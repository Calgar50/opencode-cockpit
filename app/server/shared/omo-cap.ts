// Plafond de coût saisi de la Salle OMO (spécification §4.8.2 l.722, l.729-730 ; §3.6 l.280-287 ; §9.2.2 Q7 l.1374 ; plan
// d'exécution it2bis-it2ter, fiche L22a) : module PUR (ni « node: » ni process, aucun import), partagé avec l'interface.
//
// Q7 : le montant d'arrêt est saisi à la main à chaque activation ; le cockpit n'en impose ni n'en préremplit aucun. Ce module ne
// porte donc AUCUNE valeur par défaut ni constante de plafond de coût. La borne haute (`budget.autonomie.plafondMaxUsd`) et la
// décision du garde-fou budgétaire (`ledger.guardRuns`, calculée par l'appelant : aucune lecture du registre ici) sont des
// paramètres obligatoires. Fermé en cas de doute : une borne absente ou inutilisable refuse tout montant, un garde-fou qui ne
// répond pas exactement « ok » refuse.
//
// Montant accepté (vérifié par le serveur, jamais seulement par le navigateur) : chiffres ASCII, partie entière sans zéro de tête,
// puis au plus deux décimales après une virgule ou un point ; strictement positif. Refusés : signe, exposant, espace (y compris
// insécable, en tête, en fin ou entre les chiffres), séparateur de milliers, séparateur sans chiffre de part ou d'autre. Trois
// décimales sont refusées, jamais arrondies : « 1,234 » peut aussi se lire « mille deux cent trente-quatre ».
//
// Comparaisons en CENTIMES entiers, jamais en flottant : le montant saisi est lu chiffre à chiffre ; la borne (un nombre JSON des
// réglages) est lue dans sa forme décimale la plus courte (String), ses décimales au-delà de la deuxième écartées, ce qui revient à
// l'arrondir au centime inférieur. Un montant en centimes est au plus égal à la borne exactement quand il est au plus égal à
// cette borne tronquée.
//
// Ordre des refus (le premier l'emporte) : plafond-vide, plafond-invalide, plafond-hors-bornes, budget-mensuel. Les codes sont
// ceux de `OmoActivationRefusalCode` (T3a) ; leur égalité est vérifiée au train de V0 (plan §2.2).

/** Refus du plafond saisi, sous-ensemble de `OmoActivationRefusalCode` (T3a). */
export const OMO_CAP_REFUSAL_CODES = ["plafond-vide", "plafond-invalide", "plafond-hors-bornes", "budget-mensuel"] as const;

export type OmoCapRefusalCode = (typeof OMO_CAP_REFUSAL_CODES)[number];

/** Bornes du montant saisi, toutes obligatoires : aucune n'a de valeur par défaut. */
export interface PlafondBornes {
  /** `budget.autonomie.plafondMaxUsd` (USD), borne haute comprise. */
  plafondMaxUsd: number;
  /** Décision de `ledger.guardRuns` sur la demande : « refus » (ou toute autre valeur que « ok ») → `budget-mensuel`. */
  guardRuns: "ok" | "refus";
}

/** Montant retenu en centimes entiers, ou premier refus. */
export type PlafondValidation = { ok: true; cents: number } | { ok: false; code: OmoCapRefusalCode };

/** Valeur du champ de plafond à l'ouverture de l'écran d'activation. */
export interface PlafondPropose {
  /** Dernier montant saisi, tel quel ; chaîne vide s'il n'y en a pas. */
  valeur: string;
  /** Vrai si ce dernier montant dépasse la borne en vigueur (borne abaissée depuis) : proposé quand même, jamais remplacé. */
  horsBornes: boolean;
}

/** Montant saisi : partie entière sans zéro de tête, puis au plus deux décimales après une virgule ou un point. */
const MONTANT = /^(0|[1-9][0-9]*)(?:[.,]([0-9]{1,2}))?$/;

/** Forme décimale d'un nombre fini, positif ou nul, sans exposant, telle que String l'écrit. */
const BORNE = /^([0-9]+)(?:\.([0-9]+))?$/;

/** Centimes d'une partie entière et d'au plus deux décimales, chiffres ASCII seulement. */
function centimes(entier: string, decimales: string): number {
  return Number(entier) * 100 + Number(decimales.padEnd(2, "0"));
}

/** Montant saisi (texte tel quel et centimes), ou refus de forme. Une valeur autre qu'une chaîne (nombre JSON compris) est invalide. */
function lireMontant(saisie: unknown): { texte: string; cents: number } | { code: "plafond-vide" | "plafond-invalide" } {
  if (typeof saisie !== "string") return { code: "plafond-invalide" };
  if (saisie.trim() === "") return { code: "plafond-vide" };
  const m = MONTANT.exec(saisie);
  if (!m) return { code: "plafond-invalide" };
  const cents = centimes(m[1] ?? "", m[2] ?? "");
  // Nul (« 0 », « 0,00 ») : le montant doit être strictement positif.
  if (cents <= 0) return { code: "plafond-invalide" };
  return { texte: saisie, cents };
}

/**
 * Borne en centimes, tronquée au centime ; null si elle n'est pas un nombre, ou si sa forme décimale est inutilisable : NaN,
 * infinie, négative, écrite avec un exposant (au-dessous d'un millionième ou au-delà de 1e21), ou trop grande pour des centimes
 * entiers exacts. Une borne nulle, ou sous le centime, vaut zéro centime : aucun montant n'y tient.
 */
function lireBorne(plafondMaxUsd: unknown): number | null {
  if (typeof plafondMaxUsd !== "number") return null;
  const m = BORNE.exec(String(plafondMaxUsd));
  if (!m) return null;
  const cents = centimes(m[1] ?? "", (m[2] ?? "").slice(0, 2));
  return Number.isSafeInteger(cents) ? cents : null;
}

/**
 * Vérifie le montant saisi à l'activation de la salle (§4.8.2 l.729) : forme, borne `plafondMaxUsd` comprise, puis garde-fou
 * budgétaire. Un montant refusé ne lance rien (409 + phrase, L22c).
 */
export function validatePlafond(saisie: string, bornes: PlafondBornes): PlafondValidation {
  const montant = lireMontant(saisie);
  if ("code" in montant) return { ok: false, code: montant.code };
  const max = lireBorne(bornes.plafondMaxUsd);
  if (max === null || montant.cents > max) return { ok: false, code: "plafond-hors-bornes" };
  if (bornes.guardRuns !== "ok") return { ok: false, code: "budget-mensuel" };
  return { ok: true, cents: montant.cents };
}

/**
 * Valeur proposée dans le champ (§4.8.2 l.722, l.730) : vide la première fois (`dernier` null), sinon le dernier montant saisi,
 * tel quel, marqué hors bornes si la borne a baissé depuis ou n'est plus utilisable. Le cockpit ne choisit jamais un montant à
 * la place de l'utilisateur : un dernier montant illisible (réglage altéré) donne un champ vide, jamais une autre valeur.
 */
export function proposePlafond(dernier: string | null, plafondMaxUsd: number): PlafondPropose {
  const montant = lireMontant(dernier);
  if ("code" in montant) return { valeur: "", horsBornes: false };
  const max = lireBorne(plafondMaxUsd);
  return { valeur: montant.texte, horsBornes: max === null || montant.cents > max };
}
