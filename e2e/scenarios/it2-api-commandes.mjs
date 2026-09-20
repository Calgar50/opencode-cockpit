// Scénario e2e de l'itération 2 (paquet L13) : `grep` automatique, `git status` en attente sur un dépôt piégé, et la MESURE M4
// (latence de l'autonomie) relevée sur ces décisions.
//
// Spécification §4.5 (porte déterministe : S3 consultation, S5 chemins, S6 git et G04), §4.6 (l'IA de contrôle n'est jamais
// consultée pour S1-S6), §4.12 (Journal : « Consultation dans le dossier de la conversation »), §6 lignes « Consultation dans le
// dossier de la conversation » et « L'IA de contrôle ne peut pas autoriser une commande interdite » ; plan d'exécution, fiche L13
// et §3.4 (M4 laissée aux e2e).
//
// Ce que le scénario établit, en « Autonome avec contrôle » :
//   1. `grep -rn 'TODO' src` dans le dépôt PROPRE de l'atelier part sans vous demander : règle A-grep, par « règles », « once »
//      relayé, raison « Consultation dans le dossier de la conversation » ;
//   2. `git status --short` y part aussi (A-git-status) : un dépôt sans clé de configuration ni hook ne lance aucun programme ;
//   3. dans le dépôt PIÉGÉ (`core.pager` dans `.git/config`), la même commande ATTEND : règle G04, aucune réponse relayée, et
//      AUCUNE session de contrôle n'a été créée (l'IA de contrôle n'est pas consultée avant S7) ;
//   4. M4 : la latence de l'autonomie, du `permission.asked` relayé par le cockpit au `permission.replied` qui suit, relevée sur
//      les décisions automatiques de ce scénario. C'est la latence du FAUX (aucune IA) : elle borne par le bas la mesure réelle,
//      qui reste une recette en attente (facturée).
//
// En dehors du mode « --faux », rien n'est scripté : le scénario le dit et s'arrête là.
import {
  activerAutonome,
  atelier,
  attendreDecisions,
  attendreDemandes,
  attendreIa,
  attendreQue,
  avecTemoinP6,
  commande,
  decisionAttente,
  decisionAuto,
  DOSSIER_ATELIER,
  DOSSIER_PIEGE,
  envoyerEtJouer,
  exiger,
  nonJoue,
  oc,
  releve,
  resume,
} from "./it2-api-commun.mjs";

/** Consultations du corpus de la sonde (fixture shell-corpus.json, 11 automatiques), reprises telles quelles. */
const GREP = "grep -rn 'TODO' src";
const GIT_STATUS = "git status --short";

export async function run(ctx) {
  atelier(ctx);
  if (ctx.mode !== "faux") {
    nonJoue(ctx, "porte des commandes en autonome", "aucun tour ne se script hors du faux opencode");
    return;
  }
  const ia = await attendreIa(ctx);
  const propre = oc(ctx, DOSSIER_ATELIER);
  const piege = oc(ctx, DOSSIER_PIEGE);
  const latences = [];

  await avecTemoinP6(ctx, async (temoin) => {
    // 1 et 2. Dépôt propre : la consultation et la consultation git passent sans demander.
    const racine = await propre.creerConversation("it2-api-commandes");
    await activerAutonome(ctx, racine.id);
    await envoyerEtJouer(ctx, propre, racine.id, { tools: [commande(GREP), commande(GIT_STATUS)], cost: 0.002 }, { ia });

    const [grep] = await attendreDecisions(ctx, racine.id, decisionAuto("A-grep"), { libelle: "grep automatique (A-grep)" });
    exiger(grep.par === "regles", `A-grep décidé par « ${grep.par} » au lieu des règles.`);
    exiger(grep.relais === "ok", `A-grep : relais « ${resume(grep.relais)} ».`);
    exiger(grep.resume === GREP, `A-grep : résumé « ${resume(grep.resume)} » au lieu de la commande.`);
    exiger(
      grep.raison === "Consultation dans le dossier de la conversation",
      `A-grep : raison « ${resume(grep.raison)} » au lieu de la phrase du §4.12.`,
    );
    const [status] = await attendreDecisions(ctx, racine.id, decisionAuto("A-git-status"), { libelle: "git status automatique (A-git-status)" });
    exiger(status.relais === "ok", `A-git-status : relais « ${resume(status.relais)} ».`);
    latences.push(...latencesDuTemoin(temoin));

    // 3. Dépôt piégé : la même commande attend, règle G04, sans aucun appel à l'IA de contrôle.
    const racinePiegee = await piege.creerConversation("it2-api-commandes-piege");
    await activerAutonome(ctx, racinePiegee.id);
    await envoyerEtJouer(ctx, piege, racinePiegee.id, { tools: [commande(GIT_STATUS)], cost: 0.002 }, { ia });

    const [g04] = await attendreDecisions(ctx, racinePiegee.id, decisionAttente("G04"), { libelle: "git status en attente sur dépôt piégé (G04)" });
    exiger(g04.par === "regles", `G04 décidé par « ${g04.par} » au lieu des règles.`);
    exiger(g04.relais === null, `G04 : une réponse a été relayée (${resume(g04.relais)}).`);
    exiger(g04.iaModel === null && g04.iaCost === null, `G04 : l'IA de contrôle a été consultée (${resume({ m: g04.iaModel, c: g04.iaCost })}).`);
    const attendues = await attendreDemandes(piege, (d) => d.sessionID === racinePiegee.id && d.permission === "bash", {
      libelle: "demande d'autorisation du dépôt piégé, toujours en attente",
    });
    exiger(attendues.length === 1, `${attendues.length} demande(s) en attente au lieu d'une.`);

    // Aucune session de contrôle créée : l'IA n'est jamais consultée pour S1-S6 (§6). Les sessions du dossier piégé sont la
    // racine et rien d'autre ; le contrôle, lui, crée une session enfant titrée « Contrôle de sécurité » (§4.6).
    const creations = (await temoin.requetes()).filter((r) => String(r.method).toUpperCase() === "POST" && r.pathname === "/session");
    const controles = creations.filter((r) => r.body?.title === "Contrôle de sécurité" || r.body?.metadata?.cockpit === "controle");
    exiger(controles.length === 0, `${controles.length} session(s) de contrôle créée(s) pour une commande refusée par S1-S6.`);

    // L'utilisateur refuse : la pile revient au repos pour les scénarios suivants.
    const refus = await piege.repondre(attendues[0].id, "reject");
    exiger(refus.code === 200 || refus.code === 204, `refus de l'utilisateur : code ${refus.code} (${resume(refus.corps)}).`);
    await attendreQue(async () => ((await piege.demandes()) ?? []).length === 0, { libelle: "plus aucune demande en attente dans le dépôt piégé" });
  });

  // 4. M4 : latence de l'autonomie, relevée sur les décisions automatiques de ce scénario (faux opencode, aucune IA).
  exiger(latences.length >= 2, `M4 : ${latences.length} latence(s) relevée(s), deux attendues (grep et git status).`);
  const moyenne = Math.round(latences.reduce((a, b) => a + b, 0) / latences.length);
  releve(
    ctx,
    `M4 (faux) : latence de l'autonomie, du permission.asked au permission.replied, ${latences.map((ms) => `${ms} ms`).join(", ")} ` +
      `(moyenne ${moyenne} ms, ${latences.length} décisions automatiques). M4 sur IA réelle : recette en attente (facturée).`,
  );
  releve(ctx, "grep et git status automatiques dans le dépôt propre ; git status en attente (G04) dans le dépôt piégé, sans appel à l'IA de contrôle");
}

/**
 * Latences (ms) entre chaque `permission.asked` et le `permission.replied` de la même demande, vus sur le flux d'événements du
 * cockpit (témoin P6, qui horodate la réception). C'est le temps que met l'autonomie à décider et à relayer sa réponse.
 */
function latencesDuTemoin(temoin) {
  const demandes = new Map();
  for (const evenement of temoin.deOpencode("permission.asked")) {
    const id = evenement.event?.properties?.id;
    if (typeof id === "string" && !demandes.has(id)) demandes.set(id, evenement.recu);
  }
  const mesures = [];
  for (const evenement of temoin.deOpencode("permission.replied")) {
    const id = evenement.event?.properties?.requestID;
    const debut = typeof id === "string" ? demandes.get(id) : undefined;
    if (typeof debut === "number") mesures.push(Math.max(0, evenement.recu - debut));
  }
  return mesures;
}
