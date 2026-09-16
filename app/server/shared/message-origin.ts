// Origine d'un message utilisateur (spécification §5.7.2, JP-1, JS-13 ; plan d'exécution, fiche L4a) : classement POSITIF, dans
// l'ordre ; la première règle qui reconnaît le message l'emporte. Itération 1 : cas 1 à 3, 6 et 7 ; les cas 4 (réveil sans
// réponse) et 5 (relance par l'extension) sont réservés à la Salle OMO (L25) et ne reconnaissent rien ici.
// Règles : un message de `prompts` l'emporte toujours (un utilisateur qui tape un marqueur reste « Vous ») ; un marqueur OMO n'est
// jamais cru dans l'instance principale, qui n'a pas d'extension ; un message absent de `prompts` ne suffit jamais à conclure à
// une relance. Le texte des parties n'est lu que pour chercher un marqueur : il n'est ni rendu ni conservé.
// Module pur (server/shared) : aucun module node, aucun accès à process (test de pureté de core.test.ts).
import type { MessageOrigin, SessionInstance } from "./activity-types.ts";

/** Marqueur des messages internes d'Oh My OpenAgent (F-ab) : cru dans la Salle OMO seulement (cas 6). */
export const OMO_INITIATOR_MARKER = "<!-- OMO_INTERNAL_INITIATOR -->";

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
}

/** Numéro de cas du §5.7.2 et origine retenue. */
export interface OriginVerdict {
  cas: 1 | 2 | 3 | 4 | 5 | 6 | 7;
  origine: MessageOrigin;
}

type OriginRule = (parts: readonly OriginPart[], ctx: OriginContext) => MessageOrigin | null;

/** Vrai si le message a au moins une partie texte et que toutes ses parties texte portent `synthetic: true`. */
export function isSyntheticMessage(parts: readonly OriginPart[]): boolean {
  const texts = parts.filter((part) => part.type === "text");
  return texts.length > 0 && texts.every((part) => part.synthetic === true);
}

function carriesMarker(parts: readonly OriginPart[], marker: string): boolean {
  return parts.some((part) => part.type === "text" && typeof part.text === "string" && part.text.includes(marker));
}

/** Cas 1 à 6, dans l'ordre du §5.7.2 ; le cas 7 est le repli de classifyOrigin. */
const RULES: ReadonlyArray<readonly [OriginVerdict["cas"], OriginRule]> = [
  [1, (_parts, ctx) => (ctx.promptKind === "message" ? "demande" : null)],
  [2, (_parts, ctx) => (ctx.promptKind !== null && /^equipe-[a-z]+$/.test(ctx.promptKind) ? "cockpit" : null)],
  [3, (_parts, ctx) => (ctx.firstUserOfChild ? "consigne" : null)],
  // Cas 4 : texte noReply ou marqueur OMO_INTERNAL_NOREPLY → reveil-sans-reponse. Réservé (L25, Salle OMO).
  [4, () => null],
  // Cas 5 : préfixe [SYSTEM DIRECTIVE: OH-MY-OPENCODE - {TYPE}] sur une racine → relance-extension. Réservé (L25, Salle OMO).
  [5, () => null],
  [
    6,
    (parts, ctx) => {
      if (ctx.instance === "omo") return isSyntheticMessage(parts) || carriesMarker(parts, OMO_INITIATOR_MARKER) ? "interne-extension" : null;
      // Instance principale : seul le drapeau d'opencode compte, un marqueur de l'extension n'y est jamais cru.
      return isSyntheticMessage(parts) ? "interne-opencode" : null;
    },
  ],
];

/** Origine d'un message utilisateur et numéro du cas qui l'a reconnue (7 : « Message non écrit par vous (origine non identifiée) »). */
export function originVerdict(parts: readonly OriginPart[], ctx: OriginContext): OriginVerdict {
  for (const [cas, rule] of RULES) {
    const origine = rule(parts, ctx);
    if (origine !== null) return { cas, origine };
  }
  return { cas: 7, origine: "origine-inconnue" };
}

/** Origine d'un message utilisateur (§5.7.2). */
export function classifyOrigin(parts: readonly OriginPart[], ctx: OriginContext): MessageOrigin {
  return originVerdict(parts, ctx).origine;
}
