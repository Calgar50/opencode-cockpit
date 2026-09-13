// Mise à jour des éléments liés à un niveau (réalignement, §9.6) : confirmation, appel groupé et messages.
import { type ReactNode, useState } from "react";
import { formatUsd, MESSAGES } from "../../../server/shared/assistant-rules.ts";
import { useToast } from "../../components/Toast.tsx";
import { useConfirm } from "../../components/ui.tsx";
import { ApiError, api } from "../../lib/api.ts";
import type { ItemKind, UpdateItem } from "../../lib/types.ts";

const ratioFr = new Intl.NumberFormat("fr-FR", { maximumFractionDigits: 1 });

/** « assistant(s) », « raccourci(s) » ou « élément(s) » selon les types et le nombre. */
export function itemsNoun(items: ReadonlyArray<{ kind: ItemKind }>, count: number = items.length): string {
  const kinds = new Set(items.map((i) => i.kind));
  const [one, many] =
    kinds.size === 1 && kinds.has("agents") ? ["assistant", "assistants"] : kinds.size === 1 && kinds.has("commands") ? ["raccourci", "raccourcis"] : ["élément", "éléments"];
  return count > 1 ? many : one;
}

/** « 0,18 $ → 0,45 $ » ; null si les deux coûts sont inconnus. */
export function costPairText(fromUsd: number | null, toUsd: number | null): string | null {
  if (fromUsd === null && toUsd === null) return null;
  return `${fromUsd === null ? "?" : formatUsd(fromUsd)} → ${toUsd === null ? "?" : formatUsd(toUsd)}`;
}

/** Bouton d'un assistant dont l'IA a disparu : « Passer à {nouvelle} (≈ {avant} → {après} par demande) ». */
export function switchLabel(item: UpdateItem): string {
  const cost = costPairText(item.fromUsd, item.toUsd);
  return `Passer à ${item.toName}${cost ? ` (≈ ${cost} par demande)` : ""}`;
}

export function realignConfirmation(items: readonly UpdateItem[]): { title: string; message: ReactNode; danger: boolean } {
  const count = items.length;
  const maxRatio = Math.max(0, ...items.map((i) => i.ratio ?? 0));
  const danger = maxRatio >= 2;
  const first = items[0];
  const uniform =
    first !== undefined && items.every((i) => i.from === first.from && i.to === first.to && i.fromUsd === first.fromUsd && i.toUsd === first.toUsd);
  const oldName = (i: UpdateItem) => i.fromName ?? i.from ?? "l'IA actuelle";
  let body: ReactNode;
  if (uniform && first) {
    const cost = costPairText(first.fromUsd, first.toUsd);
    body = (
      <p className="secondary">
        {count > 1 ? "Ils utiliseront" : "Il utilisera"} {first.toName} au lieu de {oldName(first)}.{cost ? ` Coût estimé : ${cost} par demande.` : ""}
      </p>
    );
  } else {
    body = (
      <ul className="secondary realign-list">
        {items.map((i) => {
          const cost = costPairText(i.fromUsd, i.toUsd);
          return (
            <li key={`${i.kind}/${i.name}`}>
              « {i.title} » : {i.toName} au lieu de {oldName(i)}
              {cost ? ` (coût estimé : ${cost} par demande)` : ""}
            </li>
          );
        })}
      </ul>
    );
  }
  return {
    title: `Mettre à jour ${count} ${itemsNoun(items)} ?`,
    message: (
      <div className="stack tight">
        {body}
        {danger ? <p className="field-error">Le coût estimé est multiplié par {ratioFr.format(maxRatio)}.</p> : null}
      </div>
    ),
    danger,
  };
}

/** Réalignement avec confirmation ; `onDone` est appelé après une mise à jour réussie. */
export function useRealign(onDone?: () => void) {
  const confirm = useConfirm();
  const toast = useToast();
  const [busy, setBusy] = useState(false);

  const apply = async (refs: Array<{ kind: ItemKind; name: string }>): Promise<boolean> => {
    if (refs.length === 0) return false;
    setBusy(true);
    try {
      const { updated } = await api.realign(refs);
      const n = updated.length;
      toast.success("Mise à jour effectuée", `${n} ${itemsNoun(updated.length > 0 ? updated : refs, n)} ${n > 1 ? "utilisent" : "utilise"} maintenant la nouvelle IA.`);
      onDone?.();
      return true;
    } catch (err) {
      if (err instanceof ApiError && err.code === "sessions-busy") toast.warning("Mise à jour impossible", err.message || MESSAGES.sessionsBusy);
      else if (err instanceof ApiError && err.code === "rejected-by-opencode") {
        const detail = err.issues.map((i) => (i.path ? `${i.path} : ${i.message}` : i.message)).join(" · ");
        toast.error(MESSAGES.rejectedByOpencode, detail || undefined);
      } else toast.error("Mise à jour impossible", err);
      return false;
    } finally {
      setBusy(false);
    }
  };

  const run = async (items: readonly UpdateItem[]): Promise<boolean> => {
    if (items.length === 0 || busy) return false;
    const c = realignConfirmation(items);
    const ok = await confirm({ title: c.title, message: c.message, confirmLabel: "Mettre à jour", danger: c.danger });
    if (!ok) return false;
    return apply(items.map((i) => ({ kind: i.kind, name: i.name })));
  };

  return { run, apply, busy };
}
