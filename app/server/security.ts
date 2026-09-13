// Défenses HTTP : en-têtes, contrôle de l'hôte (anti DNS-rebinding), session par cookie, anti-CSRF.
import crypto from "node:crypto";
import type { Context, MiddlewareHandler } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";

export const SESSION_COOKIE = "cockpit_session";
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

/** Valeur du cookie dérivée du jeton : le jeton lui-même n'est jamais stocké dans le navigateur. */
export function sessionValue(token: string): string {
  return crypto.createHmac("sha256", token).update("opencode-cockpit/session/v1").digest("base64url");
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
    h.set("Content-Security-Policy", CONTENT_SECURITY_POLICY);
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

export function hostGuard(allowedHosts: string[]): MiddlewareHandler {
  const allowed = new Set(allowedHosts);
  return async (c, next) => {
    if (!allowed.has(hostnameOf(c.req.header("host")))) {
      return c.text("Hôte non autorisé. Ouvrez le cockpit via http://127.0.0.1 ou http://localhost.", 421);
    }
    await next();
  };
}

export function isAuthenticated(c: Context, expected: string): boolean {
  const cookie = getCookie(c, SESSION_COOKIE);
  return typeof cookie === "string" && safeEqual(cookie, expected);
}

export function setSessionCookie(c: Context, value: string): void {
  setCookie(c, SESSION_COOKIE, value, {
    httpOnly: true,
    // Les navigateurs acceptent les cookies Secure sur http://localhost et http://127.0.0.1.
    secure: true,
    sameSite: "Strict",
    path: "/",
    maxAge: 60 * 60 * 24 * 30,
  });
}

export function clearSessionCookie(c: Context): void {
  deleteCookie(c, SESSION_COOKIE, { path: "/", secure: true, sameSite: "Strict" });
}

const PUBLIC_API = new Set(["/api/health", "/api/login"]);

export function authGuard(expected: string): MiddlewareHandler {
  return async (c, next) => {
    if (c.req.path.startsWith("/api/") && !PUBLIC_API.has(c.req.path) && !isAuthenticated(c, expected)) {
      return c.json({ error: "unauthorized", message: "Session expirée : reconnectez-vous." }, 401);
    }
    await next();
  };
}

/**
 * Anti-CSRF : toute requête modifiante doit porter l'en-tête personnalisé (impossible en
 * cross-origin sans pré-vol CORS, que le serveur n'accorde jamais) et une origine identique.
 */
export function csrfGuard(): MiddlewareHandler {
  return async (c, next) => {
    const method = c.req.method.toUpperCase();
    if (c.req.path.startsWith("/api/") && !["GET", "HEAD", "OPTIONS"].includes(method)) {
      if (c.req.header(CSRF_HEADER) !== "1") return c.json({ error: "csrf", message: "En-tête anti-CSRF manquant." }, 403);
      const origin = c.req.header("origin");
      if (origin) {
        let originHost = "";
        try {
          originHost = new URL(origin).host.toLowerCase();
        } catch {
          return c.json({ error: "csrf", message: "Origine invalide." }, 403);
        }
        if (originHost !== (c.req.header("host") ?? "").toLowerCase()) {
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
