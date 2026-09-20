// Propriétaire : L10d.
// Activation des choix automatiques (spécification §4.10, §4.11 ; décisions n° 13 et n° 14 ; plan d'exécution, fiche L10d) :
// - port `activation` : faits relevés en lecture seule (activation-facts.ts), verdict rendu par activationRefusal
//   (server/shared/autonomy-rules.ts, L9b) ; règles `allow` de l'assistant (edit, bash hors pwd, task, webfetch, websearch),
//   `mcp` ou `plugin` déclarés, profil « Sans confirmation (déconseillé) » actif, plancher non vérifié, interrupteur coupé ;
// - porte I1 (plan §2.6) : tant qu'ACTIVATION_OUVERTE est fausse, `check` rend EXACTEMENT le refus du port neutre
//   (« a-venir »), sans aucune lecture, même pour une configuration parfaitement conforme, et le module reste inerte comme le
//   port neutre : il n'inscrit alors aucun crochet. La bascule de la constante, une ligne de l'intégrateur dans wiring-11.ts,
//   pose le crochet et ouvre les verdicts réels ; ce paquet ne la touche pas ;
// - crochet `beforeBilledSend` (rang `activation`, après floors et plans) : un envoi facturé d'une conversation en choix
//   automatique dont l'assistant visé n'est plus conforme ramène la conversation à « Demander à chaque fois » (ligne, événement
//   et fait « choix », cause `agent-non-conforme`), puis répond 409 `autonomie-indisponible {raison}`.
// La confirmation (428) et le bornage des plafonds restent dans conversation-autonomy.ts (L6a), qui appelle ce port.
// Le port rend des CODES ; la seule phrase écrite ici vient des modules de textes (raisonRefus, L9b).
// neutralActivation reste exporté et inchangé : c'est le port des tests qui ne déclarent pas ce module (plan §2.2).
import { collectActivationFacts } from "./activation-facts.ts";
import type { ActivationPort, ActivationVerdict, Cockpit11, Cockpit11Module, ProxyContext, Registrar } from "./contracts-11.ts";
import { returnToAsk } from "./conversation-autonomy.ts";
import { errorMessage } from "./log.ts";
import { type ActivationFacts, activationRefusal } from "./shared/autonomy-rules.ts";
import { raisonRefus } from "./shared/autonomy-texts.ts";
import type { ActivationRefusalCode, AutonomyErrorBody } from "./shared/autonomy-types.ts";
import { ID_RE } from "./shared/ids.ts";

export function neutralActivation(): ActivationPort {
  return {
    check: async () => ({ ok: false, raison: "a-venir" }),
  };
}

/** Nom d'assistant lu dans le corps d'un envoi : entrée externe, bornée comme dans le proxy. */
const AGENT_MAX = 200;

/**
 * Porte I1 fermée : faits d'une configuration parfaitement conforme dont seule la porte manque. activationRefusal en tire
 * « a-venir », la phrase fixée par le contrat (autonomy-types.ts) : le refus du port neutre, au code près.
 */
const PORTE_FERMEE: ActivationFacts = Object.freeze({
  interrupteur: true,
  activationOuverte: false,
  agentRules: Object.freeze([]),
  mcpOuExtension: false,
  profilSansConfirmation: false,
  plancherVerifie: true,
});

const verdictOf = (code: ActivationRefusalCode | null): ActivationVerdict => (code === null ? { ok: true } : { ok: false, raison: code });

export interface ActivationOptions {
  /** ACTIVATION_OUVERTE (porte I1) : la fabrique le reçoit, le module le lit par c11.activationOuverte, les tests l'imposent. */
  activationOuverte: boolean;
}

export interface ActivationService {
  port: ActivationPort;
  /** Crochet beforeBilledSend ; inscrit seulement quand la porte est ouverte (le module est inerte sinon). */
  beforeBilledSend(ctx: ProxyContext): Promise<Response | null>;
}

/**
 * Fabrique du port d'activation, pure au sens où la porte lui est passée : `install` l'appelle avec c11.activationOuverte, les
 * tests avec l'une et l'autre valeur, sans toucher wiring-11.ts ni le harnais (plan §2.6, §2.8).
 */
export function createActivationPort(c11: Cockpit11, options: ActivationOptions): ActivationService {
  /**
   * Refus d'activation d'un choix automatique, réévalué à chaque appel (§4.11). Les deux choix automatiques ont les mêmes
   * refus : `choix` n'entre pas dans le verdict, il n'est là que pour l'appelant et les journaux.
   */
  const check: ActivationPort["check"] = async (input) => {
    if (options.activationOuverte !== true) return verdictOf(activationRefusal(PORTE_FERMEE));
    const facts = await collectActivationFacts(c11, {
      sessionId: input.rootId,
      agent: input.agent,
      directory: input.directory,
      activationOuverte: true,
    });
    return verdictOf(activationRefusal(facts));
  };

  /**
   * Envoi facturé d'une conversation en choix automatique : l'activation est revérifiée avec l'assistant VISÉ par cet envoi
   * (celui du corps, sinon celui de la session). Non conforme → retour à « Demander à chaque fois » et 409, avant tout relais :
   * rien n'est facturé. Les autres choix ne sont pas concernés ; le port d'activation est relu à chaque envoi (surcharges).
   */
  const beforeBilledSend = async (ctx: ProxyContext): Promise<Response | null> => {
    const sessionId = ctx.sessionId;
    // Session illisible : déjà refusée par le crochet « floors », qui passe avant (STEP_ORDER).
    if (sessionId === null || !ID_RE.test(sessionId)) return null;
    const row = c11.sessions.get(sessionId) ?? (await c11.sessions.ensure(sessionId, ctx.directory ?? undefined));
    const rootId = row?.root_id ?? sessionId;
    const choix = c11.ports.conversationAutonomy.choiceOf(rootId);
    if (choix !== "modifications" && choix !== "autonome") return null;
    const sent = typeof ctx.body.agent === "string" && ctx.body.agent.length > 0 ? ctx.body.agent.slice(0, AGENT_MAX) : null;
    const verdict = await c11.ports.activation.check({ rootId, choix, agent: sent ?? row?.agent ?? null, directory: ctx.directory || row?.directory || null });
    if (verdict.ok) return null;
    try {
      // Ligne, événement autonomie.choix et fait « choix » (data.cause) par le port des faits : la reprise est visible.
      returnToAsk(c11, "agent-non-conforme", { rootId });
    } catch (err) {
      c11.log.warn("activation : retour à « demander » non enregistré", { rootId, error: errorMessage(err) });
    }
    c11.log.info("activation : assistant non conforme à l'envoi, retour à « demander »", { sessionId, rootId, raison: verdict.raison });
    const body: AutonomyErrorBody = { error: "autonomie-indisponible", message: raisonRefus(verdict.raison), raison: verdict.raison };
    return Response.json(body, { status: 409 });
  };

  return { port: { check }, beforeBilledSend };
}

/** Pose le port et, porte ouverte, le crochet d'envoi. Rend le service (tests de la fabrique installée). */
export function installActivation(reg: Registrar, c11: Cockpit11, options: ActivationOptions): ActivationService {
  const service = createActivationPort(c11, options);
  c11.ports.activation = service.port;
  if (options.activationOuverte === true) reg.hook("beforeBilledSend", (ctx) => service.beforeBilledSend(ctx));
  return service;
}

export const activationModule: Cockpit11Module = {
  name: "activation",
  install(reg, c11) {
    installActivation(reg, c11, { activationOuverte: c11.activationOuverte });
  },
};
