// Propriétaire : NAV-3.
// Onglet « Fichiers » (1.1, décisions A19 point 2, A21, A29 D14 (b) ; fiche NAV §5) : relire en LECTURE SEULE les fichiers des
// projets, dans les deux modes (mêmes données, mêmes refus du serveur : P2). Rien n'est modifié ni envoyé à une IA : la page
// n'appelle que les quatre routes POST de api-fichiers.ts.
// - Adresse : #/fichiers?projet=…&chemin=… (adresseFichiers, lireAdresse) ; une adresse invalide donne la vue par défaut et sa
//   phrase ; une adresse explicite révèle et ouvre l'élément, même caché en mode Simple ; ouvrir un fichier suit son lien (le retour
//   arrière du navigateur marche) ; déplier un dossier ne change pas l'adresse.
// - Projet : sélecteur LOCAL, par défaut le projet courant du chat ; il ne change jamais le projet du chat et n'offre aucune
//   action de conversation (D14 (b)) : les dossiers %XX, absents des projets proposés depuis la 1.0.6, s'atteignent par
//   « Tout le workspace ».
// - Focus : au titre du fichier seulement sur demande (clic ou Entrée sur un lien), jamais au rechargement ; « Retour aux fichiers »
//   le rend au lien d'origine. Annonces par l'annonceur de la page (G3), coupables par le réglage ; aucune autre région live.
// - 400 px (rupture à 720 px) : une colonne ; un fichier ouvert remplace les colonnes, « Retour aux fichiers » en tête.
import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { adresseFichiers, lireAdresse, projetNavigable, rendreVisible } from "../../../server/shared/fichiers-regles.ts";
import { remplir, TEXTES } from "../../../server/shared/fichiers-texts.ts";
import type { ContenuReponse, DossierReponse, RechercheReponse, RecentsReponse } from "../../../server/shared/fichiers-types.ts";
import { useApp } from "../../app/AppContext.tsx";
import { Icon } from "../../components/Icon.tsx";
import { Button } from "../../components/ui.tsx";
import { useAnnouncer } from "../../lib/announcer.ts";
import { codeFichiers, estAnnule, fichiersApi } from "../../lib/api-fichiers.ts";
import { goTo, useRouteQuery } from "../../lib/router.ts";
import type { ProjectInfo } from "../../lib/types.ts";
import { ArbreFichiers } from "./ArbreFichiers.tsx";
import { type ArbreEtat, echouer, fermer, lignesVisibles, ouvrir, recevoir, reveler, vider } from "./arbre-etat.ts";
import { type Charge, type ClicLien, RecentsRecherche } from "./RecentsRecherche.tsx";
import { VueFichier } from "./VueFichier.tsx";
import "./fichiers.css";

const AUCUN_SEGMENT: readonly string[] = Object.freeze([]);
const ETROIT = "(max-width: 720px)";

/** Projet courant du chat, s'il est parcourable ; sinon la racine (« Tout le workspace »). */
function projetParDefaut(project: ProjectInfo | null): string {
  return project !== null && !project.isRoot && projetNavigable(project.name) ? project.name : "";
}

/** Tâches d'une génération (projet, « Actualiser ») : annulées ensemble, listes en vol suivies pour n'être demandées qu'une fois. */
interface Generation {
  cle: string;
  controleur: AbortController;
  enVol: Set<string>;
}

export function FichiersPage() {
  const { boot, project, advanced, ui } = useApp();
  const dire = useAnnouncer(ui.activityAnnouncements);
  const query = useRouteQuery();
  const titreId = useId();
  const projetId = useId();

  // --- Adresse ---------------------------------------------------------------------------------------------------------------
  const parDefaut = projetParDefaut(project);
  const explicite = query.has("projet") || query.has("chemin");
  const adresse = useMemo(() => (explicite ? lireAdresse(query) : { projet: parDefaut, segments: [] }), [explicite, query, parDefaut]);
  const projet = adresse?.projet ?? parDefaut;
  const segments: readonly string[] = adresse?.segments ?? AUCUN_SEGMENT;
  const fichier = segments.length > 0 ? segments.join("/") : null;
  const cleFichier = fichier === null ? null : JSON.stringify([projet, fichier]);
  const options = useMemo(() => {
    const noms = boot.projects.filter((p) => !p.isRoot && projetNavigable(p.name)).map((p) => p.name);
    if (projet !== "" && !noms.includes(projet)) noms.push(projet);
    return noms;
  }, [boot.projects, projet]);

  // --- Arborescence (état pur, remis à zéro à chaque projet) -------------------------------------------------------------------
  const [generation, setGeneration] = useState(0);
  const cleGeneration = JSON.stringify([projet, generation]);
  const [arbreEtat, setArbreEtat] = useState(() => ({ projet, etat: ouvrir(vider(), "") }));
  if (arbreEtat.projet !== projet) setArbreEtat({ projet, etat: ouvrir(vider(), "") });
  const arbre = arbreEtat.etat;
  const setArbre = useCallback((maj: (etat: ArbreEtat) => ArbreEtat) => setArbreEtat((courant) => ({ ...courant, etat: maj(courant.etat) })), []);
  const [montrerCaches, setMontrerCaches] = useState(advanced);
  useEffect(() => setMontrerCaches(advanced), [advanced]);
  const montrerCachesRef = useRef(montrerCaches);
  montrerCachesRef.current = montrerCaches;

  const gen = useRef<Generation | null>(null);
  const generationCourante = (): Generation => {
    if (gen.current === null || gen.current.cle !== cleGeneration) {
      gen.current?.controleur.abort();
      gen.current = { cle: cleGeneration, controleur: new AbortController(), enVol: new Set() };
    }
    return gen.current;
  };
  // Démontage (et double montage du mode strict de React) : tout est annulé, la génération suivante repart de zéro.
  useEffect(
    () => () => {
      gen.current?.controleur.abort();
      gen.current = null;
    },
    [],
  );

  const elements = useRef(new Map<string, HTMLElement>());
  const enregistrer = useCallback((chemin: string, element: HTMLElement | null) => {
    if (element !== null) elements.current.set(chemin, element);
    else if (elements.current.get(chemin)?.isConnected === false) elements.current.delete(chemin);
  }, []);
  const zoneArbre = useRef<HTMLDivElement>(null);
  const annonceDossier = useRef<string | null>(null);

  const annoncerDossier = (chemin: string, reponse: DossierReponse) => {
    if (annonceDossier.current !== chemin) return;
    annonceDossier.current = null;
    const n = reponse.entrees.filter((entree) => montrerCachesRef.current || !(entree.cache || entree.genere)).length;
    dire(remplir(TEXTES.partout.annonceDossier, { nom: rendreVisible(chemin.split("/").at(-1) ?? ""), n }));
  };

  // Listes demandées : une requête par dossier, à sa première ouverture (ou après « Actualiser »).
  useEffect(() => {
    const g = generationCourante();
    for (const chemin of arbre.chargements) {
      if (g.enVol.has(chemin)) continue;
      g.enVol.add(chemin);
      fichiersApi.dossier(projet, chemin, g.controleur.signal).then(
        (reponse) => {
          if (gen.current !== g) return;
          g.enVol.delete(chemin);
          setArbre((etat) => recevoir(etat, chemin, reponse));
          annoncerDossier(chemin, reponse);
        },
        (erreur: unknown) => {
          if (gen.current !== g || estAnnule(erreur)) return;
          g.enVol.delete(chemin);
          setArbre((etat) => echouer(etat, chemin, codeFichiers(erreur) ?? "erreur"));
        },
      );
    }
  });

  // Adresse explicite : l'élément et ses dossiers sont révélés, même cachés ou générés.
  useEffect(() => {
    if (segments.length > 0) setArbre((etat) => reveler(etat, segments));
  }, [segments, arbreEtat.projet, setArbre]);

  const basculer = (chemin: string, deplier: boolean) => {
    if (!deplier) {
      setArbre((etat) => fermer(etat, chemin));
      return;
    }
    annonceDossier.current = chemin;
    const enCache = arbre.listes.get(chemin);
    setArbre((etat) => ouvrir(etat, chemin));
    if (enCache !== undefined) annoncerDossier(chemin, enCache);
  };

  // --- Fichier ouvert ----------------------------------------------------------------------------------------------------------
  const [contenu, setContenu] = useState<{ cle: string; etat: Charge<ContenuReponse> } | null>(null);
  const [relire, setRelire] = useState(0);
  const annonceFichier = useRef<string | null>(null);
  const annoncerFichier = (cle: string, reponse: ContenuReponse) => {
    if (annonceFichier.current !== cle) return;
    annonceFichier.current = null;
    if (reponse.etat === "texte") dire(remplir(TEXTES.partout.annonceFichier, { nom: rendreVisible(segments.at(-1) ?? ""), n: reponse.lignes }));
  };
  useEffect(() => {
    if (cleFichier === null || fichier === null) return;
    const controleur = new AbortController();
    let actif = true;
    setContenu({ cle: cleFichier, etat: { phase: "chargement" } });
    fichiersApi.contenu(projet, fichier, controleur.signal).then(
      (reponse) => {
        if (!actif) return;
        setContenu({ cle: cleFichier, etat: { phase: "pret", reponse } });
        annoncerFichier(cleFichier, reponse);
      },
      (erreur: unknown) => {
        if (actif && !estAnnule(erreur)) setContenu({ cle: cleFichier, etat: { phase: "echec", code: codeFichiers(erreur) ?? "erreur" } });
      },
    );
    return () => {
      actif = false;
      controleur.abort();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cleFichier, relire, generation]);

  // --- Récents et recherche ------------------------------------------------------------------------------------------------------
  const [recents, setRecents] = useState<{ cle: string; etat: Charge<RecentsReponse> } | null>(null);
  const [relireRecents, setRelireRecents] = useState(0);
  useEffect(() => {
    const controleur = new AbortController();
    let actif = true;
    setRecents({ cle: cleGeneration, etat: { phase: "chargement" } });
    fichiersApi.recents(projet, controleur.signal).then(
      (reponse) => actif && setRecents({ cle: cleGeneration, etat: { phase: "pret", reponse } }),
      (erreur: unknown) => {
        if (actif && !estAnnule(erreur)) setRecents({ cle: cleGeneration, etat: { phase: "echec", code: codeFichiers(erreur) ?? "erreur" } });
      },
    );
    return () => {
      actif = false;
      controleur.abort();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cleGeneration, relireRecents]);

  const [recherche, setRecherche] = useState<{ projet: string; texte: string; n: number; etat: Charge<RechercheReponse> } | null>(null);
  const chercher = (texte: string) => setRecherche((avant) => ({ projet, texte, n: (avant?.n ?? 0) + 1, etat: { phase: "chargement" } }));
  const numeroRecherche = recherche?.n ?? 0;
  useEffect(() => {
    if (recherche === null || recherche.etat.phase !== "chargement") return;
    const { projet: projetCherche, texte, n } = recherche;
    const controleur = new AbortController();
    const poser = (etat: Charge<RechercheReponse>) => setRecherche((courante) => (courante !== null && courante.n === n ? { ...courante, etat } : courante));
    fichiersApi.recherche(projetCherche, texte, controleur.signal).then(
      (reponse) => {
        poser({ phase: "pret", reponse });
        dire(remplir(TEXTES.partout.annonceResultats, { n: reponse.resultats.length }));
      },
      (erreur: unknown) => {
        if (!estAnnule(erreur)) poser({ phase: "echec", code: codeFichiers(erreur) ?? "erreur" });
      },
    );
    return () => controleur.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [numeroRecherche]);

  // --- Focus : titre sur demande, retour au lien d'origine, dossier révélé ---------------------------------------------------------
  const [demandeFocus, setDemandeFocus] = useState<{ cle: string; n: number } | null>(null);
  const focusFait = useCallback(() => setDemandeFocus(null), []);
  const origine = useRef<HTMLElement | null>(null);
  const retourDe = useRef<string | null>(null);
  const [focusDossier, setFocusDossier] = useState<string | null>(null);
  useEffect(() => setFocusDossier(null), [projet]);

  const ouvrirFichier = (chemin: string, element: HTMLAnchorElement, clic: ClicLien) => {
    // Clic avec une touche de modification : le navigateur ouvre un autre onglet, cette page ne change pas.
    if (clic.button !== 0 || clic.ctrlKey || clic.metaKey || clic.shiftKey || clic.altKey) return;
    const cle = JSON.stringify([projet, chemin]);
    origine.current = element;
    annonceFichier.current = cle;
    setFocusDossier(null);
    setDemandeFocus((avant) => ({ cle, n: (avant?.n ?? 0) + 1 }));
    if (cle === cleFichier && contenu?.cle === cle && contenu.etat.phase === "pret") annoncerFichier(cle, contenu.etat.reponse);
  };

  const retour = () => {
    retourDe.current = fichier;
    goTo(adresseFichiers({ projet }));
  };
  useEffect(() => {
    if (fichier !== null || retourDe.current === null) return;
    const chemin = retourDe.current;
    retourDe.current = null;
    const cible = origine.current?.isConnected ? origine.current : elements.current.get(chemin);
    cible?.focus();
  }, [fichier]);

  const revelerDossier = (dossier: string[]) => {
    if (dossier.length > 0) setArbre((etat) => reveler(etat, dossier, true));
    setFocusDossier(dossier.join("/"));
    // À 400 px, le fichier ouvert masque l'arborescence : on y revient pour montrer le dossier.
    if (fichier !== null && window.matchMedia(ETROIT).matches) goTo(adresseFichiers({ projet }));
  };
  useEffect(() => {
    if (focusDossier === null) return;
    const cible = focusDossier === "" ? zoneArbre.current?.querySelector<HTMLElement>("a, button") : elements.current.get(focusDossier);
    if (cible !== null && cible !== undefined && cible.offsetParent !== null) {
      cible.focus();
      setFocusDossier(null);
    }
  });

  // --- Actualiser : cache vidé, dossiers ouverts, récents et fichier relus ----------------------------------------------------------
  const actualiser = () => {
    setGeneration((n) => n + 1);
    setArbre((etat) => {
      let suivant = vider();
      for (const chemin of etat.ouverts) suivant = ouvrir(suivant, chemin);
      return segments.length > 0 ? reveler(suivant, segments) : suivant;
    });
  };

  const changerProjet = (nouveau: string) => {
    setFocusDossier(null);
    goTo(adresseFichiers({ projet: nouveau }));
  };

  const racine = useMemo(() => lignesVisibles(arbre, { montrerCaches }), [arbre, montrerCaches]);
  const etatRecents: Charge<RecentsReponse> = recents !== null && recents.cle === cleGeneration ? recents.etat : { phase: "chargement" };
  const etatContenu: Charge<ContenuReponse> = contenu !== null && contenu.cle === cleFichier ? contenu.etat : { phase: "chargement" };

  return (
    <section className={`page fichiers-page${fichier !== null ? " fichiers-page--fichier" : ""}`} aria-labelledby={titreId}>
      <header className="fichiers-entete">
        <div className="fichiers-titres">
          <div className="row wrap">
            <h1 id={titreId}>{TEXTES.partout.titre}</h1>
            <span className="badge fichiers-badge">
              <Icon name="lock" size={12} />
              {TEXTES.partout.badge}
            </span>
          </div>
          <p className="secondary">{TEXTES.partout.sousTitre}</p>
        </div>
        <div className="fichiers-projet">
          <label htmlFor={projetId}>{TEXTES.partout.projet}</label>
          <select id={projetId} className="select" value={projet} onChange={(evenement) => changerProjet(evenement.target.value)}>
            <option value="">{TEXTES.partout.racine}</option>
            {options.map((nom) => (
              <option key={nom} value={nom}>
                {rendreVisible(nom)}
              </option>
            ))}
          </select>
          <Button icon="refresh" onClick={actualiser}>
            {TEXTES.partout.actualiser}
          </Button>
        </div>
      </header>
      {adresse === null ? (
        <p className="fichiers-bandeau">
          <Icon name="alert" size={15} />
          <span>{TEXTES.partout.invalide}</span>
        </p>
      ) : null}
      <div className="fichiers-colonnes">
        <div className="fichiers-gauche">
          <RecentsRecherche
            key={projet}
            projet={projet}
            advanced={advanced}
            recents={etatRecents}
            recherche={recherche !== null && recherche.projet === projet ? { texte: recherche.texte, etat: recherche.etat } : null}
            cheminOuvert={fichier}
            onChercher={chercher}
            onReessayerRecents={() => setRelireRecents((n) => n + 1)}
            onOuvrirFichier={ouvrirFichier}
            onRevelerDossier={revelerDossier}
          />
          <label className="fichiers-caches">
            <input type="checkbox" checked={montrerCaches} onChange={(evenement) => setMontrerCaches(evenement.target.checked)} />
            {TEXTES.partout.afficherCaches}
          </label>
          <div ref={zoneArbre}>
            <ArbreFichiers
              projet={projet}
              racine={racine}
              advanced={advanced}
              cheminOuvert={fichier}
              onBasculer={basculer}
              onReessayer={(chemin) => setArbre((etat) => ouvrir(etat, chemin))}
              onOuvrirFichier={ouvrirFichier}
              enregistrer={enregistrer}
            />
          </div>
        </div>
        <div className="fichiers-droite">
          {fichier !== null && cleFichier !== null ? (
            <VueFichier
              key={cleFichier}
              projet={projet}
              segments={segments}
              contenu={etatContenu}
              advanced={advanced}
              hostDir={boot.workspace.hostDir ?? ""}
              focus={demandeFocus !== null && demandeFocus.cle === cleFichier ? demandeFocus.n : 0}
              onFocusFait={focusFait}
              onRelire={() => setRelire((n) => n + 1)}
              onRetour={retour}
              onFil={revelerDossier}
              onCopie={dire}
            />
          ) : (
            <p className="fichiers-choix">{TEXTES.partout.aucunChoix}</p>
          )}
        </div>
      </div>
    </section>
  );
}
