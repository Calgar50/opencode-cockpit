// Propriétaire : NAV-3.
// Arborescence de l'onglet « Fichiers » (fiche NAV §5, instruction 4 ; G2, G4) : motif de divulgation, jamais un arbre fait main.
// - <nav aria-label="Fichiers de {projet}"> et listes <ul> imbriquées ;
// - dossier : <button type="button" aria-expanded aria-controls> (icône aria-hidden, nom dans <bdi>) ; la liste enfant porte
//   aria-busy pendant le chargement ;
// - fichier : lien <a href={adresseFichiers(…)}>, aria-current="page" quand il est ouvert, taille et date en petit ;
// - lien, nom ambigu, élément spécial : <span> non interactif, avec icône et MOT d'état, jamais la couleur seule ;
// - sous chaque liste : éléments protégés (leur nombre seulement, « Pourquoi ? » en mode Avancé), liste tronquée, dossier vide.
// Clavier : aucune gestion propre (Tab, Entrée et Espace natifs des liens et des boutons), aucune touche seule. Textes : TEXTES
// (fichiers-texts.ts) seulement ; noms affichés par nomVisible (caractères invisibles montrés « ⟦U+XXXX⟧ ») dans <bdi>.
import { useId, useRef } from "react";
import { adresseFichiers, rendreVisible, tailleLisible } from "../../../server/shared/fichiers-regles.ts";
import { phraseErreur, phraseMasques, remplir, TEXTES } from "../../../server/shared/fichiers-texts.ts";
import type { EntreeVue } from "../../../server/shared/fichiers-types.ts";
import { Icon, type IconName } from "../../components/Icon.tsx";
import { Button } from "../../components/ui.tsx";
import { formatDateTime, relativeTime } from "../../lib/format.ts";
import type { DossierVisible, LigneVisible } from "./arbre-etat.ts";
import type { ClicLien } from "./RecentsRecherche.tsx";

export interface ArbreFichiersProps {
  /** Projet parcouru ("" : tout le dossier de travail). */
  projet: string;
  /** lignesVisibles(…) : le projet lui-même et ses dossiers dépliés. */
  racine: DossierVisible;
  advanced: boolean;
  /** Chemin du fichier ouvert (aria-current), ou null. */
  cheminOuvert: string | null;
  /** Déplier (true) ou replier (false) un dossier ; `nom` sert à l'annonce. */
  onBasculer: (chemin: string, deplier: boolean, nom: string) => void;
  onReessayer: (chemin: string) => void;
  /** Clic sur un fichier (le lien suit son adresse) : origine du retour et demande de focus. */
  onOuvrirFichier: (chemin: string, element: HTMLAnchorElement, clic: ClicLien) => void;
  /** Registre des éléments focalisables (dossiers et fichiers), pour révéler un dossier et y donner le focus. */
  enregistrer: (chemin: string, element: HTMLElement | null) => void;
}

/** Mot d'état et icône des éléments jamais ouverts. */
function special(type: EntreeVue["type"], advanced: boolean): { mot: string; icone: IconName } | null {
  const mots = advanced ? TEXTES.avance : TEXTES.simple;
  if (type === "lien") return { mot: mots.lien, icone: "external" };
  if (type === "douteux") return { mot: mots.douteux, icone: "alert" };
  if (type === "autre") return { mot: mots.autre, icone: "ban" };
  return null;
}

/** Date en petit : relative en mode Simple, complète en mode Avancé. */
function dateDe(modifieA: number | null, advanced: boolean): string | null {
  if (modifieA === null) return null;
  return advanced ? formatDateTime(modifieA) : relativeTime(modifieA);
}

export function ArbreFichiers(props: ArbreFichiersProps) {
  const { projet, racine } = props;
  const base = useId();
  const ids = useRef(new Map<string, string>());
  /** Identifiant stable de la liste d'un dossier (aria-controls). */
  const idDe = (chemin: string): string => {
    let id = ids.current.get(chemin);
    if (id === undefined) {
      id = `${base}-${ids.current.size}`;
      ids.current.set(chemin, id);
    }
    return id;
  };
  const nomProjet = projet === "" ? TEXTES.partout.racine : rendreVisible(projet);
  return (
    <nav className="fichiers-arbre" aria-label={remplir(TEXTES.partout.arbre, { projet: nomProjet })}>
      <Liste {...props} dossier={racine} id={idDe("")} idDe={idDe} racineDuProjet />
    </nav>
  );
}

interface ListeProps extends ArbreFichiersProps {
  dossier: DossierVisible;
  id: string;
  idDe: (chemin: string) => string;
  racineDuProjet?: boolean;
}

function Liste(props: ListeProps) {
  const { dossier, advanced, racineDuProjet = false } = props;
  const masques = phraseMasques(dossier.masques);
  const vide = dossier.charge && dossier.recues === 0 && dossier.masques === 0;
  return (
    <>
      <ul id={props.id} className="fichiers-liste" aria-busy={dossier.chargement}>
        {dossier.lignes.map((ligne) => (
          <Ligne key={ligne.entree.nom} {...props} ligne={ligne} />
        ))}
        {dossier.chargement ? <li className="fichiers-note">{TEXTES.partout.chargement}</li> : null}
      </ul>
      {dossier.erreur !== null && !dossier.chargement ? (
        <div className="fichiers-note fichiers-refus">
          <p>
            <Icon name="alert" size={14} />
            {phraseErreur(dossier.erreur, "dossier")}
          </p>
          <Button size="sm" icon="refresh" onClick={() => props.onReessayer(dossier.chemin)}>
            {TEXTES.partout.reessayer}
          </Button>
        </div>
      ) : null}
      {masques !== null ? (
        <div className="fichiers-note">
          <p>
            <Icon name="lock" size={14} />
            {masques}
          </p>
          {advanced ? (
            <details className="fichiers-pourquoi">
              <summary>{TEXTES.avance.pourquoi}</summary>
              <p>{TEXTES.avance.regles}</p>
            </details>
          ) : null}
        </div>
      ) : null}
      {dossier.tronque ? <p className="fichiers-note">{remplir(TEXTES.partout.tronqueListe, { n: dossier.recues })}</p> : null}
      {vide ? <p className="fichiers-note">{racineDuProjet && props.projet === "" ? TEXTES.partout.travailVide : TEXTES.partout.dossierVide}</p> : null}
    </>
  );
}

function Ligne(props: ListeProps & { ligne: LigneVisible }) {
  const { ligne, advanced, projet } = props;
  const { entree, chemin } = ligne;
  const nom = <bdi>{entree.nomVisible}</bdi>;
  if (entree.type === "dossier") {
    const deplie = ligne.contenu !== null;
    const id = props.idDe(chemin);
    return (
      <li className="fichiers-dossier">
        <button
          type="button"
          className="fichiers-ligne"
          aria-expanded={deplie}
          aria-controls={id}
          ref={(element) => props.enregistrer(chemin, element)}
          onClick={() => props.onBasculer(chemin, !deplie, entree.nomVisible)}
        >
          <Icon name={deplie ? "chevronDown" : "chevronRight"} size={14} />
          <Icon name="folder" size={15} />
          {nom}
        </button>
        {ligne.contenu !== null ? <Liste {...props} dossier={ligne.contenu} id={id} racineDuProjet={false} /> : <ul id={id} className="fichiers-liste" hidden />}
      </li>
    );
  }
  if (entree.type === "fichier") {
    const date = dateDe(entree.modifieA, advanced);
    return (
      <li>
        <a
          className="fichiers-ligne"
          href={adresseFichiers({ projet, chemin })}
          aria-current={props.cheminOuvert === chemin ? "page" : undefined}
          ref={(element) => props.enregistrer(chemin, element)}
          onClick={(evenement) => props.onOuvrirFichier(chemin, evenement.currentTarget, evenement)}
        >
          <Icon name="file" size={15} />
          {nom}
          <span className="fichiers-meta">
            {entree.taille !== null ? tailleLisible(entree.taille) : null}
            {entree.taille !== null && date !== null ? " · " : null}
            {date}
          </span>
        </a>
      </li>
    );
  }
  const etat = special(entree.type, advanced);
  return (
    <li>
      <span className="fichiers-ligne fichiers-special">
        <Icon name={etat?.icone ?? "alert"} size={15} />
        {nom}
        <span className="fichiers-etat">{etat?.mot}</span>
      </span>
    </li>
  );
}
