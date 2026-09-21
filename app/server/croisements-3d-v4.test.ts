// Tests de croisement du train it3 V4 (plan d'exécution it3 §2.4, §5.2 ; propriété de l'intégrateur) : L33 (accessibilité,
// couleurs et captures) et DOC-3D (documentation) croisés avec tout ce que les vagues 0 à 3 ont fusionné. Chaque paquet a ses
// propres tests — L33 mesure les contrastes et lit ses quatre feuilles, DOC-3D a vérifié ses liens hors dépôt — ; ici, seulement
// ce qui ne se voit QU'UNE FOIS les deux paquets posés sur le code complet :
//   1. L33 × L35 : `it3-captures.mjs` n'écrit AUCUNE aide e2e ; chaque symbole qu'il prend dans `e2e/lib/webgl.mjs` (L35) et
//      dans `it1-ui-commun.mjs` y est réellement exporté. `npm test` ne joue pas le banc : sans ce contrôle, un renommage dans
//      une aide ne se verrait qu'au banc, plusieurs minutes plus tard.
//   2. L33 × le dépôt : toutes les captures sont écrites sous `ctx.dossierCaptures` (dossier du banc), et aucune image du
//      scénario n'a été versionnée.
//   3. L33 × L30 (`neon.css`) : la carte néon sous couleurs forcées. `neon.css` redéfinit les 14 jetons `--neon-*` sous
//      `.neon-band` SEULEMENT, alors que sa règle `.neon-map { forced-color-adjust: none }` est générale : tout composant qui
//      monte `NeonCarte`/`NeonTableau` hors de la bande doit vivre dans une portée qui redéfinit les 14 jetons. Les portées
//      couvertes sont LUES dans les feuilles ; un troisième consommateur, ou une portée qui oublierait un jeton, fait échouer.
//   4. L33 × L31b : sous couleurs forcées, le verdict est 2D (raison `accessibilite`) — c'est pourquoi les blocs de L33 n'ont
//      pas à habiller la 3D (L30, JP-12), et c'est la phrase que le scénario de captures exige.
//   5. DOC-3D × le code : chaque chiffre et chaque clé que la documentation donne pour la salle et « Revoir » est celui d'une
//      constante du code (bornes des consignes, étiquettes, sonde, temps mort, vitesses, clé du poste, version de three), et
//      chaque phrase du tableau des replis est celle de `salle3d-texts.ts`.
//   6. DOC-3D × le train : les chiffres de la ligne M24 sont ceux MESURÉS au train (build de la branche d'intégration), pas
//      ceux d'un build antérieur. Les valeurs de la vague 3 (CSS d'avant les blocs d'accessibilité de L33) sont refusées
//      nommément : une ligne de sortie ne se déclare pas tenue sur une mesure périmée.
//   7. DOC-3D × la grille de la vague : les six recettes en attente sont listées, aucune n'est déclarée tenue, et tout ce que
//      DOC-3D a écrit tient dans des sections balisées `[3d]` équilibrées et séparées par une ligne vide (D-3d-24).
// Ajouts de la relecture de la vague 4 (constats de justesse et de sécurité : la documentation, le scénario de captures et ce
// fichier même) :
//   8. DOC-3D × le code : les ENTRÉES citées pour la salle de contrôle sont celles du code. Tout `app/web` est lu ; seuls la
//      commande de la bande du travail en direct et la salle elle-même ouvrent la salle, et les Archives n'ont que « Revoir ».
//      La phrase des documents ne doit donc pas citer les Archives comme entrée de la salle, et la ligne « Revoir », elle,
//      doit les garder.
//   9. DOC-3D × le code : la règle d'accès de « Revoir » telle que le §8 Sécurité l'écrit. Les trois verdicts de `revoirAcces`
//      sont CALCULÉS ici : l'instance principale et le mode Avancé sont ouverts même pendant une demande, et seule une racine
//      de la Salle OMO en mode Simple est fermée. Une phrase non qualifiée ferait lire un portillon général à un relecteur de
//      sécurité, qui ne verrait plus le vrai point de décision (Q6, P11, D-3d-09).
//  10. DOC-3D × le train : le §10 annonce un banc COMPLET ; le nombre de scénarios qu'il cite est comparé au nombre réel de
//      fichiers de `e2e/scenarios/` (la règle du banc, `listerScenarios`, appelée telle quelle), et la ligne des tests ne doit
//      plus citer un compte d'un passage antérieur à la vague 4.
//  11. L33 × L31b × L31c : le contrôle « à 400 px, la vue disparaît » du scénario de captures nomme la vue de CHAQUE zoom
//      (`.salle3d-vue` au zoom 1, démontée par la garde `etroit` de `SalleControlePage.tsx` ; `.zoom-conv-vue` aux zooms 2
//      et 3, cachée par `zoom-conversation.css`). Un sélecteur écrit en dur rendait le contrôle du zoom 1 toujours vrai.
//  12. DOC-3D × L33 : la ligne de sortie l.1174 du §7.7 (script couleurs, captures) a SA ligne de mesure au §10, et la ligne
//      « Lignes de sortie » nomme les HUIT lignes l.1169 à l.1176, aucune n'étant déclarée tenue sans mesure.
//  13. L33 × le banc : `--scenarios it3-` et `--scenarios it3-captures` prennent le scénario selon la VRAIE règle du banc
//      (`correspond` et `listerScenarios` de `e2e/lib/docker-e2e.mjs`), pas selon une sous-chaîne recopiée ici.
// Ajouts de la revue d'itération (3), qui a trouvé le §10 périmé DANS LE SENS PRUDENT — banc rejoué vert et débit tenu, mais
// documentation restée sur le passage d'avant la correction :
//  14. DOC-3D × DOC-3D : le §10 et le §11 disent la même chose du banc et de la ligne l.1176. Le compte de scénarios VERTS est
//      lu et croisé avec le verdict (« aucun échec » ⇔ verts = joués) ; une ligne de sortie donnée tenue exige un banc vert,
//      un plafond tenu dans les deux rendus et aucun point « à remesurer » resté ouvert au §11 ; une ligne de sortie donnée en
//      attente exige, elle, le point du §11 qui la tient ouverte. Un document à moitié mis à jour tombe, dans les deux sens.
//  15. DOC-3D × les passages du banc : les comptes qui changent d'un passage à l'autre (moments de « Revoir », images du
//      premier zoom, curseur des moments, images de scène) sont DATÉS, et les quatre valeurs d'un seul passage que la revue a
//      démenties ne peuvent pas revenir. Le document doit donner la RÈGLE que le scénario vérifie, pas le chiffre.
//  16. DOC-3D × `it3-revoir.mjs` : cette règle est relue DANS le scénario, jamais recopiée. Le scénario contrôle la FORME du
//      compteur (« n / N ») aux deux endroits où il le lit, plus un minimum de moments, et promène le lecteur au clavier sur
//      tous les moments — mais il ne compare pas les deux nombres du compteur, et il ne parcourt aucun moment depuis les
//      Archives. Le §10 ne peut donc annoncer ni « N sur N », ni des moments rejoués depuis les Archives : ce serait une
//      sur-déclaration, l'exact symétrique du §10 périmé du constat 14.
// Note du troisième tour de la revue : deux phrases du §10 ont encore été corrigées — le nombre de passages de `npm test`
// (trois, et non deux) et la tête sur laquelle le banc a été joué (`28823b6`, celle d'avant les commits de documentation de
// la clôture). Aucune garde n'est ajoutée pour elles : un test ne peut savoir ni combien de fois `npm test` a été lancé, ni
// sur quel commit le banc a tourné ; une garde qui s'en donnerait l'air ne tomberait sur aucune des deux phrases fautives.
// Note du quatrième tour : ces deux phrases se périmaient EN S'ÉCRIVANT (« les deux commits de documentation » en comptait
// trois dès le commit suivant ; « joués trois fois » cessait d'être vrai au passage d'après). Le §10 ne compte donc plus ni
// les commits de documentation ni les passages de `npm test` : il nomme la tête `28823b6`, « la dernière où le code de
// l'application ait changé », et dit « le même compte à chaque passage complet ». Il consigne aussi qu'un fichier de test
// peut tomber en bloc au démarrage quand la machine est chargée, sans sous-test rouge : fragilité du poste, pas du code.
// Ce qui EST gardé ici reste le verdict du banc et les comptes datés (constats 14 et 15).
// Les liens internes et les ancres des deux documents sont déjà contrôlés, pour tout le dépôt, par
// `croisements-it1-v5.test.ts` (« liens internes et ancres de README.md, docs/RECAPITULATIF.md et e2e/README.md ») : ce fichier
// ne les refait pas. Aucun conteneur Docker, aucun vrai opencode, aucun appel facturé : tout se joue en Node. Le banc
// (`scripts/run-e2e.sh --faux --scenarios it3-captures --project-prefix 3d11-e2e --image-tag 3d11`) est joué par l'intégrateur,
// hors de `npm test` (décision D-06).
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
// Sans effet de bord : le bloc principal de docker-e2e.mjs n'exécute rien tant que Node ne lance pas ce fichier lui-même.
import { correspond, listerScenarios } from "../../e2e/lib/docker-e2e.mjs";
import { CONSIGNES } from "./shared/consignes.ts";
import { FLUIDITE, PREFERENCE_CLE } from "./shared/fluidity.ts";
import { PLAN3D } from "./shared/neon-plan3d.ts";
import { RACCOURCI, VITESSES } from "./shared/revoir.ts";
import { revoirAcces } from "./shared/revoir-access.ts";
import { messageFluidite, TEXTES as SALLE } from "./shared/salle3d-texts.ts";

const APP_DIR = path.join(import.meta.dirname, "..");
const DEPOT = path.join(APP_DIR, "..");
const E2E_DIR = path.join(DEPOT, "e2e");
const SCENARIOS_DIR = path.join(E2E_DIR, "scenarios");
const SALLE_DIR = path.join(APP_DIR, "web", "pages", "salle-controle");
const NEON_CSS = path.join(APP_DIR, "web", "pages", "chat", "activity", "neon.css");
const CAPTURES = path.join(SCENARIOS_DIR, "it3-captures.mjs");
const README = path.join(DEPOT, "README.md");
const RECAP = path.join(DEPOT, "docs", "RECAPITULATIF.md");

const lire = (fichier: string): string => fs.readFileSync(fichier, "utf8");

/**
 * Mesures du build de la branche d'intégration, à la correction de la répétition générale (`npm run build` dans la copie,
 * journal recopié dans le rapport) : morceau de three inchangé depuis le train de V3, CSS inchangé depuis V4, morceau principal
 * augmenté du créneau unique de publication de la cadence. Toute ligne de la documentation qui donne une de ces tailles doit
 * donner CELLE-CI ; sinon, on remesure et on met les deux à jour.
 */
const MESURES_TRAIN = {
  threeBruts: "567 336",
  threeGzip: "142 027",
  principal: "1 675,50 kB",
  principalGzip: "539,20 kB",
  css: "95,92 kB",
  cssGzip: "17,82 kB",
} as const;

/** Tailles d'un build antérieur, refusées nommément dans la ligne M24 (vague 3, copie de DOC-3D, train de V4). */
const MESURES_PERIMEES = ["142 026", "93,05 kB", "92,96 kB", "17,41 kB", "1 675,28 kB", "539,09 kB"] as const;

/**
 * Comptes de tests d'un passage antérieur à la vague 4, refusés nommément dans la ligne des tests du §10 (relecture 3-vague-4,
 * constat « le §10 cite un nombre de tests antérieur »). Un compte exact n'est pas tenable depuis `npm test` — le contrôle se
 * mordrait la queue — mais une valeur périmée, elle, se reconnaît : on remesure plutôt que de recopier.
 */
const TESTS_PERIMES = ["2 029", "2 033", "2 023", "2 069", "2 070"] as const;

/**
 * Verdict du banc COMPLET rejoué sur la tête `28823b6`, la
 * dernière où le code de l'application ait changé, la correction du débit comprise (journal du rejeu : « Banc e2e :
 * 23 scénario(s), aucun échec », code de sortie 0), et débit M20 relevé tenu en 3D comme en repli 2D aux trois passages du
 * même jour (banc complet, puis `it3-debit` rejoué seul deux fois). Même règle que les tailles de `MESURES_TRAIN` : toute
 * ligne de la documentation qui donne ce verdict doit donner CELUI-CI ; sinon, on rejoue le banc et on met les deux à jour.
 */
const BANC_TRAIN = {
  verdict: "aucun échec",
  debit: "tenu en 3D comme en repli 2D",
  sorties: "tenues et mesurées",
} as const;

/**
 * Verdicts d'un passage ANTÉRIEUR à la correction du débit, refusés nommément dans les sections [3d] du §10 et du §11
 * (revue d'itération 3 : le document racontait encore le banc d'avant la correction et se donnait pour moins bon qu'il
 * n'est). Une déclaration périmée se reconnaît, comme une taille périmée : on rejoue plutôt que de recopier.
 */
const BANC_PERIME = [
  "19 verts",
  "cinq des six",
  "banc à rejouer",
  "mesure au banc reste à refaire",
  "à remesurer au banc",
  "reste **en attente**",
] as const;

/** Les six recettes en attente du plan it3 §3.3, reconnues par une sous-chaîne propre à chacune. */
const RECETTES = [
  "Seuils de fluidité sur un poste de travail",
  "CSP sous WebGL, sur le poste de travail",
  "**NVDA**",
  "collègue peu à l'aise avec l'IA",
  "Captures sur le poste de travail",
  "Débit sur Copilot réel",
] as const;

/** Tous les fichiers `.ts` et `.tsx` sous un dossier, chemins absolus. */
function fichiersSources(dossier: string): string[] {
  const trouves: string[] = [];
  for (const entree of fs.readdirSync(dossier, { withFileTypes: true })) {
    const chemin = path.join(dossier, entree.name);
    if (entree.isDirectory()) trouves.push(...fichiersSources(chemin));
    else if (/\.tsx?$/.test(entree.name)) trouves.push(chemin);
  }
  return trouves;
}

/** Une phrase d'un document : de `debut` au premier point qui la ferme, sur la ligne qui la porte. */
function phraseDe(texte: string, debut: string): string {
  const ligne = texte.split(/\r?\n/).find((candidate) => candidate.includes(debut)) ?? "";
  if (ligne === "") return "";
  const depart = ligne.indexOf(debut);
  const fin = ligne.indexOf(".", depart);
  return ligne.slice(depart, fin === -1 ? undefined : fin + 1);
}

/** Symboles exportés par un module `.mjs` (déclarations `export function|const|async function|class`, et `export { … }`). */
function exportesDe(fichier: string): Set<string> {
  const source = lire(fichier);
  const noms = new Set<string>();
  for (const m of source.matchAll(/^export\s+(?:async\s+)?(?:function|const|let|class)\s+([A-Za-z0-9_$]+)/gm)) noms.add(m[1] ?? "");
  for (const m of source.matchAll(/^export\s*\{([^}]*)\}/gm)) {
    for (const brut of (m[1] ?? "").split(",")) {
      const nom = brut.trim().split(/\s+as\s+/).pop()?.trim() ?? "";
      if (nom !== "") noms.add(nom);
    }
  }
  noms.delete("");
  return noms;
}

/** Symboles importés d'un module donné (`import { a, b } from "<chemin>"`), chemin reconnu par sa fin. */
function importesDe(source: string, finDuChemin: string): string[] {
  const noms: string[] = [];
  const motif = new RegExp(`import\\s*\\{([^}]*)\\}\\s*from\\s*"([^"]*${finDuChemin.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")})"`, "g");
  for (const m of source.matchAll(motif)) {
    for (const brut of (m[1] ?? "").split(",")) {
      const nom = brut.trim().split(/\s+as\s+/)[0]?.trim() ?? "";
      if (nom !== "") noms.push(nom);
    }
  }
  return noms;
}

/** Contenu de chaque bloc `@media (forced-colors: active) { … }` d'une feuille (accolades comptées). */
function blocsCouleursForcees(css: string): string[] {
  const blocs: string[] = [];
  const motif = /@media\s*\(forced-colors:\s*active\)\s*\{/g;
  for (const debut of css.matchAll(motif)) {
    let profondeur = 1;
    let i = (debut.index ?? 0) + debut[0].length;
    const depart = i;
    for (; i < css.length && profondeur > 0; i++) {
      if (css[i] === "{") profondeur++;
      else if (css[i] === "}") profondeur--;
    }
    blocs.push(css.slice(depart, i - 1));
  }
  return blocs;
}

/** Portées (sélecteurs de premier niveau) d'un bloc, avec les jetons `--neon-*` qu'elles redéfinissent. */
function porteesNeon(bloc: string): Map<string, Set<string>> {
  const portees = new Map<string, Set<string>>();
  const motif = /([^{}]+)\{([^{}]*)\}/g;
  for (const regle of bloc.matchAll(motif)) {
    const selecteurs = (regle[1] ?? "").trim();
    const corps = regle[2] ?? "";
    const jetons = new Set<string>();
    for (const jeton of corps.matchAll(/(--neon-[a-z0-9-]+)\s*:/g)) jetons.add(jeton[1] ?? "");
    if (jetons.size === 0) continue;
    for (const selecteur of selecteurs.split(",")) {
      const cle = selecteur.trim().split(/[\s>]+/)[0] ?? "";
      if (!cle.startsWith(".")) continue;
      const deja = portees.get(cle) ?? new Set<string>();
      for (const jeton of jetons) deja.add(jeton);
      portees.set(cle, deja);
    }
  }
  return portees;
}

/** Sections balisées `<!-- [3d] début : … -->` … `<!-- [3d] fin -->` d'un document : contenu et numéros de ligne. */
function sections3d(texte: string): { debut: number; fin: number; contenu: string }[] {
  const lignes = texte.split(/\r?\n/);
  const sections: { debut: number; fin: number; contenu: string }[] = [];
  let depart: number | null = null;
  lignes.forEach((ligne, index) => {
    if (/^<!--\s*\[3d\]\s*début/.test(ligne)) {
      assert.equal(depart, null, `balise « [3d] début » imbriquée, ligne ${index + 1}`);
      depart = index;
    } else if (/^<!--\s*\[3d\]\s*fin\s*-->$/.test(ligne)) {
      assert.notEqual(depart, null, `balise « [3d] fin » sans début, ligne ${index + 1}`);
      const d = depart as number;
      sections.push({ debut: d + 1, fin: index + 1, contenu: lignes.slice(d + 1, index).join("\n") });
      depart = null;
    }
  });
  assert.equal(depart, null, "une section [3d] n'est pas refermée");
  return sections;
}

describe("croisements it3 V4 : captures et aides du banc (L33 × L35)", () => {
  it("`it3-captures.mjs` n'écrit aucune aide e2e : chaque symbole pris dans `webgl.mjs` et dans `it1-ui-commun.mjs` y est exporté", () => {
    const source = lire(CAPTURES);
    for (const [module, fichier] of [
      ["../lib/webgl.mjs", path.join(E2E_DIR, "lib", "webgl.mjs")],
      ["./it1-ui-commun.mjs", path.join(SCENARIOS_DIR, "it1-ui-commun.mjs")],
    ] as const) {
      const pris = importesDe(source, module.slice(module.lastIndexOf("/") + 1));
      assert.ok(pris.length > 0, `aucun symbole pris dans ${module}`);
      const offerts = exportesDe(fichier);
      assert.deepEqual(
        pris.filter((nom) => !offerts.has(nom)),
        [],
        `symboles absents de ${module} (renommage dans L35 ?)`,
      );
    }
    // Aucune aide écrite sur place : le scénario n'offre que son `run`, le contrat du banc (fiche L33 : « il consomme celles de
    // L35 »). Un second export serait une aide écrite ici, à mettre dans `e2e/lib/` pour être relue par les autres scénarios.
    assert.deepEqual([...exportesDe(CAPTURES)], ["run"]);
  });

  it("le scénario est pris par la règle de filtrage du banc (`correspond`, `listerScenarios`) et cité dans `e2e/README.md`", () => {
    assert.ok(fs.existsSync(CAPTURES), "it3-captures.mjs absent de e2e/scenarios");
    // La règle est celle du banc lui-même (e2e/lib/docker-e2e.mjs), pas une sous-chaîne recopiée ici : si `--scenarios` passait à
    // une correspondance exacte ou par préfixe d'identifiant, ces assertions tomberaient avec le banc, et non après lui.
    for (const motif of ["it3-", "it3-captures", "it3-*"]) {
      assert.ok(correspond("it3-captures.mjs", motif), `« --scenarios ${motif} » ne prend pas le scénario`);
      assert.ok(
        listerScenarios(motif, SCENARIOS_DIR).some((scenario) => scenario.nom === "it3-captures.mjs"),
        `« --scenarios ${motif} » n'énumère pas le scénario dans e2e/scenarios`,
      );
    }
    // La commande citée en tête de ce fichier ne joue que lui ; sans motif, le banc complet le joue.
    assert.deepEqual(listerScenarios("it3-captures", SCENARIOS_DIR).map((scenario) => scenario.nom), ["it3-captures.mjs"]);
    assert.ok(listerScenarios(null, SCENARIOS_DIR).some((scenario) => scenario.nom === "it3-captures.mjs"), "le banc complet ne joue pas le scénario");
    assert.ok(lire(path.join(E2E_DIR, "README.md")).includes("`it3-captures.mjs`"), "scénario absent de e2e/README.md");
  });

  it("le contrôle « à 400 px, la vue disparaît » nomme la vue de chaque zoom : `.salle3d-vue` au zoom 1, `.zoom-conv-vue` aux zooms 2 et 3", () => {
    const source = lire(CAPTURES);
    // (a) La fonction reçoit les DEUX sélecteurs de la vue appelante : la vérité, qui doit rester, et la vue, qui doit disparaître.
    const declaration = /async function exigerVeriteAuPetitEcran\(([^)]*)\)/.exec(source);
    assert.ok(declaration, "exigerVeriteAuPetitEcran introuvable dans it3-captures.mjs");
    assert.deepEqual(
      (declaration[1] ?? "").split(",").map((parametre) => parametre.trim()),
      ["page", "taille", "selecteurVerite", "selecteurVue"],
      "la fonction doit recevoir le sélecteur de la vue de chaque zoom, jamais l'écrire en dur",
    );
    // (e) Le corps ne nomme plus aucune vue en dur : c'est le sélecteur reçu qui est interrogé.
    const depart = declaration.index ?? 0;
    const finDuCorps = source.indexOf("\n}\n", depart);
    const corps = source.slice(depart, finDuCorps === -1 ? undefined : finDuCorps);
    assert.ok(!corps.includes('visible(".zoom-conv-vue")'), "« .zoom-conv-vue » écrit en dur : le contrôle du zoom 1 serait toujours vrai (ce nœud n'existe pas dans cette vue)");
    assert.ok(corps.includes("visible(selecteurVue)"), "le contrôle doit interroger le sélecteur de la vue reçu");
    // (b) Chaque appel passe deux sélecteurs ; (c) le zoom 1 nomme sa vue, (d) les zooms 2 et 3 la leur.
    const appels = [...source.matchAll(/(?<!function )exigerVeriteAuPetitEcran\(([^)]*)\)/g)].map((m) => (m[1] ?? "").split(",").map((argument) => argument.trim()));
    assert.equal(appels.length, 3, "les trois zooms de la salle doivent faire ce contrôle");
    for (const arguments_ of appels) {
      assert.equal(arguments_.length, 4, `appel à ${arguments_.length} arguments : les deux sélecteurs sont exigés (${arguments_.join(", ")})`);
    }
    const vueParVerite = new Map(appels.map((arguments_) => [arguments_[2], arguments_[3]]));
    assert.equal(vueParVerite.get('".salle3d-grille"'), '".salle3d-vue"', "zoom 1 : la vue à voir disparaître est .salle3d-vue");
    assert.equal(vueParVerite.get('".zoom-conv-liste"'), '".zoom-conv-vue"', "zoom 2 : la vue à voir disparaître est .zoom-conv-vue");
    assert.equal(vueParVerite.get('".zoom-conv-panneau"'), '".zoom-conv-vue"', "zoom 3 : la vue à voir disparaître est .zoom-conv-vue");
    // (c) et (d) Ces noms existent dans les composants : un renommage rendrait le contrôle vide à nouveau.
    const page = lire(path.join(SALLE_DIR, "SalleControlePage.tsx"));
    assert.ok(page.includes('className="salle3d-vue"'), "SalleControlePage.tsx ne monte plus .salle3d-vue");
    // Le zoom 1 DÉMONTE sa vue sous la garde `etroit` (seuil ETROIT à 400 px) : c'est cette garde, et non une règle CSS, que le
    // contrôle du zoom 1 protège.
    assert.match(page, /etroit \? null : \(\s*<div className="salle3d-vue">/, "la vue du zoom 1 doit être démontée par la garde etroit, pas seulement cachée");
    assert.ok(page.includes('abonnementMedia("(max-width:400px)")'), "seuil ETROIT à 400 px attendu dans SalleControlePage.tsx");
    const zoom = lire(path.join(SALLE_DIR, "ZoomConversation.tsx"));
    assert.match(zoom, /className="zoom-conv-vue(?: [^"]*)?"/, "ZoomConversation.tsx ne monte plus .zoom-conv-vue");
    // Aux zooms 2 et 3, c'est la feuille qui cache la vue à 400 px (§5.6 l.928).
    const css = lire(path.join(SALLE_DIR, "zoom-conversation.css"));
    assert.match(css, /@media \(width <= 400px\) \{\s*\.zoom-conv-vue,[^}]*display: none;/, "zoom-conversation.css ne cache plus .zoom-conv-vue à 400 px");
  });

  it("toutes les captures sont écrites dans le dossier du banc, et aucune image n'est versionnée", () => {
    const source = lire(CAPTURES);
    const appels = [...source.matchAll(/page\.capture\(([^;]*?)\)\s*;/gs)].map((m) => (m[1] ?? "").replace(/\s+/g, " "));
    assert.ok(appels.length > 0, "aucun appel à page.capture");
    for (const appel of appels) {
      assert.ok(
        appel.includes("ctx.dossierCaptures"),
        `capture écrite hors du dossier du banc : ${appel.slice(0, 120)}`,
      );
    }
    // Le scénario garde lui-même cette règle à l'exécution (chemins relus après coup).
    assert.ok(source.includes("dehors") && source.includes("path.resolve(ctx.dossierCaptures)"), "garde du dossier absente du scénario");
    const images = fs
      .readdirSync(E2E_DIR, { recursive: true, encoding: "utf8" })
      .filter((nom) => /\.(png|jpe?g|webp)$/i.test(nom));
    assert.deepEqual(images, [], "des captures ont été versionnées dans e2e/");
  });
});

describe("croisements it3 V4 : couleurs forcées (L33 × L30 × L31b)", () => {
  it("tout consommateur de `NeonCarte` vit dans une portée qui redéfinit les 14 jetons sous couleurs forcées", () => {
    // Jetons à couvrir : ceux que `neon.css` redéfinit sous `.neon-band` (source unique, D-3d-07).
    const blocNeon = blocsCouleursForcees(lire(NEON_CSS));
    assert.equal(blocNeon.length, 1, "neon.css doit porter un seul bloc de couleurs forcées");
    const jetonsBande = porteesNeon(blocNeon[0] ?? "").get(".neon-band");
    assert.ok(jetonsBande && jetonsBande.size === 14, `jetons redéfinis sous .neon-band : ${jetonsBande?.size ?? 0}`);
    // La règle générale qui rend ce contrôle nécessaire : la carte garde ses couleurs partout où elle est montée.
    assert.match(blocNeon[0] ?? "", /\.neon-map\s*\{[^}]*forced-color-adjust:\s*none/);

    // Portées couvertes : celles qui redéfinissent TOUS les jetons, dans neon.css comme dans les feuilles de la salle.
    const feuilles = [NEON_CSS, ...["salle-controle.css", "zoom-conversation.css", path.join("revoir", "revoir.css"), path.join("revoir", "consigne-revoir.css")].map((nom) => path.join(SALLE_DIR, nom))];
    const couvertes = new Set<string>();
    for (const feuille of feuilles) {
      for (const bloc of blocsCouleursForcees(lire(feuille))) {
        for (const [portee, jetons] of porteesNeon(bloc)) {
          if ([...jetonsBande].every((jeton) => jetons.has(jeton))) couvertes.add(portee.slice(1));
        }
      }
    }
    assert.ok(couvertes.has("neon-band"), "la bande elle-même doit rester couverte");

    // Consommateurs : tout fichier .tsx qui importe NeonCarte ou NeonTableau doit nommer une portée couverte.
    const consommateurs: string[] = [];
    const racine = path.join(APP_DIR, "web");
    for (const nom of fs.readdirSync(racine, { recursive: true, encoding: "utf8" })) {
      if (!nom.endsWith(".tsx")) continue;
      const fichier = path.join(racine, nom);
      const source = lire(fichier);
      if (!/import\s*\{[^}]*Neon(?:Carte|Tableau)[^}]*\}\s*from/.test(source)) continue;
      consommateurs.push(nom.replace(/\\/g, "/"));
      const classes = new Set<string>();
      for (const m of source.matchAll(/className="([^"{]*)"/g)) for (const classe of (m[1] ?? "").split(/\s+/)) classes.add(classe);
      assert.ok(
        [...classes].some((classe) => couvertes.has(classe)),
        `${nom} monte la carte néon hors d'une portée qui redéfinit les jetons sous couleurs forcées (portées couvertes : ${[...couvertes].join(", ")})`,
      );
    }
    assert.deepEqual(
      consommateurs.sort(),
      ["pages/chat/activity/DemoPlayer.tsx", "pages/salle-controle/ZoomConversation.tsx", "pages/salle-controle/revoir/RevoirDialog.tsx"],
      "la liste des consommateurs de la carte néon a changé : vérifier la couverture des couleurs forcées",
    );
  });

  it("sous couleurs forcées, le verdict est 2D : la 3D n'est jamais montrée, et c'est la phrase que le scénario exige", () => {
    assert.equal(SALLE.partout.fluidite.accessibilite, messageFluidite("accessibilite"));
    assert.ok(lire(CAPTURES).includes(SALLE.partout.fluidite.accessibilite), "le scénario n'exige pas la phrase du repli d'accessibilité");
    // Les blocs de L33 n'habillent aucun canevas 3D : sous couleurs forcées, il n'y en a pas (L30, JP-12).
    for (const nom of ["salle-controle.css", "zoom-conversation.css", path.join("revoir", "revoir.css"), path.join("revoir", "consigne-revoir.css")]) {
      for (const bloc of blocsCouleursForcees(lire(path.join(SALLE_DIR, nom)))) {
        assert.ok(!/\.salle3d-canevas\s*\{/.test(bloc), `${nom} habille le canevas 3D sous couleurs forcées`);
      }
    }
  });
});

describe("croisements it3 V4 : documentation (DOC-3D × le code)", () => {
  const recap = lire(RECAP);
  const readme = lire(README);
  /** Vrai si `cherche` est écrit dans une section balisée [3d] du document `document` (D-3d-24). */
  const dansLes3d = (cherche: string, document: string): boolean => sections3d(document).some((section) => section.contenu.includes(cherche));

  it("les chiffres et la clé cités par le README sont ceux des constantes du code", () => {
    const attendus: [string, string][] = [
      [`\`${PREFERENCE_CLE}\``, "clé de la préférence du poste"],
      [`${CONSIGNES.maxCaracteres.toLocaleString("fr-FR").replace(/ | /g, " ")} caractères`, "borne de la copie d'une consigne"],
      [`plus de ${CONSIGNES.parRacine} consignes`, "nombre de copies par conversation"],
      [`Au plus ${PLAN3D.etiquettesMax} étiquettes`, "étiquettes posées sur la scène"],
      [`il mesure ${FLUIDITE.sonde.images} images`, "sonde de fluidité"],
      [`plus de ${RACCOURCI.seuilMs / 1_000} secondes`, "temps mort raccourci"],
      [VITESSES.map((v) => `×${String(v).replace(".", ",")}`).join(", "), "vitesses du lecteur"],
    ];
    for (const [texte, quoi] of attendus) {
      assert.ok(readme.includes(texte), `${quoi} : « ${texte} » absent du README`);
      assert.ok(dansLes3d(texte, readme), `${quoi} : « ${texte} » écrit hors d'une section [3d]`);
    }
  });

  it("le tableau des replis du README dit, mot pour mot, les phrases de salle3d-texts.ts", () => {
    // Les cinq lignes du tableau des raisons : la phrase est LUE par `messageFluidite`, jamais recopiée ici.
    for (const raison of ["accessibilite", "rendu-logiciel", "webgl-absent", "saccades", "preference-2d"] as const) {
      const phrase = messageFluidite(raison);
      assert.ok(readme.includes(phrase), `phrase de repli absente du README : « ${phrase} »`);
    }
    assert.equal(messageFluidite("saccades"), SALLE.partout.fluidite.sondeLente, "la phrase de la spéc. l.1007 doit rester celle de la bascule");
    for (const phrase of [SALLE.partout.fluidite.saccades, SALLE.partout.fluidite.basculeProche, SALLE.partout.contexte.perdu, SALLE.partout.fluidite.reessayer]) {
      assert.ok(readme.includes(phrase), `phrase absente du README : « ${phrase} »`);
    }
  });

  it("les entrées citées pour la salle de contrôle sont celles du code : la commande de la bande et l'adresse, jamais les Archives", () => {
    const WEB = path.join(APP_DIR, "web");
    // 1. Le code. Tout `app/web` est lu : un `navigate(SECTION_SALLE…)` ou `navigate("salle-controle"…)` fait entrer dans la
    //    salle. Deux fichiers seulement en portent : la commande de la bande du travail en direct (la seule VRAIE entrée) et
    //    la salle elle-même (fil d'Ariane et zooms, qui déplacent quelqu'un déjà entré). Un troisième — les Archives, par
    //    exemple — rendrait la phrase des documents à revoir, dans un sens ou dans l'autre.
    const ouvrent = fichiersSources(WEB)
      .filter((fichier) => /navigate\(\s*(?:SECTION_SALLE|["']salle-controle["'])/.test(lire(fichier)))
      .map((fichier) => path.relative(WEB, fichier).split(path.sep).join("/"))
      .sort();
    assert.deepEqual(
      ouvrent,
      ["pages/salle-controle/SalleControlePage.tsx", "pages/salle-controle/revoir/BandCommands3d.tsx"],
      "la liste des composants qui ouvrent la salle a changé : reprendre la phrase des entrées dans les deux documents",
    );
    // Les Archives, elles, ne montent que l'entrée « Revoir » (L28b) : c'est ce que dit la ligne « Revoir » des documents.
    const archives = lire(path.join(WEB, "pages", "archives", "ArchiveDetail.tsx"));
    assert.ok(archives.includes("<RevoirEntree"), "les Archives doivent garder leur entrée « Revoir » (L28b)");

    // 2. Les documents. La phrase des entrées de la salle ne cite que la commande de la bande et l'adresse.
    for (const [doc, texte, debut] of [
      ["README.md", readme, "Il n'y a pas d'entrée de menu"],
      ["docs/RECAPITULATIF.md", recap, "Aucune entrée de menu"],
    ] as const) {
      const phrase = phraseDe(texte, debut);
      assert.notEqual(phrase, "", `${doc} : la phrase des entrées de la salle est introuvable`);
      assert.ok(!phrase.includes("Archives"), `${doc} : les Archives sont données pour une entrée de la salle, qu'aucun de leurs composants n'ouvre : « ${phrase} »`);
      assert.ok(phrase.includes("bande"), `${doc} : la commande de la bande doit être nommée : « ${phrase} »`);
      assert.ok(phrase.includes("adresse"), `${doc} : l'adresse doit rester citée : « ${phrase} »`);
    }
    // La ligne « Revoir », elle, cite les Archives à bon droit : `RevoirEntree` y est monté.
    for (const [doc, phrase] of [
      ["README.md", phraseDe(readme, "**Revoir cette demande** s'ouvre depuis")],
      ["docs/RECAPITULATIF.md", phraseDe(recap, "[Revoir cette demande] : ")],
    ] as const) {
      assert.ok(phrase.includes("Archives"), `${doc} : la ligne « Revoir » doit garder les Archives, qui sont une de ses entrées : « ${phrase} »`);
    }
  });

  it("le §8 dit la règle d'accès que `revoirAcces` applique : fermée pour la Salle OMO en mode Simple, ouverte ailleurs", () => {
    // Les trois verdicts sont CALCULÉS ici, jamais recopiés : une demande en cours, vue sous trois angles (Q6, D-3d-09).
    const enCours = { existe: true as const, sessionsOccupees: 2, derniereDemande: { finie: false } };
    assert.deepEqual(revoirAcces({ ...enCours, instance: "principale", mode: "simple" }), { ok: true }, "une conversation de l'instance principale se revoit en mode Simple, même pendant sa demande");
    assert.deepEqual(revoirAcces({ ...enCours, instance: "omo", mode: "avance" }), { ok: true }, "la Salle OMO se revoit en mode Avancé, même pendant sa demande");
    assert.deepEqual(
      revoirAcces({ ...enCours, instance: "omo", mode: "simple" }),
      { ok: false, status: 403, code: "salle-demande-en-cours" },
      "la Salle OMO en mode Simple est le SEUL cas fermé pendant une demande",
    );
    // La règle écrite au §8 doit donc nommer SES DEUX CONDITIONS, sur sa propre ligne : la section entière nomme la Salle OMO
    // ailleurs (« La Salle OMO reste fermée »), et s'en contenter laisserait passer une phrase non qualifiée.
    const lignes = recap.split(/\r?\n/);
    const ligneRegle = lignes.find((ligne) => ligne.includes("**« Revoir » est une lecture.**")) ?? "";
    assert.notEqual(ligneRegle, "", "§8 : la règle d'accès de « Revoir » est introuvable");
    for (const attendu of ["Salle OMO", "mode Simple"]) {
      assert.ok(ligneRegle.includes(attendu), `§8 : la règle d'accès de « Revoir » ne nomme pas « ${attendu} » : elle se lit alors comme un portillon général, et le vrai point de décision n'est plus relu`);
    }
    assert.ok(
      !/Une demande \*\*en cours\*\* ne se revoit pas/.test(ligneRegle),
      "§8 : « une demande en cours ne se revoit pas » est faux pour l'instance principale et pour le mode Avancé",
    );
    // La copie des consignes renvoie à cette règle, au lieu de la redire à moitié.
    const ligneCopie = lignes.find((ligne) => ligne.includes("**lecture** : même règle d'accès que « Revoir »")) ?? "";
    assert.notEqual(ligneCopie, "", "§8 : la règle de lecture de la copie des consignes est introuvable");
    assert.ok(!ligneCopie.includes("conversation terminée"), "§8 : la copie des consignes redit une règle d'accès qui n'est pas celle du code");
    // Le tableau des routes dit la même chose : s'il parle de demande terminée, il dit pour QUI.
    const ligneRoute = lignes.find((ligne) => ligne.includes("`GET /api/revoir/:conversation`")) ?? "";
    assert.notEqual(ligneRoute, "", "tableau des routes : la route de « Revoir » est introuvable");
    if (ligneRoute.includes("terminée")) {
      for (const attendu of ["Salle OMO", "mode Simple"]) {
        assert.ok(ligneRoute.includes(attendu), `tableau des routes : « demande terminée » sans « ${attendu} » se lit comme une condition générale`);
      }
    }
  });

  it("la version de three citée est celle de package.json, épinglée et exacte", () => {
    const paquet = JSON.parse(lire(path.join(APP_DIR, "package.json"))) as { devDependencies?: Record<string, string> };
    const version = paquet.devDependencies?.three ?? "";
    assert.equal(version, "0.186.0", "three doit rester épinglé à la version exacte (P8, exception permise par décision)");
    for (const [doc, texte] of [["README.md", readme], ["docs/RECAPITULATIF.md", recap]] as const) {
      assert.ok(
        [`three.js ${version}`, `three ${version}`, `three@${version}`].some((forme) => texte.includes(forme)),
        `version de three absente de ${doc}`,
      );
    }
  });
});

describe("croisements it3 V4 : documentation (DOC-3D × le train)", () => {
  const recap = lire(RECAP);
  const ligneM24 = recap.split(/\r?\n/).find((ligne) => ligne.includes("(M24)")) ?? "";

  it("la ligne M24 donne les tailles mesurées au train, et aucune taille périmée", () => {
    assert.notEqual(ligneM24, "", "ligne M24 absente du RECAPITULATIF");
    for (const [quoi, valeur] of Object.entries(MESURES_TRAIN)) {
      assert.ok(ligneM24.includes(valeur), `${quoi} : « ${valeur} » attendu dans la ligne M24 (mesure du train de V4)`);
    }
    for (const perimee of MESURES_PERIMEES) {
      assert.ok(!ligneM24.includes(perimee), `taille périmée « ${perimee} » encore citée : remesurer plutôt que recopier`);
    }
  });

  it("le §10 cite autant de scénarios que le dossier en contient, et aucun compte de tests périmé", () => {
    const validations = sections3d(recap).find((bloc) => bloc.contenu.includes("(M24)"));
    assert.ok(validations, "section [3d] des validations de l'itération 3 introuvable");
    const lignes = validations.contenu.split(/\r?\n/);

    const ligneBanc = lignes.find((ligne) => ligne.includes("run-e2e.sh --faux") && ligne.includes("scénarios")) ?? "";
    assert.notEqual(ligneBanc, "", "ligne du banc de bout en bout absente du §10");
    const cite = /\*\*(\d+) scénarios/.exec(ligneBanc);
    assert.ok(cite, `nombre de scénarios illisible dans la ligne du banc : « ${ligneBanc} »`);
    // La règle d'énumération du banc lui-même (`listerScenarios`, e2e/lib/docker-e2e.mjs) : tous les `.mjs` du dossier des
    // scénarios, les `*-commun.mjs` compris, que le banc joue aussi.
    const reels = listerScenarios(null, SCENARIOS_DIR).length;
    assert.equal(
      Number(cite[1]),
      reels,
      `le §10 donne le banc COMPLET pour ${cite[1]} scénarios, le dossier en contient ${reels} : rejouer le banc entier, ou dire lesquels ont été joués à part`,
    );

    // Constat de la revue d'itération 3 : le §10 annonçait « 19 verts » et « cinq des six » de l'itération 3 alors que le banc
    // avait été rejoué EN ENTIER, vert, sur cette tête. Le compte de verts est donc lu lui aussi, et croisé avec le verdict :
    // « aucun échec » et un compte de verts inférieur au nombre de scénarios joués ne peuvent pas coexister, dans un sens
    // comme dans l'autre — un document qui sous-déclare son banc est aussi faux qu'un document qui le surdéclare.
    const verts = /\*\*(\d+) verts\*\*/.exec(ligneBanc);
    assert.ok(verts, `nombre de scénarios verts illisible dans la ligne du banc : « ${ligneBanc} »`);
    assert.ok(
      Number(verts[1]) <= reels,
      `le §10 donne ${verts[1]} scénarios verts pour ${reels} joués : un banc ne rend pas plus de verts que de scénarios`,
    );
    // Le verdict du banc du train est épinglé, comme les tailles de `MESURES_TRAIN` : le banc complet rejoué sur la tête
    // `28823b6` est vert, donc le §10 le dit, et les verts sont aussi nombreux que les scénarios joués.
    assert.ok(
      ligneBanc.includes(BANC_TRAIN.verdict),
      `§10 : le banc du train est vert (« ${BANC_TRAIN.verdict} ») ; s'il ne l'est plus, rejouer et mettre les deux à jour`,
    );
    assert.equal(
      Number(verts[1]),
      reels,
      `le §10 dit « ${BANC_TRAIN.verdict} » et ne compte que ${verts[1]} scénarios verts sur ${reels} joués`,
    );

    const ligneTests = lignes.find((ligne) => ligne.includes("`npm test`")) ?? "";
    assert.notEqual(ligneTests, "", "ligne des tests automatisés absente du §10");
    for (const perime of TESTS_PERIMES) {
      assert.ok(!ligneTests.includes(perime), `compte de tests périmé « ${perime} » encore cité au §10 : remesurer plutôt que recopier`);
    }
  });

  it("la ligne de sortie l.1174 (L33 : script couleurs, captures) a sa mesure au §10, et les huit lignes du §7.7 sont nommées", () => {
    const validations = sections3d(recap).find((bloc) => bloc.contenu.includes("(M24)"));
    assert.ok(validations, "section [3d] des validations de l'itération 3 introuvable");
    const lignes = validations.contenu.split(/\r?\n/);

    // Une ligne de sortie ne se déclare pas tenue sans mesure : L33 a la sienne, avec ses chiffres (L33 §1 et §3, train de V4).
    const l33 = lignes.find((ligne) => ligne.includes("(L33)")) ?? "";
    assert.notEqual(l33, "", "§10 : aucune ligne pour L33 (script couleurs, captures) : la l.1174 du §7.7 serait tenue sans mesure");
    for (const attendu of ["4,5:1", "3:1", "90 captures", "0 violation"]) {
      assert.ok(l33.includes(attendu), `§10, ligne L33 : « ${attendu} » attendu (seuils du script couleurs, nombre de captures, CSP)`);
    }

    // Le §7.7 a HUIT lignes, l.1169 à l.1176 ; chacune est nommée par son numéro, et « sept » n'a plus cours.
    const sorties = lignes.find((ligne) => ligne.includes("Lignes de sortie")) ?? "";
    assert.notEqual(sorties, "", "§10 : ligne « Lignes de sortie de la spécification » introuvable");
    assert.ok(sorties.includes("huit"), "§10 : le §7.7 compte huit lignes de sortie (l.1169 à l.1176)");
    assert.ok(!/(?<![\p{L}])sept(?![\p{L}])/u.test(sorties), "§10 : « sept » lignes de sortie, une manque (la l.1174, L33)");
    for (const numero of [1169, 1170, 1171, 1172, 1173, 1174, 1175, 1176]) {
      assert.ok(sorties.includes(`l.${numero}`), `§10 : la ligne l.${numero} du §7.7 n'est pas nommée`);
    }

    // Constat de la revue d'itération 3, l'autre moitié : la l.1176 (M20, « run-e2e.sh sortie 0 ») était donnée « en attente »
    // alors que le banc, rejoué sur la tête `28823b6`, l'avait mesurée verte. Même idiome que `MESURES_TRAIN` pour les
    // tailles : le verdict du banc du train est épinglé ici, et le §10 comme le §11 doivent le dire.
    const limites = sections3d(recap).find((bloc) => bloc.contenu.includes("Recettes en attente"));
    assert.ok(limites, "§11 : section [3d] des limites de l'itération 3 introuvable");
    const m20 = lignes.find((ligne) => ligne.includes("(M20)")) ?? "";
    assert.notEqual(m20, "", "§10 : ligne du débit (M20) introuvable");
    assert.ok(
      sorties.includes(BANC_TRAIN.sorties),
      `§10 : les huit lignes de sortie doivent être données « ${BANC_TRAIN.sorties} » — le banc du train les a toutes mesurées`,
    );
    assert.ok(
      !/en attente/i.test(sorties) || /[Aa]ucune n'est en attente/.test(sorties),
      "§10 : une ligne de sortie est donnée « en attente » alors que le banc du train les a toutes mesurées (l.1176 comprise)",
    );
    assert.ok(
      m20.includes(BANC_TRAIN.debit),
      `§10, ligne M20 : plafond « ${BANC_TRAIN.debit} » attendu (mesure du train, trois passages)`,
    );
    for (const perime of BANC_PERIME) {
      for (const [ou, bloc] of [["§10", validations.contenu], ["§11", limites.contenu]] as const) {
        assert.ok(
          !bloc.includes(perime),
          `${ou} : verdict périmé « ${perime} », d'un passage d'avant la correction du débit : rejouer le banc plutôt que recopier`,
        );
      }
    }
  });

  it("les comptes qui varient d'un passage à l'autre sont datés, jamais donnés pour des mesures stables", () => {
    // Écart relevé par la revue d'itération 3 : « 9 moments sur 9 », « 36 images au premier zoom », « curseur de 8 à 7 » et
    // « 94 images dessinées en 3D » étaient des relevés d'UN passage, écrits comme des valeurs stables. Cinq passages du MÊME
    // code donnent cinq comptes (le regroupement des moments suit l'horodatage réel des faits ; le nombre d'images suit la
    // fenêtre de mesure). Ce que le scénario vérifie, lui, est une règle (forme du relevé, contrôle non vide) : la
    // documentation doit donner la règle, et dater le chiffre quand elle en donne un. Quelle règle exactement, c'est le
    // test suivant qui le relit dans le scénario.
    const validations = sections3d(recap).find((bloc) => bloc.contenu.includes("(M24)"));
    assert.ok(validations, "section [3d] des validations de l'itération 3 introuvable");
    const lignes = validations.contenu.split(/\r?\n/);
    const date = /au passage du \d{1,2} \p{L}+ \d{4}/u;

    for (const [repere, quoi] of [
      ["**« Revoir »**", "moments rejoués"],
      ["La 3D a réellement dessiné", "images du premier zoom"],
      ["**Clavier seul**", "curseur des moments"],
      ["(M20)", "images de scène dessinées en 3D"],
    ] as const) {
      const ligne = lignes.find((l) => l.includes(repere)) ?? "";
      assert.notEqual(ligne, "", `§10 : ligne « ${repere} » introuvable`);
      assert.ok(date.test(ligne), `§10, ligne « ${repere} » : le compte de ${quoi} varie d'un passage à l'autre, il doit être daté (« au passage du … »)`);
    }

    // Et les comptes d'un seul passage, déjà démentis par les rejeux, ne reviennent pas.
    for (const perime of ["9 moments sur 9", "36 images", "de 8 à 7", "94 images"]) {
      assert.ok(!validations.contenu.includes(perime), `§10 : compte d'un seul passage « ${perime} » de nouveau donné pour stable`);
    }
  });

  it("la règle que le §10 prête à « Revoir » est celle que `it3-revoir` vérifie vraiment, relue dans le scénario", () => {
    // Constat des contre-vérificateurs de la revue d'itération 3, symétrique du constat 14 : en remplaçant un compte périmé
    // par une règle, le §10 avait annoncé une règle PLUS FORTE que le contrôle — « le scénario exige N sur N », et des
    // moments rejoués « depuis la bande comme depuis les Archives ». Le scénario ne contrôle que la FORME du compteur, aux
    // deux endroits où il le lit ; il ne compare pas ses deux nombres ; et il ne promène le lecteur sur tous les moments que
    // depuis la bande. Une régression qui ouvrirait « Revoir » au moment 3 sur 8 le laisserait donc VERT. La règle est
    // relue ici DANS le scénario : si le scénario se renforce, cette garde tombe et le §10 est réécrit avec lui.
    const scenario = lire(path.join(SCENARIOS_DIR, "it3-revoir.mjs"));
    const FORME_COMPTEUR = "/^\\d+ \\/ \\d+$/.test(";
    const corpsDe = (nom: string): string => {
      const debut = scenario.indexOf(`async function ${nom}(`);
      assert.notEqual(debut, -1, `it3-revoir : fonction \`${nom}\` introuvable`);
      const fin = scenario.indexOf("\n}\n", debut);
      assert.notEqual(fin, -1, `it3-revoir : fin de la fonction \`${nom}\` introuvable`);
      return scenario.slice(debut, fin);
    };

    // 1. Tout contrôle du scénario qui porte sur le compteur des moments est un contrôle de FORME, et il y en a deux : celui
    //    de la bande et celui des Archives. Une égalité `n === N` ajoutée ici ferait un troisième contrôle, et la garde le dit.
    const surLeCompteur = scenario.split("\n").filter((ligne) => ligne.includes("exiger(") && /\b(?:rang|moments)\b/.test(ligne));
    assert.equal(
      surLeCompteur.length,
      2,
      `it3-revoir : ${surLeCompteur.length} contrôle(s) portent sur le compteur des moments, deux attendus (bande et Archives) — si le scénario en a gagné un, le §10 doit dire la règle nouvelle`,
    );
    for (const controle of surLeCompteur) {
      assert.ok(
        controle.includes(FORME_COMPTEUR),
        `it3-revoir : un contrôle du compteur n'est pas un contrôle de forme : « ${controle.trim()} » — le §10 ne peut plus dire que seule la forme est vérifiée`,
      );
    }

    // 2. Ce que le scénario vérifie en plus : au moins trois moments, et le lecteur promené AU CLAVIER sur tous les moments
    //    de la boîte — depuis la bande seulement.
    const lecteur = corpsDe("lecteur");
    assert.ok(lecteur.includes("exiger(total >= 3,"), "it3-revoir : le minimum de moments (contrôle non vide du lecteur) a disparu");
    assert.ok(
      /for \(let pas = 0; pas < total; pas\+\+\) await page\.touche\("ArrowLeft"\);/.test(lecteur),
      "it3-revoir : le lecteur n'est plus ramené au premier moment au clavier",
    );
    assert.ok(lecteur.includes('await page.touche("ArrowRight");'), "it3-revoir : le lecteur n'est plus avancé moment par moment au clavier");

    // 3. Depuis les Archives : la boîte est ouverte, le bandeau et le compteur relevés, puis Échap. Aucun moment parcouru.
    const archives = corpsDe("depuisLesArchives");
    assert.ok(archives.includes(FORME_COMPTEUR), "it3-revoir : le compteur n'est plus relevé depuis les Archives");
    assert.ok(archives.includes('page.touche("Escape")'), "it3-revoir : la boîte ouverte depuis les Archives n'est plus refermée");
    assert.ok(
      !/Arrow(?:Left|Right)/.test(archives),
      "it3-revoir : des moments sont désormais parcourus depuis les Archives — le §10 le dit pour la seule bande, il doit suivre",
    );

    // 4. Le §10 dit cela, et rien de plus fort.
    const validations = sections3d(recap).find((bloc) => bloc.contenu.includes("(M24)"));
    assert.ok(validations, "section [3d] des validations de l'itération 3 introuvable");
    assert.ok(
      !/N sur N/.test(validations.contenu),
      "§10 : « N sur N » donné pour la règle vérifiée par le scénario, qui ne contrôle que la forme du compteur — sur-déclaration",
    );
    const lignes = validations.contenu.split("\n");
    const entete = lignes.find((ligne) => ligne.includes("jamais comme une valeur stable")) ?? "";
    assert.notEqual(entete, "", "§10 : en-tête (règle des comptes datés) introuvable");
    assert.ok(entete.includes("« n / N »"), "§10, en-tête : la règle réellement vérifiée (la forme « n / N ») n'est pas donnée");
    assert.ok(/ne compare jamais/.test(entete), "§10, en-tête : l'absence d'égalité entre les deux nombres du compteur n'est pas dite");
    const revoir = lignes.find((ligne) => ligne.includes("**« Revoir »**")) ?? "";
    assert.notEqual(revoir, "", "§10 : ligne « Revoir » introuvable");
    assert.ok(revoir.includes("« n / N »"), "§10, ligne « Revoir » : la forme du compteur, seule règle contrôlée, n'est pas donnée");
    assert.ok(/au clavier/.test(revoir), "§10, ligne « Revoir » : le parcours des moments est au clavier, c'est ce que fait le scénario");
    assert.ok(/\*\*tous\*\* les moments/.test(revoir), "§10, ligne « Revoir » : le parcours de tous les moments de la boîte n'est plus dit");
    assert.ok(
      /aucun moment n'y est parcouru/.test(revoir),
      "§10, ligne « Revoir » : les Archives doivent être dites pour ce qu'elles sont — boîte ouverte, compteur relevé, aucun moment parcouru",
    );
    assert.ok(
      !/moments rejoués, depuis la bande comme depuis les Archives/.test(revoir),
      "§10, ligne « Revoir » : les moments sont de nouveau donnés pour rejoués depuis les Archives",
    );
  });

  it("M25 et M20 sont donnés pour mesurés avec leur mode, jamais à vide", () => {
    const lignes = recap.split(/\r?\n/);
    const m25 = lignes.find((ligne) => ligne.includes("(M25)")) ?? "";
    assert.ok(m25.includes("0 violation"), "M25 sans son résultat");
    assert.ok(m25.includes("HTTPS épinglé"), "M25 sans son mode (porte P-R105 vraie : banc en HTTPS épinglé)");
    const m20 = lignes.find((ligne) => ligne.includes("(M20)")) ?? "";
    assert.ok(/4 recalculs de scène par seconde au plus/.test(m20), "M20 sans son plafond mesuré");
    assert.ok(/aucune seconde de rafale sans le moindre recalcul|le contrôle n'est pas vide/.test(m20), "M20 sans sa preuve de contrôle non vide");
  });
});

describe("croisements it3 V4 : grille de la vague (DOC-3D)", () => {
  const recap = lire(RECAP);

  it("les six recettes en attente sont listées, et aucune n'est déclarée tenue", () => {
    const section = sections3d(recap).find((bloc) => bloc.contenu.includes("Recettes en attente"));
    assert.ok(section, "section des recettes en attente absente");
    for (const recette of RECETTES) {
      assert.ok(section.contenu.includes(recette), `recette en attente absente : ${recette}`);
    }
    assert.ok(section.contenu.includes("Aucune n'a été jouée"), "les recettes doivent être dites non jouées");
    assert.ok(section.contenu.includes("bloquent la publication"), "la portée des recettes en attente doit être dite");
  });

  it("les sections [3d] sont équilibrées et séparées du texte voisin par une ligne vide (D-3d-24)", () => {
    for (const [doc, fichier] of [["README.md", README], ["docs/RECAPITULATIF.md", RECAP]] as const) {
      const texte = lire(fichier);
      const lignes = texte.split(/\r?\n/);
      const sections = sections3d(texte);
      assert.ok(sections.length > 0, `aucune section [3d] dans ${doc}`);
      for (const section of sections) {
        const avant = lignes[section.debut - 2];
        const apres = lignes[section.fin];
        assert.equal(avant?.trim() ?? "", "", `${doc} : ligne non vide avant une balise [3d] (ligne ${section.debut - 1})`);
        assert.equal(apres?.trim() ?? "", "", `${doc} : ligne non vide après une balise [3d] (ligne ${section.fin + 1})`);
      }
    }
  });

  it("tout ce que la 1.1 dit de la salle, de « Revoir » et de three tient dans une section [3d]", () => {
    for (const [doc, fichier] of [["README.md", README], ["docs/RECAPITULATIF.md", RECAP]] as const) {
      const texte = lire(fichier);
      const sections = sections3d(texte);
      // Les lignes de balise elles-mêmes appartiennent à la section : elles nomment ce qu'elle contient.
      const balises = texte.split(/\r?\n/).filter((ligne) => /^<!--\s*\[3d\]/.test(ligne));
      const dedans = [...sections.map((section) => section.contenu), ...balises].join("\n");
      for (const terme of ["#/salle-controle", "three.js", "Revoir cette demande"]) {
        const total = texte.split(terme).length - 1;
        if (total === 0) continue;
        const couverts = dedans.split(terme).length - 1;
        assert.equal(couverts, total, `${doc} : « ${terme} » écrit hors d'une section [3d] (${total - couverts} fois)`);
      }
    }
  });
});
