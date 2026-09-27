// Déclarations de `sources-supprimees.mjs`, pour `app/server/omo-banc.test.ts` (plan §2.1 : un test du cockpit qui importe un
// `.mjs` du banc fournit son fichier de déclaration voisin). Le scénario, lui, tourne sans TypeScript et sans dépendance (P8).
import type { ResultatDeBanc } from "./git-protection.mjs";

/** Ce que la porte « sup » emploie du contexte du banc : de quoi la jouer sur un double, sans Docker. */
export interface ContexteSources {
  projet: string;
  chemins?: { ws: string } | undefined;
  surcharge?: () => string;
  docker: (args: string[], options?: { silencieux?: boolean }) => Promise<{ code: number; sortie: string; erreur?: string }>;
  compose: (args: string[], options?: { delaiMs?: number; silencieux?: boolean }) => Promise<{ code: number; sortie: string; erreur?: string }>;
  jusqua: (condition: () => Promise<boolean>, options?: { delaiMs?: number; pasMs?: number }) => Promise<boolean>;
  attendre: (ms: number) => Promise<void>;
  ecrireSortie: (nom: string, texte: string) => void;
}

declare const porte: {
  id: string;
  titre: string;
  executer(ctx: ContexteSources): Promise<ResultatDeBanc>;
};

export default porte;
