// Page Chat : conversations du projet, fil en direct, interactions de l'assistant et saisie.
import { useCallback, useEffect, useLayoutEffect, useMemo, useReducer, useRef, useState } from "react";
import {
  agentMissingMessage,
  BUDGET_CONFIRM_CANCEL,
  BUDGET_CONFIRM_SEND,
  BUDGET_CONFIRM_TITLE,
  detectPermissionPreset,
  formatUsd as usdText,
  MESSAGES,
  modelKey,
  parseModelKey,
  PERMISSION_PRESETS,
  RIGHT_LINE_SYMBOLS,
  RIGHTS_INFO,
  TIER_LABELS,
} from "../../server/shared/assistant-rules.ts";
import { useApp } from "../app/AppContext.tsx";
import { Icon } from "../components/Icon.tsx";
import { useToast } from "../components/Toast.tsx";
import { Button, IconButton, Meter, Modal, Spinner, useConfirm } from "../components/ui.tsx";
import { ApiError, api, assistantModelChanged, budgetGuard, oc } from "../lib/api.ts";
import { useEvents } from "../lib/events.ts";
import { formatPercent, formatTokens, formatUsd } from "../lib/format.ts";
import { CHAT_ASSISTANT_PARAM, navigate, openAssistants, useRoute, useRouteQuery } from "../lib/router.ts";
import type {
  AssistantsResponse,
  AssistantView,
  CatalogueItem,
  ChoicesResponse,
  Conversation,
  FileDiff,
  ModelRef,
  OcAgent,
  OcCommand,
  OcMessage,
  OcMessageWithParts,
  OcPart,
  OcSession,
  OcSessionStatus,
  PermissionRequest,
  QuestionRequest,
  ResolveRequest,
  ResolveResponse,
  TaskSize,
  Tier,
  Todo,
  UpdateItem,
} from "../lib/types.ts";
import "./chat/chat.css";
import { ChangeAssistantModal, type ChangeAssistantTarget } from "./chat/ChangeAssistantModal.tsx";
import { type AgentOption, Composer, type ComposerSubmit } from "./chat/Composer.tsx";
import { ContextPanel } from "./chat/ContextPanel.tsx";
import { IaControls, ProblemNotice } from "./chat/IaChip.tsx";
import { PermissionPrompt, QuestionPrompt } from "./chat/Interactions.tsx";
import { TurnView } from "./chat/MessageView.tsx";
import { SessionSidebar } from "./chat/SessionSidebar.tsx";
import { SubSessionDrawer } from "./chat/SubSessionDrawer.tsx";
import { contextTokens, EMPTY_TRANSCRIPT, groupTurns, transcriptReducer } from "./chat/transcript.ts";
import {
  builtinHelp,
  builtinTitle,
  commandOptions,
  defaultAgentName,
  isChatAgent,
  isModelNotFound,
  localResolve,
  resolveKey,
  useServerResolve,
} from "./chat/turn.ts";
import { type ProfileInfo, WelcomeCards } from "./chat/WelcomeCards.tsx";

function readFlag(key: string, fallback: boolean): boolean {
  try {
    const value = window.localStorage.getItem(key);
    return value === null ? fallback : value === "1";
  } catch {
    return fallback;
  }
}

function writeFlag(key: string, value: boolean): void {
  try {
    window.localStorage.setItem(key, value ? "1" : "0");
  } catch {
    // Préférence non mémorisée.
  }
}

function upsertById<T extends { id: string }>(list: T[], item: T): T[] {
  const index = list.findIndex((x) => x.id === item.id);
  if (index < 0) return [item, ...list];
  const next = list.slice();
  next[index] = item;
  return next;
}

const noop = () => undefined;

const exampleText = (example: string | undefined) => (example ? `Exemple : ${example}` : null);

/** Ce qui part dans le corps de la demande (modifié une fois après un 409 assistant-model-changed). */
interface SendParams {
  model: ModelRef;
  variant: string | null;
  modelOverride: boolean;
}

export function ChatPage() {
  const route = useRoute();
  const sessionId = route[0] === "chat" ? (route[1] ?? null) : null;
  const { boot, directory, setDirectory, categoryById, modelByKey } = useApp();
  const toast = useToast();
  const confirm = useConfirm();
  const advanced = boot.ui.mode === "avance";
  const allowOverride = advanced && boot.ai.allowModelOverride;

  const [sessions, setSessions] = useState<OcSession[]>([]);
  const [sessionsLoading, setSessionsLoading] = useState(true);
  const [statuses, setStatuses] = useState<Record<string, OcSessionStatus>>({});
  const [permissions, setPermissions] = useState<PermissionRequest[]>([]);
  const [questions, setQuestions] = useState<QuestionRequest[]>([]);
  const [agents, setAgents] = useState<OcAgent[]>([]);
  const [commands, setCommands] = useState<OcCommand[]>([]);
  const [conversations, setConversations] = useState<Map<string, Conversation>>(new Map());
  const [session, setSession] = useState<OcSession | null>(null);
  const [transcript, dispatch] = useReducer(transcriptReducer, EMPTY_TRANSCRIPT);
  const [loadingMessages, setLoadingMessages] = useState(false);
  const [todos, setTodos] = useState<Todo[]>([]);
  const [diff, setDiff] = useState<FileDiff[]>([]);
  const [children, setChildren] = useState<OcSession[]>([]);
  const [usageTick, setUsageTick] = useState(0);
  const [drawer, setDrawer] = useState<string | null>(null);
  const [asideOpen, setAsideOpen] = useState(() => readFlag("cockpit-chat-aside", true));
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [renaming, setRenaming] = useState<string | null>(null);

  // --- Choix de la demande : assistant, niveau, réflexion, autre IA (mode Avancé) ---
  const [agent, setAgent] = useState<string>(boot.settings.chat.defaultAgent ?? "build");
  const [tier, setTier] = useState<Tier>(boot.ai.chatDefaultTier);
  /** undefined : réflexion du niveau ; null : standard. */
  const [variant, setVariant] = useState<string | null | undefined>(undefined);
  const [override, setOverride] = useState<string | null>(null);
  const [draftCommand, setDraftCommand] = useState<string | null>(null);
  /** Carte choisie sur l'écran d'accueil (aucune présélection). */
  const [picked, setPicked] = useState<string | null>(null);
  const [placeholder, setPlaceholder] = useState<string | null>(null);
  const [assistants, setAssistants] = useState<AssistantsResponse | null>(null);
  const [assistantsFailed, setAssistantsFailed] = useState(false);
  const [catalogue, setCatalogue] = useState<CatalogueItem[] | null>(null);
  const [installing, setInstalling] = useState<string | null>(null);
  const [profile, setProfile] = useState<ProfileInfo | null>(null);
  const [resolveTick, setResolveTick] = useState(0);
  const [changeTarget, setChangeTarget] = useState<ChangeAssistantTarget | null>(null);

  const sessionRef = useRef<string | null>(sessionId);
  sessionRef.current = sessionId;
  const pendingRef = useRef<string | null>(null);
  const statusesRef = useRef(statuses);
  statusesRef.current = statuses;
  const agentsRef = useRef(agents);
  agentsRef.current = agents;
  /** Assistant à garder pour la prochaine nouvelle conversation (dialogue de changement d'assistant). */
  const nextAgentRef = useRef<string | null>(null);
  const missingToasted = useRef<string | null>(null);
  const isVisible = (sid: unknown) => typeof sid === "string" && (sid === sessionRef.current || sid === pendingRef.current);

  const sessionDirectory = session?.directory ?? directory;

  const loadDirectory = useCallback(async () => {
    setSessionsLoading(true);
    const [list, status, perms, qs, agentList, commandList] = await Promise.allSettled([
      oc.sessions(directory),
      oc.status(directory),
      oc.permissions(directory),
      oc.questions(directory),
      oc.agents(directory),
      oc.commands(directory),
    ]);
    if (list.status === "fulfilled") {
      setSessions(list.value.filter((s) => !s.parentID && !s.title.startsWith("[cockpit]")).sort((a, b) => b.time.updated - a.time.updated));
    } else {
      toast.error("Conversations indisponibles", list.reason);
    }
    if (status.status === "fulfilled") setStatuses(status.value);
    if (perms.status === "fulfilled") setPermissions(perms.value);
    if (qs.status === "fulfilled") setQuestions(qs.value);
    if (agentList.status === "fulfilled") setAgents(agentList.value);
    if (commandList.status === "fulfilled") setCommands(commandList.value);
    setSessionsLoading(false);
  }, [directory, toast]);

  useEffect(() => {
    void loadDirectory();
  }, [loadDirectory]);

  const loadConversations = useCallback(async () => {
    try {
      const result = await api.archiveList({ limit: 200 });
      setConversations(new Map(result.items.map((c) => [c.sessionId, c])));
    } catch {
      // Archives indisponibles : le chat reste utilisable.
    }
  }, []);

  useEffect(() => {
    void loadConversations();
  }, [loadConversations]);

  const loadAssistants = useCallback(async () => {
    try {
      const data = await api.assistants();
      setAssistants(data);
      setAssistantsFailed(false);
      if (data.assistants.length === 0) api.assistantsCatalogue().then(setCatalogue, () => setCatalogue([]));
    } catch {
      setAssistantsFailed(true);
    }
  }, []);

  const loadProfile = useCallback(async () => {
    try {
      const config = await api.opencodeConfig();
      const id = detectPermissionPreset(config.permission);
      setProfile({ prudent: id === "prudent", label: id ? PERMISSION_PRESETS[id].label : RIGHTS_INFO.personnalise.label });
    } catch {
      setProfile(null);
    }
  }, []);

  useEffect(() => {
    void loadAssistants();
    void loadProfile();
  }, [loadAssistants, loadProfile]);

  const refreshAgents = useCallback(() => oc.agents(directory).then(setAgents, noop), [directory]);

  // --- Titres et tailles de demande des assistants ---
  const assistantByName = useMemo(() => new Map((assistants?.assistants ?? []).map((a) => [a.name, a])), [assistants]);
  const titleOf = useCallback((name: string) => assistantByName.get(name)?.title ?? builtinTitle(name) ?? name, [assistantByName]);
  const sizeOf = useCallback((name: string): TaskSize => assistantByName.get(name)?.taskSize ?? "M", [assistantByName]);

  /** « Nouvelle conversation » : assistant par défaut (ou celui demandé), niveau par défaut, réflexion standard du niveau. */
  const resetChoices = (next: string | null = null) => {
    setAgent(next ?? defaultAgentName(boot.settings.chat.defaultAgent, agentsRef.current));
    setTier(boot.ai.chatDefaultTier);
    setVariant(undefined);
    setOverride(null);
    setPicked(next);
    setPlaceholder(null);
  };

  /** Réouverture : derniers choix enregistrés par le cockpit (jamais l'IA d'un raccourci). */
  const restoreChoices = async (sid: string, messages: OcMessageWithParts[]) => {
    let choices: ChoicesResponse = null;
    try {
      choices = await api.chatChoices(sid);
    } catch {
      choices = null;
    }
    if (sessionRef.current !== sid) return;
    setOverride(null);
    if (choices) {
      const chosen = choices;
      setAgent(chosen.agent || defaultAgentName(boot.settings.chat.defaultAgent, agentsRef.current));
      const known = agentsRef.current.find((a) => a.name === chosen.agent);
      const levelOfModel = boot.ai.tiers.find((t) => t.model !== null && t.model === chosen.model)?.id ?? null;
      const level = levelOfModel ?? chosen.tier;
      if (level) {
        setTier(level);
        setVariant(chosen.variant);
      } else if (advanced && chosen.model && known && !known.model && boot.models.some((m) => m.key === chosen.model)) {
        // Mode Avancé : l'IA précise choisie pour un agent sans IA propre.
        setOverride(chosen.model);
        setVariant(chosen.variant);
      } else {
        setTier(boot.ai.chatDefaultTier);
        setVariant(undefined);
      }
      return;
    }
    // Conversation antérieure à 0.2.0 : seul l'assistant du dernier message est repris.
    let lastAgent: string | null = null;
    for (let i = messages.length - 1; i >= 0; i--) {
      const info = messages[i]?.info;
      if (info?.role === "user") {
        lastAgent = info.agent;
        break;
      }
    }
    const known = lastAgent ? agentsRef.current.find((a) => a.name === lastAgent && isChatAgent(a)) : undefined;
    if (known) setAgent(known.name);
    setTier(boot.ai.chatDefaultTier);
    setVariant(undefined);
  };

  useEffect(() => {
    dispatch({ type: "reset", messages: [] });
    setTodos([]);
    setDiff([]);
    setChildren([]);
    setSession(null);
    if (!sessionId) {
      const next = nextAgentRef.current;
      nextAgentRef.current = null;
      resetChoices(next);
      return;
    }
    if (pendingRef.current !== sessionId) pendingRef.current = null;
    const restoring = pendingRef.current !== sessionId;
    let cancelled = false;
    setLoadingMessages(true);
    void (async () => {
      try {
        const info = await oc.session(sessionId);
        if (cancelled) return;
        setSession(info);
        if (info.directory !== directory && boot.projects.some((p) => p.directory === info.directory)) setDirectory(info.directory);
        const messages = await oc.messages(sessionId, info.directory);
        if (cancelled) return;
        dispatch({ type: "merge-missing", messages });
        if (restoring) void restoreChoices(sessionId, messages);
        oc.todo(sessionId, info.directory).then((t) => !cancelled && setTodos(t), noop);
        oc.diff(sessionId, info.directory).then((d) => !cancelled && setDiff(d), noop);
        oc.children(sessionId, info.directory).then((c) => !cancelled && setChildren(c), noop);
      } catch (err) {
        if (!cancelled) toast.error("Conversation introuvable", err);
      } finally {
        if (!cancelled) setLoadingMessages(false);
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId]);

  // #/chat?assistant=<nom> (« Utiliser dans le chat », « Essayer ») : présélectionne cet assistant pour une nouvelle demande.
  // Déclaré après la remise à zéro ci-dessus pour passer après elle.
  const assistantParam = useRouteQuery().get(CHAT_ASSISTANT_PARAM);
  const appliedParam = useRef<string | null>(null);
  useEffect(() => {
    if (sessionId || !assistantParam) {
      appliedParam.current = null;
      return;
    }
    if (appliedParam.current !== assistantParam) {
      appliedParam.current = assistantParam;
      applyAgent(assistantParam);
    }
    const example = assistantByName.get(assistantParam)?.examples[0];
    if (example && agent === assistantParam) setPlaceholder((current) => current ?? exampleText(example));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId, assistantParam, assistantByName, agent]);

  const refetchMessages = useCallback((sid: string) => {
    oc.messages(sid).then((messages) => {
      const status = statusesRef.current[sid]?.type;
      if (sessionRef.current === sid && status !== "busy" && status !== "retry") dispatch({ type: "reset", messages });
    }, noop);
  }, []);

  const reloadTimer = useRef<number | undefined>(undefined);

  useEvents((event) => {
    if (event.kind === "cockpit") {
      if (event.type === "conversation.classified" || event.type === "conversation.updated") {
        window.clearTimeout(reloadTimer.current);
        reloadTimer.current = window.setTimeout(() => void loadConversations(), 500);
      } else if (event.type === "usage.updated") {
        const data = event.data as { rootId?: string };
        if (!data.rootId || data.rootId === sessionRef.current) setUsageTick((t) => t + 1);
      } else if (event.type === "stream.reconnected") {
        void loadDirectory();
        void loadAssistants();
        if (sessionRef.current) refetchMessages(sessionRef.current);
      } else if (event.type === "studio.changed") {
        void refreshAgents();
        oc.commands(directory).then(setCommands, noop);
        void loadAssistants();
        setResolveTick((t) => t + 1);
      } else if (event.type === "ai.changed") {
        void loadAssistants();
        setResolveTick((t) => t + 1);
      } else if (event.type === "opencode.config.changed") {
        void loadProfile();
        void refreshAgents();
        setResolveTick((t) => t + 1);
      }
      return;
    }
    const { type, properties: p } = event.event;
    switch (type) {
      case "session.created":
      case "session.updated": {
        const info = p.info as OcSession;
        if (info.id === sessionRef.current) setSession(info);
        if (info.parentID) {
          if (info.parentID === sessionRef.current) setChildren((list) => upsertById(list, info));
          break;
        }
        if (info.title.startsWith("[cockpit]") || info.directory !== directory) break;
        setSessions((list) => upsertById(list, info).sort((a, b) => b.time.updated - a.time.updated));
        break;
      }
      case "session.deleted": {
        const info = p.info as OcSession;
        setSessions((list) => list.filter((s) => s.id !== info.id));
        if (info.id === sessionRef.current) navigate("chat");
        break;
      }
      case "session.status":
        setStatuses((s) => ({ ...s, [String(p.sessionID)]: p.status as OcSessionStatus }));
        break;
      case "session.idle": {
        const sid = String(p.sessionID);
        setStatuses((s) => ({ ...s, [sid]: { type: "idle" } }));
        if (sid === sessionRef.current) window.setTimeout(() => refetchMessages(sid), 300);
        break;
      }
      case "session.error": {
        if (!isVisible(p.sessionID)) break;
        const err = p.error as { name?: string; data?: { message?: string } } | undefined;
        if (!err || err.name === "MessageAbortedError") break;
        if (isModelNotFound({ name: err.name ?? "", ...(err.data ? { data: err.data } : {}) })) {
          toast.error(MESSAGES.modelNotFoundTitle, MESSAGES.modelNotFound);
        } else {
          toast.error("Erreur pendant la réponse", err.data?.message ?? err.name);
        }
        break;
      }
      case "message.updated": {
        const info = p.info as OcMessage;
        if (isVisible(info.sessionID)) dispatch({ type: "message", info });
        break;
      }
      case "message.removed":
        if (isVisible(p.sessionID)) dispatch({ type: "message.removed", messageID: String(p.messageID) });
        break;
      case "message.part.updated": {
        const part = p.part as OcPart;
        if (isVisible(part.sessionID)) dispatch({ type: "part", part });
        break;
      }
      case "message.part.removed":
        if (isVisible(p.sessionID)) dispatch({ type: "part.removed", messageID: String(p.messageID), partID: String(p.partID) });
        break;
      case "message.part.delta":
        if (isVisible(p.sessionID)) {
          dispatch({ type: "part.delta", messageID: String(p.messageID), partID: String(p.partID), field: String(p.field), delta: String(p.delta) });
        }
        break;
      case "permission.asked":
        setPermissions((list) => upsertById(list, p as unknown as PermissionRequest));
        break;
      case "permission.replied": {
        const id = String(p.requestID ?? "");
        setPermissions((list) => list.filter((r) => r.id !== id));
        break;
      }
      case "question.asked":
        setQuestions((list) => upsertById(list, p as unknown as QuestionRequest));
        break;
      case "question.replied":
      case "question.rejected": {
        const id = String(p.requestID ?? "");
        setQuestions((list) => list.filter((q) => q.id !== id));
        break;
      }
      case "todo.updated":
        if (p.sessionID === sessionRef.current) setTodos(p.todos as Todo[]);
        break;
      case "session.diff":
        if (p.sessionID === sessionRef.current) setDiff(p.diff as FileDiff[]);
        break;
    }
  });

  // --- Défilement : on suit la réponse tant que l'utilisateur est en bas du fil. ---
  const scroller = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const onScroll = () => {
    const el = scroller.current;
    if (el) stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 160;
  };
  useEffect(() => {
    stick.current = true;
  }, [sessionId]);
  useLayoutEffect(() => {
    const el = scroller.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [transcript, permissions, questions]);

  // --- Résolution de l'IA (même calcul que le proxy) ---------------------------------------

  const baseRequest: ResolveRequest = {
    directory: sessionDirectory,
    agent,
    tier,
    ...(variant !== undefined && !override ? { variant } : {}),
    ...(override && advanced ? { override: { ...parseModelKey(override), ...(variant ? { variant } : {}) } } : {}),
  };
  const baseKey = resolveKey(baseRequest);
  const commandName = draftCommand && commands.some((c) => c.name === draftCommand) ? draftCommand : null;
  const commandRequest: ResolveRequest | null = commandName ? { ...baseRequest, command: commandName } : null;
  const commandKey = resolveKey(commandRequest);
  const resolveCtx = useMemo(() => ({ boot, agents, commands, titleOf, sizeOf }), [boot, agents, commands, titleOf, sizeOf]);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const localChat = useMemo(() => localResolve(baseRequest, resolveCtx), [baseKey, resolveCtx]);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const localCommand = useMemo(() => (commandRequest ? localResolve(commandRequest, resolveCtx) : null), [commandKey, resolveCtx]);
  const serverChat = useServerResolve(baseRequest, resolveTick);
  const serverCommand = useServerResolve(commandRequest, resolveTick);
  const chatTurn = serverChat.data ?? localChat;
  const shownTurn = commandRequest ? (serverCommand.data ?? localCommand ?? chatTurn) : chatTurn;
  const agentHasModel = chatTurn.lock?.kind === "assistant" || Boolean(agents.find((a) => a.name === chatTurn.agent)?.model);

  /** Serveur puis repli local (proxy injoignable ou route absente) ; le proxy reste l'autorité à l'envoi. */
  const resolveForSend = async (request: ResolveRequest): Promise<ResolveResponse> => {
    try {
      return await api.resolveChat(request);
    } catch (err) {
      if (err instanceof ApiError && (err.status === 0 || err.status === 404 || err.status >= 500)) return localResolve(request, resolveCtx);
      throw err;
    }
  };

  const notifyMissing = (missing: string, fallback: string) => {
    if (missingToasted.current === missing) return;
    missingToasted.current = missing;
    toast.warning(MESSAGES.agentMissingTitle, agentMissingMessage(missing, fallback === "build" ? undefined : `« ${titleOf(fallback)} »`));
  };

  // Assistant introuvable (supprimé, renommé) : repli sur l'assistant par défaut, avec un message.
  const localMissing = agents.length > 0 ? localChat.agentMissing : null;
  const serverMissing = serverChat.data ? serverChat.data.agentMissing : undefined;
  const missingAgent = serverMissing === undefined ? localMissing : serverMissing && (agents.length === 0 || localMissing) ? serverMissing : null;
  useEffect(() => {
    if (!missingAgent || missingAgent !== agent) return;
    const fallback = serverChat.data && serverChat.data.agent !== missingAgent ? serverChat.data.agent : defaultAgentName(boot.settings.chat.defaultAgent, agents);
    const target = fallback === missingAgent ? "build" : fallback;
    setAgent(target);
    setOverride(null);
    setPicked(null);
    notifyMissing(missingAgent, target);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [missingAgent, agent]);

  // --- Actions -----------------------------------------------------------------------

  /** Exécute une action qui appelle une IA ; propose de confirmer si le garde-fou budgétaire la bloque. */
  const withGuard = useCallback(
    async (action: (confirmed: boolean) => Promise<unknown>): Promise<boolean> => {
      try {
        await action(false);
        return true;
      } catch (err) {
        const guard = budgetGuard(err);
        if (guard) {
          const ok = await confirm({
            title: guard.title || BUDGET_CONFIRM_TITLE,
            message: guard.message || "Cette demande est coûteuse au regard du budget restant. Envoyer quand même ?",
            confirmLabel: BUDGET_CONFIRM_SEND,
            cancelLabel: BUDGET_CONFIRM_CANCEL,
            danger: true,
          });
          if (ok) await action(true);
          return ok;
        }
        throw err;
      }
    },
    [confirm],
  );

  /** Envoie ; sur 409 assistant-model-changed, renvoie UNE fois avec l'IA de l'assistant puis l'annonce. */
  const sendTurn = async (initial: SendParams, send: (params: SendParams, confirmed: boolean) => Promise<unknown>): Promise<boolean> => {
    const state = { params: initial, resent: false, message: null as string | null };
    const ok = await withGuard(async (confirmed) => {
      try {
        await send(state.params, confirmed);
      } catch (err) {
        const changed = assistantModelChanged(err);
        if (!changed || state.resent) throw err;
        state.resent = true;
        state.message = changed.message;
        state.params = { model: changed.model, variant: changed.variant, modelOverride: false };
        setResolveTick((t) => t + 1);
        void refreshAgents();
        await send(state.params, confirmed);
      }
    });
    if (ok && state.message) toast.info(state.message);
    return ok;
  };

  const handleSubmit = async (input: ComposerSubmit): Promise<boolean> => {
    if (boot.models.length === 0) {
      toast.warning("Aucune IA disponible", "Connectez GitHub Copilot dans Paramètres › Connexion.");
      return false;
    }
    const commandMatch = /^\/([\w-]+)(?:\s+([\s\S]*))?$/.exec(input.text);
    const command = commandMatch ? commands.find((c) => c.name === commandMatch[1]) : undefined;
    const request: ResolveRequest = command ? { ...baseRequest, command: command.name } : baseRequest;
    let turn: ResolveResponse;
    try {
      turn = await resolveForSend(request);
    } catch (err) {
      toast.error("Envoi impossible", err);
      return false;
    }
    if (turn.agentMissing && turn.agent !== agent) {
      setAgent(turn.agent);
      notifyMissing(turn.agentMissing, turn.agent);
    }
    const blocking = turn.display.problems.filter((p) => p.blocking);
    if (blocking.length > 0) {
      toast.error("Rien n'a été envoyé", [...new Set(blocking.map((p) => p.message))].join(" "));
      return false;
    }
    const oneMessageOverride = Boolean(request.override) && agentHasModel;
    const initial: SendParams = {
      model: turn.send.model,
      variant: turn.send.variant ?? null,
      modelOverride: Boolean(request.override) && allowOverride,
    };
    try {
      let sid = sessionId;
      let dir = sessionDirectory;
      if (!sid) {
        const created = await oc.createSession(directory);
        sid = created.id;
        dir = created.directory;
        pendingRef.current = created.id;
        setSessions((list) => upsertById(list, created));
        navigate("chat", created.id);
      }
      const targetId = sid;
      const targetDir = dir;
      const fileParts = input.attachments.map((a) => ({ type: "file", mime: a.mime, filename: a.filename, url: a.url }));
      setStatuses((s) => ({ ...s, [targetId]: { type: "busy" } }));
      stick.current = true;
      const sent = command
        ? await sendTurn(initial, (params, confirmed) =>
            oc.command(
              targetId,
              targetDir,
              {
                command: command.name,
                arguments: commandMatch?.[2] ?? "",
                agent: turn.agent,
                model: modelKey(params.model),
                ...(params.variant ? { variant: params.variant } : {}),
                ...(fileParts.length > 0 ? { parts: fileParts } : {}),
              },
              confirmed,
              params.modelOverride,
            ),
          )
        : await sendTurn(initial, (params, confirmed) =>
            oc.promptAsync(
              targetId,
              targetDir,
              {
                agent: turn.agent,
                model: params.model,
                ...(params.variant ? { variant: params.variant } : {}),
                parts: [...(input.text ? [{ type: "text", text: input.text }] : []), ...fileParts],
              },
              confirmed,
              params.modelOverride,
            ),
          );
      if (!sent) {
        setStatuses((s) => ({ ...s, [targetId]: { type: "idle" } }));
        return false;
      }
      if (oneMessageOverride) setOverride(null);
      return true;
    } catch (err) {
      if (sessionRef.current) setStatuses((s) => ({ ...s, [sessionRef.current as string]: { type: "idle" } }));
      toast.error("Envoi impossible", err);
      return false;
    }
  };

  const abort = () => {
    if (!sessionId) return;
    oc.abort(sessionId, sessionDirectory).catch((err: unknown) => toast.error("Arrêt impossible", err));
  };

  /** « Résumer » : IA de la conversation (celle de l'assistant, sinon le niveau), jamais une IA choisie pour un message. */
  const summarize = async () => {
    if (!sessionId) return;
    const request: ResolveRequest = agentHasModel ? { directory: sessionDirectory, agent, tier } : baseRequest;
    try {
      const turn = await resolveForSend(request);
      const blocking = turn.display.problems.filter((p) => p.blocking);
      if (blocking.length > 0) {
        toast.error("Résumé impossible", [...new Set(blocking.map((p) => p.message))].join(" "));
        return;
      }
      toast.info("Résumé de la conversation", "L'historique est résumé pour libérer de la mémoire.");
      await withGuard((confirmed) => oc.summarize(sessionId, sessionDirectory, turn.send.model, confirmed));
    } catch (err) {
      toast.error("Résumé impossible", err);
    }
  };

  const removeSession = async () => {
    if (!session) return;
    const ok = await confirm({
      title: "Supprimer la conversation ?",
      message: "Elle sera supprimée d'opencode. Son archive (résumé, transcription, coûts) est conservée dans le cockpit.",
      confirmLabel: "Supprimer",
      danger: true,
    });
    if (!ok) return;
    try {
      await oc.deleteSession(session.id, session.directory);
      setSessions((list) => list.filter((s) => s.id !== session.id));
      navigate("chat");
      toast.success("Conversation supprimée", "L'archive reste consultable dans Archives.");
    } catch (err) {
      toast.error("Suppression impossible", err);
    }
  };

  const rename = async (title: string) => {
    if (!session || !title.trim()) return;
    try {
      const updated = await oc.updateSession(session.id, session.directory, { title: title.trim() });
      setSession(updated);
      setSessions((list) => upsertById(list, updated));
      setRenaming(null);
    } catch (err) {
      toast.error("Renommage impossible", err);
    }
  };

  const classify = async () => {
    if (!sessionId) return;
    try {
      const conv = await api.archiveClassify(sessionId);
      setConversations((map) => new Map(map).set(conv.sessionId, conv));
      const category = categoryById(conv.category);
      toast.success("Conversation classée", category ? `${category.emoji} ${category.label}` : conv.category);
    } catch (err) {
      toast.error("Classement impossible", err);
    }
  };

  const replyPermission = async (request: PermissionRequest, reply: "once" | "reject", message?: string) => {
    const drop = () => setPermissions((list) => list.filter((r) => r.id !== request.id));
    try {
      await oc.replyPermission(request.id, sessionDirectory, reply, message);
      drop();
    } catch (err) {
      // Réponse arrêtée entre-temps : le serveur n'a rien relayé, la demande ne peut plus être autorisée.
      if (err instanceof ApiError && err.status === 409 && err.code === "demande-expiree") {
        drop();
        toast.warning("Demande expirée", err.message);
        return;
      }
      // Refus d'une demande d'une réponse arrêtée pendant que la conversation retravaille : rien n'a été relayé, la carte reste.
      if (err instanceof ApiError && err.status === 409 && err.code === "demande-orpheline") {
        toast.warning("Refus différé", err.message);
        return;
      }
      toast.error("Réponse impossible", err);
    }
  };

  const toggleAside = () => {
    setAsideOpen((open) => {
      writeFlag("cockpit-chat-aside", !open);
      return !open;
    });
  };

  const newConversation = () => {
    setSidebarOpen(false);
    if (sessionId) navigate("chat");
    else resetChoices();
  };

  // --- Assistant : choix, changement en cours de conversation, installation ------------------

  const applyAgent = (name: string) => {
    setAgent(name);
    setOverride(null);
    setPicked(name);
  };

  const requestAgentChange = async (name: string) => {
    if (name === agent) return;
    if (!sessionId || transcript.order.length === 0) {
      applyAgent(name);
      return;
    }
    const request: ResolveRequest = { directory: sessionDirectory, agent: name, tier, ...(variant !== undefined ? { variant } : {}) };
    let target: ResolveResponse;
    try {
      target = await api.resolveChat(request);
    } catch {
      target = localResolve(request, resolveCtx);
    }
    const main = target.display.runs.find((r) => r.role === "message");
    setChangeTarget({
      name: target.agent,
      ia: main ? `${main.modelName}${main.tier ? ` · ${TIER_LABELS[main.tier]}` : ""}` : null,
      cost: target.display.estimate ? usdText(target.display.estimate.max) : null,
    });
  };

  const pickAssistant = (assistant: AssistantView) => {
    applyAgent(assistant.name);
    setPlaceholder(exampleText(assistant.examples[0]));
  };

  const installAndUse = async (item: CatalogueItem) => {
    if (item.installed && item.installedName) {
      applyAgent(item.installedName);
      setPlaceholder(exampleText(item.examples[0]));
      return;
    }
    const ok = await confirm({
      title: `Installer « ${item.title} »`,
      message: (
        <div className="stack tight">
          <p className="secondary">{item.description}</p>
          <strong className="small">Ce qu'il peut faire</strong>
          <ul className="right-lines">
            {item.rightLines.map((line) => (
              <li key={line.id} className={line.danger ? "rights-danger" : undefined}>
                <span aria-hidden>{RIGHT_LINE_SYMBOLS[line.kind]}</span> {line.text}
              </li>
            ))}
          </ul>
          <span className="small">
            IA utilisée : {item.modelName ?? "—"} — niveau {TIER_LABELS[item.tier]}
            {item.estimate ? ` · ${item.estimate.text}` : ""}
          </span>
          {item.newFiches.map((fiche) => (
            <span key={fiche} className="small">
              Installe aussi la fiche « {fiche} » : relisez-la avec votre équipe.
            </span>
          ))}
          <span className="tiny muted">{item.review}</span>
        </div>
      ),
      confirmLabel: "Installer et utiliser",
    });
    if (!ok) return;
    setInstalling(item.id);
    try {
      const view = await api.installCatalogueAssistant(item.id);
      await refreshAgents();
      await loadAssistants();
      applyAgent(view.name);
      setPlaceholder(exampleText(view.examples[0]));
      setResolveTick((t) => t + 1);
      toast.success("Assistant installé", "Il apparaît maintenant dans le chat.");
    } catch (err) {
      toast.error("Installation impossible", err);
    } finally {
      setInstalling(null);
    }
  };

  /** Callout « L'IA de cet assistant n'est plus disponible » : [Passer à {nouvelle}]. */
  const realignAssistant = async (item: UpdateItem) => {
    const costs = item.fromUsd !== null && item.toUsd !== null ? ` Coût estimé : ${usdText(item.fromUsd)} → ${usdText(item.toUsd)} par demande.` : "";
    const multiplied = item.ratio !== null && item.ratio >= 2;
    const ok = await confirm({
      title: "Mettre à jour 1 assistant ?",
      message: `Il utilisera ${item.toName} au lieu de ${item.fromName ?? item.from ?? "son IA actuelle"}.${costs}${
        multiplied ? ` Le coût estimé est multiplié par ${String(Math.round((item.ratio ?? 0) * 10) / 10).replace(".", ",")}.` : ""
      }`,
      confirmLabel: "Mettre à jour",
      danger: multiplied,
    });
    if (!ok) return;
    try {
      await api.realign([{ kind: item.kind, name: item.name }]);
      await refreshAgents();
      await loadAssistants();
      setResolveTick((t) => t + 1);
      toast.success("Assistant mis à jour", `Il utilise maintenant ${item.toName}.`);
    } catch (err) {
      toast.error("Mise à jour impossible", err);
    }
  };

  // --- Données dérivées ---------------------------------------------------------------

  const turns = useMemo(() => groupTurns(transcript), [transcript]);
  const modelName = useCallback((key: string) => modelByKey(key)?.name ?? key.slice(key.indexOf("/") + 1), [modelByKey]);
  const context = useMemo(() => contextTokens(transcript), [transcript]);
  const contextModel = modelByKey(context.modelKey) ?? modelByKey(modelKey(chatTurn.send.model));
  const contextLimit = contextModel?.contextLimit ?? null;
  const contextPercent = contextLimit ? (context.tokens / contextLimit) * 100 : 0;
  const summaryCost = chatTurn.display.estimate ? ` (≈ ${usdText(chatTurn.display.estimate.max)})` : "";

  const status = sessionId ? statuses[sessionId] : undefined;
  const lastTurn = turns.at(-1);
  const running = Boolean(lastTurn?.replies.some((r) => !r.info.time.completed && !r.info.error));
  const busy = status?.type === "busy" || status?.type === "retry" || running;
  const waitingFirstStep = busy && lastTurn !== undefined && lastTurn.replies.length === 0;

  const relatedIds = new Set([sessionId, ...children.map((c) => c.id)].filter((id): id is string => Boolean(id)));
  const localPermissions = permissions.filter((r) => relatedIds.has(r.sessionID));
  /** Conversation qui travaille (en cours ou nouvelle tentative) : seules ses demandes peuvent encore être autorisées. */
  const isWorking = (sid: string) => {
    const type = statuses[sid]?.type;
    return type === "busy" || type === "retry";
  };
  /**
   * La demande peut encore être autorisée : sa conversation travaille ET l'appel d'outil qui l'a posée est toujours en cours.
   * Après un arrêt, opencode garde la demande même quand un nouveau message fait retravailler la conversation : sa partie
   * « tool » est alors en erreur (« Tool execution aborted »). Appel absent du fil (sous-agent, fil en chargement) : le
   * serveur vérifie lui-même l'appel avant de relayer.
   */
  const canAllow = (request: PermissionRequest) => {
    if (!isWorking(request.sessionID)) return false;
    if (!request.tool) return true;
    const { messageID, callID } = request.tool;
    const entry = transcript.byId.get(messageID);
    if (entry?.info.role === "assistant" && entry.info.error) return false;
    const part = entry?.parts.find((p) => p.type === "tool" && p.callID === callID);
    return !part || (part.type === "tool" && part.state.status === "running");
  };
  // Consigne d'un travail délégué en attente d'autorisation : opencode ne la joint pas à la demande.
  const taskPromptFor = (request: (typeof permissions)[number]): string | undefined => {
    if (request.permission !== "task" || !request.tool) return undefined;
    const { messageID, callID } = request.tool;
    const part = transcript.byId.get(messageID)?.parts.find((p) => p.type === "tool" && p.callID === callID);
    const input = part && part.type === "tool" ? (part.state as { input?: Record<string, unknown> }).input : undefined;
    return typeof input?.prompt === "string" ? input.prompt : undefined;
  };
  const localQuestions = questions.filter((q) => relatedIds.has(q.sessionID));
  const otherPending = permissions.length + questions.length - localPermissions.length - localQuestions.length;
  const pendingBySession = useMemo(() => {
    const map = new Map<string, number>();
    for (const r of [...permissions, ...questions]) map.set(r.sessionID, (map.get(r.sessionID) ?? 0) + 1);
    return map;
  }, [permissions, questions]);

  const conversation = sessionId ? (conversations.get(sessionId) ?? null) : null;
  const category = categoryById(conversation?.category);
  const project = boot.projects.find((p) => p.directory === sessionDirectory);
  const projectLabel = project ? (project.isRoot ? "Tout le workspace" : project.name) : sessionDirectory;

  const agentOptions = useMemo<AgentOption[]>(() => {
    const rank = (name: string) => (assistantByName.has(name) ? 0 : builtinTitle(name) ? 1 : 2);
    return agents
      .filter((a) => isChatAgent(a) && !a.hidden)
      .map((a) => {
        const view = assistantByName.get(a.name);
        return {
          name: a.name,
          title: view?.title ?? builtinTitle(a.name, a.permission) ?? a.name,
          help: view?.description ?? builtinHelp(a.name, a.permission) ?? a.description ?? null,
        };
      })
      .sort((x, y) => rank(x.name) - rank(y.name) || x.title.localeCompare(y.title, "fr"));
  }, [agents, assistantByName]);

  const commandItems = useMemo(
    () => commandOptions({ commands, agents, chatTurn, chatAgent: chatTurn.agent, boot, simple: !advanced, sizeOf }),
    [commands, agents, chatTurn, boot, advanced, sizeOf],
  );

  const pickerModels = useMemo(() => {
    const allowed = boot.allowedProviders.length > 0 ? boot.allowedProviders : ["github-copilot"];
    return boot.models.filter((m) => allowed.includes(m.providerID));
  }, [boot.models, boot.allowedProviders]);

  const blockingProblems = shownTurn.display.problems.filter((p) => p.blocking);
  const assistantUpdate =
    assistants?.updates.find((u) => u.kind === "agents" && u.name === shownTurn.agent) ?? assistantByName.get(shownTurn.agent)?.update ?? null;
  const shownModel = modelByKey(modelKey(shownTurn.send.model));
  const hasBuild = agents.length === 0 || agents.some((a) => a.name === "build" && isChatAgent(a));

  return (
    <div className={`chat${asideOpen ? " aside-open" : ""}${sidebarOpen ? " sidebar-open" : ""}`}>
      <SessionSidebar
        projects={boot.projects}
        directory={directory}
        onDirectoryChange={(dir) => {
          setDirectory(dir);
          setSidebarOpen(false);
          navigate("chat");
        }}
        sessions={sessions}
        loading={sessionsLoading}
        activeId={sessionId}
        statuses={statuses}
        conversations={conversations}
        categoryById={categoryById}
        pendingBySession={pendingBySession}
        onNew={newConversation}
      />

      <section className="chat-center">
        <header className="chat-header">
          <IconButton icon="list" label="Conversations" className="toggle-sidebar" onClick={() => setSidebarOpen((v) => !v)} />
          {session ? (
            <>
              <div className="stack tight spacer" style={{ gap: 0, minWidth: 0 }}>
                <h1 className="ellipsis" title={session.title}>
                  {session.title || "Sans titre"}
                </h1>
                <span className="tiny muted ellipsis">
                  {projectLabel} · {formatUsd(session.cost ?? 0)}
                  {category ? ` · ${category.emoji} ${category.label}` : ""}
                </span>
              </div>
              {contextLimit && context.tokens > 0 ? (
                <div
                  className="context-gauge"
                  title={`Mémoire de la conversation utilisée : ${formatTokens(context.tokens)} sur ${formatTokens(contextLimit)} jetons`}
                >
                  <span className="tiny muted">Mémoire {formatPercent(contextPercent)}</span>
                  <Meter percent={contextPercent} label="Mémoire de la conversation utilisée" />
                </div>
              ) : null}
              {contextPercent >= 60 && !busy ? (
                <Button size="sm" icon="layers" onClick={() => void summarize()} title={`Résumer la conversation${summaryCost}`}>
                  Résumer
                </Button>
              ) : null}
              <IconButton icon="edit" label="Renommer" onClick={() => setRenaming(session.title)} />
              {conversation ? (
                <a className="btn ghost icon-only" href={api.archiveExportUrl(session.id)} download title="Exporter en Markdown" aria-label="Exporter en Markdown">
                  <Icon name="download" />
                </a>
              ) : null}
              <IconButton icon="trash" label="Supprimer la conversation" onClick={() => void removeSession()} />
              <IconButton icon="panel" label={asideOpen ? "Masquer le contexte" : "Afficher le contexte"} onClick={toggleAside} />
            </>
          ) : (
            <div className="stack tight spacer" style={{ gap: 0 }}>
              <h1>Nouvelle conversation</h1>
              <span className="tiny muted">{projectLabel}</span>
            </div>
          )}
        </header>

        <div className="chat-scroll" ref={scroller} onScroll={onScroll}>
          {!sessionId ? (
            <WelcomeCards
              projectLabel={projectLabel}
              profile={profile}
              copilotConnected={boot.copilotConnected}
              assistants={assistants?.assistants ?? null}
              failed={assistantsFailed}
              catalogue={catalogue}
              picked={picked}
              installing={installing}
              showGeneral={hasBuild}
              onPick={pickAssistant}
              onPickGeneral={() => {
                applyAgent("build");
                setPlaceholder(null);
              }}
              onInstall={(item) => void installAndUse(item)}
              onCreate={() => openAssistants({ mode: "nouveau" })}
              footer={
                <p className="tiny muted">
                  Budget du mois : {formatUsd(boot.usage.spentUsd)} sur {formatUsd(boot.usage.budgetUsd)} ({formatPercent(boot.usage.percent)})
                </p>
              }
            />
          ) : (
            <div className="chat-thread">
              {loadingMessages && turns.length === 0 ? (
                <div className="empty">
                  <Spinner large />
                </div>
              ) : null}
              {turns.map((turn) => (
                <TurnView key={turn.key} turn={turn} root={boot.workspace.root} modelName={modelName} onOpenSession={setDrawer} />
              ))}
              {waitingFirstStep ? (
                <div className="row small muted" style={{ paddingLeft: 34 }}>
                  <Spinner /> L'assistant réfléchit…
                </div>
              ) : null}
              {status?.type === "retry" ? (
                <div className="callout warning small">
                  <Icon name="refresh" size={14} />
                  Nouvelle tentative n° {status.attempt} : {status.message}
                </div>
              ) : null}
            </div>
          )}
        </div>

        {localPermissions.length > 0 || localQuestions.length > 0 || otherPending > 0 ? (
          <div className="interactions">
            {localPermissions.map((request) => (
              <PermissionPrompt
                key={request.id}
                request={request}
                active={canAllow(request)}
                sessionTitle={request.sessionID !== sessionId ? children.find((c) => c.id === request.sessionID)?.title : undefined}
                taskPrompt={taskPromptFor(request)}
                onReply={(reply, message) => replyPermission(request, reply, message)}
              />
            ))}
            {localQuestions.map((request) => (
              <QuestionPrompt
                key={request.id}
                request={request}
                onReply={async (answers) => {
                  try {
                    await oc.replyQuestion(request.id, sessionDirectory, answers);
                    setQuestions((list) => list.filter((q) => q.id !== request.id));
                  } catch (err) {
                    toast.error("Réponse impossible", err);
                  }
                }}
                onReject={async () => {
                  try {
                    await oc.rejectQuestion(request.id, sessionDirectory);
                    setQuestions((list) => list.filter((q) => q.id !== request.id));
                  } catch (err) {
                    toast.error("Action impossible", err);
                  }
                }}
              />
            ))}
            {otherPending > 0 ? (
              <div className="callout warning small">
                <Icon name="shield" size={14} />
                {otherPending} demande{otherPending > 1 ? "s" : ""} en attente dans d'autres conversations (repérées « à valider » dans la liste).
              </div>
            ) : null}
          </div>
        ) : null}

        <Composer
          directory={sessionDirectory}
          busy={busy}
          agents={agentOptions}
          agent={agent}
          agentTitle={titleOf(agent)}
          onAgentChange={(name) => void requestAgentChange(name)}
          commands={commandItems}
          onCommandChange={setDraftCommand}
          imageModel={shownModel ? { name: shownModel.name, attachment: shownModel.attachment } : undefined}
          notice={
            blockingProblems.length > 0 ? (
              <ProblemNotice problems={blockingProblems} update={assistantUpdate} onRealign={realignAssistant}
                onOpenAssistants={() => openAssistants({ mode: "detail", name: shownTurn.agent })}
              />
            ) : null
          }
          ia={
            <IaControls
              turn={shownTurn}
              agentHasModel={agentHasModel}
              advanced={advanced}
              allowOverride={allowOverride}
              tiers={boot.ai.tiers}
              tier={tier}
              onTierChange={(next) => {
                setTier(next);
                setOverride(null);
                setVariant(undefined);
              }}
              models={pickerModels}
              override={override}
              onOverrideChange={(key) => {
                setOverride(key);
                setVariant(undefined);
              }}
              variant={variant}
              onVariantChange={setVariant}
              size={sizeOf(shownTurn.agent)}
            />
          }
          onSubmit={handleSubmit}
          onAbort={abort}
          placeholder={boot.models.length === 0 ? "Aucune IA disponible : connectez GitHub Copilot." : (placeholder ?? undefined)}
        />
      </section>

      {asideOpen && sessionId ? (
        <ContextPanel
          sessionId={sessionId}
          conversation={conversation}
          categoryById={categoryById}
          todos={todos}
          diff={diff}
          childSessions={children}
          usageTick={usageTick}
          onOpenSession={setDrawer}
          onClassify={classify}
          onClose={toggleAside}
        />
      ) : null}

      {drawer ? (
        <SubSessionDrawer sessionId={drawer} root={boot.workspace.root} modelName={modelName} onOpenSession={setDrawer} onClose={() => setDrawer(null)} />
      ) : null}

      <RenameModal value={renaming} onClose={() => setRenaming(null)} onSave={(title) => void rename(title)} />

      <ChangeAssistantModal
        target={changeTarget}
        onCancel={() => setChangeTarget(null)}
        onChange={() => {
          if (changeTarget) applyAgent(changeTarget.name);
          setChangeTarget(null);
        }}
        onNewConversation={() => {
          const name = changeTarget?.name ?? null;
          setChangeTarget(null);
          if (sessionId) {
            nextAgentRef.current = name;
            navigate("chat");
          } else {
            resetChoices(name);
          }
        }}
      />
    </div>
  );
}

function RenameModal({ value, onClose, onSave }: { value: string | null; onClose: () => void; onSave: (title: string) => void }) {
  const [title, setTitle] = useState(value ?? "");
  useEffect(() => setTitle(value ?? ""), [value]);
  return (
    <Modal
      open={value !== null}
      title="Renommer la conversation"
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>Annuler</Button>
          <Button variant="primary" disabled={!title.trim()} onClick={() => onSave(title)}>
            Renommer
          </Button>
        </>
      }
    >
      <input
        className="input"
        value={title}
        maxLength={200}
        aria-label="Titre"
        onChange={(e) => setTitle(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && title.trim()) onSave(title);
        }}
      />
    </Modal>
  );
}
