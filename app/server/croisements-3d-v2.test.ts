// Tests de croisement du train it3 V2 (plan d'exécution it3 §2.4, §5.2 ; propriété de l'intégrateur) : L29c (moteur three,
// caméra, boucle), L29d (Scene3d et étiquettes), L31b (page et zoom 1), L31c (zooms 2 et 3) et L34 (démonstrations). Chaque
// paquet a ses propres tests ; ici, seulement ce qui ne se voit QU'UNE FOIS les cinq fusionnés.
// - L31b × L29d × L31c : la page et le zoom montent Scene3d et ZoomConversation par le SEUL contrat de slots-3d.ts — chaque
//   propriété exigée est passée, aucune propriété inventée n'est ajoutée.
// - L29d × L29c × L32 : Scene3d n'atteint le moteur que par moteur-chargeur.ts (import dynamique), et ce fichier reste la seule
//   frontière de web/ vers ./three/.
// - Le VRAI build (vite, garde de L32) : maintenant que la page monte la scène, three sort enfin dans un morceau PARESSEUX —
//   aucune entrée ne l'atteint statiquement, la licence est émise et la taille est consignée (M24). Aux vagues 0 et 1, le
//   journal disait « aucun morceau three » : ce contrôle-là ne pouvait pas exister avant ce train.
// - L30 × L31b × L29d (fluidité, D-3d-25, D-3d-28, MX-3D §9.1 et §9.3) : mouvement réduit → 2D sans jamais monter la scène,
//   refus ou perte du contexte → 2D, et dans les trois cas la clé du lecteur (cleZoom) ne bouge pas, donc la position du
//   différé survit (§5.8 l.1007).
// - L29c × L31b : une libération VOLONTAIRE du moteur (fermeture, changement de zoom) n'appelle JAMAIS onEchec, donc la page ne
//   bascule pas en 2D — joué avec le vrai moteur, rendu injecté et canevas EventTarget, y compris le cas dégradé où le retrait
//   de l'écouteur n'a aucun effet.
// - L34 × le modèle néon : les deux démonstrations se régénèrent à l'octet près sur le faux opencode, la démonstration p1 en
//   Simple montre au moins deux assistants, et DemoPlayer n'atteint ni API, ni proxy, ni fetch.
// - Constantes à garder (règles de train) : three@0.186.0 exact en devDependencies, chunkSizeWarningLimit jamais relevé.
// Aucun conteneur Docker, aucun vrai opencode, aucun appel facturé : tout se joue en Node.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { cleZoom, doitMonterScene3d, echec3d, type EtatSalle, etatInitial, peutRemettrePoignee } from "../web/pages/salle-controle/salle-etat.ts";
import type { Moteur, MoteurOptions } from "../web/pages/salle-controle/slots-3d.ts";
import {
  creerMoteur,
  EVENEMENT_PERTE,
  type FabriqueRendu,
  type MemoireRendu,
  type ParametresRendu,
  type RenduWebGL,
} from "../web/pages/salle-controle/three/moteur.ts";
import { type CapacitesPoste, verdictCapacites } from "./shared/fluidity.ts";
import { moments, type NeonSceneOptions, scene, visibleCount } from "./shared/neon-scene.ts";
import { messageFluidite, TEXTES as SALLE } from "./shared/salle3d-texts.ts";
import type { ActivityFact } from "./shared/activity-types.ts";
import type { Plan3d, Plan3dNode, Point3 } from "./shared/salle3d-types.ts";
import { nomsSimples, vueSimple } from "./shared/vue-simple.ts";
import { DEMO_P1_FILE } from "./test-support/gen-demo.ts";
import { type DemoIt3Cle, DEMOS_IT3, demoJson, fichierDemo, genererDemo } from "./test-support/gen-demos-it3.ts";

const APP_DIR = path.join(import.meta.dirname, "..");
const SALLE_DIR = path.join(APP_DIR, "web", "pages", "salle-controle");

const lire = (...segments: string[]): string => fs.readFileSync(path.join(...segments), "utf8");

/**
 * Source sans commentaires : un mot cité dans un commentaire n'est pas du code. Les commentaires de LIGNE sont retirés d'abord,
 * sinon un « /* » écrit dans une phrase ouvrirait un bloc qui avalerait le code jusqu'au commentaire suivant.
 */
const sansCommentaires = (source: string): string => source.replace(/^[ \t]*\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");

// --- L31b × L29d × L31c : montage par le seul contrat (slots-3d.ts) ------------------------------------------------------------

/** Propriétés déclarées par une interface de slots-3d.ts : nom → obligatoire ou facultative (`?`). */
function proprietesDuContrat(nom: string): Map<string, boolean> {
  const source = lire(SALLE_DIR, "slots-3d.ts");
  const debut = source.indexOf(`export interface ${nom} {`);
  assert.notEqual(debut, -1, `slots-3d.ts déclare ${nom}`);
  const fin = source.indexOf("\n}", debut);
  assert.ok(fin > debut, `l'interface ${nom} est fermée`);
  const corps = sansCommentaires(source.slice(debut, fin));
  const proprietes = new Map<string, boolean>();
  for (const ligne of corps.split("\n").slice(1)) {
    const trouvee = /^\s{2}([A-Za-z][A-Za-z0-9]*)(\??)\s*[(:]/.exec(ligne);
    if (trouvee !== null) proprietes.set(trouvee[1] as string, trouvee[2] === "");
  }
  assert.ok(proprietes.size > 0, `l'interface ${nom} a des propriétés`);
  return proprietes;
}

/**
 * Propriétés passées à une balise JSX auto-fermante, dans le source d'un composant. La balise est cherchée suivie d'une espace ou
 * d'une fermeture, sinon `<Scene3d` attraperait le type `<Scene3dHandle | null>` d'un useRef.
 */
function proprietesPassees(source: string, balise: string): Set<string> {
  const debut = source.search(new RegExp(`<${balise}(?=[\\s/>])`));
  assert.notEqual(debut, -1, `${balise} est monté`);
  const fin = source.indexOf("/>", debut);
  assert.ok(fin > debut, `la balise ${balise} est auto-fermante`);
  const passees = new Set<string>();
  for (const [, prop] of source.slice(debut, fin).matchAll(/([A-Za-z][A-Za-z0-9]*)=\{/g)) passees.add(prop as string);
  return passees;
}

/** Un montage à vérifier : le fichier consommateur, la balise montée et l'interface figée qui la décrit. */
const MONTAGES: ReadonlyArray<{ fichier: string; balise: string; contrat: string }> = [
  { fichier: "SalleControlePage.tsx", balise: "Scene3d", contrat: "Scene3dProps" },
  { fichier: "SalleControlePage.tsx", balise: "ZoomConversation", contrat: "ZoomConversationProps" },
  { fichier: "ZoomConversation.tsx", balise: "Scene3d", contrat: "Scene3dProps" },
];

describe("croisements 3D V2 : la page et le zoom montent la scène par le seul contrat", () => {
  for (const { fichier, balise, contrat } of MONTAGES) {
    it(`${fichier} monte <${balise}/> avec toutes les propriétés exigées par ${contrat} et aucune autre`, () => {
      const declarees = proprietesDuContrat(contrat);
      const passees = proprietesPassees(lire(SALLE_DIR, fichier), balise);
      const manquantes = [...declarees].filter(([prop, obligatoire]) => obligatoire && !passees.has(prop)).map(([prop]) => prop);
      assert.deepEqual(manquantes, [], `${fichier} passe toutes les propriétés obligatoires de ${contrat}`);
      // `key` est de React, pas du contrat : tout le reste doit être déclaré dans slots-3d.ts (aucune propriété inventée).
      const inconnues = [...passees].filter((prop) => prop !== "key" && !declarees.has(prop));
      assert.deepEqual(inconnues, [], `${fichier} n'invente aucune propriété hors de ${contrat}`);
    });
  }

  it("la clé de ZoomConversation est cleZoom(etat) : la position du lecteur survit au zoom et au repli 2D (§5.8 l.1007)", () => {
    const page = sansCommentaires(lire(SALLE_DIR, "SalleControlePage.tsx"));
    assert.match(page, /<ZoomConversation\s+key=\{cleZoom\(etat\)\}/, "la clé vient de salle-etat.ts, jamais du verdict ni du zoom");
  });
});

// --- L29d × L29c × L32 : une seule frontière vers three -------------------------------------------------------------------------

describe("croisements 3D V2 : Scene3d n'atteint le moteur que par moteur-chargeur.ts", () => {
  it("Scene3d importe chargerMoteur ; son seul lien vers ./three/ est un import de type", () => {
    const source = sansCommentaires(lire(SALLE_DIR, "Scene3d.tsx"));
    assert.match(source, /import \{ chargerMoteur \} from "\.\/moteur-chargeur\.ts";/);
    const versThree = [...source.matchAll(/^import( type)? .*from "\.\/three\/[^"]+";$/gm)];
    for (const [ligne, type] of versThree) assert.equal(type, " type", `Scene3d n'atteint ./three/ qu'en import de type : ${ligne}`);
    assert.doesNotMatch(source, /import\(\s*["'`]/, "aucun import dynamique dans Scene3d : la frontière est moteur-chargeur.ts");
  });

  it("moteur-chargeur.ts reste la seule frontière de salle-controle/** vers ./three/ (hors three/ et tests)", () => {
    const fichiers = fs
      .readdirSync(SALLE_DIR, { recursive: true, encoding: "utf8" })
      .filter((relatif) => /\.tsx?$/.test(relatif) && !relatif.replaceAll("\\", "/").startsWith("three/"));
    const frontieres = fichiers.filter((relatif) => /(^|[^t])import\(|from "\.\/three\//.test(sansCommentaires(lire(SALLE_DIR, relatif))));
    assert.deepEqual(
      frontieres.map((relatif) => relatif.replaceAll("\\", "/")).sort(),
      ["moteur-chargeur.ts"],
      "un seul fichier hors de three/ charge le moteur",
    );
  });
});

// --- Le vrai build : morceau three PARESSEUX, licence, taille (M24) --------------------------------------------------------------

interface BuildTrain {
  journal: string[];
  sortie: string;
  entree: string;
  morceauThree: string;
}

/** `vite build` réel, dans un dossier temporaire (le `dist/` de la copie n'est pas touché : d'autres tests le lisent). */
function construire(): BuildTrain {
  const sortie = fs.mkdtempSync(path.join(os.tmpdir(), "croisements-3d-v2-"));
  const journal = execFileSync(process.execPath, [path.join(APP_DIR, "node_modules", "vite", "bin", "vite.js"), "build", "--outDir", sortie, "--emptyOutDir"], {
    cwd: APP_DIR,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 300_000,
  }).split("\n");
  const html = fs.readFileSync(path.join(sortie, "index.html"), "utf8");
  const entree = /<script type="module"[^>]*src="\/assets\/([^"]+)"/.exec(html)?.[1] ?? "";
  assert.notEqual(entree, "", "index.html charge un morceau d'entrée");
  const ligneThree = journal.find((ligne) => ligne.startsWith("[three] "))?.trim() ?? "";
  return { journal, sortie, entree, morceauThree: ligneThree };
}

const BUILD: BuildTrain = construire();

describe("croisements 3D V2 : three sort en morceau paresseux (garde de L32, M24)", () => {
  it("le journal du build annonce un morceau three, et non plus « aucun morceau three »", () => {
    assert.match(BUILD.morceauThree, /^\[three\] assets\/[\w.-]+\.js : \d+ octets, \d+ octets gzip$/, `ligne [three] du build : ${BUILD.morceauThree}`);
    const gzip = Number(/(\d+) octets gzip/.exec(BUILD.morceauThree)?.[1]);
    // Seuil de signalement du plan (§3.2) : au-delà de 250 Ko gzip, le train doit le dire. Relevé consigné dans le rapport.
    assert.ok(gzip > 0 && gzip < 250 * 1024, `morceau three : ${gzip} octets gzip`);
  });

  it("aucune entrée n'atteint three statiquement : le morceau n'est chargé que par import()", () => {
    const morceau = /\[three\] assets\/([\w.-]+\.js)/.exec(BUILD.morceauThree)?.[1] as string;
    const entree = fs.readFileSync(path.join(BUILD.sortie, "assets", BUILD.entree), "utf8");
    const references = [...entree.matchAll(new RegExp(`.{0,12}${morceau.replaceAll(".", "\\.")}`, "g"))].map(([texte]) => texte);
    assert.ok(references.length > 0, "le morceau paresseux est bien référencé par l'entrée");
    for (const reference of references) assert.match(reference, /import\(\s*[`'"]\.?\//, `référence statique au morceau three : ${reference}`);
    const html = fs.readFileSync(path.join(BUILD.sortie, "index.html"), "utf8");
    assert.ok(!html.includes(morceau), "index.html ne précharge pas le morceau three");
    assert.ok(!entree.includes("WebGLRenderer"), "le morceau d'entrée ne contient pas three");
  });

  it("la licence de three est émise à côté du paquet", () => {
    const licence = fs.readFileSync(path.join(BUILD.sortie, "licences", "three-LICENSE.txt"), "utf8");
    assert.match(licence, /MIT License/i);
    assert.match(licence, /three\.js/i);
  });

  it("constantes à garder : three@0.186.0 exact en devDependencies, chunkSizeWarningLimit jamais relevé", () => {
    const paquet = JSON.parse(lire(APP_DIR, "package.json")) as { dependencies?: Record<string, string>; devDependencies: Record<string, string> };
    assert.equal(paquet.devDependencies.three, "0.186.0", "version exacte, jamais retirée ni changée (P8, exception de décision)");
    assert.equal(paquet.dependencies?.three, undefined, "three reste en devDependencies");
    const limite = Number(/chunkSizeWarningLimit:\s*(\d+)/.exec(lire(APP_DIR, "vite.config.ts"))?.[1]);
    assert.ok(limite <= 1500, `chunkSizeWarningLimit = ${limite} : jamais relevé pour masquer l'avertissement de taille`);
  });
});

// --- L30 × L31b × L29d : fluidité, repli 2D et position du lecteur ---------------------------------------------------------------

const CAPACITES: CapacitesPoste = Object.freeze({ mouvementReduit: false, couleursForcees: false, webgl2: true, contexteRefuse: false, moteur: "ANGLE", preference: "auto" });
const ROUTE = ["salle-controle", "ses_racine", "ses_enfant"] as const;

describe("croisements 3D V2 : fluidité, repli 2D et position du lecteur (D-3d-25, D-3d-28, MX-3D §9.1 et §9.3)", () => {
  it("mouvement réduit : verdict 2D, aucune scène montée (donc aucun WebGLRenderer), phrase dite", () => {
    const verdict = verdictCapacites({ ...CAPACITES, mouvementReduit: true });
    assert.deepEqual(verdict, { mode: "2d", raison: "accessibilite" });
    const etat = etatInitial(ROUTE, verdict);
    assert.equal(doitMonterScene3d(etat), false, "MX-3D §9.3 : pas de scène sans verdict 3D");
    assert.equal(peutRemettrePoignee(etat, true), false, "MX-3D §9.1 : pas de sonde sans scène");
    assert.deepEqual(etat.message, { genre: "fluidite", raison: "accessibilite" });
    assert.equal(messageFluidite("accessibilite"), SALLE.partout.fluidite.accessibilite);
    // Témoin : sur le même poste sans mouvement réduit, la scène est montée.
    assert.equal(doitMonterScene3d(etatInitial(ROUTE, verdictCapacites(CAPACITES))), true);
  });

  it("refus ou perte du contexte : repli en 2D SANS perdre la position du lecteur (la clé ne change pas)", () => {
    const depart = etatInitial(ROUTE, verdictCapacites(CAPACITES));
    assert.equal(doitMonterScene3d(depart), true);
    for (const raison of ["contexte-refuse", "contexte-perdu"] as const) {
      const { etat, action } = echec3d(depart, raison);
      assert.equal(etat.verdict.mode, "2d");
      assert.equal(action, null, "D-3d-25 : une bascule automatique n'écrit jamais la préférence du poste");
      assert.equal(cleZoom(etat), cleZoom(depart), "§5.8 l.1007 : ZoomConversation n'est pas remonté, le différé garde sa place");
      assert.equal(etat.rootId, depart.rootId);
      assert.equal(etat.sessionId, depart.sessionId, "le zoom 3 reste celui qu'on regardait");
    }
    assert.deepEqual(echec3d(depart, "contexte-perdu").etat.message, { genre: "contexte-perdu" });
  });
});

// --- L29c × L31b : une libération volontaire ne bascule jamais la page en 2D ------------------------------------------------------

const point = (x: number, y: number, z: number): Point3 => ({ x, y, z });

const NOEUD: Plan3dNode = Object.freeze({
  id: "n1",
  parentId: null,
  role: "conversation",
  secteur: null,
  position: point(0, 0.6, 0),
  etat: "termine",
  halo: "statique",
  nom: null,
  faits: [0],
});

const PLAN: Plan3d = Object.freeze({
  zoom: 2,
  theme: "sombre",
  mode: "avance",
  rootId: "ses_racine",
  focus: null,
  stations: [{ id: "vous" as const, position: point(0, 0.4, 6) }],
  territoires: [],
  noeuds: [NOEUD],
  faisceaux: [],
  marques: [],
  tuiles: [],
  etiquettes: [],
  camera: { cible: point(0, 0, 0), distance: 15, inclinaisonDeg: 55, fovDeg: 35 },
  anime: false,
  enceinte: null,
  carnetVide: true,
});

/** Canevas d'essai. `retrait: false` : `removeEventListener` ne fait rien — cas dégradé qui rend le drapeau `libere` obligatoire. */
function creerCanevas(retrait: boolean): { element: HTMLCanvasElement; perdreContexte: () => void } {
  const cible = new EventTarget();
  const element = {
    addEventListener: (type: string, ecouteur: EventListener) => cible.addEventListener(type, ecouteur),
    removeEventListener: (type: string, ecouteur: EventListener) => {
      if (retrait) cible.removeEventListener(type, ecouteur);
    },
  } as unknown as HTMLCanvasElement;
  return { element, perdreContexte: () => void cible.dispatchEvent(new Event(EVENEMENT_PERTE)) };
}

/** Rendu factice dont `forceContextLoss()` émet `webglcontextlost`, comme le vrai WEBGL_lose_context (D-3d-28). */
function creerRendu(perdreContexte: () => void): { fabrique: FabriqueRendu; journal: string[] } {
  const journal: string[] = [];
  let memoire: MemoireRendu = { geometries: 12, textures: 5 };
  const rendu: RenduWebGL = {
    setSize: () => void journal.push("setSize"),
    setPixelRatio: () => void journal.push("setPixelRatio"),
    setClearColor: () => void journal.push("setClearColor"),
    render: () => void journal.push("render"),
    get info() {
      journal.push("info");
      return { memory: memoire };
    },
    getContext: () => ({}),
    dispose() {
      journal.push("dispose");
      memoire = { geometries: 7, textures: 3 };
    },
    forceContextLoss() {
      journal.push("forceContextLoss");
      memoire = { geometries: 0, textures: 0 };
      perdreContexte();
    },
  } as RenduWebGL;
  return {
    fabrique: (parametres: ParametresRendu) => {
      assert.equal(parametres.failIfMajorPerformanceCaveat, true, "JP-12 : le contexte est demandé sans repli logiciel");
      journal.push("fabrique");
      return rendu;
    },
    journal,
  };
}

describe("croisements 3D V2 : la libération volontaire du moteur ne fait jamais basculer la page (D-3d-28)", () => {
  for (const retrait of [true, false]) {
    it(`liberer() n'appelle jamais onEchec (canevas ${retrait ? "ordinaire" : "dont le retrait d'écouteur reste sans effet"})`, () => {
      const canevas = creerCanevas(retrait);
      const { fabrique, journal } = creerRendu(canevas.perdreContexte);
      const echecs: string[] = [];
      const options: MoteurOptions = { theme: "sombre", mouvementReduit: false, onEchec: (raison) => void echecs.push(raison) };
      const moteur = creerMoteur(canevas.element, options, fabrique) as Moteur;
      assert.notEqual(moteur, null);
      moteur.afficher(PLAN);
      const avant = etatInitial(ROUTE, verdictCapacites(CAPACITES));

      moteur.liberer();

      assert.deepEqual(echecs, [], "une libération volontaire (fermeture, changement de zoom) n'annonce aucun échec");
      assert.deepEqual(
        journal.filter((appel) => appel === "dispose" || appel === "forceContextLoss"),
        ["dispose", "forceContextLoss"],
        "ordre de D-3d-28 : dispose avant forceContextLoss",
      );
      // La page n'a donc rien à appliquer : le verdict reste 3D et la clé du lecteur ne bouge pas.
      const apres: EtatSalle = avant;
      assert.equal(apres.verdict.mode, "3d");
      assert.equal(cleZoom(apres), cleZoom(avant));
      moteur.liberer();
      assert.deepEqual(echecs, [], "un second appel ne fait rien non plus");
    });
  }

  it("une perte de contexte NON demandée, elle, fait basculer la page en 2D une seule fois", () => {
    const canevas = creerCanevas(true);
    const { fabrique } = creerRendu(canevas.perdreContexte);
    const echecs: string[] = [];
    const moteur = creerMoteur(canevas.element, { theme: "sombre", mouvementReduit: false, onEchec: (raison) => void echecs.push(raison) }, fabrique) as Moteur;
    moteur.afficher(PLAN);

    canevas.perdreContexte();
    canevas.perdreContexte();

    assert.deepEqual(echecs, ["contexte-perdu"], "annoncée UNE fois (contrôle discriminant du drapeau `perdu`)");
    const etat = echec3d(etatInitial(ROUTE, verdictCapacites(CAPACITES)), "contexte-perdu").etat;
    assert.equal(etat.verdict.mode, "2d");
    assert.deepEqual(etat.message, { genre: "contexte-perdu" });
    moteur.liberer();
    assert.deepEqual(echecs, ["contexte-perdu"], "la libération qui suit n'ajoute rien");
  });
});

// --- L34 × le modèle néon : démonstrations enregistrées ---------------------------------------------------------------------------

const AVANCE: Readonly<NeonSceneOptions> = Object.freeze({ zoom: 2, mode: "avance" });
const faitsDuFichier = (fichier: string): ActivityFact[] => (JSON.parse(fs.readFileSync(fichier, "utf8")) as { faits: ActivityFact[] }).faits;

describe("croisements 3D V2 : démonstrations enregistrées (D-3d-20, D-3d-26)", () => {
  for (const cle of DEMOS_IT3) {
    it(`« ${cle} » se régénère à l'octet près sur le faux opencode (aucune IA, aucun appel facturé)`, async () => {
      assert.equal(demoJson(await genererDemo(cle as DemoIt3Cle)), fs.readFileSync(fichierDemo(cle as DemoIt3Cle), "utf8"));
    });
  }

  it("démonstration p1 en mode Simple : au moins deux assistants dessinés et un faisceau de consigne", () => {
    const faits = faitsDuFichier(DEMO_P1_FILE);
    let trouve = false;
    for (const t of moments(faits)) {
      const visibles = faits.slice(0, visibleCount(faits, t));
      const brute = scene(visibles, null, AVANCE);
      if (brute.noeuds.length < 2 || !brute.faisceaux.some((faisceau) => faisceau.kind === "consigne")) continue;
      trouve = true;
      const vue = vueSimple(brute, nomsSimples(brute, true));
      assert.equal(vue.mode, "simple");
      assert.ok(vue.noeuds.length >= 2, `vue Simple : ${vue.noeuds.length} assistants`);
      // Témoin : calculée en mode Simple, la même scène ne dessinerait qu'un assistant (D-3d-20).
      assert.equal(scene(visibles, null, { zoom: 2, mode: "simple" }).noeuds.length, 1);
      break;
    }
    assert.ok(trouve, "aucun moment de p1 ne montre deux assistants et une consigne");
  });

  it("DemoPlayer n'atteint ni API, ni proxy, ni fetch : une démonstration ne parle à personne", () => {
    const source = sansCommentaires(lire(APP_DIR, "web", "pages", "chat", "activity", "DemoPlayer.tsx"));
    for (const interdit of [/\bfetch\s*\(/, /from "[^"]*\/lib\/api(-[\w-]+)?\.ts"/, /\boc\./, /EventSource/, /import\(/]) {
      assert.doesNotMatch(source, interdit, `DemoPlayer.tsx contient ${interdit}`);
    }
  });
});
