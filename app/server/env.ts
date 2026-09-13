import path from "node:path";
import { DEFAULT_ALLOWED_PROVIDERS } from "./shared/assistant-rules.ts";

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

  const workspaceDir = path.resolve(env.COCKPIT_WORKSPACE_DIR ?? "/workspace");
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
    webDir: path.resolve(env.COCKPIT_WEB_DIR ?? path.join(import.meta.dirname, "..", "dist", "web")),
    opencodeUrl: opencodeUrl.replace(/\/+$/, ""),
    opencodeUsername: env.OPENCODE_SERVER_USERNAME?.trim() || "opencode",
    opencodePassword: required(env, "OPENCODE_SERVER_PASSWORD", 16),
    tlsInsecure: env.COCKPIT_TLS_INSECURE === "1" || env.COCKPIT_TLS_INSECURE === "true",
    projectConfig: env.COCKPIT_PROJECT_CONFIG === "1",
    githubEnterpriseDomain: env.COCKPIT_GITHUB_ENTERPRISE_DOMAIN?.trim().toLowerCase() || null,
    allowedProviders: parseAllowedProviders(env.COCKPIT_ALLOWED_PROVIDERS),
    version: env.COCKPIT_VERSION?.trim() || "dev",
  };
}
