// Rendu Markdown sûr : marked → DOMPurify (liste blanche) → coloration highlight.js.
import DOMPurify from "dompurify";
import hljs from "highlight.js/lib/core";
import bash from "highlight.js/lib/languages/bash";
import csharp from "highlight.js/lib/languages/csharp";
import css from "highlight.js/lib/languages/css";
import diff from "highlight.js/lib/languages/diff";
import dockerfile from "highlight.js/lib/languages/dockerfile";
import go from "highlight.js/lib/languages/go";
import ini from "highlight.js/lib/languages/ini";
import java from "highlight.js/lib/languages/java";
import javascript from "highlight.js/lib/languages/javascript";
import json from "highlight.js/lib/languages/json";
import kotlin from "highlight.js/lib/languages/kotlin";
import markdown from "highlight.js/lib/languages/markdown";
import php from "highlight.js/lib/languages/php";
import plaintext from "highlight.js/lib/languages/plaintext";
import powershell from "highlight.js/lib/languages/powershell";
import python from "highlight.js/lib/languages/python";
import rust from "highlight.js/lib/languages/rust";
import sql from "highlight.js/lib/languages/sql";
import typescript from "highlight.js/lib/languages/typescript";
import xml from "highlight.js/lib/languages/xml";
import yaml from "highlight.js/lib/languages/yaml";
import { Marked } from "marked";
import { memo, useEffect, useMemo, useRef } from "react";

const LANGUAGES = {
  bash, csharp, css, diff, dockerfile, go, ini, java, javascript, json, kotlin, markdown, php, plaintext,
  powershell, python, rust, sql, typescript, xml, yaml,
};
for (const [name, language] of Object.entries(LANGUAGES)) hljs.registerLanguage(name, language);
hljs.registerAliases(["ps1", "pwsh"], { languageName: "powershell" });
hljs.registerAliases(["sh", "shell", "zsh", "console"], { languageName: "bash" });
hljs.registerAliases(["cs", "c#"], { languageName: "csharp" });
hljs.registerAliases(["yml"], { languageName: "yaml" });
hljs.registerAliases(["html", "xaml", "svg"], { languageName: "xml" });
hljs.registerAliases(["jsonc"], { languageName: "json" });
hljs.registerAliases(["text", "txt"], { languageName: "plaintext" });

export function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

export function highlightCode(code: string, lang?: string): string {
  const language = lang && hljs.getLanguage(lang) ? lang : undefined;
  if (!language) return escapeHtml(code);
  try {
    return hljs.highlight(code, { language, ignoreIllegals: true }).value;
  } catch {
    return escapeHtml(code);
  }
}

const marked = new Marked({
  gfm: true,
  breaks: false,
  renderer: {
    code({ text, lang }) {
      const language = (lang ?? "").trim().split(/\s+/)[0] ?? "";
      return `<pre class="code-block"><div class="code-head"><span>${escapeHtml(language)}</span></div><code class="hljs">${highlightCode(text, language)}</code></pre>`;
    },
  },
});

DOMPurify.addHook("afterSanitizeAttributes", (node) => {
  if (node.tagName === "A") {
    node.setAttribute("target", "_blank");
    node.setAttribute("rel", "noopener noreferrer");
  }
});

export function renderMarkdown(source: string): string {
  const html = marked.parse(source, { async: false });
  return DOMPurify.sanitize(html, {
    USE_PROFILES: { html: true },
    FORBID_TAGS: ["style", "form", "input", "button", "textarea", "select", "iframe", "object", "embed"],
    FORBID_ATTR: ["style"],
  });
}

function MarkdownImpl({ text, className }: { text: string; className?: string }) {
  const container = useRef<HTMLDivElement>(null);
  const html = useMemo(() => renderMarkdown(text), [text]);

  // Boutons « Copier » ajoutés par le DOM (jamais par du HTML injecté).
  useEffect(() => {
    const root = container.current;
    if (!root) return;
    for (const pre of root.querySelectorAll<HTMLPreElement>("pre.code-block")) {
      const head = pre.querySelector(".code-head");
      if (!head || head.querySelector(".copy-btn")) continue;
      const button = document.createElement("button");
      button.type = "button";
      button.className = "copy-btn";
      button.textContent = "Copier";
      button.addEventListener("click", () => {
        const code = pre.querySelector("code")?.textContent ?? "";
        void navigator.clipboard?.writeText(code).then(() => {
          button.textContent = "Copié";
          window.setTimeout(() => {
            button.textContent = "Copier";
          }, 1_500);
        });
      });
      head.appendChild(button);
    }
  }, [html]);

  return <div ref={container} className={`md${className ? ` ${className}` : ""}`} dangerouslySetInnerHTML={{ __html: html }} />;
}

export const Markdown = memo(MarkdownImpl);
