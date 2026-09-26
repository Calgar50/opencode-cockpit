// Règles pures de l'onglet « Fichiers » (1.1, décisions A19 point 2, A21, A29 D14 (b) ; fiche NAV §2.4 à §2.6 et §2.9) :
// adresses des routes, bornes et listes fermées, chemins (aucune normalisation, aucun décodage), protection, décodage et
// préparation du texte, adresses du web. Module pur (server/shared) : aucun module node, aucun accès au processus, aucune
// horloge ; le serveur (lecteur disque, NAV-2) et le web (NAV-3) l'importent tous deux.
//
// Principe des chemins : la chaîne demandée est découpée sur « / » seulement, sans résolution, sans NFC et sans décoder de
// séquence %XX. Un nom qui contient %XX reste un nom ordinaire, montré en lecture (D14 (b)) : c'est ProjectsService.list() qui
// l'écarte des conversations (A22), jamais ce module. Les alias d'un volume Windows (casse, nom court 8.3, point final, ſ)
// sont refusés ici quand la règle de nom les voit, puis par le nom exact lu dans le dossier parent (G1, lecteur disque).
import { redactSecrets } from "../redact.ts";
import { wildcardMatch } from "./assistant-rules.ts";
import { KEY_FILE_GLOBS } from "./autonomy-edit-rules.ts";
import type { Encodage, FichiersRoute } from "./fichiers-types.ts";
import { sensitivePath } from "./shell-gate.ts";

// --- Routes et bornes (§2.1, §2.4) ----------------------------------------------------------------------------------------------

/** Les quatre routes POST, écrites une seule fois : lues par le serveur (routes-fichiers.ts) et par le client (api-fichiers.ts). */
export const FICHIERS_ROUTES: Readonly<Record<FichiersRoute, string>> = Object.freeze({
  dossier: "/api/fichiers/dossier",
  contenu: "/api/fichiers/contenu",
  recents: "/api/fichiers/recents",
  recherche: "/api/fichiers/recherche",
});

export const NAV_BORNES = Object.freeze({
  /** Corps d'une requête (bodyLimit, 413 « trop-long »). */
  CORPS_MAX_OCTETS: 8 * 1_024,
  CHEMIN_MAX_CARACTERES: 2_048,
  SEGMENT_MAX_CARACTERES: 255,
  SEGMENTS_MAX: 64,
  RECHERCHE_MAX_CARACTERES: 100,
  /** Liste d'un dossier : au-delà, « tronque ». */
  ENTREES_MAX: 1_000,
  /** Entrées lues dans le dossier parent pour trouver un nom exact (G1). */
  NOM_EXACT_MAX: 20_000,
  /** Lecture d'un fichier : LECTURE_MAX_OCTETS + 1 octet lu pour savoir s'il est tronqué, par morceaux de MORCEAU_OCTETS. */
  LECTURE_MAX_OCTETS: 256 * 1_024,
  MORCEAU_OCTETS: 64 * 1_024,
  LIGNES_MAX: 10_000,
  LIGNE_MAX_CARACTERES: 2_000,
  /** Octet NUL cherché dans les premiers octets ; part de caractères de contrôle au-delà de laquelle le texte est « binaire ». */
  DETECTION_OCTETS: 8_192,
  CONTROLE_PART_MAX: 0.01,
  PARCOURS_ENTREES_MAX: 5_000,
  PARCOURS_NIVEAUX_MAX: 12,
  PARCOURS_DUREE_MS: 2_000,
  RECENTS_MAX: 30,
  RESULTATS_MAX: 100,
  LECTURES_SIMULTANEES: 2,
  ATTENTE_PLACE_MS: 2_000,
  LOT_LSTAT: 16,
  JOURNAL_INTERVALLE_MS: 60_000,
});

// --- Listes fermées (§2.4, §2.6), casse ignorée --------------------------------------------------------------------------------

/** Dossiers générés : masqués par défaut en Simple (G5, choix d'affichage) et jamais parcourus. */
export const GENERES: readonly string[] = Object.freeze([
  "node_modules",
  "__pycache__",
  ".venv",
  "venv",
  ".pytest_cache",
  ".mypy_cache",
  ".ruff_cache",
  ".tox",
  ".gradle",
  ".next",
  ".nuxt",
]);

/** État « binaire » sans ouvrir le fichier (G7). */
export const EXTENSIONS_BINAIRES: readonly string[] = Object.freeze(
  [
    "zip 7z rar gz tgz bz2 xz zst tar iso img vhd vhdx", // archives et disques
    "exe dll msi sys so dylib bin class jar war pyc pyo whl", // programmes et bibliothèques
    "db sqlite sqlite3 mdf ldf bak dmp pst ost", // bases et sauvegardes
    "pdf doc docx xls xlsx xlsm ppt pptx odt ods odp", // documents
    "png jpg jpeg gif bmp ico webp tif tiff psd", // images
    "mp3 wav flac ogg mp4 mkv avi mov webm", // audio et vidéo
    "woff woff2 ttf otf eot", // polices
    "parquet pkl npy npz h5 onnx pt", // données
  ].flatMap((famille) => famille.split(" ")),
);

/** Scripts et sources : seule famille concernée par l'exception A6 (§2.6). */
export const EXTENSIONS_CODE: readonly string[] = Object.freeze(
  "ps1 psm1 psd1 py js mjs cjs ts tsx jsx sh bash zsh bat cmd vbs sql cs vb java kt go rs rb php pl r md rst html css scss".split(" "),
);

/** Liste propre à NAV (§2.6, règle 3), en plus de sensitivePath et de KEY_FILE_GLOBS. */
export const NAV_PROTEGES = Object.freeze({
  extensions: Object.freeze(["ppk", "keytab", "rdp", "kdb"]) as readonly string[],
  noms: Object.freeze([
    ".htpasswd",
    "_netrc",
    ".mcp.json",
    "opencode.json",
    "opencode.jsonc",
    // historiques de commandes (consolehost_history.txt : PSReadLine)
    ".bash_history",
    ".zsh_history",
    ".python_history",
    ".psql_history",
    ".mysql_history",
    ".node_repl_history",
    "consolehost_history.txt",
    "$recycle.bin",
    "system volume information",
  ]) as readonly string[],
});

const GENERES_SET: ReadonlySet<string> = new Set(GENERES);
const BINAIRES_SET: ReadonlySet<string> = new Set(EXTENSIONS_BINAIRES);
const CODE_SET: ReadonlySet<string> = new Set(EXTENSIONS_CODE);
const NAV_EXTENSIONS_SET: ReadonlySet<string> = new Set(NAV_PROTEGES.extensions);
const NAV_NOMS_SET: ReadonlySet<string> = new Set(NAV_PROTEGES.noms);

/** Extension en minuscules, sans le point : texte après le dernier « . » qui n'est ni en tête ni en fin ; sinon "". */
export function extensionDe(nom: string): string {
  const point = nom.lastIndexOf(".");
  return point > 0 && point < nom.length - 1 ? nom.slice(point + 1).toLowerCase() : "";
}

/** Nom d'un dossier généré (GENERES), casse ignorée. */
export function estGenere(nom: string): boolean {
  return GENERES_SET.has(nom.toLowerCase());
}

/** Extension de la liste fermée EXTENSIONS_BINAIRES (G7) : le fichier est « binaire » sans être ouvert. */
export function estBinaireParExtension(nom: string): boolean {
  return BINAIRES_SET.has(extensionDe(nom));
}

// --- Chemins (§2.5) ------------------------------------------------------------------------------------------------------------

/** Caractères refusés dans un nom : séparateurs, et caractères interdits par NTFS (A3). */
const CARACTERES_INTERDITS: ReadonlySet<string> = new Set(["/", "\\", ":", "<", ">", '"', "|", "?", "*"]);

/**
 * Noms réservés de Windows (A3), avec ou sans extension, casse ignorée. Ajout à la liste de la fiche : COM¹ à COM³ et LPT¹ à
 * LPT³ (chiffres en exposant), que Windows réserve aussi.
 */
const NOMS_RESERVES: ReadonlySet<string> = new Set([
  "con",
  "prn",
  "aux",
  "nul",
  "conin$",
  "conout$",
  ..."0123456789¹²³".split("").flatMap((chiffre) => [`com${chiffre}`, `lpt${chiffre}`]),
]);

const REMPLACEMENT = 0xfffd;

/** Caractère de contrôle C0 (U+0000 à U+001F), DEL ou C1 (U+007F à U+009F). */
const estControle = (code: number): boolean => code <= 0x1f || (code >= 0x7f && code <= 0x9f);

const estSurrogatHaut = (code: number): boolean => code >= 0xd800 && code <= 0xdbff;
const estSurrogatBas = (code: number): boolean => code >= 0xdc00 && code <= 0xdfff;

/** Nom court 8.3 possible (même règle que mayBeShortName d'autonomy-edit-rules.ts, recopiée car non exportée). */
function peutEtreNomCourt(nom: string): boolean {
  return nom.length <= 12 && /~[0-9]/.test(nom);
}

/** Nom réservé de Windows : partie avant le premier point, espaces finales retirées (Windows les ignore aussi). */
function estNomReserve(nom: string): boolean {
  const point = nom.indexOf(".");
  let fin = point === -1 ? nom.length : point;
  while (fin > 0 && nom.charAt(fin - 1) === " ") fin--;
  return NOMS_RESERVES.has(nom.slice(0, fin).toLowerCase());
}

/**
 * Règle d'un seul nom (§2.5). Dans une liste, une entrée qui la viole est « douteuse » : montrée, jamais ouverte. Refus : vide,
 * « . » ou « .. », plus de 255 caractères, séparateur ou caractère interdit par NTFS, caractère de contrôle, U+FFFD (nom qui
 * n'était pas en UTF-8) ou UTF-16 mal formé (même sens, ajout de NAV-1), point ou espace final, nom court 8.3 possible, nom
 * réservé de Windows.
 */
export function segmentSur(nom: unknown): boolean {
  if (typeof nom !== "string" || nom.length === 0 || nom.length > NAV_BORNES.SEGMENT_MAX_CARACTERES) return false;
  if (nom === "." || nom === "..") return false;
  for (let i = 0; i < nom.length; i++) {
    const code = nom.charCodeAt(i);
    if (estControle(code) || code === REMPLACEMENT || CARACTERES_INTERDITS.has(nom.charAt(i))) return false;
    if (estSurrogatHaut(code)) {
      if (!estSurrogatBas(nom.charCodeAt(i + 1))) return false;
      i++;
    } else if (estSurrogatBas(code)) {
      return false;
    }
  }
  if (nom.endsWith(".") || nom.endsWith(" ")) return false;
  return !peutEtreNomCourt(nom) && !estNomReserve(nom);
}

export type CheminAnalyse = { ok: true; segments: string[] } | { ok: false };

/**
 * Chemin relatif au projet, « / » comme seul séparateur, "" pour le projet lui-même. Aucune normalisation ni aucun décodage :
 * « %2e%2e » ou « a%2F..%2Fx » restent des noms littéraux (le disque dira « introuvable »). Refusé : autre chose qu'une chaîne,
 * plus de 2 048 caractères ou de 64 segments, « / » en tête ou en fin, segment vide ou qui viole segmentSur.
 */
export function analyserChemin(chemin: unknown): CheminAnalyse {
  if (typeof chemin !== "string" || chemin.length > NAV_BORNES.CHEMIN_MAX_CARACTERES) return { ok: false };
  if (chemin === "") return { ok: true, segments: [] };
  if (chemin.startsWith("/") || chemin.endsWith("/")) return { ok: false };
  const segments = chemin.split("/");
  if (segments.length > NAV_BORNES.SEGMENTS_MAX || !segments.every(segmentSur)) return { ok: false };
  return { ok: true, segments };
}

/** PROJECT_NAME de projects.ts, recopié (projects.ts n'est pas un module pur) : le NUL y est écrit par son code. */
const PROJECT_NAME = new RegExp(`^[^\\\\/:*?"<>|${String.fromCharCode(0)}]{1,255}$`);

/** IGNORED de projects.ts : dossiers de premier niveau jamais proposés comme projets. */
const PROJETS_ECARTES: ReadonlySet<string> = new Set(["node_modules", "$recycle.bin", "system volume information", "__pycache__"]);

/**
 * Projet parcourable : "" (la racine, « Tout le workspace »), ou un nom de premier niveau qui tient segmentSur et PROJECT_NAME,
 * ne commence pas par « . », n'est pas écarté par projects.ts et est égal à son trim(). Règle de nom seulement, sans accès au
 * disque (ProjectsService.resolve fait un stat, donc suit un lien). Un nom %XX y est navigable (D14 (b)) ; un nom protégé
 * (« secrets ») aussi : estProtege le refuse ensuite.
 */
export function projetNavigable(nom: unknown): boolean {
  if (nom === "") return true;
  return (
    typeof nom === "string" &&
    segmentSur(nom) &&
    PROJECT_NAME.test(nom) &&
    !nom.startsWith(".") &&
    !PROJETS_ECARTES.has(nom.toLowerCase()) &&
    nom.trim() === nom
  );
}

// --- Protection (§2.6) ---------------------------------------------------------------------------------------------------------

/** Noms sensibles que l'exception A6 ne lève jamais, même pour un script. */
const NOMS_SANS_EXCEPTION: readonly string[] = Object.freeze(["id_rsa", "id_dsa", "id_ecdsa", "id_ed25519", "privkey", "kubeconfig", "credential"]);

/**
 * Morceaux littéraux d'un motif de wildcardMatch (hors « * » et « ? »), en minuscules, barres inverses lues « / » ; une fin
 * « espace, étoile », que wildcardMatch rend facultative, ne garde pas son espace.
 */
function litterauxDe(glob: string): readonly string[] {
  const motif = glob.replaceAll("\\", "/");
  const source = motif.endsWith(" *") ? `${motif.slice(0, -2)}*` : motif;
  return source.toLowerCase().split(/[*?]/).filter((morceau) => morceau !== "");
}

const LITTERAUX_CLES: ReadonlyMap<string, readonly string[]> = new Map(KEY_FILE_GLOBS.map((glob) => [glob, litterauxDe(glob)]));

/** KEY_FILE_GLOBS sans « / » : comparés à chaque segment ; avec « / » (seul *.kube/config) : à chaque début du chemin. */
const GLOBS_SEGMENT: readonly string[] = KEY_FILE_GLOBS.filter((glob) => !glob.includes("/"));
const GLOBS_PREFIXE: readonly string[] = KEY_FILE_GLOBS.filter((glob) => glob.includes("/"));

/**
 * wildcardMatch(minuscule, glob, true), précédé d'un tri exact : sans « u », le drapeau « i » ne replie que la casse ASCII, donc
 * chaque morceau littéral du motif figure, en minuscules, dans tout texte en minuscules qui lui correspond (barres inverses lues
 * « / », comme wildcardMatch). Le tri évite de construire l'expression du motif pour la plupart des noms (une liste de 1 000
 * entrées, un parcours de 5 000 : 1,4 s sans tri, 80 ms avec, mesurés à profondeur 12).
 */
export function correspondMotifCle(minuscule: string, glob: string): boolean {
  const normal = minuscule.replaceAll("\\", "/");
  const litteraux = LITTERAUX_CLES.get(glob) ?? litterauxDe(glob);
  return litteraux.every((morceau) => normal.includes(morceau)) && wildcardMatch(minuscule, glob, true);
}

/** Exception A6 : genre « nom » seulement pour secret, passw ou token, sur un script ou un source (EXTENSIONS_CODE). */
function exceptionScript(minuscule: string): boolean {
  return !NOMS_SANS_EXCEPTION.some((nom) => minuscule.includes(nom)) && CODE_SET.has(extensionDe(minuscule));
}

/** Règles 1 à 3 sur des segments déjà en minuscules. */
function protegeMinuscules(segments: readonly string[]): boolean {
  for (let i = 0; i < segments.length; i++) {
    const segment = segments[i] ?? "";
    const prefixe = segments.slice(0, i + 1).join("/");
    // 1. sensitivePath (shell-gate.ts), sur le début du chemin jusqu'à ce segment, sauf exception A6.
    const genre = sensitivePath(prefixe);
    if (genre !== null && !(genre === "nom" && exceptionScript(segment))) return true;
    // 2. KEY_FILE_GLOBS (dont *.env.* : .env.example est protégé), par wildcardMatch casse ignorée.
    if (GLOBS_SEGMENT.some((glob) => correspondMotifCle(segment, glob))) return true;
    if (GLOBS_PREFIXE.some((glob) => correspondMotifCle(prefixe, glob))) return true;
    // 3. NAV_PROTEGES.
    if (NAV_NOMS_SET.has(segment) || NAV_EXTENSIONS_SET.has(extensionDe(segment))) return true;
  }
  return false;
}

/** Repli de casse complet (majuscules puis minuscules) : « ſecrets » (s long) devient « secrets », comme sur NTFS. */
const plier = (texte: string): string => texte.toUpperCase().toLowerCase();

/**
 * Vrai si un segment, projet compris (en tête, sauf la racine ""), est protégé : règle de sensitivePath (exception A6 pour les
 * scripts), KEY_FILE_GLOBS, NAV_PROTEGES, casse ignorée. Un dossier protégé l'est avec tout ce qu'il contient. Décidé avant
 * tout accès au disque. Les segments sont examinés en minuscules, puis repliés s'ils changent au repli (ajout de NAV-1 : un
 * alias de casse Unicode comme « ſecrets », que G1 refuse à l'ouverture, est aussi masqué dans une liste). Entrée qui n'est
 * pas un tableau de chaînes : vrai (fermé en cas de doute).
 */
export function estProtege(segments: readonly string[]): boolean {
  if (!Array.isArray(segments) || segments.some((segment) => typeof segment !== "string")) return true;
  const minuscules = segments.map((segment) => segment.toLowerCase());
  if (protegeMinuscules(minuscules)) return true;
  const plies = segments.map(plier);
  return plies.some((segment, i) => segment !== minuscules[i]) && protegeMinuscules(plies);
}

// --- Décodage (§2.9, A4 : sans ICU) --------------------------------------------------------------------------------------------

export interface TexteDecode {
  etat: "texte" | "vide" | "binaire";
  encodage: Encodage | null;
  /** null pour « binaire » ; "" pour « vide ». */
  texte: string | null;
}

/**
 * windows-1252, octets 0x80 à 0x9F (table WHATWG) ; 0x81, 0x8D, 0x8F, 0x90 et 0x9D, non attribués, deviennent U+FFFD (la
 * table WHATWG les laisse en C1 : les deux comptent comme caractères de contrôle au contrôle final).
 */
export const WINDOWS_1252_80_9F: readonly number[] = Object.freeze([
  0x20ac, 0xfffd, 0x201a, 0x0192, 0x201e, 0x2026, 0x2020, 0x2021, 0x02c6, 0x2030, 0x0160, 0x2039, 0x0152, 0xfffd, 0x017d, 0xfffd,
  0xfffd, 0x2018, 0x2019, 0x201c, 0x201d, 0x2022, 0x2013, 0x2014, 0x02dc, 0x2122, 0x0161, 0x203a, 0x0153, 0xfffd, 0x017e, 0x0178,
]);

/** Table pure : 0x00 à 0x7F en ASCII, 0xA0 à 0xFF en Latin-1, 0x80 à 0x9F par WINDOWS_1252_80_9F. */
function decoderWindows1252(octets: Uint8Array): string {
  const morceaux: string[] = [];
  const codes: number[] = [];
  for (const octet of octets) {
    codes.push(octet >= 0x80 && octet <= 0x9f ? (WINDOWS_1252_80_9F[octet - 0x80] ?? REMPLACEMENT) : octet);
    if (codes.length === 4_096) {
      morceaux.push(String.fromCharCode(...codes));
      codes.length = 0;
    }
  }
  morceaux.push(String.fromCharCode(...codes));
  return morceaux.join("");
}

/**
 * UTF-16LE (BOM retiré par le décodeur). Tronqué : le décodage en flux garde hors du texte un dernier octet impair et une moitié
 * de paire de substitution ; sinon, ils deviennent U+FFFD, compté au contrôle final.
 */
function decoderUtf16le(octets: Uint8Array, tronque: boolean): string {
  return new TextDecoder("utf-16le").decode(octets, { stream: tronque });
}

/** UTF-16BE : octets permutés deux à deux, puis UTF-16LE ; un dernier octet impair reste en place. */
function decoderUtf16be(octets: Uint8Array, tronque: boolean): string {
  const permutes = new Uint8Array(octets.length);
  for (let i = 0; i + 1 < octets.length; i += 2) {
    permutes[i] = octets[i + 1] ?? 0;
    permutes[i + 1] = octets[i] ?? 0;
  }
  if (octets.length % 2 === 1) permutes[octets.length - 1] = octets[octets.length - 1] ?? 0;
  return decoderUtf16le(permutes, tronque);
}

/** UTF-8 strict ; tronqué : un caractère coupé à la fin reste hors du texte (stream), jamais un U+FFFD final. */
function decoderUtf8Strict(octets: Uint8Array, tronque: boolean): string | null {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(octets, { stream: tronque });
  } catch {
    // Octets qui ne sont pas de l'UTF-8 : l'appelant essaie la suite de l'ordre.
    return null;
  }
}

/** Part des caractères de contrôle : C0 sauf TAB, LF, CR et FF ; DEL ; C1 ; U+FFFD. */
function partDeControle(texte: string): number {
  if (texte.length === 0) return 0;
  let n = 0;
  for (let i = 0; i < texte.length; i++) {
    const code = texte.charCodeAt(i);
    if ((estControle(code) && code !== 0x09 && code !== 0x0a && code !== 0x0d && code !== 0x0c) || code === REMPLACEMENT) n++;
  }
  return n / texte.length;
}

const BINAIRE: TexteDecode = Object.freeze({ etat: "binaire", encodage: null, texte: null });

function resultat(encodage: Encodage, texte: string): TexteDecode {
  if (texte === "") return { etat: "vide", encodage, texte: "" };
  if (partDeControle(texte) > NAV_BORNES.CONTROLE_PART_MAX) return BINAIRE;
  return { etat: "texte", encodage, texte };
}

/**
 * Décodage, dans l'ordre (§2.9) : 0 octet → vide ; BOM UTF-8 → UTF-8 strict (invalide : binaire) ; FF FE → UTF-16LE ;
 * FE FF → UTF-16BE ; octet NUL dans les DETECTION_OCTETS premiers → binaire ; UTF-8 strict ; sinon windows-1252 par table.
 * Puis contrôle final : plus de CONTROLE_PART_MAX de caractères de contrôle → binaire (texte null). Un texte décodé vide (BOM
 * seul) est « vide ».
 */
export function decoderTexte(octets: Uint8Array, tronque: boolean): TexteDecode {
  if (octets.length === 0) return { etat: "vide", encodage: null, texte: "" };
  const [a, b, c] = [octets[0], octets[1], octets[2]];
  if (a === 0xef && b === 0xbb && c === 0xbf) {
    const texte = decoderUtf8Strict(octets, tronque);
    return texte === null ? BINAIRE : resultat("utf-8-bom", texte);
  }
  if (a === 0xff && b === 0xfe) return resultat("utf-16le", decoderUtf16le(octets, tronque));
  if (a === 0xfe && b === 0xff) return resultat("utf-16be", decoderUtf16be(octets, tronque));
  if (octets.subarray(0, NAV_BORNES.DETECTION_OCTETS).includes(0)) return BINAIRE;
  const utf8 = decoderUtf8Strict(octets, tronque);
  if (utf8 !== null) return resultat("utf-8", utf8);
  return resultat("windows-1252", decoderWindows1252(octets));
}

// --- Préparation et masquage (§2.9, A2) ----------------------------------------------------------------------------------------

export interface TextePrepare {
  texte: string;
  lignes: number;
  tronque: boolean;
  lignesCoupees: number;
  secretsMasques: boolean;
  invisibles: number;
}

/** Ligne masquée : bloc de clé privée, ou valeur remplacée par redactSecrets (même marque). */
const MASQUE = "****";

/** Caractère rendu visible : bidirectionnel, largeur nulle, ou contrôle sauf TAB (§2.9, règle 5). */
function estInvisible(code: number): boolean {
  return (
    (code >= 0x202a && code <= 0x202e) ||
    (code >= 0x2066 && code <= 0x2069) ||
    code === 0x200e ||
    code === 0x200f ||
    code === 0x061c ||
    (code >= 0x200b && code <= 0x200d) ||
    code === 0x2060 ||
    code === 0xfeff ||
    (estControle(code) && code !== 0x09)
  );
}

/** « ⟦U+XXXX⟧ », hexadécimal majuscule, 4 à 6 chiffres. */
const marqueur = (code: number): string => `⟦U+${code.toString(16).toUpperCase().padStart(4, "0")}⟧`;

function marquerInvisibles(texte: string): { texte: string; compte: number } {
  let compte = 0;
  let sortie = "";
  let depuis = 0;
  for (let i = 0; i < texte.length; i++) {
    const code = texte.charCodeAt(i);
    if (!estInvisible(code)) continue;
    sortie += texte.slice(depuis, i) + marqueur(code);
    depuis = i + 1;
    compte++;
  }
  return compte === 0 ? { texte, compte } : { texte: sortie + texte.slice(depuis), compte };
}

/** Caractères invisibles et de contrôle d'un nom montrés « ⟦U+XXXX⟧ » (règle 5) ; le web l'affiche dans un élément bdi. */
export function rendreVisible(nom: string): string {
  return marquerInvisibles(nom).texte;
}

/** Coupe à `max` unités sans séparer une paire de substitution. */
function couper(ligne: string, max: number): string {
  return ligne.slice(0, estSurrogatHaut(ligne.charCodeAt(max - 1)) ? max - 1 : max);
}

const ouvreBlocCle = (ligne: string): boolean => ligne.includes("-----BEGIN") && ligne.includes("PRIVATE KEY");

/**
 * Masqueur ligne à ligne (A2) : une ligne qui contient « -----BEGIN » et « PRIVATE KEY » ouvre un bloc, fermé par la ligne qui
 * contient « -----END » ou par la fin du texte ; chaque ligne du bloc devient « **** » (même nombre de lignes). Toute autre
 * ligne passe par redactSecrets.
 */
function masqueurLignes(): (ligne: string) => string {
  let dansBloc = false;
  return (ligne) => {
    if (dansBloc) {
      dansBloc = !ligne.includes("-----END");
      return MASQUE;
    }
    if (!ouvreBlocCle(ligne)) return redactSecrets(ligne);
    // Bloc écrit sur une seule ligne : la fin suit le début sur la même ligne.
    dansBloc = !ligne.slice(ligne.indexOf("-----BEGIN") + 1).includes("-----END");
    return MASQUE;
  };
}

/**
 * Préparation (§2.9) : coupe au dernier saut de ligne si tronqué ; découpage sur LF, CR final retiré, LIGNES_MAX lignes au plus ;
 * lignes coupées à LIGNE_MAX_CARACTERES (borne aussi le coût des expressions de redact.ts) ; blocs de clé privée PEM masqués
 * ligne par ligne, sans changer le nombre de lignes (A2), puis redactSecrets sur chaque autre ligne ; invisibles marqués. Un
 * saut de ligne final (fichier entier) ne crée pas de ligne vide de plus.
 */
export function preparerTexte(texte: string, tronque: boolean): TextePrepare {
  let source = texte;
  if (tronque) {
    const fin = source.lastIndexOf("\n");
    if (fin >= 0) source = source.slice(0, fin);
  }
  const brutes = source.split("\n");
  if (!tronque && brutes.length > 1 && brutes[brutes.length - 1] === "") brutes.pop();
  let estTronque = tronque;
  if (brutes.length > NAV_BORNES.LIGNES_MAX) {
    brutes.length = NAV_BORNES.LIGNES_MAX;
    estTronque = true;
  }
  let lignesCoupees = 0;
  let secretsMasques = false;
  let invisibles = 0;
  const masquer = masqueurLignes();
  const sortie: string[] = [];
  for (const brute of brutes) {
    let ligne = brute.endsWith("\r") ? brute.slice(0, -1) : brute;
    if (ligne.length > NAV_BORNES.LIGNE_MAX_CARACTERES) {
      ligne = couper(ligne, NAV_BORNES.LIGNE_MAX_CARACTERES);
      lignesCoupees++;
    }
    const masquee = masquer(ligne);
    if (masquee !== ligne) secretsMasques = true;
    const visible = marquerInvisibles(masquee);
    invisibles += visible.compte;
    sortie.push(visible.texte);
  }
  return { texte: sortie.join("\n"), lignes: sortie.length, tronque: estTronque, lignesCoupees, secretsMasques, invisibles };
}

/** Recherche sur le nom : NFD, marques U+0300 à U+036F retirées, puis minuscules (casse et accents ignorés). */
export function normaliserRecherche(texte: string): string {
  const decompose = texte.normalize("NFD");
  let sortie = "";
  for (let i = 0; i < decompose.length; i++) {
    const code = decompose.charCodeAt(i);
    if (code < 0x0300 || code > 0x036f) sortie += decompose.charAt(i);
  }
  return sortie.toLowerCase();
}

// --- Affichage --------------------------------------------------------------------------------------------------------------

const UNITES: readonly string[] = Object.freeze(["Ko", "Mo", "Go", "To"]);

/**
 * « 0 o », « 512 o », « 12 Ko », « 1,2 Mo », « 3,4 Go » : unités de 1 024, virgule française, un chiffre après la virgule
 * (« ,0 » omis).
 */
export function tailleLisible(octets: number): string {
  const n = Number.isFinite(octets) && octets > 0 ? Math.floor(octets) : 0;
  if (n < 1_024) return `${n} o`;
  let valeur = n / 1_024;
  let unite = 0;
  while (unite < UNITES.length - 1 && Math.round(valeur * 10) / 10 >= 1_024) {
    valeur /= 1_024;
    unite++;
  }
  const arrondi = Math.round(valeur * 10) / 10;
  const texte = Number.isInteger(arrondi) ? String(arrondi) : arrondi.toFixed(1).replace(".", ",");
  return `${texte} ${UNITES[unite]}`;
}

// --- Adresses du web (#/fichiers?projet=…&chemin=…) ----------------------------------------------------------------------------

const SECTION = "#/fichiers";

/**
 * Adresse de l'onglet, construite par URLSearchParams : `projet` écrit dès qu'il est donné (même "", la racine), `chemin` s'il
 * n'est pas vide. Un nom %XX y est encodé « %25XX » et relu littéral par lireAdresse.
 */
export function adresseFichiers(cible: { projet?: string; chemin?: string } = {}): string {
  const params = new URLSearchParams();
  if (typeof cible.projet === "string") params.set("projet", cible.projet);
  if (typeof cible.chemin === "string" && cible.chemin !== "") params.set("chemin", cible.chemin);
  const requete = params.toString();
  return requete === "" ? SECTION : `${SECTION}?${requete}`;
}

export interface AdresseLue {
  projet: string;
  segments: string[];
}

/**
 * Lit l'adresse (paramètres du fragment). null si un paramètre est répété, si le projet n'est pas navigable ou si le chemin est
 * refusé par analyserChemin. Sans `projet` : un chemin de 2 segments ou plus dont le premier est navigable donne le projet ;
 * sinon, la racine "".
 */
export function lireAdresse(query: URLSearchParams): AdresseLue | null {
  const projets = query.getAll("projet");
  const chemins = query.getAll("chemin");
  if (projets.length > 1 || chemins.length > 1) return null;
  const analyse = analyserChemin(chemins[0] ?? "");
  if (!analyse.ok) return null;
  const projet = projets[0];
  if (projet !== undefined) return projetNavigable(projet) ? { projet, segments: analyse.segments } : null;
  const [premier, ...reste] = analyse.segments;
  if (premier !== undefined && reste.length > 0 && projetNavigable(premier)) return { projet: premier, segments: reste };
  return { projet: "", segments: analyse.segments };
}

const OUTILS_FICHIER: ReadonlySet<string> = new Set(["read", "write", "edit", "multiedit"]);

/** Retire les séparateurs de fin (boucle, sans expression régulière à retour arrière). */
function sansSeparateursFinaux(texte: string, separateurs: string): string {
  let fin = texte.length;
  while (fin > 0 && separateurs.includes(texte.charAt(fin - 1))) fin--;
  return texte.slice(0, fin);
}

/**
 * Chemin relatif de `fichier` sous `racine` : même comparaison que relativePath de ToolCard.tsx (barres inverses remplacées,
 * barres finales de la racine retirées, casse ignorée), recopiée car le web n'est pas importé ici ; la coupe se fait sur la
 * longueur du texte d'origine. null hors de la racine.
 */
function relatifSous(fichier: string, racine: string): string | null {
  const norm = fichier.replaceAll("\\", "/");
  const base = sansSeparateursFinaux(racine.replaceAll("\\", "/"), "/");
  if (base === "" || norm.slice(0, base.length + 1).toLowerCase() !== `${base.toLowerCase()}/`) return null;
  return norm.slice(base.length + 1);
}

/**
 * Lien « Ouvrir dans Fichiers » d'une carte d'outil : seulement pour read, write, edit ou multiedit au statut « completed », sur
 * un fichier situé sous `racine` (la racine du dossier de travail vue par opencode) dont le chemin relatif passe analyserChemin.
 * Le premier segment devient le projet s'il est navigable et suivi d'un autre ; sinon la racine "". Sinon null.
 */
export function adresseDepuisOutil(appel: { outil: unknown; statut: unknown; fichier: unknown; racine: unknown }): string | null {
  const { outil: nom, statut, fichier, racine } = appel;
  if (typeof nom !== "string" || !OUTILS_FICHIER.has(nom) || statut !== "completed") return null;
  if (typeof fichier !== "string" || typeof racine !== "string") return null;
  const relatif = relatifSous(fichier, racine);
  if (relatif === null) return null;
  const analyse = analyserChemin(relatif);
  if (!analyse.ok || analyse.segments.length === 0) return null;
  const [premier, ...reste] = analyse.segments;
  if (premier !== undefined && reste.length > 0 && projetNavigable(premier)) return adresseFichiers({ projet: premier, chemin: reste.join("/") });
  return adresseFichiers({ projet: "", chemin: relatif });
}

/**
 * Emplacement sur le poste de l'utilisateur (dossier de travail de l'hôte, `hostDir`) : joint par « \ » si hostDir commence par
 * une lettre de lecteur suivie de « : », sinon par « / ». null si hostDir est vide.
 */
export function emplacementSurLePoste(hostDir: string, projet: string, segments: readonly string[]): string | null {
  if (typeof hostDir !== "string" || hostDir === "") return null;
  const windows = /^[A-Za-z]:/.test(hostDir);
  const separateur = windows ? "\\" : "/";
  const parties = [...(projet === "" ? [] : [projet]), ...segments];
  if (parties.length === 0) return hostDir;
  const base = sansSeparateursFinaux(hostDir, windows ? "\\/" : "/");
  return `${base}${separateur}${parties.join(separateur)}`;
}
