// Scénarios e2e de l'interface de l'itération 1 (paquet L7b-2) : outils communs, et le scénario qui vérifie leurs préalables.
//
// Le banc lance chaque fichier « .mjs » de e2e/scenarios comme un scénario : ce module en est donc un aussi. Son run(ctx) vérifie ce
// sur quoi reposent les autres scénarios « it1-ui-* » : mode Simple par défaut, page servie dans le schéma du banc (HTTPS épinglé
// par défaut depuis R105b, HTTP explicite avec « --http ») sous la CSP réelle, règles
// d'utilisation acceptées au clic comme le ferait un utilisateur, flux d'événements ouvert, console muette.
//
// Principe : on regarde la PAGE, pilotée par le banc (CDP), et on n'agit que par ce qu'un utilisateur ferait (clic, clavier). Les
// préparations qui ne relèvent pas de l'interface passent par l'API du cockpit, comme dans les scénarios it1-api-* dont on reprend
// les outils (conversations créées par le proxy, tours joués par le faux opencode, mode changé par PUT /api/settings, témoin P6).
//
// Relevés dans la page (instrumenter) : un observateur de mutations, installé par le banc après le chargement (hors CSP, comme
// toute évaluation du protocole CDP), note
//   - chaque faisceau de la bande néon (clé data-neon-cle, classes, couleur calculée du trait, instant de première apparition) ;
//   - chaque animation WAAPI dont la cible est dans la carte (durée, répétitions, propriétés animées) ;
//   - chaque violation de la CSP (événement securitypolicyviolation).
// Rien n'est modifié dans la page : ni fonction remplacée, ni style, ni requête. Une violation survenue avant l'installation serait
// écrite par le navigateur dans la console, que chaque scénario exige muette.
import { attendre, attendreQue, exiger, iaDuBanc, resume } from "./it1-api-commun.mjs";

// Outils des scénarios it1-api-* (L7b-1), repris tels quels par les scénarios it1-ui-*.
export {
  attendre,
  attendreDemandes,
  attendreFinDuTour,
  attendreQue,
  avecTemoinP6,
  changerMode,
  delegation,
  demandeDeDelegation,
  enModeAvance,
  exiger,
  exigerListe,
  iaDuBanc,
  // --- équipes (it4) : début ---
  libererLesDemandes,
  // --- équipes (it4) : fin ---
  nonJoue,
  oc,
  occupees,
  releve,
  resume,
} from "./it1-api-commun.mjs";

/**
 * IA à envoyer (iaDuBanc), attendue au catalogue du cockpit : juste après le démarrage de la pile, le catalogue des IA se charge
 * encore (catalog.ts, premier rafraîchissement) et un scénario lancé seul (mutations) le trouverait vide (essai du 19/09).
 */
export async function attendreIa(ctx, delaiMs = 60_000) {
  return await attendreQue(
    async () => {
      try {
        return iaDuBanc(await ctx.api.get("/api/bootstrap"));
      } catch {
        return false;
      }
    },
    { delaiMs, pasMs: 500, libelle: "IA du banc au catalogue du cockpit" },
  );
}

/** Largeur de travail des scénarios : la carte néon n'est dessinée qu'au-dessus de 900 px (mini-carte en dessous, neon.css). */
export const LARGE = { largeur: 1440, hauteur: 900 };

/** Phrases attendues, écrites ici en clair (c'est la spécification qu'on vérifie, pas ce que le code déclare). */
export const PHRASES = {
  /** §6 l.1064, §5.9 : étiquette de la démonstration. */
  demonstration: "Démonstration enregistrée : aucune IA n'est appelée",
  /** Décision n° 4 du 19/09 (option b de Q5) : avis du mode Simple sur la délégation. */
  avisSimple: "En mode Simple, l'IA ne délègue pas : elle continue seule.",
  /** §6 l.1048, §4.10 : délégation lancée par un raccourci `subtask`, sans demande d'autorisation. */
  sansConfirmation: "lancé sans confirmation",
  arreter: "Arrêter",
  envoyer: "Envoyer",
  autoriser: "Autoriser une fois",
};

// --- Page ------------------------------------------------------------------------------------------------------------------------

/** Expression : bouton VISIBLE dont le texte (espaces réduits) vaut `texte`, dans `portee` (sélecteur CSS, facultatif). */
export function exprBouton(texte, portee = null) {
  const racine = portee === null ? "document" : `document.querySelector(${JSON.stringify(portee)})`;
  return `(() => { const r = ${racine}; if (!r) return null; return [...r.querySelectorAll("button")].find((b) => b.textContent.replace(/\\s+/g, " ").trim() === ${JSON.stringify(texte)} && b.getClientRects().length > 0) ?? null; })()`;
}

/** Attend un bouton visible par son texte, puis clique dessus (événement de clic de l'élément, comme un clic de souris). */
export async function cliquerBouton(page, texte, { portee = null, delaiMs = 15_000 } = {}) {
  await page.attendreQue(exprBouton(texte, portee), { delaiMs, libelle: `bouton « ${texte} »${portee ? ` dans ${portee}` : ""}` });
  await page.evaluer(`${exprBouton(texte, portee)}.click()`);
}

/** Vrai si un bouton visible porte ce texte. */
export async function boutonVisible(page, texte, portee = null) {
  return await page.evaluer(`Boolean(${exprBouton(texte, portee)})`);
}

/** Texte visible d'un élément (innerText, espaces réduits) ; "" s'il n'existe pas. */
export async function texteVisible(page, selecteur = "body") {
  return await page.evaluer(`(document.querySelector(${JSON.stringify(selecteur)})?.innerText ?? "").replace(/\\s+/g, " ").trim()`);
}

/** Attend que le texte visible de `selecteur` contienne `attendu`. */
export async function attendreTexte(page, attendu, { selecteur = "body", delaiMs = 15_000 } = {}) {
  await page.attendreQue(`(document.querySelector(${JSON.stringify(selecteur)})?.innerText ?? "").replace(/\\s+/g, " ").includes(${JSON.stringify(attendu)})`, {
    delaiMs,
    libelle: `texte « ${attendu} » dans ${selecteur}`,
  });
}

/**
 * Prépare l'onglet d'un scénario : réglage de mouvement fixé AVANT toute action (R106-b : « no-preference » par défaut, jamais
 * celui du poste, qui passe en animations réduites avec les sessions RDP ; « reduce » pour un scénario qui teste justement le
 * mouvement réduit), grande fenêtre, cockpit chargé, règles d'utilisation acceptées au clic si la fenêtre bloquante est ouverte
 * (première visite de la pile jetable), notice de la 1.0 fermée par [Compris], relevés installés.
 */
export async function preparerPage(ctx, taille = LARGE, { mouvement = "no-preference" } = {}) {
  const page = ctx.navigateur;
  await page.mouvement(mouvement);
  await page.taille(taille);
  await page.attendreQue("document.querySelector('nav.rail')", { libelle: "barre de navigation du cockpit" });
  if (await page.evaluer("Boolean(document.querySelector('.rules-modal'))")) {
    await page.evaluer("document.querySelector('.rules-modal input[type=checkbox]').click()");
    await cliquerBouton(page, "Commencer", { portee: ".rules-modal" });
    await page.attendreQue("!document.querySelector('.rules-modal')", { libelle: "fenêtre des règles fermée après « Commencer »" });
  }
  if (await boutonVisible(page, "Compris", ".notice-panel")) {
    await cliquerBouton(page, "Compris", { portee: ".notice-panel" });
    await page.attendreQue("!document.querySelector('.notice-panel')", { libelle: "notice de la 1.0 fermée" });
  }
  await instrumenter(page);
  return page;
}

/** Installe les relevés de la page (idempotent) : faisceaux, animations de la carte, violations de la CSP. */
export async function instrumenter(page) {
  return await page.evaluer(`(() => {
    if (window.__e2e) return true;
    const e2e = { violations: [], faisceaux: [], animations: [] };
    window.__e2e = e2e;
    const vues = new WeakSet();
    document.addEventListener("securitypolicyviolation", (e) => {
      e2e.violations.push({ directive: e.violatedDirective, bloque: String(e.blockedURI).slice(0, 120), t: performance.now() });
    });
    const relever = () => {
      const t = performance.now();
      for (const g of document.querySelectorAll(".neon-band .neon-map .neon-faisceau")) {
        const cle = g.dataset.neonCle ?? "";
        const etat = g.dataset.neonEtat ?? "";
        if (e2e.faisceaux.some((f) => f.cle === cle && f.etat === etat)) continue;
        const trait = g.querySelector(".neon-trait");
        e2e.faisceaux.push({ cle, etat, classes: g.getAttribute("class") ?? "", couleur: trait ? getComputedStyle(trait).stroke : "", t });
      }
      for (const a of document.getAnimations()) {
        if (vues.has(a)) continue;
        const cible = a.effect && a.effect.target;
        if (!cible || !cible.closest || !cible.closest(".neon-map")) continue;
        vues.add(a);
        const temps = a.effect.getTiming();
        const proprietes = [...new Set(a.effect.getKeyframes().flatMap((k) => Object.keys(k)))].filter((p) => !["offset", "computedOffset", "easing", "composite"].includes(p));
        e2e.animations.push({ cle: cible.dataset?.neonCle ?? cible.getAttribute("class") ?? "", duree: temps.duration, iterations: temps.iterations, proprietes, t });
      }
    };
    new MutationObserver(relever).observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ["class", "data-neon-etat"] });
    relever();
    return true;
  })()`);
}

/** Relevés de la page depuis instrumenter. */
export async function releves(page) {
  return await page.evaluer("JSON.parse(JSON.stringify(window.__e2e ?? { violations: [], faisceaux: [], animations: [] }))");
}

/** Aucune violation de la CSP relevée dans la page. */
export async function exigerAucuneViolationCsp(page) {
  const { violations } = await releves(page);
  exiger(violations.length === 0, `violation(s) de la CSP : ${resume(violations)}`);
}

/**
 * Ouvre une conversation dans la page, par l'adresse (#/chat/<id>) comme un lien : le fragment change, la page n'est pas rechargée
 * (les relevés restent en place). Attend l'en-tête de la conversation.
 */
export async function ouvrirConversation(ctx, rootId) {
  const page = ctx.navigateur;
  await page.evaluer(`location.hash = ${JSON.stringify(`#/chat/${rootId}`)}`);
  await page.attendreQue("document.querySelector('.chat-thread') && document.querySelector('.chat-header h1') && document.querySelector('.chat-header h1').textContent !== 'Nouvelle conversation'", {
    libelle: `conversation ${rootId} ouverte`,
  });
}

/**
 * Les six captures (1440, 1024 et 400, en clair et en sombre) d'une conversation ouverte. Le panneau « Contexte » devient sous
 * 1280 px une feuille posée sur la conversation (chat.css), qui cachait la bande, « Qui travaille ? » et la saisie (constat du 19/09,
 * mesures/L7b-2.md) : depuis la correction de la répétition générale, il s'y ferme de lui-même, et n'est jamais rouvert d'office au
 * large. Le banc attend l'état voulu (fermé sous 1280 px, ouvert au-dessus) ; seulement s'il ne vient pas, il clique le bouton du
 * panneau, comme le ferait l'utilisateur (au large, après un passage sous 1280 px). La fenêtre de travail (1440) est rétablie après.
 */
export async function capturerConversation(ctx, nom) {
  const page = ctx.navigateur;
  const avant = async ({ taille }) => {
    const voulu = taille.largeur > 1280;
    const etat = `document.querySelector('.chat')?.classList.contains('aside-open') === ${voulu}`;
    const libelle = `panneau « Contexte » ${voulu ? "ouvert" : "fermé"}`;
    try {
      await page.attendreQue(etat, { delaiMs: 1_500, libelle });
      return;
    } catch {
      // Au large après un passage sous 1280 px (jamais rouvert d'office), ou préférence contraire : le bouton du panneau.
    }
    const bouton = voulu ? "Afficher le contexte" : "Masquer le contexte";
    await page.evaluer(`document.querySelector(${JSON.stringify(`.chat-header button[aria-label="${bouton}"]`)})?.click()`);
    await page.attendreQue(etat, { libelle });
  };
  // Transitions de la carte finies (≈ 900 ms, un signe apparaît depuis l'opacité 0) avant la première capture.
  await attendre(1_000);
  const faites = await ctx.screenshot(nom, { avant });
  exiger(faites.length === 6, `6 captures attendues (${nom}), ${faites.length} faites.`);
  await page.taille(LARGE);
  return faites;
}

/** Attend que la page affiche le mode demandé (lien « Studio » de la barre, réservé au mode Avancé), changé par le flux. */
export async function attendreModeAffiche(page, mode, delaiMs = 10_000) {
  const studio = "[...document.querySelectorAll('nav.rail a.nav-item')].some((a) => a.textContent.includes('Studio'))";
  await page.attendreQue(mode === "avance" ? studio : `!${studio}`, { delaiMs, libelle: `page en mode ${mode === "avance" ? "Avancé" : "Simple"}` });
}

/** Attend que le journal réseau de la page reste sans nouvelle requête pendant `calmeMs` ; rend sa longueur. */
export async function attendreReseauCalme(page, { calmeMs = 1_500, delaiMs = 20_000 } = {}) {
  const limite = Date.now() + delaiMs;
  let longueur = page.journalReseau().length;
  let depuis = Date.now();
  while (Date.now() < limite) {
    await attendre(100);
    const n = page.journalReseau().length;
    const enCours = page.journalReseau().filter((l) => l.etat === "envoyée" && !String(l.url).endsWith("/api/events")).length;
    if (n !== longueur || enCours > 0) {
      longueur = n;
      depuis = Date.now();
    } else if (Date.now() - depuis >= calmeMs) return n;
  }
  throw new Error(`le réseau de la page ne se calme pas en ${Math.round(delaiMs / 1000)} s.`);
}

// --- Carte néon ------------------------------------------------------------------------------------------------------------------

/** Teinte (0-360) et saturation (0-1) d'une couleur « rgb(r, g, b) » calculée par le navigateur ; null si illisible. */
export function teinte(couleur) {
  const m = /rgba?\((\d+),\s*(\d+),\s*(\d+)/.exec(String(couleur));
  if (!m) return null;
  const [r, g, b] = [m[1], m[2], m[3]].map((v) => Number(v) / 255);
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const d = max - min;
  const l = (max + min) / 2;
  const saturation = d === 0 ? 0 : d / (1 - Math.abs(2 * l - 1));
  if (d === 0) return { teinte: null, saturation };
  let h;
  if (max === r) h = ((g - b) / d) % 6;
  else if (max === g) h = (b - r) / d + 2;
  else h = (r - g) / d + 4;
  h *= 60;
  if (h < 0) h += 360;
  return { teinte: Math.round(h), saturation };
}

/** Rose de la consigne (§5.7.1 : #FF3DA6 en néon sombre, #C2187A en néon clair) : teinte 300 à 345, couleur franche. */
export function estRose(couleur) {
  const t = teinte(couleur);
  return t !== null && t.teinte !== null && t.teinte >= 300 && t.teinte <= 345 && t.saturation >= 0.4;
}

/** Bleu du résultat (§5.7.1 : #3DA9FF en néon sombre, #1560BD en néon clair) : teinte 195 à 235, couleur franche. */
export function estBleu(couleur) {
  const t = teinte(couleur);
  return t !== null && t.teinte !== null && t.teinte >= 195 && t.teinte <= 235 && t.saturation >= 0.4;
}

/** Ambre de l'attente de votre accord (§5.7.1 : #FFB02E en néon sombre, #9A6400 en néon clair) : teinte 25 à 55, couleur franche. */
export function estAmbre(couleur) {
  const t = teinte(couleur);
  return t !== null && t.teinte !== null && t.teinte >= 25 && t.teinte <= 55 && t.saturation >= 0.4;
}

/**
 * Ce que la page montre pendant une demande d'autorisation en mode Avancé, relevé sans aucun clic (§5.1, §5.7.1, §5.7.3 ; clôture de
 * l'itération 1 et sa vérification) :
 *   - carte des agents dépliée ou non ; signe de l'attente de votre accord et faisceau de préparation de la conversation `rootId` :
 *     présents, dans la fenêtre et non recouverts (elementFromPoint à leur centre donne un point de la carte : ni hors d'une zone qui
 *     défile, ni sous la carte de la demande), forme (hexagone et traits : hachures et cadenas ; tirets du pointillé), couleur, et
 *     animation en boucle éventuelle ;
 *   - « Qui travaille ? » déplié ou non, et VU, pas seulement rendu (vérification de la clôture : le relevé par getClientRects disait
 *     « deux lignes » quand aucune n'était visible) : son titre, chacune de ses lignes (nom de l'acteur) et [Répondre], par
 *     elementFromPoint à leur centre ; `lignes` : les noms vus, `lignesRendues` : les noms rendus.
 * `defiler` : quand la hauteur de la fenêtre manque, la région d'activité se borne et défile, et la bande des agents, bornée dans la
 * région, défile elle aussi (activity.css). Le titre de « Qui travaille ? » est toujours relevé SANS défiler ; les signes de la carte
 * sont relevés après avoir amené l'attente de votre accord à la vue, chaque ligne et [Répondre] après les y avoir amenés, en faisant
 * défiler ces seules zones (bande, puis région, comme la molette de l'utilisateur au-dessus d'elles), remises en place ensuite.
 * `defilement` (carte) et `defilementQui` (lignes, [Répondre]) disent de combien (0 : vu sans défiler), `mainDefile` si la zone
 * principale a bougé.
 */
export async function signesPendantLaDemande(page, rootId, { defiler = false } = {}) {
  return await page.evaluer(`(() => {
    const region = document.querySelector(".activity-region");
    const vh = window.innerHeight, vw = window.innerWidth;
    // Zones qui défilent entre un élément et la région comprise (bande, région), de la plus proche à la plus lointaine.
    const defilantes = (el) => {
      const zones = [];
      for (let a = el ? el.parentElement : null; a && region && region.contains(a); a = a.parentElement) {
        const o = getComputedStyle(a).overflowY;
        if ((o === "auto" || o === "scroll") && a.scrollHeight > a.clientHeight) zones.push(a);
      }
      return zones;
    };
    const notees = new Map();
    const amener = (el) => {
      if (!${defiler} || !el) return 0;
      let total = 0;
      for (const zone of defilantes(el)) {
        if (!notees.has(zone)) notees.set(zone, zone.scrollTop);
        const rz = zone.getBoundingClientRect(), re = el.getBoundingClientRect();
        if (re.top >= rz.top && re.bottom <= rz.bottom) continue;
        const avant = zone.scrollTop;
        zone.scrollTop += re.top + re.height / 2 - (rz.top + rz.height / 2);
        total += Math.abs(zone.scrollTop - avant);
      }
      return Math.round(total);
    };
    const remettre = () => {
      for (const [zone, haut] of notees) zone.scrollTop = haut;
      notees.clear();
    };
    // Vu : le centre de l'élément est dans la fenêtre et elementFromPoint y donne l'élément (ou, pour un signe du SVG, la carte).
    const vu = (el, dans = null) => {
      if (!el) return "absent";
      const r = el.getBoundingClientRect();
      if (r.width === 0 && r.height === 0) return "sans-taille";
      const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
      if (cy < 0 || cy > vh || cx < 0 || cx > vw) return "hors-fenetre(y=" + Math.round(cy) + ")";
      const dessus = document.elementFromPoint(cx, cy);
      if (dessus && (dessus === el || el.contains(dessus) || (dans !== null && dessus.closest(dans)))) return "visible";
      const classe = dessus ? (typeof dessus.className === "string" ? dessus.className : dessus.getAttribute("class")) : "?";
      return "recouvert(par " + String(classe ?? "?").slice(0, 40) + ", y=" + Math.round(cy) + ")";
    };

    // Carte des agents.
    const carte = document.querySelector(".neon-band .neon-map");
    const attente = carte ? carte.querySelector(".neon-attente") : null;
    const prep = carte ? ([...carte.querySelectorAll(".neon-faisceau")].find((g) => (g.dataset.neonCle || "").startsWith(${JSON.stringify(`f:preparation:${rootId}:`)})) ?? null) : null;
    const trait = prep ? prep.querySelector(".neon-trait") : null;
    const defilement = amener(attente);
    const releve = {
      carte: document.querySelector(".neon-band .neon-commands button[aria-expanded]")?.getAttribute("aria-expanded") ?? null,
      attente: vu(attente, ".neon-map-wrap"),
      formeAttente: attente ? { hexagones: attente.querySelectorAll("polygon").length, traits: attente.querySelectorAll("path").length } : null,
      couleurAttente: attente ? getComputedStyle(attente).color : "",
      preparation: vu(prep, ".neon-map-wrap"),
      tiretsPreparation: trait ? getComputedStyle(trait).strokeDasharray : "",
      couleurPreparation: trait ? getComputedStyle(trait).stroke : "",
      animationEnBoucle: prep ? prep.getAnimations({ subtree: true }).some((a) => a.effect && a.effect.getTiming().iterations === Infinity) : null,
      defilement,
    };
    remettre();

    // « Qui travaille ? » : titre sans défiler ; chaque ligne et [Répondre], amenés à la vue un par un si \`defiler\`.
    const nom = (ligne) => (ligne.querySelector(".actor-name")?.textContent ?? "").trim();
    const rendues = [...document.querySelectorAll(".who-body .actor-row")].filter((l) => l.getClientRects().length > 0);
    const repondre = region ? ([...region.querySelectorAll("button")].find((b) => b.textContent.replace(/\\s+/g, " ").trim() === ${JSON.stringify("Répondre")} && b.getClientRects().length > 0) ?? null) : null;
    releve.quiTravaille = document.querySelector(".who-toggle")?.getAttribute("aria-expanded") ?? null;
    releve.titre = vu(document.querySelector(".who-banner .who-title"));
    let defilementQui = 0;
    const vues = [];
    for (const ligne of rendues) {
      const nomLigne = ligne.querySelector(".actor-name");
      defilementQui = Math.max(defilementQui, amener(nomLigne));
      if (vu(nomLigne) === "visible") vues.push(nom(ligne));
      remettre();
    }
    releve.lignes = vues;
    releve.lignesRendues = rendues.map(nom);
    defilementQui = Math.max(defilementQui, amener(repondre));
    releve.repondre = vu(repondre);
    remettre();
    releve.defilementQui = defilementQui;
    releve.mainDefile = document.querySelector(".main")?.scrollTop ?? null;
    return releve;
  })()`);
}

/**
 * Exige, pendant une demande en mode Avancé et sans clic, une carte dessinée (900 px de large et plus) : carte dépliée, attente de
 * votre accord visible (hexagone hachuré, cadenas, ambre), et, si `preparation` (demande de délégation), préparation visible
 * (pointillé rose, fixe) ; et, si `quiTravaille` (au-dessus de 400 px, où le bandeau tient sur une ligne, §5.6), « Qui travaille ? »
 * déplié et VU (vérification de la clôture de l'itération 1) : son titre sans défiler, chacune de ses lignes (une par acteur, celle de
 * `enfant` comprise quand il y en a un) et [Répondre].
 */
export function exigerSignesDeLaDemande(s, ou, { quiTravaille = true, enfant = "general", preparation = true } = {}) {
  const dit = `${ou} (${resume(s, 900)})`;
  exiger(s.carte === "true", `${dit} : carte des agents repliée pendant la demande (§5.1 : dépliée par défaut en Avancé).`);
  exiger(s.mainDefile === 0, `${dit} : zone principale défilée.`);
  if (quiTravaille) {
    exiger(s.quiTravaille === "true", `${dit} : « Qui travaille ? » replié pendant la demande (§5.1 : une ligne par acteur).`);
    exiger(s.titre === "visible", `${dit} : titre de « Qui travaille ? » ${s.titre} (vu par elementFromPoint, sans défiler).`);
    const attendues = enfant === null ? 1 : 2;
    exiger(
      s.lignesRendues.length >= attendues && (enfant === null || s.lignesRendues.includes(enfant)),
      `${dit} : lignes d'acteur rendues ${resume(s.lignesRendues)}, ${enfant === null ? "la conversation" : `la conversation et ${enfant}`} attendues.`,
    );
    exiger(
      s.lignes.length === s.lignesRendues.length,
      `${dit} : lignes vues ${resume(s.lignes)} sur ${resume(s.lignesRendues)} rendues (elementFromPoint ; §5.1 : une ligne par acteur, la liste reste la vérité).`,
    );
    exiger(s.repondre === "visible", `${dit} : [Répondre] de « Qui travaille ? » ${s.repondre}.`);
  }
  exiger(s.attente === "visible", `${dit} : attente de votre accord ${s.attente} (§5.7.1).`);
  exiger(s.formeAttente !== null && s.formeAttente.hexagones >= 1 && s.formeAttente.traits >= 2, `${dit} : attente sans hexagone hachuré ni cadenas.`);
  exiger(estAmbre(s.couleurAttente), `${dit} : attente de couleur ${s.couleurAttente} au lieu de l'ambre.`);
  if (!preparation) return;
  exiger(s.preparation === "visible", `${dit} : préparation ${s.preparation} (§5.7.3 : partie task en attente, pointillé fixe).`);
  exiger(s.tiretsPreparation !== "" && s.tiretsPreparation !== "none", `${dit} : préparation en trait « ${s.tiretsPreparation} » au lieu du pointillé.`);
  exiger(estRose(s.couleurPreparation), `${dit} : préparation de couleur ${s.couleurPreparation} au lieu du rose.`);
  exiger(s.animationEnBoucle === false, `${dit} : préparation animée en boucle (pointillé fixe attendu, JP-13).`);
}

/** Gris d'un faisceau figé par un arrêt : couleur sans teinte franche. */
export function estGris(couleur) {
  const t = teinte(couleur);
  return t !== null && t.saturation < 0.25;
}

/** Première apparition, dans la page, du faisceau de clé `f:<id>` (relevés), ou null. */
export function apparition(relevesPage, idFaisceau) {
  return relevesPage.faisceaux.find((f) => f.cle === `f:${idFaisceau}`) ?? null;
}

/** Faits de la conversation (GET …/facts?since=0), dans l'ordre d'écriture. */
export async function faits(ctx, rootId) {
  const reponse = await ctx.api.get(`/api/conversations/${encodeURIComponent(rootId)}/facts?since=0`);
  exiger(Array.isArray(reponse?.facts), `faits illisibles : ${resume(reponse)}`);
  return [...reponse.facts].sort((a, b) => (a.id ?? 0) - (b.id ?? 0));
}

/** Activité de la conversation (GET …/activity) : délégations, attentes d'accord. */
export async function activite(ctx, rootId) {
  return await ctx.api.get(`/api/conversations/${encodeURIComponent(rootId)}/activity`);
}

/**
 * Faisceaux qu'ouvrent les faits, dans leur ordre (grammaire de neon-scene.ts, §5.7.1) : préparation et consigne d'un appel `task`
 * de la session qui délègue, résultat rendu par l'enfant. `id` est celui du faisceau (data-neon-cle sans « f: »).
 */
export function faisceauxDesFaits(liste) {
  const ouverts = [];
  for (const fait of liste) {
    const callId = fait.data?.callId;
    if (typeof callId !== "string") continue;
    if (fait.kind === "consigne" && fait.data.etat === "prepare") ouverts.push({ id: `preparation:${fait.sessionId}:${callId}`, genre: "preparation", fait: fait.id });
    else if (fait.kind === "consigne" && fait.data.etat === "envoyee") ouverts.push({ id: `consigne:${fait.sessionId}:${callId}`, genre: "consigne", fait: fait.id });
    else if (fait.kind === "resultat" && typeof fait.data.enfant === "string" && fait.data.etat !== "interrompu") {
      ouverts.push({ id: `resultat:${fait.data.enfant}:${callId}`, genre: "resultat", fait: fait.id });
    }
  }
  return ouverts;
}

// --- Chat ------------------------------------------------------------------------------------------------------------------------

/** Ligne de « Qui travaille ? » dont le nom vaut `nom` : état affiché, ou null si la ligne n'existe pas. */
export async function etatActeur(page, nom) {
  return await page.evaluer(`(() => {
    const ligne = [...document.querySelectorAll(".actor-row")].find((l) => l.querySelector(".actor-name")?.textContent.trim() === ${JSON.stringify(nom)});
    return ligne ? (ligne.querySelector(".actor-state")?.textContent ?? "").trim() : null;
  })()`);
}

/** Attend qu'une ligne de « Qui travaille ? » (nom) affiche un état qui commence par `etat`. */
export async function attendreEtatActeur(page, nom, etat, delaiMs = 15_000) {
  await page.attendreQue(
    `(() => { const l = [...document.querySelectorAll(".actor-row")].find((x) => x.querySelector(".actor-name")?.textContent.trim() === ${JSON.stringify(nom)}); return l && (l.querySelector(".actor-state")?.textContent ?? "").trim().startsWith(${JSON.stringify(etat)}); })()`,
    { delaiMs, libelle: `« Qui travaille ? » : ${nom} « ${etat} »` },
  );
}

/** « Qui travaille ? » replié par défaut en fin de demande : le déplie (clic sur son bouton), s'il ne l'est pas. */
export async function deplierQuiTravaille(page) {
  await page.attendreQue("document.querySelector('.who-toggle')", { libelle: "bandeau « Qui travaille ? »" });
  if ((await page.evaluer("document.querySelector('.who-toggle').getAttribute('aria-expanded')")) !== "true") {
    await page.evaluer("document.querySelector('.who-toggle').click()");
  }
  await page.attendreQue("document.querySelector('.who-toggle').getAttribute('aria-expanded') === 'true'", { libelle: "« Qui travaille ? » déplié" });
}

// --- Scénario : préalables des scénarios it1-ui ----------------------------------------------------------------------------------

export async function run(ctx) {
  const page = ctx.navigateur;
  const bootstrap = await ctx.api.get("/api/bootstrap");
  exiger(bootstrap?.settings?.ui?.mode === "simple", `mode ${resume(bootstrap?.settings?.ui?.mode)} au lieu de « simple ».`);

  // Boucle locale (contexte sûr pour le navigateur), sous la CSP réelle du cockpit : adresse dans le schéma du banc
  // (HTTPS épinglé par défaut depuis R105b, HTTP explicite avec « --http »), CSP lue par le transport épinglé du banc,
  // protocole de la page vérifié plus bas.
  exiger(ctx.url.startsWith(`${ctx.schema}://127.0.0.1:`), `adresse du cockpit inattendue : ${ctx.url}`);
  const reponse = await ctx.api.brut("GET", "/");
  const csp = reponse.entetes.get("content-security-policy") ?? "";
  exiger(reponse.code === 200 && /default-src 'self'/.test(csp) && /script-src 'self'(;|$)/.test(csp) && /connect-src 'self'/.test(csp), `CSP de la page inattendue : « ${csp} »`);

  // Règles acceptées au clic (première visite de la pile), mode Simple affiché, flux d'événements ouvert.
  await preparerPage(ctx);
  // Le schéma servi est celui du banc : « https: » par défaut (épinglé, R105b), « http: » avec « --http ».
  exiger(await page.evaluer("window.isSecureContext === true"), "page hors contexte sûr.");
  const protocole = await page.evaluer("location.protocol");
  exiger(protocole === `${ctx.schema}:`, `page servie en « ${protocole} », attendu « ${ctx.schema}: ».`);
  const accepte = (await ctx.api.get("/api/settings"))?.ui?.rulesAcceptedVersion;
  exiger(typeof accepte === "number" && accepte >= (bootstrap.rulesVersion ?? 0), `règles non enregistrées après « Commencer » (${resume(accepte)}).`);
  await attendreModeAffiche(page, "simple");
  await page.attendreQue("document.querySelector('.rail-footer .dot.good')", { libelle: "pastille du flux au vert (opencode joint, flux ouvert)" });
  const flux = page.journalReseau().filter((l) => String(l.url).startsWith(`${ctx.url}/api/events`));
  exiger(flux.length >= 1 && flux.every((l) => l.etat !== "échouée"), `flux d'événements : ${resume(flux)}`);

  await exigerAucuneViolationCsp(page);
  ctx.expectNoConsoleErrors();
}
