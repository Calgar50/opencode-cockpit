// Rejeu de la Salle OMO (plan 2 bis-2 ter, fiche L25b ; spécification §3.10 points 4 et 5, §5.7.1, §5.7.3, P12, JP-2, JP-3, JP-8 ;
// mesures M20 et M21) : les captures RÉDUITES du banc (omo-banc-m20, -m21, -r16 ; D-2b-31, versées par L21) et la fixture
// synthétique omo-jp1-jp7 (L25a) passent par le même chemin que le direct — mémoire du flux et faits (activity-facts.ts), filtre de
// doublons du magasin — puis par le réducteur (activity.ts) et la scène (neon-scene.ts).
// - T-L25-i : « différé = direct » (faits relus comme depuis la base, JSON aller-retour) sur chaque capture, à chaque pas ;
// - aucun signe sans fait (P12) sur chaque pas ;
// - JP-3 et JP-2 sur la fixture synthétique ; l'écart avec la capture M21 (remis au train de V4 par L25a) est constaté ici : la
//   capture du banc ne contient ni tâche de fond ni réveil (l'appel `task` du faux fournisseur finit en outil `invalid`) ;
// - bornes sur une rafale synthétique de la salle : 3 niveaux et 50 sessions (réducteur et scène), au plus 4 rendus par seconde
//   (magasin du navigateur, useActivity.ts ; file de la bande, neon-band.ts), rattrapage compris.
// Les identifiants des captures réduites sont des textes « [synthétique] N car. sha256:… » : ils sont remplacés, en mémoire, par un
// identifiant opencode stable tiré de l'empreinte (même empreinte, même identifiant). Aucune capture n'est écrite ni modifiée.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { type ActivityClock, ActivityStore, RENDER_MIN_INTERVAL_MS } from "../web/lib/useActivity.ts";
import { ACTIVITY_MAX_DEPTH, ACTIVITY_MAX_SESSIONS, type ActivityState, activityStatus, applyEvent, emptyActivity, liveRows, replayFacts, timeline, totals } from "./shared/activity.ts";
import { EventMemory, type FactContext, FactDeduper, type FactEvent, type FactSession, factsFromEvent } from "./shared/activity-facts.ts";
import type { ActivityFact } from "./shared/activity-types.ts";
import { avancer, fileNeuve, NEON_RENDU_MS, recevoir } from "./shared/neon-band.ts";
import { moments, type NeonScene, type NeonSceneOptions, scene, visibleCount } from "./shared/neon-scene.ts";
import { roleDeAgent } from "./shared/omo-roles.ts";
import { readCapture } from "./test-support/fake-opencode.ts";

const BANC = ["omo-banc-m20.jsonl", "omo-banc-m21.jsonl", "omo-banc-r16.jsonl"] as const;
const SYNTHETIQUE = "omo-jp1-jp7.jsonl";
const JP_RACINE = "ses_jp_racine";
const JP_FOND = "ses_jp_fond";
const JP_JUNIOR = "ses_jp_junior";

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

// --- Rejeu comme le direct ---------------------------------------------------------------------------------------------------------

/** Identifiant réduit par D-2b-31 : seules restent la longueur et l'empreinte de l'original. */
const ID_REDUIT = /^\[synthétique\] \d+ car\. sha256:([0-9a-f]{16})$/;

/**
 * Identifiant opencode stable pour chaque identifiant réduit : même empreinte, même identifiant. Le tiret empêche d'y lire une
 * heure (identifiant croissant) : l'heure du fait reste celle de la réception, relative au début de la capture.
 */
function reidentifier(value: unknown): unknown {
  if (typeof value === "string") {
    const match = ID_REDUIT.exec(value);
    return match ? `syn-${match[1]}` : value;
  }
  if (Array.isArray(value)) return value.map(reidentifier);
  if (isRecord(value)) return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, reidentifier(item)]));
  return value;
}

/**
 * Cockpit de la salle vu par le dériveur de faits : la première session sans parent est la racine de la salle (instance `omo`) ; son
 * premier message utilisateur est la demande envoyée par le cockpit (ligne `prompts`). Mémoire du flux branchée en amont
 * (identité douteuse, tâche de fond), comme l'écrit L25a.
 */
class Salle {
  racine: string | null = null;
  demande: string | null = null;
  readonly sessions = new Map<string, FactSession>();
  readonly memory = new EventMemory();

  resolve(id: string, info?: Readonly<Record<string, unknown>>): FactSession | null {
    const known = this.sessions.get(id);
    if (known) return known;
    if (!info || info.id !== id) return null;
    const parentId = typeof info.parentID === "string" ? info.parentID : null;
    if (parentId === null) {
      this.racine ??= id;
      return id === this.racine ? { rootId: id, parentId: null, purpose: "chat", instance: "omo" } : null;
    }
    const parent = this.sessions.get(parentId);
    return parent ? { rootId: parent.rootId, parentId, purpose: "chat", instance: "omo" } : null;
  }

  observe(event: FactEvent): void {
    this.memory.observe(event);
    const info = event.properties?.info;
    if ((event.type === "session.created" || event.type === "session.updated") && isRecord(info) && typeof info.id === "string") {
      const session = this.resolve(info.id, info);
      if (session) this.sessions.set(info.id, session);
    }
    if (event.type === "message.updated" && isRecord(info) && info.role === "user" && info.sessionID === this.racine && typeof info.id === "string") {
      this.demande ??= info.id;
    }
  }

  ctx(receivedAt: number): FactContext {
    return {
      receivedAt,
      session: (id, info) => this.resolve(id, info),
      messageRole: (id) => this.memory.messageRole(id),
      promptKind: (id) => (id === this.demande ? "message" : null),
      firstUserMessage: (id) => this.memory.firstUserMessage(id),
      userMessageParts: (id) => this.memory.userMessageParts(id),
      unansweredUserMessages: (id) => this.memory.unansweredUserMessages(id),
      amont: this.memory.amont(),
    };
  }
}

interface Pas {
  /** Faits gardés jusqu'à cet événement compris. */
  faits: ActivityFact[];
  recv: number;
}

/** Rejoue des événements comme le direct : faits dérivés un à un, doublons écartés par le magasin ; un pas par événement qui en ajoute. */
function rejouer(events: ReadonlyArray<{ recv: number; event: FactEvent }>): { pas: Pas[]; racine: string } {
  const salle = new Salle();
  const magasin = new FactDeduper();
  const gardes: ActivityFact[] = [];
  const pas: Pas[] = [];
  for (const { recv, event } of events) {
    salle.observe(event);
    const ajoutes = factsFromEvent(event, salle.ctx(recv)).filter((fact) => magasin.accept(fact));
    if (ajoutes.length === 0) continue;
    gardes.push(...ajoutes);
    pas.push({ faits: [...gardes], recv });
  }
  assert.ok(salle.racine !== null, "une racine de la salle");
  return { pas, racine: salle.racine };
}

const evenements = (nom: string) => readCapture(nom).map(({ recv, wire }) => ({ recv, event: reidentifier(wire.payload) as FactEvent }));
const rejouerCapture = (nom: string) => rejouer(evenements(nom));

/** Faits relus comme depuis la base : data sérialisé en JSON, puis relu. */
const relus = (faits: readonly ActivityFact[]): ActivityFact[] =>
  faits.map((f, i) => ({ id: i + 1, rootId: f.rootId, sessionId: f.sessionId, kind: f.kind, ref: f.ref, data: JSON.parse(JSON.stringify(f.data)), at: f.at }));

/** Réducteur en direct : chaque fait reçu en `activite.fait`, dans l'ordre. */
const direct = (racine: string, faits: readonly ActivityFact[]): ActivityState =>
  faits.reduce<ActivityState>((state, data) => applyEvent(state, { kind: "cockpit", type: "activite.fait", data }), emptyActivity(racine));

const SALLE: NeonSceneOptions = { zoom: 2, mode: "avance", roleSalle: roleDeAgent };

/** Options de la scène : les deux modes, zoom 2 et zoom 3 de la conversation et de chaque assistant délégué. */
function optionsDe(faits: readonly ActivityFact[], racine: string): NeonSceneOptions[] {
  const enfants = [...new Set(faits.map((f) => f.sessionId))].filter((id) => id !== racine);
  return [SALLE, { ...SALLE, mode: "simple" }, { ...SALLE, zoom: 3 }, ...enfants.map((focus) => ({ ...SALLE, zoom: 3 as const, focus }))];
}

/** Compteur du zoom 3 (emplacement d'outil, « Ce qu'il a fait ») resté à zéro : décor, sans fait. */
const compteurVide = (value: Record<string, unknown>) =>
  typeof value.termines === "number" && ["enCours", "termines", "echecs", "interrompus"].every((cle) => (value[cle] ?? 0) === 0);

/**
 * P12 : chaque liste `faits` de la scène ne désigne que des faits visibles de la conversation, et n'est vide que pour un compteur
 * du zoom 3 resté à zéro (décor).
 */
function assertAucunSigneSansFait(vue: NeonScene, faits: readonly ActivityFact[], visibles: number, label: string): void {
  const walk = (value: unknown, chemin: string) => {
    if (Array.isArray(value)) value.forEach((item, i) => walk(item, `${chemin}[${i}]`));
    else if (isRecord(value)) {
      for (const [key, item] of Object.entries(value)) {
        if (key === "faits") {
          assert.ok(Array.isArray(item) && (item.length > 0 || compteurVide(value)), `${label} : ${chemin}.faits vide`);
          for (const i of item as number[]) {
            assert.ok(Number.isInteger(i) && i >= 0 && i < visibles, `${label} : ${chemin} désigne ${i} sur ${visibles}`);
            assert.equal(faits[i]?.rootId, vue.rootId, `${label} : ${chemin} désigne un fait d'une autre conversation`);
          }
        } else walk(item, `${chemin}.${key}`);
      }
    }
  };
  walk(vue, "scène");
}

const ligne = (state: ActivityState, key: string) => liveRows(state, 100_000).find((row) => row.key === key);
const faisceaux = (vue: NeonScene) => vue.faisceaux.map((f) => `${f.kind}:${f.de}>${f.vers ?? "?"}`);

// --- Tests ------------------------------------------------------------------------------------------------------------------------

describe("T-L25-i : différé = direct sur les captures réduites du banc et la fixture synthétique", () => {
  for (const nom of [...BANC, SYNTHETIQUE]) {
    it(`${nom} : à chaque pas, scène, lignes, Déroulé, totaux et état identiques relus depuis la base ; aucun signe sans fait`, () => {
      const { pas, racine } = rejouerCapture(nom);
      assert.ok(pas.length >= 5, `${pas.length} pas`);
      const tous = pas.at(-1)?.faits ?? [];
      const base = relus(tous);
      const coupures = new Set(moments(base));
      let compares = 0;
      for (const { faits } of pas) {
        const t = faits.at(-1)?.at ?? 0;
        // Réducteur : en direct, fait par fait, contre la relecture des mêmes faits depuis la base.
        const vivant = direct(racine, faits);
        const differe = replayFacts(emptyActivity(racine), relus(faits));
        assert.deepEqual(liveRows(differe, 100_000), liveRows(vivant, 100_000), `${nom} t=${t} lignes`);
        assert.deepEqual(timeline(differe), timeline(vivant), `${nom} t=${t} Déroulé`);
        assert.deepEqual(totals(differe), totals(vivant), `${nom} t=${t} totaux`);
        assert.deepEqual(activityStatus(differe), activityStatus(vivant), `${nom} t=${t} état`);
        for (const options of optionsDe(tous, racine)) {
          const vue = scene(faits, null, options);
          assertAucunSigneSansFait(vue, faits, faits.length, `${nom} t=${t}`);
          // Scène relue à l'heure t depuis la base : identique au direct quand t coupe net.
          if (coupures.has(t) && visibleCount(base, t) === faits.length) {
            assert.deepEqual(scene(base, t, options), vue, `${nom} t=${t} ${JSON.stringify({ ...options, roleSalle: undefined })}`);
            compares++;
          }
        }
      }
      assert.ok(compares >= pas.length, `${nom} : ${compares} comparaisons de scène`);
      // Toute conversation rejouée est de la salle : l'enceinte y est, dès le premier fait propre à la salle.
      assert.notEqual(scene(tous, null, SALLE).enceinte, null);
    });
  }
});

describe("écart avec la capture M21 (remis par L25a au train de la vague 4)", () => {
  it("M21, capture réduite du banc : ni tâche de fond, ni réveil, ni délégation envoyée — l'appel `task` du faux fournisseur finit en outil `invalid`", () => {
    const { pas, racine } = rejouerCapture("omo-banc-m21.jsonl");
    const faits = pas.at(-1)?.faits ?? [];
    const genres = (kind: string, etat?: string) => faits.filter((f) => f.kind === kind && (etat === undefined || f.data.etat === etat)).length;
    // Ce que la capture contient : la demande, une préparation de délégation (partie `task` en attente), un outil `invalid`.
    assert.equal(genres("consigne", "prepare"), 1);
    assert.deepEqual(
      faits.filter((f) => f.kind === "statut" && f.data.etat === "outil").map((f) => [f.data.nom, f.data.outil, f.data.phase]),
      [
        ["invalid", "autre", "en-cours"],
        ["invalid", "autre", "termine"],
      ],
    );
    // Ce qui MANQUE pour vérifier JP-3 et JP-2 sur le banc : aucune délégation envoyée, aucun enfant, aucun résultat, aucun réveil.
    assert.deepEqual(
      [genres("consigne", "envoyee"), genres("resultat"), genres("reveil"), genres("reprise"), genres("carnet")],
      [0, 0, 0, 0, 0],
    );
    assert.deepEqual([...new Set(faits.map((f) => f.sessionId))], [racine], "une seule session : la racine");
    // La scène dit exactement cela : la préparation en pointillé tant que la racine travaille, puis plus rien ; l'outil compté
    // dans « Autres outils » ; aucun faisceau bleu.
    const preparation = pas.find(({ faits: f }) => f.at(-1)?.kind === "consigne");
    assert.deepEqual(faisceaux(scene(preparation?.faits ?? [], null, SALLE)).filter((f) => f.startsWith("preparation")), [`preparation:${racine}>?`]);
    const fin = scene(faits, null, { ...SALLE, zoom: 3 });
    assert.deepEqual(faisceaux(fin), []);
    assert.equal(fin.detail?.autresOutils.termines, 1);
    assert.deepEqual(
      fin.noeuds.map((n) => [n.sessionId, n.etat]),
      [[racine, "termine"]],
    );
    // Même constat sur R16 et M20 : aucune délégation envoyée par le banc.
    for (const nom of ["omo-banc-r16.jsonl", "omo-banc-m20.jsonl"]) {
      const autres = rejouerCapture(nom).pas.at(-1)?.faits ?? [];
      assert.equal(autres.filter((f) => f.kind === "consigne" && f.data.etat === "envoyee").length, 0, nom);
    }
  });
});

describe("JP-3 et JP-2 sur la fixture synthétique (capture réelle de l'extension en attente)", () => {
  it("JP-3 : la racine qui confie une tâche de fond n'attend pas ; celle qui attend Sisyphus-Junior, si ; le bleu part à la fin de l'enfant", () => {
    const { pas, racine } = rejouerCapture(SYNTHETIQUE);
    assert.equal(racine, JP_RACINE);
    const etatA = (t: number) => {
      const avant = pas.filter((p) => p.recv <= t).at(-1)?.faits ?? [];
      return ligne(direct(racine, avant), racine)?.state;
    };
    // Tâche de fond confiée à 220 (et close « lancée » à 230) : la racine travaille, elle n'attend pas.
    for (const t of [220, 230, 310, 320]) assert.equal(etatA(t), "travaille", `t=${t}`);
    // Sisyphus-Junior confié à 410, résultat attendu à 470 : là, la racine attend.
    assert.equal(etatA(440), "attend-delegation");
    assert.equal(etatA(470), "travaille");
    // Le faisceau bleu de la tâche de fond n'existe qu'à partir du résultat, écrit au repos de l'enfant (500), jamais avant ; il
    // s'éteint à la fin du tour de la racine qui le lit (repos à 620).
    const bleu = `resultat:${JP_FOND}>${JP_RACINE}`;
    const indexResultat = (pas.at(-1)?.faits ?? []).findIndex((f) => f.kind === "resultat" && f.ref === "call_jp_fond");
    assert.ok(indexResultat > 0);
    for (const { faits, recv } of pas) {
      const vue = scene(faits, null, SALLE);
      assert.equal(faisceaux(vue).includes(bleu), faits.length > indexResultat && recv < 620, `t=${recv}`);
      // La consigne rose de la tâche de fond reste tendue de son envoi (220) à la fin de l'enfant (500).
      assert.equal(faisceaux(vue).includes(`consigne:${JP_RACINE}>${JP_FOND}`), recv >= 220 && recv < 500, `t=${recv} consigne`);
    }
    // Rôles par clé : Sisyphus planifie, Explore cherche, Sisyphus-Junior exécute.
    const fin = scene(pas.at(-1)?.faits ?? [], null, SALLE);
    assert.deepEqual(
      fin.noeuds.map((n) => [n.sessionId, n.secteur]),
      [
        [JP_RACINE, null],
        [JP_FOND, "chercher"],
        [JP_JUNIOR, "executer"],
      ],
    );
    // JP-6 : le carnet et le plan touchés par Sisyphus-Junior sont deux tuiles reliées à lui.
    assert.deepEqual(
      fin.carnet.tuiles.map((t) => [t.chemin, t.lu, t.modifie, t.sessions]),
      [
        [".omo/notepads/plan/learnings.md", false, true, [JP_JUNIOR]],
        [".omo/plans/plan.md", true, false, [JP_JUNIOR]],
      ],
    );
    // JP-7 : métadonnées des deux consignes dans le zoom 3.
    const meta = (focus: string) => scene(pas.at(-1)?.faits ?? [], null, { ...SALLE, zoom: 3, focus }).detail?.panneau.metadonnees;
    assert.deepEqual([meta(JP_FOND)?.categorie, meta(JP_FOND)?.ia, meta(JP_FOND)?.competences, meta(JP_FOND)?.attente], ["quick", "github-copilot/claude-sonnet-4.5", 2, "fond"]);
    assert.deepEqual([meta(JP_JUNIOR)?.categorie, meta(JP_JUNIOR)?.competences, meta(JP_JUNIOR)?.attente], ["deep", 1, "resultat"]);
  });

  it("JP-2 : le réveil ne fait ni impulsion, ni appel, ni coût, ni travail ; seule sa marque « résultat déposé » s'ajoute", () => {
    const { pas, racine } = rejouerCapture(SYNTHETIQUE);
    const faits = pas.at(-1)?.faits ?? [];
    // Le message déposé (600-610) n'est classé qu'une fois toutes ses parties connues : au repos de la racine (620), juste après
    // le fait « repos » de ce même événement.
    const iReveil = faits.findIndex((f) => f.kind === "reveil");
    const iRepos = faits.findIndex((f) => f.sessionId === racine && f.kind === "statut" && f.data.etat === "repos");
    assert.ok(iReveil > 0 && iRepos > 0);
    assert.deepEqual(
      faits.slice(iRepos, iReveil + 1).map((f) => [f.kind, f.data.etat ?? f.data.origine, f.at]),
      [
        ["statut", "repos", 620],
        ["origine", "reveil-sans-reponse", 620],
        ["reveil", "depose", 620],
      ],
    );
    const avant = faits.slice(0, iRepos + 1);
    const apres = faits.slice(0, iReveil + 1);
    // Réducteur : aucune ligne, aucun total, aucun Déroulé ne bouge ; un seul appel d'IA dans toute la fixture.
    assert.deepEqual(liveRows(direct(racine, apres), 100_000), liveRows(direct(racine, avant), 100_000));
    assert.deepEqual(timeline(direct(racine, apres)), timeline(direct(racine, avant)));
    assert.deepEqual(totals(direct(racine, apres)), totals(direct(racine, avant)));
    assert.equal(totals(direct(racine, apres)).calls, 1);
    // Scène : ni impulsion vers « GitHub Copilot », ni reprise du travail ; seule la marque d'origine du réveil.
    const a = scene(avant, null, SALLE);
    const b = scene(apres, null, SALLE);
    assert.deepEqual(b.impulsions, a.impulsions);
    assert.deepEqual(b.noeuds, a.noeuds);
    assert.deepEqual(b.faisceaux, a.faisceaux);
    assert.deepEqual(
      b.origines.map((o) => [o.sessionId, o.origine]),
      [[racine, "reveil-sans-reponse"]],
    );
    assert.deepEqual(a.origines, []);
  });
});

// --- Rafale synthétique de la salle ---------------------------------------------------------------------------------------------

const RACINE = "ses_rafale_racine";

/** Événements d'une rafale de la salle en `duree` ms : 70 tâches de fond confiées par la racine et une chaîne de 6 niveaux. */
function rafale(duree: number): Array<{ recv: number; event: FactEvent }> {
  const out: FactEvent[] = [];
  const cree = (id: string, parentID?: string) => out.push({ type: "session.created", properties: { sessionID: id, info: { id, ...(parentID ? { parentID } : {}), agent: "explore" } } });
  const occupee = (id: string) => out.push({ type: "session.status", properties: { sessionID: id, status: { type: "busy" } } });
  const confie = (parent: string, enfant: string, callID: string, fond: boolean) =>
    out.push({
      type: "message.part.updated",
      properties: {
        sessionID: parent,
        part: { sessionID: parent, messageID: `msg_${parent}`, type: "tool", tool: "task", callID, state: { status: "running", input: { subagent_type: "explore", run_in_background: fond }, metadata: { sessionId: enfant, run_in_background: fond, category: "quick" } } },
      },
    });
  cree(RACINE);
  occupee(RACINE);
  for (let i = 0; i < 70; i++) {
    const enfant = `ses_rafale_${String(i).padStart(2, "0")}`;
    confie(RACINE, enfant, `call_r${i}`, true);
    cree(enfant, RACINE);
    occupee(enfant);
  }
  let parent = RACINE;
  for (let n = 1; n <= 6; n++) {
    const enfant = `ses_chaine_${n}`;
    confie(parent, enfant, `call_c${n}`, false);
    cree(enfant, parent);
    occupee(enfant);
    parent = enfant;
  }
  return out.map((event, i) => ({ recv: 1_000 + Math.floor((i * duree) / out.length), event }));
}

/** Instants de rendu : au plus 4 dans toute fenêtre d'une seconde. */
function assertQuatreParSeconde(instants: readonly number[], label: string): void {
  for (const at of instants) {
    const dansLaFenetre = instants.filter((autre) => autre >= at && autre < at + 1_000).length;
    assert.ok(dansLaFenetre <= 4, `${label} : ${dansLaFenetre} rendus dans la seconde qui suit ${at}`);
  }
}

class Horloge implements ActivityClock {
  t = 0;
  #seq = 0;
  minuteries: Array<{ id: number; at: number; fn: () => void }> = [];
  readonly now = () => this.t;
  readonly setTimer = (fn: () => void, ms: number) => {
    const id = ++this.#seq;
    this.minuteries.push({ id, at: this.t + ms, fn });
    return id;
  };
  readonly clearTimer = (handle: unknown) => {
    this.minuteries = this.minuteries.filter((m) => m.id !== handle);
  };
  jusqua(fin: number): void {
    for (;;) {
      const due = this.minuteries.filter((m) => m.at <= fin).sort((a, b) => a.at - b.at || a.id - b.id)[0];
      if (!due) break;
      this.minuteries = this.minuteries.filter((m) => m !== due);
      this.t = due.at;
      due.fn();
    }
    this.t = Math.max(this.t, fin);
  }
}

/** Magasin du navigateur ouvert sur une conversation vide, puis alimenté fait par fait aux heures données ; rend les instants de rendu. */
async function rendusDuMagasin(racine: string, arrivees: ReadonlyArray<{ at: number; fait: ActivityFact }>): Promise<{ instants: number[]; store: ActivityStore }> {
  const horloge = new Horloge();
  horloge.t = (arrivees[0]?.at ?? 0) - 10;
  const source = {
    facts: async () => ({ facts: [], partial: false }),
    session: async () => ({ id: racine }),
    children: async () => [],
    messages: async () => [],
  };
  const store = new ActivityStore(racine, "/workspace/projet", source, horloge);
  const instants: number[] = [];
  store.subscribe(() => instants.push(horloge.t));
  store.start();
  for (let i = 0; i < 20; i++) await new Promise<void>((resolve) => setImmediate(resolve));
  for (const { at, fait } of arrivees) {
    horloge.jusqua(at);
    store.push({ kind: "cockpit", type: "activite.fait", data: fait });
  }
  horloge.jusqua((arrivees.at(-1)?.at ?? 0) + 5_000);
  store.stop();
  return { instants: instants.filter((t) => t >= (arrivees[0]?.at ?? 0)), store };
}

/** File de la bande (neon-band.ts) sous les mêmes arrivées, pilotée comme NeonBand.tsx : un pas à chaque réception et à l'échéance. */
function rendusDeLaBande(arrivees: readonly number[]): { instants: number[]; rattrapages: number } {
  let file = fileNeuve(0);
  let prochain: number | null = null;
  const instants: number[] = [];
  let rattrapages = 0;
  const pas = (maintenant: number) => {
    const avant = file.affiches;
    const suite = avancer(file, maintenant);
    file = suite.file;
    if (file.affiches !== avant) instants.push(maintenant);
    if (suite.rattrape) rattrapages++;
    prochain = suite.prochain;
  };
  for (const [i, at] of arrivees.entries()) {
    while (prochain !== null && prochain <= at) pas(prochain);
    file = recevoir(file, i + 1, at);
    pas(at);
  }
  for (let garde = 0; prochain !== null && garde < 1_000; garde++) pas(prochain);
  assert.equal(file.affiches, arrivees.length, "tous les faits finissent affichés");
  return { instants, rattrapages };
}

describe("bornes sur une rafale synthétique de la salle (§3.10 points 4 et 5)", () => {
  it("3 niveaux et 50 sessions : le réducteur et la scène s'arrêtent aux mêmes bornes, « Déroulé partiel » ; différé = direct", () => {
    const { pas, racine } = rejouer(rafale(900));
    assert.equal(racine, RACINE);
    const faits = pas.at(-1)?.faits ?? [];
    const etat = direct(racine, faits);
    const lignes = liveRows(etat, 100_000);
    assert.ok(lignes.length <= ACTIVITY_MAX_SESSIONS, `${lignes.length} lignes`);
    assert.ok(lignes.every((l) => l.depth <= ACTIVITY_MAX_DEPTH));
    assert.equal(activityStatus(etat).partial, true);
    const vue = scene(faits, null, SALLE);
    assert.ok(vue.noeuds.length <= ACTIVITY_MAX_SESSIONS, `${vue.noeuds.length} assistants dessinés`);
    const profondeur = (id: string | null): number => (id === null ? -1 : 1 + profondeur(vue.noeuds.find((n) => n.sessionId === id)?.parentId ?? null));
    assert.ok(vue.noeuds.every((n) => profondeur(n.sessionId) <= ACTIVITY_MAX_DEPTH));
    assert.ok(vue.horsBornes > 0);
    // La carte ne montre aucun assistant que la liste des acteurs ne suit pas.
    const suivis = new Set(lignes.filter((l) => !l.sansSession).map((l) => l.sessionId));
    assert.ok(vue.noeuds.every((n) => suivis.has(n.sessionId)), "chaque assistant dessiné est une ligne de « Qui travaille ? »");
    assert.deepEqual(liveRows(replayFacts(emptyActivity(racine), relus(faits)), 100_000), lignes);
    assert.deepEqual(scene(relus(faits), null, SALLE), vue);
    // La racine confie 70 tâches de fond : elle n'attend aucune d'elles ; seule la chaîne attendue la fait attendre.
    assert.equal(ligne(etat, racine)?.state, "attend-delegation");
    const sansChaine = direct(racine, faits.filter((f) => !(f.kind === "consigne" && f.ref === "call_c1")));
    assert.equal(ligne(sansChaine, racine)?.state, "travaille");
  });

  it("au plus 4 rendus par seconde, rattrapage compris : magasin du navigateur et file de la bande, sur M20 à son rythme et sur la rafale", async () => {
    const m20 = rejouerCapture("omo-banc-m20.jsonl");
    const faitsM20 = m20.pas.at(-1)?.faits ?? [];
    // M20 : les faits arrivent à l'heure de réception de leur événement.
    const arriveesM20 = faitsM20.map((fait, i) => ({ at: 10_000 + (m20.pas.find((p) => p.faits.length > i)?.recv ?? 0), fait }));
    const r = rejouer(rafale(900));
    const faitsRafale = r.pas.at(-1)?.faits ?? [];
    const arriveesRafale = faitsRafale.map((fait, i) => ({ at: 10_000 + (r.pas.find((p) => p.faits.length > i)?.recv ?? 0), fait }));
    assert.ok(faitsRafale.length >= 200, `${faitsRafale.length} faits`);
    for (const [label, racine, arrivees] of [
      ["M20", m20.racine, arriveesM20],
      ["rafale", r.racine, arriveesRafale],
    ] as const) {
      const { instants, store } = await rendusDuMagasin(racine, arrivees);
      assertQuatreParSeconde(instants, `magasin ${label}`);
      assert.ok(instants.length >= 2, `magasin ${label} : ${instants.length} rendus`);
      assert.equal(store.getSnapshot().state.facts.length, arrivees.length, `magasin ${label} : aucun fait perdu`);
      const bande = rendusDeLaBande(arrivees.map((a) => a.at));
      assertQuatreParSeconde(bande.instants, `bande ${label}`);
      const ecarts = bande.instants.slice(1).map((t, i) => t - (bande.instants[i] ?? 0));
      assert.ok(ecarts.every((ecart) => ecart >= NEON_RENDU_MS), `bande ${label} : 250 ms au moins entre deux rendus`);
      // La rafale déborde la file (plus d'un changement par 250 ms pendant plus de 2 s) : elle est rattrapée d'un coup.
      if (label === "rafale") assert.ok(bande.rattrapages >= 1, "rafale : « Affichage rattrapé »");
    }
    assert.equal(RENDER_MIN_INTERVAL_MS, NEON_RENDU_MS);
  });
});
