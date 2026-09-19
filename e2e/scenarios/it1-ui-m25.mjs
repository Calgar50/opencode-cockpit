// Scénario e2e de l'interface de l'itération 1 (L7b-2) : mesure M25 en HTTP, flux d'événements (SSE) et animations (WAAPI) sous la CSP.
//
// Spécification §8 M25 (« WAAPI et SSE (L14), puis WebGL (L29), sous la CSP réelle, en HTTPS avec avertissement accepté ») ; décision
// D-05 du découpage : e2e en HTTP jusqu'au rebase de la 1.0.5, M25 mesurée en HTTP sous la CSP réelle, écart noté au RECAPITULATIF.
// A9 (décisions du 19/09) : porte R105b souple pour les paquets e2e ; tant que chantier/1.1 n'a pas le banc HTTPS épinglé (R105b),
// le HTTP explicite est gardé, avec la mention « en attente » pour le HTTPS. La partie SSE en HTTPS épinglé a été mesurée par R105b
// sur tmp/r105-base (mesures/M25-r105b.md) ; la partie WebGL appartient à L29.
//
// Ce que le scénario établit (tous les modes du banc ; la partie WAAPI en direct demande un tour, joué aussi en « --reel-hors-ligne ») :
//   1. CSP réelle servie avec la page : default-src, script-src et connect-src sur 'self', ni 'unsafe-eval' ni script en ligne ;
//      page en HTTP sur la boucle locale (contexte sûr) ;
//   2. SSE : le flux /api/events est ouvert par la page (réponse 200, jamais en échec), la pastille est au vert ; un réglage changé
//      par l'API (mode Avancé) arrive par le flux : la page l'applique sans relire l'amorçage ni les réglages ; retour au mode Simple
//      de même ;
//   3. WAAPI : en mode Avancé, la bande néon suit un tour en direct ; chaque changement passe par une transition element.animate()
//      d'environ 900 ms, sur transform et opacity, jouée une fois, jamais bloquée par la CSP ; aucune animation sans fin dans la page ;
//   4. aucune violation de la CSP (écouteur securitypolicyviolation), console muette.
import {
  attendre,
  attendreFinDuTour,
  attendreIa,
  attendreModeAffiche,
  changerMode,
  exiger,
  exigerAucuneViolationCsp,
  oc,
  ouvrirConversation,
  preparerPage,
  releve,
  releves,
  resume,
} from "./it1-ui-commun.mjs";

export async function run(ctx) {
  // 1. CSP réelle et HTTP explicite (D-05).
  const reponse = await fetch(`${ctx.url}/`, { headers: { cookie: ctx.api.cookie } });
  const csp = reponse.headers.get("content-security-policy") ?? "";
  await reponse.body?.cancel();
  const directives = new Map(
    csp
      .split(";")
      .map((d) => d.trim().split(/\s+/))
      .filter((d) => d[0])
      .map(([nom, ...valeurs]) => [nom, valeurs]),
  );
  for (const nom of ["default-src", "script-src", "connect-src"]) {
    exiger(JSON.stringify(directives.get(nom)) === JSON.stringify(["'self'"]), `CSP : ${nom} = ${resume(directives.get(nom))} au lieu de 'self'.`);
  }
  exiger(!csp.includes("unsafe-eval"), "CSP : 'unsafe-eval' présent.");
  const page = await preparerPage(ctx);
  exiger(await page.evaluer("location.protocol === 'http:' && window.isSecureContext === true"), "page hors HTTP ou hors contexte sûr.");

  // 2. SSE : flux ouvert, réglage reçu par le flux et appliqué sans relecture.
  await page.attendreQue("document.querySelector('.rail-footer .dot.good')", { libelle: "pastille du flux au vert" });
  const flux = page.journalReseau().filter((l) => new URL(l.url).pathname === "/api/events");
  exiger(flux.length >= 1 && flux.every((l) => l.etat !== "échouée" && (l.code === undefined || l.code === 200)), `flux d'événements : ${resume(flux)}`);
  await attendreModeAffiche(page, "simple");
  const avant = page.journalReseau().length;
  const depuis = Date.now();
  const modeAvant = await changerMode(ctx, "avance");
  let latence = null;
  try {
    await attendreModeAffiche(page, "avance");
    latence = Date.now() - depuis;
    const relectures = page.journalReseau().slice(avant).filter((l) => /\/api\/(bootstrap|settings)$/.test(new URL(l.url).pathname));
    exiger(relectures.length === 0, `la page a relu ${resume(relectures.map((l) => l.url))} au lieu de recevoir le réglage par le flux.`);

    // 3. WAAPI : un tour en direct dans la bande dépliée (mode Avancé).
    const ia = await attendreIa(ctx);
    const client = oc(ctx);
    const racine = await client.creerConversation("it1-ui-m25");
    if (ctx.faux) await ctx.faux.scripter(racine.id, { stepMs: 700, text: "Réponse du faux, en plusieurs temps." });
    await ouvrirConversation(ctx, racine.id);
    const envoi = await client.envoyer(racine.id, "Réponds en une phrase.", ia);
    exiger(envoi.code === 204, `envoi refusé (${envoi.code}) : ${resume(envoi.corps)}`);
    await attendreFinDuTour(client, racine.id);
    await page.attendreQue(`document.querySelector('.neon-map .neon-noeud.is-termine')`, { libelle: "assistant de la conversation « terminé » sur la carte" });
    await attendre(1_200);
    const vus = await releves(page);
    exiger(vus.animations.length > 0, "aucune transition WAAPI relevée sur la carte pendant le tour.");
    const hors = vus.animations.filter((a) => a.duree < 800 || a.duree > 1_000 || a.iterations !== 1 || a.proprietes.some((p) => p !== "transform" && p !== "opacity"));
    exiger(hors.length === 0, `transition(s) hors de la règle : ${resume(hors)}`);
    const sansFin = await page.evaluer("document.getAnimations().filter((a) => a.effect && a.effect.getTiming().iterations === Infinity).length");
    exiger(sansFin === 0, `${sansFin} animation(s) sans fin dans la page.`);
    releve(
      ctx,
      `M25 en HTTP (D-05) : CSP « ${csp} » ; flux ouvert, réglage reçu par le flux en ${latence} ms ; ${vus.animations.length} transition(s) WAAPI ` +
        `de ${[...new Set(vus.animations.map((a) => a.duree))].join(", ")} ms sur ${[...new Set(vus.animations.flatMap((a) => a.proprietes))].join(" et ")} ; ` +
        `${vus.violations.length} violation de la CSP ; HTTPS épinglé : en attente de R105b dans chantier/1.1`,
    );
  } finally {
    await changerMode(ctx, modeAvant === "avance" ? "avance" : "simple");
  }
  await attendreModeAffiche(page, "simple");
  await exigerAucuneViolationCsp(page);
  ctx.expectNoConsoleErrors();
}
