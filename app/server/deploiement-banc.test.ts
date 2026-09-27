// 1.1 × 1.0.6 (GF0-106) : la surcharge du banc e2e (e2e/docker-compose.e2e.yml) ne rouvre aucune sortie à opencode.
// docker-compose.yml le met sur le seul réseau « interne », derrière le relais du cockpit (deploiement.test.ts). Le banc garde
// cette topologie ; seul le faux fournisseur de --reel-hors-ligne rejoint ce réseau, et opencode le joint en direct (NO_PROXY).
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import { parse as parseYaml } from "yaml";

const ROOT = path.join(import.meta.dirname, "..", "..");
const read = (...parts: string[]) => fs.readFileSync(path.join(ROOT, ...parts), "utf8");

interface ComposeService {
  profiles?: string[];
  networks?: string[] | Record<string, unknown>;
  environment?: Record<string, string>;
  ports?: unknown[];
}
interface Compose {
  services: Record<string, ComposeService>;
  networks?: Record<string, unknown>;
}

const networksOf = (service: ComposeService | undefined): string[] =>
  Array.isArray(service?.networks) ? [...service.networks] : Object.keys(service?.networks ?? {});

describe("banc e2e × 1.0.6 : la surcharge du banc ne rouvre aucune sortie à opencode", () => {
  // `!reset` (étiquette propre à Compose) : lue comme une valeur ordinaire, sans avertissement.
  const banc = parseYaml(read("e2e", "docker-compose.e2e.yml"), { logLevel: "error" }) as Compose;
  const prod = parseYaml(read("docker-compose.yml"), { merge: true }) as Compose;

  it("réseau « interne » laissé tel quel (internal: true de docker-compose.yml) ; opencode sans autre réseau, sans port publié", () => {
    assert.equal(banc.networks?.interne, undefined);
    assert.equal(banc.services.opencode?.networks, undefined);
    assert.equal(banc.services.opencode?.ports, undefined);
  });

  it("proxys d'opencode jamais surchargés (relais du cockpit) ; NO_PROXY = celui de docker-compose.yml plus le seul faux fournisseur", () => {
    const oc = banc.services.opencode?.environment ?? {};
    for (const key of ["HTTP_PROXY", "HTTPS_PROXY", "http_proxy", "https_proxy"]) assert.equal(oc[key], undefined, key);
    const prodOc = prod.services.opencode?.environment ?? {};
    for (const key of ["NO_PROXY", "no_proxy"]) {
      assert.deepEqual(String(oc[key]).split(","), [...String(prodOc[key]).split(","), "faux-fournisseur"], key);
    }
  });

  it("seul le faux fournisseur (profil reel-hors-ligne) rejoint le réseau d'opencode", () => {
    const joined = Object.entries(banc.services)
      .filter(([, service]) => networksOf(service).includes("interne"))
      .map(([name]) => name);
    assert.deepEqual(joined, ["faux-fournisseur"]);
    assert.deepEqual(banc.services["faux-fournisseur"]?.profiles, ["reel-hors-ligne"]);
  });
});

// Grande fusion (GF1, fiche v106 §3.8) : le banc COMPLET de la salle (L21b) s'empile lui aussi sur docker-compose.yml. Même règle
// que le banc e2e : l'instance principale reste sur « interne » derrière le relais ; seul le faux fournisseur la rejoint.
describe("banc complet de la salle × 1.0.6 : la surcharge ne rouvre aucune sortie à opencode", () => {
  const complet = parseYaml(read("e2e", "omo-banc", "cockpit", "cockpit.compose.yml"), { logLevel: "error" }) as Compose;
  const prod = parseYaml(read("docker-compose.yml"), { merge: true }) as Compose;

  it("réseau « interne » laissé tel quel ; opencode sans autre réseau, sans port publié", () => {
    assert.equal(complet.networks?.interne, undefined);
    assert.equal(complet.services.opencode?.networks, undefined);
    assert.equal(complet.services.opencode?.ports, undefined);
  });

  it("proxys d'opencode jamais surchargés ; NO_PROXY = celui de docker-compose.yml plus le seul faux fournisseur", () => {
    const oc = complet.services.opencode?.environment ?? {};
    for (const key of ["HTTP_PROXY", "HTTPS_PROXY", "http_proxy", "https_proxy"]) assert.equal(oc[key], undefined, key);
    const prodOc = prod.services.opencode?.environment ?? {};
    for (const key of ["NO_PROXY", "no_proxy"]) {
      assert.deepEqual(String(oc[key]).split(","), [...String(prodOc[key]).split(","), "faux-fournisseur"], key);
    }
  });

  it("seul le faux fournisseur rejoint le réseau d'opencode ; la salle, egress et les pilotes jamais", () => {
    const joined = Object.entries(complet.services)
      .filter(([, service]) => networksOf(service).includes("interne"))
      .map(([name]) => name);
    assert.deepEqual(joined, ["faux-fournisseur"]);
  });
});
