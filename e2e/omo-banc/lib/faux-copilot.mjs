// Banc de la salle (L21a) : faux fournisseur scripté, sans aucune dépendance (modules « node: » seulement, P8).
//
// Deux modes, un seul à la fois :
// - « --http --port <p> » : API compatible OpenAI (/v1/models, /v1/chat/completions), pour un opencode de test sans extension ;
// - « --tls --cert <f> --key <f> --port <p> » : chemins du fournisseur github-copilot (/models, /chat/completions), lus dans le
//   code d'opencode 1.18.30 (plugin/github-copilot : base(), CopilotModels.get, copilot-provider) ; MO-9 les confirme au train de V0.
// Le catalogue porte les deux formes (champs Copilot et champs OpenAI) : un client ignore ce qu'il ne connaît pas.
//
// Un second port sert le pilotage : file de réponses par ordre d'arrivée ou par IA demandée, journal, remise à zéro, arrêt.
// Rien n'est appelé au dehors : aucune sortie réseau, aucun secret, aucun texte de l'extension (réponses synthétiques).
// Le journal relève la PRÉSENCE de l'en-tête d'autorisation, jamais sa valeur ; ni chaîne de requête, ni texte de message.
//
// e2e/lib/faux-fournisseur.mjs (banc e2e du produit, L7a) n'est jamais touché : ce fichier est un serveur à part (D-2b-43).
import { createHash, timingSafeEqual } from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import https from "node:https";
import { parseArgs } from "node:util";

// --- Bornes et formats ----------------------------------------------------------------------------------------------------------

const MAX_CORPS_API = 16_777_216;
const MAX_CORPS_PILOTE = 1_048_576;
const MAX_DELAI_MS = 60_000;
const MAX_FILE = 200;
const MAX_TEXTE = 100_000;
const MAX_OUTILS = 20;
const MAX_ARGUMENTS = 20_000;
const MAX_JOURNAL = 500;

/** Outils de la salle : read, grep, glob, list, bash, edit, write, task, call_omo_agent, skill, skill_mcp, et les suivants. */
const NOM_OUTIL = /^[a-z][a-z0-9_]{1,63}$/;
const ID_IA = /^[A-Za-z0-9][A-Za-z0-9._\/-]{0,79}$/;
/** Valeur d'en-tête relevable telle quelle : courte et sans surprise ; tout le reste devient « (non relevée) ». */
const VALEUR_SURE = /^[A-Za-z0-9 .,:;_\/+-]{1,80}$/;
const FINS = new Set(["stop", "tool_calls", "length", "content_filter"]);
const CLES_REPONSE = new Set(["texte", "outils", "fin", "statut", "retryAfter", "delaiMs", "usage", "nanoAiu"]);

// --- Arguments de démarrage -----------------------------------------------------------------------------------------------------

const refuser = (raison) => {
  process.stderr.write(`faux-copilot : ${raison}\n`);
  process.exit(2);
};

let options;
try {
  ({ values: options } = parseArgs({
    options: {
      http: { type: "boolean" },
      tls: { type: "boolean" },
      cert: { type: "string" },
      key: { type: "string" },
      host: { type: "string" },
      port: { type: "string" },
      "pilot-host": { type: "string" },
      "pilot-port": { type: "string" },
    },
    strict: true,
    allowPositionals: false,
  }));
} catch (err) {
  refuser(err instanceof Error ? err.message : "arguments refusés");
}

const nombrePort = (nom, valeur, defaut) => {
  if (valeur === undefined) return defaut;
  if (!/^\d{1,5}$/.test(valeur) || Number(valeur) > 65535) refuser(`--${nom} : entier de 0 à 65535 attendu`);
  return Number(valeur);
};

if (Boolean(options.http) === Boolean(options.tls)) refuser("un seul mode attendu : --http ou --tls");
const MODE = options.tls ? "tls" : "http";
if (MODE === "tls" && (!options.cert || !options.key)) refuser("--tls exige --cert et --key");
if (MODE === "http" && (options.cert !== undefined || options.key !== undefined)) refuser("--cert et --key vont avec --tls");

const HOTE = options.host ?? "127.0.0.1";
const PILOTE_HOTE = options["pilot-host"] ?? "127.0.0.1";
const PORT = nombrePort("port", options.port, 0);
const PORT_PILOTE = nombrePort("pilot-port", options["pilot-port"], 0);
/** Secret du pilotage : par la variable d'environnement seulement, jamais en argument (il serait lisible par « ps »). */
const JETON = process.env.FAUX_COPILOT_JETON_PILOTE ?? "";

const bouclage = (hote) => hote === "::1" || hote === "localhost" || hote.startsWith("127.");
if (JETON !== "" && JETON.length < 16) refuser("FAUX_COPILOT_JETON_PILOTE : 16 caractères au moins");
if (!bouclage(PILOTE_HOTE) && JETON === "") refuser("--pilot-host hors de la boucle locale : FAUX_COPILOT_JETON_PILOTE exigé");

const memeJeton = (donne) =>
  typeof donne === "string" && timingSafeEqual(createHash("sha256").update(donne).digest(), createHash("sha256").update(JETON).digest());

const lireFichier = (chemin, quoi) => {
  try {
    return fs.readFileSync(chemin);
  } catch {
    return refuser(`${quoi} illisible : ${chemin}`);
  }
};

// --- État : file de réponses, catalogue, journal ---------------------------------------------------------------------------------

const REPONSE_DEFAUT = {
  texte: "Réponse du faux fournisseur de la salle.",
  outils: [],
  fin: "stop",
  delaiMs: 0,
  usage: { entree: 20, sortie: 6 },
  nanoAiu: 0,
};

const etat = { ordre: [], parIa: new Map(), modeles: ["faux-m1", "faux-m2"] };
const journal = [];
let recues = 0;

const enFile = () => ({ ordre: etat.ordre.length, parIa: Object.fromEntries([...etat.parIa].map(([ia, file]) => [ia, file.length])) });

const entier = (valeur, min, max) => Number.isInteger(valeur) && valeur >= min && valeur <= max;

/** Réponse scriptée : objet normalisé, ou un texte qui dit ce qui cloche (le lot entier est alors refusé). */
const validerReponse = (brute) => {
  if (typeof brute !== "object" || brute === null || Array.isArray(brute)) return "objet attendu";
  const inconnue = Object.keys(brute).find((cle) => !CLES_REPONSE.has(cle));
  if (inconnue !== undefined) return `clé inconnue « ${inconnue} »`;
  if (brute.delaiMs !== undefined && !entier(brute.delaiMs, 0, MAX_DELAI_MS)) return `delaiMs : entier de 0 à ${MAX_DELAI_MS}`;
  if (brute.statut !== undefined) {
    if (!entier(brute.statut, 400, 599)) return "statut : entier de 400 à 599";
    const deTrop = ["texte", "outils", "fin", "usage", "nanoAiu"].find((cle) => brute[cle] !== undefined);
    if (deTrop !== undefined) return `${deTrop} : sans objet avec statut`;
    if (brute.retryAfter !== undefined && !entier(brute.retryAfter, 0, 3600)) return "retryAfter : entier de 0 à 3600";
    return { statut: brute.statut, retryAfter: brute.retryAfter, delaiMs: brute.delaiMs ?? 0 };
  }
  if (brute.retryAfter !== undefined) return "retryAfter : avec statut seulement";
  if (brute.texte !== undefined && (typeof brute.texte !== "string" || brute.texte.length > MAX_TEXTE)) {
    return `texte : chaîne de ${MAX_TEXTE} caractères au plus`;
  }
  if (brute.fin !== undefined && !FINS.has(brute.fin)) return `fin : ${[...FINS].join(", ")}`;
  if (brute.nanoAiu !== undefined && !entier(brute.nanoAiu, 0, Number.MAX_SAFE_INTEGER)) return "nanoAiu : entier positif";
  const usage = brute.usage ?? REPONSE_DEFAUT.usage;
  if (typeof usage !== "object" || usage === null || !entier(usage.entree, 0, 100_000_000) || !entier(usage.sortie, 0, 100_000_000)) {
    return "usage : { entree, sortie } entiers positifs";
  }
  const outils = [];
  if (brute.outils !== undefined) {
    if (!Array.isArray(brute.outils) || brute.outils.length > MAX_OUTILS) return `outils : liste de ${MAX_OUTILS} éléments au plus`;
    for (const [i, outil] of brute.outils.entries()) {
      if (typeof outil !== "object" || outil === null || Array.isArray(outil)) return `outils[${i}] : objet attendu`;
      if (typeof outil.nom !== "string" || !NOM_OUTIL.test(outil.nom)) return `outils[${i}].nom : nom d'outil attendu`;
      if (outil.id !== undefined && (typeof outil.id !== "string" || !ID_IA.test(outil.id))) return `outils[${i}].id : identifiant simple attendu`;
      const args = outil.arguments ?? {};
      if (typeof args !== "string" && (typeof args !== "object" || args === null)) return `outils[${i}].arguments : objet ou chaîne JSON attendus`;
      if ((typeof args === "string" ? args : JSON.stringify(args)).length > MAX_ARGUMENTS) return `outils[${i}].arguments : ${MAX_ARGUMENTS} caractères au plus`;
      outils.push({ nom: outil.nom, id: outil.id, arguments: typeof args === "string" ? args : JSON.stringify(args) });
    }
  }
  return {
    texte: brute.texte ?? (outils.length > 0 ? "" : REPONSE_DEFAUT.texte),
    outils,
    fin: brute.fin ?? (outils.length > 0 ? "tool_calls" : "stop"),
    delaiMs: brute.delaiMs ?? 0,
    usage: { entree: usage.entree, sortie: usage.sortie },
    nanoAiu: brute.nanoAiu ?? 0,
  };
};

/** POST /reponses : tout le lot est bon, ou rien n'est mis en file. */
const posterReponses = (corps) => {
  if (typeof corps !== "object" || corps === null || Array.isArray(corps)) return [400, { erreur: "objet attendu" }];
  if (corps.ia !== undefined && (typeof corps.ia !== "string" || !ID_IA.test(corps.ia))) return [400, { erreur: "ia : identifiant d'IA attendu" }];
  if (!Array.isArray(corps.reponses) || corps.reponses.length === 0 || corps.reponses.length > MAX_FILE) {
    return [400, { erreur: `reponses : liste de 1 à ${MAX_FILE} éléments` }];
  }
  const valides = [];
  for (const [i, brute] of corps.reponses.entries()) {
    const reponse = validerReponse(brute);
    if (typeof reponse === "string") return [400, { erreur: `reponses[${i}] : ${reponse}` }];
    valides.push(reponse);
  }
  let file = etat.ordre;
  if (corps.ia !== undefined) {
    if (!etat.parIa.has(corps.ia)) etat.parIa.set(corps.ia, []);
    file = etat.parIa.get(corps.ia);
  }
  if (file.length + valides.length > MAX_FILE) return [400, { erreur: `file : ${MAX_FILE} réponses au plus` }];
  file.push(...valides);
  return [200, { ok: true, enFile: enFile() }];
};

/** POST /modeles : le catalogue servi par /models (ou /v1/models). */
const posterModeles = (corps) => {
  const modeles = typeof corps === "object" && corps !== null ? corps.modeles : undefined;
  const ok =
    Array.isArray(modeles) &&
    modeles.length >= 1 &&
    modeles.length <= 50 &&
    modeles.every((ia) => typeof ia === "string" && ID_IA.test(ia)) &&
    new Set(modeles).size === modeles.length;
  if (!ok) return [400, { erreur: "modeles : de 1 à 50 identifiants d'IA distincts" }];
  etat.modeles = [...modeles];
  return [200, { ok: true, modeles: etat.modeles }];
};

const catalogue = () => ({
  object: "list",
  data: etat.modeles.map((ia) => ({
    id: ia,
    object: "model",
    owned_by: "faux-copilot",
    name: `Faux ${ia}`,
    version: `${ia}-2026-01-01`,
    model_picker_enabled: true,
    supported_endpoints: ["/chat/completions"],
    policy: { state: "enabled" },
    capabilities: {
      family: "faux",
      limits: { max_context_window_tokens: 128_000, max_prompt_tokens: 120_000, max_output_tokens: 8_000 },
      supports: { streaming: true, tool_calls: true, structured_outputs: true, vision: false },
    },
  })),
});

const valeurSure = (valeur) => {
  if (valeur === undefined) return null;
  return typeof valeur === "string" && VALEUR_SURE.test(valeur) ? valeur : "(non relevée)";
};

/** Relevé d'une requête : rien du contenu, rien des secrets ; l'autorisation n'est qu'un booléen de présence. */
const journaliser = (req) => {
  const h = req.headers;
  const chemin = (req.url ?? "/").split(/[?#]/, 1)[0].slice(0, 200);
  recues += 1;
  const entree = {
    n: recues,
    methode: (req.method ?? "").slice(0, 10),
    chemin,
    route: "non-servie",
    autorisation: h.authorization !== undefined,
    entetes: Object.keys(h).sort(),
    copilot: {
      apiVersion: valeurSure(h["x-github-api-version"]),
      initiateur: valeurSure(h["x-initiator"]),
      intention: valeurSure(h["openai-intent"]),
      interaction: valeurSure(h["x-interaction-type"]),
      vision: valeurSure(h["copilot-vision-request"]),
      agentUtilisateur: valeurSure(h["user-agent"]),
    },
    ia: null,
    messages: 0,
    outilsProposes: 0,
    outilsServis: 0,
    octets: 0,
    flux: false,
    servie: null,
    abandon: false,
  };
  journal.push(entree);
  if (journal.length > MAX_JOURNAL) journal.shift();
  return entree;
};

// --- Service de l'API -------------------------------------------------------------------------------------------------------------

class ErreurCorps extends Error {}

const lireCorps = async (req, max) => {
  const morceaux = [];
  let taille = 0;
  for await (const morceau of req) {
    taille += morceau.length;
    if (taille > max) throw new ErreurCorps(`corps de plus de ${max} octets`);
    morceaux.push(morceau);
  }
  return { taille, texte: Buffer.concat(morceaux).toString("utf8") };
};

const repondre = (res, code, corps) => {
  res.writeHead(code, { "content-type": "application/json", "cache-control": "no-store" });
  res.end(JSON.stringify(corps));
};

/** Attend `ms`, ou rend false dès que le client part : un appel abandonné n'est jamais servi (et le journal le dit). */
const attendre = (ms, res) =>
  new Promise((resolve) => {
    if (res.destroyed) return resolve(false);
    let fini = false;
    const surDepart = () => {
      if (fini) return;
      fini = true;
      clearTimeout(minuterie);
      resolve(false);
    };
    const minuterie = setTimeout(() => {
      if (fini) return;
      fini = true;
      res.off("close", surDepart);
      resolve(true);
    }, ms);
    res.on("close", surDepart);
  });

const prendreReponse = (ia) => {
  const file = ia === null ? undefined : etat.parIa.get(ia);
  if (file !== undefined && file.length > 0) return file.shift();
  return etat.ordre.shift() ?? REPONSE_DEFAUT;
};

const idAppel = (entree, outil, i) => outil.id ?? `call_faux_${entree.n}_${i}`;

const appelsOutils = (entree, reponse) =>
  reponse.outils.map((o, i) => ({ id: idAppel(entree, o, i), type: "function", function: { name: o.nom, arguments: o.arguments } }));

const usageServi = (reponse) => ({
  prompt_tokens: reponse.usage.entree,
  completion_tokens: reponse.usage.sortie,
  total_tokens: reponse.usage.entree + reponse.usage.sortie,
});

const blocComplet = (entree, ia, reponse) => ({
  id: `chatcmpl-faux-${entree.n}`,
  object: "chat.completion",
  created: Math.floor(Date.now() / 1000),
  model: ia,
  choices: [
    {
      index: 0,
      message: {
        role: "assistant",
        content: reponse.texte,
        ...(reponse.outils.length > 0 ? { tool_calls: appelsOutils(entree, reponse) } : {}),
      },
      finish_reason: reponse.fin,
    },
  ],
  usage: usageServi(reponse),
  copilot_usage: { total_nano_aiu: reponse.nanoAiu },
});

/** Flux SSE : un morceau de texte, puis un morceau par appel d'outil (nom seul, arguments ensuite), puis la fin et [DONE]. */
const envoyerFlux = (res, entree, ia, reponse) => {
  res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store", connection: "keep-alive" });
  const base = { id: `chatcmpl-faux-${entree.n}`, object: "chat.completion.chunk", created: Math.floor(Date.now() / 1000), model: ia };
  const ecrire = (texte) => res.write(texte);
  const bloc = (donnees) => ecrire(`data: ${JSON.stringify({ ...base, ...donnees })}\n\n`);
  if (reponse.texte !== "") bloc({ choices: [{ index: 0, delta: { role: "assistant", content: reponse.texte }, finish_reason: null }] });
  reponse.outils.forEach((o, i) => {
    const debut = { index: i, id: idAppel(entree, o, i), type: "function", function: { name: o.nom, arguments: "" } };
    bloc({ choices: [{ index: 0, delta: { tool_calls: [debut] }, finish_reason: null }] });
    bloc({ choices: [{ index: 0, delta: { tool_calls: [{ index: i, function: { arguments: o.arguments } }] }, finish_reason: null }] });
  });
  bloc({ choices: [{ index: 0, delta: {}, finish_reason: reponse.fin }], usage: usageServi(reponse), copilot_usage: { total_nano_aiu: reponse.nanoAiu } });
  ecrire("data: [DONE]\n\n");
  res.end();
};

const servirReponse = async (res, entree, ia, reponse) => {
  if (!(await attendre(reponse.delaiMs, res))) {
    entree.abandon = true;
    return;
  }
  if (reponse.statut !== undefined) {
    const entetes = { "content-type": "application/json", "cache-control": "no-store" };
    if (reponse.retryAfter !== undefined) entetes["retry-after"] = String(reponse.retryAfter);
    entree.servie = reponse.statut;
    res.writeHead(reponse.statut, entetes);
    res.end(JSON.stringify({ error: { message: "réponse scriptée du faux fournisseur", type: "faux_copilot", code: reponse.statut } }));
    return;
  }
  entree.outilsServis = reponse.outils.length;
  entree.servie = 200;
  if (entree.flux) envoyerFlux(res, entree, ia, reponse);
  else repondre(res, 200, blocComplet(entree, ia, reponse));
};

const servirCompletions = async (req, res, entree) => {
  const { taille, texte } = await lireCorps(req, MAX_CORPS_API);
  entree.octets = taille;
  const corps = texte === "" ? {} : JSON.parse(texte);
  entree.messages = Array.isArray(corps.messages) ? corps.messages.length : 0;
  entree.outilsProposes = Array.isArray(corps.tools) ? corps.tools.length : 0;
  entree.flux = corps.stream === true;
  const ia = typeof corps.model === "string" && ID_IA.test(corps.model) ? corps.model : null;
  entree.ia = ia;
  await servirReponse(res, entree, ia ?? etat.modeles[0], prendreReponse(ia));
};

const CHEMINS = MODE === "tls" ? { modeles: "/models", chat: "/chat/completions" } : { modeles: "/v1/models", chat: "/v1/chat/completions" };

const gererApi = (req, res) => {
  void (async () => {
    const entree = journaliser(req);
    try {
      if (req.method === "GET" && entree.chemin === CHEMINS.modeles) {
        entree.route = "modeles";
        entree.servie = 200;
        return repondre(res, 200, catalogue());
      }
      if (req.method !== "POST" || entree.chemin !== CHEMINS.chat) {
        entree.servie = 404;
        return repondre(res, 404, { error: { message: "route non servie par le faux fournisseur" } });
      }
      entree.route = "chat";
      await servirCompletions(req, res, entree);
    } catch (err) {
      const code = err instanceof ErreurCorps ? 413 : 400;
      entree.servie = code;
      if (res.headersSent) res.end();
      else repondre(res, code, { error: { message: err instanceof Error ? err.message : "requête refusée" } });
    }
  })();
};

// --- Pilotage -----------------------------------------------------------------------------------------------------------------------

const gererPilote = (req, res) => {
  void (async () => {
    try {
      if (JETON !== "" && !memeJeton(req.headers["x-pilote-jeton"])) return repondre(res, 401, { erreur: "jeton de pilotage manquant ou incorrect" });
      const chemin = (req.url ?? "/").split(/[?#]/, 1)[0];
      if (req.method === "GET" && chemin === "/journal") return repondre(res, 200, { mode: MODE, recues, journal, enFile: enFile(), modeles: etat.modeles });
      if (req.method !== "POST") return repondre(res, 405, { erreur: "méthode non servie par le pilotage" });
      const { texte } = await lireCorps(req, MAX_CORPS_PILOTE);
      const corps = texte === "" ? {} : JSON.parse(texte);
      if (chemin === "/reponses") return repondre(res, ...posterReponses(corps));
      if (chemin === "/modeles") return repondre(res, ...posterModeles(corps));
      if (chemin === "/reinitialiser") {
        journal.length = 0;
        recues = 0;
        etat.ordre.length = 0;
        etat.parIa.clear();
        return repondre(res, 200, { ok: true });
      }
      if (chemin === "/arreter") {
        res.on("close", () => arreter("pilotage"));
        return repondre(res, 200, { ok: true });
      }
      return repondre(res, 404, { erreur: "route non servie par le pilotage" });
    } catch (err) {
      const code = err instanceof ErreurCorps ? 413 : 400;
      if (!res.headersSent) repondre(res, code, { erreur: err instanceof Error ? err.message : "requête refusée" });
      else res.end();
    }
  })();
};

// --- Démarrage et arrêt ---------------------------------------------------------------------------------------------------------------

const api =
  MODE === "tls"
    ? https.createServer({ cert: lireFichier(options.cert, "certificat"), key: lireFichier(options.key, "clé") }, gererApi)
    : http.createServer(gererApi);
const pilote = http.createServer(gererPilote);

const annoncer = (objet) => process.stdout.write(`${JSON.stringify(objet)}\n`);

let arretEnCours = false;
/** Arrêt propre : les deux ports fermés, les connexions retenues coupées (une réponse en attente ne bloque rien), code 0. */
const arreter = (raison) => {
  if (arretEnCours) return;
  arretEnCours = true;
  annoncer({ arret: raison });
  const fermetures = [api, pilote].map(async (serveur) => {
    await new Promise((resolve) => {
      serveur.close(() => resolve());
      serveur.closeAllConnections();
    });
  });
  void Promise.all(fermetures).then(() => process.exit(0));
};
process.on("SIGTERM", () => arreter("SIGTERM"));
process.on("SIGINT", () => arreter("SIGINT"));

const ecouter = (serveur, hote, port) =>
  new Promise((resolve, reject) => {
    serveur.once("error", reject);
    serveur.listen(port, hote, () => {
      resolve(serveur.address().port);
    });
  });

try {
  const portApi = await ecouter(api, HOTE, PORT);
  const portPilote = await ecouter(pilote, PILOTE_HOTE, PORT_PILOTE);
  annoncer({ pret: true, mode: MODE, api: { hote: HOTE, port: portApi }, pilote: { hote: PILOTE_HOTE, port: portPilote } });
} catch (err) {
  refuser(`écoute impossible : ${err instanceof Error ? err.message : "cause inconnue"}`);
}
