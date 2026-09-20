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
// Les liens internes et les ancres des deux documents sont déjà contrôlés, pour tout le dépôt, par
// `croisements-it1-v5.test.ts` (« liens internes et ancres de README.md, docs/RECAPITULATIF.md et e2e/README.md ») : ce fichier
// ne les refait pas. Aucun conteneur Docker, aucun vrai opencode, aucun appel facturé : tout se joue en Node. Le banc
// (`scripts/run-e2e.sh --faux --scenarios it3-captures --project-prefix 3d11-e2e --image-tag 3d11`) est joué par l'intégrateur,
// hors de `npm test` (décision D-06).
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import { CONSIGNES } from "./shared/consignes.ts";
import { FLUIDITE, PREFERENCE_CLE } from "./shared/fluidity.ts";
import { PLAN3D } from "./shared/neon-plan3d.ts";
import { RACCOURCI, VITESSES } from "./shared/revoir.ts";
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
 * Mesures du build de la branche d'intégration, au train de V4 (`npm run build` dans la copie, journal recopié dans le rapport
 * du train) : morceau de three inchangé depuis le train de V3, CSS augmenté des blocs d'accessibilité de L33. Toute ligne de la
 * documentation qui donne une de ces tailles doit donner CELLE-CI ; sinon, on remesure et on met les deux à jour.
 */
const MESURES_TRAIN = {
  threeBruts: "567 336",
  threeGzip: "142 027",
  principal: "1 675,28 kB",
  principalGzip: "539,09 kB",
  css: "95,92 kB",
  cssGzip: "17,82 kB",
} as const;

/** Tailles d'un build antérieur, refusées nommément dans la ligne M24 (vague 3 et copie de DOC-3D). */
const MESURES_PERIMEES = ["142 026", "93,05 kB", "92,96 kB", "17,41 kB"] as const;

/** Les six recettes en attente du plan it3 §3.3, reconnues par une sous-chaîne propre à chacune. */
const RECETTES = [
  "Seuils de fluidité sur un poste de travail",
  "CSP sous WebGL, sur le poste de travail",
  "**NVDA**",
  "collègue peu à l'aise avec l'IA",
  "Captures sur le poste de travail",
  "Débit sur Copilot réel",
] as const;

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

  it("le scénario est pris par le filtre du banc et cité dans `e2e/README.md`", () => {
    const scenarios = fs.readdirSync(SCENARIOS_DIR).filter((nom) => nom.endsWith(".mjs"));
    assert.ok(scenarios.includes("it3-captures.mjs"), scenarios.join(", "));
    // `--scenarios it3-` et `--scenarios it3-captures` passent par une sous-chaîne du nom du fichier (scripts/run-e2e.sh).
    for (const motif of ["it3-", "it3-captures"]) {
      assert.deepEqual(
        scenarios.filter((nom) => nom.includes(motif) && nom === "it3-captures.mjs"),
        ["it3-captures.mjs"],
        `le filtre « ${motif} » ne prend pas le scénario`,
      );
    }
    assert.ok(lire(path.join(E2E_DIR, "README.md")).includes("`it3-captures.mjs`"), "scénario absent de e2e/README.md");
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
