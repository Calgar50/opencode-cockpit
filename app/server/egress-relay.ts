// Relais de sortie d'opencode (1.0.6), dans le processus du cockpit, sans dépendance npm. opencode est seul sur un réseau Docker
// interne, sans route : HTTP_PROXY et HTTPS_PROXY le dirigent ici, et c'est sa SEULE sortie.
// - Seul `CONNECT <hôte de la liste fermée>:443` ouvre un tunnel (egress-policy.ts), direct ou chaîné au proxy de l'entreprise
//   (HTTPS_PROXY du cockpit). Tout le reste reçoit 403 ou 400, SANS aucune connexion sortante : le proxy de l'entreprise ne voit
//   rien, donc ses journaux non plus.
// - Chaque refus entre dans le journal du cockpit au plus une fois par hôte et par heure (nombre de refus compris), avec l'hôte,
//   le port et la raison seulement : ni chemin, ni en-tête, ni identifiant.
// - La liste est relue à chaque CONNECT et, tant qu'un tunnel est ouvert, toutes les `revalidateMs` (5 s) : un tunnel dont l'hôte
//   n'est plus permis est coupé, même s'il parle encore (fin de la fenêtre de connexion, autre adresse d'API, liste illisible).
//   Un tunnel vers un hôte de connexion (github.com, domaine GitHub Enterprise) est en plus coupé à l'heure exacte de la fin de la
//   fenêtre (`tunnelDeadline`) : il ne lui survit jamais.
// - Écoute sur l'adresse du cockpit dans le réseau interne SEULEMENT (celle qui partage le sous-réseau d'opencode), jamais sur
//   0.0.0.0 ; toute connexion venue d'ailleurs est coupée. Bornes : taille et délai de l'en-tête, connexions simultanées, délai de
//   la sortie, inactivité d'un tunnel.
// Les identifiants du proxy de l'entreprise ne partent que dans l'en-tête Proxy-Authorization envoyé à ce proxy : jamais tracés.
import dns from "node:dns/promises";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import type { Duplex } from "node:stream";
import { decideConnect, EGRESS_NAME_MAX, EGRESS_PORT, type EgressRefusalReason } from "./egress-policy.ts";
import { errorMessage, type Logger } from "./log.ts";

export interface RelayLimits {
  /** En-tête d'une demande au relais, en octets (431 au-delà). */
  maxHeaderBytes: number;
  /** En-tête complet attendu au plus (connexion lente). */
  headersTimeoutMs: number;
  /** Connexions simultanées au plus, tunnels compris. */
  maxConnections: number;
  /** Connexion sortante, ou réponse du proxy de l'entreprise, attendue au plus avant 502. */
  upstreamTimeoutMs: number;
  /** En-tête de la réponse du proxy de l'entreprise lu au plus. */
  upstreamHeaderBytes: number;
  /** Tunnel sans aucun octet échangé : fermé. */
  idleTimeoutMs: number;
  /** Tunnels ouverts revus au moins à ce rythme : ceux dont l'hôte n'est plus permis sont coupés (30 s au plus). */
  revalidateMs: number;
  /** Connexion refusée gardée au plus, le temps que le client lise la réponse. */
  closeDelayMs: number;
  /** Une ligne au plus par hôte et par fenêtre dans le journal du cockpit. */
  logWindowMs: number;
  /** Hôtes suivis au plus par le journal des refus ; au-delà, regroupés sous « (autres hôtes) ». */
  logHostsMax: number;
}

export const RELAY_LIMITS: Readonly<RelayLimits> = Object.freeze({
  maxHeaderBytes: 8 * 1024,
  headersTimeoutMs: 10_000,
  maxConnections: 128,
  upstreamTimeoutMs: 15_000,
  upstreamHeaderBytes: 16 * 1024,
  idleTimeoutMs: 10 * 60_000,
  revalidateMs: 5_000,
  closeDelayMs: 5_000,
  logWindowMs: 60 * 60_000,
  logHostsMax: 256,
});

/** Nouvel essai de la recherche du réseau interne (opencode pas encore démarré, par exemple). */
export const RELAY_RETRY_MS = 5_000;

/** Plus long délai qu'accepte setTimeout (au-delà, Node le ramène à 1 ms). */
const MAX_TIMER_MS = 2 ** 31 - 1;

const RESPONSE_200 = "HTTP/1.1 200 Connection Established\r\n\r\n";
const RESPONSE_400 = "HTTP/1.1 400 Bad Request\r\nContent-Length: 0\r\nConnection: close\r\n\r\n";
const RESPONSE_403 = "HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\nConnection: close\r\n\r\n";
const RESPONSE_431 = "HTTP/1.1 431 Request Header Fields Too Large\r\nContent-Length: 0\r\nConnection: close\r\n\r\n";
const RESPONSE_502 = "HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\nConnection: close\r\n\r\n";

export class RelayConfigError extends Error {
  override name = "RelayConfigError";
}

/** Proxy de l'entreprise : hôte et port ; « Basic … » prêt à envoyer, null sans identifiants. */
export interface UpstreamProxy {
  host: string;
  port: number;
  authorization: string | null;
}

/**
 * Proxy de l'entreprise déclaré au cockpit (HTTPS_PROXY, sinon https_proxy) : http:// seulement (schéma absent = http://), sans
 * chemin ni paramètre ; port absent = 80. null : aucun, tunnel direct. Les messages ne citent jamais la valeur (identifiants).
 */
export function readUpstreamProxy(env: NodeJS.ProcessEnv): UpstreamProxy | null {
  const raw = env.HTTPS_PROXY?.trim() || env.https_proxy?.trim() || "";
  if (raw === "") return null;
  let url: URL;
  try {
    url = new URL(raw.includes("://") ? raw : `http://${raw}`);
  } catch {
    throw new RelayConfigError("HTTPS_PROXY : adresse illisible.");
  }
  if (url.protocol !== "http:") throw new RelayConfigError("HTTPS_PROXY : seul un proxy d'entreprise en http:// est pris en charge par le relais.");
  if (url.pathname !== "/" || url.search !== "" || url.hash !== "") throw new RelayConfigError("HTTPS_PROXY : l'adresse ne doit porter ni chemin ni paramètre.");
  const host = url.hostname.startsWith("[") ? url.hostname.slice(1, -1) : url.hostname;
  let authorization: string | null = null;
  if (url.username !== "" || url.password !== "") {
    let credentials: string;
    try {
      credentials = `${decodeURIComponent(url.username)}:${decodeURIComponent(url.password)}`;
    } catch {
      throw new RelayConfigError("HTTPS_PROXY : identifiants mal encodés.");
    }
    authorization = `Basic ${Buffer.from(credentials, "utf8").toString("base64")}`;
  }
  return { host, port: url.port === "" ? 80 : Number(url.port), authorization };
}

/**
 * Hôte tel qu'il peut entrer au journal : identifiants (« …@ ») et chemin (« /… », « ?… », « #… ») retirés, minuscules, caractères
 * hors ASCII visible remplacés par « ? », 253 caractères au plus. « (vide) » pour une demande sans hôte lisible.
 */
export function hostForLog(host: string): string {
  const withoutCredentials = host.slice(host.lastIndexOf("@") + 1);
  const cut = withoutCredentials.search(/[/?#]/);
  const bare = cut === -1 ? withoutCredentials : withoutCredentials.slice(0, cut);
  const clean = bare.slice(0, EGRESS_NAME_MAX).toLowerCase().replace(/[^\x21-\x7e]/g, "?");
  return clean === "" ? "(vide)" : clean;
}

const OTHER_HOSTS = "(autres hôtes)";

/**
 * Journal des refus et des échecs en amont : une ligne au plus par hôte et par fenêtre (une heure), avec le nombre d'événements
 * depuis la ligne précédente pour cet hôte. Mémoire bornée : au-delà de `maxHosts` hôtes suivis dans la fenêtre, regroupés.
 */
export class RelayJournal {
  readonly #log: Logger;
  readonly #now: () => number;
  readonly #windowMs: number;
  readonly #maxHosts: number;
  readonly #seen = new Map<string, { at: number; hidden: number }>();

  constructor(log: Logger, now: () => number, windowMs: number, maxHosts: number) {
    this.#log = log;
    this.#now = now;
    this.#windowMs = windowMs;
    this.#maxHosts = maxHosts;
  }

  /** Vrai si une ligne est écrite pour cet événement ; `count` reçoit le nombre d'événements qu'elle résume. */
  #admit(key: string, write: (count: number, host: string) => void): boolean {
    const now = this.#now();
    let entryKey = key;
    let entry = this.#seen.get(entryKey);
    if (entry === undefined && this.#seen.size >= this.#maxHosts) {
      for (const [k, v] of this.#seen) if (now - v.at >= this.#windowMs) this.#seen.delete(k);
      if (this.#seen.size >= this.#maxHosts) {
        entryKey = `${key.slice(0, key.indexOf(":") + 1)}${OTHER_HOSTS}`;
        entry = this.#seen.get(entryKey);
      }
    }
    if (entry !== undefined && now - entry.at < this.#windowMs) {
      entry.hidden++;
      return false;
    }
    write((entry?.hidden ?? 0) + 1, entryKey.slice(entryKey.indexOf(":") + 1));
    this.#seen.set(entryKey, { at: now, hidden: 0 });
    return true;
  }

  /** Sortie refusée localement (rien n'est parti vers le proxy de l'entreprise). */
  refused(host: string, port: number, reason: EgressRefusalReason): boolean {
    return this.#admit(`refus:${hostForLog(host)}`, (count, shown) =>
      this.#log.warn("sortie d'opencode refusée par le relais du cockpit (refus local, rien n'est envoyé au proxy de l'entreprise)", {
        hote: shown,
        port: Number.isInteger(port) && port >= 0 && port <= 65535 ? port : 0,
        raison: reason,
        refus: count,
      }),
    );
  }

  /** Sortie permise mais en échec (proxy de l'entreprise qui refuse, délai, réseau). */
  upstreamFailed(host: string, motive: string): boolean {
    return this.#admit(`amont:${hostForLog(host)}`, (count, shown) =>
      this.#log.warn("sortie d'opencode permise, en échec en amont", { hote: shown, motif: motive.slice(0, 120), echecs: count }),
    );
  }
}

/** Réseau IPv4 : adresse du cockpit, base et masque (entiers non signés), notation CIDR pour le journal. */
export interface InternalNetwork {
  address: string;
  base: number;
  mask: number;
  cidr: string;
}

function ipv4ToInt(ip: string): number | null {
  if (net.isIPv4(ip) === false) return null;
  return ip.split(".").reduce((acc, part) => ((acc << 8) | Number(part)) >>> 0, 0);
}

/**
 * Réseau interne : l'interface IPv4 du cockpit qui partage le sous-réseau d'une adresse du pair (opencode). null si aucune, ou si
 * le masque est vide (/0 couvrirait tout).
 */
export function findInternalNetwork(peerAddresses: readonly string[], interfaces: NodeJS.Dict<os.NetworkInterfaceInfo[]>): InternalNetwork | null {
  const entries = Object.values(interfaces).flatMap((list) => list ?? []);
  for (const peer of peerAddresses) {
    const peerInt = ipv4ToInt(peer);
    if (peerInt === null) continue;
    for (const entry of entries) {
      const network = sharedNetwork(peerInt, entry);
      if (network !== null) return network;
    }
  }
  return null;
}

/** Réseau de l'interface s'il contient l'adresse du pair ; masque vide ou non contigu : null. */
function sharedNetwork(peerInt: number, entry: os.NetworkInterfaceInfo): InternalNetwork | null {
  if (entry.family !== "IPv4") return null;
  const address = ipv4ToInt(entry.address);
  const mask = ipv4ToInt(entry.netmask);
  if (address === null || mask === null || mask === 0) return null;
  const prefix = 32 - Math.log2(((~mask >>> 0) + 1) >>> 0 || 2 ** 32);
  if (!Number.isInteger(prefix)) return null;
  const base = (address & mask) >>> 0;
  if (((peerInt & mask) >>> 0) !== base) return null;
  const baseText = [24, 16, 8, 0].map((shift) => (base >>> shift) & 255).join(".");
  return { address: entry.address, base, mask, cidr: `${baseText}/${prefix}` };
}

/** Adresse distante dans le réseau interne (IPv4, ou IPv4 écrite en IPv6 « ::ffff: »). */
export function inNetwork(remote: string | undefined, network: Pick<InternalNetwork, "base" | "mask">): boolean {
  const value = ipv4ToInt((remote ?? "").replace(/^::ffff:/i, ""));
  return value !== null && ((value & network.mask) >>> 0) === network.base;
}

const PORTS_BY_SCHEME: Readonly<Record<string, number>> = { "http:": 80, "https:": 443 };

/** Cible d'une demande ordinaire (URI absolue d'un proxy HTTP), pour le journal : hôte et port, "" et 0 si illisible. */
function requestTarget(url: string): { host: string; port: number } {
  try {
    const u = new URL(url);
    return { host: u.hostname, port: u.port === "" ? (PORTS_BY_SCHEME[u.protocol] ?? 0) : Number(u.port) };
  } catch {
    return { host: "", port: 0 };
  }
}

/**
 * Seule forme de User-Agent qu'opencode envoie au relais (runtime Bun ; l'espion de la 1.0.6 voit « Bun/1.3 ») : « Bun/x.y » ou
 * « Bun/x.y.z », 1 à 3 chiffres par nombre.
 */
const OPENCODE_USER_AGENT = /^Bun\/\d{1,3}\.\d{1,3}(?:\.\d{1,3})?$/;

/**
 * User-Agent recopié dans le CONNECT envoyé au proxy de l'entreprise (RR-2, décision D9) : celui d'opencode tel quel, pour que ce
 * proxy voie ce qu'il voyait depuis la 1.0.5 ; toute autre valeur, jamais (aucun en-tête) : une commande fabriquée ne peut rien
 * écrire dans ses journaux.
 */
export function relayedUserAgent(value: string | undefined): string | null {
  return typeof value === "string" && OPENCODE_USER_AGENT.test(value) ? value : null;
}

function userAgentOf(req: http.IncomingMessage): string | null {
  return relayedUserAgent(req.headers["user-agent"]);
}

export interface EgressRelayOptions {
  /** Hôtes permis à l'instant de la demande (egressAllowedHosts), noms canoniques. Une erreur vaut liste vide : tout est refusé. */
  allowedHosts: () => ReadonlySet<string>;
  /**
   * Heure (horloge `now`) à laquelle un tunnel vers cet hôte est coupé au plus tard, null sans échéance (egressTunnelDeadline).
   * Relue à l'échéance : une fenêtre prolongée entre-temps repousse la coupure. Absente : seule la revue périodique s'applique.
   */
  tunnelDeadline?: (host: string) => number | null;
  /** Proxy de l'entreprise ; null : sortie directe ; erreur : configuration illisible, aucune sortie (502). */
  upstream: UpstreamProxy | null | RelayConfigError;
  log: Logger;
  /** Connexions acceptées (adresse distante) ; toutes par défaut (tests). */
  acceptFrom?: (remote: string | undefined) => boolean;
  /** Connexion sortante ; les tests la dirigent vers un serveur local. */
  connect?: (host: string, port: number) => net.Socket;
  now?: () => number;
  limits?: Partial<RelayLimits>;
}

export interface EgressRelay {
  readonly server: http.Server;
  readonly journal: RelayJournal;
  /** Écoute sur une adresse IPv4 précise, jamais 0.0.0.0 ; rend le port. */
  listen(port: number, address: string): Promise<number>;
  /** Plus d'écoute ; connexions et tunnels coupés. */
  close(): Promise<void>;
}

/** Tunnel ouvert ou en cours d'ouverture : hôte canonique, coupure, minuteur de son échéance. */
interface Tunnel {
  readonly host: string;
  readonly cut: () => void;
  deadline: NodeJS.Timeout | undefined;
}

export function createEgressRelay(options: EgressRelayOptions): EgressRelay {
  const limits: RelayLimits = { ...RELAY_LIMITS, ...options.limits };
  const { log } = options;
  const now = options.now ?? Date.now;
  const connect = options.connect ?? ((host: string, port: number) => net.connect({ host, port }));
  const acceptFrom = options.acceptFrom ?? (() => true);
  const journal = new RelayJournal(log, now, limits.logWindowMs, limits.logHostsMax);
  const open = new Set<net.Socket>();
  let lastAllowed = "";
  let unreadable = false;

  const track = (socket: net.Socket) => {
    open.add(socket);
    socket.once("close", () => open.delete(socket));
  };

  const tunnels = new Set<Tunnel>();
  let review: NodeJS.Timeout | undefined;

  const forget = (tunnel: Tunnel) => {
    tunnels.delete(tunnel);
    clearTimeout(tunnel.deadline);
    tunnel.deadline = undefined;
    if (tunnels.size === 0 && review !== undefined) {
      clearInterval(review);
      review = undefined;
    }
  };

  /** Coupe un tunnel dont l'hôte n'est plus permis (ou dont l'échéance est passée), avec une ligne au journal par tunnel. */
  const revoke = (tunnel: Tunnel, motive: "liste" | "echeance") => {
    if (!tunnels.has(tunnel)) return;
    forget(tunnel);
    log.info("relais du cockpit : tunnel coupé, hôte plus permis", { hote: tunnel.host, motif: motive });
    tunnel.cut();
  };

  /**
   * Hôtes permis ; tout changement de la liste est tracé une fois (audit), et chaque tunnel ouvert dont l'hôte n'y est plus est
   * coupé. Liste illisible (exception) : liste vide, donc tout refusé et tout coupé, sans faire tomber le cockpit.
   */
  const allowed = (): ReadonlySet<string> => {
    let hosts: ReadonlySet<string>;
    try {
      hosts = options.allowedHosts();
      unreadable = false;
    } catch (err) {
      if (!unreadable) log.error("relais du cockpit : liste des hôtes permis illisible, tout est refusé", { error: errorMessage(err) });
      unreadable = true;
      hosts = new Set();
    }
    const sorted = [...hosts].sort((a, b) => a.localeCompare(b));
    const signature = sorted.join(",");
    if (signature !== lastAllowed) {
      lastAllowed = signature;
      log.info("relais du cockpit : hôtes permis pour opencode", { hotes: sorted });
    }
    for (const tunnel of [...tunnels]) if (!hosts.has(tunnel.host)) revoke(tunnel, "liste");
    return hosts;
  };

  /**
   * Minuteur de l'échéance du tunnel (tunnelDeadline). À l'échéance, la liste est relue : hôte plus permis, tunnel coupé ;
   * fenêtre prolongée, nouvelle échéance. Une échéance passée pour un hôte encore permis coupe aussi (règle incohérente : on ferme).
   */
  const armDeadline = (tunnel: Tunnel) => {
    let at: number | null;
    try {
      at = options.tunnelDeadline?.(tunnel.host) ?? null;
    } catch {
      at = 0;
    }
    if (at === null) return;
    const delay = at - now();
    if (!(delay > 0)) {
      revoke(tunnel, "echeance");
      return;
    }
    tunnel.deadline = setTimeout(() => {
      tunnel.deadline = undefined;
      allowed();
      if (tunnels.has(tunnel)) armDeadline(tunnel);
    }, Math.min(delay, MAX_TIMER_MS));
    tunnel.deadline.unref();
  };

  /** Suit un tunnel jusqu'à sa fermeture : revue périodique de la liste tant qu'il en reste un, et son échéance éventuelle. */
  const watch = (host: string, cut: () => void, sockets: readonly net.Socket[]) => {
    const tunnel: Tunnel = { host, cut, deadline: undefined };
    tunnels.add(tunnel);
    for (const socket of sockets) socket.once("close", () => forget(tunnel));
    if (review === undefined) {
      review = setInterval(() => allowed(), limits.revalidateMs);
      review.unref();
    }
    armDeadline(tunnel);
  };

  /**
   * Réponse finale sur une connexion détachée du serveur HTTP : ce que le client envoie encore est lu et jeté pour voir sa fermeture,
   * et la connexion est détruite au bout du délai s'il ne ferme pas (elle compterait sinon dans maxConnections).
   */
  const replyAndClose = (socket: net.Socket, response: string) => {
    const timer = setTimeout(() => socket.destroy(), limits.closeDelayMs);
    socket.once("close", () => clearTimeout(timer));
    socket.resume();
    socket.end(response);
  };

  /** Tunnel vers l'hôte permis (nom canonique, jamais la cible écrite par le client), direct ou par le proxy de l'entreprise. */
  const openTunnel = (client: net.Socket, head: Buffer, host: string, userAgent: string | null) => {
    const upstream = options.upstream;
    if (upstream instanceof RelayConfigError) {
      journal.upstreamFailed(host, "proxy de l'entreprise illisible (HTTPS_PROXY) : aucune sortie directe");
      replyAndClose(client, RESPONSE_502);
      return;
    }
    const remote = upstream === null ? connect(host, EGRESS_PORT) : connect(upstream.host, upstream.port);
    track(remote);
    let state: "wait" | "open" | "done" = "wait";
    const fail = (motive: string) => {
      if (state !== "wait") return;
      state = "done";
      journal.upstreamFailed(host, motive);
      remote.destroy();
      replyAndClose(client, RESPONSE_502);
    };
    const link = (rest: Buffer) => {
      if (state !== "wait") return;
      state = "open";
      client.write(RESPONSE_200);
      if (rest.length > 0) client.write(rest);
      if (head.length > 0) remote.write(head);
      client.pipe(remote);
      remote.pipe(client);
      const idle = () => {
        client.destroy();
        remote.destroy();
      };
      remote.setTimeout(limits.idleTimeoutMs, idle);
      client.setTimeout(limits.idleTimeoutMs, idle);
      log.debug("relais du cockpit : tunnel ouvert", { hote: host });
    };
    remote.setTimeout(limits.upstreamTimeoutMs, () => fail("délai dépassé"));
    // Après un échec, la fermeture de la sortie ne touche plus au client : son 502 part d'abord.
    const endRemote = (motive: string) => {
      if (state === "wait") fail(motive);
      else if (state === "open") client.destroy();
    };
    remote.on("error", (err: NodeJS.ErrnoException) => endRemote(err.code ?? errorMessage(err)));
    remote.once("close", () => endRemote("connexion fermée"));
    client.once("close", () => {
      if (state === "wait") state = "done";
      remote.destroy();
    });
    // Connexions du serveur HTTP à moitié ouvertes (allowHalfOpen) : un client qui finit avant le tunnel l'abandonne tout de suite.
    client.once("end", () => {
      if (state !== "wait") return;
      state = "done";
      remote.destroy();
      client.destroy();
    });
    // Suivi jusqu'à la fermeture, ouverture comprise : un hôte retiré de la liste avant la réponse du proxy n'obtient jamais 200.
    watch(
      host,
      () => {
        state = "done";
        client.destroy();
        remote.destroy();
      },
      [client, remote],
    );
    if (upstream === null) {
      remote.once("connect", () => link(Buffer.alloc(0)));
      return;
    }
    remote.once("connect", () => {
      const lines = [`CONNECT ${host}:${EGRESS_PORT} HTTP/1.1`, `Host: ${host}:${EGRESS_PORT}`];
      if (userAgent !== null) lines.push(`User-Agent: ${userAgent}`);
      if (upstream.authorization !== null) lines.push(`Proxy-Authorization: ${upstream.authorization}`);
      remote.write(`${lines.join("\r\n")}\r\n\r\n`);
    });
    let buffer = Buffer.alloc(0);
    const read = (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk]);
      const end = buffer.indexOf("\r\n\r\n");
      if (end === -1) {
        if (buffer.length > limits.upstreamHeaderBytes) fail("réponse du proxy de l'entreprise trop longue");
        return;
      }
      // Plus de lecture ici : link() branche la sortie sur le client dans ce même tour, aucun octet ne se perd entre les deux.
      remote.off("data", read);
      // Seul le code de statut est lu et tracé : le reste de la réponse peut citer des identifiants ou des adresses internes.
      const status = /^HTTP\/1\.[01] (\d{3})\b/.exec(buffer.subarray(0, Math.min(end, 64)).toString("latin1"))?.[1];
      if (!status?.startsWith("2")) {
        fail(`proxy de l'entreprise : réponse ${status ?? "illisible"}`);
        return;
      }
      link(buffer.subarray(end + 4));
    };
    remote.on("data", read);
  };

  // requireHostHeader: false : une demande sans Host est refusée ET tracée ici, pas rejetée par Node avant.
  const server = http.createServer({
    maxHeaderSize: limits.maxHeaderBytes,
    headersTimeout: limits.headersTimeoutMs,
    requestTimeout: limits.headersTimeoutMs,
    connectionsCheckingInterval: Math.min(1_000, limits.headersTimeoutMs),
    requireHostHeader: false,
  });
  server.maxConnections = limits.maxConnections;

  // Connexion venue d'ailleurs que le réseau interne : coupée avant tout octet lu (l'écoute est déjà limitée à ce réseau).
  server.on("connection", (socket: net.Socket) => {
    if (acceptFrom(socket.remoteAddress)) return;
    journal.refused(socket.remoteAddress ?? "", 0, "origine");
    socket.destroy();
  });

  server.on("connect", (req: http.IncomingMessage, duplex: Duplex, head: Buffer) => {
    const socket = duplex as net.Socket;
    socket.on("error", () => socket.destroy());
    track(socket);
    const decision = decideConnect(req.url ?? "", allowed());
    if (!decision.allow) {
      journal.refused(decision.host, decision.port, decision.reason);
      replyAndClose(socket, RESPONSE_403);
      return;
    }
    openTunnel(socket, head, decision.host, userAgentOf(req));
  });

  // Toute demande qui n'est pas un CONNECT (GET http://… d'un client HTTP, demande d'upgrade…) : refusée, raison « methode ».
  server.on("request", (req: http.IncomingMessage, res: http.ServerResponse) => {
    const { host, port } = requestTarget(req.url ?? "");
    journal.refused(host, port, "methode");
    res.writeHead(403, { "content-length": "0", connection: "close" });
    res.end();
  });

  // En-tête illisible, trop long (431) ou méthode inconnue : refus sans aucune sortie. Coupure ou délai : connexion détruite.
  server.on("clientError", (err: NodeJS.ErrnoException, duplex: Duplex) => {
    const socket = duplex as net.Socket;
    const code = err.code ?? "";
    if (code.startsWith("HPE_")) journal.refused("", 0, code === "HPE_INVALID_METHOD" ? "methode" : "invalide");
    if (socket.writable && code.startsWith("HPE_")) replyAndClose(socket, code === "HPE_HEADER_OVERFLOW" ? RESPONSE_431 : RESPONSE_400);
    else socket.destroy();
  });

  server.on("error", (err) => log.error("relais du cockpit : erreur du serveur", { error: errorMessage(err) }));

  return {
    server,
    journal,
    listen: (port, address) =>
      new Promise<number>((resolve, reject) => {
        // Jamais toutes les interfaces : le relais n'écoute que sur l'adresse du réseau interne.
        if (!net.isIPv4(address) || address === "0.0.0.0") {
          reject(new RelayConfigError("relais : adresse d'écoute IPv4 précise attendue (jamais 0.0.0.0)."));
          return;
        }
        const onError = (err: Error) => {
          server.off("listening", onListening);
          reject(err);
        };
        const onListening = () => {
          server.off("error", onError);
          resolve((server.address() as net.AddressInfo).port);
        };
        server.once("error", onError);
        server.once("listening", onListening);
        server.listen(port, address);
      }),
    close: () =>
      new Promise<void>((resolve) => {
        for (const tunnel of [...tunnels]) forget(tunnel);
        if (!server.listening) {
          for (const socket of open) socket.destroy();
          resolve();
          return;
        }
        server.close(() => resolve());
        server.closeAllConnections();
        for (const socket of open) socket.destroy();
      }),
  };
}

export interface RelayStartOptions {
  port: number;
  /** Nom du pair qui désigne le réseau interne (le service opencode). */
  peer: string;
  allowedHosts: () => ReadonlySet<string>;
  /** Échéance des tunnels (EgressRelayOptions.tunnelDeadline). */
  tunnelDeadline?: (host: string) => number | null;
  processEnv: NodeJS.ProcessEnv;
  log: Logger;
  /** Adresses IPv4 du pair (dns.lookup par défaut). */
  lookup?: (host: string) => Promise<string[]>;
  interfaces?: () => NodeJS.Dict<os.NetworkInterfaceInfo[]>;
  retryMs?: number;
  connect?: (host: string, port: number) => net.Socket;
}

export interface RelayHandle {
  /** Adresse et port d'écoute, null tant que le relais n'écoute pas. */
  listening(): { address: string; port: number } | null;
  stop(): Promise<void>;
}

const defaultLookup = async (host: string): Promise<string[]> => (await dns.lookup(host, { all: true, family: 4 })).map((entry) => entry.address);

/**
 * Démarre le relais dès que le réseau interne est trouvé (nouvel essai toutes les `retryMs` sinon). Tant qu'il n'écoute pas,
 * opencode n'a aucune sortie : ses demandes échouent sur place.
 */
export function startEgressRelay(o: RelayStartOptions): RelayHandle {
  const { log } = o;
  const lookup = o.lookup ?? defaultLookup;
  const interfaces = o.interfaces ?? (() => os.networkInterfaces());
  const retryMs = o.retryMs ?? RELAY_RETRY_MS;
  let upstream: UpstreamProxy | null | RelayConfigError;
  try {
    upstream = readUpstreamProxy(o.processEnv);
  } catch (err) {
    upstream = err instanceof RelayConfigError ? err : new RelayConfigError(errorMessage(err));
    log.error("relais du cockpit : proxy de l'entreprise illisible, les sorties permises échoueront (aucune ne part en direct)", { error: upstream.message });
  }
  let relay: EgressRelay | null = null;
  let bound: { address: string; port: number } | null = null;
  let timer: NodeJS.Timeout | undefined;
  let stopped = false;
  let warned = false;

  const retry = (message: string, fields: Record<string, unknown>) => {
    if (!warned) {
      warned = true;
      log.warn(message, { ...fields, nouvelEssaiS: Math.round(retryMs / 1000) });
    }
    timer = setTimeout(() => void attempt(), retryMs);
  };

  // Hôte et port seulement, jamais les identifiants.
  const upstreamLabel = (): string | null => {
    if (upstream === null) return null;
    if (upstream instanceof RelayConfigError) return "illisible";
    return `${upstream.host}:${upstream.port}`;
  };

  const attempt = async (): Promise<void> => {
    if (stopped) return;
    let found: InternalNetwork | null = null;
    let lookupError: string | null = null;
    try {
      found = findInternalNetwork(await lookup(o.peer), interfaces());
    } catch (err) {
      lookupError = errorMessage(err);
    }
    if (stopped) return;
    if (found === null) {
      retry("relais du cockpit en attente : réseau interne d'opencode introuvable, opencode n'a aucune sortie en attendant", {
        pair: o.peer,
        ...(lookupError === null ? {} : { error: lookupError }),
      });
      return;
    }
    const network = found;
    const candidate = createEgressRelay({
      allowedHosts: o.allowedHosts,
      tunnelDeadline: o.tunnelDeadline,
      upstream,
      log,
      acceptFrom: (remote) => inNetwork(remote, network),
      connect: o.connect,
    });
    try {
      const port = await candidate.listen(o.port, network.address);
      if (stopped) {
        await candidate.close();
        return;
      }
      relay = candidate;
      bound = { address: network.address, port };
      log.info("relais du cockpit à l'écoute pour opencode (réseau interne seulement)", {
        adresse: network.address,
        port,
        reseau: network.cidr,
        proxyEntreprise: upstreamLabel(),
      });
    } catch (err) {
      await candidate.close();
      retry("relais du cockpit : écoute impossible, opencode n'a aucune sortie en attendant", { error: errorMessage(err) });
    }
  };

  void attempt();
  return {
    listening: () => bound,
    stop: async () => {
      stopped = true;
      if (timer !== undefined) clearTimeout(timer);
      await relay?.close();
      bound = null;
    },
  };
}
