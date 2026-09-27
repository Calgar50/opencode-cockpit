// Propriétaire : L39b.
// Modèle PUR de la carte des assistants (spécification §5.2 l.887-892, §5.4 l.911, §5.5, §5.6 ; C §7.4, §9.9 ; plan d'exécution
// it4, fiche L39b ; D-eq-24 : toute la logique testable vit ici, les .tsx restent minces). Testé par
// server/agent-map-service.test.ts.
// - AUCUN texte écrit ici : tout vient de server/shared/agent-map-texts.ts (T4t), gabarits remplis par remplir() et phraseArete().
// - `edge.kind` EST TOUJOURS PASSÉ à phraseArete (correction de contrat du train de V0 : un raccourci qui n'est pas une sous-tâche
//   porte le code `utilise` avec le genre `lance`, et sa phrase n'est pas celle de Vous).
// - La vue Liste est la VÉRITÉ (U11) : mapAsList rend une entrée par arête, jamais deux ; les colonnes de la vue Centrée sont les
//   voisins de neighbours (L39a). Les deux fonctions viennent du module pur de L39a : rien n'est recalculé ici.
import type { AgentMapResult, MapEdge, MapListSection, MapNode, MapNoteCode } from "../../../../server/shared/agent-map.ts";
import { MAP_VOUS_ID, mapAsList, neighbours } from "../../../../server/shared/agent-map.ts";
import { genre, phraseArete, phraseNote, remplir, TEXTES } from "../../../../server/shared/agent-map-texts.ts";

const P = TEXTES.partout;

/** Notes qui sont des ÉTATS VIDES (spécification §5.4 l.911) : elles prennent la place de la carte, pas la ligne des notes. */
export const NOTES_ETAT_VIDE: readonly MapNoteCode[] = ["aucun-assistant", "aucun-lien"];

/** Note déjà dite ailleurs : « IA de l'assistant qui délègue » est la ligne d'IA des nœuds concernés, jamais répétée dessous. */
const NOTE_PORTEE_PAR_UN_NOEUD: MapNoteCode = "ia-du-delegant";

/** Mot de la légende d'une arête ; null : lien sans confirmation à dire (« Vous pouvez utiliser… »). */
export type CarteTrait = "sans" | "accord" | "impose";

/**
 * Trait d'une arête, dit par un MOT de la légende, jamais par la couleur seule (§2.3, U9) : ce que le cockpit impose d'abord
 * (arête d'étape, refus d'une délégation en mode Simple, équipe lancée par le cockpit), puis ce qu'opencode demande ou laisse
 * passer.
 */
export function traitArete(edge: MapEdge): CarteTrait | null {
  if (edge.appliquePar === "cockpit") return "impose";
  if (edge.confirmation === "demandee") return "accord";
  if (edge.confirmation === "sans") return "sans";
  return null;
}

/** Libellé du trait dans la légende et sous chaque lien. */
export function motTrait(trait: CarteTrait): string {
  if (trait === "sans") return P.legende.sans;
  if (trait === "accord") return P.legende.accord;
  return P.legende.impose;
}

/** Genres de nœuds qui ont une carte d'identité (droits, IA, fiches) : les autres n'ont qu'un nom et un genre. */
const GENRES_AVEC_IDENTITE: ReadonlySet<MapNode["kind"]> = new Set<MapNode["kind"]>(["assistant", "integre", "agent-studio", "sous-agent"]);

/** true si le clic sur ce nœud ouvre la carte d'identité existante (IdentityCard). */
export function aUneIdentite(node: MapNode): boolean {
  return GENRES_AVEC_IDENTITE.has(node.kind);
}

/** Nom affiché d'un nœud : son titre, sinon son nom, sinon le libellé de son genre (« Vous »). */
export function nomDuNoeud(node: MapNode, avance: boolean): string {
  if (node.title !== null && node.title !== "") return node.title;
  if (node.kind === "vous") return genre(node.kind, avance) ?? node.name;
  return node.name;
}

/** Libellé du genre d'un nœud ; en Avancé, les mots d'opencode pour les agents du Studio et les assistants délégués. */
export function genreDuNoeud(node: MapNode, avance: boolean): string {
  return genre(node.kind, avance) ?? node.kind;
}

/** Ligne d'IA d'un nœud : son IA propre, celle de la conversation, ou celle de l'assistant qui délègue ; null : rien à dire. */
export function iaDuNoeud(node: MapNode): string | null {
  if (node.ia.label !== null) return remplir(P.ia.propre, { ia: node.ia.label });
  if (node.ia.heritee === "conversation") return P.ia.conversation;
  if (node.ia.heritee === "delegant") return phraseNote(NOTE_PORTEE_PAR_UN_NOEUD);
  return null;
}

/** Un lien montré à côté d'un élément (vue Centrée) ou dans une section (vue Liste) : l'autre bout et la phrase de l'arête. */
export interface CarteLien {
  /** Identifiant de nœud de l'autre bout (adresse #/assistants/carte?element=…). */
  id: string;
  nom: string;
  genre: string;
  /** Genre de l'arête (L39a), gardé pour les regroupements de l'interface (fiches consultées, raccourcis qui l'utilisent). */
  kind: MapEdge["kind"];
  /** Phrase de l'arête, écrite par T4t ; edge.kind est toujours passé. */
  phrase: string;
  /** Qui applique le lien : « règle d'opencode » ou « imposé par le cockpit ». */
  appliquePar: string;
  trait: CarteTrait | null;
  /** Mot du trait, répété à côté du lien (jamais la couleur seule) ; null quand il n'y a pas de confirmation à dire. */
  mot: string | null;
  /** Le cockpit refuse ce lien en mode Simple (décision n° 4) : la phrase le dit déjà, la forme du trait aussi. */
  refuseEnSimple: boolean;
  /** Rang et niveau d'une étape d'équipe (arête `etape`) ; null sinon. */
  etape: MapEdge["etape"] | null;
}

// <c5:vue-ensemble>
// Itération 5b (L48) : le seul changement de ce fichier est le mot-clé `export` ci-dessous, le corps est celui de L39b. La vue
// d'ensemble écrit les mêmes phrases de lien que les vues Centrée et Liste et doit passer par ici : sans cela elle appellerait
// phraseArete elle-même et pourrait oublier edge.kind, ce que la garde « aucune vue n'appelle phraseArete » de L39b interdit.
// </c5:vue-ensemble>
/** Lien d'une arête vue depuis `source` vers `cible`. Le genre de l'arête est TOUJOURS passé à phraseArete (train de V0). */
export function lienDe(edge: MapEdge, source: MapNode, cible: MapNode, autre: MapNode, avance: boolean): CarteLien {
  const trait = traitArete(edge);
  const appliquePar = edge.appliquePar === "cockpit" ? P.appliquePar.cockpit : P.appliquePar.opencode;
  const mot = trait === null ? null : motTrait(trait);
  return {
    id: autre.id,
    nom: nomDuNoeud(autre, avance),
    genre: genreDuNoeud(autre, avance),
    kind: edge.kind,
    phrase: phraseArete(edge.code, nomDuNoeud(source, avance), nomDuNoeud(cible, avance), edge.confirmation, edge.kind) ?? "",
    appliquePar,
    trait,
    // Défaut D4 du banc de la vague 4 (arbitrage A13) : le mot de la légende « impose » et `appliquePar.cockpit` sont la MÊME
    // phrase (agent-map-texts.ts) ; la vue Liste, vérité pour le lecteur d'écran (U11), l'écrivait deux fois de suite. Le mot
    // n'est gardé que s'il dit autre chose que qui applique le lien ; la règle vaut pour toute paire de textes qui se rejoint.
    mot: mot === appliquePar ? null : mot,
    refuseEnSimple: edge.refuseEnSimple,
    etape: edge.etape ?? null,
  };
}

/** Trois colonnes de la vue Centrée : « Qui le fait travailler » · élément · « Qui il fait travailler et ce qu'il consulte ». */
export interface CarteColonnes {
  element: MapNode;
  amont: CarteLien[];
  aval: CarteLien[];
}

/** Colonnes d'un élément ; null : élément inconnu de la carte. */
export function colonnesDe(result: AgentMapResult, element: string, avance: boolean): CarteColonnes | null {
  const voisins = neighbours(result, element);
  if (!voisins) return null;
  const centre = voisins.element;
  return {
    element: centre,
    amont: voisins.entrants.map(({ node, edge }) => lienDe(edge, node, centre, node, avance)),
    aval: voisins.sortants.map(({ node, edge }) => lienDe(edge, centre, node, node, avance)),
  };
}

/** Une section de la vue Liste : un élément et les liens qui en partent (une entrée par arête, jamais deux). */
export interface CarteSection {
  node: MapNode;
  liens: CarteLien[];
}

/**
 * Vue Liste, vérité pour le lecteur d'écran (U11) : toutes les arêtes de la carte, une phrase chacune, rangées par l'élément
 * d'où elles partent. `element` ne filtre rien : il n'est là que pour marquer la section choisie.
 */
export function sectionsDeLaListe(result: AgentMapResult, avance: boolean): CarteSection[] {
  const byId = new Map(result.nodes.map((node) => [node.id, node]));
  return mapAsList(result).map((section: MapListSection) => ({
    node: section.node,
    liens: section.entries.map(({ edge, autre }) => lienDe(edge, byId.get(edge.from) ?? section.node, autre, autre, avance)),
  }));
}

/** Phrases des états vides (§5.4 l.911) : aucun assistant installé, aucun lien entre assistants. */
export function phrasesEtatVide(result: AgentMapResult): string[] {
  return result.notes.filter((code) => NOTES_ETAT_VIDE.includes(code)).map((code) => phraseNote(code) ?? "");
}

/**
 * Notes sous la carte, dans l'ordre de L39a : les états vides (rendus ailleurs) et « IA de l'assistant qui délègue » (ligne d'IA
 * d'un nœud) en sont retirés. « La carte montre ce que les règles permettent, pas ce qui s'est passé. » en fait partie.
 */
export function notesSousLaCarte(result: AgentMapResult): string[] {
  return result.notes
    .filter((code) => !NOTES_ETAT_VIDE.includes(code) && code !== NOTE_PORTEE_PAR_UN_NOEUD)
    .map((code) => phraseNote(code) ?? "")
    .filter((phrase) => phrase !== "");
}

// --- Sélecteur d'élément ---------------------------------------------------------------------------------------------------

/** Groupe du sélecteur d'un genre de nœud ; null : « Vous », seul, en tête de la liste. */
function groupeDe(node: MapNode): string | null {
  switch (node.kind) {
    case "vous":
      return null;
    case "raccourci":
      return P.groupes.raccourcis;
    case "equipe":
      return P.groupes.equipes;
    case "fiche":
      return P.groupes.fiches;
    default:
      return P.groupes.assistants;
  }
}

export interface CarteOption {
  id: string;
  nom: string;
}

export interface CarteGroupe {
  /** Titre du groupe (<optgroup>) ; null : options sans groupe, en tête. */
  titre: string | null;
  options: CarteOption[];
}

/** Recherche insensible à la casse et aux accents (le nom affiché comme le nom technique sont comparés). */
function normaliser(texte: string): string {
  return texte.normalize("NFD").replace(/\p{Diacritic}/gu, "").toLowerCase();
}

/** Groupes du sélecteur, dans l'ordre des nœuds ; `recherche` vide : tout. Un groupe sans option n'est pas rendu. */
export function groupesDuSelecteur(result: AgentMapResult, avance: boolean, recherche = ""): CarteGroupe[] {
  const cherche = normaliser(recherche.trim());
  const groupes: CarteGroupe[] = [];
  for (const node of result.nodes) {
    const nom = nomDuNoeud(node, avance);
    if (cherche !== "" && !normaliser(nom).includes(cherche) && !normaliser(node.name).includes(cherche)) continue;
    const titre = groupeDe(node);
    const dernier = groupes.find((groupe) => groupe.titre === titre);
    if (dernier) dernier.options.push({ id: node.id, nom });
    else groupes.push({ titre, options: [{ id: node.id, nom }] });
  }
  return groupes;
}

/**
 * Élément montré : celui de l'adresse s'il existe dans la carte, sinon « Vous », sinon le premier nœud ; null : carte vide.
 * Un élément inconnu ne vide jamais la vue : la carte reste lisible et l'adresse garde sa valeur.
 */
export function elementMontre(result: AgentMapResult, demande: string | null): string | null {
  const ids = new Set(result.nodes.map((node) => node.id));
  if (demande !== null && ids.has(demande)) return demande;
  if (ids.has(MAP_VOUS_ID)) return MAP_VOUS_ID;
  return result.nodes[0]?.id ?? null;
}

/** Nœud d'un identifiant ; null s'il n'est pas dans la carte. */
export function noeudDe(result: AgentMapResult, id: string | null): MapNode | null {
  return id === null ? null : (result.nodes.find((node) => node.id === id) ?? null);
}
