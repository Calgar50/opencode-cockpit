import { createContext, type ReactNode, useCallback, useContext, useMemo, useRef, useState } from "react";
import { errorText } from "../lib/api.ts";
import { Icon, type IconName } from "./Icon.tsx";

type ToastKind = "info" | "success" | "warning" | "error";

interface ToastItem {
  id: number;
  kind: ToastKind;
  title: string;
  message?: string;
}

interface ToastApi {
  info: (title: string, message?: string) => void;
  success: (title: string, message?: string) => void;
  warning: (title: string, message?: string) => void;
  error: (title: string, detail?: unknown) => void;
}

const ToastContext = createContext<ToastApi | null>(null);

const ICONS: Record<ToastKind, IconName> = { info: "sparkle", success: "check", warning: "alert", error: "alert" };

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]);
  const nextId = useRef(1);

  const dismiss = useCallback((id: number) => setItems((list) => list.filter((t) => t.id !== id)), []);

  const push = useCallback(
    (kind: ToastKind, title: string, message?: string) => {
      const id = nextId.current++;
      setItems((list) => [...list.slice(-4), { id, kind, title, ...(message ? { message } : {}) }]);
      window.setTimeout(() => dismiss(id), kind === "error" ? 9_000 : 5_000);
    },
    [dismiss],
  );

  const api = useMemo<ToastApi>(
    () => ({
      info: (title, message) => push("info", title, message),
      success: (title, message) => push("success", title, message),
      warning: (title, message) => push("warning", title, message),
      error: (title, detail) => push("error", title, detail === undefined ? undefined : typeof detail === "string" ? detail : errorText(detail)),
    }),
    [push],
  );

  return (
    <ToastContext.Provider value={api}>
      {children}
      <div className="toast-stack" role="status" aria-live="polite">
        {items.map((t) => (
          <div key={t.id} className={`toast ${t.kind}`}>
            <Icon name={ICONS[t.kind]} size={18} />
            <div className="spacer" style={{ minWidth: 0 }}>
              <strong>{t.title}</strong>
              {t.message ? <p>{t.message}</p> : null}
            </div>
            <button type="button" className="btn ghost sm icon-only" aria-label="Fermer" onClick={() => dismiss(t.id)}>
              <Icon name="x" size={14} />
            </button>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast(): ToastApi {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error("ToastProvider manquant");
  return ctx;
}
