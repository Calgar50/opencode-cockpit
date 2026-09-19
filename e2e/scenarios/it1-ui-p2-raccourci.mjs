// Scénario e2e de l'interface de l'itération 1 (L7b-2) : capture p2, « lancé sans confirmation ».
//
// Spécification §6 l.1048 (phrase affichée « lancé sans confirmation » ; application : détection `subtask` ; test : capture p2),
// §4.10 (raccourcis `subtask`, oc/tool/task.ts:119 : « subtask estimé à l'envoi (existant), « lancé sans confirmation » »), §5.7.2.
// Capture p2 (fixtures/p2-commande-subtask.jsonl, opencode 1.18.30) : la commande `revue-croisee` (`subtask: true`) lance son
// sous-agent SANS demande d'autorisation ; la partie `task` porte `input.command`.
//
// Le banc ne peut ni déclarer un raccourci dans le faux opencode (GET /command y est vide), ni rejouer une capture : le tour est donc
// joué par le faux comme opencode le produit pour un raccourci `subtask`, une partie `task` sans demande dont l'entrée porte
// `command: "revue-croisee"` (même partie que la capture, que la dérivation du cockpit lit : shared/activity-facts.ts).
//
// Ce que le scénario établit (« --faux », mode Avancé, où la liste des acteurs nomme le raccourci) :
//   1. la délégation est lancée sans aucune demande d'autorisation (aucune reçue, aucune réponse envoyée) ;
//   2. le cockpit l'enregistre comme lancée par le raccourci, sans confirmation (GET …/activity : source « raccourci », commande
//      « revue-croisee », sansConfirmation, aucune demande) ;
//   3. la page la montre : « Qui travaille ? » nomme « raccourci /revue-croisee », la carte dessine la consigne ; captures p2 des six
//      tailles pendant le travail délégué ;
//   4. la page dit « lancé sans confirmation » (phrase du tableau d'honnêteté) ;
//   5. aucune violation de la CSP, console muette, P6 et P4 tenus.
// En « --reel-hors-ligne », le faux fournisseur ne délègue pas : rien n'est joué.
import {
  activite,
  attendreEtatActeur,
  attendreFinDuTour,
  attendreIa,
  attendreModeAffiche,
  attendreQue,
  avecTemoinP6,
  capturerConversation,
  enModeAvance,
  exiger,
  exigerAucuneViolationCsp,
  nonJoue,
  oc,
  ouvrirConversation,
  PHRASES,
  preparerPage,
  releve,
  resume,
  texteVisible,
} from "./it1-ui-commun.mjs";

const COMMANDE = "revue-croisee";
const DESCRIPTION = "Revue croisée des changements récents";

export async function run(ctx) {
  const page = await preparerPage(ctx);
  if (ctx.mode !== "faux") {
    nonJoue(ctx, "capture p2 (délégation d'un raccourci subtask)", "le faux fournisseur ne répond que du texte, il ne délègue pas");
    ctx.expectNoConsoleErrors();
    return;
  }
  let absente = null;
  await avecTemoinP6(ctx, async (temoin) => {
    await enModeAvance(ctx, async () => {
      await attendreModeAffiche(page, "avance");
      const ia = await attendreIa(ctx);
      const client = oc(ctx);
      const racine = await client.creerConversation("it1-ui-p2-raccourci");
      await ctx.faux.scripter(racine.id, {
        stepMs: 500,
        tools: [
          {
            tool: "task",
            input: { description: DESCRIPTION, prompt: "Relis changements.md et dis en 3 lignes ce qui pourrait casser.", subagent_type: "general", command: COMMANDE },
            child: { agent: "general", text: "Un changement risqué : le pool de connexions.", workMs: 8_000 },
          },
        ],
        followUp: { text: "Revue croisée faite." },
      });
      await ouvrirConversation(ctx, racine.id);
      const envoi = await client.envoyer(racine.id, `/${COMMANDE} incident du 13/09`, ia);
      exiger(envoi.code === 204, `envoi refusé (${envoi.code}) : ${resume(envoi.corps)}`);

      // 1. et 2. Lancée sans demande ; enregistrée comme lancée par le raccourci, sans confirmation.
      const enfant = await attendreQue(async () => ((await client.enfants(racine.id)) ?? [])[0] ?? false, { libelle: "sous-agent du raccourci lancé" });
      const delegationVue = await attendreQue(
        async () => (await activite(ctx, racine.id))?.delegations?.find((d) => d.childSessionId === enfant.id && d.state === "travaille") ?? false,
        { libelle: "délégation du raccourci enregistrée par le cockpit" },
      );
      exiger(delegationVue.source === "raccourci" && delegationVue.command === COMMANDE, `délégation enregistrée comme ${resume(delegationVue)}`);
      exiger(delegationVue.sansConfirmation === true && delegationVue.permissionId === null, `délégation du raccourci non marquée « sans confirmation » : ${resume(delegationVue)}`);

      // 3. La page la montre ; captures p2 pendant le travail délégué.
      await attendreEtatActeur(page, "general", "travaille");
      const ligne = await texteVisible(page, ".actor-list");
      exiger(ligne.includes(`raccourci /${COMMANDE}`), `« raccourci /${COMMANDE} » absent de « Qui travaille ? » : ${resume(ligne, 300)}`);
      await page.attendreQue(`window.__e2e.faisceaux.some((f) => f.cle.startsWith("f:consigne:${racine.id}:"))`, { libelle: "faisceau de consigne du raccourci dessiné" });
      await capturerConversation(ctx, "p2-lance-sans-confirmation");
      // 4. Phrase du tableau d'honnêteté (§6 l.1048), cherchée pendant le travail délégué, liste dépliée.
      const texte = await texteVisible(page, ".chat-center");
      if (!texte.toLowerCase().includes(PHRASES.sansConfirmation)) absente = texte;

      await attendreFinDuTour(client, racine.id, { delaiMs: 30_000 });
      const aucuneDemande = temoin.deOpencode("permission.asked").filter((e) => e.event.properties?.sessionID === racine.id || e.event.properties?.sessionID === enfant.id);
      exiger(aucuneDemande.length === 0, `demande d'autorisation posée pour le raccourci : ${resume(aucuneDemande.map((e) => e.event.properties?.permission))}`);
      const reponses = (await temoin.requetes()).filter((r) => /^\/permission\/[^/]+\/reply$/.test(r.pathname ?? ""));
      exiger(reponses.length === 0, `réponse(s) d'autorisation envoyée(s) : ${resume(reponses.map((r) => r.body?.reply))}`);
      releve(ctx, `p2 : délégation du raccourci /${COMMANDE} lancée sans demande, enregistrée « sans confirmation » (source ${delegationVue.source})`);
      await exigerAucuneViolationCsp(page);
    });
  });
  ctx.expectNoConsoleErrors();
  exiger(absente === null, `la page ne dit pas « ${PHRASES.sansConfirmation} » pour la délégation lancée par le raccourci /${COMMANDE} (§6 l.1048) ; texte visible : ${resume(absente, 500)}`);
}
