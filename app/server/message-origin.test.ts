// Origine des messages (spécification §5.7.2, JP-1, JS-13 ; plan d'exécution, fiche L4a) : cas 1 à 3, 6 et 7 ; cas 4 et 5
// réservés et vides (T-L4-f) ; marqueur OMO jamais cru dans l'instance principale ; `prompts` l'emporte ; l'absence de `prompts`
// ne suffit jamais à conclure à une relance. Le cas 7 sur une capture réelle est dans activity-facts.test.ts (§6 l.1066).
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { MessageOrigin, SessionInstance } from "./shared/activity-types.ts";
import { classifyOrigin, isSyntheticMessage, OMO_INITIATOR_MARKER, type OriginContext, type OriginPart, originVerdict } from "./shared/message-origin.ts";

const NOREPLY_MARKER = "<!-- OMO_INTERNAL_NOREPLY -->";
const SYSTEM_DIRECTIVE = "[SYSTEM DIRECTIVE: OH-MY-OPENCODE - TODO CONTINUATION]";

const text = (value: string, synthetic?: boolean): OriginPart => (synthetic === undefined ? { type: "text", text: value } : { type: "text", text: value, synthetic });
const ctx = (over: Partial<OriginContext> = {}): OriginContext => ({ promptKind: null, firstUserOfChild: false, instance: "principale", ...over });

describe("origine des messages : les cas actifs", () => {
  it("cas 1 : message présent dans prompts avec kind = message → demande", () => {
    assert.deepEqual(originVerdict([text("Analyse les journaux")], ctx({ promptKind: "message" })), { cas: 1, origine: "demande" });
  });

  it("cas 2 : kind = equipe-* → cockpit", () => {
    for (const promptKind of ["equipe-demande", "equipe-resultat"]) {
      assert.deepEqual(originVerdict([text("Consigne d'étape")], ctx({ promptKind })), { cas: 2, origine: "cockpit" }, promptKind);
    }
  });

  it("cas 3 : premier message utilisateur d'une session enfant → consigne", () => {
    assert.deepEqual(originVerdict([text("Analyse le fichier")], ctx({ firstUserOfChild: true })), { cas: 3, origine: "consigne" });
    // JS-13 : même avec un marqueur de l'extension, dans la salle, la première consigne d'un enfant reste une consigne.
    assert.equal(classifyOrigin([text(`${SYSTEM_DIRECTIVE} suite`)], ctx({ firstUserOfChild: true, instance: "omo" })), "consigne");
  });

  it("cas 6 : synthetic: true → interne-opencode (principale) ou interne-extension (salle) ; marqueur d'initiateur cru dans la salle seulement", () => {
    const synthetic = [text("Summarize the task tool output above and continue", true)];
    assert.deepEqual(originVerdict(synthetic, ctx()), { cas: 6, origine: "interne-opencode" });
    assert.deepEqual(originVerdict(synthetic, ctx({ instance: "omo" })), { cas: 6, origine: "interne-extension" });
    assert.deepEqual(originVerdict([text(`Réveil ${OMO_INITIATOR_MARKER}`)], ctx({ instance: "omo" })), { cas: 6, origine: "interne-extension" });
  });

  it("cas 7 : rien de ce qui précède → origine-inconnue", () => {
    assert.deepEqual(originVerdict([text("Bonjour")], ctx()), { cas: 7, origine: "origine-inconnue" });
    assert.deepEqual(originVerdict([], ctx()), { cas: 7, origine: "origine-inconnue" });
    assert.deepEqual(originVerdict([{ type: "subtask" }], ctx({ instance: "omo" })), { cas: 7, origine: "origine-inconnue" });
  });
});

describe("origine des messages : règles d'ordre et de prudence", () => {
  it("un marqueur OMO n'est jamais cru dans l'instance principale → origine-inconnue", () => {
    for (const marker of [OMO_INITIATOR_MARKER, NOREPLY_MARKER, SYSTEM_DIRECTIVE]) {
      assert.deepEqual(originVerdict([text(`${marker} Continue`)], ctx()), { cas: 7, origine: "origine-inconnue" }, marker);
      assert.deepEqual(originVerdict([text(`Texte ${marker}`, false)], ctx()), { cas: 7, origine: "origine-inconnue" }, marker);
    }
  });

  it("un message de prompts l'emporte toujours : un utilisateur qui tape un marqueur reste « Vous »", () => {
    const everything = [text(`${OMO_INITIATOR_MARKER} ${NOREPLY_MARKER} ${SYSTEM_DIRECTIVE}`, true)];
    for (const instance of ["principale", "omo"] satisfies SessionInstance[]) {
      assert.deepEqual(originVerdict(everything, ctx({ promptKind: "message", firstUserOfChild: true, instance })), { cas: 1, origine: "demande" }, instance);
      assert.deepEqual(originVerdict(everything, ctx({ promptKind: "equipe-demande", firstUserOfChild: true, instance })), { cas: 2, origine: "cockpit" }, instance);
    }
  });

  it("un genre de prompts inconnu n'est pas cru", () => {
    for (const promptKind of ["", "Message", "equipe", "equipe-", "equipe-demande x", "autre"]) {
      assert.equal(classifyOrigin([text("Bonjour")], ctx({ promptKind })), "origine-inconnue", promptKind);
    }
  });

  it("l'absence de prompts ne suffit jamais à conclure à une relance", () => {
    for (const instance of ["principale", "omo"] satisfies SessionInstance[]) {
      assert.equal(classifyOrigin([text("Continue la tâche en cours")], ctx({ instance })), "origine-inconnue", instance);
      assert.equal(classifyOrigin([text(`${SYSTEM_DIRECTIVE} Continue`)], ctx({ instance })), "origine-inconnue", instance);
    }
  });

  it("un message n'est synthétique que si toutes ses parties texte le sont", () => {
    assert.equal(isSyntheticMessage([text("a", true), text("b", true)]), true);
    assert.equal(isSyntheticMessage([text("Vraie demande"), text("Called the Read tool", true)]), false);
    assert.equal(isSyntheticMessage([{ type: "file" }, text("b", true)]), true);
    assert.equal(isSyntheticMessage([{ type: "subtask", synthetic: true }]), false);
    assert.equal(isSyntheticMessage([text("a", "true" as unknown as boolean)]), false);
    assert.equal(classifyOrigin([text("Vraie demande"), text("Called the Read tool", true)], ctx()), "origine-inconnue");
  });
});

describe("origine des messages : cas 4 et 5 réservés (T-L4-f)", () => {
  it("aucune combinaison ne rend reveil-sans-reponse ni relance-extension, et aucun verdict ne porte le cas 4 ou 5", () => {
    const partsVariants: OriginPart[][] = [
      [],
      [text("Bonjour")],
      [text("Bonjour", true)],
      [text(NOREPLY_MARKER)],
      [text(NOREPLY_MARKER, true)],
      [text(`${SYSTEM_DIRECTIVE} Continue`)],
      [text(`${SYSTEM_DIRECTIVE} Continue`, true)],
      [text(OMO_INITIATOR_MARKER)],
      [{ type: "text", synthetic: true }],
      [{ type: "subtask" }],
    ];
    const seen = new Set<MessageOrigin>();
    let runs = 0;
    for (const parts of partsVariants) {
      for (const promptKind of [null, "message", "equipe-resultat", "inconnu"]) {
        for (const firstUserOfChild of [false, true]) {
          for (const instance of ["principale", "omo"] satisfies SessionInstance[]) {
            const verdict = originVerdict(parts, { promptKind, firstUserOfChild, instance });
            runs++;
            seen.add(verdict.origine);
            assert.ok(verdict.cas !== 4 && verdict.cas !== 5, JSON.stringify({ parts, promptKind, firstUserOfChild, instance }));
            assert.equal(classifyOrigin(parts, { promptKind, firstUserOfChild, instance }), verdict.origine);
          }
        }
      }
    }
    assert.equal(runs, 160);
    assert.equal(seen.has("reveil-sans-reponse"), false);
    assert.equal(seen.has("relance-extension"), false);
    // Le balayage atteint bien les cinq cas actifs (sinon il ne prouverait rien).
    assert.deepEqual([...seen].sort(), ["cockpit", "consigne", "demande", "interne-extension", "interne-opencode", "origine-inconnue"]);
  });
});
