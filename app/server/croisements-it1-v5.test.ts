// Tests de croisement du train it1 V5 (plan d'exécution §2.3, §5.2 ; propriété de l'intégrateur) : L7b-2 (e2e de l'interface) et
// DOC1 (documentation de l'itération 1), sur le câblage complet (modules « tous »). Ce que la vague doit prouver ensemble, et
// qu'aucun paquet ne peut prouver seul :
//   1. « lancé sans confirmation » (§6 l.1048, §4.10 ; échec remis par L7b-2, phrase sans paquet désigné) : la capture p2 rejouée
//      sur le cockpit complet enregistre la délégation du raccourci `subtask` comme lancée sans confirmation (L4a, L4b) ; un onglet
//      ouvert avant (direct, flux du hub) et un onglet rouvert après (GET …/facts) en tirent la même ligne (L4c) ; « Qui
//      travaille ? » (L5b) dit la phrase dans les deux modes, précédée du nom du raccourci en mode Avancé, et seulement pour cette
//      ligne ; les délégations de l'IA de p1 (avec et sans demande) ne la disent jamais ; la phrase que cherche le scénario
//      it1-ui-p2-raccourci (L7b-2) est celle des textes, et ActorList la rend dans les deux modes ; un appel `task` dont l'IA a
//      rempli elle-même `command` et qui a posé une demande, accordée « once », ne la dit jamais, ni le nom du raccourci, et le
//      Déroulé le dit « décidé par l'IA » (relecture 1-vague-5) ;
//   2. documentation (DOC1, L7a, L7b-1, L7b-2) : liens internes et ancres (calculées comme GitHub) de README.md,
//      docs/RECAPITULATIF.md et e2e/README.md ; chaque scénario du banc est cité dans e2e/README.md et chaque scénario cité dans la
//      documentation existe ; chaque scénario it1 qui agit sur opencode tourne sous le témoin P6 ; chaque endroit du banc qui
//      aucun scénario ne suppose plus le HTTP ni ne parle au cockpit hors du transport du banc (écart D-05 levé par R105b), et les
//      deux documents le disent ; le RECAPITULATIF ne garde pas en
//      « reste à faire » ce que son §10 donne pour fait (relecture 1-vague-5).
// Le banc e2e lui-même (run-e2e.sh --faux sur tous les scénarios) est joué par l'intégrateur, hors de npm test (décision D-06).
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import { type ActivityClock, type ActivitySource, ActivityStore } from "../web/lib/useActivity.ts";
import { plannedOf } from "../web/pages/chat/turn.ts";
import type { ActivityFact, ActivityResponse, FactsResponse } from "./shared/activity-types.ts";
import { emptyActivity, type LiveRow, liveRows, replayFacts } from "./shared/activity.ts";
import { mentionsRaccourci, TEXTES } from "./shared/activity-texts.ts";
import { type CockpitHarness, startCockpit } from "./test-support/cockpit-harness.ts";
import { readCapture } from "./test-support/fake-opencode.ts";
import { until } from "./test-support/helpers.ts";

/** Racine des captures p1 et p2 (expérience « ocgraph », opencode 1.18.30). */
const ROOT = "ses_f618ff214ffevi6gfuGx6TvpTP";
const P1 = "p1-delegation-parallele.jsonl";
const P2 = "p2-commande-subtask.jsonl";
const COMMANDE = "revue-croisee";
/** Appel `task` de p1 qui passe par une demande d'autorisation (per_09e7…), accordée « once ». */
const CALL_DEMANDE = "call_397a867685754eee8591b009";

type CaptureRow = ReturnType<typeof readCapture>[number];

const APP_DIR = path.join(import.meta.dirname, "..");
const REPO_DIR = path.join(APP_DIR, "..");
const ACTOR_LIST_FILE = path.join(APP_DIR, "web", "pages", "chat", "activity", "ActorList.tsx");
const SCENARIOS_DIR = path.join(REPO_DIR, "e2e", "scenarios");
const DOCS = ["README.md", path.join("docs", "RECAPITULATIF.md"), path.join("e2e", "README.md")] as const;

async function getJson<T>(h: CockpitHarness, pathname: string): Promise<T> {
  const res = await h.call("GET", pathname, { headers: h.headers.authed });
  assert.equal(res.status, 200, `${pathname} : ${res.body}`);
  return res.json<T>();
}

/** Horloge qui avance à chaque lecture : chaque changement est rendu tout de suite (aucune minuterie n'est jouée). */
function eagerClock(): ActivityClock {
  let t = 1_800_000_000_000;
  return { now: () => (t += 1_000), setTimer: () => null, clearTimer: () => undefined };
}

/** Onglet ouvert AVANT la capture : relecture vide (GET …/facts), puis le flux du hub seul (événements relayés et faits). */
async function openLiveTab(t: { after(fn: () => void): void }, h: CockpitHarness): Promise<ActivityStore> {
  const source: ActivitySource = {
    facts: async (rootId) => getJson<FactsResponse>(h, `/api/conversations/${rootId}/facts?since=0`),
    session: async () => null,
    children: async () => [],
    messages: async () => [],
  };
  const store = new ActivityStore(ROOT, h.fake.directory, source, eagerClock());
  const unsubscribe = h.hub.subscribe((event) => store.push(event));
  t.after(() => {
    unsubscribe();
    store.stop();
  });
  store.start();
  await until(() => store.getSnapshot().loaded);
  return store;
}

/**
 * p1 où l'IA remplit elle-même le paramètre facultatif `command` de l'outil `task` (opencode 1.18.30 : « The command that
 * triggered this task ») sur l'appel qui passe par une demande (CALL_DEMANDE), accordée « once » : la demande dépend seulement de
 * bypassAgentCheck, jamais de ce paramètre.
 */
function p1CommandeDeLIa(): CaptureRow[] {
  let touched = 0;
  const rows = readCapture(P1).map((row) => {
    const payload = row.wire.payload as { type: string; properties?: { part?: { tool?: unknown; callID?: unknown; state?: { input?: unknown } } } };
    const part = payload.properties?.part;
    if (payload.type !== "message.part.updated" || part?.tool !== "task" || part.callID !== CALL_DEMANDE || typeof part.state?.input !== "object") return row;
    touched += 1;
    const copy = structuredClone(row);
    (copy.wire.payload as unknown as { properties: { part: { state: { input: Record<string, unknown> } } } }).properties.part.state.input.command = COMMANDE;
    return copy;
  });
  assert.equal(touched, 4, "parties `task` de l'appel demandé : en préparation, deux fois en cours, terminée");
  return rows;
}

/** Capture(s) rejouée(s) sur le flux du faux jusqu'au repos de la racine ; lignes du direct et d'un onglet rouvert (faits relus). */
async function replayCapture(
  t: { after(fn: () => void): void },
  h: CockpitHarness,
  capture: string | readonly CaptureRow[],
): Promise<{ direct: readonly LiveRow[]; reopened: readonly LiveRow[]; activity: ActivityResponse }> {
  const tab = await openLiveTab(t, h);
  const rows = typeof capture === "string" ? readCapture(capture) : capture;
  // p2 commence sur une conversation déjà ouverte (même racine que p1) : sa création, celle de p1, précède le raccourci.
  const created = (row: CaptureRow) => {
    const payload = row.wire.payload as { type: string; properties?: { info?: { id?: unknown } } };
    return payload.type === "session.created" && payload.properties?.info?.id === ROOT;
  };
  if (!rows.some(created)) {
    const opening = readCapture(P1).find(created);
    assert.ok(opening, "création de la racine dans p1");
    h.fake.emitRaw(opening.wire);
  }
  for (const { wire } of rows) h.fake.emitRaw(wire);
  // Un repos de la racine par capture rejouée (session.idle de la racine) : p1 suivie de p2 en compte deux.
  const idles = rows.filter(({ wire }) => {
    const payload = wire.payload as { type: string; properties?: { sessionID?: unknown } };
    return payload.type === "session.idle" && payload.properties?.sessionID === ROOT;
  }).length;
  const rootAtRest = (fact: ActivityFact) => fact.sessionId === ROOT && fact.kind === "statut" && fact.data.etat === "repos";
  await until(() => h.cockpitEvents().filter((e) => e.type === "activite.fait" && rootAtRest(e.data as ActivityFact)).length >= Math.max(1, idles), 10_000);
  const { facts } = await getJson<FactsResponse>(h, `/api/conversations/${ROOT}/facts?since=0`);
  await until(() => tab.getSnapshot().state.facts.length === facts.length, 5_000);
  const activity = await getJson<ActivityResponse>(h, `/api/conversations/${ROOT}/activity`);
  const reopened = liveRows(replayFacts(emptyActivity(ROOT), facts), Number.MAX_SAFE_INTEGER);
  return { direct: tab.getSnapshot().rows, reopened, activity };
}

/** Ce que « Qui travaille ? » écrit sous le nom de chaque ligne à propos d'un raccourci, par mode (comme ActorList). */
const mentions = (rows: readonly LiveRow[], avance: boolean) => rows.map((row) => mentionsRaccourci(row.commande, row.sansConfirmation, avance));

describe("croisements it1 V5 : « lancé sans confirmation » sur la capture p2 (L0, L4a, L4b, L4c, L5b, L7b-2)", () => {
  it("p2 sur le cockpit complet : délégation du raccourci enregistrée sans confirmation ; même ligne en direct et rouverte ; phrase dans les deux modes, nom du raccourci en Avancé, sur cette seule ligne", async (t) => {
    const h = await startCockpit(t, { modules: "tous" });
    const { direct, reopened, activity } = await replayCapture(t, h, P2);

    // L4a, L4b : la délégation du raccourci, lancée sans demande d'autorisation.
    assert.deepEqual(
      activity.delegations.map((d) => [d.source, d.command, d.sansConfirmation, d.permissionId, d.state]),
      [["raccourci", COMMANDE, true, null, "terminee"]],
    );
    const child = activity.delegations[0]?.childSessionId ?? null;
    assert.ok(child !== null, "enfant du raccourci");

    // L4c : même ligne pour le raccourci en direct et après réouverture ; seule la ligne de l'enfant porte la commande.
    for (const [label, rows] of [["direct", direct], ["rouvert", reopened]] as const) {
      const row: LiveRow | undefined = rows.find((r) => r.sessionId === child && !r.sansSession);
      assert.equal(row?.commande, COMMANDE, `${label} : commande sur la ligne de l'enfant`);
      assert.deepEqual(
        rows.filter((r) => r.commande !== null).map((r) => r.sessionId),
        [child],
        `${label} : aucune autre ligne ne porte de raccourci`,
      );
      // L5b : les mentions, dans les deux modes ; elles suivent l'absence de demande (sansConfirmation), pas la seule commande.
      assert.equal(row?.sansConfirmation, true, `${label} : raccourci lancé sans demande`);
      const sans = row?.sansConfirmation ?? false;
      assert.deepEqual(mentionsRaccourci(row?.commande ?? null, sans, true), [`raccourci /${COMMANDE}`, "lancé sans confirmation"], label);
      assert.deepEqual(mentionsRaccourci(row?.commande ?? null, sans, false), ["lancé sans confirmation"], label);
      assert.equal(mentions(rows, false).flat().length, 1, `${label} : une seule mention en mode Simple`);
      assert.deepEqual(plannedOf(row ?? null), { kind: "prevu", text: `raccourci /${COMMANDE}` }, `${label} : Déroulé`);
    }
    assert.deepEqual(h.fake.failures, []);
    h.assertNoGlobalRestart();
  });

  it("p1 : délégations de l'IA, avec et sans demande d'autorisation, jamais dites « lancé sans confirmation »", async (t) => {
    const h = await startCockpit(t, { modules: "tous", settings: { ui: { mode: "avance" } } });
    const { direct, reopened, activity } = await replayCapture(t, h, P1);
    assert.deepEqual(
      activity.delegations.map((d) => [d.source, d.command, d.sansConfirmation, d.permissionId === null]),
      [
        ["ia", null, false, true],
        ["ia", null, false, false],
      ],
    );
    for (const rows of [direct, reopened]) {
      assert.ok(rows.length >= 3, "conversation et ses deux délégations");
      for (const avance of [true, false]) assert.deepEqual(mentions(rows, avance).flat(), []);
    }
  });

  it("p1, `command` rempli par l'IA sur l'appel qui passe par une demande accordée « once » : enregistré avec confirmation ; ni « lancé sans confirmation » ni nom de raccourci, en direct comme rouvert ; Déroulé « décidé par l'IA »", async (t) => {
    const h = await startCockpit(t, { modules: "tous", settings: { ui: { mode: "avance" } } });
    const { direct, reopened, activity } = await replayCapture(t, h, p1CommandeDeLIa());
    assert.deepEqual(
      activity.delegations.map((d) => [d.callId, d.source, d.command, d.sansConfirmation, d.permissionId === null, d.state]),
      [
        ["call_d16cb6e832bd48ac81b65537", "ia", null, false, true, "terminee"],
        [CALL_DEMANDE, "raccourci", COMMANDE, false, false, "terminee"],
      ],
    );
    const child = activity.delegations.find((d) => d.callId === CALL_DEMANDE)?.childSessionId ?? null;
    assert.ok(child !== null, "enfant de l'appel demandé");
    for (const [label, rows] of [["direct", direct], ["rouvert", reopened]] as const) {
      const row: LiveRow | undefined = rows.find((r) => r.sessionId === child && !r.sansSession);
      assert.deepEqual([row?.commande, row?.sansConfirmation], [COMMANDE, false], `${label} : commande écrite par l'IA, demande vue`);
      for (const avance of [true, false]) assert.deepEqual(mentions(rows, avance).flat(), [], `${label}, ${avance ? "Avancé" : "Simple"}`);
      assert.deepEqual(plannedOf(row ?? null), { kind: "non-prevu", text: "non prévu : décidé par l'IA" }, `${label} : Déroulé`);
    }
    assert.deepEqual(h.fake.failures, []);
    h.assertNoGlobalRestart();
  });

  it("p1 (commande de l'IA, demandée) puis p2 (raccourci `subtask`) dans la même conversation : seule la ligne du raccourci dit « lancé sans confirmation », en direct comme rouverte", async (t) => {
    const h = await startCockpit(t, { modules: "tous", settings: { ui: { mode: "avance" } } });
    const { direct, reopened, activity } = await replayCapture(t, h, [...p1CommandeDeLIa(), ...readCapture(P2)]);
    assert.deepEqual(
      activity.delegations.map((d) => [d.source, d.command, d.sansConfirmation, d.permissionId === null]),
      [
        ["ia", null, false, true],
        ["raccourci", COMMANDE, false, false],
        ["raccourci", COMMANDE, true, true],
      ],
    );
    const shortcut = activity.delegations[2]?.childSessionId ?? null;
    assert.ok(shortcut !== null, "enfant du raccourci");
    for (const [label, rows] of [["direct", direct], ["rouvert", reopened]] as const) {
      assert.equal(rows.filter((r) => r.commande !== null).length, 2, `${label} : deux lignes portent la même commande`);
      assert.deepEqual(
        rows.filter((r) => mentionsRaccourci(r.commande, r.sansConfirmation, false).length > 0).map((r) => r.sessionId),
        [shortcut],
        `${label} : la seule ligne du raccourci`,
      );
      assert.deepEqual(mentions(rows, false).flat(), ["lancé sans confirmation"], `${label} : mode Simple`);
      assert.deepEqual(mentions(rows, true).flat(), [`raccourci /${COMMANDE}`, "lancé sans confirmation"], `${label} : mode Avancé`);
    }
    assert.deepEqual(h.fake.failures, []);
    h.assertNoGlobalRestart();
  });

  it("phrase du tableau d'honnêteté : celle que cherche it1-ui-p2-raccourci (L7b-2) ; ActorList la rend dans les deux modes", () => {
    assert.equal(TEXTES.partout.sansConfirmation, "lancé sans confirmation");
    // Une commande seule ne dit rien (l'IA peut remplir `command` et passer par une demande) ; sans commande non plus.
    for (const avance of [true, false]) {
      assert.deepEqual(mentionsRaccourci(COMMANDE, false, avance), []);
      assert.deepEqual(mentionsRaccourci(null, true, avance), []);
    }
    const commun =fs.readFileSync(path.join(SCENARIOS_DIR, "it1-ui-commun.mjs"), "utf8");
    assert.equal(/\bsansConfirmation: "([^"]+)"/.exec(commun)?.[1], TEXTES.partout.sansConfirmation, "PHRASES.sansConfirmation du banc");
    assert.match(fs.readFileSync(path.join(SCENARIOS_DIR, "it1-ui-p2-raccourci.mjs"), "utf8"), /includes\(PHRASES\.sansConfirmation\)/);
    // ActorList : les mentions sont rendues quel que soit le mode (jamais derrière « advanced ? »), celles du mode Simple comprises.
    const source = fs.readFileSync(ACTOR_LIST_FILE, "utf8");
    assert.match(source, /<ActorExtra row=\{row\} advanced=\{advanced\} \/>/);
    assert.doesNotMatch(source, /advanced \? <ActorExtra/);
    // … et suivent l'absence de demande (row.sansConfirmation), jamais la seule commande.
    assert.match(source, /: mentionsRaccourci\(row\.commande, row\.sansConfirmation, false\)/);
    assert.match(source, /\.\.\.mentionsRaccourci\(row\.commande, row\.sansConfirmation, true\)/);
    assert.equal(source.match(/mentionsRaccourci\(/g)?.length, 2, "deux appels : les deux ci-dessus");
  });
});

// --- Documentation ---------------------------------------------------------------------------------------------------------------

/** Lignes hors blocs de code clôturés, avec leur numéro. */
function outsideCode(text: string): Array<{ n: number; line: string }> {
  const out: Array<{ n: number; line: string }> = [];
  let fenced = false;
  text.split(/\r?\n/).forEach((line, i) => {
    if (/^\s*(```|~~~)/.test(line)) {
      fenced = !fenced;
      return;
    }
    if (!fenced) out.push({ n: i + 1, line });
  });
  return out;
}

/** Ancre d'un titre comme GitHub (github-slugger) : texte rendu, minuscules, ponctuation retirée, espaces → « - ». */
function slug(title: string): string {
  return title
    .replace(/`([^`]*)`/g, "$1")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\*\*|__/g, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{M}\p{N}\p{Pc} -]/gu, "")
    .replace(/ /g, "-");
}

function anchorsOf(file: string): Set<string> {
  const seen = new Map<string, number>();
  const out = new Set<string>();
  for (const { line } of outsideCode(fs.readFileSync(file, "utf8"))) {
    const m = /^#{1,6}\s+(.*?)\s*#*\s*$/.exec(line);
    if (!m?.[1]) continue;
    const base = slug(m[1]);
    const count = seen.get(base) ?? 0;
    out.add(count === 0 ? base : `${base}-${count}`);
    seen.set(base, count + 1);
  }
  return out;
}

describe("croisements it1 V5 : documentation (DOC1, L7a, L7b-1, L7b-2)", () => {
  it("liens internes et ancres de README.md, docs/RECAPITULATIF.md et e2e/README.md", () => {
    const broken: string[] = [];
    let seen = 0;
    for (const doc of DOCS) {
      const file = path.join(REPO_DIR, doc);
      const own = anchorsOf(file);
      for (const { n, line } of outsideCode(fs.readFileSync(file, "utf8"))) {
        const blanked = line.replace(/`[^`]*`/g, (s) => " ".repeat(s.length));
        for (const m of blanked.matchAll(/\[[^\]]*\]\(([^)\s]+)\)/g)) {
          const target = line.slice(m.index).match(/\]\(([^)\s]+)\)/)?.[1] ?? m[1] ?? "";
          if (/^(?:https?:|mailto:)/.test(target)) continue;
          seen += 1;
          const [rel = "", anchor = ""] = target.startsWith("#") ? ["", target.slice(1)] : target.split("#");
          const where = `${doc}:${n} ${target}`;
          if (rel === "") {
            if (!own.has(decodeURIComponent(anchor))) broken.push(`${where} : ancre absente`);
            continue;
          }
          const resolved = path.resolve(path.dirname(file), decodeURIComponent(rel));
          if (!resolved.startsWith(REPO_DIR)) broken.push(`${where} : hors du dépôt`);
          else if (!fs.existsSync(resolved)) broken.push(`${where} : fichier absent`);
          else if (anchor !== "" && resolved.endsWith(".md") && !anchorsOf(resolved).has(decodeURIComponent(anchor))) broken.push(`${where} : ancre absente`);
        }
      }
    }
    assert.ok(seen > 50, `liens relevés : ${seen}`);
    assert.deepEqual(broken, []);
  });

  it("chaque scénario du banc est cité dans e2e/README.md ; chaque scénario cité dans la documentation existe", () => {
    const scenarios = fs.readdirSync(SCENARIOS_DIR).filter((name) => name.endsWith(".mjs"));
    assert.ok(scenarios.includes("it1-ui-p2-raccourci.mjs") && scenarios.includes("it1-api-arret.mjs"), scenarios.join(", "));
    const e2eReadme = fs.readFileSync(path.join(REPO_DIR, "e2e", "README.md"), "utf8");
    assert.deepEqual(
      scenarios.filter((name) => !e2eReadme.includes(`\`${name}\``)),
      [],
      "scénarios absents de e2e/README.md",
    );
    const cited = new Set<string>();
    for (const doc of DOCS) {
      const text = fs.readFileSync(path.join(REPO_DIR, doc), "utf8");
      // --- équipes (it4) : début ---
      // Les familles d'une itération ne sont plus seulement `itN-api-…` et `itN-ui-…` : les scénarios d'équipes s'appellent
      // `it4-<nom>.mjs` (it4-avis, it4-carte, it4-commun…). Le motif prend donc tout nom `itN-…` (train de la vague 4). Le motif
      // d'origine était /(?<![\w-])(it\d-(?:api|ui)-[a-z0-9]+(?:-[a-z0-9]+)*|\d{3}-…\.mjs)(?![\w-])/g.
      for (const m of text.matchAll(/(?<![\w-])(it\d-[a-z0-9]+(?:-[a-z0-9]+)*|\d{3}-[a-z0-9]+(?:-[a-z0-9]+)*\.mjs)(?![\w-])/g)) {
        // --- équipes (it4) : fin ---
        cited.add(m[1]?.endsWith(".mjs") ? m[1] : `${m[1]}.mjs`);
      }
      // <c5:scenarios-cites>
      // Itération 5 (L50a) : la famille `c5a-*` (et `c5b-*` en 5b) du banc de la construction, citée dans e2e/README.md
      // comme les autres familles. Sans cette ligne, le compte des scénarios cités ne les verrait pas, et ce test
      // tomberait pour la seule raison qu'une famille nouvelle a été ajoutée au banc.
      for (const m of text.matchAll(/(?<![\w-])(c5[ab]-[a-z0-9]+(?:-[a-z0-9]+)*\.mjs)(?![\w-])/g)) cited.add(m[1] as string);
      // </c5:scenarios-cites>
    }
    assert.ok(cited.size >= scenarios.length - 1, `scénarios cités : ${[...cited].join(", ")}`);
    assert.deepEqual([...cited].filter((name) => !scenarios.includes(name)), [], "scénarios cités mais absents de e2e/scenarios");
  });

  it("témoin P6 et P4 : chaque scénario it1 qui agit sur opencode tourne sous avecTemoinP6, comme e2e/README.md l'annonce", () => {
    const read = (name: string) => fs.readFileSync(path.join(SCENARIOS_DIR, name), "utf8");
    // Agit sur opencode : conversation créée, message envoyé (proxy /api/oc/…), plan créé.
    const agit = /\bcreerConversation\(|\benvoyer\(|\/api\/oc\/|\/api\/plans\b/;
    const scenarios = fs.readdirSync(SCENARIOS_DIR).filter((name) => /^it1-.*\.mjs$/.test(name) && !name.endsWith("-commun.mjs"));
    const touchent = scenarios.filter((name) => agit.test(read(name)));
    for (const name of ["it1-ui-m25.mjs", "it1-ui-demonstration.mjs", "it1-ui-m1-noreply.mjs", "it1-ui-selecteur-clavier.mjs", "it1-api-arret.mjs"]) {
      assert.ok(touchent.includes(name), `${name} agit sur opencode`);
    }
    assert.deepEqual(touchent.filter((name) => !/\bawait avecTemoinP6\(ctx, /.test(read(name))), [], "scénarios qui agissent sur opencode hors du témoin P6");
    const readme = fs.readFileSync(path.join(REPO_DIR, "e2e", "README.md"), "utf8").replace(/\s+/g, " ");
    assert.match(readme, /Chaque autre scénario qui agit sur opencode \(.*?\) le fait sous le témoin P6/);
  });

  it("écart D-05 levé : aucun scénario ne suppose le HTTP ni n'appelle le cockpit hors du transport du banc ; e2e/README.md et le RECAPITULATIF le disent", () => {
    // fetch brut vers l'adresse du cockpit, adresse ou protocole de la page exigés en HTTP.
    const suppose = /fetch\(`\$\{ctx\.url\}|protocol === 'http:'|startsWith\("http:\/\/127\.0\.0\.1:"\)/;
    const endroits: string[] = [];
    for (const name of fs.readdirSync(SCENARIOS_DIR).filter((n) => n.endsWith(".mjs"))) {
      const lines = fs.readFileSync(path.join(SCENARIOS_DIR, name), "utf8").split(/\r?\n/);
      lines.forEach((line, i) => {
        if (suppose.test(line)) endroits.push(`${name}:${i + 1}`);
      });
    }
    assert.deepEqual(endroits, [], "endroits qui supposent encore le HTTP (le banc sert en HTTPS épinglé depuis R105b)");
    // Aucun scénario ne parle au cockpit hors du transport du banc : ni fetch nu, ni vérification TLS coupée, ni
    // connexion par mot de passe. Le seul fetch permis est celui du mode HTTP explicite, dans e2e/lib/cockpit.mjs.
    const horsBanc = /\bfetch\(|NODE_TLS_REJECT_UNAUTHORIZED|rejectUnauthorized:\s*false|ignore-certificate-errors(?!-spki-list)|\/api\/login/;
    const fautifs: string[] = [];
    for (const name of fs.readdirSync(SCENARIOS_DIR).filter((n) => n.endsWith(".mjs"))) {
      const lines = fs.readFileSync(path.join(SCENARIOS_DIR, name), "utf8").split(/\r?\n/);
      lines.forEach((line, i) => {
        if (horsBanc.test(line)) fautifs.push(`${name}:${i + 1}`);
      });
    }
    assert.deepEqual(fautifs, [], "accès au cockpit hors du transport épinglé du banc");
    assert.doesNotMatch(fs.readFileSync(path.join(REPO_DIR, "e2e", "lib", "cockpit.mjs"), "utf8"), /D-05/, "e2e/lib/cockpit.mjs : mention D-05 restante");
    const paragraphes = (file: string) =>
      fs
        .readFileSync(path.join(REPO_DIR, file), "utf8")
        .split(/\r?\n\s*\r?\n/)
        .filter((p) => p.includes("D-05"))
        .join("\n");
    for (const doc of [path.join("e2e", "README.md"), path.join("docs", "RECAPITULATIF.md")]) {
      const texte = paragraphes(doc);
      assert.match(texte, /levé/, `${doc} : l'écart D-05 n'est pas donné pour levé`);
      assert.doesNotMatch(texte, /les deux endroits à reprendre/, `${doc} : « les deux endroits » seulement`);
    }
  });

  it("RECAPITULATIF : ce que le §10 donne pour fait n'est plus dans les restes ; tests de croisement nommés jusqu'à la dernière vague", () => {
    const recap = fs.readFileSync(path.join(REPO_DIR, "docs", "RECAPITULATIF.md"), "utf8");
    const lines = recap.split(/\r?\n/);
    const restes = lines.filter((l) => /Restent pour clore cette itération|Reste à faire pour clore l'itération 1/.test(l));
    assert.equal(restes.length, 2, "état du chantier (en tête) et §9, étape 6");
    const faits = lines.map((l) => /^\| (e2e [^(|]+?) \(/.exec(l)?.[1]).filter((f): f is string => f !== undefined);
    assert.deepEqual(faits, ["e2e par l'API", "e2e de l'interface"], "résultats e2e du §10");
    for (const fait of faits) {
      for (const reste of restes) assert.ok(!reste.includes(fait), `« ${fait} » donné pour fait au §10 et encore à faire : ${reste.slice(0, 160)}`);
    }
    const vagues = fs
      .readdirSync(import.meta.dirname)
      .map((name) => /^croisements-it1-v(\d+)\.test\.ts$/.exec(name)?.[1])
      .filter((v): v is string => v !== undefined)
      .map(Number);
    assert.ok(recap.includes(`(\`croisements-it1-v0\` à \`v${Math.max(...vagues)}\`)`), `tests de croisement jusqu'à v${Math.max(...vagues)}`);
  });
});
