// Propriétaire : L29c.
// Moteur three de la salle de contrôle (spécification §5.8 l.996, D-3d-17, D-3d-28) : caméra, rendu à la demande, boucle d'images
// seulement quand le plan s'anime, libération complète. Chargé seulement par ../moteur-chargeur.ts (import dynamique). Seuls les
// fichiers de ce dossier importent "three" (D-3d-05). Squelette T3d-a : aucun import de three ; la fabrique rend null (la page
// reste en 2D, comme sur un contexte WebGL refusé).
import type { CreerMoteur } from "../slots-3d.ts";

export const creerMoteur: CreerMoteur = () => null;
