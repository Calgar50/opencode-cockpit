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

/**
 * Banc de captures d'une vue : 3 modes × 2 thèmes × 3 tailles = 18 fichiers
 * `<prefixe>-<mode>-<taille>-<theme>.png`. `avant({ mode, theme, taille })` est appelé après chaque changement, pour
 * les vues qu'il faut rouvrir (un popover que le redimensionnement referme, par exemple). Rend les chemins écrits.
 */
export async function captureAccessibilite(navigateur, onglet, prefixe, { avant = null, poseMs = 150 } = {}) {
  const faites = [];
  for (const mode of MODES_A11Y) {
    for (const theme of THEMES) {
      for (const taille of TAILLES) {
        await onglet.taille(taille);
        await emuler(navigateur, onglet, { theme, ...mode });
        if (avant) await avant({ mode, theme, taille });
        // La mise en page et les transitions se posent avant la capture (même pause que `captureSuite`).
        await attendre(poseMs);
        faites.push(await onglet.capture(`${prefixe}-${mode.nom}-${taille.nom}-${theme}.png`));
      }
    }
  }
  await rendreLAffichage(navigateur, onglet);
  return faites;
}

/**
 * Nombre d'animations EN COURS dans la page (`document.getAnimations()`, état « running ») : en mouvement réduit, il
 * doit être nul. Les animations finies ou en pause ne comptent pas — seul ce qui bouge encore compte.
 */
export async function animationsActives(onglet) {
  return await onglet.evaluer("document.getAnimations().filter((a) => a.playState === 'running').length");
}

/**
 * Focus visible sur `selecteur` : l'élément prend le focus et son anneau est DESSINÉ. Une touche est frappée d'abord
 * (Tab), parce que Chromium ne rend `:focus-visible` qu'après une interaction au clavier ; le focus est ensuite posé
 * sur l'élément voulu. Rend le détail relevé, `visible` disant si l'anneau est là (`:focus-visible`, ou un contour
 * réellement dessiné — en contraste forcé, c'est le système qui le dessine).
 */
export async function focusVisible(onglet, selecteur) {
  await onglet.touche("Tab");
  return await onglet.evaluer(`(() => {
    const el = document.querySelector(${JSON.stringify(selecteur)});
    if (!el) return { trouve: false, focus: false, pseudo: false, contour: "", largeur: 0, visible: false };
    el.focus({ preventScroll: true });
    const style = getComputedStyle(el);
    const largeur = Number.parseFloat(style.outlineWidth) || 0;
    const pseudo = el.matches(":focus-visible");
    const contourDessine = style.outlineStyle !== "none" && largeur > 0;
    return {
      trouve: true,
      focus: document.activeElement === el,
      pseudo,
      contour: style.outlineStyle,
      largeur,
      couleur: style.outlineColor,
      visible: document.activeElement === el && (pseudo || contourDessine),
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
