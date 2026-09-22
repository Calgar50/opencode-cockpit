// Édition guidée d'une équipe (itération 4, plan d'exécution it4 §6 fiche L40b, §2.6, D-eq-10, D-eq-12, D-eq-24 ; spécification
// §5.3 l.894-902, §5.5, §5.6, §2.2 l.90 ; conception C §5.1, §8.1, §9.11) : module PUR (ni « node: », ni process, ni horloge, ni
// aléa, ni réseau), partagé avec l'interface.
//
// Deux parts, toutes deux testées par server/flow-edit.test.ts (D-eq-24 : les .tsx restent minces) :
// 1. le BROUILLON : opérations d'édition (ajouter un bloc, ajouter ou retirer un avis, monter, descendre, supprimer, dupliquer,
//    modifier une étape ou une pause), identifiants stables et historique annuler / rétablir de 100 états ;
// 2. le MODÈLE DES 4 ÉCRANS : progression, écran de départ, cartes de blocs, tableau de coût, vérification et enregistrement.
//
// Formes de l'itération 4 (D-eq-10) : blocs « etape », « avis » et « pause » seulement ; clé JSON « avis » (jamais « regards ») ;
// ni « facultatif », ni « methodes », ni `recoit: {etapes}` (« relecture » et « aiguillage » arrivent en itération 5, et leurs
// formes ne sont donc proposées nulle part ici). Bornes : FLOW_LIMITS et TEAM_TEXT_LIMITS de team-limits.ts (T4), jamais réécrites.
//
// Valeurs par défaut (C §5.1, adaptées à D-eq-10) : `recoit = "precedent"` pour une étape, « demande » pour le premier bloc de
// travail ; chaque avis reçoit « demande » (c'est ce qui les rend indépendants) et la synthèse « tous » ; `niveau = null` (l'IA de
// l'assistant, décision n° 3, D-eq-12) ; taille « M » ; consigne vide. Le titre d'une étape part VIDE : la grammaire (L36a) pose
// alors son problème sur l'étape (« Donnez à l'étape un titre de 2 à 60 caractères. »), qui est l'invite. Seule la synthèse part
// avec son titre de rôle, repris de team-texts.ts.
//
// AUCUN TEXTE n'est écrit ici : toutes les phrases viennent de team-texts.ts (T4t), gabarits remplis par remplir(), montants par
// montant() à travers remplir(). Aucun ordre d'exécution n'est réécrit : planSteps et receivedFrom (T4) restent les fonctions de
// référence, consommées par l'aperçu du serveur (POST /api/teams/preview) et par layoutFlow (L36b).
//
// MODE SIMPLE FERMÉ (décision U1, D-eq-13 ; plan §2.6) : la SEULE valeur qui ferme l'éditeur en Simple est `ouvertesEnSimple` de
// GET /api/teams. Tant qu'elle est fausse, `buildEditor` rend `affichage: "ferme"` : aucun écran n'est monté et `apercuDemande`
// est faux, donc aucune requête d'aperçu ne part. Le parcours Simple reste entièrement construit et testé ici : l'ouverture tient
// en UNE ligne (EQUIPES_SIMPLE_OUVERTES = true dans wiring-eq.ts), sans qu'aucune autre valeur n'entre en jeu.
import { type RightLine, slugifyName, TASK_SIZES, type TaskSize, type Tier, TIER_IDS } from "./assistant-rules.ts";
import { FLOW_LIMITS, FLOW_VERSION, isStepInputName, TEAM_TEXT_LIMITS } from "./team-limits.ts";
import { montant, refusEnregistrement, remplir, TEXTES } from "./team-texts.ts";
import type {
  Flow,
  FlowBlock,
  FlowProblem,
  FlowRow,
  FlowStep,
  StepEstimate,
  StepInput,
  TeamExampleView,
  TeamPreviewResponse,
} from "./team-types.ts";

const P = TEXTES.partout;
const E = P.editeur;

// --- Brouillon ------------------------------------------------------------------------------------------------------------------

/**
 * Brouillon en cours d'édition. `compteur` fait les identifiants : il ne redescend JAMAIS, même après une suppression, donc un
 * identifiant déjà rendu n'est jamais réattribué et les identifiants des blocs et des étapes gardés restent STABLES à travers
 * une montée, une descente ou une duplication.
 */
export interface FlowDraft {
  flow: Flow;
  compteur: number;
}

/** Genres de bloc que l'itération 4 propose à l'ajout (D-eq-10 : union fermée, sans « relecture » ni « aiguillage »). */
export const BLOCS_AJOUTABLES: readonly FlowBlock["type"][] = Object.freeze(["etape", "avis", "pause"]);

/** Formes proposées par l'écran 1 en itération 4 (Q3 (a)) : « Rédaction et relecture » et « Aiguillage » arrivent en itération 5. */
export const FORMES_DEPART: readonly ["a-la-suite", "avis"] = Object.freeze(["a-la-suite", "avis"]) as readonly ["a-la-suite", "avis"];

export type FormeDepart = (typeof FORMES_DEPART)[number];

/** Taille d'estimation d'une étape neuve : « Un fichier ou un document » (profil du milieu). */
export const TAILLE_PAR_DEFAUT: TaskSize = "M";

/**
 * Longueur maximale d'un identifiant d'équipe. TEAM_ID_RE (T4) ne l'expose pas : le test d'identifiantEquipe vérifie que chaque
 * identifiant rendu passe TEAM_ID_RE, une borne devenue fausse ferait donc échouer les tests plutôt que les enregistrements.
 */
const TEAM_ID_MAX = 40;

/** Identifiant d'un bloc ou d'une étape : lettre, puis le compteur (STEP_ID_RE : ^[a-z0-9-]{1,24}$). */
const identifiant = (prefixe: "b" | "e", n: number): string => `${prefixe}${n}`;

// <c5:compte-formes>
// Branche minimale (L42a) : les formes de la 5b sont des blocs de TRAVAIL et leurs étapes comptent dans les 12, sinon les
// bornes de l'éditeur mentiraient sur un déroulé qui en contient. Rien de nouveau n'est proposé pour autant : BLOCS_AJOUTABLES
// et FORMES_DEPART restent ceux de l'itération 4, et l'éditeur guidé de ces formes arrive avec L42d.
const estTravail = (block: FlowBlock): boolean => block.type !== "pause";

/** Étapes déclarées d'un bloc, dans l'ordre d'écriture (aucun ordre d'exécution : planSteps reste la référence). */
function etapesDe(block: FlowBlock): FlowStep[] {
  if (block.type === "etape") return [block.etape];
  if (block.type === "avis") return [...block.avis, block.synthese];
  if (block.type === "relecture") return [block.auteur, block.relecteur];
  if (block.type === "aiguillage") return [block.aiguilleur, ...block.specialistes, ...(block.synthese ? [block.synthese] : [])];
  return [];
}
// </c5:compte-formes>

/** Nombre d'étapes déclarées d'un déroulé (bornes FLOW_LIMITS.etapes). */
export function compterEtapes(flow: Flow): number {
  return flow.blocs.reduce((total, block) => total + etapesDe(block).length, 0);
}

/** Nombre de blocs de travail (les pauses ne comptent pas, FLOW_LIMITS.blocsTravail). */
export function compterBlocsTravail(flow: Flow): number {
  return flow.blocs.filter(estTravail).length;
}

function etapeNeuve(draft: FlowDraft, recoit: StepInput, titre = ""): { step: FlowStep; compteur: number } {
  const compteur = draft.compteur + 1;
  return {
    step: { id: identifiant("e", compteur), titre, assistant: "", niveau: null, taille: TAILLE_PAR_DEFAUT, consigne: "", recoit },
    compteur,
  };
}

/** Brouillon vide : aucun bloc. L'écran 1 en pose un, et la grammaire dit « vide » tant qu'il n'y en a aucun. */
export function brouillonVide(): FlowDraft {
  return { flow: { version: FLOW_VERSION, blocs: [] }, compteur: 0 };
}

/** Brouillon repris d'un déroulé existant (modification, duplication) : les identifiants du déroulé sont gardés tels quels. */
export function brouillonDe(flow: Flow): FlowDraft {
  const copie = copierFlow(flow);
  return { flow: copie, compteur: compteurSuffisant(copie) };
}

/**
 * Compteur assez haut pour qu'aucun identifiant neuf ne heurte un identifiant déjà présent : le plus grand nombre lu dans les
 * identifiants « bN » et « eN », ou le nombre d'éléments quand aucun ne suit cette forme (un déroulé venu d'un exemple ou d'une
 * version future peut porter n'importe quel identifiant valide).
 */
function compteurSuffisant(flow: Flow): number {
  let max = 0;
  for (const block of flow.blocs) {
    for (const id of [block.id, ...etapesDe(block).map((step) => step.id)]) {
      const nombre = /^[be](\d+)$/.exec(id);
      if (nombre) max = Math.max(max, Number(nombre[1]));
      else max += 1;
    }
  }
  return max;
}

/** Copie profonde d'un déroulé : l'historique garde des états entiers, jamais un objet partagé avec l'état courant. */
function copierFlow(flow: Flow): Flow {
  return {
    version: FLOW_VERSION,
    blocs: flow.blocs.map((block): FlowBlock => {
      if (block.type === "etape") return { type: "etape", id: block.id, etape: { ...block.etape } };
      if (block.type === "avis") {
        return { type: "avis", id: block.id, avis: block.avis.map((step) => ({ ...step })), synthese: { ...block.synthese } };
      }
      if (block.type === "pause") return { type: "pause", id: block.id, message: block.message };
      // <c5:copie-formes>
      // Branche minimale (L42a) : les formes de la 5b (relecture, aiguillage) sont recopiées telles quelles. L42d donne leur
      // copie champ par champ avec l'éditeur guidé ; ici, rien de nouveau n'est rendu possible.
      return { ...block };
      // </c5:copie-formes>
    }),
  };
}

/**
 * `recoit` RÉPARÉ quand la place l'a rendu ILLÉGAL, jamais réécrit autrement : sinon la grammaire poserait « recoit-invalide »
 * sur une étape que l'utilisateur n'a pas touchée — mais une valeur légitime serait détruite en silence.
 * Ce que la grammaire (flow.ts, `attendu`) impose, et donc tout ce qui est réparé ici :
 * - premier bloc de travail : « demande », la seule valeur acceptée à cette place ;
 * - bloc « etape » suivant : `attendu` vaut null, la grammaire laisse le choix. Seule « demande », héritée d'un déplacement, est
 *   remplacée par la valeur par défaut « precedent » (C §5.1) ; « precedent » comme « tous » sont GARDÉS — l'exemple « Chaîne de
 *   relecture de script » (A11, Q3 (a)) finit justement par une consolidation en « tous » ;
 * - avis : « demande » (c'est ce qui les rend indépendants) ; synthèse : « tous ». Les deux sont imposés par la grammaire.
 */
function reglerEntrees(flow: Flow): Flow {
  let premierVu = false;
  for (const block of flow.blocs) {
    if (block.type === "pause") continue;
    const premier = !premierVu;
    premierVu = true;
    if (block.type === "etape") {
      if (premier) block.etape.recoit = "demande";
      else if (block.etape.recoit === "demande") block.etape.recoit = "precedent";
    } else if (block.type === "avis") {
      // Les avis reçoivent la demande seule : c'est ce qui les rend indépendants (spéc. §6 l.1034).
      for (const avis of block.avis) avis.recoit = "demande";
      block.synthese.recoit = "tous";
    }
    // <c5:entrees-formes>
    // Branche minimale (L42a) : les entrées des formes de la 5b sont IMPLICITES (le relecteur reçoit la version courante, un
    // spécialiste la raison de l'aiguilleur, la synthèse les résultats choisis) et ne se réparent pas ici. L42d les pose.
    // </c5:entrees-formes>
  }
  return flow;
}

/** Nouvel état du brouillon, entrées recalculées, sans toucher l'état reçu. */
function poser(draft: FlowDraft, flow: Flow, compteur: number): FlowDraft {
  return { flow: reglerEntrees(flow), compteur };
}

/** Bloc neuf du genre demandé, avec ses étapes par défaut. */
function blocNeuf(draft: FlowDraft, type: FlowBlock["type"]): { block: FlowBlock; compteur: number } {
  const compteurBloc = draft.compteur + 1;
  const id = identifiant("b", compteurBloc);
  if (type === "pause") return { block: { type: "pause", id, message: "" }, compteur: compteurBloc };
  if (type === "etape") {
    const { step, compteur } = etapeNeuve({ ...draft, compteur: compteurBloc }, "precedent");
    return { block: { type: "etape", id, etape: step }, compteur };
  }
  let compteur = compteurBloc;
  const avis: FlowStep[] = [];
  for (let i = 0; i < FLOW_LIMITS.avisMin; i++) {
    const neuve = etapeNeuve({ ...draft, compteur }, "demande");
    compteur = neuve.compteur;
    avis.push(neuve.step);
  }
  const synthese = etapeNeuve({ ...draft, compteur }, "tous", E.synthese);
  return { block: { type: "avis", id, avis, synthese: synthese.step }, compteur: synthese.compteur };
}

/** Étapes qu'un bloc de ce genre ajoute (contrôle des bornes avant l'ajout). */
function etapesAjoutees(type: FlowBlock["type"]): number {
  if (type === "pause") return 0;
  return type === "etape" ? 1 : FLOW_LIMITS.avisMin + 1;
}

/**
 * Ajout d'un bloc à la position `index` (0 = en tête, `blocs.length` = à la fin). Refusé — le brouillon est rendu tel quel —
 * quand la borne des blocs de travail (5) ou celle des étapes (12) serait dépassée : l'éditeur désactive l'entrée du menu avec
 * la même règle, et la grammaire reste la seule autorité sur ce qui est enregistrable.
 */
export function ajouterBloc(draft: FlowDraft, type: FlowBlock["type"], index: number): FlowDraft {
  if (!BLOCS_AJOUTABLES.includes(type)) return draft;
  if (!peutAjouterBloc(draft, type)) return draft;
  const place = Math.max(0, Math.min(Math.trunc(index), draft.flow.blocs.length));
  const { block, compteur } = blocNeuf(draft, type);
  const blocs = copierFlow(draft.flow).blocs;
  blocs.splice(place, 0, block);
  return poser(draft, { version: FLOW_VERSION, blocs }, compteur);
}

/** L'ajout d'un bloc de ce genre tient dans les bornes (5 blocs de travail, 12 étapes). */
export function peutAjouterBloc(draft: FlowDraft, type: FlowBlock["type"]): boolean {
  const travail = compterBlocsTravail(draft.flow) + (type === "pause" ? 0 : 1);
  return travail <= FLOW_LIMITS.blocsTravail && compterEtapes(draft.flow) + etapesAjoutees(type) <= FLOW_LIMITS.etapes;
}

/** Un avis de plus dans ce bloc : 5 avis au plus (FLOW_LIMITS.avisMax) et 12 étapes au plus. */
export function peutAjouterAvis(draft: FlowDraft, blocId: string): boolean {
  const block = draft.flow.blocs.find((b) => b.id === blocId);
  if (!block || block.type !== "avis") return false;
  return block.avis.length < FLOW_LIMITS.avisMax && compterEtapes(draft.flow) + 1 <= FLOW_LIMITS.etapes;
}

/** Un avis de moins : 2 avis au moins (FLOW_LIMITS.avisMin). */
export function peutRetirerAvis(draft: FlowDraft, blocId: string): boolean {
  const block = draft.flow.blocs.find((b) => b.id === blocId);
  return !!block && block.type === "avis" && block.avis.length > FLOW_LIMITS.avisMin;
}

export function ajouterAvis(draft: FlowDraft, blocId: string): FlowDraft {
  if (!peutAjouterAvis(draft, blocId)) return draft;
  const flow = copierFlow(draft.flow);
  const block = flow.blocs.find((b) => b.id === blocId);
  if (!block || block.type !== "avis") return draft;
  const { step, compteur } = etapeNeuve(draft, "demande");
  block.avis.push(step);
  return poser(draft, flow, compteur);
}

export function retirerAvis(draft: FlowDraft, blocId: string, stepId: string): FlowDraft {
  if (!peutRetirerAvis(draft, blocId)) return draft;
  const flow = copierFlow(draft.flow);
  const block = flow.blocs.find((b) => b.id === blocId);
  if (!block || block.type !== "avis" || !block.avis.some((step) => step.id === stepId)) return draft;
  block.avis = block.avis.filter((step) => step.id !== stepId);
  return poser(draft, flow, draft.compteur);
}

/** Déplacement d'un bloc d'un rang ; les identifiants ne bougent pas (rien n'est recréé). */
function deplacer(draft: FlowDraft, blocId: string, pas: -1 | 1): FlowDraft {
  const index = draft.flow.blocs.findIndex((block) => block.id === blocId);
  const cible = index + pas;
  if (index === -1 || cible < 0 || cible >= draft.flow.blocs.length) return draft;
  const blocs = copierFlow(draft.flow).blocs;
  const [block] = blocs.splice(index, 1);
  if (!block) return draft;
  blocs.splice(cible, 0, block);
  return poser(draft, { version: FLOW_VERSION, blocs }, draft.compteur);
}

export function monter(draft: FlowDraft, blocId: string): FlowDraft {
  return deplacer(draft, blocId, -1);
}

export function descendre(draft: FlowDraft, blocId: string): FlowDraft {
  return deplacer(draft, blocId, 1);
}

export function supprimerBloc(draft: FlowDraft, blocId: string): FlowDraft {
  if (!draft.flow.blocs.some((block) => block.id === blocId)) return draft;
  const blocs = copierFlow(draft.flow).blocs.filter((block) => block.id !== blocId);
  return poser(draft, { version: FLOW_VERSION, blocs }, draft.compteur);
}

/** La duplication de ce bloc tient dans les bornes (5 blocs de travail, 12 étapes). */
export function peutDupliquer(draft: FlowDraft, blocId: string): boolean {
  const original = draft.flow.blocs.find((block) => block.id === blocId);
  if (original === undefined) return false;
  const travail = compterBlocsTravail(draft.flow) + (estTravail(original) ? 1 : 0);
  return travail <= FLOW_LIMITS.blocsTravail && compterEtapes(draft.flow) + etapesDe(original).length <= FLOW_LIMITS.etapes;
}

/**
 * Duplication d'un bloc, posée juste après l'original : la COPIE reçoit des identifiants neufs, l'original garde les siens (un
 * identifiant déjà écrit dans un lancement passé ne doit jamais désigner autre chose). Refusée quand les bornes seraient
 * dépassées.
 */
export function dupliquerBloc(draft: FlowDraft, blocId: string): FlowDraft {
  const index = draft.flow.blocs.findIndex((block) => block.id === blocId);
  const original = draft.flow.blocs[index];
  if (!original || !peutDupliquer(draft, blocId)) return draft;

  let compteur = draft.compteur + 1;
  const copieId = identifiant("b", compteur);
  const copieEtape = (step: FlowStep): FlowStep => {
    compteur += 1;
    return { ...step, id: identifiant("e", compteur) };
  };
  let copie: FlowBlock;
  if (original.type === "etape") copie = { type: "etape", id: copieId, etape: copieEtape(original.etape) };
  else if (original.type === "avis") {
    copie = { type: "avis", id: copieId, avis: original.avis.map(copieEtape), synthese: copieEtape(original.synthese) };
  } else if (original.type === "pause") copie = { type: "pause", id: copieId, message: original.message };
  // <c5:duplication-formes>
  // Branche minimale (L42a) : une forme de la 5b se duplique telle quelle, identifiant du bloc changé. L42d renumérotera ses
  // étapes comme l'éditeur guidé le fait pour les formes de l'itération 4.
  else copie = { ...original, id: copieId };
  // </c5:duplication-formes>

  const blocs = copierFlow(draft.flow).blocs;
  blocs.splice(index + 1, 0, copie);
  return poser(draft, { version: FLOW_VERSION, blocs }, compteur);
}

/** Champs d'une étape que l'éditeur modifie. `recoit` n'en est pas : il vient de la place du bloc (C §5.1). */
export interface StepPatch {
  titre?: string;
  assistant?: string;
  taille?: TaskSize;
  consigne?: string;
  /** Mode Avancé seulement (D-eq-12) : en Simple, l'appelant ne le passe jamais et modifierEtape l'ignore. */
  niveau?: Tier | null;
}

/**
 * Modification d'une étape. Les textes sont bornés ici (titre 60, consigne 4 000) pour que le brouillon reste enregistrable ;
 * `simple` vrai ignore `niveau` : en mode Simple, l'IA d'une étape est celle de son assistant (décision n° 3, D-eq-12), et
 * aucun chemin de l'éditeur ne peut la changer.
 * Un patch qui ne change RIEN — une frappe de plus dans un champ déjà borné, une taille hors de la liste fermée — rend le
 * brouillon TEL QUEL : `appliquer` n'écrit alors aucun état, et [Annuler] ne rend jamais un état identique au précédent.
 */
export function modifierEtape(draft: FlowDraft, stepId: string, patch: StepPatch, options: { simple: boolean }): FlowDraft {
  const flow = copierFlow(draft.flow);
  let trouvee: FlowStep | null = null;
  for (const block of flow.blocs) {
    for (const step of etapesDe(block)) if (step.id === stepId) trouvee = step;
  }
  if (trouvee === null) return draft;
  const titre = patch.titre === undefined ? trouvee.titre : patch.titre.slice(0, TEAM_TEXT_LIMITS.titreEtape.max);
  const assistant = patch.assistant ?? trouvee.assistant;
  const taille = patch.taille !== undefined && TASK_SIZES.includes(patch.taille) ? patch.taille : trouvee.taille;
  const consigne = patch.consigne === undefined ? trouvee.consigne : patch.consigne.slice(0, FLOW_LIMITS.consigne);
  const niveau = patch.niveau !== undefined && !options.simple ? patch.niveau : trouvee.niveau;
  if (titre === trouvee.titre && assistant === trouvee.assistant && taille === trouvee.taille && consigne === trouvee.consigne && niveau === trouvee.niveau) {
    return draft;
  }
  trouvee.titre = titre;
  trouvee.assistant = assistant;
  trouvee.taille = taille;
  trouvee.consigne = consigne;
  trouvee.niveau = niveau;
  return poser(draft, flow, draft.compteur);
}

/** Message d'un bloc « pause » (ce que vous voulez vérifier), borné à TEAM_TEXT_LIMITS.messagePause. */
export function modifierPause(draft: FlowDraft, blocId: string, message: string): FlowDraft {
  const flow = copierFlow(draft.flow);
  const block = flow.blocs.find((b) => b.id === blocId);
  if (!block || block.type !== "pause") return draft;
  const borne = message.slice(0, TEAM_TEXT_LIMITS.messagePause);
  if (borne === block.message) return draft;
  block.message = borne;
  return poser(draft, flow, draft.compteur);
}

/**
 * Déroulé de départ d'une forme (écran 1) : « À la suite » = deux étapes ; « Avis indépendants » = un bloc d'avis (2 avis et sa
 * synthèse). Les deux tiennent dans les bornes.
 */
export function brouillonDeForme(forme: FormeDepart): FlowDraft {
  if (forme === "avis") return ajouterBloc(brouillonVide(), "avis", 0);
  return ajouterBloc(ajouterBloc(brouillonVide(), "etape", 0), "etape", 1);
}

// --- Historique annuler / rétablir -------------------------------------------------------------------------------------------

/** États gardés par l'historique, présent compris (fiche L40b : 100 états). */
export const HISTORIQUE_MAX = 100;

export interface EditHistory {
  /** États antérieurs, du plus ancien au plus récent ; HISTORIQUE_MAX - 1 au plus. */
  passe: readonly FlowDraft[];
  present: FlowDraft;
  /** États annulés, du plus proche du présent au plus lointain. */
  futur: readonly FlowDraft[];
}

export function historiqueDe(draft: FlowDraft): EditHistory {
  return { passe: [], present: draft, futur: [] };
}

/**
 * Applique une opération au présent. Une opération qui ne change rien (borne atteinte, identifiant inconnu) n'écrit PAS d'état :
 * [Annuler] ne rend jamais un état identique au précédent. Au-delà de HISTORIQUE_MAX états, les plus anciens sont oubliés.
 */
export function appliquer(historique: EditHistory, operation: (draft: FlowDraft) => FlowDraft): EditHistory {
  const suivant = operation(historique.present);
  if (suivant === historique.present) return historique;
  const passe = [...historique.passe, historique.present].slice(-(HISTORIQUE_MAX - 1));
  return { passe, present: suivant, futur: [] };
}

export const peutAnnuler = (historique: EditHistory): boolean => historique.passe.length > 0;

export const peutRetablir = (historique: EditHistory): boolean => historique.futur.length > 0;

export function annuler(historique: EditHistory): EditHistory {
  const precedent = historique.passe.at(-1);
  if (precedent === undefined) return historique;
  return {
    passe: historique.passe.slice(0, -1),
    present: precedent,
    futur: [historique.present, ...historique.futur].slice(0, HISTORIQUE_MAX - 1),
  };
}

export function retablir(historique: EditHistory): EditHistory {
  const [suivant, ...reste] = historique.futur;
  if (suivant === undefined) return historique;
  return { passe: [...historique.passe, historique.present].slice(-(HISTORIQUE_MAX - 1)), present: suivant, futur: reste };
}

// --- Assistants proposables ---------------------------------------------------------------------------------------------------

/**
 * Assistant tel que la page Assistants le rend (GET /api/assistants) : les seuls champs lus ici. La forme est un sous-ensemble
 * d'AssistantView, pour que l'interface passe ses vues sans les transformer.
 */
export interface EditorAssistantView {
  name: string;
  title: string;
  rights: "lecture" | "propose" | "personnalise";
  /** Lignes ✓ / ✗ / ? des règles effectives (rightLines d'assistant-rules.ts). */
  rightLines: readonly RightLine[];
  /** IA propre de l'assistant, nom lisible ; null sans IA propre. */
  modelName: string | null;
  /** « subagent » : l'assistant travaille seulement quand un autre lui confie du travail (D-eq-11). */
  mode: "primary" | "subagent" | "all";
  /** Caché dans le chat : réservé au cockpit. */
  hidden: boolean;
}

/**
 * Raison qui désactive un assistant dans la liste, par code de FlowProblemCode : la phrase courte de T4t. C'est une AIDE au
 * choix, pas une autorité : la grammaire du serveur (validateFlow, L36a) reste seule juge, et l'aperçu pose son problème sur
 * l'étape si un assistant passe entre les mailles. Les lignes lues sont celles de rightLines (règles effectives) :
 * « delegation » autre que refusée, « internet » autre que refusée, et « allow » sur la modification, les commandes ou un
 * dossier extérieur.
 */
export function raisonIndisponible(assistant: EditorAssistantView, options: { simple: boolean }): string | null {
  const action = (id: string) => assistant.rightLines.find((ligne) => ligne.id === id)?.action ?? null;
  if (assistant.hidden) return E.indisponibles["assistant-interne"];
  if (assistant.mode === "subagent") return E.indisponibles["assistant-non-proposable"];
  if (assistant.rights === "propose") return E.indisponibles["propose-reporte"];
  if (assistant.rights === "personnalise" && options.simple) return E.indisponibles.personnalise;
  if (action("delegation") !== null && action("delegation") !== "deny") return E.indisponibles.delegue;
  if (action("internet") !== null && action("internet") !== "deny") return E.indisponibles.internet;
  for (const id of ["modification", "commande", "hors-dossier"]) {
    if (action(id) === "allow") return E.indisponibles["autorise-sans-demander"];
  }
  // Sans IA propre : la grammaire (flow.ts) ne pose « niveau-indisponible » sur ce motif QUE lorsque l'étape n'a aucun niveau.
  // En Avancé, choisir une « IA de l'étape » (D-eq-12) lève le problème : l'éditeur ne ferme donc pas un montage que la règle
  // accepte, et laisse l'aperçu poser son problème sur l'étape tant qu'aucun niveau n'est choisi. En Simple, aucun niveau ne
  // peut être choisi (D-eq-12) : le refus est définitif, et l'option reste lisible avec sa raison.
  if (assistant.modelName === null && options.simple) return E.indisponibles["niveau-indisponible"];
  return null;
}

export interface AssistantOption {
  nom: string;
  libelle: string;
  /** Désactivée : l'option reste lisible, avec sa raison (jamais retirée en silence). */
  desactivee: boolean;
  /** Phrase courte de la raison ; null quand l'assistant est proposable. */
  raison: string | null;
}

export interface AssistantGroupe {
  titre: string;
  options: readonly AssistantOption[];
}

/**
 * Assistants offerts au choix d'une étape, en un seul groupe « Mes assistants » en itération 4 : le catalogue n'est pas installé
 * depuis l'éditeur (l'onglet Équipes s'en charge), et les assistants du Studio sont des assistants de la liste comme les autres.
 * L'ordre est celui reçu ; les indisponibles restent visibles, désactivés, avec leur raison.
 */
export function assistantsProposables(assistants: readonly EditorAssistantView[], options: { simple: boolean }): AssistantGroupe[] {
  if (assistants.length === 0) return [];
  return [
    {
      titre: E.champs.mesAssistants,
      options: assistants.map((assistant): AssistantOption => {
        const raison = raisonIndisponible(assistant, options);
        return { nom: assistant.name, libelle: assistant.title, desactivee: raison !== null, raison };
      }),
    },
  ];
}

// --- IA de l'étape (mode Avancé seulement, D-eq-12) ---------------------------------------------------------------------------

/** Niveau d'IA proposable, tel que l'amorçage le rend (boot.ai.tiers et boot.models). */
export interface EditorTier {
  niveau: Tier;
  /** Nom du niveau (TIER_LABELS). */
  libelle: string;
  /** Coût estimé d'un appel par taille, au prix effectif (ModelInfo.taskCost) ; null sans prix connu. */
  coutParTaille: Readonly<Record<TaskSize, number>> | null;
  /** Niveau résolu sur le catalogue Copilot de ce poste. */
  disponible: boolean;
}

export interface ChoixIa {
  valeur: Tier | null;
  libelle: string;
  desactive: boolean;
}

/**
 * Choix d'« IA de l'étape » : l'IA de l'assistant d'abord (valeur null, décision n° 3), puis un choix par niveau, chacun avec
 * « ≈ X $ » calculé sur la taille habituelle de l'étape. Rendu SEULEMENT en mode Avancé : en Simple, buildEditor laisse `ia` nul.
 */
export function choixIaEtape(step: FlowStep, niveaux: readonly EditorTier[], iaAssistant: string | null): ChoixIa[] {
  const choix: ChoixIa[] = [
    { valeur: null, libelle: remplir(TEXTES.avance.editeurIa.assistant, { ia: iaAssistant ?? "" }), desactive: false },
  ];
  for (const id of TIER_IDS) {
    const tier = niveaux.find((niveau) => niveau.niveau === id);
    if (!tier) continue;
    const cout = tier.coutParTaille === null ? Number.NaN : tier.coutParTaille[step.taille];
    choix.push({
      valeur: id,
      libelle: remplir(TEXTES.avance.editeurIa.niveau, { niveau: tier.libelle, cout }),
      desactive: !tier.disponible,
    });
  }
  return choix;
}

// --- Modèle des 4 écrans ------------------------------------------------------------------------------------------------------

export const ECRANS = [1, 2, 3, 4] as const;
export type EcranId = (typeof ECRANS)[number];

const NOMS_ECRANS: Readonly<Record<EcranId, string>> = {
  1: E.ecrans.depart,
  2: E.ecrans.etapes,
  3: E.ecrans.cout,
  4: E.ecrans.verifier,
};

export interface ProgressionModel {
  /** aria-label de la progression (spéc. §2.2 l.90 : « Progression », jamais « Étape »). */
  libelle: string;
  /** « 2 / 4 · Les étapes ». */
  texte: string;
  courant: EcranId;
  /** Nom de chaque écran, dans l'ordre. */
  ecrans: readonly string[];
}

export function progressionDe(ecran: EcranId): ProgressionModel {
  return {
    libelle: E.progressionLibelle,
    texte: remplir(E.progression, { n: ecran, ecran: NOMS_ECRANS[ecran] }),
    courant: ecran,
    ecrans: ECRANS.map((id) => NOMS_ECRANS[id]),
  };
}

export interface FormeCarte {
  id: FormeDepart;
  titre: string;
  aide: string;
}

export interface ExempleCarte {
  id: string;
  titre: string;
  description: string;
  liste: readonly string[];
  layout: readonly FlowRow[];
}

export interface Ecran1Model {
  partirExemple: string;
  partirForme: string;
  exemples: readonly ExempleCarte[];
  formes: readonly FormeCarte[];
}

/** Problème affiché sur un bloc ou une étape : sa phrase, et s'il bloque l'enregistrement. */
export interface ProblemeAffiche {
  code: string;
  texte: string;
  bloquant: boolean;
}

export interface StepFormModel {
  stepId: string;
  /** Rôle de l'étape dans son bloc : une synthèse ne se retire pas. */
  role: "etape" | "avis" | "synthese";
  /** `max` : borne de saisie du champ, comme la consigne et le message de pause (jamais un nombre écrit dans le .tsx). */
  titre: { libelle: string; aide: string; valeur: string; max: number };
  assistant: { libelle: string; valeur: string; groupes: readonly AssistantGroupe[] };
  taille: { libelle: string; valeur: TaskSize; choix: ReadonlyArray<{ valeur: TaskSize; libelle: string }> };
  consigne: { libelle: string; aide: string; limite: string; valeur: string; max: number };
  recoit: { libelle: string; aide: string; texte: string };
  /** « IA de l'étape » : mode AVANCÉ seulement (D-eq-12) ; null en Simple, où l'IA est celle de l'assistant. */
  ia: { libelle: string; aide: string; valeur: Tier | null; choix: readonly ChoixIa[] } | null;
  /** [Retirer cet avis] ; null quand l'étape ne se retire pas (étape seule, synthèse, ou 2 avis restants). */
  retirer: string | null;
  problemes: readonly ProblemeAffiche[];
}

export interface BlockCardModel {
  blocId: string;
  /** « Bloc 2 · Des avis indépendants ». */
  titre: string;
  type: FlowBlock["type"];
  /** Phrase d'honnêteté de la forme (« Chaque avis ne voit pas le travail des autres. ») ; null pour une étape seule. */
  aide: string | null;
  monter: { libelle: string; possible: boolean };
  descendre: { libelle: string; possible: boolean };
  supprimer: string;
  dupliquer: { libelle: string; possible: boolean };
  /** Étapes du bloc, dans l'ordre d'écriture ; vide pour une pause. */
  etapes: readonly StepFormModel[];
  /** [Ajouter un avis] ; null hors d'un bloc d'avis ou quand la borne est atteinte. */
  ajouterAvis: string | null;
  /** Bloc « pause » : son message. */
  pause: { libelle: string; exemple: string; valeur: string; max: number } | null;
  problemes: readonly ProblemeAffiche[];
}

export interface AjoutModel {
  libelle: string;
  choix: ReadonlyArray<{ type: FlowBlock["type"]; libelle: string; possible: boolean }>;
}

export interface Ecran2Model {
  blocs: readonly BlockCardModel[];
  ajouter: AjoutModel;
  annuler: { libelle: string; possible: boolean };
  retablir: { libelle: string; possible: boolean };
}

export interface LigneCout {
  stepId: string;
  etape: string;
  assistant: string;
  ia: string;
  typique: string;
  maximum: string;
}

export interface Ecran3Model {
  titre: string;
  colonnes: readonly string[];
  lignes: readonly LigneCout[];
  /** « Total : ≈ … $ en général · … $ au plus (arrêt automatique) » ; null sans estimation. */
  total: string | null;
  arret: string;
  enGeneralAide: string;
  plafondAide: string;
}

export interface Ecran4Model {
  nom: { libelle: string; exemple: string; valeur: string; min: number; max: number; erreur: string | null };
  quand: { libelle: string; aide: string; valeur: string; max: number };
  liste: readonly string[];
  droits: { titre: string; lignes: readonly RightLine[] };
  controle: { titre: string; texte: string };
  decide: { titre: string; texte: string };
  pasGaranti: string;
  confidentialite: string;
  honnetete: readonly string[];
  enregistrer: string;
  /** Enregistrement possible : aucun problème bloquant et un nom acceptable. */
  enregistrable: boolean;
  /**
   * Phrase du refus d'enregistrement, rendue juste au-dessus du bouton : « L'équipe n'a pas été enregistrée : {n} problèmes à
   * corriger. » quand l'aperçu en compte, la phrase du problème « vide » quand le brouillon n'a aucun bloc (aucun aperçu n'est
   * alors demandé, donc aucun problème du serveur n'arrive) ; null quand rien ne bloque.
   */
  refus: string | null;
}

export type EditorDisplay = "chargement" | "ferme" | "editeur";

export interface EditorModel {
  affichage: EditorDisplay;
  /** Titre de la page (« Nouvelle équipe » ou « Modifier l'équipe « … » »). */
  titre: string;
  /** Texte du §2.6 tant que les équipes sont fermées en Simple ; null sinon. */
  ferme: { texte: string } | null;
  /** « Revenir à l'onglet Équipes » : le lien de retour, ouvert comme fermé. */
  retour: string;
  /**
   * Un aperçu (POST /api/teams/preview) doit être demandé : FAUX tant que l'éditeur n'est pas monté (U1), et faux tant que le
   * brouillon n'a aucun bloc (rien à apercevoir : l'écran de départ ne demande rien).
   */
  apercuDemande: boolean;
  /**
   * Schéma du déroulé dessiné à côté (spéc. §5.3) : sur « Les étapes » et « Coût et plafond », où le déroulé se construit et se
   * chiffre. L'écran 1 montre le déroulé de chaque exemple sur sa carte, et l'écran 4 sa vue liste : le même schéma une seconde
   * fois n'y ajoute rien.
   */
  schemaACote: boolean;
  progression: ProgressionModel | null;
  precedent: string | null;
  suivant: string | null;
  ecran1: Ecran1Model | null;
  ecran2: Ecran2Model | null;
  ecran3: Ecran3Model | null;
  ecran4: Ecran4Model | null;
  /** Problèmes de l'équipe entière (bloc et étape nuls) : ils ne tiennent sur aucune carte. */
  problemes: readonly ProblemeAffiche[];
  /** Phrase d'une lecture ou d'un enregistrement refusé ; null sinon. */
  erreur: string | null;
  /** Confirmation de départ (« Quitter sans enregistrer l'équipe ? »), demandée seulement après une modification. */
  quitter: { titre: string; message: string; rester: string; quitter: string };
}

export interface EditorInput {
  mode: "nouvelle" | "modifier";
  advanced: boolean;
  /** `ouvertesEnSimple` de GET /api/teams ; null tant qu'aucune lecture n'a abouti. */
  ouvertesEnSimple: boolean | null;
  ecran: EcranId;
  historique: EditHistory;
  titre: string;
  description: string;
  /** Réponse de POST /api/teams/preview ; null tant qu'aucun aperçu n'est rendu (première frappe, aperçu en vol). */
  apercu: TeamPreviewResponse | null;
  /** Liste du déroulé calculée sur place (flowAsList de L36b) : la vérité du lecteur d'écran avant le premier aperçu. */
  liste: readonly string[];
  exemples: readonly TeamExampleView[];
  assistants: readonly EditorAssistantView[];
  /** Niveaux d'IA ; lus en mode Avancé seulement. */
  niveaux: readonly EditorTier[];
  /** Titres des AUTRES équipes installées : un nom déjà pris est refusé avant l'envoi. */
  nomsPris: readonly string[];
  /** Lecture en cours (équipe à modifier, liste des équipes). */
  chargement: boolean;
  erreur: string | null;
}

/** Phrase d'un problème, par code (T4t) ; un code hors de la liste est ignoré plutôt qu'affiché sans phrase. */
function problemesAffiches(problems: readonly FlowProblem[], garde: (probleme: FlowProblem) => boolean): ProblemeAffiche[] {
  const out: ProblemeAffiche[] = [];
  for (const probleme of problems) {
    if (!garde(probleme)) continue;
    const texte = Object.hasOwn(P.problemes, probleme.code) ? P.problemes[probleme.code as keyof typeof P.problemes] : null;
    if (texte !== null) out.push({ code: probleme.code, texte, bloquant: probleme.bloquant });
  }
  return out;
}

const TAILLES_CHOIX: ReadonlyArray<{ valeur: TaskSize; libelle: string }> = Object.freeze(
  TASK_SIZES.map((valeur) => ({ valeur, libelle: E.champs.tailles[valeur] })),
);

const AIDES_BLOC: Readonly<Record<FlowBlock["type"], string | null>> = {
  etape: null,
  avis: P.honnetete.avis,
  // <c5:aides-formes>
  // Branche minimale (L42a) : aucune aide propre aux formes de la 5b tant que l'éditeur guidé ne les propose pas (L42d).
  relecture: null,
  aiguillage: null,
  // </c5:aides-formes>
  pause: P.pauses.verification.gratuite,
};

function stepForm(
  step: FlowStep,
  role: StepFormModel["role"],
  input: EditorInput,
  groupes: readonly AssistantGroupe[],
  retirer: string | null,
): StepFormModel {
  const simple = !input.advanced;
  const assistant = input.assistants.find((a) => a.name === step.assistant) ?? null;
  const recoitChoix = E.champs.recoitChoix;
  return {
    stepId: step.id,
    role,
    titre: { libelle: E.champs.titre, aide: E.champs.titreAide, valeur: step.titre, max: TEAM_TEXT_LIMITS.titreEtape.max },
    assistant: { libelle: E.champs.assistant, valeur: step.assistant, groupes },
    taille: { libelle: E.champs.taille, valeur: step.taille, choix: TAILLES_CHOIX },
    consigne: {
      libelle: E.champs.consigne,
      aide: E.champs.consigneAide,
      // Q6 (a) : la limite du plancher ETAPE est documentée dans l'aide de l'éditeur, par la phrase de T4t.
      limite: E.champs.limiteSortie,
      valeur: step.consigne,
      max: FLOW_LIMITS.consigne,
    },
    recoit: {
      libelle: E.champs.recoit,
      aide: E.champs.recoitAide,
      // <c5:recoit-etapes>
      // Branche minimale (L42a) : `recoit: {etapes}` (mode Avancé) n'a pas de libellé dans l'éditeur guidé de l'itération 4 ;
      // la case « Le résultat d'étapes choisies » et la liste des étapes arrivent avec L42d.
      texte: isStepInputName(step.recoit) && Object.hasOwn(recoitChoix, step.recoit) ? recoitChoix[step.recoit] : "",
      // </c5:recoit-etapes>
    },
    // D-eq-12 : aucun réglage d'IA par étape en mode Simple.
    ia: simple
      ? null
      : {
          libelle: TEXTES.avance.editeurIa.libelle,
          aide: TEXTES.avance.editeurIa.aide,
          valeur: step.niveau,
          choix: choixIaEtape(step, input.niveaux, assistant?.modelName ?? null),
        },
    retirer,
    problemes: problemesAffiches(input.apercu?.problems ?? [], (probleme) => probleme.etape === step.id),
  };
}

function blockCard(block: FlowBlock, index: number, input: EditorInput, groupes: readonly AssistantGroupe[]): BlockCardModel {
  const draft = input.historique.present;
  const forme = E.blocs[block.type];
  const retraitPossible = block.type === "avis" && peutRetirerAvis(draft, block.id);
  const etapes: StepFormModel[] = [];
  if (block.type === "etape") etapes.push(stepForm(block.etape, "etape", input, groupes, null));
  else if (block.type === "avis") {
    for (const avis of block.avis) etapes.push(stepForm(avis, "avis", input, groupes, retraitPossible ? E.retirerAvis : null));
    etapes.push(stepForm(block.synthese, "synthese", input, groupes, null));
  }
  return {
    blocId: block.id,
    titre: remplir(E.bloc, { n: index + 1, forme }),
    type: block.type,
    aide: AIDES_BLOC[block.type],
    monter: { libelle: E.monter, possible: index > 0 },
    descendre: { libelle: E.descendre, possible: index < draft.flow.blocs.length - 1 },
    supprimer: E.supprimer,
    dupliquer: { libelle: P.onglet.installees.dupliquer, possible: peutDupliquer(draft, block.id) },
    etapes,
    ajouterAvis: block.type === "avis" && peutAjouterAvis(draft, block.id) ? E.ajouterAvis : null,
    pause:
      block.type === "pause"
        ? { libelle: E.champs.pause, exemple: E.champs.pauseExemple, valeur: block.message, max: TEAM_TEXT_LIMITS.messagePause }
        : null,
    problemes: problemesAffiches(input.apercu?.problems ?? [], (probleme) => probleme.bloc === block.id && probleme.etape === null),
  };
}

function ecran1(input: EditorInput): Ecran1Model {
  return {
    partirExemple: E.partirExemple,
    partirForme: E.partirForme,
    exemples: input.exemples.map((exemple) => ({
      id: exemple.id,
      titre: exemple.titre,
      description: exemple.description,
      liste: exemple.liste,
      layout: exemple.layout,
    })),
    formes: FORMES_DEPART.map((id) => ({ id, titre: P.formes[id], aide: P.aidesFormes[id] })),
  };
}

function ecran2(input: EditorInput): Ecran2Model {
  const draft = input.historique.present;
  const groupes = assistantsProposables(input.assistants, { simple: !input.advanced });
  return {
    blocs: draft.flow.blocs.map((block, index) => blockCard(block, index, input, groupes)),
    ajouter: {
      libelle: E.ajouter,
      choix: BLOCS_AJOUTABLES.map((type) => ({ type, libelle: E.blocs[type], possible: peutAjouterBloc(draft, type) })),
    },
    annuler: { libelle: E.annulerModif, possible: peutAnnuler(input.historique) },
    retablir: { libelle: E.retablir, possible: peutRetablir(input.historique) },
  };
}

/** Nom lisible de l'IA d'une étape estimée ; chaîne vide quand elle est inconnue (la cellule reste vide, sans mot inventé). */
function iaDe(ligne: StepEstimate): string {
  return ligne.modelLabel ?? ligne.model ?? "";
}

/**
 * Montant d'une cellule du tableau : la valeur écrite par montant() (« 0,60 », « < 0,01 », « — » quand le prix est inconnu)
 * suivie du symbole du dollar, comme tous les gabarits de montant de T4t (« {montant} $ »). Aucun chiffre n'est inventé.
 */
const cellule = (usd: number | null): string => `${montant(usd ?? Number.NaN)} $`;

function ecran3(input: EditorInput): Ecran3Model {
  const estimate = input.apercu?.estimate ?? null;
  const cout = E.cout;
  return {
    titre: cout.titre,
    colonnes: [cout.colonneEtape, cout.colonneAssistant, cout.colonneIa, cout.colonneEnGeneral, cout.colonneEstimationHaute],
    lignes: (estimate?.parEtape ?? []).map((ligne): LigneCout => ({
      stepId: ligne.stepId,
      etape: ligne.titre,
      assistant: ligne.assistant,
      ia: iaDe(ligne),
      typique: cellule(ligne.typique),
      maximum: cellule(ligne.maximum),
    })),
    total: estimate === null ? null : remplir(cout.total, { typique: estimate.typique, maximum: estimate.maximum }),
    arret: cout.arret,
    enGeneralAide: cout.enGeneralAide,
    plafondAide: E.plafondAide,
  };
}

/** Nom refusé : trop court, ou déjà porté par une autre équipe. */
function erreurNom(titre: string, nomsPris: readonly string[]): string | null {
  const propre = titre.trim();
  if (propre.length < TEAM_TEXT_LIMITS.titreEquipe.min) return E.verifier.nomCourt;
  if (nomsPris.some((nom) => nom.trim().toLocaleLowerCase("fr") === propre.toLocaleLowerCase("fr"))) return E.verifier.nomPris;
  return null;
}

function ecran4(input: EditorInput): Ecran4Model {
  const verifier = E.verifier;
  const bloquants = (input.apercu?.problems ?? []).filter((probleme) => probleme.bloquant);
  const erreur = erreurNom(input.titre, input.nomsPris);
  // Brouillon SANS aucun bloc : `apercuDemande` est faux, donc aucun problème du serveur n'arrive et le bouton serait désactivé
  // sans que rien n'explique pourquoi. La phrase du problème « vide » (T4t) est posée ici, là où l'utilisateur regarde.
  const vide = input.apercu === null && input.historique.present.flow.blocs.length === 0;
  return {
    nom: {
      libelle: verifier.nom,
      exemple: verifier.nomExemple,
      valeur: input.titre,
      min: TEAM_TEXT_LIMITS.titreEquipe.min,
      max: TEAM_TEXT_LIMITS.titreEquipe.max,
      erreur,
    },
    quand: { libelle: verifier.quand, aide: verifier.quandAide, valeur: input.description, max: TEAM_TEXT_LIMITS.description },
    // Liste du serveur quand l'aperçu est là, sinon celle calculée sur place : l'écran ne reste jamais muet pour le lecteur d'écran.
    liste: input.apercu?.liste ?? input.liste,
    droits: { titre: verifier.droits, lignes: input.apercu?.droits ?? [] },
    controle: { titre: verifier.controle, texte: verifier.controleTexte },
    decide: { titre: verifier.decide, texte: verifier.decideTexte },
    pasGaranti: verifier.pasGaranti,
    confidentialite: verifier.confidentialite,
    honnetete: [P.honnetete.etapes, P.honnetete.cles, P.honnetete.lecture],
    enregistrer: verifier.enregistrer,
    // AUCUNE case contractuelle : en itération 4, aucune étape ne propose de modification (D-eq-11, `propose` refusé).
    enregistrable: bloquants.length === 0 && erreur === null && input.apercu !== null,
    refus: bloquants.length > 0 ? refusEnregistrement(bloquants.length) : vide ? P.problemes.vide : null,
  };
}

const QUITTER = Object.freeze({
  titre: E.quitter.titre,
  message: E.quitter.message,
  rester: E.quitter.rester,
  quitter: E.quitter.quitter,
});

/**
 * Modèle de l'éditeur. L'ordre des contrôles est celui du §2.6 : lecture en cours → « chargement » ; équipes fermées en Simple
 * → « ferme » (aucun écran, aucun aperçu) ; sinon les 4 écrans.
 */
export function buildEditor(input: EditorInput): EditorModel {
  const base = {
    titre: input.mode === "nouvelle" ? E.titreNouvelle : remplir(E.titreModifier, { titre: input.titre }),
    ferme: null,
    retour: E.retourEquipes,
    apercuDemande: false,
    schemaACote: false,
    progression: null,
    precedent: null,
    suivant: null,
    ecran1: null,
    ecran2: null,
    ecran3: null,
    ecran4: null,
    problemes: [],
    erreur: null,
    quitter: QUITTER,
  } satisfies Omit<EditorModel, "affichage">;

  // Rien de lu : l'éditeur attend plutôt que de se monter, puis de disparaître si les équipes sont fermées en Simple. Une
  // lecture qui a échoué laisse sa phrase visible sur le même écran d'attente ; `chargement` dit seulement si elle continue.
  if (input.ouvertesEnSimple === null) return { ...base, affichage: "chargement", erreur: input.chargement ? null : input.erreur };
  if (!input.advanced && !input.ouvertesEnSimple) {
    return { ...base, affichage: "ferme", ferme: { texte: TEXTES.simple.fermees } };
  }

  return {
    ...base,
    affichage: "editeur",
    apercuDemande: input.historique.present.flow.blocs.length > 0,
    schemaACote: input.ecran === 2 || input.ecran === 3,
    progression: progressionDe(input.ecran),
    precedent: input.ecran === 1 ? null : E.precedent,
    suivant: input.ecran === 4 ? null : E.suivant,
    ecran1: input.ecran === 1 ? ecran1(input) : null,
    ecran2: input.ecran === 2 ? ecran2(input) : null,
    ecran3: input.ecran === 3 ? ecran3(input) : null,
    ecran4: input.ecran === 4 ? ecran4(input) : null,
    problemes: problemesAffiches(input.apercu?.problems ?? [], (probleme) => probleme.bloc === null && probleme.etape === null),
    erreur: input.erreur,
  };
}

/**
 * Identifiant d'une équipe NEUVE, tiré de son nom (TEAM_ID_RE : ^[a-z0-9-]{1,40}$) : le nom mis en minuscules sans accent, puis
 * « -2 », « -3 »… tant qu'il est déjà pris. Une équipe MODIFIÉE garde le sien : un identifiant déjà écrit dans un lancement passé
 * ne doit jamais désigner une autre équipe. Un nom sans aucune lettre ni chiffre (émojis seuls) rend « equipe ».
 */
export function identifiantEquipe(titre: string, pris: Iterable<string>): string {
  const base = slugifyName(titre, TEAM_ID_MAX);
  const utilise = new Set(pris);
  const candidat = base === "assistant" && !/[a-z0-9]/i.test(titre.normalize("NFD").replace(/\p{Diacritic}/gu, "")) ? "equipe" : base;
  if (!utilise.has(candidat)) return candidat;
  for (let n = 2; ; n++) {
    const suffixe = `-${n}`;
    const suivant = `${candidat.slice(0, TEAM_ID_MAX - suffixe.length).replace(/-+$/g, "")}${suffixe}`;
    if (!utilise.has(suivant)) return suivant;
  }
}

/** Corps de PUT /api/teams/:id composé du brouillon (titre ébarbé, déroulé tel quel). */
export function corpsEnregistrement(input: { titre: string; description: string; draft: FlowDraft }): {
  titre: string;
  description: string;
  flow: Flow;
} {
  return {
    titre: input.titre.trim().slice(0, TEAM_TEXT_LIMITS.titreEquipe.max),
    description: input.description.slice(0, TEAM_TEXT_LIMITS.description),
    flow: input.draft.flow,
  };
}
