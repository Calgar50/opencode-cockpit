// Scénario e2e des équipes (itération 4, L41) : garde de rechargement composée pendant une étape (§3.11, D-eq-06).
//
// Une étape d'équipe qui travaille occupe le cockpit : recharger opencode couperait sa réponse. La garde de rechargement de
// la 1.1 est donc COMPOSÉE avec l'occupation des équipes (`c11.reloadBusy` décoré par L37c), et tous ses lecteurs en
// profitent, `POST /api/ai/realign` compris, qui n'a pas de middleware propre (constat 13 de la relecture du plan).
//
// Ce que le scénario établit, dans la vraie pile, sur le faux opencode :
//   1. PENDANT une étape : `PUT /api/studio/instructions` (enregistrement du Studio) et `POST /api/ai/realign`
//      (réalignement des assistants) répondent 409, et l'installation d'un exemple aussi ;
//   2. l'étape n'a pas été coupée : l'équipe va jusqu'au bout, et le cockpit n'a ni libéré ni redémarré l'instance
//      d'opencode pendant tout cela (témoin P6) ;
//   3. APRÈS l'équipe : les deux mêmes écritures répondent 200. Elles rechargent opencode, comme elles le doivent : elles
//      sont donc jouées HORS du témoin P6, qui verrait cette libération voulue. Le banc y attend d'abord le repos réel des
//      sessions d'étape DE CE LANCEMENT — jamais celui du dossier, que les 27 scénarios partagent —, et il le MESURE
//      (voir REPOS_MAX_MS).
// En « --reel-hors-ligne », les étapes ne sont pas scriptables : le scénario le dit et ne joue rien.
import { attendreQue, avecTemoinP6, exiger, nonJoue, oc, releve, resume } from "./it1-api-commun.mjs";
import { preparerPage } from "./it1-ui-commun.mjs";
import {
  appelConfirme,
  attendreRun,
  DOSSIER_EQUIPE,
  enAvance,
  equipeDerivee,
  equipes,
  estimerEtLancer,
  etapesDuFlow,
  scripterEtape,
} from "./it4-commun.mjs";

/** Pas d'une étape assez longue pour que les trois écritures tombent pendant qu'elle travaille. */
const PAS_LONG_MS = 3_000;

/**
 * Délai laissé aux sessions d'étape pour revenir au repos APRÈS l'état « terminee » du lancement (constat C4 de la vague 4,
 * point « à surveiller » de la répétition générale du 21/09).
 *
 * Le cockpit note la fin d'une étape quand le message de l'assistant est clos ; opencode, lui, peut compter la session de cette
 * étape occupée un court moment encore. La garde de rechargement lit opencode (`probeSessionsBusy` : `GET /session/status` de
 * chaque dossier connu) : son refus 409 « sessions-busy » juste après la fin d'une équipe est donc le comportement VOULU, pas
 * un défaut — le produit n'est pas changé ici (la spécification demande ce refus tant qu'une réponse est en cours).
 *
 * Ce qui n'était borné par rien de visible, c'est le DÉLAI entre les deux. Le banc l'attend donc, et le relève : une session
 * d'étape qui ne reviendrait jamais au repos fait tomber le scénario AVEC sa mesure, au lieu de le rendre capricieux.
 *
 * PORTÉE de cette attente (correction de la revue d'itération 4). Le dossier des équipes est `/workspace`, celui que les
 * 27 scénarios du banc PARTAGENT (it4-commun.mjs, it1-api-commun.mjs). Attendre que plus AUCUNE session de ce dossier ne soit
 * occupée, c'est attendre l'état de toute la pile : un scénario précédent qui laisse une session occupée (une demande
 * d'autorisation restée sans réponse, par exemple) fait alors tomber celui-ci, et la première rédaction de cette attente
 * dépendait donc encore de l'ordre — contrairement à ce qu'annonçait le message du commit 9e50096, que ce commentaire corrige.
 * L'attente est désormais bornée aux sessions d'étape de CE lancement, nommées par la vue du lancement (`StepRunView.sessionId`).
 */
const REPOS_MAX_MS = 30_000;

/**
 * Identifiants des sessions d'étape d'UN lancement, tels que le cockpit les publie (`StepRunView.sessionId`) : la seule portée
 * légitime de l'attente du repos. Exporté pour que le test de garde de `croisements-eq-v4.test.ts` l'éprouve vraiment.
 */
export function sessionsDuLancement(vue) {
  const ids = (vue?.steps ?? []).map((etape) => etape?.sessionId).filter((id) => typeof id === "string" && id.length > 0);
  return [...new Set(ids)];
}

/**
 * Parmi `sessions` — et parmi elles SEULES —, celles qu'opencode ne dit pas « idle ». Même lecture d'état que la garde
 * (assistants.ts, `statusBusy`), mais jamais la même portée : la garde répond de toute la pile, le banc ne mesure que son
 * propre lancement. Exporté pour le test de garde.
 */
export function filtrerOccupees(etats, sessions) {
  if (etats === null || typeof etats !== "object") return [];
  const miennes = new Set(sessions);
  return Object.entries(etats)
    .filter(([sessionId]) => miennes.has(sessionId))
    .filter(([, etat]) => !(etat !== null && typeof etat === "object" && etat.type === "idle"))
    .map(([sessionId]) => sessionId);
}

/** Sessions d'étape de ce lancement qu'opencode ne dit pas « idle ». */
async function sessionsOccupees(ctx, sessions) {
  return filtrerOccupees(await oc(ctx, DOSSIER_EQUIPE).etats(), sessions);
}

/** Attend le repos réel des sessions d'étape de CE lancement et rend le délai mesuré depuis « terminee », en millisecondes. */
async function attendreLeRepos(ctx, sessions) {
  const debut = Date.now();
  let occupees = [];
  try {
    await attendreQue(
      async () => {
        occupees = await sessionsOccupees(ctx, sessions);
        return occupees.length === 0;
      },
      { delaiMs: REPOS_MAX_MS, pasMs: 200, libelle: "repos des sessions d'étape de ce lancement" },
    );
  } catch (err) {
    throw new Error(
      `repos des sessions d'étape : ${occupees.length} session(s) de CE lancement encore comptée(s) occupée(s) par opencode ${Math.round(REPOS_MAX_MS / 1000)} s après l'état « terminee » (${occupees.join(", ")}) — ${err?.message ?? err}`,
    );
  }
  return Date.now() - debut;
}

/**
 * Écritures que la garde de rechargement doit refuser pendant une étape, et accepter après.
 * Le réalignement exige d'abord `x-cockpit-confirm: 1` (428 sans lui, avant toute autre vérification) : il est donc appelé
 * DEPUIS LA PAGE, comme l'utilisateur qui confirme, sans quoi la garde ne serait jamais atteinte.
 */
const ECRITURES = [
  { nom: "enregistrement du Studio", appel: (ctx) => ctx.api.brut("PUT", "/api/studio/instructions", { content: "# Consignes du banc e2e\n" }), apres: 200 },
  { nom: "réalignement des assistants", appel: (ctx) => appelConfirme(ctx, "POST", "/api/ai/realign", {}), apres: 200 },
  // Redémarrage d'opencode : autre lecteur de la MÊME garde composée, sans en-tête de confirmation. Après l'équipe, il
  // redémarrerait vraiment opencode : le scénario ne l'éprouve donc que pendant l'étape (`apres: null`).
  { nom: "redémarrage d'opencode", appel: (ctx) => ctx.api.brut("POST", "/api/system/restart-opencode", {}), apres: null },
];

export async function run(ctx) {
  if (ctx.mode !== "faux") {
    nonJoue(ctx, "garde de rechargement pendant une étape", "le faux fournisseur ne rend que du texte : les étapes d'une équipe n'y sont pas scriptables");
    ctx.expectNoConsoleErrors();
    return;
  }

  // La page sert au réalignement confirmé (voir ECRITURES) ; aucune conversation n'y est ouverte.
  await preparerPage(ctx);

  await enAvance(ctx, async () => {
    const api = equipes(ctx);
    // L'installation d'un exemple recharge opencode : elle est faite AVANT d'ouvrir le témoin P6, qui verrait sa libération.
    const equipe = await equipeDerivee(api, "revue-sql", "s");
    for (const stepId of etapesDuFlow(equipe.flow)) {
      await scripterEtape(ctx, stepId, { text: "Avis rendu.", cost: 0.01, tokens: { input: 90, output: 20 }, stepMs: PAS_LONG_MS });
    }

    /** Vue du lancement terminé : elle nomme les sessions d'étape dont le banc attendra le repos. */
    let finie = null;
    await avecTemoinP6(ctx, async () => {
      const { runId } = await estimerEtLancer(api, equipe.id);
      await attendreRun(api, runId, (vue) => vue.steps.some((step) => step.state === "en-cours"), "une étape de l'équipe en cours");

      // 1. Pendant une étape : tout ce qui recharge opencode est refusé (409).
      for (const ecriture of ECRITURES) {
        const reponse = await ecriture.appel(ctx);
        exiger(reponse.code === 409, `${ecriture.nom} pendant une étape : code ${reponse.code} au lieu de 409 — ${resume(reponse.corps)}`);
      }
      const installation = await api.installerBrut("relecture-script");
      exiger(installation.code === 409, `installation d'un exemple pendant une étape : code ${installation.code} au lieu de 409 — ${resume(installation.corps)}`);
      releve(ctx, "pendant une étape : Studio, réalignement et installation d'un exemple refusés (409)");

      // 2. L'étape n'a pas été coupée : l'équipe va jusqu'au bout (le témoin P6 est vérifié à la sortie d'avecTemoinP6).
      finie = await attendreRun(api, runId, (vue) => vue.state === "terminee", "équipe terminée après les refus de la garde");
      for (const step of finie.steps) exiger(step.state === "terminee", `étape ${step.stepId} : état « ${step.state} » après les refus.`);
    });

    // 3. Après l'équipe : les mêmes écritures passent. Hors du témoin P6 : elles rechargent opencode, c'est leur objet.
    // Le repos réel des sessions d'étape suit de peu l'état « terminee » : le banc l'attend et le mesure (REPOS_MAX_MS), sur
    // les sessions de CE lancement et sur elles seules — le dossier, lui, est partagé par les 27 scénarios du banc.
    const miennes = sessionsDuLancement(finie);
    exiger(miennes.length > 0, `aucune session d'étape relevée sur le lancement : l'attente du repos ne mesurerait rien — ${resume(finie?.steps)}`);
    const reposMs = await attendreLeRepos(ctx, miennes);
    releve(ctx, `repos des ${miennes.length} session(s) d'étape de ce lancement : ${reposMs} ms après l'état « terminee » (borne du banc : ${REPOS_MAX_MS} ms)`);
    for (const ecriture of ECRITURES.filter((candidate) => candidate.apres !== null)) {
      const reponse = await ecriture.appel(ctx);
      exiger(
        reponse.code === ecriture.apres,
        `${ecriture.nom} après l'équipe, sessions d'étape au repos depuis la mesure (${reposMs} ms) : code ${reponse.code} au lieu de ${ecriture.apres} — ${resume(reponse.corps)}`,
      );
    }
    releve(ctx, "après l'équipe : Studio et réalignement acceptés (200)");
  });

  // Le refus 409 du réalignement est VOULU par ce scénario, et il est demandé depuis la page : le navigateur le note dans sa
  // console comme toute réponse ≥ 400. C'est le seul écart toléré, et il disparaîtrait si la garde cessait de refuser.
  ctx.expectNoConsoleErrors([/\/api\/ai\/realign/]);
}
