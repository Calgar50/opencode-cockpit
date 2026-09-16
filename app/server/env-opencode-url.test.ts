// Tests L1a (reste connu d) : OPENCODE_URL sur un port que fetch refuse est refusé au démarrage (EnvError au message vrai) ;
// port explicite ou port du schéma (80, 443) accepté. Jeton et mot de passe générés à chaque exécution, jamais imprimés.
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { describe, it } from "node:test";
import { EnvError, loadEnv } from "./env.ts";
import { FETCH_BLOCKED_PORTS } from "./fetch-ports.ts";

const TOKEN = randomBytes(36).toString("base64url");
const PASSWORD = randomBytes(18).toString("base64url");

const load = (url: string) => loadEnv({ COCKPIT_TOKEN: TOKEN, OPENCODE_SERVER_PASSWORD: PASSWORD, OPENCODE_URL: url });

describe("OPENCODE_URL : ports refusés par fetch", () => {
  it("port explicite refusé par fetch : EnvError qui nomme la variable et le port, sans recopier l'adresse ni les secrets", () => {
    for (const port of FETCH_BLOCKED_PORTS) {
      const url = `http://opencode-bloque.test:${port}`;
      assert.throws(
        () => load(url),
        (err: unknown) => {
          assert.ok(err instanceof EnvError, String(err));
          assert.equal(err.message, `OPENCODE_URL : le port ${port} est refusé par fetch (Node), le cockpit ne pourrait jamais joindre opencode. Choisissez un autre port.`);
          assert.ok(!err.message.includes("opencode-bloque.test") && !err.message.includes(TOKEN) && !err.message.includes(PASSWORD));
          return true;
        },
        `port ${port}`,
      );
    }
    assert.throws(() => load("https://opencode.test:6697/"), /le port 6697 est refusé/);
  });

  it("port normal ou port du schéma accepté ; adresse par défaut inchangée", () => {
    assert.equal(load("http://opencode:4096").opencodeUrl, "http://opencode:4096");
    assert.equal(load("http://opencode.test:4097/").opencodeUrl, "http://opencode.test:4097");
    assert.equal(load("http://opencode.test").opencodeUrl, "http://opencode.test");
    assert.equal(load("https://opencode.test:443").opencodeUrl, "https://opencode.test:443");
    assert.equal(load("http://opencode.test:80").opencodeUrl, "http://opencode.test:80");
    assert.equal(loadEnv({ COCKPIT_TOKEN: TOKEN, OPENCODE_SERVER_PASSWORD: PASSWORD }).opencodeUrl, "http://opencode:4096");
    assert.equal(FETCH_BLOCKED_PORTS.has(80) || FETCH_BLOCKED_PORTS.has(443) || FETCH_BLOCKED_PORTS.has(4096), false);
  });
});
