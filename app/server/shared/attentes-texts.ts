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
//   sans elle (isOrphanOfWorkingSession rend false quand la liste est illisible). Pré-publication 1.1.0 (reste D11) : la demande en
//   cause reste AFFICHÉE après un rechargement tant que la table des attentes la connaît (le 503 de la liste la porte : demandesDeLecture,
//   croisements-v106 « reconnexion du flux avec une demande en cause ») ;
// - « Si elle n'est pas affichée, arrêtez les réponses en cours, puis Diagnostic › Redémarrer opencode » : après un redémarrage du
//   cockpit, ou pour une demande arrivée pendant une coupure du flux (événement perdu), la table ne connaît pas la demande (aucun
//   événement rejoué) et la liste d'opencode reste en 400 tant qu'elle attend ; un
//   redémarrage d'opencode vide ses demandes en attente (en mémoire), et « Redémarrer opencode » est refusé pendant une réponse,
//   d'où l'arrêt d'abord (« Arrêter » arrête la réponse même quand la liste est illisible, sans refuser la demande) ;
// - « rechargez dans un instant » (cause inconnue seulement) : la table redevient fiable à la première lecture RÉUSSIE après une
//   reconnexion du flux, ou à une libération de l'instance (pending-table.test.ts). Tant qu'une demande en cause attend, aucune
//   lecture ne réussit : c'est pourquoi les phrases qui nomment l'outil ne disent jamais « rechargez dans un instant ».
// Mode Simple : ni « permission », ni « session », ni le nom d'un outil.

/** Outil en cause, déduit de la clé citée par opencode ; « autre » : clé inconnue (outil d'extension, par exemple). */
export type OutilBloquant = "web" | "fichiers" | "autre";

export const TEXTES = {
  simple: {},
  avance: {},
  partout: {
    /** 503 d'un « once » (proxy, garde du « task once », carte des délégations) : rien n'est relayé. */
    bloquee: {
      web: "Une demande web en attente empêche opencode de lister ses demandes : refusez-la, puis réessayez. Si elle n'est pas affichée, arrêtez les réponses en cours, puis Diagnostic › Redémarrer opencode. Rien n'a été envoyé.",
      fichiers:
        "Une demande de recherche dans les fichiers en attente empêche opencode de lister ses demandes : refusez-la, puis réessayez. Si elle n'est pas affichée, arrêtez les réponses en cours, puis Diagnostic › Redémarrer opencode. Rien n'a été envoyé.",
      autre:
        "Une demande en attente empêche opencode de lister ses demandes : refusez-la, puis réessayez. Si elle n'est pas affichée, arrêtez les réponses en cours, puis Diagnostic › Redémarrer opencode. Rien n'a été envoyé.",
    },
    /** 503 de la liste des demandes (GET /api/oc/permission) : la liste n'est pas servie, rien n'est deviné. */
    listeIllisible: {
      web: "opencode ne peut pas lister ses demandes d'autorisation : une demande web en attente l'en empêche. Refusez-la, puis rechargez. Si elle n'est pas affichée, arrêtez les réponses en cours, puis Diagnostic › Redémarrer opencode.",
      fichiers:
        "opencode ne peut pas lister ses demandes d'autorisation : une demande de recherche dans les fichiers en attente l'en empêche. Refusez-la, puis rechargez. Si elle n'est pas affichée, arrêtez les réponses en cours, puis Diagnostic › Redémarrer opencode.",
      autre:
        "opencode ne peut pas lister ses demandes d'autorisation : une demande en attente l'en empêche. Refusez-la, puis rechargez. Si elle n'est pas affichée, arrêtez les réponses en cours, puis Diagnostic › Redémarrer opencode.",
    },
    /**
     * 503 d'une suppression de conversation (DELETE /session/:id) quand ses demandes en attente n'ont pas pu être lues pour être
     * refusées d'abord : rien n'est supprimé (la variante « bloquée » reprend `bloquee`).
     */
    suppressionImpossible:
      "opencode ne répond pas : impossible de refuser d'abord les demandes d'autorisation de cette conversation. Rien n'a été supprimé, réessayez dans un instant.",
    /** Avertissement non bloquant de la page de chat quand la liste des demandes n'a pas pu être lue (spécification D11 §6.4). */
    avertissement: {
      web: "Liste des demandes d'autorisation illisible : une demande web en attente l'en empêche. Refusez-la si elle est affichée ; sinon, arrêtez les réponses en cours, puis Diagnostic › Redémarrer opencode.",
      fichiers:
        "Liste des demandes d'autorisation illisible : une demande de recherche dans les fichiers en attente l'en empêche. Refusez-la si elle est affichée ; sinon, arrêtez les réponses en cours, puis Diagnostic › Redémarrer opencode.",
      autre:
        "Liste des demandes d'autorisation illisible : une demande en attente l'en empêche. Refusez-la si elle est affichée ; sinon, arrêtez les réponses en cours, puis Diagnostic › Redémarrer opencode.",
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

/** Demande en cause servie avec le 503 « liste-bloquee » (format d'opencode, PermissionRequest), relue et bornée par la page. */
export interface DemandeEnCauseLue {
  id: string;
  sessionID: string;
  permission: string;
  patterns: string[];
  metadata: Record<string, unknown>;
  always: string[];
  tool?: { messageID: string; callID: string };
}

/** Demandes en cause lues au plus (le serveur en sert au plus EN_CAUSE_MAX, pending-table.ts). */
const EN_CAUSE_LUES_MAX = 20;
const ID_LU = /^[A-Za-z0-9_-]{1,128}$/;
const PERMISSION_LUE = /^[a-z_]{1,32}$/;

const estObjet = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const textes = (v: unknown): string[] | null => (Array.isArray(v) && v.every((x): x is string => typeof x === "string") ? [...v] : null);

/**
 * Demandes en cause que le 503 « liste-bloquee » de la liste porte (pré-publication 1.1.0, reste D11) : la page les garde affichées
 * pour que vous puissiez les REFUSER après un rechargement. Toute autre erreur, ou une entrée mal formée : ignorée (jamais inventée).
 * « Autoriser une fois » sur elles reste refusé par le serveur (503) tant que la liste est bloquée.
 */
export function demandesDeLecture(erreur: unknown): DemandeEnCauseLue[] {
  const e: Record<string, unknown> = estObjet(erreur) ? erreur : {};
  if (e.status !== 503 || e.code !== "liste-bloquee" || !estObjet(e.data) || !Array.isArray(e.data.demandes)) return [];
  const lues: DemandeEnCauseLue[] = [];
  for (const brut of e.data.demandes.slice(0, EN_CAUSE_LUES_MAX)) {
    if (!estObjet(brut)) continue;
    const { id, sessionID, permission, metadata, tool } = brut;
    const patterns = textes(brut.patterns ?? []);
    const always = textes(brut.always ?? []);
    if (typeof id !== "string" || !ID_LU.test(id) || typeof sessionID !== "string" || !ID_LU.test(sessionID)) continue;
    if (typeof permission !== "string" || !PERMISSION_LUE.test(permission) || patterns === null || always === null) continue;
    const demande: DemandeEnCauseLue = { id, sessionID, permission, patterns, metadata: estObjet(metadata) ? { ...metadata } : {}, always };
    if (estObjet(tool) && typeof tool.messageID === "string" && ID_LU.test(tool.messageID) && typeof tool.callID === "string" && tool.callID !== "") {
      demande.tool = { messageID: tool.messageID, callID: tool.callID };
    }
    lues.push(demande);
  }
  return lues;
}
