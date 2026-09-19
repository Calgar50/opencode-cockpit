// Scénario e2e API de l'itération 1 (L7b-1) : mesure M16, « plancher injecté sans effet sur titre et archive ».
//
// Spécification §8 M16 (e2e L7), §3.4 (plancher CONVERSATION injecté par le proxy sur POST /session) ; mesure MX1 §5 : sur un vrai
// opencode 1.18.30, le plancher posé à la création ne change ni le titre généré, ni les messages (base de l'archive), et la requête
// de titre ne propose aucun outil. « M16 réel ne porte plus que sur le titre écrit par une petite IA » (plan §3.5).
//
// Ce que le scénario établit, par l'API du cockpit :
//   1. titre choisi : l'écho de la création, la conversation relue après un tour et l'archive (Archives du cockpit, export Markdown
//      compris) portent exactement ce titre ;
//   2. sans titre : titre par défaut d'opencode à la création, inchangé par le cockpit ; en « --reel-hors-ligne », une petite IA
//      l'écrit après le premier échange (requête de titre sans outil), et l'archive reprend ce titre ;
//   3. l'archive reprend la conversation telle qu'opencode la garde (nombre de messages, demande, réponse), et rien du plancher
//      n'y apparaît (ni motif de fichier de clés, ni règle) ;
//   4. P6 pendant tout le scénario.
import {
  attendreFinDuTour,
  attendreQue,
  avecTemoinP6,
  exiger,
  exigerPlancher,
  iaDuBanc,
  MOTIFS_CLES,
  oc,
  PLANCHER_CONVERSATION,
  releve,
  resume,
} from "./it1-api-commun.mjs";

const TITRE_CHOISI = "it1-api-m16 titre choisi";
/** Titre par défaut d'opencode, avant toute génération (session.ts). */
const TITRE_PAR_DEFAUT = "New session - ";

export async function run(ctx) {
  await avecTemoinP6(ctx, async () => {
    const ia = iaDuBanc(await ctx.api.get("/api/bootstrap"));
    const client = oc(ctx);

    // 1. Titre choisi : jamais touché par le plancher, ni à la création, ni après un tour, ni dans l'archive.
    const choisie = await client.creerConversation(TITRE_CHOISI);
    exigerPlancher(choisie.permission, PLANCHER_CONVERSATION, "écho de la création (titre choisi)");
    exiger(choisie.title === TITRE_CHOISI, `titre changé à la création : « ${choisie.title} ».`);
    const messagesChoisie = await unTour(ctx, client, choisie.id, "Explique notes.txt en une phrase.", ia, "Notes expliquées.");
    const relue = await client.session(choisie.id);
    exiger(relue.title === TITRE_CHOISI, `titre changé après le tour : « ${relue.title} ».`);
    await exigerArchive(ctx, choisie.id, TITRE_CHOISI, messagesChoisie, "Explique notes.txt en une phrase.");

    // 2. Sans titre : le cockpit n'en pose aucun ; opencode garde le sien, ou le fait écrire par une petite IA.
    const sansTitre = await client.creerConversation();
    exigerPlancher(sansTitre.permission, PLANCHER_CONVERSATION, "écho de la création (sans titre)");
    exiger(String(sansTitre.title).startsWith(TITRE_PAR_DEFAUT), `titre posé à la création : « ${sansTitre.title} ».`);
    const debutFournisseur = ctx.mode === "reel-hors-ligne" ? (await ctx.billedCalls()).length : 0;
    const messagesSansTitre = await unTour(ctx, client, sansTitre.id, "Résume changements.md en une phrase.", ia, "Changements résumés.");
    let titre;
    if (ctx.mode === "reel-hors-ligne") {
      // Titre écrit par une petite IA après le premier échange (course avec l'appel principal : on l'attend).
      titre = await attendreQue(
        async () => {
          const t = (await client.session(sansTitre.id)).title;
          return typeof t === "string" && t.length > 0 && !t.startsWith(TITRE_PAR_DEFAUT) ? t : false;
        },
        { delaiMs: 30_000, libelle: "titre écrit par la petite IA" },
      );
      const requetes = (await ctx.billedCalls()).slice(debutFournisseur);
      const sansOutil = requetes.filter((r) => Array.isArray(r.outils) && r.outils.length === 0);
      exiger(sansOutil.length > 0, `aucune requête de titre (sans outil) reçue : ${resume(requetes.map((r) => r.outils?.length))}`);
      releve(ctx, `titre écrit par la petite IA sous le plancher : « ${titre} » ; ${sansOutil.length} requête(s) sans outil, ${requetes.length - sansOutil.length} avec`);
    } else {
      titre = (await client.session(sansTitre.id)).title;
      exiger(titre === sansTitre.title, `titre changé après le tour : « ${titre} » au lieu de « ${sansTitre.title} ».`);
    }
    await exigerArchive(ctx, sansTitre.id, titre, messagesSansTitre, "Résume changements.md en une phrase.");
  });
}

/** Un tour de conversation ; rend les messages gardés par opencode. */
async function unTour(ctx, client, sessionId, texte, ia, reponse) {
  if (ctx.faux) await ctx.faux.scripter(sessionId, { text: reponse });
  const envoi = await client.envoyer(sessionId, texte, ia);
  exiger(envoi.code === 204, `envoi refusé (${envoi.code}) : ${resume(envoi.corps)}`);
  return await attendreFinDuTour(client, sessionId);
}

/**
 * Archive de la conversation (POST /api/archive/:id/refresh, comme après un repos) : titre `titre`, un seul message de vous, autant
 * de messages qu'opencode, la demande et la réponse dans la transcription, et aucune trace du plancher dans la transcription ni
 * dans l'export Markdown.
 */
async function exigerArchive(ctx, sessionId, titre, messages, demande) {
  const conversation = await ctx.api.post(`/api/archive/${encodeURIComponent(sessionId)}/refresh`);
  exiger(conversation?.sessionId === sessionId, `archive d'une autre conversation : ${resume(conversation?.sessionId)}`);
  exiger(conversation.title === titre, `titre de l'archive « ${conversation.title} » au lieu de « ${titre} ».`);
  exiger(conversation.promptCount === 1, `${conversation.promptCount} message(s) de vous dans l'archive au lieu d'un.`);
  exiger(conversation.messageCount === messages.length, `${conversation.messageCount} message(s) dans l'archive, ${messages.length} dans opencode.`);

  const lue = await ctx.api.get(`/api/archive/${encodeURIComponent(sessionId)}`);
  const transcription = String(lue?.transcript ?? "");
  exiger(lue?.conversation?.title === titre, `titre relu dans l'archive : « ${lue?.conversation?.title} ».`);
  exiger(transcription.includes(demande), `la demande manque à la transcription de l'archive : ${resume(transcription)}`);
  const reponse = messages
    .filter((m) => m.info?.role === "assistant")
    .flatMap((m) => m.parts ?? [])
    .filter((p) => p.type === "text" && typeof p.text === "string" && p.text.trim())
    .map((p) => p.text.trim())
    .at(-1);
  exiger(reponse && transcription.includes(reponse), `la réponse manque à la transcription de l'archive : ${resume(transcription)}`);

  const markdown = await ctx.api.brut("GET", `/api/archive/${encodeURIComponent(sessionId)}/export.md`);
  exiger(markdown.code === 200, `export Markdown refusé (${markdown.code}).`);
  for (const [source, texte] of [
    ["transcription", transcription],
    ["export Markdown", markdown.corps],
  ]) {
    const traces = MOTIFS_CLES.filter((motif) => texte.includes(motif));
    exiger(traces.length === 0, `plancher visible dans ${source} de l'archive : ${traces.join(", ")}`);
    exiger(!/"action"\s*:\s*"deny"|\bdeny\b/.test(texte), `règle du plancher visible dans ${source} de l'archive.`);
  }
}
