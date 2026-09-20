// Sol quadrillé de la salle de contrôle 3D (itération 3, L29b ; spécification §5.8 l.995 « sol quadrillé par shader » ; plan it3
// D-3d-17, D-3d-05).
// Une `PlaneGeometry` et un `ShaderMaterial` : le quadrillage est dessiné par le nuanceur, au jeton `grille` sur le jeton `fond`
// de la palette, et s'éteint doucement vers le bord pour que le plan n'ait pas de limite visible.
// Les deux sources GLSL sont des constantes de ce module, ÉCRITES EN ENTIER : aucune chaîne n'est construite à l'exécution (ni
// substitution de gabarit, ni concaténation), et rien n'est compilé par `new Function` ni par `eval(` — la garde du build de L32
// échoue sur ces formes (D-3d-06). Ce qui change d'un thème à l'autre passe par des uniformes, jamais par le texte du nuanceur.
// Le plan est décrit dans son propre plan XY puis COUCHÉ par la rotation de l'objet, jamais par une rotation de la géométrie :
// l'attribut `position` lu par le nuanceur garde ainsi les coordonnées du quadrillage.
// Le sol est du décor : il ne porte aucun fait (P12). Aucun texte affiché.
import { Color, DoubleSide, Mesh, PlaneGeometry, ShaderMaterial, Vector3 } from "three";
import type { NeonPalette } from "../../../../server/shared/neon-palette.ts";
import { TAILLES } from "./formes.ts";

/** Nuanceur de sommets : le quadrillage se calcule dans le plan local, que la rotation de l'objet couche ensuite. */
export const SOL_VERTEX = `
varying vec2 vPlan;

void main() {
  vPlan = position.xy;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

/** Nuanceur de fragments : deux familles de traits, épaisseur constante, extinction vers le bord. */
export const SOL_FRAGMENT = `
precision mediump float;

uniform vec3 uFond;
uniform vec3 uGrille;
uniform float uPas;
uniform float uEpaisseur;
uniform float uRayon;

varying vec2 vPlan;

void main() {
  vec2 ecart = abs(fract(vPlan / uPas - 0.5) - 0.5) * uPas;
  float trait = 1.0 - smoothstep(uEpaisseur * 0.5, uEpaisseur, min(ecart.x, ecart.y));
  float fondu = 1.0 - smoothstep(uRayon * 0.55, uRayon, length(vPlan));
  gl_FragColor = vec4(mix(uFond, uGrille, trait * fondu), 1.0);
}
`;

/** Épaisseur d'un trait du quadrillage, en unités du monde. */
export const EPAISSEUR_GRILLE = 0.07;

/** Sol livré au graphe : l'objet à poser dans la scène et ses deux ressources, que le registre du graphe libère. */
export interface Sol {
  objet: Mesh;
  geometrie: PlaneGeometry;
  materiau: ShaderMaterial;
}

/** Sol carré de `TAILLES.solCote`, quadrillé au pas `TAILLES.solPas`, aux couleurs de la palette donnée. */
export function creerSol(palette: NeonPalette): Sol {
  const geometrie = new PlaneGeometry(TAILLES.solCote, TAILLES.solCote, 1, 1);
  const materiau = new ShaderMaterial({
    uniforms: {
      uFond: { value: new Color(palette.fond) },
      uGrille: { value: new Color(palette.grille) },
      uPas: { value: TAILLES.solPas },
      uEpaisseur: { value: EPAISSEUR_GRILLE },
      uRayon: { value: TAILLES.solCote / 2 },
    },
    vertexShader: SOL_VERTEX,
    fragmentShader: SOL_FRAGMENT,
    side: DoubleSide,
    depthWrite: true,
  });
  const objet = new Mesh(geometrie, materiau);
  objet.name = "sol";
  objet.quaternion.setFromAxisAngle(new Vector3(1, 0, 0), -Math.PI / 2);
  objet.renderOrder = -1;
  objet.frustumCulled = false;
  return { objet, geometrie, materiau };
}
