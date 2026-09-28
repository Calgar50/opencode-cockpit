// Lecture commune de la documentation par les tests (refonte du README, 1.1.0). La documentation de l'utilisateur est
// README.md (porte d'entrée) et docs/GUIDE.md (procédures P-, fiches R-, pannes X-, explications E-) ; docs/DEVELOPPEMENT.md
// s'y ajoute pour les réglages du serveur de développement. Les tests vérifient les mots, pas l'espace typographique :
// CRLF ramené à LF, espaces insécables (U+00A0, U+202F) ramenées à l'espace ordinaire. Retiré de l'image par app/Dockerfile.
// Ce fichier n'écrit aucune balise de la construction d'un seul tenant : construction-balises.test.ts les chercherait ici.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

/** Racine du dépôt (app/server/test-support → dépôt). */
export const DEPOT = path.join(import.meta.dirname, "..", "..", "..");

/** Documentation de l'utilisateur, dans l'ordre de lecture. */
export const DOCS_UTILISATEUR: readonly string[] = ["README.md", "docs/GUIDE.md"];

const INSECABLES = new RegExp(`[${String.fromCharCode(0xa0)}${String.fromCharCode(0x202f)}]`, "g");

/** Un document du dépôt (chemin relatif, barres obliques) : CRLF → LF, espaces insécables → espace. */
export function lireDoc(relatif: string): string {
  return fs.readFileSync(path.join(DEPOT, ...relatif.split("/")), "utf8").replace(/\r\n/g, "\n").replace(INSECABLES, " ");
}

/** Plusieurs documents joints par une ligne vide. Chacun équilibre ses sections [3d] et c5, donc la jonction aussi. */
export function lireDocumentation(docs: readonly string[] = DOCS_UTILISATEUR): string {
  return docs.map(lireDoc).join("\n\n");
}

/** Blancs réduits à une espace. */
export const compact = (texte: string): string => texte.replace(/\s+/g, " ");

/** Nombre d'occurrences exactes de `phrase`. */
export const occurrences = (texte: string, phrase: string): number => texte.split(phrase).length - 1;

const echapper = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Sous-section « ### titre » ou « ### P-nn titre » (identifiant stable du guide), jusqu'au titre suivant de niveau 1 à 3.
 * Une seule occurrence est exigée : un doublon mot pour mot entre README et guide fait échouer, et c'est voulu.
 */
export function sousSection(texte: string, titre: string): string {
  const lignes = texte.split("\n");
  const avecId = new RegExp(`^### [PRXE]-\\d{2} ${echapper(titre)}$`);
  const debuts = lignes.flatMap((l, i) => (l.trim() === `### ${titre}` || avecId.test(l.trim()) ? [i] : []));
  assert.equal(debuts.length, 1, `sous-section « ${titre} » : ${debuts.length} trouvée(s), une seule attendue`);
  const debut = debuts[0] as number;
  const fin = lignes.findIndex((l, i) => i > debut && /^#{1,3} /.test(l));
  return lignes.slice(debut, fin < 0 ? undefined : fin).join("\n");
}

/** Section balisée de la construction (une seule par nom). Balises assemblées en deux morceaux. */
export function sectionBalisee(texte: string, nom: string): string {
  const prefixe = "c5" + ":";
  const ouvre = `<!-- ${prefixe}${nom} -->`;
  const ferme = `<!-- /${prefixe}${nom} -->`;
  const debut = texte.indexOf(ouvre);
  assert.ok(debut >= 0 && texte.indexOf(ouvre, debut + 1) < 0, `section ${prefixe}${nom} absente ou en double`);
  const fin = texte.indexOf(ferme, debut);
  assert.ok(fin > debut, `section ${prefixe}${nom} mal fermée`);
  return texte.slice(debut, fin);
}

/** La ligne qui commence par `debut` : une seule exigée. */
export function entree(texte: string, debut: string): string {
  const lignes = texte.split("\n").filter((l) => l.startsWith(debut));
  assert.equal(lignes.length, 1, `entrée « ${debut} » : ${lignes.length} trouvée(s), une seule attendue`);
  return lignes[0] as string;
}
