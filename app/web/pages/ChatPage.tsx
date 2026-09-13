// Page Chat : conversations du projet, fil en direct, interactions de l'agent et saisie.
import { useCallback, useEffect, useLayoutEffect, useMemo, useReducer, useRef, useState } from "react";
import { useApp } from "../app/AppContext.tsx";
import { Icon } from "../components/Icon.tsx";
import { useToast } from "../components/Toast.tsx";
import { Button, IconButton, Meter, Modal, Spinner, useConfirm } from "../components/ui.tsx";
import { ApiError, api, oc } from "../lib/api.ts";
import { useEvents } from "../lib/events.ts";
import { formatPercent, formatTokens, formatUsd } from "../lib/format.ts";
import { navigate, useRoute } from "../lib/router.ts";
import type {
  Conversation,
  FileDiff,
  GuardDecision,
  OcAgent,
  OcCommand,
  OcMessage,
  OcMessageWithParts,
  OcPart,
  OcSession,
  OcSessionStatus,
  PermissionRequest,
  QuestionRequest,
  Todo,
} from "../lib/types.ts";
import "./chat/chat.css";
import { Composer, type ComposerSubmit } from "./chat/Composer.tsx";
import { ContextPanel } from "./chat/ContextPanel.tsx";
import { PermissionPrompt, QuestionPrompt } from "./chat/Interactions.tsx";
import { TurnView } from "./chat/MessageView.tsx";
import { SessionSidebar } from "./chat/SessionSidebar.tsx";
import { SubSessionDrawer } from "./chat/SubSessionDrawer.tsx";
import { contextTokens, EMPTY_TRANSCRIPT, groupTurns, transcriptReducer } from "./chat/transcript.ts";

const SUGGESTIONS = [
  { title: "Comprendre le projet", text: "Explique-moi l'architecture de ce projet : dossiers importants, points d'entrée et flux principal." },
  { title: "Corriger un bug", text: "J'ai un bug : " },
  { title: "Écrire des tests", text: "Écris des tests unitaires pour " },
  { title: "Revue de sécurité", text: "Fais une revue de sécurité des changements en cours (git diff) et propose des correctifs." },
];

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

export function ChatPage() {
  const route = useRoute();
  const sessionId = route[0] === "chat" ? (route[1] ?? null) : null;
  const { boot, directory, setDirectory, categoryById, modelByKey } = useApp();
  const toast = useToast();
  const confirm = useConfirm();

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
  const [seed, setSeed] = useState<{ text: string; nonce: number } | undefined>(undefined);

  const defaultModel = useMemo(() => {
    const known = (key: string | null | undefined) => Boolean(key && boot.models.some((m) => m.key === key));
    if (known(boot.settings.chat.defaultModel)) return boot.settings.chat.defaultModel;
    const copilot = boot.modelDefaults["github-copilot"];
    if (copilot && known(`github-copilot/${copilot}`)) return `github-copilot/${copilot}`;
    for (const [provider, id] of Object.entries(boot.modelDefaults)) if (known(`${provider}/${id}`)) return `${provider}/${id}`;
    return boot.models[0]?.key ?? null;
  }, [boot.models, boot.modelDefaults, boot.settings.chat.defaultModel]);

  const [agent, setAgent] = useState<string>(boot.settings.chat.defaultAgent ?? "build");
  const [model, setModel] = useState<string | null>(defaultModel);
  const [variant, setVariant] = useState<string | null>(null);

  useEffect(() => {
    if (!model || !boot.models.some((m) => m.key === model)) setModel(defaultModel);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [defaultModel, boot.models]);

  const sessionRef = useRef<string | null>(sessionId);
  sessionRef.current = sessionId;
  const pendingRef = useRef<string | null>(null);
  const statusesRef = useRef(statuses);
  statusesRef.current = statuses;
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

  const applyLastChoices = useCallback(
    (messages: OcMessageWithParts[]) => {
      for (let i = messages.length - 1; i >= 0; i--) {
        const info = messages[i]?.info;
        if (info?.role !== "user") continue;
        const key = `${info.model.providerID}/${info.model.modelID}`;
        if (boot.models.some((m) => m.key === key)) setModel(key);
        if (info.agent) setAgent(info.agent);
        setVariant(info.model.variant ?? null);
        return;
      }
    },
    [boot.models],
  );

  useEffect(() => {
    dispatch({ type: "reset", messages: [] });
    setTodos([]);
    setDiff([]);
    setChildren([]);
    setSession(null);
    if (!sessionId) return;
    if (pendingRef.current !== sessionId) pendingRef.current = null;
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
        applyLastChoices(messages);
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
        if (sessionRef.current) refetchMessages(sessionRef.current);
      } else if (event.type === "studio.changed") {
        oc.agents(directory).then(setAgents, noop);
        oc.commands(directory).then(setCommands, noop);
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
        if (err && err.name !== "MessageAbortedError") toast.error("Erreur pendant la réponse", err.data?.message ?? err.name);
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

  // --- Actions -----------------------------------------------------------------------

  /** Exécute une action qui appelle un modèle ; propose de confirmer si le garde-fou budgétaire la bloque. */
  const withGuard = useCallback(
    async (action: (confirmed: boolean) => Promise<unknown>): Promise<boolean> => {
      try {
        await action(false);
        return true;
      } catch (err) {
        if (err instanceof ApiError && err.status === 409 && err.code === "budget-guard") {
          const decision = err.data as GuardDecision;
          const ok = await confirm({
            title: "Garde-fou budgétaire",
            message: decision.message ?? "Ce modèle est coûteux au regard du budget restant.",
            confirmLabel: "Envoyer quand même",
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

  const handleSubmit = async (input: ComposerSubmit) => {
    if (!model) {
      toast.warning("Aucun modèle disponible", "Connectez GitHub Copilot dans Paramètres › Connexion.");
      return;
    }
    const slash = model.indexOf("/");
    const providerID = model.slice(0, slash);
    const modelID = model.slice(slash + 1);
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
      const commandMatch = /^\/([\w-]+)(?:\s+([\s\S]*))?$/.exec(input.text);
      const command = commandMatch ? commands.find((c) => c.name === commandMatch[1]) : undefined;
      setStatuses((s) => ({ ...s, [targetId]: { type: "busy" } }));
      stick.current = true;
      const sent = command
        ? await withGuard((confirmed) =>
            oc.command(
              targetId,
              targetDir,
              {
                command: command.name,
                arguments: commandMatch?.[2] ?? "",
                agent,
                model,
                ...(variant ? { variant } : {}),
                ...(fileParts.length > 0 ? { parts: fileParts } : {}),
              },
              confirmed,
            ),
          )
        : await withGuard((confirmed) =>
            oc.promptAsync(
              targetId,
              targetDir,
              {
                agent,
                model: { providerID, modelID },
                ...(variant ? { variant } : {}),
                parts: [...(input.text ? [{ type: "text", text: input.text }] : []), ...fileParts],
              },
              confirmed,
            ),
          );
      if (!sent) setStatuses((s) => ({ ...s, [targetId]: { type: "idle" } }));
    } catch (err) {
      if (sessionRef.current) setStatuses((s) => ({ ...s, [sessionRef.current as string]: { type: "idle" } }));
      toast.error("Envoi impossible", err);
    }
  };

  const abort = () => {
    if (!sessionId) return;
    oc.abort(sessionId, sessionDirectory).catch((err: unknown) => toast.error("Arrêt impossible", err));
  };

  const compact = async () => {
    if (!sessionId || !model) return;
    const slash = model.indexOf("/");
    try {
      toast.info("Compaction du contexte", "L'historique est résumé pour libérer de la place.");
      await withGuard((confirmed) =>
        oc.summarize(sessionId, sessionDirectory, { providerID: model.slice(0, slash), modelID: model.slice(slash + 1) }, confirmed),
      );
    } catch (err) {
      toast.error("Compaction impossible", err);
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

  const replyPermission = async (request: PermissionRequest, reply: "once" | "always" | "reject", message?: string) => {
    try {
      await oc.replyPermission(request.id, sessionDirectory, reply, message);
      setPermissions((list) => list.filter((r) => r.id !== request.id));
    } catch (err) {
      toast.error("Réponse impossible", err);
    }
  };

  const toggleAside = () => {
    setAsideOpen((open) => {
      writeFlag("cockpit-chat-aside", !open);
      return !open;
    });
  };

  // --- Données dérivées ---------------------------------------------------------------

  const turns = useMemo(() => groupTurns(transcript), [transcript]);
  const modelName = useCallback((key: string) => modelByKey(key)?.name ?? key.slice(key.indexOf("/") + 1), [modelByKey]);
  const context = useMemo(() => contextTokens(transcript), [transcript]);
  const contextModel = modelByKey(context.modelKey) ?? modelByKey(model);
  const contextLimit = contextModel?.contextLimit ?? null;
  const contextPercent = contextLimit ? (context.tokens / contextLimit) * 100 : 0;

  const status = sessionId ? statuses[sessionId] : undefined;
  const lastTurn = turns.at(-1);
  const running = Boolean(lastTurn?.replies.some((r) => !r.info.time.completed && !r.info.error));
  const busy = status?.type === "busy" || status?.type === "retry" || running;
  const waitingFirstStep = busy && lastTurn !== undefined && lastTurn.replies.length === 0;

  const relatedIds = new Set([sessionId, ...children.map((c) => c.id)].filter((id): id is string => Boolean(id)));
  const localPermissions = permissions.filter((r) => relatedIds.has(r.sessionID));
  // Consigne d'un sous-agent en attente d'autorisation : opencode ne la joint pas à la demande.
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
        onNew={() => {
          setSidebarOpen(false);
          navigate("chat");
        }}
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
                <div className="context-gauge" title={`Contexte utilisé : ${formatTokens(context.tokens)} sur ${formatTokens(contextLimit)} tokens`}>
                  <span className="tiny muted">Contexte {formatPercent(contextPercent)}</span>
                  <Meter percent={contextPercent} label="Contexte utilisé" />
                </div>
              ) : null}
              {contextPercent >= 60 && !busy ? (
                <Button size="sm" icon="layers" onClick={() => void compact()} title="Résumer l'historique pour libérer du contexte">
                  Compacter
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
            <div className="chat-welcome">
              <img src="/favicon.svg" alt="" width={52} height={52} />
              <h2>Sur quoi travaille-t-on ?</h2>
              <p className="secondary" style={{ maxWidth: 520 }}>
                Projet <strong>{projectLabel}</strong>. L'agent lit et modifie les fichiers de ce dossier ; chaque modification sensible vous est
                soumise selon les permissions configurées.
              </p>
              {!boot.copilotConnected ? (
                <div className="callout warning">
                  <Icon name="plug" />
                  <span>
                    GitHub Copilot n'est pas connecté. <a href="#/parametres/connexion">Connecter maintenant</a>
                  </span>
                </div>
              ) : null}
              <div className="suggestions">
                {SUGGESTIONS.map((s) => (
                  <button key={s.title} type="button" className="btn" onClick={() => setSeed({ text: s.text, nonce: Date.now() })}>
                    <strong>{s.title}</strong>
                    <span className="small muted">{s.text}</span>
                  </button>
                ))}
              </div>
              <p className="tiny muted">
                Budget du mois : {formatUsd(boot.usage.spentUsd)} sur {formatUsd(boot.usage.budgetUsd)} ({formatPercent(boot.usage.percent)})
              </p>
            </div>
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
                  <Spinner /> L'agent réfléchit…
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
          agents={agents}
          agent={agent}
          onAgentChange={setAgent}
          commands={commands}
          models={boot.models}
          model={model}
          onModelChange={(key) => {
            setModel(key);
            setVariant(null);
          }}
          variant={variant}
          onVariantChange={setVariant}
          onSubmit={(input) => void handleSubmit(input)}
          onAbort={abort}
          {...(seed ? { seed } : {})}
          {...(boot.models.length === 0 ? { placeholder: "Aucun modèle disponible : connectez GitHub Copilot." } : {})}
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
