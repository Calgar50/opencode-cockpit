// Consignes gardées localement pour « Revoir » (paquet L28d, itération 3 ; U2, D-3d-30) : bornes du module pur, magasin
// revoir_consignes (écriture paramétrée, doublon, borne par conversation sur l'ARBRE, lecture par l'arbre après rattachement d'une
// racine provisoire, clé d'étape d'équipe), nettoyage du texte à l'AFFICHAGE, capture synchrone sur le faux opencode avec le
// processeur réel, purge avec la conversation (D-07), et la garantie centrale : le texte d'une consigne n'est JAMAIS journalisé ni
// publié dans un événement du cockpit.
// Textes des fixtures : « [synthétique] », jamais un extrait réel. Le jeton factice des tests est CONSTRUIT À L'EXÉCUTION : aucun
// secret, même factice, n'est écrit en clair dans le dépôt.
// Salle branchée (« 3s », L3s-a) : capture sur le processeur de la SALLE (h.emitOmo), mêmes bornes et masquage, partie ajoutée par
// un crochet jamais lue, cloison des instances (P11) dans les deux sens, inscription seulement quand la salle existe, journal.
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { describe, it, type TestContext } from "node:test";
import { CONSIGNES_DERIVATION, CONSIGNES_DERIVATION_SALLE, createConsignesDerivation } from "./consignes-capture.ts";
import { type ConsigneAGarder, createConsignesStore, PAR_ENFANT_MAX, purgeConsignes } from "./consignes-store.ts";
import type { EventDerivation } from "./contracts-11.ts";
import { openMemoryDb } from "./db.ts";
import type { Logger } from "./log.ts";
import type { OcSession, OpencodeClient } from "./opencode.ts";
import { EventProcessor } from "./processor.ts";
import { redactSecrets } from "./redact.ts";
import { SessionTracker } from "./sessions.ts";
import { bornerConsigne, CONSIGNES, pointsDeCode } from "./shared/consignes.ts";
import { nettoyerTexteIa } from "./shared/texte-ia.ts";
import { type CockpitHarness, startCockpit } from "./test-support/cockpit-harness.ts";
import { readCapture } from "./test-support/fake-opencode.ts";
import { until } from "./test-support/helpers.ts";

/** Racine des captures p1 et p2 (expérience « ocgraph », opencode 1.18.30). */
const ROOT = "ses_f618ff214ffevi6gfuGx6TvpTP";
const AUTRE = "ses_autre_racine";
/** Arbre de la conversation : la fille et la petite-fille, pour le cas « enregistrée avant ses ancêtres » (racine provisoire). */
const FILLE = "ses_fille_de_la_racine";
const PETITE_FILLE = "ses_petite_fille";

/** Session telle qu'opencode la rend, pour SessionTracker.upsert (même forme que migration5.test.ts). */
const session = (id: string, parentID?: string): OcSession => ({
  id,
  projectID: "p",
  directory: "/workspace/app",
  title: `Session ${id}`,
  time: { created: 1_000, updated: 1_000 },
  ...(parentID ? { parentID } : {}),
});

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

/** Emoji d'essai (paire de substitution), construit à l'exécution pour ne dépendre d'aucun encodage de fichier. */
const EMOJI = String.fromCodePoint(0x1f600);

/**
 * Jeton factice reconnu par redactSecrets, assemblé à l'exécution : jamais écrit en clair dans le dépôt (règle de L28d). La forme
 * suivie est celle d'un jeton GitHub personnel.
 */
const jetonFactice = (): string => `gh${String.fromCharCode(112)}${String.fromCharCode(95)}${randomBytes(16).toString("hex")}`;

// --- Journal espion --------------------------------------------------------------------------------------------------------------

interface LigneJournal {
  niveau: string;
  message: string;
  champs: Record<string, unknown>;
  brut: string;
}

interface JournalEspion {
  log: Logger;
  lignes: LigneJournal[];
  texte(): string;
}

/** Journal qui garde tout ce qui lui est passé, message et champs : le contrôle « jamais journalisée » le relit en entier. */
function journalEspion(): JournalEspion {
  const lignes: LigneJournal[] = [];
  const noter = (niveau: string) => (message: string, fields?: Record<string, unknown>) => {
    let serialise = "";
    try {
      serialise = fields === undefined ? "" : JSON.stringify(fields, (_cle, valeur: unknown) => (valeur instanceof Error ? `${valeur.name}: ${valeur.message}` : valeur));
    } catch {
      serialise = String(fields);
    }
    lignes.push({ niveau, message, champs: fields ?? {}, brut: `${niveau} ${message} ${serialise}` });
  };
  return {
    log: { debug: noter("debug"), info: noter("info"), warn: noter("warn"), error: noter("error") },
    lignes,
    texte: () => lignes.map((l) => l.brut).join("\n"),
  };
}

/** Sous-chaînes de `taille` caractères d'un texte : aucune ne doit apparaître dans le journal ni dans un événement du cockpit. */
function morceaux(texte: string, taille = 12): string[] {
  const out: string[] = [];
  for (let i = 0; i + taille <= texte.length; i++) out.push(texte.slice(i, i + taille));
  return out;
}

function assertAucunMorceau(ou: string, textes: readonly string[], etiquette: string): void {
  for (const texte of textes) {
    for (const morceau of morceaux(texte)) {
      assert.equal(ou.includes(morceau), false, `${etiquette} : « ${morceau} » recopié`);
    }
  }
}

// --- Captures --------------------------------------------------------------------------------------------------------------------

interface ConsigneAttendue {
  parent: string;
  callId: string;
  enfant: string;
  prompt: string;
}

/**
 * Consignes qu'une capture doit faire garder : partie `task` à l'état `running`, avec un enfant connu et un prompt. La première
 * vue d'un couple (parent, callId) l'emporte, comme INSERT OR IGNORE.
 */
function consignesDeLaCapture(nom: string): ConsigneAttendue[] {
  const out: ConsigneAttendue[] = [];
  const vues = new Set<string>();
  for (const { wire } of readCapture(nom)) {
    const payload = wire.payload as unknown as { type?: string; properties?: unknown };
    if (payload.type !== "message.part.updated") continue;
    const properties = isRecord(payload.properties) ? payload.properties : null;
    const part = isRecord(properties?.part) ? properties.part : null;
    if (part === null || part.type !== "tool" || part.tool !== "task") continue;
    const state = isRecord(part.state) ? part.state : null;
    if (state === null || state.status !== "running") continue;
    const input = isRecord(state.input) ? state.input : null;
    const metadata = isRecord(state.metadata) ? state.metadata : null;
    const enfant = typeof metadata?.sessionId === "string" ? metadata.sessionId : null;
    const callId = typeof part.callID === "string" ? part.callID : null;
    const parent = typeof part.sessionID === "string" ? part.sessionID : null;
    const prompt = typeof input?.prompt === "string" ? input.prompt : null;
    if (enfant === null || callId === null || parent === null || prompt === null) continue;
    const cle = `${parent}|${callId}`;
    if (vues.has(cle)) continue;
    vues.add(cle);
    out.push({ parent, callId, enfant, prompt });
  }
  return out;
}

interface LigneConsigne {
  root_id: string;
  parent_session_id: string;
  enfant_session_id: string | null;
  call_id: string;
  texte: string;
  longueur: number;
  tronque: number;
  at: number;
}

const lignes = (h: CockpitHarness, root?: string): LigneConsigne[] =>
  (root === undefined
    ? h.db.prepare("SELECT root_id, parent_session_id, enfant_session_id, call_id, texte, longueur, tronque, at FROM revoir_consignes ORDER BY at, id").all()
    : h.db
        .prepare("SELECT root_id, parent_session_id, enfant_session_id, call_id, texte, longueur, tronque, at FROM revoir_consignes WHERE root_id = ? ORDER BY at, id")
        .all(root)) as unknown as LigneConsigne[];

/**
 * Événement `message.part.updated` d'une partie d'outil, comme opencode 1.18.30. Par défaut : l'outil `task` à l'état `running`,
 * c'est-à-dire l'instant où l'enfant reçoit sa consigne. `statut` et `outil` servent aux cas qui ne doivent RIEN faire garder.
 */
const evenementTask = (
  h: CockpitHarness,
  options: { parent: string; callId: string; enfant: string | null; prompt: string; statut?: string; outil?: string },
) =>
  h.fake.emit({
    type: "message.part.updated",
    properties: {
      sessionID: options.parent,
      part: {
        id: `prt_${options.callId}`,
        messageID: `msg_${options.callId}`,
        sessionID: options.parent,
        type: "tool",
        tool: options.outil ?? "task",
        callID: options.callId,
        state: {
          status: options.statut ?? "running",
          title: "[synthétique]",
          input: { description: "[synthétique]", prompt: options.prompt },
          metadata: options.enfant === null ? {} : { parentSessionId: options.parent, sessionId: options.enfant },
        },
      },
      time: 1,
    },
  });

// --- Bornes (module pur) ---------------------------------------------------------------------------------------------------------

describe("consignes gardées : bornes (shared/consignes.ts, module pur)", () => {
  it("texte court : gardé tel quel, longueur en points de code, jamais tronqué", () => {
    const brut = `[synthétique] consigne ${EMOJI} de deux lignes\nsuite`;
    const borne = bornerConsigne(brut, (t) => t);
    assert.equal(borne.texte, brut);
    assert.equal(borne.longueur, pointsDeCode(brut));
    assert.equal(borne.longueur, brut.length - 1, "l'emoji compte pour un point de code");
    assert.equal(borne.tronque, false);
  });

  it("8 001 caractères : 8 000 gardés, tronque, longueur d'origine 8 001", () => {
    const brut = "a".repeat(CONSIGNES.maxCaracteres + 1);
    const borne = bornerConsigne(brut, (t) => t);
    assert.equal(pointsDeCode(borne.texte), CONSIGNES.maxCaracteres);
    assert.equal(borne.texte.length, CONSIGNES.maxCaracteres);
    assert.equal(borne.longueur, CONSIGNES.maxCaracteres + 1);
    assert.equal(borne.tronque, true);
  });

  it("un emoji à la coupe n'est jamais scindé (paire de substitution gardée entière)", () => {
    const brut = `${"a".repeat(CONSIGNES.maxCaracteres - 1)}${EMOJI}c`;
    const borne = bornerConsigne(brut, (t) => t);
    assert.equal(borne.texte, `${"a".repeat(CONSIGNES.maxCaracteres - 1)}${EMOJI}`);
    assert.equal(pointsDeCode(borne.texte), CONSIGNES.maxCaracteres);
    // Aucune moitié de paire laissée seule.
    for (let i = 0; i < borne.texte.length; i++) {
      const code = borne.texte.charCodeAt(i);
      if (code >= 0xd800 && code <= 0xdbff) assert.ok(borne.texte.charCodeAt(i + 1) >= 0xdc00, `substitut seul en ${i}`);
      if (code >= 0xdc00 && code <= 0xdfff) assert.ok(i > 0 && borne.texte.charCodeAt(i - 1) <= 0xdbff, `bas substitut seul en ${i}`);
    }
    assert.equal(borne.tronque, true);
  });

  it("lecture bornée à 64 000 unités, sans couper une paire, AVANT le masquage", () => {
    let recu = "";
    const brut = `${"a".repeat(CONSIGNES.lectureMax - 1)}${EMOJI}${"b".repeat(100)}`;
    const borne = bornerConsigne(brut, (t) => {
      recu = t;
      return t;
    });
    // La coupe de lecture tombe au milieu de l'emoji : sa première moitié est retirée, jamais passée au masquage.
    assert.equal(recu.length, CONSIGNES.lectureMax - 1);
    assert.equal(recu, "a".repeat(CONSIGNES.lectureMax - 1));
    // Le masquage voit bien plus que ce qui est gardé : il passe donc AVANT la coupe à maxCaracteres.
    assert.ok(recu.length > CONSIGNES.maxCaracteres);
    assert.equal(borne.longueur, pointsDeCode(brut));
    assert.equal(borne.tronque, true);
  });

  it("masquage avant la coupe : un secret reconnu près de la limite disparaît, et la coupe porte sur le texte masqué", () => {
    const jeton = jetonFactice();
    // Espaces autour du jeton : redactSecrets reconnaît un mot entier (), comme dans un texte réel.
    const brut = `${"a".repeat(CONSIGNES.maxCaracteres - 12)} ${jeton} ${"b".repeat(50)}`;
    const borne = bornerConsigne(brut, redactSecrets);
    assert.equal(borne.texte.includes(jeton), false, "jeton gardé en base");
    assert.equal(borne.texte.includes(jeton.slice(8, 24)), false, "morceau du jeton gardé");
    assert.ok(borne.texte.includes(`gh_${"*".repeat(4)}`), "jeton remplacé par le masque");
    assert.equal(pointsDeCode(borne.texte), CONSIGNES.maxCaracteres);
    assert.equal(borne.tronque, true);
  });
});

// --- Nettoyage à l'affichage (corrections de la relecture 3-vague-1) --------------------------------------------------------------

describe("consignes gardées : nettoyage à l'AFFICHAGE (server/shared/texte-ia.ts)", () => {
  it("marque de sens d'écriture et séquence de terminal retirées ; le reste du texte est gardé tel quel", () => {
    // Caractères construits à l'exécution, jamais écrits en clair (même règle que le jeton factice).
    const rtlOverride = String.fromCharCode(0x202e);
    const isolant = String.fromCharCode(0x2066);
    const couleur = `${String.fromCharCode(27)}[31m`;
    const fin = `${String.fromCharCode(27)}[0m`;
    const brut = `${couleur}[synthétique] lis ${rtlOverride}le fichier${isolant}${fin}\tsuite${String.fromCharCode(0)}`;

    const propre = nettoyerTexteIa(brut);
    assert.equal(propre, "[synthétique] lis le fichier\tsuite");
    assert.equal(propre.includes(rtlOverride), false, "U+202E retiré : le texte ne se lit plus à l'envers (« Trojan Source »)");
    assert.equal(propre.includes(isolant), false);
    assert.equal(propre.includes(String.fromCharCode(27)), false, "séquences de terminal retirées");
    assert.equal(nettoyerTexteIa(42), "");
    assert.equal(nettoyerTexteIa(null), "");
  });

  it("le nettoyage est fait à l'affichage SEULEMENT : la copie gardée reste fidèle aux octets envoyés (U2, D-3d-30)", () => {
    const rtlOverride = String.fromCharCode(0x202e);
    const db = openMemoryDb();
    const store = createConsignesStore(db);
    const brut = `[synthétique] ${rtlOverride}consigne`;
    assert.equal(store.enregistrer({ rootId: ROOT, parent: ROOT, enfant: "ses_enfant1", callId: "call_bidi", brut, at: 1_000 }), "enregistree");
    assert.equal(store.lire(ROOT, "call_bidi")?.texte, brut, "la base garde ce qui a été envoyé");
    assert.equal(nettoyerTexteIa(store.lire(ROOT, "call_bidi")?.texte).includes(rtlOverride), false, "c'est l'affichage qui nettoie");
    db.close();
  });
});

// --- Magasin ---------------------------------------------------------------------------------------------------------------------

describe("consignes gardées : magasin (revoir_consignes)", () => {
  const consigne = (extra: Partial<ConsigneAGarder> = {}): ConsigneAGarder => ({
    rootId: ROOT,
    parent: ROOT,
    enfant: "ses_enfant1",
    callId: "call_1",
    brut: "[synthétique] consigne gardée",
    at: 1_000,
    ...extra,
  });

  it("enregistre, relit par callId et par enfant ; une autre racine n'est jamais rendue", () => {
    const db = openMemoryDb();
    const store = createConsignesStore(db);
    assert.equal(store.enregistrer(consigne()), "enregistree");
    assert.equal(store.enregistrer(consigne({ rootId: AUTRE, parent: AUTRE, callId: "call_2", brut: "[synthétique] autre racine", at: 2_000 })), "enregistree");

    const lue = store.lire(ROOT, "call_1");
    assert.deepEqual(lue, { rootId: ROOT, callId: "call_1", enfant: "ses_enfant1", texte: "[synthétique] consigne gardée", longueur: 29, tronque: false, at: 1_000 });
    assert.equal(store.lire(ROOT, "call_2"), null, "consigne d'une autre racine");
    assert.equal(store.lire(ROOT, "call_inconnu"), null);
    assert.deepEqual(store.parEnfant(ROOT, "ses_enfant1"), [lue]);
    assert.deepEqual(store.parEnfant(ROOT, "ses_enfant_inconnu"), []);
    assert.deepEqual(store.parEnfant(AUTRE, "ses_enfant1").map((c) => c.callId), ["call_2"]);
    db.close();
  });

  it("racine provisoire puis rattachement : la consigne est retrouvée par la VRAIE racine, comme la purge et les faits", () => {
    // Un événement de la petite-fille arrive avant que sa mère soit connue : SessionTracker l'enregistre sous la racine
    // PROVISOIRE (la mère), et la dérivation écrit la consigne avec ce root_id. Quand la mère arrive, #reparent remet
    // sessions.root_id à la vraie racine, mais revoir_consignes garde la racine provisoire : la lecture doit donc passer par
    // l'ARBRE (TREE_SQL), comme purgeConsignes, fact-store.since et routes-activity.
    const db = openMemoryDb();
    const sessions = new SessionTracker(db, {} as OpencodeClient);
    const store = createConsignesStore(db);
    sessions.upsert(session(ROOT));
    sessions.upsert(session(PETITE_FILLE, FILLE)); // racine provisoire : FILLE
    assert.equal(sessions.rootOf(PETITE_FILLE), FILLE, "racine provisoire avant rattachement");
    assert.equal(store.enregistrer(consigne({ rootId: FILLE, parent: FILLE, enfant: PETITE_FILLE, callId: "call_provisoire" })), "enregistree");
    sessions.upsert(session(FILLE, ROOT)); // rattachement
    assert.equal(sessions.rootOf(PETITE_FILLE), ROOT);
    assert.equal(
      (db.prepare("SELECT root_id FROM revoir_consignes WHERE call_id = ?").get("call_provisoire") as { root_id: string }).root_id,
      FILLE,
      "la ligne garde sa racine provisoire : c'est la LECTURE qui doit suivre l'arbre",
    );

    assert.equal(store.lire(ROOT, "call_provisoire")?.callId, "call_provisoire", "lire() par la vraie racine");
    assert.deepEqual(store.parEnfant(ROOT, PETITE_FILLE).map((c) => c.callId), ["call_provisoire"], "parEnfant() par la vraie racine");
    assert.equal(purgeConsignes(db, ROOT), 1, "la purge portait déjà sur l'arbre : lecture et purge restent solidaires");

    // Non-régression : une consigne d'une AUTRE conversation n'est jamais rendue par l'arbre.
    assert.equal(store.enregistrer(consigne({ rootId: AUTRE, parent: AUTRE, enfant: "ses_enfant_autre", callId: "call_ailleurs" })), "enregistree");
    assert.equal(store.lire(ROOT, "call_ailleurs"), null);
    assert.deepEqual(store.parEnfant(ROOT, "ses_enfant_autre"), []);
    db.close();
  });

  it("borne par conversation : comptée sur l'ARBRE entier, racine provisoire comprise, jamais deux fois la borne", () => {
    const db = openMemoryDb();
    const sessions = new SessionTracker(db, {} as OpencodeClient);
    const store = createConsignesStore(db);
    sessions.upsert(session(ROOT));
    sessions.upsert(session(PETITE_FILLE, FILLE)); // racine provisoire : FILLE
    // Une moitié des copies écrite sous la racine provisoire, l'autre sous la vraie racine : une seule conversation.
    for (let i = 0; i < CONSIGNES.parRacine; i++) {
      const ou = i % 2 === 0 ? { rootId: FILLE, parent: FILLE, enfant: PETITE_FILLE } : { rootId: ROOT, parent: ROOT };
      assert.equal(store.enregistrer(consigne({ ...ou, callId: `call_${i}`, at: i })), "enregistree", `consigne ${i}`);
    }
    sessions.upsert(session(FILLE, ROOT)); // rattachement : l'arbre est enfin connu
    assert.equal(store.enregistrer(consigne({ callId: "call_de_trop", at: 9_999 })), "limite", "la borne voit les copies des deux côtés de l'arbre");
    db.close();
  });

  it("doublon : le même couple (parent, callId) n'est gardé qu'une fois, le premier texte l'emporte", () => {
    const db = openMemoryDb();
    const store = createConsignesStore(db);
    assert.equal(store.enregistrer(consigne()), "enregistree");
    assert.equal(store.enregistrer(consigne({ brut: "[synthétique] réémission", at: 3_000 })), "doublon");
    assert.equal((db.prepare("SELECT COUNT(*) AS n FROM revoir_consignes").get() as { n: number }).n, 1);
    assert.equal(store.lire(ROOT, "call_1")?.texte, "[synthétique] consigne gardée");
    db.close();
  });

  it("borne par conversation : la 501e consigne d'une racine rend « limite » et n'écrit rien", () => {
    const db = openMemoryDb();
    const store = createConsignesStore(db);
    for (let i = 0; i < CONSIGNES.parRacine; i++) {
      assert.equal(store.enregistrer(consigne({ callId: `call_${i}`, at: i })), "enregistree", `consigne ${i}`);
    }
    const avant = (db.prepare("SELECT COUNT(*) AS n FROM revoir_consignes").get() as { n: number }).n;
    assert.equal(avant, CONSIGNES.parRacine);
    assert.equal(store.enregistrer(consigne({ callId: "call_de_trop", at: 9_999 })), "limite");
    assert.equal((db.prepare("SELECT COUNT(*) AS n FROM revoir_consignes").get() as { n: number }).n, avant);
    assert.equal(store.lire(ROOT, "call_de_trop"), null);
    // Une autre conversation garde son propre compte.
    assert.equal(store.enregistrer(consigne({ rootId: AUTRE, parent: AUTRE, callId: "call_de_trop" })), "enregistree");
    db.close();
  });

  it("clé d'étape d'équipe (D-3d-30) : « etape-1-1-<session> » acceptée ; un deux-points rend « cle-invalide » sans rien écrire", () => {
    const db = openMemoryDb();
    const store = createConsignesStore(db);
    const etape = `etape-1-1-${"ses_etape1"}`;
    assert.equal(store.enregistrer(consigne({ callId: etape, enfant: "ses_etape1", brut: "[synthétique] consigne d'étape" })), "enregistree");
    assert.deepEqual(store.parEnfant(ROOT, "ses_etape1").map((c) => c.callId), [etape]);

    for (const mauvaise of [`etape:1:1:${"ses_etape2"}`, "", "a".repeat(129), "call avec espace"]) {
      assert.equal(store.enregistrer(consigne({ callId: mauvaise, enfant: "ses_etape2" })), "cle-invalide", mauvaise);
    }
    // Identifiants de session refusés de la même façon, rien d'écrit.
    assert.equal(store.enregistrer(consigne({ rootId: "ses.point", callId: "call_x" })), "cle-invalide");
    assert.equal(store.enregistrer(consigne({ parent: "ses/point", callId: "call_y" })), "cle-invalide");
    assert.equal(store.enregistrer(consigne({ enfant: "ses point", callId: "call_z" })), "cle-invalide");
    assert.equal((db.prepare("SELECT COUNT(*) AS n FROM revoir_consignes").get() as { n: number }).n, 1);
    db.close();
  });

  it("deux tours d'une même session : deux lignes, rendues dans l'ordre de `at` ; 20 au plus", () => {
    const db = openMemoryDb();
    const store = createConsignesStore(db);
    // Écrits dans le désordre : c'est `at` qui ordonne, pas l'écriture.
    assert.equal(store.enregistrer(consigne({ callId: "etape-2-1-ses_etape1", enfant: "ses_etape1", brut: "[synthétique] tour 2", at: 2_000 })), "enregistree");
    assert.equal(store.enregistrer(consigne({ callId: "etape-1-1-ses_etape1", enfant: "ses_etape1", brut: "[synthétique] tour 1", at: 1_000 })), "enregistree");
    assert.deepEqual(store.parEnfant(ROOT, "ses_etape1").map((c) => [c.at, c.texte]), [
      [1_000, "[synthétique] tour 1"],
      [2_000, "[synthétique] tour 2"],
    ]);

    for (let i = 0; i < PAR_ENFANT_MAX + 5; i++) store.enregistrer(consigne({ callId: `call_m_${i}`, enfant: "ses_etape9", at: 10_000 + i }));
    const rendues = store.parEnfant(ROOT, "ses_etape9");
    assert.equal(rendues.length, PAR_ENFANT_MAX);
    assert.deepEqual(rendues.map((c) => c.at), Array.from({ length: PAR_ENFANT_MAX }, (_, i) => 10_000 + i));
    db.close();
  });

  it("jeton factice construit à l'exécution : masqué en base, jamais gardé en clair", () => {
    const db = openMemoryDb();
    const store = createConsignesStore(db);
    const jeton = jetonFactice();
    assert.equal(store.enregistrer(consigne({ brut: `[synthétique] utilise ${jeton} pour l'essai` })), "enregistree");
    const texte = store.lire(ROOT, "call_1")?.texte ?? "";
    assert.equal(texte.includes(jeton), false);
    assertAucunMorceau(texte, [jeton], "texte en base");
    // Toute la base, pas seulement la colonne lue.
    const tout = JSON.stringify(db.prepare("SELECT * FROM revoir_consignes").all());
    assert.equal(tout.includes(jeton), false);
    db.close();
  });

  it("consigne trop longue : bornée à l'écriture, longueur d'origine et marque de troncature gardées", () => {
    const db = openMemoryDb();
    const store = createConsignesStore(db);
    const brut = "a".repeat(CONSIGNES.maxCaracteres + 1);
    assert.equal(store.enregistrer(consigne({ brut })), "enregistree");
    const lue = store.lire(ROOT, "call_1");
    assert.equal(pointsDeCode(lue?.texte ?? ""), CONSIGNES.maxCaracteres);
    assert.equal(lue?.longueur, CONSIGNES.maxCaracteres + 1);
    assert.equal(lue?.tronque, true);
    db.close();
  });

  it("purgeConsignes : supprime l'arbre d'une racine, laisse les autres conversations", () => {
    const db = openMemoryDb();
    const store = createConsignesStore(db);
    db.prepare("INSERT INTO sessions (id, parent_id, root_id, created_at, updated_at) VALUES (?, ?, ?, 1, 1)").run("ses_enfant1", ROOT, ROOT);
    assert.equal(store.enregistrer(consigne()), "enregistree");
    assert.equal(store.enregistrer(consigne({ parent: "ses_enfant1", callId: "call_petit", rootId: ROOT, enfant: "ses_petit" })), "enregistree");
    assert.equal(store.enregistrer(consigne({ rootId: AUTRE, parent: AUTRE, callId: "call_autre" })), "enregistree");
    assert.equal(purgeConsignes(db, ROOT), 2);
    assert.equal(purgeConsignes(db, ROOT), 0, "idempotente");
    assert.deepEqual((db.prepare("SELECT root_id FROM revoir_consignes").all() as Array<{ root_id: string }>).map((r) => r.root_id), [AUTRE]);
    db.close();
  });
});

// --- Capture sur le faux opencode ------------------------------------------------------------------------------------------------

describe("consignes gardées : capture (faux opencode, processeur réel)", () => {
  for (const capture of ["p1-delegation-parallele.jsonl", "p2-commande-subtask.jsonl"]) {
    it(`${capture} : une ligne par consigne envoyée, même callId, même enfant, texte = prompt de la capture`, async (t: TestContext) => {
      const attendues = consignesDeLaCapture(capture);
      assert.ok(attendues.length > 0, "la capture porte au moins une consigne");
      const h = await startCockpit(t, { modules: ["facts"] });
      // La racine est connue du cockpit bien avant la délégation (son proxy l'enregistre à l'envoi de la demande). Une capture
      // rejouée d'un coup n'en laisse pas le temps à la file du processeur, ce que le flux réel, étalé sur des secondes, fait.
      h.db.prepare("INSERT INTO sessions (id, parent_id, root_id, created_at, updated_at) VALUES (?, NULL, ?, 1, 1)").run(ROOT, ROOT);
      for (const { wire } of readCapture(capture)) h.fake.emitRaw(wire);
      await until(() => lignes(h).length === attendues.length, 10_000);

      const gardees = lignes(h);
      assert.deepEqual(
        gardees.map((l) => [l.root_id, l.parent_session_id, l.call_id, l.enfant_session_id]),
        attendues.map((a) => [ROOT, a.parent, a.callId, a.enfant]),
      );
      for (const [index, ligne] of gardees.entries()) {
        const attendue = attendues[index]!;
        assert.equal(ligne.texte, bornerConsigne(attendue.prompt, redactSecrets).texte, attendue.callId);
        assert.equal(ligne.texte, attendue.prompt, "aucun secret dans ces fixtures : le texte est celui de la capture");
        assert.equal(ligne.longueur, pointsDeCode(attendue.prompt));
        assert.equal(ligne.tronque, 0);
        assert.ok(ligne.at > 0, "instant de l'événement");
      }

      // Rejeu complet : les mêmes appels sont ignorés (INSERT OR IGNORE), aucune ligne de plus.
      for (const { wire } of readCapture(capture)) h.fake.emitRaw(wire);
      await until(() => h.fake.emitted.length >= 2, 5_000);
      assert.deepEqual(lignes(h).length, attendues.length);
    });
  }

  it("session inconnue : rien d'écrit, rien de tenté (ni requête au faux, ni ligne de journal)", async (t: TestContext) => {
    const espion = journalEspion();
    const h = await startCockpit(t, { deps: () => ({ log: espion.log }) });
    const depuis = h.fake.requests.length;
    const temoin: string[] = [];
    h.processor.addDerivation({ name: "temoin-consignes", onEvent: (e) => void temoin.push(e.payload.type) });
    evenementTask(h, { parent: "ses_jamais_vue", callId: "call_inconnue", enfant: "ses_enfant_inconnue", prompt: "[synthétique] consigne perdue" });
    await until(() => temoin.includes("message.part.updated"), 5_000);
    // La file du processeur a tourné : rien n'est écrit, rien n'a été demandé à opencode, et rien n'a même été tenté — une racine
    // inconnue s'abandonne en silence, elle ne produit pas d'erreur journalisée.
    assert.deepEqual(lignes(h), []);
    assert.deepEqual(h.fake.requests.slice(depuis).map((r) => `${r.method} ${r.pathname}`), []);
    assert.deepEqual(espion.lignes.filter((l) => l.message.includes("consignes")), []);
    h.assertNoGlobalRestart();
  });

  // Relecture « 3s-vague-5 » : la garde P11 de L3s-a lisait aussi l'instance de la racine PROVISOIRE (session connue avant sa mère,
  // mère encore inconnue : instanceOf = null) et abandonnait la consigne, alors que D-3d-30 et consignes-store.ts prévoient
  // l'écriture sous cette racine, retrouvée par l'ARBRE (TREE_SQL) après rattachement. La session qui confie le travail est
  // suivie par l'instance du processeur : c'est elle qui fait foi tant que la racine n'est pas connue.
  it("racine provisoire (session suivie avant sa mère) : le processeur principal garde la consigne, retrouvée par la VRAIE racine après rattachement", async (t: TestContext) => {
    const h = await startCockpit(t);
    h.sessions.upsert(session(ROOT));
    h.sessions.upsert(session(PETITE_FILLE, FILLE)); // racine provisoire : FILLE, que le cockpit ne suit pas encore
    assert.equal(h.sessions.rootOf(PETITE_FILLE), FILLE, "racine provisoire avant rattachement");
    assert.equal(h.sessions.instanceOf(FILLE), null, "la racine provisoire n'a aucune ligne dans sessions");
    const vus: string[] = [];
    h.processor.addDerivation({
      name: "temoin-consignes",
      onEvent: (e) => void vus.push(String((e.payload.properties as { part?: { callID?: string } }).part?.callID)),
    });
    const prompt = "[synthétique] consigne confiée sous une racine provisoire";
    evenementTask(h, { parent: PETITE_FILLE, callId: "call_racine_provisoire", enfant: "ses_arriere_petite_fille", prompt });
    await until(() => vus.includes("call_racine_provisoire"), 5_000);
    assert.deepEqual(
      lignes(h).map((l) => [l.root_id, l.parent_session_id, l.enfant_session_id, l.call_id, l.texte]),
      [[FILLE, PETITE_FILLE, "ses_arriere_petite_fille", "call_racine_provisoire", prompt]],
      "écrite sous la racine provisoire, comme le prévoit consignes-store.ts",
    );

    h.sessions.upsert(session(FILLE, ROOT)); // rattachement
    assert.equal(h.sessions.rootOf(PETITE_FILLE), ROOT);
    const store = createConsignesStore(h.db);
    assert.equal(store.lire(ROOT, "call_racine_provisoire")?.texte, prompt, "« Revoir » la retrouve par la vraie racine");
    assert.deepEqual(store.parEnfant(ROOT, "ses_arriere_petite_fille").map((c) => c.callId), ["call_racine_provisoire"]);
    h.assertNoGlobalRestart();
  });

  it("racine provisoire posée par ensure (GET de la mère en échec) : la dérivation principale garde la consigne sans aucune requête, retrouvée après rattachement", async () => {
    const db = openMemoryDb();
    const demandes: string[] = [];
    // Faux client : connaît la petite-fille, échoue sur sa mère. ensure() la suit donc sous la racine provisoire FILLE.
    const client = {
      request: async (method: string, pathname: string): Promise<unknown> => {
        demandes.push(`${method} ${pathname}`);
        if (pathname === `/session/${PETITE_FILLE}`) return session(PETITE_FILLE, FILLE);
        throw new Error("[synthétique] opencode injoignable");
      },
    } as unknown as OpencodeClient;
    const sessions = new SessionTracker(db, client);
    sessions.upsert(session(ROOT));
    const suivie = await sessions.ensure(PETITE_FILLE);
    assert.equal(suivie?.root_id, FILLE, "racine provisoire : la mère n'a pas pu être lue");
    assert.equal(suivie?.instance, "principale");
    assert.equal(sessions.instanceOf(FILLE), null);
    assert.deepEqual(demandes, [`GET /session/${PETITE_FILLE}`, `GET /session/${FILLE}`]);

    const espion = journalEspion();
    const derivation = createConsignesDerivation({ db, log: espion.log, sessions } as unknown as Parameters<typeof createConsignesDerivation>[0]);
    assert.equal(derivation.name, CONSIGNES_DERIVATION);
    const prompt = "[synthétique] consigne confiée après un ensure incomplet";
    derivation.onEvent({
      payload: {
        type: "message.part.updated",
        properties: {
          part: {
            type: "tool",
            tool: "task",
            sessionID: PETITE_FILLE,
            callID: "call_ensure_provisoire",
            state: { status: "running", input: { prompt }, metadata: { sessionId: "ses_arriere_petite_fille" } },
          },
        },
      },
    } as never);
    assert.equal(demandes.length, 2, "la dérivation ne part jamais en réseau");
    assert.deepEqual(espion.lignes, [], "rien de journalisé");
    assert.deepEqual(
      (db.prepare("SELECT root_id, parent_session_id, call_id FROM revoir_consignes").all() as Array<Record<string, string>>).map((l) => [l.root_id, l.parent_session_id, l.call_id]),
      [[FILLE, PETITE_FILLE, "call_ensure_provisoire"]],
    );

    sessions.upsert(session(FILLE, ROOT)); // rattachement
    const store = createConsignesStore(db);
    assert.equal(store.lire(ROOT, "call_ensure_provisoire")?.texte, prompt, "retrouvée par la vraie racine");
    db.close();
  });

  it("seul l'envoi d'une consigne est gardé : sans enfant, hors de l'état `running`, ou hors de l'outil `task`, rien n'est écrit", async (t: TestContext) => {
    const h = await startCockpit(t);
    h.db.prepare("INSERT INTO sessions (id, parent_id, root_id, created_at, updated_at) VALUES (?, ?, ?, 1, 1)").run(ROOT, null, ROOT);
    const vus: string[] = [];
    h.processor.addDerivation({
      name: "temoin-consignes",
      onEvent: (e) => void vus.push(String((e.payload.properties as { part?: { callID?: string } }).part?.callID)),
    });
    const rien: Array<{ callId: string } & Partial<{ enfant: string | null; statut: string; outil: string }>> = [
      // Consigne en préparation (arguments en cours d'écriture) : l'enfant n'existe pas encore.
      { callId: "call_sans_enfant", enfant: null },
      // Même appel, mais avant l'envoi puis après le retour : le texte ne prouve plus une consigne transmise.
      { callId: "call_prepare", statut: "pending" },
      { callId: "call_termine", statut: "completed" },
      { callId: "call_erreur", statut: "error" },
      // Un autre outil, même avec un `prompt` et un `sessionId` : seul `task` confie un travail.
      { callId: "call_autre_outil", outil: "bash" },
    ];
    for (const cas of rien) {
      evenementTask(h, { parent: ROOT, enfant: "ses_enfant_ok", prompt: "[synthétique] rien à garder", ...cas });
    }
    await until(() => rien.every((cas) => vus.includes(cas.callId)), 5_000);
    assert.deepEqual(lignes(h), []);

    evenementTask(h, { parent: ROOT, callId: "call_avec_enfant", enfant: "ses_enfant_ok", prompt: "[synthétique] envoyée" });
    await until(() => lignes(h).length === 1, 5_000);
    assert.deepEqual(lignes(h).map((l) => [l.call_id, l.enfant_session_id, l.texte]), [["call_avec_enfant", "ses_enfant_ok", "[synthétique] envoyée"]]);
  });

  it("session.deleted d'opencode : les consignes restent (comme les faits) ; seule la suppression de l'archive purge (D-07)", async (t: TestContext) => {
    const h = await startCockpit(t);
    h.db.prepare("INSERT INTO sessions (id, parent_id, root_id, created_at, updated_at) VALUES (?, ?, ?, 1, 1)").run(ROOT, null, ROOT);
    evenementTask(h, { parent: ROOT, callId: "call_garde", enfant: "ses_enfant_ok", prompt: "[synthétique] consigne gardée aux Archives" });
    await until(() => lignes(h).length === 1, 5_000);

    h.fake.emit({ type: "session.deleted", properties: { info: { id: ROOT } } });
    await until(() => ((h.db.prepare("SELECT deleted_at AS d FROM sessions WHERE id = ?").get(ROOT) as { d: number | null } | undefined)?.d ?? null) !== null, 5_000);
    assert.equal(lignes(h).length, 1, "consignes gardées après session.deleted");

    // Suppression de l'archive : point unique de purge.
    const now = Date.now();
    h.db.prepare("INSERT INTO conversations (session_id, directory, title, created_at, updated_at) VALUES (?, '/workspace', '[synthétique]', ?, ?)").run(ROOT, now, now);
    h.db.prepare("INSERT INTO conversations (session_id, directory, title, created_at, updated_at) VALUES (?, '/workspace', '[synthétique]', ?, ?)").run(AUTRE, now, now);
    createConsignesStore(h.db).enregistrer({ rootId: AUTRE, parent: AUTRE, enfant: "ses_autre_enfant", callId: "call_autre", brut: "[synthétique] autre conversation", at: now });
    assert.equal(lignes(h).length, 2);

    assert.equal(await h.deps.archive.remove(ROOT), true);
    assert.deepEqual(lignes(h).map((l) => l.root_id), [AUTRE], "consignes de la conversation supprimées, autre racine intacte");
  });

  it("JAMAIS journalisée ni publiée : ni la capture, ni la lecture, ni une erreur provoquée, ni la purge ne recopient le texte", async (t: TestContext) => {
    const espion = journalEspion();
    const h = await startCockpit(t, { deps: () => ({ log: espion.log }) });
    h.db.prepare("INSERT INTO sessions (id, parent_id, root_id, created_at, updated_at) VALUES (?, ?, ?, 1, 1)").run(ROOT, null, ROOT);
    const textes = [
      "[synthétique] première consigne confidentielle du cockpit, assez longue pour être reconnue",
      "[synthétique] seconde consigne confidentielle du cockpit, tout aussi reconnaissable",
    ];

    evenementTask(h, { parent: ROOT, callId: "call_j1", enfant: "ses_enfant_j1", prompt: textes[0]! });
    await until(() => lignes(h).length === 1, 5_000);

    // Lecture par le port : elle non plus ne journalise rien.
    const store = createConsignesStore(h.db);
    assert.equal(store.lire(ROOT, "call_j1")?.texte, textes[0]);
    assert.deepEqual(store.parEnfant(ROOT, "ses_enfant_j1").map((c) => c.texte), [textes[0]]);

    // Erreur provoquée dans la dérivation : la table disparaît sous elle. Le processeur continue, le journal ne dit que le nom
    // de l'erreur et le callId.
    h.db.exec("DROP TABLE revoir_consignes");
    const temoin: string[] = [];
    h.processor.addDerivation({ name: "temoin-consignes", onEvent: (e) => void temoin.push(e.payload.type) });
    evenementTask(h, { parent: ROOT, callId: "call_j2", enfant: "ses_enfant_j2", prompt: textes[1]! });
    await until(() => temoin.filter((type) => type === "message.part.updated").length === 1, 5_000);
    await until(() => espion.lignes.some((l) => l.champs.callId === "call_j2"), 5_000);
    const echec = espion.lignes.find((l) => l.champs.callId === "call_j2");
    assert.ok(echec, "échec journalisé");
    assert.equal(echec.niveau, "warn");
    assert.match(echec.message, /^consignes gardées/, echec.message);
    // SON SEUL NOM : « SQLiteError », « TypeError »… jamais le message de l'erreur, qui peut recopier la consigne ou la requête.
    assert.deepEqual(Object.keys(echec.champs).sort(), ["callId", "erreur"]);
    assert.match(String(echec.champs.erreur), /^[A-Za-z]+$/, String(echec.champs.erreur));
    assert.equal(echec.brut.includes("[synthétique]"), false, "aucun morceau de consigne dans le journal");

    // Purge : rien n'est journalisé du texte non plus (table recréée pour l'appeler).
    h.db.exec(`CREATE TABLE revoir_consignes (id INTEGER PRIMARY KEY AUTOINCREMENT, root_id TEXT NOT NULL, parent_session_id TEXT NOT NULL,
      enfant_session_id TEXT, call_id TEXT NOT NULL, texte TEXT NOT NULL, longueur INTEGER NOT NULL, tronque INTEGER NOT NULL DEFAULT 0,
      at INTEGER NOT NULL, UNIQUE (parent_session_id, call_id))`);
    createConsignesStore(h.db).enregistrer({ rootId: ROOT, parent: ROOT, enfant: "ses_enfant_j1", callId: "call_j3", brut: textes[0]!, at: 1 });
    assert.equal(purgeConsignes(h.db, ROOT), 1);

    assertAucunMorceau(espion.texte(), textes, "journal");
    // Événements du cockpit : aucun ne porte le texte (le relais brut des événements d'opencode, kind « opencode », est le flux
    // de la 1.0 et ne passe pas par L28d).
    assertAucunMorceau(JSON.stringify(h.cockpitEvents()), textes, "événements du cockpit");
    assert.equal(
      h.cockpitEvents().some((e) => e.type.includes("consigne")),
      false,
      "aucun événement du cockpit publié par la capture",
    );
  });
});

// --- Salle OMO branchée (itération « 3s », L3s-a ; U2, D-3d-30, P11) ----------------------------------------------------------------

const SALLE_RACINE = "ses_salle_racine_l3sa";
const SALLE_ENFANT = "ses_salle_enfant_l3sa";
const PRINCIPALE = "ses_principale_l3sa";

/** Partie `task` à l'état `running`, émise sur l'instance de la SALLE (processeur réel de la salle, h.emitOmo). */
const tacheSalle = (h: CockpitHarness, options: { id: string; parent: string; callId: string; enfant: string; prompt: string }) =>
  h.emitOmo({
    directory: "/workspace/app",
    payload: {
      id: options.id,
      type: "message.part.updated",
      properties: {
        sessionID: options.parent,
        part: {
          id: `prt_${options.callId}`,
          messageID: `msg_${options.callId}`,
          sessionID: options.parent,
          type: "tool",
          tool: "task",
          callID: options.callId,
          state: {
            status: "running",
            title: "[synthétique]",
            input: { description: "[synthétique]", prompt: options.prompt, subagent_type: "sisyphus-junior" },
            metadata: { parentSessionId: options.parent, sessionId: options.enfant },
          },
        },
      },
    },
  });

describe("consignes gardées : salle branchée (L3s-a)", () => {
  it("consigne d'un enfant de la salle gardée par le processeur de la SALLE, sous sa racine ; masquée avant la coupe ; la partie ajoutée par un crochet n'est jamais lue ; jamais journalisée ni publiée", async (t: TestContext) => {
    const espion = journalEspion();
    const h = await startCockpit(t, { omo: true, log: espion.log });
    h.sessions.upsert(session(SALLE_RACINE), undefined, { instance: "omo" });
    const jeton = jetonFactice();
    const prompt = `[synthétique] consigne confiée dans la salle, clé ${jeton} à ne jamais garder en clair`;
    await tacheSalle(h, { id: "evt_l3sa_1", parent: SALLE_RACINE, callId: "call_salle_1", enfant: SALLE_ENFANT, prompt });
    const gardees = lignes(h, SALLE_RACINE);
    assert.deepEqual(
      gardees.map((l) => [l.root_id, l.parent_session_id, l.enfant_session_id, l.call_id]),
      [[SALLE_RACINE, SALLE_RACINE, SALLE_ENFANT, "call_salle_1"]],
    );
    assert.equal(gardees[0]?.texte, bornerConsigne(prompt, redactSecrets).texte, "mêmes bornes et même masquage que l'instance principale");
    assert.equal(gardees[0]?.texte.includes(jeton), false, "masqué avant d'être gardé");
    assert.equal(gardees[0]?.longueur, pointsDeCode(prompt));

    // Premier message de l'enfant, préfixé par un crochet de l'extension (JP-4, `.omo/notepads/`) : jamais lu par la capture.
    await h.emitOmo({
      directory: "/workspace/app",
      payload: { id: "evt_l3sa_2", type: "message.updated", properties: { sessionID: SALLE_ENFANT, info: { id: "msg_l3sa_enfant", sessionID: SALLE_ENFANT, role: "user" } } },
    });
    await h.emitOmo({
      directory: "/workspace/app",
      payload: {
        id: "evt_l3sa_3",
        type: "message.part.updated",
        properties: {
          sessionID: SALLE_ENFANT,
          part: { id: "prt_l3sa_enfant", sessionID: SALLE_ENFANT, messageID: "msg_l3sa_enfant", type: "text", text: "[synthétique] .omo/notepads/ ajouté par un crochet" },
        },
      },
    });
    assert.deepEqual(
      lignes(h).map((l) => [l.call_id, l.texte]),
      [["call_salle_1", bornerConsigne(prompt, redactSecrets).texte]],
      "seule la consigne écrite par l'assistant est gardée",
    );
    assert.equal(lignes(h).some((l) => l.texte.includes(".omo/notepads")), false);
    assertAucunMorceau(espion.texte(), [prompt], "journal");
    assertAucunMorceau(JSON.stringify(h.cockpitEvents()), [prompt], "événements du cockpit");
  });

  it("P11 : un événement de la salle n'est jamais appliqué à une racine principale, ni l'inverse ; témoins gardés", async (t: TestContext) => {
    const h = await startCockpit(t, { omo: true });
    h.sessions.upsert(session(PRINCIPALE));
    h.sessions.upsert(session(SALLE_RACINE), undefined, { instance: "omo" });
    // Salle → racine principale : ignoré (la session qui confie n'est pas de la salle).
    await tacheSalle(h, { id: "evt_l3sa_p11_1", parent: PRINCIPALE, callId: "call_croise_1", enfant: "ses_x1", prompt: "[synthétique] consigne croisée 1" });
    // Principale → racine de la salle : ignoré aussi, par le processeur principal.
    const vus: string[] = [];
    h.processor.addDerivation({ name: "temoin-consignes", onEvent: (e) => void vus.push(String((e.payload.properties as { part?: { callID?: string } }).part?.callID)) });
    evenementTask(h, { parent: SALLE_RACINE, callId: "call_croise_2", enfant: "ses_x2", prompt: "[synthétique] consigne croisée 2" });
    await until(() => vus.includes("call_croise_2"), 5_000);
    // Lignes incohérentes (base abîmée) : une session de la salle rattachée à une racine principale. La racine décide aussi : rien.
    h.db
      .prepare("INSERT INTO sessions (id, parent_id, root_id, directory, title, purpose, instance, created_at, updated_at) VALUES (?, ?, ?, '/workspace/app', '', 'chat', 'omo', 1, 1)")
      .run("ses_melange_l3sa", PRINCIPALE, PRINCIPALE);
    await tacheSalle(h, { id: "evt_l3sa_p11_3", parent: "ses_melange_l3sa", callId: "call_croise_3", enfant: "ses_x3", prompt: "[synthétique] consigne croisée 3" });
    assert.deepEqual(lignes(h), [], "aucune consigne croisée entre les instances");
    // Témoins : chaque instance garde les consignes de SES racines.
    evenementTask(h, { parent: PRINCIPALE, callId: "call_temoin_p", enfant: "ses_tp", prompt: "[synthétique] consigne principale" });
    await until(() => lignes(h, PRINCIPALE).length === 1, 5_000);
    await tacheSalle(h, { id: "evt_l3sa_p11_2", parent: SALLE_RACINE, callId: "call_temoin_s", enfant: "ses_ts", prompt: "[synthétique] consigne de la salle" });
    assert.deepEqual(
      lignes(h).map((l) => [l.root_id, l.call_id]).sort(),
      [
        [PRINCIPALE, "call_temoin_p"],
        [SALLE_RACINE, "call_temoin_s"],
      ].sort(),
    );
  });

  it("racine provisoire (relecture « 3s-vague-5 ») : le processeur de la SALLE garde la consigne d'un parent suivi « omo », retrouvée par la vraie racine ; P11 tenu dans les deux sens quand la racine est inconnue", async (t: TestContext) => {
    const SALLE_FILLE = "ses_salle_fille_3sv5";
    const SALLE_PETITE_FILLE = "ses_salle_petite_fille_3sv5";
    const PRINCIPALE_FILLE = "ses_principale_fille_3sv5";
    const PRINCIPALE_PETITE_FILLE = "ses_principale_petite_fille_3sv5";
    const h = await startCockpit(t, { omo: true });
    h.sessions.upsert(session(SALLE_RACINE), undefined, { instance: "omo" });
    h.sessions.upsert(session(SALLE_PETITE_FILLE, SALLE_FILLE), undefined, { instance: "omo" }); // racine provisoire de la salle
    h.sessions.upsert(session(PRINCIPALE));
    h.sessions.upsert(session(PRINCIPALE_PETITE_FILLE, PRINCIPALE_FILLE)); // racine provisoire de l'instance principale
    assert.equal(h.sessions.rootOf(SALLE_PETITE_FILLE), SALLE_FILLE);
    assert.equal(h.sessions.instanceOf(SALLE_FILLE), null);
    assert.equal(h.sessions.instanceOf(PRINCIPALE_FILLE), null);

    // P11, racine inconnue : la session qui confie décide. Le processeur principal n'écrit jamais pour une session de la salle…
    const vus: string[] = [];
    h.processor.addDerivation({ name: "temoin-consignes", onEvent: (e) => void vus.push(String((e.payload.properties as { part?: { callID?: string } }).part?.callID)) });
    evenementTask(h, { parent: SALLE_PETITE_FILLE, callId: "call_prov_croise_1", enfant: "ses_x5", prompt: "[synthétique] croisée sous une racine provisoire 1" });
    await until(() => vus.includes("call_prov_croise_1"), 5_000);
    // … ni la salle pour une session principale.
    await tacheSalle(h, { id: "evt_3sv5_croise", parent: PRINCIPALE_PETITE_FILLE, callId: "call_prov_croise_2", enfant: "ses_x6", prompt: "[synthétique] croisée sous une racine provisoire 2" });
    assert.deepEqual(lignes(h), [], "aucune consigne croisée, même sous une racine inconnue");

    const prompt = "[synthétique] consigne de la salle sous une racine provisoire";
    await tacheSalle(h, { id: "evt_3sv5_salle", parent: SALLE_PETITE_FILLE, callId: "call_salle_provisoire", enfant: "ses_salle_arriere_3sv5", prompt });
    assert.deepEqual(
      lignes(h).map((l) => [l.root_id, l.parent_session_id, l.enfant_session_id, l.call_id]),
      [[SALLE_FILLE, SALLE_PETITE_FILLE, "ses_salle_arriere_3sv5", "call_salle_provisoire"]],
      "gardée par le processeur de la salle sous la racine provisoire",
    );
    h.sessions.upsert(session(SALLE_FILLE, SALLE_RACINE), undefined, { instance: "omo" }); // rattachement
    assert.equal(h.sessions.rootOf(SALLE_PETITE_FILLE), SALLE_RACINE);
    assert.equal(createConsignesStore(h.db).lire(SALLE_RACINE, "call_salle_provisoire")?.texte, prompt, "retrouvée par la vraie racine de la salle");
    assert.equal(createConsignesStore(h.db).lire(PRINCIPALE, "call_salle_provisoire"), null, "jamais par une racine principale");
  });

  it("inscription : aucune salle coupée ; une fois sur le processeur de la salle quand elle existe, jamais sur le principal ; retirée par close()", async (t: TestContext) => {
    const inscrites: Array<{ nom: string; processeur: EventProcessor; retiree: boolean }> = [];
    const addDerivation = EventProcessor.prototype.addDerivation;
    t.mock.method(EventProcessor.prototype, "addDerivation", function (this: EventProcessor, derivation: EventDerivation) {
      const retirer = addDerivation.call(this, derivation);
      const entree = { nom: derivation.name, processeur: this, retiree: false };
      inscrites.push(entree);
      return () => {
        entree.retiree = true;
        retirer();
      };
    });
    const coupee = await startCockpit(t);
    assert.deepEqual(
      inscrites.filter((e) => e.nom === CONSIGNES_DERIVATION_SALLE),
      [],
      "salle coupée : rien d'inscrit",
    );
    assert.equal(inscrites.filter((e) => e.nom === CONSIGNES_DERIVATION && e.processeur === coupee.processor).length, 1);
    await coupee.close();
    inscrites.length = 0;
    const h = await startCockpit(t, { omo: true });
    assert.ok(h.omo);
    const salle = inscrites.filter((e) => e.nom === CONSIGNES_DERIVATION_SALLE);
    assert.equal(salle.length, 1);
    assert.equal(salle[0]?.processeur, h.omo.deps.processor, "sur le processeur de la salle");
    assert.equal(inscrites.filter((e) => e.nom === CONSIGNES_DERIVATION_SALLE && e.processeur === h.processor).length, 0, "jamais sur le principal");
    assert.equal(inscrites.filter((e) => e.nom === CONSIGNES_DERIVATION && e.processeur === h.omo?.deps.processor).length, 0);
    h.cockpit.close();
    assert.equal(salle[0]?.retiree, true, "retirée par close()");
  });

  it("erreur dans la dérivation de la salle : journal = nom de l'erreur et callId seulement ; le processeur continue", (t: TestContext) => {
    const espion = journalEspion();
    const texte = "[synthétique] consigne de la salle à ne jamais journaliser, assez longue pour être reconnue";
    const db = openMemoryDb();
    t.after(() => db.close());
    const deps = {
      db,
      log: espion.log,
      sessions: {
        rootOf: () => {
          throw new TypeError(texte);
        },
        instanceOf: () => "omo",
      },
    } as unknown as Parameters<typeof createConsignesDerivation>[0];
    const derivation = createConsignesDerivation(deps, "omo");
    assert.equal(derivation.name, CONSIGNES_DERIVATION_SALLE);
    derivation.onEvent({
      payload: {
        type: "message.part.updated",
        properties: {
          part: {
            type: "tool",
            tool: "task",
            sessionID: SALLE_RACINE,
            callID: "call_erreur_salle",
            state: { status: "running", input: { prompt: texte }, metadata: { sessionId: SALLE_ENFANT } },
          },
        },
      },
    } as never);
    assert.deepEqual(
      espion.lignes.map((l) => l.champs),
      [{ callId: "call_erreur_salle", erreur: "TypeError" }],
    );
    assertAucunMorceau(espion.texte(), [texte], "journal");
  });
});
