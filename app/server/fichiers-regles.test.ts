// Règles pures, types et textes de l'onglet « Fichiers » (1.1, NAV-1 ; fiche NAV §2.4 à §2.6, §2.9, §3, §8 ; décisions A19
// point 2, A21, A22, A29 D14 (b)). Chaque règle a au moins un cas qui échoue sans elle. Les caractères invisibles et de
// contrôle sont écrits par leur code (String.fromCharCode), jamais en clair dans ce fichier.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { parseRouteQuery } from "../web/lib/router.ts";
import { ProjectsService } from "./projects.ts";
import { wildcardMatch } from "./shared/assistant-rules.ts";
import { KEY_FILE_GLOBS } from "./shared/autonomy-edit-rules.ts";
import {
  adresseDepuisOutil,
  adresseFichiers,
  analyserChemin,
  correspondMotifCle,
  decoderTexte,
  emplacementSurLePoste,
  estBinaireParExtension,
  estGenere,
  estProtege,
  EXTENSIONS_BINAIRES,
  EXTENSIONS_CODE,
  extensionDe,
  FICHIERS_ROUTES,
  GENERES,
  lireAdresse,
  NAV_BORNES,
  NAV_PROTEGES,
  normaliserRecherche,
  preparerTexte,
  projetNavigable,
  rendreVisible,
  segmentSur,
  tailleLisible,
} from "./shared/fichiers-regles.ts";
import { phraseErreur, phraseInvisibles, phraseLignesCoupees, phraseMasques, remplir, TEXTES } from "./shared/fichiers-texts.ts";
import type { FichiersCode } from "./shared/fichiers-types.ts";
import { sensitivePath } from "./shared/shell-gate.ts";

const ch = (...codes: number[]): string => String.fromCharCode(...codes);
const octets = (texte: string): Uint8Array => new TextEncoder().encode(texte);
const hex = (texte: string): Uint8Array => Uint8Array.from(texte.match(/../g) ?? [], (paire) => Number.parseInt(paire, 16));
const PEM_DEBUT = "-----BEGIN " + "RSA PRIVATE KEY-----";
const PEM_FIN = "-----END " + "RSA PRIVATE KEY-----";

// --- Routes, bornes, listes ------------------------------------------------------------------------------------------------------

describe("fichiers : routes, bornes et listes fermées (§2.1, §2.4)", () => {
  it("quatre routes POST, écrites une seule fois dans le module", () => {
    assert.deepEqual(FICHIERS_ROUTES, {
      dossier: "/api/fichiers/dossier",
      contenu: "/api/fichiers/contenu",
      recents: "/api/fichiers/recents",
      recherche: "/api/fichiers/recherche",
    });
    assert.ok(Object.isFrozen(FICHIERS_ROUTES));
    const source = fs.readFileSync(path.join(import.meta.dirname, "shared", "fichiers-regles.ts"), "utf8");
    assert.equal(source.split("/api/fichiers/").length - 1, 4, "chaque adresse une seule fois");
  });

  it("NAV_BORNES : valeurs exactes du §2.4", () => {
    assert.deepEqual(NAV_BORNES, {
      CORPS_MAX_OCTETS: 8_192,
      CHEMIN_MAX_CARACTERES: 2_048,
      SEGMENT_MAX_CARACTERES: 255,
      SEGMENTS_MAX: 64,
      RECHERCHE_MAX_CARACTERES: 100,
      ENTREES_MAX: 1_000,
      NOM_EXACT_MAX: 20_000,
      LECTURE_MAX_OCTETS: 262_144,
      MORCEAU_OCTETS: 65_536,
      LIGNES_MAX: 10_000,
      LIGNE_MAX_CARACTERES: 2_000,
      DETECTION_OCTETS: 8_192,
      CONTROLE_PART_MAX: 0.01,
      PARCOURS_ENTREES_MAX: 5_000,
      PARCOURS_NIVEAUX_MAX: 12,
      PARCOURS_DUREE_MS: 2_000,
      RECENTS_MAX: 30,
      RESULTATS_MAX: 100,
      LECTURES_SIMULTANEES: 2,
      ATTENTE_PLACE_MS: 2_000,
      LOT_LSTAT: 16,
      JOURNAL_INTERVALLE_MS: 60_000,
    });
    assert.ok(Object.isFrozen(NAV_BORNES));
  });

  it("listes fermées exactes : GENERES, EXTENSIONS_BINAIRES, EXTENSIONS_CODE, NAV_PROTEGES", () => {
    assert.deepEqual(GENERES, ["node_modules", "__pycache__", ".venv", "venv", ".pytest_cache", ".mypy_cache", ".ruff_cache", ".tox", ".gradle", ".next", ".nuxt"]);
    const binaires =
      "zip 7z rar gz tgz bz2 xz zst tar iso img vhd vhdx exe dll msi sys so dylib bin class jar war pyc pyo whl db sqlite sqlite3 mdf ldf bak dmp pst ost " +
      "pdf doc docx xls xlsx xlsm ppt pptx odt ods odp png jpg jpeg gif bmp ico webp tif tiff psd mp3 wav flac ogg mp4 mkv avi mov webm woff woff2 ttf otf eot " +
      "parquet pkl npy npz h5 onnx pt";
    assert.deepEqual(EXTENSIONS_BINAIRES, binaires.split(" "));
    assert.equal(EXTENSIONS_BINAIRES.length, 77);
    const code = "ps1 psm1 psd1 py js mjs cjs ts tsx jsx sh bash zsh bat cmd vbs sql cs vb java kt go rs rb php pl r md rst html css scss";
    assert.deepEqual(EXTENSIONS_CODE, code.split(" "));
    assert.deepEqual(NAV_PROTEGES.extensions, ["ppk", "keytab", "rdp", "kdb"]);
    assert.deepEqual(NAV_PROTEGES.noms, [
      ".htpasswd",
      "_netrc",
      ".mcp.json",
      "opencode.json",
      "opencode.jsonc",
      ".bash_history",
      ".zsh_history",
      ".python_history",
      ".psql_history",
      ".mysql_history",
      ".node_repl_history",
      "consolehost_history.txt",
      "$recycle.bin",
      "system volume information",
    ]);
    assert.deepEqual(NAV_PROTEGES.suffixes, [".tfvars.json"]);
    assert.deepEqual(NAV_PROTEGES.morceaux, [".tfstate."]);
    for (const liste of [GENERES, EXTENSIONS_BINAIRES, EXTENSIONS_CODE, NAV_PROTEGES.extensions, NAV_PROTEGES.noms, NAV_PROTEGES.suffixes, NAV_PROTEGES.morceaux]) {
      assert.ok(Object.isFrozen(liste));
    }
  });

  it("extensionDe, estGenere, estBinaireParExtension : casse ignorée, point de tête ou de fin sans extension", () => {
    assert.deepEqual(["a.b.c", ".bashrc", "a.", "A.PS1", "sans", "archive.tar.gz"].map(extensionDe), ["c", "", "", "ps1", "", "gz"]);
    assert.equal(estGenere("Node_Modules"), true);
    assert.equal(estGenere(".VENV"), true);
    assert.equal(estGenere("mes_modules"), false);
    assert.equal(estBinaireParExtension("photo.PNG"), true);
    assert.equal(estBinaireParExtension("archive.tar.gz"), true);
    assert.equal(estBinaireParExtension("script.ps1"), false);
    assert.equal(estBinaireParExtension(".png"), false);
    assert.equal(estBinaireParExtension("png"), false);
  });
});

// --- Chemins ------------------------------------------------------------------------------------------------------------------

describe("fichiers : analyserChemin et segmentSur (§2.5, sans normalisation ni décodage)", () => {
  const long = (n: number) => "a".repeat(n);
  const segments64 = [...Array.from({ length: 63 }, () => "b".repeat(31)), "c".repeat(32)];
  const acceptes: Array<[string, string[]]> = [
    ["", []],
    ["a", ["a"]],
    ["a/b", ["a", "b"]],
    ["scripts/Get-Rapport.ps1", ["scripts", "Get-Rapport.ps1"]],
    [".env", [".env"]],
    [".git/config", [".git", "config"]],
    ["%2e%2e", ["%2e%2e"]],
    ["%2e%2e/%2E%2E/etc", ["%2e%2e", "%2E%2E", "etc"]],
    ["a%2F..%2F..%2Fsecret", ["a%2F..%2F..%2Fsecret"]],
    ["Remise 20%", ["Remise 20%"]],
    ["a..b", ["a..b"]],
    ["...a", ["...a"]],
    [" espace-en-tete", [" espace-en-tete"]],
    ["é/ñ/日本", ["é", "ñ", "日本"]],
    ["x~a.txt", ["x~a.txt"]],
    ["NOM-LONG~1.TXTX", ["NOM-LONG~1.TXTX"]],
    ["CONSOLE", ["CONSOLE"]],
    ["con1", ["con1"]],
    ["com10", ["com10"]],
    ["lpt", ["lpt"]],
    ["a&b=c#d+e", ["a&b=c#d+e"]],
    [`${ch(0xd83d, 0xde00)}.txt`, [`${ch(0xd83d, 0xde00)}.txt`]],
    [long(255), [long(255)]],
    [segments64.join("/"), segments64],
  ];
  const refuses: Array<[string, unknown]> = [
    ["absent", undefined],
    ["null", null],
    ["nombre", 42],
    ["tableau", ["a"]],
    ["objet", { chemin: "a" }],
    ["/etc/passwd", "/etc/passwd"],
    ["a/../b", "a/../b"],
    ["..", ".."],
    ["./a", "./a"],
    [".", "."],
    ["a//b", "a//b"],
    ["a/", "a/"],
    ["/", "/"],
    ["C: suivi d'une barre inverse", "C:\\"],
    ["a, barre inverse, b", "a\\b"],
    [".env:flux", ".env:flux"],
    [".env.", ".env."],
    [".env et espace finale", ".env "],
    ["...", "..."],
    ["espace seule", " "],
    ["GIT~1/config", "GIT~1/config"],
    ["AGENTS~1.MD", "AGENTS~1.MD"],
    ["CON", "CON"],
    ["nul.txt", "nul.txt"],
    ["com1.log", "com1.log"],
    ["LPT9", "LPT9"],
    ["lpt0.x", "lpt0.x"],
    ["conin$", "conin$"],
    ["CONOUT$.txt", "CONOUT$.txt"],
    ["aux .txt (espace avant le point)", "aux .txt"],
    ["COM¹ (chiffre en exposant)", "COM¹"],
    ["NUL", `a${ch(0)}b`],
    ["U+0007", `a${ch(7)}b`],
    ["U+001F", `a${ch(0x1f)}`],
    ["U+007F", `a${ch(0x7f)}`],
    ["U+009B", `a${ch(0x9b)}b`],
    ["U+FFFD", `a${ch(0xfffd)}b`],
    ["surrogat haut isolé", `a${ch(0xd800)}b`],
    ["surrogat bas isolé", `${ch(0xdc00)}a`],
    ["tabulation", `a${ch(9)}b`],
    ["<", "a<b"],
    [">", "a>b"],
    ['"', 'a"b'],
    ["|", "a|b"],
    ["?", "a?b"],
    ["*", "a*b"],
    ["256 caractères", long(256)],
    ["65 segments", Array.from({ length: 65 }, () => "a").join("/")],
    ["2 049 caractères", `${segments64.slice(0, 63).join("/")}/${"c".repeat(33)}`],
  ];

  it("au moins 40 cas : chemins acceptés, segments littéraux", () => {
    assert.ok(acceptes.length + refuses.length >= 40);
    assert.equal(segments64.join("/").length, 2_048);
    for (const [chemin, segments] of acceptes) assert.deepEqual(analyserChemin(chemin), { ok: true, segments }, JSON.stringify(chemin));
  });

  it("chemins refusés : type, bornes, séparateurs, « . » et « .. », NTFS, contrôle, noms courts et réservés", () => {
    assert.equal(`${segments64.slice(0, 63).join("/")}/${"c".repeat(33)}`.length, 2_049);
    for (const [nom, chemin] of refuses) assert.deepEqual(analyserChemin(chemin), { ok: false }, nom);
  });

  it("aucun décodage ni aucune normalisation : %XX et formes Unicode gardés tels quels", () => {
    const decompose = `cafe${ch(0x301)}`;
    const analyse = analyserChemin(`${decompose}/%2F`);
    assert.deepEqual(analyse, { ok: true, segments: [decompose, "%2F"] });
    assert.equal(decompose.length, 5, "la forme NFD n'est pas recomposée");
    // D14 (b) : un nom %XX reste un seul segment littéral, jamais « a/../../secret ».
    assert.deepEqual(analyserChemin("a%2F..%2F..%2Fsecret"), { ok: true, segments: ["a%2F..%2F..%2Fsecret"] });
  });

  it("segmentSur : même règle pour un seul nom, autre chose qu'une chaîne refusé", () => {
    for (const nom of ["a", "Get-Token.ps1", "%2e%2e", "a%2F..%2Fx"]) assert.equal(segmentSur(nom), true, nom);
    for (const nom of ["", ".", "..", "a/b", "a.", "a ", "X~1", "PRN.txt", 7, null]) assert.equal(segmentSur(nom), false, String(nom));
  });
});

describe("fichiers : projetNavigable et parité avec ProjectsService.list() (§2.5, D14 (b))", () => {
  it("règle de nom seulement : racine, dossiers cachés et écartés, espaces, séparateurs", () => {
    const cas: Array<[unknown, boolean]> = [
      ["", true],
      ["projet-a", true],
      ["Remise 20%", true],
      ["secrets", true],
      ["a%2F..%2Fx", true],
      [".cache", false],
      ["node_modules", false],
      ["Node_Modules", false],
      ["$RECYCLE.BIN", false],
      ["System Volume Information", false],
      ["__pycache__", false],
      ["Projet ", false],
      [" Projet", false],
      [`Projet${ch(0xa0)}`, false],
      ["a/b", false],
      ["a\\b", false],
      ["..", false],
      [".", false],
      ["GIT~1", false],
      ["CON", false],
      [null, false],
      [3, false],
    ];
    for (const [nom, attendu] of cas) assert.equal(projetNavigable(nom), attendu, JSON.stringify(nom));
    // « secrets » est navigable par le nom, mais protégé.
    assert.equal(estProtege(["secrets"]), true);
  });

  it("parité avec ProjectsService.list() sur 8 noms, dont un nom %XX écarté de list() mais navigable en lecture", async () => {
    const dossier = fs.mkdtempSync(path.join(os.tmpdir(), "cockpit-nav1-"));
    try {
      const dossiers = ["projet-a", "Remise 20%", ".cache", "node_modules", "a%2F..%2Fx", "secrets", "NOTES~1"];
      for (const nom of dossiers) fs.mkdirSync(path.join(dossier, nom));
      fs.writeFileSync(path.join(dossier, "lisez-moi.txt"), "texte");
      assert.equal(fs.readdirSync(dossier).length, 8);
      const service = new ProjectsService({ workspaceDir: dossier, opencodeWorkspaceDir: "/workspace" });
      const liste = (await service.list()).filter((projet) => !projet.isRoot).map((projet) => projet.name);
      assert.deepEqual([...liste].sort(), ["NOTES~1", "Remise 20%", "projet-a", "secrets"].sort());
      // Toute entrée non racine de list() qui n'est ni protégée ni douteuse est navigable.
      for (const nom of liste) if (!estProtege([nom]) && segmentSur(nom)) assert.equal(projetNavigable(nom), true, nom);
      // Tout dossier navigable existant est dans list(), sauf les noms %XX (écartés par A22, navigables en lecture par D14 (b)).
      const pourcent = /%[0-9A-Fa-f]{2}/;
      for (const nom of dossiers) if (projetNavigable(nom) && !pourcent.test(nom)) assert.ok(liste.includes(nom), nom);
      assert.equal(projetNavigable("a%2F..%2Fx"), true);
      assert.equal(liste.includes("a%2F..%2Fx"), false);
      assert.equal(projetNavigable("NOTES~1"), false, "nom court 8.3 possible : douteux, jamais parcouru");
      assert.equal(estProtege(["secrets"]) && liste.includes("secrets"), true);
    } finally {
      fs.rmSync(dossier, { recursive: true, force: true });
    }
  });
});

// --- Protection ---------------------------------------------------------------------------------------------------------------

describe("fichiers : estProtege (§2.6, A6)", () => {
  const proteges = [
    ".env",
    ".ENV",
    ".env.local",
    ".env.example",
    ".env.production.local",
    "prod.env",
    ".envrc",
    "projet/.env/x",
    ".git/config",
    ".GIT/HEAD",
    "projet/.git",
    "projet/sous/.git/hooks/pre-commit",
    "cle.pfx",
    "CLE.P12",
    "id_ed25519",
    "id_ed25519.pub",
    "id_rsa",
    "id_dsa",
    "id_ecdsa",
    "privkey.pem",
    "server.pem",
    "cert-key.pem",
    "a.PPK",
    ".kube/config",
    "projet/.kube/config",
    "mon.kube/config",
    "kubeconfig.yaml",
    "credentials.json",
    "credentials.ps1",
    "aws/credentials",
    ".aws/config",
    ".ssh/known_hosts",
    ".docker/config.json",
    ".claude/settings.json",
    ".opencode/agent.md",
    ".agents/x.md",
    ".terraform/etat",
    ".gnupg/cles",
    ".azure/profil",
    ".secrets/a",
    "secrets/readme.md",
    "auth.json",
    ".npmrc",
    ".netrc",
    ".pypirc",
    ".pgpass",
    ".git-credentials",
    "settings.xml",
    "terraform.tfstate",
    "prod.tfvars",
    "x.key",
    "x.jks",
    "x.keystore",
    "x.kdbx",
    "x.crt",
    "x.cer",
    "x.der",
    "x.p8",
    "x.gpg",
    "x.asc",
    "x.ovpn",
    ".bash_history",
    "ConsoleHost_history.txt",
    ".mcp.json",
    "opencode.json",
    "opencode.jsonc",
    "tokenizer/x.py",
    "token.json",
    "passwords.txt",
    "password-policy.txt",
    "api-token",
    "secrets",
    "mon-secret",
  ];
  const visibles = [
    "Get-Token.ps1",
    "Reset-Password.ps1",
    "password-policy.md",
    "README.md",
    "scripts/deploy.ps1",
    "docs/secret-sauce.md",
    "src/index.ts",
    ".gitignore",
    ".github/workflows/ci.yml",
    ".vscode/settings.json",
    "venv/lib/site.py",
    "notes.txt",
    "Dockerfile",
    "docker-compose.yml",
    "environment.md",
    "kube/config",
    "Remise 20%/facture.txt",
    "a%2F..%2Fx/b.ps1",
    "package.json",
  ];

  it("au moins 60 cas : protégés (A19 : .env*, clés, *credentials*, .git/**) et visibles", () => {
    assert.ok(proteges.length + visibles.length >= 60);
    for (const chemin of proteges) assert.equal(estProtege(chemin.split("/")), true, chemin);
    for (const chemin of visibles) assert.equal(estProtege(chemin.split("/")), false, chemin);
  });

  it("chaque motif de NAV_PROTEGES a son cas, et seule la règle 3 le protège (sauf .htpasswd, déjà couvert par « passw »)", () => {
    const cas = [
      ...NAV_PROTEGES.extensions.map((extension) => `fichier.${extension.toUpperCase()}`),
      ...NAV_PROTEGES.noms,
      ...NAV_PROTEGES.noms.map((nom) => nom.toUpperCase()),
      ...NAV_PROTEGES.suffixes.flatMap((suffixe) => [`prod${suffixe}`, `PROD${suffixe.toUpperCase()}`]),
      ...NAV_PROTEGES.morceaux.flatMap((morceau) => [`terraform${morceau}backup`, `TERRAFORM${morceau.toUpperCase()}BACKUP`]),
    ];
    assert.equal(cas.length, 4 + 14 * 2 + 1 * 2 + 1 * 2);
    const couvertsAilleurs = cas.filter((nom) => sensitivePath(nom) !== null || KEY_FILE_GLOBS.some((glob) => wildcardMatch(nom, glob, true)));
    assert.deepEqual(couvertsAilleurs, [".htpasswd", ".HTPASSWD"]);
    for (const nom of cas) {
      assert.equal(estProtege([nom]), true, nom);
      assert.equal(estProtege(["projet", "sous", nom, "enfant.txt"]), true, `${nom} protège tout ce qu'il contient`);
    }
  });

  it("Terraform (.gitignore standard : *.tfstate.*, *.tfvars.json) : copies de l'état et variables JSON, que seule la règle 3 voit", () => {
    // Écrits ou lus par Terraform lui-même à côté de terraform.tfstate et de *.tfvars (protégés par la règle 1, ancrée sur la
    // fin du nom) : l'état précédent (mêmes secrets en clair), les sauvegardes horodatées de « terraform state », les variables
    // en JSON chargées d'office.
    const cas = [
      "terraform.tfstate.backup",
      "TERRAFORM.TFSTATE.BACKUP",
      "terraform.tfstate.1695000000.backup",
      `terraform.tf${ch(0x17f)}tate.backup`,
      "terraform.tfvars.json",
      "prod.auto.tfvars.json",
      "Prod.Auto.TFVARS.JSON",
    ];
    for (const nom of cas) {
      assert.equal(sensitivePath(nom.toLowerCase()), null, `${nom} : la règle 1 ne le voit pas`);
      assert.ok(!KEY_FILE_GLOBS.some((glob) => wildcardMatch(nom.toLowerCase(), glob, true)), `${nom} : la règle 2 ne le voit pas`);
      assert.equal(estProtege([nom]), true, nom);
      assert.equal(estProtege(["infra", "prod", nom]), true, `${nom} dans un projet`);
    }
    // Dossier des états par espace de travail (backend local) : protégé avec tout ce qu'il contient.
    assert.equal(estProtege(["infra", "terraform.tfstate.d", "prod", "terraform.tfstate.backup"]), true);
    assert.equal(estProtege(["infra", "terraform.tfstate.d", "prod", "notes.txt"]), true);
    assert.equal(estProtege(["infra", "terraform.tfstate.d"]), true);
    // Témoins visibles : sources et modèles de Terraform.
    for (const nom of ["main.tf", "variables.tf", "terraform.tfvars.example", "tfvars.json", "tfstate.md", "backup.json"]) {
      assert.equal(estProtege(["infra", nom]), false, nom);
    }
  });

  it("exception A6 : secret, passw et token restent lisibles sur un script ou un source, jamais ailleurs", () => {
    const lisibles = [
      "Get-Token.ps1",
      "Reset-Password.ps1",
      "password-policy.md",
      "secret-sauce.md",
      "secret.py",
      "secrets.ps1",
      "token.ts",
      "set_password.sql",
      "Get-Secret.psm1",
      "token-refresh.sh",
      "MOT-DE-PASSWORD.CMD",
    ];
    for (const nom of lisibles) {
      assert.equal(sensitivePath(nom), "nom", `${nom} : la règle 1 le vise`);
      assert.equal(estProtege([nom]), false, nom);
    }
    const toujoursProteges = [
      "credentials.ps1",
      "credential-helper.sh",
      "id_rsa.py",
      "id_dsa.js",
      "id_ecdsa.ts",
      "id_ed25519.md",
      "privkey.js",
      "kubeconfig.py",
      "secret.json",
      "secret",
      "secret.txt",
      "token.ps1.bak",
      "password-policy.txt",
      "tokenizer",
      "secrets/Get-Token.ps1",
      "token.env",
      "secret.pem",
    ];
    for (const nom of toujoursProteges) assert.equal(estProtege(nom.split("/")), true, nom);
  });

  it("casse ignorée, alias Unicode repliés, dossier protégé avec son contenu, entrée invalide fermée", () => {
    assert.equal(estProtege([`${ch(0x17f)}ecrets`, "readme.md"]), true, "s long (U+017F)");
    assert.equal(estProtege([`${ch(0x212a)}ubeconfig`]), true, "signe kelvin (U+212A)");
    assert.equal(estProtege(["Projet", ".Git", "objects", "ab"]), true);
    assert.equal(estProtege(["projet"]), false);
    assert.equal(estProtege([]), false, "la racine elle-même n'est pas protégée");
    assert.equal(estProtege("x" as unknown as string[]), true);
    assert.equal(estProtege(["a", 3 as unknown as string]), true);
  });

  it("tri des motifs de KEY_FILE_GLOBS : même verdict que wildcardMatch sur un corpus, barres inverses et Unicode compris", () => {
    const corpus = [
      ".env",
      "a.env",
      "x.env.d",
      "x.ENV",
      "cle.pfx",
      "CLE.PFX",
      "a-key.pem",
      "a_key.PEM",
      "id_rsa.pub",
      "mon_id_ecdsa",
      "kubeconfig",
      "privkey",
      ".kube/config",
      "p/.kube/config",
      "p\\.kube\\config",
      ".kube\\config",
      "kube/config",
      "x.keystore",
      `x.key${ch(0x17f)}tore`,
      `${ch(0x212a)}ubeconfig`,
      `${ch(0x130)}d_rsa`,
      "readme.md",
      "",
    ];
    for (const texte of corpus) {
      const minuscule = texte.toLowerCase();
      for (const glob of KEY_FILE_GLOBS) {
        assert.equal(correspondMotifCle(minuscule, glob), wildcardMatch(minuscule, glob, true), `${texte} ~ ${glob}`);
      }
    }
    // Motif hors de la liste (morceaux calculés à la volée) et motif terminé par « * » après une espace.
    assert.equal(correspondMotifCle("git", "git *"), wildcardMatch("git", "git *", true));
    assert.equal(correspondMotifCle("git status", "git *"), true);
  });

  it("débit : 5 000 appels à profondeur 12 en moins d'une seconde (parcours borné à 2 s), sans construire d'expression", () => {
    const parents = ["projet", "a", "b", "c", "d", "e", "f", "g", "h", "i", "j"];
    // wildcardMatch construit une expression à chaque appel : le tri des motifs doit l'éviter pour les noms ordinaires
    // (sans lui : 5 000 × 12 × 17 constructions, 1,4 s mesurées). Compte déterministe, indépendant de la charge de la machine.
    const Origine = globalThis.RegExp;
    let constructions = 0;
    globalThis.RegExp = new Proxy(Origine, {
      construct(cible, args: [string | RegExp, string?]) {
        constructions++;
        return Reflect.construct(cible, args) as RegExp;
      },
    });
    const debut = performance.now();
    try {
      for (let i = 0; i < 5_000; i++) estProtege([...parents, `Fichier-${i}.ps1`]);
      assert.equal(estProtege(["projet", ".env.example"]), true, "protégé par le seul motif *.env.*");
    } finally {
      globalThis.RegExp = Origine;
    }
    assert.ok(performance.now() - debut < 1_000, `${Math.round(performance.now() - debut)} ms`);
    assert.ok(constructions >= 1, "témoin : un nom de clé passe le tri et construit l'expression de son motif");
    assert.ok(constructions < 50, `${constructions} expressions construites`);
  });
});

// --- Décodage -----------------------------------------------------------------------------------------------------------------

/** windows-1252 de 0x80 à 0x9F, recopié de la table WHATWG ; les cinq octets non attribués valent U+FFFD (fiche §2.9). */
const CP1252_ATTENDU = [
  0x20ac, 0xfffd, 0x201a, 0x0192, 0x201e, 0x2026, 0x2020, 0x2021, 0x02c6, 0x2030, 0x0160, 0x2039, 0x0152, 0xfffd, 0x017d, 0xfffd,
  0xfffd, 0x2018, 0x2019, 0x201c, 0x201d, 0x2022, 0x2013, 0x2014, 0x02dc, 0x2122, 0x0161, 0x203a, 0x0153, 0xfffd, 0x017e, 0x0178,
];
const NON_ATTRIBUES = new Set([0x81, 0x8d, 0x8f, 0x90, 0x9d]);

function octetsAleatoires(n: number, graine: number): Uint8Array {
  const sortie = new Uint8Array(n);
  let x = graine >>> 0;
  for (let i = 0; i < n; i++) {
    x = (Math.imul(x, 1_664_525) + 1_013_904_223) >>> 0;
    sortie[i] = x >>> 24;
  }
  sortie[0] = 0x41;
  return sortie;
}

function utf16be(texte: string): Uint8Array {
  const sortie = [0xfe, 0xff];
  for (let i = 0; i < texte.length; i++) sortie.push(texte.charCodeAt(i) >> 8, texte.charCodeAt(i) & 0xff);
  return Uint8Array.from(sortie);
}

describe("fichiers : decoderTexte (§2.9, A4 : sans ICU)", () => {
  /** Octets d'un vrai Out-File de Windows PowerShell 5.1.26100 (encodage par défaut, sans profil) : « Rapport généré », « Fin ». */
  const OUT_FILE_PS51 = hex("fffe52006100700070006f007200740020006700e9006e00e9007200e9000d000a00460069006e000d000a00");

  it("vide, BOM UTF-8, BOM seul, BOM suivi d'octets invalides", () => {
    assert.deepEqual(decoderTexte(new Uint8Array(), false), { etat: "vide", encodage: null, texte: "" });
    assert.deepEqual(decoderTexte(Uint8Array.from([0xef, 0xbb, 0xbf, ...octets("héllo")]), false), { etat: "texte", encodage: "utf-8-bom", texte: "héllo" });
    assert.deepEqual(decoderTexte(Uint8Array.from([0xef, 0xbb, 0xbf]), false), { etat: "vide", encodage: "utf-8-bom", texte: "" });
    assert.equal(decoderTexte(Uint8Array.from([0xef, 0xbb, 0xbf, 0x61, 0xe9, 0x62]), false).etat, "binaire");
  });

  it("UTF-16LE avec BOM : octets d'un vrai Out-File de PowerShell 5.1, « é » et CRLF", () => {
    const decode = decoderTexte(OUT_FILE_PS51, false);
    assert.deepEqual(decode, { etat: "texte", encodage: "utf-16le", texte: "Rapport généré\r\nFin\r\n" });
    const prepare = preparerTexte(decode.texte ?? "", false);
    assert.equal(prepare.texte, "Rapport généré\nFin");
    assert.equal(prepare.lignes, 2);
  });

  it("UTF-16LE tronqué : dernier octet impair et moitié de paire ignorés ; entier impair : binaire", () => {
    const tronque = Uint8Array.from([...OUT_FILE_PS51, 0x41]);
    assert.equal(decoderTexte(tronque, true).texte, "Rapport généré\r\nFin\r\n");
    const paire = Uint8Array.from([0xff, 0xfe, 0x61, 0x00, 0x3d, 0xd8]);
    assert.deepEqual(decoderTexte(paire, true), { etat: "texte", encodage: "utf-16le", texte: "a" });
    assert.equal(decoderTexte(Uint8Array.from([0xff, 0xfe, 0x61, 0x00, 0x62]), false).etat, "binaire");
  });

  it("UTF-16BE : octets permutés, sans ICU", () => {
    const texte = `é€${ch(0xd83d, 0xde00)} fin\r\n`;
    assert.deepEqual(decoderTexte(utf16be(texte), false), { etat: "texte", encodage: "utf-16be", texte });
  });

  it("windows-1252 par table pure : 0x80 à 0x9F exacts, E9 → é, 80 → €, Latin-1 au-delà de 0xA0", () => {
    const table = Uint8Array.from({ length: 32 }, (_, i) => 0x80 + i);
    const entourage = octets("x".repeat(600));
    const decode = decoderTexte(Uint8Array.from([...entourage, ...table]), false);
    assert.equal(decode.encodage, "windows-1252");
    assert.equal(decode.etat, "texte", "5 caractères de contrôle sur 632 : sous la part de 1 %");
    const codes = [...(decode.texte ?? "").slice(600)].map((c) => c.charCodeAt(0));
    assert.deepEqual(codes, CP1252_ATTENDU);
    assert.deepEqual(decoderTexte(Uint8Array.from([...octets("caf"), 0xe9]), false), { etat: "texte", encodage: "windows-1252", texte: "café" });
    assert.deepEqual(decoderTexte(Uint8Array.from([...octets("prix 10"), 0x80]), false), { etat: "texte", encodage: "windows-1252", texte: "prix 10€" });
    assert.equal(decoderTexte(Uint8Array.from([0x41, 0xa0, 0xe0, 0xff, 0x80]), false).texte, `A${ch(0xa0)}àÿ€`);
    // Recoupement avec le décodeur WHATWG du moteur, quand il le propose (ICU complet) ; les octets non attribués diffèrent.
    let whatwg: TextDecoder | null = null;
    try {
      whatwg = new TextDecoder("windows-1252");
    } catch {
      // Moteur sans ICU complet : la table recopiée ci-dessus fait foi.
    }
    if (whatwg !== null) {
      const reference = whatwg.decode(table);
      for (let i = 0; i < 32; i++) if (!NON_ATTRIBUES.has(0x80 + i)) assert.equal(codes[i], reference.charCodeAt(i), (0x80 + i).toString(16));
    }
  });

  it("binaire : octet NUL, octets aléatoires fixés, trop de caractères de contrôle ; TAB, LF, CR, FF permis", () => {
    assert.deepEqual(decoderTexte(octets(`abc${ch(0)}def`), false), { etat: "binaire", encodage: null, texte: null });
    assert.equal(decoderTexte(octetsAleatoires(4_096, 20_260_926), false).etat, "binaire");
    const sansNul = octetsAleatoires(4_096, 7).map((octet) => (octet === 0 ? 1 : octet));
    assert.equal(sansNul.includes(0), false);
    assert.equal(decoderTexte(sansNul, false).etat, "binaire", "part de contrôle au-delà de 1 %");
    // Un NUL dans les DETECTION_OCTETS premiers suffit, même sous la part de contrôle (1 sur 201) ; au-delà, seule la part compte.
    assert.equal(decoderTexte(octets(`${"a".repeat(200)}${ch(0)}`), false).etat, "binaire");
    const nulTardif = octets(`${"a".repeat(8_192)}${ch(0)}`);
    assert.equal(decoderTexte(nulTardif, false).etat, "texte");
    assert.equal(decoderTexte(octets(`${"a".repeat(99)}${ch(7)}`), false).etat, "texte", "1 % exactement");
    assert.equal(decoderTexte(octets(`${"a".repeat(49)}${ch(7)}`), false).etat, "binaire", "2 %");
    assert.equal(decoderTexte(octets(`${"a".repeat(49)}${ch(0x7f)}`), false).etat, "binaire", "DEL");
    assert.equal(decoderTexte(octets(`${"a".repeat(49)}${ch(0x85)}`), false).etat, "binaire", "C1 en UTF-8");
    assert.equal(decoderTexte(octets(`a${ch(9)}b${ch(12)}c\r\nd`), false).etat, "texte");
  });

  it("UTF-8 coupé au milieu d'un caractère de 3 octets : avec « tronque », aucun U+FFFD final", () => {
    const entier = octets("abc€");
    assert.equal(entier.length, 6);
    const coupe = entier.subarray(0, 5);
    assert.deepEqual(decoderTexte(coupe, true), { etat: "texte", encodage: "utf-8", texte: "abc" });
    const sansTronque = decoderTexte(coupe, false);
    assert.notEqual(sansTronque.encodage, "utf-8", "sans « tronque », l'UTF-8 strict échoue");
  });
});

// --- Préparation --------------------------------------------------------------------------------------------------------------

describe("fichiers : preparerTexte, masquage PEM ligne par ligne (A2), invisibles", () => {
  it("coupe au dernier saut de ligne si tronqué ; CRLF ; saut de ligne final", () => {
    assert.deepEqual(preparerTexte("a\nb\nc partiel", true), { texte: "a\nb", lignes: 2, tronque: true, lignesCoupees: 0, secretsMasques: false, invisibles: 0 });
    assert.equal(preparerTexte("a\n\nc partiel", true).texte, "a\n");
    assert.deepEqual(preparerTexte("a\r\nb\r\n", false), { texte: "a\nb", lignes: 2, tronque: false, lignesCoupees: 0, secretsMasques: false, invisibles: 0 });
    assert.equal(preparerTexte("a\nb", false).lignes, 2);
    assert.equal(preparerTexte("seule", true).texte, "seule", "sans saut de ligne, rien à couper");
  });

  it("10 000 lignes au plus : la 10 001e rend « tronque »", () => {
    const lignes = (n: number) => Array.from({ length: n }, (_, i) => `ligne ${i + 1}`).join("\n");
    const dixMille = preparerTexte(lignes(10_000), false);
    assert.equal(dixMille.lignes, 10_000);
    assert.equal(dixMille.tronque, false);
    const plus = preparerTexte(lignes(10_001), false);
    assert.equal(plus.lignes, 10_000);
    assert.equal(plus.tronque, true);
    assert.equal(plus.texte.split("\n").at(-1), "ligne 10000");
  });

  it("ligne de 2 001 caractères coupée à 2 000 et comptée ; paire de substitution jamais séparée", () => {
    const juste = preparerTexte("a".repeat(2_000), false);
    assert.equal(juste.lignesCoupees, 0);
    const longue = preparerTexte(`${"a".repeat(2_001)}\n${"b".repeat(3_000)}`, false);
    assert.equal(longue.lignesCoupees, 2);
    assert.equal(longue.texte.split("\n")[0]?.length, 2_000);
    const emoji = ch(0xd83d, 0xde00);
    const coupe = preparerTexte(`${"a".repeat(1_999)}${emoji}b`, false).texte;
    assert.equal(coupe, "a".repeat(1_999), "le caractère à cheval sur la borne est retiré entier");
    const dernier = coupe.charCodeAt(coupe.length - 1);
    assert.ok(dernier < 0xd800 || dernier > 0xdbff);
  });

  it("bloc de clé privée complet, sans fin, ou sur une seule ligne : chaque ligne → ****, même nombre de lignes", () => {
    const complet = ["avant", PEM_DEBUT, "MIIEvQIBADANBgkqhkiG9w0BAQEFAASC", "abcd", PEM_FIN, "après"].join("\n");
    const prepare = preparerTexte(complet, false);
    assert.deepEqual(prepare.texte.split("\n"), ["avant", "****", "****", "****", "****", "après"]);
    assert.equal(prepare.lignes, 6);
    assert.equal(prepare.secretsMasques, true);
    const sansFin = preparerTexte(["avant", PEM_DEBUT, "MIIE", "abcd"].join("\n"), false);
    assert.deepEqual(sansFin.texte.split("\n"), ["avant", "****", "****", "****"]);
    const uneLigne = preparerTexte([`${PEM_DEBUT}MIIE${PEM_FIN}`, "suite"].join("\n"), false);
    assert.deepEqual(uneLigne.texte.split("\n"), ["****", "suite"]);
    const openssh = preparerTexte(["-----BEGIN " + "OPENSSH PRIVATE KEY-----", "b3BlbnNzaC1rZXktdjEAAAA", "-----END " + "OPENSSH PRIVATE KEY-----"].join("\n"), false);
    assert.deepEqual(openssh.texte.split("\n"), ["****", "****", "****"]);
    // Un certificat (clé publique) n'est pas un bloc de clé privée.
    const certificat = preparerTexte(["-----BEGIN CERTIFICATE-----", "MIIB", "-----END CERTIFICATE-----"].join("\n"), false);
    assert.equal(certificat.texte.split("\n")[1], "MIIB");
  });

  describe("bloc de clé privée : début et fin lus sur la ligne entière, avant la coupe à 2 000 caractères (relecture F2-vague-4)", () => {
    const corps = ["MIIEowIBAAKCAQEAu1SU1LfVLPHCozMx", "H2Mo4lgOEePzNm0tRgeLezV6ffAt0gun"];
    const masque = (n: number) => Array.from({ length: n }, () => "****");
    const verifier = (lignes: readonly string[], attendu: readonly string[], cas: string) => {
      const prepare = preparerTexte(lignes.join("\n"), false);
      assert.deepEqual(prepare.texte.split("\n"), attendu, cas);
      assert.equal(prepare.lignes, lignes.length, `${cas} : même nombre de lignes`);
      assert.equal(prepare.secretsMasques, true, cas);
      return prepare;
    };

    it("cas 1 : « -----BEGIN » à cheval sur la borne (la ligne coupée finit par « -----BEGIN RSA »)", () => {
      const cheval = verifier([`${"x".repeat(1_985)}${PEM_DEBUT}`, ...corps, PEM_FIN, "après"], [...masque(4), "après"], "début à cheval");
      assert.equal(cheval.lignesCoupees, 1);
    });

    it("cas 2 : « -----BEGIN » entier au-delà du 2 000e caractère", () => {
      verifier([`${"x".repeat(2_100)}${PEM_DEBUT}`, ...corps, PEM_FIN, "après"], [...masque(4), "après"], "début au-delà de la borne");
    });

    it("cas 3 : deux clés concaténées sans saut de ligne final (cat a.pem b.pem) : la fin de la première rouvre la seconde", () => {
      verifier([PEM_DEBUT, ...corps, `${PEM_FIN}${PEM_DEBUT}`, ...corps, PEM_FIN, "après"], [...masque(7), "après"], "cat a.pem b.pem");
      verifier([`${PEM_DEBUT}MIIE${PEM_FIN}${PEM_DEBUT}`, ...corps, PEM_FIN, "après"], [...masque(4), "après"], "une ligne puis une autre clé");
      verifier([PEM_DEBUT, ...corps, `${PEM_FIN}${"x".repeat(2_000)}${PEM_DEBUT}`, ...corps, PEM_FIN, "après"], [...masque(7), "après"], "réouverture loin");
    });

    it("fin au-delà du 2 000e caractère : le bloc se ferme, la suite n'est pas masquée à tort", () => {
      verifier([PEM_DEBUT, ...corps, `${"A".repeat(2_100)}${PEM_FIN}`, "après"], [...masque(4), "après"], "fin au-delà de la borne");
    });

    it("témoin : un certificat (clé publique) qui suit la fin d'une clé sur la même ligne ne rouvre pas de bloc", () => {
      const lignes = [PEM_DEBUT, ...corps, `${PEM_FIN}-----BEGIN CERTIFICATE-----`, "MIIB", "-----END CERTIFICATE-----"];
      verifier(lignes, [...masque(4), "MIIB", "-----END CERTIFICATE-----"], "certificat");
    });
  });

  it("redactSecrets ligne par ligne : password = hunter22 → password = **** et secretsMasques", () => {
    const prepare = preparerTexte("# réglages\npassword = hunter22\nfin", false);
    assert.deepEqual(prepare.texte.split("\n"), ["# réglages", "password = ****", "fin"]);
    assert.equal(prepare.secretsMasques, true);
    assert.equal(preparerTexte("rien de secret ici", false).secretsMasques, false);
  });

  it("invisibles : U+202E et U+200B marqués et comptés ; TAB gardé ; CR isolé, BOM et C1 marqués", () => {
    const texte = `if (a) ${ch(0x202e)}{ admin }${ch(0x200b)}\n${ch(9)}x${ch(13)}y${ch(0xfeff)}z${ch(0x9b)}`;
    const prepare = preparerTexte(texte, false);
    assert.deepEqual(prepare.texte.split("\n"), ["if (a) ⟦U+202E⟧{ admin }⟦U+200B⟧", `${ch(9)}x⟦U+000D⟧y⟦U+FEFF⟧z⟦U+009B⟧`]);
    assert.equal(prepare.invisibles, 5);
    const familles = [0x202a, 0x202b, 0x202c, 0x202d, 0x2066, 0x2067, 0x2068, 0x2069, 0x200e, 0x200f, 0x061c, 0x200c, 0x200d, 0x2060, 0x7f, 0x1b];
    assert.equal(preparerTexte(familles.map((code) => ch(code)).join(""), false).invisibles, familles.length);
    assert.equal(rendreVisible(`note${ch(0x202e)}fdp.exe`), "note⟦U+202E⟧fdp.exe");
    assert.equal(rendreVisible("Get-Token.ps1"), "Get-Token.ps1");
  });

  it("chronométré : 256 Kio de lignes de 2 000 caractères « mysql » répétés, puis une seule ligne de 256 Kio, en moins de 1 s", () => {
    const motif = "mysql ";
    const ligne = motif.repeat(Math.ceil(2_000 / motif.length)).slice(0, 2_000);
    const lignes = Array.from({ length: Math.ceil((256 * 1_024) / 2_001) }, () => ligne).join("\n");
    assert.ok(lignes.length >= 256 * 1_024);
    let debut = performance.now();
    const prepare = preparerTexte(lignes, false);
    assert.ok(performance.now() - debut < 1_000, `${Math.round(performance.now() - debut)} ms`);
    assert.equal(prepare.lignesCoupees, 0);
    // Sans la coupe à 2 000 caractères, redactSecrets serait quadratique sur cette ligne (environ 2 s mesurées).
    const uneLigne = motif.repeat(Math.ceil((256 * 1_024) / motif.length));
    debut = performance.now();
    assert.equal(preparerTexte(uneLigne, false).lignesCoupees, 1);
    assert.ok(performance.now() - debut < 1_000, `${Math.round(performance.now() - debut)} ms`);
  });
});

describe("fichiers : normaliserRecherche et tailleLisible", () => {
  it("recherche : NFD, marques U+0300 à U+036F retirées, minuscules", () => {
    assert.equal(normaliserRecherche("Éléphant"), "elephant");
    assert.equal(normaliserRecherche("Crème Brûlée"), "creme brulee");
    assert.equal(normaliserRecherche(`E${ch(0x301)}te${ch(0x301)}`), normaliserRecherche("Été"));
    assert.equal(normaliserRecherche("ŒUVRE"), "œuvre");
    assert.equal(normaliserRecherche("Get-Rapport.PS1"), "get-rapport.ps1");
  });

  it("taille : octets, puis Ko, Mo, Go (1 024), virgule française, « ,0 » omis", () => {
    const cas: Array<[number, string]> = [
      [0, "0 o"],
      [512, "512 o"],
      [1_023, "1023 o"],
      [1_024, "1 Ko"],
      [1_536, "1,5 Ko"],
      [12 * 1_024, "12 Ko"],
      [1_048_575, "1 Mo"],
      [Math.round(1.2 * 1_048_576), "1,2 Mo"],
      [Math.round(3.4 * 1_073_741_824), "3,4 Go"],
      [-5, "0 o"],
      [Number.NaN, "0 o"],
    ];
    for (const [octetsDonnes, attendu] of cas) assert.equal(tailleLisible(octetsDonnes), attendu, String(octetsDonnes));
  });
});

// --- Adresses -----------------------------------------------------------------------------------------------------------------

/** Relit une adresse comme le fait la page (parseRouteQuery du routeur du web). */
const relire = (adresse: string) => lireAdresse(parseRouteQuery(adresse));

describe("fichiers : adresses du web (#/fichiers?projet=…&chemin=…)", () => {
  it("aller-retour adresseFichiers / lireAdresse, y compris un nom %XX encodé %25 puis relu littéral (D14 (b))", () => {
    assert.equal(adresseFichiers(), "#/fichiers");
    assert.equal(adresseFichiers({ projet: "nav-banc", chemin: "scripts/Get-Rapport.ps1" }), "#/fichiers?projet=nav-banc&chemin=scripts%2FGet-Rapport.ps1");
    const cas: Array<{ projet: string; chemin: string }> = [
      { projet: "", chemin: "" },
      { projet: "p", chemin: "" },
      { projet: "p", chemin: "a/b c/d.ps1" },
      { projet: "", chemin: "p/x" },
      { projet: "Remise 20%", chemin: "a&b=c#d+e" },
      { projet: "a%2F..%2Fx", chemin: "b" },
      { projet: "", chemin: "a%2F..%2F..%2Fsecret" },
    ];
    for (const { projet, chemin } of cas) {
      const adresse = adresseFichiers({ projet, chemin });
      assert.deepEqual(relire(adresse), { projet, segments: chemin === "" ? [] : chemin.split("/") }, adresse);
    }
    assert.ok(adresseFichiers({ projet: "a%2F..%2Fx" }).includes("a%252F..%252Fx"));
  });

  it("paramètre répété, projet ou chemin refusés → null", () => {
    for (const requete of ["projet=a&projet=b", "chemin=a&chemin=b", "projet=.cache", "projet=a%2Fb", "chemin=..%2Fx", "chemin=a%5Cb", "chemin=%2Fetc", "chemin=a%00b"]) {
      assert.equal(relire(`#/fichiers?${requete}`), null, requete);
    }
  });

  it("déduction du projet sans paramètre projet : premier segment navigable suivi d'un autre", () => {
    assert.deepEqual(relire("#/fichiers?chemin=nav-banc%2Fscripts%2Fx.ps1"), { projet: "nav-banc", segments: ["scripts", "x.ps1"] });
    assert.deepEqual(relire("#/fichiers?chemin=x.ps1"), { projet: "", segments: ["x.ps1"] });
    assert.deepEqual(relire("#/fichiers?chemin=.cache%2Fx"), { projet: "", segments: [".cache", "x"] });
    assert.deepEqual(relire("#/fichiers?chemin=node_modules%2Fx"), { projet: "", segments: ["node_modules", "x"] });
    assert.deepEqual(relire("#/fichiers"), { projet: "", segments: [] });
    assert.deepEqual(relire("#/fichiers?projet=&chemin=a%2Fb"), { projet: "", segments: ["a", "b"] }, "projet explicite : aucune déduction");
  });

  it("adresseDepuisOutil : read, write, edit et multiedit terminés seulement, sous la racine", () => {
    const fichier = "/workspace/nav-banc/scripts/nouveau.ps1";
    const attendu = "#/fichiers?projet=nav-banc&chemin=scripts%2Fnouveau.ps1";
    for (const outil of ["read", "write", "edit", "multiedit"]) {
      assert.equal(adresseDepuisOutil({ outil, statut: "completed", fichier, racine: "/workspace" }), attendu, outil);
      for (const statut of ["pending", "running", "error"]) assert.equal(adresseDepuisOutil({ outil, statut, fichier, racine: "/workspace" }), null, `${outil} ${statut}`);
    }
    for (const outil of ["bash", "list", "glob", "grep", "patch", "apply_patch", "READ", "autre"]) {
      assert.equal(adresseDepuisOutil({ outil, statut: "completed", fichier, racine: "/workspace" }), null, outil);
    }
    assert.deepEqual(relire(attendu), { projet: "nav-banc", segments: ["scripts", "nouveau.ps1"] });
  });

  it("adresseDepuisOutil : racine avec barre finale, chemins Windows, casse ; hors racine ou chemin refusé → null", () => {
    const lien = (fichier: unknown, racine: unknown) => adresseDepuisOutil({ outil: "write", statut: "completed", fichier, racine });
    assert.equal(lien("/workspace/p/a.ps1", "/workspace/"), "#/fichiers?projet=p&chemin=a.ps1");
    assert.equal(lien("C:\\Users\\x\\travail\\p\\a.ps1", "C:\\Users\\x\\travail"), "#/fichiers?projet=p&chemin=a.ps1");
    assert.equal(lien("/WORKSPACE/p/a.ps1", "/workspace"), "#/fichiers?projet=p&chemin=a.ps1");
    assert.equal(lien("/workspace/notes.txt", "/workspace"), "#/fichiers?projet=&chemin=notes.txt");
    assert.equal(lien("/workspace/.cache/x", "/workspace"), "#/fichiers?projet=&chemin=.cache%2Fx");
    assert.equal(lien("/workspace/a%2F..%2Fx/b.ps1", "/workspace"), "#/fichiers?projet=a%252F..%252Fx&chemin=b.ps1");
    for (const [fichier, racine] of [
      ["/etc/passwd", "/workspace"],
      ["/workspace-autre/x", "/workspace"],
      ["/workspace", "/workspace"],
      ["/workspace/", "/workspace"],
      ["/workspace/../etc/passwd", "/workspace"],
      ["/workspace/p//a", "/workspace"],
      ["/workspace/p/a", ""],
      [null, "/workspace"],
      ["/workspace/p/a", 3],
    ] as Array<[unknown, unknown]>) {
      assert.equal(lien(fichier, racine), null, `${String(fichier)} sous ${String(racine)}`);
    }
  });

  it("comparaison recopiée de relativePath (ToolCard.tsx) : le source du web n'a pas changé", () => {
    const source = fs.readFileSync(path.join(import.meta.dirname, "..", "web", "pages", "chat", "ToolCard.tsx"), "utf8");
    for (const extrait of [
      'const norm = file.replace(/\\\\/g, "/");',
      'const base = root.replace(/\\\\/g, "/").replace(/\\/+$/, "");',
      "base && norm.toLowerCase().startsWith(`${base.toLowerCase()}/`) ? norm.slice(base.length + 1) : norm",
    ]) {
      assert.ok(source.includes(extrait), extrait);
    }
  });

  it("emplacementSurLePoste : racine Windows (« \\ »), racine POSIX (« / »), hostDir vide → null", () => {
    assert.equal(emplacementSurLePoste("C:\\Users\\aurel\\travail", "nav-banc", ["scripts", "x.ps1"]), "C:\\Users\\aurel\\travail\\nav-banc\\scripts\\x.ps1");
    assert.equal(emplacementSurLePoste("C:\\travail\\", "p", ["a"]), "C:\\travail\\p\\a");
    assert.equal(emplacementSurLePoste("C:\\", "p", []), "C:\\p");
    assert.equal(emplacementSurLePoste("d:/travail", "", ["a"]), "d:/travail\\a");
    assert.equal(emplacementSurLePoste("/home/u/travail", "", ["a", "b"]), "/home/u/travail/a/b");
    assert.equal(emplacementSurLePoste("/home/u/travail/", "p", []), "/home/u/travail/p");
    assert.equal(emplacementSurLePoste("/", "p", ["a"]), "/p/a");
    assert.equal(emplacementSurLePoste("/home/u/travail", "", []), "/home/u/travail");
    assert.equal(emplacementSurLePoste("", "p", ["a"]), null);
  });
});

// --- Textes -------------------------------------------------------------------------------------------------------------------

describe("fichiers : textes (§8) et leurs fonctions", () => {
  it("phrases d'honnêteté à la lettre", () => {
    assert.equal(TEXTES.partout.sousTitre, "Lecture seule : ici, rien n'est modifié et rien n'est envoyé à une IA.");
    assert.equal(TEXTES.partout.masquesPlusieurs, "{n} éléments protégés ne sont pas montrés : clés, mots de passe, historique git.");
    assert.equal(TEXTES.simple.lienMessage, "C'est un raccourci vers un autre endroit : par sécurité, il n'est pas ouvert.");
    assert.equal(TEXTES.partout.plusieursNoms, "Ce fichier porte plusieurs noms sur le disque : par sécurité, il n'est pas affiché.");
    assert.equal(TEXTES.partout.tropLong, "Ce fichier est long ({taille}) : seul le début est affiché.");
    assert.equal(TEXTES.partout.aChange, "Ce fichier a changé pendant la lecture.");
    assert.equal(TEXTES.partout.racine, "Tout le workspace");
    assert.deepEqual(Object.keys(TEXTES).sort(), ["avance", "partout", "simple"]);
  });

  it("remplir : gabarits « {nom} », clé absente gardée", () => {
    assert.equal(remplir("{n} éléments, {n} fois", { n: 3 }), "3 éléments, 3 fois");
    assert.equal(remplir(TEXTES.partout.emplacement, { chemin: "C:\\x" }), "Sur votre poste : C:\\x");
    assert.equal(remplir("{absent} et {n}", { n: "2" }), "{absent} et 2");
  });

  it("phraseErreur : une phrase par code, « protege » selon la route, « lien » refusé, code inconnu → erreur générale", () => {
    const codes: FichiersCode[] = [
      "invalide",
      "trop-long",
      "fichiers-coupes",
      "protege",
      "lien",
      "plusieurs-noms",
      "projet-inconnu",
      "introuvable",
      "pas-un-dossier",
      "pas-un-fichier",
      "a-change",
      "illisible",
      "occupe",
    ];
    const phrases = new Set(codes.map((code) => phraseErreur(code, "dossier")));
    assert.equal(phrases.size, codes.length, "aucune phrase partagée entre deux codes");
    assert.equal(phrases.has(TEXTES.partout.erreur), false);
    assert.equal(phraseErreur("protege", "contenu"), TEXTES.partout.protegeFichier);
    for (const route of ["dossier", "recents", "recherche"] as const) assert.equal(phraseErreur("protege", route), TEXTES.partout.protegeDossier);
    assert.equal(phraseErreur("lien", "contenu"), TEXTES.partout.lienRefuse);
    assert.equal(phraseErreur("trop-long", "contenu"), TEXTES.partout.tropLongRequete);
    assert.equal(phraseErreur("fichiers-coupes", "recents"), TEXTES.partout.coupe);
    assert.equal(phraseErreur("csrf", "contenu"), TEXTES.partout.erreur);
  });

  it("phraseMasques, phraseInvisibles, phraseLignesCoupees : singulier, pluriel, rien pour 0", () => {
    assert.equal(phraseMasques(0), null);
    assert.equal(phraseMasques(-1), null);
    assert.equal(phraseMasques(1.5), null);
    assert.equal(phraseMasques(1), TEXTES.partout.masquesUn);
    assert.equal(phraseMasques(3), "3 éléments protégés ne sont pas montrés : clés, mots de passe, historique git.");
    assert.equal(phraseInvisibles(0), null);
    assert.equal(phraseInvisibles(1), TEXTES.partout.invisibleUn);
    assert.ok(phraseInvisibles(4)?.startsWith("Ce fichier contient 4 caractères invisibles"));
    assert.equal(phraseLignesCoupees(0), null);
    assert.equal(phraseLignesCoupees(1), "1 ligne trop longue est coupée.");
    assert.equal(phraseLignesCoupees(2), "2 lignes trop longues sont coupées.");
  });
});
