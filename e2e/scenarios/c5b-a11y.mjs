// Scénario e2e de l'itération 5 (paquet L50b) : le banc de captures d'accessibilité des vues de la 5b (spécification §5.5,
// §5.6, §7.11 n° 4 ; conception C §17.3 n° 8, §17.4 ; plan d'exécution it5 §2.8).
//
// Dix vues neuves sont capturées dans les TROIS modes (normal, contraste forcé, niveaux de gris avec mouvement réduit), dans
// les deux thèmes et aux trois tailles — 18 fichiers par vue : la galerie des exemples, l'éditeur guidé en vue « Étapes »
// puis en vue « Schéma modifiable », la carte d'exécution, la carte de choix d'un aiguillage, la carte de résultat, le
// Déroulé d'équipe, la vue d'ensemble de la carte des assistants, l'onglet Méthodes et la chronologie d'un lancement.
//
// Chaque vue est RELEVÉE juste avant chacune de ses 18 captures : sans ce relevé, le banc ne compterait que les FICHIERS
// écrits, et 18 images d'une page vide tiendraient le point « captures présentes » en nombre, pas en contenu — la relecture
// humaine du §7.11 n° 4 porterait alors sur de mauvaises images. Deux vues changent de forme à 400 px, et le relevé le dit :
// le schéma modifiable cède la place à sa phrase (§5.3 l.903), et la vue d'ensemble replie ses colonnes (§5.6).
//
// Deux vérifications accompagnent les captures :
//   - en MOUVEMENT RÉDUIT, plus AUCUNE animation perceptible ne tourne (§5.5) — personne ne doit subir un mouvement qu'il a
//     désactivé : relevé à CHAQUE capture de ce mode (dix vues × 2 thèmes × 3 tailles), puis une fois encore au repos ;
//   - en CONTRASTE FORCÉ, le focus reste VISIBLE sur les commandes neuves de la 5b (une puce de filtre de la vue d'ensemble,
//     une ligne du schéma) : c'est le seul repère de la personne qui navigue au clavier.
// Console muette du début à la fin.
//
// L'émulation demande la prise CDP, que le contexte d'un scénario ne porte pas (`ctx.navigateur` est l'ONGLET) : ce scénario
// ouvre son propre navigateur, avec le MÊME épinglage et la même isolation (`e2e/lib/a11y.mjs`), plutôt que de faire écrire
// `e2e/lib/cdp.mjs` par la construction (§2.8).
import path from "node:path";
import { animationsActives, captureAccessibilite, DUREE_PERCEPTIBLE_MS, emuler, focusVisible, mediasDeLaPage, MODES_A11Y, ouvrirNavigateurEpingle } from "../lib/a11y.mjs";
import { attendre, exiger, nonJoue, releve, resume } from "./it1-api-commun.mjs";
import { attendreModeAffiche, LARGE, preparerPage } from "./it1-ui-commun.mjs";
import { attendreRun, enAvance, equipes, scripterEtape } from "./it4-commun.mjs";
import { arreterLesLancements, equipeDeriveeC5, FINIS, lancerAvec } from "./c5b-relecture.mjs";

/** Suffixe des équipes propres à ce scénario : un script « quand:etape= » vaut pour tout scénario qui suit. */
const SUFFIXE = "a11";

/** Largeur sous laquelle le schéma modifiable cède la place à sa phrase (SCHEMA_LARGEUR_MIN, écrite en clair). */
const LARGEUR_SCHEMA = 900;

/** Phrases attendues, écrites en clair. */
const PHRASES = {
  schema: "Schéma modifiable",
  etapes: "Étapes",
  etroit: "Le schéma modifiable demande un écran plus large : utilisez les étapes.",
  vueEnsemble: "Vue d'ensemble",
  choix: "Choisissez le ou les spécialistes",
  chronologie: "Chronologie",
};

const TOUR = (texte, cout) => ({ text: texte, cost: cout, tokens: { input: 700, output: 90, cache: { read: 0, write: 0 } }, stepMs: 5 });

/** Va sur une adresse du cockpit par le fragment, comme un lien, puis attend ce qui doit y être. */
async function allerA(onglet, hash, attendu, libelle) {
  await onglet.evaluer(`location.hash = ${JSON.stringify(hash)}`);
  await onglet.attendreQue(attendu, { libelle, delaiMs: 25_000 });
}

/** Amène une vue dans la fenêtre avant la capture : à 1024 et à 400 px, une section basse de la page est hors champ. */
const amener = (onglet, selecteur) => async () => {
  await onglet.evaluer(`document.querySelector(${JSON.stringify(selecteur)})?.scrollIntoView({ block: "start" })`);
};

/**
 * En MOUVEMENT RÉDUIT, aucune animation perceptible ne tourne sur la vue capturée (§5.5) : relevé à CHAQUE capture du mode
 * « gris-mouvement-reduit », donc sur chacune des dix vues, aux trois tailles et dans les deux thèmes — pas seulement sur la
 * dernière page ouverte. Une transition lancée juste AVANT le passage au réglage (sous le mode précédent, 900 ms au plus)
 * a le droit de finir : le relevé attend 1,5 s au plus qu'elle s'éteigne. Une boucle, elle, ne s'éteint jamais, et une
 * animation lancée malgré le réglage non plus dans ce délai si elle dure : c'est ce que le relevé attrape.
 */
async function aucunMouvement(onglet, mode, ou) {
  if (!mode.reducedMotion) return;
  const limite = Date.now() + 1_500;
  let enMouvement = await animationsActives(onglet, { dureeMinMs: DUREE_PERCEPTIBLE_MS });
  while (enMouvement > 0 && Date.now() < limite) {
    await attendre(100);
    enMouvement = await animationsActives(onglet, { dureeMinMs: DUREE_PERCEPTIBLE_MS });
  }
  exiger(enMouvement === 0, `${enMouvement} animation(s) perceptible(s) en mouvement réduit (${ou}) : §5.5.`);
}

/**
 * Exige qu'un sélecteur soit là au moment de la capture, et le relève : le nombre de fichiers ne dit rien de leur contenu.
 * En mouvement réduit, exige aussi qu'aucune animation perceptible ne tourne (`aucunMouvement`).
 */
const exigerLaVue = (onglet, vues, nom, selecteur) => async ({ mode, theme, taille }) => {
  const present = await onglet.evaluer(`Boolean(document.querySelector(${JSON.stringify(selecteur)}))`);
  vues.push({ vue: nom, mode: mode.nom, theme, taille: taille.nom, present });
  const ou = `${mode.nom}, ${theme}, ${taille.nom} px`;
  exiger(present, `vue « ${nom} » absente au moment de la capture (${ou}).`);
  await aucunMouvement(onglet, mode, `vue « ${nom} », ${ou}`);
};

/** Ouvre le panneau « Contexte » s'il est fermé (il se ferme de lui-même sous 1280 px). */
async function ouvrirLeContexte(onglet) {
  const ouvert = "document.querySelector('.chat')?.classList.contains('aside-open') === true";
  if (await onglet.evaluer(ouvert)) return;
  await onglet.evaluer(`document.querySelector('.chat-header button[aria-label="Afficher le contexte"]')?.click()`);
  await onglet.attendreQue(ouvert, { libelle: "panneau « Contexte » ouvert", delaiMs: 10_000 });
}

export async function run(ctx) {
  const page = await preparerPage(ctx);
  if (ctx.mode !== "faux") {
    nonJoue(ctx, "captures d'accessibilité de la 5b", "les réponses scriptées du faux opencode n'existent qu'en « --faux »");
    ctx.expectNoConsoleErrors();
    return;
  }
  exiger(page !== null, "page du banc absente.");

  const lancements = [];
  let apiDuScenario = null;

  await enAvance(ctx, async () => {
    const api = equipes(ctx);
    apiDuScenario = api;

    // Données des vues : un aiguillage laissé EN ATTENTE DE CHOIX (rien n'y est facturé) puis mené jusqu'à son résultat.
    const aiguillage = await equipeDeriveeC5(api, "tri-alerte", SUFFIXE);
    const bloc = aiguillage.flow.blocs.find((candidat) => candidat.type === "aiguillage");
    const retenu = bloc.specialistes[0];
    await scripterEtape(ctx, bloc.aiguilleur.id, TOUR(`La sonde mesure un seuil trop court.\n\nCHOIX: ${retenu.titre}`, 0.004));
    await scripterEtape(ctx, retenu.id, TOUR("Regarder en lecture seule : seuil, fenêtre, fréquence des relevés.", 0.006));
    const { runId, rootId } = await lancerAvec(api, aiguillage.id, "Alerte : la sonde de supervision passe au rouge toutes les dix minutes.");
    lancements.push(runId);
    await attendreRun(api, runId, (vue) => vue.state === "attente-choix", "aiguillage en attente de choix pour les captures");

    // Un déroulé de l'éditeur : l'équipe dérivée s'ouvre dans l'éditeur guidé, en « Étapes » puis en « Schéma modifiable ».
    const prefixe = path.join(ctx.dossierCaptures, ctx.nom.replace(/\.mjs$/, ""));
    const { navigateur, onglet } = await ouvrirNavigateurEpingle(ctx, "a11y-5b");
    const faites = [];
    const vues = [];
    let nombreDeVues = 0;
    try {
      await preparerPage({ ...ctx, navigateur: onglet });
      await attendreModeAffiche(onglet, "avance");
      // Le navigateur du banc s'ouvre sur sa taille par défaut, plus étroite que les 900 px du schéma modifiable : sans
      // cette taille, l'éditeur montrerait sa phrase et la vue attendue ne viendrait jamais.
      await onglet.taille(LARGE);

      // 1. Galerie des exemples (onglet Équipes).
      await allerA(onglet, "#/assistants/equipes", "document.querySelector('.tm-galerie .tm-exemple')", "galerie des exemples");
      nombreDeVues += 1;
      faites.push(
        ...(await captureAccessibilite(navigateur, onglet, `${prefixe}-galerie`, {
          avant: amener(onglet, ".tm-galerie"),
          apres: exigerLaVue(onglet, vues, "galerie", ".tm-galerie .tm-exemple"),
        })),
      );

      // 2 et 3. Éditeur guidé : vue « Étapes », puis vue « Schéma modifiable » (et sa phrase sous 900 px).
      await allerA(onglet, `#/assistants/equipes/modifier/${aiguillage.id}`, "document.querySelector('.tm-ed-vue-boutons')", "éditeur guidé");
      const basculerVers = (libelle) => async () => {
        await onglet.evaluer(`(() => {
          const b = [...document.querySelectorAll(".tm-ed-vue-boutons button")].find((x) => x.textContent.trim() === ${JSON.stringify(libelle)});
          if (b && b.getAttribute("aria-pressed") !== "true") b.click();
        })()`);
      };
      await basculerVers(PHRASES.etapes)();
      await onglet.attendreQue("document.querySelector('.tm-ed-etapes')", { libelle: "éditeur en vue « Étapes »" });
      nombreDeVues += 1;
      faites.push(
        ...(await captureAccessibilite(navigateur, onglet, `${prefixe}-editeur-etapes`, {
          avant: basculerVers(PHRASES.etapes),
          apres: exigerLaVue(onglet, vues, "éditeur (étapes)", ".tm-ed-etapes"),
        })),
      );

      await onglet.taille(LARGE);
      await basculerVers(PHRASES.schema)();
      await onglet.attendreQue("document.querySelector('.tm-ed-schema-editeur')", { libelle: "éditeur en vue « Schéma modifiable »" });
      nombreDeVues += 1;
      faites.push(
        ...(await captureAccessibilite(navigateur, onglet, `${prefixe}-editeur-schema`, {
          avant: basculerVers(PHRASES.schema),
          // Sous 900 px, le schéma cède la place à sa phrase : la capture doit montrer l'une OU l'autre, jamais rien.
          apres: async ({ mode, theme, taille }) => {
            const etat = await onglet.evaluer(`(() => ({
              schema: Boolean(document.querySelector(".tm-ed-schema-editeur")),
              phrase: (document.querySelector(".tm-ed-schema-etroit")?.textContent ?? "").trim(),
              largeur: window.innerWidth,
            }))()`);
            vues.push({ vue: "éditeur (schéma)", mode: mode.nom, theme, taille: taille.nom, present: etat.schema || etat.phrase !== "" });
            const ou = `${mode.nom}, ${theme}, ${taille.nom} px`;
            if (etat.largeur < LARGEUR_SCHEMA) {
              exiger(etat.phrase === PHRASES.etroit, `sous ${LARGEUR_SCHEMA} px (${ou}), le schéma ne montre pas sa phrase : « ${etat.phrase} ».`);
            } else {
              exiger(etat.schema, `schéma modifiable absent au moment de la capture (${ou}).`);
            }
            await aucunMouvement(onglet, mode, `vue « éditeur (schéma) », ${ou}`);
          },
        })),
      );

      // 4. Carte de choix d'un aiguillage (le lancement attend toujours : rien n'est facturé pendant la pause).
      await allerA(onglet, `#/chat/${rootId}`, "document.querySelector('.team-choice')", "carte de choix de l'aiguillage");
      nombreDeVues += 1;
      faites.push(
        ...(await captureAccessibilite(navigateur, onglet, `${prefixe}-carte-choix`, {
          avant: amener(onglet, ".team-choice"),
          apres: exigerLaVue(onglet, vues, "carte de choix", ".team-choice .team-choice-list"),
        })),
      );
      const titreDuChoix = await onglet.evaluer(`(document.querySelector(".team-choice .team-pause-title")?.textContent ?? "").trim()`);
      exiger(titreDuChoix === PHRASES.choix, `titre de la carte de choix : « ${titreDuChoix} ».`);

      // 5. Carte d'exécution, une fois le choix confirmé (la carte porte alors « Non choisi » pour les écartés).
      const reponse = await api.continuerBrut(runId, { choix: [retenu.id] });
      exiger(reponse.code === 200, `confirmation du choix refusée (${reponse.code}) : ${resume(reponse.corps, 300)}`);
      await onglet.attendreQue("document.querySelector('.team-run .team-steps')", { delaiMs: 25_000, libelle: "carte d'exécution de l'équipe" });
      nombreDeVues += 1;
      faites.push(
        ...(await captureAccessibilite(navigateur, onglet, `${prefixe}-carte-execution`, {
          avant: amener(onglet, ".team-run"),
          apres: exigerLaVue(onglet, vues, "carte d'exécution", ".team-run .team-steps"),
        })),
      );

      // 6. Carte de résultat.
      // Un lancement fini autrement (« echec », « plafond »…) est dit tout de suite : les captures ne s'enchaînent pas dessus.
      const finie = await attendreRun(api, runId, (vue) => FINIS.has(vue.state), "aiguillage des captures terminé", 90_000);
      exiger(finie.state === "terminee", `aiguillage des captures en état « ${finie.state} » : ${resume(finie.steps.map((s) => `${s.stepId}=${s.state}`))}`);
      await allerA(onglet, `#/chat/${rootId}`, "document.querySelector('.team-result')", "carte de résultat de l'équipe");
      nombreDeVues += 1;
      faites.push(
        ...(await captureAccessibilite(navigateur, onglet, `${prefixe}-carte-resultat`, {
          avant: amener(onglet, ".team-result"),
          apres: exigerLaVue(onglet, vues, "carte de résultat", ".team-result"),
        })),
      );

      // 7. Déroulé d'équipe, dans le panneau « Contexte ».
      const ouvrirLeDeroule = async () => {
        await ouvrirLeContexte(onglet);
        await onglet.attendreQue("document.querySelector('.team-deroule')", { delaiMs: 20_000, libelle: "Déroulé d'équipe" });
      };
      await ouvrirLeDeroule();
      nombreDeVues += 1;
      faites.push(
        ...(await captureAccessibilite(navigateur, onglet, `${prefixe}-deroule-equipe`, {
          avant: ouvrirLeDeroule,
          apres: exigerLaVue(onglet, vues, "Déroulé d'équipe", ".team-deroule .deroule-row"),
        })),
      );

      // 8. Chronologie de ce lancement (mode Avancé seulement : « jeton » est interdit en Simple).
      const ouvrirLaChronologie = async () => {
        await ouvrirLeContexte(onglet);
        if (await onglet.evaluer("Boolean(document.querySelector('.chronologie'))")) return;
        await onglet.evaluer(`(() => {
          const b = [...document.querySelectorAll(".chrono-bascule button")].find((x) => x.textContent.trim() === ${JSON.stringify(PHRASES.chronologie)});
          b?.click();
        })()`);
        await onglet.attendreQue("document.querySelector('.chronologie')", { delaiMs: 15_000, libelle: "vue Chronologie" });
      };
      await ouvrirLaChronologie();
      nombreDeVues += 1;
      faites.push(
        ...(await captureAccessibilite(navigateur, onglet, `${prefixe}-chronologie-lancement`, {
          avant: ouvrirLaChronologie,
          apres: async ({ mode, theme, taille }) => {
            const vue = await onglet.evaluer(`(() => {
              const v = document.querySelector(".chronologie");
              return v ? { rangees: v.querySelectorAll("tbody tr").length, tableau: v.querySelector("table") !== null } : null;
            })()`);
            vues.push({ vue: "chronologie d'un lancement", mode: mode.nom, theme, taille: taille.nom, present: vue !== null && vue.rangees > 0 });
            const ou = `${mode.nom}, ${theme}, ${taille.nom} px`;
            exiger(vue !== null, `vue Chronologie absente au moment de la capture (${ou}).`);
            exiger(vue.tableau && vue.rangees > 0, `chronologie vide au moment de la capture (${ou}) : ${resume(vue)}`);
            await aucunMouvement(onglet, mode, `vue « chronologie d'un lancement », ${ou}`);
          },
        })),
      );

      // 9. Vue d'ensemble de la carte des assistants.
      const ouvrirLaVueDEnsemble = async () => {
        await onglet.evaluer(`(() => {
          const b = [...document.querySelectorAll(".ca-vues-choix button")].find((x) => x.textContent.trim() === ${JSON.stringify(PHRASES.vueEnsemble)});
          if (b && b.getAttribute("aria-pressed") !== "true") b.click();
        })()`);
        await onglet.attendreQue("document.querySelector('.ov-ensemble')", { delaiMs: 15_000, libelle: "vue d'ensemble" });
      };
      await allerA(onglet, "#/assistants/carte", "document.querySelector('.ca-vues-choix')", "onglet Carte");
      await ouvrirLaVueDEnsemble();
      nombreDeVues += 1;
      faites.push(
        ...(await captureAccessibilite(navigateur, onglet, `${prefixe}-vue-ensemble`, {
          avant: ouvrirLaVueDEnsemble,
          apres: exigerLaVue(onglet, vues, "vue d'ensemble", ".ov-ensemble .ov-noeud"),
        })),
      );

      // 10. Onglet Méthodes.
      await allerA(onglet, "#/assistants/methodes", "document.querySelector('.ast-tabpanel .met-library')", "onglet Méthodes");
      nombreDeVues += 1;
      faites.push(
        ...(await captureAccessibilite(navigateur, onglet, `${prefixe}-onglet-methodes`, {
          avant: amener(onglet, ".met-library"),
          apres: exigerLaVue(onglet, vues, "onglet Méthodes", ".ast-tabpanel .met-library .met-card"),
        })),
      );

      // Mouvement réduit : plus rien ne tourne. Le réglage est d'abord EXIGÉ tel que la page le voit — un relevé nul ne
      // dirait rien s'il venait d'un réglage qui n'est pas arrivé jusqu'à elle.
      await onglet.taille(LARGE);
      await emuler(navigateur, onglet, { theme: "sombre", reducedMotion: true, grayscale: true });
      const medias = await mediasDeLaPage(onglet);
      exiger(medias.mouvementReduit === true, `la page ne voit pas le mouvement réduit émulé : ${resume(medias)}`);
      await attendre(1_200);
      const enMouvement = await animationsActives(onglet, { dureeMinMs: DUREE_PERCEPTIBLE_MS });
      releve(ctx, `animations perceptibles au repos, en mouvement réduit : ${enMouvement}`);
      exiger(enMouvement === 0, `${enMouvement} animation(s) perceptible(s) alors que le mouvement réduit est demandé (§5.5).`);

      // Contraste forcé : le focus reste visible sur deux commandes neuves de la 5b.
      await emuler(navigateur, onglet, { theme: "clair", forcedColors: true });
      await allerA(onglet, "#/assistants/carte", "document.querySelector('.ca-vues-choix')", "onglet Carte (contraste forcé)");
      await ouvrirLaVueDEnsemble();
      const puce = await focusVisible(onglet, ".ov-puce");
      releve(ctx, `focus en contraste forcé (puce de filtre) : ${JSON.stringify(puce)}`);
      exiger(puce.visible, `focus invisible en contraste forcé sur une puce de filtre : ${resume(puce)}`);

      await allerA(onglet, `#/assistants/equipes/modifier/${aiguillage.id}`, "document.querySelector('.tm-ed-vue-boutons')", "éditeur guidé (contraste forcé)");
      await basculerVers(PHRASES.schema)();
      await onglet.attendreQue("document.querySelector('.sc-ligne')", { libelle: "ligne du schéma (contraste forcé)" });
      const ligne = await focusVisible(onglet, ".sc-ligne");
      releve(ctx, `focus en contraste forcé (ligne du schéma) : ${JSON.stringify(ligne)}`);
      exiger(ligne.visible, `focus invisible en contraste forcé sur une ligne du schéma : ${resume(ligne)}`);

      const attendues = nombreDeVues * MODES_A11Y.length * 6;
      releve(ctx, `captures d'accessibilité de la 5b : ${faites.length} fichiers, ${nombreDeVues} vues × ${MODES_A11Y.map((m) => m.nom).join(", ")} × 2 thèmes × 3 tailles`);
      releve(ctx, `vues relevées avant capture : ${vues.length} (toutes présentes : ${vues.every((v) => v.present)})`);
      exiger(faites.length === attendues, `${faites.length} captures au lieu de ${attendues} (3 modes × 2 thèmes × 3 tailles × ${nombreDeVues} vues).`);
      exiger(vues.length === attendues, `${vues.length} relevés de vue pour ${attendues} captures.`);
      onglet.exigerAucuneErreurConsole();
    } finally {
      await navigateur.fermer().catch(() => {});
    }
  }).finally(async () => {
    // Un lancement laissé en attente occupe une place parmi les équipes en cours : le scénario suivant serait refusé en
    // 409 « trop-d-equipes » pour une raison qui ne le regarde pas.
    if (apiDuScenario !== null) await arreterLesLancements(apiDuScenario, lancements);
  });

  ctx.expectNoConsoleErrors();
}
