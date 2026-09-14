// Règles d'utilisation (fenêtre bloquante versionnée) et notice unique de la version 0.2.0.
import { type KeyboardEvent, useEffect, useId, useRef, useState } from "react";
import {
  GOLDEN_RULES,
  perRequestText,
  RULES_BUTTON,
  RULES_CHECKBOX,
  RULES_TITLE_CHANGED,
  RULES_TITLE_FIRST,
} from "../../server/shared/assistant-rules.ts";
import { Icon } from "../components/Icon.tsx";
import { useToast } from "../components/Toast.tsx";
import { Button } from "../components/ui.tsx";
import { api, errorText } from "../lib/api.ts";
import { useApp } from "./AppContext.tsx";

/** Version dont la notice « Nouveau » est enregistrée dans ui.noticeSeen. */
export const UPGRADE_NOTICE_VERSION = "1.0.0";

/** true tant que les règles de cette version n'ont pas été acceptées (serveur antérieur à 0.2.0 : jamais). */
export function needsRules(acceptedVersion: number, rulesVersion: number | undefined): boolean {
  return typeof rulesVersion === "number" && acceptedVersion < rulesVersion;
}

/**
 * Fenêtre « Avant de commencer » : les 6 règles d'or, non modifiables. Aucune fermeture possible sans accepter
 * (ni Échap, ni clic à côté) ; le reste de l'application est rendu inerte par la coquille.
 */
export function FirstRunRules() {
  const { boot, ui, saveUi } = useApp();
  const titleId = useId();
  const checkId = useId();
  const dialog = useRef<HTMLDivElement>(null);
  const checkbox = useRef<HTMLInputElement>(null);
  const [checked, setChecked] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    checkbox.current?.focus();
  }, []);

  const title = ui.rulesAcceptedVersion > 0 ? RULES_TITLE_CHANGED : RULES_TITLE_FIRST;

  const accept = async () => {
    if (!checked) return;
    setBusy(true);
    setError("");
    try {
      await saveUi({ rulesAcceptedVersion: boot.rulesVersion });
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  // Garde le focus dans la fenêtre (Tab / Maj+Tab) ; Échap ne ferme pas.
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === "Escape") {
      e.preventDefault();
      return;
    }
    if (e.key !== "Tab" || !dialog.current) return;
    const focusable = [...dialog.current.querySelectorAll<HTMLElement>("input, button:not(:disabled)")];
    if (focusable.length === 0) return;
    const first = focusable[0]!;
    const last = focusable[focusable.length - 1]!;
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  };

  return (
    <div className="modal-backdrop rules-backdrop">
      <div className="modal rules-modal" role="alertdialog" aria-modal="true" aria-labelledby={titleId} ref={dialog} onKeyDown={onKeyDown}>
        <div className="modal-header">
          <Icon name="shield" size={20} />
          <h2 id={titleId} className="spacer" style={{ fontSize: 17 }}>
            {title}
          </h2>
        </div>
        <div className="modal-body stack">
          <ol className="rules-list">
            {GOLDEN_RULES.map((rule) => (
              <li key={rule}>{rule}</li>
            ))}
          </ol>
          <label className="check-row rules-check" htmlFor={checkId}>
            <input id={checkId} ref={checkbox} type="checkbox" checked={checked} onChange={(e) => setChecked(e.target.checked)} />
            <span>{RULES_CHECKBOX}</span>
          </label>
          {error ? (
            <p className="field-error" role="alert">
              {error}
            </p>
          ) : null}
        </div>
        <div className="modal-footer">
          <Button variant="primary" icon="check" loading={busy} disabled={!checked} onClick={() => void accept()}>
            {RULES_BUTTON}
          </Button>
        </div>
      </div>
    </div>
  );
}

interface AgentWithModel {
  name: string;
  modelName: string;
  cost: string | null;
}

/**
 * Notice unique (§8, §13) : mode Simple par défaut et IA des assistants réellement utilisée, avec la liste des agents
 * créés avant 1.0 qui imposent une IA. [Passer en mode Avancé] [Compris] enregistrent ui.noticeSeen.
 */
export function UpgradeNotice() {
  const { advanced, saveUi, modelByKey } = useApp();
  const toast = useToast();
  const [busy, setBusy] = useState<"compris" | "avance" | null>(null);
  const [agents, setAgents] = useState<AgentWithModel[]>([]);

  useEffect(() => {
    let cancelled = false;
    api.assistants().then(
      (data) => {
        if (cancelled) return;
        setAgents(
          data.toComplete.flatMap((item) => {
            if (!item.model) return [];
            const cost = modelByKey(item.model)?.taskCost?.M;
            return [{ name: item.name, modelName: item.modelName ?? item.model, cost: cost === undefined ? null : perRequestText(cost) }];
          }),
        );
      },
      () => undefined, // Liste facultative : la notice reste utile sans elle.
    );
    return () => {
      cancelled = true;
    };
    // Chargée une seule fois à l'affichage de la notice.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const dismiss = async (switchToAdvanced: boolean) => {
    setBusy(switchToAdvanced ? "avance" : "compris");
    try {
      await saveUi(switchToAdvanced ? { mode: "avance", noticeSeen: UPGRADE_NOTICE_VERSION } : { noticeSeen: UPGRADE_NOTICE_VERSION });
      if (switchToAdvanced) toast.success("Mode Avancé activé", "Le Studio et les réglages avancés sont visibles.");
    } catch (err) {
      toast.error("Enregistrement impossible", err);
    } finally {
      setBusy(null);
    }
  };

  const list = agents.map((a) => `${a.name} → ${a.modelName}${a.cost ? ` (${a.cost})` : ""}`).join(", ");

  return (
    <section className="notice-panel" aria-label="Nouveautés de la version 1.0">
      <Icon name="sparkle" size={18} />
      <div className="stack tight spacer">
        <strong>Nouveau : le cockpit s'ouvre en mode Simple. Vos réglages, agents et conversations sont intacts.</strong>
        <div className="stack tight">
          <strong>Nouveau en 1.0 : l'IA d'un assistant est vraiment utilisée</strong>
          <p className="secondary">
            Jusqu'ici, le chat utilisait l'IA choisie en bas de l'écran, même pour un agent réglé sur une autre IA. C'est corrigé.
            {list ? ` Vérifiez ces agents : ${list}.` : ""} La réflexion des raccourcis non délégués est aussi appliquée désormais.
          </p>
        </div>
        <div className="row wrap">
          {!advanced ? (
            <Button size="sm" loading={busy === "avance"} disabled={busy !== null} onClick={() => void dismiss(true)}>
              Passer en mode Avancé
            </Button>
          ) : null}
          <Button size="sm" variant="primary" loading={busy === "compris"} disabled={busy !== null} onClick={() => void dismiss(false)}>
            Compris
          </Button>
        </div>
      </div>
    </section>
  );
}
