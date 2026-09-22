// Propriétaire : L37a.
// TeamService (spécification §3.13, §5.3 ; plan d'exécution it4, fiche L37a) : équipes, aperçu, estimation (calcul : L37p),
// exemples et groupe de routes « teams » (routes-teams.ts, team-examples.ts).
//
// - ÉCRIVAIN UNIQUE de la table `teams` (D-eq-09), toujours par team-store.ts ; les autres tables ne sont lues ici qu'en lecture
//   seule, par requêtes paramétrées (lancements actifs d'une équipe, dernier lancement, assistants installés).
// - GRAMMAIRE REVALIDÉE PAR LE SERVEUR (C S4) : validateFlow est rejoué à chaque enregistrement, dans le mode courant, quel que
//   soit l'écran qui a envoyé le déroulé.
// - AUCUNE ÉCRITURE VERS OPENCODE hors de l'installation d'un assistant d'exemple (eq.assistants.install), toujours derrière la
//   garde de rechargement posée par routes-teams.ts : install() n'a aucune garde propre (plan §1.1, §4.1.2).
// - Les lectures d'opencode passent par eq.ports.preflight.assistants (L37p), lu au moment de l'appel. Une lecture impossible
//   remonte au onError de http.ts (502 opencode-unreachable) : le cockpit ne suppose jamais une liste d'assistants.
// - L'estimation d'un lancement appartient à L37p : la route la délègue à eq.ports.preflight.estimate (seule route du lancement
//   qui lit opencode, A4/D-eq-17).
//
// ITÉRATION 5b (L45b) : l'aperçu et l'enregistrement passent à `validateFlow` le contexte `methods` (C §5.2), et la forme des
// blocs « relecture » et « aiguillage » (L42a) est reconnue par `flowUtilisable`, sans quoi les exemples qui les emploient
// seraient tenus pour mal formés. `TeamView.forme` garde ses trois valeurs (type de L42a) : une relecture et un aiguillage y
// sont comptés « à la suite », faute d'un nom propre dans ce contrat — la disposition et la liste, elles, les distinguent.
import { CATALOGUE } from "./assistants-catalogue.ts";
import type { EqContext, EqModule, TeamRow, TeamsPort } from "./contracts-eq.ts";
// <c5:methodes-import>
import { METHODS } from "./methods-catalogue.ts";
import { methodIdsIn } from "./shared/methods.ts";
// </c5:methodes-import>
import { errorMessage } from "./log.ts";
import { isAdvanced } from "./mode.ts";
import { registerTeamRoutes } from "./routes-teams.ts";
import type { RightLine, Tier, UiMode } from "./shared/assistant-rules.ts";
import { modelName } from "./shared/assistant-rules.ts";
import { estimateFlow, type FlowEstimateContext, type StepIa } from "./shared/flow-estimate.ts";
import { flowAsList, layoutFlow, rightsUnion } from "./shared/flow-layout.ts";
import { type FlowMethodsContext, validateFlow } from "./shared/flow.ts";
import { FLOW_VERSION, TEAM_ID_RE, TEAM_TEXT_LIMITS } from "./shared/team-limits.ts";
import type {
  Flow,
  FlowEstimate,
  FlowProblem,
  FlowProblemCode,
  FlowRow,
  FlowStep,
  StepAssistant,
  TeamEstimateBody,
  TeamEstimateResponse,
  TeamErrorCode,
  TeamExampleView,
  TeamInstallResponse,
  TeamPreviewResponse,
  TeamsListResponse,
  TeamView,
} from "./shared/team-types.ts";
import { ACTIVE_RUN_STATES, createTeamStore, type TeamStore } from "./team-store.ts";
import { exampleById, exampleFlow, TEAM_EXAMPLES, type TeamExample } from "./team-examples.ts";

/** Refus d'une route d'équipe : un code, jamais une phrase (les phrases sont dans team-texts.ts, écrites par les routes). */
export interface TeamRefusal {
  ok: false;
  /** 502 : refus rendu tel quel par l'estimation de L37p (opencode-injoignable). */
  status: 400 | 403 | 404 | 409 | 422 | 502;
  code: TeamErrorCode;
  details?: Record<string, unknown>;
  problems?: FlowProblem[];
}

const refuse = (status: TeamRefusal["status"], code: TeamErrorCode, extra: Omit<TeamRefusal, "ok" | "status" | "code"> = {}): TeamRefusal => ({
  ok: false,
  status,
  code,
  ...extra,
});

/** Problèmes de la grammaire du mode Simple qui disent « cette équipe est réglée en mode Avancé » (colonne teams.avance). */
const CODES_AVANCE: ReadonlySet<FlowProblemCode> = new Set<FlowProblemCode>(["niveau-avance", "personnalise"]);

/** Moyennes observées prises sur 30 jours (flow-estimate applique seul le seuil OBSERVED_MIN_SAMPLES). */
const OBSERVED_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;

export interface TeamService {
  port: TeamsPort;
  list(): Promise<TeamsListResponse>;
  /** N'écrit RIEN : ni équipe, ni assistant, ni requête d'écriture vers opencode. */
  preview(body: unknown): Promise<{ ok: true; response: TeamPreviewResponse } | TeamRefusal>;
  put(id: string, body: unknown): Promise<{ ok: true; view: TeamView } | TeamRefusal>;
  remove(id: string): { ok: true } | TeamRefusal;
  installExample(id: string): Promise<{ ok: true; response: TeamInstallResponse } | TeamRefusal>;
  /** Délègue le calcul à eq.ports.preflight.estimate (L37p) : seule route du lancement qui lit opencode (A4/D-eq-17). */
  estimate(id: string, body: unknown): Promise<{ ok: true; response: TeamEstimateResponse } | TeamRefusal>;
}

// --- Lecture du corps -------------------------------------------------------------------------------------------------------

const objet = (value: unknown): Record<string, unknown> | null =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;

/** Déroulé reçu d'un client : la forme fine est contrôlée par validateFlow, qui lit un JSON quelconque sans jamais lever. */
function flowOf(value: unknown): Flow | null {
  const source = objet(value);
  if (!source || source.version !== FLOW_VERSION || !Array.isArray(source.blocs)) return null;
  return source as unknown as Flow;
}

function texte(value: unknown, min: number, max: number): string | null {
  return typeof value === "string" && value.length >= min && value.length <= max ? value : null;
}

const TAILLES: ReadonlySet<string> = new Set(["S", "M", "L"]);

function etapeUtilisable(value: unknown): boolean {
  const step = objet(value);
  return (
    step !== null &&
    typeof step.id === "string" &&
    typeof step.titre === "string" &&
    typeof step.assistant === "string" &&
    typeof step.consigne === "string" &&
    TAILLES.has(step.taille as string)
  );
}

/**
 * Déroulé dont la FORME permet les calculs dérivés (planSteps, disposition, liste, droits, estimation), qui supposent un déroulé
 * bien formé : un bloc sans son étape, des avis qui ne sont pas un tableau ou une taille inconnue les feraient lever. La
 * grammaire, elle, reste dans validateFlow, qui lit un JSON quelconque sans jamais lever.
 */
function flowUtilisable(flow: Flow): boolean {
  return flow.blocs.every((bloc) => {
    const brut = bloc as unknown as Record<string, unknown>;
    if (typeof brut.id !== "string") return false;
    if (brut.type === "etape") return etapeUtilisable(brut.etape);
    if (brut.type === "avis") return Array.isArray(brut.avis) && brut.avis.every(etapeUtilisable) && etapeUtilisable(brut.synthese);
    // <c5:formes-5b>
    // Formes de la 5b (L42a) : sans ces deux branches, un déroulé de relecture ou d'aiguillage — celui des exemples
    // « Compte rendu d'incident relu » et « Tri d'une alerte » (L45b) — serait tenu pour mal formé, donc refusé par
    // `PUT /api/teams/:id` (400) et privé de disposition, de liste, de droits et d'estimation.
    if (brut.type === "relecture") return etapeUtilisable(brut.auteur) && etapeUtilisable(brut.relecteur);
    if (brut.type === "aiguillage") {
      const specialistes = Array.isArray(brut.specialistes) && brut.specialistes.every(etapeUtilisable);
      // `synthese` est null quand un seul spécialiste est retenu (la grammaire l'exige à partir de deux).
      return etapeUtilisable(brut.aiguilleur) && specialistes && (brut.synthese === null || etapeUtilisable(brut.synthese));
    }
    // </c5:formes-5b>
    return brut.type === "pause" && typeof brut.message === "string";
  });
}

/** Calculs dérivés d'un déroulé : vides quand sa forme ne les permet pas (la liste des problèmes dit alors ce qui cloche). */
interface FlowDerives {
  estimate: FlowEstimate | null;
  layout: FlowRow[];
  liste: string[];
  droits: RightLine[];
}

const DERIVES_VIDES: FlowDerives = { estimate: null, layout: [], liste: [], droits: [] };

/** Déroulé enregistré, relu de la base ; un JSON illisible donne un déroulé vide, que la grammaire refuse (« vide »). */
function storedFlow(row: TeamRow): Flow {
  try {
    return flowOf(JSON.parse(row.flow)) ?? { version: FLOW_VERSION, blocs: [] };
  } catch {
    return { version: FLOW_VERSION, blocs: [] };
  }
}

// --- Service ----------------------------------------------------------------------------------------------------------------

export function createTeamService(eq: EqContext): TeamService {
  const { c11 } = eq;
  const store: TeamStore = createTeamStore({ db: c11.db });
  const mode = (): UiMode => (isAdvanced(c11.settings) ? "avance" : "simple");
  /** U1/D-eq-13 : en Simple, toute écriture et tout lancement sont fermés tant que EQUIPES_SIMPLE_OUVERTES est faux. */
  const simpleFerme = (): boolean => mode() === "simple" && !eq.simpleOuvertes;

  /**
   * Assistants lus pour l'instance par défaut : les assistants d'une équipe sont globaux (portée Studio), et le dossier d'un
   * lancement n'intervient qu'à l'estimation (L37p). Une lecture impossible remonte à l'appelant (502 par le onError).
   */
  const assistantsMap = (): Promise<ReadonlyMap<string, StepAssistant>> =>
    eq.ports.preflight.assistants(c11.settings.get().chat.defaultDirectory ?? "");

  const niveauDisponible = (niveau: Tier): boolean => {
    const resolution = c11.tiers.resolve(niveau);
    return resolution.model !== null && (resolution.status === "ok" || resolution.status === "secours");
  };

  /** IA d'une étape : niveau résolu en mode Avancé, IA propre de l'assistant sinon (décision n° 3, D-eq-12). */
  const iaDe = (assistants: ReadonlyMap<string, StepAssistant>, courant: UiMode) => (step: FlowStep): StepIa | null => {
    const label = (model: string) => modelName(model, c11.catalog.lite());
    if (step.niveau !== null && courant === "avance") {
      const resolution = c11.tiers.resolve(step.niveau);
      return resolution.model === null ? null : { model: resolution.model, variant: resolution.variant, niveau: step.niveau, label: label(resolution.model) };
    }
    const model = assistants.get(step.assistant)?.model ?? null;
    return model === null ? null : { model, variant: null, niveau: null, label: label(model) };
  };

  const estimateContext = (assistants: ReadonlyMap<string, StepAssistant>, courant: UiMode): FlowEstimateContext => ({
    assistants,
    iaDe: iaDe(assistants, courant),
    prix: (model) => c11.tiers.priceOf(model),
    observe: (assistant, model) => store.observedStepCost(assistant, model, Date.now() - OBSERVED_WINDOW_MS),
    simultanees: c11.settings.get().teams.concurrentSteps,
  });

  // <c5:contexte-methodes>
  /**
   * Contexte `methods` de `validateFlow` (5b, L45b ; conception C §5.2). `flow.ts` est PUR et ne peut pas importer le
   * catalogue : ses appelants le lui passent. Deux vérités, jamais confondues (D-5-07) :
   * - `consigne` : les méthodes ATTACHABLES à une étape, c'est-à-dire celles du catalogue de genre « consigne » ; une méthode
   *   de genre « relecture » (Seconde lecture) n'en est pas une, et une méthode inconnue non plus ;
   * - `parAssistant` : les méthodes DÉJÀ posées dans le FICHIER de l'assistant, lues par `methodIdsIn` — un bloc ajouté ou
   *   retiré à la main dans le Studio compte tout de suite, comme dans `methods-service.ts`.
   * Lecture LOCALE du Studio, en une fois : aucune requête à opencode, aucune écriture.
   */
  const METHODES_CONSIGNE: ReadonlySet<string> = new Set(METHODS.filter((methode) => methode.kind === "consigne").map((methode) => methode.id));
  const AUCUNE_METHODE: ReadonlySet<string> = new Set<string>();

  const contexteMethodes = async (): Promise<FlowMethodsContext> => {
    const parNom = new Map<string, ReadonlySet<string>>();
    try {
      for (const fichier of await c11.studio.list("agents", { type: "global" })) {
        parNom.set(fichier.name, new Set(methodIdsIn(fichier.body).map((methode) => methode.id)));
      }
    } catch (err) {
      // Fichiers illisibles : l'onglet Équipes répond quand même. Le catalogue reste connu (une méthode inconnue est donc
      // toujours refusée) ; ce qui se perd est le seul « déjà appliquée par l'assistant », qui ajoute un refus et n'en retire
      // aucun. La cause technique est journalisée, sans aucun texte d'instantané ni contenu de fichier.
      c11.log.warn("équipes : méthodes des fichiers d'agent illisibles", { error: errorMessage(err) });
    }
    return { consigne: METHODES_CONSIGNE, parAssistant: (nom) => parNom.get(nom) ?? AUCUNE_METHODE };
  };
  // </c5:contexte-methodes>

  const problemesDe = (flow: Flow, assistants: ReadonlyMap<string, StepAssistant>, courant: UiMode, methodes?: FlowMethodsContext): FlowProblem[] =>
    // `methodes` absent : `validateFlow` ne contrôle que le NOMBRE de méthodes d'une étape, sans rien supposer (L42a).
    validateFlow(flow, { assistants: [...assistants.values()], mode: courant, niveauDisponible, pour: "enregistrement", ...(methodes ? { methods: methodes } : {}) });

  /** Noms lisibles des assistants installés (nom technique → titre), pour la disposition et la liste. */
  const nomsDe = (assistants: ReadonlyMap<string, StepAssistant>): ReadonlyMap<string, string> =>
    new Map([...assistants].map(([name, assistant]) => [name, assistant.title]));

  const formeDe = (flow: Flow): TeamView["forme"] => {
    const avis = flow.blocs.some((bloc) => bloc.type === "avis");
    const etapes = flow.blocs.some((bloc) => bloc.type === "etape");
    return avis && etapes ? "mixte" : avis ? "avis" : "a-la-suite";
  };

  /**
   * Disposition, liste, droits et estimation d'un déroulé. `manquant` (un assistant n'est plus installé) laisse l'estimation
   * nulle : une somme qui ignore des étapes dirait un montant faux (P3).
   */
  const derivesDe = (flow: Flow, assistants: ReadonlyMap<string, StepAssistant>, courant: UiMode, manquant: boolean): FlowDerives => {
    if (!flowUtilisable(flow)) return DERIVES_VIDES;
    const noms = nomsDe(assistants);
    return {
      estimate: manquant ? null : estimateFlow(flow, estimateContext(assistants, courant)),
      layout: layoutFlow(flow, noms),
      liste: flowAsList(flow, noms),
      droits: rightsUnion(flow, assistants),
    };
  };

  /** Dernier lancement de l'équipe : date de départ (à défaut, de création) et coût déjà facturé. */
  const dernierLancement = (teamId: string): TeamView["dernierLancement"] => {
    const row = c11.db
      .prepare("SELECT started_at, created_at, cost FROM team_runs WHERE team_id = ? ORDER BY created_at DESC, id DESC LIMIT 1")
      .get(teamId) as { started_at: number | null; created_at: number; cost: number } | undefined;
    return row === undefined ? null : { at: row.started_at ?? row.created_at, cost: row.cost };
  };

  /** Un lancement de cette équipe travaille ou attend (ACTIVE_RUN_STATES du magasin, D-eq-16). */
  const lancementActif = (teamId: string): boolean => {
    const marques = ACTIVE_RUN_STATES.map((_, index) => `:etat${index}`).join(", ");
    const valeurs = Object.fromEntries(ACTIVE_RUN_STATES.map((state, index) => [`etat${index}`, state]));
    const row = c11.db
      .prepare(`SELECT COUNT(*) AS n FROM team_runs WHERE team_id = :team AND state IN (${marques})`)
      .get({ team: teamId, ...valeurs }) as { n: number };
    return row.n > 0;
  };

  /** Assistants installés depuis le catalogue (lecture locale d'item_meta) : identifiant de catalogue → nom de l'agent. */
  const nomsInstalles = (): Map<string, string> => {
    const rows = c11.db
      .prepare("SELECT name, catalog_id FROM item_meta WHERE kind = 'agents' AND catalog_id IS NOT NULL AND title IS NOT NULL ORDER BY name")
      .all() as unknown as Array<{ name: string; catalog_id: string }>;
    const out = new Map<string, string>();
    for (const row of rows) if (!out.has(row.catalog_id)) out.set(row.catalog_id, row.name);
    return out;
  };

  const titreCatalogue = (catalogId: string): string => CATALOGUE.find((entry) => entry.id === catalogId)?.title ?? catalogId;

  const vueDe = (row: TeamRow, assistants: ReadonlyMap<string, StepAssistant>, courant: UiMode, methodes?: FlowMethodsContext): TeamView => {
    const flow = storedFlow(row);
    // « À compléter » : un assistant manque (D-eq-21, aucune 409 à sa suppression) ; « Réglée en mode Avancé » : la grammaire du
    // mode Simple refuse un niveau choisi par l'équipe ou un assistant Personnalisé.
    const simples = problemesDe(flow, assistants, "simple", methodes);
    const manquant = simples.some((probleme) => probleme.code === "assistant-absent");
    const avance = simples.some((probleme) => CODES_AVANCE.has(probleme.code));
    return {
      id: row.id,
      titre: row.titre,
      description: row.description,
      flow,
      forme: formeDe(flow),
      origine: row.origine,
      exempleId: row.exemple_id,
      etat: manquant ? "a-completer" : avance ? "avance" : "ok",
      ...derivesDe(flow, assistants, courant, manquant),
      dernierLancement: dernierLancement(row.id),
    };
  };

  const vueExemple = (example: TeamExample, assistants: ReadonlyMap<string, StepAssistant>, installes: ReadonlyMap<string, string>): TeamExampleView => {
    const flow = exampleFlow(example, installes);
    // Noms lisibles : le titre de l'assistant installé, sinon celui de son entrée du catalogue (l'exemple se lit avant toute
    // installation).
    const noms = new Map(nomsDe(assistants));
    for (const catalogId of example.catalogIds) if (!installes.has(catalogId)) noms.set(catalogId, titreCatalogue(catalogId));
    return {
      id: example.id,
      titre: example.titre,
      description: example.description,
      flow,
      installee: equipeDeLExemple(example.id) !== null,
      assistantsManquants: example.catalogIds.filter((catalogId) => !installes.has(catalogId)).map(titreCatalogue),
      layout: layoutFlow(flow, noms),
      liste: flowAsList(flow, noms),
    };
  };

  /** Équipe déjà installée depuis cet exemple (jamais écrasée), quel que soit son identifiant. */
  const equipeDeLExemple = (exampleId: string): TeamRow | null => store.teams.list().find((row) => row.exemple_id === exampleId) ?? null;

  /** Identifiant libre pour une équipe d'exemple : l'identifiant de l'exemple, sinon suffixé (une équipe existante est gardée). */
  const identifiantLibre = (exampleId: string): string => {
    if (store.teams.get(exampleId) === null) return exampleId;
    for (let suffixe = 2; suffixe < 100; suffixe++) {
      const candidat = `${exampleId}-${suffixe}`;
      if (candidat.length <= 40 && store.teams.get(candidat) === null) return candidat;
    }
    return `${exampleId}-${Date.now().toString(36)}`.slice(0, 40);
  };

  const port: TeamsPort = {
    get: (id) => store.teams.get(id),
    async estimate(teamId, body, courant) {
      // U1/D-eq-13 d'abord : en Simple fermé, la route répond 403 sans rien lire, et sans dire si l'équipe existe.
      if (courant === "simple" && !eq.simpleOuvertes) return { ok: false, status: 403, code: "equipes-simple-fermees" };
      const team = store.teams.get(teamId);
      if (team === null) return { ok: false, status: 404, code: "not-found" };
      return eq.ports.preflight.estimate(team, body, courant);
    },
  };

  return {
    port,

    async list() {
      const courant = mode();
      const [assistants, methodes] = await Promise.all([assistantsMap(), contexteMethodes()]);
      const installes = nomsInstalles();
      return {
        teams: store.teams.list().map((row) => vueDe(row, assistants, courant, methodes)),
        exemples: TEAM_EXAMPLES.map((example) => vueExemple(example, assistants, installes)),
        ouvertesEnSimple: eq.simpleOuvertes,
      };
    },

    async preview(body) {
      const source = objet(body);
      const flow = source === null ? null : flowOf(source.flow);
      if (flow === null) return refuse(400, "invalid", { details: { champ: "flow" } });
      const courant = mode();
      const [assistants, methodes] = await Promise.all([assistantsMap(), contexteMethodes()]);
      const problems = problemesDe(flow, assistants, courant, methodes);
      const manquant = problems.some((probleme) => probleme.code === "assistant-absent");
      // Aucune écriture : l'aperçu ne touche ni la base, ni le catalogue, ni opencode (aucun appel d'install).
      return { ok: true, response: { problems, ...derivesDe(flow, assistants, courant, manquant) } };
    },

    async put(id, body) {
      if (!TEAM_ID_RE.test(id)) return refuse(400, "invalid", { details: { champ: "id" } });
      if (simpleFerme()) return refuse(403, "equipes-simple-fermees");
      const source = objet(body);
      const titre = source === null ? null : texte(source.titre, TEAM_TEXT_LIMITS.titreEquipe.min, TEAM_TEXT_LIMITS.titreEquipe.max);
      const description = source === null ? null : texte(source.description, 0, TEAM_TEXT_LIMITS.description);
      const flow = source === null ? null : flowOf(source.flow);
      if (titre === null || description === null || flow === null || !flowUtilisable(flow)) return refuse(400, "invalid");

      const courant = mode();
      const [assistants, methodes] = await Promise.all([assistantsMap(), contexteMethodes()]);
      // Grammaire revalidée par le serveur dans le mode courant, quel que soit l'écran (C S4). Le contexte `methodes` (5b) en
      // fait partie : une méthode inconnue ou déjà posée dans le fichier de l'assistant est refusée ici, pas seulement à
      // l'écran qui a composé le déroulé.
      const problems = problemesDe(flow, assistants, courant, methodes);
      if (courant === "simple" && problems.some((probleme) => CODES_AVANCE.has(probleme.code))) return refuse(403, "mode-avance");
      const bloquants = problems.filter((probleme) => probleme.bloquant);
      if (bloquants.length > 0) return refuse(422, "equipe-invalide", { problems: bloquants });

      const precedente = store.teams.get(id);
      const avance = problemesDe(flow, assistants, "simple", methodes).some((probleme) => CODES_AVANCE.has(probleme.code));
      const row = store.teams.put({
        id,
        titre,
        description,
        flow,
        origine: precedente?.origine ?? "creee",
        exempleId: precedente?.exemple_id ?? null,
        exempleVersion: precedente?.exemple_version ?? null,
        avance,
      });
      return { ok: true, view: vueDe(row, assistants, courant, methodes) };
    },

    remove(id) {
      if (!TEAM_ID_RE.test(id) || store.teams.get(id) === null) return refuse(404, "not-found");
      if (lancementActif(id)) return refuse(409, "equipe-en-cours");
      store.teams.remove(id);
      return { ok: true };
    },

    async installExample(id) {
      if (simpleFerme()) return refuse(403, "equipes-simple-fermees");
      const example = exampleById(id);
      if (example === null) return refuse(404, "not-found");
      const courant = mode();
      const deja = equipeDeLExemple(example.id);
      if (deja !== null) {
        // Installation idempotente : l'équipe déjà installée (modifiée ou non) est rendue telle quelle, sans aucune écriture —
        // ni fiche, ni assistant, ni équipe. C'est vrai des six exemples, ceux de la 5b comme ceux de l'itération 4.
        const [assistantsDeja, methodesDeja] = await Promise.all([assistantsMap(), contexteMethodes()]);
        return { ok: true, response: { team: vueDe(deja, assistantsDeja, courant, methodesDeja), assistantsInstalles: [] } };
      }

      const installes = nomsInstalles();
      const installesMaintenant: string[] = [];
      for (const catalogId of example.catalogIds) {
        if (installes.has(catalogId)) continue;
        // SEUL appel d'install() du module : la garde de rechargement de la route l'a autorisé (elle est posée avant ce
        // gestionnaire, routes-teams.ts).
        const vue = await eq.assistants.install(catalogId);
        installes.set(catalogId, vue.name);
        installesMaintenant.push(vue.title);
      }

      const flow = exampleFlow(example, installes);
      // Le contexte des méthodes est lu APRÈS les installations : un assistant posé à l'instant a son fichier, donc ses
      // méthodes, comptées comme celles d'un assistant installé de longue date.
      const [assistants, methodes] = await Promise.all([assistantsMap(), contexteMethodes()]);
      const row = store.teams.put({
        id: identifiantLibre(example.id),
        titre: example.titre,
        description: example.description,
        flow,
        origine: "exemple",
        exempleId: example.id,
        exempleVersion: example.version,
        avance: problemesDe(flow, assistants, "simple", methodes).some((probleme) => CODES_AVANCE.has(probleme.code)),
      });
      return { ok: true, response: { team: vueDe(row, assistants, courant, methodes), assistantsInstalles: installesMaintenant } };
    },

    async estimate(id, body) {
      if (!TEAM_ID_RE.test(id)) return refuse(404, "not-found");
      const source = objet(body);
      const directory = source === null ? null : texte(source.directory, 1, 1_000);
      const rootId = source === null ? undefined : source.rootId;
      if (directory === null || !(rootId === null || typeof rootId === "string")) return refuse(400, "invalid");
      const corps: TeamEstimateBody = { directory, rootId: rootId ?? null };
      // Calcul, lectures et instantané : L37p. Le refus qu'il rend (dont 502 opencode-injoignable) est rendu tel quel.
      const outcome = await port.estimate(id, corps, mode());
      return outcome.ok ? { ok: true, response: outcome.response } : refuse(outcome.status, outcome.code, outcome.details === undefined ? {} : { details: outcome.details });
    },
  };
}

export function neutralTeams(): TeamsPort {
  return {
    get: () => null,
    estimate: async () => ({ ok: false, status: 409, code: "a-venir" }),
  };
}

export const teamsModule: EqModule = {
  name: "teams",
  install(reg, eq) {
    const service = createTeamService(eq);
    eq.ports.teams = service.port;
    reg.routes("teams", (app) => registerTeamRoutes(app, eq, service));
  },
};
