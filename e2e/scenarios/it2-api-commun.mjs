// Scénarios e2e de l'itération 2 « Autonomie contrôlée » (paquet L13) : outils communs, et le scénario qui vérifie leurs préalables.
//
// Le banc lance chaque fichier « .mjs » de e2e/scenarios comme un scénario : ce module en est donc un aussi. Son run(ctx) vérifie ce
// sur quoi reposent tous les scénarios « it2-* » : porte I1 ouverte (ACTIVATION_OUVERTE, amorçage), interrupteur COCKPIT_AUTONOMY
// allumé, mode Simple par défaut, atelier du workspace en place, corpus des 60 commandes bien formé (jamais joué), agents internes
// installés.
//
// Principe, repris de L7b-1 : tout passe par l'API du cockpit (proxy /api/oc/*, routes /api/*), jamais directement par opencode, et
// chaque scénario qui agit se déroule sous le témoin P6 d'it1-api-commun.mjs (aucun PATCH /global/config, aucun dispose, aucun
// redémarrage de l'instance principale ; aucune réponse d'autorisation autre que « once » ou « reject »).
//
// ATELIER (nouveauté de l'itération 2). L'autonomie décide sur des FAITS DU DISQUE : la politique « modification » résout les
// chemins (E1, E2) et la porte des commandes lit le sous-arbre et `.git/config` (S5, S6, G04). Le banc monte le même dossier dans
// le cockpit (« /workspace ») et sur la machine ; les scénarios y préparent donc un petit atelier, une fois, avant d'agir :
//   /workspace/it2-atelier  dépôt git propre (config sans rien qui lance un programme), src/app.ts, notes.txt, README.md ;
//   /workspace/it2-piege    dépôt git PIÉGÉ (core.pager dans .git/config) : toute commande git y attend (G04).
// Le chemin de ce dossier sur la machine n'est pas dans le contexte du banc : il est déduit de `ctx.dossierCaptures`, que la fiche
// L7a place à côté du dossier de travail (docker-e2e.mjs : `captures` et `workspace` sont frères). La déduction est VÉRIFIÉE avant
// d'écrire quoi que ce soit ; si la disposition du banc change, le scénario s'arrête en le disant et demande `ctx.workspace` à
// l'intégrateur, propriétaire de e2e/lib/.
//
// D-05 (banc en HTTP tant que la 1.0.5 n'est pas rebasée). Le client d'API du banc ne sait pas poser d'en-tête : la confirmation
// d'un choix automatique (« x-cockpit-confirm: 1 », §4.11) part donc d'un `fetch` brut vers `ctx.url`, comme le flux du témoin P6.
// Tous les `fetch` bruts de l'itération 2 sont dans la seule section « Requêtes brutes (D-05) » ci-dessous : R105b n'a qu'un endroit
// à reprendre pour cette famille, et une option `confirm` du client d'API les supprimerait toutes (demande à l'intégrateur).
import fs from "node:fs";
import path from "node:path";
import { forbiddenCategory } from "../../app/server/shared/shell-gate.ts";
import { attendreQue, exiger, exigerListe, oc, resume } from "./it1-api-commun.mjs";
// `attendreIa` attend que le catalogue des IA du cockpit soit chargé : juste après le démarrage de la pile, il est encore vide et
// `iaDuBanc` lève. L7b-2 l'a posée dans `it1-ui-commun.mjs` ; elle ne tient qu'à l'API (aucun navigateur, aucun import de cdp) et
// les scénarios it2-api-* la reprennent telle quelle plutôt que d'en écrire une seconde.
import { attendreIa } from "./it1-ui-commun.mjs";

export { attendreIa };

// Outils de l'itération 1 repris tels quels par les scénarios it2-*.
export {
  arreter,
  attendre,
  attendreAgentsInternes,
  attendreDemandes,
  attendreFinDuTour,
  attendreQue,
  auRepos,
  avecTemoinP6,
  changerMode,
  corpsJson,
  delegation,
  demandeDeDelegation,
  enModeAvance,
  exiger,
  exigerListe,
  iaDuBanc,
  nonJoue,
  oc,
  occupees,
  partiesOutil,
  releve,
  resume,
  temoinP6,
} from "./it1-api-commun.mjs";

/** Dossier de travail des conversations de l'itération 2 : dépôt git propre, dans le workspace monté. */
export const DOSSIER_ATELIER = "/workspace/it2-atelier";
/** Dépôt PIÉGÉ : `.git/config` porte `core.pager`, donc toute consultation git y lance un programme (G04, §4.5 S6). */
export const DOSSIER_PIEGE = "/workspace/it2-piege";

/** Fichiers de l'atelier, contenus compris. Aucun secret : des lignes de test, et un « TODO » que `grep -rn` va chercher. */
const ATELIER = {
  "notes.txt": "ligne 1\nligne 2\nligne 3\n",
  "README.md": "# Atelier de l'itération 2\n\nDossier de test du banc e2e.\n",
  "src/app.ts": "// TODO: écrire l'atelier\nexport const atelier = true;\n",
  // Dépôt git propre : aucune clé qui lance un programme, aucun hook, aucun sous-module, aucun index.
  ".git/config": "[core]\n\trepositoryformatversion = 0\n\tbare = false\n",
  ".git/HEAD": "ref: refs/heads/principale\n",
};

/** Fichiers du dépôt piégé : `core.pager` suffit à faire attendre `git status` (gitConfigRisk). */
const PIEGE = {
  "notes.txt": "ligne piégée\n",
  ".git/config": "[core]\n\trepositoryformatversion = 0\n\tpager = mon-pager\n",
  ".git/HEAD": "ref: refs/heads/principale\n",
};

/** Corpus de la barrière des 60 commandes (§4.6), PRÉPARÉ et versionné : lu pour sa forme, jamais soumis. */
export const CORPUS_60 = path.resolve(import.meta.dirname, "..", "corpus", "controle-60.json");

// --- Atelier du workspace ---------------------------------------------------------------------------------------------------------

/** Racine du workspace de la pile jetable, sur la machine. Voir l'en-tête : déduite du dossier des captures, puis vérifiée. */
export function racineDuWorkspace(ctx) {
  const captures = ctx.dossierCaptures;
  exiger(typeof captures === "string" && captures.length > 0, "contexte du banc sans dossier de captures.");
  const racine = path.join(path.dirname(captures), "workspace");
  exiger(
    fs.existsSync(racine) && fs.statSync(racine).isDirectory(),
    `workspace de la pile jetable introuvable (${racine} déduit de ${captures}). La disposition du banc a changé : demandez ` +
      "`ctx.workspace` à l'intégrateur plutôt que de deviner ici.",
  );
  return racine;
}

/** Écrit un arbre de fichiers sous `racine` (dossiers créés au besoin) ; idempotent, réécrit le même contenu. */
function ecrireArbre(racine, fichiers) {
  for (const [relatif, contenu] of Object.entries(fichiers)) {
    const cible = path.join(racine, ...relatif.split("/"));
    fs.mkdirSync(path.dirname(cible), { recursive: true });
    fs.writeFileSync(cible, contenu, { encoding: "utf8" });
  }
}

/**
 * Prépare l'atelier du workspace (idempotent : chaque scénario it2-* l'appelle avant d'agir, l'ordre alphabétique du banc ne
 * garantissant pas que le scénario des préalables passe le premier). Rend les deux dossiers, vus par opencode.
 */
export function atelier(ctx) {
  const racine = racineDuWorkspace(ctx);
  ecrireArbre(path.join(racine, "it2-atelier"), ATELIER);
  ecrireArbre(path.join(racine, "it2-piege"), PIEGE);
  return { atelier: DOSSIER_ATELIER, piege: DOSSIER_PIEGE };
}

// --- P6 sans flux ouvert --------------------------------------------------------------------------------------------------------

/** Routes d'opencode interdites (P6, §6 l.1052), écrites ici en clair : c'est la liste attendue, pas celle que le code déclare. */
const ROUTES_P6 = [
  { methode: "PATCH", chemin: "/global/config" },
  { methode: "POST", chemin: "/global/dispose" },
  { methode: "POST", chemin: "/instance/dispose" },
];

/** Seules réponses d'autorisation que le cockpit peut envoyer à opencode (P4). */
const REPONSES_P4 = new Set(["once", "reject"]);

/**
 * Nombre de requêtes déjà reçues par le faux : repère à prendre AVANT d'agir, à rendre à `exigerP6SurRequetes`.
 * En dehors du mode « --faux », le relevé n'existe pas : le repère vaut 0 et la vérification ne dira rien.
 */
export async function repereDesRequetes(ctx) {
  return ctx.mode === "faux" ? (await ctx.opencodeRequests()).length : 0;
}

/**
 * P6 et P4 vérifiés sur le SEUL journal des requêtes du faux, sans tenir de flux d'événements ouvert. `avecTemoinP6` reste le
 * contrôle complet (il voit en plus les libérations d'instance relayées et les coupures du flux d'opencode) et doit être préféré
 * partout où un scénario peut tenir un flux. Cette variante existe pour les scénarios qui ne le peuvent pas — celui de l'onglet
 * fermé, dont la démonstration est justement qu'AUCUN flux du cockpit n'est ouvert — et pour ceux qui n'agissent pas sur opencode,
 * où ouvrir un flux ne prouverait rien de plus.
 */
export async function exigerP6SurRequetes(ctx, depuis = 0) {
  if (ctx.mode !== "faux") return;
  const recues = (await ctx.opencodeRequests()).slice(depuis);
  const interdites = recues.filter((r) => ROUTES_P6.some((p) => p.methode === String(r.method).toUpperCase() && p.chemin === r.pathname));
  exiger(interdites.length === 0, `P6 : ${interdites.map((r) => `${r.method} ${r.pathname}`).join(", ")} reçu(s) par opencode pendant le scénario.`);
  const reponses = recues.filter((r) => String(r.method).toUpperCase() === "POST" && /^\/permission\/[^/]+\/reply$/.test(r.pathname ?? ""));
  const hors = reponses.filter((r) => !REPONSES_P4.has(r.body?.reply));
  exiger(hors.length === 0, `P4 : réponse d'autorisation « ${hors.map((r) => r.body?.reply).join(", ")} » envoyée à opencode.`);
}

// --- Requêtes brutes (D-05) ---------------------------------------------------------------------------------------------------------

/**
 * PUT /api/conversations/:rootId/autonomie, avec ou sans la confirmation (« x-cockpit-confirm: 1 »). Le client d'API du banc ne
 * pose pas d'en-tête : requête brute avec le seul cookie de session du banc, comme le flux du témoin P6.
 * D-05 : `fetch` brut vers ctx.url, possible tant que le banc sert en HTTP ; en HTTPS épinglé (R105b), à reprendre par le transport
 * épinglé du banc — avec `postExecutionDePlan` ci-dessous, ce sont les deux seuls endroits de l'itération 2, réunis ici.
 */
export async function putAutonomie(ctx, rootId, corps, { confirme = false } = {}) {
  const entetes = {
    cookie: ctx.api.cookie,
    origin: ctx.url,
    "content-type": "application/json",
    "x-cockpit-csrf": "1",
    ...(confirme ? { "x-cockpit-confirm": "1" } : {}),
  };
  // D-05 : `fetch` brut vers ctx.url (voir l'en-tête de cette fonction).
  const reponse = await fetch(`${ctx.url}/api/conversations/${encodeURIComponent(rootId)}/autonomie`, {
    method: "PUT",
    headers: entetes,
    body: JSON.stringify(corps),
  });
  const texte = await reponse.text();
  let json = null;
  try {
    json = texte ? JSON.parse(texte) : null;
  } catch {
    json = null;
  }
  return { code: reponse.status, corps: json, texte };
}

/** POST /api/plans/:id/execution, avec ou sans la confirmation. Même D-05 que putAutonomie. */
export async function postExecutionDePlan(ctx, planId, corps, { confirme = false } = {}) {
  const reponse = await fetch(`${ctx.url}/api/plans/${encodeURIComponent(planId)}/execution`, {
    method: "POST",
    headers: {
      cookie: ctx.api.cookie,
      origin: ctx.url,
      "content-type": "application/json",
      "x-cockpit-csrf": "1",
      ...(confirme ? { "x-cockpit-confirm": "1" } : {}),
    },
    body: JSON.stringify(corps),
  });
  const texte = await reponse.text();
  let json = null;
  try {
    json = texte ? JSON.parse(texte) : null;
  } catch {
    json = null;
  }
  return { code: reponse.status, corps: json, texte };
}

// --- Choix d'autonomie ---------------------------------------------------------------------------------------------------------------

/** GET /api/conversations/:rootId/autonomie. */
export const lireAutonomie = (ctx, rootId) => ctx.api.get(`/api/conversations/${encodeURIComponent(rootId)}/autonomie`);

/**
 * Choix RÉELLEMENT fermés dans une vue d'autonomie. « Plan d'abord » rendu indisponible pour la raison `nouvelle-conversation`
 * n'est pas un refus : c'est le chemin du §4.13 (il ouvre toujours une nouvelle conversation, par POST /api/plans, jamais par
 * PUT), et le sélecteur le laisse actif (`serverRefusal`, shared/autonomy-menu.ts). Un scénario qui compterait cette entrée comme
 * un refus échouerait sur une conversation parfaitement ordinaire.
 */
export function choixFermes(vue) {
  return (vue?.disponibles ?? []).filter((d) => d.disponible !== true && !(d.choix === "plan" && d.raison === "nouvelle-conversation"));
}

/**
 * Passe la conversation en « Autonome avec contrôle » COMME L'INTERFACE le fait (§4.11, §4.13) : un premier PUT sans en-tête, qui
 * doit recevoir 428 `confirmation-requise` (le serveur est seul juge de la confirmation), puis le même PUT confirmé, avec les
 * plafonds. Rend la vue rendue par le serveur.
 */
export async function activerAutonome(ctx, rootId, plafonds = null) {
  const corps = plafonds === null ? { choix: "autonome" } : { choix: "autonome", plafonds };
  const sans = await putAutonomie(ctx, rootId, corps);
  exiger(sans.code === 428, `PUT autonome sans confirmation : code ${sans.code} au lieu de 428 (${resume(sans.texte)}).`);
  exiger(sans.corps?.error === "confirmation-requise", `428 sans le code attendu : ${resume(sans.corps)}`);
  const avec = await putAutonomie(ctx, rootId, corps, { confirme: true });
  exiger(avec.code === 200, `PUT autonome confirmé : code ${avec.code} (${resume(avec.texte)}).`);
  exiger(avec.corps?.choix === "autonome", `choix rendu : ${resume(avec.corps?.choix)} au lieu de « autonome ».`);
  return avec.corps;
}

/** Passe la conversation en « Modifications automatiques », confirmation comprise (relâcher, §4.11). */
export async function activerModifications(ctx, rootId) {
  const sans = await putAutonomie(ctx, rootId, { choix: "modifications" });
  exiger(sans.code === 428, `PUT modifications sans confirmation : code ${sans.code} au lieu de 428.`);
  const avec = await putAutonomie(ctx, rootId, { choix: "modifications" }, { confirme: true });
  exiger(avec.code === 200 && avec.corps?.choix === "modifications", `PUT modifications confirmé : ${avec.code} ${resume(avec.texte)}`);
  return avec.corps;
}

// --- Activité, décisions et demandes -------------------------------------------------------------------------------------------------

/** GET /api/conversations/:rootId/activity : délégations, attentes, décisions du Journal, demandes autonomes. */
export const activite = (ctx, rootId) => ctx.api.get(`/api/conversations/${encodeURIComponent(rootId)}/activity`);

/** Attend `nombre` lignes de Journal qui satisfont `test` ; rend-les (ordre du serveur). */
export async function attendreDecisions(ctx, rootId, test, { nombre = 1, delaiMs = 30_000, libelle = "décision" } = {}) {
  return await attendreQue(
    async () => {
      const trouvees = ((await activite(ctx, rootId))?.decisions ?? []).filter(test);
      return trouvees.length >= nombre ? trouvees : false;
    },
    { delaiMs, libelle },
  );
}

/** Demande autonome en cours ou dernière demande de la conversation (GET …/autonomie, puis GET …/activity). */
export async function derniereDemande(ctx, rootId) {
  const requests = (await activite(ctx, rootId))?.requests ?? [];
  return requests.length === 0 ? null : (requests.find((r) => r.endedAt === null) ?? requests[requests.length - 1]);
}

/** Attend que la demande autonome de la conversation soit close avec la fin `fin` ; rend-la. */
export async function attendreFinDeDemande(ctx, rootId, fin, { delaiMs = 45_000 } = {}) {
  return await attendreQue(
    async () => {
      const demande = await derniereDemande(ctx, rootId);
      return demande !== null && demande.fin === fin ? demande : false;
    },
    { delaiMs, libelle: `demande autonome close « ${fin} »` },
  );
}

/** Décision automatique de règle `regle` (ligne « Autorisé automatiquement » du Journal). */
export const decisionAuto = (regle) => (d) => d.verdict === "auto" && d.regle === regle;
/** Décision en attente de règle `regle` (carte « En attente de votre accord »). */
export const decisionAttente = (regle) => (d) => d.verdict === "attente" && d.regle === regle;

// --- Tours scriptés du faux opencode ---------------------------------------------------------------------------------------------------

/**
 * Appel `write` scripté : création d'un fichier. Le faux calcule lui-même les métadonnées mesurées sur opencode 1.18.30
 * (`metadata.filepath` absolu et `metadata.diff`, fixture mx1-mesures.json) à partir du contenu : rien n'est écrit à la main ici.
 * `patterns` est relatif au worktree, comme opencode l'écrit (mesure MX1 §3).
 */
export function ecriture(dossier, relatif, contenu) {
  return {
    tool: "write",
    input: { filePath: `${dossier}/${relatif}`, content: contenu },
    ask: { permission: "edit", patterns: [relatif] },
  };
}

/** Appel `bash` scripté : la demande ne porte que `metadata.command`, texte complet (§4.5, fixture m14). */
export function commande(texte) {
  return { tool: "bash", input: { command: texte }, ask: { permission: "bash", patterns: [texte], metadata: { command: texte } } };
}

/**
 * Script un tour sur le faux puis envoie un message par le proxy du cockpit (ouverture d'une demande autonome). Rend la réponse
 * brute de l'envoi (204 attendu). En dehors du mode « --faux », il n'y a rien à scripter : l'appelant doit l'avoir dit.
 */
export async function envoyerEtJouer(ctx, client, rootId, tour, { texte = "Vas-y.", ia, agent = "build" } = {}) {
  exiger(ctx.mode === "faux", "envoyerEtJouer ne vaut qu'en mode « --faux » : ailleurs, aucun tour ne se script.");
  await ctx.faux.scripter(rootId, tour);
  const envoi = await client.envoyer(rootId, texte, ia, agent);
  exiger(envoi.code === 204, `envoi refusé : code ${envoi.code} (${resume(envoi.corps)}).`);
  return envoi;
}

// --- Corpus des 60 (préparé, jamais joué) ----------------------------------------------------------------------------------------------

/** Programmes de la liste S3 (§4.5), écrits ici en clair : c'est la liste attendue, pas celle que le code déclare. */
const CONSULTATIONS_S3 = ["pwd", "ls", "cat", "head", "tail", "wc", "stat", "du", "grep", "rg", "find", "git"];

/** Lexique S1 (B05) : seuls ces caractères sont acceptés par la porte. */
const LEXIQUE_S1 = /^[A-Za-z0-9._/:@%+,=\- ']+$/;

/** Jetons réseau refusés par U01 : la commande ne passerait pas en « à juger ». */
const JETONS_RESEAU = [/:\/\//, /[A-Za-z0-9_.-]+@[A-Za-z0-9_.-]+/, /\b\d{1,3}(\.\d{1,3}){3}\b/, /[A-Za-z0-9_.-]+:\d+\b/];

/**
 * Vérifie la FORME du corpus de la barrière des 60 (§4.6) sans en soumettre une seule commande : 60 entrées, 30 inoffensives et
 * 30 nuisibles, identifiants uniques, chaque commande dans le lexique S1, sans jeton réseau, et dont la tête n'est ni une
 * consultation S3 ni un interdit S4 — sans quoi la porte déciderait seule et l'IA de contrôle ne serait jamais consultée.
 * Rend le corpus lu.
 */
export function verifierCorpus60() {
  const corpus = JSON.parse(fs.readFileSync(CORPUS_60, "utf8"));
  const commandes = corpus.commandes;
  exiger(Array.isArray(commandes) && commandes.length === 60, `corpus des 60 : ${commandes?.length} entrée(s).`);
  const parCategorie = { inoffensif: 0, nuisible: 0 };
  const vus = new Set();
  for (const entree of commandes) {
    exiger(typeof entree.id === "string" && !vus.has(entree.id), `corpus des 60 : identifiant absent ou en double (${resume(entree.id)}).`);
    vus.add(entree.id);
    exiger(entree.categorie in parCategorie, `corpus des 60 : catégorie inconnue (${resume(entree.categorie)}).`);
    parCategorie[entree.categorie]++;
    const texte = entree.command;
    exiger(typeof texte === "string" && texte.length >= 1 && texte.length <= 400, `corpus des 60 : commande hors bornes (${resume(entree.id)}).`);
    exiger(LEXIQUE_S1.test(texte), `corpus des 60 : « ${texte} » sort du lexique S1.`);
    for (const jeton of JETONS_RESEAU) exiger(!jeton.test(texte), `corpus des 60 : « ${texte} » porte un jeton réseau (U01).`);
    const tete = texte.split(" ")[0] ?? "";
    exiger(!CONSULTATIONS_S3.includes(tete), `corpus des 60 : « ${texte} » est une consultation S3, la porte décide seule.`);
    exiger(forbiddenCategory(tete) === null, `corpus des 60 : « ${texte} » est un interdit S4, l'IA n'est jamais consultée.`);
    exiger(typeof entree.pourquoi === "string" && entree.pourquoi.length > 0, `corpus des 60 : « ${texte} » sans raison écrite.`);
  }
  exigerListe([parCategorie.inoffensif, parCategorie.nuisible], [30, 30], "corpus des 60 : répartition inoffensifs / nuisibles");
  return corpus;
}

// --- Scénario : préalables des scénarios it2 ---------------------------------------------------------------------------------------------

export async function run(ctx) {
  // P6 : ce scénario ne fait que lire et créer une conversation ; un flux ouvert ne prouverait rien de plus que le journal des
  // requêtes du faux, relevé d'un bout à l'autre.
  const depuis = await repereDesRequetes(ctx);
  const bootstrap = await ctx.api.get("/api/bootstrap");

  // Mode Simple par défaut (décision : mode Simple par défaut) ; chaque scénario qui passe en Avancé y revient.
  exiger(bootstrap?.settings?.ui?.mode === "simple", `mode ${resume(bootstrap?.settings?.ui?.mode)} au lieu de « simple ».`);
  exiger(bootstrap?.opencode?.reachable === true, `opencode non joint : ${resume(bootstrap?.opencode)}`);

  // Porte I1 : la bascule du train de la vague 3 est faite, sinon aucun scénario d'autonomie de l'itération 2 n'a de sens.
  exiger(
    bootstrap?.autonomy?.activationOuverte === true,
    "porte I1 fermée (ACTIVATION_OUVERTE faux) : les scénarios it2-* qui activent un choix automatique sont EN ATTENTE DE LA " +
      "BASCULE ; ne les contournez pas, faites basculer la constante au train de vague.",
  );
  // Interrupteur COCKPIT_AUTONOMY (décision n° 13) : la pile du banc le sert allumé (docker-compose.yml, « on » par défaut).
  exiger(bootstrap?.autonomy?.interrupteur === true, `COCKPIT_AUTONOMY coupé sur la pile du banc : ${resume(bootstrap?.autonomy)}`);

  // Plafonds et IA de contrôle LUS dans l'amorçage (§4.8.1) : les scénarios ne les devinent pas.
  const reglages = bootstrap?.settings?.budget?.autonomie;
  exiger(typeof reglages?.plafondUsd === "number" && typeof reglages?.controleIa === "boolean", `réglages d'autonomie illisibles : ${resume(reglages)}`);

  // Atelier du workspace en place, vu par le cockpit comme par opencode.
  const dossiers = atelier(ctx);
  const racine = racineDuWorkspace(ctx);
  exiger(fs.existsSync(path.join(racine, "it2-atelier", ".git", "config")), "atelier : dépôt git propre absent.");
  exiger(fs.readFileSync(path.join(racine, "it2-piege", ".git", "config"), "utf8").includes("pager"), "atelier : dépôt piégé sans piège.");

  // Corpus des 60 : forme vérifiée, AUCUNE commande soumise (il demande une IA Rapide réelle, donc facturée).
  const corpus = verifierCorpus60();
  console.log(
    `    ${ctx.mode} : atelier prêt (${dossiers.atelier}, ${dossiers.piege}) ; corpus des 60 vérifié et NON joué ` +
      `(${corpus.commandes.length} commandes, recette en attente).`,
  );

  // Le cockpit doit répondre à la route d'autonomie d'une conversation neuve, avec les quatre choix (§4.13).
  const conversation = await oc(ctx, DOSSIER_ATELIER).creerConversation("it2-api-commun");
  const vue = await lireAutonomie(ctx, conversation.id);
  exiger(vue?.choix === "demander", `conversation neuve : choix ${resume(vue?.choix)} au lieu de « demander ».`);
  exigerListe(
    (vue?.disponibles ?? []).map((d) => d.choix),
    ["demander", "modifications", "plan", "autonome"],
    "quatre choix rendus par le serveur",
  );
  const fermes = choixFermes(vue);
  exiger(fermes.length === 0, `choix fermés dans une conversation ordinaire : ${resume(fermes)}`);
  // « Plan d'abord » est bien rendu « indisponible, nouvelle-conversation » : c'est le chemin du §4.13, pas un refus.
  const plan = (vue?.disponibles ?? []).find((d) => d.choix === "plan");
  exiger(
    plan?.disponible === false && plan?.raison === "nouvelle-conversation",
    `« Plan d'abord » rendu autrement que par « nouvelle-conversation » : ${resume(plan)}`,
  );

  await exigerP6SurRequetes(ctx, depuis);
}
