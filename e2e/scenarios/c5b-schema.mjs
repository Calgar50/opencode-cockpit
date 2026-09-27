// Scénario e2e de l'itération 5 (paquet L50b) : le SCHÉMA MODIFIABLE, au clavier seul, et son refus du lien vers le haut
// (spécification §5.3 l.903, §5.5, §5.6 ; conception C §8.2, §17.3 n° 5, §17.4 ; plan d'exécution it5, fiches L42d et L43).
//
// Le schéma se glisse à la souris, et la spécification (§5.5, WCAG 2.5.7) exige que TOUT glisser ait son chemin clavier.
// Ce scénario éprouve ce chemin dans la vraie pile, avec de VRAIES frappes (Alt compris) et un VRAI glisser au pointeur :
//   1. Alt+↓ puis Alt+↑ déplacent un bloc — exactement ce que fait le glisser d'un bloc vers une place — et [Voir le JSON]
//      suit ;
//   2. un LIEN entre étapes se pose par le menu « Reçoit le résultat de… », ouvert par Entrée, case cochée par la barre
//      d'espace ; le déroulé le porte (`recoit: {etapes}`), lu dans [Voir le JSON] ;
//   3. un lien VERS LE HAUT est REFUSÉ, avec sa phrase ANNONCÉE :
//      a. au clavier, il ne peut même pas être demandé — chaque menu ne propose que des étapes situées PLUS HAUT —, et c'est
//         mesuré sur CHAQUE menu du schéma ;
//      b. le seul geste qui peut le demander est le glisser depuis le port de sortie d'une étape (C §8.2 « arrow to a step
//         above ») : il est joué pour de vrai (événements du pointeur du navigateur), et le schéma écrit la phrase
//         « Le cockpit exécute les étapes de haut en bas … » PRÈS DE LA CIBLE, avec son icône, la page l'ANNONCE poliment
//         (région aria-live unique), et le déroulé reste inchangé ;
//      c. un déplacement de bloc qui rendrait un lien existant arrière ne le garde jamais en silence ;
//   4. [Voir le JSON] est en LECTURE SEULE, avec la phrase qui renvoie à « Dupliquer » ;
//   5. sous 900 px (SCHEMA_LARGEUR_MIN), le schéma cède la place à la phrase de la spécification — à 899 px la phrase, à
//      900 px le schéma : la borne est éprouvée des deux côtés.
// Rien n'est ENREGISTRÉ : l'éditeur est quitté par la garde de navigation, et l'équipe du banc reste celle de l'exemple.
//
// Les frappes avec Alt et le glisser au pointeur demandent la prise CDP, que le contexte d'un scénario ne porte pas
// (`ctx.navigateur` est l'ONGLET) : ce scénario ouvre son propre navigateur, avec le MÊME épinglage et la même isolation
// (`ouvrirNavigateurEpingle`, e2e/lib/a11y.mjs), plutôt que de faire écrire `e2e/lib/cdp.mjs` par la construction (§2.8).
import { ouvrirNavigateurEpingle } from "../lib/a11y.mjs";
import { attendre, exiger, releve, resume } from "./it1-api-commun.mjs";
import { attendreModeAffiche, LARGE, preparerPage } from "./it1-ui-commun.mjs";
import { enAvance, equipes, installerExemple, quitterEditeur } from "./it4-commun.mjs";

/** Exemple ouvert dans l'éditeur : quatre blocs de travail à la suite et une pause — de quoi monter, descendre et lier. */
const EXEMPLE = "relecture-script";

/** Phrases attendues (construction-texts.ts `avance.schema`), écrites en clair. */
const PHRASES = {
  etapes: "Étapes",
  schema: "Schéma modifiable",
  glisser: "Glissez vers une étape plus bas : elle recevra ce résultat.",
  recevoir: "Reçoit le résultat de…",
  json: "Voir le JSON",
  lectureSeule: "Lecture seule. Pour partager une équipe, utilisez « Dupliquer » ; l'import viendra plus tard.",
  etroit: "Le schéma modifiable demande un écran plus large : utilisez les étapes.",
  versLeBas: "Le cockpit exécute les étapes de haut en bas : un lien ne peut aller que vers une étape plus bas.",
  lienArriere: "Une étape ne peut recevoir que le résultat d'étapes situées plus haut.",
};

/** Largeur sous laquelle le schéma cède la place à sa phrase (SCHEMA_LARGEUR_MIN de flow-edit.ts, écrite en clair ici). */
const LARGEUR_MIN = 900;

/** Modificateur Alt des événements clavier de CDP (Input.dispatchKeyEvent, champ `modifiers`). */
const ALT = 1;
const CODES_FLECHES = { ArrowUp: 38, ArrowDown: 40 };

/**
 * Alt+↑ / Alt+↓ frappés POUR DE VRAI sur la ligne d'un bloc : la ligne prend le focus, puis la touche part du clavier du
 * navigateur (CDP), Alt tenu. `onglet.touche` (cdp.mjs, que la construction n'écrit jamais) ne porte pas de modificateur.
 */
async function altFleche(navigateur, onglet, blocId, sens) {
  const focalise = await onglet.evaluer(`(() => {
    const ligne = document.querySelector(${JSON.stringify(`.sc-ligne[data-sc-bloc="${blocId}"]`)});
    if (!ligne) return "absente";
    ligne.focus({ preventScroll: false });
    return document.activeElement === ligne ? "focus" : "sans focus";
  })()`);
  exiger(focalise === "focus", `Alt+${sens} sur le bloc « ${blocId} » : ligne ${focalise}.`);
  const commun = { key: sens, code: sens, windowsVirtualKeyCode: CODES_FLECHES[sens], nativeVirtualKeyCode: CODES_FLECHES[sens], modifiers: ALT };
  await navigateur.client.envoyer("Input.dispatchKeyEvent", { type: "rawKeyDown", ...commun }, onglet.sessionId);
  await navigateur.client.envoyer("Input.dispatchKeyEvent", { type: "keyUp", ...commun }, onglet.sessionId);
}

/** Ordre des blocs tel que le schéma le dessine (une ligne principale par bloc). */
const ordreDesBlocs = `[...document.querySelectorAll(".sc-lignes .sc-ligne")].map((e) => e.getAttribute("data-sc-bloc")).filter((id, rang, tous) => tous.indexOf(id) === rang)`;

/** Déroulé lu dans [Voir le JSON] (lecture seule) : la seule source qui dise ce que l'éditeur tient vraiment. */
async function derouleDuJson(onglet) {
  await onglet.evaluer(`(() => { const d = document.querySelector("details.sc-json"); if (d && !d.open) d.querySelector("summary")?.click(); })()`);
  await onglet.attendreQue("document.querySelector('.sc-json-texte')", { libelle: "[Voir le JSON] ouvert" });
  return JSON.parse(await onglet.evaluer(`document.querySelector(".sc-json-texte").value`));
}

/** Étapes d'un bloc du déroulé, dans l'ordre où le schéma les dessine. */
function etapesDuBloc(bloc) {
  if (bloc.type === "etape") return [bloc.etape];
  if (bloc.type === "avis") return [...bloc.avis, bloc.synthese];
  if (bloc.type === "relecture") return [bloc.auteur, bloc.relecteur];
  if (bloc.type === "aiguillage") return [bloc.aiguilleur, ...bloc.specialistes, ...(bloc.synthese === null ? [] : [bloc.synthese])];
  return [];
}

/** Rang du bloc de chaque étape d'un déroulé. */
function rangsDesEtapes(flow) {
  const rangs = new Map();
  flow.blocs.forEach((bloc, rang) => {
    for (const etape of etapesDuBloc(bloc)) rangs.set(etape.id, rang);
  });
  return rangs;
}

/**
 * Points du glisser, en coordonnées de la fenêtre : le PORT de sortie de l'étape `de` (là où l'appui arme le lien) et le
 * CENTRE de la cellule de l'étape `vers`. Chaque point est vérifié par `elementFromPoint` : un point qui tomberait sur autre
 * chose (une commande, une autre étape) ferait jouer un autre geste que celui qu'on veut éprouver.
 */
async function pointsDuGlisser(onglet, de, vers) {
  return await onglet.evaluer(`(() => {
    const cellule = (id) => document.querySelector('.sc-cellule[data-sc-etape="' + id + '"]');
    const source = cellule(${JSON.stringify(de)});
    const cible = cellule(${JSON.stringify(vers)});
    if (!source || !cible) return { erreur: "cellule absente" };
    cible.scrollIntoView({ block: "center" });
    const port = source.querySelector(".sc-port").getBoundingClientRect();
    const zone = cible.querySelector(".sc-titre").getBoundingClientRect();
    // Le haut du port : il déborde de sa cellule vers le bas, et son bas peut être recouvert par la place qui suit.
    const depart = { x: port.left + port.width / 2, y: port.top + port.height / 4 };
    const arrivee = { x: zone.left + Math.min(zone.width / 2, 40), y: zone.top + zone.height / 2 };
    const sousDepart = document.elementFromPoint(depart.x, depart.y);
    const sousArrivee = document.elementFromPoint(arrivee.x, arrivee.y);
    return {
      depart,
      arrivee,
      hauteur: window.innerHeight,
      departSurLePort: sousDepart !== null && sousDepart.classList.contains("sc-port"),
      arriveeSur: sousArrivee?.closest("[data-sc-etape]")?.getAttribute("data-sc-etape") ?? null,
    };
  })()`);
}

/**
 * Glisser AU POINTEUR, joué par le navigateur (Input.dispatchMouseEvent) : appui sur le port, déplacement par petits pas
 * (le glisser ne commence qu'au-delà de quelques pixels, SchemaEditor SEUIL_GLISSER), survol de la cible, puis relâche. Les
 * événements `pointer` que la page reçoit sont ceux d'une vraie souris : c'est le geste de la personne, pas une imitation
 * écrite dans la page. Rend la phrase écrite près de la cible PENDANT le survol, avant la relâche.
 */
async function glisserUnLien(navigateur, onglet, points, blocCible) {
  const souris = (type, { x, y }, extra) =>
    navigateur.client.envoyer("Input.dispatchMouseEvent", { type, x, y, pointerType: "mouse", ...extra }, onglet.sessionId);
  await souris("mouseMoved", points.depart, { button: "none", buttons: 0 });
  await souris("mousePressed", points.depart, { button: "left", buttons: 1, clickCount: 1 });
  const pas = 10;
  for (let i = 1; i <= pas; i++) {
    const x = points.depart.x + ((points.arrivee.x - points.depart.x) * i) / pas;
    const y = points.depart.y + ((points.arrivee.y - points.depart.y) * i) / pas;
    await souris("mouseMoved", { x, y }, { button: "left", buttons: 1 });
    await attendre(25);
  }
  await attendre(150);
  const pendant = await onglet.evaluer(
    `(document.querySelector(${JSON.stringify(`.sc-ligne[data-sc-bloc="${blocCible}"] .sc-refus`)})?.textContent ?? "").trim()`,
  );
  await souris("mouseReleased", points.arrivee, { button: "left", buttons: 0, clickCount: 1 });
  return pendant;
}

/** Texte de la région polie de la page (annonceur unique) : la phrase y arrive au plus tard 2 s après l'annonce précédente. */
const ANNONCES = `[...document.querySelectorAll('[role="status"][aria-live="polite"]')].map((e) => (e.textContent ?? "").trim()).filter((t) => t !== "")`;

export async function run(ctx) {
  await preparerPage(ctx);

  await enAvance(ctx, async () => {
    const api = equipes(ctx);
    await installerExemple(api, EXEMPLE);
    const avantEditeur = (await api.liste()).teams.find((candidat) => candidat.id === EXEMPLE);
    exiger(avantEditeur !== undefined, `l'équipe « ${EXEMPLE} » n'est pas installée.`);

    const { navigateur, onglet } = await ouvrirNavigateurEpingle(ctx, "schema");
    try {
      const page = await preparerPage({ ...ctx, navigateur: onglet });
      await attendreModeAffiche(page, "avance");
      await page.taille(LARGE);

      await page.evaluer(`location.hash = ${JSON.stringify(`#/assistants/equipes/modifier/${EXEMPLE}`)}`);
      await page.attendreQue("document.querySelector('.tm-ed')", { delaiMs: 25_000, libelle: "éditeur guidé" });
      // Écran 2 (« Étapes ») : la bascule « Étapes | Schéma modifiable » n'y existe qu'en mode Avancé.
      await page.attendreQue("document.querySelector('.tm-ed-vue-boutons')", { delaiMs: 15_000, libelle: "bascule « Étapes | Schéma modifiable »" });
      const bascule = await page.evaluer(`[...document.querySelectorAll(".tm-ed-vue-boutons button")].map((b) => b.textContent.trim())`);
      exiger(
        bascule.length === 2 && bascule[0] === PHRASES.etapes && bascule[1] === PHRASES.schema,
        `bascule des vues : ${resume(bascule)} (« ${PHRASES.etapes} » puis « ${PHRASES.schema} » attendus).`,
      );
      // La bascule elle-même se tient au clavier : le bouton prend le focus, Entrée l'active.
      await page.evaluer(`[...document.querySelectorAll(".tm-ed-vue-boutons button")].find((b) => b.textContent.trim() === ${JSON.stringify(PHRASES.schema)}).focus()`);
      await page.touche("Enter");
      await page.attendreQue("document.querySelector('.tm-ed-schema-editeur')", { libelle: "schéma modifiable ouvert au clavier" });
      const aide = await page.texte(".sc-aide");
      exiger(aide.trim() === PHRASES.glisser, `phrase d'aide du schéma : « ${aide.trim()} ».`);

      // 1. Alt+↓ puis Alt+↑ : le bloc descend, puis remonte, et le déroulé suit.
      const avant = await page.evaluer(ordreDesBlocs);
      exiger(avant.length >= 3, `${avant.length} bloc(s) dessinés : ce scénario en demande au moins trois.`);
      const premier = avant[0];
      await altFleche(navigateur, page, premier, "ArrowDown");
      await page.attendreQue(`${ordreDesBlocs}[0] !== ${JSON.stringify(premier)}`, { libelle: "bloc descendu par Alt+↓" });
      const descendu = await page.evaluer(ordreDesBlocs);
      releve(ctx, `Alt+↓ : ${resume(avant)} → ${resume(descendu)}`);
      exiger(descendu[1] === premier, `après Alt+↓, le bloc « ${premier} » est au rang ${descendu.indexOf(premier)} au lieu de 1.`);
      const jsonDescendu = await derouleDuJson(page);
      exiger(jsonDescendu.blocs[1]?.id === premier, `le JSON ne suit pas le déplacement : ${resume(jsonDescendu.blocs.map((b) => b.id))}`);

      await altFleche(navigateur, page, premier, "ArrowUp");
      await page.attendreQue(`${ordreDesBlocs}[0] === ${JSON.stringify(premier)}`, { libelle: "bloc remonté par Alt+↑" });
      exiger((await page.evaluer(ordreDesBlocs)).join("|") === avant.join("|"), "après Alt+↑, l'ordre des blocs n'est pas revenu à celui du départ.");
      releve(ctx, "Alt+↑ : le bloc est revenu à sa place — le clavier fait exactement ce que fait le glisser d'un bloc");

      // 3a. Menus « Reçoit le résultat de… » : ils ne proposent QUE des étapes situées plus haut. Un lien vers le haut ne peut
      //     donc pas être DEMANDÉ au clavier — c'est la garde, mesurée sur chaque menu du schéma.
      const jsonDepart = await derouleDuJson(page);
      const rangDeLEtape = rangsDesEtapes(jsonDepart);
      const menus = await page.evaluer(`[...document.querySelectorAll(".sc-cellule")].flatMap((cellule) => {
        const menu = cellule.querySelector("details.sc-menu");
        if (!menu) return [];
        return [{
          etape: cellule.getAttribute("data-sc-etape"),
          libelle: (menu.querySelector("summary")?.textContent ?? "").trim(),
          choix: [...menu.querySelectorAll(".sc-case")].map((c) => (c.querySelector("span")?.textContent ?? "").trim()),
          choixEtapes: [...menu.querySelectorAll(".sc-case input")].length,
        }];
      })`);
      exiger(menus.length > 0, "aucun menu « Reçoit le résultat de… » dans le schéma : le chemin clavier du lien n'existe pas.");
      for (const menu of menus) exiger(menu.libelle === PHRASES.recevoir, `libellé du menu de « ${menu.etape} » : « ${menu.libelle} ».`);
      // Les identifiants ne sont pas dans le DOM du menu (il porte les TITRES) : la garde se lit sur le déroulé, où « amont » se
      // lit — chaque menu ne propose que les étapes des blocs précédents, donc jamais une étape plus bas.
      for (const menu of menus) {
        const rang = rangDeLEtape.get(menu.etape);
        const amont = jsonDepart.blocs.slice(0, rang).flatMap((bloc) => etapesDuBloc(bloc));
        exiger(
          menu.choixEtapes === amont.length,
          `le menu de « ${menu.etape} » propose ${menu.choixEtapes} étape(s) alors que ${amont.length} la précèdent : un lien vers le haut serait demandable au clavier.`,
        );
        for (const titre of menu.choix) {
          exiger(
            amont.some((etape) => etape.titre === titre),
            `le menu de « ${menu.etape} » propose « ${titre} », qui n'est pas au-dessus d'elle : un lien vers le haut serait demandable au clavier.`,
          );
        }
      }
      releve(ctx, `${menus.length} menu(s) « ${PHRASES.recevoir} » : aucun ne propose une étape située plus bas`);

      // 2. Le lien se pose au clavier : le menu s'ouvre par Entrée sur son résumé, la case se coche par la barre d'espace.
      const cible = menus.at(-1);
      const selecteurMenu = `.sc-cellule[data-sc-etape="${cible.etape}"] details.sc-menu`;
      await page.evaluer(`document.querySelector(${JSON.stringify(`${selecteurMenu} summary`)}).focus()`);
      await page.touche("Enter");
      await page.attendreQue(`document.querySelector(${JSON.stringify(selecteurMenu)})?.open === true`, { libelle: "menu des liens ouvert au clavier" });
      await page.evaluer(`document.querySelector(${JSON.stringify(`${selecteurMenu} .sc-case input`)}).focus()`);
      // La barre d'espace se frappe par `taper(" ")` : `touche` n'envoie pas le caractère, et une case ne se coche pas sans lui.
      await page.taper(" ");
      await page.attendreQue(`document.querySelector(${JSON.stringify(`${selecteurMenu} .sc-case input`)})?.checked === true`, {
        delaiMs: 8_000,
        libelle: "première étape cochée au clavier",
      });
      const jsonLie = await derouleDuJson(page);
      const etapeLiee = jsonLie.blocs.flatMap(etapesDuBloc).find((etape) => etape.id === cible.etape);
      releve(ctx, `lien posé au clavier : « ${cible.etape} » reçoit ${resume(etapeLiee?.recoit)}`);
      exiger(
        etapeLiee !== undefined && typeof etapeLiee.recoit === "object" && Array.isArray(etapeLiee.recoit.etapes) && etapeLiee.recoit.etapes.length === 1,
        `« ${cible.etape} » ne porte pas de lien après le clavier : ${resume(etapeLiee?.recoit)}`,
      );
      const source = etapeLiee.recoit.etapes[0];
      exiger(rangDeLEtape.get(source) < rangDeLEtape.get(cible.etape), `le lien posé va de « ${source} » vers « ${cible.etape} », qui n'est pas plus bas.`);
      // Le menu est refermé au clavier, par Entrée sur son résumé, comme la personne le ferait avant de passer à autre chose.
      await page.evaluer(`document.querySelector(${JSON.stringify(`${selecteurMenu} summary`)}).focus()`);
      await page.touche("Enter");
      await page.attendreQue(`document.querySelector(${JSON.stringify(selecteurMenu)})?.open === false`, { libelle: "menu des liens refermé au clavier" });

      // 3b. Le lien VERS LE HAUT, par le seul geste qui peut le demander : le glisser depuis le port de sortie d'une étape
      //     jusqu'à une étape située PLUS HAUT. Deux étapes de blocs voisins, toutes deux visibles dans la fenêtre.
      const travail = jsonLie.blocs.filter((bloc) => bloc.type === "etape");
      exiger(travail.length >= 2, `${travail.length} bloc(s) d'étape : le glisser demande deux étapes l'une sous l'autre.`);
      const basse = travail.at(-2).etape.id;
      const haute = travail.at(-3)?.etape.id ?? travail[0].etape.id;
      const blocHaut = jsonLie.blocs.find((bloc) => etapesDuBloc(bloc).some((etape) => etape.id === haute)).id;
      exiger(rangsDesEtapes(jsonLie).get(haute) < rangsDesEtapes(jsonLie).get(basse), `« ${haute} » n'est pas au-dessus de « ${basse} ».`);
      const points = await pointsDuGlisser(page, basse, haute);
      releve(ctx, `glisser d'un lien vers le haut : du port de « ${basse} » vers « ${haute} » — ${resume(points, 300)}`);
      exiger(points.erreur === undefined, `glisser impossible : ${points.erreur}`);
      exiger(points.departSurLePort, `le point de départ ne tombe pas sur le port de sortie de « ${basse} » : ${resume(points)}`);
      exiger(points.arriveeSur === haute, `le point d'arrivée tombe sur « ${points.arriveeSur} » au lieu de « ${haute} ».`);
      exiger(
        [points.depart.y, points.arrivee.y].every((y) => y > 0 && y < points.hauteur),
        `les deux étapes ne tiennent pas dans la fenêtre (${points.hauteur} px) : ${resume(points)}`,
      );
      const recoitAvant = JSON.stringify(etapesDuBloc(jsonLie.blocs.find((bloc) => bloc.id === blocHaut)).map((etape) => etape.recoit ?? null));
      const pendant = await glisserUnLien(navigateur, page, points, blocHaut);
      releve(ctx, `pendant le survol, près de la cible : « ${pendant} »`);
      exiger(pendant === PHRASES.versLeBas, `pendant le survol, le schéma n'écrit pas le refus près de la cible : « ${pendant} ».`);
      // Après la relâche : la phrase RESTE près de la cible, avec son icône (jamais la couleur seule), la page l'annonce, et
      // rien n'est écrit dans le déroulé.
      await page.attendreQue(
        `(document.querySelector(${JSON.stringify(`.sc-ligne[data-sc-bloc="${blocHaut}"] .sc-refus`)})?.textContent ?? "").trim() === ${JSON.stringify(PHRASES.versLeBas)}`,
        { delaiMs: 5_000, libelle: "refus écrit près de la cible après la relâche" },
      );
      const icone = await page.evaluer(`Boolean(document.querySelector(${JSON.stringify(`.sc-ligne[data-sc-bloc="${blocHaut}"] .sc-refus svg`)}))`);
      exiger(icone, "le refus est écrit sans son icône près de la cible.");
      await page.attendreQue(`${ANNONCES}.some((t) => t.includes(${JSON.stringify(PHRASES.versLeBas)}))`, {
        delaiMs: 6_000,
        libelle: "refus du lien vers le haut annoncé par la région polie de la page",
      });
      releve(ctx, `refus annoncé poliment : ${resume(await page.evaluer(ANNONCES), 300)}`);
      const jsonApresRefus = await derouleDuJson(page);
      exiger(
        JSON.stringify(etapesDuBloc(jsonApresRefus.blocs.find((bloc) => bloc.id === blocHaut)).map((etape) => etape.recoit ?? null)) === recoitAvant,
        `le glisser refusé a quand même écrit un lien sur « ${haute} » : ${resume(jsonApresRefus.blocs.find((bloc) => bloc.id === blocHaut))}`,
      );
      exiger(JSON.stringify(jsonApresRefus) === JSON.stringify(jsonLie), "le glisser refusé a changé le déroulé.");

      // 3c. Un DÉPLACEMENT qui rendrait le lien posé en 2 arrière (le bloc lié remonté au-dessus de sa source) : jamais gardé
      //     en silence. Deux réponses seulement sont acceptables — le lien est défait, ou il est signalé sur l'étape fautive.
      const blocLie = jsonLie.blocs.find((bloc) => etapesDuBloc(bloc).some((etape) => etape.id === cible.etape));
      const rangLie = jsonLie.blocs.indexOf(blocLie);
      const rangSource = jsonLie.blocs.findIndex((bloc) => etapesDuBloc(bloc).some((etape) => etape.id === source));
      for (let pas = 0; pas < rangLie - rangSource; pas++) {
        await altFleche(navigateur, page, blocLie.id, "ArrowUp");
        await attendre(250);
      }
      await attendre(1_200);
      const apresDeplacement = await derouleDuJson(page);
      const rangs = rangsDesEtapes(apresDeplacement);
      exiger(rangs.get(cible.etape) <= rangs.get(source), `le bloc lié n'est pas passé au-dessus de sa source : ${resume(apresDeplacement.blocs.map((b) => b.id))}`);
      const etapeApres = apresDeplacement.blocs.flatMap(etapesDuBloc).find((etape) => etape.id === cible.etape);
      const liens = typeof etapeApres?.recoit === "object" && Array.isArray(etapeApres.recoit.etapes) ? etapeApres.recoit.etapes : [];
      const arrieres = liens.filter((id) => rangs.get(id) >= rangs.get(cible.etape));
      const signales = await page.evaluer(`[...document.querySelectorAll(".sc-probleme, .tm-ed-probleme")].map((e) => e.textContent.trim())`);
      releve(ctx, `après le déplacement : « ${cible.etape} » reçoit ${resume(liens)}, dont ${arrieres.length} vers le haut ; problèmes affichés : ${resume(signales, 300)}`);
      if (arrieres.length > 0) {
        exiger(signales.some((texte) => texte.includes(PHRASES.lienArriere)), `le lien de « ${cible.etape} » vers le haut est gardé EN SILENCE : ${resume(signales)}`);
      } else {
        exiger(liens.length === 0, `le lien de « ${cible.etape} » n'a pas été défait par le déplacement, et il ne va plus vers le bas : ${resume(liens)}`);
        releve(ctx, "le déplacement a DÉFAIT le lien devenu arrière (l'entrée de l'étape revient à celle de sa place) : aucun lien arrière n'est gardé");
      }

      // 4. [Voir le JSON] : lecture seule, avec la phrase qui renvoie à « Dupliquer ».
      const json = await page.evaluer(`(() => {
        const details = document.querySelector("details.sc-json");
        const zone = details?.querySelector(".sc-json-texte");
        return {
          resume: (details?.querySelector("summary")?.textContent ?? "").trim(),
          lectureSeule: zone?.readOnly === true,
          phrase: (details?.querySelector("p")?.textContent ?? "").trim(),
        };
      })()`);
      exiger(json.resume === PHRASES.json, `résumé du JSON : « ${json.resume} ».`);
      exiger(json.lectureSeule, "la zone du JSON n'est pas en lecture seule.");
      exiger(json.phrase === PHRASES.lectureSeule, `phrase du JSON : « ${json.phrase} ».`);

      // 5. La borne des 900 px, des deux côtés : à 899 px la phrase de la spécification et plus de schéma ; à 900 px le schéma.
      await page.taille({ largeur: LARGEUR_MIN - 1, hauteur: LARGE.hauteur });
      await page.attendreQue("document.querySelector('.tm-ed-schema-etroit')", { delaiMs: 10_000, libelle: `phrase du schéma à ${LARGEUR_MIN - 1} px` });
      const etroit = await page.evaluer(`(() => ({
        phrase: (document.querySelector(".tm-ed-schema-etroit")?.textContent ?? "").trim(),
        schema: Boolean(document.querySelector(".tm-ed-schema-editeur")),
        largeur: window.innerWidth,
      }))()`);
      releve(ctx, `à ${etroit.largeur} px : « ${etroit.phrase} »`);
      exiger(etroit.largeur === LARGEUR_MIN - 1, `largeur mesurée ${etroit.largeur} px au lieu de ${LARGEUR_MIN - 1}.`);
      exiger(etroit.phrase === PHRASES.etroit, `phrase à ${etroit.largeur} px : « ${etroit.phrase} ».`);
      exiger(etroit.schema === false, `le schéma reste dessiné à ${etroit.largeur} px, sous les ${LARGEUR_MIN} px qu'il demande.`);
      await page.taille({ largeur: LARGEUR_MIN, hauteur: LARGE.hauteur });
      await page.attendreQue("document.querySelector('.tm-ed-schema-editeur') && !document.querySelector('.tm-ed-schema-etroit')", {
        delaiMs: 10_000,
        libelle: `schéma de retour à ${LARGEUR_MIN} px`,
      });
      releve(ctx, `à ${LARGEUR_MIN} px : le schéma modifiable est dessiné, sans la phrase`);
      await page.taille(LARGE);

      // Rien n'est enregistré : la garde de navigation répond [Quitter], comme la personne qui abandonne son brouillon.
      await quitterEditeur({ ...ctx, navigateur: page }, "#/assistants/equipes");
      page.exigerAucuneErreurConsole();
    } finally {
      await navigateur.fermer().catch(() => {});
    }

    const equipe = (await api.liste()).teams.find((candidat) => candidat.id === EXEMPLE);
    exiger(equipe !== undefined, `l'équipe « ${EXEMPLE} » a disparu après l'éditeur.`);
    exiger(JSON.stringify(equipe.flow) === JSON.stringify(avantEditeur.flow), "l'équipe enregistrée a changé : le schéma a écrit sans qu'on enregistre.");
  });

  ctx.expectNoConsoleErrors();
}
