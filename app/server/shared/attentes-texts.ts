// Textes de la liste des demandes d'autorisation quand opencode ne sait pas la rendre (GF5, décision A31 a ; mesures/D11-permission.md
// §6.4), rangés ici pour être contrôlés par le test « textes » (convention TEXTES de T0, textes.test.ts). Lus par le proxy
// (oc-proxy.ts : 503 « liste-bloquee » de GET /permission et du « once »), la garde du « task once » et la carte des délégations
// (task-once-guard.ts, routes-delegations.ts), et la page de chat (avertissement non bloquant).
//
// Deux causes, jamais confondues (P3) :
// - « opencode ne répond pas » (verificationImpossible, delegation-texts.ts ; PERMISSION_MESSAGES.verificationImpossible) :
//   opencode injoignable, réponse illisible, ou toute erreur autre que la signature exacte du défaut ;
// - « une demande … en attente empêche opencode de lister ses demandes » : opencode répond 400 avec la signature exacte du défaut
//   (demande en attente dont un argument facultatif manque) ET la table des attentes n'est pas prouvée complète. L'outil en cause
//   est déduit de la clé citée par opencode (METADONNEES_FACULTATIVES) : « timeout » et les clés de websearch → web ; « path » et
//   « include » (glob, grep) → recherche dans les fichiers ; autre clé → sans le nommer.
// Honnêteté, chaque phrase tenue par un test :
// - « Rien n'a été envoyé » : sur ce refus, ni « once » ni refus n'est relayé à opencode (permission-gate.test.ts, croisements-v106) ;
// - « refusez-la » : le refus d'une demande n'a pas besoin de la liste (mesure D11 : un « reject » guérit la liste) et il est relayé
//   sans elle (isOrphanOfWorkingSession rend false quand la liste est illisible) ;
// - « rechargez dans un instant » : la table redevient fiable dès la lecture qui suit une reconnexion du flux ou la réponse à la
//   demande en cause (pending-table.test.ts).
// Mode Simple : ni « permission », ni « session », ni le nom d'un outil.

/** Outil en cause, déduit de la clé citée par opencode ; « autre » : clé inconnue (outil d'extension, par exemple). */
export type OutilBloquant = "web" | "fichiers" | "autre";

export const TEXTES = {
  simple: {},
  avance: {},
  partout: {
    /** 503 d'un « once » (proxy, garde du « task once », carte des délégations) : rien n'est relayé. */
    bloquee: {
      web: "Une demande web en attente empêche opencode de lister ses demandes : refusez-la, puis réessayez. Rien n'a été envoyé.",
      fichiers:
        "Une demande de recherche dans les fichiers en attente empêche opencode de lister ses demandes : refusez-la, puis réessayez. Rien n'a été envoyé.",
      autre: "Une demande en attente empêche opencode de lister ses demandes : refusez-la, puis réessayez. Rien n'a été envoyé.",
    },
    /** 503 de la liste des demandes (GET /api/oc/permission) : la liste n'est pas servie, rien n'est deviné. */
    listeIllisible: {
      web: "opencode ne peut pas lister ses demandes d'autorisation : une demande web en attente l'en empêche. Refusez-la, puis rechargez.",
      fichiers:
        "opencode ne peut pas lister ses demandes d'autorisation : une demande de recherche dans les fichiers en attente l'en empêche. Refusez-la, puis rechargez.",
      autre: "opencode ne peut pas lister ses demandes d'autorisation : une demande en attente l'en empêche. Refusez-la, puis rechargez.",
    },
    /**
     * 503 d'une suppression de conversation (DELETE /session/:id) quand ses demandes en attente n'ont pas pu être lues pour être
     * refusées d'abord : rien n'est supprimé (la variante « bloquée » reprend `bloquee`).
     */
    suppressionImpossible:
      "opencode ne répond pas : impossible de refuser d'abord les demandes d'autorisation de cette conversation. Rien n'a été supprimé, réessayez dans un instant.",
    /** Avertissement non bloquant de la page de chat quand la liste des demandes n'a pas pu être lue (spécification D11 §6.4). */
    avertissement: {
      web: "Liste des demandes d'autorisation illisible : rechargez dans un instant ; si cela dure, refusez la demande web en attente.",
      fichiers:
        "Liste des demandes d'autorisation illisible : rechargez dans un instant ; si cela dure, refusez la demande de recherche dans les fichiers en attente.",
      autre: "Liste des demandes d'autorisation illisible : rechargez dans un instant ; si cela dure, refusez la demande en attente.",
      inconnue: "Liste des demandes d'autorisation illisible : rechargez dans un instant.",
    },
  },
};

const CLES_FICHIERS = new Set(["path", "include"]);
const CLES_WEB = new Set(["timeout", "numResults", "livecrawl", "type", "contextMaxCharacters"]);

/** Outil en cause d'après la clé citée par opencode (« …["metadata"]["<clé>"] »). */
export function outilDeCle(cle: string): OutilBloquant {
  if (CLES_WEB.has(cle)) return "web";
  if (CLES_FICHIERS.has(cle)) return "fichiers";
  return "autre";
}

/** Valeur d'outil reçue du serveur (corps d'un 503) ; toute autre valeur : null. */
export function outilLu(valeur: unknown): OutilBloquant | null {
  return valeur === "web" || valeur === "fichiers" || valeur === "autre" ? valeur : null;
}

/** Phrase du 503 d'un « once » quand la liste est bloquée. */
export function phraseListeBloquee(outil: OutilBloquant): string {
  return TEXTES.partout.bloquee[outil];
}

/** Phrase du 503 de la liste des demandes. */
export function phraseListeIllisible(outil: OutilBloquant): string {
  return TEXTES.partout.listeIllisible[outil];
}

/** Phrase du 503 d'une suppression quand les demandes de la conversation n'ont pas pu être lues (opencode ne répond pas). */
export function phraseSuppressionImpossible(): string {
  return TEXTES.partout.suppressionImpossible;
}

/** Avertissement de la page de chat ; null : cause inconnue (réseau, autre erreur). */
export function avertissementListe(outil: OutilBloquant | null): string {
  return outil === null ? TEXTES.partout.avertissement.inconnue : TEXTES.partout.avertissement[outil];
}

/**
 * Avertissement de la page de chat d'après l'erreur de lecture de la liste (ApiError du client : `status`, `code`, `data.outil`) :
 * l'outil n'est nommé que pour le 503 « liste-bloquee » du proxy ; toute autre erreur donne la phrase sans cause.
 */
export function avertissementDeLecture(erreur: unknown): string {
  const e = typeof erreur === "object" && erreur !== null ? (erreur as Record<string, unknown>) : {};
  const data = typeof e.data === "object" && e.data !== null ? (e.data as Record<string, unknown>) : {};
  return avertissementListe(e.status === 503 && e.code === "liste-bloquee" ? outilLu(data.outil) : null);
}
