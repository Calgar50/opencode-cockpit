// Autorité et certificat de banc (L21, MO-9) : de quoi faire croire à opencode qu'il parle à `api.githubcopilot.com`.
//
// Tout est fabriqué dans un conteneur JETABLE, sans réseau (`--network none`), avec l'openssl de l'image : rien n'est installé
// sur la machine, et la clé privée ne sort jamais du dossier du banc, hors du dépôt.
//
// Durée : 2 jours. Un certificat de banc ne doit pas survivre au banc ; s'il traîne, il périme tout seul.
// La vérification TLS n'est JAMAIS coupée : c'est l'autorité de banc, jointe au faisceau par `NODE_EXTRA_CA_CERTS`, qui fait
// passer la vérification. Aucune variable « insecure » n'est employée nulle part dans ce banc.
//
// Aucune dépendance npm (P8).
import fs from "node:fs";
import path from "node:path";
import { dockerOuEchec } from "./verrou.mjs";

/** Noms servis par le certificat du faux fournisseur : les trois adresses d'API que le proxy de sortie sait autoriser. */
export const NOMS_COPILOT = Object.freeze(["api.githubcopilot.com", "api.business.githubcopilot.com", "api.enterprise.githubcopilot.com"]);

const SCRIPT = [
  "set -eu",
  "umask 077",
  "cd /certs-out",
  'openssl req -x509 -newkey rsa:2048 -nodes -sha256 -days 2 -keyout ca.key -out ca.pem -subj "/CN=Banc OMO (sal11) autorite jetable" -addext "basicConstraints=critical,CA:TRUE,pathlen:0" -addext "keyUsage=critical,keyCertSign,cRLSign" >/dev/null 2>&1',
  'openssl req -newkey rsa:2048 -nodes -sha256 -keyout serveur.key -out serveur.csr -subj "/CN=api.githubcopilot.com" >/dev/null 2>&1',
  `printf '%s\\n' "subjectAltName=${NOMS_COPILOT.map((n) => `DNS:${n}`).join(",")}" "extendedKeyUsage=serverAuth" "basicConstraints=critical,CA:FALSE" > ext.cnf`,
  "openssl x509 -req -in serveur.csr -CA ca.pem -CAkey ca.key -CAcreateserial -days 2 -sha256 -extfile ext.cnf -out serveur.pem >/dev/null 2>&1",
  "rm -f serveur.csr ca.srl",
  "chmod 0644 ca.pem serveur.pem",
  "chmod 0644 serveur.key",
  "openssl x509 -in serveur.pem -noout -subject -issuer -ext subjectAltName",
].join("; ");

/**
 * Fabrique `ca.pem`, `ca.key`, `serveur.pem` et `serveur.key` dans `dossier`. Rend le relevé openssl du certificat servi,
 * qui entre au journal de la porte G1 (preuve que le nom d'hôte détourné est bien celui du certificat).
 */
export async function fabriquerCertificats(dossier, image) {
  fs.mkdirSync(dossier, { recursive: true });
  for (const nom of ["ca.pem", "ca.key", "serveur.pem", "serveur.key", "ext.cnf"]) {
    fs.rmSync(path.join(dossier, nom), { force: true });
  }
  const r = await dockerOuEchec([
    "run",
    "--rm",
    "--network",
    "none",
    "--cap-drop",
    "ALL",
    "--security-opt",
    "no-new-privileges:true",
    "--user",
    "0:0",
    "--volume",
    `${dossier.replace(/\\/g, "/")}:/certs-out`,
    "--entrypoint",
    "sh",
    image,
    "-c",
    SCRIPT,
  ]);
  for (const nom of ["ca.pem", "serveur.pem", "serveur.key"]) {
    const chemin = path.join(dossier, nom);
    if (!fs.existsSync(chemin) || fs.statSync(chemin).size < 400) throw new Error(`Certificat de banc non produit : ${nom}`);
  }
  // La clé de l'autorité ne sert plus : elle disparaît avant même que le banc démarre.
  fs.rmSync(path.join(dossier, "ca.key"), { force: true });
  return String(r.sortie).trim();
}
