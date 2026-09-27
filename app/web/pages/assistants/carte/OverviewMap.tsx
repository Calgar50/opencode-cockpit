// Propriétaire : L48.
// Vue D'ENSEMBLE de la carte des assistants (itération 5b ; spécification §5.2 l.890, §5.5, §5.6 ; C §7.4, §9.9) : cinq
// colonnes HTML — Vous · Raccourcis et Équipes · Assistants, Intégrés et Agents du Studio · Sous-agents · Fiches — avec une
// puce de filtre par groupe et l'estompage de tout ce qui est hors sujet autour d'un élément.
// - MODE AVANCÉ SEULEMENT (§5.2 l.890) : CarteTab ne monte jamais cette vue en mode Simple ; sous 900 px, la Liste reste le
//   défaut (overview.css ne montre les colonnes qu'à partir de 900 px, comme carte.css pour la vue Centrée).
// - UN VRAI BOUTON PAR NŒUD : Entrée met le focus (un bouton s'active à l'Entrée), Échap le retire, le survol le met le temps
//   du survol. Aucun raccourci à une touche hors de la vue, aucun focus pris, aucune animation (§5.5).
// - Les connecteurs SVG sont DÉCORATIFS (aria-hidden, focusable="false") : aucune mesure de position, aucune bibliothèque de
//   graphe ni de glisser (P8). La vérité est écrite : chaque lien visible est repris EN TEXTE sous les colonnes, par lienDe de
//   carte-model.ts — le MÊME chemin que les vues Centrée et Liste, qui donne toujours edge.kind aux textes de l'it4 : aucune
//   vue du dossier n'écrit elle-même la phrase d'une arête, c'est une garde de L39b.
// - Estompage : opacité et « (hors sujet) » lu par le lecteur d'écran (§5.5) ; rien n'est retiré de l'arbre d'accessibilité,
//   et le focus ne cache aucun nœud — seules les puces en retirent.
// - Échappement : tout ce qui vient d'un fichier d'agent ou d'opencode (noms, titres) est rendu comme TEXTE JSX, jamais comme
//   du balisage ; aucun dangerouslySetInnerHTML, aucun innerHTML.
// Aucun texte écrit ici : les libellés viennent de construction-texts.ts (T5a, §4.3) et les phrases d'arête d'agent-map-texts.ts
// (T4t) ; les noms affichés passent par carte-model.ts (L39b), qui n'est pas modifié.
import { type KeyboardEvent, useState } from "react";
import type { AgentMapResult, MapNodeKind } from "../../../../server/shared/agent-map.ts";
import { type OverviewNode, OVERVIEW_FILTERS, overviewLayout } from "../../../../server/shared/agent-map-overview.ts";
import { TEXTES as TEXTES_C5 } from "../../../../server/shared/construction-texts.ts";
import { lienDe, nomDuNoeud } from "./carte-model.ts";
import { classesDuLien } from "./CarteListe.tsx";
import "./overview.css";

const V = TEXTES_C5.avance.vueEnsemble;

/** Un libellé par genre : il titre le groupe et nomme la puce de filtre qui le montre (§4.3). */
const LIBELLES: Readonly<Record<MapNodeKind, string>> = {
  vous: V.vous,
  raccourci: V.raccourcis,
  equipe: V.equipes,
  assistant: V.assistants,
  integre: V.integres,
  "agent-studio": V.agentsStudio,
  "sous-agent": V.sousAgents,
  fiche: V.fiches,
};

/** Connecteur entre deux colonnes : DÉCORATIF, jamais lu ni focalisable. Chaque lien est écrit plus bas, en toutes lettres. */
function Connecteur() {
  return (
    <svg className="ov-connecteur" viewBox="0 0 24 24" width="24" height="24" aria-hidden="true" focusable="false" role="presentation">
      <path className="ov-connecteur-trait" d="M1 12h18" />
      <path className="ov-connecteur-pointe" d="M14 6l6 6-6 6" />
    </svg>
  );
}

/** Un nœud : un vrai bouton, son nom affiché, son nom technique quand il dit autre chose, et « (hors sujet) » s'il est estompé. */
function Noeud({ item, advanced, focus, onFocus, onSurvol }: { item: OverviewNode; advanced: boolean; focus: string | null; onFocus(id: string): void; onSurvol(id: string | null): void }) {
  const affiche = nomDuNoeud(item.node, advanced);
  const technique = item.node.name === affiche || item.node.kind === "vous" ? null : item.node.name;
  return (
    <button
      type="button"
      className={`ov-noeud${item.estompe ? " estompe" : ""}`}
      aria-pressed={focus === item.node.id}
      onClick={() => onFocus(item.node.id)}
      onMouseEnter={() => onSurvol(item.node.id)}
      onMouseLeave={() => onSurvol(null)}
    >
      <span className="ov-noeud-nom">{affiche}</span>
      {technique === null ? null : <span className="ov-noeud-technique">{technique}</span>}
      {item.estompe ? <span className="visually-hidden">{V.horsSujet}</span> : null}
    </button>
  );
}

export interface OverviewMapProps {
  result: AgentMapResult;
  advanced: boolean;
  /** Élément choisi ailleurs (adresse, sélecteur) : focus de départ, que le survol, un clic ou Échap remplacent. */
  element: string | null;
}

export function OverviewMap({ result, advanced, element }: OverviewMapProps) {
  const [filtres, setFiltres] = useState<readonly MapNodeKind[]>(OVERVIEW_FILTERS);
  // `undefined` : rien n'a encore été choisi ici, le focus de départ est l'élément de l'adresse ; `null` : focus retiré (Échap).
  const [choisi, setChoisi] = useState<string | null | undefined>(undefined);
  const [survol, setSurvol] = useState<string | null>(null);

  const fixe = choisi === undefined ? element : choisi;
  const layout = overviewLayout(result, { filtres, focus: survol ?? fixe });

  // Une puce éteinte retire son genre ; rallumée, elle reprend sa place dans l'ordre du §4.3.
  const basculerPuce = (kind: MapNodeKind) =>
    setFiltres((actifs) => OVERVIEW_FILTERS.filter((autre) => (autre === kind ? !actifs.includes(kind) : actifs.includes(autre))));
  const basculerFocus = (id: string) => setChoisi((actuel) => ((actuel === undefined ? element : actuel) === id ? null : id));
  const surTouche = (event: KeyboardEvent<HTMLElement>) => {
    if (event.key !== "Escape" || layout.focus === null) return;
    event.stopPropagation();
    setChoisi(null);
    setSurvol(null);
  };

  return (
    <section className="ov-ensemble" aria-label={V.titre} onKeyDown={surTouche}>
      <p className="ov-aide">{V.aide}</p>
      <div className="ov-filtres" role="group" aria-label={V.filtres}>
        {OVERVIEW_FILTERS.map((kind) => (
          <button key={kind} type="button" className="btn sm ghost ov-puce" aria-pressed={filtres.includes(kind)} onClick={() => basculerPuce(kind)}>
            {LIBELLES[kind]}
          </button>
        ))}
      </div>

      <div className="ov-colonnes">
        {layout.colonnes.map((colonne, rang) => (
          <div key={colonne.id} className={`ov-colonne ov-colonne-${colonne.id}`}>
            {rang === 0 ? null : <Connecteur />}
            {colonne.groupes.map((groupe) => (
              <section key={groupe.kind} className="ov-groupe" aria-label={LIBELLES[groupe.kind]}>
                <h3 className="ov-groupe-titre">{LIBELLES[groupe.kind]}</h3>
                <ul className="ov-noeuds">
                  {groupe.nodes.map((item) => (
                    <li key={item.node.id}>
                      <Noeud item={item} advanced={advanced} focus={layout.focus} onFocus={basculerFocus} onSurvol={setSurvol} />
                    </li>
                  ))}
                </ul>
              </section>
            ))}
          </div>
        ))}
      </div>

      <section className="ov-liens" aria-label={V.liens}>
        <h3 className="ov-liens-titre">{V.liens}</h3>
        <ul className="ov-liens-liste">
          {layout.aretes.map((arete, rang) => {
            const lien = lienDe(arete.edge, arete.source, arete.cible, arete.cible, advanced);
            return (
              <li key={`${rang}-${arete.edge.from}-${arete.edge.to}`} className={`ov-lien ${classesDuLien(lien)}${arete.estompe ? " estompe" : ""}`}>
                <span className="ca-lien-phrase">{lien.phrase}</span>
                {lien.mot === null ? null : <span className="ca-lien-mot">{lien.mot}</span>}
                <span className="ca-lien-applique">{lien.appliquePar}</span>
                {arete.estompe ? <span className="visually-hidden">{V.horsSujet}</span> : null}
              </li>
            );
          })}
        </ul>
      </section>
    </section>
  );
}
