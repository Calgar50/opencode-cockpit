// Propriétaire : L39o.
// Onglet « Salle OMO » de la carte des assistants (spécification §5.2 l.892, §7.8 l.1185, P11 l.46, P2 ; plan d'exécution it4,
// fiche L39o ; plan it5 §8.7 ; fiche-fusion-v106 §7). Monté par CarteTab.tsx en mode AVANCÉ seulement (section l39o:salle-omo) :
// en mode Simple, l'onglet n'est ni proposé ni monté, et rien n'est demandé à la salle.
// - Agents de l'instance de la salle, lus par le serveur (GET /api/agent-map?instance=omo, recherche d'agents de la salle) : des
//   noms et des rôles, en LECTURE SEULE — aucun bouton qui agit, aucune écriture.
// - Libellés calculés par le serveur (shared/agent-map-omo.ts) : nom du rôle pris dans les textes de la salle (secteurs de
//   neon-texts.ts), puis la clé de configuration entre parenthèses. AUCUNE chaîne de rôle n'est écrite ici (contrôle de source
//   dans agent-map-omo.test.ts).
// - Salle coupée (409 salle-coupee, tant que SALLE_OUVERTE est faux ou COCKPIT_OMO=off) : état « Salle coupée », phrase de la
//   salle (etats.coupee d'omo-room-texts.ts). Tout autre refus : phrase de la carte (agentMapError).
// Aucun texte écrit ici : agent-map-texts.ts (section l39o:salle-omo) et omo-room-texts.ts. Aucune animation, aucun raccourci
// clavier, aucun focus pris.
import { useId } from "react";
import { TEXTES } from "../../../../server/shared/agent-map-texts.ts";
import { TEXTES as TEXTES_SALLE } from "../../../../server/shared/omo-room-texts.ts";
import { Spinner, useAsync } from "../../../components/ui.tsx";
import { agentMapApi, agentMapError, estSalleCoupee } from "../../../lib/api-agent-map.ts";

const P = TEXTES.partout;
const S = TEXTES.avance.salle;

export interface ChoixCarteProps {
  /** Vrai : l'onglet « Salle OMO » est montré ; faux : la carte de l'instance principale. */
  salle: boolean;
  onChoisir(salle: boolean): void;
}

/**
 * Boutons de l'onglet : la carte de l'instance principale ou les agents de la salle. Même forme que le choix de vue de la carte
 * (groupe nommé, aria-pressed, bordure et texte gras pour le bouton enfoncé, contraste forcé de carte.css).
 */
export function ChoixCarte({ salle, onChoisir }: ChoixCarteProps) {
  return (
    <div className="ca-vues-choix" role="group" aria-label={S.choix}>
      <button type="button" className="btn" aria-pressed={!salle} onClick={() => onChoisir(false)}>
        {P.titre}
      </button>
      <button type="button" className="btn" aria-pressed={salle} onClick={() => onChoisir(true)}>
        {S.onglet}
      </button>
    </div>
  );
}

export interface CarteSalleOmoProps {
  /** Dossier de la conversation ; null : lecture globale de la salle (aucun dossier transmis). */
  directory: string | null;
}

export function CarteSalleOmo({ directory }: CarteSalleOmoProps) {
  const titreId = useId();
  const { data, error, loading } = useAsync(() => agentMapApi.salle({ directory }), [directory]);
  const coupee = data === null && estSalleCoupee(error);
  return (
    <section className="stack" aria-labelledby={titreId}>
      <h3 id={titreId} className="ca-titre">
        {S.onglet}
      </h3>
      <p className="ca-intro">{S.intro}</p>
      {loading && data === null ? <Spinner label={S.onglet} /> : null}
      {coupee ? (
        <p className="callout ca-etat-vide" role="status">
          {TEXTES_SALLE.avance.etats.coupee}
        </p>
      ) : null}
      {coupee || error === null || data !== null ? null : (
        <p className="callout critical ca-erreur" role="alert">
          {agentMapError(error)}
        </p>
      )}
      {data === null ? null : data.agents.length === 0 ? (
        <p className="ca-vide">{S.aucun}</p>
      ) : (
        <ul className="ca-liens">
          {data.agents.map((agent) => (
            <li key={agent.cle} className="ca-section">
              <span className="ca-tete-nom">{agent.libelle}</span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
