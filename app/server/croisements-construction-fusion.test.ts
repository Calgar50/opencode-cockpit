// Tests de croisement de la grande fusion, GF4 : la construction (H5b' = 11f26eb) rejoint `chantier/1.1`, qui porte déjà
// l'itération 2, la salle (GF1), la 3D (GF2), « 3s » et les équipes (GF3) (plan d'exécution it5 §8.4 et §8.6 « GF4 » ; décisions
// A20, A27, A28, A33). Chaque branche garde ses propres tests : ici, seulement ce qui ne se voit QU'UNE FOIS la construction réunie.
//   1. câblage réuni : routes de la construction JUSTE AVANT le groupe de la salle, qui reste le dernier ; Seconde lecture en TÊTE
//      de beforeBilledSend, ordre de la salle en sous-suite ;
//   2. jonction U2 de GF3 × relecture de la construction : un seul envoi de message d'étape dans l'exécuteur, suivi de la section
//      de GF3, donc tours de relecture et relances compris ;
//   3. banc e2e (A33) : `onglet.medias()` de l'it4 passe par `emulerMedias` de R106-b — un seul envoi de
//      `Emulation.setEmulatedMedia` par onglet, jamais une liste sans `prefers-reduced-motion`, `medias({})` rend l'état du banc.
// Aucun appel facturé, aucun navigateur : l'onglet du banc est monté sur un client factice.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import { pathToFileURL } from "node:url";
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

// --- 3. Banc e2e : émulation des médias (A33) ------------------------------------------------------------------------------------

interface Envoi {
  methode: string;
  params: { features?: Array<{ name: string; value: string }> } & Record<string, unknown>;
}

interface OngletDuBanc {
  medias(options?: { forcedColors?: string | null; reducedMotion?: string | null; theme?: string | null }): Promise<string[]>;
  theme(nom: string): Promise<void>;
  mouvement(valeur: string): Promise<void>;
  evaluer(expression: string): Promise<unknown>;
  suivreMouvement(): void;
  finSuiviMouvement(): unknown;
}

interface ModuleCdp {
  creerOnglet(client: unknown, sessionId: string, targetId: string): Promise<OngletDuBanc>;
  verdictMouvement(suivi: unknown, pageDit?: string | null): string | null;
}

const chargerCdp = async (): Promise<ModuleCdp> => (await import(pathToFileURL(path.join(DEPOT, "e2e", "lib", "cdp.mjs")).href)) as ModuleCdp;

async function ongletFactice() {
  const envois: Envoi[] = [];
  const client = {
    envoyer: async (methode: string, params: Envoi["params"] = {}) => {
      envois.push({ methode, params });
      if (methode === "Runtime.evaluate") return { result: { value: true } };
      return {};
    },
    ecouter: () => () => undefined,
  };
  const { creerOnglet, verdictMouvement } = await chargerCdp();
  const onglet = await creerOnglet(client, "session-a33", "cible-a33");
  const medias = () =>
    envois.filter((e) => e.methode === "Emulation.setEmulatedMedia").map((e) => Object.fromEntries((e.params.features ?? []).map((f) => [f.name, f.value])));
  return { onglet, envois, medias, verdictMouvement };
}

describe("croisement GF4 : banc e2e, onglet.medias passe par emulerMedias (A33)", () => {
  it("cdp.mjs n'envoie Emulation.setEmulatedMedia qu'à UN endroit : emulerMedias", () => {
    const code = sansCommentaires(lire("e2e", "lib", "cdp.mjs"));
    const envois = [...code.matchAll(/envoyer\("Emulation\.setEmulatedMedia"/g)];
    assert.equal(envois.length, 1, "un autre envoi direct de Emulation.setEmulatedMedia est revenu dans cdp.mjs");
    const emuler = code.indexOf("const emulerMedias = async () =>");
    assert.ok(emuler >= 0 && code.indexOf('envoyer("Emulation.setEmulatedMedia"') > emuler, "l'envoi n'est plus dans emulerMedias");
    assert.ok(code.indexOf('envoyer("Emulation.setEmulatedMedia"') < code.indexOf("const onglet = {"), "l'envoi est sorti de emulerMedias");
  });

  it("medias() pose l'état et garde le mouvement ; medias({}) rend l'état du banc, jamais une liste vide", async () => {
    const { onglet, medias } = await ongletFactice();
    await onglet.mouvement("no-preference");
    await onglet.medias({ forcedColors: "active", reducedMotion: "reduce", theme: "sombre" });
    assert.deepEqual(medias().at(-1), { "prefers-reduced-motion": "reduce", "forced-colors": "active", "prefers-color-scheme": "dark" });
    // Thème seul : le contraste forcé et le mouvement demandés restent (un seul état, jamais un envoi partiel).
    await onglet.theme("clair");
    assert.deepEqual(medias().at(-1), { "prefers-reduced-motion": "reduce", "forced-colors": "active", "prefers-color-scheme": "light" });
    // medias({}) : l'état du banc — le mouvement fixé par le scénario, aucun thème ni contraste forcé.
    await onglet.medias({});
    assert.deepEqual(medias().at(-1), { "prefers-reduced-motion": "no-preference" });
    // Un scénario qui a fixé « reduce » le retrouve après medias({}) : medias() ne le rend jamais au poste.
    await onglet.mouvement("reduce");
    await onglet.medias({ theme: "sombre" });
    await onglet.medias({});
    assert.deepEqual(medias().at(-1), { "prefers-reduced-motion": "reduce" });
    // mouvement() lève le réglage demandé par medias() : il reste la seule commande du réglage du scénario.
    await onglet.medias({ reducedMotion: "no-preference" });
    await onglet.mouvement("reduce");
    assert.equal(medias().at(-1)?.["prefers-reduced-motion"], "reduce");
    // Aucun envoi sans prefers-reduced-motion, dans toute la suite.
    assert.deepEqual(medias().filter((m) => !("prefers-reduced-motion" in m)), []);
  });

  it("une valeur inconnue est refusée AVANT tout envoi, et l'état n'est pas changé", async () => {
    const { onglet, medias } = await ongletFactice();
    await onglet.medias({ theme: "sombre" });
    const avant = medias().length;
    await assert.rejects(() => onglet.medias({ forcedColors: "partout" }), /forced-colors/);
    await assert.rejects(() => onglet.medias({ reducedMotion: "lent" }), /prefers-reduced-motion/);
    await assert.rejects(() => onglet.medias({ theme: "nuit" }), /thème refusé/);
    assert.equal(medias().length, avant);
    await onglet.medias({ forcedColors: "active" });
    assert.deepEqual(medias().at(-1), { "prefers-reduced-motion": "no-preference", "forced-colors": "active" });
  });

  it("la garde du mouvement (R106-b) accepte un scénario qui passe par medias(), captures comprises", async () => {
    const { onglet, verdictMouvement } = await ongletFactice();
    onglet.suivreMouvement();
    await onglet.mouvement("no-preference");
    await onglet.evaluer("1");
    await onglet.medias({ forcedColors: "active", reducedMotion: "reduce", theme: "clair" });
    await onglet.evaluer("1");
    await onglet.medias({});
    await onglet.evaluer("1");
    assert.equal(verdictMouvement(onglet.finSuiviMouvement(), "no-preference"), null);
  });
});
