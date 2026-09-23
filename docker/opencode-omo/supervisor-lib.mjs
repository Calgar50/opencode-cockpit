// Superviseur de la Salle OMO : TOUTE la logique (D-2b-24). `supervisor.sh` n'a que la boucle et les signaux ; il appelle ce module
// par ses sous-commandes et ne lit que des codes de sortie. Node de l'image, AUCUNE dépendance : ce fichier est dans le périmètre du
// manifeste (D-2b-32), il doit donc rester lisible et vérifiable sans rien installer.
//
// Les formats sont ceux de `app/server/shared/omo-control-protocol.ts` : mêmes noms de fichiers, mêmes délais, mêmes règles
// « fermé en cas de doute ». Les deux modules ne s'importent JAMAIS l'un l'autre (l'un est du TypeScript du cockpit, l'autre tourne
// dans l'image) : un test rejoue les mêmes vecteurs sur les deux et compare les délais à l'octet.
//
// Qui écrit quoi :
// - root : configuration du HOME (volume `omo-config`, D-2b-33 révisée au train de V1), manifeste, validation, propriétaire et
//   points de montage des dossiers de configuration et des volumes (MO-3, MO-11), `state.json`, dossier de travail du superviseur,
//   empreinte des montages surveillée pendant la salle ;
// - `node` (par `setpriv`, D-2b-27) : tout ce qui touche à des fichiers de `node` — purge, copie d'`auth.json`, `test -w`, balayage
//   de `/workspace` — et la vérification de ses propres capacités après la bascule (MO-7). Ces sous-commandes n'écrivent RIEN
//   ailleurs que dans les dossiers de `node` : elles rendent leur constat en JSON sur la sortie standard, que le superviseur (root)
//   redirige vers un fichier de son dossier de travail, puis absorbe. `node` ne peut donc pas fausser l'état publié, même en
//   écrivant dans ses propres dossiers. Rien de tout cela ne tourne pendant qu'opencode est lancé.
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

// --- Bornes, délais et chemins ------------------------------------------------------------------------------------------------

/** 64 Kio : au-delà, un fichier de contrôle vaut « inconnu » (omo-control-protocol.ts). */
export const OMO_CONTROL_MAX_OCTETS = 65_536;

/**
 * 20 chemins au plus dans une liste publiée (`workspaceGit.nonProteges`, rapports de purge). `precheck-ok` n'a pas cette borne :
 * tous les projets préparés y sont (D-2b-35), seuls les 64 Kio et la longueur de chaque chemin le bornent.
 */
export const OMO_LISTE_MAX = 20;

/** Manifeste : une ligne par fichier du périmètre, donc bien plus gros qu'un fichier de contrôle. */
export const OMO_MANIFESTE_MAX_OCTETS = 4 * 1024 * 1024;

/** `omo-projets.json` et `auth.json` : bornés eux aussi, jamais lus sans borne. */
export const OMO_PROJETS_MAX_OCTETS = 1024 * 1024;
export const OMO_AUTH_MAX_OCTETS = 1024 * 1024;

/** `omo.jsonc` de référence (1 Mio, la borne de `validate.mjs`). */
export const OMO_CONFIG_MAX_OCTETS = 1024 * 1024;

/** Délais de l'homme mort, en secondes (D-2b-25) : mêmes valeurs que `OMO_DELAIS` du cockpit, égalité vérifiée par un test. */
export const OMO_DELAIS = { battementS: 5, perimeS: 20, verificationS: 2, killApresS: 3 };

/** Marge de la borne, et promesse faite à l'utilisateur (§7.5 l.1145). */
export const OMO_MARGE_HOMME_MORT_S = 2;
export const OMO_BORNE_HOMME_MORT_MAX_S = 30;

/** Pire cas entre le dernier battement écrit et la mort d'opencode : 20 + 2 + 3 + 2 = 27 s. */
export function borneHommeMort(delais = OMO_DELAIS) {
  return delais.perimeS + delais.verificationS + delais.killApresS + OMO_MARGE_HOMME_MORT_S;
}

/** Fichiers du volume de contrôle (contrat `contrat-salle.json`, plan §4.1.4). */
export const FICHIERS_CONTROLE = { battement: "heartbeat", arret: "stop-request", precheck: "precheck-ok", garde: "guard-state.json" };

/** État publié par le superviseur. */
export const FICHIER_ETAT = "state.json";

/**
 * Projets préparés par `install.ps1` (D-2b-12, D-2b-28). Le cockpit dépose le fichier dans le volume de contrôle : c'est la SEULE
 * entrée de la salle que `node` ne peut pas réécrire (`/control` est monté en lecture seule). Le lire dans `/workspace` reviendrait
 * à demander à l'IA quels dossiers elle accepte de laisser protéger.
 */
export const FICHIER_PROJETS = "omo-projets.json";

/** Chemins de l'image et des volumes (plan §4.1.4 ; égalité avec `contrat-salle.json` vérifiée au train de V0). */
export const CHEMINS = {
  controle: "/control",
  etat: "/omo-state",
  authSource: "/auth-src",
  donnees: "/home/node/.local/share/opencode",
  workspace: "/workspace",
  home: "/home/node",
  tmp: "/tmp",
  /** Volume `omo-config`, seul montage en écriture, hors du HOME : root y pose la configuration du HOME (D-2b-33 révisée). */
  configHome: "/omo-config",
  /**
   * Volume `omo-carnets` (L16c, décision A16 point 2) : la place de la salle HORS de tout projet, à `node`. Aucun dossier `.omo`
   * n'est jamais créé dans les projets de l'utilisateur ; la 4.19.4, elle, n'écrit ses carnets que sous `<projet>/.omo`.
   */
  carnets: "/omo-carnets",
  /** `omo.jsonc` de référence, dans le périmètre du manifeste (`configuration`), lu aussi par `validate.mjs`. */
  configurationOmo: "/etc/opencode-omo/omo/omo.jsonc",
  superviseur: "/usr/local/bin/omo-supervisor",
  superviseurLib: "/opt/omo-check/supervisor-lib.mjs",
  valider: "/opt/omo-check/validate.mjs",
  validerCoeur: "/opt/omo-check/validate-core.mjs",
  enumerations: "/opt/omo-check/enums-4.19.4.json",
  manifeste: "/opt/omo-check/manifest.sh",
  referenceManifeste: "/etc/omo-reference/omo-manifest.sha256",
  garde: "/opt/omo-guard/cockpit-guard.js",
  configuration: "/etc/opencode-omo",
  imageId: "/etc/opencode-omo/image-id",
  extension: "/opt/omo",
  licence: "/usr/share/doc/oh-my-openagent/LICENSE.md",
};

/**
 * Cinq dossiers de configuration du HOME (D-2b-33), appartenant à root, montés en lecture seule depuis le volume `omo-config`.
 * Révision du train de V1 (demande de contrat (A) de L15a, constat de L24) : ils ne sont plus vides. La 4.19.4 ne lit sa couche
 * « utilisateur » qu'à `$HOME/.omo/omo.jsonc` (aucune variable ne la déplace) ; opencode 1.18.30 écrit un `.gitignore` dans chaque
 * dossier de configuration et, sur un montage en lecture seule, reçoit EROFS et refuse tout projet (HTTP 500, mesuré par L24). Le
 * superviseur (root) remplit donc le volume, sur son seul montage en écriture (`CHEMINS.configHome`, hors du HOME), avec
 * EXACTEMENT deux fichiers : le `omo.jsonc` de référence de l'image et ce `.gitignore`. `node` ne voit que la lecture seule.
 */
export const DOSSIERS_CONFIG_HOME = [
  "/home/node/.config/opencode",
  "/home/node/.opencode",
  "/home/node/.omo",
  "/home/node/.claude",
  "/home/node/.agents",
];

/** Seuls fichiers du volume `omo-config`, donc de chacun des cinq dossiers. */
export const CONFIG_HOME_FICHIERS = Object.freeze({ omo: "omo.jsonc", gitignore: ".gitignore" });

/** Contenu du `.gitignore` posé : la liste qu'opencode 1.18.30 écrirait lui-même (`config.ts`, `ensureGitignore`). */
export const CONFIG_HOME_GITIGNORE = "node_modules\npackage.json\npackage-lock.json\nbun.lock\n.gitignore\n";

/** Identifiant de `node` dans l'image (image node officielle, comme celle du cockpit) : propriétaire attendu des volumes de `node`. */
export const UID_NODE = 1000;

/**
 * Volumes montés dans la salle et leur propriétaire attendu (contrat `volumes[].proprietaire`, plan §4.1.4). MO-11 : sous Compose,
 * le propriétaire d'un volume neuf est celui du DERNIER service créé qui le monte, pas du premier démarré ; il se vérifie, il ne se
 * déduit pas. Un écart refuse le démarrage, sans rien corriger en silence.
 */
export const VOLUMES_SALLE = [
  { volume: "control-omo", chemin: CHEMINS.controle, uid: UID_NODE },
  { volume: "omo-auth", chemin: CHEMINS.authSource, uid: UID_NODE },
  { volume: "omo-state", chemin: CHEMINS.etat, uid: 0 },
  { volume: "oc-omo-data", chemin: CHEMINS.donnees, uid: UID_NODE },
  { volume: "omo-config", chemin: CHEMINS.configHome, uid: 0 },
  { volume: "omo-carnets", chemin: CHEMINS.carnets, uid: UID_NODE },
];

/**
 * Volumes que `node` ne doit jamais pouvoir écrire, vérifiés par `test -w` en tant que `node` : le battement (G9 : un battement
 * inscriptible depuis la salle tiendrait l'homme mort en échec), l'authentification, l'état publié (M32), et le montage en écriture
 * de la configuration du HOME (ce que l'extension lit).
 */
export const VOLUMES_FERMES_A_NODE = [CHEMINS.controle, CHEMINS.authSource, CHEMINS.etat, CHEMINS.configHome];

/** Périmètre du manifeste (D-2b-32). */
export const PERIMETRE_MANIFESTE = ["/opt/omo", "/opt/omo-check", "/opt/omo-guard", "/etc/opencode-omo", "/usr/local/bin/omo-supervisor"];

/**
 * Gardés par la purge du dossier de données (D-2b-36), liste finale d'après MO-2 : la persistance réelle d'opencode 1.18.30 est
 * `opencode.db` et ses deux fichiers WAL, rien d'autre. `storage/` n'existe plus en 1.18.30 ; le garder laisserait à `node` un
 * dossier qui traverse les relances. Seuls des FICHIERS ordinaires portant exactement ces noms sont gardés (voir `viderDossier`) :
 * un dossier ou un lien nommé `opencode.db-wal` part comme le reste. Supprimer `-wal` ou `-shm` sans la base perdrait les dernières
 * écritures : les trois vont ensemble.
 */
export const PURGE_GARDES = [/^opencode\.db(?:-shm|-wal)?$/];

/** Dossiers jamais parcourus par le balayage git (D-2b-28). */
export const BALAYAGE_EXCLUS = ["node_modules"];

/** Plafond d'entrées du balayage : au-delà, « limite atteinte » et donc git non protégé (D-2b-28). */
export const BALAYAGE_PLAFOND = 200_000;

/** Profondeur maximale du balayage : un arbre plus profond est un doute, pas un dossier de travail. */
export const BALAYAGE_PROFONDEUR_MAX = 256;

/**
 * Codes de sortie lus par `supervisor.sh` : 0 continue, 3 refuse (rien ne démarre), 4 pas encore prêt, 10 arrêt demandé,
 * 11 battement périmé, 12 opencode n'est plus là, 13 point de montage déplacé (MO-3).
 */
export const CODES = { ok: 0, refus: 3, pasPret: 4, arret: 10, perime: 11, fini: 12, montage: 13 };

// --- Analyse des fichiers de contrôle (mêmes règles que le cockpit) --------------------------------------------------------------

const estObjet = (valeur) => typeof valeur === "object" && valeur !== null && !Array.isArray(valeur);
const estHorodatage = (valeur) => typeof valeur === "number" && Number.isSafeInteger(valeur) && valeur >= 0 && valeur <= 253_402_300_799_999;
const estTexte = (valeur, max) => typeof valeur === "string" && valeur.length > 0 && valeur.length <= max;
const estSha256 = (valeur) => typeof valeur === "string" && /^[0-9a-f]{64}$/.test(valeur);

/** `startId` : ce que rend `crypto.randomUUID()`. */
export const estStartId = (valeur) => typeof valeur === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(valeur);

export const tailleOctets = (texte) => Buffer.byteLength(texte, "utf8");

/** Objet JSON d'un fichier de contrôle, ou `null` (« inconnu ») : absent, trop gros, illisible, ou autre chose qu'un objet. */
export function analyserObjet(texte, maxOctets = OMO_CONTROL_MAX_OCTETS) {
  if (typeof texte !== "string" || texte.length === 0) return null;
  if (tailleOctets(texte) > maxOctets) return null;
  try {
    const brut = JSON.parse(texte);
    return estObjet(brut) ? brut : null;
  } catch {
    return null;
  }
}

export function analyserBattement(texte) {
  const brut = analyserObjet(texte);
  return brut && estHorodatage(brut.at) ? { at: brut.at } : null;
}

/**
 * Causes d'un `stop-request` : celles d'`OmoStopCause`, plus « fin-de-demande » (relance à neuf à la fin de chaque demande,
 * D-2b-29 ; `requestStop(cause: OmoRecreationRaison)` du port de contrôle, T3a). Égalité avec le cockpit vérifiée au train de V0.
 */
const ARRET_CAUSES = [
  "vous",
  "plafond-cout",
  "plafond-duree",
  "plafond-sessions",
  "plafond-tentatives",
  "seuil-mensuel",
  "hors-controle",
  "homme-mort",
  "redemarrage-cockpit",
  "fin-de-demande",
];

/**
 * `stop-request` : `{at, cause, startId}`. `startId` est celui du démarrage que le cockpit veut arrêter ; absent ou mal formé, il
 * vaut `null` et l'arrêt est rattaché au démarrage par sa date (`arretDuDemarrage`). Cause inconnue : l'arrêt reste un arrêt ; on
 * ne refuse jamais de s'arrêter.
 */
export function analyserArret(texte) {
  const brut = analyserObjet(texte);
  if (!brut || !estHorodatage(brut.at)) return null;
  return {
    at: brut.at,
    cause: ARRET_CAUSES.includes(brut.cause) ? brut.cause : "vous",
    startId: estStartId(brut.startId) ? brut.startId : null,
  };
}

/**
 * Le `stop-request` vise-t-il le démarrage en cours ? Nommé : seulement s'il nomme CE démarrage. Sans démarrage nommé : s'il date
 * de ce démarrage ou d'après (cockpit et salle lisent l'horloge du même noyau). Rien n'efface `stop-request` : sans ce lien, un
 * arrêt déjà honoré ferait sortir chaque relance à neuf dès son premier tour d'attente, et Docker la relancerait sans fin
 * (D-2b-29). Rien de sûr ne se perd : un démarrage exige toujours un battement frais et le `precheck-ok` de son `startId`.
 */
export function arretDuDemarrage(arret, startId, startedAt) {
  if (!arret) return false;
  if (arret.startId !== null) return arret.startId === startId;
  return arret.at >= startedAt;
}

export function analyserPrecheckOk(texte) {
  const brut = analyserObjet(texte);
  if (!brut || !estHorodatage(brut.at) || !estStartId(brut.startId)) return null;
  // Aucune borne en nombre : les 64 Kio d'`analyserObjet` et les 4 096 caractères de chaque chemin suffisent (D-2b-35).
  if (!Array.isArray(brut.projets)) return null;
  const projets = [];
  for (const entree of brut.projets) {
    if (!estObjet(entree) || !estTexte(entree.chemin, 4096) || !estSha256(entree.sha256)) return null;
    projets.push({ chemin: entree.chemin, sha256: entree.sha256 });
  }
  return { startId: brut.startId, at: brut.at, projets };
}

/** `omo-projets.json` (format `OmoPreparedProjects` de T3a) : version, date, projets préparés, `.git` protégés par la surcharge. */
export function analyserProjetsPrepares(texte) {
  const brut = analyserObjet(texte, OMO_PROJETS_MAX_OCTETS);
  if (!brut || brut.version !== 1 || !estTexte(brut.genereLe, 64)) return null;
  if (!Array.isArray(brut.projets) || !Array.isArray(brut.gitProteges)) return null;
  const projets = [];
  for (const entree of brut.projets) {
    if (!estObjet(entree) || !estTexte(entree.chemin, 4096)) return null;
    if (entree.git !== "dossier" && entree.git !== "absent") return null;
    projets.push({ chemin: entree.chemin, git: entree.git });
  }
  const gitProteges = [];
  for (const entree of brut.gitProteges) {
    if (!estObjet(entree) || !estTexte(entree.chemin, 4096)) return null;
    if (entree.forme !== "dossier" && entree.forme !== "fichier") return null;
    gitProteges.push({ chemin: entree.chemin, forme: entree.forme });
  }
  return { version: 1, genereLe: brut.genereLe, projets, gitProteges };
}

/** Battement frais : présent, pas plus vieux que `perimeS`, pas daté de l'avenir de plus de `perimeS` (horloge faussée). */
export function battementFrais(battement, maintenantMs, delais = OMO_DELAIS) {
  if (!battement) return false;
  const age = maintenantMs - battement.at;
  return age <= delais.perimeS * 1000 && age >= -delais.perimeS * 1000;
}

/** `precheck-ok` du démarrage en cours : même `startId`, pas daté de l'avenir. Un pré-contrôle d'un démarrage précédent ne vaut rien. */
export function precheckDuDemarrage(precheck, startId, maintenantMs, delais = OMO_DELAIS) {
  if (!precheck || precheck.startId !== startId) return false;
  return maintenantMs - precheck.at >= -delais.perimeS * 1000;
}

/**
 * Décision après relecture du volume de contrôle : `stop-request` l'emporte, puis le battement. `arret` est celui du démarrage en
 * cours (passé par `arretDuDemarrage`), `null` sinon.
 */
export function decisionSuperviseur(battement, arret, maintenantMs, delais = OMO_DELAIS) {
  if (arret) return "arret-demande";
  return battementFrais(battement, maintenantMs, delais) ? "continuer" : "battement-perime";
}

/**
 * Étape 7, sans lecture : l'appelant fournit ce qu'il a lu (`arret` tel quel : le tri par démarrage est fait ici). Rend le code
 * que `supervisor.sh` lira. Ordre : arrêt de CE démarrage, dossier de travail protégé (second verrou), battement frais,
 * `precheck-ok` de CE démarrage.
 */
export function decisionPret({ travail, arret, battement, precheck, maintenantMs }, delais = OMO_DELAIS) {
  if (arretDuDemarrage(arret, travail.startId, travail.startedAt)) return CODES.arret;
  // Second verrou : sans un dossier de travail entièrement protégé, on n'est jamais prêt, même si un precheck-ok apparaissait.
  if (!gitProtege(travail)) return CODES.pasPret;
  if (!battementFrais(battement, maintenantMs, delais)) return CODES.pasPret;
  if (!precheckDuDemarrage(precheck, travail.startId, maintenantMs, delais)) return CODES.pasPret;
  return CODES.ok;
}

/**
 * Le processus `pid` tourne-t-il encore ? Lu dans `/proc/<pid>/stat`, pas par `kill -0` : root sans CAP_KILL (contrat :
 * `cap_drop: ALL`, seulement SETUID et SETGID) reçoit EPERM sur un processus de `node`, et le shell le prendrait pour mort
 * (mesure L17a). Un zombie (Z) ou un mort (X) ne tourne plus ; un fichier illisible non plus : dans le doute, on s'arrête, et
 * l'arrêt est toujours le côté sûr (la sortie du superviseur fait tomber tout le conteneur).
 */
export function vivant(pid, racineProc = "/proc") {
  if (!/^[1-9]\d{0,9}$/.test(String(pid))) return false;
  const texte = lireTexteBorne(path.join(racineProc, String(pid), "stat"), 4096);
  if (texte === null) return false;
  // « pid (comm) S … » : comm peut contenir des espaces et des parenthèses, l'état suit la DERNIÈRE parenthèse fermante.
  const fin = texte.lastIndexOf(")");
  if (fin < 0) return false;
  const etat = texte.slice(fin + 1).trimStart().charAt(0);
  return etat !== "" && etat !== "Z" && etat !== "X" && etat !== "x";
}

/** Champs « Nom:\tvaleur » de /proc/<pid>/status. */
function champsStatut(texte) {
  const champs = new Map();
  for (const ligne of texte.split("\n")) {
    const i = ligne.indexOf(":");
    if (i > 0) champs.set(ligne.slice(0, i), ligne.slice(i + 1).trim());
  }
  return champs;
}

/**
 * Bascule vers `node` vérifiée sur le processus lui-même (D-2b-27, MO-7), à partir de son /proc/self/status : identités réelle,
 * effective, sauvegardée et du système de fichiers égales et non nulles (utilisateur ET groupe), aucun groupe supplémentaire,
 * `CapInh`, `CapPrm`, `CapEff` et `CapAmb` à 0, `NoNewPrivs` à 1. `CapBnd` n'est PAS exigé à 0 : sans CAP_SETPCAP,
 * `setpriv --bounding-set -all` rend 0 sans rien faire (MO-7) ; l'ensemble borné reste SETUID+SETGID, limite dite (R10).
 * Texte absent ou incomplet : faux (fermé en cas de doute).
 */
export function capacitesNulles(texteStatut) {
  if (typeof texteStatut !== "string") return false;
  const champs = champsStatut(texteStatut);
  const quatreEgauxNonNuls = (valeur) => {
    const ids = typeof valeur === "string" ? valeur.split(/\s+/) : [];
    return ids.length === 4 && ids.every((id) => /^[1-9]\d*$/.test(id) && id === ids[0]);
  };
  const nul = (valeur) => typeof valeur === "string" && /^0+$/.test(valeur);
  return (
    quatreEgauxNonNuls(champs.get("Uid")) &&
    quatreEgauxNonNuls(champs.get("Gid")) &&
    champs.get("Groups") === "" &&
    nul(champs.get("CapInh")) &&
    nul(champs.get("CapPrm")) &&
    nul(champs.get("CapEff")) &&
    nul(champs.get("CapAmb")) &&
    champs.get("NoNewPrivs") === "1"
  );
}

/**
 * Un tour de la boucle de l'homme mort (étape 9), sans lecture : l'appelant fournit ce qu'il a lu. Rend le code de sortie que
 * `supervisor.sh` lira. Ordre : arrêt demandé, battement périmé, point de montage déplacé (MO-3), opencode arrêté. Une empreinte
 * attendue vide (jamais figée) ou différente arrête la salle : fermé en cas de doute.
 */
export function decisionBoucle({ battement, arret, maintenantMs, empreinte, empreinteAttendue, enfantVivant }, delais = OMO_DELAIS) {
  const decision = decisionSuperviseur(battement, arret, maintenantMs, delais);
  if (decision === "arret-demande") return CODES.arret;
  if (decision === "battement-perime") return CODES.perime;
  if (!empreinteAttendue || empreinte !== empreinteAttendue) return CODES.montage;
  if (!enfantVivant) return CODES.fini;
  return CODES.ok;
}

// --- Lectures et écritures bornées ------------------------------------------------------------------------------------------------

/**
 * Texte d'un fichier, `null` si absent, illisible, pas un fichier ordinaire, ou plus gros que `maxOctets`. Ouvert sans blocage
 * (un tube nommé ne fige jamais le superviseur), vérifié sur le descripteur ouvert (aucun échange entre la vérification et la
 * lecture), puis lu au plus `maxOctets + 1` octets : un fichier de 4 Gio n'est jamais chargé, même s'il grossit pendant la lecture.
 * La taille annoncée n'est pas consultée : les fichiers de /proc annoncent 0 octet, seule la borne de lecture fait foi.
 * `suivreLiens: false` : un lien au dernier composant refuse l'ouverture elle-même (O_NOFOLLOW), pas seulement un `lstat` d'avant.
 */
export function lireTexteBorne(chemin, maxOctets = OMO_CONTROL_MAX_OCTETS, { suivreLiens = true } = {}) {
  let fd;
  try {
    const sansLien = suivreLiens ? 0 : (fs.constants.O_NOFOLLOW ?? 0);
    fd = fs.openSync(chemin, fs.constants.O_RDONLY | (fs.constants.O_NONBLOCK ?? 0) | sansLien);
    if (!fs.fstatSync(fd).isFile()) return null;
    const tampon = Buffer.alloc(maxOctets + 1);
    let lus = 0;
    for (;;) {
      const n = fs.readSync(fd, tampon, lus, tampon.length - lus, null);
      if (n === 0) break;
      lus += n;
      if (lus > maxOctets) return null;
    }
    return tampon.subarray(0, lus).toString("utf8");
  } catch {
    return null;
  } finally {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd);
      } catch {
        // Descripteur déjà fermé : rien à rendre de plus.
      }
    }
  }
}

/** Chemin temporaire d'une écriture atomique (même règle que le cockpit). */
export function cheminTemporaire(chemin, marque) {
  const sure = String(marque).replace(/[^0-9A-Za-z_-]/g, "").slice(0, 32) || "0";
  return `${chemin}.${sure}.tmp`;
}

/** Écriture atomique : fichier voisin, droits posés explicitement (le masque ne décide pas), puis `rename`. */
export function ecrireAtomique(chemin, texte, mode = 0o644) {
  const temporaire = cheminTemporaire(chemin, `${process.pid}-${randomUUID().slice(0, 8)}`);
  fs.writeFileSync(temporaire, texte, { mode });
  try {
    fs.chmodSync(temporaire, mode);
    fs.renameSync(temporaire, chemin);
  } catch (err) {
    try {
      fs.rmSync(temporaire, { force: true });
    } catch {
      // Le temporaire reste : le dossier n'est plus inscriptible, le message d'origine compte davantage.
    }
    throw err;
  }
}

export const lireBattement = (dossierControle = CHEMINS.controle) => analyserBattement(lireTexteBorne(path.join(dossierControle, FICHIERS_CONTROLE.battement)));
export const lireArret = (dossierControle = CHEMINS.controle) => analyserArret(lireTexteBorne(path.join(dossierControle, FICHIERS_CONTROLE.arret)));

/** `stop-request` du démarrage décrit par `travail`, `null` s'il n'y en a pas ou s'il vise un autre démarrage. */
export function lireArretDuDemarrage(dossierControle, travail) {
  const arret = lireArret(dossierControle);
  return arretDuDemarrage(arret, travail.startId, travail.startedAt) ? arret : null;
}
export const lirePrecheckOk = (dossierControle = CHEMINS.controle) => analyserPrecheckOk(lireTexteBorne(path.join(dossierControle, FICHIERS_CONTROLE.precheck)));
export const lireProjetsPrepares = (dossierControle = CHEMINS.controle) =>
  analyserProjetsPrepares(lireTexteBorne(path.join(dossierControle, FICHIER_PROJETS), OMO_PROJETS_MAX_OCTETS));

/** Identifiant de CE démarrage : tiré par le générateur cryptographique de node, jamais deviné ni compté. */
export const nouveauStartId = () => randomUUID();

/** Empreinte SHA-256 en hexadécimal. */
export const sha256 = (texte) => createHash("sha256").update(texte, "utf8").digest("hex");

// --- Manifeste (D-2b-32) ------------------------------------------------------------------------------------------------------

/** Lignes utiles d'un manifeste : sans blanc de fin, sans ligne vide, sans commentaire. */
const lignesManifeste = (texte) =>
  texte
    .split("\n")
    .map((ligne) => ligne.trimEnd())
    .filter((ligne) => ligne !== "" && !ligne.startsWith("#"));

/** Une référence réduite à « # amorce » est l'amorce commitée par L15a : le superviseur refuse de démarrer dessus. */
export const estAmorce = (texte) => typeof texte === "string" && /^[ \t]*#[ \t]*amorce\b/m.test(texte) && lignesManifeste(texte).length === 0;

/**
 * Compare le manifeste calculé dans le conteneur à la référence de l'image.
 * Rend `{ manifesteReference: "ok" | "amorce" | "ecart", manifestSha256 }`. Référence absente, illisible ou vide : « ecart »
 * (fermé en cas de doute). Le `manifestSha256` publié est celui du manifeste CALCULÉ, pas de la référence.
 */
export function comparerManifeste(texteActuel, texteReference) {
  const manifestSha256 = typeof texteActuel === "string" && texteActuel.length > 0 ? sha256(lignesManifeste(texteActuel).join("\n")) : "";
  if (typeof texteActuel !== "string" || lignesManifeste(texteActuel).length === 0) return { manifesteReference: "ecart", manifestSha256 };
  if (estAmorce(texteReference)) return { manifesteReference: "amorce", manifestSha256 };
  if (typeof texteReference !== "string") return { manifesteReference: "ecart", manifestSha256 };
  const attendu = lignesManifeste(texteReference);
  if (attendu.length === 0) return { manifesteReference: "ecart", manifestSha256 };
  const obtenu = lignesManifeste(texteActuel);
  const identique = attendu.length === obtenu.length && attendu.every((ligne, i) => ligne === obtenu[i]);
  return { manifesteReference: identique ? "ok" : "ecart", manifestSha256 };
}

// --- Dossiers de configuration du HOME (D-2b-33) -------------------------------------------------------------------------------

/**
 * Vu par root : le dossier existe, c'est bien un dossier (pas un lien), il appartient à `uid`, et c'est un point de montage (MO-3 :
 * un dossier de configuration qui n'est plus un montage a été remplacé, par exemple après le renommage d'un parent).
 */
export function controlerDossierRoot(chemin, uid, montages) {
  let info;
  try {
    info = fs.lstatSync(chemin);
  } catch {
    return { chemin, ok: false, raison: "absent" };
  }
  if (!info.isDirectory()) return { chemin, ok: false, raison: "pas-un-dossier" };
  if (info.uid !== uid) return { chemin, ok: false, raison: "proprietaire" };
  if (!estPointDeMontage(chemin, montages)) return { chemin, ok: false, raison: "pas-un-montage" };
  return { chemin, ok: true, raison: null };
}

/** Dossier de configuration du HOME, vu par root (D-2b-33) : dossier, à root, point de montage. */
export function controlerDossierConfigRoot(chemin, montages = pointsDeMontage()) {
  return controlerDossierRoot(chemin, 0, montages);
}

/** Vu par `node` : `test -w` DOIT échouer. Un dossier de configuration inscriptible, c'est npm et les hooks à l'exécution (JS-10). */
export function controlerDossierConfigNode(chemin, acces = accesEcriture) {
  const inscriptible = acces(chemin);
  return { chemin, ok: !inscriptible, raison: inscriptible ? "inscriptible" : null };
}

/** `access(W_OK)` : vrai si le chemin est inscriptible par l'utilisateur courant. */
export function accesEcriture(chemin) {
  try {
    fs.accessSync(chemin, fs.constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Contenu d'un dossier de configuration (ou du volume lui-même) : EXACTEMENT `.gitignore` et `omo.jsonc`, deux fichiers ordinaires
 * (jamais un lien), le premier égal à `CONFIG_HOME_GITIGNORE`, le second à `texteReference`. Tout le reste, ou une lecture
 * impossible, vaut « contenu » : fermé en cas de doute. `texteReference` nul (référence illisible) : refus aussi.
 */
export function controlerContenuConfig(chemin, texteReference) {
  const refus = { chemin, ok: false, raison: "contenu" };
  if (typeof texteReference !== "string") return refus;
  let noms;
  try {
    noms = fs.readdirSync(chemin);
  } catch {
    return refus;
  }
  if (noms.length !== 2 || !noms.includes(CONFIG_HOME_FICHIERS.gitignore) || !noms.includes(CONFIG_HOME_FICHIERS.omo)) return refus;
  const lire = (nom) => lireTexteBorne(path.join(chemin, nom), OMO_CONFIG_MAX_OCTETS, { suivreLiens: false });
  if (lire(CONFIG_HOME_FICHIERS.gitignore) !== CONFIG_HOME_GITIGNORE) return refus;
  if (lire(CONFIG_HOME_FICHIERS.omo) !== texteReference) return refus;
  return { chemin, ok: true, raison: null };
}

/**
 * Étape 1 bis (root, AVANT la validation et avant toute bascule vers `node`) : remplit le volume `omo-config` sur son montage en
 * écriture. Le dossier doit être un point de montage à root (fermé en cas de doute : absent, lien, autre propriétaire, simple
 * dossier) ; la référence est lue sans suivre de lien, bornée. Tout ce qui s'y trouve part (une relance garde le volume : rien ne
 * doit s'y accumuler, ni `omo.json`, ni dossier), puis les deux fichiers sont écrits en 0444 et relus. La référence est dans le
 * périmètre du manifeste, déjà comparé à l'étape 1 ; `validate.mjs` relit ensuite `~/.omo/omo.jsonc` par le montage en lecture seule.
 */
export function preparerConfigHome({ dossier = CHEMINS.configHome, reference = CHEMINS.configurationOmo, montages = pointsDeMontage(), uid = 0 } = {}) {
  const echec = (raison) => ({ etape: "config-home", ok: false, raison });
  const volume = controlerDossierRoot(dossier, uid, montages);
  if (!volume.ok) return echec(volume.raison);
  const texte = lireTexteBorne(reference, OMO_CONFIG_MAX_OCTETS, { suivreLiens: false });
  if (texte === null) return echec("reference-illisible");
  let noms;
  try {
    noms = fs.readdirSync(dossier);
  } catch {
    return echec("illisible");
  }
  for (const nom of noms) {
    try {
      // rmSync ne traverse pas un lien : il retire le lien lui-même.
      fs.rmSync(path.join(dossier, nom), { recursive: true, force: true });
    } catch {
      return echec("purge");
    }
  }
  try {
    ecrireAtomique(path.join(dossier, CONFIG_HOME_FICHIERS.omo), texte, 0o444);
    ecrireAtomique(path.join(dossier, CONFIG_HOME_FICHIERS.gitignore), CONFIG_HOME_GITIGNORE, 0o444);
  } catch {
    return echec("ecriture");
  }
  const relu = controlerContenuConfig(dossier, texte);
  return relu.ok ? { etape: "config-home", ok: true, raison: null, octets: tailleOctets(texte) } : echec(relu.raison);
}

/**
 * Dossier de configuration du HOME vu par root à l'étape 3 : dossier à root, point de montage (MO-3), PUIS le contenu posé à
 * l'étape 1 bis, vu par ce chemin. Un dossier monté depuis un autre volume que `omo-config` (vide, ou à `node`) est refusé ici.
 */
export function controlerDossierConfigHome(chemin, texteReference, montages = pointsDeMontage()) {
  const racine = controlerDossierConfigRoot(chemin, montages);
  return racine.ok ? controlerContenuConfig(chemin, texteReference) : racine;
}

// --- Balayage git de /workspace (D-2b-28) ---------------------------------------------------------------------------------------

/** Forme d'un `.git`, sans suivre les liens. */
export function formeGit(chemin) {
  let info;
  try {
    info = fs.lstatSync(chemin);
  } catch {
    return "absent";
  }
  if (info.isSymbolicLink()) return "lien";
  if (info.isDirectory()) return "dossier";
  if (info.isFile()) return "fichier";
  // Tube nommé, socket, périphérique : ni protégeable ni attendu, traité comme un lien (doute).
  return "lien";
}

/** Au-delà de ce nombre de casses possibles, l'énumération complète est remplacée par la paire minuscules/majuscules. */
export const ALIAS_CASSE_MAX = 64;

/**
 * Autres noms sous lesquels le MÊME dossier peut être ouvert quand le partage de l'hôte est insensible à la casse (9p/drvfs de
 * Docker Desktop : `WORKSPACE_DIR` est toujours un chemin Windows) : les variantes de casse, et les noms courts 8.3 que NTFS
 * expose encore (`.git` s'ouvre aussi par `GIT~1`). Un bind `:ro` ne porte que sur le dentry exact : par tout autre nom, le
 * dossier reste inscriptible. Liste bornée : énumération complète des casses tant qu'elle tient sous `ALIAS_CASSE_MAX`
 * (« .git » : 8 formes), sinon la seule paire minuscules/majuscules, plus quatre formes courtes. Le nom lui-même n'y est pas.
 */
/** Toutes les casses d'un nom, ou la seule paire minuscules/majuscules quand l'énumération dépasserait `ALIAS_CASSE_MAX`. */
function cassesDeNom(nom) {
  const lettres = [];
  for (let i = 0; i < nom.length; i++) if (nom[i].toLowerCase() !== nom[i].toUpperCase()) lettres.push(i);
  if (lettres.length === 0 || 2 ** lettres.length > ALIAS_CASSE_MAX) return [nom.toLowerCase(), nom.toUpperCase()];
  const formes = [];
  for (let masque = 0; masque < 2 ** lettres.length; masque++) {
    const car = [...nom];
    for (let rang = 0; rang < lettres.length; rang++) {
      const pos = lettres[rang];
      car[pos] = (masque >> rang) & 1 ? car[pos].toUpperCase() : car[pos].toLowerCase();
    }
    formes.push(car.join(""));
  }
  return formes;
}

/** Noms courts 8.3 : points de tête retirés, six caractères du corps, « ~1 » à « ~4 », extension sur trois caractères. */
function nomsCourtsDeNom(nom) {
  const sansPoints = nom.replace(/^\.+/, "");
  const dernier = sansPoints.lastIndexOf(".");
  const propre = (texte, taille) => texte.replace(/[^A-Za-z0-9]/g, "").toUpperCase().slice(0, taille);
  const corps = propre(dernier > 0 ? sansPoints.slice(0, dernier) : sansPoints, 6);
  if (corps.length === 0) return [];
  const extension = propre(dernier > 0 ? sansPoints.slice(dernier + 1) : "", 3);
  const suffixe = extension === "" ? "" : `.${extension}`;
  return [1, 2, 3, 4].map((n) => `${corps}~${n}${suffixe}`);
}

export function aliasDeNom(nom) {
  const alias = new Set([...cassesDeNom(nom), ...nomsCourtsDeNom(nom)]);
  alias.delete(nom);
  return [...alias];
}

/**
 * Formes RÉDUITES d'un nom, pour la sonde des dossiers PARENTS (L16c) : minuscules, majuscules, capitale initiale, et les quatre
 * noms courts 8.3. Pas l'énumération complète : un parent a 2 puissance (nombre de lettres) variantes (65 536 pour
 * « opencode-cockpit »), et UNE seule variante qui atteint l'écriture suffit à trahir une topologie fautive — si un alias du parent
 * contourne le montage, tous le contournent. La protection, elle, ne vient pas de cette liste : elle vient de l'ancêtre en lecture
 * seule (`sousLectureSeule`) ; la sonde n'est que le détecteur d'une topologie qui ne serait pas celle-là.
 */
export function aliasReduitsDeNom(nom) {
  const minuscules = nom.toLowerCase();
  const capitale = minuscules.charAt(0).toUpperCase() + minuscules.slice(1);
  const alias = new Set([minuscules, nom.toUpperCase(), capitale, ...nomsCourtsDeNom(nom)]);
  alias.delete(nom);
  return [...alias];
}

/**
 * Nom qui désigne `.git` pour l'hôte Windows (L16c, décision A16) : même nom à la casse près, points et espaces de fin retirés
 * (Win32 les ignore), ou nom court 8.3 (`GIT~1`). Un tel nom n'est JAMAIS ouvert en écriture, ni par install.ps1, ni par un
 * montage que la sonde accepterait.
 */
export function estNomGit(nom) {
  const normal = String(nom).toLowerCase().replace(/[. ]+$/, "");
  return normal === ".git" || /^git~\d+$/.test(normal);
}

/** Le chemin existe (lien compris, jamais suivi). */
export function existeSansSuivre(chemin) {
  try {
    fs.lstatSync(chemin);
    return true;
  } catch {
    return false;
  }
}

/** Module de chemins qui convient à `chemin` : POSIX dans le conteneur et pour un `mountinfo` simulé, Windows pour un dossier de test. */
const modulePour = (chemin) => (/^[A-Za-z]:|\\/.test(String(chemin)) ? path.win32 : path.posix);

/**
 * Autres chemins du MÊME objet sur un partage insensible à la casse : alias de la feuille (complets par défaut), et, quand `racine`
 * est donnée, alias RÉDUITS de chaque dossier parent situé sous elle (`/workspace/PROJET/.git`, `/workspace/Projet/src`), un
 * composant à la fois. Le chemin lui-même n'y est pas.
 */
export function aliasDeChemin(chemin, { racine = null, feuilleComplete = true } = {}) {
  const P = modulePour(racine ?? chemin);
  const feuille = P.basename(chemin);
  const parent = P.dirname(chemin);
  const candidats = [];
  const ajouter = (candidat) => {
    if (candidat !== chemin && !candidats.includes(candidat)) candidats.push(candidat);
  };
  if (parent !== chemin) for (const alias of feuilleComplete ? aliasDeNom(feuille) : aliasReduitsDeNom(feuille)) ajouter(P.join(parent, alias));
  if (racine !== null) {
    const relatif = P.relative(racine, parent);
    if (relatif !== "" && !relatif.startsWith("..") && !P.isAbsolute(relatif)) {
      const composants = relatif.split(P.sep);
      composants.forEach((composant, rang) => {
        for (const alias of aliasReduitsDeNom(composant)) {
          const variante = [...composants];
          variante[rang] = alias;
          ajouter(P.join(racine, ...variante, feuille));
        }
      });
    }
  }
  return candidats;
}

/**
 * SONDE de la protection d'un dépôt (relecture 2bis-vague-2, risque 11 / C2-5 ; étendue par L16c aux PARENTS) : un montage en
 * lecture seule protège un CHEMIN, pas un dossier. Sur le partage insensible à la casse de Docker Desktop Windows, `.GIT`, `.Git`,
 * `GIT~1` (alias de la feuille) et `/workspace/PROJET/.git` (alias du parent, essai 1 bis de l'arbitrage) désignent le même
 * dossier ; ils ne traversent pas un montage posé sur le seul nom exact. `readdir` ne montre pourtant que « .git ».
 *
 * Vrai dès qu'un alias EXISTE et est inscriptible : fermé en cas de doute. Aucune écriture n'est tentée dans le dépôt de
 * l'utilisateur : `access(W_OK)` est exactement la primitive qui juge déjà le `.git` lui-même.
 *
 * NE PAS « SIMPLIFIER » : `fs.lstatSync` et `fs.accessSync(W_OK)` sont les seules primitives fiables ici. Le `test -w` de busybox
 * répond « oui » sur un montage en lecture seule (mesuré, arbitrage-ro-windows.md §1) ; une sonde écrite avec lui serait verte sur
 * un poste exposé. Aucune dépendance nouvelle (P8) : `fs` seul.
 *
 * `racine` : parents sondés jusqu'à elle (exclue) ; sans elle, la feuille seule. `sauf` : chemins POSIX à ne pas juger (points de
 * montage déjà jugés pour eux-mêmes). `existe` : injectable pour les tests (partage simulé).
 */
export function aliasInscriptible(chemin, acces = accesEcriture, { racine = null, feuilleComplete = true, existe = existeSansSuivre, sauf = null } = {}) {
  for (const candidat of aliasDeChemin(chemin, { racine, feuilleComplete })) {
    if (sauf?.has(posix(candidat))) continue;
    // Absent : sur un système sensible à la casse, cet alias n'existe tout simplement pas.
    if (!existe(candidat)) continue;
    if (acces(candidat)) return true;
  }
  return false;
}

// --- Montages du dossier de travail : lecture seule par défaut, écriture par exception (L16c, décision A16, option E1) ----------

/** Chemin aux séparateurs POSIX : `/proc/self/mountinfo` ne connaît que ceux-là ; seuls les tests sous Windows en ont d'autres. */
const posix = (chemin) => String(chemin).replaceAll("\\", "/");

/**
 * Montages sous leur forme détaillée `{ point, lectureSeule, racineFs, periph, type }`. Un point donné sans ses options (chaîne
 * seule) vaut « en écriture » : on ne présume jamais la lecture seule qu'on n'a pas lue. `racineFs` (champ 4 de mountinfo : ce qui
 * est monté, dans son système de fichiers), `periph` (champ 3, major:minor) et `type` (premier champ après « - ») valent `null`
 * quand ils n'ont pas été lus : la sonde les tient alors pour douteux (fermé), jamais pour conformes.
 */
export function normaliserMontages(montages) {
  if (!Array.isArray(montages)) return [];
  const texte = (valeur) => (typeof valeur === "string" && valeur !== "" ? valeur : null);
  return montages.map((m) =>
    typeof m === "string"
      ? { point: posix(m), lectureSeule: false, racineFs: null, periph: null, type: null }
      : { point: posix(m?.point ?? ""), lectureSeule: m?.lectureSeule === true, racineFs: texte(m?.racineFs), periph: texte(m?.periph), type: texte(m?.type) },
  );
}

/**
 * Systèmes de fichiers d'un partage de l'HÔTE (Docker Desktop : 9p/drvfs sous WSL 2, virtiofs, fakeowner ou grpcfuse ailleurs).
 * Les volumes nommés (ext4 de la machine virtuelle) et les tmpfs n'en sont pas.
 */
const TYPES_PARTAGE_HOTE = /^(?:9p|drvfs|virtiofs|fakeowner|grpcfuse|osxfs|fuse(?:\.[a-z0-9_-]+)?)$/i;

/** Étiquette publiée pour un montage en écriture posé HORS du dossier de travail : jamais le chemin absolu de l'hôte. */
export const HORS_DOSSIER_DE_TRAVAIL = "(hors du dossier de travail)";

/** `chemin` est `base` ou en dessous, composant par composant (jamais par simple préfixe de texte). */
const dansChemin = (chemin, base) => chemin === base || chemin.startsWith(base === "/" ? "/" : `${base}/`);

/**
 * Vrai si `chemin` est SERVI par un montage en lecture seule : le point de montage le plus profond qui le contient (lui-même ou un
 * ancêtre) porte l'option `ro`. Plusieurs lignes pour ce point (montages empilés) : toutes doivent la porter. Aucun montage : faux.
 */
export function servieEnLectureSeule(chemin, montages) {
  const vise = posix(chemin);
  const englobants = normaliserMontages(montages).filter((m) => dansChemin(vise, m.point));
  if (englobants.length === 0) return false;
  const profond = englobants.reduce((a, b) => (b.point.length > a.point.length ? b : a)).point;
  return englobants.filter((m) => m.point === profond).every((m) => m.lectureSeule);
}

/** Montages en écriture posés sur `chemin` ou en dessous. */
export function montagesEcritureSous(chemin, montages) {
  const vise = posix(chemin);
  return normaliserMontages(montages).filter((m) => !m.lectureSeule && dansChemin(m.point, vise));
}

/**
 * Protection E1 d'un chemin (`.git`, dépôt nu, cible `gitdir:`) : servi par un ancêtre en lecture seule, et aucune écriture rouverte
 * sur lui ni en dessous. C'est la POSITION du montage qui protège (essai 6b : tout alias résolu sous un montage en lecture seule
 * hérite de sa protection), plus le nom exact d'un bind.
 */
export function sousLectureSeule(chemin, montages) {
  return servieEnLectureSeule(chemin, montages) && montagesEcritureSous(chemin, montages).length === 0;
}

/**
 * SONDE des montages du dossier de travail (L16c, décision A16 du 22/09, option E1). Le bind `.git:ro` posé SOUS un dossier ouvert
 * en écriture ne tient pas sur Docker Desktop Windows (10 alias inscriptibles mesurés : casse, 8.3, parent) ; ce qui tient, c'est
 * un ANCÊTRE en lecture seule. Exigences lues dans `/proc/self/mountinfo`, jamais déduites de l'existence d'un dossier :
 * 1. `racine` (`/workspace`) est un point de montage, et chacune de ses lignes porte l'option `ro` ;
 * 2. chaque montage en écriture sous la racine est un ENFANT DIRECT d'un projet préparé (`<racine>/<projet>/<entrée>`) ;
 * 3. ce n'est ni `.git` ni un nom qui s'y ramène (`estNomGit`), ni la racine d'un projet préparé, ni un dossier qui en contient un ;
 * 4. aucun alias de son chemin, parents compris (`/workspace/PROJET/src`), n'est inscriptible : l'écriture ne vaut qu'au chemin
 *    exact, sous lequel le noyau trouve le montage (essai E1 : 19/19 refus attendus) ;
 * 5. ce qu'il monte est bien l'entrée de l'hôte à ce chemin : sa racine dans le système de fichiers (champ 4) vaut celle de
 *    `/workspace` suivie du chemin relatif (relecture 2ter-vague-3). Une entrée remplacée sur le poste par une jonction ou un lien
 *    absolu APRÈS install.ps1 est suivie par Docker : le montage en écriture porte alors un dossier du poste HORS du dossier de
 *    travail (mesuré : `echo > /workspace/app/lien/x` écrit dans la cible) ;
 * 6. aucun montage en écriture qui vient du partage de l'hôte n'est posé HORS de la racine : Docker Desktop suit aussi, côté
 *    conteneur, le lien absolu que le partage 9p montre pour une jonction, et pose le montage sur `/mnt/host/c/…` (mesuré). Est du
 *    partage de l'hôte un montage d'un type de `TYPES_PARTAGE_HOTE`, ou du même périphérique que `/workspace` quand celui-ci en est
 *    un ; type illisible : douteux. Les volumes nommés et les tmpfs ne sont pas concernés. Publié sous `HORS_DOSSIER_DE_TRAVAIL`.
 * Rend `{ ok, racineLectureSeule, ecritures, problemes }` ; `problemes` : chemins relatifs à la racine (« . » pour la racine
 * elle-même), 20 au plus, publiés avec les `.git` non protégés dans `workspaceGit.nonProteges`. Fermé en cas de doute : un
 * `mountinfo` illisible ne donne aucune racine, donc un refus ; une racine dans le système de fichiers illisible aussi.
 */
export function controlerMontagesWorkspace(prepares, montages, { racine = CHEMINS.workspace, acces = accesEcriture, existe = existeSansSuivre } = {}) {
  const base = posix(racine).replace(/(.)\/+$/, "$1");
  const liste = normaliserMontages(montages);
  const problemes = [];
  const signaler = (relatif) => {
    if (!problemes.includes(relatif) && problemes.length < OMO_LISTE_MAX) problemes.push(relatif);
  };
  const racines = liste.filter((m) => m.point === base);
  const racineLectureSeule = racines.length > 0 && racines.every((m) => m.lectureSeule);
  if (!racineLectureSeule) signaler(".");
  // Ce que `/workspace` monte (champ 4) : une seule valeur lue, sinon rien n'est comparable (fermé).
  const sourcesRacine = [...new Set(racines.map((m) => m.racineFs))];
  const sourceRacine = sourcesRacine.length === 1 ? sourcesRacine[0] : null;
  const partage = (m) => m.type !== null && TYPES_PARTAGE_HOTE.test(m.type);
  const racinePartagee = racines.length > 0 && racines.every(partage);
  const periphRacine = racines[0]?.periph ?? null;
  // Sur le partage d'un hôte Windows, un chemin ne se distingue pas par la casse ; ailleurs, il se compare à l'octet.
  const memeSource = (a, b) => (racinePartagee ? a.toLowerCase() === b.toLowerCase() : a === b);
  const projets = (prepares?.projets ?? []).map((projet) => posix(projet.chemin));
  const points = new Set(liste.map((m) => m.point));
  for (const montage of liste) {
    if (montage.lectureSeule || dansChemin(montage.point, base)) continue;
    const duPartage = montage.type === null || partage(montage) || (racinePartagee && periphRacine !== null && montage.periph === periphRacine);
    if (duPartage) signaler(HORS_DOSSIER_DE_TRAVAIL);
  }
  const ecritures = liste.filter((m) => !m.lectureSeule && m.point.startsWith(`${base}/`));
  for (const montage of ecritures) {
    const relatif = montage.point.slice(base.length + 1);
    const parent = relatif.includes("/") ? relatif.slice(0, relatif.lastIndexOf("/")) : "";
    const nom = relatif.slice(relatif.lastIndexOf("/") + 1);
    const horsProjet = parent === "" || !projets.includes(parent);
    const contientUnProjet = projets.some((projet) => projet === relatif || projet.startsWith(`${relatif}/`));
    const sourceAttendue = sourceRacine === null ? null : sourceRacine === "/" ? `/${relatif}` : `${sourceRacine}/${relatif}`;
    const detourne = sourceAttendue === null || montage.racineFs === null || !memeSource(montage.racineFs, sourceAttendue);
    const aliasOuvert = aliasInscriptible(montage.point, acces, { racine: base, feuilleComplete: false, existe, sauf: points });
    if (horsProjet || estNomGit(nom) || contientUnProjet || detourne || aliasOuvert) signaler(relatif);
  }
  return { ok: problemes.length === 0, racineLectureSeule, ecritures: ecritures.length, problemes };
}

/** Forme d'une entrée déjà lue par `readdir` (aucun accès disque de plus) ; tout ce qui n'est ni dossier ni fichier est un doute. */
function formeDeLEntree(entree) {
  if (entree.isSymbolicLink()) return "lien";
  if (entree.isDirectory()) return "dossier";
  if (entree.isFile()) return "fichier";
  return "lien";
}

/** Cible d'un `.git` fichier (« gitdir: <chemin> », première ligne), lue bornée et sans suivre de lien ; `null` si douteuse. */
export function lireGitdir(cheminGit) {
  const texte = lireTexteBorne(cheminGit, 4096, { suivreLiens: false });
  if (texte === null) return null;
  const premiere = texte.split("\n")[0].replace(/\r$/, "");
  const trouve = /^gitdir:[ \t]*(\S(?:.*\S)?)[ \t]*$/.exec(premiere);
  return trouve ? trouve[1] : null;
}

/**
 * Le vrai dossier git d'un `.git` FICHIER (sous-module, worktree, `--separate-git-dir`, bare + worktrees) est-il protégé ? Un
 * fichier pointeur en lecture seule ne protège rien par lui-même : git écrit et exécute ce qui est au bout (config, hooks).
 * Protégé seulement si la cible, relative ou absolue du conteneur :
 * - existe, et son chemin réel est celui qu'on lit (aucun lien sur le chemin : on ne juge pas un détour) ;
 * - est DANS le dossier de travail ;
 * - est servie par un montage en lecture seule sans écriture rouverte sur elle ni dessous (`sousLectureSeule`, L16c), et n'est
 *   inscriptible par `node` ni par son nom, ni par un alias (le sien ou celui d'un parent).
 * Cible absolue de l'hôte (C:/… d'un worktree de Git for Windows), absente, illisible, hors du dossier de travail ou inscriptible :
 * non protégé. Le conteneur ne peut pas trancher, donc fermé en cas de doute.
 */
export function cibleGitdirProtegee(cheminGit, racine, montages, acces, existe = existeSansSuivre) {
  const gitdir = lireGitdir(cheminGit);
  if (gitdir === null) return false;
  let base;
  let cible;
  let racineReelle;
  try {
    base = fs.realpathSync(path.dirname(cheminGit));
    cible = path.resolve(base, gitdir);
    if (fs.realpathSync(cible) !== cible) return false;
    racineReelle = fs.realpathSync(racine);
  } catch {
    return false;
  }
  const relatif = path.relative(racineReelle, cible);
  if (relatif === "" || relatif.startsWith("..") || path.isAbsolute(relatif)) return false;
  return sousLectureSeule(cible, montages) && !acces(cible) && !aliasInscriptible(cible, acces, { racine: racineReelle, existe });
}

/**
 * Dépôt nu (`git clone --bare`, `.bare` d'un montage bare + worktrees, `x.git` servant de dépôt distant local) : à la fois un
 * fichier `HEAD`, un dossier `objects` et un dossier `refs`, comme git lui-même les reconnaît. Ses hooks et sa configuration
 * s'exécutent sur le poste comme ceux d'un `.git`.
 */
function estDepotNu(entrants) {
  const type = new Map(entrants.map((entree) => [entree.name, entree]));
  return Boolean(type.get("HEAD")?.isFile() && type.get("objects")?.isDirectory() && type.get("refs")?.isDirectory());
}

/**
 * Balaye le dossier de travail en tant que `node` et rend l'état de protection de chaque dépôt git (D-2b-28) :
 * - les liens ne sont jamais suivis (`readdir` avec les types, `lstat` seulement), `node_modules` et l'intérieur des `.git` et des
 *   dépôts nus sont sautés, la profondeur et le nombre d'entrées sont bornés ;
 * - un `.git` est « protégé » s'il est un dossier ou un fichier NON inscriptible par `node` ET servi par un montage en lecture seule
 *   sans écriture rouverte sur lui ni dessous (`sousLectureSeule`, L16c, option E1 : `/workspace` en lecture seule, écriture par
 *   exception sur les entrées de premier niveau des projets). Un `.git` servi par un montage en écriture — dépôt imbriqué dans une
 *   entrée ouverte, racine restée en écriture — n'est pas protégé. Un `.git` FICHIER ne l'est en plus que si sa cible `gitdir:`
 *   l'est (`cibleGitdirProtegee`) ;
 * - « non inscriptible » se juge AUSSI par les alias du même dossier ET de ses parents (`aliasInscriptible`) : sur le partage
 *   insensible à la casse de l'hôte Windows, `.GIT`, `GIT~1` ou `/workspace/PROJET/.git` ouvrent le dépôt hors d'un montage posé sur
 *   le seul nom exact, et `readdir` ne montre pourtant que « .git » ;
 * - un dépôt nu (`HEAD`, `objects/`, `refs/`) est protégé aux mêmes conditions qu'un `.git` dossier ;
 * - un `.git` lien, inscriptible, ou hors lecture seule, et un dépôt nu non protégé, sont listés dans `nonProteges` : un seul
 *   suffit à refuser l'activation ;
 * - plafond atteint, profondeur dépassée ou dossier illisible (racine comprise) : `limiteAtteinte`, donc « git non protégé »
 *   aussi — on ne déduit rien de ce qu'on n'a pas fini de regarder, et un dossier qu'on ne peut pas lire peut cacher un `.git` ;
 * - les liens symboliques rencontrés sont SIGNALÉS (`liens`), jamais suivis ni supprimés : posés par la salle dans une entrée
 *   ouverte en écriture, ils arrivent sur le poste comme de vrais liens (essai E1, réserve d'hygiène), et un outil de l'hôte qui
 *   suit les liens les suivrait.
 */
export function balayerGit(racine = CHEMINS.workspace, options = {}) {
  const plafond = options.plafond ?? BALAYAGE_PLAFOND;
  const profondeurMax = options.profondeurMax ?? BALAYAGE_PROFONDEUR_MAX;
  const exclus = options.exclus ?? BALAYAGE_EXCLUS;
  const acces = options.accesEcriture ?? accesEcriture;
  const montages = normaliserMontages(options.montages ?? lireMontages());
  const existe = options.existe ?? existeSansSuivre;
  const maintenant = options.maintenant ?? Date.now();
  const gitsMax = options.gitsMax ?? 200;
  const lireDossier = options.lireDossier ?? ((chemin) => fs.readdirSync(chemin, { withFileTypes: true }));
  // Sonde des alias, feuille ET parents : un dépôt ouvert par un autre nom du même dossier est ouvert, quoi que dise le montage.
  const sonde = (chemin) => aliasInscriptible(chemin, acces, { racine, existe });

  const gits = [];
  const nonProteges = [];
  const liens = [];
  let liensTotal = 0;
  let entrees = 0;
  let illisibles = 0;
  let limiteAtteinte = false;
  const pile = [{ relatif: "", profondeur: 0 }];

  /** Inscrit un dépôt trouvé ; faux quand la liste ne peut plus tout dire (plus de 20 dépôts ouverts). */
  const inscrire = (chemin, forme, inscriptible, lectureSeule, protege) => {
    if (gits.length < gitsMax) gits.push({ chemin, forme, inscriptible, lectureSeule });
    if (protege) return true;
    if (nonProteges.length < OMO_LISTE_MAX) {
      nonProteges.push(chemin);
      return true;
    }
    return false;
  };

  while (pile.length > 0 && !limiteAtteinte) {
    const { relatif, profondeur } = pile.pop();
    if (profondeur > profondeurMax) {
      limiteAtteinte = true;
      break;
    }
    const absolu = relatif === "" ? racine : path.join(racine, relatif);
    let entrants;
    try {
      entrants = lireDossier(absolu);
    } catch {
      // Illisible (EACCES, ACL refusée) ou absent : il peut cacher un `.git` inscriptible. Balayage incomplet, verdict fermé.
      illisibles++;
      limiteAtteinte = true;
      break;
    }
    if (estDepotNu(entrants)) {
      const inscriptible = acces(absolu) || (relatif !== "" && sonde(absolu));
      const lectureSeule = sousLectureSeule(absolu, montages);
      if (!inscrire(relatif === "" ? "." : relatif, "dossier", inscriptible, lectureSeule, !inscriptible && lectureSeule)) limiteAtteinte = true;
      // Comme l'intérieur d'un `.git` : jamais parcouru.
      continue;
    }
    for (const entree of entrants) {
      entrees++;
      if (entrees > plafond) {
        limiteAtteinte = true;
        break;
      }
      const cheminRelatif = relatif === "" ? entree.name : `${relatif}/${entree.name}`;
      if (entree.name === ".git") {
        const forme = formeDeLEntree(entree);
        // Un lien n'est pas protégeable par un montage : il vaut « inscriptible », sans même tenter l'accès (jamais suivi).
        const cheminGit = path.join(racine, cheminRelatif);
        // Un alias du même dossier (`.GIT`, `GIT~1`) ou d'un parent (`PROJET/.git`) qui reste inscriptible vaut « inscriptible ».
        const inscriptible = forme === "lien" ? true : acces(cheminGit) || sonde(cheminGit);
        const lectureSeule = sousLectureSeule(cheminGit, montages);
        const protege = !inscriptible && lectureSeule && (forme !== "fichier" || cibleGitdirProtegee(cheminGit, racine, montages, acces, existe));
        // Plus de 20 `.git` ouverts : la liste ne dit plus tout.
        if (!inscrire(cheminRelatif, forme, inscriptible, lectureSeule, protege)) limiteAtteinte = true;
        continue;
      }
      if (entree.isSymbolicLink()) {
        liensTotal++;
        if (liens.length < OMO_LISTE_MAX) liens.push(cheminRelatif);
        continue;
      }
      if (!entree.isDirectory()) continue;
      if (exclus.includes(entree.name)) continue;
      pile.push({ relatif: cheminRelatif, profondeur: profondeur + 1 });
    }
  }

  return { verifieLe: maintenant, limiteAtteinte, nonProteges, gits, entrees, illisibles, liens: { total: liensTotal, chemins: liens } };
}

/**
 * Partie publiée de `state.json` : les trois champs d'`OmoWorkspaceGit`, rien de plus. Un dossier illisible n'y a pas de champ à
 * lui : il pose `limiteAtteinte` (balayage incomplet), que le cockpit lit comme `workspace-non-verifie`.
 */
export const resumeWorkspaceGit = (balayage) => ({
  verifieLe: balayage.verifieLe,
  limiteAtteinte: balayage.limiteAtteinte,
  nonProteges: balayage.nonProteges.slice(0, OMO_LISTE_MAX),
});

/**
 * État des `.git` des projets préparés, vu par `node` : `access(W_OK)` doit échouer sur chacun (M32) — sur le `.git` lui-même ET
 * sur ses alias, ceux de son nom (`.GIT`, `GIT~1`) comme ceux de ses parents (`/workspace/PROJET/.git`, L16c) —, et chacun doit
 * être servi par un montage en lecture seule sans écriture rouverte sur lui (`sousLectureSeule`, option E1 ; il n'est plus un
 * point de montage à lui seul). Un `.git` devenu fichier ne l'est en plus que si sa cible `gitdir:` l'est (`cibleGitdirProtegee`).
 */
export function controlerProjetsPrepares(prepares, racine = CHEMINS.workspace, acces = accesEcriture, montages = lireMontages(), existe = existeSansSuivre) {
  const projets = [];
  if (!prepares) return projets;
  const liste = normaliserMontages(montages);
  for (const projet of prepares.projets) {
    const cheminGit = path.join(racine, projet.chemin, ".git");
    const forme = formeGit(cheminGit);
    const formeProtegee = forme === "dossier" || (forme === "fichier" && cibleGitdirProtegee(cheminGit, racine, liste, acces, existe));
    // La sonde d'alias (feuille ET parents) est appelée ici, à chaque projet préparé : les tests de croisement de l'arbitrage L21
    // n° 3 échouent si elle disparaît ou cesse de l'être.
    const gitLectureSeule =
      projet.git === "absent"
        ? forme === "absent"
        : formeProtegee && !acces(cheminGit) && !aliasInscriptible(cheminGit, acces, { racine, existe }) && sousLectureSeule(cheminGit, liste);
    projets.push({ chemin: projet.chemin, gitLectureSeule });
  }
  return projets;
}

// --- Purge (D-2b-17, D-2b-36) ---------------------------------------------------------------------------------------------------

/**
 * Montages vus depuis le conteneur, avec leur lecture seule : `/proc/self/mountinfo`, champ 5 (point de montage, caractères
 * spéciaux échappés en octal) et champ 6 (options PROPRES au montage). C'est ce champ-là qui porte le « ro » d'un bind en lecture
 * seule : les options du superbloc, après « - », disent « rw » pour tout le partage 9p de Docker Desktop et ne décident de rien
 * (mesure E1 : `/workspace ro,noatime - 9p … rw,…`). Ligne sans options : « en écriture », jamais présumée en lecture seule.
 * Sont gardés aussi, pour la sonde des montages (relecture 2ter-vague-3) : le champ 4 (`racineFs`, ce qui est monté, dans son
 * système de fichiers : là se voit une entrée suivie à travers une jonction), le champ 3 (`periph`, major:minor) et le type du
 * système de fichiers (premier champ après « - »). Liste vide si le fichier est illisible : la sonde des montages ne trouve alors
 * aucune racine et ferme la salle.
 */
export function lireMontages(fichier = "/proc/self/mountinfo") {
  const texte = lireTexteBorne(fichier, 4 * 1024 * 1024);
  if (texte === null) return [];
  // Caractères spéciaux échappés en octal par le noyau (espace, tabulation, saut de ligne, contre-oblique).
  const decoder = (champ) => champ.replaceAll(/\\([0-7]{3})/g, (_, code) => String.fromCodePoint(Number.parseInt(code, 8)));
  const montages = [];
  for (const ligne of texte.split("\n")) {
    const champs = ligne.split(" ");
    if (champs.length < 5) continue;
    // Champ 5 : point de montage.
    const point = decoder(champs[4]);
    if (!point.startsWith("/")) continue;
    // Champs optionnels (champ 7 et suivants) jusqu'au séparateur « - », puis le type du système de fichiers.
    const tiret = champs.indexOf("-", 6);
    montages.push({
      point,
      lectureSeule: (champs[5] ?? "").split(",").includes("ro"),
      racineFs: decoder(champs[3]),
      periph: champs[2],
      type: tiret > 0 && champs[tiret + 1] ? champs[tiret + 1] : null,
    });
  }
  return montages;
}

/** Points de montage vus depuis le conteneur ; liste vide si `/proc` n'est pas lisible (la purge saute alors moins de choses). */
export function pointsDeMontage(fichier = "/proc/self/mountinfo") {
  return lireMontages(fichier).map((montage) => montage.point);
}

/**
 * Vrai si `chemin` est un point de montage ou en contient un : le supprimer est impossible, et l'essayer masque les vraies erreurs.
 * Les chemins du conteneur sont POSIX ; la normalisation des séparateurs ne sert qu'aux tests joués sous Windows.
 */
export function porteUnMontage(chemin, montages) {
  const vise = chemin.replaceAll("\\", "/");
  return montages.some((point) => point === vise || point.startsWith(`${vise}/`));
}

/**
 * Vrai si `chemin` est EXACTEMENT un point de montage (MO-3). Un montage `:ro` protège le contenu, pas le chemin : `node` peut
 * renommer un PARENT (`mv ~/.config ~/.config-deplace`, `mv /workspace/p /workspace/p2`), le montage suit l'inode renommé, et un
 * dossier neuf, inscriptible, prend sa place. Seul `mountinfo` voit la différence ; les droits, eux, ne disent rien.
 */
export function estPointDeMontage(chemin, montages) {
  const vise = chemin.replaceAll("\\", "/");
  return montages.includes(vise);
}

/**
 * Empreinte de la liste des points de montage (triée) : figée juste avant le lancement d'opencode, recalculée à chaque tour de la
 * boucle. `node` n'a pas CAP_SYS_ADMIN : il ne peut ni monter ni démonter, seulement DÉPLACER un montage en renommant un parent.
 * Toute différence est donc un montage déplacé, et arrête la salle. Liste vide (mountinfo illisible) : aucune empreinte.
 */
export function empreinteMontages(montages) {
  if (!Array.isArray(montages) || montages.length === 0) return "";
  return sha256([...montages].sort().join("\n"));
}

/**
 * Vide un dossier de ce que `node` peut retirer. `gardes` : noms gardés (expressions). Ce qui résiste (racine d'un montage,
 * fichier d'un autre propriétaire) est compté, jamais tu : un HOME qui ne se vide pas est un fait à publier, pas une erreur à
 * avaler. La purge ne suit aucun lien (`rmSync` ne traverse pas un lien : il retire le lien).
 */
export function viderDossier(dossier, { gardes = [], montages = [] } = {}) {
  // Listes bornées : une session précédente (donc `node`) peut avoir semé des milliers de noms ; le constat de la purge doit
  // tenir dans la borne des 64 Kio, sinon le superviseur refuserait de repartir (fermé, mais bloqué).
  const rapport = { dossier, retires: 0, gardes: [], gardesTotal: 0, resistants: [] };
  const garder = (nom) => {
    rapport.gardesTotal++;
    if (rapport.gardes.length < OMO_LISTE_MAX) rapport.gardes.push(nom);
  };
  let entrees;
  try {
    entrees = fs.readdirSync(dossier, { withFileTypes: true });
  } catch {
    return { ...rapport, absent: true };
  }
  for (const entree of entrees) {
    const complet = path.join(dossier, entree.name);
    // Un nom gardé ne garde qu'un fichier ordinaire : `readdir` donne le type sans suivre les liens.
    if (entree.isFile() && gardes.some((garde) => garde.test(entree.name))) {
      garder(entree.name);
      continue;
    }
    if (porteUnMontage(complet, montages)) {
      garder(entree.name);
      continue;
    }
    try {
      fs.rmSync(complet, { recursive: true, force: true });
      rapport.retires++;
    } catch (err) {
      if (rapport.resistants.length < OMO_LISTE_MAX) rapport.resistants.push({ nom: entree.name, code: err?.code ?? "inconnu" });
    }
  }
  return rapport;
}

/**
 * Purge du démarrage (D-2b-27, D-2b-36, MO-2) : `/tmp`, le HOME hors montages, et le dossier de données sauf `opencode.db`,
 * `opencode.db-shm` et `opencode.db-wal` (`log/`, `snapshot/`, `tool-output/`, `repos/`, `auth.json` et tout nouveau venu partent ;
 * `auth.json` est recopié juste après). Une relance de Docker vide les tmpfs mais garde le volume (MO-8) : cette purge est la seule
 * qui le nettoie.
 */
export function purger({ tmp = CHEMINS.tmp, home = CHEMINS.home, donnees = CHEMINS.donnees, montages = pointsDeMontage() } = {}) {
  return {
    tmp: viderDossier(tmp, { montages }),
    home: viderDossier(home, { montages }),
    donnees: viderDossier(donnees, { gardes: PURGE_GARDES, montages }),
  };
}

// --- Copie d'auth.json (D-2b-26) --------------------------------------------------------------------------------------------------

/**
 * Recopie `/auth-src/auth.json` dans le dossier de données, en 0600, en tant que `node`. Le CONTENU n'est jamais journalisé, ni
 * rendu par cette fonction : le rapport ne dit que « posée », « absente » ou « trop-grosse », et la taille en octets. Source absente
 * : la copie est retirée, pour qu'une salle sans authentification ne rejoue pas celle d'avant.
 */
export function copierAuth({ source = path.join(CHEMINS.authSource, "auth.json"), donnees = CHEMINS.donnees } = {}) {
  const cible = path.join(donnees, "auth.json");
  const texte = lireTexteBorne(source, OMO_AUTH_MAX_OCTETS);
  if (texte === null) {
    let presente = false;
    try {
      presente = fs.statSync(source).isFile();
    } catch {
      presente = false;
    }
    try {
      fs.rmSync(cible, { force: true });
    } catch {
      // Cible non retirable : signalé par l'état « absente », jamais avalé en silence.
    }
    return { etat: presente ? "trop-grosse" : "absente", octets: 0 };
  }
  try {
    fs.mkdirSync(donnees, { recursive: true });
  } catch {
    // Dossier déjà là, ou non créable : l'écriture qui suit dira laquelle des deux.
  }
  ecrireAtomique(cible, texte, 0o600);
  return { etat: "posee", octets: tailleOctets(texte) };
}

// --- Dossier de travail du superviseur ------------------------------------------------------------------------------------------

/**
 * L'état en cours de construction vit dans `omo-state`, à côté de l'état publié : root seul y écrit, `node` n'y a aucun droit, et
 * il survit à la purge (qui tourne en tant que `node`). Un fichier caché, jamais publié tel quel.
 */
export const cheminTravail = (dossierEtat = CHEMINS.etat) => path.join(dossierEtat, ".superviseur.json");

export function initTravail(dossierEtat = CHEMINS.etat, maintenant = Date.now()) {
  const travail = {
    startId: nouveauStartId(),
    phase: "verification",
    imageId: lireImageId(),
    manifestSha256: "",
    manifesteReference: "ecart",
    validation: "echec",
    dossiersConfig: DOSSIERS_CONFIG_HOME.map((chemin) => ({ chemin, ok: false })),
    projets: [],
    workspaceGit: { verifieLe: maintenant, limiteAtteinte: true, nonProteges: [] },
    startedAt: maintenant,
    // Jamais publié : empreinte des points de montage, figée juste avant le lancement d'opencode (MO-3). Vide : rien n'est figé.
    montagesSha256: "",
  };
  ecrireAtomique(cheminTravail(dossierEtat), `${JSON.stringify(travail)}\n`, 0o600);
  return travail;
}

export function lireTravail(dossierEtat = CHEMINS.etat) {
  const brut = analyserObjet(lireTexteBorne(cheminTravail(dossierEtat)), OMO_CONTROL_MAX_OCTETS);
  if (!brut || !estStartId(brut.startId)) throw new Error("dossier de travail du superviseur illisible");
  return brut;
}

export function majTravail(dossierEtat, changements) {
  const travail = { ...lireTravail(dossierEtat), ...changements };
  ecrireAtomique(cheminTravail(dossierEtat), `${JSON.stringify(travail)}\n`, 0o600);
  return travail;
}

/**
 * Identifiant de l'image, publié par la construction dans `/etc/opencode-omo/image-id` (L15a). Absent : chaîne vide. Le cockpit
 * compare de son côté l'identifiant relevé par `install.ps1` : ce champ sert au Diagnostic, il ne décide de rien ici.
 */
export function lireImageId(chemin = CHEMINS.imageId) {
  const texte = lireTexteBorne(chemin, 4096);
  return texte === null ? "" : texte.trim().slice(0, 256);
}

/** Phases publiables (`OmoSupervisorPhase`). */
export const PHASES = ["verification", "attente", "opencode-lance", "arret"];

/** `state.json` publié par root : les champs d'`OmoSupervisorState`, dans l'ordre du contrat, et rien d'autre. */
export function publierEtat(dossierEtat, travail, phase) {
  if (!PHASES.includes(phase)) throw new Error(`phase inconnue: ${String(phase)}`);
  const etat = {
    startId: travail.startId,
    phase,
    imageId: travail.imageId,
    manifestSha256: travail.manifestSha256,
    manifesteReference: travail.manifesteReference,
    validation: travail.validation,
    dossiersConfig: travail.dossiersConfig,
    projets: travail.projets,
    workspaceGit: travail.workspaceGit,
    startedAt: travail.startedAt,
  };
  ecrireAtomique(path.join(dossierEtat, FICHIER_ETAT), `${JSON.stringify(etat)}\n`, 0o644);
  return etat;
}

// --- Sous-commandes appelées par supervisor.sh ------------------------------------------------------------------------------------

/** Écriture SYNCHRONE : le shell redirige cette sortie vers un fichier, et `process.exit` ne doit rien tronquer. */
const ecrire = (fd, texte) => {
  try {
    fs.writeSync(fd, texte);
  } catch {
    // Sortie fermée (journal coupé) : le code de sortie reste la seule chose que le shell lit.
  }
};

const sortie = (valeur) => ecrire(1, `${JSON.stringify(valeur)}\n`);

/**
 * Lignes d'affectation shell : la boucle de `supervisor.sh` prend ses délais ici, pour qu'il n'y ait qu'une source (D-2b-25).
 * Entiers seulement, au format `NOM=<chiffres>` : le shell les passe à `eval`, il ne doit jamais y avoir autre chose.
 */
export function delaisShell(delais = OMO_DELAIS) {
  const entier = (valeur) => Math.max(1, Math.trunc(Number(valeur) || 0));
  const lignes = [
    `OMO_BATTEMENT_S=${entier(delais.battementS)}`,
    `OMO_PERIME_S=${entier(delais.perimeS)}`,
    `OMO_VERIFICATION_S=${entier(delais.verificationS)}`,
    `OMO_KILL_APRES_S=${entier(delais.killApresS)}`,
  ];
  return `${lignes.join("\n")}\n`;
}

/**
 * Volumes de la salle vus par root (étape 3, MO-11) : chacun existe, est un dossier, a le propriétaire du contrat, et est un point de
 * montage. `/omo-state` à `node`, ce serait un état publié que l'IA pourrait réécrire (M32).
 */
export function controlerVolumesRoot(montages = pointsDeMontage(), volumes = VOLUMES_SALLE) {
  return volumes.map((v) => ({ volume: v.volume, ...controlerDossierRoot(v.chemin, v.uid, montages) }));
}

/**
 * Constat de `node` (étape 3, seconde moitié) : les cinq dossiers de configuration ET les volumes fermés à `node` (`/control`,
 * `/auth-src`, `/omo-state`) doivent tous refuser l'écriture.
 */
export function etapeConfigNode(acces = accesEcriture) {
  const dossiers = DOSSIERS_CONFIG_HOME.map((chemin) => controlerDossierConfigNode(chemin, acces));
  const volumes = VOLUMES_FERMES_A_NODE.map((chemin) => controlerDossierConfigNode(chemin, acces));
  return { etape: "config-node", ok: dossiers.every((d) => d.ok) && volumes.every((v) => v.ok), dossiers, volumes };
}

/**
 * Git du dossier de travail vu comme protégé : aucun `.git` inscriptible par `node` ou hors montage, balayage complet, et chaque
 * projet préparé en lecture seule. Faux : le superviseur ne REFUSE pas pour autant (D-2b-28 partage les rôles : il publie, le
 * cockpit n'écrit pas de `precheck-ok` et refuse l'activation) — mais il ne se déclare jamais prêt non plus, de sorte qu'opencode
 * ne démarre pas même si un `precheck-ok` apparaissait quand même.
 */
export function gitProtege(etat) {
  const balayage = etat?.workspaceGit;
  if (!balayage || balayage.limiteAtteinte !== false) return false;
  if (!Array.isArray(balayage.nonProteges) || balayage.nonProteges.length > 0) return false;
  return (etat.projets ?? []).every((projet) => projet?.gitLectureSeule === true);
}

/**
 * Constat de `node` sur les dépôts git : sonde des montages du dossier de travail (L16c : racine en lecture seule, écriture par
 * exception), `.git` des projets préparés et balayage du dossier de travail, sur UNE vue de la table des montages. Sert à l'étape 5
 * et au second balayage de l'étape 7 (`rebalayage`).
 *
 * Publication (A16 point 4, sans rien ajouter au contrat de `state.json`) : les montages refusés rejoignent les `.git` non protégés
 * dans `workspaceGit.nonProteges` (« . » quand la racine n'est pas en lecture seule), que le cockpit affiche déjà avec la phrase
 * « L'historique git de ces dossiers n'est pas protégé : la salle ne démarre pas. {liste} » (état de la salle, Diagnostic).
 * Les liens symboliques sont signalés dans le constat (`liens`) et au journal du conteneur, jamais bloquants.
 */
export function constatGit(prepares, { racine = CHEMINS.workspace, montages = lireMontages(), acces = accesEcriture, existe = existeSansSuivre, maintenant } = {}) {
  const liste = normaliserMontages(montages);
  const projets = controlerProjetsPrepares(prepares, racine, acces, liste, existe);
  const balayage = balayerGit(racine, { montages: liste, accesEcriture: acces, existe, maintenant });
  const sonde = controlerMontagesWorkspace(prepares, liste, { racine, acces, existe });
  const nonProteges = [...new Set([...sonde.problemes, ...balayage.nonProteges])].slice(0, OMO_LISTE_MAX);
  const workspaceGit = { ...resumeWorkspaceGit(balayage), nonProteges };
  return {
    ok: gitProtege({ workspaceGit, projets }),
    projets,
    workspaceGit,
    projetsPrepares: prepares === null ? null : prepares.projets.length,
    balayage: { entrees: balayage.entrees, illisibles: balayage.illisibles, gits: balayage.gits.length },
    montages: { racineLectureSeule: sonde.racineLectureSeule, ecritures: sonde.ecritures, refuses: sonde.problemes },
    liens: balayage.liens,
  };
}

/**
 * Ce que `node` dit au journal du conteneur (sortie d'erreur ; la sortie standard porte le constat JSON) : montages refusés et
 * liens symboliques trouvés. Chemins en JSON : un nom de fichier ne peut pas fabriquer une fausse ligne de journal.
 */
function journaliserConstatGit(git) {
  if (git.montages.refuses.length > 0) {
    ecrire(2, `omo-supervisor: ATTENTION: montages du dossier de travail refuses (racine non en lecture seule, ou ecriture ouverte ailleurs que sur une entree de premier niveau d'un projet prepare, sur .git, par un alias, a travers un lien ou une jonction, ou hors du dossier de travail ; relancez install.ps1) : ${git.montages.refuses.map((c) => JSON.stringify(c)).join(", ")}\n`);
  }
  if (git.liens.total > 0) {
    ecrire(2, `omo-supervisor: ATTENTION: ${git.liens.total} lien(s) symbolique(s) dans le dossier de travail, presents aussi sur le poste (signales, jamais suivis ni supprimes) : ${git.liens.chemins.map((c) => JSON.stringify(c)).join(", ")}\n`);
  }
}

/** Constat de `node` sur les étapes 4 et 5 : purge, copie d'`auth.json`, `.git` des projets préparés, balayage du dossier de travail. */
function etapePreparation(dossierControle) {
  // Une seule lecture de la table des montages pour toute l'étape : purge, projets et balayage jugent sur la même vue.
  const montages = lireMontages();
  const purge = purger({ montages: montages.map((m) => m.point) });
  const auth = copierAuth();
  const git = constatGit(lireProjetsPrepares(dossierControle), { montages });
  journaliserConstatGit(git);
  return { etape: "preparation", ok: git.ok, purge, auth, ...git };
}

/**
 * Second balayage (étape 7, juste avant le lancement) : l'attente d'un battement et du `precheck-ok` n'a pas de limite (démarrage
 * de la machine, salle fermée ou suspendue, cockpit absent), et un dépôt cloné pendant ce temps n'était pas dans le premier
 * balayage. Mêmes contrôles que l'étape 5, sans purge ni copie : rien de ce qu'a préparé l'étape 4 n'est refait. Opencode ne tourne
 * pas encore : aucun processus de `node` ne peut fausser ce constat.
 */
function etapeRebalayage(dossierControle) {
  const git = constatGit(lireProjetsPrepares(dossierControle));
  journaliserConstatGit(git);
  return { etape: "rebalayage", ...git };
}

/**
 * Absorbe le constat d'une étape de `node` (fichier JSON écrit par root) dans le dossier de travail. Un chemin absent du constat
 * vaut « inscriptible » : seul un « non » explicite de `node` compte.
 */
export function absorber(dossierEtat, fichier) {
  const constat = analyserObjet(lireTexteBorne(fichier), OMO_CONTROL_MAX_OCTETS);
  if (!constat || typeof constat.ok !== "boolean") return { ok: false, raison: "constat illisible" };
  if (constat.etape === "config-node") {
    const vus = new Map((Array.isArray(constat.dossiers) ? constat.dossiers : []).map((d) => [d?.chemin, d?.ok === true]));
    const travail = lireTravail(dossierEtat);
    const dossiersConfig = travail.dossiersConfig.map((d) => ({ chemin: d.chemin, ok: d.ok && vus.get(d.chemin) === true }));
    majTravail(dossierEtat, { dossiersConfig });
    const volumes = new Map((Array.isArray(constat.volumes) ? constat.volumes : []).map((v) => [v?.chemin, v?.ok === true]));
    const volumesFermes = VOLUMES_FERMES_A_NODE.every((chemin) => volumes.get(chemin) === true);
    return { ok: dossiersConfig.every((d) => d.ok) && volumesFermes, raison: "dossiers de configuration et volumes fermes a node" };
  }
  if (constat.etape === "preparation" || constat.etape === "rebalayage") {
    const travail = majTravail(dossierEtat, { projets: constat.projets ?? [], workspaceGit: constat.workspaceGit });
    // Absorber a REUSSI même si le dossier de travail n'est pas protégé : ce fait est publié, il ne refuse pas le démarrage ici.
    return { ok: true, raison: constat.etape, gitProtege: gitProtege(travail) };
  }
  return { ok: false, raison: "etape inconnue" };
}

/**
 * Sous-commandes de `supervisor.sh`. Les chemins ne sont JAMAIS pris dans l'environnement : ils viennent du contrat, et d'ailleurs
 * la salle n'a qu'une liste blanche fermée de variables (D-2b-39). `dossiers` ne sert qu'aux tests, qui passent un volume d'état et
 * un volume de contrôle temporaires ; `supervisor.sh` ne le passe jamais (les chemins du contrat s'appliquent).
 */
function principal(argv, dossiers) {
  const [commande, ...reste] = argv;
  const dossierEtat = dossiers.etat;
  const dossierControle = dossiers.controle;
  switch (commande) {
    case "delais-sh": {
      ecrire(1, delaisShell());
      return CODES.ok;
    }
    case "start-id": {
      ecrire(1, `${nouveauStartId()}\n`);
      return CODES.ok;
    }
    case "init": {
      initTravail(dossierEtat);
      return CODES.ok;
    }
    case "manifeste": {
      const actuel = lireTexteBorne(reste[0] ?? "", OMO_MANIFESTE_MAX_OCTETS);
      const reference = lireTexteBorne(CHEMINS.referenceManifeste, OMO_MANIFESTE_MAX_OCTETS);
      const verdict = comparerManifeste(actuel, reference);
      majTravail(dossierEtat, verdict);
      sortie(verdict);
      return verdict.manifesteReference === "ok" ? CODES.ok : CODES.refus;
    }
    case "validation": {
      const code = Number(reste[0]);
      const validation = code === 0 ? "ok" : "echec";
      majTravail(dossierEtat, { validation });
      sortie({ validation, code });
      return validation === "ok" ? CODES.ok : CODES.refus;
    }
    case "config-home": {
      const constat = preparerConfigHome();
      sortie(constat);
      return constat.ok ? CODES.ok : CODES.refus;
    }
    case "config-root": {
      const montages = pointsDeMontage();
      const reference = lireTexteBorne(CHEMINS.configurationOmo, OMO_CONFIG_MAX_OCTETS, { suivreLiens: false });
      const dossiers = DOSSIERS_CONFIG_HOME.map((chemin) => controlerDossierConfigHome(chemin, reference, montages));
      majTravail(dossierEtat, { dossiersConfig: dossiers.map((d) => ({ chemin: d.chemin, ok: d.ok })) });
      sortie({ etape: "config-root", ok: dossiers.every((d) => d.ok), dossiers });
      return dossiers.every((d) => d.ok) ? CODES.ok : CODES.refus;
    }
    case "volumes-root": {
      const volumes = controlerVolumesRoot();
      sortie({ etape: "volumes-root", ok: volumes.every((v) => v.ok), volumes });
      return volumes.every((v) => v.ok) ? CODES.ok : CODES.refus;
    }
    case "capacites": {
      // Lancé par setpriv, en tant que node : le processus juge SES capacités (MO-7). Le contenu de status n'est pas rendu.
      const ok = capacitesNulles(lireTexteBorne("/proc/self/status", OMO_CONTROL_MAX_OCTETS));
      sortie({ etape: "capacites", ok });
      return ok ? CODES.ok : CODES.refus;
    }
    case "config-node": {
      const constat = etapeConfigNode();
      sortie(constat);
      return constat.ok ? CODES.ok : CODES.refus;
    }
    case "preparation": {
      const constat = etapePreparation(dossierControle);
      sortie(constat);
      return constat.ok ? CODES.ok : CODES.refus;
    }
    case "rebalayage": {
      const constat = etapeRebalayage(dossierControle);
      sortie(constat);
      return constat.ok ? CODES.ok : CODES.refus;
    }
    case "absorber": {
      const verdict = absorber(dossierEtat, reste[0] ?? "");
      sortie(verdict);
      return verdict.ok ? CODES.ok : CODES.refus;
    }
    case "publier": {
      const phase = reste[0] ?? "verification";
      publierEtat(dossierEtat, lireTravail(dossierEtat), phase);
      return CODES.ok;
    }
    case "pret": {
      const travail = lireTravail(dossierEtat);
      return decisionPret({
        travail,
        // decisionPret ne retient que l'arrêt de CE démarrage : celui d'un démarrage précédent, resté dans le volume, a déjà été honoré.
        arret: lireArret(dossierControle),
        battement: lireBattement(dossierControle),
        precheck: lirePrecheckOk(dossierControle),
        maintenantMs: Date.now(),
      });
    }
    case "figer-montages": {
      // Juste avant le lancement d'opencode, par root : la vue que la boucle défendra (MO-3). Aucune table lisible : refus.
      const empreinte = empreinteMontages(pointsDeMontage());
      if (!empreinte) return CODES.refus;
      majTravail(dossierEtat, { montagesSha256: empreinte });
      return CODES.ok;
    }
    case "verifier": {
      // Un seul node par tour de boucle : volume de contrôle d'abord (il l'emporte), puis montages, puis présence d'opencode.
      const travail = lireTravail(dossierEtat);
      return decisionBoucle({
        battement: lireBattement(dossierControle),
        arret: lireArretDuDemarrage(dossierControle, travail),
        maintenantMs: Date.now(),
        empreinte: empreinteMontages(pointsDeMontage()),
        empreinteAttendue: travail.montagesSha256,
        enfantVivant: reste[0] === undefined ? true : vivant(reste[0]),
      });
    }
    case "vivant": {
      return vivant(reste[0] ?? "") ? CODES.ok : CODES.fini;
    }
    default: {
      ecrire(2, `omo-supervisor: sous-commande inconnue: ${String(commande)}\n`);
      return CODES.refus;
    }
  }
}

/**
 * Point d'entrée, exporté pour les tests ; rend le code de sortie au lieu de le poser. Toute erreur vaut « refus ». `dossiers` :
 * volume d'état et volume de contrôle, ceux du contrat par défaut (le shell ne passe jamais rien d'autre).
 */
export function executer(argv, dossiers = { etat: CHEMINS.etat, controle: CHEMINS.controle }) {
  try {
    return principal(argv, dossiers);
  } catch (err) {
    ecrire(2, `omo-supervisor: ${err?.message ?? String(err)}\n`);
    return CODES.refus;
  }
}

// Lancé par `supervisor.sh` : le code de sortie est TOUT ce que le shell lit. Importé par un test : rien ne s'exécute.
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(executer(process.argv.slice(2)));
}
