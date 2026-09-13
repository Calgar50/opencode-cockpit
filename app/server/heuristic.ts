// Classement gratuit et instantané, par mots-clés et par usage des outils.
import type { Category } from "./settings.ts";

export interface DigestSignals {
  title: string;
  prompts: string[];
  answers: string[];
  tools: Record<string, number>;
  files: string[];
  commands: string[];
}

export interface ClassificationResult {
  category: string;
  tags: string[];
  summary: string;
  confidence: number;
  by: "heuristic" | "llm";
  /** Titre proposé par le modèle (utilisé seulement si opencode n'a laissé qu'un titre générique). */
  title?: string;
}

export const normalize = (s: string): string =>
  s.normalize("NFD").replace(/\p{Diacritic}/gu, "").toLowerCase();

const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

function countKeyword(text: string, keyword: string): number {
  const kw = normalize(keyword).trim();
  if (!kw) return 0;
  const re = new RegExp(`(^|[^a-z0-9])${escapeRegExp(kw)}(?=$|[^a-z0-9])`, "g");
  return Math.min(text.match(re)?.length ?? 0, 5);
}

const LANGUAGES: Record<string, string> = {
  ts: "typescript", tsx: "react", js: "javascript", jsx: "react", py: "python", cs: "csharp", java: "java",
  kt: "kotlin", go: "go", rs: "rust", sql: "sql", ps1: "powershell", sh: "bash", php: "php", rb: "ruby",
  vue: "vue", svelte: "svelte", html: "html", css: "css", scss: "css", yml: "yaml", yaml: "yaml",
  tf: "terraform", dart: "dart", swift: "swift", cpp: "cpp", c: "c", xaml: "xaml", razor: "blazor",
};

const TEST_COMMAND = /\b(npm (run )?test|pnpm test|yarn test|vitest|jest|pytest|dotnet test|go test|mvn test|gradle(w)? test|cargo test|phpunit|playwright test)\b/;

export function classifyHeuristic(signals: DigestSignals, categories: Category[]): ClassificationResult {
  const promptText = normalize([signals.title, ...signals.prompts].join("\n"));
  const answerText = normalize(signals.answers.slice(0, 4).join("\n"));
  const scores = new Map<string, number>();
  const hits = new Map<string, number>();
  const add = (id: string, value: number) => scores.set(id, (scores.get(id) ?? 0) + value);

  for (const cat of categories) {
    for (const keyword of cat.keywords) {
      const inPrompts = countKeyword(promptText, keyword);
      const inAnswers = countKeyword(answerText, keyword);
      if (inPrompts + inAnswers > 0) {
        add(cat.id, inPrompts * 2 + inAnswers * 0.5);
        hits.set(normalize(keyword), (hits.get(normalize(keyword)) ?? 0) + inPrompts + inAnswers);
      }
    }
  }

  const known = new Set(categories.map((c) => c.id));
  const bonus = (id: string, value: number) => {
    if (known.has(id)) add(id, value);
  };
  const t = signals.tools;
  const edits = (t.edit ?? 0) + (t.write ?? 0) + (t.patch ?? 0) + (t.apply_patch ?? 0) + (t.multiedit ?? 0);
  const files = signals.files.map((f) => f.toLowerCase());
  if (edits === 0) {
    bonus("question", 1.5);
    bonus("exploration", 0.5);
  } else {
    bonus("feature", 1);
    bonus("debug", 0.5);
    bonus("refactor", 0.5);
  }
  if (signals.commands.some((c) => TEST_COMMAND.test(c.toLowerCase())) || files.some((f) => /(\.|_)(test|spec)\.|tests?\//.test(f))) {
    bonus("tests", 2.5);
  }
  if (files.some((f) => f.endsWith(".sql"))) bonus("data", 2.5);
  if (files.some((f) => /(^|\/)(dockerfile|docker-compose[^/]*|\.github\/workflows\/|helm\/|k8s\/|azure-pipelines)/.test(f))) bonus("devops", 2.5);
  if (edits > 0 && files.length > 0 && files.every((f) => /\.(md|mdx|rst|txt|adoc)$/.test(f))) bonus("docs", 3);

  let best = "other";
  let bestScore = 0;
  let total = 0;
  for (const [id, score] of scores) {
    total += score;
    if (score > bestScore) {
      best = id;
      bestScore = score;
    }
  }
  if (bestScore < 1.5 || !known.has(best)) best = known.has("other") ? "other" : (categories[0]?.id ?? "other");

  const languageTags = new Set<string>();
  for (const f of files) {
    const ext = f.split(".").pop() ?? "";
    const lang = LANGUAGES[ext];
    if (lang) languageTags.add(lang);
  }
  const keywordTags = [...hits.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([k]) => k)
    .filter((k) => k.length <= 24);
  const tags = [...new Set([...languageTags, ...keywordTags])].slice(0, 6);

  const firstPrompt = (signals.prompts[0] ?? signals.title).replace(/\s+/g, " ").trim();
  return {
    category: best,
    tags,
    summary: firstPrompt.length > 220 ? `${firstPrompt.slice(0, 217)}…` : firstPrompt,
    confidence: bestScore > 0 ? Math.round((bestScore / (total + 1)) * 100) / 100 : 0,
    by: "heuristic",
  };
}
