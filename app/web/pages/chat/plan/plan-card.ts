// Propriétaire : L6c.
// Modèle pur de la carte de plan (spécification §4.9 points 4 à 6, §4.11 l.776, I7 ; plan d'exécution, fiche L6c) :
// - affichage : rien hors d'une conversation de plan ; la phrase d'honnêteté seule tant qu'aucune réponse n'est terminée ou que
//   la racine travaille (« la carte attend la fin de la réponse ») ; la carte à quatre boutons après chaque réponse ;
// - boutons indisponibles désactivés avec leur raison (I7) : les choix automatiques restent fermés, raison « a-venir », tant que
//   la porte I1 (ACTIVATION_OUVERTE, lue dans /api/bootstrap) est fermée, et « autonomie-coupee » avec COCKPIT_AUTONOMY=off ;
//   « Exécuter en demandant à chaque fois » et « Continuer à planifier » restent toujours possibles (§4.11) ;
// - suite d'une exécution refusée : 428 d'un choix automatique envoyé sans en-tête → confirmation (<AutonomyConfirm>), puis nouvel
//   appel avec l'en-tête (§4.11 l.776 : relâcher demande une confirmation) ; 403 et 409 → la raison, avec la phrase propre au code
//   (autonomy-texts.ts, L9b) ; toute autre erreur → la phrase du serveur ;
// - réponse terminée : même critère que le texte de plan lu par le serveur (lastPlanText, plans.ts), pour que la carte n'offre
//   pas une exécution que le serveur refuserait faute de réponse.
// Aucun texte ici : libellés et phrases viennent de plan-texts.ts (L6b), autonomy-choice-texts.ts (L6a) et autonomy-texts.ts
// (L9b), sans doublon. Testé par server/plan-card.test.ts (le composant PlanCard.tsx n'est pas exécuté par `npm test`).
import { TEXTES as CHOIX } from "../../../../server/shared/autonomy-choice-texts.ts";
import { CHOICE_ICONS, type MenuIcon } from "../../../../server/shared/autonomy-menu.ts";
import { raisonRefus } from "../../../../server/shared/autonomy-texts.ts";
import type {
  ActivationRefusalCode,
  AutomaticChoice,
  AutonomyCaps,
  AutonomyErrorCode,
  BootstrapAutonomy,
  ConversationAutonomyView,
  PlanExecutionBody,
} from "../../../../server/shared/autonomy-types.ts";
import { TEXTES } from "../../../../server/shared/plan-texts.ts";

/** Bouton de la carte : un choix d'exécution (nouvelle conversation) ou « Continuer à planifier ». */
export type PlanCardAction = PlanExecutionBody["choix"] | "continuer";

/** Ordre des boutons (§4.9, point 4). */
export const PLAN_CARD_ORDER: readonly PlanCardAction[] = ["demander", "modifications", "autonome", "continuer"];

/** Icône de chaque bouton : celle du choix dans le sélecteur ; « Continuer à planifier » garde celle de « Plan d'abord ». */
export const PLAN_CARD_ICONS: Readonly<Record<PlanCardAction, MenuIcon>> = {
  demander: CHOICE_ICONS.demander,
  modifications: CHOICE_ICONS.modifications,
  autonome: CHOICE_ICONS.autonome,
  continuer: CHOICE_ICONS.plan,
};

const LIBELLES: Readonly<Record<PlanCardAction, string>> = {
  demander: TEXTES.partout.carte.executerDemander,
  modifications: TEXTES.partout.carte.executerModifications,
  autonome: TEXTES.partout.carte.executerAutonome,
  continuer: TEXTES.partout.carte.continuer,
};

const AUTOMATIC: ReadonlySet<PlanCardAction> = new Set<PlanCardAction>(["modifications", "autonome"]);

/** Choix automatique (confirmation sur 428, activation vérifiée par le serveur). */
export function isAutomaticAction(action: PlanCardAction): action is AutomaticChoice {
  return AUTOMATIC.has(action);
}

/** `aucune` : pas une conversation de plan (ou pas encore lue) ; `note` : phrase d'honnêteté seule ; `carte` : les quatre boutons. */
export type PlanCardDisplay = "aucune" | "note" | "carte";

export interface PlanCardButton {
  action: PlanCardAction;
  libelle: string;
  icone: MenuIcon;
  /** aria-disabled : le bouton reste focalisable pour que sa raison soit lue ; il ne fait rien. */
  desactive: boolean;
  raisonCode: ActivationRefusalCode | null;
  /** Phrase de la raison ; null si le bouton est utilisable. */
  raison: string | null;
}

export interface PlanCardReason {
  code: ActivationRefusalCode;
  texte: string;
}

export interface PlanCardModel {
  affichage: PlanCardDisplay;
  /** Nom de la carte : « Plan d'abord », avec l'icône de ce choix. */
  titre: string;
  icone: MenuIcon;
  /** Plafonds proposés à la confirmation d'un choix automatique (vue du serveur) ; null hors d'une conversation de plan. */
  plafonds: AutonomyCaps | null;
  /** §4.9, point 6 (F-g). */
  honnetete: string;
  boutons: PlanCardButton[];
  /** Raisons distinctes des boutons désactivés, dans l'ordre des boutons : une ligne chacune, qui décrit ses boutons. */
  raisons: PlanCardReason[];
}

/** Réponse terminée lue pour une conversation (la lecture d'une autre conversation est ignorée). */
export interface PlanAnswer {
  rootId: string;
  answered: boolean;
}

export interface PlanCardInput {
  /** Conversation affichée. */
  rootId: string;
  /** Vue du serveur (GET …/autonomie) ; null tant qu'elle n'est pas lue, ou si la lecture a échoué. */
  view: ConversationAutonomyView | null;
  /** null tant que les messages ne sont pas lus. */
  answer: PlanAnswer | null;
  /** La racine travaille. */
  busy: boolean;
  /** Partie `autonomy` de /api/bootstrap ; absente : interrupteur ouvert, activation fermée (porte I1). */
  boot?: BootstrapAutonomy | undefined;
}

/** Raison qui ferme les choix automatiques, ou null s'ils peuvent être demandés (le serveur vérifie encore l'activation). */
function automaticRefusal(view: ConversationAutonomyView, boot: BootstrapAutonomy | undefined): ActivationRefusalCode | null {
  if (view.interrupteur === false || boot?.interrupteur === false) return "autonomie-coupee";
  if (boot?.activationOuverte !== true) return "a-venir";
  return null;
}

/** Carte de la conversation `rootId`, à partir de la vue du serveur, des messages lus et de l'amorçage. */
export function buildPlanCard(input: PlanCardInput): PlanCardModel {
  const view = input.view !== null && input.view.rootId === input.rootId ? input.view : null;
  const titre = CHOIX.partout.choix.plan.libelle;
  const icone = CHOICE_ICONS.plan;
  const honnetete = TEXTES.partout.honnetete;
  if (view === null || view.choix !== "plan") return { affichage: "aucune", titre, icone, honnetete, plafonds: null, boutons: [], raisons: [] };
  const answered = input.answer !== null && input.answer.rootId === input.rootId && input.answer.answered;
  const refusal = automaticRefusal(view, input.boot);
  const boutons = PLAN_CARD_ORDER.map((action): PlanCardButton => {
    const code = isAutomaticAction(action) ? refusal : null;
    return {
      action,
      libelle: LIBELLES[action],
      icone: PLAN_CARD_ICONS[action],
      desactive: code !== null,
      raisonCode: code,
      raison: code === null ? null : raisonRefus(code),
    };
  });
  const raisons: PlanCardReason[] = [];
  for (const bouton of boutons) {
    if (bouton.raisonCode === null || bouton.raison === null || raisons.some((r) => r.code === bouton.raisonCode)) continue;
    raisons.push({ code: bouton.raisonCode, texte: bouton.raison });
  }
  return { affichage: answered && !input.busy ? "carte" : "note", titre, icone, honnetete, plafonds: view.plafonds, boutons, raisons };
}

/** Effet d'un clic : rien (bouton désactivé, ou exécution déjà en cours), une exécution, ou le retour à la saisie. */
export type PlanClickEffect = "rien" | "executer" | "continuer";

export function clickEffect(bouton: PlanCardButton, pending: boolean): PlanClickEffect {
  if (bouton.desactive || pending) return "rien";
  return bouton.action === "continuer" ? "continuer" : "executer";
}

/** Erreur d'autonomie lue dans la réponse (autonomyError de web/lib/api-autonomy.ts), sans dépendre du client HTTP. */
export interface ExecutionErrorInfo {
  error: AutonomyErrorCode;
  raison?: ActivationRefusalCode | undefined;
}

/** Suite d'une exécution refusée : confirmation d'un choix automatique, ou phrase à afficher dans la carte. */
export type ExecutionFailure = { kind: "confirmer"; choix: AutomaticChoice } | { kind: "message"; texte: string };

/**
 * Suite d'un refus de POST /api/plans/:id/execution pour `action`. `error` : erreur d'autonomie de la réponse, sinon null ;
 * `texte` : phrase du serveur (ou du client HTTP) ; `confirmed` : l'appel portait x-cockpit-confirm: 1. Seul un 428 d'un choix
 * automatique envoyé sans en-tête ouvre la confirmation : jamais deux fois de suite, jamais pour « Demander à chaque fois ».
 */
export function executionFailure(action: PlanExecutionBody["choix"], error: ExecutionErrorInfo | null, texte: string, confirmed: boolean): ExecutionFailure {
  if (error?.error === "confirmation-requise" && !confirmed && isAutomaticAction(action)) return { kind: "confirmer", choix: action };
  if (error?.raison !== undefined) return { kind: "message", texte: raisonRefus(error.raison) };
  return { kind: "message", texte };
}

// --- Réponse terminée ---------------------------------------------------------------------------------------------------------

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

/** Message d'IA terminé sans erreur, hors résumé : même filtre que lastPlanText (plans.ts). */
function completedAnswer(info: unknown): info is Record<string, unknown> {
  if (!isRecord(info)) return false;
  const time = isRecord(info.time) ? info.time : {};
  return info.role === "assistant" && typeof time.completed === "number" && info.error === undefined && info.summary !== true;
}

/** Au moins une réponse terminée avec un texte (hors texte synthétique ou ignoré) : le serveur a un plan à exécuter. */
export function planAnswered(messages: unknown): boolean {
  if (!Array.isArray(messages)) return false;
  return messages.some((message: unknown) => {
    if (!isRecord(message) || !completedAnswer(message.info) || !Array.isArray(message.parts)) return false;
    return (message.parts as unknown[]).some(
      (part) => isRecord(part) && part.type === "text" && part.synthetic !== true && part.ignored !== true && typeof part.text === "string" && part.text.trim() !== "",
    );
  });
}

/** `message.updated` : un message d'IA de `rootId` vient de se terminer (les messages sont alors relus). */
export function answerCompleted(info: unknown, rootId: string): boolean {
  return isRecord(info) && info.sessionID === rootId && completedAnswer(info);
}

/** Racine visée par un événement `autonomie.choix` (données non fiables : lues avec prudence). */
export function choiceEventRoot(data: unknown): string | null {
  if (!isRecord(data)) return null;
  return typeof data.rootId === "string" ? data.rootId : null;
}
