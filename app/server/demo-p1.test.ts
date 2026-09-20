// Démonstration p1 (spécification §5.9, §6 l.1064, JP-9 ; plan d'exécution, fiche L5d) :
// - demo-p1.json vaut exactement la sortie de test-support/gen-demo.ts : les faits de factsFromEvent sur la capture p1, par le
//   chemin du magasin (EventMemory, FactDeduper), et les étapes du lecteur (moments où le dessin de la scène change) ;
// - analyse de secrets de la fixture (motifs de fixtures/README.md, « Nettoyage ») et aucun texte de la capture ;
// - DemoPlayer.tsx ne fait aucune requête : examen statique de ses imports, suivis de module en module, seulement pour les noms
//   utilisés (de NeonBand.tsx, NeonCarte et NeonTableau) : ni client de l'API ou du proxy (web/lib/api*.ts), ni fetch,
//   XMLHttpRequest, EventSource, WebSocket, sendBeacon ou import dynamique ;
// - textes du lecteur et avis du mode Simple (décision n° 4) ;
// - entrée [Voir une démonstration] (§5.7.4) : la bande (NeonBand, L5c) reçoit onDemonstration d'ActivityRegion, qui ouvre et
//   ferme le lecteur avec des rappels stables.
// Chaque garde a son contrôle discriminant (fichier modifié, secret planté, import réseau ajouté).
// L'e2e « zéro requête vers opencode pendant la démonstration » est dans L7b-2 (navigateur).
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import { dedupeFacts, factProblem } from "./shared/activity-facts.ts";
import type { ActivityFact } from "./shared/activity-types.ts";
import { TEXTES as TEXTES_DELEGATION } from "./shared/delegation-texts.ts";
import { lignesTableau, resumeBande } from "./shared/neon-band.ts";
import { moments, type NeonScene, scene } from "./shared/neon-scene.ts";
import { carnetVide, TEXTES } from "./shared/neon-texts.ts";
import { readCapture } from "./test-support/fake-opencode.ts";
import {
  DEMO_P1_CAPTURE,
  DEMO_P1_FILE,
  DEMO_P1_ROOT,
  DEMO_P1_SENT,
  DEMO_SCENE,
  type DemoFile,
  demoFacts,
  demoJson,
  demoP1,
  dessin,
  etapesVisibles,
} from "./test-support/gen-demo.ts";
import { leaks, localUsername } from "./test-support/helpers.ts";

const APP_DIR = path.join(import.meta.dirname, "..");
const ACTIVITY_DIR = path.join(APP_DIR, "web", "pages", "chat", "activity");
const DEMO_PLAYER = path.join(ACTIVITY_DIR, "DemoPlayer.tsx");
const NEON_BAND = path.join(ACTIVITY_DIR, "NeonBand.tsx");
const ACTIVITY_REGION = path.join(ACTIVITY_DIR, "ActivityRegion.tsx");

const TEXTE = fs.readFileSync(DEMO_P1_FILE, "utf8");
const FICHIER = JSON.parse(TEXTE) as DemoFile;
const GENERE = demoP1();

/** Écart entre le texte d'un demo-p1.json et la sortie du générateur, null s'il est identique à l'octet. */
function ecartAuGenerateur(texte: string): string | null {
  if (texte === demoJson(GENERE)) return null;
  return "demo-p1.json diffère de la sortie de gen-demo.ts : régénérer (node server/test-support/gen-demo.ts)";
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

// --- Fichier généré -----------------------------------------------------------------------------------------------------------

describe("démonstration p1 : demo-p1.json = factsFromEvent(p1) (§5.9, JP-9)", () => {
  it("le fichier est exactement la sortie de gen-demo.ts ; un fait modifié ou retiré est vu", () => {
    assert.equal(ecartAuGenerateur(TEXTE), null);
    const lignes = TEXTE.split("\n");
    const premier = lignes.findIndex((ligne) => ligne.includes('"kind":"consigne"'));
    assert.ok(premier > 0);
    assert.notEqual(ecartAuGenerateur(lignes.filter((_, i) => i !== premier).join("\n")), null);
    assert.notEqual(ecartAuGenerateur(TEXTE.replace('"agent":"analyste-journaux"', '"agent":"analyste-journal"')), null);
  });

  it("faits de la capture p1 par le chemin du magasin, tous acceptés par la garde des faits, sans doublon", () => {
    assert.equal(FICHIER.source, DEMO_P1_CAPTURE);
    assert.equal(FICHIER.rootId, DEMO_P1_ROOT);
    assert.deepEqual(FICHIER.faits, demoFacts(DEMO_P1_CAPTURE, DEMO_P1_ROOT, DEMO_P1_SENT));
    assert.ok(FICHIER.faits.length > 20, `${FICHIER.faits.length} faits`);
    for (const fait of FICHIER.faits) {
      assert.equal(factProblem(fait), null, JSON.stringify(fait));
      assert.equal(fait.rootId, DEMO_P1_ROOT);
    }
    assert.equal(dedupeFacts(FICHIER.faits).length, FICHIER.faits.length);
    // Seul le message envoyé par le cockpit est « votre demande » ; les consignes des enfants restent des consignes.
    const origines = FICHIER.faits.filter((f) => f.kind === "origine").map((f) => `${f.data.origine}|${f.ref}`);
    assert.ok(origines.includes(`demande|${DEMO_P1_SENT[0]}`), origines.join(", "));
    assert.equal(origines.filter((o) => o.startsWith("demande|")).length, 1);
  });

  it("la démonstration montre deux assistants en même temps, puis leurs résultats rendus et la fin", () => {
    const vues = FICHIER.etapes.map((t) => scene(FICHIER.faits, t, DEMO_SCENE));
    const ensemble = vues.find((vue) => {
      const vague = vue.faisceaux.filter((f) => f.kind === "consigne" && f.enMemeTemps && f.vers !== null);
      const enfants = new Set(vague.map((f) => f.vers));
      return enfants.size >= 2 && vue.noeuds.filter((n) => enfants.has(n.sessionId) && n.etat === "travaille").length >= 2;
    });
    assert.ok(ensemble, "aucune étape ne montre deux assistants qui travaillent « en même temps »");
    assert.ok(vues.some((vue) => vue.faisceaux.filter((f) => f.kind === "resultat").length >= 2), "résultats rendus");
    assert.ok(vues.some((vue) => vue.faisceaux.some((f) => f.kind === "demande" && f.de === "vous")), "votre demande");
    const fin = vues.at(-1);
    assert.ok(fin);
    assert.equal(fin.noeuds.length, 3);
    assert.ok(fin.noeuds.every((n) => n.etat === "termine"), fin.noeuds.map((n) => n.etat).join(", "));
  });

  it("étapes : moments où le dessin change, le premier compris ; aucun changement perdu ; sans ce filtre, des pas vides", () => {
    const tous = moments(FICHIER.faits);
    const etapes = FICHIER.etapes;
    assert.deepEqual(etapes, etapesVisibles(FICHIER.faits));
    assert.equal(etapes[0], tous[0]);
    assert.equal(etapes.at(-1), tous.at(-1));
    for (let i = 1; i < etapes.length; i++) assert.ok((etapes[i] ?? 0) > (etapes[i - 1] ?? 0), "étapes croissantes");
    const dessinA = (t: number) => dessin(scene(FICHIER.faits, t, DEMO_SCENE));
    for (let i = 1; i < etapes.length; i++) assert.notEqual(dessinA(etapes[i] ?? 0), dessinA(etapes[i - 1] ?? 0), `étape ${i + 1} sans changement`);
    for (const t of tous) {
      const derniere = [...etapes].reverse().find((e) => e <= t);
      assert.ok(derniere !== undefined);
      assert.equal(dessinA(t), dessinA(derniere), `moment ${t} : changement perdu`);
    }
    // Contrôle discriminant : tous les moments pris pour des étapes donnent des pas sans changement.
    assert.ok(etapes.length < tous.length, `${etapes.length} étapes pour ${tous.length} moments`);
    const vides = tous.filter((t, i) => i > 0 && dessinA(t) === dessinA(tous[i - 1] ?? t));
    assert.ok(vides.length > 0);
    // Le dessin ignore la provenance (indices de faits), rien d'autre : une position change le dessin.
    const vue = scene(FICHIER.faits, etapes.at(-1) ?? null, DEMO_SCENE);
    const deplace: NeonScene = { ...vue, noeuds: vue.noeuds.map((n, i) => (i === 0 ? { ...n, position: { x: n.position.x + 1, y: n.position.y } } : n)) };
    assert.notEqual(dessin(deplace), dessin(vue));
    assert.equal(dessin({ ...vue, noeuds: vue.noeuds.map((n) => ({ ...n, faits: [] })) }), dessin(vue));
  });
});

// --- Analyse de secrets et textes de la capture -----------------------------------------------------------------------------

/** Textes de la capture (parties texte, titres, consignes, sorties, chemins) : 8 caractères au moins. */
function textesDeLaCapture(nom: string): Set<string> {
  const out = new Set<string>();
  const garder = (valeur: unknown) => {
    if (typeof valeur === "string" && valeur.trim().length >= 8) out.add(valeur);
  };
  for (const { wire } of readCapture(nom)) {
    const p = (wire.payload as { properties?: unknown }).properties;
    if (!isRecord(p)) continue;
    if (isRecord(p.info)) garder(p.info.title);
    const part = isRecord(p.part) ? p.part : null;
    if (part === null) continue;
    garder(part.text);
    const state = isRecord(part.state) ? part.state : null;
    const input = isRecord(state?.input) ? state.input : {};
    for (const cle of ["prompt", "description", "filePath", "command", "pattern"]) garder(input[cle]);
    garder(state?.output);
    garder(state?.title);
  }
  return out;
}

describe("démonstration p1 : analyse de secrets (fixtures/README.md, « Nettoyage »)", () => {
  it("aucun motif de secret dans demo-p1.json ; un motif planté est trouvé", () => {
    assert.deepEqual(leaks(TEXTE), []);
    assert.deepEqual(leaks(TEXTE.replace('"agent":"analyste-journaux"', '"agent":"dev@exemple.fr"')), ["adresse e-mail"]);
    assert.deepEqual(leaks(TEXTE.replace(DEMO_P1_ROOT, "ghp_abcdefghijklmnopqrstuvwx")), ["jeton GitHub"]);
    const user = localUsername();
    if (user) assert.ok(leaks(TEXTE.replace("analyste-journaux", `/home/${user}`)).includes("nom d'utilisateur"));
  });

  it("aucun texte de la capture : ni message, ni titre, ni consigne, ni sortie, ni chemin ; un texte recopié est vu", () => {
    const textes = textesDeLaCapture(DEMO_P1_CAPTURE);
    assert.ok(textes.size > 10, `${textes.size} textes`);
    const recopies = (texte: string) => [...textes].filter((t) => texte.includes(t) || texte.includes(JSON.stringify(t).slice(1, -1)));
    assert.deepEqual(recopies(TEXTE), []);
    const exemple = [...textes].find((t) => /^[\w ./-]+$/.test(t)) ?? "";
    assert.notEqual(exemple, "");
    assert.ok(recopies(`${TEXTE}${exemple}`).includes(exemple));
  });
});

// --- Aucune requête : examen statique des imports de DemoPlayer.tsx ------------------------------------------------------------

const blanc = (texte: string) => texte.replace(/[^\n]/g, " ");

/**
 * Source sans commentaires ; `chaines` : contenus des chaînes blanchis. Positions et lignes gardées. Une chaîne '…' ou "…" s'arrête
 * à la fin de sa ligne (apostrophe d'un texte JSX, expression régulière lue comme du code : dégât borné à une ligne) ; les gabarits
 * `…${…}…` sont suivis avec leurs accolades.
 */
function lexer(source: string, chaines: boolean): string {
  let out = "";
  let i = 0;
  const gabarits: number[] = [];
  const garder = (texte: string) => (chaines ? blanc(texte) : texte);
  while (i < source.length) {
    const c = source[i] ?? "";
    const suivant = source[i + 1];
    if (c === "/" && (suivant === "/" || suivant === "*")) {
      const fin = suivant === "/" ? source.indexOf("\n", i) : source.indexOf("*/", i + 2);
      let stop = source.length;
      if (fin !== -1) stop = suivant === "/" ? fin : fin + 2;
      out += blanc(source.slice(i, stop));
      i = stop;
      continue;
    }
    if (c === '"' || c === "'") {
      let j = i + 1;
      while (j < source.length && source[j] !== c && source[j] !== "\n") j += source[j] === "\\" ? 2 : 1;
      const ferme = source[j] === c;
      out += c + garder(source.slice(i + 1, j)) + (ferme ? c : "");
      i = ferme ? j + 1 : j;
      continue;
    }
    if (c === "`" || (c === "}" && gabarits.at(-1) === 0)) {
      if (c === "}") gabarits.pop();
      let j = i + 1;
      while (j < source.length && source[j] !== "`" && !(source[j] === "$" && source[j + 1] === "{")) j += source[j] === "\\" ? 2 : 1;
      out += c + garder(source.slice(i + 1, j));
      if (source[j] === "`") {
        out += "`";
        i = j + 1;
      } else if (j < source.length) {
        out += "${";
        gabarits.push(0);
        i = j + 2;
      } else {
        i = j;
      }
      continue;
    }
    if (gabarits.length > 0 && (c === "{" || c === "}")) gabarits[gabarits.length - 1] = (gabarits.at(-1) ?? 0) + (c === "{" ? 1 : -1);
    out += c;
    i++;
  }
  return out;
}

interface Liaison {
  /** Nom exporté par le module importé : « * » pour tout le module, « default » pour l'export par défaut. */
  importe: string;
  /** Nom local (import) ; null pour une réexportation. */
  local: string | null;
  /** Nom exporté (réexportation seulement). */
  exporte: string | null;
}

interface Import {
  specifier: string;
  liaisons: Liaison[];
}

/** Imports et réexportations d'un module (types exclus) ; les imports sans liaison (CSS) sont ignorés. */
function imports(sansCommentaires: string): Import[] {
  const out: Import[] = [];
  const re = /^[ \t]*(import|export)\s+(type\s+)?((?:[\w$]+\s*,\s*)?(?:\{[^}]*\}|\*(?:\s+as\s+[\w$]+)?|[\w$]+))\s*from\s*["']([^"']+)["']/gm;
  for (const m of sansCommentaires.matchAll(re)) {
    if (m[2]) continue;
    const reexport = m[1] === "export";
    const clause = (m[3] ?? "").trim();
    const liaisons: Liaison[] = [];
    const defaut = /^([\w$]+)\s*(?:,|$)/.exec(clause);
    if (defaut?.[1]) liaisons.push({ importe: "default", local: defaut[1], exporte: null });
    const espace = /\*(?:\s+as\s+([\w$]+))?/.exec(clause);
    if (espace) liaisons.push({ importe: "*", local: reexport ? null : (espace[1] ?? null), exporte: reexport ? (espace[1] ?? "*") : null });
    const accolades = /\{([^}]*)\}/.exec(clause);
    for (const brut of accolades?.[1]?.split(",") ?? []) {
      const element = brut.trim();
      if (element === "" || /^type\s/.test(element)) continue;
      const [importe = "", alias] = element.split(/\s+as\s+/);
      liaisons.push(reexport ? { importe, local: null, exporte: alias ?? importe } : { importe, local: alias ?? importe, exporte: null });
    }
    out.push({ specifier: m[4] ?? "", liaisons });
  }
  return out;
}

interface Declaration {
  nature: string;
  corps: string;
}

/** Déclarations de premier niveau (colonne 0) d'un source blanchi, avec leur texte jusqu'à la suivante. */
function declarations(blanchi: string): Map<string, Declaration> {
  const re = /^(?:export\s+)?(?:declare\s+)?(?:async\s+)?(function\*?|const|let|var|class|interface|type|enum)\s+([A-Za-z_$][\w$]*)/gm;
  const trouvees = [...blanchi.matchAll(re)];
  const out = new Map<string, Declaration>();
  trouvees.forEach((m, i) => {
    const fin = trouvees[i + 1]?.index ?? blanchi.length;
    out.set(m[2] ?? "", { nature: m[1] ?? "", corps: blanchi.slice(m.index, fin) });
  });
  return out;
}

const identifiants = (texte: string) => new Set(texte.match(/[A-Za-z_$][\w$]*/g) ?? []);

/** Modules réseau de l'interface : clients de l'API et du proxy. */
const MODULE_RESEAU = /[\\/]web[\\/]lib[\\/]api(?:-[\w-]+)?\.ts$/;
/** Appels réseau directs ; un import dynamique pourrait charger un module réseau. */
const APPELS_RESEAU: ReadonlyArray<[RegExp, string]> = [
  [/\bfetch\s*\(/, "fetch"],
  [/\bXMLHttpRequest\b/, "XMLHttpRequest"],
  [/\bEventSource\b/, "EventSource"],
  [/\bWebSocket\b/, "WebSocket"],
  [/\bsendBeacon\b/, "sendBeacon"],
  [/\bimport\s*\(/, "import dynamique"],
];

type Noms = ReadonlySet<string> | "tout";

interface Examen {
  problemes: string[];
  /** Modules examinés (chemin relatif à app/) et noms suivis. */
  visites: Map<string, Set<string>>;
}

/**
 * Suit les imports depuis `entree` (tout le module), de module en module, pour les seuls noms utilisés : le code d'un nom est sa
 * déclaration de premier niveau et celles qu'elle cite, de proche en proche. Problème : un module réseau importé par du code
 * utilisé, ou un appel réseau dans ce code ou dans le code exécuté au chargement (constantes de premier niveau). Les paquets
 * (react) et les fichiers non TypeScript (CSS, JSON) ne sont pas suivis. Les modules que NeonBand.tsx importe pour la bande
 * elle-même ne comptent pas : la bande les charge déjà, la démonstration n'en ajoute aucun.
 */
function examiner(entree: string, lire: (fichier: string) => string = (f) => fs.readFileSync(f, "utf8")): Examen {
  const problemes: string[] = [];
  const visites = new Map<string, Set<string>>();
  const relatif = (fichier: string) => path.relative(APP_DIR, fichier).replaceAll("\\", "/");
  const file: Array<{ fichier: string; noms: Noms }> = [{ fichier: entree, noms: "tout" }];
  while (file.length > 0) {
    const { fichier, noms } = file.shift() ?? { fichier: "", noms: "tout" };
    const cle = relatif(fichier);
    const deja = visites.get(cle) ?? new Set<string>();
    const nouveaux = noms === "tout" ? ["*"] : [...noms].filter((nom) => !deja.has(nom));
    if (deja.has("*") || nouveaux.length === 0) continue;
    for (const nom of nouveaux) deja.add(nom);
    visites.set(cle, deja);
    const source = lire(fichier);
    const sansCommentaires = lexer(source, false);
    const blanchi = lexer(source, true);
    const decls = declarations(blanchi);
    const liens = imports(sansCommentaires);
    // Code utilisé : tout le module, ou la fermeture des noms demandés ; un nom ni déclaré ni réexporté : tout le module.
    let utilise = blanchi;
    const suivre: Array<{ specifier: string; noms: Noms }> = [];
    if (noms !== "tout") {
      const reexports = liens.flatMap((lien) => lien.liaisons.filter((l) => l.exporte !== null).map((l) => ({ lien, l })));
      const pile = nouveaux.filter((nom) => decls.has(nom));
      for (const nom of nouveaux.filter((n) => !decls.has(n))) {
        const r = reexports.find(({ l }) => l.exporte === nom || l.exporte === "*");
        if (r) suivre.push({ specifier: r.lien.specifier, noms: r.l.importe === "*" ? "tout" : new Set([r.l.importe]) });
        else pile.push("*");
      }
      if (!pile.includes("*")) {
        const fermeture = new Set<string>();
        while (pile.length > 0) {
          const nom = pile.pop() ?? "";
          if (fermeture.has(nom)) continue;
          fermeture.add(nom);
          for (const id of identifiants(decls.get(nom)?.corps ?? "")) if (decls.has(id) && !fermeture.has(id)) pile.push(id);
        }
        utilise = [...fermeture].map((nom) => decls.get(nom)?.corps ?? "").join("\n");
      }
    }
    const auChargement = [...decls.values()].filter((d) => ["const", "let", "var", "class"].includes(d.nature)).map((d) => d.corps).join("\n");
    for (const [re, appel] of APPELS_RESEAU) {
      if (re.test(utilise) || re.test(auChargement)) problemes.push(`${cle} : ${appel}`);
    }
    const cites = identifiants(utilise);
    for (const lien of liens) {
      const utilisees = lien.liaisons.filter((l) => l.local !== null && cites.has(l.local));
      if (utilisees.length === 0) continue;
      suivre.push({ specifier: lien.specifier, noms: utilisees.some((l) => l.importe === "*" || l.importe === "default") ? "tout" : new Set(utilisees.map((l) => l.importe)) });
    }
    for (const { specifier, noms: suivis } of suivre) {
      if (!specifier.startsWith(".") || !/\.tsx?$/.test(specifier)) continue;
      const cible = path.resolve(path.dirname(fichier), specifier);
      if (MODULE_RESEAU.test(cible)) {
        problemes.push(`${cle} : import réseau ${specifier}`);
        continue;
      }
      file.push({ fichier: cible, noms: suivis });
    }
  }
  return { problemes: [...new Set(problemes)].sort(), visites };
}

describe("DemoPlayer : aucune requête (examen statique, §6 l.1064)", () => {
  it("ni API, ni proxy, ni fetch, ni import dynamique ; de la bande, seulement NeonCarte et NeonTableau, qui ne lisent rien", () => {
    const { problemes, visites } = examiner(DEMO_PLAYER);
    assert.deepEqual(problemes, []);
    assert.deepEqual([...(visites.get("web/pages/chat/activity/NeonBand.tsx") ?? [])].sort(), ["NeonCarte", "NeonTableau"]);
    for (const module of ["server/shared/neon-scene.ts", "web/components/ui.tsx", "server/shared/neon-texts.ts"]) assert.ok(visites.has(module), module);
    assert.ok(![...visites.keys()].some((module) => /^web\/lib\/api/.test(module)));
  });

  it("contrôle discriminant : la bande entière lit le proxy et l'API (oc, activityApi), l'examen le voit", () => {
    const { problemes } = examiner(DEMO_PLAYER, (f) => {
      const source = fs.readFileSync(f, "utf8");
      return f === DEMO_PLAYER ? source.replace("<NeonCarte vue={vue} />", "<NeonBand rootId={DEMO} facts={[]} advanced={advanced} />").replace("{ NeonCarte, NeonTableau }", "{ NeonBand, NeonCarte, NeonTableau }") : source;
    });
    // [train V1, itération 3] La bande porte maintenant les commandes « Revoir » (L28b), qui ouvrent la boîte de L28c : montée
    // ENTIÈRE, elle atteint donc aussi ../../../lib/api-salle3d.ts (lecture seule, permise dans revoir/**, interdite au lecteur de
    // démonstration). Ce qui est éprouvé ici reste que l'examen VOIT les imports réseau de la bande, et le contrôle du haut, lui,
    // garde son égalité stricte à [] pour le vrai DemoPlayer.
    for (const attendu of [
      "web/pages/chat/activity/NeonBand.tsx : import réseau ../../../lib/api-activity.ts",
      "web/pages/chat/activity/NeonBand.tsx : import réseau ../../../lib/api.ts",
    ]) {
      assert.ok(problemes.includes(attendu), `${attendu} absent de ${JSON.stringify(problemes)}`);
    }
    assert.deepEqual(
      problemes.filter((probleme) => !/^web\/pages\/(chat\/activity\/NeonBand\.tsx|salle-controle\/revoir\/)/.test(probleme)),
      [],
      "aucun autre module atteint ne lit le réseau",
    );
  });

  it("contrôles discriminants : import de l'API, fetch, EventSource, import dynamique, ou NeonTableau qui lit le proxy", () => {
    const avec = (fichier: string, modifier: (source: string) => string) => (f: string) => {
      const source = fs.readFileSync(f, "utf8");
      return f === fichier ? modifier(source) : source;
    };
    const joueur = (ajout: string) => examiner(DEMO_PLAYER, avec(DEMO_PLAYER, (s) => s.replace("export function DemoPlayer(", `${ajout}\nexport function DemoPlayer(`))).problemes;
    const importApi = 'import { oc } from "../../../lib/api.ts";\nconst lire = () => oc.messages("ses_x");\nvoid lire;';
    assert.deepEqual(joueur(importApi), ["web/pages/chat/activity/DemoPlayer.tsx : import réseau ../../../lib/api.ts"]);
    assert.deepEqual(joueur('const lire = () => fetch("/api/activite");'), ["web/pages/chat/activity/DemoPlayer.tsx : fetch"]);
    assert.deepEqual(joueur('const flux = () => new EventSource("/api/events");'), ["web/pages/chat/activity/DemoPlayer.tsx : EventSource"]);
    assert.deepEqual(joueur('const charger = () => import("./NeonBand.tsx");'), ["web/pages/chat/activity/DemoPlayer.tsx : import dynamique"]);
    // Un commentaire ou un texte qui cite fetch( n'est pas un appel.
    assert.deepEqual(joueur('// fetch("/x")\nconst note = "fetch(";'), []);
    const tableauQuiLit = examiner(
      DEMO_PLAYER,
      avec(NEON_BAND, (s) => s.replace("export function NeonTableau({ vue }: { vue: NeonScene }) {", 'export function NeonTableau({ vue }: { vue: NeonScene }) {\n  void oc.messages("ses_x");')),
    ).problemes;
    assert.deepEqual(tableauQuiLit, ["web/pages/chat/activity/NeonBand.tsx : import réseau ../../../lib/api.ts"]);
  });

  it("lexer : commentaires et chaînes blanchis, gabarits suivis, positions gardées", () => {
    const source = 'const a = `x${b ? "fetch(" : `y${c}`}z`; // fetch(\n/* fetch( */ const d = fetch(u);';
    const blanchi = lexer(source, true);
    assert.equal(blanchi.length, source.length);
    assert.equal(blanchi.split("\n").length, source.split("\n").length);
    assert.equal((blanchi.match(/fetch\s*\(/g) ?? []).length, 1);
    assert.ok(blanchi.includes("const d = fetch(u)"));
    assert.ok(lexer(source, false).includes('"fetch("'));
  });
});

// --- Textes -------------------------------------------------------------------------------------------------------------------

/** Mots interdits en mode Simple (§2.3 l.102, extrait de textes.test.ts) et noms réservés au mode Avancé (Salle OMO, extension). */
const INTERDITS_SIMPLE = /(?<![\p{L}-])(?:agents?|sous-agents?|sessions?|prompts?|jetons?|tokens?|orchestrat(?:eur|rice)s?|parall[èe]les?|n(?:œ|oe)uds?|permissions?|salle omo|extension)(?![\p{L}])/iu;

// --- Entrée [Voir une démonstration] -----------------------------------------------------------------------------------------

/**
 * Câblage de l'entrée dans ActivityRegion.tsx : problème trouvé, null s'il est complet. La bande n'affiche [Voir une démonstration]
 * que si elle reçoit onDemonstration ; les rappels sont stables (useCallback sans dépendance), sinon Modal reprendrait le focus à
 * chaque rendu de la région (son effet dépend de onClose).
 */
function entreeDemonstration(source: string): string | null {
  const code = lexer(source, false);
  const bande = /<NeonBand\b[^>]*?\sonDemonstration=\{(\w+)\}[^>]*\/>/.exec(code);
  if (!bande) return "la bande ne reçoit pas onDemonstration";
  const ouvrir = new RegExp(`const ${bande[1]} = useCallback\\(\\(\\) => (\\w+)\\(true\\), \\[\\]\\);`).exec(code);
  if (!ouvrir) return `${bande[1]} n'ouvre pas la démonstration par un rappel stable`;
  const etat = new RegExp(`const \\[(\\w+), ${ouvrir[1]}\\] = useState\\(false\\);`).exec(code);
  if (!etat) return "état de la démonstration introuvable, ou ouvert au premier rendu";
  const lecteur = new RegExp(`\\{${etat[1]} \\? <DemoPlayer advanced=\\{advanced\\} onClose=\\{(\\w+)\\} /> : null\\}`).exec(code);
  if (!lecteur) return "DemoPlayer n'est pas rendu à l'ouverture";
  if (!new RegExp(`const ${lecteur[1]} = useCallback\\(\\(\\) => ${ouvrir[1]}\\(false\\), \\[\\]\\);`).test(code)) return `${lecteur[1]} : fermeture sans rappel stable`;
  return null;
}

describe("DemoPlayer : entrée [Voir une démonstration] (§5.7.4, §5.9)", () => {
  it("ActivityRegion passe onDemonstration à la bande, ouvre et ferme le lecteur ; la bande montre l'entrée en mode Simple", () => {
    const region = fs.readFileSync(ACTIVITY_REGION, "utf8");
    assert.equal(entreeDemonstration(region), null);
    const bande = fs.readFileSync(NEON_BAND, "utf8");
    assert.match(bande, /mode === "simple" \? \([\s\S]*?\{onDemonstration \? \(\s*<button[^>]*onClick=\{onDemonstration\}>\s*\{TEXTES\.simple\.demonstration\}/);
  });

  it("contrôles discriminants : entrée absente, lecteur jamais rendu, rappels instables", () => {
    const region = fs.readFileSync(ACTIVITY_REGION, "utf8");
    const sans = (modifier: (source: string) => string) => {
      const modifie = modifier(region);
      assert.notEqual(modifie, region, "mutation sans effet");
      return entreeDemonstration(modifie);
    };
    const sansEntree = (s: string) => s.replace(/\s+onDemonstration=\{\w+\}/, "");
    assert.equal(sans(sansEntree), "la bande ne reçoit pas onDemonstration");
    // Un commentaire qui cite la propriété ne compte pas.
    const citee = (s: string) => sansEntree(s).replace("  return (", "  // <NeonBand onDemonstration={ouvrirDemonstration} />\n  return (");
    assert.equal(sans(citee), "la bande ne reçoit pas onDemonstration");
    assert.equal(sans((s) => s.replace(/\{demonstration \? <DemoPlayer .*? \/> : null\}/, "")), "DemoPlayer n'est pas rendu à l'ouverture");
    assert.match(sans((s) => s.replace("useCallback(() => setDemonstration(true), [])", "() => setDemonstration(true)")) ?? "", /rappel stable/);
    assert.match(sans((s) => s.replace("useCallback(() => setDemonstration(false), [])", "() => setDemonstration(false)")) ?? "", /fermeture sans rappel stable/);
    assert.equal(sans((s) => s.replace("useState(false);\n  const ouvrirDemonstration", "useState(true);\n  const ouvrirDemonstration")), "état de la démonstration introuvable, ou ouvert au premier rendu");
  });
});

describe("DemoPlayer : textes (§5.9, décision n° 4)", () => {
  it("étiquette, lecteur et avis du mode Simple", () => {
    assert.equal(TEXTES.partout.demonstrationEnregistree, "Démonstration enregistrée : aucune IA n'est appelée");
    assert.equal(TEXTES.simple.demonstration, "Voir une démonstration : deux assistants en même temps");
    assert.equal(TEXTES.simple.demonstrationAvancee, "Enregistrée en mode Avancé.");
    assert.equal(TEXTES_DELEGATION.simple.avis, "En mode Simple, l'IA ne délègue pas : elle continue seule.");
    assert.deepEqual(TEXTES.partout.lecteur, {
      titre: "Deux assistants en même temps",
      moment: "Moment {n} / {total}",
      momentAccessible: "Moment {n} sur {total}, {duree} depuis le début",
      depuisDebut: "{duree} depuis le début",
      precedent: "Moment précédent",
      suivant: "Moment suivant",
      recommencer: "Recommencer",
    });
  });

  it("DemoPlayer.tsx : titre = étiquette, avis Simple, aucun texte écrit hors des modules de textes", () => {
    const source = fs.readFileSync(DEMO_PLAYER, "utf8");
    assert.ok(source.includes("title={TEXTES.partout.demonstrationEnregistree}"));
    // [3d] DemoPlayer.tsx est passé à la salle de contrôle 3D (L34) : l'avis du mode Simple est maintenant la phrase UNIQUE
    // revoir-texts.simple.demoAvance (U1, D-3d-26), qui dit la même chose que TEXTES.simple.demonstrationAvancee suivi de
    // TEXTES_DELEGATION.simple.avis. Les deux textes de l'itération 1 restent contrôlés par le test des textes ci-dessus ; leur
    // emploi par le lecteur est vérifié, avec sa condition, par demos-it3.test.ts.
    assert.ok(source.includes("REVOIR.simple.demoAvance"));
    const code = lexer(source, false);
    const phrases = [...code.matchAll(/(["'`])((?:(?!\1).)*)\1/g)].map((m) => m[2] ?? "").filter((t) => /[À-ÿ]|[A-Z][a-z]+ [a-z]/.test(t));
    assert.deepEqual(phrases, []);
    const textesJsx = [...lexer(source, true).matchAll(/>([^<>{}\n]*\p{L}[^<>{}\n]*)</gu)].map((m) => (m[1] ?? "").trim()).filter((t) => t !== "" && !/^[\w.]+$/.test(t));
    assert.deepEqual(textesJsx, []);
  });

  it("mode Simple : chaque étape, vue avec le vocabulaire du mode Simple, sans mot du mode Avancé", () => {
    for (const t of FICHIER.etapes) {
      const vue: NeonScene = { ...scene(FICHIER.faits, t, DEMO_SCENE), mode: "simple" };
      const textes = [
        ...lignesTableau(vue).flatMap((ligne) => [ligne.nom, ligne.secteur ?? "", ligne.etat, ...ligne.signes]),
        resumeBande(vue) ?? "",
        carnetVide(vue.mode),
        ...Object.values(TEXTES.partout.lecteur),
        TEXTES.simple.demonstrationAvancee,
        TEXTES_DELEGATION.simple.avis,
      ];
      for (const texte of textes) assert.doesNotMatch(texte, INTERDITS_SIMPLE, texte);
    }
    // Contrôle discriminant : le carnet du mode Avancé nomme la Salle OMO, refusé en mode Simple.
    assert.match(carnetVide("avance"), INTERDITS_SIMPLE);
  });
});

// --- Faits : forme attendue par le lecteur -------------------------------------------------------------------------------------

describe("DemoPlayer : faits lus sans requête ni texte", () => {
  it("chaque fait ne porte que des codes, identifiants, nombres ou clés ; aucune chaîne hors de la garde", () => {
    const valeurs = FICHIER.faits.flatMap((fait: ActivityFact) => Object.values(fait.data));
    assert.ok(valeurs.every((v) => v === null || typeof v === "number" || typeof v === "boolean" || /^[A-Za-z0-9_./-]{0,128}$/.test(v)));
  });
});
