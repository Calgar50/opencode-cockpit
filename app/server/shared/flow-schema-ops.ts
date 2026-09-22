// Opérations du SCHÉMA MODIFIABLE d'une équipe (itération 5b, L43 ; spécification §5.3 l.903, §5.5, §5.6 l.928, §6 ; conception
// C §8.2 (opérations, refus), §9.12, §11 S4, D10 ; plan d'exécution it5, fiche L43 et §4.3) : module PUR (ni « node: », ni
// process, ni horloge, ni aléa, ni réseau), partagé avec l'interface.
//
// Le schéma modifiable est la SECONDE façon de modifier la MÊME équipe : « Même équipe, deux façons de la modifier. Le schéma
// n'accepte que ce que le cockpit sait exécuter. » Il n'ouvre donc AUCUNE forme que les étapes guidées ne sachent produire, et il
// ne réécrit ni la grammaire (flow.ts, L42a) ni les opérations d'édition (flow-edit.ts, L40b et L42d) : chaque opération d'ici
// compose les opérations du BROUILLON, puis REVALIDE le déroulé obtenu par `validateFlow`. Les problèmes rendus sont donc ceux
// que le serveur posera à l'enregistrement et au lancement (C §11 S4) — le navigateur n'est jamais la seule autorité.
//
// POURQUOI COMPOSER PLUTÔT QUE RÉÉCRIRE : `reglerEntrees` (flow-edit.ts) répare `recoit` selon la PLACE de chaque bloc, et c'est
// la grammaire qui dit ce qu'une place impose. Une opération de schéma qui poserait ses propres blocs contournerait cette
// réparation et produirait des `recoit-invalide` que l'utilisateur n'a pas provoqués. Ici, `transform` retire le bloc, pose la
// forme demandée à la MÊME place par `ajouterBloc` / `ajouterBlocC5`, puis recopie le travail des étapes (titre, assistant, IA,
// taille, consigne, méthodes) par `modifierEtape` et `modifierMethodes` : les entrées restent celles que la grammaire impose.
//
// REFUS (C §8.2, phrases du §4.3, section `avance.schema.refus` de construction-texts.ts) : quatre codes, quatre phrases, et
// AUCUNE autre. Ils disent ce que le cockpit ne sait pas exécuter, jamais ce qui « n'est pas joli » :
// - `versLeBas` : « Le cockpit exécute les étapes de haut en bas : un lien ne peut aller que vers une étape plus bas. » ;
// - `retourArriere` : « Seule une relecture revient en arrière, 2 tours au maximum. » (lien vers une étape du MÊME bloc, y
//   compris vers elle-même : c'est une boucle, et la seule boucle exécutable est le tour d'une relecture) ;
// - `condition` : « Pas de condition libre : seuls le verdict d'une relecture et le choix d'un aiguillage changent la suite. »
//   (lien vers une étape dont l'entrée est IMPOSÉE par la grammaire — avis, synthèse, relecteur, aiguilleur, spécialiste — ou
//   vers une pause, qui ne reçoit rien) ;
// - `imbrication` : « Un bloc ne peut pas en contenir un autre. » (bloc déposé SUR un bloc ou sur une étape, au lieu d'une place
//   entre deux blocs).
// La conception C n'étant pas dans le dossier de ce lancement, les NOMS des codes sont ceux des clés de `construction-texts.ts`
// (T5a), qui portent déjà les quatre phrases : aucune phrase n'est écrite ici.
//
// AUCUN TEXTE n'est écrit dans ce module : les phrases viennent de construction-texts.ts (§4.3) et de team-texts.ts (T4t).
// Mode AVANCÉ seulement (spécification §5.3 l.903) : l'appelant ne monte le schéma qu'en Avancé, et les liens entre étapes sont
// eux-mêmes un réglage du mode Avancé (`lien-avance`, L42a). Aucune constante ni aucun réglage propre au mode Simple (U1).
import { TEXTES as CONSTRUCTION_TEXTES } from "./construction-texts.ts";
import {
  ajouterAvis,
  ajouterBloc,
  ajouterBlocC5,
  ajouterSpecialiste,
  BLOCS_AJOUTABLES,
  BLOCS_AJOUTABLES_C5,
  brouillonDe,
  descendre,
  type FlowDraft,
  type FormeC5,
  modifierChoixMax,
  modifierEtape,
  modifierMethodes,
  modifierRecoitEtapes,
  modifierTours,
  monter,
  peutAjouterAvis,
  peutAjouterBloc,
  peutAjouterBlocC5,
  peutAjouterSpecialiste,
  peutRetirerAvis,
  peutRetirerSpecialiste,
  type ProblemeAffiche,
  retirerAvis,
  retirerSpecialiste,
  supprimerBloc,
} from "./flow-edit.ts";
import { type FlowValidationContext, validateFlow } from "./flow.ts";
import { FLOW_LIMITS, stepInputEtapes } from "./team-limits.ts";
import { TEXTES as TEAM_TEXTES } from "./team-texts.ts";
import type { Flow, FlowBlock, FlowProblem, FlowProblemCode, FlowStep, PlannedRole } from "./team-types.ts";

const SCHEMA = CONSTRUCTION_TEXTES.avance.schema;
const C5 = CONSTRUCTION_TEXTES.partout;
const P = TEAM_TEXTES.partout;

// --- Refus (C §8.2) -------------------------------------------------------------------------------------------------------------

/** Les quatre refus du schéma, nommés par leur clé de textes (§4.3). Union FERMÉE : aucun autre refus n'est annoncé. */
export type SchemaRefusCode = "versLeBas" | "retourArriere" | "condition" | "imbrication";

/** Refus annoncé POLIMENT, par du texte, jamais par la couleur seule (§5.5) : le code sert aux tests, la phrase à l'affichage. */
export interface SchemaRefus {
  code: SchemaRefusCode;
  texte: string;
}

/** Codes dans l'ordre du tableau de C §8.2 ; chaque code a sa phrase dans construction-texts.ts. */
export const SCHEMA_REFUS_CODES: readonly SchemaRefusCode[] = Object.freeze(["versLeBas", "retourArriere", "condition", "imbrication"]);

/** Phrase d'un refus (§4.3) : lue, jamais écrite ici. */
export function phraseRefus(code: SchemaRefusCode): string {
  return SCHEMA.refus[code];
}

const refus = (code: SchemaRefusCode): SchemaRefus => ({ code, texte: phraseRefus(code) });

// --- Ce qu'on glisse, et où -------------------------------------------------------------------------------------------------

/** Ce qui est glissé : un BLOC (déplacement), ou un LIEN tiré depuis le port de sortie d'une étape. */
export type SchemaSource = { genre: "bloc"; blocId: string } | { genre: "lien"; stepId: string };

/** Où il est lâché : une place entre deux blocs, un bloc, ou une étape. */
export type SchemaCible = { genre: "place"; index: number } | { genre: "bloc"; blocId: string } | { genre: "etape"; stepId: string };

/** Réponse de `dropCheck` : accepté, ou refusé avec son code (sa phrase est dans `phraseRefus`). */
export type DropCheck = { ok: true } | { ok: false; code: SchemaRefusCode };

// --- État et résultat d'une opération ------------------------------------------------------------------------------------------

/**
 * Ce qu'une opération a besoin de savoir en plus du déroulé :
 * - `validation` : le contexte de la grammaire, le MÊME que celui du serveur (assistants, mode, niveaux) ;
 * - `compteur` : identifiants déjà servis (FlowDraft.compteur). Absent → déduit du déroulé ; le passer garde la promesse de
 *   l'éditeur guidé (un identifiant rendu n'est jamais réattribué), même après une suppression.
 */
export interface SchemaContext {
  validation: FlowValidationContext;
  compteur?: number;
}

/**
 * Résultat d'une opération. `flow` est TOUJOURS un nouveau déroulé quand `change` est vrai, et le déroulé reçu quand il est faux
 * (opération impossible : borne atteinte, identifiant inconnu, refus). `problemes` est le résultat de `validateFlow` sur le
 * déroulé rendu : c'est ce que le serveur dira, et c'est ce que l'interface affiche.
 */
export interface SchemaOpResult {
  flow: Flow;
  compteur: number;
  change: boolean;
  problemes: readonly FlowProblem[];
  refus: SchemaRefus | null;
}

/**
 * Codes que le NAVIGATEUR ne peut pas juger : ils demandent les règles effectives des assistants (GET /agent) et le catalogue
 * d'IA, que seul le serveur a. Ils arrivent par l'aperçu (POST /api/teams/preview) et par la revalidation du serveur à
 * l'enregistrement et au lancement (C §11 S4).
 */
export const PROBLEMES_DES_ASSISTANTS: readonly FlowProblemCode[] = Object.freeze([
  "assistant-absent",
  "assistant-interne",
  "assistant-non-proposable",
  "delegue",
  "internet",
  "autorise-sans-demander",
  "propose-reporte",
  "personnalise",
  "niveau-indisponible",
  "meme-famille",
]);

/**
 * Contexte de revalidation du navigateur : la STRUCTURE du déroulé, en mode Avancé (le schéma n'existe qu'en Avancé, spéc.
 * l.903), sans table d'assistants. Il sert à `problemesStructurels` et aux opérations lancées depuis l'interface ; le serveur
 * reste l'autorité, et `problemesStructurels` écarte les codes qu'un navigateur ne peut pas juger.
 */
export function contexteStructure(compteur?: number): SchemaContext {
  return { validation: { assistants: [], mode: "avance", niveauDisponible: () => true, pour: "enregistrement" }, ...(compteur === undefined ? {} : { compteur }) };
}

/**
 * Problèmes de STRUCTURE d'un déroulé, tels que le navigateur peut les dire tout de suite : la même `validateFlow` que le
 * serveur, moins les codes qui demandent les règles des assistants. Ils complètent l'aperçu entre deux appels (300 ms) et ne le
 * contredisent jamais : un problème d'assistant n'est ni inventé ni effacé ici.
 */
export function problemesStructurels(flow: Flow): FlowProblem[] {
  return validateFlow(flow, contexteStructure().validation).filter((probleme) => !PROBLEMES_DES_ASSISTANTS.includes(probleme.code));
}

/** Union des problèmes du serveur et de ceux de la structure : un même code au même endroit n'est compté qu'une fois. */
export function fusionnerProblemes(serveur: readonly FlowProblem[], locaux: readonly FlowProblem[]): FlowProblem[] {
  const cle = (probleme: FlowProblem) => `${probleme.code}|${probleme.bloc ?? ""}|${probleme.etape ?? ""}`;
  const vus = new Set(serveur.map(cle));
  return [...serveur, ...locaux.filter((probleme) => !vus.has(cle(probleme)))];
}

/** Brouillon d'entrée : le déroulé reçu, avec le compteur d'identifiants donné par l'appelant quand il le connaît. */
function brouillon(flow: Flow, ctx: SchemaContext): FlowDraft {
  const depuis = brouillonDe(flow);
  const compteur = ctx.compteur === undefined ? depuis.compteur : Math.max(depuis.compteur, Math.trunc(ctx.compteur));
  return { flow: depuis.flow, compteur };
}

/** Résultat d'une opération qui a abouti (ou non) : le déroulé est revalidé dans tous les cas. */
function resultat(flow: Flow, compteur: number, change: boolean, ctx: SchemaContext, refuse: SchemaRefus | null = null): SchemaOpResult {
  return { flow, compteur, change, problemes: validateFlow(flow, ctx.validation), refus: refuse };
}

/** Opération refusée : le déroulé reçu, tel quel, avec la phrase du refus. */
const refuser = (flow: Flow, ctx: SchemaContext, code: SchemaRefusCode): SchemaOpResult => resultat(flow, brouillon(flow, ctx).compteur, false, ctx, refus(code));

/**
 * Résultat d'une opération du brouillon : `change` dit si le brouillon a bougé (flow-edit rend l'état REÇU quand il refuse).
 * Sans changement, c'est le déroulé REÇU qui est rendu, jamais sa copie : l'appelant reconnaît « rien n'a bougé » à l'identité.
 */
function depuisBrouillon(flow: Flow, avant: FlowDraft, apres: FlowDraft, ctx: SchemaContext): SchemaOpResult {
  const change = apres !== avant;
  return resultat(change ? apres.flow : flow, apres.compteur, change, ctx);
}

// --- Lecture du déroulé ---------------------------------------------------------------------------------------------------------

/** Étapes déclarées d'un bloc, dans l'ordre d'écriture, avec leur rôle (même lecture que la grammaire, flow.ts). */
function etapesDuBloc(block: FlowBlock): Array<{ step: FlowStep; role: PlannedRole }> {
  if (block.type === "etape") return [{ step: block.etape, role: "etape" }];
  if (block.type === "avis") return [...block.avis.map((step) => ({ step, role: "avis" as const })), { step: block.synthese, role: "synthese" as const }];
  if (block.type === "relecture") {
    return [
      { step: block.auteur, role: "redaction" },
      { step: block.relecteur, role: "relecture" },
    ];
  }
  if (block.type === "aiguillage") {
    return [
      { step: block.aiguilleur, role: "aiguilleur" as const },
      ...block.specialistes.map((step) => ({ step, role: "specialiste" as const })),
      ...(block.synthese === null ? [] : [{ step: block.synthese, role: "synthese" as const }]),
    ];
  }
  return [];
}

/** Place d'une étape : son bloc, son rang de bloc et son rôle ; null quand l'identifiant n'existe pas. */
function placeEtape(flow: Flow, stepId: string): { blocIndex: number; block: FlowBlock; step: FlowStep; role: PlannedRole } | null {
  for (const [blocIndex, block] of flow.blocs.entries()) {
    for (const { step, role } of etapesDuBloc(block)) {
      if (step.id === stepId) return { blocIndex, block, step, role };
    }
  }
  return null;
}

/**
 * Rôles dont la place laisse choisir ce que l'étape reçoit (flow.ts : `attendu` vaut null hors du premier bloc de travail).
 * Tous les autres reçoivent ce que la grammaire impose : un lien vers eux serait une condition libre.
 */
const ROLES_LIBRES: readonly PlannedRole[] = Object.freeze(["etape", "redaction"]);

/** Premier bloc de TRAVAIL (les pauses n'en sont pas) : son entrée est votre demande, rien d'autre ne peut y mener. */
const premierTravail = (flow: Flow): FlowBlock | undefined => flow.blocs.find((block) => block.type !== "pause");

/** Étape d'entrée d'un bloc : celle dont la place laisse un choix ; null pour un bloc dont tout est imposé (avis, aiguillage, pause). */
function entreeDuBloc(block: FlowBlock): FlowStep | null {
  const premiere = etapesDuBloc(block)[0];
  if (premiere === undefined || !ROLES_LIBRES.includes(premiere.role)) return null;
  return premiere.step;
}

// --- dropCheck (C §8.2) -----------------------------------------------------------------------------------------------------

/**
 * Ce que le schéma accepte, AVANT toute modification : c'est la fonction que le glisser interroge à chaque survol, pour écrire
 * le refus PRÈS DE LA CIBLE plutôt que de laisser tomber le geste sans rien dire.
 *
 * Un BLOC se dépose sur une PLACE (entre deux blocs) : déposé sur un bloc ou sur une étape, il faudrait qu'un bloc en contienne
 * un autre (`imbrication`). Ce que la grammaire juge ensuite (un aiguillage qui n'est plus le premier bloc, une pause en
 * dernier) reste jugé par elle : le déplacement est accepté et le problème s'affiche, jamais l'inverse.
 *
 * Un LIEN part du port de sortie d'une étape et va vers une étape PLUS BAS dont l'entrée est libre. Tout le reste est refusé :
 * plus haut (`versLeBas`), dans le même bloc ou sur elle-même (`retourArriere`), vers une entrée imposée ou vers une pause
 * (`condition`).
 */
export function dropCheck(flow: Flow, source: SchemaSource, cible: SchemaCible): DropCheck {
  if (source.genre === "bloc") {
    if (cible.genre !== "place") return { ok: false, code: "imbrication" };
    return flow.blocs.some((block) => block.id === source.blocId) ? { ok: true } : { ok: false, code: "imbrication" };
  }
  const depart = placeEtape(flow, source.stepId);
  if (depart === null) return { ok: false, code: "condition" };
  // Un lien lâché ailleurs que sur une étape ne mène nulle part : c'est un aiguillage libre, que le cockpit n'exécute pas.
  if (cible.genre === "place") return { ok: false, code: "condition" };
  const arrivee =
    cible.genre === "etape"
      ? placeEtape(flow, cible.stepId)
      : ((): ReturnType<typeof placeEtape> => {
          const block = flow.blocs.find((b) => b.id === cible.blocId);
          const entree = block === undefined ? null : entreeDuBloc(block);
          return entree === null ? null : placeEtape(flow, entree.id);
        })();
  if (arrivee === null) return { ok: false, code: "condition" };
  if (arrivee.blocIndex === depart.blocIndex) return { ok: false, code: "retourArriere" };
  if (arrivee.blocIndex < depart.blocIndex) return { ok: false, code: "versLeBas" };
  if (!ROLES_LIBRES.includes(arrivee.role)) return { ok: false, code: "condition" };
  // Le premier bloc de travail part de VOTRE demande (grammaire : `attendu` vaut « demande ») : rien ne peut y mener.
  if (arrivee.block === premierTravail(flow)) return { ok: false, code: "condition" };
  return { ok: true };
}

// --- Opérations -----------------------------------------------------------------------------------------------------------------

/** Genres de bloc que le schéma sait poser, dans l'ordre des menus : ceux de l'itération 4, puis ceux de la 5b (L42d). */
export const SCHEMA_FORMES: readonly FlowBlock["type"][] = Object.freeze([...BLOCS_AJOUTABLES, ...BLOCS_AJOUTABLES_C5]);

const estFormeC5 = (forme: FlowBlock["type"]): forme is FormeC5 => forme === "relecture" || forme === "aiguillage";

/** Ajout d'un bloc à la place `index` (0 = en tête), par l'opération de l'éditeur guidé qui correspond à sa forme. */
function ajouterA(draft: FlowDraft, forme: FlowBlock["type"], index: number): FlowDraft {
  return estFormeC5(forme) ? ajouterBlocC5(draft, forme, index) : ajouterBloc(draft, forme, index);
}

/** L'ajout d'un bloc de cette forme à cette place est possible (mêmes règles que l'éditeur guidé : bornes, aiguillage en tête). */
export function peutAjouterA(flow: Flow, forme: FlowBlock["type"], index: number, ctx: SchemaContext): boolean {
  const draft = brouillon(flow, ctx);
  return estFormeC5(forme) ? peutAjouterBlocC5(draft, forme, index) : peutAjouterBloc(draft, forme);
}

/** « Ajouter après » : un bloc neuf de la forme demandée, juste après `blocId`. */
export function insertAfter(flow: Flow, blocId: string, forme: FlowBlock["type"], ctx: SchemaContext): SchemaOpResult {
  const avant = brouillon(flow, ctx);
  const index = avant.flow.blocs.findIndex((block) => block.id === blocId);
  if (index === -1) return resultat(flow, avant.compteur, false, ctx);
  return depuisBrouillon(flow, avant, ajouterA(avant, forme, index + 1), ctx);
}

/** « Monter » (Alt+↑) : le bloc passe d'un rang vers le haut. */
export function moveUp(flow: Flow, blocId: string, ctx: SchemaContext): SchemaOpResult {
  const avant = brouillon(flow, ctx);
  return depuisBrouillon(flow, avant, monter(avant, blocId), ctx);
}

/** « Descendre » (Alt+↓) : le bloc passe d'un rang vers le bas. */
export function moveDown(flow: Flow, blocId: string, ctx: SchemaContext): SchemaOpResult {
  const avant = brouillon(flow, ctx);
  return depuisBrouillon(flow, avant, descendre(avant, blocId), ctx);
}

/**
 * Déplacement d'un bloc à la place `index` (glisser au pointeur) : une répétition de `moveUp` / `moveDown`, pour que le geste
 * soit EXACTEMENT ce que les deux boutons font, et pour qu'une seule entrée d'historique en sorte. `index` est la place VISÉE
 * dans la liste des blocs, bornée à la liste.
 */
export function moveTo(flow: Flow, blocId: string, index: number, ctx: SchemaContext): SchemaOpResult {
  const blocs = flow.blocs;
  const depart = blocs.findIndex((block) => block.id === blocId);
  if (depart === -1) return resultat(flow, brouillon(flow, ctx).compteur, false, ctx);
  const vise = Math.max(0, Math.min(Math.trunc(index), blocs.length - 1));
  let etat: SchemaOpResult = resultat(flow, brouillon(flow, ctx).compteur, false, ctx);
  let place = depart;
  while (place !== vise) {
    const pas = place < vise ? moveDown(etat.flow, blocId, { ...ctx, compteur: etat.compteur }) : moveUp(etat.flow, blocId, { ...ctx, compteur: etat.compteur });
    if (!pas.change) break;
    etat = pas;
    place += place < vise ? 1 : -1;
  }
  return etat;
}

/** « Supprimer » : le bloc et ses étapes quittent le déroulé ; les identifiants des autres ne bougent pas. */
export function removeBloc(flow: Flow, blocId: string, ctx: SchemaContext): SchemaOpResult {
  const avant = brouillon(flow, ctx);
  return depuisBrouillon(flow, avant, supprimerBloc(avant, blocId), ctx);
}

/** Un avis de plus dans un bloc d'avis (5 au plus, 12 étapes au plus). */
export function addAvis(flow: Flow, blocId: string, ctx: SchemaContext): SchemaOpResult {
  const avant = brouillon(flow, ctx);
  return depuisBrouillon(flow, avant, ajouterAvis(avant, blocId), ctx);
}

/** Un avis de moins (2 au moins : « Proposez de 2 à 8 spécialistes. » a son équivalent pour les avis, grammaire `avis-nombre`). */
export function removeAvis(flow: Flow, blocId: string, stepId: string, ctx: SchemaContext): SchemaOpResult {
  const avant = brouillon(flow, ctx);
  return depuisBrouillon(flow, avant, retirerAvis(avant, blocId, stepId), ctx);
}

/** Un spécialiste de plus dans un aiguillage (8 au plus, 12 étapes au plus). */
export function addSpecialiste(flow: Flow, blocId: string, ctx: SchemaContext): SchemaOpResult {
  const avant = brouillon(flow, ctx);
  return depuisBrouillon(flow, avant, ajouterSpecialiste(avant, blocId), ctx);
}

/** Un spécialiste de moins (2 au moins). */
export function removeSpecialiste(flow: Flow, blocId: string, stepId: string, ctx: SchemaContext): SchemaOpResult {
  const avant = brouillon(flow, ctx);
  return depuisBrouillon(flow, avant, retirerSpecialiste(avant, blocId, stepId), ctx);
}

/** « Nombre de tours au maximum » d'une relecture : 1 ou 2 (FLOW_LIMITS.toursMax). */
export function setTours(flow: Flow, blocId: string, tours: 1 | 2, ctx: SchemaContext): SchemaOpResult {
  const avant = brouillon(flow, ctx);
  return depuisBrouillon(flow, avant, modifierTours(avant, blocId, tours), ctx);
}

/** « Spécialistes à consulter au plus » d'un aiguillage : 1 ou 2 ; à 2, la synthèse est posée par l'éditeur (grammaire). */
export function setChoixMax(flow: Flow, blocId: string, choixMax: 1 | 2, ctx: SchemaContext): SchemaOpResult {
  const avant = brouillon(flow, ctx);
  return depuisBrouillon(flow, avant, modifierChoixMax(avant, blocId, choixMax), ctx);
}

/**
 * « Reçoit le résultat de… » : `recoit: {etapes}` (L42a), transmis par l'exécution (L42b). Chaque étape visée passe par
 * `dropCheck` : un lien que le cockpit ne saurait pas exécuter est REFUSÉ avec sa phrase, jamais écrit puis signalé après coup.
 * Une liste vide (ou `null`) rend l'étape à la valeur par défaut de sa place.
 */
export function setRecoit(flow: Flow, stepId: string, etapes: readonly string[] | null, ctx: SchemaContext): SchemaOpResult {
  const avant = brouillon(flow, ctx);
  for (const cible of etapes ?? []) {
    const verdict = dropCheck(avant.flow, { genre: "lien", stepId: cible }, { genre: "etape", stepId });
    if (!verdict.ok) return refuser(flow, ctx, verdict.code);
  }
  return depuisBrouillon(flow, avant, modifierRecoitEtapes(avant, stepId, etapes), ctx);
}

// --- transform ------------------------------------------------------------------------------------------------------------------

/** Champs d'une étape que `transform` recopie : tout le travail déjà fait, jamais `recoit` (il vient de la place, C §5.1). */
function travailDe(step: FlowStep): { titre: string; assistant: string; niveau: FlowStep["niveau"]; taille: FlowStep["taille"]; consigne: string; methodes: readonly string[] } {
  return { titre: step.titre, assistant: step.assistant, niveau: step.niveau, taille: step.taille, consigne: step.consigne, methodes: step.methodes ?? [] };
}

/**
 * « Transformer en… » : le bloc prend une autre forme et GARDE ses étapes quand c'est possible. La place, le rang et les blocs
 * voisins ne bougent pas.
 *
 * Méthode : le bloc est retiré, la forme demandée est posée à la même place par l'opération de l'éditeur guidé (qui crée ses
 * étapes avec les entrées que la grammaire impose), puis le travail des étapes est recopié RANG PAR RANG — un titre vide ne
 * remplace jamais le titre de rôle d'une synthèse, et les étapes en trop de l'ancienne forme sont perdues, faute d'une place où
 * les mettre. Les identifiants changent : ce sont d'autres étapes, dans une autre forme.
 *
 * Refusé — déroulé rendu tel quel — quand la forme demandée ne tient pas à cette place (aiguillage ailleurs qu'en tête, bornes
 * des blocs ou des étapes) : l'entrée du menu est alors désactivée, avec la même règle.
 */
export function transform(flow: Flow, blocId: string, forme: FlowBlock["type"], ctx: SchemaContext): SchemaOpResult {
  const avant = brouillon(flow, ctx);
  const index = avant.flow.blocs.findIndex((block) => block.id === blocId);
  const original = avant.flow.blocs[index];
  if (index === -1 || original === undefined || original.type === forme) return resultat(flow, avant.compteur, false, ctx);
  const garde = etapesDuBloc(original).map(({ step }) => travailDe(step));
  const sans = supprimerBloc(avant, blocId);
  if (sans === avant) return resultat(flow, avant.compteur, false, ctx);
  const possible = estFormeC5(forme) ? peutAjouterBlocC5(sans, forme, index) : peutAjouterBloc(sans, forme);
  if (!possible) return resultat(flow, avant.compteur, false, ctx);
  const pose = ajouterA(sans, forme, index);
  if (pose === sans) return resultat(flow, avant.compteur, false, ctx);
  const neuf = pose.flow.blocs[index];
  if (neuf === undefined) return resultat(flow, avant.compteur, false, ctx);
  let apres = pose;
  etapesDuBloc(neuf).forEach(({ step }, rang) => {
    const repris = garde[rang];
    if (repris === undefined) return;
    apres = modifierEtape(
      apres,
      step.id,
      { titre: repris.titre === "" ? step.titre : repris.titre, assistant: repris.assistant, niveau: repris.niveau, taille: repris.taille, consigne: repris.consigne },
      { simple: false },
    );
    if (repris.methodes.length > 0) apres = modifierMethodes(apres, step.id, repris.methodes);
  });
  return resultat(apres.flow, apres.compteur, true, ctx);
}

// --- Modèle de la vue (le .tsx reste mince, D-eq-24) --------------------------------------------------------------------------

/** Entrée d'un menu de formes (« Ajouter après », « Transformer en… ») : son libellé de T4t et ce que les bornes permettent. */
export interface SchemaFormeChoix {
  forme: FlowBlock["type"];
  libelle: string;
  possible: boolean;
}

/** Case d'une étape située plus haut, proposée à « Reçoit le résultat de… » (mode Avancé, `recoit: {etapes}`). */
export interface SchemaLienChoix {
  stepId: string;
  libelle: string;
  cochee: boolean;
}

/** Port de sortie et liens d'une étape du bloc : ce que le glisser tire, et ce que le menu coche. */
export interface SchemaEtapeModel {
  stepId: string;
  titre: string;
  sousTitre: string;
  /** L'étape peut recevoir des résultats choisis (sa place laisse le choix) : le menu « Reçoit le résultat de… » est rendu. */
  recoit: { libelle: string; choix: readonly SchemaLienChoix[] } | null;
  /** [Retirer cet avis] ou [Retirer ce spécialiste] ; null quand l'étape ne se retire pas (borne basse, autre rôle). */
  retirer: string | null;
  problemes: readonly ProblemeAffiche[];
}

/** Une ligne du schéma : un bloc (un bloc d'avis ou un aiguillage à synthèse en donne deux, comme layoutFlow). */
export interface SchemaLigneModel {
  blocId: string;
  kind: "etape" | "avis" | "synthese" | "relecture" | "aiguillage" | "pause";
  /** Rang du bloc dans le déroulé (place visée par un déplacement). */
  index: number;
  /** Première ligne du bloc : les actions ne sont rendues qu'une fois par bloc. */
  principale: boolean;
  etapes: readonly SchemaEtapeModel[];
  /** Étapes dont cette ligne reçoit le résultat (mêmes identifiants que les flèches de layoutFlow). */
  recoitDe: readonly string[];
  monter: { libelle: string; possible: boolean };
  descendre: { libelle: string; possible: boolean };
  supprimer: { libelle: string; possible: boolean };
  ajouterApres: { libelle: string; choix: readonly SchemaFormeChoix[] };
  transformer: { libelle: string; choix: readonly SchemaFormeChoix[] };
  /** [Ajouter un avis] ou [Ajouter un spécialiste] ; null hors de ces deux formes, ou à la borne haute. */
  ajouterEtape: string | null;
  /** « Nombre de tours au maximum » 1 · 2 (relecture) ; null ailleurs. */
  tours: { libelle: string; valeur: number; choix: readonly number[] } | null;
  /** « Spécialistes à consulter au plus » 1 · 2 (aiguillage) ; null ailleurs. */
  choixMax: { libelle: string; valeur: number; choix: readonly number[] } | null;
  problemes: readonly ProblemeAffiche[];
}

/** Modèle complet de la vue « Schéma modifiable ». */
export interface SchemaModel {
  /** « Glissez vers une étape plus bas : elle recevra ce résultat. » */
  aide: string;
  /** Phrase de chaque refus (C §8.2), pour l'écrire près de la cible sans jamais l'écrire dans le composant. */
  refus: Readonly<Record<SchemaRefusCode, string>>;
  lignes: readonly SchemaLigneModel[];
  /** [Voir le JSON] : LECTURE SEULE, copiable ; l'import viendra plus tard. */
  json: { voir: string; lectureSeule: string; texte: string };
  /** Problèmes de l'équipe entière (aucun bloc, aucune étape) : ils ne tiennent sur aucune ligne. */
  problemes: readonly ProblemeAffiche[];
}

/**
 * Phrase d'un problème, par code (T4t) ; `synthese-requise` sur un aiguillage prend la phrase du §4.3, comme dans l'éditeur
 * guidé (L42d) : ce qui manque à un aiguillage n'est pas la synthèse des avis. Un code sans phrase est ignoré plutôt qu'affiché
 * sans texte.
 */
function problemesAffiches(problems: readonly FlowProblem[], garde: (probleme: FlowProblem) => boolean, forme: FlowBlock["type"] | null): ProblemeAffiche[] {
  const out: ProblemeAffiche[] = [];
  for (const probleme of problems) {
    if (!garde(probleme)) continue;
    const texte =
      probleme.code === "synthese-requise" && forme === "aiguillage"
        ? C5.problemes["synthese-requise"]
        : Object.hasOwn(P.problemes, probleme.code)
          ? P.problemes[probleme.code as keyof typeof P.problemes]
          : null;
    if (texte !== null) out.push({ code: probleme.code, texte, bloquant: probleme.bloquant });
  }
  return out;
}

/** Libellé d'une étape dans un menu : son titre, ou son identifiant tant qu'elle n'en a pas (l'invite reste le titre vide). */
const libelleEtape = (step: FlowStep): string => (step.titre === "" ? step.id : step.titre);

/** Lignes d'un bloc, dans l'ordre de layoutFlow : un bloc d'avis et un aiguillage à synthèse en donnent deux. */
function lignesDuBloc(block: FlowBlock): Array<{ kind: SchemaLigneModel["kind"]; etapes: FlowStep[] }> {
  if (block.type === "avis") {
    return [
      { kind: "avis", etapes: [...block.avis] },
      { kind: "synthese", etapes: [block.synthese] },
    ];
  }
  if (block.type === "aiguillage") {
    const premiere = { kind: "aiguillage" as const, etapes: [block.aiguilleur, ...block.specialistes] };
    return block.synthese === null ? [premiere] : [premiere, { kind: "synthese", etapes: [block.synthese] }];
  }
  if (block.type === "relecture") return [{ kind: "relecture", etapes: [block.auteur, block.relecteur] }];
  if (block.type === "etape") return [{ kind: "etape", etapes: [block.etape] }];
  return [{ kind: "pause", etapes: [] }];
}

/** Entrées d'un menu de formes, dans l'ordre de SCHEMA_FORMES ; `possible` dit ce que les bornes et la place permettent. */
function choixFormes(possible: (forme: FlowBlock["type"]) => boolean): SchemaFormeChoix[] {
  return SCHEMA_FORMES.map((forme) => ({ forme, libelle: P.editeur.blocs[forme], possible: possible(forme) }));
}

/** Valeurs proposées par « Nombre de tours au maximum » et « Spécialistes à consulter au plus » : 1 · 2 (FLOW_LIMITS). */
const nombresJusqua = (borne: number): readonly number[] => Object.freeze(Array.from({ length: borne }, (_, rang) => rang + 1));

/** [Ajouter un avis] / [Ajouter un spécialiste] d'un bloc ; null hors de ces formes ou à la borne haute. */
function ajoutEtape(draft: FlowDraft, block: FlowBlock): string | null {
  if (block.type === "avis") return peutAjouterAvis(draft, block.id) ? P.editeur.ajouterAvis : null;
  if (block.type === "aiguillage") return peutAjouterSpecialiste(draft, block.id) ? C5.editeur.ajouterSpecialiste : null;
  return null;
}

/** [Retirer cet avis] / [Retirer ce spécialiste] d'une étape ; null quand elle ne se retire pas. */
function retraitEtape(draft: FlowDraft, block: FlowBlock, role: PlannedRole): string | null {
  if (role === "avis") return peutRetirerAvis(draft, block.id) ? P.editeur.retirerAvis : null;
  if (role === "specialiste") return peutRetirerSpecialiste(draft, block.id) ? C5.editeur.retirerSpecialiste : null;
  return null;
}

/** Une transformation est possible quand la forme demandée tient à la place du bloc, une fois celui-ci retiré. */
function peutTransformer(flow: Flow, blocId: string, forme: FlowBlock["type"], ctx: SchemaContext): boolean {
  const avant = brouillon(flow, ctx);
  const index = avant.flow.blocs.findIndex((block) => block.id === blocId);
  if (index === -1 || avant.flow.blocs[index]?.type === forme) return false;
  const sans = supprimerBloc(avant, blocId);
  return estFormeC5(forme) ? peutAjouterBlocC5(sans, forme, index) : peutAjouterBloc(sans, forme);
}

/**
 * Modèle de la vue : une ligne par ligne du schéma, ses actions (chaque glisser a son bouton ou son menu, WCAG 2.5.7), les
 * cases des étapes plus haut, les problèmes RENDUS SUR le bloc ou l'étape fautifs, et le JSON en lecture seule.
 * `problems` vient de l'aperçu du serveur quand il est là ; sinon, de la revalidation locale : les deux disent la même chose,
 * et c'est le serveur qui tranche à l'enregistrement et au lancement (C §11 S4).
 */
export function schemaModel(flow: Flow, problems: readonly FlowProblem[], ctx: SchemaContext): SchemaModel {
  const lignes: SchemaLigneModel[] = [];
  const draft = brouillon(flow, ctx);
  const premier = premierTravail(flow);
  flow.blocs.forEach((block, index) => {
    const amont: SchemaLienChoix[] = [];
    for (const precedent of flow.blocs.slice(0, index)) {
      for (const { step } of etapesDuBloc(precedent)) amont.push({ stepId: step.id, libelle: libelleEtape(step), cochee: false });
    }
    lignesDuBloc(block).forEach((ligne, rang) => {
      const etapes = ligne.etapes.map((step): SchemaEtapeModel => {
        const place = placeEtape(flow, step.id);
        const role = place === null ? "etape" : place.role;
        const libre = place !== null && ROLES_LIBRES.includes(role) && block !== premier;
        const listees = new Set(stepInputEtapes(step.recoit) ?? []);
        return {
          stepId: step.id,
          titre: step.titre,
          sousTitre: step.assistant,
          recoit: libre ? { libelle: SCHEMA.menus.recevoir, choix: amont.map((choix) => ({ ...choix, cochee: listees.has(choix.stepId) })) } : null,
          retirer: retraitEtape(draft, block, role),
          problemes: problemesAffiches(problems, (probleme) => probleme.etape === step.id, block.type),
        };
      });
      lignes.push({
        blocId: block.id,
        kind: ligne.kind,
        index,
        principale: rang === 0,
        etapes,
        recoitDe: [...new Set(ligne.etapes.flatMap((step) => stepInputEtapes(step.recoit) ?? []))],
        monter: { libelle: SCHEMA.menus.monter, possible: index > 0 },
        descendre: { libelle: SCHEMA.menus.descendre, possible: index < flow.blocs.length - 1 },
        // Le schéma garde TOUJOURS un bloc : un déroulé vide n'est pas exécutable, et le schéma n'accepte que ce que le cockpit
        // sait exécuter. Vider entièrement une équipe reste possible par « Étapes », le chemin complet (spéc. §5.3).
        supprimer: { libelle: SCHEMA.menus.supprimer, possible: flow.blocs.length > 1 },
        ajouterApres: { libelle: SCHEMA.menus.ajouterApres, choix: choixFormes((forme) => peutAjouterA(flow, forme, index + 1, ctx)) },
        transformer: { libelle: SCHEMA.menus.transformer, choix: choixFormes((forme) => peutTransformer(flow, block.id, forme, ctx)) },
        ajouterEtape: ajoutEtape(draft, block),
        tours: block.type === "relecture" ? { libelle: C5.editeur.champs.tours, valeur: block.toursMax, choix: nombresJusqua(FLOW_LIMITS.toursMax) } : null,
        choixMax:
          block.type === "aiguillage" ? { libelle: C5.editeur.champs.specialistesMax, valeur: block.choixMax, choix: nombresJusqua(FLOW_LIMITS.choixMax) } : null,
        problemes: problemesAffiches(problems, (probleme) => probleme.bloc === block.id && probleme.etape === null, block.type),
      });
    });
  });
  return {
    aide: SCHEMA.glisser,
    refus: SCHEMA.refus,
    lignes,
    json: { voir: SCHEMA.json.voir, lectureSeule: SCHEMA.json.lectureSeule, texte: JSON.stringify(flow, null, 2) },
    problemes: problemesAffiches(problems, (probleme) => probleme.bloc === null && probleme.etape === null, null),
  };
}
