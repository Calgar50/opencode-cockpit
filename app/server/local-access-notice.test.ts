// Bandeau « connexion locale non chiffrée », écran de connexion par mode et messages de retour de /auth.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import { isValidConfirmedAt } from "./env.ts";
import { authErrorText, isDisplayableConfirmedAt, localAccessNotice, loginMode } from "./shared/local-access-notice.ts";

const VECTORS = JSON.parse(fs.readFileSync(path.join(import.meta.dirname, "..", "..", "tests", "vectors", "local-access.json"), "utf8")) as {
  dates: { accepted: string[]; rejected: string[] };
};

const CONFIRMED = "2026-09-15T10:32:00Z";
const AUTH_FAILED = "Lien de connexion invalide, expiré ou déjà utilisé : relancez .\\cockpit.ps1 open.";

describe("bandeau d'accès local", () => {
  it("mode HTTP confirmé : bandeau daté", () => {
    assert.deepEqual(localAccessNotice({ scheme: "http", confirmedAt: CONFIRMED, protocol: "http:" }), {
      kind: "http-choisi",
      confirmedAt: CONFIRMED,
    });
  });

  it("page en clair alors que le cockpit annonce HTTPS : bandeau sans date", () => {
    assert.deepEqual(localAccessNotice({ scheme: "https", confirmedAt: null, protocol: "http:" }), { kind: "page-http" });
  });

  it("HTTPS de bout en bout : aucun bandeau", () => {
    assert.equal(localAccessNotice({ scheme: "https", confirmedAt: null, protocol: "https:" }), null);
    // Une date restée dans .env après un retour en HTTPS ne ressuscite pas le bandeau.
    assert.equal(localAccessNotice({ scheme: "https", confirmedAt: CONFIRMED, protocol: "https:" }), null);
  });

  it("mode HTTP sans date exploitable : bandeau sans date, jamais la valeur lue", () => {
    for (const confirmedAt of [null, "", "   ", "2026-02-30T00:00:00Z", "MARQUEUR-7f3a91"]) {
      assert.deepEqual(localAccessNotice({ scheme: "http", confirmedAt, protocol: "http:" }), { kind: "page-http" }, confirmedAt ?? "null");
    }
  });

  it("protocole en majuscules (URL recopiée à la main) : traité comme le schéma normalisé", () => {
    assert.deepEqual(localAccessNotice({ scheme: "https", confirmedAt: null, protocol: "HTTP:" }), { kind: "page-http" });
    assert.equal(localAccessNotice({ scheme: "https", confirmedAt: null, protocol: "HTTPS:" }), null);
  });

  it("date de confirmation : même règle que le serveur (vecteurs communs)", () => {
    for (const date of VECTORS.dates.accepted) {
      assert.equal(isDisplayableConfirmedAt(date.trim()), true, date);
      assert.equal(isDisplayableConfirmedAt(date.trim()), isValidConfirmedAt(date.trim()), date);
    }
    for (const date of VECTORS.dates.rejected) {
      assert.equal(isDisplayableConfirmedAt(date.trim()), false, date);
      assert.equal(isDisplayableConfirmedAt(date.trim()), isValidConfirmedAt(date.trim()), date);
    }
    assert.equal(isDisplayableConfirmedAt(null), false);
    assert.equal(isDisplayableConfirmedAt(undefined), false);
  });
});

describe("écran de connexion", () => {
  it("page en HTTPS : saisie du jeton possible", () => {
    assert.equal(loginMode("https:"), "jeton");
    assert.equal(loginMode("HTTPS:"), "jeton");
  });

  it("page en clair : ouverture par les scripts seulement (le jeton ne se saisit jamais dans une page)", () => {
    assert.equal(loginMode("http:"), "open-seulement");
    assert.equal(loginMode("HTTP:"), "open-seulement");
    assert.equal(loginMode("file:"), "open-seulement");
    assert.equal(loginMode(""), "open-seulement");
  });
});

describe("retour de /auth", () => {
  it("ticket refusé", () => {
    assert.equal(authErrorText("?auth=failed"), AUTH_FAILED);
  });

  it("lien /auth?t= d'une version antérieure à la 1.0.5", () => {
    assert.equal(authErrorText("?auth=ancien-lien"), "Lien d'une ancienne version : relancez .\\cockpit.ps1 open.");
  });

  it("code inconnu : texte générique, jamais la valeur lue", () => {
    const text = authErrorText("?auth=MARQUEUR-7f3a91");
    assert.equal(text, "Connexion impossible : relancez .\\cockpit.ps1 open.");
    assert.ok(!text.includes("MARQUEUR"));
  });

  it("aucun code : aucun message", () => {
    assert.equal(authErrorText(""), "");
    assert.equal(authErrorText("?"), "");
    assert.equal(authErrorText("?autre=1"), "");
  });

  it("le code est lu comme un paramètre, pas comme une sous-chaîne", () => {
    assert.equal(authErrorText("?redirect=%2F%3Fauth%3Dfailed"), "");
    assert.equal(authErrorText("?a=1&auth=failed"), AUTH_FAILED);
  });
});
