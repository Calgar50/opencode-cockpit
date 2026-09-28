// Paramètres › Sécurité (§8) : profil de droits global d'opencode, retour au profil Prudent, fournisseur d'IA autorisé.
// 1.1.0 (A37, fiche de la migration du web §5.2 et §5.3) : un profil d'une version précédente (Internet encore ouvert) n'est plus vert
// et propose « Fermer l'accès à Internet » (même profil, seul le web change) ; les assistants qui peuvent encore demander Internet
// sont signalés par leur titre (security.webIssues), jamais par leur nom technique en mode Simple. Pré-publication : une règle générale
// personnalisée qui demande encore Internet est signalée aussi (texteRegleGenerale), avec « Revenir au profil Prudent ».
import { useEffect, useRef, useState } from "react";
import {
  configProviderIssues,
  isDefaultProviders,
  legacyProfileText,
  MESSAGES,
  modifiedProfileText,
  PERMISSION_PRESETS,
  SECURITY_TEXTS,
  securiteProfil,
} from "../../../server/shared/assistant-rules.ts";
import {
  TEXTES as TEXTES_INTERNET,
  texteAssistantsSignales,
  texteFermerMessage,
  texteFermerReussite,
  texteRegleGenerale,
} from "../../../server/shared/internet-texts.ts";
import { useApp } from "../../app/AppContext.tsx";
import { Icon } from "../../components/Icon.tsx";
import { useToast } from "../../components/Toast.tsx";
import { Button, Card, Spinner, useAsync, useConfirm } from "../../components/ui.tsx";
import { ApiError, api, errorText } from "../../lib/api.ts";
import { cockpitEvent, useEvents } from "../../lib/events.ts";

export function SecuriteTab() {
  const { boot, advanced } = useApp();
  const toast = useToast();
  const confirm = useConfirm();
  const config = useAsync(() => api.opencodeConfig(), []);
  // Assistants signalés : relus avec l'état du système (même champ que le Diagnostic), sinon ceux du démarrage.
  const status = useAsync(() => api.systemStatus(), []);
  const reloadRef = useRef<() => void>(() => undefined);
  reloadRef.current = () => {
    config.reload();
    status.reload();
  };
  const [restoring, setRestoring] = useState(false);
  const timer = useRef<number | undefined>(undefined);

  useEffect(() => () => window.clearTimeout(timer.current), []);
  useEvents((event) => {
    if (cockpitEvent(event, "opencode.config.changed")) {
      window.clearTimeout(timer.current);
      timer.current = window.setTimeout(() => reloadRef.current(), 400);
    }
  });

  // Jugé par securiteProfil (legacyPresetOf puis detectPermissionPreset) : un profil 1.0 n'est jamais « Prudent » en vert.
  const profil = config.data ? securiteProfil(config.data.permission) : null;
  const webIssues = status.data ? status.data.security.webIssues : (boot.security.webIssues ?? null);
  const signales = texteAssistantsSignales(webIssues, advanced);
  // Règle générale personnalisée qui demande encore Internet (pré-publication 1.1.0) : l'installateur et le Diagnostic renvoient ici.
  const regleGenerale = texteRegleGenerale(webIssues, profil?.etat ?? null, advanced);
  const providers = boot.allowedProviders ?? ["github-copilot"];
  // Verrou réellement appliqué par opencode (enabled_providers, IA par défaut), pas seulement COCKPIT_ALLOWED_PROVIDERS.
  const lockIssues = config.data
    ? configProviderIssues(config.data, providers, boot.copilot?.enterpriseDomain ?? null)
    : (boot.security.providerIssues ?? []);
  const copilotOnly = isDefaultProviders(providers) && lockIssues.length === 0;

  const restore = async () => {
    const ok = await confirm({
      title: "Revenir au profil Prudent ?",
      message: TEXTES_INTERNET.partout.prudentMessage,
      confirmLabel: SECURITY_TEXTS.restorePrudent,
    });
    if (!ok) return;
    setRestoring(true);
    try {
      const result = await api.restorePrudent();
      const detail = TEXTES_INTERNET.partout.prudentReussite;
      toast.success("Profil Prudent rétabli", result.restarted ? `opencode a redémarré pour l'appliquer. ${detail}` : detail);
      reloadRef.current();
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) toast.warning("Profil non appliqué", err.message);
      else toast.error("Profil non appliqué", err);
    } finally {
      setRestoring(false);
    }
  };

  // « Fermer l'accès à Internet » (deux modes) : le serveur relit la configuration et n'écrit que le même profil en version 1.1.
  const closeInternet = async (label: string) => {
    const ok = await confirm({ title: TEXTES_INTERNET.partout.fermerTitre, message: texteFermerMessage(label), confirmLabel: SECURITY_TEXTS.closeInternet });
    if (!ok) return;
    setRestoring(true);
    try {
      const result = await api.updateProfile();
      toast.success(texteFermerReussite(PERMISSION_PRESETS[result.profil].label), result.restarted ? "opencode a redémarré pour l'appliquer." : undefined);
      reloadRef.current();
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) toast.warning("Profil non modifié", err.message);
      else toast.error("Profil non modifié", err);
    } finally {
      setRestoring(false);
    }
  };

  return (
    <div className="stack loose">
      <Card title="Profil de droits" subtitle="Règles globales appliquées à l'Assistant général et aux assistants sans règles propres.">
        {config.loading && !config.data ? (
          <Spinner />
        ) : config.error && !config.data ? (
          <div className="callout critical" role="alert">
            <Icon name="alert" size={18} />
            <span className="spacer">{errorText(config.error)}</span>
            <Button size="sm" icon="refresh" onClick={config.reload}>
              Réessayer
            </Button>
          </div>
        ) : profil === null || profil.etat === "modifie" ? (
          <div className="stack">
            <div className="callout warning">
              <Icon name="alert" size={18} />
              <span>{modifiedProfileText(profil?.label ?? "Personnalisé")}</span>
            </div>
            <div>
              <Button variant="primary" icon="shield" loading={restoring} onClick={() => void restore()}>
                {SECURITY_TEXTS.restorePrudent}
              </Button>
            </div>
          </div>
        ) : profil.etat === "ancien" ? (
          <div className="stack">
            <div className="callout warning" role="status">
              <Icon name="alert" size={18} />
              <span>{legacyProfileText(profil.label)}</span>
            </div>
            <div>
              <Button variant="primary" icon="lock" loading={restoring} onClick={() => void closeInternet(profil.label)}>
                {SECURITY_TEXTS.closeInternet}
              </Button>
            </div>
          </div>
        ) : (
          <div className="callout good">
            <Icon name="shield" size={18} />
            <span>{SECURITY_TEXTS.prudent}</span>
          </div>
        )}
        {config.data && regleGenerale !== null ? (
          <div className="callout warning" role="status" style={{ marginTop: 12 }} data-regle-generale-internet="">
            <Icon name="alert" size={18} />
            <span>{regleGenerale}</span>
          </div>
        ) : null}
        {config.data && signales !== null ? (
          <div className="callout warning" role="status" style={{ marginTop: 12 }}>
            <Icon name="alert" size={18} />
            <span>{signales}</span>
          </div>
        ) : null}
      </Card>

      <Card title="Fournisseur d'IA">
        {copilotOnly ? (
          <div className="callout good">
            <Icon name="check" size={18} />
            <span>{SECURITY_TEXTS.provider}</span>
          </div>
        ) : (
          <div className="callout critical" role="alert">
            <Icon name="alert" size={18} />
            <span className="stack tight">
              {!isDefaultProviders(providers) ? (
                <span>
                  <strong>{MESSAGES.testProviderBanner}</strong> Fournisseurs autorisés : {providers.join(", ")}.
                </span>
              ) : null}
              {lockIssues.length > 0 ? (
                <span>
                  <strong>{MESSAGES.providerLockBanner}</strong> {lockIssues.map((i) => `${i.path} : ${i.message}`).join(" · ")} Corrigez la
                  configuration dans Paramètres › opencode (mode Avancé).
                </span>
              ) : null}
            </span>
          </div>
        )}
      </Card>
    </div>
  );
}
