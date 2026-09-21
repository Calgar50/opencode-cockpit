// Captures de la salle de contrôle, de « Revoir » et des démonstrations (itération 3, paquet L33).
//
// Spécification §7.7 l.1174, §5.5 l.917-924 (clavier, contraste, couleurs forcées, mouvement), §5.6 l.926-928 (400 px :
// « captures à 400 px pour chaque nouvelle vue »), §5.7.1 l.946 (couleurs JP-14), §5.8 ; plan it3 fiche L33, D-3d-18 ;
// mesures EXEC/mesures/MX-3D.md (M3D-1 : contexte matériel sur ce poste, mode du banc RELU À CHAQUE EXÉCUTION) et
// EXEC/mesures/L35.md (mode 3D du banc). AUCUNE aide e2e n'est écrite ici : tout vient de `e2e/lib/webgl.mjs` (L35).
//
// Cinq vues, chacune prise à 1440, 1024 et 400 px, dans les deux thèmes :
//   zoom 1 (projets) · zoom 2 (une conversation) · zoom 3 (un assistant) · « Revoir » AVEC le panneau de la consigne ouvert
//   (U2, texte long : la copie gardée est bornée à 8 000 caractères et le mentionne) · démonstration enregistrée.
// Puis quatre réglages du poste, émulés par `emuler` (L35) : NIVEAUX DE GRIS (`achromatopsia`) et DEUTÉRANOPIE — qui ne
// changent que la restitution des couleurs, donc pris au vol sur la même page — puis COULEURS FORCÉES et MOUVEMENT RÉDUIT,
// qui changent la vue : la 3D n'y est jamais montrée (L30, JP-12), la salle passe en 2D et le scénario exige SA PHRASE.
//
// Contrôles (une capture muette ne prouverait rien) :
//   1. mode 3D du banc relu ici ; contexte matériel → 3D réelle, `webgl2` logiciel seul → « moteur simulé » (D-3d-18),
//      aucun `webgl2` → captures 3D consignées EN ATTENTE, jamais déclarées faites ;
//   2. contrôle NON VIDE de la 3D : morceau paresseux de three chargé ET au moins une image rendue par le moteur ;
//   3. à 400 px, la vue disparaît et la LISTE reste la vérité (P7, §5.6 l.928) — la vue de CHAQUE zoom est nommée par la vue
//      elle-même (`.salle3d-vue` au zoom 1, `.zoom-conv-vue` aux zooms 2 et 3) : un sélecteur écrit en dur rendrait le
//      contrôle du zoom 1 toujours vrai ;
//   4. le panneau de la consigne montre un texte long qui DÉFILE à 400 px, avec la mention de troncature ;
//   5. sous couleurs forcées et sous mouvement réduit : aucun canevas, et la phrase « Affichage 2D : vos réglages
//      d'accessibilité le demandent » ;
//   6. toutes les captures sont écrites DANS LE DOSSIER DU BANC (`ctx.dossierCaptures`), jamais dans le dépôt ;
//   7. zéro violation de la CSP, zéro erreur de console.
import path from "node:path";
import {
  attendre,
  attendreDemandes,
  attendreFinDuTour,
  attendreIa,
  attendreModeAffiche,
  avecTemoinP6,
  cliquerBouton,
  demandeDeDelegation,
  enModeAvance,
  exiger,
  LARGE,
  nonJoue,
  oc,
  ouvrirConversation,
  PHRASES,
  preparerPage,
  releve,
  resume,
  texteVisible,
} from "./it1-ui-commun.mjs";
import { attendre2d, attendreScene3d, emuler, ouvrirSalle, preparer3d, preuveTroisD, ressources, violationsCsp } from "../lib/webgl.mjs";

/** Tailles demandées par la spécification (§5.6 l.926-928, §7.7 l.1174). */
const TAILLES = [
  { nom: "1440", largeur: 1440, hauteur: 900 },
  { nom: "1024", largeur: 1024, hauteur: 768 },
  { nom: "400", largeur: 400, hauteur: 860 },
];
/** Taille de travail : les boîtes s'ouvrent depuis la bande, qui n'a plus ses commandes à 400 px. */
const [TRAVAIL] = TAILLES;
const THEMES = ["clair", "sombre"];
/** Réglages de vision émulés au vol, sans changer la page (`Emulation.setEmulatedVisionDeficiency`). */
const VISIONS = [
  { nom: "gris", type: "achromatopsia" },
  { nom: "deuteranopie", type: "deuteranopia" },
];
/** Réglages du poste qui changent la vue : la 3D n'y est jamais montrée, la salle passe en 2D avec sa phrase (JP-12, L30). */
const REGLAGES_2D = [
  { nom: "couleurs-forcees", media: { couleursForcees: true } },
  { nom: "mouvement-reduit", media: { mouvementReduit: true } },
];
/** Tailles gardées pour les réglages d'accessibilité : la plus large et la plus étroite. */
const TAILLES_REGLAGE = TAILLES.filter((taille) => taille.nom !== "1024");
/** §5.8 l.1006 : raison « accessibilité » du repli 2D (salle3d-texts.ts, `accessibilite`). */
const PHRASE_2D = "Affichage 2D : vos réglages d'accessibilité le demandent";

const DESCRIPTION = "Relire le dossier pour les captures";
/** Consigne scriptée de 9 000 caractères : la copie gardée est bornée à 8 000 et le dit (D-3d-30, U2). */
const CONSIGNE = `Relis le dossier et dis ce qui manque. ${"Prends le temps de tout relire, page après page. ".repeat(220)}`.slice(0, 9_000);
const TRAVAIL_MS = 3_000;
const PAS_MS = 2_500;
/** Relecture archivée d'une conversation au repos (classifier.ts, onIdle). */
const ARCHIVAGE_MS = 5_000;

/** Délégation scriptée dont la consigne transmise à l'enfant est choisie (source de la copie gardée, U2). */
const tache = (description, cible, prompt, enfant) => ({
  tool: "task",
  input: { description, prompt, subagent_type: cible },
  ask: { permission: "task", patterns: [cible], metadata: { description, subagent_type: cible } },
  askAfterMs: 5,
  child: { agent: cible, ...enfant },
});

export async function run(ctx) {
  const { cdp, mode, simule } = await preparer3d(ctx);
  try {
    if (ctx.mode !== "faux") {
      nonJoue(ctx, "captures de la salle de contrôle", "le faux fournisseur ne délègue pas : ni zoom 3, ni consigne à montrer");
      ctx.expectNoConsoleErrors();
      return;
    }
    // 1. Mode 3D du banc, relu à CHAQUE exécution (M3D-1 : le résultat dépend du poste).
    releve(ctx, `mode 3D du banc : ${mode.mode}${simule ? " (moteur simulé posé, D-3d-18)" : ""} — moteur ${resume(mode.moteur, 80)}`);
    if (mode.mode === "aucun") nonJoue(ctx, "captures de la 3D", "aucun contexte webgl2 dans ce banc : les vues de la salle sont 2D, contrôles 3D EN ATTENTE");
    await jouer(ctx, cdp, mode);
  } finally {
    await cdp.fermer();
  }
}

async function jouer(ctx, cdp, mode) {
  const page = await preparerPage(ctx);
  const faites = [];
  const attendue3d = mode.mode !== "aucun";

  await avecTemoinP6(ctx, async () => {
    await enModeAvance(ctx, async () => {
      await attendreModeAffiche(page, "avance");
      const rootId = await deleguer(ctx, page);

      // 2. Contrôle NON VIDE : le morceau paresseux de three est chargé et le moteur a rendu au moins une image.
      const avant = await ressources(cdp);
      const sessionId = await trouverAssistant(page, rootId, attendue3d);
      if (attendue3d) {
        const preuve = await preuveTroisD(cdp, avant);
        exiger(preuve.morceau !== null, "le morceau paresseux de three n'a pas été chargé : les captures 3D seraient vides.");
        exiger(preuve.scenes > 0, "aucune image rendue par le moteur three : les captures 3D seraient vides.");
        releve(ctx, `3D montée : morceau ${preuve.morceau.url.split("/").pop()} (${preuve.morceau.taille} octets), ${preuve.scenes} image(s), causes ${resume(preuve.causes)}`);
      }

      const vues = construireVues(rootId, sessionId);
      for (const theme of THEMES) faites.push(...(await passeOrdinaire(ctx, page, cdp, { vues, theme, attendue3d })));
      for (const reglage of REGLAGES_2D) {
        for (const theme of THEMES) faites.push(...(await passeAccessibilite(ctx, page, cdp, { vues, theme, reglage })));
      }
      await emuler(cdp, { theme: "clair", vision: "none" });
      await poser(page, LARGE);
    });
  });

  // 6. Toutes les captures sont dans le dossier du banc, jamais dans le dépôt.
  const dossier = path.resolve(ctx.dossierCaptures);
  const dehors = faites.filter((fichier) => !path.resolve(fichier).startsWith(dossier));
  exiger(dehors.length === 0, `capture(s) écrite(s) hors du dossier du banc : ${resume(dehors)}`);
  const attendues = THEMES.length * 5 * (TAILLES.length + VISIONS.length) + REGLAGES_2D.length * THEMES.length * 5 * TAILLES_REGLAGE.length;
  exiger(faites.length === attendues, `${faites.length} capture(s) faites, ${attendues} attendues.`);
  releve(
    ctx,
    `${faites.length} captures dans ${dossier} : 5 vues × ${TAILLES.length} tailles × ${THEMES.length} thèmes, + ${VISIONS.length} visions à ${TRAVAIL.nom} px, + ${REGLAGES_2D.length} réglages d'accessibilité (${TAILLES_REGLAGE.map((t) => t.nom).join(" et ")} px)`,
  );
  if (!attendue3d) nonJoue(ctx, "vues 3D des captures", "banc sans webgl2 : seules les vues 2D sont capturées");

  // 7. CSP et console.
  const violations = await violationsCsp(cdp);
  exiger(violations.length === 0, `violation(s) de la CSP pendant les captures : ${resume(violations)}`);
  ctx.expectNoConsoleErrors();
}

// --- Les deux passes -------------------------------------------------------------------------------------------------------------

/**
 * Passe 1 : réglages du poste ordinaires. Chaque vue est ouverte une fois, puis prise aux trois tailles ; à la plus large, deux
 * captures de plus par vue, en niveaux de gris et en deutéranopie — ces réglages ne changent que la restitution des couleurs,
 * donc ils se posent au vol, sans rouvrir la vue.
 */
async function passeOrdinaire(ctx, page, cdp, { vues, theme, attendue3d }) {
  const faites = [];
  await emuler(cdp, { theme, vision: "none" });
  for (const vue of vues) {
    await poser(page, TRAVAIL);
    await vue.ouvrir(ctx, page, { attendue3d });
    for (const taille of TAILLES) {
      await poser(page, taille);
      await vue.avant?.(ctx, page, taille);
      faites.push(await capturer(ctx, page, `${vue.nom}-${taille.nom}-${theme}`));
      if (taille.nom !== TRAVAIL.nom) continue;
      for (const vision of VISIONS) {
        await emuler(cdp, { theme, vision: vision.type });
        faites.push(await capturer(ctx, page, `${vue.nom}-${TRAVAIL.nom}-${theme}-${vision.nom}`));
      }
      await emuler(cdp, { theme, vision: "none" });
    }
    await vue.fermer(page);
  }
  return faites;
}

/**
 * Passe 2 : couleurs forcées, puis mouvement réduit. La 3D n'y est jamais montrée (L30, JP-12) : la salle passe en 2D et dit sa
 * raison, ce que `etatSalle` exige avant chaque capture. Deux tailles seulement, la plus large et la plus étroite.
 */
async function passeAccessibilite(ctx, page, cdp, { vues, theme, reglage }) {
  const faites = [];
  await emuler(cdp, { theme, vision: "none", ...reglage.media });
  for (const vue of vues) {
    await poser(page, TRAVAIL);
    await vue.ouvrir(ctx, page, { attendue3d: false, phrase2d: true });
    for (const taille of TAILLES_REGLAGE) {
      await poser(page, taille);
      faites.push(await capturer(ctx, page, `${vue.nom}-${taille.nom}-${theme}-${reglage.nom}`));
    }
    await vue.fermer(page);
  }
  releve(ctx, `${reglage.nom} (${theme}) : salle en 2D, phrase « ${PHRASE_2D} », aucun canevas ; ${faites.length} captures`);
  return faites;
}

// --- Les cinq vues ---------------------------------------------------------------------------------------------------------------

/** Les cinq vues capturées : comment les ouvrir, ce qu'on y contrôle, comment les refermer. */
function construireVues(rootId, sessionId) {
  return [
    {
      nom: "zoom1",
      ouvrir: async (ctx, page, options) => {
        await ouvrirSalle(page, null);
        await page.attendreQue("document.querySelector('.salle3d-zoom1')", { libelle: "zoom 1 de la salle" });
        await etatSalle(page, options);
      },
      avant: async (ctx, page, taille) => await exigerVeriteAuPetitEcran(page, taille, ".salle3d-grille", ".salle3d-vue"),
      fermer: fermerSalle,
    },
    {
      nom: "zoom2",
      ouvrir: async (ctx, page, options) => {
        await ouvrirSalle(page, rootId);
        await page.attendreQue("document.querySelector('.page.salle3d .zoom-conv')", { libelle: "zoom 2 de la salle" });
        await etatSalle(page, options);
      },
      avant: async (ctx, page, taille) => await exigerVeriteAuPetitEcran(page, taille, ".zoom-conv-liste", ".zoom-conv-vue"),
      fermer: fermerSalle,
    },
    {
      nom: "zoom3",
      ouvrir: async (ctx, page, options) => {
        await ouvrirSalle(page, rootId, sessionId);
        await page.attendreQue("document.querySelector('.page.salle3d .zoom-conv-panneau')", { libelle: "panneau du zoom 3" });
        await etatSalle(page, options);
      },
      avant: async (ctx, page, taille) => await exigerVeriteAuPetitEcran(page, taille, ".zoom-conv-panneau", ".zoom-conv-vue"),
      fermer: fermerSalle,
    },
    {
      nom: "revoir-consigne",
      ouvrir: async (ctx, page) => await ouvrirRevoirAvecConsigne(ctx, page, rootId),
      avant: async (ctx, page, taille) => await exigerConsigneDefilante(ctx, page, taille),
      fermer: fermerBoite,
    },
    {
      nom: "demonstration",
      ouvrir: async (ctx, page) => await ouvrirDemonstration(ctx, page, rootId),
      fermer: fermerBoite,
    },
  ];
}

/** Taille de la fenêtre, puis un temps de pose : la mise en page et les transitions doivent être finies avant la capture. */
async function poser(page, taille) {
  await page.taille(taille);
  await attendre(250);
}

/** Une capture, écrite dans le dossier du banc sous le nom du scénario (jamais dans le dépôt). */
async function capturer(ctx, page, nom) {
  return await page.capture(path.join(ctx.dossierCaptures, `${ctx.nom.replace(/\.mjs$/, "")}-${nom}.png`));
}

/**
 * État attendu de la salle : 3D montée quand le banc le permet et que le poste ne demande rien de contraire ; sinon 2D, et,
 * sous un réglage d'accessibilité, la phrase de la raison (§5.8 l.1006) — la 3D n'est JAMAIS montrée là (L30, JP-12).
 */
async function etatSalle(page, { attendue3d = true, phrase2d = false } = {}) {
  if (attendue3d) {
    await attendreScene3d(page);
    return;
  }
  await attendre2d(page);
  if (!phrase2d) return;
  await page.attendreQue(`(document.querySelector(".salle3d-fluidite")?.innerText ?? "").includes(${JSON.stringify(PHRASE_2D)})`, { libelle: `phrase « ${PHRASE_2D} »` });
  const dite = await texteVisible(page, ".salle3d-fluidite");
  exiger(dite.includes(PHRASE_2D), `repli 2D sans sa phrase : « ${resume(dite, 200)} ».`);
  exiger(!(await page.evaluer("Boolean(document.querySelector('.salle3d-canevas'))")), "un canevas 3D est monté alors que le poste demande le contraire (L30).");
}

/**
 * 3 : à 400 px, la vue disparaît et ce qui porte la vérité reste montré (P7, §5.6 l.928).
 * Les DEUX sélecteurs sont donnés par la vue : le zoom 1 a sa propre vue (`.salle3d-vue`, DÉMONTÉE par la garde `etroit` de
 * `SalleControlePage.tsx` — seuil ETROIT à 400 px —, et non cachée par une règle CSS : c'est cette garde que le contrôle
 * protège), les zooms 2 et 3 la leur (`.zoom-conv-vue`, cachée par `zoom-conversation.css`). Écrire « .zoom-conv-vue » en dur
 * rendrait le contrôle du zoom 1 toujours vrai, puisque ce nœud n'existe pas dans cette vue.
 */
async function exigerVeriteAuPetitEcran(page, taille, selecteurVerite, selecteurVue) {
  await page.attendreQue(`document.querySelector(${JSON.stringify(selecteurVerite)})`, { libelle: `vérité de la vue (${selecteurVerite})` });
  if (taille.nom !== "400") return;
  const visible = (selecteur) => `(() => { const e = document.querySelector(${JSON.stringify(selecteur)}); return Boolean(e) && e.getClientRects().length > 0; })()`;
  exiger(await page.evaluer(visible(selecteurVerite)), `à 400 px, ${selecteurVerite} n'est plus visible : la vérité de la vue a disparu.`);
  exiger((await page.evaluer(visible(selecteurVue))) === false, `à 400 px, ${selecteurVue} est encore montré (§5.6 l.928 : liste seule).`);
}

/** 4 : le texte long de la consigne défile dans sa carte à 400 px, et la mention de troncature est là. */
async function exigerConsigneDefilante(ctx, page, taille) {
  const texte = await page.evaluer("document.querySelector('.revoir-boite .consigne-revoir-texte')?.textContent ?? ''");
  exiger(texte.length > 1_000, `consigne trop courte pour la capture « texte long » : ${texte.length} caractères.`);
  if (taille.nom !== "400") return;
  const mesures = await page.evaluer(`(() => {
    const bloc = document.querySelector(".revoir-boite .consigne-revoir-texte");
    if (!bloc) return null;
    bloc.scrollTop = Math.round(bloc.scrollHeight / 3);
    return { defilement: bloc.scrollHeight, hauteur: bloc.clientHeight, position: bloc.scrollTop };
  })()`);
  exiger(mesures !== null, "panneau de la consigne absent à 400 px.");
  exiger(mesures.defilement > mesures.hauteur + 20, `à 400 px, le texte de la consigne ne défile pas (${mesures.defilement} px dans ${mesures.hauteur} px).`);
  exiger(mesures.position > 0, "le texte de la consigne n'a pas défilé : la capture ne montrerait pas le défilement.");
  const mention = await texteVisible(page, ".revoir-boite .consigne-revoir-tronquee");
  exiger(mention.startsWith("Consigne tronquée :"), `mention de troncature attendue sur une consigne de 9 000 caractères, lue « ${resume(mention)} ».`);
  releve(ctx, `consigne à 400 px : ${texte.length} caractères, ${mesures.defilement} px de texte dans ${mesures.hauteur} px, « ${resume(mention, 80)} »`);
}

async function fermerSalle(page) {
  await page.evaluer("location.hash = '#/'");
  await page.attendreQue("!document.querySelector('.page.salle3d')", { libelle: "salle fermée" });
}

/** Échap ferme d'abord le panneau de la consigne, puis la boîte : la touche est envoyée jusqu'à ce que tout soit fermé. */
async function fermerBoite(page) {
  const ouvert = "document.querySelector('.modal') || document.querySelector('.revoir-boite')";
  for (let essai = 0; essai < 3 && (await page.evaluer(`Boolean(${ouvert})`)); essai++) {
    await page.touche("Escape");
    await attendre(250);
  }
  await page.attendreQue(`!(${ouvert})`, { libelle: "boîte fermée par Échap" });
}

// --- Ouvertures des boîtes -------------------------------------------------------------------------------------------------------

/** « Revoir » ouvert depuis la bande, posé sur son dernier moment, puis le panneau de la consigne gardée (U2). */
async function ouvrirRevoirAvecConsigne(ctx, page, rootId) {
  await ouvrirConversation(ctx, rootId);
  await deplierLaBande(page);
  await cliquerBouton(page, "Revoir cette demande", { portee: ".neon-band" });
  await page.attendreQue("document.querySelector('.revoir-boite .revoir-bar .revoir-moments')", { libelle: "lecteur de « Revoir »" });
  await allerAuDernierMoment(page, ".revoir-boite");
  // Zoom 3 dans la boîte : le panneau de l'assistant porte [Voir la consigne] (U2).
  await page.attendreQue("document.querySelectorAll('.revoir-boite .neon-nodes button').length > 1", { libelle: "assistants de la carte de « Revoir »" });
  await page.evaluer("document.querySelectorAll('.revoir-boite .neon-nodes button')[1].click()");
  await page.attendreQue("document.querySelector('.revoir-boite .revoir-panneau')", { libelle: "zoom 3 dans la boîte de « Revoir »" });
  await cliquerBouton(page, "Voir la consigne", { portee: ".revoir-boite .revoir-panneau" });
  await page.attendreQue("document.querySelector('.revoir-boite .consigne-revoir-texte')", { libelle: "panneau de la consigne gardée" });
}

/** Démonstration enregistrée, ouverte depuis la bande et posée sur son dernier moment. */
async function ouvrirDemonstration(ctx, page, rootId) {
  await ouvrirConversation(ctx, rootId);
  await deplierLaBande(page);
  await cliquerBouton(page, "Voir une démonstration", { portee: ".neon-band" });
  await page.attendreQue("document.querySelector('.modal .neon-band')", { libelle: "boîte de la démonstration" });
  const etiquette = await texteVisible(page, ".modal .modal-header h2");
  exiger(etiquette === PHRASES.demonstration, `étiquette de la démonstration « ${resume(etiquette)} » au lieu de « ${PHRASES.demonstration} ».`);
  await allerAuDernierMoment(page, ".modal");
}

/** La bande dépliée : ses commandes ([Revoir cette demande], [Voir une démonstration]) n'existent qu'alors. */
async function deplierLaBande(page) {
  await page.attendreQue("document.querySelector('.neon-band')", { libelle: "bande néon de la conversation" });
  await cliquerBouton(page, "Afficher la carte", { portee: ".neon-band" }).catch(() => {});
}

/**
 * Lecteur posé sur son dernier moment : la vue y montre tout ce que la suite a dessiné. Le curseur est un VRAI curseur contrôlé
 * par React (une valeur posée par programme ne le déplace pas, it3-demos) : il se déplace au clavier, [Fin] puis → au besoin.
 */
async function allerAuDernierMoment(page, portee) {
  const curseur = `${portee} .revoir-curseur`;
  const valeur = async () => Number(await page.evaluer(`document.querySelector('${curseur}')?.value ?? -1`));
  const dernier = Number(await page.evaluer(`document.querySelector('${curseur}').max`));
  await page.evaluer(`document.querySelector('${curseur}').focus()`);
  await page.touche("End");
  await attendre(200);
  for (let pas = 0; pas < dernier && (await valeur()) !== dernier; pas++) {
    await page.touche("ArrowRight");
    await attendre(30);
  }
  const atteint = await valeur();
  exiger(atteint === dernier, `le lecteur n'est pas allé au dernier moment (${atteint} / ${dernier}).`);
}

// --- Conversation des captures ---------------------------------------------------------------------------------------------------

/** Conversation qui délègue une fois, avec une consigne longue : de quoi peupler les zooms 2 et 3 et « Revoir ». */
async function deleguer(ctx, page) {
  const ia = await attendreIa(ctx);
  const client = oc(ctx);
  const racine = await client.creerConversation("it3-captures");
  await ctx.faux.scripter(racine.id, {
    stepMs: PAS_MS,
    tools: [tache(DESCRIPTION, "general", CONSIGNE, { text: "Dossier relu.", workMs: TRAVAIL_MS })],
    followUp: { text: "Synthèse du dossier." },
  });
  await ouvrirConversation(ctx, racine.id);
  const envoi = await client.envoyer(racine.id, "Fais relire le dossier complet.", ia);
  exiger(envoi.code === 204, `envoi refusé (${envoi.code}) : ${resume(envoi.corps)}`);
  await attendreDemandes(client, demandeDeDelegation(racine.id, DESCRIPTION), { libelle: "délégation en attente" });
  await cliquerBouton(page, PHRASES.autoriser, { portee: ".interactions" });
  await attendreFinDuTour(client, racine.id, { delaiMs: 120_000 });
  // Le classement automatique tombe 4 s après le repos : la page est laissée calme avant les captures.
  await attendre(ARCHIVAGE_MS);
  return racine.id;
}

/**
 * Identifiant de l'assistant à montrer au zoom 3 : le zoom 2 est ouvert une fois, sa liste (la vérité, P7) donne le premier
 * assistant, et l'adresse de la salle le porte ensuite, sans nouveau clic à chaque passe.
 */
async function trouverAssistant(page, rootId, attendue3d) {
  await ouvrirSalle(page, rootId);
  if (attendue3d) await attendreScene3d(page);
  await page.attendreQue("document.querySelector('.zoom-conv-liste button')", { libelle: "liste des assistants du zoom 2" });
  await page.evaluer("document.querySelector('.zoom-conv-liste button').click()");
  await page.attendreQue("document.querySelector('.page.salle3d .zoom-conv-panneau')", { libelle: "panneau du zoom 3" });
  const adresse = String(await page.evaluer("location.hash"));
  const sessionId = adresse.split("/").pop() ?? "";
  exiger(sessionId.length > 0 && adresse.includes(rootId), `adresse du zoom 3 inattendue : ${resume(adresse)}`);
  await fermerSalle(page);
  return sessionId;
}
