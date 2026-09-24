// Contrat de la Salle OMO (itérations 2 bis et 2 ter) : TYPES UNIQUEMENT (aucun code exécuté), partagés par le serveur et
// l'interface. Spécification §3.9, §3.12.1, §3.15, §4.8.2, §4.14, §5.7.2, §6 ; plan d'exécution 2 bis-2 ter §4.1.1 (T3a),
// décisions D-2b-01 à D-2b-47. Les ports et les routes rendent des CODES ; les phrases sont dans omo-room-texts.ts, une par code.
// Listes des codes (tableaux) et ordre proposé des inscriptions : omo-contracts.ts (un fichier *-types.ts ne contient aucun code).
// Aucun changement de ce fichier hors d'un train : demande écrite à l'intégrateur, avec la liste des consommateurs prévenus.

// --- Ouverture d'une salle (§3.9 l.340, §4.14.1) -------------------------------------------------------------------------------

/** Corps de POST /api/omo/rooms : chemin du projet, relatif à /workspace, résolu par realpath côté serveur. */
export interface OmoRoomCreateBody {
  projet: string;
}

export interface OmoRoomCreateResponse {
  rootId: string;
  projet: string;
}

// --- Pré-contrôle (§3.15.2 l.523-530, D-2b-19, D-2b-34, D-2b-35) ---------------------------------------------------------------

/**
 * Raison d'un projet refusé au pré-contrôle, fermé en cas de doute (noms exacts : omo-precheck-rules.ts de L19a et
 * nomsPrecontrole du contrat ; la répartition entre les deux raisons de configuration est relue au train de V0) :
 * - config-extension : .omo/omo.json[c], oh-my-openagent.json[c], oh-my-opencode.json[c], .sisyphus/, .agents/ (projet ou parent) ;
 * - config-opencode : .opencode/, opencode.json[c], .claude/, .mcp.json (projet ou parent) ;
 * - fichier-cle : fichier de clés à la racine du projet ou dans un parent jusqu'à /workspace (D-2b-19) ;
 * - lien-symbolique, illisible, profondeur (au-delà de 256), hors-workspace : doute, refus ;
 * - non-prepare : projet absent de omo-projets.json (« relancez install.ps1 », §9.4 n° 2) ;
 * - empreinte-impossible : empreintes des fichiers d'IDE et de CI hors bornes (2 000 fichiers, 1 Mio par fichier).
 */
export type OmoPrecheckReason =
  | "config-extension"
  | "config-opencode"
  | "fichier-cle"
  | "lien-symbolique"
  | "illisible"
  | "profondeur"
  | "hors-workspace"
  | "non-prepare"
  | "empreinte-impossible";

export interface OmoPrecheckProjectResult {
  /** Chemin relatif à /workspace. */
  projet: string;
  verdict: "conforme" | "refuse";
  /** null si conforme. */
  raison: OmoPrecheckReason | null;
  /** Chemins trouvés : 20 au plus, relatifs au projet, masqués (jamais un contenu). */
  trouves: string[];
}

/** Empreinte d'un projet contrôlé, écrite dans precheck-ok (format de L17a). */
export interface OmoPrecheckOkProject {
  chemin: string;
  sha256: string;
}

// --- Protection git du dossier de travail (D-2b-28) ----------------------------------------------------------------------------

/** Forme d'un .git trouvé : dossier (protégé par un bind :ro), fichier gitdir: (bind de fichier), lien (refus), absent. */
export type OmoGitForm = "dossier" | "fichier" | "lien" | "absent";

/** Balayage de /workspace par le superviseur, en tant que node (sans suivre les liens, 200 000 entrées au plus). */
export interface OmoWorkspaceGit {
  /** Heure du balayage (ms depuis l'époque Unix). */
  verifieLe: number;
  /** Plafond d'entrées atteint : état « git non protégé », activation refusée. */
  limiteAtteinte: boolean;
  /** .git non protégés (lien, inscriptible par node, ou hors d'un point de montage, MO-3) : 20 chemins au plus, relatifs à /workspace. */
  nonProteges: string[];
}

/** État git d'un projet préparé, lu dans l'état publié par le superviseur. */
export type OmoProjectGitState = "lecture-seule" | "inscriptible" | "absent" | "inconnu";

// --- État de la salle et statut (§3.9 l.342, D-2b-26, D-2b-29) -----------------------------------------------------------------

/**
 * État de la salle vu par le cockpit : coupee (COCKPIT_OMO=off, COCKPIT_AUTONOMY=off ou SALLE_OUVERTE faux) ; arretee (aucun
 * opencode lancé) ; en-relance (relance à neuf en cours) ; prete ; demande-active ; suspendue (activité hors demande répétée).
 */
export type OmoEtatSalle = "coupee" | "arretee" | "en-relance" | "prete" | "demande-active" | "suspendue";

/** Réponse de GET /api/omo/status : sans secret ; l'authentification de la salle n'est décrite que par sa présence. */
export interface OmoStatusResponse {
  interrupteurs: { omo: boolean; autonomie: boolean; salleOuverte: boolean };
  image: { chargee: boolean; id: string | null; manifesteSha256: string | null; version: string | null; auditeLe: string | null };
  dernierDemarrage: { startId: string; at: number; precheck: OmoPrecheckProjectResult[] } | null;
  /** Hôtes autorisés par egress (l'API Copilot en vigueur, port 443). */
  listeBlanche: string[];
  /** Chemins relatifs à /workspace. */
  projetsPrepares: { chemin: string; git: OmoProjectGitState }[];
  /** null : balayage pas encore publié. */
  workspaceGit: OmoWorkspaceGit | null;
  etatSalle: OmoEtatSalle;
  /** Jamais le contenu d'auth.json. */
  authSalle: { presente: boolean };
  /** Refus d'egress des dernières 24 h, par hôte ; `dernier` en ms depuis l'époque Unix. */
  sortiesRefusees24h: { hote: string; nombre: number; dernier: number }[];
  /** ageMs : âge du dernier battement écrit, null si aucun. */
  battement: { actif: boolean; ageMs: number | null };
}

// --- Activation « Comme Oh My OpenAgent » (§4.14.2, §4.8.2, Q7, D-2b-07, D-2b-08) ----------------------------------------------

/** Corps de PUT /api/conversations/:rootId/autonomie pour la salle. Montant en CHAÎNE saisie, jamais un flottant JSON ; aucune valeur par défaut. */
export interface OmoActivationBody {
  choix: "omo";
  plafondUsd: string;
}

/**
 * Raison d'une activation refusée (409 et phrase, rien n'est envoyé), vérifiée à l'activation puis à l'envoi :
 * - salle-coupee : COCKPIT_OMO=off ou SALLE_OUVERTE faux ; autonomie-coupee : COCKPIT_AUTONOMY=off (§9.4 n° 3) ;
 * - mode-avance : salle réservée au mode Avancé ; racine-hors-salle : racine absente de omo_rooms ;
 * - confirmation-requise : x-cockpit-confirm: 1 absent (exigé à chaque demande) ;
 * - plafond-vide, plafond-invalide, plafond-hors-bornes, budget-mensuel : montant saisi (omo-cap.ts, L22a) ;
 * - precheck-refuse : pré-contrôle non conforme ; git-inscriptible : un .git de projet préparé inscriptible par node ;
 * - workspace-non-verifie : balayage de /workspace absent, plafond atteint ou .git non protégé (D-2b-28) ;
 * - manifeste : manifeste de l'image non vérifié (écart ou amorce) ; image-inattendue : identifiant d'image différent ;
 * - battement-absent : le cockpit n'écrit pas de battement frais ; demande-active : une demande tourne déjà (D-2b-08) ;
 * - adresse-copilot-changee : adresse Copilot différente de celle de la salle (§3.15.1 l.475) ;
 * - catalogue-absent : catalogue du compte indisponible (P1) ; jeton-consomme : activation déjà utilisée pour un envoi (D-2b-07) ;
 * - salle-suspendue, salle-en-relance : D-2b-29.
 */
export type OmoActivationRefusalCode =
  | "salle-coupee"
  | "autonomie-coupee"
  | "mode-avance"
  | "racine-hors-salle"
  | "confirmation-requise"
  | "plafond-vide"
  | "plafond-invalide"
  | "plafond-hors-bornes"
  | "budget-mensuel"
  | "precheck-refuse"
  | "git-inscriptible"
  | "manifeste"
  | "image-inattendue"
  | "battement-absent"
  | "demande-active"
  | "adresse-copilot-changee"
  | "catalogue-absent"
  | "jeton-consomme"
  | "salle-suspendue"
  | "salle-en-relance"
  | "workspace-non-verifie";

/** Vue de l'écran d'activation (§4.14.6) : champ vide la première fois, dernier montant proposé ensuite, jamais choisi par le cockpit. */
export interface OmoActivationView {
  rootId: string;
  projet: string;
  /** null : aucune activation confirmée (champ vide). */
  dernierPlafondUsd: string | null;
  /** budget.autonomie.plafondMaxUsd, borne vérifiée par le serveur. */
  plafondMaxUsd: number;
  /** Le dernier montant dépasse plafondMaxUsd : proposé tel quel, marqué hors bornes (§4.8.2 l.730). */
  horsBornes: boolean;
  demandeActive: boolean;
  conditions: { code: OmoActivationRefusalCode; ok: boolean }[];
}

// --- Arrêt, détections, interdits, sorties (§3.12.1, §4.14.3, §4.14.5, §3.15.2 l.518-522) --------------------------------------

/**
 * Cause d'un arrêt de la salle (stopTreeOmo), distincte de StopCause (D-2b-41) : vous, plafonds après coup (coût saisi, durée,
 * sessions, nouvelles tentatives 429), seuil-mensuel (80 ou 100 %), hors-controle (détection), homme-mort (battement perdu),
 * redemarrage-cockpit (salle trouvée lancée au démarrage du cockpit, D-2b-29).
 */
export type OmoStopCause =
  | "vous"
  | "plafond-cout"
  | "plafond-duree"
  | "plafond-sessions"
  | "plafond-tentatives"
  | "seuil-mensuel"
  | "hors-controle"
  | "homme-mort"
  | "redemarrage-cockpit";

/**
 * Détection après coup (§4.14.5), chacune suivie de stopTreeOmo : 1 reponse-non-emise ; 2 racine-etrangere ; 3 dispose-non-demande ;
 * 4 permission-modifiee ; 5 origine-inconnue (message de racine) ; 6 config-apparue ou git-cree ; 7 ide-ci-modifie ;
 * 8 tentatives-429 ; activite-hors-demande (activité de la salle sans demande active, D-2b-29).
 */
export type OmoDetectionCause =
  | "reponse-non-emise"
  | "racine-etrangere"
  | "dispose-non-demande"
  | "permission-modifiee"
  | "origine-inconnue"
  | "config-apparue"
  | "git-cree"
  | "ide-ci-modifie"
  | "tentatives-429"
  | "activite-hors-demande";

/**
 * Catégorie d'un interdit absolu (§4.14.3, D-2b-09) : fichier-cle ; env (.env* sauf .env.example) ; production ; reseau ;
 * git-envoi ; git-options-globales ; hors-projet (hors du projet ouvert, autre projet préparé compris) ; config-extension
 * (configuration de l'extension et d'opencode, liste du pré-contrôle, dont .agents/) ; ide-ci ; git-interne (.git/**) ; web.
 */
export type OmoForbiddenCategory =
  | "fichier-cle"
  | "env"
  | "production"
  | "reseau"
  | "git-envoi"
  | "git-options-globales"
  | "hors-projet"
  | "config-extension"
  | "ide-ci"
  | "git-interne"
  | "web";

/** Refus d'egress (journal sans chemin ni en-tête) : hôte non autorisé, port autre que 443, IP littérale, nom invalide, méthode autre que CONNECT. */
export type EgressRefusalReason = "hote" | "port" | "ip-litterale" | "invalide" | "methode";

/** Fichier signalé en fin de demande ou après une détection (D-2b-37) : fichier d'IDE ou de CI, programme à relire, .git mis de côté. */
export interface OmoSignale {
  /** Chemin relatif à /workspace. */
  chemin: string;
  genre: "ide-ci" | "programme" | "git-quarantaine";
}

// --- Événements SSE de la salle (§3.9 l.345, D-2b-02) ----------------------------------------------------------------------------

/** Étape d'une relance à neuf de la salle (stopTreeOmo, fin de demande). */
export type OmoRecreationEtat = "demandee" | "arret-confirme" | "arret-non-confirme" | "relancee";

/** Raison d'une relance à neuf : un arrêt, ou la fin d'une demande (D-2b-29). */
export type OmoRecreationRaison = OmoStopCause | "fin-de-demande";

export interface OmoEventMap {
  /** Flux d'événements de l'instance opencode-omo ; opencode.connection reste propre à l'instance principale. */
  "omo.connection": { connected: boolean; error?: string };
  /**
   * rootId null : activité sans racine attribuable (hors demande). `signales` et `signalesIncomplet` : fichiers signalés et mis
   * en quarantaine avant l'arrêt (D-2b-37 ; demandes de contrat de L26a et de L23c, reçues au train de V4) ; absents d'un émetteur
   * qui ne les relève pas, et lus avec prudence par la page (web/pages/omo/salle-journal.ts).
   */
  "omo.hors-controle": { rootId: string | null; cause: OmoDetectionCause; signales?: OmoSignale[]; signalesIncomplet?: boolean };
  "omo.recreation": { etat: OmoRecreationEtat; raison: OmoRecreationRaison };
  "omo.precheck": { projet: string; resultat: OmoPrecheckProjectResult };
  "omo.etat": { etatSalle: OmoEtatSalle };
  /**
   * Fin de demande : fichiers à relire (§4.14.5 l.850, L23c ; demande de contrat reçue au train de V4). `incomplet` : la descente
   * des fichiers signalés n'a pas tout vu, et la liste le DIT. Son affichage par la page de la salle reste à faire (L26c).
   */
  "omo.signales": { rootId: string | null; signales: OmoSignale[]; incomplet: boolean };
}

export type OmoEventType = keyof OmoEventMap;

/** Champ `omo` de /api/bootstrap : faux par défaut (salle livrée coupée). */
export interface BootstrapOmo {
  enabled: boolean;
  imageChargee: boolean;
  salleOuverte: boolean;
}

// --- Fichiers échangés avec install.ps1, le superviseur et le plugin de garde ----------------------------------------------------

/** omo-projets.json, généré par install.ps1 (D-2b-12, D-2b-28) : chemins relatifs à /workspace. */
export interface OmoPreparedProjects {
  version: 1;
  /** Date de génération, ISO 8601. */
  genereLe: string;
  projets: { chemin: string; git: "dossier" | "absent" }[];
  /** .git protégés en lecture seule par la surcharge générée (dossier, ou fichier gitdir: selon MO-3). */
  gitProteges: { chemin: string; forme: "dossier" | "fichier" }[];
}

/** Outil que le plugin de garde (filet, L24) refuse quand l'état le demande. */
export type OmoGuardTool = "task" | "call_omo_agent";

/** guard-state.json, écrit par le cockpit dans le dossier de contrôle, lu par le plugin de garde. */
export interface OmoGuardState {
  version: 1;
  /** ms depuis l'époque Unix. */
  at: number;
  bloquer: OmoGuardTool[];
}

/** Phase publiée par le superviseur dans state.json (format de L17a, comparé au train de V0). */
export type OmoSupervisorPhase = "verification" | "attente" | "opencode-lance" | "arret";

/** state.json publié par le superviseur (root) ; lu borné par le cockpit, un fichier invalide ou trop gros vaut « inconnu » (null). */
export interface OmoSupervisorState {
  startId: string;
  phase: OmoSupervisorPhase;
  imageId: string;
  manifestSha256: string;
  manifesteReference: "ok" | "amorce" | "ecart";
  validation: "ok" | "echec";
  dossiersConfig: { chemin: string; ok: boolean }[];
  projets: { chemin: string; gitLectureSeule: boolean }[];
  workspaceGit: OmoWorkspaceGit;
  /** ms depuis l'époque Unix. */
  startedAt: number;
}

// --- Contrat machine docker/opencode-omo/contrat-salle.json (D-2b-39) ------------------------------------------------------------

/** Rôle d'un service dans le contrat (clé de `services`). */
export type OmoSalleServiceRole = "salle" | "egress" | "cockpit" | "principale";

export interface OmoSalleMontage {
  service: Exclude<OmoSalleServiceRole, "principale">;
  /** Chemin absolu dans le conteneur. */
  cible: string;
  mode: "rw" | "ro";
}

export interface OmoSalleVolume {
  nom: string;
  /** Propriétaire attendu du volume. */
  proprietaire: "root" | "node";
  /** Seul service qui écrit (un seul montage en écriture) ; null : personne. */
  ecrivain: Exclude<OmoSalleServiceRole, "principale"> | null;
  montages: OmoSalleMontage[];
}

/** Type de contrat-salle.json, lu par les tests TS, supervisor-lib.mjs et les tests PowerShell. Chemins absolus, sans doublon. */
export interface OmoSalleContract {
  version: 1;
  description: string;
  services: { salle: "opencode-omo"; egress: "egress"; cockpit: "cockpit"; principale: "opencode" };
  profil: "omo";
  reseau: "omo-internal";
  volumes: OmoSalleVolume[];
  /** Chemins de l'image opencode-omo, par rôle. */
  cheminsImage: {
    superviseur: string;
    superviseurLib: string;
    valider: string;
    validerCoeur: string;
    enumerations: string;
    manifeste: string;
    referenceManifeste: string;
    garde: string;
    configuration: string;
    /** Identifiant de l'image, écrit à la construction (L15a), lu par le superviseur pour state.json. */
    imageId: string;
    extension: string;
    licence: string;
  };
  /** Racines hachées par le manifeste (D-2b-32) ; la référence du manifeste est hors périmètre. */
  perimetreManifeste: string[];
  /**
   * Dossiers de configuration du HOME, montés en lecture seule depuis le volume `omo-config` appartenant à root (D-2b-33, révisée au
   * train de V1) : le superviseur (root) le remplit sur son montage en écriture, hors du HOME, avec le seul `omo.jsonc` de référence
   * de l'image et un `.gitignore`, avant toute bascule vers node.
   */
  dossiersConfigHome: string[];
  /** Noms refusés au pré-contrôle, relatifs à un dossier (projet, parent ; racine / de l'image pour validate.mjs). */
  nomsPrecontrole: { fichiers: string[]; dossiers: string[] };
  /**
   * Noms des fichiers du dossier de contrôle, écrits par le cockpit seul ; `projets` (omo-projets.json, généré par install.ps1) y est
   * déposé par le cockpit : c'est la seule liste des projets préparés que la salle croit (/control en lecture seule).
   */
  fichiersControle: { battement: "heartbeat"; arret: "stop-request"; precheck: "precheck-ok"; garde: "guard-state.json"; projets: "omo-projets.json" };
  /** Nom du fichier d'état publié par le superviseur. */
  etat: "state.json";
  egress: { port: 3128 };
  /** Variables d'environnement : du cockpit pour la salle, et liste blanche fermée de la salle. */
  variables: { cockpit: string[]; salle: string[] };
  /** Options de sécurité du service de la salle, clés au format de compose. */
  securite: {
    cap_drop: ["ALL"];
    cap_add: ("SETUID" | "SETGID")[];
    security_opt: string[];
    read_only: true;
    tmpfs: string[];
  };
}
