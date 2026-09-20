// Route de la chronologie (itération 5, plan d'exécution it5, fiche L47b, D-5-09) : lignes `usage` d'une racine, semées dans la
// base du harnais. Contrôles : racine inconnue et session ENFANT → 404 « racine-inconnue » ; identifiant invalide → 400 ; borne
// CHRONO_MAX_ROWS et champ `tronque` ; champs conformes à ChronologieResponse ; AUCUN texte dans la réponse (ni répertoire, ni
// message d'erreur, ni titre) ; lignes d'une AUTRE racine absentes ; même réponse en mode Simple et en mode Avancé (le serveur ne
// masque rien, c'est l'interface qui montre la chronologie en Avancé seulement) ; route absente sans le module ; lecture seule.
import assert from "node:assert/strict";
import type { DatabaseSync } from "node:sqlite";
import { describe, it, type TestContext } from "node:test";
import { params } from "./db.ts";
import { chronologieRows, registerChronologieRoutes } from "./routes-chronologie.ts";
import { CHRONO_MAX_ROWS, constructionPath, CONSTRUCTION_ROUTE_PATHS } from "./shared/construction-constants.ts";
import { TEXTES } from "./shared/construction-texts.ts";
import type { ChronologieResponse, ChronologieUsageRow } from "./shared/construction-types.ts";
import { startCockpit, type CockpitHarness } from "./test-support/cockpit-harness.ts";

const RACINE = "ses_racine_chrono";
const AUTRE = "ses_autre_racine";
const ENFANT = "ses_enfant_delegue";
const T = (minute: number) => Date.UTC(2026, 8, 20, 9, minute);

/** Adresse de la chronologie d'une conversation, remplie comme le client d'API la remplit. */
const adresse = (rootId: string) => constructionPath(CONSTRUCTION_ROUTE_PATHS.chronologie, rootId);

/** Élément d'une liste, avec un échec lisible quand il manque (`noUncheckedIndexedAccess`). */
function item<T>(liste: readonly T[], index = 0): T {
  const valeur = liste[index];
  assert.ok(valeur !== undefined, `élément ${index} absent (${liste.length} au total)`);
  return valeur;
}

function seedSession(db: DatabaseSync, id: string, parentId: string | null, rootId: string): void {
  db.prepare(
    `INSERT INTO sessions (id, parent_id, root_id, directory, title, purpose, created_at, updated_at)
     VALUES (:id, :parent, :root, '/travail/projet', 'Titre de la conversation', 'chat', :at, :at)`,
  ).run(params({ id, parent: parentId, root: rootId, at: T(0) }));
}

interface UsageSeed {
  id: string;
  sessionId?: string;
  rootId?: string;
  createdAt?: number;
  completedAt?: number | null;
  variant?: string | null;
  tokens?: Partial<Pick<ChronologieUsageRow, "tokensInput" | "tokensOutput" | "tokensReasoning" | "tokensCacheRead" | "tokensCacheWrite">>;
  cost?: number;
  /** Colonnes de texte que la réponse ne doit JAMAIS porter. */
  directory?: string;
  error?: string | null;
}

function seedUsage(db: DatabaseSync, ligne: UsageSeed): void {
  const t = ligne.tokens ?? {};
  db.prepare(
    `INSERT INTO usage (message_id, session_id, root_id, directory, provider_id, model_id, variant, agent, purpose,
       parent_message_id, created_at, completed_at, tokens_input, tokens_output, tokens_reasoning, tokens_cache_read,
       tokens_cache_write, cost, error)
     VALUES (:id, :session, :root, :directory, 'github-copilot', 'gpt-5-mini', :variant, 'conseiller', 'chat',
       'msg_parent', :created, :completed, :tin, :tout, :treason, :tread, :twrite, :cost, :error)`,
  ).run(
    params({
      id: ligne.id,
      session: ligne.sessionId ?? RACINE,
      root: ligne.rootId ?? RACINE,
      directory: ligne.directory ?? "/travail/projet",
      variant: ligne.variant === undefined ? null : ligne.variant,
      created: ligne.createdAt ?? T(1),
      completed: ligne.completedAt === undefined ? T(2) : ligne.completedAt,
      tin: t.tokensInput ?? 0,
      tout: t.tokensOutput ?? 0,
      treason: t.tokensReasoning ?? 0,
      tread: t.tokensCacheRead ?? 0,
      twrite: t.tokensCacheWrite ?? 0,
      cost: ligne.cost ?? 0,
      error: ligne.error ?? null,
    }),
  );
}

/** Harnais avec le module `chronologie` installé et la racine (plus une autre racine et une session déléguée) enregistrées. */
async function harnais(t: TestContext, options: { modules?: string[] } = {}): Promise<CockpitHarness> {
  const h = await startCockpit(t, { modules: (options.modules ?? ["chronologie"]) as never });
  seedSession(h.db, RACINE, null, RACINE);
  seedSession(h.db, AUTRE, null, AUTRE);
  seedSession(h.db, ENFANT, RACINE, RACINE);
  return h;
}

const lire = async (h: CockpitHarness, rootId = RACINE) => h.call("GET", adresse(rootId), { headers: h.headers.authed });

// --- Refus ----------------------------------------------------------------------------------------------------------------------

describe("chronologie : refus", () => {
  it("racine inconnue du cockpit → 404 « racine-inconnue »", async (t: TestContext) => {
    const h = await harnais(t);
    const res = await lire(h, "ses_jamais_vue");
    assert.equal(res.status, 404);
    const corps = res.json<{ error: string; message: string }>();
    assert.equal(corps.error, "racine-inconnue");
    assert.equal(corps.message, TEXTES.partout.erreurs["racine-inconnue"]);
  });

  it("session ENFANT (travail délégué) → 404 : la chronologie est celle d'une conversation entière", async (t: TestContext) => {
    const h = await harnais(t);
    // La session déléguée a pourtant des lignes `usage` : c'est bien le parent, pas l'absence de données, qui ferme la route.
    seedUsage(h.db, { id: "msg_enfant", sessionId: ENFANT });
    const res = await lire(h, ENFANT);
    assert.equal(res.status, 404);
    assert.equal(res.json<{ error: string }>().error, "racine-inconnue");
  });

  it("identifiant invalide → 400, sans toucher à la base", async (t: TestContext) => {
    const h = await harnais(t);
    for (const mauvais of ["ses avec espace", "ses/../autre", "x".repeat(129), "ses%20a", "' OR 1=1 --"]) {
      const res = await h.call("GET", `/api/conversations/${encodeURIComponent(mauvais)}/chronologie`, { headers: h.headers.authed });
      assert.equal(res.status, 400, mauvais);
      assert.equal(res.json<{ error: string }>().error, "invalid");
      assert.ok(!res.body.includes(mauvais), res.body);
    }
  });

  it("sans cookie de session, aucune donnée n'est rendue", async (t: TestContext) => {
    const h = await harnais(t);
    assert.equal((await h.call("GET", adresse(RACINE))).status, 401);
  });

  it("sans le module, la route répond 404 (comportement de l'itération 1)", async (t: TestContext) => {
    const h = await harnais(t, { modules: [] });
    assert.equal((await lire(h)).status, 404);
  });
});

// --- Réponse --------------------------------------------------------------------------------------------------------------------

describe("chronologie : lignes rendues", () => {
  it("champs conformes à ChronologieResponse, les plus anciennes d'abord ; `variant` vide → null", async (t: TestContext) => {
    const h = await harnais(t);
    seedUsage(h.db, {
      id: "msg_2",
      createdAt: T(5),
      completedAt: T(6),
      variant: "",
      tokens: { tokensInput: 11, tokensOutput: 22, tokensReasoning: 33, tokensCacheRead: 44, tokensCacheWrite: 55 },
      cost: 0.25,
    });
    seedUsage(h.db, { id: "msg_1", sessionId: ENFANT, createdAt: T(3), completedAt: null, variant: "thinking", cost: 0.5 });

    const res = await lire(h);
    assert.equal(res.status, 200);
    const corps = res.json<ChronologieResponse>();
    assert.equal(corps.rootId, RACINE);
    assert.equal(corps.tronque, false);
    assert.deepEqual(
      corps.rows.map((r) => r.messageId),
      ["msg_1", "msg_2"],
    );
    assert.deepEqual(item(corps.rows, 0), {
      messageId: "msg_1",
      sessionId: ENFANT,
      agent: "conseiller",
      providerId: "github-copilot",
      modelId: "gpt-5-mini",
      variant: "thinking",
      tokensInput: 0,
      tokensOutput: 0,
      tokensReasoning: 0,
      tokensCacheRead: 0,
      tokensCacheWrite: 0,
      cost: 0.5,
      createdAt: T(3),
      completedAt: null,
    } satisfies ChronologieUsageRow);
    const deuxieme = item(corps.rows, 1);
    assert.equal(deuxieme.variant, null, "chaîne vide enregistrée → null, jamais une IA nommée par une chaîne vide");
    assert.deepEqual(
      [deuxieme.tokensInput, deuxieme.tokensOutput, deuxieme.tokensReasoning, deuxieme.tokensCacheRead, deuxieme.tokensCacheWrite],
      [11, 22, 33, 44, 55],
    );
    assert.equal(deuxieme.completedAt, T(6));
  });

  it("aucun texte dans la réponse : ni répertoire, ni erreur d'appel, ni titre de conversation", async (t: TestContext) => {
    const h = await harnais(t);
    seedUsage(h.db, { id: "msg_1", directory: "/travail/SECRET-REPERTOIRE", error: "SECRET-ERREUR-DE-APPEL" });
    const res = await lire(h);
    assert.equal(res.status, 200);
    for (const texte of ["SECRET-REPERTOIRE", "SECRET-ERREUR-DE-APPEL", "Titre de la conversation", "msg_parent"]) {
      assert.ok(!res.body.includes(texte), `${texte} ne doit pas sortir : ${res.body}`);
    }
    // Les clés rendues sont exactement celles du contrat : aucune colonne de texte ajoutée par mégarde.
    assert.deepEqual(Object.keys(item(res.json<ChronologieResponse>().rows)).sort(), [
      "agent",
      "completedAt",
      "cost",
      "createdAt",
      "messageId",
      "modelId",
      "providerId",
      "sessionId",
      "tokensCacheRead",
      "tokensCacheWrite",
      "tokensInput",
      "tokensOutput",
      "tokensReasoning",
      "variant",
    ]);
    assert.deepEqual(Object.keys(res.json<ChronologieResponse>()).sort(), ["rootId", "rows", "tronque"]);
  });

  it("les lignes d'une AUTRE racine ne sont jamais rendues", async (t: TestContext) => {
    const h = await harnais(t);
    seedUsage(h.db, { id: "msg_ici", createdAt: T(1) });
    seedUsage(h.db, { id: "msg_ailleurs", sessionId: AUTRE, rootId: AUTRE, createdAt: T(2) });
    const corps = (await lire(h)).json<ChronologieResponse>();
    assert.deepEqual(
      corps.rows.map((r) => r.messageId),
      ["msg_ici"],
    );
    const autre = (await lire(h, AUTRE)).json<ChronologieResponse>();
    assert.deepEqual(
      autre.rows.map((r) => r.messageId),
      ["msg_ailleurs"],
    );
  });

  it("conversation sans aucun appel d'IA : liste vide, jamais 404", async (t: TestContext) => {
    const h = await harnais(t);
    const corps = (await lire(h)).json<ChronologieResponse>();
    assert.deepEqual(corps, { rootId: RACINE, rows: [], tronque: false });
  });

  it("borne CHRONO_MAX_ROWS : la ligne de trop est coupée et `tronque` passe à vrai", async (t: TestContext) => {
    const h = await harnais(t);
    const inserer = (n: number) => {
      for (let i = 0; i < n; i++) seedUsage(h.db, { id: `msg_${String(i).padStart(5, "0")}`, createdAt: T(0) + i });
    };
    inserer(CHRONO_MAX_ROWS);
    const pile = (await lire(h)).json<ChronologieResponse>();
    assert.equal(pile.rows.length, CHRONO_MAX_ROWS);
    assert.equal(pile.tronque, false, "exactement la borne : rien n'est coupé");

    seedUsage(h.db, { id: "msg_99999", createdAt: T(0) + CHRONO_MAX_ROWS });
    const trop = (await lire(h)).json<ChronologieResponse>();
    assert.equal(trop.rows.length, CHRONO_MAX_ROWS);
    assert.equal(trop.tronque, true);
    // Les plus anciennes sont gardées : la ligne coupée est bien la dernière.
    assert.equal(item(trop.rows, 0).messageId, "msg_00000");
    assert.ok(!trop.rows.some((r) => r.messageId === "msg_99999"));
  });

  it("le serveur ne masque rien : même réponse en mode Simple et en mode Avancé", async (t: TestContext) => {
    const h = await harnais(t);
    seedUsage(h.db, { id: "msg_1", tokens: { tokensInput: 100, tokensOutput: 20 }, cost: 0.125 });
    assert.equal(h.settings.get().ui.mode, "simple");
    const simple = (await lire(h)).body;
    h.settings.update({ ui: { mode: "avance" } });
    assert.equal((await lire(h)).body, simple);
  });

  it("la lecture est bornée DANS le SQL et paramétrée : une requête, LIMIT :max, aucune valeur dans le texte", () => {
    const vues: Array<{ sql: string; args: unknown }> = [];
    // Doublure de base : la borne doit être demandée à SQLite, pas seulement appliquée après coup — sans quoi une conversation
    // très longue ferait lire toute la table en mémoire avant d'être coupée.
    const faux = {
      prepare(sql: string) {
        return {
          all(args: unknown) {
            vues.push({ sql, args });
            return [];
          },
        };
      },
    } as unknown as DatabaseSync;
    const reponse = chronologieRows(faux, RACINE);
    assert.deepEqual(reponse, { rootId: RACINE, rows: [], tronque: false });
    assert.equal(vues.length, 1, "une seule requête");
    const vue = item(vues);
    assert.match(vue.sql, /LIMIT :max/);
    assert.deepEqual(vue.args, { root: RACINE, max: CHRONO_MAX_ROWS + 1 });
    assert.ok(!vue.sql.includes(RACINE), "l'identifiant passe en paramètre, jamais dans le texte de la requête");
  });

  it("la lecture n'écrit jamais dans la base", async (t: TestContext) => {
    const h = await harnais(t);
    seedUsage(h.db, { id: "msg_1", cost: 0.5 });
    const etat = () => JSON.stringify([h.db.prepare("SELECT * FROM usage").all(), h.db.prepare("SELECT * FROM sessions").all()]);
    const avant = etat();
    chronologieRows(h.db, RACINE);
    await lire(h);
    assert.equal(etat(), avant);
    assert.equal(typeof registerChronologieRoutes, "function");
  });
});
