// Déclarations de `cockpit-guard.js` (plugin de garde de la salle, L24), pour les tests du cockpit (plan §2.1 : un test qui importe
// un module de `docker/` fournit son fichier de déclaration voisin, sinon TS7016 au typecheck). Le `.js` tourne dans l'image, chargé
// par opencode, sans TypeScript ni dépendance : ces types ne servent qu'à la relecture et aux tests. Aucun type de
// `@opencode-ai/plugin` n'est importé : les formes du crochet sont recopiées d'opencode 1.18.30 (packages/plugin/src/index.ts).

export type OutilDelegation = "task" | "call_omo_agent";

/** `guard-state.json`, même forme que `OmoGuardState` (app/server/shared/omo-control-protocol.ts). */
export interface EtatGarde {
  version: 1;
  at: number;
  bloquer: OutilDelegation[];
}

export type LectureEtatGarde = { etat: "absent" } | { etat: "valide"; garde: EtatGarde } | { etat: "invalide"; raison: string };

export type CategorieRefus = "cle" | "hors-projet" | "reseau" | "delegation" | "etat-illisible" | "doute";

export interface Refus {
  categorie: CategorieRefus;
  message: string;
}

export interface ContexteGarde {
  /** Projet ouvert (`input.directory` d'opencode), chemin absolu ; toute autre valeur rend chaque chemin douteux. */
  dossier: unknown;
  /** Dossier `tool-output` d'opencode, lisible hors du projet ; `null` si inconnu. */
  sortiesOutils: string | null;
  /** Chemin réel (liens résolus), `null` si impossible à résoudre. */
  reel: (chemin: string) => string | null;
  lireEtat: () => LectureEtatGarde;
}

export interface OptionsGarde {
  dossier?: unknown;
  sortiesOutils?: string | null;
  cheminEtat?: string;
  lireEtat?: () => LectureEtatGarde;
  reel?: (chemin: string) => string | null;
}

export interface Garde {
  decider(outil: string, args: unknown): Refus | null;
  /** Crochet `tool.execute.before` : lève une erreur pour un refus, ne modifie jamais les arguments. */
  avant(input: unknown, output: unknown): void;
}

/** Entrée et sortie du crochet `tool.execute.before` d'opencode 1.18.30. */
export interface EntreeOutil {
  tool: string;
  sessionID: string;
  callID: string;
}

export interface SortieOutil {
  args: unknown;
}

export interface CrochetsGarde {
  "tool.execute.before": (input: EntreeOutil, output: SortieOutil) => Promise<void>;
}

/** Plugin « v1 » d'opencode : `{ id, server }`. */
export interface PluginGarde {
  readonly id: string;
  readonly server: (input: { directory?: unknown }, options?: unknown) => Promise<CrochetsGarde>;
}

export declare const ID_PLUGIN: string;
export declare const CHEMIN_ETAT_GARDE: string;
export declare const ETAT_GARDE_MAX_OCTETS: number;

export declare const OUTILS_DELEGATION: readonly OutilDelegation[];
export declare const OUTILS_RESEAU: readonly string[];
export declare const PREFIXES_RESEAU: readonly string[];
export declare const OUTILS_ECRITURE: readonly string[];
export declare const CLES_CHEMIN: readonly string[];
export declare const CLES_MOTIF: readonly string[];
export declare const CLES_CORRECTIF: readonly string[];

export declare const MOTIFS_CLE_REGLES: readonly string[];
export declare const MOTIFS_CLE_PERMIS: readonly string[];
export declare const MOTIFS_CLE_CHEMIN: readonly string[];
export declare const EXTENSIONS_CLE_P03: readonly string[];
export declare const MOTIFS_ENV: readonly string[];
export declare const TEMOINS_CLE: readonly string[];
export declare const TEMOINS_ORDINAIRES: readonly string[];

export declare const MESSAGES_FILET: Readonly<Record<CategorieRefus, string>>;

export declare function estNomCle(nom: unknown): boolean;
export declare function estCheminCle(chemin: unknown): boolean;
export declare function motifViseDesCles(motif: unknown): boolean;
export declare function cheminsDuCorrectif(texte: unknown): string[];

export declare function analyserEtatGarde(texte: string | null | undefined): EtatGarde | null;
export declare function lireEtatGarde(chemin?: string): LectureEtatGarde;

export declare function cheminReel(chemin: string): string | null;
export declare function dossierSortiesOutils(): string | null;

export declare function decider(outil: unknown, args: unknown, contexte: ContexteGarde): Refus | null;
export declare function creerGarde(options?: OptionsGarde): Garde;

export declare const plugin: PluginGarde;
declare const pluginParDefaut: PluginGarde;
export default pluginParDefaut;
