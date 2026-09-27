// Tests L28a, politique d'accès à « Revoir » (spécification §5.9 l.1018-1024, Q6 ; plan d'exécution it3, fiche L28a, D-3d-09) :
// table complète de revoirAcces (racine inconnue, instance principale, salle en Avancé, salle en Simple selon les sessions occupées
// et la dernière demande), valeurs illisibles fermées en cas de doute ; occupeesSelonFaits sur les suites occupée, repos, erreur et
// nouvelle tentative, faits partiels → null, et sur les captures p1, p2, p6, p7.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { EventMemory, type FactContext, FactDeduper, type FactEvent, factsFromEvent, type FactSession } from "./shared/activity-facts.ts";
import type { ActivityFact, FactValue, SessionInstance } from "./shared/activity-types.ts";
import type { NeonMode } from "./shared/neon-scene.ts";
import { occupeesSelonFaits, type RevoirAcces, type RevoirAccesEntree, revoirAcces, type RevoirRefus } from "./shared/revoir-access.ts";
import { readCapture } from "./test-support/fake-opencode.ts";

const OK: RevoirAcces = { ok: true };
const refus = (status: 403 | 404, code: RevoirRefus): RevoirAcces => ({ ok: false, status, code });
const INCONNUE = refus(404, "racine-inconnue");
const EN_COURS = refus(403, "salle-demande-en-cours");
const FIN_INCONNUE = refus(403, "salle-fin-inconnue");

const entree = (extra: Partial<RevoirAccesEntree> = {}): RevoirAccesEntree => ({
  existe: true,
  instance: "omo",
  mode: "simple",
  sessionsOccupees: 0,
  derniereDemande: { finie: true },
  ...extra,
});

describe("revoirAcces : table des cas (D-3d-09)", () => {
  it("cas écrits un par un", () => {
    const table: Array<[string, Partial<RevoirAccesEntree>, RevoirAcces]> = [
      ["racine inconnue", { existe: false }, INCONNUE],
      ["racine inconnue, même principale en Avancé", { existe: false, instance: "principale", mode: "avance" }, INCONNUE],
      ["principale en Simple, demande en cours", { instance: "principale", sessionsOccupees: 2, derniereDemande: { finie: false } }, OK],
      ["principale en Simple, faits partiels", { instance: "principale", sessionsOccupees: null, derniereDemande: null }, OK],
      ["principale en Avancé", { instance: "principale", mode: "avance" }, OK],
      ["salle en Avancé, demande en cours", { mode: "avance", sessionsOccupees: 1, derniereDemande: { finie: false } }, OK],
      ["salle en Avancé, faits partiels", { mode: "avance", sessionsOccupees: null, derniereDemande: null }, OK],
      ["salle en Simple, demande terminée", {}, OK],
      ["salle en Simple, faits partiels", { sessionsOccupees: null }, FIN_INCONNUE],
      ["salle en Simple, aucune demande", { derniereDemande: null }, FIN_INCONNUE],
      ["salle en Simple, faits partiels et demande en cours", { sessionsOccupees: null, derniereDemande: { finie: false } }, FIN_INCONNUE],
      ["salle en Simple, session occupée", { sessionsOccupees: 1 }, EN_COURS],
      ["salle en Simple, demande pas finie", { derniereDemande: { finie: false } }, EN_COURS],
      ["salle en Simple, occupée et pas finie", { sessionsOccupees: 3, derniereDemande: { finie: false } }, EN_COURS],
    ];
    for (const [cas, extra, attendu] of table) assert.deepEqual(revoirAcces(entree(extra)), attendu, cas);
  });

  it("table complète (144 combinaisons) : 404 seulement pour une racine inconnue ; en Simple, la salle n'ouvre qu'une demande terminée", () => {
    let combinaisons = 0;
    for (const existe of [true, false])
      for (const instance of ["principale", "omo", null] as Array<SessionInstance | null>)
        for (const mode of ["simple", "avance"] as NeonMode[])
          for (const sessionsOccupees of [null, 0, 1, 3])
            for (const derniereDemande of [null, { finie: true }, { finie: false }]) {
              combinaisons += 1;
              const e: RevoirAccesEntree = { existe, instance, mode, sessionsOccupees, derniereDemande };
              const verdict = revoirAcces(e);
              const cas = JSON.stringify(e);
              if (!existe) {
                assert.deepEqual(verdict, INCONNUE, cas);
                continue;
              }
              if (instance === "principale" || mode === "avance") {
                assert.deepEqual(verdict, OK, cas);
                continue;
              }
              if (sessionsOccupees === null || derniereDemande === null) assert.deepEqual(verdict, FIN_INCONNUE, cas);
              else if (sessionsOccupees === 0 && derniereDemande.finie) assert.deepEqual(verdict, OK, cas);
              else assert.deepEqual(verdict, EN_COURS, cas);
            }
    assert.equal(combinaisons, 144);
  });

  it("valeurs illisibles : fermé en cas de doute (instance ou mode inconnus = salle en Simple ; nombre ou drapeau illisibles = fin inconnue)", () => {
    const illisible = <T>(value: unknown) => value as T;
    for (const sessionsOccupees of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, illisible<number>("0")]) {
      assert.deepEqual(revoirAcces(entree({ sessionsOccupees })), FIN_INCONNUE, String(sessionsOccupees));
    }
    for (const finie of ["true", 1, undefined, null]) assert.deepEqual(revoirAcces(entree({ derniereDemande: illisible({ finie }) })), FIN_INCONNUE, String(finie));
    for (const mode of ["SIMPLE", "Avance", "", undefined]) {
      assert.deepEqual(revoirAcces(entree({ mode: illisible(mode), sessionsOccupees: 1 })), EN_COURS, `mode ${String(mode)}`);
      assert.deepEqual(revoirAcces(entree({ mode: illisible(mode) })), OK, `mode ${String(mode)}, demande terminée`);
    }
    for (const instance of ["autre", "Principale", "", undefined]) {
      assert.deepEqual(revoirAcces(entree({ instance: illisible(instance), sessionsOccupees: 1 })), EN_COURS, `instance ${String(instance)}`);
    }
    for (const existe of ["true", 1, undefined, null]) assert.deepEqual(revoirAcces(entree({ existe: illisible(existe), instance: "principale" })), INCONNUE, String(existe));
  });
});

// --- occupeesSelonFaits ---------------------------------------------------------------------------------------------------------

const R = "ses_racine";
const statut = (sessionId: string, data: Record<string, FactValue>, at: number): ActivityFact => ({ rootId: R, sessionId, kind: "statut", ref: null, data, at });
const suite = (...etats: Array<[string, string]>): ActivityFact[] => etats.map(([sessionId, etat], i) => statut(sessionId, { etat }, 1_000 + i));

describe("occupeesSelonFaits : dernier état de cycle de chaque session (D-3d-09, condition 1)", () => {
  it("suites occupée, repos, erreur, nouvelle tentative", () => {
    const cas: Array<[string, ActivityFact[], number]> = [
      ["aucun fait", [], 0],
      ["occupée", suite([R, "occupee"]), 1],
      ["occupée puis repos", suite([R, "occupee"], [R, "repos"]), 0],
      ["occupée puis erreur", suite([R, "occupee"], [R, "erreur"]), 0],
      ["nouvelle tentative", suite([R, "occupee"], [R, "nouvelle-tentative"]), 1],
      ["erreur puis occupée", suite([R, "erreur"], [R, "occupee"]), 1],
      ["repos puis nouvelle tentative", suite([R, "repos"], [R, "nouvelle-tentative"]), 1],
      ["deux sessions, une au repos", suite([R, "occupee"], ["ses_a", "occupee"], [R, "repos"]), 1],
      ["trois sessions occupées", suite([R, "occupee"], ["ses_a", "occupee"], ["ses_b", "nouvelle-tentative"]), 3],
    ];
    for (const [nom, faits, attendu] of cas) assert.equal(occupeesSelonFaits(faits, false), attendu, nom);
  });

  it("seuls les états de cycle comptent : outil, appel, création et fait d'arrêt (cause) ne changent rien", () => {
    const faits = [
      ...suite([R, "occupee"]),
      statut(R, { etat: "outil", outil: "lire", phase: "termine", callId: "call_a" }, 2_000),
      statut(R, { etat: "appel-fini", messageId: "msg_a" }, 2_001),
      statut("ses_a", { etat: "creee", role: "delegation", parent: R }, 2_002),
      statut(R, { cause: "arret", etat: "repos" }, 2_003),
      { rootId: R, sessionId: R, kind: "reponse", ref: "per_a", data: { reponse: "once", etat: "repos" }, at: 2_004 } as ActivityFact,
    ];
    assert.equal(occupeesSelonFaits(faits, false), 1);
    const illisibles = [...suite(["ses_a", "occupee"]), null, { sessionId: 3, kind: "statut", data: { etat: "occupee" } }, { sessionId: "ses_b", kind: "statut", data: null }] as unknown as ActivityFact[];
    assert.equal(occupeesSelonFaits(illisibles, false), 1);
  });

  it("faits partiels → null : drapeau partial, drapeau illisible, ou fait « Déroulé partiel » du magasin", () => {
    const faits = suite([R, "repos"]);
    assert.equal(occupeesSelonFaits(faits, true), null);
    assert.equal(occupeesSelonFaits(faits, undefined as unknown as boolean), null);
    const coupee = [...faits, { rootId: R, sessionId: R, kind: "affichage", ref: null, data: { etat: "deroule-partiel" }, at: 9_000 } as ActivityFact];
    assert.equal(occupeesSelonFaits(coupee, false), null);
    const rattrape = [...faits, { rootId: R, sessionId: R, kind: "affichage", ref: null, data: { etat: "rattrape" }, at: 9_000 } as ActivityFact];
    assert.equal(occupeesSelonFaits(rattrape, false), 0, "« Affichage rattrapé » n'est pas une coupure");
  });

  it("captures : p1 à mi-parcours (racine et deux enfants au travail) puis au repos ; p2, p6 et p7 à la fin", () => {
    const ROOT = "ses_f618ff214ffevi6gfuGx6TvpTP";
    const replay = (name: string): ActivityFact[] => {
      const sessions = new Map<string, FactSession>([[ROOT, { rootId: ROOT, parentId: null, purpose: "chat", instance: "principale" }]]);
      const memory = new EventMemory();
      const deduper = new FactDeduper();
      const resolve = (id: string, info?: Readonly<Record<string, unknown>>): FactSession | null => {
        const known = sessions.get(id);
        if (known) return known;
        const parentId = typeof info?.parentID === "string" ? info.parentID : null;
        const parent = parentId === null ? undefined : sessions.get(parentId);
        return info?.id === id && parent ? { rootId: parent.rootId, parentId, purpose: "chat", instance: "principale" } : null;
      };
      const kept: ActivityFact[] = [];
      for (const { recv, wire } of readCapture(name)) {
        const event = wire.payload as FactEvent;
        memory.observe(event);
        const info = event.properties?.info as Record<string, unknown> | undefined;
        if (event.type === "session.created" && typeof info?.id === "string") {
          const session = resolve(info.id, info);
          if (session) sessions.set(info.id, session);
        }
        const ctx: FactContext = {
          receivedAt: recv,
          session: resolve,
          messageRole: (id) => memory.messageRole(id),
          promptKind: () => null,
          firstUserMessage: (id) => memory.firstUserMessage(id),
          userMessageParts: (id) => memory.userMessageParts(id),
          unansweredUserMessages: (id) => memory.unansweredUserMessages(id),
        };
        kept.push(...factsFromEvent(event, ctx).filter((fact) => deduper.accept(fact)));
      }
      return kept;
    };
    const p1 = replay("p1-delegation-parallele.jsonl");
    const enfantsAuTravail = p1.findIndex((f, i) => i > 0 && f.kind === "statut" && f.data.etat === "occupee" && f.sessionId === "ses_f618fbb91ffepC06O3owB9ayZ7");
    assert.ok(enfantsAuTravail > 0);
    assert.equal(occupeesSelonFaits(p1.slice(0, enfantsAuTravail + 1), false), 3);
    assert.equal(occupeesSelonFaits(p1, false), 0);
    const salle = (faits: ActivityFact[], finie: boolean) =>
      revoirAcces({ existe: true, instance: "omo", mode: "simple", sessionsOccupees: occupeesSelonFaits(faits, false), derniereDemande: { finie } });
    assert.deepEqual(salle(p1, true), OK);
    assert.deepEqual(salle(p1.slice(0, enfantsAuTravail + 1), true), EN_COURS);
    for (const name of ["p2-commande-subtask.jsonl", "p6-arret-global.jsonl"]) assert.equal(occupeesSelonFaits(replay(name), false), 0, name);
    // p7 : l'enfant détaché reçoit son « once » tardif et se met au travail ; la capture s'arrête avant sa fin.
    const p7 = replay("p7-autorisation-orpheline.jsonl");
    assert.equal(occupeesSelonFaits(p7, false), 1);
    assert.deepEqual(salle(p7, true), EN_COURS, "enfant encore occupé : demande en cours, même si la ligne de la demande est finie");
  });
});
