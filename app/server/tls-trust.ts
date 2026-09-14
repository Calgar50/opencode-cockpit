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
  /** Entrées ignorées ou chargement refusé, sans aucun contenu de certificat. */
  errors: string[];
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

/**
 * Ajoute les certificats du dossier aux autorités par défaut de Node (fetch et https compris). Dossier absent : rien. Une
 * entrée illisible est signalée sans écarter les autres certificats.
 */
export function trustCorporateCertificates(dir: string): TrustResult {
  let names: string[];
  try {
    names = fs
      .readdirSync(dir)
      .filter((name) => /\.(pem|crt)$/i.test(name))
      .sort();
  } catch (err) {
    const missing = (err as { code?: unknown }).code === "ENOENT";
    return { files: 0, certificates: 0, rejected: 0, errors: missing ? [] : [`dossier des certificats illisible : ${errorMessage(err)}`] };
  }
  const extra: string[] = [];
  const errors: string[] = [];
  let files = 0;
  let rejected = 0;
  for (const name of names) {
    const file = path.join(dir, name);
    try {
      if (!fs.statSync(file).isFile()) {
        errors.push(`${name} : n'est pas un fichier`);
        continue;
      }
      const blocks = certificateBlocks(fs.readFileSync(file, "utf8"));
      rejected += blocks.rejected;
      if (blocks.valid.length > 0) {
        files++;
        extra.push(...blocks.valid);
      }
    } catch (err) {
      errors.push(`${name} illisible : ${errorMessage(err)}`);
    }
  }
  if (extra.length === 0) return { files, certificates: 0, rejected, errors };
  try {
    tls.setDefaultCACertificates([...new Set([...tls.getCACertificates("default"), ...extra])]);
    return { files, certificates: extra.length, rejected, errors };
  } catch (err) {
    return { files, certificates: 0, rejected, errors: [...errors, `chargement refusé par Node : ${errorMessage(err)}`] };
  }
}
