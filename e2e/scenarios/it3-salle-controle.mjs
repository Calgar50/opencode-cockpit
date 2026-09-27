// Scénario e2e de la salle de contrôle 3D (itération 3, paquet L35) : le direct en mode Avancé.
//
// Spécification §5.8 l.992-1009 (vue 3D, zooms, fil d'Ariane, liste et tableau toujours là), §7.7 l.1170 et l.1172 (CSP,
// mémoire libérée, clavier seul), §5.7.4 l.985 ([Ouvrir la salle de contrôle] dans la bande) ; plan it3 fiche L35, D-3d-18,
// D-3d-28 ; mesures EXEC/mesures/MX-3D.md (M3D-1 mode du banc, M3D-2 CSP, M3D-5 mémoire, M3D-6 injections).
//
// Ce que le scénario établit (« --faux », mode Avancé) :
//   1. une délégation scriptée sur le faux travaille, puis rend son résultat ; [Ouvrir la salle de contrôle] de la bande ouvre
//      le zoom 2 EN DIRECT et la scène 3D est montée (canevas, marques `salle3d:scene`, morceau paresseux de three chargé) ;
//   2. l'ordre des faits est tenu dans la vue : « Consigne confiée » (faisceau rose, §5.7.1) apparaît AVANT « Résultat rendu »
//      (faisceau bleu) dans le tableau, qui est la vérité de la vue en 3D comme en 2D (P7) ; l'ordre est recoupé sur les faits
//      enregistrés par le cockpit ;
//   3. zoom 3 puis zoom 1 par le fil d'Ariane : AUCUNE marque `salle3d:bascule` à ces changements (D-3d-28) et la 3D reste
//      montrée (le canevas est là et de nouvelles images sont rendues) ;
//   4. CLAVIER SEUL : la grille du zoom 1 (flèches puis Entrée) ouvre le zoom 2, une étiquette DOM de la scène est atteinte au
//      clavier et activée par Entrée, et le curseur du lecteur répond à ← et → (le lecteur complet est joué par it3-revoir) ;
//   5. `securitypolicyviolation` = 0 (M25 sur le schéma du banc), zéro erreur de console ;
//   6. fermeture de la salle : marque `salle3d:memoire` à géométries 0 et textures 0, et compteurs d'objets WebGL à 0 tampon,
//      0 tableau de sommets, 0 programme (MX-3D §9.2 : les 4 textures et 3 tampons d'image internes à three ne partent qu'avec
//      le contexte, perdu par `forceContextLoss`).
// Contrôle NON VIDE : sans marque `salle3d:scene` ni morceau de three chargé, le scénario ÉCHOUE — jamais « zéro violation »
// sur une page restée en 2D. Sans aucun contexte webgl2 dans le banc, les lignes 3D sont consignées « en attente » (l.1170).
import {
  attendre,
  attendreDemandes,
  attendreFinDuTour,
  attendreIa,
  attendreModeAffiche,
  attendreQue,
  avecTemoinP6,
  cliquerBouton,
  delegation,
  demandeDeDelegation,
  enModeAvance,
  exiger,
  faits,
  faisceauxDesFaits,
  nonJoue,
  oc,
  ouvrirConversation,
  PHRASES,
  preparerPage,
  releve,
  resume,
  texteVisible,
} from "./it1-ui-commun.mjs";
import {
  attendreScene3d,
  compteursWebgl,
  compterCauses,
  marques,
  oublierMarques,
  ouvrirSalle,
  preparer3d,
  preuveTroisD,
  ressources,
  violationsCsp,
} from "../lib/webgl.mjs";

const DESCRIPTION = "Relire la salle de contrôle";
/** Travail de l'enfant : assez long pour voir la consigne dessinée seule, avant le résultat. */
const TRAVAIL_MS = 6_000;
/** Pas du tour : le faux enchaîne ses groupes en 1 ms ; sans pas, consigne et fin de réponse arrivent dans le même lot. */
const PAS_MS = 1_200;
/** Demande d'autorisation posée quelques millisecondes après la partie `task`, comme opencode 1.18.30 réel. */
const DEMANDE_APRES_MS = 5;

export async function run(ctx) {
  const { cdp, mode } = await preparer3d(ctx);
  try {
    if (ctx.mode !== "faux") {
      nonJoue(ctx, "salle de contrôle en direct", "le faux fournisseur ne délègue pas : aucun faisceau à dessiner");
      ctx.expectNoConsoleErrors();
      return;
    }
    releve(ctx, `mode 3D du banc : ${mode.mode} (webgl2 ${mode.webgl2}, drapeau ${mode.avecDrapeau}, moteur ${resume(mode.moteur, 80)})`);
    if (mode.mode === "aucun") {
      nonJoue(ctx, "contrôles 3D (CSP, mémoire, marques)", "aucun contexte webgl2 dans ce banc : lignes l.1170 consignées « en attente »");
      ctx.expectNoConsoleErrors();
      return;
    }
    await jouer(ctx, cdp);
  } finally {
    await cdp.fermer();
  }
}

async function jouer(ctx, cdp) {
  const page = await preparerPage(ctx);
  await avecTemoinP6(ctx, async () => {
    await enModeAvance(ctx, async () => {
      await attendreModeAffiche(page, "avance");
      const ia = await attendreIa(ctx);
      const client = oc(ctx);
      const racine = await client.creerConversation("it3-salle-controle");
      await ctx.faux.scripter(racine.id, {
        stepMs: PAS_MS,
        tools: [{ ...delegation(DESCRIPTION, "general", { text: "Salle relue.", workMs: TRAVAIL_MS }), askAfterMs: DEMANDE_APRES_MS }],
        followUp: { text: "Synthèse de la relecture." },
      });
      await ouvrirConversation(ctx, racine.id);
      const envoi = await client.envoyer(racine.id, "Fais relire la salle de contrôle par un autre assistant.", ia);
      exiger(envoi.code === 204, `envoi refusé (${envoi.code}) : ${resume(envoi.corps)}`);
      await attendreDemandes(client, demandeDeDelegation(racine.id, DESCRIPTION), { libelle: "délégation en attente" });
      await cliquerBouton(page, PHRASES.autoriser, { portee: ".interactions" });

      // 1. [Ouvrir la salle de contrôle] depuis la bande : zoom 2 en direct, scène 3D montée.
      const avant = await ressources(cdp);
      await cliquerBouton(page, "Ouvrir la salle de contrôle", { portee: ".neon-band" });
      await page.attendreQue("document.querySelector('.page.salle3d .zoom-conv')", { libelle: "zoom 2 de la salle de contrôle" });
      await attendreScene3d(page);
      const preuve = await preuveTroisD(cdp, avant);
      exiger(preuve.morceau !== null, "le morceau paresseux de three n'a pas été chargé : contrôle 3D vide, scénario en échec.");
      exiger(preuve.scenes > 0, "aucune image rendue par le moteur three : contrôle 3D vide, scénario en échec.");
      releve(ctx, `zoom 2 en 3D : morceau ${preuve.morceau.url.split("/").pop()} (${preuve.morceau.taille} octets), ${preuve.scenes} image(s), causes ${resume(preuve.causes)}`);

      // 2. Ordre des faits dans la vue : « Consigne confiée » (rose) avant « Résultat rendu » (bleu).
      const consigneVue = await attendreSigne(page, "Consigne confiée");
      exiger((await texteVisible(page, ".zoom-conv-tableau")).includes("Consigne confiée"), "« Consigne confiée » absente du tableau du zoom 2.");
      const resultatVu = await attendreSigne(page, "Résultat rendu", { delaiMs: TRAVAIL_MS + 20_000 });
      exiger(consigneVue < resultatVu, `« Résultat rendu » montré avant « Consigne confiée » (${consigneVue} ≥ ${resultatVu}).`);
      await attendreFinDuTour(client, racine.id);
      const beams = faisceauxDesFaits(await faits(ctx, racine.id)).map((f) => f.genre);
      const rose = beams.indexOf("consigne");
      const bleu = beams.indexOf("resultat");
      exiger(rose >= 0 && bleu > rose, `faits du cockpit : consigne (rose) puis résultat (bleu) attendus, vus ${resume(beams)}`);
      releve(ctx, `ordre des faits : ${resume(beams)} ; consigne vue à ${consigneVue} ms, résultat à ${resultatVu} ms`);

      // 3. Zoom 3 puis zoom 1 par le fil d'Ariane : aucune bascule, 3D toujours montrée (D-3d-28).
      const basculesAvant = (await marques(cdp, "salle3d:bascule")).length;
      const scenesAvant = (await marques(cdp, "salle3d:scene")).length;
      await page.attendreQue("document.querySelector('.zoom-conv-liste button')", { libelle: "liste des assistants du zoom 2" });
      const assistant = await page.evaluer("document.querySelector('.zoom-conv-liste button').textContent.trim()");
      await page.evaluer("document.querySelector('.zoom-conv-liste button').click()");
      await page.attendreQue("document.querySelector('.salle3d-fil li:nth-child(3)')", { libelle: "fil d'Ariane du zoom 3" });
      await attendreScene3d(page);
      await page.evaluer("document.querySelector('.salle3d-fil a').click()");
      await page.attendreQue("document.querySelector('.salle3d-zoom1')", { libelle: "zoom 1 par le fil d'Ariane" });
      await attendreScene3d(page);
      const bascules = await marques(cdp, "salle3d:bascule");
      exiger(bascules.length === basculesAvant, `${bascules.length - basculesAvant} bascule(s) en 2D au changement de zoom (D-3d-28) : ${resume(bascules)}`);
      const scenes = await marques(cdp, "salle3d:scene");
      exiger(scenes.length > scenesAvant, "aucune image rendue après les changements de zoom : la 3D n'est plus montrée.");
      releve(ctx, `zooms 2 → 3 → 1 (assistant ${resume(assistant, 32)}) : 0 bascule, ${scenes.length - scenesAvant} image(s) de plus, causes ${resume(compterCauses(scenes))}`);

      // 4. Clavier seul : grille du zoom 1, étiquette DOM de la scène, curseur du lecteur.
      await clavierSeul(ctx, page, racine.id);

      // 5 et 6. CSP, console, puis fermeture : mémoire libérée.
      const violations = await violationsCsp(cdp);
      exiger(violations.length === 0, `violation(s) de la CSP dans la salle de contrôle : ${resume(violations)}`);
      await oublierMarques(cdp, "salle3d:memoire");
      await page.evaluer("location.hash = '#/'");
      await page.attendreQue("!document.querySelector('.page.salle3d')", { libelle: "salle de contrôle fermée" });
      const memoire = await attendreQue(async () => (await marques(cdp, "salle3d:memoire")).at(-1) ?? false, { libelle: "marque salle3d:memoire" });
      exiger(memoire.detail?.geometries === 0 && memoire.detail?.textures === 0, `mémoire non libérée à la fermeture : ${resume(memoire.detail)}`);
      const gl = await compteursWebgl(cdp);
      exiger(gl.tampon === 0 && gl.sommets === 0 && gl.programme === 0, `objets WebGL encore vivants après la libération : ${resume(gl)}`);
      releve(ctx, `fermeture : ${resume(memoire.detail)} ; objets WebGL ${resume(gl)} (MX-3D §9.2 : 4 textures et 3 tampons d'image internes jusqu'à la perte du contexte)`);
      releve(ctx, `M25 (${ctx.schema}) : 0 violation de la CSP pendant la salle de contrôle en 3D`);
    });
  });
  // MX-3D §9.3 : aucun WebGLRenderer n'est créé après un refus, donc aucun message de three n'est toléré ici.
  ctx.expectNoConsoleErrors();
}

/** Attend qu'un signe paraisse dans le tableau du zoom et rend l'instant (horloge de la page) de son apparition. */
async function attendreSigne(page, signe, { delaiMs = 20_000 } = {}) {
  await page.attendreQue(`(document.querySelector(".zoom-conv-tableau")?.innerText ?? "").includes(${JSON.stringify(signe)})`, { delaiMs, libelle: `signe « ${signe} »` });
  return await page.evaluer("performance.now()");
}

/**
 * Clavier seul (spéc. l.1172) : la grille du zoom 1 (flèches puis Entrée) ouvre une conversation, une étiquette DOM de la scène
 * est atteignable et activable au clavier, et le curseur des moments du lecteur répond à ← et →. Aucun clic de souris ici : le
 * curseur du clavier est posé sur le premier élément, puis seules des touches sont envoyées.
 */
async function clavierSeul(ctx, page, rootId) {
  await ouvrirSalle(page, null);
  await page.attendreQue("document.querySelector('.salle3d-grille [data-cellule=\"0\"]')", { libelle: "grille des conversations" });
  await page.evaluer("document.querySelector('.salle3d-grille [data-cellule=\"0\"]').focus()");
  exiger((await page.focus()).startsWith("button:"), "le focus n'est pas sur une cellule de la grille.");
  await page.touche("ArrowRight");
  await page.touche("ArrowLeft");
  await page.touche("Enter");
  await page.attendreQue("document.querySelector('.page.salle3d .zoom-conv')", { libelle: "zoom 2 ouvert au clavier" });
  await attendreScene3d(page);

  // Étiquettes DOM posées sur le canevas (D-3d-19) : de vrais boutons, atteints au clavier.
  await page.attendreQue("document.querySelectorAll('.salle3d-scene button').length > 0", { libelle: "étiquettes DOM de la scène" });
  await page.evaluer("document.querySelector('.salle3d-scene button').focus()");
  const etiquette = await page.focus();
  exiger(etiquette.startsWith("button:"), `étiquette de la scène non focalisable : ${resume(etiquette)}`);
  await page.touche("Enter");
  await attendre(300);

  // Lecteur : le curseur des moments répond à ← et → quand il a le focus, et à lui seul (§5.5 l.917).
  await ouvrirSalle(page, rootId);
  await page.attendreQue("document.querySelector('.revoir-curseur')", { libelle: "curseur des moments" });
  await page.evaluer("document.querySelector('.revoir-curseur').focus()");
  const total = Number(await page.evaluer("document.querySelector('.revoir-curseur').max"));
  if (total < 2) {
    nonJoue(ctx, "curseur des moments au clavier", `la conversation n'a qu'un moment (${total}) : rien à reculer`);
    return;
  }
  const depart = Number(await page.evaluer("document.querySelector('.revoir-curseur').value"));
  await page.touche("ArrowLeft");
  const apres = await attendreQue(
    async () => {
      const valeur = Number(await page.evaluer("document.querySelector('.revoir-curseur')?.value ?? -1"));
      return valeur !== depart ? valeur : false;
    },
    { libelle: "moment reculé par ←" },
  );
  exiger(apres < depart, `← n'a pas reculé le curseur (${depart} → ${apres}).`);
  await page.touche("ArrowRight");
  releve(ctx, `clavier seul : grille (flèches, Entrée), étiquette de la scène (${resume(etiquette, 48)}), curseur ${depart} → ${apres}`);
}
