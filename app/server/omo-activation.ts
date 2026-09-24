// Propriétaire : L22c.
// Activation « Comme Oh My OpenAgent » (spécification §4.14.2 l.813-823, §4.8.2 l.729-730, §3.6 l.280-289, §4.11 l.774, §3.15.1
// l.475 ; décisions n° 9, 10, 13 ; plan 2 bis, fiche L22c ; D-2b-07, D-2b-08, D-2b-11 ; décision A16) : port `omoActivation`,
// jeton à usage unique et crochet `beforeBilledSend` de la salle.
//
// Ce que ce module tient, et qu'aucun autre ne tient :
// - **une confirmation par demande** (D-2b-07) : PUT …/autonomie `{choix: "omo", plafondUsd}` avec x-cockpit-confirm: 1, en
//   Avancé, crée un jeton serveur lié à la racine, valable pour UN envoi dans les 10 minutes. Le crochet `beforeBilledSend` de la
//   salle le PREND avant toute autre vérification : refusé ou non, il ne resservira pas. Un second envoi reçoit 409.
// - **conditions revérifiées à l'envoi** (§4.14.2) : chacune est relue au PUT et de nouveau au moment de l'envoi ; une seule
//   fausse → 409 et sa phrase, et RIEN n'est envoyé (le crochet rend la réponse, le proxy ne relaie pas). Ordre, première fausse
//   l'emporte : salle coupée (COCKPIT_OMO, SALLE_OUVERTE, instance), COCKPIT_AUTONOMY, salle suspendue, demande active (une seule
//   dans la salle, D-2b-08), battement du cockpit frais, puis l'état publié par le superviseur — manifeste vérifié, image de la
//   version auditée installée par install.ps1, `.git` protégés selon la sonde ÉTENDUE de L16c, dossiers de configuration et
//   pré-contrôle du projet (frais, et `precheck-ok` de CE démarrage), salle lancée —, puis le balayage git refait par le cockpit
//   (dépôt apparu hors `gitProteges` depuis le démarrage), le catalogue du compte (P1), l'adresse Copilot, et enfin le montant saisi
//   (omo-cap.ts, borne `plafondMaxUsd` et garde-fou budgétaire).
// - **fermé en cas de doute** (A16) : `state.json` illisible, balayage tronqué (`limiteAtteinte`), projet absent de l'état publié,
//   `precheck-ok` d'un autre démarrage, catalogue non vérifié, fichier illisible → refus.
// - **aucune valeur de plafond par défaut** (Q7) : le montant est celui que l'utilisateur a saisi, en chaîne, jamais complété ni
//   arrondi ; `budget.omo.dernierPlafondUsd` n'est écrit qu'après une activation CONFIRMÉE, c'est-à-dire quand l'envoi part.
//
// Sonde de L16c (A16) : le cockpit ne lit pas /proc/self/mountinfo de la salle (autre conteneur). Il lit ce que la sonde étendue du
// superviseur publie dans `state.json` : `projets[].gitLectureSeule` (alias du `.git` ET du dossier parent, montage en lecture
// seule sans écriture rouverte) et `workspaceGit` (montages refusés rangés dans `nonProteges`, « . » pour une racine sans ro).
//
// Demande en cours : en mémoire (`activeRequest`), et marquée dans la ligne « omo » de conversation_autonomy pour que le démarrage
// suivant la dise « interrompue » (conversation-autonomy.ts). La ligne `autonomy_requests` de la fiche attend une demande de
// contrat : l'API de L10a n'accepte ni « omo » ni un montant en chaîne, et la surveillance de L10c relirait une ligne de la salle
// avec les plafonds d'« Autonome avec contrôle » (1,00 $ d'office) — ce que Q7 interdit.
//
// `neutralOmoActivation` reste exporté et INCHANGÉ (T3b) : c'est le port des tests qui ne déclarent pas ce module, et celui du
// dépôt tant que `SALLE_OUVERTE` est faux (le service réel n'est construit que salle configurée ET ouverte).
import { randomUUID } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import type { ModelCatalog } from "./catalog.ts";
import type { Cockpit11, Cockpit11Deps, Cockpit11Module, Cockpit11Ports, HookSignatures, Registrar } from "./contracts-11.ts";
import { ConversationAutonomyStore, corpsRefusSalle, projetDeSalle, statutRefusSalle } from "./conversation-autonomy.ts";
import { type AppEnv, omoOf } from "./env.ts";
import type { Ledger } from "./ledger.ts";
import { errorMessage, type Logger } from "./log.ts";
import type { InstanceDeps, OmoActivationPort, OmoActivationPutResult, OmoActiveRequest, OmoConsumeResult } from "./omo-contracts.ts";
import { analyserProjetsPrepares, OMO_PROJETS_MAX_OCTETS } from "./omo-control.ts";
import { releverGitsWorkspace } from "./omo-precheck-reader.ts";
import type { SessionTracker } from "./sessions.ts";
import type { SettingsStore } from "./settings.ts";
import type { UiMode } from "./shared/assistant-rules.ts";
import type { ChoiceCause, RequestEnd } from "./shared/autonomy-types.ts";
import { egressHoteAutorise } from "./shared/egress-allow.ts";
import { SESSION_ID_RE } from "./shared/ids.ts";
import { OMO_VERSION } from "./shared/omo-audit-4.19.4.ts";
import { proposePlafond, validatePlafond } from "./shared/omo-cap.ts";
import { analyserBattement, analyserPrecheckOk, OMO_CONTROL_MAX_OCTETS, OMO_DELAIS, OMO_FICHIERS_CONTROLE } from "./shared/omo-control-protocol.ts";
import { gitsHorsProtection, type PrecheckBornes } from "./shared/omo-precheck-rules.ts";
import type { OmoActivationBody, OmoActivationRefusalCode, OmoActivationView, OmoSupervisorState } from "./shared/omo-types.ts";

export function neutralOmoActivation(_deps: Cockpit11Deps): OmoActivationPort {
  return {
    view: async () => null,
    put: async () => ({ ok: false, status: 409, code: "salle-coupee" }),
    consume: async () => ({ ok: false, code: "salle-coupee" }),
    activeRequest: () => null,
    endRequest: () => undefined,
  };
}

// --- Bornes -------------------------------------------------------------------------------------------------------------------

/** D-2b-07 : un jeton d'activation vaut pour UN envoi, dans les 10 minutes qui suivent la confirmation. */
export const OMO_JETON_DUREE_MS = 10 * 60_000;

/** Chemins rendus avec un refus git (gabarit {liste}) : 20 au plus, comme les listes publiées par le superviseur. */
export const OMO_ACTIVATION_LISTE_MAX = 20;

/** Préfixe de l'identifiant de construction de l'image (/etc/opencode-omo/image-id, L15a) : la version auditée, seule acceptée. */
export const OMO_IMAGE_ID_PREFIXE = `oh-my-openagent@${OMO_VERSION} `;

// --- Types -----------------------------------------------------------------------------------------------------------------------

/** Refus d'une activation : code du contrat, et chemins en cause pour un refus git (gabarit {liste}), en plus du contrat de T3a. */
export type OmoActivationRefus = Extract<OmoActivationPutResult, { ok: false }> & { liste?: string[] };

/** Refus d'un envoi : code, statut HTTP et chemins en cause. */
type RefusEnvoi = { ok: false; code: OmoActivationRefusalCode; liste: string[] };

/** Condition du §4.14.2 relevée, dans l'ordre de l'évaluation. */
type Condition = { code: OmoActivationRefusalCode; ok: boolean };

interface Evaluation {
  conditions: Condition[];
  /** Première condition fausse et ses chemins ; null : toutes remplies. */
  refus: { code: OmoActivationRefusalCode; liste: string[] } | null;
}

/** Référence d'un modèle dans le corps d'un envoi (`model: {providerID, modelID}`), pour le garde-fou budgétaire. */
interface ModeleEnvoye {
  providerID: string;
  modelID: string;
}

/** Jeton d'activation : montant tel que saisi, heure d'expiration. Jamais écrit ailleurs qu'en mémoire (perdu au redémarrage). */
interface Jeton {
  saisie: string;
  expireA: number;
}

export interface OmoActivationDeps {
  db: DatabaseSync;
  sessions: Pick<SessionTracker, "rootOf">;
  settings: Pick<SettingsStore, "get" | "update">;
  ledger: Pick<Ledger, "percentUsed" | "guard">;
  log: Pick<Logger, "info" | "warn">;
  env: Pick<AppEnv, "autonomy" | "copilotApiUrl" | "githubEnterpriseDomain">;
  /** COCKPIT_OMO_IMAGE : écrit par install.ps1 -OmoArchive après vérification de l'empreinte ; vide : aucune image installée. */
  image: string;
  /** Dossier de travail monté (`/workspace`) : balayage git refait par le cockpit à chaque activation. */
  workspace: string;
  /** Volume `control-omo` côté cockpit : battement et `precheck-ok` relus. */
  controlDir: string;
  /** `omo-projets.json` écrit par install.ps1 (source de `gitProteges`) ; null : aucune liste, balayage non vérifiable. */
  projectsFile: string | null;
  /** Ports voisins en vigueur, relus à CHAQUE appel. */
  ports: () => Pick<Cockpit11Ports, "omoControl" | "omoPrecheck">;
  /** `instances.omo` : null tant que la salle est coupée. */
  instance: () => InstanceDeps | null;
  /** Catalogue du compte GitHub Copilot (P1), relu en continu par l'instance principale ; même compte que la salle. */
  catalogue: () => Pick<ModelCatalog, "loaded" | "sources" | "list">;
  /** SALLE_OUVERTE (et COCKPIT_OMO=on, porté par la construction même du service), relu à chaque appel. */
  salleOuverte: () => boolean;
  now?: () => number;
  /** Bornes du balayage git ; un test en passe de plus petites. Jamais lues dans l'environnement. */
  bornes?: Partial<PrecheckBornes>;
}

export interface OmoActivationService extends OmoActivationPort {
  put(rootId: string, body: OmoActivationBody, options: { mode: UiMode; confirmed: boolean }): Promise<OmoActivationPutResult & { liste?: string[] }>;
  /** Crochet `beforeBilledSend` de la salle (`instances: ["omo"]`) : jeton pris, conditions revérifiées, 409 sans envoi. */
  hook: HookSignatures["beforeBilledSend"];
}

// --- Lectures bornées ------------------------------------------------------------------------------------------------------------

/**
 * Lit au plus `max` octets d'un fichier ordinaire, sans suivre de lien au dernier composant (O_NOFOLLOW) ni rester bloqué sur un
 * tube nommé (O_NONBLOCK). Absent, trop gros, illisible, pas un fichier : null (fermé en cas de doute).
 */
async function lireBorne(chemin: string, max: number): Promise<string | null> {
  let handle: fs.FileHandle;
  try {
    handle = await fs.open(chemin, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0) | (fsConstants.O_NONBLOCK ?? 0));
  } catch {
    return null;
  }
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.size > max) return null;
    const tampon = Buffer.alloc(max + 1);
    let lus = 0;
    for (;;) {
      const { bytesRead } = await handle.read(tampon, lus, tampon.length - lus, lus);
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

/** Chemin relatif normalisé (séparateurs « / », sans « ./ » ni « / » de fin), comme omo-room.ts et le pré-contrôle. */
function normaliser(chemin: string): string {
  const segments = chemin.split(/[\\/]/).filter((segment) => segment !== "" && segment !== ".");
  return segments.length === 0 ? "." : segments.join("/");
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

/** Modèle d'un envoi, lu prudemment ; null : absent ou illisible (le garde-fou ne juge alors que le budget épuisé). */
function modeleDuCorps(body: Record<string, unknown>): ModeleEnvoye | null {
  const model = body.model;
  if (!isRecord(model) || typeof model.providerID !== "string" || typeof model.modelID !== "string") return null;
  return { providerID: model.providerID, modelID: model.modelID };
}

// --- Service ---------------------------------------------------------------------------------------------------------------------

export function createOmoActivation(deps: OmoActivationDeps): OmoActivationService {
  const { db, log } = deps;
  const now = deps.now ?? (() => Date.now());
  const store = new ConversationAutonomyStore(db);

  /** Jetons en attente d'envoi, par racine (un seul par racine : une nouvelle confirmation remplace la précédente). */
  const jetons = new Map<string, Jeton>();
  /** Racines dont le dernier jeton a servi : un second envoi dit « déjà servi », pas « confirmez ». */
  const consommes = new Set<string>();
  /** Demande de la salle en cours : une seule à la fois (D-2b-08). */
  let active: OmoActiveRequest | null = null;

  // Une activation ou un envoi à la fois, dans l'ordre : deux envois ne peuvent pas démarrer deux demandes (D-2b-08).
  let file: Promise<unknown> = Promise.resolve();
  const enFile = <T>(tache: () => Promise<T>): Promise<T> => {
    const suite = file.then(tache);
    file = suite.catch(() => undefined);
    return suite;
  };

  const plafondMaxUsd = (): number => deps.settings.get().budget.autonomie.plafondMaxUsd;

  // --- Conditions, relues à chaque appel ---------------------------------------------------------------------------------------

  const salleDisponible = (): boolean => {
    try {
      return deps.salleOuverte() === true && deps.instance() !== null;
    } catch {
      return false;
    }
  };

  const suspendue = (): boolean => {
    try {
      return deps.ports().omoControl.suspended();
    } catch {
      return true;
    }
  };

  /** Battement écrit par le cockpit et encore frais pour la salle (au-delà de `perimeS`, le superviseur l'arrête). */
  const battementFrais = async (): Promise<boolean> => {
    const lu = analyserBattement(await lireBorne(path.join(deps.controlDir, OMO_FICHIERS_CONTROLE.battement), OMO_CONTROL_MAX_OCTETS));
    return lu !== null && Math.max(0, now() - lu.at) <= OMO_DELAIS.perimeS * 1000;
  };

  const lireEtat = async (): Promise<OmoSupervisorState | null> => {
    try {
      return await deps.ports().omoControl.readState();
    } catch (err) {
      log.warn("salle : état du superviseur illisible", { error: errorMessage(err) });
      return null;
    }
  };

  /** Image installée par install.ps1 (empreinte vérifiée) ET construite pour la version auditée. */
  const imageAttendue = (etat: OmoSupervisorState): boolean => deps.image.trim() !== "" && etat.imageId.startsWith(OMO_IMAGE_ID_PREFIXE);

  /**
   * `.git` protégés selon la sonde ÉTENDUE du superviseur (L16c, A16) : balayage complet, aucun `.git` ni montage refusé dans
   * `nonProteges`, chaque projet préparé en lecture seule, et le projet de cette salle bien relevé. Doute → refus, avec la liste.
   */
  const gitProtege = (etat: OmoSupervisorState, projet: string): { ok: boolean; liste: string[] } => {
    const chemins = new Set<string>(etat.workspaceGit.nonProteges.map(normaliser));
    for (const releve of etat.projets) if (releve.gitLectureSeule !== true) chemins.add(normaliser(releve.chemin));
    if (!etat.projets.some((releve) => normaliser(releve.chemin) === projet)) chemins.add(projet);
    const liste = [...chemins].sort().slice(0, OMO_ACTIVATION_LISTE_MAX);
    return { ok: etat.workspaceGit.limiteAtteinte === false && chemins.size === 0, liste };
  };

  /**
   * Pré-contrôle du projet : dossiers de configuration conformes, relevé frais conforme (L19a par le port de L19b), puis
   * `precheck-ok` de CE démarrage qui porte ce projet. « en-attente » : le cockpit n'a pas encore pré-contrôlé ce démarrage.
   */
  const precheckDuProjet = async (etat: OmoSupervisorState, projet: string): Promise<"ok" | "refuse" | "en-attente"> => {
    if (etat.dossiersConfig.length === 0 || etat.dossiersConfig.some((dossier) => dossier.ok !== true)) return "refuse";
    try {
      const frais = await deps.ports().omoPrecheck.check(projet);
      if (!frais.ok || frais.resultat.verdict !== "conforme") return "refuse";
    } catch (err) {
      log.warn("salle : pré-contrôle du projet impossible", { error: errorMessage(err) });
      return "refuse";
    }
    const ok = analyserPrecheckOk(await lireBorne(path.join(deps.controlDir, OMO_FICHIERS_CONTROLE.precheck), OMO_CONTROL_MAX_OCTETS));
    if (ok !== null && ok.startId === etat.startId && ok.projets.some((releve) => normaliser(releve.chemin) === projet)) return "ok";
    const controle = db.prepare("SELECT 1 FROM omo_room_starts WHERE start_id = ? LIMIT 1").get(etat.startId);
    return controle === undefined ? "en-attente" : "refuse";
  };

  /**
   * Balayage git refait par le cockpit À CHAQUE activation (relecture 2 bis-vague-0) : le `workspaceGit` de state.json date du
   * démarrage de la salle, et opencode reste lancé au repos entre deux demandes. Un dépôt apparu depuis hors `gitProteges`
   * (liste d'install.ps1, que la salle ne peut pas réécrire), un balayage tronqué ou une liste illisible → refus.
   */
  const workspaceVerifie = async (): Promise<{ ok: boolean; liste: string[] }> => {
    const prepares = deps.projectsFile === null ? null : analyserProjetsPrepares(await lireBorne(deps.projectsFile, OMO_PROJETS_MAX_OCTETS));
    if (prepares === null) return { ok: false, liste: [] };
    try {
      const gits = await releverGitsWorkspace({ workspace: deps.workspace, ...(deps.bornes ? { bornes: deps.bornes } : {}) });
      const hors = gitsHorsProtection(gits.depots, prepares.gitProteges);
      return { ok: !gits.limiteAtteinte && hors.length === 0, liste: hors.slice(0, OMO_ACTIVATION_LISTE_MAX) };
    } catch (err) {
      log.warn("salle : balayage git du dossier de travail impossible", { error: errorMessage(err) });
      return { ok: false, liste: [] };
    }
  };

  /** Catalogue du compte lu et vérifié auprès de GitHub Copilot, avec au moins une IA Copilot (P1). */
  const catalogueOk = (): boolean => {
    try {
      const catalogue = deps.catalogue();
      return catalogue.loaded && catalogue.sources.copilotVerified && catalogue.list().some((model) => model.providerID === "github-copilot");
    } catch {
      return false;
    }
  };

  /**
   * §3.15.1 l.475 : l'adresse de l'API Copilot retenue par le cockpit (celle du compte) doit être celle que la salle peut joindre,
   * c'est-à-dire l'hôte qu'egress autorise (même source que la 1.0.3, lue au démarrage, D-2b-13). Inconnue → refus.
   */
  const adresseOk = (): boolean => {
    try {
      const autorise = egressHoteAutorise(deps.env.copilotApiUrl ?? undefined, deps.env.githubEnterpriseDomain ?? undefined);
      const retenue = deps.catalogue().sources.endpoint?.url;
      if (autorise === null || typeof retenue !== "string" || retenue === "") return false;
      return new URL(retenue).host.toLowerCase() === new URL(`https://${autorise}`).host.toLowerCase();
    } catch {
      return false;
    }
  };

  /**
   * Garde-fou budgétaire (§4.8.2 : « refus si guardRuns refuse la demande ») : budget mensuel épuisé avec blocage, ou, quand
   * l'envoi dit son modèle, la décision du garde-fou pour ce modèle sans confirmation. Erreur de lecture → refus.
   */
  const budgetRefuse = (modele: ModeleEnvoye | null): boolean => {
    try {
      const { guard } = deps.settings.get().budget;
      if (guard.enabled && guard.blockAtLimit && deps.ledger.percentUsed() >= 100) return true;
      return modele !== null && !deps.ledger.guard(modele, false).allowed;
    } catch (err) {
      log.warn("salle : garde-fou budgétaire illisible", { error: errorMessage(err) });
      return true;
    }
  };

  /**
   * Conditions du §4.14.2 dans leur ordre ; `complet` faux : arrêt à la première fausse (PUT, envoi), sinon toutes (vue). Salle
   * coupée ou autonomie coupée : rien n'est lu ni deviné, même pour la vue.
   */
  const evaluer = async (projet: string, complet: boolean): Promise<Evaluation> => {
    const conditions: Condition[] = [];
    let refus: Evaluation["refus"] = null;
    const noter = (code: OmoActivationRefusalCode, ok: boolean, liste: string[] = []): boolean => {
      conditions.push({ code, ok });
      if (!ok && refus === null) refus = { code, liste };
      return ok || complet;
    };
    const fin = (): Evaluation => ({ conditions, refus });

    if (!salleDisponible()) {
      noter("salle-coupee", false);
      return fin();
    }
    noter("salle-coupee", true);
    if (!deps.env.autonomy) {
      noter("autonomie-coupee", false);
      return fin();
    }
    noter("autonomie-coupee", true);
    if (!noter("salle-suspendue", !suspendue())) return fin();
    if (!noter("demande-active", active === null)) return fin();
    if (!noter("battement-absent", await battementFrais())) return fin();

    const etat = await lireEtat();
    if (etat === null) {
      // État inconnu : la salle n'est pas prête (relance, démarrage) ; tout ce que l'état aurait dit reste non vérifié.
      if (!noter("salle-en-relance", false)) return fin();
      for (const code of ["manifeste", "image-inattendue", "git-inscriptible", "precheck-refuse"] as const) noter(code, false);
    } else {
      if (!noter("manifeste", etat.manifesteReference === "ok" && etat.validation === "ok")) return fin();
      if (!noter("image-inattendue", imageAttendue(etat))) return fin();
      const git = gitProtege(etat, projet);
      if (!noter("git-inscriptible", git.ok, git.liste)) return fin();
      const precheck = await precheckDuProjet(etat, projet);
      if (!noter("precheck-refuse", precheck !== "refuse")) return fin();
      if (!noter("salle-en-relance", etat.phase === "opencode-lance" && precheck === "ok")) return fin();
    }
    const workspace = await workspaceVerifie();
    if (!noter("workspace-non-verifie", workspace.ok, workspace.liste)) return fin();
    if (!noter("catalogue-absent", catalogueOk())) return fin();
    noter("adresse-copilot-changee", adresseOk());
    return fin();
  };

  /** Vue de l'écran d'activation : champ vide la première fois, dernier montant confirmé ensuite, jamais un montant choisi ici. */
  const vueDe = (rootId: string, projet: string, conditions: Condition[]): OmoActivationView => {
    const dernier = deps.settings.get().budget.omo.dernierPlafondUsd;
    const max = plafondMaxUsd();
    return {
      rootId,
      projet,
      dernierPlafondUsd: dernier,
      plafondMaxUsd: max,
      horsBornes: proposePlafond(dernier, max).horsBornes,
      demandeActive: active !== null,
      conditions,
    };
  };

  const refusPut = (status: OmoActivationRefus["status"], code: OmoActivationRefus["code"], liste?: string[]): OmoActivationRefus => ({
    ok: false,
    status,
    code,
    ...(liste !== undefined && liste.length > 0 ? { liste } : {}),
  });

  const put: OmoActivationService["put"] = async (rootId, body, options) => {
    if (options.mode !== "avance") return refusPut(403, "mode-avance");
    if (!SESSION_ID_RE.test(rootId) || !isRecord(body) || body.choix !== "omo") return refusPut(400, "invalid");
    if (!salleDisponible()) return refusPut(409, "salle-coupee");
    if (!deps.env.autonomy) return refusPut(409, "autonomie-coupee");
    // À CHAQUE demande (§4.14.2, T-L22-d) : sans l'en-tête, rien n'est vérifié ni préparé.
    if (!options.confirmed) return refusPut(409, "confirmation-requise");
    const projet = projetDeSalle(db, rootId);
    if (projet === null) return refusPut(409, "racine-hors-salle");
    return enFile(async () => {
      const evaluation = await evaluer(projet, false);
      if (evaluation.refus !== null) return refusPut(409, evaluation.refus.code, evaluation.refus.liste);
      const saisie: unknown = (body as { plafondUsd?: unknown }).plafondUsd;
      // Montant : chaîne saisie seulement ; absent = champ vide. Jamais un flottant JSON, jamais un montant complété.
      if (saisie !== undefined && typeof saisie !== "string") return refusPut(409, "plafond-invalide");
      const montant = validatePlafond(saisie ?? "", { plafondMaxUsd: plafondMaxUsd(), guardRuns: budgetRefuse(null) ? "refus" : "ok" });
      if (!montant.ok) return refusPut(409, montant.code);
      jetons.set(rootId, { saisie: saisie ?? "", expireA: now() + OMO_JETON_DUREE_MS });
      consommes.delete(rootId);
      log.info("salle : activation confirmée, en attente de l'envoi", { rootId });
      return { ok: true, view: vueDe(rootId, projet, [...evaluation.conditions, { code: "budget-mensuel", ok: true }]) };
    });
  };

  /** Envoi d'une demande de la salle : jeton pris d'abord (usage unique), puis chaque condition et le montant revérifiés. */
  const consommer = async (rootId: string, contexte: { mode: UiMode; modele: ModeleEnvoye | null }): Promise<{ ok: true; requestId: string } | RefusEnvoi> => {
    const refuser = (code: OmoActivationRefusalCode, liste: string[] = []): RefusEnvoi => ({ ok: false, code, liste });
    // Pris AVANT toute autre vérification, de façon synchrone, avant toute attente : quoi qu'il arrive ensuite (mode, salle,
    // conditions, montant), ce jeton ne servira plus (D-2b-07).
    const jeton = jetons.get(rootId);
    jetons.delete(rootId);
    // Un jeton présenté a servi, quelle que soit la suite : le prochain envoi sans confirmation s'entend dire « déjà servi ».
    if (jeton !== undefined) consommes.add(rootId);
    if (contexte.mode !== "avance") return refuser("mode-avance");
    if (!SESSION_ID_RE.test(rootId)) return refuser("racine-hors-salle");
    if (!salleDisponible()) return refuser("salle-coupee");
    if (!deps.env.autonomy) return refuser("autonomie-coupee");
    if (jeton === undefined) return refuser(consommes.has(rootId) ? "jeton-consomme" : "confirmation-requise");
    if (jeton.expireA < now()) return refuser("confirmation-requise");
    const projet = projetDeSalle(db, rootId);
    if (projet === null) return refuser("racine-hors-salle");
    return enFile(async () => {
      const evaluation = await evaluer(projet, false);
      if (evaluation.refus !== null) return refuser(evaluation.refus.code, evaluation.refus.liste);
      // Montant relu contre la borne et le garde-fou EN VIGUEUR (la borne a pu baisser depuis la confirmation).
      const montant = validatePlafond(jeton.saisie, { plafondMaxUsd: plafondMaxUsd(), guardRuns: budgetRefuse(contexte.modele) ? "refus" : "ok" });
      if (!montant.ok) return refuser(montant.code);
      const requestId = randomUUID();
      const debut = now();
      // Marquée AVANT d'être active : si l'écriture échoue, rien ne part (le crochet lève, le proxy ne relaie pas).
      store.writeOmo(rootId, { plafondUsd: jeton.saisie, demande: { id: requestId, debut }, depuis: debut, retourCause: null });
      active = { rootId, requestId, startedAt: debut, plafondUsd: jeton.saisie };
      try {
        // D-2b-11 : SEUL écrivain de ce réglage, et seulement ici, activation confirmée par l'envoi.
        deps.settings.update({ budget: { omo: { dernierPlafondUsd: jeton.saisie } } });
      } catch (err) {
        log.warn("salle : dernier montant d'arrêt non enregistré", { error: errorMessage(err) });
      }
      log.info("salle : demande lancée", { rootId, requestId });
      return { ok: true, requestId };
    });
  };

  const hook: HookSignatures["beforeBilledSend"] = async (ctx) => {
    // Le câblage n'appelle ce crochet que pour la salle ; sans contexte de la salle, rien n'est jugé ici.
    if (ctx.instance !== "omo") return null;
    const sessionId = ctx.sessionId;
    const rootId = sessionId === null ? null : deps.sessions.rootOf(sessionId);
    // Une demande de la salle part sur la racine de la salle, jamais sur une conversation de l'extension : le jeton n'y est pas pris.
    const verdict =
      rootId === null || rootId !== sessionId
        ? ({ ok: false, code: "racine-hors-salle", liste: [] } satisfies RefusEnvoi)
        : await consommer(rootId, { mode: deps.settings.get().ui.mode, modele: modeleDuCorps(ctx.body) });
    if (verdict.ok) return null;
    log.info("salle : envoi refusé, rien n'est envoyé", { code: verdict.code });
    const projet = rootId === null ? null : projetDeSalle(db, rootId);
    return ctx.c.json(corpsRefusSalle(verdict.code, { projet, plafondMaxUsd: plafondMaxUsd(), liste: verdict.liste }), statutRefusSalle(verdict.code));
  };

  return {
    async view(rootId) {
      const projet = SESSION_ID_RE.test(rootId) ? projetDeSalle(db, rootId) : null;
      if (projet === null) return null;
      const evaluation = await evaluer(projet, true);
      const conditions = [...evaluation.conditions];
      // Garde-fou budgétaire, sans modèle (l'envoi dira le sien) : lu par l'écran pour refuser avant d'envoyer (L26a). Salle ou
      // autonomie coupée : rien d'autre n'est relevé.
      const coupee = conditions.some((condition) => (condition.code === "salle-coupee" || condition.code === "autonomie-coupee") && !condition.ok);
      if (!coupee) conditions.push({ code: "budget-mensuel", ok: !budgetRefuse(null) });
      return vueDe(rootId, projet, conditions);
    },
    put,
    async consume(rootId): Promise<OmoConsumeResult> {
      const verdict = await consommer(rootId, { mode: deps.settings.get().ui.mode, modele: null });
      return verdict.ok ? { ok: true, requestId: verdict.requestId } : { ok: false, code: verdict.code };
    },
    activeRequest: () => (active === null ? null : { ...active }),
    endRequest(rootId: string, fin: RequestEnd) {
      if (active === null || active.rootId !== rootId) return;
      const finie = active;
      active = null;
      const retourCause: ChoiceCause | null = fin === "interrompue" || fin === "redemarrage-cockpit" ? "interrompue" : null;
      try {
        store.writeOmo(rootId, { plafondUsd: finie.plafondUsd, demande: null, depuis: finie.startedAt, retourCause });
      } catch (err) {
        log.warn("salle : fin de demande non écrite", { rootId, error: errorMessage(err) });
      }
      log.info("salle : demande terminée", { rootId, requestId: finie.requestId, fin });
    },
    hook,
  };
}

// --- Module ----------------------------------------------------------------------------------------------------------------------

/**
 * Installe l'activation réelle : seulement salle configurée (dossiers de contrôle, COCKPIT_OMO=on) ET ouverte (SALLE_OUVERTE).
 * Dans le dépôt, la porte est fausse : le port NEUTRE reste en place et rien n'est inscrit (wiring-11.test.ts, test
 * « production »). `surcharges` (tests) : dépendances remplacées ; `salleOuverte` fourni ouvre la salle pour ce câblage seul.
 */
export function installOmoActivation(reg: Registrar, c11: Cockpit11, surcharges: Partial<OmoActivationDeps> = {}): OmoActivationService | null {
  const dirs = c11.omoControlDirs ?? null;
  if (dirs === null || (surcharges.salleOuverte === undefined && !c11.salleOuverte)) return null;
  const service = createOmoActivation({
    db: c11.db,
    sessions: c11.sessions,
    settings: c11.settings,
    ledger: c11.ledger,
    log: c11.log,
    env: c11.env,
    image: omoOf(c11.env).image,
    workspace: c11.env.workspaceDir,
    controlDir: dirs.controlDir,
    projectsFile: dirs.projectsFile ?? null,
    ports: () => c11.ports,
    instance: () => c11.instances?.omo ?? null,
    catalogue: () => c11.catalog,
    salleOuverte: () => c11.salleOuverte,
    ...surcharges,
  });
  c11.ports.omoActivation = service;
  reg.hook("beforeBilledSend", service.hook, { instances: ["omo"] });
  return service;
}

export const omoActivationModule: Cockpit11Module = {
  name: "omoActivation",
  install(reg, c11) {
    installOmoActivation(reg, c11);
  },
};
