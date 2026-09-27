// Bibliothèque d'arrêt du banc complet (L21b), commune aux portes de la vague 5 (L27a : G5, G9, G13 ; L27b : G6, G7, G8) :
// arrêter une salle comme la page, attendre que la salle se taise ou qu'elle reparte à neuf (nouveau `startId`), et relever des
// EMPREINTES comparables avant et après.
//
// Ce que G5 exige (§7.10 l.1219) et que cette bibliothèque rend mesurable :
// - « aucune session occupée en 10 s » : `attendreRepos`, sur `GET /session/status` de la salle (par l'espion) — une session
//   absente de la réponse est au repos, toute autre forme que `{type: "idle"}` compte comme occupée (règle d'assistants.ts) ;
// - « aucun message, usage ni session pendant 180 s » et « zéro POST …/command » : `releverActivite` puis `ecartActivite`, sur
//   les compteurs de l'espion (requêtes ET types d'événements du flux) et sur le journal du faux fournisseur (un usage = un appel
//   au fournisseur, c'est là qu'il se voit sans lire aucun contenu) ;
// - « empreintes des dossiers de configuration identiques après la relance à neuf », « et d'`oc-omo-data` hors `opencode.db*`
//   et `storage/` » (fiche L27a) : `empreintes` puis `comparerEmpreintes`.
//
// Rien ici ne lit un contenu : des codes, des compteurs, des tailles et des empreintes SHA-256. Aucune dépendance npm (P8).
import { requete } from "./client.mjs";

/** Les cinq dossiers de configuration lus par l'extension et opencode (D-2b-33), plus la configuration d'instance de l'image. */
export const DOSSIERS_CONFIGURATION = Object.freeze([
  "/home/node/.config/opencode",
  "/home/node/.opencode",
  "/home/node/.omo",
  "/home/node/.claude",
  "/home/node/.agents",
  "/etc/opencode-omo",
]);

/** Données d'opencode dans la salle (`oc-omo-data`). */
export const DONNEES_SALLE = "/home/node/.local/share/opencode";

/** Ce qui change à chaque session sans rien dire de la configuration : écarté des empreintes d'`oc-omo-data` (fiche L27a). */
export const HORS_EMPREINTE = Object.freeze([/^opencode\.db/, /^storage(\/|$)/]);

const enc = encodeURIComponent;

/** `POST /api/omo/rooms/:rootId/stop` (D-2b-30) : « Arrêter » de la salle, dans les deux modes, jamais /api/conversations/…/stop. */
export async function arreter(client, rootId) {
  const r = await client.brut("POST", `/api/omo/rooms/${enc(rootId)}/stop`, {});
  let json = null;
  try {
    json = r.corps === "" ? null : JSON.parse(r.corps);
  } catch {
    json = null;
  }
  return { code: r.code, json, erreur: typeof json?.error === "string" ? json.error : null };
}

/** Compteurs de l'espion (`GET /__espion/compteurs`, lib/espion.mjs), par sa publication sur la boucle locale. */
export async function compteursEspion(port) {
  const r = await requete({ port, chemin: "/__espion/compteurs", delaiMs: 10_000 });
  if (r.code !== 200 || r.json === null) throw new Error(`compteurs de l'espion illisibles (code ${r.code})`);
  return r.json;
}

/** Appels reçus par le faux fournisseur de la salle (`GET /journal` du pilotage, L21a) : le nombre seul. */
export async function appelsFaux(faux) {
  const r = await faux.journal();
  if (r.code !== 200 || typeof r.json?.recues !== "number") throw new Error(`journal du faux illisible (code ${r.code})`);
  return r.json.recues;
}

/** Instantané d'activité : compteurs de l'espion et appels au faux, lus ensemble. */
export async function releverActivite({ portEspion, faux }) {
  const [espion, fournisseur] = await Promise.all([compteursEspion(portEspion), appelsFaux(faux)]);
  return { at: Date.now(), espion, fournisseur };
}

/**
 * Écart d'activité entre deux instantanés. Les événements du flux sont comptés sur les flux présents dans LES DEUX instantanés
 * (un flux ouvert entre les deux n'a pas d'origine commune) ; un flux vivant dans le premier et fermé dans le second compte
 * encore. Le plus grand écart parmi les flux est retenu : deux clients qui écoutent la même salle ne doublent rien.
 */
export function ecartActivite(avant, apres) {
  const r = (cle) => (apres.espion?.requetes?.[cle] ?? 0) - (avant.espion?.requetes?.[cle] ?? 0);
  const fluxAvant = avant.espion?.flux ?? [];
  const communs = (apres.espion?.flux ?? []).flatMap((f) => {
    const g = fluxAvant.find((x) => x.n === f.n);
    return g === undefined ? [] : [{ apres: f.types ?? {}, avant: g.types ?? {} }];
  });
  const parFlux = (type) => communs.reduce((max, c) => Math.max(max, (c.apres[type] ?? 0) - (c.avant[type] ?? 0)), 0);
  const types = [...new Set(communs.flatMap((c) => Object.keys(c.apres)))].sort();
  return {
    dureeMs: (apres.at ?? 0) - (avant.at ?? 0),
    commandes: r("commande"),
    envois: r("envoi") + r("message"),
    sessionsHttp: r("session"),
    sessionsCreees: parFlux("session.created"),
    messages: parFlux("message.updated"),
    fluxObserves: communs.length,
    appelsFournisseur: (apres.fournisseur ?? 0) - (avant.fournisseur ?? 0),
    // Plus grand écart par type d'événement, pour le relevé (des noms et des nombres, jamais de contenu).
    types: Object.fromEntries(types.map((t) => [t, parFlux(t)]).filter(([, n]) => n > 0)),
  };
}

/** Vrai quand l'écart ne montre AUCUNE activité de la salle (G5 : rien pendant 180 s, zéro `POST …/command`). */
export function silence(ecart) {
  return ecart.commandes === 0 && ecart.envois === 0 && ecart.sessionsHttp === 0 && ecart.sessionsCreees === 0 && ecart.messages === 0 && ecart.appelsFournisseur === 0;
}

/** Occupation lue dans `GET /session/status` : true dès qu'une entrée n'est pas `{type: "idle"}`. Illisible : occupée. */
export function occupee(statut) {
  if (statut === null || typeof statut !== "object" || Array.isArray(statut)) return true;
  return Object.values(statut).some((s) => s === null || typeof s !== "object" || s.type !== "idle");
}

/**
 * Attend qu'aucune session de la salle ne soit occupée dans `directory` (G5 : 10 s). `clientOmo` : client de la salle par
 * l'espion (lib/client.mjs). Rend `{ ok, attenteMs, dernier }` ; une salle injoignable n'est pas « au repos ».
 */
export async function attendreRepos(clientOmo, directory, { delaiMs = 10_000, pasMs = 500 } = {}) {
  const debut = Date.now();
  let dernier = null;
  for (;;) {
    const r = await clientOmo.get(`/session/status?directory=${enc(directory)}`, { delaiMs: 5_000 }).catch(() => null);
    dernier = r === null ? null : { code: r.code, occupee: r.code === 200 ? occupee(r.json) : true };
    if (dernier !== null && dernier.code === 200 && !dernier.occupee) return { ok: true, attenteMs: Date.now() - debut, dernier };
    if (Date.now() - debut >= delaiMs) return { ok: false, attenteMs: Date.now() - debut, dernier };
    await new Promise((res) => setTimeout(res, pasMs));
  }
}

/**
 * Attend une RELANCE À NEUF : `state.json` du superviseur publie un `startId` différent de `startIdAvant`, puis la phase voulue
 * (défaut « opencode-lance »). `lireEtat` rend l'état publié (`ctx.etat` du banc) ou null. Rend `{ ok, startId, phase,
 * attenteMs }`, jamais une exception : une salle qui ne repart pas est un constat, pas un plantage du banc.
 */
export async function attendreNouveauDemarrage(lireEtat, startIdAvant, { phase = "opencode-lance", delaiMs = 120_000, pasMs = 1000 } = {}) {
  const debut = Date.now();
  let dernier = null;
  for (;;) {
    dernier = await Promise.resolve()
      .then(() => lireEtat())
      .catch(() => null);
    const startId = typeof dernier?.startId === "string" ? dernier.startId : null;
    if (startId !== null && startId !== startIdAvant && dernier?.phase === phase) {
      return { ok: true, startId, phase: dernier.phase, attenteMs: Date.now() - debut };
    }
    if (Date.now() - debut >= delaiMs) return { ok: false, startId, phase: dernier?.phase ?? null, attenteMs: Date.now() - debut };
    await new Promise((res) => setTimeout(res, pasMs));
  }
}

/**
 * Sonde lancée DANS la salle (en tant que `node`) : empreinte SHA-256 de chaque fichier des racines données, chemins relatifs,
 * profondeur 12 au plus, liens relevés comme liens (jamais suivis). Rend `{racine: {chemin: "f:<sha256>" | "l:<cible>" |
 * "d" | "erreur:<code>"}}`. Un dossier illisible est dit, pas sauté : une empreinte qui ne voit pas tout ne prouve rien.
 */
export const SONDE_EMPREINTES = `
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const racines = JSON.parse(process.argv[1]);
const exclus = JSON.parse(process.argv[2]).map((m) => new RegExp(m));
const out = {};
const parcourir = (racine, dossier, profondeur, table) => {
  if (profondeur > 12) { table[path.relative(racine, dossier) + "/"] = "trop-profond"; return; }
  let entrees;
  try { entrees = fs.readdirSync(dossier, { withFileTypes: true }); } catch (e) { table[path.relative(racine, dossier) + "/"] = "erreur:" + e.code; return; }
  for (const e of entrees) {
    const complet = path.join(dossier, e.name);
    const rel = path.relative(racine, complet);
    if (exclus.some((m) => m.test(rel))) continue;
    try {
      const st = fs.lstatSync(complet);
      if (st.isSymbolicLink()) table[rel] = "l:" + fs.readlinkSync(complet);
      else if (st.isDirectory()) { table[rel + "/"] = "d"; parcourir(racine, complet, profondeur + 1, table); }
      else if (st.isFile()) table[rel] = "f:" + crypto.createHash("sha256").update(fs.readFileSync(complet)).digest("hex");
      else table[rel] = "autre";
    } catch (err) { table[rel] = "erreur:" + err.code; }
  }
};
for (const r of racines) { const table = {}; if (fs.existsSync(r)) parcourir(r, r, 0, table); else table["."] = "absent"; out[r] = table; }
process.stdout.write(JSON.stringify(out));
`;

/**
 * Empreintes des dossiers de configuration de la salle et de ses données hors `opencode.db*` et `storage/`, relevées dans le
 * conteneur par `ctx.exec` (en tant que `node`). Rend `{ ok, empreintes, erreur }`.
 */
export async function empreintes(ctx, { racines = [...DOSSIERS_CONFIGURATION, DONNEES_SALLE] } = {}) {
  const exclus = HORS_EMPREINTE.map((m) => m.source);
  // Les exclusions ne valent que pour les données de la salle : elles sont appliquées aux chemins RELATIFS de chaque racine,
  // et aucun fichier des dossiers de configuration ne commence par « opencode.db » ni « storage/ » (relevé M27).
  const r = await ctx.exec("opencode-omo", ["node", "-e", SONDE_EMPREINTES, JSON.stringify(racines), JSON.stringify(exclus)], { delaiMs: 120_000 });
  try {
    return { ok: r.code === 0, empreintes: JSON.parse(String(r.sortie).trim()), erreur: r.code === 0 ? null : String(r.erreur).slice(0, 300) };
  } catch {
    return { ok: false, empreintes: null, erreur: `sortie illisible (code ${r.code})` };
  }
}

/** Écart entre deux relevés d'empreintes : chemins ajoutés, retirés, modifiés, par racine. Vide : identiques. */
export function comparerEmpreintes(avant, apres) {
  const ecarts = [];
  for (const racine of new Set([...Object.keys(avant ?? {}), ...Object.keys(apres ?? {})])) {
    const a = avant?.[racine] ?? {};
    const b = apres?.[racine] ?? {};
    for (const chemin of new Set([...Object.keys(a), ...Object.keys(b)])) {
      if (!(chemin in a)) ecarts.push({ racine, chemin, ecart: "ajoute" });
      else if (!(chemin in b)) ecarts.push({ racine, chemin, ecart: "retire" });
      else if (a[chemin] !== b[chemin]) ecarts.push({ racine, chemin, ecart: "modifie" });
    }
  }
  return ecarts;
}
