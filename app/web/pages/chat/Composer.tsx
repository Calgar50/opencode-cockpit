// Zone de saisie : message, fichiers (@), commandes (/), images collées, agent, modèle et estimation du coût.
import { type KeyboardEvent, useEffect, useRef, useState } from "react";
import { Icon } from "../../components/Icon.tsx";
import { useToast } from "../../components/Toast.tsx";
import { Badge, Button, useAsync } from "../../components/ui.tsx";
import { api, oc } from "../../lib/api.ts";
import { formatPricePerM, formatUsd } from "../../lib/format.ts";
import type { ModelInfo, OcAgent, OcCommand } from "../../lib/types.ts";
import { ModelPicker } from "./ModelPicker.tsx";

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

function EstimateChip({ model }: { model: ModelInfo | undefined }) {
  const estimate = useAsync(
    () => (model ? api.usageEstimate(model.providerID, model.modelID) : Promise.resolve(null)),
    [model?.key],
  );
  if (!model) return null;
  const data = estimate.data;
  const guarded = data && !data.guard.allowed;
  if (data?.avgUsd != null) {
    return (
      <span className="row tiny muted" title={`Coût moyen observé sur ${data.samples} demande(s) ces 30 derniers jours`}>
        ≈ {formatUsd(data.avgUsd)} / demande
        {guarded ? <Badge tone="warning">confirmation requise</Badge> : null}
      </span>
    );
  }
  if (model.price) {
    return (
      <span className="row tiny muted" title="Prix par million de tokens (entrée → sortie)">
        {formatPricePerM(model.price.rates.input)} → {formatPricePerM(model.price.rates.output)}
        {guarded ? <Badge tone="warning">confirmation requise</Badge> : null}
      </span>
    );
  }
  return null;
}

export function Composer({
  directory,
  busy,
  disabled = false,
  placeholder,
  agents,
  agent,
  onAgentChange,
  commands,
  models,
  model,
  onModelChange,
  variant,
  onVariantChange,
  onSubmit,
  onAbort,
  seed,
}: {
  directory: string;
  busy: boolean;
  disabled?: boolean;
  placeholder?: string;
  agents: OcAgent[];
  agent: string;
  onAgentChange: (name: string) => void;
  commands: OcCommand[];
  models: ModelInfo[];
  model: string | null;
  onModelChange: (key: string) => void;
  variant: string | null;
  onVariantChange: (variant: string | null) => void;
  onSubmit: (input: ComposerSubmit) => void;
  onAbort: () => void;
  /** Texte à insérer (suggestions) ; `nonce` change à chaque insertion. */
  seed?: { text: string; nonce: number };
}) {
  const toast = useToast();
  const [text, setText] = useState("");
  const [attachments, setAttachments] = useState<ComposerAttachment[]>([]);
  const [menu, setMenu] = useState<Menu | null>(null);
  const [dragging, setDragging] = useState(false);
  const area = useRef<HTMLTextAreaElement>(null);
  const searchTimer = useRef<number | undefined>(undefined);
  const searchSeq = useRef(0);

  const selectedModel = models.find((m) => m.key === model);
  const primaryAgents = agents.filter((a) => a.mode !== "subagent" && !a.hidden);
  const variants = selectedModel?.variants ?? [];

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
        .map((c) => ({ value: c.name, label: `/${c.name}`, hint: c.description ?? (c.source === "skill" ? "skill" : "") }));
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
      if (selectedModel && !selectedModel.attachment) {
        toast.warning("Images non prises en charge", `${selectedModel.name} n'accepte pas les images.`);
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
    if (busy || disabled) return;
    const trimmed = text.trim();
    const kept = attachments.filter((a) => a.kind === "image" || trimmed.includes(`@${a.filename}`));
    if (!trimmed && kept.length === 0) return;
    onSubmit({ text: trimmed, attachments: kept });
    setText("");
    setAttachments([]);
    setMenu(null);
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

  return (
    <div className="composer-wrap">
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
          <div className="popover" role="listbox" aria-label={menu.kind === "command" ? "Commandes" : "Fichiers"}>
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
                <span className="ellipsis">{item.label}</span>
                {item.hint ? <span className="tiny muted ellipsis" style={{ marginLeft: "auto", maxWidth: 200 }}>{item.hint}</span> : null}
              </button>
            ))}
          </div>
        ) : null}

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
          <select
            className="select sm"
            style={{ width: "auto" }}
            value={agent}
            aria-label="Agent"
            title="Agent principal"
            onChange={(e) => onAgentChange(e.target.value)}
          >
            {primaryAgents.length === 0 ? <option value={agent}>{agent}</option> : null}
            {primaryAgents.map((a) => (
              <option key={a.name} value={a.name} title={a.description}>
                {a.name}
              </option>
            ))}
          </select>
          <ModelPicker models={models} value={model} onChange={onModelChange} />
          {variants.length > 0 ? (
            <select
              className="select sm"
              style={{ width: "auto" }}
              value={variant ?? ""}
              aria-label="Effort de raisonnement"
              title="Effort de raisonnement (plus d'effort = plus de tokens)"
              onChange={(e) => onVariantChange(e.target.value || null)}
            >
              <option value="">Effort : défaut</option>
              {variants.map((v) => (
                <option key={v} value={v}>
                  Effort : {v}
                </option>
              ))}
            </select>
          ) : null}
          <EstimateChip model={selectedModel} />
          <span className="spacer" />
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
            <Button size="sm" variant="primary" icon="send" disabled={disabled || (!text.trim() && attachments.length === 0)} onClick={submit}>
              Envoyer
            </Button>
          )}
        </div>
      </div>
      <p className="composer-hint">
        <kbd>Entrée</kbd> envoyer · <kbd>Maj</kbd>+<kbd>Entrée</kbd> nouvelle ligne · <kbd>@</kbd> joindre un fichier · <kbd>/</kbd> commande · collez
        une image
      </p>
    </div>
  );
}
