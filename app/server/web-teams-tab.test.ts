// Tests de l'onglet « Équipes » (L40a ; spécification §5.3 l.896, §5.4 l.909, §5.5, §5.6 ; C §9.10 ; plan d'exécution it4,
// fiche L40a et §2.6 ; décisions U1 et D-eq-13).
// Le modèle pur (web/pages/assistants/teams/teams-tab-model.ts) porte la logique : états de l'onglet, boutons par état d'équipe,
// textes repris de team-texts.ts sans en écrire un seul, ligne d'une équipe installée, galerie, installation, suppression et
// phrase d'un refus. L'interface n'étant pas exécutée par `npm test`, les composants et la feuille de style sont RELUS (contrat
// statique) : aucun texte en dur, [Voir une démonstration] masqué, schéma décoratif (aria-hidden) et liste (`<figure>`) vérité du
// lecteur d'écran, liste seule sous 900 px, bloc `forced-colors` complet.
// MODE SIMPLE FERMÉ (U1) : tant que `ouvertesEnSimple` est faux, en Simple, la liste est en lecture seule et AUCUN bouton ne mène
// à l'éditeur ni à l'installation. L'ouverture tient en UNE LIGNE : les mêmes données avec `ouvertesEnSimple: true` rendent tous
// les boutons, sans qu'aucune autre valeur n'entre en jeu.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import { FLOW_VERSION } from "./shared/team-limits.ts";
import { montant, remplir, TEXTES } from "./shared/team-texts.ts";
import type { FlowEstimate, FlowRow, TeamExampleView, TeamsListResponse, TeamView } from "./shared/team-types.ts";
import {
  buildTeamsTab,
  compterEtapes,
  equipesOuvertes,
  installationDe,
  libelleSchema,
  ligneEquipe,
  MOTS_LIGNE,
  suppressionDe,
  TEAM_ACTIONS,
  type TeamActionId,
  type TeamsTabInput,
  texteRefus,
  texteRefusSuppression,
} from "../web/pages/assistants/teams/teams-tab-model.ts";

const P = TEXTES.partout;
const ONGLET = P.onglet;
const TEAMS_DIR = path.join(import.meta.dirname, "..", "web", "pages", "assistants", "teams");

// --- Fixtures ---------------------------------------------------------------------------------------------------------------

const LIGNES: FlowRow[] = [
  { bloc: "b1", kind: "etape", cellules: [{ stepId: "standards", titre: "Standards", sousTitre: "relire-script" }], recoitDe: [] },
  { bloc: "b2", kind: "pause", cellules: [{ stepId: null, titre: "Pause", sousTitre: "" }], recoitDe: [] },
  {
    bloc: "b3",
    kind: "avis",
    cellules: [
      { stepId: "securite", titre: "Securite", sousTitre: "relire-script" },
      { stepId: "nuit", titre: "Nuit", sousTitre: "relire-script" },
    ],
    recoitDe: ["standards"],
  },
  { bloc: "b3", kind: "synthese", cellules: [{ stepId: "final", titre: "Consolidation", sousTitre: "relire-script" }], recoitDe: ["securite", "nuit"] },
];

const ESTIMATE: FlowEstimate = {
  typique: 0.6,
  maximum: 1.25,
  plafond: 1.25,
  etapesFacturees: 4,
  depassementUnAppel: 0.08,
  relais: 0.03,
  parEtape: [],
};

function equipe(patch: Partial<TeamView> = {}): TeamView {
  return {
    id: "relecture-script",
    titre: "Relecture de script",
    description: "Une phrase.",
    flow: { version: FLOW_VERSION, blocs: [] },
    forme: "mixte",
    origine: "exemple",
    exempleId: "relecture-script",
    etat: "ok",
    estimate: ESTIMATE,
    layout: LIGNES,
    liste: ["Etape 1 : Standards", "Pause", "Etape 2 : Securite"],
    droits: [],
    dernierLancement: null,
    ...patch,
  };
}

function exemple(patch: Partial<TeamExampleView> = {}): TeamExampleView {
  return {
    id: "revue-sql",
    titre: "Revue SQL",
    description: "Une phrase.",
    flow: { version: FLOW_VERSION, blocs: [] },
    installee: false,
    assistantsManquants: [],
    layout: LIGNES,
    liste: ["Etape 1 : Exactitude"],
    ...patch,
  };
}

function donnees(patch: Partial<TeamsListResponse> = {}): TeamsListResponse {
  return { teams: [equipe()], exemples: [exemple()], ouvertesEnSimple: false, ...patch };
}

/** Entrée du modèle ; `dateDe` rend une date déjà écrite : aucune date n'est formatée dans le modèle. */
function entree(patch: Partial<TeamsTabInput> = {}): TeamsTabInput {
  return { advanced: true, donnees: donnees(), chargement: false, erreur: null, dateDe: () => "12 sept. 2026, 10:30", ...patch };
}

const actionsDe = (modele: ReturnType<typeof buildTeamsTab>, index = 0) => modele.equipes[index]?.actions ?? [];
const idsDe = (modele: ReturnType<typeof buildTeamsTab>, index = 0) => actionsDe(modele, index).map((a) => a.id);
const actifsDe = (modele: ReturnType<typeof buildTeamsTab>, index = 0) => actionsDe(modele, index).filter((a) => !a.desactive).map((a) => a.id);

// --- États de l'onglet --------------------------------------------------------------------------------------------------------

describe("onglet Équipes : états", () => {
  it("rien de lu : l'onglet attend, sans affirmer « aucune équipe » ; une lecture en échec montre sa phrase", () => {
    assert.equal(buildTeamsTab(entree({ donnees: null, chargement: true })).affichage, "chargement");
    assert.equal(buildTeamsTab(entree({ donnees: null, chargement: false })).affichage, "chargement");
    const casse = buildTeamsTab(entree({ donnees: null, chargement: false, erreur: "Lecture impossible." }));
    assert.equal(casse.affichage, "erreur");
    assert.equal(casse.erreur, "Lecture impossible.");
    assert.deepEqual(casse.equipes, []);
    // Nouvelle lecture en cours après un échec : l'onglet attend au lieu de garder la phrase d'erreur.
    assert.equal(buildTeamsTab(entree({ donnees: null, chargement: true, erreur: "Lecture impossible." })).affichage, "chargement");
  });

  it("aucune équipe installée : définition, phrase d'accueil, [Partir d'un exemple] et la galerie", () => {
    const modele = buildTeamsTab(entree({ donnees: donnees({ teams: [] }) }));
    assert.equal(modele.affichage, "vide");
    assert.equal(modele.vide?.definition, P.definition);
    assert.equal(modele.vide?.accueil, P.accueil);
    assert.equal(modele.vide?.partirExemple, ONGLET.partirExemple);
    assert.equal(modele.galerie?.exemples.length, 1);
    assert.equal(modele.nouvelle, ONGLET.nouvelle);
  });

  it("équipes installées : la liste, la galerie et [Nouvelle équipe]", () => {
    const modele = buildTeamsTab(entree());
    assert.equal(modele.affichage, "equipes");
    assert.equal(modele.vide, null);
    assert.equal(modele.equipes.length, 1);
    assert.equal(modele.titre, ONGLET.titre);
    assert.equal(modele.galerie?.titre, ONGLET.galerie);
  });
});

// --- Mode Simple fermé (U1, D-eq-13) ------------------------------------------------------------------------------------------

describe("onglet Équipes : mode Simple fermé, ouverture en une ligne (U1)", () => {
  it("Simple fermé : texte du §2.6, liste en lecture seule, aucun bouton vers l'éditeur ni vers l'installation", () => {
    const modele = buildTeamsTab(entree({ advanced: false }));
    assert.equal(modele.affichage, "ferme");
    assert.equal(modele.ferme, TEXTES.simple.fermees);
    assert.equal(modele.lectureSeule, true);
    assert.equal(modele.nouvelle, null, "[Nouvelle équipe] absent");
    assert.equal(modele.galerie, null, "aucun chemin vers l'installation");
    assert.equal(modele.vide, null);
    assert.equal(modele.equipes.length, 1, "la liste reste consultable");
    assert.deepEqual(idsDe(modele), [], "aucun bouton sur les cartes");
  });

  it("Simple fermé sans aucune équipe : le texte du §2.6, sans galerie ni état vide", () => {
    const modele = buildTeamsTab(entree({ advanced: false, donnees: donnees({ teams: [] }) }));
    assert.equal(modele.affichage, "ferme");
    assert.equal(modele.galerie, null);
    assert.equal(modele.vide, null);
  });

  it("ouverture en UNE LIGNE : les mêmes données avec ouvertesEnSimple vrai rendent boutons, galerie et [Nouvelle équipe]", () => {
    const ouvert = buildTeamsTab(entree({ advanced: false, donnees: donnees({ ouvertesEnSimple: true }) }));
    assert.equal(ouvert.affichage, "equipes");
    assert.equal(ouvert.ferme, null);
    assert.equal(ouvert.lectureSeule, false);
    assert.equal(ouvert.nouvelle, ONGLET.nouvelle);
    assert.equal(ouvert.galerie?.exemples.length, 1);
    assert.deepEqual(idsDe(ouvert), [...TEAM_ACTIONS]);
  });

  it("seule ouvertesEnSimple ferme les équipes en Simple : le mode Avancé ne la lit jamais", () => {
    assert.equal(equipesOuvertes(true, donnees({ ouvertesEnSimple: false })), true);
    assert.equal(equipesOuvertes(true, donnees({ ouvertesEnSimple: true })), true);
    assert.equal(equipesOuvertes(false, donnees({ ouvertesEnSimple: false })), false);
    assert.equal(equipesOuvertes(false, donnees({ ouvertesEnSimple: true })), true);
    assert.equal(equipesOuvertes(false, null), false);
    // En Avancé, aucune équipe n'est jamais mise en lecture seule, quel que soit l'état des exemples ou de la liste.
    assert.equal(buildTeamsTab(entree({ advanced: true, donnees: donnees({ teams: [], exemples: [] }) })).lectureSeule, false);
  });
});

// --- Boutons par état ----------------------------------------------------------------------------------------------------------

describe("onglet Équipes : boutons par état d'équipe", () => {
  it("équipe complète : les quatre boutons, tous utilisables, dans l'ordre de la fiche", () => {
    const modele = buildTeamsTab(entree());
    assert.deepEqual(idsDe(modele), ["utiliser", "modifier", "dupliquer", "supprimer"]);
    assert.deepEqual(actifsDe(modele), ["utiliser", "modifier", "dupliquer", "supprimer"]);
    assert.deepEqual(
      actionsDe(modele).map((a) => a.libelle),
      [ONGLET.installees.utiliser, ONGLET.installees.modifier, ONGLET.installees.dupliquer, ONGLET.installees.supprimer],
    );
    assert.deepEqual(
      actionsDe(modele).map((a) => a.raison),
      [null, null, null, null],
    );
  });

  it("« À compléter » : le lancement attend, la modification reste ouverte ; l'état est dit par son MOT", () => {
    const modele = buildTeamsTab(entree({ donnees: donnees({ teams: [equipe({ etat: "a-completer" })] }) }));
    assert.deepEqual(modele.equipes[0]?.etat, {
      code: "a-completer",
      mot: ONGLET.etats["a-completer"],
      aide: ONGLET.etatsAide["a-completer"],
    });
    assert.deepEqual(actifsDe(modele), ["modifier", "dupliquer", "supprimer"]);
    assert.equal(actionsDe(modele)[0]?.raison, ONGLET.etatsAide["a-completer"]);
  });

  it("« Réglée en mode Avancé » : tout est ouvert en Avancé ; en Simple ouvert, seule la suppression reste", () => {
    const avance = donnees({ teams: [equipe({ etat: "avance" })], ouvertesEnSimple: true });
    const enAvance = buildTeamsTab(entree({ advanced: true, donnees: avance }));
    assert.deepEqual(actifsDe(enAvance), ["utiliser", "modifier", "dupliquer", "supprimer"]);
    assert.equal(enAvance.equipes[0]?.etat?.mot, ONGLET.etats.avance);

    const enSimple = buildTeamsTab(entree({ advanced: false, donnees: avance }));
    assert.deepEqual(actifsDe(enSimple), ["supprimer"]);
    for (const action of actionsDe(enSimple).filter((a) => a.desactive)) assert.equal(action.raison, ONGLET.etatsAide.avance);
  });

  it("équipe complète : aucun état affiché (pas de mot inutile)", () => {
    assert.equal(buildTeamsTab(entree()).equipes[0]?.etat, null);
  });
});

// --- Ligne d'une équipe installée ------------------------------------------------------------------------------------------------

describe("onglet Équipes : ligne d'une équipe installée", () => {
  it("gabarit de T4t rempli, montants écrits par montant() (jamais formatUsd)", () => {
    const team = equipe({ dernierLancement: { at: 1_757_000_000_000, cost: 0.42 } });
    const ligne = ligneEquipe(team, "12 sept. 2026, 10:30");
    assert.equal(
      ligne,
      remplir(ONGLET.installees.ligne, {
        titre: team.titre,
        forme: P.formes.mixte,
        n: 4,
        typique: 0.6,
        date: "12 sept. 2026, 10:30",
        cout: 0.42,
      }),
    );
    assert.ok(ligne.includes(`${montant(0.6)} $`), ligne);
    assert.ok(ligne.includes(`${montant(0.42)} $`), ligne);
    assert.ok(ligne.includes(P.formes.mixte));
  });

  it("jamais lancée : la ligne le dit, sans date inventée", () => {
    const ligne = ligneEquipe(equipe(), null);
    assert.equal(ligne, remplir(ONGLET.installees.ligneJamais, { titre: "Relecture de script", forme: P.formes.mixte, n: 4, typique: 0.6 }));
    assert.ok(!ligne.includes("2026"));
  });

  it("prix inconnu : le montant est « — », jamais un chiffre inventé", () => {
    const ligne = ligneEquipe(equipe({ estimate: null }), null);
    assert.ok(ligne.includes("— $"), ligne);
  });

  it("le modèle ne formate aucune date : dateDe est la seule source de la date", () => {
    const team = equipe({ dernierLancement: { at: 1_757_000_000_000, cost: 1 } });
    const modele = buildTeamsTab(entree({ donnees: donnees({ teams: [team] }), dateDe: () => "DATE" }));
    assert.ok(modele.equipes[0]?.ligne.includes("DATE"), modele.equipes[0]?.ligne);
  });
});

// --- Schéma lu ------------------------------------------------------------------------------------------------------------------

describe("onglet Équipes : schéma lu", () => {
  it("les étapes sont comptées sur la disposition du serveur ; les pauses n'en sont pas", () => {
    assert.equal(compterEtapes(LIGNES), 4);
    assert.equal(compterEtapes([]), 0);
    assert.equal(compterEtapes([LIGNES[1] as FlowRow]), 0);
  });

  it("libellé chiffré : « {forme} · {n} étapes », ou « {n} étapes » sans forme connue (exemples)", () => {
    assert.equal(libelleSchema(LIGNES, "avis"), `${P.formes.avis} · ${remplir(ONGLET.etapes, { n: 4 })}`);
    assert.equal(libelleSchema(LIGNES, null), remplir(ONGLET.etapes, { n: 4 }));
    assert.ok(/\b4\b/.test(libelleSchema(LIGNES, null)), "le libellé est chiffré");
  });

  it("chaque genre de ligne a son MOT, repris de team-texts (jamais la couleur seule)", () => {
    assert.deepEqual(MOTS_LIGNE, {
      etape: P.etape,
      avis: P.formes.avis,
      synthese: P.editeur.synthese,
      pause: P.execution.pause,
    });
    for (const mot of Object.values(MOTS_LIGNE)) assert.ok(mot.length > 0);
  });

  it("le modèle rend la disposition et la liste du serveur telles quelles", () => {
    const modele = buildTeamsTab(entree());
    assert.equal(modele.equipes[0]?.layout, LIGNES);
    assert.deepEqual(modele.equipes[0]?.liste, equipe().liste);
    assert.equal(modele.galerie?.exemples[0]?.liste.length, 1);
  });
});

// --- Galerie et installation -------------------------------------------------------------------------------------------------------

describe("onglet Équipes : galerie et installation", () => {
  it("carte d'exemple : phrase, « Lecture seule », [Aperçu] [Installer] ; « ≈ X $ en général » seulement quand l'aperçu l'a rendu", () => {
    const sansCout = buildTeamsTab(entree()).galerie?.exemples[0];
    assert.equal(sansCout?.cout, null, "aucun coût inventé tant que l'aperçu n'a rien rendu");
    assert.equal(sansCout?.lectureSeule, ONGLET.lectureSeule);
    assert.equal(sansCout?.libelleApercu, ONGLET.apercu);
    assert.equal(sansCout?.libelleInstaller, ONGLET.installer);
    assert.equal(sansCout?.installable, true);

    const avecCout = buildTeamsTab(entree({ coutsExemples: { "revue-sql": 0.6 } })).galerie?.exemples[0];
    assert.equal(avecCout?.cout, remplir(ONGLET.enGeneral, { typique: 0.6 }));
    assert.ok(avecCout?.cout?.includes(`${montant(0.6)} $`));
  });

  it("exemple déjà installé : « Déjà installée », bouton fermé", () => {
    const carte = buildTeamsTab(entree({ donnees: donnees({ exemples: [exemple({ installee: true })] }) })).galerie?.exemples[0];
    assert.equal(carte?.libelleInstaller, ONGLET.installee);
    assert.equal(carte?.installable, false);
  });

  it("installation : titre de l'exemple, liste du déroulé, et les assistants posés en plus", () => {
    const seul = installationDe(exemple({ assistantsManquants: ["relire-script"] }));
    assert.equal(seul.titre, remplir(ONGLET.installation.titre, { titre: "Revue SQL" }));
    assert.equal(seul.aussi, remplir(ONGLET.installation.aussi, { nom: "relire-script" }));
    assert.equal(seul.installer, ONGLET.installation.installer);
    assert.equal(seul.annuler, ONGLET.installation.annuler);
    assert.equal(seul.libelleSchema, libelleSchema(LIGNES, null));

    const plusieurs = installationDe(exemple({ assistantsManquants: ["relire-script", "relire-requete-sql"] }));
    assert.ok(plusieurs.aussi?.includes("relire-requete-sql"), plusieurs.aussi ?? "");
    assert.equal(installationDe(exemple()).aussi, null, "rien à dire quand aucun assistant n'est ajouté");
  });
});

// --- Suppression et refus -------------------------------------------------------------------------------------------------------

describe("onglet Équipes : suppression et refus", () => {
  it("suppression confirmée : les lancements passés et les assistants de l'équipe ne sont pas touchés", () => {
    const boite = suppressionDe("Relecture de script");
    assert.equal(boite.titre, remplir(ONGLET.suppression.titre, { titre: "Relecture de script" }));
    assert.equal(boite.message, ONGLET.suppression.message);
    assert.ok(boite.message.includes("Les lancements passés restent dans le déroulé des conversations."));
    assert.ok(boite.message.includes("Les assistants de l'équipe ne sont pas supprimés."));
    assert.equal(boite.confirmer, ONGLET.suppression.confirmer);
    assert.equal(boite.annuler, ONGLET.suppression.annuler);
  });

  it("garde de rechargement : son message est rendu TEL QUEL (T4t n'écrit aucun texte pour ces codes)", () => {
    for (const code of ["sessions-busy", "redemarrage-en-cours", "reponses-non-verifiables"]) {
      assert.equal(texteRefus({ error: code, message: "Message de la garde." }, "repli"), "Message de la garde.");
    }
  });

  it("code d'équipe connu : la phrase de T4t ; code inconnu : le repli du serveur", () => {
    assert.equal(texteRefus({ error: "equipes-simple-fermees", message: "autre" }, "repli"), TEXTES.simple.fermees);
    assert.equal(texteRefus({ error: "not-found", message: "autre" }, "repli"), P.erreurs["not-found"]);
    assert.equal(texteRefus({ error: "code-hors-liste", message: "autre" }, "repli"), P.erreurInconnue);
    assert.equal(texteRefus(null, "repli"), "repli");
  });

  it("suppression refusée pendant un lancement : la phrase propre à la suppression", () => {
    assert.equal(texteRefusSuppression({ error: "equipe-en-cours", message: "autre" }, "repli"), ONGLET.suppression.enCours);
    assert.notEqual(ONGLET.suppression.enCours, P.erreurs["equipe-en-cours"]);
    assert.equal(texteRefusSuppression({ error: "sessions-busy", message: "Message de la garde." }, "repli"), "Message de la garde.");
    assert.equal(texteRefusSuppression(null, "repli"), "repli");
  });
});

// --- Contrat statique des composants et de la feuille -----------------------------------------------------------------------------

const lire = (fichier: string) => fs.readFileSync(path.join(TEAMS_DIR, fichier), "utf8");

/** Source sans commentaires (chaînes gardées). */
function sansCommentaires(texte: string): string {
  let out = "";
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
      const debut = i;
      i += 1;
      while (i < texte.length && texte[i] !== c) i += texte[i] === "\\" ? 2 : 1;
      i += 1;
      out += texte.slice(debut, i);
      continue;
    }
    out += c;
    i += 1;
  }
  return out;
}

/** Une majuscule suivie d'une minuscule, ou une lettre accentuée : la marque d'un texte affichable écrit en dur. */
const TEXTE_EN_DUR = /[A-ZÀ-Ý][a-zà-ÿ]|[À-ÿ]/;

/** Chaînes d'un source, chemins de modules retirés (un nom de fichier n'est pas un texte affiché). */
function chainesAffichables(source: string): string[] {
  const code = sansCommentaires(source)
    .replace(/\bfrom\s+"[^"]*"/g, "from \"\"")
    .replace(/^\s*import\s+"[^"]*";/gm, "");
  const simples = [...code.matchAll(/"([^"\n]*)"/g)].map((m) => m[1] ?? "");
  const gabarits = [...code.matchAll(/`([^`]*)`/g)].map((m) => (m[1] ?? "").replace(/\$\{[^}]*\}/g, ""));
  return [...simples, ...gabarits].filter((chaine) => TEXTE_EN_DUR.test(chaine));
}

const SOURCES = ["TeamsTab.tsx", "TeamGallery.tsx", "TeamInstallDialog.tsx", "TeamCard.tsx", "FlowSchema.tsx", "FlowList.tsx", "teams-tab-model.ts"];

describe("onglet Équipes : contrat statique des sources", () => {
  it("contrôles discriminants : un texte affichable écrit en dur est vu, un chemin de module ne l'est pas", () => {
    assert.deepEqual(chainesAffichables('const a = "btn primary"; const b = "a-completer";'), []);
    assert.deepEqual(chainesAffichables('import { X } from "./FlowList.tsx";'), []);
    assert.deepEqual(chainesAffichables('import "./teams.css";'), []);
    assert.deepEqual(chainesAffichables('const t = "Nouvelle équipe";'), ["Nouvelle équipe"]);
    assert.deepEqual(chainesAffichables("const t = `Installer ${id}`;"), ["Installer "]);
    assert.deepEqual(chainesAffichables('// const t = "Nouvelle équipe";\nconst a = 1;'), []);
  });

  it("aucun texte en dur : tous les textes viennent de team-texts.ts, par le modèle pur", () => {
    for (const fichier of SOURCES) assert.deepEqual(chainesAffichables(lire(fichier)), [], fichier);
  });

  it("aucun texte de l'interface entre deux balises JSX (tout passe par une expression)", () => {
    for (const fichier of SOURCES.filter((f) => f.endsWith(".tsx"))) {
      assert.doesNotMatch(sansCommentaires(lire(fichier)), />[ \t]*[\p{L}][^<{}\n]*<\//u, fichier);
    }
  });

  it("[Voir une démonstration] MASQUÉ : la démonstration d'équipe arrive en itération 5 (P3)", () => {
    for (const fichier of [...SOURCES, "teams.css"]) {
      assert.doesNotMatch(sansCommentaires(lire(fichier)), /d[ée]monstration/i, fichier);
    }
  });

  it("montants : jamais formatUsd, qui ajoute déjà « $ » (report MX-EQ §4.2)", () => {
    for (const fichier of SOURCES) assert.doesNotMatch(sansCommentaires(lire(fichier)), /formatUsd/, fichier);
  });

  it("TeamsTab remplace le squelette de T4w et garde les propriétés figées", () => {
    const source = lire("TeamsTab.tsx");
    assert.equal(source.split("\n")[0], "// Propriétaire : L40a.");
    assert.doesNotMatch(source, /Squelette T4w/);
    assert.match(source, /import type \{ TeamsTabProps \} from "\.\.\/\.\.\/chat\/team\/slots\.ts";/);
    assert.match(source, /export function TeamsTab\(\{ advanced \}: TeamsTabProps\)/);
    // L'ouverture en Simple ne se lit que par le modèle : aucun autre drapeau dans le composant.
    assert.match(source, /equipesOuvertes\(advanced, data\)/);
    assert.doesNotMatch(sansCommentaires(source), /EQUIPES_SIMPLE_OUVERTES/);
  });

  it("schéma décoratif, liste vérité : aria-hidden sur le schéma ET sur chaque connecteur, `<figure>` et libellé chiffré", () => {
    const schema = sansCommentaires(lire("FlowSchema.tsx"));
    assert.match(schema, /className=\{`tm-schema\$\{mini \? " mini" : ""\}`\} aria-hidden="true"/);
    assert.match(schema, /<svg className="tm-connecteur"[^>]*aria-hidden="true"/);
    assert.doesNotMatch(schema, /aria-label|role="img"/);

    const liste = sansCommentaires(lire("FlowList.tsx"));
    assert.match(liste, /<figure className="tm-figure">/);
    assert.match(liste, /<figcaption className="tm-figure-legende">\{libelle\}<\/figcaption>/);
    assert.match(liste, /<ol className=/);
    assert.doesNotMatch(liste, /aria-hidden/, "la liste n'est jamais cachée au lecteur d'écran");
  });

  it("aucune animation, aucun raccourci clavier, aucun focus pris sans un clic", () => {
    for (const fichier of SOURCES.filter((f) => f.endsWith(".tsx"))) {
      const code = sansCommentaires(lire(fichier));
      assert.doesNotMatch(code, /\.animate\(|setInterval|requestAnimationFrame|autoFocus/, fichier);
      assert.doesNotMatch(code, /addEventListener\("keydown"/, fichier);
    }
    // Un seul appel à focus() : celui que [Partir d'un exemple] déclenche, sur le clic de l'utilisateur.
    assert.equal((sansCommentaires(lire("TeamsTab.tsx")).match(/\.focus\(/g) ?? []).length, 1);
  });
});

// --- Feuille de style : contraste forcé (U9) et 900 px (§5.6) ---------------------------------------------------------------------

/** Contenu d'un bloc @media dont l'en-tête correspond, commentaires retirés ; null quand le bloc est absent. */
function blocMedia(css: string, entete: RegExp): string | null {
  const code = css.replace(/\/\*[\s\S]*?\*\//g, " ");
  const debut = code.search(entete);
  if (debut === -1) return null;
  const ouverture = code.indexOf("{", debut);
  if (ouverture === -1) return null;
  let profondeur = 0;
  for (let i = ouverture; i < code.length; i += 1) {
    if (code[i] === "{") profondeur += 1;
    else if (code[i] === "}") {
      profondeur -= 1;
      if (profondeur === 0) return code.slice(ouverture + 1, i);
    }
  }
  return null;
}

describe("onglet Équipes : feuille teams.css", () => {
  const css = lire("teams.css");

  it("contrôles discriminants : bloc absent ou en commentaire refusé", () => {
    assert.equal(blocMedia(".a { color: red; }", /@media[^{]*\(\s*forced-colors\s*:\s*active\s*\)/i), null);
    assert.equal(blocMedia("/* @media (forced-colors: active) { .a { color: CanvasText; } } */", /@media[^{]*\(\s*forced-colors\s*:\s*active\s*\)/i), null);
    assert.equal(blocMedia("@media (forced-colors: active) { .a { color: CanvasText; } }", /@media[^{]*\(\s*forced-colors\s*:\s*active\s*\)/i)?.trim(), ".a { color: CanvasText; }");
  });

  it("contraste forcé (U9) : connecteurs en stroke CanvasText, cartes et mini-schémas bordés, focus en Highlight", () => {
    const force = blocMedia(css, /@media[^{]*\(\s*forced-colors\s*:\s*active\s*\)/i);
    assert.ok(force, "bloc @media (forced-colors: active) présent");
    assert.match(force, /\.tm-connecteur-trait\s*\{[^}]*stroke:\s*CanvasText/);
    assert.match(force, /\.tm-carte,[\s\S]*?\.tm-schema-cellule\s*\{[^}]*border:\s*1px solid CanvasText/);
    assert.match(force, /outline:\s*2px solid Highlight/);
    assert.match(force, /\.tm-etat[\s\S]*?border:\s*1px solid CanvasText/, "les états restent bordés, leur mot reste lisible");
  });

  it("900 px (§5.6) : la liste seule en dessous, le schéma au-dessus, la liste toujours dans l'arbre d'accessibilité", () => {
    assert.match(css, /\.tm-schema\s*\{\s*display:\s*none;\s*\}/, "schéma caché par défaut (sous 900 px)");
    const large = blocMedia(css, /@media\s*\(\s*min-width:\s*901px\s*\)/i);
    assert.ok(large, "bloc @media (min-width: 901px) présent");
    assert.match(large, /\.tm-schema\s*\{[^}]*display:\s*flex/);
    assert.match(large, /\.tm-figure-liste:not\(\.visible\)\s*\{[^}]*clip:\s*rect\(0 0 0 0\)/, "la liste passe hors de l'écran, jamais display: none");
    assert.doesNotMatch(large, /\.tm-figure-liste:not\(\.visible\)\s*\{[^}]*display:\s*none/);
  });

  it("mouvement : aucune animation ; la seule transition est sous prefers-reduced-motion: no-preference", () => {
    assert.doesNotMatch(css.replace(/\/\*[\s\S]*?\*\//g, " "), /\banimation(-name)?\s*:/);
    const mouvement = blocMedia(css, /@media\s*\(\s*prefers-reduced-motion:\s*no-preference\s*\)/i);
    assert.ok(mouvement, "bloc prefers-reduced-motion présent");
    assert.match(mouvement, /transition:/);
    const horsBloc = css.replace(/\/\*[\s\S]*?\*\//g, " ").replace(mouvement, " ");
    assert.doesNotMatch(horsBloc, /transition\s*:/);
  });

  it("genre d'une ligne du schéma : une forme propre par genre, en plus du mot", () => {
    const formes = ["etape", "avis", "synthese", "pause"] as const;
    const rayons = formes.map((genre) => new RegExp(`\\.tm-schema-cellule\\.tm-kind-${genre}\\s*\\{([^}]*)\\}`).exec(css)?.[1] ?? "");
    for (const [index, regle] of rayons.entries()) assert.match(regle, /border-radius|border-left-width/, formes[index] ?? "");
    assert.equal(new Set(rayons).size, formes.length, "chaque genre a sa propre forme");
  });
});

// --- Couverture des identifiants d'action ------------------------------------------------------------------------------------------

describe("onglet Équipes : couverture", () => {
  it("chaque identifiant d'action a un libellé de T4t, sans doublon", () => {
    const attendus: Record<TeamActionId, string> = {
      utiliser: ONGLET.installees.utiliser,
      modifier: ONGLET.installees.modifier,
      dupliquer: ONGLET.installees.dupliquer,
      supprimer: ONGLET.installees.supprimer,
    };
    const modele = buildTeamsTab(entree());
    assert.deepEqual(new Set(TEAM_ACTIONS), new Set(Object.keys(attendus)));
    for (const action of actionsDe(modele)) assert.equal(action.libelle, attendus[action.id]);
    assert.equal(new Set(Object.values(attendus)).size, TEAM_ACTIONS.length);
  });
});
