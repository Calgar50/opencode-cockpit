// Garde « réponse en cours » (spécification 1.1 §3.11) : un changement qui recharge ou redémarre opencode couperait les
// réponses en cours. Refus 409 ; en mode Avancé seulement, dérogation explicite par x-cockpit-confirm: 1. Réponses en cours
// impossibles à vérifier (opencode répond, conversations illisibles) : refus distinct avec un message vrai ; pour le redémarrage
// d'opencode (le remède d'un opencode bloqué), la confirmation y est acceptée même en mode Simple (décision du 15/09).
// La vérification est refaite après l'attente dans la file d'écriture de la configuration, `applying` posé (L1a) : une réponse
// commencée pendant l'attente n'est jamais coupée, et aucune demande facturée ne peut commencer entre la vérification et le
// rechargement.
import type { MiddlewareHandler } from "hono";
import type { SessionsOccupancy } from "./assistants.ts";
import type { ConfigWriteQueue } from "./config-queue.ts";
import type { ControlService } from "./control.ts";
import { errorMessage, type Logger } from "./log.ts";
import { isAdvanced } from "./mode.ts";
import { CONFIRM_HEADER } from "./security.ts";
import type { SettingsStore } from "./settings.ts";
import { MESSAGES } from "./shared/assistant-rules.ts";

/** Code du refus quand l'absence de réponse en cours n'est pas vérifiable (jamais « des réponses sont en cours »). */
export const UNVERIFIABLE_ERROR = "reponses-non-verifiables";

export interface ReloadGuardDeps {
  settings: Pick<SettingsStore, "get">;
  control: Pick<ControlService, "restarting">;
  /**
   * « busy » : une réponse lue n'est pas au repos, une demande facturée est en vol ou une décision est en examen ;
   * « unverifiable » : un dossier illisible alors qu'un autre a répondu ; rejetée si aucun dossier n'a pu être lu
   * (probeSessionsBusyStrict).
   */
  occupancy: () => Promise<SessionsOccupancy>;
  /** true si opencode répond (GET /global/health). */
  reachable: () => Promise<boolean>;
  log: Pick<Logger, "warn">;
}

export interface ReloadGuardOptions {
  /**
   * Réponses en cours non vérifiables : x-cockpit-confirm accepté dans les deux modes. Réservé à POST
   * /api/system/restart-opencode (le remède) ; jamais quand une réponse est lue en cours ou qu'une demande facturée est en vol.
   */
  confirmUnverifiable?: boolean;
  /**
   * Garde tenue (Studio, assistants) : après une première vérification, attente de la file d'écriture de la configuration, puis
   * vérification refaite `applying` posé, gardé jusqu'à la fin de la requête (rechargement compris).
   */
  hold?: Pick<ConfigWriteQueue, "run" | "applyingWhile">;
}

/** Corps d'un refus 409 de la garde. `override` : une confirmation serait acceptée. */
export interface ReloadRefusal {
  error: "redemarrage-en-cours" | "sessions-busy" | typeof UNVERIFIABLE_ERROR;
  message: string;
  override?: boolean;
}

/** Requête gardée : confirmation présente, chemin (journal). */
export interface ReloadRequest {
  confirmed: boolean;
  path: string;
}

/**
 * Décision de la garde (null : rechargement permis). 409 redemarrage-en-cours ; 409 sessions-busy (dérogation possible : mode
 * Avancé) ; 409 reponses-non-verifiables (dérogation possible : mode Avancé, ou les deux modes avec `confirmUnverifiable`).
 */
export async function reloadRefusal(deps: ReloadGuardDeps, options: ReloadGuardOptions, request: ReloadRequest): Promise<ReloadRefusal | null> {
  if (deps.control.restarting) return { error: "redemarrage-en-cours", message: MESSAGES.restartEnCours };
  const advanced = isAdvanced(deps.settings);
  const { confirmed, path } = request;
  if (advanced && confirmed) return null;
  const occupancy = await deps.occupancy().catch(async (err: unknown): Promise<SessionsOccupancy> => {
    // Aucun dossier lisible : seul opencode entièrement injoignable laisse passer (aucune réponse à couper, et le redémarrer
    // est justement le remède). opencode qui répond : l'absence de réponse en cours n'est pas vérifiable.
    const reachable = await deps.reachable().catch(() => true);
    deps.log.warn(
      reachable
        ? "garde « réponse en cours » : conversations illisibles alors qu'opencode répond"
        : "garde « réponse en cours » : opencode injoignable, rechargement laissé passer",
      { path, error: errorMessage(err) },
    );
    return reachable ? "unverifiable" : "idle";
  });
  if (occupancy === "busy") return { error: "sessions-busy", message: MESSAGES.reloadBusy, override: advanced };
  if (occupancy === "unverifiable") {
    const remedy = options.confirmUnverifiable === true;
    if (!(remedy && confirmed)) {
      deps.log.warn("garde « réponse en cours » : réponses en cours non vérifiables, rechargement refusé", { path });
      const message = remedy ? MESSAGES.restartUnverifiable : MESSAGES.reloadUnverifiable;
      return { error: UNVERIFIABLE_ERROR, message, override: advanced || remedy };
    }
    deps.log.warn("garde « réponse en cours » : redémarrage confirmé sans pouvoir vérifier les réponses en cours", { path });
  }
  return null;
}

/** La garde en middleware : refus 409 avec le corps de reloadRefusal ; garde tenue avec `hold`. */
export function reloadGuard(deps: ReloadGuardDeps, options: ReloadGuardOptions = {}): MiddlewareHandler {
  return async (c, next) => {
    const request: ReloadRequest = { confirmed: c.req.header(CONFIRM_HEADER) === "1", path: c.req.path };
    const refused = await reloadRefusal(deps, options, request);
    if (refused) return c.json(refused, 409);
    const { hold } = options;
    if (!hold) {
      await next();
      return;
    }
    // Application de la configuration en cours (redémarrage, correctif, synchro de l'adresse Copilot) : attendue d'abord.
    await hold.run(async () => undefined);
    return hold.applyingWhile(async () => {
      // Vérification refaite, applying posé : une réponse commencée pendant l'attente refuse le rechargement, et aucune demande
      // facturée n'est plus admise jusqu'à la fin de la requête.
      const again = await reloadRefusal(deps, options, request);
      if (again) return c.json(again, 409);
      await next();
      return undefined;
    });
  };
}

/** La garde pour ces méthodes seulement (chemin partagé entre lecture et écriture). */
export function forMethods(methods: readonly string[], guard: MiddlewareHandler): MiddlewareHandler {
  return (c, next) => (methods.includes(c.req.method) ? guard(c, next) : next());
}

/**
 * Prédicat d'occupation de la garde, le même pour les routes, le Studio et les modules 1.1 : demande facturée en vol ou décision en
 * examen (reloadBusy) → « busy », jamais « non vérifiable » ; sinon la sonde stricte. Un reloadBusy qui lève compte comme occupé.
 */
export function reloadOccupancy(deps: {
  queue: Pick<ConfigWriteQueue, "billedInFlight">;
  reloadBusy?: () => boolean;
  probe: () => Promise<SessionsOccupancy>;
}): () => Promise<SessionsOccupancy> {
  return async () => (deps.queue.billedInFlight > 0 || examining(deps.reloadBusy) ? "busy" : await deps.probe());
}

/** reloadBusy lu sans lever : absent = false, erreur = true (jamais « au repos » par défaut). */
export function examining(reloadBusy: (() => boolean) | undefined): boolean {
  if (!reloadBusy) return false;
  try {
    return reloadBusy() === true;
  } catch {
    return true;
  }
}
