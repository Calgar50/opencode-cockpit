// Pilote de pré-contrôle du banc (L21) : tient la place du cockpit pour `omo-projets.json` et `precheck-ok`.
//
// Deux modes :
// - `--amorcer` (une fois, avant `opencode-omo`) : recopie dans le volume de contrôle la liste des projets préparés que
//   `install.ps1 -OmoProjetsSeulement` a écrite sur l'hôte. Le superviseur la lit à ses étapes 5 et 7 ; sans elle, aucun
//   projet n'est « préparé » et les mesures M23 et M31 n'auraient rien à observer.
// - défaut (boucle) : lit `state.json`, et pour CHAQUE nouveau `startId` écrit un `precheck-ok` qui lui est rattaché. C'est
//   ce que fait le cockpit après un pré-contrôle réussi (L19b) ; un `precheck-ok` d'un démarrage précédent ne relance rien
//   (T-L17-b), et c'est ce qui rend la relance à neuf (MB-1, MB-2) observable : le banc compte les `startId` vus.
//
// L'empreinte de chaque projet est celle du pré-contrôle réel : SHA-256 du fichier `omo-projets.json` et du chemin. Le
// superviseur ne la relit pas (elle est pour le cockpit) ; elle doit seulement être un SHA-256 bien formé.
//
// Le pilote n'écrit QUE dans `/control`, jamais dans `/workspace` ni dans les dossiers d'opencode. Aucune dépendance npm (P8).
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { parseArgs } from "node:util";

const { values } = parseArgs({
  options: {
    amorcer: { type: "boolean" },
    controle: { type: "string" },
    etat: { type: "string" },
    source: { type: "string" },
    sortie: { type: "string" },
    "periode-ms": { type: "string" },
  },
  strict: true,
  allowPositionals: false,
});

const CONTROLE = values.controle ?? "/control";
const ETAT = values.etat ?? "/omo-state";
const SOURCE = values.source ?? "/banc-source/omo-projets.json";
const SORTIE = values.sortie ?? "/banc-out";
const PERIODE = /^\d{1,6}$/.test(values["periode-ms"] ?? "") ? Number(values["periode-ms"]) : 1000;

const MAX_OCTETS = 1024 * 1024;
const ID_START = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const ecrireAtomique = (cible, texte, mode = 0o644) => {
  const temporaire = `${cible}.tmp-${process.pid}`;
  fs.writeFileSync(temporaire, texte, { mode });
  fs.renameSync(temporaire, cible);
};

const lireBorne = (chemin) => {
  try {
    const stat = fs.statSync(chemin);
    if (!stat.isFile() || stat.size > MAX_OCTETS) return null;
    return fs.readFileSync(chemin, "utf8");
  } catch {
    return null;
  }
};

const sha256 = (texte) => createHash("sha256").update(texte, "utf8").digest("hex");

fs.mkdirSync(SORTIE, { recursive: true });

// --- Amorçage : la liste des projets préparés entre dans le volume de contrôle --------------------------------------------

if (values.amorcer) {
  const texte = lireBorne(SOURCE);
  if (texte === null) {
    process.stderr.write(`pilote-precheck : liste des projets préparés illisible ou trop grosse (${SOURCE})\n`);
    process.exit(2);
  }
  let liste;
  try {
    liste = JSON.parse(texte);
  } catch {
    process.stderr.write("pilote-precheck : liste des projets préparés hors format JSON\n");
    process.exit(2);
  }
  if (liste?.version !== 1 || !Array.isArray(liste.projets)) {
    process.stderr.write("pilote-precheck : liste des projets préparés hors contrat (version 1, projets attendus)\n");
    process.exit(2);
  }
  ecrireAtomique(path.join(CONTROLE, "omo-projets.json"), texte);
  const constat = { amorce: true, at: Date.now(), projets: liste.projets.map((p) => p.chemin), gitProteges: (liste.gitProteges ?? []).length };
  fs.writeFileSync(path.join(SORTIE, "projets-amorce.json"), `${JSON.stringify(constat, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify(constat)}\n`);
  process.exit(0);
}

// --- Boucle : un `precheck-ok` par démarrage -------------------------------------------------------------------------------

const JOURNAL = path.join(SORTIE, "precheck.jsonl");
const vus = new Set();
let arret = false;

const projetsPrepares = () => {
  const texte = lireBorne(path.join(CONTROLE, "omo-projets.json"));
  if (texte === null) return [];
  try {
    const liste = JSON.parse(texte);
    if (!Array.isArray(liste?.projets)) return [];
    return liste.projets.map((p) => ({ chemin: String(p.chemin), sha256: sha256(`${p.chemin}:${p.git}`) }));
  } catch {
    return [];
  }
};

const tour = () => {
  const texte = lireBorne(path.join(ETAT, "state.json"));
  if (texte === null) return;
  let etat;
  try {
    etat = JSON.parse(texte);
  } catch {
    return;
  }
  const startId = etat?.startId;
  if (typeof startId !== "string" || !ID_START.test(startId) || vus.has(startId)) return;
  // `attente` est la phase où le superviseur réclame le pré-contrôle ; on le sert aussi en `verification`, pour n'en manquer
  // aucun quand un démarrage passe vite d'une phase à l'autre.
  if (etat.phase !== "attente" && etat.phase !== "verification") return;
  vus.add(startId);
  const at = Date.now();
  ecrireAtomique(path.join(CONTROLE, "precheck-ok"), `${JSON.stringify({ startId, at, projets: projetsPrepares() })}\n`);
  const ligne = { at, startId, phase: etat.phase, startedAt: etat.startedAt, demarrages: vus.size };
  fs.appendFileSync(JOURNAL, `${JSON.stringify(ligne)}\n`);
  process.stdout.write(`${JSON.stringify(ligne)}\n`);
};

const finir = (signal) => {
  if (arret) return;
  arret = true;
  process.stdout.write(`${JSON.stringify({ arret: signal, demarrages: vus.size })}\n`);
  process.exit(0);
};

process.on("SIGTERM", () => finir("SIGTERM"));
process.on("SIGINT", () => finir("SIGINT"));

process.stdout.write(`${JSON.stringify({ pret: true, mode: "boucle", periodeMs: PERIODE })}\n`);
tour();
setInterval(tour, PERIODE);
