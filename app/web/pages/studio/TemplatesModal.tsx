// Galerie d'exemples prêts à l'emploi pour démarrer un agent, une commande ou un skill.
import { TIER_HELP, TIER_LABELS } from "../../../server/shared/assistant-rules.ts";
import { Button, EmptyState, Modal, Spinner, useAsync } from "../../components/ui.tsx";
import { api, errorText } from "../../lib/api.ts";
import type { StudioKind, StudioTemplate } from "../../lib/types.ts";
import { KIND_LABELS, str } from "./shared.ts";

const MODE_LABEL: Record<string, string> = { primary: "principal", subagent: "sous-agent", all: "tous modes" };

export function TemplatesModal({
  open,
  kind,
  onClose,
  onUse,
}: {
  open: boolean;
  kind: StudioKind;
  onClose: () => void;
  onUse: (template: StudioTemplate) => void;
}) {
  const templates = useAsync(() => (open ? api.templates() : Promise.resolve([] as StudioTemplate[])), [open]);
  const list = (templates.data ?? []).filter((t) => t.kind === kind);

  return (
    <Modal open={open} wide title={KIND_LABELS[kind].examples} onClose={onClose}>
      {templates.loading && !templates.data?.length ? (
        <div className="empty">
          <Spinner large />
        </div>
      ) : templates.error ? (
        <div className="callout critical" role="alert">
          {errorText(templates.error)}
        </div>
      ) : list.length === 0 ? (
        <EmptyState icon="layers" title="Aucun exemple pour ce type" />
      ) : (
        <div className="stack">
          <p className="small muted">
            L'exemple pré-remplit un nouvel élément, avec l'IA de son niveau conseillé : rien n'est écrit tant que vous n'enregistrez pas.
          </p>
          <div className="template-grid">
            {list.map((t) => {
              const fm = t.frontmatter;
              return (
                <article key={t.name} className="template-card">
                  <div className="stack tight" style={{ gap: 2 }}>
                    <h3 style={{ fontSize: 14 }}>{t.title}</h3>
                    <span className="mono tiny muted">{t.name}</span>
                  </div>
                  <p className="small secondary">{str(fm.description)}</p>
                  <div className="row wrap" style={{ gap: 4 }}>
                    {t.tier ? (
                      <span className="badge good" title={TIER_HELP[t.tier]}>
                        Niveau conseillé : {TIER_LABELS[t.tier]}
                      </span>
                    ) : null}
                    {str(fm.mode) ? <span className="badge accent">{MODE_LABEL[str(fm.mode)] ?? str(fm.mode)}</span> : null}
                    {fm.subtask === true ? <span className="badge">travail délégué</span> : null}
                    {str(fm.agent) ? <span className="badge">@{str(fm.agent)}</span> : null}
                  </div>
                  <details>
                    <summary>Aperçu du contenu</summary>
                    <pre className="template-preview mono">{t.body}</pre>
                  </details>
                  <div style={{ marginTop: "auto" }}>
                    <Button size="sm" variant="primary" icon="plus" onClick={() => onUse(t)}>
                      Utiliser
                    </Button>
                  </div>
                </article>
              );
            })}
          </div>
        </div>
      )}
    </Modal>
  );
}
