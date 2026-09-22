// Propriétaire : L39b.
// Vue LISTE de la carte des assistants (spécification §5.2 l.888, §5.5, §5.6 ; C §7.4) : une section par élément, les mêmes
// phrases que la vue Centrée. C'EST LA VÉRITÉ (U11) : toutes les arêtes de la carte y sont, une phrase chacune, jamais deux —
// la vue Centrée n'en montre qu'un voisinage, et ses connecteurs SVG sont décoratifs.
// Elle est le défaut sous 900 px (carte.css bascule) et pour le lecteur d'écran.
// Aucun texte écrit ici : tout vient d'agent-map-texts.ts (T4t) par ./carte-model.ts, qui passe TOUJOURS edge.kind à phraseArete.
import type { AgentMapResult } from "../../../../server/shared/agent-map.ts";
import { phraseAvertissement, TEXTES } from "../../../../server/shared/agent-map-texts.ts";
import { type CarteLien, type CarteSection, genreDuNoeud, iaDuNoeud, nomDuNoeud, sectionsDeLaListe } from "./carte-model.ts";

const P = TEXTES.partout;

/** Classes d'un lien : la FORME du trait et le refus en mode Simple, jamais la couleur seule (§2.3, U9). */
export function classesDuLien(lien: CarteLien): string {
  const trait = lien.trait === null ? "" : ` ca-trait-${lien.trait}`;
  return `ca-lien${trait}${lien.refuseEnSimple ? " ca-refuse" : ""}`;
}

/** Un lien, écrit en toutes lettres : la phrase de l'arête, le mot de son trait et qui l'applique. */
export function LienEcrit({ lien, onChoisir }: { lien: CarteLien; onChoisir(id: string): void }) {
  return (
    <li className={classesDuLien(lien)}>
      <button type="button" className="ca-lien-nom" onClick={() => onChoisir(lien.id)}>
        {lien.nom}
      </button>
      <span className="ca-lien-genre">{lien.genre}</span>
      <span className="ca-lien-phrase">{lien.phrase}</span>
      {lien.mot === null ? null : <span className="ca-lien-mot">{lien.mot}</span>}
      <span className="ca-lien-applique">{lien.appliquePar}</span>
    </li>
  );
}

/** En-tête d'un élément : son nom (qui ouvre sa carte d'identité), son genre, son IA et ses avertissements. */
export function TeteDeNoeud({
  section,
  advanced,
  choisi,
  onChoisir,
}: {
  section: CarteSection;
  advanced: boolean;
  choisi: boolean;
  onChoisir(id: string): void;
}) {
  const ia = iaDuNoeud(section.node);
  return (
    <div className="ca-tete">
      <h3 className="ca-tete-nom">
        <button type="button" className="ca-tete-bouton" aria-current={choisi ? "true" : undefined} onClick={() => onChoisir(section.node.id)}>
          {nomDuNoeud(section.node, advanced)}
        </button>
      </h3>
      <span className="ca-tete-genre">{genreDuNoeud(section.node, advanced)}</span>
      {section.node.cacheDansLeChat ? <span className="ca-tete-note">{P.cacheDansLeChat}</span> : null}
      {ia === null ? null : <span className="ca-tete-ia">{ia}</span>}
      {section.node.avertissements.map((code) => (
        <span key={code} className="ca-tete-avertissement">
          {phraseAvertissement(code)}
        </span>
      ))}
    </div>
  );
}

export interface CarteListeProps {
  result: AgentMapResult;
  advanced: boolean;
  /** Élément montré : sa section est marquée, jamais isolée (la liste reste la vérité entière). */
  element: string | null;
  onChoisir(id: string): void;
}

export function CarteListe({ result, advanced, element, onChoisir }: CarteListeProps) {
  const sections = sectionsDeLaListe(result, advanced);
  return (
    <div className="ca-liste">
      {sections.map((section) => (
        <section key={section.node.id} className={`ca-section${section.node.id === element ? " choisi" : ""}`}>
          <TeteDeNoeud section={section} advanced={advanced} choisi={section.node.id === element} onChoisir={onChoisir} />
          {section.liens.length === 0 ? (
            <p className="ca-vide">{P.personneAval}</p>
          ) : (
            <ul className="ca-liens">
              {section.liens.map((lien, rang) => (
                <LienEcrit key={`${section.node.id}-${rang}-${lien.id}`} lien={lien} onChoisir={onChoisir} />
              ))}
            </ul>
          )}
        </section>
      ))}
    </div>
  );
}
