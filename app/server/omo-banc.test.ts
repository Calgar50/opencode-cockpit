// Banc hors ligne de la Salle OMO (plan d'exécution, fiche L21 ; spéc. §7.10 l.1215-1216, l.1223, l.1226, l.1228 ; U3 et
// décision n° 9 du 19/09 : préfixes des ressources Docker).
//
// Ce que ce test tient, et que le banc lui-même ne peut pas tenir tout seul : les GARDE-FOUS. Le banc tourne à la main, sur une
// machine avec Docker ; ce test-ci tourne partout, sans Docker, et vérifie que le banc REFUSERA de toucher autre chose que ses
// propres ressources, que ses fichiers ne citent aucun nom réservé, et que le mode « à blanc » ne lance rien.
//
// Chaque garde a son test : le retirer fait tomber ce fichier.
//
// Les modules du banc sont du JavaScript sans dépendance (`e2e/omo-banc/**`, P8) : ils sont importés tels quels, jamais copiés.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import type { ContexteDePorte } from "../../e2e/omo-banc/scenarios/git-protection.mjs";
import porteGit, { FEUILLES, NETTOYAGE_E1, PROJET_ECRIT, SONDE_E1, TEMOIN } from "../../e2e/omo-banc/scenarios/git-protection.mjs";
import { cheminDeFixture, typeDEvenement } from "../../e2e/omo-banc/scenarios/mesures.mjs";
import {
  BancRefus,
  ETIQUETTE_BANC,
  ID_BANC,
  nomDeProjet,
  PREFIXE_PROJET,
  PREFIXES_INTERDITS,
  prendreVerrou,
  PROJETS_INTERDITS,
  verifierProjet,
} from "../../e2e/omo-banc/lib/verrou.mjs";

const RACINE = path.join(import.meta.dirname, "..", "..");
const BANC = path.join(RACINE, "e2e", "omo-banc");

const lire = (relatif: string): string => fs.readFileSync(path.join(BANC, relatif), "utf8");

/** Fichiers du banc que L21 possède (hors `guard/`, `portes/`, `corpus/` et le faux fournisseur de L21a). */
function fichiersDuBanc(): string[] {
  const sortie: string[] = [];
  const parcourir = (dossier: string, relatif: string): void => {
    for (const entree of fs.readdirSync(dossier, { withFileTypes: true })) {
      const complet = path.join(dossier, entree.name);
      const chemin = relatif === "" ? entree.name : `${relatif}/${entree.name}`;
      if (entree.isDirectory()) {
        if (chemin === "guard" || chemin === "portes" || chemin === "corpus") continue;
        parcourir(complet, chemin);
      } else if (entree.isFile() && chemin !== "lib/faux-copilot.mjs") {
        sortie.push(chemin);
      }
    }
  };
  parcourir(BANC, "");
  return sortie.sort();
}

describe("L21, garde du nom de projet : le banc ne touche que ses propres ressources", () => {
  it("un projet qui ne commence pas par le préfixe du banc est refusé", () => {
    for (const nom of ["opencode-cockpit", "opencode-cockpit-e2e", "cockpit-e2e", "ocauto-1", "omo11-omo-banc-x", "it11-e2e", "eq11-e2e", "c511-e2e", "3d11-e2e", "gf0-e2e", "i211-e2e", "r105b", "", "sal11", "sal11-omo-banc"]) {
      assert.throws(() => verifierProjet(nom), BancRefus, `accepté à tort : ${nom}`);
    }
  });

  it("le préfixe du banc, lui, est accepté, et le nom rendu est en minuscules", () => {
    assert.equal(verifierProjet(`${PREFIXE_PROJET}l21`), `${PREFIXE_PROJET}l21`);
    assert.equal(verifierProjet(`${PREFIXE_PROJET.toUpperCase()}L21`), `${PREFIXE_PROJET}l21`);
  });

  it("la liste noire couvre la pile de l'utilisateur et les bancs des autres travaux", () => {
    for (const interdit of ["opencode-cockpit", "ocauto-", "cockpit-e2e", "omo11-", "it11-", "eq11-", "c511-", "3d11-", "gf0-"]) {
      assert.ok(PREFIXES_INTERDITS.includes(interdit), `préfixe réservé absent de la liste : ${interdit}`);
    }
    assert.ok(PROJETS_INTERDITS.includes("opencode-cockpit"));
  });

  it("un identifiant de banc hors forme est refusé avant tout nom de projet", () => {
    for (const id of ["", "../evasion", "A", "avec espace", "a".repeat(25), "-", "é"]) {
      assert.throws(() => nomDeProjet(id), BancRefus, `accepté à tort : ${JSON.stringify(id)}`);
    }
    assert.equal(nomDeProjet("l21"), `${PREFIXE_PROJET}l21`);
    assert.equal(ID_BANC.test("l21-2"), true);
  });

  it("aucun identifiant ne peut ramener le nom sur un projet interdit", () => {
    // Double garde : même si le préfixe était un jour changé pour un préfixe réservé, la liste noire l'arrêterait.
    for (const interdit of PREFIXES_INTERDITS) {
      assert.throws(() => verifierProjet(`${interdit}quelquechose`), BancRefus, interdit);
    }
  });
});

describe("L21, verrou : un seul banc à la fois", () => {
  it("le verrou est pris, puis rendu, et un second appel dans le même processus est refusé", () => {
    const chemin = path.join(os.tmpdir(), "sal11-omo-banc.lock");
    const dejaLa = fs.existsSync(chemin);
    if (dejaLa) return; // un banc tourne sur cette machine : ce test ne lui prend pas son verrou.
    const rendre = prendreVerrou(`${PREFIXE_PROJET}test`);
    try {
      assert.ok(fs.existsSync(chemin), "le fichier de verrou doit exister pendant le banc");
      assert.throws(() => prendreVerrou(`${PREFIXE_PROJET}test2`), BancRefus, "un second banc doit être refusé");
    } finally {
      rendre();
    }
    assert.equal(fs.existsSync(chemin), false, "le verrou doit être rendu");
    rendre(); // rendre deux fois n'est jamais une erreur
  });

  it("un verrou dont le processus est mort est repris", () => {
    const chemin = path.join(os.tmpdir(), "sal11-omo-banc.lock");
    if (fs.existsSync(chemin)) return;
    // PID impossible sur tout système : le verrou est celui d'un banc tué.
    fs.writeFileSync(chemin, JSON.stringify({ pid: 2 ** 30, projet: `${PREFIXE_PROJET}mort`, at: Date.now() }));
    const rendre = prendreVerrou(`${PREFIXE_PROJET}vivant`);
    rendre();
    assert.equal(fs.existsSync(chemin), false);
  });
});

describe("L21, préfixes et ports : rien du banc ne peut heurter la pile de l'utilisateur", () => {
  const compose = lire("banc.compose.yml");
  const lanceur = lire("run-banc.mjs");
  /** Le YAML sans ses commentaires : une garde ne se prouve pas sur une ligne de commentaire. */
  const composeUtile = compose
    .split("\n")
    .filter((l) => !/^\s*#/.test(l))
    .join("\n");
  /** Blocs de service : du nom jusqu'au service suivant ou à la fin de la section. */
  const blocs = (() => {
    const texte = composeUtile.slice(composeUtile.indexOf("services:"));
    const noms = [...texte.matchAll(/^ {2}([a-z][a-z0-9-]*):$/gm)];
    const sortie = new Map<string, string>();
    for (const [i, m] of noms.entries()) {
      const debut = m.index ?? 0;
      const fin = noms[i + 1]?.index ?? texte.length;
      sortie.set(m[1] ?? "", texte.slice(debut, fin));
    }
    return sortie;
  })();

  it("la surcharge du banc ne publie jamais le port du cockpit", () => {
    assert.doesNotMatch(composeUtile, /7777/, "le port 7777 est celui de l'utilisateur");
    const publications = [...composeUtile.matchAll(/ports:\s*\["([^"]+)"\]/g)].map((m) => m[1] ?? "");
    assert.ok(publications.length >= 2, `publications trouvées : ${publications.join(", ")}`);
    for (const publication of publications) {
      assert.match(publication, /^127\.0\.0\.1:/, `port publié hors de la boucle locale : ${publication}`);
      assert.match(publication, /^127\.0\.0\.1:\$\{BANC_[A-Z_]+\}:/, `port publié hors des variables du banc : ${publication}`);
    }
  });

  it("le lanceur n'emploie par défaut aucune image réservée", () => {
    const defauts = [...lanceur.matchAll(/values\[?"?image[a-z-]*"?\]? \?\? ([^;]+);/g)].map((m) => m[1] ?? "");
    assert.ok(defauts.length >= 2, `valeurs par défaut trouvées : ${defauts.join(" | ")}`);
    for (const defaut of defauts) {
      assert.ok(!/opencode-cockpit|ocauto-|cockpit-e2e/.test(defaut), `image réservée par défaut : ${defaut}`);
    }
    assert.match(lanceur, /sal11-omo\/opencode-omo:/, "l'image de la salle doit être une image de banc");
    assert.match(lanceur, /sal11-omo\/app:/, "l'image des pilotes doit être une image de banc");
    assert.ok(lanceur.includes("ETIQUETTE_BANC"), "l'étiquette du banc vient d'une constante partagée");
    assert.equal(ETIQUETTE_BANC, "sal11");
  });

  it("chaque service du banc porte le profil omo : aucun ne démarre sans lui (T-L16-g)", () => {
    const duBanc = [...blocs.keys()].filter((s) => s.startsWith("banc-"));
    assert.ok(duBanc.length >= 5, `services du banc : ${duBanc.join(", ")}`);
    for (const service of duBanc) {
      assert.match(blocs.get(service) ?? "", /profiles: \["omo"\]/, `service sans profil omo : ${service}`);
    }
    // Les services du produit ne sont que SURCHARGÉS : la surcharge ne leur ajoute ni image ni commande.
    for (const service of ["opencode-omo", "egress"]) {
      const bloc = blocs.get(service) ?? "";
      assert.ok(bloc !== "", `service du produit absent de la surcharge : ${service}`);
      assert.doesNotMatch(bloc, /^ {4}(image|command|entrypoint):/m, `la surcharge remplace le produit pour ${service}`);
    }
  });

  it("le nettoyage passe toujours par la garde du nom de projet", () => {
    const verrou = fs.readFileSync(path.join(BANC, "lib", "verrou.mjs"), "utf8");
    for (const fonction of ["nettoyerProjet", "restes"]) {
      const debut = verrou.indexOf(`export async function ${fonction}(`);
      assert.ok(debut > 0, `fonction absente : ${fonction}`);
      const corps = verrou.slice(debut, verrou.indexOf("\n}", debut));
      assert.match(corps, /verifierProjet\(projet\)/, `${fonction} doit revérifier le nom du projet avant d'agir`);
    }
  });

  it("MSYS_NO_PATHCONV est posé pour toute commande lancée par le banc", () => {
    const verrou = fs.readFileSync(path.join(BANC, "lib", "verrou.mjs"), "utf8");
    assert.match(verrou, /MSYS_NO_PATHCONV: "1"/, "sans elle, Git Bash réécrit les chemins du conteneur");
  });
});

describe("L21, aucune dépendance et aucun secret dans le banc (P8)", () => {
  const fichiers = fichiersDuBanc();

  it("les fichiers du banc n'importent que des modules node: et leurs voisins", () => {
    for (const relatif of fichiers.filter((f) => f.endsWith(".mjs"))) {
      const texte = lire(relatif);
      for (const imp of texte.matchAll(/^import [^\n]*?from "([^"]+)";$/gm)) {
        const cible = imp[1] ?? "";
        assert.ok(cible.startsWith("node:") || cible.startsWith("./") || cible.startsWith("../"), `dépendance interdite dans ${relatif} : ${cible}`);
      }
      assert.doesNotMatch(texte, /\brequire\("(?!node:)[a-z@]/, `require d'un paquet dans ${relatif}`);
    }
  });

  it("aucun mot de passe, aucun jeton en clair dans les fichiers du banc", () => {
    // Le mot de passe et le jeton de pilotage sont tirés au hasard à chaque exécution et n'existent que dans le fichier
    // d'environnement (0600), supprimé à la fin. Rien de tout cela n'a de valeur écrite dans le dépôt.
    for (const relatif of fichiers) {
      const texte = lire(relatif);
      assert.doesNotMatch(texte, /(gh[pousr]_|github_pat_)[A-Za-z0-9_]{16,}/, `jeton GitHub dans ${relatif}`);
      assert.doesNotMatch(texte, /-----BEGIN [A-Z ]*PRIVATE KEY-----/, `clé privée dans ${relatif}`);
      assert.doesNotMatch(texte, /\b(password|motdepasse|mot_de_passe)\s*[:=]\s*["'][^"'$]{6,}/i, `mot de passe en clair dans ${relatif}`);
    }
    // Le mot de passe est tiré, jamais affiché : le lanceur ne doit pas le donner au journal.
    const lanceur = lire("run-banc.mjs");
    assert.doesNotMatch(lanceur, /dire\([^)]*motDePasse/, "le mot de passe ne doit jamais traverser le journal");
    assert.match(lanceur, /randomBytes\(24\)/, "le mot de passe doit être tiré au hasard");
  });

  it("le certificat de banc est jetable et la vérification TLS n'est jamais coupée", () => {
    const certs = lire("lib/certs.mjs");
    assert.match(certs, /-days 2\b/, "un certificat de banc ne doit pas survivre au banc");
    assert.match(certs, /--network\s*",\s*"none/, "les certificats se fabriquent sans réseau");
    for (const relatif of fichiers) {
      const texte = lire(relatif);
      assert.doesNotMatch(texte, /NODE_TLS_REJECT_UNAUTHORIZED|rejectUnauthorized:\s*false|COCKPIT_TLS_INSECURE/, `vérification TLS coupée dans ${relatif}`);
    }
  });
});

describe("L21, mode « à blanc » : aucune commande Docker, tous les refus vérifiés", () => {
  it("le mode à blanc rend 0 et n'appelle jamais docker", { timeout: 60_000 }, async () => {
    const enfant = spawn(process.execPath, [path.join(BANC, "run-banc.mjs"), "--a-blanc"], {
      stdio: ["ignore", "pipe", "pipe"],
      // PATH vidé de tout : si le mode à blanc lançait docker, il ne le trouverait pas et le dirait.
      env: { ...process.env, PATH: path.dirname(process.execPath) },
    });
    let sortie = "";
    enfant.stdout.on("data", (b: Buffer) => {
      sortie += b;
    });
    enfant.stderr.on("data", (b: Buffer) => {
      sortie += b;
    });
    const [code] = (await once(enfant, "close")) as [number];
    assert.equal(code, 0, sortie.slice(-800));
    assert.match(sortie, /\[à blanc\] VERT/);
    assert.match(sortie, /8\/8 refus vérifiés/);
    assert.doesNotMatch(sortie, /ENOENT|spawn docker/, "le mode à blanc ne lance aucune commande");
  });
});

describe("L21 / L16c, porte « git » : ce que le dossier de travail en lecture seule protège vraiment", () => {
  // Train de V3 de la 2 ter (L21b anticipé pour cette porte) : la porte mesure désormais la topologie E1 de L16c — racine en
  // lecture seule, écriture par exception — par les huit familles de l'essai E1, puis vérifie côté POSTE. Le double ci-dessous
  // joue la salle sur un arbre jetable : la sonde « écrit » ce qu'une salle réelle écrirait, le nettoyage le retire.
  const PROJETS = ["projet-ouvert", "projet-temoin"];
  const EROFS_PARTOUT = {
    "racine du dossier de travail": "EROFS",
    "fichier neuf a la racine du projet": "EROFS",
    "dossier neuf a la racine du projet": "EROFS",
    "fichier existant de .git ouvert en ecriture": "EROFS",
    "entree ouverte sous un parent aliase (PROJET-OUVERT/src)": "EROFS",
    "entree ouverte sous son nom aliase (projet-ouvert/SRC)": "EROFS",
    "fichier ouvert sous un parent aliase (PROJET-OUVERT/notes.txt)": "EROFS",
    "remontee .. vers .git/hooks": "EROFS",
    "remontee .. vers la racine du projet": "EROFS",
    "remontee .. vers le dossier de travail": "EROFS",
    "remontee .. vers le .git d'un parent aliase": "EROFS",
  };
  const EXDEV_PARTOUT = {
    ".git/config vers une entree ouverte": "EXDEV",
    ".git/HEAD vers une entree ouverte": "EXDEV",
    "entre deux entrees ouvertes (src vers docs)": "EXDEV",
    "fichier ouvert vers une entree ouverte (notes.txt vers src)": "EXDEV",
  };
  const ferme = { existe: "dossier", inscriptible: false, ecriture: "EROFS", crochet: "EROFS" };
  type Surcharge = Record<string, Record<string, unknown>>;
  const aliasFermes = (surcharge: Surcharge = {}) =>
    Object.fromEntries(PROJETS.map((p) => [p, { ".git": { ...ferme }, ".GIT": { ...ferme }, "GIT~1": { ...ferme }, ".gIt": { existe: "ENOENT" }, ...(surcharge[p] ?? {}) }]));
  const parentsFermes = (surcharge: Surcharge = {}) =>
    Object.fromEntries(PROJETS.map((p) => [p, { [`${p.toUpperCase()}/.git`]: { ...ferme }, "PROJET~1/.git": { ...ferme }, ...(surcharge[p] ?? {}) }]));
  const montagesE1 = () => [
    { point: "/workspace", ro: true },
    ...PROJETS.flatMap((p) => ["LISEZMOI.md", "docs", "notes.txt", "src"].map((nom) => ({ point: `/workspace/${p}/${nom}`, ro: false }))),
  ];

  /** Arbre jetable du « poste » : deux projets tels que run-banc.mjs les prépare, dépôts compris. */
  function arbre(t: { after: (f: () => void) => void }): string {
    const ws = fs.mkdtempSync(path.join(os.tmpdir(), "banc-porte-git-"));
    t.after(() => fs.rmSync(ws, { recursive: true, force: true }));
    for (const p of PROJETS) {
      for (const d of [".git/hooks", "src", "docs"]) fs.mkdirSync(path.join(ws, p, ...d.split("/")), { recursive: true });
      fs.writeFileSync(path.join(ws, p, ".git", "config"), "[core]\n");
      fs.writeFileSync(path.join(ws, p, ".git", "HEAD"), "ref: refs/heads/main\n");
      fs.writeFileSync(path.join(ws, p, "LISEZMOI.md"), `Projet ${p}.\n`);
      fs.writeFileSync(path.join(ws, p, "notes.txt"), "notes\n");
      fs.writeFileSync(path.join(ws, p, "src", "app.js"), "export {};\n");
      fs.writeFileSync(path.join(ws, p, "docs", "guide.md"), "guide\n");
    }
    return ws;
  }

  interface Simulation {
    vue?: Record<string, unknown>;
    /** La sonde écrit-elle vraiment sur le « poste » ? (faux : écritures légitimes perdues) */
    persiste?: boolean;
    /** Écriture parasite laissée par la « salle » là où elle devait être refusée (chemin relatif au dossier de travail). */
    fuite?: string;
    etat?: Record<string, unknown>;
    amorce?: unknown;
  }

  function contexte(ws: string | null, sim: Simulation): ContexteDePorte & { ecrits: Map<string, string>; appels: string[] } {
    const ecrits = new Map<string, string>();
    const appels: string[] = [];
    const vue = sim.vue ?? {
      montages: montagesE1(),
      alias: aliasFermes(),
      parents: parentsFermes(),
      legitimes: { fichierNeuf: "acceptee", dossierProfond: "acceptee", fichierEnPlace: "acceptee" },
      refus: EROFS_PARTOUT,
      liensDurs: EXDEV_PARTOUT,
      liensSymboliques: { cree: "acceptee", ecritureAtravers: "EROFS" },
    };
    return {
      ecrits,
      appels,
      chemins: ws === null ? undefined : { ws },
      exec: (_service: string, argv: string[]) => {
        const src = ws === null ? "" : path.join(ws, PROJET_ECRIT, "src");
        if (argv[2] === SONDE_E1) {
          appels.push("sonde");
          if (ws !== null && sim.persiste !== false) {
            fs.writeFileSync(path.join(src, `${TEMOIN}legitime.txt`), `banc ${argv[3]}\n`);
            fs.mkdirSync(path.join(src, `${TEMOIN}sous`, "dossier"), { recursive: true });
            fs.writeFileSync(path.join(src, `${TEMOIN}sous`, "dossier", "profond.txt"), `profond ${argv[3]}\n`);
            fs.appendFileSync(path.join(ws, PROJET_ECRIT, "LISEZMOI.md"), `temoin en place ${argv[3]}\n`);
          }
          if (ws !== null && sim.fuite) fs.writeFileSync(path.join(ws, ...sim.fuite.split("/")), "x");
          return Promise.resolve({ code: 0, sortie: JSON.stringify(vue) });
        }
        if (argv[2] === NETTOYAGE_E1) {
          appels.push("nettoyage");
          if (ws !== null) {
            fs.rmSync(path.join(src, `${TEMOIN}legitime.txt`), { force: true });
            fs.rmSync(path.join(src, `${TEMOIN}sous`), { recursive: true, force: true });
            if (argv[3]) fs.writeFileSync(path.join(ws, PROJET_ECRIT, "LISEZMOI.md"), Buffer.from(argv[3], "base64"));
          }
          return Promise.resolve({ code: 0, sortie: JSON.stringify({ lien: "ok", fichier: "ok", dossier: "ok", enPlace: "ok" }) });
        }
        appels.push(`inconnu:${argv.slice(0, 2).join(" ")}`);
        return Promise.resolve({ code: 1, sortie: "" });
      },
      etat: () =>
        Promise.resolve(
          sim.etat ?? {
            phase: "opencode-lance",
            workspaceGit: { nonProteges: [] },
            projets: PROJETS.map((chemin) => ({ chemin, gitLectureSeule: true })),
          },
        ),
      sortie: (nom: string) => (nom === "projets-amorce.json" ? JSON.stringify(sim.amorce ?? { gitProteges: 2 }) : null),
      ecrireSortie: (nom: string, texte: string) => {
        ecrits.set(nom, texte);
      },
    };
  }

  const rouges = (points: { nom: string; ok: boolean }[]) =>
    points
      .filter((p) => !p.ok)
      .map((p) => p.nom)
      .join(" | ");

  it("sans dépôt préparé, la porte est SANS OBJET et ne se dit surtout pas verte", async () => {
    const ctx = contexte(null, { amorce: { amorce: true, projets: ["projet-ouvert"], gitProteges: 0 } });
    const resultat = await porteGit.executer(ctx);
    assert.equal(typeof resultat.sansObjet, "string");
    assert.equal(resultat.points, undefined, "une porte sans objet ne rend aucun constat");
    assert.deepEqual(ctx.appels, [], "rien n'est sondé quand il n'y a rien à protéger");
  });

  it("topologie E1 réellement tenue : la porte est entièrement verte, et le banc repart propre à l'octet", async (t) => {
    const ws = arbre(t);
    const avant = fs.readFileSync(path.join(ws, PROJET_ECRIT, "LISEZMOI.md"));
    const ctx = contexte(ws, {});
    const resultat = await porteGit.executer(ctx);
    const points = resultat.points ?? [];
    assert.ok(points.length >= 15, `${points.length} constats`);
    assert.equal(rouges(points), "", "tout doit être vert");
    assert.deepEqual(ctx.appels, ["sonde", "nettoyage"]);
    assert.ok(fs.readFileSync(path.join(ws, PROJET_ECRIT, "LISEZMOI.md")).equals(avant), "fichier écrit en place rétabli");
    assert.deepEqual(fs.readdirSync(path.join(ws, PROJET_ECRIT, "src")), ["app.js"], "écritures légitimes retirées");
    // Le verdict qui compte : sans doute, la salle DÉMARRE avec des dépôts (c'était impossible avant L16c sur Windows).
    assert.equal(points.find((p) => p.nom.includes("la salle démarre"))?.ok, true);
  });

  it("un alias de casse inscriptible (vecteur de la FEUILLE) est un constat ROUGE, alias et crochet nommés", async (t) => {
    const alias = aliasFermes({ "projet-ouvert": { ".GIT": { existe: "dossier", inscriptible: true, ecriture: "acceptee", crochet: "acceptee" } } });
    const vue = { montages: montagesE1(), alias, parents: parentsFermes(), legitimes: {}, refus: EROFS_PARTOUT, liensDurs: EXDEV_PARTOUT, liensSymboliques: { ecritureAtravers: "EROFS" } };
    const ctx = contexte(arbre(t), { vue, etat: { phase: "attente", workspaceGit: { nonProteges: ["projet-ouvert/.git"] }, projets: [] } });
    const resultat = await porteGit.executer(ctx);
    const points = resultat.points ?? [];
    const feuille = points.find((p) => p.nom.includes("alias de casse"));
    assert.equal(feuille?.ok, false, "un alias inscriptible doit faire tomber la porte");
    assert.match(feuille?.detail ?? "", /projet-ouvert\/\.GIT/);
    assert.equal(points.find((p) => p.nom.includes("crochet git"))?.ok, false, "un crochet posable doit faire tomber la porte");
    // Le chemin exact, lui, est bien protégé : la porte ne doit pas confondre les deux.
    assert.equal(points.find((p) => p.nom.includes("chemin exact"))?.ok, true);
    assert.deepEqual(resultat.mesures?.gitAliasOuverts, ["projet-ouvert/.GIT"]);
    // Fermé en cas de doute : le superviseur qui ferme la salle reste, lui, un constat VERT.
    assert.equal(points.find((p) => p.nom.includes("ferme la salle"))?.ok, true, "fermé en cas de doute : c'est le comportement attendu");
    assert.equal(points.find((p) => p.nom.includes("même doute"))?.ok, true);
  });

  it("un alias du dossier PARENT inscriptible (essai 1 bis) est un constat ROUGE, même quand la feuille est fermée", async (t) => {
    const parents = parentsFermes({ "projet-ouvert": { "PROJET-OUVERT/.git": { existe: "dossier", inscriptible: true, ecriture: "acceptee", crochet: "acceptee" } } });
    const vue = { montages: montagesE1(), alias: aliasFermes(), parents, legitimes: {}, refus: EROFS_PARTOUT, liensDurs: EXDEV_PARTOUT, liensSymboliques: { ecritureAtravers: "EROFS" } };
    const resultat = await porteGit.executer(contexte(arbre(t), { vue }));
    const points = resultat.points ?? [];
    const parent = points.find((p) => p.nom.includes("dossier PARENT"));
    assert.equal(parent?.ok, false);
    assert.match(parent?.detail ?? "", /PROJET-OUVERT\/\.git/);
    assert.equal(points.find((p) => p.nom.includes("alias de casse"))?.ok, true, "la feuille, elle, est fermée");
    // La salle a démarré alors qu'un alias écrit : le superviseur n'a pas vu le doute, c'est rouge.
    assert.equal(points.find((p) => p.nom.includes("même doute"))?.ok, false);
    // Un vecteur jamais exercé (aucun alias de parent n'existe) ne se dit pas vert.
    const sansParent = { ...vue, parents: {} };
    const muet = ((await porteGit.executer(contexte(arbre(t), { vue: sansParent }))).points ?? []).find((p) => p.nom.includes("dossier PARENT"));
    assert.equal(muet?.ok, false, "un vecteur non exercé n'est pas une preuve");
  });

  it("racine sans l'option ro, montage en écriture en trop, remontée `..` acceptée, lien dur accepté : chacun est ROUGE", async (t) => {
    const base = { alias: aliasFermes(), parents: parentsFermes(), legitimes: {}, liensSymboliques: { ecritureAtravers: "EROFS" } };
    const cas: [string, Record<string, unknown>, string][] = [
      ["racine", { ...base, montages: [{ point: "/workspace", ro: false }, ...montagesE1().slice(1)], refus: EROFS_PARTOUT, liensDurs: EXDEV_PARTOUT }, "LECTURE SEULE"],
      ["en trop", { ...base, montages: [...montagesE1(), { point: "/workspace/projet-ouvert/.git", ro: false }], refus: EROFS_PARTOUT, liensDurs: EXDEV_PARTOUT }, "premier niveau"],
      ["remontée", { ...base, montages: montagesE1(), refus: { ...EROFS_PARTOUT, "remontee .. vers .git/hooks": "acceptee" }, liensDurs: EXDEV_PARTOUT }, "refus francs"],
      ["autre refus", { ...base, montages: montagesE1(), refus: { ...EROFS_PARTOUT, "remontee .. vers la racine du projet": "EACCES" }, liensDurs: EXDEV_PARTOUT }, "refus francs"],
      ["lien dur", { ...base, montages: montagesE1(), refus: EROFS_PARTOUT, liensDurs: { ...EXDEV_PARTOUT, ".git/config vers une entree ouverte": "acceptee" } }, "EXDEV"],
      ["lien dur EPERM", { ...base, montages: montagesE1(), refus: EROFS_PARTOUT, liensDurs: { ...EXDEV_PARTOUT, ".git/HEAD vers une entree ouverte": "EPERM" } }, "EXDEV"],
      ["lien symbolique", { ...base, montages: montagesE1(), refus: EROFS_PARTOUT, liensDurs: EXDEV_PARTOUT, liensSymboliques: { cree: "acceptee", ecritureAtravers: "acceptee" } }, "lien symbolique"],
    ];
    for (const [nom, vue, point] of cas) {
      const points = (await porteGit.executer(contexte(arbre(t), { vue }))).points ?? [];
      assert.equal(points.find((p) => p.nom.includes(point))?.ok, false, `${nom} : le constat « ${point} » doit tomber`);
    }
  });

  it("côté POSTE : écriture légitime perdue, témoin arrivé dans un dépôt, dossier .omo créé — chacun est ROUGE", async (t) => {
    const perdue = (await porteGit.executer(contexte(arbre(t), { persiste: false }))).points ?? [];
    assert.equal(perdue.find((p) => p.nom.includes("LÉGITIME"))?.ok, false, "une écriture que le poste n'a pas reçue n'est pas une preuve");

    const fuite = (await porteGit.executer(contexte(arbre(t), { fuite: `projet-ouvert/.git/hooks/${TEMOIN}pre-commit` }))).points ?? [];
    assert.equal(fuite.find((p) => p.nom.includes("aucun témoin"))?.ok, false);
    assert.equal(fuite.find((p) => p.nom.includes("dépôts intacts"))?.ok, false, "un fichier de plus dans .git change ses empreintes");

    const wsOmo = arbre(t);
    const ctx = contexte(wsOmo, {});
    fs.mkdirSync(path.join(wsOmo, "projet-temoin", ".omo"));
    const omo = (await porteGit.executer(ctx)).points ?? [];
    assert.equal(omo.find((p) => p.nom.includes(".omo"))?.ok, false, "A16 point 2 : aucun .omo dans les projets");
  });

  it("la sonde couvre les casses ET le nom court 8.3 de la feuille, le parent, et n'écrit que sous /workspace", () => {
    const scenario = fs.readFileSync(path.join(BANC, "scenarios", "git-protection.mjs"), "utf8");
    for (const alias of [".git", ".GIT", ".Git", "GIT~1"]) {
      assert.ok(scenario.includes(`"${alias}"`), `alias absent de la sonde : ${alias}`);
      assert.ok(FEUILLES.includes(alias), `alias absent des feuilles : ${alias}`);
    }
    // Parent : casses et nom court du dossier du projet, puis .git et ses alias sous chacun.
    assert.match(SONDE_E1, /projet\.toUpperCase\(\)/);
    assert.match(SONDE_E1, /court \+ "~1"/);
    assert.match(SONDE_E1, /out\.parents\[projet\]\[v \+ "\/" \+ nom\] = sonder\("\/workspace\/" \+ v/);
    // Rien d'autre que les dépôts jetables du banc n'est touché : garde dans la sonde, et aucune écriture directe ailleurs.
    assert.match(SONDE_E1, /const DANS = \(chemin\) => chemin\.startsWith\("\/workspace\/"\);/);
    assert.match(SONDE_E1, /if \(!DANS\(chemin\)\) return "refuse-hors-workspace";/);
    assert.doesNotMatch(SONDE_E1, /writeFileSync\("(?!\/workspace)/, "la sonde n'écrit nulle part ailleurs");
    // Primitives du superviseur, jamais `test -w` (busybox ment sur un montage en lecture seule).
    assert.match(SONDE_E1, /fs\.accessSync\(chemin, fs\.constants\.W_OK\)/);
    assert.doesNotMatch(SONDE_E1, /test -w/);
  });
});

describe("L21, banc dégradé : un banc qui n'a pas tout mesuré ne peut pas passer pour complet", () => {
  const lanceur = lire("run-banc.mjs");

  it("« sans objet » sort du décompte des portes, au lieu de le verdir", () => {
    assert.match(lanceur, /const jugees = bilan\.portes\.filter\(\(p\) => !p\.sansObjet\)/, "le décompte doit écarter les portes sans objet");
    assert.match(lanceur, /bilan\.vert = jugees\.length > 0 && jugees\.every\(\(p\) => p\.ok\)/, "le verdict ne porte que sur les portes jugées");
    assert.doesNotMatch(lanceur, /bilan\.vert = bilan\.portes\.every/, "une porte sans objet ne doit jamais compter comme verte");
  });

  it("le mode dégradé s'annonce à chaque exécution", () => {
    assert.match(lanceur, /sans-git/, "l'option doit exister");
    assert.match(lanceur, /banc dégradé/, "le banc doit dire qu'il est dégradé");
    assert.match(lanceur, /avecGit: !values\["sans-git"\]/, "l'option doit commander la préparation des projets");
    // Le défaut reste le cas réel : des dépôts git, comme sur le poste de l'utilisateur.
    assert.match(lanceur, /avecGit = true/, "sans l'option, le banc prépare de vrais dépôts");
  });

  it("la porte « git » est dans la liste des scénarios du banc", () => {
    assert.match(lanceur, /import git from "\.\/scenarios\/git-protection\.mjs";/);
    assert.match(lanceur, /const SCENARIOS = \[git,/, "la protection des dépôts se mesure avant que la salle n'ouvre quoi que ce soit");
  });

  it("M23 ne rend pas de verdict quand aucun dépôt n'a été préparé", () => {
    const mesures = fs.readFileSync(path.join(BANC, "scenarios", "mesures.mjs"), "utf8");
    assert.match(mesures, /ctx\.sansGit/, "la mesure doit savoir que le banc est dégradé");
    assert.match(mesures, /non mesurable/, "une mesure impossible se dit, elle ne se déduit pas");
  });
});

describe("L21, type d'un événement du flux : l'enveloppe ne doit pas faire compter zéro", () => {
  // R16 (détection 4 de L23c) et M20 comptent des types d'événements. Le flux d'opencode les enveloppe dans `payload`, et
  // une lecture naïve de `evt.type` rend `undefined` : la mesure dirait « aucun `session.updated` » sur un flux qui en porte.
  it("les trois enveloppes du flux rendent le même type", () => {
    assert.equal(typeDEvenement({ payload: { type: "session.updated", properties: {} } }), "session.updated");
    assert.equal(typeDEvenement({ directory: "/workspace/p", project: "global", payload: { type: "message.updated" } }), "message.updated");
    assert.equal(typeDEvenement({ type: "server.connected" }), "server.connected");
    assert.equal(typeDEvenement({ event: { payload: { type: "session.idle" } } }), "session.idle");
  });

  it("une enveloppe sans type rend null, jamais une chaîne fabriquée", () => {
    for (const sans of [null, undefined, {}, { payload: {} }, { payload: { type: 12 } }, "session.updated"]) {
      assert.equal(typeDEvenement(sans), null, JSON.stringify(sans));
    }
  });

  it("les mesures qui comptent des types passent toutes par cette lecture", () => {
    const mesures = fs.readFileSync(path.join(BANC, "scenarios", "mesures.mjs"), "utf8");
    // La lecture naïve d'un événement de capture (`e.evt?.type`) ne doit plus exister ; la chaîne de secours de la lecture
    // commune, elle, est justement ce qui rattrape les enveloppes, et reste dans sa fonction.
    assert.doesNotMatch(mesures, /e\.evt\?\.type/, "plus aucune lecture naïve de l'enveloppe");
    assert.ok(mesures.split("typeDEvenement(").length - 1 >= 4, "la lecture commune sert partout où un type est compté");
  });
});

describe("L21, captures du scénario « mes » : un banc ne salit jamais la copie de travail", () => {
  // Constat BAS de la revue d'itération 2 bis : `mesures.mjs` réécrivait à chaque exécution trois fixtures SUIVIES PAR GIT
  // (omo-banc-m20/m21/r16.jsonl, ≈ 260 lignes changées : identifiants de session et horodatages neufs), sans rien en dire. Un
  // banc lancé depuis un worktree laissait donc du bruit prêt à partir dans un commit d'intégration.
  const SORTIE_DU_BANC = path.join(os.tmpdir(), "sal11-sortie-du-banc");
  const contexte = (ecrireFixtures?: boolean) => ({ racine: RACINE, chemins: { sortie: SORTIE_DU_BANC }, ...(ecrireFixtures === undefined ? {} : { ecrireFixtures }) });
  const FIXTURES = ["omo-banc-m20.jsonl", "omo-banc-m21.jsonl", "omo-banc-r16.jsonl"] as const;
  const dansLeDepot = (nom: string) => path.join(RACINE, "app", "server", "test-support", "fixtures", nom);

  it("par défaut : les captures vont dans la sortie du banc, et AUCUNE fixture du dépôt n'est visée", () => {
    for (const nom of FIXTURES) {
      const cible = cheminDeFixture(contexte(), nom);
      assert.equal(cible.dansLeDepot, false, nom);
      assert.equal(cible.chemin, path.join(SORTIE_DU_BANC, nom), nom);
      assert.notEqual(path.resolve(cible.chemin), path.resolve(dansLeDepot(nom)), `${nom} ne doit pas viser la fixture du dépôt`);
      assert.ok(!path.resolve(cible.chemin).startsWith(path.resolve(RACINE)), `${nom} doit sortir du dépôt`);
    }
    // Et le défaut est bien le défaut : `ecrireFixtures` absent du contexte se comporte comme faux.
    assert.equal(cheminDeFixture(contexte(false), FIXTURES[0]).dansLeDepot, false);
  });

  it("avec --ecrire-fixtures, et seulement là : les fixtures du dépôt sont visées, à leur chemin exact", () => {
    for (const nom of FIXTURES) {
      const cible = cheminDeFixture(contexte(true), nom);
      assert.equal(cible.dansLeDepot, true, nom);
      assert.equal(path.resolve(cible.chemin), path.resolve(dansLeDepot(nom)), nom);
      assert.ok(fs.existsSync(cible.chemin), `${nom} : la fixture commitée doit exister, elle reste la référence`);
    }
  });

  it("l'option existe dans run-banc.mjs, elle est dite dans l'aide, et l'écriture est annoncée", () => {
    const banc = lire("run-banc.mjs");
    assert.match(banc, /"ecrire-fixtures": \{ type: "boolean" \}/, "option déclarée");
    assert.match(banc, /ecrireFixtures: Boolean\(values\["ecrire-fixtures"\]\)/, "option portée par le contexte");
    assert.match(banc, /--ecrire-fixtures/, "option dite dans --aide");
    const mesures = lire("scenarios/mesures.mjs");
    // Plus aucun chemin de fixture construit en dur ailleurs que dans cheminDeFixture.
    assert.equal(mesures.split("\"test-support\"").length - 1, 1, "un seul endroit connaît le chemin des fixtures du dépôt");
    assert.match(mesures, /ctx\.dire\(`  capture \$\{nom\} → /, "le banc dit où il a écrit");
    assert.match(lire("README.md"), /--ecrire-fixtures/, "le README du banc le dit aussi");
  });
});
