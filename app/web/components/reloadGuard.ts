// Garde « réponse en cours » : un changement qui recharge ou redémarre opencode est refusé (409 sessions-busy) pendant une
// réponse ; réponses en cours impossibles à vérifier : 409 reponses-non-verifiables. Dans les deux cas, la confirmation n'est
// proposée que si le serveur l'accepte (`override: true` : mode Avancé, ou redémarrage d'opencode non vérifiable dans les deux
// modes) ; sinon le message du serveur, qui donne le recours, est affiché tel quel. Le mode lu par le navigateur ne décide rien :
// il peut être périmé, et une route sans dérogation (configuration, réalignement) ne renvoie jamais `override`.
import { useCallback } from "react";
import { ApiError } from "../lib/api.ts";
import { useConfirm } from "./ui.tsx";

export interface ReloadOptions {
  confirm?: boolean;
}

/** `override: true` dans le refus : le serveur accepterait une confirmation. */
function overrideAccepted(err: ApiError): boolean {
  return typeof err.data === "object" && err.data !== null && (err.data as { override?: unknown }).override === true;
}

/** Confirmation à proposer pour un refus de la garde : seulement quand le serveur l'accepterait (`override: true`). */
export function reloadConfirmation(err: unknown): "sessions-busy" | "reponses-non-verifiables" | null {
  if (!(err instanceof ApiError) || err.status !== 409 || !overrideAccepted(err)) return null;
  return err.code === "sessions-busy" || err.code === "reponses-non-verifiables" ? err.code : null;
}

/**
 * Envoie `send({})` ; sur un refus « réponses en cours » ou « réponses en cours impossibles à vérifier » que le serveur accepterait
 * de forcer, demande confirmation puis renvoie avec `confirm`.
 */
export function useReloadGuard(): <T>(send: (options: ReloadOptions) => Promise<T>) => Promise<T> {
  const confirm = useConfirm();
  return useCallback(
    async <T>(send: (options: ReloadOptions) => Promise<T>): Promise<T> => {
      try {
        return await send({});
      } catch (err) {
        const kind = reloadConfirmation(err);
        if (kind === null) throw err;
        let ok: boolean;
        if (kind === "sessions-busy") {
          ok = await confirm({
            title: "Des réponses sont en cours",
            message:
              "Ce changement recharge ou redémarre opencode : les réponses en cours seront interrompues, travail délégué compris. Continuer quand même ?",
            confirmLabel: "Interrompre et continuer",
            danger: true,
          });
        } else {
          ok = await confirm({
            title: "Impossible de vérifier les réponses en cours",
            message:
              "opencode répond, mais ne permet pas de vérifier s'il reste des réponses en cours. Si une réponse est en cours, elle sera interrompue, travail délégué compris. Continuer quand même ?",
            confirmLabel: "Continuer quand même",
            danger: true,
          });
        }
        if (!ok) throw err;
        return send({ confirm: true });
      }
    },
    [confirm],
  );
}
