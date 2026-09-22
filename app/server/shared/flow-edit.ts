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
// FORMES DE LA 5b (L42d, plan d'exécution it5 fiche L42d ; spécification §5.3 l.896-903 ; C §8.1, §9.11, §10) : « relecture » et
// « aiguillage » sont proposés à CÔTÉ des formes de l'itération 4, jamais à leur place — `BLOCS_AJOUTABLES`, `FORMES_DEPART`,
// `ajouterBloc`, `Ecran1Model.formes` et `Ecran2Model.ajouter` gardent exactement ce que l'itération 4 y met, et les entrées de
// la 5b vivent dans des valeurs et des champs À PART (`BLOCS_AJOUTABLES_C5`, `FORMES_C5`, `ajouterBlocC5`, `Ecran1Model.formesC5`,
// `Ecran2Model.formes`). Un genre de la 5b passé à `ajouterBloc` rend donc toujours le brouillon tel quel.
// Aucun TYPE n'est touché par L42d : `FlowStep.methodes`, `recoit: {etapes}`, les deux genres de bloc et leurs bornes viennent de
// L42a (`team-types.ts`, `team-limits.ts`), et la grammaire qui les juge de `flow.ts` (L42a) — ce module n'en réécrit aucune.
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
// <c5:import-l42d>
// L42d : les phrases des formes de la 5b, de leurs réglages et des méthodes d'étape sont dans construction-texts.ts (§4.3) et
// non dans team-texts.ts — flow-layout.ts (L42a) le fait déjà pour « Reçoit le résultat de : {etapes} », et le croisement de V0
// de l'itération 4 fige les clés de team-texts.ts. `MethodView` n'apporte qu'un TYPE : le catalogue est fourni par l'appelant.
import { TEXTES as CONSTRUCTION_TEXTES } from "./construction-texts.ts";
import type { MethodView } from "./construction-types.ts";
// </c5:import-l42d>
import { FLOW_LIMITS, FLOW_VERSION, isStepInputName, stepInputEtapes, TEAM_TEXT_LIMITS } from "./team-limits.ts";
import { montant, refusEnregistrement, remplir, TEXTES } from "./team-texts.ts";
import type {
  Flow,
  FlowBlock,
  FlowProblem,
  FlowRow,
  FlowStep,
  PlannedRole,
  StepEstimate,
  StepInput,
  TeamExampleView,
  TeamPreviewResponse,
} from "./team-types.ts";

const P = TEXTES.partout;
const E = P.editeur;
// <c5:textes-l42d>
/** Textes de la construction lus ici (L42d) : formes de la 5b, champs de l'éditeur, problèmes et lignes du tableau de coût. */
const C5 = CONSTRUCTION_TEXTES.partout;
/** Bascule « Étapes | Schéma modifiable » et phrase des écrans étroits (mode Avancé seulement, §4.3). */
const C5_SCHEMA = CONSTRUCTION_TEXTES.avance.schema;
// </c5:textes-l42d>

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

// <c5:formes-l42d>
/**
 * Genres de bloc ajoutés par la 5b (L42d). Liste SÉPARÉE de `BLOCS_AJOUTABLES` : les entrées de l'itération 4 ne bougent pas,
 * et `ajouterBloc` continue de refuser un genre de la 5b (c'est `ajouterBlocC5` qui les pose, avec la règle « en tête seulement »
 * de l'aiguillage). L'ordre est celui du menu : « Une rédaction et relecture », puis « Un aiguillage ».
 */
export const BLOCS_AJOUTABLES_C5: readonly ["relecture", "aiguillage"] = Object.freeze(["relecture", "aiguillage"]) as readonly [
  "relecture",
  "aiguillage",
];

/** Formes de départ ajoutées par la 5b, dans l'ordre de l'écran 1 : elles s'affichent à la suite de `FORMES_DEPART`. */
export const FORMES_C5: readonly ["relecture", "aiguillage"] = BLOCS_AJOUTABLES_C5;

export type FormeC5 = (typeof FORMES_C5)[number];

/** Toutes les formes que l'écran 1 propose : les deux de l'itération 4, puis les deux de la 5b. */
export type FormeEditeur = FormeDepart | FormeC5;

/**
 * Largeur en dessous de laquelle le schéma modifiable n'est PAS rendu (spécification §5.3 l.903) : la phrase « Le schéma
 * modifiable demande un écran plus large : utilisez les étapes. » prend sa place, et les étapes restent le chemin complet.
 * Le nombre vit ici, jamais dans un `.tsx` : l'interface lit `Ecran2Model.vue.etroit`, calculé par le modèle.
 */
export const SCHEMA_LARGEUR_MIN = 900;

/** Vue de l'écran 2 (mode Avancé) : les étapes guidées, ou l'emplacement du schéma modifiable (L43). */
export type VueEtapes = "etapes" | "schema";
// </c5:formes-l42d>

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

// <c5:copie-etape>
/**
 * Copie d'une étape (L42d). Le tableau `methodes` (5b, L42a) est RECOPIÉ : `{ ...step }` le partagerait entre deux états de
 * l'historique, et cocher une méthode se verrait dans l'état d'avant, que [Annuler] est censé rendre intact.
 */
function copierEtape(step: FlowStep): FlowStep {
  return { ...step, ...(step.methodes === undefined ? {} : { methodes: [...step.methodes] }) };
}
// </c5:copie-etape>

/** Copie profonde d'un déroulé : l'historique garde des états entiers, jamais un objet partagé avec l'état courant. */
function copierFlow(flow: Flow): Flow {
  return {
    version: FLOW_VERSION,
    blocs: flow.blocs.map((block): FlowBlock => {
      if (block.type === "etape") return { type: "etape", id: block.id, etape: copierEtape(block.etape) };
      if (block.type === "avis") {
        return { type: "avis", id: block.id, avis: block.avis.map(copierEtape), synthese: copierEtape(block.synthese) };
      }
      if (block.type === "pause") return { type: "pause", id: block.id, message: block.message };
      // <c5:copie-formes>
      // L42d : copie CHAMP PAR CHAMP des formes de la 5b, comme pour celles de l'itération 4 — sans quoi l'historique
      // annuler / rétablir garderait des étapes partagées entre deux états, et une frappe dans le rédacteur se verrait dans
      // l'état précédent. `methodes` est un tableau : il est recopié, jamais partagé.
      if (block.type === "relecture") {
        return {
          type: "relecture",
          id: block.id,
          auteur: copierEtape(block.auteur),
          relecteur: copierEtape(block.relecteur),
          toursMax: block.toursMax,
          pauseAvantRelecture: block.pauseAvantRelecture,
        };
      }
      return {
        type: "aiguillage",
        id: block.id,
        aiguilleur: copierEtape(block.aiguilleur),
        specialistes: block.specialistes.map(copierEtape),
        choixMax: block.choixMax,
        synthese: block.synthese === null ? null : copierEtape(block.synthese),
        ...(block.repli === undefined ? {} : { repli: block.repli }),
      };
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
    // L42d : entrées des formes de la 5b, exactement celles que la grammaire impose (flow.ts, ATTENDU_PAR_ROLE) — relecteur
    // « precedent », aiguilleur et spécialistes « demande », synthèse d'un aiguillage « tous ». Seul le RÉDACTEUR a un choix,
    // le même qu'une étape : « demande » à la tête, sinon sa valeur est gardée (« precedent », « tous », ou les étapes choisies
    // du mode Avancé), et une « demande » héritée d'un déplacement redevient « precedent ».
    else if (block.type === "relecture") {
      if (premier) block.auteur.recoit = "demande";
      else if (block.auteur.recoit === "demande") block.auteur.recoit = "precedent";
      block.relecteur.recoit = "precedent";
    } else if (block.type === "aiguillage") {
      block.aiguilleur.recoit = "demande";
      for (const specialiste of block.specialistes) specialiste.recoit = "demande";
      if (block.synthese !== null) block.synthese.recoit = "tous";
    }
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

// <c5:ajout-formes-l42d>

/** Étapes qu'un bloc de la 5b ajoute : rédacteur et relecteur ; aiguilleur et 2 spécialistes (la synthèse vient avec 2 choix). */
function etapesAjouteesC5(type: FormeC5): number {
  return type === "relecture" ? 2 : 1 + FLOW_LIMITS.specialistesMin;
}

/**
 * Bloc neuf d'une forme de la 5b. Les titres partent VIDES, comme ceux de l'itération 4 : la grammaire pose alors son problème
 * « Donnez à l'étape un titre… » sur chaque étape, qui est l'invite. Seule la synthèse porte son titre de rôle (T4t).
 * Valeurs de départ : 1 tour, aucune pause avant la relecture, 1 spécialiste à consulter au plus et donc aucune synthèse —
 * « Synthèse » est EXIGÉE à 2 (flow.ts, `synthese-requise`), et `modifierChoixMax` la pose en passant à 2.
 */
function blocNeufC5(draft: FlowDraft, type: FormeC5): { block: FlowBlock; compteur: number } {
  const compteurBloc = draft.compteur + 1;
  const id = identifiant("b", compteurBloc);
  if (type === "relecture") {
    const auteur = etapeNeuve({ ...draft, compteur: compteurBloc }, "precedent");
    const relecteur = etapeNeuve({ ...draft, compteur: auteur.compteur }, "precedent");
    return {
      block: { type: "relecture", id, auteur: auteur.step, relecteur: relecteur.step, toursMax: 1, pauseAvantRelecture: false },
      compteur: relecteur.compteur,
    };
  }
  const aiguilleur = etapeNeuve({ ...draft, compteur: compteurBloc }, "demande");
  let compteur = aiguilleur.compteur;
  const specialistes: FlowStep[] = [];
  for (let i = 0; i < FLOW_LIMITS.specialistesMin; i++) {
    const neuve = etapeNeuve({ ...draft, compteur }, "demande");
    compteur = neuve.compteur;
    specialistes.push(neuve.step);
  }
  return { block: { type: "aiguillage", id, aiguilleur: aiguilleur.step, specialistes, choixMax: 1, synthese: null }, compteur };
}

/** Le déroulé contient déjà un aiguillage : un second ne pourrait pas être le premier bloc (flow.ts, `aiguillage-premier`). */
const aUnAiguillage = (flow: Flow): boolean => flow.blocs.some((block) => block.type === "aiguillage");

/**
 * L'ajout d'une forme de la 5b à la place `index` est possible. Deux règles, et rien d'autre :
 * - les bornes de l'itération 4 (5 blocs de travail, 12 étapes), comme pour tout bloc ;
 * - un AIGUILLAGE ne s'insère qu'EN TÊTE (`index` 0) et une seule fois : la grammaire n'en accepte qu'un, et seulement comme
 *   premier bloc. L'entrée du menu reste visible ailleurs, désactivée, plutôt que de disparaître sans explication.
 */
export function peutAjouterBlocC5(draft: FlowDraft, type: FormeC5, index: number): boolean {
  if (type === "aiguillage" && (Math.trunc(index) !== 0 || aUnAiguillage(draft.flow))) return false;
  const travail = compterBlocsTravail(draft.flow) + 1;
  return travail <= FLOW_LIMITS.blocsTravail && compterEtapes(draft.flow) + etapesAjouteesC5(type) <= FLOW_LIMITS.etapes;
}

/**
 * Ajout d'une forme de la 5b à la position `index`. Refusé — le brouillon est rendu TEL QUEL — quand `peutAjouterBlocC5` dit
 * non : [Annuler] ne rend alors jamais un état identique au précédent (`appliquer`).
 */
export function ajouterBlocC5(draft: FlowDraft, type: FormeC5, index: number): FlowDraft {
  if (!BLOCS_AJOUTABLES_C5.includes(type) || !peutAjouterBlocC5(draft, type, index)) return draft;
  const place = Math.max(0, Math.min(Math.trunc(index), draft.flow.blocs.length));
  const { block, compteur } = blocNeufC5(draft, type);
  const blocs = copierFlow(draft.flow).blocs;
  blocs.splice(place, 0, block);
  return poser(draft, { version: FLOW_VERSION, blocs }, compteur);
}

/** Un spécialiste de plus dans ce bloc : 8 au plus (FLOW_LIMITS.specialistesMax) et 12 étapes au plus. */
export function peutAjouterSpecialiste(draft: FlowDraft, blocId: string): boolean {
  const block = draft.flow.blocs.find((b) => b.id === blocId);
  if (!block || block.type !== "aiguillage") return false;
  return block.specialistes.length < FLOW_LIMITS.specialistesMax && compterEtapes(draft.flow) + 1 <= FLOW_LIMITS.etapes;
}

/** Un spécialiste de moins : 2 au moins (FLOW_LIMITS.specialistesMin ; « Proposez de 2 à 8 spécialistes. »). */
export function peutRetirerSpecialiste(draft: FlowDraft, blocId: string): boolean {
  const block = draft.flow.blocs.find((b) => b.id === blocId);
  return !!block && block.type === "aiguillage" && block.specialistes.length > FLOW_LIMITS.specialistesMin;
}

export function ajouterSpecialiste(draft: FlowDraft, blocId: string): FlowDraft {
  if (!peutAjouterSpecialiste(draft, blocId)) return draft;
  const flow = copierFlow(draft.flow);
  const block = flow.blocs.find((b) => b.id === blocId);
  if (!block || block.type !== "aiguillage") return draft;
  const { step, compteur } = etapeNeuve(draft, "demande");
  block.specialistes.push(step);
  return poser(draft, flow, compteur);
}

export function retirerSpecialiste(draft: FlowDraft, blocId: string, stepId: string): FlowDraft {
  if (!peutRetirerSpecialiste(draft, blocId)) return draft;
  const flow = copierFlow(draft.flow);
  const block = flow.blocs.find((b) => b.id === blocId);
  if (!block || block.type !== "aiguillage" || !block.specialistes.some((step) => step.id === stepId)) return draft;
  block.specialistes = block.specialistes.filter((step) => step.id !== stepId);
  return poser(draft, flow, draft.compteur);
}

/** « Nombre de tours au maximum » : 1 ou 2 (FLOW_LIMITS.toursMax), jamais davantage. */
export function modifierTours(draft: FlowDraft, blocId: string, tours: 1 | 2): FlowDraft {
  const flow = copierFlow(draft.flow);
  const block = flow.blocs.find((b) => b.id === blocId);
  if (!block || block.type !== "relecture" || block.toursMax === tours || tours < 1 || tours > FLOW_LIMITS.toursMax) return draft;
  block.toursMax = tours;
  return poser(draft, flow, draft.compteur);
}

/** « Me laisser vérifier le premier jet avant la relecture » : une pause après le premier jet, au tour 1 seulement. */
export function modifierPauseAvantRelecture(draft: FlowDraft, blocId: string, valeur: boolean): FlowDraft {
  const flow = copierFlow(draft.flow);
  const block = flow.blocs.find((b) => b.id === blocId);
  if (!block || block.type !== "relecture" || block.pauseAvantRelecture === valeur) return draft;
  block.pauseAvantRelecture = valeur;
  return poser(draft, flow, draft.compteur);
}

/**
 * « Spécialistes à consulter au plus » : 1 ou 2 (FLOW_LIMITS.choixMax). À 2, la SYNTHÈSE est exigée (flow.ts,
 * `synthese-requise`) : elle est posée ici, avec son titre de rôle, quand le déroulé a encore la place pour une étape. Sans
 * cette place, `choixMax` change quand même et la grammaire pose son problème sur le bloc — rien n'est caché.
 * Passer de 2 à 1 GARDE la synthèse : elle reste valide avec un seul spécialiste, et la retirer effacerait un travail réglé.
 */
export function modifierChoixMax(draft: FlowDraft, blocId: string, choixMax: 1 | 2): FlowDraft {
  const flow = copierFlow(draft.flow);
  const block = flow.blocs.find((b) => b.id === blocId);
  if (!block || block.type !== "aiguillage" || choixMax < 1 || choixMax > FLOW_LIMITS.choixMax) return draft;
  const posableSynthese = choixMax === 2 && block.synthese === null && compterEtapes(draft.flow) + 1 <= FLOW_LIMITS.etapes;
  if (block.choixMax === choixMax && !posableSynthese) return draft;
  block.choixMax = choixMax;
  if (!posableSynthese) return poser(draft, flow, draft.compteur);
  const synthese = etapeNeuve(draft, "tous", E.synthese);
  block.synthese = synthese.step;
  return poser(draft, flow, synthese.compteur);
}

// </c5:ajout-formes-l42d>

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
    // c5 (L42d) : copierEtape recopie aussi `methodes`, que `{ ...step }` partagerait entre l'original et sa copie.
    return { ...copierEtape(step), id: identifiant("e", compteur) };
  };
  let copie: FlowBlock;
  if (original.type === "etape") copie = { type: "etape", id: copieId, etape: copieEtape(original.etape) };
  else if (original.type === "avis") {
    copie = { type: "avis", id: copieId, avis: original.avis.map(copieEtape), synthese: copieEtape(original.synthese) };
  } else if (original.type === "pause") copie = { type: "pause", id: copieId, message: original.message };
  // <c5:duplication-formes>
  // L42d : une forme de la 5b se duplique comme celles de l'itération 4 — la COPIE reçoit des identifiants d'étape neufs, et
  // l'original garde les siens. `repli` (assistant proposé quand aucun spécialiste ne convient) suit la copie tel quel.
  else if (original.type === "relecture") {
    copie = {
      type: "relecture",
      id: copieId,
      auteur: copieEtape(original.auteur),
      relecteur: copieEtape(original.relecteur),
      toursMax: original.toursMax,
      pauseAvantRelecture: original.pauseAvantRelecture,
    };
  } else {
    copie = {
      type: "aiguillage",
      id: copieId,
      aiguilleur: copieEtape(original.aiguilleur),
      specialistes: original.specialistes.map(copieEtape),
      choixMax: original.choixMax,
      synthese: original.synthese === null ? null : copieEtape(original.synthese),
      ...(original.repli === undefined ? {} : { repli: original.repli }),
    };
  }
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

// <c5:etape-l42d>

/** Étape du brouillon, par identifiant ; null quand elle n'existe pas (identifiant venu d'un rendu périmé). */
function etapeDe(flow: Flow, stepId: string): FlowStep | null {
  for (const block of flow.blocs) {
    for (const step of etapesDe(block)) if (step.id === stepId) return step;
  }
  return null;
}

/**
 * Méthodes « consigne » d'une étape (5b, L42a) : FLOW_LIMITS.methodesParEtape au plus, sans doublon, dans l'ordre reçu.
 * Une liste VIDE retire le champ plutôt que d'écrire `[]` : un déroulé sans méthode reste celui que l'itération 4 enregistrait,
 * à l'octet près (aucune migration, A2). Une liste identique rend le brouillon TEL QUEL.
 */
export function modifierMethodes(draft: FlowDraft, stepId: string, methodes: readonly string[]): FlowDraft {
  const flow = copierFlow(draft.flow);
  const step = etapeDe(flow, stepId);
  if (step === null) return draft;
  const propres = [...new Set(methodes)].slice(0, FLOW_LIMITS.methodesParEtape);
  const avant = step.methodes ?? [];
  if (propres.length === avant.length && propres.every((id, rang) => id === avant[rang])) return draft;
  if (propres.length === 0) delete step.methodes;
  else step.methodes = propres;
  return poser(draft, flow, draft.compteur);
}

/**
 * « Le résultat d'étapes choisies » (mode AVANCÉ, `recoit: {etapes}` de L42a) : `etapes` non vide écrit le lien, `null` ou une
 * liste vide rend l'étape à la valeur par défaut de sa place (« precedent », réparée ensuite par `reglerEntrees` si la place a
 * changé). L'ordre et les doublons sont nettoyés ici ; ce que la grammaire accepte reste jugé par `validateFlow` (L42a), qui
 * pose `lien-arriere`, `lien-avis` ou `lien-avance` sur l'étape fautive.
 */
export function modifierRecoitEtapes(draft: FlowDraft, stepId: string, etapes: readonly string[] | null): FlowDraft {
  const flow = copierFlow(draft.flow);
  const step = etapeDe(flow, stepId);
  if (step === null) return draft;
  const propres = etapes === null ? [] : [...new Set(etapes)];
  const avant = stepInputEtapes(step.recoit);
  if (propres.length === 0) {
    if (avant === null) return draft;
    step.recoit = "precedent";
    return poser(draft, flow, draft.compteur);
  }
  if (avant !== null && avant.length === propres.length && propres.every((id, rang) => id === avant[rang])) return draft;
  step.recoit = { etapes: propres };
  return poser(draft, flow, draft.compteur);
}

// </c5:etape-l42d>

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
 * c5 (L42d) : « Rédaction et relecture » = un bloc de relecture ; « Aiguillage » = un bloc d'aiguillage, seul, donc en tête.
 * Les quatre formes tiennent dans les bornes.
 */
export function brouillonDeForme(forme: FormeEditeur): FlowDraft {
  // <c5:depart-formes>
  if (forme === "relecture" || forme === "aiguillage") return ajouterBlocC5(brouillonVide(), forme, 0);
  // </c5:depart-formes>
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
  // <c5:ecran1-formes>
  /**
   * Formes de la 5b (L42d), rendues à la SUITE de `formes` sous le même titre « Partir d'une forme » : les deux y sont
   * activées, chacune avec sa phrase d'aide. Champ séparé pour que `formes` garde exactement les deux formes de l'itération 4.
   */
  formesC5: readonly FormeCarteC5[];
  // </c5:ecran1-formes>
}

// <c5:carte-forme-c5>
/** Carte d'une forme de la 5b : son titre, sa phrase d'aide et, pour la relecture, la phrase qui dit ce qu'est un tour. */
export interface FormeCarteC5 {
  id: FormeC5;
  titre: string;
  aide: string;
  /** Deuxième phrase d'aide (« Un tour = une relecture, puis une correction si nécessaire. ») ; null pour l'aiguillage. */
  precision: string | null;
}
// </c5:carte-forme-c5>

/** Problème affiché sur un bloc ou une étape : sa phrase, et s'il bloque l'enregistrement. */
export interface ProblemeAffiche {
  code: string;
  texte: string;
  bloquant: boolean;
}

// <c5:methode-etape>
/**
 * Puce d'une méthode « consigne » dans le formulaire d'étape (L42d) : la méthode reste LISIBLE même refusée, avec sa raison —
 * jamais retirée en silence, comme les assistants indisponibles. Les deux raisons sont celles du §4.3 :
 * « Déjà appliquée par l'assistant. » et « 2 méthodes au maximum par étape. ».
 */
export interface MethodeEtapeOption {
  id: string;
  titre: string;
  choisie: boolean;
  desactivee: boolean;
  /** Phrase du refus ; null quand la méthode peut être cochée ou décochée. */
  raison: string | null;
}

/** Une étape d'un bloc antérieur, proposée à « Le résultat d'étapes choisies » (mode Avancé). */
export interface LienEtapeOption {
  stepId: string;
  libelle: string;
  cochee: boolean;
}
// </c5:methode-etape>

export interface StepFormModel {
  stepId: string;
  /**
   * Rôle de l'étape dans son bloc : une synthèse ne se retire pas.
   * c5 (L42d) : les quatre rôles des formes de la 5b s'ajoutent aux trois de l'itération 4 (mêmes noms que PlannedRole).
   */
  role: PlannedRole;
  /** `max` : borne de saisie du champ, comme la consigne et le message de pause (jamais un nombre écrit dans le .tsx). */
  titre: { libelle: string; aide: string; valeur: string; max: number };
  assistant: { libelle: string; valeur: string; groupes: readonly AssistantGroupe[] };
  taille: { libelle: string; valeur: TaskSize; choix: ReadonlyArray<{ valeur: TaskSize; libelle: string }> };
  consigne: { libelle: string; aide: string; limite: string; valeur: string; max: number };
  recoit: {
    libelle: string;
    aide: string;
    texte: string;
    // <c5:recoit-choix>
    /**
     * « Le résultat d'étapes choisies » (L42d) : cases des étapes situées PLUS HAUT, `recoit: {etapes}` de L42a. Rendu en mode
     * AVANCÉ seulement, et seulement là où la grammaire laisse le choix (une étape ou un rédacteur hors du premier bloc de
     * travail) : en mode Simple, le champ vaut null et aucun chemin de l'interface ne peut poser de lien (D-5-24, U1).
     */
    etapes: { libelle: string; actif: boolean; choix: readonly LienEtapeOption[] } | null;
    // </c5:recoit-choix>
  };
  // <c5:step-l42d>
  /** Rôle nommé au-dessus du formulaire (« Rédacteur », « Relecteur », « Aiguilleur », « Synthèse ») ; null pour l'it4. */
  roleLibelle: string | null;
  /** Phrase d'aide propre au rôle (l'IA du relecteur) ; null ailleurs. */
  roleAide: string | null;
  /** « Méthodes (facultatif, 2 au plus) » et ses puces ; null quand le catalogue n'offre aucune méthode « consigne ». */
  methodes: { libelle: string; valeur: readonly string[]; options: readonly MethodeEtapeOption[] } | null;
  // </c5:step-l42d>
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
  // <c5:bloc-l42d>
  /** « Nombre de tours au maximum » 1 · 2, avec « Un tour = … » ; null hors d'un bloc de relecture. */
  tours: { libelle: string; aide: string; valeur: number; choix: readonly number[] } | null;
  /** « Me laisser vérifier le premier jet avant la relecture » ; null hors d'un bloc de relecture. */
  pauseAvantRelecture: { libelle: string; valeur: boolean } | null;
  /** « Spécialistes à consulter au plus » 1 · 2 ; null hors d'un bloc d'aiguillage. */
  choixMax: { libelle: string; valeur: number; choix: readonly number[] } | null;
  /** « Spécialistes » et [Ajouter un spécialiste] ; null hors d'un bloc d'aiguillage, `ajouter` null à la borne haute. */
  specialistes: { libelle: string; ajouter: string | null } | null;
  // </c5:bloc-l42d>
}

export interface AjoutModel {
  libelle: string;
  choix: ReadonlyArray<{ type: FlowBlock["type"]; libelle: string; possible: boolean }>;
}

// <c5:ajout-c5-model>
/** Entrées de la 5b du menu [+ Ajouter], à une place donnée : « Une rédaction et relecture », puis « Un aiguillage ». */
export interface AjoutC5Model {
  /** Place d'insertion (0 = en tête) : l'aiguillage n'est possible qu'à 0. */
  place: number;
  choix: ReadonlyArray<{ type: FormeC5; libelle: string; possible: boolean }>;
}

/** Bascule « Étapes | Schéma modifiable » (mode Avancé, spécification §5.3 l.903). */
export interface VueSchemaModel {
  etapes: string;
  schema: string;
  phrase: string;
  courant: VueEtapes;
  /** Phrase rendue À LA PLACE du schéma sous 900 px ; null au-dessus, ou sur la vue « Étapes ». */
  etroit: string | null;
}
// </c5:ajout-c5-model>

export interface Ecran2Model {
  blocs: readonly BlockCardModel[];
  ajouter: AjoutModel;
  annuler: { libelle: string; possible: boolean };
  retablir: { libelle: string; possible: boolean };
  // <c5:ecran2-l42d>
  /**
   * Entrées de la 5b du menu [+ Ajouter], UNE par place d'insertion (`blocs.length + 1` : avant chaque bloc, puis à la fin).
   * Champ séparé pour que `ajouter` garde les trois genres de l'itération 4 ; c'est la place qui décide si « Un aiguillage »
   * est possible (en tête seulement).
   */
  formes: readonly AjoutC5Model[];
  /** Bascule « Étapes | Schéma modifiable » ; null en mode Simple, où seules les étapes existent. */
  vue: VueSchemaModel | null;
  // </c5:ecran2-l42d>
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
  // <c5:ecran3-repetitions>
  /**
   * Lignes des TOURS et des CHOIX que « au plus » couvre (L42d) : « 1 tour en général, {n} au plus » et « 1 spécialiste en
   * général, {n} au plus », d'après `FlowEstimate.repetitions` (L42a). Vide quand le déroulé n'a ni relecture ni aiguillage :
   * l'écran ne parle pas d'une forme absente.
   */
  repetitions: readonly string[];
  // </c5:ecran3-repetitions>
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
  // <c5:entree-l42d>
  /**
   * Catalogue des méthodes (GET /api/methods, L44b) : seules celles de genre « consigne » sont proposées à une étape. ABSENT
   * ou vide → le formulaire d'étape ne montre aucune section « Méthodes » plutôt qu'une section vide.
   */
  methodes?: readonly MethodView[];
  /** Vue de l'écran 2 en mode Avancé : « Étapes » (défaut) ou « Schéma modifiable ». */
  vue?: VueEtapes;
  /** La fenêtre est plus étroite que SCHEMA_LARGEUR_MIN : le schéma modifiable cède la place à sa phrase (spéc. l.903). */
  etroit?: boolean;
  // </c5:entree-l42d>
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
  // L42d : chaque forme de la 5b porte sur sa carte la phrase d'honnêteté du §4.3, la même que sur sa carte de l'écran 1.
  relecture: C5.formes.relecture.phrase,
  aiguillage: C5.formes.aiguillage.phrase,
  // </c5:aides-formes>
  pause: P.pauses.verification.gratuite,
};

// <c5:modele-l42d>

/** Libellé de rôle affiché au-dessus d'un formulaire d'étape d'une forme de la 5b ; null pour les rôles de l'itération 4. */
const LIBELLES_ROLE: Readonly<Record<PlannedRole, string | null>> = {
  etape: null,
  avis: null,
  synthese: null,
  redaction: C5.editeur.champs.redacteur,
  relecture: C5.editeur.champs.relecteur,
  aiguilleur: C5.editeur.champs.aiguilleur,
  specialiste: null,
};

/** Rôles dont la place laisse choisir ce que l'étape reçoit (flow.ts : `attendu` vaut null hors du premier bloc de travail). */
const ROLES_LIBRES: readonly PlannedRole[] = Object.freeze(["etape", "redaction"]);

/** Valeurs proposées par « Nombre de tours au maximum » et « Spécialistes à consulter au plus » : 1 · 2 (FLOW_LIMITS). */
const nombresJusqua = (borne: number): readonly number[] => Object.freeze(Array.from({ length: borne }, (_, rang) => rang + 1));
const CHOIX_TOURS = nombresJusqua(FLOW_LIMITS.toursMax);
const CHOIX_SPECIALISTES = nombresJusqua(FLOW_LIMITS.choixMax);

/**
 * Puces des méthodes « consigne » d'une étape (§4.3). Ordre des refus, le même que celui de la puce du composeur
 * (chat-methods-view.ts) : méthode DÉJÀ dans le fichier de l'assistant, puis limite par étape (FLOW_LIMITS.methodesParEtape).
 * Une méthode déjà retenue reste décochable même devenue « déjà appliquée » (assistant changé après le choix) : sans quoi elle
 * resterait attachée à l'étape sans aucun moyen de la retirer.
 */
function methodesEtape(step: FlowStep, catalogue: readonly MethodView[]): StepFormModel["methodes"] {
  const consignes = catalogue.filter((methode) => methode.kind === "consigne");
  if (consignes.length === 0) return null;
  const retenues = step.methodes ?? [];
  const choisies = new Set(retenues);
  const options = consignes.map((methode): MethodeEtapeOption => {
    const choisie = choisies.has(methode.id);
    let raison: string | null = null;
    if (methode.utiliseePar.some((assistant) => assistant.name === step.assistant)) raison = C5.problemes.methodes.deja;
    else if (!choisie && choisies.size >= FLOW_LIMITS.methodesParEtape) raison = C5.problemes.methodes.trop;
    return { id: methode.id, titre: methode.titre, choisie, desactivee: !choisie && raison !== null, raison };
  });
  return { libelle: C5.editeur.champs.methodes, valeur: retenues, options };
}

/**
 * « Le résultat d'étapes choisies » : cases des étapes des blocs situés PLUS HAUT (L42a, règle `lien-arriere`). Rendu
 * seulement en mode Avancé (`lien-avance`) et seulement pour un rôle dont la place laisse le choix. `null` partout ailleurs :
 * en mode Simple, ce choix est ABSENT du modèle, donc de l'interface.
 */
function lienEtapes(step: FlowStep, role: PlannedRole, input: EditorInput, blocIndex: number): StepFormModel["recoit"]["etapes"] {
  if (!input.advanced || !ROLES_LIBRES.includes(role)) return null;
  const blocs = input.historique.present.flow.blocs;
  const listees = new Set(stepInputEtapes(step.recoit) ?? []);
  const choix: LienEtapeOption[] = [];
  for (const bloc of blocs.slice(0, blocIndex)) {
    for (const amont of etapesDe(bloc)) {
      choix.push({ stepId: amont.id, libelle: amont.titre === "" ? amont.id : amont.titre, cochee: listees.has(amont.id) });
    }
  }
  if (choix.length === 0) return null;
  return { libelle: C5.editeur.recoitEtapes, actif: listees.size > 0, choix };
}

// </c5:modele-l42d>

function stepForm(
  step: FlowStep,
  role: StepFormModel["role"],
  input: EditorInput,
  groupes: readonly AssistantGroupe[],
  retirer: string | null,
  // <c5:step-form-l42d>
  // Rang du bloc (les étapes proposées à « Le résultat d'étapes choisies » sont celles des blocs d'AVANT) et aide propre au
  // rôle. Tous deux facultatifs : les appels de l'itération 4 restent tels quels.
  options: { blocIndex?: number; roleAide?: string | null } = {},
  // </c5:step-form-l42d>
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
      // L42d : un `recoit: {etapes}` (5b, L42a) n'a pas de libellé fermé — la phrase « Reçoit le résultat de : {etapes} » est
      // rendue par flowAsList, sous le schéma. Ici, le texte reste vide et ce sont les CASES ci-dessous qui disent le lien.
      texte: isStepInputName(step.recoit) && Object.hasOwn(recoitChoix, step.recoit) ? recoitChoix[step.recoit] : "",
      etapes: lienEtapes(step, role, input, options.blocIndex ?? 0),
      // </c5:recoit-etapes>
    },
    // <c5:step-champs-l42d>
    roleLibelle: LIBELLES_ROLE[role],
    roleAide: options.roleAide ?? null,
    methodes: methodesEtape(step, input.methodes ?? []),
    // </c5:step-champs-l42d>
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
  if (block.type === "etape") etapes.push(stepForm(block.etape, "etape", input, groupes, null, { blocIndex: index }));
  else if (block.type === "avis") {
    for (const avis of block.avis) etapes.push(stepForm(avis, "avis", input, groupes, retraitPossible ? E.retirerAvis : null));
    etapes.push(stepForm(block.synthese, "synthese", input, groupes, null));
  }
  // <c5:bloc-etapes-l42d>
  // Formes de la 5b : rédacteur puis relecteur (l'aide sur l'IA du relecteur est portée par SON formulaire) ; aiguilleur, puis
  // les spécialistes (retirables tant qu'il en reste plus de 2), puis la synthèse quand le bloc en a une.
  else if (block.type === "relecture") {
    etapes.push(stepForm(block.auteur, "redaction", input, groupes, null, { blocIndex: index }));
    etapes.push(stepForm(block.relecteur, "relecture", input, groupes, null, { roleAide: C5.editeur.aide }));
  } else if (block.type === "aiguillage") {
    const retraitSpecialiste = peutRetirerSpecialiste(draft, block.id) ? C5.editeur.retirerSpecialiste : null;
    etapes.push(stepForm(block.aiguilleur, "aiguilleur", input, groupes, null));
    for (const specialiste of block.specialistes) etapes.push(stepForm(specialiste, "specialiste", input, groupes, retraitSpecialiste));
    if (block.synthese !== null) {
      etapes.push({ ...stepForm(block.synthese, "synthese", input, groupes, null), roleLibelle: C5.editeur.champs.synthese });
    }
  }
  // </c5:bloc-etapes-l42d>
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
    // <c5:bloc-reglages-l42d>
    tours:
      block.type === "relecture"
        ? { libelle: C5.editeur.champs.tours, aide: C5.formes.relecture.tour, valeur: block.toursMax, choix: CHOIX_TOURS }
        : null,
    pauseAvantRelecture: block.type === "relecture" ? { libelle: C5.editeur.champs.pause, valeur: block.pauseAvantRelecture } : null,
    choixMax: block.type === "aiguillage" ? { libelle: C5.editeur.champs.specialistesMax, valeur: block.choixMax, choix: CHOIX_SPECIALISTES } : null,
    specialistes:
      block.type === "aiguillage"
        ? {
            libelle: C5.editeur.champs.specialistes,
            ajouter: peutAjouterSpecialiste(draft, block.id) ? C5.editeur.ajouterSpecialiste : null,
          }
        : null,
    // </c5:bloc-reglages-l42d>
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
    // <c5:ecran1-formes-c5>
    // Les DEUX formes de la 5b, activées toutes les deux, avec leur phrase d'aide du §4.3 ; la relecture porte en plus la
    // phrase qui dit ce qu'est un tour, parce que « 2 tours au maximum » ne se comprend pas sans elle.
    formesC5: [
      { id: "relecture", titre: C5.formes.relecture.titre, aide: C5.formes.relecture.phrase, precision: C5.formes.relecture.tour },
      { id: "aiguillage", titre: C5.formes.aiguillage.titre, aide: C5.formes.aiguillage.phrase, precision: null },
    ],
    // </c5:ecran1-formes-c5>
  };
}

function ecran2(input: EditorInput): Ecran2Model {
  const draft = input.historique.present;
  const groupes = assistantsProposables(input.assistants, { simple: !input.advanced });
  // <c5:ecran2-vue-l42d>
  // Bascule « Étapes | Schéma modifiable » : mode AVANCÉ seulement (spéc. §5.3). Sous 900 px, la vue « Schéma modifiable »
  // rend la phrase du spéc. l.903 à la place du schéma — les étapes restent le chemin complet, dans les deux cas.
  const courant: VueEtapes = input.vue ?? "etapes";
  const vue: VueSchemaModel | null = input.advanced
    ? {
        etapes: C5_SCHEMA.etapes,
        schema: C5_SCHEMA.titre,
        phrase: C5_SCHEMA.phrase,
        courant,
        etroit: courant === "schema" && input.etroit === true ? C5_SCHEMA.etroit : null,
      }
    : null;
  // </c5:ecran2-vue-l42d>
  return {
    blocs: draft.flow.blocs.map((block, index) => blockCard(block, index, input, groupes)),
    ajouter: {
      libelle: E.ajouter,
      choix: BLOCS_AJOUTABLES.map((type) => ({ type, libelle: E.blocs[type], possible: peutAjouterBloc(draft, type) })),
    },
    annuler: { libelle: E.annulerModif, possible: peutAnnuler(input.historique) },
    retablir: { libelle: E.retablir, possible: peutRetablir(input.historique) },
    // <c5:ecran2-formes-l42d>
    // Une entrée de menu par PLACE d'insertion : « Une rédaction et relecture » partout où les bornes le permettent,
    // « Un aiguillage » EN TÊTE SEULEMENT — ailleurs l'entrée reste lisible, désactivée, jamais retirée en silence.
    formes: Array.from({ length: draft.flow.blocs.length + 1 }, (_, place) => ({
      place,
      choix: BLOCS_AJOUTABLES_C5.map((type) => ({
        type,
        libelle: C5.editeur.menu[type],
        possible: peutAjouterBlocC5(draft, type, place),
      })),
    })),
    vue,
    // </c5:ecran2-formes-l42d>
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
    // <c5:ecran3-repetitions-l42d>
    // Ce que « au plus » couvre en plus des lignes du tableau : les tours d'une relecture et les spécialistes d'un aiguillage.
    // Les nombres viennent de l'estimation (L42a, `repetitions`), jamais d'un comptage refait ici.
    repetitions: repetitionsAffichees(estimate?.repetitions),
    // </c5:ecran3-repetitions-l42d>
  };
}

// <c5:repetitions-l42d>
/** « 1 tour en général, {n} au plus » et « 1 spécialiste en général, {n} au plus » ; rien quand la forme est absente. */
function repetitionsAffichees(repetitions: { tours: number; specialistes: number } | undefined): string[] {
  if (repetitions === undefined) return [];
  const lignes: string[] = [];
  const estimation = C5.execution.estimation;
  if (repetitions.tours > 0) lignes.push(remplir(estimation.tours, { n: repetitions.tours }));
  if (repetitions.specialistes > 0) lignes.push(remplir(estimation.specialistes, { n: repetitions.specialistes }));
  return lignes;
}
// </c5:repetitions-l42d>

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
