// Paramètres : connexion Copilot, budget, tarifs, classement, configuration opencode et chat.
import { useCallback, useEffect, useRef } from "react";
import type { IconName } from "../components/Icon.tsx";
import { Tabs, useConfirm } from "../components/ui.tsx";
import { navigate, useRoute } from "../lib/router.ts";
import { BudgetTab } from "./settings/BudgetTab.tsx";
import { ChatTab } from "./settings/ChatTab.tsx";
import { ClassifierTab } from "./settings/ClassifierTab.tsx";
import { ConnectionTab } from "./settings/ConnectionTab.tsx";
import { OpencodeTab } from "./settings/OpencodeTab.tsx";
import { PricingTab } from "./settings/PricingTab.tsx";
import "./studio/studio.css";
import "./settings/settings.css";

type SettingsTab = "connexion" | "budget" | "tarifs" | "classement" | "opencode" | "chat";

const TABS: Array<{ id: SettingsTab; label: string; icon: IconName }> = [
  { id: "connexion", label: "Connexion", icon: "plug" },
  { id: "budget", label: "Budget", icon: "coins" },
  { id: "tarifs", label: "Tarifs", icon: "tag" },
  { id: "classement", label: "Classement", icon: "layers" },
  { id: "opencode", label: "opencode", icon: "wrench" },
  { id: "chat", label: "Chat", icon: "chat" },
];

export function SettingsPage() {
  const route = useRoute();
  const confirm = useConfirm();
  const tab: SettingsTab = TABS.find((t) => t.id === route[1])?.id ?? "connexion";
  const dirtyRef = useRef(false);

  const onDirtyChange = useCallback((dirty: boolean) => {
    dirtyRef.current = dirty;
  }, []);

  useEffect(() => {
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      if (dirtyRef.current) e.preventDefault();
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, []);

  const changeTab = async (next: SettingsTab) => {
    if (next === tab) return;
    if (dirtyRef.current) {
      const ok = await confirm({
        title: "Modifications non enregistrées",
        message: "Changer d'onglet fera perdre les modifications en cours.",
        confirmLabel: "Quitter sans enregistrer",
        danger: true,
      });
      if (!ok) return;
      dirtyRef.current = false;
    }
    navigate("parametres", next);
  };

  return (
    <div className="page">
      <div className="page-narrow">
        <header className="page-header">
          <div className="spacer" style={{ minWidth: 0 }}>
            <h1>Paramètres</h1>
            <p>Réglages du cockpit et de la configuration globale d'opencode. Chaque section s'enregistre séparément.</p>
          </div>
        </header>
        <Tabs<SettingsTab> value={tab} items={TABS} onChange={(next) => void changeTab(next)} />
        <div role="tabpanel" aria-label={TABS.find((t) => t.id === tab)?.label}>
          {tab === "connexion" ? <ConnectionTab /> : null}
          {tab === "budget" ? <BudgetTab onDirtyChange={onDirtyChange} /> : null}
          {tab === "tarifs" ? <PricingTab /> : null}
          {tab === "classement" ? <ClassifierTab onDirtyChange={onDirtyChange} /> : null}
          {tab === "opencode" ? <OpencodeTab onDirtyChange={onDirtyChange} /> : null}
          {tab === "chat" ? <ChatTab onDirtyChange={onDirtyChange} /> : null}
        </div>
      </div>
    </div>
  );
}
