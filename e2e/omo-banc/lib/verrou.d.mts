// Déclarations de `verrou.mjs`, pour `app/server/omo-banc.test.ts` (plan §2.1 : un test du cockpit qui importe un `.mjs` du
// banc fournit son fichier de déclaration voisin, sinon TS7016 au typecheck). Le `.mjs`, lui, tourne sans TypeScript et sans
// la moindre dépendance (P8).

export declare const PREFIXE_PROJET: string;
export declare const ETIQUETTE_BANC: string;
export declare const PROJETS_INTERDITS: readonly string[];
export declare const PREFIXES_INTERDITS: readonly string[];
export declare const ID_BANC: RegExp;

export declare class BancRefus extends Error {
  constructor(message: string);
}

export declare function nomDeProjet(id: unknown): string;
export declare function verifierProjet(nom: string): string;

export declare function cheminVerrou(): string;
export declare function prendreVerrou(projet: string, options?: { maintenant?: () => number }): () => void;

export interface ResultatCommande {
  code: number;
  sortie: string;
  erreur: string;
}

export interface OptionsCommande {
  cwd?: string;
  entree?: string;
  delaiMs?: number;
  env?: Record<string, string>;
  silencieux?: boolean;
}

export declare function lancer(programme: string, args: readonly string[], options?: OptionsCommande): Promise<ResultatCommande>;
export declare function docker(args: readonly string[], options?: OptionsCommande): Promise<ResultatCommande>;
export declare function dockerOuEchec(args: readonly string[], options?: OptionsCommande): Promise<ResultatCommande>;

export declare function attendre(ms: number): Promise<void>;
export declare function jusqua(condition: () => boolean | Promise<boolean>, options?: { delaiMs?: number; pasMs?: number }): Promise<boolean>;

export declare function pileUtilisateur(): Promise<string[]>;
export declare function nettoyerProjet(projet: string, fichiersCompose: readonly string[], fichierEnv?: string): Promise<ResultatCommande>;
export declare function restes(projet: string): Promise<{ conteneurs: string[]; volumes: string[]; reseaux: string[] }>;
