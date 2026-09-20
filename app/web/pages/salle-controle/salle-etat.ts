// Propriétaire : L31b.
// État de la page « Salle de contrôle » (spécification §5.8 l.992-1009, §5.5 l.917-924 ; plan d'exécution it3, fiche L31b,
// D-3d-15, D-3d-25, D-3d-28 ; mesures EXEC/mesures/MX-3D.md §9.1 et §9.3) : zoom lu dans l'adresse, verdict de fluidité,
// proposition de bascule et message à dire. Module PUR : aucun React, aucun DOM, aucune horloge, aucun stockage et AUCUN TEXTE
// (des raisons, mises en phrases par salle3d-texts.ts).
// - `cleZoom` est la clé React de ZoomConversation : elle ne dépend NI du verdict, NI du zoom (§5.8 l.1007 : la position du
//   lecteur survit au passage en 2D et aux allers-retours entre les zooms 2 et 3 d'une même conversation).
// - `doitMonterScene3d` (MX-3D §9.3) : aucune scène 3D — donc aucun WebGLRenderer — tant que `capacites()` n'a pas rendu un
//   verdict 3D ; sinon three écrit un ou deux `console.error` que l'e2e compte comme des erreurs de console.
// - `peutRemettrePoignee` (MX-3D §9.1) : la poignée rendue par `onReady` n'est remise au contrôle de fluidité (`pret()`) que la
//   page visible ; un onglet caché ne reçoit aucune image, et une bascule automatique en 2D n'est JAMAIS gardée comme préférence
//   du poste (D-3d-25), donc un onglet ouvert en arrière-plan ne doit pas fermer la 3D pour de bon.
// - `action` d'une transition : SEULE porte vers le contrôle de fluidité (L30). Une transition automatique (sonde, surveillance,
//   échec de la scène, navigation) n'en demande aucune, donc n'écrit jamais la préférence du poste ; seules [Passer en 2D],
//   [Rester en 3D] et [Réessayer], choisies par la personne, en demandent une.
import type { PreferenceChoix } from "../../../server/shared/fluidity.ts";
import type { FluidityReason, FluidityVerdict } from "../../../server/shared/salle3d-types.ts";

/** Zooms de la salle de contrôle (D-3d-15) : projets, conversation, session détaillée. */
export type ZoomSalle = 1 | 2 | 3;

/** Échec de la scène 3D relayé par Scene3d ou ZoomConversation (slots-3d.ts, D-3d-28). */
export type EchecScene = "contexte-refuse" | "contexte-perdu";

/**
 * Ce que la page dit sous la vue, une fois la bascule faite : une raison de fluidité (phrase par `messageFluidite`) ou la perte
 * du contexte 3D (phrase `salle3d-texts.partout.contexte.perdu`). La PROPOSITION de bascule n'est pas un message : la vue est
 * encore en 3D et la page montre alors `fluidite.saccades` avec [Passer en 2D] et [Rester en 3D].
 */
export type MessageSalle = { genre: "fluidite"; raison: FluidityReason } | { genre: "contexte-perdu" };

export interface EtatSalle {
  zoom: ZoomSalle;
  /** Conversation montrée aux zooms 2 et 3 ; null au zoom 1. */
  rootId: string | null;
  /** Session détaillée au zoom 3 ; null ailleurs. */
  sessionId: string | null;
  verdict: FluidityVerdict;
  /** Bascule en 2D proposée (surveillance, §5.8 l.1006) : la vue est encore en 3D. */
  proposition: boolean;
  message: MessageSalle | null;
}

/** Action demandée au contrôle de fluidité (useFluidite, L30) ; les trois viennent d'un choix de la personne. */
export type ActionFluidite = "passer2d" | "rester3d" | "reessayer";

export interface TransitionSalle {
  etat: EtatSalle;
  /** null : la transition ne demande rien au contrôle de fluidité, donc n'écrit aucune préférence de poste (D-3d-25). */
  action: ActionFluidite | null;
}

/** Préférence du poste écrite par chaque action (D-3d-25, code de fluidite.ts) : [Rester en 3D] n'en garde aucune. */
export const PREFERENCE_ECRITE: Readonly<Record<ActionFluidite, PreferenceChoix | null>> = Object.freeze({
  passer2d: "2d",
  rester3d: null,
  reessayer: "auto",
});

/** Première section de l'adresse de la salle (D-3d-15). */
export const SECTION_SALLE = "salle-controle";

/** Identifiant lisible dans une adresse : même lexique que server/shared/ids.ts (SESSION_ID_RE), borné. */
const ID_ADRESSE = /^[A-Za-z0-9_-]{1,128}$/;

const identifiant = (segment: string | undefined): string | null => (typeof segment === "string" && ID_ADRESSE.test(segment) ? segment : null);

export interface AdresseSalle {
  zoom: ZoomSalle;
  rootId: string | null;
  sessionId: string | null;
}

/**
 * Zoom lu dans la route de `useRoute()` (D-3d-15) : `salle-controle` seul (zoom 1), `salle-controle/<racine>` (zoom 2),
 * `salle-controle/<racine>/<session>` (zoom 3). Un segment qui n'est pas un identifiant est ignoré : l'adresse est une entrée
 * non fiable, et le zoom retombe alors sur le précédent, jamais sur une racine inventée.
 */
export function lireAdresse(route: readonly string[]): AdresseSalle {
  if (route[0] !== SECTION_SALLE) return { zoom: 1, rootId: null, sessionId: null };
  const rootId = identifiant(route[1]);
  if (rootId === null) return { zoom: 1, rootId: null, sessionId: null };
  const sessionId = identifiant(route[2]);
  return sessionId === null ? { zoom: 2, rootId, sessionId: null } : { zoom: 3, rootId, sessionId };
}

/** Message d'un verdict : la 3D ne dit rien, la 2D dit sa raison. */
const messageDuVerdict = (verdict: FluidityVerdict): MessageSalle | null => (verdict.mode === "2d" ? { genre: "fluidite", raison: verdict.raison } : null);

/** État d'ouverture : adresse lue et verdict rendu par `capacites()` au montage (useFluidite). */
export function etatInitial(route: readonly string[], verdict: FluidityVerdict): EtatSalle {
  return { ...lireAdresse(route), verdict, proposition: false, message: messageDuVerdict(verdict) };
}

const sansAction = (etat: EtatSalle): TransitionSalle => ({ etat, action: null });

/** Changement d'adresse (fil d'Ariane, grille, sélecteur) : le verdict, la proposition et le message de la vue ne changent pas. */
export function naviguer(etat: EtatSalle, route: readonly string[]): TransitionSalle {
  return sansAction({ ...etat, ...lireAdresse(route) });
}

/**
 * Verdict du contrôle de fluidité (capacités relues, sonde finie, bascule automatique de la surveillance) : la vue suit, le
 * message dit la raison. AUCUNE action, donc aucune préférence de poste écrite (D-3d-25) : seul un choix de la personne l'est.
 */
export function verdictSonde(etat: EtatSalle, verdict: FluidityVerdict): TransitionSalle {
  const enTroisD = verdict.mode === "3d";
  return sansAction({ ...etat, verdict, proposition: enTroisD && etat.proposition, message: messageDuVerdict(verdict) });
}

/** Surveillance (§5.8 l.1006) : bascule proposée ou retirée, la vue restant en 3D. Aucune préférence écrite. */
export function surveillance(etat: EtatSalle, proposition: boolean): TransitionSalle {
  return sansAction({ ...etat, proposition: proposition && etat.verdict.mode === "3d" });
}

/**
 * Échec de la scène 3D (D-3d-28) : contexte refusé à la création, ou perdu sans libération volontaire. Retour en 2D sans toucher
 * à la préférence du poste ; une libération volontaire n'en produit jamais.
 */
export function echec3d(etat: EtatSalle, raison: EchecScene): TransitionSalle {
  const verdict: FluidityVerdict = { mode: "2d", raison: "webgl-absent" };
  const message: MessageSalle = raison === "contexte-perdu" ? { genre: "contexte-perdu" } : { genre: "fluidite", raison: "webgl-absent" };
  return sansAction({ ...etat, verdict, proposition: false, message });
}

/** [Passer en 2D] : choix de la personne, gardé pour ce poste (D-3d-25). Le verdict vient ensuite du contrôle de fluidité. */
export function passer2d(etat: EtatSalle): TransitionSalle {
  return { etat: { ...etat, proposition: false }, action: "passer2d" };
}

/** [Rester en 3D] : proposition retirée, surveillance suspendue jusqu'à [Réessayer] ; rien n'est gardé sur le poste. */
export function rester3d(etat: EtatSalle): TransitionSalle {
  return { etat: { ...etat, proposition: false }, action: "rester3d" };
}

/**
 * [Réessayer] : préférence du poste remise à `auto`, capacités relues et nouvelle sonde (D-3d-25). Le message n'est pas effacé
 * ici : il est remplacé par celui du verdict qui suit, et une cause qui n'a pas bougé (réglages d'accessibilité) reste dite.
 */
export function reessayer(etat: EtatSalle): TransitionSalle {
  return { etat: { ...etat, proposition: false }, action: "reessayer" };
}

/**
 * Clé React de ZoomConversation : la conversation, et elle seule. Un passage en 2D, un retour en 3D ou un aller-retour entre les
 * zooms 2 et 3 ne remontent donc pas le composant, et la position du lecteur en différé survit (§5.8 l.1007).
 */
export function cleZoom(etat: EtatSalle): string {
  return etat.rootId ?? "";
}

/** MX-3D §9.3 : la scène 3D n'est montée — donc aucun WebGLRenderer créé — qu'après un verdict 3D de `capacites()`. */
export function doitMonterScene3d(etat: EtatSalle): boolean {
  return etat.verdict.mode === "3d";
}

/** MX-3D §9.1 : la poignée d'`onReady` n'est remise à la sonde (`pret()`) que la page visible et la scène 3D montée. */
export function peutRemettrePoignee(etat: EtatSalle, visible: boolean): boolean {
  return visible && doitMonterScene3d(etat);
}
