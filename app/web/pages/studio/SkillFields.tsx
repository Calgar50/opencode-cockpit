// Champs d'un skill et panneau des fichiers annexes (références, scripts, exemples).
import { useEffect, useId, useRef, useState } from "react";
import { CodeEditor } from "../../components/CodeEditor.tsx";
import { useToast } from "../../components/Toast.tsx";
import { Button, EmptyState, Field, IconButton, Modal, Spinner, useConfirm } from "../../components/ui.tsx";
import { useApp } from "../../app/AppContext.tsx";
import { api, errorText } from "../../lib/api.ts";
import type { StudioItem } from "../../lib/types.ts";
import { type Draft, SKILL_FILE_RE, str } from "./shared.ts";
import { DirtyBadge } from "./widgets.tsx";

export function SkillFields({ draft, setFm }: { draft: Draft; setFm: (patch: Record<string, unknown>) => void }) {
  const ids = { description: useId(), license: useId() };
  const description = str(draft.frontmatter.description);
  return (
    <div className="stack">
      <Field
        label="Description"
        htmlFor={ids.description}
        hint="Obligatoire. C'est elle qui décide le modèle à charger le skill : dites ce qu'il contient et quand l'utiliser."
        error={!description.trim() ? "La description est obligatoire." : null}
      >
        <textarea
          id={ids.description}
          className="textarea"
          rows={3}
          maxLength={1024}
          value={description}
          onChange={(e) => setFm({ description: e.target.value })}
        />
      </Field>
      <Field label="Licence" htmlFor={ids.license} hint="Optionnelle (ex. MIT, interne).">
        <input
          id={ids.license}
          className="input"
          maxLength={200}
          value={str(draft.frontmatter.license)}
          onChange={(e) => setFm({ license: e.target.value || undefined })}
          style={{ maxWidth: 320 }}
        />
      </Field>
    </div>
  );
}

function fileError(path: string, existing: string[]): string | null {
  if (!path) return "Chemin obligatoire.";
  if (path.split("/").includes("..") || !SKILL_FILE_RE.test(path)) {
    return "Chemin relatif simple : lettres, chiffres, . _ - et au plus 3 sous-dossiers (ex. references/guide.md).";
  }
  if (path === "SKILL.md") return "SKILL.md se modifie dans l'éditeur principal.";
  if (existing.includes(path)) return "Ce fichier existe déjà.";
  return null;
}

interface OpenFile {
  path: string;
  isNew: boolean;
  loading: boolean;
  content: string;
  baseline: string;
  error: string | null;
  binary: boolean;
}

export function SkillFilesPanel({ item, project }: { item: StudioItem; project: string | null }) {
  const { dark } = useApp();
  const toast = useToast();
  const confirm = useConfirm();
  const [files, setFiles] = useState<string[]>(item.files);
  const [newPath, setNewPath] = useState("");
  const [newError, setNewError] = useState<string | null>(null);
  const [open, setOpen] = useState<OpenFile | null>(null);
  const [saving, setSaving] = useState(false);
  const confirming = useRef(false);
  const newPathId = useId();

  useEffect(() => setFiles(item.files), [item.files]);

  const openFile = async (path: string) => {
    setOpen({ path, isNew: false, loading: true, content: "", baseline: "", error: null, binary: false });
    try {
      const { content } = await api.skillFile(item.name, path, project);
      const binary = content.includes(String.fromCharCode(0)) || content.includes(String.fromCharCode(65533));
      setOpen({ path, isNew: false, loading: false, content, baseline: content, error: null, binary });
    } catch (err) {
      setOpen({ path, isNew: false, loading: false, content: "", baseline: "", error: errorText(err), binary: false });
    }
  };

  const addFile = () => {
    const path = newPath.trim();
    const problem = fileError(path, files);
    if (problem) {
      setNewError(problem);
      return;
    }
    setNewPath("");
    setNewError(null);
    setOpen({ path, isNew: true, loading: false, content: "", baseline: "", error: null, binary: false });
  };

  const save = async () => {
    if (!open) return;
    setSaving(true);
    try {
      await api.saveSkillFile(item.name, open.path, open.content, project);
      setOpen({ ...open, isNew: false, baseline: open.content });
      setFiles((list) => (list.includes(open.path) ? list : [...list, open.path].sort()));
      toast.success("Fichier enregistré", open.path);
    } catch (err) {
      toast.error("Enregistrement impossible", err);
    } finally {
      setSaving(false);
    }
  };

  const remove = async (path: string) => {
    confirming.current = true;
    const ok = await confirm({
      title: "Supprimer ce fichier ?",
      message: `« ${path} » sera supprimé du skill ${item.name}. Cette action est définitive.`,
      confirmLabel: "Supprimer",
      danger: true,
    });
    confirming.current = false;
    if (!ok) return;
    try {
      await api.deleteSkillFile(item.name, path, project);
      setFiles((list) => list.filter((f) => f !== path));
      if (open?.path === path) setOpen(null);
      toast.success("Fichier supprimé", path);
    } catch (err) {
      toast.error("Suppression impossible", err);
    }
  };

  const close = async () => {
    if (confirming.current || !open) return;
    if (open.content !== open.baseline) {
      confirming.current = true;
      const ok = await confirm({ title: "Fermer sans enregistrer ?", message: "Les modifications de ce fichier seront perdues.", confirmLabel: "Fermer" });
      confirming.current = false;
      if (!ok) return;
    }
    setOpen(null);
  };

  const dirty = open ? open.content !== open.baseline || open.isNew : false;

  return (
    <div className="stack tight">
      <p className="small muted">
        Documents chargés par le modèle seulement quand le skill en a besoin. Citez-les dans les instructions (ex. « voir references/guide.md »).
      </p>
      {files.length === 0 ? (
        <EmptyState icon="file" title="Aucun fichier annexe" />
      ) : (
        <div className="list card flush skill-files">
          {files.map((file) => (
            <div key={file} className="list-item" style={{ flexDirection: "row", cursor: "default" }}>
              <button type="button" className="btn ghost sm spacer" style={{ justifyContent: "flex-start", minWidth: 0 }} onClick={() => void openFile(file)}>
                <span className="mono ellipsis">{file}</span>
              </button>
              <IconButton icon="edit" label={`Ouvrir ${file}`} size="sm" onClick={() => void openFile(file)} />
              <IconButton icon="trash" label={`Supprimer ${file}`} size="sm" onClick={() => void remove(file)} />
            </div>
          ))}
        </div>
      )}
      <div className="row wrap" style={{ alignItems: "flex-start" }}>
        <div className="field spacer" style={{ minWidth: 220 }}>
          <label htmlFor={newPathId} className="visually-hidden">
            Chemin du nouveau fichier
          </label>
          <input
            id={newPathId}
            className="input sm mono"
            placeholder="references/guide.md"
            value={newPath}
            onChange={(e) => {
              setNewPath(e.target.value);
              setNewError(null);
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                addFile();
              }
            }}
          />
          {newError ? <span className="field-error">{newError}</span> : null}
        </div>
        <Button size="sm" icon="plus" onClick={addFile} disabled={!newPath.trim()}>
          Nouveau fichier
        </Button>
      </div>

      <Modal
        open={open !== null}
        wide
        title={
          <span className="row" style={{ minWidth: 0 }}>
            <span className="mono ellipsis">{open?.path}</span>
            <DirtyBadge dirty={dirty} />
          </span>
        }
        onClose={() => void close()}
        footer={
          <>
            {open && !open.isNew ? (
              <Button variant="danger" icon="trash" onClick={() => void remove(open.path)} style={{ marginRight: "auto" }}>
                Supprimer
              </Button>
            ) : null}
            <Button onClick={() => void close()}>Fermer</Button>
            <Button variant="primary" icon="check" loading={saving} disabled={!open || open.loading || open.binary || !dirty} onClick={() => void save()}>
              Enregistrer
            </Button>
          </>
        }
      >
        {!open ? null : open.loading ? (
          <div className="empty">
            <Spinner large />
          </div>
        ) : open.error ? (
          <div className="callout critical" role="alert">
            {open.error}
          </div>
        ) : (
          <div className="stack">
            {open.binary ? (
              <div className="callout warning">Ce fichier semble binaire : l'édition est désactivée pour ne pas le corrompre.</div>
            ) : null}
            {open.isNew ? <p className="small muted">Nouveau fichier : il sera créé à l'enregistrement.</p> : null}
            <CodeEditor
              value={open.content}
              onChange={(content) => setOpen((current) => (current ? { ...current, content } : current))}
              language={open.path.toLowerCase().endsWith(".json") ? "json" : "markdown"}
              readOnly={open.binary}
              minHeight={340}
              maxHeight={560}
              dark={dark}
              ariaLabel={`Contenu de ${open.path}`}
            />
          </div>
        )}
      </Modal>
    </div>
  );
}
