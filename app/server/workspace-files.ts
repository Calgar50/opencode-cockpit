// Lecteur disque de l'onglet « Fichiers » (1.1, NAV-2 ; décisions A19 point 2, A21, A29 D14 ; fiche NAV §2.7, §2.8, §2.10).
// Le cockpit lit lui-même un second montage du dossier de travail, en lecture seule (/projets-lecture, docker-compose.yml) :
// opencode n'est jamais appelé, rien n'est écrit, rien ne sort sur le réseau. Le cockpit voit aussi ses propres secrets
// (/proc/self/environ, /oc-data/auth.json, /tls, /data) : chaque lecture suit un ordre imposé de barrières, chacune avec son code
// de refus (§2.7), et le descripteur est toujours refermé.
//
// Défense en profondeur d'une lecture (contenu) : règles pures et protection AVANT tout accès au disque ; place au sémaphore
// (G6) ; nom exact de chaque composant lu dans son dossier parent (G1 : casse, nom court, point final d'un volume Windows) ;
// lstat de chaque composant (lien refusé) ; nlink ≤ 1 (lien physique) ; extension binaire sans ouverture (G7) ; ouverture
// O_RDONLY | O_NOFOLLOW | O_NONBLOCK (lien posé après le contrôle, tube) ; fstat (type, nlink, dev et ino du contrôle) ; chemin
// réel du descripteur comparé au chemin DEMANDÉ (A1 : dossier parent remplacé par un lien vers un autre dossier du même projet) ;
// lecture bornée par morceaux ; fstat final (taille et date inchangées).
//
// Liste d'un dossier et chaque dossier d'un parcours (§2.8 ; relectures F2-vague-5 et F2-vague-6) : le dossier est ouvert
// O_RDONLY | O_DIRECTORY | O_NOFOLLOW (un lien, un fichier ou un tube mis à sa place est refusé par le noyau), son fstat doit
// rendre le dev et l'ino du contrôle et le chemin réel de son descripteur le chemin demandé ; il est ensuite lu par le lien
// magique /proc/self/fd/<fd> (Node n'expose ni openat ni fdopendir), et chaque entrée y est examinée par lstat. Sous Linux, sur
// un système de fichiers local, ce lien mène au dossier déjà ouvert sans refaire le chemin : une course aller-retour ne peut pas
// y faire lister un autre dossier. Sur le montage 9p de Docker Desktop (production sous Windows), le serveur rouvre ce lien PAR
// SON CHEMIN (mesuré, relecture F2-vague-6), comme la lecture par le chemin sans /proc (cockpit de développement) : un autre vrai
// dossier du dossier de travail, mis à la place entre l'ouverture et la lecture puis remis, y serait listé. D'où, pour une
// liste, après la revérification par chemin, une SECONDE RÉSOLUTION au chemin demandé (confirmerListe) : chaque entrée examinée y
// est relue par lstat et doit rendre les mêmes dev et ino, chaque nom lu sans lstat (protégé, douteux) doit y figurer ; puis une
// dernière revérification. Pour un parcours, borné en durée, le dossier est revérifié par chemin AVANT l'examen de ses entrées
// (qui suit, au même chemin de lecture), puis une dernière fois après : même effet, sans lstat de plus. Les deux RÉTRÉCISSENT la
// course sans la fermer : un second aller-retour, placé entre la revérification et la relecture puis défait avant la dernière
// revérification, la déjoue encore (reste n° 2 du RECAPITULATIF). Jamais un contenu : un fichier est lu par son descripteur,
// lié au fichier ouvert, sur ce montage aussi (mesuré).
//
// A5 : aucune exception ne sort du lecteur, aucun message de Node n'est journalisé ni renvoyé (il contient le chemin). Les refus
// qui trahissent une manœuvre (lien, plusieurs-noms, a-change) sont journalisés au plus une fois par minute et par code, avec le
// seul nom du projet ; aucune réponse ne contient la racine absolue.
//
// Imports limités à node:fs/promises, node:fs (constantes et types), node:path, ./shared/* et ./log.ts (type) : ni hono, ni zod,
// ni paquet npm, pour que son test tourne dans un conteneur Linux nu (fiche §4.4). Les crochets `pendant`, `attendre` et
// `maintenant` ne servent qu'aux tests : routes-fichiers.ts ne les passe jamais.
import { type BigIntStats, constants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import type { Logger } from "./log.ts";
import {
  analyserChemin,
  decoderTexte,
  estBinaireParExtension,
  estGenere,
  estProtege,
  NAV_BORNES,
  normaliserRecherche,
  preparerTexte,
  projetNavigable,
  rendreVisible,
  segmentSur,
} from "./shared/fichiers-regles.ts";
import type {
  ContenuReponse,
  DossierReponse,
  EntreeType,
  EntreeVue,
  FichiersCode,
  FichiersRoute,
  RecentsReponse,
  RechercheReponse,
} from "./shared/fichiers-types.ts";

/** Issue d'une méthode du lecteur : jamais une exception. */
export type Resultat<T> = { ok: true; valeur: T } | { ok: false; code: FichiersCode };

/**
 * Crochets des tests (fiche §2.7 étapes 8, 12 et 13, §2.8) ; « parcours-dossier » : avant l'ouverture de chaque dossier parcouru ;
 * « apres-ouverture » : fichier ou dossier (liste, chaque dossier d'un parcours) ouvert et vérifié, avant sa lecture ;
 * « apres-liste » : liste lue, avant la revérification (liste d'un dossier seulement).
 */
export type MomentLecteur = "apres-controle" | "apres-ouverture" | "pendant-lecture" | "apres-liste" | "parcours-dossier";

export interface LecteurOptions {
  /** Dossier lu : env.fichiersDir ?? env.workspaceDir. */
  racine: string;
  log: Pick<Logger, "warn">;
  /** Horloge monotone en millisecondes (borne de durée des parcours, intervalle du journal) ; tests seulement. */
  maintenant?: () => number;
  /** Attente d'une place au sémaphore ; tests seulement. */
  attendre?: (ms: number) => Promise<void>;
  /** Crochet appelé aux moments de la fiche ; tests seulement. */
  pendant?: (moment: MomentLecteur) => void | Promise<void>;
}

export interface DemandeChemin {
  projet: string;
  chemin: string;
}

export interface DemandeProjet {
  projet: string;
  /**
   * Annulation de la requête (routes : c.req.raw.signal ; relecture F2-vague-6, constat n° 5) : un parcours abandonné rend la
   * place unique dès l'annulation et s'arrête à son prochain contrôle, comme à sa borne de durée.
   */
  signal?: AbortSignal;
}

export interface DemandeRecherche {
  projet: string;
  texte: string;
  /** Comme DemandeProjet.signal. */
  signal?: AbortSignal;
}

export interface LecteurFichiers {
  dossier(demande: DemandeChemin): Promise<Resultat<DossierReponse>>;
  contenu(demande: DemandeChemin): Promise<Resultat<ContenuReponse>>;
  recents(demande: DemandeProjet): Promise<Resultat<RecentsReponse>>;
  recherche(demande: DemandeRecherche): Promise<Resultat<RechercheReponse>>;
}

/** Demande acceptée par les règles pures : S = [projet, ...segments], sans le projet vide (la racine). */
export type ReglesDemande = { ok: true; S: string[]; avecProjet: boolean } | { ok: false; code: "invalide" | "protege" };

/**
 * Étapes 1 et 2 du §2.7, sans aucun accès au disque, communes aux routes (avant le lecteur) et au lecteur : projet navigable,
 * chemin analysé (liste vide refusée pour « contenu »), texte de recherche de 1 à 100 caractères, puis protection de chaque
 * segment, projet compris. Même réponse qu'un élément protégé existe ou non.
 */
export function reglesDemande(route: FichiersRoute, demande: { projet?: unknown; chemin?: unknown; texte?: unknown }): ReglesDemande {
  const { projet } = demande;
  if (typeof projet !== "string" || !projetNavigable(projet)) return { ok: false, code: "invalide" };
  let segments: string[] = [];
  if (route === "dossier" || route === "contenu") {
    const analyse = analyserChemin(demande.chemin);
    if (!analyse.ok || (route === "contenu" && analyse.segments.length === 0)) return { ok: false, code: "invalide" };
    segments = analyse.segments;
  }
  if (route === "recherche") {
    const { texte } = demande;
    if (typeof texte !== "string" || texte.length === 0 || texte.length > NAV_BORNES.RECHERCHE_MAX_CARACTERES) return { ok: false, code: "invalide" };
    if (normaliserRecherche(texte) === "") return { ok: false, code: "invalide" };
  }
  const S = projet === "" ? segments : [projet, ...segments];
  if (estProtege(S)) return { ok: false, code: "protege" };
  return { ok: true, S, avecProjet: projet !== "" };
}

/** Ouverture de l'étape 9 ; O_NOFOLLOW et O_NONBLOCK n'existent pas sous Windows (0). Lecture seule. */
const OUVERTURE = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0);

/**
 * Ouverture d'un dossier lu (§2.8, relecture F2-vague-5) : lecture seule ; sous Linux, O_DIRECTORY fait refuser par le noyau tout
 * ce qui n'est pas un dossier (ENOTDIR, avant toute attente sur un tube) et O_NOFOLLOW tout lien final. Constantes absentes sous
 * Windows (0).
 */
const OUVERTURE_DOSSIER = constants.O_RDONLY | (constants.O_DIRECTORY ?? 0) | (constants.O_NOFOLLOW ?? 0);

/** Refus décidé par le lecteur (jamais renvoyé tel quel : traduit en { ok: false, code }). */
class Refus extends Error {
  readonly code: FichiersCode;

  constructor(code: FichiersCode) {
    super(code);
    this.code = code;
  }
}

/** Refus révélateurs d'une manœuvre, journalisés (§2.10). */
const REFUS_JOURNALISES: ReadonlySet<FichiersCode> = new Set(["lien", "plusieurs-noms", "a-change"]);

/** §2.10 : ENOENT et ENOTDIR → introuvable, ELOOP → lien, le reste → illisible. */
function codeDe(err: unknown): FichiersCode {
  if (err instanceof Refus) return err.code;
  const errno = (err as { code?: unknown } | null)?.code;
  if (errno === "ENOENT" || errno === "ENOTDIR") return "introuvable";
  if (errno === "ELOOP") return "lien";
  return "illisible";
}

/** Nature d'une erreur inattendue, sans son message (qui contient le chemin) : code errno ou nom de l'erreur. */
function natureDe(err: unknown): string {
  const errno = (err as { code?: unknown } | null)?.code;
  if (typeof errno === "string" && /^E[A-Z0-9]{2,20}$/.test(errno)) return errno;
  if (err instanceof Error && /^[A-Za-z]{1,40}$/.test(err.name)) return err.name;
  return "inconnue";
}

const estAbsent = (err: unknown): boolean => {
  const errno = (err as { code?: unknown } | null)?.code;
  return errno === "ENOENT" || errno === "ENOTDIR";
};

/**
 * Segments du chemin réel `reel` sous `racineReelle` (séparateur du système), null s'il en sort. Aucune normalisation : la
 * comparaison au chemin demandé se fait ensuite en minuscules seulement.
 */
function segmentsSous(racineReelle: string, reel: string): string[] | null {
  const relatif = path.relative(racineReelle, reel);
  if (relatif === "") return [];
  if (path.isAbsolute(relatif)) return null;
  const segments = relatif.split(path.sep);
  return segments[0] === ".." ? null : segments;
}

/** A1 : chemin réel égal au chemin demandé, casse ignorée (toLowerCase), sans normalisation. */
const memeChemin = (reels: readonly string[], S: readonly string[]): boolean => reels.join("/").toLowerCase() === S.join("/").toLowerCase();

/** Tri de la liste : dossiers d'abord, puis ordre français, nombres dans l'ordre numérique, casse et accents confondus. */
const COLLATION = new Intl.Collator("fr", { numeric: true, sensitivity: "base" });

function comparerEntrees(a: EntreeVue, b: EntreeVue): number {
  const rang = (a.type === "dossier" ? 0 : 1) - (b.type === "dossier" ? 0 : 1);
  if (rang !== 0) return rang;
  return COLLATION.compare(a.nom, b.nom) || (a.nom < b.nom ? -1 : a.nom > b.nom ? 1 : 0);
}

/** Type d'une entrée lu par lstat, jamais sur le Dirent seul (certains montages rendent un type inconnu). */
function typeDe(info: BigIntStats): EntreeType {
  if (info.isSymbolicLink()) return "lien";
  if (info.isDirectory()) return "dossier";
  if (info.isFile()) return "fichier";
  return "autre";
}

function vueDe(nom: string, type: EntreeType, info: BigIntStats | null): EntreeVue {
  return {
    nom,
    nomVisible: rendreVisible(nom),
    type,
    taille: type === "fichier" && info !== null ? Number(info.size) : null,
    modifieA: info === null ? null : Number(info.mtimeMs),
    cache: nom.startsWith("."),
    genere: estGenere(nom),
  };
}

interface Composant {
  chemin: string;
  dev: bigint;
  ino: bigint;
}

interface Controle {
  racineReelle: string;
  /** Composants vérifiés, du haut vers le bas. */
  composants: Composant[];
  /** Chemin absolu de la cible : racine réelle si S est vide. */
  cible: string;
  /** lstat de la feuille ; null si S est vide. */
  feuille: BigIntStats | null;
}

/** Même élément que celui lu plus tôt (lstat : un lien montré dans une liste est comparé à lui-même) : présent, mêmes dev et ino. */
const memeIdentite = (info: BigIntStats | null | undefined, attendu: { dev: bigint; ino: bigint }): info is BigIntStats =>
  info !== null && info !== undefined && info.dev === attendu.dev && info.ino === attendu.ino;

/** lstat en bigint (dev et ino exacts) ; un élément disparu entre deux lectures rend null. */
async function lstatOuAbsent(chemin: string): Promise<BigIntStats | null> {
  try {
    return await fs.lstat(chemin, { bigint: true });
  } catch (err) {
    if (estAbsent(err)) return null;
    throw err;
  }
}

/**
 * Crée le lecteur, une seule fois par installation du module : le sémaphore (LECTURES_SIMULTANEES places) et le verrou de
 * parcours (un seul à la fois dans tout le cockpit) lui appartiennent. Aucun accès au disque à la création.
 */
export function creerLecteurFichiers(options: LecteurOptions): LecteurFichiers {
  const { racine, log } = options;
  const maintenant = options.maintenant ?? (() => performance.now());
  const attendre = options.attendre ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const pendant = options.pendant ?? (() => undefined);

  // --- Journal (§2.10) : au plus une ligne par minute et par clé, jamais un chemin, un nom de fichier ni un contenu. ---------
  const dernieresLignes = new Map<string, number>();
  const uneFoisParMinute = (cle: string): boolean => {
    const t = maintenant();
    const derniere = dernieresLignes.get(cle);
    if (derniere !== undefined && t - derniere < NAV_BORNES.JOURNAL_INTERVALLE_MS) return false;
    dernieresLignes.set(cle, t);
    return true;
  };

  /** Traduit une exception en code ; journalise un refus révélateur, ou la seule nature d'une erreur inattendue. */
  const echec = (projet: string, err: unknown): { ok: false; code: FichiersCode } => {
    const code = codeDe(err);
    if (REFUS_JOURNALISES.has(code)) {
      if (uneFoisParMinute(code)) log.warn("fichiers : refus", { projet, code });
    } else if (code === "illisible" && !(err instanceof Refus)) {
      const nature = natureDe(err);
      if (uneFoisParMinute(`illisible:${nature}`)) log.warn("fichiers : lecture impossible", { projet, code, nature });
    }
    return { ok: false, code };
  };

  // --- Sémaphore (G6) : deux lectures du disque à la fois ; au-delà, attente de ATTENTE_PLACE_MS puis « occupe ». -----------
  let places = NAV_BORNES.LECTURES_SIMULTANEES;
  const enAttente: Array<(liberer: () => void) => void> = [];
  const liberation = (): (() => void) => {
    let faite = false;
    return () => {
      if (faite) return;
      faite = true;
      const suivante = enAttente.shift();
      if (suivante) suivante(liberation());
      else places++;
    };
  };
  /** Une place, ou null après ATTENTE_PLACE_MS ; une requête annulée pendant l'attente la quitte tout de suite (null). */
  const prendrePlace = (signal?: AbortSignal): Promise<(() => void) | null> => {
    if (places > 0) {
      places--;
      return Promise.resolve(liberation());
    }
    if (signal?.aborted) return Promise.resolve(null);
    return new Promise((resolve) => {
      let servie = false;
      const abandon = () => {
        signal?.removeEventListener("abort", abandon);
        if (servie) return;
        const rang = enAttente.indexOf(servir);
        if (rang >= 0) enAttente.splice(rang, 1);
        resolve(null);
      };
      const servir = (liberer: () => void) => {
        servie = true;
        signal?.removeEventListener("abort", abandon);
        resolve(liberer);
      };
      enAttente.push(servir);
      signal?.addEventListener("abort", abandon, { once: true });
      attendre(NAV_BORNES.ATTENTE_PLACE_MS).then(abandon, abandon);
    });
  };

  /** Étape 3 puis `travail` ; la place est toujours rendue ; aucune exception ne sort. */
  const avecPlace = async <T>(projet: string, travail: () => Promise<T>, signal?: AbortSignal): Promise<Resultat<T>> => {
    const liberer = await prendrePlace(signal);
    if (liberer === null) return { ok: false, code: "occupe" };
    try {
      return { ok: true, valeur: await travail() };
    } catch (err) {
      return echec(projet, err);
    } finally {
      liberer();
    }
  };

  // --- Étape 11 sans /proc (cockpit de développement sous Windows) : sautée, un seul avertissement. ------------------------
  let sansProc = false;
  const procAbsent = async (): Promise<boolean> => {
    try {
      await fs.lstat("/proc/self/fd");
      return false;
    } catch {
      return true;
    }
  };

  /** Étape 5a (G1) : le nom doit figurer, casse comprise, parmi les NOM_EXACT_MAX premières entrées lues de son dossier. */
  const nomExact = async (dossier: string, nom: string): Promise<boolean> => {
    let lues = 0;
    // Lecture en flux ; sortir de la boucle referme le dossier.
    for await (const entree of await fs.opendir(dossier)) {
      if (entree.name === nom) return true;
      lues++;
      if (lues >= NAV_BORNES.NOM_EXACT_MAX) return false;
    }
    return false;
  };

  /**
   * Étapes 4 et 5 : racine réelle, puis chaque composant du haut vers le bas, sous son parent déjà vérifié : nom exact (G1),
   * puis lstat (lien refusé ; composant intermédiaire, et projet, qui doivent être de vrais dossiers ; feuille attendue).
   */
  const controler = async (S: readonly string[], avecProjet: boolean, attendue: "fichier" | "dossier"): Promise<Controle> => {
    const racineReelle = await fs.realpath(racine);
    const composants: Composant[] = [];
    let parent = racineReelle;
    let feuille: BigIntStats | null = null;
    for (let i = 0; i < S.length; i++) {
      const nom = S[i] ?? "";
      const estProjet = avecProjet && i === 0;
      const derniere = i === S.length - 1;
      const absent: FichiersCode = estProjet ? "projet-inconnu" : "introuvable";
      if (!(await nomExact(parent, nom))) throw new Refus(absent);
      const chemin = path.join(parent, nom);
      const info = await lstatOuAbsent(chemin);
      if (info === null) throw new Refus(absent);
      if (info.isSymbolicLink()) throw new Refus("lien");
      if (derniere && attendue === "fichier") {
        if (!info.isFile()) throw new Refus(estProjet ? "projet-inconnu" : "pas-un-fichier");
      } else if (!info.isDirectory()) {
        throw new Refus(estProjet ? "projet-inconnu" : derniere ? "pas-un-dossier" : "introuvable");
      }
      composants.push({ chemin, dev: info.dev, ino: info.ino });
      parent = chemin;
      feuille = info;
    }
    return { racineReelle, composants, cible: parent, feuille };
  };

  /** Étape 11 (A1) : chemin réel du descripteur égal au chemin demandé, casse ignorée, et non protégé. */
  const verifierDescripteur = async (fd: number, racineReelle: string, S: readonly string[]): Promise<void> => {
    if (sansProc) return;
    let reel: string;
    try {
      reel = await fs.realpath(`/proc/self/fd/${fd}`);
    } catch (err) {
      if (!(await procAbsent())) throw err;
      if (!sansProc) {
        sansProc = true;
        log.warn("fichiers : sans /proc, le chemin réel du fichier ouvert n'est pas vérifié (cockpit de développement)");
      }
      return;
    }
    const reels = segmentsSous(racineReelle, reel);
    if (reels === null || !memeChemin(reels, S)) throw new Refus("a-change");
    if (estProtege(reels)) throw new Refus("protege");
  };

  /**
   * §2.8 (relecture F2-vague-5) : ouvre le dossier `chemin` (OUVERTURE_DOSSIER), exige par fstat un dossier avec le dev et l'ino
   * `attendu` (ceux du contrôle, ou du lstat qui l'a découvert), puis le chemin réel de son descripteur égal à `segments` (étape
   * 11), et passe à `lire` le chemin par lequel le lire : le lien magique /proc/self/fd/<fd>, qui mène au dossier ouvert sans
   * refaire le chemin sur un système de fichiers local, mais que le montage 9p de Docker Desktop rouvre par son chemin ; sans /proc,
   * `chemin` lui-même. Un dossier devenu lien, fichier ou tube depuis le contrôle (ENOTDIR, ELOOP) → a-change. Le descripteur est
   * toujours refermé, après la lecture.
   */
  const avecDossierOuvert = async <T>(
    chemin: string,
    attendu: { dev: bigint; ino: bigint },
    racineReelle: string,
    segments: readonly string[],
    lire: (lu: string) => Promise<T>,
  ): Promise<T> => {
    let handle: fs.FileHandle;
    try {
      handle = await fs.open(chemin, OUVERTURE_DOSSIER);
    } catch (err) {
      const errno = (err as { code?: unknown } | null)?.code;
      if (errno === "ENOTDIR" || errno === "ELOOP") throw new Refus("a-change");
      throw err;
    }
    try {
      const ouvert = await handle.stat({ bigint: true });
      if (!ouvert.isDirectory() || ouvert.dev !== attendu.dev || ouvert.ino !== attendu.ino) throw new Refus("a-change");
      await verifierDescripteur(handle.fd, racineReelle, segments);
      await pendant("apres-ouverture");
      return await lire(sansProc ? chemin : `/proc/self/fd/${handle.fd}`);
    } finally {
      await handle.close().catch(() => undefined);
    }
  };

  /** Dev et ino attendus de la cible contrôlée : ceux de la feuille, ou de la racine réelle quand S est vide. */
  const identiteDe = async (controle: Controle): Promise<{ dev: bigint; ino: bigint }> =>
    controle.composants.at(-1) ?? (await fs.lstat(controle.cible, { bigint: true }));

  /** Étape 13 : FileHandle.read par morceaux de MORCEAU_OCTETS, jusqu'à LECTURE_MAX_OCTETS + 1 octet ; jamais readFile. */
  const lireBorne = async (handle: fs.FileHandle): Promise<{ octets: Uint8Array; tronque: boolean }> => {
    const max = NAV_BORNES.LECTURE_MAX_OCTETS + 1;
    const tampon = new Uint8Array(NAV_BORNES.MORCEAU_OCTETS);
    const morceaux: Uint8Array[] = [];
    let total = 0;
    while (total < max) {
      const { bytesRead } = await handle.read(tampon, 0, Math.min(tampon.length, max - total), total);
      if (bytesRead === 0) break;
      morceaux.push(tampon.slice(0, bytesRead));
      const premier = total === 0;
      total += bytesRead;
      if (premier) await pendant("pendant-lecture");
    }
    const octets = new Uint8Array(total);
    let position = 0;
    for (const morceau of morceaux) {
      octets.set(morceau, position);
      position += morceau.length;
    }
    const tronque = total > NAV_BORNES.LECTURE_MAX_OCTETS;
    return { octets: tronque ? octets.subarray(0, NAV_BORNES.LECTURE_MAX_OCTETS) : octets, tronque };
  };

  /**
   * §2.8, étape 5 : chaque composant toujours un dossier, mêmes dev et ino ; chemin réel de la cible égal au chemin demandé. Par
   * chemin, elle ne voit qu'un écart encore en place : un aller-retour achevé (lien posé puis retiré, vrai dossier remis avec les
   * mêmes dev et ino) lui échappe ; c'est la lecture par le descripteur (avecDossierOuvert) qui le ferme, sous Linux sur un système
   * de fichiers local, et la seconde résolution (confirmerListe) qui le rétrécit ailleurs.
   */
  const reverifier = async (controle: Controle, S: readonly string[]): Promise<void> => {
    try {
      for (const composant of controle.composants) {
        const info = await fs.lstat(composant.chemin, { bigint: true });
        if (info.isSymbolicLink() || !info.isDirectory() || info.dev !== composant.dev || info.ino !== composant.ino) throw new Refus("a-change");
      }
      const reels = segmentsSous(controle.racineReelle, await fs.realpath(controle.cible));
      if (reels === null || !memeChemin(reels, S)) throw new Refus("a-change");
    } catch {
      // Tout écart encore en place, disparition comprise : la liste est jetée.
      throw new Refus("a-change");
    }
  };

  /** Liste lue (lister) : `examinees`, dev et ino de chaque entrée montrée après lstat ; `sansLstat`, noms protégés et douteux. */
  interface ListeLue {
    entrees: EntreeVue[];
    masques: number;
    tronque: boolean;
    examinees: Array<{ nom: string; dev: bigint; ino: bigint }>;
    sansLstat: string[];
  }

  /**
   * §2.8, points 2 et 3 : lecture en flux, protégés comptés sans lstat ni nom, douteux sans lstat, lstat par lots. `lu` est le
   * chemin de lecture rendu par avecDossierOuvert (descripteur sous Linux) ; S, le chemin demandé, sert seul à la protection.
   */
  const lister = async (lu: string, S: readonly string[]): Promise<ListeLue> => {
    const entrees: EntreeVue[] = [];
    const aExaminer: string[] = [];
    const examinees: ListeLue["examinees"] = [];
    const sansLstat: string[] = [];
    let masques = 0;
    let tronque = false;
    let lues = 0;
    for await (const entree of await fs.opendir(lu)) {
      if (lues >= NAV_BORNES.ENTREES_MAX) {
        tronque = true;
        break;
      }
      lues++;
      const nom = entree.name;
      if (estProtege([...S, nom])) {
        masques++;
        sansLstat.push(nom);
      } else if (!segmentSur(nom)) {
        entrees.push(vueDe(nom, "douteux", null));
        sansLstat.push(nom);
      } else {
        aExaminer.push(nom);
      }
    }
    for (let debut = 0; debut < aExaminer.length; debut += NAV_BORNES.LOT_LSTAT) {
      const lot = aExaminer.slice(debut, debut + NAV_BORNES.LOT_LSTAT);
      const infos = await Promise.all(lot.map((nom) => lstatOuAbsent(path.join(lu, nom))));
      lot.forEach((nom, i) => {
        const info = infos[i];
        // Disparue entre la lecture du dossier et son lstat : elle n'est pas montrée.
        if (!info) return;
        entrees.push(vueDe(nom, typeDe(info), info));
        examinees.push({ nom, dev: info.dev, ino: info.ino });
      });
    }
    return { entrees, masques, tronque, examinees, sansLstat };
  };

  /**
   * Seconde résolution d'une liste (relecture F2-vague-6), après la revérification du dossier, au chemin DEMANDÉ `cible` : chaque
   * entrée examinée y est relue par lstat et doit rendre les dev et ino lus pendant la liste ; chaque nom lu sans lstat (protégé,
   * douteux : jamais examinés, G1) doit figurer, casse comprise, parmi les noms relus dans `cible` (NOM_EXACT_MAX au plus). Sinon
   * a-change : sur le montage 9p et sans /proc, la liste peut avoir été lue dans un autre vrai dossier mis à la place entre
   * l'ouverture et la lecture, puis remis. Rétrécit la course sans la fermer (voir l'en-tête).
   */
  const confirmerListe = async (cible: string, liste: ListeLue): Promise<void> => {
    if (liste.sansLstat.length > 0) {
      const relus = new Set<string>();
      for await (const entree of await fs.opendir(cible)) {
        relus.add(entree.name);
        if (relus.size >= NAV_BORNES.NOM_EXACT_MAX) break;
      }
      if (!liste.sansLstat.every((nom) => relus.has(nom))) throw new Refus("a-change");
    }
    for (let debut = 0; debut < liste.examinees.length; debut += NAV_BORNES.LOT_LSTAT) {
      const lot = liste.examinees.slice(debut, debut + NAV_BORNES.LOT_LSTAT);
      const infos = await Promise.all(lot.map((examinee) => lstatOuAbsent(path.join(cible, examinee.nom))));
      if (!lot.every((examinee, i) => memeIdentite(infos[i], examinee))) throw new Refus("a-change");
    }
  };

  interface Trouve {
    segments: string[];
    type: "dossier" | "fichier";
    info: BigIntStats;
  }

  /**
   * §2.8 : parcours en largeur sous la cible contrôlée, bornes PARCOURS_ENTREES_MAX, PARCOURS_NIVEAUX_MAX et PARCOURS_DUREE_MS
   * (horloge injectée) ; jamais de descente dans un lien, un élément protégé ni GENERES ; aucun fichier ouvert. `surTrouve` rend
   * true pour arrêter (borne de résultats). Chaque dossier est lu par avecDossierOuvert (relecture F2-vague-5) : il doit être
   * encore celui découvert (dev et ino du lstat de son parent, ou du contrôle) et au chemin attendu, puis il est lu par son
   * descripteur sous Linux. Un dossier illisible, disparu ou remplacé (lien, autre dossier, autre chemin réel) est sauté
   * (incomplet). Relecture F2-vague-6 : le dossier lu est revérifié par chemin AVANT l'examen de ses entrées, puis une dernière
   * fois après ; sur le montage 9p et sans /proc, où l'examen se fait au chemin demandé, une entrée lue dans un autre vrai dossier
   * mis à la place puis remis n'y est plus : sautée, parcours incomplet (voir l'en-tête : rétrécit la course sans lstat de plus ;
   * sous Linux, sur un système de fichiers local, l'examen reste lié au dossier ouvert). Une requête annulée (`signal`) arrête le
   * parcours comme sa borne de durée.
   */
  const parcourir = async (
    controle: Controle,
    S: readonly string[],
    surTrouve: (trouve: Trouve) => boolean,
    signal?: AbortSignal,
  ): Promise<{ parcourus: number; incomplet: boolean }> => {
    const debut = maintenant();
    const abandonne = () => signal?.aborted === true;
    /** Borne de durée atteinte, ou requête annulée. */
    const horsDelai = () => abandonne() || maintenant() - debut >= NAV_BORNES.PARCOURS_DUREE_MS;
    const racineInfo = await identiteDe(controle);
    const file: Array<{ chemin: string; segments: string[]; niveau: number; dev: bigint; ino: bigint }> = [
      { chemin: controle.cible, segments: [], niveau: 0, dev: racineInfo.dev, ino: racineInfo.ino },
    ];
    let parcourus = 0;
    let incomplet = false;

    /** Revérification par chemin d'un dossier lu : toujours un dossier, avec les dev et ino découverts. */
    const encoreLeDossier = async (dossier: { chemin: string; dev: bigint; ino: bigint }): Promise<boolean> => {
      const info = await lstatOuAbsent(dossier.chemin).catch(() => null);
      return memeIdentite(info, dossier) && info.isDirectory();
    };

    /**
     * Noms d'un dossier ouvert (`lu` : son descripteur sous Linux), revérification du dossier par chemin (relecture F2-vague-6),
     * puis lstat par lots au même endroit que la lecture ; aucun fichier ouvert.
     */
    const lireDossier = async (lu: string, dossier: { chemin: string; segments: readonly string[]; dev: bigint; ino: bigint }): Promise<{ borne: boolean; trouves: Trouve[] }> => {
      const { segments } = dossier;
      const noms: string[] = [];
      let borne = false;
      for await (const entree of await fs.opendir(lu)) {
        if (parcourus >= NAV_BORNES.PARCOURS_ENTREES_MAX || horsDelai()) {
          borne = true;
          break;
        }
        parcourus++;
        const nom = entree.name;
        if (segmentSur(nom) && !estProtege([...S, ...segments, nom])) noms.push(nom);
      }
      // Requête annulée pendant la lecture : aucune entrée examinée.
      if (abandonne()) return { borne: true, trouves: [] };
      // Avant l'examen des entrées : le dossier doit être encore celui découvert, à son chemin (remplacé par un lien ou un autre
      // vrai dossier encore en place : sauté). Sur le montage 9p et sans /proc, l'examen qui suit se fait au chemin demandé, dans
      // le vrai dossier : un nom lu dans un remplaçant déjà remis y est absent (sauté, incomplet).
      if (!(await encoreLeDossier(dossier))) throw new Refus("a-change");
      const trouves: Trouve[] = [];
      for (let premier = 0; premier < noms.length; premier += NAV_BORNES.LOT_LSTAT) {
        if (horsDelai()) {
          borne = true;
          break;
        }
        const lot = noms.slice(premier, premier + NAV_BORNES.LOT_LSTAT);
        const infos = await Promise.all(
          lot.map((nom) =>
            lstatOuAbsent(path.join(lu, nom)).catch(() => {
              // Entrée illisible : sautée, le parcours est dit incomplet.
              incomplet = true;
              return null;
            }),
          ),
        );
        lot.forEach((nom, i) => {
          const info = infos[i];
          if (info === null || info === undefined) {
            // Disparue entre la lecture du dossier et son examen (ou lue dans un remplaçant déjà remis) : sautée, incomplet.
            incomplet = true;
            return;
          }
          if (info.isSymbolicLink()) return;
          if (info.isDirectory()) trouves.push({ segments: [...segments, nom], type: "dossier", info });
          else if (info.isFile()) trouves.push({ segments: [...segments, nom], type: "fichier", info });
        });
      }
      return { borne, trouves };
    };

    while (file.length > 0) {
      const dossier = file.shift();
      if (dossier === undefined) break;
      if (horsDelai()) return { parcourus, incomplet: true };
      await pendant("parcours-dossier");
      let lecture: { borne: boolean; trouves: Trouve[] };
      try {
        lecture = await avecDossierOuvert(dossier.chemin, dossier, controle.racineReelle, [...S, ...dossier.segments], (lu) => lireDossier(lu, dossier));
      } catch {
        // Dossier illisible, disparu, ou qui n'est plus celui découvert (lien, autre dossier, autre chemin réel) : sauté.
        incomplet = true;
        continue;
      }
      // Requête annulée pendant la lecture : rien de plus n'est lu ni rendu.
      if (abandonne()) return { parcourus, incomplet: true };
      const { borne, trouves } = lecture;
      // Dernière revérification par chemin du dossier lu : remplacé (lien, autre vrai dossier) encore en place pendant l'examen de
      // ses entrées, ses noms sont jetés.
      if (!(await encoreLeDossier(dossier))) {
        incomplet = true;
        continue;
      }
      for (const trouve of trouves) {
        if (surTrouve(trouve)) return { parcourus, incomplet: true };
        if (trouve.type !== "dossier" || estGenere(trouve.segments.at(-1) ?? "")) continue;
        if (dossier.niveau + 1 < NAV_BORNES.PARCOURS_NIVEAUX_MAX) {
          file.push({
            chemin: path.join(dossier.chemin, trouve.segments.at(-1) ?? ""),
            segments: trouve.segments,
            niveau: dossier.niveau + 1,
            dev: trouve.info.dev,
            ino: trouve.info.ino,
          });
        } else {
          incomplet = true;
        }
      }
      if (borne) return { parcourus, incomplet: true };
    }
    return { parcourus, incomplet };
  };

  // --- Parcours : un seul à la fois dans tout le cockpit, sinon « occupe » tout de suite. ------------------------------------
  // Relecture F2-vague-6 (constat n° 5) : un parcours abandonné (requête annulée par la page) n'est plus un parcours « réel » ; il
  // rend la place dès l'annulation et s'arrête à son prochain contrôle (parcourir). Le jeton empêche sa fin tardive de libérer la
  // place d'un parcours suivant. L'annulation n'arrive ici qu'à la fermeture de la connexion : la requête suivante de la page peut
  // la devancer et recevoir « occupe » ; la page la rejoue alors une fois (répétition générale F2, fileDesParcours d'api-fichiers.ts).
  let parcoursEnCours: object | null = null;
  const avecParcours = async <T>(projet: string, signal: AbortSignal | undefined, travail: () => Promise<T>): Promise<Resultat<T>> => {
    // Requête déjà annulée : aucune place prise, aucun accès au disque ; cette réponse n'est lue par personne.
    if (signal?.aborted) return { ok: false, code: "occupe" };
    if (parcoursEnCours !== null) return { ok: false, code: "occupe" };
    const jeton = {};
    parcoursEnCours = jeton;
    const rendre = () => {
      if (parcoursEnCours === jeton) parcoursEnCours = null;
    };
    signal?.addEventListener("abort", rendre, { once: true });
    try {
      return await avecPlace(projet, travail, signal);
    } finally {
      signal?.removeEventListener("abort", rendre);
      rendre();
    }
  };

  const contenu = async (demande: DemandeChemin): Promise<Resultat<ContenuReponse>> => {
    const projet = String(demande?.projet ?? "");
    try {
      const regles = reglesDemande("contenu", demande);
      if (!regles.ok) return regles;
      const { S, avecProjet } = regles;
      return await avecPlace(projet, async () => {
        const controle = await controler(S, avecProjet, "fichier");
        const feuille = controle.feuille;
        if (feuille === null) throw new Refus("invalide");
        // 6. Liens physiques (règle de L10b) ; nlink 0 n'arrête rien.
        if (feuille.nlink > 1n) throw new Refus("plusieurs-noms");
        // 7. Extension binaire : jamais ouvert.
        if (estBinaireParExtension(S.at(-1) ?? "")) {
          return reponseContenu(demande, feuille, { etat: "binaire", encodage: null, texte: null, lignes: 0, tronque: false, lignesCoupees: 0, secretsMasques: false, invisibles: 0 });
        }
        await pendant("apres-controle");
        // 9. Ouverture sans suivre de lien et sans attendre un écrivain (tube) : ELOOP → lien, ENOENT → introuvable.
        const handle = await fs.open(controle.cible, OUVERTURE);
        try {
          // 10. fstat : fichier ordinaire, un seul nom, mêmes dev et ino qu'au contrôle.
          const ouvert = await handle.stat({ bigint: true });
          if (!ouvert.isFile()) throw new Refus("pas-un-fichier");
          if (ouvert.nlink > 1n) throw new Refus("plusieurs-noms");
          if (ouvert.dev !== feuille.dev || ouvert.ino !== feuille.ino) throw new Refus("a-change");
          // 11. Chemin réel du descripteur (A1).
          await verifierDescripteur(handle.fd, controle.racineReelle, S);
          await pendant("apres-ouverture");
          // 13. Lecture bornée.
          const { octets, tronque } = await lireBorne(handle);
          // 14. Contrôle de fin : taille et date inchangées depuis l'étape 10.
          const fin = await handle.stat({ bigint: true });
          if (fin.size !== ouvert.size || fin.mtimeNs !== ouvert.mtimeNs) throw new Refus("a-change");
          // 15. Décodage et préparation (modules purs).
          const decode = decoderTexte(octets, tronque);
          if (decode.etat !== "texte" || decode.texte === null) {
            return reponseContenu(demande, ouvert, { etat: decode.etat, encodage: decode.encodage, texte: decode.etat === "vide" ? "" : null, lignes: 0, tronque, lignesCoupees: 0, secretsMasques: false, invisibles: 0 });
          }
          const prepare = preparerTexte(decode.texte, tronque);
          return reponseContenu(demande, ouvert, { etat: "texte", encodage: decode.encodage, ...prepare });
        } finally {
          await handle.close().catch(() => undefined);
        }
      });
    } catch (err) {
      return echec(projet, err);
    }
  };

  const dossier = async (demande: DemandeChemin): Promise<Resultat<DossierReponse>> => {
    const projet = String(demande?.projet ?? "");
    try {
      const regles = reglesDemande("dossier", demande);
      if (!regles.ok) return regles;
      const { S, avecProjet } = regles;
      const resultat = await avecPlace(projet, async () => {
        const controle = await controler(S, avecProjet, "dossier");
        await pendant("apres-controle");
        // Lu par son descripteur sous Linux (relecture F2-vague-5) : un aller-retour ne fait plus lister un autre dossier, sur un
        // système de fichiers local ; sur le montage 9p et sans /proc, la seconde résolution au chemin demandé rétrécit la course
        // (relecture F2-vague-6), puis une dernière revérification.
        const liste = await avecDossierOuvert(controle.cible, await identiteDe(controle), controle.racineReelle, S, (lu) => lister(lu, S));
        await pendant("apres-liste");
        await reverifier(controle, S);
        await confirmerListe(controle.cible, liste);
        await reverifier(controle, S);
        liste.entrees.sort(comparerEntrees);
        return { projet: demande.projet, chemin: demande.chemin, entrees: liste.entrees, masques: liste.masques, tronque: liste.tronque };
      });
      return resultat;
    } catch (err) {
      return echec(projet, err);
    }
  };

  const recents = async (demande: DemandeProjet): Promise<Resultat<RecentsReponse>> => {
    const projet = String(demande?.projet ?? "");
    try {
      const regles = reglesDemande("recents", demande);
      if (!regles.ok) return regles;
      const { S, avecProjet } = regles;
      return await avecParcours(projet, demande.signal, async () => {
        const controle = await controler(S, avecProjet, "dossier");
        await pendant("apres-controle");
        const fichiers: RecentsReponse["fichiers"] = [];
        const bilan = await parcourir(
          controle,
          S,
          (trouve) => {
            if (trouve.type === "fichier") fichiers.push({ chemin: trouve.segments.join("/"), taille: Number(trouve.info.size), modifieA: Number(trouve.info.mtimeMs) });
            return false;
          },
          demande.signal,
        );
        fichiers.sort((a, b) => b.modifieA - a.modifieA || (a.chemin < b.chemin ? -1 : a.chemin > b.chemin ? 1 : 0));
        return { projet: demande.projet, fichiers: fichiers.slice(0, NAV_BORNES.RECENTS_MAX), parcourus: bilan.parcourus, incomplet: bilan.incomplet };
      });
    } catch (err) {
      return echec(projet, err);
    }
  };

  const recherche = async (demande: DemandeRecherche): Promise<Resultat<RechercheReponse>> => {
    const projet = String(demande?.projet ?? "");
    try {
      const regles = reglesDemande("recherche", demande);
      if (!regles.ok) return regles;
      const { S, avecProjet } = regles;
      const cherche = normaliserRecherche(demande.texte);
      return await avecParcours(projet, demande.signal, async () => {
        const controle = await controler(S, avecProjet, "dossier");
        await pendant("apres-controle");
        const resultats: RechercheReponse["resultats"] = [];
        const bilan = await parcourir(
          controle,
          S,
          (trouve) => {
            // Sur le NOM seulement, jamais le contenu.
            if (!normaliserRecherche(trouve.segments.at(-1) ?? "").includes(cherche)) return false;
            if (resultats.length >= NAV_BORNES.RESULTATS_MAX) return true;
            resultats.push({ chemin: trouve.segments.join("/"), type: trouve.type });
            return false;
          },
          demande.signal,
        );
        return { projet: demande.projet, texte: demande.texte, resultats, parcourus: bilan.parcourus, incomplet: bilan.incomplet };
      });
    } catch (err) {
      return echec(projet, err);
    }
  };

  return { dossier, contenu, recents, recherche };
}

type Prepare = Omit<ContenuReponse, "projet" | "chemin" | "taille" | "modifieA">;

/** Réponse 200 de « contenu » : projet et chemin tels que demandés (jamais la racine absolue), taille et date du fichier. */
function reponseContenu(demande: DemandeChemin, info: BigIntStats, prepare: Prepare): ContenuReponse {
  return {
    projet: demande.projet,
    chemin: demande.chemin,
    etat: prepare.etat,
    taille: Number(info.size),
    modifieA: Number(info.mtimeMs),
    encodage: prepare.encodage,
    texte: prepare.texte,
    lignes: prepare.lignes,
    tronque: prepare.tronque,
    lignesCoupees: prepare.lignesCoupees,
    secretsMasques: prepare.secretsMasques,
    invisibles: prepare.invisibles,
  };
}
