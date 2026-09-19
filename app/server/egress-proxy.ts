// Proxy de sortie `egress` de la salle (spéc. §3.15.2 l.518-522, JS-8, G1 ; plan D-2b-13) : lancé par `node server/egress-proxy.ts`
// dans l'image du cockpit, sans dépendance npm. Seul `CONNECT <hôte de l'API Copilot en vigueur>:443` ouvre un tunnel, direct ou
// chaîné au proxy d'entreprise (HTTPS_PROXY, https_proxy) ; toute autre demande reçoit 403 et entre au journal des refus
// (egress-journal.ts), sans chemin, sans en-tête, sans identifiant.
//
// - Hôte autorisé lu UNE fois au démarrage : COCKPIT_COPILOT_API_URL (et COCKPIT_GITHUB_ENTERPRISE_DOMAIN), validée comme en 1.0.3,
//   sinon l'adresse d'office ; adresse refusée : egress ne démarre pas. Un changement d'adresse demande de relancer l'installation.
// - Écoute 0.0.0.0:3128 (contrat de la salle) ; journal dans COCKPIT_EGRESS_JOURNAL (défaut /egress-log), qui doit être inscriptible.
// - Arrêt propre sur SIGTERM et SIGINT : plus d'écoute, tunnels coupés, journal écrit, code 0 (PID 1 dans le conteneur : sans ces
//   gestionnaires, Docker attendrait puis tuerait le processus).
// - `--sonde` : connexion locale au port d'écoute, code 0 s'il répond, 1 sinon (healthcheck du service `egress`, branché par L16b).
// Les identifiants du proxy d'entreprise ne sortent que dans l'en-tête Proxy-Authorization envoyé à ce proxy : jamais tracés.
import http from "node:http";
import net from "node:net";
import type { Duplex } from "node:stream";
import { EGRESS_JOURNAL_DOSSIER_DEFAUT, type EgressRefus, hotePourJournal, JournalRefus } from "./egress-journal.ts";
import { errorMessage, type Logger, createLogger } from "./log.ts";
import { decoupeCibleConnect, EGRESS_PORT_AUTORISE, egressAllow, egressHoteAutorise, type EgressRefusalReason } from "./shared/egress-allow.ts";

/** Port d'écoute d'egress (contrat de la salle : egress.port). */
export const EGRESS_PORT_ECOUTE = 3128;
export const EGRESS_HOTE_ECOUTE = "0.0.0.0";
/** Connexion sortante (ou réponse du proxy d'entreprise) attendue au plus avant 502. */
export const EGRESS_DELAI_AMONT_MS = 15_000;
/** Délai de la sonde du healthcheck. */
export const EGRESS_DELAI_SONDE_MS = 2_000;
/** Connexions entrantes simultanées au plus : la salle ne peut pas épuiser egress. */
export const EGRESS_CONNEXIONS_MAX = 256;
/** Connexion refusée (403, 502) gardée au plus, le temps que le client lise la réponse et ferme. */
export const EGRESS_DELAI_FERMETURE_MS = 5_000;
/** En-tête de réponse du proxy d'entreprise lu au plus. */
export const EGRESS_ENTETE_AMONT_MAX = 16 * 1024;

const REPONSE_200 = "HTTP/1.1 200 Connection Established\r\n\r\n";
const REPONSE_400 = "HTTP/1.1 400 Bad Request\r\nContent-Length: 0\r\nConnection: close\r\n\r\n";
const REPONSE_403 = "HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\nConnection: close\r\n\r\n";
const REPONSE_502 = "HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\nConnection: close\r\n\r\n";

export class EgressConfigError extends Error {
  override name = "EgressConfigError";
}

/** Proxy d'entreprise : hôte et port ; autorisation « Basic … » prête à envoyer, null sans identifiants. */
export interface ProxyEntreprise {
  hote: string;
  port: number;
  autorisation: string | null;
}

/**
 * Proxy d'entreprise déclaré (HTTPS_PROXY, sinon https_proxy) : http:// seulement (schéma absent = http://), sans chemin ni
 * paramètre ; port absent = 80. null : aucun, tunnel direct. Les messages d'erreur ne citent jamais la valeur (identifiants).
 */
export function lireProxyEntreprise(env: NodeJS.ProcessEnv): ProxyEntreprise | null {
  const brut = env.HTTPS_PROXY?.trim() || env.https_proxy?.trim() || "";
  if (brut === "") return null;
  let url: URL;
  try {
    url = new URL(brut.includes("://") ? brut : `http://${brut}`);
  } catch {
    throw new EgressConfigError("HTTPS_PROXY : adresse illisible.");
  }
  if (url.protocol !== "http:") throw new EgressConfigError("HTTPS_PROXY : seul un proxy d'entreprise en http:// est pris en charge.");
  if (url.pathname !== "/" || url.search !== "" || url.hash !== "") throw new EgressConfigError("HTTPS_PROXY : l'adresse ne doit porter ni chemin ni paramètre.");
  // Hôte jamais vide ici : l'analyseur d'URL refuse « http://:8080 ». Crochets d'une IPv6 retirés pour net.connect.
  const hote = url.hostname.startsWith("[") ? url.hostname.slice(1, -1) : url.hostname;
  let autorisation: string | null = null;
  if (url.username !== "" || url.password !== "") {
    let identifiants: string;
    try {
      identifiants = `${decodeURIComponent(url.username)}:${decodeURIComponent(url.password)}`;
    } catch {
      throw new EgressConfigError("HTTPS_PROXY : identifiants mal encodés.");
    }
    autorisation = `Basic ${Buffer.from(identifiants, "utf8").toString("base64")}`;
  }
  return { hote, port: url.port === "" ? 80 : Number(url.port), autorisation };
}

export interface ArgumentsEgress {
  sonde: boolean;
  port: number;
  hote: string;
}

function lirePort(valeur: string): number {
  const port = /^\d{1,5}$/.test(valeur) ? Number(valeur) : -1;
  if (port < 0 || port > 65535) throw new EgressConfigError("--port : numéro de port refusé.");
  return port;
}

function lireHote(valeur: string): string {
  if (net.isIP(valeur) === 0) throw new EgressConfigError("--hote : adresse IP attendue.");
  return valeur;
}

/** `--sonde`, `--port <n>` (3128 d'office ; 0 = choisi par le système, sauf pour la sonde), `--hote <adresse IP>` (0.0.0.0 d'office). */
export function analyserArguments(argv: readonly string[]): ArgumentsEgress {
  const lus: ArgumentsEgress = { sonde: false, port: EGRESS_PORT_ECOUTE, hote: EGRESS_HOTE_ECOUTE };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] ?? "";
    if (arg === "--sonde") {
      lus.sonde = true;
      continue;
    }
    if (arg !== "--port" && arg !== "--hote") throw new EgressConfigError(`argument inconnu : ${arg.slice(0, 40)}`);
    const valeur = argv[++i];
    if (valeur === undefined) throw new EgressConfigError(`${arg} : valeur manquante.`);
    if (arg === "--port") lus.port = lirePort(valeur);
    else lus.hote = lireHote(valeur);
  }
  if (lus.sonde && lus.port === 0) throw new EgressConfigError("--sonde : un port d'écoute précis est attendu.");
  return lus;
}

/** Healthcheck : vrai si une connexion locale au port aboutit en `delaiMs` au plus. N'envoie rien : aucune ligne au journal. */
export function sonder(port: number, hote = "127.0.0.1", delaiMs = EGRESS_DELAI_SONDE_MS): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect({ port, host: hote });
    let fini = false;
    const fin = (ok: boolean) => {
      if (fini) return;
      fini = true;
      clearTimeout(minuteur);
      if (ok) socket.end();
      else socket.destroy();
      resolve(ok);
    };
    const minuteur = setTimeout(() => fin(false), delaiMs);
    socket.once("connect", () => fin(true));
    socket.once("error", () => fin(false));
  });
}

const PORTS_PAR_SCHEMA: Readonly<Record<string, number>> = { "http:": 80, "https:": 443 };

/** Cible d'une demande ordinaire, pour le journal : hôte et port d'une URI absolue ; "" et 0 pour un chemin seul (URL illisible). */
function cibleRequete(url: string): { hote: string; port: number } {
  try {
    const u = new URL(url);
    return { hote: u.hostname, port: u.port === "" ? (PORTS_PAR_SCHEMA[u.protocol] ?? 0) : Number(u.port) };
  } catch {
    return { hote: "", port: 0 };
  }
}

export interface ProxySortieOptions {
  /** Lu une fois au démarrage (egressHoteAutorise) ; jamais relu ensuite. */
  hoteAutorise: string;
  proxyEntreprise?: ProxyEntreprise | null;
  journal?: Pick<JournalRefus, "ecrire"> | null;
  log: Logger;
  /** Horloge des lignes du journal (injectée par les tests). */
  maintenant?: () => number;
  /** Connexion sortante (hôte autorisé:443, ou proxy d'entreprise) ; les tests la dirigent vers un serveur d'écho local. */
  connecter?: (hote: string, port: number) => net.Socket;
  delaiAmontMs?: number;
  delaiFermetureMs?: number;
  connexionsMax?: number;
}

export interface ProxySortie {
  /** Serveur HTTP (les tests l'écoutent sur un port accepté par fetch). */
  readonly serveur: http.Server;
  ecouter(port: number, hote: string): Promise<number>;
  /** Plus d'écoute, connexions en cours et tunnels coupés. */
  fermer(): Promise<void>;
}

export function creerProxySortie(options: ProxySortieOptions): ProxySortie {
  const { hoteAutorise, log } = options;
  const proxy = options.proxyEntreprise ?? null;
  const maintenant = options.maintenant ?? Date.now;
  const connecter = options.connecter ?? ((hote: string, port: number) => net.connect({ host: hote, port }));
  const delaiAmont = options.delaiAmontMs ?? EGRESS_DELAI_AMONT_MS;
  const delaiFermeture = options.delaiFermetureMs ?? EGRESS_DELAI_FERMETURE_MS;
  const ouverts = new Set<net.Socket>();

  const suivre = (socket: net.Socket) => {
    ouverts.add(socket);
    socket.once("close", () => ouverts.delete(socket));
  };

  /**
   * Réponse finale sur une connexion détachée du serveur HTTP (après CONNECT) : ce que le client envoie encore est lu et jeté pour que
   * sa fermeture soit vue, et la connexion est détruite au bout du délai s'il ne ferme pas (sinon elle resterait ouverte et compterait
   * dans connexionsMax).
   */
  const repondreEtFermer = (socket: net.Socket, reponse: string) => {
    const minuteur = setTimeout(() => socket.destroy(), delaiFermeture);
    socket.once("close", () => clearTimeout(minuteur));
    socket.resume();
    socket.end(reponse);
  };

  const refuser = (raison: EgressRefusalReason, methode: string, hote: string, port: number) => {
    const refus: EgressRefus = { at: maintenant(), hote, port, raison };
    options.journal?.ecrire(refus);
    log.debug("sortie refusée", { raison, methode, hote: hotePourJournal(hote), port });
  };

  /** Tunnel vers l'hôte autorisé (jamais vers l'écriture du client), direct ou par le proxy d'entreprise. */
  const ouvrirTunnel = (client: net.Socket, head: Buffer) => {
    const amont = proxy === null ? connecter(hoteAutorise, EGRESS_PORT_AUTORISE) : connecter(proxy.hote, proxy.port);
    suivre(amont);
    let etat: "attente" | "etabli" | "fini" = "attente";
    const echouer = (motif: string) => {
      if (etat !== "attente") return;
      etat = "fini";
      log.warn("sortie impossible", { motif, vers: proxy === null ? hoteAutorise : "proxy d'entreprise" });
      amont.destroy();
      repondreEtFermer(client, REPONSE_502);
    };
    const relier = (reste: Buffer) => {
      if (etat !== "attente") return;
      etat = "etabli";
      amont.setTimeout(0);
      client.write(REPONSE_200);
      if (reste.length > 0) client.write(reste);
      if (head.length > 0) amont.write(head);
      client.pipe(amont);
      amont.pipe(client);
      log.debug("tunnel ouvert", { hote: hoteAutorise });
    };
    amont.setTimeout(delaiAmont, () => echouer("délai dépassé"));
    // Après un échec (état « fini »), la fermeture de l'amont ne touche plus au client : son 502 part d'abord.
    const finAmont = (motif: string) => {
      if (etat === "attente") echouer(motif);
      else if (etat === "etabli") client.destroy();
    };
    amont.on("error", (err) => finAmont(errorMessage(err)));
    amont.once("close", () => finAmont("connexion fermée"));
    client.once("close", () => {
      if (etat === "attente") etat = "fini";
      amont.destroy();
    });
    // Fin de flux du client avant le tunnel : les connexions du serveur HTTP restent à moitié ouvertes (allowHalfOpen), « close »
    // ne viendrait qu'au délai d'amont ; tunnel abandonné tout de suite. Tunnel établi : la demi-fermeture passe par pipe.
    client.once("end", () => {
      if (etat !== "attente") return;
      etat = "fini";
      amont.destroy();
      client.destroy();
    });
    if (proxy === null) {
      amont.once("connect", () => relier(Buffer.alloc(0)));
      return;
    }
    amont.once("connect", () => {
      const lignes = [`CONNECT ${hoteAutorise}:${EGRESS_PORT_AUTORISE} HTTP/1.1`, `Host: ${hoteAutorise}:${EGRESS_PORT_AUTORISE}`];
      if (proxy.autorisation !== null) lignes.push(`Proxy-Authorization: ${proxy.autorisation}`);
      amont.write(`${lignes.join("\r\n")}\r\n\r\n`);
    });
    let tampon = Buffer.alloc(0);
    const lire = (morceau: Buffer) => {
      tampon = Buffer.concat([tampon, morceau]);
      const finEntete = tampon.indexOf("\r\n\r\n");
      if (finEntete === -1) {
        if (tampon.length > EGRESS_ENTETE_AMONT_MAX) echouer("réponse du proxy d'entreprise trop longue");
        return;
      }
      // Plus de lecture ici : relier() branche l'amont sur le client dans ce même tour, aucun octet ne se perd entre les deux.
      amont.off("data", lire);
      // Seul le code de statut est lu et tracé : le reste de la réponse peut citer des identifiants ou des adresses internes.
      const statut = /^HTTP\/1\.[01] (\d{3})\b/.exec(tampon.subarray(0, Math.min(finEntete, 64)).toString("latin1"))?.[1];
      if (!statut?.startsWith("2")) {
        echouer(`proxy d'entreprise : réponse ${statut ?? "illisible"}`);
        return;
      }
      relier(tampon.subarray(finEntete + 4));
    };
    amont.on("data", lire);
  };

  // requireHostHeader: false : une demande ordinaire sans Host est refusée ET journalisée ici, pas rejetée en 400 par Node avant.
  const serveur = http.createServer({ requireHostHeader: false });
  serveur.maxConnections = options.connexionsMax ?? EGRESS_CONNEXIONS_MAX;

  serveur.on("connect", (req: http.IncomingMessage, duplex: Duplex, head: Buffer) => {
    const socket = duplex as net.Socket;
    socket.on("error", () => socket.destroy());
    suivre(socket);
    const { hote, port } = decoupeCibleConnect(req.url ?? "");
    const decision = egressAllow(hote, port, hoteAutorise);
    if (!decision.autorise) {
      refuser(decision.raison, "CONNECT", hote, port);
      repondreEtFermer(socket, REPONSE_403);
      return;
    }
    ouvrirTunnel(socket, head);
  });

  // Toute demande qui n'est pas un CONNECT (GET en URI absolue, demande d'upgrade…) : refusée, raison « methode ».
  serveur.on("request", (req: http.IncomingMessage, res: http.ServerResponse) => {
    const { hote, port } = cibleRequete(req.url ?? "");
    refuser("methode", req.method ?? "", hote, port);
    res.writeHead(403, { "content-length": "0", connection: "close" });
    res.end();
  });

  // Méthode inconnue ou écrite en minuscules (« connect ») : rejetée par l'analyseur de Node avant tout événement, journalisée ici.
  // Toute demande illisible reçoit 400 ; une connexion déjà coupée (ECONNRESET) est seulement détruite.
  serveur.on("clientError", (err: NodeJS.ErrnoException, duplex: Duplex) => {
    const socket = duplex as net.Socket;
    if (err.code === "HPE_INVALID_METHOD") refuser("methode", "", "", 0);
    if (socket.writable) repondreEtFermer(socket, REPONSE_400);
    else socket.destroy();
  });

  // Erreur du serveur après l'écoute (plus de descripteurs…) : tracée, jamais fatale.
  serveur.on("error", (err) => log.error("proxy de sortie : erreur du serveur", { error: errorMessage(err) }));

  return {
    serveur,
    ecouter: (port, hote) =>
      new Promise<number>((resolve, reject) => {
        const onError = (err: Error) => {
          serveur.off("listening", onListening);
          reject(err);
        };
        const onListening = () => {
          serveur.off("error", onError);
          resolve((serveur.address() as net.AddressInfo).port);
        };
        serveur.once("error", onError);
        serveur.once("listening", onListening);
        serveur.listen(port, hote);
      }),
    fermer: () =>
      new Promise<void>((resolve) => {
        serveur.close(() => resolve());
        // Connexions HTTP en cours, en-têtes à moitié reçus compris, puis tunnels (détachés du serveur HTTP après CONNECT).
        serveur.closeAllConnections();
        for (const socket of ouverts) socket.destroy();
      }),
  };
}

export interface DependancesLancement {
  argv: readonly string[];
  env: NodeJS.ProcessEnv;
  log: Logger;
  /** Source de SIGTERM et SIGINT (process ; un émetteur dans les tests). */
  signaux: NodeJS.EventEmitter;
  sortir: (code: number) => void;
  maintenant?: () => number;
  /** Rendu dès l'écoute (tests). */
  onEcoute?: (proxy: ProxySortie, port: number) => void;
}

/** Démarrage d'egress (ou sonde) : configuration lue une fois, refus de démarrer au moindre doute, arrêt propre sur signal. */
export async function lancer(d: DependancesLancement): Promise<void> {
  const { log } = d;
  let args: ArgumentsEgress;
  try {
    args = analyserArguments(d.argv);
  } catch (err) {
    // Code 1, jamais 2 : Docker réserve 2 dans un healthcheck, et la sonde ne rend que 0 ou 1.
    log.error(`proxy de sortie : ${errorMessage(err)}`);
    d.sortir(1);
    return;
  }
  if (args.sonde) {
    d.sortir((await sonder(args.port)) ? 0 : 1);
    return;
  }

  const hoteAutorise = egressHoteAutorise(d.env.COCKPIT_COPILOT_API_URL, d.env.COCKPIT_GITHUB_ENTERPRISE_DOMAIN);
  if (hoteAutorise === null) {
    log.error(
      "proxy de sortie : COCKPIT_COPILOT_API_URL refusée, rien ne sort. Valeurs acceptées : https://api.business.githubcopilot.com, https://api.enterprise.githubcopilot.com, https://api.githubcopilot.com (ou copilot-api.<domaine GitHub Enterprise déclaré>).",
    );
    d.sortir(1);
    return;
  }
  let proxyEntreprise: ProxyEntreprise | null;
  try {
    proxyEntreprise = lireProxyEntreprise(d.env);
  } catch (err) {
    log.error(`proxy de sortie : ${errorMessage(err)}`);
    d.sortir(1);
    return;
  }
  const dossier = d.env.COCKPIT_EGRESS_JOURNAL?.trim() || EGRESS_JOURNAL_DOSSIER_DEFAUT;
  try {
    await JournalRefus.verifierDossier(dossier);
  } catch (err) {
    log.error("proxy de sortie : dossier du journal des refus inutilisable (COCKPIT_EGRESS_JOURNAL)", { error: errorMessage(err) });
    d.sortir(1);
    return;
  }
  const journal = new JournalRefus({
    dossier,
    onErreur: (err) => log.error("journal des refus : écriture impossible", { error: errorMessage(err) }),
    onPerte: (nombre) => log.warn("journal des refus : lignes perdues, trop de refus à la fois", { nombre }),
  });
  const proxy = creerProxySortie({ hoteAutorise, proxyEntreprise, journal, log, maintenant: d.maintenant });
  let port: number;
  try {
    port = await proxy.ecouter(args.port, args.hote);
  } catch (err) {
    log.error("proxy de sortie : écoute impossible", { error: errorMessage(err) });
    d.sortir(1);
    return;
  }
  log.info("proxy de sortie à l'écoute", {
    hote: args.hote,
    port,
    hoteAutorise,
    proxyEntreprise: proxyEntreprise === null ? null : `${proxyEntreprise.hote}:${proxyEntreprise.port}`,
  });

  let arret = false;
  const arreter = (signal: string) => {
    if (arret) return;
    arret = true;
    void arreterProprement(proxy, journal, log, signal, d.sortir);
  };
  // `on` comme main.ts : un second signal pendant l'arrêt est ignoré (sans gestionnaire, Node tuerait le processus sur-le-champ).
  d.signaux.on("SIGTERM", () => arreter("SIGTERM"));
  d.signaux.on("SIGINT", () => arreter("SIGINT"));
  d.onEcoute?.(proxy, port);
}

/** Arrêt propre : plus d'écoute ni de tunnel, puis journal écrit jusqu'à la dernière ligne, puis sortie 0. */
export async function arreterProprement(
  proxy: Pick<ProxySortie, "fermer">,
  journal: Pick<JournalRefus, "attendre">,
  log: Logger,
  signal: string,
  sortir: (code: number) => void,
): Promise<void> {
  await proxy.fermer();
  await journal.attendre();
  log.info("proxy de sortie arrêté", { signal });
  sortir(0);
}

if (import.meta.main) {
  await lancer({
    argv: process.argv.slice(2),
    env: process.env,
    log: createLogger(),
    signaux: process,
    // Code posé, puis sortie naturelle (le journal et la sortie standard se vident) ; filet si une poignée restait ouverte.
    sortir: (code) => {
      process.exitCode = code;
      setTimeout(() => process.exit(code), 3000).unref();
    },
  });
}
