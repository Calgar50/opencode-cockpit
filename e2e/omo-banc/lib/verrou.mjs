// Banc hors ligne de la salle (L21) : garde-fous communs — nom de projet, verrou, appels Docker, nettoyage.
//
// Règles tenues ici, et nulle part ailleurs :
// - le nom de projet Compose doit commencer par `sal11-omo-banc-` ; tout autre nom, et en particulier `opencode-cockpit`,
//   `ocauto-*`, `cockpit-e2e*` ou les préfixes des autres travaux, fait REFUSER le démarrage (jamais un nettoyage silencieux) ;
// - un seul banc à la fois : verrou par fichier, avec le PID et l'heure ; un verrou dont le processus n'existe plus est repris ;
// - toute commande `docker` part avec `MSYS_NO_PATHCONV=1` : sans elle, Git Bash de Windows traduit `/control` en `C:/Program
//   Files/Git/control` et les montages du conteneur deviennent faux ;
// - le nettoyage ne touche QUE les ressources du projet du banc, vérifié par son nom avant chaque suppression.
//
// Aucune dépendance npm (P8) : modules `node:` seulement.
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";

/** Préfixe imposé à tout projet Compose de ce banc. */
export const PREFIXE_PROJET = "sal11-omo-banc-";

/** Étiquette des images et des ressources hors Compose du banc. */
export const ETIQUETTE_BANC = "sal11";

/**
 * Noms qu'un projet du banc ne doit JAMAIS porter : la pile de l'utilisateur, les bancs des autres travaux qui tournent en même
 * temps. La comparaison se fait sur le nom entier en minuscules, avant la moindre commande Docker.
 */
export const PROJETS_INTERDITS = Object.freeze([
  "opencode-cockpit",
  "opencode-cockpit-e2e",
  "cockpit-e2e",
  "ocauto",
]);

/** Préfixes réservés à d'autres travaux ou à l'utilisateur : un projet du banc n'en porte aucun. */
export const PREFIXES_INTERDITS = Object.freeze([
  "opencode-cockpit",
  "ocauto-",
  "cockpit-e2e",
  "omo11-",
  "it11-",
  "i211-",
  "eq11-",
  "c511-",
  "3d11-",
  "gf0-",
  "rv11-",
  "r105b",
]);

/** Identifiant de banc admis : lettres minuscules, chiffres et tirets, 1 à 24 caractères. */
export const ID_BANC = /^[a-z0-9][a-z0-9-]{0,23}$/;

export class BancRefus extends Error {
  constructor(message) {
    super(message);
    this.name = "BancRefus";
  }
}

/**
 * Nom de projet du banc, ou refus. Les deux contrôles sont indépendants : le préfixe imposé d'une part, la liste noire de
 * l'autre. Un identifiant qui ferait tomber le nom sur un projet interdit est donc refusé deux fois.
 */
export function nomDeProjet(id) {
  if (typeof id !== "string" || !ID_BANC.test(id)) {
    throw new BancRefus(`--id refusé : ${JSON.stringify(String(id)).slice(0, 40)} (minuscules, chiffres et tirets, 24 au plus).`);
  }
  const nom = `${PREFIXE_PROJET}${id}`;
  verifierProjet(nom);
  return nom;
}

/** Refuse tout nom de projet qui n'est pas un projet de ce banc. Appelée avant chaque `docker compose`, y compris au nettoyage. */
export function verifierProjet(nom) {
  const bas = String(nom).toLowerCase();
  if (!bas.startsWith(PREFIXE_PROJET)) {
    throw new BancRefus(`Projet Docker refusé : « ${bas} » ne commence pas par « ${PREFIXE_PROJET} ». Le banc ne touche rien d'autre.`);
  }
  if (PROJETS_INTERDITS.includes(bas)) {
    throw new BancRefus(`Projet Docker refusé : « ${bas} » appartient à l'utilisateur ou à un autre banc.`);
  }
  for (const prefixe of PREFIXES_INTERDITS) {
    if (bas.startsWith(prefixe)) {
      throw new BancRefus(`Projet Docker refusé : « ${bas} » porte le préfixe réservé « ${prefixe} ».`);
    }
  }
  return bas;
}

// --- Verrou -----------------------------------------------------------------------------------------------------------------

/** Le verrou vit hors du dépôt, à côté des sorties du banc : deux copies du dépôt partagent donc le même verrou. */
export const cheminVerrou = () => path.join(os.tmpdir(), "sal11-omo-banc.lock");

const vivant = (pid) => {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err?.code === "EPERM";
  }
};

/**
 * Prend le verrou du banc. Rend une fonction de libération, toujours sûre à rappeler. Un verrou dont le processus est mort est
 * repris (un banc tué laisse son fichier) ; un verrou vivant fait refuser, avec le PID qui le tient.
 */
export function prendreVerrou(projet, { maintenant = () => Date.now() } = {}) {
  const chemin = cheminVerrou();
  const contenu = JSON.stringify({ pid: process.pid, projet, at: maintenant() });
  for (let essai = 0; essai < 2; essai += 1) {
    try {
      fs.writeFileSync(chemin, contenu, { flag: "wx", mode: 0o600 });
      let rendu = false;
      return () => {
        if (rendu) return;
        rendu = true;
        try {
          const lu = JSON.parse(fs.readFileSync(chemin, "utf8"));
          if (lu?.pid === process.pid) fs.rmSync(chemin, { force: true });
        } catch {
          /* verrou déjà retiré ou illisible : rien à faire */
        }
      };
    } catch (err) {
      if (err?.code !== "EEXIST") throw err;
      let tenu = null;
      try {
        tenu = JSON.parse(fs.readFileSync(chemin, "utf8"));
      } catch {
        tenu = null;
      }
      if (tenu && vivant(tenu.pid)) {
        throw new BancRefus(`Un banc tourne déjà (PID ${tenu.pid}, projet ${String(tenu.projet).slice(0, 60)}). Attendez sa fin, ou supprimez ${chemin} s'il est resté.`);
      }
      fs.rmSync(chemin, { force: true });
    }
  }
  throw new BancRefus(`Verrou du banc impossible à prendre : ${chemin}`);
}

// --- Docker -----------------------------------------------------------------------------------------------------------------

/**
 * Lance une commande, arguments en tableau (jamais de texte de commande construit), et rend `{ code, sortie, erreur }`.
 * `MSYS_NO_PATHCONV=1` est posé pour toutes : Git Bash réécrit sinon les chemins du conteneur.
 */
export function lancer(programme, args, { cwd, entree, delaiMs = 600_000, env, silencieux = true } = {}) {
  return new Promise((resolve, reject) => {
    const enfant = spawn(programme, args, {
      cwd,
      env: { ...process.env, MSYS_NO_PATHCONV: "1", ...env },
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    let sortie = "";
    let erreur = "";
    let fini = false;
    const minuteur = setTimeout(() => {
      if (fini) return;
      fini = true;
      enfant.kill("SIGKILL");
      reject(new Error(`Commande trop longue (${delaiMs} ms) : ${programme} ${args.slice(0, 4).join(" ")}`));
    }, delaiMs);
    enfant.stdout.on("data", (bloc) => {
      sortie += bloc;
      if (!silencieux) process.stdout.write(bloc);
    });
    enfant.stderr.on("data", (bloc) => {
      erreur += bloc;
      if (!silencieux) process.stderr.write(bloc);
    });
    enfant.on("error", (err) => {
      if (fini) return;
      fini = true;
      clearTimeout(minuteur);
      reject(err);
    });
    enfant.on("close", (code) => {
      if (fini) return;
      fini = true;
      clearTimeout(minuteur);
      resolve({ code: code ?? -1, sortie, erreur });
    });
    if (entree !== undefined) enfant.stdin.write(entree);
    enfant.stdin.end();
  });
}

export const docker = (args, options) => lancer("docker", args, options);

/** `docker …` dont un code non nul est une erreur. Le message reprend les 400 derniers caractères du flux d'erreur. */
export async function dockerOuEchec(args, options) {
  const r = await docker(args, options);
  if (r.code !== 0) {
    throw new Error(`docker ${args.slice(0, 6).join(" ")} → code ${r.code}\n${String(r.erreur || r.sortie).slice(-400)}`);
  }
  return r;
}

export const attendre = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Attend qu'une condition devienne vraie, ou rend `false` au bout de `delaiMs`. */
export async function jusqua(condition, { delaiMs = 120_000, pasMs = 500 } = {}) {
  const fin = Date.now() + delaiMs;
  for (;;) {
    let ok = false;
    try {
      ok = await condition();
    } catch {
      ok = false;
    }
    if (ok) return true;
    if (Date.now() >= fin) return false;
    await attendre(pasMs);
  }
}

// --- Relevé et nettoyage de la pile -----------------------------------------------------------------------------------------

/** Lignes `nom<TAB>image<TAB>état` des conteneurs de l'utilisateur, relevées avant et après le banc (exigence de sortie). */
export async function pileUtilisateur() {
  const r = await docker(["ps", "-a", "--format", "{{.Names}}\t{{.Image}}\t{{.State}}"]);
  return String(r.sortie)
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => /^(opencode-cockpit|ocauto)/i.test(l))
    .sort();
}

/**
 * Supprime le projet du banc et lui seul. Le nom est revérifié ici : même appelée depuis un gestionnaire d'erreur, cette
 * fonction ne peut pas effacer la pile de l'utilisateur.
 */
export async function nettoyerProjet(projet, fichiersCompose, fichierEnv) {
  verifierProjet(projet);
  const args = ["compose", "--project-name", projet];
  if (fichierEnv) args.push("--env-file", fichierEnv);
  for (const f of fichiersCompose) args.push("--file", f);
  args.push("--profile", "omo", "down", "--volumes", "--remove-orphans", "--timeout", "10");
  return docker(args, { delaiMs: 180_000 });
}

/** Restes du banc : conteneurs, volumes et réseaux dont le nom commence par le projet. Doit être vide après le nettoyage. */
export async function restes(projet) {
  verifierProjet(projet);
  const lire = async (args) =>
    String((await docker(args)).sortie)
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => l.startsWith(projet));
  return {
    conteneurs: await lire(["ps", "-a", "--format", "{{.Names}}"]),
    volumes: await lire(["volume", "ls", "--format", "{{.Name}}"]),
    reseaux: await lire(["network", "ls", "--format", "{{.Name}}"]),
  };
}
