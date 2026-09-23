// Démonstration d'équipe (spécification §5.3 l.896, §5.4 l.909, §5.9 l.1013-1017, §6 l.1064, JP-9 ; fiche L49 ; D-5-15, D-5-24).
//
// Ce que ce fichier tient, garde par garde :
// - `demo-equipe.json` vaut EXACTEMENT la sortie de `test-support/gen-demo-equipe.ts`, c'est-à-dire l'exécuteur d'équipe de
//   l'itération 4 joué par le harnais sur le FAUX opencode : la fixture est donc un enregistrement, jamais un texte écrit à la
//   main. La régénération se rejoue ici même, et la canonisation est contrôlée à part : deux enregistrements qui voient les
//   mêmes étapes dans le même ordre donnent le même fichier, quel que soit l'entrelacement des faits ;
// - la fixture ne porte AUCUN secret (mêmes motifs que les captures de l'itération 1) et AUCUN texte qui ne soit pas l'un des
//   textes fictifs déclarés par le générateur ;
// - `TeamDemo.tsx` ne fait AUCUNE requête : ni client de l'API ou du proxy (web/lib/api*.ts), ni fetch, XMLHttpRequest,
//   EventSource, WebSocket, sendBeacon, ni import dynamique — dans son source et dans les modules purs qu'il ajoute. Deux
//   modules sont bornés, parce que leur pureté est gardée ailleurs ou prouvée ici : le lecteur (DemoPlayer.tsx), gardé nom par
//   nom par `demo-p1.test.ts`, et `chat/turn.ts`, dont les modèles de l'itération 4 ne prennent que `boundedAiText` — une borne
//   NOMMÉE, dont ce fichier prouve la pureté et qui signale tout autre nom qu'on y prendrait ;
// - en mode Simple, [Voir une démonstration] ne paraît pas tant que `ouvertesEnSimple` est faux : le bouton n'est rendu que dans
//   l'état vide et dans la galerie, que le modèle pur de l'itération 4 laisse nuls (U1, D-5-24). AUCUNE constante propre ;
// - mouvement réduit : aucune lecture automatique, aucune minuterie, aucune animation PROPRE au lecteur ni à la démonstration
//   (les transitions de la bande sont celles de NeonCarte, que le mouvement réduit coupe ; croisements-c5b-v4 le relie au README) ;
// - textes : ceux de `construction-texts.ts`, à l'octet ; les moments se disent « n / N », jamais « étape ».
// Chaque garde a son contrôle discriminant (fixture modifiée, secret planté, import réseau ajouté, bouton déplacé).
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import { factProblem } from "./shared/activity-facts.ts";
import type { ActivityFact } from "./shared/activity-types.ts";
import { TEXTES as TEXTES_CONSTRUCTION } from "./shared/construction-texts.ts";
import { TEXTES as TEXTES_NEON } from "./shared/neon-texts.ts";
import type { TeamRunView, TeamsListResponse } from "./shared/team-types.ts";
import {
  canoniserDemoEquipe,
  DEMO_EQUIPE_DEBUT,
  DEMO_EQUIPE_FILE,
  DEMO_EQUIPE_PAS,
  DEMO_EQUIPE_TEXTES,
  type DemoEquipeFile,
  type DemoEquipeInstantane,
  demoEquipeJson,
  genererDemoEquipe,
  jalonDe,
  renommerIdentifiants,
} from "./test-support/gen-demo-equipe.ts";
import { leaks, localUsername } from "./test-support/helpers.ts";
import { buildTeamsTab } from "../web/pages/assistants/teams/teams-tab-model.ts";

const APP_DIR = path.join(import.meta.dirname, "..");
const TEAMS_DIR = path.join(APP_DIR, "web", "pages", "assistants", "teams");
const TEAM_DEMO = path.join(TEAMS_DIR, "TeamDemo.tsx");
const TEAMS_TAB = path.join(TEAMS_DIR, "TeamsTab.tsx");
const TEAM_GALLERY = path.join(TEAMS_DIR, "TeamGallery.tsx");
const DEMO_PLAYER = path.join(APP_DIR, "web", "pages", "chat", "activity", "DemoPlayer.tsx");
const TURN = path.join(APP_DIR, "web", "pages", "chat", "turn.ts");

const TEXTE = fs.readFileSync(DEMO_EQUIPE_FILE, "utf8");
const FICHIER = JSON.parse(TEXTE) as DemoEquipeFile;
const lire = (fichier: string) => fs.readFileSync(fichier, "utf8");

// --- Fichier régénéré ---------------------------------------------------------------------------------------------------------

describe("démonstration d'équipe : demo-equipe.json = sortie de gen-demo-equipe.ts (§5.9, JP-9)", () => {
  it("le fichier est exactement la sortie du générateur, rejoué sur le faux opencode ; aucune IA appelée", async (t) => {
    const regenere = demoEquipeJson(await genererDemoEquipe(t));
    assert.equal(regenere, TEXTE, "demo-equipe.json diffère : régénérer (node server/test-support/gen-demo-equipe.ts)");
  });

  it("forme du fichier : version 1, moments croissants au pas du générateur, une vue de lancement par moment", () => {
    assert.equal(FICHIER.version, 1);
    assert.ok(FICHIER.moments.length >= 5, `${FICHIER.moments.length} moments`);
    FICHIER.moments.forEach((moment, rang) => {
      assert.equal(moment.at, DEMO_EQUIPE_DEBUT + rang * DEMO_EQUIPE_PAS, `moment ${rang}`);
      assert.ok(Array.isArray(moment.faits));
      assert.equal(typeof moment.run.id, "string");
      for (const fait of moment.faits) assert.equal(fait.at, moment.at, JSON.stringify(fait));
    });
    // Aucune heure de l'horloge de la machine : toutes les heures du fichier sont celles des moments.
    const heures = new Set(FICHIER.moments.map((moment) => moment.at));
    const horsMoments: number[] = [];
    const chercher = (valeur: unknown) => {
      if (typeof valeur === "number" && Number.isInteger(valeur) && valeur >= 1_000_000_000_000 && !heures.has(valeur)) horsMoments.push(valeur);
      else if (Array.isArray(valeur)) for (const element of valeur) chercher(element);
      else if (typeof valeur === "object" && valeur !== null) for (const element of Object.values(valeur)) chercher(element);
    };
    chercher(FICHIER);
    assert.deepEqual(horsMoments, []);
  });

  it("tous les faits passent la garde des faits, sous la même conversation, et les identifiants sont ceux du générateur", () => {
    const faits = FICHIER.moments.flatMap((moment) => moment.faits);
    assert.ok(faits.length > 10, `${faits.length} faits`);
    const racine = FICHIER.moments[0]?.run.rootId;
    assert.match(String(racine), /^ses_demo_\d+$/);
    for (const fait of faits) {
      assert.equal(factProblem(fait), null, JSON.stringify(fait));
      assert.equal(fait.rootId, racine);
    }
    // Aucun identifiant tiré au sort : ni identifiant opencode brut, ni UUID de lancement.
    assert.doesNotMatch(TEXTE, /"ses_(?!demo_)[A-Za-z0-9]{10,}"/);
    assert.doesNotMatch(TEXTE, /"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}"/);
  });

  it("le déroulé enregistré est bien « Avis indépendants » : trois étapes en même temps, puis une synthèse, puis terminée", () => {
    const etats = FICHIER.moments.map((moment) => moment.run.steps.map((step) => step.state));
    const ensemble = etats.find((ligne) => ligne.filter((etat) => etat === "en-cours").length >= 3);
    assert.ok(ensemble, `aucun moment ne montre trois étapes en même temps : ${JSON.stringify(etats)}`);
    const fin = FICHIER.moments.at(-1)?.run;
    assert.ok(fin);
    assert.equal(fin.state, "terminee");
    assert.equal(fin.steps.length, 4);
    for (const step of fin.steps) assert.equal(step.state, "terminee", step.stepId);
    // La synthèse est la dernière étape et elle ne part qu'une fois les trois avis rendus.
    const synthese = fin.steps.at(-1);
    assert.ok(synthese);
    const debutSynthese = FICHIER.moments.findIndex((moment) => (moment.run.steps.at(-1)?.state ?? "prevue") !== "prevue");
    assert.ok(debutSynthese > 0);
    const avant = FICHIER.moments[debutSynthese - 1]?.run.steps.slice(0, 3) ?? [];
    for (const step of avant) assert.equal(step.state, "terminee", step.stepId);
    assert.ok(fin.cost > 0);
  });
});

// --- Canonisation : le même ordre d'étapes donne le même fichier ---------------------------------------------------------------

/** Instantanés bruts reconstitués depuis la fixture : faits CUMULÉS et vue, moment par moment. */
function instantanesDeLaFixture(fichier: DemoEquipeFile): DemoEquipeInstantane[] {
  const out: DemoEquipeInstantane[] = [];
  let cumules: ActivityFact[] = [];
  for (const moment of fichier.moments) {
    cumules = [...cumules, ...moment.faits];
    out.push({ faits: [...cumules], run: structuredClone(moment.run) });
  }
  return out;
}

/**
 * Même suite d'instantanés, mais les faits d'un même moment rendus dans un AUTRE entrelacement : chaque session garde l'ordre
 * de ses propres faits (il est causal), les sessions se croisent dans l'ordre inverse. C'est exactement ce que la charge de la
 * machine fait varier entre deux enregistrements.
 */
function entrelacementInverse(instantanes: readonly DemoEquipeInstantane[], fichier: DemoEquipeFile): DemoEquipeInstantane[] {
  let cumules: ActivityFact[] = [];
  return instantanes.map((instantane, rang) => {
    const faits = fichier.moments[rang]?.faits ?? [];
    const sessions = [...new Set(faits.map((fait) => fait.sessionId))].reverse();
    cumules = [...cumules, ...sessions.flatMap((sessionId) => faits.filter((fait) => fait.sessionId === sessionId))];
    return { faits: [...cumules], run: instantane.run };
  });
}

describe("démonstration d'équipe : canonisation reproductible (déterminisme du générateur)", () => {
  it("rejouer la fixture par la canonisation rend la fixture : la canonisation est idempotente", () => {
    assert.equal(demoEquipeJson(canoniserDemoEquipe(instantanesDeLaFixture(FICHIER))), TEXTE);
  });

  it("l'ordre des faits d'un même moment ne change RIEN : c'est l'ordre des étapes qui décide", () => {
    const inverse = entrelacementInverse(instantanesDeLaFixture(FICHIER), FICHIER);
    assert.equal(demoEquipeJson(canoniserDemoEquipe(inverse)), TEXTE);
  });

  it("contrôles discriminants : un état d'étape changé se voit ; un identifiant déjà canonique n'est pas renommé deux fois", () => {
    const instantanes = instantanesDeLaFixture(FICHIER);
    const dernier = instantanes.at(-1);
    assert.ok(dernier);
    const jalonAvant = jalonDe(dernier.run);
    const modifie = structuredClone(instantanes);
    const cible = modifie.at(-1)?.run.steps[0];
    assert.ok(cible);
    cible.state = "echec";
    assert.notEqual(jalonDe(modifie.at(-1)?.run as TeamRunView), jalonAvant);
    assert.notEqual(demoEquipeJson(canoniserDemoEquipe(modifie)), TEXTE);
    assert.deepEqual(renommerIdentifiants(FICHIER), FICHIER);
  });

  it("contrôle discriminant : un moment retiré change le fichier", () => {
    const sansDernier = instantanesDeLaFixture(FICHIER).slice(0, -1);
    assert.notEqual(demoEquipeJson(canoniserDemoEquipe(sansDernier)), TEXTE);
  });
});

// --- Analyse de secrets et textes fictifs ---------------------------------------------------------------------------------------

/** Chaînes du fichier qui peuvent être lues par quelqu'un : 8 caractères au moins et au moins une espace ou un accent. */
function textesLibres(fichier: DemoEquipeFile): string[] {
  const out = new Set<string>();
  for (const moment of fichier.moments) {
    const run = moment.run;
    out.add(run.titre);
    for (const step of run.steps) {
      out.add(step.titre);
      out.add(step.assistantTitre);
      if (step.extrait !== null) out.add(step.extrait);
    }
    if (run.pause !== null) out.add(run.pause.message);
  }
  return [...out].filter((texte) => texte.trim().length >= 8);
}

describe("démonstration d'équipe : analyse de secrets et données fictives (§5.9)", () => {
  it("aucun motif de secret dans la fixture ; un motif planté est trouvé", () => {
    assert.deepEqual(leaks(TEXTE), []);
    assert.deepEqual(leaks(TEXTE.replace("Clarté", "ghp_abcdefghijklmnopqrstuvwx")), ["jeton GitHub"]);
    assert.deepEqual(leaks(TEXTE.replace("Clarté", "dev@exemple.fr")), ["adresse e-mail"]);
    const utilisateur = localUsername();
    if (utilisateur) assert.ok(leaks(TEXTE.replace("Clarté", `/home/${utilisateur}`)).includes("nom d'utilisateur"));
  });

  it("aucun texte qui ne soit pas l'un des textes FICTIFS du générateur ; un texte étranger est vu", () => {
    const fictifs = new Set(DEMO_EQUIPE_TEXTES);
    const etrangers = textesLibres(FICHIER).filter((texte) => !fictifs.has(texte));
    assert.deepEqual(etrangers, []);
    const avecEtranger = structuredClone(FICHIER);
    const premier = avecEtranger.moments[0];
    assert.ok(premier);
    premier.run.titre = "Revue SQL sur réplica";
    assert.deepEqual(
      textesLibres(avecEtranger).filter((texte) => !fictifs.has(texte)),
      ["Revue SQL sur réplica"],
    );
  });

  it("aucun chemin de poste : le dossier enregistré est celui du faux opencode", () => {
    for (const moment of FICHIER.moments) assert.equal(moment.run.directory, "/workspace");
    assert.doesNotMatch(TEXTE, /[A-Za-z]:\\\\|\/Users\/|\/home\//);
  });
});

// --- Aucune requête : examen des imports de TeamDemo.tsx --------------------------------------------------------------------

/**
 * Source dont les commentaires sont blanchis et, si `chaines` est vrai, le contenu des chaînes aussi (un texte qui cite
 * `fetch(` n'est alors pas un appel). Longueurs et lignes gardées : les positions restent lisibles.
 */
export function lexer(source: string, chaines: boolean): string {
  let out = "";
  let i = 0;
  const blanc = (texte: string) => texte.replace(/[^\n]/g, " ");
  const garder = (texte: string) => (chaines ? blanc(texte) : texte);
  while (i < source.length) {
    const c = source[i] ?? "";
    const suivant = source[i + 1];
    if (c === "/" && (suivant === "/" || suivant === "*")) {
      const fin = suivant === "/" ? source.indexOf("\n", i) : source.indexOf("*/", i + 2);
      const stop = fin === -1 ? source.length : suivant === "/" ? fin : fin + 2;
      out += blanc(source.slice(i, stop));
      i = stop;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") {
      let j = i + 1;
      while (j < source.length && source[j] !== c && (c === "`" || source[j] !== "\n")) j += source[j] === "\\" ? 2 : 1;
      const ferme = source[j] === c;
      out += c + garder(source.slice(i + 1, j)) + (ferme ? c : "");
      i = ferme ? j + 1 : j;
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

/** Source sans commentaires, chaînes gardées : pour lire les chemins des imports. */
const sansCommentaires = (source: string) => lexer(source, false);
/** Source sans commentaires ni contenu de chaîne : pour chercher des appels. */
const sansTexte = (source: string) => lexer(source, true);

/** Modules réseau de l'interface : clients de l'API et du proxy. */
const MODULE_RESEAU = /[\\/]web[\\/]lib[\\/]api(?:-[\w-]+)?\.ts$/;
/** Appels réseau directs ; un import dynamique pourrait charger un module réseau. */
const APPELS_RESEAU: ReadonlyArray<readonly [RegExp, string]> = [
  [/\bfetch\s*\(/, "fetch"],
  [/\bXMLHttpRequest\b/, "XMLHttpRequest"],
  [/\bEventSource\b/, "EventSource"],
  [/\bWebSocket\b/, "WebSocket"],
  [/\bsendBeacon\b/, "sendBeacon"],
  [/\bimport\s*\(/, "import dynamique"],
  [/\boc\.[a-zA-Z]/, "proxy oc"],
];

/** Un import de valeurs : le module cité et les noms qui y sont pris (« * » : l'export par défaut ou tout l'espace de noms). */
interface ImportDeValeur {
  specifier: string;
  noms: string[];
}

/** Imports de valeurs d'un module (les imports de types sont effacés à la compilation, ils ne chargent rien). */
function importsDeValeur(sansCommentaires: string): ImportDeValeur[] {
  const re = /^[ \t]*import\s+(type\s+)?(\{[^}]*\}|[^;\n]*?)\s*from\s*["']([^"']+)["']/gm;
  const out: ImportDeValeur[] = [];
  for (const m of sansCommentaires.matchAll(re)) {
    if (m[1]) continue;
    const clause = m[2] ?? "";
    const noms: string[] = [];
    // Nom par défaut ou espace de noms : tout le module est chargé, aucun nom ne peut être suivi un par un.
    if (/^[\w$]/.test(clause) || clause.includes("*")) noms.push("*");
    for (const element of (clause.match(/\{([\s\S]*)\}/)?.[1] ?? "").split(",")) {
      const nom = element.trim();
      // `{ type X }` : effacé à la compilation, comme `import type`.
      if (nom === "" || /^type\s/.test(nom)) continue;
      noms.push((nom.split(/\s+as\s+/)[0] ?? "").trim());
    }
    out.push({ specifier: m[3] ?? "", noms });
  }
  return out;
}

/**
 * Modules dont la pureté est déjà gardée ailleurs : l'examen n'y entre pas, mais il regarde QUELS noms y sont pris.
 * - « * » : tout le module est déjà gardé (DemoPlayer.tsx, gardé nom par nom par `demo-p1.test.ts`) ;
 * - une liste : ces noms-là seulement (turn.ts, dont seul `boundedAiText` est pris, et dont la pureté est prouvée ci-dessous).
 *   Tout autre nom pris dans un module borné est un problème : la borne ne couvre que ce qu'elle nomme.
 */
type Bornes = ReadonlyMap<string, "*" | ReadonlySet<string>>;

/** Suit les imports de valeurs depuis `entree`, de module en module, sans entrer dans les modules bornés, et rend les problèmes. */
export function examiner(entree: string, bornes: Bornes, lire2: (fichier: string) => string = (f) => fs.readFileSync(f, "utf8")): string[] {
  const problemes: string[] = [];
  const vus = new Set<string>();
  const file = [entree];
  while (file.length > 0) {
    const fichier = file.shift() ?? "";
    if (vus.has(fichier)) continue;
    vus.add(fichier);
    const cle = path.relative(APP_DIR, fichier).replaceAll("\\", "/");
    const source = lire2(fichier);
    for (const [motif, appel] of APPELS_RESEAU) if (motif.test(sansTexte(source))) problemes.push(`${cle} : ${appel}`);
    for (const { specifier, noms } of importsDeValeur(sansCommentaires(source))) {
      if (!specifier.startsWith(".") || !/\.tsx?$/.test(specifier)) continue;
      const cible = path.resolve(path.dirname(fichier), specifier);
      if (MODULE_RESEAU.test(cible)) {
        problemes.push(`${cle} : import réseau ${specifier}`);
        continue;
      }
      const borne = bornes.get(cible);
      if (borne === undefined) file.push(cible);
      else if (borne !== "*") for (const nom of noms) if (!borne.has(nom)) problemes.push(`${cle} : ${specifier} · nom hors borne ${nom}`);
    }
  }
  return [...new Set(problemes)].sort();
}

/**
 * Corps d'une fonction exportée de premier niveau, accolades comptées, commentaires et textes blanchis : de quoi prouver qu'une
 * fonction bornée ne fait rien d'autre que ce qu'elle dit.
 */
function corpsExporte(source: string, nom: string): string {
  const code = sansTexte(source);
  const debut = code.indexOf(`export function ${nom}(`);
  assert.ok(debut >= 0, `${nom} introuvable`);
  let profondeur = 0;
  for (let i = code.indexOf("{", debut); i < code.length; i++) {
    if (code[i] === "{") profondeur++;
    else if (code[i] === "}" && --profondeur === 0) return code.slice(debut, i + 1);
  }
  throw new Error(`fin de ${nom} introuvable`);
}

describe("TeamDemo : aucune requête (§6 l.1064)", () => {
  const bornes: Bornes = new Map<string, "*" | ReadonlySet<string>>([
    [DEMO_PLAYER, "*"],
    [TURN, new Set(["boundedAiText"])],
  ]);

  it("ni API, ni proxy, ni fetch, ni import dynamique : dans TeamDemo.tsx et dans les modules purs qu'il ajoute", () => {
    assert.deepEqual(examiner(TEAM_DEMO, bornes), []);
    const source = sansCommentaires(lire(TEAM_DEMO));
    assert.doesNotMatch(source, /from "[^"]*lib\/api/);
    // Le lecteur est bien celui de l'itération 1, dont la pureté est gardée par nom dans demo-p1.test.ts.
    assert.match(source, /import \{ DemoPlayer \} from "\.\.\/\.\.\/chat\/activity\/DemoPlayer\.tsx";/);
  });

  it("contrôles discriminants : import de l'API, fetch, proxy oc ou import dynamique ajoutés à TeamDemo.tsx sont vus", () => {
    const avec = (ajout: string) => (f: string) => {
      const source = fs.readFileSync(f, "utf8");
      return f === TEAM_DEMO ? source.replace("export function TeamDemo(", `${ajout}\nexport function TeamDemo(`) : source;
    };
    const importApi = 'import { oc } from "../../../lib/api.ts";\nconst lire = () => oc.messages("ses_x");\nvoid lire;';
    assert.deepEqual(examiner(TEAM_DEMO, bornes, avec(importApi)), [
      "web/pages/assistants/teams/TeamDemo.tsx : import réseau ../../../lib/api.ts",
      "web/pages/assistants/teams/TeamDemo.tsx : proxy oc",
    ]);
    assert.deepEqual(examiner(TEAM_DEMO, bornes, avec('const lire = () => fetch("/api/teams");')), ["web/pages/assistants/teams/TeamDemo.tsx : fetch"]);
    assert.deepEqual(examiner(TEAM_DEMO, bornes, avec('const charger = () => import("./TeamCard.tsx");')), ["web/pages/assistants/teams/TeamDemo.tsx : import dynamique"]);
    // Un commentaire ou un texte qui cite fetch( n'est pas un appel.
    assert.deepEqual(examiner(TEAM_DEMO, bornes, avec('// fetch("/x")\nconst note = "fetch(";')), []);
    // Contrôle du garde lui-même : sans les bornes, la bande du lecteur et turn.ts ramènent les clients de l'API.
    assert.ok(examiner(TEAM_DEMO, new Map()).some((probleme) => /import réseau/.test(probleme)));
  });

  it("borne turn.ts : seul `boundedAiText` en vient, et il ne fait que couper du texte", () => {
    // Les modèles purs de l'itération 4 que la démonstration réemploie (team-view-model.ts, deroule-model.ts) prennent
    // `boundedAiText` dans chat/turn.ts, qui importe par ailleurs le client de l'API pour ses propres crochets. La borne ne
    // couvre donc QUE ce nom, et sa pureté se prouve ici : son corps n'appelle rien et ne cite pas l'API.
    const corps = corpsExporte(lire(TURN), "boundedAiText");
    for (const [motif, appel] of APPELS_RESEAU) assert.doesNotMatch(corps, motif, appel);
    assert.doesNotMatch(corps, /\bapi\b|\boc\b/);
    // Contrôle discriminant : un autre nom pris dans turn.ts est vu, même s'il ne sert à rien.
    const autreNom = (f: string) => {
      const source = fs.readFileSync(f, "utf8");
      const ajout = 'import { useServerResolve } from "../../chat/turn.ts";\nvoid useServerResolve;\n';
      return f === TEAM_DEMO ? source.replace("export interface TeamDemoProps", `${ajout}export interface TeamDemoProps`) : source;
    };
    assert.deepEqual(examiner(TEAM_DEMO, bornes, autreNom), ["web/pages/assistants/teams/TeamDemo.tsx : ../../chat/turn.ts · nom hors borne useServerResolve"]);
    // Contrôle discriminant : la même borne passée en « * » laisserait passer ce nom — la précision de la borne est la garde.
    assert.deepEqual(examiner(TEAM_DEMO, new Map([...bornes, [TURN, "*" as const]]), autreNom), []);
  });
});

// --- Mode Simple : le bouton ne paraît pas tant que les équipes sont fermées -------------------------------------------------

const EQUIPE_VUE = {
  id: "equipe-1",
  titre: "Relecture croisée",
  description: "",
  forme: "avis" as const,
  etat: "ok" as const,
  layout: [],
  liste: [],
  estimate: null,
  dernierLancement: null,
  avance: false,
};

const reponse = (ouvertesEnSimple: boolean, avecEquipe: boolean): TeamsListResponse =>
  ({ teams: avecEquipe ? [EQUIPE_VUE] : [], exemples: [], ouvertesEnSimple }) as unknown as TeamsListResponse;

const onglet = (advanced: boolean, ouvertesEnSimple: boolean, avecEquipe = false) =>
  buildTeamsTab({ advanced, donnees: reponse(ouvertesEnSimple, avecEquipe), chargement: false, erreur: null, dateDe: () => "" });

describe("démonstration d'équipe : mode Simple fermé (U1, D-5-24)", () => {
  it("en Simple, tant que `ouvertesEnSimple` est faux, ni état vide ni galerie : le bouton n'a aucun endroit où paraître", () => {
    const ferme = onglet(false, false);
    assert.equal(ferme.affichage, "ferme");
    assert.equal(ferme.vide, null);
    assert.equal(ferme.galerie, null);
    // Contrôle discriminant : l'ouverture tient en UNE ligne, et alors les deux endroits existent.
    const ouvert = onglet(false, true);
    assert.notEqual(ouvert.vide, null);
    assert.notEqual(ouvert.galerie, null);
    // En Avancé, les équipes sont ouvertes quelle que soit la valeur.
    assert.notEqual(onglet(true, false).galerie, null);
  });

  it("le bouton n'est rendu QUE dans l'état vide et dans la galerie : aucune autre porte dans TeamsTab.tsx", () => {
    const source = sansTexte(lire(TEAMS_TAB));
    const libelle = /TEXTES_CONSTRUCTION\.partout\.demonstration\.voir/g;
    assert.equal([...source.matchAll(libelle)].length, 1, "le libellé apparaît une seule fois");
    const debutVide = source.indexOf("{modele.vide ? (");
    const finVide = source.indexOf("{modele.equipes.length > 0 ? (");
    const posLibelle = source.indexOf("TEXTES_CONSTRUCTION.partout.demonstration.voir");
    assert.ok(debutVide > 0 && finVide > debutVide);
    assert.ok(posLibelle > debutVide && posLibelle < finVide, "le bouton de l'état vide est sorti de son bloc");
    const debutGalerie = source.indexOf("{modele.galerie ? (");
    const posGalerie = source.indexOf("onDemonstration={");
    assert.ok(debutGalerie > 0 && posGalerie > debutGalerie);
    assert.ok(posGalerie < source.indexOf("<TeamInstallDialog"), "la galerie reçoit son rappel hors de son bloc");
    // La galerie ne montre le bouton que si elle reçoit le rappel.
    assert.match(sansTexte(lire(TEAM_GALLERY)), /\{onDemonstration \? \(/);
  });

  it("aucune constante propre au mode Simple des équipes n'est ajoutée (l'ouverture reste UNE ligne)", () => {
    for (const fichier of [TEAMS_TAB, TEAM_GALLERY, TEAM_DEMO]) {
      const source = sansTexte(lire(fichier));
      assert.doesNotMatch(source, /EQUIPES_SIMPLE_OUVERTES/, fichier);
      assert.doesNotMatch(source, /const\s+[A-Za-z_]*(?:SIMPLE|Simple|OUVERT|Ouvert)[A-Za-z_]*\s*=/, fichier);
    }
    // TeamDemo ne lit aucun réglage des équipes : c'est l'onglet qui décide de le monter.
    assert.doesNotMatch(sansTexte(lire(TEAM_DEMO)), /ouvertesEnSimple/);
    assert.doesNotMatch(sansTexte(lire(DEMO_PLAYER)), /ouvertesEnSimple/);
  });
});

// --- Mouvement réduit et textes ------------------------------------------------------------------------------------------------

describe("démonstration d'équipe : mouvement et textes (§5.5, §4.3)", () => {
  it("aucune lecture automatique, aucune minuterie, aucune animation dans le lecteur ni dans la démonstration", () => {
    for (const fichier of [TEAM_DEMO, DEMO_PLAYER]) {
      const source = sansTexte(lire(fichier));
      assert.doesNotMatch(source, /setInterval|setTimeout|requestAnimationFrame|\.animate\(|autoPlay|useEffect/, fichier);
    }
    // Contrôle discriminant : une minuterie ajoutée serait vue.
    assert.match(sansTexte(`${lire(TEAM_DEMO)}\nconst lecture = () => setInterval(() => 1, 1000);`), /setInterval/);
  });

  it("textes de la démonstration, à l'octet (§4.3) ; l'étiquette du lecteur est celle de la spéc. l.1013", () => {
    const T = TEXTES_CONSTRUCTION.partout.demonstration;
    assert.equal(T.titre, "Comment se déroule une équipe");
    assert.equal(T.etiquette, "Démonstration enregistrée : aucune IA n'est appelée");
    assert.equal(T.phrase, "Déroulé enregistré avec des données fictives.");
    assert.equal(T.voir, "Voir une démonstration");
    // Le lecteur nomme la boîte avec l'étiquette de l'itération 1 : les deux phrases sont la même, à l'octet.
    assert.equal(TEXTES_NEON.partout.demonstrationEnregistree, T.etiquette);
    // Les moments se disent « n / N » : le mot « étape » est réservé aux étapes d'une équipe.
    assert.equal(TEXTES_NEON.partout.lecteur.moment, "Moment {n} / {total}");
    for (const texte of Object.values(TEXTES_NEON.partout.lecteur)) assert.doesNotMatch(texte, /[ÉéEe]tape/);
  });

  it("TeamDemo n'écrit aucun texte : tout vient des modules de textes", () => {
    const code = sansTexte(lire(TEAM_DEMO));
    const source = lire(TEAM_DEMO);
    // Les chaînes du source qui portent une phrase (accent, ou deux mots) : aucune hors des commentaires.
    const phrases = [...code.matchAll(/(["'`])((?:(?!\1).)*)\1/g)].map((m) => m[2] ?? "");
    assert.deepEqual(phrases.filter((texte) => /[À-ÿ]|[A-Z][a-z]+ [a-z]/.test(texte)), []);
    const textesJsx = [...code.matchAll(/>([^<>{}\n]*\p{L}[^<>{}\n]*)</gu)].map((m) => (m[1] ?? "").trim()).filter((t) => t !== "" && !/^[\w.]+$/.test(t));
    assert.deepEqual(textesJsx, []);
    assert.match(source, /TEXTES\.partout\.demonstration/);
  });
});
