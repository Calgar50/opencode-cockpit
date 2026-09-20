// Propriétaire : L31b.
// Page « Salle de contrôle » (spécification §5.8 l.992-1009, §5.5 l.917-924, §5.6 l.926-928, §7.7 l.1172 ; plan d'exécution it3,
// fiche L31b ; D-3d-15, D-3d-17, D-3d-25, D-3d-28, D-3d-29 ; mesures EXEC/mesures/MX-3D.md §9.1 et §9.3) :
// #/salle-controle (zoom 1, projets), #/salle-controle/<racine> (zoom 2), #/salle-controle/<racine>/<session> (zoom 3), lues par
// useRoute ; fil d'Ariane, fluidité et repli 2D. Aucune entrée de navigation : l'accès passe par la bande, les Archives et
// l'adresse. Scene3d (L29d) et ZoomConversation (L31c) sont consommés par leurs seuls contrats (./slots-3d.ts).
// - P7 (§5.8 l.1009) : la liste en grille de boutons est TOUJOURS là, en 3D comme en 2D ; c'est elle la vérité, la scène n'est
//   qu'une image (canevas et mini-carte `aria-hidden`).
// - MX-3D §9.3 : aucune scène 3D — donc aucun WebGLRenderer — tant que `capacites()` n'a pas rendu un verdict 3D.
// - MX-3D §9.1 : la poignée d'`onReady` n'est remise à la sonde (`pret()`) que la page visible ; une page cachée ne reçoit aucune
//   image, et la bascule automatique en 2D n'est jamais gardée comme préférence du poste (D-3d-25).
// - §5.5 l.917 : aucune touche à un doigt hors du composant qui a le focus (les flèches appartiennent à la grille, Échap à la
//   boîte de dialogue de « Revoir »), et le focus n'est jamais volé : il ne bouge que sur une touche ou un clic de la personne.
// - D-3d-29 : aucune région `aria-live` ici ; les annonces passent par useAnnouncer(ui.activityAnnouncements).
// Textes : salle3d-texts.ts (T3d-b) seulement. Aucune animation, aucune boucle, aucune image demandée.
import { useCallback, useEffect, useId, useMemo, useRef, useState, useSyncExternalStore } from "react";
import type { NeonTheme } from "../../../server/shared/neon-palette.ts";
import type { NeonMode } from "../../../server/shared/neon-scene.ts";
import { libelleCompteurs, messageFluidite, TEXTES } from "../../../server/shared/salle3d-texts.ts";
import type { ConversationTerritoire, TerritoireView } from "../../../server/shared/salle3d-types.ts";
import { useApp } from "../../app/AppContext.tsx";
import { useAnnouncer } from "../../lib/announcer.ts";
import { formatUsd } from "../../lib/format.ts";
import { navigate, routeHref, useRoute } from "../../lib/router.ts";
import { REQUETE_MOUVEMENT_REDUIT } from "./fluidite.ts";
import { type EtatGrille, toucheGrille, totalCellules } from "./grille-clavier.ts";
import { RevoirEntree } from "./revoir/RevoirEntree.tsx";
import {
  cleZoom,
  doitMonterScene3d,
  type EchecScene,
  echec3d,
  type EtatSalle,
  etatInitial,
  naviguer,
  passer2d,
  peutRemettrePoignee,
  reessayer,
  rester3d,
  SECTION_SALLE,
  surveillance,
  type TransitionSalle,
  verdictSonde,
} from "./salle-etat.ts";
import { Scene3d } from "./Scene3d.tsx";
import type { Scene3dHandle } from "./slots-3d.ts";
import { Territoires2d } from "./Territoires2d.tsx";
import { useFluidite } from "./useFluidite.ts";
import { useTerritoires } from "./useTerritoires.ts";
import { ZoomConversation } from "./ZoomConversation.tsx";
import "./salle-controle.css";

/** Abonnement à une requête média (mouvement réduit) ou à la visibilité de la page, sans boucle ni minuterie. */
function abonnementMedia(requete: string): { abonner: (rappel: () => void) => () => void; lire: () => boolean } {
  return {
    abonner(rappel) {
      if (typeof window.matchMedia !== "function") return () => {};
      const liste = window.matchMedia(requete);
      liste.addEventListener("change", rappel);
      return () => liste.removeEventListener("change", rappel);
    },
    lire: () => typeof window.matchMedia === "function" && window.matchMedia(requete).matches,
  };
}

const MOUVEMENT_REDUIT = abonnementMedia(REQUETE_MOUVEMENT_REDUIT);
/** §5.6 l.928 : à 400 px, la liste seule. La vue n'est alors pas montée du tout — un canevas de taille nulle ne sert à rien. */
const ETROIT = abonnementMedia("(max-width:400px)");

function useMouvementReduit(): boolean {
  return useSyncExternalStore(MOUVEMENT_REDUIT.abonner, MOUVEMENT_REDUIT.lire, () => true);
}

function useEtroit(): boolean {
  return useSyncExternalStore(ETROIT.abonner, ETROIT.lire, () => false);
}

/** `document.visibilityState === "visible"` (MX-3D §9.1) : un onglet caché ne reçoit aucune image. */
function usePageVisible(): boolean {
  return useSyncExternalStore(
    (rappel) => {
      document.addEventListener("visibilitychange", rappel);
      return () => document.removeEventListener("visibilitychange", rappel);
    },
    () => document.visibilityState === "visible",
    () => true,
  );
}

/** Phrase dite sous la vue : proposition pendant la 3D, raison de la 2D après la bascule (§5.8 l.1006-1007). */
function phraseFluidite(etat: EtatSalle): string | null {
  if (etat.verdict.mode === "3d") return etat.proposition ? TEXTES.partout.fluidite.saccades : null;
  if (etat.message === null) return null;
  return etat.message.genre === "contexte-perdu" ? TEXTES.partout.contexte.perdu : messageFluidite(etat.message.raison);
}

// --- Liste en grille de boutons (la vérité, P7) ----------------------------------------------------------------------------------

interface LigneTerritoire {
  id: string;
  nom: string;
  /** Compteurs du projet ; null en mode Simple dans l'enceinte de la salle (D-3d-14 : ni compteur ni état en direct). */
  compteurs: string | null;
  conversations: readonly ConversationTerritoire[];
}

function GrilleConversations({
  titreId,
  lignes,
  cible,
  onCible,
  onOuvrir,
}: {
  titreId: string;
  lignes: readonly LigneTerritoire[];
  /** Territoire choisi dans la scène : la grille y place son curseur, puis rend la cible (le focus suit un geste, jamais volé). */
  cible: string | null;
  onCible: () => void;
  onOuvrir: (rootId: string) => void;
}) {
  const [index, setIndex] = useState(0);
  const conteneur = useRef<HTMLDivElement>(null);
  const tailles = useMemo(() => lignes.map((ligne) => ligne.conversations.length), [lignes]);
  const cellules = useMemo(() => lignes.flatMap((ligne) => ligne.conversations.map((conversation) => ({ ligne: ligne.id, conversation }))), [lignes]);
  const total = totalCellules(tailles);
  const courant = Math.min(Math.max(index, 0), Math.max(total - 1, 0));

  const focaliser = useCallback((vers: number) => {
    setIndex(vers);
    conteneur.current?.querySelector<HTMLButtonElement>(`[data-cellule="${vers}"]`)?.focus();
  }, []);

  // Territoire choisi dans la scène 3D : le curseur va sur sa première conversation et prend le focus (geste de la personne).
  useEffect(() => {
    if (cible === null) return;
    const vers = cellules.findIndex((cellule) => cellule.ligne === cible);
    onCible();
    if (vers >= 0) focaliser(vers);
  }, [cible, cellules, focaliser, onCible]);

  if (total === 0) return null;

  return (
    <div
      ref={conteneur}
      role="grid"
      aria-labelledby={titreId}
      className="salle3d-grille"
      onKeyDown={(evenement) => {
        const etat: EtatGrille = { lignes: tailles, index: courant, dansLaGrille: (evenement.target as HTMLElement).dataset?.cellule !== undefined };
        const action = toucheGrille(evenement, etat);
        if (action === null) return;
        evenement.preventDefault();
        if (action.type === "deplacer") return focaliser(action.index);
        const cellule = cellules[action.index];
        if (cellule) onOuvrir(cellule.conversation.rootId);
      }}
    >
      {lignes.map((ligne, rang) => (
        <div key={ligne.id} role="row" className="salle3d-ligne">
          <span role="rowheader" className="salle3d-projet">
            <span className="salle3d-nom">{ligne.nom}</span>
            {ligne.compteurs === null ? null : (
              <span className="salle3d-compteurs" title={TEXTES.partout.compteurs.coutAide}>
                {ligne.compteurs}
              </span>
            )}
          </span>
          {ligne.conversations.map((conversation, colonne) => {
            const position = tailles.slice(0, rang).reduce((somme, n) => somme + n, 0) + colonne;
            return (
              <span key={conversation.rootId} role="gridcell" className="salle3d-cellule">
                <button
                  type="button"
                  className="btn sm salle3d-conversation"
                  data-cellule={position}
                  tabIndex={position === courant ? 0 : -1}
                  onFocus={() => setIndex(position)}
                  onClick={() => onOuvrir(conversation.rootId)}
                >
                  {conversation.titre}
                </button>
              </span>
            );
          })}
        </div>
      ))}
    </div>
  );
}

/** Lignes d'un groupe de territoires ; `compteurs` absents en mode Simple dans l'enceinte de la salle (D-3d-14). */
function lignesDe(projets: readonly TerritoireView[], prefixe: string, avecCompteurs: boolean): LigneTerritoire[] {
  return projets.map((projet) => ({
    id: `${prefixe}:${projet.projet}`,
    nom: projet.nom,
    compteurs: avecCompteurs ? libelleCompteurs(projet.compteurs, formatUsd) : null,
    conversations: projet.conversations,
  }));
}

// --- Page --------------------------------------------------------------------------------------------------------------------

export function SalleControlePage() {
  const { ui, advanced, dark } = useApp();
  const route = useRoute();
  const fluidite = useFluidite();
  const visible = usePageVisible();
  const mouvementReduit = useMouvementReduit();
  const etroit = useEtroit();
  const dire = useAnnouncer(ui.activityAnnouncements);
  const mode: NeonMode = advanced ? "avance" : "simple";
  const theme: NeonTheme = dark ? "sombre" : "clair";
  const titreProjets = useId();
  const titreEnceinte = useId();

  const [etat, setEtat] = useState<EtatSalle>(() => etatInitial(route, fluidite.verdict));
  const [routeVue, setRouteVue] = useState(route);
  const [fluiditeVue, setFluiditeVue] = useState({ verdict: fluidite.verdict, proposition: fluidite.proposition });

  // Adresse et contrôle de fluidité reportés dans l'état de la page pendant le rendu (aucun aller-retour d'effet).
  if (routeVue !== route) {
    setRouteVue(route);
    setEtat((precedent) => naviguer(precedent, route).etat);
  }
  if (fluiditeVue.verdict !== fluidite.verdict || fluiditeVue.proposition !== fluidite.proposition) {
    const vu = fluiditeVue;
    setFluiditeVue({ verdict: fluidite.verdict, proposition: fluidite.proposition });
    setEtat((precedent) => {
      const apres = vu.verdict === fluidite.verdict ? precedent : verdictSonde(precedent, fluidite.verdict).etat;
      return surveillance(apres, fluidite.proposition).etat;
    });
  }

  const vue3d = doitMonterScene3d(etat);
  const rendu = vue3d ? "3d" : "2d";
  const { reponse, plan } = useTerritoires({ theme, mode, rendu, visible, actif: etat.zoom === 1 });

  const fluiditeRef = useRef(fluidite);
  fluiditeRef.current = fluidite;
  /** Seule porte vers le contrôle de fluidité (L30) : une transition automatique n'en passe aucune, donc n'écrit rien (D-3d-25). */
  const appliquer = useCallback((transition: TransitionSalle) => {
    setEtat(transition.etat);
    if (transition.action !== null) fluiditeRef.current[transition.action]();
  }, []);

  // Poignée de la scène 3D (onReady) : remise à la sonde seulement la page visible et la scène montée (MX-3D §9.1). La scène
  // n'est pas montée en 2D, ni au zoom 1 sous 400 px (liste seule, §5.6 l.928) : sa poignée est alors oubliée.
  const scenePosee = vue3d && (etat.zoom !== 1 || !etroit);
  const poignee = useRef<Scene3dHandle | null>(null);
  const [poigneeVue, setPoigneeVue] = useState(0);
  const pret = fluidite.pret;
  useEffect(() => {
    if (!scenePosee) poignee.current = null;
    const rendue = poignee.current;
    pret(rendue !== null && peutRemettrePoignee(etat, visible) ? rendue : null);
  }, [pret, etat, visible, scenePosee, poigneeVue]);

  const onReady = useCallback((rendue: Scene3dHandle) => {
    poignee.current = rendue;
    setPoigneeVue((vues) => vues + 1);
  }, []);
  const onFrame = useCallback((ms: number, anime: boolean) => fluiditeRef.current.image(ms, anime), []);
  const onEchec = useCallback((raison: EchecScene) => {
    poignee.current = null;
    setEtat((precedent) => echec3d(precedent, raison).etat);
  }, []);

  const phrase = phraseFluidite(etat);
  useEffect(() => {
    if (phrase !== null) dire(phrase);
  }, [phrase, dire]);

  // Projet et enceinte de la conversation montrée aux zooms 2 et 3, lus dans la dernière réponse connue (jamais inventés, P12).
  const situation = useMemo(() => {
    if (etat.rootId === null || reponse === null) return null;
    const groupes: Array<{ salle: boolean; projets: readonly TerritoireView[] }> = [
      { salle: false, projets: reponse.projets },
      { salle: true, projets: reponse.salle?.projets ?? [] },
    ];
    for (const groupe of groupes) {
      for (const projet of groupe.projets) {
        if (projet.conversations.some((conversation) => conversation.rootId === etat.rootId)) return { nom: projet.nom, salle: groupe.salle };
      }
    }
    return null;
  }, [reponse, etat.rootId]);

  const [cible, setCible] = useState<string | null>(null);
  const oublierCible = useCallback(() => setCible(null), []);
  const ouvrirZoom2 = useCallback((rootId: string) => navigate(SECTION_SALLE, rootId), []);

  const lignesProjets = useMemo(() => lignesDe(reponse?.projets ?? [], "projet", true), [reponse]);
  const lignesSalle = useMemo(() => lignesDe(reponse?.salle?.projets ?? [], "salle", advanced), [reponse, advanced]);
  const aRevoir = useMemo(
    () => (reponse?.salle?.projets ?? []).flatMap((projet) => projet.conversations.filter((conversation) => conversation.revoir)),
    [reponse],
  );
  const vide = etat.zoom === 1 && reponse !== null && lignesProjets.every((ligne) => ligne.conversations.length === 0) && lignesSalle.length === 0;

  return (
    <div className="page salle3d">
      <div className="salle3d-tete">
        <h1>{TEXTES.partout.titre}</h1>
        <nav aria-label={TEXTES.partout.filAriane.aria}>
          <ol className="salle3d-fil">
            <li>
              {etat.zoom === 1 ? (
                <span aria-current="page">{TEXTES.partout.filAriane.projets}</span>
              ) : (
                <a href={routeHref(SECTION_SALLE)}>{TEXTES.partout.filAriane.projets}</a>
              )}
            </li>
            {etat.zoom >= 2 && etat.rootId !== null ? (
              <li>
                {etat.zoom === 2 ? (
                  <span aria-current="page">{situation?.nom ?? etat.rootId}</span>
                ) : (
                  <a href={routeHref(SECTION_SALLE, etat.rootId)}>{situation?.nom ?? etat.rootId}</a>
                )}
              </li>
            ) : null}
            {/* Zoom 3 : la page ne connaît pas le nom de l'assistant (il vient des faits de la conversation, lus par le zoom) :
                elle montre l'identifiant reçu dans l'adresse, jamais un nom inventé (P12). */}
            {etat.zoom === 3 && etat.sessionId !== null ? (
              <li>
                <span aria-current="page" className="salle3d-identifiant">
                  {etat.sessionId}
                </span>
              </li>
            ) : null}
          </ol>
        </nav>
      </div>

      {phrase === null ? null : (
        <div className="salle3d-fluidite">
          <p>
            {phrase}
            {etat.verdict.mode === "3d" && etat.proposition ? ` ${TEXTES.partout.fluidite.basculeProche}` : ""}
          </p>
          {etat.verdict.mode === "3d" && etat.proposition ? (
            <>
              <button type="button" className="btn sm" onClick={() => appliquer(passer2d(etat))}>
                {TEXTES.partout.fluidite.passer2d}
              </button>
              <button type="button" className="btn sm" onClick={() => appliquer(rester3d(etat))}>
                {TEXTES.partout.fluidite.rester3d}
              </button>
            </>
          ) : (
            <button type="button" className="btn sm" onClick={() => appliquer(reessayer(etat))}>
              {TEXTES.partout.fluidite.reessayer}
            </button>
          )}
        </div>
      )}

      {etat.zoom === 1 ? (
        <div className="salle3d-zoom1">
          {etroit ? null : (
            <div className="salle3d-vue">
              {vue3d ? (
                <Scene3d plan={plan} mouvementReduit={mouvementReduit} suivre={null} onSelect={setCible} onFrame={onFrame} onReady={onReady} onEchec={onEchec} />
              ) : (
                <Territoires2d plan={plan} theme={theme} />
              )}
            </div>
          )}
          <div className="salle3d-listes">
            <section className="salle3d-section" aria-labelledby={titreProjets}>
              <h2 id={titreProjets}>{TEXTES.partout.filAriane.projets}</h2>
              <p className="salle3d-note">{TEXTES.partout.aucunFaisceau}</p>
              {vide ? <p className="salle3d-note">{TEXTES.partout.vide}</p> : null}
              <GrilleConversations titreId={titreProjets} lignes={lignesProjets} cible={cible} onCible={oublierCible} onOuvrir={ouvrirZoom2} />
            </section>
            {reponse?.salle ? (
              <section className="salle3d-section salle3d-enceinte" aria-labelledby={titreEnceinte}>
                <h2 id={titreEnceinte}>{advanced ? TEXTES.avance.enceinte : TEXTES.simple.enceinte}</h2>
                {advanced ? (
                  <GrilleConversations titreId={titreEnceinte} lignes={lignesSalle} cible={cible} onCible={oublierCible} onOuvrir={ouvrirZoom2} />
                ) : (
                  <>
                    <p className="salle3d-note">{TEXTES.simple.enceinteRevoir}</p>
                    <ul className="salle3d-revoir">
                      {aRevoir.map((conversation) => (
                        <li key={conversation.rootId}>
                          <span className="salle3d-nom">{conversation.titre}</span>
                          <RevoirEntree rootId={conversation.rootId} placement="zoom1" />
                        </li>
                      ))}
                    </ul>
                  </>
                )}
              </section>
            ) : null}
          </div>
        </div>
      ) : etat.rootId === null ? null : (
        <ZoomConversation
          key={cleZoom(etat)}
          rootId={etat.rootId}
          sessionId={etat.sessionId}
          mode={mode}
          theme={theme}
          salle={situation?.salle ?? false}
          vue3d={vue3d}
          mouvementReduit={mouvementReduit}
          onEchec3d={onEchec}
          onFrame={onFrame}
          onReady={onReady}
          onZoom={(vers) => (vers.zoom === 2 ? navigate(SECTION_SALLE, vers.rootId) : navigate(SECTION_SALLE, vers.rootId, vers.sessionId))}
        />
      )}
    </div>
  );
}
