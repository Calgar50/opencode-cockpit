// Propriétaire : L29c.
// Seule frontière vers ./three/ (D-3d-05, JP-11) : import dynamique, donc three reste dans un morceau paresseux, jamais atteint
// statiquement depuis une entrée (garde du build, D-3d-06). Aucun autre fichier de web/ n'importe un fichier de ./three/ ; les
// `import type` restent permis partout.
import type { CreerMoteur } from "./slots-3d.ts";

export async function chargerMoteur(): Promise<{ creerMoteur: CreerMoteur }> {
  const module = await import("./three/moteur.ts");
  return { creerMoteur: module.creerMoteur };
}
