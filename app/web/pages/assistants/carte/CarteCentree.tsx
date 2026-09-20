// Propriétaire : L39b.
// Vue CENTRÉE de la carte des assistants (défaut, spécification §5.2 l.888, §5.5, §5.6 ; C §7.4) : TROIS COLONNES HTML —
// « Qui le fait travailler » · l'élément · « Qui il fait travailler et ce qu'il consulte » — et des connecteurs SVG purement
// décoratifs (aria-hidden, focusable="false"). Chaque voisin RÉPÈTE la phrase de l'arête : la vue se lit sans le dessin.
// Le clic sur un nœud choisit cet élément ; l'élément choisi montre sa carte d'identité existante (IdentityCard) quand il en a
// une (assistant, assistant intégré, agent du Studio, assistant délégué).
// La légende répète les MOTS « sans confirmation » / « après votre accord » / « imposé par le cockpit » : la couleur seule ne
// dit jamais rien (§2.3, §5.5, U9 ; carte.css donne aussi une forme de trait à chacun).
// En mode Simple, une délégation demandée est refusée par le cockpit : la phrase de T4t le dit (« le cockpit refuse en mode
// Simple : l'IA continue seule »), et le trait prend la forme « imposé par le cockpit ».
// Aucun texte écrit ici : tout vient d'agent-map-texts.ts (T4t) par ./carte-model.ts, qui passe TOUJOURS edge.kind à phraseArete.
import type { AgentMapResult, MapNode } from "../../../../server/shared/agent-map.ts";
import { phraseAvertissement, TEXTES } from "../../../../server/shared/agent-map-texts.ts";
import { type IdentityData, IdentityCard } from "../IdentityCard.tsx";
import {
  aUneIdentite,
  type CarteColonnes,
  type CarteLien,
  type CarteTrait,
  colonnesDe,
  genreDuNoeud,
  iaDuNoeud,
  motTrait,
  nomDuNoeud,
} from "./carte-model.ts";
import { classesDuLien } from "./CarteListe.tsx";

const P = TEXTES.partout;

/** Traits de la légende, dans l'ordre : chacun a son MOT et sa forme (carte.css), jamais sa couleur seule. */
const TRAITS: readonly CarteTrait[] = ["sans", "accord", "impose"];

/**
 * Connecteur d'un lien : DÉCORATIF, jamais lu (aria-hidden, focusable="false"). Sa forme (plein, pointillés, tirets) suit le
 * trait, comme la légende ; la pointe va toujours du côté où le travail part, de gauche à droite.
 */
function Connecteur({ trait }: { trait: CarteTrait | null }) {
  const classe = trait === null ? "ca-connecteur-trait" : `ca-connecteur-trait ca-trait-${trait}`;
  return (
    <svg className="ca-connecteur" viewBox="0 0 32 24" width="32" height="24" aria-hidden="true" focusable="false" role="presentation">
      <path className={classe} d="M2 12h24" />
      <path className="ca-connecteur-pointe" d="M20 6l6 6-6 6" />
    </svg>
  );
}

/** Un voisin d'une colonne : son nom (qui le choisit), son genre, la phrase de l'arête, le mot du trait et qui l'applique. */
function Voisin({ lien, sens, onChoisir }: { lien: CarteLien; sens: "amont" | "aval"; onChoisir(id: string): void }) {
  return (
    <li className={classesDuLien(lien)}>
      <div className="ca-voisin">
        {sens === "aval" ? <Connecteur trait={lien.trait} /> : null}
        <div className="ca-voisin-texte">
          <button type="button" className="ca-lien-nom" onClick={() => onChoisir(lien.id)}>
            {lien.nom}
          </button>
          <span className="ca-lien-genre">{lien.genre}</span>
          <span className="ca-lien-phrase">{lien.phrase}</span>
          <span className="ca-lien-applique">
            {lien.mot === null ? null : <span className="ca-lien-mot">{lien.mot}</span>}
            {lien.appliquePar}
          </span>
        </div>
        {sens === "amont" ? <Connecteur trait={lien.trait} /> : null}
      </div>
    </li>
  );
}

function Colonne({
  titre,
  liens,
  vide,
  sens,
  onChoisir,
}: {
  titre: string;
  liens: readonly CarteLien[];
  vide: string;
  sens: "amont" | "aval";
  onChoisir(id: string): void;
}) {
  return (
    <section className={`ca-colonne ca-colonne-${sens}`} aria-label={titre}>
      <h3 className="ca-colonne-titre">{titre}</h3>
      {liens.length === 0 ? (
        <p className="ca-vide">{vide}</p>
      ) : (
        <ul className="ca-colonne-liens">
          {liens.map((lien, rang) => (
            <Voisin key={`${rang}-${lien.id}`} lien={lien} sens={sens} onChoisir={onChoisir} />
          ))}
        </ul>
      )}
    </section>
  );
}

/** Carte d'identité d'un nœud de la carte : ce que la carte sait de lui, sans rien inventer (ni description, ni coût). */
export function identiteDuNoeud(node: MapNode, colonnes: CarteColonnes, advanced: boolean): IdentityData {
  return {
    title: nomDuNoeud(node, advanced),
    description: "",
    rights: null,
    rightLines: node.droits,
    model: null,
    modelName: node.ia.label,
    tier: node.ia.niveau,
    estimate: null,
    guardNote: null,
    fiches: colonnes.aval.filter((lien) => lien.kind === "consulte").map((lien) => lien.nom),
    usedBy: colonnes.amont.filter((lien) => lien.kind === "lance").map((lien) => lien.nom),
  };
}

export interface CarteCentreeProps {
  result: AgentMapResult;
  advanced: boolean;
  /** Élément montré, déjà résolu par elementMontre (il existe dans la carte). */
  element: string;
  onChoisir(id: string): void;
}

export function CarteCentree({ result, advanced, element, onChoisir }: CarteCentreeProps) {
  const colonnes = colonnesDe(result, element, advanced);
  if (colonnes === null) return null;
  const node = colonnes.element;
  const ia = iaDuNoeud(node);

  return (
    <div className="ca-centree">
      <div className="ca-trois-colonnes">
        <Colonne titre={P.colonnes.amont} liens={colonnes.amont} vide={P.personneAmont} sens="amont" onChoisir={onChoisir} />
        <section className="ca-centre" aria-label={nomDuNoeud(node, advanced)}>
          <div className="ca-centre-tete">
            <h3 className="ca-centre-nom">{nomDuNoeud(node, advanced)}</h3>
            <span className="ca-tete-genre">{genreDuNoeud(node, advanced)}</span>
            {node.cacheDansLeChat ? <span className="ca-tete-note">{P.cacheDansLeChat}</span> : null}
            {ia === null ? null : <span className="ca-tete-ia">{ia}</span>}
            {node.avertissements.map((code) => (
              <span key={code} className="ca-tete-avertissement">
                {phraseAvertissement(code)}
              </span>
            ))}
          </div>
          {aUneIdentite(node) ? <IdentityCard data={identiteDuNoeud(node, colonnes, advanced)} className="ca-identite" /> : null}
        </section>
        <Colonne titre={P.colonnes.aval} liens={colonnes.aval} vide={P.personneAval} sens="aval" onChoisir={onChoisir} />
      </div>
      <section className="ca-legende" aria-label={P.legende.titre}>
        <h3 className="ca-legende-titre">{P.legende.titre}</h3>
        <ul className="ca-legende-liste">
          {TRAITS.map((trait) => (
            <li key={trait} className={`ca-legende-item ca-trait-${trait}`}>
              <span className="ca-legende-trait" aria-hidden="true" />
              {motTrait(trait)}
            </li>
          ))}
        </ul>
        <p className="ca-legende-ecrit">{P.legende.ecrit}</p>
      </section>
    </div>
  );
}
