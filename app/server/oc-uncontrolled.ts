// Ce qui échappe aux demandes d'autorisation d'opencode 1.18.30 (spécification §4.10, §4.11) : un seul relevé, écrit ici une fois,
// pour « Plan d'abord » (plans.ts : création et envoi) et, plus tard, l'activation des choix automatiques (L10d, §4.11 : « la
// configuration déclare mcp ou plugin ») et le Diagnostic (L1f, §3.14 : extensions de oc-config/plugin(s)/).
// - Serveurs MCP et extensions : opencode fusionne pour chaque agent des défauts « "*": "allow" » (agent/agent.ts:119-120) et un outil
//   MCP ou d'extension demande avec permission = son nom (session/tools.ts:408) : aucune règle ne le vise, il passe sans demande.
//   Déclarés quand la configuration effective du dossier (GET /config : globale, projet, OPENCODE_CONFIG_CONTENT, extensions
//   découvertes dans les plugin(s)/ des dossiers de configuration, en « file:// » ; mesuré sur 1.18.30) a une entrée `mcp` (même
//   désactivée : « déclare ») ou `plugin`, ou quand le dossier de configuration monté a un fichier .ts ou .js dans plugin/ ou
//   plugins/ (chargé au prochain rechargement d'opencode, même motif que config/plugin.ts).
// - Lignes « !`…` » d'un raccourci : exécutées par opencode avant tout contrôle (session/prompt.ts:1397-1407). Le texte est lu dans
//   GET /command (champ `template`, rendu tel quel, mesuré sur 1.18.30), avec le motif du Studio (SHELL_LINE_RE).
// Lectures seulement (P6). Vérification impossible (opencode muet, réponse illisible, dossier illisible) : UncontrolledUnverifiable,
// et l'appelant refuse (P1).
import fs from "node:fs/promises";
import path from "node:path";
import type { AppEnv } from "./env.ts";
import { errorMessage } from "./log.ts";
import type { OpencodeClient } from "./opencode.ts";
import { SHELL_LINE_RE } from "./shared/assistant-rules.ts";

/** Délai de chaque lecture à opencode. */
export const UNCONTROLLED_TIMEOUT_MS = 10_000;
/** Dossiers d'extensions d'un dossier de configuration d'opencode (config/plugin.ts : « {plugin,plugins}/*.{ts,js} »). */
export const PLUGIN_DIRS: readonly string[] = ["plugin", "plugins"];
const PLUGIN_FILE_RE = /\.(?:ts|js)$/;
const PLUGIN_ENTRIES_MAX = 1_000;

export interface UncontrolledDeps {
  client: Pick<OpencodeClient, "request">;
  env: Pick<AppEnv, "opencodeConfigDir">;
}

/** Relevé impossible : l'appelant refuse, rien n'est deviné. */
export class UncontrolledUnverifiable extends Error {
  override name = "UncontrolledUnverifiable";
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

/** Outils déclarés : serveurs MCP et extensions (configuration effective), fichiers d'extension du dossier de configuration monté. */
export interface DeclaredTools {
  mcp: boolean;
  plugin: boolean;
  pluginFiles: boolean;
}

export const anyDeclared = (tools: DeclaredTools): boolean => tools.mcp || tools.plugin || tools.pluginFiles;

/** Fichier .ts ou .js dans plugin/ ou plugins/ du dossier de configuration monté ; dossier absent : aucun. */
async function pluginFilesIn(configDir: string): Promise<boolean> {
  for (const dir of PLUGIN_DIRS) {
    let entries: string[];
    try {
      entries = await fs.readdir(path.join(configDir, dir));
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "ENOENT" || code === "ENOTDIR") continue;
      throw new UncontrolledUnverifiable(`dossier d'extensions illisible : ${errorMessage(err)}`);
    }
    // Au-delà de la borne : compté comme déclaré (jamais un « aucun » deviné).
    if (entries.length > PLUGIN_ENTRIES_MAX || entries.some((name) => PLUGIN_FILE_RE.test(name))) return true;
  }
  return false;
}

/**
 * Serveurs MCP et extensions déclarés pour `directory` (null : instance par défaut). Une entrée `mcp` ou `plugin` d'une forme
 * inattendue compte comme déclarée. Lève UncontrolledUnverifiable si opencode ne répond pas ou si un relevé est illisible.
 */
export async function declaredTools(deps: UncontrolledDeps, directory: string | null): Promise<DeclaredTools> {
  let config: unknown;
  try {
    config = await deps.client.request<unknown>("GET", "/config", { ...(directory ? { directory } : {}), timeoutMs: UNCONTROLLED_TIMEOUT_MS });
  } catch (err) {
    throw new UncontrolledUnverifiable(`configuration d'opencode illisible : ${errorMessage(err)}`);
  }
  if (!isRecord(config)) throw new UncontrolledUnverifiable("configuration d'opencode illisible : réponse inattendue");
  const { mcp, plugin } = config;
  return {
    mcp: mcp !== undefined && mcp !== null && (!isRecord(mcp) || Object.keys(mcp).length > 0),
    plugin: plugin !== undefined && plugin !== null && (!Array.isArray(plugin) || plugin.length > 0),
    pluginFiles: await pluginFilesIn(deps.env.opencodeConfigDir),
  };
}

/**
 * Le raccourci `name` du dossier a-t-il une ligne « !`…` » ? false : raccourci inconnu d'opencode (il refusera l'envoi lui-même,
 * rien n'est exécuté). Lève UncontrolledUnverifiable si la liste ou le texte du raccourci est illisible.
 */
export async function commandRunsShell(deps: Pick<UncontrolledDeps, "client">, directory: string | null, name: string): Promise<boolean> {
  let list: unknown;
  try {
    list = await deps.client.request<unknown>("GET", "/command", { ...(directory ? { directory } : {}), timeoutMs: UNCONTROLLED_TIMEOUT_MS });
  } catch (err) {
    throw new UncontrolledUnverifiable(`raccourcis d'opencode illisibles : ${errorMessage(err)}`);
  }
  if (!Array.isArray(list)) throw new UncontrolledUnverifiable("raccourcis d'opencode illisibles : réponse inattendue");
  const command = list.find((item) => isRecord(item) && item.name === name);
  if (command === undefined) return false;
  if (!isRecord(command) || typeof command.template !== "string") throw new UncontrolledUnverifiable("texte du raccourci illisible");
  return SHELL_LINE_RE.test(command.template);
}
