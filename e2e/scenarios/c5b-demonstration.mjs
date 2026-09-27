// Scénario e2e de l'itération 5 (paquet L50b) : la DÉMONSTRATION d'équipe, et les ÉQUIPES FERMÉES EN MODE SIMPLE
// (spécification §5.3 l.896, §5.4 l.909, §5.9 l.1013-1017, §5.5, §6 l.1064 ; conception C §17.3 n° 7 ; plan d'exécution it5,
// fiche L49 ; décisions U1 et D-5-24).
//
// Ce que le scénario établit, dans la vraie pile :
//   1. ÉQUIPES FERMÉES EN SIMPLE, sans aucune bascule : l'onglet Équipes montre la phrase de l'itération 4, la galerie, la
//      démonstration et l'éditeur guidé n'y sont pas, la saisie du chat n'a pas de lanceur, et l'avis de délégation garde
//      son texte COURT. `EQUIPES_SIMPLE_OUVERTES` reste faux dans le dépôt : rien ici ne le change ;
//   2. les EXEMPLES livrés sont valides EN SIMPLE (aucun problème bloquant à l'aperçu, qui n'est pas une route fermée) :
//      l'ouverture ne demandera pas de les réécrire ;
//   3. l'OUVERTURE TIENT EN UNE LIGNE : si la pile est bâtie depuis la copie jetable où la constante vaut `true`
//      (`GET /api/teams` l'annonce), le lanceur, la galerie, la démonstration et l'éditeur guidé apparaissent EN SIMPLE
//      sans autre changement. Sinon, le scénario le dit et ne joue pas cette partie, comme `it4-simple-ouvert` ;
//   4. la DÉMONSTRATION d'équipe (mode Avancé) : le lecteur pas à pas, la carte d'exécution et le Déroulé sous la bande,
//      la ligne « Déroulé enregistré avec des données fictives. », et ZÉRO requête — ni de la page, ni vers opencode, lu
//      sur le journal réseau du banc (toutes les requêtes reçues par le faux, hors le seul fond permanent) ;
//   5. en MOUVEMENT RÉDUIT, posé avant l'ouverture comme un réglage du système, il n'y a AUCUNE LECTURE AUTOMATIQUE : le
//      moment affiché ne bouge pas tout seul, et rien n'anime. La démonstration n'avance que quand VOUS la faites avancer
//      (§5.5). Le lecteur n'a d'ailleurs aucune lecture automatique dans AUCUN mode (DemoPlayer, TeamDemo) : le relevé
//      établit l'exigence, il ne compare pas deux réglages.
import { attendre, delegation, exiger, oc, releve, resume } from "./it1-api-commun.mjs";
import { attendreIa, attendreModeAffiche, attendreReseauCalme, LARGE, preparerPage } from "./it1-ui-commun.mjs";
import { classementAutomatique, enAvance, equipes, ouvrirLaConversation, sansRequete } from "./it4-commun.mjs";

/** Phrases attendues, écrites en clair. */
const PHRASES = {
  fermees: "Les équipes arrivent bientôt en mode Simple. En mode Avancé, vous pouvez déjà les essayer.",
  avisCourt: "En mode Simple, l'IA ne délègue pas : elle continue seule.",
  avisComplet: "Pour faire travailler plusieurs assistants, lancez une équipe.",
  voir: "Voir une démonstration",
  titreDemo: "Comment se déroule une équipe",
  fictives: "Déroulé enregistré avec des données fictives.",
  moment: "Moment",
  suivant: "Moment suivant",
};

/** Durée d'observation d'une éventuelle lecture automatique : trois fois la transition la plus longue de la bande (900 ms). */
const OBSERVATION_MS = 3_000;

/** Ce que le lecteur montre : le moment courant, le nombre de moments, et ce que la démonstration dessine sous la bande. */
const LECTEUR = `(() => {
  const boite = document.querySelector(".modal .neon-band");
  if (!boite) return null;
  const curseur = boite.querySelector("input[type=range]");
  return {
    titre: (boite.querySelector(".neon-title")?.textContent ?? "").trim(),
    moment: Number(curseur?.value ?? 0),
    total: Number(curseur?.max ?? 0),
    valeurLue: curseur?.getAttribute("aria-valuetext") ?? "",
    carte: Boolean(boite.querySelector(".team-card")),
    deroule: Boolean(boite.querySelector(".deroule-figure")),
    texte: (boite.innerText ?? "").replace(/\\s+/g, " ").trim(),
  };
})()`;

/** Étapes d'un déroulé, toutes formes confondues (itération 4 et 5b). */
function etapesDuDeroule(flow) {
  return (flow?.blocs ?? []).flatMap((bloc) => {
    if (bloc.type === "etape") return [bloc.etape];
    if (bloc.type === "avis") return [...bloc.avis, bloc.synthese];
    if (bloc.type === "relecture") return [bloc.auteur, bloc.relecteur];
    if (bloc.type === "aiguillage") return [bloc.aiguilleur, ...bloc.specialistes, ...(bloc.synthese === null ? [] : [bloc.synthese])];
    return [];
  });
}

/**
 * Ouvre l'onglet Équipes et attend qu'il soit POSÉ dans l'état demandé. Le mode courant arrive à la page par le flux
 * d'événements : lu trop tôt, l'onglet montre encore l'état du mode précédent, et le relevé décrirait une page qui n'existe
 * plus. `ferme` dit l'état attendu : avis de fermeture (Simple fermé) ou galerie (Simple ouvert, Avancé).
 */
async function ouvrirLOnglet(page, ferme) {
  await page.evaluer('location.hash = "#/assistants/equipes"');
  await page.attendreQue("document.querySelector('.tm-onglet')", { delaiMs: 25_000, libelle: "onglet Équipes" });
  const attendu = ferme
    ? "Boolean(document.querySelector('.tm-ferme')) && !document.querySelector('.tm-galerie-ancre')"
    : "Boolean(document.querySelector('.tm-galerie-ancre')) && !document.querySelector('.tm-ferme')";
  await page.attendreQue(attendu, { delaiMs: 20_000, libelle: `onglet Équipes posé (${ferme ? "fermé" : "ouvert"})` });
}

/**
 * Commandes qui mènent à l'éditeur ou à l'installation : aucune ne doit exister tant que les équipes sont fermées en Simple
 * (liste en LECTURE SEULE, plan it4 §2.6). Libellés de team-texts.ts, écrits en clair.
 */
const COMMANDES_FERMEES = ["Nouvelle équipe", "Modifier", "Dupliquer", "Utiliser dans le chat", "Installer", "Aperçu", PHRASES.voir];

/**
 * Ce que l'onglet Équipes offre : la phrase de fermeture, la galerie, la démonstration, et les commandes de la liste.
 *
 * La GALERIE se lit sur son seul ancrage (`.tm-galerie-ancre`) : la liste des équipes DÉJÀ installées (`.tm-equipes`) reste
 * montrée en Simple fermé, en lecture seule — c'est le comportement voulu (TeamsTab, plan it4 §2.6), et la confondre avec la
 * galerie faisait tomber ce scénario à tort (mesuré au banc, 22/09 : une équipe installée par un scénario précédent).
 */
const ONGLET = `(() => {
  const onglet = document.querySelector(".tm-onglet");
  if (!onglet) return null;
  const boutons = [...onglet.querySelectorAll("button")].map((b) => b.textContent.trim());
  return {
    texte: (onglet.innerText ?? "").replace(/\\s+/g, " ").trim(),
    ferme: Boolean(onglet.querySelector(".tm-ferme")),
    galerie: Boolean(onglet.querySelector(".tm-galerie-ancre")),
    installees: onglet.querySelectorAll(".tm-equipes > *").length,
    demonstration: boutons.includes(${JSON.stringify(PHRASES.voir)}),
    commandes: boutons.filter((mot) => ${JSON.stringify(COMMANDES_FERMEES)}.includes(mot)),
  };
})()`;

export async function run(ctx) {
  const page = await preparerPage(ctx, LARGE);
  const api = equipes(ctx);
  const liste = await api.liste();
  const ouvertes = liste.ouvertesEnSimple === true;

  // 2. Les exemples livrés passent la grammaire du mode SIMPLE : l'aperçu n'est pas une route fermée, et il dit ce que le
  //    serveur voit. Un exemple qui ne passerait qu'en Avancé ferait mentir « l'ouverture tient en une ligne ».
  await attendreModeAffiche(page, "simple");
  const reglages = await ctx.api.get("/api/settings");
  exiger(reglages?.ui?.mode === "simple", `mode par défaut « ${reglages?.ui?.mode} », attendu « simple ».`);
  exiger((liste.exemples ?? []).length >= 6, `${(liste.exemples ?? []).length} exemple(s) au catalogue : les six de C §12.1 sont attendus.`);
  // Ce qui se mesure ici est le DÉROULÉ, pas la pile : sur le banc, les assistants d'un exemple sont ceux que le faux
  // opencode a bien voulu servir, et tous les codes qui parlent d'un ASSISTANT (absent, interne, délégue, droits
  // personnalisés, IA indisponible…) disent l'état du banc, jamais celui de l'exemple livré. Reste ce qui vient du déroulé :
  // « niveau-avance », le seul refus que la grammaire du mode Simple oppose à une étape (§3.13, décision n° 3), et les codes
  // de structure. Le contrôle est doublé, sans passer par le serveur : AUCUNE étape d'un exemple ne choisit de niveau d'IA.
  const DE_LA_PILE = new Set([
    "assistant-absent",
    "assistant-interne",
    "assistant-non-proposable",
    "delegue",
    "internet",
    "autorise-sans-demander",
    "propose-reporte",
    "personnalise",
    "niveau-indisponible",
  ]);
  for (const exemple of liste.exemples) {
    const apercu = await api.apercu(exemple.flow);
    const bloquants = (apercu?.problems ?? []).filter((probleme) => probleme.bloquant !== false && !DE_LA_PILE.has(probleme.code));
    exiger(bloquants.length === 0, `l'exemple « ${exemple.id} » ne passe pas la grammaire du mode Simple : ${resume(bloquants.map((p) => p.code))}`);
    const niveaux = etapesDuDeroule(exemple.flow).filter((etape) => etape.niveau !== null && etape.niveau !== undefined);
    exiger(niveaux.length === 0, `l'exemple « ${exemple.id} » choisit un niveau d'IA sur ${niveaux.length} étape(s) : réservé au mode Avancé.`);
  }
  releve(ctx, `${liste.exemples.length} exemple(s) livrés : aucun ne choisit de niveau d'IA, aucun problème de structure en mode Simple`);

  if (!ouvertes) {
    // 1. Équipes FERMÉES en Simple, sans aucune bascule.
    await ouvrirLOnglet(page, true);
    const onglet = await page.evaluer(ONGLET);
    releve(
      ctx,
      `onglet Équipes en Simple : ${JSON.stringify({ ferme: onglet.ferme, galerie: onglet.galerie, installees: onglet.installees, demonstration: onglet.demonstration, commandes: onglet.commandes })}`,
    );
    exiger(onglet.ferme, `l'onglet Équipes ne montre pas l'avis de fermeture : ${resume(onglet.texte, 300)}`);
    exiger(onglet.texte.includes(PHRASES.fermees), `phrase de fermeture absente : ${resume(onglet.texte, 300)}`);
    exiger(!onglet.galerie, "la galerie des exemples est offerte en mode Simple alors que les équipes y sont fermées.");
    exiger(!onglet.demonstration, "[Voir une démonstration] est offerte en mode Simple alors que les équipes y sont fermées.");
    exiger(
      onglet.commandes.length === 0,
      `commandes offertes en mode Simple alors que les équipes y sont fermées (liste en lecture seule attendue) : ${resume(onglet.commandes)}`,
    );

    await page.evaluer('location.hash = "#/assistants/equipes/nouvelle"');
    await attendre(600);
    const editeur = await page.evaluer(`(() => ({
      ouvert: Boolean(document.querySelector(".tm-ed-progression")),
      texte: (document.body.innerText ?? "").replace(/\\s+/g, " ").trim().slice(0, 400),
    }))()`);
    exiger(!editeur.ouvert, `l'éditeur guidé est accessible en mode Simple : ${resume(editeur.texte, 300)}`);
    exiger(editeur.texte.includes(PHRASES.fermees), `l'éditeur fermé ne dit pas pourquoi : ${resume(editeur.texte, 300)}`);
  } else {
    // 3. Pile bâtie depuis la copie jetable : l'ouverture tient à la seule constante.
    await ouvrirLOnglet(page, false);
    const onglet = await page.evaluer(ONGLET);
    exiger(!onglet.texte.includes(PHRASES.fermees), `l'onglet Équipes montre encore l'avis de fermeture : ${resume(onglet.texte, 300)}`);
    exiger(onglet.galerie, "la galerie des exemples reste fermée alors que la constante est ouverte.");
    exiger(onglet.demonstration, "[Voir une démonstration] reste fermée alors que la constante est ouverte.");
    // La démonstration s'OUVRE en Simple, et l'éditeur guidé aussi : les boutons ne suffisent pas, ce qu'ils ouvrent compte.
    await page.evaluer(`[...document.querySelectorAll(".tm-onglet button")].find((b) => b.textContent.trim() === ${JSON.stringify(PHRASES.voir)}).click()`);
    await page.attendreQue("document.querySelector('.modal .neon-band')", { delaiMs: 15_000, libelle: "démonstration ouverte en Simple" });
    const enSimple = await page.evaluer(LECTEUR);
    exiger(enSimple.titre === PHRASES.titreDemo, `titre de la démonstration en Simple : « ${enSimple.titre} ».`);
    await page.touche("Escape");
    await page.attendreQue("!document.querySelector('.modal .neon-band')", { libelle: "démonstration refermée (Simple)" });
    await page.evaluer('location.hash = "#/assistants/equipes/nouvelle"');
    await page.attendreQue("document.querySelector('.tm-ed-progression')", { delaiMs: 15_000, libelle: "éditeur guidé ouvert en Simple" });
    releve(ctx, "mode Simple ouvert : galerie, démonstration (ouverte) et éditeur guidé apparaissent — l'ouverture tient à la seule constante");
  }

  // 1 bis. Le lanceur et l'avis de délégation, dans une vraie conversation (le faux joue une demande de délégation).
  if (ctx.mode === "faux") {
    const client = oc(ctx);
    const ia = await attendreIa(ctx);
    const racine = await client.creerConversation("c5b-demonstration");
    await ctx.faux.scripter(racine.id, {
      tools: [delegation("Relire les journaux", "general", { text: "Rien d'anormal." })],
      followUp: { text: "Fait." },
    });
    await ouvrirLaConversation(ctx, racine.id);
    // Le lanceur n'arrive qu'après la lecture de GET /api/teams (`ouvertesEnSimple`) : ouvert, il est ATTENDU ; fermé, son
    // absence n'est constatée qu'une fois la saisie rendue et le réseau de la page au calme — lue trop tôt, elle ne
    // prouverait rien (mesuré au banc, copie jetable du 23/09 : lanceur lu absent avant d'avoir eu le temps d'arriver).
    await page.attendreQue("document.querySelector(\"textarea[aria-label='Message']\")", { delaiMs: 20_000, libelle: "saisie du chat" });
    if (ouvertes) {
      await page.attendreQue("document.querySelector('.team-launcher button')", { delaiMs: 20_000, libelle: "lanceur d'équipe dans la saisie (Simple ouvert)" });
    } else {
      await attendreReseauCalme(page);
    }
    const lanceur = await page.evaluer("Boolean(document.querySelector('.team-launcher button'))");
    exiger(lanceur === ouvertes, `lanceur d'équipe ${lanceur ? "présent" : "absent"} en Simple alors que les équipes y sont ${ouvertes ? "ouvertes" : "fermées"}.`);
    const envoi = await client.envoyer(racine.id, "Fais relire les journaux par un autre assistant.", ia);
    exiger(envoi.code === 204, `envoi refusé (${envoi.code}) : ${resume(envoi.corps)}`);
    await page.attendreQue("document.querySelector('.delegation-notice')", { delaiMs: 30_000, libelle: "avis de délégation du mode Simple" });
    const avis = await page.texte(".delegation-notice");
    releve(ctx, `avis de délégation en Simple : ${resume(avis, 200)}`);
    if (ouvertes) {
      exiger(avis.includes(PHRASES.avisComplet), `l'avis de délégation garde le texte court alors que les équipes sont ouvertes : ${resume(avis, 300)}`);
    } else {
      exiger(avis.includes(PHRASES.avisCourt), `l'avis de délégation n'est pas le texte court de l'itération 4 : ${resume(avis, 300)}`);
      exiger(!avis.includes(PHRASES.avisComplet), `l'avis de délégation propose une équipe alors qu'elles sont fermées en Simple : ${resume(avis, 300)}`);
    }
  }

  // 4 et 5. La démonstration d'équipe, en mode Avancé : zéro requête, et aucune lecture automatique en mouvement réduit.
  await enAvance(ctx, async () => {
    await attendreModeAffiche(page, "avance");
    await ouvrirLOnglet(page, false);
    await page.attendreQue(
      `[...document.querySelectorAll(".tm-onglet button")].some((b) => b.textContent.trim() === ${JSON.stringify(PHRASES.voir)})`,
      { delaiMs: 15_000, libelle: `bouton « ${PHRASES.voir} »` },
    );

    // Une démonstration jouée de bout en bout : ouverture, observation en mouvement réduit, un moment de plus au clavier,
    // fermeture. Elle est rejouable telle quelle : la mesure « zéro requête » peut la reprendre (voir plus bas).
    const jouerLaDemonstration = async () => {
      // Point de départ de la page : réseau au calme (le flux d'événements mis à part).
      const debutPage = await attendreReseauCalme(page);

      // 5. Le mouvement réduit est posé AVANT l'ouverture, comme un réglage du système, et exigé tel que la page le voit :
      //    un relevé nul ne dirait rien s'il venait d'un réglage qui n'est pas arrivé jusqu'à elle.
      await page.medias({ reducedMotion: "reduce" });
      await page.attendreQue('matchMedia("(prefers-reduced-motion: reduce)").matches', { libelle: "mouvement réduit vu par la page" });

      await page.evaluer(`[...document.querySelectorAll(".tm-onglet button")].find((b) => b.textContent.trim() === ${JSON.stringify(PHRASES.voir)}).click()`);
      await page.attendreQue("document.querySelector('.modal .neon-band')", { delaiMs: 15_000, libelle: "boîte de la démonstration d'équipe" });
      const ouverture = await page.evaluer(LECTEUR);
      releve(ctx, `démonstration ouverte : « ${ouverture.titre} », moment ${ouverture.moment} / ${ouverture.total}`);
      exiger(ouverture.titre === PHRASES.titreDemo, `titre de la démonstration : « ${ouverture.titre} ».`);
      exiger(ouverture.total >= 2, `${ouverture.total} moment(s) enregistrés : la démonstration ne se parcourt pas.`);
      exiger(ouverture.texte.includes(PHRASES.fictives), `la démonstration ne dit pas que les données sont fictives : ${resume(ouverture.texte, 400)}`);
      exiger(ouverture.carte, "la carte d'exécution n'est pas dessinée sous la bande.");
      exiger(ouverture.deroule, "le Déroulé n'est pas dessiné sous la bande.");

      // Rien ne se lit tout seul : le moment affiché est relevé, observé, et relevé de nouveau ; rien ne bouge à l'écran.
      await attendre(OBSERVATION_MS);
      const apres = await page.evaluer(LECTEUR);
      const animations = await page.evaluer("document.getAnimations().filter((a) => a.playState === 'running' && a.effect && a.effect.getTiming().duration >= 100).length");
      releve(ctx, `mouvement réduit : moment ${ouverture.moment} → ${apres.moment} après ${OBSERVATION_MS} ms, ${animations} animation(s) perceptible(s)`);
      exiger(apres.moment === ouverture.moment, `la démonstration est passée du moment ${ouverture.moment} au moment ${apres.moment} toute seule.`);
      exiger(animations === 0, `${animations} animation(s) perceptible(s) alors que le mouvement réduit est demandé (§5.5).`);

      // Elle avance quand VOUS la faites avancer, au clavier : [Moment suivant] est un bouton ordinaire.
      await page.evaluer(`[...document.querySelectorAll(".modal .neon-band button")].find((b) => b.textContent.trim() === ${JSON.stringify(PHRASES.suivant)})?.focus()`);
      await page.touche("Enter");
      await page.attendreQue(
        `Number(document.querySelector(".modal .neon-band input[type=range]")?.value ?? 0) === ${ouverture.moment + 1}`,
        { delaiMs: 8_000, libelle: "moment suivant atteint au clavier" },
      );

      await page.touche("Escape");
      await page.attendreQue("!document.querySelector('.modal .neon-band')", { libelle: "démonstration fermée par Échap" });
      await page.medias({ reducedMotion: "no-preference" });
      await page.attendreQue('!matchMedia("(prefers-reduced-motion: reduce)").matches', { libelle: "mouvement rendu à son réglage ordinaire" });

      // 4 (page). Zéro requête de la page : tout vient de `demo-equipe.json`, livré avec l'interface. Seule la liste des
      // conversations, que la page relit d'elle-même, est écartée.
      await attendreReseauCalme(page, { calmeMs: 1_000 });
      const interdites = page
        .journalReseau()
        .slice(debutPage)
        .filter((ligne) => ligne.methode !== "GET" || new URL(ligne.url).pathname !== "/api/conversations");
      exiger(
        interdites.length === 0,
        `la page a envoyé ${interdites.length} requête(s) pendant la démonstration : ${resume(interdites.map((l) => `${l.methode} ${l.url}`))}`,
      );
    };

    if (ctx.mode !== "faux") {
      await jouerLaDemonstration();
      releve(ctx, "journal du faux opencode non relevé hors du mode « --faux » ; la page, elle, a été mesurée : 0 requête");
      return;
    }
    // 4 (opencode). ZÉRO requête vers opencode, sur le JOURNAL RÉSEAU DU BANC (toutes les requêtes reçues par le faux, toutes
    // méthodes, tous chemins), hors le seul fond qu'aucune action ne déclenche (sondage des sessions, catalogue d'IA) : la
    // mesure de `sansRequete` (it4-commun.mjs), reprise — jamais assouplie — si seule une relecture d'archive du cockpit est
    // tombée dans la fenêtre. Le classement automatique des conversations (un appel d'IA qui tombe deux minutes après un
    // repos) est coupé le temps de la mesure et rendu tel quel ensuite.
    const classementAvant = await classementAutomatique(ctx, "off");
    try {
      await sansRequete(ctx, "démonstration d'équipe", jouerLaDemonstration);
    } finally {
      if (classementAvant !== null) await classementAutomatique(ctx, classementAvant);
    }
    releve(ctx, "démonstration d'équipe : 0 requête de la page, 0 requête reçue par opencode hors fond, aucun appel d'IA");
  });

  await attendreModeAffiche(page, "simple");
  ctx.expectNoConsoleErrors();
}
