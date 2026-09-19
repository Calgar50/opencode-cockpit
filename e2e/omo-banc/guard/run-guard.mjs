// Pilote du banc du plugin de garde (L24, T-L24-a et T-L24-b), lancé dans le conteneur « banc » de docker-compose.guard.yml.
// Aucune dépendance (modules « node: » seulement, P8). Rien n'est appelé au dehors : le réseau du banc est interne.
//
// 1. lance le faux fournisseur de la salle (faux-copilot.mjs, L21a) en mode --http : API sur 0.0.0.0:8080 (joignable par
//    opencode sous le nom « banc »), pilotage sur la boucle locale seulement (127.0.0.1:8081, aucun jeton nécessaire) ;
// 2. prépare le projet ouvert dans /workspace/projet (fichiers factices, liens vers un dossier voisin hors du projet) ;
// 3. attend opencode, puis joue chaque scénario : état de garde posé dans /control (comme le ferait le cockpit), réponses
//    scriptées (un appel d'outil, puis du texte), une demande synchrone, et relevé des parties « tool » de la réponse ;
// 4. écrit UNE ligne « RAPPORT {…} » sur la sortie standard ; les assertions sont faites par omo-guard.test.ts.
//
// Aucun secret : les fichiers « clés » et « .env » portent des marques FACTICE ; le mot de passe d'opencode (tiré par le test)
// n'est jamais écrit, et toute sortie en est masquée. Code de sortie non nul seulement si le banc lui-même n'a pas pu tourner.
import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { createInterface } from "node:readline";

const MOT_DE_PASSE = process.env.OPENCODE_SERVER_PASSWORD ?? "";
const OPENCODE = new URL(process.env.OPENCODE_URL ?? "http://opencode:4096");
const AUTORISATION = `Basic ${Buffer.from(`opencode:${MOT_DE_PASSE}`).toString("base64")}`;
const FAUX = path.join(import.meta.dirname, "faux-copilot.mjs");
const PORT_API = 8080;
const PORT_PILOTE = 8081;
const IA = "faux-m1";
/** Projet ouvert, vu par opencode (volume « travail » sur /workspace). */
const PROJET = "/workspace/projet";
/**
 * Le même volume vu par le pilote, sur /data : un dossier que l'image du pilote donne à `node`. Monté sur /workspace (à root dans
 * cette image), le volume passerait à root et le pilote ne pourrait plus y écrire (MO-11 : sous Compose, le dernier conteneur créé
 * fixe le propriétaire). Les liens posés sont relatifs : ils mènent au même endroit des deux côtés.
 */
const PROJET_PILOTE = "/data/projet";
const DEHORS_PILOTE = "/data/dehors";
const ETAT = "/control/guard-state.json";
const ETAT_CIBLE = "/control/etat-cible.json";

/** Marques des fichiers factices : si l'une d'elles apparaît dans une conversation, le fichier a été lu. */
const MARQUES = Object.freeze({
  ordinaire: "CONTENU-ORDINAIRE-L24",
  cle: "FACTICE-CLE-L24",
  env: "FACTICE-ENV-L24",
  exemple: "CONTENU-EXEMPLE-L24",
  cleDehors: "FACTICE-CLE-DEHORS-L24",
  dehors: "CONTENU-DEHORS-L24",
});

const masquer = (texte) => (MOT_DE_PASSE.length >= 8 ? String(texte).split(MOT_DE_PASSE).join("****") : String(texte));
const journal = (texte) => process.stderr.write(`${new Date().toISOString()} banc-l24 ${masquer(texte).slice(0, 500)}\n`);
const extrait = (texte, max) => (typeof texte === "string" ? masquer(texte).slice(0, max) : null);

// --- HTTP (node:http : ports fixes, délais bornés) --------------------------------------------------------------------------------

function requete(url, { methode = "GET", corps, entetes = {}, delaiMs = 30_000 } = {}) {
  return new Promise((resolve, reject) => {
    const donnees = corps === undefined ? undefined : Buffer.from(JSON.stringify(corps));
    const req = http.request(
      url,
      {
        method: methode,
        headers: { ...entetes, ...(donnees ? { "content-type": "application/json", "content-length": donnees.length } : {}) },
        timeout: delaiMs,
      },
      (res) => {
        const morceaux = [];
        res.on("data", (m) => morceaux.push(m));
        res.on("end", () => {
          const texte = Buffer.concat(morceaux).toString("utf8");
          let json = null;
          try {
            json = texte === "" ? null : JSON.parse(texte);
          } catch {
            json = null;
          }
          resolve({ statut: res.statusCode ?? 0, texte, json });
        });
        res.on("error", reject);
      },
    );
    req.on("timeout", () => req.destroy(new Error(`délai dépassé : ${methode} ${url.pathname}`)));
    req.on("error", reject);
    if (donnees) req.write(donnees);
    req.end();
  });
}

const opencode = (chemin, options = {}) => {
  const url = new URL(chemin, OPENCODE);
  url.searchParams.set("directory", PROJET);
  return requete(url, { ...options, entetes: { authorization: AUTORISATION } });
};

const pilote = (chemin, corps) => requete(new URL(chemin, `http://127.0.0.1:${PORT_PILOTE}`), { methode: corps === undefined ? "GET" : "POST", corps });

// --- Faux fournisseur -------------------------------------------------------------------------------------------------------------

function lancerFaux() {
  const enfant = spawn(
    process.execPath,
    [FAUX, "--http", "--host", "0.0.0.0", "--port", String(PORT_API), "--pilot-host", "127.0.0.1", "--pilot-port", String(PORT_PILOTE)],
    { stdio: ["ignore", "pipe", "inherit"] },
  );
  return new Promise((resolve, reject) => {
    const lignes = createInterface({ input: enfant.stdout });
    const minuterie = setTimeout(() => reject(new Error("faux fournisseur muet")), 20_000);
    lignes.on("line", (ligne) => {
      let annonce = null;
      try {
        annonce = JSON.parse(ligne);
      } catch {
        annonce = null;
      }
      if (annonce?.pret === true) {
        clearTimeout(minuterie);
        resolve(enfant);
      }
    });
    enfant.once("exit", (code) => reject(new Error(`faux fournisseur arrêté (code ${code})`)));
  });
}

// --- Projet et état de garde ------------------------------------------------------------------------------------------------------

function preparerProjet() {
  fs.rmSync(PROJET_PILOTE, { recursive: true, force: true });
  fs.rmSync(DEHORS_PILOTE, { recursive: true, force: true });
  fs.mkdirSync(PROJET_PILOTE, { recursive: true });
  fs.mkdirSync(DEHORS_PILOTE, { recursive: true });
  fs.writeFileSync(path.join(PROJET_PILOTE, "README.md"), `Projet du banc L24. ${MARQUES.ordinaire}\n`);
  fs.writeFileSync(path.join(PROJET_PILOTE, "id_ed25519"), `${MARQUES.cle} : fausse clé du banc, aucun secret\n`);
  fs.writeFileSync(path.join(PROJET_PILOTE, ".env"), `FAUX_REGLAGE=${MARQUES.env}\n`);
  fs.writeFileSync(path.join(PROJET_PILOTE, ".env.example"), `EXEMPLE=${MARQUES.exemple}\n`);
  fs.writeFileSync(path.join(DEHORS_PILOTE, "id_ed25519"), `${MARQUES.cleDehors} : fausse clé hors du projet\n`);
  fs.writeFileSync(path.join(DEHORS_PILOTE, "notes.txt"), `${MARQUES.dehors}\n`);
  // Liens au nom ordinaire : seul le chemin réel dit où ils mènent.
  fs.symlinkSync("../dehors/id_ed25519", path.join(PROJET_PILOTE, "lien-vers-cle"));
  fs.symlinkSync("../dehors/notes.txt", path.join(PROJET_PILOTE, "lien-dehors.txt"));
}

/**
 * Pose l'état de garde comme le cockpit : fichier voisin puis renommage (jamais un fichier à moitié écrit). `etatLien` : l'état est
 * un lien vers un état VALIDE qui ne bloque rien ; le filet ne doit pas le suivre (sinon la délégation passerait).
 */
function poserEtat(scenario) {
  fs.rmSync(ETAT, { force: true });
  fs.rmSync(ETAT_CIBLE, { force: true });
  if (scenario.etatLien === true) {
    fs.writeFileSync(ETAT_CIBLE, `${JSON.stringify({ version: 1, at: Date.now(), bloquer: [] })}\n`);
    fs.symlinkSync(ETAT_CIBLE, ETAT);
    return;
  }
  const texte = scenario.etatTexte ?? (scenario.etat === undefined || scenario.etat === null ? null : `${JSON.stringify({ version: 1, at: Date.now(), ...scenario.etat })}\n`);
  if (texte === null) return;
  const temporaire = `${ETAT}.banc.tmp`;
  fs.writeFileSync(temporaire, texte);
  fs.renameSync(temporaire, ETAT);
}

// --- Scénarios ----------------------------------------------------------------------------------------------------------------------

const TACHE = { description: "Tache du banc", prompt: "Reponds en une ligne.", subagent_type: "general" };

/** Un état de garde de plus de 4 Kio, JSON valide par ailleurs : le filet le tient pour invalide. */
const ETAT_TROP_GROS = `${JSON.stringify({ version: 1, at: 1_757_000_000_000, bloquer: [] })}${" ".repeat(5000)}\n`;

const SCENARIOS = Object.freeze([
  { nom: "a1-temoin", outil: "read", arguments: { filePath: `${PROJET}/README.md` } },
  { nom: "a2-cle", outil: "read", arguments: { filePath: `${PROJET}/id_ed25519` } },
  { nom: "a3-env", outil: "read", arguments: { filePath: `${PROJET}/.env` } },
  { nom: "a4-env-example", outil: "read", arguments: { filePath: `${PROJET}/.env.example` } },
  { nom: "a5-lien-vers-cle", outil: "read", arguments: { filePath: `${PROJET}/lien-vers-cle` } },
  { nom: "a6-lien-dehors", outil: "read", arguments: { filePath: `${PROJET}/lien-dehors.txt` } },
  { nom: "a7-hors-projet", outil: "read", arguments: { filePath: "/etc/hostname" } },
  { nom: "a8-reseau", outil: "webfetch", arguments: { url: "http://example.invalid/", format: "text" } },
  { nom: "a9-grep-env", outil: "grep", arguments: { pattern: "FACTICE", include: ".env*" } },
  { nom: "b1-bloquer", outil: "task", arguments: TACHE, etat: { bloquer: ["task"] } },
  { nom: "b2-absent", outil: "task", arguments: TACHE, etat: null },
  { nom: "b3-invalide", outil: "task", arguments: TACHE, etatTexte: "{pas du json\n" },
  { nom: "b4-trop-gros", outil: "task", arguments: TACHE, etatTexte: ETAT_TROP_GROS },
  { nom: "b5-lien", outil: "task", arguments: TACHE, etatLien: true },
  { nom: "b6-rien-a-bloquer", outil: "task", arguments: TACHE, etat: { bloquer: [] } },
]);

/**
 * Scénarios joués : tous, ou ceux que nomme BANC_SCENARIOS (liste séparée par des virgules), pour la contre-épreuve sans filet.
 * Un nom inconnu arrête le banc : une contre-épreuve qui ne jouerait rien passerait pour réussie.
 */
function scenariosDemandes() {
  const noms = (process.env.BANC_SCENARIOS ?? "").split(",").map((n) => n.trim()).filter(Boolean);
  if (noms.length === 0) return SCENARIOS;
  const inconnus = noms.filter((n) => !SCENARIOS.some((s) => s.nom === n));
  if (inconnus.length > 0) throw new Error(`scénarios inconnus : ${inconnus.join(", ")}`);
  return SCENARIOS.filter((s) => noms.includes(s.nom));
}

/** Attend qu'opencode réponde ; rend sa version (GET /global/health). */
async function attendreOpencode() {
  const fin = Date.now() + 120_000;
  let dernier = "";
  while (Date.now() < fin) {
    try {
      const r = await opencode("/global/health", { delaiMs: 5_000 });
      if (r.statut === 200) return typeof r.json?.version === "string" ? r.json.version : null;
      dernier = `HTTP ${r.statut}`;
    } catch (err) {
      dernier = err instanceof Error ? err.message : String(err);
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`opencode injoignable : ${dernier}`);
}

async function jouer(scenario) {
  poserEtat(scenario);
  await pilote("/reinitialiser", {});
  const appel = { nom: scenario.outil, id: `appel-${scenario.nom}`, arguments: scenario.arguments };
  // Un appel d'outil, puis deux textes : l'un pour une IA déléguée (si la délégation passe), l'autre pour la fin du tour.
  const file = await pilote("/reponses", { ia: IA, reponses: [{ outils: [appel] }, { texte: "Fin de la tache du banc." }, { texte: "Fin du scenario." }] });
  if (file.statut !== 200) throw new Error(`file du faux fournisseur refusée : ${file.texte}`);

  const session = await opencode("/session", { methode: "POST", corps: { title: `banc-l24-${scenario.nom}` } });
  const id = session.json?.id;
  if (typeof id !== "string") throw new Error(`session refusée : HTTP ${session.statut}`);
  const envoi = await opencode(`/session/${id}/message`, {
    methode: "POST",
    corps: { agent: "build", model: { providerID: "faux", modelID: IA }, parts: [{ type: "text", text: `[L24] ${scenario.nom}` }] },
    delaiMs: 120_000,
  });
  const messages = await opencode(`/session/${id}/message`);
  const sessions = await opencode("/session");
  const fauxJournal = await pilote("/journal");

  const liste = Array.isArray(messages.json) ? messages.json : [];
  const parties = liste.flatMap((m) => (Array.isArray(m?.parts) ? m.parts : []));
  const outil = parties.find((p) => p?.type === "tool" && p?.tool === scenario.outil);
  const etat = outil?.state ?? {};
  const toutLeTexte = JSON.stringify(liste);
  return {
    nom: scenario.nom,
    outil: scenario.outil,
    envoi: envoi.statut,
    statut: typeof etat.status === "string" ? etat.status : null,
    erreur: extrait(etat.error, 600),
    sortie: extrait(etat.output, 300),
    marquesVues: Object.fromEntries(Object.entries(MARQUES).map(([cle, marque]) => [cle, toutLeTexte.includes(marque)])),
    enfants: (Array.isArray(sessions.json) ? sessions.json : []).filter((s) => s?.parentID === id).length,
    appelsIa: (fauxJournal.json?.journal ?? []).filter((e) => e?.route === "chat").length,
  };
}

// --- Déroulé --------------------------------------------------------------------------------------------------------------------------

let faux = null;
let code = 0;
const rapport = { debut: new Date().toISOString(), opencode: null, scenarios: [], erreur: null };
try {
  const demandes = scenariosDemandes();
  faux = await lancerFaux();
  journal("faux fournisseur prêt");
  preparerProjet();
  rapport.opencode = await attendreOpencode();
  journal(`opencode ${rapport.opencode ?? "?"} prêt`);
  for (const scenario of demandes) {
    try {
      const resultat = await jouer(scenario);
      rapport.scenarios.push(resultat);
      journal(`${scenario.nom} : ${resultat.statut}`);
    } catch (err) {
      rapport.scenarios.push({ nom: scenario.nom, outil: scenario.outil, echec: extrait(err instanceof Error ? err.message : String(err), 400) });
      journal(`${scenario.nom} : échec du banc`);
    }
  }
} catch (err) {
  rapport.erreur = extrait(err instanceof Error ? err.message : String(err), 600);
  code = 1;
} finally {
  fs.rmSync(ETAT, { force: true });
  fs.rmSync(ETAT_CIBLE, { force: true });
  if (faux !== null) faux.kill("SIGTERM");
}
rapport.fin = new Date().toISOString();
process.stdout.write(`RAPPORT ${masquer(JSON.stringify(rapport))}\n`);
process.exitCode = code;
