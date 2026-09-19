// Scénario e2e de l'interface de l'itération 1 (L7b-2) : « délégation visible en Avancé, faisceau rose puis bleu dans l'ordre des
// faits », captures 1440, 1024 et 400 dans les deux thèmes, zéro erreur de console.
//
// Spécification §7.3 L7 (« délégation visible ; bande néon en direct sur une délégation réelle du faux opencode »), §5.7.1 (grammaire :
// consigne en trait plein à chevrons, rose ; résultat en pointillé à losanges, bleu ; préparation en pointillé rose), §5.7.4 (la bande
// suit les faits, au plus 4 rendus par seconde), §3.14 (carte détaillée d'une délégation en mode Avancé), décision n° 4 (en Simple
// la délégation est refusée d'office : le scénario passe en Avancé).
//
// Ce que le scénario établit (« --faux ») :
//   1. l'IA délègue à general ; comme opencode 1.18.30 réel, la demande d'autorisation suit la partie task de quelques
//      millisecondes (clôture de l'itération 1 : avec le pas du tour de 1,5 s, la bande avait le temps de dessiner la préparation
//      AVANT la demande, et le scénario passait même quand la carte se repliait à chaque demande, rg-reel-7 en échec sur opencode
//      réel). La page montre la demande avec sa carte « Détails de la délégation » ; « Qui travaille ? » affiche general « en attente
//      de votre accord ». Sans aucun clic, pendant la demande (§5.1, §5.7.1, §5.7.3) : la carte des agents reste dépliée (défaut du
//      mode Avancé) et montre, dans la fenêtre, l'attente de votre accord (hexagone hachuré, cadenas, ambre) et la préparation
//      (pointillé rose fixe, sans animation en boucle) ; « Qui travaille ? » reste déplié, une ligne par acteur ;
//   2. « Autoriser une fois » est cliqué dans la carte ; general « travaille », la bande dessine la consigne (rose), « Arrêter » est
//      visible ; captures pendant le travail délégué ;
//   3. general rend son résultat : la bande dessine le résultat (bleu) pendant que la conversation reprend (capture à 1440), la
//      délégation est « terminé » ;
//   4. l'ordre d'apparition des faisceaux dans la page est celui des faits enregistrés par le cockpit (préparation, consigne,
//      résultat), le rose strictement avant le bleu ;
//   5. chaque changement de la carte passe par une transition WAAPI d'environ 900 ms sur transform et opacity, jouée une fois ;
//      aucune violation de la CSP, console muette, P6 et P4 tenus.
// En « --reel-hors-ligne », le faux fournisseur ne délègue pas : le scénario le dit et ne joue rien.
import path from "node:path";
import {
  apparition,
  attendre,
  attendreDemandes,
  attendreEtatActeur,
  attendreFinDuTour,
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
  estBleu,
  estRose,
  exiger,
  exigerAucuneViolationCsp,
  exigerListe,
  exigerSignesDeLaDemande,
  faisceauxDesFaits,
  faits,
  nonJoue,
  oc,
  ouvrirConversation,
  PHRASES,
  preparerPage,
  releve,
  releves,
  resume,
  signesPendantLaDemande,
  texteVisible,
} from "./it1-ui-commun.mjs";

const DESCRIPTION = "Relire les changements récents";
/** Travail de l'enfant : assez long pour les six captures pendant la consigne, et pour séparer nettement le rose du bleu. */
const TRAVAIL_MS = 9_000;
/**
 * Pas du tour de la conversation : le faux enchaîne ses groupes d'événements en 1 ms par défaut, alors qu'une vraie IA met des
 * secondes à reprendre après un résultat. Le faisceau de résultat reste ouvert jusqu'à la fin de la réponse qui a délégué
 * (neon-scene.ts, #endWork) : sans ce pas, résultat et fin de réponse arrivent dans le même lot de faits et le bleu n'est jamais
 * dessiné (essai du 19/09 : c'est ce que montre la page, et c'est juste).
 */
const PAS_MS = 1_500;
/**
 * Demande d'autorisation posée quelques millisecondes après la partie `task`, comme opencode 1.18.30 réel (rg-reel-7 ; option
 * askAfterMs du faux) : le pas du tour ne s'applique plus entre la partie et la demande.
 */
const DEMANDE_APRES_MS = 5;

export async function run(ctx) {
  const page = await preparerPage(ctx);
  if (ctx.mode !== "faux") {
    nonJoue(ctx, "délégation visible et faisceaux", "le faux fournisseur ne répond que du texte, il ne délègue pas");
    ctx.expectNoConsoleErrors();
    return;
  }
  await avecTemoinP6(ctx, async () => {
    await enModeAvance(ctx, async () => {
      await attendreModeAffiche(page, "avance");
      const ia = await attendreIa(ctx);
      const client = oc(ctx);
      const racine = await client.creerConversation("it1-ui-delegation");
      await ctx.faux.scripter(racine.id, {
        stepMs: PAS_MS,
        tools: [{ ...delegation(DESCRIPTION, "general", { text: "Deux changements relevés.", workMs: TRAVAIL_MS }), askAfterMs: DEMANDE_APRES_MS }],
        followUp: { text: "Synthèse : deux changements à surveiller." },
      });
      await ouvrirConversation(ctx, racine.id);
      const envoi = await client.envoyer(racine.id, "Fais relire les changements récents par un autre assistant.", ia);
      exiger(envoi.code === 204, `envoi refusé (${envoi.code}) : ${resume(envoi.corps)}`);

      // 1. Délégation visible en Avancé : demande d'autorisation et sa carte détaillée, « en attente de votre accord ».
      const [demande] = await attendreDemandes(client, demandeDeDelegation(racine.id, DESCRIPTION), { libelle: "délégation en attente" });
      await page.attendreQue("document.querySelector('.interactions .delegation-details dl')", { libelle: "carte « Détails de la délégation »" });
      const carte = await texteVisible(page, ".interactions .interaction");
      for (const attendu of ["L'assistant demande l'autorisation de déléguer le travail à un autre assistant", DESCRIPTION, "Détails de la délégation", "Assistant demandé", "general", "Droits comparés"]) {
        exiger(carte.includes(attendu), `carte de la demande sans « ${attendu} » : ${resume(carte, 400)}`);
      }
      await attendreEtatActeur(page, "general", "en attente de votre accord");
      await page.attendreQue(`window.__e2e.faisceaux.some((f) => f.cle.startsWith("f:preparation:${racine.id}:"))`, { libelle: "faisceau de préparation dessiné" });
      // Sans aucun clic, une fois les transitions finies (≈ 900 ms) : ce que la page montre pendant la demande.
      await attendre(1_000);
      const signes = await signesPendantLaDemande(page, racine.id);
      releve(ctx, `pendant la demande, sans clic, 1440 : ${JSON.stringify(signes)}`);
      exigerSignesDeLaDemande(signes, "pendant la demande, 1440");

      // 2. « Autoriser une fois » dans la carte : l'enfant travaille, la consigne est dessinée, « Arrêter » est visible.
      await cliquerBouton(page, PHRASES.autoriser, { portee: ".interactions" });
      const enfant = await attendreQue(
        async () => {
          const [premier] = (await client.enfants(racine.id)) ?? [];
          return premier ?? false;
        },
        { libelle: "enfant lancé après « Autoriser une fois »" },
      );
      await attendreEtatActeur(page, "general", "travaille");
      await page.attendreQue(`window.__e2e.faisceaux.some((f) => f.cle.startsWith("f:consigne:${racine.id}:"))`, { libelle: "faisceau de consigne dessiné" });
      exiger(await boutonVisible(page, PHRASES.arreter, ".composer"), "« Arrêter » absent pendant le travail délégué.");
      exiger(!(await boutonVisible(page, PHRASES.envoyer, ".composer")), "« Envoyer » affiché pendant le travail délégué.");
      await capturerConversation(ctx, "delegation-en-cours");
      exiger(
        (await client.enfants(racine.id))?.length === 1 && (await client.etats())?.[enfant.id]?.type === "busy",
        "le travail délégué s'est terminé pendant les captures : allonger TRAVAIL_MS.",
      );

      // 3. Résultat rendu : faisceau de résultat pendant que la conversation reprend, délégation terminée, fin de la réponse.
      await page.attendreQue(`window.__e2e.faisceaux.some((f) => f.cle.startsWith("f:resultat:${enfant.id}:"))`, {
        delaiMs: TRAVAIL_MS + 15_000,
        libelle: "faisceau de résultat dessiné",
      });
      // Une capture à 1440 pendant que le bleu est dessiné (il ne l'est que le temps de la reprise de la conversation), une fois sa
      // transition d'apparition finie (≈ 900 ms, partie de l'opacité 0).
      await attendre(1_000);
      await page.capture(path.join(ctx.dossierCaptures, `${ctx.nom.replace(/\.mjs$/, "")}-resultat-bleu-1440.png`));
      await attendreEtatActeur(page, "general", "terminé");
      await attendreFinDuTour(client, racine.id, { delaiMs: 20_000 });

      // 4. Ordre des faisceaux = ordre des faits ; rose (préparation, consigne) puis bleu (résultat).
      const callId = demande.tool?.callID;
      exiger(typeof callId === "string", `demande de délégation sans appel d'outil : ${resume(demande)}`);
      const attendus = faisceauxDesFaits(await faits(ctx, racine.id)).filter((f) => f.id.endsWith(`:${callId}`));
      const genres = attendus.map((f) => f.genre);
      exigerListe(genres, ["preparation", "consigne", "resultat"], "faisceaux qu'ouvrent les faits de la délégation");
      const vus = await releves(page);
      const suite = attendus.map((f) => ({ ...f, vu: apparition(vus, f.id) }));
      for (const f of suite) {
        exiger(f.vu !== null, `faisceau ${f.id} jamais dessiné (vus : ${resume(vus.faisceaux.map((x) => x.cle))}).`);
        const couleur = f.genre === "resultat" ? estBleu(f.vu.couleur) : estRose(f.vu.couleur);
        exiger(couleur, `faisceau ${f.genre} de couleur ${f.vu.couleur} au lieu du ${f.genre === "resultat" ? "bleu" : "rose"}.`);
      }
      for (let i = 1; i < suite.length; i++) {
        exiger(suite[i - 1].vu.t <= suite[i].vu.t, `faisceau ${suite[i].genre} dessiné avant ${suite[i - 1].genre}, contre l'ordre des faits.`);
      }
      const [, consigne, resultat] = suite;
      exiger(consigne.vu.t < resultat.vu.t, "le bleu (résultat) n'est pas dessiné après le rose (consigne).");
      releve(
        ctx,
        `faisceaux dans l'ordre des faits : préparation ${consigne.vu.t - suite[0].vu.t > 0 ? "puis" : "et"} consigne (rose ${suite[1].vu.couleur}), ` +
          `résultat (bleu ${resultat.vu.couleur}) ${Math.round(resultat.vu.t - consigne.vu.t)} ms après la consigne`,
      );

      // 5. Transitions WAAPI : une par changement, environ 900 ms, transform et opacity, jamais en boucle.
      exiger(vus.animations.length > 0, "aucune transition WAAPI relevée sur la carte.");
      const hors = vus.animations.filter((a) => a.duree < 800 || a.duree > 1_000 || a.iterations !== 1 || a.proprietes.some((p) => p !== "transform" && p !== "opacity"));
      exiger(hors.length === 0, `transition(s) hors de la règle (≈ 900 ms, une fois, transform et opacity) : ${resume(hors)}`);
      const resultatAnime = vus.animations.some((a) => a.cle === `f:resultat:${enfant.id}:${callId}`);
      exiger(resultatAnime, `le faisceau de résultat est apparu sans transition (animations : ${resume(vus.animations.map((a) => a.cle))}).`);
      releve(ctx, `${vus.animations.length} transition(s) WAAPI sur la carte, toutes de ${[...new Set(vus.animations.map((a) => a.duree))].join(", ")} ms`);
      await exigerAucuneViolationCsp(page);
    });
  });
  ctx.expectNoConsoleErrors();
}
