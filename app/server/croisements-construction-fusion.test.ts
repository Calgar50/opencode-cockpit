// Tests de croisement de la grande fusion, GF4 : la construction (H5b' = 11f26eb) rejoint `chantier/1.1`, qui porte déjà
// l'itération 2, la salle (GF1), la 3D (GF2), « 3s » et les équipes (GF3) (plan d'exécution it5 §8.4 et §8.6 « GF4 » ; décisions
// A20, A27, A28, A33). Chaque branche garde ses propres tests : ici, seulement ce qui ne se voit QU'UNE FOIS la construction réunie.
//   1. câblage réuni : routes de la construction JUSTE AVANT le groupe de la salle, qui reste le dernier ; Seconde lecture en TÊTE
//      de beforeBilledSend, ordre de la salle en sous-suite ;
//   2. jonction U2 de GF3 × relecture de la construction : un seul envoi de message d'étape dans l'exécuteur, suivi de la section
//      de GF3, donc tours de relecture et relances compris ;
// Aucun appel facturé, aucun conteneur : lecture du câblage et des sources.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import { CONSTRUCTION_ROUTES } from "./wiring-construction.ts";
import { STEP_ORDER } from "./wiring-11.ts";

const APP_DIR = path.join(import.meta.dirname, "..");
const DEPOT = path.join(APP_DIR, "..");
const lire = (...parts: string[]) => fs.readFileSync(path.join(DEPOT, ...parts), "utf8");

/** Commentaires retirés (bloc et ligne), pour ne compter que le code. */
const sansCommentaires = (source: string) => source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`])\/\/.*$/gm, "$1");

// --- 1. Câblage réuni -------------------------------------------------------------------------------------------------------------

describe("croisement GF4 : câblage de la construction dans la 1.1 réunie", () => {
  it("routes : la construction juste avant le groupe de la salle, qui reste le dernier ; aucun couple en double", () => {
    const routes = STEP_ORDER.routes.map((couple) => couple.join("/"));
    assert.deepEqual(STEP_ORDER.routes.at(-1), ["omo", "omoRoom"]);
    assert.deepEqual(
      STEP_ORDER.routes.slice(-CONSTRUCTION_ROUTES.length - 1, -1),
      CONSTRUCTION_ROUTES.map((couple) => [...couple]),
    );
    assert.equal(new Set(routes).size, routes.length, "couple de routes en double");
  });

  it("beforeBilledSend : Seconde lecture en tête, puis l'ordre de la 1.1, puis celui de la salle", () => {
    assert.deepEqual([...STEP_ORDER.hooks.beforeBilledSend], ["secondReading", "floors", "plans", "activation", "requests", "omoActivation", "omoCaps"]);
  });
});

// --- 2. Jonction U2 × relecture -----------------------------------------------------------------------------------------------

describe("croisement GF4 : jonction U2 de GF3 sur tous les envois d'étape de la construction", () => {
  it("un seul prompt_async dans l'exécuteur, et la section de jonction de GF3 le suit dans la même fonction", () => {
    const runner = sansCommentaires(lire("app", "server", "team-runner.ts"));
    const envois = [...runner.matchAll(/\/prompt_async`/g)];
    assert.equal(envois.length, 1, "l'exécuteur envoie un message d'étape à plus d'un endroit : chacun doit garder sa consigne");
    const source = lire("app", "server", "team-runner.ts");
    const envoi = source.indexOf("/prompt_async`");
    const jonction = source.indexOf("createConsignesStore(c11.db).enregistrer(", envoi);
    const finFonction = source.indexOf("await settleStep(run, key, watch);", envoi);
    assert.ok(jonction > envoi && jonction < finFonction, "la jonction U2 ne suit plus l'envoi du message d'étape");
    // Clé par tour et par tentative : un tour de relecture (même session, D-5-14) et une relance (tentative + 1) ont chacun la leur.
    assert.match(source, /callId: `etape-\$\{key\.tour\}-\$\{key\.tentative\}-\$\{sessionId\}`/);
  });
});
