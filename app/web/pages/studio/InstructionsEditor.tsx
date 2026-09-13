// Édition du fichier AGENTS.md (instructions permanentes), global ou propre à un projet.
import { useEffect, useState } from "react";
import { useApp } from "../../app/AppContext.tsx";
import { CodeEditor } from "../../components/CodeEditor.tsx";
import { Icon } from "../../components/Icon.tsx";
import { useToast } from "../../components/Toast.tsx";
import { Button, Card, Spinner, useConfirm } from "../../components/ui.tsx";
import { api, errorText } from "../../lib/api.ts";
import { DirtyBadge } from "./widgets.tsx";

export function InstructionsEditor({
  project,
  onDirtyChange,
}: {
  project: string | null;
  onDirtyChange: (dirty: boolean) => void;
}) {
  const { dark, boot } = useApp();
  const projectConfig = boot.security.projectConfig;
  const toast = useToast();
  const confirm = useConfirm();
  const [state, setState] = useState<{ loading: boolean; error: string | null; exists: boolean; baseline: string }>({
    loading: true,
    error: null,
    exists: false,
    baseline: "",
  });
  const [content, setContent] = useState("");
  const [saving, setSaving] = useState(false);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setState((s) => ({ ...s, loading: true, error: null }));
    api.instructions(project).then(
      (data) => {
        if (cancelled) return;
        setState({ loading: false, error: null, exists: data.exists, baseline: data.content });
        setContent(data.content);
      },
      (err: unknown) => {
        if (!cancelled) setState((s) => ({ ...s, loading: false, error: errorText(err) }));
      },
    );
    return () => {
      cancelled = true;
    };
  }, [project, tick]);

  const dirty = !state.loading && content !== state.baseline;
  useEffect(() => {
    onDirtyChange(dirty);
  }, [dirty, onDirtyChange]);
  useEffect(() => () => onDirtyChange(false), [onDirtyChange]);

  const save = async () => {
    setSaving(true);
    try {
      await api.saveInstructions(content, project);
      setState((s) => ({ ...s, exists: true, baseline: content }));
      toast.success(
        "Instructions enregistrées",
        project && !projectConfig
          ? "opencode ne charge pas ce fichier d'office : la configuration par projet est désactivée."
          : "opencode les applique dès la prochaine requête.",
      );
    } catch (err) {
      toast.error("Enregistrement impossible", err);
    } finally {
      setSaving(false);
    }
  };

  const reload = async () => {
    if (dirty && !(await confirm({ title: "Abandonner les modifications ?", message: "Le contenu enregistré sera rechargé.", confirmLabel: "Recharger" }))) {
      return;
    }
    setTick((t) => t + 1);
  };

  return (
    <div className="stack" onKeyDown={(e) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") {
        e.preventDefault();
        if (dirty && !saving) void save();
      }
    }}>
      <div className="callout accent">
        <Icon name="book" size={18} />
        <div className="stack tight">
          <strong>{project ? `AGENTS.md du projet ${project}` : "AGENTS.md global"}</strong>
          <span>
            {project
              ? projectConfig
                ? "Fichier à la racine du projet : consignes propres à ce dépôt (architecture, commandes de build, conventions). Il peut être versionné et partagé avec l'équipe ; il s'ajoute aux instructions globales."
                : "Configuration par projet désactivée (COCKPIT_PROJECT_CONFIG=0) : opencode ne charge pas ce fichier d'office. Placez vos consignes dans le AGENTS.md global, ou passez COCKPIT_PROJECT_CONFIG=1 dans .env (dépôts de confiance uniquement) puis redémarrez."
              : projectConfig
                ? "Consignes appliquées à toutes les conversations, dans tous les projets (langue des réponses, style, règles de sécurité). Les AGENTS.md des projets viennent s'y ajouter."
                : "Consignes appliquées à toutes les conversations, dans tous les projets (langue des réponses, style, règles de sécurité, conventions des dépôts). Les AGENTS.md des projets ne sont pas chargés d'office (COCKPIT_PROJECT_CONFIG=0)."}
          </span>
        </div>
      </div>

      <Card
        title={
          <span className="row">
            Instructions
            <DirtyBadge dirty={dirty} />
          </span>
        }
        subtitle={!state.loading && !state.exists ? "Le fichier n'existe pas encore : il sera créé à l'enregistrement." : undefined}
        actions={
          <>
            <Button size="sm" variant="ghost" icon="refresh" onClick={() => void reload()} disabled={state.loading}>
              Recharger
            </Button>
            <Button size="sm" variant="primary" icon="check" loading={saving} disabled={!dirty} onClick={() => void save()}>
              Enregistrer
            </Button>
          </>
        }
      >
        {state.loading ? (
          <div className="empty">
            <Spinner large />
          </div>
        ) : state.error ? (
          <div className="callout critical" role="alert">
            <Icon name="alert" size={18} />
            <span className="spacer">{state.error}</span>
            <Button size="sm" onClick={() => setTick((t) => t + 1)}>
              Réessayer
            </Button>
          </div>
        ) : (
          <CodeEditor value={content} onChange={setContent} language="markdown" minHeight={420} dark={dark} ariaLabel="Contenu de AGENTS.md" />
        )}
      </Card>
    </div>
  );
}
