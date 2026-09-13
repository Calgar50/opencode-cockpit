// Assistant de création en 5 étapes (§9.5) : créer, « Modifier » ou « Compléter » un assistant, avec aperçu en direct.
import { type CSSProperties, useEffect, useId, useMemo, useRef, useState } from "react";
import {
  COMMON_RULES_NOTE,
  DRAFT_LIMITS,
  FICHE_NAME_RE,
  MESSAGES,
  perRequestText,
  RESERVED_HELP,
  RIGHTS_INFO,
  stripCommonRules,
  TASK_SIZE_HINT,
  TASK_SIZE_LABELS,
  TASK_SIZES,
  USE_CASE_INFO,
  USE_CASES,
  VARIANT_HELP,
} from "../../../server/shared/assistant-rules.ts";
import { useApp } from "../../app/AppContext.tsx";
import { Icon } from "../../components/Icon.tsx";
import { useToast } from "../../components/Toast.tsx";
import { Button, EmptyState, IconButton, Spinner, useAsync, useConfirm } from "../../components/ui.tsx";
import { ApiError, api, oc } from "../../lib/api.ts";
import { openAssistants, openChatWithAssistant, setNavigationGuard } from "../../lib/router.ts";
import type {
  AssistantDraft,
  AssistantPreview,
  AssistantSaveRequest,
  AssistantView,
  OcAgent,
  RightsLabel,
  RightsProfile,
  SavedAssistant,
  Tier,
  TierView,
  UseCase,
  ValidationIssue,
} from "../../lib/types.ts";
import { assistantErrorText, isRejected, technicalDetail } from "./errors.ts";
import { IdentityCard, type IdentityData, identityOfView } from "./IdentityCard.tsx";
import { TierCards, TierSelectionNote, unavailableTierText } from "./TierCards.tsx";
import { emptyDraft, humanizeName, isPresetInstructions, removeFicheSentence, USE_CASE_PRESETS, withFicheSentences } from "./templates.ts";

export type WizardMode = "nouveau" | "modifier" | "completer";

const STEPS = ["Le besoin", "Les droits", "L'IA", "Consignes et fiches", "Vérifier"] as const;
const LAST_STEP = STEPS.length - 1;

type FieldKey = "title" | "description" | "tier" | "model" | "instructions" | "examples" | "confirm";

const FIELD_STEP: Readonly<Record<FieldKey, number>> = { title: 0, description: 0, tier: 2, model: 2, instructions: 3, examples: 3, confirm: 4 };

/** Étape où corriger une erreur du serveur (chemin zod « title », « tier », « fiches.0 »…). */
function issueStep(path: string): number {
  switch (path.split(".")[0]) {
    case "title":
    case "description":
    case "useCase":
    case "icon":
    case "name":
      return 0;
    case "rights":
    case "web":
      return 1;
    case "tier":
    case "model":
    case "reflection":
    case "taskSize":
      return 2;
    case "instructions":
    case "fiches":
    case "examples":
      return 3;
    default:
      return LAST_STEP;
  }
}

interface WizardSource {
  draft: AssistantDraft;
  /** Nom actuel (modification, complétion) ; null à la création. */
  previousName: string | null;
  view: AssistantView | null;
  originalRights: RightsLabel | null;
  /** IA précise d'origine (sans niveau), pour l'avertissement du mode Simple. */
  originalPreciseModel: string | null;
  displayName: string;
}

function draftFromView(view: AssistantView, advanced: boolean, tiers: readonly TierView[]): AssistantDraft {
  const inferred = tiers.find((t) => t.model !== null && t.model === view.model)?.id ?? null;
  const tier: Tier | null = view.tier ?? (advanced && view.model ? null : (inferred ?? "equilibre"));
  const useCase = view.useCase ?? "autre";
  return {
    title: view.title,
    description: view.description,
    useCase,
    rights: view.rights === "propose" ? "propose" : "lecture",
    web: view.web,
    tier,
    model: tier === null ? view.model : null,
    reflection: view.variant === "high" ? "poussee" : "standard",
    taskSize: view.taskSize,
    instructions: view.instructions,
    fiches: view.fiches.slice(0, DRAFT_LIMITS.fichesMax),
    examples: view.examples.slice(0, DRAFT_LIMITS.examplesMax),
    icon: view.icon ?? USE_CASE_INFO[useCase].icon,
  };
}

async function loadSource(mode: WizardMode, name: string | null, advanced: boolean, tiers: readonly TierView[]): Promise<WizardSource | null> {
  if (mode === "nouveau" || !name) {
    return { draft: emptyDraft(), previousName: null, view: null, originalRights: null, originalPreciseModel: null, displayName: "" };
  }
  if (mode === "modifier") {
    const data = await api.assistants();
    const view = data.assistants.find((a) => a.name === name);
    if (!view) return null;
    return {
      draft: draftFromView(view, advanced, tiers),
      previousName: view.name,
      view,
      originalRights: view.rights,
      originalPreciseModel: view.tier === null && view.model ? (view.modelName ?? view.model) : null,
      displayName: view.title,
    };
  }
  const [data, agents] = await Promise.all([api.assistants(), oc.agents().catch((): OcAgent[] => [])]);
  const item = data.toComplete.find((i) => i.name === name);
  if (!item) return null;
  const prompt = agents.find((a) => a.name === name)?.prompt;
  const tier: Tier | null = item.inferredTier ?? (advanced && item.model ? null : "equilibre");
  return {
    draft: {
      ...emptyDraft("autre"),
      title: humanizeName(name).slice(0, DRAFT_LIMITS.titleMax),
      description: item.description.slice(0, DRAFT_LIMITS.descriptionMax),
      rights: item.rights === "propose" ? "propose" : "lecture",
      web: item.rightLines.some((l) => l.id === "internet" && l.action === "ask"),
      tier,
      model: tier === null ? item.model : null,
      reflection: item.variant === "high" ? "poussee" : "standard",
      instructions: prompt ? stripCommonRules(prompt).slice(0, DRAFT_LIMITS.instructionsMax) : USE_CASE_PRESETS.autre.instructions,
    },
    previousName: name,
    view: null,
    originalRights: item.rights,
    originalPreciseModel: item.inferredTier === null && item.model ? (item.modelName ?? item.model) : null,
    displayName: name,
  };
}

/** Corps envoyé à l'aperçu et à l'enregistrement (textes nettoyés, IA précise seulement sans niveau). */
function toRequest(d: AssistantDraft, previousName: string | null): AssistantSaveRequest {
  const request: AssistantSaveRequest = {
    title: d.title.trim(),
    description: d.description.trim(),
    useCase: d.useCase,
    rights: d.rights,
    web: d.web,
    tier: d.tier,
    reflection: d.reflection,
    taskSize: d.taskSize,
    instructions: d.instructions.trim(),
    fiches: d.fiches,
    examples: d.examples.map((e) => e.trim()).filter(Boolean),
    icon: d.icon,
  };
  if (d.tier === null) request.model = d.model ?? null;
  if (previousName) request.previousName = previousName;
  return request;
}

function clientErrors(d: AssistantDraft, tierView: TierView | undefined, confirmed: boolean): Partial<Record<FieldKey, string>> {
  const errors: Partial<Record<FieldKey, string>> = {};
  const title = d.title.trim();
  if (title.length < DRAFT_LIMITS.titleMin) errors.title = "Donnez un nom à l'assistant (3 caractères au moins).";
  else if (title.length > DRAFT_LIMITS.titleMax) errors.title = `Le nom est trop long (${DRAFT_LIMITS.titleMax} caractères au plus).`;
  const description = d.description.trim();
  if (description.length === 0) errors.description = "Cette phrase est obligatoire : elle explique son rôle à l'IA.";
  else if (description.length < DRAFT_LIMITS.descriptionMin) errors.description = "Cette phrase est trop courte (10 caractères au moins).";
  else if (description.length > DRAFT_LIMITS.descriptionMax) errors.description = `Cette phrase est trop longue (${DRAFT_LIMITS.descriptionMax} caractères au plus).`;
  if (d.tier === null && !d.model) errors.model = "Choisissez une IA.";
  if (d.tier !== null && tierView?.status === "indisponible") errors.tier = unavailableTierText(d.tier);
  const instructions = d.instructions.trim();
  if (instructions.length < DRAFT_LIMITS.instructionsMin) errors.instructions = "Les consignes sont trop courtes (20 caractères au moins).";
  else if (instructions.length > DRAFT_LIMITS.instructionsMax) errors.instructions = "Les consignes sont trop longues (20 000 caractères au plus).";
  if (d.examples.some((e) => e.trim().length > DRAFT_LIMITS.exampleMax)) errors.examples = `Un exemple fait ${DRAFT_LIMITS.exampleMax} caractères au plus.`;
  if (d.rights === "propose" && !confirmed) errors.confirm = "Cochez cette case pour confirmer que vous avez lu ce que cet assistant a le droit de faire.";
  return errors;
}

/** Page de l'assistant de création : charge la source (création, modification, complétion) puis affiche le formulaire. */
export function AssistantWizard({ mode, name }: { mode: WizardMode; name: string | null }) {
  const { boot, advanced } = useApp();
  const source = useAsync(() => loadSource(mode, name, advanced, boot.ai?.tiers ?? []), [mode, name]);

  if (source.loading && !source.data) {
    return (
      <div className="page">
        <div className="empty">
          <Spinner large />
        </div>
      </div>
    );
  }
  if (source.error) {
    return (
      <div className="page">
        <EmptyState
          icon="alert"
          title="Impossible d'ouvrir l'assistant"
          action={
            <Button icon="refresh" onClick={source.reload}>
              Réessayer
            </Button>
          }
        >
          {assistantErrorText(source.error)}
        </EmptyState>
      </div>
    );
  }
  if (!source.data) {
    return (
      <div className="page">
        <EmptyState
          icon="search"
          title="Assistant introuvable"
          action={
            <Button icon="chevronLeft" onClick={() => openAssistants()}>
              Retour aux assistants
            </Button>
          }
        >
          « {name} » n'existe pas ou n'est plus à compléter.
        </EmptyState>
      </div>
    );
  }
  return <WizardForm mode={mode} source={source.data} />;
}

function WizardForm({ mode, source }: { mode: WizardMode; source: WizardSource }) {
  const { boot, advanced, modelByKey } = useApp();
  const toast = useToast();
  const confirm = useConfirm();
  const ids = { title: useId(), description: useId(), instructions: useId(), model: useId(), radios: useId() };
  const pageRef = useRef<HTMLDivElement>(null);
  const tiers = boot.ai?.tiers ?? [];
  const allowedProviders = boot.allowedProviders ?? ["github-copilot"];

  const initialJson = useMemo(() => JSON.stringify(source.draft), [source]);
  const [draft, setDraft] = useState<AssistantDraft>(source.draft);
  const [step, setStep] = useState(0);
  const [attempted, setAttempted] = useState<readonly boolean[]>(() => STEPS.map(() => false));
  const [confirmed, setConfirmed] = useState(false);
  const [preview, setPreview] = useState<AssistantPreview | null>(null);
  const [previewKey, setPreviewKey] = useState("");
  const [previewError, setPreviewError] = useState<unknown>(null);
  const [saveIssues, setSaveIssues] = useState<{ key: string; issues: ValidationIssue[] }>({ key: "", issues: [] });
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<unknown>(null);
  const [saved, setSaved] = useState<SavedAssistant | null>(null);
  const fiches = useAsync(() => api.fiches(), []);

  const request = useMemo(() => toRequest(draft, source.previousName), [draft, source.previousName]);
  const requestJson = JSON.stringify(request);
  const previewFresh = preview !== null && previewKey === requestJson;
  const dirty = saved === null && JSON.stringify(draft) !== initialJson;
  const tierView = draft.tier ? tiers.find((t) => t.id === draft.tier) : undefined;
  const usedModel = draft.tier !== null ? (tierView?.model ?? null) : (draft.model ?? null);
  const usedModelInfo = modelByKey(usedModel);
  const offersHigh = usedModelInfo?.variants.includes("high") ?? false;
  const creating = mode === "nouveau";

  // Aperçu en direct : 300 ms après la dernière modification, réponses dépassées ignorées.
  useEffect(() => {
    if (saved) return;
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      api.previewAssistant(JSON.parse(requestJson) as AssistantSaveRequest, controller.signal).then(
        (result) => {
          if (controller.signal.aborted) return;
          setPreview(result);
          setPreviewKey(requestJson);
          setPreviewError(null);
        },
        (err: unknown) => {
          if (!controller.signal.aborted) setPreviewError(err);
        },
      );
    }, 300);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [requestJson, saved]);

  // Quitter la page avec une saisie non enregistrée : confirmation (navigation interne et fermeture de l'onglet).
  useEffect(() => {
    if (!dirty) return;
    const remove = setNavigationGuard(() =>
      confirm({
        title: creating ? "Quitter sans créer l'assistant ?" : "Quitter sans enregistrer les modifications ?",
        message: "Ce que vous avez saisi sera perdu.",
        confirmLabel: "Quitter",
        cancelLabel: creating ? "Continuer la création" : "Continuer la modification",
        danger: true,
      }),
    );
    const onBeforeUnload = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => {
      remove();
      window.removeEventListener("beforeunload", onBeforeUnload);
    };
  }, [dirty, creating, confirm]);

  // « Poussée » n'existe que si l'IA propose la réflexion « high ».
  useEffect(() => {
    if (draft.reflection === "poussee" && usedModelInfo && !usedModelInfo.variants.includes("high")) {
      setDraft((d) => ({ ...d, reflection: "standard" }));
    }
  }, [draft.reflection, usedModelInfo]);

  const preciseModels = useMemo(() => {
    const cost = (key: string) => modelByKey(key)?.taskCost?.[draft.taskSize] ?? Number.POSITIVE_INFINITY;
    const list = boot.models
      .filter((m) => allowedProviders.includes(m.providerID) && m.toolcall !== false && m.status !== "deprecated")
      .sort((a, b) => cost(a.key) - cost(b.key) || a.name.localeCompare(b.name));
    return { normal: list.filter((m) => !m.reserved), reserved: list.filter((m) => m.reserved) };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [boot.models, allowedProviders.join(","), draft.taskSize]);

  const ficheList = useMemo(() => {
    const known = (fiches.data ?? []).map((f) => ({ ...f, missing: false }));
    const names = new Set(known.map((f) => f.name));
    const extra = fiches.data ? draft.fiches.filter((f) => !names.has(f)).map((f) => ({ name: f, description: "", missing: true })) : [];
    return [...known, ...extra];
  }, [fiches.data, draft.fiches]);

  const errors = clientErrors(draft, tierView, confirmed);
  const serverIssues: ValidationIssue[] = [
    ...(previewFresh && preview ? preview.issues : []),
    ...(saveIssues.key === requestJson ? saveIssues.issues : []),
  ];
  const serverFieldError = (key: FieldKey) => serverIssues.find((i) => i.path.split(".")[0] === key)?.message ?? null;
  const fieldError = (key: FieldKey): string | null => (attempted[FIELD_STEP[key]] ? (errors[key] ?? serverFieldError(key)) : null);
  const stepBlocked = (s: number) =>
    (Object.keys(errors) as FieldKey[]).some((k) => FIELD_STEP[k] === s) || (s < LAST_STEP && serverIssues.some((i) => issueStep(i.path) === s));
  const markAttempted = (upTo: number) => setAttempted((a) => a.map((v, i) => v || i <= upTo));
  const scrollTop = () => pageRef.current?.scrollTo({ top: 0 });

  const goToStep = (target: number) => {
    if (target <= step) {
      setStep(target);
      scrollTop();
      return;
    }
    for (let s = step; s < target; s++) {
      if (stepBlocked(s)) {
        markAttempted(s);
        setStep(s);
        scrollTop();
        return;
      }
    }
    setStep(target);
    scrollTop();
  };

  const goNext = () => {
    markAttempted(step);
    if (stepBlocked(step)) return;
    setStep(Math.min(LAST_STEP, step + 1));
    scrollTop();
  };

  const applyUseCase = (useCase: UseCase) => {
    const preset = USE_CASE_PRESETS[useCase];
    if (creating && preset.rights !== draft.rights) setConfirmed(false);
    setDraft((d) => {
      const next: AssistantDraft = { ...d, useCase, icon: USE_CASE_INFO[useCase].icon };
      if (isPresetInstructions(d.instructions)) next.instructions = withFicheSentences(preset.instructions, d.fiches);
      if (creating) {
        next.rights = preset.rights;
        next.taskSize = preset.taskSize;
        if (d.tier !== null) next.tier = preset.tier;
      }
      return next;
    });
  };

  const setRights = (rights: RightsProfile) => {
    if (rights !== draft.rights) setConfirmed(false);
    setDraft((d) => ({ ...d, rights }));
  };

  const toggleFiche = (fiche: string, on: boolean) =>
    setDraft((d) => {
      if (!on) return { ...d, fiches: d.fiches.filter((f) => f !== fiche), instructions: removeFicheSentence(d.instructions, fiche) };
      if (d.fiches.includes(fiche) || d.fiches.length >= DRAFT_LIMITS.fichesMax) return d;
      return { ...d, fiches: [...d.fiches, fiche], instructions: withFicheSentences(d.instructions, [fiche]) };
    });

  const restoreExample = async () => {
    const example = withFicheSentences(USE_CASE_PRESETS[draft.useCase].instructions, draft.fiches);
    if (draft.instructions === example) return;
    if (!isPresetInstructions(draft.instructions)) {
      const ok = await confirm({
        title: "Rétablir l'exemple ?",
        message: "Vos consignes actuelles seront remplacées par l'exemple du type de tâche choisi.",
        confirmLabel: "Rétablir l'exemple",
      });
      if (!ok) return;
    }
    setDraft((d) => ({ ...d, instructions: example }));
  };

  const save = async () => {
    markAttempted(LAST_STEP);
    for (let s = 0; s <= LAST_STEP; s++) {
      if (stepBlocked(s)) {
        setStep(s);
        scrollTop();
        return;
      }
    }
    setSaving(true);
    setSaveError(null);
    const body = toRequest(draft, source.previousName);
    const key = JSON.stringify(body);
    try {
      const fresh = await api.previewAssistant(body);
      setPreview(fresh);
      setPreviewKey(key);
      setPreviewError(null);
      if (fresh.issues.length > 0) {
        setStep(Math.min(...fresh.issues.map((i) => issueStep(i.path))));
        scrollTop();
        return;
      }
      const result = await api.saveAssistant(source.previousName ?? fresh.name, body);
      setSaved(result);
      if (creating) {
        toast.success("Assistant créé", `« ${result.title} » est prêt.`, {
          label: "Essayer dans le chat",
          onClick: () => openChatWithAssistant(result.name),
        });
      }
      else toast.success("Modifications enregistrées", `« ${result.title} » est à jour.`);
      scrollTop();
    } catch (err) {
      if (err instanceof ApiError && err.code === "validation" && err.issues.length > 0) {
        setSaveIssues({ key, issues: err.issues });
        setStep(Math.min(...err.issues.map((i) => issueStep(i.path))));
        scrollTop();
      } else {
        setSaveError(err);
      }
    } finally {
      setSaving(false);
    }
  };

  const copyDetail = (text: string) => {
    navigator.clipboard.writeText(text).then(
      () => toast.success("Détail copié"),
      () => toast.error("Copie impossible", "Le navigateur a refusé l'accès au presse-papiers."),
    );
  };

  if (saved) {
    return (
      <div className="page" ref={pageRef}>
        <div className="page-narrow wiz-done stack loose">
          <header className="page-header" style={{ marginBottom: 0 }}>
            <div className="spacer" style={{ minWidth: 0 }}>
              <h1>{creating ? "Assistant créé" : "Modifications enregistrées"}</h1>
              <p>Enregistré pour tous vos projets.</p>
            </div>
          </header>
          {saved.rulesDiffer ? (
            <div className="callout warning" role="alert">
              <Icon name="alert" size={18} />
              <span>Les droits réellement appliqués diffèrent de l'aperçu. Vérifiez la carte ci-dessous.</span>
            </div>
          ) : (
            <div className="callout good" role="status">
              <Icon name="check" size={18} />
              <span>« {saved.title} » est prêt.</span>
            </div>
          )}
          <IdentityCard data={identityOfView(saved)} />
          <div className="row wrap">
            <Button variant="primary" icon="chat" onClick={() => openChatWithAssistant(saved.name)}>
              Essayer dans le chat
            </Button>
            <Button onClick={() => openAssistants()}>Voir mes assistants</Button>
          </div>
        </div>
      </div>
    );
  }

  const previewData: IdentityData = {
    title: draft.title,
    description: draft.description,
    rights: draft.rights,
    rightLines: preview?.rightLines ?? [],
    model: preview?.model ?? usedModel,
    modelName: preview?.modelName ?? (draft.tier !== null ? (tierView?.modelName ?? null) : (usedModelInfo?.name ?? null)),
    tier: draft.tier,
    tierStatus: draft.tier !== null ? (preview?.status ?? tierView?.status ?? null) : null,
    variant: preview?.variant ?? null,
    estimate: preview?.estimate ?? null,
    guardNote: preview?.guardNote ?? null,
    fiches: draft.fiches,
    usedBy: source.view?.usedBy ?? null,
    examples: draft.examples.map((e) => e.trim()).filter(Boolean),
  };
  const updating = !previewFresh && !previewError;
  const pageTitle = creating ? "Créer un assistant" : mode === "modifier" ? `Modifier « ${source.displayName} »` : `Compléter « ${source.displayName} »`;
  const preciseSelected = draft.model ? modelByKey(draft.model) : undefined;
  const generalIssues = serverIssues.filter((i) => issueStep(i.path) === LAST_STEP);

  return (
    <div className="page" ref={pageRef}>
      <div className="page-narrow">
        <header className="page-header">
          <Button variant="ghost" icon="chevronLeft" onClick={() => openAssistants()}>
            Assistants
          </Button>
          <div className="spacer" style={{ minWidth: 0 }}>
            <h1 className="ellipsis">{pageTitle}</h1>
            <p>
              Étape {step + 1} sur {STEPS.length}
            </p>
          </div>
        </header>

        <ol className="wiz-steps" aria-label="Étapes">
          {STEPS.map((label, i) => (
            <li key={label}>
              <button
                type="button"
                className={`wiz-step${i === step ? " current" : ""}${i < step ? " done" : ""}`}
                aria-current={i === step ? "step" : undefined}
                onClick={() => goToStep(i)}
              >
                <span className="wiz-step-num" aria-hidden>
                  {i < step ? <Icon name="check" size={12} /> : i + 1}
                </span>
                <span className="wiz-step-label">{label}</span>
              </button>
            </li>
          ))}
        </ol>

        <div className={`wiz-layout${step === LAST_STEP ? " single" : ""}`}>
          <div className="wiz-main card stack">
            {step === 0 ? (
              <>
                <h2>Que doit faire cet assistant ?</h2>
                <div className="field">
                  <label htmlFor={ids.title}>Nom de l'assistant</label>
                  <input
                    id={ids.title}
                    className="input"
                    value={draft.title}
                    maxLength={DRAFT_LIMITS.titleMax}
                    placeholder="Relire un script avant mise en production"
                    aria-invalid={fieldError("title") ? true : undefined}
                    onChange={(e) => setDraft((d) => ({ ...d, title: e.target.value }))}
                  />
                  {fieldError("title") ? (
                    <span className="field-error">{fieldError("title")}</span>
                  ) : (
                    <span className="field-hint">Un verbe et une tâche. C'est ce que vous verrez dans le chat.</span>
                  )}
                </div>
                <div className="field">
                  <span className="field-label" id={`${ids.radios}-uc`}>
                    Type de tâche
                  </span>
                  <div className="wiz-usecases" role="radiogroup" aria-labelledby={`${ids.radios}-uc`}>
                    {USE_CASES.map((uc) => (
                      <button
                        key={uc}
                        type="button"
                        role="radio"
                        aria-checked={draft.useCase === uc}
                        className={`wiz-usecase${draft.useCase === uc ? " selected" : ""}`}
                        style={{ "--uc-color": USE_CASE_INFO[uc].color } as CSSProperties}
                        onClick={() => applyUseCase(uc)}
                      >
                        <span className="row" style={{ gap: 6 }}>
                          <Icon name={USE_CASE_INFO[uc].icon} size={16} />
                          <strong>{USE_CASE_INFO[uc].label}</strong>
                        </span>
                        {USE_CASE_INFO[uc].hint ? <span className="small secondary">{USE_CASE_INFO[uc].hint}</span> : null}
                      </button>
                    ))}
                  </div>
                  <span className="field-hint">
                    {creating
                      ? "Pré-remplit les droits, le niveau d'IA, la taille des demandes et les consignes."
                      : "Change l'icône et la couleur de l'assistant."}
                  </span>
                </div>
                <div className="field">
                  <label htmlFor={ids.description}>En une phrase, quand l'utiliser ?</label>
                  <textarea
                    id={ids.description}
                    className="textarea"
                    rows={2}
                    value={draft.description}
                    maxLength={DRAFT_LIMITS.descriptionMax}
                    placeholder="Relit un script PowerShell ou Bash et signale les risques avant une mise en production."
                    aria-invalid={fieldError("description") ? true : undefined}
                    onChange={(e) => setDraft((d) => ({ ...d, description: e.target.value }))}
                  />
                  {fieldError("description") ? (
                    <span className="field-error">{fieldError("description")}</span>
                  ) : (
                    <span className="field-hint">L'IA lit cette phrase : soyez précis.</span>
                  )}
                </div>
              </>
            ) : null}

            {step === 1 ? (
              <>
                <h2>Ce que l'assistant a le droit de faire</h2>
                {source.originalRights === "personnalise" ? (
                  <div className="callout warning">
                    <Icon name="alert" size={18} />
                    <span>
                      Droits actuels : {RIGHTS_INFO.personnalise.label} (réglés dans le Studio). Enregistrer ici les remplace par le profil choisi
                      ci-dessous.
                    </span>
                  </div>
                ) : null}
                <div className="wiz-choices" role="radiogroup" aria-label="Droits de l'assistant">
                  {(["lecture", "propose"] as const).map((rights) => (
                    <label key={rights} className={`choice-card${draft.rights === rights ? " selected" : ""}`}>
                      <input type="radio" name={`${ids.radios}-rights`} checked={draft.rights === rights} onChange={() => setRights(rights)} />
                      <span className="stack tight">
                        <strong>{rights === "lecture" ? "Lecture seule — recommandé" : RIGHTS_INFO.propose.label}</strong>
                        <span className="small secondary">{RIGHTS_INFO[rights].help}</span>
                      </span>
                    </label>
                  ))}
                </div>
                <label className={`choice-card${draft.web ? " selected" : ""}`}>
                  <input type="checkbox" checked={draft.web} onChange={(e) => setDraft((d) => ({ ...d, web: e.target.checked }))} />
                  <span className="stack tight">
                    <strong>Consulter Internet (sur demande)</strong>
                    <span className="small secondary">
                      Utile pour vérifier une faille (CVE). Chaque consultation vous est demandée. Une adresse web peut contenir des données : refusez en
                      cas de doute.
                    </span>
                  </span>
                </label>
                <div className="callout accent">
                  <Icon name="shield" size={18} />
                  <span>
                    Dans tous les cas, l'assistant ne délègue jamais son travail, n'ouvre jamais les fichiers de clés (.pfx, .key, .jks…), et tout ce
                    que vous lui envoyez part chez GitHub Copilot.
                  </span>
                </div>
                {advanced ? <p className="small muted">Autres réglages de droits : Studio avancé.</p> : null}
              </>
            ) : null}

            {step === 2 ? (
              <>
                <h2>Quelle IA pour cette tâche ?</h2>
                {source.originalPreciseModel && !advanced ? (
                  <div className="callout warning">
                    <Icon name="alert" size={18} />
                    <span>
                      Cet assistant utilise une IA précise (« {source.originalPreciseModel} »). En mode Simple, choisissez un niveau : il remplacera
                      cette IA à l'enregistrement.
                    </span>
                  </div>
                ) : null}
                <TierCards value={draft.tier} size={draft.taskSize} tiers={tiers} onChange={(tier) => setDraft((d) => ({ ...d, tier, model: null }))} />
                {draft.tier !== null ? <TierSelectionNote tier={draft.tier} view={tierView} /> : null}
                {draft.tier !== null && tierView?.status !== "indisponible" && fieldError("tier") ? (
                  <span className="field-error">{fieldError("tier")}</span>
                ) : null}

                {advanced ? (
                  <div className="stack tight">
                    <label className="check-row">
                      <input
                        type="checkbox"
                        checked={draft.tier === null}
                        onChange={(e) => {
                          const precise = e.target.checked;
                          setDraft((d) =>
                            precise
                              ? { ...d, tier: null, model: d.model ?? tierView?.model ?? null }
                              : { ...d, tier: USE_CASE_PRESETS[d.useCase].tier, model: null },
                          );
                        }}
                      />
                      <span>Choisir une IA précise</span>
                    </label>
                    {draft.tier === null ? (
                      <div className="field">
                        <label htmlFor={ids.model}>IA précise</label>
                        <select
                          id={ids.model}
                          className="select"
                          value={draft.model ?? ""}
                          onChange={(e) => setDraft((d) => ({ ...d, model: e.target.value || null }))}
                        >
                          <option value="">Choisir une IA…</option>
                          {draft.model && !preciseSelected ? <option value={draft.model}>{draft.model} (absente du catalogue)</option> : null}
                          <optgroup label="IA GitHub Copilot (de la moins chère à la plus chère)">
                            {preciseModels.normal.map((m) => (
                              <option key={m.key} value={m.key}>
                                {m.name}
                                {m.taskCost ? ` · ${perRequestText(m.taskCost[draft.taskSize])}` : ""}
                              </option>
                            ))}
                          </optgroup>
                          {preciseModels.reserved.length > 0 ? (
                            <optgroup label="Réservé (très cher)">
                              {preciseModels.reserved.map((m) => (
                                <option key={m.key} value={m.key}>
                                  {m.name}
                                  {m.taskCost ? ` · ${perRequestText(m.taskCost[draft.taskSize])}` : ""}
                                </option>
                              ))}
                            </optgroup>
                          ) : null}
                        </select>
                        {fieldError("model") ? (
                          <span className="field-error">{fieldError("model")}</span>
                        ) : (
                          <span className="field-hint">{preciseSelected?.reserved ? RESERVED_HELP : "L'IA reste fixe : elle ne suit plus les niveaux."}</span>
                        )}
                      </div>
                    ) : null}
                  </div>
                ) : null}

                <div className="field">
                  <span className="field-label" id={`${ids.radios}-size`}>
                    Taille habituelle des demandes
                  </span>
                  <div className="wiz-pills" role="radiogroup" aria-labelledby={`${ids.radios}-size`}>
                    {TASK_SIZES.map((size) => (
                      <label key={size} className={`choice-pill${draft.taskSize === size ? " selected" : ""}`}>
                        <input
                          type="radio"
                          name={`${ids.radios}-size`}
                          checked={draft.taskSize === size}
                          onChange={() => setDraft((d) => ({ ...d, taskSize: size }))}
                        />
                        {TASK_SIZE_LABELS[size]}
                      </label>
                    ))}
                  </div>
                  <span className="field-hint">{TASK_SIZE_HINT}</span>
                </div>

                {offersHigh || draft.reflection === "poussee" ? (
                  <div className="field">
                    <span className="field-label" id={`${ids.radios}-reflection`} title={VARIANT_HELP}>
                      Réflexion
                    </span>
                    <div className="wiz-pills" role="radiogroup" aria-labelledby={`${ids.radios}-reflection`}>
                      {(["standard", "poussee"] as const).map((reflection) => (
                        <label key={reflection} className={`choice-pill${draft.reflection === reflection ? " selected" : ""}`}>
                          <input
                            type="radio"
                            name={`${ids.radios}-reflection`}
                            checked={draft.reflection === reflection}
                            onChange={() => setDraft((d) => ({ ...d, reflection }))}
                          />
                          {reflection === "standard" ? "Standard (recommandé)" : "Poussée — plus lente et plus chère"}
                        </label>
                      ))}
                    </div>
                    <span className="field-hint">{VARIANT_HELP}</span>
                  </div>
                ) : null}
                <p className="small muted">{MESSAGES.estimateFootnote}</p>
              </>
            ) : null}

            {step === 3 ? (
              <>
                <h2>Consignes et fiches</h2>
                <div className="field">
                  <div className="row between wrap">
                    <label htmlFor={ids.instructions}>Consignes</label>
                    <Button size="sm" variant="ghost" icon="undo" onClick={() => void restoreExample()}>
                      Rétablir l'exemple
                    </Button>
                  </div>
                  <textarea
                    id={ids.instructions}
                    className="textarea wiz-instructions"
                    rows={12}
                    value={draft.instructions}
                    maxLength={DRAFT_LIMITS.instructionsMax}
                    aria-invalid={fieldError("instructions") ? true : undefined}
                    onChange={(e) => setDraft((d) => ({ ...d, instructions: e.target.value }))}
                  />
                  {fieldError("instructions") ? (
                    <span className="field-error">{fieldError("instructions")}</span>
                  ) : (
                    <span className="field-hint">
                      Écrivez comme à un nouveau collègue : ce qu'il doit faire, dans quel ordre, ce qu'il ne doit jamais faire et la forme de la réponse.
                    </span>
                  )}
                </div>
                <div className="callout">
                  <Icon name="shield" size={16} />
                  <span className="small">{COMMON_RULES_NOTE}</span>
                </div>

                <div className="field">
                  <span className="field-label">Fiches à consulter</span>
                  <span className="field-hint">
                    Une fiche n'a pas d'IA à elle : l'assistant la lit avec sa propre IA. Il ne pourra ouvrir que les fiches cochées.
                  </span>
                  {fiches.loading && !fiches.data ? (
                    <Spinner />
                  ) : fiches.error && !fiches.data ? (
                    <p className="small muted">Liste des fiches indisponible pour le moment : les fiches déjà choisies sont conservées.</p>
                  ) : ficheList.length === 0 ? (
                    <p className="small muted">
                      Aucune fiche disponible. Les fiches prêtes à l'emploi s'installent avec les assistants du catalogue ; les autres se créent dans le
                      Studio avancé.
                    </p>
                  ) : (
                    <div className="wiz-fiches">
                      {ficheList.map((fiche) => {
                        const checked = draft.fiches.includes(fiche.name);
                        const supported = FICHE_NAME_RE.test(fiche.name) && fiche.name.length <= 64;
                        const full = !checked && draft.fiches.length >= DRAFT_LIMITS.fichesMax;
                        return (
                          <label key={fiche.name} className={`check-row wiz-fiche${checked ? " selected" : ""}`}>
                            <input
                              type="checkbox"
                              checked={checked}
                              disabled={(!supported && !checked) || full}
                              onChange={(e) => toggleFiche(fiche.name, e.target.checked)}
                            />
                            <span className="stack tight" style={{ gap: 2, minWidth: 0 }}>
                              <span className="mono small">{fiche.name}</span>
                              {fiche.description ? <span className="small secondary">{fiche.description}</span> : null}
                              {fiche.missing ? <span className="small field-error">Fiche introuvable.</span> : null}
                              {!supported ? <span className="small muted">Nom de fiche non pris en charge par l'assistant de création.</span> : null}
                            </span>
                          </label>
                        );
                      })}
                    </div>
                  )}
                </div>

                <div className="field">
                  <span className="field-label">Exemples de demandes</span>
                  {draft.examples.map((example, i) => (
                    <div className="row" key={i}>
                      <input
                        className="input"
                        value={example}
                        maxLength={DRAFT_LIMITS.exampleMax}
                        aria-label={`Exemple ${i + 1}`}
                        placeholder="Relis ce script avant la mise en production de ce soir."
                        onChange={(e) => setDraft((d) => ({ ...d, examples: d.examples.map((x, j) => (j === i ? e.target.value : x)) }))}
                      />
                      <IconButton
                        icon="x"
                        label={`Retirer l'exemple ${i + 1}`}
                        onClick={() => setDraft((d) => ({ ...d, examples: d.examples.filter((_, j) => j !== i) }))}
                      />
                    </div>
                  ))}
                  {draft.examples.length < DRAFT_LIMITS.examplesMax ? (
                    <div>
                      <Button size="sm" icon="plus" onClick={() => setDraft((d) => ({ ...d, examples: [...d.examples, ""] }))}>
                        Ajouter un exemple
                      </Button>
                    </div>
                  ) : null}
                  {fieldError("examples") ? (
                    <span className="field-error">{fieldError("examples")}</span>
                  ) : (
                    <span className="field-hint">Ils apparaissent sur la carte de l'assistant dans le chat.</span>
                  )}
                </div>
              </>
            ) : null}

            {step === LAST_STEP ? (
              <>
                <h2>Vérifier</h2>
                <IdentityCard data={previewData} updating={updating} />
                <p className="small row">
                  <Icon name="folder" size={14} />
                  Enregistré pour tous vos projets.
                </p>
                {previewFresh && preview && preview.warnings.length > 0 ? (
                  <div className="callout warning">
                    <Icon name="alert" size={18} />
                    <ul style={{ margin: 0 }}>
                      {preview.warnings.map((w) => (
                        <li key={w}>{w}</li>
                      ))}
                    </ul>
                  </div>
                ) : null}
                {serverIssues.length > 0 ? (
                  <div className="callout critical" role="alert">
                    <Icon name="alert" size={18} />
                    <div className="stack tight" style={{ minWidth: 0 }}>
                      <strong>À corriger avant d'enregistrer</strong>
                      <ul style={{ margin: 0 }}>
                        {serverIssues.map((issue, i) => (
                          <li key={`${issue.path}-${i}`}>
                            {issue.message}
                            {issueStep(issue.path) < LAST_STEP ? (
                              <>
                                {" "}
                                <button type="button" className="link-button" onClick={() => goToStep(issueStep(issue.path))}>
                                  Étape « {STEPS[issueStep(issue.path)]} »
                                </button>
                              </>
                            ) : null}
                          </li>
                        ))}
                      </ul>
                      {generalIssues.length === 0 ? null : <span className="small">Corrigez ces points puis réessayez.</span>}
                    </div>
                  </div>
                ) : null}
                {draft.rights === "propose" ? (
                  <div className="field">
                    <label className={`check-row wiz-confirm${fieldError("confirm") ? " invalid" : ""}`}>
                      <input type="checkbox" checked={confirmed} onChange={(e) => setConfirmed(e.target.checked)} />
                      <span>J'ai lu ce que cet assistant a le droit de faire.</span>
                    </label>
                    {fieldError("confirm") ? <span className="field-error">{fieldError("confirm")}</span> : null}
                  </div>
                ) : null}
                {advanced ? (
                  <details className="wiz-file">
                    <summary>Voir le fichier généré</summary>
                    {previewFresh && preview ? (
                      <>
                        <p className="tiny muted mono">agents/{preview.name}.md</p>
                        <pre>{preview.file}</pre>
                      </>
                    ) : (
                      <Spinner />
                    )}
                  </details>
                ) : null}
                {saveError ? (
                  isRejected(saveError) ? (
                    <div className="callout critical" role="alert">
                      <Icon name="alert" size={18} />
                      <div className="stack tight" style={{ minWidth: 0 }}>
                        <strong>{MESSAGES.rejectedByOpencode}</strong>
                        {technicalDetail(saveError) ? (
                          <details>
                            <summary>Détail technique</summary>
                            <pre className="wiz-detail">{technicalDetail(saveError)}</pre>
                            <Button size="sm" icon="copy" onClick={() => copyDetail(technicalDetail(saveError))}>
                              Copier le détail
                            </Button>
                          </details>
                        ) : null}
                      </div>
                    </div>
                  ) : (
                    <div className="callout critical" role="alert">
                      <Icon name="alert" size={18} />
                      <span>{assistantErrorText(saveError)}</span>
                    </div>
                  )
                ) : null}
              </>
            ) : null}

            <div className="wiz-footer">
              {step > 0 ? (
                <Button icon="chevronLeft" onClick={() => goToStep(step - 1)}>
                  Précédent
                </Button>
              ) : (
                <Button variant="ghost" onClick={() => openAssistants()}>
                  Annuler
                </Button>
              )}
              <span className="spacer" />
              {step < LAST_STEP ? (
                <Button variant="primary" onClick={goNext}>
                  Suivant
                  <Icon name="chevronRight" size={16} />
                </Button>
              ) : (
                <Button variant="primary" icon="check" loading={saving} onClick={() => void save()}>
                  {creating ? "Créer l'assistant" : "Enregistrer les modifications"}
                </Button>
              )}
            </div>
          </div>

          {step < LAST_STEP ? (
            <aside className="wiz-aside" aria-label="Aperçu en direct">
              <span className="wiz-aside-head">Aperçu en direct</span>
              <IdentityCard data={previewData} updating={updating} />
              {previewError ? (
                <div className="callout critical small" role="alert">
                  <Icon name="alert" size={16} />
                  <span>{assistantErrorText(previewError)}</span>
                </div>
              ) : null}
              {previewFresh && preview && preview.warnings.length > 0 ? (
                <div className="callout warning small">
                  <Icon name="alert" size={16} />
                  <ul style={{ margin: 0 }}>
                    {preview.warnings.map((w) => (
                      <li key={w}>{w}</li>
                    ))}
                  </ul>
                </div>
              ) : null}
            </aside>
          ) : null}
        </div>
      </div>
    </div>
  );
}
