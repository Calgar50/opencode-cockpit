// Propriétaire : L40a.
// Onglet « Équipes » de la page Assistants (#/assistants/equipes) : état vide, galerie des exemples, équipes installées et schéma
// lu (spécification §5.3 l.896, §5.4 l.909, §5.5, §5.6 ; C §9.10 ; plan d'exécution it4, fiche L40a). Propriétés FIGÉES dans
// ../../chat/team/slots.ts (T4w) : il remplace le squelette posé par T4w.
// - État vide : la définition d'une équipe, la phrase d'accueil et [Partir d'un exemple], qui porte le focus sur la galerie.
// <c5:demonstration-equipe-doc>
// - [Voir une démonstration] (spéc. §5.3 l.896, §5.4 l.909 ; fiche L49) : dans l'état vide et dans la galerie, il ouvre TeamDemo,
//   un enregistrement rejoué sans aucun appel d'IA ni aucune requête. Il suit ce que rend cet onglet : il n'apparaît donc pas
//   tant que les équipes sont fermées dans le mode courant (`ouvertesEnSimple`, U1, D-5-24), et AUCUNE constante propre au mode
//   Simple n'est ajoutée pour lui.
// </c5:demonstration-equipe-doc>
// - Galerie : mini-schéma, phrase, « ≈ X $ en général », « Lecture seule », [Aperçu] [Installer]. L'estimation d'un exemple est
//   lue par POST /api/teams/preview (route qui n'écrit rien) : sans elle, la carte n'affiche simplement aucun coût.
// - Équipes installées : ligne, état dit par son mot, déroulé lu, [Utiliser dans le chat] [Modifier] [Dupliquer] [Supprimer] ;
//   la suppression est confirmée (« Les lancements passés restent dans le déroulé des conversations. »).
// - MODE SIMPLE FERMÉ (décision U1, D-eq-13 ; plan §2.6) : tant que `ouvertesEnSimple` de GET /api/teams est faux, en Simple,
//   l'onglet montre le texte du §2.6 et la liste en LECTURE SEULE : aucun bouton vers l'éditeur ([Modifier], [Dupliquer],
//   [Nouvelle équipe]) ni vers l'installation (la galerie n'est pas montée). L'ouverture tient en une ligne : le web ne lit que
//   `ouvertesEnSimple`, jamais une autre valeur.
// Toute la logique testable est dans ./teams-tab-model.ts (D-eq-24) ; tous les textes viennent de server/shared/team-texts.ts.
// Aucune animation, aucun raccourci clavier, aucun focus pris sans un clic de l'utilisateur.
import { useEffect, useRef, useState } from "react";
import { Icon } from "../../../components/Icon.tsx";
import { Spinner, useAsync, useConfirm } from "../../../components/ui.tsx";
import { errorText } from "../../../lib/api.ts";
import { teamError, teamsApi } from "../../../lib/api-teams.ts";
import { formatDateTime } from "../../../lib/format.ts";
import { navigate, openAssistants } from "../../../lib/router.ts";
import type { TeamExampleView } from "../../../lib/types.ts";
import type { TeamsTabProps } from "../../chat/team/slots.ts";
import { TeamCard } from "./TeamCard.tsx";
import { TeamGallery } from "./TeamGallery.tsx";
import { TeamInstallDialog } from "./TeamInstallDialog.tsx";
import {
  buildTeamsTab,
  equipesOuvertes,
  suppressionDe,
  type TeamActionId,
  type TeamCardModel,
  texteRefusSuppression,
} from "./teams-tab-model.ts";
// <c5:demonstration-equipe-import>
import { TEXTES as TEXTES_CONSTRUCTION } from "../../../../server/shared/construction-texts.ts";
import { TeamDemo } from "./TeamDemo.tsx";
// </c5:demonstration-equipe-import>
import "./teams.css";

/**
 * Équipe à recopier dans l'éditeur guidé (L40b), posée par [Dupliquer] et lue UNE SEULE FOIS à l'ouverture de « Nouvelle équipe ».
 * Rien n'est écrit tant que l'éditeur n'enregistre pas : un rechargement de la page l'oublie.
 */
let aRecopier: string | null = null;

/** [Dupliquer] : l'éditeur partira de cette équipe. */
export function poserDuplication(id: string): void {
  aRecopier = id;
}

/** Équipe à recopier, reprise et oubliée (L40b l'appelle à l'ouverture de « Nouvelle équipe »). */
export function prendreDuplication(): string | null {
  const id = aRecopier;
  aRecopier = null;
  return id;
}

export function TeamsTab({ advanced }: TeamsTabProps) {
  const confirmer = useConfirm();
  const { data, error, loading, reload } = useAsync(() => teamsApi.list(), []);
  /** « En général » de chaque exemple, lu par l'aperçu ; une lecture manquante retire seulement la ligne de coût. */
  const [couts, setCouts] = useState<Readonly<Record<string, number>>>({});
  /** Exemple à installer ; null : aucune boîte ouverte. */
  const [aInstaller, setAInstaller] = useState<TeamExampleView | null>(null);
  /** Phrase d'un refus d'action (suppression), affichée jusqu'à la prochaine action. */
  const [refus, setRefus] = useState<string | null>(null);
  const galerie = useRef<HTMLDivElement>(null);
  // <c5:demonstration-equipe-etat>
  /** Lecteur de la démonstration ouvert ; fermé au premier rendu, et jamais ouvert tout seul (L49). */
  const [demonstration, setDemonstration] = useState(false);
  // </c5:demonstration-equipe-etat>

  const ouvertes = equipesOuvertes(advanced, data);

  useEffect(() => {
    const exemples = ouvertes ? (data?.exemples ?? []) : [];
    if (exemples.length === 0) return;
    let annule = false;
    void (async () => {
      const lus: Record<string, number> = {};
      for (const exemple of exemples) {
        try {
          const apercu = await teamsApi.preview({ flow: exemple.flow });
          if (apercu.estimate) lus[exemple.id] = apercu.estimate.typique;
        } catch {
          // Estimation indisponible (route à venir, prix inconnu, opencode muet) : la carte se passe de sa ligne de coût.
        }
      }
      if (!annule) setCouts(lus);
    })();
    return () => {
      annule = true;
    };
  }, [data, ouvertes]);

  const modele = buildTeamsTab({
    advanced,
    donnees: data,
    chargement: loading,
    erreur: error === null ? refus : errorText(error),
    coutsExemples: couts,
    dateDe: formatDateTime,
  });

  const supprimer = async (carte: TeamCardModel) => {
    const boite = suppressionDe(carte.titre);
    const accord = await confirmer({
      title: boite.titre,
      message: boite.message,
      confirmLabel: boite.confirmer,
      cancelLabel: boite.annuler,
      danger: true,
    });
    if (!accord) return;
    setRefus(null);
    try {
      await teamsApi.remove(carte.id);
      reload();
    } catch (err) {
      setRefus(texteRefusSuppression(teamError(err), errorText(err)));
    }
  };

  const agir = (carte: TeamCardModel, action: TeamActionId) => {
    if (action === "utiliser") return navigate("chat");
    if (action === "modifier") return openAssistants({ mode: "equipe-modifier", id: carte.id });
    if (action === "dupliquer") {
      poserDuplication(carte.id);
      return openAssistants({ mode: "equipe-nouvelle" });
    }
    void supprimer(carte);
  };

  if (modele.affichage === "chargement") return <Spinner large />;

  return (
    <div className="stack loose tm-onglet">
      <div className="row wrap between">
        <h2 className="tm-onglet-titre">{modele.titre}</h2>
        {modele.nouvelle ? (
          <button type="button" className="btn primary" onClick={() => openAssistants({ mode: "equipe-nouvelle" })}>
            <Icon name="plus" size={16} />
            {modele.nouvelle}
          </button>
        ) : null}
      </div>

      {modele.ferme ? (
        <p className="callout tm-ferme">
          <Icon name="lock" size={18} />
          <span>{modele.ferme}</span>
        </p>
      ) : null}

      {modele.erreur ? (
        <p className="callout critical tm-erreur" role="alert">
          <Icon name="alert" size={18} />
          <span>{modele.erreur}</span>
        </p>
      ) : null}

      {modele.vide ? (
        <div className="empty tm-vide">
          <Icon name="users" size={32} strokeWidth={1.4} />
          <h3>{modele.vide.definition}</h3>
          <p>{modele.vide.accueil}</p>
          {/* <c5:demonstration-equipe-vide> */}
          {/* Les deux boutons de la spéc. l.909 sur une ligne : [Voir une démonstration] rejoint [Partir d'un exemple] de l'it4. */}
          <div className="row wrap">
            <button type="button" className="btn" onClick={() => setDemonstration(true)}>
              {TEXTES_CONSTRUCTION.partout.demonstration.voir}
            </button>
            <button type="button" className="btn primary" onClick={() => galerie.current?.focus()}>
              {modele.vide.partirExemple}
            </button>
          </div>
          {/* </c5:demonstration-equipe-vide> */}
        </div>
      ) : null}

      {modele.equipes.length > 0 ? (
        <div className="stack tm-equipes">
          {modele.equipes.map((carte) => (
            <TeamCard key={carte.id} carte={carte} onAction={(action) => agir(carte, action)} />
          ))}
        </div>
      ) : null}

      {modele.galerie ? (
        <div ref={galerie} tabIndex={-1} className="tm-galerie-ancre">
          <TeamGallery
            galerie={modele.galerie}
            onInstaller={(id) => {
              setRefus(null);
              setAInstaller(data?.exemples.find((exemple) => exemple.id === id) ?? null);
            }}
            // <c5:demonstration-equipe-galerie>
            onDemonstration={() => setDemonstration(true)}
            // </c5:demonstration-equipe-galerie>
          />
        </div>
      ) : null}

      <TeamInstallDialog exemple={aInstaller} onClose={() => setAInstaller(null)} onInstalled={() => reload()} />
      {/* <c5:demonstration-equipe-lecteur> */}
      {/* GF5 : l'onglet passe l'ouverture des équipes dans le mode courant (equipesOuvertes, déjà calculée), jamais lue par le lecteur. */}
      {demonstration ? <TeamDemo advanced={advanced} equipesVisibles={ouvertes} onClose={() => setDemonstration(false)} /> : null}
      {/* </c5:demonstration-equipe-lecteur> */}
    </div>
  );
}
