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
//   5. les six recettes réelles du §3.2 sont consignées « en attente » par DOC5, aucune n'est dite faite ;
// et les corrections de la relecture de la vague (5b-vague-4) :
//   6. la section « Démonstration d'équipe » du README ne cite que des libellés qu'un écran LIT (pas seulement définis) et
//      dit ce que fait le mouvement réduit ; la ligne « Contrôle de mutation » du RECAPITULATIF compte le train de V4 ; les
//      scénarios `c5b-*` exigent les deux notes et le dernier jet (relecture), lisent le CSV cellule par cellule (coûts) et
//      n'attendent la fin d'un lancement que sur des états réels (`FINIS`). Les fonctions des scénarios sont chargées telles
//      quelles, comme `croisements-eq-v4` charge `it4-studio`. La procédure d'ouverture d'e2e/README.md est, elle, JOUÉE dans un
//      dépôt jetable par `ouverture-u1-procedure.test.ts`.
//
// Aucune exécution facturée, aucun appel à un fournisseur, aucun réseau : ce fichier ne lit que le dépôt.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import { pathToFileURL } from "node:url";
import { TEXTES as C5, ecartTours } from "./shared/construction-texts.ts";
import { TEXTES as DELEGATION } from "./shared/delegation-texts.ts";
import { DELIVERABLE_TEXTS } from "./shared/flow.ts";
import { TEXTES as NEON } from "./shared/neon-texts.ts";
import { TEAM_RUN_TRANSITIONS, TEAM_STEP_TRANSITIONS } from "./shared/team-limits.ts";
import { TEXTES as EQ } from "./shared/team-texts.ts";
import { EQUIPES_SIMPLE_OUVERTES } from "./wiring-eq.ts";
import { assistantsTabOf, assistantsViewOf, parseRoute, parseRouteQuery } from "../web/lib/router.ts";

const DEPOT = path.resolve(import.meta.dirname, "..", "..");
const lire = (relatif: string): string => fs.readFileSync(path.join(DEPOT, relatif), "utf8");
const lignesDe = (texte: string): string[] => texte.split(/\r?\n/);

/**
 * Contenu d'une section Markdown balisée (une seule par nom, §2.6). Les balises sont assemblées en deux morceaux : écrites
 * d'un bloc, elles seraient prises pour des balises mal formées par `construction-balises.test.ts`.
 */
function sectionMarkdown(texte: string, nom: string): string {
  const debut = texte.indexOf("<!-- " + `c5:${nom} -->`);
  const fin = texte.indexOf("<!-- /" + `c5:${nom} -->`);
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

  // Grande fusion (GF4, A20) : c5b-mc5-reel, MC5-2 rejouée sur le code réel par la répétition générale de la 5b, est versé au
  // dépôt : huit scénarios de la 5b.
  it("la famille c5 : cinq scénarios de la 5a, huit de la 5b, chacun décrit dans e2e/README.md, et rien de plus", () => {
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
        "c5b-mc5-reel.mjs",
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
    // Depuis la relecture de la vague 4, la procédure n'agit que sous `"$copie"` (jamais sur le dossier courant).
    const sed = /sed -i 's\/(\^[^/]+\$)\/([^/]+)\/' "\$copie\/(app\/server\/wiring-eq\.ts)"/.exec(readme);
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

// --- 6. Corrections de la relecture de la vague 4 (5b-vague-4) --------------------------------------------------------------

/** Sous-section « ### {titre} » d'un texte Markdown, jusqu'au titre suivant de niveau 1 à 3. */
function sousSection(texte: string, titre: string): string {
  const lignes = lignesDe(texte);
  const debut = lignes.findIndex((ligne) => ligne.trim() === `### ${titre}`);
  assert.ok(debut >= 0, `sous-section « ${titre} » introuvable`);
  const fin = lignes.findIndex((ligne, i) => i > debut && /^#{1,3} /.test(ligne));
  return lignes.slice(debut, fin < 0 ? undefined : fin).join("\n");
}

/** Feuilles d'un module de textes : [chemin pointé depuis TEXTES, valeur]. */
function feuilles(valeur: unknown, prefixe: string): Array<[string, string]> {
  if (typeof valeur === "string") return [[prefixe, valeur]];
  if (!valeur || typeof valeur !== "object") return [];
  return Object.entries(valeur).flatMap(([cle, v]) => feuilles(v, prefixe === "" ? cle : `${prefixe}.${cle}`));
}

const echapper = (texte: string): string => texte.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Fichiers qui LISENT la feuille `chemin` du module de textes `module` (`construction-texts`, `neon-texts`…) : le fichier importe
 * `TEXTES` de ce module (renommé ou non) et écrit l'accès complet, ou passe par un alias local d'un sous-objet
 * (« const T = TEXTES.partout.demonstration; » puis « T.titre »). Une constante définie que personne ne lit n'a aucun lecteur.
 */
function lecteurs(sources: ReadonlyArray<readonly [string, string]>, module: string, chemin: string): string[] {
  const trouves: string[] = [];
  for (const [fichier, source] of sources) {
    const bloc = new RegExp(`import\\s*\\{([^}]*)\\}\\s*from\\s*"[^"]*/server/shared/${echapper(module)}\\.ts"`).exec(source);
    const nom = bloc ? /\bTEXTES(?:\s+as\s+(\w+))?/.exec(bloc[1] ?? "") : null;
    if (!nom) continue;
    const local = nom[1] ?? "TEXTES";
    const acces = [`${local}.${chemin}`];
    for (const alias of source.matchAll(new RegExp(`\\b(?:const|let)\\s+(\\w+)\\s*=\\s*${local}((?:\\.\\w+)+)\\s*;`, "g"))) {
      const prefixe = (alias[2] ?? "").slice(1);
      if (chemin.startsWith(`${prefixe}.`)) acces.push(`${alias[1]}.${chemin.slice(prefixe.length + 1)}`);
    }
    if (acces.some((expression) => new RegExp(`(?<![\\w.])${echapper(expression)}\\b`).test(source))) trouves.push(fichier);
  }
  return trouves;
}

/** Sources de production de l'interface, lues une fois. */
const sourcesWeb = (): Array<readonly [string, string]> => sourcesDeProduction("app/web").map((fichier) => [fichier, lire(fichier)] as const);

/** Charge un module de scénario du banc tel quel (il n'est pas dans `tsconfig`, d'où l'import par URL). */
const chargerScenario = (nom: string): Promise<unknown> => import(pathToFileURL(path.join(DEPOT, SCENARIOS, nom)).href);

const demonstrationDuReadme = (): string => sousSection(sectionMarkdown(lire("README.md"), "construction"), "Démonstration d'équipe");

describe("relecture de la vague 4 : la documentation de DOC5 dit ce que le code fait", () => {
  it("README, « Démonstration d'équipe » : chaque libellé de la démonstration qu'il cite est LU par un écran, pas seulement défini", () => {
    const section = demonstrationDuReadme();
    const cites = new Set([...section.matchAll(/«\s*([^«»]+?)\s*»/g)].map((m) => m[1] ?? ""));
    const retenus = feuilles(C5.partout.demonstration, "partout.demonstration").filter(([, valeur]) => cites.has(valeur));
    // Le titre, l'étiquette, la phrase et l'entrée au moins : le contrôle ne tourne pas à vide.
    assert.ok(retenus.length >= 4, `libellés de la démonstration cités par le README : ${JSON.stringify(retenus)}`);
    const sources = sourcesWeb();
    for (const [chemin, valeur] of retenus) {
      // Une même phrase peut être lue par un autre module de textes, à l'octet : l'étiquette de la construction est celle du
      // lecteur de l'itération 1 (`neon-texts.ts`, `demonstrationEnregistree`), que DemoPlayer lit.
      const jumeaux: Array<[string, string]> = [
        ["construction-texts", chemin],
        ...feuilles(NEON, "").filter(([, v]) => v === valeur).map(([c]): [string, string] => ["neon-texts", c]),
      ];
      const lus = jumeaux.flatMap(([module, c]) => lecteurs(sources, module, c));
      assert.ok(lus.length > 0, `« ${valeur} » (${chemin}) est cité par le README, mais aucun écran ne le lit : l'utilisateur le cherchera en vain`);
    }

    // Contrôles discriminants du lecteur d'accès : alias local et import renommé reconnus ; une feuille définie, jamais lue, rien.
    const imports = `import { TEXTES as X } from "../../../server/shared/construction-texts.ts";\n`;
    const essai = (corps: string, chemin: string) => lecteurs([["essai.tsx", imports + corps]], "construction-texts", chemin);
    assert.deepEqual(essai("const T = X.partout.demonstration;\nT.titre;", "partout.demonstration.titre"), ["essai.tsx"]);
    assert.deepEqual(essai("X.partout.demonstration.voir;", "partout.demonstration.voir"), ["essai.tsx"]);
    assert.deepEqual(essai("const T = X.partout.demonstration;\nT.titre;", "partout.demonstration.bascule.aLaSuite"), []);
    assert.deepEqual(lecteurs([["essai.tsx", "T.titre;"]], "construction-texts", "partout.demonstration.titre"), []);
  });

  it("README, « Démonstration d'équipe » : la bande qu'elle dessine a des transitions, que le mouvement réduit coupe ; le README le dit", () => {
    // Faits du code : la démonstration dessine NeonCarte, qui joue une transition WAAPI à chaque signe qui apparaît ou change,
    // et seulement quand le système ne demande pas de mouvement réduit.
    const lecteur = lire("app/web/pages/chat/activity/DemoPlayer.tsx");
    const bande = lire("app/web/pages/chat/activity/NeonBand.tsx");
    assert.match(lecteur, /<NeonCarte\b/);
    const carte = bande.indexOf("export function NeonCarte(");
    assert.ok(carte >= 0 && bande.slice(carte, carte + 400).includes("useTransitions(svgRef, vue);"), "NeonCarte ne joue plus ses transitions");
    assert.match(bande, /matchMedia\("\(prefers-reduced-motion: no-preference\)"\)/);
    assert.match(bande, /signe\.animate\(/);

    const section = demonstrationDuReadme();
    assert.doesNotMatch(section, /rien n'y est animé/);
    assert.doesNotMatch(section, /mouvement réduit[^.\n]*n'y change/);
    assert.match(section, /Elle ne se lance \*\*jamais toute seule\*\*/);
    assert.match(section, /transitions de la bande[^.\n]*sont coupées si votre système demande un mouvement réduit/);
    // Même fait dans l'en-tête du composant de la démonstration.
    const demo = lire("app/web/pages/assistants/teams/TeamDemo.tsx");
    assert.doesNotMatch(demo, /le mouvement réduit ne change rien/);
    assert.match(demo, /le mouvement réduit les coupe/);
  });

  it("RECAPITULATIF, « Contrôle de mutation » : les quatre trains qui consignent une campagne, celui de la vague 4 de la 5b compris", () => {
    const ligne = lignesDe(sectionMarkdown(lire("docs/RECAPITULATIF.md"), "validations")).find((l) => l.startsWith("| Contrôle de mutation |"));
    assert.ok(ligne, "ligne « Contrôle de mutation » absente de la section c5:validations");
    // Le train de V4 (1b965fe) consigne douze mutations posées une à une, toutes vues.
    assert.match(ligne, /Consigné dans les commits de quatre trains/);
    for (const train of ["vague 0 de la 5a (17 mutations, toutes détectées)", "vague 2 de la 5a (9, toutes détectées)", "vague 3 de la 5b (6, toutes détectées)", "vague 4 de la 5b (12, toutes détectées)"]) {
      assert.ok(ligne.includes(train), `train absent : ${train}`);
    }
    assert.match(ligne, /Aucune campagne de mutation n'est consignée pour les autres trains : ce contrôle n'est pas revendiqué pour eux\./);
  });
});

describe("relecture de la vague 4 : les scénarios c5b éprouvent ce qu'ils annoncent", () => {
  it("c5b-relecture : au plafond, la carte doit porter les DEUX notes et le DERNIER jet, jamais le deuxième", async () => {
    const { manquesDeLaCarte } = (await chargerScenario("c5b-relecture.mjs")) as { manquesDeLaCarte: (texte: string) => string[] };
    // Le produit écrit les deux notes ensemble quand le dernier verdict dit encore « à reprendre » (flow.ts,
    // `relectureDeliverable`) ; le scénario les écrit en clair, à l'octet, pour un plafond de 2 tours.
    const nonRelue = C5.partout.execution.relecture.nonRelue;
    const nonConclue = C5.partout.execution.relecture.nonConclue.replace("{n}", "2");
    assert.equal(DELIVERABLE_TEXTS.nonRelue, nonRelue);
    assert.equal(DELIVERABLE_TEXTS.nonConclue, C5.partout.execution.relecture.nonConclue);
    assert.equal(phraseDuScenario("c5b-relecture.mjs", "nonRelue"), nonRelue);
    assert.equal(phraseDuScenario("c5b-relecture.mjs", "nonConclue"), nonConclue);

    const jet3 = "Compte rendu (v3) Impact : 42 minutes, 1 380 paiements refusés (source : journal de la passerelle). Actions : surveiller l'échéance des certificats (exploitation, 30/09, alerte à J-30).";
    const jet2 = "Compte rendu (corrigé) Impact : 42 minutes, 1 380 paiements refusés (source : journal de la passerelle). Cause : un certificat périmé, renouvellement non surveillé.";
    assert.deepEqual(manquesDeLaCarte(`${jet3} ${nonRelue} ${nonConclue} Journal de relecture`), []);
    // Une seule des deux notes : un défaut, dans un sens comme dans l'autre.
    assert.equal(manquesDeLaCarte(`${jet3} ${nonRelue}`).length, 1);
    assert.equal(manquesDeLaCarte(`${jet3} ${nonConclue}`).length, 1);
    // « après 3 tours » n'est pas la note d'un plafond de 2.
    assert.equal(manquesDeLaCarte(`${jet3} ${nonRelue} ${C5.partout.execution.relecture.nonConclue.replace("{n}", "3")}`).length, 1);
    // Le deuxième jet montré à la place du dernier est vu, alors que « 1 380 paiements refusés » y figure aussi.
    assert.equal(manquesDeLaCarte(`${jet2} ${nonRelue} ${nonConclue}`).length, 2);

    const source = lire(`${SCENARIOS}/c5b-relecture.mjs`);
    assert.match(source, /const manques = manquesDeLaCarte\(carte\.texte\);\r?\n\s*exiger\(manques\.length === 0,/);
    assert.doesNotMatch(source, /exiger\(notes\.length > 0,/);
  });

  it("c5b-couts-archives : une ligne du CSV porte un lancement d'équipe par SES cellules, pas par le titre de la conversation", async () => {
    const { lireCsv, lignesDEquipe } = (await chargerScenario("c5b-couts-archives.mjs")) as {
      lireCsv: (texte: string) => string[][];
      lignesDEquipe: (tableau: string[][], titres: string[]) => string[][];
    };
    const entete = "date_utc,conversation,titre,cout_usd,lancement_equipe,etape";
    const equipe = "Compte rendu d'incident relu (c5b)";
    const csv = (...lignes: string[]) => `${[entete, ...lignes].join("\r\n")}\r\n`;

    // La colonne `titre` porte le titre de l'équipe (conversation racine « {équipe} : {demande} ») et les deux colonnes
    // d'équipe sont VIDES : aucune ligne n'est retenue — l'ancienne recherche dans la ligne entière, elle, la retenait.
    const vides = csv(`2026-09-23T08:00:00.000Z,ses_1,"${equipe} : Rédige, vite",0.020000,,`);
    assert.deepEqual(lignesDEquipe(lireCsv(vides), [equipe]), []);
    assert.ok(vides.split("\r\n").slice(1).some((ligne) => ligne.includes(equipe)), "contrôle discriminant : l'ancien filtre la retenait");
    // Les deux colonnes remplies : retenue. `etape` vide seule, ou une autre équipe : non retenue.
    const pleine = csv(`2026-09-23T08:00:00.000Z,ses_1,"${equipe} : Rédige, vite",0.020000,${equipe},Rédaction`);
    assert.deepEqual(lignesDEquipe(lireCsv(pleine), [equipe]).map((cellules) => cellules.at(-1)), ["Rédaction"]);
    assert.deepEqual(lignesDEquipe(lireCsv(csv(`d,ses_1,x,0.01,${equipe},`)), [equipe]), []);
    assert.deepEqual(lignesDEquipe(lireCsv(csv(`d,ses_1,x,0.01,Autre équipe,Rédaction`)), [equipe]), []);
    // Une ligne décalée (une cellule de trop) n'est jamais retenue : ses colonnes ne sont plus les bonnes.
    assert.deepEqual(lignesDEquipe(lireCsv(csv(`d,ses_1,x,0.01,en trop,${equipe},Rédaction`)), [equipe]), []);
    // Cellules de `csvCell` : virgule, guillemet doublé et retour à la ligne entre guillemets.
    assert.deepEqual(lireCsv('a,"b,c","d ""e""","f\r\ng"\r\n1,2,3,4\r\n'), [["a", "b,c", 'd "e"', "f\r\ng"], ["1", "2", "3", "4"]]);
    assert.throws(() => lireCsv('a,"b\r\n'), /guillemet non fermé/);

    const source = lire(`${SCENARIOS}/c5b-couts-archives.mjs`);
    assert.match(source, /const avecEquipe = lignesDEquipe\(tableauCsv, \[relecture\.titre, aiguillage\.titre\]\);/);
    assert.match(source, /const tableauCsv = lireCsv\(csv\.corps\);/);
  });

  it("c5b : `FINIS` est l'ensemble des états finaux d'un lancement, et les scénarios c5 ne comparent un état qu'à un état réel", async () => {
    const { FINIS } = (await chargerScenario("c5b-relecture.mjs")) as { FINIS: ReadonlySet<string> };
    // Un lancement est « en cours » en préparation, en cours ou en attente (de vous, du budget, d'une modification, d'un
    // choix) ; tout autre état de TeamRunState est final.
    const etatsLancement = Object.keys(TEAM_RUN_TRANSITIONS);
    const enCours = (etat: string) => etat === "preparation" || etat === "en-cours" || etat.startsWith("attente-");
    assert.deepEqual([...FINIS].sort(), etatsLancement.filter((etat) => !enCours(etat)).sort());

    const reels = new Set([...etatsLancement, ...Object.keys(TEAM_STEP_TRANSITIONS)]);
    const inconnus: string[] = [];
    const finsSansFinis: string[] = [];
    for (const nom of scenarios().filter((n) => n.startsWith("c5"))) {
      lignesDe(lire(`${SCENARIOS}/${nom}`)).forEach((ligne, i) => {
        for (const m of ligne.matchAll(/\.state\s*[!=]==?\s*"([^"]+)"/g)) if (!reels.has(m[1] ?? "")) inconnus.push(`${nom}:${i + 1} « ${m[1]} »`);
        // Une attente de FIN de lancement (libellé « … terminé(e) ») rend tout état final, pour que l'état réel soit nommé.
        if (/\battendreRun\(/.test(ligne) && /terminée?[" ]/.test(ligne) && !ligne.includes("FINIS.has(vue.state)")) finsSansFinis.push(`${nom}:${i + 1}`);
      });
    }
    assert.deepEqual(inconnus, [], "état inconnu de TeamRunState et de TeamStepState : l'attente épuiserait son délai");
    assert.deepEqual(finsSansFinis, [], "attente de fin de lancement qui ne s'arrête pas sur tous les états finaux");
    // c5b-a11y n'enchaîne pas ses captures sur un lancement fini autrement que « terminee ».
    assert.match(
      lire(`${SCENARIOS}/c5b-a11y.mjs`),
      /const finie = await attendreRun\(api, runId, \(vue\) => FINIS\.has\(vue\.state\), "aiguillage des captures terminé", 90_000\);\r?\n\s*exiger\(finie\.state === "terminee",/,
    );
  });
});
