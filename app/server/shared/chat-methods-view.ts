// Propriétaire : L44e.
// Vue PURE de la conversation pour les méthodes d'un message et la Seconde lecture (itération 5, plan d'exécution it5 fiche
// L44e, D-5-08, D-5-20, D-5-22, §4.3 ; spécification §5.5, §6 l.1051 ; conception C §9.4, §9.7 ; recherche RM §5.3, §5.4).
//
// Quatre décisions, et rien d'autre : la puce du composeur (ce qui est proposé, ce qui est refusé et pourquoi), la visibilité du
// bouton « Seconde lecture », la présence de la méthode demandée dans la réponse, et la reconnaissance d'une demande de seconde
// lecture pour le pied de la réponse du Relecteur. Aucun accès au réseau, aucune horloge, aucun état : les composants
// (MethodChip, MethodBubble, MethodPresence, SecondReadingButton) n'y ajoutent que l'affichage.
//
// Deux règles tenues ici, pas ailleurs :
// - toutes les phrases viennent de `construction-texts.ts` (§4.3) : aucune n'est réécrite, aucune n'est composée à la main dans
//   un composant, et le libellé du bouton ne porte JAMAIS « au moins » (D-5-22) — l'entrée du Relecteur n'est pas celle de
//   l'assistant précédent, donc aucun minimum n'est garanti ;
// - « Méthode appliquée » ne dit que la PRÉSENCE de la section attendue (`methodDetected`), jamais la justesse du raisonnement
//   (spécification §6 l.1051) ; une méthode inconnue du catalogue n'a pas d'en-tête à chercher, donc rien n'est affirmé d'elle.
//
// Module pur (server/shared) : aucun module node, aucun accès à process (test de pureté de core.test.ts). Imports voisins
// seulement : construction-texts.ts (phrases), construction-types.ts (types) et methods.ts (blocs et détection).
import { TEXTES, secondReadingPrefix } from "./construction-texts.ts";
import type { MethodView, SecondReadingEstimate, SecondReadingTarget } from "./construction-types.ts";
import { METHOD_LIMITS, type Method, methodDetected, renderMessageMethodBlock } from "./methods.ts";

/** Objets relus qui ont un message : la variante « reponse » est celle du chat, « equipe » celle du résultat d'une équipe. */
const CIBLES = ["reponse", "equipe"] as const satisfies readonly SecondReadingTarget[];

/**
 * `MethodView` (ce que le navigateur reçoit) vue comme une `Method` (ce que le catalogue tient). Les deux décrivent la même
 * entrée ; seul `suggereePour` manque à la vue, et ni `renderMessageMethodBlock` ni `methodDetected` ne le lisent.
 */
export function methodOfView(view: MethodView): Method {
  return { ...view, suggereePour: [] };
}

// --- Puce « + Méthode » du composeur (C §9.4) --------------------------------------------------------------------------------

/** Pourquoi une méthode ne peut pas être ajoutée à ce message : raccourci, déjà dans l'assistant, limite atteinte. */
export type MethodChipCode = "raccourci" | "deja" | "trop";

/** Une phrase par code (§4.3) : la puce n'en invente aucune. */
export function methodChipReason(code: MethodChipCode): string {
  const limites = TEXTES.partout.methodes.limites;
  if (code === "raccourci") return limites.raccourci;
  return code === "deja" ? limites.deja : limites.trop;
}

/** Ligne du popover : une méthode `consigne` du catalogue, son état et, si elle est refusée, la phrase qui le dit. */
export interface MethodChipItem {
  id: string;
  titre: string;
  phrase: string;
  /** « Quand : … » déjà formaté (§4.3). */
  quand: string;
  /** Bloc que le composeur ajoutera au texte du message (D-5-08), avant modification par l'utilisateur. */
  bloc: string;
  choisie: boolean;
  /** true : la ligne peut être cochée ou décochée. */
  active: boolean;
  code: MethodChipCode | null;
  raison: string | null;
}

/** État de la puce : le bouton « + Méthode », les lignes du popover et la limite en vigueur. */
export interface MethodChipState {
  boutonActif: boolean;
  boutonRaison: string | null;
  items: MethodChipItem[];
  limite: number;
  /** Nombre de méthodes déjà retenues pour ce message. */
  retenues: number;
}

/**
 * État de la puce pour l'assistant courant. Ordre des refus : raccourci (aucune méthode ne s'y ajoute, C §9.4), méthode déjà
 * présente dans les consignes de l'assistant (elle serait demandée deux fois), puis limite par message (2, D-5-07).
 * Une méthode DÉJÀ retenue reste décochable, même si son code est devenu « deja » (assistant changé après le choix) : sans quoi
 * un bloc resterait attaché au message sans aucun moyen de le retirer.
 */
export function methodChipState(input: {
  methods: readonly MethodView[];
  /** Nom d'agent de l'assistant du composeur. */
  agent: string;
  /** Le message commence par « /… » : c'est un raccourci. */
  estRaccourci: boolean;
  choisies: readonly string[];
  limite?: number;
}): MethodChipState {
  const limite = input.limite ?? METHOD_LIMITS.parMessage;
  const choisies = new Set(input.choisies);
  const items = input.methods
    .filter((method) => method.kind === "consigne")
    .map((method): MethodChipItem => {
      const choisie = choisies.has(method.id);
      let code: MethodChipCode | null = null;
      if (input.estRaccourci) code = "raccourci";
      else if (method.utiliseePar.some((assistant) => assistant.name === input.agent)) code = "deja";
      else if (!choisie && choisies.size >= limite) code = "trop";
      return {
        id: method.id,
        titre: method.titre,
        phrase: method.phrase,
        quand: TEXTES.partout.methodes.carte.quand.replace("{quand}", method.quand),
        bloc: renderMessageMethodBlock(methodOfView(method)),
        choisie,
        active: input.estRaccourci ? false : choisie || code === null,
        code,
        raison: code === null ? null : methodChipReason(code),
      };
    });
  return {
    boutonActif: !input.estRaccourci,
    boutonRaison: input.estRaccourci ? methodChipReason("raccourci") : null,
    items,
    limite,
    retenues: choisies.size,
  };
}

/** Libellé de la puce d'une méthode retenue et de son bouton de retrait (§4.3). */
export function methodChipLabels(titre: string): { choisie: string; retirer: string } {
  const puce = TEXTES.partout.methodes.puce;
  return { choisie: puce.choisie.replace("{titre}", titre), retirer: puce.retirer.replace("{titre}", titre) };
}

// --- Bulle d'un message et présence dans la réponse (spéc. §5.5, §6 l.1051) ----------------------------------------------------

/** Méthode lue dans le texte d'un message envoyé (`splitMessageMethods`), telle qu'elle y est écrite. */
export interface MethodDemandee {
  id: string;
  version: number;
  bloc: string;
}

/** Ligne repliée de la bulle : « Méthode demandée : {titre} » et le bloc réellement envoyé. */
export interface MethodBubbleRow {
  id: string;
  titre: string;
  libelle: string;
  bloc: string;
}

/**
 * Lignes de la bulle d'un message utilisateur. Le titre vient du catalogue ; une méthode qu'il ne connaît plus (retirée d'une
 * version à l'autre) garde son identifiant : la bulle montre ce qui a été envoyé, jamais un titre inventé.
 */
export function methodBubbleRows(demandees: readonly MethodDemandee[], catalogue: readonly MethodView[]): MethodBubbleRow[] {
  return demandees.map((demandee) => {
    const titre = catalogue.find((method) => method.id === demandee.id)?.titre ?? demandee.id;
    return { id: demandee.id, titre, libelle: TEXTES.partout.methodes.bulle.demandee.replace("{titre}", titre), bloc: demandee.bloc };
  });
}

/** Présence de la section attendue dans la réponse : un mot ET une icône, jamais la couleur seule (grille V2). */
export interface MethodPresenceRow {
  id: string;
  titre: string;
  presente: boolean;
  libelle: string;
  /** Infobulle commune : ce que le cockpit vérifie, et ce qu'il ne vérifie pas. */
  infobulle: string;
}

/**
 * Une ligne par méthode demandée DONT LE CATALOGUE DONNE L'EN-TÊTE : sans en-tête, il n'y a rien à chercher dans la réponse, et
 * le cockpit ne dit ni « appliquée » ni « non détectée ». La réponse est du texte d'IA : elle n'est que lue (`methodDetected`),
 * jamais interprétée, et l'affichage l'échappe.
 */
export function methodPresenceRows(input: {
  demandees: readonly MethodDemandee[];
  catalogue: readonly MethodView[];
  reponse: string;
}): MethodPresenceRow[] {
  const detection = TEXTES.partout.methodes.detection;
  return input.demandees.flatMap((demandee) => {
    const method = input.catalogue.find((entree) => entree.id === demandee.id);
    if (!method) return [];
    const presente = methodDetected(input.reponse, methodOfView(method));
    return [
      {
        id: method.id,
        titre: method.titre,
        presente,
        libelle: presente ? detection.appliquee : detection.absente,
        infobulle: detection.infobulle,
      },
    ];
  });
}

// --- Bouton « Seconde lecture » (C §9.7, D-5-22) -------------------------------------------------------------------------------

/** Pourquoi le bouton n'est pas proposé sous cette réponse. */
export type SecondReadingHiddenCode = "en-cours" | "repere" | "relecture";

export interface SecondReadingVisibility {
  visible: boolean;
  code: SecondReadingHiddenCode | null;
}

/**
 * Le bouton n'est proposé que sous une réponse TERMINÉE de l'assistant. Trois cas l'excluent (fiche L44e) : la relecture
 * elle-même (on ne relit pas une relecture d'un clic), un message repère sans appel d'IA (il n'y a rien à relire), et une
 * réponse en cours (elle n'est pas finie).
 */
export function secondReadingButtonVisible(input: { terminee: boolean; repere: boolean; estSecondeLecture: boolean }): SecondReadingVisibility {
  if (input.estSecondeLecture) return { visible: false, code: "relecture" };
  if (input.repere) return { visible: false, code: "repere" };
  if (!input.terminee) return { visible: false, code: "en-cours" };
  return { visible: true, code: null };
}

const BOUTON = TEXTES.partout.secondeLecture.bouton;
const MONTANT = "{x}";

/**
 * Libellé sans montant : le début du gabarit, avant la parenthèse de l'estimation. Aucune estimation n'est alors affichée
 * (`base: "aucune"`, ou aucun prix connu) : mieux vaut ne rien chiffrer que chiffrer à faux (P3).
 */
const BOUTON_SANS_MONTANT = BOUTON.includes("(") ? BOUTON.slice(0, BOUTON.indexOf("(")).trimEnd() : BOUTON;

/**
 * Libellé du bouton. `montant` est le nombre déjà formaté, SANS sa devise (le gabarit porte « $ »), ou null quand rien n'est
 * chiffrable. « ≈ » vient du gabarit ; « au moins » n'y figure pas et n'est ajouté nulle part (D-5-22).
 */
export function secondReadingButtonLabel(montant: string | null): string {
  return montant === null ? BOUTON_SANS_MONTANT : BOUTON.replace(MONTANT, montant);
}

/** Phrase de la base de l'estimation (§4.3) ; « aucune » n'en a pas : aucun montant n'est affiché. */
export function secondReadingBasePhrase(base: SecondReadingEstimate["base"]): string | null {
  return base === "aucune" ? null : TEXTES.partout.secondeLecture.base[base];
}

/**
 * Infobulle du bouton : l'IA nommée, la phrase de la base ensuite (A5, réponse Q1 (a)). Null quand aucune IA n'est résolue :
 * l'infobulle nommerait une IA inconnue.
 */
export function secondReadingTooltip(estimate: SecondReadingEstimate): string | null {
  if (estimate.ia === null) return null;
  const debut = TEXTES.partout.secondeLecture.infobulle.replace("{ia}", estimate.ia.libelle);
  const base = secondReadingBasePhrase(estimate.base);
  return base === null ? debut : `${debut} ${base}`;
}

/** Message envoyé au Relecteur, variante « reponse » (§4.3) : le texte EXACT, jamais une reformulation. */
export function secondReadingMessage(assistant: string): string {
  return TEXTES.partout.secondeLecture.message.replace("{assistant}", assistant);
}

/**
 * Le texte d'un message est-il une demande de seconde lecture ? Même règle que le crochet du serveur
 * (`estMessageDeSecondeLecture`, second-reading.ts) et même source : le début fixe rendu par `secondReadingPrefix`, pour que
 * l'interface reconnaisse exactement les tours que le serveur a requalifiés.
 */
export function estDemandeDeSecondeLecture(texte: string): boolean {
  return CIBLES.some((cible) => texte.startsWith(secondReadingPrefix(cible)));
}

/** Pied « Relecture par un autre assistant : … » sous la réponse du Relecteur : affiché quand la demande en est une. */
export function secondReadingFooter(demande: string | null): string | null {
  return demande !== null && estDemandeDeSecondeLecture(demande) ? TEXTES.partout.secondeLecture.pied : null;
}
