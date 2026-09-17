// Scène de la carte des agents en direct (spécification §5.7.1, §5.7.3, §5.7.4, P12, JP-8, JP-13 ; plan d'exécution, fiche L5a) :
// `scene(faits, t, {zoom, mode})` rend le modèle que dessinent la bande 2D (L5c), la démonstration (L5d) et plus tard la 3D. Le
// direct et le différé passent par cette seule fonction : les faits persistés (`activity_facts`) donnent le même dessin que le flux.
//
// Règles :
// - P12 : aucun signe sans fait. Chaque signe (assistant, faisceau, attente, décision, impulsion, marque d'origine, arrêt, outil
//   compté, tuile, entrée du panneau) porte `faits`, les indices des faits qui le justifient dans la liste reçue. Les stations,
//   les secteurs et les emplacements vides de l'anneau d'outils sont le décor.
// - Positions attribuées une fois, dans l'ordre d'apparition des faits, jamais réorganisées : un fait ajouté ne déplace aucun signe
//   déjà placé. Assistant de la conversation au centre ; secteurs Planifier, Chercher, Conseiller, Exécuter, Vérifier, Autres
//   (assistant inconnu : Autres) ; trois places par secteur et par anneau, puis empilement sur la dernière.
// - Anneau k : k-ième vague de délégations d'une même réponse de l'assistant qui confie. Les délégations d'un même message sont
//   une vague (« en même temps ») ; une délégation sans message connu (raccourci) rejoint la vague en cours tant qu'aucun résultat
//   n'est revenu, sinon en ouvre une ; une sous-délégation prend l'anneau de son parent plus k.
// - Aucune taille ni épaisseur liée à une grandeur (coût, nombre d'appels, durée) : tailles constantes (NEON_TAILLES) ; la scène
//   n'en porte aucune.
// - Mode Simple (défaut, P2) : un seul assistant, ses outils et ses fichiers (la délégation y est refusée, décision n° 4) ; les
//   délégations déjà enregistrées sont comptées sans être dessinées.
// - Arrêt : un fait `statut {cause: "arret"}` (L1c) fige en gris les faisceaux de la réponse arrêtée (en cours, ou terminée par
//   l'arrêt si le fait arrive après : interrompue, ou close depuis `debut`, l'heure du début de l'arrêt), jusqu'au début d'une
//   nouvelle réponse. Aucune autre cause ne fige rien. Toute cause d'arrêt dit « arrete » l'assistant dont la réponse, finie sans
//   erreur, s'est close entre `debut` et le fait (refus d'une demande en attente : aucune interruption).
// - Temps : `t` null = direct (tous les faits) ; sinon, les faits jusqu'au dernier dont l'heure est au plus `t`, dans l'ordre du
//   magasin (une inversion d'heure entre deux faits est bornée par 223 ms, mesure M15). `moments()` donne les coupures nettes.
// - Station « Carnet partagé et plan » : toujours vide hors de la Salle OMO (faits `carnet`, L25).
// Module pur (server/shared) : aucun module node, aucun accès à l'environnement, ni horloge ni aléa.
import type { ActivityFact, MessageOrigin, StatutCause } from "./activity-types.ts";

export type NeonZoom = 2 | 3;
export type NeonMode = "simple" | "avance";
export type NeonSector = "planifier" | "chercher" | "conseiller" | "executer" | "verifier" | "autres";
export type NeonToolCategory = "lire" | "chercher" | "modifier" | "commande" | "confier" | "question";

export const NEON_SECTEURS: readonly NeonSector[] = Object.freeze(["planifier", "chercher", "conseiller", "executer", "verifier", "autres"]);
/** Anneau d'outils du zoom 3, dans l'ordre des emplacements (§5.7.4). */
export const NEON_OUTILS: readonly NeonToolCategory[] = Object.freeze(["lire", "chercher", "modifier", "commande", "confier", "question"]);
/** Assistants intégrés d'opencode 1.18.30 dont le rôle est fixé par opencode ; tout autre assistant va dans « autres ». */
export const SECTEURS_OPENCODE: Readonly<Record<string, NeonSector>> = Object.freeze({ explore: "chercher", plan: "planifier" });

/** Cadre de la bande 2D (§5.7.4). */
export const NEON_CADRE = Object.freeze({ largeur: 560, hauteur: 220 });
/** Tailles, en pixels du cadre : CONSTANTES, jamais liées à une grandeur (§5.7.1). */
export const NEON_TAILLES = Object.freeze({ racine: 16, assistant: 10, station: 10, trait: 2, attente: 9, decision: 7, outil: 12, tuile: 16, detail: 28 });
/** Anneaux dessinés (au-delà, sur le dernier) et places par secteur et par anneau (au-delà, empilées sur la dernière). */
export const NEON_ANNEAUX_DESSINES = 3;
export const NEON_PLACES = 3;
/** Zoom 3 : colonnes de dossiers et tuiles par colonne dessinées ; le reste est compté. */
export const NEON_DOSSIERS_DESSINES = 5;
export const NEON_TUILES_PAR_DOSSIER = 7;

export interface NeonSceneOptions {
  zoom: NeonZoom;
  mode: NeonMode;
  /** Zoom 3 en mode Avancé : session détaillée (délégation dessinée) ; sinon, et toujours en mode Simple, la conversation. */
  focus?: string | null;
  /** Secteur par nom d'assistant (par exemple les rôles lus par la Salle OMO) ; complète SECTEURS_OPENCODE. */
  secteurs?: Readonly<Record<string, NeonSector>>;
}

export interface NeonPoint {
  x: number;
  y: number;
}

/** Indices des faits qui justifient un signe, dans la liste donnée à scene() (P12). */
export type NeonRefs = number[];

export type NeonStationId = "vous" | "copilot" | "carnet";

export interface NeonStation {
  id: NeonStationId;
  position: NeonPoint;
}

export interface NeonSectorView {
  id: NeonSector;
  /** Angle du centre du secteur, en degrés (0 : à droite, 90 : en bas). */
  angle: number;
  etiquette: NeonPoint;
}

export type NeonNodeState = "pas-commence" | "travaille" | "attente-accord" | "termine" | "echec" | "arrete";

export interface NeonNode {
  sessionId: string;
  parentId: string | null;
  role: "conversation" | "delegation";
  agent: string | null;
  /** null pour la conversation, au centre. */
  secteur: NeonSector | null;
  /** 0 pour la conversation ; anneau du parent + k pour la k-ième vague de ses délégations. */
  anneau: number;
  /** Rang dans son secteur et son anneau dessiné ; `empile` : au-delà des places, posé sur la dernière. */
  place: number;
  empile: boolean;
  position: NeonPoint;
  etat: NeonNodeState;
  depuis: number;
  tentative: number | null;
  taches: { faites: number; total: number; faits: NeonRefs } | null;
  memoireResumee: { faits: NeonRefs } | null;
  /** Dernier appel d'IA arrivé : son coût n'est connu qu'à l'arrivée (§5.7.3). */
  dernierAppel: { at: number; cout: number | null; faits: NeonRefs } | null;
  faits: NeonRefs;
}

export type NeonBeamKind = "demande" | "preparation" | "consigne" | "resultat";
export type NeonBeamEnd = "envoyee" | "rendu" | "echec" | "interrompu" | "repos" | "erreur";

export interface NeonBeam {
  id: string;
  kind: NeonBeamKind;
  /** Session de départ, ou « vous » pour une demande. */
  de: string;
  /** Session d'arrivée ; null pour une délégation en préparation (cible pas encore connue). */
  vers: string | null;
  depart: NeonPoint;
  arrivee: NeonPoint | null;
  callId: string | null;
  messageId: string | null;
  /** Délégations lancées par le même message : même anneau, « en même temps ». */
  enMemeTemps: boolean;
  depuis: number;
  /** Faisceau de la réponse arrêtée : figé, en gris. */
  fige: boolean;
  /** Fin déjà vue d'un faisceau figé ; null pour un faisceau vivant ou figé encore ouvert. */
  fin: NeonBeamEnd | null;
  faits: NeonRefs;
}

export interface NeonWait {
  permissionId: string;
  sessionId: string;
  permission: string | null;
  callId: string | null;
  /** Faisceau en préparation qui porte l'attente (délégation), null sinon. */
  faisceau: string | null;
  position: NeonPoint;
  depuis: number;
  faits: NeonRefs;
}

export interface NeonDecision {
  permissionId: string | null;
  sessionId: string;
  signe: "auto" | "refus";
  regle: string | null;
  position: NeonPoint;
  depuis: number;
  faits: NeonRefs;
}

export interface NeonPulse {
  sessionId: string;
  messageId: string;
  depart: NeonPoint;
  arrivee: NeonPoint;
  depuis: number;
  faits: NeonRefs;
}

export type NeonMarkedOrigin = Exclude<MessageOrigin, "demande" | "consigne">;

export interface NeonOriginMark {
  sessionId: string;
  messageId: string;
  origine: NeonMarkedOrigin;
  cas: number;
  position: NeonPoint;
  depuis: number;
  faits: NeonRefs;
}

export interface NeonToolSlot {
  categorie: NeonToolCategory;
  position: NeonPoint;
  enCours: number;
  termines: number;
  echecs: number;
  interrompus: number;
  faits: NeonRefs;
}

export interface NeonTile {
  /** Clé du fichier (pathKey) : le nom se relit dans la partie d'outil `callId`, passé par redactSecrets. */
  fichier: string;
  callId: string;
  position: NeonPoint;
  lu: boolean;
  modifie: boolean;
  refuse: boolean;
  enCours: boolean;
  faits: NeonRefs;
}

export interface NeonFolder {
  /** Clé du dossier (pathKey). */
  dossier: string;
  colonne: number;
  tuiles: NeonTile[];
  /** Tuiles au-delà de la colonne, comptées sans être dessinées. */
  enPlus: number;
}

export interface NeonDetail {
  sessionId: string;
  position: NeonPoint;
  outils: NeonToolSlot[];
  /** Outils hors de l'anneau (liste de tâches, compétences, outils d'extension). */
  autresOutils: Omit<NeonToolSlot, "categorie" | "position">;
  dossiers: NeonFolder[];
  dossiersEnPlus: number;
  panneau: {
    /** « Consigne reçue » : premier message de la délégation, ou votre dernière demande pour la conversation. */
    consigne: { messageId: string; faits: NeonRefs } | null;
    /** « Ce qu'il a fait » : outils terminés et travail confié rendu. */
    actions: { termines: number; faits: NeonRefs };
    /** « Résultat rendu » d'une délégation. */
    resultat: { callId: string; etat: "rendu" | "echec" | "interrompu"; faits: NeonRefs } | null;
    /** Dernière réponse rédigée. */
    reponse: { messageId: string; faits: NeonRefs } | null;
  };
}

export interface NeonScene {
  zoom: NeonZoom;
  mode: NeonMode;
  rootId: string | null;
  stations: NeonStation[];
  /** Station « Carnet partagé et plan » : vide hors de la Salle OMO. */
  carnet: { vide: true; tuiles: [] };
  secteurs: NeonSectorView[];
  noeuds: NeonNode[];
  faisceaux: NeonBeam[];
  attentes: NeonWait[];
  decisions: NeonDecision[];
  impulsions: NeonPulse[];
  origines: NeonOriginMark[];
  arret: { depuis: number; faits: NeonRefs } | null;
  /** Mode Simple : délégations enregistrées mais non dessinées (la liste des acteurs les montre). */
  delegationsMasquees: number;
  detail: NeonDetail | null;
}

// --- Géométrie (constante) --------------------------------------------------------------------------------------------------

const CENTRE: NeonPoint = Object.freeze({ x: 280, y: 110 });
const STATION_POSITIONS: Readonly<Record<NeonStationId, NeonPoint>> = Object.freeze({
  copilot: Object.freeze({ x: 280, y: 10 }),
  vous: Object.freeze({ x: 280, y: 210 }),
  carnet: Object.freeze({ x: 36, y: 16 }),
});
const STATION_ORDER: readonly NeonStationId[] = ["copilot", "vous", "carnet"];
const SECTOR_ANGLES: Readonly<Record<NeonSector, number>> = { planifier: -120, chercher: -60, conseiller: 0, executer: 60, verifier: 120, autres: 180 };
const RING_RX = 80;
const RING_RY = 30;
/** Décalages le long de la tangente, en pixels : NEON_PLACES emplacements par secteur et par anneau. */
const SLOT_OFFSETS: readonly number[] = [0, -26, 26];
const DETAIL_CENTRE: NeonPoint = Object.freeze({ x: 96, y: 110 });
const DETAIL_TOOL_RADIUS = 62;

const round = (v: number) => Math.round(v * 10) / 10;
const rad = (deg: number) => (deg * Math.PI) / 180;
const point = (p: NeonPoint): NeonPoint => ({ x: p.x, y: p.y });

function nodePosition(secteur: NeonSector, anneau: number, place: number): NeonPoint {
  const k = Math.min(Math.max(anneau, 1), NEON_ANNEAUX_DESSINES);
  const a = rad(SECTOR_ANGLES[secteur]);
  const offset = SLOT_OFFSETS[Math.min(place, NEON_PLACES - 1)] ?? 0;
  return {
    x: round(CENTRE.x + RING_RX * k * Math.cos(a) - offset * Math.sin(a)),
    y: round(CENTRE.y + RING_RY * k * Math.sin(a) + offset * Math.cos(a)),
  };
}

function sectorViews(): NeonSectorView[] {
  return NEON_SECTEURS.map((id) => {
    const a = rad(SECTOR_ANGLES[id]);
    const x = Math.min(NEON_CADRE.largeur - 16, Math.max(16, CENTRE.x + RING_RX * 3.35 * Math.cos(a)));
    const y = Math.min(NEON_CADRE.hauteur - 12, Math.max(12, CENTRE.y + RING_RY * 3.35 * Math.sin(a)));
    return { id, angle: SECTOR_ANGLES[id], etiquette: { x: round(x), y: round(y) } };
  });
}

function toolSlotPosition(index: number): NeonPoint {
  const a = rad(-90 + 60 * index);
  return { x: round(DETAIL_CENTRE.x + DETAIL_TOOL_RADIUS * Math.cos(a)), y: round(DETAIL_CENTRE.y + DETAIL_TOOL_RADIUS * Math.sin(a)) };
}

const tilePosition = (column: number, row: number): NeonPoint => ({ x: 230 + 64 * column, y: 28 + 26 * row });

// --- Temps ------------------------------------------------------------------------------------------------------------------

const timeOf = (fact: ActivityFact | undefined): number => (typeof fact?.at === "number" && Number.isFinite(fact.at) ? fact.at : 0);

/** Nombre de faits visibles à `t` : jusqu'au dernier fait dont l'heure est au plus `t`, dans l'ordre du magasin ; tous si null. */
export function visibleCount(facts: readonly ActivityFact[], t: number | null): number {
  if (t === null) return facts.length;
  for (let i = facts.length - 1; i >= 0; i--) if (timeOf(facts[i]) <= t) return i + 1;
  return 0;
}

/**
 * Moments d'une suite de faits (lecteur pas à pas, « 4 / 12 ») : heures t, croissantes, où scene(faits, t) montre exactement un
 * préfixe des faits sans fait postérieur mêlé (coupure nette).
 */
export function moments(facts: readonly ActivityFact[]): number[] {
  const out: number[] = [];
  const suffixMin: number[] = new Array<number>(facts.length + 1).fill(Number.POSITIVE_INFINITY);
  for (let i = facts.length - 1; i >= 0; i--) suffixMin[i] = Math.min(timeOf(facts[i]), suffixMin[i + 1] ?? Number.POSITIVE_INFINITY);
  let prefixMax = Number.NEGATIVE_INFINITY;
  for (let i = 0; i < facts.length; i++) {
    prefixMax = Math.max(prefixMax, timeOf(facts[i]));
    if ((suffixMin[i + 1] ?? Number.POSITIVE_INFINITY) > prefixMax && out.at(-1) !== prefixMax) out.push(prefixMax);
  }
  return out;
}

// --- Construction -----------------------------------------------------------------------------------------------------------

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const str = (v: unknown): string | null => (typeof v === "string" && v !== "" ? v : null);
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const byIndex = (a: number, b: number) => a - b;

const isFact = (fact: unknown): fact is ActivityFact =>
  isRecord(fact) && typeof fact.rootId === "string" && typeof fact.sessionId === "string" && typeof fact.kind === "string" && isRecord(fact.data);

const DECISION_SIGNS: Readonly<Record<string, "auto" | "refus">> = { auto: "auto", "refus-auto": "refus", "refus-interdit": "refus" };
const MARKED_ORIGINS: ReadonlySet<string> = new Set<NeonMarkedOrigin>(["cockpit", "reveil-sans-reponse", "relance-extension", "interne-extension", "interne-opencode", "origine-inconnue"]);
const TOOL_SLOTS: ReadonlySet<string> = new Set(NEON_OUTILS);
/** Natures de faits qui décrivent l'activité d'une session : seules elles font apparaître un assistant. */
const NODE_KINDS: ReadonlySet<string> = new Set(["statut", "origine", "consigne", "resultat", "attente", "reponse", "decision"]);
const RESULT_STATES: Readonly<Record<string, NeonNodeState>> = { rendu: "termine", echec: "echec", interrompu: "arrete" };
/** Causes d'un fait d'arrêt (StatutCause) ; seule « arret » fige des faisceaux. */
const STOP_CAUSES: ReadonlySet<string> = new Set<StatutCause>(["arret", "plafond", "non-controle", "interrompue"]);
const RESULT_PHASES: Readonly<Record<string, string>> = { rendu: "termine", echec: "erreur", interrompu: "interrompu" };

interface Open<T> {
  value: T;
  open: number;
  close: number | null;
}

interface BeamBuild {
  key: string;
  beam: Omit<NeonBeam, "depart" | "arrivee" | "enMemeTemps" | "fige" | "fin">;
  open: number;
  close: number | null;
  fin: NeonBeamEnd | null;
  /** Session dont la fin de réponse ferme le faisceau. */
  owner: string;
  /** Message qui a confié le travail : deux consignes du même groupe sont « en même temps ». */
  group: string | null;
}

/** Vagues de délégations de la réponse en cours d'une session. */
interface Waves {
  count: number;
  current: number | null;
  /** Vague ouverte par une délégation sans message connu, qu'un message peut encore rejoindre. */
  anonymous: number | null;
  resultSince: boolean;
  byMessage: Map<string, number>;
}

interface ToolBuild {
  categorie: string;
  phase: string;
  faits: NeonRefs;
}

interface TileBuild {
  callIds: string[];
  lu: boolean;
  modifie: boolean;
  enCours: Set<string>;
  faits: NeonRefs;
}

interface SessionBuild {
  node: NeonNode;
  created: number;
  working: boolean;
  /** Dernière fin de réponse (repos ou erreur) : indice et heure du fait. */
  ended: { index: number; at: number } | null;
  baseState: NeonNodeState;
  baseSince: number;
  baseRefs: NeonRefs;
  waves: Waves;
  /** Délégations préparées et pas encore envoyées : appel → message. */
  pending: Map<string, string | null>;
  tools: Map<string, ToolBuild>;
  confie: Map<string, ToolBuild>;
  folders: Map<string, Map<string, TileBuild>>;
  consigne: { messageId: string; faits: NeonRefs } | null;
  reponse: { messageId: string; faits: NeonRefs } | null;
  resultat: NeonDetail["panneau"]["resultat"];
  origine: Omit<NeonOriginMark, "position"> | null;
  decision: Open<Omit<NeonDecision, "position">> | null;
}

/** Fait visible en cours de lecture : son indice, son heure et la session qu'il concerne, si un fait antérieur l'a fait connaître. */
interface Step {
  fact: ActivityFact;
  data: ActivityFact["data"];
  index: number;
  at: number;
  session: SessionBuild | undefined;
}

const newWaves = (): Waves => ({ count: 0, current: null, anonymous: null, resultSince: false, byMessage: new Map() });

function waveOfMessage(w: Waves, messageId: string): number {
  const known = w.byMessage.get(messageId);
  if (known !== undefined) return known;
  if (w.anonymous !== null && !w.resultSince) {
    const joined = w.anonymous;
    w.byMessage.set(messageId, joined);
    w.anonymous = null;
    return joined;
  }
  w.count += 1;
  w.byMessage.set(messageId, w.count);
  w.current = w.count;
  w.anonymous = null;
  w.resultSince = false;
  return w.count;
}

function waveOfChild(w: Waves, messageId: string | null): number {
  if (messageId !== null) return waveOfMessage(w, messageId);
  if (w.current !== null && !w.resultSince) return w.current;
  w.count += 1;
  w.current = w.count;
  w.anonymous = w.count;
  w.resultSince = false;
  return w.count;
}

function newSession(node: NeonNode, index: number, at: number): SessionBuild {
  return {
    node,
    created: index,
    working: false,
    ended: null,
    baseState: "pas-commence",
    baseSince: at,
    baseRefs: [index],
    waves: newWaves(),
    pending: new Map(),
    tools: new Map(),
    confie: new Map(),
    folders: new Map(),
    consigne: null,
    reponse: null,
    resultat: null,
    origine: null,
    decision: null,
  };
}

/**
 * Réponses de la conversation, pour borner la réponse qu'un arrêt a interrompue : début de la réponse en cours (ou demande qui
 * l'annonce), dernière réponse finie (heure de fin, et si elle l'a été par une interruption), dernier fait d'arrêt.
 */
class RootResponses {
  #start: number | null = null;
  #pendingDemand: number | null = null;
  #aborted = false;
  #last: { start: number; aborted: boolean; endAt: number } | null = null;
  #stop: { index: number; at: number; boundary: number | null; limit: number | null; ended: boolean } | null = null;

  /** Votre demande : elle ouvre la prochaine réponse si aucune n'est en cours. */
  demand(index: number): void {
    if (this.#start !== null || this.#pendingDemand !== null) return;
    this.#pendingDemand = index;
    if (this.#stop !== null && index > this.#stop.index) this.#stop.limit ??= index;
  }

  /** Début d'une réponse : il termine l'affichage d'un arrêt antérieur. */
  start(index: number): void {
    const start = this.#pendingDemand ?? index;
    this.#start = start;
    this.#pendingDemand = null;
    this.#aborted = false;
    if (this.#stop !== null && index > this.#stop.index && !this.#stop.ended) {
      this.#stop.ended = true;
      this.#stop.limit ??= start;
    }
  }

  end(aborted: boolean, at: number): void {
    if (aborted) this.#aborted = true;
    const start = this.#start ?? this.#pendingDemand;
    if (start !== null) this.#last = { start, aborted: this.#aborted, endAt: at };
    else if (aborted && this.#last !== null) this.#last.aborted = true;
    this.#start = null;
    this.#pendingDemand = null;
  }

  /**
   * Fait d'arrêt : la réponse arrêtée est celle en cours, sinon la demande en attente, sinon la dernière réponse interrompue ou
   * finie entre `debut` (début de l'arrêt, s'il est connu) et le fait : un refus envoyé par l'arrêt clôt le tour sans interruption.
   */
  stopAt(index: number, at: number, debut: number | null): void {
    const last = this.#last;
    const stopped = last !== null && (last.aborted || (debut !== null && last.endAt >= debut && last.endAt <= at)) ? last.start : null;
    this.#stop = { index, at, boundary: this.#start ?? this.#pendingDemand ?? stopped, limit: null, ended: false };
  }

  /** Arrêt encore affiché (aucune réponse n'a commencé depuis), sinon null. */
  shown(): { depuis: number; faits: NeonRefs } | null {
    return this.#stop !== null && !this.#stop.ended ? { depuis: this.#stop.at, faits: [this.#stop.index] } : null;
  }

  /** Vrai si un faisceau ouvert au fait `open` appartient à la réponse arrêtée d'un arrêt encore affiché. */
  freezes(open: number, count: number): boolean {
    const stop = this.#stop;
    return stop !== null && !stop.ended && stop.boundary !== null && open >= stop.boundary && open < (stop.limit ?? count);
  }
}

/** Lecture des faits d'une conversation, dans l'ordre ; `render` rend la scène. */
class SceneBuilder {
  readonly #rootId: string;
  readonly #secteurs: Readonly<Record<string, NeonSector>> | undefined;
  readonly #sessions = new Map<string, SessionBuild>();
  readonly #places = new Map<string, number>();
  readonly #beams: BeamBuild[] = [];
  readonly #beamByKey = new Map<string, BeamBuild>();
  readonly #openBeams = new Set<BeamBuild>();
  readonly #waits = new Map<string, Open<Omit<NeonWait, "position" | "faisceau">>>();
  readonly #pulses = new Map<string, Open<Omit<NeonPulse, "depart" | "arrivee">>>();
  readonly #waitCalls = new Map<string, { callId: string; index: number }>();
  readonly #refused = new Map<string, NeonRefs>();
  readonly #root = new RootResponses();

  constructor(rootId: string, secteurs: Readonly<Record<string, NeonSector>> | undefined) {
    this.#rootId = rootId;
    this.#secteurs = secteurs;
  }

  add(fact: unknown, index: number): void {
    if (!isFact(fact) || fact.rootId !== this.#rootId) return;
    const at = timeOf(fact);
    const data = fact.data;
    // L'assistant de la conversation n'apparaît que sur un fait de son activité (ni affichage, ni choix, ni arrêt seul).
    if (fact.sessionId === this.#rootId && !this.#sessions.has(this.#rootId) && NODE_KINDS.has(fact.kind) && data.cause === undefined) {
      const node = baseNode({ sessionId: this.#rootId, parentId: null, role: "conversation", agent: null, secteur: null, anneau: 0, place: 0, empile: false, position: point(CENTRE) }, at, index);
      this.#sessions.set(this.#rootId, newSession(node, index, at));
    }
    const step: Step = { fact, data, index, at, session: this.#sessions.get(fact.sessionId) };
    switch (fact.kind) {
      case "statut":
        this.#onStatut(step);
        break;
      case "consigne":
        this.#onConsigne(step);
        break;
      case "resultat":
        this.#onResultat(step);
        break;
      case "attente":
        this.#onAttente(step);
        break;
      case "reponse":
        this.#onReponse(step);
        break;
      case "decision":
        this.#onDecision(step);
        break;
      case "origine":
        this.#onOrigine(step);
        break;
      default:
        break;
    }
  }

  // --- Assistants et réponses ---

  #addChild(sessionId: string, parent: SessionBuild, agent: string | null, messageId: string | null, step: Step): void {
    if (this.#sessions.has(sessionId)) return;
    const wanted = agent === null ? undefined : (this.#secteurs?.[agent] ?? SECTEURS_OPENCODE[agent]);
    const secteur = wanted !== undefined && NEON_SECTEURS.includes(wanted) ? wanted : "autres";
    const anneau = parent.node.anneau + waveOfChild(parent.waves, messageId);
    const slotKey = `${secteur}|${Math.min(anneau, NEON_ANNEAUX_DESSINES)}`;
    const place = this.#places.get(slotKey) ?? 0;
    this.#places.set(slotKey, place + 1);
    const position = nodePosition(secteur, anneau, place);
    const node = baseNode({ sessionId, parentId: parent.node.sessionId, role: "delegation", agent, secteur, anneau, place, empile: place >= NEON_PLACES, position }, step.at, step.index);
    this.#sessions.set(sessionId, newSession(node, step.index, step.at));
  }

  #setState(s: SessionBuild, etat: NeonNodeState, step: Step): void {
    s.baseState = etat;
    s.baseSince = step.at;
    s.baseRefs = [s.created, step.index];
  }

  #startWork(s: SessionBuild, index: number): void {
    if (s.working) return;
    s.working = true;
    s.waves = newWaves();
    s.pending.clear();
    if (s.node.sessionId === this.#rootId) this.#root.start(index);
  }

  /** Fin d'une réponse de la session (repos ou erreur) : ferme ce qui ne peut plus être en cours. */
  #endWork(s: SessionBuild, step: Step, fin: "repos" | "erreur", aborted: boolean): void {
    const { index, at } = step;
    s.working = false;
    s.ended = { index, at };
    const sessionId = s.node.sessionId;
    for (const build of [...this.#openBeams]) if (build.owner === sessionId) this.#closeBeam(build.key, index, fin);
    for (const wait of this.#waits.values()) if (wait.close === null && wait.value.sessionId === sessionId) wait.close = index;
    if (s.decision !== null && s.decision.close === null) s.decision.close = index;
    for (const [key, pulse] of this.#pulses) {
      if (pulse.value.sessionId !== sessionId) continue;
      pulse.close = index;
      this.#pulses.delete(key);
    }
    if (sessionId === this.#rootId) this.#root.end(aborted, at);
  }

  /**
   * Fait d'arrêt de la conversation (L1c) : « arret » fige la réponse arrêtée ; toute cause d'arrêt dit « arrete » un assistant
   * dont la réponse, finie sans erreur, s'est close entre le début de l'arrêt (`debut`) et le fait (refus d'une demande en attente).
   */
  #onStop(step: Step): void {
    const { data, fact, index, at } = step;
    const debut = num(data.debut);
    if (data.cause === "arret") this.#root.stopAt(index, at, debut);
    if (debut === null || fact.sessionId !== this.#rootId || !STOP_CAUSES.has(String(data.cause))) return;
    for (const s of this.#sessions.values()) {
      if (s.working || s.baseState !== "termine" || s.ended === null || s.ended.at < debut || s.ended.at > at) continue;
      s.baseState = "arrete";
      s.baseRefs = [s.created, s.ended.index, index];
    }
  }

  #openBeam(beam: BeamBuild["beam"], owner: string, index: number, group: string | null): void {
    const key = `${beam.kind}|${beam.de}|${beam.callId ?? beam.messageId ?? ""}`;
    if (this.#beamByKey.has(key)) return;
    const build: BeamBuild = { key, beam, open: index, close: null, fin: null, owner, group };
    this.#beams.push(build);
    this.#beamByKey.set(key, build);
    this.#openBeams.add(build);
  }

  #closeBeam(key: string, index: number, fin: NeonBeamEnd): void {
    const build = this.#beamByKey.get(key);
    if (!build || build.close !== null) return;
    build.close = index;
    build.fin = fin;
    build.beam.faits.push(index);
    this.#openBeams.delete(build);
  }

  // --- Faits ---

  #onStatut(step: Step): void {
    const { data, session: s } = step;
    if (data.cause !== undefined) {
      this.#onStop(step);
      return;
    }
    if (data.etat === "creee") {
      this.#onCreated(step);
      return;
    }
    if (s === undefined) return;
    switch (data.etat) {
      case "occupee":
        if (!s.working) this.#setState(s, "travaille", step);
        this.#startWork(s, step.index);
        break;
      case "nouvelle-tentative":
        this.#setState(s, "travaille", step);
        this.#startWork(s, step.index);
        s.node.tentative = num(data.tentative);
        break;
      case "repos":
        // Un repos qui suit une erreur ou une interruption ne les masque pas.
        if (s.working || (s.baseState !== "arrete" && s.baseState !== "echec")) this.#setState(s, "termine", step);
        s.node.tentative = null;
        this.#endWork(s, step, "repos", false);
        break;
      case "erreur": {
        const aborted = data.erreur === "MessageAbortedError";
        this.#setState(s, aborted ? "arrete" : "echec", step);
        s.node.tentative = null;
        this.#endWork(s, step, "erreur", aborted);
        break;
      }
      default:
        this.#onDetail(s, step);
    }
  }

  #onCreated(step: Step): void {
    const { data, fact, session: s } = step;
    if (data.role === "conversation" && s !== undefined && fact.sessionId === this.#rootId) s.node.agent ??= str(data.agent);
    const parent = this.#sessions.get(str(data.parent) ?? "");
    if (data.role !== "delegation" || parent === undefined) return;
    // Création avant l'envoi : la délégation appartient au message de la dernière préparation non envoyée.
    const pending = [...parent.pending.values()].at(-1) ?? null;
    this.#addChild(fact.sessionId, parent, str(data.agent), pending, step);
  }

  /** Mémoire résumée, tâches, appels d'IA, rédaction et outils d'une session dessinée. */
  #onDetail(s: SessionBuild, step: Step): void {
    const { data, index, at } = step;
    const sessionId = s.node.sessionId;
    const messageId = str(data.messageId);
    switch (data.etat) {
      case "memoire-resumee":
        s.node.memoireResumee = { faits: [index] };
        break;
      case "taches": {
        const faites = num(data.faites);
        const total = num(data.total);
        s.node.taches = faites !== null && total !== null ? { faites, total, faits: [index] } : null;
        break;
      }
      case "appel":
        if (messageId !== null && !this.#pulses.has(`${sessionId}|${messageId}`)) {
          this.#pulses.set(`${sessionId}|${messageId}`, { value: { sessionId, messageId, depuis: at, faits: [index] }, open: index, close: null });
        }
        break;
      case "appel-fini": {
        const key = `${sessionId}|${messageId}`;
        const pulse = this.#pulses.get(key);
        if (pulse) {
          pulse.close = index;
          this.#pulses.delete(key);
        }
        s.node.dernierAppel = { at, cout: num(data.cout), faits: pulse ? [pulse.open, index] : [index] };
        break;
      }
      case "redige":
        if (messageId !== null) s.reponse = { messageId, faits: [index] };
        break;
      case "outil":
        recordTool(s, data, index);
        break;
      default:
        break;
    }
  }

  #onConsigne(step: Step): void {
    const { data, index, at, session: s } = step;
    const callId = str(data.callId);
    const messageId = str(data.messageId);
    if (s === undefined || callId === null) return;
    const sessionId = s.node.sessionId;
    if (data.etat === "prepare") {
      if (messageId !== null) waveOfMessage(s.waves, messageId);
      if (!this.#beamByKey.has(`consigne|${sessionId}|${callId}`)) s.pending.set(callId, messageId);
      this.#openBeam({ id: `preparation:${sessionId}:${callId}`, kind: "preparation", de: sessionId, vers: null, callId, messageId, depuis: at, faits: [index] }, sessionId, index, null);
      return;
    }
    if (data.etat !== "envoyee") return;
    this.#closeBeam(`preparation|${sessionId}|${callId}`, index, "envoyee");
    s.pending.delete(callId);
    const enfant = str(data.enfant);
    if (enfant === null) return;
    this.#addChild(enfant, s, str(data.agent), messageId, step);
    if (messageId !== null) waveOfMessage(s.waves, messageId);
    const group = messageId === null ? null : `${sessionId}|${messageId}`;
    this.#openBeam({ id: `consigne:${sessionId}:${callId}`, kind: "consigne", de: sessionId, vers: enfant, callId, messageId, depuis: at, faits: [index] }, sessionId, index, group);
    s.confie.set(callId, { categorie: "confier", phase: "en-cours", faits: [...(s.confie.get(callId)?.faits ?? []), index] });
  }

  #onResultat(step: Step): void {
    const { data, index, at, session: s } = step;
    const callId = str(data.callId);
    const etat = data.etat === "rendu" || data.etat === "echec" || data.etat === "interrompu" ? data.etat : null;
    if (s === undefined || callId === null || etat === null) return;
    const sessionId = s.node.sessionId;
    s.waves.resultSince = true;
    s.pending.delete(callId);
    this.#closeBeam(`preparation|${sessionId}|${callId}`, index, etat);
    this.#closeBeam(`consigne|${sessionId}|${callId}`, index, etat);
    const confie = s.confie.get(callId);
    if (confie) s.confie.set(callId, { categorie: "confier", phase: RESULT_PHASES[etat] ?? "erreur", faits: [...confie.faits, index] });
    const child = this.#sessions.get(str(data.enfant) ?? "");
    if (child === undefined) return;
    this.#setState(child, RESULT_STATES[etat] ?? "echec", step);
    child.resultat = { callId, etat, faits: [index] };
    if (etat === "interrompu") return;
    const de = child.node.sessionId;
    this.#openBeam({ id: `resultat:${de}:${callId}`, kind: "resultat", de, vers: sessionId, callId, messageId: str(data.messageId), depuis: at, faits: [index] }, sessionId, index, null);
  }

  #onAttente(step: Step): void {
    const { data, fact, index, at, session: s } = step;
    const ref = str(fact.ref);
    if (s === undefined || ref === null || this.#waits.has(ref)) return;
    const callId = str(data.callId);
    this.#waits.set(ref, { value: { permissionId: ref, sessionId: s.node.sessionId, permission: str(data.permission), callId, depuis: at, faits: [index] }, open: index, close: null });
    if (callId !== null) this.#waitCalls.set(ref, { callId, index });
  }

  #onReponse(step: Step): void {
    const { data, fact, index, session: s } = step;
    const ref = str(fact.ref);
    const wait = ref === null ? undefined : this.#waits.get(ref);
    if (wait && wait.close === null) {
      wait.close = index;
      wait.value.faits.push(index);
    }
    if (s !== undefined && data.reponse === "reject") this.#markRefused(s.node.sessionId, ref, index);
  }

  #onDecision(step: Step): void {
    const { data, fact, index, at, session: s } = step;
    const signe = DECISION_SIGNS[String(data.verdict)];
    if (s === undefined || signe === undefined) return;
    // Une décision à la fois par assistant : la dernière remplace la précédente.
    const ref = str(fact.ref);
    s.decision = { value: { permissionId: ref, sessionId: s.node.sessionId, signe, regle: str(data.regle), depuis: at, faits: [index] }, open: index, close: null };
    if (signe === "refus") this.#markRefused(s.node.sessionId, ref, index);
  }

  #onOrigine(step: Step): void {
    const { data, fact, index, at, session: s } = step;
    const messageId = str(data.messageId) ?? str(fact.ref);
    const origine = str(data.origine);
    if (s === undefined || messageId === null || origine === null) return;
    const sessionId = s.node.sessionId;
    if (origine === "demande" && sessionId === this.#rootId) {
      this.#root.demand(index);
      this.#openBeam({ id: `demande:${messageId}`, kind: "demande", de: "vous", vers: sessionId, callId: null, messageId, depuis: at, faits: [index] }, sessionId, index, null);
      s.consigne = { messageId, faits: [index] };
    } else if (origine === "consigne") {
      s.consigne ??= { messageId, faits: [index] };
    } else if (MARKED_ORIGINS.has(origine)) {
      // Une marque à la fois par assistant : la dernière.
      s.origine = { sessionId, messageId, origine: origine as NeonMarkedOrigin, cas: num(data.cas) ?? 7, depuis: at, faits: [index] };
    }
  }

  #markRefused(sessionId: string, permissionId: string | null, index: number): void {
    const wait = permissionId === null ? undefined : this.#waitCalls.get(permissionId);
    if (wait) this.#refused.set(`${sessionId}|${wait.callId}`, [wait.index, index]);
  }

  // --- Rendu ---

  render(out: NeonScene, focus: string | null, count: number): NeonScene {
    const root = this.#sessions.get(this.#rootId);
    out.arret = this.#root.shown();
    if (root === undefined) return out;
    const simple = out.mode === "simple";
    this.#renderBeams(out, simple, count);
    const openWaits = [...this.#waits.values()].filter((wait) => wait.close === null);
    this.#renderSessions(out, simple, openWaits);
    for (const wait of openWaits) {
      if (!this.#shown(wait.value.sessionId, simple)) continue;
      const prep = wait.value.callId === null ? undefined : this.#beamByKey.get(`preparation|${wait.value.sessionId}|${wait.value.callId}`);
      const faisceau = prep?.close === null && !simple ? prep.beam.id : null;
      out.attentes.push({ ...wait.value, faits: [...wait.value.faits], faisceau, position: this.#positionOf(wait.value.sessionId) });
    }
    for (const pulse of this.#pulses.values()) {
      if (!this.#shown(pulse.value.sessionId, simple)) continue;
      out.impulsions.push({ ...pulse.value, faits: [...pulse.value.faits], depart: this.#positionOf(pulse.value.sessionId), arrivee: point(STATION_POSITIONS.copilot) });
    }
    if (out.zoom === 3) {
      // Une session non dessinée (inconnue, ou délégation en mode Simple) : le détail de la conversation.
      const wanted = focus ?? this.#rootId;
      out.detail = buildDetail(this.#shown(wanted, simple) ? (this.#sessions.get(wanted) ?? root) : root, this.#refused);
    }
    return out;
  }

  /** Session dessinée : connue, et la conversation seule en mode Simple. */
  #shown(sessionId: string | null, simple: boolean): boolean {
    return sessionId !== null && (!simple || sessionId === this.#rootId) && this.#sessions.has(sessionId);
  }

  #positionOf(id: string): NeonPoint {
    return id === "vous" ? point(STATION_POSITIONS.vous) : point(this.#sessions.get(id)?.node.position ?? CENTRE);
  }

  #renderBeams(out: NeonScene, simple: boolean, count: number): void {
    const groups = new Map<string, number>();
    for (const build of this.#beams) if (build.group !== null) groups.set(build.group, (groups.get(build.group) ?? 0) + 1);
    for (const build of this.#beams) {
      const { beam } = build;
      // Une préparation envoyée devient une consigne ; une consigne rendue devient un résultat : ni l'une ni l'autre ne se fige.
      const superseded = (beam.kind === "preparation" && build.fin === "envoyee") || (beam.kind === "consigne" && (build.fin === "rendu" || build.fin === "echec"));
      const frozen = !superseded && this.#root.freezes(build.open, count);
      if ((!frozen && build.close !== null) || (simple && beam.kind !== "demande")) continue;
      if (!(beam.de === "vous" || this.#shown(beam.de, simple)) || !(beam.vers === null || this.#shown(beam.vers, simple))) continue;
      out.faisceaux.push({
        ...beam,
        faits: [...beam.faits],
        depart: this.#positionOf(beam.de),
        arrivee: beam.vers === null ? null : this.#positionOf(beam.vers),
        enMemeTemps: build.group !== null && (groups.get(build.group) ?? 0) >= 2,
        fige: frozen,
        fin: frozen ? build.fin : null,
      });
    }
  }

  #renderSessions(out: NeonScene, simple: boolean, openWaits: ReadonlyArray<Open<Omit<NeonWait, "position" | "faisceau">>>): void {
    for (const s of this.#sessions.values()) {
      const sessionId = s.node.sessionId;
      if (!this.#shown(sessionId, simple)) {
        if (s.node.role === "delegation") out.delegationsMasquees += 1;
        continue;
      }
      // Une attente ouverte l'emporte sur l'état de base.
      const wait = openWaits.findLast((candidate) => candidate.value.sessionId === sessionId);
      const position = point(s.node.position);
      out.noeuds.push({
        ...s.node,
        position,
        etat: wait ? "attente-accord" : s.baseState,
        depuis: wait ? wait.value.depuis : s.baseSince,
        faits: wait ? [s.created, wait.open] : [...new Set(s.baseRefs)],
      });
      if (s.decision?.close === null) out.decisions.push({ ...s.decision.value, faits: [...s.decision.value.faits], position: point(position) });
      if (s.origine !== null) out.origines.push({ ...s.origine, faits: [...s.origine.faits], position: point(position) });
    }
  }
}

/**
 * Scène de la conversation des faits (la racine du premier fait valide ; les faits d'une autre racine sont ignorés), à l'heure `t`
 * (null : direct). Aucun appel réseau, aucune écriture, aucune horloge : même entrée, même scène. Un mode inconnu vaut Simple, un
 * zoom inconnu vaut 2.
 */
export function scene(facts: readonly ActivityFact[], t: number | null, options: NeonSceneOptions): NeonScene {
  const zoom: NeonZoom = options.zoom === 3 ? 3 : 2;
  const mode: NeonMode = options.mode === "avance" ? "avance" : "simple";
  const rootId = facts.find(isFact)?.rootId ?? null;
  const out = emptyScene(zoom, mode, rootId);
  const count = visibleCount(facts, t);
  if (count === 0 || rootId === null) return out;
  const builder = new SceneBuilder(rootId, options.secteurs);
  for (let index = 0; index < count; index++) builder.add(facts[index], index);
  return builder.render(out, options.focus ?? null, count);
}

function emptyScene(zoom: NeonZoom, mode: NeonMode, rootId: string | null): NeonScene {
  return {
    zoom,
    mode,
    rootId,
    stations: STATION_ORDER.map((id) => ({ id, position: point(STATION_POSITIONS[id]) })),
    carnet: { vide: true, tuiles: [] },
    secteurs: sectorViews(),
    noeuds: [],
    faisceaux: [],
    attentes: [],
    decisions: [],
    impulsions: [],
    origines: [],
    arret: null,
    delegationsMasquees: 0,
    detail: null,
  };
}

function baseNode(place: Pick<NeonNode, "sessionId" | "parentId" | "role" | "agent" | "secteur" | "anneau" | "place" | "empile" | "position">, at: number, index: number): NeonNode {
  return { ...place, etat: "pas-commence", depuis: at, tentative: null, taches: null, memoireResumee: null, dernierAppel: null, faits: [index] };
}

function recordTool(s: SessionBuild, data: ActivityFact["data"], index: number): void {
  const callId = str(data.callId);
  const categorie = str(data.outil);
  const phase = str(data.phase);
  if (callId === null || categorie === null || phase === null) return;
  s.tools.set(callId, { categorie, phase, faits: [...(s.tools.get(callId)?.faits ?? []), index] });
  const dossier = str(data.dossier);
  const fichier = str(data.fichier);
  if (dossier === null || fichier === null) return;
  let folder = s.folders.get(dossier);
  if (!folder) {
    folder = new Map();
    s.folders.set(dossier, folder);
  }
  let tile = folder.get(fichier);
  if (!tile) {
    tile = { callIds: [], lu: false, modifie: false, enCours: new Set(), faits: [] };
    folder.set(fichier, tile);
  }
  if (!tile.callIds.includes(callId)) tile.callIds.push(callId);
  tile.faits.push(index);
  if (phase === "en-cours") tile.enCours.add(callId);
  else tile.enCours.delete(callId);
  if (phase === "termine" && categorie === "lire") tile.lu = true;
  if (phase === "termine" && categorie === "modifier") tile.modifie = true;
}

function countCall(slot: Omit<NeonToolSlot, "categorie" | "position">, call: ToolBuild, actions: NeonDetail["panneau"]["actions"]): void {
  switch (call.phase) {
    case "en-cours":
      slot.enCours += 1;
      break;
    case "termine":
      slot.termines += 1;
      actions.termines += 1;
      actions.faits.push(...call.faits);
      break;
    case "interrompu":
      slot.interrompus += 1;
      break;
    default:
      slot.echecs += 1;
  }
  slot.faits.push(...call.faits);
}

function buildFolders(s: SessionBuild, refusedCalls: ReadonlyMap<string, NeonRefs>): NeonFolder[] {
  const dossiers: NeonFolder[] = [];
  for (const [dossier, folder] of s.folders) {
    const colonne = dossiers.length;
    if (colonne >= NEON_DOSSIERS_DESSINES) break;
    const tuiles: NeonTile[] = [];
    for (const [fichier, tile] of folder) {
      if (tuiles.length >= NEON_TUILES_PAR_DOSSIER) break;
      const refused = tile.callIds.map((id) => refusedCalls.get(`${s.node.sessionId}|${id}`)).find((refs) => refs !== undefined);
      tuiles.push({
        fichier,
        callId: tile.callIds[0] ?? "",
        position: tilePosition(colonne, tuiles.length),
        lu: tile.lu,
        modifie: tile.modifie,
        refuse: refused !== undefined,
        enCours: tile.enCours.size > 0,
        faits: [...new Set([...tile.faits, ...(refused ?? [])])].sort(byIndex),
      });
    }
    dossiers.push({ dossier, colonne, tuiles, enPlus: folder.size - tuiles.length });
  }
  return dossiers;
}

function buildDetail(s: SessionBuild, refusedCalls: ReadonlyMap<string, NeonRefs>): NeonDetail {
  const outils = NEON_OUTILS.map((categorie, i): NeonToolSlot => ({ categorie, position: toolSlotPosition(i), enCours: 0, termines: 0, echecs: 0, interrompus: 0, faits: [] }));
  const autresOutils: NeonDetail["autresOutils"] = { enCours: 0, termines: 0, echecs: 0, interrompus: 0, faits: [] };
  const actions: NeonDetail["panneau"]["actions"] = { termines: 0, faits: [] };
  for (const call of [...s.tools.values(), ...s.confie.values()]) {
    const slot = TOOL_SLOTS.has(call.categorie) ? outils.find((candidate) => candidate.categorie === call.categorie) : undefined;
    countCall(slot ?? autresOutils, call, actions);
  }
  for (const slot of [...outils, autresOutils]) slot.faits.sort(byIndex);
  actions.faits.sort(byIndex);
  return {
    sessionId: s.node.sessionId,
    position: point(DETAIL_CENTRE),
    outils,
    autresOutils,
    dossiers: buildFolders(s, refusedCalls),
    dossiersEnPlus: Math.max(0, s.folders.size - NEON_DOSSIERS_DESSINES),
    panneau: { consigne: s.consigne, actions, resultat: s.resultat, reponse: s.reponse },
  };
}
