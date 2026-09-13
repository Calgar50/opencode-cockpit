// Demandes d'autorisation et questions posées par l'assistant pendant une réponse.
import { useState } from "react";
import { DiffView } from "../../components/DiffView.tsx";
import { Icon } from "../../components/Icon.tsx";
import { Badge, Button } from "../../components/ui.tsx";
import type { PermissionRequest, QuestionRequest } from "../../lib/types.ts";

const PERMISSION_LABELS: Record<string, string> = {
  edit: "modifier un fichier",
  write: "écrire un fichier",
  bash: "exécuter une commande",
  webfetch: "consulter une page web",
  websearch: "faire une recherche sur le web",
  external_directory: "accéder à un dossier hors du projet",
  doom_loop: "poursuivre une action répétée en boucle",
  read: "lire un fichier",
  task: "déléguer le travail à un autre assistant",
  skill: "consulter une fiche",
};

/** Mode Simple : pas de « Toujours autoriser » pour les commandes et les dossiers hors du projet. */
const ONCE_ONLY_IN_SIMPLE = new Set(["bash", "external_directory"]);

const str = (value: unknown) => (typeof value === "string" ? value : null);

export function PermissionPrompt({
  request,
  sessionTitle,
  taskPrompt,
  simpleMode = true,
  onReply,
}: {
  request: PermissionRequest;
  sessionTitle?: string | undefined;
  /** Consigne du travail délégué demandé (opencode ne la joint pas à la demande d'autorisation). */
  taskPrompt?: string | undefined;
  /** Mode d'affichage Simple (défaut prudent). */
  simpleMode?: boolean;
  onReply: (reply: "once" | "always" | "reject", message?: string) => Promise<void>;
}) {
  const [busy, setBusy] = useState<string | null>(null);
  const [refusing, setRefusing] = useState(false);
  const [message, setMessage] = useState("");
  const metadata = request.metadata ?? {};
  const diff = str(metadata.diff);
  const command = str(metadata.command);
  const file = str(metadata.filepath) ?? str(metadata.filePath);
  const isTask = request.permission === "task";
  // Pour une délégation, « Toujours » (motif *) autoriserait toutes les délégations suivantes du projet sans voir leur consigne.
  // En mode Simple, une commande ou un dossier hors du projet s'autorise une fois à la fois.
  const allowAlways = request.always.length > 0 && !isTask && !(simpleMode && ONCE_ONLY_IN_SIMPLE.has(request.permission));

  const act = async (reply: "once" | "always" | "reject", note?: string) => {
    setBusy(reply);
    try {
      await onReply(reply, note);
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="interaction" role="alertdialog" aria-label="Demande d'autorisation">
      <div className="row">
        <Icon name="shield" size={18} />
        <strong className="spacer">L'assistant demande l'autorisation de {PERMISSION_LABELS[request.permission] ?? request.permission}</strong>
        {sessionTitle ? <span className="small muted ellipsis">{sessionTitle}</span> : null}
      </div>
      {command ? (
        <pre className="terminal">
          <span className="prompt">$ </span>
          {command}
        </pre>
      ) : null}
      {file && !diff ? <code>{file}</code> : null}
      {diff ? <DiffView patch={diff} maxLines={120} /> : null}
      {!command && !diff && request.patterns.length > 0 ? (
        <div className="row wrap">
          {request.patterns.map((pattern) => (
            <code key={pattern}>{pattern}</code>
          ))}
        </div>
      ) : null}
      {isTask ? (
        <div className="stack tight">
          {str(metadata.description) ? <span className="small">{str(metadata.description)}</span> : null}
          {taskPrompt ? (
            <pre className="terminal">{taskPrompt}</pre>
          ) : (
            <span className="tiny muted">Consigne du travail délégué indisponible : vérifiez-la dans la réponse avant d'autoriser.</span>
          )}
        </div>
      ) : null}
      {refusing ? (
        <div className="row">
          <input
            className="input sm"
            placeholder="Consigne pour l'assistant (facultatif)"
            aria-label="Consigne pour l'assistant"
            value={message}
            autoFocus
            onChange={(e) => setMessage(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") void act("reject", message.trim() || undefined);
            }}
          />
          <Button size="sm" variant="danger" loading={busy === "reject"} onClick={() => void act("reject", message.trim() || undefined)}>
            Refuser
          </Button>
          <Button size="sm" variant="ghost" onClick={() => setRefusing(false)}>
            Annuler
          </Button>
        </div>
      ) : (
        <div className="row wrap">
          <Button size="sm" variant="primary" icon="check" loading={busy === "once"} disabled={busy !== null} onClick={() => void act("once")}>
            Autoriser une fois
          </Button>
          {allowAlways ? (
            <Button
              size="sm"
              loading={busy === "always"}
              disabled={busy !== null}
              title={`Ne plus demander pour : ${request.always.join(", ")} (toutes les conversations de ce projet, jusqu'au redémarrage d'opencode)`}
              onClick={() => void act("always")}
            >
              Toujours autoriser
            </Button>
          ) : null}
          <Button size="sm" variant="danger" disabled={busy !== null} onClick={() => setRefusing(true)}>
            Refuser…
          </Button>
          {allowAlways ? (
            <span className="tiny muted ellipsis">« Toujours » couvre, pour tout le projet : {request.always.join(", ")}</span>
          ) : null}
        </div>
      )}
    </div>
  );
}

export function QuestionPrompt({
  request,
  onReply,
  onReject,
}: {
  request: QuestionRequest;
  onReply: (answers: string[][]) => Promise<void>;
  onReject: () => Promise<void>;
}) {
  const [answers, setAnswers] = useState<string[][]>(() => request.questions.map(() => []));
  const [custom, setCustom] = useState<string[]>(() => request.questions.map(() => ""));
  const [busy, setBusy] = useState(false);

  const toggle = (index: number, label: string, multiple: boolean) =>
    setAnswers((current) =>
      current.map((selected, i) => {
        if (i !== index) return selected;
        if (selected.includes(label)) return selected.filter((l) => l !== label);
        return multiple ? [...selected, label] : [label];
      }),
    );

  const final = answers.map((selected, i) => {
    const extra = (custom[i] ?? "").trim();
    return extra ? [...selected, extra] : selected;
  });
  const complete = final.every((a) => a.length > 0);

  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    try {
      await fn();
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="interaction question" role="dialog" aria-label="Question de l'assistant">
      <div className="row">
        <Icon name="question" size={18} />
        <strong>L'assistant a besoin d'une précision</strong>
      </div>
      {request.questions.map((question, index) => (
        <div key={index} className="stack tight">
          <div className="row wrap">
            {question.header ? <Badge tone="accent">{question.header}</Badge> : null}
            <span>{question.question}</span>
          </div>
          <div className="option-grid">
            {question.options.map((option) => (
              <button
                key={option.label}
                type="button"
                className="btn"
                aria-pressed={answers[index]?.includes(option.label) ?? false}
                onClick={() => toggle(index, option.label, Boolean(question.multiple))}
              >
                <strong>{option.label}</strong>
                {option.description ? <span className="tiny muted">{option.description}</span> : null}
              </button>
            ))}
          </div>
          {question.custom !== false ? (
            <input
              className="input sm"
              placeholder="Autre réponse (facultatif)"
              aria-label="Autre réponse"
              value={custom[index] ?? ""}
              onChange={(e) => setCustom((c) => c.map((v, i) => (i === index ? e.target.value : v)))}
            />
          ) : null}
        </div>
      ))}
      <div className="row">
        <Button size="sm" variant="primary" disabled={!complete || busy} loading={busy} onClick={() => void run(() => onReply(final))}>
          Répondre
        </Button>
        <Button size="sm" variant="ghost" disabled={busy} onClick={() => void run(onReject)}>
          Ignorer la question
        </Button>
      </div>
    </div>
  );
}
