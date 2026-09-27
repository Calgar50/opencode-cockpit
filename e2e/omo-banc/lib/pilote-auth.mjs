// Pilote d'authentification du banc (L21) : dépose dans `omo-auth` l'`auth.json` FACTICE que le cockpit y recopierait.
//
// Ce que MO-9 a mesuré et que ce pilote reproduit :
// - une SEULE entrée, `github-copilot`, de type `oauth` ; le reste d'`auth.json` de l'instance principale n'entre jamais dans
//   la salle (D-2b-26) ;
// - `expires` lointain : avec un jeton d'accès encore valable, opencode ne passe PAS par `/copilot_internal/v2/token`, donc
//   n'appelle jamais `api.github.com`. C'est la condition du banc hors ligne.
//
// Le jeton est FACTICE et tiré au hasard à chaque démarrage : rien ici n'ouvre quoi que ce soit, et aucune valeur n'est
// affichée ni journalisée. Le fichier est écrit en 0600, à `node`, comme le ferait le cockpit.
//
// Le pilote tourne une fois puis sort : le superviseur recopie ensuite `auth.json` lui-même, à l'étape 4.
// Aucune dépendance npm (P8).
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { parseArgs } from "node:util";

const { values } = parseArgs({
  options: { auth: { type: "string" }, sortie: { type: "string" } },
  strict: true,
  allowPositionals: false,
});

const AUTH = values.auth ?? "/omo-auth";
const SORTIE = values.sortie ?? "/banc-out";
const FICHIER = path.join(AUTH, "auth.json");

/** 2100-01-01T00:00:00Z : très au-delà de toute exécution du banc, pour qu'aucun rafraîchissement ne parte. */
const EXPIRES_LOINTAIN = 4_102_444_800_000;

const factice = (quoi) => `FACTICE-banc-${quoi}-${randomBytes(12).toString("hex")}`;

const contenu = {
  "github-copilot": {
    type: "oauth",
    refresh: factice("refresh"),
    access: factice("access"),
    expires: EXPIRES_LOINTAIN,
  },
};

const texte = `${JSON.stringify(contenu)}\n`;
const temporaire = `${FICHIER}.tmp-${process.pid}`;
fs.writeFileSync(temporaire, texte, { mode: 0o600 });
fs.renameSync(temporaire, FICHIER);
fs.chmodSync(FICHIER, 0o600);

// Constat versé au dossier de sortie : ce que la porte G2 relit (« /auth-src ne contient que auth.json »). Jamais le contenu.
const constat = {
  pose: true,
  at: Date.now(),
  fichiers: fs.readdirSync(AUTH).sort(),
  octets: Buffer.byteLength(texte),
  entrees: Object.keys(contenu),
  expires: EXPIRES_LOINTAIN,
  mode: (fs.statSync(FICHIER).mode & 0o777).toString(8),
};
fs.mkdirSync(SORTIE, { recursive: true });
fs.writeFileSync(path.join(SORTIE, "auth-pose.json"), `${JSON.stringify(constat, null, 2)}\n`);
process.stdout.write(`${JSON.stringify(constat)}\n`);
