// Scénario e2e des équipes (itération 4, L41) : « Chaîne de relecture de script », pause du déroulé et reprise avec une
// précision (spécification §3.13, §7.8 l.1187 ; plan it4, fiche L41).
//
// Ce que le scénario établit, dans la vraie pile, sur le faux opencode :
//   1. l'équipe s'arrête d'elle-même au bloc « pause » du déroulé, après l'étape 1 : état « attente-verification », cause
//      « pause », et la carte de pause de la page porte le message du déroulé et « Rien n'est facturé pendant la pause. » ;
//   2. RIEN n'est envoyé pendant la pause : aucun `prompt_async` ne part tant que [Continuer] n'a pas été demandé ;
//   3. [Continuer] avec une précision : la précision est présente, VISIBLE, dans le message de l'ÉTAPE 2 (« securite »),
//      relevé dans le JOURNAL DU FAUX opencode, pas seulement dans la base du cockpit ;
//   4. l'équipe va jusqu'au bout et le résultat est injecté une seule fois.
// En « --reel-hors-ligne », les étapes ne sont pas scriptables : le scénario le dit et ne joue rien.
import { attendre, exiger, nonJoue, releve, resume } from "./it1-api-commun.mjs";
import { preparerPage } from "./it1-ui-commun.mjs";
import { attendreRun, enAvance, equipes, ETAPES_SUITE, installerExemple, lancer, ouvrirLaConversation, repere, requetesDepuis, scripterEtape } from "./it4-commun.mjs";

/** Précision écrite par l'utilisateur dans la carte de pause : reconnaissable dans le message de l'étape suivante. */
const PRECISION = "Ne regardez que le script de sauvegarde de nuit.";

/** Texte joué par chaque étape ; le même suffit : ce que le scénario suit est la consigne REÇUE, pas la réponse. */
const TOUR = { text: "Relecture faite : rien de bloquant.", cost: 0.01, tokens: { input: 100, output: 30 }, stepMs: 5 };

const envois = (requetes) => requetes.filter((requete) => requete.method === "POST" && requete.pathname.endsWith("/prompt_async"));

export async function run(ctx) {
  if (ctx.mode !== "faux") {
    nonJoue(ctx, "pause et reprise avec précision", "le faux fournisseur ne rend que du texte : les étapes d'une équipe n'y sont pas scriptables");
    ctx.expectNoConsoleErrors();
    return;
  }
  const page = await preparerPage(ctx);

  await enAvance(ctx, async () => {
    // Un script par étape de l'exemple : les scénarios partagent un faux, et un prédicat vaut pour toute session créée ensuite.
    for (const stepId of ETAPES_SUITE) await scripterEtape(ctx, stepId, TOUR);
    const api = equipes(ctx);
    await installerExemple(api, "relecture-script");
    const estimation = await api.estimer("relecture-script");
    exiger(estimation.blocage == null, `estimation bloquée : ${resume(estimation.blocage)}`);
    const { runId, rootId } = await lancer(api, "relecture-script", estimation);

    // 1. Pause du déroulé après l'étape 1.
    const enPause = await attendreRun(api, runId, (vue) => vue.state === "attente-verification", "équipe en pause au bloc « pause »");
    exiger(enPause.pause !== null, "l'équipe est en pause sans carte de pause.");
    exiger(enPause.cause === "pause", `cause de la pause « ${enPause.cause} », attendu « pause ».`);
    const etat = (stepId) => enPause.steps.find((step) => step.stepId === stepId)?.state;
    exiger(etat("standards") === "terminee", `étape 1 « standards » : état « ${etat("standards")} ».`);
    exiger(etat("securite") !== "en-cours" && etat("securite") !== "terminee", `étape 2 « securite » lancée pendant la pause : « ${etat("securite")} ».`);

    // 2. Rien n'est envoyé pendant la pause.
    const avantReprise = await repere(ctx);
    await attendre(500);
    const pendantLaPause = envois(await requetesDepuis(ctx, avantReprise));
    exiger(pendantLaPause.length === 0, `${pendantLaPause.length} envoi(s) pendant la pause : ${resume(pendantLaPause.map((r) => r.pathname))}`);

    // La page montre la carte de pause, son message et la phrase de gratuité.
    await ouvrirLaConversation(ctx, rootId);
    await page.attendreQue("document.querySelector('.team-pause')", { libelle: "carte de pause de l'équipe" });
    const texteDeLaPause = await page.texte(".team-pause");
    exiger(texteDeLaPause.includes("Rien n'est facturé pendant la pause."), `la carte de pause ne dit pas la gratuité : ${resume(texteDeLaPause)}`);
    exiger(texteDeLaPause.includes("Précision pour la suite"), `la carte de pause n'offre pas de précision : ${resume(texteDeLaPause)}`);

    // 3. [Continuer] avec une précision : elle est dans le message de l'étape 2, relevé dans le journal du faux.
    const avantEtape2 = await repere(ctx);
    const reprise = await api.continuerBrut(runId, { precision: PRECISION });
    exiger(reprise.code === 200, `reprise refusée (${reprise.code}) : ${resume(reprise.corps)}`);
    const finie = await attendreRun(api, runId, (vue) => vue.state === "terminee", "équipe « relecture-script » terminée");
    for (const stepId of ETAPES_SUITE) {
      exiger(
        finie.steps.find((step) => step.stepId === stepId)?.state === "terminee",
        `étape ${stepId} : état « ${finie.steps.find((step) => step.stepId === stepId)?.state} ».`,
      );
    }
    const securite = finie.steps.find((step) => step.stepId === "securite")?.sessionId;
    exiger(typeof securite === "string", "l'étape 2 « securite » n'a pas de session.");
    const journal = (await ctx.opencodeRequests()).slice(avantEtape2);
    const versEtape2 = envois(journal).filter((requete) => requete.pathname === `/session/${securite}/prompt_async`);
    exiger(versEtape2.length === 1, `${versEtape2.length} envoi(s) vers l'étape 2 au lieu d'un seul.`);
    const consigne = (versEtape2[0].body?.parts ?? []).map((part) => part.text ?? "").join("");
    exiger(consigne.includes(PRECISION), `la précision n'est pas dans le message de l'étape 2 : ${resume(consigne, 400)}`);
    releve(ctx, `précision reprise dans l'étape 2 (« securite »), relevée dans le journal du faux ; ${envois(journal).length} envoi(s) après la reprise`);

    // 4. Résultat injecté une seule fois.
    await ouvrirLaConversation(ctx, rootId);
    await page.attendreQue("document.querySelector('.team-result')", { libelle: "carte de résultat après la reprise" });
    const cartes = await page.evaluer("document.querySelectorAll('.team-result').length");
    exiger(cartes === 1, `${cartes} carte(s) de résultat : le résultat doit n'apparaître qu'une fois.`);
  });

  ctx.expectNoConsoleErrors();
}
