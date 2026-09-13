// Studio : agents, skills, commandes et instructions (AGENTS.md) d'opencode.
import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useApp } from "../app/AppContext.tsx";
import { Icon } from "../components/Icon.tsx";
import { Badge, Button, EmptyState, Spinner, Tabs, useAsync, useConfirm } from "../components/ui.tsx";
import { api, errorText } from "../lib/api.ts";
import { cockpitEvent, useEvents } from "../lib/events.ts";
import { navigate, useRoute } from "../lib/router.ts";
import type { StudioItem, StudioKind, StudioTemplate } from "../lib/types.ts";
import { InstructionsEditor } from "./studio/InstructionsEditor.tsx";
import { ItemEditor } from "./studio/ItemEditor.tsx";
import { cloneJson, emptyDraft, HEX_RE, KIND_LABELS, type NewSeed, str, type StudioTab, uniqueName } from "./studio/shared.ts";
import { TemplatesModal } from "./studio/TemplatesModal.tsx";
import "./studio/studio.css";

const TABS: Array<{ id: StudioTab; label: string; icon: "bot" | "book" | "terminal" | "file" }> = [
  { id: "agents", label: "Agents", icon: "bot" },
  { id: "skills", label: "Skills", icon: "book" },
  { id: "commands", label: "Commandes", icon: "terminal" },
  { id: "instructions", label: "Instructions (AGENTS.md)", icon: "file" },
];

const MODE_BADGE: Record<string, { label: string; tone: "accent" | "neutral" }> = {
  primary: { label: "principal", tone: "accent" },
  subagent: { label: "sous-agent", tone: "neutral" },
  all: { label: "tous modes", tone: "neutral" },
};

type Seed = NewSeed & { kind: StudioKind; project: string };

function ItemBadges({ item }: { item: StudioItem }) {
  const fm = item.frontmatter;
  const badges: Array<{ key: string; label: string; tone: "accent" | "neutral" | "warning" | "critical" }> = [];
  if (item.error) badges.push({ key: "error", label: "erreur", tone: "critical" });
  if (item.kind === "agents") {
    const mode = MODE_BADGE[str(fm.mode) || "all"];
    if (mode) badges.push({ key: "mode", label: mode.label, tone: mode.tone });
    if (fm.hidden === true) badges.push({ key: "hidden", label: "masqué", tone: "neutral" });
    if (fm.disable === true) badges.push({ key: "disable", label: "désactivé", tone: "warning" });
  }
  if (item.kind === "commands") {
    if (fm.subtask === true) badges.push({ key: "subtask", label: "sous-tâche", tone: "neutral" });
    if (str(fm.agent)) badges.push({ key: "agent", label: `@${str(fm.agent)}`, tone: "accent" });
  }
  if (item.kind === "skills" && item.files.length > 0) {
    badges.push({ key: "files", label: `${item.files.length} fichier${item.files.length > 1 ? "s" : ""}`, tone: "neutral" });
  }
  if (badges.length === 0) return null;
  return (
    <span className="item-badges">
      {badges.map((b) => (
        <Badge key={b.key} tone={b.tone}>
          {b.label}
        </Badge>
      ))}
    </span>
  );
}

export function StudioPage() {
  const route = useRoute();
  const { boot } = useApp();
  const confirm = useConfirm();
  const tab: StudioTab = (TABS.find((t) => t.id === route[1])?.id ?? "agents") as StudioTab;
  const kind: StudioKind | null = tab === "instructions" ? null : tab;
  const selectedName = kind ? (route[2] ?? null) : null;

  const [project, setProject] = useState("");
  const [seed, setSeed] = useState<Seed | null>(null);
  const [templatesOpen, setTemplatesOpen] = useState(false);
  const seq = useRef(1);
  const dirtyRef = useRef(false);

  const projects = useMemo(() => boot.projects.filter((p) => !p.isRoot), [boot.projects]);
  useEffect(() => {
    if (project && !projects.some((p) => p.name === project)) setProject("");
  }, [project, projects]);

  const list = useAsync(() => (kind ? api.studioList(kind, project || null) : Promise.resolve([] as StudioItem[])), [kind, project]);
  const items = useMemo(
    () => (list.data ?? []).filter((i) => i.kind === kind && (i.project ?? "") === project),
    [list.data, kind, project],
  );
  const takenNames = useMemo(() => new Set(items.map((i) => i.name)), [items]);

  useEvents((event) => {
    const changed = cockpitEvent(event, "studio.changed", "opencode.config.changed");
    if (changed && kind) list.reload();
  });

  const onDirtyChange = useCallback((dirty: boolean) => {
    dirtyRef.current = dirty;
  }, []);

  useEffect(() => {
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      if (dirtyRef.current) e.preventDefault();
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, []);

  /** Exécute `action` après confirmation si des modifications ne sont pas enregistrées. */
  const guard = async (action: () => void) => {
    if (dirtyRef.current) {
      const ok = await confirm({
        title: "Modifications non enregistrées",
        message: "Quitter cet élément fera perdre les modifications en cours.",
        confirmLabel: "Quitter sans enregistrer",
        danger: true,
      });
      if (!ok) return;
      dirtyRef.current = false;
    }
    action();
  };

  const startNew = (template?: StudioTemplate) => {
    if (!kind) return;
    const base = template
      ? { name: uniqueName(template.name, takenNames), frontmatter: cloneJson(template.frontmatter), body: template.body }
      : emptyDraft(kind);
    void guard(() => {
      setTemplatesOpen(false);
      setSeed({ ...base, seq: seq.current++, kind, project });
      navigate("studio", kind);
    });
  };

  const onSaved = (saved: StudioItem, previousName: string | null) => {
    dirtyRef.current = false;
    list.setData((prev) => {
      const rest = (prev ?? []).filter((i) => i.name !== saved.name && i.name !== previousName);
      return [...rest, saved].sort((a, b) => a.name.localeCompare(b.name));
    });
    setSeed(null);
    if (kind) navigate("studio", kind, saved.name);
  };

  const onDeleted = (name: string) => {
    dirtyRef.current = false;
    list.setData((prev) => (prev ?? []).filter((i) => i.name !== name));
    if (kind) navigate("studio", kind);
  };

  const activeSeed = kind && !selectedName && seed && seed.kind === kind && seed.project === project ? seed : null;
  const selected = selectedName ? items.find((i) => i.name === selectedName) ?? null : null;
  const labels = kind ? KIND_LABELS[kind] : null;

  let editor: ReactNode;
  if (tab === "instructions") {
    editor = <InstructionsEditor key={project} project={project || null} onDirtyChange={onDirtyChange} />;
  } else if (!kind || !labels) {
    editor = null;
  } else if (selectedName) {
    if (selected) {
      editor = (
        <ItemEditor
          key={`${project}|${kind}|${selected.name}`}
          kind={kind}
          item={selected}
          seed={{ name: selected.name, frontmatter: cloneJson(selected.frontmatter), body: selected.body }}
          project={project || null}
          takenNames={takenNames}
          onSaved={onSaved}
          onDeleted={onDeleted}
          onDiscardNew={() => undefined}
          onDirtyChange={onDirtyChange}
        />
      );
    } else if (list.loading) {
      editor = (
        <div className="card empty">
          <Spinner large />
        </div>
      );
    } else {
      editor = (
        <div className="card">
          <EmptyState
            icon="search"
            title="Élément introuvable"
            action={
              <Button onClick={() => navigate("studio", kind)} icon="chevronLeft">
                Retour à la liste
              </Button>
            }
          >
            « {selectedName} » n'existe pas dans {project ? `le projet ${project}` : "la configuration globale"}.
          </EmptyState>
        </div>
      );
    }
  } else if (activeSeed) {
    editor = (
      <ItemEditor
        key={`new-${activeSeed.seq}`}
        kind={kind}
        item={null}
        seed={{ name: activeSeed.name, frontmatter: activeSeed.frontmatter, body: activeSeed.body }}
        project={project || null}
        takenNames={takenNames}
        onSaved={onSaved}
        onDeleted={() => undefined}
        onDiscardNew={() => setSeed(null)}
        onDirtyChange={onDirtyChange}
      />
    );
  } else {
    editor = (
      <div className="card">
        <EmptyState
          icon={kind === "agents" ? "bot" : kind === "skills" ? "book" : "terminal"}
          title={items.length > 0 ? `Sélectionnez ${labels.article}` : `Aucun${kind === "commands" ? "e" : ""} ${labels.one} pour l'instant`}
          action={
            <div className="row wrap" style={{ justifyContent: "center" }}>
              <Button variant="primary" icon="plus" onClick={() => startNew()}>
                Nouveau
              </Button>
              <Button icon="layers" onClick={() => setTemplatesOpen(true)}>
                Partir d'un modèle
              </Button>
            </div>
          }
        >
          {kind === "agents"
            ? "Un agent combine un prompt système, un modèle et des permissions. Les agents intégrés d'opencode (build, plan…) ne sont pas listés ici."
            : kind === "skills"
              ? "Un skill est un paquet d'instructions et de documents que le modèle charge uniquement quand il en a besoin."
              : "Une commande est un modèle de prompt réutilisable, lancé avec /nom dans le chat."}
        </EmptyState>
      </div>
    );
  }

  return (
    <div className="page">
      <div className="page-narrow" style={{ maxWidth: 1280 }}>
        <header className="page-header">
          <div className="spacer" style={{ minWidth: 0 }}>
            <h1>Studio</h1>
            <p>
              Agents, skills et commandes d'opencode. Les fichiers sont écrits dans sa configuration et pris en compte immédiatement ; opencode
              les vérifie et toute modification refusée est annulée automatiquement.
            </p>
          </div>
        </header>

        <div className="studio-toolbar">
          <Tabs<StudioTab>
            value={tab}
            items={TABS}
            onChange={(next) =>
              void guard(() => {
                setSeed(null);
                navigate("studio", next);
              })
            }
          />
          <div className="studio-scope">
            <label htmlFor="studio-scope" className="small secondary">
              Portée
            </label>
            <select
              id="studio-scope"
              className="select sm"
              value={project}
              onChange={(e) => {
                const next = e.target.value;
                void guard(() => {
                  setSeed(null);
                  setProject(next);
                  navigate("studio", tab);
                });
              }}
            >
              <option value="">Global (tous les projets)</option>
              {projects.map((p) => (
                <option key={p.name} value={p.name}>
                  Projet : {p.name}
                </option>
              ))}
            </select>
          </div>
        </div>

        {kind && labels ? (
          <div className="studio-layout">
            <aside className="card flush studio-list" aria-label={`Liste des ${labels.many}`}>
              <div className="studio-list-head">
                <strong className="spacer">
                  {labels.many.charAt(0).toUpperCase() + labels.many.slice(1)}{" "}
                  <span className="muted small">{list.data ? items.length : ""}</span>
                </strong>
                <Button size="sm" icon="layers" onClick={() => setTemplatesOpen(true)}>
                  Modèles
                </Button>
                <Button size="sm" variant="primary" icon="plus" onClick={() => startNew()}>
                  Nouveau
                </Button>
              </div>
              {list.loading && !list.data ? (
                <div className="empty">
                  <Spinner />
                </div>
              ) : list.error ? (
                <div className="stack tight" style={{ padding: 12 }}>
                  <div className="callout critical" role="alert">
                    {errorText(list.error)}
                  </div>
                  <Button size="sm" icon="refresh" onClick={list.reload}>
                    Réessayer
                  </Button>
                </div>
              ) : items.length === 0 && !activeSeed ? (
                <p className="small muted" style={{ padding: 12 }}>
                  {project ? `Aucun ${labels.one} dans ${project}/.opencode.` : `Aucun ${labels.one} global.`}
                </p>
              ) : (
                <nav className="list">
                  {activeSeed ? (
                    <button type="button" className="list-item active" aria-current="true">
                      <span className="item-title">
                        <Icon name="plus" size={14} />
                        <span className="ellipsis">{activeSeed.name || "Nouveau (brouillon)"}</span>
                      </span>
                      <span className="small muted">Non enregistré</span>
                    </button>
                  ) : null}
                  {items.map((item) => {
                    const color = str(item.frontmatter.color);
                    const active = item.name === selectedName;
                    return (
                      <button
                        key={item.name}
                        type="button"
                        className={`list-item${active ? " active" : ""}`}
                        aria-current={active ? "true" : undefined}
                        onClick={() => {
                          if (active) return;
                          void guard(() => {
                            setSeed(null);
                            navigate("studio", kind, item.name);
                          });
                        }}
                      >
                        <span className="item-title">
                          {item.kind === "agents" ? (
                            <span className="item-swatch" style={HEX_RE.test(color) ? { background: color } : undefined} aria-hidden />
                          ) : null}
                          <span className="ellipsis mono">{item.name}</span>
                        </span>
                        {str(item.frontmatter.description) ? (
                          <span className="small muted ellipsis">{str(item.frontmatter.description)}</span>
                        ) : null}
                        <ItemBadges item={item} />
                      </button>
                    );
                  })}
                </nav>
              )}
            </aside>
            <section className="studio-editor" aria-live="polite" style={{ minWidth: 0 }}>
              {editor}
            </section>
          </div>
        ) : (
          editor
        )}

        {kind ? <TemplatesModal open={templatesOpen} kind={kind} onClose={() => setTemplatesOpen(false)} onUse={(t) => startNew(t)} /> : null}
      </div>
    </div>
  );
}
