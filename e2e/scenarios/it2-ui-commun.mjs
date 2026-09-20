// Scénarios e2e de l'INTERFACE de l'itération 2 (paquet L13) : outils communs, et le scénario qui vérifie leurs préalables.
//
// Le banc lance chaque fichier « .mjs » de e2e/scenarios comme un scénario : ce module en est donc un aussi. Il reprend les outils
// de page de L7b-2 (`it1-ui-commun.mjs` : préparation, captures, relevés de CSP) et ceux de l'autonomie de L13
// (`it2-api-commun.mjs` : atelier du workspace, activation, Journal, tours scriptés), sans les redéfinir.
//
// UNE SEULE TOLÉRANCE DE CONSOLE, et elle est dite. Quand vous choisissez « Modifications automatiques » ou « Autonome avec
// contrôle », l'interface envoie D'ABORD un PUT sans en-tête de confirmation : le serveur répond 428 `confirmation-requise`, et
// c'est seulement alors que la confirmation s'ouvre (§4.11 : le serveur est seul juge, jamais le navigateur). Le navigateur note
// toute réponse 4xx d'une requête de la page dans sa console : cette ligne-là est ATTENDUE, elle est la preuve que la porte du
// serveur a bien répondu. Elle est écartée par `CONSOLE_428`, bornée à la route d'autonomie et au code 428 ; aucune autre erreur
// n'est tolérée. Elle disparaîtra le jour où l'interface demandera la confirmation avant d'envoyer — ce que la spécification
// interdit, justement.
import {
  activerAutonome,
  activite,
  atelier,
  attendre,
  attendreDecisions,
  attendreFinDeDemande,
  attendreQue,
  avecTemoinP6,
  commande,
  decisionAttente,
  decisionAuto,
  derniereDemande,
  DOSSIER_ATELIER,
  DOSSIER_PIEGE,
  ecriture,
  envoyerEtJouer,
  exiger,
  exigerListe,
  exigerP6SurRequetes,
  iaDuBanc,
  lireAutonomie,
  nonJoue,
  oc,
  postExecutionDePlan,
  putAutonomie,
  releve,
  repereDesRequetes,
  resume,
} from "./it2-api-commun.mjs";
import { attendreTexte, boutonVisible, exigerAucuneViolationCsp, ouvrirConversation, preparerPage, texteVisible } from "./it1-ui-commun.mjs";

// Outils de page de L7b-2, repris tels quels.
export {
  attendreIa,
  attendreModeAffiche,
  attendreReseauCalme,
  attendreTexte,
  boutonVisible,
  capturerConversation,
  cliquerBouton,
  deplierQuiTravaille,
  exigerAucuneViolationCsp,
  exprBouton,
  instrumenter,
  LARGE,
  ouvrirConversation,
  preparerPage,
  releves,
  texteVisible,
} from "./it1-ui-commun.mjs";

// Outils d'autonomie de L13, repris tels quels.
export {
  activerAutonome,
  activite,
  atelier,
  attendre,
  attendreDecisions,
  attendreDemandes,
  attendreFinDeDemande,
  attendreFinDuTour,
  attendreQue,
  auRepos,
  avecTemoinP6,
  choixFermes,
  commande,
  decisionAttente,
  decisionAuto,
  derniereDemande,
  DOSSIER_ATELIER,
  DOSSIER_PIEGE,
  ecriture,
  envoyerEtJouer,
  exiger,
  exigerListe,
  exigerP6SurRequetes,
  iaDuBanc,
  lireAutonomie,
  nonJoue,
  oc,
  partiesOutil,
  postExecutionDePlan,
  putAutonomie,
  releve,
  repereDesRequetes,
  resume,
} from "./it2-api-commun.mjs";

/**
 * Seule entrée de console tolérée par les scénarios it2-ui-* : le 428 `confirmation-requise` de la route d'autonomie, que
 * l'interface provoque exprès (voir l'en-tête). Les deux motifs valent l'un sur l'adresse, l'autre sur le texte.
 */
export const CONSOLE_428 = [/\/api\/conversations\/[^/]+\/autonomie/, /\b428\b/];

/** Libellés exacts du sélecteur et de la confirmation (§4.13) : c'est la spécification qu'on vérifie, pas ce que le code déclare. */
export const LIBELLES = {
  demander: "Demander à chaque fois",
  modifications: "Modifications automatiques",
  planNouvelle: "Plan d'abord (nouvelle conversation)",
  autonome: "Autonome avec contrôle",
  titreConfirmation: "Laisser l'IA travailler seule dans cette conversation ?",
  lancer: "Lancer en autonome",
  annuler: "Annuler",
  arreter: "Arrêter",
  journal: "Journal",
  voirModifications: "Voir les modifications de cette demande",
};

/** Bouton du sélecteur d'autonomie répété dans l'en-tête du chat (§4.13). */
export const BOUTON_SELECTEUR = ".autonomy-selector-header .autonomy-button";

/** Attend que le sélecteur de l'en-tête annonce le choix `libelle` (aria-label « Autonomie : … »). */
export async function attendreChoixAffiche(page, libelle, delaiMs = 15_000) {
  await page.attendreQue(`document.querySelector(${JSON.stringify(BOUTON_SELECTEUR)})?.getAttribute("aria-label") === ${JSON.stringify(`Autonomie : ${libelle}`)}`, {
    delaiMs,
    libelle: `sélecteur sur « ${libelle} »`,
  });
}

/** Bandeau d'autonomie de la conversation (§4.12), lu tel que la page le rend. */
export async function bandeau(page) {
  return await page.evaluer(`(() => {
    const el = document.querySelector(".autonomy-banner");
    if (!el) return null;
    const bouton = (texte) => [...el.querySelectorAll("button")].some((b) => b.textContent.replace(/\\s+/g, " ").trim() === texte && b.getClientRects().length > 0);
    return {
      terminee: el.dataset.terminee ?? null,
      resume: (el.querySelector(".autonomy-banner-resume")?.innerText ?? "").replace(/\\s+/g, " ").trim(),
      fin: (el.querySelector(".autonomy-banner-fin")?.textContent ?? "").trim(),
      arreter: bouton(${JSON.stringify(LIBELLES.arreter)}),
      journal: bouton(${JSON.stringify(LIBELLES.journal)}),
      modifications: bouton(${JSON.stringify(LIBELLES.voirModifications)}),
    };
  })()`);
}

/** Attend que le bandeau d'autonomie satisfasse `test` (fonction évaluée dans le banc, pas dans la page) ; rend-le. */
export async function attendreBandeau(page, test, { delaiMs = 30_000, libelle = "bandeau d'autonomie" } = {}) {
  return await attendreQue(
    async () => {
      const vu = await bandeau(page);
      return vu !== null && test(vu) ? vu : false;
    },
    { delaiMs, libelle },
  );
}

/** Lignes du Journal du contrôle telles que le Déroulé les rend (tableau, §4.12). */
export async function lignesDuJournal(page) {
  return await page.evaluer(`(() => {
    const table = document.querySelector(".deroule-journal .journal-table");
    if (!table) return null;
    return [...table.querySelectorAll("tbody tr")].map((tr) => ({
      qui: (tr.querySelector(".journal-qui")?.textContent ?? "").replace(/\\s+/g, " ").trim(),
      action: (tr.querySelector(".journal-action")?.textContent ?? "").trim(),
      decision: (tr.querySelector(".journal-decision")?.textContent ?? "").replace(/\\s+/g, " ").trim(),
      raison: (tr.querySelector(".journal-raison")?.textContent ?? "").replace(/\\s+/g, " ").trim(),
    }));
  })()`);
}

// --- Scénario : préalables des scénarios it2-ui ------------------------------------------------------------------------------------

export async function run(ctx) {
  atelier(ctx);
  // P6 : ce scénario n'agit pas sur opencode (il ouvre une page et lit) ; le journal des requêtes du faux suffit.
  const depuis = await repereDesRequetes(ctx);
  const page = await preparerPage(ctx);
  const bootstrap = await ctx.api.get("/api/bootstrap");
  exiger(bootstrap?.autonomy?.activationOuverte === true, "porte I1 fermée : les scénarios it2-ui-* sont en attente de la bascule.");
  exiger(bootstrap?.settings?.ui?.mode === "simple", `mode ${resume(bootstrap?.settings?.ui?.mode)} au lieu de « simple ».`);

  // Une conversation de l'atelier, ouverte dans la page : le sélecteur s'y annonce sur « Demander à chaque fois ».
  const racine = await oc(ctx, DOSSIER_ATELIER).creerConversation("it2-ui-commun");
  await ouvrirConversation(ctx, racine.id);
  await attendreChoixAffiche(page, LIBELLES.demander);

  // Aucun bandeau d'autonomie tant qu'aucune demande autonome ne court (§5.4, états vides).
  exiger((await bandeau(page)) === null, "bandeau d'autonomie affiché sans demande autonome.");
  exiger(!(await boutonVisible(page, LIBELLES.voirModifications)), "[Voir les modifications de cette demande] visible hors d'une fin de demande.");
  exiger((await texteVisible(page, ".chat-header")).length > 0, "en-tête de la conversation vide.");
  await attendreTexte(page, LIBELLES.demander, { selecteur: ".chat-header" });

  await exigerP6SurRequetes(ctx, depuis);
  await exigerAucuneViolationCsp(page);
  ctx.expectNoConsoleErrors();
}
