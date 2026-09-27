// Propriétaire : L40a.
// Modèle PUR de l'onglet « Équipes » (spécification §5.3 l.896, §5.4 l.909, §5.5, §5.6 ; C §9.10 ; plan d'exécution it4, fiche
// L40a et §2.6 ; D-eq-24 : toute la logique testable vit ici, le .tsx reste mince). Testé par server/web-teams-tab.test.ts.
// Aucun texte écrit ici : tout vient de server/shared/team-texts.ts (T4t), gabarits remplis par remplir(), montants par montant()
// à travers remplir() — jamais formatUsd(), qui ajoute déjà « $ » (report MX-EQ §4.2). Aucune date formatée ici : la date du
// dernier lancement arrive déjà écrite (dateDe), pour que le modèle reste déterministe.
// Mode Simple fermé (décision U1, D-eq-13 ; plan §2.6) : la SEULE valeur qui ferme les équipes en Simple est `ouvertesEnSimple`
// de GET /api/teams. L'ouverture tient donc en une ligne (EQUIPES_SIMPLE_OUVERTES = true dans wiring-eq.ts) : rien d'autre, ici,
// ne referme l'onglet. Tant qu'elles sont fermées : texte du §2.6, liste en LECTURE SEULE, aucun bouton vers l'éditeur
// ([Modifier], [Dupliquer], [Nouvelle équipe]) ni vers l'installation (galerie absente).
// [Voir une démonstration] de la spéc. §5.4 l.909 est MASQUÉ : la démonstration d'équipe arrive en itération 5 (P3 : ne jamais
// annoncer une fonction absente). Aucun libellé de démonstration n'existe donc dans ce modèle.
import { TEAM_GUARD_CODES } from "../../../../server/shared/team-limits.ts";
import { installeAussi, phraseErreur, remplir, TEXTES } from "../../../../server/shared/team-texts.ts";
import type { FlowRow, TeamExampleView, TeamsListResponse, TeamView } from "../../../../server/shared/team-types.ts";

const P = TEXTES.partout;
const ONGLET = P.onglet;

/** Codes de la garde de rechargement (409) : leur message est rendu tel quel, T4t n'écrit aucun texte pour eux. */
const GUARD: ReadonlySet<string> = new Set<string>(TEAM_GUARD_CODES);

// --- Schéma lu ------------------------------------------------------------------------------------------------------------------

/** Mot de chaque genre de ligne du schéma : l'état est dit par le MOT et par la forme, jamais par la couleur seule (§2.3). */
export const MOTS_LIGNE: Readonly<Record<FlowRow["kind"], string>> = {
  etape: P.etape,
  avis: P.formes.avis,
  synthese: P.editeur.synthese,
  pause: P.execution.pause,
};

/** Étapes d'un déroulé, comptées sur la disposition rendue par le serveur (les pauses n'en sont pas). */
export function compterEtapes(layout: readonly FlowRow[]): number {
  let n = 0;
  for (const ligne of layout) {
    for (const cellule of ligne.cellules) if (cellule.stepId !== null) n += 1;
  }
  return n;
}

/** Libellé chiffré du `<figure>` (spéc. §5.5) : « {forme} · {n} étapes », ou « {n} étapes » quand la forme est inconnue. */
export function libelleSchema(layout: readonly FlowRow[], forme: TeamView["forme"] | null): string {
  const etapes = remplir(ONGLET.etapes, { n: compterEtapes(layout) });
  return forme === null ? etapes : `${P.formes[forme]} · ${etapes}`;
}

// --- Équipes installées ------------------------------------------------------------------------------------------------------

export type TeamActionId = "utiliser" | "modifier" | "dupliquer" | "supprimer";

/** Ordre des boutons d'une équipe installée (fiche L40a). */
export const TEAM_ACTIONS: readonly TeamActionId[] = ["utiliser", "modifier", "dupliquer", "supprimer"];

const LIBELLES_ACTIONS: Readonly<Record<TeamActionId, string>> = {
  utiliser: ONGLET.installees.utiliser,
  modifier: ONGLET.installees.modifier,
  dupliquer: ONGLET.installees.dupliquer,
  supprimer: ONGLET.installees.supprimer,
};

export interface TeamAction {
  id: TeamActionId;
  libelle: string;
  /** aria-disabled : le bouton reste focalisable pour que sa raison soit lue ; il ne fait rien. */
  desactive: boolean;
  /** Phrase de la raison ; null quand le bouton est utilisable. */
  raison: string | null;
}

/** État d'une équipe dit par un MOT (jamais par la couleur seule) et expliqué par son aide. */
export interface TeamEtat {
  code: "a-completer" | "avance";
  mot: string;
  aide: string;
}

export interface TeamCardModel {
  id: string;
  titre: string;
  description: string;
  /** « {titre} · {forme} · {n} étapes · ≈ {typique} $ · Dernier lancement : {date}, {cout} $ », ou « … · Jamais lancée ». */
  ligne: string;
  etat: TeamEtat | null;
  libelleSchema: string;
  layout: readonly FlowRow[];
  liste: readonly string[];
  /** Vide en lecture seule (Simple fermé) : la liste se consulte seulement. */
  actions: readonly TeamAction[];
}

/** Raison qui désactive un bouton, ou null. Une équipe réglée en Avancé ne s'ouvre ni ne se lance en Simple ; à compléter : pas de lancement. */
function raisonAction(action: TeamActionId, etat: TeamView["etat"], advanced: boolean): string | null {
  if (etat === "avance" && !advanced && action !== "supprimer") return ONGLET.etatsAide.avance;
  if (etat === "a-completer" && action === "utiliser") return ONGLET.etatsAide["a-completer"];
  return null;
}

function actionsDe(team: TeamView, advanced: boolean, lectureSeule: boolean): TeamAction[] {
  if (lectureSeule) return [];
  return TEAM_ACTIONS.map((id): TeamAction => {
    const raison = raisonAction(id, team.etat, advanced);
    return { id, libelle: LIBELLES_ACTIONS[id], desactive: raison !== null, raison };
  });
}

/** Ligne d'une équipe installée. `date` : date du dernier lancement déjà écrite, ou null quand l'équipe n'a jamais été lancée. */
export function ligneEquipe(team: TeamView, date: string | null): string {
  const base = {
    titre: team.titre,
    forme: P.formes[team.forme],
    n: compterEtapes(team.layout),
    // Prix inconnu (estimation impossible) : montant() écrit « — », jamais un chiffre inventé.
    typique: team.estimate?.typique ?? Number.NaN,
  };
  if (team.dernierLancement === null || date === null) return remplir(ONGLET.installees.ligneJamais, base);
  return remplir(ONGLET.installees.ligne, { ...base, date, cout: team.dernierLancement.cost });
}

// --- Galerie des exemples -----------------------------------------------------------------------------------------------------

export interface ExempleCardModel {
  id: string;
  titre: string;
  description: string;
  /** « ≈ {typique} $ en général » ; null tant que l'aperçu n'a pas rendu d'estimation. */
  cout: string | null;
  /** « Lecture seule » : une étape lit le projet, elle ne modifie rien. */
  lectureSeule: string;
  libelleApercu: string;
  /** « Installer », ou « Déjà installée » quand l'exemple est posé. */
  libelleInstaller: string;
  installable: boolean;
  libelleSchema: string;
  layout: readonly FlowRow[];
  liste: readonly string[];
}

export interface GalerieModel {
  titre: string;
  exemples: readonly ExempleCardModel[];
}

function exempleCard(exemple: TeamExampleView, typique: number | undefined): ExempleCardModel {
  return {
    id: exemple.id,
    titre: exemple.titre,
    description: exemple.description,
    cout: typique === undefined ? null : remplir(ONGLET.enGeneral, { typique }),
    lectureSeule: ONGLET.lectureSeule,
    libelleApercu: ONGLET.apercu,
    libelleInstaller: exemple.installee ? ONGLET.installee : ONGLET.installer,
    installable: !exemple.installee,
    libelleSchema: libelleSchema(exemple.layout, null),
    layout: exemple.layout,
    liste: exemple.liste,
  };
}

export interface InstallationModel {
  titre: string;
  /** « Installe aussi : l'assistant « {nom} ». Relisez-le avec votre équipe. » ; null quand aucun assistant n'est ajouté. */
  aussi: string | null;
  installer: string;
  annuler: string;
  libelleSchema: string;
}

/** Boîte d'installation d'un exemple : le déroulé installé, et les assistants que l'installation pose en plus. */
export function installationDe(exemple: TeamExampleView): InstallationModel {
  return {
    titre: remplir(ONGLET.installation.titre, { titre: exemple.titre }),
    aussi: exemple.assistantsManquants.length === 0 ? null : installeAussi(exemple.assistantsManquants),
    installer: ONGLET.installation.installer,
    annuler: ONGLET.installation.annuler,
    libelleSchema: libelleSchema(exemple.layout, null),
  };
}

// --- Onglet -------------------------------------------------------------------------------------------------------------------

/** `ferme` : équipes fermées en Simple (U1) ; `vide` : aucune équipe installée ; `equipes` : la liste et la galerie. */
export type TeamsTabDisplay = "chargement" | "erreur" | "ferme" | "vide" | "equipes";

export interface TeamsTabVide {
  definition: string;
  accueil: string;
  partirExemple: string;
}

export interface TeamsTabModel {
  affichage: TeamsTabDisplay;
  titre: string;
  /** Texte du §2.6 tant que les équipes sont fermées en Simple ; null sinon. */
  ferme: string | null;
  /** Aucune écriture possible : ni éditeur, ni installation, ni suppression. */
  lectureSeule: boolean;
  /** Libellé de [Nouvelle équipe] ; null en lecture seule. */
  nouvelle: string | null;
  vide: TeamsTabVide | null;
  galerie: GalerieModel | null;
  equipes: readonly TeamCardModel[];
  /** Phrase d'une lecture qui a échoué ; null sinon. */
  erreur: string | null;
}

export interface TeamsTabInput {
  advanced: boolean;
  /** GET /api/teams ; null tant que la lecture n'a pas abouti. */
  donnees: TeamsListResponse | null;
  chargement: boolean;
  /** Phrase d'une lecture qui a échoué ; null sinon. */
  erreur: string | null;
  /** « En général » d'un exemple (POST /api/teams/preview), par identifiant ; absent : la ligne de coût n'est pas affichée. */
  coutsExemples?: Readonly<Record<string, number>>;
  /** Date du dernier lancement, déjà écrite par l'interface (formatDateTime) : aucune date n'est formatée dans ce module. */
  dateDe: (at: number) => string;
}

const VIDE: TeamsTabVide = { definition: P.definition, accueil: P.accueil, partirExemple: ONGLET.partirExemple };

/**
 * Équipes utilisables : toujours en mode Avancé (U1, option a) ; en Simple, SEULEMENT si `ouvertesEnSimple` de GET /api/teams est
 * vrai. Aucune autre valeur ne les ferme : basculer EQUIPES_SIMPLE_OUVERTES ouvre l'onglet d'une seule ligne.
 */
export function equipesOuvertes(advanced: boolean, donnees: TeamsListResponse | null): boolean {
  return advanced || donnees?.ouvertesEnSimple === true;
}

/** Modèle de l'onglet. Seul `ouvertesEnSimple` ferme les équipes en Simple : l'ouverture tient en une ligne (U1). */
export function buildTeamsTab(input: TeamsTabInput): TeamsTabModel {
  const base = {
    titre: ONGLET.titre,
    ferme: null,
    lectureSeule: false,
    nouvelle: null,
    vide: null,
    galerie: null,
    equipes: [],
    erreur: null,
  } satisfies Omit<TeamsTabModel, "affichage">;
  const donnees = input.donnees;
  if (donnees === null) {
    // Rien de lu : l'onglet attend tant qu'une lecture est en cours, et n'affirme jamais « aucune équipe » sans données.
    if (input.chargement || input.erreur === null) return { ...base, affichage: "chargement" };
    return { ...base, affichage: "erreur", erreur: input.erreur };
  }
  const lectureSeule = !equipesOuvertes(input.advanced, donnees);
  const equipes = donnees.teams.map((team): TeamCardModel => {
    const date = team.dernierLancement === null ? null : input.dateDe(team.dernierLancement.at);
    return {
      id: team.id,
      titre: team.titre,
      description: team.description,
      ligne: ligneEquipe(team, date),
      etat: team.etat === "ok" ? null : { code: team.etat, mot: ONGLET.etats[team.etat], aide: ONGLET.etatsAide[team.etat] },
      libelleSchema: libelleSchema(team.layout, team.forme),
      layout: team.layout,
      liste: team.liste,
      actions: actionsDe(team, input.advanced, lectureSeule),
    };
  });
  if (lectureSeule) {
    return { ...base, affichage: "ferme", ferme: TEXTES.simple.fermees, lectureSeule: true, equipes, erreur: input.erreur };
  }
  const couts = input.coutsExemples ?? {};
  const galerie: GalerieModel = { titre: ONGLET.galerie, exemples: donnees.exemples.map((e) => exempleCard(e, couts[e.id])) };
  return {
    ...base,
    affichage: equipes.length === 0 ? "vide" : "equipes",
    nouvelle: ONGLET.nouvelle,
    vide: equipes.length === 0 ? VIDE : null,
    galerie,
    equipes,
    erreur: input.erreur,
  };
}

// --- Suppression et refus -----------------------------------------------------------------------------------------------------

export interface SuppressionModel {
  titre: string;
  message: string;
  confirmer: string;
  annuler: string;
}

/** Confirmation de suppression : les lancements passés et les assistants de l'équipe ne sont pas touchés (fiche L40a). */
export function suppressionDe(titre: string): SuppressionModel {
  return {
    titre: remplir(ONGLET.suppression.titre, { titre }),
    message: ONGLET.suppression.message,
    confirmer: ONGLET.suppression.confirmer,
    annuler: ONGLET.suppression.annuler,
  };
}

/** Refus lu dans une réponse d'erreur (teamError de api-teams.ts), sans dépendre du client HTTP. */
export interface RefusInfo {
  error: string;
  message: string;
}

/**
 * Phrase d'un refus : la garde de rechargement (409 `sessions-busy`, `redemarrage-en-cours`, `reponses-non-verifiables`) rend son
 * PROPRE message, affiché tel quel ; un code d'équipe connu rend la phrase de T4t ; sinon le repli (phrase du serveur).
 */
export function texteRefus(refus: RefusInfo | null, repli: string): string {
  if (refus === null) return repli;
  if (GUARD.has(refus.error)) return refus.message;
  return phraseErreur(refus.error);
}

/** Refus d'une suppression : 409 `equipe-en-cours` a sa phrase propre (« arrêtez-la avant de la supprimer »). */
export function texteRefusSuppression(refus: RefusInfo | null, repli: string): string {
  if (refus?.error === "equipe-en-cours") return ONGLET.suppression.enCours;
  return texteRefus(refus, repli);
}
