// Tests 1.1 (L44b) : méthodes attachées aux assistants (module « methods » et chemin d'enregistrement).
//
// Harnais à modules déclarés (`modules: ["methods"]`, plan §2.2) avec un AssistantService RÉEL et un StudioService réel sur un
// dossier temporaire : les fichiers d'agent sont de vrais fichiers, comparés à l'octet. Les routes d'assistants sont montées
// par `deps.routes`, comme dans main.ts, donc la garde de rechargement de `http.ts` s'applique (PUT /api/assistants/:name).
//
// Chaque garde a son contrôle discriminant : sans le contrôle des méthodes, les cas « 3 méthodes », « méthode inconnue » et
// « seconde-lecture » passeraient ; sans la garde de rechargement, le fichier changerait pendant une réponse en cours ; sans
// la lecture du FICHIER dans la vue, un bloc retiré à la main ne se verrait pas ; sans le retrait des blocs à l'écriture, un
// second enregistrement identique en poserait deux.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, it, type TestContext } from "node:test";
import { AssistantService } from "./assistants.ts";
import { CLASSIFIER_AGENT } from "./classifier.ts";
import { METHODS } from "./methods-catalogue.ts";
import { registerAssistantRoutes } from "./routes-assistants.ts";
import type { AssistantView } from "./shared/api-types.ts";
import { COMMON_RULES_BLOCK, COMMON_RULES_START } from "./shared/assistant-rules.ts";
import { TEXTES } from "./shared/construction-texts.ts";
import type { MethodsResponse, MethodView } from "./shared/construction-types.ts";
import { METHOD_LIMITS, methodMarkers, renderMethodBlock } from "./shared/methods.ts";
import { CONTROL_AGENT, StudioService } from "./studio.ts";
import { type CockpitHarness, startCockpit } from "./test-support/cockpit-harness.ts";
import type { TierService } from "./tiers.ts";

/** Brouillon valide, sans fiche : l'enregistrement n'a alors rien à installer et le corps ne tient que les consignes. */
const DRAFT = {
  title: "Relire un script avant mise en production",
  description: "Relit un script PowerShell ou Bash avant une mise en production et signale les risques, sans rien modifier.",
  useCase: "relire",
  rights: "lecture",
  web: false,
  tier: "equilibre",
  reflection: "standard",
  taskSize: "M",
  instructions: "Relis le script ligne par ligne et signale chaque risque avec sa gravité.",
  fiches: [] as string[],
  examples: [] as string[],
  icon: "eye",
};

const NOM = "essai-methodes";

/** Réponses JSON lues sans schéma. */
type Json = any;

interface MethodsHarness {
  h: CockpitHarness;
  /** Réponse en cours simulée : la garde de rechargement (§3.11) répond « busy » sans toucher au faux opencode. */
  occupee: (busy: boolean) => void;
  fichier: (name: string) => string;
  existe: (name: string) => boolean;
  ecrire: (name: string, contenu: string) => void;
  /** Fichier d'agent supprimé hors du cockpit : la ligne item_meta reste, l'assistant n'est plus installé. */
  supprimer: (name: string) => void;
  meta: (name: string) => Record<string, unknown> | undefined;
  put: (name: string, body: unknown) => Promise<{ status: number; body: Json }>;
  installer: (id: string) => Promise<{ status: number; body: Json }>;
  vue: (name: string) => Promise<AssistantView | undefined>;
  methodes: () => Promise<MethodsResponse>;
}

async function harness(t: TestContext, options: { mode?: "simple" | "avance" } = {}): Promise<MethodsHarness> {
  const etat = { occupee: false };
  const h = await startCockpit(t, {
    ...(options.mode ? { settings: { ui: { mode: options.mode } } } : {}),
    modules: ["methods"],
    // Décision en examen : `reloadBusy` du câblage, donc la garde de rechargement refuse (comme une réponse en cours).
    ports: { autonomy: { examining: () => etat.occupee } },
    deps: (base) => {
      const studio = new StudioService({
        env: base.env,
        client: base.client,
        projects: base.projects,
        control: base.control,
        log: base.log,
        catalog: base.catalog,
      });
      const assistants = new AssistantService({
        db: base.db,
        env: base.env,
        client: base.client,
        studio,
        lookup: base.lookup,
        tiers: base.tiers as TierService,
        ledger: base.ledger,
        settings: base.settings,
        catalog: base.catalog,
        projects: base.projects,
        hub: base.hub,
        log: base.log,
        queue: base.configQueue,
        reloadBusy: () => etat.occupee,
      });
      const routeDeps = { assistants, tiers: base.tiers as TierService, settings: base.settings, hub: base.hub, log: base.log };
      return { studio, assistants, routes: [(app) => registerAssistantRoutes(app, routeDeps)] };
    },
  });
  const fichierDe = (name: string) => path.join(h.deps.env.opencodeConfigDir, "agents", `${name}.md`);
  const appel = async (method: string, url: string, body?: unknown): Promise<{ status: number; body: Json }> => {
    const res = await h.call(method, url, { headers: h.headers.mutating, ...(body === undefined ? {} : { body }) });
    return { status: res.status, body: res.body ? JSON.parse(res.body) : null };
  };
  return {
    h,
    occupee: (busy: boolean) => {
      etat.occupee = busy;
    },
    fichier: (name) => fs.readFileSync(fichierDe(name), "utf8"),
    existe: (name) => fs.existsSync(fichierDe(name)),
    ecrire: (name, contenu) => fs.writeFileSync(fichierDe(name), contenu),
    supprimer: (name) => fs.rmSync(fichierDe(name)),
    meta: (name) =>
      h.db.prepare("SELECT * FROM item_meta WHERE kind = 'agents' AND name = ?").get(name) as unknown as Record<string, unknown> | undefined,
    put: (name, body) => appel("PUT", `/api/assistants/${name}`, body),
    installer: (id) => appel("POST", `/api/assistants/catalogue/${id}/install`, {}),
    vue: async (name) => {
      const res = await h.call("GET", "/api/assistants", { headers: h.headers.authed });
      assert.equal(res.status, 200, res.body);
      return res.json<{ assistants: AssistantView[] }>().assistants.find((a) => a.name === name);
    },
    methodes: async () => {
      const res = await h.call("GET", "/api/methods", { headers: h.headers.authed });
      assert.equal(res.status, 200, res.body);
      return res.json<MethodsResponse>();
    },
  };
}

/** Occurrences d'un texte, sans expression régulière (les marqueurs contiennent des caractères spéciaux). */
function compter(texte: string, cherche: string): number {
  let n = 0;
  for (let at = texte.indexOf(cherche); at !== -1; at = texte.indexOf(cherche, at + cherche.length)) n++;
  return n;
}

const methode = (id: string) => {
  const found = METHODS.find((m) => m.id === id);
  assert.ok(found, `méthode « ${id} » absente du catalogue`);
  return found;
};

/** Marqueur d'ouverture du bloc d'une méthode, à sa version du catalogue. */
const debutDe = (id: string) => methodMarkers(id, methode(id).version).debut;

const vueDe = (reponse: MethodsResponse, id: string): MethodView => {
  const found = reponse.methods.find((m) => m.id === id);
  assert.ok(found, `méthode « ${id} » absente de GET /api/methods`);
  return found;
};

describe("méthodes attachées à un assistant (enregistrement)", () => {
  it("deux méthodes : deux blocs avant les règles communes, une fois chacun ; second enregistrement identique à l'octet", async (t) => {
    const m = await harness(t);

    // Sans méthode : corps de référence, repris tel quel quand les méthodes sont retirées.
    const sans = await m.put(NOM, DRAFT);
    assert.equal(sans.status, 200, JSON.stringify(sans.body));
    const fichierSansMethode = m.fichier(NOM);
    assert.equal(compter(fichierSansMethode, "cockpit:methode"), 0);
    assert.deepEqual(sans.body.methods, []);
    assert.equal(m.meta(NOM)?.methods, "[]");

    const deux = await m.put(NOM, { ...DRAFT, previousName: NOM, methods: ["certitude", "pre-mortem"] });
    assert.equal(deux.status, 200, JSON.stringify(deux.body));
    const fichier = m.fichier(NOM);
    // Une fois chacun, dans l'ordre demandé, et tous les blocs fermés.
    for (const id of ["certitude", "pre-mortem"]) assert.equal(compter(fichier, debutDe(id)), 1, id);
    assert.equal(compter(fichier, "<!-- /cockpit:methode -->"), 2);
    assert.ok(fichier.indexOf(debutDe("certitude")) < fichier.indexOf(debutDe("pre-mortem")));
    // Les règles communes restent le DERNIER bloc du corps (D-5-07).
    assert.ok(fichier.indexOf(debutDe("pre-mortem")) < fichier.indexOf(COMMON_RULES_START));
    assert.ok(fichier.includes(COMMON_RULES_BLOCK));
    assert.ok(fichier.trimEnd().endsWith("<!-- /cockpit:regles-communes -->"));
    // Le texte exact de chaque méthode est bien celui du catalogue.
    for (const id of ["certitude", "pre-mortem"]) assert.ok(fichier.includes(methode(id).bloc), id);
    // Vue : méthodes rendues, consignes sans bloc ; miroir item_meta.
    assert.deepEqual(deux.body.methods, ["certitude", "pre-mortem"]);
    assert.equal(compter(deux.body.instructions as string, "cockpit:methode"), 0);
    assert.ok((deux.body.instructions as string).includes("Relis le script ligne par ligne"));
    assert.equal(m.meta(NOM)?.methods, JSON.stringify(["certitude", "pre-mortem"]));

    // Second enregistrement identique : le fichier ne bouge pas d'un octet (les blocs sont retirés avant d'être reposés).
    const encore = await m.put(NOM, { ...DRAFT, previousName: NOM, methods: ["certitude", "pre-mortem"] });
    assert.equal(encore.status, 200, JSON.stringify(encore.body));
    assert.equal(m.fichier(NOM), fichier);

    // Consignes relues telles que la vue les rend (sans bloc) : toujours le même fichier, jamais de bloc en double.
    const relues = await m.put(NOM, { ...DRAFT, previousName: NOM, instructions: deux.body.instructions, methods: ["certitude", "pre-mortem"] });
    assert.equal(relues.status, 200, JSON.stringify(relues.body));
    assert.equal(m.fichier(NOM), fichier);

    // Consignes qui portent DÉJÀ un bloc (copié du fichier, ou écrit à la main) : il est retiré avant d'être reposé.
    const colle = `${DRAFT.instructions}\n\n${renderMethodBlock(methode("certitude"))}`;
    const recolle = await m.put(NOM, { ...DRAFT, previousName: NOM, instructions: colle, methods: ["certitude", "pre-mortem"] });
    assert.equal(recolle.status, 200, JSON.stringify(recolle.body));
    assert.equal(m.fichier(NOM), fichier, "un bloc collé dans les consignes ne doit pas être écrit deux fois");
    assert.equal(compter(m.fichier(NOM), debutDe("certitude")), 1);

    // Méthodes changées : blocs remplacés, jamais ajoutés.
    const change = await m.put(NOM, { ...DRAFT, previousName: NOM, methods: ["cinq-pourquoi"] });
    assert.equal(change.status, 200, JSON.stringify(change.body));
    const apres = m.fichier(NOM);
    assert.equal(compter(apres, debutDe("certitude")), 0);
    assert.equal(compter(apres, debutDe("pre-mortem")), 0);
    assert.equal(compter(apres, debutDe("cinq-pourquoi")), 1);
    assert.equal(compter(apres, "<!-- /cockpit:methode -->"), 1);
    assert.deepEqual(change.body.methods, ["cinq-pourquoi"]);

    // Méthodes retirées : le corps redevient celui de l'enregistrement sans méthode, à l'octet.
    const vide = await m.put(NOM, { ...DRAFT, previousName: NOM, methods: [] });
    assert.equal(vide.status, 200, JSON.stringify(vide.body));
    assert.equal(m.fichier(NOM), fichierSansMethode);
    assert.deepEqual(vide.body.methods, []);
    assert.equal(m.meta(NOM)?.methods, "[]");
  });

  it("brouillon fautif : 422 avec le code du contrat, aucune écriture (trop, inconnue, non attachable, doublon)", async (t) => {
    const m = await harness(t);
    const refus = async (methods: unknown, code: string, message: string) => {
      const res = await m.put(NOM, { ...DRAFT, methods });
      assert.equal(res.status, 422, JSON.stringify(res.body));
      assert.equal(res.body.error, code, JSON.stringify(res.body));
      assert.equal(res.body.message, message);
      assert.equal(m.existe(NOM), false, "aucun fichier ne doit être écrit");
      assert.equal(m.meta(NOM), undefined, "aucune ligne item_meta ne doit être écrite");
    };
    const trop = TEXTES.partout.erreurs["methodes-trop"];
    const inconnue = TEXTES.partout.erreurs["methode-inconnue"];
    // Trois méthodes : une de plus que la limite affichée (2).
    assert.equal(METHOD_LIMITS.parAssistant, 2);
    await refus(["certitude", "pre-mortem", "cinq-pourquoi"], "methodes-trop", trop);
    // Deux fois la même : elle demande plus de blocs distincts que la limite.
    await refus(["certitude", "certitude"], "methodes-trop", trop);
    // Inconnue du catalogue, ou identifiant fabriqué.
    await refus(["methode-qui-n-existe-pas"], "methode-inconnue", inconnue);
    await refus([`${"x".repeat(80)}`], "methode-inconnue", inconnue);
    // « Seconde lecture » est un autre assistant (kind « relecture »), jamais un bloc de texte attaché.
    assert.equal(methode("seconde-lecture").kind, "relecture");
    await refus(["seconde-lecture"], "methode-inconnue", inconnue);
    // Un enregistrement valide passe ensuite : le refus venait bien des méthodes.
    const bon = await m.put(NOM, { ...DRAFT, methods: ["certitude"] });
    assert.equal(bon.status, 200, JSON.stringify(bon.body));
    assert.equal(compter(m.fichier(NOM), debutDe("certitude")), 1);

    // L'aperçu dit la même chose sans rien écrire (200 avec ses phrases).
    const apercu = await m.h.call("POST", "/api/assistants/preview", {
      headers: m.h.headers.mutating,
      body: { ...DRAFT, name: "apercu-methodes", methods: ["certitude", "pre-mortem", "cinq-pourquoi"] },
    });
    assert.equal(apercu.status, 200, apercu.body);
    const corps = apercu.json<{ issues: Array<{ path: string; message: string }>; body: string }>();
    assert.ok(corps.issues.some((i) => i.path === "methods" && i.message === trop));
    assert.equal(compter(corps.body, "cockpit:methode"), 0);
    assert.equal(m.existe("apercu-methodes"), false);
  });

  it("garde de rechargement : réponse en cours → 409, fichier inchangé à l'octet", async (t) => {
    const m = await harness(t);
    assert.equal((await m.put(NOM, { ...DRAFT, methods: ["certitude"] })).status, 200);
    const avant = m.fichier(NOM);

    m.occupee(true);
    const refuse = await m.put(NOM, { ...DRAFT, previousName: NOM, methods: ["pre-mortem"] });
    assert.equal(refuse.status, 409, JSON.stringify(refuse.body));
    assert.equal(refuse.body.error, "sessions-busy");
    // En mode Simple, aucune dérogation n'est proposée.
    assert.equal(refuse.body.override, false);
    assert.equal(m.fichier(NOM), avant);
    assert.equal(m.meta(NOM)?.methods, JSON.stringify(["certitude"]));

    // La même demande passe dès que la réponse est finie : le refus venait de la garde.
    m.occupee(false);
    const passe = await m.put(NOM, { ...DRAFT, previousName: NOM, methods: ["pre-mortem"] });
    assert.equal(passe.status, 200, JSON.stringify(passe.body));
    assert.equal(compter(m.fichier(NOM), debutDe("pre-mortem")), 1);
  });

  it("nom réservé ou interne : aucune méthode ne s'y attache, aucun fichier écrit", async (t) => {
    const m = await harness(t);
    for (const name of ["build", "plan", CLASSIFIER_AGENT, CONTROL_AGENT]) {
      const res = await m.put(name, { ...DRAFT, methods: ["certitude"] });
      assert.equal(res.status, 409, `${name} : ${JSON.stringify(res.body)}`);
      assert.equal(res.body.error, "name-taken");
      assert.equal(m.existe(name), false, name);
    }
  });

  it("fichier modifié à la main dans le Studio : la vue relit ses blocs", async (t) => {
    const m = await harness(t);
    assert.equal((await m.put(NOM, { ...DRAFT, methods: ["certitude", "pre-mortem"] })).status, 200);
    const fichier = m.fichier(NOM);

    // Bloc « certitude » retiré à la main, l'autre gardé tel quel.
    const debut = fichier.indexOf(debutDe("certitude"));
    const fin = fichier.indexOf("<!-- /cockpit:methode -->", debut) + "<!-- /cockpit:methode -->".length;
    m.ecrire(NOM, `${fichier.slice(0, debut)}${fichier.slice(fin + 1)}`);

    const vue = await m.vue(NOM);
    assert.deepEqual(vue?.methods, ["pre-mortem"], "la vérité est le fichier");
    assert.equal(compter(vue?.instructions ?? "", "cockpit:methode"), 0);
    // Le miroir item_meta n'a pas été réécrit : il ne fait pas foi.
    assert.equal(m.meta(NOM)?.methods, JSON.stringify(["certitude", "pre-mortem"]));

    // GET /api/methods lit les mêmes fichiers : « certitude » n'est plus utilisée par personne.
    const reponse = await m.methodes();
    assert.deepEqual(vueDe(reponse, "certitude").utiliseePar, []);
    assert.deepEqual(vueDe(reponse, "pre-mortem").utiliseePar, [{ name: NOM, title: DRAFT.title }]);
  });
});

describe("GET /api/methods", () => {
  it("forme, limites et sources vides en mode Simple ; sources rendues en Avancé", async (t) => {
    const m = await harness(t);
    const reponse = await m.methodes();
    assert.deepEqual(
      reponse.methods.map((v) => v.id),
      METHODS.map((entry) => entry.id),
    );
    assert.deepEqual(reponse.limites, { parAssistant: 2, parMessage: 2, parEtape: 2 });
    for (const vue of reponse.methods) {
      const entry = methode(vue.id);
      assert.deepEqual(vue.sources, [], `${vue.id} : aucune source en mode Simple`);
      assert.equal(vue.titre, entry.titre);
      assert.equal(vue.phrase, entry.phrase);
      assert.equal(vue.quand, entry.quand);
      assert.equal(vue.attention, entry.attention);
      assert.equal(vue.kind, entry.kind);
      assert.equal(vue.bloc, entry.bloc);
      assert.equal(vue.enTete, entry.enTete);
      assert.equal(vue.version, entry.version);
      assert.deepEqual(vue.utiliseePar, []);
      assert.deepEqual(vue.conseilleePour, [], "aucun assistant installé");
    }
    // Une méthode « relecture » n'a pas de bloc : c'est un autre assistant.
    assert.equal(vueDe(reponse, "seconde-lecture").bloc, "");

    // Mode Avancé : les sources du catalogue sont rendues, la route reste la même.
    m.h.settings.update({ ui: { mode: "avance" } });
    const avance = await m.methodes();
    for (const vue of avance.methods) assert.deepEqual(vue.sources, [...methode(vue.id).sources], vue.id);
    assert.ok(vueDe(avance, "certitude").sources.length > 0);
    m.h.assertNoGlobalRestart();
  });

  it("utiliseePar et conseilleePour : lus dans les fichiers et dans le catalogue des assistants installés", async (t) => {
    const m = await harness(t);
    // Assistant du catalogue conseillé pour « Clarifier d'abord » (suggereePour), installé SANS aucune méthode (C §16 n° 5).
    // « rediger-runbook » n'a aucune fiche : l'installation n'écrit qu'un fichier d'agent.
    assert.deepEqual(methode("clarifier-d-abord").suggereePour, ["rediger-runbook"]);
    const installe = await m.installer("rediger-runbook");
    assert.equal(installe.status, 200, JSON.stringify(installe.body));
    const equipier = installe.body.name as string;
    assert.deepEqual(installe.body.methods, []);
    assert.equal(m.meta(equipier)?.methods, "[]");
    assert.equal(compter(m.fichier(equipier), "cockpit:methode"), 0);

    const avant = await m.methodes();
    assert.deepEqual(vueDe(avant, "clarifier-d-abord").conseilleePour, [{ name: equipier, title: installe.body.title, attachee: false }]);
    assert.deepEqual(vueDe(avant, "clarifier-d-abord").utiliseePar, []);
    // Une méthode conseillée pour des assistants NON installés n'est conseillée à personne.
    assert.deepEqual(vueDe(avant, "diagnostic-differentiel").conseilleePour, []);

    // La méthode est attachée : elle devient « utilisée par » et « déjà attachée ».
    const attache = await m.put(equipier, {
      ...DRAFT,
      title: installe.body.title,
      description: installe.body.description,
      instructions: installe.body.instructions,
      fiches: installe.body.fiches,
      useCase: installe.body.useCase,
      icon: installe.body.icon,
      previousName: equipier,
      methods: ["clarifier-d-abord"],
    });
    assert.equal(attache.status, 200, JSON.stringify(attache.body));
    const apres = await m.methodes();
    assert.deepEqual(vueDe(apres, "clarifier-d-abord").utiliseePar, [{ name: equipier, title: installe.body.title }]);
    assert.deepEqual(vueDe(apres, "clarifier-d-abord").conseilleePour, [{ name: equipier, title: installe.body.title, attachee: true }]);

    // Un second assistant, hors catalogue : il entre dans « utilisée par », jamais dans « conseillée pour ».
    assert.equal((await m.put(NOM, { ...DRAFT, methods: ["clarifier-d-abord"] })).status, 200);
    const deux = await m.methodes();
    assert.deepEqual(
      vueDe(deux, "clarifier-d-abord").utiliseePar.map((a) => a.name),
      [NOM, equipier].sort((a, b) => a.localeCompare(b)),
    );
    assert.deepEqual(
      vueDe(deux, "clarifier-d-abord").conseilleePour.map((a) => a.name),
      [equipier],
    );

    // Ligne item_meta sans fichier d'agent (fichier supprimé hors du cockpit) : l'assistant n'est plus installé, donc
    // il ne sort ni dans « utilisée par », ni dans « conseillée pour ».
    m.supprimer(equipier);
    const orphelin = await m.methodes();
    assert.deepEqual(vueDe(orphelin, "clarifier-d-abord").conseilleePour, []);
    assert.deepEqual(
      vueDe(orphelin, "clarifier-d-abord").utiliseePar.map((a) => a.name),
      [NOM],
    );
  });

  it("route servie dans les deux modes, en lecture seule (aucune écriture d'opencode)", async (t) => {
    const m = await harness(t, { mode: "avance" });
    assert.equal((await m.h.call("GET", "/api/methods", { headers: m.h.headers.authed })).status, 200);
    m.h.settings.update({ ui: { mode: "simple" } });
    assert.equal((await m.h.call("GET", "/api/methods", { headers: m.h.headers.authed })).status, 200);
    // Aucune route d'écriture : la même adresse en PUT, POST ou DELETE n'existe pas.
    for (const method of ["PUT", "POST", "DELETE"]) {
      const res = await m.h.call(method, "/api/methods", { headers: m.h.headers.mutating });
      assert.equal(res.status, 404, `${method} : ${res.body}`);
    }
    m.h.assertNoGlobalRestart();
  });

  it("module non déclaré : la route n'existe pas (comportement de l'itération 1)", async (t) => {
    const h = await startCockpit(t);
    const res = await h.call("GET", "/api/methods", { headers: h.headers.authed });
    assert.equal(res.status, 404, res.body);
  });
});
