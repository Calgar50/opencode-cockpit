// Propriétaire : NAV-3.
// Colonne de gauche, avant l'arborescence (fiche NAV §5, instruction 3) : « Modifiés récemment » (10 liens, puis « Voir plus »
// jusqu'à 30 ; dates relatives en mode Simple, complètes en mode Avancé) et recherche sur le NOM des fichiers (formulaire
// role="search", envoi sur Entrée ou au clic, jamais à chaque frappe), puis « Résultats de la recherche ». Un fichier est un lien
// (adresseFichiers) ; un dossier trouvé est un bouton qui le révèle dans l'arborescence et y donne le focus. Textes : TEXTES
// seulement ; noms montrés par rendreVisible, dans <bdi>.
import { type FormEvent, useEffect, useId, useRef, useState } from "react";
import { adresseFichiers, NAV_BORNES, rendreVisible, tailleLisible } from "../../../server/shared/fichiers-regles.ts";
import { phraseErreur, remplir, TEXTES } from "../../../server/shared/fichiers-texts.ts";
import type { RechercheReponse, RecentsReponse } from "../../../server/shared/fichiers-types.ts";
import { Icon } from "../../components/Icon.tsx";
import { Button } from "../../components/ui.tsx";
import { formatDateTime, relativeTime } from "../../lib/format.ts";

/** Réponse attendue, reçue, ou refusée (code des routes, ou « erreur »). */
export type Charge<T> = { phase: "chargement" } | { phase: "pret"; reponse: T } | { phase: "echec"; code: string };

/** Évènement de clic utile à la page (un clic avec touche de modification ouvre un autre onglet : ni focus ni retour). */
export interface ClicLien {
  button: number;
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
}

/** Récents visibles d'emblée, puis après « Voir plus » (RECENTS_MAX). */
const RECENTS_D_ABORD = 10;

export interface RecentsRechercheProps {
  projet: string;
  advanced: boolean;
  recents: Charge<RecentsReponse>;
  /** Dernière recherche envoyée, ou null. */
  recherche: { texte: string; etat: Charge<RechercheReponse> } | null;
  cheminOuvert: string | null;
  onChercher: (texte: string) => void;
  onReessayerRecents: () => void;
  onOuvrirFichier: (chemin: string, element: HTMLAnchorElement, evenement: ClicLien) => void;
  /** Dossier trouvé : révélé et déplié dans l'arborescence, avec le focus. */
  onRevelerDossier: (segments: string[]) => void;
}

/** Nom (dernier segment) et dossier parent d'un chemin, montrés par rendreVisible. */
function decouper(chemin: string): { nom: string; parent: string } {
  const segments = chemin.split("/");
  return { nom: rendreVisible(segments.at(-1) ?? ""), parent: rendreVisible(segments.slice(0, -1).join("/")) };
}

function Refus({ code, route, onReessayer }: { code: string; route: "recents" | "recherche"; onReessayer: () => void }) {
  return (
    <div className="fichiers-note fichiers-refus">
      <p>
        <Icon name="alert" size={14} />
        {phraseErreur(code, route)}
      </p>
      <Button size="sm" icon="refresh" onClick={onReessayer}>
        {TEXTES.partout.reessayer}
      </Button>
    </div>
  );
}

export function RecentsRecherche(props: RecentsRechercheProps) {
  const { projet, advanced, recents, recherche } = props;
  const idRecents = useId();
  const idResultats = useId();
  const idChamp = useId();
  const [saisie, setSaisie] = useState("");
  const [voirTout, setVoirTout] = useState(false);
  const premierDeLaSuite = useRef<HTMLAnchorElement | null>(null);

  // « Voir plus » disparaît après le clic : le focus passe au premier lien ajouté, jamais sur le corps de la page.
  useEffect(() => {
    if (voirTout) premierDeLaSuite.current?.focus();
  }, [voirTout]);

  const envoyer = (evenement: FormEvent) => {
    evenement.preventDefault();
    const texte = saisie.trim();
    if (texte !== "") props.onChercher(texte);
  };

  const lienFichier = (chemin: string, meta: string | null, suite = false) => {
    const { nom, parent } = decouper(chemin);
    return (
      <a
        className="fichiers-ligne"
        href={adresseFichiers({ projet, chemin })}
        aria-current={props.cheminOuvert === chemin ? "page" : undefined}
        ref={suite ? premierDeLaSuite : undefined}
        onClick={(evenement) => props.onOuvrirFichier(chemin, evenement.currentTarget, evenement)}
      >
        <Icon name="file" size={15} />
        <bdi>{nom}</bdi>
        <span className="fichiers-meta">
          {parent !== "" ? <bdi>{parent}</bdi> : null}
          {parent !== "" && meta !== null ? " · " : null}
          {meta}
        </span>
      </a>
    );
  };

  const fichiers = recents.phase === "pret" ? recents.reponse.fichiers : [];
  const montres = fichiers.slice(0, voirTout ? NAV_BORNES.RECENTS_MAX : RECENTS_D_ABORD);

  return (
    <>
      <section className="fichiers-bloc" aria-labelledby={idRecents}>
        <h2 id={idRecents}>{TEXTES.partout.recents}</h2>
        {recents.phase === "chargement" ? <p className="fichiers-note">{TEXTES.partout.chargement}</p> : null}
        {recents.phase === "echec" ? <Refus code={recents.code} route="recents" onReessayer={props.onReessayerRecents} /> : null}
        {recents.phase === "pret" && fichiers.length === 0 ? <p className="fichiers-note">{TEXTES.partout.recentsVides}</p> : null}
        {montres.length > 0 ? (
          <ul className="fichiers-liste fichiers-plate">
            {montres.map((fichier, i) => (
              <li key={fichier.chemin}>
                {lienFichier(
                  fichier.chemin,
                  `${tailleLisible(fichier.taille)} · ${advanced ? formatDateTime(fichier.modifieA) : relativeTime(fichier.modifieA)}`,
                  i === RECENTS_D_ABORD,
                )}
              </li>
            ))}
          </ul>
        ) : null}
        {!voirTout && fichiers.length > RECENTS_D_ABORD ? (
          <Button size="sm" variant="ghost" icon="chevronDown" onClick={() => setVoirTout(true)}>
            {TEXTES.partout.voirPlus}
          </Button>
        ) : null}
        {recents.phase === "pret" && recents.reponse.incomplet ? (
          <p className="fichiers-note">{remplir(TEXTES.partout.recentsPartiels, { n: recents.reponse.parcourus })}</p>
        ) : null}
        {recents.phase === "pret" && advanced && !recents.reponse.incomplet ? (
          <p className="fichiers-note">{remplir(TEXTES.avance.parcourus, { n: recents.reponse.parcourus })}</p>
        ) : null}
      </section>

      <form role="search" className="fichiers-bloc fichiers-recherche" onSubmit={envoyer}>
        <label htmlFor={idChamp}>{TEXTES.partout.chercher}</label>
        <div className="row">
          <input
            id={idChamp}
            className="input"
            type="search"
            maxLength={NAV_BORNES.RECHERCHE_MAX_CARACTERES}
            autoComplete="off"
            spellCheck={false}
            value={saisie}
            onChange={(evenement) => setSaisie(evenement.target.value)}
          />
          <Button type="submit" icon="search">
            {TEXTES.partout.boutonChercher}
          </Button>
        </div>
      </form>

      {recherche !== null ? (
        <section className="fichiers-bloc" aria-labelledby={idResultats}>
          <h2 id={idResultats}>{TEXTES.partout.resultats}</h2>
          {recherche.etat.phase === "chargement" ? <p className="fichiers-note">{TEXTES.partout.chargement}</p> : null}
          {recherche.etat.phase === "echec" ? (
            <Refus code={recherche.etat.code} route="recherche" onReessayer={() => props.onChercher(recherche.texte)} />
          ) : null}
          {recherche.etat.phase === "pret" ? (
            recherche.etat.reponse.resultats.length === 0 ? (
              <p className="fichiers-note">{remplir(TEXTES.partout.rechercheVide, { texte: recherche.texte })}</p>
            ) : (
              <ul className="fichiers-liste fichiers-plate">
                {recherche.etat.reponse.resultats.map((resultat) => {
                  if (resultat.type === "fichier") return <li key={resultat.chemin}>{lienFichier(resultat.chemin, null)}</li>;
                  const { nom, parent } = decouper(resultat.chemin);
                  return (
                    <li key={resultat.chemin}>
                      <button type="button" className="fichiers-ligne" onClick={() => props.onRevelerDossier(resultat.chemin.split("/"))}>
                        <Icon name="folder" size={15} />
                        <bdi>{nom}</bdi>
                        {parent !== "" ? (
                          <span className="fichiers-meta">
                            <bdi>{parent}</bdi>
                          </span>
                        ) : null}
                      </button>
                    </li>
                  );
                })}
              </ul>
            )
          ) : null}
          {recherche.etat.phase === "pret" && recherche.etat.reponse.incomplet ? (
            <p className="fichiers-note">{remplir(TEXTES.partout.recherchePartielle, { n: recherche.etat.reponse.parcourus })}</p>
          ) : null}
        </section>
      ) : null}
    </>
  );
}
