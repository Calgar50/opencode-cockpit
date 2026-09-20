// Propriétaire : L12b.
// État d'une demande d'autorisation vu par le contrôle : « Contrôle de sécurité en cours… » ou « En attente de votre accord » ·
// « Règle : … » (spécification §4.3 étapes 6 et 7, §4.13), dans la carte de la demande (Interactions.tsx, qui porte les boutons).
// Propriétés figées dans ../slots.ts. Toute la logique est dans le modèle pur server/shared/autonomy-view.ts (carteVue, bascule
// des boutons à 60 s) : ce composant ne fait que rendre ce qu'il décide, sans texte ni condition à lui. Aucune animation.
// Les textes venus d'une IA (raison) sont masqués et bornés par le modèle, puis rendus comme du texte par React (jamais de HTML).
import { useEffect, useMemo, useRef, useState } from "react";
import {
  avecDecision,
  avecExamen,
  carteVue,
  type DecisionEvenement,
  ETATS_VIDES,
  type EtatsDemandes,
  prochaineBascule,
  sansDemande,
  vueEtats,
} from "../../../../server/shared/autonomy-view.ts";
import { useApp } from "../../../app/AppContext.tsx";
import { Icon } from "../../../components/Icon.tsx";
import { cockpitEvent, opencodeEvent, useEvents } from "../../../lib/events.ts";
import type { DecisionStatusProps, PermissionAutonomyState } from "../slots.ts";
import "./autonomy-cards.css";

export function DecisionStatus({ examining, decision }: DecisionStatusProps) {
  const { advanced, boot } = useApp();
  const vue = carteVue({
    examining,
    decision,
    mode: advanced ? "avance" : "simple",
    controleIa: boot.settings.budget.autonomie.controleIa === true,
  });
  if (vue === null) return null;
  return (
    <div className="decision-status" data-etat={vue.etat}>
      <p className="decision-status-titre">
        <Icon name={vue.icone} size={14} />
        <span>{vue.titre}</span>
      </p>
      {vue.regle ? <p className="decision-status-ligne">{vue.regle}</p> : null}
      {vue.raison ? <p className="decision-status-ligne">{vue.raison}</p> : null}
    </div>
  );
}

/** Champ texte d'un événement du flux (données non fiables : lues avec prudence, jamais supposées). */
function champ(data: unknown, nom: string): string | null {
  if (typeof data !== "object" || data === null) return null;
  const valeur = (data as Record<string, unknown>)[nom];
  return typeof valeur === "string" ? valeur : null;
}

/** Décision du contrôle portée par un événement `autonomie.decision`, si elle est lisible. */
function decisionDe(data: unknown): DecisionEvenement | null {
  if (typeof data !== "object" || data === null) return null;
  const brut = data as Record<string, unknown>;
  const sessionId = champ(brut, "sessionId");
  const verdict = champ(brut, "verdict");
  const par = champ(brut, "par");
  if (sessionId === null || verdict === null || par === null) return null;
  return {
    sessionId,
    permissionId: champ(brut, "permissionId"),
    verdict: verdict as DecisionEvenement["verdict"],
    regle: champ(brut, "regle") ?? "",
    raison: champ(brut, "raison") ?? "",
    par: par as DecisionEvenement["par"],
  };
}

/**
 * États d'examen et de décision des demandes d'une conversation (événements `autonomie.examen` et `autonomie.decision`), par
 * identifiant de demande. Appelé une fois par ChatPage ; `examining` repasse à false au plus tard après 60 s (EXAMEN_BOUTONS_MS),
 * par UNE minuterie posée sur la prochaine échéance, jamais par une horloge qui tourne. Une demande répondue est oubliée.
 */
export function useDecisionStates(rootId: string | null): ReadonlyMap<string, PermissionAutonomyState> {
  const [etats, setEtats] = useState<EtatsDemandes>(ETATS_VIDES);
  /** Avance à chaque échéance de bascule : recalcule les vues sans rien changer aux états. */
  const [tick, setTick] = useState(0);
  const rootRef = useRef(rootId);
  rootRef.current = rootId;

  useEffect(() => {
    setEtats(ETATS_VIDES);
  }, [rootId]);

  useEvents((event) => {
    const racine = rootRef.current;
    if (racine === null) return;
    const examen = cockpitEvent(event, "autonomie.examen");
    if (examen !== null && champ(examen.data, "rootId") === racine) {
      const permissionId = champ(examen.data, "permissionId");
      if (permissionId !== null) setEtats((current) => avecExamen(current, permissionId, Date.now()));
      return;
    }
    const decision = cockpitEvent(event, "autonomie.decision");
    if (decision !== null && champ(decision.data, "rootId") === racine) {
      const lue = decisionDe(decision.data);
      if (lue !== null) setEtats((current) => avecDecision(current, lue));
      return;
    }
    const repondue = opencodeEvent(event, "permission.replied");
    if (repondue !== null) {
      const id = champ(repondue.properties, "requestID");
      if (id !== null) setEtats((current) => sansDemande(current, id));
    }
  });

  // Bascule des boutons : une seule minuterie, posée sur l'examen qui finit le plus tôt (0 : la bascule est due).
  useEffect(() => {
    const delai = prochaineBascule(etats, Date.now());
    if (delai === null) return;
    const handle = window.setTimeout(() => setTick((n) => n + 1), delai + 1);
    return () => window.clearTimeout(handle);
  }, [etats, tick]);

  return useMemo(() => vueEtats(etats, Date.now()), [etats, tick]);
}
