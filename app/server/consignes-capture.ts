// Propriétaire : L28d.
// Capture des consignes pour « Revoir » (U2, D-3d-30) : dérivation synchrone du processeur principal (aucune attente réseau, règle
// de L4b), inscrite par la section [3d] d'app-factory.ts hors du registre 1.1 et retirée par close(). Source : partie `task` à
// l'état `running` (metadata.sessionId, state.input.prompt) ; racine par sessions.rootOf ; jamais journalisée ni publiée sur le hub.
// Racine inconnue → rien d'enregistré : la dérivation n'appelle JAMAIS sessions.ensure et ne part jamais en réseau (une consigne
// manquée vaut mieux qu'une file de processeur bloquée ; la phrase « absente » de « Revoir » le dit à l'utilisateur).
// Journal : le NOM de l'erreur et le callId seulement, jamais le message d'erreur (il peut recopier la consigne ou un morceau de
// requête SQL), jamais le texte. Une erreur n'arrête pas le processeur.
// Salle OMO (itération « 3s », L3s-a ; U2, D-3d-30, P11) : la même dérivation, pour `instance = "omo"`, est inscrite AUSSI sur le
// processeur de l'instance de la salle (section [3d] d'app-factory.ts, seulement si cette instance existe : salle coupée, rien ne
// change). Cloison des instances : la session qui confie le travail ET sa racine doivent être suivies par l'instance du processeur
// (`sessions.instance`) — un événement de la salle n'est jamais appliqué à une racine principale, ni l'inverse. Seul le texte de
// `state.input.prompt` est gardé, celui que l'assistant a écrit en confiant le travail : une partie qu'un crochet de l'extension
// ajoute ensuite au premier message de l'enfant n'est jamais lue ici (L25a n'en garde que les identifiants et le drapeau `hook`),
// ce que dit la phrase `copie` de « Revoir » (copie gardée au moment de l'envoi). Mêmes bornes, même masquage, même purge.
import { createConsignesStore } from "./consignes-store.ts";
import type { EventDerivation } from "./contracts-11.ts";
import type { Salle3dDeps } from "./contracts-3d.ts";
import type { OcGlobalEvent } from "./opencode.ts";
import { eventTime } from "./shared/activity-facts.ts";
import type { SessionInstance } from "./shared/activity-types.ts";

/** Nom de la dérivation, hors de STEP_ORDER (wiring-11). */
export const CONSIGNES_DERIVATION = "consignes-3d";

/** Nom de la même dérivation sur le processeur de la salle (L3s-a) : distinct, pour qu'une inscription se compte par instance. */
export const CONSIGNES_DERIVATION_SALLE = "consignes-3d-salle";

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const texte = (value: unknown): string | null => (typeof value === "string" && value !== "" ? value : null);

/** Nom d'une erreur, sans son message (qui pourrait recopier la consigne) : « SQLiteError », « TypeError », sinon son type. */
const nomErreur = (err: unknown): string => (err instanceof Error && err.name !== "" ? err.name : typeof err);

/**
 * Dérivation des consignes pour le processeur d'une instance : « principale » (défaut, processeur principal) ou « omo » (processeur
 * de la salle, L3s-a). Une partie dont la session ou la racine appartient à l'autre instance est ignorée (P11).
 */
export function createConsignesDerivation(deps: Salle3dDeps, instance: SessionInstance = "principale"): EventDerivation {
  const store = createConsignesStore(deps.db);

  return {
    name: instance === "omo" ? CONSIGNES_DERIVATION_SALLE : CONSIGNES_DERIVATION,
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
        // P11 (L3s-a) : la session qui confie et sa racine sont de l'instance de ce processeur, lue dans `sessions`, sinon rien.
        if (deps.sessions.instanceOf(parent) !== instance || deps.sessions.instanceOf(rootId) !== instance) return;
        store.enregistrer({ rootId, parent, enfant, callId: appel, brut: prompt, at: eventTime(event.id, Date.now()) });
      } catch (err: unknown) {
        deps.log.warn("consignes gardées : enregistrement abandonné", { callId, erreur: nomErreur(err) });
      }
    },
  };
}
