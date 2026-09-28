// Règles d'utilisation (fenêtre bloquante versionnée) et annonce unique de la version (1.1.0 : L51, annonce-110.ts).
import { type KeyboardEvent, useEffect, useId, useRef, useState } from "react";
import {
  GOLDEN_RULES,
  RULES_BUTTON,
  RULES_CHECKBOX,
  RULES_TITLE_CHANGED,
  RULES_TITLE_FIRST,
} from "../../server/shared/assistant-rules.ts";
import { annonce110 } from "../../server/shared/annonce-110.ts";
import type { LocalAccessNotice } from "../../server/shared/local-access-notice.ts";
import { Icon } from "../components/Icon.tsx";
import { useToast } from "../components/Toast.tsx";
import { Button } from "../components/ui.tsx";
import { errorText } from "../lib/api.ts";
import { openAssistants, useRoute } from "../lib/router.ts";
import { useOuvertesEnSimple } from "../pages/chat/activity/useOuvertesEnSimple.ts";
import { useApp } from "./AppContext.tsx";
import { LocalHttpBanner, LocalHttpDetails } from "./LocalHttpNotice.tsx";

/** Version dont l'annonce « Nouveau » est enregistrée dans ui.noticeSeen (L51 : annonce de la 1.1.0, une fois). */
export const UPGRADE_NOTICE_VERSION = "1.1.0";

/** true tant que les règles de cette version n'ont pas été acceptées (serveur antérieur à 0.2.0 : jamais). */
export function needsRules(acceptedVersion: number, rulesVersion: number | undefined): boolean {
  return typeof rulesVersion === "number" && acceptedVersion < rulesVersion;
}

/**
 * Fenêtre « Avant de commencer » : les 6 règles d'or, non modifiables. Aucune fermeture possible sans accepter
 * (ni Échap, ni clic à côté) ; le reste de l'application est rendu inerte par la coquille.
 * Mode HTTP local : le bandeau permanent (I6), inerte derrière la fenêtre, y est repris ; son bouton Détails déplie les
 * explications sur place, la page Diagnostic n'étant pas accessible avant l'acceptation.
 */
export function FirstRunRules({ accessNotice = null }: { accessNotice?: LocalAccessNotice | null }) {
  const { boot, ui, saveUi } = useApp();
  const titleId = useId();
  const checkId = useId();
  const detailsId = useId();
  const [detailsOpen, setDetailsOpen] = useState(false);
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
        {accessNotice ? (
          <LocalHttpBanner notice={accessNotice} detailsId={detailsId} detailsOpen={detailsOpen} onDetails={() => setDetailsOpen((open) => !open)} />
        ) : null}
        <div className="modal-body stack">
          {accessNotice && detailsOpen ? <LocalHttpDetails id={detailsId} /> : null}
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


/** Pages où l'annonce de la version est montrée (conception C §9.14 : « chat and Assistants, once »). */
const NOTICE_SECTIONS: ReadonlySet<string> = new Set(["chat", "assistants"]);

/**
 * Annonce de la 1.1.0 (L51 ; plan it5 §4.3, D-5-24 ; décisions U1 et A37), une seule fois, dans le chat et dans Assistants :
 * [Voir la carte] ou [Compris] l'enregistrent dans ui.noticeSeen. Le texte vient d'annonce110 (shared/annonce-110.ts) :
 * phrase d'équipe seulement si les équipes sont ouvertes dans le mode courant, `ouvertesEnSimple` étant lu par GET /api/teams
 * (client api-teams.ts, par useOuvertesEnSimple) en mode Simple seulement, et `null` (lecture en cours ou en échec) fermant ;
 * paragraphe « Internet » dans les deux modes, phrase technique en mode Avancé seulement.
 */
export function UpgradeNotice() {
  const { advanced, saveUi } = useApp();
  const toast = useToast();
  const route = useRoute();
  const visible = NOTICE_SECTIONS.has(route[0] ?? "chat");
  const ouvertesEnSimple = useOuvertesEnSimple(visible && !advanced);
  const [busy, setBusy] = useState<"compris" | "carte" | null>(null);

  if (!visible) return null;
  const annonce = annonce110(advanced ? "avance" : "simple", ouvertesEnSimple);

  const dismiss = async (voirCarte: boolean) => {
    setBusy(voirCarte ? "carte" : "compris");
    try {
      await saveUi({ noticeSeen: UPGRADE_NOTICE_VERSION });
      if (voirCarte) openAssistants({ mode: "carte", element: null });
    } catch (err) {
      toast.error("Enregistrement impossible", err);
    } finally {
      setBusy(null);
    }
  };

  return (
    <section className="notice-panel" aria-label={annonce.region}>
      <Icon name="sparkle" size={18} />
      <div className="stack tight spacer">
        <strong>{annonce.titre}</strong>
        <p className="secondary">{annonce.texte}</p>
        {annonce.internet.map((phrase) => (
          <p key={phrase} className="secondary">
            {phrase}
          </p>
        ))}
        <div className="row wrap">
          <Button size="sm" loading={busy === "carte"} disabled={busy !== null} onClick={() => void dismiss(true)}>
            {annonce.voirCarte}
          </Button>
          <Button size="sm" variant="primary" loading={busy === "compris"} disabled={busy !== null} onClick={() => void dismiss(false)}>
            {annonce.compris}
          </Button>
        </div>
      </div>
    </section>
  );
}
