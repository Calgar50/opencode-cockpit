// Banc e2e (L7a) : isolation, pile Docker jetable et déroulé d'une exécution.
//
// Point d'entrée réel de scripts/run-e2e.sh. Ce fichier tient trois rôles, volontairement réunis parce que le banc
// n'a droit à aucune dépendance (P8) et que sa fiche ne prévoit pas de fichier de test à part :
//   1. les gardes d'isolation (nom de projet, images, fichier d'environnement, verrou, port) ;
//   2. la conduite de la pile (build, up, santé, down -v) et des scénarios ;
//   3. leurs propres vérifications, lancées par « run-e2e.sh --gardes », sans Docker ni navigateur.
//
// Rien de ce fichier ne tourne en intégration continue (D-06) ni dans l'image : le banc vit hors de app/.
import { spawn, spawnSync } from "node:child_process";
import crypto from "node:crypto";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import https from "node:https";
import net from "node:net";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { FETCH_BLOCKED_PORTS } from "../../app/server/fetch-ports.ts";
import { argumentsNavigateur, ouvrirNavigateur } from "./cdp.mjs";
import {
  attendreOpencode,
  attendreSante,
  CODE_EMPREINTE,
  connecterNavigateur,
  controlerPair,
  creerClientCockpit,
  creerTransport,
  relevesDuBanc,
  verifierCertificatPublic,
} from "./cockpit.mjs";

/** Racine du dépôt : e2e/lib → e2e → dépôt. */
export const RACINE = path.resolve(import.meta.dirname, "..", "..");

export const MODES = ["faux", "reel-hors-ligne", "reel"];

/**
 * Schéma servi par le cockpit de la pile jetable : HTTPS épinglé par défaut, comme une installation 1.0.5 ; HTTP
 * seulement par « --http », dans le mode HTTP explicite de la 1.0.5 (date de confirmation posée par le banc).
 */
export const SCHEMAS = ["https", "http"];

/** Fichiers publics du volume cockpit-tls, lus comme « cockpit.ps1 open » : feuille seule et empreintes, jamais la clé. */
const FICHIERS_TLS_PUBLICS = { certificat: "/tls/public/cockpit.crt", empreintes: "/tls/public/cockpit-tls.json" };

/** Profil Compose activé par mode (la surcharge e2e/docker-compose.e2e.yml range chaque service sous son profil). */
const PROFILS = { faux: ["faux"], "reel-hors-ligne": ["reel-hors-ligne"], reel: ["reel"] };

/** Services démarrés par mode ; ceux qui sont bâtis depuis les sources sont dans IMAGES_A_BATIR. */
const SERVICES = { faux: ["faux-opencode", "cockpit"], "reel-hors-ligne": ["opencode", "faux-fournisseur", "cockpit"], reel: ["opencode", "cockpit"] };
const IMAGES_A_BATIR = { faux: ["cockpit"], "reel-hors-ligne": ["cockpit", "opencode"], reel: ["cockpit", "opencode"] };

/**
 * Ports que le navigateur refuse (Chromium, net/base/port_util.cc, kRestrictedPorts). Au 2026-09-16 cette liste est
 * exactement celle que fetch refuse dans Node 24 (app/server/fetch-ports.ts) : on en fait l'union plutôt que d'en
 * recopier 82 valeurs, et ECARTS_NAVIGATEUR garde la place des ports que seul le navigateur refuserait un jour.
 */
export const ECARTS_NAVIGATEUR = new Set([]);
export const PORTS_REFUSES = new Set([...FETCH_BLOCKED_PORTS, ...ECARTS_NAVIGATEUR]);

/** Port du cockpit de l'utilisateur : jamais réutilisé par le banc, même si rien n'écoute dessus. */
export const PORT_UTILISATEUR = 7777;

/** Plage dans laquelle le banc cherche des ports libres. */
const PLAGE_PORTS = { debut: 17800, fin: 17899 };

/** Préfixes réservés à la pile de l'utilisateur : ni projet, ni image du banc ne peut commencer par l'un d'eux. */
export const PREFIXES_INTERDITS = ["opencode-cockpit", "ocauto"];

/** Dossier de travail du banc, hors du dépôt (verrou, fichiers d'environnement, captures). */
export const DOSSIER_BANC = path.join(process.env.TEMP || process.env.TMPDIR || "/tmp", "opencode-cockpit-e2e");

/** Verrou des exécutions qui parlent à un vrai opencode : une seule à la fois sur la machine. */
export const VERROU = path.join(DOSSIER_BANC, "verrou-reel");

/** Une erreur prévue du banc : message affiché tel quel, sans pile d'appels. */
export class ErreurBanc extends Error {}

const refuser = (message) => {
  throw new ErreurBanc(message);
};

// --- Gardes d'isolation -----------------------------------------------------------------------

/** Nom de projet normalisé comme le fait Compose : minuscules, puis caractères hors [a-z0-9_-] retirés. */
export function normaliserProjet(nom) {
  return String(nom ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, "");
}

/**
 * Nom de projet du banc : <préfixe>-<id>. Il ne doit jamais désigner la pile de l'utilisateur, ni avant ni après la
 * normalisation de Compose (« OpenCode-Cockpit » y deviendrait « opencode-cockpit »).
 */
export function verifierProjet(projet) {
  const normalise = normaliserProjet(projet);
  if (!normalise) refuser("nom de projet Docker vide.");
  if (!/^[a-z0-9][a-z0-9_-]*$/.test(normalise)) refuser(`nom de projet Docker refusé : « ${projet} ».`);
  for (const interdit of PREFIXES_INTERDITS) {
    if (normalise.startsWith(interdit)) {
      refuser(`nom de projet Docker refusé : « ${projet} » désigne la pile de l'utilisateur (préfixe « ${interdit} »).`);
    }
  }
  return normalise;
}

/** Étiquette d'image du banc : jamais une image de l'utilisateur. */
export function verifierImage(image) {
  const valeur = String(image ?? "").trim();
  if (!/^[a-z0-9][a-z0-9._/-]*:[a-zA-Z0-9._-]+$/.test(valeur)) refuser(`étiquette d'image refusée : « ${image} ».`);
  for (const interdit of PREFIXES_INTERDITS) {
    if (valeur.toLowerCase().startsWith(`${interdit}/`) || valeur.toLowerCase().startsWith(`${interdit}-`)) {
      refuser(`étiquette d'image refusée : « ${valeur} » désigne les images de l'utilisateur (préfixe « ${interdit} »).`);
    }
  }
  return valeur;
}

/**
 * Fichier d'environnement du banc : un fichier neuf, hors du dépôt, dont le nom ne peut pas être celui d'un « .env ».
 * Une faute de frappe ne doit jamais faire lire — ni écraser — le .env de l'utilisateur, qui porte ses vrais secrets.
 */
export function verifierFichierEnv(chemin, { racine = RACINE, existe = (p) => fs.existsSync(p) } = {}) {
  const resolu = path.resolve(chemin);
  const nom = path.basename(resolu);
  if (nom === ".env" || nom.startsWith(".env.")) refuser(`fichier d'environnement refusé : « ${resolu} » est un .env.`);
  const relatif = path.relative(racine, resolu);
  if (relatif && !relatif.startsWith("..") && !path.isAbsolute(relatif)) {
    refuser(`fichier d'environnement refusé : « ${resolu} » est dans le dépôt.`);
  }
  if (existe(resolu)) refuser(`fichier d'environnement refusé : « ${resolu} » existe déjà.`);
  return resolu;
}

/** Port utilisable par le banc : différent de 7777, refusé ni par fetch ni par le navigateur. */
export function portUtilisable(port) {
  return Number.isInteger(port) && port > 1024 && port < 65536 && port !== PORT_UTILISATEUR && !PORTS_REFUSES.has(port);
}

/** Port libre sur la boucle locale (le banc ne publie jamais ailleurs que sur 127.0.0.1). */
export async function portLibre(port) {
  return await new Promise((resolve) => {
    const serveur = net.createServer();
    serveur.once("error", () => resolve(false));
    serveur.listen(port, "127.0.0.1", () => serveur.close(() => resolve(true)));
  });
}

/** Choisit `combien` ports utilisables et libres dans la plage du banc. */
export async function choisirPorts(combien, { debut = PLAGE_PORTS.debut, fin = PLAGE_PORTS.fin, libre = portLibre } = {}) {
  const trouves = [];
  for (let port = debut; port <= fin && trouves.length < combien; port++) {
    if (!portUtilisable(port)) continue;
    if (await libre(port)) trouves.push(port);
  }
  if (trouves.length < combien) refuser(`aucun port libre entre ${debut} et ${fin} (il en faut ${combien}).`);
  return trouves;
}

/**
 * Verrou : un dossier créé en exclusivité suffit (mkdir est atomique sur NTFS comme sur ext4, et n'ajoute aucune
 * dépendance). Le banc refuse de démarrer, quel que soit son mode, tant qu'une exécution réelle tourne : deux piles
 * jetables se disputeraient les images, les ports et le vrai opencode.
 */
export function verrouTenu(chemin = VERROU) {
  return fs.existsSync(chemin);
}

export function prendreVerrou(chemin = VERROU) {
  // Dossier fermé (0700) : le dossier temporaire est partagé entre comptes sur les systèmes de type Unix.
  fs.mkdirSync(path.dirname(chemin), { recursive: true, mode: 0o700 });
  try {
    fs.mkdirSync(chemin);
  } catch (err) {
    if (err?.code === "EEXIST") refuser(messageVerrouTenu(chemin));
    throw err;
  }
  fs.writeFileSync(path.join(chemin, "pid.txt"), `${process.pid}\n`, { encoding: "utf8", mode: 0o600 });
  return chemin;
}

export function rendreVerrou(chemin = VERROU) {
  fs.rmSync(chemin, { recursive: true, force: true });
}

/**
 * Refus d'un verrou tenu, avec le processus noté dans pid.txt et la marche à suivre : un verrou laissé par une exécution
 * tuée refuserait sinon toute exécution du banc sans dire comment le lever. « ne tourne plus » est sûr ; « tourne encore »
 * peut venir d'un numéro réutilisé par un autre programme, d'où la prudence du conseil.
 */
export function messageVerrouTenu(chemin = VERROU) {
  let pid = null;
  try {
    const lu = fs.readFileSync(path.join(chemin, "pid.txt"), "utf8").trim();
    if (/^\d{1,10}$/.test(lu)) pid = Number(lu);
  } catch {
    // pid.txt absent (verrou pris à l'instant) ou illisible : le message reste valable sans le numéro.
  }
  let qui = "";
  if (pid !== null) qui = processusVivant(pid) ? ` (processus ${pid}, qui tourne encore)` : ` (processus ${pid}, qui ne tourne plus)`;
  return `une exécution réelle du banc tient déjà le verrou « ${chemin} »${qui}. Si aucune exécution du banc ne tourne, effacez ce dossier.`;
}

function processusVivant(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err?.code === "EPERM";
  }
}

/**
 * Fichiers d'environnement restés dans le dossier du banc : à sa racine, et dans le dossier de chaque projet, là où une
 * exécution écrit « banc.env ». Chemins relatifs à `dossier`, triés ; jamais le contenu.
 */
export function fichiersEnvRestants(dossier = DOSSIER_BANC) {
  const estEnv = (entree) => !entree.isDirectory() && entree.name.toLowerCase().endsWith(".env");
  // Un dossier qui disparaît pendant la lecture (verrou rendu par une autre exécution) ne contient plus rien.
  const lire = (chemin) => {
    try {
      return fs.readdirSync(chemin, { withFileTypes: true });
    } catch (err) {
      if (err?.code === "ENOENT" || err?.code === "ENOTDIR") return [];
      throw err;
    }
  };
  const restes = [];
  for (const entree of lire(dossier)) {
    if (estEnv(entree)) restes.push(entree.name);
    else if (entree.isDirectory()) {
      for (const sous of lire(path.join(dossier, entree.name))) {
        if (estEnv(sous)) restes.push(path.join(entree.name, sous.name));
      }
    }
  }
  return restes.sort();
}

// --- Mesure M-B1 ------------------------------------------------------------------------------

/**
 * « --reel-hors-ligne » n'existe que si la mesure M-B1 l'a conclu possible et a donné son levier (plan §3.2). Le
 * compte rendu vit hors du dépôt (execution/mesures/MX1.md) : on le cherche là où il est, sans jamais le supposer.
 */
export function mesureMB1(dossiers = dossiersDeMesures()) {
  for (const dossier of dossiers) {
    const fichier = path.join(dossier, "MX1.md");
    let texte;
    try {
      texte = fs.readFileSync(fichier, "utf8");
    } catch {
      continue;
    }
    const ligne = texte.split("\n").find((l) => l.includes("M-B1") && l.includes("**Oui**"));
    const levier = /COCKPIT_ALLOWED_PROVIDERS/.test(texte);
    if (ligne && levier) return { possible: true, fichier };
    return { possible: false, fichier, raison: ligne ? "le levier mesuré n'y figure pas" : "M-B1 n'y est pas conclue positive" };
  }
  return { possible: false, fichier: null, raison: `compte rendu MX1.md introuvable (cherché dans ${dossiers.join(", ")})` };
}

function dossiersDeMesures() {
  const liste = [];
  if (process.env.E2E_MESURES_DIR) liste.push(path.resolve(process.env.E2E_MESURES_DIR));
  liste.push(path.resolve("execution", "mesures"), path.resolve(RACINE, "..", "execution", "mesures"));
  return liste;
}

// --- Commandes Docker -------------------------------------------------------------------------

/** Secret du banc : jamais écrit ailleurs que dans le fichier d'environnement, jamais affiché. */
const secret = (octets) => crypto.randomBytes(octets).toString("base64url");

/**
 * Arguments communs à toutes les commandes Compose du banc : le projet est toujours donné en clair par -p, et la
 * surcharge exige les variables E2E_* (sans fichier d'environnement, Compose refuse au lieu de retomber sur la pile
 * de l'utilisateur, dont le nom et les images sont écrits dans docker-compose.yml).
 */
export function argumentsCompose(plan, sousCommande) {
  const args = ["compose", "-p", plan.projet, "-f", "docker-compose.yml", "-f", "e2e/docker-compose.e2e.yml", "--env-file", plan.fichierEnv];
  for (const profil of plan.profils) args.push("--profile", profil);
  return [...args, ...sousCommande];
}

/** Commande lisible pour --dry-run et pour le journal (aucune valeur secrète n'y figure). */
export const texteCommande = (args) => ["docker", ...args].join(" ");

/**
 * Environnement passé à docker : celui du processus, sans aucune variable que le fichier d'environnement du banc
 * définit. Compose donne la priorité au shell sur --env-file : un COCKPIT_LOCAL_SCHEME, un COCKPIT_PORT ou un
 * COCKPIT_TOKEN resté dans le shell changerait sinon, sans rien dire, le mode, le port ou le jeton de la pile jetable.
 */
export function environnementDocker(source = process.env, cles = CLES_ENVIRONNEMENT) {
  const env = { ...source };
  for (const nom of Object.keys(env)) {
    if (cles.has(nom) || nom.startsWith("E2E_") || nom.startsWith("COCKPIT_")) delete env[nom];
  }
  // MSYS_NO_PATHCONV : sous Git Bash, MSYS convertirait « /workspace » en chemin Windows dans les arguments.
  env.MSYS_NO_PATHCONV = "1";
  return env;
}

function executerDocker(args, { silencieux = false } = {}) {
  return new Promise((resolve, reject) => {
    const enfant = spawn("docker", args, {
      cwd: RACINE,
      env: environnementDocker(),
      stdio: silencieux ? ["ignore", "pipe", "pipe"] : ["ignore", "inherit", "inherit"],
    });
    // « sortie » mêle les deux flux (messages) ; « stdout » seul sert à lire un fichier du conteneur.
    let sortie = "";
    let stdout = "";
    if (silencieux) {
      enfant.stdout.setEncoding("utf8");
      enfant.stderr.setEncoding("utf8");
      enfant.stdout.on("data", (bloc) => {
        sortie += bloc;
        stdout += bloc;
      });
      enfant.stderr.on("data", (bloc) => (sortie += bloc));
    }
    enfant.on("error", reject);
    enfant.on("close", (code) => resolve({ code: code ?? 1, sortie, stdout }));
  });
}

/**
 * Lance une commande Compose du banc. Le nom de projet est revérifié juste avant chaque appel. Après un arrêt demandé
 * (plan.interrompu, posé par preparerNettoyage), seul « down » part encore : un « up » lancé par le déroulé pendant le
 * nettoyage relèverait la pile que celui-ci vient de démonter.
 */
export async function compose(plan, sousCommande, options = {}) {
  verifierProjet(plan.projet);
  const args = argumentsCompose(plan, sousCommande);
  if (plan.interrompu && sousCommande[0] !== "down") refuser(`exécution interrompue : la commande « ${texteCommande(args)} » n'est pas lancée.`);
  if (plan.dryRun) {
    plan.journal.push(texteCommande(args));
    console.log(`  à blanc : ${texteCommande(args)}`);
    return { code: 0, sortie: "" };
  }
  const resultat = await executerDocker(args, options);
  if (resultat.code !== 0 && !options.tolerant) {
    refuser(`la commande « ${texteCommande(args)} » a échoué (code ${resultat.code}).`);
  }
  return resultat;
}

/**
 * Suppression de la pile jetable, volumes compris. Le nom de projet est vérifié juste avant : « down -v » est la seule
 * commande du banc capable de détruire des données, et elle ne doit jamais viser la pile de l'utilisateur.
 */
export async function demonterPile(plan) {
  verifierProjet(plan.projet);
  await compose(plan, ["down", "-v", "--remove-orphans", "-t", "20"], { tolerant: true });
}

/** Seules actions permises sur un service pendant un scénario (redémarrage réel) : jamais rm, kill ni down. */
const ACTIONS_SERVICE = Object.freeze({ arreter: ["stop", "-t", "5"], demarrer: ["start"] });

/**
 * Arrête ou relance un service de la pile jetable, pour un scénario de redémarrage réel du conteneur (ctx.pile). Commande
 * Compose du banc, donc projet revérifié juste avant ; seulement les services de la pile du mode courant, seulement
 * « stop » et « start » : les volumes et les données restent.
 */
export async function servicePile(plan, action, service) {
  if (!Object.hasOwn(ACTIONS_SERVICE, action)) refuser(`action inconnue sur un service de la pile jetable : « ${action} ».`);
  if (!plan.services?.includes(service)) refuser(`service inconnu de la pile jetable : « ${service} ».`);
  await compose(plan, [...ACTIONS_SERVICE[action], service], { silencieux: true });
}

// --- Plan d'exécution -------------------------------------------------------------------------

export function identifiantExecution(maintenant = new Date()) {
  return `${maintenant.toISOString().replace(/[-:T]/g, "").slice(2, 12)}-${crypto.randomBytes(2).toString("hex")}`;
}

/**
 * Construit et vérifie tout ce qui touche à l'isolation, avant qu'une seule commande Docker ne parte.
 */
export async function preparerPlan(options) {
  const mode = options.mode;
  if (!MODES.includes(mode)) refuser(`mode inconnu : « ${mode} ».`);
  const schema = options.schema ?? "https";
  if (!SCHEMAS.includes(schema)) refuser(`schéma inconnu : « ${schema} ».`);
  const id = options.id ?? identifiantExecution();
  const projet = verifierProjet(`${options.prefixe}-${id}`);
  const imageApp = verifierImage(`${options.prefixe}/app:${options.tag}`);
  const imageOpencode = verifierImage(`${options.prefixe}/opencode:${options.tag}`);
  const dossier = path.join(DOSSIER_BANC, projet);
  const fichierEnv = verifierFichierEnv(options.fichierEnv ?? path.join(dossier, "banc.env"));
  const [portCockpit, portControle, portFournisseur] = await choisirPorts(3);
  return {
    mode,
    schema,
    id,
    projet,
    profils: PROFILS[mode],
    services: SERVICES[mode],
    aBatir: IMAGES_A_BATIR[mode],
    imageApp,
    imageOpencode,
    dossier,
    fichierEnv,
    portCockpit,
    portControle,
    portFournisseur,
    dryRun: options.dryRun === true,
    motif: options.motif ?? null,
    garderPile: options.garderPile === true,
    journal: [],
    captures: path.join(dossier, "captures"),
  };
}

/**
 * Variables du fichier d'environnement du banc hors des préfixes COCKPIT_ et E2E_ : environnementDocker les retire aussi
 * de l'environnement de docker, pour que le fichier du banc l'emporte toujours.
 */
const CLES_ENVIRONNEMENT = new Set(["OPENCODE_SERVER_PASSWORD", "WORKSPACE_DIR", "ARCHIVE_DIR"]);

/**
 * Lignes du fichier d'environnement de la pile jetable (sans l'écrire). HTTPS : schéma servi par défaut par la 1.0.5,
 * aucune date de confirmation. --http : mode HTTP explicite de la 1.0.5, confirmé à l'instant au format strict.
 */
export function lignesEnvironnement(plan, { jeton, motDePasse, jetonControle, contexte, maintenant = new Date() }) {
  const acces =
    plan.schema === "http"
      ? ["COCKPIT_LOCAL_SCHEME=http", `COCKPIT_LOCAL_HTTP_CONFIRMED=${maintenant.toISOString().slice(0, 19)}Z`]
      : ["COCKPIT_LOCAL_SCHEME=https", "COCKPIT_LOCAL_HTTP_CONFIRMED="];
  return [
    `COCKPIT_APP_IMAGE=${plan.imageApp}`,
    `COCKPIT_OPENCODE_IMAGE=${plan.imageOpencode}`,
    `COCKPIT_PORT=${plan.portCockpit}`,
    `COCKPIT_TOKEN=${jeton}`,
    `COCKPIT_VERSION=e2e-${plan.id}`,
    ...acces,
    // Mode test d'origine, mesuré par M-B1 : seul « --reel-hors-ligne » parle à un faux fournisseur.
    `COCKPIT_ALLOWED_PROVIDERS=${plan.mode === "reel-hors-ligne" ? "banc" : "github-copilot"}`,
    "COCKPIT_COPILOT_API_URL=",
    `OPENCODE_SERVER_PASSWORD=${motDePasse}`,
    `WORKSPACE_DIR=${path.join(plan.dossier, "workspace")}`,
    `ARCHIVE_DIR=${path.join(plan.dossier, "archives")}`,
    `E2E_PROJET=${plan.projet}`,
    // Contexte de construction propre, hors du dépôt (preparerContexte).
    `E2E_CONTEXTE=${contexte}`,
    // Réseau interne (sans Internet) sauf en mode réel, où opencode doit joindre GitHub.
    `E2E_RESEAU_INTERNE=${plan.mode === "reel" ? "false" : "true"}`,
    `E2E_IMAGE_APP=${plan.imageApp}`,
    `E2E_IMAGE_OPENCODE=${plan.imageOpencode}`,
    `E2E_OPENCODE_HOTE=${plan.mode === "faux" ? "faux-opencode" : "opencode"}`,
    `E2E_PORT_CONTROLE=${plan.portControle}`,
    `E2E_PORT_FOURNISSEUR=${plan.portFournisseur}`,
    `E2E_JETON_CONTROLE=${jetonControle}`,
  ];
}

/** Écrit le fichier d'environnement de la pile jetable. Aucune de ses valeurs n'est affichée ni journalisée. */
export function ecrireEnvironnement(plan, contexte = path.join(plan.dossier, "contexte")) {
  // Format généré par install.ps1 (64 hexadécimaux) : sans lui, la 1.0.5 ne sert ni preuve ni ticket de connexion.
  const jeton = crypto.randomBytes(32).toString("hex");
  const motDePasse = secret(24);
  const jetonControle = secret(24);
  const lignes = lignesEnvironnement(plan, { jeton, motDePasse, jetonControle, contexte });
  // Dossiers fermés (0700) : ils portent le fichier d'environnement et les captures de la pile jetable.
  fs.mkdirSync(path.join(plan.dossier, "workspace"), { recursive: true, mode: 0o700 });
  fs.mkdirSync(path.join(plan.dossier, "archives"), { recursive: true, mode: 0o700 });
  fs.mkdirSync(plan.captures, { recursive: true, mode: 0o700 });
  fs.writeFileSync(plan.fichierEnv, `${lignes.join("\n")}\n`, { encoding: "utf8", mode: 0o600 });
  return { jeton, jetonControle };
}

// --- Contexte de build ------------------------------------------------------------------------

/**
 * Contexte propre pour « docker compose build », hors du dépôt : les fichiers que git connaît, plus ceux qui ne sont
 * pas ignorés (donc le travail en cours). Trois raisons :
 *   - une copie git temporaire a un « app/node_modules » qui est une jonction Windows, et Docker refuse alors de
 *     copier le dossier (« cannot replace to directory … with file ») ;
 *   - le contexte du dépôt enverrait au démon Docker tout ce qui traîne à côté, .env de l'utilisateur compris ;
 *   - les images du banc restent bâties depuis les sources du dossier de travail, modifications en cours comprises.
 */
export function preparerContexte(plan, { racine = RACINE } = {}) {
  const cible = path.join(plan.dossier, "contexte");
  fs.rmSync(cible, { recursive: true, force: true });
  fs.mkdirSync(cible, { recursive: true, mode: 0o700 });
  const liste = fichiersSuivis(racine);
  for (const relatif of liste) {
    const source = path.join(racine, relatif);
    let etat;
    try {
      etat = fs.lstatSync(source);
    } catch {
      continue; // fichier supprimé depuis l'index de git
    }
    if (!etat.isFile()) continue;
    const destination = path.join(cible, relatif);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.copyFileSync(source, destination);
  }
  return { chemin: cible, fichiers: liste.length };
}

function fichiersSuivis(racine) {
  const resultat = spawnSync("git", ["-C", racine, "ls-files", "-z", "--cached", "--others", "--exclude-standard"], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  if (resultat.status !== 0) refuser("git est nécessaire pour préparer le contexte de construction des images du banc.");
  return resultat.stdout.split("\0").filter(Boolean);
}

// --- Scénarios --------------------------------------------------------------------------------

export function listerScenarios(motif = null, dossier = path.join(RACINE, "e2e", "scenarios")) {
  if (!fs.existsSync(dossier)) return [];
  const fichiers = fs
    .readdirSync(dossier)
    .filter((nom) => nom.endsWith(".mjs"))
    .sort();
  const gardes = motif ? fichiers.filter((nom) => correspond(nom, motif)) : fichiers;
  return gardes.map((nom) => ({ nom, chemin: path.join(dossier, nom) }));
}

/** Motif de --scenarios : sous-chaîne, ou glob simple (« it1-* », « *api* »). */
export function correspond(nom, motif) {
  if (!motif.includes("*")) return nom.includes(motif);
  const regex = new RegExp(`^${motif.replace(/[.*+?^${}()|[\]\\]/g, (c) => (c === "*" ? ".*" : `\\${c}`))}$`);
  return regex.test(nom);
}

// --- Déroulé ----------------------------------------------------------------------------------

async function attendreDemarrage(plan, service, delaiMs = 240_000) {
  const limite = Date.now() + delaiMs;
  while (Date.now() < limite) {
    const { sortie } = await compose(plan, ["ps", "-a", "--format", "{{.Service}} {{.State}}"], { silencieux: true, tolerant: true });
    const ligne = sortie.split("\n").find((l) => l.startsWith(`${service} `)) ?? "";
    if (/\brunning\b/.test(ligne)) return true;
    if (/\bexited\b/.test(ligne)) refuser(`le service « ${service} » s'est arrêté avant d'être prêt.`);
    await new Promise((r) => setTimeout(r, 1_000));
  }
  refuser(`le service « ${service} » n'est pas prêt après ${Math.round(delaiMs / 1000)} s.`);
}

/** Sous-commandes Compose qui lisent les fichiers publics du volume cockpit-tls (conteneur démarré). */
export const lecturesTlsPubliques = () => Object.values(FICHIERS_TLS_PUBLICS).map((chemin) => ["exec", "-T", "cockpit", "cat", chemin]);

/**
 * Épinglage du banc, lu comme « cockpit.ps1 open » : certificat public et cockpit-tls.json lus sur le volume cockpit-tls
 * de la pile jetable par « docker compose exec », puis contre-vérifiés (verifierCertificatPublic). Le serveur purge et
 * réécrit ces fichiers au démarrage, avant d'écouter : on relit jusqu'à obtenir une paire cohérente.
 */
export async function lireEpinglage(plan, delaiMs = 120_000) {
  const limite = Date.now() + delaiMs;
  let derniere = "fichiers absents";
  while (Date.now() < limite) {
    const lus = [];
    for (const sous of lecturesTlsPubliques()) {
      const { code, stdout } = await compose(plan, sous, { silencieux: true, tolerant: true });
      lus.push(code === 0 ? stdout : null);
    }
    if (lus.every((texte) => texte !== null)) {
      try {
        return verifierCertificatPublic(lus[0], lus[1]);
      } catch (err) {
        derniere = err?.message ?? String(err);
      }
    }
    await new Promise((r) => setTimeout(r, 1_000));
  }
  refuser(`certificat public du cockpit illisible sur le volume de la pile jetable après ${Math.round(delaiMs / 1000)} s (${derniere}).`);
}

/**
 * Contre-épreuves de l'épinglage, sur le cockpit réel de la pile jetable : il ne suffit pas que la connexion épinglée
 * réussisse, il faut que ce qui n'est pas épinglé échoue. Deux refus attendus :
 *   1. même autorité, autre empreinte attendue : refus par controlerPair (code CODE_EMPREINTE) ;
 *   2. magasin d'autorités par défaut de Node (aucune option TLS) : refus du certificat auto-signé.
 * Si l'un passe, le banc s'arrête : son HTTPS ne prouverait rien.
 */
export async function contreEpreuvesEpinglage(url, epinglage) {
  const autre = { ...epinglage, sha256: epinglage.sha256.replace(/^[0-9A-F]{2}/, (octet) => (octet === "00" ? "01" : "00")) };
  try {
    await creerTransport(url, autre)("/api/health", { delaiMs: 10_000 });
    refuser("contre-épreuve : une autre empreinte attendue a été acceptée ; l'épinglage ne protège rien.");
  } catch (err) {
    if (err instanceof ErreurBanc) throw err;
    if (err?.code !== CODE_EMPREINTE) refuser(`contre-épreuve : refus inattendu pour une autre empreinte (${err?.code ?? err?.message}).`);
  }
  // Aucune option TLS : magasin d'autorités et vérification par défaut du processus. NODE_TLS_REJECT_UNAUTHORIZED=0
  // ou une autorité ajoutée à la main feraient accepter le certificat, et le banc s'arrêterait ici. agent: false :
  // aucun proxy de l'environnement.
  const cible = new URL(url);
  const code = await new Promise((resolve) => {
    const requete = https.get({ hostname: cible.hostname, port: cible.port, path: "/api/health", agent: false, timeout: 10_000 }, (res) => {
      res.resume();
      resolve("ACCEPTE");
    });
    requete.on("timeout", () => requete.destroy(new Error("délai dépassé")));
    requete.on("error", (err) => resolve(String(err?.code ?? err?.message ?? err)));
  });
  if (code === "ACCEPTE") refuser("contre-épreuve : le certificat du cockpit est accepté sans épinglage ; la vérification TLS est coupée dans ce processus.");
  if (!/CERT|SELF_SIGNED|UNABLE_TO_VERIFY/i.test(code)) refuser(`contre-épreuve : refus inattendu sans épinglage (${code}).`);
}

/** Signaux d'arrêt écoutés pendant une exécution, et code de sortie rendu (128 + numéro du signal). */
const SIGNAUX_ARRET = { SIGINT: 130, SIGTERM: 143, SIGHUP: 129 };

/**
 * Nettoyage d'une exécution, commun au « finally » et aux signaux d'arrêt (Ctrl+C, console fermée, arrêt demandé). Sans lui,
 * un Ctrl+C sautait le « finally » : le fichier d'environnement (jetons, mot de passe) restait sur disque, la pile restait
 * debout et le verrou restait pris.
 *   - premier signal : nettoyage complet (navigateur, down -v, fichier d'environnement, contexte, verrou), puis sortie ;
 *   - signal suivant : fichier d'environnement, contexte et verrou effacés tout de suite, sans attendre Docker, puis sortie.
 * Dès le premier signal, `plan.interrompu` est posé : le déroulé, qui continue pendant le nettoyage, ne lance plus que
 * « down » (compose). `etat` ({ navigateur, verrouPris }) est lu au moment du nettoyage. `nettoyer` ne nettoie qu'une fois, quel que soit le
 * nombre d'appels ; `retirer` enlève les écouteurs à la fin normale de l'exécution.
 */
export function preparerNettoyage(plan, etat, { processus = process, sortir = (code) => process.exit(code), verrou = VERROU } = {}) {
  const effacerFichiers = () => {
    const erreurs = [];
    const essayer = (fn) => {
      try {
        fn();
      } catch (err) {
        erreurs.push(err);
      }
    };
    essayer(() => fs.rmSync(plan.fichierEnv, { force: true }));
    essayer(() => fs.rmSync(path.join(plan.dossier, "contexte"), { recursive: true, force: true }));
    if (etat.verrouPris) {
      etat.verrouPris = false;
      essayer(() => rendreVerrou(verrou));
    }
    if (erreurs.length > 0) throw erreurs[0];
  };
  let nettoyage = null;
  const nettoyer = () =>
    (nettoyage ??= (async () => {
      if (etat.navigateur) await etat.navigateur.fermer().catch(() => {});
      if (plan.garderPile) console.log(`Pile gardée : docker compose -p ${plan.projet} down -v --remove-orphans`);
      else await demonterPile(plan).catch((err) => console.error(`  nettoyage : ${err?.message ?? err}`));
      effacerFichiers();
    })());
  let recus = 0;
  const ecouteurs = Object.entries(SIGNAUX_ARRET).map(([signal, code]) => {
    const ecouteur = () => {
      recus++;
      plan.interrompu = true;
      if (recus === 1) {
        console.error(`Banc e2e : ${signal} reçu, nettoyage de la pile jetable avant de quitter (un second arrêt quitte sans attendre Docker).`);
        nettoyer()
          .catch((err) => console.error(`  nettoyage : ${err?.message ?? err}`))
          .finally(() => sortir(code));
        return;
      }
      console.error(`Banc e2e : ${signal} reçu de nouveau, sortie sans attendre Docker. Pile peut-être restée debout : docker compose -p ${plan.projet} down -v --remove-orphans`);
      try {
        effacerFichiers();
      } catch (err) {
        console.error(`  nettoyage : ${err?.message ?? err}`);
      }
      sortir(code);
    };
    processus.on(signal, ecouteur);
    return [signal, ecouteur];
  });
  const retirer = () => {
    for (const [signal, ecouteur] of ecouteurs) processus.off(signal, ecouteur);
  };
  return { nettoyer, retirer };
}

/** Exécute les scénarios sur la pile jetable. Rend le nombre d'échecs : c'est le code de sortie du banc. */
export async function executer(options) {
  if (verrouTenu()) refuser(messageVerrouTenu());
  const plan = await preparerPlan(options);
  const restes = fichiersEnvRestants();
  if (restes.length > 0) {
    console.error(
      `Banc e2e : fichier(s) d'environnement laissé(s) dans ${DOSSIER_BANC} : ${restes.join(", ")}. Ils portent les jetons d'une ` +
        "pile jetable : si aucune autre exécution du banc ne tourne, démontez la pile de ce projet et effacez-les.",
    );
  }
  if (plan.mode === "reel-hors-ligne") {
    const mesure = mesureMB1();
    if (!mesure.possible) {
      refuser(
        `le mode « --reel-hors-ligne » demande la mesure M-B1 : ${mesure.raison}. ` +
          "Indiquez le dossier des mesures par E2E_MESURES_DIR, ou lancez « --faux ».",
      );
    }
    console.log(`Mesure M-B1 lue dans ${mesure.fichier} : mode réel hors ligne permis.`);
  }

  const scenarios = listerScenarios(plan.motif);
  if (scenarios.length === 0) refuser(plan.motif ? `aucun scénario ne correspond à « ${plan.motif} ».` : "aucun scénario dans e2e/scenarios.");

  const acces = plan.schema === "https" ? "HTTPS épinglé" : "HTTP explicite (--http)";
  console.log(`Banc e2e : mode ${plan.mode}, ${acces}, projet ${plan.projet}, port 127.0.0.1:${plan.portCockpit}, ${scenarios.length} scénario(s).`);
  if (plan.dryRun) {
    console.log("À blanc : les commandes ci-dessous ne sont pas exécutées.");
    for (const sous of [
      ["build", ...plan.aBatir],
      ...(plan.mode === "reel-hors-ligne" ? [["run", "--rm", "--no-deps", "preparation"]] : []),
      ["up", "-d", "--no-build", ...plan.services],
      ["ps", "-a"],
      ...(plan.schema === "https" ? lecturesTlsPubliques() : []),
      ["down", "-v", "--remove-orphans", "-t", "20"],
    ]) {
      await compose(plan, sous);
    }
    return 0;
  }

  const reel = plan.mode !== "faux";
  const etat = { navigateur: null, verrouPris: false };
  const { nettoyer, retirer } = preparerNettoyage(plan, etat);
  let echecs = 0;

  try {
    if (reel) {
      prendreVerrou();
      etat.verrouPris = true;
    }
    const contexte = preparerContexte(plan);
    const secrets = ecrireEnvironnement(plan, contexte.chemin);
    console.log(`Contexte de construction : ${contexte.fichiers} fichiers du dossier de travail, hors du dépôt.`);

    await compose(plan, ["build", ...plan.aBatir]);
    if (plan.mode === "reel-hors-ligne") await compose(plan, ["run", "--rm", "--no-deps", "preparation"]);
    await compose(plan, ["up", "-d", "--no-build", ...plan.services]);
    await attendreDemarrage(plan, "cockpit");

    // HTTPS (défaut) : épinglage lu sur le volume de la pile jetable avant toute requête au cockpit.
    const epinglage = plan.schema === "https" ? await lireEpinglage(plan) : null;
    const urlCockpit = `${plan.schema}://127.0.0.1:${plan.portCockpit}`;
    const sante = await attendreSante(urlCockpit, { epinglage });
    if (sante?.scheme !== plan.schema) refuser(`le cockpit sert « ${sante?.scheme ?? "?"} » au lieu de « ${plan.schema} » : environnement de la pile incohérent.`);
    if (epinglage) {
      await contreEpreuvesEpinglage(urlCockpit, epinglage);
      console.log(`HTTPS épinglé : certificat SHA-256 ${epinglage.sha256} (volume de la pile jetable) ; autre empreinte et magasin par défaut refusés.`);
    }
    const sonde = creerClientCockpit(urlCockpit, secrets.jeton, epinglage);
    await sonde.connecter();
    await attendreOpencode(sonde);
    const faux = plan.mode === "faux" ? relevesDuBanc(`http://127.0.0.1:${plan.portControle}`, secrets.jetonControle) : null;
    const fournisseur = plan.mode === "reel-hors-ligne" ? relevesDuBanc(`http://127.0.0.1:${plan.portFournisseur}`, secrets.jetonControle) : null;
    if (faux) await faux.attendre();
    if (fournisseur) await fournisseur.attendre();
    etat.navigateur = await ouvrirNavigateur({ dossierProfil: path.join(plan.dossier, "profil-navigateur"), spkiEpingle: epinglage?.spki ?? null });

    for (const scenario of scenarios) {
      const debut = Date.now();
      const onglet = await etat.navigateur.nouvelOnglet();
      const prefixe = path.join(plan.captures, scenario.nom.replace(/\.mjs$/, ""));
      try {
        const ctx = await construireContexte({ plan, onglet, urlCockpit, epinglage, faux, fournisseur, secrets, scenario, prefixe });
        const module = await import(pathToFileURL(scenario.chemin).href);
        if (typeof module.run !== "function") refuser(`le scénario « ${scenario.nom} » n'exporte pas run(ctx).`);
        await module.run(ctx);
        console.log(`  ok    ${scenario.nom} (${Date.now() - debut} ms)`);
      } catch (err) {
        echecs++;
        console.error(`  ÉCHEC ${scenario.nom} : ${err?.message ?? err}`);
        if (err?.stack && !(err instanceof ErreurBanc)) console.error(String(err.stack).split("\n").slice(1, 4).join("\n"));
        await onglet.capture(`${prefixe}-echec.png`).catch(() => {});
      } finally {
        await onglet.fermer().catch(() => {});
      }
    }
  } finally {
    try {
      await nettoyer();
    } finally {
      retirer();
    }
  }

  console.log(echecs === 0 ? `Banc e2e : ${scenarios.length} scénario(s), aucun échec. Captures : ${plan.captures}` : `Banc e2e : ${echecs} échec(s). Captures : ${plan.captures}`);
  return echecs;
}

/** Contexte remis à chaque scénario (format figé par la fiche L7a). */
async function construireContexte({ plan, onglet, urlCockpit, epinglage, faux, fournisseur, secrets, scenario, prefixe }) {
  const api = creerClientCockpit(urlCockpit, secrets.jeton, epinglage);
  await api.connecter();
  // La session du navigateur est ouverte ici, par le cookie du client d'API : ni le jeton ni le scénario n'y touchent.
  await connecterNavigateur(onglet, urlCockpit, api.cookie);
  return {
    navigateur: onglet,
    url: urlCockpit,
    faux,
    mode: plan.mode,
    // « https » (défaut) ou « http » (--http) ; en HTTPS, empreintes publiques épinglées (jamais la clé).
    schema: plan.schema,
    epinglage: epinglage ? { sha256: epinglage.sha256, spki: epinglage.spki } : null,
    api,
    // Redémarrage réel d'un service de la pile jetable (« stop » puis « start ») ; jamais la pile de l'utilisateur.
    pile: {
      arreter: (service) => servicePile(plan, "arreter", service),
      demarrer: (service) => servicePile(plan, "demarrer", service),
    },
    nom: scenario.nom,
    dossierCaptures: plan.captures,
    screenshot: (nom, options) => onglet.captureSuite(`${prefixe}-${nom}`, options),
    expectNoConsoleErrors: (sauf) => onglet.exigerAucuneErreurConsole(sauf ?? []),
    opencodeRequests: async () => {
      if (!faux) refuser("les requêtes reçues par opencode ne sont observables qu'en mode « --faux ».");
      return await faux.requetes();
    },
    billedCalls: async () => {
      if (faux) return (await faux.requetes()).filter(estFacturable);
      if (fournisseur) return await fournisseur.requetes();
      return refuser("les appels facturés ne sont pas observables en mode « --reel » : le banc ne voit pas la facturation de GitHub.");
    },
  };
}

/**
 * Requête d'opencode qui déclenche un appel d'IA facturable : les envois d'une conversation, et eux seuls. Les
 * lectures (« GET /command », « GET /session/:id/message ») n'appellent aucune IA — c'est la méthode qui tranche,
 * comme dans les règles du proxy marquées « guarded » (app/server/http.ts).
 */
const CHEMINS_FACTURABLES = /^\/session\/[^/]+\/(prompt_async|command|summarize|shell|message)$/;
const estFacturable = (requete) => String(requete?.method).toUpperCase() === "POST" && CHEMINS_FACTURABLES.test(requete?.pathname ?? "");

// --- Vérifications des gardes (run-e2e.sh --gardes) ---------------------------------------------

/** Dossier d'essai à côté de celui du banc, jamais dedans (la garde des restes le verrait), effacé ensuite. */
async function avecDossierEssai(fn) {
  const essai = fs.mkdtempSync(path.join(path.dirname(DOSSIER_BANC), "opencode-cockpit-e2e-essai-"));
  try {
    return await fn(essai);
  } finally {
    fs.rmSync(essai, { recursive: true, force: true });
  }
}

/** Exécution interrompue, jouée à blanc : fichier d'environnement factice (sans secret), contexte, verrou pris. */
function planInterrompu(essai) {
  const dossier = path.join(essai, "it11-e2e-essai");
  const plan = { projet: "it11-e2e-essai", dossier, fichierEnv: path.join(dossier, "banc.env"), profils: ["faux"], dryRun: true, journal: [], garderPile: false };
  fs.mkdirSync(path.join(dossier, "contexte"), { recursive: true });
  fs.writeFileSync(plan.fichierEnv, "E2E_ESSAI=factice\n");
  fs.writeFileSync(path.join(dossier, "contexte", "Dockerfile"), "FROM scratch\n");
  const verrou = path.join(essai, "verrou");
  prendreVerrou(verrou);
  return { plan, verrou, etat: { navigateur: null, verrouPris: true } };
}

/** Fait taire la console le temps d'un essai (commandes à blanc, annonces d'arrêt), puis la rend. */
async function sansConsole(fn) {
  const { log, error } = console;
  console.log = () => {};
  console.error = () => {};
  try {
    return await fn();
  } finally {
    console.log = log;
    console.error = error;
  }
}

/** Promesse bornée : un essai qui ne rend jamais la main échoue au lieu de laisser le processus finir sans verdict. */
async function avant(promesse, delaiMs, message) {
  let minuteur;
  const delai = new Promise((_, reject) => {
    minuteur = setTimeout(() => reject(new Error(message)), delaiMs);
  });
  try {
    return await Promise.race([promesse, delai]);
  } finally {
    clearTimeout(minuteur);
  }
}

/**
 * Chaque garde d'isolation a ici une vérification qui échoue si on la retire. Elles tournent sans Docker, sans
 * navigateur et sans réseau : c'est le filet que l'intégrateur rejoue à chaque train.
 */
export async function verifierGardes() {
  const echecs = [];
  const verifier = async (nom, fn) => {
    try {
      await fn();
      console.log(`  ok    ${nom}`);
    } catch (err) {
      echecs.push(nom);
      console.error(`  ÉCHEC ${nom} : ${err?.message ?? err}`);
    }
  };
  const refuse = async (nom, fn, extrait) => {
    await verifier(nom, async () => {
      let erreur = null;
      try {
        await fn();
      } catch (err) {
        erreur = err;
      }
      if (!erreur) throw new Error("aucun refus");
      if (!(erreur instanceof ErreurBanc)) throw new Error(`refus inattendu : ${erreur.message}`);
      if (extrait && !erreur.message.includes(extrait)) throw new Error(`message sans « ${extrait} » : ${erreur.message}`);
    });
  };

  await refuse("projet de l'utilisateur refusé", () => verifierProjet("opencode-cockpit"), "pile de l'utilisateur");
  await refuse("projet de l'utilisateur refusé après normalisation", () => verifierProjet("OpenCode-Cockpit-E2E"), "pile de l'utilisateur");
  await refuse("projet ocauto refusé", () => verifierProjet("ocauto-essai"), "pile de l'utilisateur");
  await refuse("projet vidé par la normalisation refusé", () => verifierProjet("ÉÀ"), "vide");
  await refuse("projet mal formé refusé", () => verifierProjet("---"), "refusé");
  await verifier("projet du banc accepté", () => {
    for (const nom of ["cockpit-e2e-2609160812-a1b2", "it11-e2e-2609160812-a1b2"]) {
      if (verifierProjet(nom) !== nom) throw new Error(`nom changé : ${nom}`);
    }
  });

  await refuse("image de l'utilisateur refusée", () => verifierImage("opencode-cockpit/app:local"), "images de l'utilisateur");
  await refuse("image ocauto refusée", () => verifierImage("ocauto-opencode:local"), "images de l'utilisateur");
  await refuse("image sans étiquette refusée", () => verifierImage("cockpit-e2e/app"), "refusée");
  await verifier("image du banc acceptée", () => {
    if (verifierImage("it11-e2e/app:it11") !== "it11-e2e/app:it11") throw new Error("étiquette changée");
  });

  await refuse(".env refusé", () => verifierFichierEnv(path.join(DOSSIER_BANC, ".env")), "est un .env");
  await refuse(".env.local refusé", () => verifierFichierEnv(path.join(DOSSIER_BANC, ".env.local")), "est un .env");
  await refuse("fichier d'environnement dans le dépôt refusé", () => verifierFichierEnv(path.join(RACINE, "banc.env")), "dans le dépôt");
  await refuse("fichier d'environnement existant refusé", () => verifierFichierEnv(path.join(DOSSIER_BANC, "deja.env"), { existe: () => true }), "existe déjà");
  await verifier("fichier d'environnement du banc accepté", () => verifierFichierEnv(path.join(DOSSIER_BANC, "p", "banc.env"), { existe: () => false }));

  await verifier("port 7777 refusé", () => {
    if (portUtilisable(PORT_UTILISATEUR)) throw new Error("7777 accepté");
  });
  await verifier("ports refusés par fetch et par le navigateur écartés", () => {
    for (const port of [6000, 6697, 10080]) if (portUtilisable(port)) throw new Error(`port ${port} accepté`);
    if (!portUtilisable(17801)) throw new Error("17801 refusé");
  });
  await verifier("choix de port : ports refusés sautés", async () => {
    // La plage commence juste avant cinq ports que fetch et le navigateur refusent : sans la garde, ils seraient pris.
    const vus = [];
    const ports = await choisirPorts(3, {
      debut: 6664,
      fin: 6680,
      libre: (p) => {
        vus.push(p);
        return true;
      },
    });
    if (ports.length !== 3) throw new Error("mauvais nombre de ports");
    for (const port of ports) if (PORTS_REFUSES.has(port)) throw new Error(`port refusé choisi : ${port}`);
    for (const refuse of [6665, 6666, 6667, 6668, 6669, 6679]) if (vus.includes(refuse)) throw new Error(`port ${refuse} essayé`);
    if (ports[0] !== 6664) throw new Error(`premier port inattendu : ${ports[0]}`);
  });
  await refuse("aucun port libre : refus explicite", () => choisirPorts(1, { debut: 17800, fin: 17801, libre: () => false }), "aucun port libre");

  const verrouEssai = path.join(DOSSIER_BANC, `verrou-essai-${process.pid}`);
  await verifier("verrou tenu deux fois : refus", async () => {
    rendreVerrou(verrouEssai);
    prendreVerrou(verrouEssai);
    let erreur = null;
    try {
      prendreVerrou(verrouEssai);
    } catch (err) {
      erreur = err;
    } finally {
      rendreVerrou(verrouEssai);
    }
    if (!(erreur instanceof ErreurBanc)) throw new Error("second verrou accepté");
    if (!String(erreur.message).includes("verrou")) throw new Error(`message inattendu : ${erreur.message}`);
    if (verrouTenu(verrouEssai)) throw new Error("verrou non rendu");
  });

  await verifier("commande Compose : projet, surcharge et fichier d'environnement", () => {
    const plan = { projet: "cockpit-e2e-essai", fichierEnv: "/tmp/banc.env", profils: ["faux"] };
    const texte = texteCommande(argumentsCompose(plan, ["up", "-d"]));
    for (const attendu of ["-p cockpit-e2e-essai", "-f docker-compose.yml", "-f e2e/docker-compose.e2e.yml", "--env-file /tmp/banc.env", "--profile faux"]) {
      if (!texte.includes(attendu)) throw new Error(`commande sans « ${attendu} » : ${texte}`);
    }
  });
  await refuse(
    "down -v refusé sur la pile de l'utilisateur",
    () => demonterPile({ projet: "opencode-cockpit", fichierEnv: "/tmp/banc.env", profils: [], dryRun: true, journal: [] }),
    "pile de l'utilisateur",
  );

  // Redémarrage réel d'un service (ctx.pile) : même garde de projet que toute commande Compose, services et actions bornés.
  const planService = () => ({
    projet: "cockpit-e2e-essai",
    fichierEnv: "/tmp/banc.env",
    profils: ["faux"],
    services: ["faux-opencode", "cockpit"],
    dryRun: true,
    journal: [],
  });
  await refuse("service de la pile : pile de l'utilisateur refusée", () => sansConsole(() => servicePile({ ...planService(), projet: "opencode-cockpit" }, "arreter", "cockpit")), "pile de l'utilisateur");
  await refuse("service de la pile : service inconnu refusé", () => sansConsole(() => servicePile(planService(), "arreter", "opencode")), "service inconnu");
  await refuse("service de la pile : action autre que stop et start refusée", () => sansConsole(() => servicePile(planService(), "rm", "cockpit")), "action inconnue");
  await verifier("service de la pile : arrêt puis relance, dans le projet du banc", async () => {
    const plan = planService();
    await sansConsole(async () => {
      await servicePile(plan, "arreter", "cockpit");
      await servicePile(plan, "demarrer", "cockpit");
    });
    const [arret, relance, ...reste] = plan.journal;
    if (reste.length > 0 || !arret || !relance) throw new Error(`commandes inattendues : ${plan.journal.join(" | ")}`);
    if (!arret.startsWith("docker compose -p cockpit-e2e-essai ") || !arret.endsWith(" stop -t 5 cockpit")) throw new Error(`arrêt : ${arret}`);
    if (!relance.startsWith("docker compose -p cockpit-e2e-essai ") || !relance.endsWith(" start cockpit")) throw new Error(`relance : ${relance}`);
  });

  await refuse("mode réel hors ligne sans la mesure M-B1", () => {
    const mesure = mesureMB1([path.join(DOSSIER_BANC, "mesures-absentes")]);
    if (!mesure.possible) refuser(`le mode « --reel-hors-ligne » demande la mesure M-B1 : ${mesure.raison}.`);
  }, "M-B1");

  await verifier("motif de --scenarios", () => {
    if (!correspond("it1-api-arret.mjs", "it1-*")) throw new Error("glob non reconnu");
    if (correspond("it2-plafond.mjs", "it1-*")) throw new Error("glob trop large");
    if (!correspond("000-smoke.mjs", "smoke")) throw new Error("sous-chaîne non reconnue");
  });

  await verifier("verrou tenu : le message donne le processus et la marche à suivre", () => {
    rendreVerrou(verrouEssai);
    prendreVerrou(verrouEssai);
    try {
      let refus = null;
      try {
        prendreVerrou(verrouEssai);
      } catch (err) {
        refus = err;
      }
      for (const attendu of [verrouEssai, `processus ${process.pid}, qui tourne encore`, "effacez ce dossier"]) {
        if (!String(refus?.message).includes(attendu)) throw new Error(`message sans « ${attendu} » : ${refus?.message}`);
      }
      // Processus terminé : son numéro est libre, le message le dit.
      const termine = spawnSync(process.execPath, ["-e", ""]).pid;
      fs.writeFileSync(path.join(verrouEssai, "pid.txt"), `${termine}\n`);
      if (!messageVerrouTenu(verrouEssai).includes(`processus ${termine}, qui ne tourne plus`)) throw new Error(`message : ${messageVerrouTenu(verrouEssai)}`);
    } finally {
      rendreVerrou(verrouEssai);
    }
  });

  await verifier("fichier d'environnement laissé dans le dossier d'un projet : vu, chemin donné", () =>
    avecDossierEssai((essai) => {
      fs.mkdirSync(path.join(essai, "it11-e2e-essai", "captures"), { recursive: true });
      fs.writeFileSync(path.join(essai, "it11-e2e-essai", "banc.env"), "E2E_ESSAI=factice\n");
      fs.writeFileSync(path.join(essai, "it11-e2e-essai", "notes.txt"), "rien\n");
      fs.writeFileSync(path.join(essai, "reste.env"), "E2E_ESSAI=factice\n");
      const restes = fichiersEnvRestants(essai);
      const attendus = [path.join("it11-e2e-essai", "banc.env"), "reste.env"];
      if (JSON.stringify(restes) !== JSON.stringify(attendus)) throw new Error(`restes vus : ${restes.join(", ") || "aucun"}`);
    }),
  );

  await verifier("interruption (Ctrl+C) : pile démontée, fichier d'environnement, contexte et verrou effacés, sortie 130, plus aucun « up »", () =>
    avecDossierEssai(async (essai) => {
      const { plan, verrou, etat } = planInterrompu(essai);
      let ferme = false;
      etat.navigateur = {
        fermer: async () => {
          ferme = true;
        },
      };
      const processus = new EventEmitter();
      const codes = [];
      await sansConsole(() =>
        avant(
          new Promise((resolve) => {
            preparerNettoyage(plan, etat, { processus, verrou, sortir: (code) => resolve(codes.push(code)) });
            for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) if (processus.listenerCount(signal) !== 1) throw new Error(`${signal} non écouté`);
            processus.emit("SIGINT");
          }),
          5_000,
          "aucune sortie après Ctrl+C",
        ),
      );
      if (codes[0] !== 130) throw new Error(`code de sortie : ${codes[0]}`);
      if (fs.existsSync(plan.fichierEnv)) throw new Error("fichier d'environnement laissé");
      if (fs.existsSync(path.join(plan.dossier, "contexte"))) throw new Error("contexte laissé");
      if (verrouTenu(verrou)) throw new Error("verrou laissé");
      if (!ferme) throw new Error("navigateur laissé ouvert");
      if (!plan.journal.some((ligne) => ligne.includes(" down -v "))) throw new Error("pile non démontée");
      // Le déroulé continue pendant le nettoyage : un « up » qu'il lancerait ensuite relèverait la pile démontée.
      let refus = null;
      await sansConsole(() => compose(plan, ["up", "-d", "--no-build", "cockpit"])).catch((err) => {
        refus = err;
      });
      if (!(refus instanceof ErreurBanc) || !refus.message.includes("exécution interrompue")) throw new Error(`« up » après l'arrêt : ${refus?.message ?? "lancé"}`);
      if (plan.journal.some((ligne) => ligne.includes(" up "))) throw new Error("« up » journalisé après l'arrêt");
      await sansConsole(() => compose(plan, ["down", "-v", "--remove-orphans", "-t", "20"]));
    }),
  );

  await verifier("second arrêt : fichier d'environnement, contexte et verrou effacés sans attendre Docker", () =>
    avecDossierEssai(async (essai) => {
      const { plan, verrou, etat } = planInterrompu(essai);
      // Navigateur (ou Docker) qui ne rend jamais la main : le premier nettoyage reste bloqué.
      etat.navigateur = { fermer: () => new Promise(() => {}) };
      const processus = new EventEmitter();
      const codes = [];
      await sansConsole(() => {
        preparerNettoyage(plan, etat, { processus, verrou, sortir: (code) => codes.push(code) });
        processus.emit("SIGINT");
        processus.emit("SIGINT");
      });
      if (codes[0] !== 130) throw new Error(`code de sortie : ${codes[0]}`);
      if (fs.existsSync(plan.fichierEnv)) throw new Error("fichier d'environnement laissé");
      if (fs.existsSync(path.join(plan.dossier, "contexte"))) throw new Error("contexte laissé");
      if (verrouTenu(verrou)) throw new Error("verrou laissé");
    }),
  );

  await verifier("fin normale : écouteurs de signaux retirés, nettoyage fait une seule fois", () =>
    avecDossierEssai(async (essai) => {
      const { plan, verrou, etat } = planInterrompu(essai);
      let fermetures = 0;
      etat.navigateur = {
        fermer: async () => {
          fermetures++;
        },
      };
      const processus = new EventEmitter();
      const { nettoyer, retirer } = preparerNettoyage(plan, etat, { processus, verrou, sortir: () => {} });
      await sansConsole(() => Promise.all([nettoyer(), nettoyer()]));
      retirer();
      for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) if (processus.listenerCount(signal) !== 0) throw new Error(`${signal} encore écouté`);
      if (fermetures !== 1) throw new Error(`${fermetures} nettoyages`);
      if (fs.existsSync(plan.fichierEnv) || verrouTenu(verrou)) throw new Error("fichier d'environnement ou verrou laissé");
    }),
  );

  await verifierGardesHttps(verifier, refuse);

  await verifier("aucun secret dans un fichier d'environnement du banc laissé derrière", () => {
    const restes = fichiersEnvRestants();
    if (restes.length > 0) {
      throw new Error(
        `fichiers d'environnement restants dans ${DOSSIER_BANC} : ${restes.join(", ")} (une exécution du banc en cours a le sien ; ` +
          "sinon, démontez la pile de ce projet et effacez-les)",
      );
    }
  });

  console.log(echecs.length === 0 ? "Gardes du banc : aucune n'est tombée." : `Gardes du banc : ${echecs.length} vérification(s) en échec.`);
  return echecs.length;
}

/**
 * Certificat PUBLIC d'essai des gardes (ECDSA P-256, SAN IP:127.0.0.1 et DNS:localhost, valable jusqu'au 2046-09-14).
 * Sa clé a été jetée à sa création : il ne sert qu'aux contre-vérifications, jamais à servir du TLS.
 */
const CERTIFICAT_ESSAI = `-----BEGIN CERTIFICATE-----
MIIBtjCCAVygAwIBAgIUdgvardXC3+cNFE2kIhFkN3RarekwCgYIKoZIzj0EAwIw
GTEXMBUGA1UEAwwOYmFuYyBlMmUgZXNzYWkwHhcNMjYwOTE5MTAwNDExWhcNNDYw
OTE0MTAwNDExWjAZMRcwFQYDVQQDDA5iYW5jIGUyZSBlc3NhaTBZMBMGByqGSM49
AgEGCCqGSM49AwEHA0IABGCxGKq2LArJWi5JFVShaQ459nXQHbXhuYhYhpQpjCzy
VAkxl+Mi1sYaS+KZEOPs80V94i5UbGryIjihWT3PAQCjgYEwfzAdBgNVHQ4EFgQU
6YzHQisLPKYm7tUU07Z9JkHPF60wHwYDVR0jBBgwFoAU6YzHQisLPKYm7tUU07Z9
JkHPF60wGgYDVR0RBBMwEYcEfwAAAYIJbG9jYWxob3N0MAwGA1UdEwEB/wQCMAAw
EwYDVR0lBAwwCgYIKwYBBQUHAwEwCgYIKoZIzj0EAwIDSAAwRQIhANyZe2urmftP
AZ0PT5gXsstcVgT60pbmbetqnwAeo5MHAiB36mwqtz5jo087O78MzWX4nJFHsFLA
foTRgWlgnjip2Q==
-----END CERTIFICATE-----
`;

/** cockpit-tls.json tel que tls.ts l'écrit pour un certificat, avec des champs remplaçables pour les refus. */
function jsonEssai(certificat, remplacements = {}) {
  const x509 = new crypto.X509Certificate(certificat);
  const spki = crypto.createHash("sha256").update(x509.publicKey.export({ type: "spki", format: "der" })).digest("base64");
  return JSON.stringify({ schema: 1, source: "genere", sha256: x509.fingerprint256, sha256Hex: x509.fingerprint256.replaceAll(":", "").toLowerCase(), spkiSha256Base64: spki, ...remplacements });
}

/** Gardes du HTTPS épinglé (R105b) : mode par défaut, environnement de la pile, épinglage de Node et du navigateur. */
async function verifierGardesHttps(verifier, refuse) {
  await verifier("HTTPS épinglé par défaut, « --http » pour le mode HTTP explicite de la 1.0.5", () => {
    if (analyserArguments([]).schema !== "https") throw new Error("le défaut n'est pas HTTPS");
    if (analyserArguments(["--faux", "--scenarios", "smoke"]).schema !== "https") throw new Error("HTTPS perdu avec d'autres options");
    if (analyserArguments(["--http"]).schema !== "http") throw new Error("--http sans effet");
  });
  await refuse("schéma inconnu refusé", () => preparerPlan({ mode: "faux", schema: "ftp", prefixe: "it11-e2e", tag: "essai" }), "schéma inconnu");

  const planEssai = (schema) => ({ schema, mode: "faux", id: "essai", projet: "it11-e2e-essai", imageApp: "it11-e2e/app:essai", imageOpencode: "it11-e2e/opencode:essai", portCockpit: 17801, portControle: 17802, portFournisseur: 17803, dossier: path.join(DOSSIER_BANC, "it11-e2e-essai") });
  const valeursEssai = { jeton: "essai", motDePasse: "essai", jetonControle: "essai", contexte: "contexte", maintenant: new Date("2026-09-19T10:00:00.000Z") };
  await verifier("fichier d'environnement : HTTPS sans date de confirmation, « --http » daté au format strict", () => {
    const enHttps = lignesEnvironnement(planEssai("https"), valeursEssai);
    if (!enHttps.includes("COCKPIT_LOCAL_SCHEME=https") || !enHttps.includes("COCKPIT_LOCAL_HTTP_CONFIRMED=")) throw new Error(`HTTPS : ${enHttps.filter((l) => l.startsWith("COCKPIT_LOCAL")).join(", ")}`);
    const enHttp = lignesEnvironnement(planEssai("http"), valeursEssai);
    if (!enHttp.includes("COCKPIT_LOCAL_SCHEME=http") || !enHttp.includes("COCKPIT_LOCAL_HTTP_CONFIRMED=2026-09-19T10:00:00Z")) throw new Error(`HTTP : ${enHttp.filter((l) => l.startsWith("COCKPIT_LOCAL")).join(", ")}`);
  });
  await verifier("variables du fichier du banc retirées de l'environnement de docker (le shell ne l'emporte jamais)", () => {
    const cles = lignesEnvironnement(planEssai("https"), valeursEssai).map((ligne) => ligne.slice(0, ligne.indexOf("=")));
    const shell = Object.fromEntries([...cles, "PATH"].map((cle) => [cle, "valeur-du-shell"]));
    const env = environnementDocker(shell);
    const restees = cles.filter((cle) => cle in env);
    if (restees.length > 0) throw new Error(`restées : ${restees.join(", ")}`);
    if (env.PATH !== "valeur-du-shell" || env.MSYS_NO_PATHCONV !== "1") throw new Error("PATH ou MSYS_NO_PATHCONV perdus");
  });
  await verifier("lectures du volume TLS limitées aux fichiers publics", () => {
    for (const sous of lecturesTlsPubliques()) {
      const chemin = sous.at(-1);
      if (sous[0] !== "exec" || !chemin.startsWith("/tls/public/") || /private|\.key$/i.test(chemin)) throw new Error(`lecture refusée : ${sous.join(" ")}`);
    }
  });

  await refuse("HTTPS sans épinglage refusé", () => {
    try {
      creerTransport("https://127.0.0.1:17801");
    } catch (err) {
      refuser(err.message);
    }
  }, "jamais la vérification TLS");
  await refuse("HTTPS avec un épinglage incomplet refusé", () => {
    try {
      creerTransport("https://127.0.0.1:17801", { certificat: CERTIFICAT_ESSAI, sha256: "AB", spki: "" });
    } catch (err) {
      refuser(err.message);
    }
  }, "épinglage complet");
  await refuse("chemin hors du cockpit refusé", async () => {
    try {
      await creerTransport("http://127.0.0.1:17801")("//autre.exemple/x");
    } catch (err) {
      refuser(err.message);
    }
  }, "chemin du cockpit refusé");

  const x509 = new crypto.X509Certificate(CERTIFICAT_ESSAI);
  const maintenant = new Date("2026-09-19T12:00:00.000Z");
  await verifier("certificat public cohérent : épinglage rendu (empreinte, clé publique)", () => {
    const epinglage = verifierCertificatPublic(CERTIFICAT_ESSAI, jsonEssai(CERTIFICAT_ESSAI), maintenant);
    if (epinglage.sha256 !== x509.fingerprint256) throw new Error("empreinte changée");
    if (epinglage.spki !== JSON.parse(jsonEssai(CERTIFICAT_ESSAI)).spkiSha256Base64) throw new Error("clé publique changée");
    if (/PRIVATE/.test(epinglage.certificat)) throw new Error("clé dans l'épinglage");
  });
  const refusCertificat = async (nom, pem, json, extrait, instant = maintenant) =>
    await refuse(nom, () => {
      try {
        verifierCertificatPublic(pem, json, instant);
      } catch (err) {
        refuser(err.message);
      }
    }, extrait);
  await refusCertificat("certificat public : empreinte du JSON différente refusée", CERTIFICAT_ESSAI, jsonEssai(CERTIFICAT_ESSAI, { sha256: `00${x509.fingerprint256.slice(2)}` }), "empreinte");
  await refusCertificat("certificat public : clé publique du JSON différente refusée", CERTIFICAT_ESSAI, jsonEssai(CERTIFICAT_ESSAI, { spkiSha256Base64: `A${"B".repeat(42)}=` }), "clé publique");
  // La garde refuse toute mention « PRIVATE KEY » (en-tête PEM compris) : la mention seule suffit à l'essai, sans
  // écrire un en-tête de clé dans le dépôt.
  await refusCertificat("certificat public : clé privée dans les fichiers publics refusée", CERTIFICAT_ESSAI, jsonEssai(CERTIFICAT_ESSAI, { note: "PRIVATE KEY" }), "clé privée");
  await refusCertificat("certificat public : mention de clé privée dans le certificat refusée", `${CERTIFICAT_ESSAI}PRIVATE KEY\n`, jsonEssai(CERTIFICAT_ESSAI), "clé privée");
  await refusCertificat("certificat public : deux certificats refusés", `${CERTIFICAT_ESSAI}${CERTIFICAT_ESSAI}`, jsonEssai(CERTIFICAT_ESSAI), "exactement un");
  await refusCertificat("certificat public : certificat expiré refusé", CERTIFICAT_ESSAI, jsonEssai(CERTIFICAT_ESSAI), "expiré", new Date("2047-01-01T00:00:00.000Z"));

  await verifier("poignée de main : empreinte du volume acceptée, autre empreinte et autre adresse refusées", () => {
    const epinglage = verifierCertificatPublic(CERTIFICAT_ESSAI, jsonEssai(CERTIFICAT_ESSAI), maintenant);
    const pair = x509.toLegacyObject();
    if (controlerPair("127.0.0.1", pair, epinglage) !== undefined) throw new Error("certificat épinglé refusé");
    const autre = controlerPair("127.0.0.1", pair, { ...epinglage, sha256: `00${epinglage.sha256.slice(2)}` });
    if (autre?.code !== CODE_EMPREINTE) throw new Error(`autre empreinte : ${autre?.message ?? "acceptée"}`);
    const autreSpki = controlerPair("127.0.0.1", pair, { ...epinglage, spki: `A${"B".repeat(42)}=` });
    if (autreSpki?.code !== CODE_EMPREINTE) throw new Error(`autre clé publique : ${autreSpki?.message ?? "acceptée"}`);
    if (controlerPair("10.0.0.1", pair, epinglage) === undefined) throw new Error("adresse non couverte acceptée");
  });

  await verifier("navigateur : seule la clé publique épinglée passe, jamais --ignore-certificate-errors", () => {
    const spki = JSON.parse(jsonEssai(CERTIFICAT_ESSAI)).spkiSha256Base64;
    const avec = argumentsNavigateur("profil", { spkiEpingle: spki });
    const ignores = avec.filter((arg) => arg.startsWith("--ignore-certificate-errors"));
    if (ignores.length !== 1 || ignores[0] !== `--ignore-certificate-errors-spki-list=${spki}`) throw new Error(`arguments : ${ignores.join(" ") || "aucun"}`);
    if (!avec.includes("--user-data-dir=profil")) throw new Error("--user-data-dir absent (Chromium ignorerait la liste)");
    if (argumentsNavigateur("profil").some((arg) => arg.startsWith("--ignore-certificate-errors"))) throw new Error("exception de certificat sans épinglage");
    let refus = null;
    try {
      argumentsNavigateur("profil", { spkiEpingle: "*" });
    } catch (err) {
      refus = err;
    }
    if (!refus) throw new Error("condensé mal formé accepté");
  });
}

// --- Arguments --------------------------------------------------------------------------------

export function analyserArguments(argv) {
  const options = { mode: "faux", schema: "https", prefixe: "cockpit-e2e", tag: null, motif: null, dryRun: false, gardes: false, garderPile: false, fichierEnv: null };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const suivant = () => {
      const valeur = argv[++i];
      if (valeur === undefined) refuser(`l'option « ${arg} » attend une valeur.`);
      return valeur;
    };
    if (arg === "--faux") options.mode = "faux";
    else if (arg === "--reel-hors-ligne") options.mode = "reel-hors-ligne";
    else if (arg === "--reel") options.mode = "reel";
    // Mode HTTP explicite de la 1.0.5 ; sans l'option, HTTPS épinglé.
    else if (arg === "--http") options.schema = "http";
    else if (arg === "--scenarios") options.motif = suivant();
    else if (arg === "--project-prefix") options.prefixe = suivant();
    else if (arg === "--image-tag") options.tag = suivant();
    // « --fichier-env » et non « --env-file » : Node 24 intercepte « --env-file », même placé après le nom du script.
    else if (arg === "--fichier-env") options.fichierEnv = suivant();
    else if (arg === "--dry-run") options.dryRun = true;
    else if (arg === "--gardes") options.gardes = true;
    else if (arg === "--garder-pile") options.garderPile = true;
    else refuser(`option inconnue : « ${arg} ».`);
  }
  if (!options.tag) options.tag = "local";
  return options;
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  try {
    const options = analyserArguments(process.argv.slice(2));
    const code = options.gardes ? await verifierGardes() : await executer(options);
    process.exit(Math.min(code, 125));
  } catch (err) {
    console.error(err instanceof ErreurBanc ? `Banc e2e : ${err.message}` : err);
    process.exit(1);
  }
}
