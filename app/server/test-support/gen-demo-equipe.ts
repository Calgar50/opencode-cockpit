// Propriétaire : L49.
// Générateur de la démonstration d'équipe (spécification §5.3 l.896, §5.4 l.909, §5.9 l.1013-1017, §6 l.1064, JP-9 ; plan
// d'exécution it5, fiche L49 ; D-5-15) : l'EXÉCUTEUR RÉEL des équipes (team-runner.ts, itération 4) est lancé par le harnais du
// cockpit et le FAUX opencode sur un déroulé « Avis indépendants » (3 avis en même temps, puis une synthèse) dont les titres,
// les consignes et les réponses sont FICTIFS. Aucune IA n'est appelée, aucune requête ne sort : le faux répond seul.
// Le fichier produit, `web/pages/assistants/teams/demo-equipe.json`, est rejoué par TeamDemo.tsx dans le lecteur pas à pas de la
// démonstration passée (DemoPlayer, propriété `demo` ; depuis GF4, avec les mots de « Revoir ») : la bande néon vient des FAITS,
// la carte d'exécution et le Déroulé de la VUE du lancement.
//
// Déterminisme (demo-equipe.test.ts régénère le fichier et le compare à l'octet) : rien de l'horloge ni des identifiants réels
// n'entre dans le fichier.
// - Un MOMENT par état observable : le générateur relève les faits et la vue à chaque événement du cockpit, puis garde les
//   instantanés qui diffèrent d'un identifiant et d'une heure près. Le rang du moment est la seule mesure du temps.
// - Heures : chaque heure réelle est remplacée par celle du moment où elle apparaît pour la première fois (DEBUT + rang × PAS) ;
//   les faits d'un moment portent l'heure de leur moment, pour que scene(faits, t) montre exactement ce que le moment ajoute.
// - Identifiants : conversation, sessions d'étape, messages et lancement sont renommés dans leur ordre d'apparition.
// L'ordre d'arrivée des trois avis est fixé par des pas de temps très différents dans le faux (voir REPONSES) : seul cet ordre,
// pas les millisecondes, décide du fichier.
//
// Régénérer, depuis app/ : node --disable-warning=ExperimentalWarning server/test-support/gen-demo-equipe.ts
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { TestContext } from "node:test";
import { fileURLToPath } from "node:url";
import type { EqModule, PlannedStep, PreflightOutcome, RunPlan, TeamGuardsPort, TeamPreflightPort, TeamRow, TeamsPort } from "../contracts-eq.ts";
import { floorHash } from "../session-floor-service.ts";
import { type Rule, truncateGlob } from "../shared/assistant-rules.ts";
import type { ActivityFact } from "../shared/activity-types.ts";
import { buildFloor, canonicalRules } from "../shared/session-floors.ts";
import { planSteps } from "../shared/team-limits.ts";
import type { Flow, FlowEstimate, FlowStep, TeamRunStarted, TeamRunView } from "../shared/team-types.ts";
import { createTeamRunnerModule, type TeamRunner } from "../team-runner.ts";
import { createTeamStore } from "../team-store.ts";
import { startCockpit } from "./cockpit-harness.ts";
import type { FakeAgent } from "./fake-opencode.ts";
import { until } from "./helpers.ts";

/** Fichier lu par TeamDemo.tsx. */
export const DEMO_EQUIPE_FILE = path.join(import.meta.dirname, "..", "..", "web", "pages", "assistants", "teams", "demo-equipe.json");

/** Heure du premier moment : date FICTIVE, fixe, sans rapport avec l'horloge de la machine. */
export const DEMO_EQUIPE_DEBUT = 1_780_000_000_000;
/** Écart entre deux moments, en ms : le rang du moment est la seule mesure du temps. */
export const DEMO_EQUIPE_PAS = 700;

/** IA des étapes (catalogue du faux opencode) : nommée par la carte, jamais appelée. */
const MODEL = "github-copilot/gpt-5-mini";
const MODEL_LABEL = "GPT-5 mini";
/** Assistant de la conversation qui reçoit la demande et le résultat (injections `noReply`). */
const CHAT_AGENT = "build";

/** Demande FICTIVE de l'utilisateur. */
export const DEMO_EQUIPE_DEMANDE = "Relis ma note de version et dis-moi ce qui cloche.";

/** Équipe FICTIVE de la démonstration. */
export const DEMO_EQUIPE_TITRE = "Relecture croisée d'une note";
const DEMO_EQUIPE_ID = "relecture-croisee";

/** Assistants FICTIFS des étapes, avec le titre que la carte affiche (item_meta). */
const ASSISTANTS: ReadonlyArray<readonly [string, string]> = [
  ["relire-clarte", "Relecteur de clarté"],
  ["relire-exactitude", "Relecteur d'exactitude"],
  ["relire-risques", "Relecteur de risques"],
  ["resumer-avis", "Rédacteur de synthèse"],
];

/**
 * Réponses FICTIVES du faux opencode, une par étape, avec le pas de temps de son tour. Les trois avis partent en même temps :
 * leurs pas très différents (10, 60 et 120 ms) fixent leur ordre d'arrivée quelle que soit la charge de la machine, et c'est cet
 * ordre — jamais les millisecondes — qui décide du fichier produit.
 */
const REPONSES: ReadonlyArray<{ stepId: string; texte: string; stepMs: number; cout: number }> = [
  { stepId: "clarte", texte: "Trois phrases sont trop longues : je propose de les couper en deux.", stepMs: 10, cout: 0.012 },
  { stepId: "exactitude", texte: "La date de la version 2 ne correspond pas à celle du tableau plus bas.", stepMs: 60, cout: 0.018 },
  { stepId: "risques", texte: "Aucun risque bloquant ; la mention de la sauvegarde manque.", stepMs: 120, cout: 0.015 },
  { stepId: "synthese", texte: "Corriger la date, couper les trois phrases longues, ajouter la mention de la sauvegarde.", stepMs: 20, cout: 0.021 },
];

const sha256 = (texte: string): string => createHash("sha256").update(texte, "utf8").digest("hex");

/** Règles d'un assistant en lecture seule : refus par défaut, lecture permise (plancher ETAPE). */
const reglesLectureSeule = (): Rule[] => [
  { permission: "*", pattern: "*", action: "deny" },
  { permission: "read", pattern: "*", action: "allow" },
  { permission: "grep", pattern: "*", action: "allow" },
  { permission: "glob", pattern: "*", action: "allow" },
];

const fauxAssistant = (nom: string): FakeAgent => ({
  name: nom,
  mode: "all",
  description: `Assistant de la démonstration ${nom}`,
  options: {},
  permission: reglesLectureSeule() as FakeAgent["permission"],
});

const etape = (id: string, titre: string, assistant: string, consigne: string, recoit: "demande" | "precedent" | "tous"): FlowStep => ({
  id,
  titre,
  assistant,
  niveau: null,
  taille: "M",
  consigne,
  recoit,
});

/** Déroulé « Avis indépendants » FICTIF : trois avis qui partent de la demande, puis une synthèse qui les reçoit tous. */
export function demoEquipeFlow(): Flow {
  return {
    version: 1,
    blocs: [
      {
        type: "avis",
        id: "avis",
        avis: [
          etape("clarte", "Clarté", "relire-clarte", "Signale les phrases difficiles à suivre.", "demande"),
          etape("exactitude", "Exactitude", "relire-exactitude", "Vérifie les dates et les numéros de version.", "demande"),
          etape("risques", "Risques", "relire-risques", "Cherche ce qui manque avant la publication.", "demande"),
        ],
        synthese: etape("synthese", "Synthèse", "resumer-avis", "Réunis les avis en une liste de corrections.", "tous"),
      },
    ],
  };
}

/**
 * TOUS les textes libres que la démonstration peut montrer : titre de l'équipe, titres des étapes, titres d'assistants, demande
 * et réponses. Ils sont INVENTÉS. `demo-equipe.test.ts` vérifie que la fixture n'en contient aucun autre : aucun texte réel,
 * aucun chemin, aucun extrait venu d'ailleurs ne peut s'y glisser.
 */
export const DEMO_EQUIPE_TEXTES: readonly string[] = Object.freeze([
  DEMO_EQUIPE_TITRE,
  DEMO_EQUIPE_DEMANDE,
  ...ASSISTANTS.map(([, titre]) => titre),
  ...REPONSES.map((reponse) => reponse.texte),
  "Clarté",
  "Exactitude",
  "Risques",
  "Synthèse",
]);

/** Estimation FIXE de la démonstration : aucun prix réel, aucune lecture d'opencode. */
function estimationDe(stepIds: readonly string[]): FlowEstimate {
  return {
    typique: 0.06 * stepIds.length,
    maximum: 0.2 * stepIds.length,
    plafond: 0.2 * stepIds.length,
    etapesFacturees: stepIds.length,
    depassementUnAppel: 0.02,
    relais: 0,
    parEtape: stepIds.map((stepId) => ({
      stepId,
      titre: stepId,
      assistant: ASSISTANTS[0]?.[0] ?? "",
      model: MODEL,
      modelLabel: MODEL_LABEL,
      niveau: null,
      choisieParEquipe: false,
      typique: 0.06,
      maximum: 0.2,
      source: "profil" as const,
    })),
  };
}

// --- Forme du fichier ---------------------------------------------------------------------------------------------------------

/** Un moment de la démonstration : les faits qu'il AJOUTE et la vue du lancement à cet instant. */
export interface DemoEquipeMoment {
  at: number;
  faits: ActivityFact[];
  run: TeamRunView;
}

/** Contenu de demo-equipe.json. */
export interface DemoEquipeFile {
  version: 1;
  moments: DemoEquipeMoment[];
}

/** Instantané brut : faits CUMULÉS et vue du lancement, relevés à un événement du cockpit. */
export interface DemoEquipeInstantane {
  faits: ActivityFact[];
  run: TeamRunView;
}

// --- Canonisation (pure) ------------------------------------------------------------------------------------------------------

/** Nombre qui est une heure (ms depuis 1970) : au-delà de l'an 2001, jamais un coût ni un rang. */
const estHeure = (valeur: number): boolean => Number.isInteger(valeur) && valeur >= 1_000_000_000_000;

const estObjet = (valeur: unknown): valeur is Record<string, unknown> => typeof valeur === "object" && valeur !== null && !Array.isArray(valeur);

/** Parcourt toutes les valeurs d'une structure JSON, feuilles comprises. */
function parcourir(valeur: unknown, visiter: (feuille: unknown) => void): void {
  visiter(valeur);
  if (Array.isArray(valeur)) for (const element of valeur) parcourir(element, visiter);
  else if (estObjet(valeur)) for (const element of Object.values(valeur)) parcourir(element, visiter);
}

/** Remplace chaque feuille d'une structure JSON ; les objets et les tableaux sont recopiés. */
function remplacer<T>(valeur: T, feuille: (valeur: string | number) => string | number): T {
  if (typeof valeur === "string" || typeof valeur === "number") return feuille(valeur) as T;
  if (Array.isArray(valeur)) return valeur.map((element) => remplacer(element, feuille)) as T;
  if (estObjet(valeur)) return Object.fromEntries(Object.entries(valeur).map(([cle, val]) => [cle, remplacer(val, feuille)])) as T;
  return valeur;
}

/**
 * Identifiants tirés au sort : ceux d'opencode (`ses_`, `msg_`, `prt_`, `per_`) et celui du lancement, que le magasin d'équipes
 * écrit en UUID (`crypto.randomUUID`). Le fichier n'en garde aucun tel quel.
 */
const PREFIXES: ReadonlyArray<readonly [RegExp, string]> = [
  [/^ses_[A-Za-z0-9]+$/, "ses_demo"],
  [/^msg_[A-Za-z0-9]+$/, "msg_demo"],
  [/^prt_[A-Za-z0-9]+$/, "prt_demo"],
  [/^per_[A-Za-z0-9]+$/, "per_demo"],
  [/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/, "run_demo"],
];

/** Préfixe de remplacement d'un identifiant réel, ou null si la chaîne n'en est pas un. */
function prefixeDe(valeur: string): string | null {
  for (const [motif, prefixe] of PREFIXES) if (motif.test(valeur)) return prefixe;
  return null;
}

/**
 * Renomme les identifiants tirés au sort dans leur ordre d'apparition DANS LE FICHIER (`ses_demo_1`, `msg_demo_1`…) : appliquée
 * en dernier, sur la structure déjà ordonnée, elle ne dépend donc pas de l'ordre où l'enregistrement les a vus.
 */
export function renommerIdentifiants<T>(valeur: T): T {
  const noms = new Map<string, string>();
  const comptes = new Map<string, number>();
  parcourir(valeur, (feuille) => {
    if (typeof feuille !== "string" || noms.has(feuille)) return;
    const prefixe = prefixeDe(feuille);
    if (prefixe === null) return;
    const rang = (comptes.get(prefixe) ?? 0) + 1;
    comptes.set(prefixe, rang);
    noms.set(feuille, `${prefixe}_${rang}`);
  });
  return remplacer(valeur, (feuille) => (typeof feuille === "string" ? (noms.get(feuille) ?? feuille) : feuille));
}

/**
 * Jalon d'un instantané : l'état du lancement et celui de chaque étape. C'est la SEULE mesure de l'avancement : deux instantanés
 * de même jalon sont le même moment, et le fichier ne dépend donc ni des millisecondes ni du rythme de la machine.
 */
export function jalonDe(run: TeamRunView): string {
  return `${run.state}|${run.steps.map((step) => `${step.stepId}:${step.state}`).join(",")}`;
}

/** États d'étape qui ne sont plus en attente : l'étape a commencé. */
const ETAPE_COMMENCEE: ReadonlySet<string> = new Set(["en-cours", "attente-accord", "terminee", "echec", "arretee", "interrompue", "plafond"]);
/** États d'étape qui ne bougent plus : l'étape est finie. */
const ETAPE_FINIE: ReadonlySet<string> = new Set(["terminee", "echec", "arretee", "interrompue", "plafond", "non-lancee"]);

/** Premier rang où `predicat` est vrai, ou `defaut`. */
function premierRang(jalons: readonly TeamRunView[], predicat: (run: TeamRunView, rang: number) => boolean, defaut: number): number {
  const rang = jalons.findIndex((run, index) => predicat(run, index));
  return rang === -1 ? defaut : rang;
}

/**
 * Fichier de la démonstration à partir des instantanés bruts, sans aucune horloge :
 * - un MOMENT par jalon distinct (jalonDe), dans l'ordre observé, avec le premier instantané de ce jalon ;
 * - les faits de la liste finale sont répartis par une RÈGLE, jamais par l'instant où ils ont été vus : les faits d'ouverture
 *   d'une session d'étape (avant son premier appel d'IA) vont au moment où l'étape commence, les faits de son appel et de sa fin
 *   au moment où elle finit ; les faits de la conversation gardent le moment où ils sont apparus ;
 * - dans un moment, les faits suivent l'ordre des étapes, puis leur ordre dans leur session ;
 * - chaque heure est celle du moment de sa première apparition ; les faits d'un moment portent l'heure de leur moment.
 * Deux enregistrements qui voient les mêmes étapes dans le même ordre donnent donc le même fichier, à l'octet.
 */
export function canoniserDemoEquipe(bruts: readonly DemoEquipeInstantane[]): DemoEquipeFile {
  const dernier = bruts.at(-1);
  if (!dernier) throw new Error("aucun instantané relevé");

  const retenus: DemoEquipeInstantane[] = [];
  const rangDuJalon = new Map<string, number>();
  for (const instantane of bruts) {
    const jalon = jalonDe(instantane.run);
    if (rangDuJalon.has(jalon)) continue;
    rangDuJalon.set(jalon, retenus.length);
    retenus.push(instantane);
  }
  const jalons = retenus.map((instantane) => instantane.run);
  const heureDuMoment = (rang: number): number => DEMO_EQUIPE_DEBUT + rang * DEMO_EQUIPE_PAS;

  // Rang de chaque session : la conversation d'abord, puis les sessions d'étape dans l'ordre du déroulé.
  const rangSession = new Map<string, number>([[dernier.run.rootId, 0]]);
  const debutEtape = new Map<string, number>();
  const finEtape = new Map<string, number>();
  dernier.run.steps.forEach((step, rang) => {
    if (step.sessionId !== null) rangSession.set(step.sessionId, rang + 1);
    const lire = (index: number) => jalons[index]?.steps.find((candidat) => candidat.stepId === step.stepId)?.state ?? "prevue";
    debutEtape.set(step.stepId, premierRang(jalons, (_, index) => ETAPE_COMMENCEE.has(lire(index)), 0));
    finEtape.set(step.stepId, premierRang(jalons, (_, index) => ETAPE_FINIE.has(lire(index)), jalons.length - 1));
  });
  const etapeDeSession = new Map<string, string>(dernier.run.steps.filter((step) => step.sessionId !== null).map((step) => [step.sessionId as string, step.stepId]));

  /** Moment de première apparition d'un fait dans les instantanés, ramené au rang de son jalon. */
  const apparition = new Map<number, number>();
  bruts.forEach((instantane) => {
    const rang = rangDuJalon.get(jalonDe(instantane.run)) ?? 0;
    for (const fait of instantane.faits) if (typeof fait.id === "number" && !apparition.has(fait.id)) apparition.set(fait.id, rang);
  });

  // Chaque fait à son moment : règle pour les sessions d'étape, apparition observée pour la conversation.
  const parSession = new Map<string, ActivityFact[]>();
  for (const fait of dernier.faits) parSession.set(fait.sessionId, [...(parSession.get(fait.sessionId) ?? []), fait]);
  const place: Array<{ moment: number; session: number; rang: number; fait: ActivityFact }> = [];
  for (const [sessionId, faits] of parSession) {
    const stepId = etapeDeSession.get(sessionId);
    const premierAppel = faits.findIndex((fait) => fait.data.etat === "appel");
    faits.forEach((fait, rang) => {
      const moment =
        stepId === undefined
          ? (apparition.get(fait.id ?? -1) ?? 0)
          : premierAppel !== -1 && rang >= premierAppel
            ? (finEtape.get(stepId) ?? 0)
            : (debutEtape.get(stepId) ?? 0);
      place.push({ moment, session: rangSession.get(sessionId) ?? Number.MAX_SAFE_INTEGER, rang, fait });
    });
  }
  place.sort((a, b) => a.moment - b.moment || a.session - b.session || a.rang - b.rang);

  const premiereApparition = new Map<number, number>();
  retenus.forEach((instantane, rang) => {
    parcourir(instantane.run, (feuille) => {
      if (typeof feuille === "number" && estHeure(feuille) && !premiereApparition.has(feuille)) premiereApparition.set(feuille, rang);
    });
  });
  const heure = (brute: number): number => heureDuMoment(premiereApparition.get(brute) ?? 0);
  // Numéro de fait renuméroté dans l'ordre du fichier : celui du magasin suit l'ordre d'écriture, qui n'est pas reproductible.
  let numero = 0;
  const fichier: DemoEquipeFile = {
    version: 1,
    moments: retenus.map((instantane, rang): DemoEquipeMoment => ({
      at: heureDuMoment(rang),
      // Les faits d'un moment portent l'heure du moment : scene(faits, t) montre exactement ce que ce moment ajoute.
      faits: place.filter((entree) => entree.moment === rang).map((entree) => ({ ...entree.fait, id: ++numero, at: heureDuMoment(rang) })),
      run: remplacer(instantane.run, (valeur) => (typeof valeur === "number" && estHeure(valeur) ? heure(valeur) : valeur)),
    })),
  };
  return renommerIdentifiants(fichier);
}

// --- Écriture -----------------------------------------------------------------------------------------------------------------

/** Texte du fichier : un moment par bloc, faits un par ligne (différences lisibles), fin de ligne finale. */
export function demoEquipeJson(fichier: DemoEquipeFile): string {
  const moments = fichier.moments.map((moment) => {
    const faits = moment.faits.map((fait) => `        ${JSON.stringify(fait)}`).join(",\n");
    return ["    {", `      "at": ${moment.at},`, '      "faits": [', faits, "      ],", `      "run": ${JSON.stringify(moment.run)}`, "    }"].filter((ligne) => ligne !== "").join("\n");
  });
  return ["{", `  "version": ${fichier.version},`, '  "moments": [', moments.join(",\n"), "  ]", "}", ""].join("\n");
}

// --- Enregistrement -----------------------------------------------------------------------------------------------------------

/**
 * Joue la démonstration sur le harnais et le faux opencode, avec l'exécuteur RÉEL de l'itération 4, et rend le fichier canonique.
 * Aucune IA n'est appelée : le faux répond seul, avec les textes fictifs de REPONSES.
 */
export async function genererDemoEquipe(t: TestContext): Promise<DemoEquipeFile> {
  const flow = demoEquipeFlow();
  const ordonnees = planSteps(flow);
  const stepIds = ordonnees.map((planifiee) => planifiee.stepId);
  const estimate = estimationDe(stepIds);

  let plan: RunPlan | null = null;
  let equipe: TeamRow | null = null;
  const preflight: TeamPreflightPort = {
    assistants: async () => new Map(),
    estimate: async () => ({ ok: false, status: 409, code: "a-venir" }),
    // A4 : le pré-lancement n'émet aucune requête ; la démonstration part d'un plan déjà fait.
    check: async (): Promise<PreflightOutcome> => ({ ok: true, plan: plan as RunPlan }),
    recheck: async () => ({ ok: true }),
  };
  const teams: TeamsPort = {
    get: (id) => (equipe && id === equipe.id ? equipe : null),
    estimate: async () => ({ ok: false, status: 409, code: "a-venir" }),
  };
  const guards: TeamGuardsPort = { proxyGuard: async () => null, stopForCap: async () => undefined };
  const runnerModule: EqModule = createTeamRunnerModule({ pollMs: 20, retryMs: 20, usageWaitMs: 1_000 });

  const h = await startCockpit(t, {
    settings: { ui: { mode: "avance" } },
    modules: ["floors", "facts"],
    equipes: ["teams", "teamPreflight", runnerModule],
    eqPorts: { preflight, teams, guards },
  });

  h.fake.setAgents([...h.fake.agents(), ...ASSISTANTS.map(([nom]) => fauxAssistant(nom))]);
  // Titres d'assistants montrés par la carte (item_meta, lecture seule du magasin d'équipes).
  for (const [nom, titre] of ASSISTANTS) {
    h.db
      .prepare("INSERT INTO item_meta (kind, name, title, examples, origin, created_at, updated_at) VALUES ('agents', ?, ?, '[]', 'catalogue', 1, 1)")
      .run(nom, titre);
  }
  for (const reponse of REPONSES) {
    h.fake.scriptWhen((session) => (session.metadata as { etape?: string } | undefined)?.etape === reponse.stepId, {
      text: reponse.texte,
      cost: reponse.cout,
      tokens: { input: 140, output: 60 },
      stepMs: reponse.stepMs,
    });
  }

  const directory = h.fake.directory;
  const snapshot = await h.cockpit.c11.lookup.get(directory);
  const reglesDe = (nom: string): Rule[] => snapshot.agents.find((agent) => agent.name === nom)?.permission ?? [];
  const parId = new Map<string, FlowStep>(
    flow.blocs.flatMap((bloc) => (bloc.type === "avis" ? [...bloc.avis, bloc.synthese] : bloc.type === "etape" ? [bloc.etape] : [])).map((step) => [step.id, step]),
  );
  const etapes: PlannedStep[] = ordonnees.map((planifiee): PlannedStep => {
    const step = parId.get(planifiee.stepId);
    if (!step) throw new Error(`étape absente du déroulé : ${planifiee.stepId}`);
    const agentRules = reglesDe(step.assistant);
    return {
      stepId: planifiee.stepId,
      blocIndex: planifiee.blocIndex,
      ordre: planifiee.ordre,
      titre: step.titre,
      assistant: step.assistant,
      agentRules,
      rulesSha256: sha256(canonicalRules(agentRules)),
      agentFileSha256: null,
      floor: buildFloor("ETAPE", { agentRules, truncateGlob: truncateGlob() }),
      floorSha256: floorHash("ETAPE", { agentRules, truncateGlob: truncateGlob() }),
      droits: [],
      model: MODEL,
      variant: null,
      steps: null,
      taille: "M",
    };
  });

  equipe = {
    id: DEMO_EQUIPE_ID,
    titre: DEMO_EQUIPE_TITRE,
    description: "",
    flow: JSON.stringify(flow),
    origine: "exemple",
    exemple_id: DEMO_EQUIPE_ID,
    exemple_version: 1,
    avance: 0,
    created_at: 1,
    updated_at: 1,
  };
  createTeamStore({ db: h.db }).teams.put({
    id: equipe.id,
    titre: equipe.titre,
    description: "",
    flow,
    origine: "exemple",
    exempleId: DEMO_EQUIPE_ID,
    exempleVersion: 1,
    avance: false,
  });
  plan = {
    flow,
    flowSha256: sha256(JSON.stringify(flow)),
    estimate,
    estimateSha256: "a".repeat(64),
    plafond: estimate.plafond,
    rootId: null,
    directory,
    modeUi: "avance",
    agentConversation: CHAT_AGENT,
    iaConversation: { model: MODEL, variant: null },
    etapes,
  };

  const runner = h.cockpit.equipes.eq.ports.runner as TeamRunner;
  const facts = h.cockpit.c11.ports.facts;
  const bruts: DemoEquipeInstantane[] = [];
  let runId: string | null = null;
  const relever = (): void => {
    if (runId === null) return;
    const run = runner.view(runId);
    if (!run) return;
    bruts.push({ faits: [...facts.since(run.rootId, 0).facts], run: structuredClone(run) });
  };
  // Un relevé par événement du cockpit, après la file de microtâches : la base est écrite quand l'événement part.
  const desabonner = h.hub.subscribe(() => queueMicrotask(relever));
  t.after(desabonner);

  const lance = await h.call("POST", `/api/teams/${equipe.id}/run`, {
    headers: h.headers.mutating,
    body: { directory, rootId: null, demande: DEMO_EQUIPE_DEMANDE, fichiers: [], agentConversation: CHAT_AGENT, estimateSha256: plan.estimateSha256, confirmations: {} },
  });
  if (lance.status !== 202) throw new Error(`lancement refusé : ${lance.status} ${lance.body}`);
  runId = lance.json<TeamRunStarted>().runId;
  relever();

  await until(() => (runner.view(runId as string)?.state === "terminee" ? true : undefined), 20_000);
  // Dernier relevé après la file de microtâches : l'injection du résultat ferme le lancement.
  await new Promise<void>((resolve) => setTimeout(resolve, 60));
  relever();

  const fichier = canoniserDemoEquipe(bruts);
  const fin = fichier.moments.at(-1)?.run;
  if (!fin || fin.state !== "terminee") throw new Error("la démonstration ne se termine pas");
  if (fin.steps.length !== stepIds.length) throw new Error(`${fin.steps.length} étapes relevées pour ${stepIds.length} prévues`);
  return fichier;
}

if (process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const nettoyages: Array<() => unknown> = [];
  const t = { after: (fn: () => unknown) => void nettoyages.push(fn) } as unknown as TestContext;
  try {
    const texte = demoEquipeJson(await genererDemoEquipe(t));
    fs.writeFileSync(DEMO_EQUIPE_FILE, texte, "utf8");
    const fichier = JSON.parse(texte) as DemoEquipeFile;
    console.log(`${path.relative(process.cwd(), DEMO_EQUIPE_FILE)} : ${fichier.moments.length} moments, ${Buffer.byteLength(texte)} octets`);
  } finally {
    for (const nettoyage of nettoyages.reverse()) await nettoyage();
  }
}
