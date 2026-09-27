// Proxy de sortie egress et journal des refus (L16a) : T-L16-a à T-L16-d par le proxy réel sur des connexions locales (node:net et
// http.request, jamais fetch), mode chaîné par un faux proxy d'entreprise, journal (rotation, agrégation 24 h, aucun identifiant),
// démarrage, arrêt propre et --sonde, en mémoire puis en processus enfant. Serveurs de test sur des ports acceptés par fetch
// (listenFetchable, ou nouvel essai si le système en rend un refusé) ; aucune pause fixe : attentes sur événement, bornées.
import assert from "node:assert/strict";
import { type ChildProcess, spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { describe, it, type TestContext } from "node:test";
import {
  EGRESS_FENETRE_DIAGNOSTIC_MS,
  EGRESS_HOTES_AGREGES_MAX,
  EGRESS_JOURNAL_FICHIER,
  EGRESS_JOURNAL_LECTURE_MAX,
  EGRESS_JOURNAL_MAX,
  EGRESS_JOURNAL_PRECEDENT,
  type EgressRefus,
  hotePourJournal,
  JournalRefus,
  lireSortiesRefusees,
} from "./egress-journal.ts";
import {
  analyserArguments,
  arreterProprement,
  creerProxySortie,
  EGRESS_PORT_ECOUTE,
  lancer,
  lireProxyEntreprise,
  type ProxySortie,
  type ProxySortieOptions,
  sonder,
} from "./egress-proxy.ts";
import { isFetchBlockedPort } from "./fetch-ports.ts";
import type { Logger } from "./log.ts";
import type { EgressRefusalReason } from "./shared/egress-allow.ts";
import { listenFetchable, until, within } from "./test-support/helpers.ts";

const COPILOT = "api.githubcopilot.com";
const T0 = Date.UTC(2026, 8, 18, 12, 0, 0);
const HEURE = 60 * 60_000;
const PROXY_SCRIPT = path.join(import.meta.dirname, "egress-proxy.ts");

// --- Aides ------------------------------------------------------------------------------------------------------------------------

/** Traces capturées, une ligne JSON par appel (message et champs). */
function logDeTest(): { log: Logger; lignes: string[] } {
  const lignes: string[] = [];
  const ecrire = (niveau: string) => (message: string, champs?: Record<string, unknown>) => {
    lignes.push(JSON.stringify({ niveau, message, ...champs }));
  };
  return { log: { debug: ecrire("debug"), info: ecrire("info"), warn: ecrire("warn"), error: ecrire("error") }, lignes };
}

function dossierTemporaire(t: TestContext): string {
  const dossier = fs.mkdtempSync(path.join(os.tmpdir(), "cockpit-egress-"));
  t.after(() => fs.rmSync(dossier, { recursive: true, force: true }));
  return dossier;
}

const lignesDuFichier = (fichier: string): string[] =>
  fs.existsSync(fichier) ? fs.readFileSync(fichier, "utf8").split("\n").filter((ligne) => ligne !== "") : [];

const fermerServeur = (serveur: net.Server, sockets: Iterable<net.Socket> = []): Promise<void> =>
  new Promise((resolve) => {
    for (const socket of sockets) socket.destroy();
    if (serveur.listening) serveur.close(() => resolve());
    else resolve();
  });

interface ServeurTcp {
  serveur: net.Server;
  port: number;
  sockets: Set<net.Socket>;
  fermees: number;
}

/** Serveur TCP local sur un port accepté par fetch ; connexions suivies, détruites à la fin du test. */
async function serveurTcp(t: TestContext, surConnexion: (socket: net.Socket) => void): Promise<ServeurTcp> {
  const etat: ServeurTcp = { serveur: net.createServer(), port: 0, sockets: new Set(), fermees: 0 };
  etat.serveur.on("connection", (socket) => {
    etat.sockets.add(socket);
    socket.on("error", () => undefined);
    socket.once("close", () => {
      etat.sockets.delete(socket);
      etat.fermees++;
    });
    surConnexion(socket);
  });
  etat.port = await listenFetchable(etat.serveur, "127.0.0.1");
  t.after(() => fermerServeur(etat.serveur, etat.sockets));
  return etat;
}

/** Port où plus rien n'écoute (connexion refusée). */
async function portFerme(): Promise<number> {
  const serveur = net.createServer();
  const port = await listenFetchable(serveur, "127.0.0.1");
  await fermerServeur(serveur);
  return port;
}

interface Client {
  socket: net.Socket;
  texte(): string;
  ferme: Promise<void>;
  estFerme(): boolean;
}

/** Clients encore ouverts, détruits à la fin de chaque test : une régression fait échouer le test, jamais attendre la suite sans fin. */
const clientsOuverts = new Set<net.Socket>();

/** Connexion brute au proxy : `envoi` écrit tel quel ; octets reçus gardés. allowHalfOpen : le client ne ferme pas de lui-même. */
function client(port: number, envoi?: string | Buffer, options: { allowHalfOpen?: boolean } = {}): Client {
  const socket = net.connect({ host: "127.0.0.1", port, allowHalfOpen: options.allowHalfOpen ?? false });
  clientsOuverts.add(socket);
  socket.once("close", () => clientsOuverts.delete(socket));
  let recu = Buffer.alloc(0);
  let ferme = false;
  socket.on("data", (bout: Buffer) => {
    recu = Buffer.concat([recu, bout]);
  });
  socket.on("error", () => undefined);
  const promesse = new Promise<void>((resolve) =>
    socket.once("close", () => {
      ferme = true;
      resolve();
    }),
  );
  if (envoi !== undefined) socket.write(envoi);
  return { socket, texte: () => recu.toString("latin1"), ferme: promesse, estFerme: () => ferme };
}

const connect = (cible: string, entetes: string[] = [`Host: ${cible}`]): string => `CONNECT ${cible} HTTP/1.1\r\n${entetes.map((e) => `${e}\r\n`).join("")}\r\n`;

/** Texte reçu une fois l'en-tête de réponse complet (ou la connexion fermée). */
async function reponse(c: Client): Promise<string> {
  await until(() => c.texte().includes("\r\n\r\n") || c.estFerme());
  return c.texte();
}

/** Demande ordinaire par http.request (jamais fetch) : code de statut. */
function demande(port: number, methode: string, chemin: string, entetes: Record<string, string> = {}, corps?: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, method: methode, path: chemin, headers: entetes, agent: false }, (res) => {
      res.resume();
      res.once("end", () => resolve(res.statusCode ?? 0));
    });
    req.once("error", reject);
    req.end(corps);
  });
}

async function connexions(serveur: net.Server): Promise<number> {
  return new Promise((resolve, reject) => serveur.getConnections((err, nombre) => (err ? reject(err) : resolve(nombre))));
}

async function attendreConnexions(serveur: net.Server, attendu: number): Promise<void> {
  const limite = Date.now() + 3000;
  for (;;) {
    const nombre = await connexions(serveur);
    if (nombre === attendu) return;
    if (Date.now() > limite) throw new Error(`connexions ouvertes : ${nombre}, attendu ${attendu}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

interface Banc {
  proxy: ProxySortie;
  port: number;
  dossier: string;
  lignes: string[];
  /** Connexions sortantes demandées au connecteur (hôte, port), et les sockets rendues. */
  sortantes: Array<[string, number]>;
  amonts: net.Socket[];
  erreurs: unknown[];
  brut(): Promise<string>;
  refus(): Promise<EgressRefus[]>;
}

/**
 * Proxy réel, journal réel dans un dossier temporaire, horloge fixe. Connecteur : `versEcho` dirige toute sortie vers le serveur
 * donné (l'hôte autorisé ne peut pas être joint en test) ; sans lui, la sortie va vraiment à l'hôte et au port demandés (proxy
 * d'entreprise local).
 */
async function banc(t: TestContext, options: Partial<ProxySortieOptions> = {}, versEcho: { port: number } | null = null): Promise<Banc> {
  const dossier = dossierTemporaire(t);
  const erreurs: unknown[] = [];
  const journal = new JournalRefus({ dossier, onErreur: (err) => erreurs.push(err) });
  const { log, lignes } = logDeTest();
  const sortantes: Array<[string, number]> = [];
  const amonts: net.Socket[] = [];
  const echo = versEcho ?? (options.proxyEntreprise ? null : await serveurTcp(t, (socket) => socket.pipe(socket)));
  const proxy = creerProxySortie({
    hoteAutorise: COPILOT,
    journal,
    log,
    maintenant: () => T0,
    connecter: (hote, port) => {
      sortantes.push([hote, port]);
      const amont = echo ? net.connect({ host: "127.0.0.1", port: echo.port }) : net.connect({ host: hote, port });
      amonts.push(amont);
      return amont;
    },
    ...options,
  });
  const port = await listenFetchable(proxy.serveur, "127.0.0.1");
  t.after(async () => {
    for (const socket of clientsOuverts) socket.destroy();
    await within(proxy.fermer(), "fermeture du proxy de test");
  });
  const brut = async () => {
    await journal.attendre();
    const fichier = path.join(dossier, EGRESS_JOURNAL_FICHIER);
    return fs.existsSync(fichier) ? fs.readFileSync(fichier, "utf8") : "";
  };
  return {
    proxy,
    port,
    dossier,
    lignes,
    sortantes,
    amonts,
    erreurs,
    brut,
    refus: async () =>
      (await brut())
        .split("\n")
        .filter((ligne) => ligne !== "")
        .map((ligne) => JSON.parse(ligne) as EgressRefus),
  };
}

const refusAttendu = (hote: string, port: number, raison: EgressRefusalReason): EgressRefus => ({ at: T0, hote, port, raison });

/** Aucune des chaînes `fuites` dans le texte (journal, traces). */
function sansFuite(texte: string, fuites: readonly string[], ou: string): void {
  for (const fuite of fuites) assert.equal(texte.includes(fuite), false, `${ou} : « ${fuite} » présent`);
}

// --- Proxy : liste blanche ---------------------------------------------------------------------------------------------------------

describe("proxy de sortie : liste blanche", () => {
  it("T-L16-a : CONNECT vers l'hôte autorisé → 200, octets relayés dans les deux sens au serveur d'écho, rien au journal", async (t) => {
    const b = await banc(t, { delaiAmontMs: 50 });
    const c = client(b.port, connect(`${COPILOT}:443`));
    assert.match(await reponse(c), /^HTTP\/1\.1 200 /);
    const charge = Buffer.alloc(100_000, "é").toString("latin1");
    c.socket.write(charge, "latin1");
    await until(() => c.texte().endsWith(charge));
    assert.deepEqual(b.sortantes, [[COPILOT, 443]]);
    // Tunnel ouvert : le délai d'amont (connexion, réponse du proxy d'entreprise) ne coupe plus un flux resté calme.
    assert.equal(b.amonts[0]?.timeout, 0);
    assert.equal(await b.brut(), "");
    c.socket.destroy();
  });

  it("T-L16-b : autre hôte → 403, journalisé {at, hote, port, raison} sans chemin, sans en-tête, sans identifiant ; aucune sortie", async (t) => {
    const b = await banc(t);
    const entetes = ["Host: evil.example:443", "Proxy-Authorization: Basic c2VjcmV0LWVudHJlZQ==", "X-Chemin: /dossier/secret", "User-Agent: salle"];
    const c = client(b.port, connect("evil.example:443", entetes));
    assert.equal(await reponse(c), "HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
    await within(c.ferme, "fermeture après 403");
    const refus = await b.refus();
    assert.deepEqual(refus, [refusAttendu("evil.example", 443, "hote")]);
    assert.deepEqual(Object.keys(refus[0] ?? {}), ["at", "hote", "port", "raison"]);
    const fuites = ["c2VjcmV0", "Proxy-Authorization", "X-Chemin", "/dossier", "User-Agent", "salle"];
    sansFuite(await b.brut(), fuites, "journal");
    sansFuite(b.lignes.join("\n"), fuites, "traces");
    assert.deepEqual(b.sortantes, []);
  });

  it("T-L16-c : demande ordinaire (GET en URI absolue, POST, PUT, DELETE) refusée 403, raison « methode », ni chemin ni en-tête au journal", async (t) => {
    const b = await banc(t);
    const entetes = { host: COPILOT, authorization: "Bearer jeton-de-la-salle" };
    for (const methode of ["GET", "POST", "PUT", "DELETE"]) {
      const corps = methode === "GET" || methode === "DELETE" ? undefined : '{"secret":"corps"}';
      assert.equal(await demande(b.port, methode, `http://${COPILOT}/v1/chat?cle=valeur-secrete`, entetes, corps), 403, methode);
    }
    assert.equal(await demande(b.port, "GET", `https://${COPILOT}:8443/x`, {}), 403);
    assert.deepEqual(await b.refus(), [
      refusAttendu(COPILOT, 80, "methode"),
      refusAttendu(COPILOT, 80, "methode"),
      refusAttendu(COPILOT, 80, "methode"),
      refusAttendu(COPILOT, 80, "methode"),
      refusAttendu(COPILOT, 8443, "methode"),
    ]);
    const fuites = ["/v1/chat", "valeur-secrete", "cle=", "Bearer", "jeton-de-la-salle", "corps", "/x"];
    sansFuite(await b.brut(), fuites, "journal");
    sansFuite(b.lignes.join("\n"), fuites, "traces");
    assert.deepEqual(b.sortantes, []);
    await attendreConnexions(b.proxy.serveur, 0);
  });

  it("T-L16-c : demande sans Host et demande d'upgrade refusées ET journalisées (jamais un 400 de Node avant le journal)", async (t) => {
    const b = await banc(t);
    const sansHost = client(b.port, "GET / HTTP/1.1\r\n\r\n");
    assert.match(await reponse(sansHost), /^HTTP\/1\.1 403 /);
    const upgrade = client(b.port, "GET /flux HTTP/1.1\r\nHost: api.githubcopilot.com\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n");
    assert.match(await reponse(upgrade), /^HTTP\/1\.1 403 /);
    assert.deepEqual(await b.refus(), [refusAttendu("", 0, "methode"), refusAttendu("", 0, "methode")]);
  });

  it("T-L16-c : méthode inconnue ou « connect » en minuscules → 400 journalisé « methode » ; autre demande illisible → 400 sans ligne", async (t) => {
    const b = await banc(t);
    for (const texte of [`connect ${COPILOT}:443 HTTP/1.1\r\nHost: x\r\n\r\n`, "FOO / HTTP/1.1\r\nHost: x\r\n\r\n", "GET / HTTP/1.1\r\nEn tete invalide\r\n\r\n"]) {
      const c = client(b.port, texte);
      assert.match(await reponse(c), /^HTTP\/1\.1 400 /, texte);
      await within(c.ferme, "fermeture après 400");
    }
    assert.deepEqual(await b.refus(), [refusAttendu("", 0, "methode"), refusAttendu("", 0, "methode")]);
    assert.deepEqual(b.sortantes, []);
    await attendreConnexions(b.proxy.serveur, 0);
    // Demande illisible puis client qui garde sa moitié ouverte : la connexion est libérée au bout du délai, côté egress.
    const b2 = await banc(t, { delaiFermetureMs: 50 });
    const tetu = client(b2.port, "FOO / HTTP/1.1\r\n\r\n", { allowHalfOpen: true });
    assert.match(await reponse(tetu), /^HTTP\/1\.1 400 /);
    await attendreConnexions(b2.proxy.serveur, 0);
    tetu.socket.destroy();
  });

  it("erreur du serveur après l'écoute : tracée, jamais fatale", async (t) => {
    const b = await banc(t);
    b.proxy.serveur.emit("error", Object.assign(new Error("trop de fichiers ouverts"), { code: "EMFILE" }));
    assert.ok(b.lignes.some((ligne) => ligne.includes("erreur du serveur") && ligne.includes("trop de fichiers ouverts")));
    const c = client(b.port, connect("evil.example:443"));
    assert.match(await reponse(c), /^HTTP\/1\.1 403 /, "egress répond toujours");
  });

  it("T-L16-d : api.github.com, IP écrite en clair, port ≠ 443, nom invalide ou trop long → 403 avec la bonne raison, hôte borné au journal", async (t) => {
    const b = await banc(t);
    const long = `${"a".repeat(300)}.example`;
    const cas: Array<[string, EgressRefus]> = [
      ["api.github.com:443", refusAttendu("api.github.com", 443, "hote")],
      ["127.0.0.1:443", refusAttendu("127.0.0.1", 443, "ip-litterale")],
      ["[::1]:443", refusAttendu("[::1]", 443, "ip-litterale")],
      ["2130706433:443", refusAttendu("2130706433", 443, "ip-litterale")],
      [`${COPILOT}:80`, refusAttendu(COPILOT, 80, "port")],
      [`${COPILOT}:8443`, refusAttendu(COPILOT, 8443, "port")],
      [COPILOT, refusAttendu(COPILOT, 0, "port")],
      ["bad_name.example:443", refusAttendu("bad_name.example", 443, "invalide")],
      [`${long}:443`, refusAttendu("a".repeat(253), 443, "invalide")],
      ["utilisateur:secret-cible@evil.example:443", refusAttendu("evil.example", 443, "invalide")],
      ["evil.example/chemin-cache:443", refusAttendu("evil.example", 443, "invalide")],
    ];
    for (const [cible] of cas) {
      const c = client(b.port, connect(cible, ["Host: x"]));
      assert.match(await reponse(c), /^HTTP\/1\.1 403 /, cible);
    }
    assert.deepEqual(
      await b.refus(),
      cas.map(([, attendu]) => attendu),
    );
    sansFuite(await b.brut(), ["secret-cible", "utilisateur", "chemin-cache"], "journal");
    sansFuite(b.lignes.join("\n"), ["secret-cible", "utilisateur", "chemin-cache", "a".repeat(254)], "traces");
    assert.deepEqual(b.sortantes, []);
  });

  it("CONNECT autorisé écrit en majuscules, ou sans Host : la sortie vise l'hôte configuré, jamais l'écriture du client", async (t) => {
    const b = await banc(t);
    const majuscules = client(b.port, connect("API.GITHUBCOPILOT.COM:443"));
    assert.match(await reponse(majuscules), /^HTTP\/1\.1 200 /);
    const sansHost = client(b.port, connect(`${COPILOT}:443`, []));
    assert.match(await reponse(sansHost), /^HTTP\/1\.1 200 /);
    assert.deepEqual(b.sortantes, [
      [COPILOT, 443],
      [COPILOT, 443],
    ]);
    majuscules.socket.destroy();
    sansHost.socket.destroy();
  });

  it("demi-fermeture dans le tunnel : le client finit d'écrire, la réponse de l'amont lui parvient encore", async (t) => {
    const b = await banc(t);
    const c = client(b.port, connect(`${COPILOT}:443`), { allowHalfOpen: true });
    assert.match(await reponse(c), /^HTTP\/1\.1 200 /);
    c.socket.end("derniere demande");
    await until(() => c.texte().endsWith("derniere demande"));
    await within(c.ferme, "tunnel fermé par l'amont après sa réponse");
  });

  it("octets envoyés dans le même paquet que le CONNECT : relayés après le 200, jamais perdus", async (t) => {
    const b = await banc(t);
    const c = client(b.port, `${connect(`${COPILOT}:443`)}octets-joints`);
    await until(() => c.texte().endsWith("\r\n\r\noctets-joints"));
    assert.match(c.texte(), /^HTTP\/1\.1 200 /);
    c.socket.destroy();
  });

  it("client qui part brutalement (RST) : la connexion sortante est fermée aussi", async (t) => {
    const echo = await serveurTcp(t, (socket) => socket.pipe(socket));
    const b = await banc(t, {}, echo);
    const c = client(b.port, connect(`${COPILOT}:443`));
    assert.match(await reponse(c), /^HTTP\/1\.1 200 /);
    await until(() => echo.sockets.size === 1);
    c.socket.resetAndDestroy();
    await until(() => echo.sockets.size === 0 && echo.fermees === 1);
  });

  it("amont qui ferme : le client est fermé ; amont injoignable : 502, aucun tunnel", async (t) => {
    const echo = await serveurTcp(t, (socket) => socket.pipe(socket));
    const b = await banc(t, {}, echo);
    const c = client(b.port, connect(`${COPILOT}:443`));
    assert.match(await reponse(c), /^HTTP\/1\.1 200 /);
    await until(() => echo.sockets.size === 1);
    for (const socket of echo.sockets) socket.destroy();
    await within(c.ferme, "client fermé avec l'amont");

    // Amont coupé brutalement (RST, erreur sans fin de flux) : pipe ne ferme rien, egress coupe le client lui-même.
    const cr = client(b.port, connect(`${COPILOT}:443`));
    assert.match(await reponse(cr), /^HTTP\/1\.1 200 /);
    await until(() => echo.sockets.size === 1);
    for (const socket of echo.sockets) socket.resetAndDestroy();
    await within(cr.ferme, "client fermé après la coupure brutale de l'amont");

    const ferme = await portFerme();
    const b2 = await banc(t, {}, { port: ferme });
    const c2 = client(b2.port, connect(`${COPILOT}:443`));
    assert.equal(await reponse(c2), "HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
    await within(c2.ferme, "fermeture après 502");
    assert.ok(b2.lignes.some((ligne) => ligne.includes("sortie impossible")));
    assert.equal(await b2.brut(), "", "une sortie impossible n'est pas un refus");
  });

  it("connexion refusée : ce que le client envoie encore est lu, sa fermeture libère la place ; client qui ne ferme pas : détruit au bout du délai", async (t) => {
    const b = await banc(t);
    const poli = client(b.port, `${connect("evil.example:443")}suite ignoree`);
    assert.match(await reponse(poli), /^HTTP\/1\.1 403 /);
    await within(poli.ferme, "fermeture du client");
    await attendreConnexions(b.proxy.serveur, 0);

    // Client qui écrit encore après avoir lu le 403, puis ferme : ces octets sont lus et jetés, sinon ils resteraient en attente
    // devant sa fermeture et la place ne serait libérée qu'au bout du délai (5 s d'office, plus que l'attente de ce test).
    const bavard = client(b.port, connect("evil.example:443"), { allowHalfOpen: true });
    assert.match(await reponse(bavard), /^HTTP\/1\.1 403 /);
    bavard.socket.end("encore des octets apres le refus");
    await attendreConnexions(b.proxy.serveur, 0);

    // Client qui garde sa moitié de connexion ouverte : seul le délai libère la place, côté egress.
    const b2 = await banc(t, { delaiFermetureMs: 50 });
    const tetu = client(b2.port, connect("evil.example:443"), { allowHalfOpen: true });
    assert.match(await reponse(tetu), /^HTTP\/1\.1 403 /);
    await attendreConnexions(b2.proxy.serveur, 0);
    tetu.socket.destroy();
  });

  it("connexions simultanées bornées : au-delà de connexionsMax, la connexion est coupée sans réponse", async (t) => {
    const b = await banc(t, { connexionsMax: 1 });
    const premiere = client(b.port, "CONNECT api.githubcop");
    await attendreConnexions(b.proxy.serveur, 1);
    const seconde = client(b.port, connect("evil.example:443"));
    await within(seconde.ferme, "seconde connexion coupée");
    assert.equal(seconde.texte(), "");
    assert.equal(premiere.estFerme(), false);
    assert.equal(await b.brut(), "");
    premiere.socket.destroy();
  });

  it("fermer() : plus d'écoute, tunnels et demandes à moitié reçues coupés, sans attendre le client", async (t) => {
    const b = await banc(t);
    const tunnel = client(b.port, connect(`${COPILOT}:443`));
    assert.match(await reponse(tunnel), /^HTTP\/1\.1 200 /);
    const partielle = client(b.port, "CONNECT api.githubcopilot.com:443 HTTP/1.1\r\nHost: api");
    await attendreConnexions(b.proxy.serveur, 2);
    await within(b.proxy.fermer(), "fermer()");
    await within(tunnel.ferme, "tunnel coupé");
    await within(partielle.ferme, "demande à moitié reçue coupée");
    const apres = client(b.port, connect(`${COPILOT}:443`));
    await within(apres.ferme, "plus d'écoute");
    assert.equal(apres.texte(), "");
  });
});

// --- Proxy : mode chaîné au proxy d'entreprise --------------------------------------------------------------------------------------

interface FauxProxy {
  port: number;
  /** En-têtes de demande reçus (sans la ligne vide finale). */
  demandes: string[];
}

/**
 * Faux proxy d'entreprise : lit l'en-tête de la demande, répond `reponse` (null : ne répond jamais) ; sur un 200, renvoie ensuite
 * tout ce qu'il reçoit (écho), octets joints à la demande compris.
 */
async function fauxProxyEntreprise(t: TestContext, reponse: string | null): Promise<FauxProxy> {
  const demandes: string[] = [];
  const serveur = await serveurTcp(t, (socket) => {
    let tampon = Buffer.alloc(0);
    let tunnel = false;
    socket.on("data", (bout: Buffer) => {
      if (tunnel) {
        socket.write(bout);
        return;
      }
      tampon = Buffer.concat([tampon, bout]);
      const fin = tampon.indexOf("\r\n\r\n");
      if (fin === -1) return;
      demandes.push(tampon.subarray(0, fin).toString("latin1"));
      const reste = tampon.subarray(fin + 4);
      if (reponse === null) return;
      socket.write(reponse);
      if (reponse.startsWith("HTTP/1.1 200")) {
        tunnel = true;
        if (reste.length > 0) socket.write(reste);
      } else {
        socket.end();
      }
    });
  });
  return { port: serveur.port, demandes };
}

const IDENTIFIANTS = ["utilisateur-proxy", "mot@passe", "mot%40passe", Buffer.from("utilisateur-proxy:mot@passe").toString("base64")];

describe("proxy de sortie : proxy d'entreprise chaîné", () => {
  it("CONNECT relayé au proxy d'entreprise avec ses identifiants, qui n'entrent ni au journal ni aux traces", async (t) => {
    const fp = await fauxProxyEntreprise(t, "HTTP/1.1 200 Connection established\r\n\r\n");
    const proxyEntreprise = lireProxyEntreprise({ HTTPS_PROXY: `http://utilisateur-proxy:mot%40passe@127.0.0.1:${fp.port}` });
    const b = await banc(t, { proxyEntreprise });
    const c = client(b.port, connect(`${COPILOT}:443`));
    assert.match(await reponse(c), /^HTTP\/1\.1 200 /);
    c.socket.write("par le proxy");
    await until(() => c.texte().endsWith("par le proxy"));
    // Tunnel établi : la lecture de l'en-tête du proxy d'entreprise est détachée, seul le relais lit encore (sinon chaque octet du
    // flux s'ajouterait à un tampon jamais vidé).
    assert.equal(b.amonts[0]?.listenerCount("data"), 1);
    assert.deepEqual(b.sortantes, [["127.0.0.1", fp.port]]);
    assert.deepEqual(fp.demandes[0]?.split("\r\n"), [
      `CONNECT ${COPILOT}:443 HTTP/1.1`,
      `Host: ${COPILOT}:443`,
      `Proxy-Authorization: Basic ${Buffer.from("utilisateur-proxy:mot@passe").toString("base64")}`,
    ]);
    const refuse = client(b.port, connect("evil.example:443"));
    assert.match(await reponse(refuse), /^HTTP\/1\.1 403 /);
    assert.equal(fp.demandes.length, 1, "un refus ne sort pas, même par le proxy d'entreprise");
    sansFuite(await b.brut(), IDENTIFIANTS, "journal");
    sansFuite(b.lignes.join("\n"), IDENTIFIANTS, "traces");
    c.socket.destroy();
  });

  it("proxy d'entreprise sans identifiants : aucun en-tête Proxy-Authorization ; octets envoyés avec son 200 transmis au client après le 200", async (t) => {
    const fp = await fauxProxyEntreprise(t, "HTTP/1.1 200 Connection established\r\nVia: proxy\r\n\r\noctets-du-proxy");
    const b = await banc(t, { proxyEntreprise: lireProxyEntreprise({ HTTPS_PROXY: `127.0.0.1:${fp.port}` }) });
    const c = client(b.port, `${connect(`${COPILOT}:443`)}octets-du-client`);
    await until(() => c.texte().includes("octets-du-proxy") && c.texte().endsWith("octets-du-client"));
    assert.equal(c.texte(), "HTTP/1.1 200 Connection Established\r\n\r\noctets-du-proxyoctets-du-client");
    assert.deepEqual(fp.demandes[0]?.split("\r\n"), [`CONNECT ${COPILOT}:443 HTTP/1.1`, `Host: ${COPILOT}:443`]);
    c.socket.destroy();
  });

  it("proxy d'entreprise qui refuse (407) : 502 au client, seul le code de statut est tracé", async (t) => {
    const fp = await fauxProxyEntreprise(t, 'HTTP/1.1 407 Proxy Authentication Required\r\nProxy-Authenticate: Basic realm="domaine-interne"\r\n\r\n');
    const b = await banc(t, { proxyEntreprise: lireProxyEntreprise({ HTTPS_PROXY: `http://utilisateur-proxy:mot%40passe@127.0.0.1:${fp.port}` }) });
    const c = client(b.port, connect(`${COPILOT}:443`));
    assert.match(await reponse(c), /^HTTP\/1\.1 502 /);
    await within(c.ferme, "fermeture après 502");
    const traces = b.lignes.join("\n");
    assert.match(traces, /réponse 407/);
    sansFuite(traces, [...IDENTIFIANTS, "domaine-interne", "Proxy-Authenticate"], "traces");
  });

  it("réponse du proxy d'entreprise sans fin d'en-tête au-delà de 16 Kio : 502 tout de suite, sans attendre le délai d'amont", async (t) => {
    const fp = await fauxProxyEntreprise(t, `HTTP/1.1 200 OK\r\nX-Remplissage: ${"r".repeat(20_000)}`);
    const b = await banc(t, { proxyEntreprise: lireProxyEntreprise({ HTTPS_PROXY: `http://127.0.0.1:${fp.port}` }), delaiAmontMs: 60_000 });
    const c = client(b.port, connect(`${COPILOT}:443`));
    assert.match(await reponse(c), /^HTTP\/1\.1 502 /);
    assert.ok(b.lignes.some((ligne) => ligne.includes("trop longue")));
    // Octets tardifs de l'amont après l'échec : ni second 502 ni seconde trace ; puis fin d'en-tête tardive (réponse « 200 ») :
    // aucun tunnel ouvert après coup.
    b.amonts[0]?.emit("data", Buffer.alloc(32, "r"));
    b.amonts[0]?.emit("data", Buffer.from("\r\n\r\n"));
    await within(c.ferme, "fermeture après 502");
    assert.equal(b.lignes.filter((ligne) => ligne.includes("sortie impossible")).length, 1);
    assert.equal(b.lignes.some((ligne) => ligne.includes("tunnel ouvert")), false);
    assert.equal(c.texte(), "HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
  });

  it("client parti pendant la réponse du proxy d'entreprise (fin de flux ou coupure) : sortie fermée tout de suite, ni 502 ni trace d'échec", async (t) => {
    const fp = await fauxProxyEntreprise(t, null);
    // Délai d'amont d'une minute : seule la réaction au départ du client peut fermer la connexion sortante pendant le test.
    const b = await banc(t, { proxyEntreprise: lireProxyEntreprise({ HTTPS_PROXY: `http://127.0.0.1:${fp.port}` }), delaiAmontMs: 60_000 });
    for (const [i, partir] of [(s: net.Socket) => s.end(), (s: net.Socket) => s.resetAndDestroy()].entries()) {
      const c = client(b.port, connect(`${COPILOT}:443`));
      await until(() => fp.demandes.length === i + 1);
      partir(c.socket);
      await until(() => b.amonts[i]?.closed);
      await attendreConnexions(b.proxy.serveur, 0);
    }
    assert.deepEqual(
      b.lignes.filter((ligne) => ligne.includes("sortie impossible")),
      [],
    );
  });

  it("proxy d'entreprise muet : tunnel abandonné au bout du délai d'amont, 502 au client ; proxy injoignable : 502", async (t) => {
    const fp = await fauxProxyEntreprise(t, null);
    const b = await banc(t, { proxyEntreprise: lireProxyEntreprise({ HTTPS_PROXY: `http://127.0.0.1:${fp.port}` }), delaiAmontMs: 50 });
    const c = client(b.port, connect(`${COPILOT}:443`));
    assert.match(await reponse(c), /^HTTP\/1\.1 502 /);
    assert.equal(fp.demandes.length, 1);
    assert.ok(b.lignes.some((ligne) => ligne.includes("délai dépassé")));

    const b2 = await banc(t, { proxyEntreprise: lireProxyEntreprise({ HTTPS_PROXY: `http://127.0.0.1:${await portFerme()}` }) });
    const c2 = client(b2.port, connect(`${COPILOT}:443`));
    assert.match(await reponse(c2), /^HTTP\/1\.1 502 /);
  });
});

// --- Configuration, sonde, démarrage et arrêt ----------------------------------------------------------------------------------------

describe("proxy de sortie : configuration", () => {
  it("lireProxyEntreprise : absent → tunnel direct ; http:// (schéma absent compris) accepté ; port 80 d'office ; identifiants encodés en Basic", () => {
    assert.equal(lireProxyEntreprise({}), null);
    assert.equal(lireProxyEntreprise({ HTTPS_PROXY: "  " }), null);
    assert.deepEqual(lireProxyEntreprise({ HTTPS_PROXY: "http://proxy.corp:8080" }), { hote: "proxy.corp", port: 8080, autorisation: null });
    assert.deepEqual(lireProxyEntreprise({ HTTPS_PROXY: "proxy.corp:3128" }), { hote: "proxy.corp", port: 3128, autorisation: null });
    assert.deepEqual(lireProxyEntreprise({ HTTPS_PROXY: "http://proxy.corp/" }), { hote: "proxy.corp", port: 80, autorisation: null });
    assert.deepEqual(lireProxyEntreprise({ HTTPS_PROXY: "http://[::1]:3128" }), { hote: "::1", port: 3128, autorisation: null });
    assert.deepEqual(lireProxyEntreprise({ https_proxy: "http://minuscule:3128" }), { hote: "minuscule", port: 3128, autorisation: null });
    assert.deepEqual(lireProxyEntreprise({ HTTPS_PROXY: "http://majuscule:3128", https_proxy: "http://minuscule:3128" })?.hote, "majuscule");
    assert.deepEqual(lireProxyEntreprise({ HTTPS_PROXY: "", https_proxy: "http://minuscule:3128" })?.hote, "minuscule");
    assert.deepEqual(lireProxyEntreprise({ HTTPS_PROXY: "http://jean%20dupont:p%40ss%3Aword@proxy.corp:8080" }), {
      hote: "proxy.corp",
      port: 8080,
      autorisation: `Basic ${Buffer.from("jean dupont:p@ss:word").toString("base64")}`,
    });
    assert.equal(lireProxyEntreprise({ HTTPS_PROXY: "http://seul@proxy.corp:8080" })?.autorisation, `Basic ${Buffer.from("seul:").toString("base64")}`);
  });

  it("lireProxyEntreprise : toute autre forme refusée, sans jamais citer la valeur (identifiants)", () => {
    for (const valeur of [
      "https://utilisateur-proxy:mot-de-passe-proxy@proxy.corp:443",
      "socks5://utilisateur-proxy:mot-de-passe-proxy@proxy.corp:1080",
      "http://utilisateur-proxy:mot-de-passe-proxy@proxy.corp:8080/chemin",
      "http://utilisateur-proxy:mot-de-passe-proxy@proxy.corp:8080?x=1",
      "http://utilisateur-proxy:mot-de-passe-proxy@proxy.corp:8080#f",
      "http://utilisateur-proxy:%E0%A4%A@proxy.corp:8080",
      "http://utilisateur-proxy:mot-de-passe-proxy@:8080",
      "http://utilisateur-proxy:mot-de-passe-proxy@proxy.corp:99999",
    ]) {
      assert.throws(
        () => lireProxyEntreprise({ HTTPS_PROXY: valeur }),
        (err: unknown) => {
          assert.ok(err instanceof Error && err.name === "EgressConfigError", valeur);
          assert.match(err.message, /^HTTPS_PROXY : /);
          sansFuite(err.message, ["utilisateur-proxy", "mot-de-passe-proxy", "proxy.corp", "%E0"], valeur);
          return true;
        },
      );
    }
    assert.throws(() => lireProxyEntreprise({ HTTPS_PROXY: "http://u:%E0%A4%A@proxy.corp:8080" }), /identifiants mal encodés/);
  });

  it("analyserArguments : port 3128 et 0.0.0.0 d'office ; --sonde, --port, --hote lus ; toute autre forme refusée", () => {
    assert.equal(EGRESS_PORT_ECOUTE, 3128);
    assert.deepEqual(analyserArguments([]), { sonde: false, port: 3128, hote: "0.0.0.0" });
    assert.deepEqual(analyserArguments(["--sonde"]), { sonde: true, port: 3128, hote: "0.0.0.0" });
    assert.deepEqual(analyserArguments(["--port", "0", "--hote", "127.0.0.1"]), { sonde: false, port: 0, hote: "127.0.0.1" });
    assert.deepEqual(analyserArguments(["--sonde", "--port", "65535"]), { sonde: true, port: 65535, hote: "0.0.0.0" });
    for (const argv of [["--port"], ["--port", "65536"], ["--port", "-1"], ["--port", "80a"], ["--port", ""], ["--hote", "localhost"], ["--hote"], ["--sonde", "--port", "0"], ["--inconnu"], ["3128"]]) {
      assert.throws(() => analyserArguments(argv), (err: unknown) => err instanceof Error && err.name === "EgressConfigError", argv.join(" "));
    }
    assert.throws(() => analyserArguments(["--port"]), /--port : valeur manquante/);
    assert.throws(() => analyserArguments(["--hote"]), /--hote : valeur manquante/);
  });

  it("zéro dépendance : egress-proxy.ts n'importe, de proche en proche, que des modules node: et des fichiers du dépôt", () => {
    const vus = new Set<string>();
    const aVoir = [PROXY_SCRIPT];
    for (let fichier = aVoir.pop(); fichier !== undefined; fichier = aVoir.pop()) {
      if (vus.has(fichier)) continue;
      vus.add(fichier);
      for (const [, spec = ""] of fs.readFileSync(fichier, "utf8").matchAll(/(?:\bfrom\s*|\bimport\s*\(?\s*)["']([^"']+)["']/g)) {
        if (spec.startsWith("node:")) continue;
        assert.ok(spec.startsWith("./") || spec.startsWith("../"), `${path.basename(fichier)} : dépendance ${spec}`);
        aVoir.push(path.resolve(path.dirname(fichier), spec));
      }
    }
    const noms = [...vus].map((f) => path.relative(import.meta.dirname, f).replaceAll("\\", "/")).sort();
    for (const attendu of ["egress-journal.ts", "egress-proxy.ts", "log.ts", "shared/egress-allow.ts"]) assert.ok(noms.includes(attendu), attendu);
  });

  it("sonder : vraie sur un port qui écoute (sans rien envoyer), fausse sur un port fermé", async (t) => {
    const recu: Buffer[] = [];
    const serveur = await serveurTcp(t, (socket) => socket.on("data", (bout: Buffer) => recu.push(bout)));
    assert.equal(await sonder(serveur.port), true);
    await until(() => serveur.fermees === 1);
    assert.deepEqual(recu, [], "la sonde n'envoie rien : aucune ligne au journal");
    assert.equal(await sonder(await portFerme()), false);
  });
});

interface Demarre {
  signaux: EventEmitter;
  codes: number[];
  lignes: string[];
  proxy: ProxySortie;
  port: number;
}

/** lancer() en mémoire sur 127.0.0.1, port choisi par le système (nouvel essai s'il est refusé par fetch). */
async function demarrer(t: TestContext, env: NodeJS.ProcessEnv): Promise<Demarre> {
  for (let essai = 0; essai < 5; essai++) {
    const signaux = new EventEmitter();
    const codes: number[] = [];
    const { log, lignes } = logDeTest();
    const ecoute: { proxy: ProxySortie | null; port: number } = { proxy: null, port: 0 };
    await lancer({
      argv: ["--port", "0", "--hote", "127.0.0.1"],
      env,
      log,
      signaux,
      sortir: (code) => codes.push(code),
      maintenant: () => T0,
      onEcoute: (proxy, port) => {
        ecoute.proxy = proxy;
        ecoute.port = port;
      },
    });
    const proxy = ecoute.proxy;
    assert.ok(proxy !== null, `démarrage refusé : ${lignes.join(" | ")}`);
    t.after(async () => {
      for (const socket of clientsOuverts) socket.destroy();
      await within(proxy.fermer(), "fermeture du proxy de test");
    });
    if (!isFetchBlockedPort(ecoute.port)) return { signaux, codes, lignes, proxy, port: ecoute.port };
    signaux.emit("SIGTERM");
    await until(() => codes.length > 0);
  }
  throw new Error("aucun port accepté par fetch en 5 essais");
}

/** lancer() qui doit refuser : code rendu, traces, et aucune écoute. */
async function refuserDeDemarrer(argv: string[], env: NodeJS.ProcessEnv): Promise<{ codes: number[]; traces: string }> {
  const codes: number[] = [];
  const { log, lignes } = logDeTest();
  let ecoute = false;
  const onEcoute = (proxy: ProxySortie) => {
    ecoute = true;
    // Démarré à tort : refermé tout de suite, pour que le test échoue au lieu de garder le processus ouvert.
    void proxy.fermer();
  };
  await lancer({ argv, env, log, signaux: new EventEmitter(), sortir: (code) => codes.push(code), onEcoute });
  assert.equal(ecoute, false, "aucune écoute");
  return { codes, traces: lignes.join("\n") };
}

const annonce = (lignes: string[]): Record<string, unknown> | undefined =>
  lignes.map((ligne) => JSON.parse(ligne) as Record<string, unknown>).find((ligne) => ligne.message === "proxy de sortie à l'écoute");

describe("proxy de sortie : démarrage et arrêt (en mémoire)", () => {
  it("hôte autorisé lu UNE fois au démarrage ; SIGTERM → plus d'écoute, journal écrit, sortie 0 ; second signal ignoré", async (t) => {
    const dossier = dossierTemporaire(t);
    const env: NodeJS.ProcessEnv = { COCKPIT_COPILOT_API_URL: "https://api.business.githubcopilot.com", COCKPIT_EGRESS_JOURNAL: dossier };
    const d = await demarrer(t, env);
    assert.equal(annonce(d.lignes)?.hoteAutorise, "api.business.githubcopilot.com");
    assert.equal(annonce(d.lignes)?.proxyEntreprise, null);
    // Adresse d'office rendue par l'environnement après le démarrage : sans effet, l'hôte n'est jamais relu.
    env.COCKPIT_COPILOT_API_URL = "";
    const c = client(d.port, connect(`${COPILOT}:443`));
    assert.match(await reponse(c), /^HTTP\/1\.1 403 /);
    d.signaux.emit("SIGTERM");
    await until(() => d.codes.length > 0);
    assert.deepEqual(d.codes, [0]);
    assert.equal(d.proxy.serveur.listening, false);
    assert.deepEqual(lignesDuFichier(path.join(dossier, EGRESS_JOURNAL_FICHIER)).map((l) => JSON.parse(l)), [refusAttendu(COPILOT, 443, "hote")]);
    assert.ok(d.lignes.some((ligne) => ligne.includes("proxy de sortie arrêté") && ligne.includes("SIGTERM")));
    d.signaux.emit("SIGINT");
    d.signaux.emit("SIGTERM");
    assert.equal(d.signaux.listenerCount("SIGTERM"), 1, "gestionnaire gardé : un second signal ne tue pas le processus en plein arrêt");
    // Un second arrêt irait jusqu'à sortir() en quelques tours de boucle (fermeture du serveur, journal vide) : deux tours complets.
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(d.codes, [0], "un seul arrêt");
    assert.equal(d.lignes.filter((ligne) => ligne.includes("proxy de sortie arrêté")).length, 1);
  });

  it("domaine GitHub Enterprise déclaré et proxy d'entreprise : annoncés sans identifiants ; SIGINT arrête aussi", async (t) => {
    const env: NodeJS.ProcessEnv = {
      COCKPIT_COPILOT_API_URL: "https://copilot-api.acme.ghe.com",
      COCKPIT_GITHUB_ENTERPRISE_DOMAIN: "acme.ghe.com",
      COCKPIT_EGRESS_JOURNAL: dossierTemporaire(t),
      HTTPS_PROXY: "http://utilisateur-proxy:mot%40passe@proxy.corp:8080",
    };
    const d = await demarrer(t, env);
    assert.equal(annonce(d.lignes)?.hoteAutorise, "copilot-api.acme.ghe.com");
    assert.equal(annonce(d.lignes)?.proxyEntreprise, "proxy.corp:8080");
    sansFuite(d.lignes.join("\n"), IDENTIFIANTS, "traces");
    d.signaux.emit("SIGINT");
    await until(() => d.codes.length > 0);
    assert.deepEqual(d.codes, [0]);
  });

  it("démarrage refusé au moindre doute : adresse Copilot, proxy d'entreprise, journal, argument, port pris ; aucun identifiant tracé", async (t) => {
    const dossier = dossierTemporaire(t);
    const fichier = path.join(dossier, "pas-un-dossier");
    fs.writeFileSync(fichier, "");
    const base = { COCKPIT_EGRESS_JOURNAL: dossier };
    const argv = ["--port", "0", "--hote", "127.0.0.1"];

    const adresse = await refuserDeDemarrer(argv, { ...base, COCKPIT_COPILOT_API_URL: "https://evil.example" });
    assert.deepEqual(adresse.codes, [1]);
    assert.match(adresse.traces, /COCKPIT_COPILOT_API_URL refusée/);
    assert.deepEqual((await refuserDeDemarrer(argv, { ...base, COCKPIT_COPILOT_API_URL: "https://copilot-api.acme.ghe.com" })).codes, [1], "domaine non déclaré");

    for (const valeur of ["ftp://utilisateur-proxy:mot%40passe@proxy.corp:21", "http://utilisateur-proxy:%E0%A4%A@proxy.corp:8080"]) {
      const proxy = await refuserDeDemarrer(argv, { ...base, HTTPS_PROXY: valeur });
      assert.deepEqual(proxy.codes, [1], valeur);
      assert.match(proxy.traces, /HTTPS_PROXY/);
      sansFuite(proxy.traces, [...IDENTIFIANTS, "%E0"], valeur);
    }

    const journal = await refuserDeDemarrer(argv, { COCKPIT_EGRESS_JOURNAL: fichier });
    assert.deepEqual(journal.codes, [1]);
    assert.match(journal.traces, /COCKPIT_EGRESS_JOURNAL/);

    // Argument refusé : 1, jamais 2 (code réservé par Docker dans un healthcheck).
    assert.deepEqual((await refuserDeDemarrer(["--inconnu"], base)).codes, [1]);
    assert.deepEqual((await refuserDeDemarrer(["--sonde", "--port", "0"], base)).codes, [1]);

    const occupe = await serveurTcp(t, () => undefined);
    const pris = await refuserDeDemarrer(["--port", String(occupe.port), "--hote", "127.0.0.1"], base);
    assert.deepEqual(pris.codes, [1]);
    assert.match(pris.traces, /écoute impossible/);
  });

  it("--sonde : code 0 si le port écoute, 1 sinon", async (t) => {
    const serveur = await serveurTcp(t, () => undefined);
    const ok = await refuserDeDemarrer(["--sonde", "--port", String(serveur.port)], {});
    assert.deepEqual(ok.codes, [0]);
    const ko = await refuserDeDemarrer(["--sonde", "--port", String(await portFerme())], {});
    assert.deepEqual(ko.codes, [1]);
  });

  it("arreterProprement : proxy fermé, puis journal écrit jusqu'au bout, puis sortie 0 — jamais avant", async () => {
    const etapes: string[] = [];
    let finFermer!: () => void;
    let finJournal!: () => void;
    const proxy = { fermer: () => new Promise<void>((resolve) => (finFermer = () => (etapes.push("fermé"), resolve()))) };
    const journal = { attendre: () => (etapes.push("attente du journal"), new Promise<void>((resolve) => (finJournal = () => (etapes.push("journal écrit"), resolve())))) };
    const { log } = logDeTest();
    const codes: number[] = [];
    const arret = arreterProprement(proxy, journal, log, "SIGTERM", (code) => codes.push(code));
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual([etapes, codes], [[], []], "fermer() en cours : ni journal attendu, ni sortie");
    finFermer();
    await until(() => etapes.length === 2);
    assert.deepEqual([etapes, codes], [["fermé", "attente du journal"], []], "journal en cours d'écriture : pas de sortie");
    finJournal();
    await arret;
    assert.deepEqual([etapes, codes], [["fermé", "attente du journal", "journal écrit"], [0]]);
  });
});

// --- Processus réel ---------------------------------------------------------------------------------------------------------------

interface Enfant {
  enfant: ChildProcess;
  sortie: Promise<number>;
  texte(): string;
  lignes(): Array<Record<string, unknown>>;
  parti(): boolean;
}

/** Environnement de l'enfant : celui des tests sans proxy ni variable du cockpit hérités, puis `extra`. */
function envEnfant(extra: Record<string, string>): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [cle, valeur] of Object.entries(process.env)) {
    if (/^(?:https?_proxy|no_proxy|all_proxy|node_use_env_proxy)$/i.test(cle) || /^cockpit_/i.test(cle)) continue;
    env[cle] = valeur;
  }
  return { ...env, ...extra };
}

function lancerEnfant(t: TestContext, args: string[], env: NodeJS.ProcessEnv): Enfant {
  const enfant = spawn(process.execPath, ["--disable-warning=ExperimentalWarning", PROXY_SCRIPT, ...args], { env, stdio: ["ignore", "pipe", "pipe"] });
  let texte = "";
  let parti = false;
  enfant.stdout?.setEncoding("utf8");
  enfant.stderr?.setEncoding("utf8");
  enfant.stdout?.on("data", (bout: string) => (texte += bout));
  enfant.stderr?.on("data", (bout: string) => (texte += bout));
  // « close » plutôt que « exit » : la dernière ligne écrite avant la sortie est alors lue.
  const sortie = new Promise<number>((resolve) =>
    enfant.once("close", (code) => {
      parti = true;
      resolve(code ?? -1);
    }),
  );
  t.after(async () => {
    if (!parti) enfant.kill();
    await sortie;
  });
  const lignes = () =>
    texte
      .split("\n")
      .filter((ligne) => ligne.startsWith("{"))
      .map((ligne) => JSON.parse(ligne) as Record<string, unknown>);
  return { enfant, sortie, texte: () => texte, lignes, parti: () => parti };
}

describe("proxy de sortie : processus réel (node server/egress-proxy.ts)", () => {
  it("--sonde : code de sortie 0 si le port écoute, 1 sinon (healthcheck)", async (t) => {
    const serveur = await serveurTcp(t, () => undefined);
    assert.equal(await within(lancerEnfant(t, ["--sonde", "--port", String(serveur.port)], envEnfant({})).sortie, "sonde", 10_000), 0);
    await fermerServeur(serveur.serveur, serveur.sockets);
    assert.equal(await within(lancerEnfant(t, ["--sonde", "--port", String(serveur.port)], envEnfant({})).sortie, "sonde", 10_000), 1);
  });

  it("configuration refusée : code 1, rien en écoute, aucun identifiant imprimé", async (t) => {
    const env = envEnfant({ COCKPIT_EGRESS_JOURNAL: dossierTemporaire(t), HTTPS_PROXY: "ftp://utilisateur-proxy:mot%40passe@proxy.corp:21" });
    const e = lancerEnfant(t, ["--port", "0", "--hote", "127.0.0.1"], env);
    assert.equal(await within(e.sortie, "refus de démarrer", 10_000), 1);
    assert.match(e.texte(), /HTTPS_PROXY/);
    sansFuite(e.texte(), IDENTIFIANTS, "sortie du processus");
    assert.equal(
      e.lignes().some((ligne) => ligne.msg === "proxy de sortie à l'écoute"),
      false,
    );
  });

  it("service : hôte lu dans l'environnement, refus journalisé dans COCKPIT_EGRESS_JOURNAL ; SIGTERM → arrêt propre, code 0 (hors Windows)", async (t) => {
    const dossier = dossierTemporaire(t);
    const env = envEnfant({ COCKPIT_EGRESS_JOURNAL: dossier, COCKPIT_COPILOT_API_URL: "https://api.business.githubcopilot.com" });
    let e: Enfant | null = null;
    let port = 0;
    for (let essai = 0; essai < 5 && e === null; essai++) {
      const candidat = lancerEnfant(t, ["--port", "0", "--hote", "127.0.0.1"], env);
      const ecoute = await until(() => {
        if (candidat.parti()) throw new Error(`egress arrêté : ${candidat.texte().slice(0, 300)}`);
        return candidat.lignes().find((ligne) => ligne.msg === "proxy de sortie à l'écoute");
      }, 10_000);
      assert.equal(ecoute.hoteAutorise, "api.business.githubcopilot.com");
      port = Number(ecoute.port);
      if (!isFetchBlockedPort(port)) e = candidat;
      else {
        candidat.enfant.kill();
        await candidat.sortie;
      }
    }
    assert.ok(e !== null, "aucun port accepté par fetch en 5 essais");
    const c = client(port, connect(`${COPILOT}:443`));
    assert.match(await reponse(c), /^HTTP\/1\.1 403 /);
    const journal = path.join(dossier, EGRESS_JOURNAL_FICHIER);
    await until(() => lignesDuFichier(journal).length === 1);
    const ligne = JSON.parse(lignesDuFichier(journal)[0] ?? "{}") as EgressRefus;
    assert.deepEqual({ ...ligne, at: 0 }, { at: 0, hote: COPILOT, port: 443, raison: "hote" });
    if (process.platform === "win32") {
      t.diagnostic("SIGTERM réel impossible à envoyer sous Windows (kill = arrêt forcé) : arrêt propre vérifié en mémoire (lancer, arreterProprement)");
      return;
    }
    e.enfant.kill("SIGTERM");
    assert.equal(await within(e.sortie, "arrêt sur SIGTERM", 10_000), 0);
    assert.ok(e.lignes().some((l) => l.msg === "proxy de sortie arrêté" && l.signal === "SIGTERM"));
  });
});

// --- Journal des refus ------------------------------------------------------------------------------------------------------------

function journalDeTest(t: TestContext, options: { tailleMax?: number; attenteMax?: number } = {}) {
  const dossier = dossierTemporaire(t);
  const erreurs: unknown[] = [];
  const pertes: number[] = [];
  const journal = new JournalRefus({ dossier, onErreur: (err) => erreurs.push(err), onPerte: (n) => pertes.push(n), ...options });
  return { dossier, journal, erreurs, pertes, fichier: path.join(dossier, EGRESS_JOURNAL_FICHIER), precedent: path.join(dossier, EGRESS_JOURNAL_PRECEDENT) };
}

describe("journal des refus", () => {
  it("une ligne par refus, dans l'ordre, rien d'autre que {at, hote, port, raison}", async (t) => {
    const j = journalDeTest(t);
    j.journal.ecrire(refusAttendu("un.example", 443, "hote"));
    j.journal.ecrire({ ...refusAttendu("deux.example", 80, "port"), chemin: "/secret", entete: "Authorization: x" } as EgressRefus);
    j.journal.ecrire(refusAttendu("127.0.0.1", 443, "ip-litterale"));
    await j.journal.attendre();
    const lignes = lignesDuFichier(j.fichier);
    assert.deepEqual(
      lignes.map((l) => JSON.parse(l)),
      [refusAttendu("un.example", 443, "hote"), refusAttendu("deux.example", 80, "port"), refusAttendu("127.0.0.1", 443, "ip-litterale")],
    );
    sansFuite(fs.readFileSync(j.fichier, "utf8"), ["/secret", "Authorization", "chemin", "entete"], "journal");
    assert.deepEqual(j.erreurs, []);
  });

  it("borne ce que la salle peut faire écrire : ni identifiant ni chemin, minuscules, ASCII visible, 253 caractères, port entier", async (t) => {
    assert.equal(hotePourJournal("Utilisateur:Secret@Evil.Example/chemin?q=1#f"), "evil.example");
    assert.equal(hotePourJournal("evil.example?cle=secret"), "evil.example");
    assert.equal(hotePourJournal("evil.example#secret"), "evil.example");
    assert.equal(hotePourJournal("a@b@c.example"), "c.example");
    assert.equal(hotePourJournal(`é${String.fromCharCode(0)}\n.example`), "???.example");
    assert.equal(hotePourJournal("x".repeat(400)), "x".repeat(253));
    const j = journalDeTest(t);
    for (const port of [Number.NaN, 70_000, -1, 1.5]) j.journal.ecrire({ at: Number.NaN, hote: "Secret@Evil.Example/x", port, raison: "port" });
    await j.journal.attendre();
    for (const ligne of lignesDuFichier(j.fichier)) assert.deepEqual(JSON.parse(ligne), { at: 0, hote: "evil.example", port: 0, raison: "port" });
    sansFuite(fs.readFileSync(j.fichier, "utf8"), ["Secret", "secret", "/x"], "journal");
  });

  it("rotation à 1 Mio : le fichier plein devient refus.1.jsonl, l'écriture reprend à vide, l'agrégat relit les deux", async (t) => {
    assert.equal(EGRESS_JOURNAL_MAX, 1024 * 1024);
    const j = journalDeTest(t);
    const ancienne = `${JSON.stringify(refusAttendu("ancien.example", 443, "hote"))}\n`;
    const nombre = Math.floor((EGRESS_JOURNAL_MAX - 64) / ancienne.length);
    const plein = ancienne.repeat(nombre);
    // Complété par une ligne blanche jusqu'à 10 octets de la borne : la prochaine ligne ne tient plus.
    fs.writeFileSync(j.fichier, `${plein}${" ".repeat(EGRESS_JOURNAL_MAX - 10 - plein.length - 1)}\n`);
    assert.equal(fs.statSync(j.fichier).size, EGRESS_JOURNAL_MAX - 10);
    j.journal.ecrire(refusAttendu("nouveau.example", 443, "hote"));
    await j.journal.attendre();
    assert.equal(fs.statSync(j.precedent).size, EGRESS_JOURNAL_MAX - 10);
    assert.deepEqual(lignesDuFichier(j.fichier).map((l) => JSON.parse(l)), [refusAttendu("nouveau.example", 443, "hote")]);
    // Après la rotation, la taille repart de zéro : la ligne suivante s'ajoute, le fichier précédent reste celui d'avant.
    j.journal.ecrire(refusAttendu("nouveau.example", 443, "hote"));
    await j.journal.attendre();
    assert.equal(lignesDuFichier(j.fichier).length, 2);
    assert.equal(fs.statSync(j.precedent).size, EGRESS_JOURNAL_MAX - 10);
    assert.deepEqual(await lireSortiesRefusees(T0 + 1, EGRESS_FENETRE_DIAGNOSTIC_MS, j.dossier), [
      { hote: "ancien.example", nombre, dernier: T0 },
      { hote: "nouveau.example", nombre: 2, dernier: T0 },
    ]);
    // Sous la borne : aucune rotation.
    const k = journalDeTest(t);
    for (let i = 0; i < 20; i++) k.journal.ecrire(refusAttendu("petit.example", 443, "hote"));
    await k.journal.attendre();
    assert.equal(fs.existsSync(k.precedent), false);
  });

  it("rotation répétée : aucun fichier ne dépasse la borne, un seul fichier précédent gardé", async (t) => {
    const j = journalDeTest(t, { tailleMax: 400 });
    for (let lot = 0; lot < 5; lot++) {
      for (let i = 0; i < 4; i++) j.journal.ecrire(refusAttendu(`lot${lot}.example`, 443, "hote"));
      await j.journal.attendre();
      assert.ok(fs.statSync(j.fichier).size <= 400, `lot ${lot}`);
    }
    assert.deepEqual(fs.readdirSync(j.dossier).sort(), [EGRESS_JOURNAL_PRECEDENT, EGRESS_JOURNAL_FICHIER].sort());
    // Première écriture plus grosse que la borne, journal encore vide : écrite sans rotation (rien à mettre de côté), sans erreur.
    const k = journalDeTest(t, { tailleMax: 20 });
    k.journal.ecrire(refusAttendu("premiere.example", 443, "hote"));
    await k.journal.attendre();
    assert.deepEqual(k.erreurs, []);
    assert.equal(lignesDuFichier(k.fichier).length, 1);
    assert.equal(fs.existsSync(k.precedent), false);
  });

  it("file d'écriture bornée : au-delà, les lignes sont comptées perdues et signalées, jamais gardées sans limite", async (t) => {
    const j = journalDeTest(t, { attenteMax: 3 });
    for (let i = 0; i < 10; i++) j.journal.ecrire(refusAttendu(`h${i}.example`, 443, "hote"));
    await j.journal.attendre();
    assert.deepEqual(
      lignesDuFichier(j.fichier).map((l) => (JSON.parse(l) as EgressRefus).hote),
      ["h0.example", "h1.example", "h2.example"],
    );
    assert.deepEqual(j.pertes, [7]);
  });

  it("écriture en échec : l'erreur est rendue à l'appelant, jamais avalée ; dossier inutilisable refusé au démarrage", async (t) => {
    const dossier = dossierTemporaire(t);
    const fichier = path.join(dossier, "fichier-ordinaire");
    fs.writeFileSync(fichier, "");
    const erreurs: unknown[] = [];
    const journal = new JournalRefus({ dossier: fichier, onErreur: (err) => erreurs.push(err) });
    journal.ecrire(refusAttendu("x.example", 443, "hote"));
    await journal.attendre();
    assert.equal(erreurs.length, 1);
    await assert.rejects(JournalRefus.verifierDossier(fichier));
    const neuf = path.join(dossier, "cree", "au", "demarrage");
    await JournalRefus.verifierDossier(neuf);
    assert.equal(fs.statSync(neuf).isDirectory(), true);
    // Volume monté en lecture seule par erreur : refusé au démarrage, pas à la première écriture. Sous Windows, l'attribut lecture
    // seule ne protège pas un dossier, et root passe outre les droits : vérifié sous POSIX sans root seulement (CI Linux).
    if (process.platform === "win32" || process.getuid?.() === 0) {
      t.diagnostic("dossier en lecture seule : non vérifiable ici (Windows ou root), vérifié en CI Linux");
      return;
    }
    const lectureSeule = path.join(dossier, "lecture-seule");
    fs.mkdirSync(lectureSeule, { mode: 0o555 });
    fs.chmodSync(lectureSeule, 0o555);
    t.after(() => fs.chmodSync(lectureSeule, 0o755));
    await assert.rejects(JournalRefus.verifierDossier(lectureSeule));
  });

  it("lireSortiesRefusees : agrégat par hôte sur 24 h (fichier précédent compris), plus refusés d'abord, plus anciens écartés", async (t) => {
    const j = journalDeTest(t);
    const ligne = (at: number, hote: string) => `${JSON.stringify({ at, hote, port: 443, raison: "hote" })}\n`;
    fs.writeFileSync(j.precedent, ligne(T0 - 25 * HEURE, "trop-vieux.example") + ligne(T0 - 23 * HEURE, "b.example"));
    fs.writeFileSync(j.fichier, ligne(T0 - 3 * HEURE, "a.example") + ligne(T0 - HEURE, "b.example") + ligne(T0 - 2 * HEURE, "a.example") + ligne(T0 - 30 * 60_000, "c.example"));
    assert.equal(EGRESS_FENETRE_DIAGNOSTIC_MS, 24 * HEURE);
    assert.deepEqual(await lireSortiesRefusees(T0, EGRESS_FENETRE_DIAGNOSTIC_MS, j.dossier), [
      { hote: "b.example", nombre: 2, dernier: T0 - HEURE },
      { hote: "a.example", nombre: 2, dernier: T0 - 2 * HEURE },
      { hote: "c.example", nombre: 1, dernier: T0 - 30 * 60_000 },
    ]);
    // Fenêtre de 90 min ; à nombre égal, le plus récent d'abord.
    assert.deepEqual(await lireSortiesRefusees(T0, 90 * 60_000, j.dossier), [
      { hote: "c.example", nombre: 1, dernier: T0 - 30 * 60_000 },
      { hote: "b.example", nombre: 1, dernier: T0 - HEURE },
    ]);
    assert.deepEqual(await lireSortiesRefusees(T0, EGRESS_FENETRE_DIAGNOSTIC_MS, path.join(j.dossier, "absent")), [], "journal absent : aucun refus");
  });

  it("lireSortiesRefusees : lignes illisibles ou non conformes ignorées ; 50 hôtes au plus ; erreur de lecture rendue", async (t) => {
    const j = journalDeTest(t);
    const bonne = (hote: string) => JSON.stringify({ at: T0, hote, port: 443, raison: "hote" });
    const mauvaises = [
      "pas du json",
      "[1,2]",
      "null",
      JSON.stringify({ at: T0, hote: "extra.example", port: 443, raison: "hote", chemin: "/x" }),
      JSON.stringify({ at: T0, hote: "manque.example", port: 443 }),
      JSON.stringify({ at: T0, hote: "raison.example", port: 443, raison: "autre" }),
      JSON.stringify({ at: T0, hote: "p".repeat(254), port: 443, raison: "hote" }),
      JSON.stringify({ at: T0, hote: "port.example", port: 70_000, raison: "hote" }),
      JSON.stringify({ at: T0, hote: "port.example", port: 1.5, raison: "hote" }),
      JSON.stringify({ at: "hier", hote: "at.example", port: 443, raison: "hote" }),
      JSON.stringify({ at: T0, hote: 42, port: 443, raison: "hote" }),
      `{"at":${T0},"hote":"coupe.exa`,
    ];
    fs.writeFileSync(j.fichier, [...mauvaises, bonne("seul-valable.example"), ""].join("\n"));
    assert.deepEqual(await lireSortiesRefusees(T0, EGRESS_FENETRE_DIAGNOSTIC_MS, j.dossier), [{ hote: "seul-valable.example", nombre: 1, dernier: T0 }]);

    const hotes = Array.from({ length: 60 }, (_, i) => `h${String(i).padStart(2, "0")}.example`);
    // hNN apparaît 60 - NN fois : les 50 plus refusés sont h00 à h49.
    const bonnes = hotes.flatMap((hote, i) => Array.from({ length: 60 - i }, () => bonne(hote)));
    fs.writeFileSync(j.fichier, [...bonnes, ""].join("\n"));
    const agregat = await lireSortiesRefusees(T0, EGRESS_FENETRE_DIAGNOSTIC_MS, j.dossier);
    assert.equal(EGRESS_HOTES_AGREGES_MAX, 50);
    assert.deepEqual(
      agregat.map((a) => a.hote),
      hotes.slice(0, 50),
    );
    assert.equal(agregat[0]?.nombre, 60);

    // Journal remplacé par autre chose qu'un fichier ordinaire : erreur rendue, jamais « aucun refus ».
    fs.rmSync(j.fichier);
    fs.mkdirSync(j.fichier);
    await assert.rejects(lireSortiesRefusees(T0, EGRESS_FENETRE_DIAGNOSTIC_MS, j.dossier), /n'est pas un fichier ordinaire/);
  });

  it("lireSortiesRefusees : un fichier grossi hors d'egress n'est lu que sur sa fin (2 Mio)", async (t) => {
    const j = journalDeTest(t);
    const ligne = (hote: string) => `${JSON.stringify({ at: T0, hote, port: 443, raison: "hote" })}\n`;
    const debut = ligne("debut.example").repeat(Math.ceil((512 * 1024) / ligne("debut.example").length));
    const fin = ligne("fin.example").repeat(Math.ceil(EGRESS_JOURNAL_LECTURE_MAX / ligne("fin.example").length));
    fs.writeFileSync(j.fichier, debut + fin);
    assert.equal(EGRESS_JOURNAL_LECTURE_MAX, 2 * EGRESS_JOURNAL_MAX);
    const agregat = await lireSortiesRefusees(T0, EGRESS_FENETRE_DIAGNOSTIC_MS, j.dossier);
    assert.deepEqual(
      agregat.map((a) => a.hote),
      ["fin.example"],
    );
  });
});
