// Propriétaire : L5b.
// Paramètres › Affichage : annonces de « Qui travaille ? » pour les lecteurs d'écran (`ui.activityAnnouncements`, spécification
// §5.5), après le mode d'affichage. Réglable dans les deux modes (`ui.*` fait partie de SIMPLE_SETTINGS_PATHS), enregistré par
// l'API des réglages existante (saveUi). Propriétés figées dans ../chat/slots.ts.
import { useState } from "react";
import { TEXTES } from "../../../server/shared/activity-texts.ts";
import { useApp } from "../../app/AppContext.tsx";
import { useToast } from "../../components/Toast.tsx";
import { Card, ToggleRow } from "../../components/ui.tsx";
import type { ActivitySettingsProps } from "../chat/slots.ts";

export function ActivitySettings(_props: ActivitySettingsProps) {
  const { ui, saveUi } = useApp();
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const { reglages } = TEXTES.partout;

  const change = async (enabled: boolean) => {
    if (busy || enabled === ui.activityAnnouncements) return;
    setBusy(true);
    try {
      await saveUi({ activityAnnouncements: enabled });
      toast.success(enabled ? reglages.activees : reglages.coupees);
    } catch (err) {
      toast.error(reglages.echec, err);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card title={reglages.titre}>
      <div className="settings-form">
        <ToggleRow
          title={reglages.libelle}
          description={reglages.aide}
          checked={ui.activityAnnouncements}
          disabled={busy}
          onChange={(enabled) => void change(enabled)}
        />
      </div>
    </Card>
  );
}
