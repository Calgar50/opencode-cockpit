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

/**
 * Arguments du navigateur. `spkiEpingle` (HTTPS du banc) : seul le certificat dont la clé publique a ce condensé est
 * accepté malgré son autorité inconnue (--ignore-certificate-errors-spki-list, que Chromium n'honore qu'avec un
 * --user-data-dir). Toute autre erreur de certificat reste bloquante : jamais --ignore-certificate-errors, jamais
 * Security.setIgnoreCertificateErrors.
 */
export function argumentsNavigateur(profil, { spkiEpingle = null } = {}) {
  if (spkiEpingle !== null && !SPKI_BASE64.test(String(spkiEpingle))) throw new Error("condensé de clé publique épinglé mal formé.");
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
    "about:blank",
  ];
}

/**
 * Ouvre un navigateur sans fenêtre sur un profil temporaire neuf. En HTTPS, `spkiEpingle` est le condensé de la clé
 * publique du certificat lu sur le volume de la pile jetable.
 */
export async function ouvrirNavigateur({ dossierProfil, executable = trouverNavigateur(), silencieux = true, spkiEpingle = null } = {}) {
  // Profil neuf à chaque ouverture : Windows garde les fichiers du profil précédent verrouillés un moment après la
  // fermeture, et une exécution ne doit jamais s'arrêter là-dessus.
  const profil = `${dossierProfil}-${randomBytes(3).toString("hex")}`;
  fs.mkdirSync(profil, { recursive: true, mode: 0o700 });
  const processus = spawn(executable, argumentsNavigateur(profil, { spkiEpingle }), { stdio: silencieux ? "ignore" : "inherit" });
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

/** Un onglet : navigation, évaluation, clavier, captures, erreurs de console et journal réseau. */
async function creerOnglet(client, sessionId, targetId) {
  const erreurs = [];
  const reseau = [];
  // Trames du flux d'événements (SSE) reçues par la page : nom et instant seulement, jamais les données.
  const flux = [];
  let chargement = null;

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
        reseau.push({ id: p.requestId, methode: p.request?.method, url: p.request?.url, etat: "envoyée" });
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

  const envoyer = (methode, params) => client.envoyer(methode, params, sessionId);
  await envoyer("Page.enable");
  await envoyer("Runtime.enable");
  await envoyer("Log.enable");
  await envoyer("Network.enable");

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

    /** Frappe une touche (Tab, Enter, Escape, ArrowDown…). */
    async touche(nom) {
      const codes = { Tab: 9, Enter: 13, Escape: 27, ArrowDown: 40, ArrowUp: 38, Space: 32 };
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

    async taille({ largeur, hauteur }) {
      await envoyer("Emulation.setDeviceMetricsOverride", { width: largeur, height: hauteur, deviceScaleFactor: 1, mobile: false });
    },

    async theme(nom) {
      await envoyer("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: nom === "sombre" ? "dark" : "light" }] });
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
      await envoyer("Emulation.setEmulatedMedia", { features: [] });
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

    /** Journal réseau de l'onglet (méthode, adresse, code, échec). */
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
