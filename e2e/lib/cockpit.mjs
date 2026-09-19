// Banc e2e (L7a) : parler au cockpit de la pile jetable, et relever ce que le faux opencode a reçu.
//
// Depuis R105 (intégration de la 1.0.5), le cockpit du banc sert dans le mode HTTP explicite de la 1.0.5 (date de
// confirmation posée par docker-e2e.mjs) : connexion par ticket à usage unique, cookie « __Host-cockpit_session ». La
// bascule en HTTPS épinglé (D-05) reste à faire : les endroits à reprendre portent la mention D-05.
import crypto from "node:crypto";

const attendre = (ms) => new Promise((r) => setTimeout(r, ms));

/** Signature HMAC-SHA256 du contrat 1.0.5 (« opencode-cockpit/<usage>/v1\n<valeur> »), en hexadécimal. */
const signer = (jeton, usage, valeur) => crypto.createHmac("sha256", jeton).update(`opencode-cockpit/${usage}/v1\n${valeur}`).digest("hex");

/** Seul nom de cookie de session lu par le cockpit depuis la 1.0.5. */
const COOKIE_SESSION = "__Host-cockpit_session";

/** Attend que le cockpit réponde à /api/health (le conteneur démarre avant d'écouter). */
export async function attendreSante(url, delaiMs = 120_000) {
  const limite = Date.now() + delaiMs;
  let derniere = "aucune réponse";
  while (Date.now() < limite) {
    try {
      // D-05 : mode HTTP explicite de la 1.0.5 ; plus tard HTTPS épinglé, jamais « -k ».
      const reponse = await fetch(`${url}/api/health`);
      if (reponse.ok) return await reponse.json();
      derniere = `code ${reponse.status}`;
    } catch (err) {
      derniere = err?.cause?.code ?? err?.message ?? String(err);
    }
    await attendre(500);
  }
  throw new Error(`le cockpit ne répond pas sur ${url} (${derniere}).`);
}

/**
 * Client d'API du cockpit pour les scénarios : cookie de session tenu à la main (aucune dépendance), en-tête
 * anti-CSRF sur toute écriture. Le jeton n'est jamais journalisé ni rendu.
 */
export function creerClientCockpit(url, jeton) {
  let cookie = null;

  const appeler = async (methode, chemin, corps, options = {}) => {
    const entetes = { "x-cockpit-csrf": "1", origin: url };
    if (cookie) entetes.cookie = cookie;
    if (corps !== undefined) entetes["content-type"] = "application/json";
    const reponse = await fetch(`${url}${chemin}`, {
      method: methode,
      headers: entetes,
      body: corps === undefined ? undefined : JSON.stringify(corps),
      ...options,
    });
    const brut = reponse.headers.getSetCookie?.() ?? [];
    for (const valeur of brut) {
      // Seul le nom préfixé compte : la 1.0.5 envoie aussi l'effacement de l'ancien nom (« cockpit_session=; Max-Age=0 »).
      const [paire] = valeur.split(";");
      if (paire.startsWith(`${COOKIE_SESSION}=`) && paire.length > COOKIE_SESSION.length + 1) cookie = paire;
    }
    return reponse;
  };

  return {
    /**
     * Ouvre la session du banc comme « cockpit.ps1 open » (1.0.5) : défi et demande de ticket signés par le jeton sur
     * /api/health, preuve du jeton vérifiée, puis /auth?k= avec le ticket signé. POST /api/login est refusé en mode HTTP.
     * Le jeton ne sort jamais d'ici : seules des signatures partent sur le réseau.
     */
    async connecter() {
      const defi = crypto.randomBytes(32).toString("hex");
      const sante = await appeler("GET", `/api/health?challenge=${defi}&ticket=${signer(jeton, "auth-ticket-request", defi)}`);
      if (!sante.ok) throw new Error(`demande de ticket refusée (code ${sante.status}).`);
      const corps = await sante.json();
      if (corps?.proof !== signer(jeton, "health-proof", defi)) throw new Error("le cockpit n'a pas prouvé connaître le jeton du banc.");
      const ticket = typeof corps.ticket === "string" ? corps.ticket : "";
      if (!/^[0-9a-f]{64}$/.test(ticket)) throw new Error("ticket de connexion absent de /api/health.");
      const reponse = await appeler("GET", `/auth?k=${ticket}.${signer(jeton, "auth-ticket", ticket)}`, undefined, { redirect: "manual" });
      if (reponse.status !== 303 || reponse.headers.get("location") !== "/") {
        throw new Error(`connexion au cockpit refusée (code ${reponse.status}, retour ${reponse.headers.get("location") ?? "aucun"}).`);
      }
      if (!cookie) throw new Error("connexion au cockpit sans cookie de session.");
      return true;
    },
    get cookie() {
      return cookie;
    },
    async get(chemin) {
      return await lireJson(await appeler("GET", chemin));
    },
    async post(chemin, corps) {
      return await lireJson(await appeler("POST", chemin, corps ?? {}));
    },
    async put(chemin, corps) {
      return await lireJson(await appeler("PUT", chemin, corps ?? {}));
    },
    /** Réponse brute (code et corps), pour les scénarios qui attendent un refus. */
    async brut(methode, chemin, corps) {
      const reponse = await appeler(methode, chemin, corps);
      return { code: reponse.status, corps: await reponse.text() };
    },
  };
}

async function lireJson(reponse) {
  const texte = await reponse.text();
  if (!reponse.ok) throw new Error(`${reponse.status} sur ${reponse.url.replace(/\?.*$/, "")} : ${texte.slice(0, 200)}`);
  return texte ? JSON.parse(texte) : null;
}

/**
 * Attend que le cockpit joigne opencode. Un vrai opencode 1.18.30 met plusieurs secondes à écouter et à charger ses
 * instances : sans cette attente, les premières requêtes d'un scénario reçoivent 502 « opencode injoignable ».
 */
export async function attendreOpencode(client, delaiMs = 180_000) {
  const limite = Date.now() + delaiMs;
  let dernier = "aucune réponse";
  while (Date.now() < limite) {
    try {
      const bootstrap = await client.get("/api/bootstrap");
      if (bootstrap?.opencode?.reachable === true) return bootstrap;
      dernier = JSON.stringify(bootstrap?.opencode ?? null);
    } catch (err) {
      dernier = err?.message ?? String(err);
    }
    await attendre(1_000);
  }
  throw new Error(`le cockpit ne joint pas opencode après ${Math.round(delaiMs / 1000)} s (${dernier}).`);
}

/**
 * Ouvre la session du cockpit dans la page, en y posant le cookie obtenu par le client d'API. Le jeton n'entre jamais
 * dans le navigateur : ni dans l'adresse (jamais « /auth?t= », qui le laisserait dans l'historique et les captures),
 * ni dans une expression évaluée. La page n'est chargée qu'une fois, déjà connectée : aucune réponse 401 ne vient
 * salir la console d'un scénario.
 */
export async function connecterNavigateur(onglet, url, cookie) {
  if (!cookie) throw new Error("connexion du navigateur demandée sans cookie de session.");
  const separateur = cookie.indexOf("=");
  await onglet.poserCookie({
    name: cookie.slice(0, separateur),
    value: cookie.slice(separateur + 1),
    url,
    path: "/",
    httpOnly: true,
    // D-05 : cookie « __Host- » donc « Secure », accepté en HTTP sur 127.0.0.1, que les navigateurs tiennent pour une origine sûre.
    secure: true,
    sameSite: "Strict",
  });
  await onglet.aller(`${url}/`);
  return true;
}

/**
 * Client de l'interface de pilotage du banc (faux opencode, faux fournisseur) : relevé des requêtes reçues et
 * écriture des réponses à jouer. Elle n'est jamais servie par le cockpit et n'existe que dans la pile jetable.
 */
export function relevesDuBanc(url, jeton) {
  const appeler = async (methode, chemin, corps) => {
    const reponse = await fetch(`${url}${chemin}`, {
      method: methode,
      headers: { "x-banc-jeton": jeton, ...(corps === undefined ? {} : { "content-type": "application/json" }) },
      body: corps === undefined ? undefined : JSON.stringify(corps),
    });
    if (!reponse.ok) throw new Error(`pilotage du banc : ${reponse.status} sur ${chemin}`);
    return await reponse.json();
  };
  return {
    async attendre(delaiMs = 60_000) {
      const limite = Date.now() + delaiMs;
      let derniere = "aucune réponse";
      while (Date.now() < limite) {
        try {
          return await appeler("GET", "/banc/etat");
        } catch (err) {
          derniere = err?.cause?.code ?? err?.message ?? String(err);
        }
        await attendre(500);
      }
      throw new Error(`le faux du banc ne répond pas sur ${url} (${derniere}).`);
    },
    /** Requêtes reçues, dans l'ordre : méthode, chemin, paramètres et corps. */
    async requetes() {
      return (await appeler("GET", "/banc/requetes")).requetes;
    },
    /** Blocs diffusés sur le flux d'événements (hors battements). */
    async evenements() {
      return (await appeler("GET", "/banc/evenements")).evenements;
    },
    /** Tours à jouer pour une conversation donnée. */
    async scripter(sessionID, ...tours) {
      return await appeler("POST", "/banc/script", { sessionID, tours });
    },
    /** Tour joué quand aucun script n'attend. */
    async tourParDefaut(tour) {
      return await appeler("POST", "/banc/defaut", { tour });
    },
    /** Vide le relevé (début d'un scénario). */
    async oublier() {
      return await appeler("POST", "/banc/oublier", {});
    },
  };
}

/** Comparaison sans fuite de durée, pour le jeton de pilotage du banc. */
export function memeSecret(donne, attendu) {
  const a = crypto.createHash("sha256").update(String(donne ?? "")).digest();
  const b = crypto.createHash("sha256").update(String(attendu ?? "")).digest();
  return crypto.timingSafeEqual(a, b);
}
