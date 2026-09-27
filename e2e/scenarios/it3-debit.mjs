// Scénario e2e du DÉBIT de la salle de contrôle (itération 3, paquet L35) : mesure M20, suite synthétique.
//
// Spécification l.1288 (M20 : « débit d'événements d'une demande OMO réelle : 4 rendus par seconde, 50 sessions, 3 niveaux »)
// et §7.7 l.1176 (« au plus 4 rendus par seconde tenus sur la capture la plus dense ») ; plan it3 §3.2 et fiche L35, D-3d-17,
// D-3d-18 ; errata M20 du train de V2 (EXEC/mesures/MX-3D.md) : `salle3d:scene` est posée à CHAQUE image, et seule la cause
// « plan » passe par le limiteur ; le plafond de 4 par seconde se compte donc sur `salle3d:plan` et sur les marques de scène
// dont `detail.cause` vaut « plan ».
//
// La capture d'une demande réelle de la Salle OMO est faite par L3s-b, hors de cette itération. Ici, la suite est SYNTHÉTIQUE
// et reproductible (e2e/lib/gen-dense.mjs, fixture e2e/fixtures/it3-dense.jsonl) : 50 sessions sur 3 niveaux et des rafales de
// 200 événements par seconde, rejouées par la route de pilotage `POST /banc/emettre` du faux. Aucune IA, aucun appel facturé.
//
// Ce que le scénario établit :
//   1. la salle de contrôle montre la conversation pendant que la suite dense arrive ;
//   2. sur TOUTE fenêtre d'une seconde, AU PLUS 4 marques `salle3d:plan` (3D, puis 2D en repli) et au plus 4 marques
//      `salle3d:scene` de cause « plan » ;
//   3. AU MOINS une marque `salle3d:plan` par seconde DE RAFALE (l'écoulement de 1,5 s qui suit la dernière rafale n'en est pas
//      une : la vue y a rattrapé) : sans cela le contrôle serait vide et le scénario échoue ;
//   4. le repli 2D dessine lui aussi, au même plafond : la mesure est refaite avec `prefers-reduced-motion: reduce`.
import { attendre, attendreFinDuTour, attendreIa, exiger, LARGE, nonJoue, oc, preparerPage, releve, resume } from "./it1-ui-commun.mjs";
import { chargerFixture, DENSE } from "../lib/gen-dense.mjs";
import { attendre2d, attendreScene3d, debitParSeconde, marques, oublierMarques, ouvrirSalle, preparer3d } from "../lib/webgl.mjs";

/** §5.7.4 et D-3d-17 : au plus 4 recalculs par seconde (NEON_RENDU_MS = 250 ms). */
const PLAFOND = 4;
// « Sur toute fenêtre d'une seconde » (fiche L35) : fenêtre GLISSANTE, et aucun dépassement toléré.

export async function run(ctx) {
  const premiere = await preparer3d(ctx);
  // Suite de la seconde mesure, préparée pendant la première ; nulle tant que rien n'est à mesurer en 2D.
  let repliAFaire = null;
  try {
    if (ctx.mode !== "faux") {
      nonJoue(ctx, "débit (M20)", "le rejeu d'événements passe par le pilotage du faux opencode");
      ctx.expectNoConsoleErrors();
      return;
    }
    const page = await preparerPage(ctx);
    const rootId = await conversation(ctx);
    const suiteDense = (marque) => chargerFixture({ racine: rootId, prefixe: `${marque}${Date.now().toString(36).slice(-4)}` });
    const dense3d = suiteDense("d");
    exiger(dense3d.entete.sessions === DENSE.sessions && dense3d.rafales.length > 0, `fixture dense inattendue : ${resume(dense3d.entete)}`);

    // Les 50 sessions sont annoncées d'abord (le cockpit les apprend par `properties.info`, sans aucune requête), puis la
    // salle est ouverte au zoom 2 sur la racine.
    await ctx.faux.emettre(dense3d.creations);
    await attendre(1_000);
    const resultat3d = await mesurer(ctx, page, premiere.cdp, rootId, dense3d.rafales, { attendue3d: premiere.mode.mode !== "aucun" });
    releve(ctx, `M20 (3D) : ${resume(resultat3d)}`);

    // Une SECONDE suite, à sessions neuves, pour la mesure en repli : rejouer la première ne ferait naître AUCUN fait, puisque
    // le cockpit écarte les doublons par (session, appel, phase) (FactDeduper, server/shared/activity-facts.ts) — la mesure 2D
    // serait vide et le scénario tomberait sur son propre contrôle. Seuls les appels portés par la RACINE elle-même restent des
    // doublons (une session sur cinquante) : les quarante-neuf autres suffisent largement à la cadence mesurée.
    const dense2d = suiteDense("r");
    exiger(dense2d.creations.length === dense3d.creations.length, `seconde suite dense incomplète : ${resume(dense2d.entete)}`);
    await ctx.faux.emettre(dense2d.creations);
    await attendre(1_000);
    repliAFaire = { rootId, rafales: dense2d.rafales };

    // La salle est QUITTÉE avant de changer les réglages du poste : son démontage libère la scène (D-3d-28). Sans cela, la page
    // serait déchargée moteur vivant, le contexte WebGL disparaîtrait sous lui, et three écrirait son erreur dans la console.
    await page.evaluer("location.hash = '#/'");
    await page.attendreQue("!document.querySelector('.page.salle3d')", { libelle: "salle de contrôle quittée" });
    await attendre(300);
  } finally {
    // La connexion de la PREMIÈRE mesure est fermée AVANT d'ouvrir celle du repli (même usage que it3-repli) : deux connexions
    // qui émulent des réglages contraires sur le même onglet se recouvrent, la page monte alors la 3D avant de se replier, et
    // la mesure 2D compte les recalculs de cette bascule (jusqu'à 6 dans la première seconde), moteur three en erreur compris.
    await premiere.cdp.fermer();
  }
  if (repliAFaire === null) return;

  // 4. Même mesure en repli 2D : la marque `salle3d:plan` y est posée aussi (M20 compte les deux rendus).
  const repli = await preparer3d(ctx, { mouvementReduit: true });
  try {
    // Même réglage que preparer3d (R106-b) : preparerPage émule le mouvement de l'onglet du banc, qui remplacerait « reduce ».
    const page2d = await preparerPage(ctx, LARGE, { mouvement: "reduce" });
    const resultat2d = await mesurer(ctx, page2d, repli.cdp, repliAFaire.rootId, repliAFaire.rafales, { attendue3d: false });
    releve(ctx, `M20 (repli 2D) : ${resume(resultat2d)}`);
  } finally {
    // La seconde connexion fermée emporte ses réglages émulés : sa fermeture (fermetureUnique, webgl.mjs) repose, sur l'onglet
    // du banc, le « reduce » fixé par preparer3d, que la garde de R106-b relit dans la page à la fin du scénario.
    await repli.cdp.fermer();
  }
  ctx.expectNoConsoleErrors();
}

/** Conversation réelle du banc : la racine des sessions synthétiques, connue du cockpit. */
async function conversation(ctx) {
  const client = oc(ctx);
  const ia = await attendreIa(ctx);
  const racine = await client.creerConversation("it3-debit");
  const envoi = await client.envoyer(racine.id, "Réponds en une phrase.", ia);
  exiger(envoi.code === 204, `envoi refusé (${envoi.code}) : ${resume(envoi.corps)}`);
  await attendreFinDuTour(client, racine.id);
  return racine.id;
}

/**
 * Ouvre la salle au zoom 2, rejoue les rafales (une par seconde) et compte les marques. Rend le plus grand nombre de marques
 * par fenêtre d'une seconde, le nombre de secondes sans aucune marque, et les totaux.
 */
async function mesurer(ctx, page, cdp, rootId, rafales, { attendue3d }) {
  await ouvrirSalle(page, rootId);
  if (attendue3d) await attendreScene3d(page);
  else await attendre2d(page);
  await page.attendreQue("document.querySelector('.page.salle3d .zoom-conv')", { libelle: "zoom 2 de la salle de contrôle" });
  await oublierMarques(cdp, "salle3d:plan", "salle3d:scene");
  const debut = await page.evaluer("performance.now()");

  for (const lot of rafales) {
    const parti = Date.now();
    await ctx.faux.emettre(lot);
    const reste = 1_000 - (Date.now() - parti);
    if (reste > 0) await attendre(reste);
  }
  const finDesRafales = await page.evaluer("performance.now()");
  // Les derniers faits traversent encore la file d'affichage (au plus 250 ms) et le flux du cockpit.
  await attendre(1_500);
  const fin = await page.evaluer("performance.now()");

  const plans = await marques(cdp, "salle3d:plan");
  const scenes = await marques(cdp, "salle3d:scene");
  const debitPlan = debitParSeconde(plans.map((m) => m.t), { debut, fin });
  // Les secondes VIDES se comptent sur les seules SECONDES DE RAFALE : pendant l'écoulement qui suit (1,5 s, le temps que les
  // derniers faits traversent la file), la vue a déjà rattrapé et n'a plus rien à redessiner — une seconde sans marque y est
  // attendue, pas un contrôle vide. Le plafond, lui, reste compté sur toute la période, écoulement compris.
  const pendantLesRafales = debitParSeconde(plans.map((m) => m.t), { debut, fin: finDesRafales });
  const scenesPlan = scenes.filter((m) => m.detail?.cause === "plan");
  const debitScene = debitParSeconde(scenesPlan.map((m) => m.t), { debut, fin });

  // Les chiffres sont consignés AVANT les contrôles : une mesure qui dépasse le plafond doit rester lisible dans le journal.
  const mesure = {
    rendu: attendue3d ? "3d" : "2d",
    evenements: rafales.flat().length,
    plans: debitPlan.total,
    planMaxParSeconde: debitPlan.max,
    secondes: debitPlan.secondes,
    secondesDeRafale: pendantLesRafales.secondes,
    secondesVides: pendantLesRafales.vides,
    scenes: scenes.length,
    scenesDePlan: scenesPlan.length,
    sceneMaxParSeconde: debitScene.max,
    // D'où viennent les plans comptés : zoom montré et rendu, pour que la mesure désigne sans ambiguïté ce qui recalcule.
    plansParZoom: compter(plans.map((m) => `zoom${m.detail?.zoom}/${m.detail?.rendu}`)),
  };
  releve(ctx, `M20 mesurée (${mesure.rendu}) : ${resume(mesure)} ; plans par seconde ${resume(parSeconde(plans.map((m) => m.t), debut))}`);

  exiger(debitPlan.total > 0, "aucune marque salle3d:plan pendant les rafales : contrôle vide, scénario en échec.");
  exiger(pendantLesRafales.secondes >= rafales.length - 1, `période de rafale mesurée trop courte : ${pendantLesRafales.secondes} seconde(s) pour ${rafales.length} rafale(s).`);
  exiger(pendantLesRafales.vides === 0, `${pendantLesRafales.vides} seconde(s) de rafale sans aucune marque salle3d:plan : contrôle vide sur ces secondes.`);
  exiger(debitPlan.max <= PLAFOND, `${debitPlan.max} recalculs de plan dans une même seconde (plafond ${PLAFOND}).`);
  exiger(debitScene.max <= PLAFOND, `${debitScene.max} images de cause « plan » dans une même seconde (plafond ${PLAFOND}).`);
  if (attendue3d) exiger(scenes.length > 0, "aucune image rendue par le moteur three : contrôle 3D vide.");

  const rendus = new Set(plans.map((m) => m.detail?.rendu));
  exiger(rendus.has(attendue3d ? "3d" : "2d"), `plans dessinés en ${resume([...rendus])} alors que le rendu attendu est ${attendue3d ? "3d" : "2d"}.`);
  return mesure;
}

/** Compte les valeurs d'une liste : { valeur: nombre }. */
function compter(valeurs) {
  const total = {};
  for (const valeur of valeurs) total[valeur] = (total[valeur] ?? 0) + 1;
  return total;
}

/** Marques par seconde pleine depuis `debut` : la forme du débit, pour le journal et pour EXEC/mesures/L35.md. */
function parSeconde(instants, debut) {
  const seaux = [];
  for (const t of instants) {
    const seau = Math.max(0, Math.floor((t - debut) / 1_000));
    seaux[seau] = (seaux[seau] ?? 0) + 1;
  }
  return [...seaux].map((n) => n ?? 0);
}
