// Propriétaire : L12b.
// Bandeau « Autonome avec contrôle · 12 automatiques · 1 en attente · 0,08 $ sur 1,00 $ » [Arrêter] [Journal] (spécification
// §4.12, §4.4 fin, §5.4, §5.5, §5.6), sous l'en-tête du chat. Propriétés figées dans ../slots.ts.
// - toute la logique (segments, compteurs, montants, état vide, bouton de fin de demande, annonces) est dans le modèle pur
//   server/shared/autonomy-view.ts : ce composant ne fait que la rendre, sans texte ni condition à lui ;
// - la demande vient de GET /api/conversations/:rootId/autonomie, tenue à jour par l'événement `autonomie.demande` ; le flux
//   rétabli et un changement de choix relancent une lecture. Aucun appel nouveau : la route existe depuis L10a. La route ne
//   rend que la demande EN COURS : une relecture ne retire jamais une fin de demande affichée (suiviApresRelecture, R106-b) ;
// - annonces POLIES par l'annonceur de la page (L5b) : UNE région `aria-live` pour tout le cockpit, au plus une annonce toutes
//   les 2 s, coupée par `ui.activityAnnouncements`. Ce composant ne crée aucune région ;
// - [Voir les modifications de cette demande] en fin de demande : GET /session/:id/diff, déjà relayé par le proxy (oc.diff) ;
// - à 400 px, le bandeau tient sur une ligne : les segments du milieu passent dans « +2 », toujours lus par le lecteur d'écran ;
// - aucune animation.
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { TEXTES } from "../../../../server/shared/autonomy-texts.ts";
import {
  annonceBandeau,
  type BandeauVue,
  bandeauVue,
  type DemandeEvenementLu,
  SEPARATEUR,
  SUIVI_VIDE,
  type SuiviBandeau,
  suiviApresEvenement,
  suiviApresRelecture,
} from "../../../../server/shared/autonomy-view.ts";
import { ID_RE } from "../../../../server/shared/ids.ts";
import { useApp } from "../../../app/AppContext.tsx";
import { DiffView } from "../../../components/DiffView.tsx";
import { Icon } from "../../../components/Icon.tsx";
import { Button, Modal, Spinner } from "../../../components/ui.tsx";
import { useAnnouncer } from "../../../lib/announcer.ts";
import { errorText, oc } from "../../../lib/api.ts";
import { autonomyApi } from "../../../lib/api-autonomy.ts";
import { cockpitEvent, useEvents } from "../../../lib/events.ts";
import type { FileDiff } from "../../../lib/types.ts";
import type { AutonomyBannerProps } from "../slots.ts";
import "./autonomy-cards.css";

/** §5.6 : le bandeau tient sur une ligne. Même requête que « Qui travaille ? » (L5b). */
const NARROW_QUERY = "(max-width: 400px)";

function subscribeNarrow(listener: () => void): () => void {
  const media = window.matchMedia(NARROW_QUERY);
  media.addEventListener("change", listener);
  return () => media.removeEventListener("change", listener);
}

const isNarrow = () => window.matchMedia(NARROW_QUERY).matches;

/** Champ texte d'un événement du flux (données non fiables : lues avec prudence). */
function champ(data: unknown, nom: string): string | null {
  if (typeof data !== "object" || data === null) return null;
  const valeur = (data as Record<string, unknown>)[nom];
  return typeof valeur === "string" ? valeur : null;
}

/** Compteurs et dépense d'un événement `autonomie.demande`, si l'événement est lisible ; les champs illisibles sont laissés de côté. */
function demandeDe(data: unknown): DemandeEvenementLu | null {
  if (typeof data !== "object" || data === null) return null;
  const brut = data as Record<string, unknown>;
  const requestId = champ(brut, "requestId");
  const compteurs = brut.compteurs;
  if (requestId === null || typeof compteurs !== "object" || compteurs === null || typeof brut.spent !== "number") return null;
  const lus: DemandeEvenementLu["compteurs"] = {};
  for (const cle of COMPTEURS) {
    const valeur = (compteurs as Record<string, unknown>)[cle];
    if (typeof valeur === "number" && Number.isFinite(valeur)) lus[cle] = valeur;
  }
  const fin = champ(brut, "fin");
  return { requestId, compteurs: lus, spent: brut.spent, ...(fin === null ? {} : { fin: fin as DemandeEvenementLu["fin"] }) };
}

/** Compteurs de l'événement `autonomie.demande` (contrat cockpit-event-types.ts) : aucun autre champ n'est repris. */
const COMPTEURS = ["auto", "attentes", "refus", "controles", "fichiers", "delegations"] as const satisfies ReadonlyArray<
  keyof DemandeEvenementLu["compteurs"]
>;

export function AutonomyBanner(props: AutonomyBannerProps) {
  // Le bandeau ne parle que d'une conversation opencode connue : sinon, rien à montrer.
  if (!ID_RE.test(props.rootId)) return null;
  return <Banner {...props} />;
}

function Banner({ rootId, directory, onStop, onOpenJournal }: AutonomyBannerProps) {
  const { ui } = useApp();
  const say = useAnnouncer(ui.activityAnnouncements);
  const narrow = useSyncExternalStore(subscribeNarrow, isNarrow, isNarrow);
  /** Demande affichée et dernière demande vue : une relecture ne fait jamais disparaître une fin de demande (R106-b). */
  const [suivi, setSuivi] = useState<SuiviBandeau>(SUIVI_VIDE);
  const [modifications, setModifications] = useState<FileDiff[] | null>(null);
  const [ouvert, setOuvert] = useState(false);
  /** Dernière lecture lancée : seule sa réponse est appliquée (une réponse plus ancienne arrivée après est ignorée). */
  const seqRef = useRef(0);
  const abortRef = useRef<AbortController | null>(null);
  /** Dernier bandeau rendu : les annonces disent les TRANSITIONS, jamais ce qu'une première lecture révèle. */
  const precedentRef = useRef<BandeauVue | null>(null);
  /** Suivi connu, lu par les écouteurs du flux : la décision de relire se prend hors d'une mise à jour d'état. */
  const suiviRef = useRef<SuiviBandeau>(SUIVI_VIDE);
  suiviRef.current = suivi;

  /**
   * Relit la demande en cours ; un échec laisse le bandeau tel quel plutôt que d'inventer une demande. La route ne rend que
   * la demande EN COURS : la réponse passe par suiviApresRelecture, qui garde une fin de demande déjà affichée.
   */
  const refresh = useCallback((id: string) => {
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    const seq = ++seqRef.current;
    autonomyApi.get(id, controller.signal).then(
      (vue) => {
        if (seq === seqRef.current) setSuivi((courant) => suiviApresRelecture(courant, vue.demande));
      },
      (err: unknown) => {
        if (controller.signal.aborted || seq !== seqRef.current) return;
        console.warn("autonomie : lecture de la demande impossible", errorText(err));
      },
    );
  }, []);

  useEffect(() => {
    setSuivi(SUIVI_VIDE);
    setModifications(null);
    setOuvert(false);
    precedentRef.current = null;
    refresh(rootId);
    return () => {
      seqRef.current++;
      abortRef.current?.abort();
    };
  }, [rootId, refresh]);

  useEvents((event) => {
    if (cockpitEvent(event, "stream.reconnected") !== null) {
      refresh(rootId);
      return;
    }
    const choix = cockpitEvent(event, "autonomie.choix");
    if (choix !== null && champ(choix.data, "rootId") === rootId) {
      refresh(rootId);
      return;
    }
    const brut = cockpitEvent(event, "autonomie.demande");
    if (brut === null || champ(brut.data, "rootId") !== rootId) return;
    const lu = demandeDe(brut.data);
    if (lu === null) return;
    // Une autre demande que celle du bandeau (la suivante a commencé) : relecture de la route, jamais un mélange des deux. La fin
    // d'une demande qu'une relecture venait de retirer est reprise sans relire (la route ne la rendrait plus).
    if (suiviApresEvenement(suiviRef.current, lu).relire) refresh(rootId);
    else setSuivi((courant) => suiviApresEvenement(courant, lu).suivi);
  });

  const vue = bandeauVue({ demande: suivi.affichee, etroit: narrow });

  // Annonces polies des transitions (attente de votre accord, fin de demande) ; l'annonceur en dit au plus une toutes les 2 s.
  useEffect(() => {
    const phrase = annonceBandeau(precedentRef.current, vue);
    precedentRef.current = vue;
    if (phrase !== null) say(phrase);
  });

  if (vue === null) return null;
  const { commandes } = TEXTES.partout;

  const voirModifications = () => {
    setOuvert(true);
    oc.diff(rootId, directory).then(
      (fichiers) => setModifications(fichiers),
      (err: unknown) => {
        console.warn("autonomie : modifications de la demande illisibles", errorText(err));
        setModifications([]);
      },
    );
  };

  return (
    <div className="autonomy-banner" data-terminee={vue.terminee ? "oui" : "non"}>
      <p className="autonomy-banner-resume">
        <Icon name="shield" size={14} />
        {vue.segments.map((segment, i) => (
          <span key={i} className={segment.visible ? "autonomy-banner-segment" : "visually-hidden"}>
            {i > 0 ? SEPARATEUR : null}
            {segment.texte}
          </span>
        ))}
        {vue.enPlus ? (
          <span className="autonomy-banner-plus">
            <span aria-hidden="true">{vue.enPlus.court}</span>
            <span className="visually-hidden">{vue.enPlus.accessible}</span>
          </span>
        ) : null}
      </p>
      <div className="autonomy-banner-actions">
        {vue.boutons.arreter ? (
          <Button size="sm" variant="danger" icon="stop" onClick={onStop}>
            {commandes.arreter}
          </Button>
        ) : null}
        {vue.boutons.journal ? (
          <Button size="sm" variant="ghost" icon="list" onClick={onOpenJournal}>
            {commandes.journal}
          </Button>
        ) : null}
        {vue.boutons.modifications ? (
          <Button size="sm" variant="ghost" icon="file" onClick={voirModifications}>
            {commandes.voirModifications}
          </Button>
        ) : null}
      </div>
      {vue.fin ? <p className="autonomy-banner-fin">{vue.fin}</p> : null}
      {vue.vide ? <p className="autonomy-banner-vide">{vue.vide}</p> : null}
      <Modal open={ouvert} title={commandes.voirModifications} onClose={() => setOuvert(false)} wide>
        <Modifications fichiers={modifications} />
      </Modal>
    </div>
  );
}

/**
 * [Voir les modifications de cette demande] : fichiers rendus par GET /session/:id/diff, relayé par le proxy du cockpit (aucune
 * requête nouvelle). `null` : lecture en cours. Une lecture en échec rend une liste vide plutôt qu'un message d'erreur : la
 * demande est terminée, ses modifications sont dans le dossier de la conversation.
 */
function Modifications({ fichiers }: { fichiers: FileDiff[] | null }) {
  if (fichiers === null) return <Spinner />;
  if (fichiers.length === 0) return <p className="muted">Aucun fichier modifié pour cette demande.</p>;
  return (
    <div className="stack">
      {fichiers.map((fichier, i) => (
        <div key={`${fichier.file ?? ""}-${i}`} className="stack tight">
          <code className="ellipsis">{fichier.file ?? ""}</code>
          {fichier.patch ? <DiffView patch={fichier.patch} maxLines={200} /> : null}
        </div>
      ))}
    </div>
  );
}
