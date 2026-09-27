// Contrats de la salle de contrôle 3D et de « Revoir » (itération 3, T3d-a ; plan d'exécution it3 §4.1.1, spécification §5.8,
// §5.9, P12). TYPES UNIQUEMENT : aucun code exécutable (règle de pureté des *-types.ts, core.test.ts).
// - Référence des types recopiés en vague 0 (D-3d-27) : FluidityReason et FluidityVerdict (T3d-b, L30), ReplaySpeed et ReplayBadge
//   (T3d-b, L28a), LegendeKey et RevoirRefus (T3d-b, L28a). Le train de V0 les compare par affectation dans les deux sens, puis
//   remplace chaque copie par une réexportation de ce fichier. Changer l'un d'eux : demande écrite à l'intégrateur, au train.
// - Plan 3D (Plan3d et ses éléments) : produit par L29a (zooms 2 et 3) et L31a (zoom 1), consommé par L29b, L29c, L29d, L31b et
//   L31c. Jamais de texte de message dans un plan : seulement des identifiants, des états, des noms d'assistant ou de projet et des
//   positions. `faits` = indices dans la liste de faits donnée à scene() (P12 : aucun signe dessiné sans fait enregistré) ; le
//   décor (sol, stations, territoires) n'en porte pas.
// - Les ports rendent des CODES, jamais des phrases : les phrases sont dans salle3d-texts.ts, revoir-texts.ts et legendes-texts.ts.
import type { ActivityFact, SessionInstance } from "./activity-types.ts";
import type { NeonTheme, NeonToken } from "./neon-palette.ts";
import type { NeonBeamKind, NeonMode, NeonNodeState, NeonSector, NeonStationId } from "./neon-scene.ts";

// --- Fluidité (spéc. §5.8 l.1003-1008, JP-12) --------------------------------------------------------------------------------

/**
 * Raison d'un affichage 2D : réglages d'accessibilité (mouvement réduit, couleurs forcées), WebGL 2 absent ou refusé, rendu sans
 * carte graphique, sonde de 90 images trop lente, saccades pendant la surveillance, choix « 2D » gardé sur ce poste.
 */
export type FluidityReason = "accessibilite" | "webgl-absent" | "rendu-logiciel" | "sonde-lente" | "saccades" | "preference-2d";

export type FluidityVerdict = { mode: "3d" } | { mode: "2d"; raison: FluidityReason };

// --- Lecteur de « Revoir » (spéc. §5.8 l.998, D-3d-11) -----------------------------------------------------------------------

/** Vitesses du lecteur ; ×1 par défaut. */
export type ReplaySpeed = 0.25 | 0.5 | 1 | 2 | 4;

/** Badge du lecteur : en direct, ou en différé à une vitesse, à l'heure du moment montré (ms). */
export type ReplayBadge = { etat: "direct" } | { etat: "differe"; vitesse: ReplaySpeed; heure: number };

// --- Légendes (spéc. §5.8 l.999-1002, JP-5) ----------------------------------------------------------------------------------

/** Clé d'une phrase de légende (legendes-texts.ts) ; au plus deux par légende. */
export type LegendeKey = "neuf" | "reprise" | "carnet" | "tache-de-fond" | "reveil" | "relance";

// --- « Revoir » (spéc. §5.9 l.1018-1024, Q6, D-3d-08, D-3d-09) ----------------------------------------------------------------

/**
 * Refus de « Revoir » : racine inconnue (404) ; racine de la Salle OMO en mode Simple dont la demande n'est pas terminée (403) ou
 * dont la fin n'est pas vérifiable (403, fermé en cas de doute).
 */
export type RevoirRefus = "racine-inconnue" | "salle-demande-en-cours" | "salle-fin-inconnue";

/** GET /api/revoir/:rootId (lecture seule, aucune requête à opencode). */
export interface RevoirResponse {
  rootId: string;
  /** Titre de la conversation, passé par redactSecrets côté serveur. */
  titre: string;
  instance: SessionInstance;
  /** Dernière demande terminée (D-3d-09). */
  termine: boolean;
  /** Faits persistés de la conversation, sans aucun texte de message (P12). */
  facts: ActivityFact[];
  /** Faits partiels (borne du magasin) : « Déroulé partiel ». */
  partial: boolean;
}

/** GET /api/revoir/:rootId?etat=1 : accès à « Revoir » sans les faits (entrées des Archives et du zoom 1, route des consignes). */
export interface RevoirEtatResponse {
  rootId: string;
  acces: boolean;
  /** null quand l'accès est donné. */
  raison: RevoirRefus | null;
  /**
   * Instance de la racine (D-3d-14) ; null quand la racine est inconnue du cockpit. Une instance illisible est annoncée « omo »,
   * comme la règle d'accès la traite : la salle est fermée en cas de doute, jamais « principale » par défaut. Lecture DÉCISIVE
   * pour la page du zoom 2 (L31b), qui ne doit jamais déduire d'une absence qu'une racine n'est pas celle de la Salle OMO.
   */
  instance: SessionInstance | null;
}

/**
 * Consigne transmise à un sous-assistant, gardée localement par le cockpit (U2, D-3d-30) : GET /api/revoir/:rootId/consignes/
 * :callId. Texte déjà masqué (redactSecrets) puis borné ; `longueur` = points de code du texte d'origine.
 */
export interface RevoirConsigneResponse {
  rootId: string;
  callId: string;
  /** Session qui a reçu la consigne ; null si elle n'était pas connue à l'envoi. */
  enfant: string | null;
  texte: string;
  longueur: number;
  /** Texte coupé : mention visible avec le nombre de caractères affichés sur `longueur`. */
  tronque: boolean;
  at: number;
}

/**
 * GET /api/revoir/:rootId/consignes?enfant=<id> : consignes gardées dont la session destinataire est `enfant` (étapes d'équipe
 * comprises, D-3d-30), 20 au plus, par `at` croissant ; liste vide possible.
 */
export interface RevoirConsignesEnfantResponse {
  rootId: string;
  enfant: string;
  consignes: RevoirConsigneResponse[];
}

/** 404 de la route d'une consigne : aucune copie gardée pour ce `callId` dans cette conversation. */
export type ConsigneRefus = "consigne-absente";

// --- Territoires, zoom 1 (spéc. §5.8 l.993, D-3d-13, D-3d-14) -----------------------------------------------------------------

export interface ConversationTerritoire {
  rootId: string;
  /** Passé par redactSecrets côté serveur. */
  titre: string;
  instance: SessionInstance;
  /** Sessions de l'arbre qui travaillent ; null : état non vérifiable (jamais 0 par défaut). */
  travaillent: number | null;
  /** Demandes d'autorisation sans réponse dans l'arbre. */
  attendent: number;
  /** Coût de la demande en cours (USD), 0 sans demande en cours. */
  coutEnCours: number;
  demandeEnCours: boolean;
  derniereActivite: number;
  /** [Revoir cette demande] proposé (D-3d-09, D-3d-14). */
  revoir: boolean;
}

export interface TerritoireView {
  /** Chemin du projet relatif à /workspace. */
  projet: string;
  /** Dernier composant du chemin. */
  nom: string;
  conversations: ConversationTerritoire[];
  compteurs: { travaillent: number | null; attendent: number; cout: number };
}

/** GET /api/salle-controle/territoires. */
export interface TerritoiresResponse {
  genereLe: number;
  mode: NeonMode;
  projets: TerritoireView[];
  /** Enceinte de la Salle OMO ; null si aucune racine de la salle. */
  salle: { projets: TerritoireView[] } | null;
  /** false si au moins un statut n'a pas pu être lu (compteurs `travaillent` à null). */
  statutVerifie: boolean;
}

// --- Plan 3D (spéc. §5.8 l.990-996 ; D-3d-13, D-3d-16, D-3d-19) ---------------------------------------------------------------

export interface Point3 {
  x: number;
  y: number;
  z: number;
}

/** 1 : projets ; 2 : rôles d'une conversation ; 3 : un assistant. */
export type Plan3dZoom = 1 | 2 | 3;

/** Stations de la scène néon, plus « Cockpit – contrôle » (zoom 1). */
export type Plan3dStationId = NeonStationId | "controle";

/** Décor : sans faits. */
export interface Plan3dStation {
  id: Plan3dStationId;
  position: Point3;
}

/** Décor : sans faits. `enceinte` : territoire de la Salle OMO (bandeau permanent, JP-10). */
export interface Plan3dTerritoire {
  id: string;
  projet: string;
  centre: Point3;
  rayon: number;
  enceinte: boolean;
  compteurs: TerritoireView["compteurs"];
}

export interface Plan3dNode {
  id: string;
  parentId: string | null;
  role: "conversation" | "delegation";
  secteur: NeonSector | null;
  position: Point3;
  etat: NeonNodeState;
  /** « travaille » : halo pulsé (un cycle par 2 s) en 3D seulement, sous prefers-reduced-motion: no-preference. */
  halo: "aucun" | "statique" | "travaille";
  /** Nom d'assistant ; null si inconnu (jamais inventé, P12). */
  nom: string | null;
  faits: number[];
}

export interface Plan3dBeam {
  id: string;
  kind: NeonBeamKind;
  de: Point3;
  /** Point de contrôle de la courbe de Bézier. */
  controle: Point3;
  /** null : faisceau ouvert vers une cible encore inconnue. */
  vers: Point3 | null;
  forme: "fleche" | "chevrons" | "losanges" | "pointille";
  jeton: NeonToken;
  fige: boolean;
  ouvert: boolean;
  faits: number[];
}

export interface Plan3dMark {
  id: string;
  kind: "attente" | "auto" | "refus" | "origine" | "impulsion" | "arret";
  position: Point3;
  jeton: NeonToken;
  faits: number[];
}

/**
 * Tuiles de fichiers d'un dossier (InstancedMesh, zoom 3). Salle OMO (« 3s », L3s-a) : les tuiles de la station « Carnet partagé et
 * plan » (JP-6) sont des lots de même forme, au dossier `carnet` (jamais une clé de fichier, qui a 16 chiffres hexadécimaux).
 */
export interface Plan3dTileBatch {
  dossier: string;
  etat: "lu" | "modifie" | "refuse" | "en-cours";
  positions: Point3[];
  faits: number[];
}

/**
 * Lien de la station « Carnet partagé et plan » vers un assistant dessiné qui a lu ou modifié le carnet (JP-6 ; « 3s », L3s-a) :
 * trait fin, jamais un faisceau (aucune consigne ni aucun résultat n'y passe). Porte ses faits (P12).
 */
export interface Plan3dLienCarnet {
  /** Session de l'assistant relié. */
  id: string;
  de: Point3;
  vers: Point3;
  faits: number[];
}

/** Étiquette DOM superposée (60 au plus, D-3d-19) ; `cible` = identifiant de l'élément étiqueté. */
export interface Plan3dLabel {
  id: string;
  cible: string;
  position: Point3;
  nom: string | null;
  etat: NeonNodeState | null;
  /** Plus petit = plus prioritaire : conversation, puis « travaille », puis attente d'accord, puis les autres. */
  priorite: number;
}

/** Caméra perspective (35°, inclinée de 55° par défaut). */
export interface Plan3dCamera {
  cible: Point3;
  distance: number;
  inclinaisonDeg: number;
  fovDeg: number;
}

export interface Plan3d {
  zoom: Plan3dZoom;
  theme: NeonTheme;
  mode: NeonMode;
  /** Conversation montrée (zooms 2 et 3) ; null au zoom 1. */
  rootId: string | null;
  /** Session détaillée au zoom 3 ; null sinon. */
  focus: string | null;
  stations: Plan3dStation[];
  territoires: Plan3dTerritoire[];
  noeuds: Plan3dNode[];
  faisceaux: Plan3dBeam[];
  marques: Plan3dMark[];
  tuiles: Plan3dTileBatch[];
  etiquettes: Plan3dLabel[];
  camera: Plan3dCamera;
  /** Quelque chose s'anime (faisceau ouvert, halo « travaille ») : la boucle d'images ne tourne que dans ce cas (D-3d-17). */
  anime: boolean;
  /** Enceinte de la Salle OMO au zoom 1 : projets qu'elle contient ; null sans salle. */
  enceinte: { projets: string[] } | null;
  /** Station « Carnet partagé et plan » vide (salle). */
  carnetVide: boolean;
  /**
   * Salle OMO (« 3s », L3s-a ; ajout facultatif, changement de contrat annoncé) : liens de la station « Carnet partagé et plan » vers
   * les assistants dessinés qui l'ont touché. Absent ou vide : aucun lien (zoom 1, hors de la salle, carnet vide).
   */
  liensCarnet?: Plan3dLienCarnet[];
}
