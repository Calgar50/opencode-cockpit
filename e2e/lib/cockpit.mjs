// Banc e2e (L7a) : parler au cockpit de la pile jetable, et relever ce que le faux opencode a reçu.
//
// Depuis R105b, le cockpit du banc sert en HTTPS par défaut, comme une installation 1.0.5, et le banc s'y connecte comme
// « cockpit.ps1 open » :
//   1. certificat public et empreintes lus sur le volume cockpit-tls de la pile jetable (docker-e2e.mjs), puis
//      contre-vérifiés ici (verifierCertificatPublic) ;
//   2. HTTPS épinglé : ce certificat seul pour autorité, vérification TLS complète (nom compris), et empreinte comparée à
//      chaque poignée de main. Jamais « -k », jamais NODE_TLS_REJECT_UNAUTHORIZED=0, jamais rejectUnauthorized: false ;
//   3. preuve du jeton sur /api/health, puis connexion par ticket à usage unique (/auth?k=), cookie « __Host-cockpit_session ».
// Le mode HTTP explicite de la 1.0.5 reste disponible par « run-e2e.sh --http » : mêmes étapes 3, par fetch, sans TLS.
import crypto from "node:crypto";
import https from "node:https";
import tls from "node:tls";

const attendre = (ms) => new Promise((r) => setTimeout(r, ms));

/** Signature HMAC-SHA256 du contrat 1.0.5 (« opencode-cockpit/<usage>/v1\n<valeur> »), en hexadécimal. */
const signer = (jeton, usage, valeur) => crypto.createHmac("sha256", jeton).update(`opencode-cockpit/${usage}/v1\n${valeur}`).digest("hex");

/** Seul nom de cookie de session lu par le cockpit depuis la 1.0.5. */
const COOKIE_SESSION = "__Host-cockpit_session";

// --- HTTPS épinglé -------------------------------------------------------------------------------

/** Empreinte SHA-256 d'un certificat, au format de X509Certificate.fingerprint256 (« AB:CD:… »). */
const EMPREINTE = /^(?:[0-9A-F]{2}:){31}[0-9A-F]{2}$/;
/** Condensé SHA-256 de la clé publique (SPKI DER) en base64 : format de curl --pinnedpubkey et de Chromium. */
export const SPKI_BASE64 = /^[A-Za-z0-9+/]{43}=$/;
/** Code des erreurs d'épinglage : un autre certificat que celui du volume ne mérite aucune nouvelle tentative. */
export const CODE_EMPREINTE = "E2E_EMPREINTE_DIFFERENTE";
/** Taille maximale d'une réponse du cockpit lue par le banc (une page d'accueil ou un JSON d'état tiennent largement). */
const MAX_REPONSE = 16 * 1024 * 1024;

const spkiDe = (x509) => crypto.createHash("sha256").update(x509.publicKey.export({ type: "spki", format: "der" })).digest("base64");

/**
 * Contre-vérifie le certificat public et cockpit-tls.json lus sur le volume, comme ConvertTo-CockpitTlsState
 * (CockpitTls.ps1) : un seul certificat, aucune clé privée, empreintes du JSON égales à celles recalculées, clé ECDSA
 * P-256, feuille qui n'est pas une autorité, adresse 127.0.0.1 couverte, dates valables. Rend l'épinglage du banc :
 * certificat (seule autorité acceptée), empreinte du certificat et condensé de sa clé publique. Aucun secret.
 */
export function verifierCertificatPublic(pem, texteJson, maintenant = new Date()) {
  const texte = String(pem ?? "");
  const json = String(texteJson ?? "");
  if (/PRIVATE KEY/i.test(texte) || /PRIVATE KEY/i.test(json)) throw new Error("clé privée présente dans les fichiers publics du volume : refusé.");
  const blocs = texte.match(/-----BEGIN CERTIFICATE-----[A-Za-z0-9+/=\s]+?-----END CERTIFICATE-----/g) ?? [];
  if (blocs.length !== 1) throw new Error(`${blocs.length} certificat(s) dans cockpit.crt : exactement un attendu.`);
  let x509;
  try {
    x509 = new crypto.X509Certificate(blocs[0]);
  } catch {
    throw new Error("cockpit.crt illisible (structure X.509 invalide).");
  }
  let info;
  try {
    info = JSON.parse(json);
  } catch {
    throw new Error("cockpit-tls.json illisible.");
  }
  if (typeof info?.sha256 !== "string" || !EMPREINTE.test(info.sha256)) throw new Error("cockpit-tls.json : empreinte SHA-256 absente ou mal formée.");
  if (info.sha256 !== x509.fingerprint256 || info.sha256Hex !== x509.fingerprint256.replaceAll(":", "").toLowerCase()) {
    throw new Error("empreinte de cockpit.crt différente de cockpit-tls.json.");
  }
  const spki = spkiDe(x509);
  if (info.spkiSha256Base64 !== spki) throw new Error("clé publique de cockpit.crt différente de cockpit-tls.json.");
  if (x509.publicKey.asymmetricKeyType !== "ec" || x509.publicKey.asymmetricKeyDetails?.namedCurve !== "prime256v1") {
    throw new Error("certificat inattendu : clé ECDSA P-256 attendue.");
  }
  if (x509.ca) throw new Error("certificat inattendu : une autorité, pas la feuille du cockpit.");
  if (x509.checkIP("127.0.0.1") !== "127.0.0.1") throw new Error("le certificat ne couvre pas l'adresse 127.0.0.1.");
  const instant = maintenant.getTime();
  if (x509.validToDate.getTime() <= instant) throw new Error(`certificat expiré depuis le ${x509.validToDate.toISOString()}.`);
  if (x509.validFromDate.getTime() > instant + 5 * 60_000) throw new Error("certificat pas encore valable : vérifiez l'horloge.");
  return { certificat: x509.toString(), sha256: x509.fingerprint256, spki, expireLe: x509.validToDate.toISOString() };
}

/**
 * Contrôle du pair à chaque poignée de main (checkServerIdentity de node:tls) : vérification usuelle du nom (ici
 * l'adresse 127.0.0.1), puis empreinte du certificat et condensé de sa clé publique égaux à ceux du volume. Rend une
 * erreur (connexion coupée avant tout envoi) ou undefined.
 */
export function controlerPair(hote, pair, epinglage) {
  const erreurNom = tls.checkServerIdentity(hote, pair);
  if (erreurNom) return erreurNom;
  let spki = null;
  try {
    spki = pair?.raw ? spkiDe(new crypto.X509Certificate(pair.raw)) : null;
  } catch {
    spki = null;
  }
  if (pair?.fingerprint256 !== epinglage.sha256 || spki !== epinglage.spki) {
    const erreur = new Error(`certificat servi différent de celui du volume (empreinte ${pair?.fingerprint256 ?? "absente"}).`);
    erreur.code = CODE_EMPREINTE;
    return erreur;
  }
  return undefined;
}

/** Réponse d'une requête épinglée, au sous-ensemble de l'interface Response dont le banc se sert. */
function entetesDe(res) {
  const entetes = new Headers();
  for (let i = 0; i + 1 < res.rawHeaders.length; i += 2) entetes.append(res.rawHeaders[i], res.rawHeaders[i + 1]);
  return entetes;
}

function reponseDe(res, corps, url) {
  const entetes = entetesDe(res);
  const status = res.statusCode ?? 0;
  return {
    status,
    ok: status >= 200 && status < 300,
    url,
    headers: entetes,
    text: async () => corps.toString("utf8"),
    json: async () => JSON.parse(corps.toString("utf8")),
  };
}

/**
 * Une requête HTTPS épinglée (node:https) : le certificat du volume est la seule autorité (ca), la vérification reste
 * exigée (rejectUnauthorized: true) et controlerPair compare l'empreinte. agent: false : aucune connexion réutilisée,
 * aucun proxy de l'environnement. Aucune redirection n'est suivie (le cockpit n'en sert qu'à /auth).
 *
 * `flux: true` : la réponse est rendue dès les en-têtes reçus, corps compris (`corps`, lu au fil de l'eau), pour un
 * flux d'événements (SSE) qui n'a pas de fin connue. Mêmes garanties TLS ; seuls changent la lecture du corps et le
 * délai, qui ne couvre alors que l'établissement de la connexion. `signal` ferme le flux.
 */
function requeteEpinglee(base, chemin, { method = "GET", headers = {}, body, delaiMs = 60_000, flux = false, signal = null } = {}, epinglage) {
  const url = `${base.origin}${chemin}`;
  // Pour les messages : jamais la requête (défi, demande signée, ticket).
  const sansRequete = chemin.split("?")[0];
  return new Promise((resolve, reject) => {
    const requete = https.request(
      {
        hostname: base.hostname,
        port: base.port,
        path: chemin,
        method,
        headers,
        ca: epinglage.certificat,
        rejectUnauthorized: true,
        checkServerIdentity: (hote, pair) => controlerPair(hote, pair, epinglage),
        agent: false,
        timeout: delaiMs,
        ...(signal ? { signal } : {}),
      },
      (res) => {
        if (flux) {
          // Le corps est rendu tel quel : c'est le lecteur qui le consomme et qui voit ses erreurs. Plus de délai
          // d'inactivité une fois le flux ouvert (un flux d'événements se tait entre deux trames).
          requete.setTimeout(0);
          const status = res.statusCode ?? 0;
          resolve({ status, ok: status >= 200 && status < 300, url, headers: entetesDe(res), corps: res });
          return;
        }
        const morceaux = [];
        let taille = 0;
        res.on("data", (morceau) => {
          taille += morceau.length;
          if (taille > MAX_REPONSE) {
            res.destroy(new Error(`réponse de plus de ${MAX_REPONSE} octets sur ${sansRequete}.`));
            return;
          }
          morceaux.push(morceau);
        });
        res.on("error", reject);
        res.on("end", () => resolve(reponseDe(res, Buffer.concat(morceaux), url)));
      },
    );
    requete.on("timeout", () => requete.destroy(new Error(`délai de ${delaiMs} ms dépassé sur ${sansRequete}.`)));
    requete.on("error", reject);
    if (body !== undefined) requete.write(body);
    requete.end();
  });
}

/**
 * Accès au cockpit : fetch en mode HTTP explicite, requête épinglée en HTTPS. Une adresse https:// sans épinglage est
 * refusée : le banc ne se rabat jamais sur une vérification coupée. `chemin` est toujours un chemin absolu du cockpit.
 * Avec `flux: true`, les deux modes rendent la même forme : { status, ok, url, headers, corps }, où `corps` est lu au
 * fil de l'eau (flux d'événements).
 */
export function creerTransport(url, epinglage = null) {
  let base;
  try {
    base = new URL(url);
  } catch {
    throw new Error(`adresse du cockpit invalide : « ${url} ».`);
  }
  if (base.protocol === "https:") {
    if (!epinglage || typeof epinglage.certificat !== "string" || !EMPREINTE.test(epinglage.sha256 ?? "") || !SPKI_BASE64.test(epinglage.spki ?? "")) {
      throw new Error("HTTPS sans épinglage complet (certificat, empreinte, clé publique) : refusé, le banc ne coupe jamais la vérification TLS.");
    }
  } else if (base.protocol === "http:") {
    if (epinglage) throw new Error("épinglage donné pour une adresse http:// : mode incohérent.");
  } else {
    throw new Error(`schéma refusé : « ${base.protocol} ».`);
  }
  const verifierChemin = (chemin) => {
    if (typeof chemin !== "string" || !chemin.startsWith("/") || chemin.startsWith("//")) throw new Error(`chemin du cockpit refusé : « ${chemin} ».`);
  };
  if (base.protocol === "http:") {
    return async (chemin, options = {}) => {
      verifierChemin(chemin);
      const reponse = await fetch(`${base.origin}${chemin}`, options);
      if (!options.flux) return reponse;
      return { status: reponse.status, ok: reponse.ok, url: reponse.url, headers: reponse.headers, corps: reponse.body };
    };
  }
  return async (chemin, options = {}) => {
    verifierChemin(chemin);
    return await requeteEpinglee(base, chemin, options, epinglage);
  };
}

/**
 * Attend que le cockpit réponde à /api/health (le conteneur démarre avant d'écouter). En HTTPS, un certificat servi
 * autre que celui du volume arrête l'attente tout de suite : ce n'est pas un démarrage lent.
 */
export async function attendreSante(url, { epinglage = null, delaiMs = 120_000 } = {}) {
  const requete = creerTransport(url, epinglage);
  const limite = Date.now() + delaiMs;
  let derniere = "aucune réponse";
  while (Date.now() < limite) {
    try {
      const reponse = await requete("/api/health", { delaiMs: 10_000 });
      if (reponse.ok) return await reponse.json();
      derniere = `code ${reponse.status}`;
    } catch (err) {
      if (err?.code === CODE_EMPREINTE) throw err;
      derniere = err?.cause?.code ?? err?.code ?? err?.message ?? String(err);
    }
    await attendre(500);
  }
  throw new Error(`le cockpit ne répond pas sur ${url} (${derniere}).`);
}

/**
 * Client d'API du cockpit pour les scénarios : cookie de session tenu à la main (aucune dépendance), en-tête
 * anti-CSRF sur toute écriture. Le jeton n'est jamais journalisé ni rendu. `epinglage` est exigé en HTTPS.
 */
export function creerClientCockpit(url, jeton, epinglage = null) {
  let cookie = null;
  const requete = creerTransport(url, epinglage);
  const origine = new URL(url).origin;

  const appeler = async (methode, chemin, corps, { headers: enPlus, ...options } = {}) => {
    const entetes = { "x-cockpit-csrf": "1", origin: origine, ...enPlus };
    if (cookie) entetes.cookie = cookie;
    if (corps !== undefined) entetes["content-type"] = "application/json";
    const reponse = await requete(chemin, {
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
    /** Réponse brute (code, en-têtes et corps), pour les scénarios qui attendent un refus ou lisent un en-tête (CSP). */
    async brut(methode, chemin, corps) {
      const reponse = await appeler(methode, chemin, corps);
      return { code: reponse.status, entetes: reponse.headers, corps: await reponse.text() };
    },
    /**
     * Ouvre un flux d'événements (SSE) du cockpit par le transport du banc : HTTPS épinglé par défaut (certificat du
     * volume pour seule autorité, empreinte contrôlée à chaque poignée de main), fetch en mode HTTP explicite. Rend
     * { ok, status, corps }, où `corps` est lu au fil de l'eau ; `signal` ferme le flux. Le cookie de session est
     * celui de ce client : aucune autre donnée d'authentification n'est lue ni écrite ici.
     */
    async flux(chemin, { signal = null, accept = "text/event-stream" } = {}) {
      return await appeler("GET", chemin, undefined, { flux: true, signal, headers: { accept } });
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
    // Cookie « __Host- », donc « Secure » : naturel en HTTPS, et accepté aussi en mode --http sur 127.0.0.1, que les
    // navigateurs tiennent pour une origine sûre (mesuré pour la 1.0.5).
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
    // [3d] début : rejeu d'une suite d'événements (itération 3, L35 ; M20). Sans ce client, la route de pilotage
    // « POST /banc/emettre » du faux (e2e/fake-opencode-server.ts) resterait injoignable depuis un scénario, qui ne connaît ni
    // l'adresse ni le jeton du pilotage. Aucun tour joué, aucune IA, aucune facturation.
    async emettre(evenements) {
      return await appeler("POST", "/banc/emettre", { evenements });
    },
    // [3d] fin
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
