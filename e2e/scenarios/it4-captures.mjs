// Scénario e2e des équipes (itération 4, L41) : captures de toutes les vues neuves, et accessibilité mesurée.
//
// Spécification §5.5 (accessibilité), §5.6 l.928 (400 px), P7 l.42 (clavier, lecteur d'écran, forced-colors, mouvement
// réduit, 400 px), §7.8 l.1189 (« zéro erreur console »). Ce que le scénario fait, dans la vraie pile :
//   1. CAPTURES à 1440, 1024 et 400 px, en thème clair ET sombre, de chaque vue neuve : onglet Équipes (vide puis avec la
//      galerie), éditeur guidé (ses 4 écrans), feuille de lancement, carte d'exécution, carte de pause, demande injectée,
//      résultat, tiroir [Voir son travail] d'une étape, carte des assistants (Centrée et Liste) ;
//   2. CONTRASTE FORCÉ ÉMULÉ (`Emulation.setEmulatedMedia`, `forced-colors: active`, par la méthode `medias` de
//      e2e/lib/cdp.mjs) pour la feuille, la carte d'exécution en pause, le Déroulé, l'éditeur et la carte des assistants :
//      la vue reste visible, ses icônes et ses connecteurs sont dessinés, et le focus garde un contour ;
//   3. MOUVEMENT RÉDUIT (`prefers-reduced-motion: reduce`) : aucune animation ne tourne dans les vues capturées, et
//      aucune n'est infinie ;
//   4. TRANSCRIPTION : la demande injectée est une bulle « Vous » avec sa puce « Envoyé à l'équipe », sans marqueur ni
//      encadrement ; le résultat n'apparaît qu'UNE FOIS, sans marqueur ; la consigne du tiroir porte sa puce, sans
//      marqueur ;
//   5. CLAVIER SEUL : la feuille de lancement s'ouvre, se parcourt et se ferme au clavier (focus rendu au lanceur), et
//      l'éditeur guidé passe d'un écran à l'autre au clavier ;
//   6. ZÉRO ERREUR DE CONSOLE sur tout le parcours.
// En « --reel-hors-ligne », les étapes ne sont pas scriptables : le scénario le dit et ne joue rien.
import path from "node:path";
import { attendre, exiger, nonJoue, releve, resume } from "./it1-api-commun.mjs";
import { LARGE, preparerPage } from "./it1-ui-commun.mjs";
import { attendreRun, DEMANDE, enAvance, equipeDerivee, equipes, estimerEtLancer, etapesDuFlow, ouvrirLaConversation, quitterEditeur, scripterEtape } from "./it4-commun.mjs";

/** Tailles et thèmes des captures (spéc. §5.6 : 400 px pour chaque vue neuve). */
const TAILLES = [
  { nom: "1440", largeur: 1440, hauteur: 900 },
  { nom: "1024", largeur: 1024, hauteur: 768 },
  { nom: "400", largeur: 400, hauteur: 860 },
];
const THEMES = ["clair", "sombre"];

/** Pas d'une étape assez longue pour capturer la carte d'exécution pendant qu'elle travaille. */
const PAS_LONG_MS = 6_000;
/** Marqueur que le cockpit pose dans les textes injectés et que la page ne montre jamais. */
const MARQUEUR = /<!--\s*cockpit:/;

const fichier = (ctx, nom, taille, theme) => path.join(ctx.dossierCaptures, `${ctx.nom.replace(/\.mjs$/, "")}-${nom}-${taille}-${theme}.png`);

/** Les six captures d'une vue (trois largeurs, deux thèmes), sans émulation autre que le thème. */
async function capturer(ctx, nom, { avant = null } = {}) {
  const page = ctx.navigateur;
  const faites = [];
  for (const theme of THEMES) {
    await page.medias({ theme });
    for (const taille of TAILLES) {
      await page.taille(taille);
      if (avant) await avant({ theme, taille });
      await attendre(180);
      faites.push(await page.capture(fichier(ctx, nom, taille.nom, theme)));
    }
  }
  await page.taille(LARGE);
  await page.medias({});
  exiger(faites.length === 6, `6 captures attendues pour « ${nom} », ${faites.length} faites.`);
  return faites;
}

/**
 * Relevé d'une vue sous contraste forcé : la requête de média est bien active, la vue est visible, ses icônes et ses
 * connecteurs sont dessinés, le focus garde un contour, et aucune animation ne tourne.
 */
const SONDE = (selecteur) => `(() => {
  const vue = document.querySelector(${JSON.stringify(selecteur)});
  const visible = (e) => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
  const focusable = vue ? [...vue.querySelectorAll('button, a[href], input, select, textarea, [tabindex]:not([tabindex="-1"])')].filter(visible)[0] ?? null : null;
  if (focusable) focusable.focus();
  const contour = focusable ? getComputedStyle(focusable) : null;
  const motifs = vue ? [...vue.querySelectorAll("*")].filter((e) => /repeating-linear-gradient|repeating-conic-gradient/.test(getComputedStyle(e).backgroundImage)).length : 0;
  const pointilles = vue ? [...vue.querySelectorAll("*")].filter((e) => { const s = getComputedStyle(e); return ["dashed", "dotted"].includes(s.borderTopStyle) || ["dashed", "dotted"].includes(s.outlineStyle); }).length : 0;
  const animations = document.getAnimations().map((a) => {
    const cible = a.effect && a.effect.target ? a.effect.target : null;
    return {
      genre: a.constructor?.name ?? "Animation",
      etat: a.playState,
      duree: a.effect?.getTiming?.().duration ?? 0,
      iterations: a.effect?.getTiming?.().iterations ?? 1,
      propriete: a.transitionProperty ?? a.animationName ?? "",
      classe: cible ? String((typeof cible.className === "string" ? cible.className : cible.getAttribute("class")) ?? cible.tagName) : "?",
    };
  });
  return {
    force: window.matchMedia("(forced-colors: active)").matches,
    reduit: window.matchMedia("(prefers-reduced-motion: reduce)").matches,
    presente: Boolean(vue) && visible(vue),
    icones: vue ? [...vue.querySelectorAll("svg")].filter(visible).length : 0,
    traits: vue ? [...vue.querySelectorAll("svg line, svg path, svg polyline")].length : 0,
    motifs,
    pointilles,
    focus: contour === null ? null : { style: contour.outlineStyle, largeur: contour.outlineWidth, ombre: contour.boxShadow !== "none" },
    // Mouvement réduit (§5.5) : ce sont les ANIMATIONS qui doivent se taire. Une transition CSS suit un changement de mise en
    // page (ici la largeur de la fenêtre, changée par le banc lui-même) : elle est relevée à part, jamais comptée comme faute.
    animations: animations.filter((a) => a.etat === "running" && Number(a.duree) > 0 && a.genre !== "CSSTransition"),
    transitions: animations.filter((a) => a.etat === "running" && a.genre === "CSSTransition").map((a) => a.propriete),
    infinies: animations.filter((a) => a.iterations === null || a.iterations > 1000),
  };
})()`;

/**
 * Capture une vue en CONTRASTE FORCÉ émulé et en mouvement réduit, dans les trois largeurs et les deux thèmes, et exige
 * que la vue reste lisible : requête de média active, vue visible, icônes dessinées, focus avec un contour, aucune
 * animation en cours, aucune animation infinie. `traits` : la vue porte un schéma, donc des connecteurs.
 */
async function capturerContrasteForce(ctx, nom, selecteur, { traits = false, icones = true } = {}) {
  const page = ctx.navigateur;
  const releves = [];
  for (const theme of THEMES) {
    for (const taille of TAILLES) {
      await page.medias({ forcedColors: "active", reducedMotion: "reduce", theme });
      await page.taille(taille);
      await attendre(400);
      const sonde = await page.evaluer(SONDE(selecteur));
      const ou = `${nom}, ${taille.nom}, ${theme}`;
      exiger(sonde.force === true, `${ou} : « forced-colors: active » n'est pas émulé.`);
      exiger(sonde.reduit === true, `${ou} : « prefers-reduced-motion: reduce » n'est pas émulé.`);
      exiger(sonde.presente === true, `${ou} : la vue « ${selecteur} » n'est pas visible en contraste forcé.`);
      // À 400 px, une vue à schéma passe en LISTE seule (§5.6) : le dessin, donc ses icônes, disparaît par construction.
      const attendIcones = icones === true || (icones === "au-large" && taille.largeur > 400);
      if (attendIcones) exiger(sonde.icones > 0, `${ou} : aucune icône dessinée en contraste forcé.`);
      if (traits && taille.largeur > 400) exiger(sonde.traits > 0, `${ou} : aucun connecteur dessiné en contraste forcé.`);
      // Un état porté par la seule couleur disparaît en contraste forcé : la vue garde au moins un signe de forme.
      exiger(
        sonde.icones + sonde.traits + sonde.motifs + sonde.pointilles > 0,
        `${ou} : aucun signe de forme (icône, connecteur, hachure, pointillé) en contraste forcé.`,
      );
      if (sonde.focus !== null) {
        const visible = sonde.focus.style !== "none" || sonde.focus.ombre || Number.parseFloat(sonde.focus.largeur) > 0;
        exiger(visible, `${ou} : le focus n'a plus de contour en contraste forcé (${resume(sonde.focus)}).`);
      }
      exiger(sonde.animations.length === 0, `${ou} : ${sonde.animations.length} animation(s) en cours malgré le mouvement réduit : ${resume(sonde.animations, 400)}`);
      exiger(sonde.infinies.length === 0, `${ou} : ${sonde.infinies.length} animation(s) infinie(s) : ${resume(sonde.infinies, 400)}`);
      releves.push({ taille: taille.nom, theme, icones: sonde.icones, traits: sonde.traits, motifs: sonde.motifs, pointilles: sonde.pointilles, transitions: sonde.transitions.length });
      await page.capture(fichier(ctx, `${nom}-contraste-force`, taille.nom, theme));
    }
  }
  await page.taille(LARGE);
  await page.medias({});
  releve(ctx, `contraste forcé, ${nom} : ${resume(releves, 500)}`);
}

/** Tape un texte dans la saisie du chat, au clavier (jamais une affectation de valeur : React ne la verrait pas). */
async function ecrireDansLaSaisie(page, texte) {
  await page.evaluer('document.querySelector(".composer textarea").focus()');
  await page.taper(texte);
  await page.attendreQue(`document.querySelector(".composer textarea").value.length > 0`, { libelle: "demande écrite dans la saisie" });
}

/** Ouvre la feuille de lancement AU CLAVIER SEUL depuis le lanceur, et rend le libellé du bouton du lanceur. */
async function ouvrirLaFeuilleAuClavier(page) {
  await page.attendreQue('document.querySelector(".team-launcher button")', { libelle: "lanceur d'équipe" });
  await page.evaluer('document.querySelector(".team-launcher button").focus()');
  const lanceur = await page.focus();
  exiger(lanceur.startsWith("button:"), `le lanceur n'a pas pris le focus (« ${lanceur} »).`);
  await page.touche("ArrowDown");
  await page.attendreQue('document.querySelector(".team-launcher-menu")', { libelle: "menu du lanceur ouvert au clavier" });
  await page.attendreQue('document.activeElement?.getAttribute("role") === "menuitem"', { libelle: "focus sur un élément du menu" });
  await page.touche("Enter");
  await page.attendreQue('document.querySelector(".team-sheet")', { delaiMs: 20_000, libelle: "feuille de lancement ouverte au clavier" });
  return lanceur;
}

export async function run(ctx) {
  if (ctx.mode !== "faux") {
    nonJoue(ctx, "captures des vues d'équipe", "le faux fournisseur ne rend que du texte : les étapes d'une équipe n'y sont pas scriptables");
    ctx.expectNoConsoleErrors();
    return;
  }
  const page = await preparerPage(ctx);

  await enAvance(ctx, async () => {
    const api = equipes(ctx);

    // --- 1. Onglet Équipes : état vide, puis galerie -----------------------------------------------------------------------
    const avant = await api.liste();
    for (const equipe of avant.teams) {
      const retrait = await ctx.api.brut("DELETE", `/api/teams/${encodeURIComponent(equipe.id)}`);
      exiger([204, 409].includes(retrait.code), `suppression de « ${equipe.id} » : ${retrait.code} ${resume(retrait.corps)}`);
    }
    await page.evaluer('location.hash = "#/assistants/equipes"');
    await page.attendreQue('document.querySelector(".tm-onglet")', { libelle: "onglet Équipes" });
    const vide = await page.evaluer('Boolean(document.querySelector(".tm-vide"))');
    await capturer(ctx, "equipes-vide");
    releve(ctx, `onglet Équipes : état vide ${vide ? "capturé" : "non atteint (une équipe résiste à la suppression)"}`);

    // --- 2. Éditeur guidé, ses quatre écrans -------------------------------------------------------------------------------
    await page.evaluer('location.hash = "#/assistants/equipes/nouvelle"');
    await page.attendreQue('document.querySelector(".tm-ed-progression")', { libelle: "éditeur guidé, écran 1" });
    await capturer(ctx, "editeur-1");

    // Écran 1 : partir d'un exemple, puis passer d'un écran à l'autre AU CLAVIER SEUL.
    await page.evaluer('document.querySelector(".tm-ed-choix-bouton").click()');
    await page.attendreQue('document.querySelector(".tm-ed-etapes")', { libelle: "éditeur guidé, écran 2 (les étapes)" });
    await capturer(ctx, "editeur-2");
    // Contraste forcé sur l'écran des étapes : c'est là que l'éditeur dessine le schéma et ses connecteurs.
    await capturerContrasteForce(ctx, "editeur", ".tm-ed", { icones: "au-large" });
    for (const [ecran, marque] of [
      [3, ".tm-ed-cout"],
      [4, ".tm-ed-verifier"],
    ]) {
      await page.evaluer(`(() => {
        const bouton = [...document.querySelectorAll(".tm-ed-pied button")].find((b) => b.textContent.trim() === "Suivant");
        if (bouton) bouton.focus();
      })()`);
      const focus = await page.focus();
      exiger(focus.includes("Suivant"), `le bouton [Suivant] de l'éditeur ne prend pas le focus (« ${focus} »).`);
      await page.touche("Enter");
      await page.attendreQue(`document.querySelector(${JSON.stringify(marque)})`, { libelle: `éditeur guidé, écran ${ecran} (au clavier)` });
      await capturer(ctx, `editeur-${ecran}`);
    }
    releve(ctx, "éditeur guidé : 4 écrans capturés, passage d'un écran à l'autre au clavier seul");

    // --- 3. Carte des assistants : Centrée et Liste ------------------------------------------------------------------------
    const equipeAvis = await equipeDerivee(api, "revue-sql", "c");
    await quitterEditeur(ctx, "#/assistants/carte");
    await page.attendreQue('document.querySelector(".ca-vues")', { libelle: "carte des assistants" });
    await capturer(ctx, "carte-centree");
    await capturerContrasteForce(ctx, "carte", ".ca-onglet", { traits: true, icones: "au-large" });
    await page.evaluer(`(() => {
      const bouton = [...document.querySelectorAll(".ca-vues-choix button")].find((b) => b.textContent.trim() === "Liste");
      if (bouton) bouton.click();
    })()`);
    await page.attendreQue('document.querySelector(".ca-vues.vue-liste")', { libelle: "vue Liste de la carte" });
    await capturer(ctx, "carte-liste");

    // L'onglet Équipes, une équipe installée : la galerie des exemples est sous la liste.
    await page.evaluer('location.hash = "#/assistants/equipes"');
    await page.attendreQue('document.querySelector(".tm-equipes")', { libelle: "onglet Équipes avec une équipe installée" });
    await capturer(ctx, "equipes-galerie");

    // --- 4. Feuille de lancement (clavier, contraste forcé) ----------------------------------------------------------------
    for (const stepId of etapesDuFlow(equipeAvis.flow)) {
      await scripterEtape(ctx, stepId, { text: `Avis « ${stepId} » rendu.`, cost: 0.01, tokens: { input: 90, output: 20 }, stepMs: PAS_LONG_MS });
    }
    await page.evaluer('location.hash = "#/chat"');
    await page.attendreQue('document.querySelector(".composer textarea")', { libelle: "saisie du chat" });
    await ecrireDansLaSaisie(page, DEMANDE);
    const lanceur = await ouvrirLaFeuilleAuClavier(page);
    await capturer(ctx, "feuille-lancement");
    await capturerContrasteForce(ctx, "feuille", ".team-sheet");

    // Clavier : le focus reste dans la feuille, puis Échap la ferme et le rend au lanceur (§5.5, aucun focus volé).
    let dedans = 0;
    for (let pas = 0; pas < 12; pas++) {
      await page.touche("Tab");
      if (await page.evaluer('Boolean(document.activeElement?.closest(".modal, .team-sheet"))')) dedans++;
    }
    exiger(dedans > 0, "le focus ne se pose jamais dans la feuille de lancement au clavier.");
    await page.touche("Escape");
    await page.attendreQue('!document.querySelector(".team-sheet")', { libelle: "feuille fermée par Échap" });
    const rendu = await page.focus();
    exiger(rendu === lanceur, `le focus n'est pas rendu au lanceur après la fermeture (« ${rendu} » au lieu de « ${lanceur} »).`);
    releve(ctx, `feuille de lancement : ouverte, parcourue (${dedans}/12 tabulations dedans) et fermée au clavier seul`);

    // --- 5. Carte d'exécution, puis transcription (demande injectée, résultat, tiroir) --------------------------------------
    const { runId, rootId } = await estimerEtLancer(api, equipeAvis.id);
    await ouvrirLaConversation(ctx, rootId);
    await page.attendreQue('document.querySelector(".team-run")', { delaiMs: 20_000, libelle: "carte d'exécution de l'équipe" });
    await capturer(ctx, "carte-execution");
    await page.attendreQue('document.querySelector(".team-deroule")', { delaiMs: 20_000, libelle: "Déroulé de l'équipe" });
    await capturerContrasteForce(ctx, "deroule", ".team-deroule", { traits: true, icones: "au-large" });

    const finie = await attendreRun(api, runId, (vue) => vue.state === "terminee", "équipe des captures terminée");
    await page.attendreQue('document.querySelector(".team-result")', { delaiMs: 20_000, libelle: "carte de résultat" });
    await capturer(ctx, "resultat");

    const transcription = await page.evaluer(`(() => {
      const bulles = [...document.querySelectorAll(".user-msg")].map((b) => b.textContent.trim());
      return {
        cartes: document.querySelectorAll(".team-result").length,
        bulles,
        fil: document.querySelector(".chat-thread")?.textContent ?? "",
      };
    })()`);
    exiger(transcription.cartes === 1, `${transcription.cartes} carte(s) de résultat : le résultat doit n'apparaître qu'une fois.`);
    const bulle = transcription.bulles.find((texte) => texte.includes(DEMANDE));
    exiger(bulle !== undefined, `la demande injectée n'est pas une bulle « Vous » : ${resume(transcription.bulles)}`);
    exiger(bulle.includes("Envoyé à l'équipe"), `la bulle de la demande n'a pas sa puce : ${resume(bulle)}`);
    exiger(!bulle.includes("<<<") && !bulle.includes("‹‹‹"), "la demande injectée est encadrée dans la bulle.");
    exiger(!MARQUEUR.test(transcription.fil), "un marqueur « <!-- cockpit: » est visible dans la conversation.");
    await capturer(ctx, "demande-injectee");

    // Tiroir [Voir son travail] d'une étape : la consigne porte sa puce, sans marqueur.
    await page.evaluer(`(() => {
      const bouton = [...document.querySelectorAll(".team-run button")].find((b) => b.textContent.trim() === "Voir son travail");
      if (bouton) bouton.click();
    })()`);
    await page.attendreQue('document.querySelector(".drawer")', { libelle: "tiroir [Voir son travail] d'une étape" });
    await page.attendreQue('document.querySelector(".drawer .reasoning summary")', { delaiMs: 20_000, libelle: "consigne repliée du tiroir" });
    const tiroir = await page.texte(".drawer");
    exiger(tiroir.includes("Consigne envoyée par le cockpit à l'étape"), `le tiroir n'affiche pas la puce de la consigne : ${resume(tiroir, 300)}`);
    exiger(!MARQUEUR.test(tiroir), "un marqueur « <!-- cockpit: » est visible dans le tiroir d'une étape.");
    await capturer(ctx, "tiroir-etape");
    await page.touche("Escape");
    await page.evaluer('document.querySelector(".drawer-backdrop") && document.querySelector(".drawer-backdrop").dispatchEvent(new MouseEvent("mousedown", { bubbles: true }))');
    exiger(finie.steps.length > 0, "l'équipe des captures n'a aucune étape.");

    // --- 6. Carte de pause, et carte d'exécution en pause sous contraste forcé ---------------------------------------------
    const suite = await equipeDerivee(api, "relecture-script", "c");
    for (const stepId of etapesDuFlow(suite.flow)) {
      await scripterEtape(ctx, stepId, { text: "Relecture faite.", cost: 0.01, tokens: { input: 90, output: 20 }, stepMs: 5 });
    }
    const pause = await estimerEtLancer(api, suite.id);
    await attendreRun(api, pause.runId, (vue) => vue.state === "attente-verification", "équipe des captures en pause");
    await ouvrirLaConversation(ctx, pause.rootId);
    await page.attendreQue('document.querySelector(".team-pause")', { delaiMs: 20_000, libelle: "carte de pause" });
    await capturer(ctx, "pause");
    await capturerContrasteForce(ctx, "carte-execution-en-pause", ".team-card");
    const arret = await api.arreterBrut(pause.runId);
    exiger([200, 409].includes(arret.code), `arrêt du lancement en pause refusé (${arret.code}) : ${resume(arret.corps)}`);

    releve(ctx, `captures : ${TAILLES.map((t) => t.nom).join(", ")} px, thèmes ${THEMES.join(" et ")}, dossier ${ctx.dossierCaptures}`);
  });

  // 7. Zéro erreur de console sur tout le parcours.
  ctx.expectNoConsoleErrors();
}
