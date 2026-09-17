// Propriétaire : L3.
// Plancher de conversation (spécification §3.4, §3.9, §3.14 l.441, D5, D-04) : empreinte SHA-256, crochets createSession,
// sessionCreated et beforeBilledSend, ports verified et createWithFloor.
// - Création par le proxy (POST /api/oc/session) : le corps du client reste limité au titre (forbiddenProxyBody, avant les
//   crochets) ; le plancher CONVERSATION y est ajouté par le serveur, puis l'écho d'opencode est vérifié. Écart : DELETE de la
//   conversation créée et 502 plancher-non-verifie.
// - Envoi facturé (prompt_async, command, summarize) : marque enregistrée et à jour (sessions.plancher), sinon PATCH du plancher
//   puis vérification de l'écho AVANT de relayer ; écart ou échec : 502, rien n'est envoyé. Une conversation existante n'est jamais
//   supprimée pour un écart : son historique reste, seul l'envoi est refusé (la vérification est refaite au prochain envoi).
// - ports.floors.createWithFloor (plans L6b, contrôle L11b) : même vérification ; écart : DELETE et FloorNotVerifiedError.
// Mesures MX1 (M16, M3), appliquées : posé dès POST /session, le plancher ne change ni le titre généré ni les messages, et l'écho
// est identique à l'octet pour POST et PATCH ; rien n'est donc reporté après la génération du titre. CONVERSATION refuse la lecture
// des fichiers de clés sans retirer l'outil read ; sous ETAPE, les outils de ressources MCP restent visibles, refusés à l'appel.
// neutralFloors reste exporté et inchangé : c'est le port des tests qui ne déclarent pas ce module (plan §2.2).
import { createHash } from "node:crypto";
import { type Cockpit11Module, type FloorSessionBody, type FloorsPort, PortUnavailableError, type ProxyContext } from "./contracts-11.ts";
import { errorMessage, type Logger } from "./log.ts";
import type { OcSession, OpencodeClient } from "./opencode.ts";
import type { ProjectsService } from "./projects.ts";
import type { SessionTracker } from "./sessions.ts";
import type { FloorKind } from "./shared/autonomy-types.ts";
import { type FloorRefusal, floorRefusalText } from "./shared/floor-texts.ts";
import { ID_RE } from "./shared/ids.ts";
import { buildFloor, canonicalRules, type FloorContext, floorHolds, floorMark, parseFloorMark } from "./shared/session-floors.ts";

export function neutralFloors(): FloorsPort {
  return {
    verified: async () => false,
    createWithFloor: async () => {
      throw new PortUnavailableError("floors");
    },
  };
}

/** Code d'erreur des refus du plancher (D-04). */
export const FLOOR_ERROR = "plancher-non-verifie";

/** Délai de chaque requête du plancher à opencode (création, PATCH, suppression), comme la session de classement. */
export const FLOOR_TIMEOUT_MS = 15_000;

/** Planchers que le service pose et repose seul : leur empreinte ne dépend que de la version du cockpit (ETAPE dépend de l'assistant). */
const SELF_CONTAINED: ReadonlySet<FloorKind> = new Set<FloorKind>(["CONVERSATION", "PLAN", "CONTROLE"]);

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

/** SHA-256 hexadécimal du texte canonique du plancher (§3.4). */
export function floorHash(kind: FloorKind, ctx?: FloorContext): string {
  return createHash("sha256").update(canonicalRules(buildFloor(kind, ctx)), "utf8").digest("hex");
}

/** createWithFloor : l'écho d'opencode ne tient pas le plancher ; la session créée est supprimée si possible. */
export class FloorNotVerifiedError extends Error {
  override name = "FloorNotVerifiedError";
  readonly code = FLOOR_ERROR;
  readonly sessionId: string | null;
  /** true : session supprimée ; false : suppression impossible (elle peut rester, sans marque de plancher). */
  readonly deleted: boolean;

  constructor(sessionId: string | null, deleted: boolean) {
    super("plancher de session non vérifié sur l'écho d'opencode");
    this.sessionId = sessionId;
    this.deleted = deleted;
  }
}

export interface SessionFloorDeps {
  client: OpencodeClient;
  sessions: SessionTracker;
  projects: ProjectsService;
  log: Logger;
}

type CreatedOutcome = { ok: true } | { ok: false; sessionId: string | null; deleted: boolean };

/** Plancher avant un envoi : tenu ; opencode n'a pas répondu au PATCH (« echec ») ; conversation qui ne le tient pas (« ecart »). */
type EnsureOutcome = "ok" | "echec" | "ecart";

const refusal = (kind: FloorRefusal): Response => Response.json({ error: FLOOR_ERROR, message: floorRefusalText(kind) }, { status: 502 });

export class SessionFloorService implements FloorsPort {
  readonly #d: SessionFloorDeps;
  readonly #hashes = new Map<FloorKind, string>();
  /** Pose en cours par session : deux envois simultanés sur une ancienne conversation ne font qu'un PATCH. */
  readonly #inflight = new Map<string, Promise<EnsureOutcome>>();

  constructor(deps: SessionFloorDeps) {
    this.#d = deps;
  }

  #hashOf(kind: FloorKind): string {
    let hash = this.#hashes.get(kind);
    if (hash === undefined) {
      hash = floorHash(kind);
      this.#hashes.set(kind, hash);
    }
    return hash;
  }

  /**
   * Plancher attendu d'après la marque enregistrée : aucune marque → CONVERSATION à poser ; marque d'un genre que le service sait
   * reconstruire → à jour ou périmée ; marque illisible ou ETAPE → null (rien n'est posé : refus).
   */
  #expected(mark: string | null | undefined): { kind: FloorKind; current: boolean } | null {
    if (mark === null || mark === undefined) return { kind: "CONVERSATION", current: false };
    const parsed = parseFloorMark(mark);
    if (parsed === null || !SELF_CONTAINED.has(parsed.kind)) return null;
    return { kind: parsed.kind, current: parsed.hash === this.#hashOf(parsed.kind) };
  }

  #verifiedNow(sessionId: string): boolean {
    return ID_RE.test(sessionId) && this.#expected(this.#d.sessions.get(sessionId)?.plancher ?? null)?.current === true;
  }

  /** Port : la session porte un plancher vérifié par ce cockpit et à jour (marque enregistrée, empreinte de cette version). */
  async verified(sessionId: string): Promise<boolean> {
    try {
      return this.#verifiedNow(sessionId);
    } catch (err) {
      this.#d.log.warn("marque de plancher illisible : session tenue pour non vérifiée", { sessionId, error: errorMessage(err) });
      return false;
    }
  }

  /** Session vérifiée : marque enregistrée (la session est d'abord suivie). Une erreur d'écriture n'annule pas le plancher posé. */
  #record(sessionId: string, kind: FloorKind, session: Record<string, unknown>): void {
    try {
      this.#d.sessions.upsert(session as unknown as OcSession);
      this.#d.sessions.setPlancher(sessionId, floorMark(kind, this.#hashOf(kind)));
    } catch (err) {
      this.#d.log.warn("plancher vérifié mais non enregistré : il sera reposé au prochain envoi", { sessionId, kind, error: errorMessage(err) });
    }
  }

  /** Écho de POST /session : vérifié et enregistré, sinon session supprimée (si son identifiant est lisible). */
  async #settleCreated(kind: FloorKind, session: unknown, directory: string | null): Promise<CreatedOutcome> {
    const id = isRecord(session) && typeof session.id === "string" && ID_RE.test(session.id) ? session.id : null;
    if (id !== null && isRecord(session) && floorHolds(session.permission, buildFloor(kind))) {
      this.#record(id, kind, session);
      return { ok: true };
    }
    this.#d.log.warn("plancher non vérifié sur une session créée : suppression", { sessionId: id, kind });
    if (id === null) return { ok: false, sessionId: null, deleted: false };
    const where = (isRecord(session) && typeof session.directory === "string" && session.directory) || directory || undefined;
    try {
      await this.#d.client.request("DELETE", `/session/${encodeURIComponent(id)}`, { ...(where ? { directory: where } : {}), timeoutMs: FLOOR_TIMEOUT_MS });
      return { ok: false, sessionId: id, deleted: true };
    } catch (err) {
      this.#d.log.warn("session sans plancher vérifié non supprimée : tout envoi y reste refusé", { sessionId: id, kind, error: errorMessage(err) });
      return { ok: false, sessionId: id, deleted: false };
    }
  }

  /** Crochet createSession : le plancher CONVERSATION complète le corps (déjà limité au titre par le proxy) ; il a le dernier mot. */
  async onCreateSession(ctx: ProxyContext): Promise<Response | null> {
    ctx.body.permission = buildFloor("CONVERSATION");
    return null;
  }

  /** Crochet sessionCreated : écho vérifié ; écart → DELETE et 502. */
  async onSessionCreated(ctx: ProxyContext, session: unknown): Promise<Response | null> {
    const outcome = await this.#settleCreated("CONVERSATION", session, ctx.directory);
    if (outcome.ok) return null;
    return refusal(outcome.deleted ? "creation" : "creation-restee");
  }

  /** Crochet beforeBilledSend : plancher à jour, sinon PATCH et vérification ; sinon 502 sans rien relayer. */
  async beforeBilledSend(ctx: ProxyContext): Promise<Response | null> {
    const sessionId = ctx.sessionId;
    if (sessionId === null || !ID_RE.test(sessionId)) {
      this.#d.log.warn("envoi facturé sans session lisible : refusé par le plancher", { sub: ctx.sub.slice(0, 200) });
      return refusal("envoi-ecart");
    }
    const outcome = await this.#ensure(sessionId, ctx.directory);
    if (outcome === "ok") return null;
    return refusal(outcome === "ecart" ? "envoi-ecart" : "envoi");
  }

  #ensure(sessionId: string, directory: string | null): Promise<EnsureOutcome> {
    const pending = this.#inflight.get(sessionId);
    if (pending !== undefined) return pending;
    const run = this.#patch(sessionId, directory).finally(() => this.#inflight.delete(sessionId));
    this.#inflight.set(sessionId, run);
    return run;
  }

  /** Ancienne conversation (ou marque périmée) : PATCH du plancher attendu, écho vérifié, marque enregistrée. Ne lève jamais. */
  async #patch(sessionId: string, directory: string | null): Promise<EnsureOutcome> {
    let kind: FloorKind | null = null;
    try {
      const row = this.#d.sessions.get(sessionId);
      const expected = this.#expected(row?.plancher ?? null);
      if (expected === null) {
        this.#d.log.warn("marque de plancher illisible ou non reconstructible : envoi refusé", { sessionId });
        return "ecart";
      }
      if (expected.current) return "ok";
      kind = expected.kind;
      const floor = buildFloor(kind);
      const where = directory || row?.directory || undefined;
      let echo: unknown;
      try {
        echo = await this.#d.client.request<unknown>("PATCH", `/session/${encodeURIComponent(sessionId)}`, {
          ...(where ? { directory: where } : {}),
          body: { permission: floor },
          timeoutMs: FLOOR_TIMEOUT_MS,
        });
      } catch (err) {
        this.#d.log.warn("plancher non posé : envoi refusé", { sessionId, kind, error: errorMessage(err) });
        return "echec";
      }
      if (!isRecord(echo) || echo.id !== sessionId || !floorHolds(echo.permission, floor)) {
        this.#d.log.warn("plancher non vérifié après PATCH : envoi refusé, conversation gardée", { sessionId, kind });
        return "ecart";
      }
      this.#record(sessionId, kind, echo);
      return "ok";
    } catch (err) {
      this.#d.log.warn("vérification du plancher impossible : envoi refusé", { sessionId, kind, error: errorMessage(err) });
      return "echec";
    }
  }

  /**
   * Port : crée une session opencode avec un plancher vérifié (PLAN pour une conversation de plan, CONTROLE pour l'IA de contrôle,
   * CONVERSATION). ETAPE demande les règles de l'assistant (itération 4) : refusé. Le corps est reconstruit champ par champ : aucune
   * autre clé ne part, `permission` comprise. Écart : DELETE puis FloorNotVerifiedError (502 plancher-non-verifie pour la route).
   */
  async createWithFloor(kind: FloorKind, body: FloorSessionBody): Promise<OcSession> {
    if (!SELF_CONTAINED.has(kind)) throw new RangeError(`plancher ${kind} : non disponible par createWithFloor (règles de l'assistant requises)`);
    const { directory, title, parentID, metadata } = body;
    if (typeof directory !== "string" || !this.#d.projects.isAllowedDirectory(directory)) throw new RangeError("createWithFloor : dossier hors du workspace");
    if (title !== undefined && typeof title !== "string") throw new RangeError("createWithFloor : titre invalide");
    if (parentID !== undefined && (typeof parentID !== "string" || !ID_RE.test(parentID))) throw new RangeError("createWithFloor : session parente invalide");
    if (metadata !== undefined && !isRecord(metadata)) throw new RangeError("createWithFloor : metadata invalide");
    const request: Record<string, unknown> = {
      ...(title !== undefined ? { title } : {}),
      ...(parentID !== undefined ? { parentID } : {}),
      ...(metadata !== undefined ? { metadata } : {}),
      permission: buildFloor(kind),
    };
    const created = await this.#d.client.request<unknown>("POST", "/session", { directory, body: request, timeoutMs: FLOOR_TIMEOUT_MS });
    const outcome = await this.#settleCreated(kind, created, directory);
    if (!outcome.ok) throw new FloorNotVerifiedError(outcome.sessionId, outcome.deleted);
    return created as OcSession;
  }
}

export const floorsModule: Cockpit11Module = {
  name: "floors",
  install(reg, c11) {
    const service = new SessionFloorService({ client: c11.client, sessions: c11.sessions, projects: c11.projects, log: c11.log });
    c11.ports.floors = {
      verified: (sessionId) => service.verified(sessionId),
      createWithFloor: (kind, body) => service.createWithFloor(kind, body),
    };
    reg.hook("createSession", (ctx) => service.onCreateSession(ctx));
    reg.hook("sessionCreated", (ctx, session) => service.onSessionCreated(ctx, session));
    reg.hook("beforeBilledSend", (ctx) => service.beforeBilledSend(ctx));
  },
};
