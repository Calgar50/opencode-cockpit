// Page Assistants (§9.3) : mes assistants, à compléter, mises à jour, fichiers introuvables, intégrés et prêts à l'emploi.
// Sous-routes : #/assistants/nouveau, /modifier/<nom>, /completer/<nom> (assistant de création), /detail/<nom> (fenêtre).
import { type ReactNode, useCallback, useEffect, useId, useRef, useState } from "react";
import { MESSAGES } from "../../server/shared/assistant-rules.ts";
// <c5:imports>
import { EQUIPIER_ROLE } from "../../server/shared/construction-constants.ts";
import { TEXTES as TEXTES_C5 } from "../../server/shared/construction-texts.ts";
import { methodLabels, texteAssistantsEquipe } from "../../server/shared/methods-view.ts";
import { getMethods } from "../lib/api-construction.ts";
import { assistantsTabHref } from "../lib/router.ts";
import { MethodsLibrary } from "./assistants/methods/MethodsLibrary.tsx";
// </c5:imports>
import { useApp } from "../app/AppContext.tsx";
import { Icon } from "../components/Icon.tsx";
import { useToast } from "../components/Toast.tsx";
import { useReloadGuard } from "../components/reloadGuard.ts";
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
// --- équipes (it4) : début ---
import { useRouteQuery } from "../lib/router.ts";
import { AssistantsTabs, AssistantsTabsPage } from "./assistants/AssistantsTabs.tsx";
import { CarteTab } from "./assistants/carte/CarteTab.tsx";
import { TeamEditor } from "./assistants/teams/TeamEditor.tsx";
import { TeamsTab } from "./assistants/teams/TeamsTab.tsx";
// --- équipes (it4) : fin ---

export function AssistantsPage() {
  const route = useRoute();
  // --- équipes (it4) : début ---
  // Onglets « Équipes » et « Carte » (page à onglets) ; éditeur d'équipe en pleine page, comme l'assistant de création.
  const { advanced, directory } = useApp();
  const teamView = assistantsViewOf(route, useRouteQuery());
  if (teamView.mode === "equipe-nouvelle") return <TeamEditor key="nouvelle" mode="nouvelle" id={null} advanced={advanced} />;
  if (teamView.mode === "equipe-modifier") {
    return <TeamEditor key={`modifier/${teamView.id}`} mode="modifier" id={teamView.id} advanced={advanced} />;
  }
  // <c5:onglet-methodes>
  // Itération 5 (L44f) : onglet « Méthodes » (#/assistants/methodes). Même page à onglets que l'itération 4 ; la bibliothèque
  // de L44d y vit désormais seule, et la section « Méthodes » de la liste plus bas n'en garde que le lien.
  if (teamView.mode === "methodes") return <MethodsTab advanced={advanced} />;
  // </c5:onglet-methodes>
  if (teamView.mode === "equipes" || teamView.mode === "carte") {
    return (
      <AssistantsTabsPage current={teamView.mode}>
        {teamView.mode === "equipes" ? (
          <TeamsTab advanced={advanced} />
        ) : (
          <CarteTab directory={directory} advanced={advanced} element={teamView.element} />
        )}
      </AssistantsTabsPage>
    );
  }
  // --- équipes (it4) : fin ---
  const view = assistantsViewOf(route);
  if (view.mode === "nouveau") return <AssistantWizard key="nouveau" mode="nouveau" name={null} />;
  if (view.mode === "modifier" || view.mode === "completer") {
    const mode = view.mode === "modifier" ? "modifier" : "completer";
    return <AssistantWizard key={`${mode}/${view.name}`} mode={mode} name={view.name} />;
  }
  return <AssistantsList detail={view.mode === "detail" ? view.name : null} />;
}

// <c5:onglet-methodes-vue>
/**
 * Onglet « Méthodes » (L44f) : la bibliothèque de L44d, sur la page à onglets de l'itération 4. Elle lit le catalogue
 * (`GET /api/methods`) et les assistants (`GET /api/assistants`) pour elle-même : l'onglet est une page à part entière, et la
 * liste des assistants n'est plus montée quand on y arrive. Lecture seule, aucun appel d'IA, aucun coût.
 */
function MethodsTab({ advanced }: { advanced: boolean }) {
  const assistants = useAsync(() => api.assistants(), []);
  const methodes = useAsync(() => getMethods(), []);
  const reloadRef = useRef<() => void>(() => undefined);
  reloadRef.current = () => {
    // « Utilisée par » et « déjà appliquée » se lisent dans les fichiers d'agent : les deux lectures vont de pair.
    assistants.reload();
    methodes.reload();
  };
  const onChanged = useCallback(() => reloadRef.current(), []);
  // --- équipes (it4) : début ---
  // Branchement de la construction SUR la page à onglets de l'itération 4, d'où les deux balises ici.
  const page = (
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
  // --- équipes (it4) : fin ---
  return page;
}
// </c5:onglet-methodes-vue>

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
  const guardReload = useReloadGuard();
  const data = useAsync(() => api.assistants(), []);
  const catalogue = useAsync(() => api.assistantsCatalogue(), []);
  // <c5:methodes-chargement>
  // Catalogue des méthodes (GET /api/methods, L44b), lu une fois pour toute la page : il sert à la bibliothèque et aux
  // libellés des méthodes de la fiche d'identité. Lecture seule, aucun appel d'IA, aucun coût.
  const methodes = useAsync(() => getMethods(), []);
  // </c5:methodes-chargement>
  const reloadRef = useRef<() => void>(() => undefined);
  reloadRef.current = () => {
    data.reload();
    catalogue.reload();
    // <c5:methodes-relecture>
    // « Utilisée par » et « déjà appliquée » sont lus dans les fichiers d'agent : ils changent dès qu'un assistant change.
    methodes.reload();
    // </c5:methodes-relecture>
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
        await guardReload((options) => api.deleteAssistant(view.name, view.usedBy.length > 0, options));
      } catch (err) {
        // Un raccourci s'est mis à l'utiliser entre-temps : redemander avec le message du serveur.
        const used = err instanceof ApiError && err.code === "used-by" ? (err.data as UsedByError | null) : null;
        if (!used) throw err;
        if (!(await ask([used.message]))) return;
        await guardReload((options) => api.deleteAssistant(view.name, true, options));
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
  // <c5:equipiers>
  // Assistants d'équipe (rôle « equipier », L45a) : ils ont leur propre groupe plus bas, avec sa phrase ; « Mes assistants »
  // ne les répète donc pas. Les trois expressions de ce groupe (nombre, état vide, grille) lisent `mesAssistants`.
  const equipiers = res ? res.assistants.filter((view) => view.role === EQUIPIER_ROLE) : [];
  const mesAssistants = res ? res.assistants.filter((view) => view.role !== EQUIPIER_ROLE) : [];
  /** Libellés des méthodes d'un assistant, pour sa fiche d'identité : titres du catalogue, sinon identifiants du fichier. */
  const libellesMethodes = (view: AssistantView) => methodLabels(view.methods, methodes.data?.methods ?? null);
  // </c5:equipiers>
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

        {/* --- équipes (it4) : début --- */}
        <AssistantsTabs current="assistants">
        {/* --- équipes (it4) : fin --- */}
        {data.error && !res ? (
          <div className="callout critical" role="alert">
            <Icon name="alert" size={18} />
            <span className="spacer">{errorText(data.error)}</span>
            <Button size="sm" icon="refresh" onClick={data.reload}>
              Réessayer
            </Button>
          </div>
        ) : null}

        {/* <c5:mes-assistants> */}
        {/* Bloc de l'itération 1, repris par la construction pour trois expressions seulement : le nombre, l'état vide et la
            grille lisent `mesAssistants` (assistants hors équipe) au lieu de tous les assistants. Le reste du bloc est celui de
            l'itération 1, inchangé ; la section est là pour que la grande fusion retrouve ces trois lignes. */}
        <Section title="Mes assistants" count={res ? mesAssistants.length : undefined}>
          {!res ? (
            data.loading ? (
              <Spinner />
            ) : null
          ) : mesAssistants.length === 0 ? (
            <div className="card">
              <EmptyState icon="sparkle" title="Aucun assistant pour l'instant" action={createButton}>
                Installez un assistant prêt à l'emploi ou créez le vôtre en 5 écrans.
              </EmptyState>
            </div>
          ) : (
            <div className="ast-grid">
              {mesAssistants.map((view) => (
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
        {/* </c5:mes-assistants> */}

        {/* <c5:equipiers-groupe> */}
        {equipiers.length > 0 ? (
          <Section title={texteAssistantsEquipe(equipiers.length)} subtitle={TEXTES_C5.partout.assistantsEquipe.phrase}>
            <div className="ast-grid">
              {equipiers.map((view) => (
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
          </Section>
        ) : null}
        {/* </c5:equipiers-groupe> */}

        {res && res.toComplete.length > 0 ? (
          <Section title="À compléter" count={res.toComplete.length}>
            <div className="ast-rows card flush">
              {res.toComplete.map((item) => (
                <div key={item.name} className="ast-row">
                  <Icon name="edit" size={16} />
                  <div className="spacer stack tight" style={{ gap: 2 }}>
                    <span>« {item.name} » a été créé avant la version 1.0.</span>
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

        {/* <c5:methodes-section> */}
        {/* Bibliothèque des méthodes (L44d), déplacée par L44f dans l'onglet « Méthodes » : la section n'en garde que le lien,
            à la même place qu'avant, pour que personne ne la cherche. Le catalogue reste lu par la page : la fiche d'identité
            d'un assistant en tire ses libellés de méthodes (`libellesMethodes`). */}
        <Section title="Méthodes" subtitle={TEXTES_C5.partout.methodes.fiche.phrase}>
          <p>
            <a className="btn ghost sm" href={assistantsTabHref("methodes")}>
              <Icon name="list" size={14} />
              Voir les méthodes
            </a>
          </p>
        </Section>
        {/* </c5:methodes-section> */}
        {/* --- équipes (it4) : début --- */}
        </AssistantsTabs>
        {/* --- équipes (it4) : fin --- */}
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
            {/* <c5:methodes-fiche> */}
            {/* La fiche d'identité de l'itération 1 tenait sur une ligne ; la construction y ajoute les méthodes, ce qui
                éclate l'élément sur plusieurs lignes. La section entoure donc tout l'élément, et pas la seule ligne
                `methods:`, pour que la grande fusion retrouve chacune des lignes changées. */}
            <IdentityCard
              data={{
                ...identityOfView(detailView, detailView.origin === "catalogue" ? MESSAGES.catalogueReview : null),
                methods: libellesMethodes(detailView),
              }}
            />
            {/* </c5:methodes-fiche> */}
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
