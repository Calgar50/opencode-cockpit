// Scénario e2e API de l'itération 1 (L7b-1) : plancher de conversation vérifié par la présence des outils.
//
// Spécification §3.4 (CONVERSATION : refus de lecture des fichiers de clés, posé par le proxy sur POST /session et vérifié sur
// l'écho), §6 l.1033 (« N'ouvre jamais les fichiers de clés »), §7.3 L7 (« plancher par présence d'outils »), mesures M2 et M3
// (MX1 §5-6 : un refus sur un motif précis laisse l'outil proposé à l'IA et refuse l'appel, sans demande).
//
// Ce que le scénario établit, par l'API du cockpit :
//   1. une conversation créée par le proxy porte le plancher CONVERSATION, à l'identique, à la création comme à la relecture ;
//   2. le plancher ne retire aucun outil : la liste envoyée à l'IA est celle d'une session sans règle (mesure M2, « sans-regle »),
//      « read » compris — en « --faux » par l'oracle du faux, en « --reel-hors-ligne » telle que le vrai opencode l'a envoyée ;
//   3. « --faux » : l'IA qui lit cle.pfx reçoit un refus sans qu'aucune demande ne soit posée, et lit notes.txt normalement ;
//   4. P6 pendant tout le scénario.
// En « --reel-hors-ligne », le faux fournisseur ne sait répondre que du texte : le point 3 n'y est pas joué (il est mesuré sur un
// vrai opencode en MX1 §5, annexe « cle.key »).
import {
  attendreFinDuTour,
  avecTemoinP6,
  casM2,
  exiger,
  exigerAucuneDemandeDeLecture,
  exigerLectureFaite,
  exigerLectureRefusee,
  exigerListe,
  exigerPlancher,
  iaDuBanc,
  lecture,
  nonJoue,
  oc,
  outilsDuFaux,
  PLANCHER_CONVERSATION,
  releve,
  requetesAvecOutils,
  resume,
} from "./it1-api-commun.mjs";

const FICHIER_CLE = "/workspace/it1-api-plancher/cle.pfx";
const FICHIER_TEXTE = "/workspace/it1-api-plancher/notes.txt";

export async function run(ctx) {
  await avecTemoinP6(ctx, async (temoin) => {
    const ia = iaDuBanc(await ctx.api.get("/api/bootstrap"));
    const client = oc(ctx);

    // 1. Création par le proxy : le cockpit ajoute le plancher et vérifie l'écho d'opencode (sinon 502 et session supprimée).
    const creee = await client.creerConversation("it1-api-plancher");
    exiger(typeof creee?.id === "string", `création refusée : ${resume(creee)}`);
    exigerPlancher(creee.permission, PLANCHER_CONVERSATION, "écho de la création");
    exigerPlancher((await client.session(creee.id)).permission, PLANCHER_CONVERSATION, "conversation relue");

    // 2. Un tour. « --faux » : l'IA lit un fichier de clés puis un fichier ordinaire, avec l'assistant build.
    const agents = await client.agents();
    const build = agents.find((a) => a.name === "build");
    exiger(build, "assistant « build » absent de GET /agent.");
    const debutFournisseur = ctx.mode === "reel-hors-ligne" ? (await ctx.billedCalls()).length : 0;
    if (ctx.faux) {
      await ctx.faux.scripter(creee.id, { tools: [lecture(FICHIER_CLE, build), lecture(FICHIER_TEXTE, build)], followUp: { text: "Clé illisible, notes lues." } });
    }
    const envoi = await client.envoyer(creee.id, "Lis cle.pfx puis notes.txt du dossier it1-api-plancher.", ia);
    exiger(envoi.code === 204, `envoi refusé (${envoi.code}) : ${resume(envoi.corps)}`);
    const messages = await attendreFinDuTour(client, creee.id);
    const apres = await client.session(creee.id);
    exigerPlancher(apres.permission, PLANCHER_CONVERSATION, "conversation après le tour");

    // 3. Présence des outils : aucun retiré par le plancher, « read » compris.
    const attendus = casM2("sans-regle", ctx);
    if (ctx.mode === "faux") {
      const avecPlancher = outilsDuFaux(apres, agents, { agent: "build" });
      const sansRegle = outilsDuFaux({ ...apres, permission: [] }, agents, { agent: "build" });
      exigerListe(avecPlancher, sansRegle, "outils de la conversation (plancher CONVERSATION)");
      exiger(avecPlancher.includes("read"), "« read » retiré par le plancher : une lecture ordinaire serait impossible.");
      exigerListe(outilsDuFaux(apres, agents, { agent: "build", modelID: attendus.modelID }), attendus.tools, "outils de la conversation, IA de la mesure M2");

      // Fichier de clés refusé à l'appel, sans demande ; fichier ordinaire lu.
      exigerLectureRefusee(messages, FICHIER_CLE);
      exigerLectureFaite(messages, FICHIER_TEXTE);
      exigerAucuneDemandeDeLecture(temoin);
    } else if (ctx.mode === "reel-hors-ligne") {
      const requetes = await requetesAvecOutils(ctx, debutFournisseur);
      exiger(requetes.length > 0, "le faux fournisseur n'a reçu aucune requête avec des outils pour ce tour.");
      for (const requete of requetes) exigerListe([...requete.outils].sort(), attendus.tools, "outils envoyés par opencode à l'IA");
      releve(ctx, `outils envoyés à l'IA sous le plancher CONVERSATION (${requetes.length} requête(s)) : ${attendus.tools.join(" ")}`);
      nonJoue(ctx, "lecture de cle.pfx", "le faux fournisseur ne répond que du texte ; refus mesuré sur un vrai opencode en MX1 §5");
    }
  });
}
