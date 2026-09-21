// Proxy de la Salle OMO (L18b, plan 2 bis, fiche L18b ; spécification §3.8 l.325, §3.9 l.331, §3.16 l.553, §5.9, P11 ;
// D-2b-04, D-2b-30 ; MX-OMO MO-1 et MO-6) : second montage /api/omo/oc/*, cloison entre les deux instances, liste blanche plus
// étroite, compteur de demandes facturées propre à la salle, et rien de la salle en mode Simple.
// Deux faux opencode : celui du harnais (instance principale) et celui de l'option « omo » (la salle). Le montage réel de
// createApp reste fermé tant que SALLE_OUVERTE est faux (plan 2 bis §2.7) : les requêtes qui traversent le proxy passent donc
// par un montage de test bâti sur createOcProxy, avec exactement les dépendances que createApp lui donne.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, it, type TestContext } from "node:test";
import { Hono } from "hono";
import { ConfigWriteQueue } from "./config-queue.ts";
import type { Cockpit11Module, HookSignatures, ProxyContext } from "./contracts-11.ts";
import { forbiddenCommandArguments, forbiddenProxyBody } from "./http.ts";
import { createInstanceRouter } from "./instance-router.ts";
import type { Logger } from "./log.ts";
import { createOcProxy, PROXY_RULES, PROXY_RULES_OMO, refusMontageSalle } from "./oc-proxy.ts";
import type { InstanceDeps } from "./omo-contracts.ts";
import type { OcSession } from "./opencode.ts";
import { CSRF_HEADER } from "./security.ts";
import { ID } from "./shared/ids.ts";
import { type CockpitHarness, startCockpit } from "./test-support/cockpit-harness.ts";

const DOSSIER = "/workspace/app";

// --- Listes blanches et porte du montage (fonctions pures) ------------------------------------------------------------------

/** Clé lisible d'une règle : « MÉTHODE motif ». */
const cles = (regles: readonly { method: string; pattern: RegExp }[]) => regles.map((r) => `${r.method} ${r.pattern.source}`);

describe("salle : liste blanche et porte du montage", () => {
  it("PROXY_RULES_OMO : aucune route en plus de l'instance principale, et exactement les retraits de D-2b-04", () => {
    const principale = cles(PROXY_RULES);
    const salle = cles(PROXY_RULES_OMO);
    assert.deepEqual(
      salle.filter((r) => !principale.includes(r)),
      [],
      "la salle n'ouvre aucune route que l'instance principale n'ouvre pas",
    );
    const retires = (
      [
        ["GET", "/provider/auth"],
        ["POST", "/provider/github-copilot/oauth/authorize"],
        ["POST", "/provider/github-copilot/oauth/callback"],
        ["DELETE", "/auth/github-copilot"],
        ["POST", "/session"],
        ["POST", `/permission/${ID}/reply`],
      ] as const
    ).map(([method, route]) => `${method} ${new RegExp(`^${route}$`).source}`);
    assert.deepEqual(
      principale.filter((r) => !salle.includes(r)),
      retires,
    );
  });

  it("PROXY_RULES_OMO : aucune route d'authentification, de fournisseur ni de configuration (MO-6)", () => {
    for (const regle of PROXY_RULES_OMO) {
      assert.doesNotMatch(regle.pattern.source, /auth|provider|config/, `${regle.method} ${regle.pattern.source}`);
    }
  });

  it("porte du montage : coupée tant que SALLE_OUVERTE, COCKPIT_OMO ou l'instance manquent ; réservée au mode Avancé", () => {
    const ouverte = { salleOuverte: true, omoActif: true, instancePresente: true, mode: "avance" } as const;
    assert.equal(refusMontageSalle(ouverte), null);
    assert.equal(refusMontageSalle({ ...ouverte, mode: "simple" }), "mode-avance");
    assert.equal(refusMontageSalle({ ...ouverte, salleOuverte: false }), "salle-coupee");
    assert.equal(refusMontageSalle({ ...ouverte, omoActif: false }), "salle-coupee");
    assert.equal(refusMontageSalle({ ...ouverte, instancePresente: false }), "salle-coupee");
    // Salle coupée ET mode Simple : la salle coupée l'emporte, comme pour les autres routes /api/omo/* (L18c).
    assert.equal(refusMontageSalle({ salleOuverte: false, omoActif: false, instancePresente: false, mode: "simple" }), "salle-coupee");
  });
});

// --- Montage de test : les deux instances côte à côte -------------------------------------------------------------------------

interface Montage {
  h: CockpitHarness;
  app: Hono;
  /** Demandes facturées admises par la salle (son compteur propre) : début et fin. */
  salleEnVol: { debut: number; fin: number };
  /** File de configuration de l'instance principale : `billedInFlight` est ce que lit la garde de rechargement. */
  queue: ConfigWriteQueue;
  /** Crochets « abort » appelés, par instance. */
  arrets: string[];
  /** Crochets « beforeBilledSend » appelés, avec ce que la file principale comptait à ce moment-là. */
  envois: Array<{ instance: string; enVolPrincipale: number; enVolSalle: number; messageID: unknown }>;
  journal: Array<[string, Record<string, unknown> | undefined]>;
  /** Enregistre une conversation suivie par le cockpit, sur l'instance donnée. */
  suivre(id: string, instance: "principale" | "omo"): void;
  /** Crée la conversation sur le faux de la salle, comme le fera POST /api/omo/rooms (L18c). */
  ouvrirSalle(id?: string): Promise<string>;
  /** Crée la conversation sur le faux principal, par le proxy de l'instance principale (comportement 1.0.x). */
  ouvrirPrincipale(): Promise<string>;
}

async function montage(t: TestContext): Promise<Montage> {
  const arrets: string[] = [];
  const envois: Montage["envois"] = [];
  const journal: Montage["journal"] = [];
  const salleEnVol = { debut: 0, fin: 0 };
  const queue = new ConfigWriteQueue();
  const etape =
    (nom: string, liste: string[]): HookSignatures["abort"] =>
    async (ctx: ProxyContext) => {
      liste.push(`${nom}:${ctx.instance ?? "principale"}:${ctx.sessionId ?? ""}`);
      return null;
    };
  const envoi =
    (nom: string): HookSignatures["beforeBilledSend"] =>
    async (ctx: ProxyContext) => {
      envois.push({ instance: nom, enVolPrincipale: queue.billedInFlight, enVolSalle: salleEnVol.debut - salleEnVol.fin, messageID: ctx.body.messageID });
      return null;
    };
  const modules: Cockpit11Module[] = [
    { name: "stopTree", install: (reg) => reg.hook("abort", etape("principale", arrets)) },
    { name: "omoStop", install: (reg) => reg.hook("abort", etape("salle", arrets), { instances: ["omo"] }) },
    { name: "activation", install: (reg) => reg.hook("beforeBilledSend", envoi("principale")) },
    { name: "omoCaps", install: (reg) => reg.hook("beforeBilledSend", envoi("salle"), { instances: ["omo"] }) },
  ];
  const h = await startCockpit(t, { omo: true, modules, settings: { ui: { mode: "avance" } } });
  assert.ok(h.omo, "harnais : option « omo » demandée");
  const log: Logger = {
    debug: (message, fields) => void journal.push([message, fields]),
    info: (message, fields) => void journal.push([message, fields]),
    warn: (message, fields) => void journal.push([message, fields]),
    error: (message, fields) => void journal.push([message, fields]),
  };

  const principale: InstanceDeps = {
    instance: "principale",
    client: h.deps.client,
    gate: h.cockpit.gate,
    lookup: h.deps.lookup,
    catalog: h.deps.catalog,
    processor: h.deps.processor,
    billRefusal: () => null,
    beginBilled: () => queue.beginBilled(),
    isAllowedDirectory: (directory) => h.deps.projects.isAllowedDirectory(directory),
  };
  const salle: InstanceDeps = {
    ...h.omo.deps,
    beginBilled: () => {
      salleEnVol.debut++;
      let rendu = false;
      return () => {
        if (rendu) return;
        rendu = true;
        salleEnVol.fin++;
      };
    },
  };
  const instances = createInstanceRouter({ principale, omo: salle, sessions: h.sessions });
  // Mêmes dépendances que createApp donne à ses deux montages : seules l'instance, le préfixe et la liste blanche changent.
  const commun = {
    env: h.deps.env,
    log,
    projects: h.deps.projects,
    hooks: h.cockpit.wiring,
    instanceOf: (id: string) => instances.instanceOf(id),
    forbiddenProxyBody,
    forbiddenCommandArguments,
    enforceTurn: async (_c: unknown, _sub: string, _directory: string | null, body: string) => body,
  };
  const app = new Hono();
  app.all("/api/oc/*", createOcProxy({ ...commun, instance: principale, prefix: "/api/oc", rules: PROXY_RULES }));
  app.all("/api/omo/oc/*", createOcProxy({ ...commun, instance: salle, prefix: "/api/omo/oc", rules: PROXY_RULES_OMO }));

  const fauxSalle = h.omo.fake;
  return {
    h,
    app,
    salleEnVol,
    queue,
    arrets,
    envois,
    journal,
    suivre: (id, instance) => void h.sessions.upsert({ id, title: "Conversation", directory: DOSSIER } as OcSession, undefined, { instance }),
    ouvrirSalle: async (id) => {
      const creee = await h.omo!.deps.client.request<OcSession>("POST", "/session", { query: { directory: fauxSalle.directory }, body: { title: "Salle" } });
      const rootId = id ?? creee.id;
      h.sessions.upsert({ ...creee, id: rootId, directory: fauxSalle.directory } as OcSession, undefined, { instance: "omo" });
      return rootId;
    },
    ouvrirPrincipale: async () => {
      const creee = await h.deps.client.request<OcSession>("POST", "/session", { query: { directory: h.fake.directory }, body: { title: "Conversation" } });
      h.sessions.upsert({ ...creee, directory: h.fake.directory } as OcSession, undefined, { instance: "principale" });
      return creee.id;
    },
  };
}

/** Requête sur le montage de test (aucun serveur : Hono répond directement). */
const appel = (m: Montage, method: string, chemin: string, body?: unknown) =>
  m.app.request(chemin, {
    method,
    ...(body === undefined ? {} : { body: JSON.stringify(body), headers: { "content-type": "application/json" } }),
  });

const corpsPrompt = (texte = "Bonjour") => ({
  parts: [{ type: "text", text: texte }],
  model: { providerID: "github-copilot", modelID: "gpt-5-mini" },
});

/** Requêtes vues par un faux opencode, sous la forme « MÉTHODE /chemin ». */
const routes = (fake: CockpitHarness["fake"]) => fake.requests.map((r) => `${r.method} ${r.pathname}`);

describe("salle : cloison entre les deux instances (P11)", () => {
  it("T-L18-a : une conversation de l'autre instance est introuvable, dans les deux sens, sans rien envoyer", async (t) => {
    const m = await montage(t);
    m.suivre("ses_principale", "principale");
    const racineSalle = await m.ouvrirSalle();
    const avantPrincipal = routes(m.h.fake).length;
    const avantSalle = routes(m.h.omo!.fake).length;

    const versSalle = await appel(m, "GET", `/api/oc/session/${racineSalle}`);
    assert.equal(versSalle.status, 404);
    assert.equal(((await versSalle.json()) as { error: string }).error, "not-found");
    const versPrincipale = await appel(m, "GET", "/api/omo/oc/session/ses_principale");
    assert.equal(versPrincipale.status, 404);
    assert.equal(((await versPrincipale.json()) as { error: string }).error, "not-found");

    assert.equal(routes(m.h.fake).length, avantPrincipal, "aucune requête au faux principal");
    assert.equal(routes(m.h.omo!.fake).length, avantSalle, "aucune requête au faux de la salle");
  });

  it("conversation inconnue du cockpit : 409 sur la salle, relayée comme en 1.0.x sur l'instance principale", async (t) => {
    const m = await montage(t);
    const inconnue = await appel(m, "GET", "/api/omo/oc/session/ses_jamais_vue");
    assert.equal(inconnue.status, 409);
    assert.equal(((await inconnue.json()) as { error: string }).error, "instance-inconnue");
    assert.deepEqual(routes(m.h.omo!.fake), [], "rien n'est envoyé à la salle");
    // Instance principale : comportement 1.0.x conservé (opencode répond lui-même « session introuvable »).
    const relayee = await appel(m, "GET", "/api/oc/session/ses_jamais_vue");
    assert.equal(relayee.status, 404);
    assert.ok(routes(m.h.fake).includes("GET /session/ses_jamais_vue"), "la demande est bien partie vers opencode");
  });

  it("le dossier d'une requête est vérifié sur l'instance visée, et la liste des assistants vient de SON opencode", async (t) => {
    const m = await montage(t);
    const racine = await m.ouvrirSalle();
    const avantPrincipal = routes(m.h.fake).length;
    const refus = await appel(m, "GET", `/api/omo/oc/session?directory=${encodeURIComponent("/etc")}`);
    assert.equal(refus.status, 403);
    assert.equal(((await refus.json()) as { error: string }).error, "forbidden-directory");
    // Raccourci avec une référence @ : les assistants sont lus sur l'opencode de la salle, jamais sur le principal.
    const commande = await appel(m, "POST", `/api/omo/oc/session/${racine}/command`, { command: "revue", arguments: "@a.txt" });
    assert.notEqual(commande.status, 404);
    assert.ok(routes(m.h.omo!.fake).includes("GET /agent"), "assistants lus sur l'opencode de la salle");
    assert.equal(routes(m.h.fake).length, avantPrincipal, "aucune requête au faux principal");
  });
});

describe("salle : routes et corps refusés (D-2b-04, MO-1)", () => {
  it("POST /api/omo/oc/session → 403 : une conversation de la salle naît par la salle, pas par le proxy", async (t) => {
    const m = await montage(t);
    const res = await appel(m, "POST", "/api/omo/oc/session", { title: "Ma salle" });
    assert.equal(res.status, 403);
    assert.equal(((await res.json()) as { error: string }).error, "ouverture-refusee");
    assert.deepEqual(routes(m.h.omo!.fake), [], "rien n'est créé sur la salle");
    // L'instance principale garde sa route (comportement 1.0.x).
    assert.equal((await appel(m, "POST", "/api/oc/session", { title: "Ma conversation" })).status, 200);
  });

  it("réponse d'autorisation venue du navigateur → 403 dans les deux modes ; « always » reste refusé sur l'instance principale", async (t) => {
    const m = await montage(t);
    for (const corps of [{ reply: "once" }, { reply: "always" }, { reply: "reject", message: "non" }]) {
      const res = await appel(m, "POST", "/api/omo/oc/permission/per_1/reply", corps);
      assert.equal(res.status, 403, JSON.stringify(corps));
      assert.equal(((await res.json()) as { error: string }).error, "reponse-autorisation-refusee");
    }
    assert.deepEqual(routes(m.h.omo!.fake), [], "aucune réponse d'autorisation ne part vers la salle");
    const toujours = await appel(m, "POST", "/api/oc/permission/per_1/reply", { reply: "always" });
    assert.equal(toujours.status, 403);
    assert.equal(((await toujours.json()) as { error: string }).error, "toujours-refuse");
  });

  it("les routes d'authentification et d'OAuth n'existent pas sur la salle", async (t) => {
    const m = await montage(t);
    for (const [method, chemin] of [
      ["GET", "/api/omo/oc/provider/auth"],
      ["POST", "/api/omo/oc/provider/github-copilot/oauth/authorize"],
      ["DELETE", "/api/omo/oc/auth/github-copilot"],
    ] as const) {
      const res = await appel(m, method, chemin, method === "GET" ? undefined : {});
      assert.equal(res.status, 404, chemin);
      assert.equal(((await res.json()) as { error: string }).error, "not-allowed");
    }
    assert.deepEqual(routes(m.h.omo!.fake), []);
  });

  it("MO-1 et MO-5 : messageID, tools et permission venus du navigateur → 400, rien n'est envoyé", async (t) => {
    const m = await montage(t);
    const racine = await m.ouvrirSalle();
    for (const champ of ["messageID", "tools", "permission"]) {
      const res = await appel(m, "POST", `/api/omo/oc/session/${racine}/prompt_async`, { ...corpsPrompt(), [champ]: champ === "messageID" ? "msg_forge" : {} });
      assert.equal(res.status, 400, champ);
      const corps = (await res.json()) as { error: string; message: string };
      assert.equal(corps.error, "champ-refuse");
      assert.ok(corps.message.includes(champ), corps.message);
    }
    assert.deepEqual(
      routes(m.h.omo!.fake).filter((r) => r.includes("prompt_async")),
      [],
      "aucun envoi",
    );
    assert.equal(m.salleEnVol.debut, m.salleEnVol.fin, "rien ne reste compté en vol après un refus");
    assert.equal(m.envois.length, 0, "aucun crochet d'envoi appelé");
  });

  it("MO-1 : le cockpit pose son propre messageID, imprévisible, et ne le journalise jamais", async (t) => {
    const m = await montage(t);
    const racine = await m.ouvrirSalle();
    for (const texte of ["Premier", "Second"]) {
      const res = await appel(m, "POST", `/api/omo/oc/session/${racine}/prompt_async`, corpsPrompt(texte));
      assert.equal(res.status, 204, texte);
    }
    const envoyes = m.h
      .omo!.fake.requests.filter((r) => r.pathname.endsWith("/prompt_async"))
      .map((r) => (r.body as { messageID?: unknown }).messageID);
    assert.equal(envoyes.length, 2);
    for (const id of envoyes) {
      assert.equal(typeof id, "string");
      assert.match(id as string, /^msg_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    }
    assert.notEqual(envoyes[0], envoyes[1], "identifiant imprévisible, jamais réutilisé (un doublon fusionnerait les messages)");
    // Les crochets le lisent dans le corps ; il ne part jamais au journal (ce n'est pas une preuve d'origine).
    assert.deepEqual(
      m.envois.map((e) => e.instance),
      ["salle", "salle"],
    );
    assert.equal(m.envois[0]?.messageID, envoyes[0]);
    const trace = JSON.stringify(m.journal);
    for (const id of envoyes) assert.doesNotMatch(trace, new RegExp(String(id)), "identifiant de message journalisé");
    // L'instance principale n'en pose aucun (comportement 1.0.x inchangé).
    m.suivre("ses_p", "principale");
    await appel(m, "POST", "/api/oc/session/ses_p/prompt_async", corpsPrompt());
    const principal = m.h.fake.requests.find((r) => r.pathname.endsWith("/prompt_async"));
    assert.equal(Object.hasOwn((principal?.body ?? {}) as object, "messageID"), false);
  });
});

describe("salle : arrêt et compteurs par instance", () => {
  it("D-2b-30 : l'arrêt d'une conversation de la salle n'appelle que le crochet de la salle, sans toucher l'opencode principal", async (t) => {
    const m = await montage(t);
    const racine = await m.ouvrirSalle();
    m.suivre("ses_p", "principale");
    const avantPrincipal = routes(m.h.fake).length;

    const arret = await appel(m, "POST", `/api/omo/oc/session/${racine}/abort`, {});
    assert.equal(arret.status, 200);
    assert.deepEqual(m.arrets, [`salle:omo:${racine}`], "seul le crochet inscrit pour la salle est appelé");
    assert.equal(routes(m.h.fake).length, avantPrincipal, "aucune requête au faux principal");
    assert.ok(routes(m.h.omo!.fake).includes(`POST /session/${racine}/abort`));

    // Une conversation principale arrêtée n'appelle que le crochet de l'instance principale.
    await appel(m, "POST", "/api/oc/session/ses_p/abort", {});
    assert.deepEqual(m.arrets, [`salle:omo:${racine}`, "principale:principale:ses_p"]);
  });

  it("un envoi de la salle en vol ne bloque ni le Studio ni le redémarrage de l'instance principale", async (t) => {
    const m = await montage(t);
    const racine = await m.ouvrirSalle();
    const racinePrincipale = await m.ouvrirPrincipale();

    const envoiSalle = await appel(m, "POST", `/api/omo/oc/session/${racine}/prompt_async`, corpsPrompt());
    assert.equal(envoiSalle.status, 204);
    // Au moment de l'envoi (crochet beforeBilledSend), la file de configuration — celle que lit la garde de rechargement du
    // Studio et du redémarrage — ne comptait AUCUNE demande en vol : le compteur de la salle est le sien.
    assert.deepEqual(m.envois, [{ instance: "salle", enVolPrincipale: 0, enVolSalle: 1, messageID: m.envois[0]?.messageID }]);
    assert.deepEqual(m.salleEnVol, { debut: 1, fin: 1 }, "la demande de la salle est bien comptée puis relâchée");
    assert.equal(m.queue.billedInFlight, 0);

    // Contre-épreuve : un envoi de l'instance principale, lui, est bien compté par la file de configuration.
    const envoiPrincipal = await appel(m, "POST", `/api/oc/session/${racinePrincipale}/prompt_async`, corpsPrompt());
    assert.equal(envoiPrincipal.status, 204);
    assert.deepEqual(
      m.envois.slice(1).map((e) => [e.instance, e.enVolPrincipale, e.enVolSalle]),
      [["principale", 1, 0]],
    );
    assert.equal(m.queue.billedInFlight, 0, "relâchée à la réponse d'opencode");
  });
});

// --- Montage réel dans createApp : porte, flux et bootstrap --------------------------------------------------------------------

describe("salle : montage /api/omo/oc/* du cockpit", () => {
  it("salle coupée (le dépôt) : 403 salle-coupee, sans rien envoyer à aucun des deux opencode", async (t) => {
    const h = await startCockpit(t, { omo: true, settings: { ui: { mode: "avance" } } });
    const avantPrincipal = h.fake.requests.length;
    const res = await h.call("GET", "/api/omo/oc/session", { headers: h.headers.authed });
    assert.equal(res.status, 403, res.body);
    assert.equal(res.json<{ error: string }>().error, "salle-coupee");
    assert.equal(h.fake.requests.length, avantPrincipal);
    assert.deepEqual(h.omo?.fake.requests.map((r) => r.pathname) ?? [], []);
  });

  it("T-L18-b : en mode Simple, aucun envoi vers la salle — et la route neuve exige l'en-tête anti-CSRF", async (t) => {
    const h = await startCockpit(t, { omo: true });
    const sansCsrf = await h.call("POST", "/api/omo/oc/session/ses_1/prompt_async", { headers: h.headers.authed, body: { parts: [] } });
    assert.equal(sansCsrf.status, 403, sansCsrf.body);
    assert.equal(sansCsrf.json<{ error: string }>().error, "csrf", "la garde anti-CSRF passe avant la salle");
    const avecCsrf = await h.call("POST", "/api/omo/oc/session/ses_1/prompt_async", {
      headers: { ...h.headers.authed, [CSRF_HEADER]: "1" },
      body: { parts: [] },
    });
    assert.equal(avecCsrf.status, 403, avecCsrf.body);
    assert.deepEqual(h.omo?.fake.requests.map((r) => r.pathname) ?? [], [], "rien n'est parti vers la salle");
  });

  it("§3.16 : en mode Simple, le flux /api/events ne porte aucun événement de la salle ; en Avancé, il les porte", async (t) => {
    const h = await startCockpit(t, { omo: true });
    const recu = async (): Promise<string[]> => {
      const recus: string[] = [];
      const res = await h.cockpit.app.fetch(new Request("http://127.0.0.1/api/events", { headers: { ...h.headers.authed, host: "127.0.0.1" } }));
      assert.equal(res.status, 200);
      const lecteur = (res.body as ReadableStream<Uint8Array>).getReader();
      const decodeur = new TextDecoder();
      // Première lecture : le « hello » prouve que le flux est abonné au hub avant la publication.
      await lecteur.read();
      h.hub.cockpit("omo.etat", { etatSalle: "prete" }, "omo");
      // Témoin sans instance (1.0.x) : il passe dans les deux modes et borne l'attente.
      h.hub.cockpit("archive.rescanned", {});
      const limite = Date.now() + 5_000;
      while (Date.now() < limite && !recus.includes("archive.rescanned")) {
        const { value, done } = await lecteur.read();
        if (done) break;
        for (const ligne of decodeur.decode(value).split("\n")) {
          if (!ligne.startsWith("data: ")) continue;
          const donnee = JSON.parse(ligne.slice(6)) as { type?: string };
          if (donnee.type) recus.push(donnee.type);
        }
      }
      await lecteur.cancel();
      return recus;
    };
    const simple = await recu();
    assert.ok(simple.includes("archive.rescanned"), simple.join(","));
    assert.equal(simple.includes("omo.etat"), false, "aucun événement de la salle en mode Simple");
    h.settings.update({ ui: { mode: "avance" } });
    const avance = await recu();
    assert.ok(avance.includes("omo.etat"), "en mode Avancé, l'événement de la salle passe");
  });

  it("/api/bootstrap : champ omo absent sans réglages de salle lus, et faux par défaut quand ils le sont", async (t) => {
    const sans = await startCockpit(t, { omo: true });
    const brut = (await sans.call("GET", "/api/bootstrap", { headers: sans.headers.authed })).json<Record<string, unknown>>();
    assert.equal(Object.hasOwn(brut, "omo"), false, "AppEnv construit à la main : l'interface lit exactement la 1.0.x");

    const avec = await startCockpit(t, {
      omo: true,
      env: { omo: { enabled: false, url: "http://opencode-omo:4096", password: "", image: "", controlDir: "/c", stateDir: "/s", authDir: "/a", projectsFile: null, egressJournal: "/e" } },
    });
    const bootstrap = (await avec.call("GET", "/api/bootstrap", { headers: avec.headers.authed })).json<{ omo: Record<string, boolean> }>();
    assert.deepEqual(bootstrap.omo, { enabled: false, imageChargee: false, salleOuverte: false }, "trois drapeaux faux par défaut");
    assert.doesNotMatch(JSON.stringify(bootstrap.omo), /password|opencode-omo/, "aucun secret ni adresse dans le bootstrap");
  });

  it("le montage de la salle reçoit les dépendances de la SALLE, jamais celles de l'instance principale", () => {
    const source = fs.readFileSync(path.join(import.meta.dirname, "http.ts"), "utf8");
    assert.match(source, /instance: instanceSalle,\n\s+prefix: "\/api\/omo\/oc",\n\s+rules: PROXY_RULES_OMO,/);
    assert.match(source, /enforceTurn: \(c, sub, directory, body, parsed\) => enforceTurn\(instanceSalle, c, sub, directory, body, parsed\)/);
    assert.match(source, /enforceTurn: \(c, sub, directory, body, parsed\) => enforceTurn\(instancePrincipale, c, sub, directory, body, parsed\)/);
  });
});
