// Tests des routes de l'onglet « Fichiers » (1.1, NAV-2 ; fiche NAV §2.1, §2.3, §4 ; décisions A21, A29 D14 ; fiche-fusion-v106
// §8) : harnais du cockpit avec le seul module « fichiers », dossier de travail temporaire du harnais. Sécurité HTTP existante
// (hôte, session, anti-CSRF, en-têtes de l'API), ordre des refus, phrases françaises, mêmes réponses dans les deux modes (P2),
// aucune requête vers opencode ni ligne facturée ; interrupteur COCKPIT_FICHIERS et liste d'autorisation de COCKPIT_FICHIERS_DIR
// (env.ts) ; second montage en lecture seule de docker-compose.yml, jamais donné à opencode (P11).
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { describe, it, type TestContext } from "node:test";
import { createAdaptorServer } from "@hono/node-server";
import { Hono } from "hono";
import { parse as parseYaml } from "yaml";
import type { Cockpit11, Registrar } from "./contracts-11.ts";
import { EnvError, FICHIERS_DIR_MONTAGE, loadEnv, parseFichiers, parseFichiersDir } from "./env.ts";
import { fichiersModule, registerFichiersRoutes, STATUTS_FICHIERS } from "./routes-fichiers.ts";
import { API_CONTENT_SECURITY_POLICY, CSRF_HEADER } from "./security.ts";
import { FICHIERS_ROUTES, NAV_BORNES } from "./shared/fichiers-regles.ts";
import { phraseErreur, TEXTES } from "./shared/fichiers-texts.ts";
import type { FichiersCode } from "./shared/fichiers-types.ts";
import { type CallResult, type CockpitHarness, type CockpitHarnessOptions, startCockpit } from "./test-support/cockpit-harness.ts";
import { creerLecteurFichiers, type DemandeProjet, type LecteurFichiers } from "./workspace-files.ts";

type Route = keyof typeof FICHIERS_ROUTES;

/** Corps valide de chaque route, sur le projet de démonstration. */
const CORPS: Record<Route, Record<string, string>> = {
  dossier: { projet: "proj", chemin: "" },
  contenu: { projet: "proj", chemin: "scripts/a.ps1" },
  recents: { projet: "proj" },
  recherche: { projet: "proj", texte: "a" },
};
const ROUTES = Object.keys(FICHIERS_ROUTES) as Route[];

function ecrire(racine: string, relatif: string, contenu: string): void {
  const chemin = path.join(racine, ...relatif.split("/"));
  fs.mkdirSync(path.dirname(chemin), { recursive: true });
  fs.writeFileSync(chemin, contenu);
}

async function demarrer(t: TestContext, options: CockpitHarnessOptions = {}): Promise<CockpitHarness & { travail: string }> {
  const h = await startCockpit(t, { modules: ["fichiers"], ...options });
  const travail = h.deps.env.workspaceDir;
  ecrire(travail, "proj/scripts/a.ps1", "Write-Output 'bonjour'\n");
  ecrire(travail, "proj/README.md", "# Projet\n");
  return Object.assign(h, { travail });
}

const post = (h: CockpitHarness, route: Route, body: unknown, headers = h.headers.mutating) => h.call("POST", FICHIERS_ROUTES[route], { headers, body });

/** Réponse d'erreur des routes : statut du §2.3 et phrase « partout » de fichiers-texts.ts. */
function assertRefus(res: CallResult, code: FichiersCode, route: Route): void {
  assert.equal(res.status, STATUTS_FICHIERS[code], `${route} : ${res.body}`);
  assert.deepEqual(res.json(), { error: code, message: phraseErreur(code, route) });
}

const MOTS_ANGLAIS = /Expected|Invalid|Unrecognized|Unexpected|JSON at position|Required/;

describe("routes « fichiers » : réponses et sécurité HTTP", () => {
  it("les 4 routes → 200 en JSON, Cache-Control no-store, CSP de l'API ; aucune ne contient la racine absolue", async (t) => {
    const h = await demarrer(t);
    for (const route of ROUTES) {
      const res = await post(h, route, CORPS[route]);
      assert.equal(res.status, 200, `${route} : ${res.body}`);
      assert.match(String(res.headers["content-type"]), /^application\/json/);
      assert.equal(res.headers["cache-control"], "no-store");
      assert.equal(res.headers["content-security-policy"], API_CONTENT_SECURITY_POLICY);
      for (const forme of [h.travail, JSON.stringify(h.travail).slice(1, -1), h.travail.replaceAll("\\", "/")]) assert.equal(res.body.includes(forme), false, route);
    }
    const contenu = (await post(h, "contenu", CORPS.contenu)).json<{ texte: string; encodage: string }>();
    assert.deepEqual([contenu.texte, contenu.encodage], ["Write-Output 'bonjour'", "utf-8"]);
    const dossier = (await post(h, "dossier", CORPS.dossier)).json<{ entrees: Array<{ nom: string }> }>();
    assert.deepEqual(dossier.entrees.map((e) => e.nom), ["scripts", "README.md"]);
  });

  it("GET sur chacune → 404 not-found de /api/* (aucune route GET)", async (t) => {
    const h = await demarrer(t);
    for (const route of ROUTES) {
      const res = await h.call("GET", FICHIERS_ROUTES[route], { headers: h.headers.authed });
      assert.equal(res.status, 404, route);
      assert.equal(res.json<{ error: string }>().error, "not-found");
    }
  });

  it("sans en-tête anti-CSRF → 403 csrf ; Origin étrangère → 403 ; sans cookie → 401 ; hôte non autorisé → 421", async (t) => {
    const h = await demarrer(t);
    for (const route of ROUTES) {
      const sansCsrf = await post(h, route, CORPS[route], h.headers.authed);
      assert.equal(sansCsrf.status, 403, route);
      assert.equal(sansCsrf.json<{ error: string }>().error, "csrf");
      const etrangere = await post(h, route, CORPS[route], { ...h.headers.mutating, origin: "http://evil.example" });
      assert.equal(etrangere.status, 403, route);
      assert.equal(etrangere.json<{ error: string }>().error, "csrf");
      const sansCookie = await post(h, route, CORPS[route], { [CSRF_HEADER]: "1" });
      assert.equal(sansCookie.status, 401, route);
      assert.equal(sansCookie.json<{ error: string }>().error, "unauthorized");
      const hote = await post(h, route, CORPS[route], { ...h.headers.mutating, host: "evil.example" });
      assert.equal(hote.status, 421, route);
    }
  });

  it("corps de 9 Kio → 413 trop-long (phrase française), avant l'interrupteur", async (t) => {
    const h = await demarrer(t);
    const long = JSON.stringify({ projet: "proj", chemin: "a".repeat(9 * 1_024) });
    assert.ok(Buffer.byteLength(long) > NAV_BORNES.CORPS_MAX_OCTETS);
    for (const route of ROUTES) {
      assertRefus(await post(h, route, long, { ...h.headers.mutating, "content-type": "application/json" }), "trop-long", route);
    }
    const coupe = await demarrer(t, { env: { fichiers: false } });
    assertRefus(await post(coupe, "contenu", long, { ...coupe.headers.mutating, "content-type": "application/json" }), "trop-long", "contenu");
  });

  it("JSON invalide, champ en trop (sessionId), types faux, chemin avec .., \\, : ou NUL → 400 invalide, message français", async (t) => {
    const h = await demarrer(t);
    const cas: Array<[Route, unknown]> = [
      ["dossier", "{"],
      ["dossier", ""],
      ["dossier", { projet: "proj", chemin: "", sessionId: "ses_1" }],
      ["contenu", { projet: "proj", chemin: "scripts/a.ps1", rootId: "ses_1" }],
      ["recents", { projet: "proj", chemin: "" }],
      ["dossier", { projet: 1, chemin: "" }],
      ["dossier", { projet: "proj" }],
      ["contenu", { projet: "proj", chemin: ["scripts", "a.ps1"] }],
      ["recherche", { projet: "proj", texte: "" }],
      ["recherche", { projet: "proj", texte: "x".repeat(NAV_BORNES.RECHERCHE_MAX_CARACTERES + 1) }],
      ["contenu", { projet: "proj", chemin: "../proj/scripts/a.ps1" }],
      ["contenu", { projet: "proj", chemin: "scripts/../README.md" }],
      ["contenu", { projet: "proj", chemin: "scripts\\a.ps1" }],
      ["contenu", { projet: "proj", chemin: "scripts/a.ps1:flux" }],
      ["contenu", { projet: "proj", chemin: "scripts/a\u0000.ps1" }],
      ["contenu", { projet: "proj", chemin: "/etc/passwd" }],
      ["contenu", { projet: "proj", chemin: "" }],
      ["dossier", { projet: "..", chemin: "" }],
      ["dossier", { projet: "proj/scripts", chemin: "" }],
      ["dossier", { projet: "x".repeat(NAV_BORNES.SEGMENT_MAX_CARACTERES + 1), chemin: "" }],
    ];
    for (const [route, corps] of cas) {
      const headers = typeof corps === "string" ? { ...h.headers.mutating, "content-type": "application/json" } : h.headers.mutating;
      const res = await post(h, route, corps, headers);
      assertRefus(res, "invalide", route);
      assert.equal(MOTS_ANGLAIS.test(res.body), false, res.body);
    }
  });

  it(".env présent ou absent → même 403 et même corps ; dossier protégé → phrase « dossier »", async (t) => {
    const h = await demarrer(t);
    ecrire(h.travail, "proj/.env", "SECRET=valeur-factice");
    const present = await post(h, "contenu", { projet: "proj", chemin: ".env" });
    const absent = await post(h, "contenu", { projet: "proj", chemin: "scripts/.env" });
    assertRefus(present, "protege", "contenu");
    assert.deepEqual([absent.status, absent.body], [present.status, present.body]);
    assert.equal(present.json<{ message: string }>().message, TEXTES.partout.protegeFichier);
    const git = await post(h, "dossier", { projet: "proj", chemin: ".git" });
    assertRefus(git, "protege", "dossier");
    assert.equal(git.json<{ message: string }>().message, TEXTES.partout.protegeDossier);
    assert.equal(present.body.includes("valeur-factice"), false);
  });

  it("introuvable, projet inconnu, pas un dossier, pas un fichier : 404 et 409 du §2.3", async (t) => {
    const h = await demarrer(t);
    assertRefus(await post(h, "contenu", { projet: "proj", chemin: "absent.txt" }), "introuvable", "contenu");
    assertRefus(await post(h, "dossier", { projet: "absent", chemin: "" }), "projet-inconnu", "dossier");
    assertRefus(await post(h, "dossier", { projet: "proj", chemin: "README.md" }), "pas-un-dossier", "dossier");
    assertRefus(await post(h, "contenu", { projet: "proj", chemin: "scripts" }), "pas-un-fichier", "contenu");
  });

  it("statuts du §2.3 : un par code", () => {
    assert.deepEqual(STATUTS_FICHIERS, {
      invalide: 400,
      "trop-long": 413,
      "fichiers-coupes": 403,
      protege: 403,
      lien: 403,
      "plusieurs-noms": 403,
      "projet-inconnu": 404,
      introuvable: 404,
      "pas-un-dossier": 409,
      "pas-un-fichier": 409,
      "a-change": 409,
      illisible: 409,
      occupe: 429,
    });
  });
});

describe("routes « fichiers » : interrupteur, modes, aucun appel", () => {
  it("COCKPIT_FICHIERS=off (env.fichiers faux) → 403 fichiers-coupes sur les 4 routes, avant la lecture du corps", async (t) => {
    const h = await demarrer(t, { env: { fichiers: false } });
    for (const route of ROUTES) {
      assertRefus(await post(h, route, CORPS[route]), "fichiers-coupes", route);
      assertRefus(await post(h, route, "{", { ...h.headers.mutating, "content-type": "application/json" }), "fichiers-coupes", route);
    }
  });

  it("mode Simple puis Avancé : réponses identiques (P2), fichier ordinaire comme protégé", async (t) => {
    const h = await demarrer(t);
    ecrire(h.travail, "proj/.env", "SECRET=1");
    const demandes: Array<[Route, Record<string, string>]> = [...ROUTES.map((route): [Route, Record<string, string>] => [route, CORPS[route]]), ["contenu", { projet: "proj", chemin: ".env" }]];
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
    h.settings.update({ ui: { mode: "avance" } });
    assert.deepEqual(await lire(), simple);
  });

  it("aucune requête reçue par le faux opencode, aucune ligne facturée (usage) pendant les 4 routes", async (t) => {
    const h = await demarrer(t);
    const avant = h.fake.requests.length;
    const usage = () => (h.db.prepare("SELECT COUNT(*) AS n FROM usage").get() as { n: number }).n;
    const lignes = usage();
    for (const route of ROUTES) assert.equal((await post(h, route, CORPS[route])).status, 200, route);
    assert.equal(h.fake.requests.length, avant);
    assert.equal(h.fake.requests.some((r) => /^\/(file|find)/.test(r.pathname)), false);
    assert.equal(usage(), lignes);
  });

  it("D14 (b) : dossier %XX montré par « dossier » (projet « ») et lisible par « contenu », zéro requête à opencode", async (t) => {
    const h = await demarrer(t);
    ecrire(h.travail, "a%2F..%2F..%2Fdonnees/note.txt", "note ordinaire\n");
    // Le nom contient « secret » : la protection du §2.6 l'emporte (compté dans « masques », jamais nommé).
    ecrire(h.travail, "a%2F..%2F..%2Fsecret/note.txt", "x");
    const avant = h.fake.requests.length;
    const usage = () => (h.db.prepare("SELECT COUNT(*) AS n FROM usage").get() as { n: number }).n;
    const lignes = usage();
    const racine = await post(h, "dossier", { projet: "", chemin: "" });
    assert.equal(racine.status, 200, racine.body);
    const liste = racine.json<{ entrees: Array<{ nom: string; type: string }>; masques: number }>();
    assert.deepEqual(liste.entrees.find((e) => e.nom === "a%2F..%2F..%2Fdonnees")?.type, "dossier");
    assert.equal(liste.masques, 1);
    assert.equal(racine.body.includes("secret"), false);
    const contenu = await post(h, "contenu", { projet: "a%2F..%2F..%2Fdonnees", chemin: "note.txt" });
    assert.equal(contenu.status, 200, contenu.body);
    assert.equal(contenu.json<{ texte: string }>().texte, "note ordinaire");
    assert.equal((await post(h, "contenu", { projet: "", chemin: "a%2F..%2F..%2Fdonnees/note.txt" })).status, 200);
    assert.equal(h.fake.requests.length, avant);
    assert.equal(usage(), lignes);
  });
});

describe("routes « fichiers » : parcours abandonné par la page (relecture F2-vague-6, constat n° 5)", () => {
  /** Attend qu'une condition devienne vraie. */
  async function jusqua(condition: () => boolean, ms = 5_000): Promise<void> {
    const limite = performance.now() + ms;
    while (!condition()) {
      if (performance.now() > limite) throw new Error("délai dépassé");
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  }

  it("« recents » annulé pendant son parcours (connexion fermée) : le signal de la requête atteint le lecteur, un second « recents » immédiat → 200", async (t) => {
    const travail = fs.mkdtempSync(path.join(os.tmpdir(), "cockpit-nav-abandon-"));
    t.after(() => fs.rmSync(travail, { recursive: true, force: true }));
    ecrire(travail, "proj/a.txt", "x");
    let ouvrir = (): void => undefined;
    const tenue = new Promise<void>((resolve) => {
      ouvrir = () => resolve();
    });
    t.after(() => ouvrir());
    let atteint = false;
    let premier = true;
    const log = { warn: () => undefined };
    // Crochet de test sur un lecteur créé ici : routes-fichiers.ts n'en passe jamais (test statique de workspace-files.test.ts).
    const lecteur = creerLecteurFichiers({
      racine: travail,
      log,
      pendant: async (moment) => {
        if (moment !== "parcours-dossier" || !premier) return;
        premier = false;
        atteint = true;
        await tenue;
      },
    });
    const signaux: Array<AbortSignal | undefined> = [];
    const espionne: LecteurFichiers = {
      ...lecteur,
      recents: (demande: DemandeProjet) => {
        signaux.push(demande.signal);
        return lecteur.recents(demande);
      },
    };
    const app = new Hono();
    registerFichiersRoutes(app, { actif: true, lecteur: espionne, log });
    const serveur = createAdaptorServer({ fetch: app.fetch }) as http.Server;
    await new Promise<void>((resolve) => serveur.listen(0, "127.0.0.1", resolve));
    t.after(
      () =>
        new Promise<void>((resolve) => {
          serveur.closeAllConnections();
          serveur.close(() => resolve());
        }),
    );
    const { port } = serveur.address() as AddressInfo;
    const corps = JSON.stringify({ projet: "proj" });
    const envoyer = () =>
      http.request({
        host: "127.0.0.1",
        port,
        method: "POST",
        path: FICHIERS_ROUTES.recents,
        headers: { "content-type": "application/json", "content-length": String(Buffer.byteLength(corps)) },
      });
    const abandonnee = envoyer();
    abandonnee.on("error", () => undefined);
    abandonnee.end(corps);
    await jusqua(() => atteint);
    // La page annule sa requête (AbortController) : le navigateur ferme la connexion.
    abandonnee.destroy();
    await jusqua(() => signaux[0]?.aborted === true);
    const second = await new Promise<{ status: number; body: string }>((resolve, reject) => {
      const requete = envoyer();
      requete.on("error", reject);
      requete.on("response", (res) => {
        const morceaux: Buffer[] = [];
        res.on("data", (morceau: Buffer) => morceaux.push(morceau));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(morceaux).toString("utf8") }));
      });
      requete.end(corps);
    });
    assert.equal(second.status, 200, second.body);
    assert.deepEqual(JSON.parse(second.body).fichiers.map((f: { chemin: string }) => f.chemin), ["a.txt"]);
    ouvrir();
  });
});

describe("module « fichiers » : câblage", () => {
  it("install ne lit que c11.env et c11.log (ni client, ni registre, ni base) et inscrit le seul groupe de routes « fichiers »", () => {
    const lus = new Set<string>();
    const env = { workspaceDir: path.resolve("/workspace-absent"), fichiers: true } as Cockpit11["env"];
    const log = { warn: () => undefined } as unknown as Cockpit11["log"];
    const c11 = new Proxy({} as Cockpit11, {
      get(_cible, cle) {
        lus.add(String(cle));
        if (cle === "env") return env;
        if (cle === "log") return log;
        throw new Error(`lecture interdite : c11.${String(cle)}`);
      },
    });
    const inscrits: string[] = [];
    const reg = {
      routes: (groupe: string) => void inscrits.push(groupe),
      hook: () => assert.fail("aucun crochet"),
      derivation: () => assert.fail("aucune dérivation"),
      hub: () => assert.fail("aucun abonnement"),
      startup: () => assert.fail("aucun démarrage"),
    } as unknown as Registrar;
    fichiersModule.install(reg, c11);
    assert.deepEqual([...lus].sort(), ["env", "log"]);
    assert.deepEqual(inscrits, ["fichiers"]);
    assert.equal(fichiersModule.name, "fichiers");
  });

  it("COCKPIT_FICHIERS_DIR pris comme racine quand il est donné ; sinon le dossier de travail", async (t) => {
    const h = await demarrer(t);
    const lecture = path.join(h.travail, "..", "lecture-seule");
    ecrire(lecture, "autre/x.txt", "x");
    const avecDossier = await startCockpit(t, { modules: ["fichiers"], env: { workspaceDir: lecture, fichiersDir: lecture } });
    const res = await post(avecDossier, "dossier", { projet: "", chemin: "" });
    assert.deepEqual(res.json<{ entrees: Array<{ nom: string }> }>().entrees.map((e) => e.nom), ["autre"]);
    const sansDossier = await post(h, "dossier", { projet: "", chemin: "" });
    assert.deepEqual(sansDossier.json<{ entrees: Array<{ nom: string }> }>().entrees.map((e) => e.nom), ["proj"]);
  });
});

describe("env.ts : COCKPIT_FICHIERS et COCKPIT_FICHIERS_DIR (liste d'autorisation, D14 (a))", () => {
  // Valeurs de test générées à chaque exécution, jamais imprimées.
  const base = { COCKPIT_TOKEN: randomBytes(24).toString("hex"), OPENCODE_SERVER_PASSWORD: randomBytes(12).toString("hex") };

  it("COCKPIT_FICHIERS : vide ou on = actif, off = coupé, autre valeur = refus de démarrer", () => {
    assert.equal(loadEnv(base).fichiers, true);
    for (const value of ["", "on", "ON", " on "]) assert.equal(loadEnv({ ...base, COCKPIT_FICHIERS: value }).fichiers, true, value);
    assert.equal(loadEnv({ ...base, COCKPIT_FICHIERS: "off" }).fichiers, false);
    assert.equal(parseFichiers(" OFF "), false);
    for (const value of ["0", "false", "non", "oui"]) {
      assert.throws(() => loadEnv({ ...base, COCKPIT_FICHIERS: value }), (err: Error) => err instanceof EnvError && err.message === "COCKPIT_FICHIERS : valeur refusée (on ou off).", value);
    }
  });

  it("COCKPIT_FICHIERS_DIR : absent = dossier de travail ; /projets-lecture ou le dossier de travail acceptés, à la lettre", () => {
    const travail = loadEnv(base).workspaceDir;
    assert.equal(loadEnv(base).fichiersDir, undefined);
    assert.equal("fichiersDir" in loadEnv(base), false);
    assert.equal(loadEnv({ ...base, COCKPIT_FICHIERS_DIR: "" }).fichiersDir, undefined);
    assert.equal(FICHIERS_DIR_MONTAGE, "/projets-lecture");
    assert.equal(loadEnv({ ...base, COCKPIT_FICHIERS_DIR: "/projets-lecture" }).fichiersDir, "/projets-lecture");
    assert.equal(loadEnv({ ...base, COCKPIT_FICHIERS_DIR: travail }).fichiersDir, travail);
    const autre = path.resolve("/autre-travail");
    assert.equal(loadEnv({ ...base, COCKPIT_WORKSPACE_DIR: autre, COCKPIT_FICHIERS_DIR: autre }).fichiersDir, autre);
  });

  it("COCKPIT_FICHIERS_DIR : toute autre valeur refuse le démarrage, sans recopier la valeur", () => {
    const refuses = [
      "projets-lecture",
      "relatif/dossier",
      "/",
      "/proc",
      "/proc/self",
      "/data",
      "/data/x",
      "/tls",
      "/oc-data",
      "/oc-config",
      "/control",
      "/omo-auth",
      "/control-omo",
      "/omo-state",
      "/egress-log",
      "/omo-source",
      "/certs",
      "/archives",
      "/workspace/..",
      "/projets-lecture/sous",
      "/projets-lecture/..",
      "/projets-lecture/",
      "/PROJETS-LECTURE",
      " /projets-lecture",
    ];
    for (const value of refuses) {
      assert.throws(
        () => loadEnv({ ...base, COCKPIT_FICHIERS_DIR: value }),
        (err: Error) => err instanceof EnvError && err.message === "COCKPIT_FICHIERS_DIR : dossier refusé.",
        JSON.stringify(value),
      );
    }
    assert.throws(() => parseFichiersDir(`${path.resolve("/workspace")}/sous`, path.resolve("/workspace")), EnvError);
  });
});

describe("docker-compose.yml : second montage en lecture seule (P11)", () => {
  interface Service {
    volumes?: string[];
    environment?: Record<string, string>;
  }
  const texte = fs.readFileSync(path.join(import.meta.dirname, "..", "..", "docker-compose.yml"), "utf8");
  const compose = parseYaml(texte, { merge: true }) as { services: Record<string, Service> };
  const cibleDe = (volume: string) => volume.split(":")[1];

  it("/projets-lecture monté une seule fois, dans cockpit, source ${WORKSPACE_DIR}, en :ro ; /workspace du cockpit en écriture", () => {
    const montages = Object.entries(compose.services).flatMap(([service, s]) => (s.volumes ?? []).filter((v) => cibleDe(v) === "/projets-lecture").map((v) => [service, v]));
    assert.deepEqual(montages, [["cockpit", "${WORKSPACE_DIR}:/projets-lecture:ro"]]);
    const cockpit = compose.services.cockpit?.volumes ?? [];
    assert.ok(cockpit.includes("${WORKSPACE_DIR}:/workspace"));
    assert.equal(cockpit.indexOf("${WORKSPACE_DIR}:/projets-lecture:ro"), cockpit.indexOf("${WORKSPACE_DIR}:/workspace") + 1);
    assert.equal(compose.services.cockpit?.environment?.COCKPIT_FICHIERS_DIR, "/projets-lecture");
    assert.equal(compose.services.cockpit?.environment?.COCKPIT_FICHIERS, "${COCKPIT_FICHIERS:-on}");
  });

  it("aucun montage /projets-lecture dans le service opencode, ni variable de l'onglet", () => {
    const opencode = compose.services.opencode;
    assert.ok(opencode);
    assert.equal((opencode.volumes ?? []).some((v) => v.includes("projets-lecture")), false);
    assert.equal(Object.keys(opencode.environment ?? {}).some((cle) => cle.startsWith("COCKPIT_FICHIERS")), false);
  });
});
