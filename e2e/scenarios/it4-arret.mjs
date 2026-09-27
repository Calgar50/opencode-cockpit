// Scénario e2e des équipes (itération 4, L41) : arrêt pendant l'étape 2, et arrêt au plafond.
//
// Sortie de la spécification §6 l.1047 (« Arrêter » arrête les étapes) et §6 l.1036 (plafond d'arrêt). Ce que le scénario
// établit, dans la vraie pile, sur le faux opencode :
//   1. ARRÊT PENDANT L'ÉTAPE 2 : l'équipe passe « arretee », plus AUCUNE session de l'arbre n'est occupée, et aucune étape
//      n'est restée « en-cours » ;
//   2. RIEN N'EST ENVOYÉ APRÈS L'ARRÊT (constat HAUT corrigé au train de la vague 2, commit 91955c9) : aucun `prompt_async`
//      ne part après la réponse de l'arrêt, ni tout de suite ni après une attente ;
//   3. PLAFOND : une équipe dont la dépense dépasse son plafond s'arrête d'elle-même (état « plafond », cause « plafond »),
//      n'envoie plus rien, ET RESTE RELANÇABLE (second constat HAUT du même train) : `POST /api/team-runs/:id/estimate` rend
//      200 avec la dépense déjà faite, au lieu de 409 « pas-relancable ».
// Les deux parties passent par une ÉQUIPE DÉRIVÉE des exemples (identifiants d'étapes propres au scénario) : les scénarios
// partagent un faux opencode, et un script posé par prédicat vaut pour toute session créée ensuite (voir it4-commun.mjs).
// En « --reel-hors-ligne », les étapes ne sont pas scriptables : le scénario le dit et ne joue rien.
import { attendre, attendreQue, exiger, nonJoue, oc, occupees, releve, resume } from "./it1-api-commun.mjs";
import {
  attendreRun,
  DOSSIER_EQUIPE,
  enAvance,
  equipeDerivee,
  equipes,
  estimerEtLancer,
  etapesDuFlow,
  repere,
  requetesDepuis,
  scripterEtape,
  sessionsDEtape,
} from "./it4-commun.mjs";

/** Pas d'une étape qui doit durer le temps d'être arrêtée : le faux dort entre ses groupes d'événements, et se réveille à l'arrêt. */
const PAS_LONG_MS = 4_000;
/** Coût joué par une étape qui doit dépasser le plafond du lancement (l'estimation d'un exemple reste bien au-dessous d'un dollar). */
const COUT_HORS_PLAFOND = 3;
/** Tour ordinaire : ce que le scénario suit est l'état des étapes, pas le texte rendu. */
const COURT = { text: "Relecture faite.", cost: 0.01, tokens: { input: 90, output: 20 }, stepMs: 5 };

const envois = (requetes) => requetes.filter((requete) => requete.method === "POST" && requete.pathname.endsWith("/prompt_async"));

export async function run(ctx) {
  if (ctx.mode !== "faux") {
    nonJoue(ctx, "arrêt d'une équipe et arrêt au plafond", "le faux fournisseur ne rend que du texte : les étapes d'une équipe n'y sont pas scriptables");
    ctx.expectNoConsoleErrors();
    return;
  }
  const client = oc(ctx, DOSSIER_EQUIPE);

  await enAvance(ctx, async () => {
    const api = equipes(ctx);

    // --- 1 et 2. Arrêt pendant l'étape 2 --------------------------------------------------------------------------------------
    const suite = await equipeDerivee(api, "relecture-script", "a");
    const etapes = etapesDuFlow(suite.flow);
    exiger(etapes.length === 4, `déroulé dérivé à ${etapes.length} étapes : ${resume(etapes)}`);
    for (const [rang, stepId] of etapes.entries()) {
      await scripterEtape(ctx, stepId, rang === 1 ? { ...COURT, stepMs: PAS_LONG_MS } : COURT);
    }

    const { runId, rootId } = await estimerEtLancer(api, suite.id);
    const enPause = await attendreRun(api, runId, (vue) => vue.state === "attente-verification", "pause du déroulé avant l'étape 2");
    exiger(enPause.cause === "pause", `cause « ${enPause.cause} » au lieu de « pause ».`);
    const reprise = await api.continuerBrut(runId, {});
    exiger(reprise.code === 200, `reprise refusée (${reprise.code}) : ${resume(reprise.corps)}`);

    const etape2 = etapes[1];
    const enCours = await attendreRun(
      api,
      runId,
      (vue) => vue.steps.some((step) => step.stepId === etape2 && step.state === "en-cours" && step.sessionId !== null),
      `étape 2 « ${etape2} » en cours`,
    );

    const avantArret = await repere(ctx);
    const arret = await api.arreterBrut(runId);
    exiger(arret.code === 200, `arrêt refusé (${arret.code}) : ${resume(arret.corps)}`);
    const arretee = await attendreRun(api, runId, (vue) => vue.state === "arretee", "équipe arrêtée");
    exiger(
      !arretee.steps.some((step) => step.state === "en-cours"),
      `une étape travaille encore après l'arrêt : ${resume(arretee.steps.map((s) => `${s.stepId}=${s.state}`))}`,
    );

    // Aucune session de l'arbre occupée (la racine, et chaque session d'étape ouverte).
    const sessions = [rootId, ...sessionsDEtape(arretee).map((step) => step.sessionId)];
    await attendreQue(async () => (await occupees(client, sessions)).length === 0, { delaiMs: 20_000, libelle: "arbre de l'équipe au repos après l'arrêt" });
    const pendant = enCours.steps.find((step) => step.stepId === etape2)?.sessionId ?? "";
    releve(ctx, `arrêt pendant l'étape 2 (session ${pendant.slice(0, 8)}…) : ${sessions.length} session(s) au repos`);

    // Rien n'envoyé après l'arrêt, tout de suite puis après une attente (une étape suivante aurait eu le temps de partir).
    await attendre(1_500);
    const apresArret = envois(await requetesDepuis(ctx, avantArret));
    exiger(
      apresArret.length === 0,
      `${apresArret.length} envoi(s) après l'arrêt : ${resume(apresArret.map((r) => r.pathname))} — constat HAUT « envoi facturé après un arrêt » (91955c9)`,
    );

    // --- 3. Arrêt au plafond, et relance encore possible ----------------------------------------------------------------------
    const avis = await equipeDerivee(api, "revue-sql", "a");
    for (const stepId of etapesDuFlow(avis.flow)) {
      await scripterEtape(ctx, stepId, { text: "Étape coûteuse.", cost: COUT_HORS_PLAFOND, tokens: { input: 120, output: 40 }, stepMs: 5 });
    }
    const estimation = await api.estimer(avis.id);
    exiger(
      estimation.plafond < COUT_HORS_PLAFOND,
      `plafond du lancement ${estimation.plafond} $ : une étape à ${COUT_HORS_PLAFOND} $ ne le dépasserait pas.`,
    );
    const depart = await estimerEtLancer(api, avis.id);

    const auPlafond = await attendreRun(api, depart.runId, (vue) => vue.state === "plafond" || vue.state === "terminee", "équipe arrêtée au plafond");
    exiger(auPlafond.state === "plafond", `état « ${auPlafond.state} » au lieu de « plafond ».`);
    exiger(auPlafond.cause === "plafond", `cause « ${auPlafond.cause} » au lieu de « plafond ».`);

    const avantRelance = await repere(ctx);
    await attendre(1_000);
    const apresPlafond = envois(await requetesDepuis(ctx, avantRelance));
    exiger(apresPlafond.length === 0, `${apresPlafond.length} envoi(s) après l'arrêt au plafond : ${resume(apresPlafond.map((r) => r.pathname))}`);

    // Reste relançable : l'estimation de la suite répond 200, jamais 409 « pas-relancable » (constat HAUT, 91955c9).
    const relance = await api.estimerRelanceBrut(depart.runId);
    exiger(
      relance.code === 200,
      `équipe arrêtée au plafond non relançable (${relance.code}) : ${resume(relance.corps)} — constat HAUT « équipe arrêtée au plafond non relançable » (91955c9)`,
    );
    const reste = JSON.parse(relance.corps);
    exiger(typeof reste.deja === "number" && reste.deja > 0, `estimation de la suite sans dépense déjà faite : ${resume(reste.deja)}`);
    releve(ctx, `équipe arrêtée au plafond : relance estimée à ${reste.estimate?.typique} $ après ${reste.deja} $ déjà dépensés`);
  });

  ctx.expectNoConsoleErrors();
}
