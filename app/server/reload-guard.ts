// Garde « réponse en cours » (spécification 1.1 §3.11) : un changement qui recharge ou redémarre opencode couperait les
// réponses en cours. Refus 409 ; en mode Avancé seulement, dérogation explicite par x-cockpit-confirm: 1.
import type { MiddlewareHandler } from "hono";
import type { ControlService } from "./control.ts";
import { errorMessage, type Logger } from "./log.ts";
import { isAdvanced } from "./mode.ts";
import { CONFIRM_HEADER } from "./security.ts";
import type { SettingsStore } from "./settings.ts";
import { MESSAGES } from "./shared/assistant-rules.ts";

export interface ReloadGuardDeps {
  settings: Pick<SettingsStore, "get">;
  control: Pick<ControlService, "restarting">;
  /**
   * true si une conversation n'est pas au repos, ou si un dossier est illisible alors qu'un autre a répondu ; rejetée si aucun
   * dossier n'a pu être lu (probeSessionsBusyStrict).
   */
  busy: () => Promise<boolean>;
  /** true si opencode répond (GET /global/health). */
  reachable: () => Promise<boolean>;
  log: Pick<Logger, "warn">;
}

/** 409 redemarrage-en-cours, ou 409 sessions-busy avec `override` (dérogation possible : mode Avancé). */
export function reloadGuard(deps: ReloadGuardDeps): MiddlewareHandler {
  return async (c, next) => {
    if (deps.control.restarting) return c.json({ error: "redemarrage-en-cours", message: MESSAGES.restartEnCours }, 409);
    const advanced = isAdvanced(deps.settings);
    if (!(advanced && c.req.header(CONFIRM_HEADER) === "1")) {
      const busy = await deps.busy().catch(async (err: unknown) => {
        // Aucun dossier lisible : seul opencode entièrement injoignable laisse passer (aucune réponse à couper, et le redémarrer
        // est justement le remède). opencode qui répond : l'absence de réponse en cours n'est pas prouvée, refus.
        const reachable = await deps.reachable().catch(() => true);
        deps.log.warn(
          reachable
            ? "garde « réponse en cours » : conversations illisibles alors qu'opencode répond, rechargement refusé"
            : "garde « réponse en cours » : opencode injoignable, rechargement laissé passer",
          { path: c.req.path, error: errorMessage(err) },
        );
        return reachable;
      });
      if (busy) return c.json({ error: "sessions-busy", message: MESSAGES.reloadBusy, override: advanced }, 409);
    }
    await next();
  };
}

/** La garde pour ces méthodes seulement (chemin partagé entre lecture et écriture). */
export function forMethods(methods: readonly string[], guard: MiddlewareHandler): MiddlewareHandler {
  return (c, next) => (methods.includes(c.req.method) ? guard(c, next) : next());
}
