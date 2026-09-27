// Scénario e2e de l'itération 5 (répétition générale de la 5b, versé à la grande fusion, GF4, décision A20) : MC5-2 REJOUÉE
// SUR LE CODE RÉEL.
//
// La mesure MC5 (train de V0 de 5a, `mesures/MC5.md`) a tenu MC5-2 sur un banc dédié. Le plan d'exécution it5 (§3.1, §5.3
// V4, fiche L50b) demande à la répétition générale de la 5b de la rejouer « sur le code réel (`--reel-hors-ligne`) ». Les
// scénarios `c5b-*` de L50b pilotent le FAUX opencode et ne sont pas joués en réel : celui-ci le fait, avec un VRAI opencode
// 1.18.30, le faux fournisseur hors ligne du banc, aucun appel facturé, jamais Copilot. Il est resté hors dépôt jusqu'à la
// grande fusion (A20) ; le banc du dépôt expose désormais le pilotage du faux fournisseur (`ctx.fournisseur`).
//
// Ce qu'il établit :
//   A. le protocole de MC5-2 par le proxy du cockpit : deux `prompt_async` successifs dans la MÊME conversation au repos ;
//      le second appel reçu par le fournisseur porte tout l'historique (au moins deux messages de plus), avec la même
//      invite système ; la dernière ligne rendue au tour 1 est « VERDICT: À REPRENDRE » À L'OCTET, accents compris, et
//      elle l'est encore après le tour 2 ;
//   B. le VRAI exécuteur d'équipe (L42b) sur l'exemple « postmortem » (bloc relecture, toursMax 2, pause avant relecture) :
//      rien n'est envoyé au relecteur pendant la pause ; les tours suivants REPRENNENT les sessions du tour 1 (D-5-14) —
//      exactement deux sessions d'étape sous la racine, cinq appels principaux (trois jets, deux relectures), et chaque
//      appel d'une même étape porte l'historique du précédent ; les deux verdicts sont lus « a-reprendre » sur la
//      dernière ligne, relue ici à l'octet dans la session du relecteur ; le plafond de tours est respecté.
//
// Le faux fournisseur ne rend que du texte : chaque appel reçoit la MÊME réponse, terminée par la ligne de verdict (réponse
// par défaut du banc, remise à la sienne à la fin, même en échec). Hors de « --reel-hors-ligne », le scénario se dit
// « non joué » : il demande un vrai opencode. Le banc est celui du dépôt (HTTPS épinglé, préfixe de projet choisi au
// lancement, jamais celui d'un autre travail).
import { attendreFinDuTour, attendreQue, exiger, iaDuBanc, nonJoue, oc, releve, requetesAvecOutils, resume } from "./it1-api-commun.mjs";
import { attendreRun, enAvance, equipes } from "./it4-commun.mjs";
import { arreterLesLancements, equipeDeriveeC5, FINIS } from "./c5b-relecture.mjs";

const EXEMPLE = "postmortem";
const REDACTION = "redaction";
const RELECTURE = "relecture";
const A_REPRENDRE = "VERDICT: À REPRENDRE";
const TEXTE = `Réponse du banc pour MC5-2, sans texte réel.\n\n${A_REPRENDRE}`;
/** Réponse par défaut du faux fournisseur (e2e/lib/faux-fournisseur.mjs) : remise à la fin, même en échec. */
const DEFAUT_DU_BANC = { texte: "Réponse du faux fournisseur du banc.", cout: { entree: 20, sortie: 6 } };

const derniereLigne = (texte) => String(texte ?? "").replace(/\s+$/u, "").split("\n").at(-1) ?? "";
const texteDe = (message) =>
  (message?.parts ?? [])
    .filter((part) => part?.type === "text" && typeof part.text === "string")
    .map((part) => part.text)
    .join("");
const octets = (texte) => Buffer.from(String(texte), "utf8").toString("hex");
const aLOctet = (texte) => Buffer.from(derniereLigne(texte), "utf8").equals(Buffer.from(A_REPRENDRE, "utf8"));

/** Chaque appel d'un groupe porte l'historique du précédent : au moins deux messages de plus (demande et réponse). */
function historiqueCroissant(appels) {
  return appels.every((appel, rang) => rang === 0 || appel.messages >= appels[rang - 1].messages + 2);
}

export async function run(ctx) {
  if (ctx.mode !== "reel-hors-ligne") {
    nonJoue(ctx, "MC5-2 sur le code réel", "elle demande un VRAI opencode et le faux fournisseur hors ligne (« --reel-hors-ligne »)");
    return;
  }
  exiger(ctx.fournisseur && typeof ctx.fournisseur.tourParDefaut === "function", "le banc n'expose pas le pilotage du faux fournisseur (ctx.fournisseur).");
  const client = oc(ctx);
  const ia = await attendreQue(
    async () => {
      try {
        return iaDuBanc(await ctx.api.get("/api/bootstrap"));
      } catch {
        return false;
      }
    },
    { delaiMs: 60_000, pasMs: 2_000, libelle: "IA du banc au catalogue du cockpit" },
  );

  const lancements = [];
  let api = null;
  await ctx.fournisseur.tourParDefaut({ texte: TEXTE, cout: { entree: 20, sortie: 6 } });
  try {
    // --- A. Protocole de MC5-2 par le proxy du cockpit ----------------------------------------------------------------
    const racine = await client.creerConversation("c5b-mc5-reel");
    exiger(typeof racine?.id === "string", `conversation non créée : ${resume(racine)}`);
    const depart = (await ctx.billedCalls()).length;
    const envoi1 = await client.envoyer(racine.id, "Premier tour : relis la note d'incident.", ia, "build");
    exiger(envoi1.code === 204, `premier envoi refusé (${envoi1.code}) : ${resume(envoi1.corps)}`);
    const messages1 = await attendreFinDuTour(client, racine.id, { delaiMs: 90_000 });
    const reponse1 = messages1.findLast((m) => m.info?.role === "assistant");
    releve(ctx, `A. dernière ligne du tour 1 : ${JSON.stringify(derniereLigne(texteDe(reponse1)))} (octets ${octets(derniereLigne(texteDe(reponse1)))})`);
    exiger(aLOctet(texteDe(reponse1)), `A. dernière ligne du tour 1 « ${derniereLigne(texteDe(reponse1))} » au lieu de « ${A_REPRENDRE} » à l'octet.`);
    const appels1 = await requetesAvecOutils(ctx, depart);
    exiger(appels1.length >= 1, `A. aucun appel principal reçu au tour 1 : ${resume(appels1)}`);

    const avant2 = (await ctx.billedCalls()).length;
    const envoi2 = await client.envoyer(racine.id, "Second tour : reprends les points signalés.", ia, "build");
    exiger(envoi2.code === 204, `second envoi refusé (${envoi2.code}) : ${resume(envoi2.corps)}`);
    const messages2 = await attendreFinDuTour(client, racine.id, { delaiMs: 90_000 });
    const appels2 = await requetesAvecOutils(ctx, avant2);
    exiger(appels2.length >= 1, `A. aucun appel principal reçu au tour 2 : ${resume(appels2)}`);
    const [p1, p2] = [appels1[0], appels2[0]];
    releve(ctx, `A. appel du tour 1 : ${p1.messages} message(s), invite ${p1.systeme} ; tour 2 : ${p2.messages} message(s), invite ${p2.systeme}`);
    exiger(p2.messages >= p1.messages + 2, `A. historique perdu au tour 2 : ${p2.messages} message(s) contre ${p1.messages} au tour 1.`);
    exiger(p2.systeme === p1.systeme, `A. invite système changée entre les deux tours (${p1.systeme} → ${p2.systeme}).`);
    const assistants2 = messages2.filter((m) => m.info?.role === "assistant");
    exiger(assistants2.length === 2, `A. ${assistants2.length} message(s) d'assistant après deux tours (2 attendus).`);
    exiger(aLOctet(texteDe(assistants2[0])), "A. la réponse du tour 1 n'est plus terminée par la ligne de verdict après le tour 2.");

    // --- B. Le vrai exécuteur d'équipe : relecture de l'exemple « postmortem » ------------------------------------------
    await enAvance(ctx, async () => {
      api = equipes(ctx);
      const equipe = await equipeDeriveeC5(api, EXEMPLE, null);
      const bloc = equipe.flow.blocs.find((candidat) => candidat.type === "relecture");
      exiger(bloc !== undefined && bloc.toursMax === 2 && bloc.pauseAvantRelecture === true, `bloc de relecture inattendu : ${resume(bloc)}`);
      exiger(bloc.auteur.id === REDACTION && bloc.relecteur.id === RELECTURE, `étapes « ${bloc.auteur.id} » et « ${bloc.relecteur.id} ».`);

      const estimation = await api.estimer(EXEMPLE);
      exiger(estimation.blocage == null, `estimation bloquée : ${resume(estimation.blocage)}`);
      exiger(estimation.estimate?.repetitions?.tours === 2, `l'estimation annonce ${resume(estimation.estimate?.repetitions?.tours)} tour(s) au plus au lieu de 2.`);
      const debut = (await ctx.billedCalls()).length;
      const lancement = await api.lancerBrut(EXEMPLE, {
        directory: api.directory,
        rootId: null,
        demande: "Rédige le compte rendu de la coupure du banc.",
        fichiers: [],
        agentConversation: "build",
        estimateSha256: estimation.estimateSha256,
        confirmations: { workspace: true },
      });
      exiger(lancement.code === 202, `lancement refusé (${lancement.code}) : ${resume(lancement.corps, 400)}`);
      const { runId, rootId } = JSON.parse(lancement.corps);
      lancements.push(runId);

      // Pause avant la première relecture : un seul appel principal (le premier jet), rien pour le relecteur.
      const enPause = await attendreRun(api, runId, (vue) => vue.state === "attente-verification" || FINIS.has(vue.state), "pause avant la première relecture", 180_000);
      exiger(enPause.state === "attente-verification", `état « ${enPause.state} » au lieu de la pause avant relecture : ${resume(enPause.steps.map((s) => `${s.stepId}/${s.tour}=${s.state}`))}`);
      const pendant = await requetesAvecOutils(ctx, debut);
      exiger(pendant.length === 1, `${pendant.length} appel(s) principal(aux) pendant la pause (1 attendu : le premier jet).`);

      const reprise = await api.continuerBrut(runId, {});
      exiger(reprise.code === 200, `reprise refusée (${reprise.code}) : ${resume(reprise.corps, 300)}`);
      const finie = await attendreRun(api, runId, (vue) => FINIS.has(vue.state), "relecture terminée", 300_000);
      releve(ctx, `B. étapes : ${resume(finie.steps.map((s) => `${s.stepId} tour ${s.tour ?? 1} : ${s.state} ${s.verdict ?? ""}`.trim()), 400)}`);
      exiger(finie.state === "terminee", `lancement en état « ${finie.state} ».`);
      const tours = (stepId) => finie.steps.filter((step) => step.stepId === stepId);
      exiger(tours(RELECTURE).length === 2, `${tours(RELECTURE).length} relecture(s) au lieu de 2 : plafond de tours.`);
      exiger(tours(REDACTION).length === 3, `${tours(REDACTION).length} rédaction(s) au lieu de 3.`);
      const verdicts = tours(RELECTURE).map((step) => step.verdict ?? null);
      exiger(verdicts.every((verdict) => verdict === "a-reprendre"), `verdicts lus par l'exécuteur : ${resume(verdicts)}.`);

      // Sessions reprises (D-5-14) : une session par étape, la même à chaque tour, et deux enfants sous la racine.
      const sessionsDe = (stepId) => new Set(tours(stepId).map((step) => step.sessionId));
      exiger(sessionsDe(REDACTION).size === 1 && sessionsDe(RELECTURE).size === 1, `sessions par étape : rédaction ${resume([...sessionsDe(REDACTION)])}, relecture ${resume([...sessionsDe(RELECTURE)])}.`);
      const enfants = (await client.enfants(rootId)) ?? [];
      releve(ctx, `B. sessions d'étape sous la racine : ${enfants.length}`);
      exiger(enfants.length === 2, `${enfants.length} session(s) d'étape sous la racine au lieu de 2 : un tour suivant a ouvert une session neuve (D-5-14).`);
      const idsEnfants = new Set(enfants.map((e) => e.id));
      exiger([...sessionsDe(REDACTION), ...sessionsDe(RELECTURE)].every((id) => idsEnfants.has(id)), "les sessions des étapes ne sont pas les enfants de la racine.");

      // Appels reçus par le fournisseur : cinq, en deux familles d'invite système, l'historique toujours transmis.
      const appels = await requetesAvecOutils(ctx, debut);
      const familles = new Map();
      for (const appel of appels) familles.set(appel.systeme, [...(familles.get(appel.systeme) ?? []), appel]);
      const tailles = [...familles.values()].map((liste) => liste.map((a) => a.messages));
      releve(ctx, `B. appels principaux : ${appels.length} ; messages par invite système : ${JSON.stringify(tailles)}`);
      exiger(appels.length === 5, `${appels.length} appel(s) principal(aux) au lieu de 5 (trois jets, deux relectures).`);
      const comptes = [...familles.values()].map((liste) => liste.length).sort((a, b) => a - b);
      exiger(JSON.stringify(comptes) === JSON.stringify([2, 3]), `familles d'invite système : ${resume(comptes)} au lieu de [2, 3].`);
      exiger([...familles.values()].every(historiqueCroissant), `historique non transmis d'un tour à l'autre : ${JSON.stringify(tailles)}.`);

      // Dernière ligne de chaque relecture, relue ici à l'octet dans la session du relecteur.
      const [sessionRelecture] = [...sessionsDe(RELECTURE)];
      const messagesRelecture = (await client.messages(sessionRelecture)) ?? [];
      const reponses = messagesRelecture.filter((m) => m.info?.role === "assistant");
      releve(ctx, `B. réponses du relecteur : ${reponses.length}, dernières lignes ${JSON.stringify(reponses.map((m) => derniereLigne(texteDe(m))))}`);
      exiger(reponses.length === 2, `${reponses.length} réponse(s) dans la session du relecteur au lieu de 2.`);
      exiger(reponses.every((m) => aLOctet(texteDe(m))), "une relecture ne se termine pas par la ligne de verdict à l'octet.");
    });
  } finally {
    if (api !== null) await arreterLesLancements(api, lancements);
    await ctx.fournisseur.tourParDefaut(DEFAUT_DU_BANC);
  }
}
