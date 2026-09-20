// Propriétaire : L28b.
// Commandes 3d de la bande néon (spécification §5.7.4 l.985) : [Revoir cette demande] et [Ouvrir la salle de contrôle], montées par
// une section [3d] de NeonBand.tsx. Seule API : ../../../lib/api-salle3d.ts (lecture) ; aucune requête n'est faite ici : la boîte de
// dialogue « Revoir » (L28c) lit elle-même, à son ouverture. Propriétés figées dans ../slots-3d.ts.
// - [Revoir cette demande] ouvre RevoirDialog par son contrat RevoirDialogProps (jamais par son implémentation, §2.3 du plan it3) ;
//   « Revoir » ne monte jamais la bande (D-3d-12).
// - [Ouvrir la salle de contrôle] n'est offert que si le poste sait dessiner en 3D : verdictCapacites (L30), SANS sonde, et
//   préférence du poste différente de « 2d » (spéc. l.985, D-3d-25). Les capacités du navigateur ne changent pas d'un affichage à
//   l'autre : elles sont lues une seule fois par onglet ; la préférence est relue à chaque montage.
// - Aucun bouton pour une racine de la Salle OMO en mode Simple : la salle y est réservée au mode Avancé et sa bande n'est pas
//   montrée ; « Revoir » y passe par les Archives et le zoom 1 (RevoirEntree), derrière GET /api/revoir/:rootId?etat=1.
// Aucune animation, aucune minuterie, aucun requestAnimationFrame (salle3d-animations.test.ts).
import { useMemo, useState } from "react";
import type { ActivityFact } from "../../../../server/shared/activity-types.ts";
import { type CapacitesNavigateur, verdictCapacites } from "../../../../server/shared/fluidity.ts";
import { TEXTES as TEXTES_REVOIR } from "../../../../server/shared/revoir-texts.ts";
import { TEXTES as TEXTES_SALLE } from "../../../../server/shared/salle3d-texts.ts";
import { navigate } from "../../../lib/router.ts";
import { capacites, preferenceLocale } from "../fluidite.ts";
import type { BandCommands3dProps } from "../slots-3d.ts";
import { RevoirDialog } from "./RevoirDialog.tsx";

/** Capacités du navigateur : lues une seule fois par onglet (un contexte webgl2 jetable par lecture, D-3d-18). */
let capacitesLues: CapacitesNavigateur | null = null;

function capacitesDuPoste(): CapacitesNavigateur {
  capacitesLues ??= capacites();
  return capacitesLues;
}

/**
 * Racine servie par la Salle OMO, d'après les faits de la conversation : le fait `statut` de la racine porte son `instance`
 * (activity-facts.ts). Aucun fait ne la dit : instance principale, comme la bande le suppose déjà.
 */
export function racineDeLaSalle(facts: readonly ActivityFact[], rootId: string): boolean {
  return facts.some((fait) => fait.sessionId === rootId && fait.data.instance === "omo");
}

export function BandCommands3d({ rootId, facts, advanced }: BandCommands3dProps) {
  const [ouvert, setOuvert] = useState(false);
  const salleEnSimple = !advanced && racineDeLaSalle(facts, rootId);
  // Sans sonde : le verdict des seules capacités du poste, préférence comprise (spéc. l.985) ; aucun contexte webgl2 demandé quand
  // aucune commande n'est offerte.
  const vue3d = useMemo(() => {
    if (salleEnSimple) return false;
    const preference = preferenceLocale().choix;
    return preference !== "2d" && verdictCapacites({ ...capacitesDuPoste(), preference }).mode === "3d";
  }, [salleEnSimple]);
  if (salleEnSimple) return null;
  return (
    <>
      <button type="button" className="btn sm ghost" onClick={() => setOuvert(true)}>
        {TEXTES_REVOIR.partout.revoir}
      </button>
      {vue3d ? (
        <button type="button" className="btn sm ghost" onClick={() => navigate("salle-controle", rootId)}>
          {TEXTES_SALLE.partout.ouvrir}
        </button>
      ) : null}
      <RevoirDialog rootId={rootId} ouvert={ouvert} onFermer={() => setOuvert(false)} />
    </>
  );
}
