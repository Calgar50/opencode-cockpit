// Tests L29d : étiquettes DOM de la salle de contrôle 3D (spécification §5.8 l.996-998, §5.5 l.923-924 ; plan d'exécution it3,
// fiche L29d, D-3d-19, D-3d-28). Sous Node, sans navigateur et sans three :
//  - ordre de tabulation = priorité du plan, puis rang du plan (jamais la position à l'écran) ;
//  - 60 étiquettes au plus, l'étiquette de la conversation toujours gardée, même arrivée en dernier dans le plan ;
//  - position écran → style (left, top) ; hors champ ou coordonnée illisible → masquée (visibility: hidden), donc hors du
//    parcours clavier ;
//  - nom accessible par libelleBouton, par le nom de la station, ou le nom seul ; aucun bouton sans nom accessible ;
//  - contraste du fond et du texte des étiquettes : au moins 4,5:1 dans les deux thèmes (§5.5 l.923).
// Plus, par lecture du source de Scene3d.tsx (le comportement du montage est joué en e2e par L35) : canevas aria-hidden,
// libération dans le nettoyage de l'effet du moteur, zoom dans ses dépendances (libération au changement de zoom), refus du
// contexte relayé, et AUCUNE bascule en 2D posée ici (D-3d-28). Chaque règle échoue sur un source muté.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import {
  ETIQUETTES_MAX,
  etiquettesAffichees,
  libelleEtiquette,
  ordonnerEtiquettes,
  styleEtiquette,
} from "../web/pages/salle-controle/etiquettes-3d.ts";
import { PLAN3D } from "./shared/neon-plan3d.ts";
import { contrastRatio, NEON_PALETTES, SEUIL_TEXTE, VISIONS } from "./shared/neon-palette.ts";
import type { NeonNodeState } from "./shared/neon-scene.ts";
import { libelleBouton, libelleStation } from "./shared/neon-texts.ts";
import { TEXTES as TEXTES_SALLE } from "./shared/salle3d-texts.ts";
import type { Plan3dLabel } from "./shared/salle3d-types.ts";
import { ETIQUETTES_MAX as ETIQUETTES_MAX_ZOOM1 } from "./shared/territoires.ts";

const SCENE3D = path.join(import.meta.dirname, "..", "web", "pages", "salle-controle", "Scene3d.tsx");

/** Priorités de D-3d-19 : la conversation, puis « travaille », puis l'attente de votre accord, puis les autres. */
const PRIORITE = { conversation: 0, travaille: 1, attente: 2, autre: 3 };

function etiquette(id: string, priorite: number, reste: Partial<Plan3dLabel> = {}): Plan3dLabel {
  return { id, cible: id, position: { x: 0, y: 0, z: 0 }, nom: id, etat: "travaille", priorite, ...reste };
}

const ids = (etiquettes: readonly Plan3dLabel[]) => etiquettes.map((e) => e.id);

// --- Ordre de tabulation (D-3d-19) ------------------------------------------------------------------------------------------

describe("étiquettes 3D : ordre de tabulation", () => {
  it("priorité du plan croissante ; à priorité égale, le rang donné par le plan", () => {
    const plan = [
      etiquette("d", PRIORITE.autre),
      etiquette("b", PRIORITE.travaille),
      etiquette("c", PRIORITE.attente),
      etiquette("b2", PRIORITE.travaille),
      etiquette("a", PRIORITE.conversation),
      etiquette("d2", PRIORITE.autre),
    ];
    assert.deepEqual(ids(ordonnerEtiquettes(plan)), ["a", "b", "b2", "c", "d", "d2"]);
  });

  it("la position à l'écran ne change rien : le parcours clavier reste stable pendant que la caméra tourne", () => {
    const loin = etiquette("loin", PRIORITE.travaille, { position: { x: 900, y: 0, z: 900 } });
    const pres = etiquette("pres", PRIORITE.autre, { position: { x: 0, y: 0, z: 0 } });
    assert.deepEqual(ids(ordonnerEtiquettes([pres, loin])), ["loin", "pres"]);
    assert.deepEqual(ids(ordonnerEtiquettes([loin, pres])), ["loin", "pres"]);
  });

  it("DISCRIMINANT : sans le tri, l'ordre du plan mal rangé passerait tel quel", () => {
    const plan = [etiquette("autre", PRIORITE.autre), etiquette("conversation", PRIORITE.conversation)];
    assert.notDeepEqual(ids(ordonnerEtiquettes(plan)), ids(plan));
  });

  it("l'ordre est total et refait à l'identique : deux appels rendent la même suite", () => {
    const plan = Array.from({ length: 30 }, (_, rang) => etiquette(`n${rang}`, rang % 4));
    assert.deepEqual(ids(ordonnerEtiquettes(plan)), ids(ordonnerEtiquettes([...plan])));
  });
});

// --- Borne de 60 (D-3d-19) --------------------------------------------------------------------------------------------------

describe("étiquettes 3D : 60 au plus", () => {
  it("la borne est celle du plan 3D, et celle du zoom 1 : une seule valeur, jamais un second nombre écrit", () => {
    assert.equal(ETIQUETTES_MAX, 60);
    assert.equal(ETIQUETTES_MAX, PLAN3D.etiquettesMax);
    assert.equal(ETIQUETTES_MAX, ETIQUETTES_MAX_ZOOM1);
  });

  it("200 étiquettes → 60, l'étiquette de la conversation gardée même arrivée en dernier", () => {
    const foule = Array.from({ length: 199 }, (_, rang) => etiquette(`autre${rang}`, PRIORITE.autre));
    const rendues = ordonnerEtiquettes([...foule, etiquette("conversation", PRIORITE.conversation)]);
    assert.equal(rendues.length, ETIQUETTES_MAX);
    assert.deepEqual(ids(rendues)[0], "conversation");
    assert.deepEqual(ids(rendues).slice(1), foule.slice(0, ETIQUETTES_MAX - 1).map((e) => e.id));
  });

  it("les priorités hautes passent avant : 60 « travaille » devant une foule d'« autres » placée en tête", () => {
    const autres = Array.from({ length: 100 }, (_, rang) => etiquette(`autre${rang}`, PRIORITE.autre));
    const travaillent = Array.from({ length: 60 }, (_, rang) => etiquette(`travaille${rang}`, PRIORITE.travaille));
    const rendues = ordonnerEtiquettes([...autres, ...travaillent]);
    assert.equal(rendues.length, ETIQUETTES_MAX);
    assert.deepEqual(ids(rendues), travaillent.map((e) => e.id));
  });

  it("moins de 60 : tout passe ; aucune étiquette inventée", () => {
    const plan = [etiquette("a", PRIORITE.conversation), etiquette("b", PRIORITE.autre)];
    assert.deepEqual(ids(ordonnerEtiquettes(plan)), ["a", "b"]);
    assert.deepEqual(ordonnerEtiquettes([]), []);
  });

  it("DISCRIMINANT : sans la borne, 200 étiquettes poseraient 200 boutons focalisables", () => {
    const foule = Array.from({ length: 200 }, (_, rang) => etiquette(`n${rang}`, PRIORITE.autre));
    assert.ok(ordonnerEtiquettes(foule).length < foule.length);
  });
});

// --- Position écran → style -------------------------------------------------------------------------------------------------

describe("étiquettes 3D : position écran → style", () => {
  it("left et top en pixels, arrondis au pixel ; étiquette visible", () => {
    assert.deepEqual(styleEtiquette({ x: 120.4, y: 33.6, visible: true }), { left: "120px", top: "34px", visibility: "visible" });
    assert.deepEqual(styleEtiquette({ x: 0, y: 0, visible: true }), { left: "0px", top: "0px", visibility: "visible" });
    assert.deepEqual(styleEtiquette({ x: -12.5, y: -0.6, visible: true }), { left: "-12px", top: "-1px", visibility: "visible" });
  });

  it("hors champ (visible faux) → masquée, donc hors du parcours clavier, et posée en haut à gauche", () => {
    assert.deepEqual(styleEtiquette({ x: 900, y: 40, visible: false }), { left: "0px", top: "0px", visibility: "hidden" });
  });

  it("coordonnée illisible (NaN, ±Infinity : canevas de taille nulle, caméra dégénérée) → masquée", () => {
    for (const illisible of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      assert.deepEqual(styleEtiquette({ x: illisible, y: 10, visible: true }), { left: "0px", top: "0px", visibility: "hidden" }, `x = ${illisible}`);
      assert.deepEqual(styleEtiquette({ x: 10, y: illisible, visible: true }), { left: "0px", top: "0px", visibility: "hidden" }, `y = ${illisible}`);
    }
  });

  it("DISCRIMINANT : sans le masquage, une étiquette derrière la caméra resterait visible et focalisable", () => {
    assert.notEqual(styleEtiquette({ x: 10, y: 10, visible: false }).visibility, styleEtiquette({ x: 10, y: 10, visible: true }).visibility);
  });
});

// --- Noms accessibles -------------------------------------------------------------------------------------------------------

describe("étiquettes 3D : nom accessible", () => {
  it("un nœud ou un territoire avec état : « {nom}, {état} » par libelleBouton", () => {
    for (const etat of ["travaille", "attente-accord", "termine"] satisfies NeonNodeState[]) {
      assert.equal(libelleEtiquette(etiquette("n", PRIORITE.autre, { nom: "Sisyphus", etat })), libelleBouton("Sisyphus", etat));
    }
    assert.equal(libelleEtiquette(etiquette("n", PRIORITE.conversation, { nom: null, etat: "travaille" })), libelleBouton(null, "travaille"));
  });

  it("une station : son nom ; « Cockpit – contrôle » pour la station de contrôle du zoom 1", () => {
    for (const station of ["vous", "copilot", "carnet"] as const) {
      assert.equal(libelleEtiquette({ id: `station:${station}`, cible: station, position: { x: 0, y: 0, z: 0 }, nom: null, etat: null, priorite: 0 }), libelleStation(station));
    }
    assert.equal(
      libelleEtiquette({ id: "station:controle", cible: "controle", position: { x: 0, y: 0, z: 0 }, nom: null, etat: null, priorite: 0 }),
      TEXTES_SALLE.partout.stationControle,
    );
  });

  it("un territoire sans état montré (enceinte en mode Simple, D-3d-14) : son nom seul", () => {
    assert.equal(libelleEtiquette(etiquette("territoire:salle", PRIORITE.autre, { cible: "salle", nom: "cockpit", etat: null })), "cockpit");
  });

  it("aucun nom connu : aucun bouton posé (la liste de la page reste la vérité), les autres restent dans l'ordre", () => {
    const sansNom = etiquette("muet", PRIORITE.conversation, { cible: "muet", nom: null, etat: null });
    assert.equal(libelleEtiquette(sansNom), null);
    const affichees = etiquettesAffichees([sansNom, etiquette("n", PRIORITE.autre, { nom: "Atlas" })]);
    assert.deepEqual(
      affichees.map((e) => [e.id, e.cible, e.libelle]),
      [["n", "n", libelleBouton("Atlas", "travaille")]],
    );
  });

  it("les étiquettes à poser suivent l'ordre de tabulation et la borne de 60", () => {
    const plan = [etiquette("autre", PRIORITE.autre), etiquette("conversation", PRIORITE.conversation)];
    assert.deepEqual(
      etiquettesAffichees(plan).map((e) => e.id),
      ["conversation", "autre"],
    );
    assert.equal(etiquettesAffichees(Array.from({ length: 120 }, (_, rang) => etiquette(`n${rang}`, PRIORITE.autre))).length, ETIQUETTES_MAX);
  });
});

// --- Contraste (§5.5 l.923) -------------------------------------------------------------------------------------------------

describe("étiquettes 3D : contraste du fond opaque et du texte", () => {
  it("au moins 4,5:1 dans les deux thèmes, en vision normale et en déficience de vision des couleurs", () => {
    for (const theme of ["sombre", "clair"] as const) {
      const { fond, texte: couleurDuTexte } = NEON_PALETTES[theme];
      for (const vision of VISIONS) {
        assert.ok(contrastRatio(fond, couleurDuTexte, vision) >= SEUIL_TEXTE, `${theme} / ${vision} : ${contrastRatio(fond, couleurDuTexte, vision).toFixed(2)}`);
      }
    }
  });
});

// --- Scene3d.tsx : gardes lues dans le source -------------------------------------------------------------------------------

/** Source sans ses commentaires (les chaînes restent entières). */
function sansCommentaires(texte: string): string {
  let sortie = "";
  let i = 0;
  while (i < texte.length) {
    const c = texte[i] ?? "";
    const suivant = texte[i + 1];
    if (c === "/" && (suivant === "/" || suivant === "*")) {
      const fin = suivant === "/" ? texte.indexOf("\n", i) : texte.indexOf("*/", i + 2);
      i = fin === -1 ? texte.length : suivant === "/" ? fin : fin + 2;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") {
      let j = i + 1;
      while (j < texte.length && texte[j] !== c) j += texte[j] === "\\" ? 2 : 1;
      const fin = Math.min(j + 1, texte.length);
      sortie += texte.slice(i, fin);
      i = fin;
      continue;
    }
    sortie += c;
    i += 1;
  }
  return sortie;
}

/** Corps de chaque fonction de nettoyage d'effet (« return () => { … } »), accolades appariées. */
function nettoyages(code: string): string[] {
  const corps: string[] = [];
  for (const depart of code.matchAll(/return\s*\(\s*\)\s*=>\s*\{/g)) {
    let profondeur = 1;
    let i = (depart.index ?? 0) + depart[0].length;
    const debut = i;
    while (i < code.length && profondeur > 0) {
      if (code[i] === "{") profondeur += 1;
      else if (code[i] === "}") profondeur -= 1;
      i += 1;
    }
    corps.push(code.slice(debut, i - 1));
  }
  return corps;
}

/** Règles manquantes dans le source de Scene3d.tsx. */
function manques(texte: string): string[] {
  const code = sansCommentaires(texte);
  const absents: string[] = [];
  if (!/<canvas\b[^>]*aria-hidden="true"/.test(code)) absents.push("canevas aria-hidden");
  if (!nettoyages(code).some((corps) => /\bliberer\(\)/.test(corps))) absents.push("libération dans le nettoyage de l'effet du moteur (D-3d-28)");
  if (!/\[\s*zoom\s*,/.test(code)) absents.push("zoom dans les dépendances de l'effet du moteur (libération au changement de zoom)");
  if (!/onEchec\(\s*"contexte-refuse"\s*\)/.test(code)) absents.push("refus du contexte relayé");
  if (/salle3d:bascule|passer2d/.test(code)) absents.push("bascule en 2D posée par la scène (D-3d-28 : une libération volontaire n'en produit jamais)");
  return absents;
}

describe("Scene3d : gardes lues dans le source", () => {
  const source = fs.readFileSync(SCENE3D, "utf8");

  it("canevas aria-hidden, libération au nettoyage, zoom dans les dépendances, refus relayé, aucune bascule posée ici", () => {
    assert.deepEqual(manques(source), []);
  });

  it("DISCRIMINANT : chaque garde manque sur un source muté", () => {
    const mutations: ReadonlyArray<readonly [string, string]> = [
      ["canevas aria-hidden", source.replace(' aria-hidden="true"', "")],
      ["libération dans le nettoyage de l'effet du moteur (D-3d-28)", source.replaceAll("moteur?.liberer();", "")],
      ["zoom dans les dépendances de l'effet du moteur (libération au changement de zoom)", source.replace("[zoom, theme,", "[theme,")],
      ["refus du contexte relayé", source.replaceAll('onEchec("contexte-refuse")', "onEchec(raisonInconnue)")],
      ["bascule en 2D posée par la scène (D-3d-28 : une libération volontaire n'en produit jamais)", `${source}\nconst mauvais = "salle3d:bascule";\n`],
    ];
    for (const [regle, mute] of mutations) {
      assert.notEqual(mute, source, regle);
      assert.deepEqual(manques(mute), [regle], regle);
    }
  });

  it("le lecteur de nettoyages suit les accolades appariées ; les commentaires ne valent pas garde", () => {
    assert.deepEqual(nettoyages("useEffect(() => { return () => { if (a) { b(); } liberer(); }; });"), [" if (a) { b(); } liberer(); "]);
    assert.ok(manques('// <canvas aria-hidden="true" />\nuseEffect(() => { return () => { moteur?.liberer(); }; }, [zoom, theme]);').includes("canevas aria-hidden"));
  });
});
