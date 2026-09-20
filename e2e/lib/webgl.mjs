// Banc e2e de la salle de contrôle 3D (itération 3, paquet L35 ; plan it3 D-3d-18 ; mesures EXEC/mesures/MX-3D.md).
//
// TESTS DU NAVIGATEUR SANS PORTE DÉROBÉE (D-3d-18) : tout ce qui force un comportement 3D passe par une injection CDP
// (`Page.addScriptToEvaluateOnNewDocument`), JAMAIS par un paramètre, un réglage ou une variable du cockpit. Deux familles :
//   - CAUSES DE 2D (`simulerWebgl`) : refus du contexte demandé avec `failIfMajorPerformanceCaveat: true`, nom de moteur de
//     rendu logiciel ;
//   - MOTEUR SIMULÉ (`moteurSimule`) : `getContext("webgl2", options)` appelé sans `failIfMajorPerformanceCaveat`, nom
//     `UNMASKED_RENDERER_WEBGL` matériel fictif, et horloge de la sonde avancée de 12 ms par image pendant ses 90 images
//     (forme exacte mesurée en MX-3D §6 et §9.4 : horloge réelle jusqu'à la première image, puis dernière valeur + 12 ms,
//     figée entre deux rappels, retour à l'horloge réelle APRÈS le 90e rappel, décalée pour rester continue).
// Les injections sont posées AVANT le chargement du document : un scénario les installe, puis recharge la page.
//
// ENVOI BRUT (sans toucher `e2e/lib/cdp.mjs`, qui appartient à l'it4 et à l'it5) : `ouvrirCdp(ctx)` ouvre une seconde
// connexion au protocole du navigateur déjà lancé par le banc et s'attache à l'onglet du scénario (`flatten`). Le port de
// pilotage est celui que le navigateur écrit dans son profil (`DevToolsActivePort`), profil rangé par le banc à côté du
// dossier des captures (`ctx.dossierCaptures`) : rien n'est lu dans le dépôt, aucun secret n'est lu ni affiché.
// À la grande fusion, GF5 ramène la partie MÉDIA d'`emuler` (isolée dans la seule fonction `envoyerMedias`) à
// `onglet.medias` de l'it4 (L41), seule aide d'émulation de média du chantier.
import fs from "node:fs";
import path from "node:path";

/** Images forcées par la sonde de fluidité (server/shared/fluidity.ts, FLUIDITE.sonde.images). */
export const IMAGES_SONDE = 90;
/** Durée d'image rendue par l'horloge du « moteur simulé » : 12 ms, soit une sonde réussie et déterministe (MX-3D §6). */
export const PAS_HORLOGE_MS = 12;
/** Nom de moteur de rendu matériel fictif du « moteur simulé » (aucun des noms logiciels de `RENDUS_LOGICIELS`). */
export const MOTEUR_FICTIF = "ANGLE (Banc e2e, Carte fictive du banc Direct3D11 vs_5_0 ps_5_0, D3D11)";
/** Nom de moteur logiciel reconnu par la spécification (sous-chaîne, casse ignorée). */
export const MOTEUR_LOGICIEL = "ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero)), SwiftShader driver)";

/** Objet posé par les injections dans la page : drapeaux du banc et relevés. Jamais lu ni écrit par le cockpit. */
const OBJET = "__banc3d";

const attendre = (ms) => new Promise((r) => setTimeout(r, ms));

// --- Connexion brute au protocole du navigateur --------------------------------------------------------------------------------

/**
 * Port de pilotage du navigateur ouvert par le banc : lu dans `DevToolsActivePort`, que Chromium écrit dans son profil.
 * Le banc range ce profil dans le dossier de l'exécution, à côté des captures (docker-e2e.mjs : `profil-navigateur-<hex>`).
 */
export function portDevtools(dossierCaptures) {
  const dossier = path.dirname(String(dossierCaptures ?? ""));
  let entrees = [];
  try {
    entrees = fs.readdirSync(dossier);
  } catch {
    throw new Error(`dossier de l'exécution du banc illisible (${dossier}) : le protocole du navigateur reste introuvable.`);
  }
  for (const entree of entrees) {
    if (!entree.startsWith("profil-navigateur")) continue;
    try {
      const port = Number(fs.readFileSync(path.join(dossier, entree, "DevToolsActivePort"), "utf8").split("\n")[0]);
      if (Number.isInteger(port) && port > 0) return port;
    } catch {
      // Profil d'une exécution précédente, déjà effacé : on continue.
    }
  }
  throw new Error(`aucun profil de navigateur avec un port de pilotage dans ${dossier}.`);
}

/**
 * Seconde connexion au protocole, attachée à l'onglet du scénario. Rend l'envoi brut (`envoyer`), l'évaluation dans la page
 * (`evaluer`), l'écoute des événements de la session (`ecouter`) et sa fermeture. Deux sessions sur la même cible sont
 * prévues par le protocole (mode « flatten ») : celle du banc (cdp.mjs) n'est ni modifiée ni remplacée.
 */
export async function ouvrirCdp(ctx) {
  const port = portDevtools(ctx.dossierCaptures);
  const version = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json();
  const prise = new WebSocket(version.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    prise.addEventListener("open", resolve, { once: true });
    prise.addEventListener("error", () => reject(new Error("seconde connexion au navigateur refusée.")), { once: true });
  });
  let prochain = 0;
  const attentes = new Map();
  const ecouteurs = new Set();
  prise.addEventListener("message", (message) => {
    const bloc = JSON.parse(message.data);
    if (bloc.id !== undefined) {
      const attente = attentes.get(bloc.id);
      if (!attente) return;
      attentes.delete(bloc.id);
      if (bloc.error) attente.reject(new Error(`${bloc.error.message} (${attente.methode})`));
      else attente.resolve(bloc.result);
      return;
    }
    for (const ecouteur of ecouteurs) ecouteur(bloc);
  });
  const brut = (methode, params, sessionId) => {
    const id = ++prochain;
    const bloc = { id, method: methode, params: params ?? {} };
    if (sessionId) bloc.sessionId = sessionId;
    prise.send(JSON.stringify(bloc));
    return new Promise((resolve, reject) => attentes.set(id, { resolve, reject, methode }));
  };
  const { sessionId } = await brut("Target.attachToTarget", { targetId: ctx.navigateur.targetId, flatten: true });

  const cdp = {
    sessionId,
    cible: ctx.navigateur.targetId,
    envoyer: (methode, params = {}) => brut(methode, params, sessionId),
    ecouter(fn) {
      const filtre = (bloc) => {
        if (bloc.sessionId === sessionId) fn(bloc);
      };
      ecouteurs.add(filtre);
      return () => ecouteurs.delete(filtre);
    },
    /** Évalue une expression dans la page et rend sa valeur (promesses attendues). */
    async evaluer(expression) {
      const resultat = await cdp.envoyer("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
      if (resultat.exceptionDetails) {
        const details = resultat.exceptionDetails.exception?.description ?? resultat.exceptionDetails.text;
        throw new Error(`évaluation refusée (${expression.slice(0, 80)}) : ${details}`);
      }
      return resultat.result?.value;
    },
    /** Script joué avant CHAQUE document suivant (D-3d-18) ; rend son identifiant. */
    async injecter(source) {
      const { identifier } = await cdp.envoyer("Page.addScriptToEvaluateOnNewDocument", { source });
      return identifier;
    },
    async fermer() {
      try {
        await brut("Target.detachFromTarget", { sessionId });
      } catch {
        // Onglet déjà fermé par le banc : rien à détacher.
      }
      try {
        prise.close();
      } catch {
        // Prise déjà fermée.
      }
    },
  };
  await cdp.envoyer("Page.enable");
  await cdp.envoyer("Runtime.enable");
  return cdp;
}

// --- Injections de D-3d-18 -------------------------------------------------------------------------------------------------------

/** Socle commun des injections : l'objet du banc, posé avant tout script de la page. */
const SOCLE = `
  window.${OBJET} = window.${OBJET} || { refusCaveat: false, moteur: null, violations: [], sonde: null };
  (function () {
    const banc = window.${OBJET};
    if (banc.pose) return;
    banc.pose = true;
    // Le tampon des ressources est borné à 250 entrées : la preuve du morceau paresseux de three doit y rester.
    try { performance.setResourceTimingBufferSize(3000); } catch (e) {}
    const natif = HTMLCanvasElement.prototype.getContext;
    // Gardé tel quel : modeBanc mesure les capacités RÉELLES du poste, jamais celles que les injections simulent.
    banc.natif = natif;
    HTMLCanvasElement.prototype.getContext = function (type, options) {
      let choix = options;
      if (type === "webgl2" && banc.refusCaveat && options && options.failIfMajorPerformanceCaveat === true) return null;
      if (type === "webgl2" && banc.sansCaveat && options && options.failIfMajorPerformanceCaveat === true) {
        choix = Object.assign({}, options, { failIfMajorPerformanceCaveat: false });
        banc.drapeauxRetires = (banc.drapeauxRetires || 0) + 1;
      }
      const contexte = natif.call(this, type, choix);
      if (contexte !== null && type === "webgl2" && banc.moteur !== null) enveloppe(contexte);
      return contexte;
    };
    function enveloppe(contexte) {
      if (contexte.${OBJET}Vu) return;
      contexte.${OBJET}Vu = true;
      const lire = contexte.getParameter.bind(contexte);
      const extension = contexte.getExtension.bind(contexte);
      let masque = null;
      contexte.getExtension = function (nom) {
        const rendue = extension(nom);
        if (nom === "WEBGL_debug_renderer_info" && rendue) masque = rendue.UNMASKED_RENDERER_WEBGL;
        return rendue;
      };
      contexte.getParameter = function (parametre) {
        if (masque !== null && parametre === masque) return banc.moteur;
        return lire(parametre);
      };
    }
  })();
`;

/**
 * Compteurs d'objets WebGL vivants (MX-3D §9.2) : `renderer.info` ne voit pas les tampons d'instances, donc le contrôle de
 * mémoire de la spéc. l.1170 ajoute ces compteurs, tenus par des enveloppes des `create*` et `delete*` du contexte. Après la
 * libération : 0 tampon, 0 tableau de sommets, 0 programme ; 4 textures et 3 tampons d'image internes à three restent jusqu'à
 * la perte du contexte, qu'aucun `delete*` ne compte.
 */
const COMPTEURS_GL = `
  (function () {
    var banc = window.${OBJET};
    banc.gl = { tampon: 0, sommets: 0, programme: 0, texture: 0, image: 0, rendu: 0, nuanceur: 0 };
    var P = window.WebGL2RenderingContext && window.WebGL2RenderingContext.prototype;
    if (!P) return;
    var familles = [["tampon", "Buffer"], ["sommets", "VertexArray"], ["programme", "Program"], ["texture", "Texture"], ["image", "Framebuffer"], ["rendu", "Renderbuffer"], ["nuanceur", "Shader"]];
    familles.forEach(function (paire) {
      var cle = paire[0];
      var creer = P["create" + paire[1]];
      var detruire = P["delete" + paire[1]];
      if (typeof creer === "function") P["create" + paire[1]] = function () { var o = creer.apply(this, arguments); if (o) banc.gl[cle]++; return o; };
      if (typeof detruire === "function") P["delete" + paire[1]] = function (o) { if (o) banc.gl[cle]--; return detruire.apply(this, arguments); };
    });
  })();
`;

/** Écouteur des violations de la CSP, posé avant le premier script de la page (M3D-2, M25). */
const ECOUTEUR_CSP = `
  document.addEventListener("securitypolicyviolation", function (e) {
    window.${OBJET}.violations.push({ directive: e.violatedDirective, bloque: String(e.blockedURI).slice(0, 160) });
  });
`;

/**
 * Horloge de la sonde (MX-3D §6, §9.4) : `performance.now` est lue À L'APPEL par `sonder()` (L30). L'horloge réelle sert
 * jusqu'à la première image ; ensuite chaque rappel `requestAnimationFrame` avance l'horloge de 12 ms, valeur FIGÉE entre
 * deux rappels ; après le 90e rappel, retour à l'horloge réelle, décalée pour rester continue et croissante — sans attendre
 * un rappel suivant, que le rendu à la demande peut ne plus demander.
 */
const HORLOGE_SONDE = `
  (function () {
    const banc = window.${OBJET};
    const now = performance.now.bind(performance);
    const raf = window.requestAnimationFrame.bind(window);
    let images = 0;
    let valeur = null;
    let decalage = 0;
    banc.sonde = { images: () => images };
    performance.now = function () {
      if (valeur === null) return now() + decalage;
      return valeur;
    };
    window.requestAnimationFrame = function (rappel) {
      return raf(function (ms) {
        if (images < ${IMAGES_SONDE}) {
          images++;
          valeur = (valeur === null ? now() : valeur) + ${PAS_HORLOGE_MS};
          try {
            rappel(ms);
          } finally {
            if (images >= ${IMAGES_SONDE}) {
              decalage = valeur - now();
              valeur = null;
            }
          }
          return;
        }
        rappel(ms);
      });
    };
  })();
`;

/**
 * Causes de 2D (D-3d-18) : `refusCaveat` fait refuser le contexte webgl2 demandé avec `failIfMajorPerformanceCaveat: true`
 * (le cockpit le redemande alors sans le drapeau : « rendu-logiciel ») ; `moteur` remplace le nom lu par
 * `WEBGL_debug_renderer_info`. Les deux drapeaux restent réglables en cours de scénario par `reglerWebgl` : c'est le banc qui
 * les change, jamais le cockpit.
 */
export async function simulerWebgl(cdp, { refusCaveat = false, moteur = null } = {}) {
  await cdp.injecter(
    `${SOCLE}\n${COMPTEURS_GL}\n${ECOUTEUR_CSP}\nwindow.${OBJET}.refusCaveat = ${JSON.stringify(Boolean(refusCaveat))};\nwindow.${OBJET}.moteur = ${JSON.stringify(moteur)};`,
  );
}

/** Compteurs d'objets WebGL vivants relevés par l'injection (MX-3D §9.2). */
export async function compteursWebgl(cdp) {
  return (await cdp.evaluer(`JSON.parse(JSON.stringify((window.${OBJET} || {}).gl || {}))`)) ?? {};
}

/**
 * « Moteur simulé » (D-3d-18) : le drapeau `failIfMajorPerformanceCaveat` est retiré de chaque demande de contexte webgl2 (le
 * rendu logiciel du banc est donc accepté), le nom du moteur de rendu devient un nom matériel fictif, et l'horloge de la sonde
 * avance de 12 ms par image pendant ses 90 images. À n'installer que sur un banc SANS contexte matériel (M3D-1).
 */
export async function moteurSimule(cdp, { nom = MOTEUR_FICTIF } = {}) {
  await cdp.injecter(`${SOCLE}\n${COMPTEURS_GL}\n${ECOUTEUR_CSP}\nwindow.${OBJET}.sansCaveat = true;\nwindow.${OBJET}.moteur = ${JSON.stringify(nom)};\n${HORLOGE_SONDE}`);
}

/** Change un drapeau du banc dans la page chargée (aucun rechargement) : refus du contexte, nom du moteur. */
export async function reglerWebgl(cdp, reglages) {
  await cdp.evaluer(`Object.assign(window.${OBJET}, ${JSON.stringify(reglages)}), true`);
}

/** Violations de la CSP relevées par l'écouteur injecté (M25) : liste, dans l'ordre. */
export async function violationsCsp(cdp) {
  return (await cdp.evaluer(`JSON.parse(JSON.stringify((window.${OBJET} || {}).violations || []))`)) ?? [];
}

/**
 * Marques de performance d'un nom (`performance.getEntriesByName`) : instant et `detail` de chacune. `detail` n'entre pas dans
 * la sérialisation naturelle d'une entrée : il est recopié ici.
 */
export async function marques(cdp, nom) {
  return (
    (await cdp.evaluer(
      `performance.getEntriesByName(${JSON.stringify(nom)}).map(function (e) { return { t: e.startTime, detail: e.detail === undefined ? null : JSON.parse(JSON.stringify(e.detail)) }; })`,
    )) ?? []
  );
}

/** Efface les marques d'un nom : un scénario compte ce qui suit un instant précis, jamais ce que l'ouverture a laissé. */
export async function oublierMarques(cdp, ...noms) {
  for (const nom of noms) await cdp.evaluer(`performance.clearMarks(${JSON.stringify(nom)}), true`);
}

/**
 * Journal réseau du navigateur (`Network.requestWillBeSent`) sur la session brute : chaque requête partie de la page, avec sa
 * méthode et son adresse. `depuis()` rend un repère, `lignes(repere)` ce qui est parti après lui.
 */
export async function reseau(cdp) {
  const lignes = [];
  cdp.ecouter((bloc) => {
    if (bloc.method !== "Network.requestWillBeSent") return;
    lignes.push({ methode: bloc.params?.request?.method ?? "?", url: String(bloc.params?.request?.url ?? "") });
  });
  await cdp.envoyer("Network.enable");
  return {
    depuis: () => lignes.length,
    lignes: (repere = 0) => lignes.slice(repere).map((ligne) => ({ ...ligne })),
  };
}

/**
 * Ressources chargées par la page (`performance.getEntriesByType("resource")`) : adresse et taille décodée. Sert à prouver que
 * le MORCEAU PARESSEUX de three a réellement été chargé, donc exécuté (contrôle non vide de la fiche L35).
 */
export async function ressources(cdp) {
  return (
    (await cdp.evaluer(
      `performance.getEntriesByType("resource").map(function (e) { return { url: e.name, taille: e.decodedBodySize || 0 }; })`,
    )) ?? []
  );
}

/**
 * Émulation des réglages du poste par l'envoi brut : `Emulation.setEmulatedMedia` (thème, couleurs forcées, mouvement réduit,
 * dans un MÊME appel : le protocole remplace la liste entière à chaque envoi) et `Emulation.setEmulatedVisionDeficiency`.
 * `e2e/lib/cdp.mjs` n'est pas touché (it4 et it5 y travaillent) ; GF5 ramènera `envoyerMedias` à `onglet.medias` de l'it4.
 */
export async function emuler(cdp, { theme = "clair", mouvementReduit = false, couleursForcees = false, vision = null } = {}) {
  await envoyerMedias(cdp, [
    { name: "prefers-color-scheme", value: theme === "sombre" ? "dark" : "light" },
    { name: "prefers-reduced-motion", value: mouvementReduit ? "reduce" : "no-preference" },
    { name: "forced-colors", value: couleursForcees ? "active" : "none" },
  ]);
  if (vision !== null) await cdp.envoyer("Emulation.setEmulatedVisionDeficiency", { type: vision });
}

/** SEUL envoi de `Emulation.setEmulatedMedia` de ce module (point de reprise de GF5, plan it5 §2.8). */
async function envoyerMedias(cdp, features) {
  await cdp.envoyer("Emulation.setEmulatedMedia", { features });
}

// --- Mode 3D du banc (M3D-1, relu à CHAQUE exécution) ------------------------------------------------------------------------

/** Noms de moteurs de rendu sans carte graphique (server/shared/fluidity.ts, RENDUS_LOGICIELS). */
const RENDUS_LOGICIELS = ["swiftshader", "llvmpipe", "microsoft basic render"];

/**
 * Mode 3D du banc, mesuré DANS LA PAGE par le même chemin que `capacites()` (L30) : contexte webgl2 demandé avec puis sans
 * `failIfMajorPerformanceCaveat`, nom du moteur de rendu. Trois modes (fiche L35) :
 *   - « materiel » : aucune injection, la 3D du banc est la vraie ;
 *   - « logiciel » : `moteurSimule` est nécessaire pour que la 3D soit montée ;
 *   - « aucun » : aucun contexte webgl2 ; les contrôles 3D sont consignés « en attente », jamais comptés tenus.
 * À relire à chaque exécution : le résultat dépend du poste (MX-3D §1).
 */
export async function modeBanc(cdp) {
  const brut = await cdp.evaluer(`(function () {
    var banc = window.${OBJET} || {};
    var obtenir = typeof banc.natif === "function" ? banc.natif : HTMLCanvasElement.prototype.getContext;
    function essai(drapeau) {
      var c = document.createElement("canvas");
      var g = null;
      try { g = obtenir.call(c, "webgl2", { failIfMajorPerformanceCaveat: drapeau }); } catch (e) { g = null; }
      if (g === null) return { obtenu: false, moteur: null };
      var nom = null;
      try {
        var info = g.getExtension("WEBGL_debug_renderer_info");
        if (info) nom = g.getParameter(info.UNMASKED_RENDERER_WEBGL);
      } catch (e) { nom = null; }
      try { var perte = g.getExtension("WEBGL_lose_context"); if (perte) perte.loseContext(); } catch (e) {}
      return { obtenu: true, moteur: typeof nom === "string" ? nom : null };
    }
    var avec = essai(true);
    var sans = avec.obtenu ? avec : essai(false);
    return { avecDrapeau: avec.obtenu, webgl2: sans.obtenu, moteur: sans.moteur };
  })()`);
  const nom = (brut.moteur ?? "").toLowerCase();
  const logiciel = RENDUS_LOGICIELS.some((motif) => nom.includes(motif));
  let mode = "aucun";
  if (brut.webgl2) mode = brut.avecDrapeau && !logiciel ? "materiel" : "logiciel";
  return { ...brut, logiciel, mode };
}

/**
 * Prépare l'onglet d'un scénario it3 : injections de D-3d-18 selon le mode du banc, réglages du poste émulés (la 3D exige
 * `prefers-reduced-motion: no-preference` et `forced-colors: none`, que le poste du banc ne garantit pas), puis rechargement —
 * les injections ne valent que pour les documents SUIVANTS. Rend le contexte 3D du scénario.
 */
export async function preparer3d(ctx, { refusCaveat = false, moteur = null, mouvementReduit = false, couleursForcees = false, theme = "clair" } = {}) {
  const cdp = await ouvrirCdp(ctx);
  const journal = await reseau(cdp);
  await emuler(cdp, { theme, mouvementReduit, couleursForcees });
  const mode = await modeBanc(cdp);
  const simule = mode.mode === "logiciel" && !refusCaveat && moteur === null;
  if (simule) await moteurSimule(cdp);
  else await simulerWebgl(cdp, { refusCaveat, moteur });
  await ctx.navigateur.aller(`${ctx.url}/`);
  return { cdp, journal, mode, simule, attendue3d: mode.mode !== "aucun" && !refusCaveat && moteur === null && !mouvementReduit && !couleursForcees };
}

// --- Contrôles non vides (fiche L35) ---------------------------------------------------------------------------------------------

/** Taille à partir de laquelle un morceau paresseux est celui de three (M3D-3 : 568 540 octets bruts). */
export const TAILLE_MORCEAU_THREE = 200_000;

/**
 * Contrôle NON VIDE de la 3D : au moins une marque `salle3d:scene` (une image réellement rendue par le moteur three) ET le
 * morceau paresseux de three réellement chargé, donc exécuté. `avant` est la liste des adresses de ressources relevée avant
 * l'ouverture de la salle : le morceau de three est une ressource NOUVELLE et grosse. Sans ces deux preuves, un scénario
 * déclarerait « zéro violation » sur une page restée en 2D.
 */
export async function preuveTroisD(cdp, avant) {
  const connues = new Set(avant.map((r) => r.url));
  const nouvelles = (await ressources(cdp)).filter((r) => !connues.has(r.url) && /\.js(\?|$)/.test(r.url));
  const morceau = nouvelles.find((r) => r.taille >= TAILLE_MORCEAU_THREE) ?? null;
  const scenes = await marques(cdp, "salle3d:scene");
  return { morceau, scenes: scenes.length, causes: compterCauses(scenes) };
}

/** Compte les marques par `detail.cause` (M20, errata du train de V2 : seule la cause « plan » est bornée). */
export function compterCauses(liste) {
  const causes = {};
  for (const marque of liste) {
    const cause = marque.detail?.cause ?? "inconnue";
    causes[cause] = (causes[cause] ?? 0) + 1;
  }
  return causes;
}

/**
 * Plus grand nombre de marques dans une fenêtre glissante d'une seconde, et nombre de secondes de la période sans aucune
 * marque (M20). Les instants sont ceux de `performance.now()` de la page, en millisecondes.
 */
export function debitParSeconde(instants, { debut = null, fin = null } = {}) {
  const tries = [...instants].sort((a, b) => a - b);
  let max = 0;
  for (let i = 0; i < tries.length; i++) {
    let j = i;
    while (j < tries.length && tries[j] - tries[i] < 1_000) j++;
    max = Math.max(max, j - i);
  }
  const depart = debut ?? tries[0] ?? 0;
  const arrivee = fin ?? tries.at(-1) ?? depart;
  const secondes = Math.max(0, Math.floor((arrivee - depart) / 1_000));
  let vides = 0;
  for (let s = 0; s < secondes; s++) {
    const a = depart + s * 1_000;
    if (!tries.some((t) => t >= a && t < a + 1_000)) vides++;
  }
  return { max, total: tries.length, secondes, vides };
}

// --- Aides communes aux scénarios it3-* ------------------------------------------------------------------------------------------

/** Adresse de la salle de contrôle : zoom 1, zoom 2 (racine), zoom 3 (racine et session). */
export function adresseSalle(rootId = null, sessionId = null) {
  if (rootId === null) return "#/salle-controle";
  return sessionId === null ? `#/salle-controle/${rootId}` : `#/salle-controle/${rootId}/${sessionId}`;
}

/** Ouvre la salle de contrôle par l'adresse (comme un lien) et attend son titre. */
export async function ouvrirSalle(page, rootId = null, sessionId = null) {
  await page.evaluer(`location.hash = ${JSON.stringify(adresseSalle(rootId, sessionId))}`);
  await page.attendreQue("document.querySelector('.page.salle3d h1')", { libelle: "page de la salle de contrôle" });
}

/** Attend que la scène 3D soit montée (canevas) et qu'au moins une image ait été rendue (marque `salle3d:scene`). */
export async function attendreScene3d(page, { delaiMs = 30_000 } = {}) {
  await page.attendreQue("document.querySelector('.salle3d-canevas')", { delaiMs, libelle: "canevas de la scène 3D" });
  await page.attendreQue(`performance.getEntriesByName("salle3d:scene").length > 0`, { delaiMs, libelle: "image rendue par le moteur three" });
}

/** Attend l'affichage 2D (aucun canevas) : repli de la salle. */
export async function attendre2d(page, { delaiMs = 20_000 } = {}) {
  await page.attendreQue("!document.querySelector('.salle3d-canevas')", { delaiMs, libelle: "repli en 2D" });
}

/** Position du lecteur de « Revoir » montrée par la barre : moments « n / N », vitesse, badge. */
export async function positionLecteur(page, portee = ".revoir-bar") {
  return await page.evaluer(`(() => {
    const barre = document.querySelector(${JSON.stringify(portee)});
    if (!barre) return null;
    return {
      moments: (barre.querySelector(".revoir-moments")?.textContent ?? "").trim(),
      badge: (barre.querySelector(".revoir-badge")?.textContent ?? "").trim(),
      vitesse: barre.querySelector("select")?.value ?? "",
      curseur: barre.querySelector(".revoir-curseur")?.value ?? "",
    };
  })()`);
}

/** Attend, sans rien cliquer, que la page se pose (aucun changement du texte de `selecteur` pendant `calmeMs`). */
export async function attendreCalme(page, selecteur = ".page.salle3d", { calmeMs = 600, delaiMs = 15_000 } = {}) {
  const lire = async () => await page.evaluer(`(document.querySelector(${JSON.stringify(selecteur)})?.innerText ?? "").length`);
  const limite = Date.now() + delaiMs;
  let vu = await lire();
  let depuis = Date.now();
  while (Date.now() < limite) {
    await attendre(120);
    const maintenant = await lire();
    if (maintenant !== vu) {
      vu = maintenant;
      depuis = Date.now();
    } else if (Date.now() - depuis >= calmeMs) return vu;
  }
  return vu;
}

export { attendre };
