// Scénario e2e de l'interface de l'itération 1 (L7b-2) : « Arrêter » visible pendant un travail délégué, et qui l'arrête.
//
// Spécification §3.12 (« Arrêter » arrête la conversation et tout son travail délégué ; le bouton reste visible tant que l'arbre
// travaille, stopVisible), §6 l.1047 (« aucune session occupée » après l'arrêt), §5.7.1 (faisceau figé par un arrêt : gris, forme
// gardée, carré d'arrêt), §2.3 (état « arrêté »). L'arrêt lui-même est éprouvé par l'API dans it1-api-arret (L7b-1) ; ici, c'est
// l'interface : le bouton, le clic, ce que la page montre ensuite.
//
// Ce que le scénario établit (« --faux », mode Avancé : en Simple la délégation est refusée d'office, décision n° 4) :
//   1. une délégation accordée par « Autoriser une fois » travaille (60 s) : « Arrêter » est visible dans la saisie, « Envoyer » ne
//      l'est pas ; capture ;
//   2. clic sur « Arrêter » : conversation.arretee {cause: vous}, plus aucune session de l'arbre occupée, l'enfant interrompu ;
//   3. la page le montre : general « arrêté », marque « Arrêté » sur la carte, faisceau de la consigne figé en gris, « Arrêter »
//      disparu et « Envoyer » revenu ;
//   4. aucune violation de la CSP, console muette, P6 et P4 tenus.
// En « --reel-hors-ligne », aucun travail délégué n'est possible (le faux fournisseur ne délègue pas) : rien n'est joué.
import {
  apparition,
  attendreDemandes,
  attendreEtatActeur,
  attendreIa,
  attendreModeAffiche,
  attendreQue,
  avecTemoinP6,
  boutonVisible,
  capturerConversation,
  cliquerBouton,
  delegation,
  demandeDeDelegation,
  enModeAvance,
  estGris,
  estRose,
  exiger,
  exigerAucuneViolationCsp,
  nonJoue,
  oc,
  occupees,
  ouvrirConversation,
  PHRASES,
  preparerPage,
  releve,
  releves,
  resume,
} from "./it1-ui-commun.mjs";

const DESCRIPTION = "Analyser les journaux de la nuit";

export async function run(ctx) {
  const page = await preparerPage(ctx);
  if (ctx.mode !== "faux") {
    nonJoue(ctx, "« Arrêter » pendant un travail délégué", "le faux fournisseur ne répond que du texte, il ne délègue pas");
    ctx.expectNoConsoleErrors();
    return;
  }
  await avecTemoinP6(ctx, async (temoin) => {
    await enModeAvance(ctx, async () => {
      await attendreModeAffiche(page, "avance");
      const ia = await attendreIa(ctx);
      const client = oc(ctx);
      const racine = await client.creerConversation("it1-ui-arreter");
      await ctx.faux.scripter(racine.id, { tools: [delegation(DESCRIPTION, "general", { workMs: 60_000 })], followUp: { text: "Analyse faite." } });
      await ouvrirConversation(ctx, racine.id);
      const envoi = await client.envoyer(racine.id, "Fais analyser les journaux de la nuit.", ia);
      exiger(envoi.code === 204, `envoi refusé (${envoi.code}) : ${resume(envoi.corps)}`);

      // 1. Le travail délégué commence : « Arrêter » visible, « Envoyer » absent.
      const [demande] = await attendreDemandes(client, demandeDeDelegation(racine.id, DESCRIPTION), { libelle: "délégation en attente" });
      await cliquerBouton(page, PHRASES.autoriser, { portee: ".interactions" });
      const enfant = await attendreQue(
        async () => {
          const [premier] = (await client.enfants(racine.id)) ?? [];
          return premier && (await occupees(client, [racine.id, premier.id])).length === 2 ? premier : false;
        },
        { libelle: "racine et enfant occupés" },
      );
      await attendreEtatActeur(page, "general", "travaille");
      await page.attendreQue(`window.__e2e.faisceaux.some((f) => f.cle.startsWith("f:consigne:${racine.id}:"))`, { libelle: "faisceau de consigne dessiné" });
      exiger(await boutonVisible(page, PHRASES.arreter, ".composer"), "« Arrêter » absent de la saisie pendant le travail délégué.");
      exiger(!(await boutonVisible(page, PHRASES.envoyer, ".composer")), "« Envoyer » affiché pendant le travail délégué.");
      await capturerConversation(ctx, "arreter-pendant-le-travail-delegue");

      // 2. Clic sur « Arrêter » : l'arbre entier s'arrête.
      await cliquerBouton(page, PHRASES.arreter, { portee: ".composer" });
      const arretee = await temoin.attendreCockpit("conversation.arretee", (d) => d?.rootId === racine.id);
      exiger(arretee.data.cause === "vous", `cause de l'arrêt « ${arretee.data.cause} » au lieu de « vous ».`);
      exiger((arretee.data.unconfirmed ?? []).length === 0, `arrêt non confirmé pour ${resume(arretee.data.unconfirmed)}.`);
      const encore = await occupees(client, [racine.id, enfant.id]);
      exiger(encore.length === 0, `session(s) encore occupée(s) après « Arrêter » : ${encore.join(", ")}`);
      const interrompues = new Set(
        temoin
          .deOpencode("session.error")
          .filter((e) => e.event.properties?.error?.name === "MessageAbortedError")
          .map((e) => e.event.properties.sessionID),
      );
      exiger(interrompues.has(racine.id) && interrompues.has(enfant.id), `arrêt non relayé pour ${resume([racine.id, enfant.id].filter((s) => !interrompues.has(s)))}.`);

      // 3. La page le montre : état « arrêté », marque d'arrêt, consigne figée en gris, « Envoyer » revenu.
      await attendreEtatActeur(page, "general", "arrêté");
      await page.attendreQue(exprBoutonsSaisie(PHRASES.envoyer, PHRASES.arreter), { libelle: "« Envoyer » revenu, « Arrêter » disparu" });
      await page.attendreQue("document.querySelector('.neon-map .neon-arret')", { libelle: "marque « Arrêté » sur la carte" });
      const callId = demande.tool?.callID;
      const idConsigne = `consigne:${racine.id}:${callId}`;
      await page.attendreQue(`window.__e2e.faisceaux.some((f) => f.cle === ${JSON.stringify(`f:${idConsigne}`)} && f.classes.includes("is-fige"))`, {
        libelle: "faisceau de consigne figé par l'arrêt",
      });
      const vus = await releves(page);
      const vif = apparition(vus, idConsigne);
      const fige = vus.faisceaux.find((f) => f.cle === `f:${idConsigne}` && f.classes.includes("is-fige"));
      exiger(vif && estRose(vif.couleur), `consigne vivante de couleur ${vif?.couleur} au lieu du rose.`);
      exiger(fige && estGris(fige.couleur), `consigne figée de couleur ${fige?.couleur} au lieu du gris.`);
      releve(ctx, `« Arrêter » visible pendant le travail délégué ; après le clic : racine et enfant interrompus, aucune session occupée, consigne ${vif.couleur} → ${fige.couleur}`);
      await exigerAucuneViolationCsp(page);
    });
  });
  ctx.expectNoConsoleErrors();
}

/** Expression : dans la saisie, un bouton `present` visible et aucun bouton `absent` visible. */
function exprBoutonsSaisie(present, absent) {
  return `(() => {
    const boutons = [...(document.querySelector(".composer")?.querySelectorAll("button") ?? [])].filter((b) => b.getClientRects().length > 0);
    const textes = boutons.map((b) => b.textContent.replace(/\\s+/g, " ").trim());
    return textes.includes(${JSON.stringify(present)}) && !textes.includes(${JSON.stringify(absent)});
  })()`;
}
