// Vue d'ensemble de la carte des assistants (1.1, itération 5b, L48 ; spécification §5.2 l.890, §5.5, §5.6 ; conception C §7.4
// (« Vue d'ensemble »), §9.9 ; plan d'exécution it5, fiche L48) : module PUR (ni « node: », ni process, ni horloge, ni aléa) qui
// range la carte de l'itération 4 (deriveAgentMap, L39a) en CINQ COLONNES, applique les puces de filtre et calcule l'estompage
// autour d'un élément. Rien n'est recalculé de la carte : les nœuds et les arêtes sont ceux de L39a, dans leur ordre.
// - AUCUN texte écrit ici : les phrases sont dans shared/construction-texts.ts (« Vue d'ensemble », les huit puces,
//   « (hors sujet) ») et dans shared/agent-map-texts.ts (phrase de chaque arête, it4). Ce module rend des GENRES et des CODES.
// - La vue d'ensemble est réservée au mode AVANCÉ (§5.2 l.890). Le mode n'est pas lu ici : c'est l'interface qui ne la propose
//   jamais en mode Simple (CarteTab.tsx, section c5:vue-ensemble).
// - Un GROUPE par genre de nœud, une PUCE de filtre par groupe : les colonnes ne sont qu'un rangement et n'inventent aucun
//   libellé composé. Les genres viennent de MAP_NODE_KINDS (L39a), liste fermée dont les cinq colonnes couvrent TOUTES les
//   valeurs, chacune une seule fois. Les agents du Studio `primary` tombent dans la colonne des assistants (genre
//   « agent-studio »), les agents du Studio `subagent` dans celle des sous-agents (genre « sous-agent », donné par kindOf).
// - Estompage (§5.5) : est estompé tout ce qui est HORS DE L'ENSEMBLE du focus, c'est-à-dire hors du focus, de ses voisins
//   ENTRANTS et de ses voisins SORTANTS. L'interface le rend par une opacité et par « (hors sujet) » pour le lecteur d'écran ;
//   rien n'est retiré de l'arbre d'accessibilité. Sans focus (absent, inconnu ou masqué par une puce), rien n'est estompé.
import type { AgentMapResult, MapEdge, MapNode, MapNodeKind } from "./agent-map.ts";

// --- Colonnes et puces -----------------------------------------------------------------------------------------------------

/** Les cinq colonnes, de gauche à droite (§5.2 l.890, C §7.4). */
export const OVERVIEW_COLUMNS = ["vous", "raccourcis", "assistants", "sous-agents", "fiches"] as const;
export type OverviewColumnId = (typeof OVERVIEW_COLUMNS)[number];

/**
 * Genres rangés dans chaque colonne, dans l'ordre d'affichage des groupes. Chaque genre n'appartient qu'à une colonne et tous
 * les genres de MAP_NODE_KINDS sont rangés : le test de ce module le vérifie sur la liste fermée de L39a.
 */
export const OVERVIEW_COLUMN_GROUPS: Readonly<Record<OverviewColumnId, readonly MapNodeKind[]>> = {
  vous: ["vous"],
  raccourcis: ["raccourci", "equipe"],
  assistants: ["assistant", "integre", "agent-studio"],
  "sous-agents": ["sous-agent"],
  fiches: ["fiche"],
};

/**
 * Puces de filtre, dans l'ordre du §4.3 du plan (« Vous » · « Raccourcis » · « Équipes » · « Assistants » · « Intégrés » ·
 * « Agents du Studio » · « Sous-agents » · « Fiches ») : une puce par genre, donc par groupe.
 */
export const OVERVIEW_FILTERS: readonly MapNodeKind[] = OVERVIEW_COLUMNS.flatMap((id) => OVERVIEW_COLUMN_GROUPS[id]);

const COLUMN_OF: ReadonlyMap<MapNodeKind, OverviewColumnId> = new Map(
  OVERVIEW_COLUMNS.flatMap((id) => OVERVIEW_COLUMN_GROUPS[id].map((kind) => [kind, id] as const)),
);

/** Colonne d'un genre de nœud ; null pour un genre hors des listes ci-dessus (le nœud est alors laissé de côté). */
export function overviewColumnOf(kind: MapNodeKind): OverviewColumnId | null {
  return COLUMN_OF.get(kind) ?? null;
}

// --- Entrée et résultat ----------------------------------------------------------------------------------------------------

/** La carte telle que L39a la rend ; les notes ne servent pas à la vue d'ensemble. */
export type OverviewInput = Pick<AgentMapResult, "nodes" | "edges">;

export interface OverviewOptions {
  /** Genres montrés (puces de filtre) ; absent : tous. Un genre absent de la liste masque ses nœuds ET leurs arêtes. */
  filtres?: readonly MapNodeKind[] | undefined;
  /** Élément au centre de l'attention (survol ou sélection) ; absent, inconnu ou masqué : aucun estompage. */
  focus?: string | null | undefined;
}

export interface OverviewNode {
  node: MapNode;
  colonne: OverviewColumnId;
  /** Genre du groupe, donc puce de filtre qui le montre. */
  groupe: MapNodeKind;
  /** Hors de l'ensemble du focus : estompé, et « (hors sujet) » pour le lecteur d'écran. */
  estompe: boolean;
}

export interface OverviewGroup {
  kind: MapNodeKind;
  nodes: OverviewNode[];
}

export interface OverviewColumn {
  id: OverviewColumnId;
  /** Groupes non vides seulement : une colonne sans nœud visible n'est pas rendue. */
  groupes: OverviewGroup[];
}

export interface OverviewEdge {
  edge: MapEdge;
  /** Nœuds des deux bouts, pour écrire la phrase de l'arête sans la rechercher deux fois. */
  source: MapNode;
  cible: MapNode;
  de: OverviewColumnId;
  vers: OverviewColumnId;
  /** L'arête ne touche pas le focus : estompée comme les nœuds hors sujet. */
  estompe: boolean;
}

export interface OverviewLayout {
  colonnes: OverviewColumn[];
  /** Arêtes visibles : les deux bouts sont montrés par les puces. Ordre des arêtes de la carte (L39a). */
  aretes: OverviewEdge[];
  /** Focus retenu ; null quand il est absent, inconnu de la carte ou masqué par une puce. */
  focus: string | null;
  /** Ensemble du focus (focus, voisins entrants et sortants), dans l'ordre des nœuds ; vide sans focus. */
  ensemble: string[];
}

// --- Disposition -----------------------------------------------------------------------------------------------------------

/**
 * Range la carte en cinq colonnes selon les puces, puis estompe tout ce qui est hors de l'ensemble du focus. Les colonnes et
 * les groupes vides ne sont pas rendus ; l'ordre des nœuds et des arêtes est celui de la carte.
 */
export function overviewLayout(input: OverviewInput, options: OverviewOptions = {}): OverviewLayout {
  const montres = new Set<MapNodeKind>(options.filtres ?? OVERVIEW_FILTERS);
  const visibles = input.nodes.filter((node) => montres.has(node.kind) && COLUMN_OF.has(node.kind));
  const parId = new Map(visibles.map((node) => [node.id, node]));

  // Arêtes visibles : les deux bouts doivent être montrés. Une puce éteinte retire donc aussi les liens qui y mènent.
  const liens: Array<{ edge: MapEdge; source: MapNode; cible: MapNode; de: OverviewColumnId; vers: OverviewColumnId }> = [];
  for (const edge of input.edges) {
    const source = parId.get(edge.from);
    const cible = parId.get(edge.to);
    if (source === undefined || cible === undefined) continue;
    const de = COLUMN_OF.get(source.kind);
    const vers = COLUMN_OF.get(cible.kind);
    if (de === undefined || vers === undefined) continue;
    liens.push({ edge, source, cible, de, vers });
  }

  const focus = options.focus !== undefined && options.focus !== null && parId.has(options.focus) ? options.focus : null;
  const ensemble = new Set<string>();
  if (focus !== null) {
    ensemble.add(focus);
    for (const { edge } of liens) {
      if (edge.to === focus) ensemble.add(edge.from);
      if (edge.from === focus) ensemble.add(edge.to);
    }
  }
  const estompeNoeud = (id: string) => focus !== null && !ensemble.has(id);

  const colonnes: OverviewColumn[] = [];
  for (const id of OVERVIEW_COLUMNS) {
    const groupes: OverviewGroup[] = [];
    for (const kind of OVERVIEW_COLUMN_GROUPS[id]) {
      const nodes = visibles
        .filter((node) => node.kind === kind)
        .map((node) => ({ node, colonne: id, groupe: kind, estompe: estompeNoeud(node.id) }));
      if (nodes.length > 0) groupes.push({ kind, nodes });
    }
    if (groupes.length > 0) colonnes.push({ id, groupes });
  }

  return {
    colonnes,
    aretes: liens.map((lien) => ({ ...lien, estompe: focus !== null && lien.edge.from !== focus && lien.edge.to !== focus })),
    focus,
    ensemble: visibles.filter((node) => ensemble.has(node.id)).map((node) => node.id),
  };
}
