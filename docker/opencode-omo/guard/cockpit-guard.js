// Plugin de garde de la Salle OMO (L24, spéc. §7.6 l.1157, §4.2 l.612, R11) : un FILET sous les outils de l'IA, jamais une
// frontière. Le crochet `tool.execute.before` d'opencode 1.18.30 est appelé avant chaque outil ; ce qu'il refuse devient une
// erreur d'outil, que l'IA lit et que le cockpit affiche. Ce qui ne passe pas par un outil (un programme lancé par une commande,
// l'extension elle-même) ne le traverse jamais : les vraies barrières restent la configuration de l'instance, le réseau fermé, les
// montages en lecture seule, le portillon du cockpit et ses détections. Le crochet est à revérifier à chaque version d'opencode.
//
// Ce qu'il refuse :
// - lecture et écriture des fichiers de clés et des `.env*` (sauf `.env.example`), pour tout outil qui porte un chemin (read,
//   write, edit, apply_patch, glob, list, lsp… reconnus par le NOM de l'argument, pour couvrir aussi les outils d'une
//   extension), y compris quand un lien du projet y mène, et quand le motif d'un glob ou d'un `include` ne vise que de tels
//   fichiers ;
// - tout chemin hors du projet ouvert (décision M3 du 19/09 : `external_directory`, que l'extension remet à `allow`), sauf la
//   lecture des sorties longues qu'opencode range dans son dossier `tool-output` ; un chemin absolu qui porte « . » ou « .. », un
//   lien pendant ou un chemin réel introuvable valent « doute » (refusés) ;
// - `grep`, en toutes circonstances : opencode 1.18.30 n'applique ses règles qu'à l'expression cherchée, jamais aux fichiers lus,
//   et ripgrep lit tout fichier que git n'ignore pas (`.env` et clés compris) ; refusé aussi par `opencode.jsonc` ;
// - `webfetch`, `websearch` et les outils des MCP réseau de la 4.19.4 (décision M3 : l'extension les remet à `allow`) ;
// - les outils que l'audit L20 range en « couper » (`OUTILS_COUPES`, plus les MCP `codegraph` et `lsp`) : `omo.jsonc` les
//   énumère dans `disabled_tools`, mais cette couche-là n'est PAS appliquée par la 4.19.4 dans la salle (mesuré deux fois,
//   voir plus bas) ; le filet porte donc la coupure lui-même ;
// - `task` et `call_omo_agent` quand l'état de garde les bloque (plafond de délégations tenu par le cockpit).
//
// Couche utilisateur d'`omo.jsonc` : INERTE. Mesuré par le banc hors ligne (porte G2 : `GET /command` rend encore `goal` et
// `stop-continuation`, que `disabled_commands` déclare coupées), une première fois au rapport L21 §4.2, puis une seconde fois à
// la répétition générale de la 2 bis, `CLAUDE_CONFIG_DIR` posé — ce correctif-là n'y change rien. Tout ce que la salle ne coupe
// que dans `omo.jsonc` est donc sans effet : `disabled_hooks`, `disabled_commands`, `disabled_tools`, `goal.enabled: false`,
// `claude_code.hooks: false`. Ce qui tient vraiment : la configuration d'instance (`/etc/opencode-omo/opencode.jsonc`, la seule
// couche appliquée), les variables de l'image, le réseau fermé, les montages en lecture seule, ce filet, et côté cockpit les
// plafonds de coût, de durée et de sessions, les détections et l'arrêt de la salle (décision 7 du 19/09).
//
// État de garde (question Q2, variante (a), décision du 17/09) : `/control/guard-state.json`, écrit par le cockpit seul dans le
// volume `control-omo`, monté en lecture seule dans la salle. Aucun secret, aucun appel au cockpit. Lu borné à 4 Kio, sans suivre
// de lien. Absent : aucun blocage. Illisible, invalide ou trop gros : `task` et `call_omo_agent` refusés (fermé en cas de doute).
// Même format que `analyserGuardState` (app/server/shared/omo-control-protocol.ts), vecteurs communs vérifiés par un test.
//
// Format de module : un plugin « v1 » d'opencode (export par défaut `{ id, server }`). opencode n'appelle alors que `server` ; les
// exports nommés ne servent qu'aux tests du cockpit. AUCUNE dépendance (ni `@opencode-ai/plugin`, ni rien d'autre) : ce fichier est
// copié dans l'image en `/opt/omo-guard/cockpit-guard.js`, dans le périmètre du manifeste (D-2b-32), lisible sans rien installer.
import fs from "node:fs";
import os from "node:os";
import { posix } from "node:path";

// --- Identité et chemins (contrat `contrat-salle.json`) -------------------------------------------------------------------------

/** Identifiant du plugin : exigé par opencode pour un plugin chargé depuis un chemin (`file://`). */
export const ID_PLUGIN = "cockpit-guard";

/** Volume `control-omo` monté sur `/control` dans la salle, fichier `guard-state.json` (fichiersControle.garde). */
export const CHEMIN_ETAT_GARDE = "/control/guard-state.json";

/** 4 Kio : au-delà, l'état de garde vaut « invalide » (le format tient en moins de 100 octets). */
export const ETAT_GARDE_MAX_OCTETS = 4096;

// --- Outils ---------------------------------------------------------------------------------------------------------------------

/** Outils de délégation (OMO_GUARD_TOOLS du protocole) : refusés quand l'état de garde les bloque, ou s'il est illisible. */
export const OUTILS_DELEGATION = Object.freeze(["task", "call_omo_agent"]);

/** Outils réseau d'opencode : toujours refusés dans la salle (décision M3). */
export const OUTILS_RESEAU = Object.freeze(["webfetch", "websearch"]);

/** Outils des MCP réseau de la 4.19.4 (`websearch`, `context7`, `grep_app`), nommés « <serveur>_<outil> » par opencode. */
export const PREFIXES_RESEAU = Object.freeze(["websearch_", "context7_", "grep_app_"]);

/**
 * Recherche dans le CONTENU des fichiers : toujours refusée dans la salle. grep.ts d'opencode 1.18.30 ne soumet aux règles que
 * l'expression cherchée (`patterns: [params.pattern]`), et ripgrep (`--hidden`, sans `--no-ignore`) lit tout fichier que git
 * n'ignore pas : un `.env` commité, ou tout `.env` d'un projet sans `.git`, partirait dans la conversation.
 */
export const OUTILS_RECHERCHE = Object.freeze(["grep"]);

/**
 * Outils coupés par l'audit L20 : `omo.jsonc` les énumère dans `disabled_tools`, sans effet (couche utilisateur inerte, en-tête).
 * Le filet les refuse donc lui-même, nom par nom, sans joker (R1). Égalité avec `OUTILS_A_COUPER`
 * (app/server/shared/omo-audit-4.19.4.ts) vérifiée par un test, aux deux écarts dits et voulus :
 * - `grep` est déjà refusé plus haut, dans sa propre catégorie ;
 * - `glob` reste permis : la configuration d'instance, elle, est appliquée, et elle le borne motif par motif ; le refuser
 *   ici retirerait à l'IA tout moyen de retrouver un fichier, et son installation automatique de ripgrep ne peut de toute
 *   façon pas aboutir (réseau fermé, `/opt` en lecture seule, aucun npm à l'exécution, relevé par la porte G2).
 * Un outil de cette liste peut n'être même pas enregistré par l'extension (il dépend d'un réglage) : le refuser n'a alors
 * aucun effet, et c'est bien ainsi — le filet ne suppose pas de quel côté le réglage est tombé.
 */
export const OUTILS_COUPES = Object.freeze([
  "session_list",
  "session_read",
  "session_search",
  "session_info",
  "look_at",
  "skill_mcp",
  "create_goal",
  "update_goal",
  "get_goal",
  "interactive_bash",
  "team_create",
  "team_delete",
  "team_shutdown_request",
  "team_approve_shutdown",
  "team_reject_shutdown",
  "team_send_message",
  "team_task_create",
  "team_task_list",
  "team_task_update",
  "team_task_get",
  "team_status",
  "team_list",
  "monitor_start",
  "monitor_stop",
  "monitor_list",
  "monitor_output",
  "task_create",
  "task_get",
  "task_list",
  "task_update",
]);

/**
 * Outils des deux MCP intégrés qui ne sortent pas sur le réseau mais que `disabled_mcps` coupe aussi sans effet : `codegraph`
 * (indexation, provisionnement, service permanent) et `lsp`. Nommés « <serveur>_<outil> » par opencode, comme les MCP réseau.
 */
export const PREFIXES_COUPES = Object.freeze(["codegraph_", "lsp_"]);

/** Outils qui écrivent : seuls les autres peuvent lire les sorties longues rangées par opencode hors du projet. */
export const OUTILS_ECRITURE = Object.freeze(["write", "edit", "apply_patch", "patch", "multiedit", "hashline_edit"]);

/** Noms d'arguments qui portent un chemin, casse ignorée (read, write, edit, lsp : filePath ; glob, list : path ; bash : workdir). */
export const CLES_CHEMIN = Object.freeze(["filepath", "file_path", "path", "paths", "file", "files", "workdir", "cwd", "directory", "dir"]);

/** Noms d'arguments qui portent un motif de fichiers (include, globs d'une extension) ; `pattern` n'en est un que pour l'outil glob. */
export const CLES_MOTIF = Object.freeze(["include", "glob", "globs"]);

/** Noms d'arguments qui portent un correctif (apply_patch : patchText). */
export const CLES_CORRECTIF = Object.freeze(["patchtext", "patch_text"]);

// --- Fichiers de clés (listes du cockpit, recopiées : ce fichier n'importe rien) ------------------------------------------------

/**
 * KEY_FILE_READ_RULES (app/server/shared/assistant-rules.ts), motifs refusés sans « / », dans l'ordre : `*.env` et `*.env.*` y sont
 * « ask », refusés ici comme partout dans la salle. Égalité vérifiée par un test ; comparée à `omo-forbidden` (L22b) au train.
 */
export const MOTIFS_CLE_REGLES = Object.freeze([
  "*.env",
  "*.env.*",
  "*.pfx",
  "*.PFX",
  "*.p12",
  "*.P12",
  "*.key",
  "*.KEY",
  "*.jks",
  "*.JKS",
  "*.keystore",
  "*.kdbx",
  "*privkey*",
  "*-key.pem",
  "*_key.pem",
  "*id_rsa*",
  "*id_ecdsa*",
  "*id_ed25519*",
  "*kubeconfig*",
]);

/** KEY_FILE_READ_RULES, motifs « allow » : `*.env.example` reste lisible et modifiable. */
export const MOTIFS_CLE_PERMIS = Object.freeze(["*.env.example"]);

/** KEY_FILE_READ_RULES, motifs qui portent un « / » : comparés au chemin entier, « * » y traverse les dossiers. */
export const MOTIFS_CLE_CHEMIN = Object.freeze(["*.kube/config"]);

/** Extensions sensibles de la règle S5 P03 (spéc. l.662), sans le point : EXTENSIONS_CLE_P03 de omo-precheck-rules.ts. */
export const EXTENSIONS_CLE_P03 = Object.freeze([
  "asc",
  "cer",
  "crt",
  "der",
  "gpg",
  "jks",
  "kdbx",
  "key",
  "keystore",
  "ovpn",
  "p12",
  "p8",
  "pem",
  "pfx",
  "tfstate",
  "tfvars",
]);

/** Fiche L24 : « .env* (sauf .env.example) », plus large que `*.env` et `*.env.*` (`.envrc`, `.env-prod`). */
export const MOTIFS_ENV = Object.freeze([".env*"]);

/** Échappe tout ce qui a un sens dans une expression régulière, sauf « * » (traité par l'appelant). */
const echapper = (texte) => texte.replace(/[.+?^${}()|[\]\\]/g, "\\$&");

/** Motif de nom (« * » = n'importe quoi sauf « / ») en expression ancrée, casse ignorée (fermé en cas de doute). */
const motifDeNom = (motif) => new RegExp(`^${echapper(motif).replace(/\*/g, "[^/]*")}$`, "iu");

/** Motif de chemin (« * » traverse les dossiers, comme wildcardMatch d'opencode), casse ignorée. */
const motifDeChemin = (motif) => new RegExp(`^${echapper(motif).replace(/\*/g, ".*")}$`, "iu");

const NOMS_REFUSES = Object.freeze([...MOTIFS_CLE_REGLES, ...EXTENSIONS_CLE_P03.map((ext) => `*.${ext}`), ...MOTIFS_ENV].map(motifDeNom));
const NOMS_PERMIS = Object.freeze(MOTIFS_CLE_PERMIS.map(motifDeNom));
const CHEMINS_REFUSES = Object.freeze(MOTIFS_CLE_CHEMIN.map(motifDeChemin));

/** Vrai si ce nom d'entrée (sans dossier) est un fichier de clés ou un `.env*`, hors `.env.example`. */
export function estNomCle(nom) {
  if (typeof nom !== "string" || nom === "") return false;
  if (NOMS_PERMIS.some((re) => re.test(nom))) return false;
  return NOMS_REFUSES.some((re) => re.test(nom));
}

/** Vrai si ce chemin (séparateur « / ») désigne un fichier de clés : par son nom, ou par un motif de chemin (`.kube/config`). */
export function estCheminCle(chemin) {
  if (typeof chemin !== "string" || chemin === "") return false;
  const nom = chemin.slice(chemin.lastIndexOf("/") + 1);
  return estNomCle(nom) || CHEMINS_REFUSES.some((re) => re.test(chemin));
}

// --- Motifs de grep et de glob --------------------------------------------------------------------------------------------------

/**
 * Noms témoins. Un motif « vise » les fichiers de clés s'il en attrape un sans attraper aucun nom ordinaire : `id_*`, `[.]env`,
 * `*.{pem,ts}` sont refusés, `*`, `*.*`, `**\/*.ts` passent. Heuristique de filet : un motif large peut encore toucher un `.env`
 * que git n'ignore pas ; seule la lecture directe et les motifs ciblés sont rattrapés.
 */
export const TEMOINS_CLE = Object.freeze([
  ".env",
  ".env.local",
  ".env.production",
  ".envrc",
  "prod.env",
  "id_rsa",
  "id_ecdsa",
  "id_ed25519",
  "server.key",
  "privkey.pem",
  "tls-key.pem",
  "cert.pem",
  "client.p12",
  "store.pfx",
  "app.jks",
  "app.keystore",
  "coffre.kdbx",
  "kubeconfig",
  "terraform.tfstate",
  "prod.tfvars",
  "cle.asc",
  "cle.gpg",
  "acces.ovpn",
  "cle.p8",
  "cert.crt",
  "cert.cer",
  "cert.der",
]);

export const TEMOINS_ORDINAIRES = Object.freeze([
  "index.ts",
  "main.py",
  "README.md",
  "package.json",
  "Makefile",
  "app.js",
  "style.css",
  "notes.txt",
  "config.yaml",
  "Dockerfile",
  ".gitignore",
  ".env.example",
  "src",
]);

/** Accolades dépliées (`*.{pem,ts}` → `*.pem`, `*.ts`), 64 variantes au plus ; `null` au-delà (doute). */
function deplierAccolades(motif, max = 64) {
  const resultats = [];
  const pile = [motif];
  while (pile.length > 0) {
    const courant = pile.pop();
    const fin = courant.indexOf("}");
    const debut = fin < 0 ? -1 : courant.lastIndexOf("{", fin);
    if (debut < 0) {
      resultats.push(courant);
    } else {
      for (const choix of courant.slice(debut + 1, fin).split(",")) pile.push(courant.slice(0, debut) + choix + courant.slice(fin + 1));
    }
    if (resultats.length + pile.length > max) return null;
  }
  return resultats;
}

/** Segment de glob (`*`, `?`, `[…]`, `\x`) en expression ancrée, casse ignorée ; `null` si le segment est mal formé (doute). */
function segmentEnRegExp(segment) {
  let source = "";
  for (let i = 0; i < segment.length; i += 1) {
    const c = segment[i];
    if (c === "*") source += "[^/]*";
    else if (c === "?") source += "[^/]";
    else if (c === "\\") {
      if (i + 1 >= segment.length) return null;
      source += echapper(segment[i + 1]);
      i += 1;
    } else if (c === "[") {
      const fin = segment.indexOf("]", i + 2);
      if (fin < 0) return null;
      let classe = segment.slice(i + 1, fin);
      if (classe.startsWith("!")) classe = `^${classe.slice(1)}`;
      source += `[${classe.replace(/\\/g, "\\\\")}]`;
      i = fin;
    } else source += echapper(c);
  }
  try {
    return new RegExp(`^${source}$`, "iu");
  } catch {
    return null;
  }
}

/** Vrai si ce motif de fichiers (grep `include`, glob `pattern`) vise des fichiers de clés, ou s'il est illisible (doute). */
export function motifViseDesCles(motif) {
  if (typeof motif !== "string") return true;
  if (motif.length > 4096) return true;
  const variantes = deplierAccolades(motif);
  if (variantes === null) return true;
  for (const variante of variantes) {
    // « !motif » : une exclusion pour ripgrep, jamais une inclusion.
    if (variante.startsWith("!")) continue;
    if (estCheminCle(variante)) return true;
    const segment = variante.slice(variante.lastIndexOf("/") + 1);
    if (segment === "" || segment === "**") continue;
    const re = segmentEnRegExp(segment);
    if (re === null) return true;
    // Un segment sans lettre, chiffre ni classe (`*`, `*.*`, `????`) ne vise rien en particulier.
    const horsClasses = segment.replace(/\[[^\]]*\]/g, "");
    if (!/[\p{L}\p{N}]/u.test(horsClasses) && horsClasses.length === segment.length) continue;
    if (TEMOINS_CLE.some((nom) => re.test(nom)) && !TEMOINS_ORDINAIRES.some((nom) => re.test(nom))) return true;
  }
  return false;
}

// --- Correctifs (apply_patch) ---------------------------------------------------------------------------------------------------

const ENTETES_CORRECTIF = Object.freeze(["*** Add File:", "*** Update File:", "*** Delete File:", "*** Move to:"]);

/** Chemins nommés par un correctif d'apply_patch (en-têtes lus par Patch.parsePatch d'opencode 1.18.30). */
export function cheminsDuCorrectif(texte) {
  if (typeof texte !== "string") return [];
  const chemins = [];
  for (const ligne of texte.split(/\r\n|\r|\n/)) {
    for (const entete of ENTETES_CORRECTIF) {
      if (ligne.startsWith(entete)) chemins.push(ligne.slice(entete.length).trim());
    }
  }
  return chemins;
}

// --- État de garde (guard-state.json) -------------------------------------------------------------------------------------------

const estObjet = (valeur) => typeof valeur === "object" && valeur !== null && !Array.isArray(valeur);

/** Horodatage en millisecondes plausible (jusqu'à l'an 10 000), comme `estHorodatage` du protocole. */
const estHorodatage = (valeur) => typeof valeur === "number" && Number.isSafeInteger(valeur) && valeur >= 0 && valeur <= 253_402_300_799_999;

/**
 * Analyse du texte de `guard-state.json` : `{version: 1, at, bloquer}` ou `null` (« invalide »). Mêmes règles que
 * `analyserGuardState` du cockpit, avec une borne plus serrée (4 Kio au lieu de 64) : un outil inconnu rend TOUT l'état invalide.
 */
export function analyserEtatGarde(texte) {
  if (typeof texte !== "string" || texte.length === 0) return null;
  if (new TextEncoder().encode(texte).length > ETAT_GARDE_MAX_OCTETS) return null;
  let brut;
  try {
    brut = JSON.parse(texte);
  } catch {
    return null;
  }
  if (!estObjet(brut) || brut.version !== 1 || !estHorodatage(brut.at) || !Array.isArray(brut.bloquer)) return null;
  const bloquer = [];
  for (const outil of brut.bloquer) {
    const connu = OUTILS_DELEGATION.find((o) => o === outil);
    if (!connu) return null;
    if (!bloquer.includes(connu)) bloquer.push(connu);
  }
  return { version: 1, at: brut.at, bloquer };
}

const invalide = (raison) => ({ etat: "invalide", raison });

/**
 * Lecture de l'état de garde, bornée, sans suivre de lien ni attendre sur un tube : `{etat: "absent"}` (fichier inexistant),
 * `{etat: "valide", garde}` ou `{etat: "invalide", raison}` : « lien », « pas un fichier » (dossier, tube), « taille » (taille
 * annoncée trop grande, rien n'est lu), « trop gros » (plus de 4 Kio lus alors que la taille annoncée était petite, comme sous
 * /proc), « encodage », « contenu », « illisible ».
 */
export function lireEtatGarde(chemin = CHEMIN_ETAT_GARDE) {
  let fd;
  try {
    const drapeaux = fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0) | (fs.constants.O_NONBLOCK ?? 0);
    fd = fs.openSync(chemin, drapeaux);
  } catch (err) {
    return err?.code === "ENOENT" ? { etat: "absent" } : invalide(err?.code === "ELOOP" ? "lien" : "illisible");
  }
  try {
    const infos = fs.fstatSync(fd);
    if (!infos.isFile()) return invalide("pas un fichier");
    if (infos.size > ETAT_GARDE_MAX_OCTETS) return invalide("taille");
    const tampon = Buffer.alloc(ETAT_GARDE_MAX_OCTETS + 1);
    let lus = 0;
    while (lus < tampon.length) {
      const n = fs.readSync(fd, tampon, lus, tampon.length - lus, null);
      if (n === 0) break;
      lus += n;
    }
    if (lus > ETAT_GARDE_MAX_OCTETS) return invalide("trop gros");
    let texte;
    try {
      texte = new TextDecoder("utf-8", { fatal: true }).decode(tampon.subarray(0, lus));
    } catch {
      return invalide("encodage");
    }
    const garde = analyserEtatGarde(texte);
    return garde ? { etat: "valide", garde } : invalide("contenu");
  } catch {
    return invalide("illisible");
  } finally {
    fs.closeSync(fd);
  }
}

// --- Chemins réels et dossiers --------------------------------------------------------------------------------------------------

/** L'entrée existe-t-elle, sans suivre de lien au dernier composant ? `true`, `false` (absente), `null` si on ne peut le dire. */
function existeSansSuivre(chemin) {
  try {
    fs.lstatSync(chemin);
    return true;
  } catch (err) {
    return err?.code === "ENOENT" || err?.code === "ENOTDIR" ? false : null;
  }
}

/**
 * Chemin réel d'un chemin absolu, liens résolus : le plus long préfixe existant passe par `realpath`, la suite (fichier à créer) y
 * est recollée. `null` si le chemin ne peut pas être résolu (boucle de liens, droits, lien pendant) : doute.
 *
 * `realpath` de la libc (`fs.realpathSync.native`), jamais `fs.realpathSync` : la version JS normalise la cible d'un lien
 * (« a/../x ») avant de suivre « a », là où le système suit le lien puis remonte ; elle croirait lire un fichier du projet.
 * Une entrée qui existe sans pouvoir être résolue est un lien PENDANT (sur le dernier composant ou plus haut) : écrire au travers
 * créerait le fichier au bout du lien, peut-être hors du projet. On ne remonte donc au parent que si l'entrée n'existe pas.
 */
export function cheminReel(chemin) {
  let courant = chemin;
  const suite = [];
  for (let i = 0; i < 256; i += 1) {
    try {
      const reel = fs.realpathSync.native(courant);
      return suite.length === 0 ? reel : posix.join(reel, ...suite.toReversed());
    } catch (err) {
      if (err?.code !== "ENOENT" && err?.code !== "ENOTDIR") return null;
      if (existeSansSuivre(courant) !== false) return null;
      const parent = posix.dirname(courant);
      if (parent === courant) return null;
      suite.push(posix.basename(courant));
      courant = parent;
    }
  }
  return null;
}

/** Dossier des sorties longues d'opencode (Global.Path.data/tool-output, avec XDG_DATA_HOME comme opencode), `null` si inconnu. */
export function dossierSortiesOutils() {
  const donnees = process.env.XDG_DATA_HOME || posix.join(os.homedir(), ".local", "share");
  const dossier = posix.join(donnees, "opencode", "tool-output");
  return posix.isAbsolute(dossier) ? dossier : null;
}

const estDans = (chemin, base) => chemin === base || chemin.startsWith(base.endsWith("/") ? base : `${base}/`);

// --- Messages (présentés comme un filet) ----------------------------------------------------------------------------------------

/** Messages rendus à l'IA comme erreur d'outil, et affichés par le cockpit. « {outil} » : nom de l'outil refusé. */
export const MESSAGES_FILET = Object.freeze({
  cle: "Filet du cockpit : les fichiers de clés et les .env sont refusés aux outils de l'IA ({outil}) ; .env.example reste permis. N'essayez pas de le contourner.",
  "hors-projet": "Filet du cockpit : chemin hors du projet ouvert, refusé ({outil}). N'essayez pas de le contourner.",
  reseau: "Filet du cockpit : pas d'accès au réseau dans la salle ({outil}).",
  delegation: "Filet du cockpit : délégations suspendues par le cockpit pour cette demande ({outil}). Continuez sans déléguer.",
  "etat-illisible": "Filet du cockpit : état de garde illisible, délégation refusée par prudence ({outil}). Continuez sans déléguer.",
  doute: "Filet du cockpit : arguments impossibles à vérifier, outil refusé par prudence ({outil}).",
  coupe: "Filet du cockpit : cet outil est coupé dans la salle ({outil}). Faites autrement, avec les outils qui restent.",
  recherche:
    "Filet du cockpit : recherche dans le contenu des fichiers refusée dans la salle ({outil}), car elle lirait aussi les fichiers de clés et les .env. Lisez les fichiers utiles un par un.",
});

const NOM_OUTIL_SUR = /^[A-Za-z0-9_.-]{1,64}$/;

const refus = (categorie, outil) => ({
  categorie,
  message: MESSAGES_FILET[categorie].replace("{outil}", NOM_OUTIL_SUR.test(outil) ? outil : "outil"),
});

// --- Décision -------------------------------------------------------------------------------------------------------------------

/** Nombre de nœuds et profondeur au-delà desquels les arguments ne sont plus parcourus : doute, donc refus. */
const PARCOURS_MAX_NOEUDS = 2000;
const PARCOURS_MAX_PROFONDEUR = 4;

/** Parcours borné des arguments : chemins, motifs et correctifs, reconnus par le nom de leur clé. */
function collecter(outil, args) {
  const trouve = { chemins: [], motifs: [], doute: false };
  let noeuds = 0;
  const visiter = (valeur, profondeur) => {
    noeuds += 1;
    if (noeuds > PARCOURS_MAX_NOEUDS || profondeur > PARCOURS_MAX_PROFONDEUR) {
      trouve.doute = true;
      return;
    }
    if (Array.isArray(valeur)) {
      for (const element of valeur) if (typeof element === "object" && element !== null) visiter(element, profondeur + 1);
    } else if (estObjet(valeur)) {
      for (const [cle, contenu] of Object.entries(valeur)) ranger(cle.toLowerCase(), contenu, profondeur);
    }
  };
  /** Chaînes d'un argument de chemin ou de motif : une chaîne, ou une liste ; tout le reste (nombre, objet) est un doute. */
  const chaines = (contenu, liste) => {
    const elements = Array.isArray(contenu) ? contenu : [contenu];
    for (const element of elements) {
      if (typeof element === "string") liste.push(element);
      else if (element !== null && element !== undefined) trouve.doute = true;
    }
  };
  const ranger = (cle, contenu, profondeur) => {
    if (CLES_CHEMIN.includes(cle)) chaines(contenu, trouve.chemins);
    else if (CLES_MOTIF.includes(cle) || (cle === "pattern" && outil === "glob")) chaines(contenu, trouve.motifs);
    else if (CLES_CORRECTIF.includes(cle)) {
      const textes = [];
      chaines(contenu, textes);
      for (const texte of textes) trouve.chemins.push(...cheminsDuCorrectif(texte));
    } else if (typeof contenu === "object" && contenu !== null) visiter(contenu, profondeur + 1);
  };
  visiter(args, 0);
  return trouve;
}

/** Délégation : `null` si l'état la laisse passer, sinon la catégorie du refus. */
function examinerDelegation(outil, lecture) {
  // Aucun état publié : aucun blocage (variante (a) de Q2).
  if (lecture?.etat === "absent") return null;
  if (lecture?.etat === "valide" && Array.isArray(lecture.garde?.bloquer)) return lecture.garde.bloquer.includes(outil) ? "delegation" : null;
  return "etat-illisible";
}

/** Un segment « . » ou « .. » dans le texte même du chemin. */
const aDesPoints = (chemin) => chemin.split("/").some((segment) => segment === "." || segment === "..");

/**
 * Un chemin d'argument : `null` (dans le projet ouvert, ou sortie longue lue), « cle », « hors-projet » ou « doute ». Un chemin
 * RELATIF est normalisé contre le projet, comme opencode 1.18.30 le fait lui-même (path.resolve de read.ts, path.join de write.ts et
 * edit.ts) avant de le passer au système. Un chemin ABSOLU, lui, est passé tel quel : le système suit chaque lien AVANT le « .. »
 * qui le suit, alors que la normalisation retire le « .. » d'abord (« <projet>/lien/../x » peut mener hors du projet sans que le
 * texte le montre). Un chemin absolu qui porte « . » ou « .. » vaut donc « doute », sauf clé ou sortie évidente du projet. Le
 * chemin réel est vérifié ensuite : un lien du projet qui mène à une clé, ou hors du projet, est refusé comme s'il y menait
 * directement.
 */
function examinerChemin(chemin, dossier, zones, reel) {
  if (chemin.length > 4096 || chemin.includes("\0") || dossier === null) return "doute";
  const lexical = posix.resolve(dossier, chemin);
  if (estCheminCle(lexical)) return "cle";
  if (posix.isAbsolute(chemin) && aDesPoints(chemin)) return zones.some((zone) => estDans(lexical, zone)) ? "doute" : "hors-projet";
  const reelDuChemin = reel(lexical);
  if (reelDuChemin !== null && estCheminCle(reelDuChemin)) return "cle";
  const dedans = zones.some((zone) => {
    if (!estDans(lexical, zone)) return false;
    if (reelDuChemin === null) return true;
    const zoneReelle = reel(zone);
    return zoneReelle !== null && estDans(reelDuChemin, zoneReelle);
  });
  if (!dedans) return "hors-projet";
  return reelDuChemin === null ? "doute" : null;
}

/** Ordre des refus quand plusieurs chemins d'un même appel posent problème : la clé d'abord, le doute en dernier. */
const PRIORITE_CHEMINS = Object.freeze(["cle", "hors-projet", "doute"]);

/**
 * Décision du filet pour un appel d'outil : `null` (laissé passer) ou `{categorie, message}`. `contexte` : `dossier` (projet ouvert,
 * chemin absolu), `sortiesOutils` (dossier tool-output d'opencode, ou `null`), `reel(chemin)` (chemin réel ou `null`), `lireEtat()`.
 */
export function decider(outil, args, contexte) {
  const nom = typeof outil === "string" ? outil : "";
  if (OUTILS_RESEAU.includes(nom) || PREFIXES_RESEAU.some((prefixe) => nom.startsWith(prefixe))) return refus("reseau", nom);
  if (OUTILS_RECHERCHE.includes(nom)) return refus("recherche", nom);
  if (OUTILS_COUPES.includes(nom) || PREFIXES_COUPES.some((prefixe) => nom.startsWith(prefixe))) return refus("coupe", nom);
  if (OUTILS_DELEGATION.includes(nom)) {
    const categorie = examinerDelegation(nom, contexte.lireEtat());
    if (categorie !== null) return refus(categorie, nom);
  }

  const brut = args === undefined || args === null ? {} : args;
  if (!estObjet(brut)) return refus("doute", nom);
  const { chemins, motifs, doute } = collecter(nom, brut);

  const dossier = typeof contexte.dossier === "string" && posix.isAbsolute(contexte.dossier) ? posix.resolve(contexte.dossier) : null;
  const zones = dossier === null ? [] : [dossier];
  if (!OUTILS_ECRITURE.includes(nom) && typeof contexte.sortiesOutils === "string") zones.push(contexte.sortiesOutils);
  const constats = new Set(doute ? ["doute"] : []);
  for (const chemin of chemins) {
    if (chemin === "") continue;
    const constat = examinerChemin(chemin, dossier, zones, contexte.reel);
    if (constat !== null) constats.add(constat);
  }
  if (motifs.some((motif) => motifViseDesCles(motif))) constats.add("cle");
  const categorie = PRIORITE_CHEMINS.find((c) => constats.has(c));
  return categorie === undefined ? null : refus(categorie, nom);
}

/**
 * Filet d'une instance : `avant(input, output)` est le crochet `tool.execute.before`. Il lève une erreur (erreur d'outil) pour un
 * refus, et ne modifie jamais les arguments. Une erreur imprévue du filet refuse aussi (fermé en cas de doute).
 */
export function creerGarde({ dossier, sortiesOutils = dossierSortiesOutils(), cheminEtat = CHEMIN_ETAT_GARDE, lireEtat, reel = cheminReel } = {}) {
  const contexte = {
    dossier,
    sortiesOutils,
    reel,
    lireEtat: lireEtat ?? (() => lireEtatGarde(cheminEtat)),
  };
  const avant = (input, output) => {
    const outil = typeof input?.tool === "string" ? input.tool : "";
    let decision;
    try {
      decision = decider(outil, output?.args, contexte);
    } catch {
      decision = refus("doute", outil);
    }
    if (decision !== null) throw new Error(decision.message);
  };
  return { decider: (outil, args) => decider(outil, args, contexte), avant };
}

/** Point d'entrée d'opencode : un filet par instance (projet ouvert = `input.directory`). */
async function server(input) {
  const garde = creerGarde({ dossier: input?.directory });
  return {
    "tool.execute.before": async (entree, sortie) => {
      garde.avant(entree, sortie);
    },
  };
}

/** Plugin « v1 » : seul l'export par défaut est lu par opencode ; `plugin` est le même objet, nommé pour les tests. */
export const plugin = Object.freeze({ id: ID_PLUGIN, server });

export default plugin;
