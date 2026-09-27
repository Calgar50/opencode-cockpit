// Tests de croisement du train NAV V5 (fiche NAV §6 ; exécution anticipée A30 sur chantier/1.1-nav, départ H2″ 913cb81 ;
// propriété de l'intégrateur). Ce que la vague doit prouver, et qu'aucun paquet ne peut prouver seul : l'onglet « Fichiers »
// (NAV-2 : lecteur et routes ; NAV-3 : interface) tient sur le câblage de PRODUCTION, tous les modules 1.1 installés.
//   1. câblage de production : « fichiers » dans MODULE_ORDER et STEP_ORDER.routes, routes montées une seule fois, POST seulement ;
//   2. aucun appel facturé ni vers opencode pendant les 4 routes (aucune requête /file*, /find* ni POST reçue par le faux, aucune
//      ligne usage) ;
//   3. proxy inchangé : aucune règle de PROXY_RULES (http.ts) ne sert /file* ; GET /api/oc/file/content → 404 ;
//   4. sécurité HTTP existante (anti-CSRF, Origin, session, hôte) sur les 4 routes ;
//   5. P2 : mêmes réponses en mode Simple et en mode Avancé, fichier ordinaire comme protégé ;
//   6. montages (docker-compose.yml) : un seul /projets-lecture, de source ${WORKSPACE_DIR}, en :ro, dans le seul service cockpit ;
//      /workspace du cockpit en écriture ; rien pour opencode (P11) ; aucun montage sous /projets-lecture ;
//   7. constantes et dépendances : ACTIVATION_OUVERTE inchangée, SALLE_OUVERTE absente ou fausse, dépendances de app/package.json
//      identiques à H2″ (P8) ; les suites textes, pureté, web-animations et fichiers-balises tournent dans npm test ;
//   plus D14 (b) : un dossier %XX est lisible par l'onglet sans aucune requête à opencode, mais jamais proposé pour une conversation
//   (absent de /api/projects, 403 forbidden-directory au proxy, projects.ts intact).
// Au rang de FUSION (après GF5) : harnais avec equipes et omo, PROXY_RULES_OMO, omo-compose.test.ts, construction-balises.test.ts,
// SALLE_OUVERTE fausse et dépendances de la tête de GF5 (plan NAV, « à faire au rang de fusion », points 2 et 3). Aucun appel facturé :
// faux opencode seulement.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, it, type TestContext } from "node:test";
import { parse as parseYaml } from "yaml";
import { PROXY_RULES } from "./http.ts";
import { CSRF_HEADER } from "./security.ts";
import { FICHIERS_ROUTES } from "./shared/fichiers-regles.ts";
import { type CockpitHarness, type CockpitHarnessOptions, startCockpit } from "./test-support/cockpit-harness.ts";
import * as wiring11 from "./wiring-11.ts";
import { ACTIVATION_OUVERTE, MODULE_ORDER, STEP_ORDER } from "./wiring-11.ts";

type Route = keyof typeof FICHIERS_ROUTES;
const ROUTES = Object.keys(FICHIERS_ROUTES) as Route[];
const CORPS: Record<Route, Record<string, string>> = {
  dossier: { projet: "proj", chemin: "" },
  contenu: { projet: "proj", chemin: "scripts/a.ps1" },
  recents: { projet: "proj" },
  recherche: { projet: "proj", texte: "a" },
};
/** Nom qu'opencode décoderait deux fois (A22) : lisible par l'onglet, jamais proposé pour une conversation (D14 (b)). */
const DOSSIER_XX = "a%2F..%2F..%2Fdonnees";

const REPO_DIR = path.join(import.meta.dirname, "..", "..");

function ecrire(racine: string, relatif: string, contenu: string): void {
  const chemin = path.join(racine, ...relatif.split("/"));
  fs.mkdirSync(path.dirname(chemin), { recursive: true });
  fs.writeFileSync(chemin, contenu);
}

/** Harnais de PRODUCTION (modules: « tous » = MODULE_ORDER entier, comme main.ts) et projet de démonstration. */
async function demarrer(t: TestContext, options: CockpitHarnessOptions = {}): Promise<CockpitHarness & { travail: string }> {
  const h = await startCockpit(t, { modules: "tous", ...options });
  const travail = h.deps.env.workspaceDir;
  ecrire(travail, "proj/scripts/a.ps1", "Write-Output 'bonjour'\n");
  ecrire(travail, "proj/.env", "SECRET=valeur-factice\n");
  return Object.assign(h, { travail });
}

const post = (h: CockpitHarness, route: Route, body: unknown, headers = h.headers.mutating) => h.call("POST", FICHIERS_ROUTES[route], { headers, body });
const lignesUsage = (h: CockpitHarness) => (h.db.prepare("SELECT COUNT(*) AS n FROM usage").get() as { n: number }).n;
/** Routes montées sous /api/fichiers (méthode et adresse, une entrée par gestionnaire). */
const routesMontees = (h: CockpitHarness) => h.cockpit.app.routes.filter((r) => r.path.startsWith("/api/fichiers")).map((r) => `${r.method} ${r.path}`);

describe("croisements NAV V5 : onglet « Fichiers » sur le câblage de production", () => {
  it("1. « fichiers » dans MODULE_ORDER et STEP_ORDER.routes ; 4 routes POST montées une seule fois ; GET → 404", async (t) => {
    assert.equal(MODULE_ORDER.filter((m) => m === "fichiers").length, 1);
    const couples: ReadonlyArray<readonly string[]> = STEP_ORDER.routes;
    assert.deepEqual(
      couples.filter((couple) => couple.includes("fichiers")),
      [["fichiers", "fichiers"]],
    );
    const h = await demarrer(t);
    assert.ok(h.cockpit.wiring.modules.includes("fichiers"));
    assert.deepEqual(
      h.cockpit.wiring.registrations.filter((r) => r.module === "fichiers"),
      [{ kind: "routes", key: "fichiers", module: "fichiers" }],
    );
    const racine = await post(h, "dossier", { projet: "", chemin: "" });
    assert.equal(racine.status, 200, racine.body);
    assert.deepEqual(racine.json<{ entrees: Array<{ nom: string }> }>().entrees.map((e) => e.nom), ["proj"]);
    // Aucune route en double : autant de gestionnaires qu'avec le seul module « fichiers », aucun sans lui, POST seulement.
    const seul = await startCockpit(t, { modules: ["fichiers"] });
    const aucun = await startCockpit(t, { modules: [] });
    const tous = routesMontees(h);
    assert.deepEqual(tous, routesMontees(seul));
    assert.deepEqual(routesMontees(aucun), []);
    assert.deepEqual([...new Set(tous)].sort(), ROUTES.map((r) => `POST ${FICHIERS_ROUTES[r]}`).sort());
    // Deux gestionnaires par route (bodyLimit, puis la route) : une route inscrite deux fois en aurait quatre.
    assert.equal(tous.length, 2 * ROUTES.length);
    assert.equal((await post(aucun, "dossier", { projet: "", chemin: "" })).status, 404, "sans le module : 404 de /api/*");
    for (const route of ROUTES) {
      const get = await h.call("GET", FICHIERS_ROUTES[route], { headers: h.headers.authed });
      assert.equal(get.status, 404, route);
      assert.equal(get.json<{ error: string }>().error, "not-found");
    }
  });

  it("2. aucune requête /file*, /find* ni POST reçue par le faux opencode, aucune ligne usage, pendant les 4 routes", async (t) => {
    const h = await demarrer(t);
    const avant = h.fake.requests.length;
    const lignes = lignesUsage(h);
    for (const route of ROUTES) assert.equal((await post(h, route, CORPS[route])).status, 200, route);
    assert.equal((await post(h, "contenu", { projet: "proj", chemin: ".env" })).status, 403);
    const recues = h.fake.requests.slice(avant);
    assert.deepEqual(recues.filter((r) => /^\/(file|find)/.test(r.pathname)).map((r) => r.pathname), []);
    assert.deepEqual(recues.filter((r) => r.method === "POST").map((r) => r.pathname), []);
    assert.equal(lignesUsage(h), lignes);
    h.assertNoGlobalRestart();
  });

  it("3. proxy inchangé : aucune règle de PROXY_RULES ne sert /file* ; GET /api/oc/file/content → 404 sans requête", async (t) => {
    assert.equal(PROXY_RULES.some((r) => r.pattern.source.startsWith("^/file")), false);
    for (const sub of ["/file", "/file/content", "/file/status", "/file/list"]) {
      assert.equal(PROXY_RULES.some((r) => r.pattern.test(sub)), false, sub);
    }
    const h = await demarrer(t);
    const avant = h.fake.requests.length;
    const res = await h.call("GET", `/api/oc/file/content?path=${encodeURIComponent("proj/.env")}`, { headers: h.headers.authed });
    assert.equal(res.status, 404, res.body);
    assert.equal(h.fake.requests.slice(avant).some((r) => r.pathname.startsWith("/file")), false);
  });

  it("4. sécurité HTTP : sans anti-CSRF 403, Origin étrangère 403, sans cookie 401, hôte refusé 421", async (t) => {
    const h = await demarrer(t);
    for (const route of ROUTES) {
      const sansCsrf = await post(h, route, CORPS[route], h.headers.authed);
      assert.deepEqual([sansCsrf.status, sansCsrf.json<{ error: string }>().error], [403, "csrf"], route);
      const origine = await post(h, route, CORPS[route], { ...h.headers.mutating, origin: "http://evil.example" });
      assert.deepEqual([origine.status, origine.json<{ error: string }>().error], [403, "csrf"], route);
      const sansCookie = await post(h, route, CORPS[route], { [CSRF_HEADER]: "1" });
      assert.deepEqual([sansCookie.status, sansCookie.json<{ error: string }>().error], [401, "unauthorized"], route);
      assert.equal((await post(h, route, CORPS[route], { ...h.headers.mutating, host: "evil.example" })).status, 421, route);
    }
  });

  it("5. P2 : mode Simple puis Avancé, réponses identiques pour un fichier ordinaire comme pour un fichier protégé", async (t) => {
    const h = await demarrer(t);
    const demandes: Array<[Route, Record<string, string>]> = [
      ...ROUTES.map((route): [Route, Record<string, string>] => [route, CORPS[route]]),
      ["contenu", { projet: "proj", chemin: ".env" }],
      ["dossier", { projet: "proj", chemin: ".git" }],
    ];
    // Une demande à la fois : deux parcours simultanés répondraient « occupe ».
    const lire = async () => {
      const reponses: Array<[number, string]> = [];
      for (const [route, corps] of demandes) {
        const res = await post(h, route, corps);
        reponses.push([res.status, res.body]);
      }
      return reponses;
    };
    assert.equal(h.settings.get().ui.mode, "simple");
    const simple = await lire();
    assert.deepEqual(simple.map(([statut]) => statut), [200, 200, 200, 200, 403, 403]);
    h.settings.update({ ui: { mode: "avance" } });
    assert.deepEqual(await lire(), simple);
  });

  it("D14 (b) : dossier %XX lisible par l'onglet sans requête à opencode ; jamais proposé pour une conversation (projects.ts intact)", async (t) => {
    const h = await demarrer(t);
    ecrire(h.travail, `${DOSSIER_XX}/note.txt`, "note ordinaire\n");
    const avant = h.fake.requests.length;
    const lignes = lignesUsage(h);
    const racine = await post(h, "dossier", { projet: "", chemin: "" });
    assert.equal(racine.status, 200, racine.body);
    assert.equal(racine.json<{ entrees: Array<{ nom: string; type: string }> }>().entrees.find((e) => e.nom === DOSSIER_XX)?.type, "dossier");
    const contenu = await post(h, "contenu", { projet: DOSSIER_XX, chemin: "note.txt" });
    assert.equal(contenu.status, 200, contenu.body);
    assert.equal(contenu.json<{ texte: string }>().texte, "note ordinaire");
    assert.equal(h.fake.requests.length, avant, "aucune requête à opencode");
    assert.equal(lignesUsage(h), lignes);
    // Côté conversation : absent de la liste des projets, refusé par le proxy avant toute requête (403 forbidden-directory).
    const projets = await h.call("GET", "/api/projects", { headers: h.headers.authed });
    assert.equal(projets.status, 200, projets.body);
    assert.deepEqual(projets.json<Array<{ name: string }>>().map((p) => p.name).filter((n) => n.includes("%")), []);
    const directory = `${h.deps.projects.opencodeRoot.replace(/[\\/]+$/, "")}/${DOSSIER_XX}`;
    const session = await h.call("POST", `/api/oc/session?directory=${encodeURIComponent(directory)}`, { headers: h.headers.mutating, body: {} });
    assert.equal(session.status, 403, session.body);
    assert.equal(session.json<{ error: string }>().error, "forbidden-directory");
    assert.equal(h.fake.requests.length, avant, "aucune requête à opencode");
  });
});

describe("croisements NAV V5 : montages, constantes et dépendances", () => {
  interface Service {
    volumes?: string[];
    environment?: Record<string, string>;
  }
  const texte = fs.readFileSync(path.join(REPO_DIR, "docker-compose.yml"), "utf8");
  const compose = parseYaml(texte, { merge: true }) as { services: Record<string, Service> };
  const cible = (volume: string) => volume.split(":")[1] ?? "";

  it("6. un seul montage /projets-lecture (${WORKSPACE_DIR}, :ro, service cockpit) ; /workspace en écriture ; rien pour opencode (P11)", () => {
    const montages = Object.entries(compose.services).flatMap(([service, s]) =>
      (s.volumes ?? []).filter((v) => cible(v) === "/projets-lecture" || cible(v).startsWith("/projets-lecture/")).map((v) => [service, v]),
    );
    assert.deepEqual(montages, [["cockpit", "${WORKSPACE_DIR}:/projets-lecture:ro"]]);
    const cockpit = compose.services.cockpit?.volumes ?? [];
    assert.deepEqual(cockpit.filter((v) => cible(v) === "/workspace"), ["${WORKSPACE_DIR}:/workspace"], "/workspace du cockpit en écriture");
    for (const [service, s] of Object.entries(compose.services)) {
      if (service === "cockpit") continue;
      assert.equal((s.volumes ?? []).some((v) => v.includes("projets-lecture")), false, service);
      assert.equal(Object.keys(s.environment ?? {}).some((cle) => cle.startsWith("COCKPIT_FICHIERS")), false, service);
    }
    assert.ok(compose.services.opencode, "service opencode présent");
    // Le test « salle coupée » (wiring-11.test.ts) lit le texte du fichier : les sections nav: ne citent pas la salle.
    // Motif écrit en morceaux : fichiers-balises.test.ts lirait sinon une balise sans nom dans ce fichier.
    const section = new RegExp(["# <", "nav:([a-z-]+)>([\\s\\S]*?)# </", "nav:\\1>"].join(""), "g");
    const sections = [...texte.matchAll(section)];
    assert.deepEqual(sections.map((s) => s[1]), ["variables", "montage"]);
    for (const s of sections) assert.equal(/omo/i.test(s[2] ?? ""), false, s[1]);
  });

  it("7. ACTIVATION_OUVERTE inchangée, SALLE_OUVERTE absente ou fausse, dépendances de app/package.json identiques à H2″ (P8)", () => {
    assert.equal(ACTIVATION_OUVERTE, true);
    const exporte = wiring11 as Record<string, unknown>;
    assert.ok(!("SALLE_OUVERTE" in exporte) || exporte.SALLE_OUVERTE === false, "salle fermée");
    // H2″ (913cb81). Au rang de fusion : dépendances de la tête de GF5 (three y arrive avec la 3D).
    const pkg = JSON.parse(fs.readFileSync(path.join(REPO_DIR, "app", "package.json"), "utf8")) as {
      dependencies: Record<string, string>;
      devDependencies: Record<string, string>;
    };
    assert.deepEqual(pkg.dependencies, { "@hono/node-server": "2.1.1", hono: "4.13.7", "jsonc-parser": "3.3.1", yaml: "2.9.1", zod: "4.6.4" });
    assert.deepEqual(pkg.devDependencies, {
      "@codemirror/lang-json": "6.0.2",
      "@codemirror/lang-markdown": "6.5.2",
      "@codemirror/state": "6.7.4",
      "@codemirror/theme-one-dark": "6.1.3",
      "@codemirror/view": "6.43.11",
      "@types/node": "24.12.2",
      "@types/react": "19.3.0",
      "@types/react-dom": "19.3.0",
      "@vitejs/plugin-react": "6.1.1",
      codemirror: "6.0.2",
      dompurify: "3.4.15",
      "highlight.js": "11.12.0",
      marked: "18.0.13",
      react: "19.3.0",
      "react-dom": "19.3.0",
      typescript: "7.0.2",
      vite: "8.3.0",
    });
  });
});
