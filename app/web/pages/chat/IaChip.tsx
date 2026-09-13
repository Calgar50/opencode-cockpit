// IA d'une demande dans le compositeur : puce « IA : … », niveaux Rapide / Équilibré / Expert, Réflexion,
// coût « ≈ X $ par demande » et problèmes bloquants (rien n'est envoyé).
import { useEffect, useState } from "react";
import { formatUsd, MESSAGES, parseModelKey, TIER_HELP, VARIANT_HELP, variantOptionLabel } from "../../../server/shared/assistant-rules.ts";
import { Icon } from "../../components/Icon.tsx";
import { Badge, Button } from "../../components/ui.tsx";
import { api } from "../../lib/api.ts";
import type { ModelInfo, Problem, ResolveResponse, TaskSize, Tier, TierView, UpdateItem } from "../../lib/types.ts";
import { ModelPicker } from "./ModelPicker.tsx";

function tierTitle(t: TierView): string {
  return [t.help || TIER_HELP[t.id], t.fallbackText, t.statusHelp].filter(Boolean).join(" ");
}

export function IaControls({
  turn,
  agentHasModel,
  advanced,
  allowOverride,
  tiers,
  tier,
  onTierChange,
  models,
  override,
  onOverrideChange,
  variant,
  onVariantChange,
  size,
}: {
  /** Tour affiché (avec le raccourci tapé, s'il y en a un). */
  turn: ResolveResponse;
  /** L'assistant du chat a sa propre IA (fixée). */
  agentHasModel: boolean;
  advanced: boolean;
  /** Mode Avancé + « Autoriser à changer l'IA d'un assistant pour un message ». */
  allowOverride: boolean;
  tiers: TierView[];
  tier: Tier;
  onTierChange: (tier: Tier) => void;
  /** IA proposées dans « Autre IA… » (fournisseurs autorisés). */
  models: ModelInfo[];
  override: string | null;
  onOverrideChange: (model: string | null) => void;
  /** undefined : réflexion du niveau. */
  variant: string | null | undefined;
  onVariantChange: (variant: string | null) => void;
  size: TaskSize;
}) {
  const d = turn.display;
  const commandImposes = Boolean(turn.command) && (d.delegated || turn.lock?.kind === "raccourci" || turn.lock?.kind === "assistant-delegue");
  const showLevels = tiers.length > 0 && !agentHasModel && !commandImposes;
  const sendModel = models.find((m) => m.key === `${turn.send.model.providerID}/${turn.send.model.modelID}`);
  const levelVariant = override ? null : (tiers.find((t) => t.id === tier)?.variant ?? null);
  const current = variant === undefined ? levelVariant : variant;
  const variants = sendModel?.variants ?? [];
  const showVariant = !d.locked && !d.delegated && variants.length > 0;
  const canOverride = advanced && !commandImposes && !override && (agentHasModel ? allowOverride : true);
  const warnings = d.problems.filter((p) => !p.blocking);

  return (
    <div className="ia-controls">
      {showLevels ? (
        <div className="tier-toggle" role="group" aria-label="Niveau d'IA">
          {tiers.map((t) => (
            <button key={t.id} type="button" aria-pressed={!override && t.id === tier} title={tierTitle(t)} onClick={() => onTierChange(t.id)}>
              <span className="tier-name">{t.label}</span>
              <span className="tier-cost">{t.status === "indisponible" ? t.statusLabel : (t.estimateText ?? t.statusLabel)}</span>
            </button>
          ))}
        </div>
      ) : null}
      <div className="row wrap ia-line">
        <span
          className={`chip ia-chip${d.locked ? " locked" : ""}${d.delegated ? " delegated" : ""}`}
          title={d.chipTooltip ?? d.delegatedHelp ?? undefined}
        >
          <Icon name={d.locked ? "lock" : d.delegated ? "users" : "sparkle"} size={12} />
          <span>{d.chip || "IA : —"}</span>
        </span>
        {d.fallbackBadge ? (
          <Badge tone="warning" title={d.fallbackText ?? undefined}>
            {d.fallbackBadge}
          </Badge>
        ) : null}
        {showVariant ? (
          <select
            className="select sm"
            style={{ width: "auto" }}
            value={current ?? ""}
            aria-label="Réflexion"
            title={VARIANT_HELP}
            onChange={(e) => onVariantChange(e.target.value || null)}
          >
            <option value="">{variantOptionLabel(null, advanced)}</option>
            {current && !variants.includes(current) ? <option value={current}>{variantOptionLabel(current, advanced)}</option> : null}
            {variants.map((v) => (
              <option key={v} value={v}>
                {variantOptionLabel(v, advanced)}
              </option>
            ))}
          </select>
        ) : null}
        <EstimateChip turn={turn} size={size} />
        {canOverride ? (
          <ModelPicker
            models={models}
            value={override}
            onChange={(key) => onOverrideChange(key)}
            label={agentHasModel ? "Autre IA pour ce message…" : "Autre IA…"}
            title={agentHasModel ? "Utiliser une autre IA pour le prochain message seulement (mode Avancé)" : "Choisir une IA précise (mode Avancé)"}
          />
        ) : null}
        {override ? (
          <Button size="sm" variant="ghost" icon="x" onClick={() => onOverrideChange(null)}>
            {agentHasModel ? "Garder l'IA de l'assistant" : "Revenir au niveau"}
          </Button>
        ) : null}
      </div>
      {d.delegated && d.delegatedHelp ? <p className="tiny muted ia-help">{d.delegatedHelp}</p> : null}
      {warnings.length > 0 ? (
        <p className="tiny ia-warning">
          <Icon name="alert" size={12} /> {[...new Set(warnings.map((p) => p.message))].join(" ")}
        </p>
      ) : null}
    </div>
  );
}

/** « ≈ 0,18 $ par demande » : moyenne observée de l'assistant si disponible, sinon profil ; repère du garde-fou. */
function EstimateChip({ turn, size }: { turn: ResolveResponse; size: TaskSize }) {
  const d = turn.display;
  const main = d.runs.find((r) => r.role === "message" || r.role === "raccourci");
  const billed = [...new Set(d.runs.map((r) => r.model))];
  const key = `${billed.join(",")}|${main?.model ?? ""}|${main?.agent ?? ""}|${size}`;
  const [state, setState] = useState<{ key: string; text: string | null; detail: string | null; guarded: boolean } | null>(null);

  useEffect(() => {
    if (billed.length === 0) return;
    let cancelled = false;
    void Promise.all(
      billed.map((model) => {
        const ref = parseModelKey(model);
        const options = model === main?.model && main.agent ? { agent: main.agent, size } : { size };
        return api.usageEstimate(ref.providerID, ref.modelID, options).then(
          (estimate) => ({ model, estimate }),
          () => null,
        );
      }),
    ).then((results) => {
      if (cancelled) return;
      const own = results.find((r) => r !== null && r.model === main?.model)?.estimate.estimate ?? null;
      setState({
        key,
        text: own?.text ?? null,
        detail: own?.detailText ?? null,
        guarded: results.some((r) => r !== null && r.estimate.guard && !r.estimate.guard.allowed),
      });
    });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  const fresh = state?.key === key ? state : null;
  const guardBadge = fresh?.guarded ? (
    <Badge tone="warning" title="Le garde-fou budgétaire demandera une confirmation avant l'envoi.">
      confirmation requise
    </Badge>
  ) : null;
  if (d.delegated) return guardBadge;
  const text = fresh?.text ?? d.estimateText;
  if (!text) return guardBadge;
  return (
    <span className="row tiny muted estimate-chip" title={fresh?.detail ? `${fresh.detail}. ${MESSAGES.estimateFootnote}` : MESSAGES.estimateFootnote}>
      {text}
      {guardBadge}
    </span>
  );
}

/** Problèmes bloquants du tour : rien ne sera envoyé. IA d'assistant disparue : [Passer à …] [Ouvrir l'assistant]. */
export function ProblemNotice({
  problems,
  update,
  onRealign,
  onOpenAssistants,
}: {
  problems: Array<Problem & { message: string }>;
  update: UpdateItem | null;
  onRealign: (item: UpdateItem) => Promise<void>;
  onOpenAssistants: () => void;
}) {
  const [busy, setBusy] = useState(false);
  if (problems.length === 0) return null;
  const assistantModelGone = problems.some((p) => p.code === "assistant-ia-indisponible");
  const costs = update && update.fromUsd !== null && update.toUsd !== null ? ` (≈ ${formatUsd(update.fromUsd)} → ${formatUsd(update.toUsd)} par demande)` : "";
  return (
    <div className="callout critical composer-notice" role="alert">
      <Icon name="alert" size={16} />
      <div className="stack tight spacer">
        {[...new Set(problems.map((p) => p.message))].map((message) => (
          <span key={message}>{message}</span>
        ))}
        {assistantModelGone ? (
          <div className="row wrap">
            {update ? (
              <Button
                size="sm"
                variant="primary"
                loading={busy}
                onClick={() => {
                  setBusy(true);
                  void onRealign(update).finally(() => setBusy(false));
                }}
              >
                Passer à {update.toName}
                {costs}
              </Button>
            ) : null}
            <Button size="sm" onClick={onOpenAssistants}>
              Ouvrir l'assistant
            </Button>
          </div>
        ) : null}
      </div>
    </div>
  );
}
