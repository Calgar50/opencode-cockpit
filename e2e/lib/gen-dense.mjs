// Banc e2e (L35) : fixture d'événements DENSE pour la mesure M20 (débit), sans aucune IA ni aucun appel facturé.
//
// M20 (spécification l.1288 ; plan it3 §3.2) : « 4 rendus par seconde, 50 sessions, 3 niveaux ». La capture d'une vraie demande
// de la Salle OMO est faite par L3s-b, hors de cette itération : ici, la suite est SYNTHÉTIQUE et reproductible — 50 sessions sur
// 3 niveaux, des rafales de 200 événements par seconde, rejouées telles quelles par la route de pilotage `POST /banc/emettre` du
// faux opencode, qui les passe à `faux.emit`. Le cockpit les dérive en faits, la page de la salle de contrôle recalcule son plan,
// et le scénario `it3-debit` compte les marques `salle3d:plan` par fenêtre d'une seconde.
//
// Les événements portent les formes réelles d'opencode 1.18.30 : `session.created` (avec `info`, ce qui suffit au cockpit pour
// connaître une session sans aucune requête) puis `message.part.updated` avec des parties `tool`. Aucun texte de message, aucun
// chemin de fichier, aucun secret : les entrées sont des identifiants et des noms d'outils.
//
// Régénérer la fixture : `node e2e/lib/gen-dense.mjs` (écrit e2e/fixtures/it3-dense.jsonl, déterministe).
import fs from "node:fs";
import path from "node:path";

/** Racine du dépôt : e2e/lib → e2e → dépôt. */
const RACINE = path.resolve(import.meta.dirname, "..", "..");

/** Fixture produite et lue par le scénario `it3-debit`. */
export const FIXTURE = path.join(RACINE, "e2e", "fixtures", "it3-dense.jsonl");

/** Marque de la racine dans la fixture : le scénario y met l'identifiant de la conversation qu'il a créée sur le faux. */
export const RACINE_FIXTURE = "RACINE";

/** M20 : 50 sessions sur 3 niveaux, rafales de 200 événements par seconde. */
export const DENSE = { sessions: 50, niveaux: 3, parSeconde: 200, rafales: 4 };

/** Outils cités dans les parties : des noms, jamais un chemin ni un texte. */
const OUTILS = ["read", "grep", "glob", "list", "webfetch"];

/** Générateur déterministe (xorshift 32 bits) : la fixture doit être la même à chaque régénération. */
function alea(graine) {
  let etat = graine >>> 0;
  return () => {
    etat ^= etat << 13;
    etat >>>= 0;
    etat ^= etat >> 17;
    etat ^= etat << 5;
    etat >>>= 0;
    return etat / 0x1_0000_0000;
  };
}

const numero = (n) => String(n).padStart(2, "0");

/**
 * Arbre des sessions : la racine (marque `RACINE`), puis deux niveaux d'enfants. 50 sessions au total, 3 niveaux, chaque
 * session de niveau 3 rattachée à une session de niveau 2 (jamais à la racine : c'est ce qui fait les trois niveaux).
 */
export function arbreDense({ sessions = DENSE.sessions } = {}) {
  const niveau2 = Math.max(1, Math.round((sessions - 1) / 7));
  const liste = [{ id: RACINE_FIXTURE, parent: null, niveau: 1 }];
  for (let i = 0; i < niveau2; i++) liste.push({ id: `n2-${numero(i)}`, parent: RACINE_FIXTURE, niveau: 2 });
  for (let i = 0; liste.length < sessions; i++) liste.push({ id: `n3-${numero(i)}`, parent: `n2-${numero(i % niveau2)}`, niveau: 3 });
  return liste;
}

/** Événement `session.created` d'une session de l'arbre (forme d'opencode : `properties.info`). */
function creation(session, index) {
  return {
    type: "session.created",
    properties: {
      info: {
        id: session.id,
        ...(session.parent === null ? {} : { parentID: session.parent }),
        title: `Étape ${numero(index)}`,
        directory: "/workspace",
        time: { created: 0, updated: 0 },
      },
    },
  };
}

/** Partie d'outil d'un message d'assistant (forme d'opencode : `message.part.updated`). */
function partieOutil(sessionId, messageId, callId, outil, statut) {
  return {
    type: "message.part.updated",
    properties: {
      sessionID: sessionId,
      part: {
        id: `prt-${callId}-${statut}`,
        type: "tool",
        tool: outil,
        callID: callId,
        messageID: messageId,
        sessionID: sessionId,
        state: { status: statut, input: { query: callId }, ...(statut === "completed" ? { output: "lu" } : {}) },
      },
    },
  };
}

/**
 * Suite dense : les créations de sessions d'abord (elles sont rejouées seules, avant la mesure), puis `rafales` rafales de
 * `parSeconde` événements. Chaque rafale répartit ses appels d'outils sur toutes les sessions, avec des identifiants d'appel
 * uniques : aucun fait n'est écarté comme doublon, et la vue change à chaque lot.
 */
export function suiteDense({ sessions = DENSE.sessions, parSeconde = DENSE.parSeconde, rafales = DENSE.rafales } = {}) {
  const arbre = arbreDense({ sessions });
  const hasard = alea(0x3d_11_35);
  const creations = arbre.map((session, index) => creation(session, index));
  const lots = [];
  for (let r = 0; r < rafales; r++) {
    const lot = [];
    while (lot.length < parSeconde) {
      const session = arbre[Math.floor(hasard() * arbre.length)] ?? arbre[0];
      const rang = lot.length;
      const callId = `c${r}-${numero(rang)}`;
      const messageId = `msg-${session.id}-${r}`;
      const outil = OUTILS[Math.floor(hasard() * OUTILS.length)] ?? OUTILS[0];
      lot.push(partieOutil(session.id, messageId, callId, outil, "running"));
      if (lot.length < parSeconde) lot.push(partieOutil(session.id, messageId, callId, outil, "completed"));
    }
    lots.push(lot);
  }
  return { arbre, creations, lots };
}

/** Écrit la fixture JSONL (une ligne par bloc) ; rend le nombre de lignes écrites. */
export function ecrireFixture(chemin = FIXTURE) {
  const { arbre, creations, lots } = suiteDense();
  const lignes = [
    JSON.stringify({ bloc: "entete", sessions: arbre.length, niveaux: DENSE.niveaux, parSeconde: DENSE.parSeconde, rafales: lots.length }),
    ...arbre.map((session) => JSON.stringify({ bloc: "session", id: session.id, parent: session.parent, niveau: session.niveau })),
    ...creations.map((evenement) => JSON.stringify({ bloc: "creation", evenement })),
    ...lots.flatMap((lot, rafale) => lot.map((evenement) => JSON.stringify({ bloc: "rafale", rafale, evenement }))),
  ];
  fs.mkdirSync(path.dirname(chemin), { recursive: true });
  fs.writeFileSync(chemin, `${lignes.join("\n")}\n`, "utf8");
  return lignes.length;
}

/**
 * Relit la fixture et remplace la marque de la racine par la conversation créée sur le faux ; les autres identifiants reçoivent
 * `prefixe`, pour qu'une exécution ne réutilise jamais les identifiants d'une autre. Rend l'entête, les créations et les rafales.
 */
export function chargerFixture({ racine, prefixe = "d", chemin = FIXTURE } = {}) {
  const remplacer = (valeur) => {
    if (typeof valeur === "string") return valeur === RACINE_FIXTURE ? racine : valeur.replaceAll(RACINE_FIXTURE, racine).replaceAll(/\b(n[23])-(\d\d)\b/g, `${prefixe}$1$2`);
    if (Array.isArray(valeur)) return valeur.map(remplacer);
    if (valeur !== null && typeof valeur === "object") return Object.fromEntries(Object.entries(valeur).map(([cle, v]) => [cle, remplacer(v)]));
    return valeur;
  };
  const lignes = fs.readFileSync(chemin, "utf8").split("\n").filter(Boolean).map((ligne) => JSON.parse(ligne));
  const entete = lignes.find((ligne) => ligne.bloc === "entete") ?? { rafales: 0 };
  const creations = lignes.filter((ligne) => ligne.bloc === "creation").map((ligne) => remplacer(ligne.evenement));
  const rafales = [];
  for (const ligne of lignes.filter((l) => l.bloc === "rafale")) {
    (rafales[ligne.rafale] ??= []).push(remplacer(ligne.evenement));
  }
  return { entete, creations, rafales };
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.filename)) {
  const lignes = ecrireFixture();
  console.log(`e2e/fixtures/it3-dense.jsonl : ${lignes} ligne(s).`);
}
