// Propriétaire : L38a.
// Feuille de lancement d'une équipe, ouverte à CHAQUE lancement depuis la saisie du chat (spécification §7.8 l.1184, §3.13
// l.413-414, §5.5, §5.6 ; C §9.4 corrigée). Composant mince (D-eq-24) : tout le calcul est dans ./launch-sheet-model.ts et tous
// les textes dans server/shared/team-texts.ts (T4t). Appels par le client de T4 (api-teams.ts : CSRF, en-tête de confirmation,
// ApiError).
// Estimation (seule route du lancement qui lit opencode, D-eq-17) : à l'ouverture, à nouveau avant `expireA` et quand la
// conversation passe au repos. Lancement : POST …/run avec l'empreinte et les confirmations accordées ; 409 estimation-perimee
// ré-estime et affiche la nouvelle estimation, JAMAIS un lancement automatique. Succès : clearDraft() puis onLaunched(rootId).
import { useCallback, useEffect, useId, useRef, useState } from "react";
import { Icon } from "../../../components/Icon.tsx";
import { Button, Modal, Spinner } from "../../../components/ui.tsx";
import { teamError, teamsApi } from "../../../lib/api-teams.ts";
import { assistantsHref, goTo } from "../../../lib/router.ts";
import type { TeamEstimateResponse, TeamView } from "../../../lib/types.ts";
import {
  accordsApresRefus,
  AUCUN_ACCORD,
  type AccordsFeuille,
  type CleConfirmation,
  corpsLancement,
  delaiAvantReestimation,
  enTeteConfirmation,
  estimationAFaire,
  refusDemandeReestimation,
  type RefusLu,
  vueFeuille,
} from "./launch-sheet-model.ts";
import type { TeamDraft } from "./slots.ts";
import "./team-launch.css";

export interface TeamLaunchSheetProps {
  equipe: TeamView;
  rootId: string | null;
  directory: string;
  advanced: boolean;
  /** La conversation travaille : le lancement est refusé, raison affichée ; le retour au repos relance une estimation. */
  busy: boolean;
  agentConversation: string;
  getDraft(): TeamDraft;
  clearDraft(): void;
  onLaunched(rootId: string): void;
  /** Fermeture (Échap, [Annuler], [Modifier la demande]) : le lanceur reprend le focus. */
  onClose(): void;
}

/** Refus lu dans une erreur du client ; un code inconnu garde un message vide (phrase générale, sans promesse sur l'envoi). */
function refusDe(err: unknown): RefusLu {
  const lu = teamError(err);
  if (lu === null) return { status: 0, code: "", message: "", details: null };
  return { status: lu.status, code: lu.error, message: lu.message, details: lu.details ?? null };
}

export function TeamLaunchSheet({ equipe, rootId, directory, advanced, busy, agentConversation, getDraft, clearDraft, onLaunched, onClose }: TeamLaunchSheetProps) {
  const baseId = useId();
  const [estimation, setEstimation] = useState<TeamEstimateResponse | null>(null);
  const [estimationEnCours, setEstimationEnCours] = useState(true);
  const [refus, setRefus] = useState<RefusLu | null>(null);
  const [accords, setAccords] = useState<AccordsFeuille>(AUCUN_ACCORD);
  const [envoiEnCours, setEnvoiEnCours] = useState(false);
  const [detailOuvert, setDetailOuvert] = useState(false);
  /** Dernière estimation lancée : seule sa réponse est appliquée (une réponse plus ancienne arrivée après est ignorée). */
  const seqRef = useRef(0);
  const vivantRef = useRef(true);

  useEffect(() => {
    vivantRef.current = true;
    return () => {
      vivantRef.current = false;
      seqRef.current++;
    };
  }, []);

  /** POST /api/teams/:id/estimate : lectures d'opencode et instantané lié à estimateSha256 (D-eq-17). */
  const estimer = useCallback(async () => {
    const seq = ++seqRef.current;
    setEstimationEnCours(true);
    try {
      const reponse = await teamsApi.estimate(equipe.id, { directory, rootId });
      if (seq !== seqRef.current || !vivantRef.current) return;
      setEstimation(reponse);
      // Une ré-estimation demandée par un 409 estimation-perimee garde son information (« voici la nouvelle »).
      setRefus((precedent) => (precedent !== null && refusDemandeReestimation(precedent.code) ? precedent : null));
    } catch (err) {
      if (seq !== seqRef.current || !vivantRef.current) return;
      setEstimation(null);
      setRefus(refusDe(err));
    } finally {
      if (seq === seqRef.current && vivantRef.current) setEstimationEnCours(false);
    }
  }, [equipe.id, directory, rootId]);

  // Ouverture, changement d'équipe, de dossier ou de conversation : première estimation.
  useEffect(() => {
    void estimer();
  }, [estimer]);

  // Retour au repos de la conversation : nouvelle estimation (l'instantané tenait compte de l'occupation).
  const busyPrecedent = useRef(busy);
  useEffect(() => {
    const repos = busyPrecedent.current && !busy;
    busyPrecedent.current = busy;
    if (repos && !envoiEnCours) void estimer();
  }, [busy, envoiEnCours, estimer]);

  // Instantané bientôt périmé : nouvelle estimation avant `expireA`, jamais au moment de l'envoi.
  useEffect(() => {
    if (estimation === null || envoiEnCours) return;
    const minuteur = window.setTimeout(() => void estimer(), delaiAvantReestimation(estimation, Date.now()));
    return () => window.clearTimeout(minuteur);
  }, [estimation, envoiEnCours, estimer]);

  // <c5:controle-sql>
  // Demande lue UNE FOIS à l'ouverture : la feuille est modale, la saisie ne bouge plus tant qu'elle est ouverte, et le rendu
  // reste pur (aucune lecture du brouillon pendant un rendu). Elle ne sert qu'au contrôle SQL local de « Revue SQL sur
  // réplica » (C §12.1) : aucun appel d'IA, aucune requête, rien n'est envoyé.
  const [demande] = useState(() => getDraft().texte);
  // </c5:controle-sql>
  const vue = vueFeuille({ equipe, advanced, estimation, estimationEnCours, refus, accords, occupee: busy, envoiEnCours, detailOuvert, demande });

  const accorder = (cle: CleConfirmation) => setAccords((precedent) => ({ ...precedent, [cle]: !precedent[cle] }));

  const lancer = async () => {
    if (estimation === null) return;
    // Instantané absent ou bientôt périmé : nouvelle estimation AVANT tout envoi (D-eq-17), aucun lancement automatique.
    if (estimationAFaire(estimation, Date.now())) {
      await estimer();
      return;
    }
    const brouillon = getDraft();
    setEnvoiEnCours(true);
    try {
      const corps = corpsLancement({ directory, rootId, demande: brouillon.texte, fichiers: brouillon.fichiers, agentConversation, estimateSha256: estimation.estimateSha256, accords });
      const demarre = await teamsApi.run(equipe.id, corps, enTeteConfirmation(accords));
      clearDraft();
      onLaunched(demarre.rootId);
      onClose();
    } catch (err) {
      if (!vivantRef.current) return;
      const lu = refusDe(err);
      setRefus(lu);
      setAccords((precedent) => accordsApresRefus(precedent, lu.code));
      if (refusDemandeReestimation(lu.code)) await estimer();
    } finally {
      if (vivantRef.current) setEnvoiEnCours(false);
    }
  };

  const raisonId = `${baseId}-raison`;
  const pied = (
    <>
      {vue.modifierEquipe ? (
        <Button
          onClick={() => {
            goTo(assistantsHref({ mode: "equipe-modifier", id: equipe.id }));
            onClose();
          }}
        >
          {vue.modifierEquipe}
        </Button>
      ) : null}
      <Button onClick={onClose}>{vue.annuler}</Button>
      <Button variant="primary" disabled={!vue.lancer.actif} loading={envoiEnCours} aria-describedby={vue.lancer.raison ? raisonId : undefined} onClick={() => void lancer()}>
        {vue.lancer.libelle}
      </Button>
    </>
  );

  return (
    <Modal open title={vue.titre} onClose={onClose} footer={pied}>
      <div className="team-sheet">
        {vue.chargement ? (
          <Spinner />
        ) : (
          <>
            {vue.intro.map((phrase) => (
              <p key={phrase} className="team-sheet-ligne">
                {phrase}
              </p>
            ))}
            {/* <c5:controle-sql> */}
            {vue.sql ? <p className="team-sheet-ligne">{vue.sql}</p> : null}
            {/* </c5:controle-sql> */}
            {vue.blocs.length > 0 ? (
              <ol className="team-sheet-blocs">
                {vue.blocs.map((bloc, index) => (
                  <li key={`${index}-${bloc}`}>{bloc}</li>
                ))}
              </ol>
            ) : null}
            {vue.cout ? <p className="team-sheet-cout">{vue.cout}</p> : null}
            {vue.arret ? <p className="team-sheet-ligne">{vue.arret}</p> : null}
            {vue.detail ? (
              <details
                className="team-sheet-detail"
                open={vue.detail.ouvert}
                onToggle={(event) => setDetailOuvert((event.currentTarget as HTMLDetailsElement).open)}
              >
                <summary>{vue.detail.libelle}</summary>
                <ul>
                  {vue.detail.lignes.map((ligne) => (
                    <li key={ligne.stepId}>
                      {ligne.texte}
                      {ligne.ia ? <span className="team-sheet-ia">{ligne.ia}</span> : null}
                    </li>
                  ))}
                </ul>
              </details>
            ) : null}
            {vue.confirmations.map((confirmation) => (
              <div key={confirmation.cle} className={`team-sheet-confirmation${confirmation.controle === "aucun" ? " refus" : ""}`}>
                {confirmation.titre ? <p className="team-sheet-confirmation-titre">{confirmation.titre}</p> : null}
                <p className="team-sheet-ligne">
                  <Icon name="alert" size={14} className="team-sheet-icone" />
                  {confirmation.texte}
                </p>
                {confirmation.controle === "case" && confirmation.libelle ? (
                  <label className="team-sheet-case">
                    <input type="checkbox" checked={confirmation.accorde} onChange={() => accorder(confirmation.cle)} />
                    {confirmation.libelle}
                  </label>
                ) : null}
                {confirmation.controle === "bouton" && confirmation.libelle ? (
                  <div className="team-sheet-actions">
                    {confirmation.secondaire ? (
                      <Button size="sm" onClick={onClose}>
                        {confirmation.secondaire}
                      </Button>
                    ) : null}
                    <Button size="sm" variant={confirmation.accorde ? "primary" : "default"} aria-pressed={confirmation.accorde} onClick={() => accorder(confirmation.cle)}>
                      {confirmation.libelle}
                    </Button>
                  </div>
                ) : null}
              </div>
            ))}
            {vue.alerte ? (
              <p className={`team-sheet-alerte ${vue.alerte.ton}`} role={vue.alerte.ton === "refus" ? "alert" : undefined}>
                {vue.alerte.texte}
              </p>
            ) : null}
            {vue.lancer.raison ? (
              <p id={raisonId} className="team-sheet-raison">
                {vue.lancer.raison}
              </p>
            ) : null}
          </>
        )}
      </div>
    </Modal>
  );
}
