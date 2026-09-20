// Propriétaire : L1f.
// Diagnostic du travail délégué (spécification §3.14 « Diagnostic » ; plan d'exécution, fiche L1f) : port `diagnostics`, dont les
// bandeaux sont rendus par la route T0 GET /api/diagnostic/activite (routes-diagnostic-11.ts, montée par ce module). Quatre relevés
// en lecture seule (P6 : aucun PATCH, aucun redémarrage), sur l'instance par défaut d'opencode (dossier de travail : configuration
// globale et de ce dossier, agents globaux et du Studio ; la configuration propre à un projet n'est pas relevée), dans cet ordre :
// - « profondeur » : subagent_depth > 1 dans la configuration effective (GET /config ; absent = 1, comme tool/task.ts d'opencode
//   1.18.30 : `cfg.subagent_depth ?? 1` ; l'ancienne clé experimental.subagent_depth, reprise par config/v2-compat.ts, ne compte que
//   si la clé de premier niveau manque) ;
// - « arriere-plan » : GET /experimental/capabilities → backgroundSubagents (OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS, ou
//   OPENCODE_EXPERIMENTAL, effect/runtime-flags.ts ; sans lui, task.ts refuse `background: true`) ;
// - « extension » : entrées `plugin` de la configuration effective (les extensions découvertes dans les plugin(s)/ des dossiers de
//   configuration y figurent en « file:// », mesuré sur 1.18.30) et fichiers .ts ou .js de oc-config/plugin(s)/ (chargés au
//   prochain rechargement d'opencode, même motif que config/plugin.ts et oc-uncontrolled.ts) ;
// - « task-allow » : agents dont les règles effectives (GET /agent, cache de lookup) donnent `allow` à `task` pour au moins un
//   agent existant (F-a : la dernière règle qui correspond l'emporte, evaluate ; opencode ne refuse aucune cible par son mode) :
//   délégation sans demande d'autorisation, surveillée par DelegationWatch (L1e). Appelants retenus : agents non internes
//   (isInternalTarget), cachés compris (hidden ne fait que retirer un agent des menus d'opencode : il reste appelable par l'outil
//   task, et un sous-agent qui a sa propre règle task le garde), en mode primary ou all ; en mode subagent seulement si un
//   sous-agent peut déléguer (profondeur > 1, ou profondeur non relevée : on ne suppose pas le défaut). Au-delà de AGENTS_MAX
//   agents, les premiers sont examinés et le relevé « agents » est dit impossible (jamais un « aucun » deviné).
// Noms (agents, extensions) : entrées externes, jamais un chemin (dernier segment seulement) ni les identifiants ou paramètres d'une
// adresse ; caractères de contrôle et invisibles retirés ; au plus NOMS_MAX noms de NOM_MAX caractères par bandeau (« … » en plus
// quand la liste est coupée).
// Relevé impossible (opencode muet, réponse illisible, dossier illisible) : ce relevé ne produit pas son bandeau, un avertissement est
// journalisé (au plus une fois par minute et par relevé : la page se relit toutes les 10 s ; seulement la nature de l'échec,
// natureEchec, jamais le texte renvoyé par opencode), et un dernier bandeau « illisible » nomme
// les relevés impossibles (code ajouté au contrat au train it1 V4, demande de L1f : un risque n'est jamais tu). Les autres relevés et
// la route restent servis, les agents internes restent lisibles. Un relevé à la fois : les appels simultanés partagent le même.
// neutralDiagnostics reste exporté et inchangé : c'est le port des tests qui ne déclarent pas ce module (plan §2.2).
import fs from "node:fs/promises";
import path from "node:path";
import type { Cockpit11Module, DiagnosticsPort } from "./contracts-11.ts";
import type { AppEnv } from "./env.ts";
import { errorMessage, type Logger } from "./log.ts";
import type { OcAgentInfo, OcLookup } from "./oc-lookup.ts";
import { PLUGIN_DIRS } from "./oc-uncontrolled.ts";
import { type OpencodeClient, OpencodeError } from "./opencode.ts";
import { registerDiagnostic11Routes } from "./routes-diagnostic-11.ts";
import { evaluate, wildcardMatch } from "./shared/assistant-rules.ts";
import type { DelegationBanner, DelegationCheck } from "./shared/cockpit-event-types.ts";
import { isInternalTarget } from "./task-once-guard.ts";

export function neutralDiagnostics(): DiagnosticsPort {
  return {
    delegation: async () => [],
  };
}

/** Délai de chaque lecture à opencode. */
export const DIAGNOSTIC_TIMEOUT_MS = 10_000;
/** Noms affichés au plus par bandeau. */
export const NOMS_MAX = 20;
/** Longueur d'un nom affiché au plus, en caractères. */
export const NOM_MAX = 64;
/** Agents examinés au plus (appelants et cibles). */
export const AGENTS_MAX = 200;
/** Un même relevé impossible n'est journalisé qu'une fois dans cet intervalle. */
export const WARN_INTERVAL_MS = 60_000;

const PLUGIN_FILE_RE = /\.(?:ts|js)$/;
/** Caractères de contrôle et de mise en forme invisibles (dont les marques de sens d'écriture). */
const HIDDEN_RE = /[\p{Cc}\p{Cf}]/gu;
const WINDOWS_PATH_RE = /^[A-Za-z]:[\\/]/;
/** Schéma d'adresse (« file: », « https: », « npm: »…) : au moins deux caractères, jamais une lettre de lecteur Windows. */
const SCHEME_RE = /^[A-Za-z][A-Za-z0-9+.-]+:/;
/** Schéma puis autorité (identifiants compris), retirés quand l'adresse ne se lit pas avec URL. */
const SCHEME_AUTHORITY_RE = /^[A-Za-z][A-Za-z0-9+.-]+:(?:\/\/[^/?#]*)?/;

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

/** Relevés, pour le journal et le bandeau « illisible » (contrat : DelegationCheck). */
export type DiagnosticCheck = DelegationCheck;

/** Ordre des relevés dans un bandeau « illisible ». */
const CHECK_ORDER: readonly DiagnosticCheck[] = ["configuration", "profondeur", "arriere-plan", "extensions", "fichiers-extensions", "agents"];

/** Nom affichable : caractères cachés retirés, espaces réduits, longueur bornée (« … ») ; null s'il ne reste rien. */
export function nomAffichable(value: string): string | null {
  const clean = value.replace(HIDDEN_RE, "").replace(/\s+/g, " ").trim();
  if (clean === "") return null;
  const chars = Array.from(clean);
  return chars.length <= NOM_MAX ? clean : `${chars.slice(0, NOM_MAX - 1).join("")}…`;
}

const lastSegment = (value: string): string => value.split(/[\\/]/).findLast((part) => part !== "") ?? "";

const decoded = (value: string): string => {
  try {
    return decodeURIComponent(value);
  } catch {
    // Adresse mal encodée : gardée telle quelle.
    return value;
  }
};

/** Dernier segment du chemin d'une adresse, sinon son hôte (sans identifiants), sinon son schéma. */
function nomAdresse(text: string): string {
  try {
    const url = new URL(text);
    const segment = lastSegment(decoded(url.pathname));
    if (segment !== "") return segment;
    return url.host !== "" ? url.host : url.protocol;
  } catch {
    const rest = text.replace(SCHEME_AUTHORITY_RE, "").split(/[?#]/)[0] ?? "";
    const segment = lastSegment(decoded(rest));
    return segment !== "" ? segment : (SCHEME_RE.exec(text)?.[0] ?? "");
  }
}

/**
 * Nom d'une extension d'après sa spécification d'opencode (chaîne, ou [chaîne, options]) : jamais un chemin ni les identifiants d'une
 * adresse. Adresse (« file:// », « https:// », « npm: »…) → dernier segment de son chemin ; chemin (absolu, relatif, Windows) →
 * dernier segment ; paquet npm (« nom@version », « @portée/nom@version ») → tel quel. null : spécification illisible ou vide.
 */
export function nomExtension(spec: unknown): string | null {
  const raw: unknown = Array.isArray(spec) ? spec[0] : spec;
  if (typeof raw !== "string") return null;
  const text = raw.trim();
  if (!WINDOWS_PATH_RE.test(text) && SCHEME_RE.test(text)) return nomAffichable(nomAdresse(text));
  if (!text.startsWith("@") && /[\\/]/.test(text)) return nomAffichable(lastSegment(text));
  return nomAffichable(text);
}

/** Profondeur de délégation effective (subagent_depth) ; absente = 1 (défaut d'opencode). Lève si la valeur est illisible. */
export function subagentDepth(config: Readonly<Record<string, unknown>>): number {
  const legacy = isRecord(config.experimental) ? config.experimental.subagent_depth : undefined;
  const value = config.subagent_depth ?? legacy;
  if (value === undefined || value === null) return 1;
  if (typeof value === "number" && Number.isInteger(value) && value >= 0) return value;
  throw new Error("subagent_depth illisible");
}

/** Noms des extensions déclarées dans la configuration (`plugin`) ; absente : aucune. Lève si l'entrée n'est pas une liste. */
export function configuredExtensions(plugin: unknown): string[] {
  if (plugin === undefined || plugin === null) return [];
  if (!Array.isArray(plugin)) throw new Error("entrée plugin illisible");
  return plugin.map(nomExtension).filter((name): name is string => name !== null);
}

/** Fichiers .ts ou .js de plugin/ et plugins/ du dossier de configuration monté ; dossier absent : aucun. Lève s'il est illisible. */
export async function pluginFileNames(configDir: string): Promise<string[]> {
  const names: string[] = [];
  for (const dir of PLUGIN_DIRS) {
    let entries: Array<{ name: string; isDirectory(): boolean }>;
    try {
      entries = await fs.readdir(path.join(configDir, dir), { withFileTypes: true });
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "ENOENT" || code === "ENOTDIR") continue;
      throw err;
    }
    for (const entry of entries) {
      if (entry.isDirectory() || !PLUGIN_FILE_RE.test(entry.name)) continue;
      const name = nomAffichable(entry.name);
      if (name !== null) names.push(name);
    }
  }
  return names.sort();
}

/**
 * Agents qui délèguent sans demande d'autorisation : `task` évalué à `allow` pour au moins un agent existant. `depth` : profondeur
 * effective, null si elle n'a pas pu être relevée (les sous-agents sont alors retenus).
 */
export function delegatingAgents(agents: readonly OcAgentInfo[], depth: number | null): string[] {
  const list = agents.slice(0, AGENTS_MAX);
  const targets = list.map((agent) => agent.name);
  const subagentsDelegate = depth === null || depth > 1;
  const out: string[] = [];
  for (const agent of list) {
    // Un agent caché reste un appelant possible : seuls les agents internes sont écartés.
    if (isInternalTarget(agent.name)) continue;
    if (agent.mode === "subagent" && !subagentsDelegate) continue;
    // Seules les règles qui visent `task` comptent (la dernière qui correspond l'emporte, parmi elles comme parmi toutes).
    const taskRules = agent.permission.filter((rule) => wildcardMatch("task", rule.permission));
    if (!taskRules.some((rule) => rule.action === "allow")) continue;
    if (targets.some((target) => evaluate(taskRules, "task", target) === "allow")) out.push(agent.name);
  }
  return out;
}

/** Noms distincts, dans l'ordre, au plus NOMS_MAX (« … » en plus quand la liste est coupée). */
function bornes(names: ReadonlyArray<string | null>): string[] {
  const distinct = [...new Set(names.filter((name): name is string => name !== null))];
  return distinct.length <= NOMS_MAX ? distinct : [...distinct.slice(0, NOMS_MAX), "…"];
}

export interface DelegationDiagnosticsDeps {
  client: Pick<OpencodeClient, "request">;
  lookup: Pick<OcLookup, "get">;
  env: Pick<AppEnv, "opencodeConfigDir">;
}

/**
 * Relevé des bandeaux ; `warn` reçoit chaque relevé impossible, qui ne donne pas son bandeau mais est nommé par le dernier bandeau,
 * « illisible ». Ne lève jamais.
 */
export async function collectDelegationBanners(
  deps: DelegationDiagnosticsDeps & { warn: (check: DiagnosticCheck, err: unknown) => void },
): Promise<DelegationBanner[]> {
  const failed = new Set<DiagnosticCheck>();
  const fail = (check: DiagnosticCheck, err: unknown): void => {
    failed.add(check);
    deps.warn(check, err);
  };
  const read = async <T>(check: DiagnosticCheck, task: () => Promise<T>): Promise<T | null> => {
    try {
      return await task();
    } catch (err) {
      fail(check, err);
      return null;
    }
  };
  const readSync = <T>(check: DiagnosticCheck, task: () => T): T | null => {
    try {
      return task();
    } catch (err) {
      fail(check, err);
      return null;
    }
  };
  const options = { timeoutMs: DIAGNOSTIC_TIMEOUT_MS };
  const [config, background, agents, files] = await Promise.all([
    read("configuration", async () => {
      const raw = await deps.client.request<unknown>("GET", "/config", options);
      if (!isRecord(raw)) throw new Error("configuration d'opencode illisible : réponse inattendue");
      return raw;
    }),
    read("arriere-plan", async () => {
      const raw = await deps.client.request<unknown>("GET", "/experimental/capabilities", options);
      if (!isRecord(raw) || typeof raw.backgroundSubagents !== "boolean") throw new Error("capacités d'opencode illisibles : réponse inattendue");
      return raw.backgroundSubagents;
    }),
    read("agents", async () => (await deps.lookup.get(null)).agents),
    read("fichiers-extensions", () => pluginFileNames(deps.env.opencodeConfigDir)),
  ]);
  // Au-delà de la borne, les premiers agents restent examinés, mais le relevé n'est pas complet : il est dit, jamais tu.
  if (agents !== null && agents.length > AGENTS_MAX) {
    fail("agents", new Error(`plus de ${AGENTS_MAX} agents : les suivants ne sont pas examinés`));
  }
  const depth = config === null ? null : readSync("profondeur", () => subagentDepth(config));
  const configured = config === null ? null : readSync("extensions", () => configuredExtensions(config.plugin));

  const banners: DelegationBanner[] = [];
  if (depth !== null && depth > 1) banners.push({ code: "profondeur", noms: [] });
  if (background === true) banners.push({ code: "arriere-plan", noms: [] });
  const extensions = bornes([...(configured ?? []), ...(files ?? [])]);
  if (extensions.length > 0) banners.push({ code: "extension", noms: extensions });
  const delegating = agents === null ? [] : bornes(delegatingAgents(agents, depth).map(nomAffichable));
  if (delegating.length > 0) banners.push({ code: "task-allow", noms: delegating });
  if (failed.size > 0) banners.push({ code: "illisible", noms: CHECK_ORDER.filter((check) => failed.has(check)) });
  return banners;
}

/** Longueur au plus, en caractères, du message d'une erreur sans code ni statut, dans le journal. */
export const ECHEC_MAX = 120;
/** Nom d'erreur d'opencode (ConfigJsonError…) ou code système (ECONNREFUSED…) : un identifiant, jamais un texte. */
const IDENTIFIANT_RE = /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/;

const identifiant = (value: unknown): string | null => (typeof value === "string" && IDENTIFIANT_RE.test(value) ? value : null);

/**
 * Nature d'un relevé impossible, pour le journal : jamais le texte renvoyé par opencode (un JSONC mal formé y est recopié en entier,
 * secrets compris : config/parse.ts:28 d'opencode 1.18.30, repris par describeOpencodeError). OpencodeError → « opencode <statut>
 * <nom> » (ConfigJsonError…), ou son message quand opencode n'a rien renvoyé (message écrit par le cockpit) ; sinon le code système
 * de l'erreur ou de sa cause (ECONNREFUSED…) ; sinon son message, sans caractères cachés et raccourci à ECHEC_MAX caractères (les
 * erreurs levées par ce module et par oc-lookup.ts n'ont que des phrases du cockpit).
 */
export function natureEchec(err: unknown): string {
  if (err instanceof OpencodeError) {
    if (err.body === null || err.body === undefined) return err.message;
    const name = isRecord(err.body) ? identifiant(err.body.name) : null;
    return name === null ? `opencode ${err.status}` : `opencode ${err.status} ${name}`;
  }
  const code = identifiant((err as { code?: unknown } | null)?.code) ?? identifiant((err as { cause?: { code?: unknown } } | null)?.cause?.code);
  if (code !== null) return code;
  const chars = Array.from(errorMessage(err).replace(HIDDEN_RE, " ").replace(/\s+/g, " ").trim());
  return chars.length <= ECHEC_MAX ? chars.join("") : `${chars.slice(0, ECHEC_MAX - 1).join("")}…`;
}

/** Port `diagnostics` : un relevé à la fois (appels simultanés partagés), avertissements espacés par relevé. */
export function createDelegationDiagnostics(
  deps: DelegationDiagnosticsDeps & { log: Pick<Logger, "warn"> },
  options: { now?: () => number } = {},
): DiagnosticsPort {
  const now = options.now ?? Date.now;
  const warnedAt = new Map<DiagnosticCheck, number>();
  const warn = (check: DiagnosticCheck, err: unknown): void => {
    const at = now();
    const last = warnedAt.get(check);
    if (last !== undefined && at - last < WARN_INTERVAL_MS) return;
    warnedAt.set(check, at);
    deps.log.warn("Diagnostic du travail délégué : relevé impossible", { releve: check, error: natureEchec(err) });
  };
  let running: Promise<DelegationBanner[]> | null = null;
  return {
    delegation() {
      running ??= collectDelegationBanners({ client: deps.client, lookup: deps.lookup, env: deps.env, warn }).finally(() => {
        running = null;
      });
      return running;
    },
  };
}

export const diagnosticsModule: Cockpit11Module = {
  name: "diagnostics",
  install(reg, c11) {
    c11.ports.diagnostics = createDelegationDiagnostics(c11);
    reg.routes("diagnostic-11", (app) => registerDiagnostic11Routes(app, c11));
  },
};
