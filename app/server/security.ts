// Défenses HTTP : en-têtes, contrôle de l'hôte (anti DNS-rebinding), session par cookie, anti-CSRF, preuve du jeton et ticket
// de connexion à usage unique (1.0.5).
import crypto from "node:crypto";
import type { Context, MiddlewareHandler } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import type { LocalScheme } from "./env.ts";

export const SESSION_COOKIE = "cockpit_session";
/** Nom réellement posé dans le navigateur : préfixe « host » de hono. L'ancien nom, sans préfixe, est effacé. */
export const SESSION_COOKIE_NAME = `__Host-${SESSION_COOKIE}`;
export const CSRF_HEADER = "x-cockpit-csrf";
export const CONFIRM_HEADER = "x-cockpit-confirm";

export const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "script-src 'self'",
  // CodeMirror injecte ses styles dynamiquement ; aucun script en ligne n'est autorisé.
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join("; ");

/**
 * Réponses de l'API (JSON, flux, téléchargements) : jamais un document. Une réponse relayée d'opencode ouverte dans un
 * onglet ne peut ni exécuter de script, ni charger de ressource, ni être encadrée.
 */
export const API_CONTENT_SECURITY_POLICY = "default-src 'none'; frame-ancestors 'none'; sandbox";

/** Durée de vie d'une session, vérifiée par le serveur (le max-age du cookie n'est qu'une consigne au navigateur). */
export const SESSION_MAX_AGE_SECONDS = 60 * 60 * 24 * 30;

/**
 * Valeur du cookie : date d'émission et HMAC du jeton sur le secret de session et cette date. Le jeton lui-même n'est jamais
 * stocké dans le navigateur ; changer le jeton ou le secret (déconnexion) révoque toutes les sessions.
 */
export function sessionValue(token: string, secret: string, issuedAt: number = Math.floor(Date.now() / 1000)): string {
  const mac = crypto.createHmac("sha256", token).update(`opencode-cockpit/session/v2\n${secret}\n${issuedAt}`).digest("base64url");
  return `${issuedAt}.${mac}`;
}

/** Cookie de session valide : signature correcte et émis il y a moins de SESSION_MAX_AGE_SECONDS. */
export function isValidSession(cookie: string | undefined, token: string, secret: string, now: number = Date.now()): boolean {
  if (typeof cookie !== "string") return false;
  const match = /^(\d{1,12})\.[A-Za-z0-9_-]{43}$/.exec(cookie);
  if (!match) return false;
  const issuedAt = Number(match[1]);
  const age = Math.floor(now / 1000) - issuedAt;
  if (age < -300 || age > SESSION_MAX_AGE_SECONDS) return false;
  return safeEqual(cookie, sessionValue(token, secret, issuedAt));
}

/** Secret de session aléatoire (renouvelé à chaque déconnexion). */
export function newSessionSecret(): string {
  return crypto.randomBytes(32).toString("base64url");
}

export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && crypto.timingSafeEqual(ab, bb);
}

export function securityHeaders(): MiddlewareHandler {
  return async (c, next) => {
    await next();
    const h = c.res.headers;
    h.set("Content-Security-Policy", c.req.path.startsWith("/api/") ? API_CONTENT_SECURITY_POLICY : CONTENT_SECURITY_POLICY);
    h.set("X-Content-Type-Options", "nosniff");
    h.set("X-Frame-Options", "DENY");
    h.set("Referrer-Policy", "no-referrer");
    h.set("Cross-Origin-Opener-Policy", "same-origin");
    h.set("Cross-Origin-Resource-Policy", "same-origin");
    h.set("Permissions-Policy", "camera=(), microphone=(), geolocation=(), payment=(), usb=()");
    if (c.req.path.startsWith("/api/")) h.set("Cache-Control", "no-store");
  };
}

export function hostnameOf(hostHeader: string | undefined): string {
  const host = (hostHeader ?? "").trim().toLowerCase();
  if (host.startsWith("[")) return host.slice(0, host.indexOf("]") + 1);
  return host.replace(/:\d+$/, "");
}

/** Hôte hors de COCKPIT_ALLOWED_HOSTS : 421, avec l'adresse à utiliser dans le schéma réellement servi. */
export function hostGuard(allowedHosts: string[], scheme: LocalScheme): MiddlewareHandler {
  const allowed = new Set(allowedHosts);
  const message = `Hôte non autorisé. Ouvrez le cockpit via ${scheme}://127.0.0.1 ou ${scheme}://localhost.`;
  return async (c, next) => {
    if (!allowed.has(hostnameOf(c.req.header("host")))) {
      return c.text(message, 421);
    }
    await next();
  };
}

/** Vérifie le cookie de session de la requête (`isValid` connaît le jeton et le secret courant). Seul le nom préfixé est lu. */
export function isAuthenticated(c: Context, isValid: (cookie: string | undefined) => boolean): boolean {
  return isValid(getCookie(c, SESSION_COOKIE, "host"));
}

const SESSION_COOKIE_OPTIONS = { httpOnly: true, secure: true, sameSite: "Strict", path: "/" } as const;

export function setSessionCookie(c: Context, value: string): void {
  // Préfixe __Host- : Secure, Path=/ et sans Domain imposés par hono ; accepté aussi en HTTP sur 127.0.0.1 et localhost (mesuré).
  setCookie(c, SESSION_COOKIE, value, { ...SESSION_COOKIE_OPTIONS, prefix: "host", maxAge: SESSION_MAX_AGE_SECONDS });
  // Cookie des versions antérieures à 1.0.5 : effacé, il n'est plus lu.
  deleteCookie(c, SESSION_COOKIE, SESSION_COOKIE_OPTIONS);
}

/** Déconnexion : efface le cookie préfixé et l'ancien nom. */
export function clearSessionCookie(c: Context): void {
  deleteCookie(c, SESSION_COOKIE, { ...SESSION_COOKIE_OPTIONS, prefix: "host" });
  deleteCookie(c, SESSION_COOKIE, SESSION_COOKIE_OPTIONS);
}

const PUBLIC_API = new Set(["/api/health", "/api/login"]);

export function authGuard(isValid: (cookie: string | undefined) => boolean): MiddlewareHandler {
  return async (c, next) => {
    if (c.req.path.startsWith("/api/") && !PUBLIC_API.has(c.req.path) && !isAuthenticated(c, isValid)) {
      return c.json({ error: "unauthorized", message: "Session expirée : reconnectez-vous." }, 401);
    }
    await next();
  };
}

/**
 * Anti-CSRF : toute requête modifiante doit porter l'en-tête personnalisé (impossible en cross-origin sans pré-vol CORS, que
 * le serveur n'accorde jamais). Origine présente : même schéma que celui servi ET même hôte que Host ; absente : acceptée.
 * Une origine http: n'est donc acceptée qu'en mode HTTP, une origine https: qu'en HTTPS.
 */
export function csrfGuard(scheme: LocalScheme): MiddlewareHandler {
  const protocol = `${scheme}:`;
  return async (c, next) => {
    const method = c.req.method.toUpperCase();
    if (c.req.path.startsWith("/api/") && !["GET", "HEAD", "OPTIONS"].includes(method)) {
      if (c.req.header(CSRF_HEADER) !== "1") return c.json({ error: "csrf", message: "En-tête anti-CSRF manquant." }, 403);
      const origin = c.req.header("origin");
      if (origin) {
        let url: URL;
        try {
          url = new URL(origin);
        } catch {
          return c.json({ error: "csrf", message: "Origine invalide." }, 403);
        }
        if (url.protocol !== protocol || url.host.toLowerCase() !== (c.req.header("host") ?? "").toLowerCase()) {
          return c.json({ error: "csrf", message: "Origine refusée." }, 403);
        }
      }
    }
    await next();
  };
}

/** Limiteur simple des échecs de connexion (fenêtre glissante). */
export class LoginLimiter {
  #failures: number[] = [];
  readonly max: number;
  readonly windowMs: number;

  constructor(max = 20, windowMs = 5 * 60_000) {
    this.max = max;
    this.windowMs = windowMs;
  }

  blocked(now = Date.now()): boolean {
    this.#failures = this.#failures.filter((t) => now - t < this.windowMs);
    return this.#failures.length >= this.max;
  }

  fail(now = Date.now()): void {
    this.#failures.push(now);
  }
}

export type LoginOutcome = "ok" | "refused" | "blocked";

/**
 * Tentative de connexion. Le jeton est comparé AVANT le limiteur : un client qui épuise le limiteur (le conteneur opencode
 * peut joindre le cockpit sur le réseau Docker) bloque ses propres échecs, jamais la connexion avec le bon jeton. Le jeton
 * aléatoire de 32 octets rend l'essai exhaustif impossible ; chaque échec compté reste ralenti.
 */
export async function attemptLogin(limiter: LoginLimiter, candidate: string, token: string, failureDelayMs = 400): Promise<LoginOutcome> {
  if (safeEqual(candidate, token)) return "ok";
  if (limiter.blocked()) return "blocked";
  limiter.fail();
  await new Promise((resolve) => setTimeout(resolve, failureDelayMs));
  return "refused";
}

// --- Preuve du jeton et ticket de connexion (1.0.5) ----------------------------------------------------------------------

const HEX64 = /^[0-9a-f]{64}$/;
const TICKET_LINK = /^([0-9a-f]{64})\.([0-9a-f]{64})$/;

/** Jeton au format produit par install.ps1 (New-Secret 32) : 64 caractères hexadécimaux minuscules, 256 bits aléatoires. */
export const isGeneratedToken = (token: string): boolean => HEX64.test(token);

/** Défi de GET /api/health?challenge= : 64 caractères hexadécimaux minuscules. */
export const isHealthChallenge = (challenge: string): boolean => HEX64.test(challenge);

/**
 * Preuve du jeton rendue par /api/health : HMAC-SHA256(jeton, « opencode-cockpit/health-proof/v1\n » + défi), en hexadécimal.
 * Un programme qui occupe le port sans connaître le jeton ne peut pas la produire. Préfixes distincts de la session et du
 * ticket : aucune sortie d'un usage n'est valable pour un autre.
 */
export function healthProof(token: string, challenge: string): string {
  return crypto.createHmac("sha256", token).update(`opencode-cockpit/health-proof/v1\n${challenge}`).digest("hex");
}

/** Signature d'un ticket de connexion : HMAC-SHA256(jeton, « opencode-cockpit/auth-ticket/v1\n » + nonce), en hexadécimal. */
export function authTicketMac(token: string, nonce: string): string {
  return crypto.createHmac("sha256", token).update(`opencode-cockpit/auth-ticket/v1\n${nonce}`).digest("hex");
}

/** Durée de validité d'un ticket : l'avertissement de certificat du navigateur se place avant que le lien atteigne le serveur. */
export const AUTH_TICKET_TTL_MS = 10 * 60_000;
/** Tickets en attente au plus ; le plus ancien est évincé au-delà. */
export const AUTH_TICKETS_MAX = 8;

/**
 * Tickets de connexion à usage unique, émis par /api/health (défi valide et `ticket=1`) après la preuve du jeton : le lien
 * ouvert par les scripts (/auth?k=<nonce>.<signature>) ne contient jamais le jeton permanent. Mémoire seulement (un redémarrage
 * les invalide) ; durée mesurée sur une horloge monotone, sans dépendance à l'horloge de la machine virtuelle Docker.
 */
export class AuthTickets {
  readonly #now: () => number;
  /** Nonce → échéance ; l'ordre d'insertion donne l'ancienneté. */
  readonly #pending = new Map<string, number>();

  constructor(deps: { now?: () => number } = {}) {
    this.#now = deps.now ?? (() => performance.now());
  }

  /** Nouveau nonce de 32 octets aléatoires, en hexadécimal. */
  issue(): string {
    const now = this.#now();
    this.#prune(now);
    while (this.#pending.size >= AUTH_TICKETS_MAX) {
      const oldest = this.#pending.keys().next();
      if (oldest.done) break;
      this.#pending.delete(oldest.value);
    }
    const nonce = crypto.randomBytes(32).toString("hex");
    this.#pending.set(nonce, now + AUTH_TICKET_TTL_MS);
    return nonce;
  }

  /** Vrai une seule fois, si le nonce est en attente et non expiré ; il est supprimé dans tous les cas. */
  consume(nonce: string): boolean {
    const expiresAt = this.#pending.get(nonce);
    if (expiresAt === undefined) return false;
    this.#pending.delete(nonce);
    return this.#now() < expiresAt;
  }

  /** Tickets en attente et non expirés. */
  get pending(): number {
    this.#prune(this.#now());
    return this.#pending.size;
  }

  #prune(now: number): void {
    for (const [nonce, expiresAt] of this.#pending) if (now >= expiresAt) this.#pending.delete(nonce);
  }
}

/**
 * Connexion par ticket (/auth?k=<nonce>.<signature>). Même ordre qu'attemptLogin : signature comparée en temps constant puis
 * ticket consommé AVANT le limiteur (un limiteur épuisé ne bloque jamais un ticket valide) ; tout échec est compté et ralenti.
 */
export async function attemptTicketLogin(
  limiter: LoginLimiter,
  link: string,
  token: string,
  tickets: AuthTickets,
  failureDelayMs = 400,
): Promise<LoginOutcome> {
  const match = TICKET_LINK.exec(link);
  const nonce = match?.[1];
  const mac = match?.[2];
  if (nonce !== undefined && mac !== undefined && safeEqual(mac, authTicketMac(token, nonce)) && tickets.consume(nonce)) return "ok";
  if (limiter.blocked()) return "blocked";
  limiter.fail();
  await new Promise((resolve) => setTimeout(resolve, failureDelayMs));
  return "refused";
}
