// Scénario e2e des équipes (itération 4, L41) : « Revue SQL sur réplica » de bout en bout sur le faux opencode.
//
// Sortie de la spécification §7.8 l.1189, première phrase : « avis de bout en bout sur le faux opencode ». Ce que le scénario
// établit, dans la vraie pile (cockpit et opencode en conteneurs, navigateur piloté) :
//   1. l'exemple « revue-sql » s'installe (un assistant du catalogue posé), l'estimation rend une empreinte, le lancement est
//      accepté (202) ;
//   2. les TROIS avis démarrent à moins de 2 s d'écart (`time.created` des sessions d'étape lues par le proxy du cockpit) :
//      ils sont indépendants et partent ensemble, jamais l'un après l'autre (spéc. §3.13, mesure ME-4) ;
//   3. chaque avis reçoit la demande et AUCUN ne voit le travail des autres ; la synthèse reçoit les trois (§6 l.1034) ;
//   4. le résultat est injecté dans la conversation SANS appel d'IA : injection `noReply`, aucun envoi facturable vers la
//      racine, et la carte de résultat de la page porte « …, puis recopié ici par le cockpit, sans appel d'IA. » (§6 l.1035) ;
//   5. le résultat n'apparaît QU'UNE FOIS dans la conversation, sans marqueur `<!-- cockpit:… -->` visible (L38c).
// En « --reel-hors-ligne », le faux fournisseur ne rend que du texte et ne pilote pas les étapes : le scénario le dit et ne
// joue rien (it4-outils-etape y tient la part réelle).
import { exiger, nonJoue, releve, resume } from "./it1-api-commun.mjs";
import { preparerPage } from "./it1-ui-commun.mjs";
import { attendreRun, DEMANDE, enAvance, ETAPES_AVIS, lancerExemple, ouvrirLaConversation, premierMessage, scripterEtape } from "./it4-commun.mjs";

/** Écart maximal entre les créations des trois avis (fiche L41 ; seuil de la mesure ME-4). */
const ECART_AVIS_MS = 2_000;

/** Texte joué par chaque étape : reconnaissable, et différent d'un avis à l'autre. */
const AVIS = {
  exactitude: "Avis exactitude : deux jointures à revoir.",
  performance: "Avis performance : ajouter un index sur la colonne date.",
  "donnees-sensibles": "Avis données sensibles : masquer la colonne adresse.",
  synthese: "Synthèse : corriger les jointures, puis mesurer le gain.",
};

/** Marqueurs que le cockpit pose dans le texte injecté et que la page ne doit jamais montrer (L38c). */
const MARQUEUR = /<!--\s*cockpit:/;

export async function run(ctx) {
  if (ctx.mode !== "faux") {
    nonJoue(ctx, "avis de bout en bout", "le faux fournisseur ne rend que du texte : les étapes d'une équipe n'y sont pas scriptables");
    ctx.expectNoConsoleErrors();
    return;
  }
  const page = await preparerPage(ctx);

  await enAvance(ctx, async () => {
    for (const [stepId, texte] of Object.entries(AVIS)) {
      await scripterEtape(ctx, stepId, { text: texte, cost: 0.01, tokens: { input: 120, output: 40 }, stepMs: 5 });
    }

    // 1. Installation, estimation, lancement.
    const { api, runId, rootId } = await lancerExemple(ctx, "revue-sql");
    const finie = await attendreRun(api, runId, (vue) => vue.state === "terminee", "équipe « revue-sql » terminée");
    exiger(finie.steps.length === ETAPES_AVIS.length, `${finie.steps.length} étape(s) au lieu de ${ETAPES_AVIS.length} : ${resume(finie.steps.map((s) => s.stepId))}`);
    for (const step of finie.steps) exiger(step.state === "terminee", `étape ${step.stepId} : état « ${step.state} ».`);

    // 2. Trois avis démarrés à moins de 2 s d'écart : `time.created` des sessions, lu par le proxy du cockpit.
    const sessions = new Map(finie.steps.map((step) => [step.stepId, step.sessionId]));
    for (const stepId of ETAPES_AVIS) exiger(typeof sessions.get(stepId) === "string", `étape ${stepId} sans session.`);
    const creations = [];
    for (const stepId of ETAPES_AVIS.slice(0, 3)) {
      const session = await ctx.api.get(`/api/oc/session/${encodeURIComponent(sessions.get(stepId))}?directory=${encodeURIComponent(api.directory)}`);
      exiger(session?.parentID === rootId, `l'avis ${stepId} n'est pas fille de la racine (parentID ${session?.parentID}).`);
      creations.push({ stepId, cree: session?.time?.created });
    }
    for (const { stepId, cree } of creations) exiger(Number.isFinite(cree), `l'avis ${stepId} n'a pas d'instant de création.`);
    const instants = creations.map((ligne) => ligne.cree);
    const ecart = Math.max(...instants) - Math.min(...instants);
    releve(ctx, `avis démarrés à ${ecart} ms d'écart : ${creations.map((l) => `${l.stepId}=${l.cree}`).join(", ")}`);
    exiger(ecart < ECART_AVIS_MS, `les trois avis démarrent à ${ecart} ms d'écart (moins de ${ECART_AVIS_MS} ms attendu).`);

    // 3. Chaque avis reçoit la demande ; aucun ne voit le travail des autres ; la synthèse reçoit les trois.
    const consignes = new Map();
    for (const stepId of ETAPES_AVIS) consignes.set(stepId, await premierMessage(ctx, sessions.get(stepId)));
    for (const stepId of ETAPES_AVIS.slice(0, 3)) {
      const consigne = consignes.get(stepId);
      exiger(consigne.includes(DEMANDE), `l'avis ${stepId} ne reçoit pas la demande.`);
      exiger(!consigne.includes("Avis "), `l'avis ${stepId} voit le travail d'un autre avis.`);
    }
    for (const stepId of ETAPES_AVIS.slice(0, 3)) {
      exiger(consignes.get("synthese").includes(AVIS[stepId]), `la synthèse ne reçoit pas l'avis « ${stepId} ».`);
    }

    // 4. Résultat injecté sans appel d'IA : injection `noReply`, aucun envoi facturable vers la racine.
    const requetes = await ctx.opencodeRequests();
    const versRacine = requetes.filter((requete) => requete.method === "POST" && requete.pathname === `/session/${rootId}/message`);
    exiger(versRacine.length === 2, `${versRacine.length} injection(s) dans la racine au lieu de 2 (demande puis résultat).`);
    for (const injection of versRacine) exiger(injection.body?.noReply === true, `injection sans noReply : ${resume(injection.body)}`);
    // Aucun ENVOI vers la racine : les deux injections passent par `POST /session/:id/message` avec `noReply`, qui ne
    // déclenche aucun appel d'IA. `ctx.billedCalls()` du banc compte tout `POST …/message` comme facturable : sa règle
    // (docker-e2e.mjs, propriété de L7a) ne connaît pas encore `noReply`. Constat remis à l'intégrateur ; ici, c'est le
    // journal du faux qui tranche, et il est plus exigeant : aucun `prompt_async`, aucun `command`, aucun `summarize`.
    const appelsIa = requetes.filter(
      (requete) => requete.method === "POST" && new RegExp(`^/session/${rootId}/(prompt_async|command|summarize|shell)$`).test(requete.pathname),
    );
    exiger(appelsIa.length === 0, `${appelsIa.length} appel(s) d'IA sur la racine : ${resume(appelsIa.map((r) => r.pathname))}`);

    // 5. La page : carte de résultat avec sa phrase, une seule fois, sans marqueur visible.
    await ouvrirLaConversation(ctx, rootId);
    await page.attendreQue("document.querySelector('.team-result')", { libelle: "carte de résultat de l'équipe" });
    const vueDeLaPage = await page.evaluer(`(() => {
      const cartes = [...document.querySelectorAll(".team-result")];
      const fil = document.querySelector(".chat-thread");
      return {
        cartes: cartes.length,
        notes: cartes.map((carte) => [...carte.querySelectorAll(".team-card-note")].map((n) => n.textContent.trim())).flat(),
        texte: cartes.map((carte) => carte.textContent).join(" "),
        fil: fil ? fil.textContent : "",
        bulles: [...document.querySelectorAll(".user-msg")].map((b) => b.textContent.trim()),
      };
    })()`);
    exiger(vueDeLaPage.cartes === 1, `${vueDeLaPage.cartes} carte(s) de résultat dans la conversation : le résultat doit n'apparaître qu'une fois.`);
    exiger(
      vueDeLaPage.notes.some((note) => note.includes("recopié ici par le cockpit, sans appel d'IA.")),
      `la carte de résultat ne porte pas « …, puis recopié ici par le cockpit, sans appel d'IA. » : ${resume(vueDeLaPage.notes)}`,
    );
    exiger(vueDeLaPage.texte.includes(AVIS.synthese), "la carte de résultat ne porte pas le texte de la synthèse.");
    exiger(!MARQUEUR.test(vueDeLaPage.fil), "un marqueur « <!-- cockpit: » est visible dans la conversation.");
    // La demande recopiée par le cockpit est une bulle « Vous » ordinaire, avec sa puce et sans encadrement.
    const bulleDemande = vueDeLaPage.bulles.find((bulle) => bulle.includes(DEMANDE));
    exiger(bulleDemande !== undefined, `la demande recopiée n'est pas une bulle « Vous » : ${resume(vueDeLaPage.bulles)}`);
    exiger(bulleDemande.includes("Envoyé à l'équipe"), `la bulle de la demande n'a pas sa puce : ${resume(bulleDemande)}`);
    exiger(!bulleDemande.includes("<<<") && !bulleDemande.includes("‹‹‹"), "la demande recopiée est encadrée dans la bulle.");
    releve(ctx, `résultat injecté une seule fois, sans marqueur ; ${versRacine.length} injections noReply, aucun appel facturable sur la racine`);
  });

  ctx.expectNoConsoleErrors();
}
