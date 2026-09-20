// Tests de croisement du train 5a V2 (plan d'exécution it5 §2.4, §5.3 ; propriété de l'intégrateur) : L44d (bibliothèque des
// méthodes et assistant de création), L44e (puce, bulle et bouton « Seconde lecture »), L47b (chronologie) et L46b (coûts et
// archives par équipe, web), ENSEMBLE, sur le câblage complet (« modules: "tous" ») et sur le faux opencode.
//
// Les quatre paquets de la vague sont des INTERFACES : chacun a été écrit sans voir les autres, sur les types et les textes
// posés par T5a en V0 et sur les routes livrées en V1. Ce que la vague doit prouver ensemble, et qu'aucun paquet ne pouvait
// prouver seul :
//   1. §5.3 « interface compilée sur les types de T5a » : les neuf fichiers web de la vague lisent les types, les textes, les
//      limites et les adresses de T5a, sans en recopier un seul, et passent tous par `web/lib/api-construction.ts` ; et les
//      RÉPONSES RÉELLES des routes de V1 et de V2 traversent les modules purs que ces vues appellent (le catalogue de
//      `GET /api/methods` dans `methodChipState`, `methodMenuState`, `wizardMethodState` et `suggestionsByAssistant` ; les
//      lignes de `GET …/chronologie` dans `chronologie()`). Le typecheck du FIN prouve la compilation ; ces cas prouvent que
//      les formes se rencontrent vraiment à l'exécution.
//   2. §5.3 « puce → corps `prompt_async` reçu par le faux avec le bloc » : ce que la puce de L44e retient, le composeur
//      l'ajoute au TEXTE du message, et c'est ce texte-là que le faux opencode reçoit — un seul envoi, aucun champ `system`,
//      aucun appel d'IA en plus (ligne d'honnêteté « Aucun appel d'IA en plus », §13.2). Un raccourci n'emporte aucun bloc.
//   3. §5.3 « bouton de Seconde lecture → envoi avec l'assistant et l'IA résolus par `/api/chat/resolve` » : le bouton résout
//      d'abord le Relecteur par la route de la 1.0, puis envoie le texte EXACT du §4.3 avec cet agent et cette IA ; le crochet
//      de L44c requalifie la ligne `chat_turns`, et le composeur retrouve l'assistant d'avant.
//   4. grille de la vague (XSS) : aucune des vues de la vague n'injecte de HTML — bloc de méthode, réponse de l'IA relue pour la
//      détection, extraits masqués des Archives et libellés de la chronologie sont rendus en texte par React.
//
// Ce que ce fichier NE refait PAS : la substance des modules purs (testée par chaque paquet et par le croisement de V0), les
// inscriptions de câblage (croisements-c5a-v0.test.ts, corrigées au train de V2) et le comportement des routes (V1).
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, it, type TestContext } from "node:test";
import { emptyActivity } from "./shared/activity.ts";
import {
  methodChipState,
  methodPresenceRows,
  secondReadingButtonLabel,
  secondReadingButtonVisible,
  secondReadingMessage,
  estDemandeDeSecondeLecture,
  methodBubbleRows,
  methodOfView,
  secondReadingFooter,
  secondReadingSendGuard,
} from "./shared/chat-methods-view.ts";
import { chronologie } from "./shared/chronologie.ts";
import {
  CONSTRUCTION_ROUTE_PATHS as CHEMINS,
  constructionPath,
  METHODS_PER_MESSAGE,
  SECOND_READING_CATALOG_ID,
  SECOND_READING_TURN_KIND,
} from "./shared/construction-constants.ts";
import { TEXTES as TEXTES_C5, secondReadingPrefix } from "./shared/construction-texts.ts";
import type { ChronologieResponse, ChronologieUsageRow, ChronologieView, MethodsResponse, MethodView } from "./shared/construction-types.ts";
import { methodDetected, splitMessageMethods } from "./shared/methods.ts";
import { methodMenuState, suggestionsByAssistant, wizardMethodState } from "./shared/methods-view.ts";
import { StudioService } from "./studio.ts";
import { type CockpitHarness, startCockpit } from "./test-support/cockpit-harness.ts";
import { nativeAgents } from "./test-support/fake-opencode.ts";

const MODEL = { providerID: "github-copilot", modelID: "gpt-5-mini" };
const RELECTEUR = "relecteur-critique";
const WEB_DIR = path.join(import.meta.dirname, "..", "web");

/** Les neuf fichiers web livrés par la vague : ce sont eux qui doivent tenir sur les types et les textes de T5a. */
const VUES_DE_LA_VAGUE = [
  "pages/assistants/methods/MethodsLibrary.tsx", // L44d
  "pages/assistants/methods/MethodCard.tsx", // L44d
  "pages/chat/methods/MethodChip.tsx", // L44e
  "pages/chat/methods/MethodBubble.tsx", // L44e
  "pages/chat/methods/MethodPresence.tsx", // L44e
  "pages/chat/methods/SecondReadingButton.tsx", // L44e
  "pages/chat/activity/Chronologie.tsx", // L47b
  "pages/costs/TeamCosts.tsx", // L46b
  "pages/archives/ArchiveTeams.tsx", // L46b
] as const;

const lireVue = (relatif: string): string => fs.readFileSync(path.join(WEB_DIR, relatif), "utf8");

// --- Harnais -------------------------------------------------------------------------------------------------------------------

/**
 * Câblage COMPLET : les quatre modules de la construction répondent, et les gardes de l'itération 1 tournent aussi. Le Studio
 * est RÉEL, sur le dossier temporaire du harnais : `GET /api/methods` lit les fichiers d'agent pour savoir qui porte quoi.
 */
const croisement = (t: TestContext) =>
  startCockpit(t, {
    modules: "tous",
    deps: (base) => ({
      studio: new StudioService({
        env: base.env,
        client: base.client,
        projects: base.projects,
        control: base.control,
        log: base.log,
        catalog: base.catalog,
      }),
    }),
  });

/** « Relecteur critique » installé : agent vu par opencode ET ligne `item_meta` venue du catalogue (L45a), comme en V1. */
function installerRelecteur(h: CockpitHarness): void {
  h.fake.setAgents([...nativeAgents(), { name: RELECTEUR, mode: "primary", options: {}, permission: [], model: MODEL }]);
  h.deps.lookup.invalidate();
  const now = Date.now();
  h.db
    .prepare(
      `INSERT INTO item_meta (kind, name, title, tier, task_size, origin, catalog_id, catalog_version, role, created_at, updated_at)
       VALUES ('agents', ?, 'Relecteur critique', 'rapide', 'S', 'catalogue', ?, 1, 'equipier', ?, ?)`,
    )
    .run(RELECTEUR, SECOND_READING_CATALOG_ID, now, now);
}

async function conversation(h: CockpitHarness, title: string): Promise<string> {
  const created = await h.call("POST", "/api/oc/session", { headers: h.headers.mutating, body: { title } });
  assert.equal(created.status, 200, created.body);
  return created.json<{ id: string }>().id;
}

/** Envoi facturé par le proxy, tel que le composeur (L44e) et le bouton de seconde lecture le font. */
const envoyer = (h: CockpitHarness, sessionId: string, corps: Record<string, unknown>) =>
  h.call("POST", `/api/oc/session/${sessionId}/prompt_async`, { headers: h.headers.mutating, body: corps });

const catalogue = async (h: CockpitHarness): Promise<MethodsResponse> => {
  const res = await h.call("GET", CHEMINS.methodes, { headers: h.headers.authed });
  assert.equal(res.status, 200, res.body);
  return res.json<MethodsResponse>();
};

/** Corps `prompt_async` reçus par le faux, dans l'ordre. */
const recus = (h: CockpitHarness): Record<string, unknown>[] =>
  h.fake.requests
    .filter((r) => r.method === "POST" && r.pathname.endsWith("/prompt_async"))
    .map((r) => r.body as Record<string, unknown>);

/** Texte du premier (et seul) morceau d'un corps `prompt_async`. */
function texteEnvoye(corps: Record<string, unknown>): string {
  const parts = corps.parts as { type: string; text?: string }[];
  assert.equal(parts.length, 1, "un envoi porte un seul morceau de texte");
  assert.equal(parts[0]?.type, "text");
  return parts[0]?.text ?? "";
}

const genres = (h: CockpitHarness, sessionId: string): string[] =>
  (h.db.prepare("SELECT kind FROM chat_turns WHERE session_id = ? ORDER BY id").all(sessionId) as unknown as { kind: string }[]).map((t) => t.kind);

// --- 1. Interface compilée sur les types de T5a -------------------------------------------------------------------------------

describe("croisement 5a V2 : les vues de la vague tiennent sur les types de T5a", () => {
  it("les neuf fichiers web lisent T5a et ne recopient ni type, ni limite, ni adresse", () => {
    // Noms des types de T5a : une vue qui en redéclarerait un se détacherait du contrat, et le typecheck ne le dirait pas
    // (deux formes identiques compilent). C'est exactement ce que le §5.3 veut empêcher.
    const TYPES_T5A = [
      "MethodView",
      "MethodsResponse",
      "SecondReadingEstimate",
      "ChronologieResponse",
      "ChronologieUsageRow",
      "ChronologieView",
      "TeamCostsResponse",
      "ArchiveTeamsResponse",
      "TeamConversationsResponse",
    ];
    for (const relatif of VUES_DE_LA_VAGUE) {
      const source = lireVue(relatif);
      const modulesT5a = ["construction-types.ts", "construction-texts.ts", "construction-constants.ts", "methods.ts", "methods-view.ts", "chat-methods-view.ts", "chronologie.ts"];
      assert.ok(
        modulesT5a.some((module) => source.includes(`server/shared/${module}`)),
        `${relatif} : aucune lecture des modules de T5a`,
      );
      for (const nom of TYPES_T5A) {
        for (const forme of [`interface ${nom}`, `type ${nom} =`]) {
          assert.ok(!source.includes(forme), `${relatif} : « ${forme} » redéclaré au lieu d'être importé de T5a`);
        }
      }
      // Les adresses des routes vivent dans `construction-constants.ts` et sont appelées par `api-construction.ts` : une vue
      // qui écrirait « /api/… » en clair pourrait diverger des fiches sans que rien ne tombe.
      assert.ok(!/["'`]\/api\//.test(source), `${relatif} : adresse « /api/… » recopiée au lieu de passer par api-construction.ts`);
    }
  });

  it("web/lib/api.ts n'a pas bougé : les appels de la construction passent par api-construction.ts", () => {
    const api = fs.readFileSync(path.join(WEB_DIR, "lib", "api.ts"), "utf8");
    for (const adresse of [CHEMINS.methodes, CHEMINS.coutsEquipes, CHEMINS.equipesConversations]) {
      assert.ok(!api.includes(adresse), `web/lib/api.ts porte l'adresse ${adresse} : elle appartient à api-construction.ts`);
    }
    const construction = fs.readFileSync(path.join(WEB_DIR, "lib", "api-construction.ts"), "utf8");
    for (const nom of ["getMethods", "estimateSecondReading", "getChronologie", "getTeamCosts", "getArchiveTeams", "getTeamConversations"]) {
      assert.ok(construction.includes(`export function ${nom}`), `api-construction.ts : ${nom} absent`);
    }
  });

  it("aucune vue de la vague n'injecte de HTML (XSS : bloc, réponse de l'IA, extraits, libellés)", () => {
    // Grille de la vague : tout ce qui vient d'une IA, d'un fichier ou d'opencode traverse ces vues. Le seul rendu permis est
    // celui de React, qui échappe. Un `Markdown` sur le bloc ou sur la réponse relue rouvrirait la porte.
    // Les formes cherchées sont celles de l'EMPLOI (« = », « ( », « < »), jamais le mot seul : les fichiers de la vague
    // écrivent « aucun dangerouslySetInnerHTML » dans leurs commentaires, ce qui est une promesse, pas une faute.
    const INJECTIONS = [/dangerouslySetInnerHTML\s*=/, /\.innerHTML\s*=/, /\.outerHTML\s*=/, /insertAdjacentHTML\s*\(/, /document\.write\s*\(/, /<Markdown\b/];
    for (const relatif of VUES_DE_LA_VAGUE) {
      const source = lireVue(relatif);
      for (const injection of INJECTIONS) {
        assert.ok(!injection.test(source), `${relatif} : ${injection.source}`);
      }
    }
  });

  it("le composeur et le bouton sont câblés sur ce que les cas suivants rejouent", () => {
    // Les deux cas dynamiques de ce fichier rejouent ce que font `Composer.tsx` et `SecondReadingButton.tsx` : sans ce
    // contrat, ils prouveraient seulement que le faux opencode reçoit ce qu'on lui envoie. Le précédent est
    // `croisements-it1-v4.test.ts`, qui lit `Composer.tsx` de la même manière.
    const composeur = lireVue("pages/chat/Composer.tsx");
    // Le raccourci est repéré sur le texte RÉELLEMENT envoyé (`text.trimStart()`), comme ChatPage.tsx le fait de son côté :
    // c'est la garde corrigée après la relecture de V2, sans quoi « ␣/resume » emportait le bloc en arguments du raccourci.
    assert.match(composeur, /const raccourci = \/\^\\\/\(\[\\w-\]\+\)\(\?=\\s\|\$\)\/\.exec\(text\.trimStart\(\)\)/, "le raccourci n'est plus repéré sur le texte envoyé");
    assert.match(composeur, /const blocs = trimmed === "" \|\| raccourci !== null \? "" : methodes\.map\(/, "les blocs ne viennent plus des méthodes retenues, ni le raccourci n'est plus écarté");
    assert.match(composeur, /const envoye = `\$\{trimmed\}\$\{blocs\}`/, "les blocs ne sont plus ajoutés à la fin du texte");
    assert.match(composeur, /onSubmit\(\{ text: envoye, attachments: kept \}\)/, "le texte envoyé n'est plus celui qui porte les blocs");
    assert.ok(!/\bsystem\s*:/.test(composeur), "le composeur envoie un champ `system` : une méthode est un TEXTE (D-5-08)");
    // Rien n'est retiré en silence : les méthodes retenues ne sont vidées que si leurs blocs sont partis, et les deux cas de
    // refus (raccourci, message sans texte) affichent leur phrase sous les méthodes retenues.
    assert.match(composeur, /if \(blocs !== ""\) setMethodes\(\[\]\);/, "les méthodes retenues sont vidées même quand aucun bloc n'est parti");
    assert.match(composeur, /methodChipReason\("raccourci"\)/, "la phrase du raccourci ne vient plus du module pur");
    assert.match(composeur, /methodChipReason\("sans-texte"\)/, "un message sans texte efface les méthodes retenues sans rien dire");

    const bouton = lireVue("pages/chat/methods/SecondReadingButton.tsx");
    assert.match(bouton, /await api\.resolveChat\(\{ directory, agent: relecteur\.name \}\)/, "le bouton ne résout plus l'assistant par /api/chat/resolve");
    assert.match(bouton, /oc\.promptAsync\(sessionId, directory, corps\(resolu\.send\.model/, "l'IA envoyée n'est plus celle que la route a résolue");
    assert.match(bouton, /agent: resolu\.agent/, "l'agent envoyé n'est plus celui que la route a résolu");
    // Garde ajoutée après la relecture de V2 : un Relecteur disparu ne doit pas faire partir l'envoi facturé à l'assistant de repli.
    assert.match(bouton, /secondReadingSendGuard\(\{/, "le bouton n'interroge plus la garde d'envoi");
    assert.match(bouton, /agentMissing: resolu\.agentMissing/, "le repli signalé par la route n'est plus lu");
    assert.match(bouton, /if \(!garde\.envoyer\)/, "la garde d'envoi n'arrête plus le clic");
  });

  it("GET /api/methods : la réponse réelle traverse les quatre modules purs des vues de la vague", async (t) => {
    const h = await croisement(t);
    const reponse = await catalogue(h);
    assert.ok(reponse.methods.length > 0, "catalogue vide : le croisement ne prouverait rien");

    // MethodChip (L44e) : la réponse de la route est le `MethodView[]` attendu par la puce.
    const puce = methodChipState({ methods: reponse.methods, agent: "build", estRaccourci: false, choisies: [] });
    assert.equal(puce.limite, reponse.limites.parMessage, "la puce n'a pas pris la limite rendue par la route");
    assert.ok(puce.items.length > 0, "aucune méthode attachable dans la réponse de la route");
    for (const item of puce.items) assert.ok(item.bloc.length > 0, `${item.id} : bloc vide`);

    // MethodCard (L44d) : le menu « Ajouter à un assistant » lit la même réponse, avec les limites de la route.
    const premiere = puce.items[0];
    assert.ok(premiere);
    const menu = methodMenuState({ name: "assistant-du-croisement", title: "Assistant", methods: [] }, { id: premiere.id }, reponse.limites);
    assert.deepEqual({ active: menu.active, code: menu.code }, { active: true, code: null });
    const plein = methodMenuState(
      { name: "assistant-plein", title: "Assistant", methods: reponse.methods.slice(0, reponse.limites.parAssistant).map((m) => m.id) },
      { id: premiere.id },
      reponse.limites,
    );
    assert.equal(plein.active, false, "la limite par assistant rendue par la route n'est pas appliquée");

    // AssistantWizard (L44d) : rien n'est pré-coché, et les groupes conseillés se construisent sur la même réponse.
    const brouillon = wizardMethodState({ methods: [] }, reponse.methods[0] as MethodView, { assistant: null, limites: reponse.limites });
    assert.equal(brouillon.cochee, false, "une méthode est pré-cochée dans l'assistant de création");
    for (const groupe of suggestionsByAssistant(reponse.methods)) {
      assert.ok(groupe.assistant.name.length > 0);
      assert.ok(groupe.methodes.length > 0, `${groupe.assistant.name} : groupe conseillé vide`);
    }
    h.assertNoGlobalRestart();
  });

  it("GET …/chronologie : la réponse réelle est un ChronologieUsageRow[] que le module pur de L47a accepte", async (t) => {
    const h = await croisement(t);
    const racine = await conversation(h, "Chronologie du croisement");
    const debut = Date.UTC(2026, 8, 20, 9);
    h.db
      .prepare(
        `INSERT INTO usage (message_id, session_id, root_id, provider_id, model_id, variant, agent, created_at, completed_at,
           tokens_input, tokens_output, tokens_reasoning, tokens_cache_read, tokens_cache_write, cost)
         VALUES (?, ?, ?, 'github-copilot', 'gpt-5-mini', NULL, 'build', ?, ?, 120, 30, 4, 8, 2, 0.25)`,
      )
      .run("msg_croisement_v2", racine, racine, debut, debut + 1_000);

    const res = await h.call("GET", constructionPath(CHEMINS.chronologie, racine), { headers: h.headers.authed });
    assert.equal(res.status, 200, res.body);
    const reponse = res.json<ChronologieResponse>();
    assert.deepEqual(Object.keys(reponse).sort(), ["rootId", "rows", "tronque"]);
    const ligne = reponse.rows[0];
    assert.ok(ligne, "aucune ligne rendue alors qu'une ligne usage a été semée");
    // Les clés sont comparées une à une : c'est le contrat de T5a, celui que `Chronologie.tsx` passe au module pur.
    assert.deepEqual(Object.keys(ligne).sort(), [
      "agent",
      "completedAt",
      "cost",
      "createdAt",
      "messageId",
      "modelId",
      "providerId",
      "sessionId",
      "tokensCacheRead",
      "tokensCacheWrite",
      "tokensInput",
      "tokensOutput",
      "tokensReasoning",
      "variant",
    ]);
    // Aucun texte dans la réponse : ni répertoire, ni erreur, ni titre (la route ne lit pas ces colonnes).
    assert.ok(!JSON.stringify(reponse).includes("/workspace"), "un chemin de travail est sorti de la chronologie");

    // Le passage route → module pur, exactement comme `Chronologie.tsx` le fait. La substance de `chronologie()` est couverte
    // par le croisement de V0 sur les captures p1, p2, p6 et p7 : ici, seule la rencontre des deux formes est prouvée.
    const lignes: readonly ChronologieUsageRow[] = reponse.rows;
    const vue: ChronologieView = chronologie(emptyActivity(racine), lignes, debut + 2_000);
    assert.equal(typeof vue.partiel, "boolean");
    assert.equal(vue.partiel, reponse.tronque, "« Déroulé partiel » ne suit pas la troncature de la route");
    assert.ok(Array.isArray(vue.rows) && Array.isArray(vue.groupes));
    h.assertNoGlobalRestart();
  });
});

// --- 2. Puce → corps prompt_async reçu par le faux ------------------------------------------------------------------------------

describe("croisement 5a V2 : la puce de méthode aboutit au corps reçu par le faux opencode", () => {
  it("deux méthodes retenues : leurs blocs partent DANS le texte, en un seul envoi, sans champ system", async (t) => {
    const h = await croisement(t);
    const ses = await conversation(h, "Incident à analyser");
    const reponse = await catalogue(h);

    // Ce que la personne fait : elle ouvre la puce, coche deux méthodes. `methodChipState` est la fonction que le popover de
    // L44e appelle ; `bloc` est exactement le texte que `MethodChip` retient dans `ChosenMethod.texte`.
    const puce = methodChipState({ methods: reponse.methods, agent: "build", estRaccourci: false, choisies: [] });
    const choisies = puce.items.slice(0, METHODS_PER_MESSAGE);
    assert.equal(choisies.length, METHODS_PER_MESSAGE, "moins de deux méthodes attachables : le cas ne serait pas celui du §5.3");
    const limite = methodChipState({
      methods: reponse.methods,
      agent: "build",
      estRaccourci: false,
      choisies: choisies.map((m) => m.id),
    });
    for (const item of limite.items.filter((i) => !i.choisie)) {
      assert.equal(item.active, false, `${item.id} : une troisième méthode reste choisissable`);
    }

    // Ce que le composeur fait (Composer.tsx, section `c5:methodes-envoi`) : le texte, puis les blocs, et rien d'autre.
    const ecrit = "Analyse ce journal et dis-moi ce qui a cassé.";
    const texte = `${ecrit}${choisies.map((m) => m.bloc).join("")}`;
    assert.equal((await envoyer(h, ses, { agent: "build", model: MODEL, parts: [{ type: "text", text: texte }] })).status, 204);

    const envois = recus(h);
    assert.equal(envois.length, 1, "un envoi et un seul : aucun appel d'IA en plus (§13.2)");
    const corps = envois[0];
    assert.ok(corps);
    assert.ok(!("system" in corps), "un champ `system` est parti : une méthode est un TEXTE, D-5-08");
    const recu = texteEnvoye(corps);
    for (const item of choisies) assert.ok(recu.includes(item.bloc), `${item.id} : bloc absent du corps reçu par le faux`);

    // Aller-retour : ce que le faux a reçu se relit avec `splitMessageMethods`, celle de la bulle (MessageView) et des archives.
    const relu = splitMessageMethods(recu);
    assert.equal(relu.texte, ecrit, "le texte écrit par la personne n'est pas retrouvé sous les blocs");
    assert.deepEqual(
      relu.methodes.map((m) => m.id),
      choisies.map((m) => m.id),
    );
    // La bulle repliée de L44e rend ces mêmes méthodes, par leur titre du catalogue.
    const bulles = methodBubbleRows(relu.methodes, reponse.methods);
    assert.deepEqual(
      bulles.map((b) => b.titre),
      choisies.map((m) => m.titre),
    );
    h.assertNoGlobalRestart();
  });

  it("raccourci : la puce refuse, et le corps reçu par le faux ne porte aucun bloc", async (t) => {
    const h = await croisement(t);
    const ses = await conversation(h, "Raccourci");
    const reponse = await catalogue(h);

    const puce = methodChipState({ methods: reponse.methods, agent: "build", estRaccourci: true, choisies: [] });
    assert.equal(puce.boutonActif, false);
    assert.ok(puce.boutonRaison, "aucune raison donnée pour le refus du raccourci");
    for (const item of puce.items) assert.equal(item.active, false, `${item.id} : choisissable dans un raccourci`);

    // Composer.tsx : `commandName !== null` → aucun bloc n'est ajouté, mais rien n'est retiré en silence (la phrase reste
    // affichée à l'écran, sous les méthodes retenues).
    const texte = "/revue-cab";
    assert.equal((await envoyer(h, ses, { agent: "build", model: MODEL, parts: [{ type: "text", text: texte }] })).status, 204);
    const corps = recus(h)[0];
    assert.ok(corps);
    const recu = texteEnvoye(corps);
    assert.equal(recu, texte);
    assert.deepEqual(splitMessageMethods(recu).methodes, []);
    h.assertNoGlobalRestart();
  });

  it("raccourci précédé d'une espace : le bloc ne part ni dans le texte, ni en arguments du raccourci", async (t) => {
    const h = await croisement(t);
    const ses = await conversation(h, "Raccourci à espace de tête");
    const reponse = await catalogue(h);
    const choisie = methodChipState({ methods: reponse.methods, agent: "build", estRaccourci: false, choisies: [] }).items[0];
    assert.ok(choisie, "aucune méthode attachable : le cas ne prouverait rien");

    // La personne tape une espace avant la barre oblique. Les deux repérages doivent tomber d'accord : celui du composeur
    // (Composer.tsx, section `c5:methodes-raccourci`) et celui de l'envoi (ChatPage.tsx), qui lit le texte ROGNÉ.
    const brut = " /resume";
    const raccourci = /^\/([\w-]+)(?=\s|$)/.exec(brut.trimStart())?.[1] ?? null;
    const ancien = /^\/([\w-]+)(?=\s|$)/.exec(brut)?.[1] ?? null;
    assert.equal(ancien, null, "le texte brut ne voit pas le raccourci : c'est la source du défaut corrigé");
    assert.equal(raccourci, "resume", "le composeur ne reconnaît pas « ␣/resume » comme un raccourci");

    const trimmed = brut.trim();
    const blocs = trimmed === "" || raccourci !== null ? "" : choisie.bloc;
    assert.equal(blocs, "", "le bloc de méthode part avec un raccourci (C §9.4)");
    const envoye = `${trimmed}${blocs}`;

    // Ce que ChatPage.tsx fait du texte envoyé : le raccourci est reconnu, et ses ARGUMENTS restent vides.
    const commande = /^\/([\w-]+)(?:\s+([\s\S]*))?$/.exec(envoye);
    assert.equal(commande?.[1], "resume");
    assert.equal(commande?.[2], undefined, "le bloc de méthode est passé en arguments du raccourci ($ARGUMENTS)");
    // Avec l'ancien repérage, le bloc partait bel et bien en arguments : le cas ci-dessus l'empêche.
    const commandeAvant = /^\/([\w-]+)(?:\s+([\s\S]*))?$/.exec(`${trimmed}${choisie.bloc}`);
    assert.ok(commandeAvant?.[2]?.includes("cockpit:methode-message"), "le scénario du défaut n'est plus reproduit");

    assert.equal((await envoyer(h, ses, { agent: "build", model: MODEL, parts: [{ type: "text", text: envoye }] })).status, 204);
    const corps = recus(h)[0];
    assert.ok(corps);
    const recu = texteEnvoye(corps);
    assert.equal(recu, trimmed);
    assert.deepEqual(splitMessageMethods(recu).methodes, []);
    assert.ok(!recu.includes("cockpit:methode-message"), "un bloc de méthode est arrivé au faux opencode avec un raccourci");
    h.assertNoGlobalRestart();
  });

  it("présence de la méthode dans la réponse : la section trouvée, et rien de plus", async (t) => {
    const h = await croisement(t);
    const reponse = await catalogue(h);
    const methode = reponse.methods.find((m) => m.kind === "consigne");
    assert.ok(methode, "aucune méthode de genre « consigne » au catalogue");
    const demandee = { id: methode.id, version: methode.version, bloc: methode.bloc };

    // « Méthode appliquée » ne dit QUE la présence de la section (spéc. §6 l.1051) : l'en-tête ouvre une ligne de la réponse.
    const avec = `Voici mon analyse.\n\n${methodOfView(methode).enTete}\nRien ne me paraît sûr à ce stade.`;
    assert.equal(methodDetected(avec, methodOfView(methode)), true);
    assert.equal(methodDetected("Voici mon analyse, sans section.", methodOfView(methode)), false);
    const lignes = methodPresenceRows({ demandees: [demandee], reponse: avec, catalogue: reponse.methods });
    assert.equal(lignes.length, 1);
    assert.equal(lignes[0]?.presente, true);
    // Une méthode que le catalogue ne connaît plus ne produit AUCUN verdict : jamais « non appliquée » par ignorance.
    assert.deepEqual(
      methodPresenceRows({ demandees: [{ id: "methode-disparue", version: 1, bloc: "" }], reponse: avec, catalogue: reponse.methods }),
      [],
    );
    h.assertNoGlobalRestart();
  });
});

// --- 3. Bouton « Seconde lecture » → /api/chat/resolve puis envoi ------------------------------------------------------------------

describe("croisement 5a V2 : le bouton « Seconde lecture » envoie avec l'assistant et l'IA résolus", () => {
  it("resolve puis prompt_async : agent et IA du Relecteur, texte exact du §4.3, ligne requalifiée, composeur intact", async (t) => {
    const h = await croisement(t);
    installerRelecteur(h);
    const ses = await conversation(h, "Incident de production");

    // Une réponse ordinaire, avec un autre assistant : c'est sous elle que le bouton apparaît.
    assert.equal((await envoyer(h, ses, { agent: "build", model: MODEL, parts: [{ type: "text", text: "Analyse ce journal." }] })).status, 204);
    const avant = await h.call("GET", `/api/chat/choices/${ses}`, { headers: h.headers.authed });
    assert.equal(avant.json<{ agent: string }>().agent, "build");

    // Le bouton n'est proposé que sous une réponse TERMINÉE qui n'est ni un repère ni une relecture (L44e).
    assert.equal(secondReadingButtonVisible({ terminee: true, repere: false, estSecondeLecture: false }).visible, true);
    assert.equal(secondReadingButtonVisible({ terminee: false, repere: false, estSecondeLecture: false }).visible, false);
    assert.equal(secondReadingButtonVisible({ terminee: true, repere: false, estSecondeLecture: true }).visible, false);

    // Étape 1 du bouton : la résolution passe par la route de la 1.0, jamais par un choix d'IA fait dans l'interface.
    const resolu = await h.call("POST", "/api/chat/resolve", {
      headers: h.headers.mutating,
      body: { directory: h.fake.directory, agent: RELECTEUR },
    });
    assert.equal(resolu.status, 200, resolu.body);
    const turn = resolu.json<{ agent: string; send: { model: { providerID: string; modelID: string }; variant?: string }; display: { problems: { blocking: boolean }[] } }>();
    assert.equal(turn.agent, RELECTEUR, "la route n'a pas résolu le Relecteur");
    assert.deepEqual(turn.display.problems.filter((p) => p.blocking), [], "un problème bloquant : le bouton n'enverrait rien");

    // Étape 2 : UN SEUL envoi, avec l'agent ET l'IA que la route vient de rendre, et le texte EXACT du §4.3.
    const texte = secondReadingMessage("Analyser un incident");
    assert.ok(texte.startsWith(secondReadingPrefix("reponse")), "le message du bouton n'a pas le début que le serveur reconnaît");
    assert.equal(estDemandeDeSecondeLecture(texte), true);
    const corps = { agent: turn.agent, model: turn.send.model, ...(turn.send.variant ? { variant: turn.send.variant } : {}), parts: [{ type: "text", text: texte }] };
    assert.equal((await envoyer(h, ses, corps)).status, 204);

    const envois = recus(h);
    assert.equal(envois.length, 2, "la seconde lecture a produit plus d'un envoi");
    const relecture = envois[1];
    assert.ok(relecture);
    assert.equal(relecture.agent, RELECTEUR);
    assert.deepEqual(relecture.model, turn.send.model, "l'IA envoyée n'est pas celle qu'a résolue /api/chat/resolve");
    assert.equal(texteEnvoye(relecture), texte);

    // Crochet de L44c : la ligne est requalifiée, et le composeur retrouve l'assistant d'AVANT la relecture.
    assert.deepEqual(genres(h, ses), ["message", SECOND_READING_TURN_KIND]);
    const apres = await h.call("GET", `/api/chat/choices/${ses}`, { headers: h.headers.authed });
    assert.equal(apres.json<{ agent: string }>().agent, "build", "le composeur a changé d'assistant tout seul");

    // Pied affiché sous la réponse du Relecteur : reconnu par le MÊME début fixe que le crochet du serveur.
    assert.ok(secondReadingFooter(texte), "aucun pied sous une demande de seconde lecture");
    assert.equal(secondReadingFooter("Analyse ce journal."), null);
    h.assertNoGlobalRestart();
  });

  it("Relecteur disparu d'opencode : la route retombe sur l'assistant par défaut, et RIEN n'est envoyé", async (t) => {
    const h = await croisement(t);
    // Le Relecteur a une ligne `item_meta` (il a été installé), mais opencode ne le déclare plus : supprimé depuis la page
    // Assistants, ou passé en sous-agent dans le Studio. L'estimation lue plus tôt, elle, est encore en mémoire.
    const now = Date.now();
    h.db
      .prepare(
        `INSERT INTO item_meta (kind, name, title, tier, task_size, origin, catalog_id, catalog_version, role, created_at, updated_at)
         VALUES ('agents', ?, 'Relecteur critique', 'rapide', 'S', 'catalogue', ?, 1, 'equipier', ?, ?)`,
      )
      .run(RELECTEUR, SECOND_READING_CATALOG_ID, now, now);
    const ses = await conversation(h, "Incident sans relecteur");
    assert.equal((await envoyer(h, ses, { agent: "build", model: MODEL, parts: [{ type: "text", text: "Analyse ce journal." }] })).status, 204);

    // Étape 1 du bouton : la route ne REFUSE pas un assistant inconnu, elle retombe sur l'assistant par défaut du chat.
    const resolu = await h.call("POST", "/api/chat/resolve", { headers: h.headers.mutating, body: { directory: h.fake.directory, agent: RELECTEUR } });
    assert.equal(resolu.status, 200, resolu.body);
    const turn = resolu.json<{ agent: string; agentMissing: string | null; display: { problems: { message: string; blocking: boolean }[] } }>();
    assert.equal(turn.agentMissing, RELECTEUR, "la route ne signale plus le repli : le scénario du défaut n'est plus reproduit");
    assert.notEqual(turn.agent, RELECTEUR);
    assert.deepEqual(turn.display.problems.filter((p) => p.blocking), [], "aucun problème bloquant ici : seul `agentMissing` dit le repli");

    // Étape 2 : la garde du bouton s'arrête là. Sans elle, l'envoi facturé partait à l'Assistant général, avec ses droits,
    // son IA et un montant qui n'était plus celui de l'infobulle.
    const garde = secondReadingSendGuard({
      relecteur: RELECTEUR,
      agent: turn.agent,
      agentMissing: turn.agentMissing,
      problemes: turn.display.problems,
    });
    assert.equal(garde.envoyer, false, "l'envoi part à l'assistant de repli");
    assert.equal(garde.code, "absent");
    assert.equal(garde.message, TEXTES_C5.partout.secondeLecture.absente);

    // Rien de plus n'est parti au faux, et la conversation n'a toujours qu'une ligne « message ».
    assert.equal(recus(h).length, 1, "un envoi de seconde lecture est parti alors que le Relecteur n'est plus là");
    assert.deepEqual(genres(h, ses), ["message"]);
    const apres = await h.call("GET", `/api/chat/choices/${ses}`, { headers: h.headers.authed });
    assert.equal(apres.json<{ agent: string }>().agent, "build", "le composeur a changé d'assistant tout seul");
    h.assertNoGlobalRestart();
  });

  it("garde d'envoi : l'assistant résolu doit être le Relecteur, et aucun refus bloquant ne doit rester", () => {
    const problemes = [{ message: "Choisissez une IA.", blocking: true }];
    assert.deepEqual(secondReadingSendGuard({ relecteur: RELECTEUR, agent: RELECTEUR, agentMissing: null, problemes: [] }), {
      envoyer: true,
      code: null,
      message: null,
    });
    // Un refus bloquant garde la phrase du serveur, jamais celle du Relecteur absent.
    assert.deepEqual(secondReadingSendGuard({ relecteur: RELECTEUR, agent: RELECTEUR, agentMissing: null, problemes }), {
      envoyer: false,
      code: "bloquant",
      message: "Choisissez une IA.",
    });
    // Agent remplacé sans que la route le signale : l'envoi ne part pas davantage.
    assert.equal(secondReadingSendGuard({ relecteur: RELECTEUR, agent: "build", agentMissing: null, problemes: [] }).code, "absent");
  });

  it("libellé et estimation : « ≈ » et jamais « au moins », montant absent quand la base ne dit rien", async (t) => {
    const h = await croisement(t);
    installerRelecteur(h);
    const ses = await conversation(h, "Estimation du croisement");

    const estime = await h.call("POST", CHEMINS.secondeLectureEstimation, {
      headers: h.headers.mutating,
      body: { directory: h.fake.directory, sessionId: ses, cible: "reponse" },
    });
    assert.equal(estime.status, 200, estime.body);
    const estimation = estime.json<{ installe: boolean; base: string; usd: number | null }>();
    assert.equal(estimation.installe, true, "le Relecteur installé n'est pas vu par l'estimation");

    // Ligne d'honnêteté §13.2 : « ≈ », jamais « au moins » ni « minimum » ; aucun montant inventé.
    const libelle = secondReadingButtonLabel("0,01");
    assert.ok(libelle.includes("≈"), libelle);
    for (const interdit of ["au moins", "minimum"]) assert.ok(!libelle.toLowerCase().includes(interdit), libelle);
    assert.ok(!secondReadingButtonLabel(null).includes("("), "un montant est annoncé alors qu'aucune base ne le fonde");

    // Lecture seule : l'estimation n'écrit aucune ligne et n'envoie rien à opencode (P5, D-5-22).
    assert.equal((h.db.prepare("SELECT COUNT(*) AS n FROM chat_turns").get() as { n: number }).n, 0);
    assert.equal(recus(h).length, 0);
    h.assertNoGlobalRestart();
  });
});
