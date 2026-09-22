// Propriétaire : L37a.
// Exemples d'équipes (question Q3, réponse A11, option a) : « Revue SQL sur réplica » (avis, relire-requete-sql) et « Chaîne de
// relecture de script » (à la suite avec une pause, relire-script), textes de T4t ; installation idempotente des assistants
// manquants par eq.assistants.install, TOUJOURS derrière la garde de rechargement de la route (install() n'en a aucune).
// « Relecteur critique » et « Synthèse et rapport » arrivent en itération 5 : aucun exemple ne les avance.
//
// ITÉRATION 5b (L45b) : les quatre exemples restants de la conception C §12.1 — « Enquête sur un incident », « Revue d'un
// changement avant le comité », « Compte rendu d'incident relu » (forme relecture) et « Tri d'une alerte » (forme aiguillage).
// Les deux exemples de l'itération 4 ne sont JAMAIS réécrits : ni leur déroulé, ni leurs textes, ni leur `version`.
// D-5-25 : aucun bloc facultatif n'est livré — « Enquête sur un incident » n'a pas l'étape « Avocat du diable » et
// « Revue SQL sur réplica » pas la « Seconde lecture de la synthèse » de C §12.1 ; l'écart est consigné par DOC5. La seconde
// lecture reste atteignable sous le résultat d'une équipe (L44f).
// Les textes des quatre exemples de la 5b sont dans `shared/construction-texts.ts` (fichier de la construction, §2.7), ceux des
// deux exemples de l'itération 4 restent dans `shared/team-texts.ts` : ce module n'écrit toujours aucun texte.
//
// Chaque étape nomme son assistant par son IDENTIFIANT DE CATALOGUE, qui est aussi le nom de l'agent installé par défaut
// (AssistantService.install : uniqueName(id, pris)). Quand ce nom est déjà pris, l'installation en choisit un autre : le déroulé
// enregistré est alors réécrit par exampleFlow, qui remplace chaque identifiant de catalogue par le nom réel.
// Module de données : aucun texte écrit ici (tout vient de team-texts.ts), aucune lecture, aucune écriture.
import type { TaskSize } from "./shared/assistant-rules.ts";
import { TEXTES as TEXTES_C5 } from "./shared/construction-texts.ts";
import { TEXTES } from "./shared/team-texts.ts";
import type { Flow, FlowStep, StepInput } from "./shared/team-types.ts";

const E = TEXTES.partout.exemples;
// <c5:exemples-5b>
const E5 = TEXTES_C5.partout.exemplesEquipes;
// </c5:exemples-5b>

/** Assistants du catalogue utilisés par les exemples (déjà livrés : aucun assistant nouveau en itération 4). */
const SQL = "relire-requete-sql";
const SCRIPT = "relire-script";
// <c5:assistants-5b>
/** Assistants d'équipe du catalogue (L45a) et assistants déjà livrés, employés par les quatre exemples de la 5b. */
const INCIDENT = "analyser-incident";
const CAB = "preparer-revue-cab";
const ALERTE = "expliquer-alerte";
const SYNTHESE = "synthese-rapport";
const RELECTEUR = "relecteur-critique";
const AIGUILLEUR = "aiguilleur";
const COMPTE_RENDU = "rediger-compte-rendu-incident";
// </c5:assistants-5b>

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

// <c5:etape-methodes-5b>
/**
 * Étape des exemples de la 5b portant une ou plusieurs méthodes « consigne » du catalogue (L44a). `methodes` est FACULTATIF :
 * une étape sans méthode garde exactement la forme de l'itération 4, sans champ ajouté (aucune migration de données).
 * Le contexte `methods` de `validateFlow` refuse une méthode inconnue ou DÉJÀ posée dans le fichier de l'assistant : c'est
 * voulu, et l'exemple le dit alors comme problème plutôt que de poser deux fois le même bloc.
 */
function etapeAvecMethodes(
  id: string,
  texte: { titre: string; consigne: string },
  assistant: string,
  taille: TaskSize,
  recoit: StepInput,
  methodes: readonly string[],
): FlowStep {
  return { ...etape(id, texte, assistant, taille, recoit), methodes: [...methodes] };
}
// </c5:etape-methodes-5b>

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

// <c5:deroules-5b>
const ENQUETE_ETAPES = E5["enquete-incident"].etapes;
const CAB_ETAPES = E5["revue-changement-cab"].etapes;
const POSTMORTEM_ETAPES = E5.postmortem.etapes;
const TRI_ETAPES = E5["tri-alerte"].etapes;

/**
 * « Enquête sur un incident » : trois pistes examinées sans se voir (chacune part de la demande), puis la synthèse qui les
 * reçoit toutes. L'étape FACULTATIVE « Avocat du diable » de C §12.1 n'est PAS livrée (D-5-25).
 */
const ENQUETE_INCIDENT: Flow = {
  version: 1,
  blocs: [
    {
      type: "avis",
      id: "pistes",
      avis: [
        etape("changement", ENQUETE_ETAPES.changement, INCIDENT, "M", "demande"),
        etape("infrastructure", ENQUETE_ETAPES.infrastructure, INCIDENT, "M", "demande"),
        etape("donnees", ENQUETE_ETAPES.donnees, INCIDENT, "M", "demande"),
      ],
      synthese: etape("synthese", ENQUETE_ETAPES.synthese, SYNTHESE, "M", "tous"),
    },
  ],
};

/** « Revue d'un changement avant le comité » : à la suite, avec une pause pour compléter le dossier avant le pré-mortem. */
const REVUE_CHANGEMENT_CAB: Flow = {
  version: 1,
  blocs: [
    { type: "etape", id: "impact", etape: etape("impact", CAB_ETAPES.impact, CAB, "M", "demande") },
    { type: "pause", id: "completer", message: E5["revue-changement-cab"].pause },
    { type: "etape", id: "premortem", etape: etape("premortem", CAB_ETAPES.premortem, CAB, "M", "precedent") },
    { type: "etape", id: "dossier", etape: etape("dossier", CAB_ETAPES.dossier, SYNTHESE, "M", "tous") },
  ],
};

/**
 * « Compte rendu d'incident relu » : forme RELECTURE. L'auteur rédige avec la méthode « 5 pourquoi », une pause vous laisse
 * vérifier le premier jet avant la première relecture, puis le relecteur critique relit ; 2 tours au maximum.
 */
const POSTMORTEM: Flow = {
  version: 1,
  blocs: [
    {
      type: "relecture",
      id: "compte-rendu",
      auteur: etapeAvecMethodes("redaction", POSTMORTEM_ETAPES.redaction, COMPTE_RENDU, "M", "demande", ["cinq-pourquoi"]),
      relecteur: etape("relecture", POSTMORTEM_ETAPES.relecture, RELECTEUR, "M", "precedent"),
      toursMax: 2,
      pauseAvantRelecture: true,
    },
  ],
};

/**
 * « Tri d'une alerte » : forme AIGUILLAGE. L'aiguilleur propose dans une liste FERMÉE de cinq spécialistes, VOUS confirmez son
 * choix, deux spécialistes au plus travaillent, et la synthèse rassemble les résultats choisis. `repli` nomme l'assistant
 * proposé quand aucun spécialiste ne convient (D-5-13) : rien n'est alors envoyé, donc rien n'est facturé.
 */
const TRI_ALERTE: Flow = {
  version: 1,
  blocs: [
    {
      type: "aiguillage",
      id: "tri",
      aiguilleur: etape("aiguilleur", TRI_ETAPES.aiguilleur, AIGUILLEUR, "S", "demande"),
      specialistes: [
        etape("supervision", TRI_ETAPES.supervision, ALERTE, "S", "demande"),
        etape("reseau", TRI_ETAPES.reseau, ALERTE, "S", "demande"),
        etape("base-de-donnees", TRI_ETAPES["base-de-donnees"], ALERTE, "S", "demande"),
        etape("application", TRI_ETAPES.application, ALERTE, "S", "demande"),
        etape("stockage", TRI_ETAPES.stockage, ALERTE, "S", "demande"),
      ],
      choixMax: 2,
      synthese: etape("synthese", TRI_ETAPES.synthese, SYNTHESE, "S", "tous"),
      repli: ALERTE,
    },
  ],
};
// </c5:deroules-5b>

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
  // <c5:registre-5b>
  // Les quatre exemples restants de C §12.1, `exemple_version` 1 comme les deux premiers. Leur ordre suit celui de C :
  // enquête, revue de changement, compte rendu relu, tri d'alerte.
  {
    id: "enquete-incident",
    version: 1,
    titre: E5["enquete-incident"].titre,
    description: E5["enquete-incident"].description,
    catalogIds: Object.freeze([INCIDENT, SYNTHESE]),
    flow: ENQUETE_INCIDENT,
  },
  {
    id: "revue-changement-cab",
    version: 1,
    titre: E5["revue-changement-cab"].titre,
    description: E5["revue-changement-cab"].description,
    catalogIds: Object.freeze([CAB, SYNTHESE]),
    flow: REVUE_CHANGEMENT_CAB,
  },
  {
    id: "postmortem",
    version: 1,
    titre: E5.postmortem.titre,
    description: E5.postmortem.description,
    catalogIds: Object.freeze([COMPTE_RENDU, RELECTEUR]),
    flow: POSTMORTEM,
  },
  {
    id: "tri-alerte",
    version: 1,
    titre: E5["tri-alerte"].titre,
    description: E5["tri-alerte"].description,
    catalogIds: Object.freeze([AIGUILLEUR, ALERTE, SYNTHESE]),
    flow: TRI_ALERTE,
  },
  // </c5:registre-5b>
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
      if (bloc.type === "pause") return { type: "pause", id: bloc.id, message: bloc.message };
      // <c5:formes-5b>
      // Formes de la 5b (L42a), employées par les exemples de L45b : chaque étape est renommée comme les autres, et `repli`
      // d'un aiguillage nomme un ASSISTANT — il suit donc la même table (sans quoi la phrase « Envoyer à cet assistant »
      // citerait un identifiant de catalogue, jamais le nom réel de l'assistant installé).
      if (bloc.type === "relecture") {
        return {
          type: "relecture",
          id: bloc.id,
          auteur: renomme(bloc.auteur),
          relecteur: renomme(bloc.relecteur),
          toursMax: bloc.toursMax,
          pauseAvantRelecture: bloc.pauseAvantRelecture,
        };
      }
      if (bloc.type === "aiguillage") {
        return {
          type: "aiguillage",
          id: bloc.id,
          aiguilleur: renomme(bloc.aiguilleur),
          specialistes: bloc.specialistes.map(renomme),
          choixMax: bloc.choixMax,
          synthese: bloc.synthese === null ? null : renomme(bloc.synthese),
          ...(bloc.repli === undefined ? {} : { repli: noms.get(bloc.repli) ?? bloc.repli }),
        };
      }
      return bloc;
      // </c5:formes-5b>
    }),
  };
}
