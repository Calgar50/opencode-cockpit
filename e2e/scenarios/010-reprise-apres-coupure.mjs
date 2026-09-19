// Scénario « reprise après une coupure » (1.1, défaut constaté pendant la mesure M25 de R105b, décision U4) : le rechargement
// des données d'amorçage (/api/bootstrap) échoue pendant une coupure. L'interface déjà chargée doit rester en place, avec un
// bandeau d'état poli (focus et brouillon gardés, aucune animation infinie), et se rétablir SEULE :
//   A. coupure réseau émulée, puis retour du réseau : reprise aussitôt, à l'événement « online » ;
//   B. requête d'amorçage bloquée, puis débloquée sans événement réseau : reprise au retour de l'onglet (« visibilitychange ») ;
//   C. focus clavier sur « Réessayer », reprise : le focus est rattrapé sur la zone d'annonce, jamais laissé sur body ;
//   D. onglet caché : aucune tentative programmée tant qu'il l'est, reprise aussitôt à son retour ;
//   E. vrai redémarrage du conteneur du cockpit : reprise dès la reconnexion du flux d'événements (trame « hello »), bien
//      avant la tentative programmée ;
//   F. amorçage lent puis deux changements rapprochés : le rafraîchissement dû au second ne reçoit jamais la réponse en cours,
//      calculée avant lui ; une seule nouvelle requête part à sa fin, et l'affichage finit sur la valeur du serveur ;
//   G. session perdue (401) pendant un rechargement : écran de connexion, et aucune tentative ensuite.
// Après chaque reprise, plus aucune tentative ne tourne en arrière-plan. C à F viennent de la vérification de c630349.
//
// Déclencheur : un changement de réglage d'IA (ai.chatDefaultTier, permis en mode Simple) fait envoyer « ai.changed » par le
// cockpit ; la page recharge alors /api/bootstrap 800 ms plus tard. La coupure émulée laisse passer le flux d'événements déjà
// ouvert (mesuré en M25) mais fait échouer toute requête nouvelle : c'est le cas vu 4 fois sur 4 pendant M25.

const NIVEAUX = ["rapide", "equilibre", "expert"];
/** Libellés des niveaux (TIER_LABELS de server/shared/assistant-rules.ts). */
const LIBELLES = { rapide: "Rapide", equilibre: "Équilibré", expert: "Expert" };
const BROUILLON = "brouillon e2e reprise";
const OPEN_SEULEMENT = String.raw`Accès par .\cockpit.ps1 open`;
const attendre = (ms) => new Promise((r) => setTimeout(r, ms));

/** État de l'interface vu dans la page : barre de navigation, écran d'erreur, bandeau de reprise, écran de connexion, focus. */
const ETAT = `(() => {
  const ecran = [...document.querySelectorAll("h3")].some((h) => h.textContent.includes("Le cockpit ne répond pas"));
  const zone = document.querySelector("[data-testid='reprise-amorcage']");
  const bandeau = zone ? zone.querySelector(".banner") : null;
  const animationsInfinies = zone
    ? document.getAnimations().filter((a) => a.effect && zone.contains(a.effect.target) && a.effect.getTiming().iterations === Infinity).length
    : 0;
  const actif = document.activeElement;
  const main = document.querySelector("main");
  return {
    rail: Boolean(document.querySelector("nav.rail")),
    ecran,
    connexion: Boolean(document.querySelector("form input[type='password']")) || document.body.textContent.includes(${JSON.stringify(OPEN_SEULEMENT)}),
    zoneRole: zone ? zone.getAttribute("role") : null,
    zoneTexte: zone ? zone.textContent.trim() : null,
    bandeau: bandeau ? bandeau.textContent.trim() : null,
    animationsInfinies,
    focusGarde: actif ? actif.getAttribute("data-e2e-focus") === "1" : false,
    focus: !actif || actif === document.body ? "body" : actif.tagName.toLowerCase() + ":" + (actif.getAttribute("aria-label") || actif.textContent || "").trim().slice(0, 60),
    focusSurZone: Boolean(zone) && actif === zone,
    fluxPerdu: document.body.textContent.includes("Connexion au cockpit perdue"),
    defilement: [document.scrollingElement ? document.scrollingElement.scrollTop : 0, main ? main.scrollTop : 0].join("/"),
    brouillon: document.querySelector("textarea[aria-label='Message']")?.value ?? null,
  };
})()`;

/** Premier élément qui suit la zone d'annonce dans l'ordre de tabulation (visible, hors de la zone), au format de page.focus(). */
const SUIVANT_ZONE = `(() => {
  const zone = document.querySelector("[data-testid='reprise-amorcage']");
  if (!zone) return null;
  const el = [...document.querySelectorAll("a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select, [tabindex]:not([tabindex='-1'])")]
    .find((e) => !zone.contains(e) && (zone.compareDocumentPosition(e) & Node.DOCUMENT_POSITION_FOLLOWING) && e.offsetParent !== null);
  return el ? el.tagName.toLowerCase() + ":" + (el.getAttribute("aria-label") || el.textContent || "").trim().slice(0, 60) : null;
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
  // injoignable) ; les valeurs d'origine (règles, mode d'affichage, niveau) sont remises à la fin.
  const reglages = (await ctx.api.get("/api/settings")) ?? {};
  const reglesAvant = reglages.ui?.rulesAcceptedVersion ?? 0;
  const modeAvant = reglages.ui?.mode ?? "simple";
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
  const niveaux = { avant: niveauAvant, courant: niveauAvant };
  const changerNiveau = async (niveau) => {
    await ctx.api.put("/api/settings", { ai: { chatDefaultTier: niveau } });
    niveaux.courant = niveau;
  };
  // Toujours une autre valeur que la courante : chaque changement fait envoyer « ai.changed ».
  const basculerNiveau = () => changerNiveau(NIVEAUX.find((n) => n !== niveaux.courant));
  const outils = { changerNiveau, basculerNiveau, niveaux, bilan, screenshot: ctx.screenshot };

  try {
    await coupureReseau(page, outils);
    await retourOnglet(page, outils);
    await focusReessayer(page, outils);
    await ongletCache(page, outils);
    await redemarrageReel(page, ctx.pile, outils);
    await amorcageLent(page, ctx.api, outils);
    await sessionPerdue(page, ctx.url, outils);
  } finally {
    await page.horsLigne(false).catch(() => {});
    await page.bloquer([]).catch(() => {});
    if (niveaux.courant !== niveaux.avant) await ctx.api.put("/api/settings", { ai: { chatDefaultTier: niveaux.avant } }).catch(() => {});
    await ctx.api.put("/api/settings", { ui: { rulesAcceptedVersion: reglesAvant, mode: modeAvant } }).catch(() => {});
    if (bilan.length > 0) console.log(`        ${bilan.join("\n        ")}`);
  }
}

/** A. Coupure réseau émulée pendant un rechargement, puis retour du réseau : reprise à l'événement « online ». */
async function coupureReseau(page, { basculerNiveau, bilan, screenshot }) {
  const journal = page.journalReseau().length;
  await page.horsLigne(true);
  await basculerNiveau();
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
async function retourOnglet(page, { basculerNiveau, bilan }) {
  const journal = page.journalReseau().length;
  await page.bloquer(["*/api/bootstrap*"]);
  await basculerNiveau();
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

/**
 * C. Focus clavier sur « Réessayer » du bandeau, puis reprise : le bouton disparaît avec le bandeau. Le focus doit être
 * rattrapé sur la zone d'annonce (jamais laissé sur body, où un lecteur d'écran perd sa position), sans défilement, et la
 * touche Tab suivante doit mener à l'élément qui suivait le bandeau.
 */
async function focusReessayer(page, { basculerNiveau, bilan, screenshot }) {
  const journal = page.journalReseau().length;
  await page.bloquer(["*/api/bootstrap*"]);
  await basculerNiveau();
  if (!(await attendreCondition(() => echouees(page, journal)[0], 6_000))) throw new Error("C : déclencheur absent : aucun rechargement de /api/bootstrap bloqué.");
  if (!(await attendreCondition(async () => (await page.evaluer(ETAT)).bandeau, 3_000))) throw new Error("C : bandeau de reprise absent alors que l'amorçage échoue.");
  const pose = await page.evaluer(
    "(() => { const b = document.querySelector(\"[data-testid='reprise-amorcage'] .banner button\"); if (!b) return false; b.focus(); return document.activeElement === b; })()",
  );
  if (!pose) throw new Error("C : focus impossible à poser sur « Réessayer » du bandeau.");
  const defilementAvant = (await page.evaluer(ETAT)).defilement;
  await page.bloquer([]);
  const journalReprise = page.journalReseau().length;
  await page.touche("Enter");
  const repris = await attendreReprise(page, journalReprise, 8_000);
  if (!repris) throw new Error(`C : interface non rétablie après « Réessayer » au clavier. ${bilan.join(" ; ")}`);
  // Focus rattrapé, dans les trois largeurs et les deux thèmes (repère de focus de la zone d'annonce).
  await screenshot("focus-rattrape");
  const suivant = await page.evaluer(SUIVANT_ZONE);
  await page.touche("Tab");
  const apresTab = await page.focus();
  bilan.push(`C : « Réessayer » au clavier, reprise ; focus ensuite sur « ${repris.focus} », puis Tab vers « ${apresTab} » (attendu « ${suivant} »)`);
  if (repris.focus === "body") throw new Error("C : focus retombé sur body à la disparition du bandeau (position perdue pour un lecteur d'écran).");
  if (!repris.focusSurZone) throw new Error(`C : focus sur « ${repris.focus} », attendu sur la zone d'annonce de la reprise.`);
  if (repris.defilement !== defilementAvant) throw new Error(`C : la page a défilé (${defilementAvant} puis ${repris.defilement}) en rattrapant le focus.`);
  if (!suivant) throw new Error("C : aucun élément focalisable après la zone d'annonce : contrôle de la touche Tab impossible.");
  if (apresTab !== suivant) throw new Error(`C : Tab mène à « ${apresTab} », attendu « ${suivant} » (élément qui suivait le bandeau).`);
}

/**
 * D. Onglet caché pendant une reprise : la tentative programmée attend son retour, rien ne tourne en arrière-plan ; reprise
 * aussitôt quand il revient. Sans fenêtre, l'onglet ne se cache pas : document.visibilityState est forcé, puis rendu.
 */
async function ongletCache(page, { basculerNiveau, bilan }) {
  await page.evaluer(
    "Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => window.__e2eVisibilite || 'visible' }); window.__e2eVisibilite = 'hidden'; document.dispatchEvent(new Event('visibilitychange')); document.visibilityState",
  );
  try {
    const journal = page.journalReseau().length;
    await page.bloquer(["*/api/bootstrap*"]);
    await basculerNiveau();
    if (!(await attendreCondition(() => echouees(page, journal)[0], 6_000))) throw new Error("D : déclencheur absent : aucun rechargement de /api/bootstrap bloqué.");
    // Onglet visible, la reprise enverrait des tentatives 2 puis 7 s après cet échec : 12 s sans aucune prouvent l'attente.
    await attendre(12_000);
    const pendantCache = amorcages(page, journal).length;
    await page.bloquer([]);
    const journalRetour = page.journalReseau().length;
    const retour = Date.now();
    await page.evaluer("window.__e2eVisibilite = 'visible'; document.dispatchEvent(new Event('visibilitychange')); document.visibilityState");
    const repris = await attendreReprise(page, journalRetour, 5_000);
    const delai = Date.now() - retour;
    bilan.push(`D : onglet caché, ${pendantCache} requête(s) d'amorçage en 12 s ; ${repris ? `reprise ${delai} ms après son retour` : "AUCUNE reprise"}`);
    if (pendantCache !== 1) {
      throw new Error(`D : ${pendantCache} requête(s) d'amorçage onglet caché, 1 attendue (le rechargement dû au changement, puis plus rien jusqu'au retour).`);
    }
    if (!repris) throw new Error(`D : interface non rétablie au retour de l'onglet. ${bilan.join(" ; ")}`);
    if (delai > 2_000) throw new Error(`D : reprise ${delai} ms après le retour de l'onglet, attendue aussitôt.`);
  } finally {
    await page.evaluer("delete document.visibilityState; document.visibilityState").catch(() => {});
  }
}

/**
 * E. Vrai redémarrage du conteneur du cockpit (pile jetable) pendant une reprise en attente : l'amorçage repart dès la
 * reconnexion du flux d'événements (trame « hello »), bien avant la tentative programmée, puis plus rien ne tourne. La page
 * recharge aussi l'amorçage 800 ms après la reconnexion : seul un départ bien plus tôt prouve le déclencheur « flux ».
 */
async function redemarrageReel(page, pile, { basculerNiveau, bilan }) {
  if (!pile) throw new Error("E : le banc ne donne pas ctx.pile : redémarrage réel impossible.");
  const journal = page.journalReseau().length;
  await page.bloquer(["*/api/bootstrap*"]);
  await basculerNiveau();
  // Deux échecs (rechargement, puis tentative 2 s après) : la reprise attend alors 5 s, le conteneur est arrêté pendant ce temps.
  if (!(await attendreCondition(() => echouees(page, journal).length >= 2, 8_000))) throw new Error("E : deux échecs d'amorçage attendus avant l'arrêt du conteneur.");
  await page.bloquer([]);
  let arrete = false;
  try {
    await pile.arreter("cockpit");
    arrete = true;
    // Troisième tentative, cockpit arrêté : échec, puis reprise programmée 10 s après elle.
    if (!(await attendreCondition(() => echouees(page, journal).length >= 3, 10_000))) throw new Error("E : aucune tentative d'amorçage pendant l'arrêt du conteneur.");
    const echeance = echouees(page, journal)[2].envoyeeA + 10_000;
    const journalRelance = page.journalReseau().length;
    const relance = Date.now();
    await pile.demarrer("cockpit");
    arrete = false;
    const repris = await attendreReprise(page, journalRelance, 25_000);
    const reprise = Date.now();
    const hello = page.evenementsFlux().find((t) => t.evenement === "hello" && t.recuA >= relance);
    const premier = hello ? amorcages(page, journalRelance).find((l) => l.envoyeeA >= hello.recuA) : null;
    const ecart = premier ? premier.envoyeeA - hello.recuA : null;
    bilan.push(
      `E : conteneur arrêté puis relancé ; « hello » ${hello ? `${hello.recuA - relance} ms` : "JAMAIS reçu"} après la relance, ` +
        `amorçage ${ecart === null ? "absent" : `${ecart} ms`} après « hello », ${repris ? `reprise ${reprise - relance} ms` : "AUCUNE reprise"} après la relance ` +
        `(tentative programmée à ${echeance - relance} ms)`,
    );
    if (!repris) throw new Error(`E : interface non rétablie après le redémarrage du conteneur. ${bilan.join(" ; ")}`);
    if (!hello) throw new Error("E : aucune trame « hello » du flux d'événements après la relance du conteneur.");
    if (ecart === null || ecart > 400) throw new Error(`E : amorçage ${ecart} ms après « hello », attendu aussitôt (reconnexion du flux ; la page ne recharge d'elle-même que 800 ms après).`);
    if (reprise >= echeance) throw new Error("E : reprise après l'échéance de la tentative programmée : la reconnexion du flux n'a rien relancé.");
    if (repris.fluxPerdu) throw new Error("E : bannière « Connexion au cockpit perdue » affichée après la reprise.");
    // Rechargement de la page dû à la reconnexion (800 ms), puis plus rien, échéance de la minuterie comprise.
    await attendre(2_000);
    const reste = await amorcagesPendant(page, Math.max(12_000, echeance - Date.now() + 2_000));
    if (reste > 0) throw new Error(`E : ${reste} requête(s) d'amorçage encore envoyée(s) après la reprise.`);
  } finally {
    if (arrete) await pile.demarrer("cockpit").catch(() => {});
  }
}

/**
 * F. Amorçage lent, puis deux changements rapprochés (constat de la vérification de c630349). La réponse du rechargement dû
 * au premier changement est calculée par le serveur puis retenue avant la page, comme un opencode bloqué. Le rafraîchissement
 * dû au second ne doit pas la recevoir : une seule nouvelle requête part à la fin du rechargement en cours, et l'affichage
 * finit sur la valeur du serveur sans jamais montrer la valeur dépassée.
 */
async function amorcageLent(page, api, { changerNiveau, niveaux, bilan }) {
  // Le niveau des nouvelles conversations se lit dans Paramètres › Chat en mode Avancé : « Vide : le niveau X. ».
  await api.put("/api/settings", { ui: { mode: "avance" } });
  await page.evaluer("window.location.hash = '#/parametres/chat'; true");
  await page.attendreQue("document.body.textContent.includes('Vide : le niveau')", { libelle: "onglet Chat des paramètres, mode Avancé" });
  const libelle = () => page.evaluer("(document.body.textContent.match(/Vide : le niveau ([^.]+)\\./) || [])[1] || null");
  const [premier, second] = NIVEAUX.filter((n) => n !== niveaux.courant);
  const retenue = await page.retenirReponses(["*/api/bootstrap*"]);
  try {
    const journal = page.journalReseau().length;
    await changerNiveau(premier);
    if (!(await attendreCondition(() => retenue.retenues() >= 1, 6_000))) throw new Error("F : aucun rechargement de /api/bootstrap après le premier changement.");
    await changerNiveau(second);
    if (!(await attendreCondition(async () => (await libelle()) === LIBELLES[second], 3_000))) throw new Error("F : second changement non affiché (« settings.updated » non reçu ?).");
    // Le rafraîchissement dû au second « ai.changed » est demandé 800 ms après lui, pendant le rechargement retenu.
    await attendre(1_500);
    const pendant = amorcages(page, journal).length;
    const journalRelache = page.journalReseau().length;
    await retenue.relacher();
    const vus = [];
    const limite = Date.now() + 4_000;
    while (Date.now() < limite) {
      vus.push(await libelle());
      await attendre(50);
    }
    const apres = amorcages(page, journalRelache);
    const final = await libelle();
    bilan.push(
      `F : ${pendant} requête(s) d'amorçage pendant l'amorçage lent, ${apres.length} après lui (${apres.map((l) => l.code ?? l.etat).join(", ")}) ; ` +
        `niveau affiché « ${final} », serveur « ${LIBELLES[second]} »`,
    );
    if (final !== LIBELLES[second]) throw new Error(`F : affichage périmé : « ${final} » affiché, « ${LIBELLES[second]} » sur le serveur.`);
    if (vus.includes(LIBELLES[premier])) throw new Error(`F : la réponse dépassée (« ${LIBELLES[premier]} ») a été affichée après le second changement.`);
    if (pendant !== 1) throw new Error(`F : ${pendant} requête(s) d'amorçage pendant l'amorçage lent, 1 attendue (le rafraîchissement attend sa fin).`);
    if (apres.length !== 1 || apres[0].code !== 200) {
      throw new Error(`F : ${apres.length} requête(s) d'amorçage après l'amorçage lent, une seule réussie attendue (rafraîchissement demandé pendant lui).`);
    }
  } finally {
    await retenue.relacher().catch(() => {});
  }
}

/** G. Session perdue (401) pendant un rechargement : écran de connexion, jamais une boucle de tentatives. */
async function sessionPerdue(page, url, { basculerNiveau, bilan }) {
  const journal = page.journalReseau().length;
  // Cookie de session retiré de l'onglet : la requête suivante de la page reçoit 401, comme après une session expirée.
  await page.effacerCookie({ name: "__Host-cockpit_session", url });
  await basculerNiveau();
  // Le premier 401 peut venir de l'amorçage ou d'une autre requête relancée par « ai.changed » : chacun ramène à la connexion.
  const refus = await attendreCondition(() => page.journalReseau().slice(journal).find((l) => l.code === 401), 6_000);
  if (!refus) throw new Error("G : aucune requête refusée en 401 après la perte de session.");
  const connexion = await attendreCondition(async () => {
    const etat = await page.evaluer(ETAT);
    return etat.connexion && !etat.rail ? etat : null;
  }, 5_000);
  if (!connexion) throw new Error(`G : écran de connexion absent après un 401 (${JSON.stringify(await page.evaluer(ETAT))}).`);
  const reste = await amorcagesPendant(page, 12_000);
  bilan.push(`G : 401 (${refus.methode} ${new URL(refus.url).pathname}) puis écran de connexion, ${reste} tentative(s) en 12 s`);
  if (reste > 0) throw new Error(`G : ${reste} requête(s) d'amorçage après le 401 : une session perdue ne doit jamais relancer de tentatives.`);
}
