// Propriétaire : L39b.
// Onglet « Carte » de la page Assistants (#/assistants/carte?element=<id de nœud>) : carte des assistants, vues Centrée et Liste
// (spécification §5.2 l.887-892, §5.4 l.911, §5.5, §5.6 ; C §7.4, §9.9 ; plan d'exécution it4, fiche L39b). Propriétés FIGÉES
// dans ../../chat/team/slots.ts (T4w) : il remplace le squelette posé par T4w.
// - La carte est OUVERTE DANS LES DEUX MODES (plan §2.6), même quand les équipes sont fermées en mode Simple : ce que le mode
//   change est dans la réponse du serveur (agents du Studio et équipes retirés) et dans les phrases de T4t.
// - Deux vues : « Centrée » (défaut visuel) et « Liste ». La LISTE EST TOUJOURS RENDUE (U11) : au-dessus de 900 px elle reste
//   dans l'arbre d'accessibilité, hors de l'écran ; sous 900 px, carte.css la montre seule (§5.6). Elle est la vérité : toutes
//   les arêtes, une phrase chacune.
// - « Vue d'ensemble » (spéc. §5.2) : itération 5, NON LIVRÉE. Aucun libellé ne l'annonce (P3 : jamais annoncer une fonction
//   absente).
// - Élément : lu dans l'adresse, choisi par le sélecteur ou par un clic sur un nœud ; un élément inconnu de la carte ne vide
//   jamais la vue (repli sur « Vous »).
// Aucun texte écrit ici : tout vient d'agent-map-texts.ts (T4t). Aucune animation, aucun raccourci clavier, aucun focus pris.
import { useEffect, useId, useMemo, useState } from "react";
import { TEXTES } from "../../../../server/shared/agent-map-texts.ts";
import { Spinner, useAsync } from "../../../components/ui.tsx";
import { agentMapApi, agentMapError } from "../../../lib/api-agent-map.ts";
import { openAssistants } from "../../../lib/router.ts";
import type { CarteTabProps } from "../../chat/team/slots.ts";
import { elementMontre, groupesDuSelecteur, notesSousLaCarte, phrasesEtatVide } from "./carte-model.ts";
import { CarteCentree } from "./CarteCentree.tsx";
import { CarteComprendre } from "./CarteComprendre.tsx";
import { CarteListe } from "./CarteListe.tsx";
import "./carte.css";

const P = TEXTES.partout;

type Vue = "centree" | "liste";

/** Sélecteur d'élément : une liste par groupes (Assistants, Raccourcis, Équipes, Fiches) et une recherche qui la réduit. */
function Selecteur({
  groupes,
  valeur,
  recherche,
  onRecherche,
  onChoisir,
  labelId,
  rechercheId,
}: {
  groupes: ReturnType<typeof groupesDuSelecteur>;
  valeur: string;
  recherche: string;
  onRecherche(texte: string): void;
  onChoisir(id: string): void;
  labelId: string;
  rechercheId: string;
}) {
  return (
    <div className="ca-selecteur">
      <label className="ca-champ" htmlFor={rechercheId}>
        <span>{P.rechercher}</span>
        <input id={rechercheId} type="search" value={recherche} onChange={(event) => onRecherche(event.target.value)} />
      </label>
      <label className="ca-champ" htmlFor={labelId}>
        <span>{P.element}</span>
        <select id={labelId} value={valeur} onChange={(event) => onChoisir(event.target.value)}>
          {groupes.map((groupe) =>
            groupe.titre === null ? (
              groupe.options.map((option) => (
                <option key={option.id} value={option.id}>
                  {option.nom}
                </option>
              ))
            ) : (
              <optgroup key={groupe.titre} label={groupe.titre}>
                {groupe.options.map((option) => (
                  <option key={option.id} value={option.id}>
                    {option.nom}
                  </option>
                ))}
              </optgroup>
            ),
          )}
        </select>
      </label>
    </div>
  );
}

export function CarteTab({ directory, advanced, element }: CarteTabProps) {
  const baseId = useId();
  const { data, error, loading } = useAsync(() => agentMapApi.get({ directory, element }), [directory, element]);
  const [vue, setVue] = useState<Vue>("centree");
  const [recherche, setRecherche] = useState("");

  // Un dossier ou un élément qui change repart d'une recherche vide : la liste du sélecteur suit toujours ce qui est affiché.
  useEffect(() => setRecherche(""), [directory]);

  const montre = useMemo(() => (data === null ? null : elementMontre(data, element)), [data, element]);
  const groupes = useMemo(() => (data === null ? [] : groupesDuSelecteur(data, advanced, recherche)), [data, advanced, recherche]);
  const vides = useMemo(() => (data === null ? [] : phrasesEtatVide(data)), [data]);
  const notes = useMemo(() => (data === null ? [] : notesSousLaCarte(data)), [data]);

  const choisir = (id: string) => openAssistants({ mode: "carte", element: id });

  return (
    <div className="ca-onglet stack loose">
      <header className="ca-entete">
        <h2 className="ca-titre">{P.titre}</h2>
        <p className="ca-intro">{P.intro}</p>
      </header>
      <CarteComprendre titleId={`${baseId}-comprendre`} />

      {loading && data === null ? <Spinner label={P.titre} /> : null}
      {error === null || data !== null ? null : (
        <p className="callout critical ca-erreur" role="alert">
          {agentMapError(error)}
        </p>
      )}

      {data === null || montre === null ? null : (
        <>
          <div className="ca-barre">
            <Selecteur
              groupes={groupes}
              valeur={montre}
              recherche={recherche}
              onRecherche={setRecherche}
              onChoisir={choisir}
              labelId={`${baseId}-element`}
              rechercheId={`${baseId}-recherche`}
            />
            <div className="ca-vues-choix" role="group" aria-label={P.vues.libelle}>
              <button type="button" className="btn" aria-pressed={vue === "centree"} onClick={() => setVue("centree")}>
                {P.vues.centree}
              </button>
              <button type="button" className="btn" aria-pressed={vue === "liste"} onClick={() => setVue("liste")}>
                {P.vues.liste}
              </button>
            </div>
          </div>

          {vides.length === 0 ? null : (
            <div className="callout ca-etat-vide">
              {vides.map((phrase) => (
                <p key={phrase}>{phrase}</p>
              ))}
            </div>
          )}

          <div className={`ca-vues vue-${vue}`}>
            <div className="ca-bloc-centree">
              <CarteCentree result={data} advanced={advanced} element={montre} onChoisir={choisir} />
            </div>
            <div className="ca-bloc-liste">
              <CarteListe result={data} advanced={advanced} element={montre} onChoisir={choisir} />
            </div>
          </div>

          <footer className="ca-notes">
            <ul className="ca-notes-liste">
              {notes.map((note) => (
                <li key={note}>{note}</li>
              ))}
            </ul>
            <p className="ca-notes-deroule">{P.deroule}</p>
          </footer>
        </>
      )}
    </div>
  );
}
