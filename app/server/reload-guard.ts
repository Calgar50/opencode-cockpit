// Garde « réponse en cours » (spécification 1.1 §3.11) : un changement qui recharge ou redémarre opencode couperait les
// réponses en cours. Refus 409 ; en mode Avancé seulement, dérogation explicite par x-cockpit-confirm: 1. Réponses en cours
// impossibles à vérifier (opencode répond, conversations illisibles) : refus distinct avec un message vrai ; pour le redémarrage
// d'opencode (le remède d'un opencode bloqué), la confirmation y est acceptée même en mode Simple (décision du 15/09).
import type { MiddlewareHandler } from "hono";
import type { SessionsOccupancy } from "./assistants.ts";
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
   * « busy » : une réponse lue n'est pas au repos, ou une demande facturée est en vol ; « unverifiable » : un dossier illisible
   * alors qu'un autre a répondu ; rejetée si aucun dossier n'a pu être lu (probeSessionsBusyStrict).
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
}

/**
 * 409 redemarrage-en-cours ; 409 sessions-busy (dérogation possible : mode Avancé) ; 409 reponses-non-verifiables (dérogation
 * possible : mode Avancé, ou les deux modes avec `confirmUnverifiable`). `override` dit si une confirmation serait acceptée.
 */
export function reloadGuard(deps: ReloadGuardDeps, options: ReloadGuardOptions = {}): MiddlewareHandler {
  return async (c, next) => {
    if (deps.control.restarting) return c.json({ error: "redemarrage-en-cours", message: MESSAGES.restartEnCours }, 409);
    const advanced = isAdvanced(deps.settings);
    const confirmed = c.req.header(CONFIRM_HEADER) === "1";
    if (!(advanced && confirmed)) {
      const occupancy = await deps.occupancy().catch(async (err: unknown): Promise<SessionsOccupancy> => {
        // Aucun dossier lisible : seul opencode entièrement injoignable laisse passer (aucune réponse à couper, et le redémarrer
        // est justement le remède). opencode qui répond : l'absence de réponse en cours n'est pas vérifiable.
        const reachable = await deps.reachable().catch(() => true);
        deps.log.warn(
          reachable
            ? "garde « réponse en cours » : conversations illisibles alors qu'opencode répond"
            : "garde « réponse en cours » : opencode injoignable, rechargement laissé passer",
          { path: c.req.path, error: errorMessage(err) },
        );
        return reachable ? "unverifiable" : "idle";
      });
      if (occupancy === "busy") return c.json({ error: "sessions-busy", message: MESSAGES.reloadBusy, override: advanced }, 409);
      if (occupancy === "unverifiable") {
        const remedy = options.confirmUnverifiable === true;
        if (!(remedy && confirmed)) {
          deps.log.warn("garde « réponse en cours » : réponses en cours non vérifiables, rechargement refusé", { path: c.req.path });
          const message = remedy ? MESSAGES.restartUnverifiable : MESSAGES.reloadUnverifiable;
          return c.json({ error: UNVERIFIABLE_ERROR, message, override: advanced || remedy }, 409);
        }
        deps.log.warn("garde « réponse en cours » : redémarrage confirmé sans pouvoir vérifier les réponses en cours", { path: c.req.path });
      }
    }
    await next();
  };
}

/** La garde pour ces méthodes seulement (chemin partagé entre lecture et écriture). */
export function forMethods(methods: readonly string[], guard: MiddlewareHandler): MiddlewareHandler {
  return (c, next) => (methods.includes(c.req.method) ? guard(c, next) : next());
}
