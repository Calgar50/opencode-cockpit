// Garde « réponse en cours » : un changement qui recharge opencode est refusé (409 sessions-busy) pendant une réponse ; en mode
// Avancé, on peut forcer après confirmation (les réponses en cours sont interrompues). Réponses en cours impossibles à vérifier
// (409 reponses-non-verifiables) : confirmation proposée seulement si le serveur l'accepte (`override` : mode Avancé, ou
// redémarrage d'opencode dans les deux modes) ; sinon le message du serveur, qui donne le recours, est affiché tel quel.
import { useCallback } from "react";
import { useApp } from "../app/AppContext.tsx";
import { ApiError } from "../lib/api.ts";
import { useConfirm } from "./ui.tsx";

export interface ReloadOptions {
  confirm?: boolean;
}

/** `override: true` dans le refus : le serveur accepterait une confirmation. */
function overrideAccepted(err: ApiError): boolean {
  return typeof err.data === "object" && err.data !== null && (err.data as { override?: unknown }).override === true;
}

/**
 * Envoie `send({})` ; sur un refus « réponses en cours » en mode Avancé, ou « réponses en cours impossibles à vérifier » quand le
 * serveur accepterait une confirmation, demande confirmation puis renvoie avec `confirm`.
 */
export function useReloadGuard(): <T>(send: (options: ReloadOptions) => Promise<T>) => Promise<T> {
  const { advanced } = useApp();
  const confirm = useConfirm();
  return useCallback(
    async <T>(send: (options: ReloadOptions) => Promise<T>): Promise<T> => {
      try {
        return await send({});
      } catch (err) {
        if (!(err instanceof ApiError) || err.status !== 409) throw err;
        let ok: boolean;
        if (err.code === "sessions-busy" && advanced) {
          ok = await confirm({
            title: "Des réponses sont en cours",
            message: "Ce changement recharge opencode : les réponses en cours seront interrompues, travail délégué compris. Continuer quand même ?",
            confirmLabel: "Interrompre et continuer",
            danger: true,
          });
        } else if (err.code === "reponses-non-verifiables" && overrideAccepted(err)) {
          ok = await confirm({
            title: "Impossible de vérifier les réponses en cours",
            message:
              "opencode répond, mais ne permet pas de vérifier s'il reste des réponses en cours. Si une réponse est en cours, elle sera interrompue, travail délégué compris. Continuer quand même ?",
            confirmLabel: "Continuer quand même",
            danger: true,
          });
        } else {
          throw err;
        }
        if (!ok) throw err;
        return send({ confirm: true });
      }
    },
    [advanced, confirm],
  );
}
