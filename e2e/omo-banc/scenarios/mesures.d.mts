// Déclarations de `mesures.mjs`, pour `app/server/omo-banc.test.ts` (plan §2.1 : un test du cockpit qui importe un `.mjs` du
// banc fournit son fichier de déclaration voisin). Le scénario, lui, tourne sans TypeScript et sans dépendance (P8).

/** Type d'un événement du flux d'opencode, quelle que soit son enveloppe ; `null` quand il n'y en a pas. */
export declare function typeDEvenement(evt: unknown): string | null;

/**
 * Où va une capture réduite du scénario `mes`. Par défaut la sortie du banc, hors du dépôt ; les fixtures commitées ne sont
 * remplacées que si le contexte porte `ecrireFixtures: true` (option `--ecrire-fixtures` de `run-banc.mjs`).
 */
export declare function cheminDeFixture(
  ctx: { racine: string; chemins: { sortie: string }; ecrireFixtures?: boolean },
  nom: string,
): { chemin: string; dansLeDepot: boolean };

declare const porte: {
  id: string;
  titre: string;
  executer(ctx: unknown): Promise<{ points?: { nom: string; ok: boolean; detail?: string }[]; mesures?: Record<string, unknown> }>;
};

export default porte;
