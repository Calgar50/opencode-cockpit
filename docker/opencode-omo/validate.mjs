// Validation de la Salle OMO (JS-5, porte G14), lancée :
// - par la construction de l'image (`RUN node /opt/omo-check/validate.mjs --construction`) : une configuration fausse fait
//   échouer la construction (`build-omo-image.ps1 -SelfTest`) ;
// - par `build-omo-image.ps1`, dans un conteneur sans réseau (`docker run --network none … --construction`) ;
// - par le superviseur à chaque démarrage (`node /opt/omo-check/validate.mjs`, sans argument : TOUS les contrôles).
// Sortie non nulle au moindre message ; aucun message n'est jamais « seulement un avertissement ».
//
// Ce qui est vérifié (spéc. §3.15.1, plan fiche L15a) :
// 1. énumérations de L20 bien formées, pour la version épinglée ;
// 2. extension installée en version EXACTEMENT 4.19.4 ;
// 3. chaque nom énuméré (hooks, outils, MCP, compétences, commandes, agents, fournisseurs, catégories) présent dans le `dist`
//    installé : un nom disparu serait ignoré en silence par l'extension (R3) ;
// 4. `omo.jsonc` et `opencode.jsonc` figés, conformes (`validate-core.mjs`) ;
// 5. aucun des noms de `nomsPrecontrole` à la racine du conteneur : l'extension lit ses couches « de projet » dans chaque parent
//    du projet, jusqu'à `/` (C2-14) ;
// 6. au démarrage seulement (pas avec `--construction`) :
//    - la configuration que l'extension lit VRAIMENT, `$HOME/.omo/omo.jsonc` (seul emplacement « utilisateur » de la 4.19.4,
//      `omo-config-core`, `detectUserOmoJsonPath`), existe et est identique à la référence de l'image ; `omo.json` n'y est pas.
//      Sans elle, l'extension tournerait sur ses défauts, sans aucune coupure ;
//    - `COCKPIT_COPILOT_API_URL` définie et bien formée (MO-6).
//
// Rien n'est exécuté ni importé de l'extension : son `package.json` et son `dist/index.js` sont lus comme du texte, bornés.
// `--racine DOSSIER` sert aux tests seulement (arborescence posée sous DOSSIER) ; le superviseur ne passe aucun argument.
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";
import {
  CATEGORIES_4_19_4,
  NOM_PAQUET,
  NOMS_PRECONTROLE_RACINE,
  VERSION_EXTENSION,
  lireJsonc,
  nomPresentDans,
  nomsEnumeres,
  verifierAdresseCopilot,
  verifierEnumerations,
  verifierOmo,
  verifierOpencode,
  verifierTexteOpencode,
} from "./validate-core.mjs";

/** Chemins lus dans l'image (contrat `contrat-salle.json`, `cheminsImage`). */
export const CHEMINS_VALIDATION = Object.freeze({
  enumerations: "/opt/omo-check/enums-4.19.4.json",
  configurationOmo: "/etc/opencode-omo/omo/omo.jsonc",
  configurationOpencode: "/etc/opencode-omo/opencode.jsonc",
  paquet: "/opt/omo/node_modules/oh-my-openagent/package.json",
  dist: "/opt/omo/node_modules/oh-my-openagent/dist/index.js",
  dossierOmoUtilisateur: "/home/node/.omo",
});

const UN_MIO = 1024 * 1024;
/** Le `dist` de la 4.19.4 fait environ 5,5 Mio ; au-delà de 64 Mio, c'est un doute, pas une version. */
const DIST_MAX_OCTETS = 64 * UN_MIO;

/** Fichier ordinaire (jamais un lien), borné en taille ; `null` s'il est absent, et une erreur décrite sinon. */
function lireFichier(chemin, maxOctets) {
  let info;
  try {
    info = fs.lstatSync(chemin);
  } catch {
    return { texte: null, erreur: null };
  }
  if (!info.isFile()) return { texte: null, erreur: `${chemin} n'est pas un fichier ordinaire` };
  if (info.size > maxOctets) return { texte: null, erreur: `${chemin} dépasse ${maxOctets} octets` };
  try {
    return { texte: fs.readFileSync(chemin, "utf8"), erreur: null };
  } catch (err) {
    const code = err !== null && typeof err === "object" && "code" in err ? String(err.code) : "erreur";
    return { texte: null, erreur: `${chemin} illisible (${code})` };
  }
}

/** Raison lisible d'une erreur de lecture JSONC (ErreurJsonc porte sa position). */
const raisonDe = (erreur) => (erreur !== null && typeof erreur === "object" && "message" in erreur ? String(erreur.message) : String(erreur));

function lireExige(chemin, maxOctets, messages) {
  const { texte, erreur } = lireFichier(chemin, maxOctets);
  if (erreur !== null) messages.push(erreur);
  else if (texte === null) messages.push(`${chemin} absent`);
  return texte;
}

/**
 * Tous les contrôles. Rend la liste des messages (vide = conforme). `racine` préfixe chaque chemin (tests) ; `construction`
 * saute les contrôles qui n'ont de sens qu'au démarrage de la salle ; `env` fournit `COCKPIT_COPILOT_API_URL`.
 */
export function valider({ racine = "", construction = false, env = process.env } = {}) {
  const ici = (chemin) => (racine === "" ? chemin : path.join(racine, ...chemin.split("/").filter(Boolean)));
  const messages = [];

  // 1. Énumérations.
  let enums = null;
  const texteEnums = lireExige(ici(CHEMINS_VALIDATION.enumerations), UN_MIO, messages);
  if (texteEnums !== null) {
    try {
      enums = JSON.parse(texteEnums);
    } catch {
      messages.push("énumérations : JSON illisible");
    }
  }
  const formes = enums === null ? ["énumérations indisponibles"] : verifierEnumerations(enums);
  if (formes.length > 0) {
    messages.push(...formes);
    enums = null;
  }

  // 2. Version installée.
  const textePaquet = lireExige(ici(CHEMINS_VALIDATION.paquet), UN_MIO, messages);
  if (textePaquet !== null) {
    let paquet = null;
    try {
      paquet = JSON.parse(textePaquet);
    } catch {
      messages.push("package.json de l'extension illisible");
    }
    if (paquet !== null && (paquet?.name !== NOM_PAQUET || paquet?.version !== VERSION_EXTENSION)) {
      messages.push(`extension installée ${JSON.stringify(paquet?.name)}@${JSON.stringify(paquet?.version)}, attendu ${NOM_PAQUET}@${VERSION_EXTENSION} exactement`);
    }
  }

  // 3. Noms énumérés présents dans le dist installé.
  const dist = lireExige(ici(CHEMINS_VALIDATION.dist), DIST_MAX_OCTETS, messages);
  if (dist !== null) {
    const noms = enums === null ? CATEGORIES_4_19_4.map((nom) => ({ famille: "categories", nom })) : nomsEnumeres(enums);
    for (const { famille, nom } of noms) {
      if (!nomPresentDans(dist, nom)) messages.push(`nom absent du dist installé (${famille}) : ${nom}`);
    }
  }

  // 4. Configurations figées.
  const texteOmo = lireExige(ici(CHEMINS_VALIDATION.configurationOmo), UN_MIO, messages);
  if (texteOmo !== null && enums !== null) {
    try {
      messages.push(...verifierOmo(lireJsonc(texteOmo), enums).map((m) => `omo.jsonc : ${m}`));
    } catch (err) {
      messages.push(`omo.jsonc illisible : ${raisonDe(err)}`);
    }
  }
  const texteOpencode = lireExige(ici(CHEMINS_VALIDATION.configurationOpencode), UN_MIO, messages);
  if (texteOpencode !== null) {
    messages.push(...verifierTexteOpencode(texteOpencode));
    try {
      messages.push(...verifierOpencode(lireJsonc(texteOpencode)));
    } catch (err) {
      messages.push(`opencode.jsonc illisible : ${raisonDe(err)}`);
    }
  }

  // 5. Racine du conteneur : aucune couche de configuration ne doit s'y trouver (lstat : un lien compte aussi).
  for (const nom of [...NOMS_PRECONTROLE_RACINE.fichiers, ...NOMS_PRECONTROLE_RACINE.dossiers]) {
    const chemin = `/${nom}`;
    let present = true;
    try {
      fs.lstatSync(ici(chemin));
    } catch (err) {
      present = !(err instanceof Error && "code" in err && (err.code === "ENOENT" || err.code === "ENOTDIR"));
    }
    if (present) messages.push(`nom de configuration présent à la racine du conteneur : ${chemin}`);
  }

  // 6. Démarrage : configuration réellement lue par l'extension, adresse Copilot.
  if (!construction) {
    const dossier = CHEMINS_VALIDATION.dossierOmoUtilisateur;
    const effective = lireFichier(ici(`${dossier}/omo.jsonc`), UN_MIO);
    if (effective.erreur !== null) messages.push(`configuration lue par l'extension : ${effective.erreur}`);
    else if (effective.texte === null) messages.push(`configuration lue par l'extension absente : ${dossier}/omo.jsonc (l'extension tournerait sur ses défauts)`);
    else if (texteOmo !== null && effective.texte !== texteOmo) messages.push(`configuration lue par l'extension différente de la référence de l'image : ${dossier}/omo.jsonc`);
    let jsonPresent = true;
    try {
      fs.lstatSync(ici(`${dossier}/omo.json`));
    } catch {
      jsonPresent = false;
    }
    if (jsonPresent) messages.push(`${dossier}/omo.json présent : seule la référence omo.jsonc est permise`);
    messages.push(...verifierAdresseCopilot(env.COCKPIT_COPILOT_API_URL));
  }

  return messages;
}

/** Arguments : `--construction`, `--racine DOSSIER` ; tout le reste est une erreur d'usage (code 2). */
export function lireArguments(args) {
  const options = { racine: "", construction: false };
  for (let k = 0; k < args.length; k += 1) {
    const arg = args[k];
    if (arg === "--construction" && !options.construction) options.construction = true;
    else if (arg === "--racine" && options.racine === "" && typeof args[k + 1] === "string" && args[k + 1] !== "") {
      options.racine = args[k + 1];
      k += 1;
    } else return null;
  }
  return options;
}

function principal() {
  const options = lireArguments(process.argv.slice(2));
  if (options === null) {
    process.stderr.write("validate.mjs: usage : node validate.mjs [--construction] [--racine DOSSIER]\n");
    return 2;
  }
  const messages = valider(options);
  if (messages.length > 0) {
    for (const message of messages) process.stderr.write(`validate.mjs: ${message}\n`);
    process.stderr.write(`validate.mjs: ${messages.length} écart(s) : configuration refusée\n`);
    return 1;
  }
  const quoi = options.construction ? "construction (contrôles de démarrage faits par le superviseur)" : "démarrage";
  process.stdout.write(`validate.mjs: configuration conforme, ${NOM_PAQUET} ${VERSION_EXTENSION}, ${quoi}\n`);
  return 0;
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  process.exitCode = principal();
}
