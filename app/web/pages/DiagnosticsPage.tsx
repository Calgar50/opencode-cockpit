// Diagnostic : état d'opencode, du flux d'événements, du réseau, de Copilot et journal.
import { type ReactNode, useCallback, useEffect, useRef, useState } from "react";
import { localAccessNotice } from "../../server/shared/local-access-notice.ts";
import { useApp } from "../app/AppContext.tsx";
import { Icon } from "../components/Icon.tsx";
import { useToast } from "../components/Toast.tsx";
import { Badge, Button, Card, Spinner, useConfirm } from "../components/ui.tsx";
import { ApiError, api, errorText } from "../lib/api.ts";
import { formatDateTime, formatDuration, formatInt, formatPercent, formatTime, relativeTime } from "../lib/format.ts";
import { routeHref } from "../lib/router.ts";
import type { CopilotCheckResult, CopilotView, SystemStatus } from "../lib/types.ts";
import { LogsViewer } from "./diagnostics/LogsViewer.tsx";
import "./diagnostics/diagnostics.css";

type Tone = "good" | "warning" | "critical" | "neutral";

function formatUptime(seconds: number): string {
  const d = Math.floor(seconds / 86_400);
  const h = Math.floor((seconds % 86_400) / 3_600);
  const m = Math.floor((seconds % 3_600) / 60);
  if (d > 0) return `${d} j ${h} h`;
  if (h > 0) return `${h} h ${m} min`;
  if (m > 0) return `${m} min`;
  return `${seconds} s`;
}

function Line({ tone, label, value, hint, hintTone }: { tone: Tone; label: string; value?: ReactNode; hint?: ReactNode; hintTone?: "critical" }) {
  const toneLabel: Record<Tone, string> = { good: "OK", warning: "Attention", critical: "Problème", neutral: "Information" };
  return (
    <div className="diag-line">
      <span className={`dot${tone === "neutral" ? "" : ` ${tone}`}`} role="img" aria-label={toneLabel[tone]} />
      <div style={{ minWidth: 0 }}>
        <div className="diag-line-head">
          <span className="label">{label}</span>
          {value !== undefined ? <span className="value">{value}</span> : null}
        </div>
        {hint ? <p className={`hint${hintTone ? ` ${hintTone}` : ""}`}>{hint}</p> : null}
      </div>
    </div>
  );
}

const ENDPOINT_SOURCE: Readonly<Record<"env" | "github" | "defaut", string>> = {
  env: "Imposée par COCKPIT_COPILOT_API_URL (.env).",
  github: "Adresse de votre abonnement annoncée par GitHub, utilisée parce que le réseau bloque l'adresse générale.",
  defaut: "Adresse générale, utilisée d'office par opencode.",
};

const SYNC_LABEL: Readonly<Record<CopilotView["configSync"]["state"], string>> = {
  inactif: "rien à imposer",
  "a-jour": "à jour",
  applique: "appliqués",
  "en-attente": "en attente",
  "redemarrage-requis": "redémarrage requis",
  echec: "échec",
};

/** Point à vérifier, avec l'action qui le règle. */
type Problem = { tone: "critical" | "warning"; text: string; action?: "restart-opencode" };

function problemsOf(s: SystemStatus, quotaEnabled: boolean): Problem[] {
  const out: Problem[] = [];
  // Le mode HTTP local n'est jamais un « point à vérifier » : c'est un choix d'installation, rappelé par son bandeau permanent.
  if (s.security.tls !== null && s.security.tls.daysLeft <= 30) {
    out.push({
      tone: "warning",
      text:
        s.security.tls.daysLeft < 0
          ? "Le certificat HTTPS local a expiré : il sera remplacé au prochain démarrage du cockpit."
          : `Le certificat HTTPS local expire dans ${s.security.tls.daysLeft} jour${s.security.tls.daysLeft > 1 ? "s" : ""} : il sera remplacé au prochain démarrage du cockpit.`,
    });
  }
  if (s.opencode.restarting) out.push({ tone: "warning", text: "opencode est en cours de redémarrage." });
  else if (!s.opencode.reachable) out.push({ tone: "critical", text: "opencode ne répond pas." });
  if (!s.events.connected && !s.opencode.restarting) out.push({ tone: "critical", text: "Le flux d'événements d'opencode est coupé : les coûts et archives ne se mettent plus à jour." });
  if (s.security.tlsInsecure) out.push({ tone: "critical", text: "La vérification TLS est désactivée." });
  if (s.security.caFiles === 0 && (s.security.httpProxy || s.security.httpsProxy)) {
    out.push({ tone: "warning", text: "Un proxy est configuré mais aucun certificat d'entreprise n'est chargé." });
  }
  if (!s.copilotConnected) out.push({ tone: "warning", text: "GitHub Copilot n'est pas connecté." });
  else if (s.catalog.models === 0) out.push({ tone: "warning", text: "Le catalogue de modèles est vide." });
  if (s.copilot.error) out.push({ tone: "warning", text: `Liste des IA GitHub Copilot illisible : ${s.copilot.error}` });
  if (s.copilot.configSync.state === "echec") {
    out.push({
      tone: "warning",
      text: `Réglages Copilot d'opencode non appliqués : ${s.copilot.configSync.message ?? "erreur inconnue"}`,
      // Libération des instances ratée : un redémarrage la règle. Jamais proposé pour un PATCH refusé par opencode.
      ...(s.copilot.configSync.details.restartHelps ? { action: "restart-opencode" as const } : {}),
    });
  }
  if (s.copilot.configSync.state === "redemarrage-requis") {
    out.push({
      tone: "warning",
      text: s.copilot.configSync.message ?? "Adresse de l'API Copilot écrite, mais opencode ne l'utilise pas encore : redémarrez opencode.",
      action: "restart-opencode",
    });
  }
  if (quotaEnabled && s.quota.lastError) out.push({ tone: "warning", text: "La synchronisation du solde GitHub échoue." });
  return out;
}

type CopyValue = (value: string, what: string) => void;

/** Valeur longue (empreinte, origine) en chasse fixe, avec son bouton Copier. */
function Copyable({ value, what, onCopy }: { value: string; what: string; onCopy: CopyValue }) {
  return (
    <span className="row" style={{ gap: 6, alignItems: "center", minWidth: 0 }}>
      <span className="mono small" style={{ wordBreak: "break-all" }}>
        {value}
      </span>
      <Button size="sm" icon="copy" aria-label={`Copier : ${what}`} title={`Copier : ${what}`} onClick={() => onCopy(value, what)} />
    </span>
  );
}

/** Mode HTTPS : ce que le navigateur vérifie, et l'empreinte à comparer au premier accès. */
function LocalHttpsLines({ tls, onCopy }: { tls: NonNullable<SystemStatus["security"]["tls"]>; onCopy: CopyValue }) {
  return (
    <>
      <Line
        tone="good"
        label="Mode"
        value="HTTPS local"
        hint="Le navigateur affiche un avertissement au premier accès : le certificat est créé sur ce PC et n'est approuvé nulle part ailleurs. Comparez l'empreinte ci-dessous avant de continuer."
      />
      <Line
        tone="neutral"
        label="Certificat"
        value={tls.source === "genere" ? "créé par le cockpit" : tls.source}
        hint="Recréé automatiquement au démarrage un mois avant son échéance. Sa clé reste dans un volume Docker réservé au cockpit."
      />
      <Line tone="neutral" label="Empreinte SHA-256" hint={<Copyable value={tls.sha256} what="empreinte du certificat" onCopy={onCopy} />} />
      <Line tone="neutral" label="Clé publique (SPKI, base64)" hint={<span className="mono small" style={{ wordBreak: "break-all" }}>{tls.spkiSha256Base64}</span>} />
      <Line
        tone={tls.daysLeft <= 30 ? "warning" : "good"}
        label="Validité"
        value={tls.daysLeft < 0 ? "expiré" : `${formatInt(tls.daysLeft)} jour${tls.daysLeft > 1 ? "s" : ""} restant${tls.daysLeft > 1 ? "s" : ""}`}
        hint={`Du ${formatDateTime(Date.parse(tls.notBefore))} au ${formatDateTime(Date.parse(tls.notAfter))}.`}
      />
      <Line
        tone="neutral"
        label="Adresses couvertes"
        hint={
          <>
            <span className="row wrap" style={{ gap: 4 }}>
              {tls.san.map((h) => (
                <span key={h} className="chip mono">
                  {h}
                </span>
              ))}
            </span>
            {tls.ignoredHosts > 0
              ? ` ${formatInt(tls.ignoredHosts)} hôte${tls.ignoredHosts > 1 ? "s" : ""} de COCKPIT_ALLOWED_HOSTS n'a pas pu être mis dans le certificat : ouvrez le cockpit par 127.0.0.1 ou localhost.`
              : ""}
          </>
        }
      />
      <Line
        tone="neutral"
        label="Dernier renouvellement"
        value={relativeTime(Date.parse(tls.generatedAt))}
        hint={
          tls.previousSha256 ? (
            <>
              Empreinte précédente : <span className="mono">{tls.previousSha256}</span>. Un avertissement du navigateur après un
              renouvellement est normal.
            </>
          ) : (
            "Premier certificat de cette installation."
          )
        }
      />
      <Line
        tone="neutral"
        label="Connexions TLS refusées (24 h)"
        value={formatInt(tls.refusals24h)}
        hint="Indicatif : une adresse http:// ouverte par erreur sur ce port, ou un outil qui n'accepte pas le certificat."
      />
      <Line
        tone="neutral"
        label="Adresse exacte de cette page"
        hint={
          <>
            <Copyable value={window.location.origin} what="adresse du cockpit" onCopy={onCopy} />{" "}
            <span className="small">
              À donner à votre service informatique si Edge ne propose pas de continuer (exception SSLErrorOverrideAllowedForOrigins).
            </span>
          </>
        }
      />
      <Line
        tone="neutral"
        label="Trafic interne"
        value="HTTP sur le réseau Docker"
        hint="Entre le cockpit et opencode, à l'intérieur de Docker : aucun port n'est ouvert pour ce trafic."
      />
    </>
  );
}

/** Mode HTTP explicite : ce qui circule en clair, qui peut le lire, et comment revenir en HTTPS (plan §3.1). */
function LocalHttpLines({ status, onCopy }: { status: SystemStatus; onCopy: CopyValue }) {
  const confirmedAt = status.security.localHttpConfirmedAt;
  const notice = localAccessNotice({
    scheme: status.security.localScheme,
    confirmedAt,
    protocol: window.location.protocol,
  });
  return (
    <>
      <Line
        tone="warning"
        label="Mode"
        value={
          notice?.kind === "http-choisi"
            ? `HTTP local (choix d'installation du ${formatDateTime(Date.parse(notice.confirmedAt))})`
            : "HTTP local (choix d'installation)"
        }
        hint="Choisi à l'installation avec .\install.ps1 -Http, parce que le navigateur de ce poste n'accepte pas le certificat local. Le cockpit n'écoute que sur ce PC, mais sans chiffrer."
      />
      <Line
        tone="neutral"
        label="Ce qui circule en clair sur ce PC"
        hint="Le cookie qui vous garde connecté et tout le contenu des pages : vos conversations, le code affiché, et le code de connexion GitHub quand il s'affiche."
      />
      <Line
        tone="neutral"
        label="Qui peut le lire"
        hint={
          <>
            Les outils de sécurité installés sur ce poste quand ils examinent le trafic ; un programme lancé en administrateur sur ce PC ;
            toute personne qui peut piloter Docker Desktop ici. Cette dernière peut de toute façon lire le jeton dans le conteneur, en
            HTTPS comme en HTTP.
          </>
        }
      />
      <Line
        tone="neutral"
        label="Connexion"
        hint={
          <>
            Ouvrez toujours le cockpit avec <code>.\cockpit.ps1 open</code> : il vérifie le cockpit avant d'ouvrir le lien. Ne saisissez
            jamais le jeton dans une page ; l'écran de connexion ne le demande pas.
          </>
        }
      />
      <Line
        tone="neutral"
        label="Revenir en HTTPS"
        hint={
          <>
            <code>.\install.ps1 -Https</code>, seulement si Edge l'autorise : vérifiez d'abord <code>.\cockpit.ps1 diag</code>. Le jeton
            est alors remplacé et une reconnexion est demandée.
          </>
        }
      />
      <Line
        tone="neutral"
        label="Certificat"
        value="non utilisé"
        hint="Aucun certificat n'est lu ni écrit dans ce mode ; celui qui existe déjà resservira au retour en HTTPS."
      />
      <Line
        tone="neutral"
        label="Trafic interne"
        value="HTTP sur le réseau Docker"
        hint="Entre le cockpit et opencode, à l'intérieur de Docker : aucun port n'est ouvert pour ce trafic."
      />
      <Line tone="neutral" label="Adresse exacte de cette page" hint={<Copyable value={window.location.origin} what="adresse du cockpit" onCopy={onCopy} />} />
    </>
  );
}

export function DiagnosticsPage() {
  const { boot, refresh } = useApp();
  const toast = useToast();
  const confirm = useConfirm();
  const [status, setStatus] = useState<SystemStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadedAt, setLoadedAt] = useState<number | null>(null);
  const [restarting, setRestarting] = useState(false);
  const [restartResult, setRestartResult] = useState<{ ok: boolean; message: string; durationMs: number } | null>(null);
  const [backfilling, setBackfilling] = useState(false);
  const [reloadingModels, setReloadingModels] = useState(false);
  const [checking, setChecking] = useState(false);
  const [check, setCheck] = useState<CopilotCheckResult | null>(null);
  const request = useRef(0);

  const load = useCallback(async () => {
    const id = ++request.current;
    setLoading(true);
    try {
      const data = await api.systemStatus();
      if (id !== request.current) return;
      setStatus(data);
      setError(null);
      setLoadedAt(Date.now());
    } catch (err) {
      if (id === request.current) setError(errorText(err));
    } finally {
      if (id === request.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
    const timer = window.setInterval(() => {
      if (document.visibilityState === "visible") void load();
    }, 10_000);
    return () => window.clearInterval(timer);
  }, [load]);

  const restart = async () => {
    const ok = await confirm({
      title: "Redémarrer opencode ?",
      message: "Les réponses en cours seront interrompues. Le redémarrage prend généralement quelques secondes (2 minutes maximum).",
      confirmLabel: "Redémarrer",
      danger: true,
    });
    if (!ok) return;
    setRestarting(true);
    setRestartResult(null);
    try {
      const result = await api.restartOpencode();
      setRestartResult(result);
      toast.success("opencode a redémarré", `En ${formatDuration(result.durationMs)}.`);
      await refresh().catch(() => undefined);
    } catch (err) {
      const data = err instanceof ApiError && err.data && typeof err.data === "object" ? (err.data as { message?: unknown; durationMs?: unknown }) : null;
      const message = typeof data?.message === "string" ? data.message : errorText(err);
      setRestartResult({ ok: false, message, durationMs: typeof data?.durationMs === "number" ? data.durationMs : 0 });
      toast.error("Redémarrage impossible", message);
    } finally {
      setRestarting(false);
      void load();
    }
  };

  const backfill = async () => {
    setBackfilling(true);
    try {
      await api.backfill();
      toast.success("Historique rattrapé", "Les sessions manquantes ont été relues depuis opencode.");
    } catch (err) {
      toast.error("Rattrapage impossible", err);
    } finally {
      setBackfilling(false);
      void load();
    }
  };

  const reloadModels = async () => {
    setReloadingModels(true);
    try {
      const data = await api.refreshModels();
      toast.success("Catalogue rechargé", `${formatInt(data.models.length)} modèle${data.models.length > 1 ? "s" : ""} disponible${data.models.length > 1 ? "s" : ""}.`);
      await refresh().catch(() => undefined);
    } catch (err) {
      toast.error("Rechargement impossible", err);
    } finally {
      setReloadingModels(false);
      void load();
    }
  };

  const copyValue = (value: string, what: string) => {
    if (!navigator.clipboard) {
      toast.warning("Copie indisponible", "Sélectionnez la valeur puis copiez-la manuellement.");
      return;
    }
    navigator.clipboard.writeText(value).then(
      () => toast.success("Copié", `${what.charAt(0).toUpperCase()}${what.slice(1)} dans le presse-papiers.`),
      () => toast.warning("Copie refusée par le navigateur", "Sélectionnez la valeur puis copiez-la manuellement."),
    );
  };

  const runCopilotCheck = async () => {
    setChecking(true);
    try {
      setCheck(await api.copilotCheck());
      await refresh().catch(() => undefined);
    } catch (err) {
      toast.error("Test de connexion impossible", err);
    } finally {
      setChecking(false);
      void load();
    }
  };

  const s = status;
  const problems = s ? problemsOf(s, boot.settings.quotaSync.enabled) : [];
  const proxy = s ? s.security.httpProxy || s.security.httpsProxy : false;

  return (
    <div className="page">
      <div className="page-narrow">
        <header className="page-header">
          <div className="spacer" style={{ minWidth: 0 }}>
            <h1>Diagnostic</h1>
            <p>État des services du cockpit, actualisé toutes les 10 secondes.</p>
          </div>
          <span className="small muted" aria-live="polite">
            {loadedAt ? `Mis à jour à ${formatTime(loadedAt)}` : ""}
          </span>
          <Button icon="refresh" loading={loading} onClick={() => void load()}>
            Actualiser
          </Button>
        </header>

        {error ? (
          <div className="callout critical" role="alert" style={{ marginBottom: 16 }}>
            <Icon name="alert" size={18} />
            <span className="spacer">
              {error}
              {s ? " Les informations ci-dessous datent de la dernière lecture réussie." : ""}
            </span>
          </div>
        ) : null}

        {!s ? (
          error ? null : (
            <div className="empty">
              <Spinner large />
              <p>Lecture de l'état du système…</p>
            </div>
          )
        ) : (
          <div className="stack loose">
            {problems.length === 0 ? (
              <div className="callout good diag-summary">
                <Icon name="check" size={18} />
                <span>Tout fonctionne : opencode répond, le flux d'événements est actif et GitHub Copilot est connecté.</span>
              </div>
            ) : (
              <div className={`callout ${problems.some((p) => p.tone === "critical") ? "critical" : "warning"} diag-summary`} role="alert">
                <Icon name="alert" size={18} />
                <div>
                  <strong>
                    {problems.length} point{problems.length > 1 ? "s" : ""} à vérifier
                  </strong>
                  <ul>
                    {problems.map((p) => (
                      <li key={p.text}>
                        {p.text}
                        {p.action === "restart-opencode" ? (
                          <div style={{ marginTop: 6 }}>
                            <Button
                              size="sm"
                              variant="danger"
                              icon="refresh"
                              loading={restarting}
                              disabled={!s.opencode.supervisor || s.opencode.restarting}
                              onClick={() => void restart()}
                            >
                              Redémarrer opencode
                            </Button>
                          </div>
                        ) : null}
                      </li>
                    ))}
                  </ul>
                </div>
              </div>
            )}

            <div className="diag-grid">
              <Card title="opencode" subtitle="Serveur de l'agent de code, dans son propre conteneur.">
                <div className="diag-lines">
                  <Line
                    tone={s.opencode.restarting || restarting ? "warning" : s.opencode.reachable ? "good" : "critical"}
                    label="Disponibilité"
                    value={s.opencode.restarting || restarting ? "redémarrage…" : s.opencode.reachable ? "répond" : "injoignable"}
                    hint={
                      !s.opencode.reachable && !s.opencode.restarting
                        ? "Le conteneur est peut-être arrêté ou bloqué par une configuration invalide : consultez le journal ci-dessous."
                        : undefined
                    }
                  />
                  <Line tone="neutral" label="Version" value={s.opencode.version ?? "inconnue"} />
                  <Line tone="neutral" label="Adresse interne" value={<span className="mono small">{s.opencode.url}</span>} />
                  <Line
                    tone={s.opencode.supervisor ? "good" : "warning"}
                    label="Superviseur"
                    value={s.opencode.supervisor ? "présent" : "absent"}
                    hint={
                      s.opencode.supervisor
                        ? "Permet de redémarrer opencode depuis cette page."
                        : "Redémarrage depuis l'interface indisponible : utilisez .\\cockpit.ps1 restart."
                    }
                  />
                </div>
                <div className="diag-actions">
                  <Button
                    variant="danger"
                    icon="refresh"
                    loading={restarting}
                    disabled={!s.opencode.supervisor || s.opencode.restarting}
                    onClick={() => void restart()}
                  >
                    Redémarrer opencode
                  </Button>
                </div>
                {restarting ? (
                  <p className="small muted row" style={{ marginTop: 8 }}>
                    <Spinner /> Redémarrage en cours, jusqu'à 2 minutes…
                  </p>
                ) : restartResult ? (
                  <div className={`callout ${restartResult.ok ? "good" : "critical"}`} style={{ marginTop: 10 }} role="status">
                    <span>
                      {restartResult.message}
                      {restartResult.durationMs > 0 ? ` (${formatDuration(restartResult.durationMs)})` : ""}
                    </span>
                  </div>
                ) : null}
              </Card>

              <Card title="Flux d'événements" subtitle="Alimente en direct le chat, les coûts et les archives.">
                <div className="diag-lines">
                  <Line
                    tone={s.events.connected ? "good" : "critical"}
                    label="Connexion"
                    value={s.events.connected ? "active" : "coupée"}
                    hint={s.events.connected ? undefined : "Le cockpit se reconnecte automatiquement dès qu'opencode répond."}
                  />
                  <Line
                    tone="neutral"
                    label="Dernier événement"
                    value={s.events.lastEventAt > 0 ? <span title={formatDateTime(s.events.lastEventAt)}>{relativeTime(s.events.lastEventAt)}</span> : "aucun"}
                  />
                  {s.events.lastError ? <Line tone="critical" label="Dernière erreur" hint={s.events.lastError} hintTone="critical" /> : null}
                  <Line
                    tone={s.events.backfilling ? "warning" : "neutral"}
                    label="Rattrapage"
                    value={
                      s.events.backfilling ? (
                        <span className="row" style={{ gap: 6 }}>
                          <span className="dot warning pulse" aria-hidden /> en cours
                        </span>
                      ) : (
                        "inactif"
                      )
                    }
                    hint="Relit les sessions d'opencode pour compléter coûts et archives après une coupure."
                  />
                  <Line tone="neutral" label="Navigateurs connectés" value={formatInt(s.browsers)} />
                </div>
                <div className="diag-actions">
                  <Button icon="download" loading={backfilling} disabled={s.events.backfilling || !s.opencode.reachable} onClick={() => void backfill()}>
                    Rattraper l'historique
                  </Button>
                </div>
              </Card>

              <Card title="Accès à l'interface" subtitle="Comment cette page vous parvient, sur ce PC uniquement.">
                <div className="diag-lines">
                  {s.security.localScheme === "http" || s.security.tls === null ? (
                    <LocalHttpLines status={s} onCopy={copyValue} />
                  ) : (
                    <LocalHttpsLines tls={s.security.tls} onCopy={copyValue} />
                  )}
                </div>
              </Card>

              <Card title="Réseau et sécurité" subtitle="Connexions sortantes vers GitHub et le catalogue des modèles.">
                <div className="diag-lines">
                  <Line
                    tone={s.security.tlsInsecure ? "critical" : "good"}
                    label="Vérification TLS"
                    value={s.security.tlsInsecure ? "désactivée" : "active"}
                    hint={
                      s.security.tlsInsecure
                        ? "COCKPIT_TLS_INSECURE=1 : le trafic (jeton Copilot compris) peut être intercepté. Préférez les certificats du dossier certs/."
                        : undefined
                    }
                    hintTone={s.security.tlsInsecure ? "critical" : undefined}
                  />
                  <Line
                    tone={s.security.caFiles === null ? "neutral" : s.security.caFiles > 0 ? "good" : proxy ? "warning" : "neutral"}
                    label="Certificats d'entreprise"
                    value={s.security.caFiles === null ? "inconnu" : `${formatInt(s.security.caFiles)} fichier${s.security.caFiles > 1 ? "s" : ""}`}
                    hint={
                      s.security.caFiles === 0
                        ? proxy
                          ? "Proxy configuré sans certificat : les connexions HTTPS risquent d'échouer (SELF_SIGNED_CERT_IN_CHAIN)."
                          : "Inutile sans proxy d'entreprise."
                        : undefined
                    }
                  />
                  <Line tone="neutral" label="Proxy HTTP" value={s.security.httpProxy ? "configuré" : "aucun"} />
                  <Line tone="neutral" label="Proxy HTTPS" value={s.security.httpsProxy ? "configuré" : "aucun"} />
                  <Line tone="neutral" label="Exceptions (NO_PROXY)" value={s.security.noProxy ? <span className="mono small">{s.security.noProxy}</span> : "aucune"} />
                  <Line
                    tone="neutral"
                    label="Hôtes autorisés"
                    hint={
                      <span className="row wrap" style={{ gap: 4 }}>
                        {s.security.allowedHosts.map((h) => (
                          <span key={h} className="chip mono">
                            {h}
                          </span>
                        ))}
                      </span>
                    }
                  />
                </div>
              </Card>

              <Card title="GitHub Copilot et modèles">
                <div className="diag-lines">
                  <Line
                    tone={s.copilotConnected ? "good" : "warning"}
                    label="GitHub Copilot"
                    value={s.copilotConnected ? "connecté" : "non connecté"}
                    hint={s.copilotConnected ? undefined : <a href={routeHref("parametres", "connexion")}>Connecter GitHub Copilot</a>}
                  />
                  <Line
                    tone={s.copilot.endpoint ? "neutral" : "warning"}
                    label="Adresse de l'API Copilot"
                    value={s.copilot.endpoint ? <span className="mono small">{s.copilot.endpoint.url}</span> : "inconnue"}
                    hint={
                      s.copilot.endpoint ? (
                        <>
                          {ENDPOINT_SOURCE[s.copilot.endpoint.source]}
                          {s.copilot.endpoint.plan ? ` Abonnement : ${s.copilot.endpoint.plan}.` : ""}
                          {s.copilot.discoveryError ? ` ${s.copilot.discoveryError}` : ""}
                        </>
                      ) : s.copilot.lastTried ? (
                        `Dernière adresse essayée, en échec : ${s.copilot.lastTried.url}.${s.copilot.discoveryError ? ` ${s.copilot.discoveryError}` : ""}`
                      ) : (
                        "Connue après la connexion de GitHub Copilot."
                      )
                    }
                  />
                  <Line
                    tone={s.copilot.verified ? "good" : s.copilotConnected ? "warning" : "neutral"}
                    label="Liste des IA de votre compte"
                    value={s.copilot.verified ? "vérifiée auprès de GitHub" : "non vérifiée"}
                    hint={s.copilot.error ?? (s.copilot.opencodeError ? `opencode : ${s.copilot.opencodeError}` : undefined)}
                    hintTone={s.copilot.error ? "critical" : undefined}
                  />
                  {s.copilot.unavailable.length > 0 ? (
                    <Line
                      tone="neutral"
                      label="IA non disponibles sur votre compte"
                      value={formatInt(s.copilot.unavailable.length)}
                      hint={s.copilot.unavailable.map((m) => `${m.name} : ${m.reason}`).join(" ")}
                    />
                  ) : null}
                  <Line
                    tone={
                      s.copilot.configSync.state === "echec" || s.copilot.configSync.state === "redemarrage-requis"
                        ? "critical"
                        : s.copilot.configSync.state === "en-attente"
                          ? "warning"
                          : "neutral"
                    }
                    label="Adresse imposée à opencode"
                    value={SYNC_LABEL[s.copilot.configSync.state]}
                    hint={s.copilot.configSync.message ?? "Adresse de l'API Copilot écrite dans la configuration d'opencode quand elle diffère de son adresse d'office."}
                  />
                  {s.copilot.configSync.details.checked.length > 0 ? (
                    <Line
                      tone="neutral"
                      label="Adresse utilisée par opencode"
                      value={`${formatInt(s.copilot.configSync.details.checked.length)} dossier${s.copilot.configSync.details.checked.length > 1 ? "s" : ""} vérifié${s.copilot.configSync.details.checked.length > 1 ? "s" : ""}`}
                      hint={
                        <>
                          {s.copilot.configSync.details.checked.map((c, i) => (
                            <span key={c.directory ?? "(instance par défaut)"}>
                              {i > 0 ? " · " : ""}
                              {c.directory ?? "instance par défaut"} : <span className="mono">{c.baseURL || "adresse d'office"}</span>
                            </span>
                          ))}
                          {s.copilot.configSync.details.disposeOk === true && s.copilot.configSync.details.disposeMs !== undefined
                            ? ` · instances libérées en ${formatDuration(s.copilot.configSync.details.disposeMs)}`
                            : ""}
                        </>
                      }
                    />
                  ) : null}
                  <Line
                    tone={s.catalog.models > 0 ? "good" : "warning"}
                    label="Catalogue"
                    value={`${formatInt(s.catalog.models)} modèle${s.catalog.models > 1 ? "s" : ""}`}
                    hint={
                      <>
                        {s.catalog.providers.length > 0 ? `Fournisseurs : ${s.catalog.providers.join(", ")}. ` : "Aucun fournisseur. "}
                        {s.catalog.loadedAt > 0 ? `Chargé ${relativeTime(s.catalog.loadedAt)}.` : "Jamais chargé."}
                      </>
                    }
                  />
                  <Line
                    tone={s.quota.lastError ? "warning" : "neutral"}
                    label="Solde GitHub"
                    value={
                      s.quota.latest
                        ? s.quota.latest.unlimited
                          ? "illimité"
                          : s.quota.latest.percentRemaining !== null
                            ? `${formatPercent(s.quota.latest.percentRemaining)} restant`
                            : "relevé"
                        : "aucun relevé"
                    }
                    hint={
                      s.quota.lastError ? (
                        `Dernière erreur : ${s.quota.lastError}`
                      ) : s.quota.latest ? (
                        `Relevé ${relativeTime(s.quota.latest.takenAt)}.`
                      ) : (
                        <a href={routeHref("parametres", "budget")}>Synchronisation optionnelle (Paramètres › Budget)</a>
                      )
                    }
                  />
                </div>
                <div className="diag-actions">
                  <Button icon="plug" loading={checking} onClick={() => void runCopilotCheck()}>
                    Tester la connexion Copilot
                  </Button>
                  <Button icon="refresh" loading={reloadingModels} onClick={() => void reloadModels()}>
                    Recharger le catalogue
                  </Button>
                </div>
                {check ? (
                  <div className="diag-lines" style={{ marginTop: 10 }} role="status">
                    {check.hosts.map((h) => (
                      <Line key={h.host} tone={h.reachable ? "good" : "critical"} label={h.host} hint={h.detail} hintTone={h.reachable ? undefined : "critical"} />
                    ))}
                    {check.catalogError ? <Line tone="critical" label="Liste des IA" hint={check.catalogError} hintTone="critical" /> : null}
                  </div>
                ) : null}
              </Card>

              <Card title="Base de données">
                <div className="grid-2" style={{ gap: 10 }}>
                  <div className="stat-tile">
                    <span className="label">Sessions</span>
                    <span className="value tabular">{formatInt(s.database.sessions)}</span>
                  </div>
                  <div className="stat-tile">
                    <span className="label">Conversations archivées</span>
                    <span className="value tabular">{formatInt(s.database.conversations)}</span>
                  </div>
                  <div className="stat-tile">
                    <span className="label">Appels de modèles</span>
                    <span className="value tabular">{formatInt(s.database.usage)}</span>
                  </div>
                  <div className="stat-tile">
                    <span className="label">Messages envoyés</span>
                    <span className="value tabular">{formatInt(s.database.prompts)}</span>
                  </div>
                </div>
              </Card>

              <Card title="Système">
                <dl className="diag-kv">
                  <dt>Cockpit</dt>
                  <dd>
                    <Badge tone="accent">v{s.version}</Badge>
                  </dd>
                  <dt>Node.js</dt>
                  <dd className="mono small">{s.node}</dd>
                  <dt>Démarré depuis</dt>
                  <dd>{formatUptime(s.uptimeSeconds)}</dd>
                  <dt>Projets</dt>
                  <dd className="mono small">{s.paths.workspace}</dd>
                  <dt>Archives</dt>
                  <dd className="mono small">{s.paths.archives}</dd>
                </dl>
              </Card>
            </div>
          </div>
        )}

        <div style={{ marginTop: 20 }}>
          <LogsViewer proxyConfigured={proxy || boot.security.proxy} />
        </div>
      </div>
    </div>
  );
}
