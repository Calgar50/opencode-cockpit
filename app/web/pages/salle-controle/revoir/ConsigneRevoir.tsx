// Propriétaire : L28d.
// Consigne gardée localement, relue dans « Revoir » (U2, D-3d-30) : texte en nœud de texte, mention de troncature ; seule requête
// par ../../../lib/api-salle3d.ts, jamais à opencode. Propriétés figées dans ../slots-3d.ts.
// UNE seule requête, au montage : la consigne d'un appel (`cible: {callId}`) ou toutes les consignes gardées d'une session
// (`cible: {enfant}`, étape d'équipe relue en plusieurs tours). Rien n'est redemandé à l'IA : le cockpit lit sa propre copie.
// Le texte vient d'un sous-assistant : rendu en NŒUD DE TEXTE par React (jamais dangerouslySetInnerHTML, jamais du Markdown), dans
// un <pre> défilant. Aucune région aria-live (D-3d-29 : la page n'en a qu'une) ; aucune animation.
import { useEffect, useId, useState } from "react";
import { CONSIGNES, pointsDeCode } from "../../../../server/shared/consignes.ts";
import { remplir } from "../../../../server/shared/neon-texts.ts";
import { libelleConsigneAbsente, libelleConsigneTronquee, libelleRefus, TEXTES } from "../../../../server/shared/revoir-texts.ts";
import type { RevoirConsigneResponse, RevoirRefus } from "../../../../server/shared/salle3d-types.ts";
import { Button } from "../../../components/ui.tsx";
import { salle3dApi } from "../../../lib/api-salle3d.ts";
import { ApiError } from "../../../lib/api.ts";
import type { ConsigneRevoirProps } from "../slots-3d.ts";
import "./consigne-revoir.css";

const REFUS = new Set<string>(Object.keys(TEXTES.partout.refus));

type Etat =
  | { etat: "chargement" }
  | { etat: "pret"; consignes: RevoirConsigneResponse[] }
  /** Aucune copie gardée (404), ou conversation fermée à « Revoir » (403) : une phrase, jamais une cause inventée. */
  | { etat: "sans"; phrase: string };

/** 404 « consigne-absente » : phrase `absente`. Refus de « Revoir » : sa phrase. Autre échec : phrase neutre. */
function echec(err: unknown): Etat {
  if (err instanceof ApiError && REFUS.has(err.code)) return { etat: "sans", phrase: libelleRefus(err.code as RevoirRefus) };
  if (err instanceof ApiError && err.status === 404) return { etat: "sans", phrase: libelleConsigneAbsente(CONSIGNES.parRacine) };
  return { etat: "sans", phrase: TEXTES.partout.refusInconnu };
}

export function ConsigneRevoir({ rootId, cible, onFermer }: ConsigneRevoirProps) {
  const c = TEXTES.partout.consigne;
  const titreId = useId();
  const [charge, setCharge] = useState<Etat>({ etat: "chargement" });
  const callId = "callId" in cible ? cible.callId : null;
  const enfant = "enfant" in cible ? cible.enfant : null;

  useEffect(() => {
    const controller = new AbortController();
    setCharge({ etat: "chargement" });
    const lecture =
      callId === null
        ? salle3dApi.revoirConsignesEnfant(rootId, enfant ?? "", controller.signal).then((r) => r.consignes)
        : salle3dApi.revoirConsigne(rootId, callId, controller.signal).then((consigne) => [consigne]);
    lecture.then(
      (consignes) => {
        if (controller.signal.aborted) return;
        setCharge(consignes.length > 0 ? { etat: "pret", consignes } : { etat: "sans", phrase: libelleConsigneAbsente(CONSIGNES.parRacine) });
      },
      (err: unknown) => {
        if (!controller.signal.aborted) setCharge(echec(err));
      },
    );
    return () => controller.abort();
  }, [rootId, callId, enfant]);

  const total = charge.etat === "pret" ? charge.consignes.length : 0;

  return (
    <section className="consigne-revoir" aria-labelledby={titreId}>
      <h3 id={titreId} className="consigne-revoir-titre">
        {c.titre}
      </h3>
      <p className="consigne-revoir-copie">{c.copie}</p>
      {/* Phrase simple, sans indicateur animé ni région d'annonces : la page n'en a qu'une (D-3d-29). */}
      {charge.etat === "chargement" ? <p className="consigne-revoir-etat">{c.chargement}</p> : null}
      {charge.etat === "sans" ? <p className="consigne-revoir-etat">{charge.phrase}</p> : null}
      {charge.etat === "pret"
        ? charge.consignes.map((consigne, index) => (
            <article className="consigne-revoir-bloc" key={`${consigne.callId}/${consigne.at}`}>
              {total > 1 ? <h4 className="consigne-revoir-sous-titre">{remplir(c.titrePlusieurs, { n: index + 1, total })}</h4> : null}
              {/* Texte d'un sous-assistant : nœud de texte, jamais du HTML ni du Markdown. */}
              <pre className="consigne-revoir-texte">{consigne.texte}</pre>
              {consigne.tronque ? <p className="consigne-revoir-tronquee">{libelleConsigneTronquee(pointsDeCode(consigne.texte), consigne.longueur)}</p> : null}
            </article>
          ))
        : null}
      <p className="consigne-revoir-actions">
        <Button size="sm" onClick={onFermer}>
          {c.fermer}
        </Button>
      </p>
    </section>
  );
}
