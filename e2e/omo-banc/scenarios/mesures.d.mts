// Déclarations de `mesures.mjs`, pour `app/server/omo-banc.test.ts` (plan §2.1 : un test du cockpit qui importe un `.mjs` du
// banc fournit son fichier de déclaration voisin). Le scénario, lui, tourne sans TypeScript et sans dépendance (P8).

/** Type d'un événement du flux d'opencode, quelle que soit son enveloppe ; `null` quand il n'y en a pas. */
export declare function typeDEvenement(evt: unknown): string | null;

declare const porte: {
  id: string;
  titre: string;
  executer(ctx: unknown): Promise<{ points?: { nom: string; ok: boolean; detail?: string }[]; mesures?: Record<string, unknown> }>;
};

export default porte;
