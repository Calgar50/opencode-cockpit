// Déclarations de `git-protection.mjs`, pour `app/server/omo-banc.test.ts` (plan §2.1 : un test du cockpit qui importe un
// `.mjs` du banc fournit son fichier de déclaration voisin). Le scénario, lui, tourne sans TypeScript et sans dépendance (P8).

/** Un constat de la porte : un nom, un verdict, un détail lisible. */
export interface PointDeBanc {
  nom: string;
  ok: boolean;
  detail?: string;
}

/** Ce qu'une porte rend : des constats, ou bien « sans objet » quand la configuration du banc ne permet rien d'observer. */
export interface ResultatDeBanc {
  points?: PointDeBanc[];
  mesures?: Record<string, unknown>;
  ok?: boolean;
  sansObjet?: string;
}

/** Le peu du contexte du banc dont cette porte se sert : de quoi la jouer sur un double, sans Docker. */
export interface ContexteDePorte {
  exec: (service: string, argv: string[], options?: { root?: boolean; delaiMs?: number }) => Promise<{ code: number; sortie: string; erreur?: string }>;
  etat: () => Promise<Record<string, unknown> | null>;
  sortie: (nom: string) => string | null;
  ecrireSortie: (nom: string, texte: string) => void;
  /** Dossiers du banc sur le poste : `ws` est le dossier de travail jetable monté sur `/workspace` (vérifications côté poste). */
  chemins?: { ws: string } | undefined;
}

/** Projet ouvert par le banc, seul à recevoir les écritures légitimes de la sonde. */
export declare const PROJET_ECRIT: string;
/** Noms de `.git` sondés : casses et noms courts 8.3. */
export declare const FEUILLES: string[];
/** Préfixe de tout ce que la sonde écrit. */
export declare const TEMOIN: string;
/** Sonde jouée en tant que `node` dans la salle (`node -e`), jeton de la passe en premier argument. */
export declare const SONDE_E1: string;
/** Nettoyage joué en tant que `node` dans la salle, contenu d'origine du fichier écrit en place (base64) en premier argument. */
export declare const NETTOYAGE_E1: string;

declare const porte: {
  id: string;
  titre: string;
  executer(ctx: ContexteDePorte): Promise<ResultatDeBanc>;
};

export default porte;
