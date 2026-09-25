// Règle de sortie du relais d'opencode (1.0.6) : module PUR (aucun import « node: », aucun aléa ; seule LoginWindow lit une
// horloge, injectable). opencode n'a plus de route vers l'extérieur (réseau Docker interne) : sa seule sortie est le relais du
// cockpit (egress-relay.ts), qui n'ouvre un tunnel CONNECT que vers un hôte de la liste fermée ci-dessous, port 443. Tout le reste
// est refusé localement, sans aucune requête vers le proxy de l'entreprise.
//
// Liste fermée (audit des sorties d'opencode 1.18.30 du 23/09/2026, sources dans le code d'opencode) :
// - adresse de l'API Copilot EFFECTIVE, une seule : COCKPIT_COPILOT_API_URL si elle est imposée ; sinon la dernière adresse vérifiée
//   par le cockpit (CopilotApi.status.endpoint) ; sinon l'adresse qu'opencode utilise d'office (api.githubcopilot.com, ou
//   copilot-api.<domaine GitHub Enterprise déclaré>). Sources : plugin/github-copilot/copilot.ts:26-28 (base(), /models toujours à
//   l'adresse d'office), copilot.ts:100-178 et models.ts:109-113 (envois), cockpit oc-copilot-config.ts (baseURL imposée).
//   Une adresse d'office que le réseau bloque n'est donc jamais relayée : opencode reçoit un refus local au lieu d'une alerte au proxy.
// - github.com : connexion à Copilot (flux « device » : /login/device/code, /login/oauth/access_token), copilot.ts:19-24,222-276.
//   Ouvert SEULEMENT pendant une connexion lancée depuis le cockpit (LoginWindow) ; sinon l'IA pourrait y pousser du code (git push).
// - <domaine GitHub Enterprise> : même connexion pour GitHub Enterprise (copilot.ts:27,227-230), seulement si
//   COCKPIT_GITHUB_ENTERPRISE_DOMAIN est déclaré, et seulement pendant une connexion.
// Jamais : api.github.com (utilisé par le cockpit seul, jamais par opencode : aucun échange de jeton dans opencode 1.18.30),
// models.opencode.ai, registry.npmjs.org, ni aucun joker ou suffixe.
import { COPILOT_API_HOSTS, DEFAULT_COPILOT_API_URL } from "./shared/assistant-rules.ts";

/** Seul port relayé (HTTPS). */
export const EGRESS_PORT = 443;
/** Longueur maximale d'un nom DNS (RFC 1035, sans le point final) ; une étiquette fait 63 caractères au plus (LABEL). */
export const EGRESS_NAME_MAX = 253;
/** Durée d'ouverture de github.com après une demande de connexion : le code de GitHub expire au bout de 15 minutes. */
export const LOGIN_WINDOW_MS = 20 * 60_000;
/** Hôte de connexion de github.com (flux « device » du plugin Copilot d'opencode). */
export const GITHUB_LOGIN_HOST = "github.com";
/** Jamais relayé, même s'il était demandé comme hôte permis. */
export const EGRESS_NEVER = "api.github.com";

/** Raisons de refus : écrites telles quelles dans le journal du cockpit. */
export const EGRESS_REFUSAL_REASONS = ["hote", "port", "ip-litterale", "invalide", "methode", "origine"] as const;
export type EgressRefusalReason = (typeof EGRESS_REFUSAL_REASONS)[number];

export type EgressDecision =
  | { allow: true; host: string }
  | { allow: false; reason: EgressRefusalReason; host: string; port: number };

// Casse ignorée par les expressions, jamais par toLowerCase avant validation : « K » (U+212A, signe kelvin) deviendrait « k ».
const LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i;
/** Dernière étiquette numérique (décimale, octale ou 0x…) : WHATWG et getaddrinfo y lisent une IPv4 (127.1, 2130706433, 0x7f.1). */
const NUMERIC_LAST = /^(?:\d+|0x[0-9a-f]*)$/i;
/** IPv6 sans crochets (au moins un deux-points) : chiffres hexadécimaux, points et deux-points, identifiant de zone compris. */
const BARE_IPV6 = /^[0-9a-f.:]+(?:%[^%]*)?$/i;

/** Adresse IP écrite en clair : IPv4 sous toutes ses écritures (point final compris), IPv6 avec ou sans crochets. */
export function isIpLiteral(name: string): boolean {
  if (name.startsWith("[") || name.endsWith("]")) return true;
  if (name.includes(":") && BARE_IPV6.test(name)) return true;
  const trimmed = name.endsWith(".") ? name.slice(0, -1) : name;
  return NUMERIC_LAST.test(trimmed.slice(trimmed.lastIndexOf(".") + 1));
}

/**
 * Nom DNS canonique (minuscules, sans point final), ou null : ASCII seulement, 253 caractères au plus, au moins deux étiquettes de
 * 1 à 63 caractères (lettres, chiffres, tirets internes), jamais une adresse IP écrite en clair. Un seul point final est toléré :
 * « api.githubcopilot.com. » désigne le même nom et c'est le nom canonique qui sort.
 */
export function canonicalHostName(raw: string): string | null {
  const name = raw.endsWith(".") ? raw.slice(0, -1) : raw;
  if (name.length === 0 || name.length > EGRESS_NAME_MAX || isIpLiteral(raw)) return null;
  const labels = name.split(".");
  if (labels.length < 2 || !labels.every((label) => LABEL.test(label))) return null;
  // Noms validés : ASCII seul, la mise en minuscules ne peut plus changer une lettre en une autre.
  return name.toLowerCase();
}

/**
 * Cible d'un CONNECT (« hôte:port », « [v6]:port ») telle qu'elle est écrite. Port absent ou illisible : NaN. Rien n'est corrigé
 * ici : identifiants, chemin ou schéma restent dans `host` et finissent refusés par decideConnect.
 */
export function splitConnectTarget(target: string): { host: string; port: number } {
  let host = target;
  let rest: string | null = null;
  if (target.startsWith("[")) {
    const end = target.indexOf("]");
    if (end !== -1) {
      host = target.slice(0, end + 1);
      const after = target.slice(end + 1);
      rest = after.startsWith(":") ? after.slice(1) : "";
    }
  } else {
    const colon = target.lastIndexOf(":");
    if (colon !== -1) {
      host = target.slice(0, colon);
      rest = target.slice(colon + 1);
    }
  }
  const port = rest !== null && /^\d{1,5}$/.test(rest) ? Number(rest) : Number.NaN;
  return { host, port };
}

/**
 * Décision pour la cible d'un CONNECT. Ordre : adresse IP écrite en clair, nom invalide, port autre que 443, puis hôte : égalité
 * exacte avec un nom de `allowed` (déjà canonique), sans joker ni suffixe. api.github.com est toujours refusé.
 */
export function decideConnect(target: string, allowed: ReadonlySet<string>): EgressDecision {
  const { host, port } = splitConnectTarget(target);
  if (isIpLiteral(host)) return { allow: false, reason: "ip-litterale", host, port };
  const name = canonicalHostName(host);
  if (name === null) return { allow: false, reason: "invalide", host, port };
  if (port !== EGRESS_PORT) return { allow: false, reason: "port", host: name, port };
  if (name === EGRESS_NEVER || !allowed.has(name)) return { allow: false, reason: "hote", host: name, port };
  return { allow: true, host: name };
}

/**
 * Domaine GitHub Enterprise déclaré (COCKPIT_GITHUB_ENTERPRISE_DOMAIN) : schéma http(s):// et barre finale retirés comme le fait le
 * plugin Copilot d'opencode, puis nom DNS canonique d'au moins deux étiquettes. null : absent ; undefined : valeur refusée.
 */
export function parseEnterpriseDomain(value: string | undefined): string | null | undefined {
  const raw = (value ?? "").trim();
  if (raw === "") return null;
  const bare = raw.replace(/^https?:\/\//i, "").replace(/\/$/, "");
  return canonicalHostName(bare) ?? undefined;
}

const hostOf = (url: string | null | undefined): string | null => {
  if (!url?.startsWith("https://")) return null;
  return canonicalHostName(url.slice("https://".length).replace(/\/$/, ""));
};

export interface EgressHostsInput {
  /** COCKPIT_COPILOT_API_URL déjà validée (« https://hôte »), null : automatique. */
  copilotApiUrl: string | null;
  /** Dernière adresse vérifiée par le cockpit (CopilotApi.status.endpoint.url), null si aucune. */
  endpointUrl: string | null;
  /** Domaine GitHub Enterprise déclaré et validé (parseEnterpriseDomain), null si aucun. */
  enterpriseDomain: string | null;
  /** Connexion à GitHub lancée depuis le cockpit et encore en cours (LoginWindow). */
  loginOpen: boolean;
}

/** Hôte d'API Copilot officiel ou copilot-api.<domaine déclaré> : jamais un autre, même si une adresse venait d'ailleurs. */
function isCopilotApiHost(host: string, domain: string | null): boolean {
  return COPILOT_API_HOSTS.includes(host) || (domain !== null && host === `copilot-api.${domain}`);
}

/** Hôtes que le relais laisse sortir maintenant (voir l'en-tête du fichier) ; ensemble neuf à chaque appel. */
export function egressAllowedHosts(input: EgressHostsInput): Set<string> {
  const domain = input.enterpriseDomain;
  const verified = hostOf(input.endpointUrl);
  // Une seule adresse d'API quand elle est connue (imposée, sinon vérifiée) ; sinon les adresses qu'opencode utilise d'office.
  let api: Array<string | null> = [hostOf(DEFAULT_COPILOT_API_URL), domain ? `copilot-api.${domain}` : null];
  if (input.copilotApiUrl !== null) api = [hostOf(input.copilotApiUrl)];
  else if (verified !== null) api = [verified];
  const hosts = new Set<string>();
  for (const host of api) if (host !== null && isCopilotApiHost(host, domain)) hosts.add(host);
  if (input.loginOpen) {
    hosts.add(GITHUB_LOGIN_HOST);
    if (domain) hosts.add(domain);
  }
  hosts.delete(EGRESS_NEVER);
  return hosts;
}

/**
 * Échéance d'un tunnel vers `host`, en heure du cockpit : null pour un hôte permis hors de toute connexion (l'adresse de l'API) ;
 * sinon la fin de la fenêtre de connexion (`loginClosesAt`, LoginWindow.closesAt), et 0 si elle est fermée. Le relais coupe le
 * tunnel à cette heure même s'il parle encore : github.com ne reste jamais ouvert au-delà de la connexion qui l'a permis.
 */
export function egressTunnelDeadline(host: string, input: Omit<EgressHostsInput, "loginOpen">, loginClosesAt: number | null): number | null {
  if (egressAllowedHosts({ ...input, loginOpen: false }).has(host)) return null;
  return loginClosesAt ?? 0;
}

/** Fenêtre de connexion à GitHub : ouverte par le cockpit quand il relaie une demande de connexion Copilot, fermée seule. */
export class LoginWindow {
  readonly #now: () => number;
  readonly #durationMs: number;
  #until = 0;

  constructor(now: () => number = Date.now, durationMs: number = LOGIN_WINDOW_MS) {
    this.#now = now;
    this.#durationMs = durationMs;
  }

  /** Ouvre (ou prolonge) la fenêtre pour LOGIN_WINDOW_MS à partir de maintenant. */
  open(): void {
    this.#until = Math.max(this.#until, this.#now() + this.#durationMs);
  }

  isOpen(): boolean {
    return this.#now() < this.#until;
  }

  /** Fin de la fenêtre (prolongations comprises) tant qu'elle est ouverte, null sinon : échéance des tunnels qu'elle a permis. */
  closesAt(): number | null {
    return this.isOpen() ? this.#until : null;
  }
}
