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
// <c5:demonstration-passee-doc>
// Itération 5 (fiche L49, D-5-15) : la propriété `demo` passe une AUTRE démonstration enregistrée (ses faits, ses moments, son
// titre et son contenu propre) ; sans elle, le lecteur complet ci-dessus reste exactement tel quel. Le choix de la démonstration
// à ouvrir appartient à l'appelant : ce lecteur ne lit jamais `ouvertesEnSimple` ni aucun autre réglage (D-5-24).
// Grande fusion (GF4) : la démonstration passée garde son lecteur pas à pas (DemonstrationPassee, plus bas) — ouvert sur son
// PREMIER moment, sans aucune lecture automatique, avec le vocabulaire de « Revoir » (« n / N », [Moment précédent], [Moment
// suivant]) et la même règle du mode Simple (scène calculée en mode Avancé, puis vueSimple). Deux composants plutôt qu'un
// retour anticipé : chacun appelle toujours les mêmes crochets. L'entrée de la démonstration d'équipe dans le CHOIX du lecteur
// complet est posée par GF5, pas ici.
// </c5:demonstration-passee-doc>
// <c5:demonstration-equipe-doc>
// Grande fusion (GF5 ; plan it5 §8.6 GF5 point 3, §2.8 ; U1, D-5-24, plan it3 §8.4 (c)) : la démonstration d'équipe entre dans le
// CHOIX du lecteur complet (« Comment se déroule une équipe », après les trois de l'itération 3), avec ses vitesses, son pas à pas
// et son badge « EN DIFFÉRÉ », SEULEMENT si l'appelant passe `equipesVisibles` vrai (défaut faux), calculé par
// equipesOuvertes(mode, ouvertesEnSimple) (server/shared/equipes-ouvertes.ts). Ce lecteur ne lit JAMAIS cette valeur lui-même,
// ni aucune API : ses faits et son contenu propre viennent de demo-equipe-source.tsx, livré avec l'interface. Sous la bande, le
// moment enregistré atteint par le lecteur (carte d'exécution et Déroulé de l'itération 4, données fictives dites).
// </c5:demonstration-equipe-doc>
// Composant interne : ses propriétés restent libres pour son propriétaire.
import { useId, useMemo, useState } from "react";
// <c5:demonstration-passee-import>
import type { ReactNode } from "react";
// </c5:demonstration-passee-import>
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
// <c5:demonstration-passee-import-lecteur>
// Grande fusion (GF4) : ce que le lecteur de la démonstration passée prend en plus, APRÈS les imports du lecteur complet (les
// contrôles qui cherchent le premier import de neon-texts.ts y trouvent ainsi celui qui porte TEXTES).
import { resumeBande } from "../../../../server/shared/neon-band.ts";
import { remplir } from "../../../../server/shared/neon-texts.ts";
import { formatHeure } from "../../../../server/shared/revoir-texts.ts";
// </c5:demonstration-passee-import-lecteur>
// <c5:demonstration-equipe-import>
import { TEXTES as TEXTES_C5 } from "../../../../server/shared/construction-texts.ts";
import { type CleDemonstration, demonstrationsProposees } from "../../../../server/shared/equipes-ouvertes.ts";
import { ContenuDemoEquipe, FAITS_EQUIPE, momentEquipeAu } from "../../assistants/teams/demo-equipe-source.tsx";
// </c5:demonstration-equipe-import>

// <c5:demonstration-passee-contrat>
/**
 * Démonstration enregistrée par un AUTRE paquet, rejouée par ce lecteur (itération 5, fiche L49 ; D-5-15) : ses faits et ses
 * moments remplacent la capture p1, et son contenu propre est dessiné sous la bande. Tout est déjà enregistré : le lecteur
 * n'appelle rien et ne lit aucun réglage — c'est l'appelant qui décide de l'ouvrir ou non.
 */
export interface DemoSource {
  /** Titre montré à la place de celui de la capture p1. */
  titre: string;
  /** Faits rejoués, dans l'ordre ; la bande les dessine par la même scene(t) que le direct. */
  faits: readonly ActivityFact[];
  /** Heures des moments du lecteur, croissantes : « Moment n / N » les parcourt. */
  moments: readonly number[];
  /** Contenu propre de la démonstration, dessiné sous la bande à chaque moment. */
  rendre?: (moment: { rang: number; total: number; at: number | null }) => ReactNode;
}

// </c5:demonstration-passee-contrat>
export interface DemoPlayerProps {
  /** Mode de l'utilisateur : en mode Simple, vocabulaire du mode Simple et avis sur la délégation. */
  advanced: boolean;
  // <c5:demonstration-passee-propriete>
  /** Démonstration à rejouer ; absente : le lecteur complet et ses trois démonstrations. */
  demo?: DemoSource;
  // </c5:demonstration-passee-propriete>
  // <c5:demonstration-equipe-propriete>
  /**
   * « Comment se déroule une équipe » proposée dans le choix du lecteur complet : décidé par l'APPELANT (equipesOuvertes), jamais
   * lu ici ; absente ou fausse : les trois démonstrations de l'itération 3 seulement (U1 : rien ne propose d'équipe en Simple fermé).
   */
  equipesVisibles?: boolean;
  // </c5:demonstration-equipe-propriete>
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
// <c5:demonstration-equipe-liste>
/** Toutes les démonstrations du lecteur complet, par clé : celles de l'itération 3, puis celle d'équipe (L49, D-5-15). */
const PAR_CLE: Readonly<Record<CleDemonstration, Demonstration>> = {
  p1: P1,
  "attente-accord": DEMOS[1] ?? P1,
  "arret-plafond": DEMOS[2] ?? P1,
  equipe: demonstration("equipe", TEXTES_C5.partout.demonstration.titre, { faits: FAITS_EQUIPE }),
};
// </c5:demonstration-equipe-liste>

/** Vrai quand la démonstration dessine une délégation : un assistant au moins n'est pas celui de la conversation. */
function dessineUneDelegation(faits: readonly ActivityFact[]): boolean {
  return scene(faits, null, SCENE).noeuds.some((noeud) => noeud.role !== "conversation");
}

// <c5:demonstration-passee-aiguillage>
// Grande fusion (GF4) : sans `demo`, le lecteur complet de L34 (LecteurComplet, son code d'avant la fusion) ; avec `demo`, le
// lecteur pas à pas de la démonstration passée (L49).
export function DemoPlayer({ advanced, demo: passee, equipesVisibles = false, onClose }: DemoPlayerProps) {
  // c5:demonstration-equipe : `equipesVisibles` passé au lecteur complet, seul à montrer le choix.
  return passee === undefined ? <LecteurComplet advanced={advanced} equipesVisibles={equipesVisibles} onClose={onClose} /> : <DemonstrationPassee advanced={advanced} demo={passee} onClose={onClose} />;
}

function LecteurComplet({ advanced, equipesVisibles = false, onClose }: Omit<DemoPlayerProps, "demo">) {
  // </c5:demonstration-passee-aiguillage>
  const choixId = useId();
  const [cle, setCle] = useState(P1.cle);
  const [tableau, setTableau] = useState(false);
  // <c5:demonstration-equipe-choix>
  // Choix composé par la fonction pure (U1) : la démonstration d'équipe n'y est que si l'appelant la rend visible.
  const proposees = demonstrationsProposees(equipesVisibles).map((une) => PAR_CLE[une]);
  const demo = proposees.find((une) => une.cle === cle) ?? P1;
  // </c5:demonstration-equipe-choix>
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
            {/* c5:demonstration-equipe-choix : les démonstrations proposées, la démonstration d'équipe comprise si elle est visible. */}
            {proposees.map((une) => (
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
        {/* <c5:demonstration-equipe-contenu> */}
        {/* Démonstration d'équipe : le moment enregistré atteint par le lecteur, sous la bande (données fictives dites). */}
        {demo.cle === "equipe" ? <ContenuDemoEquipe moment={momentEquipeAu(t)} advanced={advanced} /> : null}
        {/* </c5:demonstration-equipe-contenu> */}
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

// <c5:demonstration-passee-lecteur>
/** Décalage du fuseau du poste à appliquer à un instant (l'opposé de getTimezoneOffset, comme l'attend formatHeure). */
const decalageLocal = (ms: number): number => -new Date(ms).getTimezoneOffset();

/**
 * Lecteur d'une démonstration passée (L49) : pas à pas, ouvert sur le PREMIER moment, sans aucune lecture automatique (ni
 * minuteur ni effet ici). Les moments sont ceux que la démonstration a enregistrés ; `rendre` reçoit leur rang. La scène suit la
 * règle du lecteur complet (D-3d-20) : calculée en mode Avancé, puis renommée en vocabulaire du mode Simple. Aucune phrase
 * demoAvance : une démonstration passée porte la sienne, dans son contenu propre.
 */
function DemonstrationPassee({ advanced, demo: passee, onClose }: { advanced: boolean; demo: DemoSource; onClose: () => void }) {
  const curseurId = useId();
  const [rang, setRang] = useState(0);
  const [tableau, setTableau] = useState(false);
  const faits = passee.faits;
  const instants = passee.moments;
  const total = instants.length;
  const t = instants[rang] ?? null;
  const vue = useMemo<NeonScene>(() => {
    const brute = scene(faits, t, SCENE);
    return advanced ? brute : vueSimple(brute, nomsSimples(brute, true));
  }, [faits, t, advanced]);
  const max = Math.max(total, 1);
  const heure = t ?? faits[0]?.at ?? 0;
  const aller = (cible: number) => setRang(Math.min(Math.max(cible, 0), Math.max(total - 1, 0)));

  return (
    <Modal open title={TEXTES.partout.demonstrationEnregistree} onClose={onClose} wide>
      <div className="neon-band">
        <div className="neon-head">
          <h3 className="neon-title">{passee.titre}</h3>
          {/* Résumé d'une ligne : seulement à 400 px, où la carte laisse la place (neon.css). */}
          <p className="neon-summary is-deplie">{resumeBande(vue)}</p>
        </div>
        {/* Premier élément focalisable de la boîte : le curseur (Modal le focalise à l'ouverture). */}
        <div className="row wrap">
          <label htmlFor={curseurId} className="small tabular">
            {remplir(T.moments, { n: rang + 1, total: max })}
          </label>
          <input
            id={curseurId}
            type="range"
            min={1}
            max={max}
            step={1}
            value={rang + 1}
            aria-valuetext={remplir(T.momentsAria, { n: rang + 1, total: max, heure: formatHeure(heure, decalageLocal(heure)) })}
            onChange={(event) => aller(Number(event.currentTarget.value) - 1)}
          />
          <button type="button" className="btn sm" disabled={rang === 0} onClick={() => aller(rang - 1)}>
            {T.precedent}
          </button>
          <button type="button" className="btn sm" disabled={rang >= total - 1} onClick={() => aller(rang + 1)}>
            {T.suivant}
          </button>
          <button type="button" className="btn sm ghost" aria-pressed={tableau} onClick={() => setTableau((v) => !v)}>
            {TEXTES.partout.commandes.tableau}
          </button>
        </div>
        <div className="neon-body">{tableau ? <NeonTableau vue={vue} /> : <NeonCarte vue={vue} />}</div>
        {passee.rendre ? passee.rendre({ rang, total, at: t }) : null}
      </div>
    </Modal>
  );
}
// </c5:demonstration-passee-lecteur>
