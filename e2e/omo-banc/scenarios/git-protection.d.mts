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
}

declare const porte: {
  id: string;
  titre: string;
  executer(ctx: ContexteDePorte): Promise<ResultatDeBanc>;
};

export default porte;
