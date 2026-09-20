// Propriétaire : L44d.
// Bibliothèque des méthodes (itération 5, plan d'exécution it5 fiche L44d ; conception C §9.8, §9.13 ; recherche RM §5.6 ;
// spécification §5.4 l.910, §5.5, §5.6) : une carte par méthode, les méthodes conseillées assistant par assistant, et l'ajout
// d'une méthode aux consignes d'un assistant.
//
// L'ajout passe par `PUT /api/assistants/:name` avec le brouillon COMPLET de l'assistant plus la méthode : la route recontrôle
// tout (limites, méthode inconnue, méthode non attachable) et écrit le bloc dans le FICHIER d'agent, qui fait foi (D-5-07).
// Elle est derrière la garde de rechargement : sur 409, `useReloadGuard` affiche la carte existante, et rien n'est écrit tant
// que la confirmation n'est pas donnée.
//
// Honnêteté : une méthode est du TEXTE ajouté aux consignes, aucun appel d'IA en plus, et elle ne garantit pas que la réponse
// est juste (phrase de l'état vide, spécification l.910). Rien n'est jamais attaché automatiquement.
import { useState } from "react";
import { RIGHTS_INFO, USE_CASE_INFO } from "../../../../server/shared/assistant-rules.ts";
import { TEXTES } from "../../../../server/shared/construction-texts.ts";
import { methodMenuState, suggestionsByAssistant, withMethod } from "../../../../server/shared/methods-view.ts";
import { Icon } from "../../../components/Icon.tsx";
import { useToast } from "../../../components/Toast.tsx";
import { useReloadGuard } from "../../../components/reloadGuard.ts";
import { Button, EmptyState, Spinner, useConfirm } from "../../../components/ui.tsx";
import { api, errorText } from "../../../lib/api.ts";
import type { AssistantSaveRequest, AssistantView, MethodsResponse, MethodView } from "../../../lib/types.ts";
import { MethodCard, SuggestionButton } from "./MethodCard.tsx";
import "./methods.css";

const M = TEXTES.partout.methodes;

/**
 * Brouillon COMPLET d'un assistant installé, plus la méthode : ce que `PUT /api/assistants/:name` attend. Chaque champ est
 * repris de l'assistant tel qu'il est lu aujourd'hui — rien n'est deviné — pour que l'ajout d'une méthode ne modifie que ses
 * méthodes. `previousName` est son nom actuel : l'enregistrement n'est pas un renommage.
 */
export function requestWithMethod(view: AssistantView, method: Pick<MethodView, "id">): AssistantSaveRequest {
  const useCase = view.useCase ?? "autre";
  const request: AssistantSaveRequest = {
    title: view.title,
    description: view.description,
    useCase,
    // « Personnalisé » n'est pas un profil enregistrable : la confirmation ci-dessous le dit avant d'envoyer.
    rights: view.rights === "propose" ? "propose" : "lecture",
    web: view.web,
    tier: view.tier,
    reflection: view.variant === "high" ? "poussee" : "standard",
    taskSize: view.taskSize,
    instructions: view.instructions,
    fiches: [...view.fiches],
    examples: [...view.examples],
    icon: view.icon ?? USE_CASE_INFO[useCase].icon,
    methods: withMethod({ methods: view.methods }, method),
    previousName: view.name,
  };
  if (view.tier === null) request.model = view.model;
  return request;
}

export interface MethodsLibraryProps {
  /** Catalogue rendu par GET /api/methods ; null tant qu'il n'est pas lu. */
  catalogue: MethodsResponse | null;
  erreur: unknown;
  chargement: boolean;
  onReessayer: () => void;
  /** Assistants du cockpit (GET /api/assistants) ; null tant qu'ils ne sont pas lus. */
  assistants: readonly AssistantView[] | null;
  /** Relecture des assistants et du catalogue après un ajout accepté. */
  onChanged: () => void;
  avance: boolean;
}

export function MethodsLibrary({ catalogue, erreur, chargement, onReessayer, assistants, onChanged, avance }: MethodsLibraryProps) {
  const toast = useToast();
  const confirm = useConfirm();
  const guardReload = useReloadGuard();
  const [busy, setBusy] = useState(false);

  const ajouter = async (assistant: AssistantView, method: MethodView) => {
    if (busy) return;
    if (assistant.rights === "personnalise") {
      const ok = await confirm({
        title: `Ajouter la méthode « ${method.titre} » à « ${assistant.title} » ?`,
        message: `Droits actuels : ${RIGHTS_INFO.personnalise.label} (réglés dans le Studio). Enregistrer une méthode ici les remplace par « ${RIGHTS_INFO.lecture.label} ». Pour choisir vous-même le profil, passez par « Modifier ».`,
        confirmLabel: M.carte.ajouter,
      });
      if (!ok) return;
    }
    setBusy(true);
    try {
      await guardReload((options) => api.saveAssistant(assistant.name, requestWithMethod(assistant, method), options));
      toast.success("Méthode ajoutée", `« ${method.titre} » s'ajoute maintenant aux consignes de « ${assistant.title} ».`);
      onChanged();
    } catch (err) {
      toast.error("Ajout impossible", err);
    } finally {
      setBusy(false);
    }
  };

  if (erreur && !catalogue) {
    return (
      <div className="callout critical" role="alert">
        <Icon name="alert" size={18} />
        <span className="spacer">{errorText(erreur)}</span>
        <Button size="sm" icon="refresh" onClick={onReessayer}>
          Réessayer
        </Button>
      </div>
    );
  }
  if (!catalogue) return chargement ? <Spinner /> : null;
  if (catalogue.methods.length === 0) {
    return (
      <div className="card">
        <EmptyState icon="book" title="Aucune méthode">
          {M.vide}
        </EmptyState>
      </div>
    );
  }

  const limites = { parAssistant: catalogue.limites.parAssistant };
  const groupes = suggestionsByAssistant(catalogue.methods);
  const parNom = new Map((assistants ?? []).map((assistant) => [assistant.name, assistant]));
  const parId = new Map(catalogue.methods.map((method) => [method.id, method]));

  return (
    <div className="stack loose met-library">
      <p className="small secondary">{M.vide}</p>

      {groupes.length > 0 ? (
        <div className="card met-conseils">
          <h3>{M.carte.conseillees}</h3>
          <div className="stack tight">
            {groupes.map((groupe) => {
              const assistant = parNom.get(groupe.assistant.name) ?? null;
              return (
                <div key={groupe.assistant.name} className="met-conseil-row">
                  <span className="met-conseil-nom">
                    <Icon name="bot" size={14} />
                    {groupe.assistant.title}
                  </span>
                  <span className="met-conseil-methodes">
                    {groupe.methodes.map((suggestion) => {
                      const method = parId.get(suggestion.id);
                      const etat = assistant
                        ? methodMenuState({ name: assistant.name, title: assistant.title, methods: assistant.methods }, suggestion, limites)
                        : { active: false, raison: null, code: null };
                      return (
                        <SuggestionButton
                          key={suggestion.id}
                          libelle={suggestion.titre}
                          raison={etat.raison}
                          busy={busy || !assistant || !etat.active}
                          onAjouter={() => {
                            if (assistant && method) void ajouter(assistant, method);
                          }}
                        />
                      );
                    })}
                  </span>
                </div>
              );
            })}
          </div>
        </div>
      ) : null}

      <div className="met-grid">
        {catalogue.methods.map((method) => (
          <MethodCard
            key={method.id}
            method={method}
            limites={limites}
            assistants={assistants}
            busy={busy}
            onAjouter={(assistant, choisie) => void ajouter(assistant, choisie)}
            avance={avance}
          />
        ))}
      </div>
    </div>
  );
}
