// Scénario e2e API de l'itération 1 (L7b-1) : « Arrêter » arrête le travail délégué, et plus aucune session n'est occupée.
//
// Spécification §6 l.1047 (« Arrêter » arrête le travail délégué et les étapes : e2e « aucune session occupée »), §3.12 (stopTree :
// refus de toutes les demandes en attente de l'arbre, arrêt de la racine puis des descendants occupés, sonde, conversation.arretee ;
// tout « once » tardif est refusé), §3.9 (POST /api/conversations/:rootId/stop → StopResult). Décision n° 4 : en Simple la
// délégation est refusée d'office ; le scénario passe donc en Avancé, où elle attend votre accord (capture p6 : une délégation
// travaille, une seconde attend).
//
// Ce que le scénario établit, par l'API du cockpit (« --faux ») :
//   1. une conversation dont une délégation travaille (enfant occupé) et une seconde attend votre accord ;
//   2. « Arrêter » rend 200 : la demande en attente refusée, la racine arrêtée la première, rien hors de l'arbre, rien de non
//      confirmé ;
//   3. la racine et l'enfant qui travaillait sont interrompus (MessageAbortedError), plus aucune session de l'arbre n'est occupée,
//      plus aucune demande n'attend, conversation.arretee {cause: vous} est publié ;
//   4. « Autoriser une fois » tardif sur la demande refusée : refusé par le cockpit, aucun enfant lancé ;
//   5. P6 (et P4 : seulement « once » et « reject » envoyés) pendant tout le scénario.
// En « --reel-hors-ligne », le faux fournisseur répond tout de suite et ne délègue pas : aucun arbre ne reste occupé. Le scénario y
// arrête une conversation après son tour et vérifie les points 2 et 3 sur la seule racine.
import {
  arreter,
  attendreDemandes,
  attendreFinDuTour,
  attendreQue,
  avecTemoinP6,
  corpsJson,
  delegation,
  demandeDeDelegation,
  enModeAvance,
  exiger,
  exigerListe,
  exigerPlancher,
  iaDuBanc,
  // --- équipes (it4) : début ---
  libererLesDemandes,
  // --- équipes (it4) : fin ---
  nonJoue,
  oc,
  occupees,
  PLANCHER_CONVERSATION,
  releve,
  resume,
} from "./it1-api-commun.mjs";

const TRAVAILLE = "Analyser les journaux";
const ATTEND = "Analyser changements.md";

export async function run(ctx) {
  // --- équipes (it4) : début ---
  // Racine créée ici ; le `finally` la rend au repos même si une assertion tombe pendant une demande d'autorisation (sans quoi
  // la session reste comptée occupée par opencode pour tous les scénarios suivants de la passe, dossier partagé).
  const racines = [];
  try {
  // --- équipes (it4) : fin ---
  await avecTemoinP6(ctx, async (temoin) => {
    const ia = iaDuBanc(await ctx.api.get("/api/bootstrap"));
    const client = oc(ctx);
    const racine = await client.creerConversation("it1-api-arret");
    // --- équipes (it4) : début ---
    racines.push(racine.id);
    // --- équipes (it4) : fin ---
    exigerPlancher(racine.permission, PLANCHER_CONVERSATION, "écho de la création");
    if (ctx.mode === "faux") await enModeAvance(ctx, () => arreterUnArbreQuiTravaille(ctx, client, temoin, racine, ia));
    else await arreterApresLeTour(ctx, client, temoin, racine, ia);
  });
  // --- équipes (it4) : début ---
  } finally {
    await libererLesDemandes(ctx, racines);
  }
  // --- équipes (it4) : fin ---
}

/** Réponse de « Arrêter » : 200 et StopResult de la racine, rien de non confirmé. */
async function arreterEtLire(ctx, racine) {
  const reponse = await arreter(ctx, racine.id);
  exiger(reponse.code === 200, `« Arrêter » refusé (${reponse.code}) : ${resume(reponse.corps)}`);
  const resultat = corpsJson(reponse, "« Arrêter »");
  exiger(resultat.rootId === racine.id, `arrêt d'une autre conversation : ${resume(resultat)}`);
  exiger(Array.isArray(resultat.aborted) && resultat.aborted[0] === racine.id, `la racine n'est pas arrêtée en premier : ${resume(resultat.aborted)}`);
  exigerListe(resultat.unconfirmed, [], "sessions dont l'arrêt n'est pas confirmé");
  releve(ctx, `« Arrêter » en ${resultat.durationMs} ms : ${resultat.rejected} demande(s) refusée(s), ${resultat.aborted.length} session(s) arrêtée(s) par le cockpit`);
  return resultat;
}

/** Après l'arrêt : conversation.arretee {cause: vous}, aucune session de l'arbre occupée. */
async function exigerArbreArrete(client, temoin, racine, arbre) {
  const arretee = await temoin.attendreCockpit("conversation.arretee", (d) => d?.rootId === racine.id);
  exiger(arretee.data.cause === "vous", `cause de l'arrêt « ${arretee.data.cause} » au lieu de « vous ».`);
  exigerListe(arretee.data.unconfirmed ?? [], [], "conversation.arretee : sessions non confirmées");
  const encore = await occupees(client, arbre);
  exiger(encore.length === 0, `session(s) encore occupée(s) après « Arrêter » : ${encore.join(", ")}`);
}

async function arreterUnArbreQuiTravaille(ctx, client, temoin, racine, ia) {
  // 1. Une délégation travaille (60 s), une seconde attend votre accord.
  await ctx.faux.scripter(racine.id, { tools: [delegation(TRAVAILLE, "general", { workMs: 60_000 }), delegation(ATTEND, "general", { text: "Deux changements." })] });
  const envoi = await client.envoyer(racine.id, "Consulte les deux analystes.", ia);
  exiger(envoi.code === 204, `envoi refusé (${envoi.code}) : ${resume(envoi.corps)}`);
  const [travaille] = await attendreDemandes(client, demandeDeDelegation(racine.id, TRAVAILLE), { libelle: `délégation « ${TRAVAILLE} » en attente` });
  const [attend] = await attendreDemandes(client, demandeDeDelegation(racine.id, ATTEND), { libelle: `délégation « ${ATTEND} » en attente` });
  const accord = await client.repondre(travaille.id, "once");
  exiger(accord.code === 200, `« Autoriser une fois » refusé (${accord.code}) : ${resume(accord.corps)}`);
  const enfant = await attendreQue(
    async () => {
      const [premier] = (await client.enfants(racine.id)) ?? [];
      return premier && (await occupees(client, [racine.id, premier.id])).length === 2 ? premier : false;
    },
    { libelle: "racine et enfant occupés" },
  );

  // 2. « Arrêter » : la demande en attente refusée, la racine arrêtée la première. L'arrêt de la racine emporte le sous-agent de
  // son tour (ordre mesuré, capture p6) : stopTree n'arrête ensuite que les descendants encore occupés, d'où un `aborted` qui peut
  // se réduire à la racine. Ce qui compte : l'enfant a été interrompu, et plus rien n'est occupé.
  const resultat = await arreterEtLire(ctx, racine);
  exiger(resultat.rejected === 1, `${resultat.rejected} demande(s) refusée(s) au lieu d'une.`);
  const horsArbre = resultat.aborted.filter((sid) => sid !== racine.id && sid !== enfant.id);
  exiger(horsArbre.length === 0, `session(s) hors de l'arbre arrêtée(s) : ${horsArbre.join(", ")}`);

  // 3. Rien n'est plus occupé, rien n'attend, et le refus est parti par le portillon (« reject », jamais « once »).
  await exigerArbreArrete(client, temoin, racine, [racine.id, enfant.id]);
  const interrompues = new Set(
    temoin
      .deOpencode("session.error")
      .filter((e) => e.event.properties?.error?.name === "MessageAbortedError")
      .map((e) => e.event.properties.sessionID),
  );
  for (const [sid, qui] of [
    [racine.id, "racine"],
    [enfant.id, "enfant qui travaillait"],
  ]) {
    exiger(interrompues.has(sid), `${qui} : aucun arrêt (MessageAbortedError) relayé par le cockpit.`);
  }
  const partie = (await client.messages(racine.id))
    .flatMap((m) => m.parts ?? [])
    .find((p) => p.type === "tool" && p.tool === "task" && p.state?.input?.description === TRAVAILLE);
  exiger(partie?.state?.status === "error", `délégation « ${TRAVAILLE} » dans l'état « ${partie?.state?.status} » après l'arrêt.`);
  const restantes = ((await client.demandes()) ?? []).filter((d) => d.sessionID === racine.id || d.sessionID === enfant.id);
  exiger(restantes.length === 0, `demande(s) encore en attente après « Arrêter » : ${resume(restantes.map((d) => d.id))}`);
  const recues = await temoin.requetes();
  const refus = recues.filter((r) => r.pathname === `/permission/${attend.id}/reply`);
  exigerListe(
    refus.map((r) => r.body?.reply),
    ["reject"],
    `réponses envoyées à opencode pour « ${ATTEND} »`,
  );
  exiger(
    recues.some((r) => String(r.method).toUpperCase() === "POST" && r.pathname === `/session/${racine.id}/abort`),
    "aucun arrêt de la racine envoyé à opencode.",
  );

  // 4. « Autoriser une fois » tardif : refusé par le cockpit, rien n'est lancé.
  const tardif = await client.repondre(attend.id, "once");
  exiger(tardif.code === 409, `« Autoriser une fois » tardif : ${tardif.code} au lieu de 409 (${resume(tardif.corps)}).`);
  const relaye = (await temoin.requetes()).some((r) => r.pathname === `/permission/${attend.id}/reply` && r.body?.reply === "once");
  exiger(!relaye, "« once » tardif relayé à opencode.");
  const enfants = (await client.enfants(racine.id)) ?? [];
  exiger(enfants.length === 1, `enfant lancé après l'arrêt : ${resume(enfants.map((e) => e.id))}`);
  exiger((await occupees(client, [racine.id, enfant.id])).length === 0, "arbre de nouveau occupé après le « once » tardif.");
}

async function arreterApresLeTour(ctx, client, temoin, racine, ia) {
  const envoi = await client.envoyer(racine.id, "Réponds en une phrase.", ia);
  exiger(envoi.code === 204, `envoi refusé (${envoi.code}) : ${resume(envoi.corps)}`);
  await attendreFinDuTour(client, racine.id);
  await arreterEtLire(ctx, racine);
  await exigerArbreArrete(client, temoin, racine, [racine.id]);
  nonJoue(ctx, "arrêt d'un arbre occupé (délégation qui travaille, demande en attente)", "le faux fournisseur répond tout de suite et ne délègue pas");
}
