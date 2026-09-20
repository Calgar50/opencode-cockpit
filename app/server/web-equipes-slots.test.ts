// Emplacements web des équipes et de la carte des assistants (1.1, itération 4, T4w ; plan it4 §4.2, §2.6, §2.7 ; spécification
// §5.2, §5.3, §5.5 l.922, §5.6 ; C §9.4, §9.8). Lecture des sources de l'interface, sans navigateur ni dépendance, et routes :
// - chat/team/slots.ts : types seulement, en types primitifs, sans aucun import (jamais team-types), propriétés figées ;
// - squelettes : « Propriétaire : Lxx » en première ligne, composant et type de propriétés gardés ; tant que le fichier se dit
//   « Squelette T4w », il rend null ;
// - branchements des fichiers partagés (ChatPage, Composer, AssistantsPage, router, Deroule, BudgetTab, web-animations.test.ts)
//   entre les balises « équipes (it4) », appariées, et à leur place ;
// - routes de la page Assistants (assistantsViewOf, assistantsHref) : cas valides, identifiant invalide ou trop long → vue par
//   défaut ; élément de la carte = identifiant de nœud (C §9.8 element=<id>, mapNodeId de L39a ; correction du train de V0) ;
//   onglets ;
// - onglets « Assistants · Équipes · Carte » : motif APG, position annoncée, focus jamais pris, libellés seuls textes, onglet actif
//   marqué par une bordure (jamais par la couleur seule) ;
// - contraste forcé (U9) : un bloc @media (forced-colors: active) non vide dans chaque feuille des périmètres des équipes et de la
//   carte (chat/team/**, assistants/teams/**, assistants/carte/**, assistants/assistants-tabs.css, settings/TeamsBudgetSettings*),
//   y compris les feuilles ajoutées par les vagues suivantes.
// Commentaires ignorés là où ils pourraient tromper. Les contrôles discriminants font échouer chaque règle sur un source fabriqué.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import {
  ASSISTANTS_TABS,
  type AssistantsView,
  assistantsHref,
  assistantsTabHref,
  assistantsTabOf,
  assistantsViewOf,
  parseRoute,
  parseRouteQuery,
} from "../web/lib/router.ts";

const APP_DIR = path.join(import.meta.dirname, "..");
const WEB_DIR = path.join(APP_DIR, "web");

/** Source d'un fichier, chemin relatif au dossier app (séparateur « / »). */
const read = (fichier: string) => fs.readFileSync(path.join(APP_DIR, fichier), "utf8");
const lineAt = (text: string, index: number) => text.slice(0, index).split("\n").length;
const blank = (text: string) => text.replace(/[^\n]/g, " ");
/** Commentaires /* … *\/ et // … retirés (positions gardées) ; suffisant pour les sources lues ici (aucune URL dans les chaînes). */
const withoutComments = (text: string) => text.replace(/\/\*[\s\S]*?\*\//g, blank).replace(/\/\/[^\n]*/g, blank);

// --- Balises ------------------------------------------------------------------------------------------------------------------

/** Balises exactes (plan it4 §2.7) : TypeScript (aussi dans une liste d'attributs JSX), JSX, CSS. */
const MARKER = /(\{\/\*|\/\*|\/\/) --- équipes \(it4\) : (début|fin) ---( \*\/\}| \*\/)?/g;

interface MarkedSource {
  /** Contenu de chaque bloc balisé (entre ses deux balises). */
  blocs: string[];
  /** Source dont les blocs balisés (balises comprises) sont effacés, lignes gardées. */
  dehors: string;
  problemes: string[];
}

function marked(texte: string): MarkedSource {
  const problemes: string[] = [];
  const blocs: string[] = [];
  const ranges: Array<[number, number]> = [];
  let open: { start: number; after: number } | null = null;
  for (const match of texte.matchAll(MARKER)) {
    const [whole, opener, kind, closer = ""] = match;
    const index = match.index ?? 0;
    const form = (opener === "{/*" && closer === " */}") || (opener === "/*" && closer === " */") || (opener === "//" && closer === "");
    if (!form) problemes.push(`balise mal formée (ligne ${lineAt(texte, index)})`);
    if (kind === "début") {
      if (open) problemes.push(`balise « début » dans un bloc déjà ouvert (ligne ${lineAt(texte, index)})`);
      open = { start: index, after: index + whole.length };
    } else if (!open) {
      problemes.push(`balise « fin » sans « début » (ligne ${lineAt(texte, index)})`);
    } else {
      blocs.push(texte.slice(open.after, index));
      ranges.push([open.start, index + whole.length]);
      open = null;
    }
  }
  if (open) problemes.push(`balise « début » sans « fin » (ligne ${lineAt(texte, open.start)})`);
  let dehors = texte;
  for (const [start, end] of ranges) dehors = dehors.slice(0, start) + blank(dehors.slice(start, end)) + dehors.slice(end);
  return { blocs, dehors, problemes };
}

/** Chaque motif attendu (sans drapeau g) est présent dans un bloc balisé et absent hors des blocs ; balises appariées. */
function checkBranchements(fichier: string, texte: string, attendus: readonly RegExp[]): string[] {
  const { blocs, dehors, problemes } = marked(texte);
  const out = problemes.map((p) => `${fichier} : ${p}`);
  if (blocs.length === 0) out.push(`${fichier} : aucun bloc balisé`);
  for (const re of attendus) {
    if (re.test(dehors)) out.push(`${fichier} : ${re} hors des balises (ligne ${lineAt(dehors, dehors.search(re))})`);
    if (!blocs.some((bloc) => re.test(bloc))) out.push(`${fichier} : ${re} absent des blocs balisés`);
  }
  return out;
}

/** Branchements de T4w dans les fichiers partagés : ce qui ne doit exister qu'entre les balises. */
const BRANCHEMENTS: Readonly<Record<string, readonly RegExp[]>> = {
  "web/pages/ChatPage.tsx": [
    /\bTeamLauncher\b/,
    /\bTeamRunCards\b/,
    /\bteamLock\b/,
    /\bsetTeamLock\b/,
    /\bonTeamLock\b/,
    /\bteamLockProps\b/,
    /\bComposerDraftHandle\b/,
    /\bcomposerDraft\b/,
    /\bdraftHandle=/,
    /\bteam=\{/,
    /\bTeamDraft\b/,
    /chat\/team\//,
  ],
  "web/pages/chat/Composer.tsx": [
    /\bteam\b/,
    /\bdraftHandle\b/,
    /\buseImperativeHandle\b/,
    /\bComposerDraftHandle\b/,
    /\bTeamDraft\b/,
    /\bteamDraftOf\b/,
    /team\/slots\.ts/,
  ],
  "web/pages/AssistantsPage.tsx": [
    /\bAssistantsTabs\b/,
    /\bAssistantsTabsPage\b/,
    /\bTeamsTab\b/,
    /\bTeamEditor\b/,
    /\bCarteTab\b/,
    /\buseRouteQuery\b/,
    /\bteamView\b/,
  ],
  "web/lib/router.ts": [
    /"equipes"/,
    /"equipe-nouvelle"/,
    /"equipe-modifier"/,
    /"carte"/,
    /\bCARTE_ELEMENT_PARAM\b/,
    /\bASSISTANTS_TABS\b/,
    /\bassistantsTabOf\b/,
    /\bassistantsTabHref\b/,
    /\bteamsViewOf\b/,
    /\[a-z0-9-\]\{1,40\}/,
    /\bCARTE_ELEMENT_ID\b/,
  ],
  "web/pages/chat/activity/Deroule.tsx": [/\bTeamDeroule\b/],
  "web/pages/settings/BudgetTab.tsx": [/\bTeamsBudgetSettings\b/],
  "server/web-animations.test.ts": [/pages\/chat\/team\b/, /pages\/assistants\/teams\b/, /pages\/assistants\/carte\b/, /assistants-tabs\.css/, /\bSCOPE_FILES\b/],
};

describe("emplacements des équipes : balises (contrôles discriminants)", () => {
  it("balises des trois formes reconnues ; motif hors balises, absent, balises non appariées ou mal formées refusés", () => {
    const ok = [
      "import { A } from \"./a.ts\";\n// --- équipes (it4) : début ---\nimport { TeamX } from \"./x.ts\";\n// --- équipes (it4) : fin ---",
      "<div>\n{/* --- équipes (it4) : début --- */}\n<TeamX />\n{/* --- équipes (it4) : fin --- */}\n</div>",
      "<A\n  b={1}\n  // --- équipes (it4) : début ---\n  x={<TeamX />}\n  // --- équipes (it4) : fin ---\n/>",
      ".a {}\n/* --- équipes (it4) : début --- */\n.TeamX {}\n/* --- équipes (it4) : fin --- */",
    ];
    for (const texte of ok) assert.deepEqual(checkBranchements("f", texte, [/TeamX/]), [], texte);
    const bad: Array<[string, string]> = [
      ["import { TeamX } from \"./x.ts\";\n// --- équipes (it4) : début ---\nconst y = 1;\n// --- équipes (it4) : fin ---", "hors des balises"],
      ["// --- équipes (it4) : début ---\nconst y = 1;\n// --- équipes (it4) : fin ---", "absent des blocs"],
      ["// --- équipes (it4) : début ---\nconst TeamX = 1;", "sans « fin »"],
      ["const TeamX = 1;\n// --- équipes (it4) : fin ---", "sans « début »"],
      ["// --- équipes (it4) : début ---\n// --- équipes (it4) : début ---\nTeamX\n// --- équipes (it4) : fin ---", "déjà ouvert"],
      ["{/* --- équipes (it4) : début --- */\nTeamX\n{/* --- équipes (it4) : fin --- */}", "mal formée"],
      ["const TeamX = 1;", "aucun bloc"],
    ];
    for (const [texte, attendu] of bad) {
      const problems = checkBranchements("f", texte, [/TeamX/]);
      assert.ok(problems.some((p) => p.includes(attendu)), `${attendu} : ${JSON.stringify(problems)}`);
    }
  });
});

describe("emplacements des équipes : branchements des fichiers partagés", () => {
  for (const [fichier, attendus] of Object.entries(BRANCHEMENTS)) {
    it(`${fichier} : branchements entre les balises « équipes (it4) »`, () => {
      assert.deepEqual(checkBranchements(fichier, read(fichier), attendus), []);
    });
  }

  it("ChatPage : verrou remis à null à chaque changement de conversation, avec l'état de l'arbre", () => {
    assert.match(
      read("web/pages/ChatPage.tsx"),
      /setTreeWorking\(false\);\s*\/\/ --- équipes \(it4\) : début ---\s*setTeamLock\(null\);\s*\/\/ --- équipes \(it4\) : fin ---/,
    );
  });

  it("ChatPage : verrou non nul → saisie désactivée, texte du verrou en invite, « Arrêter » affiché ; posé après les valeurs 1.1", () => {
    const chat = read("web/pages/ChatPage.tsx");
    assert.match(chat, /teamLock === null \? \{\} : \{ disabled: true, placeholder: teamLock, stopVisible: true \}/);
    const composer = chat.indexOf("<Composer\n");
    const placeholder = chat.indexOf("placeholder={boot.models.length === 0", composer);
    const stopVisible = chat.indexOf("stopVisible={Boolean(sessionId) && treeWorking}", composer);
    const spread = chat.indexOf("{...teamLockProps}", composer);
    assert.ok(composer > 0 && placeholder > composer && stopVisible > composer, "saisie et valeurs 1.1 trouvées");
    assert.ok(spread > placeholder && spread > stopVisible, "le verrou passe après placeholder et stopVisible (il les remplace)");
    assert.match(chat.slice(spread), /^\{\.\.\.teamLockProps\}\s*\/\/ --- équipes \(it4\) : fin ---\s*\/>/);
  });

  it("ChatPage : lanceur dans la saisie ; cartes après la carte de plan, une instance par conversation, verrou relié", () => {
    const chat = read("web/pages/ChatPage.tsx");
    assert.match(chat, /team=\{\s*<TeamLauncher\b[\s\S]*?getDraft=\{getTeamDraft\}[\s\S]*?clearDraft=\{clearTeamDraft\}[\s\S]*?\/>\s*\}\s*draftHandle=\{composerDraft\}/);
    assert.match(chat, /busy=\{busy \|\| \(Boolean\(sessionId\) && treeWorking\) \|\| teamLock !== null\}/);
    assert.match(chat, /<PlanCard [^\n]*\/>\s*\{\/\* --- équipes \(it4\) : début --- \*\/\}\s*<TeamRunCards\b/);
    assert.match(chat, /<TeamRunCards\s+key=\{`equipe-\$\{sessionId\}`\}[\s\S]*?onLockChange=\{onTeamLock\}/);
    assert.match(chat, /if \(sessionRef\.current === sessionId\) setTeamLock\(texte\);/);
  });

  it("Composer : lanceur rendu juste avant le sélecteur d'autonomie ; brouillon = texte et fichiers « @ » encore cités, jamais d'image", () => {
    const composer = read("web/pages/chat/Composer.tsx");
    assert.match(composer, /\{\/\* --- équipes \(it4\) : début --- \*\/\}\s*\{team\}\s*\{\/\* --- équipes \(it4\) : fin --- \*\/\}\s*\{autonomy\}/);
    assert.match(composer, /a\.kind === "file" && texte\.includes\(`@\$\{a\.filename\}`\)/);
    assert.match(composer, /useImperativeHandle\(\s*draftHandle,/);
  });

  it("AssistantsPage : onglets au-dessus de la liste (liste entière dans le panneau), vues des équipes et de la carte par les squelettes", () => {
    const page = read("web/pages/AssistantsPage.tsx");
    assert.match(page, /<\/header>\s*\{\/\* --- équipes \(it4\) : début --- \*\/\}\s*<AssistantsTabs current="assistants">/);
    assert.match(page, /<\/AssistantsTabs>\s*\{\/\* --- équipes \(it4\) : fin --- \*\/\}\s*<\/div>\s*<AdoptDialog\b/);
    assert.match(page, /const teamView = assistantsViewOf\(route, useRouteQuery\(\)\);/);
    for (const re of [/<TeamEditor key="nouvelle" mode="nouvelle" id=\{null\}/, /<TeamEditor key=\{`modifier\/\$\{teamView\.id\}`\} mode="modifier" id=\{teamView\.id\}/]) {
      assert.match(page, re);
    }
    assert.match(page, /<TeamsTab advanced=\{advanced\} \/>/);
    assert.match(page, /<CarteTab directory=\{directory\} advanced=\{advanced\} element=\{teamView\.element\} \/>/);
  });

  it("Déroulé : TeamDeroule en tête, dans la section du Déroulé (sous son titre), avec les propriétés de l'emplacement", () => {
    const deroule = read("web/pages/chat/activity/Deroule.tsx");
    const content = deroule.indexOf("export function DerouleContent(");
    const slot = deroule.search(/<\/div>\s*\{\/\* --- équipes \(it4\) : début --- \*\/\}\s*<TeamDeroule rootId=\{rootId\} placement=\{placement\} advanced=\{advanced\} \/>/);
    assert.ok(content > 0 && slot > content, "TeamDeroule dans DerouleContent");
    assert.ok(slot < deroule.indexOf("{activity.error ?", content), "avant le contenu du Déroulé");
  });

  it("Budget : TeamsBudgetSettings en mode Avancé seulement", () => {
    assert.match(read("web/pages/settings/BudgetTab.tsx"), /\{advanced \? <TeamsBudgetSettings \/> : null\}/);
  });
});

// --- Contrat : chat/team/slots.ts ---------------------------------------------------------------------------------------------

/** Déclarations permises (majuscule initiale) dans slots.ts : ses propres types et Record. */
const SLOT_TYPES = [
  "TeamDraft",
  "TeamLauncherProps",
  "TeamRunCardsProps",
  "TeamDerouleProps",
  "TeamsTabProps",
  "TeamEditorProps",
  "CarteTabProps",
  "TeamsBudgetSettingsProps",
] as const;

/** Membres « nom → signature » d'une interface exportée (sans accolade imbriquée) ; null si absente. */
function membersOf(code: string, name: string): Record<string, string> | null {
  const start = new RegExp(`export interface ${name} \\{`).exec(code);
  if (!start) return null;
  const body = code.slice(start.index + start[0].length, code.indexOf("}", start.index));
  const out: Record<string, string> = {};
  for (const match of body.matchAll(/^\s*(\w+)(\??)(\([^)]*\))?\s*:\s*([^;]+);/gm)) {
    out[`${match[1]}${match[2]}`] = `${match[3] ?? ""}: ${(match[4] ?? "").trim()}`;
  }
  return out;
}

function checkSlots(texte: string): string[] {
  const problems: string[] = [];
  const code = withoutComments(texte);
  if (/^\s*import\b|\bfrom\s+["']/m.test(code)) problems.push("import interdit (types primitifs seulement, jamais team-types)");
  if (/\b(?:const|let|var|function|class|enum|namespace)\b/.test(code)) problems.push("code exécutable : types seulement");
  for (const match of code.matchAll(/\b[A-Z]\w*/g)) {
    if (![...SLOT_TYPES, "Record"].includes(match[0])) problems.push(`type non primitif : ${match[0]}`);
  }
  for (const name of SLOT_TYPES) {
    if (!new RegExp(`export (?:interface|type) ${name}\\b`).test(code)) problems.push(`${name} absent`);
  }
  return problems;
}

describe("emplacements des équipes : contrat chat/team/slots.ts", () => {
  const slots = read("web/pages/chat/team/slots.ts");

  it("types seulement, primitifs, sans import ; chaque emplacement exporté", () => {
    assert.deepEqual(checkSlots(slots), []);
  });

  it("propriétés figées (plan it4 §4.2)", () => {
    const code = withoutComments(slots);
    const expected: Record<string, Record<string, string>> = {
      TeamDraft: { texte: ": string", fichiers: ": string[]" },
      TeamLauncherProps: {
        rootId: ": string | null",
        directory: ": string",
        advanced: ": boolean",
        busy: ": boolean",
        getDraft: "(): TeamDraft",
        clearDraft: "(): void",
        agentConversation: ": string",
        onLaunched: "(rootId: string): void",
      },
      TeamRunCardsProps: {
        rootId: ": string",
        directory: ": string",
        advanced: ": boolean",
        onOpenSession: "(sessionId: string): void",
        onLockChange: "(texte: string | null): void",
      },
      TeamDerouleProps: { rootId: ": string", placement: ': "contexte" | "archives"', advanced: ": boolean" },
      TeamsTabProps: { advanced: ": boolean" },
      TeamEditorProps: { mode: ': "nouvelle" | "modifier"', id: ": string | null", advanced: ": boolean" },
      CarteTabProps: { directory: ": string", advanced: ": boolean", element: ": string | null" },
    };
    for (const [name, members] of Object.entries(expected)) assert.deepEqual(membersOf(code, name), members, name);
    assert.match(code, /export type TeamsBudgetSettingsProps = Record<string, never>;/);
  });

  it("contrôles discriminants : import de team-types, code, type non primitif, emplacement absent refusés", () => {
    const withImport = `import type { TeamRunView } from "../../../../server/shared/team-types.ts";\n${slots}`;
    assert.ok(checkSlots(withImport).some((p) => p.startsWith("import interdit")));
    assert.ok(checkSlots(withImport).includes("type non primitif : TeamRunView"));
    assert.ok(checkSlots(`${slots}\nexport const X = 1;`).includes("code exécutable : types seulement"));
    assert.ok(checkSlots(slots.replace("export type TeamsBudgetSettingsProps", "export type Autre")).includes("TeamsBudgetSettingsProps absent"));
    assert.ok(checkSlots(slots.replace("element: string | null;", "element: ReactNode;")).includes("type non primitif : ReactNode"));
  });
});

// --- Squelettes -----------------------------------------------------------------------------------------------------------------

interface Squelette {
  fichier: string;
  composant: string;
  proprietaire: string;
}

const SQUELETTES: readonly Squelette[] = [
  { fichier: "web/pages/chat/team/TeamLauncher.tsx", composant: "TeamLauncher", proprietaire: "L38a" },
  { fichier: "web/pages/chat/team/TeamRunCards.tsx", composant: "TeamRunCards", proprietaire: "L38b" },
  { fichier: "web/pages/chat/team/TeamDeroule.tsx", composant: "TeamDeroule", proprietaire: "L38c" },
  { fichier: "web/pages/assistants/teams/TeamsTab.tsx", composant: "TeamsTab", proprietaire: "L40a" },
  { fichier: "web/pages/assistants/teams/TeamEditor.tsx", composant: "TeamEditor", proprietaire: "L40b" },
  { fichier: "web/pages/assistants/carte/CarteTab.tsx", composant: "CarteTab", proprietaire: "L39b" },
  { fichier: "web/pages/settings/TeamsBudgetSettings.tsx", composant: "TeamsBudgetSettings", proprietaire: "L38c" },
];

/** Propriétaire en première ligne, composant typé par slots.ts ; tant que « Squelette T4w » : rend null, rien d'autre. */
function checkSquelette({ composant, proprietaire }: Squelette, texte: string): string[] {
  const problems: string[] = [];
  const first = (texte.split("\n")[0] ?? "").replace(/\r$/, "");
  if (first !== `// Propriétaire : ${proprietaire}.`) problems.push(`première ligne : ${first}`);
  if (!new RegExp(`import type \\{[^}]*\\b${composant}Props\\b[^}]*\\} from "(?:\\.\\.?/)+(?:chat/team/)?slots\\.ts";`).test(texte)) {
    problems.push(`${composant}Props non importé de slots.ts`);
  }
  if (!new RegExp(`export function ${composant}\\([^)]*:\\s*${composant}Props\\s*\\)`).test(texte)) problems.push(`${composant} non typé par ${composant}Props`);
  if (texte.includes("Squelette T4w")) {
    const code = withoutComments(texte);
    if (!new RegExp(`export function ${composant}\\(_props: ${composant}Props\\): null \\{\\s*return null;\\s*\\}`).test(code)) problems.push("squelette : ne rend pas null");
    if ((code.match(/\breturn\b/g) ?? []).length !== 1 || /<\w/.test(code)) problems.push("squelette : autre rendu que null");
  }
  return problems;
}

describe("emplacements des équipes : squelettes", () => {
  for (const squelette of SQUELETTES) {
    it(`${squelette.fichier} : « Propriétaire : ${squelette.proprietaire} », rend null tant qu'il est un squelette`, () => {
      assert.deepEqual(checkSquelette(squelette, read(squelette.fichier)), []);
    });
  }

  it("contrôles discriminants : rendu, propriétaire et type de propriétés vérifiés", () => {
    const squelette = SQUELETTES[0] as Squelette;
    // Source FABRIQUÉ, jamais le fichier réel : chaque paquet remplace son squelette à sa vague (L38a remplace TeamLauncher en
    // V1), et le contrôle discriminant doit rester valable après ce remplacement.
    const texte = [
      "// Propriétaire : L38a.",
      "// Squelette T4w : rend null.",
      'import type { TeamLauncherProps } from "./slots.ts";',
      "",
      "export function TeamLauncher(_props: TeamLauncherProps): null {",
      "  return null;",
      "}",
      "",
    ].join("\n");
    assert.deepEqual(checkSquelette(squelette, texte), [], "le source fabriqué est un squelette conforme");
    assert.ok(checkSquelette(squelette, texte.replace("return null;", "return <div />;")).includes("squelette : ne rend pas null"));
    assert.ok(checkSquelette(squelette, texte.replace("return null;", "if (_props.busy) return null;\n  return null;")).includes("squelette : ne rend pas null"));
    assert.ok(checkSquelette(squelette, texte.replace(squelette.proprietaire, "L99")).some((p) => p.startsWith("première ligne")));
    assert.ok(checkSquelette(squelette, texte.replace("TeamLauncherProps } from", "Autre } from")).includes("TeamLauncherProps non importé de slots.ts"));
    // Composant réel (« Squelette T4w » retiré par son paquet) : il peut rendre autre chose, le contrat reste vérifié.
    const real = texte.replace("Squelette T4w : rend null.", "").replace("_props: TeamLauncherProps): null {\n  return null;", "{ busy }: TeamLauncherProps) {\n  return busy ? null : <span />;");
    assert.deepEqual(checkSquelette(squelette, real), []);
  });
});

// --- Routes de la page Assistants -----------------------------------------------------------------------------------------------

const LISTE: AssistantsView = { mode: "liste" };
const viewOf = (hash: string) => assistantsViewOf(parseRoute(hash), parseRouteQuery(hash));
const ID_40 = "a".repeat(20) + "-".repeat(10) + "0".repeat(10);
/** Nom d'assistant accepté par le Studio (nameSchema : 64 caractères au plus) et plus long que 40 caractères (43). */
const NOM_43 = "revue-des-requetes-sql-du-reporting-mensuel";
/** Nom d'agent d'opencode de 64 caractères (règle des agents de la 1.1 : fact-store.ts, task-once-guard.ts). */
const NOM_64 = "A" + "b".repeat(30) + "_." + "9".repeat(30) + "-";

describe("emplacements des équipes : routes de la page Assistants", () => {
  it("vues des équipes et de la carte lues et validées", () => {
    assert.equal(NOM_43.length, 43);
    assert.equal(NOM_64.length, 64);
    const cases: Array<[string, AssistantsView]> = [
      ["#/assistants/equipes", { mode: "equipes" }],
      ["#/assistants/equipes/", { mode: "equipes" }],
      ["#/assistants/equipes/nouvelle", { mode: "equipe-nouvelle" }],
      ["#/assistants/equipes/modifier/revue-sql-replica", { mode: "equipe-modifier", id: "revue-sql-replica" }],
      [`#/assistants/equipes/modifier/${ID_40}`, { mode: "equipe-modifier", id: ID_40 }],
      ["#/assistants/equipes/modifier/7", { mode: "equipe-modifier", id: "7" }],
      ["#/assistants/carte", { mode: "carte", element: null }],
      ["#/assistants/carte?element=", { mode: "carte", element: null }],
      ["#/assistants/carte?autre=1", { mode: "carte", element: null }],
    ];
    for (const [hash, view] of cases) assert.deepEqual(viewOf(hash), view, hash);
  });

  it("élément de la carte : identifiant de nœud de L39a (C §9.8 element=<id>), écrit en clair ou encodé", () => {
    const elements = [
      "vous",
      "agent:relire-script",
      "agent:build",
      "agent:Build",
      "agent:mon_agent.v2",
      `agent:${NOM_43}`,
      `agent:${NOM_64}`,
      "raccourci:revue",
      `raccourci:${NOM_64}`,
      "fiche:standards-scripts",
      `fiche:${NOM_43}`,
      "equipe:revue-sql",
      `equipe:${ID_40}`,
    ];
    for (const element of elements) {
      const view: AssistantsView = { mode: "carte", element };
      assert.deepEqual(viewOf(`#/assistants/carte?element=${element}`), view, element);
      assert.deepEqual(viewOf(`#/assistants/carte?element=${encodeURIComponent(element)}`), view, element);
      assert.deepEqual(viewOf(`#/assistants/carte?autre=1&element=${encodeURIComponent(element)}`), view, element);
    }
    // Homonymes : un agent, un raccourci et une fiche nommés « revue » restent trois éléments distincts.
    const revue = ["agent:revue", "raccourci:revue", "fiche:revue"].map((element) => viewOf(`#/assistants/carte?element=${element}`));
    assert.deepEqual(revue, [
      { mode: "carte", element: "agent:revue" },
      { mode: "carte", element: "raccourci:revue" },
      { mode: "carte", element: "fiche:revue" },
    ]);
  });

  it("identifiant absent, invalide ou trop long, segment en trop, élément répété : vue par défaut (liste)", () => {
    const invalid = [
      "#/assistants/equipes/modifier",
      `#/assistants/equipes/modifier/${ID_40}b`,
      "#/assistants/equipes/modifier/Revue",
      "#/assistants/equipes/modifier/revue_sql",
      "#/assistants/equipes/modifier/revue%20sql",
      "#/assistants/equipes/modifier/..%2F..%2Fx",
      "#/assistants/equipes/modifier/%E0%A4%A",
      "#/assistants/equipes/modifier/%C3%A9quipe",
      "#/assistants/equipes/modifier/abc/def",
      "#/assistants/equipes/nouvelle/abc",
      "#/assistants/equipes/autre",
      "#/assistants/carte/relire-script",
      "#/assistants/carte/agent:relire-script",
      `#/assistants/carte?element=${ID_40}b`,
      "#/assistants/carte?element=Build",
      "#/assistants/carte?element=%3Cscript%3E",
      "#/assistants/carte?element=a%2Fb",
      "#/assistants/carte?element=a&element=b",
      "#/assistants/carte?element=agent:a&element=agent:a",
      "#/assistants/carte?element=vous&element=agent:relire-script",
    ];
    for (const hash of invalid) assert.deepEqual(viewOf(hash), LISTE, hash);
  });

  it("élément de la carte sans famille, de famille inconnue, au nom invalide ou trop long : vue par défaut (liste)", () => {
    const invalid = [
      // Nom sans famille (ambigu : agent, raccourci ou fiche) ; famille inconnue ou mal écrite ; « vous » seul.
      "relire-script",
      "revue",
      `${ID_40}b`,
      "inconnu:x",
      "Agent:relire-script",
      "agents:relire-script",
      "vous:x",
      "Vous",
      "vous-meme",
      ":relire-script",
      "agent",
      "agent:",
      "raccourci:",
      "fiche:",
      "equipe:",
      // Noms refusés par la règle des agents d'opencode : premier caractère, caractères, longueur.
      "agent:../x",
      "agent:..%2Fx",
      "agent%3A..%2F..%2Fx",
      "agent:.cache",
      "agent:-x",
      "agent:_x",
      "agent:a b",
      "agent:a%20b",
      "agent:a/b",
      "agent:a%2Fb",
      "agent:a:b",
      "agent:agent:x",
      "agent:%C3%A9quipe",
      "agent:%3Cscript%3E",
      "agent:a%0A",
      `agent:${NOM_64}b`,
      `raccourci:${NOM_64}b`,
      `fiche:${NOM_64}b`,
      // Équipe : règle des identifiants d'équipe (minuscules, chiffres, tirets, 40 caractères au plus).
      `equipe:${ID_40}b`,
      `equipe:${NOM_43}`,
      "equipe:Revue",
      "equipe:revue_sql",
      "equipe:revue.sql",
    ];
    for (const element of invalid) assert.deepEqual(viewOf(`#/assistants/carte?element=${element}`), LISTE, element);
    for (const element of invalid) {
      assert.deepEqual(viewOf(`#/assistants/carte?element=${encodeURIComponent(decodeURIComponent(element))}`), LISTE, element);
    }
  });

  it("vues existantes inchangées ; appel sans paramètres d'adresse permis", () => {
    const cases: Array<[string, AssistantsView]> = [
      ["#/assistants", LISTE],
      ["#/assistants/nouveau", { mode: "nouveau" }],
      ["#/assistants/modifier/relire-script", { mode: "modifier", name: "relire-script" }],
      ["#/assistants/completer/vieux", { mode: "completer", name: "vieux" }],
      ["#/assistants/detail/build", { mode: "detail", name: "build" }],
      ["#/assistants/inconnu", LISTE],
      ["#/chat/equipes", LISTE],
      ["#/chat?equipe=revue", LISTE],
    ];
    for (const [hash, view] of cases) assert.deepEqual(viewOf(hash), view, hash);
    assert.deepEqual(assistantsViewOf(["assistants", "carte"]), { mode: "carte", element: null });
    assert.deepEqual(assistantsViewOf(["assistants", "equipes", "modifier", "revue"]), { mode: "equipe-modifier", id: "revue" });
  });

  it("adresses : assistantsHref relu par assistantsViewOf rend la même vue", () => {
    const views: AssistantsView[] = [
      { mode: "equipes" },
      { mode: "equipe-nouvelle" },
      { mode: "equipe-modifier", id: "revue-sql" },
      { mode: "carte", element: null },
      { mode: "carte", element: "vous" },
      { mode: "carte", element: "agent:relire-script" },
      { mode: "carte", element: `agent:${NOM_43}` },
      { mode: "carte", element: `agent:${NOM_64}` },
      { mode: "carte", element: "raccourci:revue" },
      { mode: "carte", element: "fiche:revue" },
      { mode: "carte", element: `equipe:${ID_40}` },
      LISTE,
      { mode: "nouveau" },
      { mode: "detail", name: "build" },
    ];
    for (const view of views) assert.deepEqual(viewOf(assistantsHref(view)), view, JSON.stringify(view));
    assert.equal(assistantsHref({ mode: "equipes" }), "#/assistants/equipes");
    assert.equal(assistantsHref({ mode: "equipe-nouvelle" }), "#/assistants/equipes/nouvelle");
    assert.equal(assistantsHref({ mode: "equipe-modifier", id: "revue-sql" }), "#/assistants/equipes/modifier/revue-sql");
    assert.equal(assistantsHref({ mode: "carte", element: null }), "#/assistants/carte");
    assert.equal(assistantsHref({ mode: "carte", element: "vous" }), "#/assistants/carte?element=vous");
    assert.equal(assistantsHref({ mode: "carte", element: "agent:relire-script" }), "#/assistants/carte?element=agent%3Arelire-script");
  });

  it("onglets : ordre, adresse de chaque onglet, onglet actif de chaque vue (aucun pour les vues en pleine page)", () => {
    assert.deepEqual([...ASSISTANTS_TABS], ["assistants", "equipes", "carte"]);
    assert.deepEqual(
      ASSISTANTS_TABS.map((tab) => assistantsTabHref(tab)),
      ["#/assistants", "#/assistants/equipes", "#/assistants/carte"],
    );
    for (const tab of ASSISTANTS_TABS) assert.equal(assistantsTabOf(viewOf(assistantsTabHref(tab))), tab);
    const tabs: Array<[AssistantsView, string | null]> = [
      [LISTE, "assistants"],
      [{ mode: "detail", name: "build" }, "assistants"],
      [{ mode: "equipes" }, "equipes"],
      [{ mode: "carte", element: "agent:build" }, "carte"],
      [{ mode: "nouveau" }, null],
      [{ mode: "modifier", name: "x" }, null],
      [{ mode: "completer", name: "x" }, null],
      [{ mode: "equipe-nouvelle" }, null],
      [{ mode: "equipe-modifier", id: "x" }, null],
    ];
    for (const [view, tab] of tabs) assert.equal(assistantsTabOf(view), tab, JSON.stringify(view));
  });
});

// --- Onglets de la page Assistants ---------------------------------------------------------------------------------------------

interface CssDeclaration {
  selecteur: string;
  prop: string;
  value: string;
  blocks: string[];
}

/** Déclarations CSS (commentaires retirés) avec le sélecteur de leur règle et les en-têtes des blocs englobants. */
function cssDeclarations(css: string): CssDeclaration[] {
  const code = css.replace(/\/\*[\s\S]*?\*\//g, blank);
  const out: CssDeclaration[] = [];
  const stack: string[] = [];
  let buffer = "";
  const flush = () => {
    const match = /^\s*([\w-]+)\s*:([\s\S]*)$/.exec(buffer);
    if (match && stack.length > 0) {
      out.push({ selecteur: stack.at(-1) ?? "", prop: (match[1] ?? "").toLowerCase(), value: (match[2] ?? "").trim().replace(/\s+/g, " "), blocks: [...stack] });
    }
  };
  for (const c of code) {
    if (c === "{") {
      stack.push(buffer.trim().replace(/\s+/g, " "));
      buffer = "";
    } else if (c === ";" || c === "}") {
      flush();
      if (c === "}") stack.pop();
      buffer = "";
    } else {
      buffer += c;
    }
  }
  return out;
}

const FORCED = /^@media\b[^{]*\(\s*forced-colors\s*:\s*active\s*\)/i;
const inForced = (d: CssDeclaration) => d.blocks.some((block) => FORCED.test(block));
const selectors = (d: CssDeclaration) => d.selecteur.split(",").map((s) => s.trim());

describe("emplacements des équipes : onglets de la page Assistants", () => {
  const tabs = read("web/pages/assistants/AssistantsTabs.tsx");
  const code = withoutComments(tabs);

  it("motif APG : liste d'onglets, onglets, panneau, sélection, un seul arrêt de tabulation, position annoncée", () => {
    for (const re of [
      /role="tablist"/,
      /role="tab"/,
      /role="tabpanel"/,
      /aria-selected=\{selected\}/,
      /aria-controls=\{selected \? panelId : undefined\}/,
      /aria-labelledby=\{tabId\(current\)\}/,
      /tabIndex=\{selected \? 0 : -1\}/,
      /aria-posinset=\{index \+ 1\}/,
      /aria-setsize=\{ASSISTANTS_TABS\.length\}/,
      /type="button"/,
    ]) {
      assert.match(code, re);
    }
  });

  it("clavier : flèches gauche et droite en boucle, Début et Fin ; touches avec modificateur laissées au navigateur", () => {
    assert.match(code, /key === "ArrowRight"\) return \(index \+ 1\) % count;/);
    assert.match(code, /key === "ArrowLeft"\) return \(index - 1 \+ count\) % count;/);
    assert.match(code, /key === "Home"\) return 0;/);
    assert.match(code, /key === "End"\) return count - 1;/);
    assert.match(code, /if \(event\.altKey \|\| event\.ctrlKey \|\| event\.metaKey \|\| event\.shiftKey\) return;/);
    assert.match(code, /event\.preventDefault\(\);\s*buttons\.current\[next\]\?\.focus\(\);/);
  });

  it("focus jamais pris : deux appels seulement (touche de l'utilisateur, onglet qu'il vient d'ouvrir, borné dans le temps)", () => {
    assert.equal((code.match(/\.focus\(/g) ?? []).length, 2);
    assert.doesNotMatch(code, /autoFocus/);
    assert.match(code, /if \(pending\?\.tab !== current \|\| Date\.now\(\) - pending\.at > REFOCUS_WINDOW_MS\) return;/);
    assert.match(code, /reopened = \{ tab, at: Date\.now\(\) \};\s*goTo\(assistantsTabHref\(tab\)\);/);
  });

  it("textes : les trois libellés seulement, aucun texte en dur dans le rendu", () => {
    assert.match(code, /const LABELS: Readonly<Record<AssistantsTab, string>> = \{ assistants: "Assistants", equipes: "Équipes", carte: "Carte" \};/);
    const literals = [...code.matchAll(/"([^"\n]*)"/g)].map((m) => m[1] ?? "").filter((s) => /[A-ZÀ-Ý][a-zà-ÿ]|[À-ÿ]/.test(s));
    assert.deepEqual([...new Set(literals)].sort(), ["ArrowLeft", "ArrowRight", "Assistants", "Carte", "End", "Home", "Équipes"].sort());
    assert.doesNotMatch(code, />[ \t]*[\p{L}][^<{}\n]*<\//u);
    const templates = [...code.matchAll(/`([^`]*)`/g)].map((m) => (m[1] ?? "").replace(/\$\{[^}]*\}/g, ""));
    assert.deepEqual(
      templates.filter((s) => /[A-ZÀ-Ý][a-zà-ÿ]|[À-ÿ]|[a-z] [a-z]/.test(s)),
      [],
    );
  });

  it("feuille : onglet actif marqué par une bordure et un texte plus gras, jamais par la couleur seule", () => {
    const decls = cssDeclarations(read("web/pages/assistants/assistants-tabs.css")).filter((d) => !d.blocks.some((b) => b.startsWith("@media")));
    const base = decls.filter((d) => selectors(d).includes(".ast-tab"));
    const selected = decls.filter((d) => selectors(d).includes('.ast-tab[aria-selected="true"]'));
    assert.ok(base.some((d) => d.prop === "border-bottom" && /\b3px solid transparent\b/.test(d.value)), "bordure réservée (transparente) sur chaque onglet");
    assert.ok(selected.some((d) => d.prop === "border-bottom-color" && !/transparent/.test(d.value)), "bordure visible sur l'onglet actif");
    const weight = (list: CssDeclaration[]) => Number(list.find((d) => d.prop === "font-weight")?.value ?? Number.NaN);
    assert.ok(weight(selected) > weight(base), "texte plus gras sur l'onglet actif");
  });

  it("feuille : contraste forcé (bordure de l'onglet actif et texte en CanvasText, focus en outline Highlight)", () => {
    const forced = cssDeclarations(read("web/pages/assistants/assistants-tabs.css")).filter(inForced);
    const has = (selecteur: string, prop: string, value: RegExp) => forced.some((d) => selectors(d).includes(selecteur) && d.prop === prop && value.test(d.value));
    assert.ok(has('.ast-tab[aria-selected="true"]', "border-bottom-color", /^CanvasText$/));
    assert.ok(has(".ast-tab", "border-bottom-color", /^Canvas$/), "bordure des autres onglets fondue dans le fond");
    assert.ok(has(".ast-tab", "color", /^CanvasText$/));
    assert.ok(has(".ast-tab:focus-visible", "outline", /\bHighlight\b/));
    assert.ok(has(".ast-tabpanel:focus-visible", "outline", /\bHighlight\b/));
  });
});

// --- Contraste forcé (U9) ----------------------------------------------------------------------------------------------------

/** Feuilles des périmètres des équipes et de la carte (chemins relatifs à web/). */
const inPerimeter = (fichier: string) =>
  ["pages/chat/team/", "pages/assistants/teams/", "pages/assistants/carte/"].some((dir) => fichier.startsWith(dir)) ||
  fichier === "pages/assistants/assistants-tabs.css" ||
  /^pages\/settings\/TeamsBudgetSettings[^/]*\.css$/.test(fichier);

function perimeterSheets(): string[] {
  return (fs.readdirSync(WEB_DIR, { recursive: true }) as string[])
    .map((entry) => entry.replaceAll("\\", "/"))
    .filter((fichier) => fichier.endsWith(".css") && inPerimeter(fichier))
    .sort();
}

/** Au moins une déclaration sous @media (forced-colors: active) (bloc présent et non vide, commentaires ignorés). */
const hasForcedColors = (css: string) => cssDeclarations(css).some(inForced);

describe("emplacements des équipes : contraste forcé (U9, spécification §5.5 l.922)", () => {
  it("contrôles discriminants : bloc absent, vide ou en commentaire refusé ; périmètre des équipes et de la carte seulement", () => {
    assert.equal(hasForcedColors(".a { color: red; }"), false);
    assert.equal(hasForcedColors("@media (forced-colors: active) {}"), false);
    assert.equal(hasForcedColors("/* @media (forced-colors: active) { .a { color: CanvasText; } } */ .a { color: red; }"), false);
    assert.equal(hasForcedColors("@media (prefers-contrast: more) { .a { color: CanvasText; } }"), false);
    assert.equal(hasForcedColors("@media (forced-colors: active) { .a { outline: 2px solid Highlight; } }"), true);
    assert.equal(hasForcedColors("@media screen and (forced-colors:active) { .a { color: CanvasText; } }"), true);
    for (const fichier of [
      "pages/chat/team/team-cards.css",
      "pages/chat/team/sous/x.css",
      "pages/assistants/teams/teams.css",
      "pages/assistants/carte/carte.css",
      "pages/assistants/assistants-tabs.css",
      "pages/settings/TeamsBudgetSettings.css",
    ]) {
      assert.ok(inPerimeter(fichier), fichier);
    }
    for (const fichier of ["pages/assistants/assistants.css", "pages/settings/settings.css", "pages/chat/chat.css", "pages/chat/teamx/x.css"]) {
      assert.ok(!inPerimeter(fichier), fichier);
    }
  });

  it("chaque feuille des périmètres porte un bloc @media (forced-colors: active) (dès V0 : assistants-tabs.css)", () => {
    const sheets = perimeterSheets();
    assert.ok(sheets.includes("pages/assistants/assistants-tabs.css"), JSON.stringify(sheets));
    const missing = sheets.filter((fichier) => !hasForcedColors(fs.readFileSync(path.join(WEB_DIR, fichier), "utf8")));
    assert.deepEqual(missing, []);
  });
});
