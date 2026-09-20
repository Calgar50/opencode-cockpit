// Propriétaire : L10e.
// Délégation en « Autonome avec contrôle » (spécification §4.7 D1-D7, §4.8.1 plafond de délégations, §3.14 ; décisions n° 4 et
// n° 9 ; §6 ligne « En mode Simple, l'IA ne délègue pas » ; plan d'exécution, fiche L10e) : le port `delegationPolicy`, appelé par
// le cycle (L10a) pour une demande `task` d'une conversation en « Autonome avec contrôle », et par lui seul.
// 1. FAITS : `ports.taskGuard.collectDelegationFacts()` (L1d), exporté et documenté pour cet usage ; la collecte n'est pas
//    réécrite ici (cible de `GET /agent`, `task_id` dans l'arbre, consigne lue dans la partie d'outil, IA au catalogue,
//    `ledger.guardRuns`, délégations lancées et reste des plafonds depuis le début de la demande).
// 2. RÈGLES : `classifyDelegation()` (server/shared/autonomy-rules.ts, L9b) applique D1 à D7 dans l'ordre de la spécification ;
//    aucune règle n'est réécrite ici. Les plafonds sont ceux de la demande autonome en cours (`ports.requests`), sinon ceux de la
//    conversation (`conversationCaps`) : D6 compare les délégations lancées à `delegationsMax`, D7 l'estimation au reste.
// 3. SUITES : « auto » → le cycle relaie un « once » par le portillon (`gate.relayOnce`), après `ledger.guardRuns` (D5) et sous
//    les plafonds (D6, D7) : aucun appel facturé ne part d'ici (P5). « attente » (mode Avancé) → la demande attend votre accord,
//    avec la carte détaillée (L1f, L12b) et la règle en cause. « refus » (mode Simple, décision n° 4) → refus avec message à l'IA
//    par `gate.rejectWhenAlone` (retenue F-c : jamais envoyé pendant qu'une autre demande de la conversation attend, mesure MX1
//    §3.5), puis `work.markWait(…, « cockpit »)` et fait « reponse », comme le refus Simple de L1d.
// 4. ENFANTS : le choix est celui de la RACINE (le cycle résout la racine avant d'appeler ce port) et les plafonds comptent le
//    travail délégué de toute la conversation : un enfant suit donc le choix de la racine sans rien décider lui-même. Il hérite des
//    refus de session par son plancher (L3) et ne pose pas de question (`question: deny`).
// P4 : ce module n'envoie jamais « allow », « ask » ni « always », et jamais de « once » ; le seul envoi possible est le refus
// Simple, par le portillon (inscrit au registre avant l'envoi). P5 : aucun appel facturé, aucune confirmation du garde-fou
// budgétaire (`guardRuns` est appelé par L1d sans confirmation). P6 : lectures seules, aucun redémarrage d'opencode.
// Aucune phrase n'est écrite ici : le seul texte, le message joint au refus Simple, vient de shared/delegation-texts.ts (L1d) ;
// l'avis affiché en mode Simple garde le texte court de la décision n° 4 jusqu'aux équipes (L38).
// Repli M9 (`REPLI_ATTENTE_SIMPLE`, L1d, désactivé) : levé, il vaut aussi en Autonome — plus aucun refus d'office, la délégation
// attend votre accord. La recette M9 reste EN ATTENTE (facturée, non autorisée).
// 5. SORT DU REFUS RENDU AU CYCLE (`input.onRefusalSettled`) : le refus part hors de l'appel, car la retenue F-c dure jusqu'à 45 s
//    et le cycle examine une demande à la fois par conversation (l'attendre bloquerait, et retiendrait la demande voisine qui,
//    elle, retient le refus). Le cycle écrit donc d'abord une ligne « attente », vraie à cet instant, puis la décision
//    « Refusé automatiquement » quand ce rappel dit « ok ». Le Journal ne dit jamais un refus qui n'est pas parti.
// Limites (dites) : resté « retenu » à la borne ou en échec, rien n'est envoyé, aucun fait n'est écrit et la demande attend votre
// accord. Au-delà de REFUS_EN_COURS_MAX refus en cours, aucun n'est lancé et la délégation attend votre accord. Faits ou plafonds
// illisibles : attente, jamais un refus sans certitude.
// neutralDelegationPolicy reste exporté et inchangé : c'est le port des tests qui ne déclarent pas ce module (plan §2.2).
import { conversationCaps } from "./autonomy-requests.ts";
import type { Cockpit11, Cockpit11Module, DelegationPolicyInput, DelegationPolicyPort, DelegationPolicyVerdict, WaitUpsert } from "./contracts-11.ts";
import { errorMessage } from "./log.ts";
import { assertFact } from "./shared/activity-facts.ts";
import type { ActivityFact, ReponseFactData } from "./shared/activity-types.ts";
import { classifyDelegation } from "./shared/autonomy-rules.ts";
import type { AutonomyCaps, DelegationFacts, RelayOutcome } from "./shared/autonomy-types.ts";
import { messageRefusSimple } from "./shared/delegation-texts.ts";
import { REPLI_ATTENTE_SIMPLE } from "./task-once-guard.ts";

export function neutralDelegationPolicy(): DelegationPolicyPort {
  return {
    decide: async () => ({ verdict: "attente", regle: null }),
  };
}

/**
 * Règle rendue quand les faits d'une délégation ou les plafonds de la conversation ne se lisent pas (opencode muet, demande
 * disparue, base illisible) : la même que le cycle pose pour une donnée illisible (§4.3), jamais une règle D inventée. Elle n'est
 * pas dans REPRISE_POSSIBLE : une relecture de `GET /permission` la redéciderait à l'identique.
 */
export const FAITS_ILLISIBLES_RULE = "X-illisible";

/** Refus Simple en cours au plus ; au-delà, aucun n'est lancé et la délégation attend votre accord (même borne que L1d). */
export const REFUS_EN_COURS_MAX = 64;

export interface DelegationPolicyOptions {
  now?: () => number;
  /** Repli M9 (défaut REPLI_ATTENTE_SIMPLE, L1d) : aucun refus d'office, la délégation attend votre accord. */
  repliAttenteSimple?: boolean;
  /** Travail lancé hors de l'appel (défaut : microtâche) ; les tests l'imposent pour observer les refus en cours. */
  defer?: (fn: () => void) => void;
}

export interface DelegationPolicyService {
  port: DelegationPolicyPort;
  /** Refus Simple en cours (tests). */
  refusEnCours(): string[];
}

export function createDelegationPolicy(c11: Cockpit11, options: DelegationPolicyOptions = {}): DelegationPolicyService {
  const now = options.now ?? Date.now;
  const defer = options.defer ?? queueMicrotask;
  const repli = options.repliAttenteSimple ?? REPLI_ATTENTE_SIMPLE;
  const log = c11.log;
  /** Refus Simple lancés et pas encore terminés : un même refus n'est jamais lancé deux fois. */
  const running = new Set<string>();
  /** Rappels du cycle qui attendent le sort d'un refus lancé, par demande d'autorisation ; vidés dès que le sort est connu. */
  const waiting = new Map<string, Array<NonNullable<DelegationPolicyInput["onRefusalSettled"]>>>();

  /**
   * Plafonds qui s'appliquent à la délégation (§4.8.1) : ceux de la demande autonome en cours, sinon ceux de la conversation
   * (réglages bornés), comme le cycle les lit. null : illisibles — la délégation attend, elle n'est jamais refusée sur une lecture
   * manquée.
   */
  const capsOf = (rootId: string): AutonomyCaps | null => {
    try {
      return c11.ports.requests.current(rootId)?.plafonds ?? conversationCaps(c11, rootId);
    } catch (err) {
      log.warn("délégation : plafonds de la conversation illisibles", { rootId, error: errorMessage(err) });
      return null;
    }
  };

  /** Attente d'accord close et fait « reponse », une fois le refus Simple parti (écrivain unique des tables : ports.facts, L4b). */
  const record = (input: DelegationPolicyInput, target: string | null): void => {
    const wait: WaitUpsert = { permissionId: input.permissionId, sessionId: input.sessionId, rootId: input.rootId, permission: "task", target };
    try {
      c11.ports.facts.work.markWait(wait, "reject", "cockpit");
    } catch (err) {
      log.warn("délégation refusée : attente d'accord non enregistrée", { permissionId: input.permissionId, error: errorMessage(err) });
    }
    const data: ReponseFactData = { reponse: "reject", par: "cockpit" };
    const fact: ActivityFact = { rootId: input.rootId, sessionId: input.sessionId, kind: "reponse", ref: input.permissionId, data, at: now() };
    try {
      c11.ports.facts.append([assertFact(fact)]);
    } catch (err) {
      log.warn("délégation refusée : fait non enregistré", { permissionId: input.permissionId, error: errorMessage(err) });
    }
  };

  /**
   * Refus Simple d'une délégation hors des règles ou des plafonds (§4.7, décision n° 4) : message à l'IA, retenu par le portillon
   * tant qu'une autre demande de la conversation attend (F-c) — votre autre demande n'est jamais annulée. Rien n'est écrit au nom
   * du cockpit quand le refus n'est pas parti (retenu à la borne, demande déjà répondue ou expirée, échec).
   */
  const refuse = async (input: DelegationPolicyInput, target: string | null, regle: string | null): Promise<void> => {
    const outcome = await c11.gate.rejectWhenAlone(input.permissionId, input.sessionId, input.directory, messageRefusSimple(), "cockpit");
    if (outcome === "ok") {
      log.info("délégation refusée : mode Simple, délégation hors des règles ou des plafonds", { rootId: input.rootId, permissionId: input.permissionId });
      record(input, target);
    } else if (outcome === "retenu") {
      log.info("délégation : refus retenu jusqu'à la borne, la demande attend votre accord", { rootId: input.rootId, permissionId: input.permissionId });
    } else {
      log.warn("délégation : refus non relayé", { rootId: input.rootId, permissionId: input.permissionId, relais: outcome });
    }
    // Sort rendu au cycle (L10a), écrivain unique du Journal : lui seul décide quelle ligne écrire, et seulement une fois le
    // sort connu. Une erreur du rappel ne doit pas changer ce que ce module a fait : elle est dite, jamais propagée.
    settle(input.permissionId, outcome, regle);
  };

  /**
   * Sort du refus rendu au cycle, une seule fois (même en échec) : sans lui, le Journal garderait une ligne « attente » qui ne
   * deviendra jamais la décision, ou dirait un refus qui n'est pas parti. Tous les examens qui ont mené à CE refus sont prévenus.
   */
  const settle = (permissionId: string, outcome: RelayOutcome | "retenu", regle: string | null): void => {
    const hooks = waiting.get(permissionId) ?? [];
    waiting.delete(permissionId);
    for (const hook of hooks) {
      try {
        hook(outcome, regle);
      } catch (err) {
        log.warn("délégation : sort du refus non rendu au cycle", { permissionId, error: errorMessage(err) });
      }
    }
  };

  /** Lance le refus Simple hors de l'appel ; false : non lancé (borne atteinte), la délégation attend votre accord. */
  const startRefusal = (input: DelegationPolicyInput, target: string | null, regle: string | null): boolean => {
    const enCours = running.has(input.permissionId);
    if (!enCours && running.size >= REFUS_EN_COURS_MAX) {
      log.warn("délégation : refus non lancé, trop de refus en cours ; la demande attend votre accord", { permissionId: input.permissionId });
      return false;
    }
    // Un second examen de la même demande ne relance rien, mais son rappel attend le même sort : aucune ligne « attente » orpheline.
    const hook = input.onRefusalSettled;
    if (hook !== undefined) waiting.set(input.permissionId, [...(waiting.get(input.permissionId) ?? []), hook]);
    if (enCours) return true;
    running.add(input.permissionId);
    defer(() => {
      refuse(input, target, regle)
        .catch((err: unknown) => {
          log.warn("délégation : refus en échec", { permissionId: input.permissionId, error: errorMessage(err) });
          settle(input.permissionId, "echec", regle);
        })
        .finally(() => running.delete(input.permissionId));
    });
    return true;
  };

  /**
   * Suite d'une demande `task` en « Autonome avec contrôle » (§4.7) : faits (L1d), règles D1 à D7 (L9b), puis « auto » (le cycle
   * relaie le « once »), « attente » (carte détaillée en Avancé) ou « refus » (mode Simple, envoyé ici).
   */
  const decide: DelegationPolicyPort["decide"] = async (input): Promise<DelegationPolicyVerdict> => {
    let facts: DelegationFacts;
    try {
      facts = await c11.ports.taskGuard.collectDelegationFacts({
        rootId: input.rootId,
        sessionId: input.sessionId,
        permissionId: input.permissionId,
        directory: input.directory,
      });
    } catch (err) {
      log.info("délégation : faits illisibles, la demande attend votre accord", { permissionId: input.permissionId, error: errorMessage(err) });
      return { verdict: "attente", regle: FAITS_ILLISIBLES_RULE };
    }
    const caps = capsOf(input.rootId);
    if (caps === null) return { verdict: "attente", regle: FAITS_ILLISIBLES_RULE };
    const verdict = classifyDelegation(facts, caps, input.mode);
    if (verdict.verdict !== "refus") return verdict;
    // Mode Simple seulement (classifyDelegation) : l'IA continue seule (décision n° 4). Repli M9 levé, ou refus non lancé à la
    // borne : la demande attend votre accord, avec la même règle.
    if (repli || !startRefusal(input, facts.target?.name ?? null, verdict.regle)) return { verdict: "attente", regle: verdict.regle };
    return verdict;
  };

  return { port: { decide }, refusEnCours: () => [...running] };
}

/** Module « delegationPolicy » avec une horloge, un ordonnanceur ou le repli M9 injectés (tests). Production : delegationPolicyModule. */
export function delegationPolicyModuleWith(options: DelegationPolicyOptions = {}): Cockpit11Module {
  return {
    name: "delegationPolicy",
    install(_reg, c11) {
      c11.ports.delegationPolicy = createDelegationPolicy(c11, options).port;
    },
  };
}

export const delegationPolicyModule: Cockpit11Module = delegationPolicyModuleWith();
