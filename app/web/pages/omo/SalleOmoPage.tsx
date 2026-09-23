// Propriétaire : L26a.
// Page « Salle OMO » (spécification §4.14.1 l.806-811, §4.14.6, §4.12 l.784, §4.13 l.802, §5.5, §5.6 ; JS-12 ; JP-10 ;
// plan 2 bis-2 ter, fiche L26a, D-2b-22, D-2b-30, D-2b-37, D-2b-38, D-2b-45 ; arbitrage A16 point 4).
//
// Ce que la page montre :
// - l'ÉTAT de la salle (coupée, non installée, arrêtée, en relance, prête, demande en cours, suspendue) et, surtout, POURQUOI
//   elle attend : historique git non protégé, plafond de balayage atteint, authentification ou battement absents, salle coupée.
//   La raison est affichée avec la phrase déjà écrite dans omo-room-texts.ts (T3a), sans promesse de geste (A16 point 4 a) ;
// - quand GET /api/omo/status répond 403 « salle-coupee » — le cas normal tant que SALLE_OUVERTE est faux — la page ne montre
//   AUCUNE erreur technique : elle lit `Bootstrap.omo`, le canal qui marche salle coupée, et affiche l'état « coupée » avec sa
//   phrase (A16 point 4 b) ;
// - quand la lecture échoue pour une AUTRE raison (500, flux coupé, redémarrage du serveur), l'état est dit « illisible », jamais
//   « coupée » (P3), et le bandeau suit le dernier statut RÉELLEMENT lu : un échec passager n'efface plus [Arrêter] pendant une
//   demande (relecture 2ter-vague-2 ; modèle `apresLecture` / `demandeEnCours`) ;
// - le choix du projet préparé et le résultat de son pré-contrôle (ProjectChooser) ;
// - la conversation de la salle EN LECTURE, avec un sélecteur réduit à « Comme Oh My OpenAgent » : AutonomySelector et
//   ChatPage.tsx ne sont jamais modifiés (D-2b-22) ;
// - l'écran d'activation, à chaque demande, et le bandeau permanent avec [Arrêter] (stopOmo, D-2b-30) et [Journal] ;
// - le Journal du contrôle de la conversation de la salle (§4.12 l.784), que [Journal] amène à l'écran : décisions lues par
//   GET …/activity (mode Avancé), `refus-interdit` et `par: extension` compris, détections et fichiers mis de côté venus du flux
//   (salle-journal.ts ; relecture 2ter-vague-2) ;
// - après une détection : la cause, le rappel qu'elle est après coup, et les fichiers signalés avec leur phrase (D-2b-37).
//
// Toute décision d'affichage est dans les modèles purs server/shared/omo-activation-view.ts et salle-journal.ts ; cette page lit,
// appelle et rend.
// La bande néon et « Qui travaille ? » de l'itération 1 sont réutilisés tels quels : l'enceinte arrive avec L25b (vague 4).
// Aucune animation.
import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { TEXTES as TEXTES_AUTONOMIE } from "../../../server/shared/autonomy-texts.ts";
import {
  annonceEtatSalle,
  apresLecture,
  cheminsNonProteges,
  conditionsActivation,
  demandeEnCours,
  ETAT_ILLISIBLE,
  LECTURE_INITIALE,
  type LectureStatut,
  SEPARATEUR_LISTE,
  statutAffiche,
  type VueEtatSalle,
  vueEtatSalle,
  vueSignales,
} from "../../../server/shared/omo-activation-view.ts";
import { phraseDetection, TEXTES } from "../../../server/shared/omo-room-texts.ts";
import type { OmoActivationView, OmoStatusResponse } from "../../../server/shared/omo-types.ts";
import { useApp } from "../../app/AppContext.tsx";
import { Icon } from "../../components/Icon.tsx";
import { Button, Card, EmptyState, Spinner } from "../../components/ui.tsx";
import { useAnnouncer } from "../../lib/announcer.ts";
import { errorText } from "../../lib/api.ts";
import { activerOmo, envoyerOmo, estSalleCoupee, getOmoMessages, getOmoSession, getOmoStatus } from "../../lib/api-omo.ts";
import { cockpitEvent, useEvents } from "../../lib/events.ts";
import type { OcMessageWithParts, OcTextPart } from "../../lib/types.ts";
import { ControlJournal, useControlDecisions } from "../chat/autonomy/ControlJournal.tsx";
import { OmoActivationDialog } from "./OmoActivationDialog.tsx";
import { OmoBanner } from "./OmoBanner.tsx";
import { ProjectChooser } from "./ProjectChooser.tsx";
import { ajouterDetection, type DetectionLue, type DetectionRecue, journalDeLaSalle, lireDetection, relireJournalApres } from "./salle-journal.ts";
import { SansDemandeTable } from "./SansDemandeTable.tsx";
import "./omo.css";

/** Seul choix proposé dans la salle (§4.13 l.802) ; AutonomySelector reste celui du chat (D-2b-22). */
const CHOIX_SALLE = "Comme Oh My OpenAgent";

/** Qui écrit dans la conversation de la salle, côté IA : la conversation et la colonne « Qui » du Journal disent le même nom. */
const QUI_EXTENSION = "L'extension";

/** État vide du Journal de la salle (§5.4) : il couvre toute la conversation, comme le Déroulé le dit de la sienne. */
const JOURNAL_VIDE = "Aucune décision automatique pour cette conversation.";

/** Salle ouverte sur un projet : la racine créée par le proxy et son dossier. */
interface Salle {
  rootId: string;
  projet: string;
  directory: string;
}

export function SalleOmoPage() {
  const { boot, ui } = useApp();
  const say = useAnnouncer(ui.activityAnnouncements);
  /** Lectures de GET /api/omo/status : dernier statut réellement lu, et échec de la dernière lecture (relecture 2ter-vague-2). */
  const [lecture, setLecture] = useState<LectureStatut>(LECTURE_INITIALE);
  const [chargement, setChargement] = useState(true);
  const [echec, setEchec] = useState<string | null>(null);
  const [salle, setSalle] = useState<Salle | null>(null);
  const [messages, setMessages] = useState<OcMessageWithParts[]>([]);
  const [detection, setDetection] = useState<DetectionLue | null>(null);
  /** Détections reçues pendant la visite, pour le Journal de la salle (bornées par salle-journal.ts). */
  const [detectionsRecues, setDetectionsRecues] = useState<DetectionRecue[]>([]);
  const numeroDetection = useRef(0);
  /** Lectures du Journal : une à l'ouverture de la salle, puis une par décision enregistrée pour sa racine, détection ou [Journal]. */
  const [lecturesJournal, setLecturesJournal] = useState(1);
  /** Clics sur [Journal] : chacun amène le Journal à l'écran et y place le focus (modèle du journalNonce du Déroulé). */
  const [ouverturesJournal, setOuverturesJournal] = useState(0);
  /**
   * Montant d'arrêt de la demande en cours, tel qu'il a été saisi et confirmé. Le dernier montant ENREGISTRÉ
   * (`budget.omo.dernierPlafondUsd`, §4.8.2) arrivera avec la vue du port d'activation (L22c) : d'ici là, le champ est vide à
   * la première activation de chaque visite, jamais rempli d'une valeur choisie par le cockpit.
   */
  const [plafondConfirme, setPlafondConfirme] = useState<string | null>(null);
  /** Dernier état rendu : les annonces disent les TRANSITIONS, jamais ce qu'une première lecture révèle. */
  const precedent = useRef<VueEtatSalle | null>(null);

  const relire = useCallback(() => {
    setChargement(true);
    getOmoStatus().then(
      (prochain) => {
        setLecture((avant) => apresLecture(avant, { ok: true, statut: prochain }));
        setEchec(null);
        setChargement(false);
      },
      (err: unknown) => {
        // Salle coupée (403) : état livré, jamais une panne ; l'état vient alors de Bootstrap.omo (A16 point 4 b). Toute autre
        // erreur ne dit rien de la salle : le dernier statut lu est gardé pour le bandeau, l'état est dit « illisible ».
        setLecture((avant) => apresLecture(avant, { ok: false, salleCoupee: estSalleCoupee(err) }));
        setEchec(estSalleCoupee(err) ? null : errorText(err));
        setChargement(false);
      },
    );
  }, []);

  useEffect(() => relire(), [relire]);

  useEvents((event) => {
    if (cockpitEvent(event, "stream.reconnected", "omo.etat", "omo.recreation", "omo.connection") !== null) {
      relire();
      if (event.kind === "cockpit" && event.type === "stream.reconnected") setLecturesJournal((n) => n + 1);
      return;
    }
    const horsControle = cockpitEvent(event, "omo.hors-controle");
    if (horsControle !== null) {
      const lue = lireDetection(horsControle.data);
      setDetection(lue);
      if (lue !== null) {
        numeroDetection.current += 1;
        const id = `detection-${numeroDetection.current}`;
        setDetectionsRecues((liste) => ajouterDetection(liste, lue, id, Date.now()));
        setLecturesJournal((n) => n + 1);
      }
      relire();
      return;
    }
    if (salle !== null && event.kind === "cockpit" && relireJournalApres(event.type, event.data, salle.rootId)) {
      setLecturesJournal((n) => n + 1);
    }
  });

  const statut = statutAffiche(lecture);
  const etat = vueEtatSalle({ boot: boot.omo ?? null, statut, illisible: lecture.illisible });

  useEffect(() => {
    const phrase = annonceEtatSalle(precedent.current, etat);
    precedent.current = etat;
    if (phrase !== null) say(phrase);
  });

  // Tant que la première lecture du statut n'a pas abouti, la page n'AFFIRME rien : elle attend. Seule exception, le cas
  // normal d'aujourd'hui — le Bootstrap dit déjà la salle fermée (SALLE_OUVERTE faux) : l'état « coupée » est sûr, il
  // s'affiche tout de suite, sans attendre le 403 de GET /api/omo/status (A16 point 4 b). Une salle ouverte, ou une lecture en
  // échec, n'est JAMAIS remplacée par cette attente : le bandeau et son [Arrêter] restent montés pendant chaque relecture.
  if (chargement && salle === null && lecture.statut === null && !lecture.illisible && boot.omo?.salleOuverte !== false) {
    return (
      <div className="page">
        <Spinner large />
      </div>
    );
  }

  const ouvrirJournal = () => {
    setOuverturesJournal((n) => n + 1);
    setLecturesJournal((n) => n + 1);
  };

  return (
    <div className="page omo-page">
      <header className="page-header">
        <div>
          <h2>Salle OMO</h2>
          <p>Une conversation confiée à l'extension Oh My OpenAgent, dans un conteneur à part.</p>
        </div>
      </header>

      {salle !== null ? (
        <OmoBanner
          rootId={salle.rootId}
          depenseUsd={null}
          plafondSaisi={plafondConfirme}
          demandeActive={demandeEnCours(boot.omo ?? null, lecture)}
          onOpenJournal={ouvrirJournal}
          onStopped={relire}
        />
      ) : null}

      <Card title="État de la salle">
        <div className="omo-etat">
          <p className="omo-etat-libelle">
            <Icon name={etat.prete ? "check" : "hourglass"} size={16} />
            {etat.libelle}
          </p>
          <span className="spacer" />
          <Button size="sm" icon="refresh" onClick={relire} loading={chargement}>
            Actualiser
          </Button>
        </div>
        {etat.raisons.length > 0 ? (
          <ul className="omo-raisons">
            {etat.raisons.map((raison) => (
              <li key={raison} className="omo-raison">
                {raison}
              </li>
            ))}
          </ul>
        ) : null}
        {echec ? (
          <p className="field-error" role="alert">
            {echec}
          </p>
        ) : null}
      </Card>

      {detection !== null ? <BlocDetection detection={detection} /> : null}

      {salle === null ? (
        <ProjectChooser
          projets={statut?.projetsPrepares ?? []}
          ouvrable={etat.prete}
          onOuverte={(rootId, projet) => {
            setSalle({ rootId, projet, directory: "" });
            getOmoSession(rootId).then(
              (session) => setSalle({ rootId, projet, directory: session.directory }),
              () => undefined,
            );
          }}
        />
      ) : (
        <Conversation
          salle={salle}
          statut={statut}
          etat={etat}
          messages={messages}
          onMessages={setMessages}
          onRelire={relire}
          dateAudit={statut?.image.auditeLe ?? ""}
          plafondMaxUsd={boot.settings.budget.autonomie.plafondMaxUsd}
          plafondConfirme={plafondConfirme}
          onPlafondConfirme={setPlafondConfirme}
        />
      )}

      {salle !== null ? (
        <JournalSalle rootId={salle.rootId} lectures={lecturesJournal} ouvertures={ouverturesJournal} detections={detectionsRecues} />
      ) : null}

      <Card title="Ce que l'extension fait sans demande">
        <SansDemandeTable dateAudit={statut?.image.auditeLe ?? ""} plafondSaisi={plafondConfirme} />
      </Card>
    </div>
  );
}

interface JournalSalleProps {
  rootId: string;
  /** Compteur de lectures : chaque changement relit les décisions (GET …/activity) ; au moins 1, la page lit dès l'ouverture. */
  lectures: number;
  /** Compteur des clics sur [Journal] : chaque changement amène le Journal à l'écran et y place le focus ; 0 : aucun clic. */
  ouvertures: number;
  /** Détections reçues pendant la visite, toutes racines : salle-journal.ts garde celles de `rootId` et celles hors demande. */
  detections: readonly DetectionRecue[];
}

/**
 * Journal du contrôle de la conversation de la salle (§4.12 l.784), sous la conversation, et ouvert par [Journal] du bandeau.
 * Le tableau est celui de L26b (ControlJournal.tsx), inchangé : décisions lues par `useControlDecisions` (GET …/activity, permis
 * pour une racine de la salle en mode Avancé, le seul où cette page existe), `refus-interdit` et `par: extension` compris ;
 * détections après coup et fichiers mis de côté passés par propriétés, depuis le flux. Aucune écriture, aucune route nouvelle.
 */
function JournalSalle({ rootId, lectures, ouvertures, detections }: JournalSalleProps) {
  const { boot, advanced } = useApp();
  // Variante des phrases de règle (décision n° 8 : l'IA de contrôle peut être livrée coupée), comme le Déroulé.
  const controleIa = boot.settings.budget.autonomie.controleIa === true;
  const journal = useControlDecisions(rootId, lectures);
  const donnees = useMemo(() => journalDeLaSalle(rootId, detections), [rootId, detections]);
  const noms = useMemo(() => new Map([[rootId, QUI_EXTENSION]]), [rootId]);
  const section = useRef<HTMLElement | null>(null);
  const titreId = useId();

  useEffect(() => {
    if (ouvertures === 0) return;
    // Demandé par un clic sur [Journal] : le Journal vient à l'écran et reçoit le focus, rien d'autre (aucune animation).
    section.current?.scrollIntoView({ block: "nearest" });
    section.current?.focus({ preventScroll: true });
  }, [ouvertures]);

  return (
    <section className="card omo-journal" aria-labelledby={titreId} tabIndex={-1} ref={section}>
      <div className="card-header">
        <h3 id={titreId}>{TEXTES_AUTONOMIE.partout.journal.titre}</h3>
      </div>
      <ControlJournal
        decisions={journal.decisions}
        advanced={advanced}
        controleIa={controleIa}
        noms={noms}
        chargement={journal.chargement}
        error={journal.error}
        vide={JOURNAL_VIDE}
        detections={donnees.detections}
        quarantaine={donnees.quarantaine}
      />
    </section>
  );
}

/** Détection après coup : la cause, le rappel d'honnêteté, puis les fichiers signalés et la quarantaine (D-2b-37). */
function BlocDetection({ detection }: { detection: DetectionLue }) {
  const groupes = vueSignales(detection.signales);
  return (
    <Card title="Demande arrêtée">
      <p role="alert">{phraseDetection(detection.cause)}</p>
      <p className="small muted">{TEXTES.avance.detectionApresCoup}</p>
      {groupes.map((groupe) => (
        <div key={groupe.genre}>
          <p className="small">{groupe.phrase}</p>
          <ul className="omo-chemins">
            {groupe.chemins.map((chemin) => (
              <li key={chemin}>
                <code>{chemin}</code>
              </li>
            ))}
          </ul>
        </div>
      ))}
    </Card>
  );
}

interface ConversationProps {
  salle: Salle;
  statut: OmoStatusResponse | null;
  etat: VueEtatSalle;
  messages: OcMessageWithParts[];
  onMessages: (messages: OcMessageWithParts[]) => void;
  onRelire: () => void;
  dateAudit: string;
  plafondMaxUsd: number;
  /** Dernier montant confirmé pendant cette visite ; null avant la première activation. */
  plafondConfirme: string | null;
  onPlafondConfirme: (plafondUsd: string) => void;
}

/**
 * Conversation de la salle en LECTURE, sélecteur réduit et composeur. Envoyer ouvre l'écran d'activation : l'activation est
 * confirmée à CHAQUE demande (§4.14.2), puis le message part par le proxy de l'instance.
 */
function Conversation(props: ConversationProps) {
  const { salle, statut, etat, messages, onMessages, onRelire, dateAudit, plafondMaxUsd, plafondConfirme, onPlafondConfirme } = props;
  const [texte, setTexte] = useState("");
  const [ouvert, setOuvert] = useState(false);
  const [occupe, setOccupe] = useState(false);
  const [refusServeur, setRefusServeur] = useState<string | null>(null);

  useEffect(() => {
    let annule = false;
    getOmoMessages(salle.rootId).then(
      (lus) => {
        if (!annule) onMessages(lus);
      },
      () => undefined,
    );
    return () => {
      annule = true;
    };
  }, [salle.rootId, onMessages]);

  const vue: OmoActivationView = {
    rootId: salle.rootId,
    projet: salle.projet,
    dernierPlafondUsd: plafondConfirme,
    plafondMaxUsd,
    horsBornes: false,
    demandeActive: etat.code === "demande-active",
    conditions: conditionsActivation(statut, etat.code === "demande-active"),
  };
  const liste = statut === null ? "" : cheminsNonProteges(statut).join(SEPARATEUR_LISTE);

  const lancer = (plafondUsd: string) => {
    setOccupe(true);
    setRefusServeur(null);
    activerOmo(salle.rootId, plafondUsd)
      .then(() => envoyerOmo(salle.rootId, salle.directory, { parts: [{ type: "text", text: texte }] }))
      .then(
        () => {
          setOccupe(false);
          setOuvert(false);
          setTexte("");
          onPlafondConfirme(plafondUsd);
          onRelire();
        },
        (err: unknown) => {
          setOccupe(false);
          setRefusServeur(errorText(err));
        },
      );
  };

  return (
    <Card title={salle.projet} subtitle="Conversation de la salle, en lecture.">
      {messages.length === 0 ? (
        <EmptyState icon="chat" title="Aucun message">
          La conversation de la salle est vide.
        </EmptyState>
      ) : (
        <ul className="omo-messages">
          {messages.map((message) => (
            <li key={message.info.id} className="omo-message">
              <span className="omo-message-qui">{message.info.role === "user" ? "Vous" : QUI_EXTENSION}</span>
              {texteDuMessage(message)}
            </li>
          ))}
        </ul>
      )}
      <div className="stack tight">
        <p className="small muted">
          <Icon name="bolt" size={14} /> {CHOIX_SALLE}
        </p>
        <textarea
          className="input"
          rows={3}
          value={texte}
          aria-label="Votre demande"
          onChange={(e) => setTexte(e.target.value)}
        />
        <div className="row">
          {/* État illisible : fermé, et l'écran d'activation n'est pas ouvert — il dirait « salle coupée » sans donnée (P3). */}
          <Button variant="primary" icon="send" disabled={texte.trim() === "" || etat.code === ETAT_ILLISIBLE} onClick={() => setOuvert(true)}>
            Envoyer
          </Button>
          {etat.code === ETAT_ILLISIBLE ? <span className="small muted">{etat.libelle}</span> : null}
        </div>
      </div>
      <OmoActivationDialog
        open={ouvert}
        vue={vue}
        dateAudit={dateAudit}
        refusServeur={refusServeur}
        occupe={occupe}
        onClose={() => setOuvert(false)}
        onLancer={lancer}
        valeurs={{ liste }}
      />
    </Card>
  );
}

/** Texte lisible d'un message : parties « text » seulement, jamais un outil ni une pièce jointe. */
function texteDuMessage(message: OcMessageWithParts): string {
  return message.parts
    .filter((part): part is OcTextPart => part.type === "text")
    .map((part) => part.text)
    .join("\n");
}
