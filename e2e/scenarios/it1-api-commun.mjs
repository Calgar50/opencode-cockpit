// Scénarios e2e API de l'itération 1 (paquet L7b-1) : outils communs, et le scénario qui vérifie leurs préalables.
//
// Le banc lance chaque fichier « .mjs » de e2e/scenarios comme un scénario : ce module en est donc un aussi. Son run(ctx) vérifie
// ce sur quoi reposent les autres scénarios « it1-api-* » : mode Simple par défaut, opencode joint, IA du banc au catalogue, agents
// internes installés (une installation recharge opencode, ce qui fausserait le témoin P6), témoin P6 branché sur le flux du
// cockpit, et oracle des outils du faux conforme à la mesure M2.
//
// Tout passe par l'API du cockpit (proxy /api/oc/*, routes /api/*), jamais directement par opencode : c'est le cockpit qu'on
// éprouve. Deux observations seulement viennent du banc lui-même :
//   - en « --faux », les requêtes reçues par le faux opencode (ctx.opencodeRequests) et les tours qu'il joue (ctx.faux.scripter) ;
//   - en « --reel-hors-ligne », les requêtes reçues par le faux fournisseur (ctx.billedCalls) : outils proposés à l'IA, sans texte.
//
// Oracle des outils en « --faux » : le faux opencode calcule les outils qu'il enverrait à l'IA (toolsFor) à partir des règles de
// l'assistant et de la session ; ce calcul est vérifié contre la mesure M2 (fixture m2-tools.json, fake-opencode.test.ts). Le banc
// n'expose pas toolsFor : on applique donc les mêmes fonctions du faux (builtinTools, disabledTools) aux règles lues par le proxy
// du cockpit (GET /session/:id, GET /agent). En « --reel-hors-ligne », aucun oracle : la liste est celle que le vrai opencode a
// envoyée au faux fournisseur.
//
// Limite du mode « --reel-hors-ligne » : le faux fournisseur (e2e/lib/faux-fournisseur.mjs) ne sait répondre que du texte, jamais
// un appel d'outil. Ce qui demande qu'une IA appelle un outil (lecture d'un fichier, délégation) n'y est donc pas joué ; chaque
// scénario le dit par une ligne « non joué » et vérifie ce qui reste observable.
import fs from "node:fs";
import path from "node:path";
import { builtinTools, deriveChildRules, disabledTools } from "../../app/server/test-support/fake-opencode.ts";

/** Racine du dépôt : e2e/scenarios → e2e → dépôt. */
const RACINE = path.resolve(import.meta.dirname, "..", "..");

/** Dossier des conversations des scénarios : la racine du workspace, que le faux comme le vrai opencode servent sans préparation. */
export const DOSSIER = "/workspace";

/** Outils qui modifient ou exécutent : aucun ne doit rester dans une conversation de plan (§4.9, M2). */
export const ECRIVAINS = ["apply_patch", "bash", "edit", "write"];

/** Routes d'opencode interdites pendant les scénarios (P6, §6 l.1052) : écriture de la configuration globale, libération des instances. */
const ROUTES_P6 = [
  { methode: "PATCH", chemin: "/global/config" },
  { methode: "POST", chemin: "/global/dispose" },
  { methode: "POST", chemin: "/instance/dispose" },
];

/** Événements d'opencode relayés par le cockpit qui trahissent une libération d'instance (P6). */
const EVENEMENTS_P6 = new Set(["global.disposed", "server.instance.disposed"]);

/** Seules réponses d'autorisation que le cockpit peut envoyer à opencode (P4) : ni « always », ni rien d'autre. */
const REPONSES_PERMISES = new Set(["once", "reject"]);

/** Bloc SSE (lignes « event: » et « data: ») : nom d'événement et données JSON, null si illisibles. */
function analyserBlocSse(bloc) {
  const lignes = bloc.split("\n");
  const nom = lignes.find((l) => l.startsWith("event:"))?.slice(6).trim() ?? null;
  const donnees = lignes
    .filter((l) => l.startsWith("data:"))
    .map((l) => l.slice(5).replace(/^ /, ""))
    .join("\n");
  if (!donnees) return { nom, valeur: null };
  try {
    return { nom, valeur: JSON.parse(donnees) };
  } catch {
    return { nom, valeur: null };
  }
}

export const attendre = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Attend qu'une fonction (éventuellement asynchrone) rende une valeur vraie ; lève avec le libellé et la dernière valeur vue. */
export async function attendreQue(fn, { delaiMs = 15_000, pasMs = 200, libelle = "condition" } = {}) {
  const limite = Date.now() + delaiMs;
  let derniere;
  for (;;) {
    try {
      derniere = await fn();
      if (derniere) return derniere;
    } catch (err) {
      derniere = err?.message ?? String(err);
    }
    if (Date.now() >= limite) break;
    await attendre(pasMs);
  }
  throw new Error(`${libelle} : non obtenu en ${Math.round(delaiMs / 1000)} s (dernier relevé : ${resume(derniere)}).`);
}

/** Valeur courte pour un message d'erreur (jamais de secret ici : rien de ce que lit un scénario n'en porte). */
export function resume(valeur, max = 300) {
  const texte = typeof valeur === "string" ? valeur : JSON.stringify(valeur);
  return String(texte).length > max ? `${String(texte).slice(0, max)}…` : String(texte);
}

/** Lève si la condition est fausse. */
export function exiger(condition, message) {
  if (!condition) throw new Error(message);
}

/** Égalité de deux listes de textes, ordre compris ; message qui montre les deux. */
export function exigerListe(obtenue, attendue, libelle) {
  const a = JSON.stringify(obtenue);
  const b = JSON.stringify(attendue);
  if (a !== b) throw new Error(`${libelle} : ${a} au lieu de ${b}.`);
}

/** Ligne « non joué » d'un mode où une partie du scénario n'a pas de sens (écrite par le banc, sous le nom du scénario). */
export function nonJoue(ctx, quoi, pourquoi) {
  console.log(`    ${ctx.mode} : ${quoi} non joué (${pourquoi}).`);
}

/** Ligne de relevé : une valeur observée, gardée dans le journal du banc (jamais un secret : ni jeton, ni texte de message). */
export function releve(ctx, texte) {
  console.log(`    ${ctx.mode} : ${texte}`);
}

// --- IA et mode ----------------------------------------------------------------------------------------------------------------------

/**
 * IA à envoyer, lue dans le bootstrap : IA par défaut du premier fournisseur autorisé (faux : github-copilot/gpt-5-mini ; réel hors
 * ligne : banc/banc-1). En mode Simple, les niveaux d'IA ne proposent que des IA Copilot (MX1 §8) : on envoie donc une IA explicite.
 */
export function iaDuBanc(bootstrap) {
  const fournisseur = bootstrap?.allowedProviders?.[0];
  exiger(typeof fournisseur === "string", `bootstrap sans fournisseur autorisé : ${resume(bootstrap?.allowedProviders)}`);
  const parDefaut = bootstrap.modelDefaults?.[fournisseur];
  const modele = parDefaut ?? bootstrap.models?.find((m) => m.providerID === fournisseur)?.modelID;
  exiger(typeof modele === "string", `aucune IA du fournisseur « ${fournisseur} » au catalogue du cockpit.`);
  return { providerID: fournisseur, modelID: modele };
}

/** Passe le cockpit dans `mode` (« simple » ou « avance ») par l'API des réglages ; rend le mode d'avant. */
export async function changerMode(ctx, mode) {
  const avant = (await ctx.api.get("/api/settings"))?.ui?.mode;
  const apres = await ctx.api.put("/api/settings", { ui: { mode } });
  exiger(apres?.ui?.mode === mode, `mode ${mode} refusé par le cockpit : ${resume(apres?.ui)}`);
  return avant;
}

/**
 * Exécute `fn` en mode Avancé (délégations relayées à l'utilisateur, décision n° 4 : en Simple elles sont refusées d'office), puis
 * revient au mode d'avant, même en cas d'échec : les scénarios partagent la pile, et le mode Simple est le défaut.
 */
export async function enModeAvance(ctx, fn) {
  const avant = await changerMode(ctx, "avance");
  try {
    return await fn();
  } finally {
    await changerMode(ctx, avant === "avance" ? "avance" : "simple");
  }
}

// --- Proxy d'opencode (/api/oc/*) et routes du cockpit --------------------------------------------------------------------------------

/** Client opencode par le proxy du cockpit, toujours dans `dossier` (paramètre « directory », vérifié par le cockpit). */
export function oc(ctx, dossier = DOSSIER) {
  const q = `directory=${encodeURIComponent(dossier)}`;
  const id = (valeur) => encodeURIComponent(valeur);
  return {
    dossier,
    /** POST /session : le corps du client ne porte que le titre ; le cockpit y ajoute le plancher CONVERSATION (L3). */
    creerConversation: (titre) => ctx.api.post(`/api/oc/session?${q}`, titre ? { title: titre } : {}),
    session: (sessionId) => ctx.api.get(`/api/oc/session/${id(sessionId)}?${q}`),
    enfants: (sessionId) => ctx.api.get(`/api/oc/session/${id(sessionId)}/children?${q}`),
    messages: (sessionId) => ctx.api.get(`/api/oc/session/${id(sessionId)}/message?${q}`),
    /** Sessions du dossier et leur état : { id: {type} } (une session au repos peut ne pas y figurer). */
    etats: () => ctx.api.get(`/api/oc/session/status?${q}`),
    demandes: () => ctx.api.get(`/api/oc/permission?${q}`),
    agents: () => ctx.api.get(`/api/oc/agent?${q}`),
    /** Envoi d'un message (réponse brute : 204 attendu). */
    envoyer: (sessionId, texte, ia, agent = "build") =>
      ctx.api.brut("POST", `/api/oc/session/${id(sessionId)}/prompt_async?${q}`, { agent, model: ia, parts: [{ type: "text", text: texte }] }),
    /** Réponse de l'utilisateur à une demande d'autorisation, par le portillon du cockpit (réponse brute). */
    repondre: (demandeId, reponse) => ctx.api.brut("POST", `/api/oc/permission/${id(demandeId)}/reply?${q}`, { reply: reponse }),
  };
}

/** « Arrêter » : POST /api/conversations/:rootId/stop (L1c), réponse brute (StopResult attendu). */
export function arreter(ctx, rootId) {
  return ctx.api.brut("POST", `/api/conversations/${encodeURIComponent(rootId)}/stop`);
}

/** Corps JSON d'une réponse brute du client du banc ; lève avec le code si illisible. */
export function corpsJson(reponse, libelle) {
  try {
    return JSON.parse(reponse.corps);
  } catch {
    throw new Error(`${libelle} : réponse ${reponse.code} illisible (${resume(reponse.corps)}).`);
  }
}

/** Sessions de `ids` occupées (« busy » ou « retry ») selon GET /session/status. */
export async function occupees(client, ids) {
  const etats = (await client.etats()) ?? {};
  return ids.filter((sid) => etats[sid] && etats[sid].type !== "idle");
}

/** Vrai si aucune des sessions `ids` n'est occupée. */
export async function auRepos(client, ids) {
  return (await occupees(client, ids)).length === 0;
}

/** Attend la fin du tour de `sessionId` : session au repos et dernier message d'assistant clos. Rend les messages. */
export async function attendreFinDuTour(client, sessionId, { delaiMs = 30_000 } = {}) {
  return await attendreQue(
    async () => {
      if (!(await auRepos(client, [sessionId]))) return false;
      const messages = await client.messages(sessionId);
      const dernier = messages?.findLast?.((m) => m.info?.role === "assistant");
      return dernier && typeof dernier.info?.time?.completed === "number" ? messages : false;
    },
    { delaiMs, libelle: `fin du tour de ${sessionId}` },
  );
}

/** Attend `nombre` demandes d'autorisation en attente qui satisfont `test` ; rend-les. */
export async function attendreDemandes(client, test, { nombre = 1, delaiMs = 15_000, libelle = "demande d'autorisation" } = {}) {
  return await attendreQue(
    async () => {
      const trouvees = ((await client.demandes()) ?? []).filter(test);
      return trouvees.length >= nombre ? trouvees : false;
    },
    { delaiMs, libelle },
  );
}

/** Parties d'outil `outil` des messages d'une session. */
export function partiesOutil(messages, outil) {
  return (messages ?? []).flatMap((m) => m.parts ?? []).filter((p) => p.type === "tool" && p.tool === outil);
}

// --- Tours scriptés (« --faux ») ---------------------------------------------------------------------------------------------------

/** Appel d'outil « read » scripté pour le faux : règles de l'assistant d'abord, puis celles de la session (F-d). */
export function lecture(fichier, assistant) {
  return { tool: "read", input: { filePath: fichier }, ask: { permission: "read", patterns: [fichier] }, agentRules: assistant.permission, output: "contenu lu" };
}

/**
 * Délégation qui demande votre accord (tool/task.ts : patterns = [subagent_type], metadata {description, subagent_type}), comme
 * avec le profil Prudent (« task: ask »). `enfant` : tour joué par le sous-agent (FakeToolScript.child), agent `cible` par défaut.
 */
export function delegation(description, cible, enfant = {}) {
  return {
    tool: "task",
    input: { description, prompt: `Consigne : ${description}`, subagent_type: cible },
    ask: { permission: "task", patterns: [cible], metadata: { description, subagent_type: cible } },
    child: { agent: cible, ...enfant },
  };
}

/** Demande d'autorisation de la délégation `description` d'une session. */
export const demandeDeDelegation = (sessionId, description) => (d) =>
  d.sessionID === sessionId && d.permission === "task" && d.metadata?.description === description;

/** Partie « read » de `fichier` dans les messages. */
function lectureDe(messages, fichier) {
  const partie = partiesOutil(messages, "read").find((p) => p.state?.input?.filePath === fichier);
  exiger(partie, `aucune lecture de ${fichier} dans la conversation.`);
  return partie;
}

/** Lecture refusée par une règle, sans demande (F-b : DeniedError, la boucle continue). */
export function exigerLectureRefusee(messages, fichier) {
  const partie = lectureDe(messages, fichier);
  exiger(partie.state.status === "error", `lecture de ${fichier} : état « ${partie.state.status} » au lieu d'un refus.`);
  exiger(/rule which prevents you/.test(String(partie.state.error)), `lecture de ${fichier} refusée pour une autre raison : ${resume(partie.state.error)}`);
}

/** Lecture faite (le refus est propre aux fichiers de clés, pas à l'outil). */
export function exigerLectureFaite(messages, fichier) {
  const partie = lectureDe(messages, fichier);
  exiger(partie.state.status === "completed", `lecture de ${fichier} : état « ${partie.state.status} » (${resume(partie.state.error)}).`);
}

/** Aucune demande d'autorisation de lecture posée pendant le scénario (relevé du flux du cockpit). */
export function exigerAucuneDemandeDeLecture(temoin) {
  const lectures = temoin.deOpencode("permission.asked").filter((e) => e.event.properties?.permission === "read");
  exiger(lectures.length === 0, `demande de lecture posée : ${resume(lectures.map((e) => e.event.properties?.patterns))}`);
}

// --- Témoin P6 -----------------------------------------------------------------------------------------------------------------------

/**
 * Témoin P6 d'un scénario (§6 l.1052 : ni PATCH /global/config, ni /global/dispose, ni redémarrage de l'instance principale pendant
 * les scénarios). À ouvrir avant toute action, à vérifier à la fin :
 *   - tous modes : flux SSE du cockpit (/api/events), où il relaie global.disposed et server.instance.disposed, et annonce toute
 *     coupure du flux d'opencode (opencode.connection {connected: false}, signe d'un redémarrage) ;
 *   - « --faux » : en plus, requêtes reçues par le faux depuis l'ouverture du témoin : aucune route P6, et (P4) aucune réponse
 *     d'autorisation autre que « once » ou « reject ».
 * Le témoin garde aussi les événements du cockpit, que les scénarios lisent (conversation.arretee, permission.asked…).
 */
export async function temoinP6(ctx) {
  const debutRequetes = ctx.mode === "faux" ? (await ctx.opencodeRequests()).length : 0;
  const controleur = new AbortController();
  const evenements = [];
  let erreurFlux = null;
  let bonjour;
  const pret = new Promise((resolve) => (bonjour = resolve));

  // Cookie de session du client d'API du banc : aucune autre donnée d'authentification n'est lue ni écrite ici.
  const reponse = await fetch(`${ctx.url}/api/events`, { headers: { cookie: ctx.api.cookie, accept: "text/event-stream" }, signal: controleur.signal });
  exiger(reponse.ok && reponse.body, `flux d'événements du cockpit refusé (code ${reponse.status}).`);

  const recevoir = (bloc) => {
    const { nom, valeur } = analyserBlocSse(bloc);
    if (nom === "hello") bonjour();
    else if (valeur && !(valeur.kind === "cockpit" && valeur.type === "heartbeat")) evenements.push({ recu: Date.now(), ...valeur });
  };
  const lecture = (async () => {
    const decodeur = new TextDecoder();
    let tampon = "";
    for await (const morceau of reponse.body) {
      tampon += decodeur.decode(morceau, { stream: true }).replaceAll("\r\n", "\n");
      for (let fin = tampon.indexOf("\n\n"); fin >= 0; fin = tampon.indexOf("\n\n")) {
        recevoir(tampon.slice(0, fin));
        tampon = tampon.slice(fin + 2);
      }
    }
  })().catch((err) => {
    if (!controleur.signal.aborted) erreurFlux = err;
  });

  let minuteur;
  await Promise.race([
    pret,
    new Promise((_, reject) => {
      minuteur = setTimeout(() => reject(new Error("flux d'événements du cockpit : aucun « hello » en 10 s.")), 10_000);
    }),
  ]).finally(() => clearTimeout(minuteur));

  const deOpencode = (type) => evenements.filter((e) => e.kind === "opencode" && e.event?.type === type);
  const duCockpit = (type) => evenements.filter((e) => e.kind === "cockpit" && e.type === type);

  return {
    evenements,
    deOpencode,
    duCockpit,
    /** Requêtes reçues par le faux depuis l'ouverture du témoin (« --faux » seulement). */
    requetes: async () => (await ctx.opencodeRequests()).slice(debutRequetes),
    /** Attend un événement du cockpit `type` dont les données satisfont `test`. */
    attendreCockpit: (type, test = () => true, delaiMs = 15_000) =>
      attendreQue(() => duCockpit(type).find((e) => test(e.data)), { delaiMs, libelle: `événement ${type} du cockpit` }),
    /** Ferme le flux et lève à la première atteinte à P6 (ou à P4) observée. */
    async verifier() {
      controleur.abort();
      await lecture;
      if (erreurFlux) throw new Error(`P6 : flux d'événements du cockpit coupé pendant le scénario (${erreurFlux?.message ?? erreurFlux}).`);
      const liberations = evenements.filter((e) => e.kind === "opencode" && EVENEMENTS_P6.has(e.event?.type));
      exiger(liberations.length === 0, `P6 : instance d'opencode libérée pendant le scénario (${liberations.map((e) => e.event.type).join(", ")}).`);
      const coupures = duCockpit("opencode.connection").filter((e) => e.data?.connected === false);
      exiger(coupures.length === 0, "P6 : flux d'opencode coupé pendant le scénario (redémarrage de l'instance principale ?).");
      if (ctx.mode === "faux") {
        const recues = (await ctx.opencodeRequests()).slice(debutRequetes);
        const interdites = recues.filter((r) => ROUTES_P6.some((p) => p.methode === String(r.method).toUpperCase() && p.chemin === r.pathname));
        exiger(interdites.length === 0, `P6 : ${interdites.map((r) => `${r.method} ${r.pathname}`).join(", ")} reçu(s) par opencode pendant le scénario.`);
        const reponses = recues.filter((r) => String(r.method).toUpperCase() === "POST" && /^\/permission\/[^/]+\/reply$/.test(r.pathname ?? ""));
        const hors = reponses.filter((r) => !REPONSES_PERMISES.has(r.body?.reply));
        exiger(hors.length === 0, `P4 : réponse d'autorisation « ${hors.map((r) => r.body?.reply).join(", ")} » envoyée à opencode.`);
      }
    },
  };
}

/**
 * Déroule un scénario sous le témoin P6 : le témoin est vérifié à la fin, même quand le corps échoue (l'échec du corps l'emporte
 * alors, et une atteinte à P6 y est ajoutée).
 */
export async function avecTemoinP6(ctx, corps) {
  await attendreAgentsInternes(ctx);
  const temoin = await temoinP6(ctx);
  let echec = null;
  try {
    await corps(temoin);
  } catch (err) {
    echec = err;
  }
  try {
    await temoin.verifier();
  } catch (err) {
    if (!echec) throw err;
    echec.message = `${echec.message} — et ${err.message}`;
  }
  if (echec) throw echec;
}

/**
 * Agents internes (cockpit-classifier, cockpit-controle) : leur installation recharge opencode (POST /global/dispose, §3.11) et se
 * fait au repos, reprise comprise. Un scénario n'ouvre son témoin P6 qu'une fois aucune installation en attente : sinon, une reprise
 * tombée pendant le scénario serait prise pour une atteinte à P6. Rend l'état relevé.
 */
export async function attendreAgentsInternes(ctx, delaiMs = 60_000) {
  return await attendreQue(
    async () => {
      const diagnostic = await ctx.api.get("/api/diagnostic/activite");
      const agents = diagnostic?.agentsInternes ?? [];
      return agents.every((a) => a.etat !== "en-attente" && a.prochainEssai === null) ? agents : false;
    },
    { delaiMs, pasMs: 1_000, libelle: "agents internes installés (aucune installation en attente)" },
  );
}

// --- Planchers -----------------------------------------------------------------------------------------------------------------------

/**
 * Motifs de fichiers de clés refusés à la lecture par le plancher CONVERSATION (§3.4, KEY_FILE_READ_RULES : entrées « deny »),
 * écrits ici en clair plutôt qu'importés du cockpit : c'est la liste attendue, pas celle que le code déclare.
 */
export const MOTIFS_CLES = [
  "*.pfx",
  "*.PFX",
  "*.p12",
  "*.P12",
  "*.key",
  "*.KEY",
  "*.jks",
  "*.JKS",
  "*.keystore",
  "*.kdbx",
  "*privkey*",
  "*-key.pem",
  "*_key.pem",
  "*id_rsa*",
  "*id_ecdsa*",
  "*id_ed25519*",
  "*kubeconfig*",
  "*.kube/config",
];

/** Plancher CONVERSATION attendu (§3.4) : un refus de lecture par motif de clé, dans cet ordre. */
export const PLANCHER_CONVERSATION = MOTIFS_CLES.map((pattern) => ({ permission: "read", pattern, action: "deny" }));

/** Plancher PLAN attendu (§3.4, §4.9) : CONVERSATION, puis « edit * deny » et « bash * deny ». */
export const PLANCHER_PLAN = [...PLANCHER_CONVERSATION, { permission: "edit", pattern: "*", action: "deny" }, { permission: "bash", pattern: "*", action: "deny" }];

const texteRegle = (r) => `${r.permission} ${r.pattern} ${r.action}`;

/**
 * Règles d'une racine créée par le cockpit : exactement `plancher`, règle pour règle et dans l'ordre (le client n'en envoie aucune :
 * tout vient du cockpit). Donc aucune autorisation ni demande (une racine ne porte jamais « allow » ni « ask », P4) et jamais
 * « *.env: ask » ni « *.env.example: allow » (décision n° 5).
 */
export function exigerPlancher(permission, plancher, libelle) {
  exiger(Array.isArray(permission), `${libelle} : session sans règles (${resume(permission)}).`);
  exigerListe(permission.map(texteRegle), plancher.map(texteRegle), `${libelle} : règles de la session`);
  const env = permission.filter((r) => /\.env/.test(r.pattern));
  exiger(env.length === 0, `${libelle} : règle sur les .env dans le plancher (${env.map(texteRegle).join(", ")}).`);
}

/** Règles d'un enfant : chaque règle de `plancher` y est héritée (F-f), et l'enfant ne porte aucune autorisation ni demande. */
export function exigerPlancherHerite(permission, plancher, libelle) {
  exiger(Array.isArray(permission), `${libelle} : session sans règles (${resume(permission)}).`);
  const presentes = new Set(permission.map(texteRegle));
  const manquantes = plancher.map(texteRegle).filter((r) => !presentes.has(r));
  exiger(manquantes.length === 0, `${libelle} : règles du plancher non héritées (${manquantes.join(", ")}).`);
  const permissives = permission.filter((r) => r.action !== "deny" && r.permission !== "external_directory");
  exiger(permissives.length === 0, `${libelle} : règle permissive sur l'enfant (${permissives.map(texteRegle).join(", ")}).`);
}

// --- Outils ---------------------------------------------------------------------------------------------------------------------------

let m2 = null;

/** Cas de la mesure M2 (opencode 1.18.30 réel, fixture m2-tools.json) : liste d'outils mesurée, et IA de la mesure. */
export function casM2(nom) {
  m2 ??= JSON.parse(fs.readFileSync(path.join(RACINE, "app", "server", "test-support", "fixtures", "m2-tools.json"), "utf8"));
  const cas = m2.cases.find((c) => c.name === nom);
  exiger(cas, `cas M2 inconnu : ${nom}`);
  return { ...cas, modelID: m2.model.modelID };
}

/**
 * Outils que le faux opencode enverrait à l'IA à la prochaine étape de `session` (FakeOpencode.toolsFor) : outils intégrés de l'IA,
 * moins ceux dont la dernière règle (assistant puis session) est « * deny ». Règles et assistant lus par le proxy du cockpit.
 */
export function outilsDuFaux(session, agents, { modelID, agent } = {}) {
  const nom = agent ?? session.agent ?? "build";
  const assistant = agents.find((a) => a.name === nom);
  exiger(assistant, `assistant « ${nom} » absent de GET /agent.`);
  const outils = builtinTools(modelID ?? session.model?.id ?? "gpt-5-mini");
  const retires = disabledTools(outils, [...(assistant.permission ?? []), ...(session.permission ?? [])]);
  return outils.filter((o) => !retires.has(o)).sort();
}

/** Aucun outil qui modifie ou exécute dans `outils`. */
export function exigerSansEcrivain(outils, libelle) {
  const restes = outils.filter((o) => ECRIVAINS.includes(o));
  exiger(restes.length === 0, `${libelle} : outil(s) qui modifient ou exécutent encore proposés (${restes.join(", ")}).`);
}

/**
 * Requêtes principales reçues par le faux fournisseur depuis l'indice `debut` (« --reel-hors-ligne ») : celles qui proposent des
 * outils. La requête de titre n'en propose aucun (MX1 §5).
 */
export async function requetesAvecOutils(ctx, debut) {
  return (await ctx.billedCalls()).slice(debut).filter((r) => Array.isArray(r.outils) && r.outils.length > 0);
}

// --- Scénario : préalables des scénarios it1-api ----------------------------------------------------------------------------------------

export async function run(ctx) {
  const bootstrap = await ctx.api.get("/api/bootstrap");

  // Mode Simple par défaut ; chaque scénario qui passe en Avancé y revient (enModeAvance).
  exiger(bootstrap?.settings?.ui?.mode === "simple", `mode ${resume(bootstrap?.settings?.ui?.mode)} au lieu de « simple ».`);
  exiger(bootstrap?.opencode?.reachable === true && bootstrap.opencode.events?.connected === true, `opencode non joint : ${resume(bootstrap?.opencode)}`);

  // IA du banc au catalogue, fournisseur autorisé.
  const ia = iaDuBanc(bootstrap);
  exiger(bootstrap.allowedProviders.includes(ia.providerID), `IA ${ia.providerID}/${ia.modelID} hors des fournisseurs autorisés.`);

  // Aucune installation d'agent interne en attente (sinon le témoin P6 des autres scénarios serait faussé).
  const agentsInternes = await attendreAgentsInternes(ctx);
  exiger(agentsInternes.length > 0, "diagnostic sans état des agents internes.");

  // Témoin P6 branché : le flux du cockpit répond, et rien ne libère opencode pendant ces lectures.
  const temoin = await temoinP6(ctx);
  await temoin.verifier();

  // Oracle des outils du faux, sur les agents que sert la pile : il rend les listes mesurées par M2 (racine, enfant general).
  if (ctx.mode === "faux") {
    const agents = await oc(ctx).agents();
    for (const nom of ["sans-regle", "racine-edit-bash-refuses", "tout-refuse-sauf-lecture", "patch-bash-refuse"]) {
      const cas = casM2(nom);
      const obtenus = outilsDuFaux({ agent: cas.agent, permission: cas.sessionPermission ?? [] }, agents, { modelID: cas.modelID });
      exigerListe(obtenus, cas.tools, `oracle des outils, cas M2 « ${nom} »`);
    }
    const enfant = casM2("enfant-general");
    const general = agents.find((a) => a.name === "general");
    exiger(general, "assistant « general » absent du faux.");
    const regles = deriveChildRules(casM2(enfant.parent).sessionPermission ?? [], general.permission);
    exigerListe(outilsDuFaux({ agent: "general", permission: regles }, agents, { modelID: enfant.modelID }), enfant.tools, "oracle des outils, cas M2 « enfant-general »");
  } else {
    nonJoue(ctx, "oracle des outils du faux", "aucun faux opencode : les listes viennent du vrai opencode");
  }
}
