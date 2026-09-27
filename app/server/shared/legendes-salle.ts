// Légendes de la Salle OMO (spécification §5.7.3 l.971-973, §5.8 l.999-1002 ; JP-3, JP-5, JP-6 ; plan d'exécution it3, fiche
// L3s-a) : prédicats lus sur la FORME des faits de la salle (L25a), branchés par legendes.ts pour les racines de la salle.
// - tacheDeFond : consigne envoyée dans la salle avec `fond: true` (clé écrite par consigneOmo d'activity-facts.ts : l'outil
//   `task` de l'extension lancé avec run_in_background). Hors de la salle, la clé `fond` n'existe pas : jamais vrai.
// - carnetTouche : fait `carnet` bien formé (JP-6) — un assistant a lu ou modifié le carnet partagé ou un plan —, avec les mêmes
//   règles que la station « Carnet partagé et plan » de neon-scene.ts : chemin relatif sous `.omo/notepads/` ou `.omo/plans/`, sans
//   remontée ni barre finale, clé de fichier de 16 chiffres hexadécimaux. Un fait mal formé n'est pas une tuile, donc pas une
//   légende (P12 : aucune phrase sur un signe qui n'est pas dessiné).
// Aucune chaîne affichable (D-3d-21) : seulement des codes ASCII en minuscules ; les phrases sont dans legendes-texts.ts. Contrôle
// de source dans croisements-3d-salle.test.ts (lexique de textes.test.ts).
// Module pur (server/shared) : aucun module node, aucun accès à l'environnement, ni horloge ni aléa.
import type { ActivityFact } from "./activity-types.ts";

/** Chemin relatif du carnet ou d'un plan, comme neon-scene.ts (CARNET_CHEMIN_RE) et activity-facts.ts (carnetChemin). */
const CARNET_CHEMIN_RE = /^\.omo\/(?:notepads|plans)\/[A-Za-z0-9_./-]{1,90}$/;
/** Clé de fichier (pathKey d'activity-facts.ts). */
const CLE_FICHIER_RE = /^[0-9a-f]{16}$/;

/** Vrai pour une consigne confiée en tâche de fond dans la salle (JP-3) : fait `consigne` envoyé, clé `fond` à vrai. */
export function tacheDeFond(fait: ActivityFact): boolean {
  return fait.kind === "consigne" && fait.data.etat === "envoyee" && fait.data.fond === true;
}

/** État d'un fait `carnet` bien formé (JP-6) : « lu » ou « modifie » ; null pour tout autre fait, ou un carnet mal formé. */
export function carnetTouche(fait: ActivityFact): "lu" | "modifie" | null {
  if (fait.kind !== "carnet") return null;
  const { etat, chemin, fichier } = fait.data;
  if (etat !== "lu" && etat !== "modifie") return null;
  if (typeof chemin !== "string" || !CARNET_CHEMIN_RE.test(chemin) || chemin.endsWith("/") || chemin.split("/").includes("..")) return null;
  if (typeof fichier !== "string" || !CLE_FICHIER_RE.test(fichier)) return null;
  return etat;
}
