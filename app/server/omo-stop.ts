// Propriétaire : L23b.
// Arrêt de la Salle OMO (stopTreeOmo, spécification §3.12.1 l.394-407, §4.14.4 l.834-836, §3.5 l.260-264, JS-1, G5 ; plan 2 bis-
// 2 ter, fiche L23b ; D-2b-29, D-2b-30, D-2b-37, D-2b-41 ; M27, M29) : port `omoStop`, crochet `abort` de l'instance de la salle
// et inscription de démarrage (salle trouvée lancée au redémarrage du cockpit).
//
// `stopTreeOmo(racine | null, cause)`, pour « Arrêter », un plafond, une détection ou l'homme mort vu du cockpit, DANS CET ORDRE :
//   0. état publié par le superviseur relu (omoControl.readState, borné) : c'est le démarrage que l'arrêt vise ;
//   1. demande de la salle marquée (omoActivation.endRequest, fin = cause : « arret-demande » de la spécification) ; une activité
//      hors demande est comptée ici, AVANT le stop-request : deux en 10 min et la salle est suspendue, donc la relance qui suit
//      l'arrêt ne reçoit aucun precheck-ok (D-2b-29) ;
//   2. dans la file des réponses DE LA SALLE, refus de TOUTES les attentes de l'instance, chacun inscrit au registre des réponses
//      émises de la salle AVANT l'envoi (P9 : base de la détection 1) ;
//   3. abandon (POST /session/:id/abort) de chaque session occupée de l'instance : la racine d'abord, puis les autres racines de
//      salle, puis le reste ;
//   4. stop-request, écrit par omoControl.requestStop SEUL (L17b y met le startId de l'état lu : la relance à neuf a un autre
//      startId et n'est jamais arrêtée par ce fichier, que rien n'efface ; relecture 2bis-vague-0) ; omo.recreation « demandee » ;
//   5. sonde toutes les 500 ms pendant 15 s au plus : arrêt confirmé quand /global/health ne répond plus (aucune réponse HTTP), ou
//      quand state.json montre la phase « arret » ou un autre démarrage (le superviseur ne publie « arret » qu'après avoir arrêté
//      opencode) ; sinon « arrêt non confirmé » journalisé et battement arrêté : l'homme mort garantit l'arrêt en 30 s ;
//   6. `.omo/boulder.json` de chaque projet ouvert renommé en `.omo/boulder.arrete-{horodatage}.json` par renommerSansSuivreLiens
//      (L19a) : jamais supprimé, jamais écrasé (suffixe en cas de collision) ; un lien sur le chemin → RIEN n'est renommé et le fait
//      est journalisé (D-2b-37, C2-16). Depuis L16c (décision A16), la salle ne peut plus écrire dans `.omo` (racine du projet en
//      lecture seule, `.omo` jamais rouvert en écriture) : un `boulder.json` présent vient du poste, et l'extension de la salle le
//      relirait à sa relance pour reprendre un plan ; c'est pour cela qu'il est mis de côté (G5) ;
//   7. clôture de la ligne `omo_room_starts` du démarrage visé, par `start_id` : `cause`, `ended_at`, `fin` (« arret-confirme » ou
//      « arret-non-confirme ») ; démarrage inconnu → aucune ligne close, fait journalisé (D-2b-21, D-2b-42) ;
//   8. fait « statut » de la racine, `conversation.arretee` (étiqueté « omo » : jamais vu en mode Simple), omo.recreation final.
// Ordre des étapes 2-3 et 4 : OMO_ORDRE_ARRET, « abandon puis stop-request » dans le dépôt. M29 (recette G10, en attente) dira si un
// appel facturé part encore ; si oui, l'ordre s'inverse en une ligne (« arret-puis-abandon » : le processus d'abord).
//
// Ce que ce module ne fait JAMAIS : POST /session/:id/command (ni /stop-continuation, F-x), un nouveau message, une suppression de
// session (un écart de plancher ne supprime rien dans la salle, §3.4), une écriture de configuration, un appel à l'instance
// principale (P6 reste vrai pour elle ; la salle, elle, est relancée à neuf par la sortie de son superviseur, §3.12.1), une autre voie
// de redémarrage que stop-request (OmoControlPort n'en a volontairement aucune, T3a). Routes de la salle appelées : GET /permission,
// POST /permission/:id/reply (« reject » seulement), GET /session/status, POST /session/:id/abort, GET /global/health.
//
// Relance de fin de demande (`relaunchAfterRequest`, D-2b-29 point 3) : stop-request « fin-de-demande », SANS refus, sans abandon,
// sans renommer boulder.json et sans marquer la demande (déjà close par L22d) ; même sonde, même clôture, omo.recreation
// {raison: "fin-de-demande"}. Un arrêt en cours la rend inutile : elle l'attend et n'écrit rien.
//
// Activité hors demande (D-2b-29 point 4) : un arrêt « hors-controle » demandé alors qu'AUCUNE demande n'est active est, par
// définition, une activité de la salle hors demande (L23c appelle `run(null, "hors-controle")`) ; deux en 10 min (OMO_LIMITES) →
// omoControl.suspend("activite-hors-demande"), levée seulement par la réouverture confirmée d'une salle (L18c).
//
// Le service réel n'est construit que si la salle est configurée ET ouverte (SALLE_OUVERTE) : dans le dépôt, le port NEUTRE reste
// en place et le module n'inscrit rien. Délais par horloge injectée (options). `neutralOmoStop` reste exporté et INCHANGÉ : c'est le
// port des tests qui ne déclarent pas ce module (plan §2.2).
import type { DatabaseSync } from "node:sqlite";
import type { Cockpit11, Cockpit11Deps, Cockpit11Module, Cockpit11Ports, PendingPermission, PermissionGate } from "./contracts-11.ts";
import { PortUnavailableError } from "./contracts-11.ts";
import type { EventHub } from "./hub.ts";
import { errorMessage, type Logger } from "./log.ts";
import type { OmoActiveRequest, OmoStopPort } from "./omo-contracts.ts";
import { renommerSansSuivreLiens } from "./omo-precheck-reader.ts";
import { type OpencodeClient, OpencodeError } from "./opencode.ts";
import type { SessionTracker } from "./sessions.ts";
import { assertFact } from "./shared/activity-facts.ts";
import type { ActivityFact, StatutCause } from "./shared/activity-types.ts";
import type { RequestEnd } from "./shared/autonomy-types.ts";
import type { CockpitEventMap, StopResult } from "./shared/cockpit-event-types.ts";
import { ID_RE } from "./shared/ids.ts";
import { OMO_LIMITES } from "./shared/omo-limits.ts";
import type { OmoEventMap, OmoRecreationEtat, OmoRecreationRaison, OmoStopCause, OmoSupervisorState } from "./shared/omo-types.ts";
import { STOP_MAX_REJECTS, STOP_PHASE_BUDGET_MS, STOP_REQUEST_TIMEOUT_MS } from "./stop-tree.ts";

export function neutralOmoStop(_deps: Cockpit11Deps): OmoStopPort {
  return {
    run: () => Promise.reject(new PortUnavailableError("omoStop")),
    // Fin de demande : sans salle, il n'y a rien à relancer (aucun stop-request écrit, D-2b-29).
    relaunchAfterRequest: async () => undefined,
  };
}

// --- Constantes -------------------------------------------------------------------------------------------------------------------

/** Étape 5 : sonde toutes les 500 ms… */
export const OMO_SONDE_INTERVALLE_MS = 500;
/** … pendant 15 s au plus (§3.12.1 point 5) ; au-delà, « arrêt non confirmé » et battement arrêté. */
export const OMO_SONDE_FENETRE_MS = 15_000;
/** Délai d'une sonde GET /global/health : sans réponse HTTP dans ce délai, le serveur de la salle est tenu pour arrêté. */
export const OMO_SONDE_DELAI_MS = 1_000;
/** Dossiers de la salle interrogés au plus (GET /permission, GET /session/status), en plus du dossier par défaut de l'instance. */
export const OMO_ARRET_MAX_DOSSIERS = 50;
/** Sessions abandonnées au plus, pour tout un arrêt. */
export const OMO_ARRET_MAX_SESSIONS = 200;
/** Projets ouverts dont `boulder.json` est mis de côté au plus. */
export const OMO_ARRET_MAX_PROJETS = 200;
/** Carnet de l'extension (4.19.4 : `BOULDER_DIR = ".omo"`, chemin figé sous le projet, mesure L16c §1). */
export const OMO_BOULDER_RELATIF = ".omo/boulder.json";

/** Ordre de l'arrêt (M29) : abandon des sessions puis stop-request, ou l'inverse (le processus d'abord). */
export type OmoOrdreArret = "abandon-puis-arret" | "arret-puis-abandon";

/**
 * Ordre du dépôt : « abandon puis stop-request » (§3.12.1). M29 (recette G10, facturée, en attente) le vérifie : si un appel facturé
 * part encore entre l'abandon et l'arrêt du processus, cette seule ligne passe à « arret-puis-abandon ».
 */
export const OMO_ORDRE_ARRET: OmoOrdreArret = "abandon-puis-arret";

/** Étape 1 : fin écrite sur la demande de la salle ; chaque cause d'arrêt a sa fin (D-2b-41), aucune n'est devinée. */
export const REQUEST_END_OF_OMO_STOP: { readonly [C in OmoStopCause]: RequestEnd } = {
  vous: "vous",
  "plafond-cout": "plafond-cout",
  "plafond-duree": "plafond-duree",
  "plafond-sessions": "plafond-sessions",
  "plafond-tentatives": "plafond-tentatives",
  "seuil-mensuel": "seuil-mensuel",
  "hors-controle": "hors-controle",
  "homme-mort": "homme-mort",
  "redemarrage-cockpit": "redemarrage-cockpit",
};

/**
 * Étape 8 : `data.cause` du fait statut de la racine. La salle est relancée à neuf : « interrompue » quand l'arrêt ne vient ni de
 * vous, ni d'un plafond, ni d'une détection (homme mort, redémarrage du cockpit).
 */
export const STATUT_CAUSE_OF_OMO_STOP: { readonly [C in OmoStopCause]: StatutCause } = {
  vous: "arret",
  "plafond-cout": "plafond",
  "plafond-duree": "plafond",
  "plafond-sessions": "plafond",
  "plafond-tentatives": "plafond",
  "seuil-mensuel": "plafond",
  "hors-controle": "hors-controle",
  "homme-mort": "interrompue",
  "redemarrage-cockpit": "interrompue",
};

/** Fenêtre de la suspension (D-2b-29), en ms : deux activités hors demande à au plus cette distance l'une de l'autre. */
export const OMO_FENETRE_SUSPENSION_MS = OMO_LIMITES.suspension.fenetreMin * 60_000;

/** Nom donné à `boulder.json` mis de côté (§3.12.1 point 6) ; renommerSansSuivreLiens y ajoute un suffixe si le nom est pris. */
export function nomBoulderArrete(at: number): string {
  return `boulder.arrete-${at}.json`;
}

// --- Types ------------------------------------------------------------------------------------------------------------------------

/** Ce que l'arrêt emprunte à l'instance de la salle (`instances.omo`) : son client et son portillon, jamais ceux du cockpit. */
export interface OmoStopInstance {
  client: Pick<OpencodeClient, "request">;
  gate: Pick<PermissionGate, "acquire" | "pending" | "working" | "emitted">;
}

export interface OmoStopDeps {
  /** Instance de la salle, relue à chaque arrêt ; null : aucun client (salle coupée), donc ni refus, ni abandon, ni sonde HTTP. */
  instance: () => OmoStopInstance | null;
  /** Base du cockpit : dossiers des sessions de la salle, clôture d'`omo_room_starts`. */
  db: DatabaseSync;
  sessions: Pick<SessionTracker, "get">;
  hub: Pick<EventHub, "cockpit">;
  log: Pick<Logger, "info" | "warn">;
  /** Dossier de travail (`/workspace`) : base de chaque renommage, jamais quittée (renommerSansSuivreLiens). */
  workspace: string;
  /** Ports en vigueur, relus à CHAQUE appel (jamais en copie) : une surcharge de test ou un port posé plus tard reste pris en compte. */
  ports: () => Pick<Cockpit11Ports, "omoControl" | "omoRoom" | "omoActivation" | "facts">;
}

/** Horloge et réglages injectés (tests) ; absents : horloge réelle, valeurs du dépôt. */
export interface OmoStopOptions {
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  /** Absent : OMO_ORDRE_ARRET. */
  ordre?: OmoOrdreArret;
  sondeIntervalleMs?: number;
  sondeFenetreMs?: number;
}

/** Issue de la sonde de l'étape 5. */
type Sonde = "arret-confirme" | "arret-non-confirme";

// --- Service ---------------------------------------------------------------------------------------------------------------------

const enc = encodeURIComponent;

/** Port `omoStop` réel : un seul arrêt de la salle à la fois (un second appel pendant l'arrêt rend le même résultat). */
export function createOmoStop(deps: OmoStopDeps, options: OmoStopOptions = {}): OmoStopPort {
  const { log } = deps;
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const ordre = options.ordre ?? OMO_ORDRE_ARRET;
  const intervalle = options.sondeIntervalleMs ?? OMO_SONDE_INTERVALLE_MS;
  const fenetre = options.sondeFenetreMs ?? OMO_SONDE_FENETRE_MS;

  let arretEnCours: Promise<StopResult> | null = null;
  let relanceEnCours: Promise<void> | null = null;
  /** Heures des arrêts pour activité hors demande, dans la fenêtre de suspension. */
  const horsDemande: number[] = [];

  const dossiersDeLaSalle = lecteurDesDossiers(deps.db);

  /** Étape 0 : état publié par le superviseur ; une erreur vaut « inconnu » (fermé en cas de doute : aucune clôture devinée). */
  const lireEtat = async (): Promise<OmoSupervisorState | null> => {
    try {
      return await deps.ports().omoControl.readState();
    } catch (err) {
      log.warn("arrêt de la salle : état du superviseur illisible", { error: errorMessage(err) });
      return null;
    }
  };

  const emettreRecreation = (etat: OmoRecreationEtat, raison: OmoRecreationRaison): void => {
    const data: OmoEventMap["omo.recreation"] = { etat, raison };
    deps.hub.cockpit("omo.recreation", data, "omo");
  };

  /** Étape 4 : stop-request par omoControl SEUL ; un échec est journalisé, jamais avalé en silence (l'homme mort reste le filet). */
  const demanderArret = async (raison: OmoRecreationRaison): Promise<void> => {
    try {
      await deps.ports().omoControl.requestStop(raison);
    } catch (err) {
      log.warn("arrêt de la salle : stop-request non écrit", { raison, error: errorMessage(err) });
    }
    emettreRecreation("demandee", raison);
  };

  /**
   * Étape 5, un tour : arrêt confirmé si state.json montre la phase « arret » ou un autre démarrage que celui visé, ou si
   * /global/health ne rend AUCUNE réponse HTTP. Une réponse, même d'erreur, dit qu'un serveur répond encore à l'adresse de la salle.
   */
  const arretConfirme = async (salle: OmoStopInstance | null, startId: string | null): Promise<boolean> => {
    if (startId !== null) {
      const etat = await lireEtat();
      if (etat !== null && (etat.startId !== startId || etat.phase === "arret")) return true;
    }
    if (salle === null) return false;
    try {
      await salle.client.request("GET", "/global/health", { timeoutMs: OMO_SONDE_DELAI_MS });
      return false;
    } catch (err) {
      return !(err instanceof OpencodeError);
    }
  };

  /** Étape 5 : sonde toutes les `intervalle` ms pendant `fenetre` ms au plus ; sinon « arrêt non confirmé » et battement arrêté. */
  const sonder = async (salle: OmoStopInstance | null, startId: string | null, raison: OmoRecreationRaison): Promise<Sonde> => {
    const debut = now();
    let confirme = await arretConfirme(salle, startId);
    while (!confirme && now() - debut < fenetre) {
      await sleep(intervalle);
      confirme = await arretConfirme(salle, startId);
    }
    if (confirme) return "arret-confirme";
    log.warn("arrêt de la salle non confirmé : battement arrêté, l'homme mort l'arrête en 30 s", { raison });
    try {
      deps.ports().omoControl.stopHeartbeat();
    } catch (err) {
      log.warn("arrêt de la salle : battement non arrêté", { error: errorMessage(err) });
    }
    return "arret-non-confirme";
  };

  /** Étape 7 : clôture de la ligne du démarrage visé ; rend le nombre de lignes closes. */
  const cloturer = (startId: string | null, raison: OmoRecreationRaison, fin: Sonde): number => {
    if (startId === null) {
      log.warn("arrêt de la salle : démarrage inconnu, aucune ligne omo_room_starts close", { raison });
      return 0;
    }
    try {
      const resultat = deps.db
        .prepare("UPDATE omo_room_starts SET cause = ?, ended_at = ?, fin = ? WHERE start_id = ? AND ended_at IS NULL")
        .run(raison, now(), fin, startId);
      return Number(resultat.changes);
    } catch (err) {
      log.warn("arrêt de la salle : démarrage non clos", { raison, error: errorMessage(err) });
      return 0;
    }
  };

  /** Étape 6 : boulder.json de chaque projet ouvert mis de côté, sans suivre de lien, sans écraser, sans supprimer. */
  const mettreDeCoteLesBoulders = async (): Promise<void> => {
    let projets: string[];
    try {
      projets = deps.ports().omoRoom.openProjects();
    } catch (err) {
      log.warn("arrêt de la salle : projets ouverts illisibles, aucun boulder.json mis de côté", { error: errorMessage(err) });
      return;
    }
    for (const projet of projets.slice(0, OMO_ARRET_MAX_PROJETS)) {
      const resultat = await renommerSansSuivreLiens(deps.workspace, `${projet}/${OMO_BOULDER_RELATIF}`, nomBoulderArrete(now()));
      if (resultat.ok) {
        log.info("arrêt de la salle : boulder.json mis de côté", { projet, nom: resultat.nom });
      } else if (resultat.raison === "lien-symbolique" || resultat.raison === "hors-base") {
        // Un lien sur le chemin : le suivre ferait renommer au cockpit un fichier hors du projet. Rien n'est renommé.
        log.warn("arrêt de la salle : boulder.json non renommé, un lien est sur son chemin", { projet, raison: resultat.raison });
      } else if (resultat.raison !== "absent") {
        log.warn("arrêt de la salle : boulder.json non renommé", { projet, raison: resultat.raison });
      }
    }
  };

  /** Sessions occupées de la salle (busy ou retry), avec le dossier où chacune a été vue ; `lisible` faux si un état manque. */
  const occupees = async (salle: OmoStopInstance, dossiers: readonly (string | null)[]): Promise<{ ids: Map<string, string | null>; lisible: boolean }> => {
    const ids = new Map<string, string | null>();
    let lisible = true;
    for (const dossier of dossiers) {
      try {
        for (const id of await salle.gate.working(dossier)) if (ID_RE.test(id) && !ids.has(id)) ids.set(id, dossier);
      } catch (err) {
        lisible = false;
        log.warn("arrêt de la salle : états des sessions illisibles", { error: errorMessage(err) });
      }
    }
    return { ids, lisible };
  };

  /**
   * Étapes 2 et 3, dans la file des réponses de la salle : refus de toutes les attentes de l'instance, puis abandon de chaque
   * session occupée, la racine d'abord. La file est tenue jusqu'aux abandons : un « once » qui attendait son tour trouve ensuite
   * une session au repos (refusé par le portillon de la salle).
   */
  const abandonner = async (salle: OmoStopInstance | null, racine: string | null): Promise<{ rejected: number; aborted: string[] }> => {
    if (salle === null) {
      log.warn("arrêt de la salle : aucune instance de la salle, ni refus ni abandon (stop-request et homme mort seuls)");
      return { rejected: 0, aborted: [] };
    }
    const dossiers = dossiersDeLaSalle();
    const aborted: string[] = [];
    let rejected = 0;
    let echeance = now() + STOP_PHASE_BUDGET_MS;
    let sautes = 0;
    /** Délai d'un appel de la phase ; null : échéance passée, l'appel est sauté (au mieux). */
    const delai = (toujours = false): number | null => {
      if (toujours) return STOP_REQUEST_TIMEOUT_MS;
      const reste = echeance - now();
      if (reste > 0) return Math.min(STOP_REQUEST_TIMEOUT_MS, reste);
      sautes++;
      return null;
    };
    const liberer = await salle.gate.acquire();
    try {
      // Échéance comptée depuis la prise de la file : c'est elle que le portillon libère d'office après 30 s.
      echeance = now() + STOP_PHASE_BUDGET_MS;

      // --- 2. Refus de toutes les attentes de l'instance -----------------------------------------------------------------------
      const attentes: Array<PendingPermission & { dossier: string | null }> = [];
      for (const dossier of dossiers) {
        try {
          for (const attente of await salle.gate.pending(dossier)) attentes.push({ ...attente, dossier });
        } catch (err) {
          log.warn("arrêt de la salle : demandes d'autorisation illisibles", { error: errorMessage(err) });
        }
      }
      const refusees = new Set<string>();
      const vues = new Set<string>();
      for (const attente of attentes.filter((a) => ID_RE.test(a.id)).slice(0, STOP_MAX_REJECTS)) {
        if (vues.has(attente.id)) continue;
        vues.add(attente.id);
        const timeoutMs = delai();
        if (timeoutMs === null) break;
        // P9 : inscrite au registre de la SALLE avant l'envoi ; sans message (le tour de la session s'arrête).
        salle.gate.emitted.record({ requestId: attente.id, reply: "reject", by: "cockpit", at: now() });
        try {
          await salle.client.request("POST", `/permission/${enc(attente.id)}/reply`, { query: { directory: attente.dossier }, body: { reply: "reject" }, timeoutMs });
          rejected++;
          refusees.add(attente.sessionID);
        } catch (err) {
          // F-c : refuser une demande refuse aussi les autres demandes de la même session (404 pour les suivantes).
          if (err instanceof OpencodeError && err.status === 404 && refusees.has(attente.sessionID)) {
            rejected++;
            continue;
          }
          log.warn("arrêt de la salle : demande d'autorisation non refusée", { requestId: attente.id, error: errorMessage(err) });
        }
      }

      // --- 3. Abandon de chaque session occupée, la racine d'abord ------------------------------------------------------------
      const { ids } = await occupees(salle, dossiers);
      const estRacineDeSalle = (id: string): boolean => {
        try {
          return deps.ports().omoRoom.isRoomRoot(id);
        } catch {
          return false;
        }
      };
      const autres = [...ids.keys()].filter((id) => id !== racine);
      const cibles = [...(racine === null ? [] : [racine]), ...autres.filter(estRacineDeSalle), ...autres.filter((id) => !estRacineDeSalle(id))].slice(
        0,
        OMO_ARRET_MAX_SESSIONS,
      );
      for (const id of cibles) {
        // La racine est toujours tentée, même après l'échéance ; son dossier est celui où elle a été vue, sinon celui du suivi.
        const toujours = id === racine;
        const timeoutMs = delai(toujours);
        if (timeoutMs === null) continue;
        const dossier = ids.get(id) ?? deps.sessions.get(id)?.directory ?? null;
        try {
          await salle.client.request("POST", `/session/${enc(id)}/abort`, { query: { directory: dossier || null }, timeoutMs });
          aborted.push(id);
        } catch (err) {
          log.warn("arrêt de la salle : session non arrêtée", { sessionId: id, error: errorMessage(err) });
        }
      }
      if (sautes > 0) log.warn("arrêt de la salle : appels sautés, échéance de la file des réponses atteinte", { sautes });
    } finally {
      liberer();
    }
    return { rejected, aborted };
  };

  /** Étape 1 : activité hors demande comptée ; la seconde dans la fenêtre suspend la salle, AVANT le stop-request de cet arrêt. */
  const compterHorsDemande = (at: number): void => {
    while (horsDemande.length > 0 && at - (horsDemande[0] ?? at) > OMO_FENETRE_SUSPENSION_MS) horsDemande.shift();
    horsDemande.push(at);
    if (horsDemande.length < OMO_LIMITES.suspension.detections) return;
    horsDemande.length = 0;
    log.warn("salle suspendue : activité sans demande répétée", { detections: OMO_LIMITES.suspension.detections, fenetreMin: OMO_LIMITES.suspension.fenetreMin });
    try {
      deps.ports().omoControl.suspend("activite-hors-demande");
    } catch (err) {
      log.warn("salle : suspension non posée", { error: errorMessage(err) });
    }
  };

  const arreter = async (demandee: string | null, cause: OmoStopCause): Promise<StopResult> => {
    const debut = now();
    const salle = deps.instance();

    // --- 0. Démarrage visé ----------------------------------------------------------------------------------------------------
    const etatAvant = await lireEtat();
    const startId = etatAvant?.startId ?? null;

    // --- 1. Demande marquée, activité hors demande comptée ------------------------------------------------------------------------
    let active: OmoActiveRequest | null = null;
    try {
      active = deps.ports().omoActivation.activeRequest();
    } catch (err) {
      log.warn("arrêt de la salle : demande active illisible", { error: errorMessage(err) });
    }
    const racine = demandee ?? active?.rootId ?? null;
    // La salle entière s'arrête : c'est la demande en cours (une seule à la fois, D-2b-08) qui prend fin, quelle que soit la racine.
    const aMarquer = active?.rootId ?? demandee;
    if (aMarquer !== null) {
      try {
        deps.ports().omoActivation.endRequest(aMarquer, REQUEST_END_OF_OMO_STOP[cause]);
      } catch (err) {
        log.warn("arrêt de la salle : demande non marquée", { rootId: aMarquer, cause, error: errorMessage(err) });
      }
    }
    if (cause === "hors-controle" && active === null) compterHorsDemande(debut);

    // --- 2, 3 et 4, dans l'ordre choisi (M29) ------------------------------------------------------------------------------------
    let abandon: { rejected: number; aborted: string[] };
    if (ordre === "abandon-puis-arret") {
      abandon = await abandonner(salle, racine);
      await demanderArret(cause);
    } else {
      await demanderArret(cause);
      abandon = await abandonner(salle, racine);
    }

    // --- 5. Sonde -------------------------------------------------------------------------------------------------------------
    const sonde = await sonder(salle, startId, cause);
    let unconfirmed: string[] = [];
    if (sonde === "arret-non-confirme") {
      const restantes = salle === null ? null : await occupees(salle, dossiersDeLaSalle());
      unconfirmed = restantes?.lisible ? [...restantes.ids.keys()] : [...new Set([...(racine === null ? [] : [racine]), ...abandon.aborted])];
    }

    // --- 6. boulder.json de chaque projet ouvert --------------------------------------------------------------------------------
    await mettreDeCoteLesBoulders();

    // --- 7. Clôture du démarrage ------------------------------------------------------------------------------------------------
    cloturer(startId, cause, sonde);

    // --- 8. Fait statut, conversation.arretee, omo.recreation --------------------------------------------------------------------
    if (racine !== null) {
      const fait: ActivityFact = {
        rootId: racine,
        sessionId: racine,
        kind: "statut",
        ref: null,
        data: { cause: STATUT_CAUSE_OF_OMO_STOP[cause], motif: cause, nonConfirmees: unconfirmed.length, debut },
        at: now(),
      };
      try {
        deps.ports().facts.append([assertFact(fait)]);
      } catch (err) {
        log.warn("arrêt de la salle : fait d'activité non écrit", { rootId: racine, error: errorMessage(err) });
      }
      const arretee: CockpitEventMap["conversation.arretee"] = { rootId: racine, cause, unconfirmed: [...unconfirmed] };
      deps.hub.cockpit("conversation.arretee", arretee, "omo");
    }
    emettreRecreation(sonde, cause);
    const result: StopResult = {
      // Arrêt sans racine (redémarrage du cockpit, activité hors demande sans demande active) : chaîne vide, aucune conversation visée.
      rootId: racine ?? "",
      rejected: abandon.rejected,
      aborted: [...abandon.aborted],
      unconfirmed: [...unconfirmed],
      durationMs: Math.max(0, now() - debut),
    };
    log.info("arrêt de la salle", { rootId: racine, cause, rejected: result.rejected, aborted: result.aborted.length, sonde, durationMs: result.durationMs });
    return result;
  };

  const relancer = async (rootId: string): Promise<void> => {
    const etatAvant = await lireEtat();
    const startId = etatAvant?.startId ?? null;
    await demanderArret("fin-de-demande");
    const sonde = await sonder(deps.instance(), startId, "fin-de-demande");
    cloturer(startId, "fin-de-demande", sonde);
    emettreRecreation(sonde, "fin-de-demande");
    log.info("salle relancée à neuf en fin de demande", { rootId: ID_RE.test(rootId) ? rootId : null, sonde });
  };

  return {
    run(rootId, cause) {
      if (arretEnCours !== null) return arretEnCours;
      // Identifiant illisible : la salle s'arrête quand même (un arrêt ne fait que restreindre), sans racine devinée.
      const racine = rootId !== null && ID_RE.test(rootId) ? rootId : null;
      if (rootId !== null && racine === null) log.warn("arrêt de la salle : racine illisible, arrêt sans racine", { cause });
      const promesse = arreter(racine, cause).finally(() => {
        arretEnCours = null;
      });
      arretEnCours = promesse;
      return promesse;
    },

    async relaunchAfterRequest(rootId) {
      // Un arrêt en cours relance déjà la salle à neuf : aucun second stop-request.
      if (arretEnCours !== null) {
        await arretEnCours.catch(() => undefined);
        return;
      }
      if (relanceEnCours !== null) return relanceEnCours;
      const promesse = relancer(rootId).finally(() => {
        relanceEnCours = null;
      });
      relanceEnCours = promesse;
      return promesse;
    },
  };
}

/**
 * Dossiers des sessions de la salle connus du cockpit (le dossier de chaque projet ouvert y est, par sa racine), précédés du
 * dossier par défaut de l'instance (`null`) : « toutes les attentes de l'instance », bornées.
 */
function lecteurDesDossiers(base: DatabaseSync): () => Array<string | null> {
  const requete = base.prepare(
    "SELECT DISTINCT directory FROM sessions WHERE instance = 'omo' AND deleted_at IS NULL AND directory <> '' ORDER BY directory LIMIT ?",
  );
  return () => [null, ...(requete.all(OMO_ARRET_MAX_DOSSIERS) as Array<{ directory: string }>).map((ligne) => ligne.directory)];
}

// --- Module -----------------------------------------------------------------------------------------------------------------------

/** Racine d'une salle : session suivie de l'instance « omo », sans parent, inscrite dans omo_rooms (L18c). */
function racineDeSalle(c11: Cockpit11, id: string): boolean {
  if (!ID_RE.test(id)) return false;
  const ligne = c11.sessions.get(id);
  if (!ligne || ligne.instance !== "omo" || ligne.parent_id !== null || ligne.root_id !== ligne.id) return false;
  try {
    return c11.ports.omoRoom.isRoomRoot(id);
  } catch {
    return false;
  }
}

/**
 * Module `omoStop`, horloge injectable (tests). Salle non configurée (aucun dossier de contrôle) ou fermée (SALLE_OUVERTE faux,
 * le dépôt) : le port NEUTRE reste en place et RIEN n'est inscrit. Sinon : port réel, crochet `abort` de la salle et inscription de
 * démarrage, toutes deux `instances: ["omo"]` (D-2b-40).
 */
export function creerModuleOmoStop(options: OmoStopOptions = {}): Cockpit11Module {
  return {
    name: "omoStop",
    install(reg, c11) {
      const dirs = c11.omoControlDirs ?? null;
      if (!c11.salleOuverte || dirs === null) return;
      c11.ports.omoStop = createOmoStop(
        {
          instance: () => c11.instances?.omo ?? null,
          db: c11.db,
          sessions: c11.sessions,
          hub: c11.hub,
          log: c11.log,
          workspace: c11.env.workspaceDir,
          ports: () => c11.ports,
        },
        options,
      );
      // « Arrêter » par le proxy de la salle (D-2b-30) : racine d'une salle → toute la salle s'arrête (200 StopResult) ; une autre
      // session est relayée telle quelle (un abandon ne fait que restreindre).
      reg.hook(
        "abort",
        async (ctx, sessionId) => {
          if (!racineDeSalle(c11, sessionId)) return null;
          return ctx.c.json(await c11.ports.omoStop.run(sessionId, "vous"));
        },
        { instances: ["omo"] },
      );
      // Redémarrage du cockpit (D-2b-29 point 1) : une salle trouvée lancée l'est sans surveillance depuis l'arrêt du cockpit
      // précédent ; elle est arrêtée et relancée à neuf AVANT que les salles et le pré-contrôle ne démarrent (STEP_ORDER.startup).
      reg.startup(
        async () => {
          const etat = await c11.ports.omoControl.readState();
          if (etat?.phase !== "opencode-lance") return;
          c11.log.warn("salle trouvée lancée au démarrage du cockpit : arrêt et relance à neuf");
          await c11.ports.omoStop.run(null, "redemarrage-cockpit");
        },
        { instances: ["omo"] },
      );
    },
  };
}

export const omoStopModule: Cockpit11Module = creerModuleOmoStop();
