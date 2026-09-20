// Contrats de la salle de contrôle 3D et de « Revoir » (itération 3, T3d-a ; plan d'exécution it3 §4.1.4) : routes neutres montées
// par app-factory HORS du registre 1.1, lecture seule sans requête à opencode, dérivation des consignes inscrite puis retirée par
// close(), surcharges de ports, client web mince, types sans code, squelettes sans three, aucun import d'un autre paquet de la
// vague 0 (D-3d-27), sections balisées [3d] (D-3d-24). Chaque contrôle statique est éprouvé sur un source fabriqué.
import assert from "node:assert/strict";
import fs from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import path from "node:path";
import { describe, it, type TestContext } from "node:test";
import { Hono } from "hono";
import { salle3dApi } from "../web/lib/api-salle3d.ts";
import { ApiError } from "../web/lib/api.ts";
import { chargerMoteur } from "../web/pages/salle-controle/moteur-chargeur.ts";
import type { EventDerivation } from "./contracts-11.ts";
import { EventProcessor } from "./processor.ts";
import type { NeonMode } from "./shared/neon-scene.ts";
import type { RevoirConsigneResponse, TerritoiresResponse } from "./shared/salle3d-types.ts";
import { type CockpitHarness, startCockpit } from "./test-support/cockpit-harness.ts";
import { until } from "./test-support/helpers.ts";
import { buildSalle3dRoutes } from "./wiring-3d.ts";

const APP_DIR = path.join(import.meta.dirname, "..");
const ROOT = "ses_racine3d";
const ENFANT = "ses_enfant3d";
const CALL = "call_3d1";

/** Fichiers de la fiche T3d-a (relatifs à app/). */
const FICHIERS_T3D_A = [
  "server/shared/salle3d-types.ts",
  "server/contracts-3d.ts",
  "server/wiring-3d.ts",
  "server/routes-territoires.ts",
  "server/territoires-service.ts",
  "server/routes-revoir.ts",
  "server/revoir-service.ts",
  "server/consignes-store.ts",
  "server/consignes-capture.ts",
  "server/routes-consignes.ts",
  "web/lib/api-salle3d.ts",
  "web/pages/salle-controle/slots-3d.ts",
  "web/pages/salle-controle/SalleControlePage.tsx",
  "web/pages/salle-controle/ZoomConversation.tsx",
  "web/pages/salle-controle/Scene3d.tsx",
  "web/pages/salle-controle/revoir/BandCommands3d.tsx",
  "web/pages/salle-controle/revoir/RevoirEntree.tsx",
  "web/pages/salle-controle/revoir/ReplayBar.tsx",
  "web/pages/salle-controle/revoir/RevoirDialog.tsx",
  "web/pages/salle-controle/revoir/LegendeBulle.tsx",
  "web/pages/salle-controle/revoir/ConsigneRevoir.tsx",
  "web/pages/salle-controle/moteur-chargeur.ts",
  "web/pages/salle-controle/three/moteur.ts",
  "server/salle3d-contrats.test.ts",
  "server/app-factory.ts",
  "web/app/App.tsx",
] as const;

/** Fichiers créés par les autres paquets de la vague 0 (plan it3 §4.2 et §6) : aucun fichier de T3d-a ne les importe (D-3d-27). */
const AUTRES_PAQUETS_V0: Readonly<Record<string, readonly string[]>> = {
  "T3d-b": [
    "server/shared/salle3d-texts.ts",
    "server/shared/revoir-texts.ts",
    "server/shared/legendes-texts.ts",
    "server/textes-3d.test.ts",
    "server/salle3d-animations.test.ts",
  ],
  L32: [
    "server/build-three-guard.ts",
    "server/three-guard.test.ts",
    "server/p8-dependances.test.ts",
    "server/three-import.test.ts",
    "server/three-exports.test.ts",
    "web/pages/salle-controle/three/three.d.ts",
  ],
  L30: [
    "server/shared/fluidity.ts",
    "server/fluidity.test.ts",
    "web/pages/salle-controle/fluidite.ts",
    "web/pages/salle-controle/useFluidite.ts",
    "server/fluidite-sonde.test.ts",
  ],
  L28a: [
    "server/shared/revoir.ts",
    "server/shared/legendes.ts",
    "server/shared/revoir-access.ts",
    "server/revoir.test.ts",
    "server/legendes.test.ts",
    "server/revoir-access.test.ts",
  ],
};

/** Squelettes : « Propriétaire : Lxx. » en première ligne (même règle que wiring-11.test.ts). */
const PROPRIETAIRES: Readonly<Record<string, string>> = {
  "server/routes-territoires.ts": "L31a",
  "server/territoires-service.ts": "L31a",
  "server/routes-revoir.ts": "L28b",
  "server/revoir-service.ts": "L28b",
  "server/consignes-store.ts": "L28d",
  "server/consignes-capture.ts": "L28d",
  "server/routes-consignes.ts": "L28d",
  "web/pages/salle-controle/SalleControlePage.tsx": "L31b",
  "web/pages/salle-controle/ZoomConversation.tsx": "L31c",
  "web/pages/salle-controle/Scene3d.tsx": "L29d",
  "web/pages/salle-controle/revoir/BandCommands3d.tsx": "L28b",
  "web/pages/salle-controle/revoir/RevoirEntree.tsx": "L28b",
  "web/pages/salle-controle/revoir/ReplayBar.tsx": "L28c",
  "web/pages/salle-controle/revoir/RevoirDialog.tsx": "L28c",
  "web/pages/salle-controle/revoir/LegendeBulle.tsx": "L28c",
  "web/pages/salle-controle/revoir/ConsigneRevoir.tsx": "L28d",
  "web/pages/salle-controle/moteur-chargeur.ts": "L29c",
  "web/pages/salle-controle/three/moteur.ts": "L29c",
};

const lire = (relatif: string) => fs.readFileSync(path.join(APP_DIR, relatif), "utf8");

/**
 * Refus d'une route 3d, sans recopier la phrase : statut, code, et « une phrase est là ». Les phrases sont dans revoir-texts.ts
 * (T3d-b), que ce fichier n'importe pas (D-3d-27).
 */
const refus = ({ status, body }: { status: number; body: unknown }) => {
  const rendu = body as { error?: unknown; code?: unknown; message?: unknown };
  return { status, code: String(rendu.code), phrase: rendu.code === rendu.error && typeof rendu.message === "string" && rendu.message.length > 10 };
};

// --- Contrôles statiques (commentaires ignorés) --------------------------------------------------------------------------------

/** Texte sans commentaires, lu de gauche à droite (recopié de core.test.ts). */
function sansCommentaires(text: string): string {
  let out = "";
  for (let i = 0; i < text.length; ) {
    if (text.startsWith("//", i)) {
      const end = text.indexOf("\n", i);
      i = end === -1 ? text.length : end;
    } else if (text.startsWith("/*", i)) {
      const end = text.indexOf("*/", i + 2);
      i = end === -1 ? text.length : end + 2;
    } else {
      out += text[i];
      i++;
    }
  }
  return out;
}

/**
 * Modules importés : déclarations en début de ligne (import, import type, export … from, sur plusieurs lignes comprises) et
 * import() dynamiques, commentaires ignorés.
 */
function importsOf(source: string): { statiques: string[]; dynamiques: string[] } {
  const code = sansCommentaires(source);
  const statiques = [
    ...[...code.matchAll(/^[ \t]*(?:import|export)\b[^;]*?\bfrom[ \t]*["']([^"']+)["']/gm)].map((m) => m[1] ?? ""),
    ...[...code.matchAll(/^[ \t]*import[ \t]*["']([^"']+)["']/gm)].map((m) => m[1] ?? ""),
  ];
  const dynamiques = [...code.matchAll(/\bimport[ \t]*\([ \t]*["']([^"']+)["'][ \t]*\)/g)].map((m) => m[1] ?? "");
  return { statiques, dynamiques };
}

const tousLesImports = (source: string) => {
  const { statiques, dynamiques } = importsOf(source);
  return [...statiques, ...dynamiques];
};

const importeThree = (source: string) => tousLesImports(source).some((spec) => spec === "three" || spec.startsWith("three/"));

/** Fichier de types : il ne reste rien une fois les types effacés et les commentaires retirés ; aucun import de valeur. */
function typesSeulement(source: string): boolean {
  return sansCommentaires(stripTypeScriptTypes(source)).trim() === "" && !/^\s*import (?!type\b)/m.test(source);
}

/** Imports relatifs de `fichier` (relatif à app/) qui désignent un fichier d'un autre paquet de V0. */
function importsCroises(fichier: string, source: string): string[] {
  const interdits = new Map<string, string>();
  for (const [paquet, fichiers] of Object.entries(AUTRES_PAQUETS_V0)) {
    for (const f of fichiers) interdits.set(path.resolve(APP_DIR, f), `${paquet} : ${f}`);
  }
  const trouves: string[] = [];
  for (const spec of tousLesImports(source)) {
    if (!spec.startsWith(".")) continue;
    const cible = path.resolve(APP_DIR, path.dirname(fichier), spec);
    for (const candidat of [cible, `${cible}.ts`, `${cible}.tsx`, `${cible}.d.ts`]) {
      const paquet = interdits.get(candidat);
      if (paquet) trouves.push(`${fichier} → ${paquet}`);
    }
  }
  return trouves;
}

/** Sections [3d] : chaque « début » est fermé par un « fin » avant le suivant (D-3d-24). */
function sectionsEquilibrees(source: string): boolean {
  let ouverte = false;
  for (const m of source.matchAll(/\[3d\] (début|fin)\b/g)) {
    if (m[1] === "début") {
      if (ouverte) return false;
      ouverte = true;
    } else {
      if (!ouverte) return false;
      ouverte = false;
    }
  }
  return !ouverte;
}

describe("salle de contrôle 3D (T3d-a) : contrôles statiques", () => {
  it("les contrôles échouent sur des sources fabriqués", () => {
    assert.equal(importeThree("import { WebGLRenderer } from \"three\";"), true);
    assert.equal(importeThree("export async function f() {\n  return import(\"three\");\n}"), true);
    assert.equal(importeThree("import {\n  Mesh,\n} from \"three/src/Three.js\";"), true);
    assert.equal(importeThree("// import { Mesh } from \"three\";\nexport const a = 1;"), false);
    assert.equal(importeThree("import type { Moteur } from \"./three-types.ts\";"), false);
    assert.deepEqual(importsCroises("server/wiring-3d.ts", "import { TEXTES } from \"./shared/revoir-texts.ts\";"), [
      "server/wiring-3d.ts → T3d-b : server/shared/revoir-texts.ts",
    ]);
    assert.deepEqual(importsCroises("web/pages/salle-controle/Scene3d.tsx", "import type {\n  X,\n} from \"./fluidite\";"), [
      "web/pages/salle-controle/Scene3d.tsx → L30 : web/pages/salle-controle/fluidite.ts",
    ]);
    assert.deepEqual(importsCroises("server/wiring-3d.ts", "export type { LegendeKey } from \"./shared/legendes.ts\";"), [
      "server/wiring-3d.ts → L28a : server/shared/legendes.ts",
    ]);
    assert.deepEqual(importsCroises("server/wiring-3d.ts", "import { ID_RE } from \"./shared/ids.ts\";"), []);
    assert.equal(typesSeulement("export type A = 1;\nexport interface B {\n  a: A;\n}\n"), true);
    assert.equal(typesSeulement("export type A = 1;\nexport const B = 2;\n"), false);
    assert.equal(typesSeulement("import { A } from \"./a.ts\";\nexport type B = A;\n"), false);
    assert.equal(sectionsEquilibrees("// [3d] début : a\nx;\n// [3d] fin\n"), true);
    assert.equal(sectionsEquilibrees("// [3d] début : a\nx;\n"), false);
    assert.equal(sectionsEquilibrees("// [3d] début : a\n// [3d] début : b\n// [3d] fin\n// [3d] fin\n"), false);
  });

  it("salle3d-types.ts : types seulement, aucun code exécutable (pureté des *-types.ts)", () => {
    assert.equal(typesSeulement(lire("server/shared/salle3d-types.ts")), true);
  });

  it("aucun fichier de T3d-a n'importe « three » ; seul moteur-chargeur.ts atteint ./three/, par import dynamique (D-3d-05)", () => {
    for (const fichier of FICHIERS_T3D_A) assert.equal(importeThree(lire(fichier)), false, fichier);
    const versThree = FICHIERS_T3D_A.flatMap((fichier) =>
      tousLesImports(lire(fichier))
        .filter((spec) => spec.startsWith(".") && path.resolve(APP_DIR, path.dirname(fichier), spec).includes(`${path.sep}three${path.sep}`))
        .map((spec) => `${fichier} → ${spec}`),
    );
    assert.deepEqual(versThree, ["web/pages/salle-controle/moteur-chargeur.ts → ./three/moteur.ts"]);
    assert.deepEqual(importsOf(lire("web/pages/salle-controle/moteur-chargeur.ts")).dynamiques, ["./three/moteur.ts"]);
  });

  it("aucun fichier de T3d-a n'importe un fichier d'un autre paquet de la vague 0 (D-3d-27)", () => {
    // D-3d-27 ne vaut que pour la vague 0 : un squelette confié à un paquet d'une vague suivante (PROPRIETAIRES) lui appartient
    // et lit alors légitimement les textes de T3d-b ou les modules de L28a. Les fichiers propres à T3d-a restent contrôlés.
    const propres = FICHIERS_T3D_A.filter((fichier) => !Object.hasOwn(PROPRIETAIRES, fichier));
    assert.ok(propres.length > 5, "les fichiers propres à T3d-a restent contrôlés");
    assert.deepEqual(
      propres.flatMap((fichier) => importsCroises(fichier, lire(fichier))),
      [],
    );
  });

  it("squelettes : « Propriétaire : Lxx » en première ligne ; un squelette encore vide rend null", () => {
    for (const [fichier, proprietaire] of Object.entries(PROPRIETAIRES)) {
      const source = lire(fichier);
      assert.equal((source.split("\n")[0] ?? "").replace(/\r$/, ""), `// Propriétaire : ${proprietaire}.`, fichier);
      // Un squelette rempli par son paquet ne porte plus la mention « Squelette T3d-a » : seule la ligne « Propriétaire » reste.
      if (fichier.endsWith(".tsx") && source.includes("Squelette T3d-a")) assert.match(source, /\): null \{\n {2}return null;\n\}/, fichier);
    }
  });

  it("chargerMoteur() rend un module dont creerMoteur rend null (squelette, aucun three chargé)", async () => {
    const { creerMoteur } = await chargerMoteur();
    assert.equal(typeof creerMoteur, "function");
    const moteur = creerMoteur({} as HTMLCanvasElement, {
      theme: "sombre",
      mouvementReduit: true,
      onEchec: () => assert.fail("aucun contexte : aucun échec annoncé"),
    });
    assert.equal(moteur, null);
  });

  it("sections balisées [3d] : app-factory.ts (routes en dernier, dérivation) et App.tsx (page sans entrée de navigation)", () => {
    const factory = lire("server/app-factory.ts");
    assert.equal(sectionsEquilibrees(factory), true);
    assert.match(factory, /routes: \[\.\.\.\(deps\.routes \?\? \[\]\), \.\.\.built\.routes, \.\.\.routes3d\],/);
    assert.match(
      factory,
      /\/\/ \[3d\] début[^\n]*\n(?:[ \t]*\/\/[^\n]*\n)*\s*const routes3d = buildSalle3dRoutes\(built\.c11\);\n\s*for \(const derivation of buildSalle3dDerivations\(built\.c11\)\) detach\.push\(deps\.processor\.addDerivation\(derivation\)\);\n\s*\/\/ \[3d\] fin\n\s*const app = createApp\(\{/,
    );
    const app = lire("web/app/App.tsx");
    assert.equal(sectionsEquilibrees(app), true);
    assert.match(app, /import \{ SalleControlePage \} from "\.\.\/pages\/salle-controle\/SalleControlePage\.tsx";/);
    assert.match(app, /\) : section === "salle-controle" \? \(\n\s*<SalleControlePage \/>\n\s*\/\/ \[3d\] fin\n\s*\) : \(\n\s*<ChatPage \/>\n\s*\)\}/);
    assert.doesNotMatch(app, /id: "salle-controle"/, "aucune entrée de navigation (D-3d-15)");
  });
});

// --- Routes montées par app-factory (startCockpit sans module) ------------------------------------------------------------------

/** Requêtes reçues par le faux opencode depuis l'indice `depuis`. */
const requetesFaux = (h: CockpitHarness, depuis: number) => h.fake.requests.slice(depuis).map((r) => `${r.method} ${r.pathname}`);

describe("salle de contrôle 3D (T3d-a) : routes neutres", () => {
  it("GET seulement, lecture seule, aucune requête à opencode : territoires 200, « Revoir » 404 / 400 / ?etat=1, consignes 404 / 400", async (t) => {
    const h = await startCockpit(t);
    const auth = h.headers.authed;
    const get = async (chemin: string) => {
      const r = await h.call("GET", chemin, { headers: auth });
      return { status: r.status, body: r.json() };
    };
    const depuis = h.fake.requests.length;

    const territoires = await h.call("GET", "/api/salle-controle/territoires", { headers: auth });
    assert.equal(territoires.status, 200);
    const vue = territoires.json<TerritoiresResponse>();
    assert.equal(typeof vue.genereLe, "number");
    assert.deepEqual({ ...vue, genereLe: 0 }, { genereLe: 0, mode: "simple", projets: [], salle: null, statutVerifie: false });

    assert.deepEqual(await get(`/api/revoir/${ROOT}`), { status: 404, body: { error: "racine-inconnue", code: "racine-inconnue" } });
    assert.deepEqual(await get(`/api/revoir/${ROOT}?etat=1`), { status: 200, body: { rootId: ROOT, acces: false, raison: "racine-inconnue" } });
    for (const invalide of ["ses.point", "x".repeat(129)]) {
      assert.equal((await get(`/api/revoir/${invalide}`)).status, 400, invalide);
      assert.equal((await get(`/api/revoir/${invalide}?etat=1`)).status, 400, `${invalide} ?etat=1`);
    }

    // Règle d'accès de « Revoir » avant toute lecture de consigne (L28d) : racine inconnue du port revoir → 404, pour les deux
    // formes de la route. Le code est comparé, la phrase seulement présente : elle appartient à revoir-texts.ts (T3d-b).
    assert.deepEqual(refus(await get(`/api/revoir/${ROOT}/consignes/${CALL}`)), { status: 404, code: "racine-inconnue", phrase: true });
    assert.equal((await get(`/api/revoir/${ROOT}/consignes/call.point`)).status, 400, "callId invalide");
    assert.equal((await get(`/api/revoir/${ROOT}/consignes/${"c".repeat(129)}`)).status, 400, "callId trop long");
    assert.equal((await get(`/api/revoir/ses.point/consignes/${CALL}`)).status, 400, "rootId invalide");

    assert.deepEqual(refus(await get(`/api/revoir/${ROOT}/consignes?enfant=${ENFANT}`)), { status: 404, code: "racine-inconnue", phrase: true });
    assert.equal((await get(`/api/revoir/${ROOT}/consignes?enfant=ses.point`)).status, 400, "enfant invalide");
    assert.equal((await get(`/api/revoir/${ROOT}/consignes`)).status, 400, "enfant absent");
    assert.equal((await get(`/api/revoir/ses.point/consignes?enfant=${ENFANT}`)).status, 400, "rootId invalide");

    for (const methode of ["POST", "PUT", "PATCH", "DELETE"]) {
      for (const chemin of [
        "/api/salle-controle/territoires",
        `/api/revoir/${ROOT}`,
        `/api/revoir/${ROOT}?etat=1`,
        `/api/revoir/${ROOT}/consignes/${CALL}`,
        `/api/revoir/${ROOT}/consignes?enfant=${ENFANT}`,
      ]) {
        const r = await h.call(methode, chemin, { headers: h.headers.mutating, ...(methode === "DELETE" ? {} : { body: {} }) });
        assert.ok(r.status === 404 || r.status === 405, `${methode} ${chemin} : ${r.status}`);
      }
    }

    assert.deepEqual(requetesFaux(h, depuis), [], "aucune requête à opencode pendant ces appels");
    // Témoin : une requête du cockpit à opencode est bien vue par le faux (le contrôle ci-dessus n'est pas vide).
    await h.cockpit.c11.client.request("GET", "/session/status");
    assert.deepEqual(requetesFaux(h, depuis), ["GET /session/status"]);
    h.assertNoGlobalRestart();
  });

  it("authentification exigée (garde de http.ts, avant ces routes) ; mode relu à chaque requête", async (t) => {
    const h = await startCockpit(t);
    for (const chemin of ["/api/salle-controle/territoires", `/api/revoir/${ROOT}`, `/api/revoir/${ROOT}/consignes/${CALL}`]) {
      assert.equal((await h.call("GET", chemin)).status, 401, chemin);
    }
    const mode = async () => (await h.call("GET", "/api/salle-controle/territoires", { headers: h.headers.authed })).json<TerritoiresResponse>().mode;
    assert.equal(await mode(), "simple");
    h.settings.update({ ui: { mode: "avance" } });
    assert.equal(await mode(), "avance");
  });

  it("hors du registre 1.1 : aucune route ni dérivation inscrite dans wiring-11, avec ou sans modules", async (t) => {
    const sans = await startCockpit(t);
    assert.equal(sans.cockpit.wiring.routes.length, 0);
    assert.equal(sans.cockpit.wiring.derivations.length, 0);
    assert.equal((await sans.call("GET", "/api/salle-controle/territoires", { headers: sans.headers.authed })).status, 200);
    const tous = await startCockpit(t, { modules: "tous" });
    assert.ok(tous.cockpit.wiring.derivations.length > 0);
    assert.equal(tous.cockpit.wiring.derivations.some((d) => d.name === "consignes-3d"), false);
    assert.equal(tous.cockpit.wiring.registrations.some((r) => r.key === "consignes-3d" || /salle|revoir|3d/.test(r.key)), false);
    // Routes 3d montées après toutes les routes 1.1 : elles répondent aussi avec tous les modules.
    assert.equal((await tous.call("GET", `/api/revoir/${ROOT}`, { headers: tous.headers.authed })).status, 404);
    assert.equal((await tous.call("GET", `/api/revoir/${ROOT}/consignes?enfant=${ENFANT}`, { headers: tous.headers.authed })).status, 404);
  });
});

// --- Dérivation des consignes ------------------------------------------------------------------------------------------------------

describe("salle de contrôle 3D (T3d-a) : dérivation des consignes (U2, D-3d-30)", () => {
  it("inscrite une fois sur le processeur (consignes-3d), neutre (aucune écriture), retirée par close()", async (t) => {
    const inscrites: Array<{ derivation: EventDerivation; retiree: boolean }> = [];
    const addDerivation = EventProcessor.prototype.addDerivation;
    t.mock.method(EventProcessor.prototype, "addDerivation", function (this: EventProcessor, derivation: EventDerivation) {
      const retirer = addDerivation.call(this, derivation);
      const entree = { derivation, retiree: false };
      inscrites.push(entree);
      return () => {
        entree.retiree = true;
        retirer();
      };
    });
    const h = await startCockpit(t);
    const consignes = inscrites.filter((e) => e.derivation.name === "consignes-3d");
    assert.equal(consignes.length, 1, "une seule inscription nommée consignes-3d");
    const entree = consignes[0]!;
    assert.equal(entree.retiree, false);

    // Rejeu d'une partie `task` à l'état `running` (texte synthétique) : la dérivation la reçoit et n'écrit rien en base.
    const changements = () => (h.db.prepare("SELECT total_changes() AS n").get() as { n: number }).n;
    const recus: Array<{ type: string; ecritures: number }> = [];
    const onEvent = entree.derivation.onEvent.bind(entree.derivation);
    entree.derivation.onEvent = (event) => {
      const avant = changements();
      onEvent(event);
      recus.push({ type: event.payload.type, ecritures: changements() - avant });
    };
    const task = (callID: string) =>
      h.fake.emit({
        type: "message.part.updated",
        properties: {
          sessionID: ROOT,
          part: {
            id: `prt_${callID}`,
            messageID: "msg_3d1",
            sessionID: ROOT,
            type: "tool",
            tool: "task",
            callID,
            state: {
              status: "running",
              title: "[synthétique]",
              input: { description: "[synthétique]", prompt: "[synthétique] consigne de test" },
              metadata: { parentSessionId: ROOT, sessionId: ENFANT },
            },
          },
          time: 1,
        },
      });
    task(CALL);
    await until(() => recus.some((r) => r.type === "message.part.updated"), 5_000);
    assert.deepEqual(recus.filter((r) => r.type === "message.part.updated").map((r) => r.ecritures), [0]);

    // close() retire la dérivation : un événement suivant ne lui parvient plus (témoin inscrit après elle).
    h.cockpit.close();
    assert.equal(entree.retiree, true);
    const temoin: string[] = [];
    h.processor.addDerivation({ name: "temoin", onEvent: (event) => void temoin.push(event.payload.type) });
    const recusAvant = recus.length;
    task("call_3d2");
    await until(() => temoin.includes("message.part.updated"), 5_000);
    assert.equal(recus.length, recusAvant, "dérivation retirée par close()");
  });
});

// --- Câblage : surcharges de ports, horloge, mode ----------------------------------------------------------------------------------

describe("salle de contrôle 3D (T3d-a) : buildSalle3dRoutes", () => {
  it("surcharges appliquées après les ports réels (undefined ignorée), horloge injectée, mode passé aux ports à chaque requête", async (t: TestContext) => {
    const h = await startCockpit(t);
    const consigne: RevoirConsigneResponse = { rootId: ROOT, callId: CALL, enfant: ENFANT, texte: "[synthétique]", longueur: 13, tronque: false, at: 5 };
    const modes: NeonMode[] = [];
    const routes = buildSalle3dRoutes(h.cockpit.c11, {
      now: () => 1_234,
      ports: {
        territoires: undefined,
        revoir: {
          lire: (rootId, mode) => {
            modes.push(mode);
            return rootId === ROOT
              ? { ok: true, value: { rootId, titre: "[synthétique]", instance: "principale", termine: true, facts: [], partial: false } }
              : { ok: false, status: 403, code: "salle-demande-en-cours" };
          },
          etat: (rootId, mode) => {
            modes.push(mode);
            return { rootId, acces: true, raison: null };
          },
        },
        consignes: { lire: (_rootId, callId) => (callId === CALL ? consigne : null), parEnfant: () => [consigne] },
      },
    });
    assert.equal(routes.length, 3);
    const app = new Hono();
    for (const install of routes) install(app);
    const get = async (chemin: string) => {
      const r = await app.request(chemin);
      return { status: r.status, body: (await r.json()) as unknown };
    };

    const territoires = await get("/api/salle-controle/territoires");
    assert.equal(territoires.status, 200);
    assert.equal((territoires.body as TerritoiresResponse).genereLe, 1_234);
    assert.equal((territoires.body as TerritoiresResponse).mode, "simple");
    assert.deepEqual(await get(`/api/revoir/${ROOT}`), {
      status: 200,
      body: { rootId: ROOT, titre: "[synthétique]", instance: "principale", termine: true, facts: [], partial: false },
    });
    assert.deepEqual(await get("/api/revoir/ses_salle"), { status: 403, body: { error: "salle-demande-en-cours", code: "salle-demande-en-cours" } });
    h.settings.update({ ui: { mode: "avance" } });
    assert.deepEqual(await get(`/api/revoir/${ROOT}?etat=1`), { status: 200, body: { rootId: ROOT, acces: true, raison: null } });
    assert.equal(((await get("/api/salle-controle/territoires")).body as TerritoiresResponse).mode, "avance");
    assert.deepEqual(modes, ["simple", "simple", "avance"]);
    assert.deepEqual(await get(`/api/revoir/${ROOT}/consignes/${CALL}`), { status: 200, body: consigne });
    assert.deepEqual(refus(await get(`/api/revoir/${ROOT}/consignes/call_autre`)), { status: 404, code: "consigne-absente", phrase: true });
    assert.deepEqual(await get(`/api/revoir/${ROOT}/consignes?enfant=${ENFANT}`), { status: 200, body: { rootId: ROOT, enfant: ENFANT, consignes: [consigne] } });
  });
});

// --- Client web mince ------------------------------------------------------------------------------------------------------------

interface Appel {
  method: string;
  url: string;
  headers: Record<string, string>;
}

/** Remplace fetch (recopié de web-api-11.test.ts) : chaque appel est noté et reçoit `reponse`. */
function espionFetch(t: TestContext, reponse: { status: number; body?: unknown }): Appel[] {
  const appels: Appel[] = [];
  t.mock.method(globalThis, "fetch", async (input: string | URL | Request, init?: RequestInit) => {
    const headers = Object.fromEntries(Object.entries((init?.headers ?? {}) as Record<string, string>).map(([k, v]) => [k.toLowerCase(), v]));
    appels.push({ method: init?.method ?? "GET", url: String(input), headers });
    return new Response(reponse.body === undefined ? null : JSON.stringify(reponse.body), { status: reponse.status });
  });
  return appels;
}

describe("salle de contrôle 3D (T3d-a) : client web api-salle3d", () => {
  it("adresses, méthode GET, en-têtes de api.ts (aucun CSRF), identifiants encodés", async (t) => {
    const appels = espionFetch(t, { status: 200, body: {} });
    await salle3dApi.territoires();
    await salle3dApi.revoir("ses/1");
    await salle3dApi.revoirEtat(ROOT);
    await salle3dApi.revoirConsigne(ROOT, "call 1");
    await salle3dApi.revoirConsignesEnfant(ROOT, ENFANT);
    assert.deepEqual(
      appels.map((a) => [a.method, a.url]),
      [
        ["GET", "/api/salle-controle/territoires"],
        ["GET", "/api/revoir/ses%2F1"],
        ["GET", `/api/revoir/${ROOT}?etat=1`],
        ["GET", `/api/revoir/${ROOT}/consignes/call%201`],
        ["GET", `/api/revoir/${ROOT}/consignes?enfant=${ENFANT}`],
      ],
    );
    for (const appel of appels) {
      assert.equal(appel.headers.accept, "application/json");
      assert.equal(appel.headers["x-cockpit-csrf"], undefined);
    }
  });

  it("refus : ApiError portant le code (« consigne-absente », RevoirRefus)", async (t) => {
    espionFetch(t, { status: 404, body: { error: "consigne-absente", code: "consigne-absente" } });
    await assert.rejects(salle3dApi.revoirConsigne(ROOT, CALL), (err: unknown) => err instanceof ApiError && err.status === 404 && err.code === "consigne-absente");
  });
});
