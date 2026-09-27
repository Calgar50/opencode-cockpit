// Migration du web 1.0.x → 1.1.0 (décision A37, fiche MW §1 à §3) : ligne de commande, exécutée par node dans un conteneur jetable
// de l'image app, pendant qu'opencode est arrêté (install.ps1 étape 4 et -NoStart, cockpit.ps1 restore ; CockpitTls.ps1,
// Invoke-CockpitWebMigration) :
//
//   docker run --rm --pull never --name <projet>-migration-web-<8 hex> --network none --user 1000:1000 --read-only --cap-drop ALL
//     --security-opt no-new-privileges --pids-limit 32 -v <projet>_oc-config:/oc-config --entrypoint node <image app>
//     --no-warnings server/migrate-oc-config.ts /oc-config
//
// Le volume est inscriptible par l'IA sous le même uid : lecture sans suivre de lien ni bloquer sur un tube, chemin réel vérifié,
// écriture seulement si le texte change, sur une relecture identique, après une copie de l'ancien fichier jamais écrasée, par un
// temporaire voisin renommé, au mode d'origine (R3, R8). Le plan vient de server/oc-config-web.ts (pur).
//
// Sortie (R9, §3) : UNE ligne sur stdout, « migration-web etat=… profil=… fichier=… blocs=… restes=… sauvegarde=… raison=… », sans
// aucun contenu ni aucune valeur du fichier ; rien sur stderr (toute exception est attrapée ici, et son message n'est JAMAIS
// imprimé : sous Node 24, une erreur de JSON.parse cite son entrée, donc l'adresse Copilot ou une clé) ; code 0, sauf « erreur » (1).
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {
  type EntreeVolume,
  type EtatMigration,
  NOM_HERITE,
  type NomGlobal,
  NOMS_EXAMINES,
  OCTETS_MAX,
  planWebMigration,
  type ProfilLu,
  type RaisonMigration,
  SUFFIXE_SAUVEGARDE,
} from "./oc-config-web.ts";

export interface VerdictMigration {
  etat: EtatMigration;
  profil: ProfilLu;
  fichier: NomGlobal | "-";
  blocs: number;
  restes: number;
  /** « <fichier>.avant-1.1.0 » (copie créée), « existante » (plus ancienne, gardée) ou « - ». */
  sauvegarde: string;
  raison: RaisonMigration;
}

export interface OptionsMigration {
  /** Point d'injection des tests (T2 e) : appelé entre l'analyse et la relecture. Jamais exposé en ligne de commande. */
  avantEcriture?: () => void;
}

const C = fs.constants;
// Linux (conteneur) : un lien est refusé à l'ouverture même, et un tube substitué entre-temps ne bloque pas. Absents sous Windows.
const SANS_LIEN = C.O_NOFOLLOW ?? 0;
const SANS_ATTENTE = C.O_NONBLOCK ?? 0;

const codeDe = (err: unknown) => (err as NodeJS.ErrnoException | null)?.code;

type Lecture = { type: "octets"; octets: Buffer; mode: number } | { type: "empeche"; empechement: "lien-ou-special" | "trop-gros" } | { type: "disparu" };

/** Présent au sens de R2 : n'importe quelle entrée (fichier, lien, dossier, fichier spécial), vue par lstat. */
function present(dossier: string, nom: string): boolean {
  try {
    fs.lstatSync(path.join(dossier, nom));
    return true;
  } catch (err) {
    if (codeDe(err) === "ENOENT") return false;
    throw err;
  }
}

/** Chemin réel d'un descripteur ouvert (Linux, /proc/self/fd), null ailleurs. */
function cheminReel(fd: number): string | null {
  try {
    return fs.realpathSync(`/proc/self/fd/${fd}`);
  } catch {
    return null;
  }
}

/**
 * Lecture sûre (R3), même logique que readBytesInside (fsutil.ts, non modifié) : lstat, puis O_RDONLY|O_NOFOLLOW|O_NONBLOCK, fstat
 * (fichier ordinaire exigé), chemin réel du descripteur à la racine du dossier, lecture bornée à OCTETS_MAX + 1.
 */
function lireSur(dossier: string, nom: string): Lecture {
  const chemin = path.join(dossier, nom);
  let info: fs.Stats;
  try {
    info = fs.lstatSync(chemin);
  } catch (err) {
    if (codeDe(err) === "ENOENT") return { type: "disparu" };
    throw err;
  }
  if (!info.isFile()) return { type: "empeche", empechement: "lien-ou-special" };
  let fd: number;
  try {
    fd = fs.openSync(chemin, C.O_RDONLY | SANS_LIEN | SANS_ATTENTE);
  } catch (err) {
    const code = codeDe(err);
    if (code === "ENOENT") return { type: "disparu" };
    if (code === "ELOOP" || code === "EISDIR" || code === "ENXIO") return { type: "empeche", empechement: "lien-ou-special" };
    throw err;
  }
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile()) return { type: "empeche", empechement: "lien-ou-special" };
    const reel = cheminReel(fd);
    if (reel !== null && reel !== path.join(fs.realpathSync(dossier), nom)) return { type: "empeche", empechement: "lien-ou-special" };
    if (stat.size > OCTETS_MAX) return { type: "empeche", empechement: "trop-gros" };
    const tampon = Buffer.alloc(OCTETS_MAX + 1);
    let lus = 0;
    while (lus < tampon.length) {
      const n = fs.readSync(fd, tampon, lus, tampon.length - lus, null);
      if (n === 0) break;
      lus += n;
    }
    if (lus > OCTETS_MAX) return { type: "empeche", empechement: "trop-gros" };
    return { type: "octets", octets: Buffer.from(tampon.subarray(0, lus)), mode: stat.mode & 0o7777 };
  } finally {
    fs.closeSync(fd);
  }
}

function ecrireTout(fd: number, octets: Uint8Array): void {
  let ecrits = 0;
  while (ecrits < octets.length) ecrits += fs.writeSync(fd, octets, ecrits, octets.length - ecrits);
}

/**
 * Copie de l'ancien fichier (R8.2) : création exclusive, sans suivre de lien, 0600 le temps de l'écrire, fsync, puis mode d'origine.
 * Nom déjà pris : un fichier ordinaire est la copie la plus ancienne, gardée ; un lien, un dossier ou un fichier spécial arrête tout.
 */
function sauvegarder(chemin: string, octets: Uint8Array, mode: number): "creee" | "existante" | "impossible" {
  let fd: number;
  try {
    fd = fs.openSync(chemin, C.O_WRONLY | C.O_CREAT | C.O_EXCL | SANS_LIEN, 0o600);
  } catch (err) {
    if (codeDe(err) !== "EEXIST") return "impossible";
    try {
      return fs.lstatSync(chemin).isFile() ? "existante" : "impossible";
    } catch {
      return "impossible";
    }
  }
  let ok = false;
  try {
    ecrireTout(fd, octets);
    fs.fsyncSync(fd);
    fs.fchmodSync(fd, mode);
    ok = true;
  } catch {
    ok = false;
  } finally {
    fs.closeSync(fd);
    if (!ok) fs.rmSync(chemin, { force: true });
  }
  return ok ? "creee" : "impossible";
}

/** fsync du dossier, au mieux (sans effet sous Windows, qui refuse d'ouvrir un dossier). */
function synchroniserDossier(dossier: string): void {
  try {
    const fd = fs.openSync(dossier, C.O_RDONLY);
    try {
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    // Au mieux : le renommage est déjà fait.
  }
}

/**
 * Écriture atomique au mode d'origine (R8.3) : temporaire voisin <fichier>.<12 hex>.tmp créé exclusivement sans suivre de lien,
 * écrit, fsync, renommé sur le fichier, puis fsync du dossier. Le temporaire est retiré en cas d'échec. writeFileAtomic (0644 forcé,
 * sans fsync) n'est pas utilisé ici et n'est pas modifié.
 */
function ecrireAtomique(dossier: string, nom: string, octets: Uint8Array, mode: number): void {
  const temporaire = path.join(dossier, `${nom}.${crypto.randomBytes(6).toString("hex")}.tmp`);
  const fd = fs.openSync(temporaire, C.O_WRONLY | C.O_CREAT | C.O_EXCL | SANS_LIEN, 0o600);
  let ferme = false;
  let renomme = false;
  try {
    fs.fchmodSync(fd, mode);
    ecrireTout(fd, octets);
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    ferme = true;
    fs.renameSync(temporaire, path.join(dossier, nom));
    renomme = true;
  } finally {
    if (!ferme) fs.closeSync(fd);
    if (!renomme) fs.rmSync(temporaire, { force: true });
  }
  synchroniserDossier(dossier);
}

const verdict = (etat: EtatMigration, raison: RaisonMigration, champs: Partial<VerdictMigration> = {}): VerdictMigration => ({
  etat,
  profil: "-",
  fichier: "-",
  blocs: 0,
  restes: 0,
  sauvegarde: "-",
  raison,
  ...champs,
});

/**
 * Migre le dossier `dossier` (racine du volume oc-config). Rend le verdict ; ne lève que sur une erreur technique imprévue, que la
 * ligne de commande rend « erreur raison=interne ». `options.avantEcriture` n'existe que pour les tests.
 */
export function migrer(dossier: string, options: OptionsMigration = {}): VerdictMigration {
  const presents = NOMS_EXAMINES.filter((nom) => present(dossier, nom));
  const fichiers: Record<string, EntreeVolume> = {};
  for (const nom of presents) fichiers[nom] = { empechement: "non-lu" };
  let lecture: Lecture | null = null;
  const seul = presents.length === 1 ? presents[0] : undefined;
  if (seul !== undefined && seul !== NOM_HERITE) {
    lecture = lireSur(dossier, seul);
    if (lecture.type === "disparu") return verdict("non-migre", "modifie-pendant");
    fichiers[seul] = lecture.type === "octets" ? lecture.octets : { empechement: lecture.empechement };
  }
  const plan = planWebMigration(fichiers);
  const lu: VerdictMigration = { etat: plan.etat, profil: plan.profil, fichier: plan.fichier, blocs: plan.blocs, restes: plan.restes, sauvegarde: "-", raison: plan.raison };
  if (plan.etat !== "migre" || plan.texte === null || plan.fichier === "-" || lecture?.type !== "octets") return lu;

  // R8.1 : relecture par la même lecture sûre ; les octets doivent être ceux qui ont été analysés.
  options.avantEcriture?.();
  const relue = lireSur(dossier, plan.fichier);
  const refus = { profil: plan.profil, fichier: plan.fichier };
  if (relue.type !== "octets" || !relue.octets.equals(lecture.octets)) return verdict("non-migre", "modifie-pendant", refus);
  // R8.2 : copie de l'ancien fichier, jamais écrasée.
  const nomSauvegarde = `${plan.fichier}${SUFFIXE_SAUVEGARDE}`;
  const copie = sauvegarder(path.join(dossier, nomSauvegarde), lecture.octets, lecture.mode);
  if (copie === "impossible") return verdict("non-migre", "sauvegarde-impossible", refus);
  const sauvegarde = copie === "creee" ? nomSauvegarde : "existante";
  // R8.3 : écriture atomique au mode d'origine.
  try {
    ecrireAtomique(dossier, plan.fichier, Buffer.from(plan.texte, "utf8"), lecture.mode);
  } catch {
    return verdict("erreur", "interne", { ...refus, sauvegarde });
  }
  return { ...lu, sauvegarde };
}

/** Ligne de verdict (§3) : rien que des valeurs de listes fermées et deux nombres (bornés à 4 chiffres, comme la lecture PowerShell). */
export function ligneMigration(v: VerdictMigration): string {
  const nombre = (n: number) => String(Math.min(Math.max(Math.trunc(n), 0), 9999));
  return `migration-web etat=${v.etat} profil=${v.profil} fichier=${v.fichier} blocs=${nombre(v.blocs)} restes=${nombre(v.restes)} sauvegarde=${v.sauvegarde} raison=${v.raison}`;
}

function estDossier(chemin: string): boolean {
  try {
    return fs.statSync(chemin).isDirectory();
  } catch {
    return false;
  }
}

/** Ligne de commande : refus en root (R8.4), un seul argument, chemin absolu d'un dossier ; toute exception → erreur interne. */
export function principal(args: readonly string[]): { ligne: string; code: number } {
  let resultat: VerdictMigration;
  try {
    const dossier = args[0];
    if (process.getuid?.() === 0) resultat = verdict("erreur", "root");
    else if (args.length !== 1 || dossier === undefined || !path.isAbsolute(dossier) || !estDossier(dossier)) resultat = verdict("erreur", "argument");
    else resultat = migrer(dossier);
  } catch {
    resultat = verdict("erreur", "interne");
  }
  return { ligne: ligneMigration(resultat), code: resultat.etat === "erreur" ? 1 : 0 };
}

const lanceDirectement = (() => {
  const script = process.argv[1];
  if (script === undefined) return false;
  const a = path.resolve(script);
  const b = import.meta.filename;
  return process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;
})();

if (lanceDirectement) {
  const { ligne, code } = principal(process.argv.slice(2));
  process.stdout.write(`${ligne}\n`);
  process.exitCode = code;
}
