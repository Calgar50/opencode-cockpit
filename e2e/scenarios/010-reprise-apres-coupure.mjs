// Scénario « reprise après une coupure » (1.1, défaut constaté pendant la mesure M25 de R105b, décision U4) : le rechargement
// des données d'amorçage (/api/bootstrap) échoue pendant une coupure. L'interface déjà chargée doit rester en place, avec un
// bandeau d'état poli (focus et brouillon gardés, aucune animation infinie), et se rétablir SEULE :
//   A. coupure réseau émulée, puis retour du réseau : reprise aussitôt, à l'événement « online » ;
//   B. requête d'amorçage bloquée, puis débloquée sans événement réseau : reprise au retour de l'onglet (« visibilitychange ») ;
//   C. session perdue (401) pendant un rechargement : écran de connexion, et aucune tentative ensuite.
// Après chaque reprise, plus aucune tentative ne tourne en arrière-plan.
//
// Déclencheur : un changement de réglage d'IA (ai.chatDefaultTier, permis en mode Simple) fait envoyer « ai.changed » par le
// cockpit ; la page recharge alors /api/bootstrap 800 ms plus tard. La coupure émulée laisse passer le flux d'événements déjà
// ouvert (mesuré en M25) mais fait échouer toute requête nouvelle : c'est le cas vu 4 fois sur 4 pendant M25.

const NIVEAUX = ["rapide", "equilibre", "expert"];
const BROUILLON = "brouillon e2e reprise";
const OPEN_SEULEMENT = String.raw`Accès par .\cockpit.ps1 open`;
const attendre = (ms) => new Promise((r) => setTimeout(r, ms));

/** État de l'interface vu dans la page : barre de navigation, écran d'erreur, bandeau de reprise, écran de connexion. */
const ETAT = `(() => {
  const ecran = [...document.querySelectorAll("h3")].some((h) => h.textContent.includes("Le cockpit ne répond pas"));
  const zone = document.querySelector("[data-testid='reprise-amorcage']");
  const bandeau = zone ? zone.querySelector(".banner") : null;
  const animationsInfinies = zone
    ? document.getAnimations().filter((a) => a.effect && zone.contains(a.effect.target) && a.effect.getTiming().iterations === Infinity).length
    : 0;
  return {
    rail: Boolean(document.querySelector("nav.rail")),
    ecran,
    connexion: Boolean(document.querySelector("form input[type='password']")) || document.body.textContent.includes(${JSON.stringify(OPEN_SEULEMENT)}),
    zoneRole: zone ? zone.getAttribute("role") : null,
    zoneTexte: zone ? zone.textContent.trim() : null,
    bandeau: bandeau ? bandeau.textContent.trim() : null,
    animationsInfinies,
    focusGarde: document.activeElement ? document.activeElement.getAttribute("data-e2e-focus") === "1" : false,
    brouillon: document.querySelector("textarea[aria-label='Message']")?.value ?? null,
  };
})()`;

/** Requêtes GET /api/bootstrap du journal depuis l'indice `depuis`. */
const amorcages = (page, depuis) => page.journalReseau().slice(depuis).filter((l) => l.methode === "GET" && l.url && new URL(l.url).pathname === "/api/bootstrap");
const echouees = (page, depuis) => amorcages(page, depuis).filter((l) => l.etat === "échouée");

async function attendreCondition(fn, delaiMs, pasMs = 100) {
  const limite = Date.now() + delaiMs;
  while (Date.now() < limite) {
    const valeur = await fn();
    if (valeur) return valeur;
    await attendre(pasMs);
  }
  return null;
}

/** Interface rétablie : barre de navigation, ni écran d'erreur ni bandeau, et un amorçage réussi depuis `depuis`. */
const attendreReprise = (page, depuis, delaiMs) =>
  attendreCondition(async () => {
    const etat = await page.evaluer(ETAT);
    return etat.rail && !etat.ecran && !etat.bandeau && amorcages(page, depuis).some((l) => l.code === 200) ? etat : null;
  }, delaiMs);

/** Plus aucune requête d'amorçage pendant `ms` : rien ne tourne en arrière-plan. */
async function amorcagesPendant(page, ms) {
  const depuis = page.journalReseau().length;
  await attendre(ms);
  return amorcages(page, depuis).length;
}

/** Contexte remis par le banc : voir le tableau de e2e/README.md. */
export async function run(ctx) {
  const { navigateur: page } = ctx;
  const bilan = [];
  await page.attendreQue("document.querySelector('nav.rail')", { libelle: "barre de navigation du cockpit" });
  await attendreCondition(() => page.evenementsFlux().some((t) => t.evenement === "hello"), 10_000);

  // Règles d'utilisation acceptées comme un utilisateur (sinon la fenêtre rend l'interface inerte et le champ Message
  // injoignable) ; la valeur d'origine est remise à la fin.
  const reglesAvant = (await ctx.api.get("/api/settings"))?.ui?.rulesAcceptedVersion ?? 0;
  const versionRegles = (await ctx.api.get("/api/bootstrap"))?.rulesVersion;
  if (Number.isInteger(versionRegles) && reglesAvant !== versionRegles) {
    await ctx.api.put("/api/settings", { ui: { rulesAcceptedVersion: versionRegles } });
    await page.attendreQue("!document.querySelector('.rules-modal')", { libelle: "fenêtre des règles refermée" });
  }

  // Focus et brouillon : posés avant la coupure, ils doivent survivre à la reprise (l'interface n'est jamais remplacée).
  const brouillon = await page.evaluer(
    "(() => { const t = document.querySelector(\"textarea[aria-label='Message']\"); if (!t || t.disabled) return false; t.focus(); return document.activeElement === t; })()",
  );
  if (!brouillon) throw new Error("champ Message introuvable ou inactif : brouillon impossible à poser.");
  await page.taper(BROUILLON);
  if ((await page.evaluer("document.activeElement.value")) !== BROUILLON) throw new Error("brouillon non saisi dans le champ Message.");
  await page.evaluer("document.activeElement.setAttribute('data-e2e-focus', '1')");
  await page.evaluer(
    "window.__e2eReseau = { online: 0, offline: 0 }; window.addEventListener('online', () => window.__e2eReseau.online++); window.addEventListener('offline', () => window.__e2eReseau.offline++); true",
  );

  const niveauAvant = (await ctx.api.get("/api/settings"))?.ai?.chatDefaultTier;
  if (!NIVEAUX.includes(niveauAvant)) throw new Error(`niveau d'IA des nouvelles conversations inattendu : « ${niveauAvant} ».`);
  const niveaux = { avant: niveauAvant, autre: NIVEAUX.find((n) => n !== niveauAvant), courant: niveauAvant };
  const changerNiveau = async (niveau) => {
    await ctx.api.put("/api/settings", { ai: { chatDefaultTier: niveau } });
    niveaux.courant = niveau;
  };

  try {
    await coupureReseau(page, { changerNiveau, niveaux, bilan, screenshot: ctx.screenshot });
    await retourOnglet(page, { changerNiveau, niveaux, bilan });
    await sessionPerdue(page, ctx.url, { changerNiveau, niveaux, bilan });
  } finally {
    await page.horsLigne(false).catch(() => {});
    await page.bloquer([]).catch(() => {});
    if (niveaux.courant !== niveaux.avant) await ctx.api.put("/api/settings", { ai: { chatDefaultTier: niveaux.avant } }).catch(() => {});
    await ctx.api.put("/api/settings", { ui: { rulesAcceptedVersion: reglesAvant } }).catch(() => {});
    if (bilan.length > 0) console.log(`        ${bilan.join("\n        ")}`);
  }
}

/** A. Coupure réseau émulée pendant un rechargement, puis retour du réseau : reprise à l'événement « online ». */
async function coupureReseau(page, { changerNiveau, niveaux, bilan, screenshot }) {
  const journal = page.journalReseau().length;
  await page.horsLigne(true);
  await changerNiveau(niveaux.autre);
  if (!(await attendreCondition(() => echouees(page, journal)[0], 6_000))) {
    throw new Error("A : déclencheur absent : aucun rechargement de /api/bootstrap pendant la coupure (« ai.changed » non reçu ?).");
  }
  const debut = Date.now();
  const pendant = [];
  while (Date.now() - debut < 8_000) {
    pendant.push(await page.evaluer(ETAT));
    await attendre(250);
  }
  const tentatives = echouees(page, journal).length;
  const horsLigne = await page.evaluer("navigator.onLine === false");
  // Bandeau (ou écran) pendant la coupure, dans les trois largeurs et les deux thèmes : la tentative suivante tombe dans 9 s.
  await screenshot("pendant-coupure");
  const journalRetour = page.journalReseau().length;
  await page.horsLigne(false);
  const retour = Date.now();
  const repris = await attendreReprise(page, journalRetour, 45_000);
  const delai = Date.now() - retour;
  const reseau = await page.evaluer("window.__e2eReseau");
  const resultat = repris ? `reprise ${delai} ms après le retour du réseau` : "AUCUNE reprise";
  bilan.push(`A : ${tentatives} tentative(s) en 8 s de coupure, hors ligne=${horsLigne}, « offline »/« online » reçus ${reseau?.offline}/${reseau?.online}, ${resultat}`);
  if (!repris) {
    const etat = await page.evaluer(ETAT);
    throw new Error(
      `A : interface non rétablie ${Math.round(delai / 1000)} s après le retour du réseau (écran « Le cockpit ne répond pas » : ${etat.ecran ? "affiché" : "absent"}, ` +
        `barre de navigation : ${etat.rail ? "présente" : "absente"}, ${tentatives} tentative(s) pendant la coupure, ` +
        `${amorcages(page, journalRetour).length} après le retour). ${bilan.join(" ; ")}`,
    );
  }
  if (pendant.some((e) => e.ecran || !e.rail)) throw new Error("A : l'interface déjà chargée a été remplacée par l'écran « Le cockpit ne répond pas » pendant la coupure.");
  const vu = pendant.find((e) => e.bandeau);
  if (!vu) throw new Error("A : aucun bandeau de reprise pendant la coupure.");
  if (!vu.bandeau.includes("Le cockpit ne répond pas") || !vu.bandeau.includes("Nouvelle tentative automatique")) throw new Error(`A : bandeau inattendu : « ${vu.bandeau} ».`);
  if (vu.zoneRole !== "status") throw new Error(`A : annonce du bandeau « ${vu.zoneRole} », attendu role="status" (annonce polie).`);
  if (pendant.some((e) => e.animationsInfinies > 0)) throw new Error("A : animation infinie dans le bandeau de reprise.");
  if (pendant.some((e) => !e.focusGarde)) throw new Error("A : le focus a quitté l'élément qui l'avait pendant la coupure.");
  // Attente croissante : 2 puis 5 s après le premier échec, donc 3 tentatives en 8 s ; jamais une boucle serrée.
  if (tentatives < 2 || tentatives > 4) throw new Error(`A : ${tentatives} tentative(s) en 8 s de coupure, 2 à 4 attendues (2, puis 5 s d'attente).`);
  if (!(reseau?.online >= 1)) throw new Error("A : la page n'a pas reçu l'événement « online » au retour du réseau émulé.");
  // La tentative programmée suivante tombait environ 9 s après le retour : une reprise bien avant vient de « online ».
  if (delai > 3_000) throw new Error(`A : reprise ${delai} ms après le retour du réseau, attendue aussitôt (événement « online »).`);
  if (!repris.focusGarde) throw new Error("A : le focus n'est plus sur l'élément qui l'avait avant la coupure.");
  if (repris.brouillon !== BROUILLON) throw new Error(`A : brouillon perdu (« ${repris.brouillon} »).`);
  if (!repris.zoneTexte?.includes("Le cockpit répond de nouveau")) throw new Error(`A : reprise non annoncée (zone d'annonce : « ${repris.zoneTexte} »).`);
  // La tentative suivante serait tombée dans ces 12 s si la minuterie n'avait pas été nettoyée.
  const reste = await amorcagesPendant(page, 12_000);
  if (reste > 0) throw new Error(`A : ${reste} requête(s) d'amorçage encore envoyée(s) après la reprise.`);
}

/** B. Amorçage bloqué, puis débloqué sans événement réseau : reprise au retour de l'onglet (« visibilitychange »). */
async function retourOnglet(page, { changerNiveau, niveaux, bilan }) {
  const journal = page.journalReseau().length;
  await page.bloquer(["*/api/bootstrap*"]);
  await changerNiveau(niveaux.avant);
  if (!(await attendreCondition(() => echouees(page, journal)[0], 6_000))) throw new Error("B : déclencheur absent : aucun rechargement de /api/bootstrap bloqué.");
  await attendre(2_800);
  const tentatives = echouees(page, journal).length;
  await page.bloquer([]);
  await attendre(700);
  if (!(await page.evaluer(ETAT)).bandeau) throw new Error("B : bandeau de reprise absent alors que l'amorçage échoue encore.");
  const journalVisible = page.journalReseau().length;
  const visible = Date.now();
  // Onglet « revenu » : visibilityState vaut déjà « visible », seul l'événement manque (sans fenêtre, l'onglet ne se cache pas).
  await page.evaluer("document.dispatchEvent(new Event('visibilitychange')), document.visibilityState");
  const repris = await attendreReprise(page, journalVisible, 10_000);
  const delai = Date.now() - visible;
  bilan.push(`B : ${tentatives} tentative(s) bloquée(s), ${repris ? `reprise ${delai} ms après « visibilitychange »` : "AUCUNE reprise"}`);
  if (!repris) throw new Error(`B : interface non rétablie après « visibilitychange ». ${bilan.join(" ; ")}`);
  // La tentative programmée suivante tombait 5 s après la deuxième : une reprise en moins de 2 s vient de l'onglet.
  if (delai > 2_000) throw new Error(`B : reprise ${delai} ms après « visibilitychange », attendue aussitôt.`);
  if (!repris.focusGarde) throw new Error("B : le focus n'est plus sur l'élément qui l'avait avant la coupure.");
}

/** C. Session perdue (401) pendant un rechargement : écran de connexion, jamais une boucle de tentatives. */
async function sessionPerdue(page, url, { changerNiveau, niveaux, bilan }) {
  const journal = page.journalReseau().length;
  // Cookie de session retiré de l'onglet : la requête suivante de la page reçoit 401, comme après une session expirée.
  await page.effacerCookie({ name: "__Host-cockpit_session", url });
  await changerNiveau(niveaux.autre);
  // Le premier 401 peut venir de l'amorçage ou d'une autre requête relancée par « ai.changed » : chacun ramène à la connexion.
  const refus = await attendreCondition(() => page.journalReseau().slice(journal).find((l) => l.code === 401), 6_000);
  if (!refus) throw new Error("C : aucune requête refusée en 401 après la perte de session.");
  const connexion = await attendreCondition(async () => {
    const etat = await page.evaluer(ETAT);
    return etat.connexion && !etat.rail ? etat : null;
  }, 5_000);
  if (!connexion) throw new Error(`C : écran de connexion absent après un 401 (${JSON.stringify(await page.evaluer(ETAT))}).`);
  const reste = await amorcagesPendant(page, 12_000);
  bilan.push(`C : 401 (${refus.methode} ${new URL(refus.url).pathname}) puis écran de connexion, ${reste} tentative(s) en 12 s`);
  if (reste > 0) throw new Error(`C : ${reste} requête(s) d'amorçage après le 401 : une session perdue ne doit jamais relancer de tentatives.`);
}
