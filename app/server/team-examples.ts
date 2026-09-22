// Propriétaire : L37a.
// Exemples d'équipes (question Q3, réponse A11, option a) : « Revue SQL sur réplica » (avis, relire-requete-sql) et « Chaîne de
// relecture de script » (à la suite avec une pause, relire-script), textes de T4t ; installation idempotente des assistants
// manquants par eq.assistants.install, TOUJOURS derrière la garde de rechargement de la route (install() n'en a aucune).
// « Relecteur critique » et « Synthèse et rapport » arrivent en itération 5 : aucun exemple ne les avance.
//
// Chaque étape nomme son assistant par son IDENTIFIANT DE CATALOGUE, qui est aussi le nom de l'agent installé par défaut
// (AssistantService.install : uniqueName(id, pris)). Quand ce nom est déjà pris, l'installation en choisit un autre : le déroulé
// enregistré est alors réécrit par exampleFlow, qui remplace chaque identifiant de catalogue par le nom réel.
// Module de données : aucun texte écrit ici (tout vient de team-texts.ts), aucune lecture, aucune écriture.
import type { TaskSize } from "./shared/assistant-rules.ts";
import { TEXTES } from "./shared/team-texts.ts";
import type { Flow, FlowStep, StepInput } from "./shared/team-types.ts";

const E = TEXTES.partout.exemples;

/** Assistants du catalogue utilisés par les exemples (déjà livrés : aucun assistant nouveau en itération 4). */
const SQL = "relire-requete-sql";
const SCRIPT = "relire-script";

export interface TeamExample {
  id: string;
  version: number;
  titre: string;
  description: string;
  /** Identifiants de catalogue dont l'exemple a besoin, dans l'ordre d'apparition (installés s'ils manquent). */
  catalogIds: readonly string[];
  /** Déroulé de référence, chaque étape nommant son assistant par son identifiant de catalogue. */
  flow: Flow;
}

function etape(id: string, texte: { titre: string; consigne: string }, assistant: string, taille: TaskSize, recoit: StepInput): FlowStep {
  // `niveau: null` : l'IA de l'étape est celle de l'assistant (décision n° 3, D-eq-12) ; les exemples passent donc la grammaire
  // du mode Simple, qui refuse tout niveau choisi par l'équipe.
  return { id, titre: texte.titre, assistant, niveau: null, taille, consigne: texte.consigne, recoit };
}

const SQL_ETAPES = E["revue-sql"].etapes;
const SCRIPT_ETAPES = E["relecture-script"].etapes;

/** « Revue SQL sur réplica » : trois avis indépendants (chacun part de la demande), puis la synthèse qui les reçoit tous. */
const REVUE_SQL: Flow = {
  version: 1,
  blocs: [
    {
      type: "avis",
      id: "avis",
      avis: [
        etape("exactitude", SQL_ETAPES.exactitude, SQL, "S", "demande"),
        etape("performance", SQL_ETAPES.performance, SQL, "S", "demande"),
        etape("donnees-sensibles", SQL_ETAPES["donnees-sensibles"], SQL, "S", "demande"),
      ],
      synthese: etape("synthese", SQL_ETAPES.synthese, SQL, "S", "tous"),
    },
  ],
};

/** « Chaîne de relecture de script » : à la suite, avec une pause pour vérifier avant la relecture de sécurité. */
const RELECTURE_SCRIPT: Flow = {
  version: 1,
  blocs: [
    { type: "etape", id: "standards", etape: etape("standards", SCRIPT_ETAPES.standards, SCRIPT, "M", "demande") },
    { type: "pause", id: "verifier", message: E["relecture-script"].pause },
    { type: "etape", id: "securite", etape: etape("securite", SCRIPT_ETAPES.securite, SCRIPT, "M", "precedent") },
    {
      type: "etape",
      id: "exploitation-nuit",
      etape: etape("exploitation-nuit", SCRIPT_ETAPES["exploitation-nuit"], SCRIPT, "M", "precedent"),
    },
    { type: "etape", id: "consolidation", etape: etape("consolidation", SCRIPT_ETAPES.consolidation, SCRIPT, "S", "tous") },
  ],
};

export const TEAM_EXAMPLES: readonly TeamExample[] = Object.freeze([
  {
    id: "revue-sql",
    version: 1,
    titre: E["revue-sql"].titre,
    description: E["revue-sql"].description,
    catalogIds: Object.freeze([SQL]),
    flow: REVUE_SQL,
  },
  {
    id: "relecture-script",
    version: 1,
    titre: E["relecture-script"].titre,
    description: E["relecture-script"].description,
    catalogIds: Object.freeze([SCRIPT]),
    flow: RELECTURE_SCRIPT,
  },
]);

export function exampleById(id: string): TeamExample | null {
  return TEAM_EXAMPLES.find((example) => example.id === id) ?? null;
}

/**
 * COPIE du déroulé de l'exemple, avec le nom réel de chaque assistant (identifiant de catalogue → nom installé) ; un identifiant
 * absent de la table garde son nom par défaut. La copie évite que le déroulé de référence soit modifié par un appelant.
 */
export function exampleFlow(example: TeamExample, noms: ReadonlyMap<string, string>): Flow {
  const renomme = (step: FlowStep): FlowStep => ({ ...step, assistant: noms.get(step.assistant) ?? step.assistant });
  return {
    version: example.flow.version,
    blocs: example.flow.blocs.map((bloc) => {
      if (bloc.type === "etape") return { type: "etape", id: bloc.id, etape: renomme(bloc.etape) };
      if (bloc.type === "avis") return { type: "avis", id: bloc.id, avis: bloc.avis.map(renomme), synthese: renomme(bloc.synthese) };
      return { type: "pause", id: bloc.id, message: bloc.message };
    }),
  };
}
