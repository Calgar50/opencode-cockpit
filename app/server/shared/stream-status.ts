// État du flux temps réel (SSE /api/events) : module PUR (aucun import « node: », aucun accès au DOM).
//
// Le navigateur voit passer des erreurs d'EventSource à chaque redémarrage du cockpit (mise à jour, restart, renouvellement du
// certificat). Une seule erreur ne veut donc rien dire : la bannière « Connexion au cockpit perdue » n'apparaît qu'après
// STREAM_LOST_AFTER erreurs consécutives sans trame « hello », ce qui évite le clignotement au redémarrage (plan 1.0.5 §2.1).

export type StreamStatus = "connecting" | "open" | "error" | "lost";

/** Événements du flux : trame « hello » du serveur, erreur d'EventSource, ou connexion ouverte avant tout « hello ». */
export type StreamEvent = "hello" | "error" | "open";

export interface StreamState {
  status: StreamStatus;
  /** Erreurs consécutives depuis le dernier « hello » ; seule cette trame prouve que le flux est réellement revenu. */
  errors: number;
}

/** Erreurs consécutives sans « hello » à partir desquelles le flux est déclaré perdu. */
export const STREAM_LOST_AFTER = 5;

export const INITIAL_STREAM_STATE: StreamState = { status: "connecting", errors: 0 };

/**
 * Transition de l'état du flux. « hello » remet le compteur à zéro (seule preuve d'un flux vivant) ; « error » l'incrémente et
 * bascule en « lost » au cinquième échec ; « open » (connexion rétablie, trame « hello » pas encore reçue) ne remet rien à zéro
 * et ne sort jamais de « lost ».
 */
export function nextStreamState(state: StreamState, event: StreamEvent): StreamState {
  if (event === "hello") return { status: "open", errors: 0 };
  if (event === "error") {
    const errors = state.errors + 1;
    return { status: errors >= STREAM_LOST_AFTER ? "lost" : "error", errors };
  }
  return { status: state.status === "lost" ? "lost" : "connecting", errors: state.errors };
}
