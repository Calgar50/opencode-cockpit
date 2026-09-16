// 1.1 (T2) : propriétés FIGÉES de chaque emplacement posé dans les pages gelées après T2 (ChatPage, Composer, Interactions,
// ContextPanel, ArchiveDetail, DiagnosticsPage, Paramètres › Affichage). TYPES UNIQUEMENT. Plan d'exécution §2.8 et fiche T2 ;
// spécification §5.1, §4.13, §3.14, §2.2. Les composants des emplacements rendent null jusqu'à leur paquet ; ils lisent le reste
// (mode, amorçage, événements) par useApp et useEvents. Changer une propriété : demande écrite à l'intégrateur, au train.
import type { ReactNode } from "react";
import type { AutomaticChoice, AutonomyCaps, CockpitEventMap, DiagnosticActiviteResponse } from "../../lib/types.ts";

// --- Chat : au-dessus du fil ----------------------------------------------------------------------------------------------

/** `<ActivityRegion/>` : « Qui travaille ? », liste des acteurs et bande néon 2D, entre l'en-tête et le fil (L5b, L5c). */
export interface ActivityRegionProps {
  /** Conversation affichée (racine). */
  rootId: string;
  directory: string;
  advanced: boolean;
  /**
   * L'arbre de la conversation travaille (racine, travail délégué, contrôles) : « Arrêter » reste affiché dans la saisie
   * même quand la racine ne travaille plus. ChatPage remet la valeur à false à chaque changement de conversation.
   */
  onTreeWorking: (working: boolean) => void;
  /** Ouvre une conversation déléguée dans le tiroir de lecture. */
  onOpenSession: (sessionId: string) => void;
  /** [Répondre] : ChatPage déplace le focus sur la carte de cette demande d'autorisation (clic de l'utilisateur seulement). */
  onReply: (permissionId: string) => void;
}

/** `<AutonomyBanner/>` : bandeau « Autonome avec contrôle · … » [Arrêter] [Journal], sous l'en-tête (L12b). */
export interface AutonomyBannerProps {
  rootId: string;
  directory: string;
  /** Même arrêt que le bouton « Arrêter » de la saisie (arbre entier, repli 1.0.4). */
  onStop: () => void;
  /** [Journal] : ChatPage ouvre le panneau de contexte et demande au Déroulé d'y montrer le Journal du contrôle. */
  onOpenJournal: () => void;
}

// --- Chat : dans le fil ---------------------------------------------------------------------------------------------------

/** `<DelegationNotice/>` : avis du mode Simple après un refus automatique de délégation, après les tours (L1f). */
export interface DelegationNoticeProps {
  rootId: string;
  advanced: boolean;
}

/**
 * `<PlanCard/>` : carte après chaque réponse d'une conversation de plan, en fin de fil (L6c). Les choix automatiques passent
 * par `<AutonomyConfirm/>` (propriétés ci-dessous) sur 428.
 */
export interface PlanCardProps {
  rootId: string;
  directory: string;
  /** La racine travaille : la carte attend la fin de la réponse. */
  busy: boolean;
  onOpenConversation: OpenConversation;
}

/**
 * Ouvre une conversation (plan, exécution de plan) : ChatPage navigue vers `rootId` et, si `draft` n'est pas null, remplace le
 * texte de la saisie par ce brouillon (l'utilisateur relit et envoie). null : la saisie garde son texte.
 */
export type OpenConversation = (rootId: string, draft: string | null) => void;

// --- Chat : en-tête et saisie ---------------------------------------------------------------------------------------------

/** `<AutonomySelector/>` : bouton de menu avant « Envoyer » (`composer`) et répété dans l'en-tête (`header`) (L6s, L12a). */
export interface AutonomySelectorProps {
  placement: "composer" | "header";
  /** null : nouvelle conversation, pas encore créée. */
  rootId: string | null;
  directory: string;
  advanced: boolean;
  /** La racine travaille. */
  busy: boolean;
  onOpenConversation: OpenConversation;
  /**
   * Crée la conversation si elle n'existe pas encore (même création que l'envoi, navigation comprise) et rend son identifiant ;
   * rend l'identifiant courant sinon. Le texte en cours de saisie est gardé.
   */
  ensureConversation: () => Promise<string>;
}

/** `<AutonomyConfirm/>` : confirmation d'un choix automatique, réutilisée par le sélecteur et la carte de plan (L12a). */
export interface AutonomyConfirmProps {
  open: boolean;
  choix: AutomaticChoice;
  /** Dossier de la conversation ({dossier}). */
  directory: string;
  /** Plafonds proposés ({x} = plafondUsd), modifiables et bornés dans la confirmation. */
  plafonds: AutonomyCaps;
  /** Envoi en cours : boutons désactivés. */
  busy?: boolean;
  onConfirm: (plafonds: AutonomyCaps) => void;
  onCancel: () => void;
}

// --- Chat : demandes d'autorisation (Interactions) ------------------------------------------------------------------------

/** Décision du contrôle pour une demande (forme de l'événement `autonomie.decision`, sans la racine). */
export type PermissionDecision = Omit<CockpitEventMap["autonomie.decision"], "rootId">;

/** État d'une demande d'autorisation vu par l'autonomie ; clé : identifiant de la demande. */
export interface PermissionAutonomyState {
  /** Contrôle de sécurité en cours : seul [Refuser…] est proposé (60 s au plus, borne tenue par la source de l'état). */
  examining: boolean;
  decision: PermissionDecision | null;
}

/** Délégation (`task`) : contexte de la carte détaillée `<DelegationDetails/>` (L1f). */
export interface PermissionDelegationContext {
  rootId: string;
  advanced: boolean;
}

/** Propriétés 1.1 de `PermissionPrompt`, toutes facultatives : absentes, la carte est celle de la 1.0.4. */
export interface PermissionPromptSlots {
  decision?: PermissionDecision | null | undefined;
  examining?: boolean | undefined;
  /** [Arrêter] de la carte d'attente (affiché avec une décision). */
  onStop?: (() => void) | undefined;
  delegation?: PermissionDelegationContext | null | undefined;
}

/** `<DecisionStatus/>` : « Contrôle de sécurité en cours… » ou « En attente de votre accord » · « Règle : … » (L12b). */
export interface DecisionStatusProps {
  examining: boolean;
  decision: PermissionDecision | null;
}

/** `<DelegationDetails/>` : carte détaillée d'une délégation en mode Avancé (L1f). */
export interface DelegationDetailsProps {
  rootId: string;
  permissionId: string;
  sessionId: string;
  advanced: boolean;
}

// --- Saisie (Composer) ----------------------------------------------------------------------------------------------------

/** Propriétés 1.1 de `Composer`, facultatives : absentes, la saisie est celle de la 1.0.4. */
export interface ComposerSlots {
  /** Emplacement du sélecteur d'autonomie, avant « Envoyer ». */
  autonomy?: ReactNode;
  /** « Arrêter » affiché aussi quand la racine ne travaille plus mais que son arbre travaille (`onTreeWorking`). */
  stopVisible?: boolean | undefined;
}

// --- Panneau de contexte et Archives --------------------------------------------------------------------------------------

/** `<Deroule/>` : Déroulé de la conversation et emplacement du Journal du contrôle (L5t, puis L12c). */
export interface DerouleProps {
  rootId: string;
  placement: "contexte" | "archives";
  advanced: boolean;
  /** Change quand le coût de la conversation change (événement `usage.updated`). */
  usageTick?: number | undefined;
  /** Change à chaque [Journal] du bandeau : le Déroulé montre le Journal du contrôle, sans voler le focus ailleurs. */
  journalNonce?: number | undefined;
}

// --- Diagnostic -----------------------------------------------------------------------------------------------------------

/**
 * `<DelegationDiagnostics/>` (L1f) et `<AutonomyDiagnostics/>` (L12c), dans la carte « Travail délégué et autonomie ». La carte
 * reste masquée tant qu'aucun des deux ne s'annonce par `onPresence(true)` : sans contenu, le Diagnostic est celui de la 1.0.4.
 */
export interface ActivityDiagnosticsProps {
  data: DiagnosticActiviteResponse;
  onPresence: (present: boolean) => void;
}

// --- Paramètres › Affichage -----------------------------------------------------------------------------------------------

/** `<ActivitySettings/>` : annonces de « Qui travaille ? » (`ui.activityAnnouncements`), après le mode d'affichage (L5b). */
export type ActivitySettingsProps = Record<string, never>;
