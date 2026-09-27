// « Déroulé partiel » d'une scène bornée (spécification §3.10 l.356 : « 3 niveaux et 50 sessions au plus (au-delà : « Déroulé
// partiel ») » ; revue F1, décision A36 point 1 ; itération « 3s », L3s-a). Au-delà de NEON_PROFONDEUR_MAX niveaux ou de
// NEON_SESSIONS_MAX assistants (neon-scene.ts), la scène ne dessine pas le surplus et le compte dans `horsBornes`. Le zoom 2 de la
// salle de contrôle (en 3D comme en repli 2D) et « Revoir » le disent en toutes lettres, avec la phrase de la bande
// (texteHorsBornes de neon-texts.ts, singulier compris : la même que NeonBand.tsx). Cette note est DISTINCTE de « Déroulé
// partiel » des faits partiels (borne du magasin, `partial`), que chaque écran garde à côté.
// Un paragraphe statique : aucune région aria-live (une seule par page, D-3d-29), aucune animation ; la classe est celle de la
// note voisine de l'écran qui le monte (zoom-conv-note, revoir-note), aucune feuille de style ajoutée.
import { texteHorsBornes } from "../../../server/shared/neon-texts.ts";

export interface DeroulePartielProps {
  /** Assistants non dessinés de la scène montrée (`NeonScene.horsBornes`) ; 0 : rien n'est rendu. */
  horsBornes: number;
  /** Classe de la note voisine de l'écran qui monte ce composant. */
  className: string;
}

export function DeroulePartiel({ horsBornes, className }: DeroulePartielProps) {
  return horsBornes > 0 ? <p className={className}>{texteHorsBornes(horsBornes)}</p> : null;
}
