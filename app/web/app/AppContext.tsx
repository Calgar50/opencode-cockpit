// État global : données d'amorçage, projet courant, thème.
import { createContext, type ReactNode, useCallback, useContext, useEffect, useMemo, useState } from "react";
import type { Bootstrap, Category, ModelInfo, ProjectInfo } from "../lib/types.ts";

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

  const value = useMemo<AppState>(() => {
    const categories = boot.settings.classifier.categories;
    const categoryMap = new Map(categories.map((c) => [c.id, c]));
    const modelMap = new Map(boot.models.map((m) => [m.key, m]));
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
    };
  }, [boot, refresh, directory, setDirectory, theme, setTheme, systemDark]);

  return <AppContext.Provider value={value}>{children}</AppContext.Provider>;
}

export function useApp(): AppState {
  const ctx = useContext(AppContext);
  if (!ctx) throw new Error("AppProvider manquant");
  return ctx;
}
