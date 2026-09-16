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
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { FETCH_BLOCKED_PORTS } from "../../app/server/fetch-ports.ts";
import { ouvrirNavigateur } from "./cdp.mjs";
import { attendreOpencode, attendreSante, connecterNavigateur, creerClientCockpit, relevesDuBanc } from "./cockpit.mjs";

/** Racine du dépôt : e2e/lib → e2e → dépôt. */
export const RACINE = path.resolve(import.meta.dirname, "..", "..");

export const MODES = ["faux", "reel-hors-ligne", "reel"];

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
    if (err?.code === "EEXIST") refuser(`une exécution réelle du banc tient déjà le verrou « ${chemin} ».`);
    throw err;
  }
  fs.writeFileSync(path.join(chemin, "pid.txt"), `${process.pid}\n`, { encoding: "utf8", mode: 0o600 });
  return chemin;
}

export function rendreVerrou(chemin = VERROU) {
  fs.rmSync(chemin, { recursive: true, force: true });
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

function executerDocker(args, { silencieux = false } = {}) {
  return new Promise((resolve, reject) => {
    const enfant = spawn("docker", args, {
      cwd: RACINE,
      // MSYS_NO_PATHCONV : sous Git Bash, MSYS convertirait « /workspace » en chemin Windows dans les arguments.
      env: { ...process.env, MSYS_NO_PATHCONV: "1" },
      stdio: silencieux ? ["ignore", "pipe", "pipe"] : ["ignore", "inherit", "inherit"],
    });
    let sortie = "";
    if (silencieux) {
      enfant.stdout.setEncoding("utf8");
      enfant.stderr.setEncoding("utf8");
      enfant.stdout.on("data", (bloc) => (sortie += bloc));
      enfant.stderr.on("data", (bloc) => (sortie += bloc));
    }
    enfant.on("error", reject);
    enfant.on("close", (code) => resolve({ code: code ?? 1, sortie }));
  });
}

/** Lance une commande Compose du banc. Le nom de projet est revérifié juste avant chaque appel. */
export async function compose(plan, sousCommande, options = {}) {
  verifierProjet(plan.projet);
  const args = argumentsCompose(plan, sousCommande);
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
  const id = options.id ?? identifiantExecution();
  const projet = verifierProjet(`${options.prefixe}-${id}`);
  const imageApp = verifierImage(`${options.prefixe}/app:${options.tag}`);
  const imageOpencode = verifierImage(`${options.prefixe}/opencode:${options.tag}`);
  const dossier = path.join(DOSSIER_BANC, projet);
  const fichierEnv = verifierFichierEnv(options.fichierEnv ?? path.join(dossier, "banc.env"));
  const [portCockpit, portControle, portFournisseur] = await choisirPorts(3);
  return {
    mode,
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

/** Écrit le fichier d'environnement de la pile jetable. Aucune de ses valeurs n'est affichée ni journalisée. */
export function ecrireEnvironnement(plan, contexte = path.join(plan.dossier, "contexte")) {
  const jeton = secret(32);
  const motDePasse = secret(24);
  const jetonControle = secret(24);
  const lignes = [
    `COCKPIT_APP_IMAGE=${plan.imageApp}`,
    `COCKPIT_OPENCODE_IMAGE=${plan.imageOpencode}`,
    `COCKPIT_PORT=${plan.portCockpit}`,
    `COCKPIT_TOKEN=${jeton}`,
    `COCKPIT_VERSION=e2e-${plan.id}`,
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

/** Exécute les scénarios sur la pile jetable. Rend le nombre d'échecs : c'est le code de sortie du banc. */
export async function executer(options) {
  if (verrouTenu()) refuser(`une exécution réelle du banc tient déjà le verrou « ${VERROU} ».`);
  const plan = await preparerPlan(options);
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

  console.log(`Banc e2e : mode ${plan.mode}, projet ${plan.projet}, port 127.0.0.1:${plan.portCockpit}, ${scenarios.length} scénario(s).`);
  if (plan.dryRun) {
    console.log("À blanc : les commandes ci-dessous ne sont pas exécutées.");
    for (const sous of [
      ["build", ...plan.aBatir],
      ...(plan.mode === "reel-hors-ligne" ? [["run", "--rm", "--no-deps", "preparation"]] : []),
      ["up", "-d", "--no-build", ...plan.services],
      ["ps", "-a"],
      ["down", "-v", "--remove-orphans", "-t", "20"],
    ]) {
      await compose(plan, sous);
    }
    return 0;
  }

  const reel = plan.mode !== "faux";
  let verrouPris = false;
  let navigateur = null;
  let echecs = 0;

  try {
    if (reel) {
      prendreVerrou();
      verrouPris = true;
    }
    const contexte = preparerContexte(plan);
    const secrets = ecrireEnvironnement(plan, contexte.chemin);
    console.log(`Contexte de construction : ${contexte.fichiers} fichiers du dossier de travail, hors du dépôt.`);

    await compose(plan, ["build", ...plan.aBatir]);
    if (plan.mode === "reel-hors-ligne") await compose(plan, ["run", "--rm", "--no-deps", "preparation"]);
    await compose(plan, ["up", "-d", "--no-build", ...plan.services]);
    await attendreDemarrage(plan, "cockpit");

    const urlCockpit = `http://127.0.0.1:${plan.portCockpit}`;
    await attendreSante(urlCockpit);
    const sonde = creerClientCockpit(urlCockpit, secrets.jeton);
    await sonde.connecter();
    await attendreOpencode(sonde);
    const faux = plan.mode === "faux" ? relevesDuBanc(`http://127.0.0.1:${plan.portControle}`, secrets.jetonControle) : null;
    const fournisseur = plan.mode === "reel-hors-ligne" ? relevesDuBanc(`http://127.0.0.1:${plan.portFournisseur}`, secrets.jetonControle) : null;
    if (faux) await faux.attendre();
    if (fournisseur) await fournisseur.attendre();
    navigateur = await ouvrirNavigateur({ dossierProfil: path.join(plan.dossier, "profil-navigateur") });

    for (const scenario of scenarios) {
      const debut = Date.now();
      const onglet = await navigateur.nouvelOnglet();
      const prefixe = path.join(plan.captures, scenario.nom.replace(/\.mjs$/, ""));
      try {
        const ctx = await construireContexte({ plan, onglet, urlCockpit, faux, fournisseur, secrets, scenario, prefixe });
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
    if (navigateur) await navigateur.fermer().catch(() => {});
    if (plan.garderPile) console.log(`Pile gardée : docker compose -p ${plan.projet} down -v --remove-orphans`);
    else await demonterPile(plan).catch((err) => console.error(`  nettoyage : ${err?.message ?? err}`));
    fs.rmSync(plan.fichierEnv, { force: true });
    fs.rmSync(path.join(plan.dossier, "contexte"), { recursive: true, force: true });
    if (verrouPris) rendreVerrou();
  }

  console.log(echecs === 0 ? `Banc e2e : ${scenarios.length} scénario(s), aucun échec. Captures : ${plan.captures}` : `Banc e2e : ${echecs} échec(s). Captures : ${plan.captures}`);
  return echecs;
}

/** Contexte remis à chaque scénario (format figé par la fiche L7a). */
async function construireContexte({ plan, onglet, urlCockpit, faux, fournisseur, secrets, scenario, prefixe }) {
  const api = creerClientCockpit(urlCockpit, secrets.jeton);
  await api.connecter();
  // La session du navigateur est ouverte ici, par le cookie du client d'API : ni le jeton ni le scénario n'y touchent.
  await connecterNavigateur(onglet, urlCockpit, api.cookie);
  return {
    navigateur: onglet,
    url: urlCockpit,
    faux,
    mode: plan.mode,
    api,
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

  await refuse("mode réel hors ligne sans la mesure M-B1", () => {
    const mesure = mesureMB1([path.join(DOSSIER_BANC, "mesures-absentes")]);
    if (!mesure.possible) refuser(`le mode « --reel-hors-ligne » demande la mesure M-B1 : ${mesure.raison}.`);
  }, "M-B1");

  await verifier("motif de --scenarios", () => {
    if (!correspond("it1-api-arret.mjs", "it1-*")) throw new Error("glob non reconnu");
    if (correspond("it2-plafond.mjs", "it1-*")) throw new Error("glob trop large");
    if (!correspond("000-smoke.mjs", "smoke")) throw new Error("sous-chaîne non reconnue");
  });

  await verifier("aucun secret dans un fichier d'environnement du banc laissé derrière", () => {
    const restes = fs.existsSync(DOSSIER_BANC) ? fs.readdirSync(DOSSIER_BANC).filter((n) => n.endsWith(".env")) : [];
    if (restes.length > 0) throw new Error(`fichiers d'environnement restants : ${restes.join(", ")}`);
  });

  console.log(echecs.length === 0 ? "Gardes du banc : aucune n'est tombée." : `Gardes du banc : ${echecs.length} vérification(s) en échec.`);
  return echecs.length;
}

// --- Arguments --------------------------------------------------------------------------------

export function analyserArguments(argv) {
  const options = { mode: "faux", prefixe: "cockpit-e2e", tag: null, motif: null, dryRun: false, gardes: false, garderPile: false, fichierEnv: null };
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
