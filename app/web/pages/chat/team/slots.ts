// Propriétaire : T4w.
// 1.1, itération 4 (T4w) : propriétés FIGÉES des emplacements web des équipes et de la carte des assistants. TYPES UNIQUEMENT,
// en types primitifs : aucun import de server/shared/team-types.ts (écrit en parallèle par T4). Plan d'exécution it4 §4.2 ;
// spécification §5.1, §5.2, §5.3. Les composants des emplacements rendent null jusqu'à leur paquet (L38a, L38b, L38c, L39b, L40a,
// L40b) ; ils lisent le reste (mode, amorçage, événements, API des équipes) par useApp, useEvents et web/lib/api-teams.ts.
// Changer une propriété : demande écrite à l'intégrateur, au train.

// --- Chat : saisie ---------------------------------------------------------------------------------------------------------

/** Brouillon de la saisie, lu par le lanceur au moment du lancement. */
export interface TeamDraft {
  /** Texte de la demande, sans les espaces de début et de fin. */
  texte: string;
  /** Chemins des fichiers joints par « @ » et encore cités dans le texte (relatifs au dossier de la conversation) ; jamais d'image. */
  fichiers: string[];
}

/** `<TeamLauncher/>` : [Lancer une équipe ▾] et feuille de lancement, dans la saisie juste avant le sélecteur d'autonomie (L38a). */
export interface TeamLauncherProps {
  /** Conversation affichée ; null : nouvelle conversation, pas encore créée (le lancement la crée, D-eq-23). */
  rootId: string | null;
  directory: string;
  advanced: boolean;
  /** La conversation travaille (réponse, travail délégué ou équipe en cours) : le lancement est refusé, raison affichée. */
  busy: boolean;
  /** Brouillon courant de la saisie, lu au clic (jamais gardé). */
  getDraft(): TeamDraft;
  /** Vide la saisie (texte et fichiers joints) après un lancement accepté. */
  clearDraft(): void;
  /** Assistant choisi dans la saisie : celui de la conversation, qui reçoit la demande recopiée et le résultat. */
  agentConversation: string;
  /** Lancement accepté : ChatPage ouvre la conversation `rootId` (créée par le lancement si besoin). */
  onLaunched(rootId: string): void;
}

// --- Chat : dans le fil ----------------------------------------------------------------------------------------------------

/** `<TeamRunCards/>` : cartes d'exécution, de pause, de résultat et d'arrêt des équipes de la conversation, après la carte de plan (L38b). */
export interface TeamRunCardsProps {
  rootId: string;
  directory: string;
  advanced: boolean;
  /** [Voir son travail] : ouvre la conversation d'une étape dans le tiroir de lecture. */
  onOpenSession(sessionId: string): void;
  /**
   * Texte non nul : la saisie est verrouillée avec ce texte (désactivée, texte en guise d'invite, « Arrêter » affiché) tant qu'une
   * équipe travaille ou attend (D-eq-16) ; null : saisie libre. ChatPage remet la valeur à null à chaque changement de conversation.
   */
  onLockChange(texte: string | null): void;
}

// --- Panneau de contexte et Archives ---------------------------------------------------------------------------------------

/** `<TeamDeroule/>` : « Prévu / Réel » de chaque équipe de la conversation, en tête du Déroulé (L38c). */
export interface TeamDerouleProps {
  rootId: string;
  placement: "contexte" | "archives";
  advanced: boolean;
}

// --- Page Assistants ---------------------------------------------------------------------------------------------------------

/** `<TeamsTab/>` : onglet « Équipes » (#/assistants/equipes) : galerie, équipes installées, schéma lu (L40a). */
export interface TeamsTabProps {
  advanced: boolean;
}

/** `<TeamEditor/>` : éditeur guidé en 4 écrans (#/assistants/equipes/nouvelle, …/modifier/<id>), sur toute la page (L40b). */
export interface TeamEditorProps {
  mode: "nouvelle" | "modifier";
  /** Équipe modifiée (identifiant validé par la route) ; null pour une nouvelle équipe. */
  id: string | null;
  advanced: boolean;
}

/** `<CarteTab/>` : onglet « Carte » (#/assistants/carte?element=<id de nœud>) : carte des assistants (L39b). */
export interface CarteTabProps {
  directory: string;
  advanced: boolean;
  /**
   * Élément choisi par l'adresse : identifiant de nœud de la carte (mapNodeId de server/shared/agent-map.ts : `vous`,
   * `agent:<nom>`, `raccourci:<nom>`, `fiche:<nom>`, `equipe:<id>`), validé par la route ; null : élément par défaut.
   */
  element: string | null;
}

// --- Paramètres › Budget -----------------------------------------------------------------------------------------------------

/** `<TeamsBudgetSettings/>` : plafonds et simultanéité des équipes, en mode Avancé seulement (L38c). */
export interface TeamsBudgetSettingsProps {
  /**
   * Modifications non enregistrées du bloc, remontées à l'onglet Budget comme tous les autres blocs de Paramètres : sans ce
   * rappel, changer d'onglet ou fermer la fenêtre jetterait la saisie sans la confirmation « Modifications non enregistrées ».
   */
  onDirty(dirty: boolean): void;
}
