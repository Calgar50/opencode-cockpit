// Scénario e2e de « Revoir » (itération 3, paquet L35) : le lecteur complet en 2D, les consignes gardées, et la lecture seule.
//
// Spécification §5.8 l.998 (moments, vitesses, badge « EN DIFFÉRÉ »), §5.9 l.1018-1024 (lecture seule, bandeau), §6 l.1065
// (« Revoir : rien n'est relancé ni facturé »), §7.7 l.1174 ; décision U2 (copie locale des consignes, [Voir la consigne] sans
// aucune requête à opencode) ; plan it3 fiche L35, D-3d-11, D-3d-12, D-3d-30 ; décision n° 7 (vocabulaire du mode Simple).
//
// Ce que le scénario établit (« --faux ») :
//   1. [Revoir cette demande] s'ouvre DEPUIS LA BANDE et DEPUIS LES ARCHIVES ; la boîte porte le bandeau
//      « Revoir : rien n'est relancé ni facturé » ;
//   2. le lecteur : moments « n / N », ← et → quand le curseur a le focus (et à ce moment-là seulement), les cinq vitesses,
//      badge « EN DIFFÉRÉ ×… · hh:mm:ss », et l'étiquette d'un écart raccourci sur une suite qui attend 6 s ;
//   3. le zoom 3 s'ouvre DANS la boîte (PanneauRevoir) et n'y montre aucun texte de message :
//      « Texte non affiché pendant « Revoir » : rien n'est redemandé ni relancé. » ;
//   4. [Voir la consigne] (U2) s'ouvre depuis une légende ET depuis le zoom 3 : le texte de la consigne scriptée est affiché
//      depuis la copie gardée par le cockpit, et une consigne de 9 000 caractères porte « Consigne tronquée : … » ;
//   5. ENTRE L'OUVERTURE ET LA FERMETURE de la boîte, le navigateur n'envoie QUE des « GET /api/revoir/… » (consignes
//      comprises) : aucune requête « /api/oc/ », aucun « …/facts », rien d'autre — la relecture de SA propre liste par la page
//      du chat (GET /api/archive, déclenchée par un classement) est comptée à part, la boîte ne pouvant pas l'émettre ; le faux
//      opencode ne reçoit RIEN sur la conversation revue et aucun appel d'IA (hors le classement automatique du cockpit, qui
//      travaille en fond sur les conversations des scénarios précédents), et le journal des dépenses ne bouge pas ;
//   6. en mode Simple, sur une racine principale : le bandeau est là et aucun mot interdit en mode Simple n'entre dans la boîte.
//
// ÉCART consigné : la fiche cite « /api/costs » pour le journal des dépenses ; la route du cockpit est
// « GET /api/usage/summary » (et « /api/usage/session/:rootId »), lues ici avant et après.
import {
  attendre,
  attendreDemandes,
  attendreFinDuTour,
  attendreIa,
  attendreModeAffiche,
  attendreQue,
  attendreReseauCalme,
  avecTemoinP6,
  cliquerBouton,
  demandeDeDelegation,
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
import { preparer3d, reseau } from "../lib/webgl.mjs";

const DESCRIPTION = "Relire le dossier complet";
/** Consigne scriptée de 9 000 caractères : la copie gardée est bornée à 8 000 (CONSIGNES.maxCaracteres, D-3d-30). */
const CONSIGNE = `Relis le dossier et dis ce qui manque. ${"Prends le temps de tout relire. ".repeat(300)}`.slice(0, 9_000);
/** Attente du sous-assistant : plus de 4 s, donc un moment raccourci et son étiquette (D-3d-11). */
const TRAVAIL_MS = 6_000;
/** Pas du tour du faux : chaque groupe d'événements est séparé de 5 s, ce qui garantit des écarts de plus de 4 s. */
const PAS_MS = 5_000;
/** Écart au-delà duquel un moment est raccourci (server/shared/revoir.ts, RACCOURCI.seuilMs). */
const SEUIL_RACCOURCI_MS = 4_000;
/** Relecture archivée d'une conversation au repos (classifier.ts, onIdle), suivie d'une relecture de la liste. */
const ARCHIVAGE_MS = 5_000;
/** Routes d'opencode qui font travailler une IA (mêmes que le scénario des démonstrations). */
const ROUTES_IA = /^\/session\/[^/]+\/(prompt_async|command|summarize|shell|message)$/;
/** §2.3 l.102 : quelques mots interdits en mode Simple, écrits ici en clair. */
const INTERDITS_SIMPLE = [/\bagents?\b/i, /\bsous-agents?\b/i, /\bsessions?\b/i, /\bpermissions?\b/i, /\bit[ée]rations?\b/i, /\bn(?:œ|oe)uds?\b/i];

/** Délégation scriptée dont la consigne transmise à l'enfant est choisie (source de la copie gardée, U2). */
const tache = (description, cible, prompt, enfant) => ({
  tool: "task",
  input: { description, prompt, subagent_type: cible },
  ask: { permission: "task", patterns: [cible], metadata: { description, subagent_type: cible } },
  askAfterMs: 5,
  child: { agent: cible, ...enfant },
});

export async function run(ctx) {
  const { cdp } = await preparer3d(ctx);
  try {
    if (ctx.mode !== "faux") {
      nonJoue(ctx, "« Revoir » d'une délégation", "le faux fournisseur ne délègue pas : aucune consigne gardée à relire");
      ctx.expectNoConsoleErrors();
      return;
    }
    const journal = await reseau(cdp);
    const page = await preparerPage(ctx);
    let rootId = null;
    await avecTemoinP6(ctx, async () => {
      rootId = await deleguer(ctx, page);
    });
    // La bande n'est dépliée d'office qu'en mode Avancé : ses commandes ([Revoir cette demande]) y sont donc atteignables.
    await enModeAvance(ctx, async () => {
      await attendreModeAffiche(page, "avance");
      await lecteurDepuisLaBande(ctx, page, journal, rootId);
      await depuisLesArchives(ctx, page, rootId);
    });
    await enSimple(ctx, page, rootId);
    ctx.expectNoConsoleErrors();
  } finally {
    await cdp.fermer();
  }
}

/** Conversation qui délègue une fois, avec une consigne de 9 000 caractères et 6 s de travail. */
async function deleguer(ctx, page) {
  return await enModeAvance(ctx, async () => {
    await attendreModeAffiche(page, "avance");
    const ia = await attendreIa(ctx);
    const client = oc(ctx);
    const racine = await client.creerConversation("it3-revoir");
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
    // Le classement automatique tombe 4 s après le repos : la page est laissée calme avant la mesure de réseau.
    await attendre(ARCHIVAGE_MS);
    return racine.id;
  });
}

/**
 * Attend que le classement automatique de la conversation soit écrit (`classifiedAt` posé). Le cockpit émet alors
 * « conversation.classified », et la page du chat relit sa liste 500 ms plus tard : passé ce point, la mesure du réseau de
 * « Revoir » ne subit plus cette relecture. Lu par l'API du banc, jamais par la page : la mesure du navigateur reste intacte.
 * Sans classement au bout de 30 s (classement coupé, pile chargée), on continue : le contrôle du réseau, lui, reste entier.
 */
async function attendreClassement(ctx, rootId) {
  const classe = async () => {
    const detail = await ctx.api.get(`/api/archive/${encodeURIComponent(rootId)}`).catch(() => null);
    return (detail?.conversation?.classifiedAt ?? null) !== null;
  };
  await attendreQue(classe, { libelle: "classement automatique de la conversation", delaiMs: 30_000 }).catch(() => false);
}

/** 1 à 5 : la boîte ouverte depuis la bande, le lecteur, les consignes, et le réseau du navigateur. */
async function lecteurDepuisLaBande(ctx, page, journal, rootId) {
  await ouvrirConversation(ctx, rootId);
  // Le classement automatique de CETTE conversation écrit son archive, puis le cockpit émet « conversation.classified » et la page
  // du chat relit sa liste 500 ms plus tard (ChatPage.tsx) : attendu ICI, il ne tombe pas au milieu de la mesure de réseau.
  await attendreClassement(ctx, rootId);
  // Le classement automatique d'autres conversations de la pile peut travailler en fond : on attend le calme sans l'exiger.
  await attendreReseauCalme(page, { calmeMs: 1_500 }).catch(() => attendre(1_500));
  const avant = {
    reseau: journal.depuis(),
    faux: (await ctx.opencodeRequests()).length,
    usage: await ctx.api.get("/api/usage/summary"),
    session: await ctx.api.get(`/api/usage/session/${encodeURIComponent(rootId)}`).catch(() => null),
  };

  await cliquerBouton(page, "Revoir cette demande", { portee: ".neon-band" });
  await page.attendreQue("document.querySelector('.revoir-boite')", { libelle: "boîte de dialogue « Revoir »" });
  const bandeau = await texteVisible(page, ".revoir-boite .revoir-bandeau");
  exiger(bandeau === "Revoir : rien n'est relancé ni facturé", `bandeau de « Revoir » : « ${resume(bandeau)} ».`);

  await lecteur(ctx, page, await momentsDeLaConversation(ctx, rootId));
  await consignes(ctx, page);

  // 5. Réseau du navigateur entre l'ouverture et la fermeture : GET /api/revoir/… et rien d'autre.
  await attendre(500);
  // Le flux d'événements (`/api/events`) est le canal permanent de la page, ouvert bien avant la boîte : une reconnexion n'est
  // pas une requête de « Revoir ». Tout le reste est interdit : aucune `/api/oc/`, aucun `…/facts`, rien d'autre.
  const chemin = (ligne) => new URL(ligne.url).pathname;
  // La PAGE DU CHAT qui porte la bande relit sa propre liste de conversations (GET /api/archive) 500 ms après un événement
  // « conversation.classified » ou « conversation.updated » du cockpit — le classement d'une autre conversation de la pile, par
  // exemple (ChatPage.tsx). Ce n'est jamais une lecture de « Revoir » : la boîte ne connaît que `salle3dApi`, c'est-à-dire
  // « GET /api/revoir/… », ce que le croisement de la vague 3 vérifie dans le code (aucune route d'archive sous le dossier `revoir/`). Elle
  // est donc comptée à part et consignée, jamais confondue avec une lecture de la boîte ; tout le reste reste interdit.
  const listeDuChat = (ligne) => ligne.methode === "GET" && chemin(ligne) === "/api/archive";
  const relectures = journal.lignes(avant.reseau).filter(listeDuChat).length;
  const lignes = journal.lignes(avant.reseau).filter((ligne) => chemin(ligne).startsWith("/api/") && chemin(ligne) !== "/api/events" && !listeDuChat(ligne));
  const permises = lignes.filter((ligne) => ligne.methode === "GET" && chemin(ligne).startsWith("/api/revoir/"));
  const autres = lignes.filter((ligne) => !permises.includes(ligne));
  exiger(autres.length === 0, `requête(s) autres que « GET /api/revoir/… » pendant « Revoir » : ${resume(autres.map((l) => `${l.methode} ${chemin(l)}`))}`);
  exiger(permises.length > 0, "aucune lecture « GET /api/revoir/… » : la boîte n'a rien lu, contrôle vide.");
  const consignesLues = permises.filter((ligne) => chemin(ligne).includes("/consignes")).length;
  exiger(consignesLues > 0, "aucune lecture « GET /api/revoir/…/consignes/… » : [Voir la consigne] n'a pas lu la copie gardée.");

  const apres = {
    faux: (await ctx.opencodeRequests()).length,
    usage: await ctx.api.get("/api/usage/summary"),
    session: await ctx.api.get(`/api/usage/session/${encodeURIComponent(rootId)}`).catch(() => null),
  };
  // Ce que le faux a reçu pendant la boîte est ATTRIBUÉ, comme dans le scénario des démonstrations : RIEN sur la conversation
  // revue, et AUCUN appel d'IA — hors le classement automatique du cockpit (`cockpit-classifier`), qui relit en fond les
  // conversations de la pile laissées par les scénarios précédents et n'a rien à voir avec « Revoir ».
  const recues = (await ctx.opencodeRequests()).slice(avant.faux);
  const surLaConversation = recues.filter((r) => `${r.pathname} ${JSON.stringify(r.query ?? {})} ${JSON.stringify(r.body ?? {})}`.includes(rootId));
  exiger(surLaConversation.length === 0, `opencode a reçu ${resume(surLaConversation.map((r) => `${r.method} ${r.pathname}`))} sur la conversation pendant « Revoir ».`);
  const appelsIa = recues.filter((r) => String(r.method).toUpperCase() === "POST" && ROUTES_IA.test(r.pathname ?? "") && r.body?.agent !== "cockpit-classifier");
  exiger(appelsIa.length === 0, `demande(s) d'IA reçue(s) par opencode pendant « Revoir » : ${resume(appelsIa.map((r) => r.pathname))}`);
  exiger(apres.usage?.spentUsd === avant.usage?.spentUsd, `le journal des dépenses a bougé pendant « Revoir » : ${avant.usage?.spentUsd} → ${apres.usage?.spentUsd}.`);
  exiger(JSON.stringify(apres.session) === JSON.stringify(avant.session), "une ligne « usage » a été écrite sur la conversation pendant « Revoir ».");
  releve(
    ctx,
    `« Revoir » depuis la bande : ${permises.length} lecture(s) /api/revoir (dont ${consignesLues} consigne(s)), ${relectures} relecture(s) de la liste du chat, ${recues.length} requête(s) de fond reçues par le faux (aucune sur la conversation, aucun appel d'IA), dépenses inchangées`,
  );

  await page.touche("Escape");
  await page.attendreQue("!document.querySelector('.revoir-boite')", { libelle: "boîte fermée par Échap" });
}

/**
 * Moments de la conversation, calculés comme `moments()` de neon-scene.ts (coupures nettes de la suite des faits), à partir des
 * faits lus par « Revoir ». Sert à viser le moment qui précède un écart de plus de 4 s, sans tâtonner sur le curseur.
 */
async function momentsDeLaConversation(ctx, rootId) {
  const faits = (await ctx.api.get(`/api/revoir/${encodeURIComponent(rootId)}`))?.facts ?? [];
  const instants = faits.map((fait) => fait.at);
  const coupures = [];
  let maximum = Number.NEGATIVE_INFINITY;
  for (let i = 0; i < instants.length; i++) {
    maximum = Math.max(maximum, instants[i]);
    const reste = instants.slice(i + 1);
    const minimum = reste.length === 0 ? Number.POSITIVE_INFINITY : Math.min(...reste);
    if (minimum > maximum && coupures.at(-1) !== maximum) coupures.push(maximum);
  }
  return coupures;
}

/** 2 : moments, ← et →, vitesses, badge « EN DIFFÉRÉ », étiquette d'un écart raccourci. */
async function lecteur(ctx, page, moments) {
  const barre = ".revoir-boite .revoir-bar";
  await page.attendreQue(`document.querySelector('${barre} .revoir-curseur')`, { libelle: "barre du lecteur" });
  const rang = await texteVisible(page, `${barre} .revoir-moments`);
  exiger(/^\d+ \/ \d+$/.test(rang), `moments « n / N » attendus, lus « ${resume(rang)} ».`);
  const total = Number(await page.evaluer(`document.querySelector('${barre} .revoir-curseur').max`));
  exiger(total >= 3, `« Revoir » ouvert sur ${total} moment(s) : trop peu pour le lecteur.`);

  // ← et → : seulement quand le curseur a le focus (§5.5 l.917). Sans focus, la touche ne bouge rien.
  await page.evaluer("document.activeElement.blur()");
  const fige = Number(await page.evaluer(`document.querySelector('${barre} .revoir-curseur').value`));
  await page.touche("ArrowLeft");
  await attendre(250);
  exiger(Number(await page.evaluer(`document.querySelector('${barre} .revoir-curseur').value`)) === fige, "← a bougé le curseur sans qu'il ait le focus.");
  await page.evaluer(`document.querySelector('${barre} .revoir-curseur').focus()`);
  await page.touche("ArrowLeft");
  const recule = await attendreQue(
    async () => {
      const valeur = Number(await page.evaluer(`document.querySelector('${barre} .revoir-curseur')?.value ?? -1`));
      return valeur !== fige ? valeur : false;
    },
    { libelle: "moment reculé par ←" },
  );
  exiger(recule === fige - 1, `← : moment ${fige} → ${recule}.`);
  await page.touche("ArrowRight");
  await attendreQue(async () => Number(await page.evaluer(`document.querySelector('${barre} .revoir-curseur')?.value ?? -1`)) === fige, { libelle: "moment avancé par →" });

  // Vitesses et badge « EN DIFFÉRÉ ×… · hh:mm:ss ».
  const badges = [];
  for (const [valeur, ecrit] of [["0.25", "×0,25"], ["0.5", "×0,5"], ["1", "×1"], ["2", "×2"], ["4", "×4"]]) {
    await page.evaluer(`(() => { const s = document.querySelector('${barre} select'); s.value = ${JSON.stringify(valeur)}; s.dispatchEvent(new Event('change', { bubbles: true })); })()`);
    await attendre(150);
    const badge = await texteVisible(page, `${barre} .revoir-badge`);
    exiger(new RegExp(`^EN DIFFÉRÉ ${ecrit.replace("×", "×")} · \\d{2}:\\d{2}:\\d{2}$`).test(badge), `badge attendu « EN DIFFÉRÉ ${ecrit} · hh:mm:ss », lu « ${resume(badge)} ».`);
    badges.push(badge);
  }

  // Étiquette d'un écart raccourci : le lecteur est promené sur chacun de ses moments, et l'étiquette relevée à chaque fois.
  // Les moments de la boîte sont ceux de la DEMANDE choisie (momentsDeLaFenetre), pas forcément toute la conversation.
  const ecarts = moments.slice(1).map((instant, i) => Math.round(instant - moments[i]));
  exiger(
    ecarts.some((ecart) => ecart > SEUIL_RACCOURCI_MS),
    `la conversation n'a aucun écart de plus de ${SEUIL_RACCOURCI_MS / 1000} s entre deux moments : ${resume(ecarts)}`,
  );
  // Le curseur est un vrai curseur : il se déplace AU CLAVIER, comme le ferait la personne (une valeur posée par programme ne
  // déclenche pas son changement). Le lecteur est ramené au premier moment, puis avancé d'un moment à la fois.
  await page.evaluer(`document.querySelector('${barre} .revoir-curseur').focus()`);
  for (let pas = 0; pas < total; pas++) await page.touche("ArrowLeft");
  const releves = [];
  let etiquette = "";
  for (let pas = 0; pas < total; pas++) {
    await attendre(200);
    const vu = {
      rang: await page.evaluer(`document.querySelector('${barre} .revoir-curseur').value`),
      raccourci: await texteVisible(page, `${barre} .revoir-raccourci`),
    };
    releves.push(vu);
    if (vu.raccourci !== "") etiquette = vu.raccourci;
    await page.touche("ArrowRight");
  }
  exiger(
    /sans nouvel événement, montrées en 1 s$/.test(etiquette),
    `aucune étiquette de raccourci sur les ${total} moments (écarts de la conversation : ${resume(ecarts)}) ; relevé : ${resume(releves, 600)}`,
  );
  releve(ctx, `lecteur : ${rang}, ${total} moments, écarts ${resume(ecarts)} ; vitesses ${resume(badges.map((b) => b.split(" ")[2]))} ; raccourci « ${etiquette} »`);
}

/** 3 et 4 : zoom 3 dans la boîte, puis [Voir la consigne] depuis le zoom 3 et depuis une légende (U2). */
async function consignes(ctx, page) {
  const boite = ".revoir-boite";
  // Les légendes sont celles du MOMENT montré : le lecteur est reculé, au clavier, jusqu'à celui où la consigne est confiée.
  await page.evaluer(`document.querySelector('${boite} .revoir-curseur').focus()`);
  const total = Number(await page.evaluer(`document.querySelector('${boite} .revoir-curseur').max`));
  let trouve = false;
  for (let pas = 0; pas < total && !trouve; pas++) {
    trouve = await page.evaluer(`Boolean(document.querySelector('${boite} .revoir-legendes button'))`);
    if (!trouve) await page.touche("ArrowLeft");
    await attendre(150);
  }
  exiger(trouve, "aucun moment de « Revoir » n'offre [Voir la consigne] dans ses légendes.");
  await page.attendreQue(`document.querySelectorAll('${boite} .neon-nodes button').length > 1`, { libelle: "assistants de la carte de « Revoir »" });
  await page.evaluer(`document.querySelectorAll('${boite} .neon-nodes button')[1].click()`);
  await page.attendreQue(`document.querySelector('${boite} .revoir-panneau')`, { libelle: "zoom 3 (PanneauRevoir) dans la boîte" });
  const panneau = await texteVisible(page, `${boite} .revoir-panneau`);
  exiger(panneau.includes("Texte non affiché pendant « Revoir »"), `le zoom 3 de « Revoir » montre un texte de message : ${resume(panneau, 300)}`);

  // [Voir la consigne] depuis le zoom 3.
  await cliquerBouton(page, "Voir la consigne", { portee: `${boite} .revoir-panneau` });
  const depuisZoom3 = await lireConsigne(page);
  exiger(depuisZoom3.includes("Relis le dossier et dis ce qui manque."), `texte de la consigne scriptée absent du zoom 3 : ${resume(depuisZoom3, 200)}`);
  const tronquee = await texteVisible(page, `${boite} .consigne-revoir-tronquee`);
  exiger(tronquee.startsWith("Consigne tronquée :"), `mention de troncature attendue sur une consigne de 9 000 caractères, lue « ${resume(tronquee)} ».`);
  await cliquerBouton(page, "Fermer la consigne", { portee: boite });
  await page.attendreQue(`!document.querySelector('${boite} .consigne-revoir')`, { libelle: "consigne fermée" });

  // Retour à la carte ([Afficher la carte] du panneau), puis [Voir la consigne] depuis une légende.
  await cliquerBouton(page, "Afficher la carte", { portee: `${boite} .revoir-panneau-tete` });
  await page.attendreQue(`document.querySelector('${boite} .revoir-legendes button')`, { libelle: "légende avec [Voir la consigne]" });
  await cliquerBouton(page, "Voir la consigne", { portee: `${boite} .revoir-legendes` });
  const depuisLegende = await lireConsigne(page);
  exiger(depuisLegende.includes("Relis le dossier et dis ce qui manque."), `texte de la consigne absent depuis la légende : ${resume(depuisLegende, 200)}`);
  releve(ctx, `[Voir la consigne] : ${depuisZoom3.length} caractères depuis le zoom 3, ${depuisLegende.length} depuis la légende ; « ${resume(tronquee, 80)} »`);
  await cliquerBouton(page, "Fermer la consigne", { portee: boite });
}

/** Texte de la copie gardée, lu dans le panneau de la consigne. */
async function lireConsigne(page) {
  await page.attendreQue("document.querySelector('.revoir-boite .consigne-revoir-texte')", { libelle: "texte de la consigne gardée" });
  return await page.evaluer("document.querySelector('.revoir-boite .consigne-revoir-texte').textContent");
}

/** 1 (suite) : [Revoir cette demande] depuis les Archives. */
async function depuisLesArchives(ctx, page, rootId) {
  await page.evaluer(`location.hash = ${JSON.stringify(`#/archives/${rootId}`)}`);
  await page.attendreQue("document.querySelector('.revoir-entree[data-placement=\"archives\"] button')", { libelle: "[Revoir cette demande] des Archives" });
  await cliquerBouton(page, "Revoir cette demande", { portee: ".revoir-entree[data-placement='archives']" });
  await page.attendreQue("document.querySelector('.revoir-boite')", { libelle: "boîte « Revoir » ouverte depuis les Archives" });
  const bandeau = await texteVisible(page, ".revoir-boite .revoir-bandeau");
  exiger(bandeau === "Revoir : rien n'est relancé ni facturé", `bandeau des Archives : « ${resume(bandeau)} ».`);
  // Les faits de la conversation sont lus à l'ouverture : la barre du lecteur n'existe qu'une fois la lecture rendue.
  await page.attendreQue("document.querySelector('.revoir-boite .revoir-bar .revoir-moments')", { libelle: "lecteur de « Revoir » ouvert depuis les Archives" });
  const moments = await texteVisible(page, ".revoir-boite .revoir-moments");
  exiger(/^\d+ \/ \d+$/.test(moments), `moments « n / N » attendus depuis les Archives, lus « ${resume(moments)} ».`);
  releve(ctx, `« Revoir » depuis les Archives : ${moments}`);
  await page.touche("Escape");
  await page.attendreQue("!document.querySelector('.revoir-boite')", { libelle: "boîte fermée" });
}

/** 6 : en mode Simple, sur une racine principale, bandeau et vocabulaire du mode Simple (décision n° 7). */
async function enSimple(ctx, page, rootId) {
  await attendreModeAffiche(page, "simple");
  await ouvrirConversation(ctx, rootId);
  await cliquerBouton(page, "Afficher la carte", { portee: ".neon-band" }).catch(() => {});
  await cliquerBouton(page, "Revoir cette demande", { portee: ".neon-band" });
  // La boîte est lue une fois son contenu chargé : un contrôle de vocabulaire sur une boîte encore vide ne prouverait rien.
  await page.attendreQue("document.querySelector('.revoir-boite .revoir-bar .revoir-moments')", { libelle: "lecteur de « Revoir » en mode Simple" });
  await page.attendreQue("document.querySelectorAll('.revoir-boite .neon-nodes button').length > 0", { libelle: "assistants dessinés en mode Simple" });
  const texte = await texteVisible(page, ".revoir-boite");
  exiger(texte.includes("Revoir : rien n'est relancé ni facturé"), "bandeau de « Revoir » absent en mode Simple.");
  exiger(texte.length > 200, `boîte de « Revoir » presque vide en mode Simple (${texte.length} caractères) : contrôle de vocabulaire sans objet.`);
  const fautes = INTERDITS_SIMPLE.filter((motif) => motif.test(texte)).map(String);
  exiger(fautes.length === 0, `mot(s) interdit(s) en mode Simple dans « Revoir » : ${resume(fautes)}`);
  releve(ctx, `« Revoir » en mode Simple : bandeau présent, aucun mot interdit sur ${texte.length} caractères`);
  await page.touche("Escape");
  await page.attendreQue("!document.querySelector('.revoir-boite')", { libelle: "boîte fermée en mode Simple" });
}
