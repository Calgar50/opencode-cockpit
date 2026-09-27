// Propriétaire : L45b.
// Contrôle SQL LOCAL de l'exemple « Revue SQL sur réplica » (conception C §12.1 ; plan d'exécution it5, fiche L45b ; D-5-25 :
// ce contrôle est toujours livré, même sans le bloc facultatif de l'exemple).
//
// Module PUR et SANS AUCUN IMPORT (règle de pureté de core.test.ts) : il ne lit rien, n'écrit rien et n'appelle aucune IA. Il
// répond à une seule question, celle que la feuille de lancement pose avant tout envoi : « la demande contient-elle un mot SQL
// qui écrit ? ». La réponse est affichée telle quelle, jamais transformée en jugement : le cockpit ne dit pas que la requête
// écrit, il dit ce qu'il a repéré, et la synthèse de l'équipe le signalera en premier.
//
// Ce que le contrôle NE fait PAS (P3, honnêteté) : il n'analyse pas le SQL, ne suit pas les procédures appelées, ne lit pas les
// chaînes de caractères et ne remplace aucune relecture. Un mot absent ne veut pas dire « aucune écriture ».
//
// H4 (itération 4) ne fournit rien de tel : la table de correspondance de FE4 le dit expressément (« sqlWriteKeywords n'existe
// pas dans H4 »), d'où ce fichier neuf plutôt qu'une réutilisation.

/**
 * Mots SQL qui écrivent, dans l'ordre où ils sont annoncés. `EXEC` couvre l'appel d'une procédure, dont le cockpit ne sait rien :
 * il est repéré par prudence, comme un mot qui peut écrire.
 */
export const SQL_WRITE_KEYWORDS: readonly string[] = Object.freeze([
  "INSERT",
  "UPDATE",
  "DELETE",
  "MERGE",
  "TRUNCATE",
  "DROP",
  "ALTER",
  "CREATE",
  "EXEC",
]);

/**
 * Caractères qui font partie d'un identifiant SQL : un mot repéré ne doit être ni précédé ni suivi de l'un d'eux, sinon
 * `UPDATED_AT`, `CREATED_BY` ou `sp_droplogin` passeraient pour des écritures.
 */
const IDENT = "A-Za-z0-9_$";

/**
 * Un mot entier, casse ignorée. Les bornes sont écrites à la main plutôt qu'avec `\b` : `$` fait partie des identifiants de
 * plusieurs bases (`CREATE$`), et `\b` le traiterait comme une séparation.
 */
const MOT_RE = new RegExp(`(?<![${IDENT}])(?:${SQL_WRITE_KEYWORDS.join("|")})(?![${IDENT}])`, "giu");

/**
 * Texte privé de ses commentaires SQL : `-- …` jusqu'à la fin de la ligne et `/* … *\/` (non terminé : jusqu'à la fin). Chaque
 * commentaire devient une espace, pour que deux mots séparés par un commentaire ne se collent pas.
 */
function sansCommentaires(text: string): string {
  let out = "";
  for (let i = 0; i < text.length; ) {
    if (text.startsWith("--", i)) {
      const fin = text.indexOf("\n", i);
      out += " ";
      i = fin === -1 ? text.length : fin;
    } else if (text.startsWith("/*", i)) {
      const fin = text.indexOf("*/", i + 2);
      out += " ";
      i = fin === -1 ? text.length : fin + 2;
    } else {
      out += text[i];
      i++;
    }
  }
  return out;
}

/**
 * Mots d'écriture repérés dans un texte, EN MAJUSCULES, sans doublon, dans leur ordre d'apparition. Les commentaires SQL sont
 * ignorés ; la casse ne compte pas ; seuls des mots entiers sont repérés (`UPDATED_AT` n'en est pas un).
 *
 * Fonction PURE : même texte, même liste, sans aucun effet ni aucun appel d'IA.
 */
export function sqlWriteKeywords(text: string): string[] {
  if (typeof text !== "string" || text === "") return [];
  const propre = sansCommentaires(text);
  const vus = new Set<string>();
  const out: string[] = [];
  for (const trouve of propre.matchAll(MOT_RE)) {
    const mot = trouve[0].toUpperCase();
    if (vus.has(mot)) continue;
    vus.add(mot);
    out.push(mot);
  }
  return out;
}
