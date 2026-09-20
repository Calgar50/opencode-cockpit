// Scénario e2e de l'itération 5 (paquet L50a) : la chronologie d'une conversation (spécification §2.1 l.63,
// §5.1 l.883-884, §5.5 l.920, §5.6 ; plan d'exécution it5 D-5-09, fiche L47b).
//
// La chronologie est un RÉGLAGE DU MODE AVANCÉ : le mot « jeton » est interdit en mode Simple (§2.3), donc la bascule
// « Déroulé | Chronologie » n'y est pas rendue du tout. Ce scénario l'établit en « --faux » :
//   1. en Avancé : la bascule est là, la chronologie montre une ligne par intervenant, la colonne des jetons, les
//      repères d'outil, et le curseur « maintenant » PENDANT le travail ;
//   2. à 400 px, la figure disparaît et le tableau reste seul (§5.6) ;
//   3. en Simple : aucune bascule, aucune chronologie, et le mot « jeton » n'apparaît nulle part dans le panneau.
// Console muette et aucune violation de la CSP.
import { suiviDeLargeur } from "../lib/a11y.mjs";
import {
  attendre,
  attendreFinDuTour,
  attendreIa,
  attendreModeAffiche,
  attendreQue,
  cliquerBouton,
  enModeAvance,
  exiger,
  exigerAucuneViolationCsp,
  LARGE,
  nonJoue,
  oc,
  occupees,
  ouvrirConversation,
  preparerPage,
  releve,
  resume,
  texteVisible,
} from "./it1-ui-commun.mjs";

/** Textes attendus (construction-texts.ts, section `avance`), écrits en clair. */
const PHRASES = {
  deroule: "Déroulé",
  titre: "Chronologie",
  phrase: "Le déroulé détaillé : chaque appel d'IA, ses outils, ses jetons et son coût.",
  jetons: "Jetons (entrée / sortie / cache)",
  maintenant: "maintenant",
};

/** Taille étroite du §5.6 : la figure disparaît, le tableau reste. */
const ETROIT = { largeur: 400, hauteur: 860 };

const FICHIER = "notes-de-nuit.txt";
const DEMANDE = "Relis les journaux de la nuit et resume.";

/**
 * Tour scripté : trois lectures de fichier, assez espacées pour que le travail dure pendant les relevés (le curseur
 * « maintenant » n'existe que tant qu'une ligne n'est pas close), puis une réponse avec ses jetons.
 */
const TOUR = {
  stepMs: 1_500,
  tools: [
    { tool: "read", input: { filePath: FICHIER }, output: "contenu lu" },
    { tool: "grep", input: { pattern: "erreur" }, output: "3 lignes" },
    { tool: "read", input: { filePath: FICHIER }, output: "contenu relu" },
  ],
  followUp: { text: "Trois erreurs, toutes a 3 h 02.", cost: 0.004, tokens: { input: 1200, output: 180, cache: { read: 120, write: 0 } } },
  cost: 0.002,
  tokens: { input: 800, output: 60, cache: { read: 0, write: 0 } },
};

/** Ouvre le panneau « Contexte » s'il est fermé (il se ferme de lui-même sous 1280 px). */
async function ouvrirLeContexte(page) {
  const ouvert = "document.querySelector('.chat')?.classList.contains('aside-open') === true";
  if (await page.evaluer(ouvert)) return;
  await page.evaluer(`document.querySelector('.chat-header button[aria-label="Afficher le contexte"]')?.click()`);
  await page.attendreQue(ouvert, { libelle: "panneau « Contexte » ouvert" });
}

/**
 * Ouvre la vue Chronologie : le panneau d'abord (il se ferme sous 1280 px), puis la bascule. Le Déroulé est démonté
 * quand le panneau se ferme, et sa vue revient alors à « Déroulé » : après chaque changement de taille, on la rouvre.
 */
async function ouvrirLaChronologie(page) {
  await ouvrirLeContexte(page);
  if (await page.evaluer("Boolean(document.querySelector('.chronologie'))")) return;
  await cliquerBouton(page, PHRASES.titre, { portee: ".chrono-bascule" });
  await page.attendreQue("document.querySelector('.chronologie')", { libelle: "vue Chronologie" });
}

/** Ce que la chronologie montre : lignes, appels, repères, colonne des jetons, figure visible, curseur. */
async function releveChronologie(page) {
  return await page.evaluer(`(() => {
    const vue = document.querySelector(".chronologie");
    if (!vue) return null;
    const figure = vue.querySelector(".chrono-figure");
    const entetes = [...vue.querySelectorAll("th")].map((e) => e.textContent.replace(/\\s+/g, " ").trim());
    const jetons = [...vue.querySelectorAll("tbody td")].map((e) => e.textContent.trim()).filter((t) => /\\d/.test(t));
    return {
      lignes: vue.querySelectorAll(".chrono-rows .chrono-row").length,
      rangees: vue.querySelectorAll("tbody tr").length,
      reperes: vue.querySelectorAll(".chrono-tick").length,
      entetes,
      chiffres: jetons.length,
      figureVisible: figure ? getComputedStyle(figure).display !== "none" : false,
      curseur: vue.querySelector(".chrono-now") !== null,
      tableau: vue.querySelector("table") !== null,
    };
  })()`);
}

export async function run(ctx) {
  const page = await preparerPage(ctx);
  const apresLaTaille = suiviDeLargeur(LARGE.largeur);
  if (ctx.mode !== "faux") {
    nonJoue(ctx, "chronologie", "les tours scriptés (outils, jetons) n'existent qu'en « --faux »");
    ctx.expectNoConsoleErrors();
    return;
  }
  const ia = await attendreIa(ctx);
  const client = oc(ctx);
  const racine = await client.creerConversation("c5a-chronologie");
  await ctx.faux.scripter(racine.id, TOUR);

  await enModeAvance(ctx, async () => {
    await attendreModeAffiche(page, "avance");
    await ouvrirConversation(ctx, racine.id);
    await ouvrirLeContexte(page);
    await page.attendreQue("document.querySelector('.chrono-bascule')", { libelle: "bascule « Déroulé | Chronologie »" });
    const bascule = await page.evaluer(`(() => {
      const groupe = document.querySelector(".chrono-bascule");
      return {
        role: groupe.getAttribute("role"),
        nom: groupe.getAttribute("aria-label"),
        boutons: [...groupe.querySelectorAll("button")].map((b) => ({ texte: b.textContent.trim(), coche: b.getAttribute("aria-checked"), tab: b.tabIndex })),
      };
    })()`);
    releve(ctx, `bascule : ${JSON.stringify(bascule)}`);
    exiger(bascule.role === "radiogroup", `bascule de rôle « ${bascule.role} » (radiogroup attendu, APG).`);
    exiger(bascule.boutons.length === 2 && bascule.boutons[0].texte === PHRASES.deroule && bascule.boutons[1].texte === PHRASES.titre, `boutons : ${resume(bascule.boutons)}`);
    exiger(bascule.boutons.filter((b) => b.tab === 0).length === 1, "la bascule doit n'avoir qu'un seul bouton dans l'ordre de tabulation (roving tabindex).");

    // Le travail commence, puis la chronologie est ouverte PENDANT : le curseur « maintenant » doit y être.
    const envoi = await client.envoyer(racine.id, DEMANDE, ia);
    exiger(envoi.code === 204, `envoi refusé (${envoi.code}) : ${resume(envoi.corps)}`);
    await cliquerBouton(page, PHRASES.titre, { portee: ".chrono-bascule" });
    await page.attendreQue("document.querySelector('.chronologie')", { libelle: "vue Chronologie" });
    const pendant = await attendreQue(
      async () => {
        const vu = await releveChronologie(page);
        return vu?.curseur ? vu : false;
      },
      { delaiMs: 20_000, pasMs: 300, libelle: "curseur « maintenant » pendant le travail" },
    );
    releve(ctx, `chronologie pendant le travail : ${JSON.stringify(pendant)}`);
    exiger((await occupees(client, [racine.id])).length === 1, "le tour s'est terminé avant le relevé du curseur.");
    const motCurseur = await texteVisible(page, ".chrono-now");
    exiger(motCurseur.includes(PHRASES.maintenant), `curseur sans son mot : « ${motCurseur} ».`);

    // Le tour fini : lignes, jetons et repères.
    await attendreFinDuTour(client, racine.id);
    const apres = await attendreQue(
      async () => {
        const vu = await releveChronologie(page);
        return vu && vu.lignes >= 1 && vu.reperes >= 1 && vu.chiffres >= 1 ? vu : false;
      },
      { delaiMs: 30_000, pasMs: 500, libelle: "lignes, repères et jetons de la chronologie" },
    );
    releve(ctx, `chronologie après le tour : ${JSON.stringify(apres)}`);
    exiger(apres.entetes.includes(PHRASES.jetons), `colonne des jetons absente : ${resume(apres.entetes)}`);
    const note = await texteVisible(page, ".chronologie");
    exiger(note.includes(PHRASES.phrase), `phrase de la chronologie absente : ${resume(note, 200)}`);

    // §5.6 : à 400 px, la figure disparaît et le tableau reste seul.
    await page.taille(ETROIT);
    await apresLaTaille(page, ETROIT.largeur);
    await ouvrirLaChronologie(page);
    await attendre(400);
    const etroit = await releveChronologie(page);
    releve(ctx, `chronologie à 400 px : ${JSON.stringify(etroit)}`);
    exiger(etroit !== null, "chronologie absente à 400 px.");
    exiger(etroit.figureVisible === false, "la figure de la chronologie est encore dessinée à 400 px (§5.6).");
    exiger(etroit.tableau === true && etroit.rangees >= 1, "le tableau de la chronologie ne reste pas seul à 400 px.");
    await page.taille(LARGE);
    await apresLaTaille(page, LARGE.largeur);
    await ouvrirLeContexte(page);
    // Les six captures ordinaires du banc (1440, 1024 et 400, dans les deux thèmes) : la vue est rouverte à chaque
    // taille, le panneau se fermant de lui-même sous 1280 px — attendue avant de rouvrir, sans quoi l'image montrerait
    // un panneau qui se referme.
    const captures = await ctx.screenshot("chronologie", {
      avant: async ({ taille }) => {
        await apresLaTaille(page, taille.largeur);
        await ouvrirLaChronologie(page);
      },
    });
    releve(ctx, `captures de la chronologie : ${captures.length}`);
    exiger(captures.length === 6, `${captures.length} capture(s) de la chronologie au lieu de 6.`);
    // `captureSuite` retire l'émulation de taille : la grande fenêtre est rétablie pour la suite (mode Simple).
    await page.taille(LARGE);
    await apresLaTaille(page, LARGE.largeur);
  });

  // Mode Simple : aucune bascule, aucune chronologie, et le mot « jeton » nulle part dans le panneau.
  await attendreModeAffiche(page, "simple");
  await ouvrirConversation(ctx, racine.id);
  await ouvrirLeContexte(page);
  await page.attendreQue("document.querySelector('.chat-aside .deroule-rows, .chat-aside .deroule-figure, .chat-aside table')", {
    libelle: "Déroulé rendu en mode Simple",
  });
  const simple = await page.evaluer(`(() => {
    const aside = document.querySelector(".chat-aside");
    return {
      bascule: aside.querySelector(".chrono-bascule") !== null,
      chronologie: aside.querySelector(".chronologie") !== null,
      jeton: /jeton/i.test(aside.innerText),
    };
  })()`);
  releve(ctx, `panneau en mode Simple : ${JSON.stringify(simple)}`);
  exiger(!simple.bascule, "la bascule « Chronologie » est offerte en mode Simple.");
  exiger(!simple.chronologie, "la chronologie est rendue en mode Simple.");
  exiger(!simple.jeton, "le mot « jeton » apparaît en mode Simple (§2.3).");

  await exigerAucuneViolationCsp(page);
  ctx.expectNoConsoleErrors();
}
