// Propriétaire : L28c.
// Légende conditionnelle (spécification §5.8 l.999-1002, §5.5 l.920, §5.7.1 l.935 ; JP-5, JP-6 ; plan d'exécution it3, fiche
// L28c, D-3d-29) : 1 ou 2 phrases choisies par legendes.ts (L28a) et écrites par legendes-texts.ts (T3d-b), avec [Pourquoi ?] et
// [Voir la consigne]. Propriétés FIGÉES dans ../slots-3d.ts.
// - [Pourquoi ?] dévoile la leçon centrale (JP-6), et sa phrase de la Salle OMO (« carnet partagé et plan ») pour une racine de
//   la salle.
// - [Voir la consigne] n'apparaît que si l'appelant passe onVoirConsigne : « Revoir » le passe quand la légende porte un callId
//   (copie gardée par le cockpit, U2), le zoom 3 de la salle de contrôle aussi ; une démonstration ne le passe JAMAIS (aucune
//   consigne gardée, D-3d-26).
// - Annonces : par la région UNIQUE de la page (useAnnouncer, réglage ui.activityAnnouncements, D-3d-29), jamais une région
//   aria-live à elle. Le texte dit vient de la fonction pure annonceLegende (./annonces-revoir.ts).
// Aucune requête : ce composant ne lit ni la conversation, ni opencode.
import { useEffect, useId, useState } from "react";
import { phrasesLegende, TEXTES } from "../../../../server/shared/legendes-texts.ts";
import { useApp } from "../../../app/AppContext.tsx";
import { useAnnouncer } from "../../../lib/announcer.ts";
import type { LegendeBulleProps } from "../slots-3d.ts";
import { annonceLegende } from "./annonces-revoir.ts";
import "./revoir.css";

export function LegendeBulle({ cles, salle, mode, onVoirConsigne }: LegendeBulleProps) {
  const { ui } = useApp();
  const say = useAnnouncer(ui.activityAnnouncements);
  const leconId = useId();
  const [pourquoi, setPourquoi] = useState(false);
  const phrases = phrasesLegende(cles, mode);
  const annonce = annonceLegende(cles, mode);

  // Transition seulement : une légende qui vient d'apparaître est dite une fois, au plus une annonce toutes les 2 s (announcer).
  useEffect(() => {
    if (annonce !== "") say(annonce);
  }, [annonce, say]);

  if (phrases.length === 0) return null;
  return (
    <div className="revoir-legende">
      {phrases.map((phrase) => (
        <p key={phrase} className="revoir-legende-phrase">
          {phrase}
        </p>
      ))}
      <div className="revoir-legende-commandes">
        <button type="button" className="btn sm ghost" aria-expanded={pourquoi} aria-controls={leconId} onClick={() => setPourquoi((ouvert) => !ouvert)}>
          {TEXTES.partout.pourquoi}
        </button>
        {onVoirConsigne === undefined ? null : (
          <button type="button" className="btn sm ghost" onClick={onVoirConsigne}>
            {TEXTES.partout.voirConsigne}
          </button>
        )}
      </div>
      <div id={leconId} hidden={!pourquoi} className="revoir-legende-lecon">
        <p>{TEXTES.partout.lecon}</p>
        {salle ? <p>{TEXTES.partout.leconSalle}</p> : null}
      </div>
    </div>
  );
}
