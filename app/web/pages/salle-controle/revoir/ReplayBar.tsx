// Propriétaire : L28c.
// Barre du lecteur de « Revoir » (spécification §5.8 l.998, §5.5 l.917-924, §5.6 l.928 ; plan d'exécution it3, fiche L28c,
// D-3d-11) : moments, « Lire » / « Figer ici », pas à pas, vitesses, badge. Propriétés FIGÉES dans ../slots-3d.ts.
// - role="toolbar" nommée par la commande qui l'ouvre ; un seul élément de la barre est dans l'ordre de tabulation par défaut du
//   navigateur, aucun raccourci à une touche hors composant focalisé (§5.5 l.917) : ←, →, Début et Fin déplacent le curseur des
//   moments SEULEMENT quand il a le focus (clavier natif du curseur, aucun écouteur sur la fenêtre).
// - Curseur des moments : role="slider" avec aria-valuenow, aria-valuemax et aria-valuetext = momentsAria (« Moment 4 sur 12,
//   10:42:07 »), étiquette visible « 4 / 12 ».
// - Vocabulaire (D-3d-11) : « Lire » et « Figer ici », jamais « pause » (réservé aux équipes) ni « Arrêter » (réservé à l'arrêt
//   de la conversation). Tous les textes viennent de revoir-texts.ts (T3d-b).
// - « Suivre l'action » n'est proposé que si la page le passe (3D et différé seulement) ; « Revenir au direct » seulement si
//   onDirect est passé.
// Aucune requête, aucune animation : le mouvement de la barre est nul (revoir.css).
import { useId } from "react";
import { remplir } from "../../../../server/shared/neon-texts.ts";
import { VITESSES } from "../../../../server/shared/revoir.ts";
import { formatHeure, formatVitesse, libelleBadge, libelleRaccourci, TEXTES } from "../../../../server/shared/revoir-texts.ts";
import type { ReplaySpeed } from "../../../../server/shared/salle3d-types.ts";
import type { ReplayBarProps } from "../slots-3d.ts";
import "./revoir.css";

const T = TEXTES.partout;

/** Décalage du fuseau du poste à appliquer à un instant (l'opposé de getTimezoneOffset, comme l'attend formatHeure). */
const decalageLocal = (ms: number): number => -new Date(ms).getTimezoneOffset();

export function ReplayBar({
  index,
  total,
  heure,
  vitesse,
  lecture,
  direct,
  raccourciMs,
  suivre,
  onLire,
  onFiger,
  onPrecedent,
  onSuivant,
  onAller,
  onVitesse,
  onDirect,
  onSuivre,
}: ReplayBarProps) {
  const curseurId = useId();
  const vitesseId = useId();
  const max = Math.max(total, 1);
  const rang = Math.min(Math.max(index + 1, 1), max);
  const instant = heure ?? 0;
  const texteHeure = formatHeure(instant, decalageLocal(instant));
  const badge = libelleBadge(direct ? { etat: "direct" } : { etat: "differe", vitesse, heure: instant }, decalageLocal(instant));

  return (
    <div className="revoir-bar" role="toolbar" aria-label={T.revoir}>
      <p className="revoir-badge" data-etat={direct ? "direct" : "differe"}>
        {badge}
      </p>
      <label className="revoir-moments tabular" htmlFor={curseurId}>
        {remplir(T.moments, { n: rang, total: max })}
      </label>
      {/* Curseur natif : ←, →, Début et Fin n'agissent que lorsqu'il a le focus (§5.5 l.917). */}
      <input
        id={curseurId}
        className="revoir-curseur"
        type="range"
        role="slider"
        min={1}
        max={max}
        step={1}
        value={rang}
        aria-valuenow={rang}
        aria-valuemax={max}
        aria-valuetext={remplir(T.momentsAria, { n: rang, total: max, heure: texteHeure })}
        onChange={(event) => onAller(Number(event.currentTarget.value) - 1)}
      />
      <div className="revoir-commandes">
        <button type="button" className="btn sm" onClick={lecture ? onFiger : onLire}>
          {lecture ? T.figer : T.lire}
        </button>
        <button type="button" className="btn sm" onClick={onPrecedent} disabled={rang <= 1}>
          {T.precedent}
        </button>
        <button type="button" className="btn sm" onClick={onSuivant} disabled={rang >= max}>
          {T.suivant}
        </button>
        <label className="revoir-vitesse" htmlFor={vitesseId}>
          {T.vitesse}
        </label>
        <select id={vitesseId} className="select sm" value={String(vitesse)} onChange={(event) => onVitesse(Number(event.currentTarget.value) as ReplaySpeed)}>
          {VITESSES.map((v) => (
            <option key={v} value={String(v)}>
              {formatVitesse(v)}
            </option>
          ))}
        </select>
        {suivre === null || onSuivre === undefined ? null : (
          <button type="button" className="btn sm ghost" aria-pressed={suivre} onClick={() => onSuivre(!suivre)}>
            {T.suivre}
          </button>
        )}
        {onDirect === undefined ? null : (
          <button type="button" className="btn sm ghost" onClick={onDirect}>
            {T.revenirDirect}
          </button>
        )}
      </div>
      {raccourciMs === null ? null : <p className="revoir-raccourci">{libelleRaccourci(raccourciMs)}</p>}
    </div>
  );
}
