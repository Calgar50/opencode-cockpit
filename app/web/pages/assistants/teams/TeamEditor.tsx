// Propriétaire : L40b.
// Éditeur guidé d'une équipe en 4 écrans, sur toute la page (#/assistants/equipes/nouvelle, #/assistants/equipes/modifier/<id>)
// (spécification §5.3 l.894-902, §5.5, §5.6, §2.2 l.90 ; C §8.1, §9.11 ; plan d'exécution it4, fiche L40b, §2.6, D-eq-10 à
// D-eq-13, D-eq-24). Propriétés FIGÉES dans ../../chat/team/slots.ts (T4w) : il remplace le squelette posé par T4w.
// - Écran 1 « Partir d'un exemple » ou « Partir d'une forme » (« À la suite », « Avis indépendants » : les deux formes de
//   l'itération 4) ; écran 2 « Les étapes » ; écran 3 « Coût et plafond » ; écran 4 « Vérifier et nommer ».
// - Progression « 2 / 4 · Les étapes », avec aria-label="Progression" : « Étape » est réservé aux étapes d'une équipe (§2.2 l.90).
// - Aperçu POST /api/teams/preview 300 ms après la dernière modification (route qui n'écrit rien) : les problèmes sont rendus SUR
//   le bloc ou l'étape concernés (BlockCard, StepForm) et annoncés poliment par l'annonceur de la page (une seule région
//   aria-live par page, réglage ui.activityAnnouncements) : aucune région nouvelle.
// - Schéma dessiné À CÔTÉ par layoutFlow (L36b), importé directement pour qu'il suive la frappe sans attendre l'aperçu ; la liste
//   (flowAsList) reste la vérité du lecteur d'écran. editor.css le passe dessous sous 900 px et laisse la liste seule à 400 px.
// - Annuler / rétablir : boutons, plus Ctrl+Z et Ctrl+Maj+Z posés SUR l'éditeur (onKeyDown), donc seulement quand le focus y est :
//   aucun raccourci global, aucun raccourci à une touche (spéc. §5.5).
// - Départ avec des modifications : confirmation « Quitter sans enregistrer l'équipe ? » (garde de navigation de la 1.0, comme
//   l'assistant de création), et fermeture de l'onglet signalée par le navigateur.
// - MODE SIMPLE FERMÉ (décision U1, D-eq-13 ; plan §2.6) : tant que `ouvertesEnSimple` de GET /api/teams est faux, en Simple,
//   l'éditeur n'est PAS monté (buildEditor rend « ferme ») : le texte du §2.6 et un lien vers l'onglet Équipes, et AUCUNE requête
//   d'aperçu (`apercuDemande` reste faux). Le web ne lit que `ouvertesEnSimple` : l'ouverture tient en UNE ligne.
// Toute la logique testable est dans ../../../../server/shared/flow-edit.ts (D-eq-24, tests server/flow-edit.test.ts) ; tous les
// textes viennent de server/shared/team-texts.ts (T4t). Aucune animation, aucun texte d'interface écrit ici.
import { type KeyboardEvent, useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import {
  ajouterAvis,
  ajouterBloc,
  type AjoutModel,
  annuler,
  appliquer,
  brouillonDe,
  brouillonDeForme,
  brouillonVide,
  buildEditor,
  corpsEnregistrement,
  descendre,
  dupliquerBloc,
  type EcranId,
  type EditHistory,
  type EditorAssistantView,
  type EditorTier,
  type FlowDraft,
  historiqueDe,
  identifiantEquipe,
  modifierEtape,
  modifierPause,
  monter,
  retablir,
  retirerAvis,
  type StepPatch,
  supprimerBloc,
} from "../../../../server/shared/flow-edit.ts";
import { flowAsList, layoutFlow } from "../../../../server/shared/flow-layout.ts";
import { phraseErreur } from "../../../../server/shared/team-texts.ts";
import type { FlowBlock } from "../../../../server/shared/team-types.ts";
import { useApp } from "../../../app/AppContext.tsx";
import { Icon } from "../../../components/Icon.tsx";
import { Spinner, useAsync, useConfirm } from "../../../components/ui.tsx";
import { api, errorText } from "../../../lib/api.ts";
import { teamError, teamsApi } from "../../../lib/api-teams.ts";
import { useAnnouncer } from "../../../lib/announcer.ts";
import { assistantsHref, openAssistants, setNavigationGuard } from "../../../lib/router.ts";
import type { AssistantView, TeamPreviewResponse, TeamsListResponse } from "../../../lib/types.ts";
import type { TeamEditorProps } from "../../chat/team/slots.ts";
import { BlockCard } from "./BlockCard.tsx";
import { FlowList } from "./FlowList.tsx";
import { FlowSchema } from "./FlowSchema.tsx";
import { libelleSchema, texteRefus } from "./teams-tab-model.ts";
import { prendreDuplication } from "./TeamsTab.tsx";
import "./teams.css";
import "./editor.css";

/** Attente après la dernière modification avant l'aperçu (spécification §5.3 l.902). */
const APERCU_MS = 300;

/** Assistant proposable à une étape, tel que l'éditeur le lit (sous-ensemble d'AssistantView). */
function vueAssistant(assistant: AssistantView): EditorAssistantView {
  return {
    name: assistant.name,
    title: assistant.title,
    rights: assistant.rights,
    rightLines: assistant.rightLines,
    modelName: assistant.modelName,
    mode: assistant.mode,
    hidden: assistant.hidden,
  };
}

/** [+ Ajouter ▾] entre deux blocs : une entrée par genre de l'itération 4 (D-eq-10), désactivée quand la borne est atteinte. */
function Ajout({ ajout, onAjouter }: { ajout: AjoutModel; onAjouter: (type: FlowBlock["type"]) => void }) {
  return (
    <div className="row wrap tm-ed-ajout">
      <span className="secondary small tm-ed-ajout-libelle">
        <Icon name="plus" size={14} />
        {ajout.libelle}
      </span>
      {ajout.choix.map((choix) => (
        <button
          key={choix.type}
          type="button"
          className="btn sm"
          aria-disabled={!choix.possible}
          onClick={() => {
            if (choix.possible) onAjouter(choix.type);
          }}
        >
          {choix.libelle}
        </button>
      ))}
    </div>
  );
}

export function TeamEditor({ mode, id, advanced }: TeamEditorProps) {
  const { boot, ui } = useApp();
  const say = useAnnouncer(ui.activityAnnouncements);
  const demander = useConfirm();

  const equipes = useAsync<TeamsListResponse>(() => teamsApi.list(), []);
  /** Assistants installés : lus SEULEMENT quand l'éditeur est monté (en Simple fermé, rien n'est demandé). */
  const [assistants, setAssistants] = useState<readonly EditorAssistantView[] | null>(null);
  const [ecran, setEcran] = useState<EcranId>(mode === "modifier" ? 2 : 1);
  const [historique, setHistorique] = useState<EditHistory>(() => historiqueDe(brouillonVide()));
  const [titre, setTitre] = useState("");
  const [description, setDescription] = useState("");
  const [apercu, setApercu] = useState<TeamPreviewResponse | null>(null);
  const [erreur, setErreur] = useState<string | null>(null);
  const [modifie, setModifie] = useState(false);
  const [enregistrement, setEnregistrement] = useState(false);
  /** Brouillon posé (équipe modifiée ou dupliquée) : une seule fois, à la première lecture des équipes. */
  const pose = useRef(false);
  /**
   * Modifications non enregistrées, lues par la garde de navigation AU MOMENT du départ : l'enregistrement la remet à faux avant
   * de changer de vue, sinon la confirmation s'ouvrirait juste après une équipe pourtant enregistrée (l'état React n'est pas
   * encore reposé quand la vue change).
   */
  const modifieRef = useRef(false);
  /** Dernier problème bloquant annoncé : une annonce par changement, jamais une à chaque aperçu. */
  const ditDernier = useRef<string | null>(null);
  const titreId = useId();
  const quandId = useId();

  const donnees = equipes.data;
  const ouvertes = advanced || donnees?.ouvertesEnSimple === true;

  // Équipe modifiée (ou dupliquée par [Dupliquer] de l'onglet Équipes) : son déroulé devient le brouillon de départ. Le nom d'une
  // copie part VIDE : deux équipes ne portent pas le même nom, et l'écran 4 demande le nouveau nom avant d'enregistrer.
  useEffect(() => {
    if (donnees === null || pose.current || !ouvertes) return;
    pose.current = true;
    const source = mode === "modifier" ? id : prendreDuplication();
    const equipe = source === null ? undefined : donnees.teams.find((team) => team.id === source);
    if (equipe === undefined) return;
    setHistorique(historiqueDe(brouillonDe(equipe.flow)));
    setDescription(equipe.description);
    if (mode === "modifier") setTitre(equipe.titre);
    setEcran(2);
  }, [donnees, id, mode, ouvertes]);

  useEffect(() => {
    if (!ouvertes || assistants !== null) return;
    let annule = false;
    void (async () => {
      try {
        const reponse = await api.assistants();
        if (!annule) setAssistants(reponse.assistants.map(vueAssistant));
      } catch {
        // Liste indisponible : les étapes gardent leur assistant et la grammaire du serveur (aperçu) reste seule juge.
        if (!annule) setAssistants([]);
      }
    })();
    return () => {
      annule = true;
    };
  }, [ouvertes, assistants]);

  const draft = historique.present;
  const noms = useMemo(() => new Map((assistants ?? []).map((assistant) => [assistant.name, assistant.title])), [assistants]);
  const layout = useMemo(() => layoutFlow(draft.flow, noms), [draft, noms]);
  const lignes = useMemo(() => flowAsList(draft.flow, noms), [draft, noms]);

  const niveaux: readonly EditorTier[] = useMemo(
    () => boot.ai.tiers.map((tier) => ({ niveau: tier.id, libelle: tier.label, coutParTaille: tier.taskCost, disponible: tier.model !== null })),
    [boot.ai.tiers],
  );

  const autres = useMemo(() => (donnees?.teams ?? []).filter((team) => !(mode === "modifier" && team.id === id)), [donnees, id, mode]);

  const modele = buildEditor({
    mode,
    advanced,
    ouvertesEnSimple: donnees === null ? null : donnees.ouvertesEnSimple,
    ecran,
    historique,
    titre,
    description,
    apercu,
    liste: lignes,
    exemples: donnees?.exemples ?? [],
    assistants: assistants ?? [],
    niveaux,
    nomsPris: autres.map((team) => team.titre),
    chargement: equipes.loading,
    erreur: erreur ?? (equipes.error === null ? null : errorText(equipes.error)),
  });

  // Aperçu 300 ms après la dernière modification. `apercuDemande` est faux tant que l'éditeur n'est pas monté (Simple fermé, U1) :
  // aucune requête ne part alors.
  const corps = useMemo(() => ({ flow: draft.flow, titre, description }), [draft, titre, description]);
  const apercuDemande = modele.apercuDemande;
  useEffect(() => {
    if (!apercuDemande) return;
    const timer = window.setTimeout(() => {
      void (async () => {
        try {
          const vue = await teamsApi.preview(corps);
          setApercu(vue);
          // Un aperçu qui aboutit DÉMENT la phrase de refus laissée par l'aperçu précédent (ou par un enregistrement refusé,
          // que la modification du brouillon vient justement de périmer) : elle ne doit pas rester annoncée (P3).
          setErreur(null);
        } catch (err) {
          setApercu(null);
          setErreur(texteRefus(teamError(err), errorText(err)));
        }
      })();
    }, APERCU_MS);
    return () => window.clearTimeout(timer);
  }, [corps, apercuDemande]);

  // Annonce POLIE d'un problème bloquant par la région de la page (jamais une région nouvelle) : une fois par changement.
  const bloquant = apercu?.problems.find((probleme) => probleme.bloquant)?.code ?? null;
  useEffect(() => {
    if (bloquant === null) {
      ditDernier.current = null;
      return;
    }
    if (ditDernier.current === bloquant) return;
    ditDernier.current = bloquant;
    say(phraseErreur("equipe-invalide"));
  }, [bloquant, say]);

  // Quitter avec des modifications : confirmation (navigation interne et fermeture de l'onglet).
  const quitter = modele.quitter;
  useEffect(() => {
    if (!modifie) return;
    const retirer = setNavigationGuard(() =>
      modifieRef.current
        ? demander({ title: quitter.titre, message: quitter.message, confirmLabel: quitter.quitter, cancelLabel: quitter.rester, danger: true })
        : Promise.resolve(true),
    );
    const avantFermeture = (event: BeforeUnloadEvent) => event.preventDefault();
    window.addEventListener("beforeunload", avantFermeture);
    return () => {
      retirer();
      window.removeEventListener("beforeunload", avantFermeture);
    };
  }, [modifie, demander, quitter]);

  /** Marque des modifications non enregistrées, pour la garde de navigation comme pour le rendu. */
  const marquerModifie = useCallback(() => {
    modifieRef.current = true;
    setModifie(true);
  }, []);

  /** Applique une opération d'édition : historique et marque de modification, rien d'autre. */
  const editer = useCallback(
    (operation: (brouillon: FlowDraft) => FlowDraft) => {
      marquerModifie();
      setHistorique((precedent) => appliquer(precedent, operation));
    },
    [marquerModifie],
  );

  const partirDe = (brouillon: FlowDraft) => {
    marquerModifie();
    setHistorique(historiqueDe(brouillon));
    setEcran(2);
  };

  /**
   * Ctrl+Z et Ctrl+Maj+Z, posés sur l'éditeur : ils n'agissent que quand le focus est dedans (spéc. §5.5), et JAMAIS dans un
   * champ de saisie, où le raccourci appartient au navigateur. Le nom de l'équipe et « Quand l'utiliser » ne sont pas dans
   * l'historique du déroulé : sans cette garde, un Ctrl+Z réflexe pour corriger une faute de frappe défairait une opération de
   * structure. Les boutons [Annuler la dernière modification] et [Rétablir] restent le chemin explicite du déroulé.
   */
  const auClavier = (event: KeyboardEvent<HTMLDivElement>) => {
    if (!(event.ctrlKey || event.metaKey) || event.key.toLowerCase() !== "z") return;
    const cible = event.target as HTMLElement | null;
    if (cible !== null && cible.closest("input, textarea, select") !== null) return;
    event.preventDefault();
    const versLeFutur = event.shiftKey;
    setHistorique((precedent) => (versLeFutur ? retablir(precedent) : annuler(precedent)));
  };

  const enregistrer = async () => {
    const aEnvoyer = corpsEnregistrement({ titre, description, draft });
    const equipeId = mode === "modifier" && id !== null ? id : identifiantEquipe(aEnvoyer.titre, autres.map((team) => team.id));
    setEnregistrement(true);
    setErreur(null);
    try {
      await teamsApi.put(equipeId, aEnvoyer);
      // Équipe enregistrée : plus rien à perdre, la garde laisse partir sans confirmation.
      modifieRef.current = false;
      setModifie(false);
      openAssistants({ mode: "equipes" });
    } catch (err) {
      const refus = teamError(err);
      setErreur(texteRefus(refus, errorText(err)));
      // 422 equipe-invalide : les problèmes du serveur remplacent ceux de l'aperçu, sur les mêmes blocs et les mêmes étapes.
      const problems = refus?.problems;
      if (problems !== undefined) setApercu((precedent) => (precedent === null ? precedent : { ...precedent, problems }));
    } finally {
      setEnregistrement(false);
    }
  };

  const retour = (
    <a className="btn ghost tm-ed-retour" href={assistantsHref({ mode: "equipes" })}>
      {modele.retour}
    </a>
  );

  if (modele.affichage === "chargement") return <Spinner large />;

  if (modele.ferme !== null) {
    return (
      <div className="stack loose tm-ed">
        <h2 className="tm-ed-titre">{modele.titre}</h2>
        <p className="callout tm-ferme">
          <Icon name="lock" size={18} />
          <span>{modele.ferme.texte}</span>
        </p>
        <p className="row wrap">{retour}</p>
      </div>
    );
  }

  // Écrans sortis du modèle une fois pour toutes : un seul écran est non nul à la fois (buildEditor), et chaque bloc de rendu
  // lit une constante, jamais une propriété qui pourrait changer entre deux lignes.
  const { progression, ecran1, ecran2, ecran3, ecran4 } = modele;

  return (
    <div className="stack loose tm-ed" onKeyDown={auClavier}>
      <div className="row wrap between tm-ed-entete">
        <h2 className="tm-ed-titre">{modele.titre}</h2>
        {retour}
      </div>

      {progression !== null ? (
        <ol className="row wrap tm-ed-progression" aria-label={progression.libelle}>
          {progression.ecrans.map((nom, rang) => {
            const courant = rang + 1 === progression.courant;
            return (
              <li key={nom} className={`tm-ed-pas${courant ? " courant" : ""}`} aria-current={courant ? "step" : undefined}>
                {courant ? progression.texte : nom}
              </li>
            );
          })}
        </ol>
      ) : null}

      {modele.erreur !== null ? (
        <p className="callout critical tm-erreur" role="alert">
          <Icon name="alert" size={18} />
          <span>{modele.erreur}</span>
        </p>
      ) : null}

      {modele.problemes.length > 0 ? (
        <ul className="stack tight tm-ed-problemes">
          {modele.problemes.map((probleme) => (
            <li key={probleme.code} className={`tm-ed-probleme${probleme.bloquant ? " bloquant" : ""}`}>
              <Icon name="alert" size={15} />
              <span>{probleme.texte}</span>
            </li>
          ))}
        </ul>
      ) : null}

      <div className="tm-ed-corps">
        <div className="stack loose tm-ed-principal">
          {ecran1 !== null ? (
            <>
              <section className="stack" aria-label={ecran1.partirExemple}>
                <h3 className="tm-ed-sous-titre">{ecran1.partirExemple}</h3>
                <div className="tm-ed-cartes">
                  {ecran1.exemples.map((exemple) => (
                    <div key={exemple.id} className="card tm-ed-choix">
                      <button
                        type="button"
                        className="btn primary tm-ed-choix-bouton"
                        onClick={() => {
                          const source = donnees?.exemples.find((item) => item.id === exemple.id);
                          if (source !== undefined) partirDe(brouillonDe(source.flow));
                        }}
                      >
                        {exemple.titre}
                      </button>
                      <p className="secondary small">{exemple.description}</p>
                      <FlowList liste={exemple.liste} libelle={libelleSchema(exemple.layout, null)} toujoursVisible />
                    </div>
                  ))}
                </div>
              </section>
              <section className="stack" aria-label={ecran1.partirForme}>
                <h3 className="tm-ed-sous-titre">{ecran1.partirForme}</h3>
                <div className="tm-ed-cartes">
                  {ecran1.formes.map((forme) => (
                    <div key={forme.id} className="card tm-ed-choix">
                      <button type="button" className="btn primary tm-ed-choix-bouton" onClick={() => partirDe(brouillonDeForme(forme.id))}>
                        {forme.titre}
                      </button>
                      <p className="secondary small">{forme.aide}</p>
                    </div>
                  ))}
                </div>
              </section>
            </>
          ) : null}

          {ecran2 !== null ? (
            <div className="stack loose tm-ed-etapes">
              <div className="row wrap tm-ed-historique">
                <Historique modele={ecran2.annuler} icone="undo" onClic={() => setHistorique(annuler)} />
                <Historique modele={ecran2.retablir} icone="refresh" onClic={() => setHistorique(retablir)} />
              </div>

              {ecran2.blocs.map((bloc, rang) => (
                <div key={bloc.blocId} className="stack tm-ed-rang">
                  <Ajout ajout={ecran2.ajouter} onAjouter={(type) => editer((d) => ajouterBloc(d, type, rang))} />
                  <BlockCard
                    bloc={bloc}
                    onMonter={() => editer((d) => monter(d, bloc.blocId))}
                    onDescendre={() => editer((d) => descendre(d, bloc.blocId))}
                    onSupprimer={() => editer((d) => supprimerBloc(d, bloc.blocId))}
                    onDupliquer={() => editer((d) => dupliquerBloc(d, bloc.blocId))}
                    onAjouterAvis={() => editer((d) => ajouterAvis(d, bloc.blocId))}
                    onRetirerAvis={(stepId) => editer((d) => retirerAvis(d, bloc.blocId, stepId))}
                    onPatchEtape={(stepId, patch: StepPatch) => editer((d) => modifierEtape(d, stepId, patch, { simple: !advanced }))}
                    onPause={(message) => editer((d) => modifierPause(d, bloc.blocId, message))}
                  />
                </div>
              ))}
              <Ajout ajout={ecran2.ajouter} onAjouter={(type) => editer((d) => ajouterBloc(d, type, draft.flow.blocs.length))} />
            </div>
          ) : null}

          {ecran3 !== null ? (
            <section className="stack" aria-label={ecran3.titre}>
              <h3 className="tm-ed-sous-titre">{ecran3.titre}</h3>
              <div className="table-wrap">
                <table className="table tm-ed-cout">
                  <thead>
                    <tr>
                      {ecran3.colonnes.map((colonne) => (
                        <th key={colonne}>{colonne}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {ecran3.lignes.map((ligne) => (
                      <tr key={ligne.stepId}>
                        <td>{ligne.etape}</td>
                        <td>{ligne.assistant}</td>
                        <td>{ligne.ia}</td>
                        <td className="num">{ligne.typique}</td>
                        <td className="num">{ligne.maximum}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {ecran3.total !== null ? <p className="tm-ed-total">{ecran3.total}</p> : null}
              <p className="callout tm-ed-arret">
                <Icon name="coins" size={18} />
                <span>{ecran3.arret}</span>
              </p>
              <p className="secondary small">{ecran3.enGeneralAide}</p>
              <p className="secondary small">{ecran3.plafondAide}</p>
            </section>
          ) : null}

          {ecran4 !== null ? (
            <div className="stack loose tm-ed-verifier">
              <div className="field">
                <label htmlFor={titreId}>{ecran4.nom.libelle}</label>
                <input
                  id={titreId}
                  type="text"
                  maxLength={ecran4.nom.max}
                  placeholder={ecran4.nom.exemple}
                  value={ecran4.nom.valeur}
                  onChange={(event) => {
                    marquerModifie();
                    setTitre(event.target.value);
                  }}
                />
                {ecran4.nom.erreur !== null ? <span className="field-error">{ecran4.nom.erreur}</span> : null}
              </div>

              <div className="field">
                <label htmlFor={quandId}>{ecran4.quand.libelle}</label>
                <input
                  id={quandId}
                  type="text"
                  maxLength={ecran4.quand.max}
                  value={ecran4.quand.valeur}
                  onChange={(event) => {
                    marquerModifie();
                    setDescription(event.target.value);
                  }}
                />
                <span className="field-hint">{ecran4.quand.aide}</span>
              </div>

              <FlowList liste={ecran4.liste} libelle={libelleSchema(layout, null)} toujoursVisible />

              <section className="stack tight" aria-label={ecran4.droits.titre}>
                <h3 className="tm-ed-sous-titre">{ecran4.droits.titre}</h3>
                <ul className="stack tight tm-ed-droits">
                  {ecran4.droits.lignes.map((ligne) => (
                    <li key={ligne.id} className={`tm-ed-droit tm-ed-droit-${ligne.kind}`}>
                      {ligne.text}
                    </li>
                  ))}
                </ul>
              </section>

              <div className="tm-ed-partage">
                <section className="stack tight">
                  <h3 className="tm-ed-sous-titre">{ecran4.controle.titre}</h3>
                  <p className="secondary small">{ecran4.controle.texte}</p>
                </section>
                <section className="stack tight">
                  <h3 className="tm-ed-sous-titre">{ecran4.decide.titre}</h3>
                  <p className="secondary small">{ecran4.decide.texte}</p>
                </section>
              </div>

              <ul className="stack tight tm-ed-honnetete">
                {ecran4.honnetete.map((phrase) => (
                  <li key={phrase}>{phrase}</li>
                ))}
              </ul>
              <p className="secondary small">{ecran4.pasGaranti}</p>
              <p className="callout tm-ed-confidentialite">
                <Icon name="shield" size={18} />
                <span>{ecran4.confidentialite}</span>
              </p>

              {ecran4.refus !== null ? (
                <p className="callout critical tm-ed-refus" role="alert">
                  <Icon name="alert" size={18} />
                  <span>{ecran4.refus}</span>
                </p>
              ) : null}

              <div className="row wrap">
                <button
                  type="button"
                  className="btn primary"
                  aria-disabled={!ecran4.enregistrable || enregistrement}
                  onClick={() => {
                    if (ecran4.enregistrable && !enregistrement) void enregistrer();
                  }}
                >
                  <Icon name="check" size={16} />
                  {ecran4.enregistrer}
                </button>
              </div>
            </div>
          ) : null}
        </div>

        {modele.schemaACote ? (
          <aside className="tm-ed-schema">
            <FlowList liste={lignes} libelle={libelleSchema(layout, null)} schema={<FlowSchema layout={layout} />} />
          </aside>
        ) : null}
      </div>

      <div className="row wrap between tm-ed-pied">
        <span className="row wrap">
          {modele.precedent !== null ? (
            <button type="button" className="btn" onClick={() => setEcran(reculer)}>
              {modele.precedent}
            </button>
          ) : null}
        </span>
        <span className="row wrap">
          {modele.suivant !== null ? (
            <button type="button" className="btn primary" onClick={() => setEcran(avancer)}>
              {modele.suivant}
            </button>
          ) : null}
        </span>
      </div>
    </div>
  );
}

const reculer = (ecran: EcranId): EcranId => (ecran === 1 ? 1 : ((ecran - 1) as EcranId));
const avancer = (ecran: EcranId): EcranId => (ecran === 4 ? 4 : ((ecran + 1) as EcranId));

/** [Annuler la dernière modification] et [Rétablir] : focalisables même impossibles, leur état dit par aria-disabled. */
function Historique({ modele, icone, onClic }: { modele: { libelle: string; possible: boolean }; icone: "undo" | "refresh"; onClic: () => void }) {
  return (
    <button
      type="button"
      className="btn sm"
      aria-disabled={!modele.possible}
      onClick={() => {
        if (modele.possible) onClic();
      }}
    >
      <Icon name={icone} size={14} />
      {modele.libelle}
    </button>
  );
}
