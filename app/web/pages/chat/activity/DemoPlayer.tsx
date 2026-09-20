// Propriétaire : L34 (salle de contrôle 3D) ; livré par L5d à l'itération 1.
// Démonstrations enregistrées (spécification §5.9 l.1013-1017, §5.7.4, §6 l.1064, JP-9 ; plan d'exécution it3, fiche L34,
// D-3d-20, D-3d-26, D-3d-30 ; décision U1) : trois suites de faits livrées avec l'interface, rejouées sur le lecteur COMPLET de
// « Revoir » (L28c). Ouvert par [Voir une démonstration] de la bande (ActivityRegion).
// - « Deux assistants en même temps » : la capture réelle p1 (demo-p1.json, gen-demo.ts de L5d, lus et jamais modifiés) ;
//   « Attente de votre accord » et « Arrêt au plafond » : les deux fichiers de demos/, suites scriptées sur le faux opencode
//   (server/test-support/gen-demos-it3.ts, D-3d-26).
// - AUCUNE IA appelée, AUCUNE requête : ce module n'importe ni l'API, ni le proxy, ni fetch, et ne prend de la bande que
//   NeonCarte et NeonTableau, qui ne lisent rien (demo-p1.test.ts et demos-it3.test.ts, examen statique des imports).
// - Lecteur complet : useReplay et ReplayBar de « Revoir » (moments, « Lire » / « Figer ici », pas à pas, vitesses, badge
//   « EN DIFFÉRÉ »), légendes conditionnelles (LegendeBulle) et [Tableau]. Aucune boucle ici (web-animations.test.ts) : les
//   minuteries du lecteur sont dans useReplay.ts, jamais setInterval ni requestAnimationFrame.
// - LegendeBulle SANS onVoirConsigne (D-3d-30) : une démonstration n'a aucune consigne gardée par le cockpit, [Voir la consigne]
//   n'y est donc jamais offert.
// - Mode Simple (D-3d-20) : la scène est calculée en mode Avancé — sinon « Deux assistants en même temps » n'en dessinerait
//   qu'un — puis montrée avec le vocabulaire du mode Simple (vueSimple), donc aucun nom d'assistant enregistré n'atteint
//   l'écran. Une démonstration qui dessine une délégation porte alors la phrase demoAvance (U1, option a : les équipes restent
//   fermées en mode Simple, et aucun texte ne propose d'équipe).
// - Accessibilité : boîte de dialogue (Modal) nommée par l'étiquette ; aucune région aria-live ajoutée (les légendes passent par
//   la région unique de la page).
// Composant interne : ses propriétés restent libres pour son propriétaire.
import { useId, useMemo, useState } from "react";
import { factProblem } from "../../../../server/shared/activity-facts.ts";
import type { ActivityFact } from "../../../../server/shared/activity-types.ts";
import { legendesAuMoment } from "../../../../server/shared/legendes.ts";
import { type NeonScene, type NeonSceneOptions, scene, visibleCount } from "../../../../server/shared/neon-scene.ts";
import { TEXTES } from "../../../../server/shared/neon-texts.ts";
import { instant } from "../../../../server/shared/revoir.ts";
import { TEXTES as REVOIR } from "../../../../server/shared/revoir-texts.ts";
import { nomsSimples, vueSimple } from "../../../../server/shared/vue-simple.ts";
import { Modal } from "../../../components/ui.tsx";
import { LegendeBulle } from "../../salle-controle/revoir/LegendeBulle.tsx";
import { ReplayBar } from "../../salle-controle/revoir/ReplayBar.tsx";
import { useReplay } from "../../salle-controle/revoir/useReplay.ts";
import demoP1 from "./demo-p1.json" with { type: "json" };
import demoPlafond from "./demos/arret-plafond.json" with { type: "json" };
import demoAttente from "./demos/attente-accord.json" with { type: "json" };
import { NeonCarte, NeonTableau } from "./NeonBand.tsx";

export interface DemoPlayerProps {
  /** Mode de l'utilisateur : en mode Simple, vocabulaire du mode Simple et avis sur la délégation. */
  advanced: boolean;
  onClose: () => void;
}

const T = REVOIR.partout;

/**
 * Scène d'une démonstration : carte au zoom 2, TOUJOURS calculée en mode Avancé (D-3d-20). En mode Simple, scene() ne dessinerait
 * que l'assistant de la conversation, et « Deux assistants en même temps » n'aurait plus rien à montrer.
 */
const SCENE: Readonly<NeonSceneOptions> = Object.freeze({ zoom: 2, mode: "avance" });

interface Demonstration {
  cle: string;
  titre: string;
  faits: readonly ActivityFact[];
}

/** Faits d'une démonstration ; un fait refusé par la garde des faits (texte, secret) est écarté, jamais montré. */
function demonstration(cle: string, titre: string, fichier: { faits: readonly unknown[] }): Demonstration {
  return { cle, titre, faits: fichier.faits.filter((fait): fait is ActivityFact => factProblem(fait) === null) };
}

const P1 = demonstration("p1", T.demos.deuxEnMemeTemps, demoP1);
const DEMOS: readonly Demonstration[] = [P1, demonstration("attente-accord", T.demos.attenteAccord, demoAttente), demonstration("arret-plafond", T.demos.arretPlafond, demoPlafond)];

/** Vrai quand la démonstration dessine une délégation : un assistant au moins n'est pas celui de la conversation. */
function dessineUneDelegation(faits: readonly ActivityFact[]): boolean {
  return scene(faits, null, SCENE).noeuds.some((noeud) => noeud.role !== "conversation");
}

export function DemoPlayer({ advanced, onClose }: DemoPlayerProps) {
  const choixId = useId();
  const [cle, setCle] = useState(P1.cle);
  const [tableau, setTableau] = useState(false);
  const demo = DEMOS.find((une) => une.cle === cle) ?? P1;
  const faits = demo.faits;
  const lecteur = useReplay(faits, null);
  const t = instant(lecteur.etat);

  const delegue = useMemo(() => dessineUneDelegation(faits), [faits]);
  // Scène du moment montré : calculée en mode Avancé, puis renommée en vocabulaire du mode Simple (D-3d-20).
  const vue = useMemo<NeonScene>(() => {
    const brute = scene(faits.slice(0, visibleCount(faits, t)), null, SCENE);
    return advanced ? brute : vueSimple(brute, nomsSimples(brute, true));
  }, [faits, t, advanced]);
  const legendes = useMemo(() => legendesAuMoment(faits, t, { salle: false }), [faits, t]);
  const moment = lecteur.etat.moments[lecteur.etat.index] ?? null;

  return (
    <Modal open title={TEXTES.partout.demonstrationEnregistree} onClose={onClose} wide>
      <div className="neon-band">
        <div className="row wrap">
          <label htmlFor={choixId} className="small">
            {T.demos.choisir}
          </label>
          <select
            id={choixId}
            className="select sm"
            value={demo.cle}
            onChange={(event) => {
              setCle(event.currentTarget.value);
            }}
          >
            {DEMOS.map((une) => (
              <option key={une.cle} value={une.cle}>
                {une.titre}
              </option>
            ))}
          </select>
        </div>
        {/* U1 (D-3d-26) : en mode Simple, l'IA ne délègue pas ; une démonstration qui dessine une délégation le dit (P3). */}
        {advanced || !delegue ? null : <p className="neon-note">{REVOIR.simple.demoAvance}</p>}
        <ReplayBar
          index={lecteur.etat.index}
          total={lecteur.etat.moments.length}
          heure={moment}
          vitesse={lecteur.etat.vitesse}
          lecture={lecteur.etat.lecture}
          direct={lecteur.etat.direct}
          raccourciMs={lecteur.raccourciMs}
          suivre={null}
          onLire={lecteur.actions.lire}
          onFiger={lecteur.actions.figer}
          onPrecedent={lecteur.actions.precedent}
          onSuivant={lecteur.actions.suivant}
          onAller={lecteur.actions.aller}
          onVitesse={lecteur.actions.vitesse}
        />
        <button
          type="button"
          className="btn sm ghost"
          aria-pressed={tableau}
          onClick={() => {
            setTableau((montre) => !montre);
          }}
        >
          {TEXTES.partout.commandes.tableau}
        </button>
        <div className="neon-body">{tableau ? <NeonTableau vue={vue} /> : <NeonCarte vue={vue} />}</div>
        <div className="revoir-legendes">
          {/* Aucun onVoirConsigne : une démonstration n'a aucune consigne gardée (D-3d-30). */}
          {legendes.map((legende, i) => (
            <LegendeBulle key={`${i}:${legende.ancre.genre}:${legende.ancre.id}:${legende.cles.join("+")}`} cles={legende.cles} salle={false} mode={vue.mode} />
          ))}
        </div>
      </div>
    </Modal>
  );
}
