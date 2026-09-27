// Propriétaire : L28b.
// Entrée de « Revoir » depuis les Archives et le zoom 1 (spécification §5.9 l.1018-1024) : [Revoir cette demande] seulement si
// l'accès est donné (GET /api/revoir/:rootId?etat=1, lu au montage). Seule API : ../../../lib/api-salle3d.ts (lecture). Propriétés
// figées dans ../slots-3d.ts.
// - accès donné : [Revoir cette demande], qui ouvre RevoirDialog (L28c) par son contrat RevoirDialogProps ;
// - « salle-demande-en-cours » : RIEN n'est affiché. Une demande en cours n'est jamais proposée, et rien n'annonce une commande à
//   venir (P3 : jamais une fonction montrée comme disponible) ;
// - « salle-fin-inconnue » : la phrase du refus (revoir-texts.partout.refus), qui dit que la demande ne peut pas être revue pour le
//   moment, sans inventer de cause ;
// - racine inconnue, lecture impossible (réseau, 4xx) ou état non encore lu : rien.
// Aucune animation, aucune minuterie, aucun requestAnimationFrame (salle3d-animations.test.ts).
import { useEffect, useState } from "react";
import { libelleRefus, TEXTES } from "../../../../server/shared/revoir-texts.ts";
import type { RevoirEtatResponse } from "../../../../server/shared/salle3d-types.ts";
import { salle3dApi } from "../../../lib/api-salle3d.ts";
import type { RevoirEntreeProps } from "../slots-3d.ts";
import { RevoirDialog } from "./RevoirDialog.tsx";

export function RevoirEntree({ rootId, placement }: RevoirEntreeProps) {
  const [etat, setEtat] = useState<RevoirEtatResponse | null>(null);
  const [ouvert, setOuvert] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    setEtat(null);
    setOuvert(false);
    salle3dApi.revoirEtat(rootId, controller.signal).then(
      (reponse) => {
        if (!controller.signal.aborted) setEtat(reponse);
      },
      (err: unknown) => {
        if (controller.signal.aborted) return;
        // Lecture impossible : aucune entrée proposée, jamais un accès supposé (fermé en cas de doute).
        console.warn("« Revoir » : lecture de l'accès impossible", err);
        setEtat(null);
      },
    );
    return () => controller.abort();
  }, [rootId]);

  if (etat === null) return null;
  if (!etat.acces) {
    if (etat.raison !== "salle-fin-inconnue") return null;
    return (
      <p className={`revoir-entree revoir-entree-refus is-${placement}`} data-placement={placement}>
        {libelleRefus(etat.raison)}
      </p>
    );
  }
  // Un bloc, jamais un paragraphe : la boîte de dialogue de « Revoir » (L28c) y monte son propre contenu.
  return (
    <div className={`revoir-entree is-${placement}`} data-placement={placement}>
      <button type="button" className="btn sm" onClick={() => setOuvert(true)}>
        {TEXTES.partout.revoir}
      </button>
      <RevoirDialog rootId={rootId} ouvert={ouvert} onFermer={() => setOuvert(false)} />
    </div>
  );
}
