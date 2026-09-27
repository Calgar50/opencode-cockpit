import path from "node:path";
import { canonicalHostName, parseEnterpriseDomain } from "./egress-policy.ts";
import { isFetchBlockedPort } from "./fetch-ports.ts";
import { DEFAULT_ALLOWED_PROVIDERS, normalizeCopilotApiUrl } from "./shared/assistant-rules.ts";

export interface AppEnv {
  host: string;
  port: number;
  /** Jeton d'accès à l'interface (≥ 32 caractères). */
  token: string;
  /** Noms d'hôte acceptés dans l'en-tête Host (anti DNS-rebinding). */
  allowedHosts: string[];
  dataDir: string;
  archiveDir: string;
  /** Racine des projets telle que vue par le cockpit. */
  workspaceDir: string;
  /** Même racine telle que vue par opencode (identique en Docker). */
  opencodeWorkspaceDir: string;
  /** Dossier de configuration globale d'opencode (agents/, commands/, skills/, opencode.jsonc). */
  opencodeConfigDir: string;
  /** Dossier de données d'opencode (auth.json) — lecture seule, synchro de quota optionnelle. */
  opencodeDataDir: string;
  /** Dossier partagé avec le superviseur d'opencode (demande de redémarrage, journal). */
  controlDir: string;
  /** Autorités de certification d'entreprise (certs/*.pem|*.crt) ajoutées à celles de Node pour les appels sortants. */
  certsDir: string;
  webDir: string;
  opencodeUrl: string;
  opencodeUsername: string;
  opencodePassword: string;
  tlsInsecure: boolean;
  /** Configuration par projet (.opencode/ des dépôts) autorisée — désactivée par défaut. */
  projectConfig: boolean;
  /**
   * Seul domaine GitHub Enterprise vers lequel le jeton Copilot peut être envoyé (synchro du solde) et que le relais d'opencode peut
   * ouvrir : nom DNS canonique d'au moins deux étiquettes (1.0.6), schéma et barre finale retirés.
   */
  githubEnterpriseDomain: string | null;
  /**
   * Fournisseurs d'IA acceptés par le proxy, l'éditeur de niveaux et le Studio (COCKPIT_ALLOWED_PROVIDERS).
   * Défaut : github-copilot seul ; toute autre valeur affiche le bandeau rouge « Mode test ».
   */
  allowedProviders: string[];
  /**
   * COCKPIT_COPILOT_API_URL : adresse d'API Copilot imposée (pare-feu d'entreprise à routage par abonnement). null :
   * adresse d'office d'opencode, ou celle de l'abonnement annoncée par GitHub si le réseau bloque la première.
   */
  copilotApiUrl: string | null;
  /** COCKPIT_AUTONOMY (1.1) : false coupe « Modifications automatiques » et « Autonome avec contrôle ». */
  autonomy: boolean;
  /**
   * Schéma servi sur la boucle locale (COCKPIT_LOCAL_SCHEME) : https par défaut ; http seulement avec une date de confirmation
   * valable (COCKPIT_LOCAL_HTTP_CONFIRMED, écrite par install.ps1 après la saisie). Jamais les deux, jamais de repli automatique.
   */
  localScheme: LocalScheme;
  /** Date UTC de la confirmation du mode HTTP (AAAA-MM-JJTHH:MM:SSZ) ; null en HTTPS. */
  localHttpConfirmedAt: string | null;
  /** Volume du certificat TLS local (COCKPIT_TLS_DIR, chemin absolu) ; ni lu ni écrit par le serveur en mode HTTP. */
  tlsDir: string;
  /** Binaire openssl lancé par execFile pour générer le certificat (COCKPIT_OPENSSL, chemin absolu). */
  opensslPath: string;
  /**
   * Salle OMO (1.1) : interrupteur et chemins lus dans l'environnement, jamais dans l'interface (§3.6 l.289). Toujours rempli
   * par loadEnv ; ABSENT d'un AppEnv construit à la main (harnais, tests d'avant la salle) = salle coupée, lu par `omoOf`.
   */
  omo?: OmoEnv;
  version: string;
  /**
   * Relais de sortie d'opencode (1.0.6) : port d'écoute sur le réseau interne (COCKPIT_RELAY_PORT) et nom du service qui désigne ce
   * réseau (COCKPIT_RELAY_PEER, « opencode » par défaut). null : relais désactivé (développement, tests).
   */
  relay: { port: number; peer: string } | null;
  // <nav:env>
  /**
   * COCKPIT_FICHIERS (1.1, onglet « Fichiers ») : false coupe les quatre routes de lecture (403 « fichiers-coupes »). Facultatif :
   * absent, l'onglet est actif (comme « on »).
   */
  fichiers?: boolean;
  /**
   * COCKPIT_FICHIERS_DIR : dossier lu par l'onglet « Fichiers » (/projets-lecture, second montage du dossier de travail en lecture
   * seule), accepté seulement s'il est égal à /projets-lecture ou au dossier de travail (D14 (a)). Absent : workspaceDir.
   */
  fichiersDir?: string;
  // </nav:env>
}

export class EnvError extends Error {
  override name = "EnvError";
}

const PROVIDER_ID = /^[a-z0-9][a-z0-9._-]{0,63}$/;

/** Liste séparée par des virgules ; vide = github-copilot ; identifiant invalide = refus de démarrer. */
export function parseAllowedProviders(value: string | undefined): string[] {
  const list = [
    ...new Set(
      (value ?? "")
        .split(",")
        .map((p) => p.trim())
        .filter(Boolean),
    ),
  ];
  if (list.length === 0) return [...DEFAULT_ALLOWED_PROVIDERS];
  const invalid = list.find((p) => !PROVIDER_ID.test(p));
  if (invalid !== undefined) {
    throw new EnvError(`COCKPIT_ALLOWED_PROVIDERS : identifiant de fournisseur invalide (${invalid.slice(0, 40)}).`);
  }
  return list;
}

/** Adresse d'API Copilot imposée : vide = automatique ; adresse inconnue = refus de démarrer (le jeton y serait envoyé). */
export function parseCopilotApiUrl(value: string | undefined, enterpriseDomain: string | null): string | null {
  const raw = value?.trim() ?? "";
  if (!raw) return null;
  const url = normalizeCopilotApiUrl(raw, enterpriseDomain);
  if (url === null) {
    throw new EnvError(
      "COCKPIT_COPILOT_API_URL : adresse refusée. Valeurs acceptées : https://api.business.githubcopilot.com, https://api.enterprise.githubcopilot.com, https://api.githubcopilot.com (ou copilot-api.<domaine GitHub Enterprise déclaré>).",
    );
  }
  return url;
}

/** COCKPIT_AUTONOMY : vide ou « on » = choix automatiques proposés, « off » = coupés ; autre valeur = refus de démarrer. */
export function parseAutonomy(value: string | undefined): boolean {
  const raw = value?.trim().toLowerCase() ?? "";
  if (raw === "" || raw === "on") return true;
  if (raw === "off") return false;
  throw new EnvError("COCKPIT_AUTONOMY : valeur refusée (on ou off).");
}

// <nav:env>
/** Second montage du dossier de travail, en lecture seule (docker-compose.yml) : le seul dossier que l'onglet « Fichiers » lit. */
export const FICHIERS_DIR_MONTAGE = "/projets-lecture";

/** COCKPIT_FICHIERS : vide ou « on » = onglet « Fichiers » actif, « off » = coupé ; autre valeur = refus de démarrer. */
export function parseFichiers(value: string | undefined): boolean {
  const raw = value?.trim().toLowerCase() ?? "";
  if (raw === "" || raw === "on") return true;
  if (raw === "off") return false;
  throw new EnvError("COCKPIT_FICHIERS : valeur refusée (on ou off).");
}

/**
 * COCKPIT_FICHIERS_DIR, liste d'autorisation (décision D14 (a), qui remplace la liste de refus A8) : absent ou vide = dossier de
 * travail (undefined) ; sinon chemin absolu ÉGAL, à la lettre et sans normalisation, à /projets-lecture ou au dossier de travail.
 * Toute autre valeur (relative, /, /proc, /data, un montage de la salle, /certs, un sous-dossier, « .. ») refuse le démarrage :
 * le cockpit ne lit jamais ses propres dossiers, même après l'ajout d'un montage. Le message ne recopie pas la valeur lue.
 */
export function parseFichiersDir(value: string | undefined, workspaceDir: string): string | undefined {
  if (value === undefined || value.trim() === "") return undefined;
  if (path.isAbsolute(value) && (value === FICHIERS_DIR_MONTAGE || value === workspaceDir)) return value;
  throw new EnvError("COCKPIT_FICHIERS_DIR : dossier refusé.");
}
// </nav:env>

/** Domaine GitHub Enterprise déclaré : vide = aucun ; valeur refusée = refus de démarrer (le relais l'ouvrirait à opencode). */
export function parseGithubEnterpriseDomain(value: string | undefined): string | null {
  const domain = parseEnterpriseDomain(value);
  if (domain === undefined) {
    throw new EnvError("COCKPIT_GITHUB_ENTERPRISE_DOMAIN : nom de domaine attendu (par exemple entreprise.ghe.com), sans adresse IP ni chemin.");
  }
  return domain;
}

/**
 * Relais de sortie d'opencode : COCKPIT_RELAY_PORT vide = désactivé ; sinon port 1-65535 différent du port de l'interface, et pair
 * (COCKPIT_RELAY_PEER) écrit comme un nom de service Docker ou un nom DNS. Toute autre valeur refuse le démarrage.
 */
export function parseRelay(env: NodeJS.ProcessEnv, interfacePort: number): { port: number; peer: string } | null {
  const raw = (env.COCKPIT_RELAY_PORT ?? "").trim();
  if (raw === "") return null;
  const port = /^\d{1,5}$/.test(raw) ? Number(raw) : Number.NaN;
  if (!Number.isInteger(port) || port < 1 || port > 65535 || port === interfacePort) {
    throw new EnvError("COCKPIT_RELAY_PORT : port du relais invalide (1-65535, différent de COCKPIT_PORT).");
  }
  const peer = (env.COCKPIT_RELAY_PEER ?? "").trim().toLowerCase() || "opencode";
  if (!/^[a-z0-9](?:[a-z0-9_-]{0,62})$/.test(peer) && canonicalHostName(peer) === null) {
    throw new EnvError("COCKPIT_RELAY_PEER : nom de service attendu (par exemple opencode).");
  }
  return { port, peer };
}

// --- Salle OMO (§3.6 l.289, §3.15 ; contrat docker/opencode-omo/contrat-salle.json, clés `variables.cockpit`) -------------------

/**
 * Réglages de la Salle OMO lus dans l'environnement. Aucun comportement n'en découle ici : la salle reste coupée tant que le
 * câblage ne la branche pas. `password` n'est jamais journalisé ni recopié dans un message d'erreur.
 */
export interface OmoEnv {
  /** COCKPIT_OMO : « on » ouvre la salle ; absent, vide ou « off » la laisse coupée (défaut livré). */
  enabled: boolean;
  /** OPENCODE_OMO_URL : serveur opencode de la salle, joint par le réseau interne seul. */
  url: string;
  /** OPENCODE_OMO_PASSWORD : mot de passe du serveur de la salle, exigé (≥ 32 caractères) quand la salle est ouverte. */
  password: string;
  /** COCKPIT_OMO_IMAGE : image chargée par `install.ps1 -OmoArchive` ; vide tant qu'aucune archive n'a été chargée. */
  image: string;
  /** COCKPIT_OMO_CONTROL_DIR : volume `control-omo` côté cockpit (écriture) : battement, demande d'arrêt, état du filet. */
  controlDir: string;
  /** COCKPIT_OMO_STATE_DIR : volume `omo-state` côté cockpit (lecture seule) : `state.json` du superviseur. */
  stateDir: string;
  /** COCKPIT_OMO_AUTH_DIR : volume `omo-auth` côté cockpit (écriture) : `auth.json` réduit à l'entrée github-copilot. */
  authDir: string;
  /** COCKPIT_OMO_PROJECTS_FILE : `omo-projets.json` écrit par `install.ps1` ; null : aucune liste de projets préparés. */
  projectsFile: string | null;
  /** COCKPIT_EGRESS_JOURNAL : volume `egress-log` côté cockpit (lecture seule) : journal des sorties refusées. */
  egressJournal: string;
}

/** Adresse d'office de la salle : nom du service du contrat, sur le réseau interne. */
export const OMO_URL_DEFAUT = "http://opencode-omo:4096";
/** Cibles d'office des volumes de la salle côté cockpit, telles que le contrat les monte. */
export const OMO_CONTROL_DIR_DEFAUT = "/control-omo";
export const OMO_STATE_DIR_DEFAUT = "/omo-state";
export const OMO_AUTH_DIR_DEFAUT = "/omo-auth";
export const OMO_EGRESS_JOURNAL_DEFAUT = "/egress-log";
/** Longueur minimale du mot de passe du serveur de la salle, salle ouverte (même exigence que COCKPIT_TOKEN). */
export const OMO_PASSWORD_MIN = 32;

/** Salle coupée : ce que vaut `AppEnv.omo` quand l'environnement n'a pas été lu (objet construit à la main). */
export const OMO_COUPEE: OmoEnv = Object.freeze({
  enabled: false,
  url: OMO_URL_DEFAUT,
  password: "",
  image: "",
  controlDir: OMO_CONTROL_DIR_DEFAUT,
  stateDir: OMO_STATE_DIR_DEFAUT,
  authDir: OMO_AUTH_DIR_DEFAUT,
  projectsFile: null,
  egressJournal: OMO_EGRESS_JOURNAL_DEFAUT,
});

/** Réglages de la salle d'un AppEnv : champ absent = salle coupée. Point de lecture unique pour tout le serveur. */
export function omoOf(env: Pick<AppEnv, "omo">): OmoEnv {
  return env.omo ?? OMO_COUPEE;
}

/**
 * Réglages de la salle, sur le modèle de parseAutonomy : « on » ou « off » seulement, tout le reste refuse le démarrage. Les
 * messages nomment la clé sans jamais recopier la valeur lue (mot de passe, adresse, identifiant d'image).
 */
export function parseOmo(env: NodeJS.ProcessEnv): OmoEnv {
  const interrupteur = env.COCKPIT_OMO?.trim().toLowerCase() ?? "";
  if (interrupteur !== "" && interrupteur !== "on" && interrupteur !== "off") {
    throw new EnvError("COCKPIT_OMO : valeur refusée (on ou off).");
  }
  const enabled = interrupteur === "on";

  const url = (env.OPENCODE_OMO_URL?.trim() || OMO_URL_DEFAUT).replace(/\/+$/, "");
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new EnvError("OPENCODE_OMO_URL : adresse invalide (http(s)://hôte:port attendu).");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") throw new EnvError("OPENCODE_OMO_URL doit être http(s).");
  // Même piège que OPENCODE_URL : un port refusé par fetch (Node) rendrait la salle injoignable sans aucune erreur lisible.
  const omoPort = parsed.port ? Number(parsed.port) : parsed.protocol === "https:" ? 443 : 80;
  if (isFetchBlockedPort(omoPort)) {
    throw new EnvError(`OPENCODE_OMO_URL : le port ${omoPort} est refusé par fetch (Node), le cockpit ne pourrait jamais joindre la salle. Choisissez un autre port.`);
  }

  const password = env.OPENCODE_OMO_PASSWORD?.trim() ?? "";
  if (enabled && password.length < OMO_PASSWORD_MIN) {
    throw new EnvError(`Variable OPENCODE_OMO_PASSWORD manquante ou trop courte (${OMO_PASSWORD_MIN} caractères minimum).`);
  }

  const projets = env.COCKPIT_OMO_PROJECTS_FILE?.trim() ?? "";
  if (projets !== "" && !path.isAbsolute(projets)) throw new EnvError("COCKPIT_OMO_PROJECTS_FILE : chemin absolu attendu.");

  return {
    enabled,
    url,
    password,
    image: env.COCKPIT_OMO_IMAGE?.trim() ?? "",
    controlDir: absolutePath(env, "COCKPIT_OMO_CONTROL_DIR", OMO_CONTROL_DIR_DEFAUT),
    stateDir: absolutePath(env, "COCKPIT_OMO_STATE_DIR", OMO_STATE_DIR_DEFAUT),
    authDir: absolutePath(env, "COCKPIT_OMO_AUTH_DIR", OMO_AUTH_DIR_DEFAUT),
    projectsFile: projets === "" ? null : path.resolve(projets),
    egressJournal: absolutePath(env, "COCKPIT_EGRESS_JOURNAL", OMO_EGRESS_JOURNAL_DEFAUT),
  };
}

export type LocalScheme = "https" | "http";

export interface LocalAccess {
  localScheme: LocalScheme;
  localHttpConfirmedAt: string | null;
}

const CONFIRMED_AT = /^20\d{2}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])T([01]\d|2[0-3]):[0-5]\d:[0-5]\dZ$/;

/**
 * Date de confirmation du mode HTTP : expression stricte, puis aller-retour (Date.parse accepte le 30 février ou le 31 septembre).
 * Même règle que les scripts PowerShell, vérifiée par tests/vectors/local-access.json.
 */
export function isValidConfirmedAt(at: string): boolean {
  if (!CONFIRMED_AT.test(at)) return false;
  const date = new Date(at);
  // Finitude d'abord : toISOString lève RangeError sur une date invalide.
  return Number.isFinite(date.getTime()) && date.toISOString() === `${at.slice(0, 19)}.000Z`;
}

/**
 * Mode d'accès local. Absent, vide ou « https » : HTTPS (date ignorée). « http » : HTTP seulement avec une date valable.
 * Toute autre valeur refuse le démarrage. Le message nomme la clé sans jamais recopier la valeur lue.
 */
export function parseLocalAccess(env: NodeJS.ProcessEnv): LocalAccess {
  const scheme = (env.COCKPIT_LOCAL_SCHEME ?? "").trim();
  if (scheme === "" || scheme === "https") return { localScheme: "https", localHttpConfirmedAt: null };
  if (scheme !== "http") {
    throw new EnvError("COCKPIT_LOCAL_SCHEME : valeur refusée (https ou http attendu, en minuscules).");
  }
  const confirmedAt = (env.COCKPIT_LOCAL_HTTP_CONFIRMED ?? "").trim();
  if (!isValidConfirmedAt(confirmedAt)) {
    throw new EnvError(
      "COCKPIT_LOCAL_HTTP_CONFIRMED : date de confirmation du mode HTTP absente ou invalide (AAAA-MM-JJTHH:MM:SSZ attendue).",
    );
  }
  return { localScheme: "http", localHttpConfirmedAt: confirmedAt };
}

/** Chemin absolu exigé (vide = valeur par défaut) ; le message ne recopie pas la valeur lue. */
function absolutePath(env: NodeJS.ProcessEnv, key: string, fallback: string): string {
  const value = env[key]?.trim() || fallback;
  if (!path.isAbsolute(value)) throw new EnvError(`${key} : chemin absolu attendu.`);
  return path.resolve(value);
}

function required(env: NodeJS.ProcessEnv, key: string, minLength: number): string {
  const value = env[key]?.trim() ?? "";
  if (value.length < minLength) {
    throw new EnvError(`Variable ${key} manquante ou trop courte (${minLength} caractères minimum).`);
  }
  return value;
}

export function loadEnv(env: NodeJS.ProcessEnv = process.env): AppEnv {
  const port = Number(env.COCKPIT_PORT ?? 7777);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new EnvError("COCKPIT_PORT invalide.");

  const opencodeUrl = env.OPENCODE_URL?.trim() || "http://opencode:4096";
  const parsed = new URL(opencodeUrl);
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") throw new EnvError("OPENCODE_URL doit être http(s).");
  // Port effectif (explicite, sinon celui du schéma) refusé par fetch : aucune demande ne partirait (« fetch failed » sans fin).
  const opencodePort = parsed.port ? Number(parsed.port) : parsed.protocol === "https:" ? 443 : 80;
  if (isFetchBlockedPort(opencodePort)) {
    throw new EnvError(`OPENCODE_URL : le port ${opencodePort} est refusé par fetch (Node), le cockpit ne pourrait jamais joindre opencode. Choisissez un autre port.`);
  }

  const workspaceDir = path.resolve(env.COCKPIT_WORKSPACE_DIR ?? "/workspace");
  const githubEnterpriseDomain = parseGithubEnterpriseDomain(env.COCKPIT_GITHUB_ENTERPRISE_DOMAIN);
  // <nav:env>
  const fichiersDir = parseFichiersDir(env.COCKPIT_FICHIERS_DIR, workspaceDir);
  // </nav:env>
  return {
    host: env.COCKPIT_HOST?.trim() || "127.0.0.1",
    port,
    token: required(env, "COCKPIT_TOKEN", 32),
    allowedHosts: (env.COCKPIT_ALLOWED_HOSTS ?? "localhost,127.0.0.1,[::1]")
      .split(",")
      .map((h) => h.trim().toLowerCase())
      .filter(Boolean),
    dataDir: path.resolve(env.COCKPIT_DATA_DIR ?? "/data"),
    archiveDir: path.resolve(env.COCKPIT_ARCHIVE_DIR ?? "/archives"),
    workspaceDir,
    opencodeWorkspaceDir: env.COCKPIT_OC_WORKSPACE_DIR?.trim() || workspaceDir,
    opencodeConfigDir: path.resolve(env.COCKPIT_OC_CONFIG_DIR ?? "/oc-config"),
    opencodeDataDir: path.resolve(env.COCKPIT_OC_DATA_DIR ?? "/oc-data"),
    controlDir: path.resolve(env.COCKPIT_CONTROL_DIR ?? "/control"),
    certsDir: path.resolve(env.COCKPIT_CERTS_DIR ?? "/certs"),
    webDir: path.resolve(env.COCKPIT_WEB_DIR ?? path.join(import.meta.dirname, "..", "dist", "web")),
    opencodeUrl: opencodeUrl.replace(/\/+$/, ""),
    opencodeUsername: env.OPENCODE_SERVER_USERNAME?.trim() || "opencode",
    opencodePassword: required(env, "OPENCODE_SERVER_PASSWORD", 16),
    // Exactement « 1 », comme le superviseur d'opencode et les Dockerfiles : le bandeau rouge suit l'état réel.
    tlsInsecure: env.COCKPIT_TLS_INSECURE === "1",
    projectConfig: env.COCKPIT_PROJECT_CONFIG === "1",
    githubEnterpriseDomain,
    allowedProviders: parseAllowedProviders(env.COCKPIT_ALLOWED_PROVIDERS),
    copilotApiUrl: parseCopilotApiUrl(env.COCKPIT_COPILOT_API_URL, githubEnterpriseDomain),
    autonomy: parseAutonomy(env.COCKPIT_AUTONOMY),
    ...parseLocalAccess(env),
    tlsDir: absolutePath(env, "COCKPIT_TLS_DIR", "/tls"),
    opensslPath: absolutePath(env, "COCKPIT_OPENSSL", "/usr/bin/openssl"),
    omo: parseOmo(env),
    version: env.COCKPIT_VERSION?.trim() || "dev",
    relay: parseRelay(env, port),
    // <nav:env>
    fichiers: parseFichiers(env.COCKPIT_FICHIERS),
    ...(fichiersDir === undefined ? {} : { fichiersDir }),
    // </nav:env>
  };
}
