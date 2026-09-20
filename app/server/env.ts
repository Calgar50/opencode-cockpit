import path from "node:path";
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
  /** Seul domaine GitHub Enterprise vers lequel le jeton Copilot peut être envoyé (synchro du solde). */
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
  version: string;
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
  const githubEnterpriseDomain = env.COCKPIT_GITHUB_ENTERPRISE_DOMAIN?.trim().toLowerCase() || null;
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
    version: env.COCKPIT_VERSION?.trim() || "dev",
  };
}
