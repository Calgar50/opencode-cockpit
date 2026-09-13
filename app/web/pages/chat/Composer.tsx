// Zone de saisie : assistant, message, fichiers (@), raccourcis (/), images collées, IA de la demande et
// bandeau de confidentialité permanent.
import { type KeyboardEvent, type ReactNode, useEffect, useId, useRef, useState } from "react";
import { MESSAGES } from "../../../server/shared/assistant-rules.ts";
import { Icon } from "../../components/Icon.tsx";
import { useToast } from "../../components/Toast.tsx";
import { Button } from "../../components/ui.tsx";
import { oc } from "../../lib/api.ts";
import type { CommandOption } from "./turn.ts";

export interface ComposerAttachment {
  id: string;
  kind: "image" | "file";
  filename: string;
  mime: string;
  url: string;
}

export interface ComposerSubmit {
  text: string;
  attachments: ComposerAttachment[];
}

/** Assistant sélectionnable (titre affiché, aide en infobulle). */
export interface AgentOption {
  name: string;
  title: string;
  help: string | null;
}

interface MenuItem {
  value: string;
  label: string;
  hint?: string;
}

interface Menu {
  kind: "file" | "command";
  query: string;
  start: number;
  items: MenuItem[];
  index: number;
}

const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

function fileUrl(directory: string, path: string): string {
  const absolute = path.startsWith("/") || /^[A-Za-z]:[\\/]/.test(path) ? path : `${directory.replace(/[\\/]+$/, "")}/${path}`;
  const normalized = absolute.replace(/\\/g, "/");
  return normalized.startsWith("/") ? `file://${normalized}` : `file:///${normalized}`;
}

function readAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error ?? new Error("lecture impossible"));
    reader.readAsDataURL(file);
  });
}

export function Composer({
  directory,
  busy,
  disabled = false,
  placeholder,
  agents,
  agent,
  agentTitle,
  onAgentChange,
  commands,
  onCommandChange,
  imageModel,
  ia,
  notice,
  onSubmit,
  onAbort,
  seed,
}: {
  directory: string;
  busy: boolean;
  disabled?: boolean;
  placeholder?: string | undefined;
  agents: AgentOption[];
  agent: string;
  /** Titre de l'assistant courant (s'il n'est pas dans la liste). */
  agentTitle: string;
  onAgentChange: (name: string) => void;
  /** Lignes du menu « / » (déjà filtrées selon le mode). */
  commands: CommandOption[];
  /** Nom tapé après « / » en tête du message (null sinon), pour afficher l'IA du raccourci. */
  onCommandChange?: (name: string | null) => void;
  /** IA qui recevra le message (vérification des images). */
  imageModel?: { name: string; attachment: boolean } | undefined;
  /** Choix de l'IA (puce, niveaux, réflexion, coût). */
  ia?: ReactNode;
  /** Message au-dessus de la zone (problème bloquant). */
  notice?: ReactNode;
  /** false (ou promesse de false) : rien n'a été envoyé, le texte est remis dans la zone. */
  onSubmit: (input: ComposerSubmit) => Promise<boolean> | boolean | void;
  onAbort: () => void;
  /** Texte à insérer ; `nonce` change à chaque insertion. */
  seed?: { text: string; nonce: number } | undefined;
}) {
  const toast = useToast();
  const [text, setText] = useState("");
  const [attachments, setAttachments] = useState<ComposerAttachment[]>([]);
  const [menu, setMenu] = useState<Menu | null>(null);
  const [dragging, setDragging] = useState(false);
  const [sending, setSending] = useState(false);
  const area = useRef<HTMLTextAreaElement>(null);
  const searchTimer = useRef<number | undefined>(undefined);
  const searchSeq = useRef(0);
  const selectId = useId();

  const commandName = /^\/([\w-]+)(?=\s|$)/.exec(text)?.[1] ?? null;
  const onCommandChangeRef = useRef(onCommandChange);
  onCommandChangeRef.current = onCommandChange;
  useEffect(() => {
    onCommandChangeRef.current?.(commandName);
  }, [commandName]);

  useEffect(() => {
    const el = area.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, window.innerHeight * 0.4)}px`;
  }, [text]);

  useEffect(() => {
    if (!seed) return;
    setText(seed.text);
    window.requestAnimationFrame(() => {
      const el = area.current;
      if (!el) return;
      el.focus();
      el.setSelectionRange(seed.text.length, seed.text.length);
    });
  }, [seed]);

  const searchFiles = (query: string) => {
    window.clearTimeout(searchTimer.current);
    const seq = ++searchSeq.current;
    searchTimer.current = window.setTimeout(() => {
      oc.findFiles(directory, query).then(
        (files) => {
          if (seq !== searchSeq.current) return;
          setMenu((m) =>
            m && m.kind === "file" && m.query === query ? { ...m, items: files.slice(0, 15).map((f) => ({ value: f, label: f })), index: 0 } : m,
          );
        },
        () => undefined,
      );
    }, 150);
  };

  const updateMenu = (value: string, caret: number) => {
    const before = value.slice(0, caret);
    const command = /^\/([\w-]*)$/.exec(before);
    if (command) {
      const query = (command[1] ?? "").toLowerCase();
      const items = commands
        .filter((c) => c.name.toLowerCase().includes(query))
        .slice(0, 12)
        .map((c) => ({ value: c.name, label: c.label, hint: c.hint }));
      setMenu(items.length > 0 ? { kind: "command", query, start: 0, items, index: 0 } : null);
      return;
    }
    const mention = /(^|\s)@([^\s@]*)$/.exec(before);
    if (mention) {
      const query = mention[2] ?? "";
      setMenu((m) => ({ kind: "file", query, start: caret - query.length - 1, items: m?.kind === "file" ? m.items : [], index: 0 }));
      searchFiles(query);
      return;
    }
    setMenu(null);
  };

  const pick = (item: MenuItem) => {
    if (!menu) return;
    const el = area.current;
    const caret = el?.selectionStart ?? text.length;
    let next: string;
    let position: number;
    if (menu.kind === "command") {
      const rest = text.slice(caret).replace(/^\S*/, "");
      next = `/${item.value} ${rest.trimStart()}`;
      position = item.value.length + 2;
    } else {
      next = `${text.slice(0, menu.start)}@${item.value} ${text.slice(caret)}`;
      position = menu.start + item.value.length + 2;
      setAttachments((list) =>
        list.some((a) => a.kind === "file" && a.filename === item.value)
          ? list
          : [...list, { id: crypto.randomUUID(), kind: "file", filename: item.value, mime: "text/plain", url: fileUrl(directory, item.value) }],
      );
    }
    setText(next);
    setMenu(null);
    window.requestAnimationFrame(() => {
      el?.focus();
      el?.setSelectionRange(position, position);
    });
  };

  const addImages = async (files: Iterable<File>) => {
    for (const file of files) {
      if (!file.type.startsWith("image/")) continue;
      if (imageModel && !imageModel.attachment) {
        toast.warning("Images non prises en charge", `${imageModel.name} n'accepte pas les images.`);
        return;
      }
      if (file.size > MAX_IMAGE_BYTES) {
        toast.warning("Image trop lourde", "5 Mo maximum par image.");
        continue;
      }
      const url = await readAsDataUrl(file);
      setAttachments((list) =>
        list.filter((a) => a.kind === "image").length >= 4
          ? list
          : [...list, { id: crypto.randomUUID(), kind: "image", filename: file.name || "image.png", mime: file.type, url }],
      );
    }
  };

  const submit = () => {
    if (busy || disabled || sending) return;
    const trimmed = text.trim();
    const kept = attachments.filter((a) => a.kind === "image" || trimmed.includes(`@${a.filename}`));
    if (!trimmed && kept.length === 0) return;
    const snapshot = { text, attachments };
    // Rien n'a été envoyé : on remet le message, sauf si l'utilisateur a déjà recommencé à écrire.
    const restore = () => {
      setText((current) => (current ? current : snapshot.text));
      setAttachments((current) => (current.length > 0 ? current : snapshot.attachments));
    };
    setText("");
    setAttachments([]);
    setMenu(null);
    const result = onSubmit({ text: trimmed, attachments: kept });
    if (result instanceof Promise) {
      setSending(true);
      result
        .then(
          (ok) => {
            if (ok === false) restore();
          },
          () => restore(),
        )
        .finally(() => setSending(false));
    } else if (result === false) {
      restore();
    }
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (menu && menu.items.length > 0) {
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        const delta = e.key === "ArrowDown" ? 1 : -1;
        setMenu({ ...menu, index: (menu.index + delta + menu.items.length) % menu.items.length });
        return;
      }
      if (e.key === "Enter" || e.key === "Tab") {
        e.preventDefault();
        const item = menu.items[menu.index];
        if (item) pick(item);
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        setMenu(null);
        return;
      }
    }
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      submit();
    }
  };

  const currentOption = agents.find((a) => a.name === agent);

  return (
    <div className="composer-wrap">
      {notice}
      <div
        className={`composer${dragging ? " dragging" : ""}`}
        onDragOver={(e) => {
          if (e.dataTransfer.types.includes("Files")) {
            e.preventDefault();
            setDragging(true);
          }
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragging(false);
          void addImages(Array.from(e.dataTransfer.files));
        }}
      >
        {menu && menu.items.length > 0 ? (
          <div className="popover" role="listbox" aria-label={menu.kind === "command" ? "Raccourcis" : "Fichiers"}>
            {menu.items.map((item, i) => (
              <button
                key={item.value}
                type="button"
                role="option"
                className="popover-item"
                aria-selected={i === menu.index}
                onMouseDown={(e) => {
                  e.preventDefault();
                  pick(item);
                }}
              >
                <Icon name={menu.kind === "command" ? "terminal" : "file"} size={14} />
                <span className="ellipsis" style={{ flex: "none", maxWidth: "45%" }}>
                  {item.label}
                </span>
                {item.hint ? (
                  <span className="tiny muted ellipsis" style={{ marginLeft: "auto", minWidth: 0 }} title={item.hint}>
                    {item.hint}
                  </span>
                ) : null}
              </button>
            ))}
          </div>
        ) : null}

        <div className="composer-assistant">
          <label className="small muted" htmlFor={selectId}>
            Assistant :
          </label>
          <select
            id={selectId}
            className="select sm"
            value={agent}
            title={currentOption?.help ?? undefined}
            disabled={disabled}
            onChange={(e) => onAgentChange(e.target.value)}
          >
            {currentOption ? null : <option value={agent}>{agentTitle}</option>}
            {agents.map((a) => (
              <option key={a.name} value={a.name} title={a.help ?? undefined}>
                {a.title}
              </option>
            ))}
          </select>
        </div>

        {attachments.length > 0 ? (
          <div className="composer-attachments">
            {attachments.map((a) => (
              <span key={a.id} className="chip">
                {a.kind === "image" ? <img src={a.url} alt="" /> : <Icon name="file" size={12} />}
                <span className="ellipsis" style={{ maxWidth: 220 }}>
                  {a.filename}
                </span>
                <button
                  type="button"
                  className="btn ghost sm icon-only"
                  aria-label={`Retirer ${a.filename}`}
                  onClick={() => setAttachments((list) => list.filter((x) => x.id !== a.id))}
                >
                  <Icon name="x" size={12} />
                </button>
              </span>
            ))}
          </div>
        ) : null}

        <textarea
          ref={area}
          rows={1}
          value={text}
          disabled={disabled}
          placeholder={placeholder ?? "Décrivez ce que vous voulez faire…"}
          aria-label="Message"
          onChange={(e) => {
            setText(e.target.value);
            updateMenu(e.target.value, e.target.selectionStart);
          }}
          onKeyDown={onKeyDown}
          onPaste={(e) => {
            const images = Array.from(e.clipboardData.files).filter((f) => f.type.startsWith("image/"));
            if (images.length > 0) {
              e.preventDefault();
              void addImages(images);
            }
          }}
          onBlur={() => window.setTimeout(() => setMenu(null), 150)}
        />

        <div className="composer-toolbar">
          <div className="spacer composer-ia">{ia}</div>
          <label className="btn ghost sm icon-only" title="Joindre une image">
            <Icon name="image" size={14} />
            <input
              type="file"
              accept="image/*"
              multiple
              hidden
              onChange={(e) => {
                if (e.target.files) void addImages(Array.from(e.target.files));
                e.target.value = "";
              }}
            />
          </label>
          {busy ? (
            <Button size="sm" variant="danger" icon="stop" onClick={onAbort}>
              Arrêter
            </Button>
          ) : (
            <Button
              size="sm"
              variant="primary"
              icon="send"
              loading={sending}
              disabled={disabled || (!text.trim() && attachments.length === 0)}
              onClick={submit}
            >
              Envoyer
            </Button>
          )}
        </div>
      </div>
      <p className="composer-hint">
        <kbd>Entrée</kbd> envoyer · <kbd>Maj</kbd>+<kbd>Entrée</kbd> nouvelle ligne · <kbd>@</kbd> joindre un fichier · <kbd>/</kbd> raccourci
      </p>
      <p className="composer-banner" role="note">
        <Icon name="shield" size={13} />
        <span>{MESSAGES.confidentialityBanner}</span>
      </p>
    </div>
  );
}
