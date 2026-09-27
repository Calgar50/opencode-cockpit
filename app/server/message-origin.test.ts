// Origine des messages (spécification §5.7.2, JP-1, JS-13 ; plan d'exécution, fiches L4a puis L25a) : les sept cas, dont le cas 4
// (réveil sans réponse, JP-2) et le cas 5 (relance de l'extension sur une racine, JS-13) ouverts par L25a ; marqueur OMO jamais cru
// dans l'instance principale ; `prompts` l'emporte ; l'absence de `prompts` ne suffit jamais à conclure à une relance ; identité
// douteuse (MO-1) → cas 7. Le cas 7 sur une capture réelle est dans activity-facts.test.ts (§6 l.1066).
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { MessageOrigin, SessionInstance } from "./shared/activity-types.ts";
import {
  classifyOrigin,
  contextVerdict,
  isSyntheticMessage,
  OMO_INITIATOR_MARKER,
  OMO_NOREPLY_MARKER,
  OMO_RELANCE_TYPE_MAX,
  OMO_RELANCE_TYPES_CONNUS,
  OMO_SYSTEM_DIRECTIVE_PREFIX,
  type OriginContext,
  type OriginPart,
  originPartSummary,
  originVerdict,
  relanceType,
} from "./shared/message-origin.ts";

const NOREPLY_MARKER = "<!-- OMO_INTERNAL_NOREPLY -->";
const SYSTEM_DIRECTIVE = "[SYSTEM DIRECTIVE: OH-MY-OPENCODE - TODO CONTINUATION]";

const text = (value: string, synthetic?: boolean): OriginPart => (synthetic === undefined ? { type: "text", text: value } : { type: "text", text: value, synthetic });
const ctx = (over: Partial<OriginContext> = {}): OriginContext => ({ promptKind: null, firstUserOfChild: false, instance: "principale", racine: true, ...over });
/** Contexte d'une racine de la Salle OMO : le seul où les cas 4 et 5 peuvent se déclencher sur un marqueur. */
const salle = (over: Partial<OriginContext> = {}): OriginContext => ctx({ instance: "omo", racine: true, ...over });

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
    assert.deepEqual(originVerdict([text("Analyse le fichier")], ctx({ firstUserOfChild: true, racine: false })), { cas: 3, origine: "consigne" });
    // T-L25-h, JS-13 : le préfixe de relance sur la PREMIÈRE consigne d'un enfant reste une consigne, jamais une relance.
    assert.deepEqual(originVerdict([text(`${SYSTEM_DIRECTIVE} suite`)], salle({ firstUserOfChild: true, racine: false })), { cas: 3, origine: "consigne" });
  });

  it("cas 4 (T-L25-a) : marqueur de réveil dans la salle, ou message déposé sans tour → reveil-sans-reponse", () => {
    assert.deepEqual(originVerdict([text(`Résultat déposé ${NOREPLY_MARKER}`)], salle()), { cas: 4, origine: "reveil-sans-reponse" });
    assert.deepEqual(originVerdict([text(NOREPLY_MARKER, true)], salle({ racine: false })), { cas: 4, origine: "reveil-sans-reponse" });
    // Le marqueur n'est pas cru dans l'instance principale, qui n'a pas d'extension (cas 7).
    assert.deepEqual(originVerdict([text(NOREPLY_MARKER)], ctx()), { cas: 7, origine: "origine-inconnue" });
    // Le drapeau `noReply` décrit la façon dont opencode a enregistré le message : il vaut dans les deux instances.
    for (const instance of ["principale", "omo"] satisfies SessionInstance[]) {
      assert.deepEqual(originVerdict([text("Résultat d'une équipe")], ctx({ instance, noReply: true })), { cas: 4, origine: "reveil-sans-reponse" }, instance);
    }
    // Le cas 4 passe avant le cas 6 : un réveil entièrement synthétique reste un réveil.
    assert.deepEqual(originVerdict([text(NOREPLY_MARKER, true), text("Suite", true)], salle()), { cas: 4, origine: "reveil-sans-reponse" });
  });

  it("cas 5 (T-L25-a, JS-13) : préfixe de relance sur une RACINE de la salle → relance-extension et son type", () => {
    assert.deepEqual(originVerdict([text(`${SYSTEM_DIRECTIVE}\nContinue`)], salle()), { cas: 5, origine: "relance-extension", relance: "todo-continuation" });
    // Le préfixe peut arriver dans n'importe laquelle des parties texte.
    assert.deepEqual(originVerdict([{ type: "file" }, text(`${SYSTEM_DIRECTIVE} Continue`)], salle()), { cas: 5, origine: "relance-extension", relance: "todo-continuation" });
    // Hors de la salle, ou dans un enfant, le préfixe n'est jamais cru.
    assert.deepEqual(originVerdict([text(`${SYSTEM_DIRECTIVE} Continue`)], ctx()), { cas: 7, origine: "origine-inconnue" });
    assert.deepEqual(originVerdict([text(`${SYSTEM_DIRECTIVE} Continue`)], salle({ racine: false })), { cas: 7, origine: "origine-inconnue" });
    // Le préfixe doit être en TÊTE : au milieu d'un texte, il ne prouve rien.
    assert.deepEqual(originVerdict([text(`Suite du travail ${SYSTEM_DIRECTIVE}`)], salle()), { cas: 7, origine: "origine-inconnue" });
    // Le cas 4 passe avant le cas 5 : un réveil marqué qui porte aussi le préfixe reste un réveil.
    assert.deepEqual(originVerdict([text(`${SYSTEM_DIRECTIVE} ${NOREPLY_MARKER}`)], salle()), { cas: 4, origine: "reveil-sans-reponse" });
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
    assert.deepEqual(originVerdict([{ type: "subtask" }], salle()), { cas: 7, origine: "origine-inconnue" });
  });
});

describe("origine des messages : types de relance de l'extension (cas 5)", () => {
  it("les types relevés en 4.19.4 sont reconnus et rendus en code", () => {
    const attendus = ["todo-continuation", "boulder-continuation", "task-continuation", "for-continuation", "ralph-loop-1-5", "ultrawork-loop-verification-2-5"];
    assert.equal(OMO_RELANCE_TYPES_CONNUS.length, attendus.length);
    for (const [i, type] of OMO_RELANCE_TYPES_CONNUS.entries()) {
      assert.equal(relanceType(`${OMO_SYSTEM_DIRECTIVE_PREFIX} - ${type}]`), attendus[i], type);
    }
  });

  it("un type inconnu est accepté (une version plus récente doit rester visible), une forme non reconnue ne l'est pas", () => {
    assert.equal(relanceType(`${OMO_SYSTEM_DIRECTIVE_PREFIX} - NOUVEAU TYPE 9]`), "nouveau-type-9");
    assert.equal(relanceType(`   \n${SYSTEM_DIRECTIVE}`), "todo-continuation", "les espaces de début sont tolérés, comme dans l'extension");
    for (const refuse of [
      "",
      "Bonjour",
      `Texte ${SYSTEM_DIRECTIVE}`,
      "[SYSTEM DIRECTIVE: OH-MY-OPENCODE]",
      "[SYSTEM DIRECTIVE: OH-MY-OPENCODE - ]",
      "[SYSTEM DIRECTIVE: OH-MY-OPENCODE - todo continuation]",
      "[SYSTEM DIRECTIVE: OH-MY-OPENCODE - TODO; rm -rf /]",
      `[SYSTEM DIRECTIVE: OH-MY-OPENCODE - ${"A".repeat(OMO_RELANCE_TYPE_MAX + 2)}]`,
      "[SYSTEM DIRECTIVE: AUTRE - TODO CONTINUATION]",
    ]) {
      assert.equal(relanceType(refuse), null, refuse.slice(0, 48));
    }
  });

  it("le type rendu est un code : ni espace, ni accent, ni ponctuation, et il tient dans un fait", () => {
    for (const type of [...OMO_RELANCE_TYPES_CONNUS, "NOUVEAU TYPE 9", "A_B-C/D 1"]) {
      const code = relanceType(`${OMO_SYSTEM_DIRECTIVE_PREFIX} - ${type}]`);
      assert.notEqual(code, null, type);
      assert.match(code as string, /^[a-z0-9][a-z0-9-]*$/, type);
      assert.ok((code as string).length <= OMO_RELANCE_TYPE_MAX, type);
    }
  });
});

describe("origine des messages : règles d'ordre et de prudence", () => {
  it("un marqueur OMO n'est jamais cru dans l'instance principale → origine-inconnue", () => {
    for (const marker of [OMO_INITIATOR_MARKER, NOREPLY_MARKER, SYSTEM_DIRECTIVE]) {
      assert.deepEqual(originVerdict([text(`${marker} Continue`)], ctx()), { cas: 7, origine: "origine-inconnue" }, marker);
      assert.deepEqual(originVerdict([text(`Texte ${marker}`, false)], ctx()), { cas: 7, origine: "origine-inconnue" }, marker);
    }
  });

  it("T-L25-g : un message de prompts l'emporte toujours, un utilisateur qui tape un marqueur reste « Vous »", () => {
    const everything = [text(`${SYSTEM_DIRECTIVE} ${OMO_INITIATOR_MARKER} ${NOREPLY_MARKER}`, true)];
    for (const instance of ["principale", "omo"] satisfies SessionInstance[]) {
      for (const racine of [false, true]) {
        assert.deepEqual(originVerdict(everything, ctx({ promptKind: "message", firstUserOfChild: true, instance, racine })), { cas: 1, origine: "demande" }, instance);
        assert.deepEqual(originVerdict(everything, ctx({ promptKind: "equipe-demande", firstUserOfChild: true, instance, racine })), { cas: 2, origine: "cockpit" }, instance);
      }
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
      assert.equal(classifyOrigin([text("Poursuis, c'est urgent")], ctx({ instance })), "origine-inconnue", instance);
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

  it("MO-1 : une identité de message douteuse ferme tout le classement, même la ligne prompts", () => {
    const suspect = { identiteSuspecte: true };
    // Le `messageID` est un corrélateur forgeable : il ne prouve pas que le cockpit a envoyé ce message-là.
    assert.deepEqual(originVerdict([text("Analyse les journaux")], ctx({ promptKind: "message", ...suspect })), { cas: 7, origine: "origine-inconnue" });
    assert.equal(contextVerdict(ctx({ promptKind: "message", ...suspect })), null);
    for (const over of [{ promptKind: "equipe-demande" }, { firstUserOfChild: true, racine: false }, { noReply: true }]) {
      assert.deepEqual(originVerdict([text(`${SYSTEM_DIRECTIVE} ${NOREPLY_MARKER}`, true)], salle({ ...over, ...suspect })), { cas: 7, origine: "origine-inconnue" }, JSON.stringify(over));
    }
    // Sans le doute, les mêmes contextes rendent bien autre chose : le test ne prouverait rien sinon.
    assert.deepEqual(originVerdict([text("Analyse les journaux")], ctx({ promptKind: "message" })), { cas: 1, origine: "demande" });
  });
});

describe("origine des messages : verdict du contexte et parties réduites", () => {
  it("contextVerdict : cas 1 à 3 sans lire les parties, null sinon ; originVerdict le reprend avant toute règle sur les parties", () => {
    assert.deepEqual(contextVerdict(ctx({ promptKind: "message" })), { cas: 1, origine: "demande" });
    assert.deepEqual(contextVerdict(ctx({ promptKind: "equipe-resultat", firstUserOfChild: true })), { cas: 2, origine: "cockpit" });
    assert.deepEqual(contextVerdict(ctx({ firstUserOfChild: true, instance: "omo" })), { cas: 3, origine: "consigne" });
    for (const over of [{}, { promptKind: "inconnu" }, { instance: "omo" as const }]) assert.equal(contextVerdict(ctx(over)), null, JSON.stringify(over));
    for (const promptKind of [null, "message", "equipe-demande"]) {
      for (const firstUserOfChild of [false, true]) {
        const known = contextVerdict(ctx({ promptKind, firstUserOfChild }));
        if (known !== null) assert.deepEqual(originVerdict([text("x", true)], ctx({ promptKind, firstUserOfChild })), known);
      }
    }
  });

  it("originPartSummary : ni texte libre ni secret gardé ; le préfixe de relance reste en tête ; même verdict que sur les parties entières", () => {
    const token = ["gh", "p_", "a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8"].join("");
    const summary = originPartSummary({ type: "text", text: `Texte libre ${token} ${OMO_INITIATOR_MARKER} suite`, synthetic: true, id: "prt_1" });
    assert.deepEqual(summary, { type: "text", synthetic: true, text: OMO_INITIATOR_MARKER });
    assert.deepEqual(originPartSummary({ type: "subtask", prompt: "Consigne libre" }), { type: "subtask", synthetic: false });
    assert.deepEqual(originPartSummary({ type: 42, synthetic: "true", text: 7 }), { type: "", synthetic: false });
    // Le préfixe est recopié tel qu'il a été reconnu, à la position 0 : la règle du cas 5 lit un PRÉFIXE.
    assert.deepEqual(originPartSummary({ type: "text", text: `  ${SYSTEM_DIRECTIVE} Reprends le travail ${NOREPLY_MARKER}` }), {
      type: "text",
      synthetic: false,
      text: `${SYSTEM_DIRECTIVE} ${NOREPLY_MARKER}`,
    });
    assert.equal(originPartSummary({ type: "text", text: `Suite ${SYSTEM_DIRECTIVE}` }).text, "", "un préfixe qui n'en est pas un n'est pas gardé");
    // Garde-fou : une règle qui lira un nouveau marqueur fera échouer ce balayage tant que originPartSummary ne le garde pas.
    const variants: OriginPart[][] = [
      [text("Bonjour")],
      [text("Bonjour", true), text("Suite", true)],
      [text("Vraie demande"), text("Called the Read tool", true)],
      [text(`${OMO_INITIATOR_MARKER} Réveil`)],
      [text(`Texte ${OMO_INITIATOR_MARKER}`, false), text("Autre", true)],
      [text(NOREPLY_MARKER)],
      [text(`${NOREPLY_MARKER} ${OMO_INITIATOR_MARKER}`, true)],
      [text(`${SYSTEM_DIRECTIVE} Continue`)],
      [text(`${SYSTEM_DIRECTIVE} Continue`, true)],
      [text(`${SYSTEM_DIRECTIVE} ${NOREPLY_MARKER}`), text("Autre")],
      [text(`[SYSTEM DIRECTIVE: OH-MY-OPENCODE - BOULDER CONTINUATION] suite`)],
      [text(`Suite ${SYSTEM_DIRECTIVE}`)],
      [{ type: "subtask" }, { type: "file" }],
      [{ type: "text", synthetic: true }],
    ];
    let runs = 0;
    for (const parts of variants) {
      for (const firstUserOfChild of [false, true]) {
        for (const racine of [false, true]) {
          for (const instance of ["principale", "omo"] satisfies SessionInstance[]) {
            const context = ctx({ firstUserOfChild, instance, racine });
            assert.deepEqual(originVerdict(parts.map((part) => originPartSummary({ ...part })), context), originVerdict(parts, context), JSON.stringify({ parts, instance, racine }));
            runs++;
          }
        }
      }
    }
    assert.equal(runs, 112);
  });
});

describe("origine des messages : balayage complet des sept cas", () => {
  it("chaque combinaison rend un verdict cohérent, et les sept cas sont atteints", () => {
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
    const cas = new Set<number>();
    let runs = 0;
    for (const parts of partsVariants) {
      for (const promptKind of [null, "message", "equipe-resultat", "inconnu"]) {
        for (const firstUserOfChild of [false, true]) {
          for (const racine of [false, true]) {
            for (const instance of ["principale", "omo"] satisfies SessionInstance[]) {
              const context: OriginContext = { promptKind, firstUserOfChild, instance, racine };
              const verdict = originVerdict(parts, context);
              runs++;
              seen.add(verdict.origine);
              cas.add(verdict.cas);
              assert.equal(classifyOrigin(parts, context), verdict.origine);
              // Seul le cas 5 porte un type de relance, et c'est toujours un code.
              if (verdict.cas === 5) assert.match(verdict.relance as string, /^[a-z0-9][a-z0-9-]*$/);
              else assert.equal(verdict.relance, undefined, JSON.stringify({ parts, context }));
            }
          }
        }
      }
    }
    assert.equal(runs, 320);
    assert.deepEqual([...cas].sort((a, b) => a - b), [1, 2, 3, 4, 5, 6, 7]);
    assert.deepEqual([...seen].sort(), ["cockpit", "consigne", "demande", "interne-extension", "interne-opencode", "origine-inconnue", "relance-extension", "reveil-sans-reponse"]);
  });

  it("le marqueur exact de la liste fermée est le seul cru : aucune variante n'ouvre le cas 4, le cas 5 ni le cas 6", () => {
    for (const variante of ["<!--OMO_INTERNAL_NOREPLY-->", "<!-- omo_internal_noreply -->", "<!-- OMO_INTERNAL_NOREPLY-->"]) {
      assert.deepEqual(originVerdict([text(variante)], salle()), { cas: 7, origine: "origine-inconnue" }, variante);
    }
    assert.equal(OMO_NOREPLY_MARKER, NOREPLY_MARKER);
    assert.equal(OMO_SYSTEM_DIRECTIVE_PREFIX, "[SYSTEM DIRECTIVE: OH-MY-OPENCODE");
    assert.ok(SYSTEM_DIRECTIVE.startsWith(OMO_SYSTEM_DIRECTIVE_PREFIX));
  });
});
