// Dossiers de projets et paramètre `directory` transmis à opencode (1.0.6). opencode 1.18.30 décode `directory` DEUX fois :
// URLSearchParams.get (workspace-routing.ts), puis decodeURIComponent (instance-context.ts:15-21, erreur ignorée). Un dossier
// nommé « a%2F..%2F..%2Fetc » est un nom valide pour le cockpit, mais opencode ouvre « /etc ». Ces tests rejouent cette chaîne.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { PathError } from "./fsutil.ts";
import { ProjectsService } from "./projects.ts";

/** Noms que opencode décoderait vers un autre dossier (hors du workspace, ou autre dossier du workspace). */
const DECODED_ELSEWHERE = [
  "a%2F..%2F..%2Fetc",
  // Dossier de données d'opencode (auth.json : jeton GitHub Copilot).
  "a%2F..%2F..%2Fhome%2Fnode%2F.local%2Fshare%2Fopencode",
  "b%2f..%2f..%2fetc",
  "a%252F..%252F..%252Fetc",
  "taux%41",
];

/** Noms légitimes qui doivent rester des projets ; « % » isolé : opencode ne le décode pas (mesuré le 23/09). */
const LEGITIMATE = ["Projet (été) 2026", "Données clients", "R&D #1 [v2]", "l'équipe + moi", "Remise 20%", "100 % bio", "dossier avec espaces"];

/** decode() d'opencode (instance-context.ts:15-21) : decodeURIComponent, valeur inchangée si elle est mal formée. */
function opencodeDecode(input: string): string {
  try {
    return decodeURIComponent(input);
  } catch {
    return input;
  }
}

/** Dossier réellement ouvert par opencode pour `directory`, envoyé comme le fait le cockpit (URLSearchParams). */
function openedByOpencode(directory: string): string {
  const sent = new URL("http://opencode:4096/session");
  sent.searchParams.set("directory", directory);
  const received = new URL(sent.toString()).searchParams.get("directory") ?? "";
  return path.posix.resolve(opencodeDecode(received));
}

describe("projets : noms que opencode décoderait (double décodage, 1.0.6)", () => {
  let tmp = "";
  let projects: ProjectsService;

  before(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cockpit-projets-"));
    for (const name of [...DECODED_ELSEWHERE, ...LEGITIMATE, "app"]) fs.mkdirSync(path.join(tmp, name));
    projects = new ProjectsService({ workspaceDir: tmp, opencodeWorkspaceDir: "/workspace" });
  });

  after(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("témoin : opencode ouvrirait bien un autre dossier pour chacun de ces noms", () => {
    assert.equal(openedByOpencode("/workspace/a%2F..%2F..%2Fetc"), "/etc");
    assert.equal(openedByOpencode("/workspace/a%2F..%2F..%2Fhome%2Fnode%2F.local%2Fshare%2Fopencode"), "/home/node/.local/share/opencode");
    assert.equal(openedByOpencode("/workspace/b%2f..%2f..%2fetc"), "/etc");
    assert.equal(openedByOpencode("/workspace/taux%41"), "/workspace/tauxA");
    for (const name of DECODED_ELSEWHERE) assert.notEqual(openedByOpencode(`/workspace/${name}`), `/workspace/${name}`, name);
  });

  it("isAllowedDirectory refuse toute séquence %XX, minuscules et sous-dossiers compris, même pour un dossier inexistant", () => {
    for (const name of DECODED_ELSEWHERE) assert.equal(projects.isAllowedDirectory(`/workspace/${name}`), false, name);
    assert.equal(projects.isAllowedDirectory("/workspace/app/sous%2Fdossier"), false);
    assert.equal(projects.isAllowedDirectory("/workspace/inexistant%2F..%2F..%2Fetc"), false);
    assert.equal(projects.isAllowedDirectory("/workspace/app/src/fichier%2Ets"), false);
  });

  it("isAllowedDirectory : chemins ordinaires inchangés, « % » isolé accepté, hors workspace toujours refusé", () => {
    for (const ok of ["/workspace", "/workspace/app", "/workspace/app/src", "/workspace/Remise 20%", "/workspace/100 % bio", "/workspace/Projet (été) 2026/src"]) {
      assert.equal(projects.isAllowedDirectory(ok), true, ok);
    }
    for (const ko of ["/etc", "/workspace/../etc", "/home/node/.local/share/opencode", "/workspace/app\0x"]) assert.equal(projects.isAllowedDirectory(ko), false, ko);
  });

  it("toOpencodePath lève une PathError en français pour un chemin qui contient %XX (Studio, liste des projets)", () => {
    for (const name of DECODED_ELSEWHERE) {
      assert.throws(
        () => projects.toOpencodePath(path.join(tmp, name)),
        (err: Error) => err instanceof PathError && err.message === "Nom de dossier non pris en charge (séquence %XX).",
        name,
      );
    }
    assert.equal(projects.toOpencodePath(path.join(tmp, "Remise 20%")), "/workspace/Remise 20%");
    assert.equal(projects.toOpencodePath(path.join(tmp, "100 % bio")), "/workspace/100 % bio");
  });

  it("list() n'expose aucun de ces dossiers et garde tous les noms légitimes", async () => {
    const names = (await projects.list()).map((p) => p.name);
    for (const name of DECODED_ELSEWHERE) assert.equal(names.includes(name), false, `encore proposé : ${name}`);
    for (const name of LEGITIMATE) assert.equal(names.includes(name), true, `nom légitime perdu : ${name}`);
    assert.equal(names[0], "(racine)");
  });

  it("chaque projet listé est autorisé et désigne le même dossier après les deux décodages d'opencode", async () => {
    const listed = await projects.list();
    assert.ok(listed.length >= LEGITIMATE.length + 2);
    for (const p of listed) {
      assert.equal(projects.isAllowedDirectory(p.directory), true, p.name);
      assert.equal(opencodeDecode(opencodeDecode(p.directory)), p.directory, p.name);
      assert.equal(openedByOpencode(p.directory), p.directory, p.name);
    }
  });
});
