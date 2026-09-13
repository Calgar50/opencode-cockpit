// Coquille de l'application : amorçage, connexion, navigation, bandeaux d'alerte.
import { type FormEvent, useCallback, useEffect, useRef, useState } from "react";
import { Icon, type IconName } from "../components/Icon.tsx";
import { ToastProvider, useToast } from "../components/Toast.tsx";
import { Button, ConfirmProvider, IconButton, Meter, Spinner } from "../components/ui.tsx";
import { ApiError, api, errorText, onUnauthorized } from "../lib/api.ts";
import { cockpitEvent, eventBus, useEvents, useStreamStatus } from "../lib/events.ts";
import { formatPercent, formatUsd } from "../lib/format.ts";
import { navigate, routeHref, useRoute } from "../lib/router.ts";
import type { BudgetAlert, Bootstrap, EventsStatus, Settings } from "../lib/types.ts";
import { ArchivesPage } from "../pages/ArchivesPage.tsx";
import { ChatPage } from "../pages/ChatPage.tsx";
import { CostsPage } from "../pages/CostsPage.tsx";
import { DiagnosticsPage } from "../pages/DiagnosticsPage.tsx";
import { SettingsPage } from "../pages/SettingsPage.tsx";
import { StudioPage } from "../pages/StudioPage.tsx";
import { AppProvider, type ThemeChoice, useApp } from "./AppContext.tsx";

const NAV: Array<{ id: string; label: string; icon: IconName }> = [
  { id: "chat", label: "Chat", icon: "chat" },
  { id: "couts", label: "Coûts", icon: "coins" },
  { id: "archives", label: "Archives", icon: "archive" },
  { id: "studio", label: "Studio", icon: "bot" },
  { id: "parametres", label: "Paramètres", icon: "settings" },
  { id: "diagnostic", label: "Diagnostic", icon: "pulse" },
];

export function App() {
  const [phase, setPhase] = useState<"loading" | "login" | "ready" | "error">("loading");
  const [boot, setBoot] = useState<Bootstrap | null>(null);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    try {
      const data = await api.bootstrap();
      setBoot(data);
      setPhase("ready");
      eventBus.connect();
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) {
        setPhase("login");
      } else {
        setError(errorText(err));
        setPhase("error");
      }
    }
  }, []);

  useEffect(() => {
    void load();
    return onUnauthorized(() => {
      eventBus.disconnect();
      setPhase("login");
    });
  }, [load]);

  return (
    <ToastProvider>
      <ConfirmProvider>
        {phase === "loading" ? (
          <div className="empty" style={{ height: "100%" }}>
            <Spinner large />
            <p>Démarrage du cockpit…</p>
          </div>
        ) : phase === "login" ? (
          <LoginScreen onSuccess={load} />
        ) : phase === "error" || !boot ? (
          <div className="empty" style={{ height: "100%" }}>
            <Icon name="alert" size={32} />
            <h3>Le cockpit ne répond pas</h3>
            <p>{error}</p>
            <Button variant="primary" icon="refresh" onClick={() => void load()}>
              Réessayer
            </Button>
          </div>
        ) : (
          <AppProvider boot={boot} refresh={load}>
            <Shell />
          </AppProvider>
        )}
      </ConfirmProvider>
    </ToastProvider>
  );
}

function LoginScreen({ onSuccess }: { onSuccess: () => Promise<void> }) {
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(() => (window.location.search.includes("auth=failed") ? "Lien de connexion invalide." : ""));

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      await api.login(token);
      window.history.replaceState(null, "", "/");
      await onSuccess();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="empty" style={{ minHeight: "100%" }}>
      <form className="card stack" style={{ width: "min(420px, 100%)", textAlign: "left" }} onSubmit={submit}>
        <div className="row">
          <img src="/favicon.svg" alt="" width={34} height={34} />
          <div>
            <h2>opencode cockpit</h2>
            <p className="small muted">Accès protégé par jeton</p>
          </div>
        </div>
        <p className="secondary small">
          Ouvrez le cockpit avec <code>.\cockpit.ps1 open</code>, ou collez la valeur de <code>COCKPIT_TOKEN</code> du fichier{" "}
          <code>.env</code>.
        </p>
        <input
          className="input mono"
          type="password"
          autoComplete="off"
          placeholder="Jeton d'accès"
          aria-label="Jeton d'accès"
          value={token}
          onChange={(e) => setToken(e.target.value)}
          autoFocus
        />
        {error ? <p className="field-error">{error}</p> : null}
        <Button type="submit" variant="primary" loading={busy} disabled={!token.trim()}>
          Se connecter
        </Button>
      </form>
    </div>
  );
}

function Shell() {
  const route = useRoute();
  const section = route[0] ?? "chat";
  const { boot, patchBoot, refresh, theme, setTheme } = useApp();
  const toast = useToast();
  const streamStatus = useStreamStatus();
  const refreshTimer = useRef<number | undefined>(undefined);

  useEvents((event) => {
    const usage = cockpitEvent(event, "usage.updated");
    if (usage) {
      const data = usage.data as { monthSpentUsd?: number; percent?: number };
      if (typeof data.monthSpentUsd === "number") {
        patchBoot((b) => ({
          ...b,
          usage: { ...b.usage, spentUsd: data.monthSpentUsd as number, percent: data.percent ?? b.usage.percent },
        }));
      }
      return;
    }
    const settings = cockpitEvent(event, "settings.updated");
    if (settings) {
      patchBoot((b) => ({ ...b, settings: settings.data as Settings }));
      return;
    }
    const connection = cockpitEvent(event, "opencode.connection");
    if (connection) {
      const data = connection.data as { connected: boolean; error: string | null };
      patchBoot((b) => ({
        ...b,
        opencode: { ...b.opencode, reachable: data.connected, events: { ...b.opencode.events, connected: data.connected, lastError: data.error } as EventsStatus },
      }));
      return;
    }
    const alert = cockpitEvent(event, "budget.alert");
    if (alert) {
      const a = alert.data as BudgetAlert;
      toast.warning(`Budget : ${a.threshold} % atteint`, `${formatUsd(a.spentUsd)} dépensés sur ${formatUsd(a.budgetUsd)} ce mois-ci.`);
      return;
    }
    if (cockpitEvent(event, "stream.reconnected", "opencode.config.changed")) {
      window.clearTimeout(refreshTimer.current);
      refreshTimer.current = window.setTimeout(() => void refresh(), 800);
    }
  });

  const logout = async () => {
    await api.logout().catch(() => undefined);
    eventBus.disconnect();
    window.location.reload();
  };

  const nextTheme: Record<ThemeChoice, ThemeChoice> = { system: "light", light: "dark", dark: "system" };
  const themeIcon: Record<ThemeChoice, IconName> = { system: "monitor", light: "sun", dark: "moon" };
  const themeLabel: Record<ThemeChoice, string> = { system: "Thème : système", light: "Thème : clair", dark: "Thème : sombre" };

  const percent = boot.usage.percent;

  return (
    <div className="app">
      <nav className="rail" aria-label="Navigation principale">
        <div className="brand">
          <img src="/favicon.svg" alt="" />
          <div className="brand-text">
            opencode cockpit
            <small>{boot.version === "dev" ? "version de développement" : `v${boot.version}`}</small>
          </div>
        </div>
        {NAV.map((item) => (
          <a key={item.id} href={routeHref(item.id)} className={`nav-item${section === item.id ? " active" : ""}`} title={item.label}>
            <Icon name={item.icon} size={18} />
            <span className="label">{item.label}</span>
          </a>
        ))}
        <div className="rail-footer">
          <a className="budget-mini" href={routeHref("couts")} title="Budget du mois">
            <div className="row between">
              <span className="label small secondary">Budget</span>
              <strong className="small">{formatPercent(percent)}</strong>
            </div>
            <Meter percent={percent} label="Budget mensuel consommé" />
            <span className="label tiny muted">
              {formatUsd(boot.usage.spentUsd)} / {formatUsd(boot.usage.budgetUsd)}
            </span>
          </a>
          <div className="row" style={{ justifyContent: "space-between" }}>
            <span className="row small muted" title={boot.opencode.reachable ? `opencode ${boot.opencode.version ?? ""}` : "opencode injoignable"}>
              <span className={`dot ${boot.opencode.reachable && streamStatus === "open" ? "good" : streamStatus === "connecting" ? "warning pulse" : "critical"}`} />
              <span className="hide-narrow">{boot.opencode.reachable ? "opencode" : "hors ligne"}</span>
            </span>
            <span className="row" style={{ gap: 2 }}>
              <IconButton icon={themeIcon[theme]} label={themeLabel[theme]} size="sm" onClick={() => setTheme(nextTheme[theme])} />
              <IconButton icon="logout" label="Se déconnecter" size="sm" onClick={() => void logout()} />
            </span>
          </div>
        </div>
      </nav>

      <main className="main">
        {boot.security.tlsInsecure ? (
          <div className="banner critical" role="alert">
            <Icon name="shield" />
            <span>
              Vérification TLS <strong>désactivée</strong> (COCKPIT_TLS_INSECURE=1) : le trafic sortant peut être intercepté. Préférez les
              certificats d'entreprise (dossier <code>certs/</code>).
            </span>
          </div>
        ) : null}
        {!boot.opencode.reachable ? (
          <div className="banner warning" role="alert">
            <Icon name="alert" />
            <span className="spacer">opencode ne répond pas pour le moment.</span>
            <Button size="sm" onClick={() => navigate("diagnostic")}>
              Diagnostic
            </Button>
          </div>
        ) : !boot.copilotConnected ? (
          <div className="banner info">
            <Icon name="plug" />
            <span className="spacer">GitHub Copilot n'est pas encore connecté.</span>
            <Button size="sm" variant="primary" onClick={() => navigate("parametres", "connexion")}>
              Connecter Copilot
            </Button>
          </div>
        ) : percent >= 90 ? (
          <div className={`banner ${percent >= 100 ? "critical" : "warning"}`}>
            <Icon name="coins" />
            <span className="spacer">
              {formatPercent(percent)} du budget mensuel consommé ({formatUsd(boot.usage.spentUsd)} / {formatUsd(boot.usage.budgetUsd)}).
            </span>
            <Button size="sm" onClick={() => navigate("couts")}>
              Voir les coûts
            </Button>
          </div>
        ) : null}

        {section === "couts" ? (
          <CostsPage />
        ) : section === "archives" ? (
          <ArchivesPage />
        ) : section === "studio" ? (
          <StudioPage />
        ) : section === "parametres" ? (
          <SettingsPage />
        ) : section === "diagnostic" ? (
          <DiagnosticsPage />
        ) : (
          <ChatPage />
        )}
      </main>
    </div>
  );
}
