// Textes de la carte des assistants (spécification §2.1 l.64, §5.2 l.887-892, §5.4 l.911, §6 l.1048 ; conception C §7.4, §9.9,
// corrigée ; plan d'exécution it4, fiches T4t §4.3 et L39a). Convention TEXTES de T0, contrôlée par textes.test.ts ; tests propres :
// team-texts.test.ts.
// Codes : agent-map.ts (L39a, écrit en parallèle) rend des CODES, ce module les met en phrases. Listes fermées recopiées TELLES
// QUELLES de la fiche L39a, qui fait foi (le croisement de V0 vérifie l'égalité des clés) : MapEdgeCode (aretes), MapNoteCode
// (notes), MapWarningCode (avertissements), AgentMapErrorCode (erreurs) sauf salle-coupee, rendu par L39o avec la phrase « Salle
// coupée » de la salle. « Caché dans le chat » n'a pas de code (MapNode.cacheDansLeChat).
// Chaque arête dit qui l'applique : « règle d'opencode » ou « imposé par le cockpit » (§5.2). En Simple, aucune mention de la
// profondeur (§5.2 l.891) : la note profondeur-plus n'est rendue qu'en Avancé (L39a), et aucune phrase de `partout` ne nomme la
// profondeur ni un agent.
// Honnêteté (§6 l.1048) : « après votre accord » seulement pour une règle « ask » (parité avec evaluate, L39a) ; « La carte montre ce
// que les règles permettent, pas ce qui s'est passé. » : la carte est dérivée des règles, jamais de l'historique (L39a, L39b).
// Module pur (server/shared), sans import.

const REGLE_OPENCODE = "règle d'opencode";
const IMPOSE = "imposé par le cockpit";

export const TEXTES = {
  simple: {},
  avance: {
    /** Genres d'éléments nommés avec les mots d'opencode, en Avancé seulement (les agents du Studio sont retirés en Simple). */
    genres: {
      "agent-studio": "Agent du Studio",
      "sous-agent": "Sous-agent",
    },
  },
  partout: {
    titre: "Carte des assistants",
    intro: "Qui peut faire travailler qui, avec quelle IA et quels droits.",
    deroule: "Pour voir ce qui s'est passé, ouvrez « Déroulé » dans le chat.",
    vues: {
      libelle: "Vue",
      centree: "Centrée",
      liste: "Liste",
    },
    element: "Élément",
    rechercher: "Rechercher…",
    groupes: {
      assistants: "Assistants",
      raccourcis: "Raccourcis",
      equipes: "Équipes",
      fiches: "Fiches",
    },
    /** Vue Centrée : colonnes de part et d'autre de l'élément choisi (neighbours de L39a). */
    colonnes: {
      amont: "Qui le fait travailler",
      aval: "Qui il fait travailler et ce qu'il consulte",
    },
    personneAmont: "Personne ne le fait travailler.",
    personneAval: "Il ne fait travailler personne et ne consulte aucune fiche.",
    legende: {
      titre: "Légende",
      sans: "sans confirmation",
      accord: "après votre accord",
      impose: IMPOSE,
      ecrit: "Chaque lien est aussi écrit en toutes lettres.",
    },
    /** MapEdge.appliquePar. */
    appliquePar: {
      opencode: REGLE_OPENCODE,
      cockpit: IMPOSE,
    },
    /** Délégation demandée en Simple (MapEdge.refuseEnSimple, décision n° 4). */
    refuseEnSimple: "le cockpit refuse en mode Simple : l'IA continue seule",
    cacheDansLeChat: "caché dans le chat",
    /** MapNodeKind. */
    genres: {
      vous: "Vous",
      assistant: "Assistant",
      integre: "Assistant intégré",
      "agent-studio": "Assistant du Studio",
      "sous-agent": "Assistant délégué",
      raccourci: "Raccourci",
      fiche: "Fiche",
      equipe: "Équipe",
    },
    /** MapNode.ia. */
    ia: {
      propre: "IA : {ia}",
      conversation: "IA : celle choisie dans le chat",
    },
    /** MapEdgeCode : une phrase par arête, vue Liste et voisins de la vue Centrée ({source}, {cible} : noms affichés). */
    aretes: {
      "delegue-sans-confirmation": "« {source} » peut confier du travail à « {cible} » sans vous demander (règle d'opencode).",
      "delegue-apres-accord": "« {source} » peut confier du travail à « {cible} » après votre accord (règle d'opencode).",
      "delegue-refuse-en-simple":
        "« {source} » demanderait votre accord pour confier du travail à « {cible} » ; le cockpit refuse en mode Simple : l'IA continue seule.",
      "raccourci-sans-confirmation":
        "Le raccourci « {source} » lance « {cible} » sans confirmation, puis reprise dans la conversation (règle d'opencode).",
      "consulte-fiche": "« {source} » peut ouvrir la fiche « {cible} » (règle d'opencode).",
      "etape-imposee": "L'équipe « {source} » fait travailler « {cible} » dans une étape (imposé par le cockpit).",
      utilise: "Vous pouvez utiliser « {cible} » dans le chat.",
    },
    /** Fiche ouverte après votre accord (consulte-fiche, confirmation « demandee »). */
    consulteApresAccord: "« {source} » peut ouvrir la fiche « {cible} » après votre accord (règle d'opencode).",
    /**
     * Raccourci qui n'est pas une sous-tâche : arête « lance » de code « utilise » (L39a, liste fermée inchangée). La phrase de
     * « utilise » est celle de Vous ; celle-ci dit ce que fait le raccourci (train de V0, intégrateur).
     */
    raccourciFaitRepondre: "Le raccourci « {source} » fait répondre « {cible} » dans la conversation (règle d'opencode).",
    /** MapNoteCode. */
    notes: {
      "profondeur-un": "ne confie pas de travail plus loin (règle d'opencode)",
      /** Avancé seulement (§5.2 l.891) : subagent_depth > 1 et une règle task. */
      "profondeur-plus": "peut à son tour confier du travail : un réglage d'opencode le permet",
      "ia-du-delegant": "IA de l'assistant qui délègue",
      "aucun-assistant": "Aucun assistant installé : seul l'Assistant général travaille.",
      "aucun-lien": "Aucun assistant ne peut en faire travailler un autre.",
      "regles-pas-historique": "La carte montre ce que les règles permettent, pas ce qui s'est passé.",
    },
    /** MapWarningCode. */
    avertissements: {
      "ia-indisponible": "IA indisponible sur votre compte GitHub Copilot",
      "droits-larges": "peut modifier des fichiers, lancer des commandes ou sortir du dossier sans vous demander",
    },
    /** AgentMapErrorCode, sauf salle-coupee (phrase de la salle, L39o). */
    erreurs: {
      invalid: "Requête invalide.",
      "forbidden-directory": "Ce dossier est hors du workspace monté.",
      "mode-avance": "Cette vue de la carte est réservée au mode Avancé.",
    },
    erreurInconnue: "La carte n'a pas pu être lue.",
    /** « Comprendre en 1 minute » (C §9.9) : refermable une fois ; la quatrième phrase est la phrase d'accueil (§2.2). */
    comprendre: {
      titre: "Comprendre en 1 minute",
      phrases: [
        "Un assistant travaille avec ses propres droits et son IA.",
        "Certains peuvent confier une partie du travail à un autre assistant : la carte montre lesquels, et si votre accord est demandé.",
        "Pendant une demande, « Qui travaille ? » dans le chat montre qui travaille vraiment.",
        "Ce que vous appeliez « modèle de réflexion » s'appelle ici Équipe ou Méthode.",
      ],
      compris: "J'ai compris",
    },
  },
};

const P = TEXTES.partout;

/** Remplit les gabarits « {nom} » ; un nom sans valeur est laissé tel quel. */
export function remplir(gabarit: string, valeurs: Readonly<Record<string, string>>): string {
  return gabarit.replace(/\{(\w+)\}/g, (brut, nom: string) => valeurs[nom] ?? brut);
}

/**
 * Phrase d'une arête ; null pour un code hors de la liste. Une fiche ouverte après votre accord le dit. `kind` (MapEdge.kind) :
 * une arête « lance » de code « utilise » (raccourci qui n'est pas une sous-tâche) dit que le raccourci fait répondre son assistant ;
 * les vues de la carte (L39b) passent toujours le genre de l'arête.
 */
export function phraseArete(code: string, source: string, cible: string, confirmation: string, kind?: string): string | null {
  if (code === "consulte-fiche" && confirmation === "demandee") return remplir(P.consulteApresAccord, { source, cible });
  if (code === "utilise" && kind === "lance") return remplir(P.raccourciFaitRepondre, { source, cible });
  return Object.hasOwn(P.aretes, code) ? remplir(P.aretes[code as keyof typeof P.aretes], { source, cible }) : null;
}

/** Phrase d'une note ; null pour un code hors de la liste. */
export function phraseNote(code: string): string | null {
  return Object.hasOwn(P.notes, code) ? P.notes[code as keyof typeof P.notes] : null;
}

/** Phrase d'un avertissement ; null pour un code hors de la liste. */
export function phraseAvertissement(code: string): string | null {
  return Object.hasOwn(P.avertissements, code) ? P.avertissements[code as keyof typeof P.avertissements] : null;
}

/** Phrase d'une erreur de la route de la carte ; un code hors de la liste (dont salle-coupee) rend une phrase générale. */
export function phraseErreurCarte(code: string): string {
  return Object.hasOwn(P.erreurs, code) ? P.erreurs[code as keyof typeof P.erreurs] : P.erreurInconnue;
}

/** Nom du genre d'un élément ; en Avancé, les mots d'opencode pour les agents du Studio et les sous-agents. */
export function genre(kind: string, avance: boolean): string | null {
  const technique = TEXTES.avance.genres;
  if (avance && Object.hasOwn(technique, kind)) return technique[kind as keyof typeof technique];
  return Object.hasOwn(P.genres, kind) ? P.genres[kind as keyof typeof P.genres] : null;
}
