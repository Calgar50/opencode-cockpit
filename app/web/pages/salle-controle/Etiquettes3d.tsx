// Propriétaire : L29d.
// Étiquettes DOM posées au-dessus du canevas 3D (spécification §5.8 l.996-998 : « étiquettes DOM superposées, focalisables,
// 60 au plus », « canvas aria-hidden ; la vérité est la liste et le tableau ; un vrai bouton par nœud » ; §5.5 l.923-924 ;
// plan d'exécution it3, fiche L29d, D-3d-19). Composant HORS de three/, sans aucun import de three, pas même en `import type`
// (D-3d-05) : il ne connaît du moteur que `projeter`, passé par Scene3d.
// - Un <button> par étiquette, dans l'ordre de tabulation décidé par etiquettes-3d.ts (priorité du plan, jamais la position à
//   l'écran), 60 au plus ; son nom accessible vient de libelleBouton, rendu en NŒUD DE TEXTE : jamais de HTML brut, un nom
//   d'assistant venu d'un sous-assistant n'est donc jamais interprété (XSS ; garde de revoir-lecture-seule.test.ts).
// - Replacement à chaque image rendue (`onImage` du moteur, relayé par `abonnerImage`) : les styles sont écrits directement sur
//   les boutons déjà posés, sans nouvelle image React — la caméra bouge à 60 images par seconde, le DOM ne se reconstruit pas.
//   AUCUNE requestAnimationFrame, AUCUNE setInterval ici (salle3d-animations.test.ts) : les images viennent du moteur.
// - Fond OPAQUE au jeton `fond` et texte au jeton `texte` de la palette néon : ces deux jetons tiennent 4,5:1 par construction
//   (NEON_TEXTES, script couleurs de neon-palette.ts), donc le texte reste lisible par-dessus n'importe quel endroit de la scène.
// - Aucune région aria-live (une seule par page, D-3d-29) et aucune animation : rien ne bouge hors des positions, qui suivent le
//   moteur.
import { type CSSProperties, useCallback, useLayoutEffect, useMemo, useRef } from "react";
import { NEON_PALETTES, type NeonTheme } from "../../../server/shared/neon-palette.ts";
import type { Plan3dLabel, Point3 } from "../../../server/shared/salle3d-types.ts";
import { etiquettesAffichees, type PositionEcran, styleEtiquette } from "./etiquettes-3d.ts";

export interface Etiquettes3dProps {
  /** Étiquettes du plan, dans l'ordre du producteur ; l'ordre de tabulation est refait ici (D-3d-19). */
  etiquettes: readonly Plan3dLabel[];
  theme: NeonTheme;
  /** Position à l'écran d'un point du plan (Moteur.projeter) ; hors champ tant que le moteur n'existe pas. */
  projeter(point: Point3): PositionEcran;
  /** Abonnement aux images rendues par le moteur (`onImage`) ; rend le retrait de l'abonnement. */
  abonnerImage(replacer: () => void): () => void;
  /** Étiquette activée : identifiant du nœud, du territoire ou de la station (Scene3dProps.onSelect). */
  onSelect(id: string): void;
}

/** Calque des étiquettes : au-dessus du canevas, transparent aux clics ; seuls les boutons en reçoivent. */
const CALQUE: CSSProperties = { position: "absolute", inset: 0, overflow: "hidden", pointerEvents: "none" };

/**
 * Bouton d'étiquette : placé par `left`/`top` (écrits par le moteur à chaque image), centré sur son point, masqué tant qu'aucune
 * image n'a été rendue. React ne réécrit jamais ces trois propriétés, dont les valeurs ne changent pas d'une image React à
 * l'autre : le placement direct tient.
 */
const BOUTON: CSSProperties = {
  position: "absolute",
  left: 0,
  top: 0,
  visibility: "hidden",
  transform: "translate(-50%, -50%)",
  pointerEvents: "auto",
  maxWidth: "16rem",
  padding: "0.15rem 0.45rem",
  borderRadius: "0.35rem",
  border: "1px solid currentColor",
  font: "inherit",
  fontSize: "0.75rem",
  lineHeight: 1.3,
  whiteSpace: "nowrap",
  overflow: "hidden",
  textOverflow: "ellipsis",
  cursor: "pointer",
};

export function Etiquettes3d({ etiquettes, theme, projeter, abonnerImage, onSelect }: Etiquettes3dProps) {
  const affichees = useMemo(() => etiquettesAffichees(etiquettes), [etiquettes]);
  const boutons = useRef(new Map<string, HTMLButtonElement>());

  const replacer = useCallback(() => {
    for (const etiquette of affichees) {
      const bouton = boutons.current.get(etiquette.id);
      if (bouton === undefined) continue;
      const style = styleEtiquette(projeter(etiquette.position));
      bouton.style.left = style.left;
      bouton.style.top = style.top;
      bouton.style.visibility = style.visibility;
    }
  }, [affichees, projeter]);

  useLayoutEffect(() => {
    // Placement tout de suite (le plan a pu changer sans nouvelle image), puis à chaque image du moteur.
    replacer();
    return abonnerImage(replacer);
  }, [replacer, abonnerImage]);

  const palette = NEON_PALETTES[theme];
  const { fond, texte: couleurDuTexte } = palette;
  return (
    <div className="salle3d-etiquettes" style={CALQUE}>
      {affichees.map((etiquette) => (
        <button
          key={etiquette.id}
          ref={(element) => {
            if (element === null) boutons.current.delete(etiquette.id);
            else boutons.current.set(etiquette.id, element);
          }}
          type="button"
          className="salle3d-etiquette"
          style={{ ...BOUTON, background: fond, color: couleurDuTexte }}
          onClick={() => onSelect(etiquette.cible)}
        >
          {etiquette.libelle}
        </button>
      ))}
    </div>
  );
}
