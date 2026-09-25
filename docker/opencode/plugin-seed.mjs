// Amorce de l'extension @opencode-ai/plugin (1.0.6), lancée une fois par le superviseur (entrypoint.sh), au démarrage du
// conteneur, avant le premier lancement d'opencode. Les relances d'opencode dans le même conteneur (redémarrage demandé par le
// cockpit, arrêt inattendu) ne la relancent pas.
// opencode 1.18.30 installe lui-même ce paquet dans son dossier de configuration (appel au registre npm) à chaque chargement d'un
// dossier, tant que son test d'installation échoue (packages/core/src/npm.ts, Npm.install) :
//   - node_modules absent ;
//   - ou un nom déclaré (dépendances de package.json, plus @opencode-ai/plugin) absent de package-lock.json › packages[""].
// Le volume de configuration d'une installation existante n'est jamais rempli par Docker : l'amorce y recopie la préinstallation de
// l'image (npm ci à la construction, versions et empreintes figées) au démarrage du conteneur, si ce test échouait, et seulement
// dans ce cas.
// Un package.json qui déclare d'autres paquets (ajoutés à la main) n'est jamais touché.
// Usage : node plugin-seed.mjs <dossier de configuration> <préinstallation>. Une ligne pour le journal ; code 1 si l'amorce échoue.
import fs from "node:fs";
import path from "node:path";

const PLUGIN = "@opencode-ai/plugin";
const [configDir, seedDir] = process.argv.slice(2);

const readJson = (file) => {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return {};
  }
};
const names = (value) => (value !== null && typeof value === "object" && !Array.isArray(value) ? Object.keys(value) : []);
const fields = (record) => [
  ...names(record?.dependencies),
  ...names(record?.devDependencies),
  ...names(record?.peerDependencies),
  ...names(record?.optionalDependencies),
];

/** Noms déclarés : ceux de package.json, plus l'extension qu'opencode ajoute toujours. */
const declared = (dir) => new Set([...fields(readJson(path.join(dir, "package.json"))), PLUGIN]);

/** Même test qu'opencode : vrai s'il lancerait une installation (donc un appel au registre npm). */
function wouldInstall(dir) {
  if (!fs.existsSync(path.join(dir, "node_modules"))) return true;
  const locked = new Set(fields(readJson(path.join(dir, "package-lock.json"))?.packages?.[""]));
  for (const name of declared(dir)) if (!locked.has(name)) return true;
  return false;
}

function main() {
  if (!configDir || !seedDir) throw new Error("usage : plugin-seed.mjs <configuration> <préinstallation>");
  if (!wouldInstall(configDir)) return `extension ${PLUGIN} présente : opencode n'appellera pas le registre npm`;
  const extra = [...declared(configDir)].filter((name) => name !== PLUGIN);
  if (extra.length > 0) {
    return `ATTENTION : package.json de la configuration déclare ${extra.length} autre(s) paquet(s), laissé tel quel ; opencode tentera de les installer (refusé : npm hors ligne, aucune sortie)`;
  }
  // node_modules de la configuration : géré par opencode pour ce seul paquet, remplacé en entier par la préinstallation.
  const target = path.join(configDir, "node_modules");
  const staging = path.join(configDir, ".node_modules.cockpit");
  fs.rmSync(staging, { recursive: true, force: true });
  fs.cpSync(path.join(seedDir, "node_modules"), staging, { recursive: true, verbatimSymlinks: true });
  fs.rmSync(target, { recursive: true, force: true });
  fs.renameSync(staging, target);
  for (const file of ["package.json", "package-lock.json"]) fs.copyFileSync(path.join(seedDir, file), path.join(configDir, file));
  if (wouldInstall(configDir)) throw new Error("préinstallation recopiée mais toujours jugée absente");
  return `extension ${PLUGIN} recopiée depuis l'image : opencode n'appellera pas le registre npm`;
}

try {
  process.stdout.write(`${main()}\n`);
} catch (err) {
  process.stdout.write(`ERREUR : amorce de ${PLUGIN} impossible (${err instanceof Error ? err.message : String(err)}) ; opencode tentera l'installation, refusée hors ligne\n`);
  process.exitCode = 1;
}
