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
import { RIGHTS_INFO } from "../../../../server/shared/assistant-rules.ts";
import { TEXTES } from "../../../../server/shared/construction-texts.ts";
import { methodMenuState, suggestionsByAssistant, texteIaRemplacee } from "../../../../server/shared/methods-view.ts";
import { useApp } from "../../../app/AppContext.tsx";
import { Icon } from "../../../components/Icon.tsx";
import { useToast } from "../../../components/Toast.tsx";
import { useReloadGuard } from "../../../components/reloadGuard.ts";
import { Button, EmptyState, Spinner, useConfirm } from "../../../components/ui.tsx";
import { api, errorText } from "../../../lib/api.ts";
import type { AssistantView, MethodsResponse, MethodView } from "../../../lib/types.ts";
import { modelSubstitution, requestWithMethod } from "./assistant-request.ts";
import { MethodCard, SuggestionButton } from "./MethodCard.tsx";
import "./methods.css";

const M = TEXTES.partout.methodes;

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
  const { boot } = useApp();
  const toast = useToast();
  const confirm = useConfirm();
  const guardReload = useReloadGuard();
  const [busy, setBusy] = useState(false);
  // Niveaux d'IA rendus par `GET /api/boot` : ils servent à retrouver le niveau d'un assistant à IA précise, que le mode Simple
  // ne peut pas réenregistrer tel quel (`tierOfView`).
  const tiers = boot.ai?.tiers ?? [];

  const ajouter = async (assistant: AssistantView, method: MethodView) => {
    if (busy) return;
    // L'ajout réenregistre le brouillon COMPLET : il peut remplacer les droits « personnalisé » et, en mode Simple, l'IA
    // précise de l'assistant. Chaque conséquence est annoncée avant l'envoi, dans un SEUL dialogue : deux dialogues de suite
    // se liraient l'un après l'autre, et le second passerait pour une répétition du premier.
    const avertissements: string[] = [];
    if (assistant.rights === "personnalise") {
      avertissements.push(
        `Droits actuels : ${RIGHTS_INFO.personnalise.label} (réglés dans le Studio). Enregistrer une méthode ici les remplace par « ${RIGHTS_INFO.lecture.label} ». Pour choisir vous-même le profil, passez par « Modifier ».`,
      );
    }
    const substitution = texteIaRemplacee(modelSubstitution(assistant, { avance, tiers }));
    if (substitution !== null) avertissements.push(substitution);
    if (avertissements.length > 0) {
      const ok = await confirm({
        title: `Ajouter la méthode « ${method.titre} » à « ${assistant.title} » ?`,
        message: avertissements.join(" "),
        confirmLabel: M.carte.ajouter,
      });
      if (!ok) return;
    }
    setBusy(true);
    try {
      await guardReload((options) => api.saveAssistant(assistant.name, requestWithMethod(assistant, method, { avance, tiers }), options));
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
