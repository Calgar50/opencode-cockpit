// Déclarations de `validate-core.mjs`, pour les tests du cockpit (plan §2.1 : un test qui importe un `.mjs` de `docker/` fournit
// son fichier de déclaration voisin, sinon TS7016 au typecheck). Le `.mjs` tourne dans l'image, sans TypeScript ni dépendance.

export declare const VERSION_EXTENSION: string;
export declare const NOM_PAQUET: string;
export declare const PREFIXE_COPILOT: string;
export declare const CATEGORIES_4_19_4: readonly string[];
export declare const LISTES_COUPEES: Readonly<Record<string, string>>;
export declare const FAMILLES_NOMMEES: readonly string[];
export declare const NOMS_PRECONTROLE_RACINE: { readonly fichiers: readonly string[]; readonly dossiers: readonly string[] };

export declare class ErreurJsonc extends Error {
  position: number;
  constructor(message: string, position: number);
}
export declare function lireJsonc(texte: string): unknown;
export declare function egalJson(a: unknown, b: unknown): boolean;
export declare function estModeleCopilot(valeur: unknown): boolean;

/** Forme de `enums-4.19.4.json` (L20) telle que le validateur la lit. */
export interface OmoEnumerationsLues {
  version: string;
  hooks: string[];
  hooksCoupes: string[];
  outils: string[];
  outilsCoupes: string[];
  mcps: string[];
  mcpsCoupes: string[];
  competences: string[];
  competencesCoupees: string[];
  commandes: string[];
  commandesCoupees: string[];
  agents: string[];
  agentsCoupes: string[];
  cles: string[];
  fournisseursCoupes: string[];
  valeurs: Record<string, unknown>;
}

export declare function verifierEnumerations(enums: unknown): string[];
export declare function nomsEnumeres(enums: unknown): { famille: string; nom: string }[];
export declare function nomPresentDans(texte: string, nom: string): boolean;
export declare function verifierOmo(config: unknown, enums: unknown): string[];

export declare const GREFFONS: readonly string[];
export declare const ADRESSE_COPILOT_CONFIG: string;
export declare const COPILOT_HOTES: readonly string[];
export declare const PERMISSIONS_FICHIERS: Readonly<Record<string, "allow" | "ask">>;
export declare const MOTIFS_REFUSES_EXIGES: readonly string[];
export declare const MOTIF_EXEMPLE: string;
export declare const SONDES_REFUSEES: readonly string[];
export declare const SONDES_PERMISES: readonly string[];
export declare function motifCorrespond(entree: string, motif: string): boolean;
export declare function actionPour(regles: Record<string, string>, entree: string): string;
export declare function verifierTexteOpencode(texte: unknown): string[];
export declare function verifierOpencode(config: unknown): string[];
export declare function verifierAdresseCopilot(valeur: unknown): string[];
