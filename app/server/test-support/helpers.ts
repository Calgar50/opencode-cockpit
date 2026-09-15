// Aides des tests qui pilotent le faux opencode ou le cockpit (déplacées de fake-opencode.test.ts) : attentes bornées, abonnement
// au flux, traces lisibles, envois et outils scriptés, écoute sur un port accepté par fetch, diff de lignes.
import assert from "node:assert/strict";
import net, { type AddressInfo } from "node:net";
import path from "node:path";
import type { TestContext } from "node:test";
import { isFetchBlockedPort } from "../fetch-ports.ts";
import type { OcEvent, OcGlobalEvent, OpencodeClient } from "../opencode.ts";
import type { FakeToolScript, SyncPayload } from "./fake-opencode.ts";

/** Attend qu'une lecture renvoie une valeur (sondage toutes les 5 ms). */
export async function until<T>(read: () => T | undefined | null | false, timeoutMs = 3000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = read();
    if (value !== undefined && value !== null && value !== false) return value;
    if (Date.now() > deadline) throw new Error("condition non atteinte à temps");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

/** Promesse `label` tenue en `timeoutMs` au plus : une attente jamais résolue fait échouer le test (message nommé) au lieu de le bloquer. */
export async function within<T>(promise: Promise<T>, label: string, timeoutMs = 3000): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const late = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} : promesse non tenue en ${timeoutMs} ms`)), timeoutMs);
  });
  try {
    return await Promise.race([promise, late]);
  } finally {
    clearTimeout(timer);
  }
}

/** Abonnement du cockpit (subscribeGlobal) : blocs reçus, dans l'ordre. */
export async function subscribe(t: TestContext, oc: OpencodeClient): Promise<OcGlobalEvent[]> {
  const events: OcGlobalEvent[] = [];
  let connected = false;
  const stop = oc.subscribeGlobal(
    (event) => events.push(event),
    (status) => {
      if (status === "connected") connected = true;
    },
  );
  t.after(stop);
  await until(() => connected && events.some((e) => e.payload.type === "server.connected"));
  return events;
}

/** Propriétés d'un bloc (vide pour un jumeau « sync »). */
export const props = (event: { payload: OcEvent | SyncPayload }): Record<string, unknown> => ("properties" in event.payload ? event.payload.properties ?? {} : {});

export async function promptAsync(oc: OpencodeClient, sessionID: string, text: string, extra: Record<string, unknown> = {}): Promise<number> {
  const res = await oc.raw("POST", oc.url(`/session/${sessionID}/prompt_async`), {
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ agent: "build", parts: [{ type: "text", text }], ...extra }),
  });
  await res.arrayBuffer();
  return res.status;
}

export const bash = (command: string, extra: Partial<FakeToolScript> = {}): FakeToolScript => ({
  tool: "bash",
  input: { command, description: `Lancer ${command}` },
  ask: { permission: "bash", patterns: [command], metadata: { command }, always: [`${command.split(" ")[0]} *`] },
  output: "ok",
  ...extra,
});

/** Trace lisible « type:détail@nom » des sessions nommées (jumeaux, deltas et événements serveur ignorés). */
export function trace(events: ReadonlyArray<{ payload: OcEvent | SyncPayload }>, names: Record<string, string>): string[] {
  const out: string[] = [];
  for (const event of events) {
    const p = props(event);
    const who = typeof p.sessionID === "string" ? names[p.sessionID] : undefined;
    if (!who || event.payload.type === "message.part.delta") continue;
    let detail = "";
    if (event.payload.type === "session.status") detail = `:${(p.status as { type: string }).type}`;
    if (event.payload.type === "session.error") detail = `:${(p.error as { name: string }).name}`;
    if (event.payload.type === "permission.replied") detail = `:${String(p.reply)}`;
    if (event.payload.type === "message.updated") {
      const info = p.info as { role: string; error?: { name: string }; time: { completed?: number }; finish?: string };
      detail = `:${info.role}${info.error ? `:${info.error.name}` : info.time.completed ? `:${info.finish}` : ""}`;
    }
    if (event.payload.type === "message.part.updated") {
      const part = p.part as { type: string; state?: { status: string } };
      detail = `:${part.type}${part.state ? `:${part.state.status}` : ""}`;
    }
    out.push(`${event.payload.type}${detail}@${who}`);
  }
  return out;
}

export function assertSubsequence(actual: string[], expected: string[]): void {
  let found = 0;
  for (const item of actual) if (item === expected[found]) found++;
  assert.equal(found, expected.length, `attendu ensuite : ${expected[found]}\ntrace : ${actual.join(", ")}`);
}

const listenOn = (server: net.Server, port: number, host: string): Promise<void> =>
  new Promise((resolve, reject) => {
    const onError = (err: Error) => {
      server.off("listening", onListening);
      reject(err);
    };
    const onListening = () => {
      server.off("error", onError);
      resolve();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(port, host);
  });

const closeServer = (server: net.Server): Promise<void> => new Promise((resolve) => server.close(() => resolve()));

/**
 * Écoute `server` sur un port rendu par le système que fetch accepte, et le renvoie. Un port refusé (FETCH_BLOCKED_PORTS) est libéré
 * puis tenu par un bouche-trou, pour que le système en rende un autre ; bouche-trous libérés à la fin. Au-delà de `maxAttempts`
 * essais : erreur explicite plutôt qu'une boucle sans fin.
 */
export async function listenFetchable(server: net.Server, host: string, maxAttempts = 32): Promise<number> {
  const held: net.Server[] = [];
  try {
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      await listenOn(server, 0, host);
      const { port } = server.address() as AddressInfo;
      if (!isFetchBlockedPort(port)) return port;
      await closeServer(server);
      const placeholder = net.createServer();
      // Port repris ailleurs entre la fermeture et le bouche-trou : le système ne le rend pas non plus tant qu'il est tenu.
      if (await listenOn(placeholder, port, host).then(() => true, () => false)) held.push(placeholder);
    }
    throw new Error(`aucun port accepté par fetch en ${maxAttempts} essais`);
  } finally {
    await Promise.all(held.map(closeServer));
  }
}

export type LineOp = { op: " " | "-" | "+"; line: string };

/** Lignes d'un texte ; le saut de ligne final ne crée pas de ligne vide. */
export const splitLines = (text: string): string[] => (text === "" ? [] : text.replace(/\n$/, "").split("\n"));

/**
 * Diff de lignes par plus longue sous-suite commune (textes de test : quelques centaines de lignes). Au-delà de 4 millions de
 * cellules : tout retiré puis tout ajouté, jamais un calcul sans borne.
 */
export function lineDiff(before: string, after: string): LineOp[] {
  const a = splitLines(before);
  const b = splitLines(after);
  if (a.length * b.length > 4_000_000) return [...a.map((line): LineOp => ({ op: "-", line })), ...b.map((line): LineOp => ({ op: "+", line }))];
  const lcs = Array.from({ length: a.length + 1 }, () => new Uint32Array(b.length + 1));
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      const row = lcs[i] as Uint32Array;
      row[j] = a[i] === b[j] ? (lcs[i + 1] as Uint32Array)[j + 1]! + 1 : Math.max((lcs[i + 1] as Uint32Array)[j]!, row[j + 1]!);
    }
  }
  const ops: LineOp[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      ops.push({ op: " ", line: a[i] as string });
      i++;
      j++;
    } else if ((lcs[i + 1] as Uint32Array)[j]! >= (lcs[i] as Uint32Array)[j + 1]!) ops.push({ op: "-", line: a[i++] as string });
    else ops.push({ op: "+", line: b[j++] as string });
  }
  while (i < a.length) ops.push({ op: "-", line: a[i++] as string });
  while (j < b.length) ops.push({ op: "+", line: b[j++] as string });
  return ops;
}

/** Changement d'un apply_patch : ajout, mise à jour (déplacement facultatif) ou suppression, chemins relatifs au dossier. */
export type PatchChange =
  | { type: "add"; path: string; content: string }
  | { type: "update"; path: string; from: string; to: string; movePath?: string }
  | { type: "delete"; path: string };

/** Texte d'entrée de l'outil apply_patch (grammaire « *** Begin Patch », tool/apply_patch.txt d'opencode 1.18.30). */
export function applyPatchText(changes: PatchChange[]): string {
  const lines = ["*** Begin Patch"];
  for (const change of changes) {
    if (change.type === "add") {
      lines.push(`*** Add File: ${change.path}`, ...splitLines(change.content).map((line) => `+${line}`));
    } else if (change.type === "delete") {
      lines.push(`*** Delete File: ${change.path}`);
    } else {
      lines.push(`*** Update File: ${change.path}`);
      if (change.movePath) lines.push(`*** Move to: ${change.movePath}`);
      lines.push("@@", ...lineDiff(change.from, change.to).map(({ op, line }) => `${op}${line}`));
    }
  }
  lines.push("*** End Patch");
  return lines.join("\n");
}

/** Motif d'une demande de modification : chemin relatif au dossier de la session (tool/edit.ts:104). */
const editPattern = (filePath: string, directory: string): string =>
  path.posix.isAbsolute(filePath) ? path.posix.relative(directory, filePath) : path.posix.normalize(filePath);

/** Outil « edit » demandé ; métadonnées (filepath, diff) complétées par le faux. `directory` : dossier de la session. */
export const editTool = (filePath: string, oldString: string, newString: string, options: { directory?: string } & Partial<FakeToolScript> = {}): FakeToolScript => {
  const { directory = "/workspace", ...extra } = options;
  return {
    tool: "edit",
    input: { filePath, oldString, newString },
    ask: { permission: "edit", patterns: [editPattern(filePath, directory)], always: ["*"] },
    output: "Edit applied successfully.",
    ...extra,
  };
};

/** Outil « write » demandé ; métadonnées (filepath, diff) complétées par le faux. */
export const writeTool = (filePath: string, content: string, options: { directory?: string } & Partial<FakeToolScript> = {}): FakeToolScript => {
  const { directory = "/workspace", ...extra } = options;
  return {
    tool: "write",
    input: { filePath, content },
    ask: { permission: "edit", patterns: [editPattern(filePath, directory)], always: ["*"] },
    output: "Wrote file successfully.",
    ...extra,
  };
};

/** Outil « apply_patch » demandé ; métadonnées (filepath, diff, files[]) complétées par le faux (tool/apply_patch.ts:205-215). */
export const applyPatchTool = (changes: PatchChange[], options: { directory?: string } & Partial<FakeToolScript> = {}): FakeToolScript => {
  const { directory = "/workspace", ...extra } = options;
  return {
    tool: "apply_patch",
    input: { patchText: applyPatchText(changes) },
    ask: { permission: "edit", patterns: changes.map((change) => editPattern(change.path, directory)), always: ["*"] },
    output: "Success.",
    ...extra,
  };
};
