// Scénario e2e API de l'itération 1 (L7b-1) : « .pfx refusé chez un enfant explore ».
//
// Spécification §6 l.1033 (« N'ouvre jamais les fichiers de clés » : e2e « .pfx refusé chez un enfant explore »), §3.14 (« CONVERSATION
// est hérité par les enfants (F-f) : general et explore ne lisent plus les fichiers de clés, sans toucher au profil Prudent »),
// décision n° 4 (en Simple la délégation est refusée d'office : le scénario passe donc en Avancé, où elle attend votre accord).
//
// Ce que le scénario établit, par l'API du cockpit (« --faux ») :
//   1. la racine porte le plancher CONVERSATION ; l'assistant explore, servi par opencode, lit tout par ses propres règles ;
//   2. l'IA délègue à explore ; la délégation attend votre accord, « Autoriser une fois » passe par le portillon du cockpit ;
//   3. l'enfant explore hérite de chaque refus du plancher, et ne porte aucune autorisation ni demande ;
//   4. l'enfant qui lit cle.pfx reçoit un refus, sans demande ; il lit notes.txt normalement ; la délégation se termine ;
//   5. P6 (et P4 : seulement « once » envoyé) pendant tout le scénario.
// En « --reel-hors-ligne », le faux fournisseur ne sait pas déléguer (il ne répond que du texte) : seuls les points 1 et 5 sont joués.
import {
  attendreDemandes,
  attendreFinDuTour,
  avecTemoinP6,
  delegation,
  demandeDeDelegation,
  enModeAvance,
  exiger,
  exigerAucuneDemandeDeLecture,
  exigerLectureFaite,
  exigerLectureRefusee,
  exigerPlancher,
  exigerPlancherHerite,
  iaDuBanc,
  lecture,
  // --- équipes (it4) : début ---
  libererLesDemandes,
  // --- équipes (it4) : fin ---
  nonJoue,
  oc,
  partiesOutil,
  PLANCHER_CONVERSATION,
  resume,
} from "./it1-api-commun.mjs";

const FICHIER_CLE = "/workspace/it1-api-pfx-explore/cle.pfx";
const FICHIER_TEXTE = "/workspace/it1-api-pfx-explore/notes.txt";
const DESCRIPTION = "Explorer it1-api-pfx-explore";

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

    // 1. Racine avec le plancher ; explore est un sous-agent qui lit par ses propres règles (la lecture n'y est pas refusée).
    const racine = await client.creerConversation("it1-api-pfx-explore");
    // --- équipes (it4) : début ---
    racines.push(racine.id);
    // --- équipes (it4) : fin ---
    exigerPlancher(racine.permission, PLANCHER_CONVERSATION, "écho de la création");
    const agents = await client.agents();
    const explore = agents.find((a) => a.name === "explore");
    exiger(explore?.mode === "subagent", `assistant « explore » absent ou non délégable : ${resume(explore)}`);
    const lectureParExplore = (explore.permission ?? []).findLast((r) => r.permission === "read" && r.pattern === "*");
    exiger(lectureParExplore?.action === "allow", `explore ne lit pas par ses propres règles : ${resume(lectureParExplore)}`);

    if (ctx.mode !== "faux") {
      nonJoue(ctx, "délégation à explore et lecture de cle.pfx", "le faux fournisseur ne répond que du texte, il ne délègue pas");
      return;
    }

    await enModeAvance(ctx, async () => {
      // 2. L'IA délègue à explore, qui lit le fichier de clés puis un fichier ordinaire.
      await ctx.faux.scripter(racine.id, {
        tools: [
          delegation(DESCRIPTION, "explore", {
            turn: { tools: [lecture(FICHIER_CLE, explore), lecture(FICHIER_TEXTE, explore)], followUp: { text: "Clé illisible, notes lues." } },
          }),
        ],
        followUp: { text: "Exploration terminée." },
      });
      const envoi = await client.envoyer(racine.id, "Fais explorer le dossier it1-api-pfx-explore.", ia);
      exiger(envoi.code === 204, `envoi refusé (${envoi.code}) : ${resume(envoi.corps)}`);
      const [demande] = await attendreDemandes(client, demandeDeDelegation(racine.id, DESCRIPTION), { libelle: "délégation à explore en attente" });
      const accord = await client.repondre(demande.id, "once");
      exiger(accord.code === 200, `« Autoriser une fois » refusé (${accord.code}) : ${resume(accord.corps)}`);
      const messagesRacine = await attendreFinDuTour(client, racine.id);

      // 3. L'enfant explore hérite des refus du plancher.
      const enfants = await client.enfants(racine.id);
      exiger(Array.isArray(enfants) && enfants.length === 1, `un enfant attendu, ${resume(enfants?.map?.((e) => e.id))}`);
      const enfant = await client.session(enfants[0].id);
      exiger(enfant.parentID === racine.id, `enfant d'une autre conversation : ${resume(enfant.parentID)}`);
      exigerPlancherHerite(enfant.permission, PLANCHER_CONVERSATION, "enfant explore");

      // 4. Fichier de clés refusé à l'appel, sans demande ; fichier ordinaire lu ; délégation terminée.
      const messagesEnfant = await client.messages(enfant.id);
      exiger(messagesEnfant.some((m) => m.info?.role === "assistant" && m.info?.agent === "explore"), "aucune réponse d'explore dans l'enfant.");
      exigerLectureRefusee(messagesEnfant, FICHIER_CLE);
      exigerLectureFaite(messagesEnfant, FICHIER_TEXTE);
      exigerAucuneDemandeDeLecture(temoin);
      const [task] = partiesOutil(messagesRacine, "task");
      exiger(task?.state?.status === "completed", `délégation dans l'état « ${task?.state?.status} » (${resume(task?.state?.error)}).`);

      // Aucune lecture n'a été autorisée par le cockpit : la seule réponse envoyée est l'accord de la délégation.
      const reponses = (await temoin.requetes()).filter((r) => String(r.method).toUpperCase() === "POST" && /^\/permission\/[^/]+\/reply$/.test(r.pathname ?? ""));
      exiger(reponses.length === 1 && reponses[0].pathname === `/permission/${demande.id}/reply`, `réponses d'autorisation inattendues : ${resume(reponses.map((r) => r.pathname))}`);
    });
  });
  // --- équipes (it4) : début ---
  } finally {
    await libererLesDemandes(ctx, racines);
  }
  // --- équipes (it4) : fin ---
}
