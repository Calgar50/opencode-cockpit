// Tiroir de lecture du travail d'un sous-agent (session enfant), mis à jour en direct.
import { useEffect, useMemo, useReducer, useState } from "react";
import { IconButton, Spinner } from "../../components/ui.tsx";
import { errorText, oc } from "../../lib/api.ts";
import { useEvents } from "../../lib/events.ts";
import { formatUsd } from "../../lib/format.ts";
import type { OcMessage, OcPart, OcSession } from "../../lib/types.ts";
import { TurnView } from "./MessageView.tsx";
import { EMPTY_TRANSCRIPT, groupTurns, transcriptReducer } from "./transcript.ts";

export function SubSessionDrawer({
  sessionId,
  root,
  modelName,
  onOpenSession,
  onClose,
}: {
  sessionId: string;
  root: string;
  modelName: (key: string) => string;
  onOpenSession: (id: string) => void;
  onClose: () => void;
}) {
  const [transcript, dispatch] = useReducer(transcriptReducer, EMPTY_TRANSCRIPT);
  const [info, setInfo] = useState<OcSession | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    dispatch({ type: "reset", messages: [] });
    Promise.all([oc.session(sessionId), oc.messages(sessionId)]).then(
      ([session, messages]) => {
        if (cancelled) return;
        setInfo(session);
        dispatch({ type: "merge-missing", messages });
        setLoading(false);
      },
      (err: unknown) => {
        if (cancelled) return;
        setError(errorText(err));
        setLoading(false);
      },
    );
    return () => {
      cancelled = true;
    };
  }, [sessionId]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  useEvents((event) => {
    if (event.kind !== "opencode") return;
    const { type, properties: p } = event.event;
    if (type === "message.updated" && (p.info as OcMessage).sessionID === sessionId) dispatch({ type: "message", info: p.info as OcMessage });
    else if (type === "message.part.updated" && (p.part as OcPart).sessionID === sessionId) dispatch({ type: "part", part: p.part as OcPart });
    else if (type === "message.part.delta" && p.sessionID === sessionId) {
      dispatch({ type: "part.delta", messageID: String(p.messageID), partID: String(p.partID), field: String(p.field), delta: String(p.delta) });
    } else if (type === "session.updated" && (p.info as OcSession).id === sessionId) setInfo(p.info as OcSession);
  });

  const turns = useMemo(() => groupTurns(transcript), [transcript]);

  return (
    <div className="drawer-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="drawer" role="dialog" aria-modal="true" aria-label="Travail du sous-agent">
        <div className="chat-header">
          <div className="stack tight spacer" style={{ gap: 0, minWidth: 0 }}>
            <h1 className="ellipsis">{info?.title ?? "Sous-agent"}</h1>
            <span className="tiny muted">
              Session enfant{info?.cost ? ` · ${formatUsd(info.cost)}` : ""}
            </span>
          </div>
          <IconButton icon="x" label="Fermer" onClick={onClose} />
        </div>
        <div className="chat-scroll">
          <div className="chat-thread">
            {loading ? <Spinner large /> : null}
            {error ? <div className="callout critical">{error}</div> : null}
            {turns.map((turn) => (
              <TurnView key={turn.key} turn={turn} root={root} modelName={modelName} onOpenSession={onOpenSession} />
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
