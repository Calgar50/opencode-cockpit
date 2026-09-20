// Consignes gardées localement pour « Revoir » (paquet L28d, itération 3 ; U2, D-3d-30) : bornes du module pur, magasin
// revoir_consignes (écriture paramétrée, doublon, borne par conversation, clé d'étape d'équipe), capture synchrone sur le faux
// opencode avec le processeur réel, purge avec la conversation (D-07), et la garantie centrale : le texte d'une consigne n'est
// JAMAIS journalisé ni publié dans un événement du cockpit.
// Textes des fixtures : « [synthétique] », jamais un extrait réel. Le jeton factice des tests est CONSTRUIT À L'EXÉCUTION : aucun
// secret, même factice, n'est écrit en clair dans le dépôt.
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { describe, it, type TestContext } from "node:test";
import { type ConsigneAGarder, createConsignesStore, PAR_ENFANT_MAX, purgeConsignes } from "./consignes-store.ts";
import { openMemoryDb } from "./db.ts";
import type { Logger } from "./log.ts";
import { redactSecrets } from "./redact.ts";
import { bornerConsigne, CONSIGNES, pointsDeCode } from "./shared/consignes.ts";
import { type CockpitHarness, startCockpit } from "./test-support/cockpit-harness.ts";
import { readCapture } from "./test-support/fake-opencode.ts";
import { until } from "./test-support/helpers.ts";

/** Racine des captures p1 et p2 (expérience « ocgraph », opencode 1.18.30). */
const ROOT = "ses_f618ff214ffevi6gfuGx6TvpTP";
const AUTRE = "ses_autre_racine";

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
