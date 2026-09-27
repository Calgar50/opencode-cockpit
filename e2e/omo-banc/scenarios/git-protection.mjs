// Porte « git » — ce que la topologie des montages protège VRAIMENT sur cet hôte (D-2b-28 ; L16c, décision A16, option E1 ;
// risque 11 / C2-5). Rejouée RÉELLEMENT au train de V3 de la 2 ter (L21b anticipé pour cette porte).
//
// Avant L16c, chaque `.git` était monté `:ro` SOUS un projet ouvert en écriture : sur le partage insensible à la casse de Docker
// Desktop Windows, `.GIT`, `GIT~1` (alias de la FEUILLE) et `/workspace/PROJET/.git` (alias du PARENT) contournaient ce montage
// — 10 alias inscriptibles mesurés, crochet `pre-commit` posable. Depuis L16c, le dossier de travail ENTIER est en lecture seule
// et l'écriture n'est rouverte que par exception, une entrée de premier niveau de projet à la fois, jamais `.git` : un alias,
// quel qu'il soit, est résolu sous l'ancêtre en lecture seule et répond EROFS.
//
// Cette porte ne suppose rien : elle mesure depuis la salle, en tant que `node`, les huit familles de l'essai E1, puis vérifie
// côté POSTE ce qui a été réellement écrit, et dit ce que le superviseur en a conclu :
//   1. les montages lus dans /proc/self/mountinfo : `/workspace` en `ro`, et rien en écriture hors des entrées attendues ;
//   2. alias de la FEUILLE (casses et nom court de `.git`) et alias du PARENT (casses et nom court du projet) : 0 inscriptible,
//      0 crochet posable ;
//   3. écriture LÉGITIME (fichier neuf, dossier profond, fichier ouvert écrit en place) persistée sur le poste ;
//   4. refus francs attendus (EROFS) : racine d'un projet et du dossier de travail (friction A16 point 6), parent ou feuille
//      aliasés d'une entrée ouverte, remontée `..` depuis une entrée ouverte, écriture à travers un lien symbolique vers `.git` ;
//   5. liens durs refusés par EXDEV, y compris entre deux entrées ouvertes (chaque montage a son superbloc) ;
//   6. dépôts intacts côté poste (empreintes de chaque fichier de `.git` avant et après), aucun `.omo` créé (A16 point 2) ;
//   7. le superviseur voit le même verdict, et la salle démarre quand rien n'est ouvert.
// Elle est SANS OBJET quand le banc tourne en `--sans-git` (aucun dépôt à protéger).
//
// Ce qu'elle écrit : seulement dans les projets JETABLES du banc, sous `/workspace` (garde dans la sonde), des témoins nommés
// `temoin-banc-*` ; les écritures légitimes sont retirées et le fichier écrit en place est rétabli à la fin, vérifié côté poste.
// Une écriture qui passerait là où elle devait être refusée reste en place, dans le dépôt jetable : c'est la preuve du constat.
import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

/** Projet ouvert par le banc : c'est lui, et lui seul, qui reçoit les écritures légitimes (le témoin M31 n'est jamais écrit). */
export const PROJET_ECRIT = "projet-ouvert";

/** Noms de `.git` sondés : casses et noms courts 8.3, la liste `aliasDeNom` du superviseur. */
export const FEUILLES = [".git", ".GIT", ".Git", ".gIt", "GIT~1", "git~1"];

/** Préfixe de tout ce que la sonde écrit : ce qu'on trouve ensuite sur le poste sous ce nom vient d'elle. */
export const TEMOIN = "temoin-banc-";

/**
 * Sonde jouée en tant que `node` dans la salle. `process.argv[1]` : jeton de cette passe (écrit dans les fichiers légitimes,
 * relu côté poste). Aucune écriture hors de `/workspace/` : `creer` et `ouvrir` le refusent d'eux-mêmes. Primitives de
 * `fs` seulement (`accessSync(W_OK)`, `lstatSync`) : le `test -w` de busybox ment sur un montage en lecture seule.
 */
export const SONDE_E1 = `
const fs = require("node:fs");
const jeton = String(process.argv[1] || "");
const code = (err) => (err && err.code) || String(err);
const DANS = (chemin) => chemin.startsWith("/workspace/");
const creer = (chemin, contenu) => {
  if (!DANS(chemin)) return "refuse-hors-workspace";
  try { fs.writeFileSync(chemin, contenu); return "acceptee"; } catch (err) { return code(err); }
};
const ouvrir = (chemin) => {
  if (!DANS(chemin)) return "refuse-hors-workspace";
  try { fs.closeSync(fs.openSync(chemin, "r+")); return "acceptee"; } catch (err) { return code(err); }
};
const lier = (de, vers) => {
  if (!DANS(de) || !DANS(vers)) return "refuse-hors-workspace";
  try { fs.linkSync(de, vers); return "acceptee"; } catch (err) { return code(err); }
};
const acces = (chemin) => { try { fs.accessSync(chemin, fs.constants.W_OK); return true; } catch { return false; } };
const existe = (chemin) => { try { return fs.lstatSync(chemin).isDirectory() ? "dossier" : "autre"; } catch (err) { return code(err); } };
const sonder = (chemin) => {
  const e = { existe: existe(chemin) };
  if (e.existe === "dossier") {
    e.inscriptible = acces(chemin);
    e.ecriture = creer(chemin + "/temoin-banc-alias", "x");
    e.crochet = creer(chemin + "/hooks/temoin-banc-pre-commit", "x");
  }
  return e;
};
const out = { montages: [], alias: {}, parents: {}, legitimes: {}, refus: {}, liensDurs: {}, liensSymboliques: {} };
try {
  for (const ligne of fs.readFileSync("/proc/self/mountinfo", "utf8").split("\\n")) {
    const c = ligne.split(" ");
    if (c.length < 6) continue;
    const point = c[4].replace(/\\\\([0-7]{3})/g, (_, o) => String.fromCharCode(parseInt(o, 8)));
    if (point === "/workspace" || point.startsWith("/workspace/")) out.montages.push({ point, ro: c[5].split(",").includes("ro") });
  }
} catch (err) { out.montagesErreur = code(err); }
const projets = fs.readdirSync("/workspace").sort();
for (const projet of projets) {
  out.alias[projet] = {};
  for (const nom of [".git", ".GIT", ".Git", ".gIt", "GIT~1", "git~1"]) out.alias[projet][nom] = sonder("/workspace/" + projet + "/" + nom);
  const court = projet.replace(/[^A-Za-z0-9]/g, "").slice(0, 6).toUpperCase();
  const variantes = new Set([projet.toUpperCase(), projet.charAt(0).toUpperCase() + projet.slice(1), court + "~1", court + "~2", court + "~3"]);
  variantes.delete(projet);
  out.parents[projet] = {};
  for (const v of variantes) for (const nom of [".git", ".GIT", "GIT~1"]) out.parents[projet][v + "/" + nom] = sonder("/workspace/" + v + "/" + nom);
}
const P = "/workspace/projet-ouvert";
const A = "/workspace/PROJET-OUVERT";
if (existe(P + "/src") === "dossier") {
  out.legitimes.fichierNeuf = creer(P + "/src/temoin-banc-legitime.txt", "banc " + jeton + "\\n");
  try {
    fs.mkdirSync(P + "/src/temoin-banc-sous/dossier", { recursive: true });
    out.legitimes.dossierProfond = creer(P + "/src/temoin-banc-sous/dossier/profond.txt", "profond " + jeton + "\\n");
  } catch (err) { out.legitimes.dossierProfond = code(err); }
  try { fs.appendFileSync(P + "/LISEZMOI.md", "temoin en place " + jeton + "\\n"); out.legitimes.fichierEnPlace = "acceptee"; } catch (err) { out.legitimes.fichierEnPlace = code(err); }
  const mkdir = (chemin) => { if (!DANS(chemin)) return "refuse-hors-workspace"; try { fs.mkdirSync(chemin); return "acceptee"; } catch (err) { return code(err); } };
  out.refus = {
    "racine du dossier de travail": creer("/workspace/temoin-banc-racine.txt", "x"),
    "fichier neuf a la racine du projet": creer(P + "/temoin-banc-racine.txt", "x"),
    "dossier neuf a la racine du projet": mkdir(P + "/temoin-banc-dossier"),
    "fichier existant de .git ouvert en ecriture": ouvrir(P + "/.git/config"),
    "entree ouverte sous un parent aliase (PROJET-OUVERT/src)": creer(A + "/src/temoin-banc-alias.txt", "x"),
    "entree ouverte sous son nom aliase (projet-ouvert/SRC)": creer(P + "/SRC/temoin-banc-alias.txt", "x"),
    "fichier ouvert sous un parent aliase (PROJET-OUVERT/notes.txt)": ouvrir(A + "/notes.txt"),
    "remontee .. vers .git/hooks": creer(P + "/src/../.git/hooks/temoin-banc-remontee", "x"),
    "remontee .. vers la racine du projet": creer(P + "/src/../temoin-banc-remontee.txt", "x"),
    "remontee .. vers le dossier de travail": creer(P + "/src/../../temoin-banc-remontee.txt", "x"),
    "remontee .. vers le .git d'un parent aliase": ouvrir(P + "/src/../../PROJET-OUVERT/.git/config"),
  };
  try { fs.symlinkSync("../.git/hooks", P + "/src/temoin-banc-lien-git"); out.liensSymboliques.cree = "acceptee"; } catch (err) { out.liensSymboliques.cree = code(err); }
  out.liensSymboliques.ecritureAtravers = creer(P + "/src/temoin-banc-lien-git/temoin-banc-pre-commit", "x");
  out.liensDurs = {
    ".git/config vers une entree ouverte": lier(P + "/.git/config", P + "/src/temoin-banc-lien-dur-config"),
    ".git/HEAD vers une entree ouverte": lier(P + "/.git/HEAD", P + "/src/temoin-banc-lien-dur-head"),
    "entre deux entrees ouvertes (src vers docs)": lier(P + "/src/app.js", P + "/docs/temoin-banc-lien-dur-app.js"),
    "fichier ouvert vers une entree ouverte (notes.txt vers src)": lier(P + "/notes.txt", P + "/src/temoin-banc-lien-dur-notes"),
  };
} else {
  out.legitimes = null;
}
process.stdout.write(JSON.stringify(out));
`;

/**
 * Nettoyage, joué en tant que `node` dans la salle : retire ce que la sonde a légitimement posé dans l'entrée ouverte `src`, et
 * rétablit en place le fichier ouvert (`process.argv[1]` : son contenu d'origine, en base64, lu côté poste avant la sonde).
 * Les liens symboliques se retirent d'ici (`unlink` Linux) : côté Windows, un lien de dossier ne s'efface pas comme un fichier.
 */
export const NETTOYAGE_E1 = `
const fs = require("node:fs");
const P = "/workspace/projet-ouvert";
const out = {};
const essai = (nom, f) => { try { f(); out[nom] = "ok"; } catch (err) { out[nom] = (err && err.code) || String(err); } };
essai("lien", () => fs.unlinkSync(P + "/src/temoin-banc-lien-git"));
essai("fichier", () => fs.rmSync(P + "/src/temoin-banc-legitime.txt", { force: true }));
essai("dossier", () => fs.rmSync(P + "/src/temoin-banc-sous", { recursive: true, force: true }));
if (process.argv[1]) essai("enPlace", () => fs.writeFileSync(P + "/LISEZMOI.md", Buffer.from(String(process.argv[1]), "base64")));
process.stdout.write(JSON.stringify(out));
`;

/** Témoins que la sonde a le DROIT de laisser sur le poste (écritures légitimes) jusqu'au nettoyage. */
const LEGITIMES = new Set([`src/${TEMOIN}legitime.txt`, `src/${TEMOIN}sous`, `src/${TEMOIN}sous/dossier`, `src/${TEMOIN}sous/dossier/profond.txt`, `src/${TEMOIN}lien-git`]);

/** Parcours d'un dossier du poste, sans jamais suivre un lien ; chemins relatifs à `racine`, séparateurs `/`. */
function parcourirHote(racine) {
  const vus = [];
  const pile = [""];
  while (pile.length > 0) {
    const relatif = pile.pop();
    let entrees;
    try {
      entrees = fs.readdirSync(path.join(racine, relatif), { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entree of entrees) {
      const chemin = relatif === "" ? entree.name : `${relatif}/${entree.name}`;
      vus.push({ chemin, dossier: entree.isDirectory() && !entree.isSymbolicLink(), lien: entree.isSymbolicLink() });
      if (entree.isDirectory() && !entree.isSymbolicLink()) pile.push(chemin);
    }
  }
  return vus;
}

/** Empreinte de chaque fichier de `<projet>/.git`, côté poste : un dépôt intact garde exactement les mêmes. */
function empreintesDepot(ws, projet) {
  const depot = path.join(ws, projet, ".git");
  const empreintes = {};
  for (const e of parcourirHote(depot)) {
    if (e.dossier || e.lien) {
      if (e.lien) empreintes[e.chemin] = "lien";
      continue;
    }
    try {
      empreintes[e.chemin] = createHash("sha256").update(fs.readFileSync(path.join(depot, e.chemin))).digest("hex");
    } catch (err) {
      empreintes[e.chemin] = `illisible:${err?.code ?? err}`;
    }
  }
  return empreintes;
}

const refuse = (valeur) => valeur !== "acceptee";

export default {
  id: "git",
  titre: "Protection des dépôts : dossier de travail en lecture seule, écriture par exception (L16c, E1)",
  async executer(ctx) {
    const points = [];
    const mesures = {};
    const ajouter = (nom, ok, detail) => points.push({ nom, ok: Boolean(ok), detail });

    let amorce = null;
    try {
      amorce = JSON.parse(ctx.sortie("projets-amorce.json") ?? "null");
    } catch {
      amorce = null;
    }
    const proteges = Number(amorce?.gitProteges ?? 0);
    if (proteges === 0) {
      return { sansObjet: "aucun dépôt dans les projets préparés (banc dégradé --sans-git) : rien à protéger, rien à mesurer" };
    }

    const ws = ctx.chemins?.ws ?? null;
    if (ws === null) {
      ajouter("le dossier de travail du banc est connu côté poste", false, "ctx.chemins.ws absent : rien ne peut être vérifié côté poste");
      return { points, mesures };
    }
    const projetsHote = fs
      .readdirSync(ws, { withFileTypes: true })
      .filter((e) => e.isDirectory() && !e.isSymbolicLink())
      .map((e) => e.name)
      .sort();
    const avant = Object.fromEntries(projetsHote.map((p) => [p, empreintesDepot(ws, p)]));
    const fichierEnPlace = path.join(ws, PROJET_ECRIT, "LISEZMOI.md");
    const origineEnPlace = fs.existsSync(fichierEnPlace) ? fs.readFileSync(fichierEnPlace) : null;
    const jeton = randomBytes(8).toString("hex");

    // --- 1. Ce que la salle peut faire, vecteur par vecteur ------------------------------------------------------------------
    let vue = null;
    const r = await ctx.exec("opencode-omo", ["node", "-e", SONDE_E1, jeton], { delaiMs: 120_000 });
    try {
      vue = JSON.parse(String(r.sortie).trim());
    } catch {
      vue = null;
    }
    ctx.ecrireSortie("git-sonde.json", `${JSON.stringify(vue, null, 2)}\n`);
    mesures.gitAlias = vue?.alias ?? null;
    if (!vue || typeof vue.alias !== "object" || vue.alias === null) {
      ajouter("la sonde de la salle répond", false, `code ${r.code} — ${String(r.erreur ?? r.sortie).slice(0, 200)}`);
      return { points, mesures };
    }

    // 1.a Montages : la racine en lecture seule, et l'écriture seulement là où install.ps1 l'a ouverte.
    const montages = Array.isArray(vue.montages) ? vue.montages : [];
    const racines = montages.filter((m) => m.point === "/workspace");
    const attendus = projetsHote
      .flatMap((p) =>
        fs
          .readdirSync(path.join(ws, p))
          .filter((nom) => nom.toLowerCase().replace(/[. ]+$/, "") !== ".git" && !/^git~\d+$/i.test(nom) && nom.toLowerCase() !== ".omo")
          .map((nom) => `/workspace/${p}/${nom}`),
      )
      .sort();
    const ecritures = montages.filter((m) => m.point !== "/workspace" && !m.ro).map((m) => m.point).sort();
    const enTrop = ecritures.filter((p) => !attendus.includes(p));
    const manquants = attendus.filter((p) => !ecritures.includes(p));
    mesures.gitMontages = { racine: racines, ecritures, attendus, enTrop, manquants, erreur: vue.montagesErreur ?? null };
    ajouter(
      "`/workspace` est monté en LECTURE SEULE (option ro de chacune de ses lignes de mountinfo)",
      racines.length > 0 && racines.every((m) => m.ro === true),
      racines.length === 0 ? `aucune ligne /workspace dans mountinfo (${vue.montagesErreur ?? "lue"})` : JSON.stringify(racines),
    );
    ajouter(
      "l'écriture n'est rouverte que sur les entrées de premier niveau des projets, jamais sur .git ni sur la racine d'un projet",
      enTrop.length === 0 && manquants.length === 0 && ecritures.length > 0,
      `${ecritures.length} montage(s) en écriture ; en trop : ${enTrop.join(", ") || "aucun"} ; manquants : ${manquants.join(", ") || "aucun"}`,
    );

    // 1.b Alias de la FEUILLE et du PARENT : un alias qui écrit est un dépôt de l'utilisateur ouvert à l'IA.
    const projets = Object.entries(vue.alias);
    const cheminExact = projets.filter(([, e]) => e[".git"]?.existe === "dossier" && e[".git"]?.ecriture !== "acceptee");
    ajouter(
      "le chemin exact `.git` est bien en lecture seule",
      projets.length > 0 && cheminExact.length === projets.length,
      projets.map(([p, e]) => `${p}=${e[".git"]?.ecriture ?? e[".git"]?.existe}`).join(", "),
    );
    const ouverts = [];
    const crochets = [];
    for (const [projet, entrees] of projets) {
      for (const [nom, e] of Object.entries(entrees)) {
        if (e.ecriture === "acceptee" || e.inscriptible === true) ouverts.push(`${projet}/${nom}`);
        if (e.crochet === "acceptee") crochets.push(`${projet}/${nom}/hooks`);
      }
    }
    const parentsOuverts = [];
    let parentsSondes = 0;
    for (const [, entrees] of Object.entries(vue.parents ?? {})) {
      for (const [chemin, e] of Object.entries(entrees)) {
        if (e.existe === "dossier") parentsSondes++;
        if (e.ecriture === "acceptee" || e.inscriptible === true) parentsOuverts.push(chemin);
        if (e.crochet === "acceptee") crochets.push(`${chemin}/hooks`);
      }
    }
    mesures.gitAliasOuverts = ouverts;
    mesures.gitParentsOuverts = parentsOuverts;
    mesures.gitParentsSondes = parentsSondes;
    mesures.gitCrochetsPosables = crochets;
    ajouter("aucun alias de casse ou nom court n'écrit dans le dépôt (vecteur de la FEUILLE)", ouverts.length === 0, ouverts.length === 0 ? "aucun" : `alias inscriptibles : ${ouverts.join(", ")}`);
    ajouter(
      "aucun alias du dossier PARENT n'écrit dans le dépôt (/workspace/PROJET/.git, essai 1 bis)",
      parentsOuverts.length === 0 && parentsSondes > 0,
      parentsSondes === 0 ? "aucun alias de parent n'existe : le vecteur n'a pas été exercé" : parentsOuverts.length === 0 ? `${parentsSondes} chemin(s) aliasé(s) sondés, aucun inscriptible` : `inscriptibles : ${parentsOuverts.join(", ")}`,
    );
    ajouter(
      "aucun crochet git ne peut être posé depuis la salle",
      crochets.length === 0,
      crochets.length === 0 ? "aucun" : `crochets posables (exécutés sur le poste au prochain commit) : ${crochets.join(", ")}`,
    );

    // 1.c Écritures légitimes, refus francs, liens durs, lien symbolique.
    const legitimes = vue.legitimes ?? null;
    const refus = Object.entries(vue.refus ?? {});
    const liensDurs = Object.entries(vue.liensDurs ?? {});
    mesures.gitEcrituresLegitimes = legitimes;
    mesures.gitRefus = Object.fromEntries(refus);
    mesures.gitLiensDurs = Object.fromEntries(liensDurs);
    mesures.gitLiensSymboliques = vue.liensSymboliques ?? null;
    const passes = refus.filter(([, v]) => v === "acceptee").map(([n]) => n);
    const pasEROFS = refus.filter(([, v]) => v !== "EROFS" && v !== "acceptee").map(([n, v]) => `${n}=${v}`);
    ajouter(
      "racine d'un projet, dossier de travail, alias d'une entrée ouverte et remontée `..` : refus francs (EROFS)",
      refus.length >= 11 && passes.length === 0 && pasEROFS.length === 0,
      passes.length > 0 ? `ACCEPTÉS : ${passes.join(", ")}` : pasEROFS.length > 0 ? `refus d'une autre nature : ${pasEROFS.join(", ")}` : `${refus.length}/${refus.length} EROFS`,
    );
    const liensAcceptes = liensDurs.filter(([, v]) => v !== "EXDEV");
    ajouter(
      "liens durs refusés par EXDEV, y compris entre deux entrées ouvertes",
      liensDurs.length >= 4 && liensAcceptes.length === 0,
      liensAcceptes.length === 0 ? `${liensDurs.length}/${liensDurs.length} EXDEV` : liensAcceptes.map(([n, v]) => `${n}=${v}`).join(", "),
    );
    const symb = vue.liensSymboliques ?? {};
    ajouter(
      "écriture à travers un lien symbolique posé vers .git/hooks : refusée (EROFS), le lien lui-même étant permis et signalé",
      symb.ecritureAtravers === "EROFS",
      `lien : ${symb.cree ?? "non tenté"} ; écriture à travers : ${symb.ecritureAtravers ?? "non tentée"}`,
    );

    // --- 2. Ce que le poste a réellement reçu ---------------------------------------------------------------------------------
    const lire = (relatif) => {
      try {
        return fs.readFileSync(path.join(ws, PROJET_ECRIT, ...relatif.split("/")), "utf8");
      } catch {
        return null;
      }
    };
    const recus = {
      fichierNeuf: lire(`src/${TEMOIN}legitime.txt`) === `banc ${jeton}\n`,
      dossierProfond: lire(`src/${TEMOIN}sous/dossier/profond.txt`) === `profond ${jeton}\n`,
      fichierEnPlace: (lire("LISEZMOI.md") ?? "").endsWith(`temoin en place ${jeton}\n`),
    };
    mesures.gitEcrituresPersistees = recus;
    ajouter(
      "écriture LÉGITIME persistée sur le poste (fichier neuf, dossier profond, fichier ouvert écrit en place)",
      legitimes !== null && Object.values(legitimes).every((v) => v === "acceptee") && Object.values(recus).every(Boolean),
      `salle : ${JSON.stringify(legitimes)} ; poste : ${JSON.stringify(recus)}`,
    );
    // Tout témoin trouvé sur le poste hors des écritures légitimes est une écriture qui devait être refusée.
    const fuites = [];
    for (const p of projetsHote) {
      for (const e of parcourirHote(path.join(ws, p))) {
        const nom = e.chemin.slice(e.chemin.lastIndexOf("/") + 1);
        if (!nom.startsWith(TEMOIN)) continue;
        if (p === PROJET_ECRIT && LEGITIMES.has(e.chemin)) continue;
        fuites.push(`${p}/${e.chemin}`);
      }
    }
    for (const e of fs.readdirSync(ws)) if (e.startsWith(TEMOIN)) fuites.push(e);
    const apres = Object.fromEntries(projetsHote.map((p) => [p, empreintesDepot(ws, p)]));
    const changes = projetsHote.filter((p) => JSON.stringify(avant[p]) !== JSON.stringify(apres[p]));
    const avecOmo = projetsHote.filter((p) => fs.readdirSync(path.join(ws, p)).some((nom) => nom.toLowerCase() === ".omo"));
    mesures.gitPoste = { fuites, depotsChanges: changes, dossierOmo: avecOmo, fichiersDepots: Object.fromEntries(projetsHote.map((p) => [p, Object.keys(avant[p]).length])) };
    ajouter("aucun témoin n'est arrivé sur le poste là où la salle devait être refusée", fuites.length === 0, fuites.length === 0 ? "aucun" : fuites.join(", "));
    ajouter(
      "dépôts intacts côté poste : chaque fichier de .git a la même empreinte avant et après",
      changes.length === 0 && projetsHote.every((p) => Object.keys(avant[p]).length > 0),
      changes.length === 0 ? projetsHote.map((p) => `${p} : ${Object.keys(avant[p]).length} fichiers`).join(", ") : `modifiés : ${changes.join(", ")}`,
    );
    ajouter("aucun dossier .omo créé dans les projets (A16 point 2)", avecOmo.length === 0, avecOmo.join(", ") || "aucun");

    // --- 3. Nettoyage : ce que la sonde a légitimement posé repart, le fichier écrit en place est rétabli ---------------------
    const n = await ctx.exec("opencode-omo", ["node", "-e", NETTOYAGE_E1, origineEnPlace === null ? "" : origineEnPlace.toString("base64")], { delaiMs: 60_000 });
    let nettoye = null;
    try {
      nettoye = JSON.parse(String(n.sortie).trim());
    } catch {
      nettoye = null;
    }
    const restes = parcourirHote(path.join(ws, PROJET_ECRIT)).filter((e) => LEGITIMES.has(e.chemin)).map((e) => e.chemin);
    const retabli = origineEnPlace === null || (fs.existsSync(fichierEnPlace) && fs.readFileSync(fichierEnPlace).equals(origineEnPlace));
    mesures.gitNettoyage = { salle: nettoye, restes, retabli };
    ajouter("le banc repart propre : écritures légitimes retirées, fichier écrit en place rétabli à l'octet", restes.length === 0 && retabli, `restes : ${restes.join(", ") || "aucun"} ; rétabli : ${retabli}`);

    // --- 4. Ce que le superviseur en conclut ------------------------------------------------------------------------------
    // Fermé en cas de doute : un dépôt douteux doit fermer la salle. Sans doute, la salle démarre : c'est tout l'objet d'E1.
    const etat = (await ctx.etat()) ?? {};
    const nonProteges = etat.workspaceGit?.nonProteges ?? [];
    const projetsEtat = etat.projets ?? [];
    mesures.gitVerdict = { phase: etat.phase ?? null, nonProteges, projets: projetsEtat };
    const doute = ouverts.length > 0 || parentsOuverts.length > 0 || crochets.length > 0 || enTrop.length > 0 || !racines.every((m) => m.ro === true) || racines.length === 0;
    ajouter(
      "le superviseur voit le même doute que la sonde",
      doute ? nonProteges.length > 0 : nonProteges.length === 0 && projetsEtat.every((p) => p.gitLectureSeule === true),
      `nonProteges = ${JSON.stringify(nonProteges)} ; projets = ${JSON.stringify(projetsEtat)}`,
    );
    ajouter(
      doute ? "un dépôt douteux ferme la salle (aucun opencode lancé)" : "rien n'est ouvert : la salle démarre (opencode lancé), dépôts compris",
      doute ? etat.phase !== "opencode-lance" : etat.phase === "opencode-lance",
      `phase = ${etat.phase ?? "illisible"}`,
    );

    return { points, mesures };
  },
};
