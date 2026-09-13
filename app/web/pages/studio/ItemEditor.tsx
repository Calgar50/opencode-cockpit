// Éditeur d'un agent, d'une commande ou d'un skill : nom, champs du type, corps, enregistrement.
import { useCallback, useEffect, useId, useMemo, useState } from "react";
import { unknownAgentKeyMessage, unknownAgentKeys } from "../../../server/shared/assistant-rules.ts";
import { useApp } from "../../app/AppContext.tsx";
import { CodeEditor } from "../../components/CodeEditor.tsx";
import { Icon } from "../../components/Icon.tsx";
import { useToast } from "../../components/Toast.tsx";
import { Badge, Button, Card, Field, useAsync, useConfirm } from "../../components/ui.tsx";
import { ApiError, api, oc } from "../../lib/api.ts";
import { cockpitEvent, useEvents } from "../../lib/events.ts";
import type { OcAgent, OcCommand, StudioItem, StudioKind, Tier, ValidationIssue } from "../../lib/types.ts";
import { AgentFields } from "./AgentFields.tsx";
import type { LevelBinding, StudioAiData } from "./aiUsage.ts";
import { CommandBodyHelp, CommandFields } from "./CommandFields.tsx";
import { type Draft, draftFromItem, KIND_LABELS, nameError, stableStringify, str, validateDraft, withKey } from "./shared.ts";
import { SkillFields, SkillFilesPanel } from "./SkillFields.tsx";
import { DirtyBadge, IssuesCallout } from "./widgets.tsx";

type Problem =
  | { type: "local"; issues: ValidationIssue[] }
  | { type: "validation"; message: string; issues: ValidationIssue[] }
  | { type: "rejected"; message: string; issues: ValidationIssue[]; restarted: boolean };

const BODY_LABEL: Record<StudioKind, { title: string; hint: string }> = {
  agents: {
    title: "Consignes",
    hint: "Instructions données à l'agent à chaque conversation (Markdown). Elles remplacent les consignes par défaut d'opencode.",
  },
  commands: { title: "Texte de la commande", hint: "Texte envoyé à l'IA quand le raccourci est lancé." },
  skills: { title: "Instructions du skill", hint: "Contenu de SKILL.md, lu quand l'IA décide d'ouvrir le skill." },
};

const NEW_TITLE: Record<StudioKind, string> = { agents: "Nouvel agent", commands: "Nouvelle commande", skills: "Nouveau skill" };

/** Ligne « !`commande` » d'un texte de commande : exécutée par opencode sans demande de permission. */
const SHELL_LINE_RE = /!`[^`]+`/;

interface TierState {
  /** Niveau choisi dans le formulaire. */
  tier: Tier | null | undefined;
  /** Niveau enregistré (item_meta) ; undefined = inconnu. */
  baseline: Tier | null | undefined;
}

export function ItemEditor({
  kind,
  item,
  seed,
  project,
  takenNames,
  binding,
  initialTier,
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
  /** Niveau lié à l'élément enregistré (item_meta) ; undefined = inconnu ou portée projet. */
  binding?: Tier | null | undefined;
  /** Niveau pré-choisi d'un nouvel élément (exemple avec un niveau conseillé). */
  initialTier?: Tier | null | undefined;
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
  const [tierState, setTierState] = useState<TierState>(() => (item ? { tier: binding, baseline: binding } : { tier: initialTier, baseline: undefined }));

  const isNew = item === null;
  const tierDirty = (tierState.tier ?? null) !== (tierState.baseline ?? null);
  const dirty = isNew || stableStringify(draft) !== baseline || tierDirty;
  const changedElsewhere = item !== null && item.updatedAt !== syncedAt;

  // Agents et raccourcis d'opencode : liste des agents du raccourci et prédiction « Quelle IA sera utilisée ? ».
  const withAi = kind !== "skills";
  const directory = project ? boot.projects.find((p) => p.name === project)?.directory : undefined;
  const agents = useAsync(() => (withAi ? oc.agents(directory) : Promise.resolve([] as OcAgent[])), [withAi, directory]);
  const commands = useAsync(() => (withAi ? oc.commands(directory) : Promise.resolve([] as OcCommand[])), [withAi, directory]);
  useEvents((event) => {
    if (withAi && cockpitEvent(event, "studio.changed", "opencode.config.changed", "ai.changed")) {
      agents.reload();
      commands.reload();
    }
  });
  const ai: StudioAiData = { agents: agents.data, agentsError: agents.error, commands: commands.data, commandsError: commands.error };

  const setTier = useCallback((tier: Tier | null) => setTierState((s) => ({ ...s, tier })), []);
  const level: LevelBinding = { tier: tierState.tier, setTier, bindable: withAi && project === null };

  useEffect(() => {
    onDirtyChange(dirty);
  }, [dirty, onDirtyChange]);
  useEffect(() => () => onDirtyChange(false), [onDirtyChange]);

  // Liaison au niveau connue après coup (GET /api/ai) : le choix suit tant qu'il n'a pas été modifié.
  useEffect(() => {
    if (!item) return;
    setTierState((s) => ({ tier: s.tier === s.baseline ? binding : s.tier, baseline: binding }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [binding]);

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

  /**
   * Niveau à envoyer (item_meta) : un niveau choisi quand il est nouveau ou que l'IA du fichier change, null pour
   * délier un élément qui était lié ; undefined = liaison inchangée (jamais de ligne créée pour une simple IA précise).
   */
  const tierToSend = (frontmatter: Record<string, unknown>, previousName: string | null): Tier | null | undefined => {
    if (!level.bindable) return undefined;
    const { tier, baseline: bound } = tierState;
    const model = str(frontmatter.model);
    if (tier && model) {
      const fileChanged = !item || str(item.frontmatter.model) !== model || str(item.frontmatter.variant) !== str(frontmatter.variant);
      return isNew || tier !== bound || fileChanged || previousName !== null ? tier : undefined;
    }
    return bound ? null : undefined;
  };

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
    const tier = tierToSend(frontmatter, previousName);
    try {
      const input = tier === undefined ? { frontmatter, body: draft.body, previousName } : { frontmatter, body: draft.body, previousName, tier };
      const saved = await api.studioSave(kind, draft.name, input, project);
      const fresh = draftFromItem(saved);
      setDraft(fresh);
      setBaseline(stableStringify(fresh));
      setSyncedAt(saved.updatedAt);
      if (tier !== undefined) setTierState({ tier, baseline: tier });
      // Niveau choisi sans IA écrite (niveau indisponible) : rien n'a été lié, le formulaire revient à la liaison enregistrée.
      else if (!str(saved.frontmatter.model)) setTierState((s) => ({ tier: s.baseline ?? null, baseline: s.baseline }));
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
    setTierState((s) => ({ ...s, tier: s.baseline }));
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
  // Clés inconnues d'opencode : envoyées telles quelles à l'IA ; refusées pour une nouvelle clé, tolérées si déjà sur disque.
  const unknownKeys = kind === "agents" ? unknownAgentKeys(draft.frontmatter) : [];
  const runsShell = kind === "commands" && SHELL_LINE_RE.test(draft.body);

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

          {unknownKeys.length > 0 ? (
            <div className="callout warning" role="status">
              <Icon name="alert" size={18} />
              <div className="stack tight" style={{ minWidth: 0 }}>
                {unknownKeys.map((key) => (
                  <div key={key} className="level-note">
                    <span className="spacer">{unknownAgentKeyMessage(key)}</span>
                    <Button size="sm" onClick={() => setFm({ [key]: undefined })}>
                      Retirer
                    </Button>
                  </div>
                ))}
              </div>
            </div>
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
                ) : (
                  "Nom technique du fichier."
                )}
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

          {kind === "agents" ? (
            <AgentFields draft={draft} models={models} setFm={setFm} level={level} ai={ai} savedName={item?.name ?? draft.name} />
          ) : null}
          {kind === "commands" ? <CommandFields draft={draft} models={models} setFm={setFm} level={level} ai={ai} /> : null}
          {kind === "skills" ? <SkillFields draft={draft} setFm={setFm} /> : null}
        </div>
      </Card>

      <Card title={BODY_LABEL[kind].title} subtitle={BODY_LABEL[kind].hint}>
        <div className="stack">
          {kind === "commands" ? <CommandBodyHelp /> : null}
          {runsShell ? (
            <div className="callout warning" role="status">
              <Icon name="terminal" size={18} />
              <span>
                Ce texte contient des lignes <code>!`commande`</code>. Attention : ces lignes s'exécutent à chaque lancement, sans vous demander.
              </span>
            </div>
          ) : null}
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
