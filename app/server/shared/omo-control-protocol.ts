// Protocole de contrôle de la Salle OMO (plan 2 bis §6 L17a ; spéc. §3.15.2 l.499-517, §3.12.1 l.400-406, §7.5 l.1145, G9, G14) :
// module PUR (ni « node: », ni process, ni horloge, ni aléa), partagé par le cockpit, les tests et — à l'identique de forme, jamais
// par import — `docker/opencode-omo/supervisor-lib.mjs`, qui tourne dans l'image sans aucune dépendance.
//
// Quatre fichiers passent du cockpit au superviseur par le volume `control-omo`, monté `/control:ro` dans la salle, plus un fichier
// publié en sens inverse par le superviseur dans `omo-state` :
// - `heartbeat` : le cockpit le réécrit toutes les `battementS` secondes tant qu'il est vivant ; passé `perimeS`, le superviseur
//   arrête opencode (homme mort, G9) ;
// - `stop-request` : arrêt immédiat demandé par le cockpit, avec sa cause (§3.12.1 l.404), pour le démarrage qu'il arrête
//   (`startId`) : la relance à neuf qui suit a un autre `startId`, et le même fichier, resté là, ne la fait pas sortir ;
// - `precheck-ok` : le pré-contrôle des projets ouverts est passé, pour CE démarrage (`startId`) et pour lui seul ;
// - `guard-state.json` : ce que le plugin de garde (filet, L24) doit refuser ;
// - `state.json` : ce que le superviseur a constaté, republié à chaque phase.
//
// Deux règles tiennent tout le protocole :
// 1. **Fermé en cas de doute** : un fichier absent, illisible, mal formé ou de plus de 64 Kio vaut « inconnu » (`null`), et
//    « inconnu » ne démarre ni ne maintient jamais rien. Un `heartbeat` daté de l'avenir de plus de `perimeS` est refusé aussi :
//    sans cela, une horloge faussée tiendrait l'homme mort en échec pour toujours.
// 2. **Écriture atomique** : on écrit dans un fichier voisin puis on renomme (`cheminTemporaire`). Un lecteur ne voit donc jamais
//    un fichier à moitié écrit, et n'a pas à distinguer « en cours d'écriture » de « corrompu ». Et l'écrivain ne rend un texte
//    qu'après l'avoir relu avec le lecteur de son format : ce que le lecteur dirait « inconnu » est refusé à l'écriture, jamais
//    écrit (sinon, un pré-contrôle perdu sans que personne ne le sache, et une salle qui attend sans fin).
//
// Les fonctions d'écriture rendent le TEXTE à écrire ; l'écriture elle-même (atomique, bornée) appartient aux modules qui touchent
// au disque : `omo-control.ts` côté cockpit (L17b) et `supervisor-lib.mjs` côté image.

// --- Bornes et délais (D-2b-25) -------------------------------------------------------------------------------------------------

/** 64 Kio : au-delà, un fichier de contrôle vaut « inconnu ». Le lecteur borne AUSSI sa lecture, il ne lit jamais 64 Kio de plus. */
export const OMO_CONTROL_MAX_OCTETS = 65_536;

/**
 * 20 chemins au plus dans `workspaceGit.nonProteges` : une liste, pas un inventaire. `precheck-ok` n'a PAS cette borne : la portée
 * « prepares » (D-2b-35) y met tous les projets préparés, souvent plus de 20 ; seuls les 64 Kio et la longueur de chaque chemin
 * le bornent (plusieurs centaines de projets).
 */
export const OMO_LISTE_MAX = 20;

/** Délais de l'homme mort, en secondes (D-2b-25). Mêmes valeurs dans `supervisor-lib.mjs` (égalité vérifiée par un test). */
export interface OmoDelais {
  /** Le cockpit réécrit `heartbeat` toutes les `battementS` secondes. */
  readonly battementS: number;
  /** Battement plus vieux que `perimeS` : le superviseur arrête opencode. */
  readonly perimeS: number;
  /** Le superviseur relit `heartbeat` et `stop-request` toutes les `verificationS` secondes. */
  readonly verificationS: number;
  /** TERM, puis KILL `killApresS` secondes plus tard. */
  readonly killApresS: number;
}

export const OMO_DELAIS: OmoDelais = { battementS: 5, perimeS: 20, verificationS: 2, killApresS: 3 };

/** Marge ajoutée à la borne : démarrage du contrôle, écriture du fichier, ordonnancement. */
export const OMO_MARGE_HOMME_MORT_S = 2;

/** Phrase garantie à l'utilisateur (§7.5 l.1145, textes de T3a) : « 30 secondes au plus ». La borne calculée doit tenir dessous. */
export const OMO_BORNE_HOMME_MORT_MAX_S = 30;

/**
 * Pire cas, en secondes, entre le DERNIER battement écrit et la mort d'opencode : le battement vieillit `perimeS`, la vérification
 * suivante arrive au plus tard `verificationS` après, le KILL `killApresS` après le TERM, plus la marge. Avec `OMO_DELAIS` :
 * 20 + 2 + 3 + 2 = 27 s, sous les 30 s promises.
 */
export function borneHommeMort(delais: OmoDelais = OMO_DELAIS): number {
  return delais.perimeS + delais.verificationS + delais.killApresS + OMO_MARGE_HOMME_MORT_S;
}

/** Vrai si ces délais tiennent la promesse des 30 secondes. */
export function delaisTiennentLaPromesse(delais: OmoDelais = OMO_DELAIS): boolean {
  return borneHommeMort(delais) <= OMO_BORNE_HOMME_MORT_MAX_S;
}

// --- Noms de fichiers (contrat `contrat-salle.json`, plan §4.1.4) -----------------------------------------------------------------

/** Fichiers du volume de contrôle, écrits par le cockpit, lus par le superviseur et par le plugin de garde. */
export const OMO_FICHIERS_CONTROLE = {
  battement: "heartbeat",
  arret: "stop-request",
  precheck: "precheck-ok",
  garde: "guard-state.json",
} as const;

/** État publié par le superviseur dans `omo-state`, relu borné par le cockpit. */
export const OMO_FICHIER_ETAT = "state.json";

/** Projets préparés, écrits par `install.ps1` (D-2b-12, D-2b-28), déposés dans le volume de contrôle par le cockpit. */
export const OMO_FICHIER_PROJETS = "omo-projets.json";

// --- Formes des fichiers -----------------------------------------------------------------------------------------------------

/** `heartbeat` : le cockpit est vivant à cette heure (ms depuis l'époque Unix). */
export interface OmoBattement {
  at: number;
}

/**
 * Cause d'un arrêt de la salle (union propre à ce module) : `OmoStopCause` de T3a, plus « fin-de-demande », la relance à neuf de
 * la fin de chaque demande (D-2b-29), que le port de contrôle écrit aussi (`requestStop(cause: OmoRecreationRaison)`). Égalité avec
 * `OmoRecreationRaison` vérifiée au train de V0 (croisements-2bis-v0.test.ts). Seul le cockpit écrit `stop-request` ;
 * « homme-mort » n'y figure que pour un arrêt décidé par le cockpit après avoir vu l'homme mort du côté salle.
 */
export type OmoArretCause =
  | "vous"
  | "plafond-cout"
  | "plafond-duree"
  | "plafond-sessions"
  | "plafond-tentatives"
  | "seuil-mensuel"
  | "hors-controle"
  | "homme-mort"
  | "redemarrage-cockpit"
  | "fin-de-demande";

export const OMO_ARRET_CAUSES: readonly OmoArretCause[] = [
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
 * `stop-request` : arrêt demandé par le cockpit pour UN démarrage. `startId` est celui que le cockpit a lu dans `state.json` ; `null`
 * quand l'état est inconnu (absent, illisible) : l'arrêt vaut alors pour le démarrage en cours à sa date (`arretDuDemarrage`).
 * Rien n'efface ce fichier : c'est ce lien qui empêche un arrêt déjà honoré de faire sortir chaque relance à neuf (D-2b-29).
 */
export interface OmoArret {
  at: number;
  cause: OmoArretCause;
  startId: string | null;
}

/** Empreinte d'un projet contrôlé, écrite dans `precheck-ok` (relue par le cockpit, jamais par la salle). */
export interface OmoPrecheckOkProjet {
  chemin: string;
  sha256: string;
}

/** `precheck-ok` : pré-contrôle passé pour CE démarrage. Un `startId` différent ne démarre rien (T-L17-b). */
export interface OmoPrecheckOk {
  startId: string;
  at: number;
  projets: OmoPrecheckOkProjet[];
}

/** Outil que le plugin de garde (filet, L24) refuse quand l'état le demande. */
export type OmoGuardTool = "task" | "call_omo_agent";

export const OMO_GUARD_TOOLS: readonly OmoGuardTool[] = ["task", "call_omo_agent"];

/** `guard-state.json` : écrit par le cockpit, lu par le plugin de garde. */
export interface OmoGuardState {
  version: 1;
  at: number;
  bloquer: OmoGuardTool[];
}

/** Forme d'un `.git` trouvé dans le dossier de travail (D-2b-28). */
export type OmoGitForme = "dossier" | "fichier" | "lien" | "absent";

export const OMO_GIT_FORMES: readonly OmoGitForme[] = ["dossier", "fichier", "lien", "absent"];

/** Balayage de `/workspace` fait par le superviseur en tant que `node` (D-2b-28). */
export interface OmoWorkspaceGit {
  /** Heure du balayage (ms depuis l'époque Unix). */
  verifieLe: number;
  /** Plafond d'entrées atteint : le balayage n'a pas tout vu, donc « git non protégé ». */
  limiteAtteinte: boolean;
  /** `.git` non protégés (lien, inscriptible par `node`, ou hors d'un point de montage, MO-3) : `OMO_LISTE_MAX` chemins au plus, relatifs à `/workspace`. */
  nonProteges: string[];
}

/** Phase publiée par le superviseur. */
export type OmoSupervisorPhase = "verification" | "attente" | "opencode-lance" | "arret";

export const OMO_SUPERVISOR_PHASES: readonly OmoSupervisorPhase[] = ["verification", "attente", "opencode-lance", "arret"];

/** `state.json` : ce que le superviseur a constaté. Un état invalide ou trop gros vaut « inconnu » pour le cockpit. */
export interface OmoSupervisorState {
  startId: string;
  phase: OmoSupervisorPhase;
  /** Identifiant de l'image, vide si l'image ne le publie pas. */
  imageId: string;
  manifestSha256: string;
  manifesteReference: "ok" | "amorce" | "ecart";
  validation: "ok" | "echec";
  dossiersConfig: { chemin: string; ok: boolean }[];
  projets: { chemin: string; gitLectureSeule: boolean }[];
  workspaceGit: OmoWorkspaceGit;
  /** ms depuis l'époque Unix. */
  startedAt: number;
}

// --- Petits contrôles (fermé en cas de doute) ---------------------------------------------------------------------------------

/** Taille en octets du texte UTF-8, sans passer par « node: ». */
export function tailleOctets(texte: string): number {
  return new TextEncoder().encode(texte).length;
}

const estObjet = (valeur: unknown): valeur is Record<string, unknown> => typeof valeur === "object" && valeur !== null && !Array.isArray(valeur);

/** Entier fini, positif ou nul, dans les bornes d'un horodatage en millisecondes plausible (jusqu'à l'an 10 000). */
const estHorodatage = (valeur: unknown): valeur is number => typeof valeur === "number" && Number.isSafeInteger(valeur) && valeur >= 0 && valeur <= 253_402_300_799_999;

const estTexte = (valeur: unknown, maxLongueur: number): valeur is string => typeof valeur === "string" && valeur.length > 0 && valeur.length <= maxLongueur;

const estSha256 = (valeur: unknown): valeur is string => typeof valeur === "string" && /^[0-9a-f]{64}$/.test(valeur);

/** `startId` : identifiant rendu par `crypto.randomUUID()` dans l'image, comparé à l'octet. */
export const estStartId = (valeur: unknown): valeur is string => typeof valeur === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(valeur);

/**
 * JSON d'un fichier de contrôle : `null` (« inconnu ») si le texte est absent, plus gros que la borne, ou n'est pas un objet JSON.
 * Un tableau, un nombre ou une chaîne au premier niveau valent « inconnu » : tous nos formats sont des objets.
 */
export function analyserObjet(texte: string | null | undefined, maxOctets: number = OMO_CONTROL_MAX_OCTETS): Record<string, unknown> | null {
  if (typeof texte !== "string" || texte.length === 0) return null;
  if (tailleOctets(texte) > maxOctets) return null;
  let brut: unknown;
  try {
    brut = JSON.parse(texte);
  } catch {
    return null;
  }
  return estObjet(brut) ? brut : null;
}

// --- Analyse ------------------------------------------------------------------------------------------------------------------

export function analyserBattement(texte: string | null | undefined): OmoBattement | null {
  const brut = analyserObjet(texte);
  if (!brut || !estHorodatage(brut.at)) return null;
  return { at: brut.at };
}

export function analyserArret(texte: string | null | undefined): OmoArret | null {
  const brut = analyserObjet(texte);
  if (!brut || !estHorodatage(brut.at)) return null;
  const cause = brut.cause;
  // Cause inconnue : l'arrêt reste un arrêt (on ne refuse jamais de s'arrêter), la cause devient « vous ».
  const connue = OMO_ARRET_CAUSES.find((c) => c === cause);
  // Démarrage absent ou mal formé : l'arrêt reste un arrêt, rattaché au démarrage par sa date.
  return { at: brut.at, cause: connue ?? "vous", startId: estStartId(brut.startId) ? brut.startId : null };
}

export function analyserPrecheckOk(texte: string | null | undefined): OmoPrecheckOk | null {
  const brut = analyserObjet(texte);
  if (!brut || !estHorodatage(brut.at) || !estStartId(brut.startId)) return null;
  // Aucune borne en nombre : les 64 Kio d'`analyserObjet` et les 4 096 caractères de chaque chemin suffisent (D-2b-35).
  if (!Array.isArray(brut.projets)) return null;
  const projets: OmoPrecheckOkProjet[] = [];
  for (const entree of brut.projets) {
    if (!estObjet(entree) || !estTexte(entree.chemin, 4096) || !estSha256(entree.sha256)) return null;
    projets.push({ chemin: entree.chemin, sha256: entree.sha256 });
  }
  return { startId: brut.startId, at: brut.at, projets };
}

export function analyserGuardState(texte: string | null | undefined): OmoGuardState | null {
  const brut = analyserObjet(texte);
  if (!brut || brut.version !== 1 || !estHorodatage(brut.at) || !Array.isArray(brut.bloquer)) return null;
  const bloquer: OmoGuardTool[] = [];
  for (const outil of brut.bloquer) {
    const connu = OMO_GUARD_TOOLS.find((o) => o === outil);
    // Outil inconnu : le filet ne sait pas le refuser, l'état entier vaut « inconnu » (fermé en cas de doute).
    if (!connu) return null;
    if (!bloquer.includes(connu)) bloquer.push(connu);
  }
  return { version: 1, at: brut.at, bloquer };
}

function analyserWorkspaceGit(valeur: unknown): OmoWorkspaceGit | null {
  if (!estObjet(valeur) || !estHorodatage(valeur.verifieLe) || typeof valeur.limiteAtteinte !== "boolean") return null;
  if (!Array.isArray(valeur.nonProteges) || valeur.nonProteges.length > OMO_LISTE_MAX) return null;
  const nonProteges: string[] = [];
  for (const chemin of valeur.nonProteges) {
    if (!estTexte(chemin, 4096)) return null;
    nonProteges.push(chemin);
  }
  return { verifieLe: valeur.verifieLe, limiteAtteinte: valeur.limiteAtteinte, nonProteges };
}

export function analyserEtat(texte: string | null | undefined): OmoSupervisorState | null {
  const brut = analyserObjet(texte);
  if (!brut || !estStartId(brut.startId) || !estHorodatage(brut.startedAt)) return null;
  const phase = OMO_SUPERVISOR_PHASES.find((p) => p === brut.phase);
  if (!phase) return null;
  if (typeof brut.imageId !== "string" || brut.imageId.length > 256) return null;
  if (typeof brut.manifestSha256 !== "string" || (brut.manifestSha256 !== "" && !estSha256(brut.manifestSha256))) return null;
  if (brut.manifesteReference !== "ok" && brut.manifesteReference !== "amorce" && brut.manifesteReference !== "ecart") return null;
  if (brut.validation !== "ok" && brut.validation !== "echec") return null;
  if (!Array.isArray(brut.dossiersConfig) || !Array.isArray(brut.projets)) return null;
  const dossiersConfig: { chemin: string; ok: boolean }[] = [];
  for (const entree of brut.dossiersConfig) {
    if (!estObjet(entree) || !estTexte(entree.chemin, 4096) || typeof entree.ok !== "boolean") return null;
    dossiersConfig.push({ chemin: entree.chemin, ok: entree.ok });
  }
  const projets: { chemin: string; gitLectureSeule: boolean }[] = [];
  for (const entree of brut.projets) {
    if (!estObjet(entree) || !estTexte(entree.chemin, 4096) || typeof entree.gitLectureSeule !== "boolean") return null;
    projets.push({ chemin: entree.chemin, gitLectureSeule: entree.gitLectureSeule });
  }
  const workspaceGit = analyserWorkspaceGit(brut.workspaceGit);
  if (!workspaceGit) return null;
  return {
    startId: brut.startId,
    phase,
    imageId: brut.imageId,
    manifestSha256: brut.manifestSha256,
    manifesteReference: brut.manifesteReference,
    validation: brut.validation,
    dossiersConfig,
    projets,
    workspaceGit,
    startedAt: brut.startedAt,
  };
}

// --- Écriture -----------------------------------------------------------------------------------------------------------------

/** Un texte de contrôle qui ne tient pas dans la borne : refusé à l'écriture plutôt que rendu illisible à la lecture. */
export class OmoControlTropGrosError extends Error {
  constructor(nom: string, octets: number) {
    super(`fichier de contrôle « ${nom} » : ${octets} octets, ${OMO_CONTROL_MAX_OCTETS} au plus`);
    this.name = "OmoControlTropGrosError";
  }
}

/**
 * Un texte de contrôle que son propre lecteur relirait « inconnu » (horodatage négatif, identifiant de démarrage mal formé, chemin
 * trop long, empreinte en majuscules…) : refusé à l'écriture, avec une erreur explicite, plutôt qu'écrit puis ignoré en silence.
 */
export class OmoControlInvalideError extends Error {
  constructor(nom: string) {
    super(`fichier de contrôle « ${nom} » : contenu que son lecteur ne relirait pas`);
    this.name = "OmoControlInvalideError";
  }
}

/**
 * JSON sur une ligne, saut de ligne final, taille vérifiée, puis relu par le lecteur du format : ce que le module d'écriture pose
 * dans le fichier temporaire est donc toujours relu tel quel, par le cockpit comme par la salle (vecteurs communs).
 */
function rendre(nom: string, valeur: unknown, lecteur: (texte: string) => unknown): string {
  const texte = `${JSON.stringify(valeur)}\n`;
  const octets = tailleOctets(texte);
  if (octets > OMO_CONTROL_MAX_OCTETS) throw new OmoControlTropGrosError(nom, octets);
  if (lecteur(texte) === null) throw new OmoControlInvalideError(nom);
  return texte;
}

export const ecrireBattement = (at: number): string => rendre(OMO_FICHIERS_CONTROLE.battement, { at } satisfies OmoBattement, analyserBattement);

/** `startId` : celui du démarrage à arrêter, lu dans `state.json` ; `null` si l'état est inconnu (arrêt rattaché par sa date). */
export const ecrireArret = (at: number, cause: OmoArretCause, startId: string | null): string =>
  rendre(OMO_FICHIERS_CONTROLE.arret, { at, cause, startId } satisfies OmoArret, analyserArret);

export const ecrirePrecheckOk = (startId: string, at: number, projets: readonly OmoPrecheckOkProjet[]): string =>
  rendre(OMO_FICHIERS_CONTROLE.precheck, { startId, at, projets: [...projets] } satisfies OmoPrecheckOk, analyserPrecheckOk);

export const ecrireGuardState = (at: number, bloquer: readonly OmoGuardTool[]): string =>
  rendre(OMO_FICHIERS_CONTROLE.garde, { version: 1, at, bloquer: [...bloquer] } satisfies OmoGuardState, analyserGuardState);

export const ecrireEtat = (etat: OmoSupervisorState): string => rendre(OMO_FICHIER_ETAT, etat, analyserEtat);

/**
 * Chemin du fichier temporaire d'une écriture atomique : `<chemin>.<marque>.tmp`, puis `rename` sur `<chemin>`. La marque est
 * fournie par l'appelant (aléa ou numéro de processus) : ce module est pur, il ne tire rien lui-même. Elle est réduite aux
 * caractères sûrs pour qu'un appelant distrait ne sorte jamais du dossier.
 */
export function cheminTemporaire(chemin: string, marque: string): string {
  const sure = marque.replace(/[^0-9A-Za-z_-]/g, "").slice(0, 32) || "0";
  return `${chemin}.${sure}.tmp`;
}

// --- Décisions de l'homme mort ------------------------------------------------------------------------------------------------

/**
 * Battement frais : présent, pas plus vieux que `perimeS`, et pas daté de l'avenir de plus de `perimeS` (horloge faussée : fermé
 * en cas de doute). « inconnu » n'est jamais frais.
 */
export function battementFrais(battement: OmoBattement | null, maintenantMs: number, delais: OmoDelais = OMO_DELAIS): boolean {
  if (!battement) return false;
  const age = maintenantMs - battement.at;
  return age <= delais.perimeS * 1000 && age >= -delais.perimeS * 1000;
}

/** Âge du battement en millisecondes, `null` si « inconnu ». Sert au Diagnostic ; un âge négatif reste tel quel, sans mensonge. */
export function ageBattementMs(battement: OmoBattement | null, maintenantMs: number): number | null {
  return battement ? maintenantMs - battement.at : null;
}

/**
 * `precheck-ok` du démarrage en cours : même `startId`, et pas daté de l'avenir de plus de `perimeS`. Un `precheck-ok` d'un
 * démarrage précédent ne vaut rien : c'est ce qui empêche un redémarrage de repartir sur un pré-contrôle périmé (T-L17-b).
 */
export function precheckDuDemarrage(precheck: OmoPrecheckOk | null, startId: string, maintenantMs: number, delais: OmoDelais = OMO_DELAIS): boolean {
  if (!precheck || precheck.startId !== startId) return false;
  return maintenantMs - precheck.at >= -delais.perimeS * 1000;
}

/**
 * Le `stop-request` lu vise-t-il le démarrage en cours (`startId`, commencé à `startedAt`) ? Nommé : seulement s'il nomme CE
 * démarrage. Sans démarrage nommé (le cockpit ne connaissait pas l'état) : s'il date de ce démarrage ou d'après — les deux
 * conteneurs lisent l'horloge du même noyau. Un arrêt d'un démarrage précédent a déjà été honoré par la sortie de celui-ci ;
 * le relire ferait sortir chaque relance à neuf, sans fin (D-2b-29). Rien de sûr ne se perd : un démarrage exige toujours un
 * battement frais et le `precheck-ok` de son propre `startId`.
 */
export function arretDuDemarrage(arret: OmoArret | null, startId: string, startedAt: number): boolean {
  if (!arret) return false;
  if (arret.startId !== null) return arret.startId === startId;
  return arret.at >= startedAt;
}

/** Ce que le superviseur doit faire après avoir relu le volume de contrôle. */
export type OmoDecision = "continuer" | "arret-demande" | "battement-perime";

/**
 * Décision du superviseur : un `stop-request` l'emporte sur tout, puis le battement. Les deux mènent à TERM puis KILL. `arret` est
 * celui du démarrage en cours (déjà passé par `arretDuDemarrage`), `null` sinon.
 */
export function decisionSuperviseur(
  battement: OmoBattement | null,
  arret: OmoArret | null,
  maintenantMs: number,
  delais: OmoDelais = OMO_DELAIS,
): OmoDecision {
  if (arret) return "arret-demande";
  return battementFrais(battement, maintenantMs, delais) ? "continuer" : "battement-perime";
}
