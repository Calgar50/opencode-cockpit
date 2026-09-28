// Tests 1.1.0 (MW-b, décision A37 ; fiche de la migration du web §5, §6 T1 (n), T3, T5 et §7) : fonctions pures de « l'accès à
// Internet fermé » (assistant-rules.ts), textes (internet-texts.ts) et logique d'écran lue dans les sources.
// Écrits AVANT le code : rouges sur la base de MW (tête de chantier/1.1 après GF4) — module de textes absent, fonctions absentes.
//
// Fonctions PARTAGÉES de référence (le train de V2 fera importer à MW-a legacyPresetOf et peutDemander à la place de ses copies) :
// - legacyPresetOf (R4) : ne dépend que de PERMISSION_PRESETS (1.1), jamais de PERMISSION_PRESETS_1_0 ;
// - peutDemander (R6) : il existe une règle i dont la permission correspond à T et d'action « ask », quel que soit son motif, sans
//   règle j > i dont la permission correspond à T et dont le motif est « * » ; clé hors bornes (R3) = « peut demander » ;
// - masque (R6) : la dernière règle dont la permission correspond à T a le motif « * » et l'action « deny ».
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import {
  activePermissionPreset,
  cheminOuverture,
  cleHorsBornes,
  configWebOpenings,
  detectPermissionPreset,
  effectiveAgentRules,
  fermerWebStudio,
  isLegacyPermissionPreset,
  legacyPresetOf,
  legacyProfileText,
  masque,
  PERMISSION_PRESET_IDS,
  PERMISSION_PRESETS,
  PERMISSION_PRESETS_1_0,
  peutDemander,
  presetPermission,
  type Rule,
  rulesFromConfig,
  SECURITY_TEXTS,
  securiteProfil,
  webAFermer,
  webAskAgents,
  webOpenings,
  webOpeningsIntroduced,
} from "./shared/assistant-rules.ts";
import {
  TEXTES,
  texteAssistantsSignales,
  texteDiagnosticInternet,
  texteFermerMessage,
  texteFermerReussite,
  texteProfilAncien,
  texteRefusInternet,
  texteStudioInternet,
} from "./shared/internet-texts.ts";

const APP_DIR = path.join(import.meta.dirname, "..");
const read = (...parts: string[]) => fs.readFileSync(path.join(APP_DIR, ...parts), "utf8");
/** Source sans commentaires (JSX et lignes) : un texte cité dans un commentaire ne compte pas. */
const code = (source: string) => source.replace(/\{\/\*[\s\S]*?\*\/\}/g, "").replace(/^\s*\/\/.*$/gm, "");

const R = (permission: string, action: Rule["action"], pattern = "*"): Rule => ({ permission, pattern, action });
const sansWeb = (permission: Readonly<Record<string, unknown>>) =>
  Object.fromEntries(Object.entries(permission).filter(([cle]) => cle !== "webfetch" && cle !== "websearch"));

describe("profils d'une version précédente (T1 n, R4)", () => {
  it("PERMISSION_PRESETS_1_0 exporté : hors du web, chaque profil 1.0 égale le profil 1.1 ; legacyPresetOf(1.0) = id, (1.1) = null", () => {
    for (const id of PERMISSION_PRESET_IDS) {
      assert.deepEqual(sansWeb(PERMISSION_PRESETS_1_0[id]), sansWeb(PERMISSION_PRESETS[id].permission), id);
      assert.notDeepEqual(PERMISSION_PRESETS_1_0[id], PERMISSION_PRESETS[id].permission, id);
      assert.equal(legacyPresetOf(PERMISSION_PRESETS_1_0[id]), id, id);
      assert.equal(legacyPresetOf(PERMISSION_PRESETS[id].permission), null, id);
      assert.equal(legacyPresetOf(presetPermission(id)), null, id);
      // Contrôle d'activation de l'autonomie inchangé (§5.5) : le profil 1.0 reste reconnu par detectPermissionPreset.
      assert.equal(detectPermissionPreset(PERMISSION_PRESETS_1_0[id]), id, id);
    }
    assert.equal(isLegacyPermissionPreset(PERMISSION_PRESETS_1_0.prudent), true);
    assert.equal(isLegacyPermissionPreset(PERMISSION_PRESETS.prudent.permission), false);
  });

  it("mélanges 1.0/1.1 et clés dans le désordre reconnus ; tout autre bloc n'est pas un profil d'une version précédente", () => {
    const prudent10 = PERMISSION_PRESETS_1_0.prudent;
    // Mélanges : un seul outil web encore ouvert, ou « allow » à la place de « ask ».
    assert.equal(legacyPresetOf({ ...prudent10, webfetch: "deny" }), "prudent");
    assert.equal(legacyPresetOf({ ...PERMISSION_PRESETS.autonome.permission, websearch: "allow" }), "autonome");
    assert.equal(legacyPresetOf({ ...PERMISSION_PRESETS.equilibre.permission, webfetch: "allow" }), "equilibre");
    // Ordre des clés ignoré (profil réécrit par « Appliquer » en 1.0.x), y compris dans les motifs de bash.
    const desordre = Object.fromEntries(Object.entries(prudent10).reverse());
    (desordre as Record<string, unknown>).bash = { pwd: "allow", "*": "ask" };
    assert.equal(legacyPresetOf(desordre), "prudent");
    // Refus : une clé web absente, une valeur web qui n'est pas une action, un réglage modifié, une clé en plus, un texte.
    const { websearch: _absente, ...sansWebsearch } = prudent10;
    assert.equal(legacyPresetOf(sansWebsearch), null);
    assert.equal(legacyPresetOf({ ...prudent10, webfetch: { "*": "ask" } }), null);
    assert.equal(legacyPresetOf({ ...prudent10, edit: "allow" }), null);
    assert.equal(legacyPresetOf({ ...prudent10, read: "allow" }), null);
    for (const valeur of ["ask", "allow", null, undefined, [], 42]) assert.equal(legacyPresetOf(valeur), null, String(valeur));
    // Bloc objet sans prototype (correctif fusionné par mergeConfigPatch) : lu comme les autres.
    assert.equal(legacyPresetOf(Object.assign(Object.create(null) as object, prudent10)), "prudent");
  });

  it("activePermissionPreset (OpencodeTab) : un profil 1.0 n'est plus « actif », un profil 1.1 l'est", () => {
    for (const id of PERMISSION_PRESET_IDS) {
      assert.equal(activePermissionPreset(PERMISSION_PRESETS_1_0[id]), null, id);
      assert.equal(activePermissionPreset(PERMISSION_PRESETS[id].permission), id, id);
    }
    assert.equal(activePermissionPreset({ ...PERMISSION_PRESETS_1_0.prudent, webfetch: "deny" }), null);
    assert.equal(activePermissionPreset({ edit: "allow" }), null);
  });
});

describe("peutDemander et masque (R6, fonctions partagées)", () => {
  it("peutDemander : une règle « ask » quel que soit son motif, sans règle « * » après elle pour le même outil", () => {
    assert.equal(peutDemander([R("*", "allow"), R("webfetch", "ask")], "webfetch"), true);
    assert.equal(peutDemander([R("webfetch", "ask"), R("*", "deny")], "webfetch"), false);
    assert.equal(peutDemander([R("webfetch", "ask"), R("webfetch", "allow")], "webfetch"), false);
    assert.equal(peutDemander([R("webfetch", "deny"), R("*", "ask")], "webfetch"), true);
    // Joker à motifs : opencode pose la demande webfetch avec l'adresse pour motif (tool/webfetch.ts:40-41).
    assert.equal(peutDemander([R("*", "ask", "https://*")], "webfetch"), true);
    assert.equal(peutDemander([R("webfetch", "deny"), R("*", "ask", "https://*")], "webfetch"), true);
    assert.equal(peutDemander([R("*", "ask", "https://*"), R("webfetch", "deny")], "webfetch"), false);
    // Une règle APRÈS, dont le motif n'est pas « * », ne masque rien.
    assert.equal(peutDemander([R("webfetch", "ask"), R("webfetch", "deny", "https://interne/*")], "webfetch"), true);
    assert.equal(peutDemander([R("web*", "ask")], "websearch"), true);
    assert.equal(peutDemander([R("websearch", "ask")], "webfetch"), false);
    assert.equal(peutDemander([], "webfetch"), false);
  });

  it("masque : la dernière règle de l'outil a le motif « * » et refuse", () => {
    assert.equal(masque([R("*", "ask"), R("webfetch", "deny")], "webfetch"), true);
    assert.equal(masque([R("webfetch", "deny"), R("webfetch", "allow", "https://a")], "webfetch"), false);
    assert.equal(masque([R("webfetch", "deny", "https://*")], "webfetch"), false);
    assert.equal(masque([R("*", "deny")], "websearch"), true);
    assert.equal(masque([], "webfetch"), false);
  });

  it("clés hors bornes (R3) : plus de 256 caractères ou de 16 jokers — fermé en cas de doute, jamais évaluées", () => {
    assert.equal(cleHorsBornes("*".repeat(16)), false);
    assert.equal(cleHorsBornes("*".repeat(17)), true);
    assert.equal(cleHorsBornes("?".repeat(9) + "*".repeat(8)), true);
    assert.equal(cleHorsBornes("a".repeat(256)), false);
    assert.equal(cleHorsBornes("a".repeat(257)), true);
    const debut = performance.now();
    const piege = `${"*".repeat(24)}z`;
    assert.equal(peutDemander([R(piege, "deny")], "webfetch"), true);
    assert.equal(peutDemander([R("webfetch", "deny", "x".repeat(300))], "webfetch"), true);
    assert.equal(masque([R(piege, "deny")], "webfetch"), false);
    assert.deepEqual(
      webOpenings({ [piege]: "deny" }).map((o) => o.action),
      ["doute"],
    );
    assert.ok(performance.now() - debut < 1_000, "une clé piégée doit être écartée avant toute évaluation");
  });
});

describe("ouvertures d'Internet et ouvertures introduites (§5.1)", () => {
  it("webOpenings : webfetch ou websearch à ask ou allow, joker à ask (valeur ou motif), permission en texte « ask »", () => {
    assert.deepEqual(webOpenings({ webfetch: "ask" }), [{ chemin: "permission", cle: "webfetch", motif: null, action: "ask" }]);
    assert.deepEqual(webOpenings({ websearch: "allow" }, "agent.x.permission"), [{ chemin: "agent.x.permission", cle: "websearch", motif: null, action: "allow" }]);
    assert.deepEqual(webOpenings({ webfetch: "deny", websearch: "deny", edit: "ask", bash: { "*": "ask" } }), []);
    assert.deepEqual(webOpenings("ask"), [{ chemin: "permission", cle: null, motif: null, action: "ask" }]);
    assert.deepEqual(webOpenings("allow"), []);
    assert.deepEqual(webOpenings({ "*": "ask" }), [{ chemin: "permission", cle: "*", motif: null, action: "ask" }]);
    assert.deepEqual(webOpenings({ "web*": { "https://*": "ask" } }), [{ chemin: "permission", cle: "web*", motif: "https://*", action: "ask" }]);
    assert.deepEqual(webOpenings({ webfetch: { "*": "deny", "https://a": "allow" } }), [{ chemin: "permission", cle: "webfetch", motif: "https://a", action: "allow" }]);
    // Joker « * » à ask masqué dans le même bloc par un refus « * » des deux outils : aucune demande web possible.
    assert.deepEqual(webOpenings({ "*": "ask", webfetch: "deny", websearch: "deny" }), []);
    // Joker à allow : jamais une demande (le défaut d'opencode est déjà « * » : allow).
    assert.deepEqual(webOpenings({ "*": "allow" }), []);
    // « __proto__ » reste une donnée : rien n'est lu ni ajouté par le prototype.
    const proto = JSON.parse('{"__proto__": {"webfetch": "ask"}, "edit": "ask"}') as unknown;
    assert.deepEqual(webOpenings(proto), []);
    assert.equal(({} as Record<string, unknown>).webfetch, undefined);
    for (const valeur of [null, undefined, 42, [], "deny"]) assert.deepEqual(webOpenings(valeur), [], String(valeur));
  });

  it("configWebOpenings : permission, agent.<nom>.permission et mode.<nom>.permission ; chemins lisibles", () => {
    const config = {
      permission: { webfetch: "deny", websearch: "deny" },
      agent: { veille: { permission: { websearch: "ask" } }, lecteur: { permission: { webfetch: "deny" } } },
      mode: { vieux: { permission: "ask" } },
      tools: { webfetch: true },
    };
    const ouvertures = configWebOpenings(config);
    assert.deepEqual(ouvertures.map(cheminOuverture), ["agent.veille.permission.websearch", "mode.vieux.permission"]);
    assert.deepEqual(cheminOuverture({ chemin: "permission", cle: "*", motif: "https://*", action: "ask" }), "permission.*.https://*");
    assert.deepEqual(configWebOpenings("ask"), []);
    assert.deepEqual(configWebOpenings({ agent: "x", mode: [1] }), []);
  });

  it("webOpeningsIntroduced : présentes après, absentes avant, comparées par chemin, clé, motif et action", () => {
    const introduites = (avant: unknown, apres: unknown) => webOpeningsIntroduced(configWebOpenings(avant), configWebOpenings(apres)).map(cheminOuverture);
    const ancien = { permission: { edit: "ask", webfetch: "ask", websearch: "deny" } };
    // Un « ask » déjà présent n'est jamais une cause de refus : correctif sans rapport accepté.
    assert.deepEqual(introduites(ancien, { ...ancien, small_model: "github-copilot/gpt-5-mini" }), []);
    assert.deepEqual(introduites(ancien, { permission: { ...ancien.permission, webfetch: "deny" } }), []);
    // ask → allow : action différente, donc introduite (garde R10 a).
    assert.deepEqual(introduites(ancien, { permission: { ...ancien.permission, webfetch: "allow" } }), ["permission.webfetch"]);
    assert.deepEqual(introduites(ancien, { permission: { ...ancien.permission, websearch: "ask" } }), ["permission.websearch"]);
    // Même clé sous un autre chemin : introduite.
    assert.deepEqual(introduites(ancien, { ...ancien, agent: { x: { permission: { webfetch: "ask" } } } }), ["agent.x.permission.webfetch"]);
    assert.deepEqual(introduites({}, { permission: "ask" }), ["permission"]);
    assert.deepEqual(introduites({}, { permission: { "*": { "https://*": "ask" } } }), ["permission.*.https://*"]);
    // Bloc seul (PUT des permissions, Studio).
    assert.deepEqual(webOpeningsIntroduced(webOpenings({ webfetch: "ask" }), webOpenings({ webfetch: "ask", edit: "allow" })), []);
    assert.deepEqual(webOpeningsIntroduced(webOpenings(undefined), webOpenings({ websearch: "ask" })).map(cheminOuverture), ["permission.websearch"]);
  });

  it("Studio : webAFermer et fermerWebStudio écrivent « deny » à la place d'un ask ou d'un allow, sans rien déplacer", () => {
    const bloc = { edit: "ask", webfetch: "ask", bash: "deny", websearch: { "*": "allow" } };
    assert.equal(webAFermer(bloc), true);
    const ferme = fermerWebStudio(bloc) as Record<string, unknown>;
    assert.deepEqual(Object.entries(ferme), [["edit", "ask"], ["webfetch", "deny"], ["bash", "deny"], ["websearch", "deny"]]);
    assert.deepEqual(bloc.webfetch, "ask", "le bloc d'origine n'est pas modifié");
    assert.equal(webAFermer(ferme), false);
    assert.equal(webAFermer({ webfetch: "deny" }), false);
    assert.equal(webAFermer(undefined), false);
    assert.equal(webAFermer("ask"), false);
    assert.equal(fermerWebStudio("ask"), "ask");
    assert.equal(fermerWebStudio(undefined), undefined);
  });
});

describe("assistants qui peuvent encore demander Internet (§5.3, webAskAgents)", () => {
  const PRUDENT_11 = presetPermission("prudent");
  const PRUDENT_10 = PERMISSION_PRESETS_1_0.prudent;
  const TITRES: Record<string, string> = { veille: "Veille des failles", lecteur: "Lecteur" };
  const titreDe = (nom: string) => TITRES[nom] ?? null;
  const agent = (name: string, propre: unknown, global: unknown, extra: Record<string, unknown> = {}) => ({
    name,
    permission: effectiveAgentRules(global, propre),
    ...extra,
  });

  it("règle générale fermée : seuls les agents visibles, non natifs, dont la règle décisive est la leur, par leur titre", () => {
    const issues = webAskAgents(
      [
        agent("build", { websearch: "ask" }, PRUDENT_11, { native: true }),
        agent("veille", { websearch: "ask", webfetch: "ask" }, PRUDENT_11),
        agent("cache", { webfetch: "ask" }, PRUDENT_11, { hidden: true }),
        agent("lecteur", { webfetch: "deny" }, PRUDENT_11),
        agent("studio-sans-titre", { "*": { "https://*": "ask" } }, PRUDENT_11),
      ],
      PRUDENT_11,
      titreDe,
    );
    assert.deepEqual(issues, {
      global: false,
      assistants: [
        { name: "veille", title: "Veille des failles" },
        { name: "studio-sans-titre", title: null },
      ],
    });
  });

  it("règle générale ouverte : signalée une seule fois, les agents qui en héritent ne sont pas listés", () => {
    const issues = webAskAgents(
      [agent("herite", {}, PRUDENT_10), agent("veille", { webfetch: "deny", websearch: "deny" }, PRUDENT_10), agent("propre", { webfetch: "ask" }, PRUDENT_10)],
      PRUDENT_10,
      titreDe,
    );
    assert.deepEqual(issues, { global: true, assistants: [{ name: "propre", title: null }] });
    assert.equal(webAskAgents([], { "*": { "https://*": "ask" } }).global, true);
    assert.equal(webAskAgents([], "ask").global, true);
    assert.equal(webAskAgents([], undefined).global, false);
    assert.equal(webAskAgents([], PRUDENT_11).global, false);
  });

  it("fermé en cas de doute : règles d'origine inconnue qui demandent, ou clé hors bornes, signalées", () => {
    // Règles qui ne commencent pas par les défauts et la configuration globale : on ne sait pas d'où vient la demande.
    const inconnu = { name: "inconnu", permission: [R("websearch", "ask")] };
    const piege = { name: "piege", permission: [...effectiveAgentRules(PRUDENT_11, {}), R(`${"*".repeat(30)}z`, "deny")] };
    const sage = { name: "sage", permission: [R("*", "allow")] };
    const issues = webAskAgents([inconnu, piege, sage], PRUDENT_11, titreDe);
    assert.deepEqual(
      issues.assistants.map((a) => a.name),
      ["inconnu", "piege"],
    );
    assert.equal(webAskAgents([], { [`${"?".repeat(20)}`]: "deny" }).global, true);
  });

  it("bornes R3 mesurées sur la clé BRUTE (relecture F2-vague-2) : un motif « ~/ » dans les bornes, développé par expandHome, n'est pas un doute", () => {
    // « ~/ » + 248 caractères = 250 : dans les bornes ; 259 une fois développé (/home/node/…) par rulesFromConfig, comme opencode
    // le développe dans les règles de GET /agent. Avant la correction : Diagnostic « la règle générale le demande encore » (faux),
    // liste des assistants masquée, et le Studio ne proposait plus « Hérité » (« La règle globale ne refuse pas cet outil », faux).
    const cle = `~/${"a".repeat(248)}`;
    const ferme = { edit: "ask", bash: { "*": "ask", [cle]: "allow" }, webfetch: "deny", websearch: "deny" };
    assert.ok(rulesFromConfig(ferme).some((r) => r.pattern.length > 256), "le motif développé dépasse 256 caractères");
    assert.deepEqual(webAskAgents([], ferme), { global: false, assistants: [] });
    for (const outil of ["webfetch", "websearch"]) {
      assert.equal(masque(effectiveAgentRules(ferme, undefined), outil), true, outil);
      assert.equal(masque(effectiveAgentRules(ferme, {}), outil), true, `${outil} (appel du Studio)`);
      assert.equal(peutDemander(effectiveAgentRules(ferme, undefined), outil), false, outil);
    }
    // $HOME, développé de même.
    const fermeHome = { ...ferme, bash: { "*": "ask", [`$HOME/${"a".repeat(250)}`]: "allow" } };
    assert.deepEqual(webAskAgents([], fermeHome), { global: false, assistants: [] });
    assert.equal(masque(effectiveAgentRules(fermeHome, undefined), "webfetch"), true);
    // Règles de GET /agent, déjà développées : l'agent qui porte ce motif n'est pas signalé pour autant ; sa demande propre l'est.
    const lecteur = agent("lecteur", { bash: { [cle]: "allow" } }, PRUDENT_11);
    const veille = agent("veille", { bash: { [cle]: "allow" }, webfetch: "ask" }, PRUDENT_11);
    assert.deepEqual(webAskAgents([lecteur, veille], PRUDENT_11, titreDe), { global: false, assistants: [{ name: "veille", title: "Veille des failles" }] });
    // Toujours fermé en cas de doute : une clé BRUTE hors bornes (257 caractères), même sous « ~/ ».
    const trop = { ...ferme, bash: { "*": "ask", [`~/${"a".repeat(255)}`]: "allow" } };
    assert.equal(webAskAgents([], trop).global, true);
    assert.equal(masque(effectiveAgentRules(trop, undefined), "webfetch"), false);
    assert.equal(peutDemander(effectiveAgentRules(trop, undefined), "webfetch"), true);
    const piegeAgent = agent("piege", { bash: { [`~/${"a".repeat(255)}`]: "allow" } }, PRUDENT_11);
    assert.deepEqual(webAskAgents([piegeAgent], PRUDENT_11).assistants, [{ name: "piege", title: null }]);
    // « $HOME » sans barre (257 caractères bruts) : sa forme brute la plus courte garde « $HOME », il reste hors bornes.
    const tropHome = { ...ferme, bash: { "*": "ask", [`$HOME${"a".repeat(252)}`]: "allow" } };
    assert.equal(webAskAgents([], tropHome).global, true);
    assert.equal(masque(effectiveAgentRules(tropHome, undefined), "websearch"), false);
  });
});

describe("écran Sécurité (T5, §5.2) : securiteProfil", () => {
  it("Prudent 1.0 → ancien avec « Fermer l'accès à Internet » ; Prudent 1.1 → vert ; personnalisé → modifié avec « Revenir au profil Prudent »", () => {
    assert.deepEqual(securiteProfil(PERMISSION_PRESETS_1_0.prudent), { etat: "ancien", id: "prudent", label: "Prudent", bouton: "Fermer l'accès à Internet" });
    assert.deepEqual(securiteProfil(PERMISSION_PRESETS.prudent.permission), { etat: "prudent", id: "prudent", label: "Prudent", bouton: null });
    assert.deepEqual(securiteProfil(PERMISSION_PRESETS_1_0.equilibre), { etat: "ancien", id: "equilibre", label: "Équilibré", bouton: "Fermer l'accès à Internet" });
    assert.deepEqual(securiteProfil(PERMISSION_PRESETS_1_0.autonome), {
      etat: "ancien",
      id: "autonome",
      label: "Sans confirmation (déconseillé)",
      bouton: "Fermer l'accès à Internet",
    });
    assert.deepEqual(securiteProfil({ ...PERMISSION_PRESETS_1_0.prudent, websearch: "deny" }).etat, "ancien");
    assert.deepEqual(securiteProfil(PERMISSION_PRESETS.equilibre.permission), { etat: "modifie", id: "equilibre", label: "Équilibré", bouton: "Revenir au profil Prudent" });
    assert.deepEqual(securiteProfil({ edit: "allow" }), { etat: "modifie", id: null, label: "Personnalisé", bouton: "Revenir au profil Prudent" });
    assert.deepEqual(securiteProfil(undefined), { etat: "modifie", id: null, label: "Personnalisé", bouton: "Revenir au profil Prudent" });
  });

  it("SecuriteTab passe par securiteProfil (donc legacyPresetOf) et appelle update-profile ; OpencodeTab par activePermissionPreset", () => {
    const securite = code(read("web", "pages", "settings", "SecuriteTab.tsx"));
    assert.match(securite, /securiteProfil\(/);
    assert.match(securite, /api\.updateProfile\(\)/);
    assert.match(securite, /texteAssistantsSignales\(/);
    assert.equal(/detectPermissionPreset\(/.test(securite), false, "SecuriteTab ne doit plus juger le profil sans legacyPresetOf");
    const opencode = code(read("web", "pages", "settings", "OpencodeTab.tsx"));
    // Le profil « actif » (carte en surbrillance, « Appliquer » désactivé) est celui d'activePermissionPreset, et lui seul.
    assert.match(opencode, /const activePreset = activePermissionPreset\(currentPermission\);/);
    assert.match(opencode, /disabled=\{activePreset === preset\.id \|\| patching !== null\}/);
    assert.match(opencode, /const legacyPreset = legacyPresetOf\(currentPermission\);/);
    assert.match(opencode, /legacyPreset === preset\.id \? \([\s\S]{0,200}TEXTES_INTERNET\.avance\.repereAncien/);
    assert.equal(/detectPermissionPreset\(/.test(opencode), false);
    assert.equal(/Web : (?:demander|autoriser)/.test(opencode), false);
    assert.equal(/accéder au web sans rien vous demander/.test(opencode), false);
    assert.match(read("web", "lib", "api.ts"), /updateProfile: \(\) => http\.post<UpdateProfileResponse>\("\/api\/security\/update-profile"\)/);
  });
});

describe("assistant de création, Studio et Diagnostic (§5.1, §5.3) : sources", () => {
  it("assistant de création : case « Consulter Internet » retirée (deux modes), phrase fixe, note pour un assistant d'une version précédente", () => {
    const wizard = code(read("web", "pages", "assistants", "AssistantWizard.tsx"));
    assert.equal(/Consulter Internet/.test(wizard), false);
    assert.equal(/checked=\{draft\.web\}/.test(wizard), false);
    assert.equal(/web: e\.target\.checked/.test(wizard), false);
    assert.match(wizard, /TEXTES_INTERNET\.partout\.creationFerme/);
    assert.match(wizard, /source\.draft\.web \? [\s\S]{0,200}TEXTES_INTERNET\.partout\.creationAncien/);
  });

  it("Studio : webfetch et websearch n'offrent que « Refuser » (« Hérité » si la règle générale les refuse) ; deny écrit à l'enregistrement", () => {
    const editeur = code(read("web", "pages", "studio", "PermissionsEditor.tsx"));
    assert.match(editeur, /masque\(/);
    assert.match(editeur, /TEXTES_INTERNET\.avance\.refuserALEnregistrement/);
    assert.match(editeur, /webAFermer|webStudioOuvert/);
    const item = code(read("web", "pages", "studio", "ItemEditor.tsx"));
    assert.match(item, /fermerWebStudio\(/);
    assert.match(item, /webAFermer\(/);
  });

  it("Diagnostic : security.webIssues lu par problemsOf et affiché", () => {
    const page = code(read("web", "pages", "DiagnosticsPage.tsx"));
    assert.match(page, /texteDiagnosticInternet\(s\.security\.webIssues\)/);
    assert.match(read("web", "lib", "types.ts"), /webIssues: WebIssues \| null;[\s\S]*webIssues: WebIssues \| null;/);
  });
});

describe("textes de l'accès à Internet (§7, à la lettre)", () => {
  it("écran Sécurité, assistant de création et Diagnostic", () => {
    assert.equal(
      TEXTES.partout.prudent,
      "Profil de droits : Prudent. L'assistant demande avant de modifier un fichier, lancer une commande ou déléguer. Il ne va jamais sur Internet.",
    );
    assert.equal(SECURITY_TEXTS.prudent, TEXTES.partout.prudent);
    assert.equal(SECURITY_TEXTS.closeInternet, "Fermer l'accès à Internet");
    assert.equal(
      legacyProfileText("Équilibré"),
      "Profil de droits : Équilibré (réglage d'une version précédente). L'assistant peut encore vous demander d'aller sur Internet. C'est impossible au travail, et une telle demande restée sans réponse peut bloquer les autres demandes d'autorisation. Cliquez sur « Fermer l'accès à Internet » : votre profil est gardé, seul l'accès à Internet change.",
    );
    assert.equal(texteProfilAncien("Prudent"), legacyProfileText("Prudent"));
    assert.equal(TEXTES.partout.fermerTitre, "Fermer l'accès à Internet ?");
    assert.equal(
      texteFermerMessage("Équilibré"),
      "Votre profil Équilibré est gardé ; seul l'accès à Internet passe à « refusé ». opencode redémarre quelques secondes pour appliquer ces règles, jamais pendant une réponse.",
    );
    assert.equal(texteFermerReussite("Prudent"), "Internet est fermé. Votre profil Prudent est inchangé.");
    // « permissions » est interdit en mode Simple (spéc. §2.3) : « règles » à sa place, seul écart avec la lettre de la fiche §7.
    assert.equal(
      TEXTES.partout.prudentMessage,
      "Les règles globales d'opencode seront remplacées : l'assistant demandera avant de modifier un fichier, lancer une commande ou déléguer, et n'ira jamais sur Internet. opencode redémarre quelques secondes pour appliquer ces règles, jamais pendant une réponse.",
    );
    assert.equal(TEXTES.partout.prudentReussite, "L'assistant demande de nouveau avant chaque action sensible. Internet est fermé.");
    assert.equal(
      TEXTES.partout.creationFerme,
      "Internet : fermé. L'assistant ne consulte jamais Internet : au travail, seul GitHub Copilot est joignable.",
    );
    assert.equal(TEXTES.partout.creationAncien, "Cet assistant pouvait demander à aller sur Internet. En enregistrant, Internet sera fermé pour lui.");
    assert.deepEqual(texteDiagnosticInternet({ global: false, assistants: [] }), { ton: "bon", texte: "Accès à Internet de l'assistant : fermé." });
    assert.deepEqual(texteDiagnosticInternet({ global: false, assistants: [{ name: "a", title: "A" }, { name: "b", title: null }] }), {
      ton: "attention",
      texte: "Accès à Internet : 2 assistants peuvent encore le demander. Voir Paramètres › Sécurité.",
    });
    assert.deepEqual(texteDiagnosticInternet({ global: false, assistants: [{ name: "a", title: "A" }] }), {
      ton: "attention",
      texte: "Accès à Internet : 1 assistant peut encore le demander. Voir Paramètres › Sécurité.",
    });
    assert.deepEqual(texteDiagnosticInternet({ global: true, assistants: [] }), {
      ton: "attention",
      texte: "Accès à Internet : la règle générale le demande encore. Voir Paramètres › Sécurité.",
    });
    assert.equal(texteDiagnosticInternet(null), null);
  });

  it("assistants signalés : titres en mode Simple (jamais le nom technique), rien quand la règle générale demande encore", () => {
    const issues = { global: false, assistants: [{ name: "veille", title: "Veille des failles" }, { name: "a-la-main", title: null }, { name: "b", title: null }] };
    const titres =
      "Ces assistants peuvent encore vous demander d'aller sur Internet : Veille des failles. Ouvrez chacun (Assistants › Modifier), puis Enregistrer : Internet sera fermé pour lui.";
    assert.equal(
      texteAssistantsSignales(issues, false),
      `${titres} 2 assistants créés hors de l'assistant de création peuvent encore vous demander d'aller sur Internet. Pour leur fermer Internet, passez en mode Avancé : Studio, ou Paramètres › opencode.`,
    );
    assert.equal(
      texteAssistantsSignales(issues, true),
      `${titres} Ces agents peuvent encore vous demander d'aller sur Internet : a-la-main, b. Dans le Studio, ouvrez chacun, mettez « Lire une page web » et « Recherche web » sur « Refuser », puis Enregistrer. Un agent déclaré dans la configuration globale se corrige dans Paramètres › opencode.`,
    );
    assert.equal(
      texteAssistantsSignales({ global: false, assistants: [{ name: "x", title: null }] }, false),
      "1 assistant créé hors de l'assistant de création peut encore vous demander d'aller sur Internet. Pour lui fermer Internet, passez en mode Avancé : Studio, ou Paramètres › opencode.",
    );
    assert.equal(texteAssistantsSignales({ global: true, assistants: [{ name: "x", title: "X" }] }, false), null);
    assert.equal(texteAssistantsSignales({ global: false, assistants: [] }, false), null);
    assert.equal(texteAssistantsSignales(null, false), null);
  });

  it("assistants signalés (relecture F2-vague-2) : « Assistants › Modifier » pour les seuls assistants titrés ; un signalé sans titre reçoit la consigne du Studio", () => {
    // Un agent sans titre (sous-agent du Studio, agent de la configuration globale) n'a aucun bouton « Modifier » dans Assistants,
    // un sous-agent n'est pas dans « À compléter », et le Studio n'existe qu'en mode Avancé.
    const titre = { name: "veille", title: "Veille des failles" };
    const sans = { name: "chercheur", title: null };
    for (const avance of [false, true]) {
      const seulsTitres = texteAssistantsSignales({ global: false, assistants: [titre] }, avance) ?? "";
      assert.match(seulsTitres, /Assistants › Modifier/);
      assert.match(seulsTitres, /Veille des failles/);
      assert.doesNotMatch(seulsTitres, /Studio/);
      const seulsSans = texteAssistantsSignales({ global: false, assistants: [sans] }, avance) ?? "";
      assert.ok(seulsSans.length > 0);
      assert.doesNotMatch(seulsSans, /Assistants › Modifier/, "un agent sans titre n'a aucun bouton « Modifier » dans Assistants");
      assert.doesNotMatch(seulsSans, /Internet sera fermé pour lui/);
      assert.match(seulsSans, /Studio/);
      assert.match(seulsSans, /Paramètres › opencode/, "agent déclaré dans la configuration globale : absent du Studio");
      const mixte = texteAssistantsSignales({ global: false, assistants: [titre, sans] }, avance) ?? "";
      const phraseAssistants = mixte.slice(0, mixte.indexOf("Internet sera fermé pour lui."));
      assert.match(phraseAssistants, /Veille des failles/);
      assert.doesNotMatch(phraseAssistants, /chercheur|créé hors/, "la consigne d'Assistants ne vise que les titrés");
      assert.match(mixte.slice(phraseAssistants.length), /Studio/);
    }
    assert.match(texteAssistantsSignales({ global: false, assistants: [sans] }, true) ?? "", /: chercheur\./, "nom technique en mode Avancé");
    assert.doesNotMatch(texteAssistantsSignales({ global: false, assistants: [sans] }, false) ?? "", /chercheur/, "jamais le nom technique en mode Simple");
    assert.match(texteAssistantsSignales({ global: false, assistants: [sans] }, false) ?? "", /mode Avancé/);
  });

  it("mode Avancé : cartes, refus 422 et Studio", () => {
    assert.equal(TEXTES.avance.cartesWeb, "Web : refusé");
    assert.equal(TEXTES.avance.resumeEquilibre, "Modifications de fichiers libres ; commandes et sous-agents sur confirmation ; web refusé.");
    assert.equal(
      TEXTES.avance.avertissementSansConfirmation,
      "L'agent pourra modifier des fichiers et lancer n'importe quelle commande sans rien vous demander. Internet reste fermé. À réserver à des projets jetables ou entièrement versionnés.",
    );
    assert.equal(TEXTES.avance.repereAncien, "Version précédente : Internet pas encore fermé.");
    assert.equal(
      texteRefusInternet(["permission.webfetch", "agent.x.permission.websearch"]),
      "Internet est fermé : « ask » et « allow » ne sont plus acceptés pour webfetch et websearch (permission.webfetch, agent.x.permission.websearch). Une demande web restée en attente bloquait les autres autorisations. Mettez « deny ».",
    );
    assert.equal(texteStudioInternet("webfetch"), "Internet est fermé : « webfetch » n'accepte plus que « deny ».");
    assert.equal(TEXTES.avance.refuserALEnregistrement, "Refuser (appliqué à l'enregistrement)");
    // En mode Simple, jamais le nom d'un outil ni D11 ni « volume » (spéc. §2.3, fiche §7).
    const simples = JSON.stringify([TEXTES.simple, TEXTES.partout]);
    for (const mot of ["webfetch", "websearch", "D11", "volume", "permission", "agent"]) assert.equal(simples.toLowerCase().includes(mot.toLowerCase()), false, mot);
  });
});

// L51 (décisions A31 c, A32 (2) ; « vérifier l'ensemble des textes de MW-b ») : les deux endroits du chat qui proposaient encore
// le web disent vrai. Une demande web n'arrive plus qu'avec des règles d'une version précédente, et Internet reste fermé.
describe("chat : carte d'une demande web et carte d'accueil d'un assistant (L51)", () => {
  it("carte d'une demande webfetch ou websearch : « Internet est fermé : seul GitHub Copilot est joignable. Refusez cette demande. »", () => {
    assert.equal(TEXTES.partout.demandeWeb, "Internet est fermé : seul GitHub Copilot est joignable. Refusez cette demande.");
    const carte = code(read("web", "pages", "chat", "Interactions.tsx"));
    assert.match(carte, /const WEB_PERMISSIONS: ReadonlySet<string> = new Set\(\["webfetch", "websearch"\]\);/);
    assert.match(carte, /WEB_PERMISSIONS\.has\(request\.permission\) \? <p className="small">\{TEXTES_INTERNET\.partout\.demandeWeb\}<\/p> : null/);
  });

  it("carte d'accueil : plus « Internet sur demande » ; un assistant d'une version précédente « peut encore demander Internet, qui est fermé »", () => {
    const accueil = code(read("web", "pages", "chat", "WelcomeCards.tsx"));
    assert.equal(/Internet sur demande/.test(accueil), false);
    assert.match(accueil, /web \? ` · \$\{TEXTES_INTERNET\.partout\.carteAncien\}` : ""/);
    assert.equal(TEXTES.partout.carteAncien, "peut encore demander Internet, qui est fermé");
  });
});
