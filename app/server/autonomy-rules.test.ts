// Matrice, délégation, activation, plafonds et phrases de l'autonomie (L9b ; spécification §4.1, §4.3, §4.7, §4.8.1, §4.10,
// §4.11, §4.13, §6 l.1049, §7.4 ; plan d'exécution, fiche L9b et §3.5 ; mesures MX1 « coût par étape » et M16, MX2 M5) : un cas
// par ligne de la matrice §4.1 et par règle D1 à D7 ; chaque raison de refus d'activation et sa phrase ; pré-conditions et
// plafonds ; textes sur les deux variantes de l'IA de contrôle (avec et sans, repli §7.4) ; chiffres « en général / au plus » ;
// pureté des deux modules.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import type { ControlAiUnavailableCode, DelegationPolicyVerdict } from "./contracts-11.ts";
import { effectiveAgentRules, effectiveBuiltinRules, evaluate, PERMISSION_PRESETS, type Rule, type UiMode } from "./shared/assistant-rules.ts";
import {
  descriptionChoix,
  raisonIndisponible,
  TEXTES as CHOIX_TEXTES,
  TEXTES_VARIANTES as CHOIX_VARIANTES,
} from "./shared/autonomy-choice-texts.ts";
import * as editRules from "./shared/autonomy-edit-rules.ts";
import type { EditFacts } from "./shared/autonomy-edit-rules.ts";
import * as rules from "./shared/autonomy-rules.ts";
import {
  ACTIVATION_REFUSAL_CODES,
  type ActivationFacts,
  activationRefusal,
  actsWithoutAsking,
  allowJudge,
  AUTONOMY_RULES_VERSION,
  CAP_ORDER,
  type CapHit,
  capReached,
  classifyDelegation,
  classifyEdit,
  DELEGATION_AUTO_RULE,
  DELEGATION_RULE_ORDER,
  type DelegationVerdict,
  isShellConsultationRule,
  type PreconditionInput,
  preconditionFailure,
  type RequestCounters,
  routePermission,
  SHELL_CONSULTATION_PROGRAMS,
  SHELL_CONSULTATION_RULES,
  SKILL_AUTO_RULE,
} from "./shared/autonomy-rules.ts";
import {
  bandeau,
  confirmationAutonome,
  confirmationModifications,
  type ControleIaIndisponible,
  controleIaIndisponible,
  decisionControleIa,
  estimationTexte,
  libelleDecision,
  libellePar,
  montant,
  phraseFin,
  phrasePlafond,
  phraseRegle,
  phraseRelais,
  phraseRetour,
  quiDelegue,
  raccourciRefuse,
  raisonRefus,
  regleCarte,
  TEXTES,
  TEXTES_VARIANTES,
  variante,
} from "./shared/autonomy-texts.ts";
import type { ActivationRefusalCode, AutonomyCaps, AutonomyChoice, ChoiceCause, DelegationFacts, RequestEnd } from "./shared/autonomy-types.ts";
import { buildFloor, disabledTools } from "./shared/session-floors.ts";
import { classifyCommand, GIT_CONSULTATION_SUBCOMMANDS, SHELL_FORBIDDEN, type ShellContext } from "./shared/shell-gate.ts";

const SHARED = path.join(import.meta.dirname, "shared");
const DIR = "/workspace/projet";
const CHOICES: readonly AutonomyChoice[] = ["demander", "modifications", "plan", "autonome"];
const MODES: readonly UiMode[] = ["simple", "avance"];
const CAPS: AutonomyCaps = { plafondUsd: 1, actionsMax: 60, delegationsMax: 5, dureeMinutes: 30, fichiersMax: 25, controlesIaMax: 20 };
const MINUTE = 60_000;
const T0 = 1_800_000_000_000;

/** Gel profond : une fonction pure qui écrirait dans son entrée lèverait (modules ES en mode strict). */
function deepFreeze<T>(value: T): T {
  if (typeof value === "object" && value !== null) {
    for (const item of Object.values(value)) deepFreeze(item);
    Object.freeze(value);
  }
  return value;
}

// --- Doublures --------------------------------------------------------------------------------------------------------------------

/** Résolution lexicale depuis le dossier de la conversation (aucun lien) ; aucun chemin sensible dans les sous-arbres. */
function shellCtx(allow: boolean): ShellContext {
  const resolveLexically = (arg: string): string => {
    const out: string[] = [];
    for (const segment of (arg.startsWith("/") ? arg : `${DIR}/${arg}`).split("/")) {
      if (segment === "" || segment === ".") continue;
      if (segment === "..") out.pop();
      else out.push(segment);
    }
    return `/${out.join("/")}`;
  };
  return {
    conversationDir: DIR,
    workdir: null,
    allowJudge: allow,
    paths: {
      resolve: (arg) => {
        const real = resolveLexically(arg);
        return { inside: real === DIR || real.startsWith(`${DIR}/`), symlinkOut: false, real };
      },
      sensitiveEntries: () => [],
    },
    git: { gitIsDirectory: true, configText: "[core]\n\tbare = false\n", launcher: null, trackedSensitive: [] },
  };
}

const EDIT_DIFF = `Index: ${DIR}/src/app.ts\n${"=".repeat(67)}\n--- ${DIR}/src/app.ts\n+++ ${DIR}/src/app.ts\n@@ -1,3 +1,3 @@\n ligne 1\n-ligne 2\n+ligne deux\n ligne 3\n`;

/** Modification conforme E1-E6 : fichier du dossier, non protégé, diff lisible, sous le plafond de fichiers. */
function editFacts(over: Partial<EditFacts> = {}): EditFacts {
  return {
    directoryAllowed: true,
    patterns: ["src/app.ts"],
    paths: [{ path: `${DIR}/src/app.ts`, resolved: `${DIR}/src/app.ts`, inside: true, symlinkOut: false }],
    deletesOrMoves: false,
    diffs: [EDIT_DIFF],
    filesSoFar: 0,
    newFiles: 1,
    ...over,
  };
}

/** Délégation conforme D1-D7. */
function delegation(over: Partial<DelegationFacts> = {}): DelegationFacts {
  return {
    target: { name: "explore", mode: "subagent", internal: false },
    taskIdInTree: null,
    promptRisk: null,
    modelAllowed: true,
    guardAccepts: true,
    delegationsSoFar: 0,
    estimateUsd: 0.1,
    remainingUsd: 0.9,
    ...over,
  };
}

/** Activation permise : interrupteur, porte ouverte, assistant du profil Prudent livré, ni MCP ni extension, plancher vérifié. */
function activation(over: Partial<ActivationFacts> = {}): ActivationFacts {
  return {
    interrupteur: true,
    activationOuverte: true,
    agentRules: effectiveAgentRules(PERMISSION_PRESETS.prudent.permission, {}),
    mcpOuExtension: false,
    profilSansConfirmation: false,
    plancherVerifie: true,
    ...over,
  };
}

function counters(over: Partial<RequestCounters> = {}): RequestCounters {
  return { startedAt: T0, spentUsd: 0.5, auto: 10, fichiers: 3, ...over };
}

const rule = (permission: string, pattern: string, action: Rule["action"]): Rule => ({ permission, pattern, action });

/** Phrase fixée par le contrat de « a-venir » (autonomy-types.ts), lue dans le commentaire. */
function contractAVenir(): string | undefined {
  const contract = fs.readFileSync(path.join(SHARED, "autonomy-types.ts"), "utf8");
  return /-\s*a-venir\s*:[\s\S]*?phrase affichée[^«]*«\s*([^»]+?)\s*»/u.exec(contract)?.[1];
}

// --- Version et réexport ------------------------------------------------------------------------------------------------------

describe("autonomie : version des règles et réexport de la politique « modification »", () => {
  it("AUTONOMY_RULES_VERSION est un entier ≥ 1, jamais sous le nom RULES_VERSION (déjà pris, D-02)", () => {
    assert.ok(Number.isSafeInteger(AUTONOMY_RULES_VERSION) && AUTONOMY_RULES_VERSION >= 1);
    assert.equal("RULES_VERSION" in rules, false);
  });

  it("classifyEdit et ses listes sont réexportés tels quels depuis autonomy-edit-rules.ts (L9a)", () => {
    assert.equal(rules.classifyEdit, editRules.classifyEdit);
    assert.equal(rules.EDIT_RULE_ORDER, editRules.EDIT_RULE_ORDER);
    assert.equal(rules.EDIT_AUTO_RULE, editRules.EDIT_AUTO_RULE);
    assert.equal(rules.isProtectedPath, editRules.isProtectedPath);
    assert.equal(rules.PROTECTED_GLOBS, editRules.PROTECTED_GLOBS);
  });
});

// --- Matrice §4.1 : un cas par ligne ------------------------------------------------------------------------------------------

describe("matrice §4.1 : un cas par ligne", () => {
  it("lire, chercher : selon l'assistant ; une lecture demandée n'est jamais automatique", () => {
    for (const permission of ["read", "glob", "grep", "list"]) {
      for (const choice of CHOICES) {
        const expected = choice === "modifications" || choice === "autonome" ? { route: "attente", regle: "R-lecture" } : { route: "hors-autonomie" };
        assert.deepEqual(routePermission(choice, permission), expected, `${choice} ${permission}`);
      }
    }
  });

  it("fichiers de clés : refusés par le plancher de toute conversation (plan compris), jamais automatiques", () => {
    for (const floor of [buildFloor("CONVERSATION"), buildFloor("PLAN")]) {
      for (const file of ["certificat.pfx", "id_rsa", "cle.key", "prod.kdbx"]) assert.equal(evaluate(floor, "read", `${DIR}/${file}`), "deny", file);
    }
    const key = `${DIR}/certificat.pfx`;
    assert.deepEqual(classifyEdit(editFacts({ patterns: ["certificat.pfx"], paths: [{ path: key, resolved: key, inside: true, symlinkOut: false }] }), 25), {
      verdict: "attente",
      regle: "E2",
    });
    assert.deepEqual(classifyCommand("cat certificat.pfx", shellCtx(true)).verdict, "attente");
    assert.equal(classifyCommand("cat certificat.pfx", shellCtx(true)).regle, "P03");
  });

  it("lire un .env : votre accord (le plancher ne le refuse pas ; jamais automatique)", () => {
    assert.notEqual(evaluate(buildFloor("CONVERSATION"), "read", `${DIR}/.env`), "deny");
    for (const choice of ["modifications", "autonome"] as const) assert.deepEqual(routePermission(choice, "read"), { route: "attente", regle: "R-lecture" });
    assert.equal(classifyCommand("cat .env", shellCtx(true)).regle, "P03");
    const env = `${DIR}/.env`;
    assert.equal(classifyEdit(editFacts({ patterns: [".env"], paths: [{ path: env, resolved: env, inside: true, symlinkOut: false }] }), 25).regle, "E2");
  });

  it("modifier un fichier du dossier, non protégé : automatique en Modifications et en Autonome, impossible en Plan d'abord", () => {
    assert.deepEqual(routePermission("demander", "edit"), { route: "hors-autonomie" });
    assert.deepEqual(routePermission("plan", "edit"), { route: "hors-autonomie" });
    assert.deepEqual(disabledTools(buildFloor("PLAN"), ["edit", "write", "apply_patch"]), ["edit", "write", "apply_patch"]);
    for (const choice of ["modifications", "autonome"] as const) {
      assert.deepEqual(routePermission(choice, "edit"), { route: "edit" });
      assert.deepEqual(classifyEdit(editFacts(), CAPS.fichiersMax), { verdict: "auto", regle: "A-edit" });
    }
  });

  it("fichier protégé, suppression, vidage, hors dossier : votre accord dans chaque choix", () => {
    const workflow = `${DIR}/.github/workflows/x.yml`;
    const outside = "/workspace/autre/a.ts";
    const cases: Array<[string, EditFacts, string]> = [
      ["protégé", editFacts({ patterns: [".github/workflows/x.yml"], paths: [{ path: workflow, resolved: workflow, inside: true, symlinkOut: false }] }), "E2"],
      ["suppression", editFacts({ deletesOrMoves: true }), "E3"],
      ["hors dossier", editFacts({ paths: [{ path: outside, resolved: outside, inside: false, symlinkOut: false }] }), "E1"],
    ];
    for (const [name, facts, regle] of cases) assert.deepEqual(classifyEdit(facts, CAPS.fichiersMax), { verdict: "attente", regle }, name);
    assert.deepEqual(routePermission("demander", "edit"), { route: "hors-autonomie" });
  });

  it("consultation shell simple : automatique en Autonome seulement ; outil retiré en Plan d'abord", () => {
    assert.deepEqual(routePermission("demander", "bash"), { route: "hors-autonomie" });
    assert.deepEqual(routePermission("modifications", "bash"), { route: "attente", regle: "R-modifications" });
    assert.deepEqual(routePermission("plan", "bash"), { route: "hors-autonomie" });
    assert.deepEqual(disabledTools(buildFloor("PLAN"), ["bash"]), ["bash"]);
    assert.deepEqual(routePermission("autonome", "bash"), { route: "bash" });
    const verdict = classifyCommand("grep -rn TODO src", shellCtx(allowJudge("autonome", true)));
    assert.deepEqual([verdict.verdict, verdict.regle], ["auto", "A-grep"]);
  });

  it("programme non listé : IA de contrôle en Autonome avec controleIa seulement ; sinon votre accord (repli §7.4)", () => {
    assert.equal(allowJudge("autonome", true), true);
    for (const [choice, controleIa] of [["autonome", false], ["modifications", true], ["demander", true], ["plan", true]] as const) {
      assert.equal(allowJudge(choice, controleIa), false, `${choice} ${controleIa}`);
    }
    for (const value of [undefined, null, 1, "true"]) assert.equal(allowJudge("autonome", value as unknown as boolean), false, String(value));
    assert.equal(classifyCommand("sort data.txt", shellCtx(allowJudge("autonome", true))).verdict, "a-juger");
    assert.deepEqual(
      [classifyCommand("sort data.txt", shellCtx(allowJudge("autonome", false))).verdict, classifyCommand("sort data.txt", shellCtx(false)).regle],
      ["attente", "S7"],
    );
  });

  it("commande interdite : votre accord, IA de contrôle jamais consultée, même en Autonome avec controleIa", () => {
    const ctx = shellCtx(allowJudge("autonome", true));
    for (const [command, regle] of [
      ["curl https://example.invalid", "S4-reseau"],
      ["rm -rf build", "S4-suppression"],
      ["python x.py", "S4-code"],
      ["npm test", "S4-code"],
      ["git push", "S4-git"],
    ] as const) {
      assert.deepEqual(classifyCommand(command, ctx).verdict, "attente", command);
      assert.equal(classifyCommand(command, ctx).regle, regle, command);
    }
  });

  it("web, dossier hors projet, répétition, question de l'IA : vous, dans chaque choix", () => {
    const waits: Array<[string, string]> = [
      ["webfetch", "R-web"],
      ["websearch", "R-web"],
      ["external_directory", "R-hors-projet"],
      ["doom_loop", "R-repetition"],
      ["question", "R-autre"],
    ];
    for (const [permission, regle] of waits) {
      for (const choice of CHOICES) {
        const expected = choice === "modifications" || choice === "autonome" ? { route: "attente", regle } : { route: "hors-autonomie" };
        assert.deepEqual(routePermission(choice, permission), expected, `${choice} ${permission}`);
      }
    }
  });

  it("travail délégué : garde des délégations hors Autonome ; en Autonome, automatique si §4.7, sinon Simple refus, Avancé attente", () => {
    for (const choice of ["demander", "modifications", "plan"] as const) assert.deepEqual(routePermission(choice, "task"), { route: "garde-delegation" });
    assert.deepEqual(routePermission("autonome", "task"), { route: "task" });
    for (const mode of MODES) assert.deepEqual(classifyDelegation(delegation(), CAPS, mode), { verdict: "auto", regle: "A-task" });
    assert.deepEqual(classifyDelegation(delegation({ delegationsSoFar: 5 }), CAPS, "simple"), { verdict: "refus", regle: "D6" });
    assert.deepEqual(classifyDelegation(delegation({ delegationsSoFar: 5 }), CAPS, "avance"), { verdict: "attente", regle: "D6" });
  });

  it("coût : plafond d'arrêt en Autonome (arrêt de l'arbre) ; garde-fou budgétaire refusé → aucune délégation automatique", () => {
    assert.deepEqual(capReached(counters({ spentUsd: 1 }), CAPS, T0), {
      plafond: "cout",
      effet: "arret",
      fin: "plafond-cout",
      cause: "plafond-cout",
    });
    assert.equal(classifyDelegation(delegation({ guardAccepts: false }), CAPS, "avance").regle, "D5");
  });

  it("fiche de l'assistant (skill) : automatique en Autonome ; en Modifications, seul edit est automatique", () => {
    assert.deepEqual(routePermission("autonome", "skill"), { route: "auto", regle: SKILL_AUTO_RULE });
    assert.deepEqual(routePermission("modifications", "skill"), { route: "attente", regle: "R-modifications" });
    for (const permission of ["bash", "skill", "webfetch", "external_directory", "read", "doom_loop", "mcp_outil", "task"]) {
      const route = routePermission("modifications", permission);
      assert.ok(route.route === "attente" || route.route === "garde-delegation", `${permission} : ${JSON.stringify(route)}`);
    }
  });

  it("nom inconnu, forme d'une autre version, clé du prototype ou valeur illisible : attente, jamais automatique", () => {
    for (const permission of ["write", "apply_patch", "todowrite", "lsp", "mcp_serveur_outil", "codesearch", "constructor", "__proto__", "toString", "", "EDIT", "Bash"]) {
      for (const choice of ["modifications", "autonome"] as const) {
        assert.deepEqual(routePermission(choice, permission), { route: "attente", regle: "R-autre" }, `${choice} ${permission}`);
      }
    }
    assert.deepEqual(routePermission("autonome", 12 as unknown as string), { route: "attente", regle: "R-autre" });
    assert.deepEqual(routePermission("omo" as unknown as AutonomyChoice, "edit"), { route: "hors-autonomie" });
    assert.deepEqual(routePermission("omo" as unknown as AutonomyChoice, "task"), { route: "garde-delegation" });
  });
});

// --- Pré-conditions (§4.3 étape 3) --------------------------------------------------------------------------------------------

describe("pré-conditions d'un examen (§4.3 étape 3)", () => {
  const ok = (over: Partial<PreconditionInput> = {}): PreconditionInput => ({ interrupteur: true, demandeEnCours: true, plafond: null, activation: null, ...over });
  const hit = capReached(counters({ auto: 60 }), CAPS, T0) as CapHit;

  it("toutes tenues : examen ; chacune isolée donne sa règle", () => {
    assert.equal(preconditionFailure(ok()), null);
    assert.equal(preconditionFailure(ok({ interrupteur: false })), "X-coupee");
    assert.equal(preconditionFailure(ok({ demandeEnCours: false })), "X-hors-demande");
    assert.equal(preconditionFailure(ok({ plafond: hit })), "plafond-actions");
    assert.equal(preconditionFailure(ok({ activation: "regle-allow" })), "regle-allow");
  });

  it("ordre : interrupteur, demande en cours, plafonds, activation", () => {
    assert.equal(preconditionFailure(ok({ interrupteur: false, demandeEnCours: false, plafond: hit, activation: "a-venir" })), "X-coupee");
    assert.equal(preconditionFailure(ok({ demandeEnCours: false, plafond: hit, activation: "a-venir" })), "X-hors-demande");
    assert.equal(preconditionFailure(ok({ plafond: hit, activation: "a-venir" })), "plafond-actions");
  });

  it("valeur illisible : X-illisible, jamais un examen par défaut", () => {
    const bad = (value: unknown) => value as never;
    for (const input of [
      bad(null),
      ok({ interrupteur: bad("true") }),
      ok({ demandeEnCours: bad(undefined) }),
      ok({ plafond: bad(undefined) }),
      ok({ plafond: bad({ cause: "plafond-inconnu" }) }),
      ok({ activation: bad(undefined) }),
      ok({ activation: bad("inconnue") }),
    ]) {
      assert.equal(preconditionFailure(input), "X-illisible", JSON.stringify(input));
    }
  });
});

// --- Délégation en Autonome D1 à D7 (§4.7) ------------------------------------------------------------------------------------

describe("délégation en Autonome : un cas isolé par règle D1 à D7 (§4.7)", () => {
  const cases: Array<[string, Partial<DelegationFacts>, string]> = [
    ["cible absente de GET /agent", { target: null }, "D1"],
    ["cible principale", { target: { name: "build", mode: "primary", internal: false } }, "D1"],
    ["cible interne au cockpit", { target: { name: "cockpit-controle", mode: "subagent", internal: true } }, "D1"],
    ["mode d'agent inconnu", { target: { name: "x", mode: "autre", internal: false } }, "D1"],
    ["nom vide", { target: { name: "", mode: "subagent", internal: false } }, "D1"],
    ["task_id hors de l'arbre", { taskIdInTree: false }, "D2"],
    ["consigne à risque (@fichier)", { promptRisk: "fichier" }, "D3"],
    ["IA non autorisée", { modelAllowed: false }, "D4"],
    ["garde-fou budgétaire refuse", { guardAccepts: false }, "D5"],
    ["plafond de délégations atteint", { delegationsSoFar: 5 }, "D6"],
    ["estimation au-delà du reste", { estimateUsd: 0.91, remainingUsd: 0.9 }, "D7"],
  ];

  it("conforme : automatique dans les deux modes ; forme compatible avec le port delegationPolicy (L10e)", () => {
    for (const mode of MODES) {
      const verdict: DelegationPolicyVerdict = classifyDelegation(delegation(), CAPS, mode);
      assert.deepEqual(verdict, { verdict: "auto", regle: DELEGATION_AUTO_RULE });
    }
    assert.equal(classifyDelegation(delegation({ target: { name: "general", mode: "all", internal: false } }), CAPS, "simple").verdict, "auto");
    assert.equal(classifyDelegation(delegation({ taskIdInTree: true }), CAPS, "simple").verdict, "auto");
  });

  it("chaque règle isolée : refus en mode Simple, attente en mode Avancé", () => {
    for (const [name, over, regle] of cases) {
      assert.deepEqual(classifyDelegation(delegation(over), CAPS, "simple"), { verdict: "refus", regle }, name);
      assert.deepEqual(classifyDelegation(delegation(over), CAPS, "avance"), { verdict: "attente", regle }, name);
    }
  });

  it("bornes : D6 strictement sous le plafond, D7 estimation ≤ reste ; valeurs illisibles refusées", () => {
    assert.equal(classifyDelegation(delegation({ delegationsSoFar: 4 }), CAPS, "avance").verdict, "auto");
    assert.equal(classifyDelegation(delegation(), { ...CAPS, delegationsMax: 0 }, "avance").regle, "D6");
    assert.equal(classifyDelegation(delegation({ delegationsSoFar: Number.NaN }), CAPS, "avance").regle, "D6");
    assert.equal(classifyDelegation(delegation({ estimateUsd: 0.9, remainingUsd: 0.9 }), CAPS, "avance").verdict, "auto");
    for (const over of [{ estimateUsd: Number.NaN }, { remainingUsd: Number.POSITIVE_INFINITY }, { estimateUsd: -0.1 }, { remainingUsd: -0.01, estimateUsd: 0 }]) {
      assert.equal(classifyDelegation(delegation(over), CAPS, "avance").regle, "D7", JSON.stringify(over));
    }
    assert.equal(classifyDelegation(delegation({ modelAllowed: "true" as unknown as boolean }), CAPS, "avance").regle, "D4");
  });

  it("ordre D1 → D7 : la première règle qui échoue décide", () => {
    assert.deepEqual(DELEGATION_RULE_ORDER, ["D1", "D2", "D3", "D4", "D5", "D6", "D7"]);
    const failing = cases.filter(([name]) => !name.startsWith("cible") && !name.startsWith("mode") && !name.startsWith("nom"));
    for (let i = 0; i < failing.length; i++) {
      const over = Object.assign({}, ...failing.slice(i).map(([, facts]) => facts)) as Partial<DelegationFacts>;
      assert.equal(classifyDelegation(delegation(over), CAPS, "avance").regle, failing[i]?.[2]);
    }
    assert.equal(classifyDelegation(delegation({ target: null, guardAccepts: false }), CAPS, "avance").regle, "D1");
  });

  it("fait absent ou d'un autre type : la règle qui le lit échoue (jamais automatique par défaut)", () => {
    const bad = (value: unknown) => value as never;
    const cases: Array<[Partial<DelegationFacts>, string]> = [
      [{ target: bad({ name: 5, mode: "subagent", internal: false }) }, "D1"],
      [{ target: bad({ name: "explore", mode: "subagent" }) }, "D1"],
      [{ target: bad({ name: "explore", mode: "subagent", internal: "false" }) }, "D1"],
      [{ taskIdInTree: bad(undefined) }, "D2"],
      [{ promptRisk: bad(undefined) }, "D3"],
      [{ promptRisk: "" }, "D3"],
      [{ guardAccepts: bad(undefined) }, "D5"],
      [{ delegationsSoFar: bad("0") }, "D6"],
      [{ remainingUsd: bad("0.9") }, "D7"],
    ];
    for (const [over, regle] of cases) assert.equal(classifyDelegation(delegation(over), CAPS, "avance").regle, regle, JSON.stringify(over));
    for (const delegationsMax of [bad("5"), Number.POSITIVE_INFINITY, 2.5]) {
      assert.equal(classifyDelegation(delegation(), { ...CAPS, delegationsMax }, "avance").regle, "D6", String(delegationsMax));
    }
    assert.deepEqual(classifyDelegation(delegation(), null as unknown as AutonomyCaps, "simple"), { verdict: "refus", regle: "D6" });
  });

  it("faits ou mode illisibles : D1 ; mode inconnu → attente (jamais un refus sans certitude)", () => {
    assert.deepEqual(classifyDelegation(null as unknown as DelegationFacts, CAPS, "simple"), { verdict: "refus", regle: "D1" });
    const inherited = Object.create({ name: "explore", mode: "subagent", internal: false }) as DelegationFacts["target"];
    assert.equal(classifyDelegation(delegation({ target: inherited }), CAPS, "avance").regle, "D1");
    assert.deepEqual(classifyDelegation(delegation({ taskIdInTree: false }), CAPS, "x" as UiMode), { verdict: "attente", regle: "D2" });
  });
});

// --- Activation (§4.10, §4.11) ------------------------------------------------------------------------------------------------

describe("activation : chaque raison de refus (§4.10, §4.11, décisions n° 13 et 14)", () => {
  it("assistant du profil Prudent livré (bash pwd permis), assistant général intégré : activation permise", () => {
    assert.equal(activationRefusal(activation()), null);
    assert.equal(activationRefusal(activation({ agentRules: effectiveBuiltinRules("build", PERMISSION_PRESETS.prudent.permission) })), null);
  });

  it("chaque raison isolée", () => {
    const cases: Array<[Partial<ActivationFacts>, ActivationRefusalCode]> = [
      [{ interrupteur: false }, "autonomie-coupee"],
      [{ activationOuverte: false }, "a-venir"],
      [{ agentRules: effectiveAgentRules(PERMISSION_PRESETS.equilibre.permission, {}) }, "regle-allow"],
      [{ agentRules: null }, "regle-allow"],
      [{ mcpOuExtension: true }, "mcp-ou-extension"],
      [{ profilSansConfirmation: true }, "profil-sans-confirmation"],
      [{ plancherVerifie: false }, "plancher-non-verifie"],
    ];
    for (const [over, code] of cases) assert.equal(activationRefusal(activation(over)), code, JSON.stringify(over));
  });

  it("ordre : interrupteur, porte I1, règle allow, MCP ou extension, profil, plancher", () => {
    const all: Partial<ActivationFacts> = {
      interrupteur: false,
      activationOuverte: false,
      agentRules: null,
      mcpOuExtension: true,
      profilSansConfirmation: true,
      plancherVerifie: false,
    };
    const expected: ActivationRefusalCode[] = ["autonomie-coupee", "a-venir", "regle-allow", "mcp-ou-extension", "profil-sans-confirmation", "plancher-non-verifie"];
    const safe = activation();
    const keys = Object.keys(all) as Array<keyof ActivationFacts>;
    for (let i = 0; i < keys.length; i++) {
      const over: Partial<ActivationFacts> = { ...all };
      for (const key of keys.slice(0, i)) Object.assign(over, { [key]: safe[key] });
      assert.equal(activationRefusal(activation(over)), expected[i]);
    }
  });

  it("valeur non booléenne : refus (jamais permis par défaut)", () => {
    const bad = (value: unknown) => value as never;
    assert.equal(activationRefusal(null as unknown as ActivationFacts), "autonomie-coupee");
    assert.equal(activationRefusal(activation({ interrupteur: bad("true") })), "autonomie-coupee");
    assert.equal(activationRefusal(activation({ interrupteur: bad(undefined) })), "autonomie-coupee");
    assert.equal(activationRefusal(activation({ activationOuverte: bad(1) })), "a-venir");
    assert.equal(activationRefusal(activation({ mcpOuExtension: bad(undefined) })), "mcp-ou-extension");
    assert.equal(activationRefusal(activation({ profilSansConfirmation: bad(null) })), "profil-sans-confirmation");
    assert.equal(activationRefusal(activation({ plancherVerifie: bad("true") })), "plancher-non-verifie");
  });

  it("porte I1 fermée (ACTIVATION_OUVERTE faux) : la phrase fixée par le contrat, exactement", () => {
    const fixed = contractAVenir();
    assert.equal(fixed, "Pas encore disponible dans cette version du cockpit.");
    const code = activationRefusal(activation({ activationOuverte: false }));
    assert.equal(code, "a-venir");
    assert.equal(raisonRefus(code as ActivationRefusalCode), fixed);
  });

  it("règles de l'assistant : dernière règle « * » qui recouvre, exception « bash pwd », motifs de permission, règles illisibles", () => {
    const cases: Array<[Rule[] | null, ReturnType<typeof actsWithoutAsking>]> = [
      [effectiveAgentRules({}, {}), "edit"],
      [effectiveAgentRules(PERMISSION_PRESETS.autonome.permission, {}), "edit"],
      [[rule("*", "*", "allow"), rule("edit", "*", "ask"), rule("bash", "*", "ask"), rule("task", "*", "ask"), rule("web*", "*", "ask")], null],
      [[rule("edit", "*", "allow"), rule("edit", "src/*", "allow"), rule("edit", "*", "ask")], null],
      [[rule("edit", "*", "ask"), rule("edit", "src/*", "allow")], "edit"],
      [[rule("bash", "*", "ask"), rule("bash", "pwd", "allow")], null],
      [[rule("bash", "*", "ask"), rule("bash", "pwd *", "allow")], "bash"],
      [[rule("*", "*", "ask"), rule("edit", "pwd", "allow")], "edit"],
      [[rule("bash", "*", "ask"), rule("bash", "git status", "allow")], "bash"],
      [[rule("task", "general", "allow")], "task"],
      [[rule("web*", "*", "allow")], "webfetch"],
      [[rule("websearch", "*", "allow")], "websearch"],
      [[rule("*", "*", "deny")], null],
      [[rule("edit", "*", "allow"), rule("*", "*", "deny")], null],
      [[rule("external_directory", "*", "allow"), rule("read", "*", "allow")], null],
      [null, "regles-illisibles"],
      [[{ permission: "edit", pattern: "*", action: "toujours" } as unknown as Rule], "regles-illisibles"],
      [[{ permission: 1, pattern: "*", action: "ask" } as unknown as Rule], "regles-illisibles"],
      [[{ permission: "edit", pattern: null, action: "ask" } as unknown as Rule], "regles-illisibles"],
      [[rule("*", "*", "ask"), null as unknown as Rule], "regles-illisibles"],
      [[Object.create({ permission: "edit", pattern: "*", action: "ask" }) as Rule], "regles-illisibles"],
      ["edit" as unknown as Rule[], "regles-illisibles"],
    ];
    for (const [input, expected] of cases) assert.equal(actsWithoutAsking(input), expected, JSON.stringify(input));
  });

  it("phrase de chaque raison : propre au code, jamais la phrase générique ni « itération » ; reprise des raisons des choix sans doublon", () => {
    assert.deepEqual([...ACTIVATION_REFUSAL_CODES].sort(), Object.keys(ALL_ACTIVATION_CODES).sort());
    const phrases = new Set<string>();
    for (const code of ACTIVATION_REFUSAL_CODES) {
      const phrase = raisonRefus(code);
      assert.ok(phrase.length > 0, code);
      assert.notEqual(phrase, CHOIX_TEXTES.partout.raisons.autre, code);
      assert.doesNotMatch(phrase, /it[ée]rations?/iu, code);
      phrases.add(phrase);
      if (code in TEXTES.partout.refusActivation) assert.notEqual(raisonIndisponible(code), phrase, code);
      else assert.equal(phrase, raisonIndisponible(code), code);
    }
    assert.equal(phrases.size, ACTIVATION_REFUSAL_CODES.length);
  });
});

const ALL_ACTIVATION_CODES: Record<ActivationRefusalCode, true> = {
  "a-venir": true,
  "autonomie-coupee": true,
  "regle-allow": true,
  "mcp-ou-extension": true,
  "profil-sans-confirmation": true,
  "plancher-non-verifie": true,
  "racine-de-plan": true,
  "nouvelle-conversation": true,
};

// --- Plafonds (§4.8.1) --------------------------------------------------------------------------------------------------------

describe("plafonds d'une demande (§4.8.1, décision n° 9)", () => {
  it("aucun plafond atteint : null", () => {
    assert.equal(capReached(counters(), CAPS, T0 + 10 * MINUTE), null);
  });

  it("chaque plafond isolé, à sa borne : coût → arrêt ; actions, durée, fichiers → retour à « Demander »", () => {
    const cases: Array<[Partial<RequestCounters>, number, CapHit["plafond"] | null]> = [
      [{ spentUsd: 0.99 }, T0, null],
      [{ spentUsd: 1 }, T0, "cout"],
      [{ auto: 59 }, T0, null],
      [{ auto: 60 }, T0, "actions"],
      [{}, T0 + 30 * MINUTE - 1, null],
      [{}, T0 + 30 * MINUTE, "duree"],
      [{ fichiers: 25 }, T0, null],
      [{ fichiers: 26 }, T0, "fichiers"],
    ];
    for (const [over, now, expected] of cases) assert.equal(capReached(counters(over), CAPS, now)?.plafond ?? null, expected, JSON.stringify([over, now - T0]));
    const effets = Object.fromEntries(CAP_ORDER.map((cap) => {
      const over: Record<string, Partial<RequestCounters>> = { cout: { spentUsd: 2 }, actions: { auto: 99 }, duree: { startedAt: 0 }, fichiers: { fichiers: 99 } };
      const hit = capReached(counters(over[cap]), CAPS, T0) as CapHit;
      return [cap, [hit.effet, hit.fin, hit.cause]];
    }));
    assert.deepEqual(effets, {
      cout: ["arret", "plafond-cout", "plafond-cout"],
      actions: ["retour", "plafond-actions", "plafond-actions"],
      duree: ["retour", "plafond-duree", "plafond-duree"],
      fichiers: ["retour", "plafond-fichiers", "plafond-fichiers"],
    });
  });

  it("ordre : coût, actions, durée, fichiers", () => {
    assert.deepEqual(CAP_ORDER, ["cout", "actions", "duree", "fichiers"]);
    assert.equal(capReached(counters({ spentUsd: 5, auto: 99, fichiers: 99, startedAt: 0 }), CAPS, T0)?.plafond, "cout");
    assert.equal(capReached(counters({ auto: 99, fichiers: 99, startedAt: 0 }), CAPS, T0)?.plafond, "actions");
    assert.equal(capReached(counters({ fichiers: 99, startedAt: 0 }), CAPS, T0)?.plafond, "duree");
  });

  it("compteur, plafond ou heure illisible : plafond atteint (jamais une décision automatique sans vérification)", () => {
    const cases: Array<[RequestCounters, AutonomyCaps, number, CapHit["plafond"]]> = [
      [counters({ spentUsd: Number.NaN }), CAPS, T0, "cout"],
      [counters({ spentUsd: -1 }), CAPS, T0, "cout"],
      [counters({ spentUsd: "0.5" as unknown as number }), CAPS, T0, "cout"],
      [counters(), { ...CAPS, plafondUsd: 0 }, T0, "cout"],
      [counters(), { ...CAPS, plafondUsd: Number.NaN }, T0, "cout"],
      [counters(), { ...CAPS, plafondUsd: "1" as unknown as number }, T0, "cout"],
      [counters(), { ...CAPS, plafondUsd: -1 }, T0, "cout"],
      [counters({ auto: 1.5 }), CAPS, T0, "actions"],
      [counters({ auto: -1 }), CAPS, T0, "actions"],
      [counters(), { ...CAPS, actionsMax: Number.NaN }, T0, "actions"],
      [counters(), { ...CAPS, actionsMax: 0 }, T0, "actions"],
      [counters(), CAPS, Number.NaN, "duree"],
      [counters({ startedAt: Number.NaN }), CAPS, T0, "duree"],
      [counters(), { ...CAPS, dureeMinutes: 0 }, T0, "duree"],
      [counters(), { ...CAPS, dureeMinutes: Number.NaN }, T0, "duree"],
      [counters(), { ...CAPS, dureeMinutes: 1.5 }, T0, "duree"],
      [counters({ fichiers: -1 }), CAPS, T0, "fichiers"],
      [counters({ fichiers: 2.5 }), CAPS, T0, "fichiers"],
      [counters(), { ...CAPS, fichiersMax: 0 }, T0, "fichiers"],
      [counters(), { ...CAPS, fichiersMax: Number.NaN }, T0, "fichiers"],
      [null as unknown as RequestCounters, CAPS, T0, "cout"],
      [counters(), null as unknown as AutonomyCaps, T0, "cout"],
    ];
    for (const [c, caps, now, expected] of cases) assert.equal(capReached(c, caps, now)?.plafond, expected, JSON.stringify([c, caps, now]));
  });
});

// --- Phrases ----------------------------------------------------------------------------------------------------------------

/** Codes que rendent les modules de règles (E, A-, D, R, X, plafonds, porte des commandes). */
function ruleCodes(): string[] {
  const shell = [
    ...["B01", "B02", "B03", "B04", "B05", "C01", "C02", "C03", "O01", "O02", "O03", "O04", "O05", "P01", "P02", "P03", "G04", "U01", "S7"],
    ...Object.keys(SHELL_FORBIDDEN).map((category) => `S4-${category}`),
    "S4-git",
    ...SHELL_CONSULTATION_RULES,
  ];
  return [
    ...editRules.EDIT_RULE_ORDER,
    "A-edit",
    "A-task",
    "A-skill",
    ...DELEGATION_RULE_ORDER,
    "R-web",
    "R-hors-projet",
    "R-lecture",
    "R-repetition",
    "R-autre",
    "R-modifications",
    "X-coupee",
    "X-hors-demande",
    "X-illisible",
    ...CAP_ORDER.map((cap) => (capReached(counters({ cout: { spentUsd: 9 }, actions: { auto: 99 }, duree: { startedAt: 0 }, fichiers: { fichiers: 99 } }[cap]), CAPS, T0) as CapHit).cause),
    ...ACTIVATION_REFUSAL_CODES,
    ...shell,
  ];
}

/** Toutes les feuilles de texte d'un objet. */
function leaves(value: unknown, out: string[] = []): string[] {
  if (typeof value === "string") out.push(value);
  else if (typeof value === "object" && value !== null) for (const item of Object.values(value)) leaves(item, out);
  return out;
}

describe("phrases des règles (« Règle : {phrase} », Journal)", () => {
  it("chaque code rendu par les règles a sa phrase, dans les deux modes et les deux variantes, gabarits remplis", () => {
    const codes = ruleCodes();
    for (const code of codes) {
      for (const mode of MODES) {
        for (const controleIa of [true, false]) {
          const phrase = phraseRegle(code, { mode, controleIa });
          assert.notEqual(phrase, TEXTES.partout.regles.inconnue, `${code} ${mode} ${controleIa}`);
          assert.ok(phrase.length > 0 && !/[{}]/.test(phrase), `${code} : ${phrase}`);
        }
      }
    }
  });

  it("codes rendus par classifyCommand sur des commandes réelles : chacun a sa phrase", () => {
    const commands = ["ls", "cat 'a", "ls | wc", "X=1 ls", "./run", "tail -f x", "curl https://x.invalid", "cat ~/x", "cat ../x", "cat .env", "sort x", "git status", "find . -name x"];
    for (const command of commands) {
      for (const allow of [true, false]) {
        const { regle } = classifyCommand(command, shellCtx(allow));
        assert.notEqual(phraseRegle(regle, { mode: "simple", controleIa: allow }), TEXTES.partout.regles.inconnue, `${command} → ${regle}`);
      }
    }
  });

  it("consultations : liste fermée, égale aux programmes S3 de la porte ; tout autre code « A-… » reste une règle inconnue", () => {
    // Liste des programmes lue dans le source de shell-gate.ts (SIMPLE_COMMANDS n'est pas exporté) : une consultation ajoutée à la
    // porte sans phrase ici fait échouer ce test.
    const gate = fs.readFileSync(path.join(SHARED, "shell-gate.ts"), "utf8");
    const block = /const SIMPLE_COMMANDS\b[^=]*=\s*\{([\s\S]*?)\n\};/u.exec(gate)?.[1] ?? "";
    const programs = [...block.matchAll(/^ {2}(\w+):/gmu)].map((m) => m[1] ?? "");
    assert.ok(programs.length >= 10, programs.join(" "));
    assert.deepEqual([...SHELL_CONSULTATION_PROGRAMS].sort(), programs.sort());
    assert.equal(new Set(SHELL_CONSULTATION_RULES).size, SHELL_CONSULTATION_RULES.length);
    assert.equal(SHELL_CONSULTATION_RULES.length, SHELL_CONSULTATION_PROGRAMS.length + 1 + GIT_CONSULTATION_SUBCOMMANDS.length);

    const args: Record<string, string> = { cat: " a.txt", head: " a.txt", tail: " a.txt", wc: " a.txt", stat: " a.txt", grep: " x a.txt", rg: " x" };
    // git show sans `rév:chemin` montre le patch de HEAD, tiré de l'historique : attente P03 (relecture 2-vague-1).
    const gitArgs: Record<string, string> = { blame: " a.txt", grep: " x", show: " HEAD:a.txt" };
    const commands = [
      ...SHELL_CONSULTATION_PROGRAMS.map((program) => `${program}${args[program] ?? ""}`),
      "find . -name x",
      ...GIT_CONSULTATION_SUBCOMMANDS.map((sub) => `git ${sub}${gitArgs[sub] ?? ""}`),
    ];
    const seen = new Set<string>();
    for (const command of commands) {
      const verdict = classifyCommand(command, shellCtx(true));
      assert.equal(verdict.verdict, "auto", `${command} → ${verdict.regle}`);
      assert.equal(isShellConsultationRule(verdict.regle), true, `${command} → ${verdict.regle}`);
      for (const mode of MODES) assert.equal(phraseRegle(verdict.regle, { mode, controleIa: false }), "Consultation dans le dossier de la conversation", command);
      seen.add(verdict.regle);
    }
    assert.deepEqual([...seen].sort(), [...SHELL_CONSULTATION_RULES].sort());

    for (const code of ["A-", "A-rm", "A-git-push", "A-git-", "A-controle", "A-GREP", "a-grep", "A-grep ", "A-edit2"]) {
      assert.equal(isShellConsultationRule(code), false, code);
      assert.equal(phraseRegle(code, { mode: "simple", controleIa: true }), "Règle inconnue de cette version du cockpit", code);
    }
    assert.equal(isShellConsultationRule(null), false);
  });

  it("phrases exactes : E2 (§4.4), consultation (§4.12), « Règle : » de la carte ; S4 : IA de contrôle non consultée", () => {
    const simple = { mode: "simple", controleIa: true } as const;
    assert.equal(phraseRegle("E2", simple), "Fichier protégé (configuration, CI/CD, infrastructure ou consignes d'IA)");
    assert.equal(regleCarte("E2", simple), "Règle : Fichier protégé (configuration, CI/CD, infrastructure ou consignes d'IA)");
    assert.equal(phraseRegle("A-grep", simple), "Consultation dans le dossier de la conversation");
    assert.equal(phraseRegle("A-edit", simple), "Modification dans le dossier de la conversation");
    for (const category of [...Object.keys(SHELL_FORBIDDEN), "git"]) {
      assert.match(phraseRegle(`S4-${category}`, simple), /\(l'IA de contrôle n'est pas consultée\)$/u, category);
    }
    assert.doesNotMatch(phraseRegle("P03", simple), /IA de contrôle/u);
    assert.equal(phraseRegle("E5", simple), "Plafond de fichiers modifiés atteint : retour à « Demander à chaque fois »");
    assert.equal(phraseRegle("R-modifications", simple), "En « Modifications automatiques », seules les modifications de fichiers passent sans vous demander");
    assert.equal(phraseRegle("a-venir", simple), contractAVenir());
  });

  it("variantes : S7 dit si l'IA de contrôle juge ou si elle est coupée", () => {
    assert.equal(phraseRegle("S7", { mode: "simple", controleIa: true }), "Programme que le cockpit ne connaît pas : jugé par l'IA de contrôle");
    assert.equal(phraseRegle("S7", { mode: "simple", controleIa: false }), "Programme que le cockpit ne connaît pas : le contrôle par IA est coupé");
    assert.equal(variante(true), "avecControleIa");
    assert.equal(variante(false), "sansControleIa");
    // Réglage illisible : la variante prudente, qui n'annonce aucun jugement par l'IA de contrôle.
    for (const value of [undefined, null, 1, "true"]) assert.equal(variante(value as unknown as boolean), "sansControleIa", String(value));
    for (const value of [null, 1, "true"]) assert.equal(descriptionChoix("autonome", value as unknown as boolean), descriptionChoix("autonome", false), String(value));
  });

  it("modes : « agent » et « boucle » en mode Avancé seulement", () => {
    for (const code of ["D1", "R-repetition", "R-autre"]) {
      const simple = phraseRegle(code, { mode: "simple", controleIa: true });
      const avance = phraseRegle(code, { mode: "avance", controleIa: true });
      assert.notEqual(simple, avance, code);
      assert.doesNotMatch(simple, /agents?\b|boucles?|MCP/iu, code);
    }
    assert.match(phraseRegle("D1", { mode: "avance", controleIa: true }), /^Agent /u);
    assert.match(phraseRegle("R-repetition", { mode: "avance", controleIa: true }), /Boucle/u);
  });

  it("code inconnu ou clé du prototype : « Règle inconnue de cette version du cockpit », jamais une phrase inventée", () => {
    for (const code of ["Z99", "constructor", "__proto__", "toString", "hasOwnProperty", "", "S4-inconnue", 5 as unknown as string]) {
      assert.equal(phraseRegle(code, { mode: "avance", controleIa: true }), "Règle inconnue de cette version du cockpit", String(code));
    }
  });
});

describe("phrases des décisions, du bandeau, des plafonds et des fins", () => {
  const demande = { spent: 1.02, plafonds: CAPS };

  it("décisions (§2.1) et « Par » (§4.12), exactes", () => {
    assert.deepEqual(
      (["auto", "attente", "refus-auto", "non-controle"] as const).map(libelleDecision),
      ["Autorisé automatiquement", "En attente de votre accord", "Refusé automatiquement", "Passé sans contrôle"],
    );
    assert.deepEqual((["regles", "ia-controle", "vous", "cockpit"] as const).map(libellePar), ["règles", "IA de contrôle", "vous", "cockpit"]);
    assert.equal(TEXTES.partout.carte.examen, "Contrôle de sécurité en cours…");
    assert.deepEqual([TEXTES.partout.commandes.autoriser, TEXTES.partout.commandes.refuser, TEXTES.partout.commandes.arreter], ["Autoriser une fois", "Refuser…", "Arrêter"]);
    assert.equal(phraseRelais("deja-repondu"), "Déjà répondu par vous.");
    assert.equal(phraseRelais("expiree"), "Demande expirée : opencode ne l'attend plus.");
    assert.equal(phraseRelais("ok"), null);
    assert.equal(phraseRelais("echec"), null);
    assert.equal(quiDelegue("Explorateur de code"), "Explorateur de code (travail délégué)");
  });

  it("bandeau (§4.12) : exemple exact, singulier et pluriel", () => {
    assert.equal(bandeau({ auto: 12, attentes: 1, spent: 0.08, plafondUsd: 1 }), "Autonome avec contrôle · 12 automatiques · 1 en attente · 0,08 $ sur 1,00 $");
    assert.equal(bandeau({ auto: 1, attentes: 0, spent: 0, plafondUsd: 2.5 }), "Autonome avec contrôle · 1 automatique · 0 en attente · 0,00 $ sur 2,50 $");
    assert.equal(bandeau({ auto: 0, attentes: 3, spent: 0.004, plafondUsd: 1 }), "Autonome avec contrôle · 0 automatique · 3 en attente · < 0,01 $ sur 1,00 $");
  });

  it("montants : deux décimales, très petit montant, valeur illisible", () => {
    const cases: Array<[number, string]> = [
      [0, "0,00 $"],
      [0.004, "< 0,01 $"],
      [0.005, "0,01 $"],
      [0.08, "0,08 $"],
      [1, "1,00 $"],
      [12.5, "12,50 $"],
      [Number.NaN, "—"],
      [Number.POSITIVE_INFINITY, "—"],
    ];
    for (const [usd, text] of cases) assert.equal(montant(usd), text, String(usd));
  });

  it("plafond de coût (§4.8.1) : chiffres, dépassement d'un appel par assistant au travail (MX1), jamais « un tour »", () => {
    assert.equal(
      phrasePlafond("cout", demande, "simple"),
      "Arrêtée : plafond d'arrêt atteint (1,02 $ sur 1,00 $). L'appel en cours de chaque assistant au travail peut l'avoir dépassé ; GitHub Copilot peut facturer un appel interrompu.",
    );
    const all = [...leaves(TEXTES), ...leaves(TEXTES_VARIANTES)];
    for (const text of all) assert.doesNotMatch(text, /\bun tour\b/iu, text);
  });

  it("autres plafonds : chiffres ; délégations selon le mode (Simple : refus, Avancé : attente)", () => {
    assert.equal(phrasePlafond("actions", demande, "simple"), "Plafond d'actions automatiques atteint (60) : retour à « Demander à chaque fois ».");
    assert.equal(phrasePlafond("duree", demande, "simple"), "Durée maximale atteinte (30 min) : retour à « Demander à chaque fois ».");
    assert.equal(phrasePlafond("fichiers", demande, "simple"), "Plafond de fichiers modifiés atteint (25) : retour à « Demander à chaque fois ».");
    assert.equal(phrasePlafond("controles", demande, "simple"), "Plafond de contrôles par IA atteint (20) : les commandes à juger attendent votre accord.");
    assert.equal(phrasePlafond("delegations", demande, "simple"), "Plafond de délégations atteint (5) : les suivantes sont refusées et l'IA continue seule.");
    assert.equal(phrasePlafond("delegations", demande, "avance"), "Plafond de délégations atteint (5) : les suivantes attendent votre accord.");
  });

  it("retours à « Demander » (§4.11) : une cause par phrase ; un clic n'en a pas", () => {
    const causes: ChoiceCause[] = ["redemarrage-cockpit", "interrompue", "agent-non-conforme", "plafond-cout", "plafond-actions", "plafond-duree", "plafond-fichiers"];
    const phrases = new Set(causes.map((cause) => phraseRetour(cause)));
    assert.equal(phrases.size, causes.length);
    for (const phrase of phrases) assert.match(phrase ?? "", /^Retour à « Demander à chaque fois » : /u);
    assert.equal(phraseRetour("clic"), null);
  });

  it("fins d'une demande de l'instance principale : « Passé sans contrôle » exact (§6 l.1046) ; plafonds chiffrés", () => {
    const ends: Array<Exclude<RequestEnd, "hors-controle" | "homme-mort" | "recreation" | "plafond-tentatives" | "plafond-sessions">> = [
      "terminee",
      "plafond-cout",
      "plafond-actions",
      "plafond-duree",
      "plafond-fichiers",
      "vous",
      "non-controle",
      "rechargement",
      "redemarrage-cockpit",
      "interrompue",
    ];
    const phrases = new Set(ends.map((fin) => phraseFin(fin, demande)));
    assert.equal(phrases.size, ends.length);
    assert.equal(phraseFin("non-controle", demande), "Passé sans contrôle : la demande a été arrêtée.");
    assert.equal(phraseFin("plafond-cout", demande), phrasePlafond("cout", demande, "simple"));
    assert.equal(phraseFin("plafond-actions", demande), phrasePlafond("actions", demande, "simple"));
  });

  it("IA de contrôle (§4.6) : chaque raison de non-consultation, réponse illisible, délai, décision avec sa raison", () => {
    const codes: Record<ControlAiUnavailableCode, true> = {
      "a-venir": true,
      desactive: true,
      "ia-rapide-absente": true,
      "budget-refuse": true,
      "plafond-controles": true,
      "facturation-suspendue": true,
      "agent-non-installe": true,
    };
    // Même liste que le contrat du port controlAi (contracts-11.ts), dans les deux sens (vérifié par le typage).
    type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
    const sameCodes: Same<ControleIaIndisponible, ControlAiUnavailableCode> = true;
    assert.equal(sameCodes, true);
    assert.deepEqual(Object.keys(TEXTES.partout.controleIa.indisponible).sort(), Object.keys(codes).sort());
    const phrases = new Set<string>();
    for (const code of Object.keys(codes) as ControlAiUnavailableCode[]) {
      const phrase = controleIaIndisponible(code);
      assert.notEqual(phrase, TEXTES.partout.controleIa.illisible, code);
      phrases.add(phrase);
    }
    assert.equal(phrases.size, Object.keys(codes).length);
    assert.equal(controleIaIndisponible("ia-rapide-absente"), "Contrôle par IA indisponible : aucune IA Rapide disponible sur votre compte.");
    assert.equal(controleIaIndisponible("constructor" as ControleIaIndisponible), TEXTES.partout.controleIa.illisible);
    assert.equal(decisionControleIa("illisible"), "Réponse illisible de l'IA de contrôle : en attente de votre accord.");
    assert.equal(decisionControleIa("sans-reponse"), "L'IA de contrôle n'a pas répondu à temps : en attente de votre accord.");
    assert.equal(decisionControleIa({ decision: "autoriser", raison: "lecture seule" }), "Autorisé par l'IA de contrôle : lecture seule");
    assert.equal(decisionControleIa({ decision: "attendre", raison: "{dossier} $&" }), "L'IA de contrôle demande votre accord : {dossier} $&");
  });

  it("raccourci refusé en choix automatique (§4.10) : nomme les deux choix", () => {
    assert.equal(
      raccourciRefuse(),
      "Raccourci refusé : il lance des commandes sans demande (lignes « !` »), refusées en « Modifications automatiques » et en « Autonome avec contrôle ».",
    );
  });
});

describe("confirmations et descriptions : deux variantes de l'IA de contrôle (§4.13, repli §7.4)", () => {
  const values = { dossier: "/workspace/projet", plafondUsd: 1 };
  const common = [
    "Toujours avec votre accord : fichiers protégés, suppressions, hors projet, web, commandes qui exécutent du code ou touchent au réseau, à la production ou à git.",
    "Jamais : ce que l'assistant refuse.",
    "Arrêt automatique à 1,00 $ : l'appel en cours de chaque assistant au travail peut le dépasser un peu ; l'appel qui donne son titre à une nouvelle conversation n'est pas compté.",
    "Certaines actions d'opencode ne passent par aucune demande : le cockpit les repère après coup et arrête la demande.",
  ];

  it("Autonome avec IA de contrôle : textes du §4.13, dépassement ajusté à la mesure (MX1), repérage après coup gardé (M5)", () => {
    assert.deepEqual(confirmationAutonome({ ...values, controleIa: true }), {
      titre: "Laisser l'IA travailler seule dans cette conversation ?",
      lignes: [
        "Sans vous demander : modifier les fichiers de /workspace/projet sauf fichiers protégés ; lancer des commandes de consultation ; faire juger les autres commandes simples par l'IA de contrôle (chaque contrôle est facturé) ; confier du travail dans les plafonds.",
        ...common,
      ],
      lancer: "Lancer en autonome",
      annuler: "Annuler",
    });
  });

  it("Autonome sans IA de contrôle : « les autres commandes attendent votre accord », aucun contrôle facturé annoncé", () => {
    const confirmation = confirmationAutonome({ ...values, controleIa: false });
    assert.deepEqual(confirmation.lignes, [
      "Sans vous demander : modifier les fichiers de /workspace/projet sauf fichiers protégés ; lancer des commandes de consultation ; confier du travail dans les plafonds. Les autres commandes attendent votre accord.",
      ...common,
    ]);
    for (const line of confirmation.lignes) assert.doesNotMatch(line, /IA de contrôle|facturé/u, line);
    assert.equal(confirmation.titre, confirmationAutonome({ ...values, controleIa: true }).titre);
  });

  it("les deux variantes ont la même forme ; un dossier qui contient un gabarit reste tel quel", () => {
    const shape = (value: unknown): unknown =>
      typeof value === "object" && value !== null ? Object.fromEntries(Object.entries(value).map(([k, v]) => [k, shape(v)])) : typeof value;
    assert.deepEqual(shape(TEXTES_VARIANTES.avecControleIa), shape(TEXTES_VARIANTES.sansControleIa));
    assert.deepEqual(shape(CHOIX_VARIANTES.avecControleIa), shape(CHOIX_VARIANTES.sansControleIa));
    assert.match(confirmationAutonome({ dossier: "{plafond}", plafondUsd: 1, controleIa: true }).lignes[0] ?? "", /de \{plafond\} sauf/u);
  });

  it("description d'Autonome : phrase exacte avec l'IA de contrôle (sans doublon), variante sans elle ; les autres choix inchangés", () => {
    assert.equal(descriptionChoix("autonome"), CHOIX_TEXTES.partout.choix.autonome.description);
    assert.equal(descriptionChoix("autonome", true), CHOIX_TEXTES.partout.choix.autonome.description);
    assert.equal(CHOIX_VARIANTES.avecControleIa.partout.descriptions.autonome, CHOIX_TEXTES.partout.choix.autonome.description);
    const sans = descriptionChoix("autonome", false);
    assert.notEqual(sans, descriptionChoix("autonome", true));
    assert.match(sans, /les commandes qu'il ne connaît pas/u);
    assert.doesNotMatch(sans, /IA de contrôle/u);
    for (const choix of ["demander", "modifications", "plan"] as const) assert.equal(descriptionChoix(choix, false), descriptionChoix(choix, true));
  });

  it("Modifications automatiques, première fois : travail délégué nommé en mode Avancé seulement", () => {
    const simple = confirmationModifications({ mode: "simple", dossier: DIR });
    const avance = confirmationModifications({ mode: "avance", dossier: DIR });
    assert.equal(simple.lignes[0], `Sans vous demander : modifier les fichiers de ${DIR} sauf fichiers protégés.`);
    assert.doesNotMatch(simple.lignes.join(" "), /délégu/u);
    assert.match(avance.lignes[1] ?? "", /travail délégué\.$/u);
    assert.deepEqual([simple.activer, simple.annuler, simple.lignes[2]], ["Activer", "Annuler", "Jamais : ce que l'assistant refuse."]);
  });

  it("aucune phrase visible en mode Simple ne dit « itération » (sections simple et partout, deux variantes)", () => {
    const visible = [
      ...leaves(TEXTES.simple),
      ...leaves(TEXTES.partout),
      ...leaves(TEXTES_VARIANTES.avecControleIa.simple),
      ...leaves(TEXTES_VARIANTES.avecControleIa.partout),
      ...leaves(TEXTES_VARIANTES.sansControleIa.simple),
      ...leaves(TEXTES_VARIANTES.sansControleIa.partout),
      ...leaves(CHOIX_VARIANTES),
    ];
    assert.ok(visible.length > 100);
    for (const text of visible) assert.doesNotMatch(text, /it[ée]rations?/iu, text);
  });
});

describe("estimation « en général / au plus » (§6 l.1049)", () => {
  /** Chiffres lus après « En général ≈ » et après « au plus » (ou « arrêt automatique à »). */
  const figures = (text: string | null) => ({
    enGeneral: /En général ≈ ([0-9]+,[0-9]{2}) \$/u.exec(text ?? "")?.[1] ?? null,
    auPlus: /au plus ([0-9]+,[0-9]{2}) \$/u.exec(text ?? "")?.[1] ?? null,
    arret: /arrêt automatique à ([0-9]+,[0-9]{2}) \$/u.exec(text ?? "")?.[1] ?? null,
  });

  it("« en général » porte l'estimation, « au plus » le plafond d'arrêt, dépassement annoncé", () => {
    const text = estimationTexte(0.18, 1);
    assert.equal(text, "En général ≈ 0,18 $ ; au plus 1,00 $ : arrêt automatique à ce montant, l'appel en cours de chaque assistant au travail peut le dépasser un peu.");
    assert.deepEqual(figures(text), { enGeneral: "0,18", auPlus: "1,00", arret: null });
    assert.deepEqual(figures(estimationTexte(1, 1)), { enGeneral: "1,00", auPlus: "1,00", arret: null });
  });

  it("sans plafond d'arrêt : jamais « au plus » (P3)", () => {
    for (const cap of [null, 0, -1, Number.NaN]) {
      const text = estimationTexte(0.18, cap);
      assert.equal(text, "En général ≈ 0,18 $.", String(cap));
      assert.doesNotMatch(text ?? "", /au plus/u);
    }
  });

  it("estimation au-delà du plafond : dite, « au plus » absent, arrêt au plafond", () => {
    const text = estimationTexte(2, 1);
    assert.equal(text, "En général ≈ 2,00 $, plus que le plafond : arrêt automatique à 1,00 $, l'appel en cours de chaque assistant au travail peut le dépasser un peu.");
    assert.deepEqual(figures(text), { enGeneral: "2,00", auPlus: null, arret: "1,00" });
  });

  it("estimation illisible : aucune phrase", () => {
    for (const estimate of [null, Number.NaN, -0.01, Number.POSITIVE_INFINITY]) assert.equal(estimationTexte(estimate, 1), null, String(estimate));
  });
});

// --- Pureté -------------------------------------------------------------------------------------------------------------------

describe("pureté : autonomy-rules.ts et autonomy-texts.ts", () => {
  it("ni module node, ni processus, ni horloge, ni hasard ; imports voisins seulement", () => {
    for (const file of ["autonomy-rules.ts", "autonomy-texts.ts"]) {
      const source = fs.readFileSync(path.join(SHARED, file), "utf8");
      for (const forbidden of ['"node:', "process.", "Date.now", "new Date", "Math.random", "performance.", "globalThis", "require("]) {
        assert.equal(source.includes(forbidden), false, `${file} : ${forbidden}`);
      }
      const imports = [...source.matchAll(/\bfrom\s*["']([^"']+)["']/g)].map((m) => m[1] ?? "");
      assert.ok(imports.length > 0, file);
      for (const spec of imports) assert.match(spec, /^\.\/[\w.-]+\.ts$/, `${file} : ${spec}`);
    }
  });

  it("entrées gelées : aucune écriture, même résultat qu'avec des entrées ordinaires", () => {
    const facts = delegation({ delegationsSoFar: 5 });
    assert.deepEqual(classifyDelegation(deepFreeze(structuredClone(facts)), deepFreeze({ ...CAPS }), "simple"), classifyDelegation(facts, CAPS, "simple"));
    const input = activation({ agentRules: effectiveAgentRules(PERMISSION_PRESETS.equilibre.permission, {}) });
    assert.equal(activationRefusal(deepFreeze(structuredClone(input))), activationRefusal(input));
    assert.deepEqual(capReached(deepFreeze(counters({ auto: 60 })), deepFreeze({ ...CAPS }), T0), capReached(counters({ auto: 60 }), CAPS, T0));
    const hits = capReached(counters({ spentUsd: 3 }), CAPS, T0);
    assert.ok(hits !== null && Object.isFrozen(hits));
    const verdicts: DelegationVerdict[] = [classifyDelegation(facts, CAPS, "avance"), classifyDelegation(facts, CAPS, "avance")];
    assert.deepEqual(verdicts[0], verdicts[1]);
  });
});
