// Vue d'ensemble de la carte des assistants (1.1, itération 5b, L48 ; spécification §5.2 l.890, §5.5, §5.6 ; C §7.4, §9.9 ;
// plan d'exécution it5, fiche L48 et §4.3).
// Ce que ce fichier tient :
// - module pur : les cinq colonnes couvrent TOUS les genres de MAP_NODE_KINDS, chacun une seule fois, et les huit puces sont
//   celles du §4.3, dans son ordre ;
// - colonnes par genre sur la SORTIE RÉELLE de deriveAgentMap (fixture de l'itération 4, mêmes aides que agent-map.test.ts) :
//   les agents du Studio `primary` tombent avec les assistants, les `subagent` avec les sous-agents ;
// - filtres : chaque puce, éteinte, retire son genre ET les arêtes qui y mènent ; rallumée, elle reprend sa place ;
// - ensemble du focus : le focus et ses voisins ENTRANTS ET SORTANTS restent nets, tout le reste est estompé ; un focus absent,
//   inconnu ou masqué par une puce n'estompe rien ;
// - interface : en mode Simple la vue n'est JAMAIS proposée (ni bouton, ni bloc) ; sous 900 px la Liste reste le défaut ; un
//   vrai bouton par nœud ; Échap retire le focus ; connecteurs SVG décoratifs ; « (hors sujet) » pour le lecteur d'écran ;
//   noms techniques affichés ; aucun texte écrit hors des modules de textes ; aucun balisage injecté ;
// - feuille : bloc @media (forced-colors: active) non vide (exigé par le test de T4w), estompage par une opacité au-dessus de
//   0,8 DOUBLÉE de pointillés, aucune animation ni transition.
// Les contrôles discriminants font échouer chaque règle de lecture de source sur un source fabriqué.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import {
  type AgentMapInput,
  type AgentMapResult,
  deriveAgentMap,
  MAP_NODE_KINDS,
  MAP_VOUS_ID,
  type MapAgentInput,
  type MapNodeKind,
  mapNodeId,
} from "./shared/agent-map.ts";
import {
  OVERVIEW_COLUMN_GROUPS,
  OVERVIEW_COLUMNS,
  OVERVIEW_FILTERS,
  type OverviewColumnId,
  type OverviewLayout,
  overviewColumnOf,
  overviewLayout,
} from "./shared/agent-map-overview.ts";
import { assistantPermission, effectiveAgentRules, effectiveBuiltinRules, presetPermission } from "./shared/assistant-rules.ts";
import { TEXTES } from "./shared/construction-texts.ts";

const APP = path.join(import.meta.dirname, "..");
const CARTE = path.join(APP, "web", "pages", "assistants", "carte");
const lire = (relatif: string) => fs.readFileSync(path.join(CARTE, relatif), "utf8");
/** Commentaires retirés (positions gardées) : un texte en commentaire ne prouve jamais un comportement. */
const sansCommentaires = (texte: string) => texte.replace(/\/\*[\s\S]*?\*\//g, (bloc) => bloc.replace(/[^\n]/g, " ")).replace(/\/\/[^\n]*/g, "");
const V = TEXTES.avance.vueEnsemble;

const A = (name: string) => mapNodeId("agent", name);
const R = (name: string) => mapNodeId("raccourci", name);
const F = (name: string) => mapNodeId("fiche", name);
const E = (id: string) => mapNodeId("equipe", id);
const PRUDENT = presetPermission("prudent");

// --- Fixture de l'itération 4 ------------------------------------------------------------------------------------------------

const integre = (name: "build" | "plan"): MapAgentInput => ({
  name,
  mode: "primary",
  origine: "integre",
  titre: null,
  rules: effectiveBuiltinRules(name, PRUDENT),
});

const sousAgentIntegre = (name: string, own: Record<string, unknown> = {}): MapAgentInput => ({
  name,
  mode: "subagent",
  origine: "integre",
  rules: effectiveAgentRules(PRUDENT, own),
});

const assistant = (name: string, fiches: string[] = []): MapAgentInput => ({
  name,
  mode: "primary",
  origine: "assistant",
  titre: `Titre ${name}`,
  rules: effectiveAgentRules(PRUDENT, assistantPermission("lecture", false, fiches)),
  ia: { label: "IA de test", niveau: "equilibre", disponible: true },
  steps: 40,
});

const studio = (name: string, mode: MapAgentInput["mode"]): MapAgentInput => ({
  name,
  mode,
  origine: "studio",
  rules: effectiveAgentRules(PRUDENT, {}),
});

/**
 * Fixture de l'itération 4 : les quatre agents livrés sous le profil Prudent, deux assistants du cockpit, DEUX agents du Studio
 * (un `primary`, un `subagent`), un raccourci en sous-tâche, une fiche et une équipe de deux étapes. La carte est la SORTIE
 * RÉELLE de deriveAgentMap (L39a) : rien n'est écrit à la main ici.
 */
function fixture(partial: Partial<AgentMapInput> = {}): AgentMapResult {
  return deriveAgentMap({
    agents: [
      integre("build"),
      integre("plan"),
      sousAgentIntegre("general"),
      sousAgentIntegre("explore", { edit: "deny", bash: "deny" }),
      assistant("relire", ["revue-sql"]),
      assistant("ecrire"),
      studio("studio-primaire", "primary"),
      studio("studio-delegue", "subagent"),
    ],
    commands: [{ name: "resume", agent: "relire", subtask: true, titre: null, ia: null }],
    fiches: ["revue-sql"],
    equipes: [{ id: "revue", titre: "Revue SQL", etapes: [{ assistant: "relire", niveau: null }, { assistant: "ecrire", niveau: "rapide" }] }],
    subagentDepth: 2,
    mode: "avance",
    internes: [],
    ...partial,
  });
}

/** Identifiants montrés, colonne par colonne. */
function parColonne(layout: OverviewLayout): Array<[OverviewColumnId, string[]]> {
  return layout.colonnes.map((colonne) => [colonne.id, colonne.groupes.flatMap((groupe) => groupe.nodes.map((item) => item.node.id))]);
}

/** Identifiants estompés, dans l'ordre des colonnes. */
const estompes = (layout: OverviewLayout): string[] =>
  layout.colonnes.flatMap((colonne) => colonne.groupes.flatMap((groupe) => groupe.nodes.filter((item) => item.estompe).map((item) => item.node.id)));

/** Identifiants montrés, dans l'ordre des colonnes. */
const montres = (layout: OverviewLayout): string[] =>
  layout.colonnes.flatMap((colonne) => colonne.groupes.flatMap((groupe) => groupe.nodes.map((item) => item.node.id)));

// --- Module pur ---------------------------------------------------------------------------------------------------------------

describe("vue d'ensemble : colonnes et puces (listes fermées)", () => {
  it("cinq colonnes qui rangent CHAQUE genre de MAP_NODE_KINDS une seule fois", () => {
    assert.deepEqual([...OVERVIEW_COLUMNS], ["vous", "raccourcis", "assistants", "sous-agents", "fiches"]);
    const ranges = OVERVIEW_COLUMNS.flatMap((id) => OVERVIEW_COLUMN_GROUPS[id]);
    assert.deepEqual([...ranges].sort(), [...MAP_NODE_KINDS].sort(), "tous les genres rangés, aucun en double");
    assert.equal(new Set(ranges).size, ranges.length);
    for (const kind of MAP_NODE_KINDS) assert.notEqual(overviewColumnOf(kind), null, kind);
    // Les agents du Studio `primary` tombent avec les assistants, les `subagent` avec les sous-agents (kindOf de L39a).
    assert.equal(overviewColumnOf("agent-studio"), "assistants");
    assert.equal(overviewColumnOf("sous-agent"), "sous-agents");
    assert.equal(overviewColumnOf("integre"), "assistants");
    assert.equal(overviewColumnOf("equipe"), "raccourcis");
  });

  it("huit puces, dans l'ordre du §4.3, une par groupe, avec le libellé de construction-texts.ts", () => {
    assert.deepEqual([...OVERVIEW_FILTERS], ["vous", "raccourci", "equipe", "assistant", "integre", "agent-studio", "sous-agent", "fiche"]);
    assert.deepEqual(
      [V.vous, V.raccourcis, V.equipes, V.assistants, V.integres, V.agentsStudio, V.sousAgents, V.fiches],
      ["Vous", "Raccourcis", "Équipes", "Assistants", "Intégrés", "Agents du Studio", "Sous-agents", "Fiches"],
    );
    assert.equal(V.titre, "Vue d'ensemble");
    assert.equal(V.aide, "Survolez ou sélectionnez un élément pour n'afficher que ses liens.");
    assert.equal(V.horsSujet, "(hors sujet)");
  });
});

describe("vue d'ensemble : colonnes par genre sur la sortie réelle de deriveAgentMap", () => {
  it("chaque nœud de la carte de l'it4 tombe dans sa colonne, dans l'ordre des nœuds", () => {
    const layout = overviewLayout(fixture());
    // Les assistants intégrés d'opencode gardent le genre `integre` même quand ils ne tournent que délégués (kindOf de L39a) :
    // ils restent donc avec les assistants. La colonne des sous-agents porte le genre `sous-agent`, agents du Studio compris.
    assert.deepEqual(parColonne(layout), [
      ["vous", [MAP_VOUS_ID]],
      ["raccourcis", [R("resume"), E("revue")]],
      ["assistants", [A("ecrire"), A("relire"), A("build"), A("explore"), A("general"), A("plan"), A("studio-primaire")]],
      ["sous-agents", [A("studio-delegue")]],
      ["fiches", [F("revue-sql")]],
    ]);
    // Rien n'est perdu : tous les nœuds de la carte sont rangés, et aucun n'est inventé.
    assert.deepEqual(montres(layout).sort(), fixture().nodes.map((node) => node.id).sort());
  });

  it("chaque groupe porte son genre, et une colonne ou un groupe sans nœud n'est pas rendu", () => {
    const layout = overviewLayout(fixture());
    const groupes = layout.colonnes.flatMap((colonne) => colonne.groupes.map((groupe) => [colonne.id, groupe.kind] as const));
    assert.deepEqual(groupes, [
      ["vous", "vous"],
      ["raccourcis", "raccourci"],
      ["raccourcis", "equipe"],
      ["assistants", "assistant"],
      ["assistants", "integre"],
      ["assistants", "agent-studio"],
      ["sous-agents", "sous-agent"],
      ["fiches", "fiche"],
    ]);
    for (const colonne of layout.colonnes) for (const groupe of colonne.groupes) assert.ok(groupe.nodes.length > 0, `${colonne.id}/${groupe.kind}`);
    // Carte sans fiche ni équipe : la colonne des fiches disparaît, celle des raccourcis garde le seul raccourci.
    const sansFiche = overviewLayout(fixture({ fiches: [], equipes: [] }));
    assert.deepEqual(
      sansFiche.colonnes.map((colonne) => colonne.id),
      ["vous", "raccourcis", "assistants", "sous-agents"],
    );
    assert.deepEqual(parColonne(sansFiche)[1], ["raccourcis", [R("resume")]]);
  });

  it("arêtes visibles : celles de la carte, dans son ordre, avec leurs deux bouts et leurs colonnes", () => {
    const carte = fixture();
    const layout = overviewLayout(carte);
    assert.deepEqual(
      layout.aretes.map((lien) => [lien.edge.from, lien.edge.to]),
      carte.edges.map((edge) => [edge.from, edge.to]),
    );
    const etape = layout.aretes.find((lien) => lien.edge.kind === "etape" && lien.edge.to === A("relire"));
    assert.ok(etape, "arête d'étape vers « relire » présente");
    assert.equal(etape.de, "raccourcis");
    assert.equal(etape.vers, "assistants");
    assert.equal(etape.source.id, E("revue"));
    assert.equal(etape.cible.id, A("relire"));
    assert.equal(etape.estompe, false, "sans focus, rien n'est estompé");
  });
});

describe("vue d'ensemble : puces de filtre", () => {
  it("chaque puce éteinte retire ses nœuds et les arêtes qui y touchent", () => {
    const carte = fixture();
    const complet = overviewLayout(carte);
    for (const puce of OVERVIEW_FILTERS) {
      const sans = overviewLayout(carte, { filtres: OVERVIEW_FILTERS.filter((autre) => autre !== puce) });
      const retires = carte.nodes.filter((node) => node.kind === puce).map((node) => node.id);
      assert.ok(retires.length > 0, `la fixture a un nœud de genre ${puce}`);
      for (const id of retires) assert.ok(!montres(sans).includes(id), `${puce} : ${id} encore montré`);
      assert.deepEqual(
        montres(sans),
        montres(complet).filter((id) => !retires.includes(id)),
        puce,
      );
      const survivantes = sans.aretes.filter((lien) => retires.includes(lien.edge.from) || retires.includes(lien.edge.to));
      assert.deepEqual(survivantes, [], `${puce} : arêtes vers un nœud masqué`);
      assert.ok(sans.aretes.length < complet.aretes.length, `${puce} : au moins une arête retirée`);
    }
  });

  it("aucune puce allumée : plus rien ; toutes allumées : la carte entière", () => {
    const carte = fixture();
    const vide = overviewLayout(carte, { filtres: [] });
    assert.deepEqual(vide.colonnes, []);
    assert.deepEqual(vide.aretes, []);
    assert.deepEqual(montres(overviewLayout(carte, { filtres: OVERVIEW_FILTERS })), montres(overviewLayout(carte)));
  });
});

describe("vue d'ensemble : ensemble du focus", () => {
  it("le focus, ses voisins ENTRANTS et SORTANTS restent nets ; tout le reste est estompé", () => {
    const carte = fixture();
    const layout = overviewLayout(carte, { focus: A("relire") });
    assert.equal(layout.focus, A("relire"));
    const entrants = carte.edges.filter((edge) => edge.to === A("relire")).map((edge) => edge.from);
    const sortants = carte.edges.filter((edge) => edge.from === A("relire")).map((edge) => edge.to);
    assert.ok(entrants.length > 0 && sortants.length > 0, "la fixture a des voisins des deux côtés");
    const attendu = new Set([A("relire"), ...entrants, ...sortants]);
    assert.deepEqual(new Set(layout.ensemble), attendu);
    assert.deepEqual(
      estompes(layout).sort(),
      montres(layout)
        .filter((id) => !attendu.has(id))
        .sort(),
    );
    // Voisins des deux sens, nommément : Vous et le raccourci font travailler « relire », qui consulte la fiche.
    for (const id of [MAP_VOUS_ID, R("resume"), E("revue"), F("revue-sql")]) assert.ok(attendu.has(id), id);
    // Un nœud sans lien avec le focus est bien estompé.
    assert.ok(estompes(layout).includes(A("ecrire")) || !montres(layout).includes(A("ecrire")));
  });

  it("une arête est estompée dès qu'elle ne touche pas le focus ; aucun nœud n'est retiré par le focus", () => {
    const layout = overviewLayout(fixture(), { focus: A("relire") });
    for (const lien of layout.aretes) {
      assert.equal(lien.estompe, lien.edge.from !== A("relire") && lien.edge.to !== A("relire"), `${lien.edge.from} → ${lien.edge.to}`);
    }
    assert.ok(layout.aretes.some((lien) => !lien.estompe) && layout.aretes.some((lien) => lien.estompe));
    assert.deepEqual(montres(layout), montres(overviewLayout(fixture())), "le focus n'enlève aucun nœud");
  });

  it("focus absent, inconnu ou masqué par une puce : rien n'est estompé", () => {
    const carte = fixture();
    for (const options of [{}, { focus: null }, { focus: "agent:inconnu" }, { focus: "" }]) {
      const layout = overviewLayout(carte, options);
      assert.equal(layout.focus, null, JSON.stringify(options));
      assert.deepEqual(estompes(layout), [], JSON.stringify(options));
      assert.deepEqual(layout.ensemble, []);
      assert.deepEqual(
        layout.aretes.filter((lien) => lien.estompe),
        [],
      );
    }
    const masque = overviewLayout(carte, { focus: F("revue-sql"), filtres: OVERVIEW_FILTERS.filter((kind) => kind !== "fiche") });
    assert.equal(masque.focus, null);
    assert.deepEqual(estompes(masque), []);
  });

  it("focus sur un nœud sans aucun lien visible : lui seul reste net", () => {
    const carte = fixture();
    const layout = overviewLayout(carte, { focus: F("revue-sql"), filtres: ["fiche", "vous"] });
    assert.deepEqual(layout.ensemble, [F("revue-sql")]);
    assert.deepEqual(estompes(layout), [MAP_VOUS_ID]);
  });
});

// --- Interface ------------------------------------------------------------------------------------------------------------------

describe("vue d'ensemble : l'interface ne la propose jamais en mode Simple", () => {
  const tab = lire("CarteTab.tsx");
  const code = sansCommentaires(tab);

  it("bouton et bloc rendus sous `advanced` seulement, et la vue montrée retombe sur Centrée hors Avancé", () => {
    assert.match(code, /\{advanced \? \(\s*<button type="button" className="btn" aria-pressed=\{vue === "ensemble"\} onClick=\{\(\) => setVue\("ensemble"\)\}>/);
    assert.match(code, /\{advanced \? \(\s*<div className="ca-bloc-ensemble">\s*<OverviewMap result=\{data\} advanced=\{advanced\} element=\{montre\} \/>/);
    assert.match(code, /const vue: Vue = vueChoisie === "ensemble" && !advanced \? "centree" : vueChoisie;/);
    // Aucune constante ni réglage propre à la vue : le mode suffit (U1 n'ouvre rien ici).
    assert.equal(/VUE_ENSEMBLE_OUVERTE|ENSEMBLE_SIMPLE/.test(code), false);
  });

  // Les motifs ci-dessous écrivent « <[c]5: » et « <\/c5: » : sans cela, le test des balises verrait ici des balises mal
  // formées (construction-balises.test.ts emploie la même précaution pour se citer lui-même).
  it("la modification de l'onglet tient dans la section c5:vue-ensemble, toutes balises appariées", () => {
    const ouvertes = [...tab.matchAll(/<[c]5:([\w-]+)>/g)].map((m) => m[1]);
    const fermees = [...tab.matchAll(/<\/c5:([\w-]+)>/g)].map((m) => m[1]);
    assert.deepEqual(new Set(ouvertes), new Set(["vue-ensemble"]), "une seule section nommée");
    assert.deepEqual(ouvertes, fermees);
    assert.ok(ouvertes.length >= 4, `${ouvertes.length} blocs balisés`);
    // Hors de ces sections, le mot « ensemble » n'apparaît plus : tout l'ajout de L48 y est.
    const dehors = tab.replace(/(\/\/|\{\/\*) <[c]5:vue-ensemble>[\s\S]*?<\/c5:vue-ensemble>( \*\/\})?/g, "");
    assert.equal(/ensemble/i.test(sansCommentaires(dehors)), false);
  });

  it("contrôle discriminant : un bouton rendu sans `advanced` ferait échouer la garde", () => {
    const mute = code.replace(
      /\{advanced \? \(\s*<button type="button" className="btn" aria-pressed=\{vue === "ensemble"\}/,
      '<button type="button" className="btn" aria-pressed={vue === "ensemble"}',
    );
    assert.notEqual(mute, code);
    assert.doesNotMatch(mute, /\{advanced \? \(\s*<button type="button" className="btn" aria-pressed=\{vue === "ensemble"\}/);
  });
});

describe("vue d'ensemble : composant", () => {
  const source = lire("OverviewMap.tsx");
  const code = sansCommentaires(source);

  it("un VRAI bouton par nœud et par puce, Entrée par le bouton, Échap qui retire le focus", () => {
    assert.match(code, /<button\s+type="button"\s+className=\{`ov-noeud\$\{item\.estompe \? " estompe" : ""\}`\}/);
    assert.match(code, /aria-pressed=\{focus === item\.node\.id\}/);
    assert.match(code, /className="btn sm ghost ov-puce" aria-pressed=\{filtres\.includes\(kind\)\}/);
    assert.match(code, /if \(event\.key !== "Escape" \|\| layout\.focus === null\) return;/);
    assert.match(code, /setChoisi\(null\);\s*setSurvol\(null\);/);
    // Aucun faux bouton, aucun raccourci à une touche en dehors de la vue, aucun focus pris (§5.5).
    assert.equal(/role="button"|tabIndex|autoFocus|\.focus\(/.test(code), false);
    assert.equal(/addEventListener|document\./.test(code), false);
  });

  it("connecteurs SVG décoratifs, et chaque lien repris EN TEXTE par lienDe (jamais phraseArete en direct)", () => {
    for (const balise of code.match(/<svg[^>]*>/g) ?? []) {
      assert.match(balise, /aria-hidden="true"/, balise);
      assert.match(balise, /focusable="false"/, balise);
    }
    assert.ok((code.match(/<svg[^>]*>/g) ?? []).length > 0, "au moins un connecteur");
    assert.match(code, /layout\.aretes\.map\(/);
    assert.match(code, /const lien = lienDe\(arete\.edge, arete\.source, arete\.cible, arete\.cible, advanced\);/);
    assert.match(code, /<span className="ca-lien-phrase">\{lien\.phrase\}<\/span>/);
    assert.match(code, /<span className="ca-lien-applique">\{lien\.appliquePar\}<\/span>/);
    // Garde de L39b : aucune vue du dossier n'appelle phraseArete elle-même, pour ne jamais oublier edge.kind.
    assert.equal(/\bphraseArete\s*\(/.test(code), false);
    // Le mot du trait reste celui de la vue Liste (défaut D4 de l'it4 : jamais répété quand il redit qui applique le lien).
    assert.match(code, /\{lien\.mot === null \? null : <span className="ca-lien-mot">\{lien\.mot\}<\/span>\}/);
  });

  it("carte-model.ts : `export` de lienDe, seule modification, en section c5:vue-ensemble", () => {
    const modele = lire("carte-model.ts");
    assert.match(modele, /export function lienDe\(edge: MapEdge, source: MapNode, cible: MapNode, autre: MapNode, avance: boolean\): CarteLien \{/);
    const ouvertes = [...modele.matchAll(/<[c]5:([\w-]+)>/g)].map((m) => m[1]);
    assert.deepEqual(ouvertes, ["vue-ensemble"]);
    assert.deepEqual([...modele.matchAll(/<\/c5:([\w-]+)>/g)].map((m) => m[1]), ["vue-ensemble"]);
    assert.equal((modele.split("\n")[0] ?? "").replace(/\r$/, ""), "// Propriétaire : L39b.");
  });

  it("estompage : « (hors sujet) » pour le lecteur d'écran sur les nœuds ET sur les liens, jamais un retrait", () => {
    assert.equal((code.match(/<span className="visually-hidden">\{V\.horsSujet\}<\/span>/g) ?? []).length, 2);
    assert.match(code, /\{item\.estompe \? <span className="visually-hidden">/);
    assert.match(code, /\{arete\.estompe \? <span className="visually-hidden">/);
    assert.equal(/hidden=|aria-hidden=\{/.test(code.replace(/<svg[^>]*>/g, "")), false, "aucun nœud retiré de l'arbre d'accessibilité");
  });

  it("noms techniques affichés, et aucun texte n'est écrit ici : tout vient des modules de textes", () => {
    assert.match(code, /const technique = item\.node\.name === affiche \|\| item\.node\.kind === "vous" \? null : item\.node\.name;/);
    assert.match(code, /<span className="ov-noeud-technique">\{technique\}<\/span>/);
    // Chemins d'import mis de côté (« ./CarteListe.tsx » n'est pas un texte affiché) : seuls les littéraux du corps comptent.
    const corps = code.replace(/^\s*import[^\n]*$/gm, "");
    const literals = [...corps.matchAll(/"([^"\n]*)"/g)].map((m) => m[1] ?? "").filter((s) => /[A-ZÀ-Ý][a-zà-ÿ]|[À-ÿ]/.test(s));
    assert.deepEqual([...new Set(literals)].sort(), ["Escape"]);
    assert.doesNotMatch(code, />[ \t]*[\p{L}][^<{}\n]*<\//u);
    // Échappement : rien n'est injecté comme balisage (noms venus d'un fichier d'agent ou d'opencode).
    assert.equal(/dangerouslySetInnerHTML|innerHTML/.test(code), false);
  });

  it("propriétaire, feuille importée, et aucune dépendance nouvelle (P8)", () => {
    assert.equal((source.split("\n")[0] ?? "").replace(/\r$/, ""), "// Propriétaire : L48.");
    assert.match(code, /import "\.\/overview\.css";/);
    const imports = [...code.matchAll(/\bfrom\s*["']([^"']+)["']/g)].map((m) => m[1] ?? "");
    for (const spec of imports) assert.ok(spec === "react" || spec.startsWith("./") || spec.startsWith("../"), spec);
  });

  it("contrôle discriminant : un connecteur lisible ou un texte écrit sur place ferait échouer les gardes", () => {
    const svg = '<svg className="ov-connecteur" role="presentation"><path d="M1 12h18" /></svg>';
    assert.doesNotMatch(svg, /aria-hidden="true"/);
    const ecrit = 'const titre = "Vue d\'ensemble";';
    const trouves = [...ecrit.matchAll(/"([^"\n]*)"/g)].map((m) => m[1] ?? "").filter((s) => /[A-ZÀ-Ý][a-zà-ÿ]|[À-ÿ]/.test(s));
    assert.deepEqual(trouves, ["Vue d'ensemble"]);
  });
});

describe("vue d'ensemble : feuille de style", () => {
  const css = lire("overview.css");
  const nu = css.replace(/\/\*[\s\S]*?\*\//g, "");

  it("sous 900 px, la LISTE reste le défaut : les colonnes n'apparaissent qu'à partir de 900 px", () => {
    assert.match(nu, /\.ca-bloc-ensemble \{\s*display: none;\s*\}/);
    const large = nu.slice(nu.indexOf("@media (min-width: 900px)"));
    assert.ok(nu.includes("@media (min-width: 900px)"), "bascule à 900 px");
    assert.match(large, /\.ca-vues\.vue-ensemble \.ca-bloc-ensemble \{\s*display: block;\s*\}/);
    // La liste reste lue par le lecteur d'écran quand la vue d'ensemble prend la place (U11).
    assert.match(large, /\.ca-vues\.vue-ensemble \.ca-bloc-liste \{[^}]*position: absolute;/);
    // Aucune règle ne montre les colonnes hors de la requête large.
    assert.equal(nu.slice(0, nu.indexOf("@media (min-width: 900px)")).includes(".ca-bloc-ensemble {\n  display: block"), false);
  });

  it("estompage par une opacité qui garde le contraste, et un nœud estompé en pointillés", () => {
    const regle = /\.ov-noeud\.estompe,\s*\.ov-lien\.estompe \{\s*opacity: ([\d.]+);\s*\}/.exec(nu);
    assert.ok(regle, "règle d'estompage présente");
    assert.ok(Number(regle[1]) >= 0.8, `opacité ${regle[1]} : contraste ≥ 4,5:1 exigé (§5.5)`);
    assert.match(nu, /\.ov-noeud\.estompe \{\s*border-style: dotted;\s*\}/);
    // La forme du trait d'un lien (plein, pointillés, tirets) dit qui l'applique : l'estompage ne l'écrase jamais.
    assert.equal(/\.ov-lien\.estompe \{[^}]*border-style/.test(nu), false);
  });

  it("bloc @media (forced-colors: active) non vide (test de T4w), avec CanvasText, pointillés et focus Highlight", () => {
    const debut = nu.indexOf("@media (forced-colors: active)");
    assert.ok(debut > 0, "bloc de contraste forcé présent");
    const bloc = nu.slice(debut);
    assert.match(bloc, /\.ov-connecteur-trait,\s*\n\s*\.ov-connecteur-pointe \{\s*\n\s*stroke: CanvasText;/);
    assert.match(bloc, /\.ov-noeud\.estompe \{\s*\n\s*border-style: dotted;/);
    assert.match(bloc, /outline: 2px solid Highlight;/);
    assert.match(bloc, /border: 1px solid CanvasText;/);
  });

  it("aucune animation ni transition déclarée (web-animations) et aucune bibliothèque de dessin", () => {
    assert.equal(/\banimation\b|\btransition\b|\binfinite\b/.test(nu), false);
    assert.equal(/@import|url\(/.test(nu), false);
  });
});
