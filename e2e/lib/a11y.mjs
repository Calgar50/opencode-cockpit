// Propriétaire : L50a (itération 5).
// Banc de captures d'accessibilité : émulation des réglages système, captures des trois modes, animations en cours et
// focus visible (spécification §5.5, §5.6, §7.11 n° 4 ; conception C §17.3 n° 8, §17.4 ; plan d'exécution it5 §2.8).
//
// Trois modes capturés, parce que ce sont les trois qui changent le dessin :
//   1. normal ;
//   2. contraste forcé (`forced-colors: active`, mode contrasté de Windows) : les couleurs du thème sont remplacées par
//      celles du système, et ce qui n'était dit que par la couleur disparaît ;
//   3. niveaux de gris et mouvement réduit (`prefers-reduced-motion: reduce` + achromatopsie) : ce qui n'était dit que par
//      la couleur disparaît aussi, et toute animation doit s'arrêter.
// Chacun dans les deux thèmes et aux trois tailles de `cdp.mjs` (1440, 1024, 400) : 18 captures par vue.
//
// `e2e/lib/cdp.mjs` N'EST JAMAIS ÉCRIT par la construction (§2.8) : l'it4 (L41) en est le seul propriétaire pour
// l'émulation de média. L'émulation passe donc par l'ENVOI BRUT que `cdp.mjs` expose déjà
// (`navigateur.client.envoyer(methode, params, onglet.sessionId)`), et la partie MÉDIA est isolée dans une seule
// fonction locale (`emulerMedias`), que FE4 remplacera en 5b par `onglet.medias` de l'it4 : une seule aide par commande
// CDP. `Emulation.setEmulatedVisionDeficiency` reste ici.
//
// Le contexte d'un scénario ne porte que l'ONGLET (`ctx.navigateur` = l'onglet, docker-e2e.mjs) : l'objet navigateur,
// seul à tenir la prise CDP, n'y est pas. Un scénario qui émule ouvre donc son propre navigateur avec
// `ouvrirNavigateurEpingle` — même épinglage, même isolation, jamais de vérification TLS coupée — plutôt que de faire
// écrire `cdp.mjs` ou `docker-e2e.mjs` par la construction.
import path from "node:path";
import { ouvrirNavigateur, TAILLES, THEMES } from "./cdp.mjs";
import { connecterNavigateur } from "./cockpit.mjs";

const attendre = (ms) => new Promise((r) => setTimeout(r, ms));

/** Les trois modes capturés (§5.5, §7.11 n° 4). `nom` entre dans le nom du fichier de capture. */
export const MODES_A11Y = Object.freeze([
  Object.freeze({ nom: "normal", forcedColors: false, reducedMotion: false, grayscale: false }),
  Object.freeze({ nom: "contraste-force", forcedColors: true, reducedMotion: false, grayscale: false }),
  Object.freeze({ nom: "gris-mouvement-reduit", forcedColors: false, reducedMotion: true, grayscale: true }),
]);

/**
 * Partie MÉDIA de l'émulation, ISOLÉE ICI : `prefers-color-scheme`, `forced-colors` et `prefers-reduced-motion` dans un
 * MÊME appel (`Emulation.setEmulatedMedia` remplace toute la liste : trois appels séparés n'en laisseraient qu'un).
 * FE4 remplace le corps de cette fonction par `onglet.medias(features)` de l'it4 (L41), sans toucher aux appelants.
 */
async function emulerMedias(navigateur, onglet, { theme, forcedColors, reducedMotion }) {
  await navigateur.client.envoyer(
    "Emulation.setEmulatedMedia",
    {
      features: [
        { name: "prefers-color-scheme", value: theme === "sombre" ? "dark" : "light" },
        { name: "forced-colors", value: forcedColors ? "active" : "none" },
        { name: "prefers-reduced-motion", value: reducedMotion ? "reduce" : "no-preference" },
      ],
    },
    onglet.sessionId,
  );
}

/**
 * Réglages système émulés pour un onglet : thème, contraste forcé, mouvement réduit et vision des couleurs.
 * `grayscale` passe par `Emulation.setEmulatedVisionDeficiency` (« achromatopsia »), qui n'est pas un réglage de média :
 * c'est la vue d'une personne qui ne distingue pas les couleurs, et ce qui n'était dit que par elles y disparaît.
 */
export async function emuler(navigateur, onglet, { theme = "clair", forcedColors = false, reducedMotion = false, grayscale = false } = {}) {
  await emulerMedias(navigateur, onglet, { theme, forcedColors, reducedMotion });
  await navigateur.client.envoyer("Emulation.setEmulatedVisionDeficiency", { type: grayscale ? "achromatopsia" : "none" }, onglet.sessionId);
}

/** Rétablit l'affichage ordinaire : aucun réglage émulé, aucune taille forcée. */
export async function rendreLAffichage(navigateur, onglet) {
  await emuler(navigateur, onglet, {});
  await navigateur.client.envoyer("Emulation.clearDeviceMetricsOverride", {}, onglet.sessionId);
}

/** Borne sous laquelle ChatPage ferme le panneau « Contexte » de lui-même (`ASIDE_OVERLAY_QUERY`, ChatPage.tsx). */
export const BORNE_PANNEAU = 1280;

/**
 * Absorbe la course du redimensionnement. `onglet.taille(...)` rend la main avant que la page ait reçu son événement
 * `matchMedia` : en passant sous 1280 px, le panneau « Contexte » se ferme DE LUI-MÊME, mais un peu plus tard. Sans cette
 * attente, le panneau paraît encore ouvert, la vue qu'il porte est rouverte puis démontée juste après, et la capture montre
 * une conversation SANS panneau. La fermeture n'est attendue qu'au franchissement de la borne VERS LE BAS : au-dessous d'elle,
 * aucun événement n'arrive et rien ne se referme. Même motif qu'à l'itération 1 (`panneauSelonLaTaille`, it1-ui-mise-en-page) ;
 * exporté ici pour que les scénarios de la construction s'en servent tous plutôt que d'en garder chacun une copie.
 */
export function suiviDeLargeur(largeurDeDepart) {
  let precedente = largeurDeDepart;
  return async function apresLaTaille(onglet, largeur) {
    const descend = precedente > BORNE_PANNEAU && largeur <= BORNE_PANNEAU;
    precedente = largeur;
    if (!descend) return;
    await onglet.attendreQue("document.querySelector('.chat')?.classList.contains('aside-open') !== true", {
      libelle: `panneau « Contexte » fermé de lui-même à ${largeur} px`,
    });
  };
}

/**
 * Banc de captures d'une vue : 3 modes × 2 thèmes × 3 tailles = 18 fichiers
 * `<prefixe>-<mode>-<taille>-<theme>.png`. `avant({ mode, theme, taille })` est appelé après chaque changement, pour
 * les vues qu'il faut rouvrir (un popover que le redimensionnement referme, par exemple) ; `apres({ mode, theme, taille })`
 * est appelé JUSTE AVANT chaque capture, pour exiger que la vue attendue y soit vraiment — le nombre de fichiers écrits ne
 * dit rien de leur contenu. Rend les chemins écrits.
 *
 * La course du redimensionnement est absorbée ici, entre le changement de taille et `avant` : la boucle franchit la borne des
 * 1280 px vers le bas à chacun des six couples mode × thème, et c'est le seul endroit qui connaisse la taille demandée.
 * Mesuré : l'aller-retour CDP d'`emuler` suffit aujourd'hui à laisser passer l'événement `matchMedia` (six passages à 1024 px,
 * panneau toujours vu refermé). L'attente rend cette absorption EXPLICITE au lieu de dépendre de cet aller-retour, qu'un
 * remaniement (FE4) pourrait déplacer ; elle rend la main tout de suite quand le panneau est déjà refermé.
 */
export async function captureAccessibilite(navigateur, onglet, prefixe, { avant = null, apres = null, poseMs = 150, largeurDeDepart = 1440 } = {}) {
  const faites = [];
  const apresLaTaille = suiviDeLargeur(largeurDeDepart);
  for (const mode of MODES_A11Y) {
    for (const theme of THEMES) {
      for (const taille of TAILLES) {
        await onglet.taille(taille);
        await apresLaTaille(onglet, taille.largeur);
        await emuler(navigateur, onglet, { theme, ...mode });
        if (avant) await avant({ mode, theme, taille });
        // La mise en page et les transitions se posent avant la capture (même pause que `captureSuite`).
        await attendre(poseMs);
        if (apres) await apres({ mode, theme, taille });
        faites.push(await onglet.capture(`${prefixe}-${mode.nom}-${taille.nom}-${theme}.png`));
      }
    }
  }
  await rendreLAffichage(navigateur, onglet);
  return faites;
}

/**
 * Durée à partir de laquelle une animation est un MOUVEMENT que l'on voit. Sous `prefers-reduced-motion: reduce`, la règle
 * globale de styles.css ramène toute animation et toute transition CSS à 0,01 ms : chaque changement de style crée alors
 * une transition CSS instantanée (mesuré : une centaine dans la carte pendant un tour), qui n'est pas un mouvement et qui
 * prouve au contraire que la règle s'applique. Ce qui reste au-dessus de ce seuil ne peut venir que d'une animation qui a
 * échappé au réglage — la transition WAAPI de la carte (900 ms), si sa garde tombait.
 */
export const DUREE_PERCEPTIBLE_MS = 100;

/**
 * Nombre d'animations EN COURS (`document.getAnimations()`, état « running ») : dans toute la page ou, avec `dans` (un
 * sélecteur), seulement celles dont la cible est dans cet élément ; avec `dureeMinMs`, seulement celles d'au moins cette
 * durée. Les animations finies ou en pause ne comptent pas — seul ce qui bouge encore compte.
 *
 * `dans` et `dureeMinMs` servent au relevé DISCRIMINANT du mouvement réduit : la seule animation que le réglage commande
 * est la transition WAAPI de la carte de la bande néon (`.neon-map`, NeonBand.tsx : `mouvementPermis()`, environ 900 ms,
 * une par signe apparu ou changé). Les boucles CSS de la page (`.dot.pulse`, `.spinner`) ne sont pas un témoin : la règle
 * globale de styles.css les raccourcit à 0,01 ms sous `prefers-reduced-motion: reduce` sans les arrêter, elles restent
 * « running » ; et les transitions CSS de 0,01 ms que cette règle crée dans la carte ne sont pas un mouvement (voir
 * `DUREE_PERCEPTIBLE_MS`).
 */
export async function animationsActives(onglet, { dans = null, dureeMinMs = 0 } = {}) {
  const cibleDans =
    dans === null
      ? "true"
      : `(a.effect && a.effect.target && typeof a.effect.target.closest === "function" && a.effect.target.closest(${JSON.stringify(dans)}) !== null)`;
  const assezLongue =
    dureeMinMs > 0 ? `(a.effect && typeof a.effect.getTiming().duration === "number" && a.effect.getTiming().duration >= ${dureeMinMs})` : "true";
  return await onglet.evaluer(`document.getAnimations().filter((a) => a.playState === 'running' && ${cibleDans} && ${assezLongue}).length`);
}

/**
 * Réglages système tels que la PAGE les voit (`matchMedia`) : à exiger avant un relevé qui dépend de l'émulation, pour
 * qu'un relevé nul ne puisse pas venir d'un réglage qui n'est pas arrivé jusqu'à la page.
 */
export async function mediasDeLaPage(onglet) {
  return await onglet.evaluer(`({
    mouvementReduit: matchMedia("(prefers-reduced-motion: reduce)").matches,
    contrasteForce: matchMedia("(forced-colors: active)").matches,
    sombre: matchMedia("(prefers-color-scheme: dark)").matches,
  })`);
}

/**
 * Focus visible sur `selecteur` : l'élément prend le focus et son anneau est DESSINÉ. Une touche est frappée d'abord
 * (Tab), parce que Chromium ne rend `:focus-visible` qu'après une interaction au clavier ; le focus est ensuite posé
 * sur l'élément voulu. Rend le détail relevé.
 *
 * `visible` exige un contour réellement dessiné (`outline-style` ≠ none ET largeur > 0 ; le test porte sur le style, parce
 * que Chromium rapporte une `outline-width` de 3 px même quand le style est `none` ; `auto` compte comme dessiné) ou, HORS
 * contraste forcé, une ombre (`box-shadow`) non nulle. `:focus-visible` seul ne suffit pas : la pseudo-classe dit que le
 * navigateur VOUDRAIT montrer le focus, pas qu'un style le dessine — un `outline: none` posé dessus la laisse vraie sans rien
 * à l'écran, et c'est ce défaut que l'assertion doit attraper. En contraste forcé, le système remplace les couleurs et
 * neutralise les ombres, mais il ne redessine pas un contour qu'un style a retiré : l'ombre n'y compte donc pas. `pseudo`
 * reste dans le relevé, en information.
 */
export async function focusVisible(onglet, selecteur) {
  await onglet.touche("Tab");
  return await onglet.evaluer(`(() => {
    const el = document.querySelector(${JSON.stringify(selecteur)});
    const contrasteForce = matchMedia("(forced-colors: active)").matches;
    if (!el) return { trouve: false, focus: false, pseudo: false, contour: "", largeur: 0, ombre: "none", contrasteForce, visible: false };
    el.focus({ preventScroll: true });
    const style = getComputedStyle(el);
    const largeur = Number.parseFloat(style.outlineWidth) || 0;
    const pseudo = el.matches(":focus-visible");
    const contourDessine = style.outlineStyle !== "none" && largeur > 0;
    const ombre = style.boxShadow || "none";
    const ombreDessinee = !contrasteForce && ombre !== "none";
    return {
      trouve: true,
      focus: document.activeElement === el,
      pseudo,
      contour: style.outlineStyle,
      largeur,
      couleur: style.outlineColor,
      ombre: ombre.slice(0, 80),
      contrasteForce,
      visible: document.activeElement === el && (contourDessine || ombreDessinee),
    };
  })()`);
}

/**
 * Navigateur propre au scénario, avec le MÊME épinglage que le banc (clé publique du volume de la pile jetable) et la
 * session déjà ouverte dans l'onglet, par le cookie du client d'API : le jeton n'entre jamais dans le navigateur.
 * À fermer par `navigateur.fermer()` dans un `finally` — le profil temporaire part avec lui.
 */
export async function ouvrirNavigateurEpingle(ctx, nom = "a11y") {
  const navigateur = await ouvrirNavigateur({
    dossierProfil: path.join(ctx.dossierCaptures, `profil-${nom}`),
    spkiEpingle: ctx.epinglage?.spki ?? null,
  });
  try {
    const onglet = await navigateur.nouvelOnglet();
    await connecterNavigateur(onglet, ctx.url, ctx.api.cookie);
    return { navigateur, onglet };
  } catch (err) {
    await navigateur.fermer().catch(() => {});
    throw err;
  }
}
