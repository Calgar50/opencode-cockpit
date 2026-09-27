// Pilote de battement du banc (L21) : tient la place du cockpit pour le SEUL fichier `heartbeat` du volume de contrôle.
//
// Il tourne dans un conteneur à part, en tant que `node`, sans réseau : le battement est la seule chose qu'il écrit. Arrêter
// ce conteneur, c'est exactement ce que la porte G9 demande — plus aucun battement, sans rien changer d'autre à la salle.
//
// Chaque écriture est notée dans un journal, sur le dossier de sortie monté depuis l'hôte : la porte G9 lit là l'heure du
// DERNIER battement écrit, pour mesurer depuis elle les 27 s de la borne, et jamais depuis l'arrêt du conteneur.
//
// Écriture atomique : fichier temporaire du même dossier, puis `rename`. Le superviseur ne lit jamais un demi-fichier.
// Aucune dépendance npm (P8).
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { parseArgs } from "node:util";

const { values } = parseArgs({
  options: {
    controle: { type: "string" },
    sortie: { type: "string" },
    "periode-ms": { type: "string" },
  },
  strict: true,
  allowPositionals: false,
});

const CONTROLE = values.controle ?? "/control";
const SORTIE = values.sortie ?? "/banc-out";
const PERIODE = /^\d{1,6}$/.test(values["periode-ms"] ?? "") ? Number(values["periode-ms"]) : 5000;
const FICHIER = path.join(CONTROLE, "heartbeat");
const JOURNAL = path.join(SORTIE, "battement.jsonl");

const ecrireAtomique = (cible, texte) => {
  const temporaire = `${cible}.tmp-${process.pid}`;
  fs.writeFileSync(temporaire, texte, { mode: 0o644 });
  fs.renameSync(temporaire, cible);
};

let battements = 0;
let arret = false;

const battre = () => {
  const at = Date.now();
  try {
    ecrireAtomique(FICHIER, `${JSON.stringify({ at })}\n`);
    battements += 1;
    fs.appendFileSync(JOURNAL, `${JSON.stringify({ at, n: battements })}\n`);
  } catch (err) {
    // Un battement raté ne doit pas tuer le pilote : le superviseur le verra périmer, ce qui est le comportement voulu.
    process.stderr.write(`pilote-battement : ${String(err?.message ?? err).slice(0, 200)}\n`);
  }
};

const finir = (signal) => {
  if (arret) return;
  arret = true;
  process.stdout.write(`${JSON.stringify({ arret: signal, battements, dernier: Date.now() })}\n`);
  process.exit(0);
};

fs.mkdirSync(SORTIE, { recursive: true });
process.on("SIGTERM", () => finir("SIGTERM"));
process.on("SIGINT", () => finir("SIGINT"));

battre();
process.stdout.write(`${JSON.stringify({ pret: true, fichier: FICHIER, periodeMs: PERIODE })}\n`);
setInterval(battre, PERIODE);
