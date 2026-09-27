// Validateur de la Salle OMO, partie PURE (JS-5, porte G14) : aucune lecture de fichier, aucun réseau, aucune dépendance.
// `validate.mjs` lit les fichiers de l'image et appelle ces fonctions ; les tests du cockpit les appellent directement
// (`validate-core.d.mts`). Ce fichier est dans le périmètre du manifeste (D-2b-32) : il tourne dans l'image, sous le node de
// l'image, et doit rester lisible sans rien installer.
//
// Pourquoi un validateur de noms (audit L20, R1 à R3) : les listes `disabled_*` de l'extension sont des tableaux de chaînes
// libres, comparées par égalité de nom. Un nom faux passe le schéma de l'extension, n'a AUCUN effet et ne produit AUCUN
// message. Et si la configuration fusionnée ne passe pas le schéma, l'extension repart de ses défauts
// (`omo-config-core`, `loadOmoConfig`) : toute la configuration figée disparaîtrait en silence. D'où « fermé en cas de doute » :
// chaque clé, chaque nom et chaque valeur épinglée sont exigés à l'identique, et tout le reste est un message.
//
// Chaque fonction `verifier…` rend une liste de messages en français ; liste vide = conforme. Aucun texte de l'extension ici :
// seulement des noms, déjà versionnés dans `enums-4.19.4.json` (D-2b-31).

// --- Constantes de la version épinglée ----------------------------------------------------------------------------------------

/** Version exacte de l'extension installée dans l'image (Q5). */
export const VERSION_EXTENSION = "4.19.4";

/** Nom du paquet npm de l'extension. */
export const NOM_PAQUET = "oh-my-openagent";

/** Seul fournisseur des IA de la salle (P1, JS-11, G3). */
export const PREFIXE_COPILOT = "github-copilot/";

/**
 * Catégories intégrées de la 4.19.4 (`BuiltinCategoryNameSchema`, `dist/config/schema/categories.d.ts`), relevées par L15a :
 * absentes de `enums-4.19.4.json` (L20). Chacune reçoit une IA `github-copilot/*` (G3) ; sans cela, l'extension garde l'IA par
 * défaut de la catégorie, d'un autre fournisseur.
 */
export const CATEGORIES_4_19_4 = Object.freeze([
  "artistry",
  "deep",
  "quick",
  "ultrabrain",
  "unspecified-high",
  "unspecified-low",
  "visual-engineering",
  "writing",
]);

/** Liste `disabled_*` → famille des énumérations de L20 qui en donne les noms permis. */
export const LISTES_COUPEES = Object.freeze({
  disabled_hooks: "hooks",
  disabled_tools: "outils",
  disabled_mcps: "mcps",
  disabled_agents: "agents",
  disabled_skills: "competences",
  disabled_commands: "commandes",
  disabled_providers: "fournisseursCoupes",
});

/** Familles des énumérations dont chaque nom doit exister dans le `dist` installé (`validate.mjs`). */
export const FAMILLES_NOMMEES = Object.freeze(["hooks", "outils", "mcps", "competences", "commandes", "agents", "fournisseursCoupes"]);

/** Seul champ permis dans une section d'agent ou de catégorie, en plus de la permission épinglée de Prometheus. */
const CHAMP_MODELE = "model";

/**
 * Noms que l'extension lit dans chaque parent du projet, jusqu'à la racine du conteneur (`findProjectConfigPathsFarthestFirst`
 * remonte jusqu'à `/`, car `/workspace` n'est pas sous le HOME). Égal à `nomsPrecontrole` du contrat (test d'égalité) : le
 * pré-contrôle les refuse dans le projet et ses parents jusqu'à `/workspace`, `validate.mjs` à `/` (D-2b-19, C2-14).
 */
export const NOMS_PRECONTROLE_RACINE = Object.freeze({
  fichiers: Object.freeze([
    ".omo/omo.json",
    ".omo/omo.jsonc",
    "oh-my-openagent.json",
    "oh-my-openagent.jsonc",
    "oh-my-opencode.json",
    "oh-my-opencode.jsonc",
    ".mcp.json",
    "opencode.json",
    "opencode.jsonc",
  ]),
  dossiers: Object.freeze([".sisyphus", ".claude", ".opencode", ".agents"]),
});

// --- Lecture JSONC stricte ---------------------------------------------------------------------------------------------------

/** Erreur de lecture d'un texte JSONC, avec sa position. */
export class ErreurJsonc extends Error {
  constructor(message, position) {
    super(`${message} (caractère ${position})`);
    this.name = "ErreurJsonc";
    this.position = position;
  }
}

/** Clés refusées : elles pollueraient les prototypes, et l'extension les ignore en silence (`isUnsafeObjectKey`). */
const CLES_DANGEREUSES = new Set(["constructor", "__proto__", "prototype"]);

const PROFONDEUR_MAX = 64;

/**
 * JSON avec commentaires de ligne et de bloc, SANS virgule finale, SANS clé en double, SANS clé dangereuse. Plus strict que les
 * lecteurs d'opencode et de l'extension : un texte qu'ils liraient autrement qu'ici est refusé, jamais interprété.
 */
export function lireJsonc(texte) {
  if (typeof texte !== "string") throw new ErreurJsonc("texte absent", 0);
  let i = texte.charCodeAt(0) === 0xfeff ? 1 : 0;

  const blancs = () => {
    for (;;) {
      const c = texte[i];
      if (c === " " || c === "\t" || c === "\n" || c === "\r") {
        i += 1;
      } else if (c === "/" && texte[i + 1] === "/") {
        while (i < texte.length && texte[i] !== "\n") i += 1;
      } else if (c === "/" && texte[i + 1] === "*") {
        const fin = texte.indexOf("*/", i + 2);
        if (fin < 0) throw new ErreurJsonc("commentaire non fermé", i);
        i = fin + 2;
      } else {
        return;
      }
    }
  };

  const chaine = () => {
    const debut = i;
    i += 1;
    for (;;) {
      if (i >= texte.length) throw new ErreurJsonc("chaîne non fermée", debut);
      const c = texte[i];
      if (c === "\\") {
        i += 2;
      } else if (c === '"') {
        i += 1;
        break;
      } else if (c < " ") {
        throw new ErreurJsonc("caractère de contrôle dans une chaîne", i);
      } else {
        i += 1;
      }
    }
    try {
      return JSON.parse(texte.slice(debut, i));
    } catch {
      throw new ErreurJsonc("chaîne invalide", debut);
    }
  };

  const valeur = (profondeur) => {
    if (profondeur > PROFONDEUR_MAX) throw new ErreurJsonc("imbrication trop profonde", i);
    blancs();
    const c = texte[i];
    if (c === "{") return objet(profondeur);
    if (c === "[") return tableau(profondeur);
    if (c === '"') return chaine();
    const reste = texte.slice(i, i + 32);
    const litteral = /^(?:true|false|null)(?![A-Za-z0-9_$])/.exec(reste);
    if (litteral) {
      i += litteral[0].length;
      return litteral[0] === "true" ? true : litteral[0] === "false" ? false : null;
    }
    const nombre = /^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/.exec(texte.slice(i, i + 64));
    if (nombre) {
      i += nombre[0].length;
      return Number(nombre[0]);
    }
    throw new ErreurJsonc("valeur attendue", i);
  };

  const objet = (profondeur) => {
    const resultat = {};
    const vues = new Set();
    i += 1;
    blancs();
    if (texte[i] === "}") {
      i += 1;
      return resultat;
    }
    for (;;) {
      blancs();
      if (texte[i] !== '"') throw new ErreurJsonc("clé attendue (virgule finale ?)", i);
      const position = i;
      const cle = chaine();
      if (CLES_DANGEREUSES.has(cle)) throw new ErreurJsonc(`clé refusée : ${cle}`, position);
      if (vues.has(cle)) throw new ErreurJsonc(`clé en double : ${cle}`, position);
      vues.add(cle);
      blancs();
      if (texte[i] !== ":") throw new ErreurJsonc("deux-points attendus", i);
      i += 1;
      resultat[cle] = valeur(profondeur + 1);
      blancs();
      if (texte[i] === ",") {
        i += 1;
        continue;
      }
      if (texte[i] === "}") {
        i += 1;
        return resultat;
      }
      throw new ErreurJsonc("virgule ou accolade attendue", i);
    }
  };

  const tableau = (profondeur) => {
    const resultat = [];
    i += 1;
    blancs();
    if (texte[i] === "]") {
      i += 1;
      return resultat;
    }
    for (;;) {
      blancs();
      if (texte[i] === "]") throw new ErreurJsonc("valeur attendue (virgule finale ?)", i);
      resultat.push(valeur(profondeur + 1));
      blancs();
      if (texte[i] === ",") {
        i += 1;
        continue;
      }
      if (texte[i] === "]") {
        i += 1;
        return resultat;
      }
      throw new ErreurJsonc("virgule ou crochet attendu", i);
    }
  };

  const resultat = valeur(0);
  blancs();
  if (i !== texte.length) throw new ErreurJsonc("texte en trop après la valeur", i);
  return resultat;
}

// --- Outils ----------------------------------------------------------------------------------------------------------------

const estObjet = (v) => v !== null && typeof v === "object" && !Array.isArray(v);

/** Égalité structurelle de deux valeurs JSON (ordre des tableaux compris, ordre des clés ignoré). */
export function egalJson(a, b) {
  if (a === b) return true;
  if (Array.isArray(a) || Array.isArray(b)) {
    return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((x, k) => egalJson(x, b[k]));
  }
  if (estObjet(a) && estObjet(b)) {
    const ka = Object.keys(a);
    const kb = Object.keys(b);
    return ka.length === kb.length && ka.every((k) => Object.hasOwn(b, k) && egalJson(a[k], b[k]));
  }
  return false;
}

const court = (v) => {
  const texte = JSON.stringify(v);
  return texte === undefined ? String(v) : texte.length > 80 ? `${texte.slice(0, 77)}...` : texte;
};

/** Identifiant d'IA de la salle : `github-copilot/<modèle>`, sans espace ni chemin. */
export function estModeleCopilot(valeur) {
  return typeof valeur === "string" && /^github-copilot\/[A-Za-z0-9][A-Za-z0-9._-]*$/.test(valeur);
}

/**
 * G3 statique : parcourt toute la configuration. Toute valeur d'une clé `model` doit être `github-copilot/*` ; les clés
 * `models` et `fallback_models` (listes d'IA de secours) ne sont jamais écrites dans la salle (`model_fallback` coupé).
 */
function verifierModelesPartout(valeur, chemin, messages) {
  if (Array.isArray(valeur)) {
    valeur.forEach((v, k) => verifierModelesPartout(v, `${chemin}[${k}]`, messages));
    return;
  }
  if (!estObjet(valeur)) return;
  for (const [cle, v] of Object.entries(valeur)) {
    const ici = chemin === "" ? cle : `${chemin}.${cle}`;
    if (cle === "model" && !estModeleCopilot(v)) messages.push(`IA hors github-copilot/* : ${ici} = ${court(v)} (G3)`);
    if (cle === "models" || cle === "fallback_models") messages.push(`liste d'IA de secours refusée : ${ici} (G3, model_fallback coupé)`);
    verifierModelesPartout(v, ici, messages);
  }
}

// --- Énumérations de L20 -------------------------------------------------------------------------------------------------------

/** Forme de `enums-4.19.4.json` : version exacte, familles de chaînes, valeurs épinglées. Une forme douteuse est un refus. */
export function verifierEnumerations(enums) {
  const messages = [];
  if (!estObjet(enums)) return ["énumérations illisibles : objet attendu"];
  if (enums.version !== VERSION_EXTENSION) messages.push(`énumérations d'une autre version : ${court(enums.version)}`);
  const familles = [...FAMILLES_NOMMEES, "hooksCoupes", "outilsCoupes", "mcpsCoupes", "competencesCoupees", "commandesCoupees", "agentsCoupes", "cles"];
  for (const famille of familles) {
    const liste = enums[famille];
    if (!Array.isArray(liste) || liste.length === 0 || !liste.every((n) => typeof n === "string" && n !== "")) {
      messages.push(`énumérations : famille ${famille} absente ou mal formée`);
    }
  }
  if (!estObjet(enums.valeurs)) messages.push("énumérations : valeurs épinglées absentes");
  return messages;
}

/** Tous les noms à retrouver dans le `dist` installé : familles de L20 et catégories intégrées. */
export function nomsEnumeres(enums) {
  const noms = [];
  for (const famille of FAMILLES_NOMMEES) {
    for (const nom of Array.isArray(enums?.[famille]) ? enums[famille] : []) noms.push({ famille, nom });
  }
  for (const nom of CATEGORIES_4_19_4) noms.push({ famille: "categories", nom });
  return noms;
}

/**
 * Le nom apparaît-il comme mot entier du texte (ni lettre, chiffre, `_` ni `-` autour) ? La présence dans le `dist` ne prouve
 * pas qu'un nom est permis (`ralph-loop` y figure encore, comme alias déprécié) : c'est l'énumération qui tranche. Elle
 * prouve seulement que le nom n'a pas disparu de la version installée.
 */
export function nomPresentDans(texte, nom) {
  const echappe = nom.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?<![A-Za-z0-9_-])${echappe}(?![A-Za-z0-9_-])`).test(texte);
}

// --- omo.jsonc (spéc. §3.15.1 point 6, D-2b-10, D-2b-47) ---------------------------------------------------------------------------

/**
 * Configuration figée de l'extension, confrontée aux énumérations et aux valeurs épinglées de L20.
 * - Clés écrites : exactement celles qui ont une valeur épinglée, plus `agents` et `categories` (IA de chaque agent et de
 *   chaque catégorie). Une clé connue mais « laissée au défaut » par l'audit est refusée, une clé inconnue aussi.
 * - Listes `disabled_*` : chaînes seulement, chacune dans son énumération, sans doublon, égales à la liste épinglée.
 * - `agents` : chaque agent énuméré, et lui seul, avec une IA `github-copilot/*` ; Prometheus avec sa permission épinglée.
 * - `categories` : chaque catégorie intégrée, et elle seule, avec une IA `github-copilot/*`.
 */
export function verifierOmo(config, enums) {
  const formes = verifierEnumerations(enums);
  if (formes.length > 0) return formes;
  if (!estObjet(config)) return ["omo.jsonc : objet attendu"];
  const messages = [];
  const valeurs = enums.valeurs;
  const cles = new Set(enums.cles);
  const ecrites = new Set([...Object.keys(valeurs), "agents", "categories"]);

  for (const cle of Object.keys(config)) {
    if (!cles.has(cle)) messages.push(`clé inconnue : ${cle}`);
    else if (!ecrites.has(cle)) messages.push(`clé non écrite par la configuration figée (laissée au défaut par l'audit) : ${cle}`);
  }

  for (const [cle, attendu] of Object.entries(valeurs)) {
    if (!Object.hasOwn(config, cle)) {
      messages.push(Object.hasOwn(LISTES_COUPEES, cle) ? `coupure manquante : ${cle}` : `valeur épinglée manquante : ${cle}`);
      continue;
    }
    const obtenu = config[cle];
    if (Object.hasOwn(LISTES_COUPEES, cle)) {
      verifierListeCoupee(cle, obtenu, attendu, enums[LISTES_COUPEES[cle]], messages);
    } else if (cle === "agents") {
      verifierAgents(obtenu, attendu, enums, messages);
    } else if (cle === "team_mode" && !egalJson(obtenu, attendu)) {
      messages.push(`Team Mode doit rester coupé : team_mode = ${court(obtenu)} (Q5)`);
    } else if (!egalJson(obtenu, attendu)) {
      messages.push(`valeur épinglée différente : ${cle} = ${court(obtenu)}, attendu ${court(attendu)}`);
    }
  }

  if (!Object.hasOwn(config, "categories")) messages.push("valeur épinglée manquante : categories (IA de chaque catégorie, G3)");
  else verifierCategories(config.categories, messages);

  verifierModelesPartout(config, "", messages);
  return messages;
}

function verifierListeCoupee(cle, obtenu, attendu, enumeration, messages) {
  if (!Array.isArray(obtenu)) {
    messages.push(`${cle} : liste attendue, obtenu ${court(obtenu)}`);
    return;
  }
  const permis = new Set(enumeration);
  const vus = new Set();
  for (const entree of obtenu) {
    if (typeof entree !== "string") {
      messages.push(`${cle} : entrée non textuelle ${court(entree)}`);
      continue;
    }
    if (!permis.has(entree)) messages.push(`${cle} : nom hors énumération de la ${VERSION_EXTENSION} : ${entree}`);
    else if (!attendu.includes(entree)) messages.push(`${cle} : nom non coupé par l'audit : ${entree}`);
    if (vus.has(entree)) messages.push(`${cle} : nom en double : ${entree}`);
    vus.add(entree);
  }
  for (const nom of attendu) {
    if (!vus.has(nom)) messages.push(`${cle} : coupure manquante : ${nom}`);
  }
}

function verifierAgents(obtenu, attendu, enums, messages) {
  if (!estObjet(obtenu)) {
    messages.push(`agents : objet attendu, obtenu ${court(obtenu)}`);
    return;
  }
  const connus = new Set(enums.agents);
  for (const [nom, section] of Object.entries(obtenu)) {
    if (!connus.has(nom)) {
      messages.push(`agents : agent hors énumération de la ${VERSION_EXTENSION} : ${nom}`);
      continue;
    }
    if (!estObjet(section)) {
      messages.push(`agents.${nom} : objet attendu`);
      continue;
    }
    const epingle = estObjet(attendu[nom]) ? attendu[nom] : {};
    for (const champ of Object.keys(section)) {
      if (champ !== CHAMP_MODELE && !Object.hasOwn(epingle, champ)) messages.push(`agents.${nom} : champ refusé : ${champ}`);
    }
    for (const [champ, valeur] of Object.entries(epingle)) {
      if (!egalJson(section[champ], valeur)) {
        const quoi = nom === "prometheus" && champ === "permission" ? "permission de Prometheus différente de {edit: ask, bash: deny, webfetch: deny} (JS-3)" : `valeur épinglée différente pour ${champ}`;
        messages.push(`agents.${nom} : ${quoi} : ${court(section[champ])}`);
      }
    }
  }
  for (const nom of enums.agents) {
    if (!estObjet(obtenu[nom]) || !Object.hasOwn(obtenu[nom], CHAMP_MODELE)) messages.push(`agents.${nom} : IA non épinglée (G3)`);
  }
  for (const nom of Object.keys(attendu)) {
    if (!connus.has(nom)) messages.push(`agents : valeur épinglée pour un agent hors énumération : ${nom}`);
  }
}

function verifierCategories(obtenu, messages) {
  if (!estObjet(obtenu)) {
    messages.push(`categories : objet attendu, obtenu ${court(obtenu)}`);
    return;
  }
  const connues = new Set(CATEGORIES_4_19_4);
  for (const [nom, section] of Object.entries(obtenu)) {
    if (!connues.has(nom)) {
      messages.push(`categories : catégorie hors des catégories intégrées de la ${VERSION_EXTENSION} : ${nom}`);
      continue;
    }
    if (!estObjet(section)) {
      messages.push(`categories.${nom} : objet attendu`);
      continue;
    }
    for (const champ of Object.keys(section)) {
      if (champ !== CHAMP_MODELE) messages.push(`categories.${nom} : champ refusé : ${champ}`);
    }
  }
  for (const nom of CATEGORIES_4_19_4) {
    if (!estObjet(obtenu[nom]) || !Object.hasOwn(obtenu[nom], CHAMP_MODELE)) messages.push(`categories.${nom} : IA non épinglée (G3)`);
  }
}

// --- opencode.jsonc (spéc. §3.15.1 point 5, D-2b-36, MO-6, MO-9) ---------------------------------------------------------------------

/** Greffons de l'instance, dans cet ordre : l'extension, puis le filet du cockpit (L24). */
export const GREFFONS = Object.freeze([
  "file:///opt/omo/node_modules/oh-my-openagent/dist/index.js",
  "file:///opt/omo-guard/cockpit-guard.js",
]);

/** Adresse de l'API Copilot : même source que la 1.0.3, substituée par opencode au chargement (MO-6). */
export const ADRESSE_COPILOT_CONFIG = "{env:COCKPIT_COPILOT_API_URL}";

/** Hôtes de l'API Copilot (même liste que `COPILOT_API_HOSTS` du cockpit, égalité vérifiée par un test). */
export const COPILOT_HOTES = Object.freeze([
  "api.githubcopilot.com",
  "api.business.githubcopilot.com",
  "api.enterprise.githubcopilot.com",
  "api.individual.githubcopilot.com",
]);

/** Clés de premier niveau permises dans `opencode.jsonc` : tout le reste (mcp, agent, command, instructions…) est refusé. */
const CLES_OPENCODE = new Set([
  "$schema",
  "autoupdate",
  "share",
  "lsp",
  "formatter",
  "snapshot",
  "enabled_providers",
  "disabled_providers",
  "plugin",
  "provider",
  "model",
  "small_model",
  "permission",
]);

/** Valeurs exigées telles quelles. */
const OPENCODE_EPINGLE = Object.freeze({
  $schema: "https://opencode.ai/config.json",
  autoupdate: false,
  share: "disabled",
  lsp: false,
  formatter: false,
  snapshot: false,
  enabled_providers: ["github-copilot"],
  disabled_providers: ["opencode", "opencode-go"],
  plugin: [...GREFFONS],
});

/**
 * Champs permis pour une IA déclarée (MO-9 : le catalogue distant est injoignable depuis le réseau interne). Pas de `cost` :
 * opencode reporte le coût facturé par Copilot, et le cockpit estime avec sa propre grille (`COPILOT_PRICES`) quand il manque ;
 * un second barème écrit ici pourrait s'en écarter. Pas d'`options`, d'`headers` ni de `provider` : rien qui dévie l'appel.
 */
const CHAMPS_MODELE_DECLARE = new Set(["name", "tool_call", "limit"]);

/**
 * Permissions dont la règle porte sur un chemin (read, edit, list) ou sur un motif de fichiers (glob : la règle voit le MOTIF
 * demandé, pas les fichiers trouvés, et l'outil ne rend que des noms) : action de base, puis refus des fichiers de clés et des
 * `.env*`. Les sondes ci-dessous ne valent que pour elles.
 */
export const PERMISSIONS_FICHIERS = Object.freeze({ read: "allow", edit: "ask", glob: "allow", list: "allow" });

/**
 * Permissions à action unique. `grep` refusé en entier : opencode 1.18.30 n'évalue sa règle que sur l'EXPRESSION cherchée
 * (grep.ts : `patterns: [params.pattern]`), et ripgrep lit tout fichier que git n'ignore pas ; des règles par motif de fichiers
 * n'y protégeraient ni les clés ni les `.env`.
 */
const PERMISSIONS_SIMPLES = Object.freeze({ grep: "deny", bash: "ask", task: "ask", webfetch: "deny", websearch: "deny", external_directory: "deny" });

/**
 * Motifs refusés exigés dans chaque permission de fichiers (spéc. l.474) : `.env*` sous toutes ses formes, puis les motifs de
 * fichiers de clés du cockpit (`KEY_FILE_READ_RULES`) et les extensions P03 (l.662), en minuscules et en majuscules (opencode
 * compare avec la casse sous Linux). Égalité avec les listes du cockpit vérifiée par un test.
 */
export const MOTIFS_REFUSES_EXIGES = Object.freeze([
  "*.env",
  "*.env.*",
  ".env*",
  "*/.env*",
  "*.pfx",
  "*.PFX",
  "*.p12",
  "*.P12",
  "*.key",
  "*.KEY",
  "*.jks",
  "*.JKS",
  "*.keystore",
  "*.KEYSTORE",
  "*.kdbx",
  "*.KDBX",
  "*privkey*",
  "*-key.pem",
  "*_key.pem",
  "*id_rsa*",
  "*id_ecdsa*",
  "*id_ed25519*",
  "*kubeconfig*",
  "*.kube/config",
  "*.asc",
  "*.ASC",
  "*.cer",
  "*.CER",
  "*.crt",
  "*.CRT",
  "*.der",
  "*.DER",
  "*.gpg",
  "*.GPG",
  "*.ovpn",
  "*.OVPN",
  "*.p8",
  "*.P8",
  "*.pem",
  "*.PEM",
  "*.tfstate",
  "*.TFSTATE",
  "*.tfvars",
  "*.TFVARS",
]);

/** Motif remis à l'action de base, en DERNIER (la dernière règle qui correspond l'emporte) : `.env.example` jamais refusé. */
export const MOTIF_EXEMPLE = "*.env.example";

/** Chemins relatifs qui doivent être refusés pour chaque permission de fichiers (PERMISSIONS_FICHIERS seulement). */
export const SONDES_REFUSEES = Object.freeze([
  ".env",
  ".env.local",
  ".envrc",
  "app/.env.production",
  "config/prod.env",
  "certs/serveur.key",
  "certs/SERVEUR.KEY",
  "certs/serveur.pfx",
  "certs/serveur.pem",
  "certs/SERVEUR.PEM",
  ".ssh/id_ed25519",
  ".ssh/id_rsa.pub",
  ".kube/config",
  "infra/terraform.tfstate",
  "infra/prod.tfvars",
]);

/** Chemins relatifs qui gardent l'action de base : `.env.example` et des fichiers ordinaires. */
export const SONDES_PERMISES = Object.freeze([".env.example", "app/.env.example", "src/index.ts", "README.md", "scripts/deploy.ps1"]);

/** Portage de `Wildcard.match` d'opencode 1.18.30 : `*` = n'importe quelle suite, `?` = un caractère, casse respectée. */
export function motifCorrespond(entree, motif) {
  let echappe = motif
    .replaceAll("\\", "/")
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, ".*")
    .replace(/\?/g, ".");
  if (echappe.endsWith(" .*")) echappe = `${echappe.slice(0, -3)}( .*)?`;
  return new RegExp(`^${echappe}$`, "s").test(entree.replaceAll("\\", "/"));
}

/** Action d'une permission de fichiers pour une entrée : la DERNIÈRE règle qui correspond l'emporte (opencode). */
export function actionPour(regles, entree) {
  let action = "ask";
  for (const [motif, valeur] of Object.entries(regles)) {
    if (motifCorrespond(entree, motif)) action = valeur;
  }
  return action;
}

/** Texte brut d'`opencode.jsonc` : opencode substitue `{env:…}` et `{file:…}` avant lecture, commentaires compris. */
export function verifierTexteOpencode(texte) {
  const messages = [];
  if (typeof texte !== "string") return ["opencode.jsonc : texte absent"];
  const envs = texte.match(/\{env:[^}]*\}/g) ?? [];
  if (envs.length !== 1 || envs[0] !== ADRESSE_COPILOT_CONFIG) {
    messages.push(`opencode.jsonc : seule substitution permise ${ADRESSE_COPILOT_CONFIG}, trouvé ${court(envs)} (une variable substituée est rendue par GET /config)`);
  }
  if (/\{file:/.test(texte)) messages.push("opencode.jsonc : substitution {file:…} refusée");
  return messages;
}

/** Configuration d'instance de la salle, déjà lue. */
export function verifierOpencode(config) {
  if (!estObjet(config)) return ["opencode.jsonc : objet attendu"];
  const messages = [];
  for (const cle of Object.keys(config)) {
    if (!CLES_OPENCODE.has(cle)) messages.push(`opencode.jsonc : clé refusée : ${cle}`);
  }
  for (const [cle, attendu] of Object.entries(OPENCODE_EPINGLE)) {
    if (!egalJson(config[cle], attendu)) messages.push(`opencode.jsonc : ${cle} = ${court(config[cle])}, attendu ${court(attendu)}`);
  }

  const declares = verifierFournisseur(config.provider, messages);
  for (const cle of ["model", "small_model"]) {
    const valeur = config[cle];
    if (!estModeleCopilot(valeur)) messages.push(`opencode.jsonc : ${cle} hors github-copilot/* : ${court(valeur)} (G3)`);
    else if (!declares.has(valeur.slice(PREFIXE_COPILOT.length))) messages.push(`opencode.jsonc : ${cle} non déclarée dans provider.github-copilot.models : ${valeur}`);
  }

  verifierPermissions(config.permission, messages);
  return messages;
}

function verifierFournisseur(provider, messages) {
  const declares = new Set();
  if (!estObjet(provider) || Object.keys(provider).join(",") !== "github-copilot") {
    messages.push("opencode.jsonc : provider doit porter github-copilot seul");
    return declares;
  }
  const copilot = provider["github-copilot"];
  if (!estObjet(copilot)) {
    messages.push("opencode.jsonc : provider.github-copilot : objet attendu");
    return declares;
  }
  for (const champ of Object.keys(copilot)) {
    if (champ !== "options" && champ !== "models") messages.push(`opencode.jsonc : provider.github-copilot : champ refusé : ${champ}`);
  }
  // Aucun secret dans options : GET /config/providers les rend en clair (MO-6). L'adresse vient de l'environnement.
  if (!egalJson(copilot.options, { baseURL: ADRESSE_COPILOT_CONFIG })) {
    messages.push(`opencode.jsonc : provider.github-copilot.options doit être exactement {baseURL: ${ADRESSE_COPILOT_CONFIG}}`);
  }
  if (!estObjet(copilot.models) || Object.keys(copilot.models).length === 0) {
    messages.push("opencode.jsonc : provider.github-copilot.models : IA déclarées attendues (catalogue distant injoignable, MO-9)");
    return declares;
  }
  for (const [id, modele] of Object.entries(copilot.models)) {
    if (!estModeleCopilot(`${PREFIXE_COPILOT}${id}`) || !estObjet(modele)) {
      messages.push(`opencode.jsonc : IA déclarée invalide : ${court(id)}`);
      continue;
    }
    for (const champ of Object.keys(modele)) {
      if (!CHAMPS_MODELE_DECLARE.has(champ)) messages.push(`opencode.jsonc : IA déclarée ${id} : champ refusé : ${champ}`);
    }
    declares.add(id);
  }
  return declares;
}

function verifierPermissions(permission, messages) {
  if (!estObjet(permission)) {
    messages.push("opencode.jsonc : permission : objet attendu");
    return;
  }
  const permises = new Set([...Object.keys(PERMISSIONS_FICHIERS), ...Object.keys(PERMISSIONS_SIMPLES)]);
  for (const cle of Object.keys(permission)) {
    if (!permises.has(cle)) messages.push(`opencode.jsonc : permission refusée : ${cle}`);
  }
  for (const [cle, attendu] of Object.entries(PERMISSIONS_SIMPLES)) {
    if (permission[cle] !== attendu) messages.push(`opencode.jsonc : permission.${cle} = ${court(permission[cle])}, attendu ${attendu}`);
  }
  for (const [cle, base] of Object.entries(PERMISSIONS_FICHIERS)) {
    const regles = permission[cle];
    if (!estObjet(regles)) {
      messages.push(`opencode.jsonc : permission.${cle} : règles par motif attendues`);
      continue;
    }
    const entrees = Object.entries(regles);
    if (entrees.length === 0 || entrees[0][0] !== "*" || entrees[0][1] !== base) {
      messages.push(`opencode.jsonc : permission.${cle} : première règle attendue « * » = ${base}`);
    }
    if (entrees.length > 0 && (entrees.at(-1)[0] !== MOTIF_EXEMPLE || entrees.at(-1)[1] !== base)) {
      messages.push(`opencode.jsonc : permission.${cle} : dernière règle attendue « ${MOTIF_EXEMPLE} » = ${base}`);
    }
    for (const [motif, action] of entrees) {
      if (action !== base && action !== "deny") messages.push(`opencode.jsonc : permission.${cle} : action ${court(action)} refusée pour ${motif}`);
    }
    for (const motif of MOTIFS_REFUSES_EXIGES) {
      if (regles[motif] !== "deny") messages.push(`opencode.jsonc : permission.${cle} : motif non refusé : ${motif}`);
    }
    for (const sonde of SONDES_REFUSEES) {
      if (actionPour(regles, sonde) !== "deny") messages.push(`opencode.jsonc : permission.${cle} : ${sonde} n'est pas refusé`);
    }
    for (const sonde of SONDES_PERMISES) {
      if (actionPour(regles, sonde) !== base) messages.push(`opencode.jsonc : permission.${cle} : ${sonde} devrait rester à ${base}`);
    }
  }
}

// --- Environnement de la salle (contrôles de démarrage) -----------------------------------------------------------------------------

/**
 * `COCKPIT_COPILOT_API_URL` de la salle : définie et bien formée (MO-6 : absente, opencode la remplace par une chaîne vide sans
 * rien dire, et le premier appel échoue sans nommer la variable). Mêmes règles que `normalizeCopilotApiUrl` du cockpit ; le
 * domaine GitHub Enterprise n'est pas dans la liste blanche de variables de la salle : `copilot-api.<domaine>` est accepté sur
 * sa forme, le cockpit (env.ts) le compare au domaine déclaré et le proxy de sortie limite l'hôte joignable.
 */
export function verifierAdresseCopilot(valeur) {
  if (typeof valeur !== "string" || valeur.trim() === "") return ["COCKPIT_COPILOT_API_URL absente ou vide : l'adresse de l'API Copilot de la salle est inconnue"];
  let url;
  try {
    url = new URL(valeur.trim());
  } catch {
    return [`COCKPIT_COPILOT_API_URL illisible : ${court(valeur)}`];
  }
  if (url.protocol !== "https:" || url.username || url.password || url.port || url.search || url.hash || url.pathname !== "/") {
    return [`COCKPIT_COPILOT_API_URL refusée (https://hôte seulement) : ${court(valeur)}`];
  }
  const hote = url.hostname.toLowerCase();
  const entreprise = /^copilot-api\.(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(hote);
  if (!COPILOT_HOTES.includes(hote) && !entreprise) return [`COCKPIT_COPILOT_API_URL : hôte refusé : ${hote}`];
  return [];
}
