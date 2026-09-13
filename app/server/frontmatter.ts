import { parse, stringify } from "yaml";

export interface FrontmatterDoc {
  data: Record<string, unknown>;
  body: string;
}

export class FrontmatterError extends Error {
  override name = "FrontmatterError";
}

const FENCE = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)([\s\S]*)$/;

/** Découpe un fichier Markdown `---yaml---corps`. Lève FrontmatterError si le YAML est invalide. */
export function parseFrontmatter(source: string): FrontmatterDoc {
  const text = source.replace(/^\uFEFF/, "");
  const match = FENCE.exec(text);
  if (!match) return { data: {}, body: text };
  let data: unknown;
  try {
    // maxAliasCount borne les « billion laughs » ; uniqueKeys refuse les clés en double.
    data = parse(match[1] ?? "", { maxAliasCount: 50, uniqueKeys: true, prettyErrors: true });
  } catch (err) {
    throw new FrontmatterError(`YAML invalide dans l'en-tête : ${(err as Error).message}`);
  }
  if (data === null || data === undefined) data = {};
  if (typeof data !== "object" || Array.isArray(data)) {
    throw new FrontmatterError("L'en-tête YAML doit être un objet (clé: valeur).");
  }
  return { data: data as Record<string, unknown>, body: match[2] ?? "" };
}

/** Recompose un fichier Markdown ; les clés `undefined` sont omises. */
export function stringifyFrontmatter(data: Record<string, unknown>, body: string): string {
  const clean = Object.fromEntries(Object.entries(data).filter(([, v]) => v !== undefined));
  const head = Object.keys(clean).length > 0 ? stringify(clean, { lineWidth: 0 }) : "";
  const normalizedBody = body.replace(/\r\n/g, "\n").replace(/^\n+/, "");
  const withNewline = normalizedBody.endsWith("\n") ? normalizedBody : `${normalizedBody}\n`;
  return `---\n${head}---\n\n${withNewline}`;
}
