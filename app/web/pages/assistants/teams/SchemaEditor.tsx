// Propriétaire : L43.
// SCHÉMA MODIFIABLE d'une équipe (spécification §5.3 l.903, §5.5, §5.6 l.928, §6 ; C §8.2, §9.12, §11 S4, D10 ; plan d'exécution
// it5, fiches L42d et L43). Seconde façon de modifier la MÊME équipe, en mode AVANCÉ seulement : c'est TeamEditor qui ne propose
// la bascule qu'en Avancé, et qui rend la phrase des écrans étroits à la place de cette vue sous 900 px (spéc. l.903).
//
// Ce composant reste MINCE (D-eq-24) : toutes les opérations, tous les refus et tout le modèle de la vue sont dans le module pur
// ../../../../server/shared/flow-schema-ops.ts, testé par server/flow-schema-ops.test.ts. Aucun texte n'est écrit ici.
//
// GLISSER (P8 : AUCUNE dépendance npm nouvelle) : événements `pointer` natifs, capture du pointeur, et la cible lue sous le
// pointeur par `elementFromPoint` et les attributs `data-sc-*`. Deux gestes, et CHACUN a son bouton ou son menu (WCAG 2.5.7) :
// - déplacer un bloc → « Monter » · « Descendre », et Alt+↑ / Alt+↓ sur la ligne ;
// - tirer un lien depuis le port de sortie d'une étape → menu « Reçoit le résultat de… » de l'étape qui reçoit (cases des étapes
//   situées plus haut). Le port lui-même est DÉCORATIF (aria-hidden) : il double un chemin clavier complet, il n'en crée pas.
// Le reste tient dans des menus : « Ajouter après », « Transformer en… », « Supprimer », les avis et les spécialistes, le nombre
// de tours et le nombre de spécialistes à consulter.
//
// REFUS (C §8.2) : `dropCheck` est interrogé à chaque survol, et sa phrase est écrite PRÈS DE LA CIBLE, en toutes lettres, avec
// son icône — jamais par la couleur seule (§5.5) — puis annoncée POLIMENT par la région de la page (aucune région nouvelle).
//
// HISTORIQUE : celui de l'éditeur, et lui seul. Ce composant ne garde aucun état d'annulation : il rend une opération par
// `onOperation`, que TeamEditor applique à son historique annuler / rétablir (flow-edit.ts, 100 états).
//
// PROBLÈMES : ceux de l'aperçu du SERVEUR (POST /api/teams/preview) font foi. En attendant l'aperçu suivant (300 ms), la
// revalidation locale de la STRUCTURE complète l'affichage, sans jamais le contredire : le serveur revalide de toute façon à
// l'enregistrement ET au lancement (C §11 S4), et le navigateur n'est jamais la seule autorité.
import { Fragment, type KeyboardEvent, type PointerEvent as ReactPointerEvent, type ReactNode, useCallback, useMemo, useRef, useState } from "react";
import type { FlowDraft } from "../../../../server/shared/flow-edit.ts";
import {
  addAvis,
  addSpecialiste,
  contexteStructure,
  dropCheck,
  fusionnerProblemes,
  insertAfter,
  moveDown,
  moveTo,
  moveUp,
  problemesStructurels,
  removeAvis,
  removeBloc,
  removeSpecialiste,
  type SchemaCible,
  type SchemaContext,
  type SchemaLigneModel,
  type SchemaOpResult,
  type SchemaSource,
  schemaModel,
  setChoixMax,
  setRecoit,
  setTours,
  transform,
} from "../../../../server/shared/flow-schema-ops.ts";
import type { Flow, FlowProblem } from "../../../../server/shared/team-types.ts";
import { Icon } from "../../../components/Icon.tsx";
import { FlowList } from "./FlowList.tsx";
import { MOTS_LIGNE } from "./teams-tab-model.ts";
import "./schema.css";

export interface SchemaEditorProps {
  /** Brouillon courant de l'éditeur : le déroulé et le compteur d'identifiants. */
  draft: FlowDraft;
  /** Lignes du déroulé (flowAsList de L36b) : la vérité pour le lecteur d'écran. */
  liste: readonly string[];
  /** Libellé chiffré de la figure (libelleSchema de teams-tab-model.ts). */
  libelle: string;
  /** « Même équipe, deux façons de la modifier. Le schéma n'accepte que ce que le cockpit sait exécuter. » (§4.3). */
  phrase: string;
  /** Problèmes rendus par l'aperçu du serveur ; vide tant qu'aucun aperçu n'est arrivé. */
  problemes: readonly FlowProblem[];
  /** Opération appliquée à l'historique de l'éditeur (MÊME annuler / rétablir que les étapes). */
  onOperation: (operation: (brouillon: FlowDraft) => FlowDraft) => void;
  /** Annonce polie par la région aria-live de la page (réglage ui.activityAnnouncements). */
  onAnnonce: (texte: string) => void;
}

/** Une opération du module pur, telle que ce composant la lance. */
type Operation = (flow: Flow, ctx: SchemaContext) => SchemaOpResult;

/** Cible lue sous le pointeur, par les attributs `data-sc-*` posés sur les lignes, les étapes et les places. */
function cibleSous(x: number, y: number): SchemaCible | null {
  const sous = document.elementFromPoint(x, y);
  if (sous === null) return null;
  const etape = sous.closest("[data-sc-etape]")?.getAttribute("data-sc-etape");
  if (typeof etape === "string" && etape !== "") return { genre: "etape", stepId: etape };
  const place = sous.closest("[data-sc-place]")?.getAttribute("data-sc-place");
  if (typeof place === "string" && place !== "") return { genre: "place", index: Number(place) };
  const bloc = sous.closest("[data-sc-bloc]")?.getAttribute("data-sc-bloc");
  if (typeof bloc === "string" && bloc !== "") return { genre: "bloc", blocId: bloc };
  return null;
}

/** Commandes d'une ligne : un appui dessus n'est jamais le début d'un glisser de bloc. */
const COMMANDES = "button, summary, input, label, textarea, .sc-port";

/** Clé d'affichage d'un refus : la ligne, l'étape ou la place où la phrase est écrite, au plus près de la cible. */
function cleDe(cible: SchemaCible | null): string {
  if (cible === null) return "";
  if (cible.genre === "etape") return `e:${cible.stepId}`;
  if (cible.genre === "place") return `p:${cible.index}`;
  return `b:${cible.blocId}`;
}

export function SchemaEditor({ draft, liste, libelle, phrase, problemes, onOperation, onAnnonce }: SchemaEditorProps) {
  /** Le schéma n'existe qu'en mode Avancé (spéc. l.903) : la revalidation locale juge donc la structure de ce mode. */
  const contexteDe = useCallback((brouillon: FlowDraft): SchemaContext => contexteStructure(brouillon.compteur), []);
  const [glisse, setGlisse] = useState<SchemaSource | null>(null);
  const [survol, setSurvol] = useState<{ cle: string; refus: string | null } | null>(null);
  const [refus, setRefus] = useState<{ cle: string; texte: string } | null>(null);
  const dernierRefus = useRef<string | null>(null);

  const locaux = useMemo(() => problemesStructurels(draft.flow), [draft]);
  const vus = useMemo(() => fusionnerProblemes(problemes, locaux), [problemes, locaux]);
  const modele = useMemo(() => schemaModel(draft.flow, vus, contexteDe(draft)), [draft, vus, contexteDe]);

  /** Refus annoncé une seule fois par phrase, poliment, et écrit près de la cible. */
  const refuser = useCallback(
    (cle: string, texte: string) => {
      setRefus({ cle, texte });
      if (dernierRefus.current === texte) return;
      dernierRefus.current = texte;
      onAnnonce(texte);
    },
    [onAnnonce],
  );

  /**
   * Lance une opération : elle est d'abord jouée sur le brouillon RENDU (pour dire un refus tout de suite), puis rejouée dans la
   * mise à jour de l'historique, sur le brouillon COURANT — deux gestes rapides ne se marchent donc jamais dessus.
   */
  const lancer = useCallback(
    (operation: Operation, cle: string) => {
      const essai = operation(draft.flow, contexteDe(draft));
      if (essai.refus !== null) {
        refuser(cle, essai.refus.texte);
        return;
      }
      if (!essai.change) return;
      setRefus(null);
      dernierRefus.current = null;
      onOperation((courant) => {
        const fait = operation(courant.flow, contexteDe(courant));
        return fait.change ? { flow: fait.flow, compteur: fait.compteur } : courant;
      });
    },
    [draft, contexteDe, onOperation, refuser],
  );

  const commencer = useCallback((event: ReactPointerEvent<Element>, source: SchemaSource) => {
    event.preventDefault();
    event.currentTarget.setPointerCapture?.(event.pointerId);
    setGlisse(source);
    setSurvol(null);
  }, []);

  const bouger = useCallback(
    (event: ReactPointerEvent<Element>) => {
      if (glisse === null) return;
      const cible = cibleSous(event.clientX, event.clientY);
      if (cible === null) {
        setSurvol(null);
        return;
      }
      const verdict = dropCheck(draft.flow, glisse, cible);
      setSurvol({ cle: cleDe(cible), refus: verdict.ok ? null : modele.refus[verdict.code] });
    },
    [glisse, draft, modele],
  );

  const lacher = useCallback(
    (event: ReactPointerEvent<Element>) => {
      if (glisse === null) return;
      const source = glisse;
      setGlisse(null);
      setSurvol(null);
      // La capture du pointeur est relâchée par le navigateur au `pointerup` et au `pointercancel` : rien à défaire ici.
      const cible = cibleSous(event.clientX, event.clientY);
      if (cible === null) return;
      const verdict = dropCheck(draft.flow, source, cible);
      if (!verdict.ok) {
        refuser(cleDe(cible), modele.refus[verdict.code]);
        return;
      }
      if (source.genre === "bloc" && cible.genre === "place") {
        lancer((flow, ctx) => moveTo(flow, source.blocId, cible.index, ctx), cleDe(cible));
        return;
      }
      if (source.genre === "lien" && (cible.genre === "etape" || cible.genre === "bloc")) {
        const stepId = cible.genre === "etape" ? cible.stepId : (modele.lignes.find((ligne) => ligne.blocId === cible.blocId)?.etapes[0]?.stepId ?? "");
        const ligne = modele.lignes.find((item) => item.etapes.some((etape) => etape.stepId === stepId));
        const deja = ligne?.etapes.find((etape) => etape.stepId === stepId)?.recoit?.choix.filter((choix) => choix.cochee).map((choix) => choix.stepId) ?? [];
        lancer((flow, ctx) => setRecoit(flow, stepId, [...new Set([...deja, source.stepId])], ctx), cleDe(cible));
      }
    },
    [glisse, draft, modele, lancer, refuser],
  );

  const annuler = useCallback(() => {
    setGlisse(null);
    setSurvol(null);
  }, []);

  /** Alt+↑ et Alt+↓ : le clavier fait EXACTEMENT ce que le glisser fait, sans raccourci à une touche (spéc. §5.5). */
  const auClavier = useCallback(
    (event: KeyboardEvent<HTMLLIElement>, ligne: SchemaLigneModel) => {
      if (!event.altKey || (event.key !== "ArrowUp" && event.key !== "ArrowDown")) return;
      event.preventDefault();
      const vers = event.key === "ArrowUp";
      if (vers ? !ligne.monter.possible : !ligne.descendre.possible) return;
      lancer((flow, ctx) => (vers ? moveUp(flow, ligne.blocId, ctx) : moveDown(flow, ligne.blocId, ctx)), `b:${ligne.blocId}`);
    },
    [lancer],
  );

  const messageDe = (cle: string): string | null => {
    if (survol !== null && survol.cle === cle) return survol.refus;
    return refus !== null && refus.cle === cle ? refus.texte : null;
  };

  const place = (index: number) => {
    const message = messageDe(`p:${index}`);
    return (
      <li className="sc-place" data-sc-place={index} key={`place-${index}`}>
        {message === null ? null : <Refus texte={message} />}
      </li>
    );
  };

  return (
    <div className="stack tm-ed-schema-editeur">
      <p className="secondary small">{phrase}</p>
      <p className="secondary small sc-aide">{modele.aide}</p>

      {modele.problemes.length > 0 ? (
        <ul className="stack tight tm-ed-problemes">
          {modele.problemes.map((probleme, rangProbleme) => (
            <li key={`${probleme.code}-${rangProbleme}`} className={`tm-ed-probleme${probleme.bloquant ? " bloquant" : ""}`}>
              <Icon name="alert" size={15} />
              <span>{probleme.texte}</span>
            </li>
          ))}
        </ul>
      ) : null}

      <ol className="stack sc-lignes" onPointerMove={bouger} onPointerUp={lacher} onPointerCancel={annuler}>
        {modele.lignes.map((ligne, rang) => (
          <Fragment key={`${ligne.blocId}-${ligne.kind}`}>
            {ligne.principale ? place(ligne.index) : null}
            <li
              className={`card sc-ligne tm-kind-${ligne.kind}${glisse !== null ? " sc-glisse" : ""}`}
              data-sc-bloc={ligne.blocId}
              data-sc-index={ligne.index}
              tabIndex={0}
              role="group"
              aria-label={MOTS_LIGNE[ligne.kind]}
              onKeyDown={(event) => auClavier(event, ligne)}
              onPointerDown={(event) => {
                // Le bloc se glisse par sa ligne, jamais par une commande : un appui sur un bouton, un menu ou une case reste
                // un appui sur cette commande.
                const sous = event.target as HTMLElement;
                if (!ligne.principale || sous.closest(COMMANDES) !== null) return;
                commencer(event, { genre: "bloc", blocId: ligne.blocId });
              }}
            >
              <p className={`sc-mot tm-kind-${ligne.kind}`}>{MOTS_LIGNE[ligne.kind]}</p>

              <div className="row wrap sc-cellules">
                {ligne.etapes.map((etape) => (
                  <div className="sc-cellule" data-sc-etape={etape.stepId} key={etape.stepId}>
                    <span className="sc-titre">{etape.titre}</span>
                    <span className="sc-sous-titre">{etape.sousTitre}</span>
                    {/* Port de sortie : DÉCORATIF (le clavier passe par le menu « Reçoit le résultat de… » de l'étape visée). */}
                    <span
                      className="sc-port"
                      aria-hidden="true"
                      onPointerDown={(event) => {
                        event.stopPropagation();
                        commencer(event, { genre: "lien", stepId: etape.stepId });
                      }}
                    />
                    {etape.recoit === null ? null : (
                      <details className="sc-menu">
                        <summary className="btn sm">{etape.recoit.libelle}</summary>
                        <div className="stack tight sc-menu-corps">
                          {etape.recoit.choix.map((choix) => (
                            <label className="row sc-case" key={choix.stepId}>
                              <input
                                type="checkbox"
                                checked={choix.cochee}
                                onChange={() => {
                                  const retenues = etape.recoit?.choix.filter((item) => item.cochee).map((item) => item.stepId) ?? [];
                                  const suite = choix.cochee ? retenues.filter((id) => id !== choix.stepId) : [...retenues, choix.stepId];
                                  lancer((flow, ctx) => setRecoit(flow, etape.stepId, suite, ctx), `e:${etape.stepId}`);
                                }}
                              />
                              <span>{choix.libelle}</span>
                            </label>
                          ))}
                        </div>
                      </details>
                    )}
                    {etape.retirer === null ? null : (
                      <button
                        type="button"
                        className="btn sm ghost"
                        onClick={() =>
                          lancer(
                            (flow, ctx) =>
                              ligne.kind === "avis"
                                ? removeAvis(flow, ligne.blocId, etape.stepId, ctx)
                                : removeSpecialiste(flow, ligne.blocId, etape.stepId, ctx),
                            `e:${etape.stepId}`,
                          )
                        }
                      >
                        {etape.retirer}
                      </button>
                    )}
                    {etape.problemes.map((probleme, rangProbleme) => (
                      <p key={`${probleme.code}-${rangProbleme}`} className={`sc-probleme${probleme.bloquant ? " bloquant" : ""}`}>
                        <Icon name="alert" size={14} />
                        <span>{probleme.texte}</span>
                      </p>
                    ))}
                  </div>
                ))}
              </div>

              {ligne.problemes.map((probleme, rangProbleme) => (
                <p key={`${probleme.code}-${rangProbleme}`} className={`sc-probleme${probleme.bloquant ? " bloquant" : ""}`}>
                  <Icon name="alert" size={14} />
                  <span>{probleme.texte}</span>
                </p>
              ))}

              {ligne.principale ? (
                <div className="row wrap sc-actions">
                  <button
                    type="button"
                    className="btn sm"
                    aria-disabled={!ligne.monter.possible}
                    onClick={() => {
                      if (ligne.monter.possible) lancer((flow, ctx) => moveUp(flow, ligne.blocId, ctx), `b:${ligne.blocId}`);
                    }}
                  >
                    {ligne.monter.libelle}
                  </button>
                  <button
                    type="button"
                    className="btn sm"
                    aria-disabled={!ligne.descendre.possible}
                    onClick={() => {
                      if (ligne.descendre.possible) lancer((flow, ctx) => moveDown(flow, ligne.blocId, ctx), `b:${ligne.blocId}`);
                    }}
                  >
                    {ligne.descendre.libelle}
                  </button>
                  <Menu libelle={ligne.ajouterApres.libelle}>
                    {ligne.ajouterApres.choix.map((choix) => (
                      <button
                        key={choix.forme}
                        type="button"
                        className="btn sm"
                        aria-disabled={!choix.possible}
                        onClick={() => {
                          if (choix.possible) lancer((flow, ctx) => insertAfter(flow, ligne.blocId, choix.forme, ctx), `b:${ligne.blocId}`);
                        }}
                      >
                        {choix.libelle}
                      </button>
                    ))}
                  </Menu>
                  <Menu libelle={ligne.transformer.libelle}>
                    {ligne.transformer.choix.map((choix) => (
                      <button
                        key={choix.forme}
                        type="button"
                        className="btn sm"
                        aria-disabled={!choix.possible}
                        onClick={() => {
                          if (choix.possible) lancer((flow, ctx) => transform(flow, ligne.blocId, choix.forme, ctx), `b:${ligne.blocId}`);
                        }}
                      >
                        {choix.libelle}
                      </button>
                    ))}
                  </Menu>
                  {ligne.ajouterEtape === null ? null : (
                    <button
                      type="button"
                      className="btn sm"
                      onClick={() =>
                        lancer((flow, ctx) => (ligne.kind === "avis" ? addAvis(flow, ligne.blocId, ctx) : addSpecialiste(flow, ligne.blocId, ctx)), `b:${ligne.blocId}`)
                      }
                    >
                      {ligne.ajouterEtape}
                    </button>
                  )}
                  {ligne.tours === null ? null : (
                    <Nombre modele={ligne.tours} onChoisir={(valeur) => lancer((flow, ctx) => setTours(flow, ligne.blocId, valeur, ctx), `b:${ligne.blocId}`)} />
                  )}
                  {ligne.choixMax === null ? null : (
                    <Nombre modele={ligne.choixMax} onChoisir={(valeur) => lancer((flow, ctx) => setChoixMax(flow, ligne.blocId, valeur, ctx), `b:${ligne.blocId}`)} />
                  )}
                  <button
                    type="button"
                    className="btn sm ghost"
                    aria-disabled={!ligne.supprimer.possible}
                    onClick={() => {
                      if (ligne.supprimer.possible) lancer((flow, ctx) => removeBloc(flow, ligne.blocId, ctx), `b:${ligne.blocId}`);
                    }}
                  >
                    {ligne.supprimer.libelle}
                  </button>
                </div>
              ) : null}

              {messageDe(`b:${ligne.blocId}`) === null ? null : <Refus texte={messageDe(`b:${ligne.blocId}`) ?? ""} />}
              {ligne.etapes.map((etape) =>
                messageDe(`e:${etape.stepId}`) === null ? null : <Refus key={etape.stepId} texte={messageDe(`e:${etape.stepId}`) ?? ""} />,
              )}
            </li>
            {rang === modele.lignes.length - 1 ? place(ligne.index + 1) : null}
          </Fragment>
        ))}
      </ol>

      <details className="sc-json">
        <summary className="btn sm">{modele.json.voir}</summary>
        <div className="stack tight">
          <p className="secondary small">{modele.json.lectureSeule}</p>
          <textarea className="sc-json-texte" readOnly value={modele.json.texte} rows={12} spellCheck={false} aria-label={modele.json.voir} />
        </div>
      </details>

      <FlowList liste={liste} libelle={libelle} />
    </div>
  );
}

/** Refus écrit PRÈS DE LA CIBLE : une icône ET la phrase, jamais la couleur seule (§5.5). */
function Refus({ texte }: { texte: string }) {
  return (
    <p className="sc-refus">
      <Icon name="alert" size={14} />
      <span>{texte}</span>
    </p>
  );
}

/** Menu déroulant natif : il s'ouvre au clavier comme à la souris, sans aucune bibliothèque (P8). */
function Menu({ libelle, children }: { libelle: string; children: ReactNode }) {
  return (
    <details className="sc-menu">
      <summary className="btn sm">{libelle}</summary>
      <div className="row wrap sc-menu-corps">{children}</div>
    </details>
  );
}

/** Nombre de tours ou de spécialistes à consulter : les valeurs de FLOW_LIMITS, rendues par le modèle. */
function Nombre({ modele, onChoisir }: { modele: { libelle: string; valeur: number; choix: readonly number[] }; onChoisir: (valeur: 1 | 2) => void }) {
  return (
    <div className="row sc-nombre" role="group" aria-label={modele.libelle}>
      <span className="secondary small">{modele.libelle}</span>
      {modele.choix.map((valeur) => (
        <button
          key={valeur}
          type="button"
          className={`btn sm${valeur === modele.valeur ? " primary" : ""}`}
          aria-pressed={valeur === modele.valeur}
          onClick={() => onChoisir(valeur === 2 ? 2 : 1)}
        >
          {valeur}
        </button>
      ))}
    </div>
  );
}
