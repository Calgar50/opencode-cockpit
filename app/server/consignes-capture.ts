// Propriétaire : L28d.
// Capture des consignes pour « Revoir » (U2, D-3d-30) : dérivation synchrone du processeur principal (aucune attente réseau, règle
// de L4b), inscrite par la section [3d] d'app-factory.ts hors du registre 1.1 et retirée par close(). Source : partie `task` à
// l'état `running` (metadata.sessionId, state.input.prompt) ; racine par sessions.rootOf ; jamais journalisée ni publiée sur le hub.
// Racine inconnue → rien d'enregistré : la dérivation n'appelle JAMAIS sessions.ensure et ne part jamais en réseau (une consigne
// manquée vaut mieux qu'une file de processeur bloquée ; la phrase « absente » de « Revoir » le dit à l'utilisateur).
// Journal : le NOM de l'erreur et le callId seulement, jamais le message d'erreur (il peut recopier la consigne ou un morceau de
// requête SQL), jamais le texte. Une erreur n'arrête pas le processeur.
import { createConsignesStore } from "./consignes-store.ts";
import type { EventDerivation } from "./contracts-11.ts";
import type { Salle3dDeps } from "./contracts-3d.ts";
import type { OcGlobalEvent } from "./opencode.ts";
import { eventTime } from "./shared/activity-facts.ts";

/** Nom de la dérivation, hors de STEP_ORDER (wiring-11). */
export const CONSIGNES_DERIVATION = "consignes-3d";

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const texte = (value: unknown): string | null => (typeof value === "string" && value !== "" ? value : null);

/** Nom d'une erreur, sans son message (qui pourrait recopier la consigne) : « SQLiteError », « TypeError », sinon son type. */
const nomErreur = (err: unknown): string => (err instanceof Error && err.name !== "" ? err.name : typeof err);

export function createConsignesDerivation(deps: Salle3dDeps): EventDerivation {
  const store = createConsignesStore(deps.db);

  return {
    name: CONSIGNES_DERIVATION,
    onEvent(global: OcGlobalEvent): void {
      let callId: string | null = null;
      try {
        const event = global.payload as { type?: unknown; id?: unknown; properties?: unknown } | undefined;
        if (!event || event.type !== "message.part.updated") return;
        const properties = isRecord(event.properties) ? event.properties : null;
        const part = isRecord(properties?.part) ? properties.part : null;
        if (part === null || part.type !== "tool" || part.tool !== "task") return;
        const state = isRecord(part.state) ? part.state : null;
        // « running » seulement : c'est l'instant où l'enfant reçoit la consigne (fait `consigne` à l'état `envoyee`). En
        // « pending » le texte est encore en cours d'écriture, et une partie close ne prouve plus un envoi.
        if (state === null || state.status !== "running") return;
        const input = isRecord(state.input) ? state.input : null;
        const prompt = input?.prompt;
        if (typeof prompt !== "string") return;
        const metadata = isRecord(state.metadata) ? state.metadata : null;
        const enfant = texte(metadata?.sessionId);
        const parent = texte(part.sessionID);
        const appel = texte(part.callID);
        if (enfant === null || parent === null || appel === null) return;
        callId = appel;
        const rootId = deps.sessions.rootOf(parent);
        if (rootId === null) return;
        store.enregistrer({ rootId, parent, enfant, callId: appel, brut: prompt, at: eventTime(event.id, Date.now()) });
      } catch (err: unknown) {
        deps.log.warn("consignes gardées : enregistrement abandonné", { callId, erreur: nomErreur(err) });
      }
    },
  };
}
