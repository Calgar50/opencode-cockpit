// Tests de croisement du train 5b V4 (plan d'exécution it5 §2.4, §5.3 ; propriété de l'intégrateur) : L50b (e2e de la 5b et
// captures des vues d'équipe) et DOC5 (documentation de l'itération 5), réunis sur la branche de la construction.
//
// Les deux paquets ont été écrits EN MÊME TEMPS, sans se voir, sur la tête du train de V3. Le croisement de la vague, au §5.3,
// est la passe du banc `run-e2e.sh --faux --scenarios c5 --project-prefix c511-e2e --image-tag c511` : elle se joue sous Docker,
// hors de `npm test`, et son résultat est consigné dans le commit du train. Ce fichier tient, lui, ce qui se vérifie sans banc
// et qui a manqué au train de V3 :
//   1. CORRECTION DU TRAIN : chaque état de lancement et d'étape que l'itération 4 et la 5b enregistrent a son libellé dans la
//      table des Coûts et des Archives (`TeamCosts.tsx`, L46b) — la passe du banc de L50b a trouvé « non-choisi » écrit tel quel
//      dans la section « Équipes lancées dans cette conversation » des Archives, alors que le Déroulé disait « Non choisi » ;
//   2. les scénarios de la famille `c5` suivent les adresses du VRAI routeur : toute attente de la bibliothèque des méthodes
//      passe par une adresse que `parseRoute` range dans l'onglet « Méthodes », où L44f l'a déplacée au train de V3 (les deux
//      scénarios de la 5a qui attendaient encore `#/assistants` tombaient au banc) ; chaque scénario `c5*` est décrit dans
//      `e2e/README.md` et chaque ligne de la table nomme un scénario présent ;
// et la grille propre de la vague (§5.3) :
//   3. chaque ligne d'honnêteté du §13.2 que la fiche confie au banc (L50a, L50b) est lue À L'OCTET par son scénario : la
//      phrase écrite en clair dans le scénario est exactement celle des modules de textes ;
//   4. `EQUIPES_SIMPLE_OUVERTES` vaut false dans la branche, n'a aucune sœur, et l'ouverture documentée (e2e/README.md de
//      L50b, RECAPITULATIF de DOC5) tient en UNE ligne du code réel ;
//   5. les six recettes réelles du §3.2 sont consignées « en attente » par DOC5, aucune n'est dite faite.
//
// Aucune exécution facturée, aucun appel à un fournisseur, aucun réseau : ce fichier ne lit que le dépôt.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import { TEXTES as C5, ecartTours } from "./shared/construction-texts.ts";
import { TEXTES as DELEGATION } from "./shared/delegation-texts.ts";
import { TEAM_RUN_TRANSITIONS, TEAM_STEP_TRANSITIONS } from "./shared/team-limits.ts";
import { TEXTES as EQ } from "./shared/team-texts.ts";
import { EQUIPES_SIMPLE_OUVERTES } from "./wiring-eq.ts";
import { assistantsTabOf, assistantsViewOf, parseRoute, parseRouteQuery } from "../web/lib/router.ts";

const DEPOT = path.resolve(import.meta.dirname, "..", "..");
const lire = (relatif: string): string => fs.readFileSync(path.join(DEPOT, relatif), "utf8");
const lignesDe = (texte: string): string[] => texte.split(/\r?\n/);

/** Contenu d'une section Markdown balisée `<!-- c5:nom -->` … `<!-- /c5:nom -->` (une seule par nom, §2.6). */
function sectionMarkdown(texte: string, nom: string): string {
  const debut = texte.indexOf(`<!-- c5:${nom} -->`);
  const fin = texte.indexOf(`<!-- /c5:${nom} -->`);
  assert.ok(debut >= 0 && fin > debut, `section c5:${nom} introuvable ou mal fermée`);
  return texte.slice(debut, fin);
}

// --- 1. Libellés d'état des Coûts et des Archives (correction du train) ----------------------------------------------------

const TEAM_COSTS = "app/web/pages/costs/TeamCosts.tsx";

/**
 * Table ETATS de `TeamCosts.tsx`, lue dans la SOURCE (un .tsx ne se charge pas dans `node --test`) : pour chaque code, le
 * libellé écrit en clair, ou celui que la ligne reprend de `team-texts.ts` par `TEAM_TEXTES.partout.<table>["<code>"]`.
 */
function etatsDesCouts(): Map<string, string> {
  const source = lire(TEAM_COSTS);
  const bloc = /const ETATS: Record<string, \{ libelle: string; tone: Tone \}> = \{\r?\n([\s\S]*?)\r?\n\};/.exec(source);
  assert.ok(bloc?.[1], "table ETATS introuvable dans TeamCosts.tsx");
  const etats = new Map<string, string>();
  for (const ligne of lignesDe(bloc[1])) {
    const entree = /^\s*(?:"([a-z-]+)"|([a-z]+)):\s*\{\s*libelle:\s*(.+?),\s*tone:/.exec(ligne);
    if (!entree) continue;
    const code = entree[1] ?? entree[2] ?? "";
    const valeur = entree[3] ?? "";
    const litteral = /^"([^"]*)"$/.exec(valeur);
    const repris = /^TEAM_TEXTES\.partout\.(etatsEtape|etatsEquipe)\["([a-z-]+)"\]$/.exec(valeur);
    let libelle: string | undefined;
    if (litteral) libelle = litteral[1];
    else if (repris) libelle = (EQ.partout[repris[1] as "etatsEtape" | "etatsEquipe"] as Record<string, string>)[repris[2] ?? ""];
    assert.ok(libelle !== undefined, `libellé de « ${code} » illisible dans TeamCosts.tsx : ${valeur}`);
    etats.set(code, libelle);
  }
  return etats;
}

describe("croisement V4 : chaque état d'équipe a son libellé dans les Coûts et les Archives (correction du train)", () => {
  it("chaque état de lancement et d'étape enregistré par l'it4 et la 5b a un libellé, jamais son code brut", () => {
    const etats = etatsDesCouts();
    const lancements = Object.keys(TEAM_RUN_TRANSITIONS);
    const etapes = Object.keys(TEAM_STEP_TRANSITIONS);
    // Les deux listes sont celles de team-types.ts (TeamRunState, TeamStepState), tenues exhaustives par le typage des tables de
    // transitions : un état ajouté sans transition ne compile pas.
    assert.ok(lancements.includes("attente-choix") && etapes.includes("non-choisi"), "états de la 5b absents des transitions");
    const manquants = [...new Set([...lancements, ...etapes])].filter((code) => !etats.has(code));
    assert.deepEqual(manquants, [], `états rendus TELS QUELS dans les Archives (« … · ${manquants[0] ?? ""} · … »)`);
    for (const [code, libelle] of etats) {
      assert.notEqual(libelle.trim(), "", `libellé vide pour « ${code} »`);
      assert.notEqual(libelle, code, `« ${code} » est affiché comme son propre code`);
    }
  });

  it("« Non choisi » : le même mot dans la section des Archives, le Déroulé d'équipe et les textes de la construction", () => {
    const etats = etatsDesCouts();
    assert.equal(C5.partout.execution.etat.nonChoisi, "Non choisi");
    assert.equal(EQ.partout.etatsEtape["non-choisi"], C5.partout.execution.etat.nonChoisi);
    assert.equal(etats.get("non-choisi"), C5.partout.execution.etat.nonChoisi);
    // Les autres états ajoutés par le train reprennent le mot de l'itération 4, jamais une réécriture locale.
    for (const code of ["en-file", "attente-accord", "non-lancee"] as const) assert.equal(etats.get(code), EQ.partout.etatsEtape[code], code);
    assert.equal(etats.get("attente-modification"), EQ.partout.etatsEquipe["attente-modification"]);
  });
});

// --- 2. Scénarios `c5` : adresses du vrai routeur, et table d'e2e/README.md ------------------------------------------------

const SCENARIOS = "e2e/scenarios";
const scenarios = (): string[] => fs.readdirSync(path.join(DEPOT, SCENARIOS)).filter((nom) => nom.endsWith(".mjs")).sort();

describe("croisement V4 : les scénarios c5 suivent le vrai routeur et sont tous décrits", () => {
  it("toute attente de la bibliothèque des méthodes passe par une adresse que le routeur range dans l'onglet « Méthodes »", () => {
    const attentes: Array<{ ou: string; adresse: string | null }> = [];
    for (const nom of scenarios()) {
      const lignes = lignesDe(lire(`${SCENARIOS}/${nom}`));
      lignes.forEach((ligne, i) => {
        if (!ligne.includes("met-library") || !/\b(?:attendreQue|allerA)\(/.test(ligne)) return;
        // L'adresse visitée juste avant l'attente : sur la même ligne (allerA) ou quelques lignes au-dessus (location.hash).
        let adresse: string | null = null;
        for (let j = i; j >= Math.max(0, i - 4) && adresse === null; j--) {
          const trouvees = [...(lignes[j] ?? "").matchAll(/#\/assistants[^"'`\s)]*/g)];
          adresse = trouvees.at(-1)?.[0] ?? null;
        }
        attentes.push({ ou: `${nom}:${i + 1}`, adresse });
      });
    }
    // c5a-a11y, c5a-methodes (5a) ; c5b-a11y, c5b-couts-archives (5b) : au moins ces quatre attentes.
    assert.ok(attentes.length >= 4, `attentes de la bibliothèque trouvées : ${JSON.stringify(attentes)}`);
    for (const { ou, adresse } of attentes) {
      assert.ok(adresse !== null, `${ou} : aucune adresse visitée avant d'attendre la bibliothèque`);
      const onglet = assistantsTabOf(assistantsViewOf(parseRoute(adresse), parseRouteQuery(adresse)));
      assert.equal(onglet, "methodes", `${ou} : « ${adresse} » ouvre l'onglet « ${onglet} », où la bibliothèque n'est plus (L44f)`);
    }
  });

  it("la famille c5 : cinq scénarios de la 5a, sept de la 5b, chacun décrit dans e2e/README.md, et rien de plus", () => {
    const famille = scenarios().filter((nom) => nom.startsWith("c5"));
    assert.deepEqual(
      famille,
      [
        "c5a-a11y.mjs",
        "c5a-chronologie.mjs",
        "c5a-mc5-reel.mjs",
        "c5a-methodes.mjs",
        "c5a-seconde-lecture.mjs",
        "c5b-a11y.mjs",
        "c5b-aiguillage.mjs",
        "c5b-couts-archives.mjs",
        "c5b-demonstration.mjs",
        "c5b-relecture.mjs",
        "c5b-schema.mjs",
        "c5b-vue-ensemble.mjs",
      ],
    );
    const table = sectionMarkdown(lire("e2e/README.md"), "scenarios");
    const decrits = [...table.matchAll(/^\| `(c5[ab]-[a-z0-9-]+\.mjs)` \|/gm)].map((m) => m[1] ?? "").sort();
    assert.deepEqual(decrits, famille, "table des scénarios de la construction d'e2e/README.md");
    for (const nom of famille) assert.match(lire(`${SCENARIOS}/${nom}`), /export async function run\(ctx\)/, nom);
  });
});

// --- 3. Grille V4 : lignes d'honnêteté du §13.2 lues à l'octet par leur scénario ------------------------------------------

/** Phrase écrite en clair par un scénario, dans son objet `PHRASES` (convention des scénarios `c5*`). */
function phraseDuScenario(nom: string, cle: string): string {
  const source = lire(`${SCENARIOS}/${nom}`);
  const bloc = /^const PHRASES = \{\r?\n([\s\S]*?)\r?\n\};/m.exec(source);
  assert.ok(bloc?.[1], `${nom} : objet PHRASES introuvable`);
  const entree = new RegExp(`^\\s*${cle}:\\s*"((?:[^"\\\\]|\\\\.)*)",?\\s*$`, "m").exec(bloc[1]);
  assert.ok(entree?.[1] !== undefined, `${nom} : phrase « ${cle} » introuvable dans PHRASES`);
  return JSON.parse(`"${entree[1]}"`) as string;
}

/** Toutes les chaînes d'un module de textes (recherche d'une phrase quel que soit son chemin). */
function chaines(valeur: unknown, acc: string[] = []): string[] {
  if (typeof valeur === "string") acc.push(valeur);
  else if (valeur && typeof valeur === "object") for (const v of Object.values(valeur)) chaines(v, acc);
  return acc;
}

describe("grille V4 : chaque ligne d'honnêteté du §13.2 confiée au banc est lue à l'octet par son scénario", () => {
  // Ligne du §13.2 → scénario qui la lit (colonne « Test » : L50a, L50b) → phrase attendue, tirée des modules de textes.
  const LECTURES = [
    { ligne: "« Prévu : jusqu'à 2 tours · Réel : 1 tour »", scenario: "c5b-couts-archives.mjs", cle: "ecartTours", attendu: ecartTours(2, 1) },
    { ligne: "« Non choisi »", scenario: "c5b-couts-archives.mjs", cle: "nonChoisi", attendu: C5.partout.execution.etat.nonChoisi },
    { ligne: "refus du schéma", scenario: "c5b-schema.mjs", cle: "versLeBas", attendu: C5.avance.schema.refus.versLeBas },
    { ligne: "démonstration enregistrée", scenario: "c5b-demonstration.mjs", cle: "fictives", attendu: C5.partout.demonstration.phrase },
    { ligne: "« Méthode appliquée »", scenario: "c5a-methodes.mjs", cle: "appliquee", attendu: C5.partout.methodes.detection.appliquee },
    { ligne: "« … non détectée dans la réponse »", scenario: "c5a-methodes.mjs", cle: "absente", attendu: C5.partout.methodes.detection.absente },
    { ligne: "pied de la Seconde lecture", scenario: "c5a-seconde-lecture.mjs", cle: "pied", attendu: C5.partout.secondeLecture.pied },
  ] as const;

  for (const { ligne, scenario, cle, attendu } of LECTURES) {
    it(`${ligne} : ${scenario} lit « ${attendu} »`, () => {
      assert.equal(phraseDuScenario(scenario, cle), attendu);
    });
  }

  it("« Il voit toute la conversation : le coût dépend de sa longueur. » : fin de l'infobulle lue par c5a-seconde-lecture", () => {
    const fin = phraseDuScenario("c5a-seconde-lecture.mjs", "infobulleFin");
    assert.ok(fin.endsWith("Il voit toute la conversation : le coût dépend de sa longueur."), fin);
    assert.ok(C5.partout.secondeLecture.infobulle.endsWith(fin), `infobulle des textes : ${C5.partout.secondeLecture.infobulle}`);
  });

  it("équipes fermées en Simple : c5b-demonstration lit la phrase de l'it4 et l'avis court de délégation", () => {
    assert.ok(chaines(EQ).includes(phraseDuScenario("c5b-demonstration.mjs", "fermees")), "phrase de fermeture absente de team-texts.ts");
    assert.equal(phraseDuScenario("c5b-demonstration.mjs", "avisCourt"), DELEGATION.simple.avis);
    assert.equal(DELEGATION.simple.avisEquipes, `${DELEGATION.simple.avis} ${phraseDuScenario("c5b-demonstration.mjs", "avisComplet")}`);
  });
});

// --- 4. Grille V4 : équipes fermées en Simple, ouverture en une ligne (U1, D-5-24) -----------------------------------------

/** Sources de production du cockpit (tests exclus). */
function sourcesDeProduction(dossier: string, acc: string[] = []): string[] {
  for (const entree of fs.readdirSync(path.join(DEPOT, dossier), { withFileTypes: true })) {
    const relatif = `${dossier}/${entree.name}`;
    if (entree.isDirectory()) {
      if (entree.name !== "node_modules" && entree.name !== "test-support") sourcesDeProduction(relatif, acc);
    } else if (/\.tsx?$/.test(entree.name) && !entree.name.endsWith(".test.ts")) acc.push(relatif);
  }
  return acc;
}

describe("grille V4 : équipes fermées en Simple, ouverture en une ligne (U1, D-5-24)", () => {
  it("EQUIPES_SIMPLE_OUVERTES vaut false dans la branche, et aucune fiche n'a posé de constante sœur", () => {
    assert.equal(EQUIPES_SIMPLE_OUVERTES, false);
    const declarations: string[] = [];
    for (const fichier of [...sourcesDeProduction("app/server"), ...sourcesDeProduction("app/web")]) {
      for (const ligne of lignesDe(lire(fichier))) {
        if (/\b(?:const|let|var)\s+\w*SIMPLE_OUVERT\w*/i.test(ligne)) declarations.push(`${fichier} : ${ligne.trim()}`);
      }
    }
    assert.deepEqual(declarations, ["app/server/wiring-eq.ts : export const EQUIPES_SIMPLE_OUVERTES = false;"]);
  });

  it("la bascule documentée par L50b (e2e/README.md) touche exactement une ligne du code réel, celle que nomme DOC5", () => {
    const readme = sectionMarkdown(lire("e2e/README.md"), "scenarios");
    const sed = /sed -i 's\/(\^[^/]+\$)\/([^/]+)\/' (app\/server\/wiring-eq\.ts)/.exec(readme);
    assert.ok(sed?.[1] && sed[2] && sed[3], "commande de bascule introuvable dans e2e/README.md");
    const motif = new RegExp(sed[1]);
    const lignes = lignesDe(lire(sed[3]));
    const touchees = lignes.map((ligne, i) => ({ ligne, i })).filter(({ ligne }) => motif.test(ligne));
    assert.equal(touchees.length, 1, `lignes que la bascule toucherait : ${JSON.stringify(touchees)}`);
    const apres = lignes.map((ligne) => (motif.test(ligne) ? sed[2] : ligne));
    assert.equal(apres.filter((ligne, i) => ligne !== lignes[i]).length, 1);
    assert.equal(sed[2], "export const EQUIPES_SIMPLE_OUVERTES = true;");

    // DOC5 : la procédure d'ouverture du RECAPITULATIF nomme la même constante dans le même fichier, « seule ligne à changer ».
    const etapes = sectionMarkdown(lire("docs/RECAPITULATIF.md"), "etapes");
    assert.match(etapes, /`EQUIPES_SIMPLE_OUVERTES` de `app\/server\/wiring-eq\.ts`/);
    assert.match(etapes, /C'est la seule ligne du code à changer/);
  });
});

// --- 5. Grille V4 : recettes en attente consignées (§3.2) ------------------------------------------------------------------

describe("grille V4 : les recettes réelles du §3.2 sont consignées « en attente » par DOC5", () => {
  it("M7, RM Q1, C §17.5 n° 1 et n° 2, M13, spéc. §7.11 n° 4 : chacune sur sa ligne, « en attente », aucune dite faite", () => {
    const limites = sectionMarkdown(lire("docs/RECAPITULATIF.md"), "limites");
    const recettes = ["recette M7", "recette RM Q1", "§17.5 n° 1", "§17.5 n° 2", "recette M13", "§7.11 n° 4"];
    const lignes = lignesDe(limites);
    for (const recette of recettes) {
      const ligne = lignes.find((l) => l.includes(recette));
      assert.ok(ligne, `recette « ${recette} » absente de la section c5:limites`);
      assert.match(ligne, /\*\*en attente\*\*/, recette);
    }
    assert.match(limites, /aucune de ces recettes n'est présentée comme faite/);
    assert.match(limites, /bloquent la publication de la 1\.1\*\*, \*\*pas\*\* l'itération/);
  });
});
