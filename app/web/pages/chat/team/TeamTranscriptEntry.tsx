// Propriétaire : L38c.
// Ouverture d'un tour quand le message vient d'une équipe (C §7.2 ; spécification §3.13 l.421, §6 l.1035) :
// - CONVERSATION : la demande recopiée par le cockpit devient une bulle « Vous » SANS marqueur ni encadrement, avec la puce
//   « Envoyé à l'équipe « {equipe} » » ; le résultat injecté devient la carte de résultat de L38b (rendu Markdown échappé),
//   JAMAIS une bulle — avec L38b (carte rendue seulement si `resultMessageId === null`), il n'apparaît donc qu'une fois ;
// - TIROIR DE LECTURE d'une étape (`conversationRoot` faux) : la consigne écrite par le cockpit est repliée, en texte brut, sous
//   la puce « Consigne envoyée par le cockpit à l'étape « {titre} » », sans aucune ligne `<!-- cockpit:… -->`.
// Message non reconnu (le cas ordinaire) : `fallback`, c'est-à-dire exactement ce que MessageView rendait déjà.
// RECONNAISSANCE PAR IDENTIFIANT SEULEMENT (risque 19) : voir ./team-transcript.ts ; un marqueur tapé par vous ou recopié par une
// IA ne fait jamais passer un message pour un message d'équipe. Toute la logique est dans ce module pur ; ce fichier ne fait que
// lire les lancements et dessiner. Aucun texte écrit ici (server/shared/team-texts.ts par team-transcript.ts) ; aucune animation ;
// aucune région aria-live propre ; aucun texte d'IA inséré comme HTML (texte, ou Markdown assaini par la carte de L38b).
import { type ReactNode, useEffect, useMemo, useState } from "react";
import type { TeamRunView } from "../../../../server/shared/team-types.ts";
import { Icon } from "../../../components/Icon.tsx";
import { teamRunsApi } from "../../../lib/api-teams.ts";
import { errorText } from "../../../lib/api.ts";
import { TeamResultCard } from "./TeamResultCard.tsx";
import { puceConsigne, puceInjection, type TranscriptMessageLike, stepOpeningOf, teamInjectionOf } from "./team-transcript.ts";
import { useTeamRuns } from "./useTeamRuns.ts";

export interface TeamTranscriptEntryProps {
  message: TranscriptMessageLike;
  /** Vrai dans le chat (conversation racine), faux dans le tiroir de lecture d'une étape (SubSessionDrawer). */
  conversationRoot: boolean;
  advanced: boolean;
  /** Rendu ordinaire de l'ouverture du tour : gardé tel quel tant que le message n'est pas reconnu. */
  fallback: ReactNode;
}

/**
 * Aiguillage sans crochet : les deux vues lisent des sources différentes (lancements de la racine d'un côté, lancement d'une
 * session d'étape de l'autre). `conversationRoot` ne change pas au cours de la vie d'un tour ; si cela arrivait, React démonterait
 * l'une et monterait l'autre, les deux composants étant distincts.
 */
export function TeamTranscriptEntry({ conversationRoot, message, advanced, fallback }: TeamTranscriptEntryProps) {
  return conversationRoot ? (
    <ConversationEntry message={message} advanced={advanced} fallback={fallback} />
  ) : (
    <StepEntry message={message} fallback={fallback} />
  );
}

type VueProps = Omit<TeamTranscriptEntryProps, "conversationRoot" | "advanced">;

/** Conversation : lancements de la racine par useTeamRuns (une seule requête et un seul abonnement pour toute la page). */
function ConversationEntry({ message, advanced, fallback }: VueProps & { advanced: boolean }) {
  const rootId = typeof message.info.sessionID === "string" ? message.info.sessionID : "";
  const { runs } = useTeamRuns(rootId);
  const injection = useMemo(() => teamInjectionOf(message, runs), [message, runs]);
  if (injection === null) return <>{fallback}</>;
  if (injection.kind === "demande") {
    // Bulle « Vous » : le texte est celui que vous avez écrit, recopié par le cockpit, rendu en texte (jamais en HTML).
    return (
      <div className="user-msg">
        {injection.texte}
        <span className="chip">
          <Icon name="users" size={12} />
          {puceInjection(injection)}
        </span>
      </div>
    );
  }
  return (
    <div className="stack tight">
      {injection.kind === "resultats-partiels" ? (
        <span className="chip">
          <Icon name="users" size={12} />
          {puceInjection(injection)}
        </span>
      ) : null}
      <TeamResultCard run={injection.run} texte={injection.texte} advanced={advanced} />
    </div>
  );
}

/**
 * Lancement d'une session d'étape (GET /api/team-runs?sessionId=, L37b), partagé par les tours du tiroir : une seule requête par
 * session, gardée le temps de la page. Seuls le titre de l'étape et l'appartenance au lancement en sont lus : ils ne changent pas.
 */
const RUNS_DE_SESSION = new Map<string, Promise<TeamRunView | null>>();

function runDeSession(sessionId: string): Promise<TeamRunView | null> {
  const connu = RUNS_DE_SESSION.get(sessionId);
  if (connu !== undefined) return connu;
  const promesse = teamRunsApi.ofStepSession(sessionId).then(
    (reponse) => (Array.isArray(reponse.runs) ? (reponse.runs[0] ?? null) : null),
    (err: unknown) => {
      // Lecture impossible : le tiroir garde son rendu ordinaire, jamais un lancement supposé. Une prochaine ouverture réessaie.
      console.warn("équipe : lancement d'une session d'étape illisible", errorText(err));
      RUNS_DE_SESSION.delete(sessionId);
      return null;
    },
  );
  RUNS_DE_SESSION.set(sessionId, promesse);
  return promesse;
}

/** Tiroir de lecture : la consigne envoyée par le cockpit, repliée et en texte brut. */
function StepEntry({ message, fallback }: VueProps) {
  const sessionId = typeof message.info.sessionID === "string" ? message.info.sessionID : "";
  const [run, setRun] = useState<TeamRunView | null>(null);

  useEffect(() => {
    if (sessionId === "") return undefined;
    let vivant = true;
    void runDeSession(sessionId).then((trouve) => {
      if (vivant) setRun(trouve);
    });
    return () => {
      vivant = false;
    };
  }, [sessionId]);

  const opening = useMemo(() => stepOpeningOf(message, run), [message, run]);
  if (opening === null) return <>{fallback}</>;
  return (
    <details className="reasoning">
      <summary>
        <Icon name="users" size={13} />
        {puceConsigne(opening.titre)}
      </summary>
      <p className="delegation-text-body">{opening.texte}</p>
    </details>
  );
}
