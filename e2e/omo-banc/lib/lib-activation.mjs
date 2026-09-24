// Bibliothèque d'activation du banc complet (L21b), commune aux portes de la vague 5 (L27a : G5, G9, G13 ; L27b : G6, G7, G8) :
// parler au cockpit RÉEL du banc comme le ferait la page de la salle — ouvrir une salle, activer avec un montant, envoyer.
//
// Les routes sont exactement celles de la page (web/lib/api-omo.ts, L26a). Toutes sont servies par la tête de la vague 3, SAUF
// l'activation (`PUT …/autonomie {choix: "omo"}`), que L22c livre au train de la vague 4 : avant, elle est refusée sans envoi.
//   PUT  /api/settings                          mode Avancé (ui.mode, permis en Simple)
//   GET  /api/omo/status                        état de la salle, sans secret
//   POST /api/omo/rooms            {projet}     ouverture, x-cockpit-confirm: 1
//   PUT  /api/conversations/:rootId/autonomie   {choix: "omo", plafondUsd}, x-cockpit-confirm: 1, à CHAQUE demande
//   POST /api/omo/oc/session/:rootId/prompt_async?directory=…  {parts, model}, x-cockpit-confirm: 1 (IA obligatoire, voir envoyer)
//
// Trois règles tiennent cette bibliothèque :
// 1. **Le montant part en CHAÎNE**, telle que saisie, jamais en nombre JSON : c'est le serveur qui la juge (L22a) et refuse en
//    409. Aucune valeur par défaut n'est fabriquée ici (§7.6 : « aucune valeur de plafond par défaut ») ; les portes qui
//    éprouvent les refus (champ vide, hors bornes) passent la chaîne qu'elles veulent.
// 2. **Jamais d'envoi sans activation acceptée** : `activerPuisEnvoyer` n'envoie que sur un 2xx de l'activation. Un banc qui
//    enverrait malgré un refus prouverait le contraire de ce qu'il cherche.
// 3. **Aucun secret ne sort** : le jeton du cockpit ne quitte jamais le client de session (e2e/lib/cockpit.mjs), qui n'envoie que
//    des signatures ; les réponses rendues sont des codes et des corps JSON du cockpit, qui n'en portent aucun (§4.12 l.784).
//
// Le cockpit du banc sert en HTTP explicite sur la boucle locale (COCKPIT_LOCAL_SCHEME=http, confirmé à l'instant) : pas de
// certificat à épingler dans une pile qui vit dix minutes. Aucune dépendance npm (P8).
import { attendreSante, creerClientCockpit } from "../../lib/cockpit.mjs";

/** En-tête de confirmation exigé par chaque geste qui ouvre ou relâche un choix automatique. */
export const CONFIRMATION = Object.freeze({ "x-cockpit-confirm": "1" });

/** États de la salle rendus par `GET /api/omo/status` (`OmoEtatSalle`, T3a). */
export const ETATS_SALLE = Object.freeze(["coupee", "arretee", "en-relance", "prete", "demande-active", "suspendue"]);

const enc = encodeURIComponent;

const lireJson = (texte) => {
  try {
    return texte === "" ? null : JSON.parse(texte);
  } catch {
    return null;
  }
};

/** Réponse brute du client de session réduite à ce qu'une porte lit : code, JSON (ou null), code d'erreur du cockpit. */
const rendre = (r) => {
  const json = lireJson(r.corps);
  let erreur = null;
  if (typeof json?.error === "string") erreur = json.error;
  else if (typeof json?.code === "string") erreur = json.code;
  return { code: r.code, json, erreur };
};

/**
 * Ouvre la session du banc sur le cockpit réel : attente de `/api/health`, puis connexion par ticket signé (jamais le jeton en
 * clair sur le réseau). `jeton` : 64 hexadécimaux, tiré par le banc et jamais affiché.
 */
export async function connecterCockpit({ port, jeton, hote = "127.0.0.1", delaiMs = 180_000 }) {
  if (!Number.isInteger(port) || port <= 0 || port > 65535) throw new Error(`port du cockpit du banc invalide : ${port}`);
  if (typeof jeton !== "string" || !/^[0-9a-f]{64}$/.test(jeton)) throw new Error("jeton du cockpit du banc hors format (64 hexadécimaux attendus)");
  const url = `http://${hote}:${port}`;
  await attendreSante(url, { delaiMs });
  const client = creerClientCockpit(url, jeton);
  await client.connecter();
  return client;
}

/** Mode Avancé : la salle n'existe qu'en Avancé (§4.14.1). `ui.mode` est l'un des réglages permis en Simple. */
export async function passerEnAvance(client) {
  return rendre(await client.brut("PUT", "/api/settings", { ui: { mode: "avance" } }));
}

/** `GET /api/bootstrap` : `omo {enabled, imageChargee, salleOuverte}` y dit si la porte du code est ouverte dans CETTE copie. */
export async function amorce(client) {
  return rendre(await client.brut("GET", "/api/bootstrap"));
}

/** `GET /api/omo/status`. */
export async function statutSalle(client) {
  return rendre(await client.brut("GET", "/api/omo/status"));
}

/** Attend que l'état de la salle soit l'un de `etats`. Rend `{ ok, etat, statut, attenteMs }`, jamais une exception. */
export async function attendreEtatSalle(client, etats, { delaiMs = 120_000, pasMs = 1000 } = {}) {
  const voulus = new Set(etats);
  const debut = Date.now();
  let dernier = null;
  for (;;) {
    try {
      dernier = await statutSalle(client);
    } catch (err) {
      dernier = { code: 0, json: null, erreur: String(err?.message ?? err).slice(0, 120) };
    }
    const etat = dernier?.json?.etatSalle ?? null;
    if (etat !== null && voulus.has(etat)) return { ok: true, etat, statut: dernier, attenteMs: Date.now() - debut };
    if (Date.now() - debut >= delaiMs) return { ok: false, etat, statut: dernier, attenteMs: Date.now() - debut };
    await new Promise((r) => setTimeout(r, pasMs));
  }
}

/** `POST /api/omo/rooms {projet}`, confirmé. `projet` : chemin RELATIF au dossier de travail (ex. « projet-ouvert »). */
export async function ouvrirSalle(client, projet, { confirmer = true } = {}) {
  const r = rendre(await client.brut("POST", "/api/omo/rooms", { projet }, confirmer ? { entetes: CONFIRMATION } : {}));
  return { ...r, rootId: typeof r.json?.rootId === "string" ? r.json.rootId : null, projet: r.json?.projet ?? null };
}

/**
 * `PUT …/autonomie {choix: "omo", plafondUsd}`, confirmé. `plafondUsd` est une CHAÎNE (règle 1) : un nombre est refusé ici,
 * avant tout appel, parce que l'envoyer serait déjà un écart au contrat (`OmoActivationBody.plafondUsd: string`).
 */
export async function activer(client, rootId, plafondUsd, { confirmer = true } = {}) {
  if (typeof plafondUsd !== "string") throw new TypeError("plafondUsd : une chaîne saisie, jamais un nombre JSON (OmoActivationBody)");
  const corps = { choix: "omo", plafondUsd };
  return rendre(await client.brut("PUT", `/api/conversations/${enc(rootId)}/autonomie`, corps, confirmer ? { entetes: CONFIRMATION } : {}));
}

/**
 * Envoi d'un message dans la salle, par le proxy de l'instance (L18b), même route que la page (`envoyerMessageOmo`). L'IA est
 * OBLIGATOIRE (`model: {providerID, modelID}`) : le proxy passe toute demande facturée, salle comprise, par `enforceTurn`, qui
 * refuse en 400 « modele-requis » un corps sans IA (mesuré au banc le 24/09 ; la page de la salle envoyait `{parts}` seul, constat
 * corrigé au train de la vague 4). Refusé ici, avant tout appel, plutôt que de laisser croire qu'un envoi a été tenté.
 */
export async function envoyer(client, rootId, directory, texte, { model, agent, confirmer = true } = {}) {
  if (!modeleValide(model)) throw new TypeError("envoyer : model {providerID, modelID} obligatoire (400 « modele-requis » sinon)");
  const corps = { parts: [{ type: "text", text: String(texte) }], model: { providerID: model.providerID, modelID: model.modelID }, ...(agent ? { agent } : {}) };
  const chemin = `/api/omo/oc/session/${enc(rootId)}/prompt_async?directory=${enc(directory)}`;
  const options = confirmer ? { entetes: CONFIRMATION } : {};
  const premier = rendre(await client.brut("POST", chemin, corps, options));
  // 409 « assistant-model-changed » : l'assistant de la salle a son IA, et le proxy demande de renvoyer UNE fois avec elle
  // (AssistantModelChangedError, comme ChatPage.sendTurn). Ce refus vient d'enforceTurn, AVANT les crochets : le jeton
  // d'activation n'a pas été consommé. Jamais un second renvoi.
  if (premier.code === 409 && premier.erreur === "assistant-model-changed" && modeleValide(premier.json?.model)) {
    const imposee = { providerID: premier.json.model.providerID, modelID: premier.json.model.modelID };
    const variant = typeof premier.json.variant === "string" && premier.json.variant !== "" ? premier.json.variant : null;
    const second = rendre(await client.brut("POST", chemin, { ...corps, model: imposee, ...(variant ? { variant } : {}) }, options));
    return { ...second, renvoye: true, model: imposee };
  }
  return { ...premier, renvoye: false, model: corps.model };
}

const modeleValide = (m) => typeof m?.providerID === "string" && m.providerID !== "" && typeof m?.modelID === "string" && m.modelID !== "";

/**
 * IA Copilot que la SALLE sert vraiment, lue dans `GET /config/providers` de la salle (réponse passée ici) : `preferee` si elle
 * y est, sinon la première du fournisseur `github-copilot` dans l'ordre des noms. null si aucune : pas d'envoi à l'aveugle.
 */
export function modeleDeLaSalle(providers, preferee = "faux-m1") {
  const liste = Array.isArray(providers?.providers) ? providers.providers : Array.isArray(providers) ? providers : [];
  const copilot = liste.find((p) => p?.id === "github-copilot");
  const ids = Object.keys(copilot?.models ?? {}).sort((a, b) => a.localeCompare(b));
  if (ids.length === 0) return null;
  return { providerID: "github-copilot", modelID: ids.includes(preferee) ? preferee : ids[0] };
}

/**
 * Activation puis envoi, comme le bouton de la page : l'envoi ne part QUE si l'activation a été acceptée (règle 2). Rend les deux
 * réponses ; `envoi` vaut null quand rien n'a été envoyé, et `envoye` le dit en clair.
 */
export async function activerPuisEnvoyer(client, { rootId, directory, plafondUsd, texte, model, agent }) {
  const activation = await activer(client, rootId, plafondUsd);
  if (activation.code < 200 || activation.code >= 300) return { activation, envoi: null, envoye: false };
  const envoi = await envoyer(client, rootId, directory, texte, { model, agent });
  return { activation, envoi, envoye: envoi.code >= 200 && envoi.code < 300 };
}
