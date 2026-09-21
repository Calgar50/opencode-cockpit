// Contrat 1.1 « Qui travaille ? » et carte néon : TYPES UNIQUEMENT (aucun code exécuté), partagés par le serveur et l'interface.
// Spécification §3.5 (migration 5), §3.9, §3.10, §5.7.2, §5.7.3 ; plan d'exécution §4.2 (T0, D-01).
import type { AutonomyChoice, AutonomyRequestView, ChoiceCause, DecisionVerdict, DecisionView, RepliedBy } from "./autonomy-types.ts";

/**
 * Nature d'un fait persisté (`activity_facts.kind`, colonne TEXT). « decision » (D-01) : un fait par ligne de
 * `autonomy_decisions` ; « choix » : changement du choix d'autonomie (clic, retour à « demander »).
 */
export type ActivityFactKind =
  | "statut"
  | "attente"
  | "reponse"
  | "origine"
  | "consigne"
  | "resultat"
  | "reveil"
  | "reprise"
  | "carnet"
  | "detection"
  | "affichage"
  | "decision"
  | "choix";

export type FactValue = string | number | boolean | null;

/** Fait persisté (`activity_facts`) : « Revoir » le relit par la même fonction que le direct (P12). */
export interface ActivityFact {
  id?: number;
  rootId: string;
  sessionId: string;
  kind: ActivityFactKind;
  /** permission_id, message_id ou call_id. */
  ref: string | null;
  /** Identifiants, états, empreintes, codes : JAMAIS de texte de message, de consigne ni de sortie d'outil. */
  data: Record<string, FactValue>;
  at: number;
}

/**
 * `data.cause` d'un fait « statut » écrit par un arrêt, un plafond, « Passé sans contrôle » ou un redémarrage d'opencode.
 * « hors-controle » (D-2b-41) : arrêt de la Salle OMO après une détection ; les lecteurs de l'instance principale ne la
 * connaissent pas et restent muets plutôt que d'inventer une phrase (P3).
 */
export type StatutCause = "arret" | "plafond" | "non-controle" | "interrompue" | "hors-controle";

/**
 * Forme de `data` d'un fait « statut » posé par un arrêt ou un plafond. stopTree (L1c) y ajoute `motif` (la StopCause de l'arrêt :
 * « vous », « plafond-cout »…), `nonConfirmees` (nombre de sessions encore occupées après la sonde) et `debut` (heure du début de
 * l'arrêt, ms) : une session dont le travail s'est fermé entre `debut` et l'heure du fait a été arrêtée, même sans
 * MessageAbortedError (tour clos par le refus d'une demande en attente).
 */
export interface StatutFactData {
  cause: StatutCause;
  [key: string]: FactValue;
}

/**
 * Forme de `data` d'un fait « decision » (D-01, une ligne de `autonomy_decisions`, écrit par le cycle d'autonomie) : `ref` est
 * l'identifiant de la demande d'autorisation. Lu par la scène néon (L5a : bouclier coché ou croix). Jamais la raison ni le résumé
 * (textes) : ils restent dans `autonomy_decisions`.
 */
export interface DecisionFactData {
  verdict: DecisionVerdict;
  /** Code de la règle appliquée (`autonomy_decisions.regle`), jamais un texte libre. */
  regle: string;
  [key: string]: FactValue;
}

/**
 * Forme de `data` d'un fait « detection » (L10c) : le cockpit a VU quelque chose après coup, sans rien arrêter — « non-controle »,
 * une commande qu'opencode a lancée sans poser de demande d'autorisation (§4.10). `ref` est l'appel d'outil. Un arrêt, lui, s'écrit
 * toujours en fait « statut {cause} » (L1c) : le réducteur d'activité ne lit que celui-là comme un arrêt de la conversation.
 */
export interface DetectionFactData {
  cas: "non-controle";
  [key: string]: FactValue;
}

/** Forme de `data` d'un fait « choix ». */
export interface ChoixFactData {
  choix: AutonomyChoice;
  cause: ChoiceCause;
  [key: string]: FactValue;
}

/**
 * `data.etat` d'un fait « affichage » (L4b) : « deroule-partiel », écrit par le magasin à la place du 20 000e fait d'une
 * conversation (« Déroulé partiel », plus rien d'enregistré ensuite) ; « rattrape », écrit par POST …/facts/affichage quand la bande
 * 2D vide sa file (« Affichage rattrapé »).
 */
export type AffichageEtat = "deroule-partiel" | "rattrape";

/** Forme de `data` d'un fait « affichage ». */
export interface AffichageFactData {
  etat: AffichageEtat;
  [key: string]: FactValue;
}

/**
 * Forme de `data` d'un fait « reponse » : réponse vue dans le flux (`permission.replied`), ou « expiree » écrit par la dérivation
 * des faits (L4b) quand l'instance qui portait la demande est libérée sans réponse (mesure M14).
 * `par: "cockpit"` : refus Simple envoyé par le cockpit (L1d), écrit après l'envoi en plus du fait tiré du flux (arbitrage du train
 * it1 V3 : gardé, il clôt l'attente même si l'événement du flux est manqué). Deux faits de même clé (reponse, session, demande) : les
 * lecteurs gardent le premier ; l'auteur de la réponse est porté par permission_waits.replied_by (work.markWait), jamais par ce champ.
 */
export interface ReponseFactData {
  reponse: "once" | "always" | "reject" | "expiree";
  [key: string]: FactValue;
}

/**
 * Rôle d'une session dans l'arbre, dérivé de `sessions.purpose` : une session « controle » est la ligne « Contrôle de
 * sécurité » et n'entre JAMAIS dans « dont x $ de travail délégué » ; « etape » : équipes (itération 4).
 */
export type SessionRole = "conversation" | "delegation" | "controle" | "etape";

/** Origine d'un message utilisateur, classement positif dans l'ordre (§5.7.2) ; cas 4 et 5 réservés à la Salle OMO. */
export type MessageOrigin =
  | "demande"
  | "cockpit"
  | "consigne"
  | "reveil-sans-reponse"
  | "relance-extension"
  | "interne-extension"
  | "interne-opencode"
  | "origine-inconnue";

/** Instance opencode qui sert une session (`sessions.instance`, migration 5). */
export type SessionInstance = "principale" | "omo";

/** `delegations.state` (migration 4). */
export type DelegationState =
  | "prepare"
  | "attente-accord"
  | "autorisee"
  | "travaille"
  | "terminee"
  | "arretee"
  | "jamais-demarree"
  | "refusee"
  | "expiree";

/** `delegations.source`. */
export type DelegationSource = "ia" | "raccourci";

/** État d'une attente d'accord (`permission_waits.reply`, null tant qu'aucune réponse : « attente »). */
export type WaitState = "attente" | "once" | "reject" | "expiree";

/**
 * Transitions permises d'une délégation : pour chaque état, les états suivants possibles. Un état final (`never`) ne
 * régresse jamais : `facts.work.markDelegation` (L4b, seul écrivain de `delegations`) refuse toute autre transition.
 */
export interface DelegationTransitions {
  prepare: "attente-accord" | "autorisee" | "travaille" | "refusee" | "expiree" | "arretee" | "jamais-demarree";
  "attente-accord": "autorisee" | "refusee" | "expiree" | "arretee" | "jamais-demarree";
  autorisee: "travaille" | "terminee" | "arretee" | "jamais-demarree";
  travaille: "terminee" | "arretee";
  terminee: never;
  arretee: never;
  "jamais-demarree": never;
  refusee: never;
  expiree: never;
}

/** Transitions permises d'une attente d'accord (`facts.work.markWait`, L4b, seul écrivain de `permission_waits`). */
export interface WaitTransitions {
  attente: "once" | "reject" | "expiree";
  once: never;
  reject: never;
  expiree: never;
}

export type DelegationFinalState = { [S in DelegationState]: [DelegationTransitions[S]] extends [never] ? S : never }[DelegationState];
export type WaitFinalState = { [S in WaitState]: [WaitTransitions[S]] extends [never] ? S : never }[WaitState];

/** Ligne de `delegations`. */
export interface DelegationView {
  id: number;
  rootId: string;
  parentSessionId: string;
  childSessionId: string | null;
  callId: string;
  agent: string;
  command: string | null;
  source: DelegationSource;
  /**
   * Lancée sans demande par un raccourci `subtask` (§4.10, §6 l.1048) : source « raccourci » et aucune demande connue pour l'appel.
   * Une commande remplie par l'IA passe par une demande : jamais marquée. Un agent `task: allow` ne l'est pas non plus (l'absence
   * d'une demande vue dans le flux ne prouve rien) : DelegationWatch surveille ses plafonds et le Diagnostic le signale (§3.14).
   */
  sansConfirmation: boolean;
  state: DelegationState;
  permissionId: string | null;
  createdAt: number;
  startedAt: number | null;
  endedAt: number | null;
}

/** Ligne de `permission_waits`. */
export interface PermissionWaitView {
  permissionId: string;
  sessionId: string;
  rootId: string;
  permission: string;
  target: string | null;
  askedAt: number;
  repliedAt: number | null;
  reply: Exclude<WaitState, "attente"> | null;
  repliedBy: RepliedBy | null;
}

/**
 * Refus de la garde du `task once` (§3.14), en code : demande morte ; cible inconnue, primaire, interne ou privée ; task_id
 * hors de l'arbre ; consigne avec @fichier, ``!` `` ou URL ; IA hors Copilot ou hors catalogue ; garde-fou budgétaire ;
 * plafond par demande (nombre ou coût).
 */
export type DelegationRefusalCode =
  | "demande-morte"
  | "cible-refusee"
  | "task-id-hors-arbre"
  | "consigne-refusee"
  | "ia-refusee"
  | "budget-refuse"
  | "plafond-atteint";

export type RuleActionLite = "allow" | "ask" | "deny";

/** Réponse de GET /api/conversations/:rootId/delegations/:permissionId (carte détaillée du mode Avancé, L1d). */
export interface DelegationDetailsView {
  rootId: string;
  permissionId: string;
  sessionId: string;
  cible: { nom: string; titre: string; mode: string; interne: boolean } | null;
  ia: { model: string | null; disponible: boolean };
  estimationUsd: number | null;
  /** Droits comparés de l'appelant et de la cible, par permission. */
  droits: Array<{ permission: string; appelant: RuleActionLite | null; cible: RuleActionLite | null }>;
  compteurs: { delegations: number; delegationsMax: number; depenseUsd: number; plafondUsd: number };
  /** Refus que la garde appliquerait à un « Autoriser une fois », null si aucun. */
  refus: DelegationRefusalCode | null;
}

/** État d'un acteur dans « Qui travaille ? » (§2.3, « États ») ; le libellé vient du module de textes. */
export type ActorState =
  | "pas-commence"
  | "prepare-delegation"
  | "travaille"
  | "redige"
  | "attend-delegation"
  | "attente-accord"
  | "controle"
  | "attend-verification"
  | "nouvelle-tentative"
  | "termine"
  | "echec"
  | "arrete"
  | "jamais-demarre"
  | "non-choisi";

/** Détail de « travaille » : lit {chemin}, cherche « {motif} », modifie {chemin}, lance une commande. */
export interface ActorActivity {
  kind: "lit" | "cherche" | "modifie" | "commande";
  detail: string | null;
}

/** Ligne d'acteur produite par server/shared/activity.ts (L4c) et affichée par l'interface. */
export interface ActivityRow {
  sessionId: string;
  parentId: string | null;
  rootId: string;
  role: SessionRole;
  instance: SessionInstance;
  title: string;
  agent: string | null;
  /** 0 : racine ; au plus 3 niveaux affichés. */
  depth: number;
  state: ActorState;
  activity: ActorActivity | null;
  since: number | null;
  cost: number;
  calls: number;
  /** Numéro de la nouvelle tentative en cours, null sinon. */
  attempt: number | null;
}

/** Appel d'IA vu dans le registre des coûts (Déroulé). */
export interface UsageSpan {
  sessionId: string;
  messageId: string;
  start: number;
  end: number | null;
  cost: number;
}

/** Réponse de GET /api/conversations/:rootId/activity (L4b). */
export interface ActivityResponse {
  /** Équipes : itération 4. */
  runs: never[];
  delegations: DelegationView[];
  waits: PermissionWaitView[];
  decisions: DecisionView[];
  requests: AutonomyRequestView[];
  usageSpans: UsageSpan[];
}

/** Réponse de GET /api/conversations/:rootId/facts?since= (L4b) ; `partial` : borne de 20 000 faits atteinte. */
export interface FactsResponse {
  facts: ActivityFact[];
  partial: boolean;
}

/** Réponse de POST /api/conversations/:rootId/facts/affichage (L4b) ; false : borne de 2 s ou « Déroulé partiel », rien d'écrit. */
export interface AffichageResponse {
  enregistre: boolean;
}
