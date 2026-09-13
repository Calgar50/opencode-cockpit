import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

/** true si `target` est `root` ou se trouve dessous (comparaison lexicale après résolution). */
export function isInside(root: string, target: string): boolean {
  const rel = path.relative(path.resolve(root), path.resolve(target));
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

export class PathError extends Error {
  override name = "PathError";
}

/**
 * Vérifie que `target` reste dans `root`, liens symboliques compris :
 * on résout le plus proche ancêtre existant avec realpath.
 */
export async function assertInside(root: string, target: string): Promise<string> {
  const resolved = path.resolve(target);
  if (!isInside(root, resolved)) throw new PathError("Chemin hors du dossier autorisé.");
  const realRoot = await fs.realpath(root).catch(() => path.resolve(root));
  let probe = resolved;
  for (;;) {
    try {
      const real = await fs.realpath(probe);
      if (!isInside(realRoot, real)) throw new PathError("Chemin hors du dossier autorisé (lien symbolique).");
      return resolved;
    } catch (err) {
      if (err instanceof PathError) throw err;
      const parent = path.dirname(probe);
      if (parent === probe) return resolved;
      probe = parent;
    }
  }
}

/** Écriture atomique : fichier temporaire voisin puis renommage. */
export async function writeFileAtomic(file: string, content: string): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${crypto.randomBytes(6).toString("hex")}.tmp`;
  try {
    await fs.writeFile(tmp, content, { encoding: "utf8", mode: 0o644 });
    await fs.rename(tmp, file);
  } catch (err) {
    await fs.rm(tmp, { force: true });
    throw err;
  }
}

export async function readIfExists(file: string): Promise<string | null> {
  try {
    return await fs.readFile(file, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}

export async function exists(file: string): Promise<boolean> {
  try {
    await fs.access(file);
    return true;
  } catch {
    return false;
  }
}

/** Segment de nom de fichier sûr sous Windows comme sous Linux. */
export function safeSegment(input: string, max = 60): string {
  const cleaned = input
    .replace(/[<>:"/\\|?*\u0000-\u001F]/g, "-")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[. ]+$/, "");
  const reserved = /^(con|prn|aux|nul|com\d|lpt\d)$/i;
  const base = cleaned.slice(0, max) || "sans-titre";
  return reserved.test(base) ? `_${base}` : base;
}

export function slugify(input: string, max = 60): string {
  return (
    input
      .normalize("NFD")
      .replace(/\p{Diacritic}/gu, "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, max)
      .replace(/-+$/g, "") || "conversation"
  );
}
