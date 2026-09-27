// Banc e2e (L7a) : navigateur sans dépendance, piloté par le protocole CDP (D-06).
//
// Node 24 apporte WebSocket et fetch en natif : il ne manque qu'un navigateur, Edge ou Chromium, lancé en mode sans
// fenêtre sur un profil temporaire neuf. Aucun paquet npm n'est ajouté (P8).
//
// Isolation : profil jeté à chaque exécution, résolution de noms coupée (seule la boucle locale reste joignable),
// aucune mise à jour ni service d'arrière-plan, aucune extension.
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

/** Emplacements usuels d'Edge et de Chromium ; E2E_NAVIGATEUR a toujours la priorité. */
const CANDIDATS = [
  process.env.E2E_NAVIGATEUR,
  "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
  "C:/Program Files/Microsoft/Edge/Application/msedge.exe",
  "C:/Program Files/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
  "/usr/bin/microsoft-edge",
  "/usr/bin/chromium",
  "/usr/bin/chromium-browser",
  "/usr/bin/google-chrome",
];

/** Tailles demandées par la fiche L7a, dans les deux thèmes. */
export const TAILLES = [
  { nom: "1440", largeur: 1440, hauteur: 900 },
  { nom: "1024", largeur: 1024, hauteur: 768 },
  { nom: "400", largeur: 400, hauteur: 860 },
];
export const THEMES = ["clair", "sombre"];

export function trouverNavigateur() {
  for (const candidat of CANDIDATS) {
    if (candidat && fs.existsSync(candidat)) return candidat;
  }
  throw new Error("aucun navigateur trouvé : installez Edge ou Chromium, ou indiquez son chemin dans E2E_NAVIGATEUR.");
}

const attendre = (ms) => new Promise((r) => setTimeout(r, ms));

/** Port du protocole, écrit par le navigateur dans son profil dès qu'il écoute. */
async function lirePortDevTools(dossierProfil, delaiMs = 30_000) {
  const fichier = path.join(dossierProfil, "DevToolsActivePort");
  const limite = Date.now() + delaiMs;
  while (Date.now() < limite) {
    try {
      const lignes = fs.readFileSync(fichier, "utf8").split("\n");
      const port = Number(lignes[0]);
      if (Number.isInteger(port) && port > 0) return port;
    } catch {
      // Le navigateur n'a pas encore écrit le fichier.
    }
    await attendre(100);
  }
  throw new Error("le navigateur n'a pas ouvert son protocole de pilotage.");
}

/** Condensé SHA-256 d'une clé publique (SPKI DER) en base64, tel que Chromium l'attend. */
const SPKI_BASE64 = /^[A-Za-z0-9+/]{43}=$/;

// --- Réglage de mouvement (R106-b) -----------------------------------------------------------------------------------------------
//
// `prefers-reduced-motion` ne doit JAMAIS venir du poste : Windows passe en animations réduites avec les sessions RDP, le
// navigateur du banc rapporte alors « reduce », et le cockpit fait ce que la spécification demande (aucune transition WAAPI
// sur la carte, transitions CSS à 0,01 ms). Trois scénarios it1-ui tombaient ainsi selon l'état du poste (revue 5b,
// GF0-106, A29). Chaque scénario qui agit sur la page fixe donc son réglage (preparerPage : « no-preference » ; un scénario
// qui teste le mouvement réduit demande « reduce » explicitement), et le banc refuse, après coup, un scénario qui a agi sur
// la page pendant que le réglage était celui du poste (garde de R106-b, verdictMouvement).

/** Valeurs de `prefers-reduced-motion` (spécification CSS Media Queries 5). */
export const MOUVEMENTS = ["no-preference", "reduce"];

/**
 * Réglage de mouvement épinglé par `theme()` et par la fin de `captureSuite` tant que le scénario n'en a pas demandé un
 * autre : l'émulation remplace toute la liste à chaque envoi, et ces deux envois rendaient la page au réglage du poste.
 */
export const MOUVEMENT_DU_BANC = "no-preference";

/**
 * Drapeaux de Chromium qui SIMULENT le réglage d'animations du poste (« --poste-mouvement » du banc) : ils changent ce que
 * le navigateur rapporte sans émulation, exactement comme le réglage de Windows, et servent à rejouer les scénarios sur un
 * poste en animations réduites (ou normales) sans toucher au poste. L'émulation CDP les recouvre (mesuré le 26/09 sur
 * Edge 153 : « --force-prefers-reduced-motion », puis Emulation.setEmulatedMedia « no-preference » → no-preference).
 */
export const DRAPEAUX_POSTE_MOUVEMENT = { reduce: "--force-prefers-reduced-motion", "no-preference": "--force-prefers-no-reduced-motion" };

/** Relevé d'un scénario : réglage de mouvement en vigueur, envois à la page, et ceux faits au réglage du poste. */
export function nouveauSuivi() {
  return { mouvement: null, actions: 0, auPoste: [], pertes: 0 };
}

/**
 * Note un envoi du protocole à la page dans le relevé. `Emulation.setEmulatedMedia` fixe le réglage s'il porte
 * `prefers-reduced-motion`, et le rend au poste sinon (le protocole remplace toute la liste) ; tout autre envoi est une
 * action sur la page, comptée « au poste » tant qu'aucun réglage n'est fixé.
 */
export function noterEnvoi(suivi, methode, params = {}) {
  if (methode === "Emulation.setEmulatedMedia") {
    const valeur = (Array.isArray(params?.features) ? params.features : []).find((f) => f?.name === "prefers-reduced-motion")?.value;
    const avant = suivi.mouvement;
    suivi.mouvement = MOUVEMENTS.includes(valeur) ? valeur : null;
    if (avant !== null && suivi.mouvement === null) suivi.pertes++;
    return;
  }
  suivi.actions++;
  if (suivi.mouvement === null) suivi.auPoste.push(methode);
}

/**
 * Garde de R106-b : rend la raison du refus, ou null. Un scénario qui n'agit pas sur la page (scénarios d'API) passe ; un
 * scénario qui y agit doit avoir fixé `prefers-reduced-motion` AVANT sa première action et ne jamais l'avoir rendu au
 * poste ; `pageDit`, lu dans la page à la fin, doit être le réglage fixé.
 */
export function verdictMouvement(suivi, pageDit = null) {
  if (suivi.actions === 0) return null;
  const conseil = "appelez preparerPage(ctx) (ou onglet.mouvement(…)) avant d'agir sur la page";
  if (suivi.auPoste.length > 0) {
    const methodes = [...new Set(suivi.auPoste)].slice(0, 4).join(", ");
    return `réglage de mouvement du poste : ${suivi.auPoste.length} action(s) sur la page (${methodes}) sans prefers-reduced-motion fixé ; ${conseil}.`;
  }
  if (suivi.pertes > 0) return `réglage de mouvement rendu au poste : ${suivi.pertes} émulation(s) de média sans prefers-reduced-motion ; passez par theme() ou mouvement().`;
  if (suivi.mouvement === null) return `réglage de mouvement jamais fixé ; ${conseil}.`;
  if (pageDit !== null && pageDit !== suivi.mouvement) return `la page rapporte prefers-reduced-motion: ${pageDit} au lieu de ${suivi.mouvement} fixé par le scénario.`;
  return null;
}

/** Expression : réglage de mouvement que la page voit (« reduce » ou « no-preference »). */
export const EXPR_MOUVEMENT = "matchMedia('(prefers-reduced-motion: reduce)').matches ? 'reduce' : 'no-preference'";

/**
 * Arguments du navigateur. `spkiEpingle` (HTTPS du banc) : seul le certificat dont la clé publique a ce condensé est
 * accepté malgré son autorité inconnue (--ignore-certificate-errors-spki-list, que Chromium n'honore qu'avec un
 * --user-data-dir). Toute autre erreur de certificat reste bloquante : jamais --ignore-certificate-errors, jamais
 * Security.setIgnoreCertificateErrors. `posteMouvement` (« reduce » ou « no-preference ») simule le réglage d'animations
 * du poste (DRAPEAUX_POSTE_MOUVEMENT) ; null : le vrai réglage du poste.
 */
export function argumentsNavigateur(profil, { spkiEpingle = null, posteMouvement = null } = {}) {
  if (spkiEpingle !== null && !SPKI_BASE64.test(String(spkiEpingle))) throw new Error("condensé de clé publique épinglé mal formé.");
  if (posteMouvement !== null && !MOUVEMENTS.includes(posteMouvement)) throw new Error(`réglage de mouvement du poste inconnu : « ${posteMouvement} » (${MOUVEMENTS.join(", ")}).`);
  return [
    "--headless=new",
    "--remote-debugging-port=0",
    `--user-data-dir=${profil}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-extensions",
    "--disable-background-networking",
    "--disable-component-update",
    "--disable-sync",
    "--disable-default-apps",
    "--disable-features=Translate,MediaRouter,OptimizationHints",
    "--metrics-recording-only",
    "--mute-audio",
    "--hide-scrollbars",
    "--password-store=basic",
    "--use-mock-keychain",
    // Isolation : rien ne se résout hors de la boucle locale. Chromium applique aussi ces règles aux adresses IP
    // écrites en clair : sans l'exclusion, « https://127.0.0.1:port » donnerait ERR_NAME_NOT_RESOLVED.
    "--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1, EXCLUDE localhost",
    "--no-proxy-server",
    ...(spkiEpingle === null ? [] : [`--ignore-certificate-errors-spki-list=${spkiEpingle}`]),
    ...(posteMouvement === null ? [] : [DRAPEAUX_POSTE_MOUVEMENT[posteMouvement]]),
    "about:blank",
  ];
}

/**
 * Ouvre un navigateur sans fenêtre sur un profil temporaire neuf. En HTTPS, `spkiEpingle` est le condensé de la clé
 * publique du certificat lu sur le volume de la pile jetable. `posteMouvement` : voir argumentsNavigateur.
 */
export async function ouvrirNavigateur({ dossierProfil, executable = trouverNavigateur(), silencieux = true, spkiEpingle = null, posteMouvement = null } = {}) {
  // Profil neuf à chaque ouverture : Windows garde les fichiers du profil précédent verrouillés un moment après la
  // fermeture, et une exécution ne doit jamais s'arrêter là-dessus.
  const profil = `${dossierProfil}-${randomBytes(3).toString("hex")}`;
  fs.mkdirSync(profil, { recursive: true, mode: 0o700 });
  const processus = spawn(executable, argumentsNavigateur(profil, { spkiEpingle, posteMouvement }), { stdio: silencieux ? "ignore" : "inherit" });
  processus.on("error", (err) => {
    throw err;
  });
  const port = await lirePortDevTools(profil);
  const version = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json();
  const client = await connecter(version.webSocketDebuggerUrl);

  return {
    processus,
    client,
    version: version.Browser,
    async nouvelOnglet() {
      const { targetId } = await client.envoyer("Target.createTarget", { url: "about:blank" });
      const { sessionId } = await client.envoyer("Target.attachToTarget", { targetId, flatten: true });
      return await creerOnglet(client, sessionId, targetId);
    },
    /** Réglage de mouvement que le navigateur rapporte SANS émulation (celui du poste, ou celui de posteMouvement). */
    async mouvementDuPoste() {
      const onglet = await this.nouvelOnglet();
      try {
        return await onglet.evaluer(EXPR_MOUVEMENT);
      } finally {
        await onglet.fermer();
      }
    },
    async fermer() {
      // « Browser.close » fait quitter le navigateur ET ses processus de rendu. Tuer le seul processus lancé ne
      // suffit pas : sous Windows, Edge laisse alors des dizaines de processus enfants derrière lui, qui tiennent
      // en plus les fichiers du profil. La réponse n'arrive pas toujours (la prise se ferme d'abord) : on ne fait
      // que l'attendre un instant, puis on s'assure que le processus est bien parti.
      await Promise.race([client.envoyer("Browser.close").catch(() => {}), attendre(3_000)]);
      await client.fermer();
      const fini = new Promise((resolve) => processus.once("exit", resolve));
      await Promise.race([fini, attendre(3_000)]);
      if (processus.exitCode === null && processus.signalCode === null) {
        processus.kill();
        await Promise.race([fini, attendre(2_000)]);
      }
      // Windows garde les fichiers du profil un instant ; un profil qui résiste n'arrête jamais une exécution.
      try {
        fs.rmSync(profil, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
      } catch {
        // Profil encore tenu par Windows : il part avec le dossier temporaire de l'exécution.
      }
    },
  };
}

/** Connexion au protocole : une seule prise, les onglets passent par leur sessionId (mode « flatten »). */
async function connecter(url) {
  const prise = new WebSocket(url);
  await new Promise((resolve, reject) => {
    prise.addEventListener("open", resolve, { once: true });
    prise.addEventListener("error", () => reject(new Error("connexion au navigateur refusée")), { once: true });
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
  prise.addEventListener("close", () => {
    for (const attente of attentes.values()) attente.reject(new Error("le navigateur s'est fermé."));
    attentes.clear();
  });
  return {
    envoyer(methode, params = {}, sessionId) {
      const id = ++prochain;
      const message = { id, method: methode, params };
      if (sessionId) message.sessionId = sessionId;
      prise.send(JSON.stringify(message));
      return new Promise((resolve, reject) => attentes.set(id, { resolve, reject, methode }));
    },
    ecouter(fn) {
      ecouteurs.add(fn);
      return () => ecouteurs.delete(fn);
    },
    async fermer() {
      try {
        prise.close();
      } catch {
        // Prise déjà fermée : rien à faire.
      }
    },
  };
}

/**
 * Un onglet : navigation, évaluation, clavier, captures, erreurs de console et journal réseau. Exporté pour les gardes du
 * banc, qui le montent sur un client factice (aucun navigateur) pour vérifier l'émulation des médias.
 */
export async function creerOnglet(client, sessionId, targetId) {
  const erreurs = [];
  const reseau = [];
  // Trames du flux d'événements (SSE) reçues par la page : nom et instant seulement, jamais les données.
  const flux = [];
  let chargement = null;
  // Médias émulés (R106-b) : thème et mouvement partent TOUJOURS ensemble (emulerMedias), le protocole remplaçant toute la
  // liste à chaque envoi. `mouvement` null : aucun réglage demandé par le scénario, MOUVEMENT_DU_BANC est épinglé.
  const medias = { theme: null, mouvement: null };
  // Relevé du réglage de mouvement pendant un scénario (garde de R106-b) : null hors d'un scénario.
  let suivi = null;

  const arreterEcoute = client.ecouter((bloc) => {
    if (bloc.sessionId !== sessionId) return;
    const p = bloc.params ?? {};
    switch (bloc.method) {
      case "Runtime.consoleAPICalled":
        if (p.type === "error" || p.type === "assert") erreurs.push({ source: "console", texte: textePropre(p.args) });
        break;
      case "Runtime.exceptionThrown":
        erreurs.push({ source: "exception", texte: p.exceptionDetails?.exception?.description ?? p.exceptionDetails?.text ?? "exception" });
        break;
      case "Log.entryAdded":
        if (p.entry?.level === "error") erreurs.push({ source: p.entry.source ?? "journal", texte: p.entry.text ?? "", url: p.entry.url ?? "" });
        break;
      case "Network.requestWillBeSent":
        reseau.push({ id: p.requestId, methode: p.request?.method, url: p.request?.url, etat: "envoyée", envoyeeA: Date.now() });
        break;
      case "Network.responseReceived": {
        const ligne = reseau.find((r) => r.id === p.requestId);
        if (ligne) {
          ligne.etat = "reçue";
          ligne.code = p.response?.status;
        }
        break;
      }
      case "Network.eventSourceMessageReceived": {
        const ligne = reseau.find((r) => r.id === p.requestId);
        flux.push({ evenement: p.eventName || "message", url: ligne?.url ?? null, recuA: Date.now() });
        break;
      }
      case "Network.loadingFailed": {
        const ligne = reseau.find((r) => r.id === p.requestId);
        if (ligne) {
          ligne.etat = "échouée";
          ligne.raison = p.errorText;
        }
        break;
      }
      case "Page.loadEventFired":
        chargement?.();
        break;
      case "Page.javascriptDialogOpening":
        void client.envoyer("Page.handleJavaScriptDialog", { accept: false }, sessionId);
        erreurs.push({ source: "dialogue", texte: p.message ?? "" });
        break;
      default:
        break;
    }
  });

  const envoyer = (methode, params) => {
    if (suivi !== null) noterEnvoi(suivi, methode, params);
    return client.envoyer(methode, params, sessionId);
  };
  await envoyer("Page.enable");
  await envoyer("Runtime.enable");
  await envoyer("Log.enable");
  await envoyer("Network.enable");

  /** SEUL envoi de `Emulation.setEmulatedMedia` de l'onglet : thème (s'il est posé) et mouvement, toujours ensemble. */
  const emulerMedias = async () => {
    const features = [{ name: "prefers-reduced-motion", value: medias.mouvement ?? MOUVEMENT_DU_BANC }];
    if (medias.theme !== null) features.push({ name: "prefers-color-scheme", value: medias.theme === "sombre" ? "dark" : "light" });
    await envoyer("Emulation.setEmulatedMedia", { features });
  };

  const onglet = {
    sessionId,
    targetId,
    erreurs,
    reseau,

    async aller(url, { attendreChargement = true } = {}) {
      const promesse = attendreChargement ? new Promise((resolve) => (chargement = resolve)) : Promise.resolve();
      await envoyer("Page.navigate", { url });
      await Promise.race([promesse, attendre(20_000)]);
      chargement = null;
    },

    /** Évalue une expression dans la page. `secrete` retire l'expression des messages d'erreur (jeton de connexion). */
    async evaluer(expression, { secrete = false } = {}) {
      const resultat = await envoyer("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
      if (resultat.exceptionDetails) {
        const details = resultat.exceptionDetails.exception?.description ?? resultat.exceptionDetails.text;
        throw new Error(secrete ? `évaluation en échec : ${details}` : `évaluation en échec (${expression.slice(0, 80)}) : ${details}`);
      }
      return resultat.result?.value;
    },

    /** Attend qu'une expression rende une valeur vraie. */
    async attendreQue(expression, { delaiMs = 15_000, libelle = expression } = {}) {
      const limite = Date.now() + delaiMs;
      while (Date.now() < limite) {
        if (await onglet.evaluer(`Boolean(${expression})`)) return true;
        await attendre(150);
      }
      throw new Error(`attente dépassée : ${libelle}`);
    },

    /** Attend qu'un élément existe, puis rend son texte. */
    async texte(selecteur, options = {}) {
      await onglet.attendreQue(`document.querySelector(${JSON.stringify(selecteur)})`, { libelle: selecteur, ...options });
      return await onglet.evaluer(`document.querySelector(${JSON.stringify(selecteur)}).textContent`);
    },

    async cliquer(selecteur) {
      await onglet.attendreQue(`document.querySelector(${JSON.stringify(selecteur)})`, { libelle: selecteur });
      await onglet.evaluer(`document.querySelector(${JSON.stringify(selecteur)}).click()`);
    },

    /**
     * Frappe une touche (Tab, Enter, Escape, ArrowDown…). Le code virtuel Windows est celui d'un vrai clavier : sans lui, la
     * touche part avec 0 et le navigateur peut ne pas la servir lui-même (curseur natif, champ de saisie), même si les
     * gestionnaires de la page, qui lisent `event.key`, la voient.
     */
    async touche(nom) {
      const codes = { Tab: 9, Enter: 13, Escape: 27, Space: 32, End: 35, Home: 36, ArrowLeft: 37, ArrowUp: 38, ArrowRight: 39, ArrowDown: 40 };
      const commun = { key: nom, code: nom, windowsVirtualKeyCode: codes[nom] ?? 0, nativeVirtualKeyCode: codes[nom] ?? 0 };
      await envoyer("Input.dispatchKeyEvent", { type: "rawKeyDown", ...commun });
      if (nom === "Enter") await envoyer("Input.dispatchKeyEvent", { type: "char", text: "\r", ...commun });
      await envoyer("Input.dispatchKeyEvent", { type: "keyUp", ...commun });
    },

    /** Tape un texte caractère par caractère (clavier réel, pas une affectation de valeur). */
    async taper(texte) {
      for (const caractere of texte) {
        await envoyer("Input.dispatchKeyEvent", { type: "keyDown", text: caractere, key: caractere });
        await envoyer("Input.dispatchKeyEvent", { type: "keyUp", key: caractere });
      }
    },

    /** Élément qui a le focus : contrôle du parcours au clavier. */
    async focus() {
      return await onglet.evaluer("(() => { const e = document.activeElement; return e ? `${e.tagName.toLowerCase()}:${(e.getAttribute('aria-label') || e.textContent || '').trim().slice(0, 60)}` : ''; })()");
    },

    /** Pose un cookie avant la première navigation (session du cockpit, ouverte par le banc). */
    async poserCookie(cookie) {
      await envoyer("Network.setCookie", cookie);
    },

    /** Retire un cookie de l'onglet (`name`, `url`) : la session du navigateur tombe, celle du client d'API reste. */
    async effacerCookie(cookie) {
      await envoyer("Network.deleteCookies", cookie);
    },

    async taille({ largeur, hauteur }) {
      await envoyer("Emulation.setDeviceMetricsOverride", { width: largeur, height: hauteur, deviceScaleFactor: 1, mobile: false });
    },

    async theme(nom) {
      // Le réglage de mouvement part avec le thème (R106-b) : un envoi du thème seul rendait la page au réglage du poste.
      medias.theme = nom === "sombre" ? "sombre" : "clair";
      await emulerMedias();
    },

    /**
     * Fixe `prefers-reduced-motion` de la page (R106-b) : « no-preference » (preparerPage), ou « reduce » pour un scénario
     * qui teste justement le mouvement réduit. theme() et la fin de captureSuite le gardent ; seul un nouvel appel le change.
     */
    async mouvement(valeur) {
      if (!MOUVEMENTS.includes(valeur)) throw new Error(`réglage de mouvement refusé : « ${valeur} » (${MOUVEMENTS.join(", ")}).`);
      medias.mouvement = valeur;
      await emulerMedias();
    },

    /** Garde de R106-b : le banc commence le relevé du réglage de mouvement juste avant chaque scénario… */
    suivreMouvement() {
      suivi = nouveauSuivi();
    },

    /** …et le reprend juste après (null si aucun relevé n'était en cours). */
    finSuiviMouvement() {
      const releve = suivi;
      suivi = null;
      return releve;
    },

    // --- équipes (it4) : début ---
    /**
     * Émulation des requêtes de média de la page (`Emulation.setEmulatedMedia`), en UN SEUL envoi : `forced-colors`,
     * `prefers-reduced-motion` et, si on le demande, `prefers-color-scheme`. C'est la SEULE aide d'émulation de média du
     * banc (plan it4 §2.7) : `theme()` n'est pas touchée, et rien d'autre ici n'émule un média.
     *
     * Le protocole remplace la liste entière à chaque envoi : un `theme()` posé avant efface donc `forced-colors`, et
     * inversement. Pour une capture en contraste forcé dans un thème donné, tout se demande d'un coup :
     *   `await onglet.medias({ forcedColors: "active", reducedMotion: "reduce", theme: "sombre" })`.
     * `medias({})` rend la page à ses médias réels (liste vide), comme `captureSuite` le fait à la fin.
     *
     * Valeurs acceptées, celles de la spécification CSS : `forcedColors` « active » ou « none » ; `reducedMotion`
     * « reduce » ou « no-preference » ; `theme` « sombre » ou « clair ». Une valeur inconnue est refusée ici plutôt
     * qu'ignorée par le navigateur, qui rendrait une capture trompeuse.
     */
    async medias({ forcedColors = null, reducedMotion = null, theme = null } = {}) {
      const features = [];
      const ajouter = (name, valeur, permises) => {
        if (valeur === null) return;
        if (!permises.includes(valeur)) throw new Error(`valeur refusée pour « ${name} » : « ${valeur} » (${permises.join(", ")}).`);
        features.push({ name, value: valeur });
      };
      ajouter("forced-colors", forcedColors, ["active", "none"]);
      ajouter("prefers-reduced-motion", reducedMotion, ["reduce", "no-preference"]);
      if (theme !== null) {
        if (theme !== "sombre" && theme !== "clair") throw new Error(`thème refusé : « ${theme} » (sombre, clair).`);
        features.push({ name: "prefers-color-scheme", value: theme === "sombre" ? "dark" : "light" });
      }
      await envoyer("Emulation.setEmulatedMedia", { features });
      return features.map((feature) => `${feature.name}: ${feature.value}`);
    },

    // --- équipes (it4) : fin ---
    /**
     * Coupe (true) ou rétablit (false) le réseau de l'onglet, comme un Wi-Fi perdu : toute requête nouvelle échoue
     * (ERR_INTERNET_DISCONNECTED), `navigator.onLine` suit et la page reçoit « offline » puis « online ». Un flux
     * d'événements déjà ouvert n'est pas coupé (mesuré en M25).
     */
    async horsLigne(coupe) {
      await envoyer("Network.emulateNetworkConditions", { offline: Boolean(coupe), latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
    },

    /** Fait échouer les requêtes dont l'adresse correspond à l'un des motifs (« * » joker) ; `[]` les laisse toutes passer. */
    async bloquer(motifs) {
      await envoyer("Network.setBlockedURLs", { urls: motifs });
    },

    /**
     * Retient, à l'arrivée de leur réponse, les requêtes dont l'adresse correspond à l'un des motifs (« * » joker) : le
     * serveur a déjà calculé sa réponse, la page l'attend encore. C'est une requête lente vue de la page, dont la réponse
     * date d'AVANT ce qui suit. Rend `retenues()` (réponses retenues à cet instant) et `relacher()`, qui les rend toutes telles
     * quelles puis cesse de retenir (à appeler aussi en cas d'échec : sans lui, la page attend sans fin).
     */
    async retenirReponses(motifs) {
      const retenues = [];
      let actif = true;
      const continuer = (requestId) =>
        envoyer("Fetch.continueResponse", { requestId }).catch(() => envoyer("Fetch.continueRequest", { requestId }).catch(() => {}));
      const arreterEcouteFetch = client.ecouter((bloc) => {
        if (bloc.sessionId !== sessionId || bloc.method !== "Fetch.requestPaused") return;
        if (actif) retenues.push(bloc.params.requestId);
        else void continuer(bloc.params.requestId);
      });
      await envoyer("Fetch.enable", { patterns: motifs.map((urlPattern) => ({ urlPattern, requestStage: "Response" })) });
      return {
        retenues: () => retenues.length,
        async relacher() {
          if (!actif) return;
          actif = false;
          for (const requestId of retenues.splice(0)) await continuer(requestId);
          await envoyer("Fetch.disable").catch(() => {});
          arreterEcouteFetch();
        },
      };
    },

    async capture(fichier) {
      const { data } = await envoyer("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
      fs.mkdirSync(path.dirname(fichier), { recursive: true });
      fs.writeFileSync(fichier, Buffer.from(data, "base64"));
      return fichier;
    },

    /** Les six captures exigées : 1440, 1024 et 400, en clair et en sombre. */
    async captureSuite(prefixe, { avant = null } = {}) {
      const faites = [];
      for (const theme of THEMES) {
        await onglet.theme(theme);
        for (const taille of TAILLES) {
          await onglet.taille(taille);
          if (avant) await avant({ theme, taille });
          // Laisser la mise en page et les transitions se poser avant la capture.
          await attendre(150);
          faites.push(await onglet.capture(`${prefixe}-${taille.nom}-${theme}.png`));
        }
      }
      await envoyer("Emulation.clearDeviceMetricsOverride");
      // Thème rendu à celui de la page ; le mouvement reste celui du scénario, jamais celui du poste (R106-b).
      medias.theme = null;
      await emulerMedias();
      return faites;
    },

    /**
     * Zéro erreur de console : exigence de toutes les sorties machine visuelles. `sauf` écarte des erreurs connues,
     * chacune décrite par une expression régulière sur son adresse ou sur son texte ; un scénario qui s'en sert doit
     * dire pourquoi, et la ligne disparaît dès que la cause est corrigée.
     */
    exigerAucuneErreurConsole(sauf = []) {
      const retenues = erreurs.filter((e) => !sauf.some((motif) => motif.test(e.url ?? "") || motif.test(e.texte)));
      if (retenues.length === 0) return;
      const liste = retenues.map((e) => `    ${e.source} : ${e.texte}${e.url ? ` (${e.url})` : ""}`).join("\n");
      throw new Error(`${retenues.length} erreur(s) dans la console :\n${liste}`);
    },

    /** Trames du flux d'événements reçues par la page, dans l'ordre : nom (« hello », « message »…), adresse, instant. */
    evenementsFlux() {
      return flux.map((trame) => ({ ...trame }));
    },

    /** Journal réseau de l'onglet (méthode, adresse, code, échec, instant d'envoi `envoyeeA` en ms). */
    journalReseau() {
      return reseau.map(({ id, ...reste }) => reste);
    },

    async fermer() {
      arreterEcoute();
      await client.envoyer("Target.closeTarget", { targetId }).catch(() => {});
    },
  };
  return onglet;
}

/** Texte lisible d'un appel console (les valeurs par référence n'ont qu'une description). */
function textePropre(args) {
  return (args ?? [])
    .map((arg) => (arg.value !== undefined ? String(arg.value) : (arg.description ?? arg.type)))
    .join(" ")
    .slice(0, 400);
}
