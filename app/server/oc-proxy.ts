// Propriétaire : L18b.
// Proxy filtré vers UNE instance opencode (spécification §3.8 l.325, §3.9 l.331, §3.10 l.358, P11 ; plan 2 bis, fiche L18b) :
// liste blanche explicite, filtres de corps, portillon des accords, crochets 1.1 et compteur des demandes facturées. La
// fermeture vient de http.ts (1.0.x) sans changer de comportement : createApp monte /api/oc/* sur l'instance principale.
// Tout ce qui dépend de l'instance (client, portillon, catalogue, compteur facturé, dossiers permis) arrive par InstanceDeps :
// un second montage sert la Salle OMO sans que les deux se croisent.
import { randomUUID } from "node:crypto";
import type { Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { z } from "zod";
import type { BillRefusal } from "./config-queue.ts";
import type { EmittedReply, ProxyContext } from "./contracts-11.ts";
import type { AppEnv } from "./env.ts";
import { errorMessage, type Logger } from "./log.ts";
import type { InstanceDeps } from "./omo-contracts.ts";
import type { ProjectsService } from "./projects.ts";
import type { SessionInstance } from "./shared/activity-types.ts";
import { MESSAGES, type UiMode } from "./shared/assistant-rules.ts";
import { ID } from "./shared/ids.ts";
import type { Cockpit11Wiring } from "./wiring-11.ts";

/** Crochets du proxy /api/oc/* : listes par étape et exécution dans l'ordre (la première Response l'emporte). */
export type ProxyHooks = Pick<Cockpit11Wiring, "hooks" | "runHooks">;

/** Corps d'un refus du proxy : même forme que celle de createApp (error, message, puis détails). */
const fail = (c: Context, status: number, error: string, message: string, extra: Record<string, unknown> = {}) =>
  c.json({ error, message, ...extra }, status as ContentfulStatusCode);

/** Objet JSON simple (ni tableau, ni null) : corps relayés et réponses lues. */
export function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

// --- Proxy opencode : liste blanche explicite ------------------------------------------

export interface ProxyRule {
  method: string;
  pattern: RegExp;
  /** Requête qui déclenche un appel de modèle : soumise au garde-fou budgétaire. */
  guarded?: boolean;
}

const rule = (method: string, route: string, guarded = false): ProxyRule => ({
  method,
  pattern: new RegExp(`^${route}$`),
  guarded,
});

/**
 * Moindre privilège : uniquement les routes dont l'interface a besoin. Exclues notamment :
 * exécution shell directe sans permission (/session/:id/shell), lecture de fichiers arbitraires (/file*),
 * partage public (/share), mise à jour (/global/upgrade), injection d'identifiants (PUT /auth), terminal (/pty).
 */
export const PROXY_RULES: ProxyRule[] = [
  rule("GET", "/provider/auth"),
  // Connexion limitée à GitHub Copilot : l'interface ne propose aucun autre fournisseur.
  rule("POST", "/provider/github-copilot/oauth/authorize"),
  rule("POST", "/provider/github-copilot/oauth/callback"),
  rule("DELETE", "/auth/github-copilot"),
  rule("GET", "/agent"),
  rule("GET", "/command"),
  rule("GET", "/session"),
  rule("POST", "/session"),
  rule("GET", "/session/status"),
  rule("GET", `/session/${ID}`),
  rule("PATCH", `/session/${ID}`),
  rule("DELETE", `/session/${ID}`),
  rule("GET", `/session/${ID}/children`),
  rule("GET", `/session/${ID}/todo`),
  rule("GET", `/session/${ID}/diff`),
  rule("GET", `/session/${ID}/message`),
  rule("POST", `/session/${ID}/prompt_async`, true),
  rule("POST", `/session/${ID}/command`, true),
  rule("POST", `/session/${ID}/summarize`, true),
  rule("POST", `/session/${ID}/abort`),
  rule("GET", "/permission"),
  rule("POST", `/permission/${ID}/reply`),
  rule("GET", "/question"),
  rule("POST", `/question/${ID}/reply`),
  rule("POST", `/question/${ID}/reject`),
  rule("GET", "/find/file"),
];

/**
 * Liste blanche de la Salle OMO (D-2b-04, fiche L18b) : celle de l'instance principale, moins ce que la salle n'ouvre jamais au
 * navigateur.
 * - `POST /session` : une racine de la salle naît seulement par `POST /api/omo/rooms` (L18c), après son pré-contrôle ;
 * - `GET /provider/auth`, les deux routes OAuth et `DELETE /auth/github-copilot` : la salle reçoit son authentification par le
 *   volume `omo-auth` (L17b), jamais par le navigateur, et les routes de fournisseur rendent les options en clair (MO-6) ;
 * - `POST /permission/:id/reply` : aucune réponse d'autorisation venue du navigateur n'entre dans la salle (D-2b-04) — c'est
 *   le répondeur du cockpit qui répond (L22d). Le proxy la refuse en 403 avant même cette liste, dans les DEUX modes.
 * Comparée à PROXY_RULES par oc-proxy-omo.test.ts : aucune route en plus, et exactement ces retraits.
 */
export const PROXY_RULES_OMO: ProxyRule[] = [
  rule("GET", "/agent"),
  rule("GET", "/command"),
  rule("GET", "/session"),
  rule("GET", "/session/status"),
  rule("GET", `/session/${ID}`),
  rule("PATCH", `/session/${ID}`),
  rule("DELETE", `/session/${ID}`),
  rule("GET", `/session/${ID}/children`),
  rule("GET", `/session/${ID}/todo`),
  rule("GET", `/session/${ID}/diff`),
  rule("GET", `/session/${ID}/message`),
  rule("POST", `/session/${ID}/prompt_async`, true),
  rule("POST", `/session/${ID}/command`, true),
  rule("POST", `/session/${ID}/summarize`, true),
  rule("POST", `/session/${ID}/abort`),
  rule("GET", "/permission"),
  rule("GET", "/question"),
  rule("POST", `/question/${ID}/reply`),
  rule("POST", `/question/${ID}/reject`),
  rule("GET", "/find/file"),
];

const ALLOWED_QUERY = new Set(["directory", "roots", "limit", "query"]);

/** Message du refus (409 redemarrage-en-cours) d'une demande facturée, selon son motif. */
const BILL_REFUSAL_MESSAGES: Readonly<Record<BillRefusal, string>> = {
  redemarrage: MESSAGES.restartEnCours,
  "adresse-en-verification": MESSAGES.adresseCopilotEnVerification,
  reconnexion: MESSAGES.opencodeReconnexion,
  "correction-differee": MESSAGES.adresseCopilotCorrectionDifferee,
};

/**
 * Première pièce jointe refusée d'un corps de prompt (parts[].url) : opencode lit lui-même les fichiers
 * désignés par une URL file:, qui doit donc rester dans le workspace. Seules les images en data: et les
 * URL file: sont admises.
 */
export function forbiddenAttachment(body: unknown, isAllowed: (file: string) => boolean): string | undefined {
  if (!body || typeof body !== "object") return undefined;
  const parts = (body as { parts?: unknown }).parts;
  if (!Array.isArray(parts)) return undefined;
  for (const part of parts) {
    if (!part || typeof part !== "object" || !("url" in part)) continue;
    const url = (part as { url: unknown }).url;
    if (typeof url === "string" && /^data:image\//i.test(url)) continue;
    if (typeof url !== "string") return typeof url;
    if (!/^file:/i.test(url)) return url;
    let file: string;
    try {
      file = decodeURIComponent(new URL(url).pathname);
    } catch {
      return url;
    }
    if (/^\/[A-Za-z]:\//.test(file)) file = file.slice(1);
    if (!isAllowed(file)) return url;
  }
  return undefined;
}

/** Types de parties acceptés dans un corps de prompt : l'interface n'envoie que du texte et des fichiers. */
export function forbiddenPartType(body: unknown): string | undefined {
  if (!body || typeof body !== "object" || !("parts" in body)) return undefined;
  const parts = (body as { parts: unknown }).parts;
  if (!Array.isArray(parts)) return typeof parts;
  for (const part of parts) {
    const type = part && typeof part === "object" ? (part as { type?: unknown }).type : undefined;
    // Une partie « subtask » ou « agent » ferait lire par opencode les @chemins de sa consigne, sans contrôle.
    if (type !== "text" && type !== "file") return typeof type === "string" ? type.slice(0, 40) : typeof type;
  }
  return undefined;
}

// --- Demandes d'autorisation -------------------------------------------------------------

/** Réponse à une demande d'autorisation et arrêt d'une conversation, relayés par le proxy. */
const PERMISSION_REPLY_ROUTE = new RegExp(`^/permission/(${ID})/reply$`);
const SESSION_ABORT_ROUTE = new RegExp(`^/session/(${ID})/abort$`);
/** Conversation désignée par le chemin relayé (contexte des crochets 1.1). */
const SESSION_ROUTE = new RegExp(`^/session/(${ID})(?:/|$)`);
const COMMAND_ROUTE = new RegExp(`^/session/${ID}/command$`);
/** Envoi d'un message : seule route où le cockpit pose son propre identifiant de message dans la salle (MO-1). */
const PROMPT_ASYNC_ROUTE = new RegExp(`^/session/${ID}/prompt_async$`);

export const PERMISSION_MESSAGES = Object.freeze({
  toujoursRefuse:
    "« Toujours autoriser » est désactivé : opencode l'appliquerait à tous les assistants du projet, y compris ceux qui refusent cette action, jusqu'à son redémarrage.",
  reponseInvalide: "Réponse invalide : « once » ou « reject » uniquement, avec une consigne facultative de 2 000 caractères au plus.",
  demandeExpiree: "Cette demande n'est plus active : la réponse a été arrêtée. Rien n'a été lancé.",
  demandeOrpheline:
    "Cette demande vient d'une réponse arrêtée. La refuser maintenant refuserait aussi les demandes de la réponse en cours : rien n'a été envoyé, réessayez quand celle-ci sera terminée.",
  verificationImpossible:
    "opencode ne répond pas : impossible de vérifier que cette demande est encore active. Rien n'a été envoyé, réessayez dans un instant.",
});

export interface PermissionReply {
  reply: "once" | "reject";
  message?: string;
}

const permissionReplySchema = z.strictObject({ reply: z.enum(["once", "reject"]), message: z.string().max(2_000).optional() });

/**
 * Corps accepté pour répondre à une demande d'autorisation : exactement { reply: "once" | "reject", message? }.
 * « always » est refusé (403) : opencode 1.18.30 ajoute alors { permission, pattern "*", allow } à une liste propre à
 * l'instance, évaluée APRÈS les règles de chaque agent (permission/index.ts:28-38, 145-150). Mesuré : un « Toujours » sur
 * la lecture d'un .env a levé le refus « *.pfx » d'un autre assistant, dans une autre conversation, jusqu'au redémarrage.
 */
export function parsePermissionReply(
  body: unknown,
): { ok: true; value: PermissionReply } | { ok: false; status: 400 | 403; error: string; message: string } {
  const reply = isRecord(body) ? body.reply : undefined;
  if (typeof reply === "string" && reply.trim().toLowerCase() === "always") {
    return { ok: false, status: 403, error: "toujours-refuse", message: PERMISSION_MESSAGES.toujoursRefuse };
  }
  const parsed = permissionReplySchema.safeParse(body);
  if (!parsed.success) return { ok: false, status: 400, error: "reponse-invalide", message: PERMISSION_MESSAGES.reponseInvalide };
  const { reply: value, message } = parsed.data;
  return { ok: true, value: message === undefined ? { reply: value } : { reply: value, message } };
}

/** Types de contenu relayés depuis opencode ; tout autre (text/html, JavaScript…) est servi en application/json. */
const PROXY_CONTENT_TYPE = /^(?:application\/json|text\/event-stream)\s*(?:;|$)/i;

/**
 * Champs qu'un corps venu du navigateur ne porte jamais vers la salle (MO-1, MO-5), refusés en 400 quelle que soit la route :
 * - `messageID` : opencode accepte tout identifiant qui commence par « msg » ; un doublon complète le message existant, et un
 *   identifiant emprunté à une AUTRE session y écrit la partie, alors que l'événement annonce la session visée ;
 * - `tools` : opencode remplace alors toute la liste `permission` de la session (la détection 4 de L23a l'y verrait) ;
 * - `permission` : même raison, et le champ est de toute façon ignoré par `prompt_async`.
 */
const CHAMPS_REFUSES_SALLE = ["messageID", "tools", "permission"] as const;

/** Phrases des refus propres au proxy de la salle. */
export const OMO_PROXY_MESSAGES = Object.freeze({
  reponseAutorisation:
    "Les demandes d'autorisation de la Salle OMO ne se répondent pas depuis le navigateur : le cockpit y répond lui-même, selon ses interdits absolus.",
  ouvertureConversation: "Une conversation de la Salle OMO s'ouvre depuis la page de la salle, sur un projet préparé : rien n'a été créé.",
  champRefuse: "Champ non accepté pour la Salle OMO : {champ}. Le cockpit pose lui-même l'identifiant du message et les règles de la conversation.",
  sessionInconnue: "Conversation inconnue du cockpit : rien n'est envoyé à la Salle OMO.",
  conversationIntrouvable: "Conversation introuvable.",
});

/**
 * Refus lisibles du proxy de la salle, avant la liste blanche : sans eux, la route serait simplement « non autorisée » (404) et
 * l'interface ne saurait pas quoi dire. D-2b-04 : une racine naît par POST /api/omo/rooms, et le cockpit répond lui-même aux
 * demandes d'autorisation de la salle (L22d).
 */
function refusRouteSalle(method: string, sub: string): { error: string; message: string } | null {
  if (method !== "POST") return null;
  if (sub === "/session") return { error: "ouverture-refusee", message: OMO_PROXY_MESSAGES.ouvertureConversation };
  if (PERMISSION_REPLY_ROUTE.test(sub)) return { error: "reponse-autorisation-refusee", message: OMO_PROXY_MESSAGES.reponseAutorisation };
  return null;
}

/**
 * Porte du montage /api/omo/oc/* (§3.9 l.331, §5.9) : la salle est coupée tant que SALLE_OUVERTE est faux, que COCKPIT_OMO
 * n'est pas « on » ou qu'aucune instance n'est construite ; elle est réservée au mode Avancé. Rendue ici pour que les quatre
 * cas soient contrôlés sans toucher à la porte du dépôt (SALLE_OUVERTE reste faux).
 */
export function refusMontageSalle(etat: { salleOuverte: boolean; omoActif: boolean; instancePresente: boolean; mode: UiMode }): "salle-coupee" | "mode-avance" | null {
  if (!etat.salleOuverte || !etat.omoActif || !etat.instancePresente) return "salle-coupee";
  return etat.mode === "avance" ? null : "mode-avance";
}

// --- Proxy d'une instance -------------------------------------------------------------

/** Dépendances du proxy d'une instance : l'instance elle-même, et ce que createApp garde (contrôles facturés, filtres). */
export interface OcProxyDeps {
  /** Instance servie : client, portillon, catalogue, assistants, compteur des demandes facturées, dossiers permis. */
  instance: InstanceDeps;
  /** Chemin sous lequel le proxy est monté, retiré du chemin reçu : « /api/oc » ou « /api/omo/oc ». */
  prefix: string;
  /** Liste blanche de ce montage : PROXY_RULES pour l'instance principale, PROXY_RULES_OMO pour la salle. */
  rules: readonly ProxyRule[];
  /**
   * Instance d'une session suivie, null si le cockpit ne la connaît pas (routeur d'instances, P11). Une session de l'AUTRE
   * instance reçoit 404 sur les deux montages ; sur la salle, une session inconnue reçoit 409.
   */
  instanceOf(sessionId: string): SessionInstance | null;
  env: AppEnv;
  log: Logger;
  projects: Pick<ProjectsService, "isAllowedDirectory" | "opencodeWorktree" | "opencodeRoot">;
  /** Crochets 1.1 rangés par wiring-11 ; absents : comportement 1.0. */
  hooks?: ProxyHooks;
  /** Contrôle d'une demande facturée (IA, fournisseurs, garde-fou, trace) : reste dans http.ts, qui a les relevés et les niveaux. */
  enforceTurn(c: Context, sub: string, directory: string | null, body: string, parsed: unknown): Promise<Response | string>;
  /**
   * Filtres de corps restés dans http.ts : ils partagent le motif FILE_REFERENCE, dont task-once-guard.test.ts compare le texte
   * à sa propre copie dans http.ts.
   */
  forbiddenProxyBody(method: string, sub: string, body: unknown, enterpriseDomain: string | null, agentNames?: ReadonlySet<string> | null): string | undefined;
  forbiddenCommandArguments(body: unknown, isAllowed: (file: string) => boolean, worktree: string): string | undefined;
}

/** Gestionnaire du proxy d'une instance : la fermeture de la 1.0.x, ses dépendances rendues explicites. */
export function createOcProxy(instanceDeps: OcProxyDeps): (c: Context) => Promise<Response> {
  const { instance, prefix, rules, instanceOf, env, log, projects, enforceTurn, forbiddenProxyBody, forbiddenCommandArguments } = instanceDeps;
  const { client, gate, lookup } = instance;
  const proxyHooks = instanceDeps.hooks;
  /** Montage de la Salle OMO : liste blanche plus étroite, aucune réponse d'autorisation, corps du navigateur borné (D-2b-04). */
  const salle = instance.instance === "omo";

  /** Noms des assistants vus par opencode dans ce dossier (cache court) ; null si la liste est illisible. */
  const agentNamesOf = (directory: string | null): Promise<ReadonlySet<string> | null> =>
    lookup.get(directory).then(
      (snapshot) => new Set(snapshot.agents.map((agent) => agent.name)),
      (err: unknown) => {
        log.warn("assistants d'opencode illisibles : références @ refusées dans les arguments d'un raccourci", { error: errorMessage(err) });
        return null;
      },
    );

  return async (c: Context): Promise<Response> => {
    const sub = c.req.path.slice(prefix.length) || "/";
    const method = c.req.method.toUpperCase();
    // Ouverture d'une conversation et réponse d'autorisation venues du navigateur : refusées par la salle dans les DEUX modes,
    // avant la liste blanche, pour que le refus soit lisible (un 404 de route ferait croire à une erreur d'adresse). D-2b-04.
    const refusRoute = salle ? refusRouteSalle(method, sub) : null;
    if (refusRoute !== null) return fail(c, 403, refusRoute.error, refusRoute.message);
    const matched = rules.find((r) => r.method === method && r.pattern.test(sub));
    if (!matched) return fail(c, 404, "not-allowed", `Route opencode non autorisée : ${method} ${sub}`);
    // Cloison des instances (P11), avant tout envoi : une conversation de l'autre instance n'existe pas sur ce montage, dans
    // les deux sens. Sur la salle, une conversation que le cockpit ne suit pas est refusée aussi (fermé en cas de doute) ;
    // sur l'instance principale, une conversation inconnue reste relayée, exactement comme en 1.0.x.
    const routedSession = SESSION_ROUTE.exec(sub)?.[1];
    if (routedSession !== undefined) {
      const proprietaire = instanceOf(routedSession);
      if (proprietaire !== null && proprietaire !== instance.instance) {
        return fail(c, 404, "not-found", OMO_PROXY_MESSAGES.conversationIntrouvable);
      }
      if (proprietaire === null && salle) return fail(c, 409, "instance-inconnue", OMO_PROXY_MESSAGES.sessionInconnue);
    }
    // Configuration en cours d'application ou redémarrage : opencode couperait cette demande facturée. Adresse de l'API Copilot en
    // cours d'écriture ou à revérifier (« synchro due », flux coupé compris) : opencode peut tourner sur l'adresse d'office, que le
    // réseau bloque peut-être. Garde globale : le dossier d'une demande ne dit pas quelle adresse opencode y utilisera.
    const refusal = matched.guarded ? instance.billRefusal() : null;
    if (refusal !== null) return fail(c, 409, "redemarrage-en-cours", BILL_REFUSAL_MESSAGES[refusal]);
    // Demande facturée admise (sans attente depuis la garde) : comptée en vol jusqu'à la réponse d'opencode. Une application qui
    // commence d'ici là la traite comme une réponse en cours, que la sonde des conversations ne voit pas encore.
    const endBilled = matched.guarded ? instance.beginBilled() : undefined;

    // Place dans la file d'attente des réponses (« once » vérifié, arrêt) : libérée au plus tard en sortant.
    let releaseGate: (() => void) | undefined;
    try {
      const incoming = new URL(c.req.url);
      const target = client.url(sub);
      for (const [key, value] of incoming.searchParams) if (ALLOWED_QUERY.has(key)) target.searchParams.set(key, value);
      const directory = target.searchParams.get("directory");
      if (directory !== null && !instance.isAllowedDirectory(directory)) {
        return fail(c, 403, "forbidden-directory", "Ce dossier est hors du workspace monté.");
      }

      let body: string | null = null;
      /** Corps JSON lu (objet, {} sinon) : contexte des crochets 1.1. */
      let record: Record<string, unknown> = {};
      const hookContext = (bodyRecord: Record<string, unknown>): ProxyContext => ({
        c,
        method,
        sub,
        directory,
        body: bodyRecord,
        sessionId: SESSION_ROUTE.exec(sub)?.[1] ?? null,
        // Instance visée : absente pour l'instance principale (contexte 1.0.x). runHooks n'appelle alors QUE les crochets de
        // la salle, et l'arrêt d'une conversation de la salle ne passe jamais par stopTree de l'instance principale (D-2b-30).
        ...(salle ? { instance: instance.instance } : {}),
      });
      /** Réponse du navigateur à inscrire au registre du portillon juste avant son relais (P9). */
      let browserReply: Omit<EmittedReply, "at"> | null = null;
      if (method !== "GET" && method !== "HEAD") {
        body = await c.req.text();
        let parsed: unknown = {};
        try {
          parsed = body ? JSON.parse(body) : {};
        } catch {
          return fail(c, 400, "invalid-json", "Corps JSON invalide.");
        }
        record = isRecord(parsed) ? parsed : {};
        if (salle) {
          // MO-1 et MO-5 : ces trois champs venus du navigateur détourneraient l'écriture du message ou les règles de la
          // conversation. Refusés avant tout autre contrôle, sur toutes les routes de la salle.
          const champ = CHAMPS_REFUSES_SALLE.find((nom) => Object.hasOwn(record, nom));
          if (champ !== undefined) return fail(c, 400, "champ-refuse", OMO_PROXY_MESSAGES.champRefuse.replace("{champ}", champ));
        }
        // Raccourci dont les arguments portent une référence @ : assistants d'opencode lus (cache court) pour refuser @assistant.
        const agentNames =
          method === "POST" && COMMAND_ROUTE.test(sub) && typeof record.arguments === "string" && record.arguments.includes("@")
            ? await agentNamesOf(directory)
            : undefined;
        const refusedBody = forbiddenProxyBody(method, sub, parsed, env.githubEnterpriseDomain, agentNames);
        if (refusedBody !== undefined) return fail(c, 403, "forbidden-body", refusedBody);
        if (method === "POST" && sub === "/session" && proxyHooks && proxyHooks.hooks.createSession.length > 0) {
          // Création d'une conversation : un crochet peut compléter le corps (plancher) ; le proxy envoie le corps après les crochets.
          const context = hookContext({ ...record });
          const hooked = await proxyHooks.runHooks("createSession", context);
          if (hooked) return hooked;
          body = JSON.stringify(context.body);
        }
        const replyTo = method === "POST" ? PERMISSION_REPLY_ROUTE.exec(sub)?.[1] : undefined;
        if (replyTo !== undefined) {
          const reply = parsePermissionReply(parsed);
          if (!reply.ok) return fail(c, reply.status, reply.error, reply.message);
          if (reply.value.reply === "once") {
            // Gardée jusqu'au relais : aucun arrêt ne peut s'intercaler entre la vérification et le « once ».
            releaseGate = await gate.acquire();
            const verdict = await gate.checkOnce(replyTo, directory);
            if (!verdict.ok) {
              releaseGate();
              if (verdict.status === 503) return fail(c, 503, "verification-impossible", PERMISSION_MESSAGES.verificationImpossible);
              log.info("demande d'autorisation qui n'est plus active : « once » non relayé", { requestId: replyTo, found: verdict.request !== null });
              // Demande orpheline d'une conversation au repos : refusée, pour qu'elle ne redevienne pas autorisable plus tard.
              if (verdict.orphan && verdict.request) await gate.rejectOrphans([verdict.request], directory, { cause: "réponse tardive", requestId: replyTo });
              return fail(c, 409, "demande-expiree", PERMISSION_MESSAGES.demandeExpiree);
            }
            if (proxyHooks && proxyHooks.hooks.beforeOnceRelay.length > 0) {
              // Garde du « task once » (§3.14), toujours dans la file : aucun arrêt ne s'intercale. Refus : place libérée en sortant.
              const hooked = await proxyHooks.runHooks("beforeOnceRelay", hookContext(record), replyTo);
              if (hooked) return hooked;
            }
          } else if (await gate.isOrphanOfWorkingSession(replyTo, directory)) {
            log.info("refus d'une demande orpheline non relayé : la conversation retravaille", { requestId: replyTo });
            return fail(c, 409, "demande-orpheline", PERMISSION_MESSAGES.demandeOrpheline);
          }
          // Corps réécrit : opencode reçoit exactement ce qui a été contrôlé (ni clé en double, ni champ ignoré).
          body = JSON.stringify(reply.value);
          browserReply = { requestId: replyTo, reply: reply.value.reply, by: "vous" };
        }
        if (matched.guarded) {
          const isAllowed = (file: string) => instance.isAllowedDirectory(file);
          const partType = forbiddenPartType(parsed);
          if (partType !== undefined) {
            return fail(c, 403, "forbidden-part", `Type de contenu refusé : ${partType} (texte et fichiers uniquement).`);
          }
          if (forbiddenAttachment(parsed, isAllowed) !== undefined) {
            return fail(c, 403, "forbidden-attachment", "Pièce jointe refusée : fichier hors du workspace monté ou type d'URL non pris en charge.");
          }
          if (sub.endsWith("/command")) {
            const worktree = await projects.opencodeWorktree(directory ?? projects.opencodeRoot);
            if (forbiddenCommandArguments(parsed, isAllowed, worktree) !== undefined) {
              return fail(
                c,
                403,
                "forbidden-command-arguments",
                "Arguments refusés : un « ! » et un accent grave dans le même texte (opencode pourrait les exécuter comme !`commande`), ou une référence @fichier qui sortirait du workspace (~, .., chemin hors du projet). Retirez-les, ou envoyez le texte sans /commande.",
              );
            }
          }
          const enforced = await enforceTurn(c, sub, directory, body, parsed);
          if (enforced instanceof Response) return enforced;
          body = enforced;
          if (salle && PROMPT_ASYNC_ROUTE.test(sub)) {
            // MO-1 : le cockpit pose SON identifiant de message, imprévisible, après tous les contrôles et avant les crochets,
            // qui le lisent dans le corps. C'est un corrélateur de l'envoi, JAMAIS une preuve d'origine (un tiers qui aurait
            // accès à l'instance peut en forger un) et jamais journalisé. `prompt_async` répond 204 sans corps : il ne se lit
            // qu'au flux d'événements.
            const avant: unknown = body === "" ? {} : JSON.parse(body);
            body = JSON.stringify({ ...(isRecord(avant) ? avant : {}), messageID: `msg_${randomUUID()}` });
          }
          if (proxyHooks && proxyHooks.hooks.beforeBilledSend.length > 0) {
            // Après tous les contrôles 1.0 (IA, fournisseurs, garde-fou) : plancher, plan, activation, demande d'autonomie.
            const sent: unknown = body === "" ? {} : JSON.parse(body);
            const hooked = await proxyHooks.runHooks("beforeBilledSend", hookContext(isRecord(sent) ? sent : {}));
            if (hooked) return hooked;
          }
        }
      }

      const abortId = method === "POST" ? SESSION_ABORT_ROUTE.exec(sub)?.[1] : undefined;
      if (abortId !== undefined && proxyHooks && proxyHooks.hooks.abort.length > 0) {
        // Avant la file des réponses : l'arrêt de l'arbre (stopTree) la prend lui-même.
        const hooked = await proxyHooks.runHooks("abort", hookContext(record), abortId);
        if (hooked) return hooked;
      }
      // Arrêt : attend qu'un « once » en cours de vérification soit relayé, puis garde la file jusqu'à la liste du nettoyage.
      const abortGate = abortId !== undefined ? await gate.acquire() : undefined;
      if (abortGate !== undefined) releaseGate = abortGate;
      // P9 : réponse inscrite au registre avant son envoi.
      if (browserReply !== null) gate.emitted.record({ ...browserReply, at: Date.now() });
      const upstream = await client.raw(method, target, {
        headers: {
          accept: c.req.header("accept") ?? "application/json",
          ...(body !== null ? { "content-type": "application/json" } : {}),
        },
        body: body === null || body === "" ? null : body,
        signal: c.req.raw.signal,
      });
      // Réponse d'opencode reçue : la demande n'est plus comptée en vol.
      endBilled?.();
      if (abortId !== undefined && abortGate !== undefined && upstream.ok) {
        // Sans attendre : la réponse de l'arrêt part tout de suite et reste celle d'opencode ; le nettoyage libère la file.
        releaseGate = undefined;
        void gate.rejectAborted(abortId, directory, abortGate).catch((err: unknown) =>
          log.warn("arrêt : demandes d'autorisation en attente non vérifiées", { sessionId: abortId, error: errorMessage(err) }),
        );
      }
      const headers = new Headers();
      const contentType = upstream.headers.get("content-type");
      // Jamais de document ni de script servi sous l'origine du cockpit, même si opencode (ou un faux serveur) le demandait.
      if (contentType) headers.set("content-type", PROXY_CONTENT_TYPE.test(contentType) ? contentType : "application/json");
      if (method === "POST" && sub === "/session" && upstream.ok && proxyHooks && proxyHooks.hooks.sessionCreated.length > 0) {
        // Corps de la réponse lu seulement ici : vérification de la conversation créée (écart : supprimée, 502).
        const text = await upstream.text();
        let session: unknown = null;
        try {
          session = text ? JSON.parse(text) : null;
        } catch {
          session = null;
        }
        const hooked = await proxyHooks.runHooks("sessionCreated", hookContext(record), session);
        if (hooked) return hooked;
        return new Response(text, { status: upstream.status, headers });
      }
      return new Response(upstream.body, { status: upstream.status, headers });
    } finally {
      // Refusée avant le relais ou en erreur : plus comptée en vol (sans effet si la réponse d'opencode l'a déjà retirée).
      endBilled?.();
      releaseGate?.();
    }
  };
}
