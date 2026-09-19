// Test « textes de la 3D » (spécification §2.1 à §2.3, §5.7.1, §5.8, §5.9, §6 ; plan d'exécution de l'itération 3, §4.2.4,
// D-3d-11, D-3d-21, D-3d-26, D-3d-27 ; décisions U1 et U2 du 19/09 ; paquet T3d-b). Complète textes.test.ts, qui n'est pas
// modifié et découvre déjà salle3d-texts.ts, revoir-texts.ts et legendes-texts.ts par leur nom (structure, mots interdits, textes
// écrits hors de TEXTES) :
// - « un sens par mot » sur ces trois modules (textes.test.ts ne l'applique qu'à ses familles) : « mode » seulement dans « mode
//   Simple » ou « mode Avancé », jamais « pause » (équipes) ni « relecture » (§2.2 l.97 : « Revoir » et « En différé ») ;
// - jamais « Arrêter » (seul sens : l'arrêt de la conversation, D-3d-11), « agent » ni « orchestrateur » (§2.3 l.104, D-3d-20),
//   dans aucun mode ;
// - textes vus en mode Simple (sections simple et partout, phrases rendues en mode Simple) : aucun mot interdit (§2.3 l.102),
//   jamais « extension » (salle réservée au mode Avancé), aucune équipe proposée (U1 : équipes fermées en mode Simple) ;
// - phrases de la spécification exactes à l'octet (ligne citée de spec-final.md, révision 2) ;
// - gabarits cohérents : noms permis, gabarits attendus texte par texte, ni `${}` ni accolade isolée, aucun gabarit laissé par
//   les fonctions ;
// - modules « sans texte » de la 3D (D-3d-21) : aucune chaîne affichable, lexique recopié de textes.test.ts ; un module absent de
//   cette copie est sauté avec sa raison ; fluidity.ts est exclu (ses noms de moteurs logiciels sont des motifs de comparaison).
// Chaque règle échoue sur un module ou un source fabriqué (contrôles discriminants).
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import * as legendes from "./shared/legendes-texts.ts";
import type { LegendeKey } from "./shared/legendes-texts.ts";
import { remplir } from "./shared/neon-texts.ts";
import * as revoir from "./shared/revoir-texts.ts";
import type { ReplaySpeed, RevoirRefus } from "./shared/revoir-texts.ts";
import * as salle3d from "./shared/salle3d-texts.ts";
import type { FluidityReason } from "./shared/salle3d-texts.ts";

const SHARED_DIR = path.join(import.meta.dirname, "shared");

// --- Règles de vocabulaire ------------------------------------------------------------------------------------------------------

interface WordRule {
  mot: string;
  re: RegExp;
}

const LETTER = "\\p{L}\\p{N}_";

/** Mot ou expression entier, casse ignorée : ni lettre ni trait d'union avant, ni lettre après (recopié de textes.test.ts). */
const rule = (mot: string, pattern: string): WordRule => ({ mot, re: new RegExp(`(?<![${LETTER}-])(?:${pattern})(?![${LETTER}])`, "iu") });

/** §2.2 : un sens par mot (recopié de textes.test.ts). */
const UN_SENS: readonly WordRule[] = [
  rule("mode", "modes?(?!\\s+(?:Simple|Avancé)(?![\\p{L}]))"),
  rule("pause", "pauses?"),
  rule("relecture", "relectures?"),
];

/** Jamais dans les textes de la 3D, quel que soit le mode (D-3d-11, D-3d-20, §2.3 l.104). */
const JAMAIS: readonly WordRule[] = [
  rule("Arrêter", "arr[êe]t(?:er|ez|e)"),
  rule("agent", "agents?|sous-agents?"),
  rule("orchestrateur", "orchestrat(?:eur|rice)s?"),
];

/** §2.3 l.102 : interdits en mode Simple (recopié de textes.test.ts). */
const INTERDITS_SIMPLE: readonly WordRule[] = [
  rule("agent", "agents?"),
  rule("sous-agent", "sous-agents?"),
  rule("session", "sessions?"),
  rule("prompt", "prompts?"),
  rule("jeton", "jetons?"),
  rule("token", "tokens?"),
  rule("workflow", "workflows?"),
  rule("pipeline", "pipelines?"),
  rule("orchestrateur", "orchestrat(?:eur|rice)s?"),
  rule("nœud", "n(?:œ|oe)uds?"),
  rule("parallèle", "parall[èe]les?"),
  rule("boucle", "boucles?"),
  rule("itération", "it[ée]rations?"),
  rule("permission", "permissions?"),
  rule("juge", "juges?"),
  rule("classifieur", "classifi(?:eur|cateur)s?"),
  rule("LLM", "llms?"),
  rule("profondeur", "profondeurs?"),
  rule("subagent_depth", "subagent_depth"),
  rule("regard", "regards?"),
  rule("validé", "validée?s?"),
  rule("approuvé", "approuvée?s?"),
  rule("vérifié par l'IA", "vérifiée?s?\\s+par\\s+l['’]\\s*IA"),
  rule("feu vert", "feux?\\s+verts?"),
  rule("prêt pour le CAB", "prête?s?\\s+pour\\s+le\\s+CAB"),
];

/** Propres à la 3D en mode Simple : la salle et son extension sont réservées au mode Avancé ; aucune équipe proposée (U1). */
const RESERVES_AVANCE: readonly WordRule[] = [rule("extension", "extensions?"), rule("équipe", "[ée]quipes?")];

type Section = "simple" | "avance" | "partout";
const SECTIONS: readonly Section[] = ["simple", "avance", "partout"];
type Textes = Readonly<Record<Section, unknown>>;

interface Leaf {
  chemin: string;
  texte: string;
}

interface Violation {
  source: string;
  chemin: string;
  regle: string;
  mot: string;
}

function leaves(value: unknown, chemin: string, out: Leaf[] = []): Leaf[] {
  if (typeof value === "string") out.push({ chemin, texte: value });
  else if (Array.isArray(value)) value.forEach((item, index) => leaves(item, `${chemin}[${index}]`, out));
  else if (typeof value === "object" && value !== null) for (const [key, item] of Object.entries(value)) leaves(item, `${chemin}.${key}`, out);
  return out;
}

/** Vocabulaire d'un module : TEXTES section par section, plus des phrases que ses fonctions rendent en mode Simple. */
function checkVocabulaire(source: string, textes: Textes, rendusSimple: readonly Leaf[] = []): Violation[] {
  const problems: Violation[] = [];
  const all: Array<Leaf & { simple: boolean }> = rendusSimple.map((leaf) => ({ ...leaf, simple: true }));
  for (const section of SECTIONS) for (const leaf of leaves(textes[section], `TEXTES.${section}`)) all.push({ ...leaf, simple: section !== "avance" });
  for (const { chemin, texte, simple } of all) {
    const add = (regle: string, rules: readonly WordRule[]) => {
      for (const r of rules) if (r.re.test(texte)) problems.push({ source, chemin, regle, mot: r.mot });
    };
    add("un sens par mot", UN_SENS);
    add("jamais dans la 3D", JAMAIS);
    if (simple) {
      add("interdit en mode Simple", INTERDITS_SIMPLE);
      add("réservé au mode Avancé", RESERVES_AVANCE);
    }
  }
  return problems;
}

// --- Phrases de la spécification ------------------------------------------------------------------------------------------------

interface PhraseSpec {
  /** Ligne de spec-final.md (révision 2) où la phrase est écrite. */
  ligne: number;
  attendu: string;
  obtenu: string;
  /** Texte affiché devant la phrase (bandeau de l'enceinte : « Salle OMO · » devant la phrase de §5.7.4). */
  prefixe?: string;
}

/** Phrase exacte à l'octet (UTF-8), préfixe compris. */
function checkPhrases(source: string, phrases: readonly PhraseSpec[]): Violation[] {
  return phrases
    .filter(({ attendu, obtenu, prefixe = "" }) => !Buffer.from(obtenu, "utf8").equals(Buffer.from(prefixe + attendu, "utf8")))
    .map(({ ligne, attendu, obtenu }) => ({ source, chemin: `spéc. l.${ligne}`, regle: "phrase de la spécification", mot: `« ${obtenu} » au lieu de « ${attendu} »` }));
}

/** Instant du badge de §5.8 l.998 (« 10:42:07 ») : 10 h 42 min 07 s UTC, affiché sans décalage. */
const HEURE_BADGE = Date.UTC(2026, 8, 19, 10, 42, 7);

const PHRASES_SALLE3D: readonly PhraseSpec[] = [
  { ligne: 79, attendu: "Salle de contrôle", obtenu: salle3d.TEXTES.partout.titre },
  { ligne: 985, attendu: "Ouvrir la salle de contrôle", obtenu: salle3d.TEXTES.partout.ouvrir },
  { ligne: 993, attendu: "Cockpit – contrôle", obtenu: salle3d.TEXTES.partout.stationControle },
  { ligne: 993, attendu: "3 travaillent · 1 attend votre accord · 0,42 $", obtenu: salle3d.libelleCompteurs({ travaillent: 3, attendent: 1, cout: 0.42 }) },
  { ligne: 987, attendu: "extension active · actions non contrôlées avant exécution", obtenu: salle3d.TEXTES.avance.enceinte, prefixe: "Salle OMO · " },
  { ligne: 1068, attendu: "Affichage 2D : vos réglages d'accessibilité le demandent", obtenu: salle3d.messageFluidite("accessibilite") },
  { ligne: 1007, attendu: "La 3D n'était pas fluide sur ce poste", obtenu: salle3d.messageFluidite("sonde-lente") },
];

const PHRASES_REVOIR: readonly PhraseSpec[] = [
  { ligne: 985, attendu: "Revoir cette demande", obtenu: revoir.TEXTES.partout.revoir },
  { ligne: 998, attendu: "EN DIRECT", obtenu: revoir.libelleBadge({ etat: "direct" }, 0) },
  { ligne: 998, attendu: "EN DIFFÉRÉ ×0,5 · 10:42:07", obtenu: revoir.libelleBadge({ etat: "differe", vitesse: 0.5, heure: HEURE_BADGE }, 0) },
  { ligne: 998, attendu: "4 / 12", obtenu: remplir(revoir.TEXTES.partout.moments, { n: 4, total: 12 }) },
  { ligne: 998, attendu: "Suivre l'action", obtenu: revoir.TEXTES.partout.suivre },
  { ligne: 1023, attendu: "Revoir : rien n'est relancé ni facturé", obtenu: revoir.TEXTES.partout.rienRelance },
  { ligne: 1023, attendu: "Cette conversation vient de la Salle OMO, réservée au mode Avancé", obtenu: revoir.TEXTES.simple.salle },
];

const PHRASES_LEGENDES: readonly PhraseSpec[] = [
  { ligne: 999, attendu: "Pourquoi ?", obtenu: legendes.TEXTES.partout.pourquoi },
  { ligne: 999, attendu: "Voir la consigne", obtenu: legendes.TEXTES.partout.voirConsigne },
  { ligne: 1000, attendu: "Il ne voit pas votre conversation : il reçoit seulement cette consigne et peut lire le projet", obtenu: legendes.TEXTES.partout.neuf },
  { ligne: 1001, attendu: "Il reprend son travail précédent, avec tout son historique", obtenu: legendes.TEXTES.partout.reprise },
  { ligne: 1002, attendu: "Il peut lire le carnet partagé et le plan", obtenu: legendes.TEXTES.partout.carnet },
  { ligne: 1067, attendu: "Résultat déposé, lu à son prochain tour (sans appel d'IA)", obtenu: legendes.TEXTES.partout.reveil },
  {
    ligne: 935,
    attendu:
      "Les assistants ne s'envoient jamais de message directement : tout passe par celui qui confie le travail, consigne à l'aller, résultat au retour. Chaque appel d'IA part séparément vers GitHub Copilot. Dans la Salle OMO, ils se laissent aussi des notes dans des fichiers partagés.",
    obtenu: `${legendes.TEXTES.partout.lecon} ${legendes.TEXTES.partout.leconSalle}`,
  },
];

// --- Gabarits ---------------------------------------------------------------------------------------------------------------------

/** Noms de gabarits permis dans les textes de la 3D (plan it3 §4.2.4). */
const GABARITS_PERMIS = new Set(["n", "total", "heure", "vitesse", "duree", "x", "affiches"]);

/** Gabarits attendus, texte par texte ; un texte à gabarit absent de cette table est refusé. */
const GABARITS: Readonly<Record<string, Readonly<Record<string, readonly string[]>>>> = {
  "salle3d-texts.ts": {
    "TEXTES.partout.compteurs.travailleUn": ["n"],
    "TEXTES.partout.compteurs.travaillent": ["n"],
    "TEXTES.partout.compteurs.attendUn": ["n"],
    "TEXTES.partout.compteurs.attendent": ["n"],
    "TEXTES.partout.compteurs.cout": ["x"],
  },
  "revoir-texts.ts": {
    "TEXTES.partout.badgeDiffere": ["vitesse", "heure"],
    "TEXTES.partout.moments": ["n", "total"],
    "TEXTES.partout.momentsAria": ["n", "total", "heure"],
    "TEXTES.partout.raccourci": ["duree"],
    "TEXTES.partout.duree.heures": ["n"],
    "TEXTES.partout.duree.minutes": ["n"],
    "TEXTES.partout.duree.secondes": ["n"],
    "TEXTES.partout.demande": ["n", "total", "heure"],
    "TEXTES.partout.consigne.titrePlusieurs": ["n", "total"],
    "TEXTES.partout.consigne.tronquee": ["affiches", "total"],
    "TEXTES.partout.consigne.absente": ["n"],
  },
  "legendes-texts.ts": {},
};

const liste = (noms: readonly string[]) => [...new Set(noms)].sort().join(", ");

function checkGabarits(source: string, textes: Textes, attendus: Readonly<Record<string, readonly string[]>>): Violation[] {
  const problems: Violation[] = [];
  const vus = new Set<string>();
  for (const section of SECTIONS) {
    for (const { chemin, texte } of leaves(textes[section], `TEXTES.${section}`)) {
      const add = (mot: string) => problems.push({ source, chemin, regle: "gabarit", mot });
      const noms = [...texte.matchAll(/\{(\w+)\}/g)].map((m) => m[1] ?? "");
      if (texte.includes("${")) add("${…} : écrire un gabarit « {nom} »");
      if (/[{}]/.test(texte.replace(/\{\w+\}/g, ""))) add("accolade isolée");
      for (const nom of noms) if (!GABARITS_PERMIS.has(nom)) add(`{${nom}} : nom hors de la liste permise`);
      const attendu = attendus[chemin] ?? [];
      if (Object.hasOwn(attendus, chemin)) vus.add(chemin);
      if (liste(noms) !== liste(attendu)) add(`gabarits {${liste(noms)}} au lieu de {${liste(attendu)}}`);
    }
  }
  for (const chemin of Object.keys(attendus)) if (!vus.has(chemin)) problems.push({ source, chemin, regle: "gabarit", mot: "texte attendu absent" });
  return problems;
}

// --- Modules « sans texte » : lexique recopié de textes.test.ts -----------------------------------------------------------------

interface SourceLiteral {
  ligne: number;
  texte: string;
}

/** Mots-clés après lesquels « / » ouvre une expression régulière. */
const BEFORE_EXPRESSION = new Set(["return", "typeof", "instanceof", "in", "of", "new", "delete", "void", "throw", "case", "do", "else", "yield", "await"]);

const IDENT_CHAR = /[\p{L}\p{N}_$]/u;

/** Décode les échappements d'une chaîne JavaScript (lettres, code hexadécimal ou Unicode, fin de ligne échappée). */
function unescapeJs(raw: string): string {
  const simples: Record<string, string> = { n: "\n", t: "\t", r: "\r", b: String.fromCharCode(8), f: String.fromCharCode(12), v: String.fromCharCode(11), 0: String.fromCharCode(0) };
  return raw.replace(/\\(u\{[0-9a-fA-F]+\}|u[0-9a-fA-F]{4}|x[0-9a-fA-F]{2}|\r\n|[\s\S])/g, (_, seq: string) => {
    if (seq.length > 1 && (seq[0] === "u" || seq[0] === "x")) return String.fromCodePoint(Number.parseInt(seq.slice(1).replace(/[{}]/g, ""), 16));
    if (seq === "\r\n" || seq === "\n" || seq === "\r" || seq === String.fromCharCode(0x2028) || seq === String.fromCharCode(0x2029)) return "";
    return simples[seq] ?? seq;
  });
}

/** Fin (indice qui suit les drapeaux) de l'expression régulière ouverte en `start`, ou -1 si la ligne ne la referme pas. */
function readRegex(source: string, start: number): number {
  let at = start + 1;
  let inClass = false;
  while (at < source.length && source[at] !== "\n") {
    const c = source.charAt(at);
    if (c === "\\") {
      at += 2;
      continue;
    }
    if (c === "/" && !inClass) {
      at += 1;
      while (at < source.length && IDENT_CHAR.test(source.charAt(at))) at += 1;
      return at;
    }
    if (c === "[") inClass = true;
    else if (c === "]") inClass = false;
    at += 1;
  }
  return -1;
}

/**
 * Chaînes littérales et morceaux fixes de gabarits d'un source TypeScript, dans l'ordre : commentaires et expressions régulières
 * écartés, expressions `${…}` parcourues (gabarits imbriqués compris). Recopié de textes.test.ts (sans la distinction « entier »,
 * inutile ici : un module sans texte n'exporte aucun texte).
 */
function sourceLiterals(source: string): SourceLiteral[] {
  const out: SourceLiteral[] = [];
  const ligne = (at: number) => source.slice(0, at).split("\n").length;
  const step = (at: number) => (source[at] === "\\" ? (source.startsWith("\r\n", at + 1) ? at + 3 : at + 2) : at + 1);
  type Frame = { depth: number; pieces: Array<{ at: number; raw: string }> };
  const suspended: Frame[] = [];
  let depth = 0;
  let regexAllowed = true;
  const emit = (frame: Frame) => {
    for (const piece of frame.pieces) out.push({ ligne: ligne(piece.at), texte: unescapeJs(piece.raw) });
  };
  const readTemplate = (frame: Frame, from: number): number => {
    let at = from;
    while (at < source.length && source[at] !== "`" && !(source[at] === "$" && source[at + 1] === "{")) at = step(at);
    frame.pieces.push({ at: from, raw: source.slice(from, Math.min(at, source.length)) });
    if (source[at] === "$") {
      depth += 1;
      frame.depth = depth;
      suspended.push(frame);
      regexAllowed = true;
      return at + 2;
    }
    emit(frame);
    regexAllowed = false;
    return at + 1;
  };
  let i = 0;
  while (i < source.length) {
    const c = source.charAt(i);
    if (c === "/" && source[i + 1] === "/") {
      const end = source.indexOf("\n", i);
      i = end === -1 ? source.length : end;
    } else if (c === "/" && source[i + 1] === "*") {
      const end = source.indexOf("*/", i + 2);
      i = end === -1 ? source.length : end + 2;
    } else if (c === '"' || c === "'") {
      let at = i + 1;
      while (at < source.length && source[at] !== c && source[at] !== "\n") at = step(at);
      out.push({ ligne: ligne(i), texte: unescapeJs(source.slice(i + 1, Math.min(at, source.length))) });
      i = at + 1;
      regexAllowed = false;
    } else if (c === "`") {
      i = readTemplate({ depth: 0, pieces: [] }, i + 1);
    } else if (c === "}" && suspended.at(-1)?.depth === depth) {
      depth -= 1;
      i = readTemplate(suspended.pop() as Frame, i + 1);
    } else if (IDENT_CHAR.test(c)) {
      let at = i + 1;
      while (at < source.length && IDENT_CHAR.test(source.charAt(at))) at += 1;
      regexAllowed = BEFORE_EXPRESSION.has(source.slice(i, at));
      i = at;
    } else if (c === "/" && regexAllowed && readRegex(source, i) !== -1) {
      i = readRegex(source, i);
      regexAllowed = false;
    } else {
      if (c === "{") depth += 1;
      else if (c === "}") depth -= 1;
      if (!/\s/u.test(c)) regexAllowed = !(c === ")" || c === "]" || c === "}");
      i += 1;
    }
  }
  for (const frame of suspended) emit(frame);
  return out;
}

/** Code (identifiant, clé, valeur d'énumération) plutôt que texte : minuscules ASCII et chiffres, séparés par - _ . ou :. */
const CODE_LIKE = /^[a-z0-9]+(?:[-_.:][a-z0-9]+)*$/;

/** Texte affichable plutôt que code : lettre et espace, lettre accentuée, ou mot à majuscule initiale (« Terminé », « Session »). */
const looksDisplayed = (texte: string) =>
  (/\p{L}/u.test(texte) && /\s/u.test(texte)) || /(?=\P{ASCII})\p{L}/u.test(texte) || /^\p{Lu}\p{Ll}[\p{L}'’-]*[.!?…]?$/u.test(texte);

function checkSansTexte(fichier: string, source: string): Violation[] {
  return sourceLiterals(source)
    .filter(({ texte }) => !CODE_LIKE.test(texte) && looksDisplayed(texte))
    .map(({ ligne, texte }) => ({ source: fichier, chemin: `ligne ${ligne}`, regle: "texte affichable dans un module sans texte", mot: texte }));
}

/**
 * Modules de server/shared sans aucune chaîne affichable (D-3d-21, constat 15), et paquet qui les crée. fluidity.ts (L30) n'y est
 * pas : ses noms de moteurs logiciels (« SwiftShader »…) sont des motifs de comparaison, jamais affichés.
 */
const SANS_TEXTE: ReadonlyArray<{ fichier: string; paquet: string }> = [
  { fichier: "legendes.ts", paquet: "L28a" },
  { fichier: "revoir.ts", paquet: "L28a" },
  { fichier: "revoir-access.ts", paquet: "L28a" },
  { fichier: "consignes.ts", paquet: "L28d" },
  { fichier: "vue-simple.ts", paquet: "L28c" },
  { fichier: "territoires.ts", paquet: "L31a" },
];

// --- Valeurs des types recopiés (D-3d-27), exhaustives par construction -----------------------------------------------------------

const RAISONS = Object.keys({
  accessibilite: true,
  "webgl-absent": true,
  "rendu-logiciel": true,
  "sonde-lente": true,
  saccades: true,
  "preference-2d": true,
} satisfies Record<FluidityReason, true>) as FluidityReason[];

const CLES = Object.keys({ neuf: true, reprise: true, carnet: true, "tache-de-fond": true, reveil: true, relance: true } satisfies Record<LegendeKey, true>) as LegendeKey[];

const REFUS = Object.keys({ "racine-inconnue": true, "salle-demande-en-cours": true, "salle-fin-inconnue": true } satisfies Record<RevoirRefus, true>) as RevoirRefus[];

/** Clés entières d'abord pour Object.keys (« 1 » avant « 0.25 ») : tri numérique. */
const VITESSES = Object.keys({ "0.25": true, "0.5": true, "1": true, "2": true, "4": true } satisfies Record<`${ReplaySpeed}`, true>)
  .map(Number)
  .sort((a, b) => a - b) as ReplaySpeed[];

/** Phrases que legendes-texts rend en mode Simple, clé par clé et deux à deux. */
function legendesSimple(): Leaf[] {
  const out: Leaf[] = [];
  for (const a of CLES) {
    for (const b of [null, ...CLES]) {
      const cles = b === null ? [a] : [a, b];
      legendes.phrasesLegende(cles, "simple").forEach((texte, index) => out.push({ chemin: `phrasesLegende([${cles.join(", ")}], simple)[${index}]`, texte }));
    }
  }
  return out;
}

const MODULES: ReadonlyArray<{ fichier: string; textes: Textes; rendusSimple: readonly Leaf[]; phrases: readonly PhraseSpec[] }> = [
  { fichier: "salle3d-texts.ts", textes: salle3d.TEXTES, rendusSimple: RAISONS.map((r) => ({ chemin: `messageFluidite(${r})`, texte: salle3d.messageFluidite(r) })), phrases: PHRASES_SALLE3D },
  { fichier: "revoir-texts.ts", textes: revoir.TEXTES, rendusSimple: REFUS.map((c) => ({ chemin: `libelleRefus(${c})`, texte: revoir.libelleRefus(c) })), phrases: PHRASES_REVOIR },
  { fichier: "legendes-texts.ts", textes: legendes.TEXTES, rendusSimple: legendesSimple(), phrases: PHRASES_LEGENDES },
];

// --- Tests ------------------------------------------------------------------------------------------------------------------------

describe("textes de la 3D : contrôles discriminants", () => {
  const vide = { simple: {}, avance: {}, partout: {} };
  const regles = (problems: Violation[]) => problems.map((p) => `${p.regle} : ${p.mot}`).sort();

  it("un sens par mot : « mode » hors de « mode Simple » ou « mode Avancé », « pause » et « relecture » refusés, dans toutes les sections", () => {
    assert.deepEqual(regles(checkVocabulaire("x-texts.ts", { ...vide, avance: { a: "Le mode différé" } })), ["un sens par mot : mode"]);
    assert.deepEqual(regles(checkVocabulaire("x-texts.ts", { ...vide, avance: { a: "Mettre en pause" } })), ["un sens par mot : pause"]);
    assert.deepEqual(regles(checkVocabulaire("x-texts.ts", { ...vide, avance: { a: "Relecture au ralenti" } })), ["un sens par mot : relecture"]);
    assert.deepEqual(checkVocabulaire("x-texts.ts", { ...vide, simple: { a: "Réservée au mode Avancé, pas au mode Simple." } }), []);
  });

  it("jamais « Arrêter », « agent » ni « orchestrateur », même en mode Avancé ; « Arrêt » et « arrêté » permis", () => {
    assert.deepEqual(regles(checkVocabulaire("x-texts.ts", { ...vide, avance: { a: "Arrêter la lecture" } })), ["jamais dans la 3D : Arrêter"]);
    assert.deepEqual(regles(checkVocabulaire("x-texts.ts", { ...vide, avance: { a: "Chaque agent" } })), ["jamais dans la 3D : agent"]);
    assert.deepEqual(regles(checkVocabulaire("x-texts.ts", { ...vide, avance: { a: "Un sous-agent" } })), ["jamais dans la 3D : agent"]);
    assert.deepEqual(regles(checkVocabulaire("x-texts.ts", { ...vide, avance: { a: "L'orchestrateur (Sisyphus)" } })), ["jamais dans la 3D : orchestrateur"]);
    assert.deepEqual(checkVocabulaire("x-texts.ts", { ...vide, partout: { a: "Arrêt au plafond", b: "arrêté" } }), []);
  });

  it("mode Simple : mot interdit, « extension » et équipe proposée refusés en simple et partout, permis en avance", () => {
    assert.deepEqual(regles(checkVocabulaire("x-texts.ts", { ...vide, simple: { a: "Votre session" } })), ["interdit en mode Simple : session"]);
    assert.deepEqual(regles(checkVocabulaire("x-texts.ts", { ...vide, partout: { a: "Relance par l'extension" } })), ["réservé au mode Avancé : extension"]);
    assert.deepEqual(regles(checkVocabulaire("x-texts.ts", { ...vide, simple: { a: "Essayer une Équipe" } })), ["réservé au mode Avancé : équipe"]);
    assert.deepEqual(checkVocabulaire("x-texts.ts", { ...vide, avance: { a: "Session, extension et équipes" } }), []);
    // Phrase rendue en mode Simple par une fonction : contrôlée comme une section simple.
    const rendu = [{ chemin: "phrasesLegende([relance], simple)[0]", texte: "Relance par l'extension (sans demande)" }];
    assert.deepEqual(regles(checkVocabulaire("x-texts.ts", vide, rendu)), ["réservé au mode Avancé : extension"]);
  });

  it("phrases de la spécification : apostrophe, tiret, espace ou préfixe différents refusés", () => {
    const phrase = (obtenu: string, prefixe?: string): PhraseSpec => ({ ligne: 1, attendu: "L'affichage – ok", obtenu, ...(prefixe === undefined ? {} : { prefixe }) });
    assert.deepEqual(checkPhrases("x", [phrase("L'affichage – ok"), phrase("Salle · L'affichage – ok", "Salle · ")]), []);
    const insecable = `L'affichage${String.fromCodePoint(0xa0)}– ok`;
    for (const obtenu of ["L’affichage – ok", "L'affichage - ok", insecable, "L'affichage – ok.", "Salle · L'affichage – ok"]) {
      assert.equal(checkPhrases("x", [phrase(obtenu)]).length, 1, obtenu);
    }
    assert.equal(checkPhrases("x", [phrase("L'affichage – ok", "Salle · ")]).length, 1);
  });

  it("gabarits : nom hors liste, jeu inattendu, `${}`, accolade isolée et texte attendu absent refusés", () => {
    const summary = (textes: Textes, attendus: Record<string, readonly string[]>) => checkGabarits("x", textes, attendus).map((p) => `${p.chemin} : ${p.mot}`);
    assert.deepEqual(summary({ ...vide, partout: { a: "{n} / {total}" } }, { "TEXTES.partout.a": ["total", "n"] }), []);
    assert.deepEqual(summary({ ...vide, partout: { a: "{nombre} travaillent" } }, { "TEXTES.partout.a": ["n"] }), [
      "TEXTES.partout.a : {nombre} : nom hors de la liste permise",
      "TEXTES.partout.a : gabarits {nombre} au lieu de {n}",
    ]);
    assert.deepEqual(summary({ ...vide, partout: { a: "{n} sur {total}" } }, {}), ["TEXTES.partout.a : gabarits {n, total} au lieu de {}"]);
    assert.deepEqual(summary({ ...vide, partout: { a: "Moment {n}" } }, { "TEXTES.partout.a": ["n", "total"] }), ["TEXTES.partout.a : gabarits {n} au lieu de {n, total}"]);
    assert.deepEqual(summary({ ...vide, partout: { a: "Moment ${n}" } }, { "TEXTES.partout.a": ["n"] }), ["TEXTES.partout.a : ${…} : écrire un gabarit « {nom} »"]);
    assert.deepEqual(summary({ ...vide, partout: { a: "Moment {n" } }, {}), ["TEXTES.partout.a : accolade isolée"]);
    assert.deepEqual(summary(vide, { "TEXTES.partout.b": ["n"] }), ["TEXTES.partout.b : texte attendu absent"]);
  });

  it("modules sans texte : texte affichable refusé (chaîne, gabarit, message d'erreur, nom propre), codes et commentaires permis", () => {
    const source = [
      /* 1 */ `import type { NeonScene } from "./neon-scene.ts";`,
      /* 2 */ `// « Il reprend son travail » : commentaire ignoré ; /* "Relancé" */`,
      /* 3 */ `export type Cle = "neuf" | "tache-de-fond" | "salle3d:plan";`,
      /* 4 */ `export const cle = (n: number) => (/Salle OMO/.test(String(n)) ? "reprise" : \`carnet-\${n}\`);`,
      /* 5 */ `export const phrase = () => "Il reprend son travail";`,
      /* 6 */ `export const aria = (n: number) => \`Moment \${n}\`;`,
      /* 7 */ `throw new Error("Revoir");`,
      /* 8 */ `export const moteur = "SwiftShader";`,
      /* 9 */ `export const etat = "réservé";`,
    ].join("\n");
    assert.deepEqual(
      checkSansTexte("legendes.ts", source).map((p) => [p.chemin, p.mot]),
      [
        ["ligne 5", "Il reprend son travail"],
        ["ligne 6", "Moment "],
        ["ligne 7", "Revoir"],
        ["ligne 8", "SwiftShader"],
        ["ligne 9", "réservé"],
      ],
    );
    // D'où l'exclusion de fluidity.ts (ligne 8) : ses motifs de comparaison seraient pris pour des textes.
    assert.equal(SANS_TEXTE.some((m) => m.fichier === "fluidity.ts"), false);
  });
});

describe("textes de la 3D : modules salle3d-texts, revoir-texts et legendes-texts", () => {
  it("vocabulaire : un sens par mot, jamais « Arrêter », « agent » ni « orchestrateur » ; en mode Simple, aucun mot interdit, ni extension ni équipe", () => {
    const problems = MODULES.flatMap((m) => checkVocabulaire(m.fichier, m.textes, m.rendusSimple));
    assert.deepEqual(problems, []);
    assert.ok(MODULES.every((m) => m.rendusSimple.length > 0));
  });

  it("phrases de la spécification exactes à l'octet", () => {
    assert.deepEqual(
      MODULES.flatMap((m) => checkPhrases(m.fichier, m.phrases)),
      [],
    );
    assert.equal(MODULES.reduce((n, m) => n + m.phrases.length, 0), 21);
  });

  it("gabarits cohérents, texte par texte", () => {
    assert.deepEqual(
      MODULES.flatMap((m) => checkGabarits(m.fichier, m.textes, GABARITS[m.fichier] ?? {})),
      [],
    );
    assert.deepEqual(Object.keys(GABARITS).sort(), MODULES.map((m) => m.fichier).sort());
  });

  it("fonctions : aucun gabarit laissé dans les phrases rendues", () => {
    const rendus = [
      salle3d.libelleCompteurs({ travaillent: 0, attendent: 0, cout: 0 }),
      salle3d.libelleCompteurs({ travaillent: null, attendent: 2, cout: 1.5 }),
      ...RAISONS.map((r) => salle3d.messageFluidite(r)),
      ...VITESSES.map((v) => revoir.formatVitesse(v)),
      ...VITESSES.map((v) => revoir.libelleBadge({ etat: "differe", vitesse: v, heure: HEURE_BADGE }, 120)),
      revoir.formatDuree(3_723_000),
      revoir.libelleRaccourci(130_000),
      ...REFUS.map((c) => revoir.libelleRefus(c)),
      revoir.libelleConsigneTronquee(8_000, 12_345),
      revoir.libelleConsigneAbsente(500),
      ...legendesSimple().map((l) => l.texte),
      ...CLES.flatMap((c) => legendes.phrasesLegende([c], "avance")),
    ];
    for (const texte of rendus) assert.doesNotMatch(texte, /[{}]/, texte);
  });

  it("types recopiés (D-3d-27) : une phrase par raison de fluidité, par refus, par vitesse et par clé de légende", () => {
    const fluidite = RAISONS.map((r) => salle3d.messageFluidite(r));
    assert.equal(new Set(fluidite).size, RAISONS.length);
    assert.ok(!fluidite.includes(salle3d.TEXTES.partout.fluidite.autre));
    assert.deepEqual(Object.keys(revoir.TEXTES.partout.refus).sort(), [...REFUS].sort());
    assert.deepEqual(Object.keys(revoir.TEXTES.partout.vitesses).sort(), VITESSES.map(String).sort());
    for (const cle of CLES) for (const mode of ["simple", "avance"] as const) assert.equal(legendes.phrasesLegende([cle], mode).length, 1, `${cle} ${mode}`);
  });

  it("imports : neon-texts.ts, neon-scene.ts et les types partagés de salle3d-types.ts (réexportés depuis le train de V0, D-3d-27)", () => {
    for (const m of MODULES) {
      const source = fs.readFileSync(path.join(SHARED_DIR, m.fichier), "utf8");
      const imports = [...source.matchAll(/\bfrom\s*["']([^"']+)["']/g)].map((x) => x[1] ?? "");
      for (const spec of imports) assert.ok(spec === "./neon-texts.ts" || spec === "./neon-scene.ts" || spec === "./salle3d-types.ts", `${m.fichier} : ${spec}`);
      assert.doesNotMatch(source, /^\s*import\s+(?!type\b)[^;]*from\s*["']\.\/salle3d-types\.ts["']/m, `${m.fichier} : salle3d-types.ts en types seulement`);
      assert.match(source, /^export type \{[^}]+\} from "\.\/salle3d-types\.ts";$/m, `${m.fichier} : réexportation`);
      assert.equal((source.match(/^export type \w+\s*=/gm) ?? []).length, 0, `${m.fichier} : plus aucune copie de type`);
    }
  });
});

describe("textes de la 3D : fonctions", () => {
  it("libelleCompteurs : singulier pour 0 et 1, pluriel au-delà, « état non vérifiable », montant du web, entrées illisibles → 0", () => {
    const sep = " · ";
    assert.equal(salle3d.libelleCompteurs({ travaillent: 1, attendent: 0, cout: 0 }), ["1 travaille", "0 attend votre accord", "0,00 $"].join(sep));
    assert.equal(salle3d.libelleCompteurs({ travaillent: 2, attendent: 5, cout: 1.005 }), ["2 travaillent", "5 attendent votre accord", "1,00 $"].join(sep));
    assert.equal(salle3d.libelleCompteurs({ travaillent: null, attendent: 1, cout: 0.42 }), ["état non vérifiable", "1 attend votre accord", "0,42 $"].join(sep));
    assert.equal(salle3d.libelleCompteurs({ travaillent: 3, attendent: 1, cout: 0.42 }, (usd) => `${usd} USD`), ["3 travaillent", "1 attend votre accord", "0.42 USD"].join(sep));
    assert.equal(salle3d.libelleCompteurs({ travaillent: -4, attendent: Number.NaN, cout: Number.POSITIVE_INFINITY }), ["0 travaille", "0 attend votre accord", "0,00 $"].join(sep));
  });

  it("messageFluidite : raison inconnue à l'exécution → phrase neutre, jamais une clé du prototype", () => {
    for (const raison of ["inconnue", "constructor", "__proto__", "toString"]) {
      assert.equal(salle3d.messageFluidite(raison as FluidityReason), salle3d.TEXTES.partout.fluidite.autre, raison);
    }
  });

  it("formatHeure : décalage de l'appelant, passage de minuit dans les deux sens, instant illisible", () => {
    assert.equal(revoir.formatHeure(HEURE_BADGE, 0), "10:42:07");
    assert.equal(revoir.formatHeure(HEURE_BADGE, 120), "12:42:07");
    assert.equal(revoir.formatHeure(HEURE_BADGE + 999, 0), "10:42:07");
    assert.equal(revoir.formatHeure(Date.UTC(2026, 8, 19, 23, 30, 0), 60), "00:30:00");
    assert.equal(revoir.formatHeure(Date.UTC(2026, 8, 19, 0, 15, 5), -60), "23:15:05");
    assert.equal(revoir.formatHeure(-1_000, 0), "23:59:59");
    assert.equal(revoir.formatHeure(Number.NaN, 0), "--:--:--");
    assert.equal(revoir.formatHeure(HEURE_BADGE, Number.NaN), "--:--:--");
  });

  it("formatDuree et libelleRaccourci : unités nulles omises, arrondi à la seconde, « 0 s » au plus bas", () => {
    const cas: Array<[number, string]> = [
      [0, "0 s"],
      [-5_000, "0 s"],
      [Number.NaN, "0 s"],
      [4_001, "4 s"],
      [45_400, "45 s"],
      [120_000, "2 min"],
      [130_000, "2 min 10 s"],
      [3_600_000, "1 h"],
      [3_723_000, "1 h 2 min 3 s"],
    ];
    for (const [ms, attendu] of cas) assert.equal(revoir.formatDuree(ms), attendu, String(ms));
    assert.equal(revoir.libelleRaccourci(130_000), "2 min 10 s sans nouvel événement, montrées en 1 s");
  });

  it("formatVitesse et libelleBadge : chaque vitesse, badge direct, valeur hors liste écrite telle quelle", () => {
    assert.deepEqual(VITESSES.map((v) => revoir.formatVitesse(v)), ["×0,25", "×0,5", "×1", "×2", "×4"]);
    assert.equal(revoir.formatVitesse(3 as ReplaySpeed), "×3");
    assert.equal(revoir.libelleBadge({ etat: "differe", vitesse: 0.25, heure: HEURE_BADGE }, 120), "EN DIFFÉRÉ ×0,25 · 12:42:07");
    for (const v of VITESSES) assert.ok(revoir.libelleBadge({ etat: "differe", vitesse: v, heure: 0 }, 0).includes(revoir.formatVitesse(v)), String(v));
  });

  it("libelleRefus : une phrase par code, code inconnu → phrase neutre", () => {
    assert.deepEqual(REFUS.map((c) => revoir.libelleRefus(c)), REFUS.map((c) => revoir.TEXTES.partout.refus[c]));
    for (const code of ["inconnu", "constructor", "__proto__"]) assert.equal(revoir.libelleRefus(code as RevoirRefus), revoir.TEXTES.partout.refusInconnu, code);
  });

  it("consignes : nombres groupés par une espace fine insécable, valeurs illisibles → 0", () => {
    const fine = String.fromCodePoint(0x202f);
    assert.equal(revoir.libelleConsigneTronquee(8_000, 12_345), `Consigne tronquée : 8${fine}000 caractères affichés sur 12${fine}345.`);
    assert.equal(revoir.libelleConsigneTronquee(999, 1_234_567), `Consigne tronquée : 999 caractères affichés sur 1${fine}234${fine}567.`);
    assert.ok(revoir.libelleConsigneAbsente(500).endsWith("ou plus de 500 consignes dans cette conversation)."));
    assert.ok(revoir.libelleConsigneAbsente(Number.NaN).includes("plus de 0 consignes"));
  });

  it("phrasesLegende : au plus 2 phrases, « neuf » jamais avec « reprise », relance selon le mode, doublons et clés inconnues ignorés", () => {
    const p = legendes.TEXTES.partout;
    assert.deepEqual(legendes.phrasesLegende(["neuf", "carnet"], "simple"), [p.neuf, p.carnet]);
    assert.deepEqual(legendes.phrasesLegende(["neuf", "reprise"], "avance"), [p.reprise]);
    assert.deepEqual(legendes.phrasesLegende(["reprise", "neuf", "carnet"], "avance"), [p.reprise, p.carnet]);
    assert.deepEqual(legendes.phrasesLegende(["reprise", "carnet", "tache-de-fond"], "avance"), [p.reprise, p.carnet]);
    assert.deepEqual(legendes.phrasesLegende(["carnet", "carnet"], "simple"), [p.carnet]);
    assert.deepEqual(legendes.phrasesLegende(["relance"], "avance"), [legendes.TEXTES.avance.relance]);
    assert.deepEqual(legendes.phrasesLegende(["relance"], "simple"), [legendes.TEXTES.simple.relance]);
    assert.deepEqual(legendes.phrasesLegende(["constructor" as LegendeKey, "reveil"], "simple"), [p.reveil]);
    assert.deepEqual(legendes.phrasesLegende([], "simple"), []);
  });
});

describe("textes de la 3D : modules « sans texte » de server/shared (D-3d-21)", () => {
  for (const { fichier, paquet } of SANS_TEXTE) {
    const chemin = path.join(SHARED_DIR, fichier);
    const raison = `absent de cette copie : créé par ${paquet} ; le train qui le fusionne vérifie que ce contrôle n'est plus sauté`;
    it(`server/shared/${fichier} : aucune chaîne affichable`, { skip: fs.existsSync(chemin) ? false : raison }, () => {
      assert.deepEqual(checkSansTexte(fichier, fs.readFileSync(chemin, "utf8")), []);
    });
  }
});
