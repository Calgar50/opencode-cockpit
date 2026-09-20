// Propriétaire : L44d (corrections de la relecture de 5a V2).
// Corps de `PUT /api/assistants/:name` envoyé par « Ajouter à un assistant » (bibliothèque des méthodes, C §9.8) : module PUR,
// sans React, pour qu'un test puisse rejouer le corps exact que la page envoie.
//
// L'ajout d'une méthode réenregistre le brouillon COMPLET de l'assistant (D-5-07) : la route recontrôle tout et écrit le bloc
// dans le FICHIER d'agent, qui fait foi. Chaque champ est donc repris de l'assistant tel qu'il est lu aujourd'hui — rien n'est
// deviné — pour que l'ajout ne modifie que ses méthodes.
//
// Le niveau d'IA passe par `tierOfView` (assistant-rules.ts), la MÊME conversion que l'assistant de création : sans elle, un
// assistant à IA précise (`tier` null, `model` renseigné) repris en mode Simple partirait avec son IA précise, que la route
// refuse hors du mode Avancé — l'ajout échouait alors en 422 « Contenu invalide. ».
import { tierOfView, USE_CASE_INFO } from "../../../../server/shared/assistant-rules.ts";
import { type ModelSubstitution, withMethod } from "../../../../server/shared/methods-view.ts";
import type { AssistantSaveRequest, AssistantView, MethodView, TierView } from "../../../lib/types.ts";

/** Ce que la page connaît du mode d'affichage et des niveaux d'IA au moment de l'ajout. */
export interface AssistantRequestContext {
  /** Mode Avancé (Paramètres › Affichage) : seul mode où une IA précise s'enregistre. */
  avance: boolean;
  /** Niveaux d'IA rendus par `GET /api/boot` : ils servent à retrouver le niveau d'une IA précise. */
  tiers: readonly TierView[];
}

/** Niveau d'IA réduit à ce que la conversion et l'annonce lisent : un `TierView` entier convient partout. */
export type TierBrief = Pick<TierView, "id" | "label" | "model" | "modelName">;

/** Aucun remplacement : une seule valeur, pour que l'appelant compare sans se demander d'où vient chaque champ. */
const AUCUNE: ModelSubstitution = Object.freeze({ remplacee: false, actuelle: null, nouvelle: null, niveau: null });

/**
 * Ce que l'ajout d'une méthode ferait à l'IA de l'assistant. En mode Simple, un assistant à IA précise ne peut pas être
 * renvoyé tel quel : `tierOfView` retombe sur un niveau, dont l'IA n'est pas forcément la sienne. Son IA change alors — donc
 * son coût et sa façon de répondre — au cours d'une action qui ne devait toucher que ses méthodes. La page le DIT avant
 * d'envoyer (MethodsLibrary).
 *
 * Rien n'est décidé ici : cette fonction ne sert qu'à annoncer, et `requestWithMethod` reste seul à construire le corps.
 */
export function modelSubstitution(
  view: Pick<AssistantView, "tier" | "model" | "modelName">,
  contexte: { avance: boolean; tiers: readonly TierBrief[] },
): ModelSubstitution {
  if (view.tier !== null || !view.model) return AUCUNE;
  const tier = tierOfView(view, contexte.avance, contexte.tiers);
  // null = IA précise conservée (mode Avancé) : le corps renvoie `model`, rien ne change.
  if (tier === null) return AUCUNE;
  const cible = contexte.tiers.find((niveau) => niveau.id === tier) ?? null;
  if (cible === null || cible.model === view.model) return AUCUNE;
  return {
    remplacee: true,
    actuelle: view.modelName ?? view.model,
    nouvelle: cible.modelName ?? cible.model,
    niveau: cible.label,
  };
}

/** Brouillon COMPLET d'un assistant installé, plus la méthode : ce que `PUT /api/assistants/:name` attend. */
export function requestWithMethod(view: AssistantView, method: Pick<MethodView, "id">, contexte: AssistantRequestContext): AssistantSaveRequest {
  const useCase = view.useCase ?? "autre";
  const tier = tierOfView(view, contexte.avance, contexte.tiers);
  const request: AssistantSaveRequest = {
    title: view.title,
    description: view.description,
    useCase,
    // « Personnalisé » n'est pas un profil enregistrable : la confirmation de la page le dit avant d'envoyer.
    rights: view.rights === "propose" ? "propose" : "lecture",
    web: view.web,
    tier,
    reflection: view.variant === "high" ? "poussee" : "standard",
    taskSize: view.taskSize,
    instructions: view.instructions,
    fiches: [...view.fiches],
    examples: [...view.examples],
    icon: view.icon ?? USE_CASE_INFO[useCase].icon,
    methods: withMethod({ methods: view.methods }, method),
    previousName: view.name,
  };
  // `tier === null` veut dire « IA précise conservée » : elle n'est envoyée que là, et le mode Avancé l'a déjà permise.
  if (tier === null) request.model = view.model;
  return request;
}
