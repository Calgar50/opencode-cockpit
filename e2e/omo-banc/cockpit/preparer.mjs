// Cockpit RÉEL jetable du banc complet (L21b) : construit l'image du cockpit depuis une copie `git archive` d'un commit du
// dépôt, avec `SALLE_OUVERTE` basculée DANS LA COPIE SEULEMENT, jamais commitée (plan 2 bis §2.7 : « constante basculée dans
// cette copie seulement »).
//
// Pourquoi une copie `git archive`, et pas le dossier de travail : la copie ne contient que des fichiers SUIVIS, à un commit
// précis (reproductible), sans le `node_modules` jointé de la copie de travail (que Docker refuse de copier) ni aucun fichier
// non suivi. Le Dockerfile de l'app y refait `npm ci` : la construction demande Internet (accord (d) du 17/09), aucun appel
// Copilot, aucun jeton.
//
// Ce qui est basculé, et RIEN d'autre : l'unique déclaration `export const SALLE_OUVERTE = false;` de
// `app/server/wiring-11.ts` devient `= true`. La bascule est vérifiée (exactement une occurrence) : zéro ou deux, c'est un
// arrêt, jamais une image au hasard. Le dépôt n'est pas touché — la bascule vit dans la copie extraite, hors du dépôt.
//
// LIMITE, à connaître (tête de la vague 3 : V3 + A18 + L16c, ce que voit ce paquet) : basculer `SALLE_OUVERTE` ne suffit pas à ce
// qu'un cockpit RÉEL pilote la salle jusqu'au bout.
// - Aucun code de production n'appelle `omoControl.startHeartbeat()` (ni sur cette tête, ni dans les branches de la vague 4
//   commitées au 24/09) : le cockpit publie l'authentification et fait le pré-contrôle, mais n'écrit pas de battement ni ne
//   dépose la liste des projets dans le volume de contrôle, et le superviseur, faute de battement frais, ne démarre rien (homme
//   mort). Constat remis à l'intégrateur de la vague 4. `run-banc.mjs --complet --battement-banc` fait faire ces deux gestes par
//   les pilotes du banc, et le DIT, pour que le reste du cockpit réel puisse être éprouvé.
// - L'activation « omo » (L22c) et la fin de demande (L22d, L23b) arrivent avec le train de la vague 4.
// `activationLivreeDansCopie` lit la SOURCE extraite pour savoir ce qui est livré : le scénario de fumée dit « en attente » ce
// qui ne l'est pas encore, jamais un faux vert ni un faux rouge. Rejoué sur une tête où la vague 4 est intégrée (`--ref`), il va
// au bout sans rien changer ici.
//
// Aucune dépendance npm (P8) : modules `node:` seulement.
import { execFile, spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";

const execFileP = promisify(execFile);

/** Déclaration basculée : une seule dans le dépôt (`wiring-11.ts`). Le motif tient à l'espace autour du `=`. */
const AVANT = "export const SALLE_OUVERTE = false;";
const APRES = "export const SALLE_OUVERTE = true;";

/** Fichier qui porte la constante, relatif à la racine de la copie. */
export const FICHIER_SALLE_OUVERTE = "app/server/wiring-11.ts";

/**
 * Bascule `SALLE_OUVERTE` dans le texte de `wiring-11.ts`. Rend `{ texte, remplacements }`. L'appelant EXIGE `remplacements === 1`
 * (pur, testé sans Docker) : le fichier du dépôt en porte exactement une, et une image bâtie sur zéro ou deux serait fausse.
 */
export function basculerSalleOuverte(texte) {
  const remplacements = texte.split(AVANT).length - 1;
  return { texte: texte.split(AVANT).join(APRES), remplacements };
}

const barre = (p) => String(p).replace(/\\/g, "/");

/**
 * Référence git acceptée pour `--ref` : un nom de branche, d'étiquette ou un SHA, rien d'autre. Elle part en argument de `git
 * rev-parse` : un texte qui commence par « - » y serait lu comme une OPTION (`--output=…`), un espace ou un caractère de contrôle
 * n'a rien à faire dans un nom. Refusée ici, avant tout appel.
 */
export function refAcceptee(ref) {
  return typeof ref === "string" && ref.length > 0 && ref.length <= 200 && /^[A-Za-z0-9][A-Za-z0-9._/^~-]*$/.test(ref) && !ref.includes("..");
}

/**
 * L'activation « omo » (L22c, vague 4) est-elle LIVRÉE dans la copie extraite ? Vraie quand le choix d'autonomie « omo » est
 * accepté (l'énumération de `conversation-autonomy.ts` le contient) ET qu'un déclencheur de battement existe
 * (`startHeartbeat(` appelé ailleurs que dans la définition du port). Faux sur une tête antérieure au train de la vague 4 : le
 * cockpit démarre mais ne pilote pas la salle, et le scénario de fumée le dit « en attente » au lieu d'un faux rouge.
 */
export function activationLivreeDansCopie(cible) {
  const lire = (rel) => {
    try {
      return fs.readFileSync(path.join(cible, ...rel.split("/")), "utf8");
    } catch {
      return "";
    }
  };
  const autonomie = lire("app/server/conversation-autonomy.ts");
  // Deux formes du corps : « omo » dans l'énumération des choix, ou le schéma dédié que L22c a livré
  // (`omoBodySchema = z.strictObject({ choix: z.literal("omo"), … })`). Sans la seconde, une tête qui livre l'activation était
  // dite « en attente » et la fumée sautait l'activation (train de V4 de la 2 ter).
  const choixOmo = /choix:\s*z\.enum\(\[[^\]]*"omo"/.test(autonomie) || /choix:\s*z\.literal\(\s*"omo"\s*\)/.test(autonomie);
  const battementDeclenche = battementDeclencheDans(cible);
  return { choixOmo, battementDeclenche, livree: choixOmo && battementDeclenche };
}

/**
 * Un code de PRODUCTION de `app/server` appelle-t-il `….startHeartbeat()` ? Tous les `.ts` du dossier et de ses sous-dossiers sont
 * lus, tests exclus ; la déclaration (`startHeartbeat() {`, omo-control.ts), la signature du port (`startHeartbeat(): void`,
 * omo-contracts.ts) et le port neutre (`startHeartbeat: () => undefined`) ne sont pas des appels et ne comptent pas.
 */
export function battementDeclencheDans(cible) {
  const racine = path.join(cible, "app", "server");
  const pile = [racine];
  while (pile.length > 0) {
    const dossier = pile.pop();
    let entrees;
    try {
      entrees = fs.readdirSync(dossier, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entrees) {
      const complet = path.join(dossier, e.name);
      if (e.isDirectory()) {
        if (e.name !== "node_modules" && e.name !== "test-support") pile.push(complet);
        continue;
      }
      if (!e.isFile() || !e.name.endsWith(".ts") || e.name.endsWith(".test.ts") || e.name.endsWith(".d.ts")) continue;
      if (/\.startHeartbeat\(\s*\)/.test(fs.readFileSync(complet, "utf8"))) return true;
    }
  }
  return false;
}

/**
 * Désarchive `tar` dans `cible`, l'archive passée sur l'ENTRÉE STANDARD (`tar -xf -`). Deux `tar` se rencontrent sous Windows :
 * celui de Git (GNU), qui prend « C:\… » dans `-f` pour un hôte distant sans `--force-local`, et celui de Windows (bsdtar), que
 * trouve un processus lancé par Start-Process et qui REFUSE `--force-local` (mesuré au banc, 24/09). Par l'entrée standard, aucun
 * nom d'archive n'est lu : la même commande vaut pour les deux.
 */
function desarchiver(tar, cible) {
  return new Promise((resolve, reject) => {
    const enfant = spawn("tar", ["-xf", "-", "-C", barre(cible)], { stdio: ["pipe", "ignore", "pipe"], windowsHide: true });
    let erreur = "";
    enfant.stderr.on("data", (b) => {
      erreur = `${erreur}${b}`.slice(-2000);
    });
    enfant.on("error", reject);
    enfant.stdin.on("error", () => undefined);
    enfant.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`tar -xf - a rendu ${code} : ${erreur.trim().slice(-600)}`))));
    const flux = fs.createReadStream(tar);
    flux.on("error", (err) => {
      enfant.kill();
      reject(err);
    });
    flux.pipe(enfant.stdin);
  });
}

/**
 * Extrait `ref` du dépôt dans `cible`. `git archive --output` écrit un tar dans le dossier PARENT de la cible (hors du dépôt),
 * `desarchiver` l'extrait, puis le tar est retiré : pas de tube entre deux commandes, pas de tar laissé derrière. `git archive`
 * suit `.gitattributes` (`eol=lf`) : les scripts de l'image gardent leurs fins de ligne. Rend le SHA complet du commit extrait.
 */
async function extraireArchive({ racineDepot, ref, cible }) {
  if (!refAcceptee(ref)) throw new Error(`preparerCockpit : référence refusée « ${String(ref).slice(0, 60)} » (branche, étiquette ou SHA attendus)`);
  fs.rmSync(cible, { recursive: true, force: true });
  fs.mkdirSync(cible, { recursive: true });
  const sha = (await execFileP("git", ["-C", racineDepot, "rev-parse", "--verify", `${ref}^{commit}`])).stdout.trim();
  const tar = `${cible}.tar`;
  try {
    await execFileP("git", ["-C", racineDepot, "archive", "--format=tar", `--output=${barre(tar)}`, sha], { maxBuffer: 8 * 1024 * 1024 });
    await desarchiver(tar, cible);
  } finally {
    fs.rmSync(tar, { force: true });
  }
  return sha;
}

/**
 * Construit le cockpit réel jetable. Rend `{ image, sha, ref, cible }`.
 *
 * - `racineDepot` : la racine du dépôt (copie de travail du banc) ;
 * - `ref` : le commit à extraire (défaut : `HEAD`) ;
 * - `cible` : le dossier d'extraction, HORS du dépôt (le banc le met sous son dossier de sortie) ;
 * - `image` : l'étiquette de l'image (défaut : `sal11-omo/cockpit-reel:sal11`) ;
 * - `docker` : la fonction d'appel Docker du banc (`lib/verrou.mjs`) ;
 * - `dire` : le journal du banc ;
 * - `construire` : false pour ne faire que l'extraction et la bascule (tests, `--a-blanc`).
 */
export async function preparerCockpit({ racineDepot, ref = "HEAD", cible, image = "sal11-omo/cockpit-reel:sal11", docker, dire = () => {}, construire = true }) {
  if (typeof racineDepot !== "string" || racineDepot === "") throw new Error("preparerCockpit : racineDepot manquante");
  if (typeof cible !== "string" || cible === "") throw new Error("preparerCockpit : cible manquante (hors du dépôt)");

  const sha = await extraireArchive({ racineDepot, ref, cible });
  dire(`cockpit réel : archive de ${ref} (${sha.slice(0, 12)}) extraite dans ${barre(cible)}`);

  const fichier = path.join(cible, ...FICHIER_SALLE_OUVERTE.split("/"));
  if (!fs.existsSync(fichier)) throw new Error(`preparerCockpit : ${FICHIER_SALLE_OUVERTE} absent de l'archive de ${ref}`);
  const { texte, remplacements } = basculerSalleOuverte(fs.readFileSync(fichier, "utf8"));
  if (remplacements !== 1) {
    throw new Error(`preparerCockpit : SALLE_OUVERTE basculée ${remplacements} fois dans ${FICHIER_SALLE_OUVERTE} (une seule attendue) — image refusée`);
  }
  fs.writeFileSync(fichier, texte);
  dire("cockpit réel : SALLE_OUVERTE basculée à true dans la copie jetable (jamais dans le dépôt)");

  const activation = activationLivreeDansCopie(cible);
  dire(`cockpit réel : activation « omo » ${activation.livree ? "livrée" : "EN ATTENTE"} (choix omo ${activation.choixOmo}, battement déclenché ${activation.battementDeclenche})`);

  if (!construire) return { image, sha, ref, cible, activation, construite: false };

  if (typeof docker !== "function") throw new Error("preparerCockpit : docker manquant pour la construction");
  dire(`cockpit réel : construction de l'image ${image} (npm ci, Internet, aucun appel Copilot)`);
  const build = await docker(
    ["build", "--provenance=false", "-f", path.join(cible, "app", "Dockerfile"), "-t", image, cible],
    { delaiMs: 600_000, silencieux: true },
  );
  if (build.code !== 0) throw new Error(`preparerCockpit : construction du cockpit réel en échec (code ${build.code})\n${String(build.erreur).slice(-1200)}`);
  dire(`cockpit réel : image ${image} construite`);
  return { image, sha, ref, cible, activation, construite: true };
}
