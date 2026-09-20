// Scénario e2e de l'interface de l'itération 2 (paquet L13) : un plan exécuté en autonome.
// 428 → confirmation → nouvelle conversation, brouillon prérempli, rien d'envoyé.
//
// Spécification §4.9 (points 4 et 5 : carte à quatre boutons après chaque réponse ; l'exécution crée une racine CONVERSATION avec
// le choix demandé, confirmation si Autonome, et un composeur prérempli « Exécute le plan suivant. » + dernier texte du plan, que
// l'utilisateur relit et envoie), §4.11 (la confirmation est exigée par le serveur : 428 `confirmation-requise`), §4.13 ; plan
// d'exécution, fiche L13 et risque « Plan d'abord en modifications ou autonome ».
//
// Ce que le scénario établit :
//   1. une conversation de plan qui a répondu montre la carte à quatre boutons ;
//   2. [Exécuter en autonome avec contrôle] n'exécute rien tout seul : le serveur répond 428, et c'est lui qui ouvre la
//      confirmation ; tant qu'elle n'est pas validée, AUCUNE conversation d'exécution n'est créée ;
//   3. validée, elle crée la nouvelle conversation, l'ouvre, et y pose le brouillon « Exécute le plan suivant. » suivi du dernier
//      texte du plan — sans rien envoyer à opencode (aucun appel facturé n'est parti pour cette conversation) ;
//   4. la nouvelle conversation est bien en « Autonome avec contrôle » côté serveur, et la conversation de plan garde son choix
//      « Plan d'abord » (elle ne peut rien modifier, même plus tard).
import {
  atelier,
  attendre,
  attendreChoixAffiche,
  attendreFinDuTour,
  attendreIa,
  attendreQue,
  avecTemoinP6,
  cliquerBouton,
  CONSOLE_428,
  DOSSIER_ATELIER,
  exiger,
  exigerAucuneViolationCsp,
  LIBELLES,
  lireAutonomie,
  nonJoue,
  oc,
  ouvrirConversation,
  preparerPage,
  releve,
  resume,
} from "./it2-ui-commun.mjs";

/** Libellés exacts de la carte de plan (§4.9 point 4, plan-texts.ts). */
const CARTE = {
  autonome: "Exécuter en autonome avec contrôle",
  demander: "Exécuter en demandant à chaque fois",
  modifications: "Exécuter avec modifications automatiques",
  continuer: "Continuer à planifier",
};

/** Début exact du brouillon d'exécution (§4.9 point 5, plan-texts.ts). */
const BROUILLON = "Exécute le plan suivant.";

/** Texte du plan joué par le faux : on le retrouve dans le brouillon. */
const TEXTE_DU_PLAN = "Étape 1 : relire les notes de l'atelier. Étape 2 : écrire le bilan.";

const COMPOSEUR = 'textarea[aria-label="Message"]';

export async function run(ctx) {
  atelier(ctx);
  const page = await preparerPage(ctx);
  if (ctx.mode !== "faux") {
    nonJoue(ctx, "plan exécuté en autonome", "le texte du plan ne se script pas hors du faux opencode");
    return;
  }
  // P6 sur tout le scénario : il agit (création de conversations, envoi vers le plan), donc le témoin complet.
  await avecTemoinP6(ctx, () => scenario(ctx, page));
}

async function scenario(ctx, page) {
  const client = oc(ctx, DOSSIER_ATELIER);
  const ia = await attendreIa(ctx);

  // 1. Une conversation de plan qui a répondu.
  const plan = await ctx.api.post("/api/plans", { directory: DOSSIER_ATELIER });
  exiger(typeof plan?.rootId === "string", `POST /api/plans : ${resume(plan)}`);
  await ctx.faux.scripter(plan.rootId, { text: TEXTE_DU_PLAN, cost: 0.002 });
  const envoi = await client.envoyer(plan.rootId, "Propose un plan.", ia);
  exiger(envoi.code === 204, `envoi vers la conversation de plan : code ${envoi.code} (${resume(envoi.corps)}).`);
  await attendreFinDuTour(client, plan.rootId);

  await ouvrirConversation(ctx, plan.rootId);
  await page.attendreQue("document.querySelector('.plan-card .plan-card-actions button')", { delaiMs: 20_000, libelle: "carte de plan affichée" });
  const boutons = await page.evaluer(
    `[...document.querySelectorAll('.plan-card .plan-card-actions button')].map((b) => b.textContent.replace(/\\s+/g, " ").trim())`,
  );
  for (const attendu of Object.values(CARTE)) exiger(boutons.includes(attendu), `carte de plan sans « ${attendu} » : ${resume(boutons)}`);

  // 2. Le bouton part sans confirmation : 428, et rien n'est créé tant que la confirmation n'est pas validée.
  const creationsAvant = await compterCreations(ctx);
  await cliquerBouton(page, CARTE.autonome, { portee: ".plan-card" });
  await page.attendreQue(`document.querySelector('[role="dialog"]')`, { delaiMs: 20_000, libelle: "confirmation de l'exécution en autonome" });
  const refus = page.journalReseau().filter((l) => l.url && /\/api\/plans\/[^/]+\/execution$/.test(new URL(l.url).pathname));
  exiger(refus.some((l) => l.code === 428), `aucun 428 avant la confirmation : ${resume(refus.map((l) => `${l.methode} ${l.code}`))}`);
  const titre = await page.evaluer(`(document.querySelector('[role="dialog"] .modal-header h2')?.textContent ?? "").trim()`);
  exiger(titre === LIBELLES.titreConfirmation, `titre de la confirmation : « ${resume(titre)} ».`);
  exiger((await compterCreations(ctx)) === creationsAvant, "une conversation d'exécution a été créée avant la confirmation.");

  // 3. Validée : nouvelle conversation ouverte, brouillon prérempli, rien d'envoyé.
  await cliquerBouton(page, LIBELLES.lancer, { portee: '[role="dialog"]' });
  await page.attendreQue(`location.hash.startsWith("#/chat/") && location.hash !== ${JSON.stringify(`#/chat/${plan.rootId}`)}`, {
    delaiMs: 20_000,
    libelle: "conversation d'exécution ouverte",
  });
  const execution = await page.evaluer("decodeURIComponent(location.hash.slice('#/chat/'.length))");
  const brouillon = await attendreQue(
    async () => {
      const valeur = await page.evaluer(`document.querySelector(${JSON.stringify(COMPOSEUR)})?.value ?? ""`);
      return valeur.includes(BROUILLON) ? valeur : false;
    },
    { libelle: "brouillon d'exécution dans le composeur" },
  );
  exiger(brouillon.startsWith(BROUILLON), `brouillon : « ${resume(brouillon, 200)} » ne commence pas par la première ligne du §4.9.`);
  exiger(brouillon.includes(TEXTE_DU_PLAN), `brouillon sans le dernier texte du plan : « ${resume(brouillon, 300)} ».`);

  // Rien n'est parti : aucun envoi vers la conversation d'exécution (le §4.9 dit « l'utilisateur relit et envoie »).
  await attendre(500);
  const envois = (await ctx.opencodeRequests()).filter(
    (r) => String(r.method).toUpperCase() === "POST" && r.pathname === `/session/${execution}/prompt_async`,
  );
  exiger(envois.length === 0, `${envois.length} envoi(s) partis sans vous pour la conversation d'exécution.`);

  // 4. Les deux choix, côté serveur.
  await attendreChoixAffiche(page, LIBELLES.autonome);
  const vueExecution = await lireAutonomie(ctx, execution);
  exiger(vueExecution?.choix === "autonome", `conversation d'exécution en « ${resume(vueExecution?.choix)} ».`);
  exiger(vueExecution?.planSourceId === plan.rootId || vueExecution?.executionDePlanId === plan.rootId, `le lien avec le plan n'est pas gardé : ${resume(vueExecution)}`);
  const vuePlan = await lireAutonomie(ctx, plan.rootId);
  exiger(vuePlan?.choix === "plan", `la conversation de plan est passée en « ${resume(vuePlan?.choix)} ».`);

  await exigerAucuneViolationCsp(page);
  ctx.expectNoConsoleErrors(CONSOLE_428);
  releve(ctx, `plan exécuté en autonome : 428, confirmation, conversation ${execution.slice(0, 8)}… ouverte avec son brouillon, rien d'envoyé`);
}

/** Nombre de créations de conversation reçues par opencode (pour voir si une exécution a été créée trop tôt). */
async function compterCreations(ctx) {
  return (await ctx.opencodeRequests()).filter((r) => String(r.method).toUpperCase() === "POST" && r.pathname === "/session").length;
}
