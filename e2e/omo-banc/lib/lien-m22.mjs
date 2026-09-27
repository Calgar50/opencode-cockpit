// Lien AUTOMATIQUE entre la mesure M22 du banc et les constantes d'`app/server/omo-compose.test.ts` (reste R-2 de la clôture 2 bis).
//
// Le défaut que ce module ferme : les constantes M22 du test (mémoire et processus au maximum, qui dimensionnent `mem_limit` et
// `pids_limit` du compose) étaient RECOPIÉES À LA MAIN depuis un rapport de banc. La dérive était silencieuse, et elle a eu lieu
// (516,7 Mio dans le test pendant qu'un rejeu relevait 547,2 Mio). Le garde-fou de S3 (6385c92) refuse une constante sous le
// dernier relevé PUBLIÉ ; il ne voit pas un relevé qui n'a pas été publié.
//
// Le lien est posé du côté où la dérive naît : le banc. Après la porte G1 (seule à publier `M22`, sous charge), `run-banc.mjs`
// écrit `g1-stats.json` (déjà fait par la porte) et relit les constantes dans le SOURCE du test ; un relevé qui les dépasse rend
// le lien ROUGE, avec la ligne à corriger. Des constantes introuvables (renommées, déplacées) le rendent rouge aussi : un lien
// rompu ne passe jamais pour un lien tenu. Le test unitaire, lui, ne dépend d'aucun banc : il vérifie cette lecture et ce
// jugement sur le vrai fichier (`app/server/omo-banc-complet.test.ts`).
//
// Pur : aucune entrée-sortie ici, l'appelant lit les fichiers. Aucune dépendance npm (P8).

/** Fichier des constantes, relatif à la racine du dépôt. */
export const FICHIER_CONSTANTES_M22 = "app/server/omo-compose.test.ts";

const nombre = (source, nom) => {
  const m = new RegExp(`\\bconst ${nom} = (\\d+(?:\\.\\d+)?);`).exec(source);
  return m === null ? null : Number(m[1]);
};

/**
 * Constantes M22 lues dans le source du test : `MEM_MAX_MIO`, `PIDS_MAX`, `M22_MEM_RELEVE_MAX_PUBLIE`. Rend null si l'une manque :
 * le lien ne devine jamais une valeur.
 */
export function constantesM22(source) {
  const memMaxMio = nombre(String(source ?? ""), "MEM_MAX_MIO");
  const pidsMax = nombre(String(source ?? ""), "PIDS_MAX");
  const releveMaxPublie = nombre(String(source ?? ""), "M22_MEM_RELEVE_MAX_PUBLIE");
  if (memMaxMio === null || pidsMax === null || releveMaxPublie === null) return null;
  return { memMaxMio, pidsMax, releveMaxPublie };
}

/**
 * Juge un relevé M22 (`bilan.mesures.M22` de la porte G1 : `memoireMioMax`, `pidsMax`) contre les constantes. Rend `{ ok, points }`
 * au format des portes du banc. Un relevé absent ou mal formé n'est jamais « vert » : il n'y a rien eu à relier.
 */
export function jugerLienM22(m22, constantes) {
  const points = [];
  if (constantes === null) {
    points.push({ nom: "constantes M22 lues dans omo-compose.test.ts", ok: false, detail: "MEM_MAX_MIO, PIDS_MAX ou M22_MEM_RELEVE_MAX_PUBLIE introuvable : lien rompu" });
    return { ok: false, points };
  }
  const mem = m22?.memoireMioMax;
  const pids = m22?.pidsMax;
  if (typeof mem !== "number" || !Number.isFinite(mem) || typeof pids !== "number" || !Number.isFinite(pids)) {
    points.push({ nom: "relevé M22 de la porte G1", ok: false, detail: "relevé absent ou mal formé : rien à relier" });
    return { ok: false, points };
  }
  const memOk = mem <= constantes.memMaxMio;
  points.push({
    nom: "M22 : la mémoire relevée sous charge ne dépasse pas MEM_MAX_MIO",
    ok: memOk,
    detail: memOk
      ? `${mem} Mio ≤ ${constantes.memMaxMio} Mio`
      : `${mem} Mio > ${constantes.memMaxMio} Mio : remonter MEM_MAX_MIO ET M22_MEM_RELEVE_MAX_PUBLIE à ${mem} dans ${FICHIER_CONSTANTES_M22}, puis revoir mem_limit (deux fois le maximum)`,
  });
  const pidsOk = pids <= constantes.pidsMax;
  points.push({
    nom: "M22 : les processus relevés sous charge ne dépassent pas PIDS_MAX",
    ok: pidsOk,
    detail: pidsOk ? `${pids} ≤ ${constantes.pidsMax}` : `${pids} > ${constantes.pidsMax} : remonter PIDS_MAX à ${pids} dans ${FICHIER_CONSTANTES_M22}, puis revoir pids_limit (cinq fois le maximum)`,
  });
  return { ok: memOk && pidsOk, points };
}
