// Messages d'erreur des écrans d'assistants (installation, création, complétion).
import { MESSAGES } from "../../../server/shared/assistant-rules.ts";
import { ApiError, errorText } from "../../lib/api.ts";

/** opencode injoignable (proxy du cockpit ou erreur 502 relayée). */
export function isUnreachable(err: unknown): boolean {
  return err instanceof ApiError && (err.code === "opencode-unreachable" || err.status === 502);
}

/** Configuration refusée par opencode : rien n'a été modifié. */
export function isRejected(err: unknown): err is ApiError {
  return err instanceof ApiError && err.code === "rejected-by-opencode";
}

/** Détail technique (repliable, copiable) d'un refus d'opencode. */
export function technicalDetail(err: ApiError): string {
  const lines = err.issues.map((i) => (i.path ? `${i.path} : ${i.message}` : i.message));
  if (err.message && err.message !== MESSAGES.rejectedByOpencode) lines.unshift(err.message);
  return lines.join("\n");
}

export function assistantErrorText(err: unknown): string {
  if (isUnreachable(err)) return MESSAGES.opencodeInjoignable;
  if (isRejected(err)) return MESSAGES.rejectedByOpencode;
  return errorText(err);
}
