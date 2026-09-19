// Détections de la Salle OMO, module PUR (spécification §4.14.5, JS-6, JS-7 ; §3.4 l.203 ; §5.7.2 cas 7 ; G13 ; plan d'exécution
// 2 bis et 2 ter, fiche L23a, D-2b-18, D-2b-29, D-2b-37, MO-5, R16) : ni « node: », ni process, ni horloge, ni aléa.
//
// `detect(etat, entree)` lit UN fait déjà réduit par le service de détections (L23c, V4) et rend le nouvel état, au plus une
// détection, les fichiers signalés et les `.git` à mettre en quarantaine. Le service fait tout le reste : lecture des événements
// de l'instance `omo`, arbre des sessions, registre des réponses du portillon, origine des messages (message-origin.ts), demande
// active (`omoActivation.activeRequest()`), relevés bornés du disque (L19a), quarantaine (`renommerSansSuivreLiens`) et arrêt
// (`omoStop`, L23b). Aucun branchement ici. Aucune échéance non plus : le module ne lit jamais l'heure.
//
// Règles tenues :
// - fermé en cas de doute : un drapeau absent ou mal typé vaut « non émis », « non demandé », « hors demande » ; un relevé du
//   disque incomplet, un fichier illisible, un chemin invalide ou une liste de dossiers vide valent une modification des
//   fichiers d'IDE et de CI ;
// - une détection est APRÈS COUP (§4.14.5) : un programme a pu agir avant l'arrêt ;
// - gardes contre les faux positifs (G13 : zéro faux positif) : enfant avec `parentID` ; racine ouverte par le cockpit ; écho d'un
//   PATCH du cockpit ; `session.updated` sans changement de permission ; nouvelle tentative suivie d'un progrès ; même nouvelle
//   tentative reçue deux fois ; configuration, `.git`, fichiers d'IDE et de CI présents au démarrage et inchangés ;
//   `node_modules` ignoré pour `.git` et les fichiers signalés (comme le balayage de D-2b-28) ;
// - le service ne transmet que des faits NOUVEAUX (jamais une resynchronisation) et rien pendant un arrêt ou une relance demandés
//   par le cockpit : sinon `dispose` et l'activité de l'arrêt seraient lus comme venant de l'extension ; il repart d'un état
//   initial à chaque relance de la salle ;
// - unions propres au module (plan §2.2) : le train de V0 vérifie qu'elles égalent celles de T3a (`OmoDetectionCause`,
//   `OmoSignale` de `omo-types.ts`, `tentatives429Max` de `omo-limits.ts`) et que les listes de noms égalent celles du
//   pré-contrôle (L19a) et des interdits (L22b).
import type { MessageOrigin } from "./activity-types.ts";

/** Les 10 causes de détection (T3a, `OmoDetectionCause`), dans l'ordre du plan. */
export const OMO_DETECTION_CAUSES = [
  "reponse-non-emise",
  "racine-etrangere",
  "dispose-non-demande",
  "permission-modifiee",
  "origine-inconnue",
  "config-apparue",
  "git-cree",
  "ide-ci-modifie",
  "tentatives-429",
  "activite-hors-demande",
] as const;

export type OmoDetectionCause = (typeof OMO_DETECTION_CAUSES)[number];

/** Fichier signalé (T3a, `OmoSignale`) : à relire, listé en fin de demande ou avec la détection. */
export interface OmoSignale {
  /** Chemin relatif à /workspace, séparateur « / ». */
  chemin: string;
  genre: "ide-ci" | "programme" | "git-quarantaine";
}

/** Nouvelles tentatives d'affilée dans un arbre avant l'arrêt (spécification §4.8.2 ; T3a `tentatives429Max`). */
export const OMO_TENTATIVES_429_MAX = 3;

/** Chemins au plus dans le détail d'une détection (triés ; la quarantaine et les signalés restent complets). */
export const OMO_DETAIL_CHEMINS_MAX = 20;

/**
 * Règle de la détection 4 (permission de session modifiée sans le cockpit), deux variantes (R16) :
 * - « toute-modification » : toute différence, ordre compris (opencode garde la dernière règle qui correspond) ;
 * - « ajout-allow-ou-ask » : seulement une règle `allow` ou `ask` (ou d'action inconnue) absente avant. Repli si MO-5 montre qu'un
 *   `prompt_async` portant `tools` (F-y) remplace la permission de session : un remplacement fait de refus, ou le retrait d'un
 *   refus, ne déclenche alors rien ; la configuration d'instance en lecture seule reste la barrière (§3.4 l.203).
 */
export const OMO_REGLES_PERMISSION = ["toute-modification", "ajout-allow-ou-ask"] as const;

export type OmoReglePermission = (typeof OMO_REGLES_PERMISSION)[number];

/**
 * Variante retenue au train de V0 d'après MO-5 (MX-OMO, 18/09) : « toute-modification », la règle de la spécification (l.844).
 * MO-5 a mesuré qu'un `prompt_async` portant `tools` REMPLACE la liste entière (un retrait n'est visible que par la différence) et
 * que `tools: {x: true}` pose un `allow` : le repli du plan ne supprimerait donc pas les délégations de l'extension, qui passent
 * elles aussi des outils à vrai, et il perdrait les retraits. Le tri des délégations de l'extension (G13, zéro faux positif) reste
 * à régler sur la capture R16 du banc (L21) et dans le service de détections (L23c) ; la variante « ajout-allow-ou-ask » reste
 * disponible par l'option.
 */
export const OMO_REGLE_PERMISSION: OmoReglePermission = "toute-modification";

/**
 * Noms de configuration (liste du pré-contrôle, §3.15.2 l.524, dont `.agents/`, D-2b-34), cherchés à la racine de chaque dossier
 * contrôlé, casse ignorée (dossier de travail Windows). Un dossier compte avec tout son contenu. Les fichiers de clés du
 * pré-contrôle n'en font pas partie : ils ne configurent rien, et un test qui écrit un certificat arrêterait la salle.
 */
export const OMO_CONFIG_NOMS: readonly string[] = [
  ".omo/omo.json",
  ".omo/omo.jsonc",
  "oh-my-openagent.json",
  "oh-my-openagent.jsonc",
  "oh-my-opencode.json",
  "oh-my-opencode.jsonc",
  ".sisyphus",
  ".claude",
  ".mcp.json",
  ".opencode",
  "opencode.json",
  "opencode.jsonc",
  ".agents",
];

/** Fichiers et dossiers d'IDE et de CI (§4.14.5 n° 7), à la racine de chaque dossier contrôlé, casse ignorée. */
export const OMO_IDE_CI_NOMS: readonly string[] = [
  ".vscode",
  ".idea",
  ".devcontainer",
  ".github",
  ".gitlab-ci.yml",
  ".husky",
  ".pre-commit-config.yaml",
  "Jenkinsfile",
];

/** `azure-pipelines*.yml` (§4.14.5 n° 7). */
const AZURE_PIPELINES = /^azure-pipelines[^/]*\.yml$/;

/** Fichiers signalés sans arrêt (§4.14.5) : nom exact à toute profondeur, casse ignorée, plus l'extension `.ps1`. */
export const OMO_PROGRAMME_NOMS: readonly string[] = ["package.json", "Makefile"];

const PROGRAMME_EXTENSION = ".ps1";

/** Règle de permission de session, telle qu'opencode la publie (`session.updated`, `info.permission`). */
export interface OmoPermissionRule {
  permission: string;
  pattern: string;
  action: string;
}

export type OmoDiskForm = "fichier" | "dossier" | "lien" | "autre";

/** Élément relevé sur le disque (L19a) : forme lue par `lstat`, empreinte SHA-256 d'un fichier, null si illisible ou sans objet. */
export interface OmoDiskElement {
  forme: OmoDiskForm;
  empreinte: string | null;
}

/**
 * Relevé borné du disque (L19a) : tous les projets préparés, /workspace et ses dossiers de premier niveau (plan, fiche L23a).
 * Chemins relatifs à /workspace, séparateur « / », sans « ./ », ni « / » au début ou à la fin ; "" désigne /workspace.
 */
export interface OmoDiskSnapshot {
  /** Dossiers contrôlés ("" pour /workspace). */
  dossiers: readonly string[];
  /** Fichiers de configuration, d'IDE et de CI, fichiers signalés et `.git`, avec leur contenu relevé. */
  elements: ReadonlyMap<string, OmoDiskElement>;
  /** Borne atteinte ou lecture impossible : le relevé ne peut pas conclure. */
  incomplet: boolean;
}

/**
 * Fait réduit par le service. `demandeActive` : racine de la demande active dans la salle, null sans demande ; une activité d'un
 * autre arbre, ou d'un arbre inconnu (`rootId` null), est hors demande.
 */
export type OmoDetectionInput =
  | {
      type: "permission.replied";
      sessionId: string;
      rootId: string | null;
      /** Réponse inscrite au registre du portillon de la salle avant son envoi (§4.14.3). */
      emisParPortillon: boolean;
    }
  | {
      type: "session.created";
      sessionId: string;
      parentID: string | null;
      rootId: string | null;
      /** Racine créée par le proxy de la salle (`POST /api/omo/rooms`, `omo_rooms`). Sans objet pour un enfant. */
      racineOuverteParLeCockpit: boolean;
      demandeActive: string | null;
    }
  | { type: "dispose"; evenement: "global.disposed" | "server.instance.disposed"; demandeParLeCockpit: boolean }
  | {
      /** Permission attendue après un PATCH du cockpit sur cette session, inscrite AVANT l'envoi : son écho n'est pas une détection. */
      type: "permission.patch-cockpit";
      sessionId: string;
      permission: readonly OmoPermissionRule[];
    }
  | {
      type: "session.updated";
      sessionId: string;
      rootId: string | null;
      permissionAvant: readonly OmoPermissionRule[];
      permissionApres: readonly OmoPermissionRule[];
    }
  | {
      /** Nouveau message d'une session de la salle. */
      type: "message";
      sessionId: string;
      rootId: string | null;
      racine: boolean;
      /** Origine d'un message utilisateur (§5.7.2, calculée en amont), null pour une réponse ou tant qu'elle est inconnue. */
      origine: MessageOrigin | null;
      demandeActive: string | null;
    }
  | {
      type: "session.status";
      sessionId: string;
      rootId: string | null;
      statut: "busy" | "idle" | "retry";
      /** Numéro de la nouvelle tentative (`status.attempt`), null sinon. */
      tentative: number | null;
      demandeActive: string | null;
    }
  | { type: "usage.updated"; sessionId: string; rootId: string | null; demandeActive: string | null }
  | {
      /** Progrès dans l'arbre (appel d'IA terminé, contenu produit) : remet à zéro le compteur de nouvelles tentatives (D-2b-18). */
      type: "progres";
      rootId: string | null;
    }
  | { type: "disque"; avant: OmoDiskSnapshot; apres: OmoDiskSnapshot };

export interface OmoDetectionDetail {
  /** Arbre concerné ; null pour la salle entière (`dispose`, disque). */
  rootId: string | null;
  sessionId: string | null;
  /** Chemins relatifs à /workspace (détections du disque), triés, au plus OMO_DETAIL_CHEMINS_MAX. */
  chemins: string[];
}

export interface OmoDetection {
  cause: OmoDetectionCause;
  detail: OmoDetectionDetail;
}

interface ArbreTentatives {
  /** Nouvelles tentatives vues dans l'arbre depuis le dernier progrès. */
  nombre: number;
  /** Dernier numéro compté par session, oublié quand la session repasse occupée ou au repos. */
  dernieres: ReadonlyMap<string, number>;
}

/** État des détections : jamais modifié en place, `detect` en rend un nouveau. */
export interface OmoDetectionState {
  readonly tentatives: ReadonlyMap<string, ArbreTentatives>;
  readonly patchs: ReadonlyMap<string, readonly OmoPermissionRule[]>;
}

export interface OmoDetectionOptions {
  reglePermission?: OmoReglePermission;
}

export interface OmoDetectionResult {
  etat: OmoDetectionState;
  detection: OmoDetection | null;
  signales: OmoSignale[];
  quarantaine: string[];
}

export function etatInitial(): OmoDetectionState {
  return { tentatives: new Map(), patchs: new Map() };
}

// --- Outils -----------------------------------------------------------------------------------------------------------------------

const texte = (value: unknown): string | null => (typeof value === "string" && value !== "" ? value : null);

function detection(cause: OmoDetectionCause, rootId: unknown, sessionId: unknown, chemins: readonly string[] = []): OmoDetection {
  const tries = [...new Set(chemins)].sort();
  return { cause, detail: { rootId: texte(rootId), sessionId: texte(sessionId), chemins: tries.slice(0, OMO_DETAIL_CHEMINS_MAX) } };
}

function resultat(etat: OmoDetectionState, found: OmoDetection | null): OmoDetectionResult {
  return { etat, detection: found, signales: [], quarantaine: [] };
}

/** Hors demande : aucune demande active, arbre inconnu ou arbre d'une autre racine que celle de la demande. */
function horsDemande(rootId: unknown, demandeActive: unknown): boolean {
  const active = texte(demandeActive);
  return active === null || texte(rootId) !== active;
}

function avec<V>(map: ReadonlyMap<string, V>, key: string, value: V | undefined): ReadonlyMap<string, V> {
  const copy = new Map(map);
  if (value === undefined) copy.delete(key);
  else copy.set(key, value);
  return copy;
}

// --- Permission de session (détection 4) -------------------------------------------------------------------------------------------

function regle(value: unknown): OmoPermissionRule | null {
  if (typeof value !== "object" || value === null) return null;
  const { permission, pattern, action } = value as Record<string, unknown>;
  return typeof permission === "string" && typeof pattern === "string" && typeof action === "string" ? { permission, pattern, action } : null;
}

/** Règles lues, null si la liste ou une règle est mal formée (vaut une modification). */
function regles(value: unknown): OmoPermissionRule[] | null {
  if (!Array.isArray(value)) return null;
  const out: OmoPermissionRule[] = [];
  for (const item of value) {
    const lue = regle(item);
    if (lue === null) return null;
    out.push(lue);
  }
  return out;
}

const cleRegle = (r: OmoPermissionRule) => JSON.stringify([r.permission, r.pattern, r.action]);

function memesRegles(a: readonly OmoPermissionRule[] | null, b: readonly OmoPermissionRule[] | null): boolean {
  if (a === null || b === null || a.length !== b.length) return false;
  return a.every((r, i) => b[i] !== undefined && cleRegle(r) === cleRegle(b[i]));
}

/** Vrai si `apres` porte une règle autre qu'un refus (`allow`, `ask` ou action inconnue) que `avant` n'avait pas (comptée). */
function ajouteAllowOuAsk(avant: readonly OmoPermissionRule[] | null, apres: readonly OmoPermissionRule[] | null): boolean {
  if (avant === null || apres === null) return true;
  const restantes = new Map<string, number>();
  for (const r of avant) restantes.set(cleRegle(r), (restantes.get(cleRegle(r)) ?? 0) + 1);
  for (const r of apres) {
    if (r.action === "deny") continue;
    const n = restantes.get(cleRegle(r)) ?? 0;
    if (n === 0) return true;
    restantes.set(cleRegle(r), n - 1);
  }
  return false;
}

function permissionModifiee(avant: OmoPermissionRule[] | null, apres: OmoPermissionRule[] | null, variante: unknown): boolean {
  // Variante inconnue : la plus stricte.
  return variante === "ajout-allow-ou-ask" ? ajouteAllowOuAsk(avant, apres) : !memesRegles(avant, apres);
}

// --- Nouvelles tentatives (détection 8, D-2b-18) ----------------------------------------------------------------------------------

const ARBRE_VIDE: ArbreTentatives = { nombre: 0, dernieres: new Map() };

function numeroTentative(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : null;
}

function statut(etat: OmoDetectionState, e: Extract<OmoDetectionInput, { type: "session.status" }>): OmoDetectionResult {
  const rootId = texte(e.rootId);
  const sessionId = texte(e.sessionId) ?? "";
  let tentatives = etat.tentatives;
  let nombre = 0;
  if (rootId !== null) {
    const arbre = tentatives.get(rootId) ?? ARBRE_VIDE;
    if (e.statut === "retry") {
      const numero = numeroTentative(e.tentative);
      // Même numéro sans passage par « occupée » ou « au repos » : le même événement reçu deux fois (opencode repasse
      // « occupée » avant chaque nouvel essai, processor.ts), jamais une nouvelle tentative.
      const doublon = numero !== null && arbre.dernieres.get(sessionId) === numero;
      const compte = doublon ? arbre : { nombre: arbre.nombre + 1, dernieres: avec(arbre.dernieres, sessionId, numero ?? undefined) };
      tentatives = compte === arbre ? tentatives : avec(tentatives, rootId, compte);
      nombre = compte.nombre;
    } else if ((e.statut === "busy" || e.statut === "idle") && arbre.dernieres.has(sessionId)) {
      tentatives = avec(tentatives, rootId, { nombre: arbre.nombre, dernieres: avec(arbre.dernieres, sessionId, undefined) });
    }
  }
  const etatSuivant = tentatives === etat.tentatives ? etat : { ...etat, tentatives };
  // Occupée, nouvelle tentative ou statut inconnu : activité (D-2b-29) ; « au repos » n'en est pas une.
  if (e.statut !== "idle" && horsDemande(e.rootId, e.demandeActive)) {
    return resultat(etatSuivant, detection("activite-hors-demande", e.rootId, e.sessionId));
  }
  if (e.statut === "retry" && nombre >= OMO_TENTATIVES_429_MAX) return resultat(etatSuivant, detection("tentatives-429", e.rootId, e.sessionId));
  return resultat(etatSuivant, null);
}

// --- Disque (détections 6 et 7, fichiers signalés, quarantaine D-2b-37) -----------------------------------------------------------

const FORMES: ReadonlySet<string> = new Set(["fichier", "dossier", "lien", "autre"]);

/** Chemin relatif normalisé (« \ » lu comme séparateur), null s'il est invalide. "" n'est admis que pour un dossier. */
function normaliser(chemin: unknown, dossier: boolean): string | null {
  if (typeof chemin !== "string" || chemin.includes("\0")) return null;
  const brut = chemin.replaceAll("\\", "/");
  if (brut === "") return dossier ? "" : null;
  const segments = brut.split("/");
  return segments.every((s) => s !== "" && s !== "." && s !== "..") ? brut : null;
}

interface Releve {
  elements: Map<string, OmoDiskElement>;
  doute: boolean;
}

function releve(snapshot: OmoDiskSnapshot, dossiers: Set<string>): Releve {
  let doute = snapshot?.incomplet !== false;
  for (const d of Array.isArray(snapshot?.dossiers) ? snapshot.dossiers : []) {
    const n = normaliser(d, true);
    if (n === null) doute = true;
    else dossiers.add(n.toLowerCase());
  }
  if (!Array.isArray(snapshot?.dossiers)) doute = true;
  const elements = new Map<string, OmoDiskElement>();
  const source = snapshot?.elements instanceof Map ? snapshot.elements : null;
  if (source === null) doute = true;
  for (const [chemin, element] of source ?? []) {
    const n = normaliser(chemin, false);
    if (n === null || elements.has(n)) {
      doute = true;
      continue;
    }
    const forme = typeof element?.forme === "string" && FORMES.has(element.forme) ? element.forme : "autre";
    elements.set(n, { forme, empreinte: typeof element?.empreinte === "string" ? element.empreinte : null });
  }
  return { elements, doute };
}

/** Changé : apparu, disparu, forme ou empreinte différente, ou fichier illisible (empreinte absente). */
function change(a: OmoDiskElement | undefined, b: OmoDiskElement | undefined): boolean {
  if (a === undefined || b === undefined) return a !== b;
  if (a.forme !== b.forme || a.empreinte !== b.empreinte) return true;
  return b.forme === "fichier" && b.empreinte === null;
}

/** Chemins relatifs (en minuscules) à chaque dossier contrôlé qui contient `chemin`. */
function relatifs(chemin: string, dossiers: ReadonlySet<string>): string[] {
  const bas = chemin.toLowerCase();
  const out: string[] = [];
  for (const d of dossiers) {
    if (d === "") out.push(bas);
    else if (bas.startsWith(`${d}/`)) out.push(bas.slice(d.length + 1));
  }
  return out;
}

const couvre = (relatif: string, nom: string) => relatif === nom || relatif.startsWith(`${nom}/`);

const CONFIG_BAS = OMO_CONFIG_NOMS.map((n) => n.toLowerCase());
const IDE_CI_BAS = OMO_IDE_CI_NOMS.map((n) => n.toLowerCase());
const PROGRAMME_BAS = new Set(OMO_PROGRAMME_NOMS.map((n) => n.toLowerCase()));

const estConfig = (relatif: string) => CONFIG_BAS.some((nom) => couvre(relatif, nom));

function estIdeCi(relatif: string): boolean {
  return IDE_CI_BAS.some((nom) => couvre(relatif, nom)) || AZURE_PIPELINES.test(relatif.split("/")[0] ?? "");
}

function estProgramme(chemin: string): boolean {
  const segments = chemin.toLowerCase().split("/");
  if (segments.some((s) => s === "node_modules" || s === ".git")) return false;
  const nom = segments.at(-1) ?? "";
  return PROGRAMME_BAS.has(nom) || nom.endsWith(PROGRAMME_EXTENSION);
}

interface Git {
  chemin: string;
  /** Forme de l'élément relevé au chemin même du `.git`, absente s'il n'est connu que par son contenu. */
  forme: OmoDiskForm | undefined;
}

/** `.git` relevés, par chemin en minuscules : premier segment `.git` de chaque chemin, hors `node_modules`. */
function gits(elements: ReadonlyMap<string, OmoDiskElement>): Map<string, Git> {
  const out = new Map<string, Git>();
  for (const [chemin, element] of elements) {
    const segments = chemin.split("/");
    for (let i = 0; i < segments.length; i++) {
      const bas = (segments[i] ?? "").toLowerCase();
      if (bas === "node_modules") break;
      if (bas !== ".git") continue;
      const prefixe = segments.slice(0, i + 1).join("/");
      const cle = prefixe.toLowerCase();
      const connu = out.get(cle);
      const forme = i === segments.length - 1 ? element.forme : undefined;
      out.set(cle, { chemin: connu?.chemin ?? prefixe, forme: forme ?? connu?.forme });
      break;
    }
  }
  return out;
}

const ORDRE_GENRE: Record<OmoSignale["genre"], number> = { "git-quarantaine": 0, "ide-ci": 1, programme: 2 };

function disque(etat: OmoDetectionState, e: Extract<OmoDetectionInput, { type: "disque" }>): OmoDetectionResult {
  const dossiers = new Set<string>();
  const avant = releve(e.avant, dossiers);
  const apres = releve(e.apres, dossiers);
  const doute = avant.doute || apres.doute || dossiers.size === 0;

  const config: string[] = [];
  const ideCi: string[] = [];
  const signales: OmoSignale[] = [];
  for (const chemin of new Set([...avant.elements.keys(), ...apres.elements.keys()])) {
    const a = avant.elements.get(chemin);
    const b = apres.elements.get(chemin);
    if (!change(a, b)) continue;
    const rel = relatifs(chemin, dossiers);
    // Une configuration disparue ne configure plus rien ; un fichier d'IDE ou de CI supprimé compte (fermé en cas de doute).
    if (b !== undefined && rel.some(estConfig)) config.push(chemin);
    if (rel.some(estIdeCi)) {
      ideCi.push(chemin);
      if (b !== undefined) signales.push({ chemin, genre: "ide-ci" });
    }
    if (b !== undefined && estProgramme(chemin)) signales.push({ chemin, genre: "programme" });
  }

  const gitsAvant = gits(avant.elements);
  const quarantaine: string[] = [];
  const gitChanges: string[] = [];
  for (const [cle, git] of gits(apres.elements)) {
    const connu = gitsAvant.get(cle);
    if (connu === undefined) {
      quarantaine.push(git.chemin);
      signales.push({ chemin: git.chemin, genre: "git-quarantaine" });
    } else if (connu.forme !== undefined && git.forme !== undefined && connu.forme !== git.forme) {
      // `.git` présent au démarrage, protégé en lecture seule, dont la forme a changé : jamais renommé (ce peut être l'original).
      gitChanges.push(git.chemin);
    }
  }
  quarantaine.sort();
  signales.sort((x, y) => (x.chemin < y.chemin ? -1 : x.chemin > y.chemin ? 1 : ORDRE_GENRE[x.genre] - ORDRE_GENRE[y.genre]));

  let found: OmoDetection | null = null;
  if (quarantaine.length > 0 || gitChanges.length > 0) found = detection("git-cree", null, null, [...quarantaine, ...gitChanges]);
  else if (config.length > 0) found = detection("config-apparue", null, null, config);
  else if (ideCi.length > 0 || doute) found = detection("ide-ci-modifie", null, null, ideCi);
  return { etat, detection: found, signales, quarantaine };
}

// --- Point d'entrée ---------------------------------------------------------------------------------------------------------------

/**
 * Lit un fait et rend le nouvel état, au plus une détection (la plus précise : une racine étrangère ou une origine inconnue avant
 * l'activité hors demande ; sur le disque, `.git` créé, puis configuration, puis IDE et CI), les fichiers signalés et les `.git` à
 * mettre en quarantaine. Ni `etat` ni `entree` ne sont modifiés.
 */
export function detect(etat: OmoDetectionState, entree: OmoDetectionInput, options: OmoDetectionOptions = {}): OmoDetectionResult {
  switch (entree.type) {
    case "permission.replied":
      return resultat(etat, entree.emisParPortillon === true ? null : detection("reponse-non-emise", entree.rootId, entree.sessionId));

    case "session.created": {
      const racine = texte(entree.parentID) === null;
      if (racine) {
        // Ouverture d'une salle : ni racine étrangère, ni activité de l'extension.
        return resultat(etat, entree.racineOuverteParLeCockpit === true ? null : detection("racine-etrangere", entree.sessionId, entree.sessionId));
      }
      return resultat(etat, horsDemande(entree.rootId, entree.demandeActive) ? detection("activite-hors-demande", entree.rootId, entree.sessionId) : null);
    }

    case "dispose":
      return resultat(etat, entree.demandeParLeCockpit === true ? null : detection("dispose-non-demande", null, null));

    case "permission.patch-cockpit": {
      const permission = regles(entree.permission);
      const sessionId = texte(entree.sessionId);
      if (permission === null || sessionId === null) return resultat(etat, null);
      return resultat({ ...etat, patchs: avec(etat.patchs, sessionId, permission) }, null);
    }

    case "session.updated": {
      const avant = regles(entree.permissionAvant);
      const apres = regles(entree.permissionApres);
      const sessionId = texte(entree.sessionId);
      const attendu = sessionId === null ? undefined : etat.patchs.get(sessionId);
      if (sessionId !== null && attendu !== undefined && memesRegles(attendu, apres)) {
        // Écho du PATCH du cockpit : accepté une fois.
        return resultat({ ...etat, patchs: avec(etat.patchs, sessionId, undefined) }, null);
      }
      const regleChoisie = options.reglePermission ?? OMO_REGLE_PERMISSION;
      return resultat(etat, permissionModifiee(avant, apres, regleChoisie) ? detection("permission-modifiee", entree.rootId, entree.sessionId) : null);
    }

    case "message":
      if (entree.racine !== false && entree.origine === "origine-inconnue") return resultat(etat, detection("origine-inconnue", entree.rootId, entree.sessionId));
      return resultat(etat, horsDemande(entree.rootId, entree.demandeActive) ? detection("activite-hors-demande", entree.rootId, entree.sessionId) : null);

    case "session.status":
      return statut(etat, entree);

    case "usage.updated":
      return resultat(etat, horsDemande(entree.rootId, entree.demandeActive) ? detection("activite-hors-demande", entree.rootId, entree.sessionId) : null);

    case "progres": {
      const rootId = texte(entree.rootId);
      if (rootId === null || !etat.tentatives.has(rootId)) return resultat(etat, null);
      return resultat({ ...etat, tentatives: avec(etat.tentatives, rootId, undefined) }, null);
    }

    case "disque":
      return disque(etat, entree);

    default: {
      const inconnue: never = entree;
      throw new TypeError(`omo-detections: entree inconnue ${JSON.stringify((inconnue as { type?: unknown }).type)}`);
    }
  }
}
