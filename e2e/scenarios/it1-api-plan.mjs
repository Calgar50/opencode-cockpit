// Scénario e2e API de l'itération 1 (L7b-1) : mesure M2 sur une conversation de plan, « outils retirés racine + enfant ».
//
// Spécification §6 l.1044 (« Plan d'abord : cette conversation ne peut rien modifier » : e2e « outils absents racine + enfant »),
// §4.9 (POST /api/plans : racine avec le plancher PLAN vérifié, choix « plan » ; edit write apply_patch bash retirés pour la racine
// et les enfants, F-e et F-f), §3.4 (PLAN = CONVERSATION + « edit * deny » + « bash * deny »), §8 M2 (listes mesurées sur opencode
// 1.18.30 : « racine-edit-bash-refuses » et « enfant-general »). Décision n° 4 : en Simple la délégation est refusée d'office ; la
// partie « enfant » passe donc en Avancé, où elle attend votre accord.
//
// Ce que le scénario établit, par l'API du cockpit :
//   1. POST /api/plans crée une racine qui porte exactement le plancher PLAN, avec le choix « plan » ;
//   2. racine : les outils envoyés à l'IA sont ceux de la mesure M2 « racine-edit-bash-refuses » — en « --faux » par l'oracle du faux
//      (et, pour l'IA du faux, aucun outil qui modifie ou exécute), en « --reel-hors-ligne » tels que le vrai opencode les envoie ;
//   3. « --faux » : l'IA délègue à general ; l'enfant hérite du plancher PLAN et ses outils sont ceux de « enfant-general », sans
//      aucun outil qui modifie ou exécute ;
//   4. le plancher PLAN est encore tenu après les envois (aucun PATCH nécessaire en « --faux » : la marque est à jour) ;
//   5. P6 (et P4) pendant tout le scénario.
// En « --reel-hors-ligne », le faux fournisseur ne délègue pas : le point 3 n'y est pas joué.
import {
  attendreDemandes,
  attendreFinDuTour,
  avecTemoinP6,
  casM2,
  corpsJson,
  delegation,
  demandeDeDelegation,
  DOSSIER,
  enModeAvance,
  exiger,
  exigerListe,
  exigerPlancher,
  exigerPlancherHerite,
  exigerSansEcrivain,
  iaDuBanc,
  nonJoue,
  oc,
  outilsDuFaux,
  PLANCHER_PLAN,
  releve,
  requetesAvecOutils,
  resume,
} from "./it1-api-commun.mjs";

const DESCRIPTION = "Lire a.txt pour le plan";

export async function run(ctx) {
  await avecTemoinP6(ctx, async (temoin) => {
    const ia = iaDuBanc(await ctx.api.get("/api/bootstrap"));
    const client = oc(ctx);

    // 1. Conversation de plan : plancher PLAN vérifié par le cockpit, choix « plan ».
    const creation = await ctx.api.brut("POST", "/api/plans", { directory: DOSSIER });
    exiger(creation.code === 200, `POST /api/plans refusé (${creation.code}) : ${resume(creation.corps)}`);
    const { rootId } = corpsJson(creation, "POST /api/plans");
    exiger(typeof rootId === "string", `POST /api/plans sans rootId : ${resume(creation.corps)}`);
    const racine = await client.session(rootId);
    exigerPlancher(racine.permission, PLANCHER_PLAN, "conversation de plan");
    const autonomie = await ctx.api.get(`/api/conversations/${encodeURIComponent(rootId)}/autonomie`);
    exiger(autonomie?.choix === "plan", `choix « ${resume(autonomie?.choix)} » au lieu de « plan ».`);

    // 2. Outils de la racine.
    const casRacine = casM2("racine-edit-bash-refuses");
    const agents = await client.agents();
    if (ctx.mode === "faux") {
      exigerListe(outilsDuFaux(racine, agents, { agent: "build", modelID: casRacine.modelID }), casRacine.tools, "outils de la racine, IA de la mesure M2");
      exigerSansEcrivain(outilsDuFaux(racine, agents, { agent: "build", modelID: ia.modelID }), `racine, IA ${ia.modelID}`);
      await enModeAvance(ctx, () => delegationDansLePlan(ctx, client, temoin, rootId, agents, ia));
    } else if (ctx.mode === "reel-hors-ligne") {
      const debut = (await ctx.billedCalls()).length;
      const envoi = await client.envoyer(rootId, "Propose un plan pour lire a.txt.", ia);
      exiger(envoi.code === 204, `envoi refusé (${envoi.code}) : ${resume(envoi.corps)}`);
      await attendreFinDuTour(client, rootId);
      const requetes = await requetesAvecOutils(ctx, debut);
      exiger(requetes.length > 0, "le faux fournisseur n'a reçu aucune requête avec des outils pour ce tour.");
      for (const requete of requetes) exigerListe([...requete.outils].sort(), casRacine.tools, "outils envoyés par opencode à l'IA (racine du plan)");
      releve(ctx, `outils envoyés à l'IA sous le plancher PLAN (${requetes.length} requête(s)) : ${casRacine.tools.join(" ")}`);
      nonJoue(ctx, "outils de l'enfant d'un plan", "le faux fournisseur ne répond que du texte, il ne délègue pas");
    }

    // 4. Plancher PLAN encore tenu après les envois.
    exigerPlancher((await client.session(rootId)).permission, PLANCHER_PLAN, "conversation de plan après les envois");
  });
}

async function delegationDansLePlan(ctx, client, temoin, rootId, agents, ia) {
  // 3. L'IA délègue à general ; « Autoriser une fois » passe par le portillon ; l'enfant répond.
  await ctx.faux.scripter(rootId, { tools: [delegation(DESCRIPTION, "general", { text: "a.txt lu." })], followUp: { text: "1. Lire a.txt." } });
  const envoi = await client.envoyer(rootId, "Délègue la lecture de a.txt, puis propose un plan.", ia);
  exiger(envoi.code === 204, `envoi refusé (${envoi.code}) : ${resume(envoi.corps)}`);
  const [demande] = await attendreDemandes(client, demandeDeDelegation(rootId, DESCRIPTION), { libelle: "délégation du plan en attente" });
  const accord = await client.repondre(demande.id, "once");
  exiger(accord.code === 200, `« Autoriser une fois » refusé (${accord.code}) : ${resume(accord.corps)}`);
  await attendreFinDuTour(client, rootId);

  const enfants = await client.enfants(rootId);
  exiger(Array.isArray(enfants) && enfants.length === 1, `un enfant attendu, ${resume(enfants?.map?.((e) => e.id))}`);
  const enfant = await client.session(enfants[0].id);
  exigerPlancherHerite(enfant.permission, PLANCHER_PLAN, "enfant du plan");
  const casEnfant = casM2("enfant-general");
  exigerListe(outilsDuFaux(enfant, agents, { agent: "general", modelID: casEnfant.modelID }), casEnfant.tools, "outils de l'enfant, IA de la mesure M2");
  exigerSansEcrivain(outilsDuFaux(enfant, agents, { agent: "general", modelID: ia.modelID }), `enfant, IA ${ia.modelID}`);

  // Marque du plancher à jour : les envois de l'arbre sont relayés sans reposer le plancher.
  const patchs = (await temoin.requetes()).filter((r) => String(r.method).toUpperCase() === "PATCH" && r.pathname === `/session/${rootId}`);
  exiger(patchs.length === 0, `${patchs.length} PATCH de la conversation de plan : la marque du plancher n'était pas à jour.`);
}
