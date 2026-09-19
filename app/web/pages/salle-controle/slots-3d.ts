// Salle de contrôle 3D et « Revoir » (itération 3, T3d-a ; plan d'exécution it3 §4.1.3, §2.3) : propriétés FIGÉES des composants
// 3d et interface du moteur three. TYPES UNIQUEMENT. Un paquet consomme un composant ou le moteur d'un autre paquet par ces
// contrats et le squelette posé par T3d-a, jamais par son implémentation. `import type` permis partout (effacé, D-3d-05).
// Changer une propriété : demande écrite à l'intégrateur, au train.
import type { ActivityFact } from "../../../server/shared/activity-types.ts";
import type { NeonTheme } from "../../../server/shared/neon-palette.ts";
import type { NeonMode } from "../../../server/shared/neon-scene.ts";
import type { LegendeKey, Plan3d, Point3, ReplaySpeed } from "../../../server/shared/salle3d-types.ts";

// --- Scène 3D (L29d, consommée par L31b et L31c) ---------------------------------------------------------------------------

/** `<Scene3d/>` : canevas three (aria-hidden) et étiquettes DOM focalisables ; la liste et le tableau restent la vérité. */
export interface Scene3dProps {
  plan: Plan3d;
  mouvementReduit: boolean;
  /** « Suivre l'action » : cible vers laquelle la caméra se déplace (en 1 s au plus), différé seulement ; null sinon. */
  suivre: Point3 | null;
  /** Élément choisi (étiquette ou clic) : identifiant d'un nœud, d'un territoire ou d'une station du plan. */
  onSelect(id: string): void;
  /** Après chaque image : durée (ms) et « quelque chose s'anime » (surveillance de la fluidité). */
  onFrame?(ms: number, anime: boolean): void;
  onReady?(poignee: Scene3dHandle): void;
  /** Contexte WebGL refusé à la création ou perdu sans libération volontaire (D-3d-28) : la page passe en 2D. */
  onEchec(raison: "contexte-refuse" | "contexte-perdu"): void;
}

export interface Scene3dHandle {
  renderFrame(): void;
  info(): { geometries: number; textures: number };
  liberer(): void;
}

// --- Moteur three (produit par L29c, consommé par L29d) -----------------------------------------------------------------------

export interface MoteurOptions {
  theme: NeonTheme;
  mouvementReduit: boolean;
  onFrame?(ms: number, anime: boolean): void;
  /** Après chaque image rendue : replacer les étiquettes DOM. */
  onImage?(): void;
  /** Perte de contexte non demandée ; jamais appelé par liberer() (D-3d-28). */
  onEchec(raison: "contexte-perdu"): void;
}

export interface Moteur {
  /** Rendu à la demande : une image par changement de plan (D-3d-17). */
  afficher(plan: Plan3d): void;
  renderFrame(): void;
  suivre(cible: Point3, ms: number): void;
  /** Position à l'écran (px CSS) d'un point de la scène ; `visible` faux derrière la caméra ou hors du cadre. */
  projeter(p: Point3): { x: number; y: number; visible: boolean };
  redimensionner(largeur: number, hauteur: number, ratio: number): void;
  info(): { geometries: number; textures: number };
  /** Libère géométries, matériaux, textures et contexte ; sans bascule en 2D. */
  liberer(): void;
}

/** null : contexte WebGL refusé (la page passe en 2D). Seule fabrique, chargée par moteur-chargeur.ts (import dynamique). */
export type CreerMoteur = (canvas: HTMLCanvasElement, options: MoteurOptions) => Moteur | null;

// --- Zooms 2 et 3 (produits par L31c, consommés par la page L31b) ----------------------------------------------------------------

export interface ZoomConversationProps {
  rootId: string;
  /** Session détaillée (zoom 3) ; null au zoom 2. */
  sessionId: string | null;
  mode: NeonMode;
  theme: NeonTheme;
  /** Racine de la Salle OMO. */
  salle: boolean;
  /** Verdict de fluidité « 3d » ; faux : vue 2D. */
  vue3d: boolean;
  mouvementReduit: boolean;
  onEchec3d(raison: "contexte-refuse" | "contexte-perdu"): void;
  onFrame?(ms: number, anime: boolean): void;
  onReady?(poignee: Scene3dHandle): void;
  onZoom(cible: { zoom: 2; rootId: string } | { zoom: 3; rootId: string; sessionId: string }): void;
}

// --- « Revoir » (L28b, L28c, L28d) -------------------------------------------------------------------------------------------

/** `<ReplayBar/>` : barre du lecteur (moments, lecture, vitesses, badge). */
export interface ReplayBarProps {
  index: number;
  total: number;
  /** Heure du moment montré (ms) ; null sans moment. */
  heure: number | null;
  vitesse: ReplaySpeed;
  lecture: boolean;
  direct: boolean;
  /** Durée réelle d'un écart raccourci à 1 s (étiquette), null sinon (D-3d-11). */
  raccourciMs: number | null;
  /** « Suivre l'action » : null quand il n'est pas proposé (2D ou direct). */
  suivre: boolean | null;
  onLire(): void;
  onFiger(): void;
  onPrecedent(): void;
  onSuivant(): void;
  onAller(index: number): void;
  onVitesse(v: ReplaySpeed): void;
  /** [Revenir au direct] ; absent : bouton non proposé. */
  onDirect?(): void;
  onSuivre?(actif: boolean): void;
}

/** `<RevoirDialog/>` : « Revoir » en 2D dans une boîte de dialogue, sans monter NeonBand (D-3d-12). */
export interface RevoirDialogProps {
  rootId: string;
  ouvert: boolean;
  onFermer(): void;
  /** Demande à ouvrir (index) ; absente ou null : la dernière. */
  demande?: number | null;
}

/** `<BandCommands3d/>` : [Revoir cette demande] et [Ouvrir la salle de contrôle] dans la barre de la bande (L28b). */
export interface BandCommands3dProps {
  rootId: string;
  facts: ActivityFact[];
  advanced: boolean;
}

/** `<RevoirEntree/>` : [Revoir cette demande] depuis les Archives ou le zoom 1 (L28b). */
export interface RevoirEntreeProps {
  rootId: string;
  placement: "archives" | "zoom1";
}

/**
 * `<LegendeBulle/>` : 1 ou 2 phrases, [Pourquoi ?], [Voir la consigne]. `onVoirConsigne` est passé par « Revoir » quand la légende
 * porte une consigne gardée (U2, D-3d-12) et par le zoom 3 de la salle de contrôle, en direct et en différé ; jamais par une
 * démonstration.
 */
export interface LegendeBulleProps {
  cles: LegendeKey[];
  salle: boolean;
  mode: NeonMode;
  onVoirConsigne?(): void;
}

/**
 * `<ConsigneRevoir/>` : panneau de la consigne gardée (L28d, consommé par L28c et L31c). `callId` : une consigne ; `enfant` : toutes
 * les consignes gardées de cette session, pour une session sans fait `consigne` qui la désigne (étape d'équipe, D-3d-30).
 */
export interface ConsigneRevoirProps {
  rootId: string;
  cible: { callId: string } | { enfant: string };
  onFermer(): void;
}
