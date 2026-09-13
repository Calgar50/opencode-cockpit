// Paramètres › Sécurité (§8) : profil de droits global d'opencode, retour au profil Prudent, fournisseur d'IA autorisé.
import { useEffect, useRef, useState } from "react";
import {
  detectPermissionPreset,
  isDefaultProviders,
  MESSAGES,
  modifiedProfileText,
  PERMISSION_PRESETS,
  SECURITY_TEXTS,
} from "../../../server/shared/assistant-rules.ts";
import { useApp } from "../../app/AppContext.tsx";
import { Icon } from "../../components/Icon.tsx";
import { useToast } from "../../components/Toast.tsx";
import { Button, Card, Spinner, useAsync, useConfirm } from "../../components/ui.tsx";
import { api, errorText } from "../../lib/api.ts";
import { cockpitEvent, useEvents } from "../../lib/events.ts";

export function SecuriteTab() {
  const { boot } = useApp();
  const toast = useToast();
  const confirm = useConfirm();
  const config = useAsync(() => api.opencodeConfig(), []);
  const reloadRef = useRef(config.reload);
  reloadRef.current = config.reload;
  const [restoring, setRestoring] = useState(false);
  const timer = useRef<number | undefined>(undefined);

  useEffect(() => () => window.clearTimeout(timer.current), []);
  useEvents((event) => {
    if (cockpitEvent(event, "opencode.config.changed")) {
      window.clearTimeout(timer.current);
      timer.current = window.setTimeout(() => reloadRef.current(), 400);
    }
  });

  const preset = config.data ? detectPermissionPreset(config.data.permission) : null;
  const providers = boot.allowedProviders ?? ["github-copilot"];

  const restore = async () => {
    const ok = await confirm({
      title: "Revenir au profil Prudent ?",
      message:
        "Les permissions globales d'opencode seront remplacées : l'assistant demandera avant de modifier un fichier, lancer une commande, consulter le web ou déléguer.",
      confirmLabel: SECURITY_TEXTS.restorePrudent,
    });
    if (!ok) return;
    setRestoring(true);
    try {
      await api.restorePrudent();
      toast.success("Profil Prudent rétabli", "L'assistant demande de nouveau avant chaque action sensible.");
      config.reload();
    } catch (err) {
      toast.error("Profil non appliqué", err);
    } finally {
      setRestoring(false);
    }
  };

  return (
    <div className="stack loose">
      <Card title="Profil de droits" subtitle="Règles globales appliquées à l'Assistant général et aux agents sans règles propres.">
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
        ) : preset === "prudent" ? (
          <div className="callout good">
            <Icon name="shield" size={18} />
            <span>{SECURITY_TEXTS.prudent}</span>
          </div>
        ) : (
          <div className="stack">
            <div className="callout warning">
              <Icon name="alert" size={18} />
              <span>{modifiedProfileText(preset ? PERMISSION_PRESETS[preset].label : "Personnalisé")}</span>
            </div>
            <div>
              <Button variant="primary" icon="shield" loading={restoring} onClick={() => void restore()}>
                {SECURITY_TEXTS.restorePrudent}
              </Button>
            </div>
          </div>
        )}
      </Card>

      <Card title="Fournisseur d'IA">
        {isDefaultProviders(providers) ? (
          <div className="callout good">
            <Icon name="check" size={18} />
            <span>{SECURITY_TEXTS.provider}</span>
          </div>
        ) : (
          <div className="callout critical" role="alert">
            <Icon name="alert" size={18} />
            <span>
              <strong>{MESSAGES.testProviderBanner}</strong> Fournisseurs autorisés : {providers.join(", ")}.
            </span>
          </div>
        )}
      </Card>
    </div>
  );
}
