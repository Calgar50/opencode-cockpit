// Tests du lecteur disque de l'onglet « Fichiers » (1.1, NAV-2 ; fiche NAV §2.7, §2.8, §2.10, §4). Lecteur seul, sur des
// dossiers temporaires (NAV_TEST_DIR, sinon le dossier temporaire du système : la passe du §4.4 le rejoue sur un montage Docker
// Desktop). Aucun paquet npm : ce fichier tourne aussi dans un conteneur Linux nu (§4.4).
//
// Cas [L] : liens symboliques, tubes et /proc exigent Linux ; sous Windows, ils sont sautés avec la raison « exige Linux (liens
// symboliques, tubes, /proc) ». Chaque barrière du §2.7 a un test qui tombe AVEC SON CODE quand elle est retirée (mutations
// listées dans le message du commit de NAV-2).
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, describe, it, type TestContext } from "node:test";
import { NAV_BORNES } from "./shared/fichiers-regles.ts";
import { creerLecteurFichiers, type LecteurFichiers, type LecteurOptions, type MomentLecteur, reglesDemande } from "./workspace-files.ts";

const LINUX = process.platform === "linux";
const EXIGE_LINUX = "exige Linux (liens symboliques, tubes, /proc)";
/** Options des cas [L]. */
const L = LINUX ? {} : { skip: EXIGE_LINUX };
const BASE = process.env.NAV_TEST_DIR ?? os.tmpdir();
/**
 * Montage réel (passe du §4.4 sur Docker Desktop, NAV_TEST_DIR posé ; train de la vague 6) : sur ce montage (9p), un dossier
 * déplacé après son ouverture ne se relit plus par /proc/self/fd/<fd> (ENOENT, mesuré par NAV-4). Le lecteur le refuse alors
 * (illisible) ou le saute (parcours incomplet). Les deux cas « aller-retour après l'ouverture » y admettent ce refus, jamais un
 * nom extérieur ; sur un dossier local (tmpfs, disque), seuls les vrais noms sont admis.
 */
const MONTAGE = process.env.NAV_TEST_DIR !== undefined;

interface Ligne {
  message: string;
  champs: Record<string, unknown> | undefined;
}

/** Toutes les lignes du journal de tous les lecteurs de ce fichier (contrôlées à la fin, A5). */
const JOURNAL: Ligne[] = [];
/** Racines créées, retirées à la fin ; aucune ne doit apparaître dans une réponse ni dans le journal. */
const RACINES: string[] = [];

after(() => {
  for (const racine of RACINES) fs.rmSync(racine, { recursive: true, force: true });
});

function nouvelleRacine(): string {
  const racine = fs.mkdtempSync(path.join(BASE, "cockpit-nav2-"));
  RACINES.push(racine, fs.realpathSync(racine));
  return racine;
}

function ecrire(racine: string, relatif: string, contenu: string | Uint8Array = ""): string {
  const chemin = path.join(racine, ...relatif.split("/"));
  fs.mkdirSync(path.dirname(chemin), { recursive: true });
  fs.writeFileSync(chemin, contenu);
  return chemin;
}

function dossierVide(racine: string, relatif: string): string {
  const chemin = path.join(racine, ...relatif.split("/"));
  fs.mkdirSync(chemin, { recursive: true });
  return chemin;
}

function tube(chemin: string): void {
  execFileSync("mkfifo", [chemin]);
}

function nouveauLecteur(racine: string, options: Partial<LecteurOptions> = {}): { lecteur: LecteurFichiers; lignes: Ligne[] } {
  const lignes: Ligne[] = [];
  const log = {
    warn: (message: string, champs?: Record<string, unknown>) => {
      lignes.push({ message, champs });
      JOURNAL.push({ message, champs });
    },
  };
  return { lecteur: creerLecteurFichiers({ racine, log, ...options }), lignes };
}

/** Barrière ouverte par le test : tient une lecture à un moment du lecteur. */
function barriere(): { ouverte: Promise<void>; ouvrir: () => void } {
  let ouvrir = (): void => undefined;
  const ouverte = new Promise<void>((resolve) => {
    ouvrir = () => resolve();
  });
  return { ouverte, ouvrir };
}

/** Attend qu'une condition devienne vraie (crochets du lecteur atteints). */
async function jusqua(condition: () => boolean, ms = 5_000): Promise<void> {
  const limite = performance.now() + ms;
  while (!condition()) {
    if (performance.now() > limite) throw new Error("délai dépassé");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

/** Espion d'une méthode de node:fs/promises (le lecteur l'appelle par la même instance) : premiers arguments reçus. */
function espion(t: TestContext, methode: "lstat" | "opendir" | "open"): string[] {
  const vus: string[] = [];
  const cible = fsp as unknown as Record<string, (...args: unknown[]) => Promise<unknown>>;
  const original = cible[methode];
  if (original === undefined) throw new Error(methode);
  t.mock.method(cible, methode, function (this: unknown, ...args: unknown[]) {
    vus.push(String(args[0]));
    return original.apply(this, args);
  });
  return vus;
}

/** Espion de fsp.open : chemin et drapeaux de chaque ouverture. */
function espionOuvertures(t: TestContext): Array<{ chemin: string; drapeaux: number }> {
  const vues: Array<{ chemin: string; drapeaux: number }> = [];
  const cible = fsp as unknown as Record<string, (...args: unknown[]) => Promise<unknown>>;
  const original = cible.open;
  if (original === undefined) throw new Error("open");
  t.mock.method(cible, "open", function (this: unknown, ...args: unknown[]) {
    vues.push({ chemin: String(args[0]), drapeaux: Number(args[1] ?? 0) });
    return original.apply(this, args);
  });
  return vues;
}

/**
 * Aller-retour d'une course (relecture F2-vague-5) sur le dossier `dossier` (chemin réel) : `versLien(dehors)` le remplace par un
 * lien vers `dehors`, `versDossier(autre)` par le vrai dossier `autre` du même disque ; le vrai dossier, avec les mêmes dev et
 * ino, est remis juste avant le lstat suivant de `dossier` lui-même, qui est la revérification du parcours.
 */
function remiseAvantReverification(t: TestContext, dossier: string): { versLien: (dehors: string) => void; versDossier: (autre: string) => void } {
  let remise: (() => void) | null = null;
  const cible = fsp as unknown as Record<string, (...args: unknown[]) => Promise<unknown>>;
  const original = cible.lstat;
  if (original === undefined) throw new Error("lstat");
  t.mock.method(cible, "lstat", function (this: unknown, ...args: unknown[]) {
    if (remise !== null && args[0] === dossier) {
      const remettre = remise;
      remise = null;
      remettre();
    }
    return original.apply(this, args);
  });
  return {
    versLien: (dehors) => {
      fs.renameSync(dossier, `${dossier}-ancien`);
      fs.symlinkSync(dehors, dossier);
      remise = () => {
        fs.unlinkSync(dossier);
        fs.renameSync(`${dossier}-ancien`, dossier);
      };
    },
    versDossier: (autre) => {
      fs.renameSync(dossier, `${dossier}-ancien`);
      fs.renameSync(autre, dossier);
      remise = () => {
        fs.renameSync(dossier, autre);
        fs.renameSync(`${dossier}-ancien`, dossier);
      };
    },
  };
}

/** Nombre de liens rapporté pour un lien physique tout juste créé (M-NAV-1) ; 1 : non rapporté, le cas est sauté. */
function lienPhysique(t: TestContext, source: string, cible: string): boolean {
  fs.linkSync(source, cible);
  if (fs.statSync(cible).nlink > 1) return true;
  t.skip("nlink non rapporté (M-NAV-1)");
  return false;
}

/** Aucune racine de test dans un texte, telle quelle ou échappée en JSON (barres inverses doublées sous Windows). */
function sansRacine(texte: string): void {
  for (const racine of RACINES) {
    for (const forme of [racine, JSON.stringify(racine).slice(1, -1), racine.replaceAll("\\", "/")]) {
      assert.equal(texte.includes(forme), false, `racine présente : ${texte.slice(0, 200)}`);
    }
  }
}

describe("lecteur : liste d'un dossier (§2.8)", () => {
  it("types, tailles, dates ; tri : dossiers d'abord, puis ordre français, nombres dans l'ordre numérique", async () => {
    const racine = nouvelleRacine();
    const date = new Date(1_700_000_000_000);
    fs.utimesSync(ecrire(racine, "proj/b.txt", "abc"), date, date);
    ecrire(racine, "proj/a10.txt");
    ecrire(racine, "proj/a2.txt");
    ecrire(racine, "proj/Été.md");
    dossierVide(racine, "proj/zeta");
    dossierVide(racine, "proj/Alpha");
    dossierVide(racine, "proj/.cache");
    dossierVide(racine, "proj/node_modules");
    const { lecteur } = nouveauLecteur(racine);
    const res = await lecteur.dossier({ projet: "proj", chemin: "" });
    assert.ok(res.ok, JSON.stringify(res));
    assert.deepEqual(
      res.valeur.entrees.map((e) => e.nom),
      [".cache", "Alpha", "node_modules", "zeta", "a2.txt", "a10.txt", "b.txt", "Été.md"],
    );
    const b = res.valeur.entrees.find((e) => e.nom === "b.txt");
    assert.deepEqual(b, { nom: "b.txt", nomVisible: "b.txt", type: "fichier", taille: 3, modifieA: 1_700_000_000_000, cache: false, genere: false });
    const alpha = res.valeur.entrees.find((e) => e.nom === "Alpha");
    assert.equal(alpha?.type, "dossier");
    assert.equal(alpha?.taille, null);
    assert.equal(res.valeur.entrees.find((e) => e.nom === ".cache")?.cache, true);
    assert.equal(res.valeur.entrees.find((e) => e.nom === "node_modules")?.genere, true);
    assert.deepEqual([res.valeur.projet, res.valeur.chemin, res.valeur.masques, res.valeur.tronque], ["proj", "", 0, false]);
  });

  it("au-delà de 1 000 entrées : les 1 000 premières, « tronque »", async () => {
    const racine = nouvelleRacine();
    const grand = dossierVide(racine, "proj/grand");
    for (let i = 0; i <= NAV_BORNES.ENTREES_MAX; i++) fs.writeFileSync(path.join(grand, `f${String(i).padStart(4, "0")}.txt`), "");
    const { lecteur } = nouveauLecteur(racine);
    const res = await lecteur.dossier({ projet: "proj", chemin: "grand" });
    assert.ok(res.ok, JSON.stringify(res));
    assert.equal(res.valeur.entrees.length, NAV_BORNES.ENTREES_MAX);
    assert.equal(res.valeur.tronque, true);
  });

  it("protégés : comptés dans « masques », sans lstat ni nom envoyé ; aucun « .env » dans la réponse", async (t) => {
    const racine = nouvelleRacine();
    for (const nom of [".env", ".env.example", ".git/config", "cle.pfx", "credentials.json", "secrets/x.txt", "README.md", "Get-Token.ps1"]) {
      ecrire(racine, `proj/${nom}`, "x");
    }
    const lstats = espion(t, "lstat");
    const { lecteur } = nouveauLecteur(racine);
    const res = await lecteur.dossier({ projet: "proj", chemin: "" });
    assert.ok(res.ok, JSON.stringify(res));
    assert.equal(res.valeur.masques, 6);
    assert.deepEqual(res.valeur.entrees.map((e) => e.nom), ["Get-Token.ps1", "README.md"]);
    const json = JSON.stringify(res);
    for (const nom of [".env", "cle.pfx", "credentials", ".git", "secrets"]) assert.equal(json.includes(nom), false, nom);
    const proteges = new Set([".env", ".env.example", ".git", "cle.pfx", "credentials.json", "secrets"]);
    assert.deepEqual(lstats.filter((vu) => proteges.has(path.basename(vu))), []);
  });

  it("entrées douteuses (nom court, point ou espace final, contrôle) : montrées « douteux », jamais examinées par lstat", async (t) => {
    const racine = nouvelleRacine();
    // NTFS retire le point et l'espace finals et refuse les caractères de contrôle : ces noms-là ne se créent que sous Linux.
    const douteux = LINUX ? ["x~1", "a.", "b ", "c\u0007"] : ["x~1", "NOTES~2.TXT"];
    for (const nom of douteux) ecrire(racine, `proj/${nom}`, "x");
    ecrire(racine, "proj/sur.txt", "x");
    const lstats = espion(t, "lstat");
    const { lecteur } = nouveauLecteur(racine);
    const res = await lecteur.dossier({ projet: "proj", chemin: "" });
    assert.ok(res.ok, JSON.stringify(res));
    const entrees = res.valeur.entrees;
    for (const nom of douteux) {
      const entree = entrees.find((e) => e.nom === nom);
      assert.deepEqual([entree?.type, entree?.taille, entree?.modifieA], ["douteux", null, null], nom);
    }
    assert.equal(entrees.find((e) => e.nom === "sur.txt")?.type, "fichier");
    assert.deepEqual(lstats.filter((vu) => douteux.includes(path.basename(vu))), []);
    if (LINUX) assert.equal(res.valeur.entrees.find((e) => e.nom === "c\u0007")?.nomVisible, "c⟦U+0007⟧");
  });

  it("racine (projet « ») et dossier %XX montré en lecture (D14 (b)) ; un nom %XX qui contient « secret » reste protégé", async () => {
    const racine = nouvelleRacine();
    ecrire(racine, "a%2F..%2F..%2Fdonnees/note.txt", "bonjour\n");
    ecrire(racine, "a%2F..%2F..%2Fsecret/note.txt", "x");
    const { lecteur } = nouveauLecteur(racine);
    const tout = await lecteur.dossier({ projet: "", chemin: "" });
    assert.ok(tout.ok, JSON.stringify(tout));
    assert.deepEqual(tout.valeur.entrees.map((e) => [e.nom, e.type]), [["a%2F..%2F..%2Fdonnees", "dossier"]]);
    assert.equal(tout.valeur.masques, 1);
    const projet = await lecteur.dossier({ projet: "a%2F..%2F..%2Fdonnees", chemin: "" });
    assert.ok(projet.ok, JSON.stringify(projet));
    assert.deepEqual(projet.valeur.entrees.map((e) => e.nom), ["note.txt"]);
    const texte = await lecteur.contenu({ projet: "a%2F..%2F..%2Fdonnees", chemin: "note.txt" });
    assert.ok(texte.ok, JSON.stringify(texte));
    assert.equal(texte.valeur.texte, "bonjour");
    const parLaRacine = await lecteur.contenu({ projet: "", chemin: "a%2F..%2F..%2Fdonnees/note.txt" });
    assert.ok(parLaRacine.ok, JSON.stringify(parLaRacine));
  });

  it("fichier demandé comme dossier → pas-un-dossier ; absent → introuvable ; projet absent ou fichier → projet-inconnu", async () => {
    const racine = nouvelleRacine();
    ecrire(racine, "proj/a.txt", "x");
    ecrire(racine, "fichier-racine.txt", "x");
    const { lecteur } = nouveauLecteur(racine);
    assert.deepEqual(await lecteur.dossier({ projet: "proj", chemin: "a.txt" }), { ok: false, code: "pas-un-dossier" });
    assert.deepEqual(await lecteur.dossier({ projet: "proj", chemin: "absent" }), { ok: false, code: "introuvable" });
    assert.deepEqual(await lecteur.dossier({ projet: "absent", chemin: "" }), { ok: false, code: "projet-inconnu" });
    assert.deepEqual(await lecteur.dossier({ projet: "fichier-racine.txt", chemin: "" }), { ok: false, code: "projet-inconnu" });
    assert.deepEqual(await lecteur.contenu({ projet: "proj", chemin: "absent/b.txt" }), { ok: false, code: "introuvable" });
  });
});

describe("lecteur : nom exact (G1)", () => {
  it("SCRIPTS/x.ps1 quand le dossier s'appelle scripts → introuvable ; PROJ → projet-inconnu (discriminant sur NTFS)", async () => {
    const racine = nouvelleRacine();
    ecrire(racine, "proj/scripts/x.ps1", "Write-Output 1\n");
    const { lecteur } = nouveauLecteur(racine);
    assert.ok((await lecteur.contenu({ projet: "proj", chemin: "scripts/x.ps1" })).ok);
    assert.deepEqual(await lecteur.contenu({ projet: "proj", chemin: "SCRIPTS/x.ps1" }), { ok: false, code: "introuvable" });
    assert.deepEqual(await lecteur.contenu({ projet: "proj", chemin: "scripts/X.PS1" }), { ok: false, code: "introuvable" });
    assert.deepEqual(await lecteur.contenu({ projet: "proj", chemin: "ſcripts/x.ps1" }), { ok: false, code: "introuvable" });
    assert.deepEqual(await lecteur.dossier({ projet: "proj", chemin: "SCRIPTS" }), { ok: false, code: "introuvable" });
    assert.deepEqual(await lecteur.contenu({ projet: "PROJ", chemin: "scripts/x.ps1" }), { ok: false, code: "projet-inconnu" });
  });
});

describe("lecteur : contenu (§2.7)", () => {
  it("script PowerShell 5.1 (UTF-16LE avec BOM, CRLF) : décodé, mot de passe masqué, taille et date", async () => {
    const racine = nouvelleRacine();
    const texte = '$nom = "é"\r\n$password = "Secr3t!"\r\nWrite-Output $nom\r\n';
    const octets = new Uint8Array([0xff, 0xfe, ...new Uint8Array(new Uint16Array([...texte].map((c) => c.charCodeAt(0))).buffer)]);
    const fichier = ecrire(racine, "proj/scripts/Get-Rapport.ps1", octets);
    const { lecteur } = nouveauLecteur(racine);
    const res = await lecteur.contenu({ projet: "proj", chemin: "scripts/Get-Rapport.ps1" });
    assert.ok(res.ok, JSON.stringify(res));
    assert.equal(res.valeur.etat, "texte");
    assert.equal(res.valeur.encodage, "utf-16le");
    assert.equal(res.valeur.lignes, 3);
    assert.ok(res.valeur.texte?.includes('$nom = "é"'));
    assert.equal(res.valeur.texte?.includes("Secr3t!"), false);
    assert.equal(res.valeur.secretsMasques, true);
    assert.equal(res.valeur.taille, octets.length);
    assert.equal(res.valeur.modifieA, Math.trunc(fs.statSync(fichier).mtimeMs));
    assert.deepEqual([res.valeur.projet, res.valeur.chemin, res.valeur.tronque], ["proj", "scripts/Get-Rapport.ps1", false]);
  });

  it("fichier vide → « vide »", async () => {
    const racine = nouvelleRacine();
    ecrire(racine, "proj/vide.txt", "");
    const { lecteur } = nouveauLecteur(racine);
    const res = await lecteur.contenu({ projet: "proj", chemin: "vide.txt" });
    assert.ok(res.ok, JSON.stringify(res));
    assert.deepEqual([res.valeur.etat, res.valeur.texte, res.valeur.lignes, res.valeur.taille], ["vide", "", 0, 0]);
  });

  it("256 Kio + 1 octet : lecture bornée, « tronque », coupe au dernier saut de ligne", async () => {
    const racine = nouvelleRacine();
    const taille = NAV_BORNES.LECTURE_MAX_OCTETS + 1;
    // Lignes de 64 octets : 4 096 lignes lues, sous la borne de LIGNES_MAX.
    const ligne = `${"x".repeat(63)}\n`;
    const texte = ligne.repeat(Math.ceil(taille / ligne.length)).slice(0, taille);
    ecrire(racine, "proj/gros.log", texte);
    const { lecteur } = nouveauLecteur(racine);
    const res = await lecteur.contenu({ projet: "proj", chemin: "gros.log" });
    assert.ok(res.ok, JSON.stringify(res));
    assert.equal(res.valeur.tronque, true);
    assert.equal(res.valeur.taille, taille);
    assert.equal(res.valeur.lignes, NAV_BORNES.LECTURE_MAX_OCTETS / ligne.length);
  });

  it("binaire par extension : jamais ouvert (ni crochet « apres-controle », ni open)", async (t) => {
    const racine = nouvelleRacine();
    ecrire(racine, "proj/image.png", "texte lisible, mais extension binaire");
    const moments: MomentLecteur[] = [];
    const ouvertures = espion(t, "open");
    const { lecteur } = nouveauLecteur(racine, { pendant: (moment) => void moments.push(moment) });
    const res = await lecteur.contenu({ projet: "proj", chemin: "image.png" });
    assert.ok(res.ok, JSON.stringify(res));
    assert.deepEqual([res.valeur.etat, res.valeur.texte, res.valeur.encodage], ["binaire", null, null]);
    assert.equal(res.valeur.taille, 37);
    assert.deepEqual(moments, []);
    assert.deepEqual(ouvertures, []);
  });

  it("binaire par contenu (octet NUL) → « binaire », texte null", async () => {
    const racine = nouvelleRacine();
    ecrire(racine, "proj/donnees.txt", new Uint8Array([0x41, 0x00, 0x42, 0x43]));
    const { lecteur } = nouveauLecteur(racine);
    const res = await lecteur.contenu({ projet: "proj", chemin: "donnees.txt" });
    assert.ok(res.ok, JSON.stringify(res));
    assert.deepEqual([res.valeur.etat, res.valeur.texte], ["binaire", null]);
  });

  it("dossier demandé comme fichier → pas-un-fichier", async () => {
    const racine = nouvelleRacine();
    dossierVide(racine, "proj/sous");
    const { lecteur } = nouveauLecteur(racine);
    assert.deepEqual(await lecteur.contenu({ projet: "proj", chemin: "sous" }), { ok: false, code: "pas-un-fichier" });
  });

  it("règles pures et protection AVANT le disque : .env présent ou absent → même refus, sans opendir, lstat ni open", async (t) => {
    const racine = nouvelleRacine();
    ecrire(racine, "proj/.env", "SECRET=1");
    const espions = [espion(t, "opendir"), espion(t, "lstat"), espion(t, "open")];
    const vus = () => espions.reduce((n, liste) => n + liste.length, 0);
    const { lecteur } = nouveauLecteur(racine);
    const present = await lecteur.contenu({ projet: "proj", chemin: ".env" });
    const absent = await lecteur.contenu({ projet: "autre", chemin: ".env" });
    assert.deepEqual(present, { ok: false, code: "protege" });
    assert.deepEqual(absent, present);
    assert.deepEqual(await lecteur.dossier({ projet: "proj", chemin: ".git" }), { ok: false, code: "protege" });
    assert.deepEqual(await lecteur.dossier({ projet: "secrets", chemin: "" }), { ok: false, code: "protege" });
    for (const chemin of ["../x", "a/../b", "a\\b", "a:b", "a\u0000b", "/etc/passwd", "a//b", ""]) {
      assert.deepEqual(await lecteur.contenu({ projet: "proj", chemin }), { ok: false, code: "invalide" }, JSON.stringify(chemin));
    }
    assert.deepEqual(await lecteur.recherche({ projet: "proj", texte: "" }), { ok: false, code: "invalide" });
    assert.deepEqual(await lecteur.recherche({ projet: "proj", texte: "x".repeat(101) }), { ok: false, code: "invalide" });
    assert.deepEqual(await lecteur.recents({ projet: ".cache" }), { ok: false, code: "invalide" });
    assert.equal(vus(), 0);
    assert.deepEqual(reglesDemande("contenu", { projet: "proj", chemin: "a/b.txt" }), { ok: true, S: ["proj", "a", "b.txt"], avecProjet: true });
    assert.deepEqual(reglesDemande("dossier", { projet: "", chemin: "" }), { ok: true, S: [], avecProjet: false });
  });
});

describe("lecteur : liens symboliques [L]", () => {
  it("feuille liée à /proc/self/environ → lien, aucune variable d'environnement dans la réponse", L, async () => {
    const racine = nouvelleRacine();
    dossierVide(racine, "proj");
    fs.symlinkSync("/proc/self/environ", path.join(racine, "proj", "lien-environ.txt"));
    const { lecteur } = nouveauLecteur(racine);
    const res = await lecteur.contenu({ projet: "proj", chemin: "lien-environ.txt" });
    assert.deepEqual(res, { ok: false, code: "lien" });
    const json = JSON.stringify(res);
    for (const valeur of Object.values(process.env)) if (valeur !== undefined && valeur.length >= 8) assert.equal(json.includes(valeur), false);
  });

  it("feuille liée hors de la racine → lien ; feuille liée à .env du même projet → lien", L, async () => {
    const racine = nouvelleRacine();
    const dehors = ecrire(nouvelleRacine(), "secret.txt", "SECRET_EXTERIEUR");
    ecrire(racine, "proj/.env", "SECRET=1");
    fs.symlinkSync(dehors, path.join(racine, "proj", "lien-dehors.txt"));
    fs.symlinkSync(".env", path.join(racine, "proj", "lien-env.txt"));
    const { lecteur } = nouveauLecteur(racine);
    assert.deepEqual(await lecteur.contenu({ projet: "proj", chemin: "lien-dehors.txt" }), { ok: false, code: "lien" });
    assert.deepEqual(await lecteur.contenu({ projet: "proj", chemin: "lien-env.txt" }), { ok: false, code: "lien" });
  });

  it("dossier intermédiaire lié → lien (contenu et liste) ; projet lié → lien", L, async () => {
    const racine = nouvelleRacine();
    const dehors = nouvelleRacine();
    ecrire(dehors, "f.txt", "SECRET_EXTERIEUR");
    dossierVide(racine, "proj");
    fs.symlinkSync(dehors, path.join(racine, "proj", "sous"));
    fs.symlinkSync(dehors, path.join(racine, "projet-lie"));
    const { lecteur } = nouveauLecteur(racine);
    assert.deepEqual(await lecteur.contenu({ projet: "proj", chemin: "sous/f.txt" }), { ok: false, code: "lien" });
    assert.deepEqual(await lecteur.dossier({ projet: "proj", chemin: "sous" }), { ok: false, code: "lien" });
    assert.deepEqual(await lecteur.dossier({ projet: "projet-lie", chemin: "" }), { ok: false, code: "lien" });
  });

  it("dans une liste : type « lien », sans taille ni cible", L, async () => {
    const racine = nouvelleRacine();
    dossierVide(racine, "proj");
    fs.symlinkSync("/proc/self/environ", path.join(racine, "proj", "lien-environ.txt"));
    const { lecteur } = nouveauLecteur(racine);
    const res = await lecteur.dossier({ projet: "proj", chemin: "" });
    assert.ok(res.ok, JSON.stringify(res));
    assert.deepEqual(res.valeur.entrees.map((e) => [e.nom, e.type, e.taille]), [["lien-environ.txt", "lien", null]]);
    assert.equal(JSON.stringify(res).includes("/proc"), false);
  });
});

describe("lecteur : courses (crochet pendant)", () => {
  it("(1) [L] après le contrôle, la feuille devient un lien vers un secret extérieur → lien (O_NOFOLLOW)", L, async () => {
    const racine = nouvelleRacine();
    const feuille = ecrire(racine, "proj/f.txt", "ordinaire");
    const dehors = ecrire(nouvelleRacine(), "secret.txt", "SECRET_EXTERIEUR");
    const { lecteur } = nouveauLecteur(racine, {
      pendant: (moment) => {
        if (moment !== "apres-controle") return;
        const provisoire = `${feuille}.lien`;
        fs.symlinkSync(dehors, provisoire);
        fs.renameSync(provisoire, feuille);
      },
    });
    assert.deepEqual(await lecteur.contenu({ projet: "proj", chemin: "f.txt" }), { ok: false, code: "lien" });
  });

  it("(2) [L] après le contrôle, le dossier parent devient un lien vers un autre dossier du projet (fichier de même nom) → a-change", L, async () => {
    const racine = nouvelleRacine();
    ecrire(racine, "proj/a/f.txt", "A");
    ecrire(racine, "proj/b/f.txt", "B");
    const a = path.join(racine, "proj", "a");
    const { lecteur } = nouveauLecteur(racine, {
      pendant: (moment) => {
        if (moment !== "apres-controle") return;
        fs.renameSync(a, `${a}-ancien`);
        fs.symlinkSync("b", a);
      },
    });
    assert.deepEqual(await lecteur.contenu({ projet: "proj", chemin: "a/f.txt" }), { ok: false, code: "a-change" });
  });

  it("(2 bis) [L] le dossier parent, déplacé sous un nom protégé, est remplacé par un lien : même fichier, autre chemin réel → a-change (A1)", L, async () => {
    const racine = nouvelleRacine();
    ecrire(racine, "proj/a/f.txt", "même fichier");
    const a = path.join(racine, "proj", "a");
    const { lecteur } = nouveauLecteur(racine, {
      pendant: (moment) => {
        if (moment !== "apres-controle") return;
        fs.renameSync(a, path.join(racine, "proj", "secrets"));
        fs.symlinkSync("secrets", a);
      },
    });
    assert.deepEqual(await lecteur.contenu({ projet: "proj", chemin: "a/f.txt" }), { ok: false, code: "a-change" });
  });

  it("(3) le fichier est allongé pendant la lecture → a-change (fstat final)", async () => {
    const racine = nouvelleRacine();
    const fichier = ecrire(racine, "proj/journal.log", "ligne 1\n");
    const { lecteur } = nouveauLecteur(racine, {
      pendant: (moment) => {
        if (moment === "pendant-lecture") fs.appendFileSync(fichier, "ligne 2\n");
      },
    });
    assert.deepEqual(await lecteur.contenu({ projet: "proj", chemin: "journal.log" }), { ok: false, code: "a-change" });
  });

  it("(4) [L] après le contrôle, la feuille devient un tube → pas-un-fichier en moins d'une seconde (O_NONBLOCK)", L, async () => {
    const racine = nouvelleRacine();
    const feuille = ecrire(racine, "proj/f.txt", "ordinaire");
    const { lecteur } = nouveauLecteur(racine, {
      pendant: (moment) => {
        if (moment !== "apres-controle") return;
        fs.rmSync(feuille);
        tube(feuille);
      },
    });
    const debut = performance.now();
    const promesse = lecteur.contenu({ projet: "proj", chemin: "f.txt" });
    let delai: ReturnType<typeof setTimeout> | undefined;
    const expire = new Promise<"expire">((resolve) => {
      delai = setTimeout(() => resolve("expire"), 1_000);
    });
    const issue = await Promise.race([promesse, expire]);
    clearTimeout(delai);
    if (issue === "expire") {
      // Ouverture bloquée en attente d'un écrivain : débloquée pour finir proprement, puis échec.
      fs.closeSync(fs.openSync(feuille, fs.constants.O_WRONLY | fs.constants.O_NONBLOCK));
      await promesse;
      assert.fail("ouverture bloquée sur un tube");
    }
    assert.deepEqual(issue, { ok: false, code: "pas-un-fichier" });
    assert.ok(performance.now() - debut < 1_000);
  });

  it("(5) [L] après la liste, le dossier listé devient un lien → a-change, liste jetée", L, async () => {
    const racine = nouvelleRacine();
    ecrire(racine, "proj/a/f.txt", "A");
    ecrire(racine, "proj/b/g.txt", "B");
    const a = path.join(racine, "proj", "a");
    const { lecteur } = nouveauLecteur(racine, {
      pendant: (moment) => {
        if (moment !== "apres-liste") return;
        fs.renameSync(a, `${a}-ancien`);
        fs.symlinkSync("b", a);
      },
    });
    assert.deepEqual(await lecteur.dossier({ projet: "proj", chemin: "a" }), { ok: false, code: "a-change" });
  });

  it("(6) [L] aller-retour pendant la liste : dossier remplacé par un lien vers un dossier extérieur, puis remis → a-change, aucun nom extérieur", L, async () => {
    // Relecture F2-vague-5 : les mêmes dev et ino reviennent avec le vrai dossier, la revérification seule ne voit rien.
    const racine = nouvelleRacine();
    ecrire(racine, "proj/d/vrai.txt", "V");
    const dehors = nouvelleRacine();
    ecrire(dehors, "cockpit.db", "0123456789");
    ecrire(dehors, "session-7f3a.json", "{}");
    const d = path.join(racine, "proj", "d");
    const { lecteur } = nouveauLecteur(racine, {
      pendant: (moment) => {
        if (moment === "apres-controle") {
          fs.renameSync(d, `${d}.bak`);
          fs.symlinkSync(dehors, d);
        } else if (moment === "apres-liste") {
          fs.unlinkSync(d);
          fs.renameSync(`${d}.bak`, d);
        }
      },
    });
    const res = await lecteur.dossier({ projet: "proj", chemin: "d" });
    const json = JSON.stringify(res);
    for (const nom of ["cockpit.db", "session-7f3a"]) assert.equal(json.includes(nom), false, json);
    assert.deepEqual(res, { ok: false, code: "a-change" });
  });

  it("(7) [L] aller-retour après l'ouverture du dossier : il est lu par son descripteur (/proc/self/fd), seulement ses vrais noms", L, async () => {
    const racine = nouvelleRacine();
    ecrire(racine, "proj/d/vrai.txt", "V");
    const dehors = nouvelleRacine();
    ecrire(dehors, "cockpit.db", "0123456789");
    const d = path.join(racine, "proj", "d");
    let pose = false;
    const moments: MomentLecteur[] = [];
    const { lecteur } = nouveauLecteur(racine, {
      pendant: (moment) => {
        moments.push(moment);
        if (moment === "apres-ouverture") {
          fs.renameSync(d, `${d}.bak`);
          fs.symlinkSync(dehors, d);
          pose = true;
        } else if (moment === "apres-liste" && pose) {
          fs.unlinkSync(d);
          fs.renameSync(`${d}.bak`, d);
          pose = false;
        }
      },
    });
    const res = await lecteur.dossier({ projet: "proj", chemin: "d" });
    assert.equal(JSON.stringify(res).includes("cockpit.db"), false, JSON.stringify(res));
    if (MONTAGE && !res.ok) {
      // Montage 9p : le descripteur du dossier déplacé ne se relit plus → refus, aucun nom extérieur.
      assert.deepEqual(res, { ok: false, code: "illisible" });
      return;
    }
    assert.ok(res.ok, JSON.stringify(res));
    assert.deepEqual(res.valeur.entrees.map((e) => [e.nom, e.type, e.taille]), [["vrai.txt", "fichier", 1]]);
    assert.deepEqual(moments, ["apres-controle", "apres-ouverture", "apres-liste"]);
  });

  it("(8) aller-retour pendant la liste avec un autre vrai dossier (.git mis à la place, puis remis) → a-change, aucun de ses noms (dev et ino au fstat)", async () => {
    const racine = nouvelleRacine();
    ecrire(racine, "proj/d/vrai.txt", "V");
    ecrire(racine, "proj/.git/HEAD", "ref: refs/heads/main\n");
    ecrire(racine, "proj/.git/config", "[core]\n");
    const d = path.join(racine, "proj", "d");
    const git = path.join(racine, "proj", ".git");
    const { lecteur } = nouveauLecteur(racine, {
      pendant: (moment) => {
        if (moment === "apres-controle") {
          fs.renameSync(d, `${d}.bak`);
          fs.renameSync(git, d);
        } else if (moment === "apres-liste") {
          fs.renameSync(d, git);
          fs.renameSync(`${d}.bak`, d);
        }
      },
    });
    const res = await lecteur.dossier({ projet: "proj", chemin: "d" });
    const json = JSON.stringify(res);
    for (const nom of ["HEAD", "config"]) assert.equal(json.includes(nom), false, json);
    assert.deepEqual(res, { ok: false, code: "a-change" });
  });

  it("(9) [L] aller-retour du dossier parent, déplacé sous un nom protégé et remplacé par un lien, puis remis → a-change (A1, chemin réel du descripteur)", L, async () => {
    const racine = nouvelleRacine();
    ecrire(racine, "proj/a/sous/note.txt", "x");
    const a = path.join(racine, "proj", "a");
    const secrets = path.join(racine, "proj", "secrets");
    const { lecteur } = nouveauLecteur(racine, {
      pendant: (moment) => {
        if (moment === "apres-controle") {
          fs.renameSync(a, secrets);
          fs.symlinkSync("secrets", a);
        } else if (moment === "apres-liste") {
          fs.unlinkSync(a);
          fs.renameSync(secrets, a);
        }
      },
    });
    assert.deepEqual(await lecteur.dossier({ projet: "proj", chemin: "a/sous" }), { ok: false, code: "a-change" });
  });

  it("après le contrôle, la feuille est remplacée par un autre fichier ordinaire → a-change (dev et ino)", async () => {
    const racine = nouvelleRacine();
    const feuille = ecrire(racine, "proj/f.txt", "vrai");
    const autre = ecrire(racine, "proj/autre.txt", "remplaçant");
    const { lecteur } = nouveauLecteur(racine, {
      pendant: (moment) => {
        if (moment === "apres-controle") fs.renameSync(autre, feuille);
      },
    });
    assert.deepEqual(await lecteur.contenu({ projet: "proj", chemin: "f.txt" }), { ok: false, code: "a-change" });
  });

  it("après le contrôle, un lien physique est ajouté à la feuille → plusieurs-noms (fstat)", async (t) => {
    const racine = nouvelleRacine();
    const feuille = ecrire(racine, "proj/f.txt", "texte");
    const essai = ecrire(racine, "essai/a.txt", "x");
    if (!lienPhysique(t, essai, path.join(racine, "essai", "b.txt"))) return;
    const { lecteur } = nouveauLecteur(racine, {
      pendant: (moment) => {
        if (moment === "apres-controle") fs.linkSync(feuille, path.join(racine, "proj", "double.txt"));
      },
    });
    assert.deepEqual(await lecteur.contenu({ projet: "proj", chemin: "f.txt" }), { ok: false, code: "plusieurs-noms" });
  });
});

describe("lecteur : liens physiques", () => {
  it("lien physique → plusieurs-noms avant toute ouverture, même pour une extension binaire", async (t) => {
    const racine = nouvelleRacine();
    const original = ecrire(racine, "proj/original.txt", "texte");
    if (!lienPhysique(t, original, path.join(racine, "proj", "double.txt"))) return;
    fs.linkSync(ecrire(racine, "proj/image.png", "x"), path.join(racine, "proj", "double.png"));
    const ouvertures = espion(t, "open");
    const { lecteur } = nouveauLecteur(racine);
    for (const chemin of ["double.txt", "original.txt", "double.png", "image.png"]) {
      assert.deepEqual(await lecteur.contenu({ projet: "proj", chemin }), { ok: false, code: "plusieurs-noms" }, chemin);
    }
    assert.deepEqual(ouvertures, []);
  });
});

describe("lecteur : tubes [L]", () => {
  it("tube : type « autre » dans la liste ; contenu → pas-un-fichier sans blocage", L, async () => {
    const racine = nouvelleRacine();
    dossierVide(racine, "proj");
    tube(path.join(racine, "proj", "tube"));
    const { lecteur } = nouveauLecteur(racine);
    const liste = await lecteur.dossier({ projet: "proj", chemin: "" });
    assert.ok(liste.ok, JSON.stringify(liste));
    assert.deepEqual(liste.valeur.entrees.map((e) => [e.nom, e.type, e.taille]), [["tube", "autre", null]]);
    const debut = performance.now();
    assert.deepEqual(await lecteur.contenu({ projet: "proj", chemin: "tube" }), { ok: false, code: "pas-un-fichier" });
    assert.ok(performance.now() - debut < 1_000);
  });
});

describe("lecteur : erreurs et journal (A5, §2.10)", () => {
  it("[L] fichier sans droit de lecture → illisible ; le journal ne dit que la nature de l'erreur", L, async (t) => {
    const racine = nouvelleRacine();
    const fichier = ecrire(racine, "proj/ferme.txt", "x");
    try {
      fs.chmodSync(fichier, 0o000);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "EPERM") return t.skip("droits non modifiables ici (EPERM)");
      throw err;
    }
    try {
      fs.closeSync(fs.openSync(fichier, "r"));
      return t.skip("droits non appliqués : processus privilégié (EPERM attendu)");
    } catch {
      // Lecture refusée par le système, comme attendu.
    }
    const { lecteur, lignes } = nouveauLecteur(racine);
    assert.deepEqual(await lecteur.contenu({ projet: "proj", chemin: "ferme.txt" }), { ok: false, code: "illisible" });
    assert.deepEqual(lignes, [{ message: "fichiers : lecture impossible", champs: { projet: "proj", code: "illisible", nature: "EACCES" } }]);
  });

  it("refus révélateurs : une ligne par minute et par code, avec le seul projet (jamais un chemin ni un nom)", async (t) => {
    const racine = nouvelleRacine();
    const original = ecrire(racine, "proj/original.txt", "texte");
    if (!lienPhysique(t, original, path.join(racine, "proj", "double.txt"))) return;
    let horloge = 0;
    const { lecteur, lignes } = nouveauLecteur(racine, { maintenant: () => horloge });
    const refus = { ok: false, code: "plusieurs-noms" };
    assert.deepEqual(await lecteur.contenu({ projet: "proj", chemin: "double.txt" }), refus);
    horloge = 1_000;
    assert.deepEqual(await lecteur.contenu({ projet: "proj", chemin: "original.txt" }), refus);
    assert.equal(lignes.length, 1);
    horloge = NAV_BORNES.JOURNAL_INTERVALLE_MS + 1;
    assert.deepEqual(await lecteur.contenu({ projet: "proj", chemin: "double.txt" }), refus);
    assert.deepEqual(lignes, [
      { message: "fichiers : refus", champs: { projet: "proj", code: "plusieurs-noms" } },
      { message: "fichiers : refus", champs: { projet: "proj", code: "plusieurs-noms" } },
    ]);
  });

  it("aucune réponse ne contient la racine absolue", async () => {
    const racine = nouvelleRacine();
    ecrire(racine, "proj/scripts/a.ps1", "Write-Output 1\n");
    const { lecteur } = nouveauLecteur(racine);
    const reponses = [
      await lecteur.dossier({ projet: "", chemin: "" }),
      await lecteur.dossier({ projet: "proj", chemin: "scripts" }),
      await lecteur.contenu({ projet: "proj", chemin: "scripts/a.ps1" }),
      await lecteur.contenu({ projet: "proj", chemin: "absent.txt" }),
      await lecteur.recents({ projet: "proj" }),
      await lecteur.recherche({ projet: "", texte: "a" }),
    ];
    for (const reponse of reponses) sansRacine(JSON.stringify(reponse));
    assert.ok(reponses.filter((r) => r.ok).length >= 5);
  });
});

describe("lecteur : parcours (récents, recherche)", () => {
  it("récents : les plus récents d'abord ; node_modules, .git, protégés (et liens, sous Linux) jamais parcourus", async () => {
    const racine = nouvelleRacine();
    const date = (s: number) => new Date(1_700_000_000_000 + s * 1_000);
    const poser = (relatif: string, s: number) => fs.utimesSync(ecrire(racine, `proj/${relatif}`, "x"), date(s), date(s));
    poser("a.txt", 1);
    poser("sous/profond/c.md", 2);
    poser("sous/b.ps1", 3);
    poser("node_modules/paquet/index.js", 4);
    poser(".git/HEAD", 5);
    poser(".env", 6);
    poser("secrets/y.txt", 7);
    if (LINUX) {
      const dehors = nouvelleRacine();
      fs.utimesSync(ecrire(dehors, "z.txt", "x"), date(8), date(8));
      fs.symlinkSync(dehors, path.join(racine, "proj", "lien"));
    }
    const { lecteur } = nouveauLecteur(racine);
    const res = await lecteur.recents({ projet: "proj" });
    assert.ok(res.ok, JSON.stringify(res));
    assert.deepEqual(res.valeur.fichiers.map((f) => f.chemin), ["sous/b.ps1", "sous/profond/c.md", "a.txt"]);
    assert.deepEqual(res.valeur.fichiers[0], { chemin: "sous/b.ps1", taille: 1, modifieA: date(3).getTime() });
    assert.equal(res.valeur.incomplet, false);
    assert.equal(res.valeur.projet, "proj");
  });

  it("récents : 30 au plus", async () => {
    const racine = nouvelleRacine();
    for (let i = 0; i < 35; i++) {
      const d = new Date(1_700_000_000_000 + i * 1_000);
      fs.utimesSync(ecrire(racine, `proj/f${i}.txt`, "x"), d, d);
    }
    const { lecteur } = nouveauLecteur(racine);
    const res = await lecteur.recents({ projet: "proj" });
    assert.ok(res.ok, JSON.stringify(res));
    assert.equal(res.valeur.fichiers.length, NAV_BORNES.RECENTS_MAX);
    assert.equal(res.valeur.fichiers[0]?.chemin, "f34.txt");
  });

  it("recherche : sur le nom seulement, casse et accents ignorés, dossiers et fichiers ; aucun fichier ouvert", async (t) => {
    const racine = nouvelleRacine();
    ecrire(racine, "proj/Résumé.md", "profond");
    ecrire(racine, "proj/sous/profond/Profond.ps1", "x");
    ecrire(racine, "proj/notes.txt", "le mot profond est ici, dans le contenu");
    const ouvertures = espionOuvertures(t);
    const { lecteur } = nouveauLecteur(racine);
    const res = await lecteur.recherche({ projet: "proj", texte: "PROFOND" });
    assert.ok(res.ok, JSON.stringify(res));
    assert.deepEqual(res.valeur.resultats, [
      { chemin: "sous/profond", type: "dossier" },
      { chemin: "sous/profond/Profond.ps1", type: "fichier" },
    ]);
    const accents = await lecteur.recherche({ projet: "proj", texte: "resume" });
    assert.ok(accents.ok, JSON.stringify(accents));
    assert.deepEqual(accents.valeur.resultats, [{ chemin: "Résumé.md", type: "fichier" }]);
    assert.equal(accents.valeur.texte, "resume");
    // Aucun fichier ouvert : seuls les dossiers parcourus le sont, pour être lus par leur descripteur (relecture F2-vague-5) ;
    // sous Linux, O_DIRECTORY fait refuser au noyau tout ce qui n'est pas un dossier, O_NOFOLLOW tout lien.
    for (const { chemin, drapeaux } of ouvertures) {
      assert.equal(fs.lstatSync(chemin).isDirectory(), true, chemin);
      assert.equal(["Résumé.md", "Profond.ps1", "notes.txt"].includes(path.basename(chemin)), false, chemin);
      if (LINUX) {
        assert.equal(drapeaux & fs.constants.O_DIRECTORY, fs.constants.O_DIRECTORY, chemin);
        assert.equal(drapeaux & fs.constants.O_NOFOLLOW, fs.constants.O_NOFOLLOW, chemin);
        assert.equal(drapeaux & (fs.constants.O_WRONLY | fs.constants.O_RDWR), 0, chemin);
      }
    }
  });

  it("borne de 5 000 entrées → incomplet", async () => {
    const racine = nouvelleRacine();
    const grand = dossierVide(racine, "proj/grand");
    for (let i = 0; i < NAV_BORNES.PARCOURS_ENTREES_MAX + 10; i++) fs.writeFileSync(path.join(grand, `f${i}.txt`), "");
    const { lecteur } = nouveauLecteur(racine);
    const res = await lecteur.recents({ projet: "proj" });
    assert.ok(res.ok, JSON.stringify(res));
    assert.equal(res.valeur.parcourus, NAV_BORNES.PARCOURS_ENTREES_MAX);
    assert.equal(res.valeur.incomplet, true);
  });

  it("borne de 12 niveaux → incomplet ; rien n'est lu sous le 12e niveau", async () => {
    const racine = nouvelleRacine();
    const niveaux = Array.from({ length: 13 }, (_, i) => `d${i + 1}`);
    ecrire(racine, `proj/${niveaux.slice(0, 11).join("/")}/vu.txt`, "x");
    ecrire(racine, `proj/${niveaux.slice(0, 12).join("/")}/cache-trop-bas.txt`, "x");
    ecrire(racine, `proj/${niveaux.join("/")}/encore-plus-bas.txt`, "x");
    const { lecteur } = nouveauLecteur(racine);
    const res = await lecteur.recents({ projet: "proj" });
    assert.ok(res.ok, JSON.stringify(res));
    assert.deepEqual(res.valeur.fichiers.map((f) => path.posix.basename(f.chemin)), ["vu.txt"]);
    assert.equal(res.valeur.incomplet, true);
  });

  it("borne de 2 s (horloge injectée) → incomplet", async () => {
    const racine = nouvelleRacine();
    for (let i = 0; i < 40; i++) ecrire(racine, `proj/f${i}.txt`, "x");
    let horloge = 0;
    const { lecteur } = nouveauLecteur(racine, {
      maintenant: () => {
        horloge += 150;
        return horloge;
      },
    });
    const res = await lecteur.recherche({ projet: "proj", texte: "f" });
    assert.ok(res.ok, JSON.stringify(res));
    assert.equal(res.valeur.incomplet, true);
    assert.ok(res.valeur.parcourus < 40, `${res.valeur.parcourus} entrées parcourues`);
  });

  it("recherche : 100 résultats au plus → incomplet", async () => {
    const racine = nouvelleRacine();
    for (let i = 0; i < NAV_BORNES.RESULTATS_MAX + 5; i++) ecrire(racine, `proj/cle-${i}.md`, "x");
    const { lecteur } = nouveauLecteur(racine);
    const res = await lecteur.recherche({ projet: "proj", texte: "cle-" });
    assert.ok(res.ok, JSON.stringify(res));
    assert.equal(res.valeur.resultats.length, NAV_BORNES.RESULTATS_MAX);
    assert.equal(res.valeur.incomplet, true);
  });

  it("un seul parcours à la fois : un second pendant un premier → occupe ; libre ensuite", async () => {
    const racine = nouvelleRacine();
    ecrire(racine, "proj/a.txt", "x");
    const tenue = barriere();
    let atteint = false;
    let premier = true;
    const { lecteur } = nouveauLecteur(racine, {
      pendant: async (moment) => {
        if (moment !== "apres-controle" || !premier) return;
        premier = false;
        atteint = true;
        await tenue.ouverte;
      },
    });
    const enCours = lecteur.recents({ projet: "proj" });
    await jusqua(() => atteint);
    assert.deepEqual(await lecteur.recherche({ projet: "proj", texte: "a" }), { ok: false, code: "occupe" });
    assert.deepEqual(await lecteur.recents({ projet: "" }), { ok: false, code: "occupe" });
    tenue.ouvrir();
    assert.ok((await enCours).ok);
    assert.ok((await lecteur.recherche({ projet: "proj", texte: "a" })).ok);
  });

  it("[L] dossier remplacé par un lien pendant le parcours : ses noms sont jetés, parcours incomplet", L, async () => {
    const racine = nouvelleRacine();
    ecrire(racine, "proj/a/dedans.txt", "x");
    const dehors = nouvelleRacine();
    ecrire(dehors, "nom-exterieur.txt", "x");
    const a = path.join(racine, "proj", "a");
    let dossiers = 0;
    const { lecteur } = nouveauLecteur(racine, {
      pendant: (moment) => {
        if (moment !== "parcours-dossier") return;
        dossiers++;
        // Deuxième dossier lu : « a », découvert par lstat dans « proj », remplacé avant sa lecture.
        if (dossiers === 2) {
          fs.renameSync(a, `${a}-ancien`);
          fs.symlinkSync(dehors, a);
        }
      },
    });
    const res = await lecteur.recents({ projet: "proj" });
    assert.ok(res.ok, JSON.stringify(res));
    assert.equal(JSON.stringify(res).includes("nom-exterieur"), false);
    assert.equal(res.valeur.incomplet, true);
  });

  it("[L] aller-retour pendant le parcours : dossier remplacé par un lien vers un dossier extérieur, remis juste avant sa revérification → aucun nom extérieur", L, async (t) => {
    // Relecture F2-vague-5 : la revérification par lstat retrouve les mêmes dev et ino, elle seule ne voit rien.
    const racine = nouvelleRacine();
    ecrire(racine, "proj/a/dedans.txt", "x");
    const dehors = nouvelleRacine();
    ecrire(dehors, "nom-exterieur.txt", "0123456789");
    const a = path.join(fs.realpathSync.native(racine), "proj", "a");
    const course = remiseAvantReverification(t, a);
    let dossiers = 0;
    const { lecteur } = nouveauLecteur(racine, {
      pendant: (moment) => {
        if (moment !== "parcours-dossier") return;
        dossiers++;
        // Deuxième dossier lu : « a », remplacé avant sa lecture.
        if (dossiers === 2) course.versLien(dehors);
      },
    });
    const res = await lecteur.recents({ projet: "proj" });
    assert.ok(res.ok, JSON.stringify(res));
    assert.equal(JSON.stringify(res).includes("nom-exterieur"), false, JSON.stringify(res));
    assert.equal(res.valeur.incomplet, true);
  });

  it("aller-retour pendant le parcours avec un autre vrai dossier (.git mis à la place, remis avant la revérification) → ses noms jamais montrés (dev et ino au fstat)", async (t) => {
    const racine = nouvelleRacine();
    ecrire(racine, "proj/a/dedans.txt", "x");
    ecrire(racine, "proj/.git/HEAD", "ref: refs/heads/main\n");
    ecrire(racine, "proj/.git/config", "[core]\n");
    const reelle = fs.realpathSync.native(racine);
    const course = remiseAvantReverification(t, path.join(reelle, "proj", "a"));
    let dossiers = 0;
    const { lecteur } = nouveauLecteur(racine, {
      pendant: (moment) => {
        if (moment !== "parcours-dossier") return;
        dossiers++;
        if (dossiers === 2) course.versDossier(path.join(reelle, "proj", ".git"));
      },
    });
    const res = await lecteur.recents({ projet: "proj" });
    assert.ok(res.ok, JSON.stringify(res));
    for (const nom of ["HEAD", "config"]) assert.equal(JSON.stringify(res).includes(nom), false, JSON.stringify(res));
    assert.equal(res.valeur.incomplet, true);
  });

  it("[L] aller-retour après l'ouverture d'un dossier parcouru : il est lu par son descripteur, seulement ses vrais noms", L, async (t) => {
    const racine = nouvelleRacine();
    ecrire(racine, "proj/a/dedans.txt", "x");
    const dehors = nouvelleRacine();
    ecrire(dehors, "nom-exterieur.txt", "0123456789");
    const a = path.join(fs.realpathSync.native(racine), "proj", "a");
    const course = remiseAvantReverification(t, a);
    let ouverts = 0;
    const { lecteur } = nouveauLecteur(racine, {
      pendant: (moment) => {
        if (moment !== "apres-ouverture") return;
        ouverts++;
        // Deuxième dossier ouvert : « a », remplacé entre son ouverture et sa lecture.
        if (ouverts === 2) course.versLien(dehors);
      },
    });
    const res = await lecteur.recents({ projet: "proj" });
    assert.ok(res.ok, JSON.stringify(res));
    assert.equal(ouverts, 2);
    assert.equal(JSON.stringify(res).includes("nom-exterieur"), false, JSON.stringify(res));
    if (MONTAGE && res.valeur.fichiers.length === 0) {
      // Montage 9p : le dossier déplacé ne se relit plus par son descripteur → sauté, parcours dit incomplet.
      assert.equal(res.valeur.incomplet, true);
      return;
    }
    assert.deepEqual(res.valeur.fichiers.map((f) => f.chemin), ["a/dedans.txt"]);
    assert.equal(res.valeur.incomplet, false);
  });
});

describe("lecteur : sémaphore (G6)", () => {
  it("deux lectures tenues : la troisième → occupe après l'attente injectée ; place rendue ensuite", async () => {
    const racine = nouvelleRacine();
    for (const nom of ["f1.txt", "f2.txt", "f3.txt"]) ecrire(racine, `proj/${nom}`, "x");
    const tenue = barriere();
    let tenues = 0;
    const attentes: number[] = [];
    const { lecteur } = nouveauLecteur(racine, {
      attendre: async (ms) => void attentes.push(ms),
      pendant: async (moment) => {
        if (moment !== "apres-controle") return;
        tenues++;
        await tenue.ouverte;
      },
    });
    const premiere = lecteur.contenu({ projet: "proj", chemin: "f1.txt" });
    const deuxieme = lecteur.contenu({ projet: "proj", chemin: "f2.txt" });
    await jusqua(() => tenues === 2);
    assert.deepEqual(await lecteur.contenu({ projet: "proj", chemin: "f3.txt" }), { ok: false, code: "occupe" });
    assert.deepEqual(await lecteur.dossier({ projet: "proj", chemin: "" }), { ok: false, code: "occupe" });
    assert.deepEqual(attentes, [NAV_BORNES.ATTENTE_PLACE_MS, NAV_BORNES.ATTENTE_PLACE_MS]);
    tenue.ouvrir();
    assert.ok((await premiere).ok);
    assert.ok((await deuxieme).ok);
    assert.ok((await lecteur.contenu({ projet: "proj", chemin: "f3.txt" })).ok);
  });

  it("place rendue pendant l'attente : la lecture en attente est servie", async () => {
    const racine = nouvelleRacine();
    for (const nom of ["f1.txt", "f2.txt", "f3.txt"]) ecrire(racine, `proj/${nom}`, "x");
    const tenue = barriere();
    const delai = barriere();
    let tenues = 0;
    let attend = false;
    const { lecteur } = nouveauLecteur(racine, {
      attendre: async () => {
        attend = true;
        await delai.ouverte;
      },
      pendant: async (moment) => {
        if (moment !== "apres-controle" || tenues >= 2) return;
        tenues++;
        await tenue.ouverte;
      },
    });
    const tenus = [lecteur.contenu({ projet: "proj", chemin: "f1.txt" }), lecteur.contenu({ projet: "proj", chemin: "f2.txt" })];
    await jusqua(() => tenues === 2);
    const troisieme = lecteur.contenu({ projet: "proj", chemin: "f3.txt" });
    await jusqua(() => attend);
    tenue.ouvrir();
    assert.ok((await troisieme).ok);
    for (const lecture of tenus) assert.ok((await lecture).ok);
    delai.ouvrir();
  });
});

describe("lecteur : sans /proc (cockpit de développement sous Windows)", () => {
  it("étape 11 sautée, un seul avertissement", LINUX ? { skip: "exige Windows (sans /proc)" } : {}, async () => {
    const racine = nouvelleRacine();
    ecrire(racine, "proj/a.txt", "a");
    ecrire(racine, "proj/b.txt", "b");
    const { lecteur, lignes } = nouveauLecteur(racine);
    assert.ok((await lecteur.contenu({ projet: "proj", chemin: "a.txt" })).ok);
    assert.ok((await lecteur.contenu({ projet: "proj", chemin: "b.txt" })).ok);
    assert.equal(lignes.filter((ligne) => ligne.message.includes("/proc")).length, 1);
    assert.equal(lignes.length, 1);
  });
});

describe("statiques : lecture seule, aucune sortie, crochets de test jamais passés par les routes", () => {
  const source = (nom: string) => fs.readFileSync(path.join(import.meta.dirname, nom), "utf8");
  const FICHIERS = ["workspace-files.ts", "routes-fichiers.ts"];
  const ECRITURES = [
    "writeFile",
    "appendFile",
    "mkdir",
    "rename",
    "rm(",
    "rmdir",
    "unlink",
    "truncate",
    "chmod",
    "chown",
    "symlink",
    "link(",
    "copyFile",
    "cp(",
    "utimes",
    "O_WRONLY",
    "O_RDWR",
    "O_CREAT",
    "O_TRUNC",
    "O_APPEND",
  ];
  const importsDe = (texte: string) => [...texte.matchAll(/^\s*import\s[^;]*?from\s+"([^"]+)";/gms)].map((m) => m[1]);

  it("aucune fonction d'écriture ni option d'ouverture en écriture", () => {
    for (const nom of FICHIERS) {
      const texte = source(nom);
      for (const mot of ECRITURES) assert.equal(texte.includes(mot), false, `${nom} : ${mot}`);
    }
  });

  it("aucun import de node:http, node:https, node:net, node:child_process, ./opencode.ts ni ./ledger.ts ; pas de fetch(", () => {
    const interdits = new Set(["node:http", "node:https", "node:net", "node:child_process", "http", "https", "net", "child_process", "./opencode.ts", "./ledger.ts"]);
    for (const nom of FICHIERS) {
      const texte = source(nom);
      assert.deepEqual(importsDe(texte).filter((spec) => interdits.has(spec ?? "")), [], nom);
      assert.equal(/\bimport\s*\(/.test(texte), false, `${nom} : import dynamique`);
      assert.equal(texte.includes("fetch("), false, `${nom} : fetch(`);
      assert.equal(/\brequire\s*\(/.test(texte), false, `${nom} : require`);
    }
  });

  it("workspace-files.ts n'importe que node:fs/promises, node:fs, node:path, ./shared/* et le type de ./log.ts", () => {
    const texte = source("workspace-files.ts");
    const imports = importsDe(texte);
    assert.ok(imports.length >= 5);
    for (const spec of imports) assert.match(spec ?? "", /^(node:fs|node:fs\/promises|node:path|\.\/log\.ts|\.\/shared\/[a-z0-9-]+\.ts)$/, spec);
    assert.match(texte, /^import type \{ Logger \} from "\.\/log\.ts";$/m);
  });

  it("routes-fichiers.ts ne passe jamais pendant, attendre ni maintenant au lecteur ; ne lit que c11.env et c11.log", () => {
    const texte = source("routes-fichiers.ts");
    assert.equal(/\b(pendant|attendre|maintenant)\b/.test(texte), false);
    const lus = [...texte.matchAll(/\bc11\.([A-Za-z]+)/g)].map((m) => m[1]);
    assert.deepEqual([...new Set(lus)].sort(), ["env", "log"]);
  });
});

describe("journal de tout le fichier (A5)", () => {
  it("aucune ligne ne contient une racine de test ni un message d'erreur de Node", () => {
    for (const ligne of JOURNAL) {
      const texte = JSON.stringify(ligne);
      sansRacine(texte);
      assert.equal(/ENOENT:|EACCES:|ELOOP:|EPERM:|no such file|permission denied|operation not permitted|too many levels/i.test(texte), false, texte);
    }
  });
});
