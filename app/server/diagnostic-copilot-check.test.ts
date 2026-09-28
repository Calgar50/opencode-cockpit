// « Tester la connexion Copilot » (page Diagnostic, POST /api/system/copilot-check) après la mesure réseau de la 1.1.0 : le
// cockpit n'essaie que l'adresse d'API Copilot réellement utilisée (probeHosts) et relit la liste des IA SANS rien demander à
// GitHub (catalog.refresh({ discovery: false })) : plus aucune requête vers api.github.com ni github.com hors de la fenêtre de
// connexion. Route réelle (createApp par le harnais), CopilotApi remplacée par une doublure, catalogue réel observé.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Reachability } from "./copilot.ts";
import { startCockpit } from "./test-support/cockpit-harness.ts";

describe("Diagnostic › Tester la connexion Copilot (1.1.0)", () => {
  it("adresse Copilot utilisée seule, liste relue sans lecture de l'adresse de l'abonnement, aucune remise à zéro", async (t) => {
    const refreshes: Array<{ discovery?: boolean } | undefined> = [];
    let probed = 0;
    const hosts: Reachability[] = [{ host: "api.business.githubcopilot.com", reachable: true, detail: "joignable (réponse 404)" }];
    const h = await startCockpit(t, {
      deps: (base) => {
        const refresh = base.catalog.refresh.bind(base.catalog);
        base.catalog.refresh = (options) => {
          refreshes.push(options);
          return refresh(options);
        };
        return {
          copilot: {
            status: { connected: false, endpoint: null, lastTried: null, modelsAt: 0, models: 0, error: null, discoveryError: null },
            probeHosts: async () => {
              probed++;
              return hosts;
            },
          },
        };
      },
    });
    refreshes.length = 0;
    const res = await h.call("POST", "/api/system/copilot-check", { headers: h.headers.mutating, body: {} });
    assert.equal(res.status, 200);
    const body = res.json<{ hosts: Reachability[]; catalogError: string | null }>();
    assert.deepEqual(body.hosts, hosts);
    assert.equal(probed, 1);
    // Relecture du test : sans découverte. (Le réalignement d'opencode ne relit la liste que s'il écrit une nouvelle adresse :
    // relecture ordinaire, celle de la tâche de fond ; rien d'écrit ici.)
    assert.deepEqual(refreshes, [{ discovery: false }]);
  });
});
