// Garde du build pour three.js (itération 3, L32 ; plan it3 D-3d-06 ; spécification §5.8 l.996, §7.7 l.1173, M24, JP-11).
// Fonctions pures, testées sur des morceaux fabriqués (three-guard.test.ts), et greffon Vite `threeGuard()` branché par
// vite.config.ts. Le build échoue dans quatre cas :
// 1. un morceau qui contient un module de three porte `new Function(` ou `eval(`, y compris sous leurs formes minifiées,
//    indirectes ou globales (`Function(`, `(0,eval)(`, `globalThis.eval(`…, voir `codeInterdit`) ;
// 2. un module three.webgpu, three.tsl, examples (addons) ou src de three entre dans le build ;
// 3. un module de three est atteint depuis une entrée par import statique (three reste dans un morceau paresseux, D-3d-05) ;
// 4. la licence de three n'est pas émise (`licences/three-LICENSE.txt`, lue à côté du module résolu : build/../LICENSE).
// Il journalise la taille brute et compressée de chaque morceau de three (M24), sinon « [three] aucun morceau three ».
// Portée de `codeInterdit` : les morceaux de three ; un autre morceau qui porte ces formes est signalé dans le journal sans faire
// échouer le build (M3D-8 : l'extension à tous les morceaux se décide au train).
// Ce module n'importe pas three (types de Vite seulement, effacés) ; il vit dans server/ pour être typé et testé, et le serveur
// ne le charge jamais.
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import type { Plugin } from "vite";

/** Chemin de la licence de three dans le build (dist/web). */
export const LICENCE_THREE = "licences/three-LICENSE.txt";

/** Sous-chaînes d'identifiant de module (séparateurs « / ») interdites dans le build. */
export const MODULES_THREE_INTERDITS = ["/three/build/three.webgpu", "/three/build/three.tsl", "/three/examples/", "/three/src/"] as const;

/** Sous-chaîne des modules de three permis (three.module.js, three.core.js). */
const MODULE_THREE = "/three/build/";

/** Morceau du build : sous-ensemble d'`OutputChunk` (Vite 8.3.0, Rolldown). `imports` et `dynamicImports` : noms de morceaux. */
export interface MorceauGarde {
  type: "chunk";
  fileName: string;
  isEntry: boolean;
  code: string;
  moduleIds: readonly string[];
  imports: readonly string[];
  dynamicImports: readonly string[];
}

/** Fichier non JavaScript du build (`OutputAsset`). */
export interface FichierGarde {
  type: "asset";
  fileName: string;
  source: string | Uint8Array;
}

export type BundleGarde = Readonly<Record<string, MorceauGarde | FichierGarde>>;

/** Licence lue à côté du module résolu de three, ou la raison de son absence. */
export type LicenceThree = { texte: string } | { erreur: string };

/** Contextes du greffon utilisés par la garde : sous-ensembles du `PluginContext` de Rolldown. */
export interface ContexteEmission {
  emitFile(file: { type: "asset"; fileName: string; source: string }): string;
}
export interface ContexteGarde {
  error(message: string): never;
}

const normaliser = (id: string) => id.replaceAll("\\", "/");
const estMorceau = (fichier: MorceauGarde | FichierGarde | undefined): fichier is MorceauGarde => fichier?.type === "chunk";

/** Vrai pour un module du dossier build de three (`…/three/build/…`) : un morceau qui en contient un est un morceau de three. */
export const estModuleThree = (id: string) => normaliser(id).includes(MODULE_THREE);

/** Identifiants interdits parmi `ids` (triés, sans doublon) : three.webgpu, three.tsl, examples, src. */
export function modulesThreeInterdits(ids: Iterable<string>): string[] {
  const interdits = new Set<string>();
  for (const id of ids) if (MODULES_THREE_INTERDITS.some((motif) => normaliser(id).includes(motif))) interdits.add(id);
  return [...interdits].sort();
}

/**
 * Constructeur Function : `new Function(` (espaces permis) et sa forme minifiée `Function(` (le minifieur de Vite 8.3.0 retire
 * `new` : `new Function(s)` devient `Function(e)`, mesuré par L32), non précédé d'une lettre, d'un chiffre, de `_`, `$` ou `.` ;
 * plus `globalThis.Function(`, `window.Function(`, `self.Function(` (avec ou sans `new`, gardés tels quels par le minifieur).
 */
const NEW_FUNCTION = /(?<![\p{L}\p{N}_$.])Function\s*\(|\b(?:globalThis|window|self)\s*\.\s*Function\s*\(/u;
/**
 * eval : `eval` suivi d'une parenthèse (espaces permis), non précédé d'une lettre, d'un chiffre, de `_`, `$` ou `.` ; plus l'eval
 * indirect `(0, eval)(` et l'eval global `globalThis.eval(`, `window.eval(`, `self.eval(` (gardés tels quels par le minifieur,
 * mesuré par L32). `obj.eval(` et `retrieval(` restent tolérés.
 */
const EVAL = /(?<![\p{L}\p{N}_$.])eval\s*(?:\)\s*)?\(|\b(?:globalThis|window|self)\s*\.\s*eval\s*\(/u;

/** Formes interdites trouvées dans `code` : « new Function( » et « eval( », dans cet ordre ; tableau vide si aucune. */
export function codeInterdit(code: string): string[] {
  const formes: string[] = [];
  if (NEW_FUNCTION.test(code)) formes.push("new Function(");
  if (EVAL.test(code)) formes.push("eval(");
  return formes;
}

/** Morceaux qui contiennent au moins un module de three, triés par nom. */
export function morceauxThree(bundle: BundleGarde): MorceauGarde[] {
  return Object.values(bundle)
    .filter(estMorceau)
    .filter((morceau) => morceau.moduleIds.some(estModuleThree))
    .sort((a, b) => a.fileName.localeCompare(b.fileName));
}

/**
 * Morceaux qui contiennent un module de three et qu'une entrée atteint en suivant ses `imports` statiques (jamais
 * `dynamicImports`), entrée comprise. Tableau vide : three n'est chargé que par un import dynamique.
 */
export function atteintStatiquement(bundle: BundleGarde): string[] {
  const atteints = new Set<string>();
  const pile = Object.values(bundle)
    .filter(estMorceau)
    .filter((morceau) => morceau.isEntry)
    .map((morceau) => morceau.fileName);
  for (let nom = pile.pop(); nom !== undefined; nom = pile.pop()) {
    if (atteints.has(nom)) continue;
    atteints.add(nom);
    const morceau = bundle[nom];
    if (estMorceau(morceau)) pile.push(...morceau.imports);
  }
  return [...atteints]
    .filter((nom) => {
      const morceau = bundle[nom];
      return estMorceau(morceau) && morceau.moduleIds.some(estModuleThree);
    })
    .sort();
}

/** Problèmes du build (cas 1 à 3 de l'en-tête) ; tableau vide si le build est conforme. */
export function verifierBundle(bundle: BundleGarde): string[] {
  const problemes: string[] = [];
  for (const morceau of morceauxThree(bundle)) {
    for (const forme of codeInterdit(morceau.code)) problemes.push(`${morceau.fileName} : « ${forme} » dans un morceau de three`);
  }
  const ids = Object.values(bundle).filter(estMorceau).flatMap((morceau) => morceau.moduleIds);
  for (const id of modulesThreeInterdits(ids)) problemes.push(`module de three interdit dans le build : ${normaliser(id)}`);
  for (const nom of atteintStatiquement(bundle)) {
    problemes.push(`${nom} : three atteint depuis une entrée par import statique (il doit rester dans un morceau paresseux)`);
  }
  return problemes;
}

/**
 * Lignes du journal : `[three] <fichier> : <octets> octets, <gzip> octets gzip` par morceau de three (M24), sinon
 * `[three] aucun morceau three` ; puis un signalement non bloquant par autre morceau qui porte une forme interdite (M3D-8).
 */
export function lignesJournal(bundle: BundleGarde): string[] {
  const three = morceauxThree(bundle);
  const lignes = three.map((morceau) => {
    const octets = Buffer.byteLength(morceau.code, "utf8");
    const gzip = zlib.gzipSync(morceau.code).length;
    return `[three] ${morceau.fileName} : ${octets} octets, ${gzip} octets gzip`;
  });
  if (lignes.length === 0) lignes.push("[three] aucun morceau three");
  const autres = Object.values(bundle)
    .filter(estMorceau)
    .filter((morceau) => !three.includes(morceau))
    .sort((a, b) => a.fileName.localeCompare(b.fileName));
  for (const morceau of autres) {
    const formes = codeInterdit(morceau.code);
    if (formes.length > 0) lignes.push(`[three] signalé, hors three (non bloquant) : ${morceau.fileName} contient ${formes.map((f) => `« ${f} »`).join(" et ")}`);
  }
  return lignes;
}

/** Licence MIT de three, lue à côté du module résolu (`build/../LICENSE`). `moduleThree` : identifiant résolu, ou null. */
export function lireLicenceThree(moduleThree: string | null): LicenceThree {
  if (moduleThree === null) return { erreur: "module three introuvable depuis la racine du build" };
  if (!estModuleThree(moduleThree)) return { erreur: `module three résolu hors de three/build : ${normaliser(moduleThree)}` };
  const fichier = path.join(path.dirname(moduleThree), "..", "LICENSE");
  let texte: string;
  try {
    texte = fs.readFileSync(fichier, "utf8");
  } catch (error) {
    return { erreur: `${normaliser(fichier)} illisible (${(error as NodeJS.ErrnoException).code ?? "erreur"})` };
  }
  if (!/\bMIT License\b/.test(texte)) return { erreur: `${normaliser(fichier)} ne porte pas la licence MIT` };
  return { texte };
}

/**
 * Émet la licence lue. Appelé au début du build (`buildStart`) : sous Rolldown, un fichier émis pendant `generateBundle`
 * n'apparaît pas dans le bundle que ce crochet reçoit, et la garde n'y verrait jamais la licence.
 */
export function emettreLicence(contexte: ContexteEmission, licence: LicenceThree): void {
  if ("texte" in licence) contexte.emitFile({ type: "asset", fileName: LICENCE_THREE, source: licence.texte });
}

const texteDe = (source: string | Uint8Array) => (typeof source === "string" ? source : Buffer.from(source).toString("utf8"));

/**
 * Fin du build : journalise, puis fait échouer le build (`contexte.error`) si un des quatre cas est présent. La licence compte
 * comme émise seulement si le bundle la contient, avec le texte lu.
 */
export function garderBundle(contexte: ContexteGarde, bundle: BundleGarde, licence: LicenceThree, journal: (ligne: string) => void): void {
  const problemes = verifierBundle(bundle);
  const emise = bundle[LICENCE_THREE];
  if (!("texte" in licence)) problemes.push(`licence non émise : ${licence.erreur}`);
  else if (emise?.type !== "asset" || texteDe(emise.source) !== licence.texte) problemes.push(`licence non émise : ${LICENCE_THREE} absent du build`);
  for (const ligne of lignesJournal(bundle)) journal(ligne);
  if (problemes.length > 0) contexte.error(`[three] garde du build en échec : ${problemes.join(" ; ")}`);
}

/** Greffon Vite (build seulement) : three résolu depuis la racine du build et licence émise, puis `garderBundle`. */
export function threeGuard(): Plugin {
  let racine = process.cwd();
  let journal = (ligne: string) => console.info(ligne);
  let licence: LicenceThree = { erreur: "three non résolu (buildStart non appelé)" };
  return {
    name: "cockpit:three-guard",
    apply: "build",
    configResolved(config) {
      racine = config.root;
      journal = (ligne) => config.logger.info(ligne);
    },
    async buildStart() {
      const resolu = await this.resolve("three", path.join(racine, "index.html"));
      licence = lireLicenceThree(resolu && !resolu.external ? resolu.id : null);
      emettreLicence(this, licence);
    },
    generateBundle(_options, bundle) {
      garderBundle(this, bundle, licence, journal);
    },
  };
}
