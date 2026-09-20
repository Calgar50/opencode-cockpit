// Tiroir de lecture d'un travail délégué (session enfant), mis à jour en direct. 1.1 (L5t, spécification §5.7.3, JP-4) :
// [Voir la consigne] montre le premier message réellement reçu par le travail délégué (receivedInstruction, turn.ts), jamais la
// seule consigne écrite par l'IA qui délègue ; texte d'IA rendu en texte brut, borné. Vocabulaire du mode Simple (§2.3) : ni
// « sous-agent » ni « session » affichés ; le titre d'opencode (« … (@assistant subagent) ») seulement en Avancé, le nom de
// l'assistant en Simple (delegatedWorkName).
import { useEffect, useId, useMemo, useReducer, useState } from "react";
import { useApp } from "../../app/AppContext.tsx";
import { Button, IconButton, Spinner } from "../../components/ui.tsx";
import { errorText, oc } from "../../lib/api.ts";
import { useEvents } from "../../lib/events.ts";
import { formatUsd, plural } from "../../lib/format.ts";
import type { OcMessage, OcPart, OcSession } from "../../lib/types.ts";
import "./activity/deroule.css";
import { TurnView } from "./MessageView.tsx";
import { EMPTY_TRANSCRIPT, groupTurns, type MessageEntry, transcriptReducer } from "./transcript.ts";
import { delegatedWorkName, receivedInstruction } from "./turn.ts";

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
  const { advanced } = useApp();
  const [transcript, dispatch] = useReducer(transcriptReducer, EMPTY_TRANSCRIPT);
  const [info, setInfo] = useState<OcSession | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [showInstruction, setShowInstruction] = useState(false);
  const instructionId = useId();

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setShowInstruction(false);
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
  const instruction = useMemo(
    () => receivedInstruction(transcript.order.map((id) => transcript.byId.get(id)).filter((entry): entry is MessageEntry => entry !== undefined)),
    [transcript],
  );

  return (
    <div className="drawer-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="drawer" role="dialog" aria-modal="true" aria-label="Travail délégué">
        <div className="chat-header">
          <div className="stack tight spacer" style={{ gap: 0, minWidth: 0 }}>
            <h1 className="ellipsis">{advanced ? info?.title ?? "Travail délégué" : delegatedWorkName(info)}</h1>
            <span className="tiny muted">
              Travail délégué{info?.cost ? ` · ${formatUsd(info.cost)}` : ""}
              {advanced ? <span className="mono"> · {sessionId}</span> : null}
            </span>
          </div>
          <Button
            size="sm"
            variant="ghost"
            icon="file"
            aria-expanded={showInstruction}
            aria-controls={instructionId}
            onClick={() => setShowInstruction((v) => !v)}
          >
            Voir la consigne
          </Button>
          <IconButton icon="x" label="Fermer" onClick={onClose} />
        </div>
        {showInstruction ? (
          <section id={instructionId} className="instruction-panel" aria-label="Consigne reçue">
            <div className="tiny muted">Consigne reçue par le travail délégué, telle qu'il l'a lue</div>
            {instruction === null ? (
              <p className="small muted">{loading ? "Lecture de la consigne…" : "Aucune consigne reçue pour l'instant."}</p>
            ) : (
              <>
                <p className="delegation-text-body">
                  {instruction.text || "(consigne sans texte)"}
                  {instruction.clipped ? "\n… (texte coupé)" : ""}
                </p>
                {instruction.added > 0 ? (
                  <p className="tiny muted">
                    {plural(instruction.added, "partie ajoutée par opencode (fichier joint ou texte) non montrée", "parties ajoutées par opencode (fichiers joints ou textes) non montrées")}.
                  </p>
                ) : null}
              </>
            )}
          </section>
        ) : null}
        <div className="chat-scroll">
          <div className="chat-thread">
            {loading ? <Spinner large /> : null}
            {error ? <div className="callout critical">{error}</div> : null}
            {turns.map((turn) => (
              <TurnView key={turn.key} turn={turn} root={root} modelName={modelName} onOpenSession={onOpenSession} conversationRoot={false} />
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
