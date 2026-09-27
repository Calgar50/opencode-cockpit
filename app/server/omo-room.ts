// Propriétaire : L18c.
// Salles de la Salle OMO (spécification §3.9 l.340-343, §3.15.2 l.506-510, §4.14.1 l.806-811, §4.12 l.784, §9.4 n° 2 l.1418,
// §6 l.1063, §7.5 l.1146 ; plan 2 bis, fiche L18c ; D-2b-29, D-2b-30, D-2b-42) : port `omoRoom` (ouverture d'une salle par
// projet, statut, projets ouverts, appartenance d'une racine, arrêt) et montage du groupe de routes « omo ».
//
// Ce que ce module tient, et qu'aucun autre ne tient :
// - **une salle = un projet préparé**. Le chemin reçu est relatif au dossier de travail, résolu par `realpath` : ni `..`, ni
//   chemin absolu, ni lien qui sort du dossier de travail (400). Ensuite seulement viennent la liste des projets préparés
//   (409 « Projet non préparé pour la salle : relancez `install.ps1` », §9.4 n° 2) et le pré-contrôle (409, liste masquée).
// - **la racine est créée sur le client de la SALLE**, jamais sur l'instance principale : `InstanceDeps.client` de
//   `instances.omo`, titre seul, puis `sessions.instance = 'omo'` (upsert de T3c) et une ligne `omo_rooms` (migration 6, T3c).
// - **rien n'est deviné quand la salle est coupée** : `COCKPIT_OMO=off`, `COCKPIT_AUTONOMY=off` (§9.4 n° 3 : il coupe aussi la
//   salle) ou `SALLE_OUVERTE` faux → 403, avant toute lecture de disque et avant tout appel à la salle.
// - **la réouverture confirmée d'une salle lève la suspension** (D-2b-29) : `omoControl.resume()`, AVANT la création de la racine
//   (train de V4 de la 2 ter : une salle suspendue n'a pas d'opencode lancé), puis pré-contrôle du démarrage en attente et
//   reprise du battement (`relancerPourOuvrir`) ; un serveur de la salle injoignable rend 409 « salle-en-relance ».
// - **le statut ne porte aucun secret** (§4.12 l.784) : de l'authentification de la salle, il ne dit que la PRÉSENCE du fichier,
//   jamais son contenu — il ne le lit même pas (`lstat` seul).
//
// Le port neutre `neutralOmoRoom` (T3b) reste exporté et INCHANGÉ : c'est le port des tests qui ne déclarent pas ce module, et
// celui d'un cockpit où la salle n'est pas configurée (aucun dossier de contrôle). Le service réel n'est construit que quand
// `omoControlDirs` est présent, exactement comme `omoControl` (omo-control-module.ts).
import { constants as fsConstants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import type { Cockpit11Deps, Cockpit11Module, Cockpit11Ports } from "./contracts-11.ts";
import { EGRESS_FENETRE_DIAGNOSTIC_MS, lireSortiesRefusees } from "./egress-journal.ts";
import { type AppEnv, omoOf } from "./env.ts";
import { errorMessage, type Logger } from "./log.ts";
import type { InstanceDeps, OmoRoomOpenResult, OmoRoomPort } from "./omo-contracts.ts";
import { OMO_PRECHECK_REASONS } from "./omo-contracts.ts";
import { analyserProjetsPrepares, OMO_PROJETS_MAX_OCTETS } from "./omo-control.ts";
import { type OcSession, OpencodeError } from "./opencode.ts";
import { ProjectsService } from "./projects.ts";
import { registerOmoRoutes } from "./routes-omo.ts";
import type { SessionTracker } from "./sessions.ts";
import type { UiMode } from "./shared/assistant-rules.ts";
import { egressHoteAutorise } from "./shared/egress-allow.ts";
import { OMO_VERSION } from "./shared/omo-audit-4.19.4.ts";
import {
  analyserArret,
  analyserBattement,
  arretDuDemarrage,
  OMO_CONTROL_MAX_OCTETS,
  OMO_DELAIS,
  OMO_FICHIERS_CONTROLE,
} from "./shared/omo-control-protocol.ts";
import type {
  OmoActivationRefusalCode,
  OmoEtatSalle,
  OmoPrecheckProjectResult,
  OmoPrecheckReason,
  OmoProjectGitState,
  OmoRoomCreateBody,
  OmoStatusResponse,
  OmoSupervisorState,
} from "./shared/omo-types.ts";

// --- Bornes -----------------------------------------------------------------------------------------------------------------

/** Longueur maximale du chemin de projet reçu : au-delà, la demande est refusée sans toucher au disque. */
export const OMO_PROJET_MAX_CARACTERES = 1024;

/** Nombre de résultats de pré-contrôle relus dans `omo_room_starts.precheck` pour le statut (le reste est ignoré). */
export const OMO_STATUT_PRECHECK_MAX = 100;

/** Délai d'attente de la création de la racine sur le serveur de la salle. */
export const OMO_CREATION_TIMEOUT_MS = 15_000;

// --- Port neutre (T3b, inchangé) ----------------------------------------------------------------------------------------------

export function neutralOmoRoom(deps: Cockpit11Deps): OmoRoomPort {
  return {
    open: async () => ({ ok: false, status: 403, code: "salle-coupee", precheck: null }),
    // Salle coupée : aucun relevé n'est deviné. `omo` et `salleOuverte` sont faux ; `autonomie` est la seule chose que le
    // cockpit sache de lui-même. Les vrais relevés (image, démarrage, egress, battement) arrivent avec L18c.
    status: async () => ({
      interrupteurs: { omo: false, autonomie: deps.env.autonomy, salleOuverte: false },
      image: { chargee: false, id: null, manifesteSha256: null, version: null, auditeLe: null },
      dernierDemarrage: null,
      listeBlanche: [],
      projetsPrepares: [],
      workspaceGit: null,
      etatSalle: "coupee",
      authSalle: { presente: false },
      sortiesRefusees24h: [],
      battement: { actif: false, ageMs: null },
    }),
    openProjects: () => [],
    isRoomRoot: () => false,
  };
}

// --- Service réel ---------------------------------------------------------------------------------------------------------------

/** Arrêt d'une salle demandé par une route (D-2b-30) : l'arrêt ne fait que restreindre, il n'a donc pas de garde de mode. */
export type OmoRoomStopResult =
  | { ok: true }
  | {
      ok: false;
      status: 403 | 404;
      /** « salle-coupee » ou « autonomie-coupee » (403) ; « racine-hors-salle » (404 : la racine n'est pas une salle). */
      code: Extract<OmoActivationRefusalCode, "salle-coupee" | "autonomie-coupee" | "racine-hors-salle">;
    };

/** Pré-contrôle d'un projet demandé par une route : chemin refusé (400), port qui refuse (409), ou relevé rendu tel quel. */
export type OmoRoomPrecheckResult =
  | { ok: true; resultat: OmoPrecheckProjectResult }
  | { ok: false; status: 400; code: OmoPrecheckReason }
  | { ok: false; status: 409; code: OmoActivationRefusalCode };

/**
 * Au-delà du port de T3a (demande de contrat au train, plan §2.3) : l'arrêt d'une salle et le pré-contrôle d'un projet, qui sont
 * des routes et non des ports. Les garder ici évite que `routes-omo.ts` décide quoi que ce soit.
 */
export interface OmoRoomService extends OmoRoomPort {
  stop(rootId: string): Promise<OmoRoomStopResult>;
  precheck(projet: unknown): Promise<OmoRoomPrecheckResult>;
}

export interface OmoRoomDeps {
  db: DatabaseSync;
  sessions: SessionTracker;
  log: Pick<Logger, "info" | "warn">;
  env: Pick<AppEnv, "autonomy" | "copilotApiUrl" | "githubEnterpriseDomain">;
  /**
   * Dossier de travail. Le compose monte le MÊME dossier sur le cockpit et sur la salle, au même chemin (`/workspace`) : ce
   * chemin sert donc à la fois à résoudre le projet ici et à nommer le dossier transmis au serveur de la salle.
   */
  workspace: string;
  /** Volume `control-omo` côté cockpit : le battement que le cockpit y écrit est relu pour le statut. */
  controlDir: string;
  /** Volume `omo-auth` côté cockpit : seule la PRÉSENCE d'`auth.json` y est regardée, jamais son contenu. */
  authDir: string;
  /** `omo-projets.json` écrit par `install.ps1` (source) ; null : aucune liste, donc aucun projet préparé. */
  projectsFile: string | null;
  /** Journal des sorties refusées d'`egress` (L16a), monté en lecture seule. */
  egressJournal: string;
  /** Ports en vigueur, relus à CHAQUE appel : une surcharge de port (tests) ou un port posé plus tard reste prise en compte. */
  ports: () => Pick<Cockpit11Ports, "omoControl" | "omoPrecheck" | "omoStop" | "omoActivation">;
  /** `instances.omo` : null tant que la salle est coupée (aucun client, aucun processeur). */
  instance: () => InstanceDeps | null;
  /** COCKPIT_OMO=on (porté par la présence des dossiers) ET SALLE_OUVERTE : relu à chaque demande. */
  salleOuverte: () => boolean;
  /** Absent : horloge réelle. */
  now?: () => number;
}

const refus = (status: 400 | 403 | 409, code: OmoActivationRefusalCode | OmoPrecheckReason, precheck: OmoPrecheckProjectResult | null = null): OmoRoomOpenResult => ({
  ok: false,
  status,
  code,
  precheck,
});

/** Séquence %XX que le second décodage d'opencode transformerait (même motif que PERCENT_ESCAPE de projects.ts). */
const SEQUENCE_ECHAPPEE = /%[0-9A-Fa-f]{2}/;

/** Chemin de projet accepté : relatif au dossier de travail, en séparateurs « / ». */
type CheminProjet = { ok: true; relatif: string; local: string; racine: string } | { ok: false; code: Extract<OmoPrecheckReason, "hors-workspace" | "lien-symbolique" | "illisible"> };

/**
 * Lit au plus `max` octets d'un fichier ordinaire, sans suivre de lien au dernier composant (O_NOFOLLOW) ni rester bloqué sur un
 * tube nommé (O_NONBLOCK). Un fichier absent, trop gros, illisible ou qui n'est pas un fichier ordinaire vaut `null` : fermé en
 * cas de doute, le cockpit ne devine jamais le contenu d'un fichier qu'il n'a pas lu en entier.
 */
async function lireBorne(chemin: string, max: number): Promise<string | null> {
  let handle: fs.FileHandle;
  try {
    handle = await fs.open(chemin, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0) | (fsConstants.O_NONBLOCK ?? 0));
  } catch {
    return null;
  }
  try {
    if (!(await handle.stat()).isFile()) return null;
    const tampon = Buffer.alloc(max + 1);
    let lus = 0;
    for (;;) {
      const { bytesRead } = await handle.read(tampon, lus, tampon.length - lus, null);
      if (bytesRead === 0) break;
      lus += bytesRead;
      if (lus > max) return null;
    }
    return tampon.subarray(0, lus).toString("utf8");
  } catch {
    return null;
  } finally {
    await handle.close().catch(() => undefined);
  }
}

/** Chemin relatif normalisé, séparateurs « / » : la comparaison avec `omo-projets.json` et avec `omo_rooms` passe par là. */
export function normaliserProjet(projet: string): string {
  const segments = projet.split(/[\\/]/).filter((segment) => segment !== "" && segment !== ".");
  return segments.length === 0 ? "." : segments.join("/");
}

/**
 * Valide le chemin d'un projet (400 quand il refuse) :
 * 1. contrôles de forme, sans toucher au disque : chaîne non vide, bornée, sans octet nul, sans `..`, jamais absolue ;
 * 2. le chemin résolu doit rester dans le dossier de travail ;
 * 3. `realpath` : un lien qui SORT du dossier de travail est refusé. Un projet qui n'existe pas encore n'est pas une erreur de
 *    chemin : il sera refusé plus loin, comme projet non préparé (409) — c'est la réponse juste, et celle que l'utilisateur peut
 *    corriger en relançant `install.ps1`.
 * Les liens INTÉRIEURS au dossier de travail ne sont pas jugés ici : c'est le pré-contrôle qui les refuse (409 « lien-symbolique »),
 * avec sa liste masquée.
 */
async function validerChemin(workspace: string, projet: unknown): Promise<CheminProjet> {
  if (typeof projet !== "string" || projet.length === 0 || projet.length > OMO_PROJET_MAX_CARACTERES || projet.includes("\0")) {
    return { ok: false, code: "hors-workspace" };
  }
  // 1.0.6 × salle (décision D4 de la grande fusion) : opencode 1.18.30 décode `directory` DEUX fois. « a%2F..%2F..%2Fhome » est
  // un seul segment ici, mais un chemin qui sort du dossier de travail chez la salle (son dossier de données, auth.json réduit).
  // Même règle que projects.ts (PERCENT_ESCAPE), même code que tout chemin hors du dossier de travail ; « Remise 20% » reste permis.
  if (SEQUENCE_ECHAPPEE.test(projet)) return { ok: false, code: "hors-workspace" };
  if (projet.split(/[\\/]/).includes("..")) return { ok: false, code: "hors-workspace" };
  if (path.isAbsolute(projet) || path.posix.isAbsolute(projet) || /^[A-Za-z]:/.test(projet)) return { ok: false, code: "hors-workspace" };
  const relatif = normaliserProjet(projet);
  if (relatif === ".") return { ok: false, code: "hors-workspace" };
  let racine: string;
  try {
    racine = await fs.realpath(workspace);
  } catch {
    return { ok: false, code: "illisible" };
  }
  const local = path.resolve(racine, ...relatif.split("/"));
  const depuisRacine = path.relative(racine, local);
  // SECONDE BARRIÈRE, volontairement redondante : un chemin relatif sans `..` ne peut pas sortir du dossier de travail par
  // résolution, donc aucun test ne peut la distinguer de la règle ci-dessus. Elle tient si cette règle change un jour.
  if (depuisRacine === "" || depuisRacine.startsWith("..") || path.isAbsolute(depuisRacine)) return { ok: false, code: "hors-workspace" };
  const reel = await fs.realpath(local).catch(() => null);
  if (reel !== null) {
    const depuisReel = path.relative(racine, reel);
    // Le chemin lexical restait dedans, le chemin réel n'y est plus : un lien en est sorti.
    if (depuisReel === "" || depuisReel.startsWith("..") || path.isAbsolute(depuisReel)) return { ok: false, code: "lien-symbolique" };
  }
  return { ok: true, relatif, local, racine };
}

/** Résultats de pré-contrôle relus dans `omo_room_starts.precheck` : ce que le cockpit y a écrit, jamais davantage. */
function relireResultats(brut: string): OmoPrecheckProjectResult[] {
  let parse: unknown;
  try {
    parse = JSON.parse(brut);
  } catch {
    return [];
  }
  if (!Array.isArray(parse)) return [];
  const resultats: OmoPrecheckProjectResult[] = [];
  for (const entree of parse.slice(0, OMO_STATUT_PRECHECK_MAX)) {
    if (typeof entree !== "object" || entree === null) continue;
    const { projet, verdict, raison, trouves } = entree as Record<string, unknown>;
    if (typeof projet !== "string" || (verdict !== "conforme" && verdict !== "refuse")) continue;
    resultats.push({
      projet,
      verdict,
      // Raison inconnue : `null` plutôt qu'une valeur hors de l'union (le lecteur ne s'invente pas de code).
      raison: OMO_PRECHECK_REASONS.find((connue) => connue === raison) ?? null,
      trouves: Array.isArray(trouves) ? trouves.filter((t): t is string => typeof t === "string") : [],
    });
  }
  return resultats;
}

export function createOmoRoom(deps: OmoRoomDeps): OmoRoomService {
  const now = deps.now ?? (() => Date.now());
  const { db } = deps;
  // COCKPIT_OMO=on est porté par la construction même de ce service (les dossiers de contrôle ne sont connus que d'un cockpit
  // où la salle est configurée) ; COCKPIT_AUTONOMY=off coupe aussi la salle (§9.4 n° 3, décision du 14/09).
  const coupee = (): Extract<OmoActivationRefusalCode, "salle-coupee" | "autonomie-coupee"> | null => {
    if (!deps.salleOuverte()) return "salle-coupee";
    if (!deps.env.autonomy) return "autonomie-coupee";
    return null;
  };

  const projetsOuverts = db.prepare("SELECT DISTINCT projet FROM omo_rooms ORDER BY projet");
  const estRacine = db.prepare("SELECT 1 FROM omo_rooms WHERE root_id = ?");
  const inserer = db.prepare("INSERT INTO omo_rooms (root_id, projet, created_at) VALUES (?, ?, ?)");
  const dernierStart = db.prepare("SELECT start_id, started_at, precheck FROM omo_room_starts WHERE start_id IS NOT NULL ORDER BY id DESC LIMIT 1");

  /** Projets préparés par `install.ps1`, relus bornés ; `null` : liste absente, illisible ou mal formée → aucun projet préparé. */
  const projetsPrepares = async () => {
    if (deps.projectsFile === null) return null;
    const texte = await lireBorne(deps.projectsFile, OMO_PROJETS_MAX_OCTETS);
    return analyserProjetsPrepares(texte);
  };

  const open = async (body: OmoRoomCreateBody, options: { mode: UiMode; confirmed: boolean }): Promise<OmoRoomOpenResult> => {
    // Ordre de la fiche L18c : mode, confirmation, interrupteurs, chemin, projet préparé, pré-contrôle, création. La garde
    // anti-CSRF de http.ts et la garde « salle coupée » du groupe de routes sont passées AVANT d'arriver ici.
    if (options.mode !== "avance") return refus(403, "mode-avance");
    if (!options.confirmed) return refus(403, "confirmation-requise");
    const coupure = coupee();
    if (coupure !== null) return refus(403, coupure);
    const chemin = await validerChemin(deps.workspace, (body as { projet?: unknown } | null | undefined)?.projet);
    if (!chemin.ok) return refus(400, chemin.code);
    // Défense en profondeur (D4) : le dossier transmis au serveur de la salle (`chemin.local`) passe AUSSI la règle de
    // projects.ts (ni %XX, ni octet nul, dans le dossier de travail). Vue de la salle : le compose y monte le dossier de travail au
    // MÊME chemin que chez le cockpit, d'où une racine identique des deux côtés. Refusé : aucune requête, ni ici ni plus loin.
    if (!new ProjectsService({ workspaceDir: chemin.racine, opencodeWorkspaceDir: chemin.racine }).isAllowedDirectory(chemin.local)) {
      return refus(400, "hors-workspace");
    }
    const prepares = await projetsPrepares();
    if (!prepares?.projets.some((entree) => normaliserProjet(entree.chemin) === chemin.relatif)) return refus(409, "non-prepare");
    const verdict = await deps.ports().omoPrecheck.check(chemin.relatif);
    if (!verdict.ok) return refus(409, verdict.code);
    if (verdict.resultat.verdict === "refuse") return refus(409, verdict.resultat.raison ?? "illisible", verdict.resultat);
    // La racine est créée sur le client de la SALLE. `instances.omo` absent = salle coupée : rien n'est envoyé nulle part, et
    // surtout pas à l'instance principale.
    const instance = deps.instance();
    if (instance === null) return refus(403, "salle-coupee");
    // Train de V4 (2 ter) : tout ce qui relance la salle est fait AVANT la création de la racine, qui a besoin d'un opencode lancé.
    await relancerPourOuvrir();
    // Titre seul : le chemin du projet. C'est une donnée, pas une phrase (les phrases de la salle sont dans omo-room-texts.ts).
    let session: OcSession;
    try {
      session = await instance.client.request<OcSession>("POST", "/session", {
        directory: chemin.local,
        body: { title: chemin.relatif },
        timeoutMs: OMO_CREATION_TIMEOUT_MS,
      });
    } catch (err) {
      // Serveur de la salle injoignable (relance à neuf en cours, suspension levée à l'instant) : 409 et sa phrase (« La salle
      // redémarre à neuf. Réessayez dans quelques secondes. »), jamais un 500. Une réponse HTTP de la salle reste une erreur.
      if (err instanceof OpencodeError && err.status < 500) throw err;
      deps.log.warn("salle : racine non créée, serveur de la salle injoignable", { projet: chemin.relatif, error: errorMessage(err) });
      return refus(409, "salle-en-relance");
    }
    deps.sessions.upsert(session, undefined, { instance: "omo" });
    inserer.run(session.id, chemin.relatif, now());
    deps.log.info("salle : salle ouverte", { projet: chemin.relatif });
    return { ok: true, room: { rootId: session.id, projet: chemin.relatif } };
  };

  /**
   * Ce qu'une ouverture CONFIRMÉE fait pour que la salle puisse (re)démarrer, avant de créer la racine (train de V4 de la 2 ter) :
   * 1. D-2b-29 : elle lève la suspension, et elle seule. Levée ICI et non après la création : une salle suspendue n'a pas
   *    d'opencode lancé (aucun `precheck-ok`), la racine ne pourrait jamais être créée, et la suspension jamais levée ;
   * 2. le démarrage que le superviseur publie en attente est alors pré-contrôlé : la surveillance de L19b ne revient jamais sur un
   *    démarrage qu'elle a déjà vu, et elle l'avait vu refusé pour suspension. `beforeStart` refuse toujours un second
   *    `precheck-ok` sur un démarrage déjà contrôlé : rien n'est ouvert de plus qu'une relance à neuf ne l'aurait fait ;
   * 3. le battement du cockpit est repris : un arrêt non confirmé l'a coupé (L23b, l'homme mort arrête la salle), et le
   *    superviseur ne lance rien sans lui. Sans effet s'il tourne déjà, ni salle coupée.
   * Un échec est journalisé, jamais avalé en silence ; l'ouverture continue : la création de la racine dira si la salle répond.
   */
  const relancerPourOuvrir = async (): Promise<void> => {
    const control = deps.ports().omoControl;
    if (control.suspended()) {
      control.resume();
      try {
        const etat = await control.readState();
        if (etat !== null && etat.phase !== "opencode-lance" && etat.phase !== "arret") {
          const issue = await deps.ports().omoPrecheck.beforeStart(etat.startId);
          if (!issue.ok) deps.log.warn("salle : démarrage en attente non pré-contrôlé après la levée de la suspension", { code: issue.code });
        }
      } catch (err) {
        deps.log.warn("salle : pré-contrôle après la levée de la suspension en échec", { error: errorMessage(err) });
      }
    }
    control.startHeartbeat();
  };

  const stop = async (rootId: string): Promise<OmoRoomStopResult> => {
    // Deux modes (D-2b-30) : un arrêt ne fait que restreindre, il n'a pas de garde de mode. Salle coupée : 403.
    const coupure = coupee();
    if (coupure !== null) return { ok: false, status: 403, code: coupure };
    // Racine inconnue de la salle : 404, et AUCUN appel — ni à la salle, ni à l'instance principale.
    if (estRacine.get(rootId) === undefined) return { ok: false, status: 404, code: "racine-hors-salle" };
    await deps.ports().omoStop.run(rootId, "vous");
    return { ok: true };
  };

  const precheck = async (projet: unknown): Promise<OmoRoomPrecheckResult> => {
    const coupure = coupee();
    if (coupure !== null) return { ok: false, status: 409, code: coupure };
    const chemin = await validerChemin(deps.workspace, projet);
    if (!chemin.ok) return { ok: false, status: 400, code: chemin.code };
    const verdict = await deps.ports().omoPrecheck.check(chemin.relatif);
    return verdict.ok ? { ok: true, resultat: verdict.resultat } : { ok: false, status: 409, code: verdict.code };
  };

  /** État du superviseur, lu borné par `omoControl` ; `null` = inconnu (absent, invalide ou trop gros). */
  const etatSuperviseur = async (): Promise<OmoSupervisorState | null> => deps.ports().omoControl.readState();

  /**
   * Relance à neuf décidée par le cockpit, que le superviseur n'a pas encore faite (relecture 2ter-vague-4, même règle que
   * l'activation de L22c) : arrêt ou relance en cours (`omoStop.enCours`), ou stop-request écrit pour le démarrage publié
   * (`arretDuDemarrage`, la règle du superviseur). Sans elle, la page dirait « prête » pendant ces secondes-là.
   */
  const relanceDecidee = async (etat: OmoSupervisorState): Promise<boolean> => {
    try {
      if (deps.ports().omoStop.enCours?.() === true) return true;
    } catch (err) {
      deps.log.warn("salle : arrêt en cours illisible", { error: errorMessage(err) });
      return true;
    }
    const arret = analyserArret(await lireBorne(path.join(deps.controlDir, OMO_FICHIERS_CONTROLE.arret), OMO_CONTROL_MAX_OCTETS));
    return arretDuDemarrage(arret, etat.startId, etat.startedAt);
  };

  const etatSalle = async (etat: OmoSupervisorState | null): Promise<OmoEtatSalle> => {
    if (coupee() !== null) return "coupee";
    if (deps.ports().omoControl.suspended()) return "suspendue";
    if (deps.ports().omoActivation.activeRequest() !== null) return "demande-active";
    // Fermé en cas de doute : un état illisible vaut « aucun opencode lancé ». « en-relance » n'est dit que quand une relance à
    // neuf est certaine (D-2b-29) : le superviseur annonce lui-même un arrêt, ou le cockpit l'a déjà décidé pour CE démarrage.
    if (etat === null) return "arretee";
    if (etat.phase === "arret" || (await relanceDecidee(etat))) return "en-relance";
    if (etat.phase === "opencode-lance") return "prete";
    return "arretee";
  };

  const battement = async (): Promise<{ actif: boolean; ageMs: number | null }> => {
    const texte = await lireBorne(path.join(deps.controlDir, OMO_FICHIERS_CONTROLE.battement), OMO_CONTROL_MAX_OCTETS);
    const lu = analyserBattement(texte);
    if (lu === null) return { actif: false, ageMs: null };
    const ageMs = Math.max(0, now() - lu.at);
    // Actif = le battement est encore frais pour la salle : au-delà de `perimeS`, le superviseur l'arrête (homme mort).
    return { actif: ageMs <= OMO_DELAIS.perimeS * 1000, ageMs };
  };

  /** Présence seule de l'authentification de la salle : jamais d'ouverture, jamais de lecture, jamais de contenu (§4.12 l.784). */
  const authPresente = async (): Promise<boolean> => {
    const info = await fs.lstat(path.join(deps.authDir, "auth.json")).catch(() => null);
    return info !== null && info.isFile();
  };

  const status = async (): Promise<OmoStatusResponse> => {
    const etat = await etatSuperviseur();
    const prepares = await projetsPrepares();
    const gitDeLEtat = new Map((etat?.projets ?? []).map((projet) => [normaliserProjet(projet.chemin), projet.gitLectureSeule]));
    const gitDuProjet = (chemin: string, git: "dossier" | "absent"): OmoProjectGitState => {
      const lectureSeule = gitDeLEtat.get(normaliserProjet(chemin));
      if (lectureSeule !== undefined) return lectureSeule ? "lecture-seule" : "inscriptible";
      return git === "absent" ? "absent" : "inconnu";
    };
    const hote = egressHoteAutorise(deps.env.copilotApiUrl ?? undefined, deps.env.githubEnterpriseDomain ?? undefined);
    const demarrage = dernierStart.get() as { start_id: string; started_at: number; precheck: string } | undefined;
    // Une erreur de lecture du journal d'egress n'est PAS rendue comme « aucun refus » (L16a) : elle remonte, et le cockpit dit
    // qu'il ne peut pas répondre plutôt que d'annoncer un journal vide.
    const sortiesRefusees24h = await lireSortiesRefusees(now(), EGRESS_FENETRE_DIAGNOSTIC_MS, deps.egressJournal);
    return {
      // `omo` est vrai par construction : ce service n'existe QUE sur un cockpit où la salle est configurée, c'est-à-dire où
      // COCKPIT_OMO=on (les dossiers de contrôle ne sont connus qu'à cette condition, omo-control-module.ts).
      interrupteurs: { omo: true, autonomie: deps.env.autonomy, salleOuverte: deps.salleOuverte() },
      image: {
        chargee: etat !== null && etat.imageId !== "",
        id: etat?.imageId || null,
        manifesteSha256: etat?.manifestSha256 || null,
        version: OMO_VERSION,
        // Aucune source machine de la date d'audit dans le dépôt : le cockpit ne l'invente pas (DOC-OMO la pose).
        auditeLe: null,
      },
      dernierDemarrage:
        demarrage === undefined ? null : { startId: demarrage.start_id, at: demarrage.started_at, precheck: relireResultats(demarrage.precheck) },
      listeBlanche: hote === null ? [] : [hote],
      projetsPrepares: (prepares?.projets ?? []).map((projet) => ({ chemin: normaliserProjet(projet.chemin), git: gitDuProjet(projet.chemin, projet.git) })),
      workspaceGit: etat?.workspaceGit ?? null,
      etatSalle: await etatSalle(etat),
      authSalle: { presente: await authPresente() },
      sortiesRefusees24h,
      battement: await battement(),
    };
  };

  return {
    open,
    status,
    stop,
    precheck,
    openProjects: () => (projetsOuverts.all() as Array<{ projet: string }>).map((ligne) => ligne.projet),
    isRoomRoot: (rootId) => estRacine.get(rootId) !== undefined,
  };
}

// --- Module -----------------------------------------------------------------------------------------------------------------

export const omoRoomModule: Cockpit11Module = {
  name: "omoRoom",
  install(reg, c11) {
    // Salle non configurée (aucun dossier de contrôle) : le port NEUTRE reste en place, comme pour `omoControl`. Le module
    // n'inscrit QUE son groupe de routes, dans les deux cas : aucune autre inscription, jamais (wiring-11.test.ts le vérifie).
    const dirs = c11.omoControlDirs ?? null;
    if (dirs !== null) {
      c11.ports.omoRoom = createOmoRoom({
        db: c11.db,
        sessions: c11.sessions,
        log: c11.log,
        env: c11.env,
        workspace: c11.env.workspaceDir,
        controlDir: dirs.controlDir,
        authDir: dirs.authDir,
        projectsFile: dirs.projectsFile ?? null,
        egressJournal: omoOf(c11.env).egressJournal,
        ports: () => c11.ports,
        instance: () => c11.instances?.omo ?? null,
        salleOuverte: () => c11.salleOuverte,
      });
    }
    reg.routes("omo", (app) => registerOmoRoutes(app, c11), { instances: ["omo"] });
  },
};
