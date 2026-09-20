// Méthodes : blocs balisés, détection et interdits (spécification §3.7 l.299, §5.4 l.910, §6 l.1051 ; conception C §5.4 ;
// recherche RM §2, §5.1 à §5.3 ; plan d'exécution it5 D-5-07, D-5-08, fiche L44a).
//
// Une méthode est un TEXTE, jamais un appel d'IA en plus. Trois emplacements, trois formes :
// - assistant (durable) : bloc « <!-- cockpit:methode {id} v{n} --> … <!-- /cockpit:methode --> » dans le corps du fichier
//   d'agent, AVANT le bloc de règles communes, qui reste le dernier (D-5-07) ;
// - un message : bloc visible « <!-- cockpit:methode-message {id} v{n} --> … », ajouté à la fin du texte envoyé (D-5-08) ;
// - « Seconde lecture » (kind « relecture ») : un autre assistant, jamais un bloc de texte — elle n'est donc jamais rendue ici.
//
// La VÉRITÉ est le fichier d'agent : `methodIdsIn` le relit. `item_meta.methods` n'en est qu'un miroir, écrit ailleurs.
// Aucune méthode n'est attachée automatiquement : elles sont seulement conseillées (`suggereePour`).
//
// Module pur (server/shared) : aucun module node, aucun accès à process (test de pureté de core.test.ts). Seul import :
// construction-constants.ts, lui-même pur, posé au train de V0 à la place de la copie locale des limites (plan it5 §5.3).
import {
  METHOD_BLOCK_MAX_CHARS,
  METHOD_BLOCK_MAX_WORDS,
  METHODS_PER_ASSISTANT,
  METHODS_PER_MESSAGE,
  METHODS_PER_STEP,
} from "./construction-constants.ts";

/** Entrée du catalogue des méthodes (conception C §5.4). */
export interface Method {
  id: string;
  version: number;
  /** Titre affiché, repris tel quel dans l'en-tête demandé à l'IA. */
  titre: string;
  /** Une phrase pour un débutant. */
  phrase: string;
  /** Quand cette méthode sert (texte affiché). */
  quand: string;
  /** Ce qu'elle rate et comment le texte y pare (texte affiché). */
  attention: string;
  /** « consigne » : un bloc de texte ; « relecture » : un autre assistant relit, sans bloc. */
  kind: "consigne" | "relecture";
  /** Texte ajouté aux consignes ou au message ; vide pour une méthode « relecture ». */
  bloc: string;
  /** En-tête demandé à l'IA, cherché ensuite dans sa réponse (« ### Méthode : {titre} »). */
  enTete: string;
  /** Identifiants d'assistants du catalogue pour lesquels la méthode est CONSEILLÉE, jamais attachée. */
  suggereePour: string[];
  /** Liens de la recherche, affichés en mode Avancé seulement. */
  sources: string[];
}

// --- Limites -------------------------------------------------------------------------------------------------------------------

// Les cinq valeurs viennent de construction-constants.ts (T5a), seule source depuis le train de V0 : la copie locale de L44a
// a été remplacée par l'import ci-dessus, après vérification de l'égalité des cinq valeurs (plan d'exécution it5 §4.2, §5.3).

/** Limites des méthodes (2 par assistant, par message et par étape ; bloc de 900 caractères et 120 mots au plus). */
export const METHOD_LIMITS = {
  parAssistant: METHODS_PER_ASSISTANT,
  parMessage: METHODS_PER_MESSAGE,
  parEtape: METHODS_PER_STEP,
  blocMaxCaracteres: METHOD_BLOCK_MAX_CHARS,
  blocMaxMots: METHOD_BLOCK_MAX_WORDS,
} as const;

// --- Marqueurs -----------------------------------------------------------------------------------------------------------------

const BLOCK_END = "<!-- /cockpit:methode -->";
const MESSAGE_BLOCK_END = "<!-- /cockpit:methode-message -->";

/** Identifiant d'une méthode dans un marqueur : minuscules, chiffres et traits d'union. */
const ID = "[\\w-]+";

const BLOCK_RE = new RegExp(`<!-- cockpit:methode (${ID}) v(\\d+) -->[\\s\\S]*?${BLOCK_END}`, "g");
const BLOCK_ORPHAN_LINE_RE = new RegExp(`^(?:<!-- cockpit:methode ${ID} v\\d+ -->|${BLOCK_END})$`);
/** En-tête posé par le cockpit : « (ajoutée par le cockpit) » le distingue de l'en-tête d'une étape ou d'un message. */
const BLOCK_HEADER_ORPHAN_RE = /^## Méthode : .* \(ajoutée par le cockpit\)$/;
/** Début du bloc de règles communes (assistant-rules.ts), qui doit rester le DERNIER bloc du corps (D-5-07). */
const COMMON_RULES_START_RE = /^<!-- cockpit:regles-communes v\d+ -->$/m;

const MESSAGE_BLOCK_RE = new RegExp(
  `<!-- cockpit:methode-message (${ID}) v(\\d+) -->\\n## Méthode demandée : [^\\n]*\\n([\\s\\S]*?)\\n?${MESSAGE_BLOCK_END}`,
  "g",
);

/** Fins de ligne normalisées : un corps relu peut venir d'un fichier écrit sous Windows. */
const lf = (text: string): string => text.replace(/\r\n/g, "\n");

/** Marqueurs d'un bloc de méthode attaché à un assistant. */
export function methodMarkers(id: string, version: number): { debut: string; fin: string } {
  return { debut: `<!-- cockpit:methode ${id} v${version} -->`, fin: BLOCK_END };
}

// --- Blocs d'un fichier d'agent ------------------------------------------------------------------------------------------------

/**
 * Bloc à insérer dans le corps d'un assistant. Rend "" pour une méthode « relecture » (elle n'est pas du texte) et pour un
 * bloc vide : `applyMethodBlocks` ne pose alors rien.
 */
export function renderMethodBlock(m: Method): string {
  if (m.kind !== "consigne") return "";
  const bloc = lf(m.bloc).trim();
  if (bloc === "") return "";
  const { debut, fin } = methodMarkers(m.id, m.version);
  return [debut, `## Méthode : ${m.titre} (ajoutée par le cockpit)`, bloc, fin].join("\n");
}

/** Corps sans aucun bloc de méthode (toutes versions), marqueurs et en-têtes orphelins compris, comme `stripCommonRules`. */
export function stripMethodBlocks(body: string): string {
  return lf(body)
    .replace(BLOCK_RE, "")
    .split("\n")
    .filter((line) => !BLOCK_ORPHAN_LINE_RE.test(line.trim()) && !BLOCK_HEADER_ORPHAN_RE.test(line.trim()))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * Corps avec EXACTEMENT les méthodes données, dans l'ordre, séparées d'une ligne vide : tous les blocs existants sont retirés
 * d'abord, donc la fonction est idempotente et ne laisse jamais deux blocs du même identifiant. Les blocs sont posés avant les
 * règles communes, qui restent le dernier bloc du corps (D-5-07). Rend un corps sans saut de ligne final : l'appelant compose.
 */
export function applyMethodBlocks(body: string, methods: readonly Method[]): string {
  const base = stripMethodBlocks(body);
  const vus = new Set<string>();
  const blocs: string[] = [];
  for (const m of methods) {
    if (vus.has(m.id)) continue;
    vus.add(m.id);
    const bloc = renderMethodBlock(m);
    if (bloc !== "") blocs.push(bloc);
  }
  if (blocs.length === 0) return base;
  const ajout = blocs.join("\n\n");
  const marque = COMMON_RULES_START_RE.exec(base);
  if (marque === null) return base === "" ? ajout : `${base}\n\n${ajout}`;
  const avant = base.slice(0, marque.index).replace(/\n+$/, "");
  return `${avant === "" ? "" : `${avant}\n\n`}${ajout}\n\n${base.slice(marque.index)}`;
}

/**
 * Méthodes réellement présentes dans le corps, dans l'ordre du fichier : c'est la VÉRITÉ (D-5-07). Un marqueur orphelin, sans
 * fin, ne compte pas. Un même identifiant écrit deux fois à la main est rendu deux fois : le fichier est décrit tel qu'il est.
 */
export function methodIdsIn(body: string): { id: string; version: number }[] {
  const out: { id: string; version: number }[] = [];
  for (const trouve of lf(body).matchAll(BLOCK_RE)) {
    out.push({ id: trouve[1] ?? "", version: Number(trouve[2] ?? "0") });
  }
  return out;
}

// --- Bloc ajouté à un message --------------------------------------------------------------------------------------------------

/** Bloc visible ajouté à la fin du texte d'un message (D-5-08) ; "" pour une méthode « relecture » ou un bloc vide. */
export function renderMessageMethodBlock(m: Method): string {
  if (m.kind !== "consigne") return "";
  const bloc = lf(m.bloc).trim();
  if (bloc === "") return "";
  return `\n\n<!-- cockpit:methode-message ${m.id} v${m.version} -->\n## Méthode demandée : ${m.titre}\n${bloc}\n${MESSAGE_BLOCK_END}`;
}

/** Texte d'un message séparé des blocs de méthode qu'il porte (bulle repliée, archives, relecture d'un envoi). */
export function splitMessageMethods(text: string): { texte: string; methodes: { id: string; version: number; bloc: string }[] } {
  const brut = lf(text);
  const methodes: { id: string; version: number; bloc: string }[] = [];
  for (const trouve of brut.matchAll(MESSAGE_BLOCK_RE)) {
    methodes.push({ id: trouve[1] ?? "", version: Number(trouve[2] ?? "0"), bloc: (trouve[3] ?? "").trim() });
  }
  const texte = brut.replace(MESSAGE_BLOCK_RE, "").replace(/\n{3,}/g, "\n\n").trim();
  return { texte, methodes };
}

// --- Détection dans la réponse ---------------------------------------------------------------------------------------------------

/** Minuscules sans accents : la détection tolère « ### METHODE : PRE-MORTEM » comme « ### Méthode : Pré-mortem ». */
const aplati = (text: string): string =>
  text
    .normalize("NFD")
    .replace(/\p{M}+/gu, "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();

/**
 * Vrai quand l'en-tête de la méthode ouvre une ligne de la réponse (casse et accents tolérés). Jamais au milieu d'une ligne :
 * la présence de la section est la SEULE chose contrôlée, jamais la qualité du raisonnement (spéc. §6 l.1051).
 */
export function methodDetected(answer: string, m: Method): boolean {
  const cherche = aplati(m.enTete);
  if (cherche === "") return false;
  for (const line of lf(answer).split("\n")) {
    if (aplati(line).startsWith(cherche)) return true;
  }
  return false;
}

// --- Contrôle du texte d'une méthode -----------------------------------------------------------------------------------------

/** Séquences refusées dans un bloc : exécution de commande d'opencode, référence de fichier, arguments d'un raccourci. */
const INTERDITS: readonly string[] = ["!`", "@", "$ARGUMENTS"];

/** Dernière phrase attendue : une méthode ne s'applique qu'à son déclencheur. */
export const PHRASE_SINON = "Sinon, n'applique pas cette méthode.";

/** Méthodes de base, qui s'appliquent toujours et n'ont donc pas de phrase « Sinon » (RM §2.1). */
const SANS_SINON_PERMIS: readonly string[] = ["certitude"];

export type MethodTextProblem = "interdit" | "trop-long" | "sans-en-tete" | "sans-sinon";

/** Dernière phrase d'un texte, ponctuation finale comprise. */
function dernierePhrase(bloc: string): string {
  const phrases = bloc.trim().split(/(?<=[.!?])\s+/);
  return (phrases[phrases.length - 1] ?? "").trim();
}

/**
 * Problème du texte d'une méthode, ou null. Une méthode « relecture » n'a pas de bloc : rien à contrôler.
 * Ordre des contrôles : interdits, longueur, en-tête demandé, phrase « Sinon ».
 */
export function methodTextProblem(m: Method): MethodTextProblem | null {
  if (m.kind !== "consigne") return null;
  const bloc = lf(m.bloc).trim();
  for (const interdit of INTERDITS) if (bloc.includes(interdit)) return "interdit";
  const mots = bloc === "" ? 0 : bloc.split(/\s+/).length;
  if (bloc.length > METHOD_LIMITS.blocMaxCaracteres || mots > METHOD_LIMITS.blocMaxMots) return "trop-long";
  if (!bloc.includes(m.enTete)) return "sans-en-tete";
  if (!SANS_SINON_PERMIS.includes(m.id) && dernierePhrase(bloc) !== PHRASE_SINON) return "sans-sinon";
  return null;
}
