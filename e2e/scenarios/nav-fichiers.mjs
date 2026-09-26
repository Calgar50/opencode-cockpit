// Scénario e2e de l'onglet « Fichiers » (1.1, NAV-4 ; fiche NAV §7, décisions A19 point 2, A21, A29 D14) : relire en LECTURE
// SEULE les fichiers des projets, dans les deux modes, sans rien modifier ni rien envoyer à une IA.
//
// Préparation (ctx.travail, section nav:travail de e2e/lib/docker-e2e.mjs) : un projet « nav-banc » écrit depuis l'hôte (script
// PowerShell 5.1 en UTF-16LE avec BOM et un faux mot de passe, texte cp1252, page HTML piégée, caractère bidirectionnel, journal de
// 1 Mio, image avec octets NUL, faux secrets factices protégés par leur nom), puis, DANS le conteneur du cockpit, un lien vers
// /proc/self/environ, un lien vers .env, un lien physique de .env et un tube nommé ; deux dossiers de premier niveau au nom %XX
// (D14 (b)) ; enfin scripts/nouveau.ps1, le plus récent.
//
// Ce que le scénario établit, en agissant comme un utilisateur (clic, clavier) :
//   1. mode Simple : entrée « Fichiers » du rail, titre, sous-titre et badge ; nouveau.ps1 en tête de « Modifiés récemment » ;
//      arborescence au CLAVIER SEUL (Tab, Entrée) : dossier déplié (aria-expanded), fichier ouvert (aria-current, focus sur le titre),
//      texte UTF-16 décodé, mot de passe masqué et bandeau ; éléments protégés absents et comptés ; lien montré « raccourci, non
//      ouvert » ; page HTML rendue en texte (aucun script exécuté) ; caractère invisible montré ; bandeaux d'un fichier long en tête
//      et en fin ; image « binaire » ; recherche sur le nom ;
//   2. adresses directes : fichier protégé, chemin qui remonte, retour arrière du navigateur ;
//   3. API en HTTPS épinglé (ctx.api) : liens, lien physique (mesure M-NAV-1), tube, alias de casse, nom court, point final ;
//   4. D14 (b) : un dossier %XX est listé et lisible sous « Tout le workspace », jamais proposé pour une conversation ; un dossier
//      %XX dont le nom contient « secret » reste protégé par son nom ;
//   5. mode Avancé : ligne de détails (utf-16le), « lien symbolique », fichiers cachés affichés ;
//   6. captures 1440, 1024 et 400 dans les deux thèmes, en mode normal, en contraste forcé et en niveaux de gris avec mouvement réduit
//      (émulation CDP de ctx.travail.emulation) ; focus visible en contraste forcé, aucune animation en mouvement réduit ; vue à 400 px
//      avec « Retour aux fichiers » ;
//   7. aucun appel : aucune requête facturable, aucune requête /file* ni /find* reçue par opencode pendant les étapes de l'onglet ;
//   8. chat (« --faux ») : un outil `write` terminé sur /workspace/nav-banc/scripts/nouveau.ps1 porte « Ouvrir dans Fichiers », qui
//      ouvre ce fichier (sous le témoin P6 et P4) ;
//   9. console muette, sauf le refus voulu de l'adresse du fichier protégé (403 de la route contenu, vérifié au journal réseau), et
//      aucune violation de la CSP.
// Les phrases attendues sont écrites ici en clair : c'est la spécification (fiche NAV §8) qu'on vérifie, pas ce que le code déclare.
import path from "node:path";
import {
  attendre,
  attendreFinDuTour,
  attendreIa,
  attendreModeAffiche,
  avecTemoinP6,
  enModeAvance,
  exiger,
  exigerAucuneViolationCsp,
  LARGE,
  nonJoue,
  oc,
  ouvrirConversation,
  preparerPage,
  releve,
  resume,
} from "./it1-ui-commun.mjs";

const NL = String.fromCharCode(10);
const CRLF = String.fromCharCode(13, 10);
const DQ = String.fromCharCode(34);
const RLO = String.fromCharCode(0x202e);

/** Projet préparé par le scénario, et son dossier dans le conteneur du cockpit. */
const PROJET = "nav-banc";
const DANS_CONTENEUR = `/workspace/${PROJET}`;
/** D14 (b) : nom mesuré par la faille du double décodage (A22), montré en lecture ; et un nom %XX protégé par « secret ». */
const DOSSIER_PCT = "a%2F..%2F..%2Fhome%2Fnode%2F.local%2Fshare%2Fopencode";
const DOSSIER_PCT_SECRET = "a%2F..%2F..%2Fsecret";

/** Faux secret factice : aucun vrai secret n'est jamais écrit par le banc. */
const FAUX_MOT_DE_PASSE = ["Secr", "3t!"].join("");
const LIGNE_MOT_DE_PASSE = ["$pass", "word = ", DQ, FAUX_MOT_DE_PASSE, DQ].join("");
const CONTENU_ENV = ["NAV_BANC_FACTICE", "=ceci-n-est-pas-un-secret", NL].join("");
const CONTENU_NOUVEAU = `Write-Output ${DQ}nouveau script de l'IA${DQ}${CRLF}`;

const PHRASES = {
  rail: "Fichiers",
  titre: "Fichiers des projets",
  sousTitre: "Lecture seule : ici, rien n'est modifié et rien n'est envoyé à une IA.",
  badge: "Lecture seule",
  recents: "Modifiés récemment",
  racine: "Tout le workspace",
  masques: (n) => `${n} éléments protégés ne sont pas montrés : clés, mots de passe, historique git.`,
  lienSimple: "raccourci, non ouvert",
  lienAvance: "lien symbolique, non suivi",
  autreSimple: "élément spécial, non ouvert",
  secrets: "Des passages qui ressemblent à des mots de passe ou à des clés sont remplacés par ****.",
  invisibleUn: "Ce fichier contient 1 caractère invisible, montré ainsi : ⟦U+202E⟧.",
  long: "Ce fichier est long (",
  finTronquee: "Fin de l'affichage : la suite du fichier n'est pas montrée ici.",
  binaire: "Ce fichier n'est pas du texte (image, archive, programme…) : il n'est pas affiché.",
  ancienFormat: "Fichier enregistré dans un ancien format Windows : quelques caractères peuvent s'afficher mal.",
  protegeFichier: "Ce fichier est protégé : il peut contenir des clés ou des mots de passe. Il n'est pas affiché.",
  invalide: "Cette adresse de fichier n'est pas prise en charge.",
  retour: "Retour aux fichiers",
  occupe: "Une autre lecture est en cours.",
  ouvrirDansFichiers: "Ouvrir dans Fichiers",
  detailsUtf16: "Encodage : utf-16le",
};

/** Adresse d'un fichier de l'onglet, construite ici indépendamment du code (URLSearchParams, comme la fiche l'écrit). */
const adresse = (projet, chemin) => `#/fichiers?${new URLSearchParams(chemin === undefined ? { projet } : { projet, chemin }).toString()}`;

/**
 * Seule entrée de console tolérée : le 403 voulu de la route « contenu » quand l'adresse directe désigne .env (étape 2). Le navigateur
 * écrit tout refus HTTP d'une requête dans la console ; le journal réseau vérifie ensuite qu'il n'y a eu que ce refus-là.
 */
const CONSOLE_REFUS_VOULU = [/\/api\/fichiers\/contenu$/];

// --- Page ------------------------------------------------------------------------------------------------------------------------

const SECTION = "section.fichiers-page";
const ARBRE = "nav.fichiers-arbre";

/** Expression : élément de l'arborescence (bouton de dossier, lien de fichier, élément spécial) dont le nom affiché vaut `nom`. */
const exprLigne = (nom) =>
  `([...document.querySelectorAll(${JSON.stringify(`${ARBRE} .fichiers-ligne`)})].find((e) => e.querySelector("bdi")?.textContent === ${JSON.stringify(nom)}) ?? null)`;
/** Expression : texte visible (espaces réduits) de `selecteur`. */
const exprTexte = (selecteur) => `(document.querySelector(${JSON.stringify(selecteur)})?.innerText ?? "").replace(/\\s+/g, " ")`;

async function texte(page, selecteur) {
  return await page.evaluer(exprTexte(selecteur));
}

async function attendreTexteDans(page, selecteur, attendu, libelle = attendu) {
  await page.attendreQue(`${exprTexte(selecteur)}.includes(${JSON.stringify(attendu)})`, { libelle: `« ${libelle} » dans ${selecteur}` });
}

/** Ouvre un fichier par son lien de l'arborescence (clic), attend son titre et la fin du chargement ; rend le texte du contenu. */
async function ouvrirParLien(page, projet, chemin) {
  const href = adresse(projet, chemin);
  const lien = `${ARBRE} a[href=${JSON.stringify(href)}]`;
  await page.attendreQue(`document.querySelector(${JSON.stringify(lien)})`, { libelle: `lien de ${chemin} dans l'arborescence` });
  await page.evaluer(`document.querySelector(${JSON.stringify(lien)}).click()`);
  return await attendreFichierOuvert(page, chemin.split("/").at(-1));
}

/** Attend la vue du fichier `nom` chargée (ni « Chargement ») ; rend le texte du contenu, ou "" s'il n'y a pas de contenu. */
async function attendreFichierOuvert(page, nom) {
  await page.attendreQue(
    `document.querySelector(".fichiers-vue h2.fichiers-titre")?.textContent === ${JSON.stringify(nom)} && !${exprTexte(".fichiers-vue")}.endsWith("Chargement")`,
    { libelle: `fichier ${nom} ouvert` },
  );
  await attendre(100);
  return await page.evaluer(`document.querySelector(".fichiers-vue pre.fichiers-texte")?.textContent ?? ""`);
}

/** Déplie un dossier de l'arborescence par un clic sur son bouton ; attend ses enfants. */
async function deplier(page, nom) {
  await page.attendreQue(exprLigne(nom), { libelle: `dossier ${nom} dans l'arborescence` });
  if ((await page.evaluer(`${exprLigne(nom)}.getAttribute("aria-expanded")`)) !== "true") await page.evaluer(`${exprLigne(nom)}.click()`);
  await page.attendreQue(`(() => { const b = ${exprLigne(nom)}; const l = b && document.getElementById(b.getAttribute("aria-controls")); return b?.getAttribute("aria-expanded") === "true" && l && !l.hidden && l.getAttribute("aria-busy") !== "true"; })()`, {
    libelle: `dossier ${nom} déplié et chargé`,
  });
}

/**
 * Choisit le projet parcouru dans le sélecteur « Projet » (événement change, comme un choix à la souris). La valeur du sélecteur
 * n'est pas relue aussitôt (React la rétablit tant que l'adresse n'a pas changé) : c'est l'arborescence qui dit le projet affiché.
 */
async function choisirProjet(page, projet) {
  const options = await page.evaluer(`(() => {
    const s = document.querySelector(${JSON.stringify(`${SECTION} select`)});
    const valeurs = s ? [...s.options].map((o) => o.value) : null;
    if (!s || !valeurs.includes(${JSON.stringify(projet)})) return valeurs;
    Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value").set.call(s, ${JSON.stringify(projet)});
    s.dispatchEvent(new Event("change", { bubbles: true }));
    return valeurs;
  })()`);
  exiger(Array.isArray(options) && options.includes(projet), `projet « ${projet} » absent du sélecteur « Projet » : ${resume(options)}`);
  await page.attendreQue(`document.querySelector(${JSON.stringify(ARBRE)})?.getAttribute("aria-label") === ${JSON.stringify(`Fichiers de ${projet === "" ? PHRASES.racine : projet}`)}`, {
    libelle: `arborescence du projet ${projet || PHRASES.racine}`,
  });
  await page.attendreQue(`document.querySelector(${JSON.stringify(`${ARBRE} > ul`)})?.getAttribute("aria-busy") !== "true"`, { libelle: "racine de l'arborescence chargée" });
}

/**
 * Attend la fin du chargement de « Modifiés récemment ». Un seul parcours tourne à la fois dans le cockpit, et celui d'un projet
 * quitté continue sur le serveur après l'annulation de sa requête : changer de projet avant la fin du parcours en cours donne
 * « Une autre lecture est en cours » (constat transmis, voir le RECAPITULATIF). Le scénario attend donc, comme un utilisateur qui
 * laisse la page se charger, avant de changer de projet ou d'adresse.
 */
async function attendreRecentsCharges(page) {
  await page.attendreQue(`(() => { const b = document.querySelector(${JSON.stringify(`${SECTION} .fichiers-bloc`)}); return b && !b.innerText.includes("Chargement"); })()`, {
    delaiMs: 20_000,
    libelle: "« Modifiés récemment » chargé",
  });
}

/** Tabule jusqu'à ce que l'élément actif satisfasse `expression` ; rend le nombre de tabulations. */
async function tabulerJusqua(page, expression, libelle, max = 90) {
  for (let i = 0; i <= max; i++) {
    if (await page.evaluer(`Boolean((() => { const e = document.activeElement; return e && (${expression}); })())`)) return i;
    await page.touche("Tab");
  }
  throw new Error(`clavier seul : ${libelle} jamais atteint en ${max} tabulations (focus sur « ${await page.focus()} »).`);
}

// --- Préparation du projet nav-banc ------------------------------------------------------------------------------------------------

function utf16leAvecBom(texteSource) {
  return Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(texteSource, "utf16le")]);
}

/** Journal de 1 Mio exactement, en lignes ASCII sans secret. */
function journal1Mio() {
  const lignes = [];
  let taille = 0;
  for (let i = 1; taille < 1024 * 1024; i++) {
    const ligne = `ligne ${String(i).padStart(6, "0")} du journal du banc, sans secret${NL}`;
    lignes.push(ligne);
    taille += ligne.length;
  }
  return Buffer.from(lignes.join("")).subarray(0, 1024 * 1024);
}

/** Écrit le projet nav-banc ; rend le résultat des opérations faites dans le conteneur (mesures M-NAV-1 et M-NAV-2). */
async function preparer(ctx) {
  const ecrire = (relatif, contenu) => ctx.travail.ecrire(`${PROJET}/${relatif}`, contenu);
  ecrire("scripts/Get-Rapport.ps1", utf16leAvecBom([`# Rapport de l'été (factice)`, LIGNE_MOT_DE_PASSE, `Write-Output ${DQ}Rapport généré${DQ}`, ""].join(CRLF)));
  // « é à € » en windows-1252 : E9, E0, 80.
  ecrire("scripts/notes-cp1252.txt", Buffer.from([0xe9, 0x20, 0xe0, 0x20, 0x80, 0x0d, 0x0a]));
  ecrire("scripts/page.html", `<script>window.__xss=1</script><img src=x onerror=${DQ}window.__xss=2${DQ}>${NL}`);
  ecrire("scripts/bidi.py", `# contrôle d'accès${NL}acces = ${DQ}utilisateur${DQ} # ${RLO} ;${DQ}nimda${DQ} = acces${NL}print(acces)${NL}`);
  ecrire("sous/dossier/profond.ps1", `Write-Output 'profond'${CRLF}`);
  ecrire(".env", CONTENU_ENV);
  ecrire(".git/config", `[core]${NL}	repositoryformatversion = 0${NL}`);
  ecrire("cle.pfx", Buffer.from(`factice, pas une clé${NL}`));
  ecrire("credentials.json", `{${DQ}factice${DQ}: true}${NL}`);
  ecrire(".editorconfig", `root = true${NL}`);
  ecrire("gros.log", journal1Mio());
  ecrire("image.png", Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64)]));

  // Dans le conteneur du cockpit, comme le ferait une IA depuis son conteneur Linux.
  const conteneur = {
    lienEnviron: await ctx.travail.dansLeConteneur(["ln", "-s", "/proc/self/environ", `${DANS_CONTENEUR}/lien-environ.txt`]),
    lienEnv: await ctx.travail.dansLeConteneur(["ln", "-s", ".env", `${DANS_CONTENEUR}/lien-env.txt`]),
    double: await ctx.travail.dansLeConteneur(["ln", `${DANS_CONTENEUR}/.env`, `${DANS_CONTENEUR}/double.txt`]),
    tube: await ctx.travail.dansLeConteneur(["mkfifo", `${DANS_CONTENEUR}/tube`]),
  };
  exiger(conteneur.lienEnviron.code === 0 && conteneur.lienEnv.code === 0, `liens symboliques non créés dans le conteneur : ${resume([conteneur.lienEnviron, conteneur.lienEnv])}`);

  // D14 (b) : dossiers de premier niveau au nom %XX, chacun avec un fichier ordinaire.
  ctx.travail.ecrire(`${DOSSIER_PCT}/lisez-moi.txt`, `Dossier au nom %XX : montré en lecture seule, jamais proposé pour une conversation.${NL}`);
  ctx.travail.ecrire(`${DOSSIER_PCT_SECRET}/lisez-moi.txt`, `Dossier au nom %XX qui contient « secret » : protégé par son nom.${NL}`);

  // En dernier, le plus récent (dates du montage au mieux à la seconde).
  await attendre(1_100);
  ecrire("scripts/nouveau.ps1", CONTENU_NOUVEAU);
  releve(
    ctx,
    `préparation de ${PROJET} : lien vers /proc/self/environ ${conteneur.lienEnviron.code === 0 ? "créé" : "refusé"}, lien physique ${conteneur.double.code === 0 ? "créé" : `refusé (${resume(conteneur.double.sortie, 120)})`}, tube ${conteneur.tube.code === 0 ? "créé" : `refusé (${resume(conteneur.tube.sortie, 120)})`}`,
  );
  return conteneur;
}

// --- API (HTTPS épinglé) -------------------------------------------------------------------------------------------------------

async function contenu(ctx, projet, chemin) {
  const debut = Date.now();
  const reponse = await ctx.api.brut("POST", "/api/fichiers/contenu", { projet, chemin });
  let corps = null;
  try {
    corps = JSON.parse(reponse.corps);
  } catch {
    corps = null;
  }
  return { code: reponse.code, corps, brut: reponse.corps, ms: Date.now() - debut };
}

async function dossier(ctx, projet, chemin) {
  const debut = Date.now();
  const reponse = await ctx.api.brut("POST", "/api/fichiers/dossier", { projet, chemin });
  return { code: reponse.code, corps: JSON.parse(reponse.corps), ms: Date.now() - debut };
}

async function verifierApi(ctx, conteneur) {
  // Lien vers /proc/self/environ : refusé comme lien, sans aucune variable d'environnement du cockpit dans la réponse.
  const environ = await contenu(ctx, PROJET, "lien-environ.txt");
  exiger(environ.code === 403 && environ.corps?.error === "lien", `lien-environ.txt : ${environ.code} ${resume(environ.brut)}`);
  for (const nom of ["COCKPIT_TOKEN", "OPENCODE_SERVER_PASSWORD", "PATH=", "HOSTNAME="]) exiger(!environ.brut.includes(nom), `lien-environ.txt : « ${nom} » dans la réponse.`);
  const env = await contenu(ctx, PROJET, "lien-env.txt");
  exiger(env.code === 403 && env.corps?.error === "lien", `lien-env.txt : ${env.code} ${resume(env.brut)}`);
  exiger(!env.brut.includes("ceci-n-est-pas-un-secret"), "lien-env.txt : contenu de .env dans la réponse.");

  // Lien physique de .env (mesure M-NAV-1) : refusé si le montage rapporte nlink ; sinon, le constat est consigné.
  if (conteneur.double.code === 0) {
    const double = await contenu(ctx, PROJET, "double.txt");
    if (double.code === 403 && double.corps?.error === "plusieurs-noms") releve(ctx, "M-NAV-1 : double.txt (lien physique de .env posé dans le conteneur) → 403 plusieurs-noms : nlink rapporté par le montage");
    else releve(ctx, `M-NAV-1 CONTREDITE : double.txt → ${double.code} ${double.corps?.error ?? double.corps?.etat ?? ""} : lien physique non détecté sur ce montage (reste n° 4)`);
  } else {
    releve(ctx, "M-NAV-1 : lien physique refusé par le montage dans le conteneur (aucun lien physique possible ici)");
  }

  // Tube : refusé sans blocage.
  if (conteneur.tube.code === 0) {
    const tube = await contenu(ctx, PROJET, "tube");
    exiger(tube.code === 409 && tube.corps?.error === "pas-un-fichier", `tube : ${tube.code} ${resume(tube.brut)}`);
    exiger(tube.ms < 2_000, `tube : réponse en ${tube.ms} ms (2 s au plus).`);
    releve(ctx, `tube → 409 pas-un-fichier en ${tube.ms} ms`);
  } else {
    releve(ctx, "tube : mkfifo refusé par le montage dans le conteneur (mesure, aucun tube possible ici)");
  }

  // Alias de casse, nom court, point final, dossier en majuscules : jamais 200.
  const alias = [];
  for (const chemin of [".ENV", "ENV~1", ".env.", "SCRIPTS/Get-Rapport.ps1"]) {
    const r = await contenu(ctx, PROJET, chemin);
    exiger([400, 403, 404].includes(r.code), `${chemin} : ${r.code} ${resume(r.brut)} (400, 403 ou 404 attendu, jamais 200).`);
    alias.push(`${chemin} → ${r.code} ${r.corps?.error ?? ""}`);
  }
  releve(ctx, `alias refusés : ${alias.join(" ; ")}`);

  // Liste du projet : types vus par le cockpit sur /projets-lecture (M-NAV-2 : un lien posé par un conteneur est vu comme lien).
  const liste = await dossier(ctx, PROJET, "");
  exiger(liste.code === 200, `dossier ${PROJET} : ${liste.code}`);
  const type = (nom) => liste.corps.entrees.find((e) => e.nom === nom)?.type ?? "absent";
  exiger(type("lien-environ.txt") === "lien" && type("lien-env.txt") === "lien", `M-NAV-2 : liens vus comme ${type("lien-environ.txt")} et ${type("lien-env.txt")}.`);
  for (const nom of [".env", ".git", "cle.pfx", "credentials.json"]) exiger(!liste.corps.entrees.some((e) => e.nom === nom), `${nom} envoyé dans la liste.`);
  exiger(liste.corps.masques === 4, `${liste.corps.masques} élément(s) masqué(s) au lieu de 4.`);
  exiger(!JSON.stringify(liste.corps).includes("/projets-lecture"), "racine absolue dans la réponse.");
  releve(ctx, `M-NAV-2 : lien-environ.txt et lien-env.txt vus comme « lien » par le cockpit ; double.txt ${type("double.txt")}, tube ${type("tube")}`);

  // Durées sur le montage (M-NAV-7, par l'API) : lecture de 256 Kio (gros.log, 1 Mio) et liste du projet.
  const gros = await contenu(ctx, PROJET, "gros.log");
  exiger(gros.code === 200 && gros.corps?.tronque === true, `gros.log : ${gros.code} tronque=${gros.corps?.tronque}`);
  releve(ctx, `M-NAV-7 (HTTPS, montage) : contenu de gros.log (256 Kio lus sur 1 Mio) en ${gros.ms} ms ; liste de ${PROJET} (${liste.corps.entrees.length} entrées) en ${liste.ms} ms`);
}

// --- D14 (b) -----------------------------------------------------------------------------------------------------------------------

async function verifierPourcent(ctx, page) {
  const boot = await ctx.api.get("/api/bootstrap");
  const projets = (boot?.projects ?? []).map((p) => p.name);
  exiger(projets.includes(PROJET), `${PROJET} absent des projets du cockpit : ${resume(projets)}`);
  exiger(!projets.includes(DOSSIER_PCT) && !projets.includes(DOSSIER_PCT_SECRET), `dossier %XX proposé comme projet de conversation : ${resume(projets)}`);

  const racine = await dossier(ctx, "", "");
  exiger(racine.code === 200, `dossier racine : ${racine.code}`);
  const entree = racine.corps.entrees.find((e) => e.nom === DOSSIER_PCT);
  exiger(entree?.type === "dossier", `dossier %XX absent de « ${PHRASES.racine} » : ${resume(racine.corps.entrees.map((e) => e.nom))}`);
  exiger(!racine.corps.entrees.some((e) => e.nom === DOSSIER_PCT_SECRET), "dossier %XX « secret » envoyé dans la liste.");
  const lu = await contenu(ctx, "", `${DOSSIER_PCT}/lisez-moi.txt`);
  exiger(lu.code === 200 && lu.corps?.texte?.includes("montré en lecture seule"), `lisez-moi.txt du dossier %XX : ${lu.code} ${resume(lu.brut)}`);
  const commeProjet = await contenu(ctx, DOSSIER_PCT, "lisez-moi.txt");
  exiger(commeProjet.code === 200, `dossier %XX pris comme projet : ${commeProjet.code}`);
  const secret = await contenu(ctx, "", `${DOSSIER_PCT_SECRET}/lisez-moi.txt`);
  exiger(secret.code === 403 && secret.corps?.error === "protege", `dossier %XX « secret » : ${secret.code} ${resume(secret.brut)}`);

  // Par la page : « Tout le workspace », dossier %XX déplié, fichier ouvert ; aucune action de conversation proposée.
  await attendreRecentsCharges(page);
  await choisirProjet(page, "");
  await attendreRecentsCharges(page);
  await deplier(page, DOSSIER_PCT);
  const texteLu = await ouvrirParLien(page, "", `${DOSSIER_PCT}/lisez-moi.txt`);
  exiger(texteLu.includes("montré en lecture seule"), `lisez-moi.txt du dossier %XX : ${resume(texteLu)}`);
  exiger(!(await page.evaluer(`Boolean(${exprLigne(DOSSIER_PCT_SECRET)})`)), "dossier %XX « secret » montré dans l'arborescence.");
  const conversation = await page.evaluer(`document.querySelectorAll(${JSON.stringify(`${SECTION} a[href^="#/chat"]`)}).length`);
  exiger(conversation === 0, `${conversation} lien(s) vers une conversation dans l'onglet Fichiers.`);
  const options = await page.evaluer(`[...document.querySelectorAll(${JSON.stringify(`${SECTION} select option`)})].map((o) => o.value)`);
  exiger(!options.includes(DOSSIER_PCT), `dossier %XX proposé au sélecteur de projet : ${resume(options)}`);
  releve(ctx, `D14 (b) : ${DOSSIER_PCT} listé et lu sous « ${PHRASES.racine} » (API et page), absent des projets de conversation ; ${DOSSIER_PCT_SECRET} protégé par son nom (403 protege)`);
}

// --- Captures et accessibilité ------------------------------------------------------------------------------------------------------

async function capturesEtAccessibilite(ctx, page) {
  const emulation = ctx.travail.emulation;
  const faites = [];
  faites.push(...(await ctx.screenshot("fichier-ouvert")));
  try {
    faites.push(...(await ctx.screenshot("fichier-ouvert-contraste", { avant: ({ theme }) => emulation.appliquer({ theme, contraste: true }) })));
    faites.push(...(await ctx.screenshot("fichier-ouvert-gris", { avant: ({ theme }) => emulation.appliquer({ theme, gris: true, mouvementReduit: true }) })));
    await page.taille(LARGE);

    // Contraste forcé : le focus clavier reste visible (contour de 2 px au moins).
    await emulation.appliquer({ theme: "clair", contraste: true });
    exiger(await page.evaluer(`matchMedia("(forced-colors: active)").matches`), "contraste forcé non émulé.");
    await page.evaluer(`document.activeElement?.blur()`);
    await tabulerJusqua(page, `e.matches(${JSON.stringify(`${ARBRE} a, ${ARBRE} button`)})`, "élément de l'arborescence");
    const focus = await page.evaluer(`(() => { const e = document.activeElement; const s = getComputedStyle(e); return { visible: e.matches(":focus-visible"), style: s.outlineStyle, largeur: parseFloat(s.outlineWidth) }; })()`);
    exiger(focus.visible && focus.style !== "none" && focus.largeur >= 2, `contraste forcé : focus clavier peu visible (${resume(focus)}).`);

    // Niveaux de gris et mouvement réduit : aucune animation en cours dans la page.
    await emulation.appliquer({ theme: "clair", gris: true, mouvementReduit: true });
    exiger(await page.evaluer(`matchMedia("(prefers-reduced-motion: reduce)").matches`), "mouvement réduit non émulé.");
    await attendre(300);
    const animations = await page.evaluer(`document.getAnimations().filter((a) => a.playState === "running").length`);
    exiger(animations === 0, `${animations} animation(s) en cours en mouvement réduit.`);
    releve(ctx, `accessibilité : focus visible en contraste forcé (contour ${focus.style} ${focus.largeur} px) ; 0 animation en mouvement réduit`);
  } finally {
    await emulation.retirer();
  }
  exiger(faites.length === 18, `18 captures attendues (3 modes × 2 thèmes × 3 tailles), ${faites.length} faites.`);

  // 400 px : le fichier ouvert remplace les colonnes, « Retour aux fichiers » en tête ; le retour rend le focus au lien d'origine.
  await page.taille({ largeur: 400, hauteur: 860 });
  await attendre(200);
  const retourVu = await page.evaluer(`(() => {
    const b = [...document.querySelectorAll(".fichiers-vue button")].find((x) => x.textContent.trim() === ${JSON.stringify(PHRASES.retour)});
    if (!b) return false;
    const r = b.getBoundingClientRect();
    const arbre = document.querySelector(${JSON.stringify(ARBRE)});
    return document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2)?.closest("button") === b && (!arbre || arbre.getClientRects().length === 0);
  })()`);
  exiger(retourVu, `400 px : « ${PHRASES.retour} » non vu en tête, ou arborescence encore affichée.`);
  faites.push(await page.capture(path.join(ctx.dossierCaptures, "nav-fichiers-retour-aux-fichiers-400-clair.png")));
  await page.evaluer(`[...document.querySelectorAll(".fichiers-vue button")].find((x) => x.textContent.trim() === ${JSON.stringify(PHRASES.retour)}).click()`);
  await page.attendreQue(`!document.querySelector(".fichiers-vue") && document.activeElement?.getAttribute("href") === ${JSON.stringify(adresse(PROJET, "scripts/Get-Rapport.ps1"))}`, {
    libelle: "400 px : retour aux fichiers, focus rendu au lien d'origine",
  });
  await page.taille(LARGE);
  releve(ctx, `captures : ${faites.length} (18 en trois modes, plus la vue à 400 px avec « ${PHRASES.retour} »)`);
  return faites;
}

// --- Scénario ----------------------------------------------------------------------------------------------------------------------

export async function run(ctx) {
  // 0. Gardes de ctx.travail (sans Docker ni navigateur), puis préparation du projet.
  const tombees = await ctx.travail.verifierGardes();
  exiger(tombees.length === 0, `gardes de ctx.travail tombées : ${resume(tombees, 600)}`);
  const conteneur = await preparer(ctx);

  // La page est rechargée pour que la liste des projets du cockpit contienne nav-banc.
  await ctx.navigateur.aller(`${ctx.url}/`);
  const page = await preparerPage(ctx);
  const faux = ctx.mode === "faux";
  const requetesAvant = faux ? (await ctx.opencodeRequests()).length : 0;
  const facturesAvant = faux ? (await ctx.billedCalls()).length : 0;

  // 1. Mode Simple : rail, en-tête, projet, récents.
  const entree = await page.evaluer(`(() => { const a = [...document.querySelectorAll("nav.rail a.nav-item")].find((x) => x.textContent.trim() === ${JSON.stringify(PHRASES.rail)}); return a && a.getClientRects().length > 0 ? a.getAttribute("href") : null; })()`);
  exiger(entree !== null, `entrée « ${PHRASES.rail} » absente du rail en mode Simple.`);
  await page.evaluer(`[...document.querySelectorAll("nav.rail a.nav-item")].find((x) => x.textContent.trim() === ${JSON.stringify(PHRASES.rail)}).click()`);
  await page.attendreQue(`document.querySelector(${JSON.stringify(`${SECTION} h1`)})?.textContent === ${JSON.stringify(PHRASES.titre)}`, { libelle: "titre de l'onglet Fichiers" });
  const entete = await texte(page, `${SECTION} .fichiers-entete`);
  exiger(entete.includes(PHRASES.sousTitre) && entete.includes(PHRASES.badge), `en-tête sans sous-titre ou badge : ${resume(entete)}`);
  await attendreRecentsCharges(page);
  await choisirProjet(page, PROJET);
  await attendreRecentsCharges(page);
  exiger(!(await texte(page, `${SECTION} .fichiers-bloc`)).includes(PHRASES.occupe), `« ${PHRASES.recents} » : « ${PHRASES.occupe} » après le changement de projet.`);
  await page.attendreQue(`document.querySelector(${JSON.stringify(`${SECTION} .fichiers-bloc .fichiers-plate a bdi`)})`, { libelle: "liste de « Modifiés récemment »" });
  const premierRecent = await page.evaluer(`document.querySelector(${JSON.stringify(`${SECTION} .fichiers-bloc .fichiers-plate a bdi`)}).textContent`);
  exiger(premierRecent === "nouveau.ps1", `« ${PHRASES.recents} » commence par ${premierRecent}, pas par nouveau.ps1.`);

  // Arborescence au clavier seul : Tab jusqu'à « scripts », Entrée, Tab jusqu'à Get-Rapport.ps1, Entrée.
  await page.evaluer(`document.activeElement?.blur()`);
  const tabs1 = await tabulerJusqua(page, `e.matches(${JSON.stringify(`${ARBRE} button`)}) && e.querySelector("bdi")?.textContent === "scripts"`, "dossier « scripts »");
  await page.touche("Enter");
  await page.attendreQue(`(() => { const b = ${exprLigne("scripts")}; const l = b && document.getElementById(b.getAttribute("aria-controls")); return b.getAttribute("aria-expanded") === "true" && l && !l.hidden && l.querySelector('a[href=${JSON.stringify(adresse(PROJET, "scripts/Get-Rapport.ps1"))}]')?.getClientRects().length > 0; })()`, {
    libelle: "Entrée sur « scripts » : dossier déplié, enfants visibles",
  });
  const tabs2 = await tabulerJusqua(page, `e.getAttribute("href") === ${JSON.stringify(adresse(PROJET, "scripts/Get-Rapport.ps1"))}`, "lien de Get-Rapport.ps1");
  await page.touche("Enter");
  const rapport = await attendreFichierOuvert(page, "Get-Rapport.ps1");
  exiger(await page.evaluer(`document.activeElement?.matches("h2.fichiers-titre")`), `Entrée sur le lien : focus sur « ${await page.focus()} », pas sur le titre du fichier.`);
  exiger((await page.evaluer(`document.querySelector('${ARBRE} a[aria-current="page"]')?.getAttribute("href")`)) === adresse(PROJET, "scripts/Get-Rapport.ps1"), "aria-current absent du lien du fichier ouvert.");
  exiger(rapport.includes("Rapport généré") && rapport.includes("été"), `texte UTF-16 mal décodé : ${resume(rapport)}`);
  exiger(rapport.includes(`password = ${DQ}****${DQ}`) && !rapport.includes(FAUX_MOT_DE_PASSE), `mot de passe non masqué : ${resume(rapport)}`);
  exiger((await texte(page, ".fichiers-vue")).includes(PHRASES.secrets), "bandeau des passages masqués absent.");
  releve(ctx, `clavier seul : ${tabs1} tabulations jusqu'à « scripts », ${tabs2} jusqu'à Get-Rapport.ps1 ; Entrée déplie et ouvre, focus sur le titre`);

  // Éléments protégés absents et comptés ; lien et tube montrés sans être ouverts.
  const racineArbre = await texte(page, ARBRE);
  for (const nom of [".env", ".git", "cle.pfx", "credentials.json"]) exiger(!(await page.evaluer(`Boolean(${exprLigne(nom)})`)), `${nom} montré dans l'arborescence.`);
  exiger(racineArbre.includes(PHRASES.masques(4)), `phrase « ${PHRASES.masques(4)} » absente : ${resume(racineArbre, 400)}`);
  exiger((await page.evaluer(`${exprLigne("lien-environ.txt")}?.tagName`)) === "SPAN", "lien-environ.txt ouvrable dans l'arborescence.");
  exiger((await page.evaluer(`${exprLigne("lien-environ.txt")}.textContent`)).includes(PHRASES.lienSimple), `lien-environ.txt sans « ${PHRASES.lienSimple} ».`);
  if (conteneur.tube.code === 0) exiger((await page.evaluer(`${exprLigne("tube")}?.textContent ?? ""`)).includes(PHRASES.autreSimple), `tube sans « ${PHRASES.autreSimple} ».`);
  exiger(!(await page.evaluer(`Boolean(${exprLigne(".editorconfig")})`)), ".editorconfig montré en mode Simple (fichiers cachés masqués par défaut).");

  // 6. Captures (fichier ouvert, arborescence dépliée) et vérifications d'accessibilité.
  await capturesEtAccessibilite(ctx, page);

  // Page HTML piégée : rendue en texte, aucun script exécuté, aucun élément ajouté.
  const scriptsAvant = await page.evaluer(`document.querySelectorAll("script").length`);
  const html = await ouvrirParLien(page, PROJET, "scripts/page.html");
  exiger(html.includes("<script>window.__xss=1</script>"), `page.html non rendue en texte : ${resume(html)}`);
  exiger((await page.evaluer(`typeof window.__xss`)) === "undefined", "page.html : script exécuté (window.__xss défini).");
  exiger((await page.evaluer(`document.querySelectorAll("script").length`)) === scriptsAvant, "page.html : élément <script> ajouté au document.");
  exiger((await page.evaluer(`document.querySelectorAll('img[src="x"]').length`)) === 0, "page.html : image ajoutée au document.");

  // Caractère bidirectionnel montré, bandeau.
  const bidi = await ouvrirParLien(page, PROJET, "scripts/bidi.py");
  exiger(bidi.includes("⟦U+202E⟧") && !bidi.includes(RLO), `bidi.py : marqueur absent ou caractère brut : ${resume(bidi)}`);
  exiger((await texte(page, ".fichiers-vue")).includes(PHRASES.invisibleUn), "bidi.py : bandeau des caractères invisibles absent.");

  // Ancien format Windows (cp1252).
  const notes = await ouvrirParLien(page, PROJET, "scripts/notes-cp1252.txt");
  exiger(notes.includes("é à €"), `notes-cp1252.txt mal décodé : ${resume(notes)}`);
  exiger((await texte(page, ".fichiers-vue")).includes(PHRASES.ancienFormat), "notes-cp1252.txt : bandeau « ancien format » absent.");

  // Fichier long : bandeau en tête ET en fin du texte.
  await ouvrirParLien(page, PROJET, "gros.log");
  const bandeaux = await page.evaluer(`(() => {
    const pre = document.querySelector(".fichiers-vue pre.fichiers-texte");
    const b = [...document.querySelectorAll(".fichiers-vue .fichiers-bandeau")];
    const avant = b.filter((x) => x.compareDocumentPosition(pre) & Node.DOCUMENT_POSITION_FOLLOWING).map((x) => x.textContent);
    const apres = b.filter((x) => x.compareDocumentPosition(pre) & Node.DOCUMENT_POSITION_PRECEDING).map((x) => x.textContent);
    return { avant, apres };
  })()`);
  exiger(bandeaux.avant.some((t) => t.includes(PHRASES.long)) && bandeaux.apres.some((t) => t.includes(PHRASES.finTronquee)), `gros.log : bandeaux ${resume(bandeaux)}`);

  // Image : « binaire », jamais affichée.
  await ouvrirParLien(page, PROJET, "image.png");
  exiger((await texte(page, ".fichiers-vue")).includes(PHRASES.binaire), "image.png : phrase « binaire » absente.");

  // Recherche sur le nom : un résultat, ouvrable.
  await page.evaluer(`document.querySelector(${JSON.stringify(`${SECTION} form[role="search"] input`)}).focus()`);
  await page.taper("profond");
  await page.touche("Enter");
  await page.attendreQue(`[...document.querySelectorAll(${JSON.stringify(`${SECTION} .fichiers-bloc h2`)})].some((h) => h.textContent === "Résultats de la recherche") && [...document.querySelectorAll(${JSON.stringify(`${SECTION} .fichiers-bloc`)})].at(-1).querySelectorAll("li").length > 0`, {
    libelle: "résultats de la recherche",
  });
  const resultats = await page.evaluer(`[...[...document.querySelectorAll(${JSON.stringify(`${SECTION} .fichiers-bloc`)})].at(-1).querySelectorAll("li a")].map((a) => a.getAttribute("href"))`);
  exiger(resultats.length === 1 && resultats[0] === adresse(PROJET, "sous/dossier/profond.ps1"), `recherche « profond » : ${resume(resultats)}`);
  await page.evaluer(`[...document.querySelectorAll(${JSON.stringify(`${SECTION} .fichiers-bloc`)})].at(-1).querySelector("li a").click()`);
  exiger((await attendreFichierOuvert(page, "profond.ps1")).includes("profond"), "profond.ps1 : contenu absent.");

  // 2. Adresses directes : fichier protégé, retour arrière, chemin qui remonte.
  await page.evaluer(`location.hash = ${JSON.stringify(adresse(PROJET, ".env"))}`);
  await attendreTexteDans(page, ".fichiers-vue", PHRASES.protegeFichier);
  exiger(!(await texte(page, SECTION)).includes("ceci-n-est-pas-un-secret"), "contenu de .env affiché.");
  await page.evaluer("history.back()");
  await attendreFichierOuvert(page, "profond.ps1");
  await page.evaluer(`location.hash = ${JSON.stringify(`#/fichiers?projet=${PROJET}&chemin=..%2Fx`)}`);
  await attendreTexteDans(page, SECTION, PHRASES.invalide);
  releve(ctx, "adresses directes : .env protégé, retour arrière vers le fichier précédent, « ..%2Fx » non prise en charge");

  // 3. API en HTTPS épinglé.
  await verifierApi(ctx, conteneur);

  // 4. D14 (b).
  await verifierPourcent(ctx, page);

  // 5. Mode Avancé : détails, « lien symbolique », fichiers cachés affichés.
  await enModeAvance(ctx, async () => {
    await attendreModeAffiche(page, "avance");
    await page.evaluer(`location.hash = ${JSON.stringify(adresse(PROJET, "scripts/Get-Rapport.ps1"))}`);
    await attendreFichierOuvert(page, "Get-Rapport.ps1");
    await attendreRecentsCharges(page);
    await attendreTexteDans(page, ".fichiers-vue", PHRASES.detailsUtf16);
    await page.attendreQue(`${exprLigne("lien-environ.txt")}?.textContent.includes(${JSON.stringify(PHRASES.lienAvance)})`, { libelle: `« ${PHRASES.lienAvance} » dans l'arborescence` });
    exiger(await page.evaluer(`document.querySelector(${JSON.stringify(`${SECTION} .fichiers-caches input`)}).checked`), "mode Avancé : case des fichiers cachés décochée.");
    await page.attendreQue(`Boolean(${exprLigne(".editorconfig")})`, { libelle: ".editorconfig affiché en mode Avancé" });
  });
  await attendreModeAffiche(page, "simple");

  // 7. Aucun appel pendant les étapes de l'onglet.
  if (faux) {
    const pendant = (await ctx.opencodeRequests()).slice(requetesAvant);
    const fichiersOuRecherche = pendant.filter((r) => /^\/(?:file|find)(?:\/|$)/.test(r.pathname ?? ""));
    exiger(fichiersOuRecherche.length === 0, `requête(s) /file* ou /find* reçue(s) par opencode : ${resume(fichiersOuRecherche.map((r) => r.pathname))}`);
    const factures = (await ctx.billedCalls()).length;
    exiger(factures === facturesAvant, `${factures - facturesAvant} appel(s) facturable(s) pendant les étapes de l'onglet Fichiers.`);
    releve(ctx, `aucun appel : ${pendant.length} requête(s) reçue(s) par opencode pendant l'onglet, aucune /file* ni /find*, aucune facturable`);
  } else {
    nonJoue(ctx, "relevé des requêtes reçues par opencode", "observable en « --faux » seulement");
  }

  // Journal réseau : réponses des routes de l'onglet, toutes 200 sauf le refus voulu de .env.
  const refus = page.journalReseau().filter((l) => /\/api\/fichiers\//.test(l.url ?? "") && typeof l.code === "number" && l.code !== 200);
  exiger(refus.length === 1 && refus[0].code === 403 && /\/api\/fichiers\/contenu$/.test(refus[0].url), `réponses des routes de l'onglet hors 200 : ${resume(refus.map((l) => `${l.code} ${l.url}`))}`);

  // 8. Chat : « Ouvrir dans Fichiers » sur un outil write terminé.
  if (faux) {
    await avecTemoinP6(ctx, async () => {
      const ia = await attendreIa(ctx);
      const client = oc(ctx);
      const racine = await client.creerConversation("nav-fichiers-ouvrir");
      await ctx.faux.scripter(racine.id, {
        tools: [{ tool: "write", input: { filePath: `${DANS_CONTENEUR}/scripts/nouveau.ps1`, content: CONTENU_NOUVEAU } }],
        followUp: { text: "Script écrit." },
      });
      const envoi = await client.envoyer(racine.id, "Écris scripts/nouveau.ps1", ia);
      exiger(envoi.code === 204, `envoi refusé (${envoi.code}) : ${resume(envoi.corps)}`);
      await attendreFinDuTour(client, racine.id);
      await ouvrirConversation(ctx, racine.id);
      const href = adresse(PROJET, "scripts/nouveau.ps1");
      await page.attendreQue(`[...document.querySelectorAll("a.tool-open-files")].some((a) => a.textContent.trim() === ${JSON.stringify(PHRASES.ouvrirDansFichiers)} && a.getAttribute("href") === ${JSON.stringify(href)} && !a.closest("button"))`, {
        libelle: `« ${PHRASES.ouvrirDansFichiers} » sur la carte de l'outil write`,
      });
      await page.evaluer(`[...document.querySelectorAll("a.tool-open-files")].find((a) => a.getAttribute("href") === ${JSON.stringify(href)}).click()`);
      const nouveau = await attendreFichierOuvert(page, "nouveau.ps1");
      exiger(nouveau.includes("nouveau script de l'IA"), `nouveau.ps1 ouvert depuis le chat : ${resume(nouveau)}`);
      releve(ctx, `chat : « ${PHRASES.ouvrirDansFichiers} » sur l'outil write terminé ouvre scripts/nouveau.ps1 dans l'onglet`);
    });
  } else {
    nonJoue(ctx, "« Ouvrir dans Fichiers » depuis un outil write joué par le faux opencode", "le faux fournisseur ne répond que du texte");
  }

  // 9. Console et CSP.
  await exigerAucuneViolationCsp(page);
  ctx.expectNoConsoleErrors(CONSOLE_REFUS_VOULU);
}
