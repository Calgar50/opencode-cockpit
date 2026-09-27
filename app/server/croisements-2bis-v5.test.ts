// Tests de croisement du train de V5 de la Salle OMO, itération 2 ter (plan d'exécution 2 bis-2 ter §2.3, §5.2 ligne V5 ;
// propriété de l'intégrateur) : L26c (e2e de l'interface de la salle, faux), L27a (portes G5, G9, G13), L27b (portes G6, G7, G8),
// DOC-OMO (documentation et recettes en attente).
//
// Ce que la vague doit prouver ENSEMBLE (§5.2, ligne V5), et qu'aucun paquet ne peut prouver seul :
//   1. `SALLE_OUVERTE` reste fausse dans le dépôt livré : aucun fichier suivi ne la bascule ; les deux bancs qui l'ouvrent (e2e
//      « --salle » de L26c, banc complet de L21b que jouent L27a et L27b) ne la basculent que dans une copie ;
//   2. e2e faux complet : le scénario de la salle (L26c) est branché sur ses étapes (douze de L26c, plus « revoir-simple » de la
//      répétition générale « 3s »), « --salle » n'existe qu'en « --faux », la
//      pile de la salle n'utilise jamais l'image réelle de la salle ;
//   3. résultats des portes du banc : les six portes de la vague sont chargées par le banc complet, et le corpus de G7 (L27b) est le
//      reflet exact d'`omo-forbidden` (L22b), vérifié hors Docker ;
//   4. fixtures sans texte de l'extension (D-2b-31) : le corpus de G7 est une fixture ÉCRITE par le cockpit (aucune partie texte,
//      aucun marqueur de l'extension, aucun secret).
//
// Défauts du produit remis par les paquets de la vague, corrigés par ce train (chacun tombe ici sans sa correction) :
//   A. L27b, G7 [competence-course], MOYEN : des « once » décidés par le répondeur (L22d) AVANT un arrêt hors-contrôle attendaient
//      leur tour dans la file du portillon, puis partaient APRÈS la clôture de la demande, et leurs commandes s'exécutaient
//      (reproduit trois fois au banc). Correction : le portillon relit la condition du répondeur (demande active, même racine,
//      même `requestId`) après sa file et sa vérification, juste avant l'inscription (`relayOnce(…, stillAllowed)`) ; le répondeur
//      ne journalise aucune autorisation qui n'est pas partie (croisement 5) ;
//   B. L26c, D-L26c-2, MOYEN : la page de la salle n'écoutait pas `omo.signales` : les fichiers « à relire avant de lancer sur votre
//      poste » de fin de demande (§4.14.5 l.850) n'étaient jamais affichés (croisement 6) ;
//   C. L26c, D-L26c-1, MOYEN : `onClose` recréé à chaque rendu → `Modal` refocalisait le champ du montant à chaque relecture de
//      l'état : le focus était volé (§5.5, P7) (croisement 6).
// Défaut du BANC remis par L27a (n° 1) et L27b (n° 4.1), corrigé ici (le banc hors `portes/` appartient à l'intégrateur en V5) :
//   D. l'espion (L21b) gardait ouvert, muet, le flux relayé au cockpit quand opencode était relancé : le cockpit restait aveugle
//      jusqu'à son chien de garde de 35 s (croisement 7).
// Constats de la relecture 2ter-vague-5, corrigés ensuite (chacun tombe ici sans sa correction) :
//   E. MOYEN : fenêtre résiduelle de A. L'arrêt réel (stopTreeOmo) lit state.json AVANT de clore la demande ; un « once » vérifié
//      pendant cette lecture passait la relecture du répondeur et partait après la détection. Correction : le répondeur tient
//      aussi un arrêt EN COURS (`omoStop.enCours`, posé de façon synchrone par `run`) pour une demande close (croisement 5, avec
//      le vrai createOmoStop et une lecture de state.json retenue) ;
//   F. BAS : une liste de fichiers à relire bornée par la PAGE (200) était dite « incomplète : le cockpit n'a pas pu examiner… »,
//      ce qui est faux (le cockpit a tout examiné) ; deux causes, deux phrases : `incomplet` (descente du serveur) et `masques`
//      (nombre de fichiers relevés non affichés) (croisement 6).
// Le scénario e2e de L26c (étapes « signales » et « focus-ecran ») et la porte G7 de L27b ([competence-course]) sont les preuves
// de bout en bout ; ils se jouent hors de `npm test` (Docker), au train.
// Aucun conteneur, aucun appel Copilot, aucun réseau.
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import type { Cockpit11 } from "./contracts-11.ts";
import { openMemoryDb } from "./db.ts";
import { EventHub } from "./hub.ts";
import { createLogger } from "./log.ts";
import type { OmoActiveRequest, OmoActivationPort, OmoControlPort, OmoRoomPort, OmoStopPort } from "./omo-contracts.ts";
import { createOmoResponder } from "./omo-responder.ts";
import { createOmoStop } from "./omo-stop.ts";
import type { OpencodeClient } from "./opencode.ts";
import { createPermissionGate } from "./permission-gate.ts";
import { SessionTracker } from "./sessions.ts";
import type { ActivityFact } from "./shared/activity-types.ts";
import { TEXTES } from "./shared/omo-room-texts.ts";
import type { OmoSupervisorPhase, OmoSupervisorState } from "./shared/omo-types.ts";
import { until } from "./test-support/helpers.ts";
import { SALLE_OUVERTE } from "./wiring-11.ts";
import { lireSignales, phraseSignalesMasques, SIGNALES_MAX } from "../web/pages/omo/salle-journal.ts";

const RACINE = path.join(import.meta.dirname, "..", "..");
const lire = (...segments: string[]): string => fs.readFileSync(path.join(RACINE, ...segments), "utf8");

// --- 1. SALLE_OUVERTE toujours fausse --------------------------------------------------------------------------------------------

const SALLE_FERMEE = "export const SALLE_OUVERTE = false;";
const SALLE_BASCULEE = "export const SALLE_OUVERTE = true;";
/** Dossiers écartés du parcours : dépendances, sorties de construction, dépôt git. */
const ECARTES = new Set(["node_modules", "dist", ".git", "coverage"]);
const EXTENSIONS = /\.(?:[cm]?[jt]sx?|json|ya?ml|sh|ps1|md)$/;

function fichiersDe(dossier: string, sortie: string[] = []): string[] {
  for (const entree of fs.readdirSync(dossier, { withFileTypes: true })) {
    if (ECARTES.has(entree.name)) continue;
    const chemin = path.join(dossier, entree.name);
    if (entree.isDirectory()) fichiersDe(chemin, sortie);
    else if (entree.isFile() && EXTENSIONS.test(entree.name)) sortie.push(chemin);
  }
  return sortie;
}

describe("croisement 1 : SALLE_OUVERTE reste fausse dans le dépôt livré (plan §2.7)", () => {
  it("la constante vaut false, déclarée une seule fois dans wiring-11.ts", () => {
    assert.equal(SALLE_OUVERTE, false);
    assert.equal(lire("app", "server", "wiring-11.ts").split(SALLE_FERMEE).length, 2);
  });

  it("aucun fichier du dépôt ne porte la bascule, hors des deux bancs qui l'appliquent à une COPIE (tests exceptés)", () => {
    const porteurs = ["app", "docker", "e2e", "scripts", "tests"]
      .map((d) => path.join(RACINE, d))
      .filter((d) => fs.existsSync(d))
      .flatMap((d) => fichiersDe(d))
      .filter((f) => !/\.test\.[cm]?[jt]s$/.test(f) && fs.readFileSync(f, "utf8").includes(SALLE_BASCULEE))
      .map((f) => path.relative(RACINE, f).replaceAll("\\", "/"));
    // e2e « --salle » (L26c) et cockpit réel du banc complet (L21b, joué par L27a et L27b).
    assert.deepEqual(porteurs, ["e2e/lib/docker-e2e.mjs", "e2e/omo-banc/cockpit/preparer.mjs"]);
    // Le banc e2e refuse de basculer ailleurs que dans sa copie, et vérifie que le dépôt la garde fausse.
    const e2e = lire("e2e", "lib", "docker-e2e.mjs");
    assert.match(e2e, /SALLE_OUVERTE ne se bascule que dans la copie du banc/);
    assert.match(e2e, /SALLE_OUVERTE n'est plus fausse dans le dépôt/);
    // Le banc complet bascule dans la copie `git archive` extraite, hors du dépôt.
    assert.match(lire("e2e", "omo-banc", "cockpit", "preparer.mjs"), /SALLE_OUVERTE basculée à true dans la copie jetable \(jamais dans le dépôt\)/);
  });

  it("la documentation du banc complet dit la même règle : copie `git archive`, jamais le dépôt, jamais une variable", () => {
    const readme = lire("e2e", "omo-banc", "README.md");
    assert.match(readme, /copie `git archive`/);
    assert.match(readme, /ne bascule \*\*jamais\*\* `SALLE_OUVERTE` dans le dépôt, et jamais par une variable d'environnement/);
  });
});

// --- 2. e2e faux complet -----------------------------------------------------------------------------------------------------

describe("croisement 2 : e2e de l'interface de la salle (L26c), faux complet", () => {
  const scenario = lire("e2e", "scenarios", "omo-ui-salle.mjs");

  it("le scénario joue ses quatorze étapes, dont « signales » et « focus-ecran » (défauts corrigés par ce train), « temoin-q6 » (GF5) et « revoir-simple » (3s)", () => {
    const table = /const ETAPES = \[([\s\S]*?)\];/.exec(scenario)?.[1] ?? "";
    const etapes = [...table.matchAll(/\["([a-z0-9-]+)",/g)].map((m) => m[1]); // GF5 : chiffres admis (« temoin-q6 »)
    assert.deepEqual(etapes, [
      "prealables",
      "simple",
      "entree",
      "projet-piege",
      "activation",
      "fin-de-demande",
      "signales",
      "suspendue",
      "detection",
      "git-attente",
      "focus-ecran",
      // GF5 (A38 (1)) : étapes 1 à 5 du témoin Q6 de la répétition générale « 3s », versées au dépôt.
      "temoin-q6",
      // Répétition générale « 3s » : « Revoir » en Simple d'une demande terminée de la salle (Q6, D-3d-09).
      "revoir-simple",
      "sans-salle",
    ]);
  });

  it("« --salle » n'existe qu'en « --faux » ; la pile de la salle ne démarre jamais l'image réelle de la salle", () => {
    const e2e = lire("e2e", "lib", "docker-e2e.mjs");
    assert.match(e2e, /if \(salle && mode !== "faux"\) refuser\(/);
    const compose = lire("e2e", "docker-compose.e2e.yml");
    // opencode-omo, egress et omo-init du produit passent dans un profil que le banc ne donne jamais.
    assert.equal(compose.match(/profiles: !override \["jamais-dans-le-banc-e2e"\]/g)?.length, 3);
    // Toute image de la pile e2e est locale : aucune n'est tirée d'un registre.
    const images = compose.match(/^\s{4}image:/gm)?.length ?? 0;
    assert.ok(images > 0);
    assert.equal(compose.match(/^\s{4}pull_policy: never$/gm)?.length, images, "chaque service à image porte pull_policy: never");
  });
});

// --- 3. Résultats des portes du banc --------------------------------------------------------------------------------------------

describe("croisement 3 : portes du banc complet de la vague (L27a, L27b)", () => {
  const PORTES = ["g5-arret.mjs", "g6-plafonds.mjs", "g7-interdits.mjs", "g8-depot-piege.mjs", "g9-cockpit-reel.mjs", "g13-hors-controle.mjs"];

  it("les six portes sont des portes du banc (export par défaut { id, titre, executer }) et rien d'autre n'est dans portes/", () => {
    const dossier = path.join(RACINE, "e2e", "omo-banc", "portes");
    const presentes = fs.readdirSync(dossier).filter((n) => n.endsWith(".mjs"));
    for (const porte of PORTES) assert.ok(presentes.includes(porte), `porte absente : ${porte}`);
    for (const nom of presentes) {
      const source = fs.readFileSync(path.join(dossier, nom), "utf8");
      const defaut = /export default \{([\s\S]*?)\n\};/.exec(source)?.[1] ?? "";
      for (const cle of ["id", "titre", "executer"]) assert.match(defaut, new RegExp(`\\b${cle}\\b`), `${nom} : ${cle} absent de l'export par défaut`);
    }
  });

  it("G7 : le corpus du banc est le reflet exact d'omo-forbidden (L22b), vérifié sans Docker par la porte elle-même", () => {
    const sortie = execFileSync(process.execPath, [path.join(RACINE, "e2e", "omo-banc", "portes", "g7-interdits.mjs"), "--corpus"], {
      cwd: path.join(RACINE, "app"),
      encoding: "utf8",
      timeout: 60_000,
    });
    const points = sortie.split("\n").filter((l) => l.includes("[corpus]"));
    assert.equal(points.length, 4, sortie);
    assert.ok(
      points.every((l) => l.startsWith("✓")),
      sortie,
    );
  });
});

// --- 4. Fixtures sans texte de l'extension -----------------------------------------------------------------------------------------

/** Clés dont la valeur est, dans le flux d'opencode, un texte de message ou de sortie (omo-fixtures.test.ts, L25a). */
const CLES_DE_TEXTE = ["text", "prompt", "output", "content", "delta", "preview", "reasoning", "summary"];

function cles(valeur: unknown, sortie: string[] = []): string[] {
  if (Array.isArray(valeur)) for (const v of valeur) cles(v, sortie);
  else if (valeur && typeof valeur === "object")
    for (const [k, v] of Object.entries(valeur)) {
      sortie.push(k);
      cles(v, sortie);
    }
  return sortie;
}

describe("croisement 4 : fixtures de la vague sans texte de l'extension (D-2b-31)", () => {
  it("corpus/g7.json est écrit par le cockpit : aucune partie texte, aucun marqueur ni préfixe de relance, aucun secret", () => {
    const brut = lire("e2e", "omo-banc", "corpus", "g7.json");
    const corpus = JSON.parse(brut) as { source?: string };
    assert.match(corpus.source ?? "", /Aucune capture/);
    const texte = cles(corpus).filter((k) => CLES_DE_TEXTE.includes(k));
    assert.deepEqual(texte, [], "valeur de texte de message dans le corpus : ce serait une capture");
    for (const marqueur of ["<!-- OMO_INTERNAL_NOREPLY -->", "<!-- OMO_INTERNAL_INITIATOR -->", "[SYSTEM DIRECTIVE: OH-MY-OPENCODE"]) {
      assert.ok(!brut.includes(marqueur), marqueur);
    }
    for (const motif of [/(gh[pousr]_|github_pat_)[A-Za-z0-9_]{16,}/, /\bsk-[A-Za-z0-9]{16,}/, /-----BEGIN [A-Z ]*PRIVATE KEY-----/, /[A-Za-z]:\\Users\\|\/c\/Users\/|AppData/i]) {
      assert.equal(motif.exec(brut), null, String(motif));
    }
  });
});

// --- 5. Portillon : aucun « once » après la clôture de la demande (constat de L27b, G7 [competence-course]) -------------------------

const WORKSPACE = "/workspace";
const PROJET = "projet";
const DOSSIER = `${WORKSPACE}/${PROJET}`;

interface Envoi {
  id: string;
  reply: string;
}

/**
 * Répondeur RÉEL (L22d) sur le portillon RÉEL de la salle (L1b, instance « omo »), face à un faux opencode de la salle : `n`
 * demandes bash de la même réponse (appels en cours, session occupée). La lecture des demandes en attente peut être RETENUE, pour
 * placer la clôture de la demande pendant que les « once » attendent leur tour dans la file.
 */
function atelierPortillon(n: number) {
  const db = openMemoryDb();
  const log = createLogger("error");
  const hub = new EventHub();
  let liberer: () => void = () => undefined;
  let retenir = false;
  const retenue = new Promise<void>((resolve) => {
    liberer = resolve;
  });
  let lecturesEnAttente = 0;
  const enAttente = new Map<string, { id: string; sessionID: string; tool: { messageID: string; callID: string } }>();
  const envois: Envoi[] = [];
  const client = {
    request: async (method: string, pathname: string, options: { body?: { reply?: string } } = {}) => {
      if (method === "GET" && pathname === "/permission") {
        if (retenir) {
          lecturesEnAttente++;
          await retenue;
        }
        return [...enAttente.values()];
      }
      if (method === "GET" && pathname === "/session/status") return { ses_enfant: { type: "busy" } };
      if (method === "GET" && pathname.startsWith("/session/ses_enfant/message/")) {
        return { info: {}, parts: Array.from({ length: n }, (_, i) => ({ type: "tool", callID: `call_${i + 1}`, state: { status: "running" } })) };
      }
      const reponse = /^\/permission\/([^/]+)\/reply$/.exec(pathname);
      if (method === "POST" && reponse) {
        const id = decodeURIComponent(reponse[1] ?? "");
        envois.push({ id, reply: String(options.body?.reply) });
        enAttente.delete(id);
        return true;
      }
      // Arrêt réel de la salle (stopTreeOmo) : abandon des sessions occupées ; la sonde, elle, conclut sur state.json.
      if (method === "POST" && /^\/session\/[^/]+\/abort$/.test(pathname)) return true;
      throw new Error(`requête inattendue : ${method} ${pathname}`);
    },
  } as unknown as OpencodeClient;
  const principal = {
    request: async () => {
      throw new Error("l'instance principale ne doit jamais être interrogée pour la salle");
    },
  } as unknown as OpencodeClient;
  const sessions = new SessionTracker(db, principal);
  sessions.useClient("omo", client);
  const gate = createPermissionGate({ client, db, log, hub, sessions, instance: "omo" });
  const etat = { demande: null as OmoActiveRequest | null };
  const faits: ActivityFact[] = [];
  const evenements: Array<{ type: string; data: unknown }> = [];
  hub.subscribe((e) => {
    if (e.kind === "cockpit") evenements.push({ type: e.type, data: e.data });
  });
  const c11 = {
    db,
    sessions,
    hub,
    log,
    env: { workspaceDir: WORKSPACE },
    instances: { omo: { gate } },
    ports: {
      omoActivation: { activeRequest: () => etat.demande } satisfies Pick<OmoActivationPort, "activeRequest">,
      omoPrecheck: {},
      facts: { append: (f: ActivityFact[]) => void faits.push(...f), work: { markWait: () => true } },
    },
  } as unknown as Cockpit11;
  const service = createOmoResponder(c11);
  const session = (id: string, parentID?: string) =>
    sessions.upsert({ id, projectID: "p", directory: DOSSIER, title: id, time: { created: 1, updated: 1 }, ...(parentID ? { parentID } : {}) }, undefined, { instance: "omo" });
  session("ses_racine");
  session("ses_enfant", "ses_racine");
  db.prepare("INSERT INTO omo_rooms (root_id, projet, created_at) VALUES (?, ?, ?)").run("ses_racine", PROJET, 1);
  /** Publie les `n` demandes (même réponse de l'IA), sans attendre leurs réponses. */
  const demander = (): void => {
    for (let i = 1; i <= n; i++) {
      const tool = { messageID: "msg_1", callID: `call_${i}` };
      enAttente.set(`per_${i}`, { id: `per_${i}`, sessionID: "ses_enfant", tool });
      service.derivation.onEvent(
        {
          directory: DOSSIER,
          payload: {
            id: `evt_${i}`,
            type: "permission.asked",
            properties: { id: `per_${i}`, sessionID: "ses_enfant", permission: "bash", patterns: ["*"], always: ["*"], metadata: { command: `echo competence-${i}` }, tool },
          },
        },
        { instance: "omo" },
      );
    }
  };
  const decisions = () => db.prepare("SELECT permission_id, verdict, relais FROM autonomy_decisions ORDER BY id").all() as Array<{ permission_id: string; verdict: string; relais: string | null }>;
  return {
    c11,
    client,
    db,
    sessions,
    hub,
    log,
    gate,
    etat,
    envois,
    faits,
    evenements,
    service,
    demander,
    decisions,
    retenir: () => {
      retenir = true;
    },
    lecturesEnAttente: () => lecturesEnAttente,
    liberer: () => liberer(),
    activer: (requestId = "req_1") => {
      etat.demande = { rootId: "ses_racine", requestId, startedAt: 1, plafondUsd: "1.00" };
    },
  };
}

/** state.json tel que le superviseur le publie (démarrage `dem_1`). */
function etatSuperviseur(phase: OmoSupervisorPhase): OmoSupervisorState {
  return {
    startId: "dem_1",
    phase,
    imageId: "",
    manifestSha256: "",
    manifesteReference: "ok",
    validation: "ok",
    dossiersConfig: [],
    projets: [{ chemin: PROJET, gitLectureSeule: true }],
    workspaceGit: { verifieLe: 1, limiteAtteinte: false, nonProteges: [] },
    startedAt: 1,
  };
}

/**
 * Arrêt RÉEL de la salle (createOmoStop, L23b) posé comme port `omoStop` de l'atelier, sur le même faux opencode et le même
 * portillon : la demande n'est close qu'à son étape 1, APRÈS la lecture de state.json (étape 0), qui peut être RETENUE (lecture
 * lente du volume omo-state). Le superviseur obéit au stop-request (phase « arret »).
 */
function arretReel(a: ReturnType<typeof atelierPortillon>, options: { etatRetenu?: boolean } = {}) {
  let rendre: () => void = () => undefined;
  const retenue = new Promise<void>((resolve) => {
    rendre = resolve;
  });
  let lectures = 0;
  let arrete = false;
  const omoControl = {
    readState: async () => {
      lectures++;
      if (options.etatRetenu === true && lectures === 1) await retenue;
      return etatSuperviseur(arrete ? "arret" : "opencode-lance");
    },
    requestStop: async () => {
      arrete = true;
    },
    stopHeartbeat: () => undefined,
    suspend: () => undefined,
  } as unknown as OmoControlPort;
  const omoActivation = {
    activeRequest: () => a.etat.demande,
    endRequest: () => {
      a.etat.demande = null;
    },
  } as unknown as OmoActivationPort;
  const omoRoom = { openProjects: () => [], isRoomRoot: (id: string) => id === "ses_racine" } as unknown as OmoRoomPort;
  const stop = createOmoStop(
    {
      instance: () => ({ client: a.client, gate: a.gate }),
      db: a.db,
      sessions: a.sessions,
      hub: a.hub,
      log: a.log,
      workspace: WORKSPACE,
      ports: () => ({ omoControl, omoRoom, omoActivation, facts: a.c11.ports.facts }),
    },
    { sondeFenetreMs: 0, sleep: async () => undefined },
  );
  (a.c11.ports as { omoStop?: OmoStopPort }).omoStop = stop;
  return { stop, rendreEtat: () => rendre(), lecturesEtat: () => lectures };
}

describe("croisement 5 : portillon de la salle, aucun « once » après la clôture de la demande (L22d × L23b, G7 de L27b)", () => {
  it("témoin : demande active pendant toute la file → les cinq « once » partent, cinq décisions « auto » relayées", async () => {
    const a = atelierPortillon(5);
    a.activer();
    a.demander();
    await a.service.settled();
    assert.deepEqual(
      a.envois.map((e) => e.reply),
      ["once", "once", "once", "once", "once"],
    );
    assert.deepEqual(
      a.decisions().map((d) => [d.verdict, d.relais]),
      Array.from({ length: 5 }, () => ["auto", "ok"]),
    );
  });

  it("demande close pendant que les « once » attendent la file (arrêt hors-contrôle) → AUCUN « once », aucune autorisation journalisée", async () => {
    const a = atelierPortillon(5);
    a.activer();
    a.retenir();
    a.demander();
    // Le premier « once » tient la file (vérification en cours) ; les quatre autres attendent leur tour derrière lui.
    await until(() => a.lecturesEnAttente() >= 1);
    // stopTreeOmo, étape 1 : la demande est marquée close, AVANT de prendre la file pour refuser les attentes.
    a.etat.demande = null;
    a.liberer();
    await a.service.settled();
    assert.deepEqual(a.envois, [], "aucune réponse envoyée après la clôture : les commandes ne s'exécutent pas");
    assert.equal(a.gate.emitted.has("per_1"), false, "rien n'est inscrit au registre pour une réponse qui ne part pas");
    assert.deepEqual(a.decisions(), [], "aucune autorisation journalisée : aucune n'a été donnée");
    assert.deepEqual(
      a.evenements.filter((e) => e.type === "autonomie.decision"),
      [],
      "aucun autonomie.decision « auto » après la détection (jugement de G7 [competence-course])",
    );
  });

  it("une NOUVELLE demande de la même racine ne réveille pas les « once » de l'ancienne (même racine, autre requestId)", async () => {
    const a = atelierPortillon(3);
    a.activer("req_1");
    a.retenir();
    a.demander();
    await until(() => a.lecturesEnAttente() >= 1);
    a.activer("req_2");
    a.liberer();
    await a.service.settled();
    assert.deepEqual(a.envois, []);
  });

  it("témoin : arrêt RÉEL (createOmoStop) posé mais au repos → les « once » d'une demande active partent", async () => {
    const a = atelierPortillon(3);
    const arret = arretReel(a);
    a.activer();
    a.demander();
    await a.service.settled();
    assert.equal(arret.stop.enCours?.(), false);
    assert.deepEqual(
      a.envois.map((e) => e.reply),
      ["once", "once", "once"],
    );
  });

  it("arrêt RÉEL dont la lecture de state.json est lente : une vérification rendue pendant cette lecture ne fait partir AUCUN « once » (relecture 2ter-vague-5)", async () => {
    const a = atelierPortillon(3);
    const arret = arretReel(a, { etatRetenu: true });
    a.activer();
    a.retenir();
    a.demander();
    // Le premier « once » tient la file (vérification GET /permission en cours) ; les deux autres attendent derrière lui.
    await until(() => a.lecturesEnAttente() >= 1);
    // Détection hors-contrôle : omo-detections-service.agir appelle omoStop.run, qui lit D'ABORD state.json (étape 0), lentement.
    const resultat = arret.stop.run("ses_racine", "hors-controle");
    // La vérification est rendue PENDANT cette lecture : l'arrêt est parti, la demande n'est pas encore close (étape 1).
    a.liberer();
    await a.service.settled();
    assert.equal(arret.lecturesEtat(), 1, "témoin : l'arrêt est encore dans sa lecture de state.json");
    assert.notEqual(a.etat.demande, null, "témoin : la demande n'est pas encore close par l'arrêt");
    assert.deepEqual(
      a.envois.filter((e) => e.reply === "once"),
      [],
      "aucun « once » après le départ de l'arrêt : leurs commandes s'exécuteraient après la détection",
    );
    for (const id of ["per_1", "per_2", "per_3"]) assert.equal(a.gate.emitted.has(id), false, `${id} : rien d'inscrit pour une réponse qui ne part pas`);
    // L'arrêt se termine : il clôt la demande et refuse TOUTES les attentes de l'instance.
    arret.rendreEtat();
    const fin = await resultat;
    assert.equal(a.etat.demande, null);
    assert.equal(fin.rejected, 3);
    assert.deepEqual(
      a.envois.map((e) => [e.id, e.reply]).sort(),
      [
        ["per_1", "reject"],
        ["per_2", "reject"],
        ["per_3", "reject"],
      ],
      "les trois demandes sont refusées par l'arrêt, aucune n'a reçu « once »",
    );
    assert.deepEqual(a.decisions(), [], "aucune autorisation journalisée : aucune n'a été donnée");
    assert.deepEqual(
      a.evenements.filter((e) => e.type === "autonomie.decision"),
      [],
      "aucun autonomie.decision « auto » après la détection",
    );
    assert.equal(arret.stop.enCours?.(), false, "arrêt fini : plus rien n'est retenu par lui");
  });

  it("portillon seul : condition fausse ou qui lève → « expiree », rien d'inscrit ni d'envoyé ; absente → comportement L1b", async () => {
    for (const [condition, attendu] of [
      [() => false, "expiree"],
      [
        () => {
          throw new Error("illisible");
        },
        "expiree",
      ],
      [() => true, "ok"],
      [undefined, "ok"],
    ] as const) {
      const a = atelierPortillon(1);
      a.demander();
      // Aucune demande active : le répondeur ne répond pas ; le portillon est appelé directement, comme par un service.
      await a.service.settled();
      const sort = await a.gate.relayOnce("per_1", DOSSIER, "cockpit", condition);
      assert.equal(sort, attendu);
      assert.equal(a.envois.length, attendu === "ok" ? 1 : 0);
      assert.equal(a.gate.emitted.has("per_1"), attendu === "ok");
    }
  });
});

// --- 7. Espion du banc : un flux amont coupé coupe le relais aval (constat n° 1 de L27a, n° 4.1 de L27b) ----------------------------

/** Port libre de la boucle locale, rendu aussitôt (le programme l'écoute ensuite). */
async function portLibre(): Promise<number> {
  const s = http.createServer();
  s.listen(0, "127.0.0.1");
  await once(s, "listening");
  const adresse = s.address();
  s.close();
  assert.ok(adresse !== null && typeof adresse === "object");
  return adresse.port;
}

describe("croisement 7 : espion du banc (L21b) × portes de la vague (L27a, L27b)", () => {
  it("opencode relancé (flux amont coupé sans fin) → le flux relayé au cockpit est coupé aussitôt, jamais laissé muet", async (t) => {
    let socketAmont: import("node:net").Socket | null = null;
    const amont = http.createServer((req, res) => {
      if (req.url?.startsWith("/global/event")) {
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.write('data: {"payload":{"type":"server.connected"}}\n\n');
        socketAmont = req.socket;
        return;
      }
      res.writeHead(404).end();
    });
    amont.listen(0, "127.0.0.1");
    await once(amont, "listening");
    t.after(() => amont.close());
    const adresse = amont.address();
    assert.ok(adresse !== null && typeof adresse === "object");
    const sortie = fs.mkdtempSync(path.join(os.tmpdir(), "sal11-v5-espion-"));
    t.after(() => fs.rmSync(sortie, { recursive: true, force: true }));
    const port = await portLibre();
    const enfant = spawn(process.execPath, [path.join(RACINE, "e2e", "omo-banc", "lib", "espion.mjs"), "--port", String(port), "--amont", "127.0.0.1", "--port-amont", String(adresse.port), "--sortie", sortie], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let annonce = "";
    enfant.stdout.on("data", (b: Buffer) => {
      annonce += String(b);
    });
    t.after(async () => {
      enfant.kill();
      await once(enfant, "close").catch(() => undefined);
    });
    await until(() => annonce.includes('"pret":true'), 10_000);

    const recu: string[] = [];
    let coupe = false;
    const requete = http.get({ host: "127.0.0.1", port, path: "/global/event" }, (res) => {
      res.on("data", (b: Buffer) => recu.push(String(b)));
      res.on("close", () => {
        coupe = true;
      });
    });
    requete.on("error", () => {
      coupe = true;
    });
    t.after(() => requete.destroy());
    await until(() => recu.join("").includes("server.connected"), 5_000);
    // Témoin : tant que l'amont vit, le relais reste ouvert.
    await new Promise((r) => setTimeout(r, 200));
    assert.equal(coupe, false, "flux ouvert tant que l'amont vit");
    // opencode relancé : sa connexion tombe, sans fin de flux.
    (socketAmont as import("node:net").Socket | null)?.destroy();
    await until(() => coupe, 3_000);
  });
});

// --- 6. Page de la salle : fichiers à relire et focus (constats D-L26c-1 et D-L26c-2 de L26c) --------------------------------------

describe("croisement 6 : page de la salle, fichiers à relire de fin de demande et focus jamais volé (L26a × L23c × L26c)", () => {
  const page = lire("app", "web", "pages", "omo", "SalleOmoPage.tsx");

  it("la page écoute « omo.signales », le lit avec prudence et le rend avec vueSignales et sa mention d'une liste incomplète", () => {
    assert.match(page, /cockpitEvent\(event, "omo\.signales"\)/);
    assert.match(page, /lireSignales\(finDeDemande\.data\)/);
    assert.match(page, /function BlocSignalesFin[\s\S]*?vueSignales\(lus\.signales\)[\s\S]*?TEXTES\.avance\.signalesFin\.incomplet/);
    assert.match(page, /<BlocSignalesFin lus=\{signalesFin\} \/>/);
    // Les chemins venus du flux sont du texte React, jamais du HTML.
    assert.doesNotMatch(page, /dangerouslySetInnerHTML/);
  });

  it("deux causes, deux phrases (relecture 2ter-vague-5) : « incomplet » seulement pour la descente du cockpit, la borne de la page dite à part", () => {
    const bloc = /function BlocSignalesFin[\s\S]*?\n\}/.exec(page)?.[0] ?? "";
    // La phrase d'une descente incomplète ne suit que `incomplet` ; la borne de la page a sa propre phrase, avec son nombre.
    assert.match(bloc, /\{lus\.incomplet \? <p className="small muted">\{TEXTES\.avance\.signalesFin\.incomplet\}<\/p> : null\}/);
    assert.match(bloc, /\{lus\.masques > 0 \? <p className="small muted">\{phraseSignalesMasques\(lus\.masques\)\}<\/p> : null\}/);
  });

  it("lireSignales : données du flux non fiables — genre inconnu, chemin illisible écartés ; liste bornée, nombre des fichiers non affichés dit", () => {
    assert.equal(lireSignales(null), null);
    assert.equal(lireSignales("omo.signales"), null);
    const lus = lireSignales({
      rootId: "ses_racine",
      incomplet: false,
      signales: [
        { chemin: "projet-a/src/outil.ps1", genre: "programme" },
        { chemin: "projet-a/package.json", genre: "inconnu" },
        { chemin: 42, genre: "programme" },
        { chemin: "", genre: "programme" },
        "projet-a/Makefile",
        { chemin: "projet-a/.vscode/tasks.json", genre: "ide-ci" },
      ],
    });
    assert.deepEqual(lus, {
      rootId: "ses_racine",
      incomplet: false,
      masques: 0,
      signales: [
        { chemin: "projet-a/src/outil.ps1", genre: "programme" },
        { chemin: "projet-a/.vscode/tasks.json", genre: "ide-ci" },
      ],
    });
    assert.deepEqual(lireSignales({ rootId: 7, signales: "x", incomplet: "oui" }), { rootId: null, signales: [], incomplet: false, masques: 0 });
    assert.equal(lireSignales({ signales: [], incomplet: true })?.incomplet, true, "la descente incomplète du cockpit est dite");
    // Le cockpit a tout examiné (incomplet: false) et en relève plus que la page n'en montre (250 `*.ps1` d'une fin de demande) :
    // la liste est bornée ici, le nombre des fichiers non affichés est dit, et la descente n'est PAS dite incomplète (ce serait faux).
    const beaucoup = Array.from({ length: SIGNALES_MAX + 5 }, (_, i) => ({ chemin: `projet-a/f${i}.ps1`, genre: "programme" }));
    const bornes = lireSignales({ rootId: null, signales: beaucoup, incomplet: false });
    assert.equal(bornes?.signales.length, SIGNALES_MAX);
    assert.equal(bornes?.masques, 5, "une liste bornée ici dit combien de fichiers relevés ne sont pas affichés, jamais tue");
    assert.equal(bornes?.incomplet, false, "la borne de la page n'est pas une descente incomplète du cockpit");
    // Au-delà de la borne, seules les entrées lisibles sont comptées : une entrée écartée n'est pas un fichier relevé.
    const melange = [...beaucoup, { chemin: "projet-a/x.ps1", genre: "inconnu" }, { chemin: "", genre: "programme" }, 42];
    assert.equal(lireSignales({ signales: melange, incomplet: false })?.masques, 5);
    // Les deux causes à la fois : chacune est dite.
    const lesDeux = lireSignales({ signales: beaucoup, incomplet: true });
    assert.equal(lesDeux?.incomplet, true);
    assert.equal(lesDeux?.masques, 5);
    // Juste à la borne : rien de masqué.
    assert.equal(lireSignales({ signales: beaucoup.slice(0, SIGNALES_MAX), incomplet: false })?.masques, 0);
  });

  it("les phrases de la carte sont celles de T3a : « à relire avant de lancer sur votre poste », titre, liste incomplète et liste abrégée", () => {
    assert.equal(TEXTES.avance.signales.programme, "à relire avant de lancer sur votre poste");
    assert.equal(TEXTES.avance.signalesFin.titre, "Fichiers à relire");
    assert.match(TEXTES.avance.signalesFin.incomplet, /^Liste incomplète/);
    // La phrase de la borne de la page ne prétend pas que le cockpit n'a pas tout examiné : elle dit ce qui n'est pas affiché.
    assert.doesNotMatch(TEXTES.avance.signalesFin.masques, /incomplète|examiner/);
    assert.match(TEXTES.avance.signalesFin.masques, /non affichés/);
    assert.equal(phraseSignalesMasques(5), TEXTES.avance.signalesFin.masques.replace("{n}", "5"));
    assert.doesNotMatch(phraseSignalesMasques(1), /\{n\}/);
    assert.match(phraseSignalesMasques(1), /\b1\b/);
  });

  it("focus jamais volé : aucun `onClose` écrit en ligne dans les pages de la salle ; l'écran d'activation reçoit une fonction stable", () => {
    const dossier = path.join(RACINE, "app", "web", "pages", "omo");
    for (const nom of fs.readdirSync(dossier).filter((n) => n.endsWith(".tsx"))) {
      const source = fs.readFileSync(path.join(dossier, nom), "utf8");
      assert.doesNotMatch(source, /onClose=\{\s*\(/, `${nom} : onClose écrit en ligne, recréé à chaque rendu (Modal refocalise son premier champ)`);
    }
    assert.match(page, /const fermer = useCallback\(\(\) => setOuvert\(false\), \[\]\);/);
    assert.match(page, /onClose=\{fermer\}/);
  });
});
