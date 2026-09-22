// Tests de croisement du train 5b V3 (plan d'exécution it5 §2.4, §5.3 ; propriété de l'intégrateur) : L43 (schéma modifiable)
// et L44f (liens : onglet Méthodes, puce avec une équipe, Seconde lecture d'un résultat d'équipe, Archives), ENSEMBLE, sur le
// cockpit COMPLET avec le faux opencode.
//
// Les deux paquets ont été écrits sans se voir, et chacun a prouvé sa part : L43 sur des déroulés fabriqués et tirés au hasard
// (`flow-schema-ops.test.ts`), L44f sur des sources et des messages composés à la main (`construction-liens.test.ts`). Ce fichier
// ne refait aucune de ces preuves. Il branche les deux sur le VRAI cockpit et vérifie les trois croisements de la vague
// (§5.3, colonne « Croisements ») et sa grille propre :
//   1. CHAQUE opération du schéma suivie de `validateFlow`, sur les VRAIS exemples de C §12.1 installés par leur route :
//      zéro problème bloquant, ou refus attendu — et, pour les déroulés obtenus, l'aperçu RÉEL du serveur
//      (`POST /api/teams/preview`) dit exactement ce que le schéma affiche, sur toute la STRUCTURE ;
//   2. l'onglet « Méthodes » est routé : l'adresse fait l'aller-retour, l'onglet est en FIN de la liste de l'itération 4, et la
//      bibliothèque qu'il monte lit le VRAI catalogue par `GET /api/methods` (L44a, L44d) ;
//   3. la Seconde lecture d'un résultat d'équipe est refusée (409 `equipe-en-cours`) PENDANT un lancement réel, et acceptée
//      après : le masquage du bouton (L44f) et le verrou du proxy (it4) disent la même chose au même moment.
// Grille propre de la vague : revalidation SERVEUR à l'enregistrement et au lancement (C §11 S4), chaque glisser a son bouton ou
// son menu (WCAG 2.5.7), chaque refus est annoncé par une PHRASE (jamais par la couleur seule).
// S'y ajoute le quatrième lien de L44f éprouvé de bout en bout : les deux messages qu'une équipe fait écrire au cockpit,
// injectés par le VRAI exécuteur, découpés par le VRAI `buildDigest` (it1) puis rendus à leur auteur par `blocsDArchive`.
//
// Aucune exécution facturée, aucun appel à un fournisseur réel : tout passe par le faux opencode (C §17.2).
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, it, type TestContext } from "node:test";
import { Hono } from "hono";
import { buildDigest } from "./archive.ts";
import { AssistantService as AssistantServiceClass } from "./assistants.ts";
import type { ConfigWriteQueue } from "./config-queue.ts";
import type { OcMessageWithParts, OcSession } from "./opencode.ts";
import { registerAiRoutes, registerAssistantRoutes } from "./routes-assistants.ts";
import { SECOND_READING_CATALOG_ID, SECOND_READING_TURN_KIND } from "./shared/construction-constants.ts";
import { TEXTES as C5 } from "./shared/construction-texts.ts";
import { secondReadingMessageFor } from "./shared/chat-methods-view.ts";
import type { MethodView } from "./shared/construction-types.ts";
import { validateFlow } from "./shared/flow.ts";
import {
  PROBLEMES_DES_ASSISTANTS,
  SCHEMA_FORMES,
  SCHEMA_REFUS_CODES,
  type SchemaOpResult,
  addAvis,
  addSpecialiste,
  contexteStructure,
  dropCheck,
  insertAfter,
  moveDown,
  moveUp,
  phraseRefus,
  problemesStructurels,
  removeAvis,
  removeBloc,
  removeSpecialiste,
  schemaModel,
  setChoixMax,
  setRecoit,
  setTours,
  transform,
} from "./shared/flow-schema-ops.ts";
import { TEXTES as EQ } from "./shared/team-texts.ts";
import type { Flow, FlowProblem, FlowStep, TeamEstimateResponse, TeamInstallResponse, TeamRunStarted, TeamRunView, TeamRunsResponse } from "./shared/team-types.ts";
import type { StudioService } from "./studio.ts";
import { TEAM_EXAMPLES } from "./team-examples.ts";
import { createTeamRunnerModule } from "./team-runner.ts";
import { type CockpitHarness, startCockpit } from "./test-support/cockpit-harness.ts";
import type { FakeAgent } from "./test-support/fake-opencode.ts";
import type { TierService } from "./tiers.ts";
import { EQ_MODULES, EQUIPES_SIMPLE_OUVERTES } from "./wiring-eq.ts";
import { ASSISTANTS_TABS, type AssistantsTab, assistantsHref, assistantsTabHref, assistantsTabOf, assistantsViewOf, parseRoute, parseRouteQuery } from "../web/lib/router.ts";
import { blocsDArchive } from "../web/pages/chat/team/team-transcript.ts";
import { verrouDe } from "../web/pages/chat/team/team-view-model.ts";

const DEMANDE = "Le traitement de nuit est tombé deux fois cette semaine.";
const SCHEMA = C5.avance.schema;

// --- Banc : tout le cockpit, les cinq modules d'équipes, aucun port surchargé --------------------------------------------------

/** Studio simulé qui garde le corps des fichiers d'agent (même espion que le train de la vague 2). */
function studioEspion(): { studio: StudioService } {
  const saved = new Map<string, { kind: string; name: string; body: string; frontmatter: Record<string, unknown> }>();
  const item = (entry: { kind: string; name: string; body: string; frontmatter: Record<string, unknown> }) => ({
    kind: entry.kind,
    name: entry.name,
    scope: "global",
    project: null,
    file: `${entry.kind}/${entry.name}.md`,
    frontmatter: entry.frontmatter,
    body: entry.body,
    error: null,
    files: [],
    updatedAt: Date.now(),
  });
  const studio = {
    save: async (kind: string, _scope: unknown, input: { name: string; frontmatter: Record<string, unknown>; body?: string; createOnly?: boolean }) => {
      const cle = `${kind}/${input.name}`;
      if (input.createOnly === true && saved.has(cle)) return item(saved.get(cle) as never);
      const entry = { kind, name: input.name, body: input.body ?? "", frontmatter: input.frontmatter };
      saved.set(cle, entry);
      return item(entry);
    },
    remove: async () => true,
    get: async (kind: string, name: string) => {
      const entry = saved.get(`${kind}/${name}`);
      return entry ? item(entry) : null;
    },
    list: async (kind: string) => [...saved.values()].filter((entry) => entry.kind === kind).map(item),
    applyModels: async (_plan: unknown[], beforeWrite?: () => Promise<void>) => void (await beforeWrite?.()),
    ensureClassifierAgent: async () => undefined,
  } as unknown as StudioService;
  return { studio };
}

interface Banc extends CockpitHarness {
  /** Sous-dossier du workspace : l'équipe ne travaille pas sur tout le workspace (P9, `confirmation-workspace`). */
  directory: string;
}

/** Cockpit de production : modules 1.1 « tous », les CINQ modules d'équipes réels, AUCUN port d'équipe surchargé. */
async function banc(t: TestContext): Promise<Banc> {
  const { studio } = studioEspion();
  const ref: { h?: CockpitHarness } = {};
  const h = await startCockpit(t, {
    settings: {
      ui: { mode: "avance" },
      ai: {
        tiers: {
          rapide: { candidates: ["github-copilot/gpt-5-mini"], variant: null },
          equilibre: { candidates: ["github-copilot/gpt-5-mini"], variant: null },
          expert: { candidates: ["github-copilot/claude-sonnet-5"], variant: null },
        },
      },
    },
    modules: "tous",
    equipes: [
      EQ_MODULES.agentMap,
      EQ_MODULES.teams,
      EQ_MODULES.teamPreflight,
      createTeamRunnerModule({ pollMs: 40, retryMs: 25, usageWaitMs: 300 }),
      EQ_MODULES.teamGuards,
    ],
    deps: (base) => {
      const assistants = new AssistantServiceClass({
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
      const routeDeps = { assistants, tiers: base.tiers as TierService, settings: base.settings, hub: base.hub, log: base.log };
      return {
        studio,
        assistants,
        routes: [(app: Hono) => registerAssistantRoutes(app, routeDeps), (app: Hono) => registerAiRoutes(app, routeDeps)],
      };
    },
  });
  ref.h = h;
  fs.mkdirSync(path.join(h.deps.env.workspaceDir, "projet"), { recursive: true });
  return Object.assign(h, { directory: `${h.fake.directory}/projet` });
}

/** Règles d'un assistant du catalogue en lecture seule, telles que le faux les rend à `GET /agent`. */
const readOnlyRules = () => [
  { permission: "*", pattern: "*", action: "deny" },
  { permission: "read", pattern: "*", action: "allow" },
  { permission: "grep", pattern: "*", action: "allow" },
  { permission: "glob", pattern: "*", action: "allow" },
];

const fakeAgent = (name: string): FakeAgent => ({
  name,
  mode: "all",
  description: `Assistant ${name}`,
  model: { providerID: "github-copilot", modelID: "gpt-5-mini" },
  options: {},
  permission: readOnlyRules() as FakeAgent["permission"],
  steps: 40,
});

/** Étapes déclarées d'un déroulé, toutes formes confondues. */
function etapesDe(flow: Flow): FlowStep[] {
  return flow.blocs.flatMap((bloc) => {
    switch (bloc.type) {
      case "etape":
        return [bloc.etape];
      case "avis":
        return [...bloc.avis, bloc.synthese];
      case "relecture":
        return [bloc.auteur, bloc.relecteur];
      case "aiguillage":
        return [bloc.aiguilleur, ...bloc.specialistes, ...(bloc.synthese ? [bloc.synthese] : [])];
      default:
        return [];
    }
  });
}

/** Installe un exemple par sa VRAIE route et déclare ses assistants au faux. */
async function installerExemple(h: Banc, id: string): Promise<TeamInstallResponse> {
  const res = await h.call("POST", `/api/teams/examples/${id}/install`, { headers: h.headers.mutating, body: {} });
  assert.equal(res.status, 200, res.body);
  const body = res.json<TeamInstallResponse>();
  const connus = new Set(h.fake.agents().map((agent) => agent.name));
  const manquants = [...new Set(etapesDe(body.team.flow).map((etape) => etape.assistant))].filter((nom) => !connus.has(nom));
  if (manquants.length > 0) {
    h.fake.setAgents([...h.fake.agents(), ...manquants.map(fakeAgent)]);
    h.deps.lookup.invalidate();
  }
  return body;
}

// --- 1. Chaque opération du schéma, sur les exemples réels, et le serveur qui tranche -------------------------------------------

/** Clé d'un problème : son code et l'endroit exact où il est rendu (équipe, bloc ou étape). */
const cleProbleme = (probleme: FlowProblem) => `${probleme.code}|${probleme.bloc ?? ""}|${probleme.etape ?? ""}`;
const cles = (problemes: readonly FlowProblem[]) => [...new Set(problemes.map(cleProbleme))].sort();

/** Problèmes de STRUCTURE seulement : ceux qu'un navigateur peut juger sans lire les fichiers d'agent. */
const structurels = (problemes: readonly FlowProblem[]) => problemes.filter((probleme) => !PROBLEMES_DES_ASSISTANTS.includes(probleme.code));

const bloquants = (problemes: readonly FlowProblem[]) => problemes.filter((probleme) => probleme.bloquant);

/** Une opération jouée : son nom (pour le message d'erreur) et son résultat. */
interface Jouee {
  nom: string;
  res: SchemaOpResult;
}

/**
 * TOUTES les opérations du schéma applicables à ce déroulé, jouées une par une sur le déroulé de départ (jamais enchaînées :
 * chacune part du même état, donc chacune est comparable au serveur).
 */
function toutesLesOperations(flow: Flow): Jouee[] {
  const ctx = contexteStructure();
  const jouees: Jouee[] = [];
  flow.blocs.forEach((bloc, index) => {
    jouees.push({ nom: `moveUp(${bloc.id})`, res: moveUp(flow, bloc.id, ctx) });
    jouees.push({ nom: `moveDown(${bloc.id})`, res: moveDown(flow, bloc.id, ctx) });
    jouees.push({ nom: `removeBloc(${bloc.id})`, res: removeBloc(flow, bloc.id, ctx) });
    jouees.push({ nom: `addAvis(${bloc.id})`, res: addAvis(flow, bloc.id, ctx) });
    jouees.push({ nom: `addSpecialiste(${bloc.id})`, res: addSpecialiste(flow, bloc.id, ctx) });
    jouees.push({ nom: `setTours(${bloc.id}, 2)`, res: setTours(flow, bloc.id, 2, ctx) });
    jouees.push({ nom: `setTours(${bloc.id}, 1)`, res: setTours(flow, bloc.id, 1, ctx) });
    jouees.push({ nom: `setChoixMax(${bloc.id}, 2)`, res: setChoixMax(flow, bloc.id, 2, ctx) });
    jouees.push({ nom: `setChoixMax(${bloc.id}, 1)`, res: setChoixMax(flow, bloc.id, 1, ctx) });
    for (const forme of SCHEMA_FORMES) {
      jouees.push({ nom: `insertAfter(${bloc.id}, ${forme})`, res: insertAfter(flow, bloc.id, forme, ctx) });
      jouees.push({ nom: `transform(${bloc.id}, ${forme})`, res: transform(flow, bloc.id, forme, ctx) });
    }
    if (bloc.type === "avis") for (const avis of bloc.avis) jouees.push({ nom: `removeAvis(${avis.id})`, res: removeAvis(flow, bloc.id, avis.id, ctx) });
    if (bloc.type === "aiguillage") {
      for (const specialiste of bloc.specialistes) jouees.push({ nom: `removeSpecialiste(${specialiste.id})`, res: removeSpecialiste(flow, bloc.id, specialiste.id, ctx) });
    }
    // Liens : chaque étape du bloc reçoit le résultat de chaque étape déclarée plus haut, puis rend la main à la grammaire.
    const amont = flow.blocs.slice(0, index).flatMap((precedent) => etapesDe({ version: flow.version, blocs: [precedent] }).map((etape) => etape.id));
    for (const etape of etapesDe({ version: flow.version, blocs: [bloc] })) {
      jouees.push({ nom: `setRecoit(${etape.id}, null)`, res: setRecoit(flow, etape.id, null, ctx) });
      if (amont.length > 0) jouees.push({ nom: `setRecoit(${etape.id}, [${amont[0]}])`, res: setRecoit(flow, etape.id, [amont[0] as string], ctx) });
    }
  });
  return jouees;
}

/**
 * Déroulé de départ porteur d'un lien `recoit: {etapes}` du mode Avancé, que les six exemples du catalogue n'ont pas : c'est
 * exactement ce que le port de sortie et le menu « Reçoit le résultat de… » laissent poser dans le schéma. Sans lui, aucune
 * opération jouée ici n'avait de lien à casser, et un lien laissé PENDANT par une opération qui retire une étape passait
 * inaperçu (corrections de la relecture de la vague 3).
 */
const DEROULE_AVEC_LIEN: { id: string; flow: Flow } = {
  id: "déroulé-avec-lien",
  flow: {
    version: 1,
    blocs: [
      { type: "etape", id: "b-1", etape: { id: "e1", titre: "Collecte", assistant: "collecte", niveau: null, taille: "S", consigne: "Relever les faits.", recoit: "demande" } },
      { type: "etape", id: "b-2", etape: { id: "e2", titre: "Analyse", assistant: "analyse", niveau: null, taille: "M", consigne: "Chercher les causes.", recoit: "precedent" } },
      { type: "etape", id: "b-3", etape: { id: "e3", titre: "Rapport", assistant: "rapport", niveau: null, taille: "M", consigne: "Écrire le rapport.", recoit: { etapes: ["e1"] } } },
    ],
  },
};

/** Problèmes de LIEN qui bloquent : un lien vers une étape disparue en laisse derrière lui. */
const liensBloquants = (problemes: readonly FlowProblem[]) => problemes.filter((probleme) => probleme.bloquant && probleme.code.startsWith("lien-")).map(cleProbleme);

describe("croisement V3 : chaque opération du schéma, puis le serveur (C §11 S4)", () => {
  it("les six exemples réels : une opération rend un déroulé que `validateFlow` explique, ou un refus qui ne change rien", () => {
    for (const exemple of [...TEAM_EXAMPLES, DEROULE_AVEC_LIEN]) {
      const depart = exemple.flow;
      const jouees = toutesLesOperations(depart);
      assert.ok(jouees.length >= 20, `${exemple.id} : trop peu d'opérations jouées (${jouees.length})`);
      const liensDuDepart = liensBloquants(validateFlow(depart, contexteStructure().validation));
      for (const { nom, res } of jouees) {
        const ou = `${exemple.id} · ${nom}`;
        // (a) Le déroulé rendu est TOUJOURS expliqué par `validateFlow`, la même que le serveur emploie.
        assert.deepEqual(cles(res.problemes), cles(validateFlow(res.flow, contexteStructure().validation)), `${ou} : problemes ≠ validateFlow`);
        // (b) Un refus ne change JAMAIS le déroulé, et il porte sa phrase (jamais un code nu à l'écran).
        if (res.refus !== null) {
          assert.equal(res.change, false, `${ou} : un refus a changé le déroulé`);
          assert.equal(res.flow, depart, `${ou} : un refus a rendu un autre objet`);
          assert.equal(res.refus.texte, phraseRefus(res.refus.code), `${ou} : phrase du refus`);
        }
        // (c) Une opération qui change rend un NOUVEAU déroulé, et laisse celui qu'elle a reçu intact.
        if (res.change) assert.notEqual(res.flow, depart, `${ou} : le déroulé reçu a été modifié sur place`);
        // (d) Le schéma n'accepte que ce que le cockpit sait exécuter : tout problème bloquant STRUCTUREL est affiché quelque
        //     part par le modèle de la vue — sur l'équipe, sur son bloc ou sur son étape.
        const modele = schemaModel(res.flow, res.problemes, contexteStructure());
        const affiches = new Set([
          ...modele.problemes.map((probleme) => probleme.code),
          ...modele.lignes.flatMap((ligne) => [...ligne.problemes.map((probleme) => probleme.code), ...ligne.etapes.flatMap((etape) => etape.problemes.map((probleme) => probleme.code))]),
        ]);
        for (const probleme of bloquants(structurels(res.problemes))) {
          assert.ok(affiches.has(probleme.code), `${ou} : le problème bloquant « ${probleme.code} » n'est affiché nulle part`);
        }
        // (e) Une opération ACCEPTÉE ne pose jamais un problème de LIEN que le déroulé de départ n'avait pas : un lien laissé
        //     pendant par une étape retirée rendrait l'équipe irrecevable, avec une phrase qui parle d'ordre là où le lien
        //     vise une étape disparue — et sans aucune case à décocher pour la réparer.
        if (res.refus === null) {
          assert.deepEqual(liensBloquants(res.problemes).filter((cle) => !liensDuDepart.includes(cle)), [], `${ou} : lien resté pendant`);
        }
      }
    }
  });

  it("revue-sql, postmortem, tri-alerte : l'aperçu RÉEL du serveur dit exactement ce que le schéma affiche", async (t) => {
    const h = await banc(t);
    for (const id of ["revue-sql", "postmortem", "tri-alerte"]) {
      const installe = await installerExemple(h, id);
      const depart = installe.team.flow;

      // Déroulés distincts obtenus par une opération, dans l'ordre où le schéma les propose ; six suffisent par exemple, et
      // l'ensemble couvre les déplacements, les ajouts, les transformations et les liens.
      const distincts: Jouee[] = [];
      const vus = new Set<string>();
      for (const jouee of toutesLesOperations(depart)) {
        if (!jouee.res.change) continue;
        const signature = JSON.stringify(jouee.res.flow);
        if (vus.has(signature)) continue;
        vus.add(signature);
        distincts.push(jouee);
        if (distincts.length === 6) break;
      }
      assert.equal(distincts.length, 6, `${id} : moins de six déroulés distincts`);

      for (const { nom, res } of distincts) {
        const ou = `${id} · ${nom}`;
        const apercu = await h.call("POST", "/api/teams/preview", { headers: h.headers.mutating, body: { flow: res.flow } });
        assert.equal(apercu.status, 200, `${ou} : ${apercu.body}`);
        const duServeur = apercu.json<{ problems: FlowProblem[] }>().problems;
        // Le navigateur et le serveur disent LA MÊME CHOSE de la structure. (Les codes qui demandent les fichiers d'agent
        // restent au serveur : `problemesStructurels` ne prétend pas les juger, et ne les efface pas non plus.)
        assert.deepEqual(cles(problemesStructurels(res.flow)), cles(structurels(duServeur)), `${ou} : structure vue autrement par le serveur`);

        // Revalidation à l'ENREGISTREMENT (C §11 S4) : la route tranche, et elle tranche comme l'aperçu.
        const enregistrement = await h.call("PUT", `/api/teams/${id}`, {
          headers: h.headers.mutating,
          body: { titre: installe.team.titre, description: installe.team.description, flow: res.flow },
        });
        if (bloquants(duServeur).length === 0) {
          assert.equal(enregistrement.status, 200, `${ou} : enregistrement refusé alors qu'aucun problème ne bloque — ${enregistrement.body}`);
        } else {
          assert.equal(enregistrement.status, 422, `${ou} : enregistrement accepté malgré un problème bloquant — ${enregistrement.body}`);
          const refus = enregistrement.json<{ error: string; problems: FlowProblem[] }>();
          assert.equal(refus.error, "equipe-invalide", ou);
          assert.deepEqual(cles(refus.problems), cles(bloquants(duServeur)), `${ou} : problèmes du refus`);
        }
      }
      // L'exemple est remis dans son état d'origine pour l'exemple suivant (les identifiants sont partagés).
      const remise = await h.call("PUT", `/api/teams/${id}`, {
        headers: h.headers.mutating,
        body: { titre: installe.team.titre, description: installe.team.description, flow: depart },
      });
      assert.equal(remise.status, 200, remise.body);
    }
  });

  it("revalidation au LANCEMENT : une équipe enregistrée valide devient irrecevable quand son assistant disparaît", async (t) => {
    const h = await banc(t);
    const installe = await installerExemple(h, "revue-sql");
    const flow = installe.team.flow;

    // Le navigateur ne voit RIEN : « assistant-absent » demande les fichiers d'agent, que seul le serveur lit.
    assert.deepEqual(problemesStructurels(flow), [], "le déroulé de l'exemple est structurellement sain");
    const premier = await h.call("POST", "/api/teams/revue-sql/estimate", { headers: h.headers.mutating, body: { directory: h.directory, rootId: null } });
    assert.equal(premier.status, 200, premier.body);
    assert.equal(premier.json<TeamEstimateResponse>().blocage, null);

    // L'assistant d'une étape est retiré d'opencode : le déroulé enregistré, lui, n'a pas bougé d'un octet.
    const assistantDUneEtape = etapesDe(flow)[0]?.assistant as string;
    h.fake.setAgents(h.fake.agents().filter((agent) => agent.name !== assistantDUneEtape));
    h.deps.lookup.invalidate();
    assert.deepEqual(problemesStructurels(flow), [], "la structure est toujours saine : le navigateur ne peut pas juger cela");

    // Le pré-lancement rend son refus DANS l'estimation (`blocage`), pour que l'écran l'explique avant tout envoi…
    const apres = await h.call("POST", "/api/teams/revue-sql/estimate", { headers: h.headers.mutating, body: { directory: h.directory, rootId: null } });
    assert.equal(apres.status, 200, apres.body);
    const estimation = apres.json<TeamEstimateResponse>();
    assert.equal(estimation.blocage?.code, "equipe-invalide", JSON.stringify(estimation.blocage));
    const problemes = (estimation.blocage?.details as { problems?: FlowProblem[] } | undefined)?.problems ?? [];
    assert.ok(
      problemes.some((probleme) => probleme.code === "assistant-absent"),
      `problèmes du refus : ${JSON.stringify(problemes)}`,
    );

    // … et la route de LANCEMENT refuse, quoi qu'ait affiché le navigateur : c'est elle l'autorité (C §11 S4).
    const lancement = await h.call("POST", "/api/teams/revue-sql/run", {
      headers: h.headers.mutating,
      body: {
        directory: h.directory,
        rootId: null,
        demande: DEMANDE,
        fichiers: [],
        agentConversation: "build",
        estimateSha256: estimation.estimateSha256,
        confirmations: {},
      },
    });
    assert.equal(lancement.status, 422, lancement.body);
    assert.equal(lancement.json<{ error: string }>().error, "equipe-invalide");
  });

  it("grille de la vague : chaque glisser a son bouton ou son menu, et chaque refus a sa phrase", () => {
    // WCAG 2.5.7 : sur un exemple RÉEL, chaque ligne du schéma porte l'équivalent clavier de tout ce que le pointeur fait —
    // monter, descendre, ajouter après, transformer, supprimer — et chaque étape qui peut recevoir un résultat a son menu.
    const flow = (TEAM_EXAMPLES.find((exemple) => exemple.id === "tri-alerte") as (typeof TEAM_EXAMPLES)[number]).flow;
    const modele = schemaModel(flow, problemesStructurels(flow), contexteStructure());
    assert.ok(modele.lignes.length > 0);
    for (const ligne of modele.lignes.filter((candidate) => candidate.principale)) {
      assert.equal(ligne.monter.libelle, SCHEMA.menus.monter, ligne.blocId);
      assert.equal(ligne.descendre.libelle, SCHEMA.menus.descendre, ligne.blocId);
      assert.equal(ligne.supprimer.libelle, SCHEMA.menus.supprimer, ligne.blocId);
      assert.equal(ligne.ajouterApres.libelle, SCHEMA.menus.ajouterApres, ligne.blocId);
      assert.equal(ligne.transformer.libelle, SCHEMA.menus.transformer, ligne.blocId);
      assert.ok(ligne.ajouterApres.choix.length > 0 && ligne.transformer.choix.length > 0, ligne.blocId);
    }
    // L'équivalent clavier du lien tiré au pointeur est le menu « Reçoit le résultat de… » de l'étape VISÉE. Il n'est proposé
    // que là où la grammaire laisse le choix (une entrée imposée — avis, synthèse, relecteur, spécialiste — n'a rien à choisir),
    // et les exemples réels en offrent : sans cela, le lien n'aurait aucun équivalent clavier (WCAG 2.5.7).
    const avecLien = TEAM_EXAMPLES.flatMap((autre) =>
      schemaModel(autre.flow, problemesStructurels(autre.flow), contexteStructure())
        .lignes.flatMap((ligne) => ligne.etapes)
        .filter((etape) => etape.recoit !== null),
    );
    assert.ok(avecLien.length > 0, "aucune étape des exemples ne propose « Reçoit le résultat de… »");
    for (const etape of avecLien) {
      assert.equal(etape.recoit?.libelle, SCHEMA.menus.recevoir, etape.stepId);
      assert.ok((etape.recoit?.choix.length ?? 0) > 0, `${etape.stepId} : menu sans aucune case`);
    }

    // Refus annoncé POLIMENT : les quatre codes de C §8.2, chacun avec sa phrase du §4.3, à l'octet, et le modèle les porte.
    assert.deepEqual([...SCHEMA_REFUS_CODES].sort(), Object.keys(SCHEMA.refus).sort());
    for (const code of SCHEMA_REFUS_CODES) {
      assert.equal(modele.refus[code], SCHEMA.refus[code], code);
      assert.ok(modele.refus[code].trim().length > 10, `${code} : refus sans phrase`);
    }
    // Un lien tiré vers le HAUT, d'un bloc vers un bloc précédent, est refusé ; et le refus est du texte, pas une couleur.
    const script = (TEAM_EXAMPLES.find((exemple) => exemple.id === "relecture-script") as (typeof TEAM_EXAMPLES)[number]).flow;
    const parBloc = script.blocs.map((bloc) => etapesDe({ version: script.version, blocs: [bloc] }));
    const premiere = parBloc.find((etapes) => etapes.length > 0)?.[0] as FlowStep;
    const derniere = [...parBloc].reverse().find((etapes) => etapes.length > 0)?.at(-1) as FlowStep;
    assert.notEqual(premiere.id, derniere.id, "deux étapes de blocs différents sont attendues");
    const versLeHaut = dropCheck(script, { genre: "lien", stepId: derniere.id }, { genre: "etape", stepId: premiere.id });
    assert.deepEqual(versLeHaut, { ok: false, code: "versLeBas" });
    assert.equal(phraseRefus("versLeBas"), SCHEMA.refus.versLeBas);
    // Et un bloc lâché SUR un autre bloc : « Un bloc ne peut pas en contenir un autre. »
    const surUnBloc = dropCheck(script, { genre: "bloc", blocId: script.blocs[0]?.id as string }, { genre: "bloc", blocId: script.blocs[2]?.id as string });
    assert.deepEqual(surUnBloc, { ok: false, code: "imbrication" });
  });
});

// --- 2. Onglet « Méthodes » routé ------------------------------------------------------------------------------------------

describe("croisement V3 : l'onglet « Méthodes » est routé et monte le vrai catalogue", () => {
  it("adresse, aller-retour, onglet actif, et l'ordre des trois onglets de l'itération 4 inchangé", () => {
    assert.deepEqual([...ASSISTANTS_TABS], ["assistants", "equipes", "carte", "methodes"]);
    assert.equal(assistantsHref({ mode: "methodes" }), "#/assistants/methodes");
    assert.equal(assistantsTabHref("methodes"), "#/assistants/methodes");

    // Aller-retour par le VRAI analyseur d'adresses : chaque onglet retrouve le sien.
    for (const tab of ASSISTANTS_TABS) {
      const href = assistantsTabHref(tab);
      const vue = assistantsViewOf(parseRoute(href), parseRouteQuery(href));
      assert.equal(assistantsTabOf(vue), tab, href);
    }
    assert.deepEqual(assistantsViewOf(parseRoute("#/assistants/methodes"), parseRouteQuery("#/assistants/methodes")), { mode: "methodes" });
    // Un segment en trop ne devine rien : la vue par défaut, comme pour les adresses des équipes.
    assert.deepEqual(assistantsViewOf(parseRoute("#/assistants/methodes/x"), parseRouteQuery("#/assistants/methodes/x")), { mode: "liste" });
  });

  it("la bibliothèque de l'onglet lit le VRAI catalogue par GET /api/methods", async (t) => {
    const h = await banc(t);
    const res = await h.call("GET", "/api/methods", { headers: h.headers.authed });
    assert.equal(res.status, 200, res.body);
    const catalogue = res.json<{ methods: MethodView[] }>().methods;
    assert.ok(catalogue.length > 0, "catalogue des méthodes vide");
    for (const methode of catalogue) {
      assert.equal(typeof methode.id, "string");
      assert.equal(typeof methode.titre, "string");
      assert.ok(Array.isArray(methode.utiliseePar), `${methode.id} : « utilisée par » absent`);
    }
    // L'onglet monte la bibliothèque sur cette réponse : la page n'a plus d'autre montage (contrôle discriminant compris).
    const source = fs.readFileSync(path.join(import.meta.dirname, "..", "web/pages/AssistantsPage.tsx"), "utf8");
    const montages = source.match(/<MethodsLibrary\b/g) ?? [];
    assert.equal(montages.length, 1, "la bibliothèque doit être montée une seule fois, dans l'onglet");
    assert.match(source, /teamView\.mode === "methodes"/, "l'onglet « Méthodes » n'est pas branché sur la vue");
    assert.match(source, /assistantsTabHref\("methodes"\)/, "la section « Méthodes » de la liste ne renvoie pas vers l'onglet");
  });
});

// --- 3. Seconde lecture d'un résultat d'équipe pendant, puis après, un lancement réel -------------------------------------------

describe("croisement V3 : Seconde lecture d'un résultat d'équipe et verrou de la conversation", () => {
  it("409 `equipe-en-cours` pendant le lancement, acceptée et requalifiée après", async (t) => {
    const h = await banc(t);
    // `postmortem` installe le « Relecteur critique » : sans lui, aucun message ne pourrait être requalifié.
    await installerExemple(h, "postmortem");
    const equipe = await installerExemple(h, "revue-sql");
    const relecteur = h.db.prepare("SELECT name FROM item_meta WHERE kind = 'agents' AND catalog_id = ? LIMIT 1").get(SECOND_READING_CATALOG_ID) as
      | { name: string }
      | undefined;
    assert.ok(relecteur?.name, "le Relecteur critique doit être installé par l'exemple « postmortem »");

    // Chaque étape ouvre un outil qui attend la porte : l'équipe reste « en cours » tant que le test ne l'ouvre pas.
    let ouvrir: () => void = () => undefined;
    const porte = new Promise<void>((resolve) => {
      ouvrir = resolve;
    });
    h.fake.scriptWhen((session) => (session.metadata as { cockpit?: string } | undefined)?.cockpit === "equipe", {
      tools: [{ tool: "read", input: { filePath: "/workspace/projet/note.md" }, beforeAsk: () => porte }],
      followUp: { text: "Synthèse : corriger les jointures." },
      stepMs: 1,
    });

    const estimation = await h.call("POST", "/api/teams/revue-sql/estimate", { headers: h.headers.mutating, body: { directory: h.directory, rootId: null } });
    assert.equal(estimation.status, 200, estimation.body);
    const started = await h.call("POST", "/api/teams/revue-sql/run", {
      headers: h.headers.mutating,
      body: {
        directory: h.directory,
        rootId: null,
        demande: DEMANDE,
        fichiers: [],
        agentConversation: "build",
        estimateSha256: estimation.json<TeamEstimateResponse>().estimateSha256,
        confirmations: {},
      },
    });
    assert.equal(started.status, 202, started.body);
    const { runId, rootId } = started.json<TeamRunStarted>();

    /** Vue d'un lancement, par sa route. */
    const vue = async (): Promise<TeamRunView> => {
      const res = await h.call("GET", `/api/team-runs/${runId}`, { headers: h.headers.authed });
      assert.equal(res.status, 200, res.body);
      return res.json<TeamRunView>();
    };
    const attendre = async (predicat: (view: TeamRunView) => boolean, libelle: string): Promise<TeamRunView> => {
      const limite = Date.now() + 15_000;
      for (;;) {
        const courante = await vue();
        if (predicat(courante)) return courante;
        if (Date.now() > limite) throw new Error(`${libelle} : état ${courante.state}`);
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    };
    /** Lancements de la conversation, tels que la carte de résultat les lit (`useTeamRuns`). */
    const runsDeLaRacine = async (): Promise<TeamRunView[]> => {
      const res = await h.call("GET", `/api/team-runs?rootId=${rootId}`, { headers: h.headers.authed });
      assert.equal(res.status, 200, res.body);
      return res.json<TeamRunsResponse>().runs;
    };

    await attendre((view) => view.steps.some((step) => step.state === "en-cours"), "une étape en cours");

    // (1) PENDANT : l'envoi EXACT du bouton (variante « equipe ») est refusé par le proxy, avant même la lecture du corps.
    const texte = secondReadingMessageFor("equipe", equipe.team.titre);
    const envoi = {
      agent: relecteur?.name,
      model: { providerID: "github-copilot", modelID: "gpt-5-mini" },
      parts: [{ type: "text", text: texte }],
    };
    const pendant = await h.call("POST", `/api/oc/session/${rootId}/prompt_async`, { headers: h.headers.mutating, body: envoi });
    assert.deepEqual([pendant.status, pendant.json<{ error: string; message: string }>()], [409, { error: "equipe-en-cours", message: EQ.partout.verrous.envoi }]);
    // Le masquage du bouton (L44f) s'appuie sur le MÊME verrou : les deux disent oui au même instant.
    assert.equal(verrouDe(await runsDeLaRacine()), EQ.partout.saisieVerrouillee, "le modèle de la carte devrait masquer le bouton");
    assert.equal((h.db.prepare("SELECT COUNT(*) AS n FROM chat_turns WHERE session_id = ?").get(rootId) as { n: number }).n, 0, "rien n'a été facturé derrière le verrou");

    // (2) APRÈS : le lancement finit, le verrou tombe, et le même envoi passe.
    ouvrir();
    await attendre((view) => view.state === "terminee", "fin du lancement");
    assert.equal(verrouDe(await runsDeLaRacine()), null, "le bouton doit être proposé une fois le lancement fini");

    const apres = await h.call("POST", `/api/oc/session/${rootId}/prompt_async`, { headers: h.headers.mutating, body: envoi });
    assert.ok(apres.status < 400, `envoi refusé après la fin du lancement : ${apres.status} ${apres.body}`);

    // (3) Le crochet du serveur (5a) reconnaît la variante « equipe » de L44f : le tour est requalifié, pas laissé « message ».
    const tours = h.db.prepare("SELECT kind FROM chat_turns WHERE session_id = ? ORDER BY created_at, id").all(rootId) as unknown as Array<{ kind: string }>;
    assert.deepEqual(
      tours.map((row) => row.kind),
      [SECOND_READING_TURN_KIND],
    );

    // (4) Archives : les deux messages écrits par le cockpit pour l'équipe, injectés par le VRAI exécuteur, sont rendus à leur
    //     auteur une fois la transcription construite par le VRAI `buildDigest` (it1).
    const session = h.fake.session(rootId);
    assert.ok(session, "la racine doit exister dans le faux");
    const digest = buildDigest(session as unknown as OcSession, h.fake.messages(rootId) as OcMessageWithParts[], h.deps.env.workspaceDir);
    const blocs = blocsDArchive(digest.transcript);
    assert.deepEqual(
      blocs.filter((bloc) => bloc.genre !== "texte").map((bloc) => bloc.genre),
      ["equipe-demande", "equipe-resultat"],
    );
    assert.ok((blocs.find((bloc) => bloc.genre === "equipe-demande")?.texte ?? "").includes(DEMANDE), "la demande recopiée devrait être dans sa carte");
    assert.ok((blocs.find((bloc) => bloc.genre === "equipe-resultat")?.texte ?? "").includes("corriger les jointures"), "le résultat injecté devrait être dans sa carte");
    for (const bloc of blocs) assert.ok(!bloc.texte.includes("<!-- cockpit:"), "aucune ligne de marqueur n'est rendue");
  });
});

// --- 4. Constantes tenues par le train --------------------------------------------------------------------------------------

describe("croisement V3 : constantes de la construction", () => {
  it("les équipes restent fermées en mode Simple : `EQUIPES_SIMPLE_OUVERTES` vaut false (U1, D-5-24)", () => {
    assert.equal(EQUIPES_SIMPLE_OUVERTES, false);
  });
});
