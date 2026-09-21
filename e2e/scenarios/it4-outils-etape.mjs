// Scénario e2e des équipes (itération 4, L41) : les outils offerts à l'IA d'une étape (spéc. §6 l.1032, mesure ME-2).
//
// Sortie de la spécification §7.8 l.1189, troisième phrase : « outils absents d'une étape en e2e ». Une étape d'équipe ne
// modifie rien, ne lance aucune commande, ne va pas sur Internet, ne délègue pas et ne pose aucune question : les outils
// correspondants ne sont même pas OFFERTS à l'IA.
//
// C'est le scénario du mode « --reel-hors-ligne » (opencode 1.18.30 RÉEL, faux fournisseur hors ligne, leviers de M-B1) :
// la liste relevée est celle que le VRAI opencode a envoyée au faux fournisseur, sans aucun oracle et sans aucun coût.
// En « --faux », le scénario tient la même exigence par l'oracle du faux opencode (outils intégrés de l'IA, moins ceux
// qu'une règle « deny » retire), calculé sur les règles que le proxy du cockpit rend pour la session d'étape.
import { attendreQue, exiger, oc, outilsDuFaux, releve, requetesAvecOutils, resume } from "./it1-api-commun.mjs";
import { attendreRun, DOSSIER_EQUIPE, enAvance, equipeDerivee, equipes, estimerEtLancer, etapesDuFlow, scripterEtape } from "./it4-commun.mjs";

/**
 * Outils qu'une étape ne doit jamais se voir offrir (fiche L41 ; `apply_patch` remplace `edit` et `write` sur certaines IA,
 * mesure M2 : il est refusé pour la même raison).
 */
const INTERDITS = ["edit", "write", "apply_patch", "bash", "task", "webfetch", "websearch", "question"];

/** Outils attendus d'une étape en lecture seule (ME-2) : le scénario vérifie qu'il en reste, sinon l'absence ne prouve rien. */
const ATTENDUS = ["read", "grep", "glob"];

export async function run(ctx) {
  const client = oc(ctx, DOSSIER_EQUIPE);

  await enAvance(ctx, async () => {
    const api = equipes(ctx);
    const equipe = await equipeDerivee(api, "relecture-script", "o");
    const etapes = etapesDuFlow(equipe.flow);
    if (ctx.mode === "faux") {
      for (const stepId of etapes) {
        await scripterEtape(ctx, stepId, { text: "Relecture faite.", cost: 0.01, tokens: { input: 90, output: 20 }, stepMs: 5 });
      }
    }

    const debut = ctx.mode === "faux" ? 0 : (await ctx.billedCalls()).length;
    const { runId } = await estimerEtLancer(api, equipe.id);
    const etape1 = etapes[0];
    const lancee = await attendreRun(
      api,
      runId,
      (vue) => vue.steps.some((step) => step.stepId === etape1 && step.sessionId !== null && (step.state === "en-cours" || step.state === "terminee")),
      `étape 1 « ${etape1} » lancée`,
    );
    const session = lancee.steps.find((step) => step.stepId === etape1).sessionId;

    let outils;
    if (ctx.mode === "faux") {
      // Oracle du faux : outils intégrés de l'IA, moins ceux dont la dernière règle est « deny » (règles lues par le proxy).
      const vue = await client.session(session);
      const agents = await client.agents();
      outils = outilsDuFaux(vue, agents, { agent: vue.agent });
    } else {
      // Réel hors ligne : la liste est celle que le vrai opencode a envoyée au faux fournisseur, pour CETTE session d'étape.
      // Le vrai opencode met quelques secondes entre `prompt_async` et l'appel du fournisseur : on l'attend.
      const appels = await attendreQue(async () => {
        const recues = await requetesAvecOutils(ctx, debut);
        return recues.length > 0 ? recues : false;
      }, { delaiMs: 90_000, pasMs: 1_000, libelle: "requête du faux fournisseur proposant des outils (étape de l'équipe)" });
      outils = [...new Set(appels.flatMap((appel) => appel.outils))].sort((a, b) => a.localeCompare(b));
    }

    const restes = INTERDITS.filter((outil) => outils.includes(outil));
    exiger(restes.length === 0, `outil(s) interdit(s) offerts à l'IA de l'étape : ${restes.join(", ")} (liste : ${resume(outils)})`);
    const manquants = ATTENDUS.filter((outil) => !outils.includes(outil));
    exiger(manquants.length === 0, `l'étape n'a plus d'outil de lecture (${manquants.join(", ")} absent(s)) : l'absence des interdits ne prouverait rien.`);
    releve(ctx, `outils offerts à l'étape « ${etape1} » (${ctx.mode}) : ${outils.join(", ")}`);

    // L'équipe de ce scénario s'arrête au bloc « pause » : elle est arrêtée pour ne pas rester active sur la pile partagée.
    const arret = await api.arreterBrut(runId);
    exiger([200, 409].includes(arret.code), `arrêt du lancement refusé (${arret.code}) : ${resume(arret.corps)}`);
  });

  ctx.expectNoConsoleErrors();
}
