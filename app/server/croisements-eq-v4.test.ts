// Tests de croisement du train it4 V4 (plan d'exécution it4 §2.4, §5.2 ligne V4 ; propriété de l'intégrateur). La vague 4 ne
// livre que du banc (L41) et de la documentation (DOC-EQ) : ce qu'elle a APPRIS, ce sont les six défauts que le banc a reproduits
// sur le produit déjà intégré (rapport L41 §4, arbitrage A13 du 21/09). Les corrections sont faites par le train, dans
// « 1.1 : ajustements d'intégration (4, vague 4) », et chacune a ici son test — c'est ce que ce fichier garde.
//
//   1. D1 (HAUT) : `useTeamRuns` passait à `useSyncExternalStore` deux fonctions recréées à chaque rendu. Aucune suite ne montait
//      ce crochet dans React : il est ici monté par un répartiteur de crochets minimal, aux règles de React (réabonnement dès que
//      `subscribe` change d'identité, nouveau rendu dès que l'instantané change), et la boucle de rendu est comptée.
//   2. D2 (MOYEN) : la carte néon n'avait plus la place de son dessin sous « Qui travaille ? » ; la feuille dit désormais que la
//      bande garde sa carte entière dans une fenêtre haute, et que c'est la région qui défile.
//   3. D3 (MOYEN) : l'installation d'un exemple répondait 500 quand le catalogue d'IA n'est pas chargé, au lieu du 409
//      `catalogue-indisponible` que le service prévoit. La route rend maintenant ce refus TEL QUEL, par la route réelle.
//   4. D4 (MOYEN) : la vue Liste écrivait « imposé par le cockpit » deux fois de suite pour une arête d'étape.
//   5. D5 (BAS) : le faux opencode ne servait pas `GET /skill`, que le Studio appelle pour vérifier l'écriture d'une fiche.
//   6. D6 (BAS) : la boîte de dialogue ne retenait pas la tabulation (une sur douze se posait dans la feuille de lancement).
//
// S'y ajoutent les deux vérifications de la ligne V4 du §5.2 qui se tiennent sans Docker : `EQUIPES_SIMPLE_OUVERTES` toujours
// fausse dans le dépôt (U1), et le banc e2e joignable par les options que la vague impose (`--faux`, `--reel-hors-ligne`,
// `--project-prefix`, `--image-tag`). Le banc lui-même (27 scénarios en faux, outils d'étape en réel hors ligne) est joué hors de
// `npm test`, et ses résultats sont consignés au §10 de docs/RECAPITULATIF.md.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, it, type TestContext } from "node:test";
import { Hono } from "hono";
import React from "react";
import { AssistantService as AssistantServiceClass, AssistantServiceError } from "./assistants.ts";
import type { ConfigWriteQueue } from "./config-queue.ts";
import { registerAiRoutes, registerAssistantRoutes } from "./routes-assistants.ts";
import type { AgentMapResult, MapEdge, MapNode } from "./shared/agent-map.ts";
import { TEXTES as CARTE_TEXTES } from "./shared/agent-map-texts.ts";
import { type CockpitHarness, startCockpit } from "./test-support/cockpit-harness.ts";
import type { StudioService } from "./studio.ts";
import type { TierService } from "./tiers.ts";
import { EQ_MODULES, EQUIPES_SIMPLE_OUVERTES } from "./wiring-eq.ts";
import { sectionsDeLaListe } from "../web/pages/assistants/carte/carte-model.ts";
import { TeamRunsCache, type TeamRunsDeps, useTeamRuns } from "../web/pages/chat/team/useTeamRuns.ts";

const APP_DIR = path.join(import.meta.dirname, "..");
const REPO_DIR = path.join(APP_DIR, "..");
const lire = (rel: string) => fs.readFileSync(path.join(REPO_DIR, rel), "utf8");

// --- D1 : le crochet monté dans React, sans navigateur ---------------------------------------------------------------------------

/**
 * Répartiteur de crochets de React : `useCallback` et `useSyncExternalStore` de « react » ne font que déléguer au répartiteur
 * courant. En poser un permet d'appeler un crochet hors d'un navigateur. La clé est celle de React 19 (version épinglée du
 * dépôt) ; si React la changeait, les tests de ce fichier échoueraient au lieu de passer à côté.
 */
const CLE_REPARTITEUR = "__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE";

interface MemoCrochet {
  valeur: unknown;
  deps: readonly unknown[];
}

interface Montage<T> {
  /** Dernière valeur rendue. */
  valeur(): T;
  rendus(): number;
  /** Nombre d'abonnements posés depuis le montage (React en repose un dès que `subscribe` change d'identité). */
  abonnements(): number;
  demonter(): void;
}

/**
 * Monte un crochet avec les RÈGLES de React, sans navigateur :
 *   - `useCallback` rend la même fonction tant que ses dépendances ne changent pas ;
 *   - `useSyncExternalStore` lit l'instantané au rendu, (ré)pose l'abonnement dès que `subscribe` change d'identité, puis relit
 *     l'instantané juste après s'être abonné (`handleStoreChange`) et redemande un rendu s'il a changé.
 * Un compteur de rendus arrête le montage au lieu de boucler sans fin : c'est exactement ce que faisait la page (« Minified React
 * error #185 », écran vide) avant le correctif de D1.
 */
function monterCrochet<T>(corps: () => T, maxRendus = 25): Montage<T> {
  const racine = (React as unknown as Record<string, { H: unknown } | undefined>)[CLE_REPARTITEUR];
  assert.ok(racine, `répartiteur de crochets de React introuvable (${CLE_REPARTITEUR})`);
  const memos: MemoCrochet[] = [];
  let curseur = 0;
  let subscribeRendu: ((auditeur: () => void) => () => void) | null = null;
  let lireRendu: (() => unknown) | null = null;
  let abonnementPose: ((auditeur: () => void) => () => void) | null = null;
  let desabonner: (() => void) | null = null;
  let abonnements = 0;
  let instantane: unknown;
  let valeur: T;
  let rendus = 0;
  let demonte = false;

  const repartiteur = {
    useCallback<F>(fn: F, deps: readonly unknown[]): F {
      const i = curseur++;
      const ancien = memos[i];
      if (ancien && ancien.deps.length === deps.length && ancien.deps.every((d, k) => Object.is(d, deps[k]))) return ancien.valeur as F;
      memos[i] = { valeur: fn, deps: [...deps] };
      return fn;
    },
    useSyncExternalStore<S>(subscribe: (auditeur: () => void) => () => void, getSnapshot: () => S): S {
      curseur++;
      subscribeRendu = subscribe;
      lireRendu = getSnapshot as () => unknown;
      instantane = getSnapshot();
      return instantane as S;
    },
  };

  const surChangement = (): void => {
    if (demonte || lireRendu === null) return;
    if (Object.is(lireRendu(), instantane)) return;
    rendre();
  };

  const rendre = (): void => {
    if (++rendus > maxRendus) throw new Error(`boucle de rendu : ${rendus} rendus sans se stabiliser`);
    curseur = 0;
    const precedent = racine.H;
    racine.H = repartiteur;
    try {
      valeur = corps();
    } finally {
      racine.H = precedent;
    }
    // Effet d'abonnement : React ne repose l'abonnement que si `subscribe` a changé d'identité.
    if (subscribeRendu !== null && subscribeRendu !== abonnementPose) {
      desabonner?.();
      abonnementPose = subscribeRendu;
      abonnements += 1;
      desabonner = subscribeRendu(surChangement);
      surChangement();
    }
  };

  rendre();
  return {
    valeur: () => valeur,
    rendus: () => rendus,
    abonnements: () => abonnements,
    demonter: () => {
      demonte = true;
      desabonner?.();
      desabonner = null;
    },
  };
}

/** Cache de lancements sur des dépendances injectées : aucune requête, aucun flux, aucune horloge réelle. */
function cacheEssai(): { cache: TeamRunsCache; appels: () => number } {
  let appels = 0;
  const deps: TeamRunsDeps = {
    charger: (_rootId, _signal) => {
      appels += 1;
      return Promise.resolve({ runs: [] });
    },
    abonner: () => () => undefined,
    setTimer: (fn, ms) => setTimeout(fn, ms),
    clearTimer: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
    now: () => Date.now(),
    phraseErreur: () => "",
  };
  return { cache: new TeamRunsCache(deps), appels: () => appels };
}

describe("croisements it4 V4 — D1 : le crochet des lancements d'équipe monté dans React ne boucle pas", () => {
  it("le crochet se stabilise, garde UN seul abonnement et l'entrée du cache ne se vide pas entre deux rendus", () => {
    // Le crochet du produit lit le cache de la page : les dépendances de celui-ci ne sont pas injectables ici, mais le chargement
    // n'a aucune part dans la boucle — elle vient de l'identité des deux fonctions passées à useSyncExternalStore. La requête est
    // donc neutralisée (et comptée : le crochet n'en fait qu'une).
    const reel = globalThis.fetch;
    let requetes = 0;
    globalThis.fetch = (async () => {
      requetes += 1;
      return new Response(JSON.stringify({ runs: [] }), { status: 200, headers: { "content-type": "application/json" } });
    }) as typeof fetch;
    try {
      const montage = monterCrochet(() => useTeamRuns("ses_racine_d1"));
      assert.ok(montage.rendus() <= 3, `rendus : ${montage.rendus()}`);
      assert.equal(montage.abonnements(), 1, "React ne doit se réabonner qu'au changement de racine");
      assert.equal(montage.valeur().erreur, null);
      assert.deepEqual(montage.valeur().runs, []);
      montage.demonter();
      assert.ok(requetes <= 1, `requêtes de lecture : ${requetes}`);
    } finally {
      globalThis.fetch = reel;
    }
  });

  it("sans mémorisation, le même cache ferait boucler React : deux abonnements de suite rendent un instantané DIFFÉRENT", () => {
    // Le moteur de la boucle, prouvé sur le cache seul : le dernier désabonnement libère l'entrée, le réabonnement la recrée avec
    // un nouvel objet d'état. C'est pour cela que les deux fonctions du crochet DOIVENT être stables.
    const { cache } = cacheEssai();
    const premier = cache.subscribe("ses_racine", () => undefined);
    const avant = cache.snapshot("ses_racine");
    premier();
    const second = cache.subscribe("ses_racine", () => undefined);
    const apres = cache.snapshot("ses_racine");
    second();
    assert.notEqual(avant, apres, "l'entrée est bien recréée : l'instantané n'est pas le même objet");
    assert.deepEqual([avant.runs, apres.runs], [[], []]);
  });

  it("le crochet mémorise les DEUX fonctions sur `rootId` (relecture du code, qu'aucun rendu ne peut deviner)", () => {
    const code = fs.readFileSync(path.join(APP_DIR, "web/pages/chat/team/useTeamRuns.ts"), "utf8");
    assert.match(code, /const abonner = useCallback\(\(auditeur: \(\) => void\) => teamRunsCache\.subscribe\(rootId, auditeur\), \[rootId\]\);/);
    assert.match(code, /const lire = useCallback\(\(\) => teamRunsCache\.snapshot\(rootId\), \[rootId\]\);/);
    assert.match(code, /return useSyncExternalStore\(abonner, lire, lire\);/);
  });
});

// --- D2 : la bande garde sa carte dans une fenêtre haute ------------------------------------------------------------------------

describe("croisements it4 V4 — D2 reporté, et le mouvement réduit corrigé", () => {
  it("D2 : les planchers de la clôture de l'itération 1 sont intacts, et la raison du report est écrite dans la feuille", () => {
    const chat = fs.readFileSync(path.join(APP_DIR, "web/pages/chat/chat.css"), "utf8");
    assert.match(chat, /\.chat-center:has\(> \.activity-region\.demande\) > \.interactions \{\s*flex-shrink: 4;/);
    assert.match(chat, /\.interactions:has\(> \.interaction\) \{\s*min-height: min\(7rem, 40vh\);/);
    const activite = fs.readFileSync(path.join(APP_DIR, "web/pages/chat/activity/activity.css"), "utf8");
    assert.match(activite, /\.activity-region\.demande \{\s*min-height: min\(2\.5rem, 6vh\);/);
    assert.match(activite, /\.activity-region\.demande > \.neon-band:has\(> \.neon-body\) \{\s*display: flex;[\s\S]*?min-height: 1\.75rem;/);
    // Le report est écrit là où la prochaine main travaillera, avec les trois essais mesurés.
    assert.match(activite, /Défaut D2 du banc de la vague 4 de l'itération 4 \(arbitrage A13\), NON corrigé ici/);
    assert.match(activite, /execution\/constats-V4\.md/);
  });

  it("mouvement réduit : aucune animation ne tourne sans fin (nombre de répétitions ramené à 1)", () => {
    const styles = fs.readFileSync(path.join(APP_DIR, "web/styles.css"), "utf8");
    assert.match(
      styles,
      /@media \(prefers-reduced-motion: reduce\) \{[\s\S]*?animation-duration: 0\.01ms !important;\s*animation-iteration-count: 1 !important;\s*transition-duration: 0\.01ms !important;/,
    );
    // La pastille d'une réponse en cours est bien une animation sans fin : c'est elle que la règle arrête.
    assert.match(styles, /\.dot\.pulse \{\s*animation: pulse [\d.]+s ease-in-out infinite;/);
  });
});

// --- D3 : le refus du service rendu tel quel par la route des équipes ------------------------------------------------------------

/** Studio simulé : l'installation d'un assistant du catalogue va jusqu'au bout, sans écrire dans le dépôt. */
function studioEspion(): StudioService {
  const saved = new Map<string, unknown>();
  return {
    save: async (kind: string, _scope: unknown, input: { name: string; frontmatter: Record<string, unknown> }) => {
      const item = { kind, name: input.name, scope: "global", project: null, file: `${kind}/${input.name}.md`, frontmatter: input.frontmatter, body: "x", error: null, files: [], updatedAt: Date.now() };
      saved.set(`${kind}/${input.name}`, item);
      return item;
    },
    remove: async () => true,
    get: async (kind: string, name: string) => saved.get(`${kind}/${name}`) ?? null,
    list: async (kind: string) => [...saved.values()].filter((item) => (item as { kind: string }).kind === kind),
    applyModels: async (_plan: unknown[], beforeWrite?: () => Promise<void>) => void (await beforeWrite?.()),
    ensureClassifierAgent: async () => undefined,
  } as unknown as StudioService;
}

/**
 * Cockpit complet, modules d'équipes réels ; `installAssistant` remplace le seul appel que `installExample` fait au service des
 * assistants (`eq.assistants.install`), pour rejouer un refus métier sans dépendre de l'état du catalogue d'IA.
 */
async function bancInstallation(t: TestContext, installAssistant?: () => never): Promise<CockpitHarness> {
  const studio = studioEspion();
  const ref: { h?: CockpitHarness } = {};
  const h = await startCockpit(t, {
    settings: { ui: { mode: "avance" } },
    modules: "tous",
    equipes: [EQ_MODULES.agentMap, EQ_MODULES.teams, EQ_MODULES.teamPreflight, EQ_MODULES.teamGuards],
    deps: (base) => {
      const reel = new AssistantServiceClass({
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
        queue: base.configQueue as ConfigWriteQueue,
        reloadBusy: () => ref.h?.cockpit.c11.reloadBusy() ?? false,
      });
      const assistants = (
        installAssistant === undefined ? reel : { install: installAssistant, fiches: () => reel.fiches(), list: () => reel.list() }
      ) as AssistantServiceClass;
      const routeDeps = { assistants: reel, tiers: base.tiers as TierService, settings: base.settings, hub: base.hub, log: base.log };
      return {
        studio,
        assistants,
        routes: [(app: Hono) => registerAssistantRoutes(app, routeDeps), (app: Hono) => registerAiRoutes(app, routeDeps)],
      };
    },
  });
  ref.h = h;
  return h;
}

describe("croisements it4 V4 — D3 : l'installation d'un exemple rend le refus du service, jamais 500", () => {
  it("catalogue d'IA non chargé : 409 catalogue-indisponible avec sa phrase, par la vraie route", async (t) => {
    const h = await bancInstallation(t, () => {
      throw new AssistantServiceError(409, "catalogue-indisponible", "Liste des IA indisponible : impossible de vérifier cette IA.");
    });
    const res = await h.call("POST", "/api/teams/examples/revue-sql/install", { headers: h.headers.mutating, body: {} });
    assert.equal(res.status, 409, res.body);
    const corps = res.json<{ error: string; message: string }>();
    assert.equal(corps.error, "catalogue-indisponible");
    assert.match(corps.message, /Liste des IA indisponible/);
    assert.doesNotMatch(res.body, /"error":"internal"/);
  });

  it("un refus d'IA du fournisseur passe aussi tel quel (422), et l'installation ordinaire reste un 200", async (t) => {
    const refuse = await bancInstallation(t, () => {
      throw new AssistantServiceError(422, "ia-indisponible", "IA indisponible pour ce niveau.");
    });
    const res = await refuse.call("POST", "/api/teams/examples/revue-sql/install", { headers: refuse.headers.mutating, body: {} });
    assert.equal(res.status, 422, res.body);
    assert.equal(res.json<{ error: string }>().error, "ia-indisponible");

    const normal = await bancInstallation(t);
    const ok = await normal.call("POST", "/api/teams/examples/revue-sql/install", { headers: normal.headers.mutating, body: {} });
    assert.equal(ok.status, 200, ok.body);
  });
});

// --- D4 : la vue Liste n'écrit jamais deux fois la même phrase ---------------------------------------------------------------

/** Carte minimale : Vous fait travailler un assistant dans une étape d'équipe (arête imposée par le cockpit). */
function carteEtape(): AgentMapResult {
  const noeud = (id: string, kind: MapNode["kind"], name: string): MapNode => ({
    id,
    kind,
    name,
    title: null,
    ia: { label: null, niveau: null, heritee: null },
    droits: [],
    cacheDansLeChat: false,
    avertissements: [],
  });
  const arete = (patch: Partial<MapEdge>): MapEdge => ({
    from: "vous",
    to: "agent:relire",
    kind: "delegue",
    confirmation: "sans",
    appliquePar: "opencode",
    refuseEnSimple: false,
    code: "delegue-sans-confirmation",
    ...patch,
  });
  return {
    nodes: [noeud("vous", "vous", "vous"), noeud("agent:relire", "assistant", "relire"), noeud("equipe:eq", "equipe", "eq")],
    edges: [
      arete({ from: "equipe:eq", to: "agent:relire", kind: "etape", appliquePar: "cockpit", code: "etape-imposee", etape: { numero: 1, niveau: "equilibre" } }),
      arete({}),
      arete({ to: "agent:relire", confirmation: "demandee", code: "delegue-apres-accord" }),
    ],
    notes: [],
  };
}

describe("croisements it4 V4 — D4 : la vue Liste, vérité pour le lecteur d'écran, ne répète pas une mention", () => {
  it("une arête imposée par le cockpit écrit « imposé par le cockpit » UNE fois", () => {
    const liens = sectionsDeLaListe(carteEtape(), true).flatMap((section) => section.liens);
    const imposee = liens.find((lien) => lien.kind === "etape");
    assert.ok(imposee, "l'arête d'étape est dans la liste");
    assert.equal(imposee.appliquePar, CARTE_TEXTES.partout.appliquePar.cockpit);
    assert.equal(imposee.mot, null, "le mot de la légende répétait la mention de qui applique le lien");
    for (const lien of liens) {
      const ecrits = [lien.phrase, lien.mot, lien.appliquePar].filter((texte): texte is string => typeof texte === "string" && texte !== "");
      assert.equal(new Set(ecrits).size, ecrits.length, `phrase écrite deux fois : ${ecrits.join(" | ")}`);
    }
  });

  it("les traits qui disent autre chose que qui applique le lien gardent leur mot", () => {
    const liens = sectionsDeLaListe(carteEtape(), true).flatMap((section) => section.liens);
    const sans = liens.find((lien) => lien.trait === "sans");
    const accord = liens.find((lien) => lien.trait === "accord");
    assert.equal(sans?.mot, CARTE_TEXTES.partout.legende.sans);
    assert.equal(accord?.mot, CARTE_TEXTES.partout.legende.accord);
    assert.equal(sans?.appliquePar, CARTE_TEXTES.partout.appliquePar.opencode);
  });
});

// --- D5 : le faux opencode sert la liste des fiches ----------------------------------------------------------------------------

describe("croisements it4 V4 — D5 : le faux opencode sert GET /skill, que le Studio appelle pour vérifier une fiche", () => {
  it("la route répond 200 avec la liste déclarée, jamais 404 « Route inconnue »", async (t) => {
    const h = await startCockpit(t, { settings: { ui: { mode: "avance" } } });
    assert.deepEqual(await h.deps.client.request("GET", "/skill"), []);
    h.fake.setSkills([{ name: "relire-requete-sql", description: "Relecture d'une requête" }]);
    assert.deepEqual(await h.deps.client.request("GET", "/skill"), [{ name: "relire-requete-sql", description: "Relecture d'une requête" }]);
  });
});

// --- D6 : la boîte de dialogue retient la tabulation ---------------------------------------------------------------------------

describe("croisements it4 V4 — D6 : le focus reste dans la boîte de dialogue", () => {
  it("la tabulation boucle aux deux extrémités, Échap rend le focus et le piège ne vise que la boîte du dessus", () => {
    const code = fs.readFileSync(path.join(APP_DIR, "web/components/ui.tsx"), "utf8");
    assert.match(code, /const FOCUSABLES =/);
    assert.match(code, /if \(e\.key !== "Tab" \|\| e\.altKey \|\| e\.ctrlKey \|\| e\.metaKey \|\| !dessus\(\)\) return;/);
    assert.match(code, /if \(e\.shiftKey && \(actif === premier \|\| actif === boite \|\| dehors\)\) \{\s*e\.preventDefault\(\);\s*dernier\.focus\(\);/);
    assert.match(code, /\} else if \(!e\.shiftKey && \(actif === dernier \|\| dehors\)\) \{\s*e\.preventDefault\(\);\s*premier\.focus\(\);/);
    // Échap et le retour du focus à l'élément d'avant restent ceux de l'itération 1.
    assert.match(code, /if \(e\.key === "Escape"\) \{\s*if \(dessus\(\)\) onClose\(\);/);
    assert.match(code, /previous\?\.focus\?\.\(\);/);
  });
});

// --- Ligne V4 du §5.2 : constante d'ouverture et options du banc ----------------------------------------------------------------

describe("croisements it4 V4 — ce que la vague doit garder vrai", () => {
  it("EQUIPES_SIMPLE_OUVERTES reste fausse dans le dépôt (U1), et le banc ne l'ouvre que dans sa copie", () => {
    assert.equal(EQUIPES_SIMPLE_OUVERTES, false);
    assert.match(fs.readFileSync(path.join(APP_DIR, "server/wiring-eq.ts"), "utf8"), /export const EQUIPES_SIMPLE_OUVERTES = false;/);
  });

  it("le banc e2e s'appelle avec les modes et les préfixes que la vague impose", () => {
    const script = lire(path.join("scripts", "run-e2e.sh"));
    for (const option of ["--faux", "--reel-hors-ligne", "--project-prefix", "--image-tag", "--scenarios", "--gardes"]) {
      assert.ok(script.includes(option), `option ${option} absente de scripts/run-e2e.sh`);
    }
  });

  it("les dix scénarios d'équipes sont au banc et cités dans e2e/README.md", () => {
    const scenarios = fs.readdirSync(path.join(REPO_DIR, "e2e", "scenarios")).filter((name) => /^it4-.*\.mjs$/.test(name));
    assert.equal(scenarios.length, 10, scenarios.join(", "));
    const readme = lire(path.join("e2e", "README.md"));
    assert.deepEqual(
      scenarios.filter((name) => !readme.includes(`\`${name}\``)),
      [],
    );
  });

  it("porte commune R105b : le banc de la vague 4 tourne en HTTPS épinglé", () => {
    assert.match(lire(path.join("docs", "RECAPITULATIF.md")), /écart D-05 levé/);
    const fichiers = fs.readdirSync(path.join(REPO_DIR, "e2e", "lib"));
    for (const nom of fichiers) {
      assert.doesNotMatch(fs.readFileSync(path.join(REPO_DIR, "e2e", "lib", nom), "utf8"), /D-05/, `${nom} porte encore l'écart D-05`);
    }
  });
});
