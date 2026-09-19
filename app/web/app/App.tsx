// Coquille de l'application : amorçage, connexion, navigation, bandeaux d'alerte, règles d'utilisation.
import { type FormEvent, useEffect, useRef, useState } from "react";
import { isDefaultProviders, MESSAGES } from "../../server/shared/assistant-rules.ts";
import type { BootView } from "../../server/shared/boot-recovery.ts";
import { authErrorText, certificateRenewalDue, localAccessNotice, loginMode } from "../../server/shared/local-access-notice.ts";
import { Icon, type IconName } from "../components/Icon.tsx";
import { ToastProvider, useToast } from "../components/Toast.tsx";
import { Button, ConfirmProvider, EmptyState, IconButton, Meter, Spinner } from "../components/ui.tsx";
import { api, errorText } from "../lib/api.ts";
import { cockpitEvent, eventBus, useEvents, useStreamStatus } from "../lib/events.ts";
import { formatPercent, formatUsd } from "../lib/format.ts";
import { navigate, routeHref, useRoute } from "../lib/router.ts";
import type { BudgetAlert, Bootstrap, EventsStatus, Settings } from "../lib/types.ts";
import { ArchivesPage } from "../pages/ArchivesPage.tsx";
import { AssistantsPage } from "../pages/AssistantsPage.tsx";
import { ChatPage } from "../pages/ChatPage.tsx";
import { CostsPage } from "../pages/CostsPage.tsx";
import { DiagnosticsPage } from "../pages/DiagnosticsPage.tsx";
import { SettingsPage } from "../pages/SettingsPage.tsx";
import { StudioPage } from "../pages/StudioPage.tsx";
import { AppProvider, type ThemeChoice, useApp } from "./AppContext.tsx";
import { BootErrorScreen, RecoveryBanner } from "./BootRecovery.tsx";
import { FirstRunRules, needsRules, UPGRADE_NOTICE_VERSION, UpgradeNotice } from "./FirstRunRules.tsx";
import { LocalHttpBanner } from "./LocalHttpNotice.tsx";
import { useBootRecovery } from "./useBootRecovery.ts";

const NAV: Array<{ id: string; label: string; icon: IconName; advancedOnly?: boolean }> = [
  { id: "chat", label: "Chat", icon: "chat" },
  { id: "assistants", label: "Assistants", icon: "sparkle" },
  { id: "couts", label: "Coûts", icon: "coins" },
  { id: "archives", label: "Archives", icon: "archive" },
  { id: "studio", label: "Studio (avancé)", icon: "bot", advancedOnly: true },
  { id: "parametres", label: "Paramètres", icon: "settings" },
  { id: "diagnostic", label: "Diagnostic", icon: "pulse" },
];

export function App() {
  // Amorçage et reprise automatique après un échec (1.1, décision U4) : une interface déjà chargée n'est plus remplacée par
  // l'écran « Le cockpit ne répond pas » ; un bandeau signale la reprise, qui se fait seule (web/app/useBootRecovery.ts).
  const { view, load } = useBootRecovery();
  const boot = view.data;
  const retry = () => void load();

  return (
    <ToastProvider>
      <ConfirmProvider>
        {view.phase === "loading" ? (
          <div className="empty" style={{ height: "100%" }}>
            <Spinner large />
            <p>Démarrage du cockpit…</p>
          </div>
        ) : view.phase === "login" ? (
          <LoginScreen onSuccess={load} />
        ) : view.phase === "error" || !boot ? (
          <BootErrorScreen view={view} onRetry={retry} />
        ) : (
          <AppProvider boot={boot} refresh={load}>
            <Shell recovery={view} onRetry={retry} />
          </AppProvider>
        )}
      </ConfirmProvider>
    </ToastProvider>
  );
}

function LoginScreen({ onSuccess }: { onSuccess: () => Promise<void> }) {
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(() => authErrorText(window.location.search));
  // La page est servie en clair : le jeton y circulerait en clair, et le serveur refuse POST /api/login (403 login-disabled).
  const mode = loginMode(window.location.protocol);

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

  const retry = async () => {
    setBusy(true);
    setError("");
    try {
      window.history.replaceState(null, "", "/");
      await onSuccess();
    } finally {
      setBusy(false);
    }
  };

  const header = (
    <div className="row">
      <img src="/favicon.svg" alt="" width={34} height={34} />
      <div>
        <h2>opencode cockpit</h2>
        <p className="small muted">{mode === "jeton" ? "Accès protégé par jeton" : "Accès par .\\cockpit.ps1 open"}</p>
      </div>
    </div>
  );

  if (mode === "open-seulement") {
    return (
      <div className="empty" style={{ minHeight: "100%" }}>
        <div className="card stack" style={{ width: "min(460px, 100%)", textAlign: "left", padding: 0, overflow: "hidden" }}>
          <LocalHttpBanner notice={{ kind: "page-http" }} />
          <div className="stack" style={{ padding: 18 }}>
            {header}
            <p className="secondary small">
              Pour vous connecter, lancez <code>.\cockpit.ps1 open</code> : il vérifie le cockpit avant d'ouvrir le lien. Ne saisissez
              jamais le jeton dans une page.
            </p>
            {error ? <p className="field-error">{error}</p> : null}
            <Button variant="primary" icon="refresh" loading={busy} onClick={() => void retry()}>
              Réessayer
            </Button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="empty" style={{ minHeight: "100%" }}>
      <form className="card stack" style={{ width: "min(420px, 100%)", textAlign: "left" }} onSubmit={submit}>
        {header}
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

/** Page réservée au mode Avancé (le serveur refuse de toute façon les écritures en mode Simple). */
function AdvancedOnlyPage({ title }: { title: string }) {
  return (
    <div className="page">
      <EmptyState
        icon="lock"
        title={title}
        action={
          <Button variant="primary" icon="settings" onClick={() => navigate("parametres", "affichage")}>
            Paramètres › Affichage
          </Button>
        }
      >
        {MESSAGES.modeAvance}
      </EmptyState>
    </div>
  );
}

function Shell({ recovery, onRetry }: { recovery: BootView<Bootstrap>; onRetry: () => void }) {
  const route = useRoute();
  const section = route[0] ?? "chat";
  const { boot, patchBoot, refresh, theme, setTheme, ui, advanced, applySettings } = useApp();
  const toast = useToast();
  const streamStatus = useStreamStatus();
  const refreshTimer = useRef<number | undefined>(undefined);

  useEffect(() => () => window.clearTimeout(refreshTimer.current), []);

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
      applySettings(settings.data as Settings);
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
    // Niveaux d'IA résolus, catalogue et configuration : l'amorçage est recalculé par le serveur.
    if (cockpitEvent(event, "stream.reconnected", "opencode.config.changed", "ai.changed")) {
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
  const rulesOpen = needsRules(ui.rulesAcceptedVersion, boot.rulesVersion);
  const providers = boot.allowedProviders ?? [];
  const testProviders = providers.length > 0 && !isDefaultProviders(providers);
  const providerIssues = boot.security.providerIssues ?? [];
  const nav = NAV.filter((item) => advanced || !item.advancedOnly);
  // Mode HTTP local : bandeau visible dans les modes Simple et Avancé, jamais masquable (I6).
  const accessNotice = localAccessNotice({
    scheme: boot.security.localScheme,
    confirmedAt: boot.security.localHttpConfirmedAt,
    protocol: window.location.protocol,
  });
  const tls = boot.security.tls;
  const certDaysLeft = tls === null ? null : tls.daysLeft;
  // Flux perdu (5 erreurs sans « hello ») : même ton qu'un flux coupé, avec sa propre bannière et son bouton Recharger.
  const streamTone =
    streamStatus === "lost" ? "critical" : boot.opencode.reachable && streamStatus === "open" ? "good" : streamStatus === "connecting" ? "warning pulse" : "critical";
  const streamTitle =
    streamStatus === "lost"
      ? "Connexion au cockpit perdue : rechargez la page"
      : boot.opencode.reachable
        ? `opencode ${boot.opencode.version ?? ""}`
        : "opencode injoignable";

  return (
    <>
      <div className="app" inert={rulesOpen}>
        <nav className="rail" aria-label="Navigation principale">
          <div className="brand">
            <img src="/favicon.svg" alt="" />
            <div className="brand-text">
              opencode cockpit
              <small>{boot.version === "dev" ? "version de développement" : `v${boot.version}`}</small>
            </div>
          </div>
          {nav.map((item) => (
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
              <span className="row small muted" title={streamTitle}>
                <span className={`dot ${streamTone}`} />
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
          {testProviders ? (
            <div className="banner critical" role="alert">
              <Icon name="alert" />
              <span>
                <strong>{MESSAGES.testProviderBanner}</strong>
                {" "}
                <span className="small">Fournisseurs autorisés : {providers.join(", ")}.</span>
              </span>
            </div>
          ) : null}
          {providerIssues.length > 0 ? (
            <div className="banner critical" role="alert">
              <Icon name="alert" />
              <span className="spacer">
                <strong>{MESSAGES.providerLockBanner}</strong>{" "}
                <span className="small">{providerIssues.map((i) => `${i.path} : ${i.message}`).join(" · ")}</span>
              </span>
              <Button size="sm" onClick={() => navigate("parametres", "securite")}>
                Sécurité
              </Button>
            </div>
          ) : null}
          {boot.security.tlsInsecure ? (
            <div className="banner critical" role="alert">
              <Icon name="shield" />
              <span>
                Vérification TLS <strong>désactivée</strong> (COCKPIT_TLS_INSECURE=1) : le trafic sortant peut être intercepté. Préférez les
                certificats d'entreprise (dossier <code>certs/</code>).
              </span>
            </div>
          ) : null}
          {streamStatus === "lost" ? (
            <div className="banner critical" role="alert">
              <Icon name="alert" />
              <span className="spacer">
                Connexion au cockpit perdue. Rechargez la page. Si un avertissement de certificat s'affiche, comparez l'empreinte donnée
                par <code>.\cockpit.ps1 tls</code>.
              </span>
              <Button size="sm" variant="primary" icon="refresh" onClick={() => window.location.reload()}>
                Recharger
              </Button>
            </div>
          ) : null}
          <RecoveryBanner view={recovery} masque={streamStatus === "lost"} onRetry={onRetry} />
          {accessNotice ? <LocalHttpBanner notice={accessNotice} onDetails={() => navigate("diagnostic")} /> : null}
          {certDaysLeft !== null && certificateRenewalDue(certDaysLeft) ? (
            <div className="banner warning" role="status">
              <Icon name="shield" />
              <span className="spacer">
                {certDaysLeft < 0
                  ? "Le certificat HTTPS local a expiré."
                  : `Le certificat HTTPS local expire dans ${certDaysLeft} jour${certDaysLeft > 1 ? "s" : ""}.`}{" "}
                Il sera remplacé au prochain démarrage du cockpit : le navigateur redemandera de continuer, avec une nouvelle empreinte à
                comparer.
              </span>
              <Button size="sm" onClick={() => navigate("diagnostic")}>
                Diagnostic
              </Button>
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
          {!rulesOpen && ui.noticeSeen !== UPGRADE_NOTICE_VERSION ? <UpgradeNotice /> : null}

          {section === "couts" ? (
            <CostsPage />
          ) : section === "archives" ? (
            <ArchivesPage />
          ) : section === "assistants" ? (
            <AssistantsPage />
          ) : section === "studio" ? (
            advanced ? (
              <StudioPage />
            ) : (
              <AdvancedOnlyPage title="Studio (avancé)" />
            )
          ) : section === "parametres" ? (
            <SettingsPage />
          ) : section === "diagnostic" ? (
            <DiagnosticsPage />
          ) : (
            <ChatPage />
          )}
        </main>
      </div>
      {/* La coquille est inerte tant que les règles ne sont pas acceptées : le bandeau du mode HTTP est repris dans la fenêtre. */}
      {rulesOpen ? <FirstRunRules accessNotice={accessNotice} /> : null}
    </>
  );
}
