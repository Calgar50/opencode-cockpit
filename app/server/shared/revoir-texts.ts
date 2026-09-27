// Textes de « Revoir » (lecteur en différé), des consignes gardées et des démonstrations enregistrées (spécification §2.1, §2.2,
// §5.8 l.998, §5.9 l.1013-1024, §6 l.1065 ; plan d'exécution de l'itération 3, §4.2.2, D-3d-11, D-3d-12, D-3d-26, D-3d-30 ;
// décisions U1 et U2 du 19/09 ; paquet T3d-b). Convention TEXTES de T0, contrôlée par textes.test.ts ; « un sens par mot »,
// mots interdits en mode Simple et vocabulaire de la 3D contrôlés par textes-3d.test.ts.
// Vocabulaire (§2.2 l.97, D-3d-11) : « Revoir » (action) et « En différé » (état), jamais « relecture » ; « Lire » et « Figer ici »,
// jamais « pause » (réservé aux équipes) ni « Arrêter » (réservé à l'arrêt de la conversation).
// Honnêteté (U2, D-3d-12) : seule la consigne reçue est montrée, depuis la copie gardée par le cockpit ; tout autre texte de
// message reste « Texte non affiché pendant « Revoir » ». U1 : en mode Simple, aucune phrase ne propose une équipe.
// Module pur (server/shared) : aucune horloge ; l'heure affichée est calculée avec le décalage fourni par l'appelant.
import { remplir } from "./neon-texts.ts";
import type { ReplayBadge, ReplaySpeed, RevoirRefus } from "./salle3d-types.ts";

// Types partagés de la vague 0 (D-3d-27) : référence salle3d-types.ts (T3d-a), réexportés depuis le train de V0.
export type { ReplayBadge, ReplaySpeed, RevoirRefus } from "./salle3d-types.ts";

export const TEXTES = {
  simple: {
    /** §5.9 l.1023 : mention d'une conversation de la Salle OMO revue en mode Simple. */
    salle: "Cette conversation vient de la Salle OMO, réservée au mode Avancé",
    /** D-3d-20 : nom de l'assistant au centre, en mode Simple (jamais un nom de rôle de l'extension). */
    assistantPrincipal: "Assistant principal",
    /** U1 et D-3d-26 : démonstration qui dessine une délégation, montrée en mode Simple (P3 : rien de montré comme disponible). */
    demoAvance: "Démonstration enregistrée en mode Avancé : en mode Simple, l'IA ne délègue pas, elle continue seule.",
  },
  avance: {},
  partout: {
    /** §5.7.4 l.985 : commande de la bande, des Archives et du zoom 1. */
    revoir: "Revoir cette demande",
    revenirDirect: "Revenir au direct",
    /** §5.8 l.998 : badge « EN DIRECT » ou « EN DIFFÉRÉ ×0,5 · 10:42:07 » (libelleBadge). */
    badgeDirect: "EN DIRECT",
    badgeDiffere: "EN DIFFÉRÉ ×{vitesse} · {heure}",
    /** §5.8 l.998 : barre de moments « 4 / 12 ». */
    moments: "{n} / {total}",
    momentsAria: "Moment {n} sur {total}, {heure}",
    /** D-3d-11 : « Lire » et « Figer ici ». */
    lire: "Lire",
    figer: "Figer ici",
    precedent: "Moment précédent",
    suivant: "Moment suivant",
    vitesse: "Vitesse",
    /** D-3d-11 : une clé par vitesse du lecteur (formatVitesse). */
    vitesses: {
      "0.25": "×0,25",
      "0.5": "×0,5",
      "1": "×1",
      "2": "×2",
      "4": "×4",
    },
    /** D-3d-11 : écart de plus de 4 s montré en 1 s (libelleRaccourci). */
    raccourci: "{duree} sans nouvel événement, montrées en 1 s",
    /** Morceaux d'une durée (formatDuree) : « 2 min 10 s ». */
    duree: {
      heures: "{n} h",
      minutes: "{n} min",
      secondes: "{n} s",
    },
    /** §5.8 l.998 : translation de caméra, en différé seulement. */
    suivre: "Suivre l'action",
    demande: "Demande {n} sur {total} · {heure}",
    /** §5.9 l.1023 et §6 l.1065 : bandeau permanent de « Revoir ». */
    rienRelance: "Revoir : rien n'est relancé ni facturé",
    fermer: "Fermer",
    vide: "Rien à revoir pour cette conversation.",
    /** Faits partiels (borne des faits gardés) : le déroulé montré n'est pas complet. */
    partiel: "Déroulé partiel",
    /** D-3d-12 et U2 : tout texte de message sauf la consigne reçue. */
    texteNonAffiche: "Texte non affiché pendant « Revoir » : rien n'est redemandé ni relancé.",
    /** U2 et D-3d-30 : consigne gardée localement, lue sans requête à opencode. */
    consigne: {
      titre: "Consigne reçue",
      /** Session qui a reçu plusieurs consignes (étape d'équipe relue en deux tours, par exemple) : harmonisation du 19/09. */
      titrePlusieurs: "Consigne reçue ({n} / {total})",
      copie: "Copie gardée par le cockpit au moment de l'envoi, secrets reconnus masqués : rien n'est redemandé à l'IA.",
      tronquee: "Consigne tronquée : {affiches} caractères affichés sur {total}.",
      absente:
        "Consigne non enregistrée : le cockpit n'en a pas gardé de copie (demande antérieure à cette version, cockpit arrêté pendant l'envoi, ou plus de {n} consignes dans cette conversation).",
      chargement: "Chargement de la consigne…",
      fermer: "Fermer la consigne",
    },
    /** D-3d-09 : une phrase par refus de la route « Revoir » (libelleRefus). */
    refus: {
      "racine-inconnue": "Conversation introuvable.",
      "salle-demande-en-cours": "Cette demande n'est pas terminée : elle pourra être revue à sa fin.",
      "salle-fin-inconnue": "Impossible de vérifier que cette demande est terminée : elle ne peut pas être revue pour le moment.",
    },
    /** Code de refus inconnu à l'exécution (réponse d'un autre serveur) : aucune cause inventée. */
    refusInconnu: "Cette demande ne peut pas être revue pour le moment.",
    /** §5.9 l.1015 et D-3d-26 : démonstrations de l'itération 3. */
    demos: {
      choisir: "Choisir une démonstration",
      deuxEnMemeTemps: "Deux assistants en même temps",
      attenteAccord: "Attente de votre accord",
      arretPlafond: "Arrêt au plafond",
      salleReelle: "Séquence réelle de la Salle OMO (anonymisée)",
    },
  },
};

const JOUR_MS = 86_400_000;

/** Entier groupé par trois chiffres, séparés par une espace fine insécable (« 12 345 »), comme les nombres du web. */
function entier(n: number): string {
  const chiffres = String(Number.isFinite(n) && n > 0 ? Math.trunc(n) : 0);
  const groupes: string[] = [];
  for (let fin = chiffres.length; fin > 0; fin -= 3) groupes.unshift(chiffres.slice(Math.max(0, fin - 3), fin));
  return groupes.join(String.fromCodePoint(0x202f));
}

/** Vitesse du badge, sans le signe « × » : « 0,5 ». */
function nombreVitesse(v: number): string {
  return String(v).replace(".", ",");
}

/** « ×0,25 » à « ×4 » ; une valeur hors de la liste (relue hors du type) est écrite telle quelle. */
export function formatVitesse(v: ReplaySpeed): string {
  const vitesses: Readonly<Record<string, string>> = TEXTES.partout.vitesses;
  const cle = String(v);
  return Object.hasOwn(vitesses, cle) ? (vitesses[cle] ?? "") : `×${nombreVitesse(v)}`;
}

/**
 * Heure « hh:mm:ss » d'un instant (millisecondes depuis l'époque Unix), dans le fuseau de l'appelant : `decalageMinutes` est le
 * décalage à ajouter à l'heure UTC (Paris en été : 120 ; c'est l'opposé de getTimezoneOffset du navigateur). Module pur : aucune
 * horloge lue, aucun fuseau deviné. Instant illisible : « --:--:-- ».
 */
export function formatHeure(ms: number, decalageMinutes: number): string {
  if (!Number.isFinite(ms) || !Number.isFinite(decalageMinutes)) return "--:--:--";
  const local = ms + decalageMinutes * 60_000;
  const secondes = Math.floor((((local % JOUR_MS) + JOUR_MS) % JOUR_MS) / 1000);
  return [Math.floor(secondes / 3600), Math.floor(secondes / 60) % 60, secondes % 60].map((v) => String(v).padStart(2, "0")).join(":");
}

/** Durée arrondie à la seconde : « 45 s », « 2 min 10 s », « 1 h 5 min » ; les unités nulles sont omises, sauf « 0 s ». */
export function formatDuree(ms: number): string {
  const d = TEXTES.partout.duree;
  const total = Number.isFinite(ms) && ms > 0 ? Math.round(ms / 1000) : 0;
  const heures = Math.floor(total / 3600);
  const minutes = Math.floor(total / 60) % 60;
  const secondes = total % 60;
  const morceaux: string[] = [];
  if (heures > 0) morceaux.push(remplir(d.heures, { n: heures }));
  if (minutes > 0) morceaux.push(remplir(d.minutes, { n: minutes }));
  if (secondes > 0 || morceaux.length === 0) morceaux.push(remplir(d.secondes, { n: secondes }));
  return morceaux.join(" ");
}

/** Étiquette d'un écart raccourci (D-3d-11) : « 2 min 10 s sans nouvel événement, montrées en 1 s ». */
export function libelleRaccourci(ecartMs: number): string {
  return remplir(TEXTES.partout.raccourci, { duree: formatDuree(ecartMs) });
}

/** Badge du lecteur : « EN DIRECT » ou « EN DIFFÉRÉ ×0,5 · 10:42:07 » (§5.8 l.998). */
export function libelleBadge(badge: ReplayBadge, decalageMinutes: number): string {
  const p = TEXTES.partout;
  if (badge.etat !== "differe") return p.badgeDirect;
  return remplir(p.badgeDiffere, { vitesse: nombreVitesse(badge.vitesse), heure: formatHeure(badge.heure, decalageMinutes) });
}

/** Phrase d'un refus de « Revoir » ; un code inconnu garde une phrase neutre. */
export function libelleRefus(code: RevoirRefus): string {
  const refus: Readonly<Record<string, string>> = TEXTES.partout.refus;
  return Object.hasOwn(refus, code) ? (refus[code] ?? TEXTES.partout.refusInconnu) : TEXTES.partout.refusInconnu;
}

/** « Consigne tronquée : 8 000 caractères affichés sur 12 345. » (D-3d-30). */
export function libelleConsigneTronquee(affiches: number, total: number): string {
  return remplir(TEXTES.partout.consigne.tronquee, { affiches: entier(affiches), total: entier(total) });
}

/** « Consigne non enregistrée : … ou plus de 500 consignes dans cette conversation). » (D-3d-30 : borne passée par l'appelant). */
export function libelleConsigneAbsente(n: number): string {
  return remplir(TEXTES.partout.consigne.absente, { n: entier(n) });
}
