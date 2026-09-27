// Migration du web 1.0.x → 1.1.0 (décision A37, fiche MW §2) : planificateur PUR, sans fichier ni processus ni horloge.
//
// Entrée : les entrées présentes (lstat) à la racine du volume oc-config parmi opencode.jsonc, opencode.json, config.json et le
// fichier hérité « config », avec les octets du seul fichier lu. Sortie : l'état (§3), le nombre de blocs modifiés, les demandes web
// qui restent, et le texte à écrire. Seules les VALEURS de webfetch et websearch peuvent changer, et seulement de « ask » (ou de
// « allow » pour un profil 1.0) vers « deny », à leur place : aucune clé n'est ajoutée, retirée ni déplacée (R1, R4, R5, R7).
//
// Toutes les décisions se prennent sur l'ARBRE de jsonc-parser (parseTree), jamais sur un objet lu par JSON.parse : une clé
// « __proto__ » ne peut rien ajouter ni rien cacher (R3). Les règles d'opencode viennent du module partagé (rulesFromConfig,
// effectiveAgentRules, legacyPresetOf, peutDemander) : une seule source des profils et de l'évaluation. Exécuté par
// server/migrate-oc-config.ts dans un conteneur jetable de l'image app, pendant qu'opencode est arrêté (install.ps1, cockpit.ps1
// restore).
import { type Node, type ParseError, parseTree } from "jsonc-parser";
import {
  detectPermissionPreset,
  effectiveAgentRules,
  legacyPresetOf,
  type MemoRegles,
  memoRegles,
  PERMISSION_PRESETS,
  type PermissionPresetId,
  peutDemander,
  type Rule,
  rulesFromConfig,
} from "./shared/assistant-rules.ts";

/** Fichiers globaux qu'opencode lit à la racine du volume (config.ts:272-290), dans l'ordre de la ligne de verdict. */
export const NOMS_GLOBAUX = ["opencode.jsonc", "opencode.json", "config.json"] as const;
export type NomGlobal = (typeof NOMS_GLOBAUX)[number];
/** Fichier hérité (TOML fusionné en dernier puis converti) : sa présence suffit à ne rien toucher. */
export const NOM_HERITE = "config";
/** Noms examinés par lstat (R2). */
export const NOMS_EXAMINES: readonly string[] = Object.freeze([...NOMS_GLOBAUX, NOM_HERITE]);
/** Bornes de lecture (R3) : octets du fichier, puis unités UTF-16 du texte décodé (même unité que PUT raw). */
export const OCTETS_MAX = 1_048_576;
export const UNITES_MAX = 262_144;
/** Clé piégée (R3) : plus longue que ceci, ou avec plus de jokers « * » et « ? » que cela. */
export const CLE_LONGUEUR_MAX = 256;
export const CLE_JOKERS_MAX = 16;
/** Suffixe de la copie de l'ancien fichier, écrite une seule fois (R8). */
export const SUFFIXE_SAUVEGARDE = ".avant-1.1.0";

const OUTILS_WEB = ["webfetch", "websearch"] as const;
type OutilWeb = (typeof OUTILS_WEB)[number];

export type EtatMigration = "absent" | "conforme" | "migre" | "non-migre" | "erreur";
export type RaisonMigration =
  | "-"
  | "plusieurs-fichiers"
  | "illisible"
  | "cle-en-double"
  | "inhabituel"
  | "lien-ou-special"
  | "trop-gros"
  | "modifie-pendant"
  | "sauvegarde-impossible"
  | "verification"
  | "interne"
  | "root"
  | "argument";
export type ProfilLu = PermissionPresetId | "-";

/** Ce qui empêche de lire une entrée présente : lien, dossier ou fichier spécial ; taille ; entrée présente mais non lue. */
export interface EntreeEmpechee {
  empechement: "lien-ou-special" | "trop-gros" | "non-lu";
}
/** Entrée présente à la racine du volume : octets (ou texte) du fichier ordinaire lu, sinon ce qui en a empêché la lecture. */
export type EntreeVolume = Uint8Array | string | EntreeEmpechee;

export interface PlanMigrationWeb {
  etat: EtatMigration;
  raison: RaisonMigration;
  fichier: NomGlobal | "-";
  /** Profil 1.0 (ou mélange 1.0/1.1) reconnu dans le bloc global LU, sinon « - ». */
  profil: ProfilLu;
  /** Nombre de blocs « permission » modifiés (global, agent.<nom>, mode.<nom>). */
  blocs: number;
  /** Paires (bloc, outil) qui peuvent encore demander après la migration, la demande décisive venant de ce bloc (R6). */
  restes: number;
  /** « migre » : texte à écrire ; « conforme » : texte lu, inchangé ; sinon null (rien à écrire). */
  texte: string | null;
  /** Valeurs basculées, dans l'ordre du texte : chemins comme ["permission", "webfetch"]. */
  bascules: string[][];
}

// --- Fonctions partagées (train de V2 de F2, fiche MW §8) -------------------------------------------------------------------------
//
// legacyPresetOf (R4) et peutDemander (R6) sont IMPORTÉES de shared/assistant-rules.ts (MW-b, seul écrivain de ce module en V2) :
// les copies locales posées par MW-a sont retirées au train, pour une seule source des profils et de l'évaluation. La clause
// « clé hors bornes → peut demander » de peutDemander n'est jamais atteinte ici : lireArbre refuse avant toute évaluation une clé
// piégée (clePiegee, mêmes bornes que cleHorsBornes, plus « __proto__ »), et les défauts d'opencode sont dans les bornes. Les deux
// évaluations sont donc identiques à celles des copies (croisements-f2-v2.test.ts). Le mémo facultatif (memoRegles) remplace le
// cache de wildcardMatch des copies : sur un fichier de 254 000 unités (7 000 règles globales, 2 000 agents), mesure du train,
// 78 s sans lui contre 25 s avec les copies et 22 s avec lui, loin du délai de 120 s d'Invoke-CockpitWebMigration.

// --- Valeurs, lues sur l'arbre seulement ----------------------------------------------------------------------------------------

type Objet = Record<string, unknown>;

function estObjet(valeur: unknown): valeur is Objet {
  return typeof valeur === "object" && valeur !== null && !Array.isArray(valeur);
}

/** Objet sans prototype : aucune clé (« __proto__ » comprise) ne peut atteindre Object.prototype. */
const objetNu = (): Objet => Object.create(null) as Objet;
/** Propriété propre, à sa place si elle existe déjà (comme une affectation d'opencode), jamais un accesseur hérité. */
function definir(objet: Objet, cle: string, valeur: unknown): void {
  Object.defineProperty(objet, cle, { value: valeur, enumerable: true, writable: true, configurable: true });
}

function egalProfond(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a) || Array.isArray(b)) {
    return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((v, i) => egalProfond(v, b[i]));
  }
  if (estObjet(a) && estObjet(b)) {
    const ka = Object.keys(a);
    const kb = Object.keys(b);
    return ka.length === kb.length && ka.every((k) => Object.hasOwn(b, k) && egalProfond(a[k], b[k]));
  }
  return false;
}

/** Propriétés d'un nœud objet : nom DÉCODÉ, nœud du nom, nœud de la valeur. */
function proprietes(noeud: Node | undefined): Array<{ cle: string; valeur: Node }> {
  if (!noeud || noeud.type !== "object") return [];
  const sortie: Array<{ cle: string; valeur: Node }> = [];
  for (const propriete of noeud.children ?? []) {
    const [nom, valeur] = propriete.children ?? [];
    if (nom && valeur) sortie.push({ cle: String(nom.value), valeur });
  }
  return sortie;
}

/** Valeur de la propriété `cle` d'un nœud objet (la seule : les doublons sont refusés avant). */
function propriete(noeud: Node | undefined, cle: string): Node | undefined {
  return proprietes(noeud).find((p) => p.cle === cle)?.valeur;
}

/** Valeur JavaScript d'un nœud, objets sans prototype ; `remplaces` (décalages) valent « deny ». La dernière clé l'emporte. */
function valeurDe(noeud: Node, remplaces: ReadonlySet<number> = new Set()): unknown {
  if (remplaces.has(noeud.offset)) return "deny";
  if (noeud.type === "object") {
    const objet = objetNu();
    for (const { cle, valeur } of proprietes(noeud)) definir(objet, cle, valeurDe(valeur, remplaces));
    return objet;
  }
  if (noeud.type === "array") return (noeud.children ?? []).map((enfant) => valeurDe(enfant, remplaces));
  return noeud.value;
}

// --- Lecture sûre de l'arbre (R3) -----------------------------------------------------------------------------------------------

interface Bloc {
  /** Chemin du bloc : ["permission"], ["agent", nom, "permission"] ou ["mode", nom, "permission"]. */
  chemin: string[];
  noeud: Node;
  /** null : bloc global ; sinon, nom de l'agent (agent.<nom> et mode.<nom> sont fondus). */
  unite: string | null;
}

interface Arbre {
  blocs: Bloc[];
}

/** Objets des chemins traités (R3, clés en double) : racine, agent, mode, chaque entrée, chaque bloc et ses motifs, tools. */
function objetsTraites(racine: Node): Node[] {
  const objets: Node[] = [];
  // La racine porte le bloc global et « tools » comme une entrée d'agent : même parcours.
  const avecBloc = (entree: Node | undefined) => {
    if (!entree || entree.type !== "object") return;
    objets.push(entree);
    const permission = propriete(entree, "permission");
    if (permission?.type === "object") {
      objets.push(permission);
      for (const { valeur } of proprietes(permission)) if (valeur.type === "object") objets.push(valeur);
    }
    const tools = propriete(entree, "tools");
    if (tools?.type === "object") objets.push(tools);
  };
  avecBloc(racine);
  for (const section of ["agent", "mode"]) {
    const noeud = propriete(racine, section);
    if (noeud?.type !== "object") continue;
    objets.push(noeud);
    for (const { valeur } of proprietes(noeud)) avecBloc(valeur);
  }
  return objets;
}

function aDesDoublons(objet: Node): boolean {
  const vus = new Set<string>();
  for (const { cle } of proprietes(objet)) {
    if (vus.has(cle)) return true;
    vus.add(cle);
  }
  return false;
}

/** Clé piégée (R3) : trop longue, trop de jokers, ou « __proto__ » (jamais écrite par le cockpit ni par opencode). */
function clePiegee(cle: string): boolean {
  if (cle.length > CLE_LONGUEUR_MAX || cle === "__proto__") return true;
  let jokers = 0;
  for (const c of cle) if (c === "*" || c === "?") jokers++;
  return jokers > CLE_JOKERS_MAX;
}

/** Lit l'arbre des chemins traités, ou dit pourquoi il faut s'arrêter (doublons d'abord, puis tout ce qui est inhabituel). */
function lireArbre(racine: Node): Arbre | "cle-en-double" | "inhabituel" {
  const objets = objetsTraites(racine);
  if (objets.some(aDesDoublons)) return "cle-en-double";
  const blocs: Bloc[] = [];
  // « __proto__ » dans un objet traité : opencode (JSON.parse ou jsonc-parser) en ferait un PROTOTYPE, dont il pourrait lire une
  // permission que l'arbre ne montre pas. Jamais écrit par le cockpit ni par opencode : fermé en cas de doute.
  let inhabituel = objets.some((objet) => proprietes(objet).some(({ cle }) => cle === "__proto__"));
  const lireEntree = (entree: Node, chemin: string[], unite: string | null) => {
    const permission = propriete(entree, "permission");
    if (permission) {
      if (permission.type === "string") blocs.push({ chemin: [...chemin, "permission"], noeud: permission, unite });
      else if (permission.type === "object") {
        for (const { cle, valeur } of proprietes(permission)) {
          if (clePiegee(cle)) inhabituel = true;
          for (const motif of proprietes(valeur)) if (clePiegee(motif.cle)) inhabituel = true;
        }
        blocs.push({ chemin: [...chemin, "permission"], noeud: permission, unite });
      } else inhabituel = true;
    }
    const tools = propriete(entree, "tools");
    if (tools) {
      if (tools.type !== "object") inhabituel = true;
      for (const { cle, valeur } of proprietes(tools)) if (clePiegee(cle) || valeur.type !== "boolean") inhabituel = true;
    }
  };
  lireEntree(racine, [], null);
  for (const section of ["agent", "mode"]) {
    const noeud = propriete(racine, section);
    if (!noeud) continue;
    if (noeud.type !== "object") {
      inhabituel = true;
      continue;
    }
    for (const { cle, valeur } of proprietes(noeud)) {
      if (cle === "__proto__" || valeur.type !== "object") inhabituel = true;
      else lireEntree(valeur, [section, cle], cle);
    }
  }
  return inhabituel ? "inhabituel" : { blocs };
}

function analyser(texte: string): Node | null {
  const erreurs: ParseError[] = [];
  const racine = parseTree(texte, erreurs, { allowTrailingComma: true, disallowComments: false, allowEmptyContent: false });
  return erreurs.length === 0 && racine?.type === "object" ? racine : null;
}

// --- Simulation du chargement d'opencode (R12) ----------------------------------------------------------------------------------

/** Une permission en texte x vaut { "*": x } (core v1 config/permission.ts:40-41) ; absente, {}. */
function normaliser(permission: unknown): Objet {
  if (typeof permission === "string") {
    const objet = objetNu();
    definir(objet, "*", permission);
    return objet;
  }
  return estObjet(permission) ? permission : objetNu();
}

/** Règles tirées de « tools » (allow ou deny ; write, edit et patch donnent edit), dans l'ordre des clés. */
function reglesDeTools(tools: unknown): Objet {
  const permission = objetNu();
  if (!estObjet(tools)) return permission;
  for (const [outil, actif] of Object.entries(tools)) {
    definir(permission, outil === "write" || outil === "edit" || outil === "patch" ? "edit" : outil, actif ? "allow" : "deny");
  }
  return permission;
}

/** mergeDeep de remeda (config.ts) : clés de `cible` d'abord, puis les nouvelles de `source` ; la valeur de `source` l'emporte. */
function fusionProfonde(cible: Objet, source: Objet): Objet {
  const sortie = objetNu();
  for (const [cle, valeur] of Object.entries(cible)) definir(sortie, cle, valeur);
  for (const [cle, valeur] of Object.entries(source)) {
    const avant = Object.hasOwn(cible, cle) ? cible[cle] : undefined;
    definir(sortie, cle, estObjet(avant) && estObjet(valeur) ? fusionProfonde(avant, valeur) : valeur);
  }
  return sortie;
}

/** Permission d'une entrée d'agent ou de mode normalisée comme agent.ts:62-81 : tools devant, puis Object.assign du bloc. */
function permissionEntree(entree: unknown): Objet {
  const objet = estObjet(entree) ? entree : objetNu();
  const permission = reglesDeTools(Object.hasOwn(objet, "tools") ? objet.tools : undefined);
  for (const [cle, valeur] of Object.entries(normaliser(Object.hasOwn(objet, "permission") ? objet.permission : undefined))) definir(permission, cle, valeur);
  return permission;
}

interface Unite {
  /** Règles effectives (défauts, global migré, agent). */
  regles: Rule[];
  /** Règles propres à l'unité : le global seul, ou l'agent seul. */
  propres: Rule[];
}

/** Unités évaluées : le global, puis chaque agent (agent.<nom> et mode.<nom> fondus, le mode l'emporte : config.ts:550-557). */
function simuler(racine: Node): Map<string | null, Unite> {
  const config = valeurDe(racine) as Objet;
  const lire = (objet: unknown, cle: string) => (estObjet(objet) && Object.hasOwn(objet, cle) ? objet[cle] : undefined);
  let global = normaliser(lire(config, "permission"));
  // Clé tools globale : règles placées DEVANT le bloc, la valeur du bloc l'emportant (config.ts:567-578, mergeDeep).
  if (lire(config, "tools") !== undefined) global = fusionProfonde(reglesDeTools(lire(config, "tools")), global);
  const unites = new Map<string | null, Unite>();
  unites.set(null, { regles: effectiveAgentRules(global, undefined), propres: rulesFromConfig(global) });
  const agents = lire(config, "agent");
  const modes = lire(config, "mode");
  const noms = [...Object.keys(estObjet(agents) ? agents : {}), ...Object.keys(estObjet(modes) ? modes : {})];
  for (const nom of new Set(noms)) {
    const deAgent = estObjet(agents) && Object.hasOwn(agents, nom) ? permissionEntree(agents[nom]) : null;
    const deMode = estObjet(modes) && Object.hasOwn(modes, nom) ? permissionEntree(modes[nom]) : null;
    const fondue = deAgent && deMode ? fusionProfonde(deAgent, deMode) : (deAgent ?? deMode ?? objetNu());
    unites.set(nom, { regles: effectiveAgentRules(global, fondue), propres: rulesFromConfig(fondue) });
  }
  return unites;
}

// --- Bascules -------------------------------------------------------------------------------------------------------------------

interface Bascule {
  chemin: string[];
  noeud: Node;
  outil: OutilWeb;
  unite: string | null;
}

/** Remplace exactement la plage de chaque nœud valeur par « "deny" », de la fin vers le début (R7) : aucune insertion. */
function appliquer(texte: string, noeuds: readonly Node[]): string {
  let sortie = texte;
  for (const noeud of [...noeuds].sort((a, b) => b.offset - a.offset)) {
    sortie = sortie.slice(0, noeud.offset) + '"deny"' + sortie.slice(noeud.offset + noeud.length);
  }
  return sortie;
}

/** Candidates : bloc global d'un profil 1.0 (R4, les deux ensemble), sinon chaque « ask » EXISTANT de webfetch et websearch (R5). */
function candidates(arbre: Arbre, profil: PermissionPresetId | null): Bascule[] {
  const liste: Bascule[] = [];
  for (const bloc of arbre.blocs) {
    if (bloc.noeud.type !== "object") continue;
    const r4 = bloc.unite === null && profil !== null;
    for (const outil of OUTILS_WEB) {
      const valeur = propriete(bloc.noeud, outil);
      if (valeur?.type !== "string") continue;
      if (r4 ? valeur.value !== "deny" : valeur.value === "ask") liste.push({ chemin: [...bloc.chemin, outil], noeud: valeur, outil, unite: bloc.unite });
    }
  }
  return liste.sort((a, b) => a.noeud.offset - b.noeud.offset);
}

/** Paires (unité, outil) qui peuvent encore demander, la demande décisive venant de l'unité elle-même (R6). */
function restesDe(unites: Map<string | null, Unite>, memo: MemoRegles): number {
  let restes = 0;
  for (const unite of unites.values()) {
    for (const outil of OUTILS_WEB) if (peutDemander(unite.regles, outil, memo) && peutDemander(unite.propres, outil, memo)) restes++;
  }
  return restes;
}

interface Decision {
  gardees: Bascule[];
  restes: number;
  texte: string;
}

/**
 * R6, outil par outil, sur parse(nouveauTexte) : le bloc global d'abord (règle de la paire pour un profil 1.0), puis chaque agent
 * par-dessus le global migré. Une bascule qui ne suffit pas (un joker à « ask » placé après, par exemple) est abandonnée seule.
 */
function decider(texte: string, arbre: Arbre, profil: PermissionPresetId | null, memo: MemoRegles): Decision | null {
  const toutes = candidates(arbre, profil);
  const evaluer = (liste: readonly Bascule[]) => {
    const racine = analyser(appliquer(texte, liste.map((b) => b.noeud)));
    return racine ? simuler(racine) : null;
  };
  const avecTout = evaluer(toutes);
  if (!avecTout) return null;
  const globalUnite = avecTout.get(null);
  let globales = toutes.filter((b) => b.unite === null);
  if (profil !== null) {
    if (OUTILS_WEB.some((outil) => peutDemander(globalUnite?.regles ?? [], outil, memo))) globales = [];
  } else {
    globales = globales.filter((b) => !peutDemander(globalUnite?.regles ?? [], b.outil, memo));
  }
  const agents = toutes.filter((b) => b.unite !== null);
  const surGlobalMigre = evaluer([...globales, ...agents]);
  if (!surGlobalMigre) return null;
  const gardeesAgents = agents.filter((b) => !peutDemander(surGlobalMigre.get(b.unite)?.regles ?? [], b.outil, memo));
  const gardees = [...globales, ...gardeesAgents].sort((a, b) => a.noeud.offset - b.noeud.offset);
  const nouveau = appliquer(texte, gardees.map((b) => b.noeud));
  const racine = analyser(nouveau);
  if (!racine) return null;
  const final = simuler(racine);
  // Chaque bascule gardée doit être efficace sur le texte qui sera écrit.
  if (gardees.some((b) => peutDemander(final.get(b.unite)?.regles ?? [], b.outil, memo))) return null;
  return { gardees, restes: restesDe(final, memo), texte: nouveau };
}

// --- Contrôle octet (R7) --------------------------------------------------------------------------------------------------------

/** Nœud valeur au bout de `chemin`, s'il est unique à chaque pas. */
function noeudAu(racine: Node, chemin: readonly string[]): Node | undefined {
  let noeud: Node | undefined = racine;
  for (const pas of chemin) {
    const trouves: Node[] = proprietes(noeud).filter((p) => p.cle === pas).map((p) => p.valeur);
    if (trouves.length !== 1) return undefined;
    noeud = trouves[0];
  }
  return noeud;
}

/**
 * Contrôle octet, tous exigés (R7) : chaque plage d'origine décode en « ask » (ou « allow » pour un profil 1.0 du bloc global) ;
 * le nouveau texte égale l'ancien hors des plages, et chaque plage y vaut exactement « "deny" » ; la ré-analyse se fait sans
 * erreur ; le JSON décodé est identique hors des chemins basculés (verrou « fournisseurs », $schema, provider et adresse Copilot
 * compris) ; pour un profil 1.0, le bloc égale le profil 1.1 et detectPermissionPreset rend le même id.
 */
export function verifierMigration(ancien: string, nouveau: string, bascules: readonly (readonly string[])[], profil: PermissionPresetId | null): boolean {
  const racineAncienne = analyser(ancien);
  const racineNouvelle = analyser(nouveau);
  if (!racineAncienne || !racineNouvelle || bascules.length === 0) return false;
  const noeuds: Node[] = [];
  for (const chemin of bascules) {
    const noeud = noeudAu(racineAncienne, chemin);
    if (!noeud || noeud.type !== "string" || noeuds.some((n) => n.offset === noeud.offset)) return false;
    const globalR4 = profil !== null && chemin.length === 2 && chemin[0] === "permission";
    let decode: unknown;
    try {
      decode = JSON.parse(ancien.slice(noeud.offset, noeud.offset + noeud.length));
    } catch {
      return false;
    }
    if (!(decode === "ask" || (globalR4 && decode === "allow"))) return false;
    noeuds.push(noeud);
  }
  // Hors des plages : octets identiques ; dans chaque plage : exactement « "deny" ».
  let decalage = 0;
  let depuis = 0;
  for (const noeud of [...noeuds].sort((a, b) => a.offset - b.offset)) {
    if (ancien.slice(depuis, noeud.offset) !== nouveau.slice(depuis + decalage, noeud.offset + decalage)) return false;
    if (nouveau.slice(noeud.offset + decalage, noeud.offset + decalage + 6) !== '"deny"') return false;
    decalage += 6 - noeud.length;
    depuis = noeud.offset + noeud.length;
  }
  if (ancien.slice(depuis) !== nouveau.slice(depuis + decalage)) return false;
  // JSON décodé identique hors des chemins basculés.
  if (!egalProfond(valeurDe(racineAncienne, new Set(noeuds.map((n) => n.offset))), valeurDe(racineNouvelle))) return false;
  if (profil !== null) {
    const bloc = valeurDe(noeudAu(racineNouvelle, ["permission"]) ?? racineNouvelle);
    if (!egalProfond(bloc, PERMISSION_PRESETS[profil].permission) || detectPermissionPreset(bloc) !== profil) return false;
  }
  return true;
}

// --- Planificateur --------------------------------------------------------------------------------------------------------------

function plan(etat: EtatMigration, raison: RaisonMigration, champs: Partial<PlanMigrationWeb> = {}): PlanMigrationWeb {
  return { etat, raison, fichier: "-", profil: "-", blocs: 0, restes: 0, texte: null, bascules: [], ...champs };
}

/**
 * Plan de migration du volume oc-config (fiche MW §2, R1 à R14). `fichiers` : les entrées présentes parmi NOMS_EXAMINES ; pour le
 * seul fichier global présent, ses octets (ou son texte), sinon ce qui en a empêché la lecture.
 */
export function planWebMigration(fichiers: Readonly<Partial<Record<string, EntreeVolume>>>): PlanMigrationWeb {
  const presents = NOMS_EXAMINES.filter((nom) => Object.hasOwn(fichiers, nom) && fichiers[nom] !== undefined);
  // R2 : aucun → le superviseur posera le défaut 1.1 ; plusieurs, ou le fichier hérité → rien.
  if (presents.length === 0) return plan("absent", "-");
  if (presents.length > 1 || presents.includes(NOM_HERITE)) return plan("non-migre", "plusieurs-fichiers");
  const fichier = NOMS_GLOBAUX.find((nom) => nom === presents[0]);
  const entree = fichier ? fichiers[fichier] : undefined;
  if (!fichier || entree === undefined) return plan("erreur", "interne");
  if (typeof entree !== "string" && !(entree instanceof Uint8Array)) {
    if (entree.empechement === "non-lu") return plan("erreur", "interne", { fichier });
    return plan("non-migre", entree.empechement, { fichier });
  }
  // R3 : bornes, UTF-8 strict sans BOM.
  const octets = typeof entree === "string" ? new TextEncoder().encode(entree) : entree;
  if (octets.length > OCTETS_MAX) return plan("non-migre", "trop-gros", { fichier });
  let texte: string;
  try {
    texte = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(octets);
  } catch {
    return plan("non-migre", "illisible", { fichier });
  }
  if (texte.charCodeAt(0) === 0xfeff) return plan("non-migre", "illisible", { fichier });
  if (texte.length > UNITES_MAX) return plan("non-migre", "trop-gros", { fichier });
  const racine = analyser(texte);
  if (!racine) return plan("non-migre", "illisible", { fichier });
  // Substitutions d'opencode faites sur le texte brut AVANT l'analyse : le document qu'il lirait peut différer.
  if (texte.includes("{env:") || texte.includes("{file:")) return plan("non-migre", "inhabituel", { fichier });
  const arbre = lireArbre(racine);
  if (arbre === "cle-en-double" || arbre === "inhabituel") return plan("non-migre", arbre, { fichier });

  const blocGlobal = arbre.blocs.find((bloc) => bloc.unite === null);
  const legacy = blocGlobal ? legacyPresetOf(valeurDe(blocGlobal.noeud)) : null;
  const profil: ProfilLu = legacy ?? "-";
  // Mémo de peutDemander (train de V2) : même réponse, sans réévaluer wildcardMatch pour chaque unité.
  const memo = memoRegles();
  const decision = decider(texte, arbre, legacy, memo);
  if (!decision) return plan("erreur", "verification", { fichier, profil });
  if (decision.gardees.length === 0) return plan("conforme", "-", { fichier, profil, restes: decision.restes, texte });

  const bascules = decision.gardees.map((b) => b.chemin);
  if (!verifierMigration(texte, decision.texte, bascules, legacy)) return plan("erreur", "verification", { fichier, profil });
  // R10 : un second passage sur le texte écrit ne trouve plus rien à basculer.
  const racineEcrite = analyser(decision.texte);
  const arbreEcrit = racineEcrite ? lireArbre(racineEcrite) : "inhabituel";
  if (typeof arbreEcrit === "string") return plan("erreur", "verification", { fichier, profil });
  const blocEcrit = arbreEcrit.blocs.find((bloc) => bloc.unite === null);
  const second = decider(decision.texte, arbreEcrit, blocEcrit ? legacyPresetOf(valeurDe(blocEcrit.noeud)) : null, memo);
  if (!second || second.gardees.length > 0 || second.restes !== decision.restes) return plan("erreur", "verification", { fichier, profil });

  const blocs = new Set(bascules.map((chemin) => JSON.stringify(chemin.slice(0, -1)))).size;
  return { etat: "migre", raison: "-", fichier, profil, blocs, restes: decision.restes, texte: decision.texte, bascules };
}
