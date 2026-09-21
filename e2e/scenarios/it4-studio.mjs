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
//      sont donc jouées HORS du témoin P6, qui verrait cette libération voulue.
// En « --reel-hors-ligne », les étapes ne sont pas scriptables : le scénario le dit et ne joue rien.
import { avecTemoinP6, exiger, nonJoue, releve, resume } from "./it1-api-commun.mjs";
import { preparerPage } from "./it1-ui-commun.mjs";
import { appelConfirme, attendreRun, enAvance, equipeDerivee, equipes, estimerEtLancer, etapesDuFlow, scripterEtape } from "./it4-commun.mjs";

/** Pas d'une étape assez longue pour que les trois écritures tombent pendant qu'elle travaille. */
const PAS_LONG_MS = 3_000;

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
      const finie = await attendreRun(api, runId, (vue) => vue.state === "terminee", "équipe terminée après les refus de la garde");
      for (const step of finie.steps) exiger(step.state === "terminee", `étape ${step.stepId} : état « ${step.state} » après les refus.`);
    });

    // 3. Après l'équipe : les mêmes écritures passent. Hors du témoin P6 : elles rechargent opencode, c'est leur objet.
    for (const ecriture of ECRITURES.filter((candidate) => candidate.apres !== null)) {
      const reponse = await ecriture.appel(ctx);
      exiger(reponse.code === ecriture.apres, `${ecriture.nom} après l'équipe : code ${reponse.code} au lieu de ${ecriture.apres} — ${resume(reponse.corps)}`);
    }
    releve(ctx, "après l'équipe : Studio et réalignement acceptés (200)");
  });

  // Le refus 409 du réalignement est VOULU par ce scénario, et il est demandé depuis la page : le navigateur le note dans sa
  // console comme toute réponse ≥ 400. C'est le seul écart toléré, et il disparaîtrait si la garde cessait de refuser.
  ctx.expectNoConsoleErrors([/\/api\/ai\/realign/]);
}
