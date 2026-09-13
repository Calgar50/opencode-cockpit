// Page Assistants (§9.3) : mes assistants, à compléter, mises à jour, fichiers introuvables, intégrés et prêts à l'emploi.
// Sous-routes : #/assistants/nouveau, /modifier/<nom>, /completer/<nom> (assistant de création), /detail/<nom> (fenêtre).
import { type ReactNode, useCallback, useEffect, useId, useRef, useState } from "react";
import { MESSAGES } from "../../server/shared/assistant-rules.ts";
import { useApp } from "../app/AppContext.tsx";
import { Icon } from "../components/Icon.tsx";
import { useToast } from "../components/Toast.tsx";
import { Badge, Button, EmptyState, Modal, Spinner, useAsync, useConfirm } from "../components/ui.tsx";
import { ApiError, api, errorText } from "../lib/api.ts";
import { cockpitEvent, useEvents } from "../lib/events.ts";
import { assistantsViewOf, openAssistants, openChatWithAssistant, useRoute } from "../lib/router.ts";
import type { AssistantView, MissingItem, ToCompleteItem, UsedByError } from "../lib/types.ts";
import { AdoptDialog } from "./assistants/AdoptDialog.tsx";
import { AssistantCard, BuiltinCard } from "./assistants/AssistantCard.tsx";
import { AssistantWizard } from "./assistants/AssistantWizard.tsx";
import { CatalogueGrid } from "./assistants/CatalogueGrid.tsx";
import { IdentityCard, identityOfBuiltin, identityOfView } from "./assistants/IdentityCard.tsx";
import { useRealign } from "./assistants/realign.tsx";
import "./assistants/assistants.css";

export function AssistantsPage() {
  const route = useRoute();
  const view = assistantsViewOf(route);
  if (view.mode === "nouveau") return <AssistantWizard key="nouveau" mode="nouveau" name={null} />;
  if (view.mode === "modifier" || view.mode === "completer") {
    const mode = view.mode === "modifier" ? "modifier" : "completer";
    return <AssistantWizard key={`${mode}/${view.name}`} mode={mode} name={view.name} />;
  }
  return <AssistantsList detail={view.mode === "detail" ? view.name : null} />;
}

function Section({ title, count, subtitle, actions, children }: { title: string; count?: number; subtitle?: string; actions?: ReactNode; children: ReactNode }) {
  const id = useId();
  return (
    <section className="ast-section" aria-labelledby={id}>
      <div className="ast-section-head">
        <h2 id={id}>
          {title}
          {count !== undefined ? <span className="ast-count"> ({count})</span> : null}
        </h2>
        {actions ? (
          <>
            <span className="spacer" />
            {actions}
          </>
        ) : null}
      </div>
      {subtitle ? <p className="small secondary">{subtitle}</p> : null}
      {children}
    </section>
  );
}

const usedByText = (command: string) => `Le raccourci /${command} utilise cet assistant : il ne fonctionnera plus.`;

function AssistantsList({ detail }: { detail: string | null }) {
  const { advanced } = useApp();
  const toast = useToast();
  const confirm = useConfirm();
  const data = useAsync(() => api.assistants(), []);
  const catalogue = useAsync(() => api.assistantsCatalogue(), []);
  const reloadRef = useRef<() => void>(() => undefined);
  reloadRef.current = () => {
    data.reload();
    catalogue.reload();
  };
  const reloadAll = useCallback(() => reloadRef.current(), []);
  const timer = useRef<number | undefined>(undefined);
  const realign = useRealign(reloadAll);
  const [adopting, setAdopting] = useState<ToCompleteItem | null>(null);
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const closeAdopt = useCallback(() => setAdopting(null), []);
  const closeDetail = useCallback(() => openAssistants(), []);

  useEffect(() => () => window.clearTimeout(timer.current), []);
  useEvents((event) => {
    if (cockpitEvent(event, "studio.changed", "ai.changed", "opencode.config.changed")) {
      window.clearTimeout(timer.current);
      timer.current = window.setTimeout(reloadAll, 400);
    }
  });

  const remove = async (view: AssistantView) => {
    const ask = (extra: readonly string[]) =>
      confirm({
        title: `Supprimer l'assistant « ${view.title} » ?`,
        message: (
          <div className="stack tight">
            <p className="secondary">Il disparaîtra du chat. Les conversations passées restent dans les Archives et ses fiches ne sont pas supprimées.</p>
            {extra.map((text) => (
              <p key={text} className="field-error">
                {text}
              </p>
            ))}
          </div>
        ),
        confirmLabel: "Supprimer",
        danger: true,
      });
    if (!(await ask(view.usedBy.map(usedByText)))) return;
    setBusyKey(view.name);
    try {
      try {
        await api.deleteAssistant(view.name, view.usedBy.length > 0);
      } catch (err) {
        // Un raccourci s'est mis à l'utiliser entre-temps : redemander avec le message du serveur.
        const used = err instanceof ApiError && err.code === "used-by" ? (err.data as UsedByError | null) : null;
        if (!used) throw err;
        if (!(await ask([used.message]))) return;
        await api.deleteAssistant(view.name, true);
      }
      toast.success("Assistant supprimé", `« ${view.title} » n'apparaît plus dans le chat.`);
      if (detail === view.name) openAssistants();
      reloadAll();
    } catch (err) {
      toast.error("Suppression impossible", err);
    } finally {
      setBusyKey(null);
    }
  };

  const removeMissing = async (item: MissingItem) => {
    const key = `meta:${item.kind}/${item.name}`;
    setBusyKey(key);
    try {
      await api.deleteAssistantMeta(item.name, item.kind);
      toast.success("Retiré de la liste", `« ${item.title ?? item.name} » n'apparaît plus.`);
      reloadAll();
    } catch (err) {
      toast.error("Retrait impossible", err);
    } finally {
      setBusyKey(null);
    }
  };

  const res = data.data;
  const detailView = detail && res ? (res.assistants.find((a) => a.name === detail) ?? null) : null;
  const detailBuiltin = detail && res && !detailView ? (res.builtins.find((b) => b.name === detail) ?? null) : null;
  const createButton = (
    <Button variant="primary" icon="plus" onClick={() => openAssistants({ mode: "nouveau" })}>
      Créer un assistant
    </Button>
  );

  return (
    <div className="page">
      <div className="page-narrow stack loose">
        <header className="page-header" style={{ marginBottom: 0 }}>
          <div className="spacer" style={{ minWidth: 0 }}>
            <h1>Assistants</h1>
            <p>Un assistant fait une tâche précise, avec des droits limités et une IA adaptée.</p>
          </div>
          {createButton}
        </header>

        {data.error && !res ? (
          <div className="callout critical" role="alert">
            <Icon name="alert" size={18} />
            <span className="spacer">{errorText(data.error)}</span>
            <Button size="sm" icon="refresh" onClick={data.reload}>
              Réessayer
            </Button>
          </div>
        ) : null}

        <Section title="Mes assistants" count={res?.assistants.length}>
          {!res ? (
            data.loading ? (
              <Spinner />
            ) : null
          ) : res.assistants.length === 0 ? (
            <div className="card">
              <EmptyState icon="sparkle" title="Aucun assistant pour l'instant" action={createButton}>
                Installez un assistant prêt à l'emploi ou créez le vôtre en 5 étapes.
              </EmptyState>
            </div>
          ) : (
            <div className="ast-grid">
              {res.assistants.map((view) => (
                <AssistantCard
                  key={view.name}
                  view={view}
                  busy={busyKey === view.name || realign.busy}
                  onUse={() => openChatWithAssistant(view.name)}
                  onDetail={() => openAssistants({ mode: "detail", name: view.name })}
                  onEdit={() => openAssistants({ mode: "modifier", name: view.name })}
                  onDelete={() => void remove(view)}
                  onSwitch={(update) => void realign.run([update])}
                />
              ))}
            </div>
          )}
        </Section>

        {res && res.toComplete.length > 0 ? (
          <Section title="À compléter" count={res.toComplete.length}>
            <div className="ast-rows card flush">
              {res.toComplete.map((item) => (
                <div key={item.name} className="ast-row">
                  <Icon name="edit" size={16} />
                  <div className="spacer stack tight" style={{ gap: 2 }}>
                    <span>« {item.name} » a été créé avant la version 0.2.</span>
                    <span className="small muted">
                      IA : {item.modelName ?? item.model ?? "celle choisie dans le chat"}
                      {item.description ? ` · ${item.description}` : ""}
                    </span>
                  </div>
                  <Button size="sm" onClick={() => setAdopting(item)}>
                    Compléter
                  </Button>
                </div>
              ))}
            </div>
          </Section>
        ) : null}

        {res && res.updates.length > 0 ? (
          <Section
            title="Mise à jour disponible"
            count={res.updates.length}
            actions={
              res.updates.length > 1 ? (
                <Button size="sm" variant="primary" icon="refresh" disabled={realign.busy} onClick={() => void realign.run(res.updates)}>
                  Tout mettre à jour
                </Button>
              ) : null
            }
          >
            <div className="ast-rows card flush">
              {res.updates.map((item) => (
                <div key={`${item.kind}/${item.name}`} className="ast-row">
                  <Icon name="refresh" size={16} />
                  <span className="spacer">
                    « {item.title} » : {item.fromName ?? item.from ?? "—"} → {item.toName}
                  </span>
                  <Button size="sm" disabled={realign.busy} onClick={() => void realign.run([item])}>
                    Mettre à jour
                  </Button>
                </div>
              ))}
            </div>
          </Section>
        ) : null}

        {res && res.missing.length > 0 ? (
          <Section title="Fichier introuvable" count={res.missing.length}>
            <div className="ast-rows card flush">
              {res.missing.map((item) => {
                const key = `meta:${item.kind}/${item.name}`;
                return (
                  <div key={key} className="ast-row">
                    <Icon name="file" size={16} />
                    <div className="spacer stack tight" style={{ gap: 2 }}>
                      <span>« {item.title ?? item.name} »</span>
                      <span className="small muted">
                        {item.kind === "commands" ? `Raccourci /${item.name}` : `Assistant ${item.name}`} : son fichier n'existe plus.
                      </span>
                    </div>
                    <Button size="sm" variant="ghost" loading={busyKey === key} onClick={() => void removeMissing(item)}>
                      Retirer de la liste
                    </Button>
                  </div>
                );
              })}
            </div>
          </Section>
        ) : null}

        {res && res.builtins.length > 0 ? (
          <Section title="Assistants intégrés">
            <div className="ast-grid">
              {res.builtins.map((item) => (
                <BuiltinCard
                  key={item.name}
                  item={item}
                  onUse={() => openChatWithAssistant(item.name)}
                  onDetail={() => openAssistants({ mode: "detail", name: item.name })}
                />
              ))}
            </div>
          </Section>
        ) : null}

        <Section title="Prêts à l'emploi" subtitle="Des exemples à installer en un clic, puis à relire avec votre équipe.">
          {catalogue.error && !catalogue.data ? (
            <div className="callout critical" role="alert">
              <Icon name="alert" size={18} />
              <span className="spacer">{errorText(catalogue.error)}</span>
              <Button size="sm" icon="refresh" onClick={catalogue.reload}>
                Réessayer
              </Button>
            </div>
          ) : !catalogue.data ? (
            <Spinner />
          ) : catalogue.data.length === 0 ? (
            <p className="small muted">Aucun assistant prêt à l'emploi.</p>
          ) : (
            <CatalogueGrid items={catalogue.data} onChanged={reloadAll} />
          )}
        </Section>
      </div>

      <AdoptDialog item={adopting} onClose={closeAdopt} onDone={reloadAll} />

      <Modal
        open={detail !== null}
        wide
        title={detailView?.title ?? detailBuiltin?.title ?? "Assistant"}
        onClose={closeDetail}
        footer={
          detailView ? (
            <>
              <Button icon="edit" onClick={() => openAssistants({ mode: "modifier", name: detailView.name })}>
                Modifier
              </Button>
              <Button variant="primary" icon="chat" onClick={() => openChatWithAssistant(detailView.name)}>
                Utiliser dans le chat
              </Button>
            </>
          ) : detailBuiltin ? (
            <Button variant="primary" icon="chat" onClick={() => openChatWithAssistant(detailBuiltin.name)}>
              Utiliser dans le chat
            </Button>
          ) : (
            <Button onClick={closeDetail}>Fermer</Button>
          )
        }
      >
        {!res ? (
          data.loading ? (
            <Spinner />
          ) : (
            <p className="secondary">{data.error ? errorText(data.error) : "Assistant introuvable."}</p>
          )
        ) : detailView ? (
          <div className="stack">
            <IdentityCard data={identityOfView(detailView, detailView.origin === "catalogue" ? MESSAGES.catalogueReview : null)} />
            {advanced ? (
              <p className="tiny muted">
                <Badge>{detailView.name}</Badge>
                {" "}
                <span className="mono">{detailView.file}</span>
              </p>
            ) : null}
          </div>
        ) : detailBuiltin ? (
          <IdentityCard data={identityOfBuiltin(detailBuiltin)} />
        ) : (
          <p className="secondary">Assistant introuvable : « {detail} » n'existe plus.</p>
        )}
      </Modal>
    </div>
  );
}
