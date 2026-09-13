// Archives : fiche d'une conversation (classement, tags, résumé, statistiques, transcription).
import { type FormEvent, type ReactNode, useEffect, useId, useRef, useState } from "react";
import { useApp } from "../../app/AppContext.tsx";
import { Icon } from "../../components/Icon.tsx";
import { Markdown } from "../../components/Markdown.tsx";
import { useToast } from "../../components/Toast.tsx";
import { Button, Card, CategoryChip, EmptyState, IconButton, Spinner, useAsync, useConfirm } from "../../components/ui.tsx";
import { ApiError, api, errorText } from "../../lib/api.ts";
import { cockpitEvent, useEvents } from "../../lib/events.ts";
import { formatDateTime, formatInt, formatTokens, formatUsd, plural, relativeTime } from "../../lib/format.ts";
import { navigate, routeHref } from "../../lib/router.ts";
import type { Conversation, ModelInfo } from "../../lib/types.ts";
import { ClassificationBadge, classificationMethod, DeletedBadge, formatConfidence } from "./shared.tsx";

type Action = "title" | "category" | "tags" | "summary" | "pin" | "classify" | "refresh" | "delete";
type ArchivePatch = Parameters<typeof api.archivePatch>[1];

// Limites alignées sur la validation du serveur (PATCH /api/archive/:id).
const MAX_TITLE = 200;
const MAX_SUMMARY = 2_000;
const MAX_TAGS = 12;
const MAX_TAG_LENGTH = 32;
const FILES_PREVIEW = 12;
const LIVE_REFRESH_MS = 700;

function modelName(key: string, modelByKey: (key: string) => ModelInfo | undefined): string {
  const known = modelByKey(key);
  if (known) return known.name;
  const slash = key.indexOf("/");
  return slash > 0 ? key.slice(slash + 1) : key;
}

function BackLink() {
  return (
    <a className="btn ghost sm archive-back" href={routeHref("archives")}>
      <Icon name="chevronLeft" size={14} />
      Archives
    </a>
  );
}

export function ArchiveDetailView({ sessionId, onDeleted }: { sessionId: string; onDeleted: () => void }) {
  const { boot, categories, categoryById, modelByKey } = useApp();
  const toast = useToast();
  const confirm = useConfirm();
  const detail = useAsync(() => api.archiveGet(sessionId), [sessionId]);
  const [busy, setBusy] = useState<Action | null>(null);
  const [classifierError, setClassifierError] = useState<string | null>(null);
  const [showAllFiles, setShowAllFiles] = useState(false);
  const categoryFieldId = useId();
  const tagsLabelId = useId();

  const reload = useRef(detail.reload);
  reload.current = detail.reload;
  const liveTimer = useRef<number | undefined>(undefined);
  useEvents((event) => {
    const failure = cockpitEvent(event, "classifier.error");
    if (failure) {
      const data = failure.data as { sessionId?: unknown; error?: unknown } | null;
      if (data?.sessionId === sessionId && typeof data.error === "string") setClassifierError(data.error);
      return;
    }
    const change = cockpitEvent(event, "conversation.classified", "conversation.updated", "stream.reconnected");
    if (!change) return;
    if (change.type !== "stream.reconnected") {
      const data = change.data as { sessionId?: unknown; by?: unknown } | null;
      if (data?.sessionId !== sessionId) return;
      if (change.type === "conversation.classified" && data?.by === "llm") setClassifierError(null);
    }
    window.clearTimeout(liveTimer.current);
    liveTimer.current = window.setTimeout(() => reload.current(), LIVE_REFRESH_MS);
  });
  useEffect(() => () => window.clearTimeout(liveTimer.current), []);

  const setConversation = (conversation: Conversation) =>
    detail.setData((previous) => (previous ? { ...previous, conversation } : previous));

  const patch = async (action: Action, changes: ArchivePatch, successTitle?: string, successMessage?: string): Promise<boolean> => {
    setBusy(action);
    try {
      setConversation(await api.archivePatch(sessionId, changes));
      if (successTitle) toast.success(successTitle, successMessage);
      return true;
    } catch (err) {
      toast.error("Modification impossible", err);
      return false;
    } finally {
      setBusy(null);
    }
  };

  const data = detail.data;
  if (!data) {
    const notFound = detail.error instanceof ApiError && detail.error.status === 404;
    return (
      <div className="archives">
        <BackLink />
        {detail.error ? (
          <EmptyState
            icon={notFound ? "archive" : "alert"}
            title={notFound ? "Conversation introuvable" : "Chargement impossible"}
            action={
              notFound ? (
                <a className="btn" href={routeHref("archives")}>
                  Retour aux archives
                </a>
              ) : (
                <Button icon="refresh" onClick={() => detail.reload()}>
                  Réessayer
                </Button>
              )
            }
          >
            {notFound ? "Elle a peut-être été retirée de l'archive." : errorText(detail.error)}
          </EmptyState>
        ) : (
          <div className="empty">
            <Spinner large />
            <p>Chargement de la conversation…</p>
          </div>
        )}
      </div>
    );
  }

  const c = data.conversation;
  const { transcript, usage } = data;

  const classify = async () => {
    setBusy("classify");
    setClassifierError(null);
    try {
      const updated = await api.archiveClassify(sessionId);
      setConversation(updated);
      const target = categoryById(updated.category);
      const label = target ? `${target.emoji} ${target.label}` : updated.category;
      if (updated.classifiedBy === "llm") {
        toast.success("Conversation reclassée par l'IA", `Catégorie : ${label}.`);
      } else {
        toast.warning(
          "Classement par mots-clés",
          `L'IA n'a pas pu être utilisée (mode de classement, modèle indisponible ou erreur). Catégorie : ${label}.`,
        );
      }
    } catch (err) {
      toast.error("Reclassement impossible", err);
    } finally {
      setBusy(null);
    }
  };

  const refresh = async () => {
    setBusy("refresh");
    try {
      await api.archiveRefresh(sessionId);
      reload.current();
      toast.success("Archive actualisée", "La session a été relue dans opencode.");
    } catch (err) {
      if (err instanceof ApiError && err.status === 404) {
        reload.current();
        toast.warning("Session introuvable dans opencode", "Elle a pu être supprimée ou ne contient aucun prompt ; l'archive est conservée.");
      } else {
        toast.error("Actualisation impossible", err);
      }
    } finally {
      setBusy(null);
    }
  };

  const remove = async () => {
    const ok = await confirm({
      title: "Supprimer de l'archive ?",
      message: (
        <div className="stack tight">
          <p className="secondary">
            La fiche, l'index de recherche et la copie Markdown de « {c.title || "Sans titre"} » seront supprimés.
          </p>
          <p className="secondary">
            La session opencode, elle, n'est pas supprimée : elle sera réarchivée si elle reprend, ou lors d'une réanalyse de l'historique
            si elle a été active ces 45 derniers jours.
          </p>
        </div>
      ),
      confirmLabel: "Supprimer de l'archive",
      danger: true,
    });
    if (!ok) return;
    setBusy("delete");
    try {
      await api.archiveDelete(sessionId);
      toast.success("Conversation retirée de l'archive", "La session opencode est conservée.");
      onDeleted();
      navigate("archives");
    } catch (err) {
      toast.error("Suppression impossible", err);
    } finally {
      setBusy(null);
    }
  };

  const busyAny = busy !== null;
  const category = categoryById(c.category);
  const method = classificationMethod(c.classifiedBy);
  const manual = c.classifiedBy === "manual";
  const confidence = formatConfidence(c.confidence);
  const newPrompts = c.classifiedAt ? Math.max(0, c.promptCount - c.promptsAtClassification) : 0;
  const tools = Object.entries(c.tools).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  const toolCalls = tools.reduce((sum, [, count]) => sum + count, 0);
  const byModel = [...usage.byModel].sort((a, b) => b.cost - a.cost);
  const modelKeys = c.models.length > 0 ? c.models : byModel.map((m) => `${m.providerID}/${m.modelID}`);
  const models = modelKeys.map((key) => modelName(key, modelByKey));
  const visibleFiles = showAllFiles ? c.files : c.files.slice(0, FILES_PREVIEW);
  const heuristicOnly = boot.settings.classifier.mode === "heuristic";
  const tokens = usage.tokens;

  return (
    <div className="archives">
      <div className="archive-head">
        <BackLink />
        <TitleEditor
          title={c.title}
          disabled={busyAny}
          saving={busy === "title"}
          onSave={(title) => patch("title", { title }, "Titre modifié")}
        />
        <div className="archive-meta">
          <CategoryChip category={category} fallback={c.category} />
          <span className="archive-meta-item" title={c.directory}>
            <Icon name="folder" size={14} />
            {c.project}
          </span>
          <span className="archive-meta-item" title={formatDateTime(c.updatedAt)}>
            <Icon name="clock" size={14} />
            {`Dernière activité : ${relativeTime(c.updatedAt)}`}
          </span>
          <ClassificationBadge conversation={c} />
          {c.deletedInOpencode ? <DeletedBadge /> : null}
          {detail.loading ? <Spinner label="Actualisation" /> : null}
        </div>
        {detail.error ? (
          <div className="callout critical" role="alert">
            <Icon name="alert" />
            <span>Actualisation impossible : {errorText(detail.error)}</span>
          </div>
        ) : null}
        <div className="archive-actions">
          <span className="archive-tooltip" title={c.deletedInOpencode ? "Cette session n'existe plus dans opencode." : undefined}>
            <Button variant="primary" icon="chat" disabled={c.deletedInOpencode} onClick={() => navigate("chat", c.sessionId)}>
              Ouvrir dans le chat
            </Button>
          </span>
          <Button
            icon="pin"
            aria-pressed={c.pinned}
            loading={busy === "pin"}
            disabled={busyAny}
            title={c.pinned ? "Retirer l'épingle" : "Garder en tête de liste"}
            onClick={() => void patch("pin", { pinned: !c.pinned })}
          >
            Épingler
          </Button>
          <Button
            icon="sparkle"
            loading={busy === "classify"}
            disabled={busyAny}
            title={
              heuristicOnly
                ? "Le classement est réglé sur « mots-clés » : l'IA ne sera pas utilisée."
                : "Relit la conversation et la reclasse avec le modèle de classement"
            }
            onClick={() => void classify()}
          >
            Reclasser avec l'IA
          </Button>
          <Button
            icon="refresh"
            loading={busy === "refresh"}
            disabled={busyAny}
            title="Relit la session dans opencode et met à jour l'archive"
            onClick={() => void refresh()}
          >
            Actualiser
          </Button>
          <a className="btn" href={api.archiveExportUrl(c.sessionId)} download>
            <Icon name="download" />
            Exporter .md
          </a>
          <span className="spacer" />
          <Button variant="danger" icon="trash" loading={busy === "delete"} disabled={busyAny} onClick={() => void remove()}>
            Supprimer de l'archive
          </Button>
        </div>
      </div>

      <div className="archive-tiles">
        <StatTile label="Coût" value={formatUsd(usage.cost)} sub={plural(usage.calls, "appel au modèle", "appels aux modèles")} />
        <StatTile label="Prompts" value={formatInt(c.promptCount)} sub={`Créée le ${formatDateTime(c.createdAt)}`} />
        <StatTile
          label="Messages"
          value={formatInt(c.messageCount)}
          sub={`${formatTokens(tokens.input)} en entrée · ${formatTokens(tokens.output)} en sortie`}
          title={`Tokens : entrée ${formatInt(tokens.input)} · sortie ${formatInt(tokens.output)} · raisonnement ${formatInt(tokens.reasoning)} · cache lu ${formatInt(tokens.cacheRead)} · cache écrit ${formatInt(tokens.cacheWrite)}`}
        />
        <StatTile
          label="Lignes modifiées"
          value={
            <>
              <span className="num-add">+{formatInt(c.additions)}</span> <span className="muted">/</span>{" "}
              <span className="num-del">−{formatInt(c.deletions)}</span>
            </>
          }
          sub={plural(c.files.length, "fichier modifié", "fichiers modifiés")}
        />
        <StatTile
          label="Modèles"
          value={formatInt(models.length)}
          sub={models.length > 0 ? models.join(", ") : "Aucun"}
          title={modelKeys.join(", ")}
        />
        <StatTile label="Dernière activité" value={relativeTime(c.updatedAt)} sub={formatDateTime(c.updatedAt)} />
      </div>

      <div className="archive-grid">
        <SummaryEditor
          summary={c.summary}
          disabled={busyAny}
          saving={busy === "summary"}
          onSave={(summary) => patch("summary", { summary }, "Résumé enregistré")}
        />

        <aside className="area-side" aria-label="Détails de la conversation">
          <Card title="Classement">
            <div className="stack">
              <div className="field">
                <label htmlFor={categoryFieldId}>Catégorie</label>
                <select
                  id={categoryFieldId}
                  className="select"
                  value={c.category}
                  disabled={busyAny}
                  onChange={(e) =>
                    void patch("category", { category: e.target.value }, "Catégorie modifiée", "Ce classement manuel sera conservé.")
                  }
                >
                  {category ? null : <option value={c.category}>{`${c.category} (inconnue)`}</option>}
                  {categories.map((item) => (
                    <option key={item.id} value={item.id}>
                      {`${item.emoji} ${item.label}`}
                    </option>
                  ))}
                </select>
                <span className="field-hint">
                  {manual
                    ? "Classement manuel : l'analyse automatique le conserve (seul « Reclasser avec l'IA » le remplace)."
                    : "Changer la catégorie ou les tags fixe un classement manuel, conservé ensuite."}
                </span>
              </div>
              <div className="field">
                <span className="field-label" id={tagsLabelId}>
                  Tags
                </span>
                <TagsEditor
                  tags={c.tags}
                  labelledBy={tagsLabelId}
                  disabled={busyAny}
                  saving={busy === "tags"}
                  onSave={(tags) => patch("tags", { tags })}
                />
              </div>
              <dl className="archive-kv">
                <dt>Méthode</dt>
                <dd>{method.long}</dd>
                {manual ? null : (
                  <>
                    <dt>Confiance</dt>
                    <dd>{confidence ?? "—"}</dd>
                    <dt>Date</dt>
                    <dd>{c.classifiedAt ? formatDateTime(c.classifiedAt) : "—"}</dd>
                    {newPrompts > 0 ? (
                      <>
                        <dt>Depuis</dt>
                        <dd>{plural(newPrompts, "nouveau prompt", "nouveaux prompts")}</dd>
                      </>
                    ) : null}
                  </>
                )}
              </dl>
              {classifierError ? (
                <div className="callout warning" role="status">
                  <Icon name="alert" />
                  <span>Le classement par l'IA a échoué : {classifierError}</span>
                </div>
              ) : null}
            </div>
          </Card>

          <Card title="Fichiers modifiés" subtitle={c.files.length > 0 ? plural(c.files.length, "fichier", "fichiers") : undefined}>
            {c.files.length === 0 ? (
              <p className="small muted">Aucun fichier modifié.</p>
            ) : (
              <>
                <ul className="archive-files">
                  {visibleFiles.map((file) => {
                    const slash = file.lastIndexOf("/");
                    return (
                      <li key={file} title={file}>
                        <Icon name="file" size={13} />
                        <span className="archive-file-name">{slash >= 0 ? file.slice(slash + 1) : file}</span>
                        {slash > 0 ? <span className="archive-file-dir ellipsis">{file.slice(0, slash)}</span> : null}
                      </li>
                    );
                  })}
                </ul>
                {c.files.length > FILES_PREVIEW ? (
                  <Button variant="ghost" size="sm" aria-expanded={showAllFiles} onClick={() => setShowAllFiles((value) => !value)}>
                    {showAllFiles ? "Réduire la liste" : `Afficher les ${formatInt(c.files.length)} fichiers`}
                  </Button>
                ) : null}
              </>
            )}
          </Card>

          <Card title="Outils utilisés" subtitle={toolCalls > 0 ? plural(toolCalls, "appel", "appels") : undefined}>
            {tools.length === 0 ? (
              <p className="small muted">Aucun outil utilisé.</p>
            ) : (
              <div className="archive-tools">
                {tools.map(([name, count]) => (
                  <span key={name} className="badge">
                    <span className="archive-tool-name">{name}</span>×{formatInt(count)}
                  </span>
                ))}
              </div>
            )}
          </Card>

          <Card title="Coût par modèle" flush>
            {byModel.length === 0 ? (
              <p className="small muted archive-card-note">Aucun appel enregistré pour cette conversation.</p>
            ) : (
              <div className="table-wrap">
                <table className="table archive-model-table">
                  <thead>
                    <tr>
                      <th scope="col">Modèle</th>
                      <th scope="col" className="num">
                        Appels
                      </th>
                      <th scope="col" className="num">
                        Coût
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {byModel.map((m) => {
                      const key = `${m.providerID}/${m.modelID}`;
                      return (
                        <tr key={key}>
                          <td title={key}>
                            <div className="ellipsis">{modelName(key, modelByKey)}</div>
                            <div className="tiny muted ellipsis">{m.providerID}</div>
                          </td>
                          <td className="num">{formatInt(m.calls)}</td>
                          <td className="num">{formatUsd(m.cost)}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                  {byModel.length > 1 ? (
                    <tfoot>
                      <tr>
                        <td>Total</td>
                        <td className="num">{formatInt(usage.calls)}</td>
                        <td className="num">{formatUsd(usage.cost)}</td>
                      </tr>
                    </tfoot>
                  ) : null}
                </table>
              </div>
            )}
          </Card>
        </aside>

        <Card
          className="area-transcript"
          title="Transcription"
          subtitle={
            c.archivePath ? (
              <span className="archive-path">
                Copie dans le dossier des archives : <code>{c.archivePath}</code>
              </span>
            ) : (
              "Copie Markdown pas encore écrite dans le dossier des archives."
            )
          }
        >
          {transcript.trim() ? (
            <Markdown text={transcript} className="archive-transcript" />
          ) : (
            <EmptyState icon="file" title="Transcription vide">
              Utilisez « Actualiser » pour relire la session dans opencode.
            </EmptyState>
          )}
        </Card>
      </div>
    </div>
  );
}

function StatTile({ label, value, sub, title }: { label: string; value: ReactNode; sub?: ReactNode; title?: string }) {
  return (
    <div className="stat-tile" title={title}>
      <span className="label">{label}</span>
      <span className="value tabular ellipsis">{value}</span>
      {sub ? <span className="sub ellipsis">{sub}</span> : null}
    </div>
  );
}

function TitleEditor({
  title,
  disabled,
  saving,
  onSave,
}: {
  title: string;
  disabled: boolean;
  saving: boolean;
  onSave: (title: string) => Promise<boolean>;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const row = useRef<HTMLDivElement>(null);
  const wasEditing = useRef(false);
  const editing = draft !== null;

  useEffect(() => {
    if (editing) {
      input.current?.focus();
      input.current?.select();
    } else if (wasEditing.current) {
      row.current?.querySelector("button")?.focus();
    }
    wasEditing.current = editing;
  }, [editing]);

  if (draft === null) {
    return (
      <div className="archive-title-row" ref={row}>
        <h1 className="archive-title">{title || "Sans titre"}</h1>
        <IconButton icon="edit" label="Renommer" size="sm" disabled={disabled} onClick={() => setDraft(title)} />
      </div>
    );
  }

  const trimmed = draft.trim();
  const invalid = trimmed.length === 0 || trimmed.length > MAX_TITLE;
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (invalid || saving) return;
    if (trimmed === title) {
      setDraft(null);
      return;
    }
    if (await onSave(trimmed)) setDraft(null);
  };

  return (
    <form className="archive-title-edit" onSubmit={(e) => void submit(e)}>
      <input
        ref={input}
        className="input"
        value={draft}
        maxLength={MAX_TITLE}
        aria-label="Titre de la conversation"
        aria-invalid={invalid}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            e.preventDefault();
            setDraft(null);
          }
        }}
      />
      <Button type="submit" variant="primary" icon="check" loading={saving} disabled={invalid}>
        Enregistrer
      </Button>
      <Button variant="ghost" disabled={saving} onClick={() => setDraft(null)}>
        Annuler
      </Button>
    </form>
  );
}

function TagsEditor({
  tags,
  labelledBy,
  disabled,
  saving,
  onSave,
}: {
  tags: string[];
  labelledBy: string;
  disabled: boolean;
  saving: boolean;
  onSave: (tags: string[]) => Promise<boolean>;
}) {
  const [draft, setDraft] = useState("");
  const [error, setError] = useState<string | null>(null);
  const full = tags.length >= MAX_TAGS;

  const add = async () => {
    const value = draft.trim().replace(/^#+/, "").trim();
    if (!value || disabled) return;
    if (value.length > MAX_TAG_LENGTH) {
      setError(`${MAX_TAG_LENGTH} caractères maximum par tag.`);
      return;
    }
    if (tags.some((tag) => tag.toLowerCase() === value.toLowerCase())) {
      setError("Ce tag existe déjà.");
      return;
    }
    if (full) {
      setError(`${MAX_TAGS} tags maximum.`);
      return;
    }
    setError(null);
    if (await onSave([...tags, value])) setDraft("");
  };

  return (
    <div className="stack tight">
      {tags.length === 0 ? (
        <p className="small muted">Aucun tag.</p>
      ) : (
        <div className="tag-editor" role="list" aria-labelledby={labelledBy}>
          {tags.map((tag, i) => (
            <span key={`${tag}-${i}`} className="chip tag-chip" role="listitem">
              <span className="ellipsis">#{tag}</span>
              <button
                type="button"
                className="tag-remove"
                aria-label={`Retirer le tag ${tag}`}
                title="Retirer"
                disabled={disabled}
                onClick={() => void onSave(tags.filter((_, j) => j !== i))}
              >
                <Icon name="x" size={12} />
              </button>
            </span>
          ))}
        </div>
      )}
      <form
        className="tag-add"
        onSubmit={(e) => {
          e.preventDefault();
          void add();
        }}
      >
        <input
          className="input sm"
          value={draft}
          maxLength={MAX_TAG_LENGTH + 8}
          placeholder={full ? `${MAX_TAGS} tags maximum` : "Nouveau tag"}
          aria-label="Nouveau tag"
          aria-invalid={error !== null}
          disabled={full}
          onChange={(e) => {
            setDraft(e.target.value);
            setError(null);
          }}
          onKeyDown={(e) => {
            if (e.key === ",") {
              e.preventDefault();
              void add();
            }
          }}
        />
        <Button type="submit" size="sm" icon="plus" loading={saving} disabled={disabled || full || !draft.trim()}>
          Ajouter
        </Button>
      </form>
      {error ? (
        <span className="field-error" role="alert">
          {error}
        </span>
      ) : null}
    </div>
  );
}

function SummaryEditor({
  summary,
  disabled,
  saving,
  onSave,
}: {
  summary: string;
  disabled: boolean;
  saving: boolean;
  onSave: (summary: string) => Promise<boolean>;
}) {
  // null : pas de modification en cours, on affiche la valeur du serveur (mise à jour en direct).
  const [draft, setDraft] = useState<string | null>(null);
  const fieldId = useId();
  const value = draft ?? summary;
  const dirty = draft !== null && draft !== summary;

  const save = async () => {
    if (draft === null) return;
    if (await onSave(draft)) setDraft(null);
  };

  return (
    <Card
      className="area-summary"
      title={<label htmlFor={fieldId}>Résumé</label>}
      subtitle="Rédigé lors du classement ; vous pouvez le corriger."
    >
      <textarea
        id={fieldId}
        className="textarea"
        rows={4}
        maxLength={MAX_SUMMARY}
        value={value}
        placeholder="Aucun résumé pour l'instant."
        onChange={(e) => setDraft(e.target.value)}
      />
      <div className="row archive-summary-foot">
        <span className="small muted tabular">{`${formatInt(value.length)} / ${formatInt(MAX_SUMMARY)}`}</span>
        <span className="spacer" />
        {dirty ? (
          <Button variant="ghost" size="sm" disabled={saving} onClick={() => setDraft(null)}>
            Annuler
          </Button>
        ) : null}
        <Button variant="primary" size="sm" icon="check" loading={saving} disabled={!dirty || disabled} onClick={() => void save()}>
          Enregistrer
        </Button>
      </div>
    </Card>
  );
}
