// Propriétaire : L1f.
// Avis du mode Simple après un refus automatique de délégation (spécification §3.14 ; texte : décision de l'utilisateur n° 4 du 15/09,
// question Q5 option b), en fin de fil : « En mode Simple, l'IA ne délègue pas : elle continue seule. », sans [Voir les équipes] ni
// phrase sur les équipes tant qu'elles n'existent pas (le texte complet viendra en itération 4, L38). Montré une fois par
// conversation dès qu'un refus Simple de la garde (L1d) y est connu :
// - à l'ouverture et à la reconnexion du flux : attentes de la conversation (GET …/activity), demande `task` refusée par le cockpit
//   (permission_waits.replied_by = « cockpit ») ; jamais annoncé ;
// - en direct : fait « reponse » {par: « cockpit »} de cette conversation (activite.fait ; contrat ReponseFactData : refus Simple écrit
//   par L1d), annoncé une fois par la région de la page (useAnnouncer, réglage ui.activityAnnouncements).
// Mode Avancé : rien (la délégation y attend votre accord, avec la carte détaillée DelegationDetails). Lecture en échec : rien n'est
// inventé, l'avis attend le direct. Propriétés figées dans ../slots.ts.
import { useCallback, useEffect, useRef, useState } from "react";
import { avisSimple } from "../../../../server/shared/delegation-texts.ts";
import { ID_RE } from "../../../../server/shared/ids.ts";
import { useApp } from "../../../app/AppContext.tsx";
import { Icon } from "../../../components/Icon.tsx";
import { activityApi } from "../../../lib/api-activity.ts";
import { useAnnouncer } from "../../../lib/announcer.ts";
import { eventBus } from "../../../lib/events.ts";
import type { PermissionWaitView } from "../../../lib/types.ts";
import type { DelegationNoticeProps } from "../slots.ts";
import "./delegation.css";
// --- équipes (it4) : début ---
import { type AvisDelegation, avisDelegationSimple } from "../../../../server/shared/delegation-texts.ts";
import { Button } from "../../../components/ui.tsx";
import { teamsApi } from "../../../lib/api-teams.ts";
import { errorText } from "../../../lib/api.ts";
import { goTo } from "../../../lib/router.ts";

// --- équipes (it4) : fin ---
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

/** Attente d'une délégation refusée par le cockpit : refus Simple de la garde (L1d, work.markWait(…, « cockpit »)). */
function simpleRefusalWait(wait: PermissionWaitView): boolean {
  return wait.permission === "task" && wait.reply === "reject" && wait.repliedBy === "cockpit";
}

/** Fait « reponse » {par: « cockpit »} de la conversation `rootId` (entrée du flux, vérifiée). */
function simpleRefusalFact(data: unknown, rootId: string): boolean {
  return isRecord(data) && data.rootId === rootId && data.kind === "reponse" && isRecord(data.data) && data.data.par === "cockpit";
}

export function DelegationNotice({ rootId, advanced }: DelegationNoticeProps) {
  if (advanced || !ID_RE.test(rootId)) return null;
  // Une instance par conversation : l'avis d'une conversation ne passe jamais à la suivante.
  return <Notice key={rootId} rootId={rootId} />;
}

function Notice({ rootId }: { rootId: string }) {
  const { ui } = useApp();
  const say = useAnnouncer(ui.activityAnnouncements);
  const [shown, setShown] = useState(false);
  const [reload, setReload] = useState(0);
  const shownRef = useRef(false);
  // --- équipes (it4) : début ---
  // `ouvertesEnSimple` de GET /api/teams (EQUIPES_SIMPLE_OUVERTES, U1) : faux tant que la réponse n'est pas là, ou si elle ne
  // vient pas — l'avis garde alors son texte court, et n'invite jamais à une fonction que le serveur refuserait (P3).
  const [ouvertesEnSimple, setOuvertesEnSimple] = useState(false);
  // Équipes fermées : le texte court d'avant, `avisSimple()`, sans bouton ; ouvertes : le texte complet et [Voir les équipes].
  const avis: AvisDelegation = ouvertesEnSimple ? avisDelegationSimple(true) : { texte: avisSimple(), bouton: null };
  const avisRef = useRef(avis.texte);
  avisRef.current = avis.texte;

  // --- équipes (it4) : fin ---
  const show = useCallback(
    (announce: boolean) => {
      if (shownRef.current) return;
      shownRef.current = true;
      setShown(true);
      // --- équipes (it4) : début ---
      // Annoncé : le texte réellement affiché (court ou complet), jamais l'autre.
      if (announce) say(avisRef.current);
      // --- équipes (it4) : fin ---
    },
    [say],
  );
  // --- équipes (it4) : début ---

  // Une seule lecture par conversation, et seulement quand l'avis est affiché : rien n'est demandé tant qu'il n'y a pas de refus.
  useEffect(() => {
    if (!shown) return undefined;
    const controller = new AbortController();
    teamsApi.list(controller.signal).then(
      (reponse) => setOuvertesEnSimple(reponse.ouvertesEnSimple === true),
      (err: unknown) => {
        if (!controller.signal.aborted) console.warn("avis du mode Simple : ouverture des équipes illisible", errorText(err));
      },
    );
    return () => controller.abort();
  }, [shown]);

  // --- équipes (it4) : fin ---
  // Relecture (ouverture, reconnexion du flux) : un refus déjà fait montre l'avis, sans l'annoncer.
  useEffect(() => {
    const controller = new AbortController();
    activityApi.activity(rootId, controller.signal).then(
      (activity) => {
        if (Array.isArray(activity.waits) && activity.waits.some(simpleRefusalWait)) show(false);
      },
      (err: unknown) => {
        if (!controller.signal.aborted) console.warn("avis du mode Simple : attentes de la conversation illisibles", err);
      },
    );
    return () => controller.abort();
  }, [rootId, reload, show]);

  // Direct : refus Simple de cette conversation.
  useEffect(
    () =>
      eventBus.subscribe((event) => {
        if (event.kind !== "cockpit") return;
        if (event.type === "stream.reconnected") setReload((n) => n + 1);
        else if (event.type === "activite.fait" && simpleRefusalFact(event.data, rootId)) show(true);
      }),
    [rootId, show],
  );

  if (!shown) return null;
  return (
    <div className="callout small delegation-notice" role="note">
      <Icon name="users" size={14} />
      {/* --- équipes (it4) : début --- */}
      <span>{avis.texte}</span>
      {avis.bouton === null ? null : (
        <Button variant="ghost" size="sm" icon="users" onClick={() => goTo(avis.bouton?.href ?? "")}>
          {avis.bouton.libelle}
        </Button>
      )}
      {/* --- équipes (it4) : fin --- */}
    </div>
  );
}
