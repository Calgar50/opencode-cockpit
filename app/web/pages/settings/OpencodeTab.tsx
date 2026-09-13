// Configuration globale d'opencode : modèles, fournisseurs, partage, permissions et fichier brut.
import { useEffect, useId, useRef, useState } from "react";
import { detectPermissionPreset, MESSAGES, type PermissionPresetId, presetPermission } from "../../../server/shared/assistant-rules.ts";
import { useApp } from "../../app/AppContext.tsx";
import { CodeEditor } from "../../components/CodeEditor.tsx";
import { Icon } from "../../components/Icon.tsx";
import { useToast } from "../../components/Toast.tsx";
import { Badge, Button, Card, Field, Spinner, useAsync, useConfirm } from "../../components/ui.tsx";
import { ApiError, api, errorText } from "../../lib/api.ts";
import { DirtyBadge, IssuesCallout, ModelSelect, TokenListEditor } from "../studio/widgets.tsx";
import { useDraft } from "./common.tsx";

const COPILOT = "github-copilot";

// Règles de chaque profil : PERMISSION_PRESETS (server/shared), « prudent » = docker/opencode/opencode.default.jsonc.
const PRESETS: Array<{ id: PermissionPresetId; title: string; summary: string; points: string[]; danger?: boolean }> = [
  {
    id: "prudent",
    title: "Prudent",
    summary: "Confirmation avant toute modification ou commande (configuration d'origine).",
    points: ["Fichiers : demander", "Shell : demander (seul pwd est autorisé d'office)", "Sous-agents : demander", "Web : demander"],
  },
  {
    id: "equilibre",
    title: "Équilibré",
    summary: "Modifications de fichiers libres ; commandes, sous-agents et web sur confirmation.",
    points: ["Fichiers : autoriser", "Shell : demander", "Sous-agents : demander", "Web : demander"],
  },
  {
    id: "autonome",
    title: "Autonome",
    summary: "Aucune confirmation : l'agent agit seul.",
    points: ["Fichiers : autoriser", "Shell : autoriser", "Sous-agents : autoriser", "Web : autoriser"],
    danger: true,
  },
];

function RawConfigEditor({ reloadToken, onDirty, onSaved }: { reloadToken: number; onDirty: (dirty: boolean) => void; onSaved: () => void }) {
  const { dark } = useApp();
  const toast = useToast();
  const confirm = useConfirm();
  const [state, setState] = useState<{ loading: boolean; error: string | null; file: string; baseline: string }>({
    loading: true,
    error: null,
    file: "",
    baseline: "",
  });
  const [content, setContent] = useState("");
  const [saving, setSaving] = useState(false);
  const [rejected, setRejected] = useState<{ message: string; restarted: boolean } | null>(null);
  const [tick, setTick] = useState(0);
  const dirty = !state.loading && content !== state.baseline;

  const baselineRef = useRef<string | null>(null);

  useEffect(() => onDirty(dirty), [dirty, onDirty]);
  useEffect(() => () => onDirty(false), [onDirty]);

  // Recharge le fichier ; le contenu affiché n'est remplacé que s'il n'a pas été modifié.
  useEffect(() => {
    let cancelled = false;
    setState((s) => ({ ...s, error: null }));
    api.opencodeConfigRaw().then(
      (data) => {
        if (cancelled) return;
        setContent((current) => (baselineRef.current === null || current === baselineRef.current ? data.content : current));
        baselineRef.current = data.content;
        setState({ loading: false, error: null, file: data.file, baseline: data.content });
      },
      (err: unknown) => {
        if (!cancelled) setState((s) => ({ ...s, loading: false, error: errorText(err) }));
      },
    );
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tick, reloadToken]);

  const save = async () => {
    setSaving(true);
    setRejected(null);
    try {
      await api.saveOpencodeConfigRaw(content);
      baselineRef.current = content;
      setState((s) => ({ ...s, baseline: content }));
      toast.success("Fichier enregistré", "opencode a rechargé sa configuration.");
      onSaved();
    } catch (err) {
      if (err instanceof ApiError && err.status === 422) {
        const data = (err.data ?? {}) as { restarted?: unknown };
        setRejected({ message: err.message, restarted: data.restarted === true });
      } else {
        toast.error("Enregistrement impossible", err);
      }
    } finally {
      setSaving(false);
    }
  };

  const reload = async () => {
    if (dirty && !(await confirm({ title: "Abandonner les modifications ?", message: "Le fichier enregistré sera rechargé.", confirmLabel: "Recharger" }))) return;
    setContent(state.baseline);
    setTick((t) => t + 1);
  };

  return (
    <Card
      title={
        <span className="row">
          Fichier brut {state.file ? <span className="mono small muted">{state.file}</span> : null}
          <DirtyBadge dirty={dirty} />
        </span>
      }
      subtitle="JSON avec commentaires (JSONC). Un fichier refusé par opencode est restauré automatiquement."
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
      <div
        className="stack"
        onKeyDown={(e) => {
          if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") {
            e.preventDefault();
            if (dirty && !saving) void save();
          }
        }}
      >
        {rejected ? (
          <IssuesCallout title="opencode a refusé ce fichier, l'ancienne version a été restaurée." issues={[]}>
            <span className="small mono">{rejected.message}</span>
            {rejected.restarted ? <span className="small">opencode a été redémarré pour repartir de la configuration précédente.</span> : null}
          </IssuesCallout>
        ) : null}
        {state.loading ? (
          <div className="empty">
            <Spinner large />
          </div>
        ) : state.error ? (
          <div className="callout critical" role="alert">
            <span className="spacer">{state.error}</span>
            <Button size="sm" onClick={() => setTick((t) => t + 1)}>
              Réessayer
            </Button>
          </div>
        ) : (
          <CodeEditor value={content} onChange={setContent} language="json" minHeight={320} maxHeight={640} dark={dark} ariaLabel="Configuration brute d'opencode" />
        )}
      </div>
    </Card>
  );
}

export function OpencodeTab({ onDirtyChange }: { onDirtyChange: (dirty: boolean) => void }) {
  const { boot } = useApp();
  const toast = useToast();
  const confirm = useConfirm();
  const ids = { model: useId(), small: useId() };
  const config = useAsync(() => api.opencodeConfig(), []);
  const cfg = config.data ?? {};
  const [patching, setPatching] = useState<string | null>(null);
  const [rawDirty, setRawDirty] = useState(false);
  const [rawReload, setRawReload] = useState(0);

  const modelSource = { model: typeof cfg.model === "string" ? cfg.model : null, small_model: typeof cfg.small_model === "string" ? cfg.small_model : null };
  const models = useDraft(modelSource);
  const providersSource = Array.isArray(cfg.enabled_providers) ? cfg.enabled_providers.filter((p): p is string => typeof p === "string") : null;
  const providers = useDraft<string[] | null>(providersSource);

  useEffect(() => onDirtyChange(models.dirty || providers.dirty || rawDirty), [models.dirty, providers.dirty, rawDirty, onDirtyChange]);
  useEffect(() => () => onDirtyChange(false), [onDirtyChange]);

  const patch = async (
    section: string,
    body: Record<string, unknown>,
    title: string,
    send: (body: Record<string, unknown>) => Promise<unknown> = api.patchOpencodeConfig,
  ): Promise<boolean> => {
    setPatching(section);
    try {
      await send(body);
      toast.success(title, "opencode a rechargé sa configuration.");
      config.reload();
      setRawReload((n) => n + 1);
      return true;
    } catch (err) {
      toast.error("opencode a refusé la modification", err);
      return false;
    } finally {
      setPatching(null);
    }
  };

  const removed = (["model", "small_model"] as const).filter((k) => models.draft[k] === null && modelSource[k] !== null);
  const saveModels = async () => {
    const body: Record<string, unknown> = {};
    for (const k of ["model", "small_model"] as const) if (models.draft[k] !== null && models.draft[k] !== modelSource[k]) body[k] = models.draft[k];
    if (Object.keys(body).length === 0) return;
    await patch("models", body, "Modèles par défaut enregistrés");
  };

  const providerList = providers.draft ?? [];
  const foreign = providerList.filter((p) => p !== COPILOT);
  const saveProviders = async () => {
    if (foreign.length > 0) {
      const ok = await confirm({
        title: "Autoriser d'autres fournisseurs ?",
        message: `Du code et des conversations pourront être envoyés à : ${foreign.join(", ")}. Vérifiez que c'est autorisé par votre organisation.`,
        confirmLabel: "Autoriser",
        danger: true,
      });
      if (!ok) return;
    }
    await patch("providers", { enabled_providers: providerList }, "Fournisseurs enregistrés");
  };

  const currentPermission = cfg.permission;
  const activePreset = detectPermissionPreset(currentPermission);
  // Mode Simple : la carte « Autonome » n'est pas proposée (seulement affichée si ce profil est déjà actif).
  const advanced = boot.ui?.mode === "avance";
  const visiblePresets = PRESETS.filter((p) => advanced || p.id !== "autonome" || activePreset === "autonome");

  const applyPreset = async (preset: (typeof PRESETS)[number]) => {
    const ok = await confirm({
      title: `Appliquer le profil « ${preset.title} » ?`,
      message: preset.danger
        ? "L'agent pourra modifier des fichiers, lancer n'importe quelle commande et accéder au web sans rien vous demander. À réserver à des projets jetables ou entièrement versionnés."
        : "Les permissions globales d'opencode seront remplacées pour tous les agents qui n'ont pas leurs propres règles.",
      confirmLabel: "Appliquer",
      danger: preset.danger ?? false,
    });
    if (!ok) return;
    // Remplacement complet : aucune ancienne règle du fichier ne survit au profil choisi.
    await patch(`preset-${preset.id}`, presetPermission(preset.id), `Profil « ${preset.title} » appliqué`, api.putOpencodePermission);
  };

  if (config.loading && !config.data) {
    return (
      <div className="card empty">
        <Spinner large />
      </div>
    );
  }
  if (config.error && !config.data) {
    return (
      <div className="callout critical" role="alert">
        <Icon name="alert" size={18} />
        <span className="spacer">{errorText(config.error)} Vérifiez qu'opencode est démarré (page Diagnostic).</span>
        <Button size="sm" icon="refresh" onClick={config.reload}>
          Réessayer
        </Button>
      </div>
    );
  }

  const share = typeof cfg.share === "string" ? cfg.share : null;

  return (
    <div className="stack loose">
      {!advanced ? (
        <div className="callout warning" role="status">
          <Icon name="lock" size={18} />
          <span>{MESSAGES.modeAvance}</span>
        </div>
      ) : null}
      <Card
        title="Modèles par défaut"
        subtitle="Le chat du cockpit choisit toujours l'IA de chaque demande : ces réglages ne servent qu'en dehors du chat, sauf le petit modèle."
      >
        <div className="settings-form">
          <div className="grid-2">
            <Field label="Modèle principal" htmlFor={ids.model}>
              <ModelSelect
                id={ids.model}
                value={models.draft.model}
                models={boot.models}
                emptyLabel="Non défini (choix d'opencode)"
                onChange={(model) => models.setDraft((d) => ({ ...d, model }))}
              />
            </Field>
            <Field label="Petit modèle" htmlFor={ids.small} hint="Sert à générer le titre des conversations.">
              <ModelSelect
                id={ids.small}
                value={models.draft.small_model}
                models={boot.models}
                emptyLabel="Non défini (choix d'opencode)"
                onChange={(small_model) => models.setDraft((d) => ({ ...d, small_model }))}
              />
            </Field>
          </div>
          {removed.length > 0 ? (
            <p className="small muted">Pour retirer complètement un modèle par défaut, supprimez la clé dans le fichier brut ci-dessous.</p>
          ) : null}
          <div className="settings-footer">
            <span className="spacer" />
            <DirtyBadge dirty={models.dirty} />
            <Button disabled={!models.dirty} onClick={models.reset}>
              Annuler
            </Button>
            <Button
              variant="primary"
              icon="check"
              loading={patching === "models"}
              disabled={!models.dirty || removed.length === (["model", "small_model"] as const).filter((k) => models.draft[k] !== modelSource[k]).length}
              onClick={() => void saveModels()}
            >
              Enregistrer
            </Button>
          </div>
        </div>
      </Card>

      <Card title="Fournisseurs autorisés" subtitle="Clé enabled_providers : seuls ces fournisseurs peuvent recevoir vos requêtes.">
        <div className="settings-form">
          {providersSource === null && !providers.dirty ? (
            <div className="callout critical" role="alert">
              <Icon name="shield" size={18} />
              <span>
                <strong>Aucune restriction active.</strong> opencode peut utiliser tous les fournisseurs, y compris les modèles gratuits « OpenCode
                Zen » : du code pourrait partir hors de GitHub Copilot. Ajoutez <code>{COPILOT}</code> ci-dessous puis enregistrez.
              </span>
            </div>
          ) : null}
          {foreign.length > 0 ? (
            <div className="callout critical" role="alert">
              <Icon name="shield" size={18} />
              <span>
                <strong>Attention :</strong> {foreign.join(", ")} {foreign.length > 1 ? "recevront" : "recevra"} du code et des conversations si{" "}
                {foreign.length > 1 ? "ils sont utilisés" : "il est utilisé"}. Seul <code>{COPILOT}</code> est recommandé.
              </span>
            </div>
          ) : null}
          {providers.draft !== null && providerList.length === 0 ? (
            <div className="callout warning">
              <Icon name="alert" size={18} />
              <span>Liste vide : aucun modèle ne sera disponible.</span>
            </div>
          ) : null}
          <TokenListEditor
            label="Fournisseurs autorisés"
            values={providerList}
            mono
            placeholder="github-copilot"
            validate={(v) => (/^[a-z0-9][a-z0-9._-]*$/i.test(v) ? (providerList.includes(v) ? "Déjà présent." : null) : "Identifiant de fournisseur invalide.")}
            onChange={(values) => providers.setDraft(values)}
          />
          <div className="settings-footer">
            {!providerList.includes(COPILOT) || foreign.length > 0 ? (
              <Button variant="ghost" icon="shield" onClick={() => providers.setDraft([COPILOT])}>
                Revenir à GitHub Copilot seul
              </Button>
            ) : null}
            <span className="spacer" />
            <DirtyBadge dirty={providers.dirty} />
            <Button disabled={!providers.dirty} onClick={providers.reset}>
              Annuler
            </Button>
            <Button variant="primary" icon="check" loading={patching === "providers"} disabled={!providers.dirty} onClick={() => void saveProviders()}>
              Enregistrer
            </Button>
          </div>
        </div>
      </Card>

      <Card title="Partage des conversations" subtitle="Publication de conversations sur opencode.ai (clé share).">
        <div className="row wrap">
          <span className="small secondary">Valeur actuelle :</span>
          <Badge tone={share === "disabled" ? "good" : "warning"}>{share ?? "non définie (manuel)"}</Badge>
          <span className="spacer" />
          {share !== "disabled" ? (
            <Button variant="primary" icon="lock" loading={patching === "share"} onClick={() => void patch("share", { share: "disabled" }, "Partage désactivé")}>
              Désactiver le partage
            </Button>
          ) : null}
        </div>
        <p className="small muted" style={{ marginTop: 8 }}>
          Recommandé : <code>disabled</code>. Le cockpit bloque déjà les routes de partage, mais la valeur protège aussi les autres clients d'opencode.
        </p>
      </Card>

      <Card title="Permissions globales" subtitle="Ce que les agents peuvent faire sans vous demander. Les agents du Studio peuvent les surcharger.">
        <div className="stack">
          <div className="preset-grid">
            {visiblePresets.map((preset) => (
              <div key={preset.id} className={`preset-card${activePreset === preset.id ? " active" : ""}${preset.danger ? " danger" : ""}`}>
                <div className="row between">
                  <strong>{preset.title}</strong>
                  {activePreset === preset.id ? <Badge tone="accent">actif</Badge> : preset.danger ? <Badge tone="critical">risqué</Badge> : null}
                </div>
                <p className="small secondary">{preset.summary}</p>
                <ul>
                  {preset.points.map((p) => (
                    <li key={p}>{p}</li>
                  ))}
                </ul>
                <div style={{ marginTop: "auto" }}>
                  <Button
                    size="sm"
                    variant={preset.danger ? "danger" : "default"}
                    loading={patching === `preset-${preset.id}`}
                    disabled={activePreset === preset.id || patching !== null}
                    onClick={() => void applyPreset(preset)}
                  >
                    Appliquer
                  </Button>
                </div>
              </div>
            ))}
          </div>
          <p className="small muted">
            Dans les règles par motif, la dernière règle correspondante l'emporte. Appliquer un profil remplace toutes les permissions globales du
            fichier ; le fichier brut permet un contrôle total.
          </p>
          <div className="stack tight">
            <span className="field-label">Permissions actuelles{activePreset ? "" : " (personnalisées)"}</span>
            <pre className="json-preview mono">{currentPermission === undefined ? "(non définies : valeurs par défaut d'opencode)" : JSON.stringify(currentPermission, null, 2)}</pre>
          </div>
        </div>
      </Card>

      <RawConfigEditor reloadToken={rawReload} onDirty={setRawDirty} onSaved={config.reload} />
    </div>
  );
}
