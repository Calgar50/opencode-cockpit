// État global : données d'amorçage, projet courant, thème, mode d'affichage (Simple / Avancé).
import { createContext, type ReactNode, useCallback, useContext, useEffect, useMemo, useState } from "react";
import { api } from "../lib/api.ts";
import type { Bootstrap, Category, ModelInfo, ProjectInfo, Settings, UiSettings } from "../lib/types.ts";

export type ThemeChoice = "system" | "light" | "dark";

interface AppState {
  boot: Bootstrap;
  /** Recharge complètement les données d'amorçage. */
  refresh: () => Promise<void>;
  /** Modifie localement les données d'amorçage (mise à jour par événement). */
  patchBoot: (updater: (boot: Bootstrap) => Bootstrap) => void;
  project: ProjectInfo | null;
  directory: string;
  setDirectory: (directory: string) => void;
  theme: ThemeChoice;
  setTheme: (theme: ThemeChoice) => void;
  dark: boolean;
  categories: Category[];
  categoryById: (id: string | null | undefined) => Category | undefined;
  modelByKey: (key: string | null | undefined) => ModelInfo | undefined;
  /** Réglages d'affichage (mode, règles acceptées, notice vue). */
  ui: UiSettings;
  /** true en mode Avancé. */
  advanced: boolean;
  /** Reporte des paramètres enregistrés dans l'amorçage (settings, ui, ai). */
  applySettings: (settings: Settings) => void;
  /** Enregistre une partie de `ui` puis met l'amorçage à jour ; lève l'erreur de l'API en cas d'échec. */
  saveUi: (patch: Partial<UiSettings>) => Promise<Settings>;
}

const DEFAULT_UI: UiSettings = Object.freeze({ mode: "simple", rulesAcceptedVersion: 0, noticeSeen: null });

/** Copie les sections 0.2.0 des paramètres dans les champs dérivés de l'amorçage. */
export function withSettings(boot: Bootstrap, settings: Settings): Bootstrap {
  return {
    ...boot,
    settings,
    ui: settings.ui ?? boot.ui,
    ai: boot.ai
      ? { ...boot.ai, chatDefaultTier: settings.ai?.chatDefaultTier ?? boot.ai.chatDefaultTier, allowModelOverride: settings.ai?.allowModelOverride ?? boot.ai.allowModelOverride }
      : boot.ai,
  };
}

const AppContext = createContext<AppState | null>(null);

function readStorage(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeStorage(key: string, value: string): void {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    // Stockage indisponible (navigation privée) : préférence non mémorisée.
  }
}

export function AppProvider({
  boot: initialBoot,
  refresh,
  children,
}: {
  boot: Bootstrap;
  refresh: () => Promise<void>;
  children: ReactNode;
}) {
  const [boot, setBoot] = useState(initialBoot);
  useEffect(() => setBoot(initialBoot), [initialBoot]);

  const [theme, setThemeState] = useState<ThemeChoice>(() => {
    const stored = readStorage("cockpit-theme");
    return stored === "light" || stored === "dark" ? stored : "system";
  });
  const [systemDark, setSystemDark] = useState(() => window.matchMedia("(prefers-color-scheme: dark)").matches);

  useEffect(() => {
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const onChange = () => setSystemDark(media.matches);
    media.addEventListener("change", onChange);
    return () => media.removeEventListener("change", onChange);
  }, []);

  useEffect(() => {
    if (theme === "system") delete document.documentElement.dataset.theme;
    else document.documentElement.dataset.theme = theme;
  }, [theme]);

  const setTheme = useCallback((next: ThemeChoice) => {
    setThemeState(next);
    writeStorage("cockpit-theme", next);
  }, []);

  const [directory, setDirectoryState] = useState<string>(() => {
    const stored = readStorage("cockpit-directory");
    const known = initialBoot.projects.map((p) => p.directory);
    if (stored && known.includes(stored)) return stored;
    const preferred = initialBoot.settings.chat.defaultDirectory;
    if (preferred && known.includes(preferred)) return preferred;
    return initialBoot.projects.find((p) => !p.isRoot)?.directory ?? initialBoot.workspace.root;
  });

  const setDirectory = useCallback((next: string) => {
    setDirectoryState(next);
    writeStorage("cockpit-directory", next);
  }, []);

  const applySettings = useCallback((settings: Settings) => setBoot((current) => withSettings(current, settings)), []);

  const saveUi = useCallback(
    async (patch: Partial<UiSettings>) => {
      const saved = await api.saveSettings({ ui: patch });
      applySettings(saved);
      return saved;
    },
    [applySettings],
  );

  const value = useMemo<AppState>(() => {
    const categories = boot.settings.classifier.categories;
    const categoryMap = new Map(categories.map((c) => [c.id, c]));
    const modelMap = new Map(boot.models.map((m) => [m.key, m]));
    // Serveur antérieur à 0.2.0 (amorçage sans « ui ») : valeurs sûres par défaut.
    const ui = boot.ui ?? boot.settings.ui ?? DEFAULT_UI;
    return {
      boot,
      refresh,
      patchBoot: (updater) => setBoot((current) => updater(current)),
      project: boot.projects.find((p) => p.directory === directory) ?? null,
      directory,
      setDirectory,
      theme,
      setTheme,
      dark: theme === "dark" || (theme === "system" && systemDark),
      categories,
      categoryById: (id) => (id ? categoryMap.get(id) : undefined),
      modelByKey: (key) => (key ? modelMap.get(key) : undefined),
      ui,
      advanced: ui.mode === "avance",
      applySettings,
      saveUi,
    };
  }, [boot, refresh, directory, setDirectory, theme, setTheme, systemDark, applySettings, saveUi]);

  return <AppContext.Provider value={value}>{children}</AppContext.Provider>;
}

export function useApp(): AppState {
  const ctx = useContext(AppContext);
  if (!ctx) throw new Error("AppProvider manquant");
  return ctx;
}
