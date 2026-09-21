// Scénario e2e de l'itération 5 (paquet L50a) : le banc de captures d'accessibilité des vues de la construction
// (spécification §5.5, §5.6, §7.11 n° 4 ; conception C §17.3 n° 8, §17.4 ; plan d'exécution it5 §2.8).
//
// Six vues neuves sont capturées dans les TROIS modes (normal, contraste forcé, niveaux de gris avec mouvement réduit),
// dans les deux thèmes et aux trois tailles — 18 fichiers par vue : la bibliothèque des méthodes, l'écran « Consignes et
// fiches » de l'assistant de création, le popover de la puce « + Méthode », la bulle d'un message qui portait une
// méthode, la chronologie et les Coûts par équipe vides.
// Trois vérifications accompagnent les captures :
//   - en MOUVEMENT RÉDUIT, la transition de la carte de la bande néon ne joue plus, et le relevé est DISCRIMINANT : la même
//     action (un second tour envoyé pendant que la carte est affichée) anime la carte en mode normal et ne l'anime plus en
//     mouvement réduit, relevé sans délai ; puis plus rien ne tourne au repos (`document.getAnimations()`). Personne ne doit
//     subir un mouvement qu'il a désactivé ;
//   - en CONTRASTE FORCÉ, le focus reste VISIBLE : c'est le seul repère de la personne qui navigue au clavier ;
//   - la vue Chronologie est RELEVÉE juste avant chacune de ses 18 captures. Sans ce relevé, le banc ne compterait que les
//     FICHIERS écrits : 18 images d'une conversation sans panneau tiendraient le point « captures présentes » en nombre, pas
//     en contenu, et la relecture humaine du §7.11 n° 4 porterait sur de mauvaises images. Le panneau « Contexte » se ferme
//     de lui-même sous 1280 px, après que `taille(...)` a rendu la main : l'attente qui absorbe cette course est posée dans
//     `captureAccessibilite` (`e2e/lib/a11y.mjs`), avec le motif de `c5a-chronologie.mjs`.
//
// L'émulation demande la prise CDP, que le contexte d'un scénario ne porte pas (`ctx.navigateur` est l'ONGLET) : ce
// scénario ouvre donc son propre navigateur, avec le MÊME épinglage et la même isolation (`e2e/lib/a11y.mjs`), plutôt
// que de faire écrire `e2e/lib/cdp.mjs` par la construction (§2.8).
import path from "node:path";
import {
  animationsActives,
  captureAccessibilite,
  DUREE_PERCEPTIBLE_MS,
  emuler,
  focusVisible,
  mediasDeLaPage,
  MODES_A11Y,
  ouvrirNavigateurEpingle,
} from "../lib/a11y.mjs";
import {
  attendre,
  attendreFinDuTour,
  attendreIa,
  attendreModeAffiche,
  attendreQue,
  enModeAvance,
  exiger,
  LARGE,
  nonJoue,
  oc,
  preparerPage,
  releve,
  releves,
  resume,
} from "./it1-ui-commun.mjs";

/** Assistant du scénario : il donne l'écran « Consignes et fiches » de l'assistant de création, déjà rempli. */
const ASSISTANT = { name: "c5a-a11y-redacteur", title: "Rédacteur des captures (c5a)" };

/** Méthode du catalogue livré, écrite en clair : c'est elle que la bulle du message replie. */
const METHODE = { id: "certitude", titre: "Certitude et À VÉRIFIER" };

/**
 * Message envoyé avec son bloc de méthode, tel que la puce l'ajoute (D-5-08) : la bulle montre le texte SANS le bloc et
 * replie le bloc dessous. Il est envoyé par l'API pour préparer la vue, la puce elle-même étant vérifiée par
 * `c5a-methodes.mjs`.
 */
const DEMANDE = "Explique la bascule de nuit a quelqu'un qui prend l'astreinte demain.";
const BLOC = [
  "",
  "",
  `<!-- cockpit:methode-message ${METHODE.id} v1 -->`,
  `## Méthode demandée : ${METHODE.titre}`,
  "Classe chaque affirmation qui compte : Vérifié, avec la source lue ; Déduit ; ou À VÉRIFIER, avec la façon de le vérifier.",
  "<!-- /cockpit:methode-message -->",
].join("\n");

/** Réponse du faux, avec ses jetons : la chronologie a ainsi des lignes à montrer. */
const REPONSE = {
  text: "### Méthode : Certitude et À VÉRIFIER\n\nVérifié : la bascule est lancée a 2 h 30.\nÀ VÉRIFIER : le contact d'astreinte.",
  cost: 0.003,
  tokens: { input: 1400, output: 210, cache: { read: 0, write: 0 } },
};

/** Textes attendus des vues capturées, écrits en clair. */
const PHRASES = {
  consignes: "Consignes et fiches",
  coutsVides: "Aucune équipe lancée ce mois-ci.",
  chronologie: "Chronologie",
};

/** Brouillon complet d'assistant (PUT /api/assistants/:nom). */
function brouillon() {
  return {
    title: ASSISTANT.title,
    description: "Explique une procedure d'exploitation a une personne qui prend l'astreinte.",
    useCase: "expliquer",
    rights: "lecture",
    web: false,
    tier: "rapide",
    reflection: "standard",
    taskSize: "S",
    instructions: "Tu expliques une procedure pas a pas, en francais, sans jargon inutile.",
    fiches: [],
    examples: [],
    icon: "book",
    methods: [METHODE.id],
    name: ASSISTANT.name,
  };
}

/** Va sur une adresse du cockpit par le fragment, comme un lien, puis attend ce qui doit y être. */
async function allerA(onglet, hash, attendu, libelle) {
  await onglet.evaluer(`location.hash = ${JSON.stringify(hash)}`);
  await onglet.attendreQue(attendu, { libelle, delaiMs: 20_000 });
}

/** Ouvre le panneau « Contexte » s'il est fermé (il se ferme de lui-même sous 1280 px). */
async function ouvrirLeContexte(onglet) {
  const ouvert = "document.querySelector('.chat')?.classList.contains('aside-open') === true";
  if (await onglet.evaluer(ouvert)) return;
  await onglet.evaluer(`document.querySelector('.chat-header button[aria-label="Afficher le contexte"]')?.click()`);
  await onglet.attendreQue(ouvert, { libelle: "panneau « Contexte » ouvert", delaiMs: 10_000 });
}

/** Amène une vue dans la fenêtre avant la capture : à 1024 et à 400 px, une section basse de la page est hors champ. */
const amener = (onglet, selecteur) => async () => {
  await onglet.evaluer(`document.querySelector(${JSON.stringify(selecteur)})?.scrollIntoView({ block: "start" })`);
};

/** Ouvre le popover de la puce « + Méthode » s'il est fermé : il se referme à chaque changement de taille. */
async function ouvrirLePopover(onglet) {
  await onglet.attendreQue("document.querySelector('.methodes-puce button:not([disabled])')", { libelle: "puce « + Méthode »" });
  if (!(await onglet.evaluer("Boolean(document.querySelector('.methodes-menu'))"))) {
    await onglet.evaluer(`document.querySelector(".methodes-puce button").click()`);
  }
  await onglet.attendreQue("document.querySelector('.methodes-menu')", { libelle: "popover de la puce ouvert" });
}

export async function run(ctx) {
  const page = await preparerPage(ctx);
  if (ctx.mode !== "faux") {
    nonJoue(ctx, "banc de captures d'accessibilité", "les réponses scriptées du faux opencode n'existent qu'en « --faux »");
    ctx.expectNoConsoleErrors();
    return;
  }
  const ia = await attendreIa(ctx);
  const client = oc(ctx);

  // Données des vues : un assistant avec une méthode, et une conversation dont la demande portait son bloc.
  const enregistre = await ctx.api.put(`/api/assistants/${ASSISTANT.name}`, brouillon());
  exiger(enregistre?.name === ASSISTANT.name, `assistant non enregistré : ${resume(enregistre)}`);
  await ctx.faux.tourParDefaut(REPONSE);
  const racine = await client.creerConversation("c5a-a11y");
  const envoi = await client.envoyer(racine.id, `${DEMANDE}${BLOC}`, ia);
  exiger(envoi.code === 204, `envoi refusé (${envoi.code}) : ${resume(envoi.corps)}`);
  await attendreFinDuTour(client, racine.id);

  const prefixe = path.join(ctx.dossierCaptures, ctx.nom.replace(/\.mjs$/, ""));
  const { navigateur, onglet } = await ouvrirNavigateurEpingle(ctx, "a11y");
  const faites = [];
  try {
    // Même préparation que tout scénario de la page (règles acceptées au clic, notice fermée, relevés installés) : la
    // fonction ne lit du contexte que `ctx.navigateur`, on lui passe donc l'onglet de ce banc.
    await preparerPage({ ...ctx, navigateur: onglet });

    // 1. Bibliothèque des méthodes.
    await allerA(onglet, "#/assistants", "document.querySelector('.met-library .met-grid .met-card')", "bibliothèque des méthodes");
    faites.push(...(await captureAccessibilite(navigateur, onglet, `${prefixe}-bibliotheque`, { avant: amener(onglet, ".met-library") })));

    // 2. Écran « Consignes et fiches » de l'assistant de création (les méthodes s'y choisissent), ouvert sur un
    //    assistant existant : ses étapes précédentes sont déjà valides.
    await allerA(onglet, `#/assistants/modifier/${ASSISTANT.name}`, "document.querySelector('.wiz-steps')", "assistant de création");
    const allerAuxConsignes = async () => {
      if (await onglet.evaluer(`[...document.querySelectorAll(".wiz h2")].some((h) => h.textContent.trim() === ${JSON.stringify(PHRASES.consignes)})`)) return;
      await onglet.evaluer(`(() => {
        const bouton = [...document.querySelectorAll(".wiz-steps button")].find((b) => b.textContent.includes(${JSON.stringify(PHRASES.consignes)}));
        bouton?.click();
      })()`);
      await onglet.attendreQue(
        `[...document.querySelectorAll("h2")].some((h) => h.textContent.trim() === ${JSON.stringify(PHRASES.consignes)})`,
        { libelle: `écran « ${PHRASES.consignes} »` },
      );
    };
    await allerAuxConsignes();
    faites.push(...(await captureAccessibilite(navigateur, onglet, `${prefixe}-consignes-et-fiches`, { avant: allerAuxConsignes })));

    // 3. Popover de la puce « + Méthode » et 4. bulle du message : les deux dans la conversation préparée.
    await allerA(onglet, `#/chat/${racine.id}`, "document.querySelector('.methode-bulle')", "conversation avec une méthode demandée");
    await ouvrirLePopover(onglet);
    faites.push(...(await captureAccessibilite(navigateur, onglet, `${prefixe}-popover-puce`, { avant: () => ouvrirLePopover(onglet) })));
    await onglet.touche("Escape");
    await onglet.attendreQue("!document.querySelector('.methodes-menu')", { libelle: "popover fermé" });
    faites.push(...(await captureAccessibilite(navigateur, onglet, `${prefixe}-bulle-methode`)));

    // 5. Chronologie (mode Avancé seulement : « jeton » est interdit en Simple).
    await enModeAvance(ctx, async () => {
      await attendreModeAffiche(onglet, "avance");
      const ouvrirLaChronologie = async () => {
        await ouvrirLeContexte(onglet);
        if (await onglet.evaluer("Boolean(document.querySelector('.chronologie'))")) return;
        await onglet.evaluer(`(() => {
          const b = [...document.querySelectorAll(".chrono-bascule button")].find((x) => x.textContent.trim() === ${JSON.stringify(PHRASES.chronologie)});
          b?.click();
        })()`);
        await onglet.attendreQue("document.querySelector('.chronologie')", { libelle: "vue Chronologie" });
      };
      await ouvrirLaChronologie();
      // La vue est relevée JUSTE AVANT chaque capture : `captureAccessibilite` ne compte que les fichiers écrits, et 18
      // fichiers montrant une conversation sans panneau tiendraient le point « captures présentes » en nombre, pas en
      // contenu. À 400 px la figure disparaît (§5.6) : seul le tableau est exigé.
      const chronoVues = [];
      faites.push(
        ...(await captureAccessibilite(navigateur, onglet, `${prefixe}-chronologie`, {
          avant: ouvrirLaChronologie,
          apres: async ({ mode, theme, taille }) => {
            const vue = await onglet.evaluer(`(() => {
              const v = document.querySelector(".chronologie");
              return v ? { rangees: v.querySelectorAll("tbody tr").length, tableau: v.querySelector("table") !== null } : null;
            })()`);
            chronoVues.push({ mode: mode.nom, theme, taille: taille.nom, vue });
            const ou = `${mode.nom}, ${theme}, ${taille.nom} px`;
            exiger(vue !== null, `vue Chronologie absente au moment de la capture (${ou}).`);
            exiger(vue.tableau && vue.rangees > 0, `chronologie vide au moment de la capture (${ou}) : ${resume(vue)}`);
          },
        })),
      );
      releve(ctx, `chronologie relevée avant chacune des ${chronoVues.length} captures`);
      exiger(chronoVues.length === MODES_A11Y.length * 6, `${chronoVues.length} relevés de chronologie pour 18 captures.`);

      // Mouvement réduit : relevé DISCRIMINANT. La seule animation que le réglage commande est la transition WAAPI d'un signe de
      // la carte de la bande néon (NeonBand.tsx, `mouvementPermis()` ; environ 900 ms, une par signe apparu ou changé). La MÊME
      // action — un tour de plus, envoyé par l'API pendant que la carte est affichée (mode Avancé, bande dépliée), qui fait
      // passer l'assistant de « terminé » à « travaille » puis à « terminé » — est donc jouée deux fois, relevée de la même façon :
      //   1. en mode normal, la carte doit animer : au moins une animation de la carte en cours, relevée sans délai ;
      //   2. en mouvement réduit (le réglage vu par matchMedia dans la page, exigé d'abord), la même action n'anime rien : zéro.
      // Un relevé au repos, longtemps après le dernier changement, ne dirait rien du réglage : plus rien ne tourne alors, réglage
      // ou non. Les boucles CSS de la page (`.dot.pulse`, `.spinner`) ne sont pas un témoin non plus, ni les transitions CSS
      // de 0,01 ms que la règle globale de styles.css crée dans la carte sous mouvement réduit (voir `DUREE_PERCEPTIBLE_MS`) :
      // seules les animations d'une durée perceptible comptent. Enfin, au repos, plus rien ne tourne dans toute la page.
      await onglet.taille(LARGE);
      await onglet.attendreQue("document.querySelector('.neon-map')", { libelle: "carte de la bande néon" });
      const perceptibles = async () => (await releves(onglet)).animations.filter((a) => a.duree >= DUREE_PERCEPTIBLE_MS).length;
      const enCoursSurLaCarte = () => animationsActives(onglet, { dans: ".neon-map", dureeMinMs: DUREE_PERCEPTIBLE_MS });
      const tourSurLaCarte = async (etiquette) => {
        // Carte au repos d'abord : la file de la bande dessine le dernier état d'un tour un peu après que l'API l'a dit fini, et
        // sa transition (900 ms) court encore un instant ; une transition lancée en mode normal ne s'arrête pas quand le réglage
        // change, et elle compterait à tort dans le relevé du tour suivant.
        await attendreQue(async () => (await enCoursSurLaCarte()) === 0, { delaiMs: 10_000, pasMs: 100, libelle: `carte au repos avant « ${etiquette} »` });
        // Un tour en plusieurs temps (700 ms par pas), pour que la file de la bande (au plus 4 rendus par seconde) dessine bien
        // « travaille » avant « terminé » : sinon un tour instantané pourrait tenir entre deux rendus.
        await ctx.faux.scripter(racine.id, { ...REPONSE, stepMs: 700 });
        const avant = await perceptibles();
        const envoi = await client.envoyer(racine.id, `${DEMANDE} (${etiquette})`, ia);
        exiger(envoi.code === 204, `envoi (${etiquette}) refusé (${envoi.code}) : ${resume(envoi.corps)}`);
        // Relevé sans délai : la carte est échantillonnée toutes les 50 ms environ, du départ du tour jusqu'à une transition
        // entière (900 ms) après sa fin. Une transition de 900 ms ne peut pas passer entre deux échantillons.
        let enCours = 0;
        const fin = attendreFinDuTour(client, racine.id).then(() => attendre(900));
        for (let termine = false; !termine; ) {
          enCours = Math.max(enCours, await enCoursSurLaCarte());
          termine = await Promise.race([fin.then(() => true), attendre(50).then(() => false)]);
        }
        await onglet.attendreQue("document.querySelector('.neon-map .neon-noeud.is-termine')", { libelle: `assistant « terminé » sur la carte (${etiquette})` });
        // Animations d'une durée perceptible créées dans la carte pendant le tour, vues par l'observateur de mutations
        // d'`instrumenter` (it1-ui-commun) : un second témoin, qui ne dépend pas de l'échantillonnage.
        const creees = (await perceptibles()) - avant;
        return { enCours, creees };
      };

      await emuler(navigateur, onglet, { theme: "clair" });
      const mediasNormal = await mediasDeLaPage(onglet);
      exiger(mediasNormal.mouvementReduit === false, `la page voit un mouvement réduit alors que le mode normal est émulé : ${resume(mediasNormal)}`);
      const normal = await tourSurLaCarte("tour 2, mode normal");
      releve(ctx, `tour 2 en mode normal : au plus ${normal.enCours} animation(s) perceptible(s) de la carte en cours, ${normal.creees} créée(s)`);
      exiger(
        normal.enCours > 0 && normal.creees > 0,
        `la carte n'a pas animé le tour en mode normal (${resume(normal)}) : le relevé en mouvement réduit ne discriminerait rien.`,
      );

      await emuler(navigateur, onglet, { theme: "sombre", reducedMotion: true, grayscale: true });
      const mediasReduit = await mediasDeLaPage(onglet);
      exiger(mediasReduit.mouvementReduit === true, `la page ne voit pas le mouvement réduit émulé : ${resume(mediasReduit)}`);
      const reduit = await tourSurLaCarte("tour 3, mouvement réduit");
      releve(ctx, `tour 3 en mouvement réduit : au plus ${reduit.enCours} animation(s) perceptible(s) de la carte en cours, ${reduit.creees} créée(s)`);
      exiger(
        reduit.enCours === 0 && reduit.creees === 0,
        `${reduit.enCours} animation(s) perceptible(s) de la carte en cours et ${reduit.creees} créée(s) alors que le mouvement réduit est demandé (§5.5).`,
      );

      // Au repos, plus rien ne tourne dans toute la page.
      await attendre(1_200);
      const enMouvementReduit = await animationsActives(onglet);
      releve(ctx, `animations en cours dans toute la page, au repos, en mouvement réduit : ${enMouvementReduit}`);
      exiger(enMouvementReduit === 0, `${enMouvementReduit} animation(s) tournent encore alors que le mouvement réduit est demandé (§5.5).`);
    });
    await attendreModeAffiche(onglet, "simple");

    // 6. Coûts par équipe, vides : aucun lancement d'équipe dans cette pile.
    await allerA(onglet, "#/couts", `document.body.innerText.includes(${JSON.stringify(PHRASES.coutsVides)})`, "Coûts par équipe vides");
    faites.push(...(await captureAccessibilite(navigateur, onglet, `${prefixe}-couts-equipes-vides`, { avant: amener(onglet, ".team-costs-note") })));

    // Contraste forcé : le focus reste visible, sur la navigation comme sur la puce du composeur.
    await emuler(navigateur, onglet, { theme: "clair", forcedColors: true });
    const navigation = await focusVisible(onglet, "nav.rail a.nav-item");
    releve(ctx, `focus en contraste forcé (navigation) : ${JSON.stringify(navigation)}`);
    exiger(navigation.visible, `focus invisible en contraste forcé sur la navigation : ${resume(navigation)}`);
    await allerA(onglet, `#/chat/${racine.id}`, "document.querySelector('.methodes-puce button')", "composeur de la conversation");
    const puce = await focusVisible(onglet, ".methodes-puce button");
    releve(ctx, `focus en contraste forcé (puce « + Méthode ») : ${JSON.stringify(puce)}`);
    exiger(puce.visible, `focus invisible en contraste forcé sur la puce : ${resume(puce)}`);

    const attendues = 6 * MODES_A11Y.length * 6;
    releve(ctx, `captures d'accessibilité écrites : ${faites.length} (${MODES_A11Y.map((m) => m.nom).join(", ")})`);
    exiger(faites.length === attendues, `${faites.length} captures au lieu de ${attendues} (3 modes × 2 thèmes × 3 tailles × 6 vues).`);
    onglet.exigerAucuneErreurConsole();
  } finally {
    await navigateur.fermer().catch(() => {});
  }

  exiger(page !== null, "page du banc absente.");
  ctx.expectNoConsoleErrors();
}
