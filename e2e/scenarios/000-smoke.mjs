// Scénario de fumée du banc e2e (L7a) : la pile jetable est debout, le cockpit répond, sa page s'affiche dans les
// trois largeurs et les deux thèmes, le clavier circule, la console est muette, et rien n'a été facturé.
//
// Il ne vérifie aucun comportement de l'itération 1 : ceux-là arrivent avec L7b-1, L7b-2 et L13. Il vérifie le banc.

/**
 * Écarts connus du faux opencode, tolérés par ce scénario. Aucun aujourd'hui : le seul relevé par ce banc le 2026-09-16
 * (« GET /session » servi au processeur sous « /experimental/session » mais pas à l'interface, d'où une liste de
 * conversations en 404) a été corrigé au train de la vague 1 par l'intégrateur, propriétaire de
 * app/server/test-support/fake-opencode.ts après T1. La liste reste ici pour le prochain écart, et doit rester vide.
 */
const ECARTS_DU_FAUX = [];

/** Contexte remis par le banc : voir le tableau de e2e/README.md. */
export async function run(ctx) {
  const { navigateur: page } = ctx;

  // 1. Le cockpit répond et parle bien de la pile jetable.
  const sante = await ctx.api.get("/api/health");
  if (sante?.ok !== true) throw new Error(`/api/health inattendu : ${JSON.stringify(sante)}`);

  const bootstrap = await ctx.api.get("/api/bootstrap");
  if (!bootstrap || typeof bootstrap !== "object") throw new Error("/api/bootstrap n'a rien rendu.");
  if (bootstrap.opencode?.reachable !== true) throw new Error(`le cockpit ne joint pas opencode : ${JSON.stringify(bootstrap.opencode)}`);

  // 1 bis. Accès local : le schéma servi est celui du banc et, en HTTPS, l'empreinte annoncée par le Diagnostic est celle
  // que le banc a lue sur le volume et épinglée.
  if (sante.scheme !== ctx.schema) throw new Error(`schéma servi « ${sante.scheme} », attendu « ${ctx.schema} ».`);
  const securite = (await ctx.api.get("/api/system/status"))?.security;
  if (securite?.localScheme !== ctx.schema) throw new Error(`Diagnostic : schéma « ${securite?.localScheme} », attendu « ${ctx.schema} ».`);
  if (ctx.schema === "https") {
    if (securite.tls?.sha256 !== ctx.epinglage?.sha256) throw new Error(`Diagnostic : empreinte ${securite.tls?.sha256 ?? "absente"}, épinglée ${ctx.epinglage?.sha256}.`);
    if (securite.tls?.spkiSha256Base64 !== ctx.epinglage?.spki) throw new Error("Diagnostic : clé publique différente de celle épinglée.");
  } else if (securite.tls !== null) {
    throw new Error("Diagnostic : certificat annoncé en mode HTTP explicite.");
  }

  // 2. La page se charge et l'ouverture de session a bien eu lieu (la barre de navigation n'existe que connecté).
  const titre = await page.evaluer("document.title");
  if (titre !== "opencode cockpit") throw new Error(`titre inattendu : « ${titre} »`);
  await page.attendreQue("document.querySelector('nav.rail')", { libelle: "barre de navigation du cockpit" });
  const protocole = await page.evaluer("location.protocol");
  if (protocole !== `${ctx.schema}:`) throw new Error(`page servie en « ${protocole} », attendu « ${ctx.schema}: ».`);
  if ((await page.evaluer("window.isSecureContext")) !== true) throw new Error("la page n'est pas un contexte sûr.");

  // 2 bis. Flux d'événements (SSE) sous la CSP réelle : la page reçoit la trame « hello » du cockpit.
  const limiteFlux = Date.now() + 10_000;
  const hello = () => page.evenementsFlux().some((t) => t.evenement === "hello" && t.url?.startsWith(`${ctx.url}/api/events`));
  while (!hello() && Date.now() < limiteFlux) await new Promise((r) => setTimeout(r, 150));
  if (!hello()) throw new Error(`aucune trame « hello » du flux d'événements reçue par la page (${page.evenementsFlux().length} trame(s)).`);

  // 3. Parcours au clavier : la première tabulation donne le focus à un élément de la page.
  await page.touche("Tab");
  const focus = await page.focus();
  if (!focus || focus.startsWith("body")) throw new Error(`la tabulation ne donne le focus à rien (« ${focus} »).`);

  // 4. Captures : 1440, 1024 et 400, en clair et en sombre.
  const captures = await ctx.screenshot("accueil");
  if (captures.length !== 6) throw new Error(`6 captures attendues, ${captures.length} faites.`);

  // 5. Journal réseau : rien n'est allé ailleurs que sur le cockpit, et aucune requête n'a échoué.
  const journal = page.journalReseau();
  const dehors = journal.filter((ligne) => ligne.url && !ligne.url.startsWith(ctx.url) && !ligne.url.startsWith("data:") && !ligne.url.startsWith("blob:"));
  if (dehors.length > 0) throw new Error(`la page est allée hors du cockpit : ${dehors.map((l) => l.url).join(", ").slice(0, 200)}`);
  const echouees = journal.filter((ligne) => ligne.etat === "échouée");
  if (echouees.length > 0) throw new Error(`requêtes en échec : ${echouees.map((l) => `${l.url} (${l.raison})`).join(", ").slice(0, 300)}`);
  const refusees = journal
    .filter((ligne) => typeof ligne.code === "number" && ligne.code >= 400)
    .filter((ligne) => !ECARTS_DU_FAUX.some((motif) => motif.test(ligne.url ?? "")));
  if (refusees.length > 0) throw new Error(`réponses en erreur : ${refusees.map((l) => `${l.code} ${l.url}`).join(", ").slice(0, 300)}`);

  // 6. Console muette, aux écarts connus du faux près.
  ctx.expectNoConsoleErrors(ECARTS_DU_FAUX);

  // 7. Le cockpit a bien parlé à opencode, et rien n'a été facturé par la fumée.
  if (ctx.mode === "faux") {
    const recues = await ctx.opencodeRequests();
    if (recues.length === 0) throw new Error("le faux opencode n'a reçu aucune requête du cockpit.");
    const factures = await ctx.billedCalls();
    if (factures.length > 0) throw new Error(`${factures.length} appel(s) facturable(s) pendant la fumée : ${factures.map((r) => `${r.method} ${r.pathname}`).join(", ")}`);
  }
}
