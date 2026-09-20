// Propriétaire : L38c.
// Paramètres › Budget, bloc « Équipes », mode Avancé SEULEMENT (spécification §3.6 l.276 ; D-eq-12, D-eq-13) : plafond maximum
// d'un lancement, étapes en même temps, équipes en cours en même temps. Réglages `teams.*`, hors SIMPLE_SETTINGS_PATHS : en mode
// Simple, le serveur refuse leur écriture (403 mode-avance) et BudgetTab ne rend pas ce bloc du tout (`{advanced ? … : null}`).
// Enregistrement par le PUT /api/settings EXISTANT (api.saveSettings, useSettingsSave), sans aucune route ni aucun schéma neufs :
// server/settings.ts n'est pas modifié par ce paquet. Bornes reprises de son schéma (maxCapUsd 0 à 1 000 ou vide, concurrentSteps
// 1 à 3, maxActiveRuns 1 à 5) : le serveur reste seul juge, l'interface ne fait que les annoncer.
// Textes : server/shared/team-texts.ts (T4t, `avance.reglages`) ; les libellés de structure (« Enregistrer », « Valeurs par
// défaut ») viennent de SectionFooter, comme dans les autres blocs de Paramètres. Propriétés figées dans ../chat/team/slots.ts.
import { useId } from "react";
import { TEXTES } from "../../../server/shared/team-texts.ts";
import { useApp } from "../../app/AppContext.tsx";
import { Card, Field } from "../../components/ui.tsx";
import { NumberInput } from "../studio/widgets.tsx";
import type { TeamsBudgetSettingsProps } from "../chat/team/slots.ts";
import { SectionFooter, useDraft, useReportDirty, useSettingsSave } from "./common.tsx";

const R = TEXTES.avance.reglages;

/** Bornes du schéma de server/settings.ts (`teams`), annoncées ici sans être redéfinies : le serveur valide, l'interface guide. */
const BORNES = {
  plafond: { min: 0, max: 1_000 },
  simultanees: { min: 1, max: 3 },
  equipesActives: { min: 1, max: 5 },
};

/** Valeur d'un champ entier : une saisie vide ou illisible garde la valeur courante, jamais un nombre inventé. */
const entier = (valeur: number | undefined, courant: number) => (valeur === undefined || !Number.isFinite(valeur) ? courant : valeur);

/** Messages des deux boutons du pied, écrits ici comme les autres blocs de Paramètres (BudgetTab, « Budget enregistré »). */
const ENREGISTRE = "Réglages des équipes enregistrés";
const REINITIALISE = "Réglages des équipes réinitialisés";

export function TeamsBudgetSettings(props: TeamsBudgetSettingsProps) {
  const { boot } = useApp();
  const { draft, setDraft, dirty, reset } = useDraft(boot.settings.teams);
  const { save, resetSection, saving, issues } = useSettingsSave();
  // Modifications non enregistrées remontées à l'onglet Budget, comme ChatTab, ClassifierTab et TiersTab : sans cela, changer
  // d'onglet ou fermer la fenêtre jetterait la saisie SANS la confirmation « Modifications non enregistrées ».
  useReportDirty(dirty, props.onDirty);
  const plafondId = useId();
  const simultaneesId = useId();
  const activesId = useId();

  return (
    <Card title={R.titre}>
      <div className="settings-form">
        <div className="grid-2">
          <Field label={R.plafondLibelle} htmlFor={plafondId} hint={R.plafondSuffixe}>
            <NumberInput
              id={plafondId}
              value={draft.maxCapUsd}
              min={BORNES.plafond.min}
              max={BORNES.plafond.max}
              step="any"
              // Champ vide : `null`, c'est-à-dire « 5 % du budget » calculé par le serveur, jamais un plafond écrit ici.
              onChange={(maxCapUsd) => setDraft({ ...draft, maxCapUsd: maxCapUsd === undefined ? null : maxCapUsd })}
            />
          </Field>
          <Field label={R.simultanees} htmlFor={simultaneesId} hint={R.simultaneesAide}>
            <NumberInput
              id={simultaneesId}
              value={draft.concurrentSteps}
              min={BORNES.simultanees.min}
              max={BORNES.simultanees.max}
              step={1}
              onChange={(n) => setDraft({ ...draft, concurrentSteps: entier(n, draft.concurrentSteps) })}
            />
          </Field>
          <Field label={R.equipesActives} htmlFor={activesId}>
            <NumberInput
              id={activesId}
              value={draft.maxActiveRuns}
              min={BORNES.equipesActives.min}
              max={BORNES.equipesActives.max}
              step={1}
              onChange={(n) => setDraft({ ...draft, maxActiveRuns: entier(n, draft.maxActiveRuns) })}
            />
          </Field>
        </div>
        <SectionFooter
          dirty={dirty}
          saving={saving}
          issues={issues}
          onCancel={reset}
          onSave={() => void save({ teams: draft }, ENREGISTRE)}
          onReset={async () => {
            await resetSection("teams", REINITIALISE);
          }}
        />
      </div>
    </Card>
  );
}
