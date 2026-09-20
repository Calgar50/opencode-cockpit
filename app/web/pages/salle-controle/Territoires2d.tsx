// Propriétaire : L31b.
// Repli 2D du zoom 1 (spécification §5.8 l.993 et l.1009, §5.6 l.928 ; plan d'exécution it3, fiche L31b) : mini-carte des
// territoires hexagonaux, dessinée à partir du MÊME plan que la 3D (D-3d-16), donc aux mêmes places.
// La carte est une image : `aria-hidden`, jamais focalisable. La vérité reste la liste en grille de boutons (P7, §5.8 l.1009) ;
// rien d'affiché ici qui n'y soit aussi. Aucun texte, aucune animation, aucune image demandée.
import { NEON_PALETTES, type NeonTheme } from "../../../server/shared/neon-palette.ts";
import type { Plan3d, Plan3dTerritoire, Point3 } from "../../../server/shared/salle3d-types.ts";

/** Marge autour des plaques, en unités de la scène. */
const MARGE = 1.6;
/** Rayon des pastilles de station. */
const RAYON_STATION = 0.45;

/** Hexagone à sommet plat centré sur (x, z) : la plaque du plan vue de dessus. */
function hexagone(centre: Point3, rayon: number): string {
  const points: string[] = [];
  for (let i = 0; i < 6; i += 1) {
    const angle = (Math.PI / 3) * i;
    points.push(`${(centre.x + rayon * Math.cos(angle)).toFixed(3)},${(centre.z + rayon * Math.sin(angle)).toFixed(3)}`);
  }
  return points.join(" ");
}

/** Couleur d'une plaque : la même grammaire que la liste (on y travaille, on y attend un accord, ou rien de vérifié). */
function jetonTerritoire(territoire: Plan3dTerritoire): "acteur" | "attente" | "extension" | "territoire" {
  if (territoire.enceinte) return "extension";
  const { travaillent, attendent } = territoire.compteurs;
  if (typeof travaillent === "number" && travaillent > 0) return "acteur";
  if (attendent > 0) return "attente";
  return "territoire";
}

export function Territoires2d({ plan, theme }: { plan: Plan3d; theme: NeonTheme }) {
  const palette = NEON_PALETTES[theme];
  const points = [...plan.territoires.map((t) => t.centre), ...plan.stations.map((s) => s.position)];
  const xs = points.map((p) => p.x);
  const zs = points.map((p) => p.z);
  const minX = (xs.length > 0 ? Math.min(...xs) : 0) - MARGE;
  const minZ = (zs.length > 0 ? Math.min(...zs) : 0) - MARGE;
  const largeur = Math.max((xs.length > 0 ? Math.max(...xs) : 0) + MARGE - minX, 1);
  const hauteur = Math.max((zs.length > 0 ? Math.max(...zs) : 0) + MARGE - minZ, 1);

  return (
    <svg
      className="salle3d-carte2d"
      aria-hidden="true"
      focusable="false"
      viewBox={`${minX.toFixed(3)} ${minZ.toFixed(3)} ${largeur.toFixed(3)} ${hauteur.toFixed(3)}`}
      preserveAspectRatio="xMidYMid meet"
    >
      <rect x={minX} y={minZ} width={largeur} height={hauteur} fill={palette.fond} />
      {plan.territoires.map((territoire) => (
        <polygon
          key={territoire.id}
          points={hexagone(territoire.centre, territoire.rayon)}
          fill={palette.grille}
          stroke={palette[jetonTerritoire(territoire)]}
          strokeWidth={0.09}
          strokeDasharray={territoire.enceinte ? "0.3 0.18" : undefined}
        />
      ))}
      {plan.stations.map((station) => (
        <circle
          key={station.id}
          cx={station.position.x}
          cy={station.position.z}
          r={RAYON_STATION}
          fill={palette.grille}
          stroke={station.id === "vous" ? palette.vous : palette.texteDiscret}
          strokeWidth={0.09}
        />
      ))}
    </svg>
  );
}
