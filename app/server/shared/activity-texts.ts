// Textes de « Qui travaille ? » (spécification §2.1, §2.3 « États », §5.1, §5.4, §5.5, §5.6 ; plan d'exécution, fiche L5b) :
// libellés des acteurs et de leurs états, détail de « travaille », bandeau, premier bandeau, annonces du lecteur d'écran et réglage
// des annonces. Convention TEXTES de T0, contrôlée par textes.test.ts avec « un sens par mot » : ni « pause », ni « relecture »,
// « mode » seulement dans « mode Simple » ou « mode Avancé ». Vocabulaire du mode Simple (§2.3) : assistant, travail délégué, votre
// accord ; « terminé », jamais « réussi » ; « travaille », jamais « réfléchit ».
// Le réducteur (activity.ts, L4c) rend des CODES ; ce module les met en phrases. Le détail d'un outil (chemin, motif) vient de la
// partie d'outil lue par l'interface, jamais d'un fait : il est masqué par redactSecrets et raccourci ici (texte d'IA, échappé à
// l'affichage par React).
// Module pur (server/shared).
import { redactSecrets } from "../redact.ts";
import type { ActivityAnnouncement } from "./activity.ts";
import type { ActorActivity, ActorState, SessionRole, StatutCause } from "./activity-types.ts";
import { libelleChoix } from "./autonomy-choice-texts.ts";
import type { ChoiceCause } from "./autonomy-types.ts";
import { remplir } from "./neon-texts.ts";

export const TEXTES = {
  simple: {},
  avance: {
    /** Nom de l'erreur d'opencode (code, jamais son message). */
    echecCode: "échec ({erreur})",
    /** Enfant lancé après la fin de la réponse qui délègue (accord tardif, capture p7). */
    detache: "lancé après la fin de la réponse : son résultat ne revient pas dans la conversation",
    /** Délégation lancée par un raccourci (`subtask`). */
    raccourci: "raccourci /{commande}",
    /** `task_id` repris. */
    reprise: "reprend son travail précédent",
  },
  partout: {
    /** §2.1 : nom du bandeau (jamais un libellé de champ). */
    titre: "Qui travaille ?",
    /** §5.4 : premier bandeau. */
    accueil: "Ici, vous voyez qui travaille pour votre demande, depuis quand et pour quel coût.",
    noms: {
      conversation: "Assistant de la conversation",
      delegation: "Travail délégué",
      controle: "Contrôle de sécurité",
      etape: "Étape d'équipe",
    },
    /** §2.3, « États ». */
    etats: {
      "pas-commence": "pas encore commencé",
      "prepare-delegation": "prépare une délégation",
      travaille: "travaille",
      redige: "rédige sa réponse",
      "attend-delegation": "attend le travail délégué",
      "attente-accord": "en attente de votre accord",
      controle: "contrôle de sécurité en cours",
      "attend-verification": "attend votre vérification",
      "nouvelle-tentative": "nouvelle tentative ({n})",
      termine: "terminé",
      echec: "échec",
      arrete: "arrêté",
      "jamais-demarre": "jamais démarré",
      "non-choisi": "non choisi",
    },
    /** §2.3 : « travaille · lit {chemin} / cherche « {motif} » / modifie {chemin} / lance une commande ». */
    activites: {
      lit: "travaille · lit {chemin}",
      litSansDetail: "travaille · lit un fichier",
      cherche: "travaille · cherche « {motif} »",
      chercheSansDetail: "travaille · cherche",
      modifie: "travaille · modifie {chemin}",
      modifieSansDetail: "travaille · modifie un fichier",
      commande: "travaille · lance une commande",
    },
    /** Arrêt lu dans les faits (`statut {cause}`). */
    causes: {
      arret: "arrêté",
      plafond: "arrêté : plafond atteint",
      "non-controle": "arrêté : action passée sans contrôle",
      interrompue: "interrompu : opencode a redémarré",
    },
    /**
     * §6 l.1048, §4.10 : délégation lancée par un raccourci `subtask`, qu'opencode lance sans demande d'autorisation (capture p2 ;
     * fait `consigne` de source « raccourci », délégation `sansConfirmation`). Dite dans les deux modes.
     */
    sansConfirmation: "lancé sans confirmation",
    depuis: "depuis {duree}",
    duree: "{duree}",
    repondre: "Répondre",
    /** Nom accessible de [Répondre] : il dit à quelle demande (plusieurs lignes peuvent en attendre une). */
    repondreA: "Répondre à la demande de : {nom}",
    voir: "Voir le travail",
    voirA: "Voir le travail de : {nom}",
    afficher: "Afficher le détail de « Qui travaille ? »",
    replier: "Replier le détail de « Qui travaille ? »",
    /** §5.6 : bandeau sur une ligne à 400 px. */
    enPlus: "+{n}",
    enPlusA: "et {n} de plus",
    /** Bornes du réducteur (3 niveaux, 50 assistants) ou des faits (20 000) atteintes. */
    partiel: "Déroulé partiel : une partie du travail délégué n'est pas montrée.",
    lectureImpossible: "Qui travaille ? : lecture impossible pour le moment.",
    reessayer: "Réessayer",
    /** §5.5 : transitions annoncées (au plus une annonce toutes les 2 s). */
    annonces: {
      commence: "{nom} : commence à travailler.",
      "attente-accord": "{nom} : en attente de votre accord.",
      termine: "{nom} : terminé.",
      termineEn: "{nom} : terminé en {duree}.",
      echec: "{nom} : échec.",
      arrete: "{nom} : arrêté.",
      arreteCause: "{nom} : {cause}.",
      "jamais-demarre": "{nom} : jamais démarré.",
      "retour-demander": "Autonomie revenue à « {choix} » : {cause}.",
    },
    /** Cause d'un retour à « Demander à chaque fois » sans clic (fait `choix`). */
    retours: {
      clic: "changement de votre part",
      "redemarrage-cockpit": "le cockpit a redémarré",
      interrompue: "opencode a redémarré",
      "agent-non-conforme": "l'assistant ne remplit pas les conditions",
      "plafond-cout": "plafond de coût atteint",
      "plafond-actions": "plafond d'actions atteint",
      "plafond-duree": "durée maximale atteinte",
      "plafond-fichiers": "plafond de fichiers atteint",
    },
    /** Paramètres › Affichage (ActivitySettings). */
    reglages: {
      titre: "Annonces de « Qui travaille ? »",
      libelle: "Annoncer les changements au lecteur d'écran",
      aide: "Au plus une annonce toutes les 2 secondes : qui commence, attend votre accord, termine, échoue ou s'arrête, et le retour de l'autonomie à « Demander à chaque fois ». Aucun texte de la conversation n'est lu.",
      activees: "Annonces activées",
      coupees: "Annonces coupées",
      echec: "Enregistrement impossible",
    },
  },
};

/** Longueur affichée d'un détail d'outil (chemin, motif) ; au-delà, seule la fin est gardée. */
const DETAIL_MAX = 80;

/** Ce que les libellés lisent d'une ligne d'acteur (LiveRow, activity.ts). */
export interface ActorLabelInput {
  role: SessionRole;
  depth: number;
  agent: string | null;
  state: ActorState;
  activity: ActorActivity | null;
  attempt: number | null;
  cause: StatutCause | null;
  erreur: string | null;
}

/** Nom d'un acteur : l'assistant de la conversation, le contrôle de sécurité, sinon le nom de l'assistant délégué. */
export function nomActeur(row: Pick<ActorLabelInput, "role" | "depth" | "agent">): string {
  const { noms } = TEXTES.partout;
  if (row.depth === 0 || row.role === "conversation") return noms.conversation;
  if (row.role === "controle") return noms.controle;
  return row.agent ?? (row.role === "etape" ? noms.etape : noms.delegation);
}

function libelleActivite(activity: ActorActivity, detail: string | null): string {
  const { activites } = TEXTES.partout;
  switch (activity.kind) {
    case "lit":
      return detail === null ? activites.litSansDetail : remplir(activites.lit, { chemin: detail });
    case "cherche":
      return detail === null ? activites.chercheSansDetail : remplir(activites.cherche, { motif: detail });
    case "modifie":
      return detail === null ? activites.modifieSansDetail : remplir(activites.modifie, { chemin: detail });
    default:
      return activites.commande;
  }
}

/**
 * État d'un acteur en clair (§2.3) : détail de « travaille » (outil en cours ; `detail` relu dans la partie d'outil), numéro de la
 * nouvelle tentative, cause d'un arrêt ; en mode Avancé, code de l'erreur d'un échec.
 */
export function libelleEtatActeur(row: ActorLabelInput, detail: string | null, avance: boolean): string {
  const { etats, causes } = TEXTES.partout;
  switch (row.state) {
    case "travaille":
      return row.activity === null ? etats.travaille : libelleActivite(row.activity, detail);
    case "nouvelle-tentative":
      return remplir(etats["nouvelle-tentative"], { n: row.attempt ?? 1 });
    case "arrete":
      return row.cause === null ? etats.arrete : causes[row.cause];
    case "echec":
      return avance && row.erreur !== null ? remplir(TEXTES.avance.echecCode, { erreur: row.erreur }) : etats.echec;
    default:
      return etats[row.state];
  }
}

/** « depuis 42 s » pour un acteur au travail, « 42 s » pour un travail fini ; `duree` déjà formatée par l'interface. */
export function libelleDuree(duree: string, auTravail: boolean): string {
  return remplir(auTravail ? TEXTES.partout.depuis : TEXTES.partout.duree, { duree });
}

export function libelleRepondre(nom: string): string {
  return remplir(TEXTES.partout.repondreA, { nom });
}

export function libelleVoir(nom: string): string {
  return remplir(TEXTES.partout.voirA, { nom });
}

/** « +2 » et son nom accessible « et 2 de plus » (§5.6). */
export function libelleEnPlus(n: number): { court: string; accessible: string } {
  return { court: remplir(TEXTES.partout.enPlus, { n }), accessible: remplir(TEXTES.partout.enPlusA, { n }) };
}

export function libelleRaccourci(commande: string): string {
  return remplir(TEXTES.avance.raccourci, { commande });
}

/**
 * Mentions d'une ligne lancée par un raccourci `subtask` (`commande` du fait `consigne`, source « raccourci ») : « lancé sans
 * confirmation » dans les deux modes (§6 l.1048), précédé en mode Avancé du nom du raccourci. Aucune pour une autre ligne.
 */
export function mentionsRaccourci(commande: string | null, avance: boolean): string[] {
  if (commande === null) return [];
  const { sansConfirmation } = TEXTES.partout;
  return avance ? [libelleRaccourci(commande), sansConfirmation] : [sansConfirmation];
}

function causeRetour(cause: ActivityAnnouncement["cause"]): string {
  const { retours } = TEXTES.partout;
  return cause !== null && Object.hasOwn(retours, cause) ? retours[cause as ChoiceCause] : retours.clic;
}

/** Phrase d'une transition annoncée (§5.5) ; `formatDuree` formate une durée en ms (interface). */
export function phraseAnnonce(annonce: ActivityAnnouncement, formatDuree: (ms: number) => string): string {
  const { annonces, causes } = TEXTES.partout;
  const nom = nomActeur({ role: annonce.role, depth: annonce.role === "conversation" ? 0 : 1, agent: annonce.agent });
  switch (annonce.code) {
    case "termine":
      return annonce.durationMs === null ? remplir(annonces.termine, { nom }) : remplir(annonces.termineEn, { nom, duree: formatDuree(annonce.durationMs) });
    case "arrete": {
      const cause = annonce.cause !== null && Object.hasOwn(causes, annonce.cause) ? causes[annonce.cause as StatutCause] : null;
      return cause === null ? remplir(annonces.arrete, { nom }) : remplir(annonces.arreteCause, { nom, cause });
    }
    case "retour-demander":
      return remplir(annonces["retour-demander"], { choix: libelleChoix("demander"), cause: causeRetour(annonce.cause) });
    default:
      return remplir(annonces[annonce.code], { nom });
  }
}

/** Une seule annonce pour un lot de transitions (au plus une annonce toutes les 2 s). */
export function phrasesAnnonces(lot: readonly ActivityAnnouncement[], formatDuree: (ms: number) => string): string {
  return lot.map((annonce) => phraseAnnonce(annonce, formatDuree)).join(" ");
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const textOf = (value: unknown): string | null => (typeof value === "string" && value.trim() !== "" ? value : null);

/** Chemin du dossier de la conversation retiré, secrets masqués, espaces réduits, fin gardée au-delà de DETAIL_MAX caractères. */
function court(texte: string, dossier: string): string {
  let base = dossier.replaceAll("\\", "/");
  while (base.endsWith("/")) base = base.slice(0, -1);
  let out = texte.replaceAll("\\", "/");
  if (base !== "" && out.startsWith(`${base}/`)) out = out.slice(base.length + 1);
  out = redactSecrets(out).replace(/\s+/g, " ").trim();
  return out.length > DETAIL_MAX ? `…${out.slice(out.length - DETAIL_MAX + 1)}` : out;
}

/**
 * Détail de « travaille » lu dans l'entrée d'une partie d'outil d'opencode (`state.input`) : chemin lu ou modifié (`filePath`,
 * `path`), motif cherché (`pattern`) ; null pour tout autre outil (une commande n'est jamais recopiée, une adresse web non plus).
 */
export function detailOutil(outil: string, entree: unknown, dossier: string): string | null {
  if (!isRecord(entree)) return null;
  switch (outil) {
    case "read":
    case "edit":
    case "write":
    case "multiedit":
    case "patch":
    case "list": {
      const chemin = textOf(entree.filePath) ?? textOf(entree.path);
      return chemin === null ? null : court(chemin, dossier);
    }
    case "grep":
    case "glob":
    case "codesearch": {
      const motif = textOf(entree.pattern) ?? textOf(entree.query);
      return motif === null ? null : court(motif, dossier);
    }
    default:
      return null;
  }
}
