// Tests de croisement du train de la vague 2 de F2 (plan d'exécution it5 §8 ; fiche de la migration du web §8 et §10 ; décision
// A37) : L39o, MW-b et MW-a réunis sur `chantier/1.1`. Chaque paquet garde ses tests ; ici, seulement ce qui ne se voit QU'UNE FOIS
// les trois paquets réunis :
//   1. une seule source : le planificateur de la migration (MW-a, oc-config-web.ts) n'a plus de copie locale de legacyPresetOf ni
//      de peutDemander, il importe celles de shared/assistant-rules.ts (MW-b) ; le mémo facultatif de peutDemander ne change jamais
//      la réponse, qui suit à la lettre la règle R6 de la fiche ;
//   2. planificateur ↔ legacyPresetOf : même profil lu sur les fixtures 1.0.6 et 0.1.0, les trois profils 1.0 et leurs mélanges ;
//      un profil 1.0 devient le MÊME profil 1.1 (T1 n : PERMISSION_PRESETS_1_0 exporté, croisé avec PERMISSION_PRESETS) ;
//   3. 422 ↔ migration ↔ signalement, sur les mêmes blocs : la migration n'introduit jamais d'ouverture (elle ne serait donc jamais
//      refusée par le 422) ; ce qui peut encore demander après elle (restes, peutDemander) est une ouverture pour webOpenings et
//      est signalé par webAskAgents (global une fois, assistants dont la demande est la leur) ;
//   4. banc : la graine 1.0.6 migrée à l'octet ne demande plus rien, et mw-api-volume-106 EXIGE security.webIssues =
//      { global: false, assistants: [] } depuis que MW-b est là ;
//   5. carte : CarteTab.tsx garde les six blocs c5:vue-ensemble de L48 à l'identique et la section l39o:salle-omo, jamais imbriqués.
// Aucun appel réseau, aucun processus : fonctions pures et lectures de sources.
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import { parse as parseJsonc } from "jsonc-parser";
import { planWebMigration } from "./oc-config-web.ts";
import {
  cleHorsBornes,
  configWebOpenings,
  detectPermissionPreset,
  effectiveAgentRules,
  legacyPresetOf,
  memoRegles,
  opencodeDefaultPermission,
  PERMISSION_PRESET_IDS,
  PERMISSION_PRESETS,
  PERMISSION_PRESETS_1_0,
  peutDemander,
  type Rule,
  rulesFromConfig,
  securiteProfil,
  WEB_TOOLS,
  type WebAgentLite,
  webAskAgents,
  webOpenings,
  webOpeningsIntroduced,
  wildcardMatch,
} from "./shared/assistant-rules.ts";

const SERVER_DIR = import.meta.dirname;
const APP_DIR = path.join(SERVER_DIR, "..");
const RACINE = path.join(APP_DIR, "..");
const lire = (...parts: string[]) => fs.readFileSync(path.join(...parts), "utf8");

type Objet = Record<string, unknown>;
const isObjet = (v: unknown): v is Objet => typeof v === "object" && v !== null && !Array.isArray(v);
const own = (o: unknown, k: string): unknown => (isObjet(o) && Object.hasOwn(o, k) ? o[k] : undefined);
const sansWeb = (bloc: Readonly<Objet>) => Object.fromEntries(Object.entries(bloc).filter(([k]) => k !== "webfetch" && k !== "websearch"));

/** Fichier de configuration minimal, JSON pur : `permission` et, au besoin, des agents. */
function fichier(permission: unknown, agents?: Record<string, unknown>): string {
  const config: Objet = {};
  if (permission !== undefined) config.permission = permission;
  if (agents) config.agent = Object.fromEntries(Object.entries(agents).map(([nom, p]) => [nom, { permission: p }]));
  return `${JSON.stringify(config, null, 2)}\n`;
}

const planDe = (texte: string) => planWebMigration({ "opencode.jsonc": texte });

/** Configuration servie après la migration : le texte écrit (« migre »), sinon le texte lu. */
function apres(texte: string): Objet {
  const p = planDe(texte);
  const servi = p.etat === "migre" ? (p.texte ?? "") : texte;
  const config = parseJsonc(servi, [], { allowTrailingComma: true });
  assert.ok(isObjet(config));
  return config;
}

/** Clés BRUTES d'un bloc `permission` (clés de permission et de motif), telles qu'écrites dans la configuration. */
function clesBrutes(bloc: unknown): string[] {
  if (!isObjet(bloc)) return [];
  return Object.entries(bloc).flatMap(([cle, valeur]) => [cle, ...(isObjet(valeur) ? Object.keys(valeur) : [])]);
}

/**
 * Référence R6, écrite depuis la fiche (§2 R3 et R6) et non depuis le code : une clé hors bornes → vrai sans rien évaluer. Les bornes
 * se mesurent sur les clés BRUTES (`brutes`), comme lireArbre, jamais sur les motifs développés par expandHome (relecture
 * F2-vague-2 : une clé « ~/ » + 248 caractères, dans les bornes, fait 259 caractères une fois développée).
 */
function peutDemanderReference(regles: readonly Rule[], brutes: readonly string[], outil: string): boolean {
  if (brutes.some(cleHorsBornes)) return true;
  return regles.some(
    (r, i) =>
      wildcardMatch(outil, r.permission) &&
      r.action === "ask" &&
      !regles.slice(i + 1).some((s) => wildcardMatch(outil, s.permission) && s.pattern === "*"),
  );
}

/** Blocs `permission` du croisement : profils 1.0, 1.1, mélanges, réglages personnalisés et jokers. */
const BLOCS: ReadonlyArray<[string, unknown]> = [
  ...PERMISSION_PRESET_IDS.map((id): [string, unknown] => [`${id} 1.0`, PERMISSION_PRESETS_1_0[id]]),
  ...PERMISSION_PRESET_IDS.map((id): [string, unknown] => [`${id} 1.1`, PERMISSION_PRESETS[id].permission]),
  ["prudent mélange (webfetch deny, websearch ask)", { ...PERMISSION_PRESETS.prudent.permission, websearch: "ask" }],
  ["autonome mélange (webfetch deny, websearch allow)", { ...PERMISSION_PRESETS.autonome.permission, websearch: "allow" }],
  ["équilibré mélange (webfetch allow, websearch deny)", { ...PERMISSION_PRESETS.equilibre.permission, webfetch: "allow" }],
  ["prudent 1.0 dans le désordre", { websearch: "ask", task: "ask", webfetch: "ask", bash: { pwd: "allow", "*": "ask" }, edit: "ask" }],
  ["joker à ask avant webfetch", { "*": "ask", webfetch: "ask" }],
  ["joker à ask après webfetch", { webfetch: "ask", "*": "ask" }],
  ["joker à motifs après webfetch", { webfetch: "ask", "*": { "https://*": "ask" } }],
  ["joker à motifs seul", { "*": { "https://*": "ask" } }],
  ["joker web* à ask", { "web*": "ask" }],
  ["allow personnalisé", { webfetch: "allow", bash: "ask" }],
  ["valeur objet sous websearch", { websearch: { "*": "ask" } }],
  ["web à ask, reste personnalisé", { edit: "allow", webfetch: "ask", websearch: "deny", bash: "ask" }],
  ["permission en texte « ask »", "ask"],
  ["permission en texte « allow »", "allow"],
  ["bloc vide", {}],
  // Clés « ~/ » et « $HOME » dans les bornes (250 et 256 caractères bruts), plus longues que 256 une fois développées.
  ["motif « ~/ » dans les bornes, web à ask", { edit: "ask", bash: { "*": "ask", [`~/${"a".repeat(248)}`]: "allow" }, webfetch: "ask", websearch: "ask" }],
  ["motif « ~/ » dans les bornes, web fermé", { edit: "ask", bash: { "*": "ask", [`~/${"a".repeat(248)}`]: "allow" }, webfetch: "deny", websearch: "deny" }],
  ["motif « $HOME/ » dans les bornes, web à ask", { bash: { [`$HOME/${"b".repeat(250)}`]: "allow" }, webfetch: "ask" }],
];

/** Agents du croisement (par-dessus chaque bloc global) : demande propre fermée, joker seul, joker puis webfetch. */
const AGENTS: Readonly<Record<string, unknown>> = {
  ferme: { webfetch: "ask" },
  joker: { "*": "ask" },
  mixte: { "*": "ask", webfetch: "ask" },
  neutre: { edit: "allow" },
};

describe("croisements F2 · V2 (1) : une seule source pour legacyPresetOf et peutDemander", () => {
  it("oc-config-web.ts n'a plus aucune copie locale : legacyPresetOf et peutDemander viennent de shared/assistant-rules.ts", () => {
    const source = lire(SERVER_DIR, "oc-config-web.ts");
    for (const nom of ["legacyPresetOf", "peutDemander", "masque", "correspond"]) {
      assert.doesNotMatch(source, new RegExp(`function ${nom}\\b`), `copie locale « ${nom} » encore présente`);
    }
    assert.doesNotMatch(source, /Copie locale/);
    const imports = /import \{([^}]*)\} from "\.\/shared\/assistant-rules\.ts";/.exec(source)?.[1] ?? "";
    for (const nom of ["legacyPresetOf", "peutDemander"]) assert.match(imports, new RegExp(`\\b${nom}\\b`), `${nom} non importé`);
    assert.doesNotMatch(source, /wildcardMatch\(/, "le planificateur n'évalue plus lui-même les jokers");
  });

  it("peutDemander : même réponse avec ou sans mémo (un seul mémo pour tout le corpus), et conforme à la règle R6 de la fiche", () => {
    const memo = memoRegles();
    const corpus: Array<{ regles: Rule[]; brutes: string[] }> = [];
    const defauts = clesBrutes(opencodeDefaultPermission());
    for (const [, bloc] of BLOCS) {
      corpus.push({ regles: rulesFromConfig(bloc), brutes: clesBrutes(bloc) });
      corpus.push({ regles: effectiveAgentRules(bloc, undefined), brutes: [...defauts, ...clesBrutes(bloc)] });
      for (const agent of Object.values(AGENTS)) corpus.push({ regles: effectiveAgentRules(bloc, agent), brutes: [...defauts, ...clesBrutes(bloc), ...clesBrutes(agent)] });
      // Règles d'un agent qui porte lui-même le motif « ~/ » dans les bornes (GET /agent les rend développées).
      const agentLong = { bash: { [`~/${"c".repeat(254)}`]: "allow" }, webfetch: "ask" };
      corpus.push({ regles: effectiveAgentRules(bloc, agentLong), brutes: [...defauts, ...clesBrutes(bloc), ...clesBrutes(agentLong)] });
    }
    // Clés hors bornes (fermé en cas de doute) : vrai sans rien évaluer, avec ou sans mémo.
    const bruteRegles = (regles: Rule[]) => ({ regles, brutes: regles.flatMap((r) => [r.permission, r.pattern]) });
    corpus.push(bruteRegles([{ permission: `${"*".repeat(17)}x`, pattern: "*", action: "deny" }]));
    corpus.push(bruteRegles([{ permission: "webfetch", pattern: "y".repeat(257), action: "deny" }]));
    corpus.push(bruteRegles([]));
    // Clé BRUTE hors bornes sous « ~/ » (257 caractères) : toujours un doute une fois développée.
    const blocTrop = { bash: { [`~/${"d".repeat(255)}`]: "allow" }, webfetch: "deny" };
    corpus.push({ regles: rulesFromConfig(blocTrop), brutes: clesBrutes(blocTrop) });
    let vrais = 0;
    for (const { regles, brutes } of corpus) {
      for (const outil of [...WEB_TOOLS, "bash", "read"]) {
        const attendu = peutDemanderReference(regles, brutes, outil);
        assert.equal(peutDemander(regles, outil), attendu, `${outil} sans mémo : ${JSON.stringify(regles).slice(0, 200)}`);
        assert.equal(peutDemander(regles, outil, memo), attendu, `${outil} avec mémo : ${JSON.stringify(regles).slice(0, 200)}`);
        if (attendu) vrais++;
      }
    }
    assert.ok(vrais > 20 && vrais < corpus.length * 4, `corpus discriminant (${vrais} vrais)`);
  });
});

describe("croisements F2 · V2 (2) : planificateur ↔ legacyPresetOf, même profil", () => {
  it("T1 (n) : PERMISSION_PRESETS_1_0 exporté égale PERMISSION_PRESETS hors du web ; legacyPresetOf(1.0) = id, (1.1) = null", () => {
    for (const id of PERMISSION_PRESET_IDS) {
      assert.deepEqual(sansWeb(PERMISSION_PRESETS_1_0[id]), sansWeb(PERMISSION_PRESETS[id].permission), id);
      assert.equal(legacyPresetOf(PERMISSION_PRESETS_1_0[id]), id);
      assert.equal(legacyPresetOf(PERMISSION_PRESETS[id].permission), null);
      assert.equal(detectPermissionPreset(PERMISSION_PRESETS_1_0[id]), id, "le contrôle d'activation reconnaît toujours le 1.0");
    }
  });

  it("fixtures 1.0.6 et 0.1.0 : le planificateur lit le profil que lit legacyPresetOf, et le 1.0.6 devient le Prudent 1.1", () => {
    const f106 = lire(SERVER_DIR, "test-support", "oc-config-1.0.6.jsonc");
    const f010 = lire(SERVER_DIR, "test-support", "oc-config-0.1.0.jsonc");
    const p106 = planDe(f106);
    assert.equal(legacyPresetOf(own(parseJsonc(f106), "permission")), "prudent");
    assert.equal(p106.etat, "migre");
    assert.equal(p106.profil, "prudent");
    assert.deepEqual(own(apres(f106), "permission"), PERMISSION_PRESETS.prudent.permission);
    assert.equal(securiteProfil(own(parseJsonc(f106), "permission")).etat, "ancien");
    assert.equal(securiteProfil(own(apres(f106), "permission")).etat, "prudent");

    const p010 = planDe(f010);
    assert.equal(legacyPresetOf(own(parseJsonc(f010), "permission")), null);
    assert.equal(p010.profil, "-");
    assert.equal(p010.etat, "migre", "0.1.0 : seul le web passe à deny");
    const avant010 = own(parseJsonc(f010), "permission");
    const apres010 = own(apres(f010), "permission");
    assert.ok(isObjet(avant010) && isObjet(apres010));
    assert.deepEqual(sansWeb(apres010), sansWeb(avant010), "0.1.0 : aucune règle hors du web ne change");
    assert.equal(securiteProfil(apres010).etat, "modifie");
    assert.equal(securiteProfil(apres010).label, "Personnalisé");
  });

  it("chaque bloc : profil du planificateur = legacyPresetOf ; un profil 1.0 (ou mélange) devient le MÊME profil 1.1", () => {
    let profils = 0;
    for (const [nom, bloc] of BLOCS) {
      const texte = fichier(bloc);
      const p = planDe(texte);
      const id = legacyPresetOf(bloc);
      assert.equal(p.profil, id ?? "-", nom);
      const servi = own(apres(texte), "permission");
      assert.equal(legacyPresetOf(servi), null, `${nom} : plus aucun profil d'une version précédente après la migration`);
      if (id === null) continue;
      profils++;
      assert.equal(p.etat, "migre", nom);
      assert.deepEqual(servi, PERMISSION_PRESETS[id].permission, nom);
      assert.equal(detectPermissionPreset(servi), id, nom);
      assert.equal(securiteProfil(bloc).etat, "ancien", nom);
      assert.equal(securiteProfil(servi).etat, id === "prudent" ? "prudent" : "modifie", nom);
      assert.equal(securiteProfil(servi).id, id, nom);
    }
    assert.equal(profils, 7, "trois profils 1.0, trois mélanges et un désordre reconnus");
  });
});

describe("croisements F2 · V2 (3) : 422 (webOpenings) ↔ migration (peutDemander) ↔ signalement (webAskAgents)", () => {
  /** Paires (unité, outil) qui peuvent encore demander, la demande venant de l'unité (R6), recalculées hors du planificateur. */
  function restesAttendus(config: Objet, agents: readonly string[]): { global: number; parAgent: Map<string, number> } {
    const globale = own(config, "permission");
    const compte = (regles: Rule[], propres: Rule[]) => WEB_TOOLS.filter((t) => peutDemander(regles, t) && peutDemander(propres, t)).length;
    const global = compte(effectiveAgentRules(globale, undefined), rulesFromConfig(globale ?? {}));
    const parAgent = new Map<string, number>();
    for (const nom of agents) {
      const propre = own(own(own(config, "agent"), nom), "permission");
      parAgent.set(nom, compte(effectiveAgentRules(globale, propre), rulesFromConfig(propre ?? {})));
    }
    return { global, parAgent };
  }

  it("bloc global seul : restes = peutDemander ; global signalé ⇔ restes > 0 ; ce qui demande encore est une ouverture ; rien d'introduit", () => {
    for (const [nom, bloc] of BLOCS) {
      const texte = fichier(bloc);
      const p = planDe(texte);
      assert.ok(p.etat === "migre" || p.etat === "conforme", `${nom} : ${p.etat} ${p.raison}`);
      const avant = parseJsonc(texte) as Objet;
      const servi = apres(texte);
      const { global } = restesAttendus(servi, []);
      assert.equal(p.restes, global, `${nom} : restes du planificateur`);
      const signal = webAskAgents([], own(servi, "permission"));
      assert.equal(signal.global, global > 0, `${nom} : règle générale signalée`);
      assert.deepEqual(signal.assistants, []);
      const ouvertes = configWebOpenings(servi);
      if (global > 0) assert.ok(ouvertes.length > 0, `${nom} : ce qui demande encore doit être une ouverture pour le 422`);
      assert.deepEqual(webOpeningsIntroduced(configWebOpenings(avant), ouvertes), [], `${nom} : la migration n'introduit aucune ouverture`);
      if (legacyPresetOf(bloc) !== null) {
        assert.ok(configWebOpenings(avant).length > 0, `${nom} : un profil 1.0 est une ouverture`);
        assert.deepEqual(ouvertes, [], `${nom} : le profil 1.1 n'en a plus aucune`);
      }
    }
  });

  it("agents par-dessus chaque bloc : restes du planificateur = Σ des unités ; assistants signalés = agents dont la demande est la leur", () => {
    const noms = Object.keys(AGENTS);
    for (const [nom, bloc] of BLOCS) {
      const texte = fichier(bloc, AGENTS as Record<string, unknown>);
      const p = planDe(texte);
      assert.ok(p.etat === "migre" || p.etat === "conforme", `${nom} : ${p.etat} ${p.raison}`);
      const avant = parseJsonc(texte) as Objet;
      const servi = apres(texte);
      const attendus = restesAttendus(servi, noms);
      const somme = attendus.global + [...attendus.parAgent.values()].reduce((a, b) => a + b, 0);
      assert.equal(p.restes, somme, `${nom} : restes`);
      // GET /agent rend les règles EFFECTIVES (défauts, global, agent) : webAskAgents les lit ainsi.
      const lus: WebAgentLite[] = noms.map((n) => ({ name: n, permission: effectiveAgentRules(own(servi, "permission"), own(own(own(servi, "agent"), n), "permission")) }));
      lus.push({ name: "build", native: true, permission: effectiveAgentRules(own(servi, "permission"), { "*": "ask" }) });
      const signal = webAskAgents(lus, own(servi, "permission"), (n) => `Assistant ${n}`);
      const attendusSignales = noms.filter((n) => (attendus.parAgent.get(n) ?? 0) > 0).sort();
      assert.deepEqual(signal.assistants.map((a) => a.name).sort(), attendusSignales, `${nom} : assistants signalés`);
      assert.equal(signal.global, attendus.global > 0, `${nom} : règle générale`);
      assert.ok(signal.assistants.every((a) => a.title === `Assistant ${a.name}`), "titre d'assistant, jamais le nom seul");
      // Ce qui demande encore est une ouverture (le 422 refuserait de l'introduire) ; la migration n'en introduit aucune.
      const ouvertes = configWebOpenings(servi);
      for (const n of attendusSignales) {
        assert.ok(
          ouvertes.some((o) => o.chemin === `agent.${n}.permission`),
          `${nom} : l'agent ${n} demande encore, sans ouverture vue par webOpenings`,
        );
      }
      assert.deepEqual(webOpeningsIntroduced(configWebOpenings(avant), ouvertes), [], `${nom} : aucune ouverture introduite`);
      // L'agent dont seul « webfetch » demandait est fermé par la migration (bascule efficace) : ni reste, ni signal.
      assert.equal(attendus.parAgent.get("ferme"), 0, `${nom} : agent « ferme »`);
      assert.equal(attendus.parAgent.get("neutre"), 0, `${nom} : agent « neutre » sans demande propre`);
    }
  });

  it("webOpenings et peutDemander lisent les mêmes jokers : un joker à ask est une ouverture ⇔ il peut demander (bloc sans clé web)", () => {
    const jokers: unknown[] = [
      { "*": "ask" },
      { "web*": "ask" },
      { "*": { "https://*": "ask" } },
      { "*": "ask", "we?fetch": "deny", websearch: "deny" },
      { "*": "ask", "*s": "deny" },
      { bash: "ask" },
      { "*": "deny" },
      { "*": { "https://*": "ask" }, "*x": "allow" },
    ];
    for (const bloc of jokers) {
      const regles = rulesFromConfig(bloc);
      const demande = WEB_TOOLS.some((t) => peutDemander([...rulesFromConfig(opencodeDefaultPermission()), ...regles], t));
      const ouverte = webOpenings(bloc).some((o) => o.action === "ask");
      assert.equal(ouverte, demande, JSON.stringify(bloc));
    }
  });
});

describe("croisements F2 · V2 (4) : banc — graine 1.0.6 et mw-api-volume-106", () => {
  it("la graine 1.0.6 du banc donne l'attendu migré à l'octet, qui ne demande plus rien (webIssues vide)", () => {
    const graine = lire(RACINE, "e2e", "lib", "opencode-volume-1.0.6.jsonc");
    const attendu = lire(RACINE, "e2e", "lib", "opencode-volume-1.0.6.migre.jsonc");
    const p = planDe(graine);
    assert.equal(p.etat, "migre");
    assert.equal(p.profil, "prudent");
    assert.equal(p.restes, 0);
    assert.equal(p.texte, attendu);
    const servi = parseJsonc(attendu) as Objet;
    assert.deepEqual(configWebOpenings(servi), []);
    assert.deepEqual(webAskAgents([], own(servi, "permission")), { global: false, assistants: [] });
  });

  it("mw-api-volume-106 exige security.webIssues = { global: false, assistants: [] } : plus de « non joué » depuis MW-b", () => {
    const source = lire(RACINE, "e2e", "scenarios", "mw-api-volume-106.mjs");
    assert.doesNotMatch(source, /nonJoue\(ctx, "security\.webIssues"/);
    assert.match(source, /exiger\(egal\(webIssues, \{ global: false, assistants: \[\] \}\)/);
    assert.match(source, /Object\.hasOwn\(bootstrap\.security, "webIssues"\)/, "champ exigé dans le bootstrap");
  });
});

describe("croisements F2 · V2 (5) : carte — c5:vue-ensemble (L48) et l39o:salle-omo (L39o) ensemble", () => {
  it("CarteTab.tsx : six blocs c5:vue-ensemble identiques à ceux de la construction, section l39o présente, aucune imbrication", () => {
    const texte = lire(APP_DIR, "web", "pages", "assistants", "carte", "CarteTab.tsx").replaceAll(String.fromCharCode(13), "");
    const pile: string[] = [];
    const blocsC5: string[] = [];
    let courant: string[] | null = null;
    let l39o = 0;
    // Noms composés à l'exécution : le test des balises (construction-balises.test.ts) lit aussi ce fichier, qui ne doit en
    // ouvrir aucune.
    const C5 = ["c5", "vue-ensemble"].join(":");
    const L39O = ["l39o", "salle-omo"].join(":");
    const ouvreC5 = `<${C5}>`;
    const fermeC5 = `</${C5}>`;
    const baliseRe = new RegExp(`<(/?)(${C5}|${L39O})>`, "g");
    for (const ligne of texte.split(String.fromCharCode(10))) {
      for (const [, fin, balise] of ligne.matchAll(baliseRe)) {
        if (fin) {
          assert.equal(pile.pop(), balise, `fermeture ${balise} sans ouverture`);
        } else {
          assert.equal(pile.length, 0, `${balise} ouverte dans ${pile.at(-1)}`);
          pile.push(balise as string);
          if (balise === L39O) l39o++;
        }
      }
      if (ligne.includes(ouvreC5)) courant = [];
      if (courant) courant.push(ligne);
      if (ligne.includes(fermeC5) && courant) {
        blocsC5.push(courant.join(String.fromCharCode(10)));
        courant = null;
      }
    }
    assert.deepEqual(pile, []);
    assert.equal(blocsC5.length, 6);
    assert.ok(l39o >= 1, "section l39o:salle-omo absente");
    // Empreinte des six blocs à la tête de GF4 (049e27e) : la vague 2 ne les a pas touchés.
    const empreinte = crypto.createHash("sha256").update(blocsC5.join(`${String.fromCharCode(10)}--${String.fromCharCode(10)}`)).digest("hex");
    assert.equal(empreinte, "e3eab17c7ec2a1427f9a3dc0ce66d721e9865bd27c3782bd66183fef924d06ef");
  });

  it("un seul groupe porte la classe des vues (ca-vues-choix) : ChoixCarte a la sienne, stylée dans la section l39o de carte.css", () => {
    // Partagée, la classe faisait trouver les boutons de ChoixCarte, montés avant les données, à la place de ceux des vues
    // (e2e it4-carte au train de V2 : « la vue « Centrée » n'est pas le défaut visuel »).
    const carte = path.join(APP_DIR, "web", "pages", "assistants", "carte");
    const tsx = ["CarteTab.tsx", "CarteSalleOmo.tsx"].map((nom) => lire(carte, nom)).join(String.fromCharCode(10));
    assert.equal(tsx.match(/className="ca-vues-choix"/g)?.length, 1, "la bascule des vues seule");
    assert.match(lire(carte, "CarteSalleOmo.tsx"), /<div className="ca-choix-carte" role="group" aria-label=\{S\.choix\}>/);
    const css = lire(carte, "carte.css");
    const L39O = ["l39o", "salle-omo"].join(":");
    const debut = css.indexOf(`/* <${L39O}> */`);
    const fin = css.indexOf(`/* </${L39O}> */`);
    assert.ok(debut > 0 && fin > debut, "section l39o de carte.css");
    const section = css.slice(debut, fin);
    assert.match(section, /\.ca-choix-carte \.btn\[aria-pressed="true"\] \{\s*border-color: var\(--border-strong\);\s*font-weight: 600;/);
    assert.match(section, /@media \(forced-colors: active\) \{[\s\S]*\.ca-choix-carte \.btn\[aria-pressed="true"\] \{\s*border: 2px solid CanvasText;/);
    assert.match(section, /\.ca-choix-carte \.btn:focus-visible \{\s*outline: 2px solid Highlight;/);
  });
});
