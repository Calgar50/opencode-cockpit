// Scénarios e2e des équipes (itération 4, paquet L41) : outils communs, et le scénario qui vérifie leurs préalables.
//
// Le banc lance chaque fichier « .mjs » de e2e/scenarios comme un scénario : ce module en est donc un aussi, sur le modèle
// d'it1-api-commun.mjs. Son run(ctx) vérifie ce sur quoi reposent les autres scénarios « it4-* » : routes d'équipes et de la
// carte montées, exemples au catalogue, équipes fermées en mode Simple dans le dépôt, et pilotage du faux (« quand: » et
// « config:global », ajoutés par L41 à e2e/fake-opencode-server.ts).
//
// Tout passe par l'API du cockpit (routes /api/teams, /api/team-runs, /api/agent-map, proxy /api/oc/*), jamais directement par
// opencode. Deux observations seulement viennent du banc : en « --faux », les requêtes reçues par le faux opencode et les tours
// qu'il joue ; en « --reel-hors-ligne », les requêtes reçues par le faux fournisseur (outils proposés à l'IA, sans texte).
//
// AUCUN appel facturé, AUCUN jeton Copilot : faux opencode, ou opencode 1.18.30 réel avec le faux fournisseur hors ligne.
import { attendre, attendreQue, changerMode, corpsJson, DOSSIER, exiger, releve, resume } from "./it1-api-commun.mjs";
import { attendreIa } from "./it1-ui-commun.mjs";

/** Dossier de travail des équipes du banc : la racine du workspace monté, d'où la confirmation « workspace » (P9). */
export const DOSSIER_EQUIPE = DOSSIER;

/** Exemples installables, tranchés par la question Q3 (réponse A11, option a) : aucun assistant nouveau en itération 4. */
export const EXEMPLES = ["revue-sql", "relecture-script"];

/** Étapes de « Revue SQL sur réplica » (trois avis indépendants puis la synthèse) et de « Chaîne de relecture de script ». */
export const ETAPES_AVIS = ["exactitude", "performance", "donnees-sensibles", "synthese"];
export const ETAPES_SUITE = ["standards", "securite", "exploitation-nuit", "consolidation"];

/** Demande écrite par l'utilisateur dans la saisie, recopiée telle quelle par le cockpit dans la conversation. */
export const DEMANDE = "Relis la requête de facturation du mois dernier.";

/**
 * Requêtes de fond du cockpit, qu'AUCUNE route d'équipe ne déclenche et qui tournent d'elles-mêmes dès que la pile est debout :
 * sondage des sessions (1.1 et runner, STEP_STATUS_POLL_MS) et rafraîchissement du catalogue d'IA (catalog.ts). Elles sont
 * écartées du compte d'un refus, comme dans les tests de croisement de la vague 2.
 * En revanche, les TROIS lectures du pré-lancement (GET /agent, GET /command, GET /global/config) ne sont JAMAIS écartées :
 * ce sont elles qu'un refus ne doit pas faire (A4, D-eq-17), et `sansRequete` échoue si l'une d'elles apparaît.
 */
const FOND = [
  ["GET", "/session/status"],
  ["GET", "/config/providers"],
];

/** Lectures que l'estimation fait et qu'un refus de lancement ne doit jamais faire (D-eq-17). */
export const LECTURES_ESTIMATION = ["/agent", "/command", "/global/config"];

const estDeFond = (requete) => FOND.some(([methode, chemin]) => requete.method === methode && requete.pathname === chemin);

/** Client des routes d'équipes et de la carte, toutes par l'API du cockpit. Les refus passent par `brut` (code et corps). */
export function equipes(ctx, directory = DOSSIER_EQUIPE) {
  const id = (valeur) => encodeURIComponent(valeur);
  return {
    ctx,
    directory,
    /** Agents servis par opencode dans ce dossier, lus par le proxy du cockpit. */
    agents: () => ctx.api.get(`/api/oc/agent?directory=${id(directory)}`),
    liste: () => ctx.api.get("/api/teams"),
    mettreAJourBrut: (equipe, corps) => ctx.api.brut("PUT", `/api/teams/${id(equipe)}`, corps),
    /** Aperçu de l'éditeur : problèmes du déroulé, sans rien écrire (la route la plus directe pour savoir ce que voit le serveur). */
    apercu: (flow) => ctx.api.post("/api/teams/preview", { flow }),
    installer: (exemple) => ctx.api.post(`/api/teams/examples/${id(exemple)}/install`, {}),
    installerBrut: (exemple) => ctx.api.brut("POST", `/api/teams/examples/${id(exemple)}/install`, {}),
    estimer: (equipe, rootId = null) => ctx.api.post(`/api/teams/${id(equipe)}/estimate`, { directory, rootId }),
    estimerBrut: (equipe, rootId = null) => ctx.api.brut("POST", `/api/teams/${id(equipe)}/estimate`, { directory, rootId }),
    lancerBrut: (equipe, corps) => ctx.api.brut("POST", `/api/teams/${id(equipe)}/run`, corps),
    vue: (runId) => ctx.api.get(`/api/team-runs/${id(runId)}`),
    deLaRacine: (rootId) => ctx.api.get(`/api/team-runs?rootId=${id(rootId)}`),
    deLaSession: (sessionId) => ctx.api.get(`/api/team-runs?sessionId=${id(sessionId)}`),
    continuerBrut: (runId, corps) => ctx.api.brut("POST", `/api/team-runs/${id(runId)}/continue`, corps ?? {}),
    arreterBrut: (runId) => ctx.api.brut("POST", `/api/team-runs/${id(runId)}/stop`, {}),
    estimerRelanceBrut: (runId) => ctx.api.brut("POST", `/api/team-runs/${id(runId)}/estimate`, {}),
    relancerBrut: (runId, corps) => ctx.api.brut("POST", `/api/team-runs/${id(runId)}/relancer`, corps ?? {}),
    carte: (element = null) => ctx.api.get(`/api/agent-map?directory=${id(directory)}${element === null ? "" : `&element=${id(element)}`}`),
    carteBrut: (requete) => ctx.api.brut("GET", `/api/agent-map?${requete}`),
  };
}

/** Corps de `POST /api/teams/:id/run`, complété par `patch` : un seul endroit où la forme du lancement est écrite. */
export function corpsLancement(estimation, patch = {}) {
  return {
    directory: DOSSIER_EQUIPE,
    rootId: null,
    demande: DEMANDE,
    fichiers: [],
    agentConversation: "build",
    estimateSha256: estimation?.estimateSha256 ?? "0".repeat(64),
    // Le dossier est la racine du workspace monté : P9 demande cette confirmation, accordée ici comme par la feuille.
    confirmations: { workspace: true },
    ...patch,
  };
}

/** Lancement accepté : 202 attendu, { runId, rootId } rendu. Tout autre code est une erreur du scénario, pas un refus attendu. */
export async function lancer(api, equipe, estimation, patch = {}) {
  const reponse = await api.lancerBrut(equipe, corpsLancement(estimation, patch));
  exiger(reponse.code === 202, `lancement de « ${equipe} » refusé (${reponse.code}) : ${resume(reponse.corps)}`);
  return corpsJson(reponse, "lancement");
}

/** Attend qu'un lancement satisfasse `predicat` ; rend sa vue. Le message d'échec dit l'état et celui de chaque étape. */
export async function attendreRun(api, runId, predicat, libelle, delaiMs = 60_000) {
  let derniere = null;
  try {
    return await attendreQue(
      async () => {
        derniere = await api.vue(runId);
        return predicat(derniere) ? derniere : false;
      },
      { delaiMs, pasMs: 150, libelle },
    );
  } catch (err) {
    const etapes = (derniere?.steps ?? []).map((step) => `${step.stepId}=${step.state}`).join(", ");
    throw new Error(`${libelle} : état « ${derniere?.state ?? "?"} », étapes ${etapes || "aucune"} (${err?.message ?? err})`);
  }
}

/** Sessions d'étape d'un lancement, dans l'ordre des étapes, avec leur identifiant de session quand il existe. */
export const sessionsDEtape = (vue) => vue.steps.filter((step) => step.sessionId !== null).map((step) => ({ stepId: step.stepId, sessionId: step.sessionId }));

// --- Pilotage du faux opencode (routes de e2e/fake-opencode-server.ts, jeton du banc) -------------------------------------------

/** Tours joués par toute session d'étape créée ENSUITE pour `stepId` (scriptWhen, « quand:etape= »). */
export const scripterEtape = (ctx, stepId, ...tours) => ctx.faux.scripter(`quand:etape=${stepId}`, ...tours);

/**
 * Fusionne `fusion` dans la configuration globale rendue par `GET /global/config` (« config:global »). Le pré-lancement la lit à
 * l'estimation (D-eq-17) : c'est ainsi qu'un scénario fait apparaître une extension (`mcp`, `plugin`) avant ou après elle. Le
 * cockpit n'écrit jamais cette configuration (P6) : le changement vient du banc, comme s'il venait de l'utilisateur.
 */
export const configGlobale = (ctx, fusion) => ctx.faux.scripter("config:global", fusion);

/** Extension configurée dans opencode : refus `extension-configuree` à l'estimation, pause « À vérifier » après elle. */
export const MCP = { mcp: { local: { type: "local", command: ["outil"], enabled: true } } };

// --- Zéro requête pendant un refus (A4, D-eq-17) --------------------------------------------------------------------------------

/** Repère dans le journal du faux : longueur courante de la liste des requêtes reçues. */
export const repere = async (ctx) => (await ctx.opencodeRequests()).length;

/** Requêtes reçues par le faux depuis `debut`, hors requêtes de fond ; méthode, chemin et paramètres seulement. */
export async function requetesDepuis(ctx, debut) {
  return (await ctx.opencodeRequests())
    .slice(debut)
    .filter((requete) => !estDeFond(requete))
    .map((requete) => ({ method: requete.method, pathname: requete.pathname }));
}

/**
 * Exécute `appel` et exige que le faux opencode n'ait reçu AUCUNE requête pendant — journal complet, toutes méthodes, tous
 * chemins (spécification §7.8 l.1189 : « aucun refus de pré-lancement n'émet de requête »). Rend la réponse brute.
 * Les requêtes de fond du cockpit sont écartées (FOND) ; les trois lectures de l'estimation ne le sont jamais.
 */
/**
 * Attend que le faux opencode ne reçoive plus rien pendant `calmeMs` : le cockpit et la page lisent d'eux-mêmes
 * (`GET /api/bootstrap` relit `GET /global/config` après un changement de réglage, le sondage des sessions tourne…).
 * Mesurer un refus dans un moment calme évite de compter une lecture qu'aucune route d'équipe n'a déclenchée.
 */
export async function attendreCalme(ctx, { calmeMs = 800, delaiMs = 20_000 } = {}) {
  const limite = Date.now() + delaiMs;
  let longueur = await repere(ctx);
  let depuis = Date.now();
  while (Date.now() < limite) {
    await attendre(150);
    const n = await repere(ctx);
    if (n !== longueur) {
      longueur = n;
      depuis = Date.now();
    } else if (Date.now() - depuis >= calmeMs) return n;
  }
  throw new Error(`le faux opencode reçoit encore des requêtes après ${Math.round(delaiMs / 1000)} s : aucun moment calme pour mesurer un refus.`);
}

export async function sansRequete(ctx, libelle, appel) {
  await attendreCalme(ctx);
  const debut = await repere(ctx);
  const reponse = await appel();
  // Le faux enregistre une requête à sa réception : une requête partie juste avant la réponse est déjà dans le journal, et un
  // court délai laisse arriver celles qu'un gestionnaire aurait lancées sans les attendre.
  await attendre(150);
  const emises = await requetesDepuis(ctx, debut);
  exiger(emises.length === 0, `${libelle} : ${emises.length} requête(s) émise(s) pendant un refus — ${emises.map((r) => `${r.method} ${r.pathname}`).join(", ")}`);
  return reponse;
}

/** Exige un refus : code HTTP et code d'erreur du corps, sans aucune requête pendant l'appel. Rend le corps lu. */
export async function refusSansRequete(ctx, libelle, appel, attendu) {
  const reponse = await sansRequete(ctx, libelle, appel);
  const corps = corpsJson(reponse, libelle);
  exiger(reponse.code === attendu.code, `${libelle} : code ${reponse.code} au lieu de ${attendu.code} (${corps.error ?? "?"})`);
  if (attendu.erreur !== undefined) exiger(corps.error === attendu.erreur, `${libelle} : erreur « ${corps.error} » au lieu de « ${attendu.erreur} »`);
  // Honnêteté §6 l.1037 : un refus de lancement le dit toujours.
  exiger(typeof corps.message === "string" && corps.message.length > 0, `${libelle} : refus sans phrase.`);
  return corps;
}

// --- Préparation commune --------------------------------------------------------------------------------------------------------

/**
 * Exécute `fn` en mode Avancé, puis revient au mode d'avant (le mode Simple est le défaut, et les scénarios partagent la pile).
 * Les équipes sont complètes en Avancé seulement tant qu'`EQUIPES_SIMPLE_OUVERTES` est faux (U1, D-eq-13).
 */
export async function enAvance(ctx, fn) {
  const avant = await changerMode(ctx, "avance");
  try {
    return await fn();
  } finally {
    await changerMode(ctx, avant === "avance" ? "avance" : "simple");
  }
}

/**
 * Le faux opencode ne servait pas `GET /skill` : l'installation d'un exemple d'équipe installe l'assistant du catalogue, qui
 * installe sa FICHE ; le Studio vérifie l'écriture par `GET /skill` (studio.ts, VERIFY_ROUTE.skills) et le faux répondait 404
 * « Route inconnue ». CORRIGÉ par le train de la vague 4 (défaut D5, arbitrage A13) : le faux sert la route. Le motif reste,
 * pour qu'une pile bâtie sur une image plus ancienne se rabatte encore sur le dépôt de l'équipe au lieu de s'arrêter.
 */
const DEFAUT_SKILL = /Route inconnue du faux opencode\s*:\s*GET \/skill/;

/**
 * `POST /api/teams/examples/:id/install` rendait **500 « Erreur interne du cockpit »** quand le catalogue d'IA n'est pas chargé,
 * au lieu du refus que `AssistantService.install` prévoit. CORRIGÉ par le train de la vague 4 (défaut D3, arbitrage A13) : le
 * refus du service est rendu tel quel. Le motif du 500 reste par prudence (image plus ancienne).
 */
const DEFAUT_CATALOGUE = /"error":"internal"/;

/**
 * Refus PROPRES de l'installation, que le banc doit savoir contourner sans s'arrêter : le catalogue d'IA n'est pas chargé
 * (409 `catalogue-indisponible`, systématique en « --reel-hors-ligne », où le banc n'a pas Internet) ou aucune IA du niveau
 * demandé n'est disponible sur le compte (422 `ia-indisponible`, le faux fournisseur hors ligne n'en offrant aucune). Ce ne
 * sont pas des défauts : c'est le refus que la spécification demande. L'équipe est alors posée par `PUT /api/teams/:id` à
 * partir du déroulé de l'exemple, et le reste du parcours est celui du produit.
 */
const REFUS_PROPRES = /"error":"(catalogue-indisponible|ia-indisponible)"/;

/** Cause connue d'un refus d'installation d'exemple, ou null quand le banc ne la reconnaît pas (le scénario s'arrête alors). */
function causeConnue(corps) {
  if (DEFAUT_SKILL.test(corps)) return "faux sans « GET /skill »";
  if (DEFAUT_CATALOGUE.test(corps)) return "catalogue d'IA indisponible (500)";
  const propre = REFUS_PROPRES.exec(corps);
  if (propre) return `refus propre de l'installation (${propre[1]})`;
  return null;
}

/**
 * Exemples dont l'installation a buté sur DEFAUT_SKILL pendant cette exécution : elle n'est plus retentée.
 * Une seconde tentative réussirait parfois à moitié (la fiche a été écrite avant l'échec de sa vérification) et POSERAIT
 * L'ASSISTANT SOUS UN AUTRE NOM (« relire-requete-sql-2 », `uniqueName`), puisque le banc a déjà déclaré le premier au
 * faux : le déroulé de l'équipe ne correspondrait plus à ce que le faux sert. Une mémoire par exécution suffit.
 */
const INSTALLATION_CASSEE = new Set();

/**
 * Installe un exemple si l'équipe n'est pas déjà là (l'installation est idempotente, mais elle recharge opencode : les scénarios
 * qui se suivent sur la même pile n'ont aucune raison de la refaire). Rend l'équipe installée, ses assistants déclarés au faux.
 *
 * Repli quand le banc bute sur DEFAUT_SKILL : l'équipe est posée par `PUT /api/teams/:id` à partir du DÉROULÉ DE L'EXEMPLE,
 * et ses assistants sont déclarés au faux. Le déroulé, les assistants, les droits et tout le reste du parcours sont ceux de
 * l'exemple : seule l'écriture du fichier de la fiche manque. Le repli est CONSIGNÉ à chaque exécution.
 */
export async function installerExemple(api, exemple) {
  const liste = await api.liste();
  const connue = liste.teams.find((equipe) => equipe.id === exemple);
  if (connue) {
    await declarerAssistants(api, connue.flow);
    return connue;
  }
  const modele = liste.exemples.find((candidat) => candidat.id === exemple);
  exiger(modele !== undefined, `exemple « ${exemple} » absent du catalogue : ${resume(liste.exemples?.map((e) => e.id))}`);

  if (!INSTALLATION_CASSEE.has(exemple)) {
    // La garde de rechargement refuse l'installation pendant une réponse en cours : les scénarios partagent la pile, et
    // un travail délégué laissé par un scénario précédent tient parfois une session occupée plusieurs dizaines de
    // secondes. C'est une attente, pas un refus : le banc réessaie, puis se rabat sur le dépôt de l'équipe.
    let pose = await api.installerBrut(exemple);
    for (let essai = 0; essai < 12 && pose.code === 409 && pose.corps.includes("sessions-busy"); essai++) {
      await attendre(5_000);
      pose = await api.installerBrut(exemple);
    }
    if (pose.code === 200) {
      const equipe = corpsJson(pose, `installation de « ${exemple} »`).team;
      await declarerAssistants(api, equipe.flow);
      return equipe;
    }
    const connu = causeConnue(pose.corps);
    exiger(connu !== null || pose.corps.includes("sessions-busy"), `installation de « ${exemple} » refusée (${pose.code}) : ${resume(pose.corps, 400)}`);
    if (connu !== null) INSTALLATION_CASSEE.add(exemple);
    releve(
      api.ctx,
      `Repli du banc : l'installation de l'exemple « ${exemple} » est refusée en ${pose.code} (${connu ?? "sessions occupées"}) ; ` +
        "l'équipe est posée par PUT à partir du déroulé de l'exemple, avec les mêmes étapes et les mêmes assistants.",
    );
  }
  await declarerAssistants(api, modele.flow);
  return await ctxPut(api, exemple, { titre: modele.titre, description: modele.description ?? "", flow: modele.flow });
}

/** Boucle de rendu de React (« Minified React error #185 » : profondeur de mise à jour dépassée). */
const BOUCLE_REACT = /React error #185|Maximum update depth/i;

/**
 * DÉFAUT PRODUIT, reproduit et remis à l'intégrateur (jamais corrigé ici, plan it4 §2.7 : ce paquet n'écrit ni dans
 * `app/server/**` ni dans `app/web/**`).
 */
const DEFAUT_BOUCLE =
  "DÉFAUT PRODUIT (HAUT) : ouvrir une conversation vide la page (React #185, boucle de rendu). " +
  "`useTeamRuns` (app/web/pages/chat/team/useTeamRuns.ts, L38b) passe à `useSyncExternalStore` un `subscribe` et un " +
  "`getSnapshot` CRÉÉS À CHAQUE RENDU : React se réabonne donc à chaque rendu, le dernier désabonnement vide l'entrée du " +
  "cache (`#liberer`) et le réabonnement la recrée avec un NOUVEL objet d'état ({ runs: [], chargement: true }), donc un " +
  "instantané différent, donc un nouveau rendu, sans fin. Le banc l'a vérifié : mémoriser les deux fonctions " +
  "(`useCallback([rootId])`) rend `it1-ui-arreter` et les scénarios de chat verts. Touche TOUTE conversation ouverte dans " +
  "le chat, dans les deux modes, et casse aussi les scénarios e2e de l'itération 1.";

/**
 * Ouvre une conversation dans la page par son adresse (#/chat/<id>), et attend le fil.
 *
 * Volontairement plus souple qu'`ouvrirConversation` d'it1 : une conversation OUVERTE PAR UNE ÉQUIPE n'a pas encore de
 * titre classé quand la page l'affiche, et attendre un titre autre que « Nouvelle conversation » ferait attendre en vain.
 */
export async function ouvrirLaConversation(ctx, rootId) {
  const page = ctx.navigateur;
  await page.evaluer(`location.hash = ${JSON.stringify(`#/chat/${rootId}`)}`);
  try {
    await page.attendreQue("document.querySelector('.chat-thread')", { delaiMs: 25_000, libelle: `conversation ${rootId} ouverte` });
  } catch (err) {
    // Un échec ici est un DÉFAUT de la page, pas un aléa du banc : le rapport porte son état et les erreurs de console.
    const etat = await page.evaluer(`(() => ({
      adresse: location.hash,
      corps: (document.body?.textContent ?? "").replace(/\\s+/g, " ").trim().slice(0, 200),
      racines: [...document.body.children].map((e) => e.tagName.toLowerCase() + "." + (e.className || "")).slice(0, 5),
      rail: Boolean(document.querySelector("nav.rail")),
      accueil: Boolean(document.querySelector(".welcome, .empty")),
    }))()`).catch((autre) => ({ erreur: String(autre?.message ?? autre) }));
    const erreursConsole = page.erreurs.map((e) => `${e.source} : ${e.texte}`);
    if (erreursConsole.some((texte) => BOUCLE_REACT.test(texte))) throw new Error(`${err?.message ?? err} — ${DEFAUT_BOUCLE}`);
    throw new Error(`${err?.message ?? err} — page : ${resume(etat, 400)} ; console : ${resume(erreursConsole.slice(0, 5), 600)}`);
  }
}

/**
 * Quitte l'éditeur guidé pour `adresse` : un brouillon modifié pose une garde de navigation (spéc. §5.5), qui demande
 * « Quitter sans enregistrer l'équipe ? ». Le banc répond [Quitter], comme l'utilisateur qui abandonne son brouillon.
 */
export async function quitterEditeur(ctx, adresse) {
  const page = ctx.navigateur;
  await page.evaluer(`location.hash = ${JSON.stringify(adresse)}`);
  const clic = `(() => {
    const bouton = [...document.querySelectorAll(".modal button")].find((b) => b.textContent.trim() === "Quitter");
    if (!bouton) return false;
    bouton.click();
    return true;
  })()`;
  const limite = Date.now() + 5_000;
  while (Date.now() < limite) {
    if (await page.evaluer(`location.hash === ${JSON.stringify(adresse)} && !document.querySelector(".tm-ed")`)) return;
    await page.evaluer(clic);
    await attendre(150);
  }
  throw new Error(`l'éditeur guidé ne se quitte pas vers « ${adresse} » (garde de navigation restée ouverte).`);
}

/** Règles d'un assistant du catalogue en lecture seule, telles qu'opencode les rend à `GET /agent` (lire, chercher, lister). */
const REGLES_LECTURE_SEULE = [
  { permission: "*", pattern: "*", action: "deny" },
  { permission: "read", pattern: "*", action: "allow" },
  { permission: "grep", pattern: "*", action: "allow" },
  { permission: "glob", pattern: "*", action: "allow" },
];

/**
 * Déclare au FAUX opencode les assistants d'un déroulé qu'il ne connaît pas encore.
 *
 * Le faux ne lit pas les fichiers d'agents que le Studio écrit : sans cette déclaration, `GET /agent` ignorerait l'assistant
 * qu'une installation d'exemple vient de poser, et le pré-lancement refuserait l'équipe comme invalide. Les tests
 * d'intégration font exactement de même (`h.fake.setAgents`, croisements de la vague 2). L'IA et la réflexion sont celles de
 * l'agent « build » servi par le banc, pour rester dans les fournisseurs autorisés de la pile.
 * En mode réel hors ligne, le vrai opencode lit ces fichiers : il n'y a rien à déclarer.
 */
export async function declarerAssistants(api, flow) {
  const voulus = [...new Set(etapesAvecAssistant(flow).map((etape) => etape.assistant))];
  const connus = await api.agents();
  const noms = new Set(connus.map((agent) => agent.name));
  const manquants = voulus.filter((nom) => !noms.has(nom));
  if (manquants.length === 0) return [];
  // Mode réel : le vrai opencode lit les fichiers d'agents. L'assistant manquant est écrit par le STUDIO du cockpit, en
  // lecture seule, comme un utilisateur le ferait — l'installation depuis le catalogue, elle, demande Internet (catalogue
  // d'IA), que le banc hors ligne n'a pas.
  if (api.ctx.mode !== "faux") return await ecrireAssistantsParLeStudio(api, manquants);
  // L'IA de l'assistant est celle du banc (fournisseur autorisé de la pile) : sans `model`, l'étape n'a aucune IA
  // disponible et la grammaire refuse l'équipe (« niveau-indisponible »). Les agents natifs du faux n'en portent pas.
  // Elle est ATTENDUE au catalogue, jamais lue d'un coup : sur une pile neuve, le premier scénario de la famille arrive
  // avant le premier rafraîchissement du catalogue d'IA (catalog.ts) et lirait un bootstrap sans IA — vu le 20/09 avec
  // it4-arret en tête de pile. C'est l'attente bornée que la famille it1 fait déjà (it1-ui-commun.mjs, essai du 19/09).
  const ia = await attendreIa(api.ctx);
  const ajouts = manquants.map((name) => ({
    name,
    mode: "all",
    description: `Assistant « ${name} » du catalogue, déclaré au faux opencode par le banc.`,
    model: { providerID: ia.providerID, modelID: ia.modelID },
    options: {},
    permission: REGLES_LECTURE_SEULE,
    steps: 20,
  }));
  await api.ctx.faux.scripter("agents:defaut", ...connus, ...ajouts);
  await attendreAssistantsVus(api, flow, manquants);
  return manquants;
}

/**
 * Attend que le SERVEUR voie les assistants déclarés. Le cockpit garde `GET /agent` et `GET /command` en cache 15 s
 * (`LOOKUP_TTL_MS`) : sans cette attente, l'équipe posée juste après serait refusée en 422 « assistant-absent », alors que
 * le faux les sert déjà. L'aperçu de l'éditeur (`POST /api/teams/preview`) dit exactement ce que le serveur voit, sans
 * rien écrire.
 */
async function attendreAssistantsVus(api, flow, manquants) {
  const aveugles = new Set(["assistant-absent", "niveau-indisponible"]);
  await attendreQue(
    async () => {
      const apercu = await api.apercu(flow);
      const restes = (apercu?.problems ?? []).filter((probleme) => aveugles.has(probleme.code));
      return restes.length === 0;
    },
    { delaiMs: 40_000, pasMs: 1_000, libelle: `assistants ${manquants.join(", ")} vus par le cockpit (cache GET /agent)` },
  );
}

/**
 * Écrit par le STUDIO du cockpit (`PUT /api/studio/agents/:nom`) les assistants manquants d'un déroulé, en lecture seule :
 * un fichier d'agent que le VRAI opencode relira. C'est le chemin du mode « --reel-hors-ligne », où l'installation depuis
 * le catalogue est impossible (catalogue d'IA hors ligne). Attend que `GET /agent` les serve.
 */
async function ecrireAssistantsParLeStudio(api, manquants) {
  // Même attente bornée qu'en mode « --faux » : l'IA du banc (fournisseur `banc`) vient des fournisseurs qu'opencode annonce.
  const ia = await attendreIa(api.ctx);
  for (const nom of manquants) {
    const reponse = await api.ctx.api.brut("PUT", `/api/studio/agents/${encodeURIComponent(nom)}`, {
      frontmatter: {
        description: `Assistant de relecture en lecture seule, écrit par le banc e2e pour l'étape « ${nom} ».`,
        mode: "all",
        model: `${ia.providerID}/${ia.modelID}`,
        steps: 20,
        permission: { "*": "deny", read: "allow", grep: "allow", glob: "allow" },
      },
      body: "Tu relis et tu rends un avis court. Tu ne modifies rien et tu ne lances aucune commande.\n",
    });
    exiger(reponse.code === 200, `écriture de l'assistant « ${nom} » par le Studio refusée (${reponse.code}) : ${resume(reponse.corps, 300)}`);
  }
  await attendreQue(
    async () => {
      const servis = new Set((await api.agents()).map((agent) => agent.name));
      return manquants.every((nom) => servis.has(nom));
    },
    { delaiMs: 60_000, pasMs: 1_000, libelle: `assistants ${manquants.join(", ")} servis par opencode` },
  );
  return manquants;
}

/** Étapes d'un déroulé avec leur assistant (les avis avant leur synthèse). */
function etapesAvecAssistant(flow) {
  return flow.blocs.flatMap((bloc) => {
    if (bloc.type === "etape") return [bloc.etape];
    if (bloc.type === "avis") return [...bloc.avis, bloc.synthese];
    return [];
  });
}

/**
 * Équipe PROPRE À UN SCÉNARIO, dérivée d'un exemple : même déroulé, mêmes assistants, mais chaque identifiant d'étape et de
 * bloc porte un suffixe.
 *
 * Pourquoi : les scénarios partagent UNE pile, donc UN faux opencode, et un script posé par prédicat (« quand:etape= ») vaut
 * pour toute session créée ENSUITE, y compris celles d'un autre scénario. Des identifiants propres évitent qu'un scénario
 * joue les tours d'un autre. Les deux scénarios qui éprouvent les exemples EUX-MÊMES (it4-avis sur « revue-sql »,
 * it4-pause sur « relecture-script ») les lancent tels quels ; les autres passent par ici.
 *
 * Le suffixe reste court : un identifiant d'étape tient en 24 caractères (STEP_ID_RE).
 */
export async function equipeDerivee(api, exemple, suffixe) {
  const source = await installerExemple(api, exemple);
  const renomme = (etape) => ({ ...etape, id: `${etape.id}-${suffixe}` });
  const flow = {
    version: source.flow.version,
    blocs: source.flow.blocs.map((bloc) => {
      const id = `${bloc.id}-${suffixe}`;
      if (bloc.type === "etape") return { type: "etape", id, etape: renomme(bloc.etape) };
      if (bloc.type === "avis") return { type: "avis", id, avis: bloc.avis.map(renomme), synthese: renomme(bloc.synthese) };
      return { type: "pause", id, message: bloc.message };
    }),
  };
  const equipeId = `${exemple}-${suffixe}`;
  const vue = await ctxPut(api, equipeId, { titre: `${source.titre} (${suffixe})`.slice(0, 80), description: source.description ?? "", flow });
  return { id: equipeId, flow, titre: vue.titre };
}

/** PUT /api/teams/:id, avec un message d'échec qui porte les problèmes du déroulé quand il y en a. */
async function ctxPut(api, equipeId, corps) {
  const reponse = await api.mettreAJourBrut(equipeId, corps);
  exiger(reponse.code === 200, `équipe « ${equipeId} » refusée (${reponse.code}) : ${resume(reponse.corps, 400)}`);
  return corpsJson(reponse, `équipe « ${equipeId} »`);
}

/** Étapes d'un déroulé, dans l'ordre des blocs (les avis avant leur synthèse) : identifiants tels que le faux les verra. */
export const etapesDuFlow = (flow) => etapesAvecAssistant(flow).map((etape) => etape.id);

/** Estime puis lance une équipe déjà installée (exemple ou équipe dérivée) ; rend { estimation, runId, rootId }. */
export async function estimerEtLancer(api, equipeId, { patch = {}, rootId = null } = {}) {
  const estimation = await api.estimer(equipeId, rootId);
  exiger(estimation.blocage == null, `estimation de « ${equipeId} » bloquée : ${resume(estimation.blocage)}`);
  const demarre = await lancer(api, equipeId, estimation, { rootId, ...patch });
  return { estimation, runId: demarre.runId, rootId: demarre.rootId };
}

/** Installe l'exemple, estime, lance, et rend { api, equipe, estimation, runId, rootId }. */
export async function lancerExemple(ctx, exemple, options = {}) {
  const api = equipes(ctx);
  const equipe = await installerExemple(api, exemple);
  return { api, equipe, ...(await estimerEtLancer(api, exemple, options)) };
}

/**
 * Appel du cockpit AVEC l'en-tête de confirmation (`x-cockpit-confirm: 1`), fait DEPUIS LA PAGE, comme l'interface au clic.
 *
 * Pourquoi la page : le client d'API du banc (e2e/lib/cockpit.mjs, propriété du paquet L7a) n'a aucun moyen de poser cet
 * en-tête, et certaines routes le REFUSENT sans lui — `POST /api/ai/realign` rend 428 « confirmation-requise » AVANT toute
 * autre vérification, donc avant la garde de rechargement qu'on veut éprouver. La page, elle, est déjà connectée par le
 * cookie de session ouvert par le banc, parle à SA PROPRE ORIGINE (le HTTPS épinglé du banc, jamais un transport à part)
 * et pose l'en-tête anti-CSRF comme l'interface. Le banc, lui, ne parle jamais au cockpit hors de son transport.
 * Rend { code, corps }, comme `ctx.api.brut`.
 */
export async function appelConfirme(ctx, methode, chemin, corps = {}) {
  const appel = `new Promise((resolve, reject) => {
    const requete = new XMLHttpRequest();
    requete.open(${JSON.stringify(methode)}, ${JSON.stringify(chemin)}, true);
    requete.setRequestHeader("content-type", "application/json");
    requete.setRequestHeader("x-cockpit-csrf", "1");
    requete.setRequestHeader("x-cockpit-confirm", "1");
    requete.onload = () => resolve({ code: requete.status, corps: requete.responseText });
    requete.onerror = () => reject(new Error("appel confirmé impossible depuis la page"));
    requete.send(${JSON.stringify(JSON.stringify(corps))});
  })`;
  return await ctx.navigateur.evaluer(appel);
}

/** Texte du premier message d'une session (consigne envoyée par le cockpit), lu par le proxy du cockpit. */
export async function premierMessage(ctx, sessionId) {
  const messages = await ctx.api.get(`/api/oc/session/${encodeURIComponent(sessionId)}/message?directory=${encodeURIComponent(DOSSIER_EQUIPE)}`);
  const premier = (messages ?? [])[0];
  return (premier?.parts ?? []).map((part) => part.text ?? "").join("");
}

// --- Scénario : préalables des scénarios it4 -------------------------------------------------------------------------------------

export async function run(ctx) {
  const api = equipes(ctx);

  // 1. Mode Simple par défaut, et équipes fermées dans le dépôt (U1) : le banc ne bascule la constante que dans sa copie jetable.
  const reglages = await ctx.api.get("/api/settings");
  exiger(reglages?.ui?.mode === "simple", `mode par défaut « ${reglages?.ui?.mode} », attendu « simple ».`);

  // 2. Routes d'équipes montées, exemples au catalogue (Q3, A11 option a).
  const liste = await api.liste();
  exiger(Array.isArray(liste?.exemples), `GET /api/teams sans exemples : ${resume(liste)}`);
  for (const exemple of EXEMPLES) {
    exiger(
      liste.exemples.some((candidat) => candidat.id === exemple),
      `exemple « ${exemple} » absent du catalogue : ${resume(liste.exemples.map((e) => e.id))}`,
    );
  }
  releve(ctx, `équipes : ${liste.teams.length} installée(s), exemples ${liste.exemples.map((e) => e.id).join(", ")}, ouvertesEnSimple=${liste.ouvertesEnSimple}`);

  // 3. Carte des assistants : ouverte dans les deux modes (plan §2.6), en lecture seule.
  const carte = await api.carte();
  exiger(Array.isArray(carte?.nodes) && carte.nodes.length > 0, `GET /api/agent-map sans nœud : ${resume(carte)}`);

  if (ctx.mode !== "faux") {
    releve(ctx, "pilotage du faux opencode : non vérifié hors du mode « --faux ».");
    ctx.expectNoConsoleErrors();
    return;
  }

  // 4. Pilotage ajouté par L41 au faux : un sélecteur bien écrit est accepté, un sélecteur mal écrit est refusé (jamais ignoré).
  await scripterEtape(ctx, "sonde-it4-commun", { text: "Jamais joué : aucune étape ne porte ce nom." });
  await configGlobale(ctx, {});
  let refuse = false;
  try {
    await ctx.faux.scripter("quand:champ-inconnu=1", { text: "x" });
  } catch {
    refuse = true;
  }
  exiger(refuse, "le pilotage du faux accepte un sélecteur « quand: » inconnu : un scénario scripterait sans le savoir.");

  ctx.expectNoConsoleErrors();
}
