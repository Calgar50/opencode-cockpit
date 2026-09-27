// Tests L15a : validateur de la configuration figée de la Salle OMO (JS-5, porte G14 ; spéc. §3.15.1 ; plan, fiche L15a).
//
// Deux étages :
// 1. `validate-core.mjs`, pur, importé avec ses déclarations (`validate-core.d.mts`) : chaque garde a son cas refusé (nom de
//    hook faux de type chaîne, ralph-loop, joker session_*, clé inconnue, chaque valeur épinglée retirée tour à tour, chaque
//    coupure retirée tour à tour, permission de Prometheus, Team Mode, IA hors github-copilot/*), et la configuration livrée
//    ne produit aucun message.
// 2. `validate.mjs`, lancé en processus enfant sur une arborescence jetable (`--racine`) : version installée exacte, noms
//    présents dans le dist, noms de configuration à la racine du conteneur, configuration réellement lue par l'extension et
//    adresse Copilot au démarrage. Le « dist » y est un texte SYNTHÉTIQUE fait des seuls noms énumérés : aucun fichier ni texte
//    de l'extension n'est lu, téléchargé ni versionné (P13, D-2b-31).
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { parse as parseJsonc, type ParseError } from "jsonc-parser";
import {
  CATEGORIES_4_19_4,
  COPILOT_HOTES,
  ErreurJsonc,
  LISTES_COUPEES,
  NOMS_PRECONTROLE_RACINE,
  type OmoEnumerationsLues,
  actionPour,
  lireJsonc,
  nomPresentDans,
  nomsEnumeres,
  verifierAdresseCopilot,
  verifierEnumerations,
  verifierOmo,
  verifierOpencode,
  verifierTexteOpencode,
} from "../../docker/opencode-omo/validate-core.mjs";
import { OMO_SALLE_CONTRACT_FILE } from "./omo-contracts.ts";
import { COPILOT_API_HOSTS, normalizeCopilotApiUrl } from "./shared/assistant-rules.ts";
import type { OmoSalleContract } from "./shared/omo-types.ts";

const RACINE_DEPOT = path.join(import.meta.dirname, "..", "..");
const DOCKER_OMO = path.join(RACINE_DEPOT, "docker", "opencode-omo");
const VALIDATE = path.join(DOCKER_OMO, "validate.mjs");

const lire = (nom: string): string => fs.readFileSync(path.join(DOCKER_OMO, nom), "utf8");
const ENUMS = JSON.parse(lire("enums-4.19.4.json")) as OmoEnumerationsLues;
const TEXTE_OMO = lire("omo.jsonc");
const TEXTE_OPENCODE = lire("opencode.jsonc");
const CONTRAT = JSON.parse(fs.readFileSync(path.join(RACINE_DEPOT, OMO_SALLE_CONTRACT_FILE), "utf8")) as OmoSalleContract;

type Json = Record<string, unknown>;
/** Copie modifiable de la configuration livrée. */
const omo = (): Json => lireJsonc(TEXTE_OMO) as Json;
const opencode = (): Json => lireJsonc(TEXTE_OPENCODE) as Json;
const objet = (v: unknown): Json => v as Json;
const liste = (v: unknown): unknown[] => v as unknown[];

/** Au moins un message, et l'un d'eux contient `extrait` (le refus a bien la raison attendue). */
function refuse(messages: string[], extrait: string): void {
  assert.ok(messages.length > 0, `refus attendu (${extrait}), aucun message`);
  assert.ok(
    messages.some((m) => m.includes(extrait)),
    `message contenant « ${extrait} » attendu, obtenu :\n${messages.join("\n")}`,
  );
}

// --- validate-core : configuration de l'extension ------------------------------------------------------------------------------

describe("validate-core : omo.jsonc figé (G14, D-2b-47)", () => {
  it("la configuration livrée ne produit aucun message", () => {
    assert.deepEqual(verifierOmo(omo(), ENUMS), []);
  });

  it("un nom de hook faux DE TYPE CHAÎNE est refusé (R2 : le schéma de l'extension l'accepterait et l'ignorerait)", () => {
    const c = omo();
    liste(c.disabled_hooks).push("hook-qui-n-existe-pas");
    refuse(verifierOmo(c, ENUMS), "disabled_hooks : nom hors énumération de la 4.19.4 : hook-qui-n-existe-pas");
  });

  it("ralph-loop est refusé : ce n'est pas un nom de hook de la 4.19.4 (décision du 19/09)", () => {
    const c = omo();
    liste(c.disabled_hooks).push("ralph-loop");
    refuse(verifierOmo(c, ENUMS), "nom hors énumération de la 4.19.4 : ralph-loop");
  });

  it("un joker session_* ou team_* est refusé : disabled_tools compare les noms à l'identique (R1)", () => {
    for (const joker of ["session_*", "team_*"]) {
      const c = omo();
      liste(c.disabled_tools).push(joker);
      refuse(verifierOmo(c, ENUMS), `disabled_tools : nom hors énumération de la 4.19.4 : ${joker}`);
    }
  });

  it("une clé inconnue est refusée, et une clé connue laissée au défaut par l'audit aussi", () => {
    for (const cle of ["cle_inventee", "profiles", "[opencode]"]) {
      const c = omo();
      c[cle] = {};
      refuse(verifierOmo(c, ENUMS), `clé inconnue : ${cle}`);
    }
    for (const cle of ["ralph_loop", "experimental", "$schema", "skills", "websearch"]) {
      const c = omo();
      c[cle] = {};
      refuse(verifierOmo(c, ENUMS), `clé non écrite par la configuration figée (laissée au défaut par l'audit) : ${cle}`);
    }
  });

  it("chaque valeur épinglée retirée tour à tour est refusée", () => {
    const cles = [...Object.keys(ENUMS.valeurs), "categories"];
    assert.ok(cles.length >= 30, `au moins 30 clés épinglées attendues, ${cles.length} trouvées`);
    for (const cle of cles) {
      const c = omo();
      assert.ok(Object.hasOwn(c, cle), `la configuration livrée porte ${cle}`);
      delete c[cle];
      const messages = verifierOmo(c, ENUMS);
      assert.ok(messages.some((m) => m.includes(cle)), `retirer ${cle} doit être refusé : ${messages.join(" | ")}`);
    }
  });

  it("chaque coupure retirée tour à tour d'une liste disabled_* est refusée", () => {
    let essais = 0;
    for (const cle of Object.keys(LISTES_COUPEES)) {
      const noms = liste(omo()[cle]);
      for (const nom of noms) {
        const c = omo();
        c[cle] = liste(c[cle]).filter((n) => n !== nom);
        refuse(verifierOmo(c, ENUMS), `${cle} : coupure manquante : ${String(nom)}`);
        essais += 1;
      }
    }
    // 23 hooks, 32 outils, 5 MCP, 2 agents, 8 compétences, 2 commandes, 25 fournisseurs.
    assert.equal(essais, 97);
  });

  it("un nom connu mais gardé par l'audit, ajouté à une liste, est refusé (liste épinglée à l'identique)", () => {
    const c = omo();
    liste(c.disabled_hooks).push("atlas");
    refuse(verifierOmo(c, ENUMS), "disabled_hooks : nom non coupé par l'audit : atlas");
  });

  it("une entrée non textuelle ou en double est refusée", () => {
    for (const entree of [42, null, {}, ["goal"], true]) {
      const c = omo();
      liste(c.disabled_tools).push(entree);
      refuse(verifierOmo(c, ENUMS), "disabled_tools : entrée non textuelle");
    }
    const c = omo();
    liste(c.disabled_mcps).push("lsp");
    refuse(verifierOmo(c, ENUMS), "disabled_mcps : nom en double : lsp");
    const d = omo();
    d.disabled_agents = "librarian";
    refuse(verifierOmo(d, ENUMS), "disabled_agents : liste attendue");
  });

  it("une valeur épinglée changée est refusée", () => {
    const changements: [string, (c: Json) => void][] = [
      ["goal", (c) => (objet(c.goal).enabled = true)],
      ["background_task", (c) => (objet(c.background_task).defaultConcurrency = 3)],
      ["hashline_edit", (c) => (c.hashline_edit = true)],
      ["codegraph", (c) => (objet(c.codegraph).auto_provision = true)],
      ["start_work", (c) => (objet(c.start_work).auto_commit = true)],
      ["claude_code", (c) => (objet(c.claude_code).hooks = true)],
      ["auto_update", (c) => (c.auto_update = true)],
      ["agent_definitions", (c) => (c.agent_definitions = ["./agents/x.md"])],
      ["tmux", (c) => (objet(c.tmux).enabled = true)],
    ];
    for (const [cle, changer] of changements) {
      const c = omo();
      changer(c);
      refuse(verifierOmo(c, ENUMS), `valeur épinglée différente : ${cle}`);
    }
  });

  it("Team Mode rallumé est refusé, avec sa raison (Q5)", () => {
    const c = omo();
    objet(c.team_mode).enabled = true;
    refuse(verifierOmo(c, ENUMS), "Team Mode doit rester coupé");
  });

  it("la permission de Prometheus est exigée à l'identique (JS-3), et rien d'autre dans sa section", () => {
    const a = omo();
    objet(objet(objet(a.agents).prometheus).permission).bash = "allow";
    refuse(verifierOmo(a, ENUMS), "permission de Prometheus différente");
    const b = omo();
    delete objet(objet(b.agents).prometheus).permission;
    refuse(verifierOmo(b, ENUMS), "permission de Prometheus différente");
    const c = omo();
    objet(objet(c.agents).prometheus).tools = { bash: true };
    refuse(verifierOmo(c, ENUMS), "agents.prometheus : champ refusé : tools");
    const d = omo();
    objet(objet(d.agents).sisyphus).permission = { bash: "allow" };
    refuse(verifierOmo(d, ENUMS), "agents.sisyphus : champ refusé : permission");
  });

  it("toute IA hors github-copilot/* est refusée, pour chaque agent et chaque catégorie (G3)", () => {
    for (const agent of ENUMS.agents) {
      const c = omo();
      objet(objet(c.agents)[agent]).model = "anthropic/claude-opus-4";
      refuse(verifierOmo(c, ENUMS), `IA hors github-copilot/* : agents.${agent}.model`);
    }
    for (const categorie of CATEGORIES_4_19_4) {
      const c = omo();
      objet(objet(c.categories)[categorie]).model = "openai/gpt-5";
      refuse(verifierOmo(c, ENUMS), `IA hors github-copilot/* : categories.${categorie}.model`);
    }
    const e = omo();
    objet(objet(e.agents).oracle).model = "github-copilot/../x";
    refuse(verifierOmo(e, ENUMS), "IA hors github-copilot/* : agents.oracle.model");
  });

  it("chaque agent et chaque catégorie doivent avoir leur IA ; aucun agent ni catégorie inventés", () => {
    for (const agent of ENUMS.agents) {
      const c = omo();
      delete objet(objet(c.agents)[agent]).model;
      refuse(verifierOmo(c, ENUMS), `agents.${agent} : IA non épinglée`);
    }
    for (const categorie of CATEGORIES_4_19_4) {
      const c = omo();
      delete objet(c.categories)[categorie];
      refuse(verifierOmo(c, ENUMS), `categories.${categorie} : IA non épinglée`);
    }
    const a = omo();
    objet(a.agents).athena = { model: "github-copilot/claude-sonnet-5" };
    refuse(verifierOmo(a, ENUMS), "agent hors énumération de la 4.19.4 : athena");
    const b = omo();
    objet(b.categories).maison = { model: "github-copilot/claude-sonnet-5" };
    refuse(verifierOmo(b, ENUMS), "catégorie hors des catégories intégrées de la 4.19.4 : maison");
    const d = omo();
    objet(objet(d.categories).quick).description = "texte";
    refuse(verifierOmo(d, ENUMS), "categories.quick : champ refusé : description");
  });

  it("aucune liste d'IA de secours, où qu'elle soit (model_fallback coupé)", () => {
    const c = omo();
    objet(objet(c.categories).deep).fallback_models = ["github-copilot/gpt-5.4-mini"];
    refuse(verifierOmo(c, ENUMS), "liste d'IA de secours refusée : categories.deep.fallback_models");
  });

  it("des énumérations mal formées ou d'une autre version font tout refuser", () => {
    refuse(verifierOmo(omo(), { ...ENUMS, version: "4.19.5" }), "énumérations d'une autre version");
    refuse(verifierOmo(omo(), { ...ENUMS, hooks: undefined }), "famille hooks absente ou mal formée");
    refuse(verifierOmo(omo(), { ...ENUMS, outils: ["grep", 3] }), "famille outils absente ou mal formée");
    refuse(verifierOmo(omo(), null), "énumérations illisibles");
    assert.deepEqual(verifierEnumerations(ENUMS), []);
  });
});

// --- validate-core : lecture JSONC ---------------------------------------------------------------------------------------------

describe("validate-core : lecture JSONC stricte", () => {
  it("lit commentaires, chaînes qui en contiennent, BOM", () => {
    const texte = '﻿// tête\n{ /* bloc */ "a": "http://x // pas un commentaire /* non plus */", "b": [1, -2.5e3, true, null] }\n';
    assert.deepEqual(lireJsonc(texte), { a: "http://x // pas un commentaire /* non plus */", b: [1, -2500, true, null] });
  });

  it("refuse clé en double, clé dangereuse, virgule finale, commentaire non fermé, texte en trop", () => {
    for (const texte of [
      '{"a": 1, "a": 2}',
      '{"__proto__": {"x": 1}}',
      '{"constructor": 1}',
      '{"a": 1,}',
      '{"a": [1, 2,]}',
      '{"a": 1} /* fin',
      '{"a": 1} {"b": 2}',
      "{'a': 1}",
      '{"a": 01}',
    ]) {
      assert.throws(() => lireJsonc(texte), ErreurJsonc, texte);
    }
  });

  it("lit les deux configurations livrées exactement comme jsonc-parser (lecteur d'opencode et de l'extension)", () => {
    for (const texte of [TEXTE_OMO, TEXTE_OPENCODE]) {
      const erreurs: ParseError[] = [];
      const reference = parseJsonc(texte, erreurs, { allowTrailingComma: false, disallowComments: false }) as unknown;
      assert.deepEqual(erreurs, []);
      assert.deepEqual(lireJsonc(texte), reference);
    }
  });
});

// --- validate-core : configuration d'instance d'opencode ----------------------------------------------------------------------------

describe("validate-core : opencode.jsonc de la salle", () => {
  it("la configuration livrée ne produit aucun message", () => {
    assert.deepEqual(verifierTexteOpencode(TEXTE_OPENCODE), []);
    assert.deepEqual(verifierOpencode(opencode()), []);
  });

  it("aucune autre substitution que l'adresse Copilot, même en commentaire (GET /config rend le résultat)", () => {
    refuse(verifierTexteOpencode(`// {env:OPENCODE_SERVER_PASSWORD}\n${TEXTE_OPENCODE}`), "seule substitution permise");
    refuse(verifierTexteOpencode(`// {file:/auth-src/auth.json}\n${TEXTE_OPENCODE}`), "substitution {file:…} refusée");
    refuse(verifierTexteOpencode(TEXTE_OPENCODE.replace("{env:COCKPIT_COPILOT_API_URL}", "https://api.githubcopilot.com")), "seule substitution permise");
  });

  it("chaque valeur d'instance est exigée à l'identique", () => {
    const changements: [string, (c: Json) => void][] = [
      ["snapshot", (c) => delete c.snapshot],
      ["snapshot", (c) => (c.snapshot = true)],
      ["lsp", (c) => (c.lsp = true)],
      ["formatter", (c) => delete c.formatter],
      ["share", (c) => (c.share = "manual")],
      ["autoupdate", (c) => (c.autoupdate = "notify")],
      ["enabled_providers", (c) => liste(c.enabled_providers).push("openai")],
      ["disabled_providers", (c) => (c.disabled_providers = [])],
      ["plugin", (c) => (c.plugin = liste(c.plugin).toReversed())],
      ["plugin", (c) => (c.plugin = liste(c.plugin).slice(0, 1))],
    ];
    for (const [cle, changer] of changements) {
      const c = opencode();
      changer(c);
      refuse(verifierOpencode(c), `opencode.jsonc : ${cle} =`);
    }
    const d = opencode();
    d.mcp = {};
    refuse(verifierOpencode(d), "opencode.jsonc : clé refusée : mcp");
  });

  it("fournisseur : Copilot seul, adresse par la variable, aucun secret ni détour dans les options ou les IA déclarées", () => {
    const a = opencode();
    objet(objet(objet(a.provider)["github-copilot"]).options).apiKey = "x";
    refuse(verifierOpencode(a), "provider.github-copilot.options doit être exactement");
    const b = opencode();
    objet(b.provider).openai = {};
    refuse(verifierOpencode(b), "provider doit porter github-copilot seul");
    const c = opencode();
    objet(objet(objet(objet(c.provider)["github-copilot"]).models)["claude-sonnet-5"]).headers = { a: "b" };
    refuse(verifierOpencode(c), "IA déclarée claude-sonnet-5 : champ refusé : headers");
    const d = opencode();
    d.model = "github-copilot/gpt-9";
    refuse(verifierOpencode(d), "model non déclarée dans provider.github-copilot.models");
    const e = opencode();
    e.small_model = "openai/gpt-5-mini";
    refuse(verifierOpencode(e), "small_model hors github-copilot/*");
  });

  it("permissions : webfetch, websearch, external_directory et grep refusés ; edit, bash et task demandés", () => {
    // grep : règles par motif d'autrefois (évaluées sur l'expression cherchée, jamais sur un fichier), « allow » ou absent → refusés.
    const reglesGrep = { "*": "allow", ".env*": "deny", "*.pem": "deny", "*.env.example": "allow" };
    for (const [cle, valeur] of [
      ["webfetch", "allow"],
      ["websearch", "ask"],
      ["external_directory", undefined],
      ["grep", "allow"],
      ["grep", "ask"],
      ["grep", undefined],
      ["grep", reglesGrep],
      ["bash", "allow"],
      ["task", "allow"],
    ] as const) {
      const c = opencode();
      if (valeur === undefined) delete objet(c.permission)[cle];
      else objet(c.permission)[cle] = valeur;
      refuse(verifierOpencode(c), `permission.${cle} =`);
    }
    const d = opencode();
    objet(d.permission).skill = "allow";
    refuse(verifierOpencode(d), "permission refusée : skill");
  });

  it("permissions de fichiers : chaque refus exigé, .env.example jamais refusé, ordre des règles tenu", () => {
    const a = opencode();
    delete objet(objet(a.permission).read)[".env*"];
    refuse(verifierOpencode(a), "permission.read : motif non refusé : .env*");
    const b = opencode();
    objet(objet(b.permission).edit)["*.pem"] = "ask";
    refuse(verifierOpencode(b), "permission.edit : motif non refusé : *.pem");
    const c = opencode();
    objet(objet(c.permission).edit)["src/*"] = "allow";
    refuse(verifierOpencode(c), "permission.edit : action \"allow\" refusée pour src/*");
    // .env.example remis à la base AVANT les refus : la dernière règle qui correspond (.env*) le refuserait.
    const d = opencode();
    const lecture = objet(objet(d.permission).read);
    delete lecture[".env*"];
    lecture[".env*"] = "deny";
    refuse(verifierOpencode(d), "permission.read : dernière règle attendue");
    refuse(verifierOpencode(d), "permission.read : .env.example devrait rester à allow");
    const e = opencode();
    objet(e.permission).glob = "allow";
    refuse(verifierOpencode(e), "permission.glob : règles par motif attendues");
  });

  it("la dernière règle qui correspond l'emporte (portage d'opencode)", () => {
    assert.equal(actionPour({ "*": "allow", ".env*": "deny", "*.env.example": "allow" }, ".env.example"), "allow");
    assert.equal(actionPour({ "*": "allow", "*.env.example": "allow", ".env*": "deny" }, ".env.example"), "deny");
    assert.equal(actionPour({}, "x"), "ask");
  });
});

// --- validate-core : adresse Copilot, noms -------------------------------------------------------------------------------------

describe("validate-core : adresse Copilot de la salle (MO-6)", () => {
  it("mêmes hôtes que le cockpit", () => {
    assert.deepEqual([...COPILOT_HOTES], [...COPILOT_API_HOSTS]);
  });

  it("accepte les adresses que le cockpit accepte", () => {
    for (const adresse of [
      "https://api.githubcopilot.com",
      "https://api.business.githubcopilot.com/",
      "https://api.enterprise.githubcopilot.com",
      "https://api.individual.githubcopilot.com",
      " https://api.githubcopilot.com ",
      "https://copilot-api.ghe.exemple.fr",
    ]) {
      assert.deepEqual(verifierAdresseCopilot(adresse), [], adresse);
    }
    for (const hote of COPILOT_API_HOSTS) assert.notEqual(normalizeCopilotApiUrl(`https://${hote}`), null);
  });

  it("refuse une adresse absente, vide, en clair, avec port, chemin, identifiants ou hôte inconnu", () => {
    for (const adresse of [
      undefined,
      "",
      "   ",
      "http://api.githubcopilot.com",
      "https://api.githubcopilot.com:8443",
      "https://api.githubcopilot.com/v1",
      "https://jeton@api.githubcopilot.com",
      "https://api.githubcopilot.com?x=1",
      "https://exemple.com",
      "https://api.githubcopilot.com.exemple.com",
      "https://copilot-api.",
      "pas une adresse",
    ]) {
      assert.ok(verifierAdresseCopilot(adresse).length > 0, String(adresse));
    }
  });
});

describe("validate-core : noms", () => {
  it("un nom n'est trouvé que comme mot entier", () => {
    assert.equal(nomPresentDans('x("goal")', "goal"), true);
    assert.equal(nomPresentDans("goals", "goal"), false);
    assert.equal(nomPresentDans("team_create_x", "team_create"), false);
    assert.equal(nomPresentDans("x-goal", "goal"), false);
    assert.equal(nomPresentDans("session_list:", "session_*"), false);
  });

  it("noms à chercher : toutes les familles de L20 et les huit catégories", () => {
    const noms = nomsEnumeres(ENUMS);
    const attendu =
      ENUMS.hooks.length + ENUMS.outils.length + ENUMS.mcps.length + ENUMS.competences.length + ENUMS.commandes.length + ENUMS.agents.length + ENUMS.fournisseursCoupes.length + 8;
    assert.equal(noms.length, attendu);
    assert.equal(CATEGORIES_4_19_4.length, 8);
  });

  it("noms refusés à la racine du conteneur = nomsPrecontrole du contrat", () => {
    assert.deepEqual([...NOMS_PRECONTROLE_RACINE.fichiers], CONTRAT.nomsPrecontrole.fichiers);
    assert.deepEqual([...NOMS_PRECONTROLE_RACINE.dossiers], CONTRAT.nomsPrecontrole.dossiers);
  });
});

// --- validate.mjs, en processus enfant --------------------------------------------------------------------------------------------

interface Racine {
  dir: string;
  poser(chemin: string, contenu: string): void;
  retirer(chemin: string): void;
}

/**
 * Arborescence d'image jetable : énumérations et configurations livrées, `package.json` et `dist` SYNTHÉTIQUES (les seuls noms
 * énumérés, un par ligne), et, pour le démarrage, la configuration lue par l'extension.
 */
function racineJetable(t: { after(fn: () => void): void }, { demarrage = false, distSans = "" } = {}): Racine {
  const dir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "omo-l15a-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const ici = (chemin: string) => path.join(dir, ...chemin.split("/").filter(Boolean));
  const racine: Racine = {
    dir,
    poser(chemin, contenu) {
      fs.mkdirSync(path.dirname(ici(chemin)), { recursive: true });
      fs.writeFileSync(ici(chemin), contenu);
    },
    retirer(chemin) {
      fs.rmSync(ici(chemin), { recursive: true, force: true });
    },
  };
  racine.poser("/opt/omo-check/enums-4.19.4.json", lire("enums-4.19.4.json"));
  racine.poser("/etc/opencode-omo/omo/omo.jsonc", TEXTE_OMO);
  racine.poser("/etc/opencode-omo/opencode.jsonc", TEXTE_OPENCODE);
  racine.poser("/opt/omo/node_modules/oh-my-openagent/package.json", JSON.stringify({ name: "oh-my-openagent", version: "4.19.4" }));
  const noms = nomsEnumeres(ENUMS)
    .map(({ nom }) => nom)
    .filter((nom) => nom !== distSans);
  racine.poser("/opt/omo/node_modules/oh-my-openagent/dist/index.js", `// dist synthétique du test\n${noms.map((n) => JSON.stringify(n)).join("\n")}\n`);
  if (demarrage) racine.poser("/home/node/.omo/omo.jsonc", TEXTE_OMO);
  return racine;
}

function valider(racine: Racine, args: string[], env: Record<string, string> = {}): { code: number | null; sortie: string; erreurs: string } {
  const propre = Object.fromEntries(Object.entries(process.env).filter(([cle]) => cle !== "COCKPIT_COPILOT_API_URL"));
  const r = spawnSync(process.execPath, [VALIDATE, "--racine", racine.dir, ...args], { encoding: "utf8", env: { ...propre, ...env }, timeout: 30_000 });
  return { code: r.status, sortie: r.stdout, erreurs: r.stderr };
}

const ADRESSE = { COCKPIT_COPILOT_API_URL: "https://api.githubcopilot.com" };

describe("validate.mjs : arborescence jetable (processus enfant)", () => {
  it("construction : configuration livrée conforme, code 0", (t) => {
    const r = valider(racineJetable(t), ["--construction"]);
    assert.equal(r.code, 0, r.erreurs);
    assert.match(r.sortie, /configuration conforme, oh-my-openagent 4\.19\.4/);
  });

  // Un processus par cas coûte ≈ 70 ms de démarrage : les écarts indépendants sont réunis dans une même arborescence, et chaque
  // message attendu est vérifié à part (retirer une garde fait disparaître son message, donc échouer le test).
  it("extension d'une autre version, nom énuméré disparu du dist installé (R3) : refus, chaque écart nommé", (t) => {
    const racine = racineJetable(t, { distSans: "session_list" });
    racine.poser("/opt/omo/node_modules/oh-my-openagent/package.json", JSON.stringify({ name: "oh-my-openagent", version: "4.19.5" }));
    const r = valider(racine, ["--construction"]);
    assert.equal(r.code, 1);
    assert.match(r.erreurs, /attendu oh-my-openagent@4\.19\.4 exactement/);
    assert.match(r.erreurs, /nom absent du dist installé \(outils\) : session_list/);
  });

  it("dist absent : refus", (t) => {
    const racine = racineJetable(t);
    racine.retirer("/opt/omo/node_modules/oh-my-openagent/dist");
    const r = valider(racine, ["--construction"]);
    assert.equal(r.code, 1);
    assert.match(r.erreurs, /dist[\\/]index\.js absent/);
  });

  it("noms de configuration à la racine du conteneur : chacun refusé (fichier ou dossier)", (t) => {
    const racine = racineJetable(t);
    const noms = ["/.omo/omo.jsonc", "/oh-my-opencode.json", "/opencode.json", "/.claude/settings.json", "/.agents/skills/x/SKILL.md"];
    for (const nom of noms) racine.poser(nom, "{}");
    const r = valider(racine, ["--construction"]);
    assert.equal(r.code, 1);
    for (const vu of ["/.omo/omo.jsonc", "/oh-my-opencode.json", "/opencode.json", "/.claude", "/.agents"]) {
      assert.ok(r.erreurs.includes(`nom de configuration présent à la racine du conteneur : ${vu}\n`), vu);
    }
  });

  it("omo.jsonc faussé (nom de hook faux) : la construction échoue (G14, -SelfTest)", (t) => {
    const racine = racineJetable(t);
    racine.poser("/etc/opencode-omo/omo/omo.jsonc", TEXTE_OMO.replace('"goal",\n', '"goal",\n    "ralph-loop",\n'));
    const r = valider(racine, ["--construction"]);
    assert.equal(r.code, 1);
    assert.match(r.erreurs, /omo\.jsonc : disabled_hooks : nom hors énumération de la 4\.19\.4 : ralph-loop/);
  });

  it("démarrage : configuration lue par l'extension et adresse Copilot exigées", (t) => {
    const complet = valider(racineJetable(t, { demarrage: true }), [], ADRESSE);
    assert.equal(complet.code, 0, complet.erreurs);
    assert.match(complet.sortie, /démarrage/);

    // Sans configuration effective ni adresse : les deux refus.
    const sans = valider(racineJetable(t), []);
    assert.equal(sans.code, 1);
    assert.match(sans.erreurs, /configuration lue par l'extension absente : \/home\/node\/\.omo\/omo\.jsonc/);
    assert.match(sans.erreurs, /COCKPIT_COPILOT_API_URL absente ou vide/);

    // Configuration effective différente, omo.json à côté, adresse en clair : trois refus.
    const faussee = racineJetable(t, { demarrage: true });
    faussee.poser("/home/node/.omo/omo.jsonc", `${TEXTE_OMO}\n`);
    faussee.poser("/home/node/.omo/omo.json", "{}");
    const r = valider(faussee, [], { COCKPIT_COPILOT_API_URL: "http://api.githubcopilot.com" });
    assert.equal(r.code, 1);
    assert.match(r.erreurs, /différente de la référence de l'image/);
    assert.match(r.erreurs, /omo\.json présent/);
    assert.match(r.erreurs, /COCKPIT_COPILOT_API_URL refusée/);
  });

  it("argument inconnu ou --racine sans dossier : erreur d'usage (code 2)", () => {
    for (const args of [["--inconnu"], ["--racine"]]) {
      const r = spawnSync(process.execPath, [VALIDATE, ...args], { encoding: "utf8", timeout: 30_000 });
      assert.equal(r.status, 2, args.join(" "));
    }
  });
});
