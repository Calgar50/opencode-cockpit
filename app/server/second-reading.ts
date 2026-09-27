// Propriétaire : L44c.
// Seconde lecture (itération 5, plan d'exécution it5 D-5-06, D-5-22, §4.2, §4.3 ; spécification §7.9 ; C §9.7, §14 ; RM §5.4).
// Voie principale, tenue par la mesure MC5-1 (train de V0 de 5a, `mesures/MC5.md`) : une seconde lecture est un message ORDINAIRE
// envoyé à l'assistant « Relecteur critique » DANS LA MÊME conversation, par le proxy, avec la garde 1.0. Le cockpit n'ouvre
// aucun chemin facturé propre (P5) et n'ajoute aucun en-tête : il se contente de reconnaître l'envoi et de requalifier la ligne
// `chat_turns` que le proxy vient d'écrire, pour que le composeur retrouve ensuite l'assistant précédent.
// Deux inscriptions, et rien d'autre :
// - crochet `beforeBilledSend`, EN TÊTE de la chaîne (wiring-construction.ts, posé dans STEP_ORDER par l'intégrateur) : il rend
//   TOUJOURS null (aucun refus nouveau ; la garde budgétaire d'`enforceTurn` a déjà parlé avant lui) et ne fait qu'un UPDATE.
//   En queue, il était sauté dès qu'un crochet antérieur refusait (`runHooks` s'arrête au premier refus) : la ligne restait
//   « message » au nom du Relecteur et le composeur basculait sur lui après une relecture qui n'était jamais partie ;
// - route POST /api/chat/second-reading/estimate : coût estimé, lecture seule, deux modes.
// Le montant est une ESTIMATION, jamais un minimum (D-5-22) : l'entrée du Relecteur n'est pas celle de l'assistant précédent
// (autres consignes, aucun cache hérité) et opencode peut élaguer l'historique. Les phrases sont dans construction-texts.ts.
import type { DatabaseSync } from "node:sqlite";
import type { Context, Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod";
import type { ConstructionModule } from "./construction-contracts.ts";
import type { Cockpit11, ProxyContext } from "./contracts-11.ts";
import type { OcLookupSnapshot } from "./oc-lookup.ts";
import { computeCost, type ModelPrice, roundUsd } from "./pricing.ts";
import {
  estimateTaskCost,
  MESSAGES,
  modelKey,
  modelName,
  OBSERVED_MIN_SAMPLES,
  parseModelKey,
  TASK_PROFILES,
  type Tier,
  TIER_IDS,
} from "./shared/assistant-rules.ts";
import { CONSTRUCTION_ROUTE_PATHS, SECOND_READING_CATALOG_ID, SECOND_READING_TURN_KIND } from "./shared/construction-constants.ts";
import { secondReadingPrefix } from "./shared/construction-texts.ts";
import type { AssistantRef, SecondReadingEstimate, SecondReadingTarget } from "./shared/construction-types.ts";
import { SESSION_ID_RE } from "./shared/ids.ts";

/** Taille du profil S : la relecture porte sur un travail déjà rédigé (entrée du catalogue « Relecteur critique », L45a). */
const SECOND_READING_SIZE = "S" as const;

/**
 * Âge maximum de la ligne `chat_turns` requalifiée. `enforceTurn` l'écrit juste avant les crochets, dans la même requête :
 * quelques millisecondes séparent les deux. Cette borne garde le crochet d'attraper une demande PLUS ANCIENNE du même assistant
 * dans la même conversation (renvoi après un 409, deuxième onglet) si, pour une raison quelconque, l'écriture avait échoué.
 */
export const SECOND_READING_MAX_AGE_MS = 5_000;

/** Corps accepté par la route d'estimation : un dossier, une conversation, un objet relu. */
const DIRECTORY_MAX = 4096;
const BODY_MAX = 8 * 1024;

const CIBLES = ["reponse", "equipe"] as const satisfies readonly SecondReadingTarget[];

/**
 * `cible` est validée et n'entre pas dans le calcul : sur la voie principale, le Relecteur reçoit le MÊME historique qu'il relise
 * une réponse d'assistant ou un résultat d'équipe, donc le même contexte et le même montant. Elle reste au contrat parce que
 * l'interface en tire la variante du message et de l'infobulle, et qu'un corps sans elle serait une demande incomplète.
 */
const estimateBodySchema = z.strictObject({
  directory: z.string().min(1).max(DIRECTORY_MAX),
  sessionId: z.string().regex(SESSION_ID_RE),
  cible: z.enum(CIBLES),
});

/** Aucune estimation : le Relecteur critique n'est pas installé, ou aucun prix ne permet de chiffrer (D-5-22). */
const SANS_ESTIMATION: SecondReadingEstimate = { installe: false, assistant: null, ia: null, usd: null, base: "aucune" };

/** Ligne `item_meta` de l'assistant venu du catalogue sous l'identifiant « relecteur-critique ». */
interface RelecteurRow {
  name: string;
  title: string | null;
  tier: string | null;
}

/** Dernière ligne `usage` retenue pour la base « conversation ». */
interface DerniereLigne {
  tokens_input: number;
  tokens_output: number;
  tokens_cache_read: number;
  tokens_cache_write: number;
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

/** Niveau d'IA lu dans `item_meta` : une valeur inconnue (ou une IA précise, colonne vide) ne fixe aucun niveau. */
const tierOf = (value: string | null): Tier | null => TIER_IDS.find((id) => id === value) ?? null;

/**
 * Assistant installé dont `item_meta.catalog_id` vaut « relecteur-critique » (requête paramétrée). Un seul peut exister :
 * `AssistantService.install` rend l'assistant déjà posé au lieu d'en créer un second. Le titre absent = ligne d'un élément qui
 * n'est pas un assistant : elle ne compte pas.
 */
function relecteurRow(db: DatabaseSync): RelecteurRow | null {
  const row = db
    .prepare("SELECT name, title, tier FROM item_meta WHERE kind = 'agents' AND catalog_id = ? AND title IS NOT NULL ORDER BY name LIMIT 1")
    .get(SECOND_READING_CATALOG_ID) as RelecteurRow | undefined;
  return row ?? null;
}

/** Première partie texte du corps relayé (`parts`), telle qu'opencode la lira ; « » si le corps n'en porte aucune. */
function premierTexte(body: Record<string, unknown>): string {
  const parts = Array.isArray(body.parts) ? body.parts : [];
  for (const part of parts) {
    if (!isRecord(part) || part.type !== "text") continue;
    return typeof part.text === "string" ? part.text : "";
  }
  return "";
}

/** Le texte ouvre-t-il par le début fixe d'un message de seconde lecture (réponse d'un assistant ou résultat d'une équipe) ? */
export function estMessageDeSecondeLecture(texte: string): boolean {
  return CIBLES.some((cible) => texte.startsWith(secondReadingPrefix(cible)));
}

/**
 * Requalifie la ligne `kind = 'message'` la plus récente de CETTE conversation et de CET assistant, écrite depuis moins de 5 s :
 * celle qu'`enforceTurn` vient d'écrire pour cet envoi. Une seule ligne au plus change (sous-requête `LIMIT 1`), donc jamais
 * celle d'une autre conversation menée en même temps. Rend le nombre de lignes modifiées (0 ou 1).
 */
export function requalifierTour(db: DatabaseSync, sessionId: string, agent: string, now: number): number {
  const changed = db
    .prepare(
      `UPDATE chat_turns SET kind = ?
       WHERE id = (SELECT id FROM chat_turns
                   WHERE session_id = ? AND agent = ? AND kind = 'message' AND created_at >= ?
                   ORDER BY created_at DESC, id DESC LIMIT 1)`,
    )
    .run(SECOND_READING_TURN_KIND, sessionId, agent, now - SECOND_READING_MAX_AGE_MS);
  return Number(changed.changes);
}

export interface SecondReadingService {
  /**
   * Crochet `beforeBilledSend`, EN TÊTE de la chaîne. Rend TOUJOURS null : la Seconde lecture n'ajoute aucun refus, la garde 1.0
   * s'applique déjà (`enforceTurn` a écrit la ligne `chat_turns` AVANT les crochets, et refuse lui-même avant d'y arriver).
   * En tête, la requalification a lieu même quand un crochet suivant refuse l'envoi : la ligne décrit une TENTATIVE de seconde
   * lecture, qu'elle parte ou non, et le composeur retrouve l'assistant précédent dans les deux cas.
   */
  beforeBilledSend(ctx: ProxyContext): Promise<Response | null>;
  /** Coût estimé d'une seconde lecture partant de cette conversation. */
  estimate(body: unknown): Promise<{ ok: true; value: SecondReadingEstimate } | { ok: false; status: 400 | 403 | 502; error: string; message: string }>;
}

export function createSecondReadingService(c11: Cockpit11, options: { now?: () => number } = {}): SecondReadingService {
  const now = options.now ?? Date.now;
  const { db, log, lookup, ledger, settings, tiers, catalog, projects } = c11;

  /** Prix effectif d'une IA (grille officielle, tarif saisi ou catalogue opencode) ; null : IA inconnue de toutes les sources. */
  const priceOf = (model: string): ModelPrice | null => tiers.priceOf(model);

  /**
   * Dernière ligne `usage` de la conversation d'où part la seconde lecture : `session_id` exactement, jamais `root_id`. Une ligne
   * d'une session enfant (sous-agent, étape d'équipe) n'est PAS dans l'historique que le Relecteur recevra. Terminée
   * (`completed_at` non nul) et à jetons non nuls : une ligne en cours ou vide ne dit rien de la longueur. Requête paramétrée.
   */
  const derniereLigne = (sessionId: string): DerniereLigne | null => {
    const row = db
      .prepare(
        `SELECT tokens_input, tokens_output, tokens_cache_read, tokens_cache_write
         FROM usage
         WHERE session_id = ? AND completed_at IS NOT NULL
           AND (tokens_input + tokens_output + tokens_cache_read + tokens_cache_write) > 0
         ORDER BY created_at DESC, message_id DESC LIMIT 1`,
      )
      .get(sessionId) as DerniereLigne | undefined;
    return row ?? null;
  };

  /**
   * Base « conversation » (D-5-22, premier choix) : le contexte du Relecteur vaut tout ce qu'a vu le dernier appel, RÉPONSE
   * COMPRISE (elle entre dans l'historique), soit `tokens_input + tokens_cache_read + tokens_cache_write + tokens_output`. Il est
   * compté EN ÉCRITURE DE CACHE : le Relecteur n'hérite pas du cache de l'assistant précédent. S'y ajoute la sortie du profil S.
   */
  const coutConversation = (ligne: DerniereLigne, price: ModelPrice): number => {
    const contexte = ligne.tokens_input + ligne.tokens_cache_read + ligne.tokens_cache_write + ligne.tokens_output;
    return computeCost({ input: 0, cacheRead: 0, cacheWrite: contexte, output: TASK_PROFILES[SECOND_READING_SIZE].output, reasoning: 0 }, price);
  };

  const beforeBilledSend: SecondReadingService["beforeBilledSend"] = async (ctx) => {
    try {
      // Seul un envoi de message porte des parties de texte : un raccourci (`/command`) et un résumé n'en ont pas.
      const sessionId = ctx.sessionId;
      if (sessionId === null || !ctx.sub.endsWith("/prompt_async")) return null;
      const agent = typeof ctx.body.agent === "string" ? ctx.body.agent : null;
      if (agent === null) return null;
      const relecteur = relecteurRow(db);
      // Ni le relecteur installé, ni un autre assistant qui recopierait la phrase : la ligne reste un message ordinaire.
      if (!relecteur || relecteur.name !== agent) return null;
      if (!estMessageDeSecondeLecture(premierTexte(ctx.body))) return null;
      const changed = requalifierTour(db, sessionId, agent, now());
      if (changed === 0) log.warn("seconde lecture : aucune demande récente à requalifier", { agent });
    } catch (err) {
      // Une requalification manquée ne doit jamais empêcher un envoi déjà contrôlé et facturé.
      log.warn("seconde lecture : demande non requalifiée", { error: err instanceof Error ? err.message : String(err) });
    }
    return null;
  };

  const estimate: SecondReadingService["estimate"] = async (body) => {
    const parsed = estimateBodySchema.safeParse(body);
    if (!parsed.success) return { ok: false, status: 400, error: "invalid", message: "Requête invalide." };
    if (!projects.isAllowedDirectory(parsed.data.directory)) {
      return { ok: false, status: 403, error: "forbidden-directory", message: "Ce dossier est hors du workspace monté." };
    }
    const row = relecteurRow(db);
    if (!row) return { ok: true, value: SANS_ESTIMATION };

    let snapshot: OcLookupSnapshot;
    try {
      snapshot = await lookup.get(parsed.data.directory);
    } catch {
      return { ok: false, status: 502, error: "opencode-unreachable", message: MESSAGES.opencodeInjoignable };
    }
    // « Installé » a le même sens que dans le catalogue des assistants : une ligne item_meta ET un fichier d'agent vu par opencode.
    const agent = snapshot.agents.find((a) => a.name === row.name && a.mode !== "subagent");
    if (!agent) return { ok: true, value: SANS_ESTIMATION };

    const assistant: AssistantRef = { name: row.name, title: row.title ?? row.name };
    // IA résolue comme pour le chat : l'IA propre de l'assistant l'emporte, sinon son niveau (« Rapide » pour le Relecteur), sinon
    // le niveau par défaut du chat. Un niveau indisponible ne rend aucune IA : le montant est alors sans base.
    const tier = tierOf(row.tier) ?? settings.get().ai.chatDefaultTier;
    const model = agent.model ? modelKey(agent.model) : tiers.resolve(tier).model;
    if (!model) return { ok: true, value: { ...SANS_ESTIMATION, installe: true, assistant } };
    const ia = { model, libelle: modelName(model, catalog.lite()) };
    const chiffre = (usd: number, base: SecondReadingEstimate["base"]): { ok: true; value: SecondReadingEstimate } => ({
      ok: true,
      value: { installe: true, assistant, ia, usd, base },
    });

    const price = priceOf(model);
    // Ordre de D-5-22 : longueur actuelle de la conversation, sinon relectures observées, sinon profil S.
    const ligne = derniereLigne(parsed.data.sessionId);
    if (ligne && price) return chiffre(coutConversation(ligne, price), "conversation");
    const observe = ledger.estimateAgent(row.name, parseModelKey(model));
    if (observe.avgUsd !== null && observe.samples >= OBSERVED_MIN_SAMPLES) return chiffre(roundUsd(observe.avgUsd), "observe");
    if (price) return chiffre(estimateTaskCost(price, SECOND_READING_SIZE), "profil");
    return { ok: true, value: { installe: true, assistant, ia, usd: null, base: "aucune" } };
  };

  return { beforeBilledSend, estimate };
}

/** Route d'estimation : mince, les deux modes, CSRF et session posés par les gardes globales de http.ts. */
export function registerSecondReadingRoutes(app: Hono, service: SecondReadingService): void {
  const tooLong = (c: Context) => c.json({ error: "invalid", message: "Requête trop longue." }, 413);
  app.post(CONSTRUCTION_ROUTE_PATHS.secondeLectureEstimation, bodyLimit({ maxSize: BODY_MAX, onError: tooLong }), async (c) => {
    let body: unknown;
    try {
      body = JSON.parse(await c.req.text()) as unknown;
    } catch {
      return c.json({ error: "invalid", message: "Requête invalide." }, 400);
    }
    const result = await service.estimate(body);
    if (!result.ok) return c.json({ error: result.error, message: result.message }, result.status);
    return c.json(result.value);
  });
}

export const secondReadingModule: ConstructionModule = {
  name: "secondReading",
  install(reg, c11) {
    const service = createSecondReadingService(c11);
    reg.hook("beforeBilledSend", (ctx) => service.beforeBilledSend(ctx));
    reg.routes("construction", (app) => registerSecondReadingRoutes(app, service));
  },
};
