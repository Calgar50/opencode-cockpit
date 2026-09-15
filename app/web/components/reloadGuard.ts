// Garde « réponse en cours » : un changement qui recharge opencode est refusé (409 sessions-busy) pendant une réponse.
// En mode Avancé, on peut forcer après confirmation (les réponses en cours sont interrompues).
import { useCallback } from "react";
import { useApp } from "../app/AppContext.tsx";
import { ApiError } from "../lib/api.ts";
import { useConfirm } from "./ui.tsx";

export interface ReloadOptions {
  confirm?: boolean;
}

/** Envoie `send({})` ; sur un refus « réponses en cours » en mode Avancé, demande confirmation puis renvoie avec `confirm`. */
export function useReloadGuard(): <T>(send: (options: ReloadOptions) => Promise<T>) => Promise<T> {
  const { advanced } = useApp();
  const confirm = useConfirm();
  return useCallback(
    async <T>(send: (options: ReloadOptions) => Promise<T>): Promise<T> => {
      try {
        return await send({});
      } catch (err) {
        const busy = err instanceof ApiError && err.status === 409 && err.code === "sessions-busy";
        if (!busy || !advanced) throw err;
        const ok = await confirm({
          title: "Des réponses sont en cours",
          message: "Ce changement recharge opencode : les réponses en cours seront interrompues, travail délégué compris. Continuer quand même ?",
          confirmLabel: "Interrompre et continuer",
          danger: true,
        });
        if (!ok) throw err;
        return send({ confirm: true });
      }
    },
    [advanced, confirm],
  );
}
