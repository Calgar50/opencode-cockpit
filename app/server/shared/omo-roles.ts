// Rôles des agents d'Oh My OpenAgent 4.19.4 dans la Salle OMO (spécification §3.7 l.308, §5.7.3 l.970 ; JP-7 ; plan d'exécution,
// fiche L20). La carte des agents range chaque acteur dans un secteur : Planifier, Chercher, Conseiller, Exécuter, Vérifier, Autres.
//
// Règle d'honnêteté : le rôle est lu sur la CLÉ DE CONFIGURATION de l'agent (`agents.<clé>` de la 4.19.4), jamais sur son
// `displayName`, que l'extension et l'utilisateur peuvent réécrire. Une clé inconnue (agent maison, version plus récente) tombe
// dans « autres » : on n'invente jamais un rôle.
//
// Source unique : paquet npm 4.19.4, `dist/config/schema/oh-my-opencode-config.d.ts` (clés de `agents`) et
// `dist/config/schema/agent-names.d.ts` (`OverridableAgentNameSchema`). Module pur (server/shared).

export const OMO_ROLES = ["planifier", "chercher", "conseiller", "executer", "verifier", "autres"] as const;
export type OmoRole = (typeof OMO_ROLES)[number];

/**
 * Rôle par clé de configuration, pour les 14 clés nommées de `agents` en 4.19.4. `OpenCode-Builder` garde sa casse : la clé est
 * comparée telle quelle, puis en minuscules (l'extension compare les noms d'agents sans tenir compte de la casse).
 */
export const ROLE_PAR_CLE: Readonly<Record<string, OmoRole>> = {
  atlas: "planifier",
  build: "executer",
  explore: "chercher",
  hephaestus: "executer",
  librarian: "chercher",
  metis: "conseiller",
  momus: "verifier",
  "multimodal-looker": "chercher",
  "OpenCode-Builder": "executer",
  oracle: "conseiller",
  plan: "planifier",
  prometheus: "planifier",
  sisyphus: "planifier",
  "sisyphus-junior": "executer",
};

/** Clés connues, dans l'ordre du fichier de schéma. */
export const CLES_AGENTS: readonly string[] = [
  "build",
  "plan",
  "sisyphus",
  "hephaestus",
  "sisyphus-junior",
  "OpenCode-Builder",
  "prometheus",
  "metis",
  "momus",
  "oracle",
  "librarian",
  "explore",
  "multimodal-looker",
  "atlas",
];

/**
 * Rôle d'un agent d'après sa clé de configuration ; inconnu, vide ou non nommé → « autres ». Clés PROPRES de la table seulement
 * (train de V4, constat de L25b) : une clé venue de la salle comme `constructor` ou `toString` rendait sinon ce qu'Object hérite.
 */
export function roleDeAgent(cle: string | null | undefined): OmoRole {
  if (typeof cle !== "string") return "autres";
  const exact = Object.hasOwn(ROLE_PAR_CLE, cle) ? ROLE_PAR_CLE[cle] : undefined;
  if (exact !== undefined) return exact;
  const bas = cle.toLowerCase();
  for (const [connue, role] of Object.entries(ROLE_PAR_CLE)) {
    if (connue.toLowerCase() === bas) return role;
  }
  return "autres";
}
