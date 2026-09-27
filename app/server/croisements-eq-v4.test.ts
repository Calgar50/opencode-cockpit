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
// S'y ajoute, depuis la répétition générale du 21/09, la mesure du point « à surveiller » (constat C4) : à l'état « terminee »,
// l'équipe a rendu son occupation propre, et le 409 « sessions-busy » qui pouvait suivre ne vient que de la sonde d'opencode,
// qui revient au repos seule. Le produit n'est pas changé ; c'est `it4-studio.mjs` qui attend ce repos, et qui le mesure.
//
// S'y ajoutent les deux vérifications de la ligne V4 du §5.2 qui se tiennent sans Docker : `EQUIPES_SIMPLE_OUVERTES` toujours
// fausse dans le dépôt (U1), et le banc e2e joignable par les options que la vague impose (`--faux`, `--reel-hors-ligne`,
// `--project-prefix`, `--image-tag`). Le banc lui-même (27 scénarios en faux, outils d'étape en réel hors ligne) est joué hors de
// `npm test`, et ses résultats sont consignés au §10 de docs/RECAPITULATIF.md.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, it, type TestContext } from "node:test";
import { pathToFileURL } from "node:url";
import { Hono } from "hono";
import React from "react";
import { AssistantService as AssistantServiceClass, AssistantServiceError, probeSessionsBusy } from "./assistants.ts";
import type { ConfigWriteQueue } from "./config-queue.ts";
import type { EqModule } from "./contracts-eq.ts";
import { registerAiRoutes, registerAssistantRoutes } from "./routes-assistants.ts";
import type { AgentMapResult, MapEdge, MapNode } from "./shared/agent-map.ts";
import { TEXTES as CARTE_TEXTES } from "./shared/agent-map-texts.ts";
import type { Flow, TeamEstimateResponse, TeamInstallResponse, TeamRunStarted, TeamRunView } from "./shared/team-types.ts";
import { createTeamRunnerModule } from "./team-runner.ts";
import { type CockpitHarness, startCockpit } from "./test-support/cockpit-harness.ts";
import type { FakeAgent } from "./test-support/fake-opencode.ts";
import type { StudioService } from "./studio.ts";
import type { TierService } from "./tiers.ts";
import { EQ_MODULES, EQUIPES_SIMPLE_OUVERTES } from "./wiring-eq.ts";
import { sectionsDeLaListe } from "../web/pages/assistants/carte/carte-model.ts";
import { piegerLaTabulation } from "../web/components/modal-focus.ts";
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

describe("croisements it4 V4 — D2 corrigé en amont, dans la saisie, et le mouvement réduit corrigé", () => {
  it("D2 : la région d'activité ne bouge pas, et c'est le lanceur qui rend sa rangée à la ligne d'IA", () => {
    const chat = fs.readFileSync(path.join(APP_DIR, "web/pages/chat/chat.css"), "utf8");
    assert.match(chat, /\.chat-center:has\(> \.activity-region\.demande\) > \.interactions \{\s*flex-shrink: 4;/);
    assert.match(chat, /\.interactions:has\(> \.interaction\) \{\s*min-height: min\(7rem, 40vh\);/);
    const activite = fs.readFileSync(path.join(APP_DIR, "web/pages/chat/activity/activity.css"), "utf8");
    assert.match(activite, /\.activity-region\.demande \{\s*min-height: min\(2\.5rem, 6vh\);/);
    assert.match(activite, /\.activity-region\.demande > \.neon-band:has\(> \.neon-body\) \{\s*display: flex;[\s\S]*?min-height: 1\.75rem;/);
    // La correction est CHEZ LE LANCEUR, dans la feuille de la branche : la barre de la saisie est une rangée qui passe à la
    // ligne, et le lanceur y prenait 498 px à côté d'une ligne d'IA réduite à 34 px de large, donc à 246 px de haut. Le lanceur
    // prend maintenant sa propre rangée ; la ligne d'IA retrouve sa largeur, et la région d'activité sa hauteur (258 px).
    const lanceur = fs.readFileSync(path.join(APP_DIR, "web/pages/chat/team/team-launch.css"), "utf8");
    assert.match(lanceur, /\.composer-toolbar:has\(> \.team-launcher\) > \.composer-ia \{\s*flex: 1 0 100%;\s*\}/);
    assert.match(lanceur, /\.team-launcher-raison \{[\s\S]*?max-width: 14rem;/, "raison bornée pour tenir sur la rangée des boutons");
    // La raison n'est jamais tronquée : elle passe à la ligne, elle ne disparaît pas (§7.8).
    assert.ok(!/\.team-launcher-raison \{[^}]*text-overflow/.test(lanceur), "la raison du lanceur n'est pas tronquée");
    // Rien n'est écrit dans la feuille partagée de la saisie : la barre reste celle de l'itération 1.
    assert.match(chat, /\.composer-toolbar \{\s*display: flex;\s*align-items: flex-end;\s*flex-wrap: wrap;/);
    assert.ok(!/team-launcher|team-launch/.test(chat), "chat.css (fichier partagé, itération 1) reste sans règle d'équipe");
    // Les relevés d'avant et d'après sont écrits là où la prochaine main travaillera.
    assert.match(activite, /execution\/constats-V4\.md/);
    assert.match(activite, /La correction est donc chez le\s+lanceur/);
  });

  it("mouvement réduit : aucune animation ne tourne sans fin (nombre de répétitions ramené à 1), et la règle est chez la branche", () => {
    const styles = fs.readFileSync(path.join(APP_DIR, "web/styles.css"), "utf8");
    // La remise à zéro de l'itération 1 est INTACTE : `styles.css` est « jamais écrit par cette branche » (§2.7).
    assert.match(styles, /@media \(prefers-reduced-motion: reduce\) \{\s*\*,\s*\*::before,\s*\*::after \{\s*animation-duration: 0\.01ms !important;\s*transition-duration: 0\.01ms !important;\s*\}\s*\}/);
    assert.ok(!/animation-iteration-count/.test(styles), "la règle des équipes n'est pas écrite dans le fichier partagé");
    // La pastille d'une réponse en cours est bien une animation sans fin : c'est elle que la règle arrête.
    assert.match(styles, /\.dot\.pulse \{\s*animation: pulse [\d.]+s ease-in-out infinite;/);
    // La règle vit dans une feuille de la branche, chargée par une vue d'équipe du fil, donc toujours dans le paquet.
    const feuille = fs.readFileSync(path.join(APP_DIR, "web/pages/chat/team/mouvement-reduit.css"), "utf8");
    assert.match(feuille, /@media \(prefers-reduced-motion: reduce\) \{\s*\*,\s*\*::before,\s*\*::after \{\s*animation-iteration-count: 1 !important;\s*\}\s*\}/);
    assert.match(feuille, /execution\/constats-V4\.md/, "l'écart est consigné là où la prochaine main le relira");
    assert.match(fs.readFileSync(path.join(APP_DIR, "web/pages/chat/team/TeamRunCards.tsx"), "utf8"), /import "\.\/mouvement-reduit\.css";/);
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
async function bancInstallation(t: TestContext, installAssistant?: () => never, modulesEnPlus: readonly EqModule[] = []): Promise<CockpitHarness> {
  const studio = studioEspion();
  const ref: { h?: CockpitHarness } = {};
  const h = await startCockpit(t, {
    settings: { ui: { mode: "avance" } },
    modules: "tous",
    equipes: [EQ_MODULES.agentMap, EQ_MODULES.teams, EQ_MODULES.teamPreflight, ...modulesEnPlus, EQ_MODULES.teamGuards],
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

/**
 * Nœud minimal du DOM : exactement ce que le piège demande, et rien de plus (aucune dépendance de test n'est ajoutée, P8).
 * `Node` global est posé sur cette classe pendant l'essai, pour l'`instanceof` du piège à focus.
 */
class NoeudEssai {
  focus_recu = 0;
  readonly enfants: NoeudEssai[] = [];
  readonly nom: string;
  readonly focalisable: boolean;
  private readonly attributs: Record<string, string>;
  private readonly visible: boolean;
  constructor(nom: string, focalisable = false, attributs: Record<string, string> = {}, visible = true) {
    this.nom = nom;
    this.focalisable = focalisable;
    this.attributs = attributs;
    this.visible = visible;
  }
  hasAttribute(nom: string): boolean {
    return Object.hasOwn(this.attributs, nom);
  }
  getAttribute(nom: string): string | null {
    return this.attributs[nom] ?? null;
  }
  get offsetWidth(): number {
    return this.visible ? 10 : 0;
  }
  get offsetHeight(): number {
    return this.visible ? 10 : 0;
  }
  focus(): void {
    this.focus_recu += 1;
  }
  contains(autre: unknown): boolean {
    return autre === this || this.enfants.includes(autre as NoeudEssai);
  }
  querySelectorAll(_selecteur: string): NoeudEssai[] {
    return this.enfants.filter((enfant) => enfant.focalisable);
  }
  querySelector(_selecteur: string): NoeudEssai | null {
    return this.enfants.find((enfant) => enfant.focalisable) ?? null;
  }
}

interface DomEssai {
  /** `document.activeElement` : l'élément qui a le focus au moment de la touche. */
  actif: NoeudEssai | null;
  /** Les fonds de boîte empilés, dans l'ordre du document (`document.querySelectorAll(".modal-backdrop")`). */
  pile: NoeudEssai[];
  /** Le document servi au piège pendant l'essai. */
  document: Document;
}

/** Pose `Node` (pour l'`instanceof`) le temps de `corps`, et le remet exactement comme il était. */
function avecDomMinimal<T>(corps: (dom: DomEssai) => T): T {
  const global = globalThis as Record<string, unknown>;
  const avantNode = global.Node;
  const nodePresent = "Node" in global;
  global.Node = NoeudEssai;
  const dom = {
    actif: null as NoeudEssai | null,
    pile: [] as NoeudEssai[],
  } as DomEssai;
  dom.document = {
    get activeElement() {
      return dom.actif;
    },
    querySelectorAll: (selecteur: string) => (selecteur === ".modal-backdrop" ? dom.pile : []),
  } as unknown as Document;
  try {
    return corps(dom);
  } finally {
    if (nodePresent) global.Node = avantNode;
    else delete global.Node;
  }
}

const toucheEssai = (key: string, options: { shiftKey?: boolean; altKey?: boolean; ctrlKey?: boolean; metaKey?: boolean } = {}) => {
  const e = { key, shiftKey: false, altKey: false, ctrlKey: false, metaKey: false, ...options, empeche: 0, preventDefault: () => void (e.empeche += 1) };
  return e;
};

/** Le piège, appelé comme `Modal` l'appelle : `piegerLaTabulation(e, panel.current, backdrop.current)`. */
const frapper = (dom: DomEssai, boite: NoeudEssai, fond: NoeudEssai, touche: ReturnType<typeof toucheEssai>) => {
  piegerLaTabulation(touche, boite as unknown as HTMLElement, fond as unknown as Element, dom.document);
  return touche;
};

describe("croisements it4 V4 — D6 : le piège à focus des boîtes de dialogue, monté", () => {
  it("la tabulation boucle aux deux extrémités, ne touche à rien au milieu, et ne vise que la boîte du dessus", () => {
    avecDomMinimal((dom) => {
      const lanceur = new NoeudEssai("lanceur", true);
      const premier = new NoeudEssai("premier", true);
      const milieu = new NoeudEssai("milieu", true);
      const dernier = new NoeudEssai("dernier", true);
      const boite = new NoeudEssai("boite");
      boite.enfants.push(premier, milieu, dernier);
      const fond = new NoeudEssai("fond");
      dom.pile = [fond];

      // 1. Tabulation depuis le DERNIER : elle revient au premier au lieu de sortir derrière la boîte (c'est le défaut D6).
      dom.actif = dernier;
      assert.equal(frapper(dom, boite, fond, toucheEssai("Tab")).empeche, 1, "la tabulation qui sortirait de la boîte est retenue");
      assert.equal(premier.focus_recu, 1, "le focus revient au premier élément");

      // 2. Maj+Tabulation depuis le PREMIER : elle va au dernier.
      dom.actif = premier;
      assert.equal(frapper(dom, boite, fond, toucheEssai("Tab", { shiftKey: true })).empeche, 1);
      assert.equal(dernier.focus_recu, 1, "Maj+Tab depuis le premier va au dernier");

      // 3. Au MILIEU, le piège ne fait rien : l'ordre de tabulation à l'intérieur de la boîte ne change pas.
      dom.actif = milieu;
      assert.equal(frapper(dom, boite, fond, toucheEssai("Tab")).empeche, 0, "la tabulation entre deux éléments de la boîte n'est pas touchée");
      assert.equal(premier.focus_recu, 1);

      // 4. Focus égaré HORS de la boîte (c'est ce que faisait la tabulation avant D6) : il y est ramené.
      dom.actif = lanceur;
      assert.equal(frapper(dom, boite, fond, toucheEssai("Tab")).empeche, 1);
      assert.equal(premier.focus_recu, 2, "un focus parti derrière la boîte y est ramené");

      // 5. Raccourcis du navigateur (Ctrl, Alt, Cmd) et autres touches : jamais touchés.
      dom.actif = dernier;
      for (const options of [{ ctrlKey: true }, { altKey: true }, { metaKey: true }]) {
        assert.equal(frapper(dom, boite, fond, toucheEssai("Tab", options)).empeche, 0, `Tab + ${JSON.stringify(options)} laissé au navigateur`);
      }
      assert.equal(frapper(dom, boite, fond, toucheEssai("Escape")).empeche, 0, "le piège ne connaît qu'une touche : Tab");

      // 6. Une boîte EMPILÉE au-dessus : celle du dessous ne retient plus rien (même règle qu'Échap).
      dom.pile = [fond, new NoeudEssai("fond-2")];
      dom.actif = dernier;
      assert.equal(frapper(dom, boite, fond, toucheEssai("Tab")).empeche, 0, "seule la boîte du dessus retient la tabulation");

      // 7. Boîte sans rien à focaliser : le focus se pose sur elle, jamais derrière.
      dom.pile = [fond];
      const vide = new NoeudEssai("boite-vide");
      dom.actif = lanceur;
      assert.equal(frapper(dom, vide, fond, toucheEssai("Tab")).empeche, 1);
      assert.equal(vide.focus_recu, 1);
    });
  });

  it("Modal n'envoie à ce piège que la tabulation, et Échap rend le focus au lanceur comme à l'itération 1", () => {
    const code = fs.readFileSync(path.join(APP_DIR, "web/components/ui.tsx"), "utf8");
    // Le changement de D6 touche TOUTES les boîtes de dialogue : dans ce fichier partagé, il tient en un branchement balisé.
    assert.match(
      code,
      /\/\/ --- équipes \(it4\) : début ---[\s\S]*?if \(e\.key === "Tab"\) \{\s*piegerLaTabulation\(e, panel\.current, backdrop\.current\);\s*return;\s*\}\s*\/\/ --- équipes \(it4\) : fin ---/,
    );
    assert.match(code, /\/\/ --- équipes \(it4\) : début ---\s*import \{ piegerLaTabulation \} from "\.\/modal-focus\.ts";\s*\/\/ --- équipes \(it4\) : fin ---/);
    // Échap et le retour du focus à l'élément d'avant restent ceux de l'itération 1, hors balises, inchangés.
    assert.match(code, /if \(e\.key !== "Escape"\) return;\s*\/\/ Modales empilées : seule celle du dessus se ferme\.\s*const stack = document\.querySelectorAll\("\.modal-backdrop"\);/);
    assert.match(code, /previous\?\.focus\?\.\(\);/);
    // Éprouvé de bout en bout dans un vrai navigateur par `it4-captures` : les DOUZE tabulations restent dans la feuille de
    // lancement, Échap la ferme et rend le focus au lanceur. L'assertion du banc exigeait « au moins une » ; elle exige les 12.
    const scenario = lire(path.join("e2e", "scenarios", "it4-captures.mjs"));
    assert.match(scenario, /exiger\(dedans === 12, `le focus sort de la feuille de lancement au clavier : \$\{dedans\}\/12 tabulations dedans\.`\)/);
    assert.match(scenario, /exiger\(rendu === lanceur, `le focus n'est pas rendu au lanceur après la fermeture/);
  });
});

// --- « À surveiller » de la répétition générale : le repos qui suit l'état « terminee » -------------------------------------------

/*
 * Point « à surveiller » de la répétition générale du 21/09 (constat C4 de la vague 4) : `it4-studio` échouait dans le passage
 * complet chargé sur un 409 « sessions-busy » rendu JUSTE APRÈS la fin d'une équipe, et passait seul. Le refus lui-même est le
 * comportement que la spécification demande ; ce qui n'était borné par rien de visible, c'est le DÉLAI entre l'état « terminee »
 * du lancement et le repos réel des sessions d'étape. La mesure est faite ici, dans la vraie pile et sans Docker :
 *   1. à « terminee », le cockpit a DÉJÀ rendu son occupation propre — `c11.reloadBusy()` est faux (D-eq-06) et la file de
 *      configuration ne porte plus de demande facturée : l'équipe ne retient plus la garde de rechargement ;
 *   2. ce qui peut encore refuser est la seule sonde d'opencode (`probeSessionsBusy`, `GET /session/status`), et elle revient au
 *      repos d'elle-même, en un temps borné.
 * Le produit n'a donc rien à changer (aucune publication de « terminee » différée, ce qui mentirait sur l'état du lancement) :
 * c'est au banc d'attendre ce repos, et `e2e/scenarios/it4-studio.mjs` le fait désormais, en le mesurant.
 */

/** Assistants et étapes d'un déroulé installé, pour les déclarer au faux et scripter leurs tours. */
function etapesEtAssistants(flow: Flow): { etapes: string[]; assistants: string[] } {
  const etapes = flow.blocs.flatMap((bloc) => (bloc.type === "etape" ? [bloc.etape] : bloc.type === "avis" ? [...bloc.avis, bloc.synthese] : []));
  return { etapes: etapes.map((etape) => etape.id), assistants: [...new Set(etapes.map((etape) => etape.assistant))] };
}

/** Assistant du catalogue tel que le faux le rend à `GET /agent` (lecture seule : le pré-lancement réel en calcule le plancher). */
const agentDuFaux = (name: string): FakeAgent => ({
  name,
  mode: "all",
  description: `Assistant ${name}`,
  model: { providerID: "github-copilot", modelID: "gpt-5-mini" },
  options: {},
  permission: [
    { permission: "*", pattern: "*", action: "deny" },
    { permission: "read", pattern: "*", action: "allow" },
    { permission: "grep", pattern: "*", action: "allow" },
    { permission: "glob", pattern: "*", action: "allow" },
  ] as FakeAgent["permission"],
  steps: 20,
});

/** Attend un état du lancement par la vraie route de lecture ; le message d'échec dit l'état et celui de chaque étape. */
async function attendreEtat(h: CockpitHarness, runId: string, etat: TeamRunView["state"], timeoutMs = 10_000): Promise<TeamRunView> {
  const limite = Date.now() + timeoutMs;
  for (;;) {
    const res = await h.call("GET", `/api/team-runs/${runId}`, { headers: h.headers.authed });
    assert.equal(res.status, 200, res.body);
    const vue = res.json<TeamRunView>();
    if (vue.state === etat) return vue;
    assert.ok(
      Date.now() < limite,
      `lancement « ${etat} » attendu : état ${vue.state}, étapes ${vue.steps.map((step) => `${step.stepId}=${step.state}`).join(", ")}`,
    );
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

/** Installe « Revue SQL sur réplica », la lance sur le faux opencode et rend la vue du lancement terminé. */
async function equipeTerminee(t: TestContext): Promise<{ h: CockpitHarness; vue: TeamRunView }> {
  const h = await bancInstallation(t, undefined, [createTeamRunnerModule({ pollMs: 40, retryMs: 25, usageWaitMs: 300 })]);
  fs.mkdirSync(path.join(h.deps.env.workspaceDir, "projet"), { recursive: true });
  const directory = `${h.fake.directory}/projet`;

  const installe = await h.call("POST", "/api/teams/examples/revue-sql/install", { headers: h.headers.mutating, body: {} });
  assert.equal(installe.status, 200, installe.body);
  const { assistants } = etapesEtAssistants(installe.json<TeamInstallResponse>().team.flow);
  // Les assistants posés par l'installation sont déclarés au faux : le vrai pré-lancement les retrouve par `GET /agent`.
  const connus = new Set(h.fake.agents().map((agent) => agent.name));
  const manquants = assistants.filter((nom) => !connus.has(nom));
  if (manquants.length > 0) h.fake.setAgents([...h.fake.agents(), ...manquants.map(agentDuFaux)]);
  h.fake.scriptWhen(() => true, { text: "Avis rendu.", cost: 0.01, tokens: { input: 90, output: 20 }, stepMs: 5 });

  const estimation = await h.call("POST", "/api/teams/revue-sql/estimate", { headers: h.headers.mutating, body: { directory, rootId: null } });
  assert.equal(estimation.status, 200, estimation.body);
  const started = await h.call("POST", "/api/teams/revue-sql/run", {
    headers: h.headers.mutating,
    body: {
      directory,
      rootId: null,
      demande: "Relis la requête de facturation du mois dernier.",
      fichiers: [],
      agentConversation: "build",
      estimateSha256: estimation.json<TeamEstimateResponse>().estimateSha256,
      confirmations: {},
    },
  });
  assert.equal(started.status, 202, started.body);
  return { h, vue: await attendreEtat(h, started.json<TeamRunStarted>().runId, "terminee") };
}

describe("croisements it4 V4 — à « terminee », l'équipe ne retient plus la garde de rechargement", () => {
  it("le cockpit a rendu son occupation propre, et la sonde d'opencode revient au repos d'elle-même", async (t) => {
    const { h, vue } = await equipeTerminee(t);
    assert.equal(vue.steps.length, 4, "les quatre étapes de « Revue SQL sur réplica » ont tourné");
    for (const step of vue.steps) {
      assert.equal(step.state, "terminee", `étape ${step.stepId}`);
      assert.ok(step.sessionId, `étape ${step.stepId} sans session : rien n'aurait été envoyé à opencode`);
    }

    // 1. Occupation PROPRE du cockpit : rendue dès « terminee ». C'est la moitié dont le produit répond (D-eq-06).
    assert.equal(h.cockpit.c11.reloadBusy(), false, "l'équipe terminée compte encore le cockpit occupé");
    assert.equal(h.deps.configQueue?.billedInFlight ?? 0, 0, "une demande facturée est encore comptée en vol après la fin de l'équipe");

    // 2. Reste la sonde d'opencode, que la garde lit à chaque appel : elle revient au repos seule, en un temps borné. C'est ce
    //    délai — et lui seul — que le banc attend maintenant avant les écritures d'après l'équipe (it4-studio.mjs).
    const sonde = () => probeSessionsBusy({ client: h.deps.client, projects: h.deps.projects, db: h.db });
    const limite = Date.now() + 5_000;
    let occupe = await sonde();
    while (occupe && Date.now() < limite) {
      await new Promise((resolve) => setTimeout(resolve, 10));
      occupe = await sonde();
    }
    assert.equal(occupe, false, "une session est encore comptée occupée par opencode 5 s après la fin de l'équipe");
  });

  it("`it4-studio` n'attend QUE les sessions d'étape de son lancement — la portée est éprouvée, pas relue", async () => {
    // Le module du scénario est chargé tel quel (il n'est pas dans `tsconfig`, d'où l'import par URL) : ce sont ses deux
    // fonctions de portée qui sont éprouvées, pas une copie ni son texte. C'est ce que la relecture de la première correction
    // n'attrapait pas : elle relisait le scénario, et le scénario lisait tout le dossier partagé.
    const studio = (await import(pathToFileURL(path.join(REPO_DIR, "e2e", "scenarios", "it4-studio.mjs")).href)) as {
      sessionsDuLancement: (vue: unknown) => string[];
      filtrerOccupees: (etats: unknown, sessions: readonly string[]) => string[];
    };

    // 1. Les sessions d'un lancement sont celles que la vue du lancement nomme, et elles seules ; une étape sans session
    //    (jamais démarrée) n'en ajoute pas, et un doublon ne compte qu'une fois.
    const vue = { steps: [{ sessionId: "ses_a" }, { sessionId: null }, { sessionId: "ses_b" }, { sessionId: "ses_a" }, {}] };
    assert.deepEqual(studio.sessionsDuLancement(vue), ["ses_a", "ses_b"]);
    assert.deepEqual(studio.sessionsDuLancement(null), []);

    // 2. PORTÉE : le dossier des équipes est « /workspace », que les 27 scénarios du banc partagent. `GET /session/status` y
    //    rend AUSSI les sessions des autres scénarios. Une session étrangère occupée ne doit jamais faire attendre celui-ci —
    //    c'est le défaut que la revue d'itération a relevé (le scénario tombait en passage complet et passait seul).
    const etats = {
      ses_a: { type: "idle" },
      ses_b: { type: "idle" },
      ses_etrangere: { type: "busy" },
      ses_autre_scenario: { type: "retry" },
    };
    assert.deepEqual(studio.filtrerOccupees(etats, ["ses_a", "ses_b"]), [], "une session occupée d'un AUTRE scénario ne compte pas");

    // 3. …et une session d'étape de CE lancement qui reste occupée est bien vue, elle.
    assert.deepEqual(studio.filtrerOccupees({ ...etats, ses_b: { type: "busy" } }, ["ses_a", "ses_b"]), ["ses_b"]);
    assert.deepEqual(studio.filtrerOccupees({ ...etats, ses_a: { type: "retry" } }, ["ses_a", "ses_b"]), ["ses_a"]);
    // Une session au repos peut ne pas figurer du tout dans la réponse : absente = au repos.
    assert.deepEqual(studio.filtrerOccupees({ ses_etrangere: { type: "busy" } }, ["ses_a", "ses_b"]), []);
    assert.deepEqual(studio.filtrerOccupees(null, ["ses_a"]), []);

    const scenario = lire(path.join("e2e", "scenarios", "it4-studio.mjs"));
    // Le refus pendant l'étape reste exigé : la correction du banc ne doit pas devenir une tolérance au 409.
    assert.match(scenario, /pendant une étape : code \$\{reponse\.code\} au lieu de 409/);
    // L'attente du repos est bornée, mesurée, relevée, et portée sur les seules sessions du lancement.
    assert.match(scenario, /const REPOS_MAX_MS = \d[\d_]*;/);
    assert.match(scenario, /delaiMs: REPOS_MAX_MS/);
    assert.match(scenario, /const miennes = sessionsDuLancement\(finie\);/);
    assert.match(scenario, /const reposMs = await attendreLeRepos\(ctx, miennes\);/);
    assert.match(scenario, /repos des \$\{miennes\.length\} session\(s\) d'étape de ce lancement/);
    // Un lancement sans aucune session d'étape ferait « attendre » une liste vide, donc rien : le scénario le refuse.
    assert.match(scenario, /exiger\(miennes\.length > 0,/);
    // Les écritures d'après l'équipe gardent leur code attendu : aucune n'est rendue facultative.
    assert.match(scenario, /reponse\.code === ecriture\.apres/);
  });
});

// --- Clôture de l'itération 4 : `it4-prelancement` ne suppose plus le travail d'un autre scénario -------------------------------

/** Charge un module de scénario du banc tel quel (il n'est pas dans `tsconfig`, d'où l'import par URL). */
const chargerScenario = (nom: string) => import(pathToFileURL(path.join(REPO_DIR, "e2e", "scenarios", nom)).href);

interface OutilsCommuns {
  sansLeFond: (journal: unknown) => { method: string; pathname: string }[];
  attendreCalme: (ctx: unknown, options?: { calmeMs?: number; delaiMs?: number }) => Promise<number>;
  sansRequete: (
    ctx: unknown,
    libelle: string,
    appel: () => Promise<unknown>,
    options?: { reprises?: number; calmeRepriseMs?: number },
  ) => Promise<unknown>;
}

/**
 * Pile de banc simulée : à CHAQUE lecture du journal, le cockpit a reçu une requête de FOND de plus (sondage des sessions),
 * exactement comme la vraie pile, qui ne se tait jamais complètement. `ajouter` permet d'y glisser une requête utile.
 */
function faussePile() {
  const journal: { method: string; pathname: string }[] = [];
  return {
    journal,
    ajouter(method: string, pathname: string) {
      journal.push({ method, pathname });
    },
    ctx: {
      mode: "faux",
      opencodeRequests: async () => {
        journal.push({ method: "GET", pathname: "/session/status" });
        return [...journal];
      },
    },
  };
}

/** Déroulé dérivé, comme `equipeDerivee` du banc : mêmes blocs, identifiants suffixés (donc empreinte différente). */
function deriverFlow(flow: Flow, suffixe: string): Flow {
  const renomme = (etape: { id: string }) => ({ ...etape, id: `${etape.id}-${suffixe}` });
  return {
    version: flow.version,
    blocs: flow.blocs.map((bloc) => {
      const id = `${bloc.id}-${suffixe}`;
      if (bloc.type === "etape") return { type: "etape", id, etape: renomme(bloc.etape) };
      if (bloc.type === "avis") return { type: "avis", id, avis: bloc.avis.map(renomme), synthese: renomme(bloc.synthese) };
      return { type: "pause", id, message: bloc.message };
    }),
  } as Flow;
}

describe("croisements it4 V4 — clôture : `it4-prelancement` ne suppose plus le travail d'un autre scénario", () => {
  it("deux équipes dérivées du MÊME exemple ont des empreintes différentes, et l'une refuse l'empreinte de l'autre (409)", async (t) => {
    const h = await bancInstallation(t, undefined, [createTeamRunnerModule({ pollMs: 40, retryMs: 25, usageWaitMs: 300 })]);
    fs.mkdirSync(path.join(h.deps.env.workspaceDir, "projet"), { recursive: true });
    const directory = `${h.fake.directory}/projet`;

    const installe = await h.call("POST", "/api/teams/examples/revue-sql/install", { headers: h.headers.mutating, body: {} });
    assert.equal(installe.status, 200, installe.body);
    const modele = installe.json<TeamInstallResponse>().team;

    // Les deux équipes du scénario, posées comme le banc les pose : `PUT /api/teams/:id` à partir du déroulé de l'exemple.
    const poser = async (suffixe: string) => {
      const flow = deriverFlow(modele.flow, suffixe);
      const { assistants } = etapesEtAssistants(flow);
      const connus = new Set(h.fake.agents().map((agent) => agent.name));
      const manquants = assistants.filter((nom) => !connus.has(nom));
      if (manquants.length > 0) h.fake.setAgents([...h.fake.agents(), ...manquants.map(agentDuFaux)]);
      // L'installation vient de remplir l'instantané des agents du cockpit (oc-lookup.ts, 15 s) : sans cela, le déroulé serait
      // refusé « assistant-absent » alors que le faux les sert déjà. Le banc, lui, attend cette expiration (attendreAssistantsVus).
      h.deps.lookup.invalidate();
      const id = `revue-sql-${suffixe}`;
      const pose = await h.call("PUT", `/api/teams/${id}`, {
        headers: h.headers.mutating,
        body: { titre: `${modele.titre} (${suffixe})`.slice(0, 80), description: modele.description ?? "", flow },
      });
      assert.equal(pose.status, 200, pose.body);
      return id;
    };
    const equipe = await poser("p");
    const autre = await poser("pb");

    const estimer = async (id: string) => {
      const res = await h.call("POST", `/api/teams/${id}/estimate`, { headers: h.headers.mutating, body: { directory, rootId: null } });
      assert.equal(res.status, 200, res.body);
      return res.json<TeamEstimateResponse>().estimateSha256;
    };
    const empreinte = await estimer(equipe);
    const empreinteAutre = await estimer(autre);
    // C'est ce que le scénario exige avant de s'en servir : sans cela, le refus ne prouverait rien.
    assert.notEqual(empreinte, empreinteAutre, "deux équipes dérivées du même exemple rendent la même empreinte");

    const lancer = (id: string, sha: string) =>
      h.call("POST", `/api/teams/${id}/run`, {
        headers: h.headers.mutating,
        body: {
          directory,
          rootId: null,
          demande: "Relis la requête de facturation du mois dernier.",
          fichiers: [],
          agentConversation: "build",
          estimateSha256: sha,
          confirmations: {},
        },
      });
    const refuse = await lancer(equipe, empreinteAutre);
    assert.equal(refuse.status, 409, refuse.body);
    assert.equal(refuse.json<{ error: string }>().error, "estimation-perimee");

    // …et l'exemple que l'ancien scénario nommait en dur SANS l'installer : le 404 était la BONNE réponse du cockpit, pas un défaut.
    const absente = await h.call("POST", "/api/teams/relecture-script/estimate", { headers: h.headers.mutating, body: { directory, rootId: null } });
    assert.equal(absente.status, 404, absente.body);
    assert.equal(absente.json<{ error: string }>().error, "not-found");
  });

  it("le scénario ne nomme AUCUN exemple qu'il n'installe pas : ses deux équipes viennent du même exemple, qu'il dérive", async () => {
    const source = lire(path.join("e2e", "scenarios", "it4-prelancement.mjs"));
    const prelancement = (await chargerScenario("it4-prelancement.mjs")) as { lecturesManquantes: (lues: unknown) => string[] };

    // 1. Aucune chaîne écrite en dur ne part vers une route d'équipe : tout passe par une équipe que le scénario a posée.
    const enDur = [...source.matchAll(/\b(?:estimer|installerExemple|lancer)\(\s*(?:api,\s*)?"([^"]+)"/g)].map((m) => m[1]);
    assert.deepEqual(enDur, [], `exemple(s) nommé(s) en dur dans it4-prelancement : ${enDur.join(", ")}`);
    // 2. Les deux équipes du scénario sont dérivées du MÊME exemple, avec deux suffixes différents.
    assert.match(source, /const EXEMPLE = "revue-sql";/);
    assert.match(source, /equipeDerivee\(api, EXEMPLE, SUFFIXE\)/);
    assert.match(source, /equipeDerivee\(api, EXEMPLE, SUFFIXE_AUTRE\)/);
    assert.match(source, /exiger\(\s*autre\.estimateSha256 !== estimation\.estimateSha256,/);
    // 3. Le classement automatique est mis de côté, et REMIS dans un `finally`.
    assert.match(source, /const classementAvant = await classementAutomatique\(ctx, "off"\);/);
    assert.match(source, /} finally \{\n\s*\/\/ Le classement automatique est remis comme trouvé[\s\S]*?classementAutomatique\(ctx, classementAvant\);/);
    // 4. Le refus n'est mesuré qu'après une fenêtre calme large, posée avant chaque série.
    assert.equal(source.match(/await calmeSiPossible\(ctx, \{ calmeMs: CALME_LONG_MS/g)?.length, 2);

    // 5. …et la seule fonction de décision du scénario est éprouvée, pas relue.
    assert.deepEqual(prelancement.lecturesManquantes([{ method: "GET", pathname: "/agent" }]), ["/command", "/global/config"]);
    assert.deepEqual(prelancement.lecturesManquantes([]), ["/agent", "/command", "/global/config"]);
    assert.deepEqual(prelancement.lecturesManquantes(null), ["/agent", "/command", "/global/config"]);
    assert.deepEqual(
      prelancement.lecturesManquantes([
        { method: "GET", pathname: "/agent" },
        { method: "GET", pathname: "/command" },
        { method: "GET", pathname: "/global/config" },
      ]),
      [],
    );
    // Une lecture faite par une AUTRE méthode ne compte pas : c'est bien `GET /agent` que l'estimation doit faire.
    assert.deepEqual(prelancement.lecturesManquantes([{ method: "POST", pathname: "/agent" }]), ["/agent", "/command", "/global/config"]);
  });

  it("le calme se mesure sur les requêtes UTILES : une pile qui sonde sans arrêt laisse quand même une fenêtre de mesure", async () => {
    const commun = (await chargerScenario("it4-commun.mjs")) as OutilsCommuns;

    // 1. Ce qui est de fond, et ce qui ne l'est jamais.
    assert.deepEqual(commun.sansLeFond([{ method: "GET", pathname: "/session/status" }, { method: "GET", pathname: "/config/providers" }]), []);
    assert.deepEqual(
      commun.sansLeFond([
        { method: "GET", pathname: "/agent" },
        { method: "POST", pathname: "/session" },
        { method: "GET", pathname: "/session/ses_1/message" },
      ]),
      [
        { method: "GET", pathname: "/agent" },
        { method: "POST", pathname: "/session" },
        { method: "GET", pathname: "/session/ses_1/message" },
      ],
    );
    assert.deepEqual(commun.sansLeFond(null), []);

    // 2. Sur une pile qui reçoit une requête de FOND à chaque lecture du journal — la vraie pile ne se tait jamais —, le calme
    //    vient quand même. Mesuré sur le journal complet, comme avant la clôture, il ne serait JAMAIS venu.
    const pile = faussePile();
    const avant = Date.now();
    await commun.attendreCalme(pile.ctx, { calmeMs: 400, delaiMs: 5_000 });
    assert.ok(Date.now() - avant < 4_000, "le calme n'est pas venu alors que la pile ne reçoit que des requêtes de fond");
  });

  it("aucune assertion n'est relâchée : une requête utile pendant l'appel fait toujours tomber le refus", async () => {
    const commun = (await chargerScenario("it4-commun.mjs")) as OutilsCommuns;

    // 1. Refus propre : rien d'utile pendant l'appel, malgré le sondage de fond qui continue.
    const calme = faussePile();
    const rendu = await commun.sansRequete(calme.ctx, "refus mesuré", async () => "réponse");
    assert.equal(rendu, "réponse");

    // 2. Une seule requête utile pendant l'appel suffit à faire tomber la mesure, avec son chemin dans le message — et SANS
    //    reprise : une création de session pendant un refus n'est jamais un bruit de fond.
    const bruyante = faussePile();
    let appels = 0;
    await assert.rejects(
      () =>
        commun.sansRequete(bruyante.ctx, "refus qui parle à opencode", async () => {
          appels += 1;
          bruyante.ajouter("POST", "/session");
          return "réponse";
        }),
      /refus qui parle à opencode : 1 requête\(s\) émise\(s\) pendant un refus — POST \/session/,
    );
    assert.equal(appels, 1, "une requête qui n'est pas un bruit de fond ne donne droit à aucune reprise");
  });

  it("la relecture d'archive du cockpit fait REPRENDRE la mesure, et un refus qui lirait vraiment une session tombe quand même", async () => {
    const commun = (await chargerScenario("it4-commun.mjs")) as OutilsCommuns;

    // 1. Bruit de fond passager : la mesure est reprise, et le refus passe à l'essai suivant.
    const passagere = faussePile();
    let tours = 0;
    const rendu = await commun.sansRequete(
      passagere.ctx,
      "refus sali une fois",
      async () => {
        tours += 1;
        if (tours === 1) {
          passagere.ajouter("GET", "/session/ses_etrangere");
          passagere.ajouter("GET", "/session/ses_etrangere/message");
        }
        return "réponse";
      },
      { reprises: 2, calmeRepriseMs: 300 },
    );
    assert.equal(rendu, "réponse");
    assert.equal(tours, 2, "la mesure salie par une relecture d'archive doit être reprise une fois");

    // 2. …mais une lecture de session qui se REPRODUIT à chaque essai fait tomber la mesure : l'assertion tient entière.
    const tetue = faussePile();
    let essais = 0;
    await assert.rejects(
      () =>
        commun.sansRequete(
          tetue.ctx,
          "refus qui lit une session",
          async () => {
            essais += 1;
            tetue.ajouter("GET", "/session/ses_lue/message");
            return "réponse";
          },
          { reprises: 1, calmeRepriseMs: 300 },
        ),
      /refus qui lit une session : 1 requête\(s\) émise\(s\) pendant un refus — GET \/session\/ses_lue\/message/,
    );
    assert.equal(essais, 2, "les reprises sont bornées : la mesure finit par tomber");
  });
});

// --- Ligne V4 du §5.2 : constante d'ouverture et options du banc ----------------------------------------------------------------

describe("croisements it4 V4 — ce que la vague doit garder vrai", () => {
  it("EQUIPES_SIMPLE_OUVERTES reste fausse dans le dépôt (U1) — ce test ne dit rien du banc, qui la bascule dans sa seule copie jetable", () => {
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

// --- Relecture de la vague 4 : le relevé publié ne doit pas vieillir en silence ---------------------------------------------------

/** Dernière vague de tests de croisement des équipes présente dans le dépôt (`croisements-eq-vN.test.ts`). */
function derniereVagueDeCroisements(): number {
  const vagues = fs
    .readdirSync(path.join(APP_DIR, "server"))
    .map((nom) => /^croisements-eq-v(\d+)\.test\.ts$/.exec(nom))
    .filter((trouve): trouve is RegExpExecArray => trouve !== null)
    .map((trouve) => Number(trouve[1]));
  assert.ok(vagues.length > 0, "aucun fichier croisements-eq-vN.test.ts trouvé");
  return Math.max(...vagues);
}

/** Texte d'un bloc balisé `<!-- équipes (it4) : début -->` … `: fin -->` de docs/RECAPITULATIF.md, réunis. */
function blocsEquipesDuRecapitulatif(): string {
  const texte = lire(path.join("docs", "RECAPITULATIF.md"));
  const blocs = [...texte.matchAll(/<!-- équipes \(it4\) : début -->([\s\S]*?)<!-- équipes \(it4\) : fin -->/g)].map((trouve) => trouve[1] ?? "");
  assert.ok(blocs.length >= 2, `blocs balisés « équipes (it4) » attendus, ${blocs.length} trouvé(s)`);
  return blocs.join("\n");
}

describe("croisements it4 V4 — le relevé de l'itération reste à jour", () => {
  it("le RECAPITULATIF nomme la DERNIÈRE vague de tests de croisement présente dans le dépôt, jamais une plus ancienne", () => {
    const derniere = derniereVagueDeCroisements();
    const bloc = blocsEquipesDuRecapitulatif();
    assert.ok(
      bloc.includes(`\`croisements-eq-v0\` à \`v${derniere}\``),
      `le relevé ne cite pas « \`croisements-eq-v0\` à \`v${derniere}\` » alors que croisements-eq-v${derniere}.test.ts est dans le dépôt`,
    );
    assert.ok(bloc.includes(`vagues 0 à ${derniere}`), `le relevé ne dit pas « tests de croisement des vagues 0 à ${derniere} »`);
    // Aucune mention d'une vague plus ancienne comme si elle était la dernière : c'est ainsi que le relevé s'est périmé.
    for (let vague = 0; vague < derniere; vague += 1) {
      assert.ok(!bloc.includes(`\`croisements-eq-v0\` à \`v${vague}\``), `le relevé s'arrête encore à « v${vague} »`);
      assert.ok(!bloc.includes(`vagues 0 à ${vague}`), `le relevé s'arrête encore aux « vagues 0 à ${vague} »`);
    }
  });

  it("la ligne des tests automatisés et celle du contrôle de mutation parlent de la même vague", () => {
    const bloc = blocsEquipesDuRecapitulatif();
    const mutations = [...bloc.matchAll(/à la vague (\d+)/g)].map((trouve) => Number(trouve[1]));
    assert.ok(mutations.length > 0, "la ligne « Contrôle de mutation » ne cite aucune vague");
    const vagueDuControle = Math.max(...mutations);
    assert.ok(
      bloc.includes(`vagues 0 à ${vagueDuControle}`),
      `le contrôle de mutation va jusqu'à la vague ${vagueDuControle}, mais la ligne des tests automatisés s'arrête plus tôt`,
    );
  });

  it("`it4-simple-ouvert` n'est pas compté sans sa condition : le relevé et e2e/README.md disent comment le jouer", () => {
    const readme = lire(path.join("e2e", "README.md"));
    const ligne = readme.split("\n").find((l) => l.includes("`it4-simple-ouvert.mjs`") && l.startsWith("|"));
    assert.ok(ligne, "aucune ligne de tableau pour `it4-simple-ouvert.mjs` dans e2e/README.md");
    assert.match(ligne, /avant de bâtir les images/, "e2e/README.md ne dit pas QUAND basculer la constante dans la copie jetable");
    assert.match(ligne, /jamais dans le dépôt/, "e2e/README.md ne rappelle pas que le dépôt n'est jamais touché (U1)");
    // Le §10 doit nommer ce scénario : sans cela, il est compté « vert » alors qu'il ne joue rien dans une passe ordinaire.
    assert.match(blocsEquipesDuRecapitulatif(), /it4-simple-ouvert/, "le §10 compte les scénarios verts sans dire le cas de `it4-simple-ouvert`");
  });

  it("les sélecteurs qu'interroge `it4-simple-ouvert` existent dans l'interface (filet qui manquait, le scénario ne tournant pas)", () => {
    const scenario = fs.readFileSync(path.join(REPO_DIR, "e2e", "scenarios", "it4-simple-ouvert.mjs"), "utf8");
    const bruts = [
      ...[...scenario.matchAll(/querySelector\('([^']+)'\)/g)].map((trouve) => trouve[1] ?? ""),
      ...[...scenario.matchAll(/page\.texte\("([^"]+)"\)/g)].map((trouve) => trouve[1] ?? ""),
    ];
    const classes = [...new Set(bruts.flatMap((sel) => sel.split(/\s+/)).filter((mot) => mot.startsWith(".")))].map((mot) => mot.slice(1));
    assert.ok(classes.length >= 6, `sélecteurs de classe extraits du scénario : ${classes.join(", ")}`);
    const sources: string[] = [];
    const parcourir = (dossier: string) => {
      for (const entree of fs.readdirSync(dossier, { withFileTypes: true })) {
        const chemin = path.join(dossier, entree.name);
        if (entree.isDirectory()) parcourir(chemin);
        else if (/\.(?:tsx?|css)$/.test(entree.name)) sources.push(fs.readFileSync(chemin, "utf8"));
      }
    };
    parcourir(path.join(APP_DIR, "web"));
    for (const classe of classes) {
      assert.ok(
        sources.some((source) => source.includes(classe)),
        `la classe « ${classe} », interrogée par it4-simple-ouvert.mjs, n'existe plus dans app/web`,
      );
    }
  });
});
