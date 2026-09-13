// Connexion GitHub Copilot : flux d'appareil OAuth relayé par opencode.
import { useEffect, useId, useRef, useState } from "react";
import { useApp } from "../../app/AppContext.tsx";
import { Icon } from "../../components/Icon.tsx";
import { useToast } from "../../components/Toast.tsx";
import { Button, Card, Field, Spinner, useAsync, useConfirm } from "../../components/ui.tsx";
import { api, errorText, oc } from "../../lib/api.ts";
import type { ProviderAuthPrompt } from "../../lib/types.ts";
import { isHttpsUrl } from "../studio/widgets.tsx";

const PROVIDER = "github-copilot";

type Flow =
  | { step: "idle" }
  | { step: "authorizing" }
  | { step: "waiting"; url: string; code: string | null; instructions: string; manual: boolean }
  | { step: "finishing" }
  | { step: "error"; message: string };

export function ConnectionTab() {
  const { boot, refresh } = useApp();
  const toast = useToast();
  const confirm = useConfirm();
  const methods = useAsync(() => oc.providerAuth(), []);
  const method = methods.data?.[PROVIDER]?.[0];
  const prompts: ProviderAuthPrompt[] = method?.prompts ?? [];
  const [inputs, setInputs] = useState<Record<string, string>>({});
  const [flow, setFlow] = useState<Flow>({ step: "idle" });
  const [manualCode, setManualCode] = useState("");
  const [loggingOut, setLoggingOut] = useState(false);
  const [formOpen, setFormOpen] = useState(false);
  const generation = useRef(0);
  const manualId = useId();
  const promptIdPrefix = useId();

  useEffect(
    () => () => {
      generation.current++;
    },
    [],
  );

  const valueOf = (key: string): string => {
    const prompt = prompts.find((p) => p.key === key);
    return inputs[key] ?? (prompt?.type === "select" ? (prompt.options?.[0]?.value ?? "") : "");
  };
  const visible = (p: ProviderAuthPrompt) => {
    if (!p.when) return true;
    const current = valueOf(p.when.key);
    return p.when.op === "eq" ? current === p.when.value : current !== p.when.value;
  };
  const visiblePrompts = prompts.filter(visible);
  const missing = visiblePrompts.some((p) => p.type === "text" && !valueOf(p.key).trim());

  const copilotModels = boot.models.filter((m) => m.providerID === PROVIDER).length;
  const connected = boot.copilotConnected;
  const busy = flow.step === "authorizing" || flow.step === "waiting" || flow.step === "finishing";

  const finish = async (gen: number, ok: boolean) => {
    if (gen !== generation.current) return;
    if (!ok) throw new Error("GitHub n'a pas confirmé l'autorisation : le code a peut-être expiré ou été refusé.");
    setFlow({ step: "finishing" });
    try {
      await api.refreshModels();
    } catch (err) {
      toast.warning("Catalogue des modèles non rechargé", errorText(err));
    }
    await refresh();
    if (gen !== generation.current) return;
    setFormOpen(false);
    toast.success("GitHub Copilot connecté", "Les modèles Copilot sont disponibles dans le chat.");
    setFlow({ step: "idle" });
  };

  const connect = async () => {
    const gen = ++generation.current;
    setFlow({ step: "authorizing" });
    setManualCode("");
    const payload = Object.fromEntries(visiblePrompts.map((p) => [p.key, valueOf(p.key).trim()]));
    try {
      const auth = await oc.oauthAuthorize(PROVIDER, 0, payload);
      if (gen !== generation.current) return;
      const instructions = typeof auth.instructions === "string" ? auth.instructions : "";
      const code = /[A-Z0-9]{4}-[A-Z0-9]{4}/.exec(instructions)?.[0] ?? null;
      const manual = auth.method === "code";
      setFlow({ step: "waiting", url: auth.url, code, instructions, manual });
      if (!manual) await finish(gen, await oc.oauthCallback(PROVIDER, 0));
    } catch (err) {
      if (gen === generation.current) setFlow({ step: "error", message: errorText(err) });
    }
  };

  const submitManual = async () => {
    const gen = generation.current;
    try {
      await finish(gen, await oc.oauthCallback(PROVIDER, 0, manualCode.trim()));
    } catch (err) {
      if (gen === generation.current) setFlow({ step: "error", message: errorText(err) });
    }
  };

  const cancel = () => {
    generation.current++;
    setFlow({ step: "idle" });
  };

  const logout = async () => {
    const ok = await confirm({
      title: "Déconnecter GitHub Copilot ?",
      message: "Le jeton est supprimé du conteneur opencode. Les conversations restent archivées, mais plus aucun modèle Copilot ne sera disponible.",
      confirmLabel: "Déconnecter",
      danger: true,
    });
    if (!ok) return;
    setLoggingOut(true);
    try {
      await oc.logoutProvider(PROVIDER);
      await api.refreshModels().catch(() => undefined);
      await refresh();
      toast.success("GitHub Copilot déconnecté");
    } catch (err) {
      toast.error("Déconnexion impossible", err);
    } finally {
      setLoggingOut(false);
    }
  };

  const copyCode = (code: string) => {
    if (!navigator.clipboard) {
      toast.warning("Copie indisponible", "Sélectionnez le code puis copiez-le manuellement.");
      return;
    }
    navigator.clipboard.writeText(code).then(
      () => toast.success("Code copié", "Collez-le sur la page GitHub."),
      () => toast.warning("Copie refusée par le navigateur", "Sélectionnez le code puis copiez-le manuellement."),
    );
  };

  return (
    <div className="stack loose">
      <Card title="GitHub Copilot" subtitle="Fournisseur des modèles utilisés par opencode.">
        <div className="stack">
          <div className="connect-status">
            <span className={`dot ${connected ? "good" : "warning"}`} aria-hidden />
            <div className="stack tight spacer" style={{ gap: 0 }}>
              <strong>{connected ? "Connecté" : "Non connecté"}</strong>
              <span className="small muted">
                {connected
                  ? `${copilotModels} modèle${copilotModels > 1 ? "s" : ""} Copilot dans le catalogue.`
                  : "Connectez votre compte GitHub disposant d'un abonnement Copilot."}
              </span>
            </div>
            {connected && flow.step === "idle" ? (
              <>
                <Button icon="refresh" onClick={() => setFormOpen(true)} disabled={methods.loading || !method || formOpen}>
                  Reconnecter
                </Button>
                <Button variant="danger" icon="logout" loading={loggingOut} onClick={() => void logout()}>
                  Déconnecter
                </Button>
              </>
            ) : null}
          </div>

          {methods.loading ? (
            <div className="row small muted">
              <Spinner /> Lecture des méthodes de connexion…
            </div>
          ) : methods.error || !method ? (
            <div className="callout critical" role="alert">
              <Icon name="alert" size={18} />
              <span className="spacer">
                {methods.error ? errorText(methods.error) : "opencode ne propose pas de connexion GitHub Copilot."} Vérifiez qu'opencode est
                démarré (page Diagnostic).
              </span>
              <Button size="sm" icon="refresh" onClick={methods.reload}>
                Réessayer
              </Button>
            </div>
          ) : (!connected || formOpen) && (flow.step === "idle" || flow.step === "error") ? (
            <div className="stack">
              {prompts.map((p) =>
                visible(p) ? (
                  <Field key={p.key} label={p.message} htmlFor={`${promptIdPrefix}-${p.key}`}>
                    {p.type === "select" ? (
                      <select
                        id={`${promptIdPrefix}-${p.key}`}
                        className="select"
                        style={{ maxWidth: 360 }}
                        value={valueOf(p.key)}
                        onChange={(e) => setInputs((s) => ({ ...s, [p.key]: e.target.value }))}
                      >
                        {(p.options ?? []).map((o) => (
                          <option key={o.value} value={o.value}>
                            {o.label}
                            {o.hint ? ` (${o.hint})` : ""}
                          </option>
                        ))}
                      </select>
                    ) : (
                      <input
                        id={`${promptIdPrefix}-${p.key}`}
                        className="input"
                        style={{ maxWidth: 360 }}
                        placeholder={p.placeholder}
                        value={valueOf(p.key)}
                        onChange={(e) => setInputs((s) => ({ ...s, [p.key]: e.target.value }))}
                      />
                    )}
                  </Field>
                ) : null,
              )}
              <div>
                <Button variant="primary" icon="plug" onClick={() => void connect()} disabled={missing}>
                  Connecter
                </Button>
                {connected ? (
                  <Button variant="ghost" onClick={() => setFormOpen(false)} style={{ marginLeft: 8 }}>
                    Annuler
                  </Button>
                ) : null}
              </div>
            </div>
          ) : null}

          {flow.step === "authorizing" ? (
            <div className="row">
              <Spinner /> Demande d'un code à GitHub…
            </div>
          ) : null}

          {flow.step === "waiting" ? (
            <div className="stack">
              <ol className="connect-steps">
                <li>Copiez le code ci-dessous.</li>
                <li>Ouvrez la page GitHub, collez le code et autorisez l'accès.</li>
                <li>Revenez ici : la connexion se termine toute seule (le code expire au bout d'environ 15 minutes).</li>
              </ol>
              <div className="connect-code-box">
                {flow.code ? (
                  <>
                    <span className="small muted">Code d'appareil</span>
                    <span className="connect-code" aria-label={`Code : ${flow.code.split("").join(" ")}`}>
                      {flow.code}
                    </span>
                  </>
                ) : (
                  <span className="secondary">{flow.instructions || "Suivez les instructions sur la page GitHub."}</span>
                )}
                <div className="row wrap" style={{ justifyContent: "center" }}>
                  {flow.code ? (
                    <Button icon="copy" onClick={() => copyCode(flow.code as string)}>
                      Copier le code
                    </Button>
                  ) : null}
                  {isHttpsUrl(flow.url) ? (
                    <a className="btn primary" href={flow.url} target="_blank" rel="noopener noreferrer">
                      <Icon name="external" size={16} />
                      Ouvrir GitHub
                    </a>
                  ) : (
                    <span className="field-error">Adresse d'autorisation inattendue : connexion interrompue par sécurité.</span>
                  )}
                </div>
              </div>
              {flow.manual ? (
                <div className="row wrap" style={{ alignItems: "flex-end" }}>
                  <Field label="Code renvoyé par GitHub" htmlFor={manualId}>
                    <input id={manualId} className="input mono" value={manualCode} onChange={(e) => setManualCode(e.target.value)} style={{ maxWidth: 280 }} />
                  </Field>
                  <Button variant="primary" onClick={() => void submitManual()} disabled={!manualCode.trim()}>
                    Valider
                  </Button>
                </div>
              ) : (
                <div className="row small muted">
                  <span className="dot accent pulse" aria-hidden />
                  En attente de votre autorisation sur GitHub…
                </div>
              )}
              <div>
                <Button variant="ghost" icon="x" onClick={cancel}>
                  Annuler
                </Button>
              </div>
            </div>
          ) : null}

          {flow.step === "finishing" ? (
            <div className="row">
              <Spinner /> Autorisation reçue, chargement des modèles…
            </div>
          ) : null}

          {flow.step === "error" ? (
            <div className="callout critical" role="alert">
              <Icon name="alert" size={18} />
              <div className="stack tight spacer">
                <strong>La connexion n'a pas abouti</strong>
                <span>{flow.message}</span>
              </div>
              <Button size="sm" icon="refresh" onClick={() => void connect()} disabled={missing}>
                Réessayer
              </Button>
            </div>
          ) : null}

          {busy && connected ? <p className="small muted">La connexion actuelle reste active tant que la nouvelle n'est pas confirmée.</p> : null}
        </div>
      </Card>

      <div className="callout accent">
        <Icon name="shield" size={18} />
        <div className="stack tight">
          <strong>Où va votre jeton ?</strong>
          <span>
            Le jeton GitHub reste dans le volume du conteneur opencode : il n'est jamais envoyé au navigateur ni enregistré par le cockpit. Par
            défaut, seul le fournisseur GitHub Copilot est activé (Paramètres › opencode) : aucun code n'est transmis à d'autres fournisseurs.
          </span>
        </div>
      </div>
    </div>
  );
}
