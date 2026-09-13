// Journal d'opencode : lecture, rafraîchissement automatique, copie et détection de problèmes connus.
import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Icon } from "../../components/Icon.tsx";
import { useToast } from "../../components/Toast.tsx";
import { Button, Card, Spinner, Toggle } from "../../components/ui.tsx";
import { api, errorText } from "../../lib/api.ts";
import { formatTime } from "../../lib/format.ts";
import { routeHref } from "../../lib/router.ts";
import { detectLogProblems, type LogProblem, type LogProblemId } from "./logHints.ts";

const LINE_CHOICES = [200, 500, 2000] as const;

function hintContent(id: LogProblemId, proxyConfigured: boolean): { title: string; tone: "critical" | "warning"; body: ReactNode } {
  switch (id) {
    case "tls":
      return {
        title: "Certificat d'entreprise non reconnu",
        tone: "critical",
        body: (
          <>
            <span>
              Un proxy d'entreprise inspecte le trafic HTTPS et le re-signe avec sa propre autorité racine, inconnue des conteneurs.
            </span>
            <ul>
              <li>
                Exportez les autorités de confiance de Windows avec <code>.\cockpit.ps1 certs</code>, ou déposez le certificat racine
                (format PEM, <code>.pem</code> ou <code>.crt</code>) dans le dossier <code>certs/</code>.
              </li>
              <li>
                Redémarrez ensuite avec <code>.\cockpit.ps1 restart</code> : la vérification TLS reste active.
              </li>
              <li>
                En dernier recours seulement : <code>COCKPIT_TLS_INSECURE=1</code> dans <code>.env</code> (déconseillé, le trafic peut alors être
                intercepté).
              </li>
            </ul>
          </>
        ),
      };
    case "network":
      return {
        title: "Accès réseau impossible",
        tone: "warning",
        body: (
          <>
            <span>
              opencode n'arrive pas à joindre un service externe (GitHub, catalogue des modèles).{" "}
              {proxyConfigured ? "Un proxy est configuré : vérifiez son adresse et ses exceptions." : "Aucun proxy n'est configuré."}
            </span>
            <ul>
              <li>
                Derrière un proxy d'entreprise, lancez <code>.\install.ps1 -Proxy http://proxy:port</code> (et <code>-NoProxy</code> pour les
                exceptions) : le choix est mémorisé et les conteneurs sont recréés.
              </li>
              <li>
                Ou renseignez <code>HTTPS_PROXY</code> (et <code>HTTP_PROXY</code>, <code>NO_PROXY</code>) dans <code>.env</code>, puis redémarrez avec{" "}
                <code>.\cockpit.ps1 restart</code>.
              </li>
            </ul>
          </>
        ),
      };
    case "auth":
      return {
        title: "Authentification GitHub Copilot refusée",
        tone: "warning",
        body: (
          <>
            <span>Le jeton Copilot a expiré, a été révoqué ou l'abonnement n'est plus actif.</span>
            <span>
              <a href={routeHref("parametres", "connexion")}>Reconnecter GitHub Copilot</a>
            </span>
          </>
        ),
      };
    case "config":
      return {
        title: "Configuration opencode invalide",
        tone: "critical",
        body: (
          <>
            <span>
              Un fichier de configuration (opencode.jsonc, agent, commande ou skill) est refusé par opencode, qui peut rester bloqué tant qu'il
              n'est pas corrigé.
            </span>
            <ul>
              <li>
                Corrigez-le dans le <a href={routeHref("studio")}>Studio</a> ou dans{" "}
                <a href={routeHref("parametres", "opencode")}>Paramètres › opencode › Fichier brut</a>.
              </li>
              <li>Puis redémarrez opencode avec le bouton ci-dessus.</li>
            </ul>
          </>
        ),
      };
  }
}

function ProblemCallout({ problem, proxyConfigured }: { problem: LogProblem; proxyConfigured: boolean }) {
  const hint = hintContent(problem.id, proxyConfigured);
  return (
    <div className={`callout ${hint.tone}`} role="alert">
      <Icon name="alert" size={18} />
      <div className="stack tight" style={{ minWidth: 0 }}>
        <strong>
          {hint.title}{" "}
          <span className="small muted" style={{ fontWeight: 400 }}>
            ({problem.count} ligne{problem.count > 1 ? "s" : ""})
          </span>
        </strong>
        {hint.body}
        <span className="log-excerpt">{problem.lastLine}</span>
      </div>
    </div>
  );
}

export function LogsViewer({ proxyConfigured }: { proxyConfigured: boolean }) {
  const toast = useToast();
  const [lines, setLines] = useState<number>(500);
  const [auto, setAuto] = useState(false);
  const [content, setContent] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [loadedAt, setLoadedAt] = useState<number | null>(null);
  const terminal = useRef<HTMLPreElement>(null);
  const stickToBottom = useRef(true);
  const request = useRef(0);

  const load = useCallback(async (count: number) => {
    const id = ++request.current;
    const el = terminal.current;
    stickToBottom.current = !el || el.scrollHeight - el.scrollTop - el.clientHeight < 40;
    try {
      const data = await api.logs(count);
      if (id !== request.current) return;
      setContent(data.content);
      setError(null);
      setLoadedAt(Date.now());
    } catch (err) {
      if (id === request.current) setError(errorText(err));
    } finally {
      if (id === request.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    setLoading(true);
    void load(lines);
  }, [lines, load]);

  useEffect(() => {
    if (!auto) return;
    const timer = window.setInterval(() => {
      if (document.visibilityState === "visible") void load(lines);
    }, 5_000);
    return () => window.clearInterval(timer);
  }, [auto, lines, load]);

  useEffect(() => {
    const el = terminal.current;
    if (el && stickToBottom.current) el.scrollTop = el.scrollHeight;
  }, [content]);

  const problems = useMemo(() => detectLogProblems(content), [content]);

  const copy = () => {
    if (!navigator.clipboard) {
      toast.warning("Copie indisponible", "Sélectionnez le texte du journal puis copiez-le manuellement.");
      return;
    }
    navigator.clipboard.writeText(content).then(
      () => toast.success("Journal copié", "Les secrets connus sont masqués par le cockpit, relisez quand même avant de partager."),
      () => toast.warning("Copie refusée par le navigateur"),
    );
  };

  return (
    <Card title="Journal d'opencode" subtitle={loadedAt ? `Mis à jour à ${formatTime(loadedAt)}` : "Dernières lignes écrites par opencode."}>
      <div className="logs-toolbar">
        <label htmlFor="logs-lines" className="small secondary">
          Lignes
        </label>
        <select id="logs-lines" className="select sm" value={lines} onChange={(e) => setLines(Number(e.target.value))}>
          {LINE_CHOICES.map((n) => (
            <option key={n} value={n}>
              {n}
            </option>
          ))}
        </select>
        <span className="row small secondary">
          <Toggle checked={auto} onChange={setAuto} label="Actualisation automatique toutes les 5 secondes" />
          Auto (5 s)
        </span>
        <span className="spacer" />
        <Button size="sm" icon="refresh" loading={loading} onClick={() => void load(lines)}>
          Actualiser
        </Button>
        <Button size="sm" icon="copy" onClick={copy} disabled={!content}>
          Copier
        </Button>
      </div>

      <div className="stack">
        {problems.map((p) => (
          <ProblemCallout key={p.id} problem={p} proxyConfigured={proxyConfigured} />
        ))}
        {error ? (
          <div className="callout critical" role="alert">
            <Icon name="alert" size={18} />
            <span>{error}</span>
          </div>
        ) : null}
        {loading && !content ? (
          <div className="empty">
            <Spinner large />
          </div>
        ) : (
          <pre ref={terminal} className="terminal logs" tabIndex={0} aria-label="Journal d'opencode">
            {content || "Journal vide ou introuvable : le superviseur d'opencode n'a encore rien écrit."}
          </pre>
        )}
      </div>
    </Card>
  );
}
