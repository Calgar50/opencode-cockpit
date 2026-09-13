import { useState } from "react";

function lineClass(line: string): string {
  if (line.startsWith("@@")) return "hunk";
  if (line.startsWith("+++") || line.startsWith("---") || line.startsWith("diff ") || line.startsWith("index ")) return "meta";
  if (line.startsWith("+")) return "add";
  if (line.startsWith("-")) return "del";
  return "";
}

/** Affiche un diff unifié ; les lignes au-delà de `maxLines` sont dépliables. */
export function DiffView({ patch, maxLines = 300 }: { patch: string; maxLines?: number }) {
  const [expanded, setExpanded] = useState(false);
  const lines = patch.replace(/\n$/, "").split("\n");
  const visible = expanded ? lines : lines.slice(0, maxLines);
  return (
    <div className="stack tight">
      <div className="diff" role="region" aria-label="Différences">
        {visible.map((line, i) => (
          <span key={i} className={`diff-line ${lineClass(line)}`}>
            {line || " "}
          </span>
        ))}
      </div>
      {lines.length > maxLines ? (
        <button type="button" className="btn ghost sm" onClick={() => setExpanded((v) => !v)}>
          {expanded ? "Réduire" : `Afficher ${lines.length - maxLines} lignes de plus`}
        </button>
      ) : null}
    </div>
  );
}

export function countDiff(patch: string): { additions: number; deletions: number } {
  let additions = 0;
  let deletions = 0;
  for (const line of patch.split("\n")) {
    if (line.startsWith("+") && !line.startsWith("+++")) additions++;
    else if (line.startsWith("-") && !line.startsWith("---")) deletions++;
  }
  return { additions, deletions };
}
