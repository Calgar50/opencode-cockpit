// Scénario e2e du repli 2D de la salle de contrôle (itération 3, paquet L35).
//
// Spécification §5.8 l.1003-1008 (ordre des causes du repli), §7.7 l.1171 (« `failIfMajorPerformanceCaveat` simulé → 2D sans
// perte de position »), §6 l.1068 ; plan it3 fiche L35, D-3d-18, D-3d-25, D-3d-28 ; MX-3D M3D-1 et M3D-6.
//
// Quatre causes, toutes simulées par injection CDP (D-3d-18 : jamais un réglage du cockpit) :
//   1. REFUS du contexte demandé avec `failIfMajorPerformanceCaveat: true` dès l'ouverture : le cockpit redemande le contexte
//      sans le drapeau, l'obtient, et affiche « Affichage 2D : ce poste dessine la 3D sans carte graphique (bureau à distance
//      ou machine virtuelle) » — la phrase de la raison « rendu-logiciel » ;
//   2. le MÊME refus PENDANT UNE LECTURE EN DIFFÉRÉ : la vue est en 3D, le lecteur est figé sur un moment à une vitesse
//      choisie, puis le refus est posé et la scène est refaite (le thème du poste change, geste ordinaire d'un utilisateur) :
//      la page passe en 2D, dit sa raison, et le lecteur garde la MÊME demande, le MÊME moment et la MÊME vitesse ;
//   3. un nom de moteur de rendu « SwiftShader » : même raison, même phrase ;
//   4. `prefers-reduced-motion: reduce` : « Affichage 2D : vos réglages d'accessibilité le demandent », puis [Réessayer] une
//      fois le réglage levé : la 3D revient.
// Le repli dessine la même vue en 2D : la marque `salle3d:plan` y est posée aussi (M20), avec `rendu: "2d"`.
import { attendreFinDuTour, attendreIa, attendreQue, cliquerBouton, exiger, LARGE, nonJoue, oc, preparerPage, releve, resume, texteVisible } from "./it1-ui-commun.mjs";
import { attendre, attendre2d, attendreScene3d, emuler, marques, ouvrirSalle, positionLecteur, preparer3d, reglerWebgl, violationsCsp } from "../lib/webgl.mjs";

/** Phrases de la spécification, écrites en clair : c'est la spécification qu'on vérifie, pas ce que le code déclare. */
const PHRASES = {
  renduLogiciel: "Affichage 2D : ce poste dessine la 3D sans carte graphique (bureau à distance ou machine virtuelle)",
  accessibilite: "Affichage 2D : vos réglages d'accessibilité le demandent",
  webglAbsent: "Affichage 2D : la 3D n'est pas disponible dans ce navigateur",
  reessayer: "Réessayer",
};

/** Nom de moteur logiciel simulé (reconnu par sous-chaîne, casse ignorée : server/shared/fluidity.ts). */
const SWIFTSHADER = "ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero)), SwiftShader driver)";

export async function run(ctx) {
  // 1. Refus du contexte dès l'ouverture : la phrase de la raison, et la salle dessinée en 2D.
  const refus = await preparer3d(ctx, { refusCaveat: true });
  try {
    if (refus.mode.mode === "aucun") {
      nonJoue(ctx, "repli 2D simulé", "aucun contexte webgl2 dans ce banc : la salle y est toujours en 2D");
      ctx.expectNoConsoleErrors();
      return;
    }
    const page = await preparerPage(ctx);
    await ouvrirSalle(page, null);
    await attendre2d(page);
    await exigerPhrase(page, PHRASES.renduLogiciel, "refus du drapeau à l'ouverture");
    const plans2d = (await marques(refus.cdp, "salle3d:plan")).filter((m) => m.detail?.rendu === "2d");
    exiger(plans2d.length > 0, "aucune marque salle3d:plan en repli 2D (M20 compte les deux rendus).");
    releve(ctx, `refus du drapeau : 2D, ${plans2d.length} plan(s) dessiné(s) en 2D`);
    exiger((await violationsCsp(refus.cdp)).length === 0, "violation de la CSP en repli 2D.");
  } finally {
    await refus.cdp.fermer();
  }

  // 3. Moteur logiciel simulé : même raison, même phrase.
  const logiciel = await preparer3d(ctx, { moteur: SWIFTSHADER });
  try {
    const page = await preparerPage(ctx);
    await ouvrirSalle(page, null);
    await attendre2d(page);
    await exigerPhrase(page, PHRASES.renduLogiciel, "moteur SwiftShader simulé");
    releve(ctx, "moteur « SwiftShader » simulé : 2D et phrase du rendu logiciel");
  } finally {
    await logiciel.cdp.fermer();
  }

  // 4. Mouvement réduit : phrase des réglages d'accessibilité, puis [Réessayer] le réglage levé.
  const accessibilite = await preparer3d(ctx, { mouvementReduit: true });
  try {
    // Même réglage que preparer3d (R106-b) : preparerPage émule le mouvement de l'onglet du banc, qui remplacerait « reduce ».
    const page = await preparerPage(ctx, LARGE, { mouvement: "reduce" });
    await ouvrirSalle(page, null);
    await attendre2d(page);
    await exigerPhrase(page, PHRASES.accessibilite, "mouvement réduit");
    // Réglage levé : l'onglet du banc d'abord (garde de R106-b), puis la seconde connexion avec le jeu complet (dernier envoi) ;
    // la fermeture de la connexion reposera ce réglage levé, et non le « reduce » du départ.
    await accessibilite.mouvement("no-preference");
    await cliquerBouton(page, PHRASES.reessayer, { portee: ".salle3d-fluidite" });
    if (accessibilite.mode.mode === "materiel") {
      await attendreScene3d(page);
      releve(ctx, "mouvement réduit : 2D et sa phrase ; [Réessayer] le réglage levé : retour en 3D");
    } else {
      nonJoue(ctx, "[Réessayer] → retour en 3D", "banc sans contexte matériel : le moteur simulé n'est pas posé ici");
    }
  } finally {
    await accessibilite.cdp.fermer();
  }

  // 2. Refus pendant une lecture en différé : 2D sans perte de position.
  await refusPendantLeDiffere(ctx);
}

/** Phrase de la fluidité affichée sous la vue (§5.8 l.1006-1007). */
async function exigerPhrase(page, attendue, quand) {
  await page.attendreQue(`(document.querySelector(".salle3d-fluidite")?.innerText ?? "").includes(${JSON.stringify(attendue)})`, {
    libelle: `phrase « ${attendue} » (${quand})`,
  });
  const dite = await texteVisible(page, ".salle3d-fluidite");
  exiger(dite.includes(attendue), `${quand} : phrase attendue « ${attendue} », lue « ${resume(dite, 200)} ».`);
}

/**
 * Refus simulé PENDANT une lecture en différé (spéc. l.1171). La vue part en 3D ; le lecteur du zoom 2 est figé sur un moment,
 * à une vitesse choisie. Le refus est alors posé, puis la scène est refaite — la personne change le thème de son poste, geste
 * ordinaire qui ne touche ni le zoom ni le lecteur. Le contexte est refusé, la page passe en 2D et dit sa raison ; la position
 * du différé est intacte : la clé React du zoom ne dépend pas du verdict de fluidité (L31b).
 */
async function refusPendantLeDiffere(ctx) {
  const { cdp, mode } = await preparer3d(ctx);
  try {
    if (mode.mode !== "materiel") {
      nonJoue(ctx, "refus pendant une lecture en différé", "banc sans contexte matériel : la vue ne part pas en 3D sans injection");
      return;
    }
    const page = await preparerPage(ctx);
    const rootId = await conversationAvecFaits(ctx, "it3-repli");
    await ouvrirSalle(page, rootId);
    await attendreScene3d(page);

    // Lecture en différé : figée sur un moment, à ×0,5.
    await page.attendreQue("document.querySelector('.revoir-curseur')", { libelle: "lecteur du zoom 2" });
    const moments = Number(await page.evaluer("document.querySelector('.revoir-curseur').max"));
    if (moments < 2) {
      nonJoue(ctx, "refus pendant une lecture en différé", `la conversation n'a qu'un moment (${moments})`);
      return;
    }
    await page.evaluer("(() => { const s = document.querySelector('.revoir-bar select'); s.value = '0.5'; s.dispatchEvent(new Event('change', { bubbles: true })); })()");
    await cliquerBouton(page, "Moment précédent", { portee: ".revoir-bar" });
    await attendre(400);
    const avant = await positionLecteur(page);
    exiger(avant !== null && avant.badge.startsWith("EN DIFFÉRÉ"), `lecteur resté en direct : ${resume(avant)}`);

    // Le refus est posé, puis la scène est refaite par un changement de thème du poste.
    await reglerWebgl(cdp, { refusCaveat: true });
    await emuler(cdp, { theme: "sombre" });
    await attendre2d(page);
    const apres = await positionLecteur(page);
    exiger(apres.moments === avant.moments, `moment perdu au passage en 2D : « ${avant.moments} » → « ${apres.moments} ».`);
    exiger(apres.vitesse === avant.vitesse, `vitesse perdue au passage en 2D : ${avant.vitesse} → ${apres.vitesse}.`);
    exiger(apres.badge === avant.badge, `badge du différé changé : « ${avant.badge} » → « ${apres.badge} ».`);
    const phrase = await texteVisible(page, ".salle3d-fluidite");
    exiger(phrase.includes(PHRASES.webglAbsent), `aucune raison dite après le refus pendant le différé : « ${resume(phrase, 200)} ».`);
    const plans = (await marques(cdp, "salle3d:plan")).filter((m) => m.detail?.rendu === "2d");
    exiger(plans.length > 0, "aucun plan dessiné en 2D après le repli.");
    releve(ctx, `refus pendant le différé : 2D, position gardée (${avant.moments}, ${avant.badge}, vitesse ${avant.vitesse}), ${plans.length} plan(s) 2D`);
    exiger((await violationsCsp(cdp)).length === 0, "violation de la CSP pendant le repli.");
  } finally {
    await cdp.fermer();
  }
  // MX-3D §9.3 : le contexte refusé est demandé par three lui-même (la page, elle, ne monte la scène qu'après un verdict 3D).
  // three écrit alors un ou deux messages, nommés ici et tolérés pour ce seul scénario.
  ctx.expectNoConsoleErrors([/WebGL context could not be created/i, /Error creating WebGL context/i, /THREE\.WebGLRenderer/i]);
}

/**
 * Conversation du scénario : un tour de texte suffit à remplir la vue et le lecteur (aucune délégation n'est nécessaire ici).
 * Elle est créée par le proxy du cockpit, comme un utilisateur, puis attendue dans les territoires du zoom 1.
 */
async function conversationAvecFaits(ctx, titre) {
  const client = oc(ctx);
  const ia = await attendreIa(ctx);
  const racine = await client.creerConversation(titre);
  const envoi = await client.envoyer(racine.id, "Réponds en une phrase.", ia);
  exiger(envoi.code === 204, `envoi refusé (${envoi.code}) : ${resume(envoi.corps)}`);
  await attendreFinDuTour(client, racine.id);
  await attendreQue(
    async () => {
      const lue = await ctx.api.get("/api/salle-controle/territoires");
      const toutes = [...(lue?.projets ?? []), ...(lue?.salle?.projets ?? [])].flatMap((projet) => projet.conversations ?? []);
      return toutes.some((conversation) => conversation.rootId === racine.id);
    },
    { delaiMs: 20_000, libelle: "conversation listée par les territoires" },
  );
  return racine.id;
}
