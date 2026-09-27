// Écoutes du cockpit : gardes STATIQUES (décision D12 de la grande fusion). Ce fichier ne lance aucun processus et n'ouvre aucun
// port : une mort au chargement de http-transport.test.ts (sous-processus, ports libres, attentes) ne peut plus masquer ces gardes.
// Écoutes permises : l'interface (server-start.ts) et le relais d'opencode (egress-relay.ts, 1.0.6) dans le processus du cockpit ;
// egress-proxy.ts (salle, L16a) est un PROGRAMME À PART (service `egress`), jamais chargé par le cockpit.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import * as serverStart from "./server-start.ts";

const SERVER_DIR = import.meta.dirname;

/** Sources du serveur (hors tests) ; l'outillage de test 1.1 (harnais, faux opencode) est retiré de l'image par app/Dockerfile. */
function sources(): string[] {
  return fs
    .readdirSync(SERVER_DIR, { recursive: true, encoding: "utf8" })
    .filter((file) => file.endsWith(".ts") && !file.endsWith(".test.ts"))
    .map((file) => file.replaceAll("\\", "/"))
    .filter((file) => !file.startsWith("test-support/"));
}

const lire = (file: string) => fs.readFileSync(path.join(SERVER_DIR, file), "utf8");

/** Vrai si `file` importe le module `name` (« ./name », « ./name.ts », « ../name.js », sous-dossiers compris). */
const importe = (file: string, name: string) => new RegExp(`["'](?:\\.{1,2}/)+(?:[\\w-]+/)*${name}(?:\\.ts|\\.js)?["']`).test(lire(file));

/** Fichiers qui mettent un serveur en écoute. */
function ecouteurs(files: readonly string[], read: (file: string) => string): string[] {
  return files.filter((file) => /from "@hono\/node-server"|\bcreateServer\b|createSecureServer|\.listen\(/.test(read(file))).sort();
}

describe("écoutes du cockpit (gardes statiques, D12)", () => {
  it("une seule fonction d'écoute de l'interface (server-start.ts) ; trois fichiers qui écoutent, pas un de plus", () => {
    assert.deepEqual(Object.keys(serverStart).sort(), ["logHttpsFailure", "prepareStartup", "startLocalServer"]);
    // Le processus du cockpit a DEUX écoutes depuis la 1.0.6 (interface et relais) ; egress-proxy.ts tourne dans son conteneur.
    assert.deepEqual(ecouteurs(sources(), lire), ["egress-proxy.ts", "egress-relay.ts", "server-start.ts"]);
  });

  it("egress-relay.ts lancé par main.ts seul ; egress-proxy.ts importé par personne ; jamais l'un par l'autre", () => {
    const files = sources();
    assert.deepEqual(files.filter((f) => f !== "main.ts" && importe(f, "egress-relay")), []);
    assert.deepEqual(files.filter((f) => f !== "egress-proxy.ts" && importe(f, "egress-proxy")), []);
    assert.equal(importe("main.ts", "egress-relay"), true);
    assert.equal(importe("main.ts", "egress-proxy"), false);
  });

  it("main.ts : une interface, un relais, dans l'ordre prepareStartup < openDb < startLocalServer < startEgressRelay", () => {
    const main = lire("main.ts");
    assert.equal(main.match(/\bstartLocalServer\(/g)?.length, 1);
    assert.equal(main.match(/\bstartEgressRelay\(/g)?.length, 1);
    // Certificat préparé avant la base, base ouverte avant l'écoute, relais d'opencode après l'interface.
    const order = ["prepareStartup(", "openDb(", "startLocalServer(", "startEgressRelay("].map((marker) => main.indexOf(marker));
    assert.ok(order.every((at, i) => at > 0 && (i === 0 || at > (order[i - 1] ?? 0))), JSON.stringify(order));
  });

  it("témoins : la garde voit une écoute ajoutée et un import détourné, sous toutes leurs formes", () => {
    const faux: Record<string, string> = {
      "a.ts": 'import { serve } from "@hono/node-server";',
      "b.ts": "const s = net.createServer(); s.listen(0);",
      "c.ts": "export const rien = 1;",
    };
    assert.deepEqual(ecouteurs(Object.keys(faux), (f) => faux[f] ?? ""), ["a.ts", "b.ts"]);
    const motif = (name: string) => new RegExp(`["'](?:\\.{1,2}/)+(?:[\\w-]+/)*${name}(?:\\.ts|\\.js)?["']`);
    for (const texte of ['from "./egress-relay.ts"', "from './egress-relay'", 'import("../egress-relay.js")', 'from "../lib/egress-relay"']) {
      assert.equal(motif("egress-relay").test(texte), true, texte);
    }
    assert.equal(motif("egress-relay").test('from "./egress-relay-extra.ts"'), false);
  });
});
