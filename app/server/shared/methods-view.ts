// Propriétaire : L44d.
// Modèle pur des vues « méthodes » côté assistants (itération 5, plan d'exécution it5 fiche L44d ; conception C §9.8, §9.13 ;
// recherche RM §5.6 ; spécification §5.4 l.910, §5.5, §5.6) : état d'une entrée du menu « Ajouter à un assistant », état d'une
// case de l'assistant de création, regroupement des méthodes conseillées par assistant, phrases des cartes et titre du groupe
// « Assistants des équipes ({n}) » de la page Assistants.
//
// Aucun texte n'est écrit ici : toutes les phrases viennent de construction-texts.ts (T5a), remplies par gabarit « {nom} ».
// Aucune limite n'est recopiée : elles viennent de construction-constants.ts, par METHOD_VIEW_LIMITS ou par les limites rendues
// avec le catalogue (GET /api/methods), que l'appelant passe telles quelles.
//
// Ce module ne décide RIEN de ce qui est écrit : l'attachement d'une méthode est fait par PUT /api/assistants/:name, qui
// recontrôle tout côté serveur (assistants.ts, `methodDraftProblem`). Ce qui est calculé ici ne sert qu'à montrer d'avance,
// à côté de chaque entrée, POURQUOI elle ne se choisit pas — jamais à autoriser quoi que ce soit.
import { METHODS_PER_ASSISTANT } from "./construction-constants.ts";
import { TEXTES } from "./construction-texts.ts";
import type { AssistantRef, MethodView } from "./construction-types.ts";

const M = TEXTES.partout.methodes;

/** Remplit un gabarit « {nom} » ; un nom absent des valeurs garde son gabarit (jamais de trou silencieux). */
function remplir(gabarit: string, valeurs: Readonly<Record<string, string>>): string {
  return gabarit.replace(/\{(\w+)\}/g, (match: string, nom: string) => (Object.hasOwn(valeurs, nom) ? String(valeurs[nom]) : match));
}

/** Séparateur des listes d'assistants et de méthodes affichées sur une ligne. */
const SEPARATEUR = " · ";

// --- Limites ------------------------------------------------------------------------------------------------------------------

/** Limites lues par ces vues ; `parAssistant` vient de construction-constants.ts, jamais d'un nombre écrit dans un composant. */
export interface MethodViewLimits {
  parAssistant: number;
}

export const METHOD_VIEW_LIMITS: Readonly<MethodViewLimits> = Object.freeze({ parAssistant: METHODS_PER_ASSISTANT });

// --- Menu « Ajouter à un assistant » --------------------------------------------------------------------------------------------

/** Code de refus d'une entrée : « deja » (le fichier de l'assistant porte déjà cette méthode) ou « trop » (limite atteinte). */
export type MethodRefusal = "deja" | "trop";

/**
 * État d'une entrée : `active` false → l'entrée reste focalisable (APG) et porte SA raison, jamais une phrase générale.
 * `raison` est null quand l'entrée est utilisable.
 */
export interface MethodMenuState {
  active: boolean;
  raison: string | null;
  code: MethodRefusal | null;
}

/** Assistant du cockpit vu par le menu : `methods` = identifiants lus dans son FICHIER d'agent (D-5-07), absent = aucune. */
export interface MethodMenuAssistant {
  name: string;
  title: string;
  methods?: readonly string[];
}

/**
 * Une méthode s'ajoute aux consignes d'un assistant seulement si c'est un bloc de texte : « seconde-lecture » (kind
 * « relecture ») est un AUTRE assistant qui relit, demandé réponse par réponse depuis le chat, jamais un bloc à attacher.
 */
export function methodAttachable(method: Pick<MethodView, "kind">): boolean {
  return method.kind === "consigne";
}

/**
 * État de l'entrée « {assistant} » du menu d'une méthode. « Déjà appliquée » passe AVANT la limite : un assistant qui porte
 * déjà la méthode et qui est plein doit lire la vraie raison, sinon la limite cacherait que la méthode est en place.
 */
export function methodMenuState(
  assistant: MethodMenuAssistant,
  method: Pick<MethodView, "id">,
  limites: MethodViewLimits = METHOD_VIEW_LIMITS,
): MethodMenuState {
  const posees = assistant.methods ?? [];
  if (posees.includes(method.id)) return { active: false, raison: M.limites.deja, code: "deja" };
  if (posees.length >= limites.parAssistant) return { active: false, raison: M.limites.trop, code: "trop" };
  return { active: true, raison: null, code: null };
}

/** Brouillon d'assistant, réduit à ce que ces vues lisent (l'assistant de création passe son `draft`). */
export interface MethodDraft {
  methods?: readonly string[];
}

/** Méthodes du brouillon, la méthode ajoutée à la fin : corps envoyé par PUT /api/assistants/:name (brouillon COMPLET). */
export function withMethod(draft: MethodDraft, method: Pick<MethodView, "id">): string[] {
  const posees = draft.methods ?? [];
  return posees.includes(method.id) ? [...posees] : [...posees, method.id];
}

// --- Assistant de création -------------------------------------------------------------------------------------------------------

/** État d'une case « Méthodes (facultatif) » : rien n'est jamais pré-coché (C §16 n° 5, D-5-07). */
export interface WizardMethodState {
  cochee: boolean;
  /** false : case désactivée (limite atteinte) ; une case cochée reste toujours décochable. */
  active: boolean;
  raison: string | null;
  code: MethodRefusal | null;
  /** Badge « Conseillée pour cet assistant » : la méthode conseille l'assistant en cours de modification. */
  conseillee: boolean;
}

/** Contexte de l'assistant de création : nom de l'assistant modifié (null à la création) et limites en vigueur. */
export interface WizardMethodContext {
  assistant?: string | null;
  limites?: MethodViewLimits;
}

/**
 * État de la case d'une méthode dans l'écran « Consignes et fiches ». Au-delà de la limite, les cases NON cochées sont
 * désactivées avec le message ; les cases cochées restent utilisables, sans quoi on ne pourrait plus en retirer une.
 */
export function wizardMethodState(
  draft: MethodDraft,
  method: Pick<MethodView, "id" | "conseilleePour">,
  contexte: WizardMethodContext = {},
): WizardMethodState {
  const choisies = draft.methods ?? [];
  const limites = contexte.limites ?? METHOD_VIEW_LIMITS;
  const cochee = choisies.includes(method.id);
  const plein = !cochee && choisies.length >= limites.parAssistant;
  const assistant = contexte.assistant ?? null;
  return {
    cochee,
    active: !plein,
    raison: plein ? M.limites.trop : null,
    code: plein ? "trop" : null,
    conseillee: assistant !== null && method.conseilleePour.some((entree) => entree.name === assistant),
  };
}

// --- « Méthodes conseillées », par assistant installé -----------------------------------------------------------------------------

/** Méthode conseillée à un assistant ; `attachee` : son fichier la porte déjà. */
export interface SuggestedMethod {
  id: string;
  titre: string;
  attachee: boolean;
}

/** Un assistant du catalogue installé et les méthodes que le catalogue lui conseille, dans l'ordre du catalogue. */
export interface SuggestionGroup {
  assistant: AssistantRef;
  methodes: SuggestedMethod[];
}

/**
 * Inverse `conseilleePour` : une entrée par assistant installé, dans l'ordre de première apparition, avec ses méthodes dans
 * l'ordre du catalogue. Les méthodes non attachables (« relecture ») sont écartées : elles n'ont pas de bouton « Ajouter ».
 * Un assistant sans aucune méthode conseillée n'apparaît pas.
 */
export function suggestionsByAssistant(methods: readonly MethodView[]): SuggestionGroup[] {
  const groupes = new Map<string, SuggestionGroup>();
  for (const method of methods) {
    if (!methodAttachable(method)) continue;
    for (const entree of method.conseilleePour) {
      const groupe = groupes.get(entree.name) ?? { assistant: { name: entree.name, title: entree.title }, methodes: [] };
      groupe.methodes.push({ id: method.id, titre: method.titre, attachee: entree.attachee });
      groupes.set(entree.name, groupe);
    }
  }
  return [...groupes.values()];
}

// --- Phrases des cartes et de la fiche d'identité -----------------------------------------------------------------------------------

/** « Quand : {quand} ». */
export function texteQuand(method: Pick<MethodView, "quand">): string {
  return remplir(M.carte.quand, { quand: method.quand });
}

/** « Attention : {attention} ». */
export function texteAttention(method: Pick<MethodView, "attention">): string {
  return remplir(M.carte.attention, { attention: method.attention });
}

/** « Utilisée par : {assistants} » ; null quand aucun assistant ne l'applique (la ligne n'est alors pas affichée). */
export function texteUtiliseePar(assistants: readonly AssistantRef[]): string | null {
  if (assistants.length === 0) return null;
  return remplir(M.carte.utiliseePar, { assistants: assistants.map((a) => a.title).join(SEPARATEUR) });
}

/** Titre du groupe « Assistants des équipes ({n}) » de la page Assistants (assistants d'équipe de L45a, plan it5 §4.3). */
export function texteAssistantsEquipe(nombre: number): string {
  return remplir(TEXTES.partout.assistantsEquipe.titre, { n: String(nombre) });
}

/** « Méthodes : {liste} » de la fiche d'identité ; null sans méthode (la ligne et sa phrase fixe sont alors absentes). */
export function texteFicheMethodes(titres: readonly string[]): string | null {
  if (titres.length === 0) return null;
  return remplir(M.fiche.liste, { liste: titres.join(SEPARATEUR) });
}

/**
 * Libellés des méthodes d'un assistant, dans l'ordre de son fichier : le titre du catalogue quand il est connu, sinon
 * l'identifiant tel qu'il est écrit dans le fichier — jamais un titre inventé, jamais une méthode passée sous silence.
 */
export function methodLabels(ids: readonly string[] | undefined, catalogue: readonly Pick<MethodView, "id" | "titre">[] | null): string[] {
  return (ids ?? []).map((id) => catalogue?.find((method) => method.id === id)?.titre ?? id);
}

/**
 * Adresse cliquable d'une source (mode Avancé), ou null : seul « https:// » est rendu en lien. Une source arrive ici par une
 * réponse HTTP ; sans cette garde, « javascript: » deviendrait un lien exécutable dans la page. Une source refusée reste
 * affichée en texte, échappée comme tout le reste : rien n'est caché.
 */
export function sourceHref(source: string): string | null {
  return source.startsWith("https://") && !/[\s<>"]/.test(source) ? source : null;
}
