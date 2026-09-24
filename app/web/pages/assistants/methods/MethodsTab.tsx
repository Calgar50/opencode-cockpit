// Propriétaire : L44f.
// Onglet « Méthodes » de la page Assistants (5b, L44f ; C §9.4) : la bibliothèque de L44d, sur la page à onglets de
// l'itération 4. Déplacé tel quel de AssistantsPage.tsx par la clôture de la 5b (décision A20, régularisation des balises) :
// dans la page, fichier partagé de classe A, ce composant de la construction portait des balises « équipes (it4) » À
// L'INTÉRIEUR d'une section c5:, parce que le contrat de l'itération 4 (web-equipes-slots.test.ts, T4w) n'admet la page à
// onglets qu'entre ces balises. Ici, dans un fichier propre à la construction, il n'a plus besoin d'aucune balise, et la page ne
// garde qu'un appel, dans sa section c5:. Aucun changement de comportement.
import { useCallback, useRef } from "react";
import { useAsync } from "../../../components/ui.tsx";
import { api } from "../../../lib/api.ts";
import { getMethods } from "../../../lib/api-construction.ts";
import { AssistantsTabsPage } from "../AssistantsTabs.tsx";
import { MethodsLibrary } from "./MethodsLibrary.tsx";

/**
 * Onglet « Méthodes » (L44f) : la bibliothèque de L44d, sur la page à onglets de l'itération 4. Elle lit le catalogue
 * (`GET /api/methods`) et les assistants (`GET /api/assistants`) pour elle-même : l'onglet est une page à part entière, et la
 * liste des assistants n'est plus montée quand on y arrive. Lecture seule, aucun appel d'IA, aucun coût.
 */
export function MethodsTab({ advanced }: { advanced: boolean }) {
  const assistants = useAsync(() => api.assistants(), []);
  const methodes = useAsync(() => getMethods(), []);
  const reloadRef = useRef<() => void>(() => undefined);
  reloadRef.current = () => {
    // « Utilisée par » et « déjà appliquée » se lisent dans les fichiers d'agent : les deux lectures vont de pair.
    assistants.reload();
    methodes.reload();
  };
  const onChanged = useCallback(() => reloadRef.current(), []);
  return (
    <AssistantsTabsPage current="methodes">
      <MethodsLibrary
        catalogue={methodes.data}
        erreur={methodes.error}
        chargement={methodes.loading}
        onReessayer={methodes.reload}
        assistants={assistants.data?.assistants ?? null}
        onChanged={onChanged}
        avance={advanced}
      />
    </AssistantsTabsPage>
  );
}
