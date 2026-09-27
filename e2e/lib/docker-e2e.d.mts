// Déclaration locale et minimale de `docker-e2e.mjs` (banc e2e, L7a) pour les tests de croisement de `app/server`, qui appliquent
// la VRAIE règle de filtrage du banc (`--scenarios`) au lieu de la recopier (relecture 3-vague-4, itération 3). Le banc reste hors
// de `app/` et de son `tsconfig.json` (D-06) : seuls les deux symboles consommés sont déclarés, sans `any`, et chaque signature
// est celle de la fonction exportée à côté. Importer le module est sans effet de bord : son bloc principal n'exécute rien tant que
// Node ne lance pas `docker-e2e.mjs` lui-même.

/** Motif de `--scenarios` : sous-chaîne du nom du fichier, ou glob simple (« it1-* », « *api* »). */
export function correspond(nom: string, motif: string): boolean;

/** Les scénarios d'un dossier (tous les `.mjs`, triés), filtrés par `motif` s'il est donné ; `[]` si le dossier n'existe pas. */
export function listerScenarios(motif?: string | null, dossier?: string): { nom: string; chemin: string }[];
