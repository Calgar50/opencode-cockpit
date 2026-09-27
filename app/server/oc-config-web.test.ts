// T1 de la migration du web 1.0.x → 1.1.0 (décision A37, fiche MW §6) : planificateur pur de server/oc-config-web.ts, sans aucun
// fichier ni processus. Cas a à u de la fiche, sauf n (croisement PERMISSION_PRESETS_1_0 exporté ↔ PERMISSION_PRESETS, écrit par
// MW-b). Au train de V2, les copies locales de MW-a ont été remplacées par les fonctions partagées de shared/assistant-rules.ts
// (MW-b) ; le croisement planificateur ↔ legacyPresetOf est dans croisements-f2-v2.test.ts.
//
// Ce qui est vérifié ici tient aux octets : chaque bascule remplace exactement un jeton « "ask" » (ou « "allow" » d'un profil
// 1.0) par « "deny" », à sa place, et rien d'autre ne change (commentaires, CRLF, virgules finales, adresse Copilot). Les
// profils 1.0 sont écrits ici en clair : c'est la liste attendue, pas celle que le code déclare.
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import { applyEdits, modify, parse as parseJsonc } from "jsonc-parser";
import { NOMS_GLOBAUX, OCTETS_MAX, planWebMigration, UNITES_MAX, verifierMigration } from "./oc-config-web.ts";
import {
  configProviderIssues,
  detectPermissionPreset,
  legacyPresetOf,
  masque,
  PERMISSION_PRESET_IDS,
  PERMISSION_PRESETS,
  type PermissionPresetId,
  peutDemander,
  rulesFromConfig,
} from "./shared/assistant-rules.ts";

const SERVER_DIR = import.meta.dirname;
const RACINE = path.join(SERVER_DIR, "..", "..");
const octets = (...parts: string[]) => fs.readFileSync(path.join(...parts));
const sha256 = (data: Uint8Array) => crypto.createHash("sha256").update(data).digest("hex");

/** Fichier livré de la 1.0.0 à la 1.0.6 (d804e1f:docker/opencode/opencode.default.jsonc), à l'octet. */
const FIXTURE_106 = octets(SERVER_DIR, "test-support", "oc-config-1.0.6.jsonc");
const TEXTE_106 = FIXTURE_106.toString("utf8");
/** Défaut de la 0.1.0 (git status, git diff… autorisés), à l'octet. */
const FIXTURE_010 = octets(SERVER_DIR, "test-support", "oc-config-0.1.0.jsonc");
const TEXTE_010 = FIXTURE_010.toString("utf8");

/** Profils livrés jusqu'à la 1.0.x, en clair (T1 n, écrit par MW-b, les croise avec PERMISSION_PRESETS_1_0 exporté). */
const PROFILS_1_0: Readonly<Record<PermissionPresetId, Record<string, unknown>>> = {
  prudent: { edit: "ask", bash: { "*": "ask", pwd: "allow" }, task: "ask", webfetch: "ask", websearch: "ask" },
  equilibre: { edit: "allow", bash: "ask", task: "ask", webfetch: "ask", websearch: "ask" },
  autonome: { edit: "allow", bash: "allow", task: "allow", webfetch: "allow", websearch: "allow" },
};

const CRLF = String.fromCharCode(13, 10);
const BOM = Uint8Array.from([0xef, 0xbb, 0xbf]);
const lire = (texte: string) => parseJsonc(texte, [], { allowTrailingComma: true }) as Record<string, unknown>;
const permissionDe = (texte: string) => lire(texte).permission as Record<string, unknown>;
const plan = (texte: string | Uint8Array, nom = "opencode.jsonc") => planWebMigration({ [nom]: texte });
/** Comme replacePermission (http.ts) : modify() du bloc entier, 2 espaces. */
const ecritCommeLeCockpit = (source: string, permission: unknown) =>
  applyEdits(source, modify(source, ["permission"], permission, { formattingOptions: { insertSpaces: true, tabSize: 2 } }));
/** Texte attendu : `source` avec les jetons indiqués remplacés, un par un, à leur première occurrence. */
function avecJetons(source: string, remplacements: ReadonlyArray<readonly [string, string]>): string {
  let texte = source;
  for (const [avant, apres] of remplacements) {
    assert.ok(texte.includes(avant), `jeton absent du texte de départ : ${avant}`);
    texte = texte.replace(avant, apres);
  }
  return texte;
}
function exigerConformeAuSecondPassage(texte: string, restes = 0) {
  const second = plan(texte);
  assert.equal(second.etat, "conforme");
  assert.equal(second.texte, texte, "second passage : texte identique");
  assert.equal(second.restes, restes);
  assert.equal(second.blocs, 0);
}

describe("T1 (a, b) : fichier livré de la 1.0.0 à la 1.0.6", () => {
  it("(a) empreinte de la fixture vérifiée ; Prudent 1.1, exactement deux jetons « ask » → « deny », verrou fournisseurs intact ; second passage conforme", () => {
    assert.equal(sha256(FIXTURE_106), "c95fa212a3596c9216669f80ba9c366349b470b96a5746f12cecf40735dd10ec");
    const p = plan(FIXTURE_106);
    assert.deepEqual(
      { etat: p.etat, raison: p.raison, fichier: p.fichier, profil: p.profil, blocs: p.blocs, restes: p.restes },
      { etat: "migre", raison: "-", fichier: "opencode.jsonc", profil: "prudent", blocs: 1, restes: 0 },
    );
    assert.deepEqual(p.bascules, [
      ["permission", "webfetch"],
      ["permission", "websearch"],
    ]);
    const attendu = avecJetons(TEXTE_106, [
      ['"webfetch": "ask"', '"webfetch": "deny"'],
      ['"websearch": "ask"', '"websearch": "deny"'],
    ]);
    assert.equal(p.texte, attendu);
    assert.equal(p.texte?.length, TEXTE_106.length + 2, "deux jetons de 5 octets devenus 6");
    assert.deepEqual(permissionDe(attendu), PERMISSION_PRESETS.prudent.permission);
    assert.equal(detectPermissionPreset(permissionDe(attendu)), "prudent");
    assert.deepEqual(configProviderIssues(lire(TEXTE_106), ["github-copilot"]), []);
    assert.deepEqual(configProviderIssues(lire(attendu), ["github-copilot"]), []);
    exigerConformeAuSecondPassage(attendu);
  });

  it("(b) adresse Copilot (provider.github-copilot.options.baseURL) et clé voisine intactes, à l'octet", () => {
    const fournisseur =
      '  "provider": {\n    "github-copilot": {\n      "options": { "baseURL": "https://api.business.githubcopilot.com", "apiKey": "cle-factice-du-banc" }\n    }\n  },\n';
    const source = TEXTE_106.replace('  "lsp": false,', `${fournisseur}  "lsp": false,`);
    assert.notEqual(source, TEXTE_106);
    const p = plan(source);
    assert.equal(p.etat, "migre");
    assert.equal(p.profil, "prudent");
    assert.ok(p.texte?.includes(fournisseur), "bloc du fournisseur inchangé");
    assert.deepEqual(lire(p.texte ?? "").provider, lire(source).provider);
    assert.deepEqual(configProviderIssues(lire(p.texte ?? ""), ["github-copilot"]), []);
  });
});

describe("T1 (c, e) : profils 1.0 et mélanges 1.0/1.1 → le MÊME profil 1.1", () => {
  for (const id of PERMISSION_PRESET_IDS) {
    it(`(c) ${id} 1.0 écrit comme replacePermission, puis dans le désordre → ${id} 1.1, en place`, () => {
      for (const ordre of ["livré", "désordre"] as const) {
        const profil = PROFILS_1_0[id];
        const permission = ordre === "livré" ? profil : Object.fromEntries(Object.entries(profil).reverse());
        const source = ecritCommeLeCockpit(TEXTE_106, permission);
        const p = plan(source);
        assert.equal(p.etat, "migre", `${id} (${ordre})`);
        assert.equal(p.profil, id);
        assert.equal(p.blocs, 1);
        assert.equal(p.restes, 0);
        const apres = permissionDe(p.texte ?? "");
        assert.deepEqual(apres, PERMISSION_PRESETS[id].permission);
        assert.equal(detectPermissionPreset(apres), id, "jamais « Personnalisé »");
        // En place : mêmes clés, dans le même ordre ; seules les valeurs web changent.
        assert.deepEqual(Object.keys(apres), Object.keys(permission));
        exigerConformeAuSecondPassage(p.texte ?? "");
      }
    });
  }

  it("(c) « Sans confirmation » 1.0 (web sur « allow ») reste « autonome » : les deux « allow » passent ensemble à « deny »", () => {
    const p = plan(ecritCommeLeCockpit(TEXTE_106, PROFILS_1_0.autonome));
    assert.equal(p.profil, "autonome");
    assert.equal((p.texte?.match(/"allow"/g) ?? []).length, 3, "edit, bash et task gardés sur « allow »");
    assert.equal(detectPermissionPreset(permissionDe(p.texte ?? "")), "autonome");
  });

  it("(e) mélanges 1.0/1.1 → profil 1.1 exact (Prudent : un seul « ask » ; Sans confirmation : webfetch deny, websearch allow)", () => {
    const cas: Array<[PermissionPresetId, Record<string, unknown>]> = [
      ["prudent", { ...PROFILS_1_0.prudent, webfetch: "deny" }],
      ["prudent", { ...PROFILS_1_0.prudent, websearch: "deny" }],
      ["prudent", { ...PROFILS_1_0.prudent, webfetch: "allow", websearch: "deny" }],
      ["autonome", { ...PROFILS_1_0.autonome, webfetch: "deny" }],
      ["equilibre", { ...PROFILS_1_0.equilibre, webfetch: "allow" }],
    ];
    for (const [id, permission] of cas) {
      const p = plan(ecritCommeLeCockpit(TEXTE_106, permission));
      assert.equal(p.etat, "migre", JSON.stringify(permission));
      assert.equal(p.profil, id);
      const nonDeny = ["webfetch", "websearch"].filter((outil) => permission[outil] !== "deny");
      assert.deepEqual(p.bascules, nonDeny.map((outil) => ["permission", outil]), "seules les valeurs qui n'étaient pas « deny » changent");
      assert.deepEqual(permissionDe(p.texte ?? ""), PERMISSION_PRESETS[id].permission);
      assert.equal(detectPermissionPreset(permissionDe(p.texte ?? "")), id);
    }
  });

  it("legacyPresetOf (partagée, R4) : profil 1.0 ou mélange → id ; profil 1.1, web absent ou valeur objet → null", () => {
    for (const id of PERMISSION_PRESET_IDS) {
      assert.equal(legacyPresetOf(PROFILS_1_0[id]), id);
      assert.equal(legacyPresetOf(PERMISSION_PRESETS[id].permission), null, `${id} 1.1`);
    }
    assert.equal(legacyPresetOf({ ...PROFILS_1_0.prudent, websearch: undefined }), null);
    const { websearch: _sansRecherche, ...sansWebsearch } = PROFILS_1_0.prudent;
    assert.equal(legacyPresetOf(sansWebsearch), null, "les deux clés doivent exister");
    assert.equal(legacyPresetOf({ ...PROFILS_1_0.prudent, webfetch: { "*": "ask" } }), null, "valeur objet");
    assert.equal(legacyPresetOf({ ...PROFILS_1_0.prudent, bash: "ask" }), null, "hors web, égalité exigée");
    assert.equal(legacyPresetOf("ask"), null);
  });
});

describe("T1 (d, f, j, t) : réglages personnalisés, seuls les « ask » existants du web", () => {
  it("(d) défaut de la 0.1.0 (empreinte vérifiée) : seul le web change, toutes les règles bash gardées, profil Personnalisé", () => {
    assert.equal(sha256(FIXTURE_010), "470392b89872c649a2e63734dd5ef842a12c24d9ec6499f0ef3689bc8590edf7");
    const p = plan(FIXTURE_010);
    assert.equal(p.etat, "migre");
    assert.equal(p.profil, "-");
    assert.equal(p.blocs, 1);
    assert.equal(p.restes, 0);
    assert.equal(
      p.texte,
      avecJetons(TEXTE_010, [
        ['"webfetch": "ask"', '"webfetch": "deny"'],
        ['"websearch": "ask"', '"websearch": "deny"'],
      ]),
    );
    const avant = permissionDe(TEXTE_010);
    const apres = permissionDe(p.texte ?? "");
    assert.deepEqual(apres.bash, avant.bash);
    assert.equal(apres.edit, "ask");
    assert.equal(detectPermissionPreset(apres), null);
    exigerConformeAuSecondPassage(p.texte ?? "");
  });

  it("(f) commentaires dans et hors du bloc, CRLF construit, virgules finales : identique à l'octet hors des jetons", () => {
    const lignes = (valeurFetch: string, valeurSearch: string) =>
      [
        "{ // tête",
        '  "$schema": "https://opencode.ai/config.json", /* bloc */',
        '  "permission": {',
        "    // avant les règles",
        '    "edit": "ask", /* règle */',
        `    "webfetch": /* avant la valeur */ ${valeurFetch}, // après`,
        `    "websearch":${valeurSearch},`,
        '    "bash": { "*": "ask", "git status": "allow", },',
        "  },",
        '  "enabled_providers": ["github-copilot",],',
        "}",
        "",
      ].join(CRLF);
    const source = lignes('"ask"', '"ask"');
    const p = plan(source);
    assert.equal(p.etat, "migre");
    assert.equal(p.profil, "-");
    assert.equal(p.texte, lignes('"deny"', '"deny"'));
    assert.equal(p.texte?.split(CRLF).length, source.split(CRLF).length, "CRLF gardés");
    exigerConformeAuSecondPassage(p.texte ?? "");
  });

  it("(f) jeton écrit avec un échappement : la plage entière du nœud est remplacée", () => {
    const echappe = `"${String.fromCharCode(92)}u0061sk"`;
    const source = `{"permission": {"edit": "ask", "webfetch": ${echappe}, "websearch": "ask"}}\n`;
    const p = plan(source);
    assert.equal(p.etat, "migre");
    assert.equal(p.texte, `{"permission": {"edit": "ask", "webfetch": "deny", "websearch": "deny"}}\n`);
  });

  it("(j) « allow » personnalisé, clé absente, bloc absent : texte identique, aucune clé ajoutée", () => {
    for (const source of [
      '{\n  "permission": { "edit": "ask", "webfetch": "allow", "websearch": "allow" }\n}\n',
      '{\n  "permission": { "edit": "ask" }\n}\n',
      '{\n  "permission": { "edit": "ask", "websearch": "ask" }\n}\n',
      '{\n  "$schema": "https://opencode.ai/config.json"\n}\n',
    ]) {
      const p = plan(source);
      if (source.includes('"websearch": "ask"')) {
        // Seule la clé qui existe bascule ; webfetch, absent, n'est pas ajouté (« * »: allow par défaut, aucune demande).
        assert.equal(p.etat, "migre");
        assert.equal(p.texte, source.replace('"websearch": "ask"', '"websearch": "deny"'));
        assert.equal(p.texte?.includes("webfetch"), false);
        continue;
      }
      assert.equal(p.etat, "conforme", source);
      assert.equal(p.texte, source);
      assert.equal(p.restes, 0);
    }
  });

  it("(t) opencode.json seul et config.json seul : bascule en place, mise en forme gardée", () => {
    const source = '{\n\t"permission": {\n\t\t"edit": "ask",\n\t\t"webfetch": "ask",\n\t\t"websearch": "ask"\n\t}\n}\n';
    for (const nom of ["opencode.json", "config.json"] as const) {
      const p = plan(source, nom);
      assert.equal(p.etat, "migre");
      assert.equal(p.fichier, nom);
      assert.equal(p.texte, source.replace('"webfetch": "ask"', '"webfetch": "deny"').replace('"websearch": "ask"', '"websearch": "deny"'));
    }
    assert.deepEqual([...NOMS_GLOBAUX], ["opencode.jsonc", "opencode.json", "config.json"]);
  });
});

describe("T1 (g, h, r, s, u) : efficacité outil par outil (R6, simulation R12)", () => {
  const perm = (bloc: string) => `{\n  "permission": ${bloc}\n}\n`;

  it("(g) « * » à ask APRÈS webfetch → bascule abandonnée, comptée dans restes ; texte identique", () => {
    const source = perm('{ "websearch": "ask", "webfetch": "ask", "*": "ask" }');
    const p = plan(source);
    assert.equal(p.etat, "conforme");
    assert.equal(p.texte, source);
    assert.equal(p.restes, 2);
  });

  it("(g) « * » à ask AVANT webfetch → bascule efficace", () => {
    const source = perm('{ "*": "ask", "webfetch": "ask", "websearch": "ask" }');
    const p = plan(source);
    assert.equal(p.etat, "migre");
    assert.equal(p.restes, 0);
    assert.equal(p.texte, perm('{ "*": "ask", "webfetch": "deny", "websearch": "deny" }'));
  });

  it("(g) joker à motifs « * »: { « https://* »: ask } après webfetch → webfetch reste, websearch (placé après) basculé : outil par outil", () => {
    const source = perm('{ "webfetch": "ask", "*": { "https://*": "ask" }, "websearch": "ask" }');
    const p = plan(source);
    assert.equal(p.etat, "migre");
    assert.deepEqual(p.bascules, [["permission", "websearch"]]);
    assert.equal(p.restes, 1);
    assert.equal(p.texte, perm('{ "webfetch": "ask", "*": { "https://*": "ask" }, "websearch": "deny" }'));
    // (u) rejeu de cette migration partielle : conforme, même reste, texte identique.
    exigerConformeAuSecondPassage(p.texte ?? "", 1);
  });

  it("(g) joker nommé « web* » à ask après webfetch → reste", () => {
    const source = perm('{ "webfetch": "ask", "web*": "ask" }');
    const p = plan(source);
    assert.equal(p.etat, "conforme");
    assert.equal(p.restes, 2);
    assert.equal(p.texte, source);
  });

  it("(h) « permission »: « ask » (texte) → conforme, restes 2, texte identique", () => {
    const source = '{\n  "permission": "ask"\n}\n';
    const p = plan(source);
    assert.deepEqual({ etat: p.etat, restes: p.restes, blocs: p.blocs, texte: p.texte }, { etat: "conforme", restes: 2, blocs: 0, texte: source });
  });

  it("(r) { « * »: ask, webfetch: ask } sans websearch → webfetch basculé, restes 1", () => {
    const p = plan(perm('{ "*": "ask", "webfetch": "ask" }'));
    assert.equal(p.etat, "migre");
    assert.equal(p.texte, perm('{ "*": "ask", "webfetch": "deny" }'));
    assert.equal(p.restes, 1);
  });

  it("(s) tools { webfetch: false } avec « * » à ask : tools placé DEVANT le bloc, la bascule de webfetch n'est plus efficace", () => {
    const sansTools = plan(perm('{ "*": "ask", "webfetch": "ask" }'));
    assert.equal(sansTools.etat, "migre", "témoin sans tools");
    const source = `{\n  "tools": { "webfetch": false },\n  "permission": { "*": "ask", "webfetch": "ask" }\n}\n`;
    const p = plan(source);
    assert.equal(p.etat, "conforme");
    assert.equal(p.texte, source);
    assert.equal(p.restes, 2);
    // Au niveau d'un agent (Object.assign d'opencode) : même placement.
    const agent = `{\n  "agent": { "x": { "tools": { "webfetch": false }, "permission": { "*": "ask", "webfetch": "ask" } } }\n}\n`;
    const pa = plan(agent);
    assert.equal(pa.etat, "conforme");
    assert.equal(pa.restes, 2);
  });

  it("peutDemander et masque (partagées, R6) : motif quelconque compté, dernière règle « * » deny = masqué", () => {
    const regles = rulesFromConfig({ webfetch: "deny", "*": { "https://*": "ask" } });
    assert.equal(peutDemander(regles, "webfetch"), true);
    assert.equal(masque(regles, "webfetch"), false);
    const fermees = rulesFromConfig({ "*": { "https://*": "ask" }, webfetch: "deny" });
    assert.equal(peutDemander(fermees, "webfetch"), false);
    assert.equal(masque(fermees, "webfetch"), true);
    const motifSeul = rulesFromConfig({ webfetch: "ask", "*": { "https://exemple": "allow" } });
    assert.equal(peutDemander(motifSeul, "webfetch"), true, "une règle à motif ne couvre pas toutes les adresses");
    assert.equal(masque(motifSeul, "webfetch"), false);
  });
});

describe("T1 (i) : agent.<nom> et mode.<nom>, fondus comme opencode les fond", () => {
  it("(i) agent.x et mode.y à ask → deny ; blocs comptés un par un", () => {
    const source =
      '{\n  "permission": { "edit": "ask" },\n  "agent": { "x": { "permission": { "webfetch": "ask" } } },\n  "mode": { "y": { "permission": { "websearch": "ask" } } }\n}\n';
    const p = plan(source);
    assert.equal(p.etat, "migre");
    assert.equal(p.blocs, 2);
    assert.equal(p.restes, 0);
    assert.deepEqual(p.bascules, [
      ["agent", "x", "permission", "webfetch"],
      ["mode", "y", "permission", "websearch"],
    ]);
    assert.equal(p.texte, source.replace('"webfetch": "ask"', '"webfetch": "deny"').replace('"websearch": "ask"', '"websearch": "deny"'));
  });

  it("(i) agent avec « * » à ask seul → restes (demande propre à l'agent), rien d'écrit", () => {
    const source = '{\n  "agent": { "z": { "permission": { "*": "ask" } } }\n}\n';
    const p = plan(source);
    assert.equal(p.etat, "conforme");
    assert.equal(p.restes, 2);
  });

  it("(i) un agent qui HÉRITE de la demande du global n'est pas compté en plus", () => {
    const source = '{\n  "permission": "ask",\n  "agent": { "a": { "permission": { "edit": "deny" } }, "b": {} }\n}\n';
    assert.equal(plan(source).restes, 2);
  });

  it("(i) mode.w fondu dans agent.w (le mode l'emporte, ses clés neuves après) : la bascule de agent.w.webfetch n'est plus efficace", () => {
    const source =
      '{\n  "agent": { "w": { "permission": { "webfetch": "ask" } } },\n  "mode": { "w": { "permission": { "*": "ask" } } }\n}\n';
    const p = plan(source);
    assert.equal(p.etat, "conforme");
    assert.equal(p.texte, source);
    assert.equal(p.restes, 2);
    // Dans l'autre sens, la bascule de mode.v.webfetch est placée après le « * » de agent.v : efficace, websearch reste.
    const inverse =
      '{\n  "agent": { "v": { "permission": { "*": "ask" } } },\n  "mode": { "v": { "permission": { "webfetch": "ask" } } }\n}\n';
    const q = plan(inverse);
    assert.equal(q.etat, "migre");
    assert.deepEqual(q.bascules, [["mode", "v", "permission", "webfetch"]]);
    assert.equal(q.restes, 1);
  });

  it("(i) agent par-dessus le global migré : un global Prudent 1.0 et un agent sans règle web → global seul basculé", () => {
    const source = ecritCommeLeCockpit(TEXTE_106, PROFILS_1_0.prudent).replace('  "lsp": false,', '  "agent": { "relecteur": { "permission": { "edit": "deny" } } },\n  "lsp": false,');
    const p = plan(source);
    assert.equal(p.etat, "migre");
    assert.equal(p.blocs, 1);
    assert.equal(p.restes, 0);
  });
});

describe("T1 (k, l, m, o, p, q) : refus de sûreté, rien n'est écrit", () => {
  it("(k) doublons décodés : permission (y compris échappé), webfetch, agent, mode, nom d'agent → cle-en-double", () => {
    const antislash = String.fromCharCode(92);
    for (const source of [
      '{ "permission": { "edit": "ask" }, "permission": { "webfetch": "ask" } }',
      `{ "permission": { "webfetch": "ask" }, "perm${antislash}u0069ssion": { "webfetch": "allow" } }`,
      '{ "permission": { "webfetch": "ask", "websearch": "ask", "webfetch": "allow" } }',
      '{ "agent": {}, "agent": { "x": { "permission": { "webfetch": "ask" } } } }',
      '{ "mode": { "y": {} }, "mode": {} }',
      '{ "agent": { "x": { "permission": { "webfetch": "ask" } }, "x": {} } }',
      '{ "permission": { "bash": { "*": "ask", "*": "allow" } } }',
      '{ "tools": { "webfetch": true, "webfetch": false } }',
    ]) {
      const p = plan(source);
      assert.deepEqual({ etat: p.etat, raison: p.raison, texte: p.texte }, { etat: "non-migre", raison: "cle-en-double", texte: null }, source);
    }
  });

  it("(l) BOM, UTF-8 invalide, erreur d'analyse, racine tableau ou vide → illisible", () => {
    const avecBom = new Uint8Array([...BOM, ...Buffer.from('{ "permission": { "webfetch": "ask" } }')]);
    const invalide = new Uint8Array([...Buffer.from('{ "permission": "'), 0xc3, 0x28, ...Buffer.from('" }')]);
    for (const source of [avecBom, invalide, '{ "permission": ', "[]", "", "  // rien\n", '"texte"']) {
      const p = plan(source);
      assert.deepEqual({ etat: p.etat, raison: p.raison, texte: p.texte }, { etat: "non-migre", raison: "illisible", texte: null }, String(source));
    }
  });

  it("(m) deux fichiers, fichier hérité « config » → plusieurs-fichiers ; aucun → absent ; défaut 1.1 → conforme", () => {
    const deux = planWebMigration({ "opencode.jsonc": FIXTURE_106, "opencode.json": "{}" });
    assert.deepEqual({ etat: deux.etat, raison: deux.raison, fichier: deux.fichier, texte: deux.texte }, { etat: "non-migre", raison: "plusieurs-fichiers", fichier: "-", texte: null });
    const herite = planWebMigration({ "opencode.jsonc": FIXTURE_106, config: { empechement: "non-lu" } });
    assert.equal(herite.raison, "plusieurs-fichiers");
    assert.equal(planWebMigration({ config: { empechement: "non-lu" } }).raison, "plusieurs-fichiers", "config seul aussi (TOML fusionné en dernier)");
    const absent = planWebMigration({});
    assert.deepEqual({ etat: absent.etat, raison: absent.raison, fichier: absent.fichier, profil: absent.profil, blocs: absent.blocs, restes: absent.restes }, {
      etat: "absent",
      raison: "-",
      fichier: "-",
      profil: "-",
      blocs: 0,
      restes: 0,
    });
    const defaut11 = octets(RACINE, "docker", "opencode", "opencode.default.jsonc");
    assert.equal(sha256(defaut11), "1e3e5b6564406ca4fc92ea4646b40835de81872197f0ccadb57ca8dcc7ac982a");
    const p = plan(defaut11);
    assert.deepEqual({ etat: p.etat, profil: p.profil, restes: p.restes, blocs: p.blocs }, { etat: "conforme", profil: "-", restes: 0, blocs: 0 });
    assert.equal(p.texte, defaut11.toString("utf8"));
  });

  it("(m) entrée présente mais lien, dossier ou fichier spécial → lien-ou-special ; trop grosse → trop-gros", () => {
    assert.equal(planWebMigration({ "opencode.jsonc": { empechement: "lien-ou-special" } }).raison, "lien-ou-special");
    assert.equal(planWebMigration({ "opencode.jsonc": { empechement: "lien-ou-special" } }).fichier, "opencode.jsonc");
    assert.equal(planWebMigration({ "opencode.json": { empechement: "trop-gros" } }).raison, "trop-gros");
    // Un TEXTE qui vaudrait l'un de ces mots n'est pas pris pour un empêchement : il est analysé (et illisible).
    assert.equal(planWebMigration({ "opencode.jsonc": "lien-ou-special" }).raison, "illisible");
    const non = planWebMigration({ "opencode.jsonc": { empechement: "non-lu" } });
    assert.deepEqual({ etat: non.etat, raison: non.raison }, { etat: "erreur", raison: "interne" });
  });

  it("R3 : plus de 1 Mio, ou plus de 262 144 unités UTF-16 → trop-gros, avant toute analyse", () => {
    assert.equal(OCTETS_MAX, 1_048_576);
    assert.equal(UNITES_MAX, 262_144);
    const gros = new Uint8Array(OCTETS_MAX + 1).fill(0x20);
    assert.equal(plan(gros).raison, "trop-gros");
    const unites = `{ "x": "${"a".repeat(UNITES_MAX)}" }`;
    assert.ok(Buffer.byteLength(unites) <= OCTETS_MAX);
    assert.equal(plan(unites).raison, "trop-gros");
  });

  it("(o) « {env: » et « {file: » n'importe où, commentaires compris → inhabituel", () => {
    for (const source of [
      '{ "permission": { "webfetch": "ask" }, "provider": { "x": { "options": { "apiKey": "{env:CLE}" } } } }',
      '{ "permission": { "webfetch": "ask" } } // {file:~/secret}',
      '{ /* {env:X} */ "permission": "ask" }',
    ]) {
      const p = plan(source);
      assert.deepEqual({ etat: p.etat, raison: p.raison, texte: p.texte }, { etat: "non-migre", raison: "inhabituel", texte: null }, source);
    }
  });

  it("(p) clés piégées (« * »×24+« z », 60 étoiles, 257 caractères) → inhabituel en moins d'1 s, dans le bloc, un motif ou tools", () => {
    const pieges = ["*".repeat(24) + "z", "*".repeat(60), "a".repeat(257), "?".repeat(17)];
    for (const cle of pieges) {
      for (const source of [
        `{ "permission": { "webfetch": "ask", ${JSON.stringify(cle)}: "ask" } }`,
        `{ "permission": { "webfetch": "ask", "bash": { ${JSON.stringify(cle)}: "ask" } } }`,
        `{ "agent": { "x": { "permission": { "webfetch": "ask", ${JSON.stringify(cle)}: "deny" } } } }`,
        `{ "tools": { ${JSON.stringify(cle)}: false }, "permission": { "webfetch": "ask" } }`,
      ]) {
        const debut = performance.now();
        const p = plan(source);
        const duree = performance.now() - debut;
        assert.equal(p.raison, "inhabituel", `${cle.slice(0, 30)}… : ${p.etat} ${p.raison}`);
        assert.equal(p.texte, null);
        assert.ok(duree < 1000, `${Math.round(duree)} ms`);
      }
    }
    // Aux bornes exactes : accepté (16 jokers, 256 caractères).
    assert.equal(plan(`{ "permission": { ${JSON.stringify("*".repeat(16))}: "deny", ${JSON.stringify("b".repeat(256))}: "ask", "webfetch": "ask" } }`).etat, "migre");
  });

  it("(p) valeur de permission ni texte ni objet → inhabituel", () => {
    for (const source of ['{ "permission": 5 }', '{ "permission": null }', '{ "permission": ["ask"] }', '{ "agent": { "x": { "permission": true } } }']) {
      assert.equal(plan(source).raison, "inhabituel", source);
    }
  });

  it("(q) « __proto__ » : n'ajoute ni ne lit rien, texte identique, aucun prototype touché", () => {
    for (const source of [
      '{ "permission": { "edit": "ask", "__proto__": { "webfetch": "ask" } } }',
      '{ "__proto__": { "permission": { "webfetch": "ask" } } }',
      '{ "agent": { "__proto__": { "permission": { "webfetch": "ask" } } } }',
      '{ "agent": { "x": { "__proto__": { "permission": { "webfetch": "ask" } } } } }',
      '{ "permission": { "bash": { "__proto__": "ask" } } }',
    ]) {
      const p = plan(source);
      assert.notEqual(p.etat, "migre", source);
      assert.equal(p.bascules.length, 0);
      assert.ok(p.texte === source || p.texte === null, source);
    }
    assert.equal((Object.prototype as Record<string, unknown>).webfetch, undefined);
    assert.equal((Object.prototype as Record<string, unknown>).permission, undefined);
  });
});

describe("R7 : contrôle octet (verifierMigration), fermé en cas de doute", () => {
  const source = '{\n  // garde\n  "permission": { "edit": "ask", "webfetch": "ask", "websearch": "ask" }\n}\n';
  const bon = plan(source);

  it("le plan écrit passe le contrôle ; toute différence hors des jetons, une valeur autre que « deny » ou un jeton d'origine autre que « ask » est refusée", () => {
    assert.equal(bon.etat, "migre");
    const texte = bon.texte ?? "";
    assert.equal(verifierMigration(source, texte, bon.bascules, null), true);
    assert.equal(verifierMigration(source, texte.replace("// garde", "// gardé"), bon.bascules, null), false, "commentaire changé");
    assert.equal(verifierMigration(source, texte.replace('"websearch": "deny"', '"websearch": "allow"'), bon.bascules, null), false, "allow au lieu de deny");
    assert.equal(verifierMigration(source, texte.replace('"edit": "ask"', '"edit": "deny"'), bon.bascules, null), false, "valeur hors web changée");
    assert.equal(verifierMigration(source, texte.replace("}\n}", ', "webfetch": "deny" }\n}'), bon.bascules, null), false, "clé ajoutée");
    assert.equal(verifierMigration(source.replace('"webfetch": "ask"', '"webfetch": "allow"'), texte, bon.bascules, null), false, "jeton d'origine « allow » hors profil");
    assert.equal(verifierMigration(source, texte, [["permission", "webfetch"]], null), false, "bascule non déclarée");
  });

  it("profil 1.0 : le bloc doit égaler le profil 1.1 et detectPermissionPreset rendre le même id", () => {
    const prudent = ecritCommeLeCockpit(TEXTE_106, PROFILS_1_0.prudent);
    const p = plan(prudent);
    assert.equal(verifierMigration(prudent, p.texte ?? "", p.bascules, "prudent"), true);
    assert.equal(verifierMigration(prudent, p.texte ?? "", p.bascules, "equilibre"), false);
  });
});

describe("banc e2e « --volume-1-0-6 » : graine et attendu", () => {
  it("le planificateur appliqué à la graine donne l'attendu migré à l'octet ; la graine est le fichier de la 1.0.6 hors fournisseur du banc", () => {
    const graine = octets(RACINE, "e2e", "lib", "opencode-volume-1.0.6.jsonc");
    const attendu = octets(RACINE, "e2e", "lib", "opencode-volume-1.0.6.migre.jsonc").toString("utf8");
    const p = plan(graine);
    assert.deepEqual({ etat: p.etat, profil: p.profil, blocs: p.blocs, restes: p.restes }, { etat: "migre", profil: "prudent", blocs: 1, restes: 0 });
    assert.equal(p.texte, attendu);
    // Hors du fournisseur du banc (levier M-B1), la graine est la 1.0.6 à l'octet.
    const sansBanc = graine
      .toString("utf8")
      .replace('"enabled_providers": ["banc"]', '"enabled_providers": ["github-copilot"]')
      .replace(/ {2}\/\/ Banc e2e, option[\s\S]*?\n {2}},\n/, "");
    assert.equal(sansBanc, TEXTE_106);
  });
});
