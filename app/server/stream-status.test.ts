// Bannière « Connexion au cockpit perdue » : seuil, remise à zéro et absence de clignotement au redémarrage.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { INITIAL_STREAM_STATE, nextStreamState, STREAM_LOST_AFTER, type StreamEvent, type StreamState } from "./shared/stream-status.ts";

/** Rejoue une suite d'événements depuis l'état initial. */
function replay(...events: StreamEvent[]): StreamState {
  return events.reduce(nextStreamState, INITIAL_STREAM_STATE);
}

describe("état du flux d'événements", () => {
  it("part en « connecting », sans erreur", () => {
    assert.deepEqual(INITIAL_STREAM_STATE, { status: "connecting", errors: 0 });
    assert.equal(STREAM_LOST_AFTER, 5);
  });

  it("4 erreurs consécutives : « error », pas encore perdu", () => {
    assert.deepEqual(replay("error", "error", "error", "error"), { status: "error", errors: 4 });
  });

  it("5 erreurs consécutives sans « hello » : « lost »", () => {
    assert.deepEqual(replay("error", "error", "error", "error", "error"), { status: "lost", errors: 5 });
  });

  it("« hello » : « open » et compteur à zéro", () => {
    assert.deepEqual(replay("error", "error", "hello"), { status: "open", errors: 0 });
    // Le compteur repart de zéro : quatre erreurs de plus ne suffisent pas à déclarer le flux perdu.
    assert.deepEqual(replay("error", "error", "hello", "error", "error", "error", "error"), { status: "error", errors: 4 });
  });

  it("un redémarrage du cockpit (quelques erreurs puis « hello ») ne fait jamais clignoter la bannière", () => {
    let state = INITIAL_STREAM_STATE;
    for (let i = 0; i < 20; i++) {
      state = nextStreamState(state, "error");
      state = nextStreamState(state, "open");
      state = nextStreamState(state, "hello");
      assert.equal(state.status, "open");
    }
    assert.equal(state.errors, 0);
  });

  it("« open » sans « hello » : ni remise à zéro, ni sortie de « lost »", () => {
    assert.deepEqual(replay("error", "error", "open"), { status: "connecting", errors: 2 });
    // Reconnexion du transport après le seuil : la bannière reste tant que le serveur n'a pas dit « hello ».
    const lost = replay("error", "error", "error", "error", "error", "open");
    assert.deepEqual(lost, { status: "lost", errors: 5 });
    assert.deepEqual(nextStreamState(lost, "hello"), { status: "open", errors: 0 });
  });

  it("une fois perdu, une erreur de plus ne change pas l'état affiché", () => {
    assert.deepEqual(replay("error", "error", "error", "error", "error", "error"), { status: "lost", errors: 6 });
  });
});
