// Propriétaire : L18a.
// Exécution de l'instance de la Salle OMO (spécification §3.8 l.325, §3.9 l.331 ; plan 2 bis, fiche L18a) : second client
// opencode, second portillon (registre des réponses émises propre à la salle, base de la détection 1), second EventProcessor,
// et les dépendances d'instance (InstanceDeps) qu'ils forment.
// SQUELETTE posé par T3b (plan 2 bis §4.2) : AUCUN comportement, aucune construction. `creerInstanceOmo` reste à L18a, qui la
// branchera dans app-factory et main.ts au train de V3, derrière SALLE_OUVERTE. Tant que la salle est coupée, `instances.omo`
// vaut null : aucun client, aucun processeur, aucune inscription de la salle active.
import type { InstanceDeps } from "./omo-contracts.ts";

/** Instance de la salle, quand elle existe ; null tant que la salle est coupée (le dépôt). */
export type OmoInstance = InstanceDeps | null;

/** Squelette : la salle n'a pas d'exécution. L18a rendra ici l'InstanceDeps de la salle et sa fermeture. */
export const OMO_INSTANCE_ABSENTE: OmoInstance = null;
