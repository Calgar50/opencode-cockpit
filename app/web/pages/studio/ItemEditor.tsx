// Éditeur d'un agent, d'une commande ou d'un skill : nom, champs du type, corps, enregistrement.
import { useCallback, useEffect, useId, useMemo, useState } from "react";
import { useApp } from "../../app/AppContext.tsx";
import { CodeEditor } from "../../components/CodeEditor.tsx";
import { Icon } from "../../components/Icon.tsx";
import { useToast } from "../../components/Toast.tsx";
import { Badge, Button, Card, Field, useConfirm } from "../../components/ui.tsx";
import { ApiError, api } from "../../lib/api.ts";
import type { StudioItem, StudioKind, ValidationIssue } from "../../lib/types.ts";
import { AgentFields } from "./AgentFields.tsx";
import { CommandBodyHelp, CommandFields } from "./CommandFields.tsx";
import { type Draft, draftFromItem, KIND_LABELS, nameError, stableStringify, str, validateDraft, withKey } from "./shared.ts";
import { SkillFields, SkillFilesPanel } from "./SkillFields.tsx";
import { DirtyBadge, IssuesCallout } from "./widgets.tsx";

type Problem =
  | { type: "local"; issues: ValidationIssue[] }
  | { type: "validation"; message: string; issues: ValidationIssue[] }
  | { type: "rejected"; message: string; issues: ValidationIssue[]; restarted: boolean };

const BODY_LABEL: Record<StudioKind, { title: string; hint: string }> = {
  agents: { title: "Prompt système", hint: "Instructions données à l'agent à chaque conversation (Markdown)." },
  commands: { title: "Modèle de la commande", hint: "Texte envoyé au modèle quand la commande est lancée." },
  skills: { title: "Instructions du skill", hint: "Contenu de SKILL.md, chargé quand le modèle décide d'utiliser le skill." },
};

const NEW_TITLE: Record<StudioKind, string> = { agents: "Nouvel agent", commands: "Nouvelle commande", skills: "Nouveau skill" };

export function ItemEditor({
  kind,
  item,
  seed,
  project,
  takenNames,
  onSaved,
  onDeleted,
  onDiscardNew,
  onDirtyChange,
}: {
  kind: StudioKind;
  /** null : nouvel élément pas encore enregistré. */
  item: StudioItem | null;
  seed: Draft;
  project: string | null;
  takenNames: Set<string>;
  onSaved: (item: StudioItem, previousName: string | null) => void;
  onDeleted: (name: string) => void;
  onDiscardNew: () => void;
  onDirtyChange: (dirty: boolean) => void;
}) {
  const { boot, dark } = useApp();
  const toast = useToast();
  const confirm = useConfirm();
  const nameId = useId();

  const [draft, setDraft] = useState<Draft>(seed);
  const [baseline, setBaseline] = useState(() => stableStringify(item ? draftFromItem(item) : null));
  const [syncedAt, setSyncedAt] = useState(item?.updatedAt ?? 0);
  const [problem, setProblem] = useState<Problem | null>(null);
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);

  const isNew = item === null;
  const dirty = isNew || stableStringify(draft) !== baseline;
  const changedElsewhere = item !== null && item.updatedAt !== syncedAt;

  useEffect(() => {
    onDirtyChange(dirty);
  }, [dirty, onDirtyChange]);
  useEffect(() => () => onDirtyChange(false), [onDirtyChange]);

  // Fichier modifié ailleurs (autre onglet, opencode) : resynchronisation si aucune modification locale.
  useEffect(() => {
    if (!item || item.updatedAt === syncedAt) return;
    if (stableStringify(draft) === baseline) {
      const fresh = draftFromItem(item);
      setDraft(fresh);
      setBaseline(stableStringify(fresh));
      setSyncedAt(item.updatedAt);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [item?.updatedAt]);

  const setFm = useCallback((patch: Record<string, unknown>) => {
    setDraft((d) => {
      let frontmatter = d.frontmatter;
      for (const [key, value] of Object.entries(patch)) frontmatter = withKey(frontmatter, key, value);
      return { ...d, frontmatter };
    });
  }, []);

  const liveNameError = useMemo(() => {
    if (!draft.name) return null;
    const err = nameError(draft.name);
    if (err) return err;
    if (draft.name !== item?.name && takenNames.has(draft.name)) return "Un élément porte déjà ce nom.";
    return null;
  }, [draft.name, item?.name, takenNames]);

  const save = async () => {
    if (saving) return;
    const issues = validateDraft(kind, draft);
    if (draft.name && draft.name !== item?.name && takenNames.has(draft.name)) issues.push({ path: "nom", message: "Un élément porte déjà ce nom." });
    if (issues.length > 0) {
      setProblem({ type: "local", issues });
      return;
    }
    setSaving(true);
    setProblem(null);
    let frontmatter = { ...draft.frontmatter };
    if (typeof frontmatter.description === "string") frontmatter = withKey(frontmatter, "description", frontmatter.description.trim() || (kind === "commands" ? undefined : ""));
    if (kind === "skills") frontmatter.name = draft.name;
    const previousName = item && item.name !== draft.name ? item.name : null;
    try {
      const saved = await api.studioSave(kind, draft.name, { frontmatter, body: draft.body, previousName }, project);
      const fresh = draftFromItem(saved);
      setDraft(fresh);
      setBaseline(stableStringify(fresh));
      setSyncedAt(saved.updatedAt);
      toast.success(`${KIND_LABELS[kind].one.charAt(0).toUpperCase()}${KIND_LABELS[kind].one.slice(1)} enregistré${kind === "commands" ? "e" : ""}`, `${saved.name} est actif dans opencode.`);
      onSaved(saved, previousName);
    } catch (err) {
      if (err instanceof ApiError && err.code === "rejected-by-opencode") {
        const data = (err.data ?? {}) as { restarted?: unknown };
        setProblem({ type: "rejected", message: err.message, issues: err.issues, restarted: data.restarted === true });
      } else if (err instanceof ApiError && err.code === "validation") {
        setProblem({ type: "validation", message: err.message, issues: err.issues });
      } else {
        toast.error("Enregistrement impossible", err);
      }
    } finally {
      setSaving(false);
    }
  };

  const revert = async () => {
    if (isNew) {
      if (await confirm({ title: "Abandonner ce brouillon ?", message: "Rien n'a encore été enregistré.", confirmLabel: "Abandonner", danger: true })) {
        onDirtyChange(false);
        onDiscardNew();
      }
      return;
    }
    if (!(await confirm({ title: "Annuler les modifications ?", message: "Le contenu enregistré sera rétabli.", confirmLabel: "Rétablir" }))) return;
    const fresh = draftFromItem(item);
    setDraft(fresh);
    setBaseline(stableStringify(fresh));
    setSyncedAt(item.updatedAt);
    setProblem(null);
  };

  const remove = async () => {
    if (!item) return;
    const ok = await confirm({
      title: `Supprimer « ${item.name} » ?`,
      message:
        kind === "skills"
          ? "Le dossier du skill et tous ses fichiers annexes seront supprimés. Cette action est définitive."
          : "Le fichier sera supprimé de la configuration d'opencode. Cette action est définitive.",
      confirmLabel: "Supprimer",
      danger: true,
    });
    if (!ok) return;
    setDeleting(true);
    try {
      const { deleted } = await api.studioDelete(kind, item.name, project);
      if (deleted) toast.success("Supprimé", item.name);
      else toast.warning("Élément introuvable", "Il avait peut-être déjà été supprimé.");
      onDirtyChange(false);
      onDeleted(item.name);
    } catch (err) {
      toast.error("Suppression impossible", err);
    } finally {
      setDeleting(false);
    }
  };

  const models = boot.models;

  return (
    <div
      className="stack"
      onKeyDown={(e) => {
        if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") {
          e.preventDefault();
          void save();
        }
      }}
    >
      <Card>
        <div className="studio-editor-head">
          <h2 className="spacer">{draft.name || NEW_TITLE[kind]}</h2>
          {isNew ? <Badge tone="accent">brouillon</Badge> : <DirtyBadge dirty={dirty} />}
          {!isNew && dirty ? (
            <Button size="sm" variant="ghost" icon="undo" onClick={() => void revert()}>
              Annuler
            </Button>
          ) : null}
          {isNew ? (
            <Button size="sm" variant="ghost" icon="x" onClick={() => void revert()}>
              Abandonner
            </Button>
          ) : (
            <Button size="sm" variant="danger" icon="trash" loading={deleting} onClick={() => void remove()}>
              Supprimer
            </Button>
          )}
          <Button size="sm" variant="primary" icon="check" loading={saving} disabled={!dirty} onClick={() => void save()} title="Ctrl+S">
            Enregistrer
          </Button>
        </div>

        <div className="stack">
          {item?.error ? (
            <div className="callout critical" role="alert">
              <Icon name="alert" size={18} />
              <div className="stack tight">
                <strong>En-tête YAML illisible</strong>
                <span className="mono small">{item.error}</span>
                <span>
                  Le corps ci-dessous contient le fichier brut. Renseignez les champs, retirez l'ancien bloc <code>---</code> du corps, puis
                  enregistrez pour réécrire un fichier propre.
                </span>
              </div>
            </div>
          ) : null}
          {changedElsewhere && dirty ? (
            <div className="callout warning" role="status">
              <Icon name="alert" size={18} />
              <span className="spacer">Ce fichier a été modifié ailleurs depuis l'ouverture. Enregistrer écrasera cette version.</span>
              <Button
                size="sm"
                onClick={() => {
                  const fresh = draftFromItem(item);
                  setDraft(fresh);
                  setBaseline(stableStringify(fresh));
                  setSyncedAt(item.updatedAt);
                }}
              >
                Recharger
              </Button>
            </div>
          ) : null}
          {problem?.type === "local" ? <IssuesCallout title="À corriger avant d'enregistrer" issues={problem.issues} tone="warning" /> : null}
          {problem?.type === "validation" ? <IssuesCallout title={problem.message || "Contenu invalide."} issues={problem.issues} /> : null}
          {problem?.type === "rejected" ? (
            <IssuesCallout title="opencode a refusé cette configuration, la modification a été annulée." issues={problem.issues}>
              {problem.restarted ? <span className="small">opencode a été redémarré pour repartir de la configuration précédente.</span> : null}
            </IssuesCallout>
          ) : null}

          <Field
            label="Nom"
            htmlFor={nameId}
            error={liveNameError}
            hint={
              <>
                Minuscules, chiffres et tirets.{" "}
                {kind === "commands" ? (
                  <>
                    S'utilise avec <code>/{draft.name || "nom"}</code> dans le chat.
                  </>
                ) : kind === "agents" ? (
                  <>
                    S'appelle avec <code>@{draft.name || "nom"}</code>.
                  </>
                ) : null}
                {item && draft.name !== item.name ? " Renommer déplace le fichier." : ""}
              </>
            }
          >
            <input
              id={nameId}
              className="input mono"
              value={draft.name}
              maxLength={64}
              autoComplete="off"
              spellCheck={false}
              placeholder="revue-securite"
              onChange={(e) => setDraft((d) => ({ ...d, name: e.target.value }))}
              style={{ maxWidth: 360 }}
            />
          </Field>
          {item ? (
            <p className="tiny muted">
              Fichier : <span className="mono">{item.file}</span>
              {item.project ? ` (projet ${item.project})` : " (configuration globale)"}
            </p>
          ) : null}

          {kind === "agents" ? <AgentFields draft={draft} models={models} setFm={setFm} /> : null}
          {kind === "commands" ? <CommandFields draft={draft} models={models} setFm={setFm} /> : null}
          {kind === "skills" ? <SkillFields draft={draft} setFm={setFm} /> : null}
        </div>
      </Card>

      <Card title={BODY_LABEL[kind].title} subtitle={BODY_LABEL[kind].hint}>
        <div className="stack">
          {kind === "commands" ? <CommandBodyHelp /> : null}
          <CodeEditor
            value={draft.body}
            onChange={(body) => setDraft((d) => ({ ...d, body }))}
            language="markdown"
            minHeight={320}
            dark={dark}
            ariaLabel={BODY_LABEL[kind].title}
          />
        </div>
      </Card>

      {kind === "skills" ? (
        <Card title="Fichiers annexes" subtitle="Références, exemples ou scripts rangés dans le dossier du skill.">
          {item ? <SkillFilesPanel item={item} project={project} /> : <p className="small muted">Enregistrez d'abord le skill pour lui ajouter des fichiers.</p>}
        </Card>
      ) : null}
    </div>
  );
}
