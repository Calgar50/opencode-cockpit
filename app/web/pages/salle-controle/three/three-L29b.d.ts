// Déclarations de three dont le graphe a besoin en plus de three.d.ts (itération 3, L29b ; plan it3 D-3d-04, décision Q2 (a)).
// Un paquet qui a besoin d'une déclaration de plus ajoute son propre fichier : les déclarations d'un module ambiant fusionnent, et
// une interface au nom d'une classe déclarée ailleurs ajoute des membres à cette classe sans la redéclarer. three.d.ts (L32) n'est
// donc pas modifié. three-exports.test.ts contrôle ce fichier comme les autres (un seul bloc `declare module "three"`, sans `any`).
// Deux besoins, tous deux tirés de la mesure MX-3D (M3D-5) :
// - `InstancedMesh.dispose()` : sans cet appel, 5 tampons WebGL (instanceMatrix, instanceColor) restent vivants alors que
//   `renderer.info.memory` affiche 0/0 ;
// - `Sprite.geometry` : three partage UNE géométrie entre tous les `Sprite` ; le registre du graphe la libère une seule fois.
declare module "three" {
  export interface InstancedMesh {
    /** Libère les tampons d'instances ; ne touche ni à la géométrie ni au matériau (M3D-5). */
    dispose(): void;
  }

  export interface Sprite {
    /** Géométrie partagée par tous les `Sprite` de three : une seule libération pour toute la scène (M3D-5). */
    readonly geometry: BufferGeometry;
  }
}
