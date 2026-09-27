// Propriétaire : L39o.
// Onglet « Salle OMO » de la carte des assistants (1.1, grande fusion F2 · V2 ; spécification §5.2 l.892, §7.8 l.1185, P11 l.46 ;
// plan d'exécution it4, fiche L39o ; fiche-fusion-v106 §7) : module PUR (ni « node: » ni process), calculé côté serveur par
// GET /api/agent-map?instance=omo (agent-map-service.ts) et relu tel quel par l'interface (CarteSalleOmo.tsx).
// - Agents de l'instance de la SALLE, lus par sa recherche d'agents (GET /agent de la salle) : la vue ne montre que des noms et
//   des rôles, en lecture seule ; ni droits, ni IA, ni lien (la carte de l'instance principale reste celle de L39b).
// - Rôle lu PAR CLÉ de configuration (roleDeAgent d'omo-roles.ts, JP-7), jamais sur un nom affiché ; clé inconnue → « autres ».
// - Libellé = nom français du rôle, pris dans les textes de la salle (secteurs de neon-texts.ts, par libelleSecteur), suivi de la
//   clé entre parenthèses : « Planifier (sisyphus) », « Autres (athena) ». Aucune table de libellés propre à la carte, aucun rôle
//   « orchestrateur » (roleDeAgent("sisyphus") = planifier).
// - Agents internes exclus, comme partout sur la carte : ceux d'opencode (compaction, title, summary), le préfixe cockpit-
//   (isInternalAgentName) et la liste du Studio, passée en entrée (studio.ts n'est pas importé ici).
import { isInternalAgentName } from "./agent-choice.ts";
import { libelleSecteur } from "./neon-texts.ts";
import { OMO_ROLES, type OmoRole, roleDeAgent } from "./omo-roles.ts";

/** Agents gardés au plus : au-delà, la vue serait illisible (même borne que la carte de l'instance principale). */
export const SALLE_AGENTS_MAX = 300;

/** Un agent de la salle, tel que la vue l'affiche. */
export interface AgentDeLaSalle {
  /** Clé de configuration : le nom rendu par GET /agent de la salle. */
  cle: string;
  /** Rôle lu par la clé (roleDeAgent) ; « autres » pour une clé inconnue. */
  role: OmoRole;
  /** Nom français du rôle (textes de la salle) suivi de la clé entre parenthèses. */
  libelle: string;
}

/** Réponse de GET /api/agent-map?instance=omo : agents rangés dans l'ordre des rôles (OMO_ROLES), puis par clé. */
export interface AgentMapSalleResult {
  agents: AgentDeLaSalle[];
}

/** Libellé d'un agent de la salle : nom du rôle lu par sa clé, puis la clé entre parenthèses. */
export function libelleAgentDeLaSalle(cle: string): string {
  return `${libelleSecteur(roleDeAgent(cle))} (${cle})`;
}

/** Ordre stable des clés, sans dépendre de la langue du poste. */
const parCle = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/**
 * Vue de la salle à partir des noms d'agents de GET /agent (entrée externe, déjà vérifiée par OcLookup) : internes retirés,
 * doublons retirés, au plus SALLE_AGENTS_MAX agents, rôle lu par clé, ordre des rôles puis des clés.
 */
export function vueDeLaSalle(noms: readonly string[], internes: readonly string[]): AgentMapSalleResult {
  const exclus = new Set(internes);
  const vus = new Set<string>();
  const agents: AgentDeLaSalle[] = [];
  for (const cle of noms) {
    if (agents.length >= SALLE_AGENTS_MAX) break;
    if (cle.length === 0 || vus.has(cle) || exclus.has(cle) || isInternalAgentName(cle)) continue;
    vus.add(cle);
    agents.push({ cle, role: roleDeAgent(cle), libelle: libelleAgentDeLaSalle(cle) });
  }
  agents.sort((a, b) => OMO_ROLES.indexOf(a.role) - OMO_ROLES.indexOf(b.role) || parCle(a.cle, b.cle));
  return { agents };
}
