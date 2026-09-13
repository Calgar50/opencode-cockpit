// Champs « IA » et « Réflexion » du Studio : aucune IA, un niveau d'IA (lié dans item_meta) ou une IA précise,
// chaque choix avec le coût estimé d'une demande.
import { type ReactNode, useId, useMemo, useState } from "react";
import {
  MESSAGES,
  modelName,
  perRequestText,
  providerOf,
  rangeText,
  TIER_IDS,
  TIER_LABELS,
  type Tier,
  VARIANT_HELP,
  variantLabel,
} from "../../../server/shared/assistant-rules.ts";
import { useApp } from "../../app/AppContext.tsx";
import { Button, Field } from "../../components/ui.tsx";
import type { ModelInfo, TierView } from "../../lib/types.ts";
import type { LevelBinding } from "./aiUsage.ts";
import { type Draft, str } from "./shared.ts";
import { ModelSelect } from "./widgets.tsx";

export type LevelChoice = "aucune" | Tier | "precise";

const DEFAULT_PROVIDERS = ["github-copilot"];

/** Change l'IA et retire la réflexion si la nouvelle IA ne la propose pas. */
export function modelPatch(key: string | null, draft: Draft, models: ModelInfo[]): Record<string, unknown> {
  const patch: Record<string, unknown> = { model: key ?? undefined };
  const variant = str(draft.frontmatter.variant);
  if (variant) {
    const next = models.find((m) => m.key === key);
    if (!next || !next.variants.includes(variant)) patch.variant = undefined;
  }
  return patch;
}

/** « ≈ 0,18 $ par demande » à la taille M, ou null sans prix. */
export function modelCostText(key: string | null | undefined, models: ModelInfo[]): string | null {
  const cost = key ? models.find((m) => m.key === key)?.taskCost?.M : undefined;
  return typeof cost === "number" ? perRequestText(cost) : null;
}

function joinParts(...parts: Array<string | null | undefined>): string {
  return parts.filter((p): p is string => Boolean(p)).join(" · ");
}

export function LevelField({
  label,
  hint,
  draft,
  models,
  setFm,
  level,
}: {
  label: string;
  hint: ReactNode;
  draft: Draft;
  models: ModelInfo[];
  setFm: (patch: Record<string, unknown>) => void;
  level: LevelBinding;
}) {
  const id = useId();
  const preciseId = useId();
  const { boot } = useApp();
  const [precise, setPrecise] = useState(false);
  const tiers: TierView[] = boot.ai?.tiers ?? [];
  const allowedProviders = boot.allowedProviders ?? DEFAULT_PROVIDERS;
  const selectable = useMemo(() => models.filter((m) => allowedProviders.includes(m.providerID)), [models, allowedProviders]);

  const model = str(draft.frontmatter.model);
  const choice: LevelChoice = model ? (level.tier ? level.tier : "precise") : precise ? "precise" : "aucune";
  const viewOf = (tier: Tier) => tiers.find((v) => v.id === tier);

  const levelCosts = tiers.map((v) => v.taskCost?.M).filter((n): n is number => typeof n === "number");
  const noneCost = levelCosts.length > 0 ? `${rangeText(Math.min(...levelCosts), Math.max(...levelCosts))} par demande selon le niveau` : null;

  const select = (next: LevelChoice) => {
    if (next === "aucune") {
      setPrecise(false);
      setFm(modelPatch(null, draft, models));
      if (level.tier) level.setTier(null);
      return;
    }
    if (next === "precise") {
      setPrecise(true);
      if (level.tier) level.setTier(null);
      return;
    }
    const view = viewOf(next);
    if (!view?.model) return;
    setPrecise(false);
    const patch = modelPatch(view.model, draft, models);
    if (view.variant) patch.variant = view.variant;
    setFm(patch);
    level.setTier(next);
  };

  // Contrôles repris de l'enregistrement (Studio côté serveur) pour les voir avant d'enregistrer.
  let error: string | null = null;
  if (model) {
    if (!allowedProviders.includes(providerOf(model))) error = MESSAGES.fournisseurRefuse;
    else if (models.length === 0) error = MESSAGES.catalogueIndisponible;
    else if (!models.some((m) => m.key === model)) error = MESSAGES.iaAbsenteDuCompte;
  }

  const notes: Array<{ key: string; text: string; action?: ReactNode }> = [];
  const boundView = choice !== "aucune" && choice !== "precise" ? viewOf(choice) : undefined;
  if (boundView) {
    const levelLabel = TIER_LABELS[boundView.id];
    if (!boundView.model) {
      notes.push({
        key: "indisponible",
        text: `Aucune IA de niveau ${levelLabel} n'est disponible sur votre compte Copilot. Choisissez un autre niveau ou demandez l'accès à votre administrateur Copilot.`,
      });
    } else if (boundView.model !== model) {
      const nextName = boundView.modelName ?? modelName(boundView.model);
      notes.push({
        key: "mise-a-jour",
        text: `Le niveau ${levelLabel} utilise maintenant ${nextName} : ce fichier utilise encore ${modelName(model, [])}.`,
        action: (
          <Button size="sm" onClick={() => select(boundView.id)}>
            Passer à {nextName}
          </Button>
        ),
      });
    } else if (boundView.fallbackText) {
      notes.push({ key: "secours", text: boundView.fallbackText });
    }
    if (!level.bindable) {
      notes.push({ key: "projet", text: "Portée projet : seule l'IA est écrite dans le fichier, le niveau n'est pas mémorisé." });
    }
  }
  if (choice === "precise" && model) {
    const current = models.find((m) => m.key === model)?.tier ?? null;
    if (current) {
      notes.push({
        key: "egal-niveau",
        text: `C'est l'IA actuelle du niveau ${TIER_LABELS[current]} : choisissez « Niveau ${TIER_LABELS[current]} » pour suivre ce niveau.`,
      });
    }
  }

  return (
    <Field label={label} htmlFor={id} hint={hint}>
      <select id={id} className="select" value={choice} onChange={(e) => select(e.target.value as LevelChoice)}>
        <option value="aucune">{joinParts("Aucune (IA choisie dans le chat)", noneCost)}</option>
        {TIER_IDS.map((tier) => {
          const view = viewOf(tier);
          return (
            <option key={tier} value={tier} disabled={!view?.model && choice !== tier}>
              {joinParts(
                `Niveau ${TIER_LABELS[tier]}`,
                view?.modelName ?? null,
                view && view.status !== "ok" ? view.statusLabel : null,
                view?.estimateText ?? modelCostText(view?.model, models),
              )}
            </option>
          );
        })}
        <option value="precise">{joinParts("IA précise…", choice === "precise" ? modelCostText(model, models) : null)}</option>
      </select>
      {choice === "precise" ? (
        <ModelSelect
          id={preciseId}
          ariaLabel="IA précise"
          value={model || null}
          models={selectable}
          emptyLabel="Choisir une IA…"
          showCost
          onChange={(key) => {
            setFm(modelPatch(key, draft, models));
            if (level.tier) level.setTier(null);
            setPrecise(true);
          }}
        />
      ) : null}
      {error ? <span className="field-error">{error}</span> : null}
      {notes.length > 0 ? (
        <div className="level-notes">
          {notes.map((note) => (
            <div key={note.key} className="level-note">
              <span className="spacer">{note.text}</span>
              {note.action}
            </div>
          ))}
        </div>
      ) : null}
    </Field>
  );
}

/** Libellé d'une option de réflexion en mode Avancé : « Réflexion poussée (high) ». */
export function variantOptionText(variant: string): string {
  const label = variantLabel(variant, true);
  return label.startsWith("Réglage particulier") ? label : `${label} (${variant})`;
}

/** Réflexion d'un agent ou d'un raccourci, proposée d'après l'IA qui l'exécutera (`modelKey`). */
export function VariantField({
  draft,
  models,
  setFm,
  modelKey,
  hint,
}: {
  draft: Draft;
  models: ModelInfo[];
  setFm: (patch: Record<string, unknown>) => void;
  modelKey: string | null;
  hint: string;
}) {
  const id = useId();
  const variant = str(draft.frontmatter.variant);
  const offered = (modelKey ? models.find((m) => m.key === modelKey)?.variants : undefined) ?? [];
  if (offered.length === 0 && !variant) return null;
  return (
    <Field label="Réflexion" htmlFor={id} hint={hint}>
      <select id={id} className="select" value={variant} title={VARIANT_HELP} onChange={(e) => setFm({ variant: e.target.value || undefined })}>
        <option value="">Réflexion standard</option>
        {variant && !offered.includes(variant) ? <option value={variant}>{variantOptionText(variant)} · non proposée par cette IA</option> : null}
        {offered.map((v) => (
          <option key={v} value={v}>
            {variantOptionText(v)}
          </option>
        ))}
      </select>
    </Field>
  );
}
