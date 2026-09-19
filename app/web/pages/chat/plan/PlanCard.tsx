// Propriétaire : L6c.
// Carte de plan, en fin de fil de toute conversation (spécification §4.9 points 4 à 6, §4.11 l.776, I7 ; plan d'exécution, fiche
// L6c). Propriétés figées dans ../slots.ts. Elle ne montre rien hors d'une conversation de plan (GET …/autonomie, choix « plan ») ;
// dans une conversation de plan, la phrase d'honnêteté seule tant qu'aucune réponse n'est terminée ou que la racine travaille, puis,
// après chaque réponse, quatre boutons : [Exécuter en demandant à chaque fois] [… avec modifications automatiques] [… en autonome
// avec contrôle] [Continuer à planifier].
// - Exécuter : POST /api/plans/:id/execution sans en-tête. Sur 428 (choix automatique), <AutonomyConfirm> (propriétés de
//   ../slots.ts ; squelette T2 jusqu'à L12a), puis nouvel appel avec x-cockpit-confirm: 1 et les plafonds confirmés ; sur 403 ou
//   409, la raison dans la carte ; réussite : onOpenConversation(nouvelle racine, brouillon), l'utilisateur relit et envoie.
//   Réussite arrivée après un changement de conversation ou de page (carte démontée) : ni navigation ni saisie remplacée ; le
//   brouillon est gardé sous la conversation d'exécution et remis à la saisie quand elle s'ouvre (notification avec [Ouvrir]).
// - Boutons indisponibles (porte I1 fermée, COCKPIT_AUTONOMY=off) : aria-disabled, focalisables, décrits par leur raison.
// - Continuer à planifier : le focus revient à la saisie ; rien n'est envoyé.
// Modèle pur (affichage, raisons, suite d'un refus, réponse terminée) : ./plan-card.ts ; textes : server/shared/plan-texts.ts et
// autonomy-*-texts.ts, sans doublon ici. Aucune animation, aucun raccourci clavier.
import { useCallback, useEffect, useId, useRef, useState } from "react";
import { TEXTES as PLAN_TEXTES } from "../../../../server/shared/plan-texts.ts";
import { useApp } from "../../../app/AppContext.tsx";
import { Icon } from "../../../components/Icon.tsx";
import { useToast } from "../../../components/Toast.tsx";
import { errorText, oc } from "../../../lib/api.ts";
import { autonomyApi, autonomyError } from "../../../lib/api-autonomy.ts";
import { planApi } from "../../../lib/api-plans.ts";
import { cockpitEvent, opencodeEvent, useEvents } from "../../../lib/events.ts";
import { navigate } from "../../../lib/router.ts";
import type { ActivationRefusalCode, AutomaticChoice, AutonomyCaps, ConversationAutonomyView, PlanExecutionBody } from "../../../lib/types.ts";
import { AutonomyConfirm } from "../autonomy/AutonomyConfirm.tsx";
import type { PlanCardProps } from "../slots.ts";
import {
  answerCompleted,
  buildPlanCard,
  choiceEventRoot,
  clickEffect,
  executionFailure,
  type PlanAnswer,
  type PlanCardAction,
  type PlanCardButton,
  planAnswered,
} from "./plan-card.ts";
import "./plan.css";

/** Allure de chaque bouton : « Demander à chaque fois » en premier choix, « Continuer à planifier » en retrait. */
const VARIANTS: Readonly<Record<PlanCardAction, string>> = {
  demander: "btn primary",
  modifications: "btn",
  autonome: "btn",
  continuer: "btn ghost",
};

const PLAN = PLAN_TEXTES.partout;

/** Brouillons gardés au plus (exécutions créées pendant que vous étiez ailleurs, jamais ouvertes depuis) ; les plus anciens oubliés. */
const PENDING_DRAFTS_MAX = 20;

/**
 * Brouillons d'exécutions créées pendant que vous étiez sur une autre conversation ou une autre page, par conversation d'exécution :
 * la carte, montée dans toute conversation ouverte, les remet à la saisie quand vous ouvrez la leur, une seule fois.
 */
const pendingDrafts = new Map<string, string>();

function keepDraft(rootId: string, draft: string): void {
  pendingDrafts.delete(rootId);
  pendingDrafts.set(rootId, draft);
  while (pendingDrafts.size > PENDING_DRAFTS_MAX) {
    const oldest = pendingDrafts.keys().next().value;
    if (oldest === undefined) break;
    pendingDrafts.delete(oldest);
  }
}

export function PlanCard({ rootId, directory, busy, onOpenConversation }: PlanCardProps) {
  const { boot } = useApp();
  const toast = useToast();
  const baseId = useId();

  const [view, setView] = useState<ConversationAutonomyView | null>(null);
  const [answer, setAnswer] = useState<PlanAnswer | null>(null);
  /** Relecture des messages demandée (réponse terminée, flux rétabli). */
  const [answerTick, setAnswerTick] = useState(0);
  /** Bouton dont l'exécution est en cours ; null sinon. */
  const [pending, setPending] = useState<PlanCardAction | null>(null);
  /** Raison d'un refus ou phrase d'une erreur, affichée dans la carte jusqu'au prochain essai ou à la prochaine réponse. */
  const [message, setMessage] = useState<string | null>(null);
  /** Choix automatique en attente de confirmation (428). */
  const [confirm, setConfirm] = useState<AutomaticChoice | null>(null);

  /** Brouillon gardé pour la conversation affichée (elle vient d'être créée ailleurs) : relecture de pendingDrafts demandée. */
  const [draftTick, setDraftTick] = useState(0);

  /** Conversation affichée, lue après un appel : une réponse arrivée après un changement de conversation n'y est pas affichée. */
  const rootRef = useRef(rootId);
  rootRef.current = rootId;
  /** Dernier rappel reçu de ChatPage : celui du rendu courant, jamais celui d'un clic ancien. */
  const openRef = useRef(onOpenConversation);
  openRef.current = onOpenConversation;
  /** Carte montée : une exécution qui répond après son démontage (autre page) n'ouvre rien. */
  const mounted = useRef(false);
  /** Exécution en cours (garde synchrone contre un double clic, avant le rendu suivant). */
  const inflight = useRef(false);
  const viewSeq = useRef(0);
  const viewAbort = useRef<AbortController | null>(null);
  const answerSeq = useRef(0);
  const buttonRefs = useRef<Partial<Record<PlanCardAction, HTMLButtonElement | null>>>({});

  const model = buildPlanCard({ rootId, view, answer, busy, boot: boot.autonomy });
  const isPlan = model.affichage !== "aucune";

  /** Relit le choix de `id` ; un échec cache la carte (jamais une carte de plan supposée). */
  const refreshView = useCallback((id: string) => {
    viewAbort.current?.abort();
    const controller = new AbortController();
    viewAbort.current = controller;
    const seq = ++viewSeq.current;
    autonomyApi.get(id, controller.signal).then(
      (next) => {
        if (seq === viewSeq.current) setView(next);
      },
      (err: unknown) => {
        if (controller.signal.aborted || seq !== viewSeq.current) return;
        console.warn("carte de plan : lecture du choix impossible", errorText(err));
        setView(null);
      },
    );
  }, []);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  // Conversation d'exécution créée pendant que vous étiez ailleurs : son brouillon remplit la saisie quand vous l'ouvrez.
  useEffect(() => {
    const draft = pendingDrafts.get(rootId);
    if (draft === undefined) return;
    pendingDrafts.delete(rootId);
    openRef.current(rootId, draft);
  }, [rootId, draftTick]);

  // Changement de conversation : rien de l'ancienne ne reste (vue, réponse lue, phrase, confirmation).
  useEffect(() => {
    setView(null);
    setAnswer(null);
    setMessage(null);
    setConfirm(null);
    refreshView(rootId);
    return () => {
      viewSeq.current++;
      viewAbort.current?.abort();
    };
  }, [rootId, refreshView]);

  // Conversation de plan au repos : réponse terminée ou non, relue après chaque réponse. Jamais pour une autre conversation.
  useEffect(() => {
    if (!isPlan || busy) return;
    const seq = ++answerSeq.current;
    const id = rootId;
    oc.messages(id, directory).then(
      (messages) => {
        if (seq === answerSeq.current) setAnswer({ rootId: id, answered: planAnswered(messages) });
      },
      (err: unknown) => {
        if (seq === answerSeq.current) console.warn("carte de plan : lecture des messages impossible", errorText(err));
      },
    );
  }, [isPlan, busy, rootId, directory, answerTick]);

  // Une nouvelle réponse commence : la phrase de l'essai précédent n'a plus cours.
  useEffect(() => {
    if (busy) setMessage(null);
  }, [busy]);

  useEvents((event) => {
    if (cockpitEvent(event, "stream.reconnected")) {
      refreshView(rootId);
      setAnswerTick((tick) => tick + 1);
      return;
    }
    const choice = cockpitEvent(event, "autonomie.choix");
    if (choice) {
      if (choiceEventRoot(choice.data) === rootId) refreshView(rootId);
      return;
    }
    const updated = opencodeEvent(event, "message.updated");
    if (updated && isPlan && answerCompleted(updated.properties.info, rootId)) setAnswerTick((tick) => tick + 1);
  });

  const focusButton = (action: PlanCardAction) => {
    window.requestAnimationFrame(() => buttonRefs.current[action]?.focus());
  };

  /**
   * POST /api/plans/:id/execution. `plafonds` null : premier appel, sans en-tête ; sinon appel confirmé (x-cockpit-confirm: 1)
   * avec les plafonds de la confirmation.
   */
  const execute = async (action: PlanExecutionBody["choix"], plafonds: AutonomyCaps | null) => {
    if (inflight.current) return;
    inflight.current = true;
    const planRoot = rootId;
    const confirmed = plafonds !== null;
    setPending(action);
    setMessage(null);
    try {
      const body: PlanExecutionBody = plafonds === null ? { choix: action } : { choix: action, plafonds };
      const created = await planApi.execute(planRoot, body, { confirm: confirmed });
      // Conversation changée ou page quittée pendant l'appel (même garde que l'échec) : ni navigation, ni saisie remplacée. Le
      // brouillon attend l'ouverture de la conversation d'exécution, annoncée avec [Ouvrir] ; déjà affichée : remis tout de suite.
      if (!mounted.current || rootRef.current !== planRoot) {
        keepDraft(created.rootId, created.brouillon);
        if (mounted.current && rootRef.current === created.rootId) setDraftTick((tick) => tick + 1);
        else {
          toast.success(PLAN.executionCreee.titre, PLAN.executionCreee.message, {
            label: PLAN.executionCreee.ouvrir,
            onClick: () => navigate("chat", created.rootId),
          });
        }
        return;
      }
      setConfirm(null);
      onOpenConversation(created.rootId, created.brouillon);
    } catch (err) {
      // Conversation changée pendant l'appel : ni confirmation ni phrase sur une autre conversation.
      if (rootRef.current !== planRoot) return;
      const failure = executionFailure(action, autonomyError(err), errorText(err), confirmed);
      if (failure.kind === "confirmer") {
        setConfirm(failure.choix);
        return;
      }
      setConfirm(null);
      setMessage(failure.texte);
      if (confirmed) focusButton(action);
    } finally {
      inflight.current = false;
      setPending(null);
    }
  };

  const cancelConfirm = () => {
    const from = confirm;
    setConfirm(null);
    if (from !== null) focusButton(from);
  };

  /** Continuer à planifier : retour à la saisie de cette conversation de plan, sans rien envoyer. */
  const continuePlanning = () => {
    document.querySelector<HTMLTextAreaElement>(".composer-wrap textarea")?.focus();
  };

  const onClick = (bouton: PlanCardButton) => {
    const effect = clickEffect(bouton, pending !== null || inflight.current);
    if (effect === "continuer") continuePlanning();
    else if (effect === "executer" && bouton.action !== "continuer") void execute(bouton.action, null);
  };

  if (model.affichage === "aucune") return null;

  const titleId = `${baseId}-titre`;
  const noteId = `${baseId}-honnetete`;
  const reasonId = (code: ActivationRefusalCode) => `${baseId}-raison-${code}`;

  if (model.affichage === "note") {
    return (
      <p className="plan-note">
        <Icon name="lock" size={14} className="plan-icon" />
        <span>{model.honnetete}</span>
      </p>
    );
  }

  return (
    <section className="plan-card" aria-labelledby={titleId} aria-describedby={noteId}>
      <div className="plan-card-head">
        <Icon name={model.icone} size={16} className="plan-icon" />
        <h2 id={titleId} className="plan-card-title">
          {model.titre}
        </h2>
      </div>
      <p id={noteId} className="plan-card-honnetete">
        <Icon name="lock" size={14} className="plan-icon" />
        <span>{model.honnetete}</span>
      </p>
      <div className="plan-card-actions">
        {model.boutons.map((bouton) => (
          <button
            key={bouton.action}
            ref={(element) => {
              buttonRefs.current[bouton.action] = element;
            }}
            type="button"
            className={`${VARIANTS[bouton.action]} plan-card-button`}
            aria-disabled={bouton.desactive || pending !== null || undefined}
            aria-describedby={bouton.raisonCode ? reasonId(bouton.raisonCode) : undefined}
            aria-busy={pending === bouton.action || undefined}
            onClick={() => onClick(bouton)}
          >
            <Icon name={pending === bouton.action ? "hourglass" : bouton.icone} size={16} />
            <span>{bouton.libelle}</span>
          </button>
        ))}
      </div>
      {model.raisons.map((raison) => (
        <p key={raison.code} id={reasonId(raison.code)} className="plan-card-reason">
          <Icon name="lock" size={12} className="plan-icon" />
          <span>{raison.texte}</span>
        </p>
      ))}
      {message ? (
        <p role="alert" className="plan-card-message">
          <Icon name="alert" size={14} className="plan-icon" />
          <span>{message}</span>
        </p>
      ) : null}
      {model.plafonds ? (
        <AutonomyConfirm
          open={confirm !== null}
          choix={confirm ?? "autonome"}
          directory={directory}
          plafonds={model.plafonds}
          busy={pending !== null}
          onConfirm={(plafonds) => {
            if (confirm !== null) void execute(confirm, plafonds);
          }}
          onCancel={cancelConfirm}
        />
      ) : null}
    </section>
  );
}
