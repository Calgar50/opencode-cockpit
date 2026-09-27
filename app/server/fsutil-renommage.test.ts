// Écriture atomique (fsutil.ts) : renommage repris sous Windows sur un refus transitoire (EPERM, EACCES, EBUSY), jamais ailleurs.
// Constat de la grande fusion (GF12) : sous charge, le stop-request de la salle était perdu (EPERM au renommage pendant une lecture
// concurrente), l'arrêt restait « non confirmé » et croisements-2bis-v4 tombait (2 fois sur 36 sous charge, sur HS comme après GF1).
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { RENOMMAGE_ESSAIS_WINDOWS, renameAtomic, writeFileAtomic } from "./fsutil.ts";

const erreur = (code: string) => Object.assign(new Error(`${code}: operation not permitted, rename`), { code });

/** Renommage factice : refuse les `refus` premiers essais avec `code`, puis réussit ; compte les essais et les attentes. */
function renommageFactice(refus: number, code = "EPERM") {
  const essais: string[] = [];
  const attentes: number[] = [];
  return {
    essais,
    attentes,
    rename: async (a: string, b: string) => {
      essais.push(`${a}->${b}`);
      if (essais.length <= refus) throw erreur(code);
    },
    sleep: async (ms: number) => void attentes.push(ms),
  };
}

describe("renameAtomic : refus transitoires de Windows repris, rien d'autre", () => {
  it("Windows : deux EPERM puis succès → renommé, attentes croissantes", async () => {
    const f = renommageFactice(2);
    await renameAtomic("a.tmp", "a", { rename: f.rename, sleep: f.sleep, platform: "win32" });
    assert.equal(f.essais.length, 3);
    assert.deepEqual(f.attentes, [10, 20]);
  });

  it("Windows : EACCES et EBUSY repris aussi ; ENOENT remonte au premier essai", async () => {
    for (const code of ["EACCES", "EBUSY"]) {
      const f = renommageFactice(1, code);
      await renameAtomic("a.tmp", "a", { rename: f.rename, sleep: f.sleep, platform: "win32" });
      assert.equal(f.essais.length, 2, code);
    }
    const f = renommageFactice(1, "ENOENT");
    await assert.rejects(renameAtomic("a.tmp", "a", { rename: f.rename, sleep: f.sleep, platform: "win32" }), { code: "ENOENT" });
    assert.equal(f.essais.length, 1);
  });

  it("Windows : refus qui dure → l'erreur remonte après le dernier essai (280 ms d'attente au plus)", async () => {
    const f = renommageFactice(Number.POSITIVE_INFINITY);
    await assert.rejects(renameAtomic("a.tmp", "a", { rename: f.rename, sleep: f.sleep, platform: "win32" }), { code: "EPERM" });
    assert.equal(f.essais.length, RENOMMAGE_ESSAIS_WINDOWS);
    assert.equal(f.attentes.reduce((a, b) => a + b, 0), 280);
  });

  it("Linux : un seul essai, l'EPERM remonte tel quel (comportement de la 1.0.x inchangé)", async () => {
    const f = renommageFactice(1);
    await assert.rejects(renameAtomic("a.tmp", "a", { rename: f.rename, sleep: f.sleep, platform: "linux" }), { code: "EPERM" });
    assert.equal(f.essais.length, 1);
    assert.deepEqual(f.attentes, []);
  });

  it("writeFileAtomic réel : contenu écrit, aucun fichier temporaire laissé", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cockpit-renommage-"));
    try {
      const file = path.join(dir, "stop-request");
      await writeFileAtomic(file, "premier\n");
      await writeFileAtomic(file, "second\n");
      assert.equal(fs.readFileSync(file, "utf8"), "second\n");
      assert.deepEqual(fs.readdirSync(dir), ["stop-request"]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
