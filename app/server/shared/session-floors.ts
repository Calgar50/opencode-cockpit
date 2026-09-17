// Planchers de règles de session (spécification §3.4, D5, P4) : module PUR (ni « node: » ni process), partagé avec l'interface.
//
// Un plancher est écrit par le serveur seul (session-floor-service.ts), jamais par le navigateur, puis vérifié sur l'écho d'opencode
// (POST et PATCH /session) : le tableau `permission` renvoyé doit se TERMINER par le plancher, à l'identique (PATCH ajoute sans rien
// retirer, F-g), et ne rien porter d'autre qu'un refus. L'empreinte SHA-256 du texte canonique est calculée par le service
// (node:crypto est interdit ici). Mesure M16 (MX1) : l'écho est identique à l'octet, ordre compris, pour POST comme pour PATCH.
//
// Pourquoi un plancher ne rend jamais plus permissif : opencode garde la DERNIÈRE règle qui correspond, règles de l'assistant
// puis règles de la session (F-a, F-d) ; aucune règle = « ask ». Un plancher fait seulement de refus, posé après, ne peut donc que
// refuser davantage. ETAPE porte des « allow » de lecture : chaque « ask » ou « deny » de l'assistant sur ces permissions y est
// recopié en refus APRÈS eux, et l'absence de règle (qui vaut « ask ») aussi (test « jamais plus permissif »).
import { KEY_FILE_READ_RULES, type Rule, truncateGlob, wildcardMatch } from "./assistant-rules.ts";
import type { FloorKind } from "./autonomy-types.ts";

export const FLOOR_KINDS = ["CONVERSATION", "PLAN", "ETAPE", "CONTROLE"] as const satisfies readonly FloorKind[];

/** Planchers faits de refus seulement : racines (conversation, plan) et contrôle. Une racine ne porte jamais « allow » ni « ask » (P4). */
export const DENY_ONLY_FLOORS: readonly FloorKind[] = ["CONVERSATION", "PLAN", "CONTROLE"];

/** Permissions de lecture laissées à une étape (ETAPE). */
export const STEP_READ_PERMISSIONS: readonly string[] = ["read", "grep", "glob", "list"];

/** Permissions dont les règles « ask » et « deny » de l'assistant sont recopiées en refus dans ETAPE. */
export const STEP_COPIED_PERMISSIONS: readonly string[] = [...STEP_READ_PERMISSIONS, "external_directory"];

/** Outils de modification : leur permission est « edit » (Permission.disabled, permission/index.ts:204-214). */
export const EDIT_TOOLS: readonly string[] = ["edit", "write", "apply_patch"];

/** Outils de ressources MCP : leur permission est « read » ; « read mcp:* deny » les refuse à l'appel SANS les retirer (mesure M3). */
export const MCP_RESOURCE_TOOLS: readonly string[] = ["list_mcp_resources", "list_mcp_resource_templates", "read_mcp_resource"];

export interface FloorContext {
  /** ETAPE seulement, obligatoire : règles effectives de l'assistant de l'étape (GET /agent, dans l'ordre). */
  agentRules?: readonly Rule[];
  /** ETAPE : Truncate.GLOB d'opencode ; défaut : chemins de l'image opencode du cockpit. */
  truncateGlob?: string;
}

const deny = (permission: string, pattern: string): Rule => ({ permission, pattern, action: "deny" });

/**
 * Refus de lecture des fichiers de clés : les entrées « deny » de KEY_FILE_READ_RULES, dans leur ordre. Jamais « *.env: ask » ni
 * « *.env.example: allow » : sur une racine, une règle « ask » ou « allow » lèverait un refus de l'assistant (F-a) ; les .env restent
 * « avec votre accord » par les règles de l'assistant (décision n° 5).
 */
export function keyFileDenyRules(): Rule[] {
  return Object.entries(KEY_FILE_READ_RULES)
    .filter(([, action]) => action === "deny")
    .map(([pattern]) => deny("read", pattern));
}

/**
 * ETAPE, recopie en refus : pour chaque permission de STEP_COPIED_PERMISSIONS, chaque règle « ask » ou « deny » de l'assistant qui
 * la vise (motif de permission compris : « * », « re* ») et peut encore décider devient un refus de cette permission sur le même
 * motif d'entrée. Une règle suivie d'une règle de motif « * » visant la même permission ne décide jamais (F-a : la dernière
 * l'emporte) : elle n'est pas recopiée, sinon « * deny » puis « read * allow » (assistant explore) refuserait toute lecture. Sans
 * règle de motif « * », une entrée qu'aucune règle ne couvre vaudrait « ask » : refus sur « * ». Jamais plus permissif : la règle
 * qui décide pour l'assistant est soit recopiée en refus, soit une autorisation.
 */
function copiedDenials(agentRules: readonly Rule[]): Rule[] {
  const out: Rule[] = [];
  const seen = new Set<string>();
  const push = (rule: Rule) => {
    const key = JSON.stringify([rule.permission, rule.pattern]);
    if (seen.has(key)) return;
    seen.add(key);
    out.push(rule);
  };
  for (const permission of STEP_COPIED_PERMISSIONS) {
    const matching = agentRules.filter((rule) => wildcardMatch(permission, rule.permission));
    const lastWide = matching.findLastIndex((rule) => rule.pattern === "*");
    if (lastWide < 0) push(deny(permission, "*"));
    for (const rule of matching.slice(Math.max(lastWide, 0))) if (rule.action !== "allow") push(deny(permission, rule.pattern));
  }
  return out;
}

/**
 * Plancher d'un genre (spécification §3.4), dans l'ordre :
 * - CONVERSATION : refus de lecture des fichiers de clés (toute racine ; hérités par le travail délégué, F-f, §3.14 l.441) ;
 * - PLAN : CONVERSATION + « edit * deny » + « bash * deny » (§4.9) ;
 * - ETAPE (itération 4) : « * * deny » ; « read grep glob list * allow » ; « external_directory <Truncate.GLOB> allow » ; recopie en
 *   refus des règles de l'assistant (copiedDenials) ; fichiers de clés ; « read mcp:* deny ». La recopie vient après l'autorisation
 *   des sorties tronquées, comme l'écrit la spécification : un assistant qui demande pour « external_directory * » (défaut
 *   d'opencode) ne les lit donc pas. Jamais plus permissif ; à revoir avec les équipes si la lecture des sorties tronquées manque ;
 * - CONTROLE : « * * deny » (§4.6).
 */
export function buildFloor(kind: FloorKind, ctx: FloorContext = {}): Rule[] {
  switch (kind) {
    case "CONVERSATION":
      return keyFileDenyRules();
    case "PLAN":
      return [...keyFileDenyRules(), deny("edit", "*"), deny("bash", "*")];
    case "CONTROLE":
      return [deny("*", "*")];
    case "ETAPE": {
      if (!ctx.agentRules) throw new RangeError("plancher ETAPE : règles de l'assistant de l'étape requises");
      return [
        deny("*", "*"),
        ...STEP_READ_PERMISSIONS.map((permission): Rule => ({ permission, pattern: "*", action: "allow" })),
        { permission: "external_directory", pattern: ctx.truncateGlob ?? truncateGlob(), action: "allow" },
        ...copiedDenials(ctx.agentRules),
        ...keyFileDenyRules(),
        deny("read", "mcp:*"),
      ];
    }
  }
}

/** Texte canonique d'un tableau de règles (haché par le service) : clés dans l'ordre permission, pattern, action ; ordre des règles gardé. */
export function canonicalRules(rules: readonly Rule[]): string {
  return JSON.stringify(rules.map((rule) => ({ permission: rule.permission, pattern: rule.pattern, action: rule.action })));
}

const RULE_KEYS = "action,pattern,permission";

/**
 * Règles d'une session telles qu'opencode les renvoie ; null si la valeur n'est pas un tableau de règles exactes : trois champs
 * texte (permission, pattern, action « allow », « ask » ou « deny »), aucun autre. Un changement de forme d'opencode est un écart.
 */
export function readSessionRules(value: unknown): Rule[] | null {
  if (!Array.isArray(value)) return null;
  const rules: Rule[] = [];
  for (const item of value as unknown[]) {
    if (typeof item !== "object" || item === null || Array.isArray(item)) return null;
    if (Object.keys(item).sort().join(",") !== RULE_KEYS) return null;
    const { permission, pattern, action } = item as Record<string, unknown>;
    if (typeof permission !== "string" || typeof pattern !== "string") return null;
    if (action !== "allow" && action !== "ask" && action !== "deny") return null;
    rules.push({ permission, pattern, action });
  }
  return rules;
}

/**
 * Vrai si la permission renvoyée par opencode tient le plancher : elle SE TERMINE par le plancher, règle pour règle (PATCH ajoute,
 * F-g), et tout ce qui le précède est un refus (une conversation déjà protégée, un enfant qui hérite des refus de sa racine). Faux
 * pour une valeur illisible, un plancher vide, une règle en plus après le plancher, ou un « allow »/« ask » avant lui.
 */
export function floorHolds(sessionPermission: unknown, floor: readonly Rule[]): boolean {
  const rules = readSessionRules(sessionPermission);
  if (rules === null || floor.length === 0 || rules.length < floor.length) return false;
  const cut = rules.length - floor.length;
  if (canonicalRules(rules.slice(cut)) !== canonicalRules(floor)) return false;
  return rules.slice(0, cut).every((rule) => rule.action === "deny");
}

/** Spécification §3.7 : la permission renvoyée tient le plancher CONVERSATION (toute racine). */
export function conversationFloorHolds(sessionPermission: unknown): boolean {
  return floorHolds(sessionPermission, buildFloor("CONVERSATION"));
}

/** Permission évaluée pour retirer un outil : « edit » pour les outils de modification, « read » pour les ressources MCP. */
export function toolPermission(tool: string): string {
  if (EDIT_TOOLS.includes(tool)) return "edit";
  if (MCP_RESOURCE_TOOLS.includes(tool)) return "read";
  return tool;
}

/**
 * Permission.disabled d'opencode 1.18.30 (F-e) : outils retirés de la liste envoyée à l'IA, dans l'ordre de `tools`. Un outil est
 * retiré seulement si la DERNIÈRE règle qui vise sa permission a le motif « * » et refuse ; un refus sur un motif précis (fichiers
 * de clés, « mcp:* ») laisse l'outil visible et refuse l'appel. `rules` : règles de l'assistant puis de la session (F-d).
 */
export function disabledTools(rules: readonly Rule[], tools: readonly string[]): string[] {
  return tools.filter((tool) => {
    const permission = toolPermission(tool);
    const last = rules.findLast((rule) => wildcardMatch(permission, rule.permission));
    return last?.pattern === "*" && last.action === "deny";
  });
}

/** Code du genre dans la marque enregistrée (`sessions.plancher`). */
const FLOOR_CODES: Readonly<Record<FloorKind, string>> = { CONVERSATION: "conversation", PLAN: "plan", ETAPE: "etape", CONTROLE: "controle" };

const SHA256_HEX = /^[0-9a-f]{64}$/;

/** Marque d'un plancher vérifié, enregistrée dans `sessions.plancher` : « <genre>:<empreinte SHA-256 hexadécimale> ». */
export function floorMark(kind: FloorKind, hash: string): string {
  if (!SHA256_HEX.test(hash)) throw new RangeError("empreinte de plancher invalide");
  return `${FLOOR_CODES[kind]}:${hash}`;
}

/** Genre et empreinte d'une marque enregistrée ; null si elle est absente ou illisible. */
export function parseFloorMark(mark: string | null | undefined): { kind: FloorKind; hash: string } | null {
  if (typeof mark !== "string") return null;
  const at = mark.indexOf(":");
  const code = mark.slice(0, at);
  const hash = mark.slice(at + 1);
  const kind = FLOOR_KINDS.find((candidate) => FLOOR_CODES[candidate] === code);
  return at > 0 && kind !== undefined && SHA256_HEX.test(hash) ? { kind, hash } : null;
}
