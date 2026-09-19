// Scénario e2e de l'interface de l'itération 1 (L7b-2) : « Démonstration enregistrée : aucune IA n'est appelée » (zéro requête).
//
// Spécification §6 l.1064 (« Démonstration enregistrée : aucune IA n'est appelée » : lecteur hors ligne ; e2e : zéro requête
// opencode), §5.9 (capture réelle p1 rejouée pas à pas dans la même scène que le direct), §5.7.4 ([Voir une démonstration] en mode
// Simple), décision n° 4 du 19/09 (avis du mode Simple sur la délégation).
//
// Ce que le scénario établit, dans les deux modes (mode Simple d'abord, le défaut, puis Avancé) :
//   1. une conversation a travaillé : la bande néon existe ; [Voir une démonstration] ouvre la boîte de dialogue étiquetée
//      « Démonstration enregistrée : aucune IA n'est appelée » ; en Simple, l'avis « Enregistrée en mode Avancé. En mode Simple, l'IA
//      ne délègue pas : elle continue seule. » ;
//   2. tous les moments sont parcourus ([Moment suivant] jusqu'à [Recommencer]) : la carte dessine les deux délégations de la
//      capture p1 (consignes « en même temps », résultats), puis [Tableau] ; captures des six tailles (Simple) ; Échap ferme ;
//   3. ZÉRO requête : pendant toute la démonstration, la page n'envoie rien (journal réseau de l'onglet), et opencode ne reçoit ni
//      requête sur la conversation ouverte, ni demande d'IA autre que celles du classement automatique du cockpit (tâche de fond du
//      serveur, indépendante de la page, qui peut tomber pendant une longue exécution du banc) ;
//   4. aucune violation de la CSP, console muette.
// Le lecteur ne dépend pas d'opencode : le scénario est joué dans tous les modes du banc ; les relevés du faux opencode ne sont
// possibles qu'en « --faux ».
import {
  attendre,
  attendreFinDuTour,
  attendreIa,
  attendreModeAffiche,
  attendreReseauCalme,
  attendreTexte,
  cliquerBouton,
  enModeAvance,
  exiger,
  exigerAucuneViolationCsp,
  LARGE,
  oc,
  ouvrirConversation,
  PHRASES,
  preparerPage,
  releve,
  resume,
  texteVisible,
} from "./it1-ui-commun.mjs";

/** Envois d'une conversation qui appellent une IA (méthode POST). */
const ROUTES_IA = /^\/session\/[^/]+\/(prompt_async|command|summarize|shell|message)$/;
/** Relecture archivée d'une conversation au repos, 4 s après (classifier.ts, onIdle), suivie d'une relecture de la liste. */
const ARCHIVAGE_MS = 5_000;

export async function run(ctx) {
  const page = await preparerPage(ctx);
  const ia = await attendreIa(ctx);
  const client = oc(ctx);

  // 1. Une conversation qui a travaillé (un tour de texte) : la bande néon a un fait à dessiner. Son archivage passé, la page est
  // au calme.
  const racine = await client.creerConversation("it1-ui-demonstration");
  const envoi = await client.envoyer(racine.id, "Réponds en une phrase.", ia);
  exiger(envoi.code === 204, `envoi refusé (${envoi.code}) : ${resume(envoi.corps)}`);
  await attendreFinDuTour(client, racine.id);
  await ouvrirConversation(ctx, racine.id);
  await attendre(ARCHIVAGE_MS);

  // Mode Simple (défaut) : bande repliée, [Afficher la carte], puis le bouton de la note.
  await attendreModeAffiche(page, "simple");
  await cliquerBouton(page, "Afficher la carte", { portee: ".neon-band" });
  await jouerDemonstration(ctx, racine.id, { mode: "simple", bouton: "Voir une démonstration : deux assistants en même temps", captures: true });

  // Mode Avancé : bande dépliée, [Voir une démonstration] dans ses commandes.
  await enModeAvance(ctx, async () => {
    await attendreModeAffiche(page, "avance");
    await jouerDemonstration(ctx, racine.id, { mode: "avance", bouton: "Voir une démonstration", captures: false });
  });
  await exigerAucuneViolationCsp(page);
  ctx.expectNoConsoleErrors();
}

async function jouerDemonstration(ctx, rootId, { mode, bouton, captures }) {
  const page = ctx.navigateur;
  await page.attendreQue(`[...document.querySelectorAll(".neon-band button")].some((b) => b.textContent.trim() === ${JSON.stringify(bouton)})`, {
    libelle: `bouton « ${bouton} » de la bande (${mode})`,
  });

  // Point de départ : page au calme (flux d'événements mis à part), relevés du faux notés.
  const debut = { page: await attendreReseauCalme(page), faux: ctx.mode === "faux" ? (await ctx.opencodeRequests()).length : 0 };

  // 2. La démonstration : étiquette, avis du mode Simple, tous les moments, tableau, fermeture par Échap.
  await cliquerBouton(page, bouton, { portee: ".neon-band" });
  await page.attendreQue("document.querySelector('.modal .neon-band')", { libelle: "boîte de dialogue de la démonstration" });
  const titre = await texteVisible(page, ".modal .modal-header h2");
  exiger(titre === PHRASES.demonstration, `titre de la démonstration « ${titre} » au lieu de « ${PHRASES.demonstration} ».`);
  const contenu = await texteVisible(page, ".modal");
  const avis = `Enregistrée en mode Avancé. ${PHRASES.avisSimple}`;
  if (mode === "simple") exiger(contenu.includes(avis), `avis du mode Simple absent : ${resume(contenu, 400)}`);
  else exiger(!contenu.includes(PHRASES.avisSimple), "avis du mode Simple affiché en mode Avancé.");
  const total = await parcourirMoments(ctx, mode, captures);
  await cliquerBouton(page, "Tableau", { portee: ".modal" });
  await page.attendreQue("document.querySelector('.modal table')", { libelle: "tableau de la démonstration" });
  await page.touche("Escape");
  await page.attendreQue("!document.querySelector('.modal')", { libelle: "démonstration fermée par Échap" });

  // 3. Zéro requête.
  await exigerZeroRequete(ctx, rootId, debut, `démonstration ${mode} : ${total} moments`);
}

/** Parcourt tous les moments ([Moment suivant] jusqu'à [Recommencer]) et vérifie ce que la carte dessine ; rend leur nombre. */
async function parcourirMoments(ctx, mode, captures) {
  const page = ctx.navigateur;
  const compteur = /Moment 1 \/ (\d+)/.exec(await texteVisible(page, ".modal"));
  exiger(compteur, "compteur des moments illisible.");
  const total = Number(compteur[1]);
  exiger(total >= 3, `démonstration de ${total} moment(s) seulement.`);
  const vus = { consigne: 0, resultat: 0, enMemeTemps: false };
  for (let n = 1; n <= total; n++) {
    await attendreTexte(page, `Moment ${n} / ${total}`, { selecteur: ".modal" });
    const classes = await page.evaluer("[...document.querySelectorAll('.modal .neon-map .neon-faisceau')].map((g) => g.getAttribute('class'))");
    vus.consigne += classes.filter((c) => c.includes("is-consigne")).length;
    vus.resultat += classes.filter((c) => c.includes("is-resultat")).length;
    // La carte est un SVG : son texte se lit par textContent (innerText n'existe que sur les éléments HTML).
    vus.enMemeTemps ||= (await page.evaluer("document.querySelector('.modal .neon-map')?.textContent ?? ''")).includes("en même temps");
    if (captures && n === Math.ceil(total / 2)) {
      exiger((await ctx.screenshot(`demonstration-${mode}`)).length === 6, "6 captures attendues de la démonstration.");
      await page.taille(LARGE);
    }
    if (n < total) await cliquerBouton(page, "Moment suivant", { portee: ".modal" });
  }
  exiger(vus.consigne > 0 && vus.resultat > 0, `démonstration sans consigne ou sans résultat dessinés : ${resume(vus)}`);
  exiger(vus.enMemeTemps, "les deux délégations de la capture p1 ne sont pas marquées « en même temps ».");
  const recommencer = "[...document.querySelectorAll('.modal button')].some((b) => b.textContent.trim() === 'Recommencer')";
  exiger(await page.evaluer(recommencer), "[Recommencer] absent au dernier moment.");
  return total;
}

/**
 * Zéro requête pendant la démonstration : la page ne fait que relire la liste des conversations (GET /api/conversations, base du
 * cockpit) si un événement du serveur tombe pendant ce temps (classement d'une autre conversation) ; elle n'envoie rien d'autre.
 * Côté opencode (« --faux ») : aucune requête sur la conversation, aucune demande d'IA hors du classement automatique.
 */
async function exigerZeroRequete(ctx, rootId, debut, libelle) {
  const page = ctx.navigateur;
  await attendreReseauCalme(page, { calmeMs: 1_000 });
  const nouvelles = page.journalReseau().slice(debut.page);
  const interdites = nouvelles.filter((l) => l.methode !== "GET" || new URL(l.url).pathname !== "/api/conversations");
  const liste = interdites.map((l) => `${l.methode} ${l.url}`);
  exiger(interdites.length === 0, `la page a envoyé ${interdites.length} requête(s) pendant la démonstration : ${resume(liste)}`);
  if (ctx.mode !== "faux") {
    releve(ctx, `${libelle}, ${nouvelles.length} requête(s) de la page`);
    return;
  }
  const recues = (await ctx.opencodeRequests()).slice(debut.faux);
  const surLaConversation = recues.filter((r) => String(r.pathname).includes(rootId) || JSON.stringify(r.query ?? {}).includes(rootId));
  exiger(surLaConversation.length === 0, `opencode a reçu ${resume(surLaConversation.map((r) => r.pathname))} sur la conversation pendant la démonstration.`);
  const appelsIa = recues.filter((r) => String(r.method).toUpperCase() === "POST" && ROUTES_IA.test(r.pathname ?? "") && r.body?.agent !== "cockpit-classifier");
  exiger(appelsIa.length === 0, `demande(s) d'IA reçue(s) par opencode pendant la démonstration : ${resume(appelsIa.map((r) => r.pathname))}`);
  releve(ctx, `${libelle}, ${nouvelles.length} requête(s) de la page, ${recues.length} requête(s) de fond reçues par opencode (aucune sur la conversation, aucun appel d'IA)`);
}
