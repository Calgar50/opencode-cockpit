// Déclarations de `supervisor-lib.mjs`, pour les tests du cockpit (plan §2.1 : un test qui importe un `.mjs` de `docker/` fournit
// son fichier de déclaration voisin, sinon TS7016 au typecheck). Le `.mjs` tourne dans l'image, sans TypeScript ni dépendance ; ces
// types ne servent qu'à la relecture et aux tests. Toute forme décrite ici est comparée à `omo-control-protocol.ts` au train de V0.

export declare const OMO_CONTROL_MAX_OCTETS: number;
export declare const OMO_LISTE_MAX: number;
export declare const OMO_MANIFESTE_MAX_OCTETS: number;
export declare const OMO_PROJETS_MAX_OCTETS: number;
export declare const OMO_AUTH_MAX_OCTETS: number;
export declare const OMO_CONFIG_MAX_OCTETS: number;

export interface OmoDelais {
  battementS: number;
  perimeS: number;
  verificationS: number;
  killApresS: number;
}

export declare const OMO_DELAIS: OmoDelais;
export declare const OMO_MARGE_HOMME_MORT_S: number;
export declare const OMO_BORNE_HOMME_MORT_MAX_S: number;
export declare function borneHommeMort(delais?: OmoDelais): number;

export declare const FICHIERS_CONTROLE: { battement: string; arret: string; precheck: string; garde: string };
export declare const FICHIER_ETAT: string;
export declare const FICHIER_PROJETS: string;

export declare const CHEMINS: {
  controle: string;
  etat: string;
  authSource: string;
  donnees: string;
  workspace: string;
  home: string;
  tmp: string;
  configHome: string;
  configurationOmo: string;
  superviseur: string;
  superviseurLib: string;
  valider: string;
  validerCoeur: string;
  enumerations: string;
  manifeste: string;
  referenceManifeste: string;
  garde: string;
  configuration: string;
  imageId: string;
  extension: string;
  licence: string;
};

export declare const DOSSIERS_CONFIG_HOME: string[];
export declare const CONFIG_HOME_FICHIERS: Readonly<{ omo: string; gitignore: string }>;
export declare const CONFIG_HOME_GITIGNORE: string;
export declare const UID_NODE: number;
export declare const VOLUMES_SALLE: { volume: string; chemin: string; uid: number }[];
export declare const VOLUMES_FERMES_A_NODE: string[];
export declare const PERIMETRE_MANIFESTE: string[];
export declare const PURGE_GARDES: RegExp[];
export declare const BALAYAGE_EXCLUS: string[];
export declare const BALAYAGE_PLAFOND: number;
export declare const BALAYAGE_PROFONDEUR_MAX: number;
export declare const PHASES: string[];
export declare const CODES: { ok: number; refus: number; pasPret: number; arret: number; perime: number; fini: number; montage: number };

export interface Battement {
  at: number;
}

export interface Arret {
  at: number;
  cause: string;
  /** Démarrage visé ; `null` : état inconnu du cockpit, l'arrêt est rattaché au démarrage par sa date. */
  startId: string | null;
}

export interface PrecheckOk {
  startId: string;
  at: number;
  projets: { chemin: string; sha256: string }[];
}

export interface ProjetsPrepares {
  version: 1;
  genereLe: string;
  projets: { chemin: string; git: "dossier" | "absent" }[];
  gitProteges: { chemin: string; forme: "dossier" | "fichier" }[];
}

export type GitForme = "dossier" | "fichier" | "lien" | "absent";

export interface WorkspaceGit {
  verifieLe: number;
  limiteAtteinte: boolean;
  nonProteges: string[];
}

export interface Balayage extends WorkspaceGit {
  gits: { chemin: string; forme: GitForme; inscriptible: boolean; montage: boolean }[];
  entrees: number;
  illisibles: number;
}

export interface BalayageOptions {
  plafond?: number;
  profondeurMax?: number;
  exclus?: string[];
  accesEcriture?: (chemin: string) => boolean;
  maintenant?: number;
  gitsMax?: number;
  /** Points de montage (chemins POSIX) ; par défaut, ceux de /proc/self/mountinfo. */
  montages?: string[];
  /** Lecture d'un dossier (tests : échec injecté) ; par défaut `readdirSync` avec les types, sans suivre les liens. */
  lireDossier?: (chemin: string) => import("node:fs").Dirent[];
}

export interface DossierConfigVerdict {
  chemin: string;
  ok: boolean;
  raison: string | null;
}

export interface RapportDossier {
  dossier: string;
  retires: number;
  /** 20 noms au plus ; `gardesTotal` dit combien il y en avait. */
  gardes: string[];
  gardesTotal: number;
  resistants: { nom: string; code: string }[];
  absent?: boolean;
}

export interface RapportPurge {
  tmp: RapportDossier;
  home: RapportDossier;
  donnees: RapportDossier;
}

export interface RapportAuth {
  etat: "posee" | "absente" | "trop-grosse";
  octets: number;
}

export interface EtatPublie {
  startId: string;
  phase: string;
  imageId: string;
  manifestSha256: string;
  manifesteReference: "ok" | "amorce" | "ecart";
  validation: "ok" | "echec";
  dossiersConfig: { chemin: string; ok: boolean }[];
  projets: { chemin: string; gitLectureSeule: boolean }[];
  workspaceGit: WorkspaceGit;
  startedAt: number;
}

/** Dossier de travail du superviseur : l'état en construction, plus ce qui n'est jamais publié. */
export interface Travail extends EtatPublie {
  /** Empreinte des points de montage figée avant le lancement d'opencode (MO-3) ; vide : rien n'est figé. */
  montagesSha256: string;
}

export interface DecisionBoucleEntree {
  battement: Battement | null;
  arret: Arret | null;
  maintenantMs: number;
  empreinte: string;
  empreinteAttendue: string;
  enfantVivant: boolean;
}

export interface ConstatConfigNode {
  etape: "config-node";
  ok: boolean;
  dossiers: DossierConfigVerdict[];
  volumes: DossierConfigVerdict[];
}

export declare function estStartId(valeur: unknown): valeur is string;
export declare function tailleOctets(texte: string): number;
export declare function analyserObjet(texte: string | null | undefined, maxOctets?: number): Record<string, unknown> | null;
export declare function analyserBattement(texte: string | null | undefined): Battement | null;
export declare function analyserArret(texte: string | null | undefined): Arret | null;
export declare function analyserPrecheckOk(texte: string | null | undefined): PrecheckOk | null;
export declare function analyserProjetsPrepares(texte: string | null | undefined): ProjetsPrepares | null;

export declare function battementFrais(battement: Battement | null, maintenantMs: number, delais?: OmoDelais): boolean;
export declare function precheckDuDemarrage(precheck: PrecheckOk | null, startId: string, maintenantMs: number, delais?: OmoDelais): boolean;
export declare function arretDuDemarrage(arret: Arret | null, startId: string, startedAt: number): boolean;
export declare function lireArretDuDemarrage(dossierControle: string, travail: { startId: string; startedAt: number }): Arret | null;
export declare function decisionPret(
  entree: {
    travail: { startId: string; startedAt: number; workspaceGit?: WorkspaceGit; projets?: { gitLectureSeule: boolean }[] };
    arret: Arret | null;
    battement: Battement | null;
    precheck: PrecheckOk | null;
    maintenantMs: number;
  },
  delais?: OmoDelais,
): number;
export declare function decisionSuperviseur(
  battement: Battement | null,
  arret: Arret | null,
  maintenantMs: number,
  delais?: OmoDelais,
): "continuer" | "arret-demande" | "battement-perime";

export declare function vivant(pid: number | string, racineProc?: string): boolean;
export declare function capacitesNulles(texteStatut: string | null | undefined): boolean;
export declare function decisionBoucle(entree: DecisionBoucleEntree, delais?: OmoDelais): number;
export declare function lireTexteBorne(chemin: string, maxOctets?: number, options?: { suivreLiens?: boolean }): string | null;
export declare function cheminTemporaire(chemin: string, marque: string): string;
export declare function ecrireAtomique(chemin: string, texte: string, mode?: number): void;
export declare function lireBattement(dossierControle?: string): Battement | null;
export declare function lireArret(dossierControle?: string): Arret | null;
export declare function lirePrecheckOk(dossierControle?: string): PrecheckOk | null;
export declare function lireProjetsPrepares(dossierControle?: string): ProjetsPrepares | null;
export declare function nouveauStartId(): string;
export declare function sha256(texte: string): string;

export declare function estAmorce(texte: string | null | undefined): boolean;
export declare function comparerManifeste(
  texteActuel: string | null | undefined,
  texteReference: string | null | undefined,
): { manifesteReference: "ok" | "amorce" | "ecart"; manifestSha256: string };

export declare function controlerDossierRoot(chemin: string, uid: number, montages: string[]): DossierConfigVerdict;
export declare function controlerDossierConfigRoot(chemin: string, montages?: string[]): DossierConfigVerdict;
export declare function controlerVolumesRoot(
  montages?: string[],
  volumes?: { volume: string; chemin: string; uid: number }[],
): (DossierConfigVerdict & { volume: string })[];
export declare function etapeConfigNode(acces?: (chemin: string) => boolean): ConstatConfigNode;
export declare function absorber(dossierEtat: string, fichier: string): { ok: boolean; raison: string; gitProtege?: boolean };
export declare function controlerDossierConfigNode(chemin: string, acces?: (chemin: string) => boolean): DossierConfigVerdict;
export declare function accesEcriture(chemin: string): boolean;
export declare function controlerContenuConfig(chemin: string, texteReference: string | null): DossierConfigVerdict;
export declare function controlerDossierConfigHome(chemin: string, texteReference: string | null, montages?: string[]): DossierConfigVerdict;
export interface ConstatConfigHome {
  etape: "config-home";
  ok: boolean;
  raison: string | null;
  octets?: number;
}
export declare function preparerConfigHome(options?: { dossier?: string; reference?: string; montages?: string[]; uid?: number }): ConstatConfigHome;

export declare function formeGit(chemin: string): GitForme;
export declare function lireGitdir(cheminGit: string): string | null;
export declare function cibleGitdirProtegee(cheminGit: string, racine: string, montages: string[], acces: (chemin: string) => boolean): boolean;
export declare function balayerGit(racine?: string, options?: BalayageOptions): Balayage;
export declare function resumeWorkspaceGit(balayage: Balayage): WorkspaceGit;
export declare function gitProtege(etat: { workspaceGit?: WorkspaceGit; projets?: { gitLectureSeule: boolean }[] } | null | undefined): boolean;
export interface ConstatGit {
  ok: boolean;
  projets: { chemin: string; gitLectureSeule: boolean }[];
  workspaceGit: WorkspaceGit;
  projetsPrepares: number | null;
  balayage: { entrees: number; illisibles: number; gits: number };
}
export declare function constatGit(
  prepares: ProjetsPrepares | null,
  options?: { racine?: string; montages?: string[]; acces?: (chemin: string) => boolean; maintenant?: number },
): ConstatGit;
export declare function controlerProjetsPrepares(
  prepares: ProjetsPrepares | null,
  racine?: string,
  acces?: (chemin: string) => boolean,
  montages?: string[],
): { chemin: string; gitLectureSeule: boolean }[];

export declare function pointsDeMontage(fichier?: string): string[];
export declare function porteUnMontage(chemin: string, montages: string[]): boolean;
export declare function estPointDeMontage(chemin: string, montages: string[]): boolean;
export declare function empreinteMontages(montages: string[] | null | undefined): string;
export declare function viderDossier(dossier: string, options?: { gardes?: RegExp[]; montages?: string[] }): RapportDossier;
export declare function purger(options?: { tmp?: string; home?: string; donnees?: string; montages?: string[] }): RapportPurge;
export declare function copierAuth(options?: { source?: string; donnees?: string }): RapportAuth;

export declare function cheminTravail(dossierEtat?: string): string;
export declare function initTravail(dossierEtat?: string, maintenant?: number): Travail;
export declare function lireTravail(dossierEtat?: string): Travail;
export declare function majTravail(dossierEtat: string, changements: Partial<Travail>): Travail;
export declare function lireImageId(chemin?: string): string;
export declare function publierEtat(dossierEtat: string, travail: EtatPublie, phase: string): EtatPublie;
export declare function delaisShell(delais?: OmoDelais): string;
/** `dossiers` : volume d'état et volume de contrôle ; ceux du contrat par défaut (tests seulement). */
export declare function executer(argv: string[], dossiers?: { etat: string; controle: string }): number;
