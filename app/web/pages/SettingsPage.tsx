// Paramètres : connexion Copilot, niveaux d'IA, budget, tarifs, classement, configuration opencode, chat, affichage, sécurité.
// En mode Simple, les onglets Tarifs, Classement et opencode sont masqués.
import { useCallback, useEffect, useRef } from "react";
import { useApp } from "../app/AppContext.tsx";
import { Icon, type IconName } from "../components/Icon.tsx";
import { Button, Tabs, useConfirm } from "../components/ui.tsx";
import { navigate, useRoute } from "../lib/router.ts";
import { AffichageTab } from "./settings/AffichageTab.tsx";
import { BudgetTab } from "./settings/BudgetTab.tsx";
import { ChatTab } from "./settings/ChatTab.tsx";
import { ClassifierTab } from "./settings/ClassifierTab.tsx";
import { ConnectionTab } from "./settings/ConnectionTab.tsx";
import { OpencodeTab } from "./settings/OpencodeTab.tsx";
import { PricingTab } from "./settings/PricingTab.tsx";
import { SecuriteTab } from "./settings/SecuriteTab.tsx";
import { TiersTab } from "./settings/TiersTab.tsx";
import "./studio/studio.css";
import "./settings/settings.css";
import "./assistants/assistants.css";

type SettingsTab = "connexion" | "niveaux" | "budget" | "tarifs" | "classement" | "opencode" | "chat" | "affichage" | "securite";

const TABS: Array<{ id: SettingsTab; label: string; icon: IconName; advancedOnly?: boolean }> = [
  { id: "connexion", label: "Connexion", icon: "plug" },
  { id: "niveaux", label: "Niveaux d'IA", icon: "gauge" },
  { id: "budget", label: "Budget", icon: "coins" },
  { id: "tarifs", label: "Tarifs", icon: "tag", advancedOnly: true },
  { id: "classement", label: "Classement", icon: "layers", advancedOnly: true },
  { id: "opencode", label: "opencode", icon: "wrench", advancedOnly: true },
  { id: "chat", label: "Chat", icon: "chat" },
  { id: "affichage", label: "Affichage", icon: "monitor" },
  { id: "securite", label: "Sécurité", icon: "shield" },
];

export function SettingsPage() {
  const route = useRoute();
  const confirm = useConfirm();
  const { advanced } = useApp();
  const visible = TABS.filter((t) => advanced || !t.advancedOnly);
  const hiddenRequested = !advanced ? TABS.find((t) => t.advancedOnly && t.id === route[1]) : undefined;
  const tab: SettingsTab = visible.find((t) => t.id === route[1])?.id ?? "connexion";
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
    if (next === tab && !hiddenRequested) return;
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
        <Tabs<SettingsTab> value={tab} items={visible} onChange={(next) => void changeTab(next)} />
        {hiddenRequested ? (
          <div className="callout warning" style={{ marginBottom: 16, alignItems: "center" }}>
            <Icon name="lock" size={18} />
            <span className="spacer">L'onglet « {hiddenRequested.label} » est réservé au mode Avancé (Paramètres › Affichage).</span>
            <Button size="sm" onClick={() => void changeTab("affichage")}>
              Affichage
            </Button>
          </div>
        ) : null}
        <div role="tabpanel" aria-label={TABS.find((t) => t.id === tab)?.label}>
          {tab === "connexion" ? <ConnectionTab /> : null}
          {tab === "niveaux" ? <TiersTab onDirtyChange={onDirtyChange} /> : null}
          {tab === "budget" ? <BudgetTab onDirtyChange={onDirtyChange} /> : null}
          {tab === "tarifs" ? <PricingTab /> : null}
          {tab === "classement" ? <ClassifierTab onDirtyChange={onDirtyChange} /> : null}
          {tab === "opencode" ? <OpencodeTab onDirtyChange={onDirtyChange} /> : null}
          {tab === "chat" ? <ChatTab onDirtyChange={onDirtyChange} /> : null}
          {tab === "affichage" ? <AffichageTab /> : null}
          {tab === "securite" ? <SecuriteTab /> : null}
        </div>
      </div>
    </div>
  );
}
