// Propriétaire : L5d.
// Démonstration enregistrée (spécification §5.9, §5.7.4, §6 l.1064, JP-9 ; plan d'exécution, fiche L5d) : la capture réelle p1
// (deux délégations lancées par une même réponse), rejouée pas à pas dans la même scene(t) que le direct et dessinée par
// NeonCarte et NeonTableau de la bande (L5c). Ouverte par [Voir une démonstration] de la bande (ActivityRegion).
// - Aucune IA appelée, aucune requête : les faits viennent de demo-p1.json, livré avec l'interface et généré par
//   server/test-support/gen-demo.ts depuis factsFromEvent(p1). Ce module n'importe ni l'API, ni le proxy, ni fetch, et ne prend
//   de la bande que NeonCarte et NeonTableau, qui ne lisent rien (demo-p1.test.ts, examen statique des imports).
// - Pas à pas : curseur des moments (←/→, Début, Fin), [Moment précédent], [Moment suivant] puis [Recommencer]. Aucune lecture
//   automatique, aucune boucle (web-animations.test.ts) ; les transitions (WAAPI, environ 900 ms, seulement sous
//   prefers-reduced-motion: no-preference) sont celles de NeonCarte.
// - Mode Simple : la délégation y est refusée (décision n° 4). La scène est calculée en mode Avancé, pour dessiner les deux
//   assistants, puis montrée avec le vocabulaire du mode Simple ; le lecteur le dit (P3) : « Enregistrée en mode Avancé. En mode
//   Simple, l'IA ne délègue pas : elle continue seule. »
// - Accessibilité : boîte de dialogue (Modal) nommée par l'étiquette, curseur focalisé à l'ouverture et valeur dite
//   « Moment n sur N, … » ; [Tableau] montre la même scène en tableau ; aucune région aria-live ajoutée (une seule par page).
// Composant interne : ses propriétés restent libres pour son propriétaire.
import { useId, useMemo, useState } from "react";
import { factProblem } from "../../../../server/shared/activity-facts.ts";
import type { ActivityFact } from "../../../../server/shared/activity-types.ts";
import { TEXTES as TEXTES_DELEGATION } from "../../../../server/shared/delegation-texts.ts";
import { resumeBande } from "../../../../server/shared/neon-band.ts";
import { moments, type NeonScene, scene } from "../../../../server/shared/neon-scene.ts";
import { remplir, TEXTES } from "../../../../server/shared/neon-texts.ts";
import { Modal } from "../../../components/ui.tsx";
import { formatDuration } from "../../../lib/format.ts";
import demo from "./demo-p1.json" with { type: "json" };
import { NeonCarte, NeonTableau } from "./NeonBand.tsx";

export interface DemoPlayerProps {
  /** Mode de l'utilisateur : en mode Simple, vocabulaire du mode Simple et avis sur la délégation. */
  advanced: boolean;
  onClose: () => void;
}

/** Faits de la démonstration ; un fait refusé par la garde des faits (texte, secret) est écarté, jamais montré. */
const FAITS: readonly ActivityFact[] = (demo.faits as readonly unknown[]).filter((fait): fait is ActivityFact => factProblem(fait) === null);
const ETAPES_LUES = (demo.etapes as readonly unknown[]).filter((t): t is number => typeof t === "number" && Number.isFinite(t));
/** Étapes du lecteur : moments où le dessin change (gen-demo.ts) ; à défaut, tous les moments. */
const ETAPES: readonly number[] = ETAPES_LUES.length > 0 ? ETAPES_LUES : moments(FAITS);
const DEBUT = FAITS[0]?.at ?? 0;
const T = TEXTES.partout.lecteur;

/**
 * Scène d'une étape : calculée en mode Avancé (les deux assistants sont dessinés) ; en mode Simple, montrée avec son vocabulaire.
 * Le mode d'une scène ne choisit que des textes dans NeonCarte et NeonTableau (carnet, marques d'origine, légende du tableau).
 */
function vueDuLecteur(t: number | null, advanced: boolean): NeonScene {
  const vue = scene(FAITS, t, { zoom: 2, mode: "avance" });
  return advanced ? vue : { ...vue, mode: "simple" };
}

export function DemoPlayer({ advanced, onClose }: DemoPlayerProps) {
  const curseurId = useId();
  const [rang, setRang] = useState(0);
  const [tableau, setTableau] = useState(false);
  const total = ETAPES.length;
  const t = ETAPES[rang] ?? null;
  const vue = useMemo(() => vueDuLecteur(t, advanced), [t, advanced]);
  const dernier = rang >= total - 1;
  const duree = formatDuration(Math.max(0, (t ?? DEBUT) - DEBUT));
  const aller = (cible: number) => setRang(Math.min(Math.max(cible, 0), Math.max(total - 1, 0)));

  return (
    <Modal open title={TEXTES.partout.demonstrationEnregistree} onClose={onClose} wide>
      <div className="neon-band">
        <div className="neon-head">
          <h3 className="neon-title">{T.titre}</h3>
          {/* Résumé d'une ligne : seulement à 400 px, où la carte laisse la place (neon.css). */}
          <p className="neon-summary is-deplie">{resumeBande(vue)}</p>
        </div>
        {advanced ? null : <p className="neon-note">{`${TEXTES.simple.demonstrationAvancee} ${TEXTES_DELEGATION.simple.avis}`}</p>}
        {/* Premier élément focalisable de la boîte : le curseur (Modal le focalise à l'ouverture). */}
        <div className="row wrap">
          <label htmlFor={curseurId} className="small tabular">
            {remplir(T.moment, { n: rang + 1, total })}
          </label>
          <input
            id={curseurId}
            type="range"
            min={1}
            max={Math.max(total, 1)}
            step={1}
            value={rang + 1}
            aria-valuetext={remplir(T.momentAccessible, { n: rang + 1, total, duree })}
            onChange={(event) => aller(Number(event.currentTarget.value) - 1)}
          />
          <span className="small muted tabular">{remplir(T.depuisDebut, { duree })}</span>
          <button type="button" className="btn sm" disabled={rang === 0} onClick={() => aller(rang - 1)}>
            {T.precedent}
          </button>
          <button type="button" className="btn sm" onClick={() => aller(dernier ? 0 : rang + 1)}>
            {dernier ? T.recommencer : T.suivant}
          </button>
          <button type="button" className="btn sm ghost" aria-pressed={tableau} onClick={() => setTableau((v) => !v)}>
            {TEXTES.partout.commandes.tableau}
          </button>
        </div>
        <div className="neon-body">{tableau ? <NeonTableau vue={vue} /> : <NeonCarte vue={vue} />}</div>
      </div>
    </Modal>
  );
}
