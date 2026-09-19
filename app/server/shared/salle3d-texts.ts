// Textes de la salle de contrôle 3D (spécification §2.1, §2.2, §2.3, §5.8, §6 ; plan d'exécution de l'itération 3, §4.2.1,
// paquet T3d-b) : titre, fil d'Ariane, station « Cockpit – contrôle », compteurs du zoom 1, enceinte de la Salle OMO, phrases
// de la fluidité et du repli en 2D. Convention TEXTES de T0, contrôlée par textes.test.ts ; « un sens par mot » (mode, pause,
// relecture), mots interdits en mode Simple et vocabulaire propre à la 3D contrôlés par textes-3d.test.ts.
// « Vous » et « GitHub Copilot » restent dans neon-texts.ts (stations de la scène néon, lues sans être recopiées).
// La Salle OMO et l'extension ne sont décrites qu'en mode Avancé ; en mode Simple, l'enceinte dit seulement qu'elle est réservée
// au mode Avancé et ne liste que des conversations terminées, à revoir (D-3d-14).
// Module pur (server/shared) : aucune horloge, aucun module node.
import { remplir } from "./neon-texts.ts";
import type { FluidityReason } from "./salle3d-types.ts";

// Types partagés de la vague 0 (D-3d-27) : référence salle3d-types.ts (T3d-a), réexportés depuis le train de V0.
export type { FluidityReason, FluidityVerdict } from "./salle3d-types.ts";

export const TEXTES = {
  simple: {
    /** Enceinte de la Salle OMO au zoom 1 : ni compteur ni état en direct en mode Simple (D-3d-14). */
    enceinte: "Salle OMO, réservée au mode Avancé",
    /** Seules les conversations terminées de la salle y sont listées, avec [Revoir cette demande] (D-3d-14, §5.9). */
    enceinteRevoir: "Conversations terminées à revoir",
  },
  avance: {
    /** §5.7.4 l.987 et JP-10 : bandeau permanent de l'enceinte (le montant du plafond reste dans la bande de la salle). */
    enceinte: "Salle OMO · extension active · actions non contrôlées avant exécution",
  },
  partout: {
    /** §2.1 l.79 : la vue 3D plein écran. */
    titre: "Salle de contrôle",
    /** §5.7.4 l.985 : commande de la bande. */
    ouvrir: "Ouvrir la salle de contrôle",
    /** D-3d-15 : « Projets › {projet} › {assistant} ». */
    filAriane: {
      aria: "Fil d'Ariane",
      projets: "Projets",
    },
    /** §5.8 l.993 : station fixe à gauche. */
    stationControle: "Cockpit – contrôle",
    /** §5.8 l.993 : « 3 travaillent · 1 attend votre accord · 0,42 $ » (D-3d-13, libelleCompteurs). */
    compteurs: {
      travailleUn: "{n} travaille",
      travaillent: "{n} travaillent",
      attendUn: "{n} attend votre accord",
      attendent: "{n} attendent votre accord",
      cout: "{x} $",
      coutAide: "Coût des demandes en cours dans ce projet",
      /** Statut illisible ou refusé par opencode : jamais 0 (D-3d-13). */
      nonVerifiable: "état non vérifiable",
      separateur: "·",
    },
    /** §5.8 l.993 : infobulle du zoom 1. */
    aucunFaisceau: "Aucun faisceau entre projets : une conversation ne confie jamais de travail à une conversation d'un autre projet.",
    vide: "Aucune conversation récente dans vos projets.",
    /** D-3d-15 : sélecteur du zoom 2. */
    conversationsDuProjet: "Conversations de ce projet",
    liste: "Liste",
    tableau: "Tableau",
    /**
     * §5.8 l.1003-1008 et §6 l.1068 : phrase de chaque raison de l'affichage en 2D (messageFluidite), proposition et commandes de
     * la bascule.
     */
    fluidite: {
      accessibilite: "Affichage 2D : vos réglages d'accessibilité le demandent",
      /** §5.8 l.1007 : dite après une sonde lente (étape 3) et après la bascule automatique de la surveillance (étape 4). */
      sondeLente: "La 3D n'était pas fluide sur ce poste",
      reessayer: "Réessayer",
      renduLogiciel: "Affichage 2D : ce poste dessine la 3D sans carte graphique (bureau à distance ou machine virtuelle)",
      webglAbsent: "Affichage 2D : la 3D n'est pas disponible dans ce navigateur",
      /**
       * Proposition à 5 s, la vue encore en 3D (avec passer2d, rester3d et basculeProche) : lue telle quelle par la page tant que
       * la proposition tient. Après la bascule automatique, messageFluidite("saccades") rend sondeLente (§5.8 l.1007).
       */
      saccades: "La 3D saccade sur ce poste.",
      passer2d: "Passer en 2D",
      rester3d: "Rester en 3D",
      basculeProche: "Passage en 2D dans quelques secondes.",
      preference2d: "Affichage 2D : vous l'avez choisi sur ce poste",
      /** Raison inconnue à l'exécution (préférence du poste relue, par exemple) : la 2D est dite, jamais une cause inventée. */
      autre: "Affichage 2D sur ce poste",
    },
    /** D-3d-28 : perte du contexte non demandée. */
    contexte: {
      perdu: "L'affichage 3D s'est interrompu : retour en 2D.",
    },
  },
};

export interface CompteursTerritoire {
  /** null : statut des conversations non vérifiable (D-3d-13). */
  travaillent: number | null;
  attendent: number;
  /** Dollars des demandes en cours. */
  cout: number;
}

/** Nombre entier affiché : négatif ou illisible → 0 (un compteur ne descend jamais sous zéro). */
function entier(n: number): number {
  return Number.isFinite(n) && n > 0 ? Math.trunc(n) : 0;
}

/**
 * Compteurs d'un territoire : « 3 travaillent · 1 attend votre accord · 0,42 $ » (§5.8 l.993). Singulier pour 0 et 1 ;
 * « état non vérifiable » si `travaillent` est null. `formatUsd` (web/lib/format.ts) rend le montant avec son symbole ; sans lui,
 * deux décimales et une virgule.
 */
export function libelleCompteurs(compteurs: CompteursTerritoire, formatUsd?: (usd: number) => string): string {
  const t = TEXTES.partout.compteurs;
  const attendent = entier(compteurs.attendent);
  const travail =
    compteurs.travaillent === null
      ? t.nonVerifiable
      : remplir(entier(compteurs.travaillent) > 1 ? t.travaillent : t.travailleUn, { n: entier(compteurs.travaillent) });
  const attente = remplir(attendent > 1 ? t.attendent : t.attendUn, { n: attendent });
  const cout = Number.isFinite(compteurs.cout) ? compteurs.cout : 0;
  const montant = formatUsd ? formatUsd(cout) : remplir(t.cout, { x: (Math.round(cout * 100) / 100).toFixed(2).replace(".", ",") });
  return [travail, attente, montant].join(` ${t.separateur} `);
}

/**
 * Phrase de chaque raison de l'affichage en 2D (le crochet de fluidité rend des raisons, jamais des textes : D-3d-27).
 * « saccades » n'est posée qu'après la bascule automatique à 10 s : la vue est déjà en 2D, la phrase est celle de §5.8 l.1007,
 * au passé, et non la proposition au présent (« La 3D saccade sur ce poste. »), montrée seulement pendant la 3D.
 */
const PHRASE_FLUIDITE: Readonly<Record<FluidityReason, keyof typeof TEXTES.partout.fluidite>> = {
  accessibilite: "accessibilite",
  "webgl-absent": "webglAbsent",
  "rendu-logiciel": "renduLogiciel",
  "sonde-lente": "sondeLente",
  saccades: "sondeLente",
  "preference-2d": "preference2d",
};

/** Phrase de l'affichage en 2D, une par raison ; une raison inconnue (valeur relue hors du type) garde une phrase neutre. */
export function messageFluidite(raison: FluidityReason): string {
  const f = TEXTES.partout.fluidite;
  return Object.hasOwn(PHRASE_FLUIDITE, raison) ? f[PHRASE_FLUIDITE[raison]] : f.autre;
}
