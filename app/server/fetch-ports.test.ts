import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import net, { type AddressInfo } from "node:net";
import path from "node:path";
import { describe, it } from "node:test";
import { FETCH_BLOCKED_PORTS, isFetchBlockedPort } from "./fetch-ports.ts";
import { describeNetworkError, OpencodeClient } from "./opencode.ts";
import { FETCH_BLOCKED_PORTS as FAKE_FETCH_BLOCKED_PORTS } from "./test-support/fake-opencode.ts";
import { listenFetchable, until } from "./test-support/helpers.ts";

const closed = (server: net.Server) => new Promise<void>((resolve) => (server.listening ? server.close(() => resolve()) : resolve()));

describe("ports refusés par fetch", () => {
  it("liste conforme à Node : fetch refuse chaque port avant toute connexion (« bad port »)", async () => {
    for (const port of FETCH_BLOCKED_PORTS) {
      await assert.rejects(fetch(`http://127.0.0.1:${port}/global/health`), (err: unknown) => {
        assert.ok(err instanceof TypeError && err.cause instanceof Error, `port ${port}`);
        assert.equal(err.cause.message, "bad port", `port ${port}`);
        return true;
      });
    }
    assert.equal([...FETCH_BLOCKED_PORTS].filter((port) => port > 1024).length, 19, "19 ports bloqués dans la plage dynamique de Windows");
  });

  it("isFetchBlockedPort : vrai pour chaque port de la liste, faux pour les ports ordinaires", () => {
    for (const port of FETCH_BLOCKED_PORTS) assert.equal(isFetchBlockedPort(port), true, `port ${port}`);
    for (const port of [0, 80, 443, 4096, 7777, 8080, 10079, 10081, 65535]) assert.equal(isFetchBlockedPort(port), false, `port ${port}`);
  });

  it("faux opencode : ré-export de la même liste, sous le même nom", () => {
    assert.equal(FAKE_FETCH_BLOCKED_PORTS, FETCH_BLOCKED_PORTS);
  });

  it("serveur : aucun module de production n'importe test-support (retiré de l'image)", () => {
    const root = import.meta.dirname;
    const production = fs
      .readdirSync(root, { recursive: true, encoding: "utf8" })
      .map((file) => file.replaceAll("\\", "/"))
      .filter((file) => /\.tsx?$/.test(file) && !file.endsWith(".test.ts") && !file.startsWith("test-support/"));
    assert.ok(production.includes("fetch-ports.ts") && production.includes("opencode.ts"));
    const offenders = production.filter((file) => /from\s+["'][^"']*test-support|import\(\s*["'][^"']*test-support/.test(fs.readFileSync(path.join(root, file), "utf8")));
    assert.deepEqual(offenders, []);
  });
});

describe("listenFetchable", () => {
  it("ne rend jamais un port refusé : chaque port refusé (simulé) reste tenu par un bouche-trou pendant le choix suivant, puis est libéré", async (t) => {
    const server = http.createServer((_req, res) => res.end("ok"));
    t.after(() => closed(server));
    const placeholders: net.Server[] = [];
    const create = net.createServer;
    t.mock.method(net, "createServer", ((...args: unknown[]) => {
      const placeholder = (create as (...params: unknown[]) => net.Server)(...args);
      placeholders.push(placeholder);
      return placeholder;
    }) as typeof net.createServer);
    t.after(() => Promise.all(placeholders.map(closed)));
    // Deux premiers ports rendus annoncés refusés ; ports tenus par les bouche-trous relevés à chaque écoute.
    const simulated = [6566, 4190];
    const heldAtEachListen: Array<Array<number | null>> = [];
    const realAddress = server.address.bind(server);
    server.address = () => {
      heldAtEachListen.push(placeholders.map((p) => (p.listening ? (p.address() as AddressInfo).port : null)));
      const port = simulated[heldAtEachListen.length - 1];
      return port === undefined ? realAddress() : { address: "127.0.0.1", family: "IPv4", port };
    };
    const port = await listenFetchable(server, "127.0.0.1");
    t.mock.restoreAll();
    assert.equal(isFetchBlockedPort(port), false);
    assert.equal(server.listening, true);
    assert.equal(port, (realAddress() as AddressInfo).port);
    assert.deepEqual(heldAtEachListen, [[], [6566], [6566, 4190]]);
    assert.deepEqual(placeholders.map((p) => p.listening), [false, false], "bouche-trous libérés");
    const answer = await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(3_000) }).catch((err: unknown) => err);
    assert.ok(answer instanceof Response, "fetch joint le port rendu");
  });

  it("ports refusés à chaque essai : erreur explicite après maxAttempts, serveur fermé, bouche-trous libérés", async (t) => {
    const server = http.createServer();
    t.after(() => closed(server));
    const placeholders: net.Server[] = [];
    const create = net.createServer;
    t.mock.method(net, "createServer", ((...args: unknown[]) => {
      const placeholder = (create as (...params: unknown[]) => net.Server)(...args);
      placeholders.push(placeholder);
      return placeholder;
    }) as typeof net.createServer);
    t.after(() => Promise.all(placeholders.map(closed)));
    server.address = () => ({ address: "127.0.0.1", family: "IPv4", port: 10080 });
    await assert.rejects(listenFetchable(server, "127.0.0.1", 3), /aucun port accepté par fetch en 3 essais/);
    t.mock.restoreAll();
    assert.equal(server.listening, false);
    assert.equal(placeholders.length, 3);
    assert.ok(placeholders.every((p) => !p.listening), "bouche-trous libérés");
  });
});

describe("subscribeGlobal : cause d'un échec réseau", () => {
  const password = `mot-de-passe-${"q".repeat(12)}`;
  const encoded = Buffer.from(`opencode:${password}`).toString("base64");
  const clientFor = () => new OpencodeClient({ opencodeUrl: "http://127.0.0.1:4096", opencodeUsername: "opencode", opencodePassword: password });

  /** Premier statut publié par subscribeGlobal quand fetch lève `error`. */
  async function firstStatus(t: import("node:test").TestContext, error: unknown) {
    t.mock.method(globalThis, "fetch", async () => {
      throw error;
    });
    const statuses: Array<{ status: string; error: string | undefined }> = [];
    const stop = clientFor().subscribeGlobal(
      () => undefined,
      (status, message) => statuses.push({ status, error: message }),
    );
    t.after(stop);
    const first = await until(() => statuses[0]);
    stop();
    return first;
  }

  it("fetch qui lève TypeError('fetch failed', {cause: {code: 'ECONNREFUSED'}}) : « disconnected » avec ECONNREFUSED", async (t) => {
    const first = await firstStatus(t, new TypeError("fetch failed", { cause: { code: "ECONNREFUSED" } }));
    assert.deepEqual(first, { status: "disconnected", error: "fetch failed : ECONNREFUSED" });
  });

  it("cause qui contient le mot de passe, les identifiants encodés ou une adresse à identifiants : rien de tout cela dans le statut", async (t) => {
    const cause = Object.assign(new Error(`connexion refusée pour ${password} (en-tête ${encoded}) vers http://opencode:${password}@opencode:4096/global/event`), {
      code: "ECONNREFUSED",
    });
    const first = await firstStatus(t, new TypeError("fetch failed", { cause }));
    assert.equal(first.status, "disconnected");
    assert.match(first.error ?? "", /^fetch failed : ECONNREFUSED connexion refusée/);
    assert.ok(!(first.error ?? "").includes(password), "mot de passe");
    assert.ok(!(first.error ?? "").includes(encoded), "identifiants encodés");
  });

  it("describeNetworkError : deux niveaux de cause au plus, codes vérifiés, adresse à identifiants et en-tête masqués, 300 caractères au plus", () => {
    const err = new TypeError("fetch failed", {
      cause: Object.assign(new Error(`Request cannot be constructed from a URL that includes credentials: http://opencode:${password}@opencode:4096/`), {
        code: "ERR_INVALID_URL",
        cause: { code: "UND_ERR_SOCKET", message: `authorization: Basic ${encoded}`, cause: { message: "niveau trois" } },
      }),
    });
    const text = describeNetworkError(err);
    assert.match(text, /^fetch failed : ERR_INVALID_URL Request cannot be constructed/);
    assert.match(text, /http:\/\/opencode:\*\*\*\*@opencode:4096/);
    assert.match(text, / : UND_ERR_SOCKET authorization: Basic \*\*\*\*$/);
    assert.ok(!text.includes(password) && !text.includes(encoded) && !text.includes("niveau trois"), text);
    assert.equal(describeNetworkError({ message: "échec", code: "pas un code" }), "échec");
    assert.equal(describeNetworkError(new Error("x".repeat(1_000))).length, 300);
    assert.equal(describeNetworkError(null), "erreur inconnue");
  });
});
