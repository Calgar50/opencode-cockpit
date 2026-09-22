// Propriétaire : L38a.
// Modèle PUR du lanceur d'équipe et de la feuille de lancement (D-eq-24 : toute la logique testable vit ici, TeamLauncher.tsx et
// TeamLaunchSheet.tsx restent minces ; tests : server/web-team-launch.test.ts). Aucun import de React, aucune lecture de réseau,
// aucune horloge : l'instant est toujours passé en argument.
// Références : spécification §7.8 l.1184, §3.13 l.413-414, §5.5, §5.6 ; C §9.4 corrigée ; plan it4 §6 fiche L38a, §4.1.1
// (TeamEstimateResponse, TeamRunBody), D-eq-13 (U1), D-eq-17 (A4), D-eq-24.
// Règles tenues ici :
// - tous les textes viennent de server/shared/team-texts.ts (T4t) : aucune phrase écrite dans ce fichier ni dans les .tsx ;
// - montants : la valeur est écrite par montant() ou par remplir() avec un nombre, jamais par formatUsd() (report MX-EQ §4.2) ;
// - refus prévisible (blocage de l'estimation, D-eq-17) : [Lancer l'équipe] est désactivé AVANT tout clic, la raison est rendue
//   près du bouton ; aucune requête n'est lancée seule ;
// - confirmations workspace, secret, plafond et budget (P7) : dans le CORPS du lancement, et seulement après un clic de
//   l'utilisateur ; le garde-fou budgétaire P6 passe, lui, par l'en-tête x-cockpit-confirm: 1 et n'entre jamais dans le corps ;
// - mode Simple : le lanceur est absent tant que `ouvertesEnSimple` est faux (U1) et la feuille ne montre aucune IA par étape.
import { TEXTES as TEXTES_C5 } from "../../../../server/shared/construction-texts.ts";
import { sqlWriteKeywords } from "../../../../server/shared/sql-keywords.ts";
import {
  arretAutomatique,
  confidentialite,
  coutLancement,
  phraseBlocage,
  phraseErreur,
  phraseProbleme,
  refusLancement,
  remplir,
  TEXTES,
} from "../../../../server/shared/team-texts.ts";
import type { FlowRow, TeamConfirmation, TeamEstimateResponse, TeamRunBody, TeamsListResponse, TeamView } from "../../../lib/types.ts";

const P = TEXTES.partout;
const F = P.feuille;
// <c5:controle-sql>
const E5 = TEXTES_C5.partout.exemplesEquipes;

/** Exemple dont la feuille annonce le contrôle SQL local (conception C §12.1, L45b). */
export const EXEMPLE_REVUE_SQL = "revue-sql";
// </c5:controle-sql>

// --- Lanceur [Lancer une équipe ▾] ----------------------------------------------------------------------------------------------

/** Équipe proposée par le menu du lanceur. */
export interface LanceurItem {
  id: string;
  titre: string;
  /** Forme et nombre d'étapes. */
  sousTitre: string;
  /** Lançable dans le mode courant ; sinon l'élément reste atteignable au clavier, désactivé, avec sa raison lue. */
  lancable: boolean;
  raison: string | null;
}

export interface LanceurVue {
  /** Lanceur rendu ; jamais en Simple tant que `ouvertesEnSimple` est faux (U1, D-eq-13). */
  visible: boolean;
  libelle: string;
  actif: boolean;
  /** Raison de l'inactivité, écrite près du bouton. */
  raison: string | null;
  items: LanceurItem[];
}

/** Nombre d'étapes d'une disposition (cellules porteuses d'une étape ; une pause n'en est pas une). */
function nombreEtapes(layout: readonly FlowRow[]): number {
  let total = 0;
  for (const row of layout) {
    if (row.kind === "pause") continue;
    for (const cellule of row.cellules) if (cellule.stepId !== null) total++;
  }
  return total;
}

/** Équipe lançable dans le mode courant : rien à compléter, et réglages du mode Avancé seulement en Avancé. */
function lancabilite(team: TeamView, advanced: boolean): { lancable: boolean; raison: string | null } {
  if (team.etat === "a-completer") return { lancable: false, raison: P.onglet.etatsAide["a-completer"] };
  if (team.etat === "avance" && !advanced) return { lancable: false, raison: P.onglet.etatsAide.avance };
  return { lancable: true, raison: null };
}

/** Raison écrite près du bouton quand le lancement n'est pas ouvert ; null quand il l'est. */
function raisonLanceur(items: readonly LanceurItem[], busy: boolean, demandeVide: boolean): string | null {
  if (items.length === 0) return P.lanceur.aucune;
  if (busy) return P.lanceur.occupee;
  if (demandeVide) return P.lanceur.saisieVide;
  if (items.some((item) => item.lancable)) return null;
  return items[0]?.raison ?? null;
}

/**
 * Bouton de menu et liste des équipes installées. `demandeVide` : la saisie ne porte aucune demande ; `busy` : la conversation
 * travaille (réponse, travail délégué ou équipe en cours). Les deux désactivent le lanceur avec leur raison.
 */
export function vueLanceur(input: { liste: TeamsListResponse | null; advanced: boolean; busy: boolean; demandeVide: boolean }): LanceurVue {
  const { liste, advanced, busy, demandeVide } = input;
  const visible = liste !== null && (advanced || liste.ouvertesEnSimple);
  const items: LanceurItem[] = (liste?.teams ?? []).map((team) => ({
    id: team.id,
    titre: team.titre,
    sousTitre: `${P.formes[team.forme]} · ${remplir(P.onglet.etapes, { n: nombreEtapes(team.layout) })}`,
    ...lancabilite(team, advanced),
  }));
  const lancable = items.some((item) => item.lancable);
  return { visible, libelle: P.lanceur.bouton, actif: visible && lancable && !busy && !demandeVide, raison: raisonLanceur(items, busy, demandeVide), items };
}

// --- Feuille de lancement : entrées ---------------------------------------------------------------------------------------------

/** Accords donnés par l'utilisateur dans la feuille ; tous faux tant qu'il n'a rien cliqué. */
export interface AccordsFeuille {
  workspace: boolean;
  secret: boolean;
  plafond: boolean;
  budget: boolean;
  /** Garde-fou budgétaire P6 : en-tête x-cockpit-confirm: 1, jamais dans le corps du lancement. */
  gardeBudget: boolean;
}

export const AUCUN_ACCORD: AccordsFeuille = { workspace: false, secret: false, plafond: false, budget: false, gardeBudget: false };

/** Refus lu dans la réponse du serveur (teamError d'api-teams.ts), ou échec de l'estimation. */
export interface RefusLu {
  status: number;
  code: string;
  /** Message du serveur : rendu tel quel pour le garde-fou budgétaire (texte du serveur). */
  message: string;
  details: Record<string, unknown> | null;
}

export interface EtatFeuille {
  equipe: TeamView;
  advanced: boolean;
  /** Dernière estimation rendue ; null tant qu'aucune n'a abouti. */
  estimation: TeamEstimateResponse | null;
  /** Une estimation est en cours (ouverture, instantané bientôt périmé, retour au repos, 409 estimation-perimee). */
  estimationEnCours: boolean;
  /** Refus du dernier envoi, ou échec de la dernière estimation ; null sinon. */
  refus: RefusLu | null;
  accords: AccordsFeuille;
  /** La conversation travaille : le lancement est refusé, raison affichée. */
  occupee: boolean;
  envoiEnCours: boolean;
  detailOuvert: boolean;
  // <c5:controle-sql-etat>
  /**
   * Demande écrite dans la saisie, lue une fois à l'ouverture de la feuille. Elle ne sert qu'au contrôle SQL LOCAL de
   * l'exemple « Revue SQL sur réplica » : aucun appel d'IA, aucune requête. Absente : aucun contrôle, aucune ligne.
   */
  demande?: string;
  // </c5:controle-sql-etat>
}

// --- Feuille de lancement : sortie ------------------------------------------------------------------------------------------------

export type CleConfirmation = TeamConfirmation | "gardeBudget";

export interface ConfirmationFeuille {
  cle: CleConfirmation;
  titre: string | null;
  texte: string;
  /** « case » : case « Je confirme » ; « bouton » : [Lancer quand même] ; « aucun » : refus, rien à cocher (Simple). */
  controle: "case" | "bouton" | "aucun";
  libelle: string | null;
  accorde: boolean;
  /** Bouton secondaire : [Modifier la demande] ferme la feuille et rend le focus à la saisie. */
  secondaire: string | null;
}

export interface LigneEtape {
  stepId: string;
  texte: string;
  /** « IA de l'étape : … (choisie par l'équipe) », en Avancé seulement (§3.13 l.413) ; jamais en Simple. */
  ia: string | null;
}

export interface VueFeuille {
  titre: string;
  /** Estimation en cours : le corps est remplacé par l'attente, aucun bouton de lancement actif. */
  chargement: boolean;
  intro: string[];
  // <c5:controle-sql-vue>
  /** Contrôle SQL LOCAL de « Revue SQL sur réplica » : ligne affichée seulement quand un mot d'écriture a été repéré. */
  sql: string | null;
  // </c5:controle-sql-vue>
  blocs: string[];
  cout: string | null;
  arret: string | null;
  detail: { libelle: string; ouvert: boolean; lignes: LigneEtape[] } | null;
  confirmations: ConfirmationFeuille[];
  /** Message au-dessus des boutons : refus du dernier envoi, ou information (nouvelle estimation affichée). */
  alerte: { ton: "refus" | "info"; texte: string } | null;
  lancer: { libelle: string; actif: boolean; raison: string | null };
  /** [Modifier l'équipe] : l'équipe elle-même doit changer (problème bloquant, IA indisponible…). */
  modifierEquipe: string | null;
  annuler: string;
}

/** Code d'erreur qui porte chaque confirmation (P7) : sa phrase sert de raison près du bouton [Lancer l'équipe]. */
const CODE_DE: Readonly<Record<CleConfirmation, string>> = {
  workspace: "confirmation-workspace",
  secret: "secret-probable",
  plafond: "plafond-a-confirmer",
  budget: "budget-insuffisant",
  gardeBudget: "budget-guard",
};

/** Refus qui demande une confirmation : la feuille l'affiche au lieu d'un message d'erreur. */
const CONFIRMATION_DE: Readonly<Record<string, CleConfirmation>> = {
  "confirmation-workspace": "workspace",
  "secret-probable": "secret",
  "plafond-a-confirmer": "plafond",
  "plafond-trop-haut": "plafond",
  "budget-insuffisant": "budget",
  "budget-guard": "gardeBudget",
};

/** Refus que seule une modification de l'équipe lève : [Modifier l'équipe] est proposé. */
const CODES_EQUIPE: ReadonlySet<string> = new Set(["equipe-invalide", "ia-indisponible", "assistant-absent", "mode-avance", "fournisseur-refuse", "niveau-indisponible"]);

/** Confirmation demandée par un refus, sinon null. */
export function confirmationDuRefus(code: string): CleConfirmation | null {
  return Object.hasOwn(CONFIRMATION_DE, code) ? (CONFIRMATION_DE[code] as CleConfirmation) : null;
}

/** 409 estimation-perimee : la feuille ré-estime et affiche la nouvelle estimation, jamais un lancement automatique (D-eq-17). */
export function refusDemandeReestimation(code: string): boolean {
  return code === "estimation-perimee";
}

/** Nombre lu dans les détails d'un refus (données du serveur, lues avec prudence) ; null si absent ou non fini. */
function nombreDetail(details: Record<string, unknown> | null, cle: string): number | null {
  const valeur = details?.[cle];
  return typeof valeur === "number" && Number.isFinite(valeur) ? valeur : null;
}

/**
 * Phrase chiffrée d'une confirmation : le gabarit rempli quand tous les montants sont connus, sinon la phrase du code, qui les
 * tait (l'estimation annonce la confirmation sans ses montants ; ils arrivent avec le refus). Jamais un « {nom} » affiché.
 */
function chiffre(gabarit: string, code: string, valeurs: Record<string, number> | null): string {
  return valeurs === null ? phraseErreur(code) : remplir(gabarit, valeurs);
}

/** Texte lu dans les détails d'un refus ; null si absent ou vide. */
function texteDetail(details: Record<string, unknown> | null, cle: string): string | null {
  const valeur = details?.[cle];
  return typeof valeur === "string" && valeur.trim() !== "" ? valeur : null;
}

/** Blocs du déroulé, tels que la feuille les liste (« En même temps : … » pour un bloc d'avis). */
export function blocsFeuille(layout: readonly FlowRow[]): string[] {
  return layout.map((row) =>
    row.kind === "avis" && row.cellules.length > 1
      ? remplir(F.enMemeTemps, { titres: row.cellules.map((cellule) => cellule.titre).join(", ") })
      : (row.cellules[0]?.titre ?? ""),
  );
}

/** Paragraphes d'introduction : confidentialité, périmètre, ce que fait l'équipe, honnêteté, arrêt possible (C §9.4 corrigée). */
function introFeuille(estimation: TeamEstimateResponse, layout: readonly FlowRow[]): string[] {
  const lignes = [confidentialite(estimation.estimate.etapesFacturees), F.perimetre, F.ceQueFait, P.honnetete.etapes, P.honnetete.cles];
  if (layout.some((row) => row.kind === "avis")) lignes.push(P.honnetete.avis);
  lignes.push(F.memeFichier, F.arreterQuandVous);
  return lignes;
}

/** Une ligne par étape : titre, assistant et montants ; l'IA de l'étape n'est écrite qu'en Avancé, quand l'équipe l'a choisie. */
function lignesEtapes(estimation: TeamEstimateResponse, advanced: boolean): LigneEtape[] {
  return estimation.estimate.parEtape.map((etape) => ({
    stepId: etape.stepId,
    texte: remplir(F.ligneEtape, { titre: etape.titre, assistant: etape.assistant, typique: etape.typique ?? 0, maximum: etape.maximum ?? 0 }),
    ia: advanced && etape.choisieParEquipe && etape.modelLabel !== null ? remplir(TEXTES.avance.iaEtape, { ia: etape.modelLabel }) : null,
  }));
}

/** Confirmations à obtenir : celles annoncées par l'estimation, plus celle qu'un refus vient de demander. */
export function confirmationsFeuille(etat: EtatFeuille): ConfirmationFeuille[] {
  const { estimation, refus, accords, advanced } = etat;
  const demandee = refus === null ? null : confirmationDuRefus(refus.code);
  const cles: CleConfirmation[] = [...(estimation?.confirmations ?? [])];
  if (demandee !== null && !cles.includes(demandee)) cles.push(demandee);
  const details = demandee === null ? null : refus?.details ?? null;
  const plafond = estimation?.plafond ?? null;

  return cles.map((cle) => {
    const accorde = accords[cle];
    switch (cle) {
      case "workspace":
        return { cle, titre: F.workspaceTitre, texte: F.workspace, controle: "case", libelle: F.jeConfirme, accorde, secondaire: null };
      case "secret": {
        const n = estimation?.estimate.etapesFacturees ?? 0;
        return { cle, titre: null, texte: remplir(F.secret, { n }), controle: "bouton", libelle: F.lancerQuandMeme, accorde, secondaire: F.modifierDemande };
      }
      case "plafond": {
        // Simple : refus (403 plafond-trop-haut), rien à cocher. Avancé : confirmation (409 plafond-a-confirmer).
        const code = advanced ? "plafond-a-confirmer" : "plafond-trop-haut";
        const gabarit = advanced ? F.plafondAConfirmer : F.plafondTropHaut;
        const permis = nombreDetail(details, "permis");
        const texte = chiffre(gabarit, code, plafond === null || permis === null ? null : { plafond, permis });
        if (!advanced) return { cle, titre: null, texte, controle: "aucun", libelle: null, accorde: false, secondaire: null };
        return { cle, titre: null, texte, controle: "case", libelle: F.jeConfirme, accorde, secondaire: null };
      }
      case "budget": {
        const reste = nombreDetail(details, "reste");
        const texte = chiffre(F.budgetRestant, "budget-insuffisant", plafond === null || reste === null ? null : { plafond, reste });
        return { cle, titre: null, texte, controle: "case", libelle: F.jeConfirme, accorde, secondaire: null };
      }
      default: {
        // Garde-fou budgétaire P6 : le texte vient du serveur, rendu tel quel ; l'accord passe par l'en-tête.
        const texte = refus !== null && refus.code === "budget-guard" && refus.message.trim() !== "" ? refus.message : phraseErreur("budget-guard");
        return { cle: "gardeBudget", titre: null, texte, controle: "case", libelle: F.jeConfirme, accorde, secondaire: null };
      }
    }
  });
}

/** Message d'un refus qui n'est pas une confirmation ; null quand le refus est porté par une confirmation ou qu'il n'y en a pas. */
function alerteFeuille(etat: EtatFeuille): VueFeuille["alerte"] {
  const refus = etat.refus;
  if (refus === null || confirmationDuRefus(refus.code) !== null) return null;
  if (!Object.hasOwn(P.erreurs, refus.code)) {
    // Code hors de TeamErrorCode (garde de rechargement, panne du réseau) : message du serveur tel quel, sinon phrase générale.
    // Jamais « Rien n'a été envoyé ni facturé. » ici : le cockpit ne sait pas ce qui est parti (P3).
    return { ton: "refus", texte: refus.message.trim() === "" ? P.erreurInconnue : refus.message };
  }
  if (refusDemandeReestimation(refus.code)) return { ton: "info", texte: F.perimee };
  if (refus.code === "opencode-injoignable") return { ton: "refus", texte: F.injoignable };
  if (refus.code === "conversation-occupee") return { ton: "refus", texte: F.occupee };
  if (refus.code === "ia-indisponible") {
    const titre = texteDetail(refus.details, "titre");
    return { ton: "refus", texte: titre === null ? refusLancement(refus.code) : remplir(F.iaIndisponible, { titre }) };
  }
  return { ton: "refus", texte: refusLancement(refus.code) };
}

// <c5:controle-sql-ligne>
/**
 * Contrôle SQL LOCAL de l'exemple « Revue SQL sur réplica » (conception C §12.1, D-5-25 : toujours livré). PUR et sans aucun
 * appel d'IA : les mots d'écriture sont repérés dans la demande écrite par `sqlWriteKeywords`, et la ligne dit ce qui a été
 * repéré — jamais que la requête écrit, ce que le cockpit ne sait pas (P3).
 * Rendue seulement pour l'équipe installée DEPUIS cet exemple (`exempleId`), et seulement si un mot a été repéré.
 */
export function ligneControleSql(equipe: TeamView, demande: string | undefined): string | null {
  if (equipe.exempleId !== EXEMPLE_REVUE_SQL || typeof demande !== "string") return null;
  const mots = sqlWriteKeywords(demande);
  return mots.length === 0 ? null : remplir(E5.sqlRepere, { mots: mots.join(", ") });
}
// </c5:controle-sql-ligne>

/** Premier problème bloquant de l'estimation (l'équipe doit être modifiée avant tout lancement) ; null sinon. */
function problemeBloquant(etat: EtatFeuille): string | null {
  const probleme = etat.estimation?.problems.find((p) => p.bloquant);
  return probleme === undefined ? null : phraseProbleme(probleme.code);
}

/** Feuille entière : titre, textes, coût, confirmations et état du bouton [Lancer l'équipe] (C §9.4 corrigée). */
export function vueFeuille(etat: EtatFeuille): VueFeuille {
  const { equipe, advanced, estimation, estimationEnCours, envoiEnCours, occupee, detailOuvert } = etat;
  const titre = remplir(F.titre, { equipe: equipe.titre });
  const confirmations = estimationEnCours ? [] : confirmationsFeuille(etat);
  const alerte = alerteFeuille(etat);
  const bloquant = problemeBloquant(etat);
  const blocage = estimation?.blocage ?? null;
  const refusee = confirmations.find((c) => c.controle === "aucun");
  const manquante = confirmations.find((c) => c.controle !== "aucun" && !c.accorde);

  let raison: string | null = null;
  if (bloquant !== null) raison = bloquant;
  else if (blocage !== null) raison = phraseBlocage(blocage.code);
  else if (occupee) raison = F.occupee;
  else if (refusee !== undefined) raison = refusee.texte;
  else if (manquante !== undefined) raison = phraseErreur(CODE_DE[manquante.cle]);

  const pret = estimation !== null && !estimationEnCours && !envoiEnCours && raison === null;
  const modifier = bloquant !== null || (etat.refus !== null && CODES_EQUIPE.has(etat.refus.code)) || (blocage !== null && CODES_EQUIPE.has(blocage.code));

  return {
    titre,
    // Attente seulement pendant une estimation : une estimation impossible (502) laisse la feuille visible avec sa phrase.
    chargement: estimationEnCours,
    intro: estimation === null ? [] : introFeuille(estimation, equipe.layout),
    // <c5:controle-sql-sortie>
    // Contrôle local : il ne dépend d'aucune estimation, donc il s'affiche même quand l'estimation n'a pas abouti.
    sql: ligneControleSql(equipe, etat.demande),
    // </c5:controle-sql-sortie>
    blocs: estimation === null ? [] : blocsFeuille(equipe.layout),
    cout: estimation === null ? null : coutLancement(estimation.estimate.typique, estimation.estimate.maximum, estimation.estimate.etapesFacturees),
    arret: estimation === null ? null : arretAutomatique(estimation.plafond, estimation.estimate.depassementUnAppel),
    detail: estimation === null ? null : { libelle: F.detail, ouvert: detailOuvert, lignes: lignesEtapes(estimation, advanced) },
    confirmations,
    alerte,
    lancer: { libelle: F.lancer, actif: pret, raison },
    modifierEquipe: modifier ? F.modifierEquipe : null,
    annuler: F.annuler,
  };
}

// --- Envoi du lancement -------------------------------------------------------------------------------------------------------

/** Marge avant `expireA` : l'instantané est ré-estimé avant d'être périmé, jamais au moment de l'envoi (D-eq-17). */
export const MARGE_EXPIRATION_MS = 30_000;

/** Instantané absent ou bientôt périmé : une nouvelle estimation est demandée AVANT tout envoi. */
export function estimationAFaire(estimation: TeamEstimateResponse | null, maintenant: number): boolean {
  return estimation === null || estimation.expireA - maintenant <= MARGE_EXPIRATION_MS;
}

/** Délai minimum entre deux estimations : un instantané déjà périmé ne déclenche jamais une suite de lectures serrées. */
export const DELAI_REESTIMATION_MIN_MS = 5_000;

/** Délai avant la prochaine estimation (ms), jamais sous le délai minimum ; l'appelant l'arme sur un seul minuteur. */
export function delaiAvantReestimation(estimation: TeamEstimateResponse | null, maintenant: number): number {
  if (estimation === null) return DELAI_REESTIMATION_MIN_MS;
  return Math.max(DELAI_REESTIMATION_MIN_MS, estimation.expireA - MARGE_EXPIRATION_MS - maintenant);
}

/** Confirmations du corps (P7) : seulement celles que l'utilisateur a accordées ; le garde-fou P6 n'y entre jamais. */
export function confirmationsDuCorps(accords: AccordsFeuille): TeamRunBody["confirmations"] {
  const corps: TeamRunBody["confirmations"] = {};
  if (accords.workspace) corps.workspace = true;
  if (accords.secret) corps.secret = true;
  if (accords.plafond) corps.plafond = true;
  if (accords.budget) corps.budget = true;
  return corps;
}

/** Garde-fou budgétaire P6 confirmé : en-tête x-cockpit-confirm: 1 (options du client api-teams.ts). */
export function enTeteConfirmation(accords: AccordsFeuille): { confirm?: boolean } {
  return accords.gardeBudget ? { confirm: true } : {};
}

/** Corps de POST /api/teams/:id/run : demande et fichiers du brouillon, empreinte de l'estimation affichée, accords donnés. */
export function corpsLancement(input: {
  directory: string;
  rootId: string | null;
  demande: string;
  fichiers: readonly string[];
  agentConversation: string;
  estimateSha256: string;
  accords: AccordsFeuille;
}): TeamRunBody {
  return {
    directory: input.directory,
    rootId: input.rootId,
    demande: input.demande,
    fichiers: [...input.fichiers],
    agentConversation: input.agentConversation,
    estimateSha256: input.estimateSha256,
    confirmations: confirmationsDuCorps(input.accords),
  };
}

/** Accords après un refus : l'accord que le refus vient de demander est remis à zéro (il n'a pas encore été donné). */
export function accordsApresRefus(accords: AccordsFeuille, code: string): AccordsFeuille {
  const cle = confirmationDuRefus(code);
  return cle === null ? accords : { ...accords, [cle]: false };
}
