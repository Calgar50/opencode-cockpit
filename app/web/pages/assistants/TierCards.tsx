// Choix du niveau d'IA (Rapide / Équilibré / Expert) avec le coût estimé « ≈ X $ par demande » à la taille choisie.
import { fallbackText, perRequestText, TIER_HELP, TIER_IDS, TIER_LABELS } from "../../../server/shared/assistant-rules.ts";
import { Icon } from "../../components/Icon.tsx";
import { Badge, type Tone } from "../../components/ui.tsx";
import type { TaskSize, Tier, TierStatus, TierView } from "../../lib/types.ts";

export const TIER_STATUS_TONE: Readonly<Record<TierStatus, Tone>> = Object.freeze({
  ok: "good",
  secours: "warning",
  indisponible: "critical",
  "non-verifie": "neutral",
});

/** Texte du niveau indisponible (même phrase que l'erreur 422 ia-indisponible du serveur). */
export function unavailableTierText(tier: Tier): string {
  return `Aucune IA de niveau ${TIER_LABELS[tier]} n'est disponible sur votre compte Copilot. Choisissez un autre niveau ou demandez l'accès à votre administrateur Copilot.`;
}

export function TierCards({
  value,
  onChange,
  size,
  tiers,
  recommended = "equilibre",
  label = "Niveau d'IA",
}: {
  value: Tier | null;
  onChange: (tier: Tier) => void;
  size: TaskSize;
  tiers: readonly TierView[];
  recommended?: Tier | null;
  label?: string;
}) {
  const byId = new Map(tiers.map((t) => [t.id, t]));
  return (
    <div className="tiercards" role="radiogroup" aria-label={label}>
      {TIER_IDS.map((id) => {
        const view = byId.get(id);
        const cost = view?.taskCost ? perRequestText(view.taskCost[size]) : null;
        const selected = value === id;
        return (
          <button key={id} type="button" role="radio" aria-checked={selected} className={`tiercard${selected ? " selected" : ""}`} onClick={() => onChange(id)}>
            <span className="row between wrap" style={{ gap: 6 }}>
              <strong>{TIER_LABELS[id]}</strong>
              {id === recommended ? <Badge tone="accent">Recommandé</Badge> : null}
            </span>
            <span className="small secondary">{TIER_HELP[id]}</span>
            <span className="tiercard-cost tabular">{cost ?? "Coût inconnu"}</span>
            {view && view.status !== "ok" ? (
              <span>
                <Badge tone={TIER_STATUS_TONE[view.status]} title={view.statusHelp ?? undefined}>
                  {view.statusLabel}
                </Badge>
              </span>
            ) : null}
          </button>
        );
      })}
    </div>
  );
}

/** Ligne sous la carte choisie : IA correspondante, IA de secours, niveau indisponible ou non vérifié. */
export function TierSelectionNote({ tier, view }: { tier: Tier; view: TierView | undefined }) {
  if (!view) return null;
  if (view.status === "indisponible") {
    return (
      <div className="callout critical" role="alert">
        <Icon name="alert" size={18} />
        <span>{unavailableTierText(tier)}</span>
      </div>
    );
  }
  const name = view.modelName ?? view.model ?? "—";
  return (
    <div className="stack tight">
      <p className="small">
        IA correspondante sur votre compte : <strong>{name}</strong>.
      </p>
      {view.status === "secours" ? (
        <p className="small tier-note-warning">
          {view.fallbackText ?? (view.plannedName ? fallbackText(view.plannedName, name) : "IA de secours utilisée.")}
        </p>
      ) : null}
      {view.status === "non-verifie" ? <p className="small muted">{view.statusHelp ?? view.statusLabel}</p> : null}
    </div>
  );
}
