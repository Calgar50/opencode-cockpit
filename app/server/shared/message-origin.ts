// Origine d'un message utilisateur (spécification §5.7.2, JP-1, JS-13 ; plan d'exécution, fiches L4a puis L25a) : classement
// POSITIF, dans l'ordre ; la première règle qui reconnaît le message l'emporte. Itération 1 : cas 1 à 3, 6 et 7 ; la Salle OMO
// (L25a) ajoute le cas 4 (réveil sans réponse) et le cas 5 (relance par l'extension).
// Règles : un message de `prompts` l'emporte toujours (un utilisateur qui tape un marqueur reste « Vous ») ; un marqueur OMO n'est
// jamais cru dans l'instance principale, qui n'a pas d'extension ; un message absent de `prompts` ne suffit jamais à conclure à
// une relance. Le texte des parties n'est lu que pour chercher un marqueur : il n'est ni rendu ni conservé.
// Module pur (server/shared) : aucun module node, aucun accès à process (test de pureté de core.test.ts).
import type { MessageOrigin, SessionInstance } from "./activity-types.ts";

/** Marqueur des messages internes d'Oh My OpenAgent (F-ab) : cru dans la Salle OMO seulement (cas 6). */
export const OMO_INITIATOR_MARKER = "<!-- OMO_INTERNAL_INITIATOR -->";

/** Marqueur d'un réveil déposé sans tour (F-ab) : cru dans la Salle OMO seulement (cas 4). */
export const OMO_NOREPLY_MARKER = "<!-- OMO_INTERNAL_NOREPLY -->";

/**
 * Début du préfixe de relance de l'extension (F-ab, `omo:shared/system-directive.ts`) ; la forme complète est
 * `[SYSTEM DIRECTIVE: OH-MY-OPENCODE - {TYPE}]`. C'est l'un des trois marqueurs de la liste fermée de D-2b-31 : rien d'autre du
 * paquet 4.19.4 n'est recopié ici.
 */
export const OMO_SYSTEM_DIRECTIVE_PREFIX = "[SYSTEM DIRECTIVE: OH-MY-OPENCODE";

/**
 * Types de relance relevés dans la 4.19.4 (documentation et fixtures). La règle du cas 5 n'est PAS limitée à cette liste : elle
 * accepte tout type de la forme reconnue, car une version plus récente peut en ajouter, et un type inconnu doit rester visible
 * plutôt que de retomber en « origine non identifiée ».
 */
export const OMO_RELANCE_TYPES_CONNUS: readonly string[] = [
  "TODO CONTINUATION",
  "BOULDER CONTINUATION",
  "TASK CONTINUATION",
  "FOR CONTINUATION",
  "RALPH LOOP 1/5",
  "ULTRAWORK LOOP VERIFICATION 2/5",
];

/** Préfixe complet, en tête du texte (espaces de début tolérés, comme l'extension elle-même) : `{TYPE}` en majuscules, chiffres, espace, `_`, `/` ou `-`. */
const SYSTEM_DIRECTIVE_RE = /^\[SYSTEM DIRECTIVE: OH-MY-OPENCODE - ([A-Z0-9][A-Z0-9 _/-]{0,63})\]/;

/** Longueur maximale d'un type de relance normalisé (tient dans la garde `data` de activity-facts.ts : 128 caractères). */
export const OMO_RELANCE_TYPE_MAX = 64;

/**
 * Type de relance en code : minuscules, tout ce qui n'est pas lettre ou chiffre devient un trait d'union
 * (« TODO CONTINUATION » → « todo-continuation », « RALPH LOOP 1/5 » → « ralph-loop-1-5 »). Jamais un texte libre : la forme
 * reconnue n'accepte ni minuscule, ni accent, ni ponctuation de phrase.
 */
function codeDeType(type: string): string | null {
  const code = type
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return code === "" || code.length > OMO_RELANCE_TYPE_MAX ? null : code;
}

/** Type de relance porté par un texte, en code, ou null si le texte ne commence pas par le préfixe de l'extension. */
export function relanceType(text: string): string | null {
  const found = SYSTEM_DIRECTIVE_RE.exec(text.replace(/^\s+/, ""));
  return found?.[1] === undefined ? null : codeDeType(found[1]);
}

/** Partie d'un message utilisateur, telle qu'opencode la publie (`message.part.updated`, `GET /session/:id/message`). */
export interface OriginPart {
  type: string;
  synthetic?: boolean;
  text?: string;
}

export interface OriginContext {
  /**
   * Genre de la ligne `prompts` (migration 4 : message, equipe-demande, equipe-resultat) d'un message que le COCKPIT a envoyé,
   * par le proxy ou par une équipe ; null si le cockpit ne l'a pas envoyé. « message » : cas 1 ; « equipe-… » : cas 2 ; tout
   * autre genre n'est pas cru. ⚠ En 1.0.4, `ledger.recordUser` inscrit TOUT message utilisateur reçu (enfants et messages
   * synthétiques compris) avec le genre « message » : l'appelant ne doit passer ici que ce que le cockpit a réellement envoyé.
   */
  promptKind: string | null;
  /** Vrai pour le premier message utilisateur d'une session enfant (`parentID`). */
  firstUserOfChild: boolean;
  instance: SessionInstance;
  /** Vrai pour une RACINE (session sans parent) : condition du cas 5 (JS-13, « relance marquée sur une racine »). */
  racine: boolean;
  /**
   * L'amont sait que le message a été déposé SANS TOUR (`noReply`, F-h) : cas 4, même sans marqueur. Le cockpit ne le sait que
   * pour ses propres envois (qui sont dans `prompts`, donc cas 1 ou 2) et pour ce que le processeur de la salle lui en dit ;
   * absent, seul le marqueur déclenche le cas 4.
   */
  noReply?: boolean;
  /**
   * MO-1 (MX-OMO, 18/09) : l'amont met l'IDENTITÉ du message en doute — son `messageID` a déjà été vu pour une AUTRE session, ou
   * une partie s'ajoute à un message déjà clos. `prompt_async` accepte n'importe quel identifiant commençant par `msg` et fusionne
   * les parties d'un identifiant répété : un `messageID` est un corrélateur, JAMAIS une preuve d'origine. Le classement ne croit
   * alors plus rien de ce message, pas même sa ligne `prompts` : cas 7, et donc, sur une racine de la salle, la détection
   * « origine-inconnue » (§4.14.5 n° 5) arrête la salle.
   */
  identiteSuspecte?: boolean;
}

/** Numéro de cas du §5.7.2 et origine retenue ; `relance` n'est porté que par le cas 5. */
export interface OriginVerdict {
  cas: 1 | 2 | 3 | 4 | 5 | 6 | 7;
  origine: MessageOrigin;
  /** Cas 5 seulement : type de relance en code (« todo-continuation »…), tel qu'il part dans `data.relance`. */
  relance?: string;
}

/** Verdict d'une règle sur les parties : l'origine, et pour le cas 5 le type de relance. */
type PartVerdict = { origine: MessageOrigin; relance?: string };

type OriginRule = (parts: readonly OriginPart[], ctx: OriginContext) => PartVerdict | null;

/** Vrai si le message a au moins une partie texte et que toutes ses parties texte portent `synthetic: true`. */
export function isSyntheticMessage(parts: readonly OriginPart[]): boolean {
  const texts = parts.filter((part) => part.type === "text");
  return texts.length > 0 && texts.every((part) => part.synthetic === true);
}

function carriesMarker(parts: readonly OriginPart[], marker: string): boolean {
  return parts.some((part) => part.type === "text" && typeof part.text === "string" && part.text.includes(marker));
}

/** Premier type de relance porté par une partie texte, en code ; null si aucune partie ne commence par le préfixe. */
function relanceDesParties(parts: readonly OriginPart[]): string | null {
  for (const part of parts) {
    if (part.type !== "text" || typeof part.text !== "string") continue;
    const type = relanceType(part.text);
    if (type !== null) return type;
  }
  return null;
}

/**
 * Chemin du carnet partagé qu'un hook de l'extension ajoute EN TÊTE d'une consigne, avant son exécution (F-ab,
 * `omo:hooks/sisyphus-junior-notepad/hook.ts`). C'est un CHEMIN, jamais un texte de l'extension (D-2b-31), et c'est un INDICE,
 * jamais une preuve : il sert à marquer une partie « ajouté par l'extension » (JP-4), jamais à classer une origine.
 */
export const OMO_NOTEPAD_PATH = ".omo/notepads/";

/** Vrai si une partie texte porte la directive de carnet d'un hook (JP-4). L'appelant vérifie qu'on est bien dans la salle. */
export function partsCarryHookPrefix(parts: readonly OriginPart[]): boolean {
  return carriesMarker(parts, OMO_NOTEPAD_PATH);
}

/** Marqueurs qu'une règle cherche dans le texte d'une partie. Une règle qui en lit un autre doit l'ajouter ici (originPartSummary). */
const TEXT_MARKERS: readonly string[] = [OMO_INITIATOR_MARKER, OMO_NOREPLY_MARKER, OMO_NOTEPAD_PATH];

/**
 * Partie réduite à ce que lit le classement : type, drapeau `synthetic`, marqueurs reconnus et préfixe de relance remis en tête,
 * jamais le texte. Le verdict d'un message est le même sur ses parties réduites (message-origin.test.ts) : c'est tout ce que la
 * mémoire du flux en garde. Le préfixe est recopié tel qu'il a été reconnu, et à la position 0, pour que la règle du cas 5, qui
 * lit un PRÉFIXE, dise la même chose sur la partie réduite.
 */
export function originPartSummary(part: Readonly<Record<string, unknown>>): OriginPart {
  const summary: OriginPart = { type: typeof part.type === "string" ? part.type : "", synthetic: part.synthetic === true };
  const text = part.text;
  if (typeof text === "string") {
    const directive = SYSTEM_DIRECTIVE_RE.exec(text.replace(/^\s+/, ""));
    const kept = directive === null ? [] : [directive[0]];
    summary.text = [...kept, ...TEXT_MARKERS.filter((marker) => text.includes(marker))].join(" ");
  }
  return summary;
}

/** Cas 1 à 3 : ils ne lisent que le contexte, jamais les parties du message. */
const CONTEXT_RULES: ReadonlyArray<readonly [OriginVerdict["cas"], (ctx: OriginContext) => MessageOrigin | null]> = [
  [1, (ctx) => (ctx.promptKind === "message" ? "demande" : null)],
  [2, (ctx) => (ctx.promptKind !== null && /^equipe-[a-z]+$/.test(ctx.promptKind) ? "cockpit" : null)],
  [3, (ctx) => (ctx.firstUserOfChild ? "consigne" : null)],
];

/**
 * Verdict des cas 1 à 3, rendu sans connaître les parties ; null quand il faut TOUTES les parties du message (cas 4 à 7) : un
 * classement fait sur les parties déjà arrivées dépendrait de leur ordre d'arrivée (une partie synthétique, puis une réelle).
 * Une identité douteuse (MO-1) ferme aussi ce chemin : le verdict attend alors le message entier et finit en cas 7.
 */
export function contextVerdict(ctx: OriginContext): OriginVerdict | null {
  if (ctx.identiteSuspecte === true) return null;
  for (const [cas, rule] of CONTEXT_RULES) {
    const origine = rule(ctx);
    if (origine !== null) return { cas, origine };
  }
  return null;
}

/** Cas 4 à 6, dans l'ordre du §5.7.2, après les cas 1 à 3 (contextVerdict) ; le cas 7 est le repli de originVerdict. */
const PART_RULES: ReadonlyArray<readonly [OriginVerdict["cas"], OriginRule]> = [
  [
    4,
    // Réveil déposé sans tour : « Résultat déposé, lu à son prochain tour », sans appel ni coût (JP-2). Le marqueur n'est cru que
    // dans la salle ; le drapeau `noReply`, lui, décrit la façon dont opencode a enregistré le message, sans rien devoir à
    // l'extension : il vaut dans les deux instances.
    (parts, ctx) => (ctx.noReply === true || (ctx.instance === "omo" && carriesMarker(parts, OMO_NOREPLY_MARKER)) ? { origine: "reveil-sans-reponse" } : null),
  ],
  [
    5,
    // Relance de l'extension, sur une RACINE de la salle seulement (JS-13) : dans un enfant, le même préfixe ouvre une consigne,
    // que le cas 3 a déjà reconnue. Hors de la salle, le préfixe n'est jamais cru (cas 7).
    (parts, ctx) => {
      if (ctx.instance !== "omo" || !ctx.racine) return null;
      const relance = relanceDesParties(parts);
      return relance === null ? null : { origine: "relance-extension", relance };
    },
  ],
  [
    6,
    (parts, ctx) => {
      if (ctx.instance === "omo") return isSyntheticMessage(parts) || carriesMarker(parts, OMO_INITIATOR_MARKER) ? { origine: "interne-extension" } : null;
      // Instance principale : seul le drapeau d'opencode compte, un marqueur de l'extension n'y est jamais cru.
      return isSyntheticMessage(parts) ? { origine: "interne-opencode" } : null;
    },
  ],
];

/** Origine d'un message utilisateur et numéro du cas qui l'a reconnue (7 : « Message non écrit par vous (origine non identifiée) »). */
export function originVerdict(parts: readonly OriginPart[], ctx: OriginContext): OriginVerdict {
  // MO-1 : identité douteuse → rien n'est cru, pas même `prompts`, dont la ligne est retrouvée par un `messageID` forgeable.
  if (ctx.identiteSuspecte === true) return { cas: 7, origine: "origine-inconnue" };
  const known = contextVerdict(ctx);
  if (known !== null) return known;
  for (const [cas, rule] of PART_RULES) {
    const verdict = rule(parts, ctx);
    if (verdict !== null) return verdict.relance === undefined ? { cas, origine: verdict.origine } : { cas, origine: verdict.origine, relance: verdict.relance };
  }
  return { cas: 7, origine: "origine-inconnue" };
}

/** Origine d'un message utilisateur (§5.7.2). */
export function classifyOrigin(parts: readonly OriginPart[], ctx: OriginContext): MessageOrigin {
  return originVerdict(parts, ctx).origine;
}
