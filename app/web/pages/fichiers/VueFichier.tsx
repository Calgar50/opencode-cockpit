// Propriétaire : NAV-3.
// Vue d'un fichier de l'onglet « Fichiers » (fiche NAV §5, instruction 5), en LECTURE SEULE et en TEXTE SEUL : le contenu, déjà
// décodé, borné et masqué par le serveur, est rendu dans un seul nœud de texte React (échappé) ; ni HTML, ni Markdown, ni
// coloration syntaxique, aucun lien fabriqué à partir du contenu.
// - « Retour aux fichiers » en tête (seul moyen de revenir aux colonnes à 400 px) ; fil d'Ariane <nav><ol> de boutons qui révèlent
//   le dossier dans l'arborescence, dernier élément aria-current="location" ;
// - titre <h2 tabIndex={-1}> : il reçoit le focus seulement quand l'utilisateur a demandé l'ouverture (clic ou Entrée sur un lien),
//   jamais au rechargement ni au retour arrière ;
// - « Sur votre poste : … » et « Copier l'emplacement », masqués si le dossier de travail de l'hôte est inconnu ;
// - bandeaux en <p> avec icône et texte, sans région live : fichier long (en tête ET en fin), lignes coupées, passages masqués,
//   caractères invisibles, ancien format Windows ;
// - gouttière de numéros <pre aria-hidden="true">, masquée avec « Retour à la ligne » (actif par défaut en mode Simple) ;
// - états : binaire, vide, protégé, lien, plusieurs noms, pas un fichier, a changé (« Relire »), introuvable, occupé, coupé,
//   erreur (« Réessayer ») ; détails (encodage, octets, date complète) en mode Avancé seulement.
import { type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import { emplacementSurLePoste, rendreVisible, tailleLisible } from "../../../server/shared/fichiers-regles.ts";
import { phraseErreur, phraseInvisibles, phraseLignesCoupees, remplir, TEXTES } from "../../../server/shared/fichiers-texts.ts";
import type { ContenuReponse } from "../../../server/shared/fichiers-types.ts";
import { Icon, type IconName } from "../../components/Icon.tsx";
import { Button } from "../../components/ui.tsx";
import { formatDateTime, formatInt } from "../../lib/format.ts";
import type { Charge } from "./RecentsRecherche.tsx";

export interface VueFichierProps {
  projet: string;
  /** Chemin du fichier dans le projet (au moins un segment). */
  segments: readonly string[];
  contenu: Charge<ContenuReponse>;
  advanced: boolean;
  /** Dossier de travail sur le poste (COCKPIT_HOST_WORKSPACE_DIR), "" s'il est inconnu. */
  hostDir: string;
  /** Plus grand que 0 : l'utilisateur vient de demander l'ouverture, le titre reçoit le focus (une fois). */
  focus: number;
  onFocusFait: () => void;
  onRelire: () => void;
  onRetour: () => void;
  /** Dossier du fil d'Ariane ([] : le projet) : révélé dans l'arborescence, avec le focus. */
  onFil: (segments: string[]) => void;
  /** Résultat de « Copier l'emplacement » (annoncé par la page). */
  onCopie: (message: string) => void;
}

function Bandeau({ icone, children }: { icone: IconName; children: string }) {
  return (
    <p className="fichiers-bandeau">
      <Icon name={icone} size={15} />
      <span>{children}</span>
    </p>
  );
}

/** Phrase d'un refus de lecture ; « lien » a sa phrase Simple ou Avancé. */
function phraseRefus(code: string, advanced: boolean): string {
  if (code === "lien") return advanced ? TEXTES.avance.lienMessage : TEXTES.simple.lienMessage;
  return phraseErreur(code, "contenu");
}

/** Refus qui se relisent : « Relire » pour un fichier changé pendant la lecture, « Réessayer » pour un échec passager. */
function relecture(code: string): string | null {
  if (code === "a-change") return TEXTES.partout.relire;
  if (code === "occupe" || code === "illisible" || code === "erreur") return TEXTES.partout.reessayer;
  return null;
}

export function VueFichier(props: VueFichierProps) {
  const { projet, segments, contenu, advanced, onFocusFait } = props;
  const titre = useRef<HTMLHeadingElement>(null);
  const [retourALaLigne, setRetourALaLigne] = useState(!advanced);
  const [copie, setCopie] = useState<string | null>(null);
  const nom = rendreVisible(segments.at(-1) ?? "");
  const dossiers = segments.slice(0, -1);
  const emplacement = emplacementSurLePoste(props.hostDir, projet, segments);
  const [avantEmplacement = "", apresEmplacement = ""] = TEXTES.partout.emplacement.split("{chemin}");

  useEffect(() => {
    if (props.focus <= 0) return;
    titre.current?.focus();
    onFocusFait();
  }, [props.focus, onFocusFait]);

  const texte = contenu.phase === "pret" && contenu.reponse.etat === "texte" ? (contenu.reponse.texte ?? "") : null;
  const lignes = contenu.phase === "pret" ? contenu.reponse.lignes : 0;
  const numeros = useMemo(() => Array.from({ length: lignes }, (_, i) => String(i + 1)).join("\n"), [lignes]);

  const copier = () => {
    if (emplacement === null) return;
    const fini = (message: string) => {
      setCopie(message);
      props.onCopie(message);
    };
    const pressePapiers = typeof navigator === "undefined" ? undefined : navigator.clipboard;
    if (!pressePapiers) {
      fini(TEXTES.partout.copieImpossible);
      return;
    }
    pressePapiers.writeText(emplacement).then(
      () => fini(TEXTES.partout.emplacementCopie),
      () => fini(TEXTES.partout.copieImpossible),
    );
  };

  let corps: ReactNode = null;
  if (contenu.phase === "chargement") {
    corps = <p className="fichiers-note">{TEXTES.partout.chargement}</p>;
  } else if (contenu.phase === "echec") {
    const bouton = relecture(contenu.code);
    corps = (
      <div className="fichiers-refus">
        <Bandeau icone={contenu.code === "protege" ? "lock" : "alert"}>{phraseRefus(contenu.code, advanced)}</Bandeau>
        {contenu.code === "protege" && advanced ? (
          <details className="fichiers-pourquoi">
            <summary>{TEXTES.avance.pourquoi}</summary>
            <p>{TEXTES.avance.regles}</p>
          </details>
        ) : null}
        {bouton !== null ? (
          <div>
            <Button size="sm" icon="refresh" onClick={props.onRelire}>
              {bouton}
            </Button>
          </div>
        ) : null}
      </div>
    );
  } else {
    const reponse = contenu.reponse;
    const coupees = phraseLignesCoupees(reponse.lignesCoupees);
    const invisibles = phraseInvisibles(reponse.invisibles);
    corps = (
      <>
        {advanced ? (
          <p className="fichiers-note">
            {remplir(TEXTES.avance.details, { encodage: reponse.encodage ?? "—", octets: formatInt(reponse.taille), date: formatDateTime(reponse.modifieA) })}
          </p>
        ) : null}
        {reponse.etat === "binaire" ? <Bandeau icone="ban">{TEXTES.partout.binaire}</Bandeau> : null}
        {reponse.etat === "vide" ? <Bandeau icone="file">{TEXTES.partout.vide}</Bandeau> : null}
        {texte !== null ? (
          <>
            {reponse.tronque ? <Bandeau icone="alert">{remplir(TEXTES.partout.tropLong, { taille: tailleLisible(reponse.taille) })}</Bandeau> : null}
            {coupees !== null ? <Bandeau icone="alert">{coupees}</Bandeau> : null}
            {reponse.secretsMasques ? <Bandeau icone="lock">{TEXTES.partout.secretsMasques}</Bandeau> : null}
            {invisibles !== null ? <Bandeau icone="eye">{invisibles}</Bandeau> : null}
            {reponse.encodage === "windows-1252" ? <Bandeau icone="alert">{TEXTES.partout.ancienFormat}</Bandeau> : null}
            <div className="fichiers-outils">
              <Button size="sm" aria-pressed={retourALaLigne} onClick={() => setRetourALaLigne((actif) => !actif)}>
                {TEXTES.partout.retourALaLigne}
              </Button>
            </div>
            <div className={`fichiers-contenu${retourALaLigne ? " fichiers-contenu--retour" : ""}`}>
              {retourALaLigne ? null : (
                <pre className="fichiers-gouttiere" aria-hidden="true">
                  {numeros}
                </pre>
              )}
              <pre className="fichiers-texte" tabIndex={0} aria-label={remplir(TEXTES.partout.contenuDe, { nom, n: reponse.lignes })}>{texte}</pre>
            </div>
            {reponse.tronque ? <Bandeau icone="alert">{TEXTES.partout.finTronquee}</Bandeau> : null}
          </>
        ) : null}
      </>
    );
  }

  return (
    <div className="fichiers-vue">
      <div>
        <Button size="sm" icon="chevronLeft" onClick={props.onRetour}>
          {TEXTES.partout.retourFichiers}
        </Button>
      </div>
      <nav className="fichiers-fil" aria-label={TEXTES.partout.filAriane}>
        <ol>
          <li>
            <button type="button" className="fichiers-fil-lien" onClick={() => props.onFil([])}>
              <bdi>{projet === "" ? TEXTES.partout.racine : rendreVisible(projet)}</bdi>
            </button>
          </li>
          {dossiers.map((dossier, i) => (
            <li key={dossiers.slice(0, i + 1).join("/")}>
              <button type="button" className="fichiers-fil-lien" onClick={() => props.onFil(dossiers.slice(0, i + 1))}>
                <bdi>{rendreVisible(dossier)}</bdi>
              </button>
            </li>
          ))}
          <li>
            <span aria-current="location">
              <bdi>{nom}</bdi>
            </span>
          </li>
        </ol>
      </nav>
      <h2 className="fichiers-titre" tabIndex={-1} ref={titre}>
        <bdi>{nom}</bdi>
      </h2>
      {emplacement !== null ? (
        <div className="fichiers-emplacement">
          <p>
            {avantEmplacement}
            <bdi className="mono">{rendreVisible(emplacement)}</bdi>
            {apresEmplacement}
          </p>
          <div className="row wrap">
            <Button size="sm" icon="copy" onClick={copier}>
              {TEXTES.partout.copierEmplacement}
            </Button>
            {copie !== null ? <p className="fichiers-note">{copie}</p> : null}
          </div>
        </div>
      ) : null}
      {advanced ? <p className="fichiers-note">{remplir(TEXTES.avance.cheminRelatif, { chemin: rendreVisible(segments.join("/")) })}</p> : null}
      {corps}
    </div>
  );
}
