// Banc complet (L21b), instance principale : pose dans les volumes ce qu'un cockpit devant un faux fournisseur hors ligne
// (modèle L7a --reel-hors-ligne) attend AVANT le premier démarrage d'opencode.
//
//   1. la configuration d'opencode (`enabled_providers` réduit au faux fournisseur, aucun secret) dans `oc-config` ;
//   2. un `auth.json` FACTICE à entrée `github-copilot` seule dans `oc-data`, source que la publication d'authentification du
//      cockpit recopie, réduite, vers la salle (D-2b-26). Le jeton est tiré au hasard et jamais affiché ; `expires` lointain,
//      pour qu'aucun rafraîchissement ne parte vers `api.github.com` (banc hors ligne).
//
// Root le temps de poser et de donner à `node` (uid 1000) : ce service jetable sort ensuite. Aucun réseau (network none).
// Aucune dépendance npm (P8).
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { parseArgs } from "node:util";

const { values } = parseArgs({
  options: {
    config: { type: "string" },
    "oc-config": { type: "string" },
    "oc-data": { type: "string" },
  },
  strict: true,
  allowPositionals: false,
});

const refuser = (raison) => {
  process.stderr.write(`prepare-principale : ${raison}\n`);
  process.exit(2);
};

const CONFIG = values.config ?? "";
const OC_CONFIG = values["oc-config"] ?? "";
const OC_DATA = values["oc-data"] ?? "";
for (const [nom, valeur] of [["--config", CONFIG], ["--oc-config", OC_CONFIG], ["--oc-data", OC_DATA]]) {
  if (valeur === "" || !path.isAbsolute(valeur)) refuser(`${nom} : chemin absolu attendu`);
}

// 1. Configuration de l'instance principale, recopiée telle quelle (aucun secret dedans : c'est le levier mesuré par M-B1).
let config;
try {
  config = fs.readFileSync(CONFIG, "utf8");
} catch {
  refuser(`configuration illisible : ${CONFIG}`);
}
fs.mkdirSync(OC_CONFIG, { recursive: true });
fs.writeFileSync(path.join(OC_CONFIG, "opencode.jsonc"), config);

// 2. auth.json FACTICE (github-copilot seule, expires lointain). Jamais affiché, jamais journalisé.
const factice = (quoi) => `FACTICE-banc-${quoi}-${randomBytes(12).toString("hex")}`;
const EXPIRES_LOINTAIN = 4_102_444_800_000; // 2100-01-01
const auth = {
  "github-copilot": { type: "oauth", refresh: factice("refresh"), access: factice("access"), expires: EXPIRES_LOINTAIN },
};
fs.mkdirSync(OC_DATA, { recursive: true });
const cibleAuth = path.join(OC_DATA, "auth.json");
const temporaire = `${cibleAuth}.tmp-${process.pid}`;
fs.writeFileSync(temporaire, `${JSON.stringify(auth)}\n`, { mode: 0o600 });
fs.renameSync(temporaire, cibleAuth);
fs.chmodSync(cibleAuth, 0o600);

// Les deux volumes appartiennent ensuite à node (uid 1000) : opencode et le cockpit y lisent et y écrivent sans root.
for (const racine of [OC_CONFIG, OC_DATA]) {
  const parcourir = (dossier) => {
    fs.chownSync(dossier, 1000, 1000);
    for (const e of fs.readdirSync(dossier, { withFileTypes: true })) {
      const complet = path.join(dossier, e.name);
      if (e.isDirectory()) parcourir(complet);
      else fs.chownSync(complet, 1000, 1000);
    }
  };
  parcourir(racine);
}

// Constat, sans le contenu : ce que la porte relit (« oc-data contient auth.json, oc-config contient opencode.jsonc »).
process.stdout.write(
  `${JSON.stringify({
    pose: true,
    config: fs.readdirSync(OC_CONFIG).sort(),
    data: fs.readdirSync(OC_DATA).sort(),
    entrees: Object.keys(auth),
    modeAuth: (fs.statSync(cibleAuth).mode & 0o777).toString(8),
  })}\n`,
);
