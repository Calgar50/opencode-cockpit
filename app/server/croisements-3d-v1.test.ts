// Tests de croisement du train it3 V1 (plan d'exécution it3 §2.4, §5.2 ; propriété de l'intégrateur) : L29a (plan 3D pur), L29b
// (graphe three), L31a (territoires), L28b (route et service de « Revoir »), L28c (vue Simple, boîte en lecture seule) et L28d
// (consignes gardées, migration 8). Chaque paquet a ses propres tests : ici, seulement ce qui ne se voit QU'UNE FOIS les six
// fusionnés.
// - Porte P-H1 (§7.1) : H1', M0 et v1.0.5 ancêtres de la branche, relus dans le dépôt.
// - L29a × L29b : le plan d'une vraie capture, passé au graphe avec le VRAI three dans Node — un objet au moins par élément,
//   `faits` recopiés hors décor (P12), puis `liberer()` qui libère chaque ressource exactement une fois et vide la racine.
// - L29a × le modèle néon : « différé = direct » du plan sur p1, p2, p6 et p7 (le plan d'un préfixe lu en direct est celui du
//   même moment relu en différé).
// - L28b × L28d × la base : rejeu de p1 par le vrai harnais → une ligne `revoir_consignes` par fait `consigne` à l'état
//   `envoyee`, relue par la VRAIE route des consignes, qui applique le VRAI port `revoir.etat` de L28b ; suppression de
//   l'archive → consignes purgées.
// - L28b × L31a : les deux routes réelles montées par app-factory, racine de la Salle OMO simulée en base, mode Simple.
// - L28c × le modèle néon : vue de « Revoir » en Simple d'une racine de la salle (p1) — au moins deux assistants, un faisceau de
//   consigne, et aucun nom d'agent à l'écran.
// - L28b × L28c : `BandCommands3d` monté dans la bande, et `revoir/**` qui ne prend de la bande que `NeonCarte` et `NeonTableau`.
// - L28d × tout le dépôt : `user_version === MIGRATIONS.length`, montées depuis 5, 6 et 7, et plus aucune assertion à nombre écrit.
// - T3d-b × L28c, L28d, L31a : le contrôle « sans texte » ne saute plus pour consignes.ts, vue-simple.ts ni territoires.ts.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, it, type TestContext } from "node:test";
import { BufferGeometry, InstancedMesh, LineBasicMaterial, MeshBasicMaterial, type Object3D, ShaderMaterial, SpriteMaterial, Texture } from "three";
import { creerGraphe } from "../web/pages/salle-controle/three/graphe.ts";
import { MIGRATIONS, openDb, transaction } from "./db.ts";
import type { ActivityFact, FactsResponse } from "./shared/activity-types.ts";
import { libelleNoeud, lignesTableau } from "./shared/neon-band.ts";
import { NEON_PALETTES } from "./shared/neon-palette.ts";
import { planConversation } from "./shared/neon-plan3d.ts";
import { moments, NEON_SECTEURS, type NeonSceneOptions, scene, visibleCount } from "./shared/neon-scene.ts";
import { libelleSecteur } from "./shared/neon-texts.ts";
import { TEXTES } from "./shared/revoir-texts.ts";
import type { Plan3d, RevoirConsigneResponse, TerritoiresResponse } from "./shared/salle3d-types.ts";
import { modeSceneRevoir, nomsSimples, vueSimple } from "./shared/vue-simple.ts";
import { type CockpitHarness, startCockpit } from "./test-support/cockpit-harness.ts";
import { readCapture } from "./test-support/fake-opencode.ts";
import { demoFacts, DEMO_P1_CAPTURE, DEMO_P1_ROOT, DEMO_P1_SENT } from "./test-support/gen-demo.ts";

const APP_DIR = path.join(import.meta.dirname, "..");
const DEPOT = path.join(APP_DIR, "..");
const PALETTE = NEON_PALETTES.sombre;
const AVANCE: NeonSceneOptions = { zoom: 2, mode: "avance" };
/**
 * Captures jouées par le train, toutes enregistrées sur la même conversation (DEMO_P1_ROOT) : p8 (autonomie) est absente de la
 * branche (porte P-IT2 souple, croisement repris à GF2).
 */
const CAPTURES = ["p1-delegation-parallele.jsonl", "p2-commande-subtask.jsonl", "p6-arret-global.jsonl", "p7-autorisation-orpheline.jsonl"] as const;
/** Messages envoyés par le cockpit dans les captures (demande de p1, commande de p2, demande de p6). */
const ENVOYES: readonly string[] = ["msg_09e702c4e001phPA6LcfC9t4WK", "msg_09e70de68001w3xwbgF26JxZPW", "msg_09e75b36c001x5Cehfmxl57pRZ"];

const lire = (relatif: string) => fs.readFileSync(path.join(APP_DIR, relatif), "utf8");

const faitsDe = (capture: string): ActivityFact[] => demoFacts(capture, DEMO_P1_ROOT, ENVOYES);

// --- Porte P-H1 (§7.1) ------------------------------------------------------------------------------------------------------------

/** H1' (fusion de H1 et de M0), M0 et l'étiquette de la 1.0.5 : les trois ancêtres que la porte P-H1 exige. */
const ANCETRES: ReadonlyArray<readonly [string, string]> = [
  ["H1'", "55ad5f1f03baf5f180359f9fa3a4c38191ee9623"],
  ["M0", "06cae1c"],
  ["v1.0.5", "v1.0.5"],
];

function git(...args: string[]): string {
  return execFileSync("git", ["-C", DEPOT, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

/** Le dépôt est-il lisible ici ? (une copie exportée sans .git ne peut pas vérifier la porte) */
function depotLisible(): boolean {
  try {
    git("rev-parse", "--git-dir");
    return true;
  } catch {
    return false;
  }
}

describe("train V1 : porte P-H1", () => {
  it(
    "H1', M0 et v1.0.5 sont des ancêtres de la branche intégrée",
    { skip: depotLisible() ? false : "dépôt git absent de cette copie : porte vérifiée à la fusion" },
    () => {
      for (const [nom, commit] of ANCETRES) {
        assert.doesNotThrow(() => git("merge-base", "--is-ancestor", commit, "HEAD"), `${nom} (${commit}) n'est pas un ancêtre de HEAD`);
      }
    },
  );

  it(
    "le modèle néon attendu par la porte est bien là (aucun squelette T2, démonstration p1, moments)",
    { skip: fs.existsSync(path.join(APP_DIR, "web/pages/chat/activity/demo-p1.json")) ? false : "demo-p1.json absent" },
    () => {
      for (const fichier of ["web/pages/chat/activity/NeonBand.tsx", "web/pages/chat/activity/DemoPlayer.tsx", "web/pages/chat/activity/ActivityRegion.tsx"]) {
        assert.equal(lire(fichier).includes("Squelette T2"), false, fichier);
      }
      assert.match(lire("server/shared/neon-scene.ts"), /export function moments/);
      // D-3d-12 : le repli de L28c n'a pas lieu d'être tant que la bande exporte ces deux composants.
      assert.match(lire("web/pages/chat/activity/NeonBand.tsx"), /export function NeonCarte/);
      assert.match(lire("web/pages/chat/activity/NeonBand.tsx"), /export function NeonTableau/);
    },
  );
});

// --- L29a × L29b : plan d'une vraie capture, monté puis libéré avec le vrai three ------------------------------------------------

/** Nombre de signes que le plan demande de dessiner (hors décor : stations, territoires, étiquettes). */
const signesDuPlan = (plan: Plan3d): number => plan.noeuds.length + plan.faisceaux.length + plan.marques.length + plan.tuiles.filter((lot) => lot.positions.length > 0).length;

function descendants(racine: Object3D): Object3D[] {
  const tous: Object3D[] = [];
  racine.traverse((objet) => {
    if (objet !== racine) tous.push(objet);
  });
  return tous;
}

/** Ressources portées par la scène : géométries, matériaux, textures de leur carte, et les `InstancedMesh` eux-mêmes. */
function ressourcesDe(racine: Object3D): Set<object> {
  const tout = new Set<object>();
  for (const objet of descendants(racine)) {
    const porteur = objet as unknown as { geometry?: object; material?: { map?: object | null } };
    if (porteur.geometry) tout.add(porteur.geometry);
    if (porteur.material) {
      tout.add(porteur.material);
      if (porteur.material.map) tout.add(porteur.material.map);
    }
    if (objet instanceof InstancedMesh) tout.add(objet);
  }
  return tout;
}

/** Enveloppe `dispose()` sur les prototypes de three employés par le graphe, et compte les appels par objet. */
function pendant(action: () => void): Map<object, number> {
  const comptes = new Map<object, number>();
  const restaurations: Array<() => void> = [];
  const poser = <T extends { dispose(): void }>(prototype: T): void => {
    const original = prototype.dispose;
    prototype.dispose = function remplacant(this: T): void {
      comptes.set(this, (comptes.get(this) ?? 0) + 1);
      original.call(this);
    };
    restaurations.push(() => {
      prototype.dispose = original;
    });
  };
  for (const prototype of [BufferGeometry.prototype, Texture.prototype, InstancedMesh.prototype, MeshBasicMaterial.prototype, LineBasicMaterial.prototype, SpriteMaterial.prototype, ShaderMaterial.prototype]) {
    poser(prototype as { dispose(): void });
  }
  try {
    action();
  } finally {
    for (const restaurer of restaurations) restaurer();
  }
  return comptes;
}

describe("train V1 : plan 3D (L29a) monté par le graphe three (L29b)", () => {
  for (const capture of CAPTURES) {
    it(`${capture} : un objet au moins par signe, faits recopiés hors décor, puis liberer() qui ne laisse rien`, () => {
      const faits = faitsDe(capture);
      assert.ok(faits.length > 0, "capture sans fait");
      const vue = scene(faits, null, AVANCE);
      const factsDeLaScene = new Set<readonly number[]>([...vue.noeuds, ...vue.faisceaux, ...vue.attentes, ...vue.decisions, ...vue.impulsions, ...vue.origines].map((signe) => signe.faits));
      const plan = planConversation(vue, { theme: "sombre", mode: "avance" });
      assert.ok(signesDuPlan(plan) > 0, "plan sans aucun signe");

      // P12, premier maillon : le plan recopie les faits de la scène (modifier le plan ne modifie jamais la scène).
      for (const signe of [...plan.noeuds, ...plan.faisceaux, ...plan.marques, ...plan.tuiles]) {
        assert.equal(factsDeLaScene.has(signe.faits), false, "le plan partage un tableau de faits de la scène");
      }

      const graphe = creerGraphe(plan, PALETTE);
      try {
        assert.ok(graphe.nombreObjets() >= signesDuPlan(plan), `${graphe.nombreObjets()} objets pour ${signesDuPlan(plan)} signes`);

        // P12 : tout objet qui n'est pas du décor cite des faits, et ces faits sont ceux du plan, recopiés (jamais partagés).
        const factsDuPlan = new Set<readonly number[]>([...plan.noeuds, ...plan.faisceaux, ...plan.marques].map((signe) => signe.faits));
        let porteurs = 0;
        for (const objet of descendants(graphe.racine)) {
          const data = objet.userData as { decor?: unknown; faits?: unknown };
          if (data.decor === true) {
            assert.equal(data.faits, undefined, "le décor ne porte aucun fait");
            continue;
          }
          if (!Array.isArray(data.faits)) continue;
          porteurs += 1;
          assert.ok(data.faits.length > 0, "un signe sans fait");
          assert.equal(factsDuPlan.has(data.faits as readonly number[]), false, "faits du plan partagés au lieu d'être recopiés");
          for (const indice of data.faits as number[]) assert.ok(Number.isInteger(indice) && indice >= 0 && indice < faits.length, `indice hors des faits : ${indice}`);
        }
        assert.ok(porteurs >= signesDuPlan(plan), `${porteurs} objets porteurs de faits pour ${signesDuPlan(plan)} signes`);
      } finally {
        const portees = ressourcesDe(graphe.racine);
        const comptes = pendant(() => graphe.liberer());
        assert.ok(portees.size > 0, "scène sans aucune ressource");
        for (const ressource of portees) assert.equal(comptes.get(ressource), 1, "ressource de la scène non libérée, ou libérée deux fois");
        assert.deepEqual([...comptes.values()].filter((appels) => appels !== 1), [], "chaque ressource libérée exactement une fois");
        assert.equal(graphe.nombreObjets(), 0, "racine vidée");
      }
    });
  }
});

// --- L29a × modèle néon : « différé = direct » du plan (P12, JP-8) ----------------------------------------------------------------

describe("train V1 : « différé = direct » du plan 3D", () => {
  for (const capture of CAPTURES) {
    it(`${capture} : à chaque moment, le plan du différé est celui du direct`, () => {
      const faits = faitsDe(capture);
      const tous = moments(faits);
      assert.ok(tous.length > 0, "capture sans moment");
      for (const t of tous) {
        const differe = planConversation(scene(faits, t, AVANCE), { theme: "sombre", mode: "avance" });
        const direct = planConversation(scene(faits.slice(0, visibleCount(faits, t)), null, AVANCE), { theme: "sombre", mode: "avance" });
        assert.deepEqual(differe, direct, `moment ${t}`);
      }
    });
  }
});

// --- L28c × modèle néon : vue de « Revoir » en Simple d'une racine de la salle -----------------------------------------------------

describe("train V1 : « Revoir » en Simple d'une racine de la Salle OMO (D-3d-20, décision n° 7)", () => {
  it("au moins deux assistants et un faisceau de consigne, sans aucun nom d'agent à l'écran", () => {
    const faits = demoFacts(DEMO_P1_CAPTURE, DEMO_P1_ROOT, DEMO_P1_SENT);
    const permis = new Set<string>([TEXTES.simple.assistantPrincipal, ...NEON_SECTEURS.map((secteur) => libelleSecteur(secteur))]);
    const nomsDeLaFixture = [
      ...new Set(
        scene(faits, null, AVANCE)
          .noeuds.map((noeud) => noeud.agent ?? "")
          .filter((nom) => nom !== ""),
      ),
    ];
    assert.ok(nomsDeLaFixture.length >= 2, "la fixture doit porter des noms d'agent, sinon la garde ne prouve rien");

    const mode = modeSceneRevoir({ salle: true, advanced: false });
    assert.equal(mode, "avance", "une racine de la salle est dessinée en entier, même en mode Simple");
    let vueTrouvee = false;
    for (const t of moments(faits)) {
      const brute = scene(faits, t, { zoom: 2, mode });
      if (brute.noeuds.length < 2 || !brute.faisceaux.some((faisceau) => faisceau.kind === "consigne")) continue;
      vueTrouvee = true;
      const vue = vueSimple(brute, nomsSimples(brute, true));
      assert.equal(vue.mode, "simple");
      const montre = [
        ...lignesTableau(vue).flatMap((ligne) => [ligne.nom, ligne.secteur ?? "", ligne.etat, ...ligne.signes]),
        ...vue.noeuds.map((noeud) => libelleNoeud(noeud)),
      ].join(" | ");
      for (const nom of nomsDeLaFixture) assert.equal(montre.includes(nom), false, `nom d'agent montré : ${nom}`);
      assert.equal(/agent/i.test(montre), false, montre);
      assert.equal(/orchestrateur/i.test(montre), false, montre);
      for (const noeud of vue.noeuds) assert.ok(noeud.agent !== null && permis.has(noeud.agent), `nom montré : ${noeud.agent}`);
      break;
    }
    assert.ok(vueTrouvee, "aucun moment de p1 ne montre deux assistants et une consigne");
  });
});

// --- L28b × L28c : la bande, les commandes et la boîte -----------------------------------------------------------------------------

/** Imports d'un source, commentaires ignorés. */
function importsDe(source: string): Array<{ spec: string; noms: string[] }> {
  const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/.*$/gm, "");
  return [...code.matchAll(/^[ \t]*import[ \t]+([^;]*?)[ \t]*from[ \t]*["']([^"']+)["']/gm)].map((m) => ({
    spec: m[2] ?? "",
    noms: [...(m[1] ?? "").matchAll(/[A-Za-z_$][\w$]*/g)].map((nom) => nom[0]),
  }));
}

describe("train V1 : entrées de « Revoir » (L28b) et boîte en lecture seule (L28c)", () => {
  it("la bande monte BandCommands3d dans une section balisée [3d], et l'importe sur une ligne balisée", () => {
    const bande = lire("web/pages/chat/activity/NeonBand.tsx");
    assert.match(bande, /<BandCommands3d\b/);
    for (const ligne of bande.split("\n")) {
      if (/\bBandCommands3d\b/.test(ligne) && /^\s*import\b/.test(ligne)) assert.match(ligne, /\/\/ \[3d\]/, ligne);
    }
    assert.match(lire("web/pages/archives/ArchiveDetail.tsx"), /<RevoirEntree\b/);
  });

  it("revoir/** ne prend de la bande que NeonCarte et NeonTableau, et jamais le client d'opencode", () => {
    const dossier = path.join(APP_DIR, "web/pages/salle-controle/revoir");
    const fichiers = fs.readdirSync(dossier).filter((nom) => nom.endsWith(".ts") || nom.endsWith(".tsx"));
    assert.ok(fichiers.length >= 6, "dossier revoir/ non parcouru");
    let vus = 0;
    for (const nom of fichiers) {
      for (const { spec, noms } of importsDe(fs.readFileSync(path.join(dossier, nom), "utf8"))) {
        assert.equal(/\/lib\/api\.ts$|\/lib\/api-activity\.ts$/.test(spec), false, `${nom} importe ${spec}`);
        if (!spec.endsWith("NeonBand.tsx")) continue;
        vus += 1;
        assert.deepEqual([...noms].sort(), ["NeonCarte", "NeonTableau"], nom);
      }
    }
    assert.ok(vus > 0, "aucun import de la bande dans revoir/ : la garde ne prouverait rien");
  });
});

// --- L28b × L28d × L31a : les routes réelles, sur la vraie base ---------------------------------------------------------------------

const SALLE = "ses_croisement_salle";
const lignesUsage = (h: CockpitHarness) => (h.db.prepare("SELECT COUNT(*) AS n FROM usage").get() as { n: number }).n;

/** Racine de la Salle OMO posée en base, avec sa dernière demande (terminée ou non). */
function poserSalle(h: CockpitHarness, finie: boolean): void {
  h.db
    .prepare("INSERT INTO sessions (id, parent_id, root_id, directory, title, purpose, instance, created_at, updated_at) VALUES (?, NULL, ?, '', ?, 'chat', 'omo', 1, 1)")
    .run(SALLE, SALLE, "[synthétique] demande de la salle");
  h.db
    .prepare("INSERT INTO autonomy_requests (id, root_id, choix, plafonds, started_at, ended_at) VALUES (?, ?, 'autonome', '{}', 100, ?)")
    .run("aur_croisement", SALLE, finie ? 200 : null);
}

describe("train V1 : routes réelles de la salle et de « Revoir » (app-factory)", () => {
  it("territoires et « Revoir » répondent, en lecture seule et sans requête à opencode", async (t: TestContext) => {
    const h = await startCockpit(t);
    const avant = h.fake.requests.length;
    const usageAvant = lignesUsage(h);

    const territoires = await h.call("GET", "/api/salle-controle/territoires", { headers: h.headers.authed });
    assert.equal(territoires.status, 200);
    const vue = territoires.json<TerritoiresResponse>();
    assert.equal(vue.mode, "simple");
    assert.ok(Array.isArray(vue.projets));

    poserSalle(h, true);
    const terminee = await h.call("GET", `/api/revoir/${SALLE}`, { headers: h.headers.authed });
    assert.equal(terminee.status, 200, "demande terminée : « Revoir » ouvert même en mode Simple");

    h.db.prepare("UPDATE autonomy_requests SET ended_at = NULL WHERE id = 'aur_croisement'").run();
    const enCours = await h.call("GET", `/api/revoir/${SALLE}`, { headers: h.headers.authed });
    assert.equal(enCours.status, 403, "demande en cours : refusée en mode Simple");
    assert.equal((enCours.json() as { code?: string }).code, "salle-demande-en-cours");

    assert.equal(lignesUsage(h), usageAvant, "aucune ligne usage");
    assert.deepEqual(h.fake.requests.slice(avant).map((r) => `${r.method} ${r.pathname}`), [], "aucune requête à opencode");
  });

  it("rejeu de p1 : une consigne gardée par fait « consigne envoyee », relue par la vraie route, purgée avec l'archive", async (t: TestContext) => {
    const h = await startCockpit(t, { modules: ["facts"] });
    // La racine est connue du cockpit avant la délégation (son proxy l'enregistre à l'envoi de la demande) : une capture rejouée
    // d'un coup n'en laisse pas le temps à la file du processeur.
    h.db.prepare("INSERT INTO sessions (id, parent_id, root_id, created_at, updated_at) VALUES (?, NULL, ?, 1, 1)").run(DEMO_P1_ROOT, DEMO_P1_ROOT);
    for (const { wire } of readCapture(DEMO_P1_CAPTURE)) h.fake.emitRaw(wire);

    const envoyees = async (): Promise<ActivityFact[]> => {
      const reponse = await h.call("GET", `/api/conversations/${DEMO_P1_ROOT}/facts?since=0`, { headers: h.headers.authed });
      return reponse.json<FactsResponse>().facts.filter((fait) => fait.kind === "consigne" && fait.data.etat === "envoyee");
    };
    const gardees = () => h.db.prepare("SELECT call_id FROM revoir_consignes WHERE root_id = ? ORDER BY at, id").all(DEMO_P1_ROOT) as Array<{ call_id: string }>;

    // Les faits et les consignes arrivent par la file du processeur : on attend que les deux se rejoignent (jamais de sleep fixe).
    let faits: ActivityFact[] = [];
    const limite = Date.now() + 15_000;
    for (;;) {
      faits = await envoyees();
      if (faits.length > 0 && gardees().length >= faits.length) break;
      if (Date.now() > limite) break;
      await new Promise((resoudre) => setTimeout(resoudre, 20));
    }
    assert.ok(faits.length > 0, "p1 porte au moins une consigne envoyée");
    const clefsDesFaits = faits.map((fait) => String(fait.data.callId ?? fait.ref ?? "")).filter((clef) => clef !== "");
    assert.equal(clefsDesFaits.length, faits.length, "chaque fait « consigne envoyee » porte sa clé d'appel");
    assert.deepEqual(
      gardees()
        .map((ligne) => ligne.call_id)
        .sort(),
      [...clefsDesFaits].sort(),
      "une ligne revoir_consignes par fait « consigne envoyee »",
    );

    // Vraie route des consignes, avec le vrai port revoir.etat de L28b : la conversation est celle du cockpit, donc lisible.
    const premiere = clefsDesFaits[0] ?? "";
    const reponse = await h.call("GET", `/api/revoir/${DEMO_P1_ROOT}/consignes/${premiere}`, { headers: h.headers.authed });
    assert.equal(reponse.status, 200);
    const consigne = reponse.json<RevoirConsigneResponse>();
    assert.equal(consigne.callId, premiere);
    assert.ok(consigne.texte.length > 0, "consigne gardée vide");

    // Purge : l'archive supprimée emporte les consignes de la conversation (U2, D-3d-30). La ligne `conversations` est ce que la
    // suppression d'une archive prend pour cible (le rejeu d'une capture ne la crée pas).
    const maintenant = Date.now();
    h.db
      .prepare("INSERT INTO conversations (session_id, directory, title, created_at, updated_at) VALUES (?, '/workspace', '[synthétique]', ?, ?)")
      .run(DEMO_P1_ROOT, maintenant, maintenant);
    assert.equal(await h.deps.archive.remove(DEMO_P1_ROOT), true);
    assert.deepEqual(gardees(), [], "consignes purgées avec la conversation");
  });

  it("consignes d'une racine de la salle en mode Simple : terminée → 200, en cours → 403", async (t: TestContext) => {
    const h = await startCockpit(t);
    poserSalle(h, true);
    h.db
      .prepare(
        `INSERT INTO revoir_consignes (root_id, parent_session_id, enfant_session_id, call_id, texte, longueur, tronque, at)
         VALUES (?, ?, NULL, ?, ?, 10, 0, 1000)`,
      )
      .run(SALLE, SALLE, "call_croisement", "[synthétique] consigne de la salle");

    const ouverte = await h.call("GET", `/api/revoir/${SALLE}/consignes/call_croisement`, { headers: h.headers.authed });
    assert.equal(ouverte.status, 200);
    assert.equal(ouverte.json<RevoirConsigneResponse>().callId, "call_croisement");

    h.db.prepare("UPDATE autonomy_requests SET ended_at = NULL WHERE id = 'aur_croisement'").run();
    const refusee = await h.call("GET", `/api/revoir/${SALLE}/consignes/call_croisement`, { headers: h.headers.authed });
    assert.equal(refusee.status, 403, "une demande en cours ferme aussi la consigne");
    assert.equal((refusee.json() as { code?: string }).code, "salle-demande-en-cours");
  });
});

// --- L28d × tout le dépôt : migration 8 et règle d'assertion -------------------------------------------------------------------------

const userVersion = (db: DatabaseSync): number => (db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version;

describe("train V1 : migration 8 (A2, D-3d-23)", () => {
  it("une base neuve est migrée jusqu'au bout, et une base de la 5, de la 6 ou de la 7 y monte", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "3d11-v1-"));
    try {
      for (const depuis of [5, 6, 7]) {
        const sousDossier = path.join(dir, `v${depuis}`);
        fs.mkdirSync(sousDossier);
        const vieille = new DatabaseSync(path.join(sousDossier, "cockpit.db"));
        vieille.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;");
        for (let v = 0; v < depuis; v++) {
          transaction(vieille, () => {
            vieille.exec(MIGRATIONS[v] ?? "");
            vieille.exec(`PRAGMA user_version = ${v + 1}`);
          });
        }
        assert.equal(userVersion(vieille), depuis);
        vieille.close();

        const db = openDb(sousDossier);
        try {
          assert.equal(userVersion(db), MIGRATIONS.length, `montée depuis ${depuis}`);
          assert.equal((db.prepare("SELECT COUNT(*) AS n FROM revoir_consignes").get() as { n: number }).n, 0);
        } finally {
          db.close();
        }
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("plus aucune assertion à nombre écrit sur user_version ni MIGRATIONS.length (hors migration8.test.ts)", () => {
    const fautifs: string[] = [];
    for (const nom of fs.readdirSync(path.join(APP_DIR, "server")).filter((f) => f.endsWith(".test.ts") && f !== "migration8.test.ts")) {
      const source = lire(path.join("server", nom)).replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/.*$/gm, "");
      for (const ligne of source.split("\n")) {
        if (!/assert\./.test(ligne)) continue;
        // Grande fusion (GF3) : les contrôles discriminants de la règle jumelle des équipes (croisements-eq-v1.test.ts) passent
        // les formes interdites, écrites en toutes lettres, à `asserteUnNombre(…)` ; ce ne sont pas des assertions de version.
        if (/asserteUnNombre\(/.test(ligne)) continue;
        if (/user_version|MIGRATIONS\.length/.test(ligne) && /,\s*\d+\s*[),]|===\s*\d+/.test(ligne)) fautifs.push(`${nom} : ${ligne.trim()}`);
      }
    }
    assert.deepEqual(fautifs, []);
  });
});

// --- L28b × L28c × la fiche d'archive : zones de la grille -------------------------------------------------------------------------
// Corrections de la relecture 3-vague-1 : `<RevoirEntree placement="archives"/>` est posé en enfant direct de `.archive-grid`, une
// grille à zones nommées. Sans règle `grid-area`, l'auto-placement renvoyait l'entrée dans une rangée implicite, tout en bas de la
// page, sous la Transcription. Contrôle STATIQUE : tout enfant direct de la grille a sa zone, et, pour chaque combinaison d'enfants
// facultatifs (Déroulé, entrée « Revoir ») et pour les deux largeurs, la règle `.archive-grid` qui l'emporte nomme exactement les
// zones de ces enfants — ni oubli, ni zone orpheline.

const CSS_DIR = path.join(APP_DIR, "web");

/** Enfant direct de `.archive-grid` (ArchiveDetail.tsx) : sa classe, sa présence, et la marque qui le prouve dans le source. */
const ENFANTS_ARCHIVE: ReadonlyArray<{ quoi: string; classe: string; toujours: boolean; marque: RegExp }> = [
  { quoi: "résumé", classe: "area-summary", toujours: true, marque: /className="area-summary"/ },
  { quoi: "panneau latéral", classe: "area-side", toujours: true, marque: /<aside className="area-side"/ },
  { quoi: "transcription", classe: "area-transcript", toujours: true, marque: /className="area-transcript"/ },
  { quoi: "Déroulé", classe: "deroule--archives", toujours: false, marque: /<Deroule rootId=\{sessionId\} placement="archives"/ },
  { quoi: "entrée « Revoir »", classe: "revoir-entree", toujours: false, marque: /<RevoirEntree rootId=\{sessionId\} placement="archives" \/>/ },
];

interface RegleCss {
  selecteurs: string[];
  corps: string;
  /** Contexte `@media` normalisé ; chaîne vide hors media. */
  media: string;
  ordre: number;
}

/** Règles d'une feuille : `@media` suivis, autres règles-at (keyframes, font-face) sautées avec leur bloc. */
function lireRegles(css: string, media: string, out: RegleCss[]): void {
  let i = 0;
  while (i < css.length) {
    const ouvre = css.indexOf("{", i);
    if (ouvre === -1) return;
    const prelude = css.slice(i, ouvre).trim().replace(/\s+/g, " ");
    let profondeur = 1;
    let j = ouvre + 1;
    while (j < css.length && profondeur > 0) {
      if (css[j] === "{") profondeur += 1;
      else if (css[j] === "}") profondeur -= 1;
      j += 1;
    }
    const corps = css.slice(ouvre + 1, j - 1);
    if (prelude.startsWith("@media")) lireRegles(corps, media === "" ? prelude : `${media} ${prelude}`, out);
    else if (!prelude.startsWith("@")) out.push({ selecteurs: prelude.split(",").map((s) => s.trim()), corps, media, ordre: out.length });
    i = j;
  }
}

/** Toutes les règles des feuilles de web/, commentaires retirés, dans l'ordre des fichiers. */
function reglesDeLInterface(): RegleCss[] {
  const out: RegleCss[] = [];
  for (const nom of (fs.readdirSync(CSS_DIR, { recursive: true }) as string[]).filter((f) => f.endsWith(".css")).sort()) {
    lireRegles(fs.readFileSync(path.join(CSS_DIR, nom), "utf8").replace(/\/\*[\s\S]*?\*\//g, ""), "", out);
  }
  return out;
}

/** Zones nommées par `grid-template-areas` ; null si la règle n'en déclare pas. */
function zonesDeLaGrille(corps: string): Set<string> | null {
  const declaration = /grid-template-areas\s*:([^;]*);/.exec(corps);
  if (declaration === null) return null;
  const zones = new Set<string>();
  for (const chaine of (declaration[1] ?? "").matchAll(/"([^"]*)"/g)) {
    for (const nom of (chaine[1] ?? "").split(/\s+/)) if (nom !== "" && nom !== ".") zones.add(nom);
  }
  return zones;
}

/** Valeur d'une déclaration `grid-area` (jamais `grid-template-areas`). */
const zoneDeclaree = (corps: string): string | null => /(?<![\w-])grid-area\s*:\s*([\w-]+)\s*;/.exec(corps)?.[1] ?? null;

interface GrilleArchive {
  selecteur: string;
  /** Classes exigées par les `:has(> .x)` du sélecteur. */
  conditions: string[];
  zones: Set<string>;
  media: string;
  ordre: number;
}

const grillesArchive = (regles: readonly RegleCss[]): GrilleArchive[] =>
  regles.flatMap((regle) =>
    regle.selecteurs
      .filter((sel) => sel.startsWith(".archive-grid"))
      .flatMap((sel) => {
        const zones = zonesDeLaGrille(regle.corps);
        if (zones === null) return [];
        const conditions = [...sel.matchAll(/:has\(\s*>\s*\.([\w-]+)\s*\)/g)].map((m) => m[1] ?? "");
        return [{ selecteur: sel, conditions, zones, media: regle.media, ordre: regle.ordre }];
      }),
  );

/** Zone nommée d'une classe (règle hors `@media` qui cible cette classe et déclare `grid-area`) ; null : aucune. */
function zoneDeClasse(regles: readonly RegleCss[], classe: string): string | null {
  const cible = new RegExp(`\\.${classe}(?![\\w-])`);
  for (const regle of regles) {
    if (regle.media !== "" || !regle.selecteurs.some((sel) => cible.test(sel))) continue;
    const zone = zoneDeclaree(regle.corps);
    if (zone !== null) return zone;
  }
  return null;
}

/** Règle qui l'emporte : toutes ses conditions remplies, le plus de conditions, puis la dernière écrite. */
function grilleGagnante(grilles: readonly GrilleArchive[], media: string, presentes: ReadonlySet<string>): GrilleArchive | null {
  let gagnante: GrilleArchive | null = null;
  for (const grille of grilles) {
    if (grille.media !== media || !grille.conditions.every((classe) => presentes.has(classe))) continue;
    const mieux = gagnante === null || grille.conditions.length > gagnante.conditions.length || (grille.conditions.length === gagnante.conditions.length && grille.ordre > gagnante.ordre);
    if (mieux) gagnante = grille;
  }
  return gagnante;
}

const MEDIAS_ARCHIVE = ["", "@media (max-width: 1100px)"] as const;

/** Manquements de la grille de la fiche d'archive : enfant sans zone, ou grille qui ne nomme pas exactement les zones présentes. */
function manquementsGrilleArchive(regles: readonly RegleCss[]): string[] {
  const manquements: string[] = [];
  const zones = new Map<string, string>();
  for (const enfant of ENFANTS_ARCHIVE) {
    const zone = zoneDeClasse(regles, enfant.classe);
    if (zone === null) manquements.push(`${enfant.quoi} (.${enfant.classe}) : aucune zone nommée (grid-area)`);
    else zones.set(enfant.classe, zone);
  }
  if (manquements.length > 0) return manquements;
  const grilles = grillesArchive(regles);
  const facultatifs = ENFANTS_ARCHIVE.filter((e) => !e.toujours).map((e) => e.classe);
  for (const media of MEDIAS_ARCHIVE) {
    for (let masque = 0; masque < 2 ** facultatifs.length; masque++) {
      const presentes = new Set(ENFANTS_ARCHIVE.filter((e) => e.toujours).map((e) => e.classe));
      for (const [rang, classe] of facultatifs.entries()) if ((masque & (1 << rang)) !== 0) presentes.add(classe);
      const attendues = [...presentes].map((classe) => zones.get(classe) ?? "").sort();
      const gagnante = grilleGagnante(grilles, media, presentes);
      const ou = `${media === "" ? "par défaut" : media} avec ${[...presentes].sort().join(" + ")}`;
      if (gagnante === null) manquements.push(`${ou} : aucune règle .archive-grid ne pose de grille`);
      else if ([...gagnante.zones].sort().join(" ") !== attendues.join(" ")) {
        manquements.push(`${ou} : ${gagnante.selecteur} nomme « ${[...gagnante.zones].sort().join(" ")} » au lieu de « ${attendues.join(" ")} »`);
      }
    }
  }
  return manquements;
}

describe("train V1 : l'entrée « Revoir » des Archives (L28b) a sa zone dans la grille de la fiche (L28c, revoir.css)", () => {
  it("ArchiveDetail.tsx pose bien ces enfants directs dans .archive-grid", () => {
    const source = lire("web/pages/archives/ArchiveDetail.tsx");
    assert.match(source, /<div className="archive-grid">/);
    for (const enfant of ENFANTS_ARCHIVE) assert.match(source, enfant.marque, enfant.quoi);
    // Aucune autre zone `area-*` n'est posée sur la fiche : la table ci-dessus reste la liste complète.
    const autres = [...source.matchAll(/className="(area-[\w-]+)"/g)].map((m) => m[1] ?? "").filter((classe) => !ENFANTS_ARCHIVE.some((e) => e.classe === classe));
    assert.deepEqual([...new Set(autres)], []);
  });

  it("chaque enfant direct a sa zone, et la grille qui l'emporte nomme exactement les zones présentes (deux largeurs)", () => {
    const regles = reglesDeLInterface();
    assert.ok(grillesArchive(regles).length >= 8, "les règles .archive-grid sont bien lues");
    const manquements = manquementsGrilleArchive(regles);
    assert.deepEqual(manquements, [], manquements.join("\n"));
  });

  it("DISCRIMINANT : sans les règles de .revoir-entree, le contrôle échoue", () => {
    const regles = reglesDeLInterface();
    const sansRevoir = regles.filter((regle) => !regle.selecteurs.some((sel) => /\.revoir-entree(?![\w-])/.test(sel)));
    const manquements = manquementsGrilleArchive(sansRevoir);
    assert.ok(
      manquements.some((m) => m.includes("revoir-entree")),
      manquements.join("\n"),
    );
    // Témoin : le seul retrait des règles de grille (la zone gardée) est vu aussi, par les combinaisons.
    const sansGrille = regles.filter((regle) => !regle.selecteurs.some((sel) => sel.startsWith(".archive-grid") && /\.revoir-entree(?![\w-])/.test(sel)));
    assert.ok(manquementsGrilleArchive(sansGrille).length > 0);
  });
});

// --- T3d-b × L28c, L28d, L31a : contrôles « sans texte » qui ne sautent plus ---------------------------------------------------------

describe("train V1 : modules « sans texte » de la vague (D-3d-21)", () => {
  for (const fichier of ["consignes.ts", "vue-simple.ts", "territoires.ts"]) {
    it(`server/shared/${fichier} est là, donc son contrôle « sans texte » ne saute plus`, () => {
      assert.ok(fs.existsSync(path.join(APP_DIR, "server/shared", fichier)), fichier);
      assert.match(lire("server/textes-3d.test.ts"), new RegExp(`fichier: "${fichier.replace(".", "\\.")}"`));
    });
  }
});
