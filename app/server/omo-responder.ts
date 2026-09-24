// Propriétaire : L22d.
// Répondeur de la Salle OMO (portillon P9 ; spécification §4.14.3 l.825-832, §4.2 l.603-604, §4.3 l.620 et l.634, G7 l.1221,
// JS-6 ; plan 2 bis et 2 ter §6 fiche L22d) : port `omoResponder` (vide) et dérivation `permission.asked` de la salle, qui répond
// aux demandes d'autorisation de l'extension PAR LE PORTILLON DE LA SALLE (`instances.omo.gate`), jamais par celui du cockpit.
//
// Pour chaque demande publiée par l'instance de la salle, dans cet ordre (le premier doute laisse la demande sans réponse) :
// 1. ORIGINE : l'événement vient du processeur de la salle (`origin.instance` = « omo ») ; sinon rien, jamais.
// 2. RACINE : la session est suivie par le cockpit POUR LA SALLE (`sessions.instance` = « omo »), sa racine aussi, et cette
//    racine a été ouverte par `POST /api/omo/rooms` (ligne `omo_rooms`, qui donne le projet ouvert). Une session inconnue est
//    cherchée sur le serveur de la SALLE (`sessions.ensure(…, "omo")`, 5 s) ; une session de l'instance principale n'est jamais
//    lue ni répondue (P11) : AUCUNE demande d'une racine principale n'est touchée.
// 3. DEMANDE ACTIVE : `omoActivation.activeRequest()` porte sur cette racine. Sans demande active, rien n'est répondu : la
//    demande attend, et l'activité hors demande est l'affaire des détections (L23c).
// 4. VERDICT : `classifyOmoPermission` (L22b, module pur) avec le projet ouvert (dossier de travail + projet d'`omo_rooms`) et
//    les cibles de la configuration git relevées au pré-contrôle (`references()` de L19b, quand le port la porte).
// 5. RÉPONSE, par le portillon de la salle :
//    - rien d'interdit → `relayOnce(id, dossier, "cockpit")` ;
//    - interdit absolu → `rejectWhenAlone(id, session, dossier, message, "cockpit")`, avec « Interdit absolu du cockpit :
//      {catégorie}. N'essayez pas de le contourner. » (TEXTES.avance.interdits de omo-room-texts.ts, catégorie en clair). Le refus
//      est RETENU tant qu'une autre demande de la session attend ou qu'un appel d'outil voisin peut encore en poser une (F-c) :
//      opencode refuse d'un coup toutes les demandes en attente d'une session.
//    Le portillon inscrit chaque réponse au registre des réponses émises AVANT de l'envoyer (JS-6, §3.8) : c'est la base de la
//    détection « réponse non émise par le cockpit » (L23c). Ce module n'envoie rien lui-même, jamais « always ».
// 6. JOURNAL : une ligne `autonomy_decisions` (choix « omo », verdict « auto » ou « refus-interdit », par « regles », règle =
//    « aucun-interdit » ou le code de la catégorie, sort du relais), un fait « decision » et l'événement `autonomie.decision`
//    ÉTIQUETÉ « omo » (jamais envoyé en mode Simple). Le résumé de l'action est masqué et borné (`actionResume`), jamais un
//    texte de message. La raison d'un refus reste vide : le Journal y ajoute lui-même le message d'interdit (L26b, omo-journal.ts).
//
// Ce module ne lit ni variable d'environnement ni fichier ; il n'écrit que sa ligne de journal. `neutralOmoResponder` reste
// exporté et inchangé : c'est le port des tests qui ne déclarent pas ce module. Dans le dépôt, `SALLE_OUVERTE` est fausse :
// le module n'inscrit RIEN (wiring-11.test.ts le vérifie) ; les tests montent la fabrique sur un `c11` dont cette seule porte
// est ouverte.
import { posix } from "node:path";
import { type AskedPermission, actionResume, readAsked, SESSION_LOOKUP_TIMEOUT_MS } from "./autonomy.ts";
import type { Cockpit11, Cockpit11Deps, Cockpit11Module, EventDerivation, Registrar } from "./contracts-11.ts";
import { errorMessage } from "./log.ts";
import type { OmoResponderPort } from "./omo-contracts.ts";
import type { OcGlobalEvent } from "./opencode.ts";
import type { SessionRow } from "./sessions.ts";
import { assertFact } from "./shared/activity-facts.ts";
import type { ActivityFact, DecisionFactData, SessionInstance } from "./shared/activity-types.ts";
import type { DecisionVerdict, RelayOutcome, RepliedBy } from "./shared/autonomy-types.ts";
import type { CockpitEventMap } from "./shared/cockpit-event-types.ts";
import { classifyOmoPermission, type OmoPermissionVerdict } from "./shared/omo-forbidden.ts";
import { libelleInterdit, TEXTES } from "./shared/omo-room-texts.ts";
import type { OmoForbiddenCategory } from "./shared/omo-types.ts";

export function neutralOmoResponder(_deps: Cockpit11Deps): OmoResponderPort {
  return {};
}

// --- Constantes ------------------------------------------------------------------------------------------------------------------

/** Choix écrit au journal pour une décision de la salle (`autonomy_decisions.choix`, colonne TEXT). */
export const OMO_CHOIX_JOURNAL = "omo";

/** Règle d'un « once » : aucune catégorie d'interdit absolu ne vise la demande (codes des refus : `OmoForbiddenCategory`). */
export const OMO_REGLE_AUCUN_INTERDIT = "aucun-interdit";

/** Version des règles du répondeur (`autonomy_decisions.rules_version`) : celles d'`omo-forbidden.ts` (L22b, A18). */
export const OMO_REPONDEUR_REGLES_VERSION = 1;

/** Auteur des réponses du répondeur, au sens du portillon (`RepliedBy`) : le cockpit. */
const PAR_COCKPIT: RepliedBy = "cockpit";

/** Demandes déjà prises en charge, gardées en mémoire : un événement reçu deux fois ne donne jamais deux réponses. */
export const OMO_REPONDUES_MAX = 5_000;

/** Raison écrite au journal : bornée, comme celle du cycle d'autonomie. */
const RAISON_MAX = 500;

// --- Outils ------------------------------------------------------------------------------------------------------------------------

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

/** Promesse bornée : undefined après `ms` (recherche d'une session inconnue, jamais plus longue que dans le cycle d'autonomie). */
async function bounded<T>(promise: Promise<T>, ms: number): Promise<T | undefined> {
  let timer: NodeJS.Timeout | undefined;
  const late = new Promise<undefined>((resolve) => {
    timer = setTimeout(() => resolve(undefined), ms);
    timer.unref();
  });
  try {
    return await Promise.race([promise, late]);
  } finally {
    clearTimeout(timer);
  }
}

/** Projet d'une salle (`omo_rooms.projet`) : relatif au dossier de travail, sans « . », « .. » ni chemin absolu ; null sinon. */
function projetRelatif(projet: unknown): string | null {
  if (typeof projet !== "string" || projet === "" || projet.includes("\0")) return null;
  const segments = projet.split(/[\\/]/);
  if (projet.startsWith("/") || /^[A-Za-z]:/.test(projet) || segments.some((segment) => segment === "..")) return null;
  const utiles = segments.filter((segment) => segment !== "" && segment !== ".");
  return utiles.length === 0 ? null : utiles.join("/");
}

/**
 * Nom de permission accepté dans la salle : celui du cycle d'autonomie (`readAsked`, minuscules et « _ ») ne couvre pas les noms
 * d'outils d'une extension ou d'un serveur d'outils (majuscules, tiret), qu'opencode publie tels quels. Une demande que le
 * répondeur ne sait pas lire n'a personne d'autre pour lui répondre dans la salle (le navigateur n'y répond jamais) : elle
 * resterait en attente jusqu'à un arrêt. Le verdict, lui, reste celui d'`omo-forbidden.ts`.
 */
const PERMISSION_SALLE_RE = /^[A-Za-z0-9_-]{1,128}$/;

/** Demande d'autorisation de la salle, lue comme le cycle d'autonomie la lit, nom de permission élargi ; null si illisible. */
export function lireDemandeSalle(raw: unknown, directory: string | null): AskedPermission | null {
  const lue = readAsked(raw, directory);
  if (lue !== null || !isRecord(raw) || typeof raw.permission !== "string" || !PERMISSION_SALLE_RE.test(raw.permission)) return lue;
  const reste = readAsked({ ...raw, permission: "inconnue" }, directory);
  return reste === null ? null : { ...reste, permission: raw.permission };
}

/**
 * Relevés du dernier pré-contrôle accepté (L19b, `OmoPrecheckService.references`) : lus seulement si le port en vigueur les porte
 * (le port neutre ne les a pas). Une forme inattendue vaut « aucun relevé ».
 */
function ideCiDynamiquesDe(port: unknown, projet: string): string[] {
  const references = isRecord(port) && typeof port.references === "function" ? (port as { references(): unknown }).references() : null;
  if (!isRecord(references) || !Array.isArray(references.releves)) return [];
  for (const releve of references.releves) {
    if (!isRecord(releve) || projetRelatif(releve.racine) !== projet || !Array.isArray(releve.ideCiDynamiques)) continue;
    return releve.ideCiDynamiques.filter((cible): cible is string => typeof cible === "string");
  }
  return [];
}

// --- Service -------------------------------------------------------------------------------------------------------------------------

export interface OmoResponderOptions {
  /**
   * Dossier de travail tel que la salle le voit : le compose monte le même dossier sur le cockpit et sur la salle, au même chemin
   * (`/workspace`, omo-room.ts). Absent : `c11.env.workspaceDir`. Un chemin qui n'est pas absolu au sens POSIX rend toute écriture
   * « hors-projet » (fermé en cas de doute, omo-forbidden.ts).
   */
  workspace?: string;
  /** Absent : horloge réelle (heures du journal seulement). */
  now?: () => number;
}

export interface OmoResponderService {
  derivation: EventDerivation;
  /** Réponses en cours, de toutes les demandes déjà reçues : rend la main quand chacune est finie (tests, arrêt). */
  settled(): Promise<void>;
}

/** Racine de salle d'une demande, avec son projet ouvert ; null : la demande n'est pas celle d'une racine de la salle. */
interface RacineSalle {
  rootId: string;
  projet: string;
}

type Refus = Extract<OmoPermissionVerdict, { verdict: "interdit" }>;

/** Message remis à l'IA avec un refus d'interdit absolu (§4.14.3 l.829), catégorie en clair. */
export function messageInterdit(categorie: OmoForbiddenCategory): string {
  return TEXTES.avance.interdits.message.replace("{categorie}", libelleInterdit(categorie));
}

export function createOmoResponder(c11: Cockpit11, options: OmoResponderOptions = {}): OmoResponderService {
  const now = options.now ?? Date.now;
  const log = c11.log;
  const workspace = (options.workspace ?? c11.env.workspaceDir).replaceAll("\\", "/");
  const projetDeSalle = c11.db.prepare("SELECT projet FROM omo_rooms WHERE root_id = ?");
  /** Demandes prises en charge (par identifiant), bornées : la plus ancienne est oubliée au-delà. */
  const prises = new Set<string>();
  const enCours = new Set<Promise<void>>();

  const prendre = (permissionId: string): boolean => {
    if (prises.has(permissionId)) return false;
    prises.add(permissionId);
    if (prises.size > OMO_REPONDUES_MAX) {
      const plusAncienne = prises.values().next().value;
      if (plusAncienne !== undefined) prises.delete(plusAncienne);
    }
    return true;
  };

  /** Racine de la salle d'une session de la salle ; null : session inconnue, de l'instance principale, ou racine hors salle. */
  const racineDeSalle = async (asked: AskedPermission): Promise<RacineSalle | null> => {
    const connue = c11.sessions.get(asked.sessionId);
    // Session inconnue, ou parent pas encore suivi : recherche sur le serveur de la SALLE seulement (jamais l'instance principale).
    const row: SessionRow | undefined =
      connue && (connue.parent_id === null || c11.sessions.get(connue.parent_id))
        ? connue
        : await bounded(c11.sessions.ensure(asked.sessionId, asked.directory ?? undefined, 0, "omo").catch(() => undefined), SESSION_LOOKUP_TIMEOUT_MS);
    if (row === undefined || row.instance !== "omo" || row.deleted_at !== null) return null;
    const racine = c11.sessions.get(row.root_id);
    if (!racine || racine.instance !== "omo" || racine.parent_id !== null || racine.root_id !== racine.id || racine.deleted_at !== null) return null;
    const ligne = projetDeSalle.get(racine.id) as { projet?: unknown } | undefined;
    const projet = projetRelatif(ligne?.projet);
    return projet === null ? null : { rootId: racine.id, projet };
  };

  interface Decision {
    asked: AskedPermission;
    rootId: string;
    requestId: string;
    askedAt: number;
    verdict: Extract<DecisionVerdict, "auto" | "refus-interdit">;
    regle: string;
    raison: string;
    relais: RelayOutcome | null;
  }

  /** Une ligne `autonomy_decisions`, UN fait « decision » et un événement `autonomie.decision` de la salle. */
  const journaliser = (d: Decision): void => {
    const decidedAt = now();
    try {
      c11.db
        .prepare(
          `INSERT INTO autonomy_decisions (request_id, root_id, session_id, permission_id, permission, resume, choix, regle,
             rules_version, verdict, par, raison, ia_model, ia_cost, ia_ms, relais, asked_at, decided_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'regles', ?, NULL, NULL, NULL, ?, ?, ?)`,
        )
        .run(
          d.requestId,
          d.rootId,
          d.asked.sessionId,
          d.asked.permissionId,
          d.asked.permission,
          actionResume(d.asked),
          OMO_CHOIX_JOURNAL,
          d.regle,
          OMO_REPONDEUR_REGLES_VERSION,
          d.verdict,
          d.raison.slice(0, RAISON_MAX),
          d.relais,
          d.askedAt,
          decidedAt,
        );
    } catch (err) {
      log.warn("salle : décision du répondeur non journalisée", { rootId: d.rootId, permissionId: d.asked.permissionId, error: errorMessage(err) });
      return;
    }
    try {
      const data: DecisionFactData = { verdict: d.verdict, regle: d.regle };
      const fait: ActivityFact = { rootId: d.rootId, sessionId: d.asked.sessionId, kind: "decision", ref: d.asked.permissionId, data, at: decidedAt };
      c11.ports.facts.append([assertFact(fait)]);
    } catch (err) {
      log.warn("salle : fait « decision » du répondeur non écrit", { permissionId: d.asked.permissionId, error: errorMessage(err) });
    }
    const evenement: CockpitEventMap["autonomie.decision"] = {
      rootId: d.rootId,
      sessionId: d.asked.sessionId,
      permissionId: d.asked.permissionId,
      verdict: d.verdict,
      regle: d.regle,
      raison: d.raison,
      par: "regles",
    };
    // Étiqueté « omo » : le flux des navigateurs n'envoie jamais un événement de la salle en mode Simple (L18b).
    c11.hub.cockpit("autonomie.decision", evenement, "omo");
    log.info("salle : demande d'autorisation répondue", {
      rootId: d.rootId,
      permissionId: d.asked.permissionId,
      permission: d.asked.permission,
      verdict: d.verdict,
      regle: d.regle,
      relais: d.relais,
    });
  };

  /** Réponse aux interdits : refus retenu (F-c), puis journal. « retenu » : rien n'est parti, la demande attend encore. */
  const refuser = async (asked: AskedPermission, racine: RacineSalle, requestId: string, askedAt: number, refus: Refus): Promise<void> => {
    const gate = c11.instances?.omo?.gate;
    if (!gate) return;
    const sort = await gate.rejectWhenAlone(asked.permissionId, asked.sessionId, asked.directory, messageInterdit(refus.categorie), PAR_COCKPIT);
    if (sort === "ok") markWait(asked, racine.rootId, "reject");
    journaliser({ asked, rootId: racine.rootId, requestId, askedAt, verdict: "refus-interdit", regle: refus.categorie, raison: "", relais: sort === "retenu" ? null : sort });
  };

  const autoriser = async (asked: AskedPermission, racine: RacineSalle, requestId: string, askedAt: number): Promise<void> => {
    const gate = c11.instances?.omo?.gate;
    if (!gate) return;
    const sort = await gate.relayOnce(asked.permissionId, asked.directory, PAR_COCKPIT);
    if (sort === "ok") markWait(asked, racine.rootId, "once");
    const raison = TEXTES.avance.activation.autorise.replace("{projet}", racine.projet);
    journaliser({ asked, rootId: racine.rootId, requestId, askedAt, verdict: "auto", regle: OMO_REGLE_AUCUN_INTERDIT, raison, relais: sort });
  };

  /** Attente d'accord close par le cockpit (écrivain unique : ports.facts.work, L4b). */
  const markWait = (asked: AskedPermission, rootId: string, etat: "once" | "reject"): void => {
    try {
      c11.ports.facts.work.markWait({ permissionId: asked.permissionId, sessionId: asked.sessionId, rootId, permission: asked.permission, target: null }, etat, PAR_COCKPIT);
    } catch (err) {
      log.warn("salle : attente d'accord non enregistrée", { permissionId: asked.permissionId, error: errorMessage(err) });
    }
  };

  const repondre = async (asked: AskedPermission): Promise<void> => {
    const askedAt = now();
    // Salle coupée : aucun portillon, aucune réponse.
    if (!c11.instances?.omo) return;
    const racine = await racineDeSalle(asked);
    if (racine === null) {
      log.info("salle : demande d'autorisation hors d'une racine de la salle, laissée sans réponse", { permissionId: asked.permissionId });
      return;
    }
    const demande = c11.ports.omoActivation.activeRequest();
    if (demande === null || demande.rootId !== racine.rootId) {
      log.info("salle : demande d'autorisation sans demande active de sa racine, laissée sans réponse", { rootId: racine.rootId, permissionId: asked.permissionId });
      return;
    }
    const verdict = classifyOmoPermission(
      { permission: asked.permission, metadata: asked.metadata },
      { projetOuvert: posix.join(workspace, racine.projet), ideCiDynamiques: ideCiDynamiquesDe(c11.ports.omoPrecheck, racine.projet) },
    );
    if (verdict.verdict === "interdit") await refuser(asked, racine, demande.requestId, askedAt, verdict);
    else await autoriser(asked, racine, demande.requestId, askedAt);
  };

  const derivation: EventDerivation = {
    name: "omoResponder",
    instances: ["omo"],
    onEvent(global: OcGlobalEvent, origin?: { instance: SessionInstance }): void {
      // Origine absente = instance principale : jamais une demande de la principale, même si un câblage se trompait de processeur.
      if (origin?.instance !== "omo") return;
      const event = isRecord(global) ? global.payload : null;
      if (!isRecord(event) || event.type !== "permission.asked") return;
      const asked = lireDemandeSalle(event.properties, typeof global.directory === "string" && global.directory !== "" ? global.directory : null);
      if (asked === null || !prendre(asked.permissionId)) return;
      // Hors de l'appel de la dérivation (aucune attente réseau ici) ; une erreur imprévue laisse la demande sans réponse.
      const travail = repondre(asked).catch((err: unknown) =>
        log.warn("salle : répondeur en échec, la demande reste sans réponse", { permissionId: asked.permissionId, error: errorMessage(err) }),
      );
      enCours.add(travail);
      void travail.finally(() => enCours.delete(travail));
    },
  };

  return {
    derivation,
    async settled() {
      while (enCours.size > 0) await Promise.allSettled([...enCours]);
    },
  };
}

/** Pose la dérivation du répondeur (instance « omo »). Rend le service (tests de la fabrique installée). */
export function installOmoResponder(reg: Registrar, c11: Cockpit11, options: OmoResponderOptions = {}): OmoResponderService {
  const service = createOmoResponder(c11, options);
  reg.derivation(service.derivation);
  return service;
}

/**
 * SALLE_OUVERTE fausse (dépôt) : aucune inscription. Ouverte : la dérivation `permission.asked` de la salle, branchée par
 * app-factory au seul processeur de la salle (`instances: ["omo"]`), entre les détections et les faits (STEP_ORDER).
 */
export const omoResponderModule: Cockpit11Module = {
  name: "omoResponder",
  install(reg, c11) {
    if (!c11.salleOuverte) return;
    installOmoResponder(reg, c11);
  },
};
