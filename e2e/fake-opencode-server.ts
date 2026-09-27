// Banc e2e (L7a, puis L26c pour la Salle OMO) : le faux opencode des tests, servi comme un vrai serveur dans la pile jetable.
//
// Il n'ajoute rien au faux (app/server/test-support/fake-opencode.ts, propriété de T1) : il l'enveloppe. Quatre modes, un seul
// par processus :
//   - sans option : l'instance PRINCIPALE du cockpit (L7a) ;
//   - « --instance omo » (L26c) : la SALLE factice. Le même faux opencode, avec les assistants de l'extension (fixtures de la
//     salle), derrière un SUPERVISEUR factice qui parle au cockpit par les fichiers du contrat de la salle (volumes `control-omo`
//     et `omo-state`, formats de shared/omo-control-protocol.ts, le module même que lit le cockpit) : état publié, battement et
//     `precheck-ok` attendus avant de « lancer » opencode, `stop-request` et homme mort honorés, relance à neuf avec un nouveau
//     démarrage. Aucune image de l'extension, aucun opencode réel, aucun appel à GitHub : c'est l'interface du cockpit qu'on
//     éprouve, pas l'extension ;
//   - « --copilot » (L26c) : le catalogue GitHub Copilot du compte, factice (GET /models en TLS, sous le nom
//     `api.githubcopilot.com` du réseau fermé de la pile jetable). Sans lui, le cockpit refuse toute activation de la salle
//     « catalogue-absent » (P1, §4.14.2) : le banc n'a aucun accès à GitHub, et c'est voulu ;
//   - « --preparer-salle » (L26c) : la préparation de la pile de la salle, jouée une fois avant son démarrage, dans un conteneur
//     jetable sans réseau (certificat du faux catalogue, `auth.json` factice, volume d'état donné à `node`).
//
// Dans les deux premiers modes :
//   - le faux écoute sur la boucle locale du conteneur ; un relais l'expose sur 4096 pour le cockpit ;
//   - une interface de pilotage, sur 4097, laisse les scénarios relever les requêtes reçues et écrire les réponses ; la salle y
//     ajoute son superviseur (/banc/salle).
//
// L'interface de pilotage exige un jeton (comparaison sans fuite de durée). Elle n'est publiée que sur 127.0.0.1 par
// docker-compose.e2e.yml, et le jeton est fabriqué à chaque exécution : rien n'est écrit dans le dépôt.
import { execFileSync } from "node:child_process";
import { createHash, randomBytes, randomUUID, timingSafeEqual, X509Certificate } from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { OMO_VERSION } from "../app/server/shared/omo-audit-4.19.4.ts";
import {
  analyserArret,
  analyserBattement,
  analyserObjet,
  analyserPrecheckOk,
  arretDuDemarrage,
  battementFrais,
  ecrireEtat,
  OMO_CONTROL_MAX_OCTETS,
  OMO_FICHIER_ETAT,
  OMO_FICHIER_PROJETS,
  OMO_FICHIERS_CONTROLE,
  OMO_LISTE_MAX,
  precheckDuDemarrage,
} from "../app/server/shared/omo-control-protocol.ts";
import type { OmoSupervisorPhase, OmoSupervisorState } from "../app/server/shared/omo-types.ts";
import { type FakeAgent, FakeOpencode, type FakeTurnScript, rulesFromConfig } from "../app/server/test-support/fake-opencode.ts";

// --- Mode ------------------------------------------------------------------------------------------------------------------------

type Mode = "principale" | "omo" | "copilot" | "preparer-salle";

/** Arguments reconnus, et eux seuls : une faute de frappe ne doit jamais démarrer l'instance principale à la place de la salle. */
function lireMode(argv: readonly string[]): Mode {
  if (argv.length === 0) return "principale";
  if (argv.length === 1 && argv[0] === "--copilot") return "copilot";
  if (argv.length === 1 && argv[0] === "--preparer-salle") return "preparer-salle";
  if (argv.length === 2 && argv[0] === "--instance" && argv[1] === "omo") return "omo";
  console.error(`faux opencode : arguments refusés (${argv.join(" ")}) ; attendu : aucun, « --instance omo », « --copilot » ou « --preparer-salle ».`);
  process.exit(2);
}

const MODE = lireMode(process.argv.slice(2));
const MAX_CORPS = 1_048_576;

const memeSecret = (donne: string, attendu: string): boolean =>
  timingSafeEqual(createHash("sha256").update(donne).digest(), createHash("sha256").update(attendu).digest());

const repondre = (res: http.ServerResponse, code: number, corps: unknown, entetes: Record<string, string> = {}): void => {
  const texte = JSON.stringify(corps);
  res.writeHead(code, { "content-type": "application/json", "cache-control": "no-store", "content-security-policy": "default-src 'none'; sandbox", ...entetes });
  res.end(texte);
};

const lireCorps = async (req: http.IncomingMessage): Promise<unknown> => {
  const morceaux: Buffer[] = [];
  let taille = 0;
  for await (const morceau of req) {
    taille += (morceau as Buffer).length;
    if (taille > MAX_CORPS) throw new Error("corps trop long");
    morceaux.push(morceau as Buffer);
  }
  const texte = Buffer.concat(morceaux).toString("utf8");
  return texte ? JSON.parse(texte) : {};
};

const estObjet = (valeur: unknown): valeur is Record<string, unknown> => typeof valeur === "object" && valeur !== null && !Array.isArray(valeur);

// --- Préparation de la pile de la salle (« --preparer-salle ») ----------------------------------------------------------------------

/** Noms servis par le certificat du faux catalogue : les trois adresses d'API Copilot que le cockpit et la salle savent autoriser. */
const NOMS_COPILOT = ["api.githubcopilot.com", "api.business.githubcopilot.com", "api.enterprise.githubcopilot.com"] as const;

/** Uid et gid de `node` dans l'image du cockpit (app/Dockerfile) : la salle factice et le faux catalogue tournent sous lui. */
const NODE_UID = 1000;
const NODE_GID = 1000;

/**
 * Préparation de la pile de la salle, jouée UNE fois par le banc avant son démarrage (`docker compose run --rm salle-preparation`),
 * dans un conteneur jetable SANS RÉSEAU, root le temps de poser et de donner à `node` :
 *   1. l'autorité et le certificat du faux catalogue Copilot, fabriqués par l'openssl de l'image (execFile, liste d'arguments,
 *      jamais de shell), valables 2 jours : le certificat PUBLIC de l'autorité dans le volume `salle-ca` (monté sur /certs du
 *      cockpit, qui l'ajoute à ses autorités : la vérification TLS n'est jamais coupée), le certificat et la clé du serveur dans le
 *      volume `salle-tls` (monté sur le seul faux catalogue). La clé de l'autorité est effacée aussitôt ; aucune clé ne touche le
 *      disque de l'hôte, et `down -v` efface le reste ;
 *   2. un `auth.json` FACTICE (entrée github-copilot seule, jetons tirés au hasard, jamais affichés, échéance lointaine pour
 *      qu'aucun rafraîchissement ne parte) dans `oc-data` : le cockpit le lit pour le catalogue du compte (P1) et en recopie
 *      l'entrée, réduite, pour la salle (D-2b-26) ;
 *   3. le volume `omo-state` donné à `node` : la salle factice y publie son état sans être root.
 * Aucun chemin ni aucune valeur ne vient de l'extérieur : les emplacements sont ceux des montages du compose du banc.
 */
function preparerSalle(): void {
  const openssl = process.env.COCKPIT_OPENSSL ?? "/usr/bin/openssl";
  const dossierCa = "/salle-ca";
  const dossierTls = "/salle-tls";
  const ocData = "/oc-data";
  const etat = "/omo-state";
  const travail = fs.mkdtempSync(path.join(os.tmpdir(), "salle-ca-"));
  try {
    const dans = (nom: string) => path.join(travail, nom);
    const lancer = (args: string[]): void => {
      execFileSync(openssl, args, { stdio: ["ignore", "ignore", "pipe"], timeout: 60_000 });
    };
    lancer([
      "req", "-x509", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:P-256", "-nodes", "-sha256", "-days", "2",
      "-keyout", dans("ca.key"), "-out", dans("ca.pem"), "-subj", "/CN=Banc e2e de la salle (autorite jetable)",
      "-addext", "basicConstraints=critical,CA:TRUE,pathlen:0", "-addext", "keyUsage=critical,keyCertSign,cRLSign",
    ]);
    lancer([
      "req", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:P-256", "-nodes", "-sha256",
      "-keyout", dans("serveur.key"), "-out", dans("serveur.csr"), "-subj", `/CN=${NOMS_COPILOT[0]}`,
    ]);
    fs.writeFileSync(
      dans("ext.cnf"),
      `subjectAltName=${NOMS_COPILOT.map((nom) => `DNS:${nom}`).join(",")}\nextendedKeyUsage=serverAuth\nbasicConstraints=critical,CA:FALSE\n`,
    );
    lancer([
      "x509", "-req", "-in", dans("serveur.csr"), "-CA", dans("ca.pem"), "-CAkey", dans("ca.key"), "-CAcreateserial", "-days", "2",
      "-sha256", "-extfile", dans("ext.cnf"), "-out", dans("serveur.pem"),
    ]);
    // Contre-vérification avant de poser quoi que ce soit : feuille signée par l'autorité, noms couverts, autorité marquée CA.
    const ca = new X509Certificate(fs.readFileSync(dans("ca.pem")));
    const feuille = new X509Certificate(fs.readFileSync(dans("serveur.pem")));
    if (!ca.ca || feuille.ca || !feuille.checkIssued(ca) || !feuille.verify(ca.publicKey) || NOMS_COPILOT.some((nom) => feuille.checkHost(nom) === undefined)) {
      throw new Error("certificat du faux catalogue incohérent");
    }
    fs.copyFileSync(dans("ca.pem"), path.join(dossierCa, "banc-e2e-salle-ca.pem"));
    fs.chmodSync(path.join(dossierCa, "banc-e2e-salle-ca.pem"), 0o644);
    fs.copyFileSync(dans("serveur.pem"), path.join(dossierTls, "serveur.pem"));
    fs.chmodSync(path.join(dossierTls, "serveur.pem"), 0o644);
    fs.copyFileSync(dans("serveur.key"), path.join(dossierTls, "serveur.key"));
    // Lisible par `node` (le faux catalogue), par personne d'autre : le volume n'est monté que sur lui.
    fs.chownSync(path.join(dossierTls, "serveur.key"), 0, NODE_GID);
    fs.chmodSync(path.join(dossierTls, "serveur.key"), 0o640);

    // auth.json FACTICE : jetons tirés au hasard, jamais affichés ni journalisés.
    const factice = (quoi: string) => `FACTICE-banc-e2e-${quoi}-${randomBytes(12).toString("hex")}`;
    const auth = { "github-copilot": { type: "oauth", refresh: factice("refresh"), access: factice("access"), expires: 4_102_444_800_000 } };
    const cibleAuth = path.join(ocData, "auth.json");
    const temporaire = `${cibleAuth}.tmp-${process.pid}`;
    fs.writeFileSync(temporaire, `${JSON.stringify(auth)}\n`, { mode: 0o600 });
    fs.renameSync(temporaire, cibleAuth);
    fs.chownSync(cibleAuth, NODE_UID, NODE_GID);
    fs.chmodSync(cibleAuth, 0o600);

    fs.chownSync(etat, NODE_UID, NODE_GID);
    fs.chmodSync(etat, 0o755);
    // Volume laissé NON VIDE : Docker recopie le propriétaire du point de montage de l'image (root) dans un volume vide à chaque
    // montage (mesuré au banc : omo-state repassé à root au démarrage de la salle factice). Ce témoin l'en empêche.
    const temoin = path.join(etat, "banc-e2e-salle-factice.txt");
    fs.writeFileSync(temoin, "Volume d'état de la salle FACTICE du banc e2e (L26c) : aucune extension, aucune donnée réelle.\n", { mode: 0o644 });
    fs.chownSync(temoin, NODE_UID, NODE_GID);
  } finally {
    // La clé de l'autorité, la demande et le numéro de série ne sortent jamais de ce conteneur.
    fs.rmSync(travail, { recursive: true, force: true });
  }
  console.log(
    `salle-preparation : certificat du faux catalogue posé (${NOMS_COPILOT.join(", ")}, 2 jours, autorité jetable), ` +
      "auth.json factice posé (entrée github-copilot seule), omo-state donné à node.",
  );
}

// --- Catalogue Copilot factice (« --copilot ») -------------------------------------------------------------------------------------

/**
 * GET /models de l'API Copilot, au format que lit `copilotModelsFromApi` (app/server/copilot.ts) : les IA du faux opencode
 * (`providers` du faux, les mêmes que GET /config/providers), pour que le catalogue du compte et celui d'opencode disent la même
 * chose. Chaque réponse porte `x-github-request-id` (réponse « marquée GitHub ») ; tout autre chemin reçoit 404. Aucun jeton n'est
 * lu ni relevé : l'autorisation n'est regardée que pour sa présence.
 */
function servirCatalogueCopilot(): void {
  const certificat = process.env.E2E_COPILOT_CERT ?? "";
  const cle = process.env.E2E_COPILOT_CLE ?? "";
  if (!certificat || !cle) {
    console.error("faux catalogue Copilot : E2E_COPILOT_CERT et E2E_COPILOT_CLE exigés (certificat de banc).");
    process.exit(2);
  }
  const port = Number(process.env.E2E_PORT_COPILOT ?? 443);
  const faux = new FakeOpencode();
  const modeles = faux.providers
    .filter((fournisseur) => fournisseur.id === "github-copilot")
    .flatMap((fournisseur) => Object.values(fournisseur.models))
    .filter((modele) => modele.available !== false)
    .map((modele) => ({
      id: modele.id,
      name: modele.name,
      object: "model",
      version: `${modele.id}-e2e`,
      model_picker_enabled: true,
      supported_endpoints: ["/chat/completions"],
      policy: { state: "enabled" },
      capabilities: {
        family: "e2e-factice",
        limits: { max_context_window_tokens: modele.limit?.context ?? 128_000, max_prompt_tokens: modele.limit?.context ?? 128_000, max_output_tokens: modele.limit?.output ?? 8_000 },
        supports: { streaming: true, tool_calls: modele.capabilities?.toolcall === true, reasoning_effort: Object.keys(modele.variants ?? {}) },
      },
    }));
  const marque = { "x-github-request-id": "e2e-faux-catalogue" };
  let servies = 0;
  const serveur = https.createServer({ cert: fs.readFileSync(certificat), key: fs.readFileSync(cle) }, (req, res) => {
    const chemin = new URL(req.url ?? "/", "https://api.githubcopilot.com").pathname;
    if (req.method === "GET" && chemin === "/models" && typeof req.headers.authorization === "string") {
      servies++;
      repondre(res, 200, { object: "list", data: modeles }, marque);
      return;
    }
    repondre(res, 404, { message: "route non servie par le faux catalogue" }, marque);
  });
  serveur.listen(port, "0.0.0.0", () => console.log(`faux catalogue Copilot : ${modeles.length} IA sur 0.0.0.0:${port} (TLS)`));
  const arreter = (signal: string): void => {
    console.log(`faux catalogue Copilot : arrêt (${signal}), ${servies} catalogue(s) servi(s).`);
    serveur.close(() => process.exit(0));
    serveur.closeAllConnections();
  };
  process.on("SIGTERM", () => arreter("SIGTERM"));
  process.on("SIGINT", () => arreter("SIGINT"));
}

// [3d] début : rejeu d'événements (itération 3, L35 ; M20). Les blocs reçus sont passés TELS QUELS à `faux.emit`, qui les
// diffuse sur le flux comme opencode le ferait : aucun tour joué, aucune IA, aucune facturation. Le corps reste borné par
// MAX_CORPS (1 Mio) comme les autres routes de pilotage. Grande fusion (GF2) : le faux est passé en paramètre, chaque mode
// de la salle (L26c) ayant le sien.
function rejouer(faux: FakeOpencode, corps: { evenements?: unknown }): { emis: number; erreur: string | null } {
  const liste = corps.evenements;
  if (!Array.isArray(liste)) return { emis: 0, erreur: "evenements (liste) attendus" };
  let emis = 0;
  for (const brut of liste) {
    const evenement = brut as { type?: unknown; properties?: unknown; id?: unknown } | null;
    if (typeof evenement?.type !== "string" || typeof evenement.properties !== "object" || evenement.properties === null) {
      return { emis, erreur: "chaque événement attend { type, properties }" };
    }
    const proprietes = evenement.properties as Record<string, unknown>;
    faux.emit(typeof evenement.id === "string" ? { type: evenement.type, properties: proprietes, id: evenement.id } : { type: evenement.type, properties: proprietes });
    emis++;
  }
  return { emis, erreur: null };
}
// [3d] fin

// --- Faux opencode (instance principale ou salle) ----------------------------------------------------------------------------------

async function servirOpencode(mode: "principale" | "omo"): Promise<void> {
  const PORT_API = Number(process.env.E2E_PORT_API ?? 4096);
  const PORT_BANC = Number(process.env.E2E_PORT_BANC ?? 4097);
  const MOT_DE_PASSE = process.env.E2E_FAUX_MOT_DE_PASSE ?? process.env.OPENCODE_SERVER_PASSWORD ?? "";
  const JETON = process.env.E2E_JETON_CONTROLE ?? "";

  if (!MOT_DE_PASSE) {
    console.error("faux opencode : E2E_FAUX_MOT_DE_PASSE manquant (le cockpit s'authentifie auprès d'opencode).");
    process.exit(2);
  }
  if (!JETON) {
    console.error("faux opencode : E2E_JETON_CONTROLE manquant (interface de pilotage du banc).");
    process.exit(2);
  }

  const faux = new FakeOpencode({
    password: MOT_DE_PASSE,
    directory: process.env.E2E_FAUX_DOSSIER ?? "/workspace",
    project: process.env.E2E_FAUX_PROJET ?? "global",
  });
  const amont = await faux.start();
  const portAmont = Number(new URL(amont).port);

  // Salle : les assistants de l'extension, et un superviseur qui décide quand « opencode » est joignable.
  const salle = mode === "omo" ? creerSalle(faux, amont, MOT_DE_PASSE) : null;

  /**
   * Relais : le faux écoute sur 127.0.0.1 (il est écrit pour les tests, où c'est le bon choix), alors que le cockpit l'appelle
   * depuis un autre conteneur. Un relais d'octets ne change ni les en-têtes ni le flux d'événements. Salle : tant que son
   * superviseur n'a pas « lancé » opencode, la connexion est coupée aussitôt (rien n'écoute, comme un opencode arrêté).
   */
  const relayees = new Set<net.Socket>();
  const relais = net.createServer((entrant) => {
    if (salle !== null && !salle.joignable()) {
      entrant.destroy();
      return;
    }
    const sortant = net.connect(portAmont, "127.0.0.1");
    relayees.add(entrant);
    entrant.on("close", () => relayees.delete(entrant));
    entrant.on("error", () => sortant.destroy());
    sortant.on("error", () => entrant.destroy());
    entrant.pipe(sortant);
    sortant.pipe(entrant);
  });
  relais.listen(PORT_API, "0.0.0.0", () => console.log(`faux opencode (${mode}) : API sur 0.0.0.0:${PORT_API}`));
  // Salle arrêtée : toutes les connexions relayées tombent, flux d'événements compris (opencode tué par son superviseur).
  salle?.surArret(() => {
    for (const prise of relayees) prise.destroy();
    relayees.clear();
    faux.disconnectStreams();
  });

  // --- Interface de pilotage du banc -------------------------------------------------------------------------------------------

  const banc = http.createServer((req, res) => {
    void (async () => {
      try {
        const jeton = req.headers["x-banc-jeton"];
        if (typeof jeton !== "string" || !memeSecret(jeton, JETON)) {
          repondre(res, 401, { erreur: "jeton du banc manquant ou incorrect" });
          return;
        }
        const chemin = new URL(req.url ?? "/", "http://banc").pathname;
        if (req.method === "GET" && chemin === "/banc/etat") {
          repondre(res, 200, { instance: mode, version: faux.version, dossier: faux.directory, requetes: faux.requests.length, echecs: faux.failures.length });
          return;
        }
        if (req.method === "GET" && chemin === "/banc/requetes") {
          repondre(res, 200, { requetes: faux.requests });
          return;
        }
        if (req.method === "GET" && chemin === "/banc/evenements") {
          repondre(res, 200, { evenements: faux.emitted });
          return;
        }
        if (req.method === "POST" && chemin === "/banc/script") {
          const corps = (await lireCorps(req)) as { sessionID?: unknown; tours?: unknown };
          if (typeof corps.sessionID !== "string" || !Array.isArray(corps.tours)) {
            repondre(res, 400, { erreur: "sessionID (texte) et tours (liste) attendus" });
            return;
          }
          faux.script(corps.sessionID, ...(corps.tours as FakeTurnScript[]));
          repondre(res, 200, { ok: true });
          return;
        }
        if (req.method === "POST" && chemin === "/banc/defaut") {
          const corps = (await lireCorps(req)) as { tour?: unknown };
          if (typeof corps.tour !== "object" || corps.tour === null) {
            repondre(res, 400, { erreur: "tour (objet) attendu" });
            return;
          }
          faux.defaultTurn = corps.tour as FakeTurnScript;
          repondre(res, 200, { ok: true });
          return;
        }
        // [3d] début : rejeu d'une suite d'événements (itération 3, L35 ; M20), derrière le même jeton que le reste du pilotage.
        if (req.method === "POST" && chemin === "/banc/emettre") {
          const resultat = rejouer(faux, (await lireCorps(req)) as { evenements?: unknown });
          repondre(res, resultat.erreur === null ? 200 : 400, resultat.erreur === null ? { ok: true, emis: resultat.emis } : { erreur: resultat.erreur });
          return;
        }
        // [3d] fin
        if (req.method === "POST" && chemin === "/banc/oublier") {
          faux.requests.length = 0;
          faux.emitted.length = 0;
          repondre(res, 200, { ok: true });
          return;
        }
        if (salle !== null && chemin.startsWith("/banc/salle")) {
          const [code, corps] = await salle.piloter(req.method ?? "GET", chemin, req.method === "POST" ? await lireCorps(req) : {});
          repondre(res, code, corps);
          return;
        }
        repondre(res, 404, { erreur: "route inconnue" });
      } catch (err) {
        repondre(res, 400, { erreur: err instanceof Error ? err.message : "requête refusée" });
      }
    })();
  });
  banc.listen(PORT_BANC, "0.0.0.0", () => console.log(`faux opencode (${mode}) : pilotage du banc sur 0.0.0.0:${PORT_BANC}`));

  salle?.demarrer();

  const arreter = (signal: string): void => {
    console.log(`faux opencode (${mode}) : arrêt (${signal}).`);
    salle?.fermer();
    relais.close();
    banc.close();
    void faux.close().then(() => process.exit(0));
  };
  process.on("SIGTERM", () => arreter("SIGTERM"));
  process.on("SIGINT", () => arreter("SIGINT"));
}

// --- Salle factice : assistants et superviseur (« --instance omo ») -----------------------------------------------------------------

/** IA des assistants de la salle : une IA GitHub Copilot du faux, présente au catalogue du compte factice. */
const IA_SALLE = { providerID: "github-copilot", modelID: "gpt-5-mini" };

/**
 * Assistants de l'extension, tels que GET /agent de la salle les rend (fixtures de la salle, noms de la 4.19.4 : l'orchestrateur
 * Sisyphus, le planificateur Prometheus, leurs exécutants). Leurs règles sont celles d'une instance sans demande de l'extension :
 * ce n'est pas elles qu'on éprouve ici (le banc complet de L21b le fait avec la vraie image), mais l'interface du cockpit.
 */
function assistantsDeLaSalle(): FakeAgent[] {
  const regles = rulesFromConfig({ "*": "allow", question: "deny", doom_loop: "ask", external_directory: { "*": "ask" } });
  const assistant = (name: string, agentMode: FakeAgent["mode"], description: string): FakeAgent => ({
    name,
    mode: agentMode,
    description,
    model: { ...IA_SALLE },
    options: {},
    permission: [...regles],
  });
  const cache = (name: string): FakeAgent => ({ name, mode: "primary", native: true, hidden: true, options: {}, permission: rulesFromConfig({ "*": "deny" }) });
  return [
    assistant("sisyphus", "primary", "Orchestrateur de l'extension (fixture du banc e2e)."),
    assistant("prometheus", "primary", "Planificateur de l'extension (fixture du banc e2e)."),
    assistant("sisyphus-junior", "subagent", "Exécutant de l'extension (fixture du banc e2e)."),
    assistant("oracle", "subagent", "Conseiller de l'extension (fixture du banc e2e)."),
    cache("compaction"),
    cache("title"),
    cache("summary"),
  ];
}

/** Réglages du superviseur factice, posés par les scénarios (POST /banc/salle) et publiés au démarrage suivant. */
interface ReglagesSalle {
  /** `.git` non protégés relevés par la « sonde » : la salle ATTEND, le cockpit refuse son pré-contrôle (A16 point 4). */
  nonProteges: string[];
  limiteAtteinte: boolean;
  manifesteReference: OmoSupervisorState["manifesteReference"];
  imageId: string;
  /** Durée de la phase « arret » avant la relance à neuf : assez longue pour que la page puisse dire « Salle en relance ». */
  dureeArretMs: number;
}

/** Identifiant d'image publié par la salle factice : la version auditée (sinon « image-inattendue »), et le mot « factice ». */
const IMAGE_FACTICE = `oh-my-openagent@${OMO_VERSION} e2e-salle-factice`;

/** Empreinte du « manifeste » factice : un SHA-256 bien formé, qui ne prétend rien de plus. */
const MANIFESTE_FACTICE = createHash("sha256").update("e2e-salle-factice").digest("hex");

/** Délais du superviseur factice : relecture du contrôle, attente de la liste des projets au premier démarrage. */
const TOUR_MS = 250;
const ATTENTE_LISTE_MS = 20_000;

interface Salle {
  joignable(): boolean;
  surArret(fn: () => void): void;
  piloter(methode: string, chemin: string, corps: unknown): Promise<[number, unknown]>;
  demarrer(): void;
  fermer(): void;
}

function creerSalle(faux: FakeOpencode, amont: string, motDePasse: string): Salle {
  const controle = process.env.E2E_SALLE_CONTROLE ?? "/control";
  const dossierEtat = process.env.E2E_SALLE_ETAT ?? "/omo-state";
  const autorisation = `Basic ${Buffer.from(`opencode:${motDePasse}`).toString("base64")}`;
  faux.setAgents(assistantsDeLaSalle());

  const reglages: ReglagesSalle = { nonProteges: [], limiteAtteinte: false, manifesteReference: "ok", imageId: IMAGE_FACTICE, dureeArretMs: 3_000 };
  let startId = "";
  let startedAt = 0;
  let phase: OmoSupervisorPhase = "verification";
  let projets: string[] = [];
  let demarrages = 0;
  let liste = false;
  let minuterie: NodeJS.Timeout | null = null;
  let relance: NodeJS.Timeout | null = null;
  let premierTourA = Date.now();
  const journal: Array<{ at: number; startId: string; phase: OmoSupervisorPhase; cause: string }> = [];
  const auxArrets: Array<() => void> = [];
  /** Sessions vues dans le flux du faux (session.created), relevées au fil de l'eau : `oublier` du banc ne les efface pas. */
  const sessionsVues = new Set<string>();
  let relevesJusqua = 0;
  /**
   * Flux d'événements du cockpit depuis le dernier lancement d'opencode : indice de `faux.requests` au lancement, heure du
   * lancement, heure du premier `GET /global/event` reçu après lui (relevé à chaque tour, 250 ms près). Le cockpit se rebranche
   * avec un délai croissant (500 ms à 10 s, opencode.ts) : un fait de la salle émis avant ce premier flux n'est vu par personne.
   */
  let indiceLancement = 0;
  let lanceA = 0;
  let fluxA = 0;

  const fluxDepuisLancement = (): number => {
    if (phase !== "opencode-lance") return 0;
    // Relevés vidés par le banc (`/banc/oublier`) : tout ce qui reste est postérieur au lancement.
    if (faux.requests.length < indiceLancement) indiceLancement = 0;
    return faux.requests.slice(indiceLancement).filter((r) => r.method === "GET" && r.pathname === "/global/event" && r.authorized).length;
  };

  const releverSessions = (): void => {
    if (faux.emitted.length < relevesJusqua) relevesJusqua = 0;
    for (const bloc of faux.emitted.slice(relevesJusqua)) {
      if (bloc.payload.type !== "session.created") continue;
      const info = (bloc.payload.properties as { info?: { id?: unknown }; sessionID?: unknown }) ?? {};
      const id = typeof info.info?.id === "string" ? info.info.id : typeof info.sessionID === "string" ? info.sessionID : "";
      if (id !== "") sessionsVues.add(id);
    }
    relevesJusqua = faux.emitted.length;
  };

  /** Fichier du volume de contrôle, lu borné ; absent, illisible ou trop gros : null (fermé en cas de doute, comme la vraie salle). */
  const lireControle = (nom: string): string | null => {
    try {
      const chemin = path.join(controle, nom);
      const info = fs.lstatSync(chemin);
      if (!info.isFile() || info.size > OMO_CONTROL_MAX_OCTETS * 16) return null;
      return fs.readFileSync(chemin, "utf8");
    } catch {
      return null;
    }
  };

  /** Projets de la liste déposée par le cockpit (le vrai superviseur la lit à sa préparation) ; null : pas encore déposée. */
  const lireListe = (): string[] | null => {
    const brut = analyserObjet(lireControle(OMO_FICHIER_PROJETS), 1024 * 1024);
    if (!brut || !Array.isArray(brut.projets)) return null;
    return brut.projets.flatMap((p) => (estObjet(p) && typeof p.chemin === "string" && p.chemin !== "" ? [p.chemin] : []));
  };

  const normaliser = (chemin: string): string => chemin.split(/[\\/]/).filter((s) => s !== "" && s !== ".").join("/");

  /** `state.json` publié par écriture atomique (fichier voisin puis renommage), au format que relit le cockpit. */
  const publier = (): void => {
    const nonProteges = reglages.nonProteges.slice(0, OMO_LISTE_MAX);
    const etat: OmoSupervisorState = {
      startId,
      phase,
      imageId: reglages.imageId,
      manifestSha256: MANIFESTE_FACTICE,
      manifesteReference: reglages.manifesteReference,
      validation: "ok",
      dossiersConfig: [
        { chemin: "/home/node/.config/opencode", ok: true },
        { chemin: "/home/node/.omo", ok: true },
      ],
      projets: projets.map((chemin) => ({
        chemin,
        // Un projet dont un `.git` est relevé non protégé n'est pas en lecture seule ; les autres le sont (sonde de L16c).
        gitLectureSeule: !nonProteges.some((n) => normaliser(n) === normaliser(chemin) || normaliser(n).startsWith(`${normaliser(chemin)}/`)),
      })),
      workspaceGit: { verifieLe: Date.now(), limiteAtteinte: reglages.limiteAtteinte, nonProteges },
      startedAt,
    };
    const cible = path.join(dossierEtat, OMO_FICHIER_ETAT);
    const temporaire = `${cible}.${process.pid}.tmp`;
    fs.writeFileSync(temporaire, ecrireEtat(etat), { mode: 0o644 });
    fs.renameSync(temporaire, cible);
  };

  const noter = (cause: string): void => {
    journal.push({ at: Date.now(), startId, phase, cause });
    if (journal.length > 200) journal.shift();
    console.log(`salle factice : ${phase} (démarrage ${demarrages}, ${cause})`);
  };

  /** Nouveau démarrage : nouvel identifiant, liste relue, phase « attente » (battement frais et `precheck-ok` attendus). */
  const nouveauDemarrage = (cause: string): void => {
    const lue = lireListe();
    projets = lue ?? [];
    liste = lue !== null;
    startId = randomUUID();
    startedAt = Date.now();
    phase = "attente";
    demarrages++;
    publier();
    noter(cause);
  };

  /** opencode « tué » : connexions coupées, tours en cours abandonnés (un opencode arrêté n'émet plus rien). */
  const tuerOpencode = async (): Promise<void> => {
    for (const fn of auxArrets) fn();
    releverSessions();
    for (const id of sessionsVues) {
      if (faux.statusOf(id).type === "idle") continue;
      await fetch(`${amont}/session/${encodeURIComponent(id)}/abort`, { method: "POST", headers: { authorization: autorisation } }).catch(() => undefined);
    }
  };

  /** Arrêt du démarrage en cours, puis relance à neuf après `dureeArretMs` (le vrai superviseur sort, Docker le relance). */
  const arreter = (cause: string): void => {
    if (phase === "arret") return;
    phase = "arret";
    publier();
    noter(cause);
    void tuerOpencode();
    relance = setTimeout(() => {
      relance = null;
      nouveauDemarrage(`relance à neuf après ${cause}`);
    }, reglages.dureeArretMs);
  };

  const tour = (): void => {
    const maintenant = Date.now();
    releverSessions();
    if (phase === "verification") {
      // Premier démarrage : la liste des projets est attendue un moment (le cockpit la dépose en lançant son battement).
      if (lireListe() === null && maintenant - premierTourA < ATTENTE_LISTE_MS) return;
      nouveauDemarrage("premier démarrage");
      return;
    }
    if (phase === "arret") return;
    const battement = analyserBattement(lireControle(OMO_FICHIERS_CONTROLE.battement));
    const arret = analyserArret(lireControle(OMO_FICHIERS_CONTROLE.arret));
    if (arretDuDemarrage(arret, startId, startedAt)) {
      arreter(`stop-request « ${arret?.cause ?? "?"} »`);
      return;
    }
    const frais = battementFrais(battement, maintenant);
    if (phase === "opencode-lance") {
      if (fluxA === 0 && fluxDepuisLancement() > 0) fluxA = maintenant;
      if (!frais) arreter("battement périmé (homme mort)");
      return;
    }
    // Phase « attente » : opencode n'est lancé qu'avec un battement frais ET le `precheck-ok` de CE démarrage.
    const precheck = analyserPrecheckOk(lireControle(OMO_FICHIERS_CONTROLE.precheck));
    if (frais && precheckDuDemarrage(precheck, startId, maintenant)) {
      phase = "opencode-lance";
      indiceLancement = faux.requests.length;
      lanceA = maintenant;
      fluxA = 0;
      publier();
      noter("battement frais et pré-contrôle du démarrage");
    }
  };

  const listeDeTextes = (valeur: unknown): string[] | null =>
    Array.isArray(valeur) && valeur.length <= OMO_LISTE_MAX && valeur.every((v) => typeof v === "string" && v.length > 0 && v.length <= 512) ? [...(valeur as string[])] : null;

  return {
    joignable: () => phase === "opencode-lance",
    surArret: (fn) => void auxArrets.push(fn),

    async piloter(methode, chemin, corps) {
      if (methode === "GET" && chemin === "/banc/salle") {
        // `fluxDepuisLancement` : flux d'événements ouverts par le cockpit depuis le lancement d'opencode (0 : le cockpit ne voit
        // encore rien de ce démarrage) ; `fluxApresMs` : délai entre le lancement et le premier d'entre eux, null s'il n'y en a pas.
        const flux = fluxDepuisLancement();
        const fluxApresMs = phase === "opencode-lance" && flux > 0 ? Math.max(0, (fluxA === 0 ? Date.now() : fluxA) - lanceA) : null;
        return [200, { startId, phase, startedAt, demarrages, projets, listeLue: liste, joignable: phase === "opencode-lance", fluxDepuisLancement: flux, fluxApresMs, reglages, journal: journal.slice(-30) }];
      }
      if (methode === "POST" && chemin === "/banc/salle") {
        if (!estObjet(corps)) return [400, { erreur: "objet attendu" }];
        const inconnue = Object.keys(corps).find((cle) => !["nonProteges", "limiteAtteinte", "manifesteReference", "imageId", "dureeArretMs", "relancer"].includes(cle));
        if (inconnue !== undefined) return [400, { erreur: `clé inconnue « ${inconnue} »` }];
        if (corps.nonProteges !== undefined) {
          const lue = listeDeTextes(corps.nonProteges);
          if (lue === null) return [400, { erreur: `nonProteges : ${OMO_LISTE_MAX} chemins au plus` }];
          reglages.nonProteges = lue;
        }
        if (corps.limiteAtteinte !== undefined) {
          if (typeof corps.limiteAtteinte !== "boolean") return [400, { erreur: "limiteAtteinte : booléen" }];
          reglages.limiteAtteinte = corps.limiteAtteinte;
        }
        if (corps.manifesteReference !== undefined) {
          if (corps.manifesteReference !== "ok" && corps.manifesteReference !== "amorce" && corps.manifesteReference !== "ecart") return [400, { erreur: "manifesteReference : ok, amorce ou ecart" }];
          reglages.manifesteReference = corps.manifesteReference;
        }
        if (corps.imageId !== undefined) {
          if (typeof corps.imageId !== "string" || corps.imageId.length > 256) return [400, { erreur: "imageId : texte de 256 caractères au plus" }];
          reglages.imageId = corps.imageId;
        }
        if (corps.dureeArretMs !== undefined) {
          if (!Number.isInteger(corps.dureeArretMs) || (corps.dureeArretMs as number) < 500 || (corps.dureeArretMs as number) > 30_000) return [400, { erreur: "dureeArretMs : de 500 à 30 000" }];
          reglages.dureeArretMs = corps.dureeArretMs as number;
        }
        // Les réglages valent au démarrage suivant ; sans relance, l'état publié est seulement réécrit (même démarrage).
        if (corps.relancer === true) arreter("relance demandée par le banc");
        else if (phase !== "verification") publier();
        return [200, { ok: true, startId, phase, reglages }];
      }
      if (methode === "POST" && chemin === "/banc/salle/racine-etrangere") {
        // Racine créée dans la salle SANS passer par le cockpit (détection 2) : la route même d'opencode, jamais un raccourci.
        if (phase !== "opencode-lance") return [409, { erreur: `salle non lancée (phase ${phase})` }];
        const dossier = estObjet(corps) && typeof corps.dossier === "string" ? corps.dossier : faux.directory;
        const reponse = await fetch(`${amont}/session?directory=${encodeURIComponent(dossier)}`, {
          method: "POST",
          headers: { authorization: autorisation, "content-type": "application/json" },
          body: JSON.stringify({ title: "Racine créée hors du cockpit (banc e2e)" }),
        });
        const session = (await reponse.json()) as { id?: unknown };
        return [reponse.ok ? 200 : 502, { sessionID: typeof session.id === "string" ? session.id : null }];
      }
      return [404, { erreur: "route inconnue du superviseur factice" }];
    },

    demarrer() {
      premierTourA = Date.now();
      minuterie = setInterval(() => {
        try {
          tour();
        } catch (err) {
          console.error(`salle factice : tour en échec (${err instanceof Error ? err.message : String(err)})`);
        }
      }, TOUR_MS);
    },

    fermer() {
      if (minuterie !== null) clearInterval(minuterie);
      if (relance !== null) clearTimeout(relance);
    },
  };
}

// --- Démarrage ---------------------------------------------------------------------------------------------------------------------
// En fin de module : les constantes des modes (noms du catalogue, assistants et délais de la salle) sont déjà initialisées.

if (MODE === "copilot") servirCatalogueCopilot();
else if (MODE === "preparer-salle") preparerSalle();
else await servirOpencode(MODE);
