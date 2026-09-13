// Cartes de la page Assistants : assistant installé et assistant intégré (Assistant général, Conseiller).
import type { CSSProperties } from "react";
import { MESSAGES, RIGHTS_INFO, TIER_LABELS, USE_CASE_INFO } from "../../../server/shared/assistant-rules.ts";
import { Icon } from "../../components/Icon.tsx";
import { Badge, Button, IconButton, type Tone } from "../../components/ui.tsx";
import type { AssistantState, AssistantView, BuiltinAssistantView, UpdateItem } from "../../lib/types.ts";
import { switchLabel } from "./realign.tsx";

const STATE_BADGES: Readonly<Record<Exclude<AssistantState, "ok">, { tone: Tone; label: string; help: string }>> = {
  "mise-a-jour": { tone: "accent", label: "Mise à jour disponible", help: "Le niveau de cet assistant utilise maintenant une autre IA." },
  "ia-indisponible": { tone: "critical", label: "IA indisponible", help: "L'IA de cet assistant n'est plus proposée par votre compte Copilot." },
  "modifie-hors-cockpit": { tone: "warning", label: "Modifié hors du cockpit", help: "L'IA de son fichier a été changée en dehors du cockpit." },
};

/** « IA : Claude Sonnet 5 (Équilibré) · ≈ 0,18 $ par demande · Fiches : 2 » */
export function assistantSummary(view: AssistantView): string {
  const level = view.tier ? TIER_LABELS[view.tier] : "IA précise";
  const parts = [`IA : ${view.modelName ?? view.model ?? "celle du chat"} (${level})`];
  if (view.estimate) parts.push(view.estimate.text);
  parts.push(`Fiches : ${view.fiches.length}`);
  return parts.join(" · ");
}

export function AssistantCard({
  view,
  busy = false,
  onUse,
  onDetail,
  onEdit,
  onDelete,
  onSwitch,
}: {
  view: AssistantView;
  busy?: boolean;
  onUse: () => void;
  onDetail: () => void;
  onEdit: () => void;
  onDelete: () => void;
  onSwitch: (update: UpdateItem) => void;
}) {
  const color = view.useCase ? USE_CASE_INFO[view.useCase].color : "var(--border-strong)";
  const icon = view.icon ?? (view.useCase ? USE_CASE_INFO[view.useCase].icon : "sparkle");
  const state = view.state === "ok" ? null : STATE_BADGES[view.state];
  return (
    <article className="ast-card" style={{ "--ast-color": color } as CSSProperties}>
      <div className="ast-card-head">
        <span className="ast-icon" aria-hidden>
          <Icon name={icon} size={16} />
        </span>
        <h3 className="spacer">{view.title}</h3>
        <Badge tone={view.rights === "personnalise" ? "critical" : "neutral"} title={RIGHTS_INFO[view.rights].help}>
          {RIGHTS_INFO[view.rights].label}
        </Badge>
      </div>
      <p className="small secondary ast-desc">{view.description}</p>
      <p className="small">{assistantSummary(view)}</p>
      {state || view.origin === "catalogue" || view.expensive ? (
        <div className="row wrap" style={{ gap: 6 }}>
          {state ? (
            <Badge tone={state.tone} title={state.help}>
              {state.label}
            </Badge>
          ) : null}
          {view.origin === "catalogue" ? <Badge tone="warning">{MESSAGES.catalogueReview}</Badge> : null}
          {view.expensive ? (
            <Badge tone="warning" title={view.guardNote ?? undefined}>
              IA chère
            </Badge>
          ) : null}
        </div>
      ) : null}
      {view.state === "ia-indisponible" ? (
        <div className="callout critical ast-callout" role="alert">
          <Icon name="alert" size={16} />
          <div className="stack tight" style={{ minWidth: 0 }}>
            <span>L'IA de cet assistant (« {view.modelName ?? view.model ?? "?"} ») n'est plus disponible sur votre compte Copilot.</span>
            <div className="row wrap" style={{ gap: 6 }}>
              {view.update ? (
                <Button size="sm" variant="primary" disabled={busy} onClick={() => view.update && onSwitch(view.update)}>
                  {switchLabel(view.update)}
                </Button>
              ) : null}
              <Button size="sm" onClick={onDetail}>
                Ouvrir l'assistant
              </Button>
            </div>
          </div>
        </div>
      ) : null}
      <div className="ast-card-actions">
        <Button size="sm" variant="primary" icon="chat" onClick={onUse}>
          Utiliser dans le chat
        </Button>
        <Button size="sm" icon="eye" onClick={onDetail}>
          Détail
        </Button>
        <Button size="sm" icon="edit" onClick={onEdit}>
          Modifier
        </Button>
        <span className="spacer" />
        <IconButton icon="trash" size="sm" label={`Supprimer « ${view.title} »`} disabled={busy} onClick={onDelete} />
      </div>
    </article>
  );
}

export function BuiltinCard({ item, onUse, onDetail }: { item: BuiltinAssistantView; onUse: () => void; onDetail: () => void }) {
  return (
    <article className="ast-card ast-builtin">
      <div className="ast-card-head">
        <span className="ast-icon" aria-hidden>
          <Icon name={item.name === "plan" ? "eye" : "chat"} size={16} />
        </span>
        <h3 className="spacer">{item.title}</h3>
        <Badge>Intégré</Badge>
      </div>
      <p className="small secondary ast-desc">{item.help}</p>
      <p className="small">
        IA : {item.modelName ?? item.model ?? "—"} (niveau {TIER_LABELS[item.tier]} de la conversation)
        {item.estimate ? ` · ${item.estimate.text}` : ""}
      </p>
      <div className="ast-card-actions">
        <Button size="sm" variant="primary" icon="chat" onClick={onUse}>
          Utiliser dans le chat
        </Button>
        <Button size="sm" icon="eye" onClick={onDetail}>
          Détail
        </Button>
      </div>
    </article>
  );
}
