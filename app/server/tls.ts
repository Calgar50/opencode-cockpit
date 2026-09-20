// Certificat TLS du cockpit sur la boucle locale (mode HTTPS, 1.0.5) : paire ECDSA P-256 auto-signée, générée au démarrage par
// openssl (execFile, liste d'arguments, jamais de shell) dans le volume cockpit-tls, monté seulement dans ce conteneur.
// Clé 0600 dans un dossier 0700 : jamais dans l'image, la sauvegarde, le journal ni l'API. Renouvelée au démarrage seulement.
// Aucun message ne propose le mode HTTP : un défaut réparable ne doit pas habituer à s'en servir.
import { type ExecFileException, execFile } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import type { Logger } from "./log.ts";
import { redactSecrets } from "./redact.ts";

/** Durée de validité du certificat (Q5). */
export const TLS_CERT_DAYS = 397;
/** Renouvellement au démarrage quand l'échéance est à moins de 30 jours. */
export const TLS_RENEW_BEFORE_DAYS = 30;
/** Entrées subjectAltName au plus, base comprise. */
export const TLS_MAX_SAN_ENTRIES = 16;
/** Sujet fixe : aucune donnée de configuration n'y est recopiée. */
export const TLS_SUBJECT = "/CN=opencode-cockpit (local)";

const DAY_MS = 86_400_000;
const CLOCK_SKEW_MS = 5 * 60_000;
const OPENSSL_TIMEOUT_MS = 15_000;
const BASE_SAN = ["IP:127.0.0.1", "DNS:localhost", "IP:::1"];
const DNS_NAME = /^(?=.{1,253}$)[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*$/;
const SAN_ENTRY = /^(?:IP:[0-9a-f:.]{2,45}|DNS:[a-z0-9.-]{1,253})$/;
const SERVER_AUTH_OID = "1.3.6.1.5.5.7.3.1";
const FINGERPRINT = /^(?:[0-9A-F]{2}:){31}[0-9A-F]{2}$/;
const REMEDY_INSTALL = "relancez .\\install.ps1";
const REMEDY_RENEW = ".\\cockpit.ps1 tls -Renew";

/** Échec de préparation du HTTPS local : raison courte et remède, sans aucun contenu lu (clé, sortie brute d'openssl). */
export class TlsSetupError extends Error {
  override name = "TlsSetupError";
  /** Catégorie : droits-volume, droits-cle, openssl-absent, delai, code <n>… */
  readonly reason: string;
  /** Commande à lancer : .\install.ps1 ou .\cockpit.ps1 tls -Renew. */
  readonly remedy: string;

  constructor(reason: string, description: string, remedy: string) {
    super(`${description} : ${remedy}`);
    this.reason = reason;
    this.remedy = remedy;
  }
}

// --- Noms couverts par le certificat -------------------------------------------------------------------------------------

export interface SanHosts {
  /** Entrées subjectAltName validées (IP:… ou DNS:…), base en tête, sans doublon, 16 au plus. */
  entries: string[];
  /** Valeurs écartées, réduites à 40 caractères ASCII imprimables. */
  ignored: string[];
}

/** Adresse IP canonique (IPv6 compressée en minuscules) ou null ; un identifiant de zone (%) fait échouer new URL. */
function canonicalIp(value: string): string | null {
  const family = net.isIP(value);
  if (family === 4) return value;
  if (family !== 6) return null;
  try {
    return new URL(`http://[${value}]/`).hostname.slice(1, -1);
  } catch {
    return null;
  }
}

const printable = (value: string): string => value.replace(/[^ -~]/g, "?").slice(0, 40);

/**
 * COCKPIT_ALLOWED_HOSTS → entrées du certificat. Base IP:127.0.0.1, DNS:localhost, IP:::1 ; IPv6 entre crochets ; nom DNS
 * strict avec au moins une lettre (ni joker, ni port, ni préfixe « IP: » ou « DNS: », ni virgule qui ajouterait une entrée).
 */
export function normalizeSanHosts(allowedHosts: readonly string[], log?: Logger): SanHosts {
  const entries = [...BASE_SAN];
  const ignored: string[] = [];
  const skip = (value: string, motif: string) => {
    const shown = printable(value);
    ignored.push(shown);
    log?.warn("hôte ignoré pour le certificat TLS local", { valeur: shown, motif });
  };
  for (const raw of allowedHosts) {
    const host = raw.trim().toLowerCase();
    if (!host) continue;
    const bracketed = /^\[(.*)\]$/.exec(host);
    let entry: string | null = null;
    if (bracketed) {
      const ip = canonicalIp(bracketed[1] ?? "");
      if (ip !== null && ip.includes(":")) entry = `IP:${ip}`;
    } else {
      const ip = canonicalIp(host);
      if (ip !== null) entry = `IP:${ip}`;
      else if (DNS_NAME.test(host) && /[a-z]/.test(host)) entry = `DNS:${host}`;
    }
    if (entry === null) {
      skip(raw, "nom d'hôte ou adresse IP invalide");
      continue;
    }
    if (entries.includes(entry)) continue;
    if (entries.length >= TLS_MAX_SAN_ENTRIES) {
      skip(raw, `plus de ${TLS_MAX_SAN_ENTRIES} entrées`);
      continue;
    }
    entries.push(entry);
  }
  return { entries, ignored };
}

/** Arguments d'openssl req (Q5) ; les entrées sont revalidées ici, juste avant d'être passées à openssl. */
export function opensslArgs(keyTmp: string, certTmp: string, entries: readonly string[]): string[] {
  if (entries.length === 0 || entries.length > TLS_MAX_SAN_ENTRIES || !entries.every((e) => SAN_ENTRY.test(e))) {
    throw new TlsSetupError("san-invalide", "entrees du certificat invalides", REMEDY_INSTALL);
  }
  return [
    "req",
    "-x509",
    "-newkey",
    "ec",
    "-pkeyopt",
    "ec_paramgen_curve:prime256v1",
    "-nodes",
    "-sha256",
    "-days",
    String(TLS_CERT_DAYS),
    "-subj",
    TLS_SUBJECT,
    "-addext",
    `subjectAltName=${entries.join(",")}`,
    "-addext",
    "basicConstraints=critical,CA:FALSE",
    "-addext",
    "keyUsage=critical,digitalSignature",
    "-addext",
    "extendedKeyUsage=serverAuth",
    "-keyout",
    keyTmp,
    "-out",
    certTmp,
  ];
}

// --- Inspection d'une paire ----------------------------------------------------------------------------------------------

export type PairReason =
  | "absente"
  | "droits-cle"
  | "illisible"
  | "cle-certificat-incoherents"
  | "courbe"
  | "autorite"
  | "usage"
  | "echeance"
  | "date-future"
  | "san-incomplet";

const BASIC_CONSTRAINTS_OID = Buffer.from([0x06, 0x03, 0x55, 0x1d, 0x13]);

/**
 * Extension basicConstraints avec cA à vrai, lue dans le DER : x509.ca (X509_check_ca) ne la signale que si keyUsage autorise
 * aussi la signature de certificats. Forme DER : OID, critique facultatif, OCTET STRING { SEQUENCE { BOOLEAN cA … } }.
 */
function basicConstraintsCa(der: Buffer): boolean {
  for (let at = der.indexOf(BASIC_CONSTRAINTS_OID); at !== -1; at = der.indexOf(BASIC_CONSTRAINTS_OID, at + 1)) {
    let p = at + BASIC_CONSTRAINTS_OID.length;
    if (der[p] === 0x01 && der[p + 1] === 0x01) p += 3;
    if (der[p] !== 0x04 || der[p + 2] !== 0x30 || (der[p + 3] ?? 0) < 3) continue;
    if (der[p + 4] === 0x01 && der[p + 5] === 0x01 && der[p + 6] !== 0x00) return true;
  }
  return false;
}

function covers(cert: crypto.X509Certificate, entry: string): boolean {
  if (entry.startsWith("IP:")) return cert.checkIP(entry.slice(3)) !== undefined;
  if (entry.startsWith("DNS:")) return cert.checkHost(entry.slice(4), { subject: "never", wildcards: false }) !== undefined;
  return false;
}

/**
 * null si la paire est réutilisable, sinon la raison de la régénérer. keyMode : droits de la clé (null = non vérifiés, Windows).
 * Échéance à moins de 30 jours et début de validité à plus de 5 minutes dans le futur refusés, `now` injecté.
 */
export function inspectPair(o: {
  keyPem: string | null;
  certPem: string | null;
  keyMode: number | null;
  entries: readonly string[];
  now: Date;
}): PairReason | null {
  if (o.keyPem === null || o.certPem === null) return "absente";
  if (o.keyMode !== null && (o.keyMode & 0o077) !== 0) return "droits-cle";
  let cert: crypto.X509Certificate;
  let key: crypto.KeyObject;
  try {
    cert = new crypto.X509Certificate(o.certPem);
    key = crypto.createPrivateKey(o.keyPem);
  } catch {
    return "illisible";
  }
  try {
    if (!cert.checkPrivateKey(key)) return "cle-certificat-incoherents";
  } catch {
    return "cle-certificat-incoherents";
  }
  if (cert.publicKey.asymmetricKeyType !== "ec" || cert.publicKey.asymmetricKeyDetails?.namedCurve !== "prime256v1") return "courbe";
  // Autorité, ou certificat signé par une autre clé que la sienne (émis par une autorité) : pas notre feuille auto-signée.
  if (cert.ca || basicConstraintsCa(cert.raw) || !cert.verify(cert.publicKey)) return "autorite";
  if (!(cert.keyUsage ?? []).includes(SERVER_AUTH_OID)) return "usage";
  const now = o.now.getTime();
  if (cert.validToDate.getTime() - now < TLS_RENEW_BEFORE_DAYS * DAY_MS) return "echeance";
  if (cert.validFromDate.getTime() > now + CLOCK_SKEW_MS) return "date-future";
  if (!o.entries.every((entry) => covers(cert, entry))) return "san-incomplet";
  return null;
}

// --- Empreintes et fichier public ----------------------------------------------------------------------------------------

export interface CertificateFingerprints {
  /** SHA-256 du certificat, « AB:CD:… » (format de x509.fingerprint256). */
  sha256: string;
  /** Même empreinte en hexadécimal minuscule sans séparateur. */
  sha256Hex: string;
  /** SHA-256 de la clé publique (SPKI DER) en base64, format de curl --pinnedpubkey. */
  spkiSha256Base64: string;
}

export function certificateFingerprints(certificate: crypto.X509Certificate | string): CertificateFingerprints {
  const cert = typeof certificate === "string" ? new crypto.X509Certificate(certificate) : certificate;
  const spki = cert.publicKey.export({ type: "spki", format: "der" });
  return {
    sha256: cert.fingerprint256,
    sha256Hex: cert.fingerprint256.replaceAll(":", "").toLowerCase(),
    spkiSha256Base64: crypto.createHash("sha256").update(spki).digest("base64"),
  };
}

/** Contenu de public/cockpit-tls.json (§3.6.1), dans cet ordre. */
export interface TlsInfo {
  schema: 1;
  source: "genere";
  sha256: string;
  sha256Hex: string;
  spkiSha256Base64: string;
  notBefore: string;
  notAfter: string;
  san: string[];
  ignoredHosts: number;
  generatedAt: string;
  previousSha256: string | null;
}

/** Entrées subjectAltName du certificat, au format de normalizeSanHosts (Node écrit « IP Address:0:0:…:1 »). */
function certificateSan(cert: crypto.X509Certificate): string[] {
  const san: string[] = [];
  for (const part of (cert.subjectAltName ?? "").split(", ")) {
    if (part.startsWith("DNS:") && DNS_NAME.test(part.slice(4))) san.push(part);
    else if (part.startsWith("IP Address:")) {
      const ip = canonicalIp(part.slice("IP Address:".length));
      if (ip !== null) san.push(`IP:${ip}`);
    }
  }
  return san;
}

const isIsoInstant = (value: string): boolean => {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) return false;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) && date.toISOString() === value;
};

/**
 * Date de génération et empreinte précédente annoncées au démarrage précédent, relues avant la purge de public/ pour être
 * gardées quand la paire est réutilisée. Fichier absent, illisible ou mal formé : null (le serveur repart des dates du certificat).
 */
function readAnnounced(file: string): { sha256: string; generatedAt: string; previousSha256: string | null } | null {
  let data: unknown;
  try {
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.size > 16_000) return null;
    data = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
  if (typeof data !== "object" || data === null) return null;
  const { sha256, generatedAt, previousSha256 } = data as Record<string, unknown>;
  if (typeof sha256 !== "string" || !FINGERPRINT.test(sha256)) return null;
  if (typeof generatedAt !== "string" || !isIsoInstant(generatedAt)) return null;
  if (previousSha256 !== null && (typeof previousSha256 !== "string" || !FINGERPRINT.test(previousSha256))) return null;
  return { sha256, generatedAt, previousSha256 };
}

// --- Préparation au démarrage --------------------------------------------------------------------------------------------

/** Signature d'execFile utilisée ici (injectable dans les tests). */
export type ExecFileRunner = (
  file: string,
  args: readonly string[],
  options: { timeout: number; env: NodeJS.ProcessEnv; maxBuffer: number; windowsHide: boolean },
  callback: (error: ExecFileException | null, stdout: string, stderr: string) => void,
) => unknown;

export interface EnsureCertificateOptions {
  tlsDir: string;
  /** Entrées validées par normalizeSanHosts. */
  entries: readonly string[];
  /** Nombre de valeurs écartées par normalizeSanHosts, recopié dans cockpit-tls.json. */
  ignoredHosts?: number;
  opensslPath: string;
  log: Logger;
  now?: Date;
  run?: ExecFileRunner;
}

export interface ServerCertificate {
  key: string;
  cert: string;
  info: TlsInfo;
}

function lstatOrNull(file: string): fs.Stats | null {
  try {
    return fs.lstatSync(file);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}

const ownedAndClosed = (stat: fs.Stats): boolean => stat.uid === process.getuid?.() && (stat.mode & 0o077) === 0;

const tmpName = (): string => `.tmp-${crypto.randomBytes(8).toString("hex")}`;

/** Supprime les fichiers temporaires (.tmp-*) laissés par une génération ou une écriture interrompue. */
function purgeTemporaries(dir: string): void {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith(".tmp-") && (entry.isFile() || entry.isSymbolicLink())) {
      fs.rmSync(path.join(dir, entry.name), { force: true });
    }
  }
}

const errorCode = (err: unknown): string => {
  const code = typeof err === "object" && err !== null ? (err as { code?: unknown }).code : undefined;
  return typeof code === "string" && /^[A-Z0-9_]{1,40}$/.test(code) ? code : "erreur";
};

/** Première ligne de stderr, masquée, ASCII imprimable, 120 caractères ; rien qui ressemble à un bloc PEM. */
function stderrHead(stderr: unknown): string {
  const text = typeof stderr === "string" ? stderr : Buffer.isBuffer(stderr) ? stderr.toString("utf8") : "";
  const line = text.split(/\r?\n/, 1)[0] ?? "";
  const clean = redactSecrets(line)
    .replace(/[^ -~]/g, "")
    .trim()
    .slice(0, 120);
  return /PRIVATE|-----/i.test(clean) ? "(sortie masquee)" : clean;
}

function opensslFailure(error: unknown, stderr: unknown): TlsSetupError {
  const e = (typeof error === "object" && error !== null ? error : {}) as { code?: unknown; killed?: unknown; signal?: unknown };
  if (e.code === "ENOENT") return new TlsSetupError("openssl-absent", "openssl introuvable dans l'image du cockpit", REMEDY_INSTALL);
  const head = stderrHead(stderr);
  const detail = head ? ` : ${head}` : "";
  if (typeof e.code === "number") return new TlsSetupError(`code ${e.code}`, `openssl a echoue (code ${e.code})${detail}`, REMEDY_RENEW);
  if ((e.code === undefined || e.code === null) && (e.killed === true || typeof e.signal === "string")) {
    return new TlsSetupError("delai", `openssl interrompu (delai de ${OPENSSL_TIMEOUT_MS / 1000} s)`, REMEDY_RENEW);
  }
  return new TlsSetupError("echec", `openssl a echoue (${errorCode(error)})${detail}`, REMEDY_RENEW);
}

function runOpenssl(run: ExecFileRunner, file: string, args: readonly string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    try {
      run(
        file,
        args,
        // Environnement réduit à PATH : ni proxy, ni OPENSSL_CONF, ni jeton hérités du conteneur.
        { timeout: OPENSSL_TIMEOUT_MS, env: { PATH: "/usr/bin:/bin" }, maxBuffer: 64_000, windowsHide: true },
        (error, _stdout, stderr) => (error ? reject(opensslFailure(error, stderr)) : resolve()),
      );
    } catch (err) {
      reject(opensslFailure(err, ""));
    }
  });
}

/** Écriture atomique d'un fichier public (0644) : temporaire voisin puis renommage. */
function writePublic(dir: string, name: string, content: string): void {
  const tmp = path.join(dir, tmpName());
  try {
    fs.writeFileSync(tmp, content, { encoding: "utf8", mode: 0o644, flag: "wx" });
    if (process.platform !== "win32") fs.chmodSync(tmp, 0o644);
    fs.renameSync(tmp, path.join(dir, name));
  } finally {
    fs.rmSync(tmp, { force: true });
  }
}

/**
 * Paire du serveur HTTPS, vérifiée ou régénérée avant toute écoute (§3.6.2). Échec : TlsSetupError, jamais de repli.
 * 1. volume à l'uid du serveur en 0700 (aucune écriture avant) ; 2. purge de public/ ; 3. private/ en 0700 et purge des .tmp-* ;
 * 4. clé aux droits élargis refusée ; 5. inspection ; 6. génération éventuelle ; 7. revalidation ; 8. écriture de public/.
 * Sous Windows (développement seulement), les contrôles de droits POSIX sont sautés avec un avertissement.
 */
export async function ensureServerCertificate(o: EnsureCertificateOptions): Promise<ServerCertificate> {
  try {
    return await prepare(o);
  } catch (err) {
    if (err instanceof TlsSetupError) throw err;
    throw new TlsSetupError("volume", `volume cockpit-tls inutilisable (${errorCode(err)})`, REMEDY_INSTALL);
  }
}

async function prepare(o: EnsureCertificateOptions): Promise<ServerCertificate> {
  const now = o.now ?? new Date();
  const run = o.run ?? execFile;
  const posix = process.platform !== "win32";
  const privateDir = path.join(o.tlsDir, "private");
  const publicDir = path.join(o.tlsDir, "public");
  const keyFile = path.join(privateDir, "cockpit.key");
  const certFile = path.join(privateDir, "cockpit.crt");
  const publicJson = path.join(publicDir, "cockpit-tls.json");
  if (!posix) o.log.warn("certificat TLS local : contrôles de droits POSIX sautés (Windows, développement seulement)");

  // 1. Volume : rien n'est écrit tant que le propriétaire et les droits ne sont pas ceux attendus.
  const root = lstatOrNull(o.tlsDir);
  if (root === null || !root.isDirectory()) throw new TlsSetupError("volume-absent", "volume cockpit-tls absent", REMEDY_INSTALL);
  if (posix && !ownedAndClosed(root)) {
    throw new TlsSetupError("droits-volume", "volume cockpit-tls : droits incorrects (0700, proprietaire node attendus)", REMEDY_INSTALL);
  }

  // 2. Fichiers publics : jamais un JSON périmé ; réécrits seulement après validation de la paire.
  const announced = readAnnounced(publicJson);
  if (lstatOrNull(publicDir) === null) fs.mkdirSync(publicDir, { mode: 0o755 });
  purgeTemporaries(publicDir);
  fs.rmSync(path.join(publicDir, "cockpit.crt"), { force: true });
  fs.rmSync(publicJson, { force: true });

  // 3. Dossier privé.
  if (lstatOrNull(privateDir) === null) {
    fs.mkdirSync(privateDir, { mode: 0o700 });
    if (posix) fs.chmodSync(privateDir, 0o700);
  }
  const privateStat = fs.lstatSync(privateDir);
  if (!privateStat.isDirectory() || (posix && !ownedAndClosed(privateStat))) {
    throw new TlsSetupError(
      "droits-dossier-prive",
      "volume cockpit-tls : dossier private aux droits incorrects (0700, proprietaire node attendus)",
      REMEDY_INSTALL,
    );
  }
  purgeTemporaries(privateDir);

  // 4. Une clé lisible par d'autres a pu être copiée : refus, jamais de réparation silencieuse.
  const keyStat = lstatOrNull(keyFile);
  const certStat = lstatOrNull(certFile);
  if ((keyStat !== null && !keyStat.isFile()) || (certStat !== null && !certStat.isFile())) {
    throw new TlsSetupError("fichier-inattendu", "volume cockpit-tls : cle ou certificat qui n'est pas un fichier ordinaire", REMEDY_RENEW);
  }
  if (posix && keyStat !== null && (keyStat.mode & 0o077) !== 0) {
    throw new TlsSetupError("droits-cle", "cle TLS aux droits elargis", REMEDY_RENEW);
  }

  // 5. Paire existante.
  let keyPem = keyStat === null ? null : fs.readFileSync(keyFile, "utf8");
  let certPem = certStat === null ? null : fs.readFileSync(certFile, "utf8");
  const reason = inspectPair({ keyPem, certPem, keyMode: posix && keyStat !== null ? keyStat.mode : null, entries: o.entries, now });
  let generatedAt: string | null = null;
  let previousSha256: string | null = null;

  if (reason !== null) {
    o.log.info(`certificat régénéré : ${reason}`);
    try {
      // Certificat absent (« .\cockpit.ps1 tls -Renew » efface la paire et garde cockpit-tls.json) : empreinte annoncée au
      // démarrage précédent, relue et validée avant la purge de public/.
      previousSha256 = certPem === null ? (announced?.sha256 ?? null) : new crypto.X509Certificate(certPem).fingerprint256;
    } catch {
      previousSha256 = null; // certificat illisible : aucune empreinte à annoncer
    }

    // 6. Génération dans private/ puis renommage, clé d'abord ; une coupure entre les deux est rattrapée au démarrage suivant.
    const keyTmp = path.join(privateDir, tmpName());
    const certTmp = path.join(privateDir, tmpName());
    try {
      await runOpenssl(run, o.opensslPath, opensslArgs(keyTmp, certTmp, o.entries));
      if (!lstatOrNull(keyTmp)?.isFile() || !lstatOrNull(certTmp)?.isFile()) {
        throw new TlsSetupError("echec", "openssl n'a pas produit la cle et le certificat", REMEDY_RENEW);
      }
      if (posix) {
        fs.chmodSync(keyTmp, 0o600);
        fs.chmodSync(certTmp, 0o644);
      }
      fs.renameSync(keyTmp, keyFile);
      fs.renameSync(certTmp, certFile);
    } finally {
      fs.rmSync(keyTmp, { force: true });
      fs.rmSync(certTmp, { force: true });
    }

    // 7. Revalidation de ce qui est réellement sur le disque.
    keyPem = fs.readFileSync(keyFile, "utf8");
    certPem = fs.readFileSync(certFile, "utf8");
    const after = inspectPair({ keyPem, certPem, keyMode: posix ? fs.lstatSync(keyFile).mode : null, entries: o.entries, now });
    if (after !== null) throw new TlsSetupError("certificat-invalide", `certificat genere refuse (${after})`, REMEDY_RENEW);
    generatedAt = now.toISOString();
  }
  if (keyPem === null || certPem === null) throw new TlsSetupError("echec", "paire TLS absente apres generation", REMEDY_RENEW);

  // 8. Fichiers publics : feuille seule et empreintes, jamais la clé.
  const cert = new crypto.X509Certificate(certPem);
  const prints = certificateFingerprints(cert);
  if (generatedAt === null) {
    const kept = announced !== null && announced.sha256 === prints.sha256 ? announced : null;
    generatedAt = kept?.generatedAt ?? cert.validFromDate.toISOString();
    previousSha256 = kept?.previousSha256 ?? null;
  }
  const info: TlsInfo = {
    schema: 1,
    source: "genere",
    sha256: prints.sha256,
    sha256Hex: prints.sha256Hex,
    spkiSha256Base64: prints.spkiSha256Base64,
    notBefore: cert.validFromDate.toISOString(),
    notAfter: cert.validToDate.toISOString(),
    san: certificateSan(cert),
    ignoredHosts: o.ignoredHosts ?? 0,
    generatedAt,
    previousSha256,
  };
  const publicPem = cert.toString();
  const json = `${JSON.stringify(info, null, 2)}\n`;
  if (publicPem.includes("PRIVATE KEY") || json.includes("PRIVATE KEY")) {
    throw new TlsSetupError("fichier-public", "contenu public refuse (cle privee detectee)", REMEDY_RENEW);
  }
  writePublic(publicDir, "cockpit.crt", publicPem);
  writePublic(publicDir, "cockpit-tls.json", json);
  return { key: keyPem, cert: certPem, info };
}

// --- Poignées TLS refusées -----------------------------------------------------------------------------------------------

const REFUSAL_CODE = /^[A-Z0-9_/]{1,80}$/;
const WINDOW_MS = 60_000;
const HOUR_MS = 3_600_000;

/**
 * Compteur des poignées TLS refusées (événement tlsClientError) : seul le code filtré est gardé, jamais le message, l'adresse
 * ni les octets reçus. Au plus une ligne de journal par fenêtre de 60 s ; total glissant sur 24 h, par heure.
 */
export class TlsRefusals {
  readonly #log: Logger;
  readonly #now: () => number;
  #pending = new Map<string, number>();
  #windowStart: number | null = null;
  readonly #hours = new Map<number, number>();
  #timer: NodeJS.Timeout | null = null;

  constructor(deps: { log: Logger; now?: () => number }) {
    this.#log = deps.log;
    this.#now = deps.now ?? Date.now;
  }

  add(err: unknown): void {
    const raw = typeof err === "object" && err !== null ? (err as { code?: unknown }).code : undefined;
    const code = typeof raw === "string" && REFUSAL_CODE.test(raw) ? raw : "AUTRE";
    const now = this.#now();
    if (this.#windowStart !== null && now - this.#windowStart >= WINDOW_MS) this.flush();
    if (this.#windowStart === null) this.#windowStart = now;
    this.#pending.set(code, (this.#pending.get(code) ?? 0) + 1);
    const hour = Math.floor(now / HOUR_MS);
    this.#hours.set(hour, (this.#hours.get(hour) ?? 0) + 1);
    this.#prune(hour);
  }

  /** Journalise la fenêtre écoulée ; `force` (arrêt) écrit même une fenêtre inachevée. */
  flush(force = false): void {
    if (this.#windowStart === null || this.#pending.size === 0) return;
    if (!force && this.#now() - this.#windowStart < WINDOW_MS) return;
    const codes = Object.fromEntries([...this.#pending.entries()].sort(([a], [b]) => a.localeCompare(b)));
    const total = [...this.#pending.values()].reduce((sum, n) => sum + n, 0);
    this.#log.info("connexions TLS refusées sur la boucle locale", { total, codes });
    this.#pending = new Map();
    this.#windowStart = null;
  }

  /** Poignées refusées sur les 24 dernières heures (par tranches d'une heure). */
  count24h(): number {
    this.#prune(Math.floor(this.#now() / HOUR_MS));
    let total = 0;
    for (const n of this.#hours.values()) total += n;
    return total;
  }

  /** Résumé périodique ; minuterie sans effet sur l'arrêt du processus. */
  start(): void {
    if (this.#timer !== null) return;
    this.#timer = setInterval(() => this.flush(), WINDOW_MS);
    this.#timer.unref();
  }

  stop(): void {
    if (this.#timer !== null) clearInterval(this.#timer);
    this.#timer = null;
    this.flush(true);
  }

  #prune(currentHour: number): void {
    for (const hour of this.#hours.keys()) if (hour <= currentHour - 24) this.#hours.delete(hour);
  }
}
