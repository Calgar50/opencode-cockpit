// Paramètres › Affichage (§9.7) : mode Simple (par défaut) ou Avancé.
import { useId, useState } from "react";
import { UI_MODES, type UiMode } from "../../../server/shared/assistant-rules.ts";
import { useApp } from "../../app/AppContext.tsx";
import { useToast } from "../../components/Toast.tsx";
import { Card, Spinner, useConfirm } from "../../components/ui.tsx";

const MODE_LABELS: Readonly<Record<UiMode, string>> = { simple: "Simple (recommandé)", avance: "Avancé" };

export function AffichageTab() {
  const { ui, saveUi } = useApp();
  const toast = useToast();
  const confirm = useConfirm();
  const name = useId();
  const hintId = useId();
  const [busy, setBusy] = useState<UiMode | null>(null);

  const choose = async (mode: UiMode) => {
    if (mode === ui.mode || busy) return;
    if (mode === "avance") {
      const ok = await confirm({
        title: "Passer en mode Avancé ?",
        message:
          "Le mode Avancé affiche des réglages qui peuvent augmenter les coûts ou donner plus de droits à l'IA. Les protections du cockpit restent actives : GitHub Copilot uniquement, confirmations, budget.",
        confirmLabel: "Passer en mode Avancé",
      });
      if (!ok) return;
    }
    setBusy(mode);
    try {
      await saveUi({ mode });
      toast.success(mode === "avance" ? "Mode Avancé activé" : "Mode Simple activé");
    } catch (err) {
      toast.error("Enregistrement impossible", err);
    } finally {
      setBusy(null);
    }
  };

  return (
    <Card title="Mode d'affichage">
      <div className="settings-form">
        <div className="stack tight" role="radiogroup" aria-label="Mode d'affichage" aria-describedby={hintId}>
          {UI_MODES.map((mode) => (
            <label key={mode} className={`choice-card${ui.mode === mode ? " selected" : ""}`}>
              <input type="radio" name={name} checked={ui.mode === mode} disabled={busy !== null} onChange={() => void choose(mode)} />
              <strong className="spacer">{MODE_LABELS[mode]}</strong>
              {busy === mode ? <Spinner /> : null}
            </label>
          ))}
        </div>
        <p className="field-hint" id={hintId}>
          Le mode Simple n'affiche que les choix sûrs et expliqués. Le mode Avancé ouvre le Studio, les fichiers bruts et les réglages risqués. Ce
          n'est pas une protection : chaque poste reste administré par son utilisateur.
        </p>
      </div>
    </Card>
  );
}
