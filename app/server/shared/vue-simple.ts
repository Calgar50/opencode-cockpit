// Vocabulaire du mode Simple pour une scène néon (spécification §5.9 l.1018-1024, §2.3 l.102-104 ; plan d'exécution it3, fiche
// L28c, D-3d-12, D-3d-20 ; décision de l'utilisateur n° 7) : « Revoir » d'une racine de la Salle OMO calcule la scène en mode
// Avancé, pour DESSINER toutes les délégations, puis la montre avec le vocabulaire du mode Simple.
// - modeSceneRevoir : « avance » pour une racine de la salle (décision n° 7 : sinon la carte n'aurait qu'un nœud et la demande
//   ne serait pas compréhensible), sinon le mode de l'utilisateur (différé = direct de la bande 2D).
// - nomsSimples puis vueSimple : le champ `agent` de chaque nœud à renommer est remplacé, et `vue.mode` devient « simple », donc
//   tous les libellés (titre, stations, origines, tableau) sont ceux du mode Simple. NeonCarte et NeonTableau lisent les noms par
//   nomAssistant et libelleNoeud (neon-band.ts) : aucun nom de rôle de la salle n'atteint l'écran, ni « agent », ni
//   « orchestrateur » (§2.3 l.104).
// - P12 : rien d'autre n'est touché ; positions, faisceaux, attentes, décisions et `faits` de chaque signe sont recopiés tels
//   quels, donc chaque signe dessiné garde le fait qui le justifie.
// Aucune chaîne affichable (D-3d-21, prouvé par textes-3d.test.ts) : les noms viennent de revoir-texts.ts et de neon-texts.ts.
// Module pur (server/shared) : aucun module node, aucun accès à l'environnement, ni horloge ni aléa.
import type { NeonMode, NeonNode, NeonScene, NeonSector } from "./neon-scene.ts";
import { libelleSecteur } from "./neon-texts.ts";
import { TEXTES } from "./revoir-texts.ts";

/** Secteur d'un nœud dessiné hors du centre ; un nœud sans secteur (jamais produit par scene()) tombe dans « Autres ». */
const SECTEUR_PAR_DEFAUT: NeonSector = "autres";

/** Contexte d'une scène de « Revoir » : racine de la Salle OMO, et mode choisi par l'utilisateur. */
export interface ModeRevoirOptions {
  salle: boolean;
  advanced: boolean;
}

/**
 * Mode à donner à scene() pour « Revoir » (D-3d-12). Une racine de la Salle OMO est toujours calculée en « avance », pour que
 * toutes les délégations soient dessinées (décision n° 7) ; elle est ensuite renommée par vueSimple quand l'utilisateur est en
 * mode Simple. Une racine ordinaire garde le mode de l'utilisateur : le différé montre exactement ce que la bande 2D montre.
 */
export function modeSceneRevoir({ salle, advanced }: ModeRevoirOptions): NeonMode {
  if (salle) return "avance";
  return advanced ? "avance" : "simple";
}

/** Nom Simple d'un nœud : « Assistant principal » au centre, le libellé de son secteur ailleurs. */
function nomSimple(noeud: Pick<NeonNode, "role" | "secteur">): string {
  if (noeud.role === "conversation") return TEXTES.simple.assistantPrincipal;
  return libelleSecteur(noeud.secteur ?? SECTEUR_PAR_DEFAUT);
}

/**
 * Noms Simples des nœuds à renommer (D-3d-20), par identifiant de session.
 * - Racine de la Salle OMO (`salle`) : TOUS les nœuds sont renommés. Les noms de rôle de la salle (ceux de l'extension) sont
 *   réservés au mode Avancé et ne doivent jamais atteindre l'écran en mode Simple (§5.9 l.1022, §2.3 l.104).
 * - Ailleurs : carte vide, donc aucun renommage. Les noms des assistants du cockpit sont ceux que la bande 2D montre déjà en mode
 *   Simple (nomAssistant, neon-band.ts) ; les remplacer tromperait sur qui a travaillé (P3).
 */
export function nomsSimples(vue: NeonScene, salle: boolean): Map<string, string> {
  const noms = new Map<string, string>();
  if (!salle) return noms;
  for (const noeud of vue.noeuds) noms.set(noeud.sessionId, nomSimple(noeud));
  return noms;
}

/**
 * Scène montrée avec le vocabulaire du mode Simple : `agent` remplacé pour chaque nœud nommé par `noms`, `mode` à « simple ».
 * Tout le reste est recopié tel quel — zoom, racine, stations, secteurs, positions, faisceaux, attentes, décisions, impulsions,
 * origines, arrêt, détail et les `faits` de chaque signe (P12). Un nœud absent de `noms` garde son nom.
 */
export function vueSimple(vue: NeonScene, noms: ReadonlyMap<string, string>): NeonScene {
  return {
    ...vue,
    mode: "simple",
    noeuds: vue.noeuds.map((noeud) => {
      const nom = noms.get(noeud.sessionId);
      return nom === undefined ? noeud : { ...noeud, agent: nom };
    }),
  };
}
