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
import { withMethod } from "../../../../server/shared/methods-view.ts";
import type { AssistantSaveRequest, AssistantView, MethodView, TierView } from "../../../lib/types.ts";

/** Ce que la page connaît du mode d'affichage et des niveaux d'IA au moment de l'ajout. */
export interface AssistantRequestContext {
  /** Mode Avancé (Paramètres › Affichage) : seul mode où une IA précise s'enregistre. */
  avance: boolean;
  /** Niveaux d'IA rendus par `GET /api/boot` : ils servent à retrouver le niveau d'une IA précise. */
  tiers: readonly TierView[];
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
