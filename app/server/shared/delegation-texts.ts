// Textes du travail délégué par l'IA hors équipes (spécification §3.14, §6 l.1038, décision n° 4 ; plan d'exécution, fiche L1d et
// question Q5) : avis du mode Simple, message envoyé à l'IA avec le refus Simple, refus de la garde du « task once » par code
// (409 delegation-refusee) et messages de la route des détails d'une délégation. Convention TEXTES de T0 (textes.test.ts).
// Q5 (décision de l'utilisateur, option b) : l'avis Simple s'arrête à « elle continue seule. », sans [Voir les équipes] ni phrase
// sur les équipes tant qu'elles n'existent pas (P3) ; le texte complet viendra en itération 4 (L38).
// Honnêteté (P3), chaque phrase tenue par task-once-guard.test.ts :
// - « Rien n'a été lancé » : un refus de la garde ne relaie jamais le « once » (aucune réponse reçue par opencode) ;
// - « La demande d'autorisation reste en attente » : la garde ne répond rien à opencode, la demande reste à l'utilisateur ;
// - l'avis Simple : le refus part avec le message à l'IA par rejectWhenAlone, jamais avant la réponse à une autre demande de la même
//   conversation (votre autre demande n'est pas annulée) ; M9 (l'IA continue seule sur une IA Copilot réelle) : recette en attente.
//   Rendu au « once » seulement quand ce refus est en cours (lancé par la dérivation ou par le « once » lui-même) ;
// - « elle attend votre réponse » (avis Simple sans refus) : trop de refus Simple en cours (SIMPLE_JOBS_MAX), aucun refus n'est lancé
//   pour cette demande, rien n'est relayé ; elle reste à l'utilisateur.
// L1f (interface du portillon et Diagnostic, spécification §3.14, §3.11 ; textes rangés ici pour être contrôlés par le test « textes »,
// les composants de chat/delegation et DelegationDiagnostics les lisent) : carte détaillée du mode Avancé, bandeaux du Diagnostic et
// état des agents internes. Honnêteté, chaque phrase tenue par diagnostics-11.test.ts ou par le code cité :
// - « Tout @fichier … est lu sans vous demander » : opencode joint le fichier cité à la consigne de l'enfant sans demande
//   (§4.10) ; la garde (L1d, « consigne-refusee ») refuse « Autoriser une fois » pour une consigne qui cite un fichier existant ;
// - « Le cockpit arrête la conversation au-delà du plafond » : DelegationWatch (L1e), dans les deux modes, plafonds budget.delegation
//   (nombre et dépense) d'une conversation du cockpit ;
// - extensions : leurs outils ne sont visés par aucune règle d'autorisation (oc-uncontrolled.ts, §4.10), d'où « peuvent » ;
// - bandeaux : chacun n'est affiché que si son relevé l'a constaté (diagnostics-11.ts) ; aucune phrase ne dit « aucun » ; un relevé
//   impossible est dit par le bandeau « illisible » (train it1 V4), qui annonce qu'un bandeau « peut manquer », jamais qu'il manque ;
// - agents internes : « installation en attente d'un moment sans réponse en cours » (§3.11) seulement avec une reprise planifiée ;
//   « refusée par opencode » : échec sans reprise (retour arrière de L1g), nouvel essai au prochain ensureAll (démarrage du cockpit,
//   redémarrage d'opencode).
import type { DelegationDetailsView, DelegationRefusalCode, RuleActionLite } from "./activity-types.ts";
import { formatUsd } from "./assistant-rules.ts";
import type { DelegationBanner, DelegationCheck, InternalAgentStatus } from "./cockpit-event-types.ts";

export const TEXTES = {
  simple: {
    /** Avis affiché en mode Simple quand l'IA veut déléguer (Q5, option b). */
    avis: "En mode Simple, l'IA ne délègue pas : elle continue seule.",
    // --- équipes (it4) : début ---
    /**
     * Avis COMPLET (spécification §3.14 l.437), affiché à la place du court SEULEMENT quand les équipes sont ouvertes dans le mode
     * courant (`ouvertesEnSimple` de GET /api/teams, c'est-à-dire EQUIPES_SIMPLE_OUVERTES, décision U1). Tant que la constante est
     * fausse, le texte court est gardé : le cockpit n'invite jamais à une fonction qu'il refuserait (P3). L'écart avec la décision
     * Q5 (b), qui prévoyait le texte complet « jusqu'à L38, puis », est consigné par DOC-EQ.
     */
    avisEquipes: "En mode Simple, l'IA ne délègue pas : elle continue seule. Pour faire travailler plusieurs assistants, lancez une équipe.",
    /** Bouton de l'avis complet, vers #/assistants/equipes ; absent avec le texte court (rien à proposer). */
    voirEquipes: "Voir les équipes",
    // --- équipes (it4) : fin ---
    /** « Autoriser une fois » en mode Simple quand le refus d'office n'a pas pu être lancé (trop de refus en cours). */
    avisAttente: "En mode Simple, l'IA ne délègue pas, mais le cockpit n'a pas pu refuser cette demande pour l'instant : elle attend votre réponse. Choisissez « Refuser ».",
    /** Titre de la partie « travail délégué » du Diagnostic. */
    titreDiagnostic: "Travail délégué",
    /** Bandeaux du Diagnostic (§3.14), par code de DelegationBanner ; {noms} : noms concernés, séparés par des virgules. */
    diagnostic: {
      profondeur: "Réglage d'opencode : un travail délégué peut à son tour déléguer du travail (par défaut, il ne le peut pas).",
      "arriere-plan": "Réglage d'opencode : un travail délégué peut continuer en tâche de fond, sans que la conversation attende son résultat.",
      extension:
        "Extensions d'opencode installées : {noms}. Les outils qu'elles ajoutent ne sont visés par aucune règle d'autorisation du cockpit : ils peuvent s'exécuter sans vous demander.",
      "task-allow":
        "Assistants qui délèguent du travail sans vous demander : {noms}. Le cockpit arrête la conversation au-delà du plafond de délégations ou de dépense de la demande.",
      illisible:
        "Diagnostic incomplet : une partie des réglages d'opencode n'a pas pu être lue (opencode ne répond pas, ou sa réponse est inattendue). Un réglage qui laisse déléguer du travail sans vous demander peut manquer ici.",
    },
    /** Agents internes du cockpit (§3.11), sans le mot « agent ». */
    agentsInternes: {
      titre: "Outils internes du cockpit",
      /** Nom affiché par nom réservé (studio.ts, INTERNAL_AGENTS). */
      noms: {
        "cockpit-classifier": "Classement des archives",
        "cockpit-controle": "IA de contrôle",
      },
      /** Nom réservé sans libellé connu. */
      inconnu: "Outil interne du cockpit",
    },
  },
  avance: {
    titreDiagnostic: "Travail délégué (sous-agents)",
    diagnostic: {
      profondeur:
        "subagent_depth vaut plus de 1 dans la configuration d'opencode : un sous-agent peut lancer ses propres sous-agents (par défaut : 1, un sous-agent ne délègue pas).",
      "arriere-plan":
        "Sous-agents en arrière-plan activés (OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS ou OPENCODE_EXPERIMENTAL) : un sous-agent peut travailler en tâche de fond, sans que la conversation attende son résultat.",
      extension:
        "Extensions (plugins) déclarées dans la configuration d'opencode ou déposées dans oc-config/plugin(s)/ : {noms}. Leurs outils ne sont visés par aucune règle du cockpit et peuvent s'exécuter sans demande d'autorisation.",
      "task-allow":
        "Agents dont la règle task vaut allow pour au moins un agent (délégation sans demande d'autorisation) : {noms}. Le cockpit compte ces délégations et arrête la conversation au-delà du plafond de délégations ou de dépense de la demande (budget.delegation).",
      illisible:
        "Relevés impossibles : {noms} (opencode muet, réponse inattendue ou dossier illisible ; détail dans le journal du cockpit). Les bandeaux qui en dépendent peuvent manquer.",
    },
    /** Relevés nommés par le bandeau « illisible » (DelegationCheck). */
    releves: {
      configuration: "configuration effective (GET /config)",
      profondeur: "subagent_depth",
      "arriere-plan": "sous-agents en arrière-plan (GET /experimental/capabilities)",
      extensions: "entrée plugin de la configuration",
      "fichiers-extensions": "oc-config/plugin(s)/",
      agents: "règles task des agents (GET /agent)",
    } satisfies Record<DelegationCheck, string>,
    agentsInternes: {
      titre: "Agents internes du cockpit",
    },
    /** Carte détaillée d'une délégation en attente (§3.14, mode Avancé). */
    carte: {
      titre: "Détails de la délégation",
      chargement: "Lecture des détails de la délégation…",
      illisible: "Détails de la délégation illisibles : opencode ne répond pas.",
      plusEnAttente: "Détails de la délégation indisponibles : cette demande d'autorisation n'est plus en attente.",
      indisponible: "Détails de la délégation indisponibles.",
      reessayer: "Réessayer",
      cible: "Assistant demandé",
      cibleInconnue: "inconnu d'opencode",
      cibleInterne: "interne au cockpit",
      ciblePortee: {
        primary: "réservé aux conversations",
        subagent: "pour le travail délégué",
        all: "conversations et travail délégué",
      },
      ia: "IA du travail délégué",
      iaInconnue: "inconnue",
      iaRefusee: "non autorisée par le cockpit ou indisponible pour votre compte GitHub Copilot",
      estimation: "Estimation",
      estimationValeur: "≈ {montant} en général",
      estimationInconnue: "impossible (IA inconnue ou hors du catalogue)",
      compteurs: "Cette demande",
      compteursValeur: "délégations : {delegations} sur {delegationsMax} · dépense : {depense} sur {plafond}",
      droits: "Droits comparés",
      colonneDroit: "Droit",
      colonneAppelant: "Assistant qui délègue",
      colonneCible: "Assistant demandé",
      droitsNoms: {
        read: "Lire un fichier",
        edit: "Modifier un fichier",
        bash: "Lancer une commande",
        webfetch: "Consulter une page web (Internet fermé)",
        websearch: "Chercher sur Internet (Internet fermé)",
        task: "Déléguer du travail",
        external_directory: "Sortir du dossier de travail",
      },
      actions: {
        allow: "sans demander",
        ask: "demande votre accord",
        deny: "refusé",
      },
      actionInconnue: "inconnu",
      droitsNote:
        "Règles des assistants, sans les refus que le cockpit ajoute à la conversation. Internet est fermé quelle que soit la règle : seul GitHub Copilot est joignable.",
      arobase:
        "Tout @fichier cité dans la consigne est lu sans vous demander : le cockpit refuse « Autoriser une fois » pour une consigne qui cite un fichier existant avec « @ ».",
      refusPrevu: "« Autoriser une fois » sera refusé par le cockpit : {raison}",
      refusPrevuSansRaison: "« Autoriser une fois » sera refusé par le cockpit.",
      raisons: {
        "demande-morte": "cette demande d'autorisation n'est plus active.",
        "cible-refusee": "l'assistant demandé est inconnu, réservé aux conversations ou interne au cockpit.",
        "task-id-hors-arbre": "l'IA veut reprendre un travail qui n'appartient pas à cette conversation.",
        "consigne-refusee": "la consigne cite un fichier avec « @ », une commande « !` » ou une adresse web, ou elle est illisible.",
        "ia-refusee": "son IA n'est pas autorisée par le cockpit ou n'est pas disponible pour votre compte GitHub Copilot.",
        "budget-refuse": "le garde-fou budgétaire refuse (budget du mois atteint, ou IA plus chère que le prix fixé au-delà du seuil).",
        "plafond-atteint": "le plafond de délégations ou de dépense de cette demande est atteint.",
      },
    },
  },
  partout: {
    /** Message joint au refus Simple, lu par l'IA (refus avec message : elle peut continuer seule). */
    messageIa: "Travaille seul : le mode Simple n'autorise pas la délégation.",
    /** Refus de la garde du « task once » (§3.14), par code : 409 delegation-refusee, rien n'est relayé. */
    refus: {
      "demande-morte": "Cette demande d'autorisation n'est plus active : rien n'a été lancé.",
      "cible-refusee":
        "Travail délégué refusé : l'assistant demandé est inconnu, réservé aux conversations ou interne au cockpit. Rien n'a été lancé. La demande d'autorisation reste en attente.",
      "task-id-hors-arbre":
        "Travail délégué refusé : l'IA veut reprendre un travail qui n'appartient pas à cette conversation. Rien n'a été lancé. La demande d'autorisation reste en attente.",
      "consigne-refusee":
        "Travail délégué refusé : sa consigne cite un fichier avec « @ » (il serait lu sans vous demander), une commande « !` » ou une adresse web, ou elle est illisible. Rien n'a été lancé. La demande d'autorisation reste en attente.",
      "ia-refusee":
        "Travail délégué refusé : son IA n'est pas autorisée par le cockpit ou n'est pas disponible pour votre compte GitHub Copilot. Rien n'a été lancé. La demande d'autorisation reste en attente.",
      /** Garde-fou budgétaire, budget du mois atteint. */
      "budget-refuse":
        "Travail délégué refusé par le garde-fou budgétaire : le budget du mois est atteint. Rien n'a été lancé. La demande d'autorisation reste en attente.",
      /** Garde-fou budgétaire, IA plus chère que le prix fixé au-delà du seuil du budget du mois. */
      "budget-refuse-ia-chere":
        "Travail délégué refusé par le garde-fou budgétaire : le seuil du budget du mois est dépassé et son IA coûte plus que le prix fixé. Rien n'a été lancé. La demande d'autorisation reste en attente.",
      "plafond-atteint":
        "Travail délégué refusé : plafond de cette demande atteint (délégations : {delegations} sur {delegationsMax} ; dépense : {depense} sur {plafond}). Rien n'a été lancé. La demande d'autorisation reste en attente.",
    },
    /**
     * opencode n'a pas répondu pendant la vérification : 503, rien n'est relayé. Générique : la garde ne sait pas encore s'il s'agit
     * d'une délégation quand la liste des demandes est illisible. GF5 (D11) : quand opencode RÉPOND mais ne sait pas lister ses
     * demandes (demande en attente sans argument facultatif) et que la table des attentes n'est pas fiable, la phrase est une autre,
     * « liste bloquée » (shared/attentes-texts.ts, phraseListeBloquee) : jamais celle-ci.
     */
    verificationImpossible: "opencode ne répond pas : impossible de vérifier cette demande d'autorisation. Rien n'a été envoyé, réessayez dans un instant.",
    /** Route GET /api/conversations/:rootId/delegations/:permissionId. */
    erreurs: {
      identifiant: "Identifiant de conversation ou de demande invalide.",
      inconnue: "Aucune demande de travail délégué en attente avec cet identifiant dans cette conversation.",
    },
    /** État d'installation d'un agent interne (§3.11, InternalAgentState), dans les deux modes ; {heure} : heure du prochain essai. */
    agentsInternes: {
      installe: "installé",
      enAttente: "installation en attente",
      enAttenteReprise: "installation en attente d'un moment sans réponse en cours ; nouvel essai vers {heure}",
      echecReprise: "installation en échec ; nouvel essai vers {heure}",
      refusee: "installation refusée par opencode ; nouvel essai au prochain démarrage du cockpit ou redémarrage d'opencode",
      nonSuivi: "installation non suivie",
    },
  },
};

/** Remplit un gabarit « {nom} » ; un nom absent des valeurs garde son gabarit. */
function remplir(gabarit: string, valeurs: Readonly<Record<string, string | number>>): string {
  return gabarit.replace(/\{(\w+)\}/g, (match: string, nom: string) => (Object.hasOwn(valeurs, nom) ? String(valeurs[nom]) : match));
}

/** Avis du mode Simple sur la délégation (Q5). */
export function avisSimple(): string {
  return TEXTES.simple.avis;
}
// --- équipes (it4) : début ---


/** Avis du mode Simple sur la délégation, avec le bouton [Voir les équipes] quand il y a lieu (§3.14 l.437). */
export interface AvisDelegation {
  texte: string;
  /** Bouton vers l'onglet Équipes ; null avec le texte court : aucune invitation à une fonction fermée (P3, U1). */
  bouton: { libelle: string; href: string } | null;
}

/** Adresse de l'onglet Équipes (web/lib/router.ts) : code, jamais un texte affiché. */
const EQUIPES_HREF = "#/assistants/equipes";

/**
 * Avis du mode Simple avec ou sans les équipes. `ouvertesEnSimple` VRAI (EQUIPES_SIMPLE_OUVERTES, lu par l'interface dans
 * `ouvertesEnSimple` de GET /api/teams) : texte complet et [Voir les équipes] ; FAUX : texte court d'avant, sans bouton (U1). Le
 * refus envoyé à opencode, lui, garde toujours `avisSimple()`.
 */
export function avisDelegationSimple(ouvertesEnSimple: boolean): AvisDelegation {
  if (!ouvertesEnSimple) return { texte: TEXTES.simple.avis, bouton: null };
  return { texte: TEXTES.simple.avisEquipes, bouton: { libelle: TEXTES.simple.voirEquipes, href: EQUIPES_HREF } };
}


// --- équipes (it4) : fin ---
/** Avis du mode Simple quand aucun refus d'office n'a pu être lancé : la demande attend l'utilisateur. */
export function avisSimpleEnAttente(): string {
  return TEXTES.simple.avisAttente;
}

/** Message joint au refus Simple, envoyé à l'IA (décision n° 4). */
export function messageRefusSimple(): string {
  return TEXTES.partout.messageIa;
}

/** Compteurs du plafond par demande, pour la phrase « plafond-atteint ». */
export interface PlafondValeurs {
  delegations: number;
  delegationsMax: number;
  depenseUsd: number;
  plafondUsd: number;
}

/**
 * Phrase d'un refus de la garde. `budget` : code du garde-fou budgétaire (ledger.guard) pour « budget-refuse » ; `plafond` : compteurs
 * pour « plafond-atteint » (sans eux, la phrase garde ses gabarits : jamais de chiffre inventé).
 */
export function refusDelegation(
  code: DelegationRefusalCode,
  details: { budget?: "budget-exhausted" | "expensive-model" | null; plafond?: PlafondValeurs | null } = {},
): string {
  const { refus } = TEXTES.partout;
  switch (code) {
    case "budget-refuse":
      return details.budget === "expensive-model" ? refus["budget-refuse-ia-chere"] : refus["budget-refuse"];
    case "plafond-atteint": {
      const p = details.plafond;
      if (!p) return refus["plafond-atteint"];
      return remplir(refus["plafond-atteint"], {
        delegations: p.delegations,
        delegationsMax: p.delegationsMax,
        depense: formatUsd(p.depenseUsd),
        plafond: formatUsd(p.plafondUsd),
      });
    }
    default:
      return refus[code];
  }
}

/** 503 : vérification impossible (opencode injoignable ou réponse illisible). */
export function verificationImpossible(): string {
  return TEXTES.partout.verificationImpossible;
}

/** Messages d'erreur de la route des détails : 400 et 404. */
export function erreurDetails(erreur: "identifiant" | "inconnue"): string {
  return TEXTES.partout.erreurs[erreur];
}

// --- L1f : Diagnostic ----------------------------------------------------------------------------------------------------------

/** Titre de la partie « travail délégué » du Diagnostic. */
export function titreDiagnostic(advanced: boolean): string {
  return advanced ? TEXTES.avance.titreDiagnostic : TEXTES.simple.titreDiagnostic;
}

/** Libellé d'un relevé du bandeau « illisible » (mode Avancé) ; relevé inconnu (serveur plus récent) : son code. */
function libelleReleve(nom: string): string {
  const releves: Readonly<Record<string, string>> = TEXTES.avance.releves;
  return Object.hasOwn(releves, nom) ? (releves[nom] ?? nom) : nom;
}

/**
 * Phrase d'un bandeau du Diagnostic (§3.14) ; les noms (déjà bornés par le collecteur) sont joints par des virgules, et ceux d'un
 * bandeau « illisible » (relevés impossibles) remplacés par leur libellé. null : code inconnu de cette interface (serveur plus
 * récent), rien n'est affiché pour lui.
 */
export function bandeauDiagnostic(banner: DelegationBanner, advanced: boolean): string | null {
  const textes: Readonly<Record<string, string>> = advanced ? TEXTES.avance.diagnostic : TEXTES.simple.diagnostic;
  const gabarit = Object.hasOwn(textes, banner.code) ? textes[banner.code] : undefined;
  if (gabarit === undefined) return null;
  const noms = Array.isArray(banner.noms) ? banner.noms : [];
  return remplir(gabarit, { noms: (banner.code === "illisible" ? noms.map(libelleReleve) : noms).join(", ") });
}

/** Titre de la liste des agents internes. */
export function titreAgentsInternes(advanced: boolean): string {
  return advanced ? TEXTES.avance.agentsInternes.titre : TEXTES.simple.agentsInternes.titre;
}

/** Libellé d'un agent interne par son nom réservé ; null : nom sans libellé connu. */
export function libelleAgentInterne(nom: string): string | null {
  const noms: Readonly<Record<string, string>> = TEXTES.simple.agentsInternes.noms;
  return Object.hasOwn(noms, nom) ? (noms[nom] ?? null) : null;
}

/** Nom affiché d'un agent interne : libellé connu ; sinon, en mode Avancé, le nom réservé, et en mode Simple un libellé générique. */
export function nomAgentInterne(nom: string, advanced: boolean): string {
  return libelleAgentInterne(nom) ?? (advanced ? nom : TEXTES.simple.agentsInternes.inconnu);
}

/**
 * État d'installation d'un agent interne (§3.11, L1g) ; `heure` met en forme l'heure du prochain essai. « en-attente » sans
 * échéance : aucune tentative encore (avant le premier ensureAll) ; « echec » sans échéance : refusé par opencode, aucune reprise
 * automatique (internal-agents.ts).
 */
export function etatAgentInterne(status: Pick<InternalAgentStatus, "etat" | "prochainEssai">, heure: (ms: number) => string): string {
  const t = TEXTES.partout.agentsInternes;
  const essai = status.prochainEssai;
  switch (status.etat) {
    case "installe":
      return t.installe;
    case "en-attente":
      return essai === null ? t.enAttente : remplir(t.enAttenteReprise, { heure: heure(essai) });
    case "echec":
      return essai === null ? t.refusee : remplir(t.echecReprise, { heure: heure(essai) });
    default:
      return t.nonSuivi;
  }
}

// --- L1f : carte détaillée du mode Avancé ------------------------------------------------------------------------------------

/**
 * Assistant demandé : titre (et nom s'il diffère), portée, « interne au cockpit ». Titre et nom viennent d'opencode ou du Studio :
 * l'appelant les borne et retire les caractères cachés avant (texte rendu tel quel, jamais du HTML).
 */
export function libelleCible(cible: DelegationDetailsView["cible"]): string {
  const c = TEXTES.avance.carte;
  if (cible === null) return c.cibleInconnue;
  const portees: Readonly<Record<string, string>> = c.ciblePortee;
  const parts = [
    cible.titre === cible.nom || cible.titre === "" ? cible.nom : `${cible.titre} (${cible.nom})`,
    Object.hasOwn(portees, cible.mode) ? (portees[cible.mode] ?? cible.mode) : cible.mode,
  ];
  if (cible.interne) parts.push(c.cibleInterne);
  return parts.join(" · ");
}

/** IA du travail délégué, avec la raison d'un refus. */
export function libelleIa(ia: DelegationDetailsView["ia"]): string {
  const c = TEXTES.avance.carte;
  const nom = ia.model ?? c.iaInconnue;
  return ia.disponible ? nom : `${nom} : ${c.iaRefusee}`;
}

/** Estimation « en général » d'un travail délégué ; null : impossible (IA inconnue ou hors du catalogue). */
export function phraseEstimation(usd: number | null): string {
  const c = TEXTES.avance.carte;
  return usd === null || !Number.isFinite(usd) ? c.estimationInconnue : remplir(c.estimationValeur, { montant: formatUsd(usd) });
}

/** Compteurs de la demande : délégations et dépense, sur leurs plafonds. */
export function phraseCompteurs(compteurs: DelegationDetailsView["compteurs"]): string {
  return remplir(TEXTES.avance.carte.compteursValeur, {
    delegations: compteurs.delegations,
    delegationsMax: compteurs.delegationsMax,
    depense: formatUsd(compteurs.depenseUsd),
    plafond: formatUsd(compteurs.plafondUsd),
  });
}

/** Nom d'un droit comparé ; un droit sans libellé garde son nom de permission. */
export function libelleDroit(permission: string): string {
  const noms: Readonly<Record<string, string>> = TEXTES.avance.carte.droitsNoms;
  return Object.hasOwn(noms, permission) ? (noms[permission] ?? permission) : permission;
}

/** Action d'une règle ; null ou action inconnue : « inconnu ». */
export function libelleAction(action: RuleActionLite | null): string {
  const c = TEXTES.avance.carte;
  return action !== null && Object.hasOwn(c.actions, action) ? c.actions[action] : c.actionInconnue;
}

/** Refus que la garde opposerait à « Autoriser une fois » ; un code inconnu garde la phrase sans raison. */
export function phraseRefusPrevu(code: DelegationRefusalCode): string {
  const c = TEXTES.avance.carte;
  return Object.hasOwn(c.raisons, code) ? remplir(c.refusPrevu, { raison: c.raisons[code] }) : c.refusPrevuSansRaison;
}
