// Propriétaire : L47b.
// Chronologie d'une conversation (itération 5, plan d'exécution it5 fiche L47b, D-5-09 ; spécification §2.1 l.63, §5.1
// l.883-884, §5.5 l.920, §5.6) : le déroulé détaillé, appel d'IA par appel d'IA, avec les jetons et le coût de chacun.
// MODE AVANCÉ SEULEMENT : « jeton » est interdit en mode Simple (§2.3), et tous les textes viennent de la section `avance` de
// construction-texts.ts. C'est le Déroulé (Deroule.tsx, section `c5:chronologie`) qui n'offre la bascule qu'en Avancé ; le
// serveur, lui, ne masque rien (routes-chronologie.ts).
// Un seul modèle (P12) : l'état du Déroulé (useConversationActivity, faits de l'itération 1) et les lignes `usage` de la route
// dédiée, réunis par le module PUR server/shared/chronologie.ts (L47a). Aucun calcul de vue n'est refait ici.
// Les lignes `usage` sont relues sur `usage.updated` de cette conversation, AU PLUS UNE FOIS PAR SECONDE.
// Accessibilité : le `<table>` porte toute l'information (légende, colonnes du §4.3) ; les barres sont une grille CSS décorative
// (`aria-hidden`), les repères d'outils, de tentatives et de décisions sont des boutons qui montrent leur mot au focus, et le
// curseur « maintenant » est un trait STATIQUE replacé à chaque rendu — aucune animation, aucune minuterie de mouvement
// (web-animations.test.ts). Sous 400 px, la figure disparaît : le tableau seul reste (§5.6). Textes venus d'opencode (assistant,
// titre) : échappés par React.
import { useEffect, useId, useRef, useState } from "react";
import { type ActivityState, liveRows } from "../../../../server/shared/activity.ts";
import { libelleDecision } from "../../../../server/shared/autonomy-texts.ts";
import { chronologie } from "../../../../server/shared/chronologie.ts";
import { TEXTES } from "../../../../server/shared/construction-texts.ts";
import type { ChronologieRow, ChronologieTick, ChronologieUsageRow, ChronologieView } from "../../../../server/shared/construction-types.ts";
import type { NeonToolCategory } from "../../../../server/shared/neon-scene.ts";
import { libelleOutil, remplir } from "../../../../server/shared/neon-texts.ts";
import { Icon, type IconName } from "../../../components/Icon.tsx";
import { getChronologie } from "../../../lib/api-construction.ts";
import { errorText } from "../../../lib/api.ts";
import { cockpitEvent, eventBus } from "../../../lib/events.ts";
import { formatDuration, formatTime, formatTokens, formatUsd } from "../../../lib/format.ts";
import type { BrowserEvent } from "../../../lib/types.ts";
import { builtinTitle } from "../turn.ts";
import "./chronologie.css";

const T = TEXTES.avance.chronologie;

/** Lignes `usage` relues au plus une fois par seconde (fiche L47b) : une rafale d'`usage.updated` ne fait qu'une lecture. */
export const RECHARGE_MIN_MS = 1_000;

/** Colonnes de la grille CSS des barres : assez fine pour un appel court, assez courte pour rester lisible dans le style. */
const GRILLE = 500;

/** Repères : une icône par genre, le mot venant des textes de l'itération 1 (jamais une couleur seule). */
const TICK_ICONS: Readonly<Record<ChronologieTick["genre"], IconName>> = {
  outil: "wrench",
  tentative: "refresh",
  decision: "shield",
  attente: "hourglass",
};

/** Catégories d'outil nommées par `neon-texts` ; `toolCategory` rend « autre » pour tout le reste. */
const OUTILS: ReadonlySet<string> = new Set<NeonToolCategory>(["lire", "chercher", "modifier", "commande", "confier", "question"]);

/** Verdicts nommés par `autonomy-texts` ; « refus-interdit » n'existe que dans la Salle OMO, absente de la construction. */
const VERDICTS: ReadonlySet<string> = new Set(["auto", "attente", "refus-auto", "non-controle"]);

/** Mot d'un repère, lu au focus et par le lecteur d'écran. */
function tickMot(tick: ChronologieTick): string {
  if (tick.genre === "outil") return libelleOutil(OUTILS.has(tick.code) ? (tick.code as NeonToolCategory) : "autres");
  if (tick.genre === "tentative") return `nouvelle tentative (${tick.code})`;
  if (tick.genre === "attente") return "attente de vous";
  return VERDICTS.has(tick.code) ? libelleDecision(tick.code as "auto" | "attente" | "refus-auto" | "non-controle") : "décision du contrôle";
}

/** Nom de l'acteur d'une ligne : même vocabulaire que le Déroulé (§2.3), l'assistant étant nommé quand il est connu. */
function quiOf(row: ChronologieRow, agent: string | null): string {
  const nom = agent ? (builtinTitle(agent) ?? agent) : null;
  if (row.depth === 0) return nom ? `Conversation · ${nom}` : "Conversation";
  if (row.role === "controle") return "Contrôle de sécurité";
  if (row.role === "etape") return nom ? `Étape · ${nom}` : "Étape";
  return nom ?? "Travail délégué";
}

/**
 * Assistant de chaque ligne, par clé de ligne : `liveRows(state, 0)` rend les mêmes clés et le même ordre que `timeline`, sur
 * lequel la vue de L47a est bâtie. La vue, elle, ne rend que des codes et des nombres — jamais un nom déjà mis en forme.
 */
function agentsOf(state: ActivityState): Map<string, string | null> {
  return new Map(liveRows(state, 0).map((row) => [row.key, row.agent]));
}

/** IA d'un appel : son nom, suivi de sa variante quand elle est enregistrée ; « — » quand aucune ligne `usage` ne le dit. */
function iaOf(call: ChronologieRow["calls"][number]): string {
  if (call.model === null) return "—";
  return call.variant === null ? call.model : `${call.model} · ${call.variant}`;
}

// --- Lignes visibles (groupes « ×n » dépliables) ---------------------------------------------------------------------------------

/** Bloc affiché : une ligne seule, ou un groupe de délégations du même assistant, replié tant qu'on ne l'a pas déplié. */
type Bloc = { kind: "ligne"; row: ChronologieRow } | { kind: "groupe"; key: string; agent: string; count: number; rows: ChronologieRow[] };

/**
 * Blocs dans l'ordre des lignes : un groupe prend la place de sa PREMIÈRE ligne, les suivantes disparaissent tant qu'il est
 * replié. Déplié, ses lignes reviennent à leur place, le repli n'ayant jamais changé l'ordre du Déroulé.
 */
function blocsOf(vue: ChronologieView, deplies: ReadonlySet<string>): Bloc[] {
  const groupes = new Map(vue.groupes.map((groupe) => [groupe.key, groupe]));
  const vus = new Set<string>();
  const blocs: Bloc[] = [];
  for (const row of vue.rows) {
    const groupe = row.groupe === null ? undefined : groupes.get(row.groupe);
    if (groupe === undefined) {
      blocs.push({ kind: "ligne", row });
      continue;
    }
    if (deplies.has(groupe.key)) {
      blocs.push({ kind: "ligne", row });
      continue;
    }
    if (vus.has(groupe.key)) continue;
    vus.add(groupe.key);
    const rows = vue.rows.filter((autre) => autre.groupe === groupe.key);
    blocs.push({ kind: "groupe", key: groupe.key, agent: groupe.agent, count: groupe.count, rows });
  }
  return blocs;
}

// --- Échelle du temps ------------------------------------------------------------------------------------------------------------

/** Échelle de la figure : une position en pour cent et une colonne de grille pour chaque instant de la vue. */
interface Echelle {
  pct(at: number): number;
  colonne(at: number): number;
}

function echelleOf(vue: ChronologieView): Echelle {
  const debut = vue.start ?? 0;
  const span = Math.max(1, (vue.end ?? debut) - debut);
  const pct = (at: number) => Math.min(100, Math.max(0, ((at - debut) / span) * 100));
  return { pct, colonne: (at) => Math.min(GRILLE + 1, Math.max(1, 1 + Math.round((pct(at) / 100) * GRILLE))) };
}

// --- Bascule « Déroulé | Chronologie » --------------------------------------------------------------------------------------------

export type VueDeroule = "deroule" | "chronologie";

const VUES: readonly VueDeroule[] = ["deroule", "chronologie"];

/**
 * Bascule du Déroulé (APG « Radio Group ») : `role="radiogroup"`, un seul bouton dans l'ordre de tabulation (roving tabindex),
 * flèches et Origine/Fin pour passer d'une vue à l'autre. Rendue par Deroule.tsx en mode Avancé SEULEMENT.
 */
export function BasculeChronologie({ value, onChange, label }: { value: VueDeroule; onChange: (value: VueDeroule) => void; label: string }) {
  const refs = useRef<Array<HTMLButtonElement | null>>([]);
  const aller = (index: number) => {
    const cible = VUES[(index + VUES.length) % VUES.length] as VueDeroule;
    onChange(cible);
    refs.current[VUES.indexOf(cible)]?.focus();
  };
  return (
    <div className="chrono-bascule" role="radiogroup" aria-label={label}>
      {VUES.map((vue, index) => (
        <button
          key={vue}
          ref={(el) => {
            refs.current[index] = el;
          }}
          type="button"
          role="radio"
          aria-checked={vue === value}
          tabIndex={vue === value ? 0 : -1}
          className={vue === value ? "chrono-bascule-btn selected" : "chrono-bascule-btn"}
          onClick={() => onChange(vue)}
          onKeyDown={(e) => {
            if (e.key === "ArrowRight" || e.key === "ArrowDown") aller(index + 1);
            else if (e.key === "ArrowLeft" || e.key === "ArrowUp") aller(index - 1);
            else if (e.key === "Home") aller(0);
            else if (e.key === "End") aller(VUES.length - 1);
            else return;
            e.preventDefault();
          }}
        >
          {vue === "deroule" ? T.deroule : T.titre}
        </button>
      ))}
    </div>
  );
}

// --- Lecture des lignes `usage` ----------------------------------------------------------------------------------------------------

interface Lignes {
  rows: ChronologieUsageRow[];
  tronque: boolean;
  erreur: string | null;
}

const VIDE: Lignes = Object.freeze({ rows: [], tronque: false, erreur: null });

/** Lignes `usage` de la conversation, relues sur `usage.updated` au plus une fois par seconde (une rafale = une lecture). */
function useLignes(rootId: string): Lignes {
  const [lignes, setLignes] = useState<Lignes>(VIDE);
  useEffect(() => {
    setLignes(VIDE);
    let vivant = true;
    const arret = new AbortController();
    let minuteur: ReturnType<typeof setTimeout> | undefined;
    let dernier = 0;
    const charger = async () => {
      dernier = Date.now();
      try {
        const reponse = await getChronologie(rootId, arret.signal);
        if (vivant) setLignes({ rows: reponse.rows, tronque: reponse.tronque, erreur: null });
      } catch (err) {
        if (vivant && !arret.signal.aborted) setLignes((avant) => ({ ...avant, erreur: errorText(err) }));
      }
    };
    const planifier = () => {
      if (minuteur !== undefined) return;
      minuteur = setTimeout(
        () => {
          minuteur = undefined;
          void charger();
        },
        Math.max(0, dernier + RECHARGE_MIN_MS - Date.now()),
      );
    };
    void charger();
    const stop = eventBus.subscribe((brut: BrowserEvent) => {
      const event = cockpitEvent(brut, "usage.updated", "stream.reconnected");
      if (event === null) return;
      // Un `usage.updated` sans racine vient d'un rattrapage : il peut concerner cette conversation.
      const racine = (event.data as { rootId?: string } | null)?.rootId;
      if (racine !== undefined && racine !== rootId) return;
      planifier();
    });
    return () => {
      vivant = false;
      stop();
      arret.abort();
      if (minuteur !== undefined) clearTimeout(minuteur);
    };
  }, [rootId]);
  return lignes;
}

// --- Figure : barres, repères et curseur ------------------------------------------------------------------------------------------

/** Une ligne de la figure : fond de la ligne, une barre par appel d'IA (grille CSS, décorative) et ses repères focusables. */
function Piste({ row, vue, echelle }: { row: ChronologieRow; vue: ChronologieView; echelle: Echelle }) {
  // Fin manquante (appel ou ligne encore en cours) : la barre court jusqu'au bord de la vue, jamais au-delà.
  const fin = (at: number | null) => at ?? vue.end ?? 0;
  /** Colonnes d'une barre : au moins une, pour qu'un appel très court reste visible. */
  const colonnes = (debut: number, at: number | null) => `${echelle.colonne(debut)} / ${Math.max(echelle.colonne(debut) + 1, echelle.colonne(fin(at)))}`;
  return (
    <div className="chrono-track">
      <div className="chrono-bars" aria-hidden="true" style={{ gridTemplateColumns: `repeat(${GRILLE}, 1fr)` }}>
        {row.start === null ? null : <span className="chrono-span" style={{ gridColumn: colonnes(row.start, row.end) }} />}
        {row.calls.map((call) => (
          <span
            key={call.messageId}
            className={call.end === null ? "chrono-bar chrono-bar--encours" : "chrono-bar"}
            style={{ gridColumn: colonnes(call.start, call.end) }}
          />
        ))}
      </div>
      <ul className="chrono-marks">
        {row.ticks.map((tick, index) => (
          <li key={`${tick.genre}-${tick.at}-${index}`} className="chrono-mark" style={{ left: `${echelle.pct(tick.at)}%` }}>
            <button type="button" className={`chrono-tick chrono-tick--${tick.genre}`}>
              <Icon name={TICK_ICONS[tick.genre]} size={11} />
              <span className="chrono-mot">{tickMot(tick)}</span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

// --- Tableau ------------------------------------------------------------------------------------------------------------------------

/** Jetons d'un appel : « entrée / sortie / cache », ou la phrase d'absence quand rien n'a été enregistré pour cet appel. */
function Jetons({ call }: { call: ChronologieRow["calls"][number] }) {
  if (call.tokensIn === null && call.tokensOut === null && call.tokensCache === null) return <span className="muted">{T.jetonsAbsents}</span>;
  return (
    <span className="nowrap">
      {`${formatTokens(call.tokensIn)} / ${formatTokens(call.tokensOut)} / ${formatTokens(call.tokensCache)}`}
    </span>
  );
}

/** Rangées d'une ligne : une par appel d'IA ; « Qui », « Outils » et « Tentatives » couvrent toutes les rangées de la ligne. */
function RangeesLigne({ row, qui }: { row: ChronologieRow; qui: string }) {
  const outils = row.ticks.filter((tick) => tick.genre === "outil").length;
  const tentatives = row.ticks.filter((tick) => tick.genre === "tentative").length;
  const nombre = Math.max(1, row.calls.length);
  const marge = { paddingLeft: `${4 + row.depth * 10}px` };
  const entete = (
    <th scope={nombre > 1 ? "rowgroup" : "row"} rowSpan={nombre} className="chrono-cell-qui" style={marge}>
      {qui}
    </th>
  );
  if (row.calls.length === 0) {
    return (
      <tr>
        {entete}
        <td>—</td>
        <td className="nowrap">{row.start === null ? "—" : formatTime(row.start)}</td>
        <td className="num nowrap">—</td>
        <td>—</td>
        <td className="num nowrap">—</td>
        <td className="num nowrap">—</td>
        <td className="num">{outils}</td>
        <td className="num">{tentatives}</td>
        <td className="num nowrap">—</td>
      </tr>
    );
  }
  return (
    <>
      {row.calls.map((call, index) => (
        <tr key={call.messageId}>
          {index === 0 ? entete : null}
          <td className="num">{index + 1}</td>
          <td className="nowrap">{formatTime(call.start)}</td>
          <td className="num nowrap">{call.end === null ? "—" : formatDuration(call.end - call.start)}</td>
          <td className="chrono-cell-ia">{iaOf(call)}</td>
          <td className="num nowrap">{call.tokensReasoning === null ? "—" : formatTokens(call.tokensReasoning)}</td>
          <td className="num nowrap">
            <Jetons call={call} />
          </td>
          {index === 0 ? (
            <>
              <td className="num" rowSpan={nombre}>
                {outils}
              </td>
              <td className="num" rowSpan={nombre}>
                {tentatives}
              </td>
            </>
          ) : null}
          <td className="num nowrap">{call.cost === null ? "—" : formatUsd(call.cost)}</td>
        </tr>
      ))}
    </>
  );
}

// --- Vue ----------------------------------------------------------------------------------------------------------------------------

export interface ChronologieProps {
  /** Conversation affichée (racine). */
  rootId: string;
  /** État du Déroulé déjà lu (useConversationActivity) : un seul modèle pour les deux vues. */
  state: ActivityState;
  /** « Déroulé partiel » du magasin : une partie du travail délégué n'est pas montrée. */
  partial?: boolean | undefined;
}

/** Phrase du Déroulé partiel (§5.1), la même que celle du Déroulé : une partie du travail délégué manque. */
const PARTIEL = "Déroulé partiel : une partie du travail délégué n'est pas montrée.";

export function Chronologie({ rootId, state, partial = false }: ChronologieProps) {
  const lignes = useLignes(rootId);
  const [deplies, setDeplies] = useState<ReadonlySet<string>>(() => new Set<string>());
  const legendeId = useId();
  // Curseur « maintenant » : l'instant du RENDU, jamais une minuterie. Il se replace quand la vue est redessinée (fait reçu,
  // lignes relues), et reste immobile le reste du temps — aucune animation (web-animations.test.ts).
  const vue = chronologie(state, lignes.rows, Date.now());
  const echelle = echelleOf(vue);
  const agents = agentsOf(state);
  const blocs = blocsOf(vue, deplies);
  const appels = vue.rows.reduce((total, row) => total + row.calls.length, 0);
  // `tronque` : la base avait plus de CHRONO_MAX_ROWS lignes `usage` ; des appels manquent donc, comme lorsqu'une partie du
  // travail délégué n'a pas été enregistrée. Le dire avec la phrase du Déroulé vaut mieux que de laisser croire au compte exact.
  const partiel = partial || vue.partiel || lignes.tronque;

  const deplier = (key: string) =>
    setDeplies((avant) => {
      const apres = new Set(avant);
      apres.add(key);
      return apres;
    });

  return (
    <div className="chronologie stack tight">
      <p className="tiny muted chrono-note">{T.phrase}</p>
      {lignes.erreur ? <div className="callout critical small">{lignes.erreur}</div> : null}
      {partiel ? <p className="tiny muted chrono-note">{PARTIEL}</p> : null}

      {appels === 0 ? (
        <p className="small muted">{T.vide}</p>
      ) : (
        <>
          <figure className="chrono-figure" aria-labelledby={legendeId}>
            <figcaption id={legendeId} className="visually-hidden">
              {T.phrase}
            </figcaption>
            {vue.curseur === null ? null : (
              <div className="chrono-axe" aria-hidden="true">
                <span className="chrono-now" style={{ left: `${echelle.pct(vue.curseur)}%` }}>
                  <span className="chrono-now-mot">{T.maintenant}</span>
                </span>
              </div>
            )}
            <ol className="chrono-rows">
              {blocs.map((bloc) =>
                bloc.kind === "groupe" ? (
                  <li key={bloc.key} className="chrono-row chrono-row--groupe">
                    <div className="chrono-who">
                      <span className="chrono-name ellipsis">{remplir(T.groupe, { agent: builtinTitle(bloc.agent) ?? bloc.agent, n: bloc.count })}</span>
                      <button type="button" className="chrono-deplier" onClick={() => deplier(bloc.key)}>
                        {remplir(T.voirAppels, { n: bloc.count })}
                      </button>
                    </div>
                  </li>
                ) : (
                  <li key={bloc.row.key} className="chrono-row" style={{ paddingLeft: `${bloc.row.depth * 12}px` }}>
                    <div className="chrono-who">
                      <span className="chrono-name ellipsis">{quiOf(bloc.row, agents.get(bloc.row.key) ?? null)}</span>
                    </div>
                    <Piste row={bloc.row} vue={vue} echelle={echelle} />
                  </li>
                ),
              )}
            </ol>
          </figure>

          <div className="table-wrap">
            <table className="table chrono-table">
              <caption className="visually-hidden">{T.titre}</caption>
              <thead>
                <tr>
                  <th scope="col">{T.colonnes.qui}</th>
                  <th scope="col" className="num">
                    {T.colonnes.appel}
                  </th>
                  <th scope="col">{T.colonnes.debut}</th>
                  <th scope="col" className="num">
                    {T.colonnes.duree}
                  </th>
                  <th scope="col">{T.colonnes.ia}</th>
                  <th scope="col" className="num">
                    {T.colonnes.reflexion}
                  </th>
                  <th scope="col" className="num">
                    {T.colonnes.jetons}
                  </th>
                  <th scope="col" className="num">
                    {T.colonnes.outils}
                  </th>
                  <th scope="col" className="num">
                    {T.colonnes.tentatives}
                  </th>
                  <th scope="col" className="num">
                    {T.colonnes.cout}
                  </th>
                </tr>
              </thead>
              <tbody>
                {blocs.map((bloc) =>
                  bloc.kind === "groupe" ? (
                    <tr key={bloc.key}>
                      <th scope="row" className="chrono-cell-qui">
                        {remplir(T.groupe, { agent: builtinTitle(bloc.agent) ?? bloc.agent, n: bloc.count })}
                      </th>
                      <td colSpan={9}>
                        <button type="button" className="chrono-deplier" onClick={() => deplier(bloc.key)}>
                          {remplir(T.voirAppels, { n: bloc.count })}
                        </button>
                      </td>
                    </tr>
                  ) : (
                    <RangeesLigne key={bloc.row.key} row={bloc.row} qui={quiOf(bloc.row, agents.get(bloc.row.key) ?? null)} />
                  ),
                )}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
}
