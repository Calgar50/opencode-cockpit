// Propriétaire : L12b.
// Modèle PUR de ce que l'autonomie montre (spécification §4.3 étape 7, §4.4 fin, §4.12, §4.13, §2.3 « États », §5.4, §5.5, §5.6 ;
// plan d'exécution, fiche L12b) : état de la carte d'une demande d'autorisation (examen, attente, terminée), bascule des boutons
// à 60 s d'examen, compteurs et segments du bandeau, montants formatés, bouton de fin de demande, état vide et annonces polies.
// Les composants (DecisionStatus.tsx, AutonomyBanner.tsx) restent minces : ils rendent ce que ce module décide ; ils n'ont ni
// condition, ni texte à eux (risque 7 du plan : interface sans tests).
// Aucun texte écrit ici : les phrases viennent de autonomy-texts.ts (L9b) et de activity-texts.ts (L5b, « +{n} » du bandeau à
// 400 px) ; les seules chaînes de ce module sont des codes et le séparateur du bandeau.
// Textes venus d'une IA, d'un fichier ou d'opencode (raison d'une décision) : secrets masqués, caractères invisibles retirés,
// blancs réduits et texte borné à TEXTE_IA_MAX caractères ici ; l'échappement à l'affichage est celui de React, qui n'interprète
// aucun HTML (les composants n'emploient jamais dangerouslySetInnerHTML).
// Horloge INJECTÉE (`maintenant`) : ce module ne lit jamais l'heure, il n'a donc pas de bascule à lui.
// Module pur (server/shared).
import { libelleEnPlus } from "./activity-texts.ts";
import { bandeau, libelleDecision, montant, type OmoRequestEnd, type PhraseOptions, phraseFin, regleCarte, TEXTES } from "./autonomy-texts.ts";
import type { AutonomyRequestView, DecisionVerdict, RequestEnd } from "./autonomy-types.ts";
import type { CockpitEventMap } from "./cockpit-event-types.ts";
import { redactSecrets } from "../redact.ts";

// --- Textes venus d'ailleurs (IA, fichier, opencode) -------------------------------------------------------------------------

/** Borne d'un texte qui n'est pas écrit par le cockpit (§4.12 : action masquée à 120 caractères ; même borne pour une raison). */
export const TEXTE_IA_MAX = 120;

/**
 * Texte affichable d'une donnée : secrets masqués d'abord (le masquage peut allonger le texte, la borne est tenue après lui),
 * caractères invisibles retirés, blancs réduits, texte borné à `max` caractères avec « … ». Rend "" pour un texte vide ou absent :
 * l'appelant n'affiche alors rien, plutôt qu'une ligne vide.
 */
export function texteAffichable(texte: unknown, max: number = TEXTE_IA_MAX): string {
  if (typeof texte !== "string") return "";
  const propre = redactSecrets(texte)
    .replace(/\p{Cf}/gu, "")
    .replace(/[\p{Cc}\p{Zl}\p{Zp}]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
  const lettres = Array.from(propre);
  if (lettres.length <= max) return propre;
  return `${lettres.slice(0, Math.max(0, max - 1)).join("").trimEnd()}…`;
}

// --- États des demandes d'autorisation (§4.3 étapes 6 et 7) ------------------------------------------------------------------

/** Décision du contrôle pour une demande (événement `autonomie.decision`, sans la racine). */
export type DecisionEvenement = Omit<CockpitEventMap["autonomie.decision"], "rootId">;

/** Ce que l'interface retient d'une demande d'autorisation : début de l'examen (null : aucun examen vu) et décision du contrôle. */
export interface EtatDemande {
  examenDepuis: number | null;
  decision: DecisionEvenement | null;
}

export type EtatsDemandes = ReadonlyMap<string, EtatDemande>;

/** Aucun état (conversation sans demande suivie) : le même objet partout, pour que les composants ne se rendent pas à vide. */
export const ETATS_VIDES: EtatsDemandes = new Map<string, EtatDemande>();

/** Demandes gardées en mémoire ; au-delà, les plus anciennes sont oubliées (leur carte a déjà disparu du fil). */
export const ETATS_MAX = 200;

/** Vue d'une demande rendue aux composants (forme figée de PermissionAutonomyState, web/pages/chat/slots.ts). */
export interface VueDemande {
  /** Contrôle de sécurité en cours : seul [Refuser…] est proposé, 60 s au plus. */
  examining: boolean;
  decision: DecisionEvenement | null;
}

/**
 * Bascule des boutons (§4.3 étape 7) : pendant l'examen, la carte ne propose que [Refuser…] ; au-delà de EXAMEN_BOUTONS_MS, elle
 * reprend ses boutons normaux, même si le cockpit n'a encore rien décidé (l'examen a sa propre borne à 45 s, autonomy.ts).
 */
export const EXAMEN_BOUTONS_MS = 60_000;

/** Carte gardée sur place à 60 s : le compte ne repart jamais en arrière, une horloge qui recule ne rallume pas l'examen. */
export function examenEnCours(etat: EtatDemande | null | undefined, maintenant: number): boolean {
  if (!etat || etat.decision !== null || etat.examenDepuis === null) return false;
  return maintenant - etat.examenDepuis < EXAMEN_BOUTONS_MS;
}

/** Map bornée à ETATS_MAX : les entrées les plus anciennes sont oubliées d'abord (ordre d'insertion). */
function borner(etats: Map<string, EtatDemande>): EtatsDemandes {
  if (etats.size <= ETATS_MAX) return etats;
  const trop = etats.size - ETATS_MAX;
  let i = 0;
  for (const cle of etats.keys()) {
    if (i++ >= trop) break;
    etats.delete(cle);
  }
  return etats;
}

/** Examen commencé (`autonomie.examen`) : le début de l'examen est noté, la décision précédente oubliée. */
export function avecExamen(etats: EtatsDemandes, permissionId: string, at: number): EtatsDemandes {
  if (permissionId === "") return etats;
  const suite = new Map(etats);
  suite.delete(permissionId);
  suite.set(permissionId, { examenDepuis: at, decision: null });
  return borner(suite);
}

/** Décision du contrôle (`autonomie.decision`) : sans identifiant de demande (action hors demande), rien ne change. */
export function avecDecision(etats: EtatsDemandes, decision: DecisionEvenement): EtatsDemandes {
  const id = decision.permissionId;
  if (id === null || id === "") return etats;
  const suite = new Map(etats);
  suite.set(id, { examenDepuis: etats.get(id)?.examenDepuis ?? null, decision });
  return borner(suite);
}

/** Demande répondue ou retirée (`permission.replied`) : son état est oublié. */
export function sansDemande(etats: EtatsDemandes, permissionId: string): EtatsDemandes {
  if (!etats.has(permissionId)) return etats;
  const suite = new Map(etats);
  suite.delete(permissionId);
  return suite;
}

/** Vues des demandes à l'instant `maintenant` (bascule des boutons comprise). */
export function vueEtats(etats: EtatsDemandes, maintenant: number): ReadonlyMap<string, VueDemande> {
  const out = new Map<string, VueDemande>();
  for (const [id, etat] of etats) out.set(id, { examining: examenEnCours(etat, maintenant), decision: etat.decision });
  return out;
}

/**
 * Délai (ms) avant la prochaine bascule des boutons, 0 si elle est due, null si aucun examen n'est en cours : l'interface pose UNE
 * minuterie, jamais une horloge qui tourne (§5.5, aucune animation ni relance inutile).
 */
export function prochaineBascule(etats: EtatsDemandes, maintenant: number): number | null {
  let delai: number | null = null;
  for (const etat of etats.values()) {
    if (!examenEnCours(etat, maintenant)) continue;
    const reste = Math.max(0, (etat.examenDepuis as number) + EXAMEN_BOUTONS_MS - maintenant);
    if (delai === null || reste < delai) delai = reste;
  }
  return delai;
}

// --- Carte d'une demande (§4.3 étape 7, §4.13) -------------------------------------------------------------------------------

/** État de la carte : contrôle de sécurité en cours, attente de votre accord, ou décision prise (carte retirée juste après). */
export type EtatCarte = "examen" | "attente" | "terminee";

/** Verdicts de l'instance principale : « refus-interdit » n'existe que dans la Salle OMO (migration 5), jamais sur cette carte. */
export type VerdictPrincipal = Exclude<DecisionVerdict, "refus-interdit">;

const VERDICTS_ATTENDUS: ReadonlySet<string> = new Set<VerdictPrincipal>(["auto", "attente", "refus-auto", "non-controle"]);

/**
 * Icône de la carte (noms de web/components/Icon.tsx) : elle accompagne TOUJOURS le mot, jamais la couleur seule (§2.3, §5.5).
 * `shield` pendant le contrôle de sécurité (§2.3), puis l'icône du verdict.
 */
export type CarteIcon = "shield" | "hourglass" | "check" | "ban" | "alert";

export const ICONES_VERDICT: Readonly<Record<VerdictPrincipal, CarteIcon>> = {
  auto: "check",
  attente: "hourglass",
  "refus-auto": "ban",
  "non-controle": "alert",
};

export interface CarteEntree extends PhraseOptions {
  examining: boolean;
  decision: DecisionEvenement | null;
}

export interface CarteVue {
  etat: EtatCarte;
  icone: CarteIcon;
  titre: string;
  /** « Règle : {phrase} » ; null quand aucune règle n'est connue (examen en cours). */
  regle: string | null;
  /** Raison, texte d'ailleurs : masqué et borné ; null quand il n'y en a pas. */
  raison: string | null;
  /** Boutons de la carte de la demande (Interactions.tsx) : pendant l'examen, [Refuser…] seul (§4.3 étape 7). */
  boutons: { autoriser: boolean; refuser: boolean; arreter: boolean };
}

/**
 * Carte d'une demande d'autorisation : « Contrôle de sécurité en cours… » avec [Refuser…] seul pendant l'examen, sinon la décision
 * du contrôle (« En attente de votre accord » · « Règle : … » · [Autoriser une fois] [Refuser…] [Arrêter]). null : la carte reste
 * celle de la 1.0.4 (aucun examen, aucune décision, ou verdict inconnu de cette version).
 */
export function carteVue(entree: CarteEntree): CarteVue | null {
  const options: PhraseOptions = { mode: entree.mode, controleIa: entree.controleIa };
  if (entree.examining) {
    return {
      etat: "examen",
      icone: "shield",
      titre: TEXTES.partout.carte.examen,
      regle: null,
      raison: null,
      boutons: { autoriser: false, refuser: true, arreter: false },
    };
  }
  const decision = entree.decision;
  if (decision === null || !VERDICTS_ATTENDUS.has(decision.verdict)) return null;
  const verdict = decision.verdict as VerdictPrincipal;
  const attente = verdict === "attente";
  const raison = texteAffichable(decision.raison);
  return {
    etat: attente ? "attente" : "terminee",
    icone: ICONES_VERDICT[verdict],
    titre: libelleDecision(verdict),
    regle: regleCarte(texteAffichable(decision.regle, TEXTE_IA_MAX), options),
    raison: raison === "" ? null : raison,
    boutons: { autoriser: attente, refuser: attente, arreter: attente },
  };
}

// --- Bandeau de la demande (§4.12, §5.6) -------------------------------------------------------------------------------------

/** Séparateur des segments du bandeau (gabarit `bandeau.resume` de L9b) : ponctuation, jamais un texte affiché écrit ici. */
export const SEPARATEUR = " · ";

/** Fin d'une demande de l'instance principale : les fins de la Salle OMO (itération 2 ter) n'ont aucune phrase ici. */
export type FinPrincipale = Exclude<RequestEnd, OmoRequestEnd>;

/**
 * Fins que cette version sait dire (phraseFin de L9b). Une fin d'une version plus récente, ou d'une salle, ne donne aucune phrase :
 * le bandeau reste muet plutôt que d'afficher « undefined » (P3).
 */
const FINS_CONNUES: ReadonlySet<string> = new Set<FinPrincipale>([
  "terminee",
  "plafond-cout",
  "plafond-actions",
  "plafond-duree",
  "plafond-fichiers",
  "vous",
  "non-controle",
  "rechargement",
  "redemarrage-cockpit",
  "interrompue",
]);

export interface BandeauEntree {
  /** Demande autonome connue : celle en cours, ou la dernière close (fin de demande) ; null : aucune, le bandeau ne paraît pas. */
  demande: AutonomyRequestView | null;
  /** Largeur au plus 400 px (§5.6) : le bandeau tient sur une ligne, les segments du milieu passent dans « +n ». */
  etroit: boolean;
}

export interface BandeauVue {
  /** Résumé entier « Autonome avec contrôle · 12 automatiques · 1 en attente · 0,08 $ sur 1,00 $ » : toujours lu en entier. */
  resume: string;
  /** Segments du résumé, dans l'ordre ; `visible` faux : montré seulement au lecteur d'écran (bandeau d'une ligne à 400 px). */
  segments: Array<{ texte: string; visible: boolean }>;
  /** « +2 » et son nom accessible quand des segments sont repliés, sinon null. */
  enPlus: { court: string; accessible: string } | null;
  compteurs: { auto: number; attentes: number };
  depense: string;
  plafond: string;
  terminee: boolean;
  /** Phrase de fin de la demande (plafond atteint, arrêt, fin normale) ; null tant qu'elle travaille. */
  fin: string | null;
  /** État vide (§5.4) : la demande s'est terminée sans aucune décision du cockpit. */
  vide: string | null;
  boutons: {
    /** « Arrêter » est visible dès qu'une demande travaille (§4.8.1). */
    arreter: boolean;
    journal: boolean;
    /** [Voir les modifications de cette demande] : en fin de demande seulement (§4.4). */
    modifications: boolean;
  };
}

/**
 * Bandeau d'« Autonome avec contrôle » (§4.12). null : aucun bandeau (aucune demande connue, ou demande d'un autre choix : le
 * bandeau nomme « Autonome avec contrôle », il ne parle pas pour « Modifications automatiques »).
 */
export function bandeauVue(entree: BandeauEntree): BandeauVue | null {
  const demande = entree.demande;
  if (demande === null || demande.choix !== "autonome") return null;
  const resume = bandeau({ auto: demande.auto, attentes: demande.attentes, spent: demande.spent, plafondUsd: demande.plafonds.plafondUsd });
  const parts = resume.split(SEPARATEUR);
  // À 400 px, seuls le premier (le choix) et le dernier (les montants) restent visibles : les compteurs passent dans « +n ».
  const replie = entree.etroit && parts.length > 2;
  const segments = parts.map((texte, i) => ({ texte, visible: !replie || i === 0 || i === parts.length - 1 }));
  const caches = segments.filter((segment) => !segment.visible).length;
  const terminee = demande.fin !== null;
  return {
    resume,
    segments,
    enPlus: caches > 0 ? libelleEnPlus(caches) : null,
    compteurs: { auto: demande.auto, attentes: demande.attentes },
    depense: montant(demande.spent),
    plafond: montant(demande.plafonds.plafondUsd),
    terminee,
    fin: phraseFinDemande(demande),
    vide: terminee && demande.auto === 0 ? TEXTES.partout.journal.vide : null,
    boutons: { arreter: !terminee, journal: true, modifications: terminee },
  };
}

/** Phrase de fin d'une demande close ; null tant qu'elle travaille, ou pour une fin que cette version ne sait pas dire. */
export function phraseFinDemande(demande: AutonomyRequestView): string | null {
  const fin = demande.fin;
  if (fin === null || !FINS_CONNUES.has(fin)) return null;
  return phraseFin(fin as FinPrincipale, demande);
}

/**
 * Annonce polie d'une transition du bandeau (§4.12, §5.5) : une demande qui attend votre accord, une demande terminée. L'annonceur
 * de la page (web/lib/announcer.ts, L5b) en dit au plus une toutes les 2 s et les coupe avec `ui.activityAnnouncements`. Une
 * première lecture n'annonce rien (ce qu'une relecture révèle n'est jamais annoncé) ; les compteurs qui montent non plus.
 */
export function annonceBandeau(precedent: BandeauVue | null, suivant: BandeauVue | null): string | null {
  if (suivant === null || precedent === null) return null;
  if (suivant.terminee && !precedent.terminee) return suivant.fin;
  if (suivant.compteurs.attentes > precedent.compteurs.attentes) return TEXTES.partout.decisions.attente;
  return null;
}

// --- Demande suivie par le bandeau (§4.12) -----------------------------------------------------------------------------------

/** Compteurs et dépense d'un événement `autonomie.demande` (sans la racine) : forme exacte du contrat. */
export type DemandeEvenement = Omit<CockpitEventMap["autonomie.demande"], "rootId">;

/**
 * Même événement LU du flux : un compteur illisible est laissé de côté (données non fiables), les autres sont repris. Un
 * `DemandeEvenement` du contrat en est un cas particulier.
 */
export type DemandeEvenementLu = Omit<DemandeEvenement, "compteurs"> & { compteurs: Partial<DemandeEvenement["compteurs"]> };

/**
 * Demande du bandeau après un événement `autonomie.demande` : les compteurs, la dépense et la fin de l'événement sont reportés sur
 * la demande lue par GET …/autonomie. Un événement qui porte sur une AUTRE demande ne change rien : le bandeau ne mélange jamais
 * deux demandes, et l'interface relit la route pour prendre la suivante. `endedAt` reste celui de la route (le bandeau lit `fin`).
 */
export function demandeApresEvenement(demande: AutonomyRequestView | null, evenement: DemandeEvenementLu): AutonomyRequestView | null {
  if (demande === null || demande.id !== evenement.requestId) return demande;
  return { ...demande, ...evenement.compteurs, spent: evenement.spent, fin: evenement.fin ?? demande.fin };
}

/** Une demande close laisse la place à la suivante : l'interface relit GET …/autonomie pour un événement d'une autre demande. */
export function relirePourEvenement(demande: AutonomyRequestView | null, evenement: DemandeEvenementLu): boolean {
  return demande === null || demande.id !== evenement.requestId;
}

// --- Fin de demande gardée à travers les relectures (R106-b) ----------------------------------------------------------------------
//
// GET …/autonomie ne rend que la demande EN COURS (contrat ConversationAutonomyView : « en cours, sinon null »). La fin d'une
// demande n'arrive donc que par l'événement `autonomie.demande` qui porte `fin`, et toute relecture faite APRÈS la clôture
// rend null. Avant R106-b, le bandeau prenait cette relecture telle quelle : la fin de demande (« Demande terminée. »,
// « Plafond … atteint », [Voir les modifications de cette demande]) disparaissait aussitôt. C'était systématique au plafond et
// au redémarrage d'opencode (la surveillance ferme la demande PUIS remet le choix à « Demander », dont l'événement
// `autonomie.choix` fait relire), et aléatoire quand un envoi suivait de près un changement de choix (it2-ui-bandeau-journal).

/** Demande suivie par le bandeau : celle qu'il affiche, et la dernière qu'il a vue (gardée quand une relecture la retire). */
export interface SuiviBandeau {
  affichee: AutonomyRequestView | null;
  connue: AutonomyRequestView | null;
}

/** Aucune demande vue (conversation ouverte, ou changée). */
export const SUIVI_VIDE: SuiviBandeau = { affichee: null, connue: null };

const estClose = (demande: AutonomyRequestView | null): demande is AutonomyRequestView => demande !== null && demande.fin !== null;

/**
 * Suivi après une relecture de GET …/autonomie (`lue` : la demande en cours, ou null). Une demande close ne se rouvre jamais :
 * - rien en cours : une fin de demande affichée reste affichée ; une demande affichée encore ouverte est retirée (sa fin
 *   n'est pas connue : l'événement qui la porte la rendra, depuis `connue`) ;
 * - la demande en cours est celle que le bandeau sait déjà close (relecture calculée AVANT la clôture et arrivée après son
 *   événement) : la fin reste affichée ;
 * - une autre demande en cours : elle remplace la précédente.
 */
export function suiviApresRelecture(suivi: SuiviBandeau, lue: AutonomyRequestView | null): SuiviBandeau {
  const vue = suivi.affichee ?? suivi.connue;
  if (lue === null) {
    if (estClose(suivi.affichee)) return { affichee: suivi.affichee, connue: suivi.affichee };
    return { affichee: null, connue: vue };
  }
  if (estClose(vue) && vue.id === lue.id) return { affichee: vue, connue: vue };
  return { affichee: lue, connue: lue };
}

/**
 * Suivi après un événement `autonomie.demande` lu du flux. `relire` : l'interface doit relire la route (événement d'une autre
 * demande, ou d'une demande que le bandeau ne connaît pas). La fin d'une demande que la relecture venait de retirer est
 * reprise sur `connue`, sans relecture : la route ne la rendrait plus.
 */
export function suiviApresEvenement(suivi: SuiviBandeau, evenement: DemandeEvenementLu): { suivi: SuiviBandeau; relire: boolean } {
  if (suivi.affichee !== null) {
    if (relirePourEvenement(suivi.affichee, evenement)) return { suivi, relire: true };
    const suite = demandeApresEvenement(suivi.affichee, evenement);
    return { suivi: { affichee: suite, connue: suite }, relire: false };
  }
  if (suivi.connue !== null && suivi.connue.id === evenement.requestId && evenement.fin !== undefined) {
    const suite = demandeApresEvenement(suivi.connue, evenement);
    return { suivi: { affichee: suite, connue: suite }, relire: false };
  }
  return { suivi, relire: true };
}
