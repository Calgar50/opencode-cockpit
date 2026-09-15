import assert from "node:assert/strict";
import { type ExecFileException, execFile, execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import type { Logger } from "./log.ts";
import {
  certificateFingerprints,
  type EnsureCertificateOptions,
  type ExecFileRunner,
  ensureServerCertificate,
  inspectPair,
  normalizeSanHosts,
  opensslArgs,
  type ServerCertificate,
  TLS_SUBJECT,
  TlsRefusals,
  TlsSetupError,
} from "./tls.ts";

// openssl réel : sauté en local quand il manque ; COCKPIT_TEST_REQUIRE_OPENSSL=1 (CI) le rend obligatoire, les tests échouent alors.
const OPENSSL = process.env.COCKPIT_OPENSSL?.trim() || "/usr/bin/openssl";
const REQUIRE_OPENSSL = process.env.COCKPIT_TEST_REQUIRE_OPENSSL === "1";
const SKIP_OPENSSL = !REQUIRE_OPENSSL && !fs.existsSync(OPENSSL) ? "SKIP openssl absent" : false;
const POSIX = process.platform !== "win32";
const SKIP_POSIX = SKIP_OPENSSL || (POSIX ? false : "SKIP droits POSIX (Windows)");

const BASE = ["IP:127.0.0.1", "DNS:localhost", "IP:::1"];
const DAY_MS = 86_400_000;
const FAUX_JETON = `faux-jeton-${"9".repeat(40)}`;
// Bloc piégé assemblé à l'exécution : aucune étiquette de clé privée en clair dans le dépôt.
const PIEGE_B64 = Buffer.from("piege de test : ceci n'est pas une vraie cle, rien ne doit en sortir").toString("base64");
const PIEGE_PEM = [["-----BEGIN", "PRIVATE", "KEY-----"].join(" "), PIEGE_B64, ["-----END", "PRIVATE", "KEY-----"].join(" ")].join("\n");

const roots: string[] = [];
after(() => {
  for (const dir of roots) fs.rmSync(dir, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cockpit-tls-test-"));
  roots.push(dir);
  return dir;
}

/** Volume /tls simulé : dossier 0700 à l'utilisateur courant. */
function freshTlsDir(): string {
  const dir = path.join(tempDir(), "tls");
  fs.mkdirSync(dir, { mode: 0o700 });
  if (POSIX) fs.chmodSync(dir, 0o700);
  return dir;
}

const modeOf = (file: string): number => fs.statSync(file).mode & 0o777;

function argAfter(args: readonly string[], flag: string): string {
  const value = args[args.indexOf(flag) + 1];
  assert.ok(value, flag);
  return value;
}

function captureLog(): { log: Logger; lines: string[]; text: () => string } {
  const lines: string[] = [];
  const write = (level: string) => (message: string, fields?: Record<string, unknown>) => {
    lines.push(JSON.stringify({ level, message, ...fields }));
  };
  return { log: { debug: write("debug"), info: write("info"), warn: write("warn"), error: write("error") }, lines, text: () => lines.join("\n") };
}

interface Pair {
  keyPem: string;
  certPem: string;
  keyFile: string;
  certFile: string;
}

/** Paire produite par openssl avec les arguments du produit, éventuellement modifiés (courbe, CA, usage, émetteur). */
function opensslPair(dir: string, replace: Record<string, string> = {}, extraArgs: readonly string[] = []): Pair {
  const keyFile = path.join(dir, `${crypto.randomUUID()}.key`);
  const certFile = path.join(dir, `${crypto.randomUUID()}.crt`);
  const args = [...opensslArgs(keyFile, certFile, BASE).map((arg) => replace[arg] ?? arg), ...extraArgs];
  execFileSync(OPENSSL, args, { stdio: "pipe", timeout: 15_000 });
  return { keyPem: fs.readFileSync(keyFile, "utf8"), certPem: fs.readFileSync(certFile, "utf8"), keyFile, certFile };
}

/** Exécuteur réel qui compte ses appels. */
function spyRunner(): { run: ExecFileRunner; calls: () => number } {
  let calls = 0;
  const run: ExecFileRunner = (file, args, options, callback) => {
    calls++;
    return execFile(file, args, options, callback);
  };
  return { run, calls: () => calls };
}

/** Exécuteur factice qui dépose une paire existante à la place d'openssl. */
function copyRunner(pair: Pair, keyMode: number): ExecFileRunner {
  return (_file, args, _options, callback) => {
    const keyTmp = argAfter(args, "-keyout");
    fs.writeFileSync(keyTmp, pair.keyPem, { mode: keyMode });
    fs.chmodSync(keyTmp, keyMode);
    fs.writeFileSync(argAfter(args, "-out"), pair.certPem, { mode: 0o644 });
    setImmediate(() => callback(null, "", ""));
  };
}

async function start(
  tlsDir: string,
  extra: Partial<EnsureCertificateOptions> = {},
): Promise<{ value: ServerCertificate; calls: number; log: string }> {
  const spy = spyRunner();
  const capture = captureLog();
  const value = await ensureServerCertificate({ tlsDir, entries: BASE, opensslPath: OPENSSL, log: capture.log, run: spy.run, ...extra });
  return { value, calls: spy.calls(), log: capture.text() };
}

/** Arborescence (nom, droits, taille, condensé) pour prouver qu'un refus n'a rien écrit. */
function snapshot(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true, recursive: true })) {
    const file = path.join(entry.parentPath, entry.name);
    const stat = fs.lstatSync(file);
    const digest = stat.isFile() ? crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex") : "-";
    out.push(`${path.relative(dir, file)} ${(stat.mode & 0o777).toString(8)} ${stat.size} ${digest}`);
  }
  return out.sort();
}

describe("certificat TLS local : noms couverts (SAN)", () => {
  it("défauts : 127.0.0.1, localhost et ::1 ; crochets retirés, IPv6 normalisée, sans doublon", () => {
    assert.deepEqual(normalizeSanHosts(["localhost", "127.0.0.1", "[::1]"]), { entries: BASE, ignored: [] });
    assert.deepEqual(normalizeSanHosts([]), { entries: BASE, ignored: [] });
    assert.deepEqual(normalizeSanHosts(["[::1]", "::1", "[0:0:0:0:0:0:0:1]", " LOCALHOST ", ""]), { entries: BASE, ignored: [] });
  });

  it("cockpit.localhost, IPv6 entre crochets et IPv4 acceptés", () => {
    const { entries, ignored } = normalizeSanHosts(["localhost", "Cockpit.LocalHost", "[FD00:0:0:0:0:0:0:2]", "192.168.1.10"]);
    assert.deepEqual(entries, [...BASE, "DNS:cockpit.localhost", "IP:fd00::2", "IP:192.168.1.10"]);
    assert.deepEqual(ignored, []);
  });

  it("valeurs refusées : jamais ajoutées, journalisées sur 40 caractères ASCII imprimables au plus", () => {
    const refused = [
      "a,IP:10.0.0.1,DNS:evil.example",
      "*.x",
      "a b",
      "localhost:7777",
      "-a.com",
      `${"a".repeat(250)}.com`,
      "évil",
      "1.2.3",
      "IP:1.2.3.4",
      "DNS:x",
      "[127.0.0.1]",
      "[localhost]",
      "fe80::1%eth0",
      "[fe80::1%eth0]",
      "exemple.",
    ];
    assert.equal(`${"a".repeat(250)}.com`.length, 254);
    const capture = captureLog();
    const { entries, ignored } = normalizeSanHosts(refused, capture.log);
    assert.deepEqual(entries, BASE);
    assert.equal(ignored.length, refused.length);
    assert.equal(capture.lines.length, refused.length);
    for (const line of capture.lines) assert.match(line, /ignoré/);
    for (const shown of ignored) assert.match(shown, /^[ -~]{0,40}$/);
    assert.ok(!entries.some((entry) => entry.includes("10.0.0.1") || entry.includes("evil") || entry === "DNS:x"));
  });

  it("17 entrées valables : 16 gardées, la dernière ignorée et journalisée", () => {
    const names = Array.from({ length: 14 }, (_, i) => `h${i}.localhost`);
    const capture = captureLog();
    const { entries, ignored } = normalizeSanHosts(["localhost", "127.0.0.1", "[::1]", ...names], capture.log);
    assert.equal(BASE.length + names.length, 17);
    assert.equal(entries.length, 16);
    assert.deepEqual(entries.slice(BASE.length), names.slice(0, 13).map((name) => `DNS:${name}`));
    assert.deepEqual(ignored, ["h13.localhost"]);
    assert.equal(capture.lines.length, 1);
  });
});

describe("certificat TLS local : arguments d'openssl", () => {
  it("tableau exact : P-256, 397 jours, sujet fixe, extensions de serveur, temporaires", () => {
    assert.equal(TLS_SUBJECT, "/CN=opencode-cockpit (local)");
    assert.deepEqual(opensslArgs("/tls/private/.tmp-a", "/tls/private/.tmp-b", [...BASE, "DNS:cockpit.localhost"]), [
      "req",
      "-x509",
      "-newkey",
      "ec",
      "-pkeyopt",
      "ec_paramgen_curve:prime256v1",
      "-nodes",
      "-sha256",
      "-days",
      "397",
      "-subj",
      "/CN=opencode-cockpit (local)",
      "-addext",
      "subjectAltName=IP:127.0.0.1,DNS:localhost,IP:::1,DNS:cockpit.localhost",
      "-addext",
      "basicConstraints=critical,CA:FALSE",
      "-addext",
      "keyUsage=critical,digitalSignature",
      "-addext",
      "extendedKeyUsage=serverAuth",
      "-keyout",
      "/tls/private/.tmp-a",
      "-out",
      "/tls/private/.tmp-b",
    ]);
  });

  it("entrées revalidées : injection, liste vide ou de plus de 16 entrées refusées", () => {
    const invalid = [
      [],
      ["DNS:a,IP:10.0.0.1"],
      ["IP:127.0.0.1", "DNS:evil example"],
      ["email:a@b.example"],
      Array.from({ length: 17 }, (_, i) => `DNS:h${i}.localhost`),
    ];
    for (const entries of invalid) assert.throws(() => opensslArgs("k", "c", entries), TlsSetupError, JSON.stringify(entries));
  });
});

describe("certificat TLS local : inspection d'une paire (openssl)", { skip: SKIP_OPENSSL }, () => {
  const pairs = new Map<string, Pair>();
  const pair = (name: string): Pair => {
    const found = pairs.get(name);
    assert.ok(found, name);
    return found;
  };
  const CA_TRUE = { "basicConstraints=critical,CA:FALSE": "basicConstraints=critical,CA:TRUE" };
  const CERT_SIGN = { "keyUsage=critical,digitalSignature": "keyUsage=critical,digitalSignature,keyCertSign" };
  before(() => {
    const dir = tempDir();
    pairs.set("a", opensslPair(dir));
    pairs.set("b", opensslPair(dir));
    pairs.set("p384", opensslPair(dir, { "ec_paramgen_curve:prime256v1": "ec_paramgen_curve:secp384r1" }));
    // CA:TRUE avec keyUsage digitalSignature seul : x509.ca reste faux, seule la lecture de basicConstraints le voit.
    pairs.set("ca", opensslPair(dir, CA_TRUE));
    // CA:TRUE avec keyCertSign : x509.ca vrai.
    pairs.set("ca-signe", opensslPair(dir, { ...CA_TRUE, ...CERT_SIGN }));
    // basicConstraints non critique : autre forme DER, toujours pas une autorité.
    pairs.set("ca-non-critique", opensslPair(dir, { "basicConstraints=critical,CA:FALSE": "basicConstraints=CA:FALSE" }));
    pairs.set("client", opensslPair(dir, { "extendedKeyUsage=serverAuth": "extendedKeyUsage=clientAuth" }));
    // Feuilles conformes en apparence mais émises par une autorité (autre sujet, puis même sujet que la feuille).
    const autorite = opensslPair(dir, { "/CN=opencode-cockpit (local)": "/CN=autorite de test", ...CA_TRUE, ...CERT_SIGN });
    pairs.set("emise", opensslPair(dir, {}, ["-CA", autorite.certFile, "-CAkey", autorite.keyFile]));
    pairs.set("emise-meme-sujet", opensslPair(dir, {}, ["-CA", pair("ca-signe").certFile, "-CAkey", pair("ca-signe").keyFile]));
  });

  it("paire du produit réutilisable, bornes de 30 jours et de 5 minutes comprises", () => {
    const { keyPem, certPem } = pair("a");
    const cert = new crypto.X509Certificate(certPem);
    const base = { keyPem, certPem, keyMode: 0o100600, entries: BASE };
    assert.equal(inspectPair({ ...base, now: new Date() }), null);
    assert.equal(inspectPair({ ...base, now: new Date(cert.validToDate.getTime() - 31 * DAY_MS) }), null);
    assert.equal(inspectPair({ ...base, now: new Date(cert.validFromDate.getTime() - 4 * 60_000) }), null);
    assert.equal(inspectPair({ ...base, keyMode: null, now: new Date() }), null);
  });

  it("chaque raison de régénération", () => {
    const { keyPem, certPem } = pair("a");
    const cert = new crypto.X509Certificate(certPem);
    const check = (o: Partial<Parameters<typeof inspectPair>[0]>) =>
      inspectPair({ keyPem, certPem, keyMode: 0o100600, entries: BASE, now: new Date(), ...o });
    assert.equal(check({ keyPem: null }), "absente");
    assert.equal(check({ certPem: null }), "absente");
    assert.equal(check({ keyMode: 0o100644 }), "droits-cle");
    assert.equal(check({ keyMode: 0o100640 }), "droits-cle");
    assert.equal(check({ certPem: "pas un certificat" }), "illisible");
    assert.equal(check({ keyPem: "pas une cle" }), "illisible");
    assert.equal(check({ keyPem: pair("b").keyPem }), "cle-certificat-incoherents");
    assert.equal(check(pair("p384")), "courbe");
    assert.equal(new crypto.X509Certificate(pair("ca").certPem).ca, false);
    assert.equal(check(pair("ca")), "autorite");
    assert.equal(new crypto.X509Certificate(pair("ca-signe").certPem).ca, true);
    assert.equal(check(pair("ca-signe")), "autorite");
    assert.equal(check(pair("ca-non-critique")), null);
    const emise = new crypto.X509Certificate(pair("emise").certPem);
    assert.notEqual(emise.issuer, emise.subject);
    assert.equal(check(pair("emise")), "autorite");
    const memeSujet = new crypto.X509Certificate(pair("emise-meme-sujet").certPem);
    assert.equal(memeSujet.issuer, memeSujet.subject);
    assert.equal(check(pair("emise-meme-sujet")), "autorite");
    assert.equal(check(pair("client")), "usage");
    assert.equal(check({ now: new Date(cert.validToDate.getTime() - 29 * DAY_MS) }), "echeance");
    assert.equal(check({ now: new Date(cert.validToDate.getTime() + DAY_MS) }), "echeance");
    assert.equal(check({ now: new Date(cert.validFromDate.getTime() - 6 * 60_000) }), "date-future");
    assert.equal(check({ entries: [...BASE, "DNS:cockpit.localhost"] }), "san-incomplet");
    assert.equal(check({ entries: [...BASE, "IP:192.168.1.10"] }), "san-incomplet");
  });
});

describe("certificat TLS local : préparation au démarrage (openssl réel)", { skip: SKIP_POSIX }, () => {
  it("premier démarrage : paire générée, droits 0700/0600/0644, fichiers publics au format exact", async () => {
    const tlsDir = freshTlsDir();
    const { value, calls, log } = await start(tlsDir, { ignoredHosts: 2 });
    assert.equal(calls, 1);
    const priv = path.join(tlsDir, "private");
    const pub = path.join(tlsDir, "public");
    assert.equal(modeOf(tlsDir), 0o700);
    assert.equal(modeOf(priv), 0o700);
    assert.equal(modeOf(path.join(priv, "cockpit.key")), 0o600);
    assert.equal(modeOf(path.join(priv, "cockpit.crt")), 0o644);
    assert.equal(modeOf(path.join(pub, "cockpit.crt")), 0o644);
    assert.equal(modeOf(path.join(pub, "cockpit-tls.json")), 0o644);
    assert.deepEqual(fs.readdirSync(priv).sort(), ["cockpit.crt", "cockpit.key"]);
    assert.deepEqual(fs.readdirSync(pub).sort(), ["cockpit-tls.json", "cockpit.crt"]);
    assert.equal(value.key, fs.readFileSync(path.join(priv, "cockpit.key"), "utf8"));
    assert.equal(value.cert, fs.readFileSync(path.join(priv, "cockpit.crt"), "utf8"));

    const json = JSON.parse(fs.readFileSync(path.join(pub, "cockpit-tls.json"), "utf8"));
    assert.deepEqual(Object.keys(json), [
      "schema",
      "source",
      "sha256",
      "sha256Hex",
      "spkiSha256Base64",
      "notBefore",
      "notAfter",
      "san",
      "ignoredHosts",
      "generatedAt",
      "previousSha256",
    ]);
    assert.deepEqual(json, value.info);
    assert.equal(json.schema, 1);
    assert.equal(json.source, "genere");
    assert.deepEqual(json.san, BASE);
    assert.equal(json.ignoredHosts, 2);
    assert.equal(json.previousSha256, null);
    const cert = new crypto.X509Certificate(value.cert);
    assert.equal(cert.subject, "CN=opencode-cockpit (local)");
    assert.equal(Math.round((cert.validToDate.getTime() - cert.validFromDate.getTime()) / DAY_MS), 397);
    assert.equal(json.notBefore, cert.validFromDate.toISOString());
    assert.equal(json.notAfter, cert.validToDate.toISOString());
    assert.match(log, /certificat régénéré : absente/);
    assert.ok(!log.includes("PRIVATE"));
  });

  it("second démarrage : même empreinte, openssl jamais rappelé, date de génération gardée", async () => {
    const tlsDir = freshTlsDir();
    const first = await start(tlsDir);
    const second = await start(tlsDir);
    assert.equal(second.calls, 0);
    assert.equal(second.value.info.sha256, first.value.info.sha256);
    assert.equal(second.value.info.generatedAt, first.value.info.generatedAt);
    assert.equal(second.value.info.previousSha256, null);
    assert.equal(second.value.key, first.value.key);
    assert.ok(!second.log.includes("régénéré"));
  });

  it("hôte ajouté : régénération, previousSha256 = ancienne empreinte, gardée au démarrage suivant", async () => {
    const tlsDir = freshTlsDir();
    const first = await start(tlsDir);
    const entries = [...BASE, "DNS:cockpit.localhost"];
    const second = await start(tlsDir, { entries });
    assert.equal(second.calls, 1);
    assert.match(second.log, /certificat régénéré : san-incomplet/);
    assert.notEqual(second.value.info.sha256, first.value.info.sha256);
    assert.equal(second.value.info.previousSha256, first.value.info.sha256);
    assert.deepEqual(second.value.info.san, entries);
    const third = await start(tlsDir, { entries });
    assert.equal(third.calls, 0);
    assert.equal(third.value.info.previousSha256, first.value.info.sha256);
  });

  it("JSON public relu : falsifié ou d'une autre paire, ignoré (dates du certificat, previousSha256 null)", async () => {
    const tlsDir = freshTlsDir();
    const entries = [...BASE, "DNS:cockpit.localhost"];
    await start(tlsDir);
    const { info } = (await start(tlsDir, { entries })).value;
    assert.notEqual(info.previousSha256, null);
    assert.notEqual(info.generatedAt, info.notBefore);
    const jsonFile = path.join(tlsDir, "public", "cockpit-tls.json");
    const forgeries = [
      { ...info, sha256: `${"AB:".repeat(31)}AB` },
      { ...info, previousSha256: "pas une empreinte" },
      { ...info, generatedAt: "hier" },
    ];
    for (const forged of forgeries) {
      fs.writeFileSync(jsonFile, JSON.stringify(forged));
      const reused = await start(tlsDir, { entries });
      assert.equal(reused.calls, 0);
      assert.equal(reused.value.info.previousSha256, null, JSON.stringify(forged));
      assert.equal(reused.value.info.generatedAt, reused.value.info.notBefore, JSON.stringify(forged));
    }
  });

  it("clé en 0644 : TlsSetupError, openssl non lancé, clé laissée telle quelle, aucun message ne propose -Http", async () => {
    const tlsDir = freshTlsDir();
    await start(tlsDir);
    const key = path.join(tlsDir, "private", "cockpit.key");
    fs.chmodSync(key, 0o644);
    const spy = spyRunner();
    const capture = captureLog();
    await assert.rejects(
      ensureServerCertificate({ tlsDir, entries: BASE, opensslPath: OPENSSL, log: capture.log, run: spy.run }),
      (err: unknown) => {
        assert.ok(err instanceof TlsSetupError);
        assert.equal(err.reason, "droits-cle");
        assert.equal(err.message, "cle TLS aux droits elargis : .\\cockpit.ps1 tls -Renew");
        assert.ok(!err.message.includes("-Http"));
        return true;
      },
    );
    assert.equal(spy.calls(), 0);
    assert.equal(modeOf(key), 0o644);
    assert.ok(!capture.text().includes("-Http"));
  });

  it("/tls en 0755 : TlsSetupError sans aucune écriture, ni purge, ni dossier créé", async () => {
    const populated = freshTlsDir();
    await start(populated);
    fs.writeFileSync(path.join(populated, "private", ".tmp-0123456789abcdef"), "reste", { mode: 0o600 });
    fs.chmodSync(populated, 0o755);
    const empty = freshTlsDir();
    fs.chmodSync(empty, 0o755);
    for (const tlsDir of [populated, empty]) {
      const before = snapshot(tlsDir);
      const spy = spyRunner();
      await assert.rejects(
        ensureServerCertificate({ tlsDir, entries: BASE, opensslPath: OPENSSL, log: captureLog().log, run: spy.run }),
        (err: unknown) => {
          assert.ok(err instanceof TlsSetupError);
          assert.equal(err.reason, "droits-volume");
          assert.equal(err.message, "volume cockpit-tls : droits incorrects (0700, proprietaire node attendus) : relancez .\\install.ps1");
          return true;
        },
      );
      assert.equal(spy.calls(), 0);
      assert.deepEqual(snapshot(tlsDir), before);
    }
    assert.deepEqual(fs.readdirSync(empty), []);
  });

  it("dossier private/ ouvert au groupe : TlsSetupError", async () => {
    const tlsDir = freshTlsDir();
    await start(tlsDir);
    fs.chmodSync(path.join(tlsDir, "private"), 0o750);
    await assert.rejects(start(tlsDir), (err: unknown) => err instanceof TlsSetupError && err.reason === "droits-dossier-prive");
  });

  it("coupure entre les deux renommages : paire incohérente régénérée au démarrage suivant", async () => {
    const tlsDir = freshTlsDir();
    const first = await start(tlsDir);
    const key = path.join(tlsDir, "private", "cockpit.key");
    fs.writeFileSync(key, opensslPair(tempDir()).keyPem);
    fs.chmodSync(key, 0o600);
    const second = await start(tlsDir);
    assert.equal(second.calls, 1);
    assert.match(second.log, /certificat régénéré : cle-certificat-incoherents/);
    assert.equal(second.value.info.previousSha256, first.value.info.sha256);
    const keyPem = fs.readFileSync(key, "utf8");
    const certPem = fs.readFileSync(path.join(tlsDir, "private", "cockpit.crt"), "utf8");
    assert.equal(inspectPair({ keyPem, certPem, keyMode: fs.statSync(key).mode, entries: BASE, now: new Date() }), null);
  });

  it("génération : clé remise en 0600 même si l'outil l'a écrite plus ouverte", async () => {
    const fixture = opensslPair(tempDir());
    const tlsDir = freshTlsDir();
    const { info } = await ensureServerCertificate({
      tlsDir,
      entries: BASE,
      opensslPath: OPENSSL,
      log: captureLog().log,
      run: copyRunner(fixture, 0o644),
    });
    assert.equal(modeOf(path.join(tlsDir, "private", "cockpit.key")), 0o600);
    assert.equal(info.sha256, new crypto.X509Certificate(fixture.certPem).fingerprint256);
  });

  it("génération non conforme (SAN incomplet) : refusée à la revalidation, rien de public", async () => {
    const fixture = opensslPair(tempDir());
    const tlsDir = freshTlsDir();
    await assert.rejects(
      ensureServerCertificate({
        tlsDir,
        entries: [...BASE, "DNS:cockpit.localhost"],
        opensslPath: OPENSSL,
        log: captureLog().log,
        run: copyRunner(fixture, 0o600),
      }),
      (err: unknown) =>
        err instanceof TlsSetupError && err.reason === "certificat-invalide" && err.message.includes("san-incomplet") && !err.message.includes("-Http"),
    );
    assert.deepEqual(fs.readdirSync(path.join(tlsDir, "public")), []);
  });

  it("temporaires .tmp-* purgés dans private/ et public/, JSON périmé remplacé", async () => {
    const tlsDir = freshTlsDir();
    const priv = path.join(tlsDir, "private");
    const pub = path.join(tlsDir, "public");
    fs.mkdirSync(priv, { mode: 0o700 });
    fs.chmodSync(priv, 0o700);
    fs.mkdirSync(pub, { mode: 0o755 });
    fs.writeFileSync(path.join(priv, ".tmp-0123456789abcdef"), "reste d'une generation coupee", { mode: 0o600 });
    fs.writeFileSync(path.join(pub, ".tmp-fedcba9876543210"), "reste d'une ecriture coupee");
    fs.writeFileSync(path.join(pub, "cockpit-tls.json"), '{"schema":1,"sha256":"perime"}');
    const { value } = await start(tlsDir);
    for (const dir of [priv, pub]) assert.ok(!fs.readdirSync(dir).some((name) => name.startsWith(".tmp-")), dir);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(pub, "cockpit-tls.json"), "utf8")), value.info);
  });

  it("public/ : feuille seule, jamais de clé privée", async () => {
    const tlsDir = freshTlsDir();
    const { value } = await start(tlsDir);
    const pub = path.join(tlsDir, "public");
    for (const name of fs.readdirSync(pub)) {
      const content = fs.readFileSync(path.join(pub, name), "utf8");
      assert.ok(!content.includes("PRIVATE KEY"), name);
      assert.ok(!content.includes(value.key.split("\n")[1] ?? "absent"), name);
    }
    const publicPem = fs.readFileSync(path.join(pub, "cockpit.crt"), "utf8");
    assert.equal(publicPem.match(/-----BEGIN [A-Z ]+-----/g)?.join(), "-----BEGIN CERTIFICATE-----");
    assert.equal(new crypto.X509Certificate(publicPem).fingerprint256, value.info.sha256);
  });

  it("empreintes du JSON recalculées par openssl : SHA-256 du certificat et de la clé publique", async () => {
    const tlsDir = freshTlsDir();
    const { value } = await start(tlsDir);
    const crt = path.join(tlsDir, "public", "cockpit.crt");
    const fingerprint = execFileSync(OPENSSL, ["x509", "-in", crt, "-noout", "-fingerprint", "-sha256"], { encoding: "utf8" });
    assert.equal(fingerprint.trim().split("=")[1], value.info.sha256);
    const publicKey = execFileSync(OPENSSL, ["x509", "-in", crt, "-noout", "-pubkey"], { encoding: "utf8" });
    const spkiDer = execFileSync(OPENSSL, ["pkey", "-pubin", "-outform", "DER"], { input: publicKey });
    assert.equal(crypto.createHash("sha256").update(spkiDer).digest("base64"), value.info.spkiSha256Base64);
    assert.equal(value.info.sha256Hex, value.info.sha256.replaceAll(":", "").toLowerCase());
    assert.deepEqual(certificateFingerprints(fs.readFileSync(crt, "utf8")), {
      sha256: value.info.sha256,
      sha256Hex: value.info.sha256Hex,
      spkiSha256Base64: value.info.spkiSha256Base64,
    });
  });
});

describe("certificat TLS local : échecs d'openssl (exécuteur factice)", () => {
  const fail =
    (error: Record<string, unknown>, stderr: string, writeTemporaries = true): ExecFileRunner =>
    (_file, args, _options, callback) => {
      if (writeTemporaries) {
        // Temporaires à moitié écrits, contenu piégé : ils doivent disparaître.
        for (const flag of ["-keyout", "-out"]) fs.writeFileSync(argAfter(args, flag), PIEGE_PEM, { mode: 0o600 });
      }
      const err = Object.assign(new Error(`Command failed: openssl req\n${PIEGE_PEM}\n${FAUX_JETON}`), error) as ExecFileException;
      setImmediate(() => callback(err, "", stderr));
    };
  const cases: Array<[string, ExecFileRunner, string]> = [
    ["openssl absent (ENOENT)", fail({ code: "ENOENT" }, "", false), "openssl-absent"],
    ["code 1, stderr piégé par un bloc de clé privée", fail({ code: 1 }, `${PIEGE_PEM}\n${FAUX_JETON}`), "code 1"],
    ["code 3, première ligne de stderr avec un secret", fail({ code: 3 }, `openssl: password=${FAUX_JETON}`), "code 3"],
    ["délai dépassé (processus tué)", fail({ killed: true, signal: "SIGTERM", code: null }, PIEGE_PEM), "delai"],
    ["tampon de sortie dépassé", fail({ code: "ERR_CHILD_PROCESS_STDIO_MAXBUFFER", killed: true }, PIEGE_PEM), "echec"],
    ["succès annoncé sans fichier produit", (_f, _a, _o, callback) => setImmediate(() => callback(null, "", "")), "echec"],
    [
      "exécuteur qui lève une exception",
      () => {
        throw new Error(PIEGE_PEM);
      },
      "echec",
    ],
  ];
  for (const [name, run, reason] of cases) {
    it(`${name} : TlsSetupError « ${reason} », sans contenu piégé, sans temporaire, public/ purgé, sans -Http`, async () => {
      const tlsDir = freshTlsDir();
      // Fichiers publics d'un démarrage précédent : ils ne doivent pas survivre à l'échec.
      fs.mkdirSync(path.join(tlsDir, "public"), { mode: 0o755 });
      fs.writeFileSync(path.join(tlsDir, "public", "cockpit.crt"), "ancienne feuille");
      fs.writeFileSync(path.join(tlsDir, "public", "cockpit-tls.json"), '{"schema":1}');
      const capture = captureLog();
      await assert.rejects(ensureServerCertificate({ tlsDir, entries: BASE, opensslPath: OPENSSL, log: capture.log, run }), (err: unknown) => {
        assert.ok(err instanceof TlsSetupError, String(err));
        assert.equal(err.reason, reason);
        for (const text of [err.message, err.remedy]) {
          assert.ok(!text.includes("PRIVATE"), text);
          assert.ok(!text.includes(PIEGE_B64), text);
          assert.ok(!text.includes(FAUX_JETON), text);
          assert.ok(!text.includes("-Http"), text);
        }
        assert.match(err.remedy, /install\.ps1|tls -Renew/);
        return true;
      });
      assert.deepEqual(fs.readdirSync(path.join(tlsDir, "private")), []);
      assert.deepEqual(fs.readdirSync(path.join(tlsDir, "public")), []);
      assert.ok(!capture.text().includes("PRIVATE") && !capture.text().includes(PIEGE_B64) && !capture.text().includes(FAUX_JETON));
    });
  }

  it("première ligne de stderr ordinaire : reprise, ASCII imprimable, 120 caractères au plus", async () => {
    const tlsDir = freshTlsDir();
    const stderr = `req: Unknown option -foo ${"é".repeat(5)}${"x".repeat(200)}\nligne suivante jamais reprise`;
    await assert.rejects(
      ensureServerCertificate({ tlsDir, entries: BASE, opensslPath: OPENSSL, log: captureLog().log, run: fail({ code: 2 }, stderr) }),
      (err: unknown) => {
        assert.ok(err instanceof TlsSetupError);
        assert.equal(err.reason, "code 2");
        const detail = err.message.slice("openssl a echoue (code 2) : ".length, err.message.lastIndexOf(" : "));
        assert.ok(detail.startsWith("req: Unknown option -foo x"), detail);
        assert.ok(detail.length <= 120, String(detail.length));
        assert.match(err.message, /^[ -~]+$/);
        assert.ok(!err.message.includes("ligne suivante"));
        return true;
      },
    );
  });

  it("appel d'openssl : chemin donné, arguments du produit, environnement réduit à PATH, délai de 15 s", async () => {
    const tlsDir = freshTlsDir();
    const seen: Array<{ file: string; args: string[]; options: unknown }> = [];
    const run: ExecFileRunner = (file, args, options, callback) => {
      seen.push({ file, args: [...args], options });
      setImmediate(() => callback(Object.assign(new Error("absent"), { code: "ENOENT" }) as ExecFileException, "", ""));
    };
    await assert.rejects(ensureServerCertificate({ tlsDir, entries: BASE, opensslPath: "/usr/bin/openssl", log: captureLog().log, run }), TlsSetupError);
    assert.equal(seen.length, 1);
    const call = seen[0];
    assert.ok(call);
    assert.equal(call.file, "/usr/bin/openssl");
    assert.deepEqual(call.options, { timeout: 15_000, env: { PATH: "/usr/bin:/bin" }, maxBuffer: 64_000, windowsHide: true });
    const keyTmp = argAfter(call.args, "-keyout");
    const certTmp = argAfter(call.args, "-out");
    for (const tmp of [keyTmp, certTmp]) {
      assert.equal(path.dirname(tmp), path.join(tlsDir, "private"));
      assert.match(path.basename(tmp), /^\.tmp-[0-9a-f]{16}$/);
    }
    assert.notEqual(keyTmp, certTmp);
    assert.deepEqual(call.args, opensslArgs(keyTmp, certTmp, BASE));
  });

  it("clé remplacée par un dossier : TlsSetupError « fichier-inattendu », openssl non lancé", async () => {
    const tlsDir = freshTlsDir();
    fs.mkdirSync(path.join(tlsDir, "private"), { mode: 0o700 });
    if (POSIX) fs.chmodSync(path.join(tlsDir, "private"), 0o700);
    fs.mkdirSync(path.join(tlsDir, "private", "cockpit.key"));
    let calls = 0;
    const run: ExecFileRunner = () => {
      calls++;
    };
    await assert.rejects(
      ensureServerCertificate({ tlsDir, entries: BASE, opensslPath: OPENSSL, log: captureLog().log, run }),
      (err: unknown) => err instanceof TlsSetupError && err.reason === "fichier-inattendu" && !err.message.includes("-Http"),
    );
    assert.equal(calls, 0);
  });

  it("vrai execFile sur un binaire absent : openssl-absent", async () => {
    const tlsDir = freshTlsDir();
    await assert.rejects(
      ensureServerCertificate({ tlsDir, entries: BASE, opensslPath: path.join(tempDir(), "openssl-absent"), log: captureLog().log }),
      (err: unknown) => err instanceof TlsSetupError && err.reason === "openssl-absent" && !err.message.includes("-Http"),
    );
    assert.deepEqual(fs.readdirSync(path.join(tlsDir, "private")), []);
  });
});

describe("poignées TLS refusées : résumé sans contenu", () => {
  it("1 000 événements : une seule ligne par fenêtre de 60 s, total glissant sur 24 h", () => {
    let now = 1_000_000_000;
    const capture = captureLog();
    const refusals = new TlsRefusals({ log: capture.log, now: () => now });
    for (let i = 0; i < 1000; i++) {
      refusals.add(Object.assign(new Error(`GET /auth?t=${FAUX_JETON}`), { code: "ERR_SSL_HTTP_REQUEST" }));
      now += 50;
    }
    refusals.flush();
    assert.equal(capture.lines.length, 0, "fenêtre de 60 s pas encore écoulée");
    now = 1_000_000_000 + 60_000;
    refusals.flush();
    refusals.flush();
    assert.equal(capture.lines.length, 1);
    const first = JSON.parse(capture.lines[0] ?? "{}");
    assert.equal(first.total, 1000);
    assert.deepEqual(first.codes, { ERR_SSL_HTTP_REQUEST: 1000 });

    for (let i = 0; i < 1000; i++) {
      refusals.add({ code: "ECONNRESET" });
      now += 10;
    }
    assert.equal(capture.lines.length, 1);
    now += 60_000;
    refusals.add({ code: "ECONNRESET" }); // écrit la fenêtre écoulée, puis ouvre la suivante
    assert.equal(capture.lines.length, 2);
    assert.deepEqual(JSON.parse(capture.lines[1] ?? "{}").codes, { ECONNRESET: 1000 });
    refusals.stop();
    assert.equal(capture.lines.length, 3);
    assert.equal(refusals.count24h(), 2001);
    now += 25 * 3_600_000;
    assert.equal(refusals.count24h(), 0);
    assert.ok(!capture.text().includes(FAUX_JETON));
  });

  it("code exotique → AUTRE ; ni message, ni adresse, ni jeton dans le journal", () => {
    const capture = captureLog();
    const refusals = new TlsRefusals({ log: capture.log, now: () => 0 });
    const exotic: unknown[] = [
      Object.assign(new Error(FAUX_JETON), { code: `ERR_${FAUX_JETON}` }),
      { code: "err_ssl_minuscules" },
      { code: "A".repeat(81) },
      { code: "ERR\nFORGE" },
      { code: 42 },
      { message: FAUX_JETON },
      null,
      FAUX_JETON,
    ];
    for (const err of exotic) refusals.add(err);
    refusals.add({ code: "ERR_SSL_WRONG_VERSION_NUMBER", message: FAUX_JETON, remoteAddress: "10.1.2.3" });
    refusals.flush(true);
    assert.equal(capture.lines.length, 1);
    const line = JSON.parse(capture.lines[0] ?? "{}");
    assert.deepEqual(line.codes, { AUTRE: exotic.length, ERR_SSL_WRONG_VERSION_NUMBER: 1 });
    assert.ok(!capture.text().includes(FAUX_JETON));
    assert.ok(!capture.text().includes("10.1.2.3"));
  });

  it("minuterie de résumé sans effet sur l'arrêt du processus, arrêt idempotent", () => {
    const capture = captureLog();
    const refusals = new TlsRefusals({ log: capture.log });
    refusals.start();
    refusals.start();
    refusals.add({ code: "ECONNRESET" });
    refusals.stop();
    refusals.stop();
    assert.equal(capture.lines.length, 1);
  });
});
