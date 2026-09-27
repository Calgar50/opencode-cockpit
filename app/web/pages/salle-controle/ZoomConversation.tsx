// Propriétaire : L31c.
// Zooms 2 et 3 d'une conversation dans la salle de contrôle (spécification §5.8 l.992-1009, §5.5 l.917-924, §5.6 l.928 ;
// plan d'exécution it3, fiche L31c, D-3d-11, D-3d-12, D-3d-17, D-3d-18, D-3d-28, D-3d-29, M20, U2), en 3D ou en repli 2D, en
// direct et en différé. Propriétés FIGÉES dans ./slots-3d.ts ; les parties pures sont dans ./useFaitsConversation.ts.
//
// - CADENCE : les faits arrivent par useFaitsConversation, qui les fait passer par la file de la bande (au plus 4 recalculs par
//   seconde). La salle de contrôle n'écrit JAMAIS « Affichage rattrapé » et n'enregistre aucun fait `affichage` (fiche L31c).
// - MARQUE : chaque recalcul pose `performance.mark("salle3d:plan", {detail: {zoom, rendu}})`, en 3D ET en repli 2D (M20,
//   D-3d-18) ; l'e2e de L35 compte ces marques dans les deux rendus.
// - LECTEUR : l'état vit ICI, jamais dans la page ; la clé React donnée par L31b ne dépend pas du verdict de fluidité, donc la
//   position du différé survit au passage en 2D. « Figer ici » gèle la liste des faits : le différé lit une liste stable pendant
//   que le direct continue d'arriver. [Revenir au direct] la relâche.
// - DIRECT / DIFFÉRÉ (D-3d-12, U2) : en direct, les textes de message sont relus dans la conversation, comme la bande 2D, et
//   rendus en TEXTE (échappé par React, jamais en HTML). En différé, AUCUN texte de message n'est relu : le panneau du zoom 3
//   est celui de « Revoir » (PanneauRevoir), donc « Texte non affiché pendant « Revoir » » partout, SAUF la consigne reçue, lue
//   par ConsigneRevoir dans la copie gardée par le cockpit, sans aucune requête à opencode.
// - [VOIR LA CONSIGNE] d'une légende : en différé, ConsigneRevoir (copie gardée, aucune requête à opencode). EN DIRECT ET EN
//   MODE AVANCÉ, le zoom 3 de l'assistant visé, dont la section « Consigne reçue » relit le texte réel dans la conversation,
//   comme la bande : c'est le même texte, à sa source. ÉCART assumé avec la fiche, qui écrit « le tiroir existant » : le tiroir
//   de la page de conversation ne peut pas être ouvert d'ici (son état est local à cette page) et son nom est interdit dans
//   salle-controle/** par la règle de lecture seule de L28c (D-3d-12 : [Voir la consigne] ne passe jamais par ce tiroir, qui
//   relit la conversation en direct). En mode Simple et en direct, aucun bouton n'est offert.
// - SALLE OMO EN MODE SIMPLE (D-3d-14, §5.9) : aucune vue en direct ; seulement « Revoir » d'une demande terminée, si l'accès
//   est donné. C'est la même entrée que le zoom 1 et les Archives (RevoirEntree, L28b).
// - ACCESSIBILITÉ : le canevas 3D est aria-hidden (Scene3d) ; la vérité reste la liste et le tableau, qui sont toujours là.
//   AUCUNE région aria-live ici : la page n'en a qu'une (D-3d-29), et les légendes passent par elle (LegendeBulle).
// - LIBÉRATION (D-3d-28) : changer de zoom remonte Scene3d, qui libère son moteur ; ce n'est jamais une bascule en 2D.
// - SALLE BRANCHÉE (« 3s », L3s-a) : les assistants d'une conversation de la salle sont rangés par leur RÔLE, lu sur la clé de
//   l'agent (roleDeAgent, comme la bande : différé = direct) ; en Avancé, le bandeau de l'enceinte de la salle (JP-10) est écrit
//   au-dessus de la vue, en 3D comme en 2D.
// - DÉROULÉ PARTIEL (A36 point 1, spéc. l.356) : au-delà de 3 niveaux ou de 50 assistants, la scène ne dessine pas le surplus ;
//   « Déroulé partiel : {n} assistants non dessinés » est écrit au-dessus de la vue, en 3D comme en repli 2D (DeroulePartiel),
//   distinct de la note des faits partiels (borne du magasin).
import { useEffect, useId, useMemo, useRef, useState } from "react";
import type { ActivityFact } from "../../../server/shared/activity-types.ts";
import { TEXTES as ACTIVITE } from "../../../server/shared/activity-texts.ts";
import { legendesAuMoment } from "../../../server/shared/legendes.ts";
import { libelleNoeud, NEON_RELECTURE_MS, texteDuMessage } from "../../../server/shared/neon-band.ts";
import { planConversation } from "../../../server/shared/neon-plan3d.ts";
import type { NeonDetail, NeonScene } from "../../../server/shared/neon-scene.ts";
import { scene, visibleCount } from "../../../server/shared/neon-scene.ts";
import { libelleEtat, libelleOutil, remplir, TEXTES as NEON } from "../../../server/shared/neon-texts.ts";
import { roleDeAgent } from "../../../server/shared/omo-roles.ts";
import { cibleASuivre, instant } from "../../../server/shared/revoir.ts";
import { TEXTES as REVOIR } from "../../../server/shared/revoir-texts.ts";
import { TEXTES as SALLE } from "../../../server/shared/salle3d-texts.ts";
import type { ConversationTerritoire, Plan3d } from "../../../server/shared/salle3d-types.ts";
import { useApp } from "../../app/AppContext.tsx";
import { oc } from "../../lib/api.ts";
import { salle3dApi } from "../../lib/api-salle3d.ts";
import { NeonCarte, NeonTableau } from "../chat/activity/NeonBand.tsx";
import { DeroulePartiel } from "./DeroulePartiel.tsx";
import { ConsigneRevoir } from "./revoir/ConsigneRevoir.tsx";
import { LegendeBulle } from "./revoir/LegendeBulle.tsx";
import { PanneauRevoir } from "./revoir/PanneauRevoir.tsx";
import { ReplayBar } from "./revoir/ReplayBar.tsx";
import { RevoirEntree } from "./revoir/RevoirEntree.tsx";
import { useReplay } from "./revoir/useReplay.ts";
import { Scene3d } from "./Scene3d.tsx";
import type { ConsigneRevoirProps, ZoomConversationProps } from "./slots-3d.ts";
import {
  cheminsDesTuiles,
  cibleSuivre,
  directServi,
  dossierDuProjet,
  libelleTuile,
  optionsScene,
  type TextesPanneau,
  textesPanneau,
  useFaitsConversation,
  useMarquePlan,
  usePrecedent,
  zoomDe,
} from "./useFaitsConversation.ts";
import "./zoom-conversation.css";

/** Valeur absente : un tiret, comme le panneau du zoom 3 de la bande (aucun texte inventé, P12). */
const RIEN = "—";

export function ZoomConversation(props: ZoomConversationProps) {
  // Une racine de la Salle OMO en mode Simple n'a pas de vue en direct : la salle est réservée au mode Avancé (D-3d-14).
  if (!directServi({ salle: props.salle, mode: props.mode })) return <SalleSimple rootId={props.rootId} />;
  return <Zoom {...props} />;
}

/**
 * Racine de la Salle OMO en mode Simple (§5.9 l.1018-1024, D-3d-14) : aucune vue en direct, aucun compteur, aucun nom de rôle de
 * l'extension. Seulement « Revoir » d'une demande terminée, par la MÊME entrée que le zoom 1 (RevoirEntree, L28b), qui n'offre
 * rien tant que l'accès n'est pas donné (P3 : jamais une commande montrée comme disponible).
 */
function SalleSimple({ rootId }: { rootId: string }) {
  return (
    <section className="zoom-conv zoom-conv-simple">
      <p className="zoom-conv-note">{SALLE.simple.enceinte}</p>
      <p className="zoom-conv-note">{SALLE.simple.enceinteRevoir}</p>
      <RevoirEntree rootId={rootId} placement="zoom1" />
    </section>
  );
}

function Zoom({ rootId, sessionId, mode, theme, salle, vue3d, mouvementReduit, onEchec3d, onFrame, onReady, onZoom }: ZoomConversationProps) {
  const { boot } = useApp();
  const titreId = useId();
  const avance = mode === "avance";
  const zoom = zoomDe(sessionId);
  const { faits, partiel, chargement, echec } = useFaitsConversation(rootId);

  // Différé : liste des faits GELÉE au moment où l'utilisateur quitte le direct. Le direct continue d'arriver dans `faits`, mais
  // le lecteur lit `gel`, dont l'identité ne change plus : useReplay ne rouvre donc pas sa fenêtre à chaque nouveau fait.
  const [gel, setGel] = useState<readonly ActivityFact[] | null>(null);
  const [suivreActif, setSuivreActif] = useState(false);
  const [consigne, setConsigne] = useState<ConsigneRevoirProps["cible"] | null>(null);
  const consigneRef = useRef<HTMLDivElement>(null);
  const retourConsigneRef = useRef<HTMLElement | null>(null);
  const direct = gel === null;
  const liste = gel ?? faits;
  const lecteur = useReplay(liste, null);
  // `setGel(faits)` garde l'identité de la liste : le lecteur passe en différé sur son moment courant, sans être rouvert.
  const geler = () => {
    if (gel === null) setGel(faits);
  };
  const revenirAuDirect = () => {
    setGel(null);
    setSuivreActif(false);
    lecteur.actions.direct();
  };

  const t = direct ? null : instant(lecteur.etat);
  const montres = useMemo(() => liste.slice(0, visibleCount(liste, t)), [liste, t]);
  // Rôles de la salle lus par clé de configuration, comme la bande (L3s-a) : sans effet hors de la salle (neon-scene.ts).
  const vue = useMemo<NeonScene>(() => scene(montres, null, { ...optionsScene({ salle, mode }, sessionId), roleSalle: roleDeAgent }), [montres, salle, mode, sessionId]);
  const plan = useMemo<Plan3d | null>(() => (vue3d ? planConversation(vue, { theme, mode: vue.mode }) : null), [vue, vue3d, theme]);
  useMarquePlan(vue, zoom, vue3d ? "3d" : "2d");

  // « Suivre l'action » (différé et 3D seulement, §5.8 l.998) : premier signe changé entre le moment précédent et celui-ci.
  const vuePrecedente = usePrecedent(vue);
  const aSuivre = useMemo(() => (vuePrecedente === null ? null : cibleASuivre(vuePrecedente, vue)), [vuePrecedente, vue]);
  const suivre = suivreActif && plan !== null && !direct ? cibleSuivre(plan, aSuivre) : null;

  const legendes = useMemo(() => legendesAuMoment(liste, t, { salle }), [liste, t, salle]);
  const conversations = useConversationsDuProjet(rootId);
  const dossier = conversations === null ? undefined : dossierDuProjet(boot.workspace.root, conversations.projet);
  const moment = lecteur.etat.moments[lecteur.etat.index] ?? null;
  const detail = vue.detail;

  const ouvrirConsigne = (cible: ConsigneRevoirProps["cible"], session: string | null) => {
    // En différé, la copie gardée par le cockpit (U2). En direct et en mode Avancé, le panneau du zoom 3, dont la section
    // « Consigne reçue » relit le texte réel dans la conversation, comme la bande : c'est le même texte, à sa source.
    if (!direct) {
      retourConsigneRef.current = document.activeElement as HTMLElement | null;
      setConsigne(cible);
    } else if (session !== null) onZoom({ zoom: 3, rootId, sessionId: session });
  };
  // Panneau du zoom 3 : relu dans la conversation EN DIRECT ; en différé, celui de « Revoir », qui ne relit rien (D-3d-12, U2).
  const retourAuZoom2 = () => onZoom({ zoom: 2, rootId });
  let panneauDuZoom3 = null;
  if (detail !== null && direct) panneauDuZoom3 = <PanneauDirect vue={vue} detail={detail} dossier={dossier} onRetour={retourAuZoom2} />;
  else if (detail !== null) {
    panneauDuZoom3 = <PanneauRevoir vue={vue} detail={detail} faits={montres} onRetour={retourAuZoom2} onVoirConsigne={(cible) => ouvrirConsigne(cible, null)} />;
  }

  const fermerConsigne = () => {
    setConsigne(null);
    retourConsigneRef.current?.focus?.();
    retourConsigneRef.current = null;
  };
  useEffect(() => {
    if (consigne !== null) consigneRef.current?.focus();
  }, [consigne]);

  return (
    <section className="zoom-conv" aria-labelledby={titreId}>
      <h2 className="visually-hidden" id={titreId}>
        {SALLE.partout.titre}
      </h2>
      <div className="zoom-conv-tete">
        {conversations === null ? null : <ChoixConversation projet={conversations} rootId={rootId} onChoisir={(autre) => onZoom({ zoom: 2, rootId: autre })} />}
        {partiel ? <p className="zoom-conv-note">{REVOIR.partout.partiel}</p> : null}
        {/* Scène bornée (A36 point 1) : même phrase que la bande, en 3D comme en repli 2D. */}
        <DeroulePartiel horsBornes={vue.horsBornes} className="zoom-conv-note" />
        {/* Enceinte de la Salle OMO (JP-10, mode Avancé) : son bandeau, écrit en toutes lettres comme dans la bande. */}
        {vue.enceinte === null ? null : <p className="zoom-conv-note">{SALLE.avance.enceinte}</p>}
        {direct ? null : <p className="zoom-conv-bandeau">{REVOIR.partout.rienRelance}</p>}
      </div>
      <ReplayBar
        index={lecteur.etat.index}
        total={lecteur.etat.moments.length}
        heure={moment}
        vitesse={lecteur.etat.vitesse}
        lecture={lecteur.etat.lecture}
        direct={direct}
        raccourciMs={lecteur.raccourciMs}
        suivre={vue3d && !direct ? suivreActif : null}
        onLire={() => {
          geler();
          lecteur.actions.lire();
        }}
        onFiger={() => {
          geler();
          lecteur.actions.figer();
        }}
        onPrecedent={() => {
          geler();
          lecteur.actions.precedent();
        }}
        onSuivant={() => {
          geler();
          lecteur.actions.suivant();
        }}
        onAller={(index) => {
          geler();
          lecteur.actions.aller(index);
        }}
        onVitesse={lecteur.actions.vitesse}
        onDirect={direct ? undefined : revenirAuDirect}
        onSuivre={setSuivreActif}
      />
      <div className="zoom-conv-corps" aria-busy={chargement}>
        {echec ? <p className="zoom-conv-note">{ACTIVITE.partout.lectureImpossible}</p> : null}
        {/* Vue : la scène 3D, ou le repli 2D (la carte de la bande, sur la MÊME vue). Le tableau et la liste sont toujours là :
            c'est la vérité de la vue (§5.8 l.1009, P7), et à 400 px la liste reste seule.
            Au zoom 3, la carte 2D garde la conversation entière (NeonZoom3 n'est pas exporté par la bande, D-3d-12) : le détail
            de l'assistant est le panneau, en dessous. En 3D, le plan porte déjà les tuiles et les outils du zoom 3. */}
        {plan === null ? (
          <div className="zoom-conv-vue">
            <NeonCarte vue={vue} />
          </div>
        ) : (
          <div className="zoom-conv-vue zoom-conv-3d">
            {/* Changer de zoom remonte la scène, qui libère son moteur : jamais une bascule en 2D (D-3d-28). */}
            <Scene3d
              key={`zoom${zoom}`}
              plan={plan}
              mouvementReduit={mouvementReduit}
              suivre={suivre}
              onSelect={(id) => onZoom({ zoom: 3, rootId, sessionId: id })}
              onFrame={onFrame}
              onReady={onReady}
              onEchec={onEchec3d}
            />
          </div>
        )}
        <div className="zoom-conv-tableau">
          <NeonTableau vue={vue} />
        </div>
        <ListeAssistants vue={vue} onOuvrir={(session) => onZoom({ zoom: 3, rootId, sessionId: session })} />
        {panneauDuZoom3}
        <div className="zoom-conv-legendes">
          {legendes.map((legende, i) => {
            const callId = legende.callId;
            const offert = callId !== null && (!direct || avance);
            return (
              <LegendeBulle
                key={`${i}:${legende.ancre.genre}:${legende.ancre.id}:${legende.cles.join("+")}`}
                cles={legende.cles}
                salle={salle}
                mode={vue.mode}
                onVoirConsigne={offert && callId !== null ? () => ouvrirConsigne({ callId }, legende.sessionId) : undefined}
              />
            );
          })}
        </div>
      </div>
      {consigne === null ? null : (
        // Le panneau de la consigne prend le focus à son ouverture ; [Fermer la consigne] le rend au bouton qui l'a ouvert.
        <div className="zoom-conv-consigne" ref={consigneRef} tabIndex={-1}>
          <ConsigneRevoir rootId={rootId} cible={consigne} onFermer={fermerConsigne} />
        </div>
      )}
    </section>
  );
}

/**
 * Liste des assistants dessinés : la VÉRITÉ de la vue (P7, §5.8 l.1009). Un vrai bouton par assistant, dans l'ordre de la scène,
 * avec son nom et son état ; à 400 px, c'est la seule chose montrée (zoom-conversation.css).
 */
function ListeAssistants({ vue, onOuvrir }: { vue: NeonScene; onOuvrir: (sessionId: string) => void }) {
  const id = useId();
  if (vue.noeuds.length === 0) return null;
  return (
    <nav className="zoom-conv-liste" aria-labelledby={id}>
      <h3 className="visually-hidden" id={id}>
        {SALLE.partout.liste}
      </h3>
      <ul>
        {vue.noeuds.map((noeud) => (
          <li key={noeud.sessionId}>
            <button type="button" className="btn sm ghost" onClick={() => onOuvrir(noeud.sessionId)}>
              {libelleNoeud(noeud)}
            </button>
          </li>
        ))}
      </ul>
    </nav>
  );
}

/** Conversations du projet de la racine montrée (sélecteur du zoom 2, D-3d-15). */
interface ProjetDeLaRacine {
  /** Chemin du projet relatif à la racine du workspace (TerritoireView.projet). */
  projet: string;
  conversations: readonly ConversationTerritoire[];
}

/**
 * Projet de la racine montrée, lu UNE fois à l'ouverture (GET /api/salle-controle/territoires, lecture seule). Sert au sélecteur
 * « Conversations de ce projet » et au dossier dans lequel relire les textes en direct. Une lecture en échec n'offre pas de
 * sélecteur : rien n'est supposé.
 */
function useConversationsDuProjet(rootId: string): ProjetDeLaRacine | null {
  const [projet, setProjet] = useState<ProjetDeLaRacine | null>(null);
  useEffect(() => {
    const abandon = new AbortController();
    setProjet(null);
    salle3dApi.territoires(abandon.signal).then(
      (reponse) => {
        if (abandon.signal.aborted) return;
        const tous = [...reponse.projets, ...(reponse.salle?.projets ?? [])];
        const trouve = tous.find((territoire) => territoire.conversations.some((conversation) => conversation.rootId === rootId));
        setProjet(trouve === undefined ? null : { projet: trouve.projet, conversations: trouve.conversations });
      },
      (erreur: unknown) => {
        if (abandon.signal.aborted) return;
        console.warn("salle de contrôle : territoires illisibles", erreur);
        setProjet(null);
      },
    );
    return () => abandon.abort();
  }, [rootId]);
  return projet;
}

/** Sélecteur « Conversations de ce projet » (D-3d-15) : passer d'une conversation à l'autre sans repasser par le zoom 1. */
function ChoixConversation({ projet, rootId, onChoisir }: { projet: ProjetDeLaRacine; rootId: string; onChoisir: (rootId: string) => void }) {
  const id = useId();
  if (projet.conversations.length < 2) return null;
  return (
    <div className="zoom-conv-choix">
      <label htmlFor={id}>{SALLE.partout.conversationsDuProjet}</label>
      <select id={id} className="select sm" value={rootId} onChange={(event) => onChoisir(event.currentTarget.value)}>
        {projet.conversations.map((conversation) => (
          <option key={conversation.rootId} value={conversation.rootId}>
            {conversation.titre}
          </option>
        ))}
      </select>
    </div>
  );
}

// --- Panneau du zoom 3 en direct ---------------------------------------------------------------------------------------------

interface Lecture {
  sessionId: string;
  /** null : lecture en échec (textes indisponibles). */
  messages: readonly unknown[] | null;
}

/**
 * Messages de la session détaillée, relus EN DIRECT comme la bande 2D : quand le panneau change, au plus une fois toutes les 2 s
 * pour un même assistant. `aRelire` vide (différé) : AUCUNE requête n'est faite, jamais (textesPanneau, D-3d-12).
 */
function useTextesDuPanneau(detail: NeonDetail, etat: string, dossier: string | undefined, textes: TextesPanneau): Lecture | null {
  const sessionId = detail.sessionId;
  const cle = [sessionId, etat, ...textes.aRelire].join("|");
  const [lecture, setLecture] = useState<Lecture | null>(null);
  const derniere = useRef<{ sessionId: string; at: number } | null>(null);
  const relire = textes.aRelire.length > 0;
  useEffect(() => {
    if (!relire) {
      setLecture(null);
      return;
    }
    let annule = false;
    const avant = derniere.current;
    const delai = avant?.sessionId === sessionId ? Math.max(0, avant.at + NEON_RELECTURE_MS - Date.now()) : 0;
    const minuteur = globalThis.setTimeout(() => {
      derniere.current = { sessionId, at: Date.now() };
      oc.messages(sessionId, dossier).then(
        (messages) => {
          if (!annule) setLecture({ sessionId, messages });
        },
        // Échec (proxy injoignable, conversation supprimée) : le panneau dit « Texte indisponible. ».
        () => {
          if (!annule) setLecture({ sessionId, messages: null });
        },
      );
    }, delai);
    return () => {
      annule = true;
      globalThis.clearTimeout(minuteur);
    };
  }, [cle, sessionId, dossier, relire]);
  return lecture?.sessionId === sessionId ? lecture : null;
}

/**
 * Texte d'un message relu dans la conversation : « non enregistré » si aucun fait ne le nomme (P12 : trou étiqueté), « … »
 * pendant la lecture, « Texte indisponible. » si la lecture échoue ou si le message est absent ou vide ; sinon le texte masqué
 * puis coupé par texteDuMessage, rendu en TEXTE (échappé par React), jamais en HTML.
 */
function TexteLu({ lecture, messageId }: { lecture: Lecture | null; messageId: string | null }) {
  if (messageId === null) return <p className="zoom-conv-panneau-texte">{NEON.partout.nonEnregistre}</p>;
  if (lecture === null) return <p className="zoom-conv-panneau-texte">…</p>;
  const valeur = lecture.messages === null ? null : texteDuMessage(lecture.messages, messageId);
  return <p className="zoom-conv-panneau-texte">{valeur ?? NEON.partout.texteIndisponible}</p>;
}

/**
 * Panneau « Consigne reçue · Ce qu'il a fait · Résultat rendu » EN DIRECT (§5.7.4) : les textes de message sont relus dans la
 * conversation, comme la bande 2D. En différé, ce panneau n'est jamais monté : c'est PanneauRevoir (L28c) qui sert, sans aucune
 * relecture (D-3d-12, U2).
 */
function PanneauDirect({
  vue,
  detail,
  dossier,
  onRetour,
}: {
  vue: NeonScene;
  detail: NeonDetail;
  dossier: string | undefined;
  onRetour: () => void;
}) {
  const noeud = vue.noeuds.find((candidat) => candidat.sessionId === detail.sessionId);
  // Les tuiles de fichiers entrent dans la clé de relecture : leur chemin ne vit que dans la partie d'outil de leur `callId`.
  const textes = textesPanneau(true, detail.panneau, detail.dossiers);
  const lecture = useTextesDuPanneau(detail, noeud?.etat ?? "", dossier, textes);
  // Chemins relus des tuiles, comme la bande 2D : la scène ne porte que la clé du fichier, jamais son chemin.
  const chemins = useMemo(() => cheminsDesTuiles(lecture?.messages ?? null, detail.dossiers), [lecture, detail]);
  const { panneau } = detail;
  const outils = [...detail.outils.map((outil) => ({ nom: libelleOutil(outil.categorie), ...outil })), { nom: libelleOutil("autres"), ...detail.autresOutils }]
    .map((outil) => ({ nom: outil.nom, total: outil.enCours + outil.termines + outil.echecs + outil.interrompus }))
    .filter((outil) => outil.total > 0);
  const tuiles = detail.dossiers.flatMap((un) => un.tuiles);
  const enPlus = detail.dossiers.reduce((somme, un) => somme + un.enPlus, 0) + detail.dossiersEnPlus;
  const resultat = panneau.resultat;

  return (
    <div className="zoom-conv-panneau">
      <div className="zoom-conv-panneau-tete">
        <p>{noeud === undefined ? NEON.partout.assistantConversation : libelleNoeud(noeud)}</p>
        <button type="button" className="btn sm" onClick={onRetour}>
          {NEON.partout.commandes.afficher}
        </button>
      </div>
      <dl>
        {/* En direct, la consigne reçue EST le texte réel relu dans la conversation : aucun bouton n'a à l'ouvrir ailleurs. */}
        <dt>{NEON.partout.panneau.consigne}</dt>
        <dd>
          <TexteLu lecture={lecture} messageId={panneau.consigne?.messageId ?? null} />
        </dd>
        <dt>{NEON.partout.panneau.actions}</dt>
        <dd>
          {outils.length === 0 && tuiles.length === 0 ? (
            <p className="zoom-conv-panneau-texte">{RIEN}</p>
          ) : (
            <ul>
              {outils.map((outil) => (
                <li key={outil.nom}>{`${outil.nom} : ${outil.total}`}</li>
              ))}
              {tuiles.map((tuile) => (
                <li key={`${tuile.fichier}|${tuile.callId}`}>{libelleTuile(tuile, chemins.get(tuile.callId))}</li>
              ))}
              {enPlus > 0 ? <li>{remplir(NEON.partout.tuiles.enPlus, { n: enPlus })}</li> : null}
            </ul>
          )}
        </dd>
        {resultat === null && panneau.reponse === null ? null : (
          <>
            <dt>{resultat === null ? NEON.partout.panneau.reponse : NEON.partout.panneau.resultat}</dt>
            <dd>
              {resultat !== null && resultat.etat !== "rendu" ? (
                <p className="zoom-conv-panneau-texte">{libelleEtat(resultat.etat === "echec" ? "echec" : "arrete")}</p>
              ) : (
                <TexteLu lecture={lecture} messageId={panneau.reponse?.messageId ?? null} />
              )}
            </dd>
          </>
        )}
      </dl>
    </div>
  );
}
