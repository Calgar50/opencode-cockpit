// Scénario e2e des démonstrations enregistrées (itération 3, paquet L35).
//
// Spécification §5.9 l.1013-1017 (trois démonstrations rejouées sur le lecteur complet), §6 l.1064 (« Démonstration
// enregistrée : aucune IA n'est appelée » : e2e zéro requête opencode), §7.7 l.1175 ; plan it3 fiche L35, D-3d-20, D-3d-26 ;
// décision U1 (en mode Simple, l'IA ne délègue pas).
//
// Ce que le scénario établit, en mode Simple (le défaut) puis en mode Avancé :
//   1. [Voir une démonstration] ouvre la boîte étiquetée « Démonstration enregistrée : aucune IA n'est appelée » ;
//   2. les TROIS démonstrations sont au choix (« Deux assistants en même temps », « Attente de votre accord », « Arrêt au
//      plafond ») et chacune se joue sur le lecteur complet de « Revoir » (moments « n / N », badge, [Lire], [Tableau]) ;
//   3. « Deux assistants en même temps » montre au moins DEUX assistants en mode Simple, avec leur nom accessible : la carte
//      les dessine, et le tableau — la vérité de la vue (P7) — en porte une ligne chacun ;
//   4. ZÉRO requête vers opencode pendant tout cela (journal du faux) et zéro requête de la page ;
//   5. en mode Simple, une démonstration qui dessine une délégation porte l'avis d'U1.
//
// ÉCART consigné : la fiche parle de « deux boutons d'assistant ». Le lecteur des démonstrations (L34) monte `NeonCarte` SANS
// `onOuvrir` : la carte est un dessin, et la vérité reste le tableau (P7, §5.8 l.1009). Le scénario compte donc les assistants
// dessinés ET les lignes du tableau, chacun avec son nom, au lieu de boutons qui n'existent pas dans ce lecteur.
import {
  attendre,
  attendreFinDuTour,
  attendreIa,
  attendreModeAffiche,
  avecTemoinP6,
  cliquerBouton,
  enModeAvance,
  exiger,
  nonJoue,
  oc,
  ouvrirConversation,
  PHRASES,
  preparerPage,
  releve,
  resume,
  texteVisible,
} from "./it1-ui-commun.mjs";
import { preparer3d } from "../lib/webgl.mjs";

/** Sélecteur « Choisir une démonstration » de la boîte (l'autre select de la boîte est la vitesse du lecteur). */
const CHOIX = ".modal .row.wrap select";

/** §5.9 l.1015, D-3d-26 : les trois démonstrations livrées avec l'interface. */
const DEMOS = ["Deux assistants en même temps", "Attente de votre accord", "Arrêt au plafond"];
/** Avis du mode Simple sur une démonstration qui délègue (U1, D-3d-26). */
const AVIS_SIMPLE = "Démonstration enregistrée en mode Avancé : en mode Simple, l'IA ne délègue pas, elle continue seule.";
/** Relecture archivée d'une conversation au repos, 4 s après (classifier.ts, onIdle). */
const ARCHIVAGE_MS = 5_000;

export async function run(ctx) {
  const { cdp } = await preparer3d(ctx);
  try {
    const page = await preparerPage(ctx);
    await avecTemoinP6(ctx, async () => {
      const rootId = await conversation(ctx);
      await ouvrirConversation(ctx, rootId);
      await attendre(ARCHIVAGE_MS);
      await attendreModeAffiche(page, "simple");
      await cliquerBouton(page, "Afficher la carte", { portee: ".neon-band" }).catch(() => {});
      await jouer(ctx, page, { mode: "simple", bouton: "Voir une démonstration : deux assistants en même temps" });
      await enModeAvance(ctx, async () => {
        await attendreModeAffiche(page, "avance");
        await jouer(ctx, page, { mode: "avance", bouton: "Voir une démonstration" });
      });
    });
    ctx.expectNoConsoleErrors();
  } finally {
    await cdp.fermer();
  }
}

/** Une conversation qui a travaillé : la bande néon existe, donc ses commandes aussi. */
async function conversation(ctx) {
  const client = oc(ctx);
  const ia = await attendreIa(ctx);
  const racine = await client.creerConversation("it3-demos");
  const envoi = await client.envoyer(racine.id, "Réponds en une phrase.", ia);
  exiger(envoi.code === 204, `envoi refusé (${envoi.code}) : ${resume(envoi.corps)}`);
  await attendreFinDuTour(client, racine.id);
  return racine.id;
}

/**
 * Repère du journal réseau, sans exiger le calme : d'autres scénarios de la même pile laissent le classement automatique
 * travailler en fond (relectures de la liste des conversations), et ce n'est pas ce que la démonstration mesure.
 */
async function repereReseau(page) {
  await attendre(1_200);
  return page.journalReseau().length;
}

async function jouer(ctx, page, { mode, bouton }) {
  const debut = { page: await repereReseau(page), faux: ctx.mode === "faux" ? (await ctx.opencodeRequests()).length : 0 };

  await cliquerBouton(page, bouton, { portee: ".neon-band" });
  await page.attendreQue("document.querySelector('.modal .neon-band')", { libelle: "boîte de dialogue de la démonstration" });
  const titre = await texteVisible(page, ".modal .modal-header h2");
  exiger(titre === PHRASES.demonstration, `étiquette de la démonstration « ${resume(titre)} » au lieu de « ${PHRASES.demonstration} ».`);

  // 2. Les trois démonstrations sont au choix, et chacune se joue sur le lecteur complet.
  const choix = await page.evaluer(`[...document.querySelectorAll('${CHOIX} option')].map((o) => o.textContent.trim())`);
  for (const attendue of DEMOS) exiger(choix.includes(attendue), `démonstration « ${attendue} » absente du choix : ${resume(choix)}`);
  const vus = [];
  for (const demo of DEMOS) {
    await choisir(page, demo);
    const moments = await texteVisible(page, ".modal .revoir-moments");
    exiger(/^\d+ \/ \d+$/.test(moments), `« ${demo} » : moments « n / N » attendus, lus « ${resume(moments)} ».`);
    const badge = await texteVisible(page, ".modal .revoir-badge");
    exiger(/^EN DIFFÉRÉ ×/.test(badge), `« ${demo} » : badge « EN DIFFÉRÉ ×… » attendu, lu « ${resume(badge)} ».`);
    await cliquerBouton(page, "Lire", { portee: ".modal .revoir-commandes" });
    await attendre(700);
    await cliquerBouton(page, "Figer ici", { portee: ".modal .revoir-commandes" }).catch(() => {});
    vus.push(`${demo} : ${moments}`);
  }

  // 3. « Deux assistants en même temps » : au moins deux assistants dessinés, chacun nommé dans le tableau (P7).
  await choisir(page, DEMOS[0]);
  await allerAuDernierMoment(page);
  const dessines = await page.evaluer("document.querySelectorAll('.modal .neon-map .neon-noeud').length");
  await cliquerBouton(page, "Tableau", { portee: ".modal" });
  await page.attendreQue("document.querySelector('.modal table tbody tr')", { libelle: "tableau de la démonstration" });
  const noms = await page.evaluer("[...document.querySelectorAll('.modal table tbody tr th')].map((c) => c.textContent.trim()).filter(Boolean)");
  exiger(dessines >= 2, `« ${DEMOS[0]} » (${mode}) : ${dessines} assistant(s) dessiné(s), 2 au moins attendus.`);
  exiger(noms.length >= 2, `« ${DEMOS[0]} » (${mode}) : ${noms.length} assistant(s) nommé(s) dans le tableau : ${resume(noms)}`);
  await cliquerBouton(page, "Tableau", { portee: ".modal" });

  // 5. Avis du mode Simple sur une démonstration qui délègue (U1).
  const contenu = await texteVisible(page, ".modal");
  if (mode === "simple") exiger(contenu.includes(AVIS_SIMPLE), `avis du mode Simple absent : ${resume(contenu, 300)}`);
  else exiger(!contenu.includes(AVIS_SIMPLE), "avis du mode Simple affiché en mode Avancé.");

  await page.touche("Escape");
  await page.attendreQue("!document.querySelector('.modal')", { libelle: "démonstration fermée par Échap" });

  // 4. Zéro requête : ni la page, ni opencode.
  await attendre(1_200);
  const nouvelles = page.journalReseau().slice(debut.page);
  const interdites = nouvelles.filter((l) => l.methode !== "GET" || new URL(l.url).pathname !== "/api/conversations");
  exiger(interdites.length === 0, `la page a envoyé ${interdites.length} requête(s) pendant les démonstrations : ${resume(interdites.map((l) => `${l.methode} ${l.url}`))}`);
  if (ctx.mode !== "faux") {
    nonJoue(ctx, "zéro requête reçue par opencode", "le journal du faux n'existe qu'en mode « --faux »");
  } else {
    const recues = (await ctx.opencodeRequests()).slice(debut.faux);
    const surLaDemo = recues.filter((r) => String(r.method).toUpperCase() !== "GET" && r.body?.agent !== "cockpit-classifier");
    exiger(surLaDemo.length === 0, `opencode a reçu ${resume(surLaDemo.map((r) => r.pathname))} pendant les démonstrations.`);
    releve(ctx, `démonstrations ${mode} : ${resume(vus)} ; ${dessines} assistant(s) dessiné(s), ${noms.length} nommé(s) ; 0 requête de la page, ${recues.length} requête(s) de fond reçues par opencode`);
  }
}

/** Choisit une démonstration dans le sélecteur de la boîte. */
async function choisir(page, titre) {
  await page.evaluer(`(() => {
    const select = document.querySelector('${CHOIX}');
    const option = [...select.options].find((o) => o.textContent.trim() === ${JSON.stringify(titre)});
    select.value = option.value;
    select.dispatchEvent(new Event('change', { bubbles: true }));
  })()`);
  await attendre(200);
}

/** Place le lecteur sur le dernier moment : la scène y montre tout ce que la démonstration a dessiné. */
async function allerAuDernierMoment(page) {
  await page.evaluer(`(() => {
    const curseur = document.querySelector('.modal .revoir-curseur');
    curseur.value = curseur.max;
    curseur.dispatchEvent(new Event('input', { bubbles: true }));
    curseur.dispatchEvent(new Event('change', { bubbles: true }));
  })()`);
  await attendre(250);
}
