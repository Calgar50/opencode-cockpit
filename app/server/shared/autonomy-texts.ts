// Phrases de l'autonomie (spécification §2.1, §4.1, §4.3, §4.4 à §4.8.1, §4.10 à §4.13, §6 ; plan d'exécution, fiche L9b et §3.5 ;
// mesures MX1 « coût par étape » et M16, MX2 M5) : « Règle : {phrase} » de chaque code (E, S, D, R, X, plafonds, IA de contrôle),
// refus d'activation, décisions et « Par », carte d'attente, bandeau, Journal du contrôle, plafonds, retours à « Demander à chaque
// fois », fins de demande, confirmations d'« Autonome avec contrôle » et de « Modifications automatiques », estimation « en
// général / au plus ». Les codes viennent de autonomy-rules.ts, autonomy-edit-rules.ts et shell-gate.ts.
// Libellés, descriptions et raisons de base des choix : autonomy-choice-texts.ts (L6a), repris ici par ses fonctions, sans doublon.
// Convention de T0 (textes.test.ts) : TEXTES pour les phrases communes, TEXTES_VARIANTES pour celles qui changent avec l'IA de
// contrôle (budget.autonomie.controleIa ; repli §7.4 : controleIa faux, tout « à juger » attend votre accord). « Un sens par mot » :
// ni « pause » ni « relecture », « mode » seulement dans « mode Simple » ou « mode Avancé ».
// Honnêteté (P3) :
// - dépassement du plafond de coût : chaque étape d'un tour est un appel clos avec son coût avant l'appel suivant (MX1 §7) ; la
//   surveillance arrête l'arbre entre deux appels, le dépassement se limite à l'appel en cours de chaque session occupée : « l'appel
//   en cours de chaque assistant au travail », jamais « un tour ». Réserve mesurée (MX1 §5) : l'appel qui donne son titre à une
//   nouvelle conversation n'est porté par aucun message, donc pas compté : la confirmation le dit ;
// - M5 (MX2 §2) : la partie bash est publiée 3 à 4 ms avant son effet, mais un arrêt n'empêche pas l'effet : « le cockpit les
//   repère après coup et arrête la demande » est gardée telle quelle ;
// - « au plus » seulement avec un plafond d'arrêt, dépassement annoncé (§6 l.1049) ;
// - E1, P02, P03 et G04 attendent aussi quand le cockpit n'a pas pu vérifier les faits (lien en boucle, alias de nom, fichier à
//   deux noms, dossier trop grand ou illisible, historique ou index git) : leur phrase le dit (relecture 2-vague-1) ;
// - {raison} d'une décision de l'IA de contrôle et {dossier} sont des données : l'interface les échappe à l'affichage.
// Module pur (server/shared).
import type { UiMode } from "./assistant-rules.ts";
import { libelleChoix, raisonIndisponible } from "./autonomy-choice-texts.ts";
import { isActivationRefusalCode, isShellConsultationRule } from "./autonomy-rules.ts";
import type {
  ActivationRefusalCode,
  AutonomyRequestView,
  ChoiceCause,
  DecisionBy,
  DecisionVerdict,
  RelayOutcome,
  RequestEnd,
} from "./autonomy-types.ts";

const ANNULER = "Annuler";
const JAMAIS = "Jamais : ce que l'assistant refuse.";

export const TEXTES = {
  simple: {
    regles: {
      D1: "Assistant inconnu, principal ou réservé au cockpit",
      "R-repetition": "L'IA répète la même action",
      "R-autre": "Action que le cockpit ne sait pas contrôler",
    },
    plafonds: {
      delegations: "Plafond de délégations atteint ({n}) : les suivantes sont refusées et l'IA continue seule.",
    },
    confirmationModifications: {
      accord: "Toujours avec votre accord : fichiers protégés, suppressions et vidages, fichiers hors du dossier, commandes et web.",
    },
  },
  avance: {
    regles: {
      D1: "Agent absent de la liste, principal (primary) ou interne au cockpit",
      "R-repetition": "Boucle détectée (doom_loop)",
      "R-autre": "Outil que le cockpit ne contrôle pas (MCP, extension ou autre)",
    },
    plafonds: {
      delegations: "Plafond de délégations atteint ({n}) : les suivantes attendent votre accord.",
    },
    confirmationModifications: {
      accord:
        "Toujours avec votre accord : fichiers protégés, suppressions et vidages, fichiers hors du dossier, commandes, web et travail délégué.",
    },
  },
  partout: {
    /** Phrase de chaque code de règle (« Règle : {phrase} » sur la carte, colonne Raison du Journal) ; sans point final. */
    regles: {
      // Décisions automatiques (§4.12).
      "A-edit": "Modification dans le dossier de la conversation",
      "A-task": "Travail délégué conforme, dans les plafonds",
      "A-skill": "Lecture d'une fiche de l'assistant",
      // Modification, E1 à E6 (§4.4) ; E2 : phrase exacte de la spécification.
      E1: "Fichier hors du dossier de la conversation, lien qui en sort, ou fichier que le cockpit n'a pas pu vérifier",
      E2: "Fichier protégé (configuration, CI/CD, infrastructure ou consignes d'IA)",
      E3: "Suppression, déplacement, vidage ou remplacement d'un fichier",
      E4: "Modification illisible : le cockpit ne peut pas voir ce qui change",
      E5: "Plafond de fichiers modifiés atteint : retour à « {demander} »",
      E6: "Conversation hors des dossiers de travail du cockpit",
      // Commandes, S1 à S7 (§4.5).
      B01: "Commande vide ou trop longue (plus de 400 caractères)",
      B02: "Caractère inhabituel : saut de ligne, tabulation ou caractère hors ASCII",
      B03: "Guillemet simple non fermé",
      B04: "Texte collé à une chaîne entre guillemets",
      B05: "Caractère spécial du shell : enchaînement, redirection, substitution ou variable",
      C01: "Programme écrit entre guillemets",
      C02: "Affectation de variable en tête de commande",
      C03: "Programme désigné par un chemin",
      O01: "Option que le cockpit ne connaît pas pour ce programme",
      O02: "Option sans sa valeur",
      O03: "Valeur d'option inattendue",
      O04: "Trop d'arguments pour ce programme",
      O05: "Argument manquant pour ce programme",
      "S4-reseau": "Commande qui touche au réseau",
      "S4-production": "Commande qui touche à la production",
      "S4-code": "Commande qui exécute du code",
      "S4-enveloppes": "Commande qui en lance une autre",
      "S4-suppression": "Commande qui supprime, déplace, copie ou change les droits de fichiers",
      "S4-editeurs": "Commande qui modifie des fichiers",
      "S4-declarations": "Déclaration ou commande interne du shell",
      "S4-git": "Commande git qui n'est pas une consultation, ou option globale de git",
      P01: "Chemin dans le dossier personnel (« ~ »)",
      P02: "Chemin hors du dossier de la conversation, lien qui en sort, ou chemin que le cockpit n'a pas pu vérifier",
      P03: "Fichier ou dossier sensible (clés, secrets, .env, .git ou configuration d'outils), ou contenu que le cockpit n'a pas pu vérifier",
      G04: "Dépôt git qui peut lancer un programme (configuration, hook ou sous-module) ou que le cockpit n'a pas pu vérifier, ou .git qui n'est pas un dossier",
      U01: "Adresse réseau dans la commande (URL, hôte ou adresse IP)",
      // Délégation, D2 à D7 (§4.7) ; D1 dépend du mode.
      D2: "Reprise d'un travail délégué d'une autre conversation",
      D3: "Consigne qui cite un fichier (@…), une commande « !` », une adresse web, « ~ », un chemin absolu ou « .. »",
      D4: "IA non disponible sur votre compte, ou fournisseur refusé",
      D5: "Le garde-fou budgétaire refuse ce travail délégué",
      D6: "Plafond de délégations de la demande atteint",
      D7: "Coût estimé supérieur au reste du plafond d'arrêt",
      // « Passé sans contrôle » (§4.10) : famille des formes qu'opencode lance sans rien demander, vues après coup par L10c.
      "F-l": "Commande qu'opencode a lancée sans demande d'autorisation (affectation, déclaration ou redirection seule)",
      // Routes (§4.3 étape 4, §4.1).
      "R-web": "Accès au web",
      "R-hors-projet": "Dossier hors du projet",
      "R-lecture": "Lecture que l'assistant ne fait qu'avec votre accord (un .env, par exemple)",
      "R-modifications": "En « {modifications} », seules les modifications de fichiers passent sans vous demander",
      // Pré-conditions (§4.3 étape 3).
      "X-coupee": "Autonomie coupée sur ce cockpit",
      "X-hors-demande": "Action hors d'une demande suivie par le cockpit",
      "X-illisible": "Le cockpit n'a pas pu vérifier que le choix d'autonomie s'applique à cette action",
      "plafond-cout": "Plafond d'arrêt de la demande atteint",
      "plafond-actions": "Plafond d'actions automatiques atteint",
      "plafond-duree": "Durée maximale de la demande atteinte",
      "plafond-fichiers": "Plafond de fichiers modifiés atteint",
      /** Code d'une version plus récente ou d'un autre module : jamais une phrase inventée. */
      inconnue: "Règle inconnue de cette version du cockpit",
    },
    /** Consultation automatique de la porte des commandes (A-grep, A-git-status, A-find… : isShellConsultationRule). */
    consultation: "Consultation dans le dossier de la conversation",
    /** Commandes interdites S4 : l'IA de contrôle n'est jamais consultée (décisions n° 6 et 7). */
    interdit: "{phrase} (l'IA de contrôle n'est pas consultée)",
    /** Carte d'une demande en examen ou en attente (§4.3 étape 7, §4.13). */
    carte: {
      examen: "Contrôle de sécurité en cours…",
      regle: "Règle : {phrase}",
    },
    /** Sort d'une réponse relayée (§4.3 étape 5). */
    relais: {
      "deja-repondu": "Déjà répondu par vous.",
      expiree: "Demande expirée : opencode ne l'attend plus.",
    },
    /** Décisions (§2.1) et « Par » (§4.12). */
    decisions: {
      auto: "Autorisé automatiquement",
      attente: "En attente de votre accord",
      "refus-auto": "Refusé automatiquement",
      "non-controle": "Passé sans contrôle",
    },
    par: {
      regles: "règles",
      "ia-controle": "IA de contrôle",
      vous: "vous",
      cockpit: "cockpit",
    },
    commandes: {
      autoriser: "Autoriser une fois",
      refuser: "Refuser…",
      arreter: "Arrêter",
      journal: "Journal",
      voirModifications: "Voir les modifications de cette demande",
      lancerAutonome: "Lancer en autonome",
      activer: "Activer",
      annuler: ANNULER,
    },
    /** Bandeau (§4.12) : « Autonome avec contrôle · 12 automatiques · 1 en attente · 0,08 $ sur 1,00 $ ». */
    bandeau: {
      resume: "{choix} · {automatiques} · {attentes} · {depense} sur {plafond}",
      automatique: "{n} automatique",
      automatiques: "{n} automatiques",
      attentes: "{n} en attente",
    },
    /** Journal du contrôle (§4.12). */
    journal: {
      titre: "Journal du contrôle",
      colonnes: {
        heure: "Heure",
        qui: "Qui",
        action: "Action",
        decision: "Décision",
        par: "Par",
        regle: "Règle",
        raison: "Raison",
        cout: "Coût du contrôle",
      },
      quiDelegue: "{nom} (travail délégué)",
      // Train de la vague 3 (it2) : phrase alignée sur le §5.4, signalée par L12b (bandeau) et L12c (Journal), qui l'écrivaient
      // chacun à sa façon. Le Déroulé garde son gabarit, qui sait dire « cette conversation » ; les deux disent le même mot.
      vide: "Aucune décision automatique pour cette demande.",
    },
    /** Plafonds d'« Autonome avec contrôle » (§4.8.1, décision n° 9). */
    plafonds: {
      libelles: {
        plafondUsd: "Arrêt automatique à",
        actionsMax: "Actions automatiques",
        delegationsMax: "Délégations",
        dureeMinutes: "Durée (minutes)",
        fichiersMax: "Fichiers modifiés",
        controlesIaMax: "Contrôles par IA",
      },
      cout: "Arrêtée : plafond d'arrêt atteint ({depense} sur {plafond}). L'appel en cours de chaque assistant au travail peut l'avoir dépassé ; GitHub Copilot peut facturer un appel interrompu.",
      actions: "Plafond d'actions automatiques atteint ({n}) : retour à « {demander} ».",
      duree: "Durée maximale atteinte ({n} min) : retour à « {demander} ».",
      fichiers: "Plafond de fichiers modifiés atteint ({n}) : retour à « {demander} ».",
      controles: "Plafond de contrôles par IA atteint ({n}) : les commandes à juger attendent votre accord.",
    },
    /** Dépassement possible du plafond de coût (mesure MX1 « coût par étape »). */
    depassement: "l'appel en cours de chaque assistant au travail peut le dépasser un peu",
    /** Cause d'un retour à « Demander à chaque fois » (§4.11, décision n° 10). */
    retours: {
      "redemarrage-cockpit": "Retour à « {demander} » : le cockpit a redémarré.",
      interrompue: "Retour à « {demander} » : opencode a redémarré et la demande a été interrompue.",
      "agent-non-conforme": "Retour à « {demander} » : l'assistant choisi agit déjà sans demander, le contrôle ne verrait pas ses actions.",
      "plafond-cout": "Retour à « {demander} » : plafond d'arrêt atteint.",
      "plafond-actions": "Retour à « {demander} » : plafond d'actions automatiques atteint.",
      "plafond-duree": "Retour à « {demander} » : durée maximale atteinte.",
      "plafond-fichiers": "Retour à « {demander} » : plafond de fichiers modifiés atteint.",
    },
    /** Fin d'une demande autonome de l'instance principale (autonomy_requests.fin) ; plafonds : phrases des plafonds. */
    fins: {
      terminee: "Demande terminée.",
      vous: "Demande arrêtée par vous.",
      "non-controle": "Passé sans contrôle : la demande a été arrêtée.",
      rechargement: "Demande arrêtée : opencode a été rechargé.",
      "redemarrage-cockpit": "Demande interrompue : le cockpit a redémarré.",
      interrompue: "Demande interrompue : opencode a redémarré.",
    },
    /** Refus d'activation propres au port d'activation (§4.10, §4.11) ; les autres codes : autonomy-choice-texts.ts. */
    refusActivation: {
      "regle-allow":
        "Cet assistant agit déjà sans demander pour modifier, lancer une commande, confier du travail ou aller sur le web (ou ses droits n'ont pas pu être lus) : le contrôle ne verrait pas ces actions.",
      "mcp-ou-extension":
        "Des serveurs MCP ou des extensions sont configurés dans opencode (ou sa configuration n'a pas pu être lue) : le contrôle ne verrait pas leurs actions.",
      "profil-sans-confirmation":
        "Le profil de droits « Sans confirmation (déconseillé) » est actif (ou n'a pas pu être vérifié) : l'IA agirait sans rien demander.",
      "plancher-non-verifie":
        "Le cockpit n'a pas pu vérifier les protections de cette conversation, dont le refus de lire les fichiers de clés.",
    },
    /** 409 raccourci-refuse-autonomie (§4.10). */
    raccourciRefuse:
      "Raccourci refusé : il lance des commandes sans demande (lignes « !` »), refusées en « {modifications} » et en « {autonome} ».",
    /** IA de contrôle (§4.6, §6 l.1041-1042) ; {raison} vient de l'IA, masquée et bornée : à échapper. */
    controleIa: {
      autorise: "Autorisé par l'IA de contrôle : {raison}",
      attend: "L'IA de contrôle demande votre accord : {raison}",
      illisible: "Réponse illisible de l'IA de contrôle : en attente de votre accord.",
      sansReponse: "L'IA de contrôle n'a pas répondu à temps : en attente de votre accord.",
      /** Aucune réponse n'a été lue (contrôle non préparé, appel ou réponse en erreur) : la décision revient au cockpit. */
      nonAbouti: "Le contrôle par IA n'a pas abouti : en attente de votre accord.",
      indisponible: {
        "a-venir": "Contrôle par IA pas encore disponible dans cette version du cockpit : en attente de votre accord.",
        desactive: "Contrôle par IA coupé dans les réglages : en attente de votre accord.",
        "ia-rapide-absente": "Contrôle par IA indisponible : aucune IA Rapide disponible sur votre compte.",
        "budget-refuse": "Contrôle par IA non lancé : le garde-fou budgétaire le refuse. En attente de votre accord.",
        "plafond-controles": "Plafond de contrôles par IA atteint : en attente de votre accord.",
        "facturation-suspendue": "Contrôle par IA non lancé : le cockpit n'envoie aucun appel facturé en ce moment. En attente de votre accord.",
        "agent-non-installe": "Contrôle par IA indisponible : l'assistant de contrôle du cockpit n'est pas encore installé. En attente de votre accord.",
      },
    },
    /** Confirmation d'« Autonome avec contrôle » (§4.13), à chaque activation ; « Sans vous demander » : TEXTES_VARIANTES. */
    confirmationAutonome: {
      titre: "Laisser l'IA travailler seule dans cette conversation ?",
      accord:
        "Toujours avec votre accord : fichiers protégés, suppressions, hors projet, web, commandes qui exécutent du code ou touchent au réseau, à la production ou à git.",
      jamais: JAMAIS,
      arret: "Arrêt automatique à {plafond} : {depassement} ; l'appel qui donne son titre à une nouvelle conversation n'est pas compté.",
      horsDemande: "Certaines actions d'opencode ne passent par aucune demande : le cockpit les repère après coup et arrête la demande.",
    },
    /** Première confirmation de « Modifications automatiques » (§4.11) ; « Toujours avec votre accord » dépend du mode. */
    confirmationModifications: {
      titre: "Laisser l'IA modifier les fichiers de cette conversation sans vous demander ?",
      sansDemander: "Sans vous demander : modifier les fichiers de {dossier} sauf fichiers protégés.",
      jamais: JAMAIS,
    },
    /** Estimation « en général / au plus » (§6 l.1049) : « au plus » seulement avec un plafond d'arrêt. */
    estimation: {
      enGeneral: "En général ≈ {estimation}.",
      auPlus: "En général ≈ {estimation} ; au plus {plafond} : arrêt automatique à ce montant, {depassement}.",
      auDela: "En général ≈ {estimation}, plus que le plafond : arrêt automatique à {plafond}, {depassement}.",
    },
    /** Montants (§4.12 : « 0,08 $ sur 1,00 $ »). */
    montant: "{valeur} $",
    montantMinuscule: "< 0,01 $",
    montantInconnu: "—",
  },
};

/** Phrases qui changent avec l'IA de contrôle (budget.autonomie.controleIa ; repli §7.4 quand elle est coupée). */
export const TEXTES_VARIANTES = {
  avecControleIa: {
    simple: {},
    avance: {},
    partout: {
      regles: {
        S7: "Programme que le cockpit ne connaît pas : jugé par l'IA de contrôle",
      },
      confirmationAutonome: {
        sansDemander:
          "Sans vous demander : modifier les fichiers de {dossier} sauf fichiers protégés ; lancer des commandes de consultation ; faire juger les autres commandes simples par l'IA de contrôle (chaque contrôle est facturé) ; confier du travail dans les plafonds.",
      },
    },
  },
  sansControleIa: {
    simple: {},
    avance: {},
    partout: {
      regles: {
        S7: "Programme que le cockpit ne connaît pas : le contrôle par IA est coupé",
      },
      confirmationAutonome: {
        sansDemander:
          "Sans vous demander : modifier les fichiers de {dossier} sauf fichiers protégés ; lancer des commandes de consultation ; confier du travail dans les plafonds. Les autres commandes attendent votre accord.",
      },
    },
  },
};

export type TextesVariante = keyof typeof TEXTES_VARIANTES;

/** Variante des textes pour budget.autonomie.controleIa. */
export function variante(controleIa: boolean): TextesVariante {
  return controleIa === true ? "avecControleIa" : "sansControleIa";
}

/** Remplit un gabarit « {nom} » ; un nom absent des valeurs garde son gabarit. */
function remplir(gabarit: string, valeurs: Readonly<Record<string, string | number>>): string {
  return gabarit.replace(/\{(\w+)\}/g, (match: string, nom: string) => (Object.hasOwn(valeurs, nom) ? String(valeurs[nom]) : match));
}

/** Libellés des choix cités dans les phrases (repris de autonomy-choice-texts.ts). */
function libellesChoix(): Record<string, string> {
  return { demander: libelleChoix("demander"), modifications: libelleChoix("modifications"), autonome: libelleChoix("autonome") };
}

/** Phrase propre à une clé dans une table, sans jamais lire une clé héritée du prototype (« constructor », « __proto__ »). */
function propre(table: Readonly<Record<string, string>>, cle: string): string | undefined {
  return Object.hasOwn(table, cle) ? table[cle] : undefined;
}

/** Montant en dollars à deux décimales (« 0,08 $ », « 1,00 $ ») ; très petit montant « < 0,01 $ » ; illisible « — ». */
export function montant(usd: number): string {
  const { partout } = TEXTES;
  if (!Number.isFinite(usd)) return partout.montantInconnu;
  if (usd > 0 && usd < 0.005) return partout.montantMinuscule;
  return remplir(partout.montant, { valeur: (Math.round(usd * 100) / 100).toFixed(2).replace(".", ",") });
}

export interface PhraseOptions {
  mode: UiMode;
  controleIa: boolean;
}

/**
 * Phrase d'un code de règle (décision, carte, Journal) : codes E, S (porte des commandes), D, R, X, A-, plafonds, IA de contrôle
 * non consultée et refus d'activation. Code inconnu : « Règle inconnue de cette version du cockpit » (jamais une phrase inventée).
 */
export function phraseRegle(regle: string, options: PhraseOptions): string {
  const section = options.mode === "avance" ? TEXTES.avance : TEXTES.simple;
  const regles = TEXTES.partout.regles;
  const phrase =
    propre(TEXTES_VARIANTES[variante(options.controleIa)].partout.regles, regle) ??
    propre(section.regles, regle) ??
    propre(regles, regle) ??
    (isActivationRefusalCode(regle) ? raisonRefus(regle) : undefined) ??
    (isShellConsultationRule(regle) ? TEXTES.partout.consultation : undefined);
  if (phrase === undefined) return regles.inconnue;
  const rempli = remplir(phrase, libellesChoix());
  return regle.startsWith("S4-") ? remplir(TEXTES.partout.interdit, { phrase: rempli }) : rempli;
}

/** « Règle : {phrase} » de la carte d'attente (§4.13). */
export function regleCarte(regle: string, options: PhraseOptions): string {
  return remplir(TEXTES.partout.carte.regle, { phrase: phraseRegle(regle, options) });
}

const REFUS_PROPRES: ReadonlySet<string> = new Set(Object.keys(TEXTES.partout.refusActivation));

/**
 * Phrase d'un refus d'activation ou d'un choix indisponible (409 et `disponibles[].raison`) : codes propres au port d'activation
 * ici, les autres (« a-venir », « autonomie-coupee », « racine-de-plan », « nouvelle-conversation ») repris de
 * autonomy-choice-texts.ts, dont la phrase fixée de « a-venir ».
 */
export function raisonRefus(code: ActivationRefusalCode): string {
  if (REFUS_PROPRES.has(code)) return TEXTES.partout.refusActivation[code as keyof typeof TEXTES.partout.refusActivation];
  return raisonIndisponible(code);
}

/** Libellé d'une décision (§2.1) de l'instance principale. */
export function libelleDecision(verdict: Exclude<DecisionVerdict, "refus-interdit">): string {
  return TEXTES.partout.decisions[verdict];
}

/** Libellé « Par » (§4.12) de l'instance principale. */
export function libellePar(par: Exclude<DecisionBy, "extension">): string {
  return TEXTES.partout.par[par];
}

/** Phrase d'un relais qui n'a pas abouti (§4.3 étape 5) ; null pour « ok » et « echec » (la demande attend toujours). */
export function phraseRelais(relais: RelayOutcome): string | null {
  return relais === "deja-repondu" || relais === "expiree" ? TEXTES.partout.relais[relais] : null;
}

/** Bandeau d'« Autonome avec contrôle » (§4.12). */
export function bandeau(demande: { auto: number; attentes: number; spent: number; plafondUsd: number }): string {
  const { bandeau: textes } = TEXTES.partout;
  return remplir(textes.resume, {
    choix: libelleChoix("autonome"),
    automatiques: remplir(demande.auto > 1 ? textes.automatiques : textes.automatique, { n: demande.auto }),
    attentes: remplir(textes.attentes, { n: demande.attentes }),
    depense: montant(demande.spent),
    plafond: montant(demande.plafondUsd),
  });
}

/** Plafond atteint pendant une demande (§4.8.1) ; délégations selon le mode (Simple : refus, Avancé : attente). */
export function phrasePlafond(
  plafond: "cout" | "actions" | "duree" | "fichiers" | "delegations" | "controles",
  demande: Pick<AutonomyRequestView, "spent" | "plafonds">,
  mode: UiMode,
): string {
  const { plafonds } = TEXTES.partout;
  const caps = demande.plafonds;
  const choix = libellesChoix();
  switch (plafond) {
    case "cout":
      return remplir(plafonds.cout, { depense: montant(demande.spent), plafond: montant(caps.plafondUsd) });
    case "actions":
      return remplir(plafonds.actions, { ...choix, n: caps.actionsMax });
    case "duree":
      return remplir(plafonds.duree, { ...choix, n: caps.dureeMinutes });
    case "fichiers":
      return remplir(plafonds.fichiers, { ...choix, n: caps.fichiersMax });
    case "delegations":
      return remplir((mode === "avance" ? TEXTES.avance : TEXTES.simple).plafonds.delegations, { n: caps.delegationsMax });
    case "controles":
      return remplir(plafonds.controles, { n: caps.controlesIaMax });
  }
}

/** Cause affichée d'un retour à « Demander à chaque fois » (§4.11) ; null pour un choix fait par un clic. */
export function phraseRetour(cause: ChoiceCause): string | null {
  if (cause === "clic") return null;
  return remplir(TEXTES.partout.retours[cause], libellesChoix());
}

/** Fins d'une demande de la Salle OMO (itération 2 ter) : sans phrase ici. */
export type OmoRequestEnd = "hors-controle" | "homme-mort" | "recreation" | "plafond-tentatives" | "plafond-sessions" | "seuil-mensuel";

/** Phrase de fin d'une demande autonome de l'instance principale ; plafonds : phrase du plafond, avec ses chiffres. */
export function phraseFin(fin: Exclude<RequestEnd, OmoRequestEnd>, demande: Pick<AutonomyRequestView, "spent" | "plafonds">): string {
  switch (fin) {
    case "plafond-cout":
      return phrasePlafond("cout", demande, "simple");
    case "plafond-actions":
      return phrasePlafond("actions", demande, "simple");
    case "plafond-duree":
      return phrasePlafond("duree", demande, "simple");
    case "plafond-fichiers":
      return phrasePlafond("fichiers", demande, "simple");
    default:
      return TEXTES.partout.fins[fin];
  }
}

/** Raison, en code, d'une IA de contrôle non consultée (ControlAiUnavailableCode de contracts-11.ts, même liste). */
export type ControleIaIndisponible = keyof typeof TEXTES.partout.controleIa.indisponible;

/** Phrase d'une IA de contrôle non consultée : la commande attend votre accord (§4.6). */
export function controleIaIndisponible(code: ControleIaIndisponible): string {
  return propre(TEXTES.partout.controleIa.indisponible, code) ?? TEXTES.partout.controleIa.illisible;
}

/**
 * Phrase d'une réponse de l'IA de contrôle (§4.6) : « autoriser » ou « attendre » avec sa raison (texte de l'IA, masqué et borné,
 * à échapper), réponse illisible, délai dépassé, ou contrôle qui n'a pas abouti (aucune réponse lue). Un CODE interne du port
 * n'est jamais affiché : l'appelant choisit l'une de ces phrases (L10a, autonomy.ts).
 */
export function decisionControleIa(reponse: { decision: "autoriser" | "attendre"; raison: string } | "illisible" | "sans-reponse" | "non-abouti"): string {
  const { controleIa } = TEXTES.partout;
  if (reponse === "illisible") return controleIa.illisible;
  if (reponse === "sans-reponse") return controleIa.sansReponse;
  if (reponse === "non-abouti") return controleIa.nonAbouti;
  return remplir(reponse.decision === "autoriser" ? controleIa.autorise : controleIa.attend, { raison: reponse.raison });
}

/** Confirmation d'« Autonome avec contrôle » (§4.13) : lignes dans l'ordre de la spécification, variante selon l'IA de contrôle. */
export function confirmationAutonome(valeurs: { controleIa: boolean; dossier: string; plafondUsd: number }): {
  titre: string;
  lignes: string[];
  lancer: string;
  annuler: string;
} {
  const { confirmationAutonome: textes, commandes, depassement } = TEXTES.partout;
  return {
    titre: textes.titre,
    lignes: [
      remplir(TEXTES_VARIANTES[variante(valeurs.controleIa)].partout.confirmationAutonome.sansDemander, { dossier: valeurs.dossier }),
      textes.accord,
      textes.jamais,
      remplir(textes.arret, { plafond: montant(valeurs.plafondUsd), depassement }),
      textes.horsDemande,
    ],
    lancer: commandes.lancerAutonome,
    annuler: commandes.annuler,
  };
}

/** Première confirmation de « Modifications automatiques » (§4.11). */
export function confirmationModifications(valeurs: { mode: UiMode; dossier: string }): {
  titre: string;
  lignes: string[];
  activer: string;
  annuler: string;
} {
  const { confirmationModifications: textes, commandes } = TEXTES.partout;
  const section = valeurs.mode === "avance" ? TEXTES.avance : TEXTES.simple;
  return {
    titre: textes.titre,
    lignes: [remplir(textes.sansDemander, { dossier: valeurs.dossier }), section.confirmationModifications.accord, textes.jamais],
    activer: commandes.activer,
    annuler: commandes.annuler,
  };
}

/**
 * Estimation « en général / au plus » (§6 l.1049) : « en général » porte l'estimation (moyenne observée ou profil, chooseEstimate),
 * « au plus » seulement le plafond d'arrêt qui l'applique, avec le dépassement annoncé ; sans plafond, jamais « au plus ». Une
 * estimation au-delà du plafond le dit. null : aucune estimation lisible.
 */
export function estimationTexte(estimationUsd: number | null, plafondUsd: number | null): string | null {
  if (typeof estimationUsd !== "number" || !Number.isFinite(estimationUsd) || estimationUsd < 0) return null;
  const { estimation, depassement } = TEXTES.partout;
  const valeurs = { estimation: montant(estimationUsd), depassement };
  if (typeof plafondUsd !== "number" || !Number.isFinite(plafondUsd) || plafondUsd <= 0) return remplir(estimation.enGeneral, valeurs);
  return remplir(estimationUsd > plafondUsd ? estimation.auDela : estimation.auPlus, { ...valeurs, plafond: montant(plafondUsd) });
}

/** 409 raccourci-refuse-autonomie (§4.10). */
export function raccourciRefuse(): string {
  return remplir(TEXTES.partout.raccourciRefuse, libellesChoix());
}

/** « {nom} (travail délégué) » de la colonne Qui du Journal (§4.12). */
export function quiDelegue(nom: string): string {
  return remplir(TEXTES.partout.journal.quiDelegue, { nom });
}
