// Propriétaire : L10d.
// Faits d'une activation des choix automatiques (spécification §4.10, §4.11 ; décision n° 14 ; plan d'exécution, fiche L10d),
// relevés en LECTURE SEULE et rendus tels que activationRefusal (server/shared/autonomy-rules.ts, L9b) les classe :
// - règles effectives de l'assistant visé, par deps.lookup (GET /agent, cache court) ;
// - serveurs MCP ou extensions déclarés, par le relevé unique de oc-uncontrolled.ts (GET /config du dossier : configuration
//   globale, projet et extensions découvertes ; §4.10) ;
// - profil global « Sans confirmation (déconseillé) » actif, par GET /global/config et detectPermissionPreset ;
// - plancher de la conversation vérifié, par ports.floors.verified (§3.4).
// P6 : aucun PATCH /global/config, aucun dispose, aucun redémarrage ; rien n'est écrit, ici ni ailleurs.
// Un relevé impossible n'est jamais deviné « conforme » : la valeur qui REFUSE est rendue (P1), et la phrase de refus le dit
// (« ou n'a pas pu être lu », autonomy-texts.ts). Ce module rend des FAITS ; le verdict et les phrases sont ailleurs.
import type { Cockpit11Ports } from "./contracts-11.ts";
import type { AppEnv } from "./env.ts";
import { errorMessage, type Logger } from "./log.ts";
import type { OcLookup } from "./oc-lookup.ts";
import { anyDeclared, declaredTools } from "./oc-uncontrolled.ts";
import type { OpencodeClient } from "./opencode.ts";
import { detectPermissionPreset, type Rule } from "./shared/assistant-rules.ts";
import type { ActivationFacts } from "./shared/autonomy-rules.ts";

/** Délai de la lecture de la configuration globale (même borne que les autres relevés d'activation, oc-uncontrolled.ts). */
export const ACTIVATION_READ_TIMEOUT_MS = 10_000;

/** Nom d'assistant relevé : borné comme dans le proxy avant d'être journalisé ou comparé. */
const AGENT_MAX = 200;

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

/** Dépendances du relevé : sous-ensemble de Cockpit11, qui le satisfait tel quel (les ports sont lus à l'appel). */
export interface ActivationFactsDeps {
  env: Pick<AppEnv, "autonomy" | "opencodeConfigDir">;
  log: Logger;
  client: Pick<OpencodeClient, "request">;
  lookup: Pick<OcLookup, "get">;
  ports: Pick<Cockpit11Ports, "floors">;
}

export interface ActivationFactsInput {
  /** Session dont le plancher doit être vérifié : la racine pour une activation, la session visée pour un envoi. */
  sessionId: string;
  /**
   * Assistant visé, tel qu'opencode le rapporte ou tel que l'envoi le nomme. null : aucun assistant visé (conversation qui n'a
   * encore rien envoyé) ; l'activation ne se refuse alors pas sur ce motif, l'envoi la réévalue avec l'assistant réel (§4.11).
   */
  agent: string | null;
  directory: string | null;
  /** ACTIVATION_OUVERTE, passé par la fabrique du port (jamais lu ici). */
  activationOuverte: boolean;
}

/**
 * Règles effectives de l'assistant visé (défauts, configuration, agent), dans l'ordre où opencode les évalue. Aucun assistant
 * visé : liste vide (rien à reprocher). Assistant inconnu de GET /agent ou opencode muet : null, lu comme « illisibles » par
 * actsWithoutAsking, donc refus.
 */
async function agentRules(deps: ActivationFactsDeps, input: ActivationFactsInput): Promise<readonly Rule[] | null> {
  if (input.agent === null || input.agent === "") return [];
  const agent = input.agent.slice(0, AGENT_MAX);
  try {
    const snapshot = await deps.lookup.get(input.directory);
    const found = snapshot.agents.find((candidate) => candidate.name === agent);
    if (found !== undefined) return found.permission;
    deps.log.warn("activation : assistant inconnu d'opencode, activation refusée", { agent });
    return null;
  } catch (err) {
    deps.log.warn("activation : règles de l'assistant illisibles, activation refusée", { agent, error: errorMessage(err) });
    return null;
  }
}

/** Serveurs MCP ou extensions déclarés pour le dossier (§4.10). Relevé impossible : tenu pour déclaré (refus). */
async function mcpOrPlugin(deps: ActivationFactsDeps, directory: string | null): Promise<boolean> {
  try {
    return anyDeclared(await declaredTools(deps, directory));
  } catch (err) {
    deps.log.warn("activation : outils d'opencode non relevés, activation refusée", { error: errorMessage(err) });
    return true;
  }
}

/** Profil global « Sans confirmation (déconseillé) » actif (PERMISSION_PRESETS.autonome). Lecture impossible : tenu pour actif. */
async function unconfirmedProfile(deps: ActivationFactsDeps): Promise<boolean> {
  try {
    const config = await deps.client.request<unknown>("GET", "/global/config", { timeoutMs: ACTIVATION_READ_TIMEOUT_MS });
    if (!isRecord(config)) {
      deps.log.warn("activation : configuration globale illisible, activation refusée");
      return true;
    }
    return detectPermissionPreset(config.permission) === "autonome";
  } catch (err) {
    deps.log.warn("activation : profil de droits non vérifié, activation refusée", { error: errorMessage(err) });
    return true;
  }
}

/** Plancher de la session vérifié par ce cockpit (§3.4). Port en échec : tenu pour non vérifié. */
async function floorVerified(deps: ActivationFactsDeps, sessionId: string): Promise<boolean> {
  try {
    return (await deps.ports.floors.verified(sessionId)) === true;
  } catch (err) {
    deps.log.warn("activation : plancher non vérifié, activation refusée", { sessionId, error: errorMessage(err) });
    return false;
  }
}

/**
 * Relève les quatre faits d'opencode en parallèle et y joint l'interrupteur (COCKPIT_AUTONOMY, décision n° 13) et la porte I1.
 * Chaque relevé a son propre repli : un seul échec ne fait jamais passer les autres pour conformes.
 */
export async function collectActivationFacts(deps: ActivationFactsDeps, input: ActivationFactsInput): Promise<ActivationFacts> {
  const [rules, tools, profile, floor] = await Promise.all([
    agentRules(deps, input),
    mcpOrPlugin(deps, input.directory),
    unconfirmedProfile(deps),
    floorVerified(deps, input.sessionId),
  ]);
  return {
    interrupteur: deps.env.autonomy === true,
    activationOuverte: input.activationOuverte === true,
    agentRules: rules,
    mcpOuExtension: tools,
    profilSansConfirmation: profile,
    plancherVerifie: floor,
  };
}
