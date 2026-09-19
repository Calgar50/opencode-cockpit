// Décision de sortie d'egress (L16a) : T-L16-d sur la règle pure, hôte autorisé lu comme en 1.0.3 (D-2b-13), cible d'un CONNECT et
// T-L16-f (pureté de shared/egress-allow.ts).
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import {
  decoupeCibleConnect,
  EGRESS_HOTE_TOUJOURS_REFUSE,
  EGRESS_NOM_MAX,
  EGRESS_PORT_AUTORISE,
  EGRESS_REFUSAL_REASONS,
  egressAllow,
  egressHoteAutorise,
  type EgressRefusalReason,
} from "./shared/egress-allow.ts";

const COPILOT = "api.githubcopilot.com";
const OK = { autorise: true };
const refus = (raison: EgressRefusalReason) => ({ autorise: false, raison });

/** Nom valide de `longueur` caractères exactement (étiquettes de 63 caractères au plus). */
function nomDeLongueur(longueur: number): string {
  const etiquettes: string[] = [];
  let reste = longueur;
  while (reste > 0) {
    const taille = Math.min(63, reste - (etiquettes.length > 0 ? 1 : 0));
    etiquettes.push("a".repeat(taille));
    reste -= taille + (etiquettes.length > 1 ? 1 : 0);
  }
  const nom = etiquettes.join(".");
  assert.equal(nom.length, longueur);
  return nom;
}

describe("egressAllow : liste blanche de sortie", () => {
  it("seul l'hôte autorisé passe, sur le port 443, casse ignorée des deux côtés", () => {
    assert.deepEqual(egressAllow(COPILOT, 443, COPILOT), OK);
    assert.deepEqual(egressAllow("API.GitHubCopilot.COM", 443, COPILOT), OK);
    assert.deepEqual(egressAllow(COPILOT, 443, "Api.GithubCopilot.Com"), OK);
    assert.deepEqual(egressAllow("api.business.githubcopilot.com", 443, "api.business.githubcopilot.com"), OK);
    assert.equal(EGRESS_PORT_AUTORISE, 443);
  });

  it("T-L16-d : comparaison exacte, sans joker, sous-domaine, suffixe ni préfixe", () => {
    for (const host of [
      "githubcopilot.com",
      "sub.api.githubcopilot.com",
      "xapi.githubcopilot.com",
      "api.githubcopilot.com.evil.example",
      "api-githubcopilot.com",
      "api.githubcopilot.co",
      "api.business.githubcopilot.com",
      "example.com",
      "localhost",
    ]) {
      assert.deepEqual(egressAllow(host, 443, COPILOT), refus("hote"), host);
    }
    // Un hôte autorisé en forme de joker n'autorise rien, pas même ce qu'il semblerait couvrir.
    assert.deepEqual(egressAllow(COPILOT, 443, "*.githubcopilot.com"), refus("hote"));
    assert.deepEqual(egressAllow("x.githubcopilot.com", 443, "*.githubcopilot.com"), refus("hote"));
  });

  it("T-L16-d : api.github.com toujours refusé, même donné comme hôte autorisé", () => {
    assert.equal(EGRESS_HOTE_TOUJOURS_REFUSE, "api.github.com");
    assert.deepEqual(egressAllow("api.github.com", 443, COPILOT), refus("hote"));
    assert.deepEqual(egressAllow("api.github.com", 443, "api.github.com"), refus("hote"));
    assert.deepEqual(egressAllow("API.GITHUB.COM", 443, "api.github.com"), refus("hote"));
    assert.deepEqual(egressAllow(COPILOT, 443, "API.GitHub.com"), refus("hote"), "hôte autorisé égal à api.github.com : rien ne sort");
  });

  it("T-L16-d : IP écrite en clair refusée (v4 sous toutes ses écritures, v6 avec ou sans crochets)", () => {
    for (const host of [
      "127.0.0.1",
      "10.0.0.1",
      "140.82.112.21",
      "127.0.0.1.",
      "127.1",
      "2130706433",
      "0x7f000001",
      "0x7F.0.0.1",
      "0X7F000001",
      "a.0XFF",
      "0177.0.0.1",
      "foo.123",
      "::1",
      "::ffff:127.0.0.1",
      "2001:db8::1",
      "2001:DB8::1",
      "fe80::1%eth0",
      "FE80::1%ETH0",
      "[::1]",
      "[2001:db8::1]",
      "[api.githubcopilot.com]",
      "[",
    ]) {
      assert.deepEqual(egressAllow(host, 443, COPILOT), refus("ip-litterale"), host);
    }
    // Le port ne change rien : la forme de l'hôte est jugée d'abord.
    assert.deepEqual(egressAllow("127.0.0.1", 80, COPILOT), refus("ip-litterale"));
  });

  it("T-L16-d : nom invalide ou de plus de 253 caractères refusé, étiquettes de 63 caractères au plus", () => {
    for (const host of [
      "",
      ".",
      "a..b",
      ".api.githubcopilot.com",
      "api.githubcopilot.com.",
      "-a.example",
      "a-.example",
      "a_b.example",
      "é.example",
      " api.githubcopilot.com",
      "api.githubcopilot.com ",
      "user@api.githubcopilot.com",
      "user:secret@api.githubcopilot.com",
      "api.githubcopilot.com/chemin",
      "http://api.githubcopilot.com",
      "*.githubcopilot.com",
      `${"a".repeat(64)}.example`,
      nomDeLongueur(254),
    ]) {
      assert.deepEqual(egressAllow(host, 443, COPILOT), refus("invalide"), JSON.stringify(host.slice(0, 80)));
    }
    assert.equal(EGRESS_NOM_MAX, 253);
    // Bornes exactes : 253 caractères et une étiquette de 63 restent des noms valides (refusés « hote », pas « invalide »).
    assert.deepEqual(egressAllow(nomDeLongueur(253), 443, COPILOT), refus("hote"));
    assert.deepEqual(egressAllow(`${"a".repeat(63)}.example`, 443, COPILOT), refus("hote"));
    assert.deepEqual(egressAllow("xn--caf-dma.example", 443, COPILOT), refus("hote"), "nom international en punycode : valide");
    // Le port ne change rien à un nom invalide.
    assert.deepEqual(egressAllow("a_b.example", 80, COPILOT), refus("invalide"));
    // Lettre hors ASCII que toLowerCase change en lettre ASCII (U+212A, signe kelvin → « k ») : validée avant, jamais confondue.
    const kelvin = String.fromCharCode(0x212a);
    assert.equal(kelvin.toLowerCase(), "k");
    assert.deepEqual(egressAllow(`${kelvin}.example`, 443, "k.example"), refus("invalide"));
    assert.deepEqual(egressAllow(`api.${kelvin}.example`, 443, "api.k.example"), refus("invalide"));
    assert.deepEqual(egressAllow("k.example", 443, `${kelvin}.example`), refus("hote"), "hôte autorisé hors ASCII : rien ne sort");
  });

  it("T-L16-d : tout port autre que 443 refusé, y compris vers l'hôte autorisé", () => {
    for (const port of [0, 1, 80, 442, 444, 4096, 8443, 65535, 443.5, -443, Number.NaN, Number.POSITIVE_INFINITY]) {
      assert.deepEqual(egressAllow(COPILOT, port, COPILOT), refus("port"), String(port));
    }
    assert.deepEqual(egressAllow("evil.example", 80, COPILOT), refus("port"), "port jugé avant l'hôte");
  });

  it("hôte autorisé vide, écrit en clair ou invalide : plus rien ne sort (fermé en cas de doute)", () => {
    for (const allowed of ["", "127.0.0.1", "[::1]", "a..b", `${"a".repeat(64)}.example`, nomDeLongueur(254)]) {
      assert.deepEqual(egressAllow(COPILOT, 443, allowed), refus("hote"), JSON.stringify(allowed.slice(0, 80)));
      assert.deepEqual(egressAllow(allowed === "" ? "x.example" : allowed, 443, allowed).autorise, false, "aucune demande n'égale un hôte autorisé refusé");
    }
  });

  it("déni de service : une cible de 16 Kio (taille d'une ligne de demande) est jugée en temps linéaire", () => {
    const debut = performance.now();
    for (const host of [`${"0:".repeat(8192)}g`, `${"a".repeat(16_384)}!`, `${"a-".repeat(8192)}`, `${"1.".repeat(8192)}x`]) {
      assert.equal(egressAllow(host, 443, COPILOT).autorise, false);
    }
    assert.ok(performance.now() - debut < 500, "jugement borné");
  });

  it("raisons : les cinq codes d'EgressRefusalReason (T3a), dans le même ordre, sans doublon", () => {
    assert.deepEqual([...EGRESS_REFUSAL_REASONS], ["hote", "port", "ip-litterale", "invalide", "methode"]);
  });
});

describe("egressHoteAutorise : hôte lu une fois au démarrage, même source qu'en 1.0.3 (D-2b-13)", () => {
  it("vide : adresse d'office d'opencode ; adresse imposée : son hôte ; domaine GitHub Enterprise déclaré accepté", () => {
    assert.equal(egressHoteAutorise(undefined, undefined), COPILOT);
    assert.equal(egressHoteAutorise("", ""), COPILOT);
    assert.equal(egressHoteAutorise("   ", undefined), COPILOT);
    assert.equal(egressHoteAutorise("https://api.business.githubcopilot.com", undefined), "api.business.githubcopilot.com");
    assert.equal(egressHoteAutorise(" https://API.Enterprise.githubcopilot.com/ ", undefined), "api.enterprise.githubcopilot.com");
    assert.equal(egressHoteAutorise("https://copilot-api.acme.ghe.com", " ACME.ghe.com "), "copilot-api.acme.ghe.com");
  });

  it("adresse refusée par la 1.0.3 : null, egress ne démarre pas", () => {
    for (const url of [
      "https://evil.example",
      "http://api.githubcopilot.com",
      "https://api.githubcopilot.com:8443",
      "https://user@api.githubcopilot.com",
      "https://api.githubcopilot.com/v1",
      "https://api.githubcopilot.com?x=1",
      "https://api.github.com",
      "https://140.82.112.21",
      "api.githubcopilot.com",
      "pas une adresse",
    ]) {
      assert.equal(egressHoteAutorise(url, undefined), null, url);
    }
    assert.equal(egressHoteAutorise("https://copilot-api.acme.ghe.com", undefined), null, "domaine GitHub Enterprise non déclaré");
    assert.equal(egressHoteAutorise("https://copilot-api.acme.ghe.com", "autre.ghe.com"), null);
  });

  it("seconde garde : un hôte accepté par la 1.0.3 mais qui ne passerait pas la règle de sortie laisse egress arrêté", () => {
    // Domaine GitHub Enterprise déclaré avec un point final ou un « _ » : l'analyseur d'URL les garde, la règle de sortie non.
    assert.equal(egressHoteAutorise("https://copilot-api.acme.ghe.com.", "acme.ghe.com."), null);
    assert.equal(egressHoteAutorise("https://copilot-api.ac_me.ghe.com", "ac_me.ghe.com"), null);
  });
});

describe("decoupeCibleConnect : cible d'un CONNECT telle qu'elle est écrite", () => {
  it("hôte et port ; crochets gardés ; port absent ou illisible : NaN", () => {
    assert.deepEqual(decoupeCibleConnect("api.githubcopilot.com:443"), { hote: COPILOT, port: 443 });
    assert.deepEqual(decoupeCibleConnect("API.GitHubCopilot.com:0443"), { hote: "API.GitHubCopilot.com", port: 443 });
    assert.deepEqual(decoupeCibleConnect("[::1]:443"), { hote: "[::1]", port: 443 });
    assert.deepEqual(decoupeCibleConnect("::1"), { hote: ":", port: 1 });
    for (const cible of ["api.githubcopilot.com", "api.githubcopilot.com:", "api.githubcopilot.com:https", "api.githubcopilot.com:123456", "[::1]", "[::1]x", "[::1]x443", "[::1"]) {
      assert.ok(Number.isNaN(decoupeCibleConnect(cible).port), cible);
    }
    assert.deepEqual(decoupeCibleConnect("user:secret@evil.example:443"), { hote: "user:secret@evil.example", port: 443 });
  });

  it("toute cible mal formée finit refusée par egressAllow, jamais autorisée", () => {
    for (const cible of [
      "api.githubcopilot.com",
      "api.githubcopilot.com:",
      "api.githubcopilot.com:80",
      "api.githubcopilot.com:443/chemin",
      "user:secret@api.githubcopilot.com:443",
      "http://api.githubcopilot.com:443",
      "[::1]:443",
      "::1",
      "",
      ":443",
    ]) {
      const { hote, port } = decoupeCibleConnect(cible);
      assert.equal(egressAllow(hote, port, COPILOT).autorise, false, cible);
    }
    const { hote, port } = decoupeCibleConnect("api.githubcopilot.com:443");
    assert.deepEqual(egressAllow(hote, port, COPILOT), OK);
  });
});

describe("T-L16-f : pureté de shared/egress-allow.ts", () => {
  const source = fs.readFileSync(path.join(import.meta.dirname, "shared", "egress-allow.ts"), "utf8");

  it("ni module node, ni process, ni horloge, ni aléa, ni réseau ; n'importe que assistant-rules.ts (pur)", () => {
    assert.equal(source.includes('"node:'), false, "module node:");
    for (const interdit of [/\bprocess\./, /\brequire\s*\(/, /\bDate\b/, /\bperformance\b/, /Math\.random/, /\bcrypto\b/, /\bfetch\s*\(/, /\bsetTimeout\b/, /\bsetInterval\b/]) {
      assert.equal(interdit.test(source), false, String(interdit));
    }
    const imports = [...source.matchAll(/(?:\bfrom\s*|\bimport\s*\(?\s*)["']([^"']+)["']/g)].map((m) => m[1]);
    assert.deepEqual(imports, ["./assistant-rules.ts"]);
  });

  it("décision reproductible : mêmes arguments, même réponse, aucun état gardé d'un appel à l'autre", () => {
    const cas: Array<[string, number, string]> = [
      [COPILOT, 443, COPILOT],
      ["evil.example", 443, COPILOT],
      ["127.0.0.1", 443, COPILOT],
      [COPILOT, 80, COPILOT],
      ["a..b", 443, COPILOT],
    ];
    const premier = cas.map(([h, p, a]) => egressAllow(h, p, a));
    const second = [...cas].reverse().map(([h, p, a]) => egressAllow(h, p, a)).reverse();
    assert.deepEqual(second, premier);
    const decision = egressAllow(COPILOT, 443, COPILOT);
    assert.notEqual(decision, egressAllow(COPILOT, 443, COPILOT), "objet neuf à chaque appel : rien de partagé entre appelants");
  });
});
