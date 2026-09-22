// Propriétaire : L39b.
// « Comprendre en 1 minute » (conception C §9.9 ; plan d'exécution it4, fiche L39b) : carte d'accueil de l'onglet Carte,
// REFERMABLE UNE FOIS. [J'ai compris] écrit `carte` dans `ui.seenOnboarding` (PUT /api/settings, même mécanisme que le premier
// bandeau de « Qui travaille ? ») : elle ne revient plus. Tant que l'enregistrement n'a pas abouti, la carte reste refermée pour
// cette visite et rien d'autre ne change.
// Les quatre phrases (dont la phrase d'accueil, §2.2) viennent de agent-map-texts.ts (T4t) : aucun texte écrit ici.
import { useState } from "react";
import { TEXTES } from "../../../../server/shared/agent-map-texts.ts";
import { useApp } from "../../../app/AppContext.tsx";
import { seenOnboardingWith } from "../../../lib/useActivity.ts";

/** Identifiant de `ui.seenOnboarding` de la carte des assistants (règle des identifiants : ^[a-z0-9-]{1,40}$). */
export const CARTE_ONBOARDING_KEY = "carte";

const C = TEXTES.partout.comprendre;

export function CarteComprendre({ titleId }: { titleId: string }) {
  const { ui, saveUi } = useApp();
  const [referme, setReferme] = useState(false);
  if (referme || ui.seenOnboarding.includes(CARTE_ONBOARDING_KEY)) return null;

  const fermer = () => {
    setReferme(true);
    saveUi({ seenOnboarding: seenOnboardingWith(ui.seenOnboarding, CARTE_ONBOARDING_KEY) }).catch((err: unknown) => {
      // Non enregistrée : la carte d'accueil reviendra à la prochaine visite, rien d'autre ne change.
      console.warn("carte des assistants : accueil non enregistré", err);
    });
  };

  return (
    <section className="ca-comprendre callout" aria-labelledby={titleId}>
      <h2 id={titleId} className="ca-comprendre-titre">
        {C.titre}
      </h2>
      <ul className="ca-comprendre-liste">
        {C.phrases.map((phrase) => (
          <li key={phrase}>{phrase}</li>
        ))}
      </ul>
      <p className="ca-comprendre-actions">
        <button type="button" className="btn" onClick={fermer}>
          {C.compris}
        </button>
      </p>
    </section>
  );
}
