// Onglet « Fichiers » côté web (1.1, NAV-3 ; fiche NAV §5, §9 V5) : Node seul, sans navigateur ni serveur (NAV-3 n'appelle pas
// les routes dans ses tests : seulement les types, les textes et les adresses de NAV-1 ; fetch est remplacé par un espion).
// - arbre-etat.ts (pur) : ouvrir, fermer, cache, liste plus récente, refus puis nouvel essai, filtre des cachés et générés (G5),
//   révélation d'une adresse profonde ;
// - api-fichiers.ts : quatre routes POST tirées de FICHIERS_ROUTES, en-tête anti-CSRF, signal d'annulation transmis, codes de
//   refus, files d'attente (deux lectures, un parcours) ;
// - contrôles statiques de pages/fichiers/** et de lib/api-fichiers.ts : texte seul (XSS), aucun texte JSX littéral, aucune
//   région live ni gestion de touche propre, seuls href permis, motif de divulgation, forced-colors et aucun mouvement ;
// - fichiers partagés balisés : App.tsx (entrée du rail juste après « Chat », sans advancedOnly), ToolCard.tsx (lien par
//   adresseDepuisOutil, hors de tout bouton), web-animations.test.ts (périmètre) ;
// - D14 (b) : aucune action de conversation, aucun appel au changeur de projet du chat (nom relu dans AppContext.tsx).
// Chaque contrôle statique est d'abord éprouvé sur des sources fabriquées (il échoue sans sa garde).
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, it, type TestContext } from "node:test";
import { FICHIERS_ROUTES, NAV_BORNES } from "./shared/fichiers-regles.ts";
import { TEXTES } from "./shared/fichiers-texts.ts";
import type { DossierReponse, EntreeVue } from "./shared/fichiers-types.ts";
import { codeFichiers, estAnnule, fileDAttente, fichiersApi } from "../web/lib/api-fichiers.ts";
import { ApiError } from "../web/lib/api.ts";
import { ancetres, cheminDe, echouer, fermer, lignesVisibles, ouvrir, recevoir, reveler, vider } from "../web/pages/fichiers/arbre-etat.ts";

const WEB = path.join(import.meta.dirname, "..", "web");
const PAGES = path.join(WEB, "pages", "fichiers");
const lire = (relatif: string): string => fs.readFileSync(path.join(WEB, relatif), "utf8");
/** Balises assemblées : ce fichier n'en écrit aucune (fichiers-balises.test.ts). */
const NAV = "nav" + ":";

// --- Aides ------------------------------------------------------------------------------------------------------------------------

function entree(nom: string, type: EntreeVue["type"] = "fichier", options: Partial<EntreeVue> = {}): EntreeVue {
  return {
    nom,
    nomVisible: nom,
    type,
    taille: type === "fichier" ? 10 : null,
    modifieA: 1_700_000_000_000,
    cache: nom.startsWith("."),
    genere: ["node_modules", ".venv", "__pycache__"].includes(nom),
    ...options,
  };
}

function liste(chemin: string, entrees: EntreeVue[], options: Partial<DossierReponse> = {}): DossierReponse {
  return { projet: "p", chemin, entrees, masques: 0, tronque: false, ...options };
}

/** Noms montrés à un niveau de l'arbre visible. */
const noms = (dossier: { lignes: Array<{ entree: EntreeVue }> }) => dossier.lignes.map((ligne) => ligne.entree.nom);

/** Source sans commentaires (positions gardées) ; les chaînes sont recopiées telles quelles. */
function sansCommentaires(texte: string): string {
  let sortie = "";
  let i = 0;
  const blanc = (morceau: string) => morceau.replace(/[^\n]/g, " ");
  while (i < texte.length) {
    const c = texte.charAt(i);
    const suivant = texte.charAt(i + 1);
    if (c === "/" && (suivant === "/" || suivant === "*")) {
      const fin = suivant === "/" ? texte.indexOf("\n", i) : texte.indexOf("*/", i + 2);
      const arret = fin === -1 ? texte.length : suivant === "/" ? fin : fin + 2;
      sortie += blanc(texte.slice(i, arret));
      i = arret;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") {
      let j = i + 1;
      while (j < texte.length && texte.charAt(j) !== c && !(c !== "`" && texte.charAt(j) === "\n")) j += texte.charAt(j) === "\\" ? 2 : 1;
      sortie += texte.slice(i, Math.min(j + 1, texte.length));
      i = j + 1;
      continue;
    }
    sortie += c;
    i++;
  }
  return sortie;
}

interface Source {
  fichier: string;
  texte: string;
}

/** Sources de l'onglet : pages/fichiers/** et lib/api-fichiers.ts (chemins relatifs à web/). */
function sourcesFichiers(): Source[] {
  const pages = (fs.readdirSync(PAGES, { recursive: true }) as string[])
    .map((entreeRelative) => `pages/fichiers/${entreeRelative.replaceAll("\\", "/")}`)
    .filter((fichier) => /\.(?:tsx?|css)$/.test(fichier));
  return [...pages, "lib/api-fichiers.ts"].sort().map((fichier) => ({ fichier, texte: lire(fichier) }));
}

// --- Règles statiques (chacune éprouvée sur des sources fabriquées) -----------------------------------------------------------------

/** Rendus autres que le texte, et exécution de code : interdits (fiche §5, instruction 10). */
const INTERDITS_XSS: ReadonlyArray<[string, RegExp]> = [
  ["dangerouslySetInnerHTML", /dangerouslySetInnerHTML/],
  ["innerHTML", /\binnerHTML\b/],
  ["outerHTML", /\bouterHTML\b/],
  ["insertAdjacentHTML", /\binsertAdjacentHTML\b/],
  ["document.write", /\bdocument\s*\.\s*write/],
  ["marked", /\bmarked\b/],
  ["dompurify", /dompurify/i],
  ["highlight.js", /highlight\.js/],
  ["renderMarkdown", /\brenderMarkdown\b/],
  ["highlightCode", /\bhighlightCode\b/],
  ["eval(", /\beval\s*\(/],
  ["new Function", /\bnew\s+Function\b/],
  ["composant Markdown", /components\/Markdown/],
  ["DiffView", /\bDiffView\b/],
];

function interditsXss(source: string): string[] {
  const code = sansCommentaires(source);
  return INTERDITS_XSS.filter(([, motif]) => motif.test(code)).map(([nom]) => nom);
}

/** Attributs qui ne s'affichent pas : une chaîne littérale y est permise. */
const ATTRIBUTS_NON_AFFICHES = new Set(["className", "id", "key", "type", "role", "htmlFor", "autoComplete"]);

/** Textes affichés écrits en dur dans un .tsx : texte JSX, attribut affiché littéral, chaîne littérale en enfant JSX. */
function textesLitteraux(source: string): string[] {
  const code = sansCommentaires(source);
  const trouves: string[] = [];
  for (const m of code.matchAll(/>([^<>{}()=;]*\p{L}[^<>{}()=;]*)</gu)) {
    // « > » d'un opérateur (a > 0 && b < 2, =>) plutôt que la fin d'une balise : ignoré.
    const avant = code.charAt((m.index ?? 0) - 1);
    const operateur = avant === "=" || (avant === " " && /[\w)\].]/.test(code.charAt((m.index ?? 0) - 2)) && /^\s/.test(m[1] ?? ""));
    if (!operateur) trouves.push((m[1] ?? "").trim());
  }
  // Texte JSX qui suit une expression : « {a} texte</p> ».
  for (const m of code.matchAll(/\}([^<>{}()=;:?&|]*\p{L}[^<>{}()=;:?&|]*)<\//gu)) trouves.push((m[1] ?? "").trim());
  for (const m of code.matchAll(/\b(aria-label|aria-description|aria-roledescription|title|placeholder|alt|label)=(["'])([^"']*\p{L}[^"']*)\2/gu)) {
    trouves.push(`${m[1]}=${m[3]}`);
  }
  for (const m of code.matchAll(/(\b[\w-]+=)?\{\s*(["'`])((?:(?!\2)[\s\S])*?\p{L}(?:(?!\2)[\s\S])*?)\2\s*\}/gu)) {
    const attribut = (m[1] ?? "").slice(0, -1);
    if (!ATTRIBUTS_NON_AFFICHES.has(attribut)) trouves.push(m[3] ?? "");
  }
  return trouves;
}

/** Une seule région live par page (§5.5) : l'annonceur de la page ; aucune autre ici. */
const REGIONS_LIVE: ReadonlyArray<[string, RegExp]> = [
  ["aria-live", /aria-live/],
  ['role="status"', /role=["']status["']/],
  ['role="alert"', /role=["']alert["']/],
  ['role="log"', /role=["']log["']/],
  ['role="timer"', /role=["']timer["']/],
  ["Spinner (role status)", /<Spinner\b/],
  ["useToast", /\buseToast\b/],
];

function regionsLive(source: string): string[] {
  const code = sansCommentaires(source);
  return REGIONS_LIVE.filter(([, motif]) => motif.test(code)).map(([nom]) => nom);
}

/** Motif de divulgation (G2) : aucune gestion de touche propre, aucune touche seule. */
function gestionClavier(source: string): string[] {
  const code = sansCommentaires(source);
  return [...code.matchAll(/\bon(?:KeyDown|KeyUp|KeyPress)\b|addEventListener\(\s*["']key\w*["']|\baccessKey\b/g)].map((m) => m[0]);
}

/** Seuls href permis : adresseFichiers(…) ou routeHref(…), jamais un lien fabriqué à partir du contenu. */
function hrefsNonPermis(source: string): string[] {
  const code = sansCommentaires(source);
  return [...code.matchAll(/\bhref=(\{?\s*[^\s>]*)/g)].map((m) => m[1] ?? "").filter((valeur) => !/^\{\s*(?:adresseFichiers|routeHref)\(/.test(valeur));
}

/** Actions de conversation et changement du projet du chat (D14 (b)) ; `changeur` : nom réel lu dans AppContext.tsx. */
function actionsDeConversation(source: string, changeur: string): string[] {
  const code = sansCommentaires(source);
  const motifs: RegExp[] = [
    new RegExp(`\\b${changeur}\\b`),
    /\bcreateSession\b/,
    /\bpromptAsync\b/,
    /\boc\s*\./,
    /\bonOpenSession\b/,
    /\bchatWithAssistantHref\b|\bopenChatWithAssistant\b/,
    /(?:routeHref|navigate)\(\s*["']chat["']/,
    /#\/chat/,
    /lib\/api\.ts/,
  ];
  return motifs.filter((motif) => motif.test(code)).map((motif) => motif.source);
}

/** Vrai si `indice` est entre une ouverture <button et sa fermeture. */
function dansUnBouton(source: string, indice: number): boolean {
  const avant = sansCommentaires(source).slice(0, indice);
  const ouvertures = [...avant.matchAll(/<button\b/g)].length;
  const fermetures = [...avant.matchAll(/<\/button>/g)].length;
  return ouvertures > fermetures;
}

/** Section d'une balise (forme donnée) dans un source, ou null. */
function section(source: string, ouvre: string, ferme: string): { debut: number; texte: string } | null {
  const debut = source.indexOf(ouvre);
  const fin = debut === -1 ? -1 : source.indexOf(ferme, debut + ouvre.length);
  return debut === -1 || fin === -1 ? null : { debut, texte: source.slice(debut + ouvre.length, fin) };
}

// --- Tests ------------------------------------------------------------------------------------------------------------------------

describe("arbre-etat : ouvrir, fermer, cache", () => {
  it("ouvrir demande la liste une seule fois ; replier garde le cache ; déplier de nouveau sert le cache", () => {
    const depart = vider();
    const a = ouvrir(depart, "");
    assert.deepEqual([...a.ouverts], [""]);
    assert.deepEqual([...a.chargements], [""]);
    assert.equal(depart.ouverts.size, 0, "l'état précédent n'est jamais modifié");
    assert.equal(ouvrir(a, "").chargements.size, 1, "déjà demandée : pas une seconde fois");
    const b = recevoir(a, "", liste("", [entree("src", "dossier"), entree("README.md")]));
    assert.equal(b.chargements.size, 0);
    const c = ouvrir(b, "src");
    assert.deepEqual([...c.chargements], ["src"]);
    const d = recevoir(c, "src", liste("src", [entree("main.ts")]));
    assert.deepEqual(noms(lignesVisibles(d, { montrerCaches: false }).lignes[0]?.contenu ?? { lignes: [] }), ["main.ts"]);
    const e = fermer(d, "src");
    assert.equal(lignesVisibles(e, { montrerCaches: false }).lignes[0]?.contenu, null, "replié : aucun contenu montré");
    assert.ok(e.listes.has("src"), "replié : la liste reste en cache");
    const f = ouvrir(e, "src");
    assert.equal(f.chargements.size, 0, "déplié de nouveau : aucune nouvelle requête");
    assert.deepEqual(noms(lignesVisibles(f, { montrerCaches: false }).lignes[0]?.contenu ?? { lignes: [] }), ["main.ts"]);
    // « Actualiser » : tout est vidé.
    const g = vider();
    assert.equal(g.listes.size + g.ouverts.size + g.chargements.size + g.erreurs.size + g.reveles.size, 0);
  });

  it("une liste plus récente remplace l'ancienne ; un refus est gardé puis oublié au nouvel essai", () => {
    let etat = recevoir(ouvrir(vider(), ""), "", liste("", [entree("a.txt")]));
    etat = recevoir(etat, "", liste("", [entree("a.txt"), entree("b.txt")], { masques: 2, tronque: true }));
    const racine = lignesVisibles(etat, { montrerCaches: false });
    assert.deepEqual(noms(racine), ["a.txt", "b.txt"]);
    assert.equal(racine.masques, 2);
    assert.equal(racine.tronque, true);
    assert.equal(racine.recues, 2);
    etat = echouer(ouvrir(etat, "x"), "x", "protege");
    assert.equal(etat.erreurs.get("x"), "protege");
    assert.equal(etat.chargements.has("x"), false);
    etat = ouvrir(etat, "x");
    assert.equal(etat.erreurs.has("x"), false, "nouvel essai : le refus est oublié");
    assert.equal(etat.chargements.has("x"), true);
    etat = recevoir(etat, "x", liste("x", []));
    assert.equal(etat.erreurs.has("x"), false);
  });

  it("dossier vide, liste reçue, chargement : états distincts", () => {
    const enCours = lignesVisibles(ouvrir(vider(), ""), { montrerCaches: false });
    assert.deepEqual([enCours.chargement, enCours.charge, enCours.recues], [true, false, 0]);
    const vide = lignesVisibles(recevoir(ouvrir(vider(), ""), "", liste("", [])), { montrerCaches: false });
    assert.deepEqual([vide.chargement, vide.charge, vide.recues, vide.masques], [false, true, 0, 0]);
  });
});

describe("arbre-etat : fichiers cachés et générés (G5), révélation d'une adresse", () => {
  const racine = [
    entree(".vscode", "dossier"),
    entree("node_modules", "dossier"),
    entree("src", "dossier"),
    entree(".gitignore"),
    entree("README.md"),
    entree("lien", "lien", { taille: null }),
  ];

  it("case décochée : ni fichier caché ni dossier généré ; cochée : tout ; les liens restent montrés", () => {
    const etat = recevoir(ouvrir(vider(), ""), "", liste("", racine));
    assert.deepEqual(noms(lignesVisibles(etat, { montrerCaches: false })), ["src", "README.md", "lien"]);
    assert.deepEqual(noms(lignesVisibles(etat, { montrerCaches: true })), [".vscode", "node_modules", "src", ".gitignore", "README.md", "lien"]);
    assert.equal(lignesVisibles(etat, { montrerCaches: false }).recues, 6, "le filtre est un choix d'affichage : tout est reçu");
  });

  it("ancetres : dossiers à déplier pour une adresse", () => {
    assert.deepEqual(ancetres([]), []);
    assert.deepEqual(ancetres(["a.txt"]), [""]);
    assert.deepEqual(ancetres(["a", "b", "c.ps1"]), ["", "a", "a/b"]);
    assert.equal(cheminDe("", "x"), "x");
    assert.equal(cheminDe("a/b", "x"), "a/b/x");
  });

  it("adresse profonde dans un dossier généré : parents dépliés et montrés même en mode Simple, frères cachés toujours masqués", () => {
    let etat = reveler(ouvrir(vider(), ""), ["node_modules", "pkg", "index.js"]);
    assert.deepEqual([...etat.ouverts].sort(), ["", "node_modules", "node_modules/pkg"]);
    assert.deepEqual([...etat.chargements].sort(), ["", "node_modules", "node_modules/pkg"]);
    etat = recevoir(etat, "", liste("", racine));
    etat = recevoir(etat, "node_modules", liste("node_modules", [entree(".bin", "dossier"), entree("pkg", "dossier"), entree("autre", "dossier")]));
    etat = recevoir(etat, "node_modules/pkg", liste("node_modules/pkg", [entree(".npmignore"), entree("index.js"), entree("package.json")]));
    const vue = lignesVisibles(etat, { montrerCaches: false });
    assert.deepEqual(noms(vue), ["node_modules", "src", "README.md", "lien"], "node_modules révélé ; .vscode et .gitignore masqués");
    const modules = vue.lignes.find((ligne) => ligne.entree.nom === "node_modules")?.contenu;
    assert.ok(modules);
    assert.deepEqual(noms(modules), ["pkg", "autre"], ".bin reste masqué");
    const pkg = modules.lignes.find((ligne) => ligne.entree.nom === "pkg")?.contenu;
    assert.ok(pkg);
    assert.deepEqual(noms(pkg), ["index.js", "package.json"]);
    // Sans révélation, node_modules ne serait pas montré (discriminant).
    const sans = recevoir(ouvrir(vider(), ""), "", liste("", racine));
    assert.equal(noms(lignesVisibles(sans, { montrerCaches: false })).includes("node_modules"), false);
  });

  it("révéler un dossier (fil d'Ariane, résultat de recherche) le déplie aussi", () => {
    const etat = reveler(ouvrir(vider(), ""), ["a", "b"], true);
    assert.deepEqual([...etat.ouverts].sort(), ["", "a", "a/b"]);
    assert.equal(reveler(ouvrir(vider(), ""), ["a", "b"]).ouverts.has("a/b"), false);
  });

  it("un état fabriqué ne fait jamais boucler l'affichage (profondeur bornée)", () => {
    let etat = ouvrir(vider(), "");
    let chemin = "";
    for (let i = 0; i < 80; i++) {
      etat = recevoir(etat, chemin, liste(chemin, [entree("d", "dossier")]));
      chemin = cheminDe(chemin, "d");
      etat = ouvrir(etat, chemin);
    }
    let niveau = lignesVisibles(etat, { montrerCaches: true });
    let profondeur = 0;
    while (niveau.lignes[0]?.contenu) {
      niveau = niveau.lignes[0].contenu;
      profondeur++;
    }
    assert.ok(profondeur <= 64, `profondeur ${profondeur}`);
  });
});

interface Appel {
  methode: string;
  url: string;
  entetes: Record<string, string>;
  corps: unknown;
  signal: AbortSignal | null | undefined;
}

/** Remplace fetch : chaque appel est noté et reçoit `reponse` (aucun réseau). */
function espion(t: TestContext, reponse: { status: number; body?: unknown } | "reseau"): Appel[] {
  const appels: Appel[] = [];
  t.mock.method(globalThis, "fetch", async (input: string | URL | Request, init?: RequestInit) => {
    const entetes = Object.fromEntries(Object.entries((init?.headers ?? {}) as Record<string, string>).map(([k, v]) => [k.toLowerCase(), v]));
    appels.push({ methode: init?.method ?? "GET", url: String(input), entetes, corps: typeof init?.body === "string" ? JSON.parse(init.body) : null, signal: init?.signal });
    if (reponse === "reseau") throw new TypeError("fetch failed");
    return new Response(reponse.body === undefined ? null : JSON.stringify(reponse.body), { status: reponse.status });
  });
  return appels;
}

describe("api-fichiers : client mince", () => {
  it("quatre routes POST de FICHIERS_ROUTES, en-tête anti-CSRF, corps exact, signal transmis à chaque appel", async (t) => {
    const appels = espion(t, { status: 200, body: {} });
    const controleur = new AbortController();
    await fichiersApi.dossier("p", "a/b", controleur.signal);
    await fichiersApi.contenu("", "p/x.ps1", controleur.signal);
    await fichiersApi.recents("p", controleur.signal);
    await fichiersApi.recherche("p", "rapport", controleur.signal);
    assert.deepEqual(
      appels.map((a) => [a.methode, a.url, a.corps]),
      [
        ["POST", FICHIERS_ROUTES.dossier, { projet: "p", chemin: "a/b" }],
        ["POST", FICHIERS_ROUTES.contenu, { projet: "", chemin: "p/x.ps1" }],
        ["POST", FICHIERS_ROUTES.recents, { projet: "p" }],
        ["POST", FICHIERS_ROUTES.recherche, { projet: "p", texte: "rapport" }],
      ],
    );
    for (const appel of appels) {
      assert.equal(appel.entetes["x-cockpit-csrf"], "1");
      assert.equal(appel.signal, controleur.signal);
    }
    // Aucune adresse écrite en dur dans le client : toutes viennent de FICHIERS_ROUTES.
    assert.doesNotMatch(sansCommentaires(lire("lib/api-fichiers.ts")), /["'`]\/api\//);
  });

  it("codes de refus : ceux des routes « fichiers » seulement ; réseau, CSRF, session : phrase générale ; annulation reconnue", async (t) => {
    espion(t, { status: 403, body: { error: "protege", message: TEXTES.partout.protegeFichier } });
    const refus = await fichiersApi.contenu("p", ".env", new AbortController().signal).catch((erreur: unknown) => erreur);
    assert.equal(codeFichiers(refus), "protege");
    assert.equal(codeFichiers(new ApiError(403, "csrf", "x")), null);
    assert.equal(codeFichiers(new ApiError(0, "network", "x")), null);
    assert.equal(codeFichiers(new Error("x")), null);
    assert.equal(estAnnule(new DOMException("x", "AbortError")), true);
    assert.equal(estAnnule(new ApiError(409, "a-change", "x")), false);
    const annule = new AbortController();
    annule.abort();
    const erreur = await fichiersApi.dossier("p", "", annule.signal).catch((e: unknown) => e);
    assert.equal(estAnnule(erreur), true, "déjà annulé : jamais envoyé");
  });

  const tour = () => new Promise<void>((resolve) => setImmediate(resolve));

  it("file d'attente : jamais plus de `limite` tâches à la fois, la place passe à la suivante", { timeout: 10_000 }, async () => {
    const file = fileDAttente(2);
    const signal = new AbortController().signal;
    let actives = 0;
    let maximum = 0;
    const fins: Array<() => void> = [];
    const tache = () =>
      new Promise<number>((resolve) => {
        actives++;
        maximum = Math.max(maximum, actives);
        fins.push(() => {
          actives--;
          resolve(actives);
        });
      });
    const promesses = [file(tache, signal), file(tache, signal), file(tache, signal), file(tache, signal)];
    await tour();
    assert.equal(fins.length, 2, "deux tâches lancées, deux en attente");
    fins[0]?.();
    await tour();
    // Une nouvelle tâche arrivée pendant le transfert de la place attend aussi.
    const tardive = file(tache, signal);
    await tour();
    assert.equal(fins.length, 3);
    for (let i = 1; i < 5; i++) {
      fins[i]?.();
      await tour();
    }
    await Promise.all([...promesses, tardive]);
    assert.equal(fins.length, 5);
    assert.equal(maximum, 2);
  });

  it("file d'attente : une tâche annulée pendant l'attente n'est jamais lancée et rend sa place", { timeout: 10_000 }, async () => {
    const file = fileDAttente(1);
    const libre = new AbortController().signal;
    let fin: () => void = () => undefined;
    let lancees = 0;
    const premiere = file(() => new Promise<void>((resolve) => ((lancees += 1), (fin = resolve))), libre);
    const annulee = new AbortController();
    const seconde = file(async () => void (lancees += 1), annulee.signal);
    await tour();
    annulee.abort();
    await assert.rejects(seconde, (erreur: unknown) => estAnnule(erreur));
    fin();
    await premiere;
    await file(async () => void (lancees += 1), libre);
    assert.equal(lancees, 2, "la tâche annulée n'a jamais tourné, la suivante a eu sa place");
  });

  it("bornes des files : celles du serveur (deux lectures, un parcours)", () => {
    const source = sansCommentaires(lire("lib/api-fichiers.ts"));
    assert.equal(NAV_BORNES.LECTURES_SIMULTANEES, 2);
    assert.match(source, /const lectures = fileDAttente\(NAV_BORNES\.LECTURES_SIMULTANEES\);/);
    assert.match(source, /const parcours = fileDAttente\(1\);/);
    assert.match(source, /dossier: [^\n]*\n\s*lectures\(/);
    assert.match(source, /contenu: [^\n]*\n\s*lectures\(/);
    assert.match(source, /recents: [^\n]*\n\s*parcours\(/);
    assert.match(source, /recherche: [^\n]*\n\s*parcours\(/);
  });
});

describe("contrôles statiques : contrôles discriminants sur des sources fabriquées", () => {
  it("texte seul : chaque interdit est trouvé, les commentaires sont ignorés", () => {
    const cas: Array<[string, string]> = [
      ["<pre dangerouslySetInnerHTML={{ __html: t }} />", "dangerouslySetInnerHTML"],
      ["el.innerHTML = t;", "innerHTML"],
      ["el.outerHTML = t;", "outerHTML"],
      ['el.insertAdjacentHTML("beforeend", t);', "insertAdjacentHTML"],
      ["document.write(t);", "document.write"],
      ['import { marked } from "marked";', "marked"],
      ['import DOMPurify from "dompurify";', "dompurify"],
      ['import hljs from "highlight.js";', "highlight.js"],
      ["renderMarkdown(t);", "renderMarkdown"],
      ["highlightCode(t);", "highlightCode"],
      ["eval(t);", "eval("],
      ['new Function("return 1");', "new Function"],
      ['import { Markdown } from "../../components/Markdown.tsx";', "composant Markdown"],
      ["<DiffView patch={t} />", "DiffView"],
    ];
    for (const [source, attendu] of cas) assert.deepEqual(interditsXss(source), [attendu], source);
    assert.deepEqual(interditsXss("// innerHTML, marked, eval(x)\n/* dangerouslySetInnerHTML */ const remarque = 1;"), []);
  });

  it("textes : texte JSX, attribut affiché et chaîne en enfant trouvés ; TEXTES, classes et séparateurs permis", () => {
    assert.deepEqual(textesLitteraux("<p>Bonjour</p>"), ["Bonjour"]);
    assert.deepEqual(textesLitteraux("<p><b>{x}</b> suite</p>"), ["suite"]);
    assert.deepEqual(textesLitteraux(["<a", "  href={x}", ">", "  Texte en dur", "</a>"].join(String.fromCharCode(10))), ["Texte en dur"]);
    assert.deepEqual(textesLitteraux("{ouvert ? <Icon name={i} /> : null} Titre</p>"), ["Titre"]);
    assert.deepEqual(textesLitteraux("<p>{a} texte</p>"), ["texte"]);
    assert.deepEqual(textesLitteraux('<pre aria-label="Contenu du fichier">{t}</pre>'), ["aria-label=Contenu du fichier"]);
    assert.deepEqual(textesLitteraux('<Button title="Copier">{x}</Button>'), ["title=Copier"]);
    assert.deepEqual(textesLitteraux('<span>{"Chargement"}</span>'), ["Chargement"]);
    assert.deepEqual(textesLitteraux("<option>{`Tout le workspace`}</option>"), ["Tout le workspace"]);
    assert.deepEqual(textesLitteraux('<p aria-label={"Fil"}>{a}</p>'), ["Fil"]);
    const permis = [
      "<p>{TEXTES.partout.vide}</p>",
      '<span className="fichiers-meta">{a}{" · "}{b}</span>',
      '<div className={`x${y ? " y" : ""}`} id={"zone"} key={"k"}>{a} · {b}</div>',
      "const x = useState<Map<string, number>>(new Map());",
      "if (a > 0 && b < 2) return null;",
      "// <p>Bonjour</p>\nconst y = 1;",
    ];
    for (const source of permis) assert.deepEqual(textesLitteraux(source), [], source);
  });

  it("régions live, gestion de touche et href : trouvés ; adresseFichiers et routeHref permis", () => {
    assert.deepEqual(regionsLive('<p role="status">{x}</p>'), ['role="status"']);
    assert.deepEqual(regionsLive('<div aria-live="polite" />'), ["aria-live"]);
    assert.deepEqual(regionsLive("<Spinner />"), ["Spinner (role status)"]);
    assert.deepEqual(regionsLive('<p role="alert">{x}</p>'), ['role="alert"']);
    assert.deepEqual(regionsLive("const toast = useToast();"), ["useToast"]);
    assert.deepEqual(regionsLive('<form role="search" />'), []);
    assert.deepEqual(gestionClavier("<ul onKeyDown={f} />"), ["onKeyDown"]);
    assert.deepEqual(gestionClavier('window.addEventListener("keydown", f);'), ['addEventListener("keydown"']);
    assert.deepEqual(gestionClavier("<button onClick={f} />"), []);
    assert.deepEqual(hrefsNonPermis("<a href={texte}>{x}</a>"), ["{texte}"]);
    assert.deepEqual(hrefsNonPermis('<a href="https://exemple.fr">{x}</a>'), ['"https://exemple.fr"']);
    assert.deepEqual(hrefsNonPermis("<a href={`#/fichiers?chemin=${c}`}>{x}</a>"), ["{`#/fichiers?chemin=${c}`}"]);
    assert.deepEqual(hrefsNonPermis('<a href={adresseFichiers({ projet, chemin })}>{x}</a><a href={routeHref("fichiers")}>{y}</a>'), []);
  });

  it("D14 (b) : changeur de projet du chat et actions de conversation trouvés", () => {
    assert.ok(actionsDeConversation("const { setDirectory } = useApp();", "setDirectory").length > 0);
    assert.ok(actionsDeConversation("await oc.createSession(d);", "setDirectory").length > 0);
    assert.ok(actionsDeConversation('navigate("chat");', "setDirectory").length > 0);
    assert.ok(actionsDeConversation('<a href="#/chat">{x}</a>', "setDirectory").length > 0);
    assert.ok(actionsDeConversation('import { api } from "../../lib/api.ts";', "setDirectory").length > 0);
    assert.deepEqual(actionsDeConversation('import { fichiersApi } from "../../lib/api-fichiers.ts";\nconst { boot } = useApp();', "setDirectory"), []);
  });

  it("lien dans un bouton : trouvé ; lien après le bouton : permis", () => {
    const dedans = '<button type="button">{a}<a href={x}>{b}</a></button>';
    const apres = '<button type="button">{a}</button><a href={x}>{b}</a>';
    assert.equal(dansUnBouton(dedans, dedans.indexOf("<a ")), true);
    assert.equal(dansUnBouton(apres, apres.indexOf("<a ")), false);
  });
});

describe("contrôles statiques : pages/fichiers/** et lib/api-fichiers.ts", () => {
  const sources = sourcesFichiers();

  it("les sept fichiers possédés de l'interface sont présents (le huitième est ce test)", () => {
    assert.deepEqual(
      sources.map((s) => s.fichier),
      [
        "lib/api-fichiers.ts",
        "pages/fichiers/ArbreFichiers.tsx",
        "pages/fichiers/FichiersPage.tsx",
        "pages/fichiers/RecentsRecherche.tsx",
        "pages/fichiers/VueFichier.tsx",
        "pages/fichiers/arbre-etat.ts",
        "pages/fichiers/fichiers.css",
      ],
    );
  });

  it("texte seul : aucun rendu HTML ou Markdown, aucune coloration, aucune exécution de code", () => {
    for (const { fichier, texte } of sources) assert.deepEqual(interditsXss(texte), [], fichier);
    // Mutation d'un source réel : la garde tombe.
    const vue = lire("pages/fichiers/VueFichier.tsx");
    const mute = vue.replace("{texte}</pre>", "</pre><div dangerouslySetInnerHTML={{ __html: texte }} />");
    assert.notEqual(mute, vue);
    assert.deepEqual(interditsXss(mute), ["dangerouslySetInnerHTML"]);
  });

  it("aucun texte JSX littéral qui contient une lettre : tous les textes viennent de TEXTES", () => {
    for (const { fichier, texte } of sources.filter((s) => s.fichier.endsWith(".tsx"))) assert.deepEqual(textesLitteraux(texte), [], fichier);
    const page = lire("pages/fichiers/FichiersPage.tsx");
    assert.deepEqual(textesLitteraux(page.replace("{TEXTES.partout.titre}", "Fichiers des projets")), ["Fichiers des projets"]);
  });

  it("aucune région live ajoutée (annonceur de la page seulement), aucune gestion de touche propre", () => {
    for (const { fichier, texte } of sources) {
      assert.deepEqual(regionsLive(texte), [], fichier);
      assert.deepEqual(gestionClavier(texte), [], fichier);
    }
    const page = sansCommentaires(lire("pages/fichiers/FichiersPage.tsx"));
    assert.match(page, /const dire = useAnnouncer\(ui\.activityAnnouncements\);/);
    for (const cle of ["annonceDossier", "annonceFichier", "annonceResultats"]) assert.match(page, new RegExp(`TEXTES\\.partout\\.${cle}\\b`), cle);
    // Train V5 : chaque annonce passe par l'accord (singulier pour 0 et 1), jamais par un gabarit au pluriel seul.
    for (const cle of ["annonceDossier", "annonceFichier", "annonceResultats"]) {
      assert.match(page, new RegExp(`remplirAccorde\\(TEXTES\\.partout\\.${cle}Un, TEXTES\\.partout\\.${cle}, `), cle);
    }
    assert.equal(/\bremplir\(/.test(page), false, "aucune annonce par remplir seul");
  });

  it("seuls href : adresseFichiers ou routeHref", () => {
    for (const { fichier, texte } of sources) assert.deepEqual(hrefsNonPermis(texte), [], fichier);
  });

  it("D14 (b) : ni action de conversation, ni appel au changeur de projet du chat (nom relu dans AppContext.tsx)", () => {
    const contexte = lire("app/AppContext.tsx");
    const changeur = /\n\s+(\w+): \(directory: string\) => void;/.exec(contexte)?.[1];
    assert.equal(changeur, "setDirectory", "AppContext expose toujours son changeur de projet sous ce nom");
    for (const { fichier, texte } of sources) assert.deepEqual(actionsDeConversation(texte, changeur), [], fichier);
    // La page ne lit que ces champs du contexte.
    const page = sansCommentaires(lire("pages/fichiers/FichiersPage.tsx"));
    assert.deepEqual([...page.matchAll(/=\s*useApp\(\)/g)].length, 1);
    assert.match(page, /const \{ boot, project, advanced, ui \} = useApp\(\);/);
    for (const { fichier, texte } of sources.filter((s) => s.fichier.startsWith("pages/"))) {
      assert.equal(/useApp\(\)/.test(texte), fichier === "pages/fichiers/FichiersPage.tsx", fichier);
    }
  });

  it("motif de divulgation (G2) et noms dans <bdi> (G4)", () => {
    const arbre = sansCommentaires(lire("pages/fichiers/ArbreFichiers.tsx"));
    for (const extrait of [
      '<nav className="fichiers-arbre" aria-label={remplir(TEXTES.partout.arbre, { projet: nomProjet })}>',
      'type="button"',
      "aria-expanded={deplie}",
      "aria-controls={id}",
      "aria-busy={dossier.chargement}",
      'aria-current={props.cheminOuvert === chemin ? "page" : undefined}',
      "href={adresseFichiers({ projet, chemin })}",
      "<bdi>{entree.nomVisible}</bdi>",
      "phraseMasques(dossier.masques)",
      "TEXTES.partout.tronqueListe",
      "TEXTES.partout.dossierVide",
      "TEXTES.partout.travailVide",
      "TEXTES.avance.pourquoi",
    ]) {
      assert.ok(arbre.includes(extrait), `ArbreFichiers : ${extrait}`);
    }
    // Lien, nom ambigu, élément spécial : <span> non interactif avec un mot d'état (Simple et Avancé).
    assert.match(arbre, /<span className="fichiers-ligne fichiers-special">/);
    for (const mot of ["lien", "douteux", "autre"]) assert.match(arbre, new RegExp(`mots\\.${mot}`), mot);
    assert.match(arbre, /const mots = advanced \? TEXTES\.avance : TEXTES\.simple;/);
  });

  it("vue d'un fichier : un seul nœud de texte, gouttière aria-hidden, titre focalisable, fil d'Ariane, retour à la ligne", () => {
    const vue = sansCommentaires(lire("pages/fichiers/VueFichier.tsx"));
    assert.match(
      vue,
      /<pre className="fichiers-texte" tabIndex=\{0\} aria-label=\{remplirAccorde\(TEXTES\.partout\.contenuDeUn, TEXTES\.partout\.contenuDe, \{ nom, n: reponse\.lignes \}\)\}>\{texte\}<\/pre>/,
    );
    assert.match(vue, /<pre className="fichiers-gouttiere" aria-hidden="true">\s*\{numeros\}\s*<\/pre>/);
    assert.match(vue, /\{retourALaLigne \? null : \(\s*<pre className="fichiers-gouttiere"/, "gouttière masquée avec le retour à la ligne");
    assert.match(vue, /<h2 className="fichiers-titre" tabIndex=\{-1\} ref=\{titre\}>\s*<bdi>\{nom\}<\/bdi>/);
    assert.match(vue, /<nav className="fichiers-fil" aria-label=\{TEXTES\.partout\.filAriane\}>\s*<ol>/);
    assert.match(vue, /<span aria-current="location">/);
    assert.match(vue, /aria-pressed=\{retourALaLigne\}/);
    assert.match(vue, /useState\(!advanced\)/, "retour à la ligne actif par défaut en mode Simple");
    assert.match(vue, /emplacementSurLePoste\(props\.hostDir, projet, segments\)/);
    assert.match(vue, /\{emplacement !== null \? \(/, "emplacement masqué si le dossier du poste est inconnu");
    assert.match(vue, /navigator\.clipboard/);
    // Bandeaux : fichier long en tête ET en fin ; passages masqués dès secretsMasques ; ancien format.
    assert.equal([...vue.matchAll(/reponse\.tronque \?/g)].length, 2);
    assert.match(vue, /reponse\.secretsMasques \? <Bandeau icone="lock">\{TEXTES\.partout\.secretsMasques\}<\/Bandeau>/);
    assert.match(vue, /reponse\.encodage === "windows-1252"/);
    // Détails en mode Avancé seulement ; phrase « lien » propre à chaque mode.
    assert.match(vue, /\{advanced \? \(\s*<p className="fichiers-note">\s*\{remplir\(TEXTES\.avance\.details,/);
    assert.match(vue, /advanced \? TEXTES\.avance\.lienMessage : TEXTES\.simple\.lienMessage/);
    // Focus au titre seulement sur demande.
    assert.match(vue, /if \(props\.focus <= 0\) return;\s*titre\.current\?\.focus\(\);/);
  });

  it("page : région nommée par son <h1>, recherche sans envoi à chaque frappe, focus rendu au lien d'origine", () => {
    const page = sansCommentaires(lire("pages/fichiers/FichiersPage.tsx"));
    assert.match(page, /<section className=\{`page fichiers-page[^`]*`\} aria-labelledby=\{titreId\}>/);
    assert.match(page, /<h1 id=\{titreId\}>\{TEXTES\.partout\.titre\}<\/h1>/);
    assert.match(page, /<option value="">\{TEXTES\.partout\.racine\}<\/option>/);
    assert.match(page, /goTo\(adresseFichiers\(\{ projet: nouveau \}\)\)/, "sélecteur : adresse de l'onglet, jamais le projet du chat");
    assert.match(page, /lireAdresse\(query\)/);
    assert.match(page, /\{adresse === null \? \(/);
    assert.match(page, /TEXTES\.partout\.invalide/);
    assert.match(page, /useState\(advanced\)/, "case des fichiers cachés : cochée en Avancé, décochée en Simple");
    assert.match(page, /origine\.current\?\.isConnected \? origine\.current :/);
    const recherche = sansCommentaires(lire("pages/fichiers/RecentsRecherche.tsx"));
    assert.match(recherche, /<form role="search"/);
    assert.match(recherche, /onSubmit=\{envoyer\}/);
    assert.match(recherche, /onChange=\{\(evenement\) => setSaisie\(evenement\.target\.value\)\}/);
    assert.doesNotMatch(recherche, /onChange=\{[^}]*onChercher/, "jamais une recherche à chaque frappe");
    assert.match(recherche, /maxLength=\{NAV_BORNES\.RECHERCHE_MAX_CARACTERES\}/);
    assert.match(recherche, /const RECENTS_D_ABORD = 10;/);
    assert.match(recherche, /NAV_BORNES\.RECENTS_MAX/);
  });

  it("fichiers.css : forced-colors complet, 400 px, ni animation ni transition", () => {
    const css = lire("pages/fichiers/fichiers.css");
    const code = css.replace(/\/\*[\s\S]*?\*\//g, "");
    assert.match(code, /@media \(forced-colors: active\)/);
    const contraste = code.slice(code.indexOf("@media (forced-colors: active)"));
    for (const mot of ["CanvasText", "Highlight", "HighlightText", "outline: 2px solid", "currentColor"]) assert.ok(contraste.includes(mot), mot);
    assert.match(code, /@media \(max-width: 720px\)/);
    assert.doesNotMatch(css, /animation|transition|@keyframes/i);
  });
});

describe("fichiers partagés balisés", () => {
  it("App.tsx : entrée « Fichiers » juste après « Chat », sans advancedOnly ; import et branche balisés", () => {
    const app = lire("app/App.tsx");
    const tableau = /const NAV: [^=]*= \[([\s\S]*?)\n\];/.exec(app)?.[1] ?? "";
    const lignes = tableau.split("\n").filter((ligne) => ligne.includes("id:"));
    const ids = lignes.map((ligne) => /id: "([^"]+)"/.exec(ligne)?.[1]);
    assert.equal(ids.indexOf("fichiers"), ids.indexOf("chat") + 1, ids.join(", "));
    const entreeFichiers = lignes.find((ligne) => ligne.includes('id: "fichiers"')) ?? "";
    assert.equal(entreeFichiers.trim(), '{ id: "fichiers", label: TEXTES_FICHIERS.partout.rail, icon: "folder" }, // nav');
    assert.doesNotMatch(entreeFichiers, /advancedOnly/);
    assert.equal(TEXTES.partout.rail, "Fichiers");
    const imports = section(app, `// <${NAV}import>`, `// </${NAV}import>`);
    assert.ok(imports);
    assert.match(imports.texte, /import \{ TEXTES as TEXTES_FICHIERS \} from "\.\.\/\.\.\/server\/shared\/fichiers-texts\.ts";/);
    assert.match(imports.texte, /import \{ FichiersPage \} from "\.\.\/pages\/fichiers\/FichiersPage\.tsx";/);
    const branche = section(app, `/* <${NAV}section> */`, `/* </${NAV}section> */`);
    assert.ok(branche);
    assert.match(branche.texte, /^ section === "fichiers" \? \(\s*<FichiersPage \/>\s*\) : $/);
    assert.equal([...app.matchAll(/FichiersPage/g)].length, 3, "import, branche : aucune autre ligne");
  });

  it("ToolCard.tsx : lien « Ouvrir dans Fichiers » par adresseDepuisOutil, hors de tout bouton, icône aria-hidden", () => {
    const carte = lire("pages/chat/ToolCard.tsx");
    const calcul = section(carte, `// <${NAV}ouvrir>`, `// </${NAV}ouvrir>`);
    assert.ok(calcul);
    assert.match(
      calcul.texte,
      /const ouvrirDansFichiers = adresseDepuisOutil\(\{ outil: part\.tool, statut: state\.status, fichier: str\(input\.filePath\) \|\| str\(input\.path\), racine: root \}\);/,
    );
    const lien = section(carte, `{/* <${NAV}ouvrir> */}`, `{/* </${NAV}ouvrir> */}`);
    assert.ok(lien);
    assert.match(lien.texte, /\{ouvrirDansFichiers !== null \? \(\s*<a className="tool-open-files small" href=\{ouvrirDansFichiers\}>/);
    assert.match(lien.texte, /<Icon name="folder" size=\{14\} \/>/, "icône sans titre : aria-hidden");
    assert.match(lien.texte, /\{TEXTES_FICHIERS\.partout\.ouvrirDansFichiers\}/);
    assert.doesNotMatch(lien.texte, /<button/);
    assert.equal(dansUnBouton(carte, lien.debut), false, "jamais un lien dans un bouton");
    assert.ok(lien.debut > carte.indexOf("</button>"), "après le bouton tool-head");
    // Seul href de la carte : l'adresse de l'onglet.
    assert.deepEqual([...sansCommentaires(carte).matchAll(/\bhref=\{([^}]*)\}/g)].map((m) => m[1]), ["ouvrirDansFichiers"]);
    const imports = section(carte, `// <${NAV}import>`, `// </${NAV}import>`);
    assert.ok(imports);
    assert.match(imports.texte, /import \{ adresseDepuisOutil \} from "\.\.\/\.\.\/\.\.\/server\/shared\/fichiers-regles\.ts";/);
  });

  it("web-animations.test.ts : périmètre pages/fichiers dans sa section", () => {
    const test = fs.readFileSync(path.join(import.meta.dirname, "web-animations.test.ts"), "utf8");
    const perimetre = section(test, `// <${NAV}perimetre>`, `// </${NAV}perimetre>`);
    assert.ok(perimetre);
    assert.match(perimetre.texte, /SCOPES\.push\("pages\/fichiers"\);/);
  });
});
