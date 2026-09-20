// Scénario e2e de l'interface de l'itération 2 (paquet L13) : les quatre choix ET la confirmation, au CLAVIER SEUL.
//
// Spécification §4.13 (sélecteur APG, confirmation d'« Autonome avec contrôle » et ses cinq lignes, plafonds modifiables,
// [Lancer en autonome] [Annuler]), §4.11 (la confirmation est exigée par le SERVEUR : 428 `confirmation-requise`), §5.5 (clavier,
// focus visible, aucun raccourci global) ; plan d'exécution, fiche L13.
//
// Aucune souris : seulement des touches envoyées au navigateur (Tab, flèches, Fin, Entrée, Échap). Là où le scénario de
// l'itération 1 s'arrêtait au bord (il évitait exprès d'ouvrir la confirmation), celui-ci la traverse.
//
// Ce que le scénario établit :
//   1. les quatre choix sont atteints au clavier, annoncés 1 à 4, l'un coché, aucun désactivé dans une conversation ordinaire ;
//   2. Entrée sur « Autonome avec contrôle » n'applique RIEN tout seul : l'interface envoie un PUT sans en-tête, le serveur
//      répond 428, et c'est le 428 qui ouvre la confirmation (la page ne décide pas à la place du serveur) ;
//   3. la confirmation porte les cinq lignes du §4.13, le dossier de la conversation, les plafonds modifiables, et ses deux
//      boutons ; le focus y entre tout seul, et Échap la ferme sans rien appliquer ;
//   4. rouverte, elle se valide au clavier : Tab jusqu'à [Lancer en autonome], Entrée, et le choix de la conversation devient
//      « Autonome avec contrôle » côté SERVEUR (GET …/autonomie), pas seulement à l'écran ;
//   5. aucune violation de la CSP ; la seule entrée de console tolérée est le 428 attendu (CONSOLE_428).
import {
  atelier,
  attendre,
  attendreChoixAffiche,
  BOUTON_SELECTEUR,
  CONSOLE_428,
  DOSSIER_ATELIER,
  exiger,
  exigerAucuneViolationCsp,
  exigerP6SurRequetes,
  LIBELLES,
  lireAutonomie,
  oc,
  ouvrirConversation,
  preparerPage,
  releve,
  repereDesRequetes,
  resume,
} from "./it2-ui-commun.mjs";

const TABULATIONS_MAX = 120;

export async function run(ctx) {
  atelier(ctx);
  // P6 : le scénario ne fait que du clavier sur le sélecteur ; le journal des requêtes du faux le couvre d'un bout à l'autre.
  const depuis = await repereDesRequetes(ctx);
  const page = await preparerPage(ctx);
  const racine = await oc(ctx, DOSSIER_ATELIER).creerConversation("it2-ui-selecteur-clavier");
  await ouvrirConversation(ctx, racine.id);
  await attendreChoixAffiche(page, LIBELLES.demander);

  // 1. Les quatre choix au clavier.
  const tabulations = await tabulerJusquAuBouton(page);
  await page.touche("ArrowDown");
  await attendreFocusMenu(page, { libelle: LIBELLES.demander, coche: true, desactive: false, position: 1 });
  await page.touche("ArrowDown");
  await attendreFocusMenu(page, { libelle: LIBELLES.modifications, coche: false, desactive: false, position: 2 });
  await page.touche("ArrowDown");
  await attendreFocusMenu(page, { libelle: LIBELLES.planNouvelle, coche: false, desactive: false, position: 3 });
  await page.touche("End");
  await attendreFocusMenu(page, { libelle: LIBELLES.autonome, coche: false, desactive: false, position: 4 });

  // 2. Entrée : le PUT part sans en-tête, le serveur répond 428, la confirmation s'ouvre.
  await page.touche("Enter");
  await page.attendreQue(`document.querySelector('[role="dialog"]')`, { libelle: "confirmation d'« Autonome avec contrôle » ouverte" });
  const refus = page
    .journalReseau()
    .filter((l) => l.url && /\/api\/conversations\/[^/]+\/autonomie$/.test(new URL(l.url).pathname) && l.methode === "PUT");
  exiger(refus.some((l) => l.code === 428), `aucun 428 « confirmation-requise » avant la confirmation : ${resume(refus.map((l) => `${l.methode} ${l.code}`))}`);
  exiger((await lireAutonomie(ctx, racine.id))?.choix === "demander", "le choix a changé avant la confirmation.");

  // 3. Les cinq lignes du §4.13, le dossier, les plafonds, les deux boutons ; le focus est entré dans la fenêtre.
  const fenetre = await lireConfirmation(page);
  exiger(fenetre.titre === LIBELLES.titreConfirmation, `titre de la confirmation : « ${resume(fenetre.titre)} ».`);
  exiger(fenetre.lignes.length === 5, `${fenetre.lignes.length} ligne(s) dans la confirmation au lieu de cinq : ${resume(fenetre.lignes)}`);
  const texte = fenetre.lignes.join(" ");
  for (const attendu of [
    "Sans vous demander :",
    DOSSIER_ATELIER,
    "Toujours avec votre accord :",
    "Jamais : ce que l'assistant refuse.",
    "Arrêt automatique à",
    "Certaines actions d'opencode ne passent par aucune demande",
  ]) {
    exiger(texte.includes(attendu), `la confirmation ne dit pas « ${attendu} » : ${resume(texte, 700)}`);
  }
  exiger(fenetre.plafonds >= 5, `${fenetre.plafonds} plafond(s) modifiable(s) dans la confirmation (six attendus au plus).`);
  exiger(fenetre.boutons.includes(LIBELLES.lancer) && fenetre.boutons.includes(LIBELLES.annuler), `boutons : ${resume(fenetre.boutons)}`);
  exiger(fenetre.focusDansLaFenetre === true, `le focus n'est pas entré dans la confirmation (${resume(fenetre.focus)}).`);

  // Échap : rien n'est appliqué, rien n'est envoyé.
  const avant = page.journalReseau().length;
  await page.touche("Escape");
  await page.attendreQue(`!document.querySelector('[role="dialog"]')`, { libelle: "confirmation fermée par Échap" });
  await attendre(400);
  const envoyees = page
    .journalReseau()
    .slice(avant)
    .filter((l) => l.url && /\/api\/conversations\/[^/]+\/autonomie$/.test(new URL(l.url).pathname) && l.methode === "PUT");
  exiger(envoyees.length === 0, `Échap a envoyé ${resume(envoyees.map((l) => `${l.methode} ${l.code}`))}`);
  exiger((await lireAutonomie(ctx, racine.id))?.choix === "demander", "Échap a quand même appliqué le choix.");

  // 4. Rouverte au clavier, validée au clavier.
  await page.attendreQue(`document.activeElement === document.querySelector(${JSON.stringify(BOUTON_SELECTEUR)})`, {
    libelle: "focus rendu au bouton du sélecteur après Échap",
  });
  await page.touche("ArrowUp");
  await attendreFocusMenu(page, { libelle: LIBELLES.autonome, coche: false, desactive: false, position: 4 });
  await page.touche("Enter");
  await page.attendreQue(`document.querySelector('[role="dialog"]')`, { libelle: "confirmation rouverte" });
  const tabsConfirmation = await tabulerJusquAuBoutonTexte(page, LIBELLES.lancer);
  await page.touche("Enter");
  await page.attendreQue(`!document.querySelector('[role="dialog"]')`, { delaiMs: 20_000, libelle: "confirmation fermée après [Lancer en autonome]" });
  await attendreChoixAffiche(page, LIBELLES.autonome);
  const vue = await lireAutonomie(ctx, racine.id);
  exiger(vue?.choix === "autonome", `le serveur garde le choix « ${resume(vue?.choix)} » après la confirmation.`);
  exiger(vue?.depuis !== null, "le choix est appliqué sans date.");

  // Resserrer est immédiat : Flèche haut… Début, Entrée sur « Demander à chaque fois », sans aucune confirmation.
  await page.attendreQue(`document.activeElement === document.querySelector(${JSON.stringify(BOUTON_SELECTEUR)})`, {
    libelle: "focus rendu au bouton du sélecteur après la confirmation",
  });
  await page.touche("ArrowDown");
  await page.touche("Home");
  await attendreFocusMenu(page, { libelle: LIBELLES.demander, coche: false, desactive: false, position: 1 });
  await page.touche("Enter");
  await attendreChoixAffiche(page, LIBELLES.demander);
  exiger(!(await page.evaluer(`Boolean(document.querySelector('[role="dialog"]'))`)), "resserrer a demandé une confirmation.");
  exiger((await lireAutonomie(ctx, racine.id))?.choix === "demander", "le resserrement n'a pas été appliqué.");

  await exigerP6SurRequetes(ctx, depuis);
  await exigerAucuneViolationCsp(page);
  ctx.expectNoConsoleErrors(CONSOLE_428);
  releve(
    ctx,
    `sélecteur atteint en ${tabulations} tabulation(s) ; quatre choix parcourus, confirmation ouverte par le 428 du serveur, ` +
      `fermée par Échap sans effet, puis validée au clavier en ${tabsConfirmation} tabulation(s) ; resserrement immédiat`,
  );
}

/** Tabule depuis le focus courant jusqu'au bouton du sélecteur de l'en-tête ; rend le nombre de tabulations. */
async function tabulerJusquAuBouton(page) {
  for (let n = 1; n <= TABULATIONS_MAX; n++) {
    await page.touche("Tab");
    if (await page.evaluer(`document.activeElement === document.querySelector(${JSON.stringify(BOUTON_SELECTEUR)})`)) return n;
  }
  throw new Error(`bouton du sélecteur non atteint en ${TABULATIONS_MAX} tabulations (focus sur ${await page.focus()}).`);
}

/** Tabule dans la fenêtre ouverte jusqu'au bouton dont le texte vaut `texte` ; rend le nombre de tabulations. */
async function tabulerJusquAuBoutonTexte(page, texte) {
  const cible = `(() => { const e = document.activeElement; return e?.tagName === "BUTTON" && e.textContent.replace(/\\s+/g, " ").trim() === ${JSON.stringify(texte)}; })()`;
  if (await page.evaluer(cible)) return 0;
  for (let n = 1; n <= 30; n++) {
    await page.touche("Tab");
    if (await page.evaluer(cible)) return n;
  }
  throw new Error(`bouton « ${texte} » non atteint au clavier dans la confirmation (focus sur ${await page.focus()}).`);
}

/** Ce que la confirmation montre : titre, lignes, nombre de plafonds modifiables, boutons, et où est le focus. */
async function lireConfirmation(page) {
  return await page.evaluer(`(() => {
    const dlg = document.querySelector('[role="dialog"]');
    if (!dlg) return null;
    const actif = document.activeElement;
    return {
      titre: (dlg.querySelector(".modal-header h2")?.textContent ?? "").trim(),
      lignes: [...dlg.querySelectorAll(".autonomy-confirm-line")].map((li) => li.textContent.replace(/\\s+/g, " ").trim()),
      plafonds: dlg.querySelectorAll(".autonomy-confirm-cap input").length,
      boutons: [...dlg.querySelectorAll(".modal-footer button")].map((b) => b.textContent.replace(/\\s+/g, " ").trim()),
      focus: actif ? actif.tagName.toLowerCase() + ":" + (actif.getAttribute("aria-label") || actif.textContent || "").trim().slice(0, 40) : "",
      focusDansLaFenetre: Boolean(actif && dlg.contains(actif)),
    };
  })()`);
}

/** Attend que le focus soit sur l'élément de menu attendu ; rend ce que lit un lecteur d'écran (nom, état, position). */
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
