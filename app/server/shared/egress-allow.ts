// Décision de sortie du proxy `egress` de la salle (spéc. §3.15.2 l.518-522, JS-8, D-2b-13) : module PUR (aucun import « node: »,
// aucun accès à process, ni horloge ni aléa). Seul un CONNECT vers l'hôte de l'API Copilot en vigueur, port 443, sort ; tout le
// reste est refusé, fermé en cas de doute. Les codes de refus sont ceux d'EgressRefusalReason (T3a), comparés au train de V0 ;
// « methode » est rendu par egress-proxy.ts pour toute demande qui n'est pas un CONNECT (le serveur HTTP de Node les sépare).
import { DEFAULT_COPILOT_API_URL, normalizeCopilotApiUrl } from "./assistant-rules.ts";

/** Codes de refus, dans l'ordre d'EGRESS_REFUSAL_REASONS de T3a (omo-contracts.ts) : égalité vérifiée au train de V0. */
export const EGRESS_REFUSAL_REASONS = ["hote", "port", "ip-litterale", "invalide", "methode"] as const;
export type EgressRefusalReason = (typeof EGRESS_REFUSAL_REASONS)[number];

export type EgressDecision = { autorise: true } | { autorise: false; raison: EgressRefusalReason };

/** Seul port de sortie (HTTPS de l'API Copilot). */
export const EGRESS_PORT_AUTORISE = 443;
/** Longueur maximale d'un nom DNS (RFC 1035, sans le point final). */
export const EGRESS_NOM_MAX = 253;
/** Longueur maximale d'une étiquette DNS. */
export const EGRESS_ETIQUETTE_MAX = 63;
/** Jamais ouvert depuis la salle : la connexion GitHub se fait dans l'instance principale (l.519). */
export const EGRESS_HOTE_TOUJOURS_REFUSE = "api.github.com";

// Expressions sans retour arrière : la cible vient de la salle et n'est pas encore bornée quand l'IP écrite en clair est cherchée.
// Casse ignorée par les expressions, jamais par toLowerCase avant validation : « K » (U+212A, signe kelvin) deviendrait « k ».
const ETIQUETTE_CARACTERES = /^[a-z0-9-]+$/i;
/** Dernière étiquette numérique (décimale, octale ou 0x…) : WHATWG et getaddrinfo y lisent une IPv4 (127.1, 2130706433, 0x7f.1). */
const FIN_NUMERIQUE = /^(?:\d+|0x[0-9a-f]*)$/i;
/** IPv6 sans crochets (avec au moins un deux-points) : chiffres hexadécimaux, points et deux-points, identifiant de zone (%…) compris. */
const IPV6_NUE = /^[0-9a-f.:]+(?:%[^%]*)?$/i;

/** Adresse IP écrite en clair (v4 sous toutes ses écritures, point final compris comme WHATWG, v6 avec ou sans crochets). */
function estIpLitterale(nom: string): boolean {
  if (nom.startsWith("[") || nom.endsWith("]")) return true;
  if (nom.includes(":") && IPV6_NUE.test(nom)) return true;
  const sansPointFinal = nom.endsWith(".") ? nom.slice(0, -1) : nom;
  return FIN_NUMERIQUE.test(sansPointFinal.slice(sansPointFinal.lastIndexOf(".") + 1));
}

/** Nom DNS écrit en ASCII : 253 caractères au plus, étiquettes de 1 à 63 caractères (lettres, chiffres, tirets internes). */
function estNomDnsValide(nom: string): boolean {
  if (nom.length === 0 || nom.length > EGRESS_NOM_MAX) return false;
  return nom
    .split(".")
    .every(
      (etiquette) =>
        etiquette.length <= EGRESS_ETIQUETTE_MAX && ETIQUETTE_CARACTERES.test(etiquette) && !etiquette.startsWith("-") && !etiquette.endsWith("-"),
    );
}

const refus = (raison: EgressRefusalReason): EgressDecision => ({ autorise: false, raison });

/**
 * Décision pour une cible `host:port` demandée par CONNECT. Ordre : IP écrite en clair, nom invalide, port autre que 443, puis hôte :
 * comparaison exacte à `allowedHost`, casse ignorée (ASCII seulement), sans joker ni suffixe. api.github.com est toujours refusé,
 * même donné comme hôte autorisé. Les deux côtés étant validés avant la comparaison exacte, un hôte autorisé vide, écrit en clair ou
 * invalide n'égale jamais aucune demande : plus rien ne sort.
 */
export function egressAllow(host: string, port: number, allowedHost: string): EgressDecision {
  if (estIpLitterale(host)) return refus("ip-litterale");
  if (!estNomDnsValide(host)) return refus("invalide");
  if (port !== EGRESS_PORT_AUTORISE) return refus("port");
  // Noms validés : ASCII seul, la mise en minuscules ne peut plus changer une lettre en une autre. Un hôte autorisé écrit en clair
  // n'égale jamais une demande, déjà refusée « ip-litterale » plus haut.
  const demande = host.toLowerCase();
  const autorise = estNomDnsValide(allowedHost) ? allowedHost.toLowerCase() : null;
  if (demande === EGRESS_HOTE_TOUJOURS_REFUSE || demande !== autorise) return refus("hote");
  return { autorise: true };
}

/**
 * Cible d'un CONNECT (« hôte:port », « [v6]:port ») telle qu'elle est écrite. Port absent ou illisible : NaN (refusé « port » si
 * l'hôte passe). Rien n'est corrigé ici : identifiants, chemin ou schéma restent dans `hote` et finissent refusés par egressAllow.
 */
export function decoupeCibleConnect(cible: string): { hote: string; port: number } {
  let hote = cible;
  let reste: string | null = null;
  if (cible.startsWith("[")) {
    const fin = cible.indexOf("]");
    if (fin !== -1) {
      hote = cible.slice(0, fin + 1);
      reste = cible.slice(fin + 1);
      reste = reste.startsWith(":") ? reste.slice(1) : "";
    }
  } else {
    const deuxPoints = cible.lastIndexOf(":");
    if (deuxPoints !== -1) {
      hote = cible.slice(0, deuxPoints);
      reste = cible.slice(deuxPoints + 1);
    }
  }
  const port = reste !== null && /^\d{1,5}$/.test(reste) ? Number(reste) : Number.NaN;
  return { hote, port };
}

/**
 * Hôte autorisé, lu une fois au démarrage d'egress depuis la même source que la 1.0.3 (D-2b-13) : COCKPIT_COPILOT_API_URL validée
 * comme par env.ts (normalizeCopilotApiUrl, domaine GitHub Enterprise déclaré), sinon l'adresse qu'opencode utilise d'office.
 * null : adresse refusée, egress ne démarre pas.
 */
export function egressHoteAutorise(copilotApiUrl: string | undefined, enterpriseDomain: string | undefined): string | null {
  const brut = copilotApiUrl?.trim() ?? "";
  const domaine = enterpriseDomain?.trim().toLowerCase() || null;
  // Même lecture qu'env.ts (parseCopilotApiUrl) : vide = adresse d'office ; sinon normalisée (« https://hôte ») ou refusée.
  const adresse = brut === "" ? DEFAULT_COPILOT_API_URL : normalizeCopilotApiUrl(brut, domaine);
  if (!adresse?.startsWith("https://")) return null;
  const hote = adresse.slice("https://".length);
  // Seconde garde : l'hôte retenu doit lui-même passer la règle de sortie (nom valide, jamais une IP ni api.github.com).
  return egressAllow(hote, EGRESS_PORT_AUTORISE, hote).autorise ? hote : null;
}
