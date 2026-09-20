// Scénario e2e de l'interface de l'itération 2 (paquet L13) : l'onglet fermé pendant une demande autonome.
// Les décisions automatiques continuent, et l'attente est retrouvée à la réouverture (décision n° 11).
//
// Spécification §4.11 (« Onglet fermé : le travail continue dans les plafonds »), §4.3 étape 8 (à la reconnexion, relecture de
// `GET /permission` pour l'arbre), §4.12 (bandeau et Journal relus), §4.13 (carte d'attente) ; plan d'exécution, fiche L13.
//
// Comment l'onglet est « fermé » : la page est quittée pour `about:blank`. Le cockpit n'a plus aucune page ouverte — son flux
// d'événements est coupé côté navigateur, exactement comme si l'utilisateur avait fermé l'onglet. Le banc garde le même onglet du
// navigateur (il n'en ouvre qu'un par scénario) ; c'est le DOCUMENT du cockpit qui disparaît, avec son flux, ses relevés et son
// état. La réouverture recharge la page à neuf.
//
// Ce que le scénario établit :
//   1. une demande autonome est en cours, page ouverte, bandeau affiché ;
//   2. la page est quittée AVANT que les décisions ne tombent (les appels d'outil du faux sont retardés) ;
//   3. pendant que la page est fermée, l'autonomie décide quand même : la décision automatique est prise, horodatée entre la
//      fermeture et la réouverture, et la réponse « once » est bien partie vers opencode ;
//   4. à la réouverture, la conversation retrouve son bandeau (compteurs à jour) et l'attente restée en suspens est là, avec sa
//      carte « En attente de votre accord » ;
//   5. aucune violation de la CSP ; les seules entrées de console tolérées sont celles de la navigation interrompue.
import {
  activerAutonome,
  atelier,
  attendre,
  attendreBandeau,
  attendreDecisions,
  attendreIa,
  attendreQue,
  bandeau,
  decisionAttente,
  decisionAuto,
  DOSSIER_ATELIER,
  ecriture,
  envoyerEtJouer,
  exiger,
  exigerAucuneViolationCsp,
  exigerP6SurRequetes,
  nonJoue,
  oc,
  ouvrirConversation,
  preparerPage,
  releve,
  repereDesRequetes,
  resume,
} from "./it2-ui-commun.mjs";

/**
 * Entrées de console tolérées ici, et seulement ici : quitter une page coupe ses requêtes en cours (le flux d'événements
 * `/api/events`, une lecture d'activité), et le navigateur note l'abandon. Ce n'est pas une erreur du cockpit, c'est la
 * navigation elle-même. Les motifs sont bornés à l'abandon et au flux ; aucune autre erreur n'est tolérée.
 */
const CONSOLE_NAVIGATION = [/net::ERR_ABORTED/, /\/api\/events/];

/** Retard des appels d'outil du faux : le temps de quitter la page avant que les décisions ne tombent. */
const RETARD_MS = 8_000;

const FICHIER_AUTO = "hors-onglet.md";
const FICHIER_PROTEGE = ".vscode/settings.json";

export async function run(ctx) {
  atelier(ctx);
  const page = await preparerPage(ctx);
  if (ctx.mode !== "faux") {
    nonJoue(ctx, "onglet fermé pendant une demande autonome", "le retard des appels d'outil ne se script pas hors du faux opencode");
    return;
  }
  const client = oc(ctx, DOSSIER_ATELIER);
  const ia = await attendreIa(ctx);
  // P6 sans flux ouvert, et c'est voulu : la démonstration de ce scénario est qu'AUCUN flux du cockpit n'est ouvert pendant que
  // l'autonomie décide. Le témoin `avecTemoinP6` en tiendrait un et ruinerait la démonstration ; le journal des requêtes du faux
  // établit les mêmes interdits (PATCH /global/config, les deux libérations) et la même règle P4.
  const depuis = await repereDesRequetes(ctx);

  // 1. Demande autonome en cours, page ouverte.
  const racine = await client.creerConversation("it2-ui-onglet-ferme");
  await activerAutonome(ctx, racine.id);
  await ouvrirConversation(ctx, racine.id);

  await envoyerEtJouer(
    ctx,
    client,
    racine.id,
    {
      tools: [
        { ...ecriture(DOSSIER_ATELIER, FICHIER_AUTO, "# Hors onglet\n"), askAfterMs: RETARD_MS },
        { ...ecriture(DOSSIER_ATELIER, FICHIER_PROTEGE, "{}\n"), askAfterMs: RETARD_MS },
      ],
      cost: 0.003,
      stepMs: 1,
    },
    { ia },
  );
  await attendreBandeau(page, (b) => b.terminee === "non", { libelle: "bandeau d'autonomie affiché avant la fermeture" });

  // 2. L'onglet est fermé : la page du cockpit disparaît, son flux avec elle.
  const ferme = Date.now();
  await page.aller("about:blank");
  await page.attendreQue("!document.querySelector('nav.rail')", { libelle: "page du cockpit quittée" });

  // 3. Pendant ce temps, l'autonomie décide : les décisions tombent sans aucune page ouverte.
  const [auto] = await attendreDecisions(ctx, racine.id, decisionAuto("A-edit"), { delaiMs: 45_000, libelle: "modification automatique, page fermée" });
  const [attente] = await attendreDecisions(ctx, racine.id, decisionAttente("E2"), { delaiMs: 45_000, libelle: "attente sur le fichier protégé, page fermée" });
  exiger(auto.relais === "ok", `la réponse « once » n'est pas partie pendant que la page était fermée (${resume(auto.relais)}).`);
  const rouvert = Date.now();
  exiger(
    auto.decidedAt >= ferme && auto.decidedAt <= rouvert,
    `la décision automatique n'a pas été prise pendant que la page était fermée (${auto.decidedAt}, fenêtre ${ferme}–${rouvert}).`,
  );
  exiger(attente.relais === null, `une réponse a été relayée pour le fichier protégé (${resume(attente.relais)}).`);

  // 4. Réouverture : la conversation retrouve son bandeau et son attente.
  await page.aller(`${ctx.url}/`);
  await preparerPage(ctx);
  await ouvrirConversation(ctx, racine.id);
  const retrouve = await attendreBandeau(page, (b) => b.terminee === "non" && /1 automatique/.test(b.resume) && /1 en attente/.test(b.resume), {
    libelle: "bandeau retrouvé à la réouverture",
  });
  exiger(retrouve.arreter && retrouve.journal, `bandeau retrouvé sans ses boutons : ${resume(retrouve)}`);
  await page.attendreQue(
    `[...document.querySelectorAll("button")].some((b) => b.textContent.replace(/\\s+/g, " ").trim() === "Autoriser une fois" && b.getClientRects().length > 0)`,
    { delaiMs: 20_000, libelle: "carte de l'attente retrouvée (« Autoriser une fois »)" },
  );
  const carte = await page.evaluer(`(document.body.innerText ?? "").replace(/\\s+/g, " ")`);
  exiger(carte.includes("En attente de votre accord"), "la carte d'attente ne dit pas « En attente de votre accord ».");

  // La pile revient au repos pour les scénarios suivants.
  const enAttente = (await client.demandes()) ?? [];
  for (const demande of enAttente.filter((d) => d.sessionID === racine.id)) await client.repondre(demande.id, "reject");
  await attendreQue(async () => ((await client.demandes()) ?? []).length === 0, { libelle: "plus aucune demande d'autorisation en attente" });
  await attendre(200);

  exiger((await bandeau(page)) !== null, "le bandeau a disparu après le refus.");
  await exigerP6SurRequetes(ctx, depuis);
  await exigerAucuneViolationCsp(page);
  ctx.expectNoConsoleErrors(CONSOLE_NAVIGATION);
  releve(
    ctx,
    `onglet fermé ${Math.round((rouvert - ferme) / 100) / 10} s : décision automatique prise sans page ouverte (« once » relayé), ` +
      "attente retrouvée à la réouverture avec le bandeau et sa carte",
  );
}
