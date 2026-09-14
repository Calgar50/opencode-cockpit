// Autorités de certification d'entreprise (certs/*.pem|*.crt, montés en lecture seule) ajoutées à celles de Node pour les
// appels sortants du cockpit (GitHub, Copilot) derrière un proxy qui inspecte le HTTPS. La vérification TLS reste active.
import { X509Certificate } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import tls from "node:tls";
import { errorMessage } from "./log.ts";

const BLOCK = /-----BEGIN CERTIFICATE-----[A-Za-z0-9+/=\s]+-----END CERTIFICATE-----/g;

export interface TrustResult {
  files: number;
  certificates: number;
  /** Blocs illisibles ignorés (certificat mal formé). */
  rejected: number;
  error: string | null;
}

/** Blocs CERTIFICATE valides d'un fichier PEM (jamais une clé privée). */
export function certificateBlocks(text: string): { valid: string[]; rejected: number } {
  const valid: string[] = [];
  let rejected = 0;
  for (const block of text.match(BLOCK) ?? []) {
    try {
      new X509Certificate(block);
      valid.push(block);
    } catch {
      rejected++;
    }
  }
  return { valid, rejected };
}

/** Ajoute les certificats du dossier aux autorités par défaut de Node (fetch et https compris). Dossier absent : rien. */
export function trustCorporateCertificates(dir: string): TrustResult {
  let names: string[];
  try {
    names = fs
      .readdirSync(dir)
      .filter((name) => /\.(pem|crt)$/i.test(name))
      .sort();
  } catch {
    return { files: 0, certificates: 0, rejected: 0, error: null };
  }
  const extra: string[] = [];
  let files = 0;
  let rejected = 0;
  for (const name of names) {
    let text: string;
    try {
      text = fs.readFileSync(path.join(dir, name), "utf8");
    } catch (err) {
      return { files, certificates: 0, rejected, error: `${name} illisible : ${errorMessage(err)}` };
    }
    const blocks = certificateBlocks(text);
    rejected += blocks.rejected;
    if (blocks.valid.length > 0) {
      files++;
      extra.push(...blocks.valid);
    }
  }
  if (extra.length === 0) return { files, certificates: 0, rejected, error: null };
  try {
    tls.setDefaultCACertificates([...new Set([...tls.getCACertificates("default"), ...extra])]);
    return { files, certificates: extra.length, rejected, error: null };
  } catch (err) {
    return { files, certificates: 0, rejected, error: errorMessage(err) };
  }
}
