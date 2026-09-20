// Propriétaire : L38b.
// Cartes des équipes de la conversation, dans le fil après la carte de plan : exécution, pause, résultat et arrêt ; verrou de la
// saisie annoncé par onLockChange (spécification §5.1, §7.8 ; C §9.5, §9.6). Propriétés figées dans ./slots.ts.
// Lancements lus par useTeamRuns(rootId) : UN SEUL chargement et UN SEUL abonnement par racine, partagés avec tous les autres
// appelants (L38c les demandera depuis chaque tour de la transcription).
// UNE SEULE carte de résultat : elle n'est rendue ICI que si `run.resultMessageId === null` (mode carte seule, injection refusée,
// résultats pas encore ajoutés) ; sinon le résultat est rendu à sa place dans la transcription (L38c), jamais deux fois. Un message
// d'équipe n'est reconnu que par IDENTIFIANT, jamais par un marqueur (risque 19).
// Verrou (D-eq-16) : texte tant qu'une équipe est `preparation`, `en-cours` ou `attente-*` ; `terminee`, `arretee`, `echec`,
// `interrompue` et `plafond` ne verrouillent pas. Aucun texte écrit ici, aucune animation, aucune région aria-live propre.
import { useCallback, useEffect, useMemo, useRef } from "react";
import { teamRunsApi } from "../../../lib/api-teams.ts";
import { errorText } from "../../../lib/api.ts";
import type { TeamRunCardsProps } from "./slots.ts";
import { TeamResultCard } from "./TeamResultCard.tsx";
import { TeamRunCard } from "./TeamRunCard.tsx";
import { buildTeamRunCard, etapeResultat, verrouDe } from "./team-view-model.ts";
import { teamRunsCache, useTeamRuns } from "./useTeamRuns.ts";
import "./team-cards.css";

// `directory` n'est pas lu ici : les lancements portent déjà leur dossier, et aucun chemin n'est écrit dans le document.
export function TeamRunCards({ rootId, advanced, onOpenSession, onLockChange }: TeamRunCardsProps) {
  const { runs } = useTeamRuns(rootId);
  const cartes = useMemo(() => runs.map((run) => ({ run, modele: buildTeamRunCard(run, advanced) })), [runs, advanced]);
  const verrou = useMemo(() => verrouDe(runs), [runs]);

  /** Dernier rappel reçu de ChatPage : celui du rendu courant, jamais celui d'un rendu ancien. */
  const lockRef = useRef(onLockChange);
  lockRef.current = onLockChange;

  useEffect(() => {
    lockRef.current(verrou);
  }, [verrou]);

  // Conversation quittée : la saisie est rendue libre (ChatPage remet aussi le verrou à null à chaque changement).
  useEffect(() => {
    return () => lockRef.current(null);
  }, []);

  const relire = useCallback(() => teamRunsCache.invalider(rootId), [rootId]);
  /** [Ajouter à la conversation] (carte seule) : une injection, puis relecture ; un refus est relu par le cache, jamais avalé. */
  const ajouter = useCallback(
    (runId: string) => {
      void teamRunsApi.addResults(runId).then(relire, (err: unknown) => {
        console.warn("équipe : résultat non ajouté à la conversation", errorText(err));
        relire();
      });
    },
    [relire],
  );

  if (cartes.length === 0) return null;
  return (
    <div className="team-cards">
      {cartes.map(({ run, modele }) => (
        <div key={run.id} className="team-cards-item">
          <TeamRunCard run={run} modele={modele} onOpenSession={onOpenSession} onChanged={relire} />
          {modele.resultat === null ? null : (
            <TeamResultCard run={run} texte={etapeResultat(run)?.extrait ?? ""} advanced={advanced} onAdd={run.resultatsAjoutes ? undefined : () => ajouter(run.id)} />
          )}
        </div>
      ))}
    </div>
  );
}
