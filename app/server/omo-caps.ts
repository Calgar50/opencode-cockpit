// Propriétaire : L22d.
// Plafonds et fin de demande de la Salle OMO (spécification §4.8.2 l.718-732, §4.14.3 l.832, G6 l.1220, JS-11, P5 ; plan 2 bis et
// 2 ter §6 fiche L22d, D-2b-11, D-2b-29) : port `omoCaps` (vide), crochet `beforeBilledSend` de la salle (après l'activation),
// dérivation et abonnement `usage.updated` de la salle. Règles pures : shared/omo-cap.ts (L22a) et shared/omo-limits.ts (T3a).
//
// Ce que la salle ne peut pas empêcher AVANT l'envoi, elle l'arrête APRÈS COUP : les appels internes de l'extension ne passent
// pas par le garde-fou budgétaire (P5). Le dépassement annoncé est d'un appel par session occupée ; aucun montant n'est promis.
//
// 1. MESSAGE DE L'UTILISATEUR (crochet `beforeBilledSend`, instance « omo », rang omoCaps, après omoActivation qui a consommé le
//    jeton) : `ledger.guardRuns` sur l'IA du message, TOUJOURS sans confirmation — dans la salle, un seuil budgétaire n'est
//    jamais confirmé, ni par l'en-tête de confirmation d'un envoi, ni automatiquement. Refus → 409 « budget-mensuel » (phrase de
//    omo-room-texts.ts), rien n'est envoyé, et la demande qui vient d'être ouverte est close (`endRequest`, fin « seuil-mensuel »).
//    Accepté : l'état de garde est remis à « rien de bloqué » (`omoControl.writeGuardState`, guard-state.json) — un plafond de la
//    demande précédente avait bloqué les délégations — et la surveillance de la demande commence.
// 2. PLAFONDS, pour LA demande active (`omoActivation.activeRequest()`, une seule à la fois) :
//    - coût : `usage.updated` de la salle → `ledger.spentSince(racine, début)` ≥ montant saisi → « plafond-cout » ; un montant
//      illisible vaut « atteint » (fermé en cas de doute) ; comparaison en micro-dollars, jamais en flottant brut ;
//    - durée : 60 minutes depuis le début (`OMO_LIMITES.dureeMinutes`), par minuterie et à chaque événement → « plafond-duree » ;
//    - sessions : plus de 30 sessions créées dans la salle pendant la demande (`OMO_LIMITES.sessionsMax`, racine exclue, chaque
//      identifiant compté une fois, toute racine comprise : plus strict) → « plafond-sessions » ;
//    - seuils mensuels 80 % et 100 % franchis pendant la demande → « seuil-mensuel », jamais confirmés automatiquement.
//    Effet, une seule fois par demande : `omoControl.writeGuardState({bloquer: ["task", "call_omo_agent"]})` d'abord (le filet de
//    L24 refuse alors toute nouvelle délégation), puis `omoStop.run(racine, cause)` (stopTreeOmo, L23b). Un échec de l'un
//    n'empêche jamais l'autre ; il est journalisé.
// 3. FIN DE DEMANDE (D-2b-29) : toutes les sessions de la salle au repos depuis `OMO_LIMITES.finDemandeReposS` (15 s), aucune
//    demande d'autorisation en attente, aucune tâche de fond ouverte → `omoActivation.endRequest(racine, "terminee")` puis
//    `omoStop.relaunchAfterRequest(racine)` (relance à neuf, qui tue tout programme resté en arrière-plan). Avant de conclure,
//    le cockpit relit la salle (`GET /session/status`, `GET /permission` par le portillon de la salle) et les faits de L25a
//    (`consigne` « en tâche de fond » sans `resultat`, dans `activity_facts`), plus les délégations en tâche de fond vues dans le
//    flux dont l'enfant n'est pas encore connu ou pas encore au repos. Un doute (lecture impossible, borne atteinte) ne termine
//    jamais la demande : la vérification est refaite 15 s plus tard, et le plafond de durée reste la limite.
//
// Horloge injectée (tests) : aucune variable d'environnement n'est lue ici. `neutralOmoCaps` reste exporté et inchangé : c'est le
// port des tests qui ne déclarent pas ce module. Dans le dépôt, `SALLE_OUVERTE` est fausse : le module n'inscrit RIEN.
import type { Cockpit11, Cockpit11Deps, Cockpit11Module, EventDerivation, ProxyContext, Registrar, UsageUpdatedData } from "./contracts-11.ts";
import { errorMessage } from "./log.ts";
import type { OmoActiveRequest, OmoCapsPort } from "./omo-contracts.ts";
import { OMO_CONTROL_SYSTEM_CLOCK, type OmoControlClock } from "./omo-control.ts";
import type { OcGlobalEvent } from "./opencode.ts";
import type { SessionInstance } from "./shared/activity-types.ts";
import type { Run } from "./shared/assistant-rules.ts";
import type { RequestEnd } from "./shared/autonomy-types.ts";
import { ID_RE } from "./shared/ids.ts";
import { validatePlafond } from "./shared/omo-cap.ts";
import { OMO_GUARD_TOOLS, type OmoGuardTool } from "./shared/omo-control-protocol.ts";
import { OMO_LIMITES } from "./shared/omo-limits.ts";
import { phraseRefusActivation } from "./shared/omo-room-texts.ts";
import type { OmoActivationRefusalCode, OmoStopCause } from "./shared/omo-types.ts";

export function neutralOmoCaps(_deps: Cockpit11Deps): OmoCapsPort {
  return {};
}

// --- Constantes ------------------------------------------------------------------------------------------------------------------

/** Seuils du budget mensuel qui arrêtent la salle quand une demande les franchit (§4.8.2), en pour cent. */
export const OMO_SEUILS_MENSUELS: readonly number[] = Object.freeze([80, 100]);

/** Durée maximale d'une demande (plafond-duree). */
export const OMO_DUREE_MS = OMO_LIMITES.dureeMinutes * 60_000;

/** Repos de toute la salle qui termine une demande (D-2b-29). */
export const OMO_FIN_REPOS_MS = OMO_LIMITES.finDemandeReposS * 1_000;

/**
 * Borne haute passée à `validatePlafond` pour RELIRE un montant déjà accepté à l'activation (L22c le borne par
 * `budget.autonomie.plafondMaxUsd`) : seule la forme est vérifiée ici.
 */
const PLAFOND_RELU_MAX_USD = 1_000_000_000;

/** Borne des faits de L25a lus pour dire qu'aucune tâche de fond n'est ouverte ; au-delà : doute, la demande continue. */
export const OMO_FAITS_FOND_MAX = 20_000;

/** Borne des sessions occupées et des demandes en attente suivies dans la salle ; au-delà : doute, aucune fin de demande. */
export const OMO_SUIVIS_MAX = 10_000;

/** Longueur maximale d'un identifiant d'appel d'outil (même borne que le portillon). */
const CALL_ID_MAX = 512;

// --- Outils ------------------------------------------------------------------------------------------------------------------------

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const idOf = (value: unknown): string | null => (typeof value === "string" && ID_RE.test(value) ? value : null);
const callIdOf = (value: unknown): string | null => (typeof value === "string" && value.length > 0 && value.length <= CALL_ID_MAX ? value : null);

/** Montant saisi relu en micro-dollars ; null s'il est illisible (plafond tenu pour atteint). */
export function plafondEnMicros(plafondUsd: unknown): number | null {
  if (typeof plafondUsd !== "string") return null;
  const lu = validatePlafond(plafondUsd, { plafondMaxUsd: PLAFOND_RELU_MAX_USD, guardRuns: "ok" });
  return lu.ok ? lu.cents * 10_000 : null;
}

/** Dépense en micro-dollars (arrondie au micro-dollar, pour qu'une somme de flottants juste au plafond ne passe pas dessous). */
const enMicros = (usd: number): number => Math.round(usd * 1_000_000);

/**
 * IA du message dans la forme que lit le proxy pour cette route (même règle que `turnModelFromBody` de http.ts, qui a déjà
 * exigé une IA explicite par un 400 « modele-requis » avant les crochets) : `summarize` → providerID et modelID à plat ;
 * `command` → « fournisseur/modèle » ; `prompt_async` → objet. null si la forme n'est pas celle-là.
 */
export function modeleDuMessage(sub: string, body: Record<string, unknown>): { run: Run } | null {
  const action = sub.split("/")[3] ?? "";
  if (action === "summarize") {
    return typeof body.providerID === "string" && typeof body.modelID === "string"
      ? { run: { role: "message", model: `${body.providerID}/${body.modelID}`, variant: null, source: "choix-avance" } }
      : null;
  }
  const model = body.model;
  if (action === "command") {
    return typeof model === "string" && model.indexOf("/") > 0 ? { run: { role: "raccourci", model, variant: null, source: "choix-avance" } } : null;
  }
  return isRecord(model) && typeof model.providerID === "string" && typeof model.modelID === "string"
    ? { run: { role: "message", model: `${model.providerID}/${model.modelID}`, variant: null, source: "choix-avance" } }
    : null;
}

// --- Service -------------------------------------------------------------------------------------------------------------------------

export interface OmoCapsOptions {
  /** Absent : horloge réelle (minuteries sans retenir le processus). Les tests passent une horloge simulée. */
  clock?: OmoControlClock;
}

/** Raison pour laquelle une demande au repos n'est pas encore terminée (journal) ; null : rien ne la retient. */
export type OmoFinDiffereeRaison = "occupee" | "attente" | "tache-de-fond" | "illisible";

export interface OmoCapsService {
  derivation: EventDerivation;
  /** Abonnement `usage.updated` de la salle. */
  onUsage(data: UsageUpdatedData): void;
  /** Crochet `beforeBilledSend` de la salle. */
  beforeBilledSend(ctx: ProxyContext): Promise<Response | null>;
  /** Travaux en cours (arrêt, fin de demande, état de garde) : rend la main quand tous sont finis (tests). */
  settled(): Promise<void>;
  /** Minuteries retirées (arrêt du cockpit, fin d'un test). */
  close(): void;
}

/** Délégation lancée en tâche de fond vue dans le flux : enfant encore inconnu (« pending ») ou pas encore revenu au repos. */
interface TacheDeFond {
  enfant: string | null;
  rendue: boolean;
}

/** Surveillance de LA demande active. */
interface Suivi {
  demande: OmoActiveRequest;
  /** Montant saisi en micro-dollars ; null : illisible, tenu pour atteint. */
  plafondMicros: number | null;
  /** Budget mensuel consommé au début de la demande, en pour cent : un seuil n'arrête que s'il est franchi PENDANT la demande. */
  pourcentDebut: number;
  /** Sessions créées dans la salle pendant la demande (hors racine). */
  sessions: Set<string>;
  /** Délégations en tâche de fond vues dans le flux, par identifiant d'appel. */
  fond: Map<string, TacheDeFond>;
  /** Arrêt déjà demandé (une seule fois par demande). */
  arret: OmoStopCause | null;
  /** Fin de demande déjà lancée. */
  fin: boolean;
  minuterieDuree: unknown;
}

export function createOmoCaps(c11: Cockpit11, options: OmoCapsOptions = {}): OmoCapsService {
  const clock = options.clock ?? OMO_CONTROL_SYSTEM_CLOCK;
  const log = c11.log;
  const faitsFond = c11.db.prepare(
    `SELECT kind, ref, data FROM activity_facts
     WHERE root_id = ? AND at >= ? AND kind IN ('consigne', 'resultat') ORDER BY id LIMIT ?`,
  );

  let suivi: Suivi | null = null;
  /** Sessions de la salle occupées (busy, retry ou état inconnu), toutes racines : la salle entière doit être au repos. */
  const occupees = new Set<string>();
  /** Demandes d'autorisation de la salle en attente (asked sans replied). */
  const attentes = new Set<string>();
  /** Une borne a été atteinte : l'état du flux n'est plus sûr, aucune fin de demande jusqu'à la prochaine relance. */
  let saturee = false;
  let reposDepuis: number | null = null;
  let minuterieRepos: unknown = null;
  let verification = false;
  const enCours = new Set<Promise<void>>();

  const suivre = (travail: Promise<void>): void => {
    const tache = travail.catch((err: unknown) => log.warn("salle : surveillance des plafonds en échec", { error: errorMessage(err) }));
    enCours.add(tache);
    void tache.finally(() => enCours.delete(tache));
  };

  const demandeActive = (): OmoActiveRequest | null => {
    try {
      return c11.ports.omoActivation.activeRequest();
    } catch (err) {
      log.warn("salle : demande active illisible", { error: errorMessage(err) });
      return null;
    }
  };

  const pourcentDuMois = (): number => {
    try {
      return c11.ledger.percentUsed();
    } catch (err) {
      log.warn("salle : budget mensuel illisible", { error: errorMessage(err) });
      return Number.NaN;
    }
  };

  // --- Repos et fin de demande -------------------------------------------------------------------------------------------------

  const annulerRepos = (): void => {
    if (minuterieRepos !== null) clock.clearTimer(minuterieRepos);
    minuterieRepos = null;
  };

  const armerRepos = (ms: number): void => {
    annulerRepos();
    minuterieRepos = clock.setTimer(() => {
      minuterieRepos = null;
      suivre(verifierFin());
    }, Math.max(0, ms));
  };

  /** Arme, garde ou annule l'attente du repos, selon l'état de la salle et de la demande. */
  const gererRepos = (): void => {
    const s = suivi;
    if (s === null || s.arret !== null || s.fin || occupees.size > 0 || attentes.size > 0) {
      annulerRepos();
      reposDepuis = null;
      return;
    }
    if (reposDepuis === null) {
      reposDepuis = clock.now();
      if (!verification) armerRepos(OMO_FIN_REPOS_MS);
    } else if (minuterieRepos === null && !verification) {
      armerRepos(reposDepuis + OMO_FIN_REPOS_MS - clock.now());
    }
  };

  /** Tâche de fond encore ouverte pour la demande : faits de L25a et délégations vues dans le flux. Lève si la base est illisible. */
  const tacheDeFondOuverte = (s: Suivi): boolean => {
    const ouvertes = new Set<string>();
    for (const [callId, tache] of s.fond) if (!tache.rendue) ouvertes.add(callId);
    const lignes = faitsFond.all(s.demande.rootId, s.demande.startedAt, OMO_FAITS_FOND_MAX + 1) as Array<{ kind: string; ref: string | null; data: string }>;
    // Borne atteinte : on ne sait pas tout, donc une tâche peut être ouverte.
    if (lignes.length > OMO_FAITS_FOND_MAX) return true;
    const rendues = new Set<string>();
    for (const ligne of lignes) {
      let data: unknown;
      try {
        data = JSON.parse(ligne.data);
      } catch {
        data = null;
      }
      const callId = callIdOf(ligne.ref) ?? (isRecord(data) ? callIdOf(data.callId) : null);
      if (callId === null) continue;
      if (ligne.kind === "resultat") rendues.add(callId);
      else if (isRecord(data) && data.fond === true && data.etat === "envoyee") ouvertes.add(callId);
    }
    for (const callId of rendues) ouvertes.delete(callId);
    return ouvertes.size > 0;
  };

  /** Ce qui retient encore la demande, relu à la source ; null : rien. */
  const raisonDeContinuer = async (s: Suivi): Promise<OmoFinDiffereeRaison | null> => {
    if (occupees.size > 0) return "occupee";
    if (attentes.size > 0) return "attente";
    if (saturee) return "illisible";
    try {
      if (tacheDeFondOuverte(s)) return "tache-de-fond";
    } catch (err) {
      log.warn("salle : faits des tâches de fond illisibles", { rootId: s.demande.rootId, error: errorMessage(err) });
      return "illisible";
    }
    const gate = c11.instances?.omo?.gate;
    if (!gate) return "illisible";
    const racine = c11.sessions.get(s.demande.rootId);
    const dossier = racine && racine.directory !== "" ? racine.directory : null;
    try {
      const [travail, attente] = await Promise.all([gate.working(dossier), gate.pending(dossier)]);
      if (travail.size > 0) return "occupee";
      if (attente.length > 0) return "attente";
    } catch (err) {
      log.warn("salle : état de la salle illisible avant la fin de demande", { rootId: s.demande.rootId, error: errorMessage(err) });
      return "illisible";
    }
    return null;
  };

  const verifierFin = async (): Promise<void> => {
    const s = actualiser();
    if (s === null || s.arret !== null || s.fin || reposDepuis === null || verification) return;
    const depuis = reposDepuis;
    const reste = depuis + OMO_FIN_REPOS_MS - clock.now();
    if (reste > 0) {
      armerRepos(reste);
      return;
    }
    verification = true;
    let raison: OmoFinDiffereeRaison | null;
    try {
      raison = await raisonDeContinuer(s);
    } finally {
      verification = false;
    }
    // Rien ne doit avoir bougé pendant les lectures : un travail repris, un arrêt, une autre demande.
    if (actualiser() !== s || s.arret !== null || s.fin || reposDepuis !== depuis) {
      gererRepos();
      return;
    }
    if (raison !== null) {
      log.info("salle : fin de demande différée", { rootId: s.demande.rootId, raison });
      armerRepos(OMO_FIN_REPOS_MS);
      return;
    }
    s.fin = true;
    annulerRepos();
    if (s.minuterieDuree !== null) clock.clearTimer(s.minuterieDuree);
    s.minuterieDuree = null;
    const { rootId } = s.demande;
    try {
      c11.ports.omoActivation.endRequest(rootId, "terminee");
    } catch (err) {
      log.warn("salle : demande non close à sa fin", { rootId, error: errorMessage(err) });
    }
    try {
      await c11.ports.omoStop.relaunchAfterRequest(rootId);
    } catch (err) {
      log.warn("salle : relance à neuf de fin de demande en échec", { rootId, error: errorMessage(err) });
    }
    log.info("salle : demande terminée, salle relancée à neuf", { rootId, requestId: s.demande.requestId });
  };

  // --- Plafonds ------------------------------------------------------------------------------------------------------------------

  const ecrireGarde = async (bloquer: readonly OmoGuardTool[], rootId: string): Promise<void> => {
    try {
      await c11.ports.omoControl.writeGuardState({ version: 1, at: clock.now(), bloquer: [...bloquer] });
    } catch (err) {
      log.warn("salle : état de garde non écrit", { rootId, bloquer: bloquer.length, error: errorMessage(err) });
    }
  };

  /** Arrêt de la demande par un plafond : délégations bloquées d'abord, puis stopTreeOmo. Une seule fois par demande. */
  const arreter = (s: Suivi, cause: OmoStopCause): void => {
    if (s.arret !== null || s.fin) return;
    s.arret = cause;
    annulerRepos();
    reposDepuis = null;
    if (s.minuterieDuree !== null) clock.clearTimer(s.minuterieDuree);
    s.minuterieDuree = null;
    const { rootId } = s.demande;
    log.info("salle : plafond atteint, arrêt de la demande (constaté après coup : dépassement possible d'un appel par session occupée)", {
      rootId,
      requestId: s.demande.requestId,
      cause,
    });
    suivre(
      (async () => {
        await ecrireGarde(OMO_GUARD_TOOLS, rootId);
        try {
          await c11.ports.omoStop.run(rootId, cause);
        } catch (err) {
          log.warn("salle : arrêt au plafond en échec", { rootId, cause, error: errorMessage(err) });
        }
      })(),
    );
  };

  const verifierDuree = (s: Suivi): void => {
    if (clock.now() - s.demande.startedAt >= OMO_DUREE_MS) arreter(s, "plafond-duree");
  };

  const verifierCout = (s: Suivi): void => {
    let depense: number;
    try {
      depense = c11.ledger.spentSince(s.demande.rootId, s.demande.startedAt);
    } catch (err) {
      log.warn("salle : dépense de la demande illisible", { rootId: s.demande.rootId, error: errorMessage(err) });
      depense = Number.NaN;
    }
    // Montant ou dépense illisible : le plafond est tenu pour atteint.
    if (s.plafondMicros === null || !Number.isFinite(depense) || enMicros(depense) >= s.plafondMicros) arreter(s, "plafond-cout");
  };

  const verifierSeuils = (s: Suivi): void => {
    const pourcent = pourcentDuMois();
    // Seuil franchi pendant la demande ; un pourcentage illisible vaut « franchi » (fermé en cas de doute).
    if (OMO_SEUILS_MENSUELS.some((seuil) => s.pourcentDebut < seuil && !(pourcent < seuil))) arreter(s, "seuil-mensuel");
  };

  // --- Demande suivie ----------------------------------------------------------------------------------------------------------

  const fermer = (): void => {
    const s = suivi;
    if (s !== null && s.minuterieDuree !== null) clock.clearTimer(s.minuterieDuree);
    suivi = null;
    annulerRepos();
    reposDepuis = null;
  };

  const ouvrir = (demande: OmoActiveRequest): Suivi => {
    const debut = pourcentDuMois();
    const s: Suivi = {
      demande,
      plafondMicros: plafondEnMicros(demande.plafondUsd),
      // Illisible au début : 0, donc tout seuil atteint pendant la demande arrête (plus strict).
      pourcentDebut: Number.isFinite(debut) ? debut : 0,
      sessions: new Set(),
      fond: new Map(),
      arret: null,
      fin: false,
      minuterieDuree: null,
    };
    s.minuterieDuree = clock.setTimer(
      () => {
        s.minuterieDuree = null;
        if (actualiser() === s) verifierDuree(s);
      },
      Math.max(0, demande.startedAt + OMO_DUREE_MS - clock.now()),
    );
    suivi = s;
    log.info("salle : surveillance des plafonds de la demande", { rootId: demande.rootId, requestId: demande.requestId });
    return s;
  };

  /** Demande active relue à chaque fois : une autre demande remplace la surveillance, aucune la retire. */
  const actualiser = (): Suivi | null => {
    const demande = demandeActive();
    if (demande === null || !idOf(demande.rootId) || !Number.isFinite(demande.startedAt)) {
      if (suivi !== null) fermer();
      return null;
    }
    if (suivi !== null && suivi.demande.requestId === demande.requestId && suivi.demande.rootId === demande.rootId) return suivi;
    if (suivi !== null) fermer();
    const s = ouvrir(demande);
    if (s.plafondMicros === null) arreter(s, "plafond-cout");
    verifierDuree(s);
    return s;
  };

  // --- Flux de la salle ------------------------------------------------------------------------------------------------------------

  const ajouterBorne = (ensemble: Set<string>, id: string): void => {
    if (ensemble.has(id)) return;
    if (ensemble.size >= OMO_SUIVIS_MAX) {
      saturee = true;
      return;
    }
    ensemble.add(id);
  };

  const auRepos = (sessionId: string): void => {
    occupees.delete(sessionId);
    const s = suivi;
    if (s === null) return;
    for (const tache of s.fond.values()) if (tache.enfant === sessionId) tache.rendue = true;
  };

  /** Délégation `task` lancée en tâche de fond (JP-3) : suivie jusqu'au repos de son enfant. */
  const noterTacheDeFond = (s: Suivi, p: Record<string, unknown>): void => {
    const part = isRecord(p.part) ? p.part : null;
    if (part === null || part.type !== "tool" || part.tool !== "task") return;
    const state = isRecord(part.state) ? part.state : {};
    const input = isRecord(state.input) ? state.input : {};
    const metadata = isRecord(state.metadata) ? state.metadata : {};
    if (input.run_in_background !== true && metadata.run_in_background !== true) return;
    const callId = callIdOf(part.callID);
    if (callId === null) return;
    const enfant = metadata.sessionId === "pending" ? null : idOf(metadata.sessionId);
    const connue = s.fond.get(callId);
    if (connue === undefined) {
      if (s.fond.size >= OMO_SUIVIS_MAX) saturee = true;
      else s.fond.set(callId, { enfant, rendue: false });
    } else if (connue.enfant === null && enfant !== null) {
      connue.enfant = enfant;
    }
  };

  const compterSession = (s: Suivi, p: Record<string, unknown>): void => {
    const info = isRecord(p.info) ? p.info : {};
    const id = idOf(info.id) ?? idOf(p.sessionID);
    if (id === null || id === s.demande.rootId || s.sessions.has(id)) return;
    s.sessions.add(id);
    if (s.sessions.size > OMO_LIMITES.sessionsMax) arreter(s, "plafond-sessions");
  };

  const observer = (type: string, p: Record<string, unknown>): void => {
    switch (type) {
      case "session.status": {
        const id = idOf(p.sessionID);
        if (id === null) return;
        const etat = isRecord(p.status) ? p.status.type : undefined;
        // Un état inconnu compte comme occupé : la demande ne se termine jamais sur un doute.
        if (etat === "idle") auRepos(id);
        else ajouterBorne(occupees, id);
        return;
      }
      case "session.idle": {
        const id = idOf(p.sessionID);
        if (id !== null) auRepos(id);
        return;
      }
      case "session.deleted": {
        const id = idOf(isRecord(p.info) ? p.info.id : undefined) ?? idOf(p.sessionID);
        if (id !== null) occupees.delete(id);
        return;
      }
      case "permission.asked": {
        const id = idOf(p.id);
        if (id !== null) ajouterBorne(attentes, id);
        return;
      }
      case "permission.replied": {
        const id = idOf(p.requestID);
        if (id !== null) attentes.delete(id);
        return;
      }
      case "global.disposed":
      case "server.instance.disposed":
        // Rechargement de la salle : ses sessions sont arrêtées et ses demandes retirées sans événement (mesure MX1 M14).
        occupees.clear();
        attentes.clear();
        saturee = false;
        return;
      default:
        return;
    }
  };

  const derivation: EventDerivation = {
    name: "omoCaps",
    instances: ["omo"],
    onEvent(global: OcGlobalEvent, origin?: { instance: SessionInstance }): void {
      if (origin?.instance !== "omo") return;
      const event = isRecord(global) ? global.payload : null;
      if (!isRecord(event) || typeof event.type !== "string") return;
      const p = isRecord(event.properties) ? event.properties : {};
      observer(event.type, p);
      const s = actualiser();
      if (s !== null) {
        if (event.type === "session.created") compterSession(s, p);
        else if (event.type === "message.part.updated") noterTacheDeFond(s, p);
        verifierDuree(s);
      }
      gererRepos();
    },
  };

  const onUsage = (data: UsageUpdatedData): void => {
    // Étiquette de l'enveloppe déjà filtrée par app-factory ; la donnée est relue ici par prudence.
    if (isRecord(data) && data.instance !== undefined && data.instance !== "omo") return;
    const s = actualiser();
    if (s === null) return;
    verifierCout(s);
    verifierSeuils(s);
    verifierDuree(s);
    gererRepos();
  };

  // --- Message de l'utilisateur ------------------------------------------------------------------------------------------------

  const refuserEnvoi = (demande: OmoActiveRequest, code: Extract<OmoActivationRefusalCode, "budget-mensuel" | "plafond-invalide">, fin: RequestEnd): Response => {
    try {
      c11.ports.omoActivation.endRequest(demande.rootId, fin);
    } catch (err) {
      log.warn("salle : demande refusée non close", { rootId: demande.rootId, error: errorMessage(err) });
    }
    log.info("salle : envoi refusé par les plafonds, rien n'est parti", { rootId: demande.rootId, code });
    return Response.json({ error: code, message: phraseRefusActivation(code) }, { status: 409 });
  };

  const beforeBilledSend = async (ctx: ProxyContext): Promise<Response | null> => {
    if ((ctx.instance ?? "principale") !== "omo") return null;
    const demande = demandeActive();
    if (demande === null || ctx.sessionId === null) return null;
    const rootId = c11.sessions.rootOf(ctx.sessionId) ?? ctx.sessionId;
    // L'activation (rang précédent) a refusé tout envoi sans demande active de cette racine : rien à garder ici.
    if (rootId !== demande.rootId) return null;
    // guardRuns SANS confirmation (P5, §4.8.2) : l'en-tête de confirmation d'un envoi n'y change rien dans la salle.
    const lu = modeleDuMessage(ctx.sub, ctx.body);
    let refus: unknown;
    try {
      refus = c11.ledger.guardRuns(lu === null ? [] : [lu.run], false, { command: null, modelName: (model) => model, tierOfModel: () => null, size: "M" });
    } catch (err) {
      log.warn("salle : garde-fou budgétaire illisible", { rootId, error: errorMessage(err) });
      refus = true;
    }
    if (refus !== null) return refuserEnvoi(demande, "budget-mensuel", "seuil-mensuel");
    // Montant déjà vérifié à l'activation (L22c) : illisible ici, rien n'est envoyé plutôt qu'une demande sans plafond.
    if (plafondEnMicros(demande.plafondUsd) === null) return refuserEnvoi(demande, "plafond-invalide", "interrompue");
    actualiser();
    // Nouvelle demande : délégations rouvertes (un plafond de la demande précédente les avait bloquées dans guard-state.json).
    await ecrireGarde([], rootId);
    gererRepos();
    return null;
  };

  return {
    derivation,
    onUsage,
    beforeBilledSend,
    async settled() {
      while (enCours.size > 0) await Promise.allSettled([...enCours]);
    },
    close() {
      fermer();
    },
  };
}

/** Pose le crochet d'envoi, la dérivation et l'abonnement de la salle. Rend le service (tests de la fabrique installée). */
export function installOmoCaps(reg: Registrar, c11: Cockpit11, options: OmoCapsOptions = {}): OmoCapsService {
  const service = createOmoCaps(c11, options);
  reg.hook("beforeBilledSend", (ctx) => service.beforeBilledSend(ctx), { instances: ["omo"] });
  reg.derivation(service.derivation);
  reg.hub("usage.updated", (data) => service.onUsage(data), { instances: ["omo"] });
  return service;
}

/**
 * SALLE_OUVERTE fausse (dépôt) : aucune inscription. Ouverte : crochet `beforeBilledSend` (après omoActivation), dérivation
 * (après les faits) et abonnement `usage.updated` de la salle (avant les détections), tous avec `instances: ["omo"]`.
 */
export const omoCapsModule: Cockpit11Module = {
  name: "omoCaps",
  install(reg, c11) {
    if (!c11.salleOuverte) return;
    installOmoCaps(reg, c11);
  },
};
