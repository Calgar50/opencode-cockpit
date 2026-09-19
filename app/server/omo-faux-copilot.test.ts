// Faux fournisseur scripté de la salle (plan d'exécution §6, fiche L21a, D-2b-43 ; spécification §7.5 l.1149, §7.10 l.1215,
// l.1219-1221, l.1227) : e2e/omo-banc/lib/faux-copilot.mjs sert des réponses scriptées (texte, appels d'outils, 429, délai) à un
// opencode de test, et se pilote sur un second port (file, journal, remise à zéro, arrêt).
//
// Le serveur est lancé en PROCESSUS ENFANT, jamais importé : le fichier reste un script sans déclarations de types, et le test voit
// ce que verra le banc. Il écoute sur le port 0 ; comme un port choisi par le système peut être refusé par fetch
// (FETCH_BLOCKED_PORTS de server/fetch-ports.ts), toutes les requêtes du test passent par node:http. Aucune pause fixe : on attend
// la ligne d'annonce, un fait au journal, ou la fin du processus.
//
// Le mode TLS (chemins et en-têtes du fournisseur github-copilot) n'est pas joué ici : aucun certificat n'est versionné ni fabriqué
// en intégration continue ; il est tenu par le banc (L21).
import assert from "node:assert/strict";
import { spawn, type ChildProcessByStdio } from "node:child_process";
import { once } from "node:events";
import http from "node:http";
import path from "node:path";
import type { Readable } from "node:stream";
import { after, before, beforeEach, describe, it, type TestContext } from "node:test";
import { until, within } from "./test-support/helpers.ts";

/** Processus enfant du faux fournisseur : entrée fermée, sortie et erreurs lues par le test. */
type Enfant = ChildProcessByStdio<null, Readable, Readable>;

const FAUX = path.join(import.meta.dirname, "..", "..", "e2e", "omo-banc", "lib", "faux-copilot.mjs");

/** Marque envoyée dans l'autorisation, dans une chaîne de requête, dans un en-tête libre et dans un message : jamais au journal. */
const MARQUE = "marque-de-test-a-ne-jamais-relever-4f2a";
const SECRET_PILOTE = "jeton-de-test-du-pilotage-32-signes";

// --- Formes lues ------------------------------------------------------------------------------------------------------------------

interface AppelOutil {
  id: string;
  type: string;
  function: { name: string; arguments: string };
}

interface MorceauOutil {
  index: number;
  id?: string;
  function: { name?: string; arguments: string };
}

interface Choix {
  index: number;
  message?: { role: string; content: string; tool_calls?: AppelOutil[] };
  delta?: { role?: string; content?: string; tool_calls?: MorceauOutil[] };
  finish_reason: string | null;
}

interface BlocChat {
  choices: Choix[];
  usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
  copilot_usage?: { total_nano_aiu: number };
}

interface EntreeJournal {
  n: number;
  methode: string;
  chemin: string;
  route: string;
  autorisation: boolean;
  entetes: string[];
  copilot: Record<string, string | null>;
  ia: string | null;
  messages: number;
  outilsProposes: number;
  outilsServis: number;
  octets: number;
  flux: boolean;
  servie: number | null;
  abandon: boolean;
}

interface VueJournal {
  mode: string;
  recues: number;
  journal: EntreeJournal[];
  enFile: { ordre: number; parIa: Record<string, number> };
  modeles: string[];
}

interface Catalogue {
  object: string;
  data: Array<{ id: string; object: string; model_picker_enabled: boolean; supported_endpoints: string[]; capabilities: { supports: { tool_calls: boolean } } }>;
}

interface Annonce {
  pret?: boolean;
  arret?: string;
  mode?: string;
  api?: { hote: string; port: number };
  pilote?: { hote: string; port: number };
}

// --- Requêtes (node:http seulement) ---------------------------------------------------------------------------------------------

interface Reponse {
  statut: number;
  entetes: http.IncomingHttpHeaders;
  corps: string;
}

interface Envoi {
  methode?: string;
  chemin: string;
  corps?: string;
  entetes?: Record<string, string>;
}

function demander(port: number, envoi: Envoi): Promise<Reponse> {
  return new Promise((resolve, reject) => {
    const corps = envoi.corps;
    const entetes: Record<string, string> = { ...envoi.entetes };
    if (corps !== undefined) {
      entetes["content-type"] ??= "application/json";
      entetes["content-length"] = String(Buffer.byteLength(corps));
    }
    const req = http.request({ host: "127.0.0.1", port, path: envoi.chemin, method: envoi.methode ?? "GET", headers: entetes, agent: false }, (res) => {
      const morceaux: Buffer[] = [];
      res.on("data", (morceau: Buffer) => morceaux.push(morceau));
      res.on("end", () => resolve({ statut: res.statusCode ?? 0, entetes: res.headers, corps: Buffer.concat(morceaux).toString("utf8") }));
      res.on("error", reject);
    });
    req.on("error", reject);
    req.end(corps);
  });
}

/** Corps démesuré, écrit par morceaux : l'écriture s'arrête dès que le serveur a répondu (il refuse avant la fin). */
function demanderDemesure(port: number, chemin: string, octets: number, entetes: Record<string, string> = {}): Promise<Reponse> {
  return new Promise((resolve, reject) => {
    let repondu = false;
    const req = http.request({ host: "127.0.0.1", port, path: chemin, method: "POST", headers: { "content-type": "application/json", ...entetes }, agent: false }, (res) => {
      repondu = true;
      const morceaux: Buffer[] = [];
      res.on("data", (morceau: Buffer) => morceaux.push(morceau));
      res.on("end", () => {
        resolve({ statut: res.statusCode ?? 0, entetes: res.headers, corps: Buffer.concat(morceaux).toString("utf8") });
        req.destroy();
      });
    });
    req.on("error", (err) => {
      if (!repondu) reject(err);
    });
    const bloc = Buffer.alloc(262_144, 0x41);
    void (async () => {
      req.write('{"model":"faux-m1","messages":[{"role":"user","content":"');
      for (let ecrits = 0; ecrits < octets && !repondu; ecrits += bloc.length) {
        if (!req.write(bloc)) await once(req, "drain");
      }
      if (!repondu) req.end('"}]}');
    })().catch(() => undefined);
  });
}

/** Requête d'appel que le test abandonnera : rien n'est attendu, les erreurs de socket sont normales. */
function envoyerPuisAbandonner(port: number, corps: string): http.ClientRequest {
  const req = http.request(
    {
      host: "127.0.0.1",
      port,
      path: "/v1/chat/completions",
      method: "POST",
      headers: { "content-type": "application/json", "content-length": String(Buffer.byteLength(corps)) },
      agent: false,
    },
    (res) => res.resume(),
  );
  req.on("error", () => undefined);
  req.end(corps);
  return req;
}

const lire = <T>(rep: Reponse): T => JSON.parse(rep.corps) as T;

function premier<T>(liste: readonly T[], quoi: string): T {
  const valeur = liste[0];
  assert.ok(valeur !== undefined, `${quoi} : rien à lire`);
  return valeur;
}

function dernier<T>(liste: readonly T[], quoi: string): T {
  const valeur = liste[liste.length - 1];
  assert.ok(valeur !== undefined, `${quoi} : rien à lire`);
  return valeur;
}

/** Sonde toutes les 5 ms jusqu'à ce que la lecture rende une valeur : on attend un fait, jamais une durée. */
async function jusqua<T>(lire2: () => Promise<T | undefined>, quoi: string, limiteMs = 5000): Promise<T> {
  const fin = Date.now() + limiteMs;
  for (;;) {
    const valeur = await lire2();
    if (valeur !== undefined) return valeur;
    if (Date.now() > fin) throw new Error(`${quoi} : rien en ${limiteMs} ms`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

// --- Lancement du faux fournisseur ------------------------------------------------------------------------------------------------

interface Faux {
  enfant: Enfant;
  portApi: number;
  portPilote: number;
  lignes: Annonce[];
  sortie: Promise<number>;
}

interface Depart {
  enfant: Enfant;
  lignes: Annonce[];
  erreurs: () => string;
  parti: () => number | null;
  sortie: Promise<number>;
}

/** Tous les enfants lancés par ce fichier : le filet de sécurité de la fin les arrête, quoi qu'il arrive aux tests. */
const lances: Depart[] = [];

function partir(args: string[], env: NodeJS.ProcessEnv): Depart {
  const enfant = spawn(process.execPath, [FAUX, ...args], { env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"] });
  const lignes: Annonce[] = [];
  let reste = "";
  let erreurs = "";
  let parti: number | null = null;
  enfant.stdout.setEncoding("utf8");
  enfant.stdout.on("data", (bout: string) => {
    reste += bout;
    const morceaux = reste.split("\n");
    reste = morceaux.pop() ?? "";
    for (const ligne of morceaux) if (ligne.trim() !== "") lignes.push(JSON.parse(ligne) as Annonce);
  });
  enfant.stderr.setEncoding("utf8");
  enfant.stderr.on("data", (bout: string) => {
    erreurs += bout;
  });
  // « close » plutôt que « exit » : la dernière ligne annoncée avant la sortie est alors déjà lue.
  const sortie = new Promise<number>((resolve) => {
    enfant.once("close", (code) => {
      parti = code ?? -1;
      resolve(parti);
    });
  });
  const depart = { enfant, lignes, erreurs: () => erreurs, parti: () => parti, sortie };
  lances.push(depart);
  return depart;
}

async function lancer(t: TestContext | null, args: string[] = ["--http", "--port", "0", "--pilot-port", "0"], env: NodeJS.ProcessEnv = {}): Promise<Faux> {
  const depart = partir(args, env);
  t?.after(async () => {
    if (depart.parti() === null) depart.enfant.kill();
    await depart.sortie;
  });
  const annonce = await until(() => {
    const code = depart.parti();
    if (code !== null) throw new Error(`faux-copilot arrêté (code ${code}) : ${depart.erreurs().slice(0, 300)}`);
    return depart.lignes.find((ligne) => ligne.pret === true);
  }, 10_000);
  assert.ok(annonce.api !== undefined && annonce.pilote !== undefined, "annonce sans port");
  return { enfant: depart.enfant, portApi: annonce.api.port, portPilote: annonce.pilote.port, lignes: depart.lignes, sortie: depart.sortie };
}

/** Démarrage refusé : code de sortie et raison dite, sans qu'aucun port ne soit ouvert. Un enfant qui tient bon est arrêté ici même
 * (sinon un test en échec laisserait un serveur derrière lui et la série ne finirait jamais). */
async function refus(args: string[], env: NodeJS.ProcessEnv = {}): Promise<{ code: number; erreurs: string }> {
  const depart = partir(args, env);
  try {
    const code = await within(depart.sortie, "refus de démarrer", 10_000);
    return { code, erreurs: depart.erreurs() };
  } finally {
    if (depart.parti() === null) {
      depart.enfant.kill();
      await depart.sortie;
    }
  }
}

const piloter = (faux: Faux, chemin: string, corps?: unknown, entetes: Record<string, string> = {}): Promise<Reponse> =>
  demander(faux.portPilote, {
    methode: corps === undefined ? "GET" : "POST",
    chemin,
    corps: corps === undefined ? undefined : JSON.stringify(corps),
    entetes,
  });

const scripter = async (faux: Faux, reponses: unknown[], ia?: string): Promise<void> => {
  const rep = await piloter(faux, "/reponses", ia === undefined ? { reponses } : { ia, reponses });
  assert.equal(rep.statut, 200, rep.corps);
};

const appeler = (faux: Faux, corps: Record<string, unknown>, entetes: Record<string, string> = {}, chemin = "/v1/chat/completions"): Promise<Reponse> =>
  demander(faux.portApi, { methode: "POST", chemin, corps: JSON.stringify(corps), entetes });

const journalDe = async (faux: Faux, entetes: Record<string, string> = {}): Promise<VueJournal> => lire<VueJournal>(await piloter(faux, "/journal", undefined, entetes));

/** Blocs « data: » d'un flux SSE, dans l'ordre. */
const blocsFlux = (corps: string): string[] =>
  corps
    .split("\n\n")
    .filter((bloc) => bloc.startsWith("data: "))
    .map((bloc) => bloc.slice("data: ".length));

// --- Tests --------------------------------------------------------------------------------------------------------------------------

describe("faux fournisseur scripté de la salle (L21a)", () => {
  let faux: Faux;

  before(async () => {
    faux = await lancer(null);
  });

  beforeEach(async () => {
    const rep = await piloter(faux, "/reinitialiser", {});
    assert.equal(rep.statut, 200, rep.corps);
  });

  after(async () => {
    if (faux.enfant.exitCode === null) faux.enfant.kill();
    await faux.sortie;
  });

  it("annonce le port choisi par le système et sert le catalogue d'IA", async () => {
    assert.ok(faux.portApi > 0 && faux.portPilote > 0, "ports effectifs attendus");
    assert.notEqual(faux.portApi, faux.portPilote);
    const rep = await demander(faux.portApi, { chemin: "/v1/models" });
    assert.equal(rep.statut, 200);
    const catalogue = lire<Catalogue>(rep);
    assert.equal(catalogue.data.length, 2);
    const ia = premier(catalogue.data, "catalogue");
    assert.equal(ia.object, "model");
    assert.equal(ia.model_picker_enabled, true);
    assert.deepEqual(ia.supported_endpoints, ["/chat/completions"]);
    assert.equal(ia.capabilities.supports.tool_calls, true);
    const inconnue = await demander(faux.portApi, { chemin: "/responses", methode: "POST", corps: "{}" });
    assert.equal(inconnue.statut, 404);
  });

  it("sert une réponse de texte, hors flux puis en flux", async () => {
    await scripter(faux, [{ texte: "Bonjour du banc." }, { texte: "Salut du banc.", nanoAiu: 4200 }]);
    const rep = await appeler(faux, { model: "faux-m1", messages: [{ role: "user", content: "coucou" }] });
    assert.equal(rep.statut, 200);
    const bloc = lire<BlocChat>(rep);
    const choix = premier(bloc.choices, "choices");
    assert.equal(choix.message?.content, "Bonjour du banc.");
    assert.equal(choix.finish_reason, "stop");
    assert.equal(bloc.usage?.total_tokens, 26);

    const flux = await appeler(faux, { model: "faux-m1", stream: true, messages: [{ role: "user", content: "coucou" }] });
    assert.equal(flux.statut, 200);
    assert.match(String(flux.entetes["content-type"]), /text\/event-stream/);
    const blocs = blocsFlux(flux.corps);
    assert.equal(dernier(blocs, "flux"), "[DONE]");
    const premierBloc = JSON.parse(premier(blocs, "flux")) as BlocChat;
    assert.equal(premier(premierBloc.choices, "choices").delta?.content, "Salut du banc.");
    const avantDone = JSON.parse(blocs[blocs.length - 2] ?? "{}") as BlocChat;
    assert.equal(premier(avantDone.choices, "choices").finish_reason, "stop");
    assert.equal(avantDone.copilot_usage?.total_nano_aiu, 4200);
  });

  it("sert des appels d'outils au format OpenAI, hors flux", async () => {
    await scripter(faux, [
      {
        outils: [
          { nom: "read", arguments: { filePath: "README.md" } },
          { nom: "bash", arguments: '{"command":"ls"}' },
        ],
      },
    ]);
    const bloc = lire<BlocChat>(await appeler(faux, { model: "faux-m1", messages: [{ role: "user", content: "lis" }] }));
    const choix = premier(bloc.choices, "choices");
    assert.equal(choix.finish_reason, "tool_calls");
    const appels = choix.message?.tool_calls ?? [];
    assert.equal(appels.length, 2);
    const [lecture, commande] = [premier(appels, "appels"), dernier(appels, "appels")];
    assert.equal(lecture.type, "function");
    assert.equal(lecture.function.name, "read");
    assert.equal(lecture.function.arguments, '{"filePath":"README.md"}');
    assert.equal(commande.function.name, "bash");
    // Arguments donnés en chaîne : servis tels quels, jamais ré-encodés.
    assert.equal(commande.function.arguments, '{"command":"ls"}');
    assert.notEqual(lecture.id, commande.id);
    assert.match(lecture.id, /^call_faux_/);
  });

  it("sert un appel d'outil en flux : le nom d'abord, les arguments ensuite", async () => {
    await scripter(faux, [{ outils: [{ nom: "call_omo_agent", arguments: { agent: "omo-audit" } }] }]);
    const flux = await appeler(faux, { model: "faux-m1", stream: true, messages: [{ role: "user", content: "délègue" }] });
    const blocs = blocsFlux(flux.corps).filter((bloc) => bloc !== "[DONE]");
    const morceaux = blocs.flatMap((bloc) => premier((JSON.parse(bloc) as BlocChat).choices, "choices").delta?.tool_calls ?? []);
    const debut = premier(morceaux, "morceaux d'outil");
    assert.equal(debut.function.name, "call_omo_agent");
    assert.equal(debut.function.arguments, "", "le premier morceau annonce le nom, pas les arguments");
    assert.match(String(debut.id), /^call_faux_/);
    assert.equal(morceaux.map((morceau) => morceau.function.arguments).join(""), '{"agent":"omo-audit"}');
    assert.equal(dernier(blocsFlux(flux.corps), "flux"), "[DONE]");
    const avantDone = JSON.parse(dernier(blocs, "blocs")) as BlocChat;
    assert.equal(premier(avantDone.choices, "choices").finish_reason, "tool_calls");
  });

  it("sert trois 429 avec retry-after, puis la réponse suivante", async () => {
    await scripter(faux, [{ statut: 429, retryAfter: 2 }, { statut: 429, retryAfter: 2 }, { statut: 429, retryAfter: 7 }, { texte: "Enfin." }]);
    for (const attendu of [2, 2, 7]) {
      const rep = await appeler(faux, { model: "faux-m1", messages: [] });
      assert.equal(rep.statut, 429);
      assert.equal(rep.entetes["retry-after"], String(attendu));
    }
    const rep = await appeler(faux, { model: "faux-m1", messages: [] });
    assert.equal(rep.statut, 200);
    assert.equal(premier(lire<BlocChat>(rep).choices, "choices").message?.content, "Enfin.");
  });

  it("sert la file de l'IA demandée avant la file d'arrivée", async () => {
    await scripter(faux, [{ texte: "ordre d'arrivée" }]);
    await scripter(faux, [{ texte: "pour faux-m2" }], "faux-m2");
    const pourM2 = lire<BlocChat>(await appeler(faux, { model: "faux-m2", messages: [] }));
    assert.equal(premier(pourM2.choices, "choices").message?.content, "pour faux-m2");
    const pourM1 = lire<BlocChat>(await appeler(faux, { model: "faux-m1", messages: [] }));
    assert.equal(premier(pourM1.choices, "choices").message?.content, "ordre d'arrivée");
    const vue = await journalDe(faux);
    assert.deepEqual(
      vue.journal.map((entree) => entree.ia),
      ["faux-m2", "faux-m1"],
    );
  });

  it("attend le délai scripté avant de répondre", async () => {
    await scripter(faux, [{ texte: "en retard", delaiMs: 400 }]);
    const debut = Date.now();
    const rep = await appeler(faux, { model: "faux-m1", messages: [] });
    const ecoule = Date.now() - debut;
    assert.equal(rep.statut, 200);
    assert.ok(ecoule >= 300, `réponse servie en ${ecoule} ms, délai de 400 ms non tenu`);
  });

  it("ne sert rien à un client parti pendant le délai", async () => {
    await scripter(faux, [{ texte: "jamais servi", delaiMs: 4000 }]);
    const req = envoyerPuisAbandonner(faux.portApi, JSON.stringify({ model: "faux-m1", messages: [] }));
    await jusqua(async () => (await journalDe(faux)).journal.find((entree) => entree.route === "chat"), "appel au journal");
    req.destroy();
    const entree = await jusqua(async () => (await journalDe(faux)).journal.find((e) => e.abandon), "abandon vu au journal", 2000);
    assert.equal(entree.servie, null);
  });

  it("journalise la présence de l'autorisation, jamais une valeur secrète", async () => {
    const rep = await appeler(
      faux,
      { model: "faux-m1", tools: [{ type: "function", function: { name: "read" } }], messages: [{ role: "system", content: MARQUE }, { role: "user", content: `lis ${MARQUE}` }] },
      {
        authorization: `Bearer ${MARQUE}`,
        "x-api-key": MARQUE,
        "user-agent": "opencode/1.18.30",
        "x-initiator": "agent",
        "openai-intent": "conversation-edits",
        "x-github-api-version": "2026-06-01",
        "x-session-id": "ses_banc0001",
      },
      `/v1/chat/completions?cle=${MARQUE}`,
    );
    assert.equal(rep.statut, 200);
    const vue = await journalDe(faux);
    const entree = premier(vue.journal, "journal");
    assert.equal(entree.autorisation, true);
    assert.equal(entree.chemin, "/v1/chat/completions", "la chaîne de requête n'est pas gardée");
    assert.equal(entree.messages, 2);
    assert.equal(entree.outilsProposes, 1);
    assert.equal(entree.ia, "faux-m1");
    assert.equal(entree.copilot.initiateur, "agent");
    assert.equal(entree.copilot.intention, "conversation-edits");
    assert.equal(entree.copilot.agentUtilisateur, "opencode/1.18.30");
    // MO-9 (train de V0) : l'identifiant de session d'opencode, porté par x-session-id, rattache l'appel à sa session.
    assert.equal(entree.copilot.session, "ses_banc0001");
    assert.ok(entree.entetes.includes("authorization") && entree.entetes.includes("x-api-key"), "les noms d'en-têtes sont relevés");
    assert.ok(!JSON.stringify(vue).includes(MARQUE), "aucune valeur secrète au journal");
  });

  it("remet à zéro la file et le journal", async () => {
    await scripter(faux, [{ texte: "a" }, { texte: "b" }]);
    await appeler(faux, { model: "faux-m1", messages: [] });
    assert.equal((await journalDe(faux)).enFile.ordre, 1);
    assert.equal((await piloter(faux, "/reinitialiser", {})).statut, 200);
    const vue = await journalDe(faux);
    assert.deepEqual(vue.journal, []);
    assert.equal(vue.recues, 0);
    assert.equal(vue.enFile.ordre, 0);
    const bloc = lire<BlocChat>(await appeler(faux, { model: "faux-m1", messages: [] }));
    assert.match(String(premier(bloc.choices, "choices").message?.content), /faux fournisseur/);
  });

  it("refuse une réponse scriptée mal formée, sans rien mettre en file", async () => {
    const refuse = async (corps: unknown, raison: RegExp): Promise<void> => {
      const rep = await piloter(faux, "/reponses", corps);
      assert.equal(rep.statut, 400, JSON.stringify(corps));
      assert.match(String(lire<{ erreur: string }>(rep).erreur), raison);
    };
    await refuse({ reponses: [{ texteQuiNexistePas: "x" }] }, /clé inconnue/);
    await refuse({ reponses: [{ statut: 200 }] }, /statut/);
    await refuse({ reponses: [{ statut: 429, texte: "x" }] }, /sans objet avec statut/);
    await refuse({ reponses: [{ texte: "x", delaiMs: -1 }] }, /delaiMs/);
    await refuse({ reponses: [{ texte: "x", delaiMs: 600_000 }] }, /delaiMs/);
    await refuse({ reponses: [{ outils: [{ nom: "Lire Le Fichier" }] }] }, /nom d'outil/);
    await refuse({ ia: "pas une IA !", reponses: [{ texte: "x" }] }, /identifiant d'IA/);
    await refuse({ reponses: [] }, /liste de 1 à/);
    // Tout ou rien : la réponse valide du lot refusé n'est pas gardée.
    await refuse({ reponses: [{ texte: "bonne" }, { statut: 12 }] }, /reponses\[1\]/);
    assert.equal((await journalDe(faux)).enFile.ordre, 0);
  });

  it("refuse un catalogue d'IA vide, trop long ou à doublons", async () => {
    for (const modeles of [[], Array.from({ length: 51 }, (_, i) => `ia-${i}`), ["faux-m1", "faux-m1"], ["ia impossible"]]) {
      const rep = await piloter(faux, "/modeles", { modeles });
      assert.equal(rep.statut, 400, JSON.stringify(modeles).slice(0, 60));
    }
    assert.equal((await piloter(faux, "/modeles", { modeles: ["faux-seul"] })).statut, 200);
    const catalogue = lire<Catalogue>(await demander(faux.portApi, { chemin: "/v1/models" }));
    assert.deepEqual(
      catalogue.data.map((ia) => ia.id),
      ["faux-seul"],
    );
    assert.equal((await piloter(faux, "/modeles", { modeles: ["faux-m1", "faux-m2"] })).statut, 200);
  });

  it("refuse un corps démesuré, côté API comme côté pilotage", async () => {
    const api = await demanderDemesure(faux.portApi, "/v1/chat/completions", 16_777_216 + 262_144);
    assert.equal(api.statut, 413);
    const pilote = await demanderDemesure(faux.portPilote, "/reponses", 1_048_576 + 262_144);
    assert.equal(pilote.statut, 413);
    assert.equal((await journalDe(faux)).enFile.ordre, 0);
  });
});

describe("faux fournisseur de la salle : démarrage et arrêt (L21a)", () => {
  it("exige un secret pour le pilotage quand il est posé, et le vérifie", async (t) => {
    const faux = await lancer(t, ["--http", "--port", "0", "--pilot-port", "0"], { FAUX_COPILOT_JETON_PILOTE: SECRET_PILOTE });
    assert.equal((await piloter(faux, "/journal")).statut, 401);
    assert.equal((await piloter(faux, "/journal", undefined, { "x-pilote-jeton": "autre chose" })).statut, 401);
    const vue = await journalDe(faux, { "x-pilote-jeton": SECRET_PILOTE });
    assert.equal(vue.mode, "http");
    assert.deepEqual(vue.journal, []);
    // L'API, elle, reste ouverte : c'est le fournisseur que l'opencode de test appelle sans secret.
    assert.equal((await demander(faux.portApi, { chemin: "/v1/models" })).statut, 200);
  });

  it("refuse de démarrer sur des arguments impossibles, avec le code 2", async () => {
    const cas: Array<{ args: string[]; env?: NodeJS.ProcessEnv; raison: RegExp }> = [
      { args: ["--port", "0"], raison: /un seul mode/ },
      { args: ["--http", "--tls", "--cert", "c", "--key", "k"], raison: /un seul mode/ },
      { args: ["--tls", "--port", "0"], raison: /--tls exige/ },
      { args: ["--http", "--cert", "c"], raison: /vont avec --tls/ },
      { args: ["--http", "--port", "70000"], raison: /entier de 0 à 65535/ },
      { args: ["--http", "--port", "0", "--inconnu"], raison: /inconnu/ },
      { args: ["--http", "--port", "0", "--pilot-host", "0.0.0.0"], raison: /boucle locale/ },
      { args: ["--http", "--port", "0"], env: { FAUX_COPILOT_JETON_PILOTE: "trop-court" }, raison: /16 caractères/ },
    ];
    for (const { args, env, raison } of cas) {
      const { code, erreurs } = await refus(args, env);
      assert.equal(code, 2, `${args.join(" ")} : code ${code}`);
      assert.match(erreurs, raison);
    }
  });

  it("s'arrête proprement sur demande du pilotage, sans attendre une réponse retenue", async (t) => {
    const faux = await lancer(t);
    await scripter(faux, [{ texte: "retenue", delaiMs: 30_000 }]);
    const req = envoyerPuisAbandonner(faux.portApi, JSON.stringify({ model: "faux-m1", messages: [] }));
    await jusqua(async () => (await journalDe(faux)).journal.find((entree) => entree.route === "chat"), "appel retenu au journal");
    assert.equal((await piloter(faux, "/arreter", {})).statut, 200);
    const code = await within(faux.sortie, "arrêt par le pilotage", 5000);
    assert.equal(code, 0);
    assert.ok(
      faux.lignes.some((ligne) => ligne.arret === "pilotage"),
      "arrêt annoncé",
    );
    req.destroy();
  });

  it(
    "s'arrête proprement sur SIGTERM",
    { skip: process.platform === "win32" ? "Windows n'a pas SIGTERM (l'arrêt propre est tenu par le pilotage)" : false },
    async (t) => {
      const faux = await lancer(t);
      faux.enfant.kill("SIGTERM");
      const code = await within(faux.sortie, "arrêt sur SIGTERM", 5000);
      assert.equal(code, 0);
      assert.ok(
        faux.lignes.some((ligne) => ligne.arret === "SIGTERM"),
        "arrêt annoncé",
      );
    },
  );
});

after(async () => {
  for (const depart of lances) {
    if (depart.parti() === null) depart.enfant.kill();
    await depart.sortie;
  }
});
