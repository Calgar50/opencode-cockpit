// Mentions @ du composeur (GET /api/oc/find/file) filtrées par estProtege (1.1, rang de fusion GFN ; décision A21, fiche NAV §12.2
// n° 2, BAS). Avant : opencode rendait, et le cockpit relayait, les noms des fichiers protégés (.env, clés, identifiants, .git…)
// alors que l'onglet « Fichiers » les masque. Ici, le proxy des deux instances est monté par createOcProxy avec un client opencode
// factice qui sert /find/file (le faux du harnais ne connaît pas cette route) ; aucun appel facturé.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Hono } from "hono";
import type { Logger } from "./log.ts";
import { createOcProxy, mentionsSansProteges, PROXY_RULES, PROXY_RULES_OMO } from "./oc-proxy.ts";
import type { InstanceDeps } from "./omo-contracts.ts";
import type { OpencodeClient } from "./opencode.ts";
import type { AppEnv } from "./env.ts";
import type { ProjectsService } from "./projects.ts";

/** Ce que rend opencode pour « @ » dans un projet où l'IA a écrit des scripts, à côté de secrets factices. */
const LISTE_OPENCODE = [
  "README.md",
  "src/app.ts",
  "scripts/deploy.ps1",
  "scripts/Get-Token.ps1",
  "scripts/Reset-Password.ps1",
  "docs/secret-sauce.md",
  ".env",
  ".env.example",
  "config/.env.local",
  "prod.env",
  ".git/config",
  ".git/",
  "cle.pfx",
  "certs/server.pem",
  "credentials.json",
  "scripts/credentials.ps1",
  "secrets/readme.md",
  ".ssh/id_ed25519",
  "id_rsa",
  ".npmrc",
  "auth.json",
  "opencode.jsonc",
  ".bash_history",
  "infra/terraform.tfstate.backup",
];
const VISIBLES = ["README.md", "src/app.ts", "scripts/deploy.ps1", "scripts/Get-Token.ps1", "scripts/Reset-Password.ps1", "docs/secret-sauce.md"];

describe("mentions @ : noms protégés retirés (mentionsSansProteges)", () => {
  it("retire chaque nom que l'onglet Fichiers protège, garde les autres dans l'ordre (scripts de l'IA compris, exception A6)", () => {
    assert.deepEqual(mentionsSansProteges(JSON.stringify(LISTE_OPENCODE)), VISIBLES);
  });

  it("fermé en cas de doute : JSON illisible ou autre chose qu'une liste → liste vide ; élément qui n'est pas un texte → retiré", () => {
    assert.deepEqual(mentionsSansProteges("pas du JSON"), []);
    assert.deepEqual(mentionsSansProteges(""), []);
    assert.deepEqual(mentionsSansProteges(JSON.stringify({ fichiers: [".env"] })), []);
    assert.deepEqual(mentionsSansProteges(JSON.stringify([".env", 3, null, { chemin: ".env" }, "a.txt"])), ["a.txt"]);
  });

  it("aucun décodage ni normalisation : un nom %XX reste un seul nom ; une barre oblique inverse découpe aussi (prudence)", () => {
    assert.deepEqual(mentionsSansProteges(JSON.stringify(["a%2F..%2Fnotes.txt", "dossier\\.env", "b/../.env", "a%2F..%2F.env"])), ["a%2F..%2Fnotes.txt"]);
  });
});

// --- Proxy des deux instances ------------------------------------------------------------------------------------------------------

interface Montage {
  app: Hono;
  /** Requêtes reçues par le client factice : « MÉTHODE chemin?requête ». */
  recues: string[];
}

/** Proxy /api/oc/* (instance principale) et /api/omo/oc/* (salle), sur un client opencode factice qui sert /find/file. */
function montage(reponse: () => Response): Montage {
  const recues: string[] = [];
  const client = {
    url: (sub: string) => new URL(sub, "http://opencode.test"),
    raw: async (method: string, target: URL) => {
      recues.push(`${method} ${target.pathname}${target.search}`);
      return reponse();
    },
  } as unknown as OpencodeClient;
  const instance = (nom: "principale" | "omo"): InstanceDeps =>
    ({
      instance: nom,
      client,
      gate: {},
      lookup: {},
      catalog: {},
      processor: {},
      billRefusal: () => null,
      beginBilled: () => () => undefined,
      isAllowedDirectory: (dir: string) => dir === "/workspace" || dir.startsWith("/workspace/"),
    }) as unknown as InstanceDeps;
  const log: Logger = { debug: () => undefined, info: () => undefined, warn: () => undefined, error: () => undefined };
  const commun = {
    env: {} as AppEnv,
    log,
    projects: { isAllowedDirectory: () => true, opencodeWorktree: async () => "/workspace", opencodeRoot: "/workspace" } as unknown as Pick<
      ProjectsService,
      "isAllowedDirectory" | "opencodeWorktree" | "opencodeRoot"
    >,
    instanceOf: () => null,
    forbiddenProxyBody: () => undefined,
    forbiddenCommandArguments: () => undefined,
    enforceTurn: async (_c: unknown, _sub: string, _directory: string | null, body: string) => body,
  };
  const app = new Hono();
  app.all("/api/oc/*", createOcProxy({ ...commun, instance: instance("principale"), prefix: "/api/oc", rules: PROXY_RULES }));
  app.all("/api/omo/oc/*", createOcProxy({ ...commun, instance: instance("omo"), prefix: "/api/omo/oc", rules: PROXY_RULES_OMO }));
  return { app, recues };
}

const liste = () => new Response(JSON.stringify(LISTE_OPENCODE), { status: 200, headers: { "content-type": "application/json" } });

describe("mentions @ : GET /find/file filtré par le proxy des deux instances", () => {
  for (const prefixe of ["/api/oc", "/api/omo/oc"]) {
    it(`${prefixe}/find/file : un nom protégé n'est plus rendu ; requête relayée telle quelle, une seule fois`, async () => {
      const m = montage(liste);
      const res = await m.app.request(`${prefixe}/find/file?query=e&directory=${encodeURIComponent("/workspace/proj")}&limit=30`);
      assert.equal(res.status, 200);
      assert.match(res.headers.get("content-type") ?? "", /^application\/json/);
      const rendu = (await res.json()) as string[];
      assert.deepEqual(rendu, VISIBLES);
      for (const nom of [".env", ".env.example", ".git/config", "cle.pfx", "credentials.json", "id_rsa", "auth.json"]) {
        assert.equal(rendu.includes(nom), false, `${nom} rendu par les mentions @`);
      }
      assert.deepEqual(m.recues, [`GET /find/file?query=e&directory=%2Fworkspace%2Fproj&limit=30`]);
    });
  }

  it("erreur d'opencode : relayée telle quelle (statut et corps), sans filtrage", async () => {
    const corps = JSON.stringify({ name: "UnknownError", data: { message: "instance en panne" } });
    const m = montage(() => new Response(corps, { status: 500, headers: { "content-type": "application/json" } }));
    const res = await m.app.request(`/api/oc/find/file?query=e&directory=${encodeURIComponent("/workspace/proj")}`);
    assert.equal(res.status, 500);
    assert.equal(await res.text(), corps);
  });

  it("réponse d'opencode qui n'est pas une liste : liste vide (fermé en cas de doute)", async () => {
    const m = montage(() => new Response("<html>.env</html>", { status: 200, headers: { "content-type": "text/html" } }));
    const res = await m.app.request(`/api/oc/find/file?query=e&directory=${encodeURIComponent("/workspace/proj")}`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type") ?? "", /^application\/json/);
    assert.deepEqual(await res.json(), []);
  });

  it("dossier refusé (hors du workspace) : 403 avant toute requête, comme avant", async () => {
    const m = montage(liste);
    const res = await m.app.request(`/api/oc/find/file?query=auth.json&directory=${encodeURIComponent("/home/node/.local/share/opencode")}`);
    assert.equal(res.status, 403);
    assert.deepEqual(m.recues, []);
  });
});
