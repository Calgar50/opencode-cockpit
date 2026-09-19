// Scénario e2e de l'interface de l'itération 1 (L7b-2) : le sélecteur « Autonomie » au clavier seul.
//
// Spécification §4.13 et §5.5 (sélecteur accessible : bouton de menu APG, éléments `menuitemradio`, choix indisponibles atteignables
// avec leur raison, aucun raccourci global), §4.9 point 1 (« Plan d'abord (nouvelle conversation) » depuis une conversation
// existante), P7. Itération 1 (L6s) : « Demander à chaque fois » et « Plan d'abord » s'appliquent ; les choix automatiques restent
// désactivés avec leur raison jusqu'à L12a.
//
// Aucune souris dans ce scénario : seulement des touches envoyées au navigateur (Tab, flèches, Début, Fin, Entrée, Échap, une lettre).
// La conversation est préparée par l'API et ouverte par son adresse (un lien) ; les règles d'utilisation, si la fenêtre bloquante est
// ouverte, sont acceptées au clavier aussi (Espace sur la case, Tab, Entrée).
//
// Ce que le scénario établit (tous les modes du banc : le sélecteur n'appelle aucune IA) :
//   1. la tabulation atteint le bouton « Autonomie : Demander à chaque fois » de l'en-tête ;
//   2. Flèche bas ouvre le menu sur le premier choix, coché ; Flèche bas passe au choix suivant, désactivé avec sa raison ; Entrée
//      sur ce choix ne fait rien (menu ouvert, aucune requête) ; Fin et Début vont au dernier et au premier choix ; la lettre « p »
//      va à « Plan d'abord (nouvelle conversation) » ; Échap ferme le menu et rend le focus au bouton ;
//   3. au clavier, « Plan d'abord (nouvelle conversation) » + Entrée crée la conversation de plan (POST /api/plans) et l'ouvre : son
//      sélecteur affiche « Plan d'abord » ;
//   4. dans cette conversation, le focus est resté sur le bouton du sélecteur (jamais sur la page) ; Flèche haut ouvre le menu sur le
//      dernier choix ; Tab le ferme et la tabulation continue hors du menu ;
//   5. aucune violation de la CSP, console muette ; P6 et P4 tenus (témoin ouvert avant la création de la conversation, fermé après
//      celle de la conversation de plan).
import {
  attendre,
  avecTemoinP6,
  exiger,
  exigerAucuneViolationCsp,
  oc,
  ouvrirConversation,
  preparerPage,
  releve,
  resume,
} from "./it1-ui-commun.mjs";

const BOUTON = ".autonomy-selector-header .autonomy-button";
const TABULATIONS_MAX = 120;

export async function run(ctx) {
  const page = ctx.navigateur;
  await accepterReglesAuClavier(page);
  await preparerPage(ctx);
  await avecTemoinP6(ctx, async () => {
    const racine = await oc(ctx).creerConversation("it1-ui-selecteur-clavier");
    await ouvrirConversation(ctx, racine.id);
    await page.attendreQue(`document.querySelector(${JSON.stringify(BOUTON)})?.getAttribute("aria-label") === "Autonomie : Demander à chaque fois"`, {
      libelle: "sélecteur de l'en-tête sur « Demander à chaque fois »",
    });

    // 1. La tabulation atteint le bouton du sélecteur.
    const tabulations = await tabulerJusquAuBouton(page);
    exiger(await page.evaluer(`document.activeElement.getAttribute("aria-haspopup") === "menu"`), "le bouton du sélecteur n'annonce pas son menu.");

    // 2. Menu au clavier.
    await page.touche("ArrowDown");
    await attendreFocusMenu(page, { libelle: "Demander à chaque fois", coche: true, desactive: false, position: 1 });
    await page.touche("ArrowDown");
    const modifications = await attendreFocusMenu(page, { libelle: "Modifications automatiques", coche: false, desactive: true, position: 2 });
    exiger(modifications.raison !== "", "choix désactivé sans raison lue.");
    const avant = page.journalReseau().length;
    await page.touche("Enter");
    await attendre(400);
    exiger(await menuOuvert(page), "Entrée sur un choix désactivé a fermé le menu.");
    // Seules comptent les écritures du sélecteur (choix, plan) : la page peut résoudre l'IA de la saisie au même moment.
    const envoyees = page.journalReseau().slice(avant).filter((l) => /\/api\/(conversations\/[^/]+\/autonomie|plans)$/.test(new URL(l.url).pathname));
    exiger(envoyees.length === 0, `Entrée sur un choix désactivé a envoyé ${resume(envoyees.map((l) => `${l.methode} ${l.url}`))}`);
    await page.touche("End");
    await attendreFocusMenu(page, { libelle: "Autonome avec contrôle", coche: false, desactive: true, position: 4 });
    await page.touche("Home");
    await attendreFocusMenu(page, { libelle: "Demander à chaque fois", coche: true, desactive: false, position: 1 });
    await page.taper("p");
    await attendreFocusMenu(page, { libelle: "Plan d'abord (nouvelle conversation)", coche: false, desactive: false, position: 3 });
    await page.touche("Escape");
    await page.attendreQue(`!document.querySelector('[role="menu"]') && document.activeElement === document.querySelector(${JSON.stringify(BOUTON)})`, {
      libelle: "Échap : menu fermé, focus rendu au bouton",
    });

    // 3. « Plan d'abord (nouvelle conversation) » au clavier : la conversation de plan est créée et ouverte.
    await page.touche("ArrowDown");
    await attendreFocusMenu(page, { libelle: "Demander à chaque fois", coche: true, desactive: false, position: 1 });
    await page.taper("p");
    await attendreFocusMenu(page, { libelle: "Plan d'abord (nouvelle conversation)", coche: false, desactive: false, position: 3 });
    await page.touche("Enter");
    await page.attendreQue(`location.hash.startsWith("#/chat/") && location.hash !== ${JSON.stringify(`#/chat/${racine.id}`)}`, {
      delaiMs: 20_000,
      libelle: "conversation de plan ouverte",
    });
    const plan = await page.evaluer("decodeURIComponent(location.hash.slice('#/chat/'.length))");
    await page.attendreQue(`document.querySelector(${JSON.stringify(BOUTON)})?.getAttribute("aria-label") === "Autonomie : Plan d'abord"`, {
      libelle: "sélecteur de la conversation de plan sur « Plan d'abord »",
    });
    const choix = await ctx.api.get(`/api/conversations/${encodeURIComponent(plan)}/autonomie`);
    exiger(choix?.choix === "plan", `choix de la conversation de plan : ${resume(choix)}`);

    // 4. Dans la conversation de plan : focus resté sur le bouton (répétition générale de l'itération 1 : il tombait sur la page,
    // document.body) ; Flèche haut ouvre sur le dernier choix ; Tab ferme le menu et la tabulation continue hors de lui.
    await page.attendreQue(`document.activeElement === document.querySelector(${JSON.stringify(BOUTON)})`, {
      libelle: "focus gardé sur le bouton du sélecteur après l'ouverture de la conversation de plan",
    });
    await page.touche("ArrowUp");
    await attendreFocusMenu(page, { libelle: "Autonome avec contrôle", coche: false, desactive: true, position: 4 });
    await page.touche("Tab");
    await page.attendreQue(`!document.querySelector('[role="menu"]') && document.activeElement !== document.body && !document.activeElement.closest('.autonomy-selector-header')`, {
      libelle: "Tab : menu fermé, focus sur l'élément suivant de la page",
    });
    releve(
      ctx,
      `sélecteur atteint en ${tabulations} tabulation(s) ; menu parcouru, « Plan d'abord » choisi au clavier seul ; focus gardé ` +
        "sur le bouton après l'ouverture de la conversation de plan",
    );
  });

  await exigerAucuneViolationCsp(page);
  ctx.expectNoConsoleErrors();
}

/** Fenêtre des règles (première visite de la pile) : Espace sur la case (focalisée à l'ouverture), Tab, Entrée sur « Commencer ». */
async function accepterReglesAuClavier(page) {
  await page.attendreQue("document.querySelector('nav.rail')", { libelle: "barre de navigation du cockpit" });
  if (!(await page.evaluer("Boolean(document.querySelector('.rules-modal'))"))) return;
  await page.attendreQue("document.activeElement?.matches('.rules-modal input[type=checkbox]')", { libelle: "case des règles focalisée" });
  await page.taper(" ");
  await page.attendreQue("document.querySelector('.rules-modal input[type=checkbox]').checked", { libelle: "case des règles cochée à l'Espace" });
  await page.touche("Tab");
  await page.attendreQue("document.activeElement?.textContent.trim() === 'Commencer'", { libelle: "focus sur « Commencer »" });
  await page.touche("Enter");
  await page.attendreQue("!document.querySelector('.rules-modal')", { libelle: "fenêtre des règles fermée au clavier" });
}

/** Tabule depuis le focus courant jusqu'au bouton du sélecteur de l'en-tête ; rend le nombre de tabulations. */
async function tabulerJusquAuBouton(page) {
  for (let n = 1; n <= TABULATIONS_MAX; n++) {
    await page.touche("Tab");
    if (await page.evaluer(`document.activeElement === document.querySelector(${JSON.stringify(BOUTON)})`)) return n;
  }
  throw new Error(`bouton du sélecteur non atteint en ${TABULATIONS_MAX} tabulations (focus sur ${await page.focus()}).`);
}

async function menuOuvert(page) {
  return await page.evaluer(`Boolean(document.querySelector('[role="menu"]'))`);
}

/** Attend que le focus soit sur l'élément de menu attendu ; rend ce que lit un lecteur d'écran (nom, état, raison). */
async function attendreFocusMenu(page, attendu) {
  const lire = `(() => {
    const e = document.activeElement;
    if (!e || e.getAttribute("role") !== "menuitemradio") return null;
    const texte = (id) => (id ? id.split(" ").map((i) => document.getElementById(i)?.textContent ?? "").join(" ").trim() : "");
    return {
      libelle: texte(e.getAttribute("aria-labelledby")),
      coche: e.getAttribute("aria-checked") === "true",
      desactive: e.getAttribute("aria-disabled") === "true",
      position: Number(e.getAttribute("aria-posinset")),
      total: Number(e.getAttribute("aria-setsize")),
      raison: e.querySelector(".autonomy-item-reason")?.textContent.trim() ?? "",
    };
  })()`;
  let lu = null;
  const limite = Date.now() + 5_000;
  while (Date.now() < limite) {
    lu = await page.evaluer(lire);
    if (lu && lu.libelle === attendu.libelle) break;
    await attendre(100);
  }
  exiger(lu && lu.libelle === attendu.libelle, `focus du menu sur ${resume(lu)} au lieu de « ${attendu.libelle} ».`);
  exiger(lu.coche === attendu.coche && lu.desactive === attendu.desactive, `« ${attendu.libelle} » : coché ${lu.coche}, désactivé ${lu.desactive}.`);
  exiger(lu.position === attendu.position && lu.total === 4, `« ${attendu.libelle} » annoncé ${lu.position} sur ${lu.total}.`);
  return lu;
}
