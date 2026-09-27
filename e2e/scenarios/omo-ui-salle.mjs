// Scénario e2e de l'INTERFACE de la Salle OMO (paquet L26c, itération 2 ter, vague 5), joué sur la pile de la salle :
//
//   scripts/run-e2e.sh --faux --salle --project-prefix sal11-e2e --image-tag sal11
//
// La salle y est FACTICE (e2e/fake-opencode-server.ts « --instance omo » : faux opencode et superviseur factice qui parle au
// cockpit par les fichiers du contrat), le catalogue du compte GitHub Copilot aussi (« --copilot »), et le cockpit est bâti avec
// SALLE_OUVERTE basculée dans la COPIE du banc seulement. Aucune extension, aucune IA, aucun appel facturé : c'est l'interface du
// cockpit qu'on éprouve, pas l'extension (le banc complet de L21b le fait avec la vraie image).
//
// UN SEUL FICHIER pour toute la famille, découpé en ÉTAPES : croisements-it1-v5 veut chaque scénario cité par e2e/README.md et
// n'admet qu'un scénario hors du relevé des noms « itN-… » et « NNN-… ». Chaque étape pose ses préalables (mode, salle prête,
// salle ouverte sur un projet) ; une étape en échec est notée et capturée, la salle est remise en état, et les suivantes sont
// jouées quand même : le scénario échoue à la fin en les nommant toutes. Rejouer des étapes seules (machine chargée) :
//
//   E2E_OMO_ETAPES=activation,detection scripts/run-e2e.sh --faux --salle --project-prefix sal11-e2e --image-tag sal11
//
// Étapes (fiche L26c ; spécification §7.6 l.1159, §5.6 l.928, P7 l.42, §5.5 l.917-924, §4.14.6 l.854-868) :
//   prealables     Bootstrap de la salle, SALLE_OUVERTE toujours fausse dans le dépôt, catalogue du compte (faux) vérifié, salle
//                  factice prête (jamais l'image de l'extension), projets préparés ;
//   simple         T-L26-e en mode Simple : entrée absente, page inaccessible, aucune requête /api/omo/* de la page ; AUCUN
//                  événement de la salle reçu par le flux en Simple, alors que la même relance en Avancé en fait arriver ;
//   entree         mode Avancé : entrée « Salle OMO » atteinte et ouverte au CLAVIER SEUL, « Salle prête », projets préparés ;
//   projet-piege   projet piégé : pré-contrôle refusé, phrase et liste MASQUÉE (le nom du fichier de clés n'est jamais montré),
//                  ouverture impossible ; piège retiré : projet contrôlé ;
//   activation     T-L26-c au clavier seul : champ vide → erreur annoncée près du champ, rien n'est envoyé ; 409 du serveur
//                  affiché avec sa phrase, rien n'est envoyé ; confirmation → bandeau ; [Arrêter] → POST
//                  /api/omo/rooms/:rootId/stop, « Salle en relance » puis « Salle prête » ; T-L26-f (variante Prometheus) ;
//   fin-de-demande [Journal] au clavier (le focus va au Journal) ; fin de demande → « Salle en relance » puis « Salle prête » ;
//   signales       un `*.ps1` écrit pendant une demande : `omo.signales` part en fin de demande (contre-épreuve par le flux), et la
//                  page doit lister le fichier avec « à relire avant de lancer sur votre poste », atteint au clavier (§4.14.5) ;
//   suspendue      deux racines créées hors du cockpit → « Salle suspendue » ; activation refusée avec sa phrase (écran, 409) ;
//                  réouverture confirmée d'une salle : suspension levée, battement repris ;
//   detection      `.git` créé pendant une demande → arrêt, quarantaine sur le disque, liste des fichiers signalés et Journal,
//                  atteignables au clavier (1440 et 400 px) ;
//   git-attente    décision A16 point (4), troisième test de croisement de l'arbitrage L21 n° 3 en version e2e : un `.git` non
//                  protégé fait ATTENDRE la salle, et la raison est à l'écran — page de la salle et Diagnostic —, au clavier, pas
//                  seulement dans le journal du conteneur ; 409 « git-inscriptible » ;
//   focus-ecran    §5.5 « focus jamais volé » : écran d'activation ouvert, focus sur [Lancer…], la page relit l'état de la salle
//                  sur un événement du flux ; le focus doit rester où l'utilisateur l'a mis ;
//   revoir-simple  Q6 (§5.9, §6 l.1065 ; D-3d-09, D-3d-14 ; répétition générale « 3s ») : demande brève lancée par l'API, en Simple
//                  « Revoir » refusé pendant la demande, /facts 403, puis permis quand elle est finie, sans requête aux instances,
//                  et la conversation listée au zoom 1 avec [Revoir] ;
//   sans-salle    T-L26-e : COCKPIT_OMO coupé, puis image absente (cockpit redémarré) → entrée absente ; puis rétabli.
// Chaque étape part d'une salle prête ET écoutée : le flux d'événements du cockpit rebranché sur son dernier lancement (relevé de
// la salle factice) ; le délai de ce rebranchement est dit au bilan.
// Sur tout le scénario : captures 1440, 1024 et 400 dans les deux thèmes (T-L26-d), zéro erreur de console (une seule tolérance,
// bornée : le 409 d'activation provoqué exprès), aucune violation de CSP, P6/P11 (l'instance principale ne reçoit rien de la
// salle, ni configuration, ni libération) et P4 dans la salle (seulement « once » ou « reject »).
//
// Aucun `fetch` ici : le cockpit n'est joint que par `ctx.api` (transport épinglé) et par la page ; la salle factice par
// `ctx.salle.pilote`, le disque du dossier de travail du banc par `ctx.salle.workspace` (hors du dépôt).
import fs from "node:fs";
import path from "node:path";
import { CLES } from "../../app/server/shared/omo-audit-4.19.4.ts";
import { phraseDetection, TEXTES } from "../../app/server/shared/omo-room-texts.ts";
import { attendre, attendreQue, avecTemoinP6, changerMode, exiger, releve, resume } from "./it1-api-commun.mjs";
import { attendreModeAffiche, exigerAucuneViolationCsp, LARGE, preparerPage } from "./it1-ui-commun.mjs";

const T = TEXTES.avance;

/** Racine du dépôt : e2e/scenarios → e2e → dépôt (lecture seule de wiring-11.ts, jamais d'écriture). */
const RACINE_DEPOT = path.resolve(import.meta.dirname, "..", "..");

/** Libellés de l'interface, écrits en clair : c'est la spécification (§4.14.6, §4.12, textes de T3a) qu'on vérifie. */
const L = {
  entree: "Salle OMO",
  diagnostic: "Diagnostic",
  etats: {
    prete: "Salle prête",
    relance: "Salle en relance",
    demande: "Demande en cours",
    suspendue: "Salle suspendue",
    arretee: "Salle arrêtée",
  },
  titreActivation: "Lancer cette demande comme Oh My OpenAgent ?",
  lancer: "Lancer comme Oh My OpenAgent",
  annuler: "Annuler",
  sansDemande: "Ce que l'extension fait sans demande",
  champ: "Arrêt automatique à :",
  controler: "Contrôler ce projet",
  ouvrir: "Ouvrir la salle ici",
  envoyer: "Envoyer",
  arreter: "Arrêter",
  journal: "Journal",
  actualiser: "Actualiser",
  bandeau: "Salle OMO · extension active · actions non contrôlées avant exécution",
  demandeArretee: "Demande arrêtée",
  carteDiagnostic: "Salle Oh My OpenAgent",
  attente: "Pourquoi la salle attend",
  projetControle: "Projet contrôlé",
};

/** Montant saisi au clavier dans le champ « Arrêt automatique à : » (virgule décimale, comme un utilisateur français). */
const MONTANT = "0,50";

/** Seule entrée de console tolérée : le 409 d'activation provoqué exprès (étape « activation »), sur la route d'autonomie. */
const ROUTE_AUTONOMIE = /\/api\/conversations\/[^/]+\/autonomie$/;

/** Tour lent de la salle factice : la demande reste active le temps de voir le bandeau et de l'arrêter. */
const TOUR_LONG = {
  text: "Je parcours le projet.",
  stepMs: 4_000,
  tools: [{ tool: "read", callID: "call-e2e-salle-lecture", input: { filePath: "/workspace/projet-a/README.md" }, output: "# Projet A" }],
  followUp: { text: "Parcours terminé." },
  cost: 0.001,
  tokens: { input: 12, output: 4 },
};

/** Tour bref : réponse de texte seule, puis repos (fin de demande 15 s plus tard, D-2b-29). */
const TOUR_BREF = { text: "Réponse de la salle factice (banc e2e).", cost: 0.001, tokens: { input: 12, output: 4 } };

// --- Relevés dans la page ------------------------------------------------------------------------------------------------------

/**
 * Enregistreur des états affichés de la salle (« .omo-etat-libelle ») : un observateur de mutations, installé par le banc (hors CSP,
 * comme toute évaluation CDP), note chaque libellé différent du précédent. Un état bref (« Salle en relance ») est ainsi vu même
 * entre deux relevés du banc. Rien n'est modifié dans la page.
 */
const ENREGISTREUR = `(() => {
  if (window.__salle) return true;
  const s = { etats: [] };
  window.__salle = s;
  const relever = () => {
    const el = document.querySelector(".omo-etat-libelle");
    const texte = el ? el.textContent.replace(/\\s+/g, " ").trim() : null;
    const dernier = s.etats.length > 0 ? s.etats[s.etats.length - 1].texte : undefined;
    if (texte !== dernier) s.etats.push({ texte, t: Math.round(performance.now()) });
  };
  new MutationObserver(relever).observe(document.body, { subtree: true, childList: true, characterData: true });
  relever();
  return true;
})()`;

async function etatsVus(page) {
  return (await page.evaluer("JSON.parse(JSON.stringify((window.__salle && window.__salle.etats) || []))")).map((e) => e.texte);
}

/** Attend que les libellés `suite` aient été affichés dans cet ordre depuis l'indice `depuis` de l'enregistreur ; rend les états vus. */
async function attendreSuite(page, depuis, suite, delaiMs = 90_000) {
  return await attendreQue(
    async () => {
      const vus = (await etatsVus(page)).slice(depuis);
      let i = 0;
      for (const texte of vus) if (i < suite.length && texte === suite[i]) i++;
      return i === suite.length ? vus : false;
    },
    { delaiMs, pasMs: 300, libelle: `états affichés « ${suite.join(" » puis « ")} »` },
  );
}

/** Élément qui a le focus, décrit pour le parcours au clavier. */
const FOCUS = `(() => {
  const e = document.activeElement;
  if (!e || e === document.body) return { tag: "body", texte: "", label: "", dans: [], projet: null };
  const lab = e.id ? document.querySelector('label[for="' + CSS.escape(e.id) + '"]') : null;
  return {
    tag: e.tagName.toLowerCase(),
    texte: (e.textContent || "").replace(/\\s+/g, " ").trim().slice(0, 100),
    label: e.getAttribute("aria-label") || (lab ? lab.textContent.trim() : ""),
    dans: ["nav.rail", ".modal", ".omo-banner", ".omo-journal", ".omo-projets", ".omo-page"].filter((sel) => e.closest(sel)),
    projet: e.closest(".omo-projet") ? e.closest(".omo-projet").querySelector(".omo-projet-chemin").textContent.trim() : null,
  };
})()`;

const focus = async (page) => await page.evaluer(FOCUS);

/** Tabule depuis le focus courant jusqu'à l'élément que `test` reconnaît ; rend le nombre de tabulations. Aucune souris. */
async function tabuler(page, test, libelle, max = 150) {
  if (test(await focus(page))) return 0;
  for (let n = 1; n <= max; n++) {
    await page.touche("Tab");
    if (test(await focus(page))) return n;
  }
  throw new Error(`clavier : ${libelle} non atteint en ${max} tabulations (focus sur ${resume(await focus(page))}).`);
}

const bouton = (texte, dans = null) => (f) => f.tag === "button" && f.texte === texte && (dans === null || f.dans.includes(dans));

/** Expression : premier élément de la page qui correspond à `selecteur`. */
const PREMIER = (selecteur) => `document.querySelector(${JSON.stringify(selecteur)})`;

/** Vrai si l'élément rendu par l'expression `element` est dans la fenêtre et visible (elementFromPoint), pas seulement rendu. */
const VU = (element) => `(() => {
  const el = ${element};
  if (!el) return false;
  const r = el.getBoundingClientRect();
  if (r.width === 0 || r.height === 0) return false;
  const x = r.left + Math.min(r.width / 2, 24), y = r.top + Math.min(r.height / 2, 12);
  if (x < 0 || y < 0 || x >= innerWidth || y >= innerHeight) return false;
  const dessus = document.elementFromPoint(x, y);
  return Boolean(dessus && (dessus === el || el.contains(dessus)));
})()`;

/**
 * Atteint au clavier : depuis le haut de la page (défilement remis à zéro), tabule en relevant après chaque touche si l'élément est
 * VU ; rend le nombre de tabulations (0 : visible sans rien faire). Un texte lisible sans survol ni repli, que le parcours au
 * clavier amène à l'écran, est atteignable au clavier (§5.5).
 */
async function atteintAuClavier(page, element, libelle, max = 150) {
  await page.evaluer("(() => { window.scrollTo(0, 0); for (const el of document.querySelectorAll('main, .main, .content, .page')) el.scrollTop = 0; return true; })()");
  for (let n = 0; n <= max; n++) {
    if (n > 0) await page.touche("Tab");
    if (await page.evaluer(VU(element))) return n;
  }
  throw new Error(`clavier : ${libelle} jamais amené à l'écran en ${max} tabulations.`);
}

const texteDe = async (page, selecteur) =>
  await page.evaluer(`(document.querySelector(${JSON.stringify(selecteur)})?.innerText ?? "").replace(/\\s+/g, " ").trim()`);

const textesDe = async (page, selecteur) =>
  await page.evaluer(`[...document.querySelectorAll(${JSON.stringify(selecteur)})].map((e) => e.innerText.replace(/\\s+/g, " ").trim())`);

/** Libellé d'état affiché par la page de la salle. */
const etatAffiche = async (page) => await texteDe(page, ".omo-etat-libelle");

/** Raisons affichées dans la carte « État de la salle » (et non dans l'écran d'activation, qui a les siennes). */
const RAISONS_ETAT = ".omo-page section.card:has(.omo-etat) .omo-raison";

/** Carte « Demande arrêtée » (détection), repérée par son titre. */
const CARTE_DETECTION = `(() => [...document.querySelectorAll(".omo-page section.card")].find((c) => c.querySelector("h3")?.textContent.trim() === ${JSON.stringify(L.demandeArretee)}) ?? null)()`;

// --- Accès au cockpit et à la salle factice ------------------------------------------------------------------------------------

const statut = async (ctx) => await ctx.api.get("/api/omo/status");

async function attendreEtatSalle(ctx, etat, delaiMs = 90_000) {
  return await attendreQue(
    async () => {
      const lu = await statut(ctx);
      return lu.etatSalle === etat ? lu : false;
    },
    { delaiMs, pasMs: 500, libelle: `salle « ${etat} » (GET /api/omo/status)` },
  );
}

/** Ouvre une salle par l'API (préparation, jamais le parcours éprouvé) : réessaie tant que la salle redémarre (409 salle-en-relance). */
async function ouvrirSalleApi(ctx, projet = "projet-a", delaiMs = 60_000) {
  const limite = Date.now() + delaiMs;
  for (;;) {
    const reponse = await ctx.api.brut("POST", "/api/omo/rooms", { projet }, { entetes: { "x-cockpit-confirm": "1" } });
    const corps = reponse.corps ? JSON.parse(reponse.corps) : null;
    if (reponse.code === 200) return corps;
    if (!(reponse.code === 409 && corps?.error === "salle-en-relance") || Date.now() > limite) {
      throw new Error(`ouverture d'une salle sur ${projet} refusée : ${reponse.code} ${resume(corps)}`);
    }
    await attendre(1_000);
  }
}

/** PUT …/autonomie « omo » par l'API, avec la confirmation : réponse brute (code, corps lu). */
async function activerApi(ctx, rootId, plafondUsd = MONTANT) {
  const reponse = await ctx.api.brut("PUT", `/api/conversations/${encodeURIComponent(rootId)}/autonomie`, { choix: "omo", plafondUsd }, { entetes: { "x-cockpit-confirm": "1" } });
  return { code: reponse.code, corps: reponse.corps ? JSON.parse(reponse.corps) : null };
}

/**
 * Flux d'événements du cockpit rebranché sur la salle depuis son dernier lancement (relevé de la salle factice). « Salle prête »
 * se lit dans l'état publié par le superviseur ; le flux, lui, revient avec le délai croissant du client d'opencode (500 ms à
 * 10 s) : un fait de la salle émis avant (une racine créée, un outil terminé) n'est vu par personne. Rend le délai relevé, en ms.
 */
async function fluxRebranche(ctx, delaiMs = 30_000) {
  const lu = await attendreQue(
    async () => {
      const superviseur = await ctx.salle.pilote.superviseur();
      return superviseur.phase === "opencode-lance" && superviseur.fluxDepuisLancement > 0 ? superviseur : false;
    },
    { delaiMs, pasMs: 250, libelle: "flux d'événements du cockpit rebranché sur la salle lancée" },
  );
  return lu.fluxApresMs;
}

/**
 * Remet la salle en état « prête » : demande en cours arrêtée (par la route de la salle), suspension levée (réouverture confirmée
 * d'une salle, D-2b-29), réglages de la sonde factice rétablis, flux du cockpit rebranché. Préparation d'une étape, jamais ce
 * qu'elle éprouve.
 */
async function sallePrete(s, delaiMs = 120_000) {
  const { ctx } = s;
  const lu = await statut(ctx);
  if (lu.etatSalle === "demande-active") {
    for (const rootId of s.racines) await ctx.api.brut("POST", `/api/omo/rooms/${encodeURIComponent(rootId)}/stop`, {});
  }
  if (lu.etatSalle === "suspendue") s.racines.add((await ouvrirSalleApi(ctx)).rootId);
  const prete = await attendreEtatSalle(ctx, "prete", delaiMs);
  s.rebranchements.push(await fluxRebranche(ctx));
  return prete;
}

/** Page de la salle rechargée À NEUF (autre section puis « Salle OMO ») : état React vidé, enregistreur réinstallé. */
async function pageSalleNeuve(s) {
  const { page } = s;
  await page.evaluer(`location.hash = "#/chat"`);
  await page.attendreQue("!document.querySelector('.omo-page')", { libelle: "page de la salle quittée" });
  await page.evaluer(`location.hash = "#/salle"`);
  await page.attendreQue("document.querySelector('.omo-page .omo-etat-libelle')", { libelle: "page de la salle affichée" });
  await page.evaluer(ENREGISTREUR);
}

/** Identifiant de la racine ouverte par la page : lu dans les requêtes de la page (GET /api/omo/oc/session/:id…). */
function racineDeLaPage(page, depuis = 0) {
  for (const ligne of page.journalReseau().slice(depuis).reverse()) {
    const trouve = /\/api\/omo\/oc\/session\/([^/?]+)/.exec(String(ligne.url));
    if (trouve) return decodeURIComponent(trouve[1]);
  }
  return null;
}

/** Contrôle d'un projet au CLAVIER : [Contrôler ce projet] de sa ligne, Entrée ; rend le résultat affiché. */
async function controlerAuClavier(page, projet) {
  await tabuler(page, (f) => bouton(L.controler)(f) && f.projet === projet, `[${L.controler}] de ${projet}`);
  await page.touche("Enter");
  return await attendreQue(
    async () =>
      await page.evaluer(`(() => {
        const carte = document.querySelector(".omo-projets")?.closest("section.card");
        const statut = carte?.querySelector('[role="status"]');
        if (!statut || carte.querySelector(".spinner")) return false;
        return {
          conforme: statut.innerText.includes(${JSON.stringify(L.projetControle)}),
          phrase: (statut.querySelector(".field-error")?.innerText ?? "").trim(),
          chemins: [...statut.querySelectorAll(".omo-chemins code")].map((c) => c.textContent.trim()),
          texte: carte.innerText,
          ouvrir: [...document.querySelectorAll(".omo-projet")].map((li) => ({
            projet: li.querySelector(".omo-projet-chemin").textContent.trim(),
            actif: ![...li.querySelectorAll("button")].find((b) => b.textContent.trim() === ${JSON.stringify(L.ouvrir)})?.disabled,
          })),
        };
      })()`),
    { delaiMs: 30_000, pasMs: 200, libelle: `pré-contrôle de ${projet} affiché` },
  );
}

/** Salle ouverte sur projet-a au CLAVIER, depuis une page de la salle neuve ; rend l'identifiant de la racine. */
async function ouvrirSalleAuClavier(s, projet = "projet-a") {
  const { page } = s;
  await pageSalleNeuve(s);
  await page.attendreQue(`document.querySelectorAll(".omo-projet").length === 2`, { libelle: "projets préparés affichés" });
  const controle = await controlerAuClavier(page, projet);
  exiger(controle.conforme, `${projet} : pré-contrôle non conforme (${resume(controle)}).`);
  const depuis = page.journalReseau().length;
  await tabuler(page, (f) => bouton(L.ouvrir)(f) && f.projet === projet, `[${L.ouvrir}] de ${projet}`);
  await page.touche("Enter");
  await page.attendreQue(`document.querySelector('.omo-page textarea[aria-label="Votre demande"]')`, { delaiMs: 30_000, libelle: "conversation de la salle ouverte" });
  const rootId = await attendreQue(() => racineDeLaPage(page, depuis), { delaiMs: 15_000, libelle: "racine de la salle lue par la page" });
  s.racines.add(rootId);
  s.rootId = rootId;
  return rootId;
}

/** La page montre-t-elle la conversation d'une salle ouverte ? */
const conversationOuverte = async (page) => await page.evaluer(`Boolean(document.querySelector('.omo-page textarea[aria-label="Votre demande"]'))`);

/** Salle ouverte et page sur sa conversation : ouverte au clavier si besoin. */
async function assurerConversation(s) {
  if (s.rootId !== null && (await conversationOuverte(s.page))) return s.rootId;
  return await ouvrirSalleAuClavier(s);
}

/** Lecture de l'écran d'activation ouvert. */
const ECRAN = `(() => {
  const m = document.querySelector('.modal[role="dialog"]');
  if (!m) return null;
  const champ = m.querySelector(".field input");
  return {
    titre: (m.querySelector(".modal-header h2")?.textContent ?? "").trim(),
    phrases: [...m.querySelectorAll(".omo-activation-phrases li")].map((li) => li.textContent.trim()),
    libelle: (m.querySelector(".field label")?.textContent ?? "").trim(),
    valeur: champ ? champ.value : null,
    invalide: champ ? champ.getAttribute("aria-invalid") : null,
    focusChamp: document.activeElement === champ,
    borne: (m.querySelector(".omo-champ-borne")?.textContent ?? "").trim(),
    aide: (m.querySelector(".field .field-hint")?.textContent ?? "").trim(),
    erreurChamp: (m.querySelector(".field .field-error")?.textContent ?? "").trim(),
    erreurChampAnnoncee: m.querySelector(".field .field-error")?.getAttribute("role") === "alert",
    refusServeur: (m.querySelector(".modal-body > .stack > .field-error")?.textContent ?? "").trim(),
    refusAnnonce: m.querySelector(".modal-body > .stack > .field-error")?.getAttribute("role") === "alert",
    conditions: [...m.querySelectorAll(".omo-raisons .omo-raison")].map((li) => li.textContent.trim()),
    boutons: [...m.querySelectorAll("button")].map((b) => b.textContent.replace(/\\s+/g, " ").trim()).filter(Boolean),
    sansDemande: [...m.querySelectorAll(".omo-sans-demande td")].map((td) => td.textContent.trim()),
  };
})()`;

const ecran = async (page) => await page.evaluer(ECRAN);

/** Saisit la demande et ouvre l'écran d'activation au CLAVIER (zone de saisie, [Envoyer], Entrée). */
async function ouvrirEcranAuClavier(page, texte) {
  await tabuler(page, (f) => f.tag === "textarea" && f.label === "Votre demande", "zone « Votre demande »");
  await page.taper(texte);
  await tabuler(page, bouton(L.envoyer, ".omo-page"), `[${L.envoyer}]`);
  await page.touche("Enter");
  return await attendreQue(async () => (await ecran(page)) ?? false, { delaiMs: 10_000, libelle: "écran d'activation ouvert par Entrée" });
}

/**
 * [Lancer comme Oh My OpenAgent] au clavier, depuis le focus courant dans l'écran d'activation. Le focus est relu juste avant
 * Entrée : un redessin de la page pendant que l'écran est ouvert le renvoie sur le champ (défaut reproduit par l'étape
 * « focus-ecran ») ; il est alors ramené au clavier, et chaque retour est compté au bilan, jamais tu.
 */
async function lancerAuClavier(page, s = null) {
  for (let essai = 1; essai <= 5; essai++) {
    await tabuler(page, bouton(L.lancer, ".modal"), `[${L.lancer}]`, 12);
    if (bouton(L.lancer, ".modal")(await focus(page))) {
      await page.touche("Enter");
      return;
    }
    if (s !== null) s.volsDeFocus += 1;
  }
  throw new Error(`clavier : [${L.lancer}] repris par la page cinq fois de suite avant Entrée.`);
}

/**
 * Attend le bandeau de la demande après [Lancer…] ; sinon, l'échec dit ce que la page a fait (activation, envoi) et ce que l'écran
 * montre, pour qu'un échec soit reproductible et remis tel quel, jamais un simple délai dépassé.
 */
async function attendreBandeau(page, depuis, delaiMs = 30_000) {
  try {
    await page.attendreQue("!document.querySelector('.modal') && document.querySelector('.omo-banner')", { delaiMs, libelle: "bandeau de la demande après la confirmation" });
  } catch (err) {
    const reseau = page
      .journalReseau()
      .slice(depuis)
      .filter((l) => /\/api\/(conversations\/[^/]+\/autonomie|omo\/)/.test(String(l.url)))
      .map((l) => `${l.methode} ${String(l.url).replace(/^https?:\/\/[^/]+/, "").split("?")[0]} → ${l.code ?? l.etat}`);
    throw new Error(`${err.message} ; requêtes de la page : ${resume(reseau, 600)} ; écran : ${resume(await ecran(page), 400)} ; état affiché : « ${await etatAffiche(page)} »`);
  }
}

/** Requêtes de la page d'une méthode vers une route (journal réseau de l'onglet), depuis l'indice `depuis`. */
const requetesPage = (page, methode, motif, depuis = 0) => page.journalReseau().slice(depuis).filter((l) => l.methode === methode && motif.test(String(l.url).split("?")[0]));

/** Envois reçus par la salle factice pour une racine (POST …/prompt_async). */
async function envoisSalle(ctx, rootId) {
  return (await ctx.salle.pilote.requetes()).filter((r) => r.method === "POST" && r.pathname === `/session/${rootId}/prompt_async`);
}

/** Les six captures (1440, 1024, 400, clair et sombre), puis la fenêtre de travail rétablie. */
async function captures(s, nom) {
  await attendre(400);
  const faites = await s.ctx.screenshot(nom);
  exiger(faites.length === 6, `6 captures attendues (${nom}), ${faites.length} faites.`);
  s.captures += faites.length;
  await s.page.taille(LARGE);
}

// --- Étapes --------------------------------------------------------------------------------------------------------------------

async function prealables(s) {
  const { ctx } = s;
  const boot = await ctx.api.get("/api/bootstrap");
  exiger(boot?.omo?.enabled === true && boot.omo.imageChargee === true && boot.omo.salleOuverte === true, `Bootstrap.omo inattendu sur la pile de la salle : ${resume(boot?.omo)}`);
  exiger(boot?.settings?.ui?.mode === "simple", `mode ${resume(boot?.settings?.ui?.mode)} au lieu de « simple » (défaut).`);
  // La bascule ne vit que dans la copie du banc : le dépôt garde la salle FERMÉE.
  const wiring = fs.readFileSync(path.join(RACINE_DEPOT, "app", "server", "wiring-11.ts"), "utf8");
  exiger(/^export const SALLE_OUVERTE = false;$/m.test(wiring) && !/SALLE_OUVERTE = true/.test(wiring), "SALLE_OUVERTE n'est plus fausse dans le dépôt.");
  // Catalogue du compte GitHub Copilot (P1) : le faux catalogue, lu par le cockpit ; un relevé est demandé s'il ne l'est pas encore.
  if (boot.copilot?.verified !== true) await ctx.api.post("/api/models/refresh");
  await attendreQue(async () => (await ctx.api.get("/api/bootstrap"))?.copilot?.verified === true, { delaiMs: 60_000, pasMs: 1_000, libelle: "catalogue du compte Copilot (faux) vérifié" });
  const lu = await sallePrete(s, 180_000);
  exiger(String(lu.image?.id ?? "").includes("e2e-salle-factice"), `image publiée par la salle : ${resume(lu.image)} (la salle factice, jamais l'extension).`);
  exiger(lu.projetsPrepares.map((p) => p.chemin).join() === ctx.salle.projets.join(), `projets préparés : ${resume(lu.projetsPrepares)}`);
  exiger(lu.authSalle?.presente === true && lu.battement?.actif === true, `authentification ou battement absents : ${resume({ auth: lu.authSalle, battement: lu.battement })}`);
  const superviseur = await ctx.salle.pilote.superviseur();
  exiger(superviseur.listeLue === true && superviseur.phase === "opencode-lance", `superviseur factice : ${resume(superviseur)}`);
  await preparerPage(ctx);
  s.bilan.push(`préalables : salle factice prête (démarrage ${superviseur.demarrages}), catalogue du compte vérifié, SALLE_OUVERTE fausse dans le dépôt`);
}

async function simple(s) {
  const { ctx, page } = s;
  await changerMode(ctx, "simple");
  await attendreModeAffiche(page, "simple");
  const entrees = await textesDe(page, "nav.rail a.nav-item");
  exiger(entrees.length > 0 && !entrees.includes(L.entree), `mode Simple : entrée « ${L.entree} » présente (${resume(entrees)}).`);
  const depuis = page.journalReseau().length;
  await page.evaluer(`location.hash = "#/salle"`);
  await attendre(1_500);
  exiger(!(await page.evaluer("Boolean(document.querySelector('.omo-page'))")), "mode Simple : la page de la salle s'affiche par son adresse.");
  exiger(requetesPage(page, "GET", /\/api\/omo\//, depuis).length === 0, "mode Simple : la page a appelé /api/omo/*.");
  await page.evaluer(`location.hash = "#/chat"`);

  // Flux d'événements (P11, §3.16) : aucun événement de la salle en Simple ; la même relance en Avancé en fait arriver.
  await avecTemoinP6(ctx, async (temoin) => {
    const relancer = async () => {
      const avant = (await statut(ctx)).dernierDemarrage?.startId ?? null;
      await ctx.salle.pilote.regler({ relancer: true });
      await attendreQue(
        async () => {
          const lu = await statut(ctx);
          return lu.etatSalle === "prete" && (lu.dernierDemarrage?.startId ?? null) !== avant ? lu : false;
        },
        { delaiMs: 90_000, pasMs: 500, libelle: "salle relancée à neuf puis prête" },
      );
      await attendre(1_500);
    };
    const debutSimple = temoin.evenements.length;
    await relancer();
    const enSimple = temoin.evenements.slice(debutSimple).filter((e) => e.instance === "omo");
    exiger(enSimple.length === 0, `mode Simple : ${enSimple.length} événement(s) de la salle reçu(s) (${resume(enSimple.map((e) => e.type ?? e.event?.type))}).`);
    await changerMode(ctx, "avance");
    const debutAvance = temoin.evenements.length;
    await relancer();
    const enAvance = temoin.evenements.slice(debutAvance).filter((e) => e.instance === "omo");
    exiger(enAvance.length > 0, "contre-épreuve : aucun événement de la salle reçu en Avancé pour la même relance (le relevé ne prouverait rien).");
    s.bilan.push(`Simple : entrée absente, page inaccessible, 0 événement de la salle pendant une relance ; Avancé : ${enAvance.length} événement(s) pour la même relance`);
  });
  await changerMode(ctx, "simple");
}

async function entree(s) {
  const { ctx, page } = s;
  await changerMode(ctx, "avance");
  await attendreModeAffiche(page, "avance");
  await page.evaluer(`location.hash = "#/chat"`);
  const tabulations = await tabuler(page, (f) => f.tag === "a" && f.texte === L.entree && f.dans.includes("nav.rail"), `entrée « ${L.entree} » de la barre`);
  await page.touche("Enter");
  await page.attendreQue("document.querySelector('.omo-page .omo-etat-libelle')", { libelle: "page de la salle ouverte par Entrée" });
  exiger((await page.evaluer("location.hash")) === "#/salle", "Entrée sur « Salle OMO » n'a pas ouvert #/salle.");
  await page.evaluer(ENREGISTREUR);
  await page.attendreQue(`document.querySelector(".omo-etat-libelle")?.textContent.trim() === ${JSON.stringify(L.etats.prete)}`, { delaiMs: 30_000, libelle: `« ${L.etats.prete} » affiché` });
  const projets = await textesDe(page, ".omo-projet .omo-projet-chemin");
  exiger(projets.join() === ctx.salle.projets.join(), `projets préparés affichés : ${resume(projets)}`);
  await captures(s, "salle-prete");
  s.bilan.push(`entrée « ${L.entree} » atteinte en ${tabulations} tabulation(s) et ouverte par Entrée ; « ${L.etats.prete} »`);
}

async function projetPiege(s) {
  const { ctx, page } = s;
  await changerMode(ctx, "avance");
  await sallePrete(s);
  await pageSalleNeuve(s);
  await page.attendreQue(`document.querySelectorAll(".omo-projet").length === 2`, { libelle: "projets préparés affichés" });
  // Piège posé sur le disque du banc, comme un fichier laissé dans un projet : configuration d'opencode et fichier de clés.
  const pieges = [path.join(ctx.salle.workspace, "projet-a", "opencode.json"), path.join(ctx.salle.workspace, "projet-a", "client-acme-prod.pem")];
  fs.writeFileSync(pieges[0], "{}\n");
  fs.writeFileSync(pieges[1], "contenu factice du banc e2e, aucune clé\n");
  try {
    const refuse = await controlerAuClavier(page, "projet-a");
    exiger(!refuse.conforme, `projet piégé donné conforme : ${resume(refuse)}`);
    exiger(Object.values(T.precontrole).includes(refuse.phrase), `phrase du refus inattendue : « ${refuse.phrase} »`);
    exiger(refuse.chemins.includes("./opencode.json") && refuse.chemins.includes("./****.pem"), `liste masquée inattendue : ${resume(refuse.chemins)}`);
    exiger(!refuse.texte.includes("client-acme"), "le nom du fichier de clés est montré en clair.");
    exiger(refuse.ouvrir.find((o) => o.projet === "projet-a")?.actif === false, "[Ouvrir la salle ici] reste possible sur un projet refusé.");
    await captures(s, "projet-piege");
    s.bilan.push(`projet piégé : « ${refuse.phrase} » ; liste masquée ${refuse.chemins.join(", ")}`);
  } finally {
    for (const piege of pieges) fs.rmSync(piege, { force: true });
  }
  const conforme = await controlerAuClavier(page, "projet-a");
  exiger(conforme.conforme && conforme.ouvrir.find((o) => o.projet === "projet-a")?.actif === true, `piège retiré : projet toujours refusé (${resume(conforme)}).`);
}

async function activation(s) {
  const { ctx, page } = s;
  await changerMode(ctx, "avance");
  await sallePrete(s);
  const rootId = await ouvrirSalleAuClavier(s);
  await ctx.salle.pilote.tourParDefaut(TOUR_LONG);
  const debutReseau = page.journalReseau().length;
  const envoisAvant = (await envoisSalle(ctx, rootId)).length;

  // Écran d'activation (§4.14.6), à chaque demande : titre, phrases, champ vide la première fois, focus sur le champ.
  const vue = await ouvrirEcranAuClavier(page, "Demande e2e de la salle, au clavier seul");
  exiger(vue.titre === L.titreActivation, `titre de l'écran : « ${vue.titre} »`);
  exiger(vue.focusChamp, "le focus n'est pas sur le champ « Arrêt automatique à : » à l'ouverture.");
  exiger(vue.libelle === L.champ && vue.valeur === "", `champ : « ${vue.libelle} » = « ${vue.valeur} » (vide attendu la première fois).`);
  exiger(/^au plus \d+(,\d{2})? \$$/.test(vue.borne), `borne affichée : « ${vue.borne} »`);
  for (const bout of [L.lancer, L.annuler, L.sansDemande]) exiger(vue.boutons.includes(bout), `bouton [${bout}] absent (${resume(vue.boutons)}).`);
  for (const phrase of [T.activation.reseau, T.activation.programme, T.activation.fichiersExecutes, T.activation.arreter, T.activation.sansDemande, T.activation.refuse]) {
    exiger(vue.phrases.includes(phrase), `phrase absente de l'écran : « ${phrase.slice(0, 80)}… »`);
  }
  // T-L26-f : variante Prometheus, lue dans l'audit de la 4.19.4 (clé `agents`), jamais devinée.
  const edit = CLES.find((c) => c.cle === "agents")?.valeur?.prometheus?.permission?.edit;
  const [attendue, autre] = edit === "allow" ? [T.activation.planificateurSansDemande, T.activation.planificateurControle] : [T.activation.planificateurControle, T.activation.planificateurSansDemande];
  exiger(vue.phrases.includes(attendue) && !vue.phrases.includes(autre), `variante Prometheus (edit « ${edit} ») : ${resume(vue.phrases)}`);
  await tabuler(page, bouton(L.sansDemande, ".modal"), `[${L.sansDemande}]`, 12);
  await page.touche("Enter");
  const tableau = await attendreQue(async () => ((await ecran(page)).sansDemande.length > 0 ? (await ecran(page)).sansDemande : false), { delaiMs: 5_000, libelle: "tableau « sans demande » ouvert" });
  const attendueTableau = edit === "allow" ? T.honnetete.planificateurSansDemande : T.honnetete.planificateurControle;
  exiger(tableau.includes(attendueTableau), `tableau « sans demande » sans la variante Prometheus : ${resume(tableau)}`);
  await page.touche("Enter");

  // T-L26-c, champ vide : erreur annoncée près du champ, rien n'est envoyé.
  await lancerAuClavier(page, s);
  const vide = await attendreQue(async () => {
    const lu = await ecran(page);
    return lu.erreurChamp !== "" ? lu : false;
  }, { delaiMs: 5_000, libelle: "erreur du champ vide annoncée" });
  exiger(vide.erreurChamp === T.refus["plafond-vide"] && vide.erreurChampAnnoncee && vide.invalide === "true", `champ vide : ${resume({ erreur: vide.erreurChamp, annoncee: vide.erreurChampAnnoncee, invalide: vide.invalide })}`);
  exiger(requetesPage(page, "PUT", ROUTE_AUTONOMIE, debutReseau).length === 0, "champ vide : une activation est partie.");
  await captures(s, "activation-champ-vide");

  // T-L26-c, refus du serveur : une condition que seul le serveur vérifie (manifeste de l'image) → 409 et sa phrase, rien n'est envoyé.
  await ctx.salle.pilote.regler({ manifesteReference: "ecart" });
  try {
    await page.touche("Escape");
    await page.attendreQue("!document.querySelector('.modal')", { libelle: "écran fermé par Échap" });
    exiger(bouton(L.envoyer)(await focus(page)), `Échap : le focus n'est pas revenu sur [${L.envoyer}] (${resume(await focus(page))}).`);
    await page.touche("Enter");
    await attendreQue(async () => (await ecran(page))?.focusChamp === true, { delaiMs: 5_000, libelle: "écran rouvert, focus sur le champ" });
    await page.taper(MONTANT);
    await lancerAuClavier(page, s);
    const refus = await attendreQue(async () => {
      const lu = await ecran(page);
      return lu?.refusServeur ? lu : false;
    }, { delaiMs: 20_000, libelle: "refus du serveur affiché" });
    exiger(refus.refusServeur === T.refus.manifeste && refus.refusAnnonce, `409 affiché : « ${refus.refusServeur} » (attendu « ${T.refus.manifeste} »).`);
    const puts = requetesPage(page, "PUT", ROUTE_AUTONOMIE, debutReseau);
    exiger(puts.length === 1 && puts[0].code === 409, `activation refusée : ${resume(puts)}`);
    exiger((await envoisSalle(ctx, rootId)).length === envoisAvant, "409 : un message est parti vers la salle.");
    exiger(!(await page.evaluer("Boolean(document.querySelector('.omo-banner'))")), "409 : bandeau affiché.");
    s.consoleToleree += 1;
    await captures(s, "activation-409");
  } finally {
    await ctx.salle.pilote.regler({ manifesteReference: "ok" });
  }

  // Confirmation → bandeau permanent (« … · — $ sur 0,50 $ ») avec [Arrêter] et [Journal] ; le message part vers la salle.
  await page.touche("Escape");
  await page.attendreQue("!document.querySelector('.modal')", { libelle: "écran fermé par Échap" });
  await page.touche("Enter");
  const rouvert = await attendreQue(async () => ((await ecran(page))?.focusChamp ? await ecran(page) : false), { delaiMs: 5_000, libelle: "écran rouvert" });
  exiger(rouvert.valeur === MONTANT, `montant saisi perdu à la réouverture : « ${rouvert.valeur} »`);
  const repere = (await etatsVus(page)).length;
  await lancerAuClavier(page, s);
  await page.attendreQue("!document.querySelector('.modal') && document.querySelector('.omo-banner')", { delaiMs: 30_000, libelle: "bandeau de la salle après la confirmation" });
  const bandeau = await texteDe(page, ".omo-banner-resume");
  exiger(bandeau.startsWith(L.bandeau) && bandeau.endsWith(`sur ${MONTANT} $`), `bandeau : « ${bandeau} »`);
  const boutonsBandeau = await textesDe(page, ".omo-banner button");
  exiger(boutonsBandeau.includes(L.arreter) && boutonsBandeau.includes(L.journal), `boutons du bandeau : ${resume(boutonsBandeau)}`);
  exiger(requetesPage(page, "PUT", ROUTE_AUTONOMIE, debutReseau).some((l) => l.code === 200), "confirmation : aucune activation acceptée.");
  await attendreQue(async () => (await envoisSalle(ctx, rootId)).length === envoisAvant + 1, { delaiMs: 15_000, libelle: "message reçu par la salle factice" });
  await attendreSuite(page, repere, [L.etats.demande], 20_000);
  await captures(s, "bandeau-demande");

  // [Arrêter] → POST /api/omo/rooms/:rootId/stop (jamais l'arrêt de l'instance principale), puis relance à neuf affichée.
  const avantArret = page.journalReseau().length;
  const reperArret = (await etatsVus(page)).length;
  await tabuler(page, bouton(L.arreter, ".omo-banner"), `[${L.arreter}] du bandeau`);
  await page.touche("Enter");
  await attendreQue(() => requetesPage(page, "POST", new RegExp(`/api/omo/rooms/${rootId}/stop$`), avantArret).find((l) => l.code === 200) ?? false, {
    delaiMs: 30_000,
    libelle: "POST /api/omo/rooms/:rootId/stop accepté",
  });
  exiger(requetesPage(page, "POST", /\/api\/conversations\/[^/]+\/stop$/, avantArret).length === 0, "[Arrêter] a appelé l'arrêt d'une conversation de l'instance principale.");
  const vus = await attendreSuite(page, reperArret, [L.etats.relance, L.etats.prete], 120_000);
  exiger(!(await page.evaluer("Boolean(document.querySelector('.omo-banner'))")), "bandeau encore affiché après l'arrêt.");
  const journal = (await ctx.salle.pilote.superviseur()).journal.map((j) => j.cause);
  exiger(journal.some((cause) => cause.includes("stop-request « vous »")), `superviseur : aucun stop-request « vous » (${resume(journal)}).`);
  s.bilan.push(`activation au clavier : champ vide annoncé, 409 « manifeste » affiché, bandeau, [Arrêter] → stop de la salle ; états vus ${vus.join(" → ")}`);
}

async function finDeDemande(s) {
  const { ctx, page } = s;
  await changerMode(ctx, "avance");
  await sallePrete(s);
  const rootId = await assurerConversation(s);
  await ctx.salle.pilote.tourParDefaut(TOUR_BREF);
  const envoisAvant = (await envoisSalle(ctx, rootId)).length;
  const vue = await ouvrirEcranAuClavier(page, "Demande brève de la salle");
  if (vue.valeur !== MONTANT) {
    exiger(vue.valeur === "", `champ prérempli inattendu : « ${vue.valeur} »`);
    await page.taper(MONTANT);
  }
  const repere = (await etatsVus(page)).length;
  const avantLancer = page.journalReseau().length;
  await lancerAuClavier(page, s);
  await attendreBandeau(page, avantLancer);
  await attendreQue(async () => (await envoisSalle(ctx, rootId)).length === envoisAvant + 1, { delaiMs: 15_000, libelle: "message reçu par la salle factice" });

  // [Journal] au clavier : le Journal vient à l'écran et reçoit le focus.
  await tabuler(page, bouton(L.journal, ".omo-banner"), `[${L.journal}] du bandeau`);
  await page.touche("Enter");
  await page.attendreQue(`document.activeElement?.classList.contains("omo-journal")`, { delaiMs: 5_000, libelle: "focus sur le Journal après [Journal]" });
  exiger(await page.evaluer(VU(PREMIER("section.omo-journal h3"))), "le Journal n'est pas à l'écran après [Journal].");

  // Fin de demande (repos 15 s, D-2b-29) : relance à neuf, puis prête.
  const vus = await attendreSuite(page, repere, [L.etats.demande, L.etats.relance, L.etats.prete], 120_000);
  exiger(!(await page.evaluer("Boolean(document.querySelector('.omo-banner'))")), "bandeau encore affiché après la fin de la demande.");
  const journal = (await ctx.salle.pilote.superviseur()).journal.map((j) => j.cause);
  exiger(journal.some((cause) => cause.includes("stop-request « fin-de-demande »")), `superviseur : aucune relance de fin de demande (${resume(journal)}).`);
  s.bilan.push(`fin de demande : [Journal] au clavier (focus sur le Journal) ; états vus ${vus.join(" → ")}`);
}

async function suspendue(s) {
  const { ctx, page } = s;
  await changerMode(ctx, "avance");
  await sallePrete(s);
  const rootId = await assurerConversation(s);
  const racineEtrangere = async (numero) => {
    const avant = (await statut(ctx)).dernierDemarrage?.startId ?? null;
    // Racine créée seulement quand le cockpit écoute la salle : avant, personne ne la verrait (délai de reconnexion du flux, dit au
    // bilan). Sans cette attente, la seconde racine tombait parfois dans ce délai après la relance (passe complète du 24/09).
    s.rebranchements.push(await fluxRebranche(ctx));
    const creee = await ctx.salle.pilote.racineEtrangere("/workspace/projet-a");
    exiger(typeof creee.sessionID === "string", `racine étrangère ${numero} non créée : ${resume(creee)}`);
    return avant;
  };
  // Première activité hors demande : arrêt et relance, la détection est dite à l'écran.
  const avant = await racineEtrangere(1);
  await page.attendreQue(`(${CARTE_DETECTION})?.innerText.includes(${JSON.stringify(phraseDetection("racine-etrangere"))})`, { delaiMs: 30_000, libelle: "détection « racine étrangère » affichée" });
  await attendreQue(
    async () => {
      const lu = await statut(ctx);
      return lu.etatSalle === "prete" && (lu.dernierDemarrage?.startId ?? null) !== avant ? lu : false;
    },
    { delaiMs: 90_000, pasMs: 500, libelle: "salle relancée après la première activité hors demande" },
  );
  // Seconde en moins de 10 minutes : suspendue (D-2b-29).
  await racineEtrangere(2);
  await attendreEtatSalle(ctx, "suspendue", 60_000);
  await page.attendreQue(`document.querySelector(".omo-etat-libelle")?.textContent.trim() === ${JSON.stringify(L.etats.suspendue)}`, { delaiMs: 30_000, libelle: `« ${L.etats.suspendue} » affiché` });
  const raisons = await textesDe(page, RAISONS_ETAT);
  exiger(raisons.includes(T.refus["salle-suspendue"]), `raison de la suspension absente : ${resume(raisons)}`);

  // Activation refusée avec sa phrase : à l'écran, rien n'est envoyé ; par l'API, 409 et la même phrase.
  const debutReseau = page.journalReseau().length;
  const vue = await ouvrirEcranAuClavier(page, "Demande pendant la suspension");
  exiger(vue.conditions.includes(T.refus["salle-suspendue"]), `écran d'activation sans la raison de la suspension : ${resume(vue.conditions)}`);
  if (vue.valeur !== MONTANT) await page.taper(MONTANT);
  await lancerAuClavier(page, s);
  await attendre(1_500);
  exiger(requetesPage(page, "PUT", ROUTE_AUTONOMIE, debutReseau).length === 0, "salle suspendue : une activation est partie de l'écran.");
  exiger(await page.evaluer("Boolean(document.querySelector('.modal'))"), "salle suspendue : l'écran s'est fermé comme si la demande était lancée.");
  await captures(s, "salle-suspendue");
  await page.touche("Escape");
  const api = await activerApi(ctx, rootId);
  exiger(api.code === 409 && api.corps?.raison === "salle-suspendue" && api.corps?.message === T.refus["salle-suspendue"], `PUT …/autonomie pendant la suspension : ${resume(api)}`);

  // La réouverture confirmée d'une salle lève la suspension (D-2b-29), et le battement reprend (reste n° 2 du train de V4) : la
  // salle factice, comme la vraie, ne relance opencode qu'avec un battement frais et le precheck-ok du nouveau démarrage.
  const battementSuspendue = (await statut(ctx)).battement;
  s.racines.add((await ouvrirSalleApi(ctx)).rootId);
  const levee = await attendreEtatSalle(ctx, "prete", 90_000);
  exiger(levee.battement?.actif === true, `suspension levée sans battement actif : ${resume(levee.battement)}`);
  s.bilan.push(
    "suspension : deux racines hors du cockpit → « Salle suspendue » et sa raison ; activation refusée à l'écran et par 409 ; levée par la " +
      `réouverture d'une salle, battement ${battementSuspendue?.actif ? "actif" : "arrêté"} pendant la suspension puis actif`,
  );
}

/**
 * Fichiers « à relire » de fin de demande (§4.14.5 l.850, « signalé sans arrêt » ; D-2b-37) : un `*.ps1` écrit pendant une demande,
 * dans une entrée ouverte en écriture, est listé par le cockpit à la fin de la demande (`omo.signales`), sans arrêt. Contre-épreuve
 * par le flux du cockpit (l'événement part bien, pour cette racine), puis l'écran : la phrase et le chemin doivent être sur la page
 * de la salle, atteints au clavier. Constat du train de V4 (constats-salle-V4.md §3 et §7 n° 3) : l'affichage d'`omo.signales` par
 * la page revenait à L26c, qui n'écrit pas dans app/ ; l'étape l'a trouvé absent (D-L26c-2), le train de V5 l'a corrigé (carte
 * « Fichiers à relire » de SalleOmoPage). Un échec ici est REMIS, jamais tu.
 */
async function signales(s) {
  const { ctx, page } = s;
  await changerMode(ctx, "avance");
  await sallePrete(s);
  const rootId = await assurerConversation(s);
  await ctx.salle.pilote.tourParDefaut(TOUR_BREF);
  const relatif = "projet-a/src/outil-e2e.ps1";
  const fichier = path.join(ctx.salle.workspace, ...relatif.split("/"));
  await avecTemoinP6(ctx, async (temoin) => {
    const vue = await ouvrirEcranAuClavier(page, "Demande pendant laquelle un script PowerShell est écrit");
    if (vue.valeur !== MONTANT) await page.taper(MONTANT);
    const repere = (await etatsVus(page)).length;
    const avantLancer = page.journalReseau().length;
    await lancerAuClavier(page, s);
    await attendreBandeau(page, avantLancer);
    // Pendant la demande : un script écrit dans une entrée ouverte en écriture (A16), comme l'IA de la salle le ferait.
    fs.writeFileSync(fichier, "Write-Output 'Script du banc e2e de la salle : à relire avant de le lancer.'\n");
    try {
      const vus = await attendreSuite(page, repere, [L.etats.demande, L.etats.relance, L.etats.prete], 120_000);
      const recu = await temoin.attendreCockpit(
        "omo.signales",
        (d) => d?.rootId === rootId && Array.isArray(d?.signales) && d.signales.some((x) => x.chemin === relatif && x.genre === "programme"),
        30_000,
      );
      exiger(recu.instance === "omo", `omo.signales sans l'étiquette de la salle : ${resume(recu)}`);
      await attendre(1_500);
      const texte = await page.evaluer(`(document.querySelector(".omo-page")?.innerText ?? "").replace(/\\s+/g, " ")`);
      const phrase = T.signales.programme;
      exiger(
        texte.includes(relatif) && texte.includes(phrase),
        `fin de demande : « omo.signales » reçu par le flux du cockpit (${relatif}, « programme ») mais la page de la salle ne l'affiche pas ` +
          `(chemin ${texte.includes(relatif) ? "présent" : "absent"}, phrase « ${phrase} » ${texte.includes(phrase) ? "présente" : "absente"}) : ` +
          "SalleOmoPage (L26a) doit lire « omo.signales » et le rendre (carte des fichiers à relire, train de V5) ; §4.14.5 l.850 veut ces fichiers listés en fin de demande.",
      );
      const cible = `[...document.querySelectorAll(".omo-page code")].find((c) => c.textContent.trim() === ${JSON.stringify(relatif)}) ?? null`;
      const tabulations = await atteintAuClavier(page, cible, "fichier à relire de fin de demande");
      await captures(s, "signales-fin-de-demande");
      s.bilan.push(`fichiers à relire : ${relatif} listé en fin de demande (${vus.join(" → ")}), atteint en ${tabulations} tabulation(s)`);
    } finally {
      fs.rmSync(fichier, { force: true });
    }
  });
}

async function detection(s) {
  const { ctx, page } = s;
  await changerMode(ctx, "avance");
  await sallePrete(s);
  await assurerConversation(s);
  const src = path.join(ctx.salle.workspace, "projet-a", "src");
  const quarantaines = () => fs.readdirSync(src).filter((nom) => nom.startsWith(".git.suspect-"));
  const dejaEnQuarantaine = quarantaines().length;
  await ctx.salle.pilote.tourParDefaut(TOUR_LONG);
  const vue = await ouvrirEcranAuClavier(page, "Demande pendant laquelle un historique git apparaît");
  if (vue.valeur !== MONTANT) await page.taper(MONTANT);
  const avantLancer = page.journalReseau().length;
  await lancerAuClavier(page, s);
  await attendreBandeau(page, avantLancer);
  // Pendant la demande, un `.git` apparaît dans une entrée ouverte en écriture (A16) : c'est la détection 6.
  const creation = path.join(src, ".git");
  fs.mkdirSync(creation, { recursive: true });
  fs.writeFileSync(path.join(creation, "HEAD"), "ref: refs/heads/main\n");
  try {
    await page.attendreQue(`(${CARTE_DETECTION})?.innerText.includes(${JSON.stringify(phraseDetection("git-cree"))})`, { delaiMs: 120_000, libelle: "détection « git créé » affichée" });
    const carte = await page.evaluer(`(() => { const c = ${CARTE_DETECTION}; return { texte: c.innerText, chemins: [...c.querySelectorAll(".omo-chemins code")].map((e) => e.textContent.trim()), alerte: c.querySelector('[role="alert"]')?.textContent.trim() ?? "" }; })()`);
    exiger(carte.alerte === phraseDetection("git-cree"), `détection annoncée : « ${carte.alerte} »`);
    exiger(carte.texte.includes(T.detectionApresCoup), "la détection n'est pas dite après coup.");
    exiger(carte.chemins.some((chemin) => chemin.startsWith("projet-a/src/.git")), `fichiers signalés : ${resume(carte.chemins)}`);
    exiger(carte.texte.includes(T.signales["git-quarantaine"].split("({chemin})")[0].trim()), `quarantaine non dite : ${carte.texte.slice(0, 300)}`);
    // Sur le disque : le `.git` créé est mis de côté, jamais supprimé.
    await attendreQue(() => !fs.existsSync(creation) && quarantaines().length === dejaEnQuarantaine + 1, { delaiMs: 30_000, libelle: "`.git` créé mis en quarantaine sur le disque" });
    // Journal de la salle : la détection et la quarantaine, venues du flux.
    await page.attendreQue(`(document.querySelector("section.omo-journal")?.innerText ?? "").includes("projet-a/src/.git")`, { delaiMs: 15_000, libelle: "quarantaine dans le Journal de la salle" });
    // Atteignables au clavier, à 1440 et à 400 px : le parcours au clavier amène la liste des fichiers signalés et la phrase de la
    // quarantaine (carte « Demande arrêtée ») à l'écran. La copie du Journal est relevée à part : elle est rendue sous le dernier
    // élément focalisable de la page, et [Journal], qui y mène, disparaît avec la demande ; c'est dit au bilan, pas tu.
    const atteintes = [];
    for (const taille of [LARGE, { largeur: 400, hauteur: 860 }]) {
      await page.taille(taille);
      atteintes.push(`${taille.largeur} px : liste en ${await atteintAuClavier(page, `(${CARTE_DETECTION})?.querySelector(".omo-chemins li")`, "liste des fichiers signalés")}`);
      atteintes.push(`quarantaine en ${await atteintAuClavier(page, `(${CARTE_DETECTION})?.querySelector("p.small:not(.muted)")`, "phrase de la quarantaine")}`);
      let journal;
      try {
        journal = `${await atteintAuClavier(page, PREMIER("section.omo-journal li code"), "quarantaine du Journal", 60)}`;
      } catch {
        journal = "jamais par la seule tabulation";
      }
      atteintes.push(`copie du Journal ${journal}`);
    }
    await page.taille(LARGE);
    await captures(s, "detection");
    await attendreEtatSalle(ctx, "prete", 120_000);
    s.bilan.push(`détection : « git créé », arrêt, quarantaine sur le disque, liste et quarantaine atteintes au clavier (tabulations : ${atteintes.join(", ")})`);
  } finally {
    fs.rmSync(creation, { recursive: true, force: true });
    for (const nom of quarantaines()) fs.rmSync(path.join(src, nom), { recursive: true, force: true });
  }
}

async function gitAttente(s) {
  const { ctx, page } = s;
  await changerMode(ctx, "avance");
  await sallePrete(s);
  const rootId = s.rootId ?? (await ouvrirSalleApi(ctx)).rootId;
  s.racines.add(rootId);
  const avant = (await statut(ctx)).dernierDemarrage?.startId ?? null;
  // La sonde (factice) de la salle relève un `.git` non protégé : la salle ATTEND, le cockpit refuse son pré-contrôle.
  await ctx.salle.pilote.regler({ nonProteges: ["projet-b/.git"], relancer: true });
  try {
    const lu = await attendreQue(
      async () => {
        const st = await statut(ctx);
        return st.dernierDemarrage && st.dernierDemarrage.startId !== avant && st.workspaceGit?.nonProteges?.includes("projet-b/.git") ? st : false;
      },
      { delaiMs: 90_000, pasMs: 500, libelle: "démarrage relevé avec un `.git` non protégé" },
    );
    await attendre(4_000);
    const superviseur = await ctx.salle.pilote.superviseur();
    exiger(superviseur.phase === "attente" && (await statut(ctx)).etatSalle !== "prete", `la salle a démarré malgré le .git non protégé : ${resume({ phase: superviseur.phase, etat: lu.etatSalle })}`);

    // Page de la salle : la raison est ÉCRITE, lisible sans interaction, et le parcours au clavier l'amène à l'écran.
    await pageSalleNeuve(s);
    await tabuler(page, bouton(L.actualiser, ".omo-page"), `[${L.actualiser}]`);
    await page.touche("Enter");
    await page.attendreQue(`document.querySelector(".omo-etat-libelle")?.textContent.trim() === ${JSON.stringify(L.etats.arretee)}`, { delaiMs: 20_000, libelle: `« ${L.etats.arretee} » affiché` });
    const debutGit = T.refus["git-inscriptible"].split("{liste}")[0].trim();
    const raisons = await textesDe(page, RAISONS_ETAT);
    const raison = raisons.find((r) => r.startsWith(debutGit));
    exiger(raison !== undefined && raison.includes("projet-b/.git"), `raison de l'attente absente de la page de la salle : ${resume(raisons)}`);
    const gitProjets = await textesDe(page, ".omo-projet");
    exiger(gitProjets.some((ligne) => ligne.includes("projet-b") && ligne.includes(T.git.inscriptible)), `état git des projets : ${resume(gitProjets)}`);
    const tabsSalle = [];
    for (const taille of [LARGE, { largeur: 400, hauteur: 860 }]) {
      await page.taille(taille);
      tabsSalle.push(await atteintAuClavier(page, PREMIER(RAISONS_ETAT), "raison de l'attente (page de la salle)"));
    }
    await page.taille(LARGE);
    await captures(s, "git-attente-salle");

    // Diagnostic : même raison, avec la liste des chemins, atteinte au clavier depuis la barre.
    await tabuler(page, (f) => f.tag === "a" && f.texte === L.diagnostic && f.dans.includes("nav.rail"), "entrée « Diagnostic »");
    await page.touche("Enter");
    const SECTION = `(() => { const c = [...document.querySelectorAll("section.card")].find((x) => x.querySelector("h3")?.textContent.trim() === ${JSON.stringify(L.carteDiagnostic)}); return c ? [...c.querySelectorAll("section")].find((x) => x.querySelector("h4")?.textContent.trim() === ${JSON.stringify(L.attente)}) ?? null : null; })()`;
    await page.attendreQue(SECTION, { delaiMs: 30_000, libelle: `section « ${L.attente} » du Diagnostic` });
    const diag = await page.evaluer(`(() => { const s = ${SECTION}; return { texte: s.innerText, chemins: [...s.querySelectorAll("ul.mono li")].map((li) => li.textContent.trim()) }; })()`);
    exiger(diag.chemins.includes("projet-b/.git") || diag.chemins.includes("projet-b"), `Diagnostic : chemins de l'attente ${resume(diag.chemins)}`);
    exiger(diag.texte.includes(T.refus["git-inscriptible"].split("{liste}")[0].trim().split(" : ")[0]), `Diagnostic : raison git absente (${diag.texte.slice(0, 300)})`);
    const tabsDiag = [];
    for (const taille of [LARGE, { largeur: 400, hauteur: 860 }]) {
      await page.taille(taille);
      tabsDiag.push(await atteintAuClavier(page, `(${SECTION})?.querySelector("li")`, "raison de l'attente (Diagnostic)"));
    }
    await page.taille(LARGE);
    await captures(s, "git-attente-diagnostic");

    // Activation : 409 « git-inscriptible », avec la liste.
    const api = await activerApi(ctx, rootId);
    exiger(api.code === 409 && api.corps?.raison === "git-inscriptible" && String(api.corps?.message).includes("projet-b/.git"), `PUT …/autonomie pendant l'attente : ${resume(api)}`);
    const phraseDiag = diag.texte.includes("install.ps1") ? "le Diagnostic y ajoute la phrase « relancez install.ps1 » (workspace-non-verifie) pour la liste de la sonde" : "même phrase dans le Diagnostic";
    s.bilan.push(
      `attente git (A16 point 4) : raison « ${raison.slice(0, 90)}… » sur la page de la salle (${tabsSalle.join(" / ")} tabulation(s), 1440 / 400) ` +
        `et dans le Diagnostic (${tabsDiag.join(" / ")} tabulation(s)) ; ${phraseDiag} ; 409 git-inscriptible`,
    );
  } finally {
    await ctx.salle.pilote.regler({ nonProteges: [], relancer: true });
  }
  await attendreEtatSalle(ctx, "prete", 120_000);
}

/**
 * §5.5 : « focus visible et jamais volé ». L'écran d'activation ouvert, focus sur [Lancer comme Oh My OpenAgent], la page se
 * redessine parce qu'un événement de la salle arrive (ici, sa relance à neuf, qui fait relire son état) : le focus doit rester
 * où l'utilisateur l'a mis. Rien n'est envoyé (Échap à la fin).
 */
async function focusEcran(s) {
  const { ctx, page } = s;
  await changerMode(ctx, "avance");
  await sallePrete(s);
  await assurerConversation(s);
  await ouvrirEcranAuClavier(page, "Demande pour éprouver le focus");
  await tabuler(page, bouton(L.lancer, ".modal"), `[${L.lancer}]`, 12);
  const avant = (await statut(ctx)).dernierDemarrage?.startId ?? null;
  const debutReseau = page.journalReseau().length;
  await ctx.salle.pilote.regler({ relancer: true });
  await attendreQue(
    async () => {
      const lu = await statut(ctx);
      return lu.etatSalle === "prete" && (lu.dernierDemarrage?.startId ?? null) !== avant ? lu : false;
    },
    { delaiMs: 90_000, pasMs: 500, libelle: "salle relancée à neuf puis prête" },
  );
  await attendreQue(() => requetesPage(page, "GET", /\/api\/omo\/status$/, debutReseau).length > 0, { delaiMs: 15_000, libelle: "état de la salle relu par la page" });
  await attendre(1_500);
  const apres = await focus(page);
  await page.touche("Escape");
  await page.attendreQue("!document.querySelector('.modal')", { libelle: "écran fermé par Échap" });
  exiger(
    bouton(L.lancer, ".modal")(apres),
    `focus volé pendant l'écran d'activation : placé au clavier sur [${L.lancer}], retrouvé sur ${resume(apres)} après que la page a relu l'état de la salle (§5.5, « jamais volé »).`,
  );
}

/** Envoi d'une demande dans la salle PAR L'API (préparation) : IA de l'agent principal de la salle, confirmée ; 409 d'IA changée suivi. */
async function envoyerApi(ctx, rootId, directory) {
  const agents = await ctx.api.brut("GET", `/api/omo/oc/agent?directory=${encodeURIComponent(directory)}`);
  exiger(agents.code === 200, `GET /api/omo/oc/agent : ${agents.code} ${resume(agents.corps)}`);
  const principal = (a) => typeof a?.name === "string" && a.mode !== "subagent";
  const liste = JSON.parse(agents.corps);
  const agent = liste.find((a) => principal(a) && a.name === "build") ?? liste.find((a) => principal(a) && a.hidden !== true);
  const model = agent?.model?.providerID && agent?.model?.modelID ? { providerID: agent.model.providerID, modelID: agent.model.modelID } : null;
  const parts = [{ type: "text", text: "[synthétique] demande brève de la salle, revue ensuite en mode Simple" }];
  const chemin = `/api/omo/oc/session/${encodeURIComponent(rootId)}/prompt_async?directory=${encodeURIComponent(directory)}`;
  const confirmer = { entetes: { "x-cockpit-confirm": "1" } };
  let reponse = await ctx.api.brut("POST", chemin, { parts, ...(model ? { model } : {}) }, confirmer);
  const lu = reponse.corps ? JSON.parse(reponse.corps) : null;
  if (reponse.code === 409 && lu?.error === "assistant-model-changed" && lu?.model) {
    reponse = await ctx.api.brut("POST", chemin, { parts, model: lu.model, ...(lu.variant ? { variant: lu.variant } : {}) }, confirmer);
  }
  return reponse;
}

/**
 * « Revoir » en Simple d'une demande TERMINÉE de la salle (Q6 ; spécification §5.9 l.1018-1024, §6 l.1065 ; plan it3 D-3d-09,
 * D-3d-14, sortie de L3s-a) : étape 6 du témoin de la répétition générale « 3s », versée au dépôt. Une salle neuve est ouverte et
 * activée PAR L'API (préparation, jamais le parcours éprouvé), une demande brève part en Avancé et finit d'elle-même (repos, puis
 * fin de demande, D-2b-29). En Simple : pendant la demande, « Revoir » est refusé (« salle-demande-en-cours ») et /facts reste 403
 * (L18c) ; la demande finie, « Revoir » est permis (état, puis lecture 200 « terminée »), sans aucune requête aux deux instances,
 * et le zoom 1 liste la conversation avec [Revoir cette demande]. Défaut reproduit par cette étape avant sa correction : la salle
 * tient sa demande dans la ligne « omo » de conversation_autonomy (omo-activation.ts), jamais dans `autonomy_requests`, et
 * « Revoir » restait refusé (« salle-fin-inconnue ») après la fin de la demande.
 */
async function revoirSimple(s) {
  const { ctx, page } = s;
  // La page quitte la salle avant le passage en Simple : rien d'elle n'est éprouvé ici (API seule).
  await page.evaluer(`location.hash = "#/chat"`);
  await changerMode(ctx, "avance");
  await sallePrete(s);
  // Racine NEUVE : une seule demande, finie d'elle-même (jamais une racine dont une étape précédente a arrêté la demande).
  const ouverte = await ouvrirSalleApi(ctx);
  const rootId = ouverte.rootId;
  s.racines.add(rootId);
  const directory = `/workspace/${ouverte.projet ?? "projet-a"}`;
  await ctx.salle.pilote.tourParDefaut(TOUR_BREF);
  const activation = await activerApi(ctx, rootId);
  exiger(activation.code === 200, `activation par l'API : ${resume(activation)}`);
  const envoisAvant = (await envoisSalle(ctx, rootId)).length;
  const envoi = await envoyerApi(ctx, rootId, directory);
  exiger(envoi.code >= 200 && envoi.code < 300, `envoi en Avancé : ${envoi.code} ${resume(envoi.corps)}`);
  await attendreQue(async () => (await envoisSalle(ctx, rootId)).length === envoisAvant + 1, { delaiMs: 15_000, libelle: "message reçu par la salle factice" });

  await changerMode(ctx, "simple");
  const etatRevoir = async () => {
    const lu = await ctx.api.brut("GET", `/api/revoir/${encodeURIComponent(rootId)}?etat=1`);
    exiger(lu.code === 200, `GET /api/revoir/:rootId?etat=1 : ${lu.code} ${resume(lu.corps)}`);
    return JSON.parse(lu.corps);
  };
  const etatSalle = async () => {
    const lu = await ctx.api.brut("GET", "/api/omo/status");
    return lu.code === 200 ? (JSON.parse(lu.corps)?.etatSalle ?? "?") : `http ${lu.code}`;
  };
  const pendant = await etatRevoir();
  const facts = await ctx.api.brut("GET", `/api/conversations/${encodeURIComponent(rootId)}/facts`);

  // Fin de la demande : « Revoir » permis. Le suivi (raison du refus / état de la salle) est dit à l'échec, jamais un simple délai ;
  // la fin est attendue AVANT de juger le relevé fait pendant la demande, pour que l'échec dise les deux.
  const suivi = [];
  let dernier = null;
  let fin = null;
  try {
    await attendreQue(
      async () => {
        const etat = await etatRevoir();
        const cle = `${etat.acces === true ? "permis" : etat.raison}/${await etatSalle()}`;
        if (cle !== dernier) suivi.push(cle);
        dernier = cle;
        return etat.acces === true ? etat : false;
      },
      { delaiMs: 90_000, pasMs: 1_000, libelle: "demande de la salle terminée, « Revoir » permis en mode Simple" },
    );
  } catch (err) {
    fin = `${err?.message ?? err} ; suivi ${suivi.join(" → ")}`;
  }
  exiger(
    pendant.acces === false && pendant.raison === "salle-demande-en-cours" && pendant.instance === "omo",
    `Simple, demande en cours : ${resume(pendant)} (refus « salle-demande-en-cours » attendu) ; après la fin : ${fin ?? `permis (${suivi.join(" → ")})`}`,
  );
  exiger(facts.code === 403, `Simple : /facts ${facts.code} (403 attendu, L18c)`);
  exiger(fin === null, fin);

  // Lecture : 200, demande terminée, aucune requête à la salle ni à l'instance principale (rien n'est relancé ni facturé).
  const avantSalle = (await ctx.salle.pilote.requetes()).length;
  const avantPrincipale = (await ctx.opencodeRequests()).length;
  const lecture = await ctx.api.brut("GET", `/api/revoir/${encodeURIComponent(rootId)}`);
  await attendre(500);
  const versSalle = (await ctx.salle.pilote.requetes()).length - avantSalle;
  const versPrincipale = (await ctx.opencodeRequests()).length - avantPrincipale;
  exiger(lecture.code === 200, `Simple, demande terminée : « Revoir » ${lecture.code} ${resume(lecture.corps)}`);
  const vue = JSON.parse(lecture.corps);
  exiger(vue.instance === "omo" && vue.termine === true, `« Revoir » : ${resume({ instance: vue.instance, termine: vue.termine })}`);
  exiger(versSalle === 0 && versPrincipale === 0, `« Revoir » : ${versSalle} requête(s) à la salle, ${versPrincipale} à l'instance principale`);

  // Zoom 1 (D-3d-14) : en Simple, la conversation terminée de la salle est listée, avec [Revoir cette demande], sans compteur.
  const territoires = await ctx.api.get("/api/salle-controle/territoires");
  const conversation = (territoires.salle?.projets ?? []).flatMap((p) => p.conversations ?? []).find((c) => c.rootId === rootId);
  exiger(conversation?.revoir === true && conversation.travaillent === null, `zoom 1 en Simple : ${resume(territoires.salle)}`);
  await changerMode(ctx, "avance");
  s.bilan.push(
    `« Revoir » en Simple (Q6) : pendant la demande « ${pendant.raison} », /facts ${facts.code} ; ${suivi.join(" → ")} ; lecture ${lecture.code} ` +
      `(${Array.isArray(vue.facts) ? vue.facts.length : "?"} faits, terminée), 0 requête aux deux instances ; zoom 1 : conversation listée avec [Revoir]`,
  );
}

async function sansSalle(s) {
  const { ctx, page } = s;
  exigerConsole(s, "avant les redémarrages du cockpit");
  const avantRedemarrage = page.erreurs.length;
  const verifierAbsente = async (libelle, attendu) => {
    await page.aller(`${ctx.url}/`);
    await preparerPage(ctx);
    await changerMode(ctx, "avance");
    await attendreModeAffiche(page, "avance");
    const boot = await ctx.api.get("/api/bootstrap");
    exiger(boot.omo?.enabled === attendu.enabled && boot.omo?.imageChargee === attendu.imageChargee, `${libelle} : Bootstrap.omo ${resume(boot.omo)}`);
    const entrees = await textesDe(page, "nav.rail a.nav-item");
    exiger(!entrees.includes(L.entree), `${libelle} : entrée « ${L.entree} » présente en mode Avancé.`);
    await page.evaluer(`location.hash = "#/salle"`);
    await attendre(1_500);
    exiger(!(await page.evaluer("Boolean(document.querySelector('.omo-page'))")), `${libelle} : la page de la salle s'affiche par son adresse.`);
    await page.evaluer(`location.hash = "#/chat"`);
  };
  try {
    await ctx.salle.reconfigurer({ COCKPIT_OMO: "off" });
    // Image toujours déclarée : seule la coupure de COCKPIT_OMO retire l'entrée.
    await verifierAbsente("COCKPIT_OMO=off", { enabled: false, imageChargee: true });
    const coupee = await ctx.api.brut("GET", "/api/omo/status");
    exiger(coupee.code === 403 && JSON.parse(coupee.corps || "{}").error === "salle-coupee", `COCKPIT_OMO=off : GET /api/omo/status ${coupee.code} ${coupee.corps.slice(0, 120)}`);
    await ctx.salle.reconfigurer({ COCKPIT_OMO: "on", COCKPIT_OMO_IMAGE: "" });
    await verifierAbsente("sans image", { enabled: true, imageChargee: false });
  } finally {
    await ctx.salle.reconfigurer({ COCKPIT_OMO: "on", COCKPIT_OMO_IMAGE: ctx.salle.imageFactice });
  }
  await page.aller(`${ctx.url}/`);
  await preparerPage(ctx);
  s.consoleDepuis = page.erreurs.length;
  // Erreurs de la fenêtre des redémarrages : seulement des connexions refusées au cockpit arrêté (flux, amorçage), dites au bilan.
  const fenetre = page.erreurs.slice(avantRedemarrage, s.consoleDepuis);
  const autres = fenetre.filter((e) => !(String(e.url ?? "").startsWith(ctx.url) && /net::ERR_|Failed to load resource/.test(e.texte)));
  exiger(autres.length === 0, `console pendant les redémarrages du cockpit : ${resume(autres)}`);
  await changerMode(ctx, "avance");
  await attendreModeAffiche(page, "avance");
  const entrees = await textesDe(page, "nav.rail a.nav-item");
  exiger(entrees.includes(L.entree), "salle rétablie : entrée absente.");
  await attendreEtatSalle(ctx, "prete", 120_000);
  s.bilan.push(`sans salle : entrée absente avec COCKPIT_OMO=off (GET /api/omo/status 403) et sans image, rétablie ensuite ; ${fenetre.length} erreur(s) de connexion pendant les trois redémarrages`);
}

// --- Contrôles de tout le scénario -----------------------------------------------------------------------------------------------

/** Console muette depuis `s.consoleDepuis`, sauf le 409 d'activation provoqué exprès (route d'autonomie ET code 409). */
function exigerConsole(s, moment) {
  const toutes = s.page.erreurs.slice(s.consoleDepuis);
  const tolerees = toutes.filter((e) => ROUTE_AUTONOMIE.test(String(e.url ?? "")) && /\b409\b/.test(e.texte));
  const retenues = toutes.filter((e) => !tolerees.includes(e));
  exiger(retenues.length === 0, `${retenues.length} erreur(s) dans la console (${moment}) : ${retenues.map((e) => `${e.source} : ${e.texte}${e.url ? ` (${e.url})` : ""}`).join(" | ")}`);
  exiger(tolerees.length <= s.consoleToleree, `${tolerees.length} refus 409 d'activation dans la console, ${s.consoleToleree} provoqué(s) exprès.`);
}

/**
 * P6 et P11 : l'instance principale ne reçoit aucune requête sur une conversation de la salle (ses racines), ni configuration, ni
 * libération. Les dossiers projet-a et projet-b sont aussi des projets ordinaires du dossier de travail : l'instance principale
 * peut y lister ses propres conversations (page de chat), ce n'est pas la salle.
 */
async function exigerCloisonnement(s, depuis) {
  const principales = (await s.ctx.opencodeRequests()).slice(depuis);
  const racines = [...s.racines];
  s.bilan.push(racines.length > 0 ? `P11 : ${racines.length} racine(s) de la salle, aucune vue par l'instance principale` : "P11 : aucune racine de la salle ouverte, contrôle sans objet");
  const deLaSalle = principales.filter((r) => racines.some((id) => `${r.pathname} ${JSON.stringify(r.query ?? {})} ${JSON.stringify(r.body ?? null)}`.includes(id)));
  exiger(deLaSalle.length === 0, `P11 : l'instance principale a reçu ${deLaSalle.length} requête(s) sur une conversation de la salle (${resume(deLaSalle.map((r) => `${r.method} ${r.pathname}`))}).`);
  const p6 = principales.filter((r) => ["PATCH /global/config", "POST /global/dispose", "POST /instance/dispose"].includes(`${String(r.method).toUpperCase()} ${r.pathname}`));
  exiger(p6.length === 0, `P6 : ${p6.map((r) => `${r.method} ${r.pathname}`).join(", ")} reçu(s) par l'instance principale.`);
  const reponses = (await s.ctx.salle.pilote.requetes()).filter((r) => r.method === "POST" && /^\/permission\/[^/]+\/reply$/.test(r.pathname));
  const hors = reponses.filter((r) => r.body?.reply !== "once" && r.body?.reply !== "reject");
  exiger(hors.length === 0, `P4 : réponse « ${hors.map((r) => r.body?.reply).join(", ")} » envoyée à la salle.`);
}

/** Remet la salle et la page dans un état connu après une étape en échec : écran fermé, réglages de la sonde, salle prête. */
async function remettreEnEtat(s) {
  await s.page.touche("Escape").catch(() => {});
  await s.page.taille(LARGE).catch(() => {});
  await s.ctx.salle.pilote.regler({ nonProteges: [], limiteAtteinte: false, manifesteReference: "ok" });
  await changerMode(s.ctx, "avance");
  await sallePrete(s, 180_000);
}

const ETAPES = [
  ["prealables", prealables],
  ["simple", simple],
  ["entree", entree],
  ["projet-piege", projetPiege],
  ["activation", activation],
  ["fin-de-demande", finDeDemande],
  ["signales", signales],
  ["suspendue", suspendue],
  ["detection", detection],
  ["git-attente", gitAttente],
  ["focus-ecran", focusEcran],
  ["revoir-simple", revoirSimple],
  ["sans-salle", sansSalle],
];

/** Étapes demandées par E2E_OMO_ETAPES (rejeu isolé) ; toutes sinon. Les préalables sont toujours joués. */
function etapesChoisies() {
  const demandees = (process.env.E2E_OMO_ETAPES ?? "")
    .split(",")
    .map((nom) => nom.trim())
    .filter(Boolean);
  const connues = ETAPES.map(([nom]) => nom);
  const inconnues = demandees.filter((nom) => !connues.includes(nom));
  exiger(inconnues.length === 0, `E2E_OMO_ETAPES : étape(s) inconnue(s) ${inconnues.join(", ")} (connues : ${connues.join(", ")}).`);
  return demandees.length === 0 ? ETAPES : ETAPES.filter(([nom]) => nom === "prealables" || demandees.includes(nom));
}

export async function run(ctx) {
  exiger(ctx.salle, "ce scénario demande la pile de la salle : scripts/run-e2e.sh --faux --salle …");
  const etapes = etapesChoisies();
  const s = { ctx, page: ctx.navigateur, bilan: [], racines: new Set(), rootId: null, captures: 0, consoleToleree: 0, consoleDepuis: 0, volsDeFocus: 0, rebranchements: [] };
  const reperePrincipale = (await ctx.opencodeRequests()).length;
  const echecs = [];
  for (const [nom, etape] of etapes) {
    const debut = Date.now();
    try {
      await etape(s);
      console.log(`        étape ${nom} : ok (${Math.round((Date.now() - debut) / 1000)} s)`);
    } catch (err) {
      echecs.push(`${nom} : ${err?.message ?? err}`);
      console.error(`        étape ${nom} : ÉCHEC (${Math.round((Date.now() - debut) / 1000)} s) — ${err?.message ?? err}`);
      await s.page.capture(path.join(ctx.dossierCaptures, `omo-ui-salle-${nom}-echec.png`)).catch(() => {});
      if (nom === "prealables") break;
      await remettreEnEtat(s).catch((e) => console.error(`        remise en état après ${nom} : ${e?.message ?? e}`));
    }
  }
  try {
    await exigerCloisonnement(s, reperePrincipale);
    await exigerAucuneViolationCsp(s.page);
    exigerConsole(s, "fin du scénario");
  } catch (err) {
    echecs.push(`contrôles de fin : ${err?.message ?? err}`);
  } finally {
    await changerMode(ctx, "simple").catch(() => {});
  }
  const delais = s.rebranchements.filter((ms) => typeof ms === "number");
  const rebranche = delais.length > 0 ? `flux du cockpit rebranché sur la salle de ${Math.min(...delais)} à ${Math.max(...delais)} ms après chaque lancement (${delais.length} relevés)` : "aucun rebranchement relevé";
  releve(ctx, `${s.bilan.join(" ; ")} ; ${rebranche} ; ${s.captures} captures ; focus repris par la page ${s.volsDeFocus} fois avant [${L.lancer}]`);
  if (echecs.length > 0) throw new Error(`${echecs.length} étape(s) en échec sur ${etapes.length} : ${echecs.join(" || ")}`);
}
