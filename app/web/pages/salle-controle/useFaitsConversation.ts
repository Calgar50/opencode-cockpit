// Propriétaire : L31c.
// Faits d'une conversation et parties pures des zooms 2 et 3 de la salle de contrôle (spécification §5.8 l.992-1009, §5.7.4 ;
// plan d'exécution it3, fiche L31c, D-3d-11, D-3d-12, D-3d-17, D-3d-18, M20). Tout ce qui est décidé sans React vit ici, pour
// être joué sous Node (server/zoom-conversation.test.ts) : la cadence d'affichage, le mode de la scène, l'accès au direct, les
// textes du panneau, la cible de « Suivre l'action » et le dossier d'un projet.
//
// Cadence (§5.7.4, D-3d-17) : la file de server/shared/neon-band.ts (fileNeuve, recevoir, avancer), donc AU PLUS 4 recalculs par
// seconde, exactement comme la bande 2D. Différence assumée avec la bande : la salle de contrôle n'écrit JAMAIS
// « Affichage rattrapé » et n'enregistre aucun fait `affichage` (fiche L31c) — elle ne fait que ralentir son propre dessin, elle
// ne raconte rien de plus à l'utilisateur. `rattrape` de la file est donc lu et ignoré ; aucune requête n'en sort.
// Aucune animation, aucune boucle d'images : un seul minuteur ponctuel à la fois, replacé par le pas suivant (D-3d-22).
import { useEffect, useMemo, useRef, useState } from "react";
import type { ActivityFact } from "../../../server/shared/activity-types.ts";
import { avancer, fileNeuve, type NeonFile, recevoir } from "../../../server/shared/neon-band.ts";
import type { NeonDetail, NeonMode, NeonSceneOptions } from "../../../server/shared/neon-scene.ts";
import type { Plan3d, Plan3dZoom, Point3 } from "../../../server/shared/salle3d-types.ts";
import { activityApi } from "../../lib/api-activity.ts";
import { useEvents } from "../../lib/events.ts";

/** Nom de la marque de performance d'un plan recalculé (D-3d-18, M20) ; émise en 3D ET en repli 2D. */
export const MARQUE_PLAN = "salle3d:plan";

/** Rendu qui a servi le plan : la scène three, ou la carte 2D de la bande. */
export type RenduPlan = "3d" | "2d";

/**
 * Marque « salle3d:plan » d'un plan recalculé (compteur de l'e2e de L35, D-3d-18). Comme `marquerBascule` (fluidite.ts) : une
 * marque refusée (API absente, mesures coupées) n'empêche jamais l'affichage.
 */
export function marquerPlan(zoom: Plan3dZoom, rendu: RenduPlan): void {
  try {
    performance.mark(MARQUE_PLAN, { detail: { zoom, rendu } });
  } catch {
    // Mesure seulement : sans marque, la vue reste la même.
  }
}

// --- Cadence d'affichage (pure, jouée sous Node) --------------------------------------------------------------------------------

/** Dépendances de la cadence ; celles du navigateur par défaut, remplacées dans les tests. */
export interface DependancesCadence {
  maintenant(): number;
  minuteur(rappel: () => void, ms: number): number;
  annuler(identifiant: number): void;
}

export interface Cadence {
  /** Nombre de faits que la vue doit montrer maintenant. */
  affiches(): number;
  /** Liste rallongée (fait reçu en direct) ou remplacée (relecture) : la file décide quand la vue la suit. */
  recevoir(total: number): void;
  /** Liste lue d'un coup (ouverture, autre conversation) : affichée telle quelle, sans attente. */
  ouvrir(total: number): void;
  /** Minuteur en cours annulé (démontage). */
  arreter(): void;
}

const DEPENDANCES_NAVIGATEUR: DependancesCadence = {
  maintenant: () => Date.now(),
  minuteur: (rappel, ms) => globalThis.setTimeout(rappel, ms) as unknown as number,
  annuler: (identifiant) => {
    globalThis.clearTimeout(identifiant);
  },
};

/**
 * Cadence d'affichage des faits : au plus 4 recalculs par seconde (NEON_RENDU_MS de neon-band.ts). `surChangement` est appelé
 * seulement quand le nombre de faits montrés change — c'est-à-dire à chaque recalcul de la scène et du plan.
 */
export function creerCadence(surChangement: (affiches: number) => void, deps: DependancesCadence = DEPENDANCES_NAVIGATEUR): Cadence {
  let file: NeonFile = fileNeuve(0);
  let minuteur: number | null = null;

  const arreter = () => {
    if (minuteur === null) return;
    deps.annuler(minuteur);
    minuteur = null;
  };

  // Un pas de la file ; replanifié seulement si un changement attend encore (aucune boucle d'images, D-3d-22).
  const pas = () => {
    minuteur = null;
    const maintenant = deps.maintenant();
    const avant = file;
    // `rattrape` est volontairement ignoré : la salle de contrôle n'écrit jamais « Affichage rattrapé » (fiche L31c).
    const { file: apres, prochain } = avancer(avant, maintenant);
    file = apres;
    if (apres.affiches !== avant.affiches) surChangement(apres.affiches);
    if (prochain !== null && apres.attente.length > 0) minuteur = deps.minuteur(pas, Math.max(0, prochain - maintenant));
  };

  return {
    affiches: () => file.affiches,
    recevoir: (total) => {
      const avant = file;
      const apres = recevoir(avant, total, deps.maintenant());
      file = apres;
      // Liste raccourcie ou remplacée à longueur égale, sans rien en attente : montrée telle quelle.
      const remplacee = apres === avant && !apres.fige && apres.attente.length === 0;
      if (apres.affiches !== avant.affiches || remplacee) surChangement(apres.affiches);
      arreter();
      pas();
    },
    ouvrir: (total) => {
      arreter();
      file = fileNeuve(total);
      surChangement(file.affiches);
    },
    arreter,
  };
}

// --- Décisions pures des zooms 2 et 3 --------------------------------------------------------------------------------------------

export interface ContexteZoom {
  /** Racine de la Salle OMO (JP-10). */
  salle: boolean;
  /** Mode de l'utilisateur. */
  mode: NeonMode;
}

/**
 * Le direct est-il servi ? Une racine de la Salle OMO en mode Simple n'a PAS de vue en direct : la salle est réservée au mode
 * Avancé (D-3d-14, §5.9 l.1018-1024), et la seule chose offerte est « Revoir » d'une demande terminée, en lecture seule. Partout
 * ailleurs, la vue en direct est servie.
 */
export function directServi({ salle, mode }: ContexteZoom): boolean {
  return !(salle && mode === "simple");
}

/**
 * Options de `scene()` des zooms 2 et 3 (D-3d-12, D-3d-20). Une racine de la salle est calculée en « avance » pour que toutes
 * les délégations soient dessinées (décision n° 7) ; une racine ordinaire garde le MODE DE L'UTILISATEUR — en mode Simple, la
 * carte ne dessine donc qu'un seul assistant, comme la bande 2D (P3 : jamais une délégation montrée à qui n'en a pas).
 */
export function optionsScene(contexte: ContexteZoom, sessionId: string | null): NeonSceneOptions {
  return {
    zoom: sessionId === null ? 2 : 3,
    mode: contexte.salle ? "avance" : contexte.mode,
    focus: sessionId,
  };
}

/** Zoom servi par le composant : 2 (conversation) ou 3 (un assistant). */
export function zoomDe(sessionId: string | null): Plan3dZoom {
  return sessionId === null ? 2 : 3;
}

/** D'où le panneau du zoom 3 tire ses textes (D-3d-12, U2). */
export interface TextesPanneau {
  /** Messages à relire dans la conversation, dans l'ordre (consigne, réponse) ; TOUJOURS vide en différé. */
  aRelire: string[];
  /** Les textes de message sont remplacés par « Texte non affiché pendant « Revoir » » (différé). */
  nonAffiche: boolean;
  /** [Voir la consigne] lit la copie gardée par le cockpit (ConsigneRevoir, U2) au lieu de relire la conversation. */
  consigneGardee: boolean;
}

/**
 * Textes du panneau « Consigne reçue · Ce qu'il a fait · Résultat rendu » (§5.7.4, D-3d-12, U2) :
 * - EN DIRECT, ils sont relus dans la conversation, exactement comme la bande 2D, et rendus en texte ;
 * - EN DIFFÉRÉ, AUCUN texte de message n'est relu (`aRelire` vide) : chacun devient « Texte non affiché pendant « Revoir » »,
 *   SAUF la consigne reçue, lue dans la copie gardée localement par le cockpit, sans aucune requête à opencode (U2, D-3d-30).
 */
export function textesPanneau(direct: boolean, panneau: NeonDetail["panneau"]): TextesPanneau {
  if (!direct) return { aRelire: [], nonAffiche: true, consigneGardee: true };
  const aRelire = [panneau.consigne?.messageId, panneau.reponse?.messageId].filter((id): id is string => typeof id === "string" && id !== "");
  return { aRelire, nonAffiche: false, consigneGardee: false };
}

/**
 * Point du plan 3D vers lequel « Suivre l'action » déplace la caméra : l'identifiant rendu par `cibleASuivre` (revoir.ts) est
 * celui d'un nœud (sessionId), d'un faisceau ou d'une attente. Un faisceau ouvert (cible encore inconnue) est suivi à son départ.
 * null : rien de connu à suivre, la caméra ne bouge pas (jamais une position inventée, P12).
 */
export function cibleSuivre(plan: Plan3d, id: string | null): Point3 | null {
  if (id === null) return null;
  const noeud = plan.noeuds.find((candidat) => candidat.id === id);
  if (noeud !== undefined) return noeud.position;
  const faisceau = plan.faisceaux.find((candidat) => candidat.id === id);
  if (faisceau !== undefined) return faisceau.vers ?? faisceau.de;
  const marque = plan.marques.find((candidat) => candidat.id === `attente:${id}` || candidat.id === id);
  return marque?.position ?? null;
}

/**
 * Dossier d'un projet du zoom 1 : l'inverse de `projetRelatif` (server/territoires-service.ts), qui rend un chemin relatif à la
 * racine du workspace vue par opencode, la chaîne vide pour la racine elle-même et le chemin entier en repli. Sert à relire les
 * textes des messages dans le bon projet (oc.messages), en direct seulement.
 */
export function dossierDuProjet(racine: string, projet: string): string {
  if (projet === "") return racine;
  if (projet.startsWith("/") || /^[A-Za-z]:[\\/]/.test(projet)) return projet;
  const separateur = racine.startsWith("/") ? "/" : "\\";
  const base = racine.endsWith(separateur) ? racine.slice(0, -separateur.length) : racine;
  return `${base}${separateur}${projet}`;
}

// --- Crochet React ---------------------------------------------------------------------------------------------------------------

/**
 * Préfixe montré d'une liste reçue : les `affiches` premiers faits, ou la liste entière quand la cadence l'a rattrapée. Pur, pour
 * être joué sous Node avec la cadence (M20, train de la vague 3).
 */
export function prefixeMontre(liste: readonly ActivityFact[], affiches: number): readonly ActivityFact[] {
  return affiches >= liste.length ? liste : liste.slice(0, Math.max(0, affiches));
}

export interface FaitsConversation {
  /** Faits montrés maintenant : préfixe cadencé de la liste reçue. */
  faits: readonly ActivityFact[];
  /** Borne du magasin atteinte : « Déroulé partiel ». */
  partiel: boolean;
  /** Première lecture pas encore arrivée. */
  chargement: boolean;
  /** Lecture refusée ou impossible : la vue le dit, sans inventer de cause. */
  echec: boolean;
}

/** Fait du flux qui appartient à cette conversation (mêmes gardes que useActivity : rien d'un autre arbre). */
function faitDeLaRacine(donnee: unknown, rootId: string): ActivityFact | null {
  if (donnee === null || typeof donnee !== "object") return null;
  const fait = donnee as ActivityFact;
  return typeof fait.rootId === "string" && fait.rootId === rootId && typeof fait.sessionId === "string" && typeof fait.kind === "string" ? fait : null;
}

/**
 * Faits d'une conversation pour les zooms 2 et 3 : `activityApi.facts` à l'ouverture, puis les faits `activite.fait` du flux,
 * filtrés sur la racine. L'affichage suit la cadence de la bande (au plus 4 recalculs par seconde), sans jamais écrire
 * « Affichage rattrapé » ni enregistrer de fait `affichage`.
 */
export function useFaitsConversation(rootId: string, actif = true): FaitsConversation {
  const [faits, setFaits] = useState<readonly ActivityFact[]>([]);
  const [partiel, setPartiel] = useState(false);
  const [chargement, setChargement] = useState(true);
  const [echec, setEchec] = useState(false);
  const listeRef = useRef<readonly ActivityFact[]>([]);

  // Une cadence par montage ; son minuteur est annulé au démontage. Elle est le SEUL chemin qui publie les faits montrés (M20,
  // train de la vague 3) : un fait reçu ne fait que rallonger la liste gardée dans la référence, et seule la cadence — au plus
  // quatre fois par seconde — rend un nouveau tableau. Publier la liste à chaque fait rendait un tableau NEUF par événement, donc
  // une scène, un plan et une marque « salle3d:plan » par fait reçu, quelle que soit la cadence.
  const cadence = useMemo(() => creerCadence((montres) => setFaits(prefixeMontre(listeRef.current, montres))), []);
  useEffect(() => cadence.arreter, [cadence]);

  // Première lecture : les faits persistés de la conversation, affichés d'un coup.
  useEffect(() => {
    if (!actif) return;
    const abandon = new AbortController();
    setChargement(true);
    setEchec(false);
    listeRef.current = [];
    cadence.ouvrir(0);
    activityApi.facts(rootId, 0, abandon.signal).then(
      (reponse) => {
        if (abandon.signal.aborted) return;
        listeRef.current = reponse.facts;
        setPartiel(reponse.partial);
        setChargement(false);
        cadence.ouvrir(reponse.facts.length);
      },
      (erreur: unknown) => {
        if (abandon.signal.aborted) return;
        // Lecture impossible (403 d'une racine fermée, réseau) : la vue le dit, rien n'est supposé.
        console.warn("salle de contrôle : faits de la conversation illisibles", erreur);
        setChargement(false);
        setEchec(true);
      },
    );
    return () => abandon.abort();
  }, [rootId, actif, cadence]);

  // Direct : un fait à la fois, rangé dans la file qui décide du prochain recalcul.
  useEvents((event) => {
    if (!actif || event.kind !== "cockpit" || event.type !== "activite.fait") return;
    const fait = faitDeLaRacine(event.data, rootId);
    if (fait === null) return;
    const suivante = [...listeRef.current, fait];
    listeRef.current = suivante;
    // Aucune publication ici : c'est la cadence qui décide quand la vue suit (M20).
    cadence.recevoir(suivante.length);
  });

  return { faits, partiel, chargement, echec };
}

/** Dernière valeur vue au rendu précédent (scène d'avant, pour « Suivre l'action »). */
export function usePrecedent<T>(valeur: T): T | null {
  const garde = useRef<T | null>(null);
  const precedente = garde.current;
  useEffect(() => {
    garde.current = valeur;
  }, [valeur]);
  return precedente;
}

/** Marque « salle3d:plan » à chaque recalcul, en 3D comme en 2D (M20, D-3d-18). */
export function useMarquePlan(vue: unknown, zoom: Plan3dZoom, rendu: RenduPlan): void {
  const derniere = useRef<{ vue: unknown; rendu: RenduPlan; zoom: Plan3dZoom } | null>(null);
  useEffect(() => {
    const avant = derniere.current;
    if (avant !== null && avant.vue === vue && avant.rendu === rendu && avant.zoom === zoom) return;
    derniere.current = { vue, rendu, zoom };
    marquerPlan(zoom, rendu);
  }, [vue, zoom, rendu]);
}
