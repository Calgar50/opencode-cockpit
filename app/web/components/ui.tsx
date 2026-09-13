// Composants de base de l'interface.
import {
  type ButtonHTMLAttributes,
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useId,
  useRef,
  useState,
} from "react";
import type { Category } from "../lib/types.ts";
import { Icon, type IconName } from "./Icon.tsx";

type ButtonVariant = "default" | "primary" | "ghost" | "danger" | "danger-solid";

export function Button({
  variant = "default",
  size = "md",
  icon,
  loading = false,
  children,
  className,
  type = "button",
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: ButtonVariant;
  size?: "sm" | "md";
  icon?: IconName;
  loading?: boolean;
}) {
  const classes = [
    "btn",
    variant === "danger-solid" ? "danger solid" : variant === "default" ? "" : variant,
    size === "sm" ? "sm" : "",
    !children ? "icon-only" : "",
    className ?? "",
  ]
    .filter(Boolean)
    .join(" ");
  return (
    <button type={type} className={classes} {...rest} disabled={rest.disabled || loading}>
      {loading ? <span className="spinner" /> : icon ? <Icon name={icon} size={size === "sm" ? 14 : 16} /> : null}
      {children}
    </button>
  );
}

export function IconButton({
  icon,
  label,
  size = "md",
  variant = "ghost",
  ...rest
}: Omit<ButtonHTMLAttributes<HTMLButtonElement>, "children"> & {
  icon: IconName;
  label: string;
  size?: "sm" | "md";
  variant?: ButtonVariant;
}) {
  return <Button variant={variant} size={size} icon={icon} aria-label={label} title={label} {...rest} />;
}

export type Tone = "neutral" | "accent" | "good" | "warning" | "critical";

export function Badge({ tone = "neutral", children, title }: { tone?: Tone; children: ReactNode; title?: string }) {
  return (
    <span className={`badge ${tone === "neutral" ? "" : tone}`} title={title}>
      {children}
    </span>
  );
}

export function Spinner({ large = false, label = "Chargement" }: { large?: boolean; label?: string }) {
  return <span className={`spinner${large ? " lg" : ""}`} role="status" aria-label={label} />;
}

export function EmptyState({
  icon = "sparkle",
  title,
  children,
  action,
}: {
  icon?: IconName;
  title: string;
  children?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="empty">
      <Icon name={icon} size={32} strokeWidth={1.4} />
      <h3>{title}</h3>
      {children ? <p>{children}</p> : null}
      {action}
    </div>
  );
}

export function Card({
  title,
  subtitle,
  actions,
  children,
  className,
  flush = false,
}: {
  title?: ReactNode;
  subtitle?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
  flush?: boolean;
}) {
  return (
    <section className={`card${flush ? " flush" : ""}${className ? ` ${className}` : ""}`}>
      {title || actions ? (
        <div className="card-header" style={flush ? { padding: "14px 16px 0" } : undefined}>
          <div className="stack tight" style={{ gap: 2 }}>
            {title ? <h3>{title}</h3> : null}
            {subtitle ? <p>{subtitle}</p> : null}
          </div>
          <span className="spacer" />
          {actions}
        </div>
      ) : null}
      {children}
    </section>
  );
}

export function Field({
  label,
  hint,
  error,
  children,
  htmlFor,
}: {
  label: ReactNode;
  hint?: ReactNode;
  error?: string | null;
  children: ReactNode;
  htmlFor?: string;
}) {
  return (
    <div className="field">
      <label htmlFor={htmlFor}>{label}</label>
      {children}
      {error ? <span className="field-error">{error}</span> : hint ? <span className="field-hint">{hint}</span> : null}
    </div>
  );
}

export function Toggle({
  checked,
  onChange,
  label,
  disabled,
}: {
  checked: boolean;
  onChange: (value: boolean) => void;
  label: string;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      role="switch"
      className="toggle"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
    />
  );
}

export function ToggleRow({
  title,
  description,
  checked,
  onChange,
  disabled,
}: {
  title: string;
  description?: ReactNode;
  checked: boolean;
  onChange: (value: boolean) => void;
  disabled?: boolean;
}) {
  return (
    <div className="toggle-row">
      <div className="stack tight spacer">
        <strong style={{ fontWeight: 600 }}>{title}</strong>
        {description ? <span className="small muted">{description}</span> : null}
      </div>
      <Toggle checked={checked} onChange={onChange} label={title} disabled={disabled} />
    </div>
  );
}

export function Segmented<T extends string>({
  value,
  options,
  onChange,
  label,
}: {
  value: T;
  options: Array<{ value: T; label: ReactNode; title?: string }>;
  onChange: (value: T) => void;
  label: string;
}) {
  return (
    <div className="segmented" role="group" aria-label={label}>
      {options.map((o) => (
        <button key={o.value} type="button" aria-pressed={o.value === value} title={o.title} onClick={() => onChange(o.value)}>
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function Tabs<T extends string>({
  value,
  items,
  onChange,
}: {
  value: T;
  items: Array<{ id: T; label: string; icon?: IconName; count?: number }>;
  onChange: (id: T) => void;
}) {
  return (
    <div className="tabs" role="tablist">
      {items.map((item) => (
        <button key={item.id} type="button" role="tab" className="tab" aria-selected={item.id === value} onClick={() => onChange(item.id)}>
          {item.icon ? <Icon name={item.icon} size={15} /> : null}
          {item.label}
          {item.count !== undefined ? <span className="count">{item.count}</span> : null}
        </button>
      ))}
    </div>
  );
}

export function Meter({ percent, large = false, label }: { percent: number; large?: boolean; label: string }) {
  const clamped = Math.max(0, Math.min(100, Number.isFinite(percent) ? percent : 100));
  const tone = percent >= 90 ? "critical" : percent >= 75 ? "warning" : "";
  return (
    <div
      className={`meter${large ? " lg" : ""}${tone ? ` ${tone}` : ""}`}
      role="meter"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(clamped)}
    >
      <span style={{ width: `${clamped}%` }} />
    </div>
  );
}

export function CategoryChip({ category, fallback }: { category: Category | undefined; fallback?: string }) {
  if (!category) return <span className="chip">{fallback ?? "Non classé"}</span>;
  return (
    <span className="chip" title={category.description}>
      <span className="swatch" style={{ background: category.color }} />
      <span aria-hidden>{category.emoji}</span>
      <span className="ellipsis">{category.label}</span>
    </span>
  );
}

export function Modal({
  open,
  title,
  onClose,
  children,
  footer,
  wide = false,
}: {
  open: boolean;
  title: ReactNode;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
  wide?: boolean;
}) {
  const panel = useRef<HTMLDivElement>(null);
  const backdrop = useRef<HTMLDivElement>(null);
  const titleId = useId();
  useEffect(() => {
    if (!open) return;
    const previous = document.activeElement as HTMLElement | null;
    const focusable = panel.current?.querySelector<HTMLElement>("input, textarea, select, button:not([data-close])");
    (focusable ?? panel.current)?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      // Modales empilées : seule celle du dessus se ferme.
      const stack = document.querySelectorAll(".modal-backdrop");
      if (stack[stack.length - 1] === backdrop.current) onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      previous?.focus?.();
    };
  }, [open, onClose]);
  if (!open) return null;
  return (
    <div className="modal-backdrop" ref={backdrop} onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className={`modal${wide ? " wide" : ""}`} role="dialog" aria-modal="true" aria-labelledby={titleId} ref={panel} tabIndex={-1}>
        <div className="modal-header">
          <h2 id={titleId} className="spacer" style={{ fontSize: 16 }}>
            {title}
          </h2>
          <IconButton icon="x" label="Fermer" onClick={onClose} data-close />
        </div>
        <div className="modal-body">{children}</div>
        {footer ? <div className="modal-footer">{footer}</div> : null}
      </div>
    </div>
  );
}

// --- Confirmation asynchrone -------------------------------------------------------------

interface ConfirmOptions {
  title: string;
  message?: ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  danger?: boolean;
}

const ConfirmContext = createContext<((options: ConfirmOptions) => Promise<boolean>) | null>(null);

export function ConfirmProvider({ children }: { children: ReactNode }) {
  const [pending, setPending] = useState<(ConfirmOptions & { resolve: (ok: boolean) => void }) | null>(null);
  const confirm = useCallback(
    (options: ConfirmOptions) => new Promise<boolean>((resolve) => setPending({ ...options, resolve })),
    [],
  );
  const close = (ok: boolean) => {
    pending?.resolve(ok);
    setPending(null);
  };
  return (
    <ConfirmContext.Provider value={confirm}>
      {children}
      <Modal
        open={pending !== null}
        title={pending?.title ?? ""}
        onClose={() => close(false)}
        footer={
          <>
            <Button onClick={() => close(false)}>{pending?.cancelLabel ?? "Annuler"}</Button>
            <Button variant={pending?.danger ? "danger-solid" : "primary"} onClick={() => close(true)}>
              {pending?.confirmLabel ?? "Confirmer"}
            </Button>
          </>
        }
      >
        {typeof pending?.message === "string" ? <p className="secondary">{pending.message}</p> : pending?.message}
      </Modal>
    </ConfirmContext.Provider>
  );
}

export function useConfirm(): (options: ConfirmOptions) => Promise<boolean> {
  const ctx = useContext(ConfirmContext);
  if (!ctx) throw new Error("ConfirmProvider manquant");
  return ctx;
}

/** Charge des données asynchrones avec gestion d'erreur ; `reload` relance le chargement. */
export function useAsync<T>(loader: () => Promise<T>, deps: unknown[]): {
  data: T | null;
  error: unknown;
  loading: boolean;
  reload: () => void;
  setData: (value: T | null | ((previous: T | null) => T | null)) => void;
} {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [loading, setLoading] = useState(true);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    loader().then(
      (value) => {
        if (cancelled) return;
        setData(value);
        setError(null);
        setLoading(false);
      },
      (err: unknown) => {
        if (cancelled) return;
        setError(err);
        setLoading(false);
      },
    );
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, tick]);
  return { data, error, loading, reload: () => setTick((t) => t + 1), setData };
}
