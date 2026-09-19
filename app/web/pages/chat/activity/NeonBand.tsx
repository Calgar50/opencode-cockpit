// Propriétaire : L5c.
// Carte des agents en direct : bande néon 2D du chat (spécification §5.7.4, §5.5, §5.6, JP-13, P12 ; plan d'exécution, fiche
// L5c), rendue par ActivityRegion au-dessus de la liste des acteurs, qui reste la vérité.
// - Dessin : scene() de neon-scene.ts (L5a) sur les faits AFFICHÉS, en SVG 560 × 220 aria-hidden. Un vrai bouton par assistant
//   ouvre le zoom 3 : anneau d'outils, tuiles de fichiers et panneau « Consigne reçue · Ce qu'il a fait · Résultat rendu », dont
//   les textes sont relus dans la conversation par neon-band.ts (redactSecrets, puis coupe) et rendus en texte, donc échappés,
//   jamais en HTML. [Tableau] montre la même scène en tableau.
// - Mouvement (JP-13) : WAAPI sur transform et opacity, une transition d'environ 900 ms par changement, seulement sous
//   prefers-reduced-motion: no-preference ; halo statique ; AUCUNE boucle (web-animations.test.ts). La file (neon-band.ts) rend au
//   plus 4 fois par seconde avec un minuteur ponctuel, relancé seulement tant que des changements attendent ou qu'une annonce
//   est à retirer ; au-delà de 2 s d'attente, elle est vidée d'un coup : « Affichage rattrapé », annoncé 2 s et enregistré par
//   POST …/facts/affichage (décision du 15/09, n° 3). « Figer l'affichage » garde l'image ; le travail continue.
// - Modes : repliée par défaut en Simple, avec un résumé d'une ligne ; dépliée en Avancé ; une autre conversation ou un autre
//   mode revient à ce défaut. Sous 900 px, mini-carte de 3 lignes ; à 400 px, liste seule (neon.css). Néon clair en thème clair
//   (jetons de styles.css) ; couleurs forcées dans neon.css.
// Composant interne : ses propriétés restent libres pour son propriétaire. NeonCarte et NeonTableau sont réutilisables (L5d).
import { type KeyboardEvent, type RefObject, useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import {
  angle,
  avancer,
  cheminDeLOutil,
  couper,
  deplieeParDefaut,
  dossierDe,
  figer,
  fileNeuve,
  grille,
  hexagone,
  imagesCles,
  libelleNoeud,
  lignesTableau,
  NEON_ANNEAU,
  NEON_CENTRE,
  NEON_NOM_MAX,
  NEON_RELECTURE_MS,
  NEON_TRANSITION_MS,
  type NeonFile,
  type NeonTransition,
  nomAssistant,
  nomDeFichier,
  pointSur,
  recevoir,
  resumeBande,
  segment,
  texteDuMessage,
  versLExterieur,
} from "../../../../server/shared/neon-band.ts";
import {
  NEON_ANNEAUX_DESSINES,
  NEON_CADRE,
  NEON_TAILLES,
  type NeonBeam,
  type NeonDecision,
  type NeonDetail,
  type NeonMode,
  type NeonNode,
  type NeonOriginMark,
  type NeonPoint,
  type NeonPulse,
  type NeonScene,
  type NeonStation,
  type NeonTile,
  type NeonWait,
  scene,
} from "../../../../server/shared/neon-scene.ts";
import { carnetVide, libelleEtat, libelleOutil, libelleSecteur, libelleStation, remplir, TEXTES, titreBande } from "../../../../server/shared/neon-texts.ts";
import { activityApi } from "../../../lib/api-activity.ts";
import { oc } from "../../../lib/api.ts";
import type { ActivityFact } from "../../../lib/types.ts";
import "./neon.css";

export interface NeonBandProps {
  rootId: string;
  facts: ActivityFact[];
  advanced: boolean;
  /** Dossier de la conversation : relecture des textes du zoom 3 par le proxy (facultatif, comme pour oc.messages). */
  directory?: string | undefined;
  /** [Voir une démonstration] (L5d) : absent, le bouton n'est pas affiché. */
  onDemonstration?: (() => void) | undefined;
}

const L = NEON_CADRE.largeur;
const H = NEON_CADRE.hauteur;
const GRILLE = grille(L, H);
const HEURE = new Intl.DateTimeFormat("fr-FR", { timeStyle: "medium" });
const TOUCHES = TEXTES.partout.commandes;

/** Focus à rendre après un changement de vue demandé par l'utilisateur (jamais volé autrement). */
type FocusApres = { vers: "retour" } | { vers: "noeud"; sessionId: string };

export function NeonBand({ rootId, facts, advanced, directory, onDemonstration }: NeonBandProps) {
  const mode: NeonMode = advanced ? "avance" : "simple";
  const titreId = useId();
  const corpsId = useId();
  const [deplie, setDeplie] = useState(() => deplieeParDefaut(mode));
  const [tableau, setTableau] = useState(false);
  const [fige, setFige] = useState(false);
  const [focus, setFocus] = useState<string | null>(null);
  // Autre mode ou autre conversation : repliée ou dépliée selon le mode, retour à la carte, affichage en direct.
  const contexte = `${mode}|${rootId}`;
  const [contexteVu, setContexteVu] = useState(contexte);
  if (contexteVu !== contexte) {
    setContexteVu(contexte);
    setDeplie(deplieeParDefaut(mode));
    setFocus(null);
    setFige(false);
  }
  const retourRef = useRef<HTMLButtonElement>(null);
  const noeudsRef = useRef<HTMLUListElement>(null);
  const focusApres = useRef<FocusApres | null>(null);

  const { affiches, rattrape } = useAffichage(rootId, facts, deplie, fige);
  const zoom = focus === null ? 2 : 3;
  const vue = useMemo(() => scene(affiches, null, { zoom, mode, focus }), [affiches, zoom, mode, focus]);
  const ligne = useMemo(() => resumeBande(vue), [vue]);

  useEffect(() => {
    const cible = focusApres.current;
    if (cible === null) return;
    focusApres.current = null;
    if (cible.vers === "retour") retourRef.current?.focus();
    else noeudsRef.current?.querySelector<HTMLButtonElement>(`[data-neon-session="${CSS.escape(cible.sessionId)}"]`)?.focus();
  });

  const ouvrir = useCallback((sessionId: string) => {
    focusApres.current = { vers: "retour" };
    setFocus(sessionId);
  }, []);
  const quitteDetail = vue.detail?.sessionId ?? null;
  const fermer = useCallback(() => {
    if (quitteDetail !== null) focusApres.current = { vers: "noeud", sessionId: quitteDetail };
    setFocus(null);
  }, [quitteDetail]);

  // Aucun fait ne dessine encore l'assistant de la conversation : rien à montrer (P12).
  if (ligne === null) return null;

  const onKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (event.key !== "Escape" || focus === null) return;
    event.stopPropagation();
    fermer();
  };
  const basculerRepli = () => {
    setDeplie((v) => !v);
    setFige(false);
    setFocus(null);
  };
  let contenu = <NeonTableau vue={vue} />;
  if (!tableau && vue.detail === null) contenu = <NeonCarte vue={vue} onOuvrir={ouvrir} noeudsRef={noeudsRef} />;
  else if (!tableau && vue.detail !== null) contenu = <NeonZoom3 vue={vue} detail={vue.detail} directory={directory} retourRef={retourRef} onRetour={fermer} />;

  return (
    <section className="neon-band" aria-labelledby={titreId} onKeyDown={onKeyDown}>
      <div className="neon-head">
        <h2 className="neon-title" id={titreId}>
          {titreBande(mode)}
        </h2>
        {/* Résumé d'une ligne : bande repliée ; dépliée, seulement à 400 px, où la carte laisse la place à la liste (neon.css). */}
        <p className={deplie ? "neon-summary is-deplie" : "neon-summary"}>{ligne}</p>
        {deplie && rattrape ? <span className="neon-rattrape">{TEXTES.partout.rattrape}</span> : null}
        <div className="neon-commands">
          {deplie ? (
            <>
              <button type="button" className="btn sm ghost" onClick={() => setFige((v) => !v)}>
                {fige ? TOUCHES.reprendre : TOUCHES.figer}
              </button>
              <button type="button" className="btn sm ghost" aria-pressed={tableau} onClick={() => setTableau((v) => !v)}>
                {TOUCHES.tableau}
              </button>
              {advanced && onDemonstration ? (
                <button type="button" className="btn sm ghost" onClick={onDemonstration}>
                  {TOUCHES.demonstration}
                </button>
              ) : null}
            </>
          ) : null}
          <button type="button" className="btn sm" aria-expanded={deplie} aria-controls={deplie ? corpsId : undefined} onClick={basculerRepli}>
            {deplie ? TOUCHES.replier : TOUCHES.afficher}
          </button>
        </div>
      </div>
      {deplie ? (
        <div className="neon-body" id={corpsId}>
          {contenu}
          {mode === "simple" ? (
            <div className="neon-note">
              <p>{vue.delegationsMasquees > 0 ? TEXTES.simple.travailConfieHorsCarte : TEXTES.simple.resume}</p>
              {onDemonstration ? (
                <button type="button" className="btn sm" onClick={onDemonstration}>
                  {TEXTES.simple.demonstration}
                </button>
              ) : null}
            </div>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}

// --- File d'affichage -----------------------------------------------------------------------------------------------------------

const prefixe = (liste: readonly ActivityFact[], n: number) => (n >= liste.length ? liste : liste.slice(0, n));

/**
 * Enregistre « Affichage rattrapé » (fait `affichage`, sans texte). Enregistrement au mieux : le serveur n'en garde qu'un par 2 s
 * et plus aucun après « Déroulé partiel » ; un échec (réseau, 4xx) ne change rien à l'écran, qui montre déjà le libellé, et ne
 * demande rien à l'utilisateur. L'erreur est donc écartée ici, exprès.
 */
function enregistrerRattrapage(rootId: string): void {
  activityApi.affichage(rootId).catch(() => undefined);
}

/**
 * Faits affichés par la bande : la file de neon-band.ts quand la bande est dépliée (au plus 4 rendus par seconde, rattrapage
 * après 2 s, figée sur demande) ; tous les faits, sans file, quand elle est repliée (résumé d'une ligne) ou quand la
 * conversation change (liste lue d'un coup).
 */
function useAffichage(rootId: string, facts: readonly ActivityFact[], actif: boolean, fige: boolean) {
  const [affiches, setAffiches] = useState<readonly ActivityFact[]>(facts);
  const [rattrape, setRattrape] = useState(false);
  const file = useRef<NeonFile>(fileNeuve(facts.length));
  const liste = useRef(facts);
  const racine = useRef(rootId);
  const minuteur = useRef<number | null>(null);

  const arreter = useCallback(() => {
    if (minuteur.current === null) return;
    window.clearTimeout(minuteur.current);
    minuteur.current = null;
  }, []);

  // Un pas de la file ; relance un minuteur ponctuel seulement si un changement attend encore ou si l'annonce d'un rattrapage
  // est à retirer (aucune boucle d'animation).
  const pas = useCallback(() => {
    minuteur.current = null;
    const maintenant = Date.now();
    const avant = file.current;
    const { file: apres, rattrape: vide, prochain } = avancer(avant, maintenant);
    file.current = apres;
    if (apres.affiches !== avant.affiches) setAffiches(prefixe(liste.current, apres.affiches));
    setRattrape(apres.rattrapage !== null);
    if (vide) enregistrerRattrapage(rootId);
    if (prochain !== null) minuteur.current = window.setTimeout(pas, Math.max(0, prochain - maintenant));
  }, [rootId]);

  useEffect(() => {
    liste.current = facts;
    if (!actif || racine.current !== rootId) {
      racine.current = rootId;
      arreter();
      file.current = fileNeuve(facts.length);
      setAffiches(facts);
      setRattrape(false);
      return;
    }
    const avant = file.current;
    const apres = recevoir(avant, facts.length, Date.now());
    file.current = apres;
    // Liste raccourcie (relecture), ou remplacée à longueur égale sans rien en attente : affichée telle quelle.
    const remplacee = apres === avant && !apres.fige && apres.attente.length === 0;
    if (apres.affiches !== avant.affiches || remplacee) setAffiches(prefixe(facts, apres.affiches));
    // Pas replanifié à chaque réception : le minuteur en cours peut viser la fin d'une annonce, plus lointaine que le prochain rendu.
    arreter();
    pas();
  }, [rootId, facts, actif, arreter, pas]);

  useEffect(() => {
    const avant = file.current;
    const apres = figer(avant, fige, Date.now());
    if (apres === avant) return;
    file.current = apres;
    arreter();
    setRattrape(false);
    if (!fige) setAffiches(prefixe(liste.current, apres.affiches));
  }, [fige, arreter]);

  useEffect(() => arreter, [arreter]);

  return { affiches, rattrape };
}

// --- Transitions (JP-13) ----------------------------------------------------------------------------------------------------------

function mouvementPermis(): boolean {
  return typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: no-preference)").matches;
}

const TRANSITIONS_DECLAREES: ReadonlySet<string> = new Set<NeonTransition>(["apparition", "trait", "trajet"]);

/** Signe déjà dessiné : « changement » ; nouveau : sa transition déclarée, « apparition » par défaut. */
function transitionDe(ancien: string | undefined, declaree: string): NeonTransition {
  if (ancien !== undefined) return "changement";
  return TRANSITIONS_DECLAREES.has(declaree) ? (declaree as NeonTransition) : "apparition";
}

/**
 * Une transition WAAPI d'environ 900 ms (transform, opacity) pour chaque signe apparu ou changé depuis le rendu précédent, une
 * seule fois ; rien au premier rendu ni sous mouvement réduit. Chaque signe porte data-neon-cle (identité), data-neon-etat
 * (ce qui change), data-neon-anim (transition d'apparition) et, pour un trajet, data-neon-dx et data-neon-dy.
 */
function useTransitions(svgRef: RefObject<SVGSVGElement | null>, vue: NeonScene): void {
  const precedent = useRef<Map<string, string> | null>(null);
  useLayoutEffect(() => {
    const svg = svgRef.current;
    if (svg === null) return;
    const avant = precedent.current;
    const actuel = new Map<string, string>();
    const bouger = avant !== null && typeof svg.animate === "function" && mouvementPermis();
    for (const signe of svg.querySelectorAll<SVGGElement>("[data-neon-cle]")) {
      const cle = signe.dataset.neonCle ?? "";
      const etat = signe.dataset.neonEtat ?? "";
      actuel.set(cle, etat);
      if (!bouger || avant === null) continue;
      const ancien = avant.get(cle);
      if (ancien === etat) continue;
      const transition = transitionDe(ancien, signe.dataset.neonAnim ?? "");
      const dx = Number(signe.dataset.neonDx ?? 0) || 0;
      const dy = Number(signe.dataset.neonDy ?? 0) || 0;
      signe.animate(imagesCles(transition, dx, dy), { duration: NEON_TRANSITION_MS, easing: "cubic-bezier(0.2, 0, 0, 1)", iterations: 1 });
    }
    precedent.current = actuel;
  }, [svgRef, vue]);
}

// --- Carte (zoom 2) ---------------------------------------------------------------------------------------------------------------

const pourcent = (v: number, total: number) => `${Math.round((v / total) * 10000) / 100}%`;

/** Carte d'une scène au zoom 2 ; `onOuvrir` absent (démonstration), aucun bouton d'assistant. */
export function NeonCarte({ vue, onOuvrir, noeudsRef }: { vue: NeonScene; onOuvrir?: (sessionId: string) => void; noeudsRef?: RefObject<HTMLUListElement | null> }) {
  const svgRef = useRef<SVGSVGElement>(null);
  useTransitions(svgRef, vue);
  const rayons = useMemo(() => new Map(vue.noeuds.map((n) => [n.sessionId, rayonNoeud(n)])), [vue]);
  const rayon = (id: string) => (id === "vous" ? NEON_TAILLES.station : (rayons.get(id) ?? NEON_TAILLES.assistant));
  return (
    <div className="neon-map-wrap">
      <svg ref={svgRef} className="neon-map" viewBox={`0 0 ${L} ${H}`} aria-hidden="true" focusable="false">
        <Decor vue={vue} />
        {vue.faisceaux.map((f) => (
          <Faisceau key={f.id} faisceau={f} rayonDepart={rayon(f.de)} rayonArrivee={f.vers === null ? 0 : rayon(f.vers)} />
        ))}
        <EnMemeTemps faisceaux={vue.faisceaux} rayon={rayon} />
        {vue.impulsions.map((p) => (
          <Impulsion key={`i:${p.sessionId}:${p.messageId}`} impulsion={p} />
        ))}
        {vue.noeuds.map((n) => (
          <Noeud key={n.sessionId} noeud={n} position={n.position} rayon={rayonNoeud(n)} />
        ))}
        {vue.attentes.map((a) => (
          <Attente key={`a:${a.permissionId}`} attente={a} />
        ))}
        {vue.decisions.map((d) => (
          <Decision key={`d:${d.sessionId}`} decision={d} />
        ))}
        {vue.origines.map((o) => (
          <Origine key={`o:${o.sessionId}`} origine={o} />
        ))}
        {vue.arret === null ? null : (
          <g className="neon-arret" data-neon-cle="arret" data-neon-etat={String(vue.arret.depuis)} data-neon-anim="apparition">
            <rect className="neon-carre" x={L - 70} y={9} width={7} height={7} />
            <text className="neon-texte" x={L - 59} y={16}>
              {TEXTES.partout.signes.arret}
            </text>
          </g>
        )}
      </svg>
      {onOuvrir ? (
        <ul className="neon-nodes" ref={noeudsRef}>
          {vue.noeuds.map((n) => (
            <li key={n.sessionId} style={{ left: pourcent(n.position.x, L), top: pourcent(n.position.y, H) }}>
              <button type="button" className="neon-node-btn" data-neon-session={n.sessionId} aria-label={libelleNoeud(n)} title={libelleNoeud(n)} onClick={() => onOuvrir(n.sessionId)} />
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

const rayonNoeud = (n: NeonNode) => (n.role === "conversation" ? NEON_TAILLES.racine : NEON_TAILLES.assistant);

function Decor({ vue }: { vue: NeonScene }) {
  const anneaux = Array.from({ length: NEON_ANNEAUX_DESSINES }, (_, i) => i + 1);
  return (
    <g className="neon-decor">
      <rect className="neon-fond" width={L} height={H} />
      <path className="neon-grille" d={GRILLE} />
      {anneaux.map((k) => (
        <ellipse key={k} className="neon-anneau" cx={NEON_CENTRE.x} cy={NEON_CENTRE.y} rx={NEON_ANNEAU.rx * k} ry={NEON_ANNEAU.ry * k} />
      ))}
      {vue.secteurs.map((s) => {
        const { x, y } = s.etiquette;
        const ancre = x > L - 60 ? "end" : "start";
        return (
          <g key={s.id}>
            <polygon className="neon-territoire" points={hexagone(s.etiquette, 5)} />
            <text className="neon-etiquette" x={ancre === "end" ? x - 8 : x + 8} y={y + 3} textAnchor={ancre}>
              {libelleSecteur(s.id)}
            </text>
          </g>
        );
      })}
      {vue.stations.map((s) => (
        <Station key={s.id} station={s} mode={vue.mode} />
      ))}
    </g>
  );
}

function Station({ station, mode }: { station: NeonStation; mode: NeonMode }) {
  const { x, y } = station.position;
  const r = NEON_TAILLES.station;
  const carnet = station.id === "carnet";
  // Le carnet est dans le coin : son étiquette va dessous (à droite, elle toucherait le secteur Planifier).
  const tx = carnet ? x - r : x + r + 4;
  const ty = carnet ? y + r * 0.7 + 10 : y + 3;
  return (
    <g className={`neon-station${carnet ? " is-carnet" : ""}`}>
      <rect x={x - r} y={y - r * 0.7} width={r * 2} height={r * 1.4} rx={3} />
      <text className="neon-etiquette" x={tx} y={ty}>
        {libelleStation(station.id)}
      </text>
      {carnet ? (
        <text className="neon-etiquette" x={tx} y={ty + 10}>
          {carnetVide(mode)}
        </text>
      ) : null}
    </g>
  );
}

/** Assistant : cœur, halo statique s'il travaille, anneau coché (terminé), anneau brisé (échec), carré gris (arrêté), nom. */
function Noeud({ noeud, position, rayon }: { noeud: NeonNode; position: NeonPoint; rayon: number }) {
  const { x, y } = position;
  let tirets: string | undefined;
  if (noeud.etat === "pas-commence") tirets = "3 3";
  if (noeud.etat === "echec") tirets = `${Math.round(Math.PI * rayon * 0.84)} ${Math.round(Math.PI * rayon * 0.16)}`;
  return (
    <g className={`neon-noeud is-${noeud.etat}`} data-neon-cle={`n:${noeud.sessionId}`} data-neon-etat={`${noeud.etat}|${noeud.tentative ?? ""}`} data-neon-anim="apparition">
      {noeud.etat === "travaille" ? <circle className="neon-halo" cx={x} cy={y} r={rayon + 5} /> : null}
      <circle className="neon-coeur" cx={x} cy={y} r={rayon} strokeDasharray={tirets} />
      {noeud.etat === "termine" ? <path className="neon-coche" d={`M${x - rayon * 0.45} ${y}l${rayon * 0.3} ${rayon * 0.32}l${rayon * 0.55} ${-rayon * 0.62}`} /> : null}
      {noeud.etat === "arrete" ? <rect className="neon-carre" x={x - 3.5} y={y - 3.5} width={7} height={7} /> : null}
      <text className="neon-texte" x={x} y={y + rayon + 11} textAnchor="middle">
        {couper(nomAssistant(noeud), NEON_NOM_MAX)}
      </text>
    </g>
  );
}

const chevron = (p: NeonPoint, a: number) => <path className="neon-chevron" d="M-3 -4L2 0L-3 4" transform={`translate(${p.x} ${p.y}) rotate(${a})`} />;
const losange = (p: NeonPoint, r: number) => <polygon className="neon-losange" points={`${p.x},${p.y - r} ${p.x + r},${p.y} ${p.x},${p.y + r} ${p.x - r},${p.y}`} />;

/** Faisceau : forme propre à sa nature (grammaire §5.7.1) ; figé par un arrêt : gris, carré d'arrêt au milieu, forme gardée. */
function Faisceau({ faisceau: f, rayonDepart, rayonArrivee }: { faisceau: NeonBeam; rayonDepart: number; rayonArrivee: number }) {
  const fin = f.arrivee ?? versLExterieur(f.depart, NEON_CENTRE, rayonDepart + 30);
  const trait = segment(f.depart, fin, rayonDepart + 2, f.arrivee === null ? 0 : rayonArrivee + 3);
  if (trait === null) return null;
  const a = angle(trait.a, trait.b);
  const milieu = pointSur(trait.a, trait.b, 0.5);
  const enveloppe = f.kind === "consigne" && !f.fige;
  return (
    <>
      <g className={`neon-faisceau is-${f.kind}${f.fige ? " is-fige" : ""}`} data-neon-cle={`f:${f.id}`} data-neon-etat={f.fige ? `fige|${f.fin ?? ""}` : "vif"} data-neon-anim="trait">
        <line className="neon-trait" x1={trait.a.x} y1={trait.a.y} x2={trait.b.x} y2={trait.b.y} />
        {f.kind === "consigne" ? [0.28, 0.72].map((t) => <g key={t}>{chevron(pointSur(trait.a, trait.b, t), a)}</g>) : null}
        {f.kind === "resultat" ? [0.3, 0.7].map((t) => <g key={t}>{losange(pointSur(trait.a, trait.b, t), 3.5)}</g>) : null}
        {f.kind === "demande" ? <path className="neon-fleche" d="M-5 -4L3 0L-5 4Z" transform={`translate(${trait.b.x} ${trait.b.y}) rotate(${a})`} /> : null}
        {f.fige ? <rect className="neon-carre" x={milieu.x - 3} y={milieu.y - 3} width={6} height={6} /> : null}
      </g>
      {enveloppe ? (
        <g className="neon-enveloppe" data-neon-cle={`e:${f.id}`} data-neon-etat="vif" data-neon-anim="trajet" data-neon-dx={milieu.x - trait.a.x} data-neon-dy={milieu.y - trait.a.y}>
          <rect x={milieu.x - 5} y={milieu.y - 3.5} width={10} height={7} rx={1} />
          <path d={`M${milieu.x - 5} ${milieu.y - 3.5}L${milieu.x} ${milieu.y}L${milieu.x + 5} ${milieu.y - 3.5}`} />
        </g>
      ) : null}
    </>
  );
}

/**
 * « en même temps » à côté de chaque assistant d'une vague de consignes d'un même message (au moins deux), du côté opposé à
 * celui qui confie : jamais sur un faisceau court ni sur un assistant.
 */
function EnMemeTemps({ faisceaux, rayon }: { faisceaux: readonly NeonBeam[]; rayon: (id: string) => number }) {
  return (
    <>
      {faisceaux.map((f) => {
        if (f.kind !== "consigne" || !f.enMemeTemps || f.arrivee === null || f.vers === null) return null;
        const aDroite = f.arrivee.x >= f.depart.x;
        const ecart = rayon(f.vers) + 4;
        return (
          <g key={`m:${f.id}`} data-neon-cle={`m:${f.id}`} data-neon-etat="vif" data-neon-anim="trait">
            <text className="neon-etiquette" x={aDroite ? f.arrivee.x + ecart : f.arrivee.x - ecart} y={f.arrivee.y + 3} textAnchor={aDroite ? "start" : "end"}>
              {TEXTES.partout.enMemeTemps}
            </text>
          </g>
        );
      })}
    </>
  );
}

/** Appel d'IA : impulsion qui glisse de l'assistant vers la station « GitHub Copilot » et s'arrête en chemin. */
function Impulsion({ impulsion: p }: { impulsion: NeonPulse }) {
  const arrivee = pointSur(p.depart, p.arrivee, 0.35);
  return (
    <g className="neon-impulsion" data-neon-cle={`i:${p.sessionId}:${p.messageId}`} data-neon-etat="vif" data-neon-anim="trajet" data-neon-dx={arrivee.x - p.depart.x} data-neon-dy={arrivee.y - p.depart.y}>
      {losange(arrivee, 3.5)}
    </g>
  );
}

/** Attente de votre accord : hexagone hachuré, cadenas à côté. */
function Attente({ attente }: { attente: NeonWait }) {
  const c = { x: attente.position.x + 15, y: attente.position.y - 13 };
  const r = NEON_TAILLES.attente;
  const hachures = [-4, 0, 4].map((d) => `M${c.x + d - 2.5} ${c.y + 4}L${c.x + d + 2.5} ${c.y - 4}`).join("");
  const k = { x: c.x + r + 5, y: c.y };
  return (
    <g className="neon-attente" data-neon-cle={`a:${attente.permissionId}`} data-neon-etat="ouverte" data-neon-anim="apparition">
      <polygon points={hexagone(c, r)} />
      <path d={hachures} />
      <path d={`M${k.x - 3} ${k.y}h6v5h-6zM${k.x - 2} ${k.y}v-2a2 2 0 0 1 4 0v2`} />
    </g>
  );
}

/** Décision du cockpit : bouclier coché (automatique) ou croix (refusé). */
function Decision({ decision: d }: { decision: NeonDecision }) {
  const { x, y } = { x: d.position.x - 15, y: d.position.y - 13 };
  const r = NEON_TAILLES.decision;
  const forme =
    d.signe === "auto"
      ? `M${x} ${y - r}l${r * 0.85} ${r * 0.33}v${r * 0.6}c0 ${r * 0.5} ${-r * 0.37} ${r * 0.85} ${-r * 0.85} ${r}c${-r * 0.48} ${-r * 0.15} ${-r * 0.85} ${-r * 0.5} ${-r * 0.85} ${-r}v${-r * 0.6}zM${x - r * 0.4} ${y}l${r * 0.3} ${r * 0.3}l${r * 0.5} ${-r * 0.6}`
      : `M${x - r * 0.7} ${y - r * 0.7}L${x + r * 0.7} ${y + r * 0.7}M${x + r * 0.7} ${y - r * 0.7}L${x - r * 0.7} ${y + r * 0.7}`;
  return (
    <g className={`neon-decision is-${d.signe}`} data-neon-cle={`d:${d.sessionId}`} data-neon-etat={`${d.signe}|${d.permissionId ?? ""}`} data-neon-anim="apparition">
      <path d={forme} />
    </g>
  );
}

const GLYPHES: Readonly<Record<NeonOriginMark["origine"], string>> = {
  cockpit: "C",
  "reveil-sans-reponse": "…",
  "relance-extension": "↻",
  "interne-extension": "i",
  "interne-opencode": "i",
  "origine-inconnue": "?",
};

/** Marque d'origine d'un message non écrit par vous (§5.7.2) ; son libellé est dans le tableau. */
function Origine({ origine: o }: { origine: NeonOriginMark }) {
  const c = { x: o.position.x + 15, y: o.position.y + 13 };
  return (
    <g className={`neon-origine is-${o.origine}`} data-neon-cle={`o:${o.sessionId}`} data-neon-etat={`${o.origine}|${o.messageId}`} data-neon-anim="apparition">
      <circle cx={c.x} cy={c.y} r={6} />
      <text className="neon-texte" x={c.x} y={c.y + 3} textAnchor="middle">
        {GLYPHES[o.origine]}
      </text>
    </g>
  );
}

// --- Zoom 3 -----------------------------------------------------------------------------------------------------------------------

interface Lecture {
  sessionId: string;
  /** null : lecture en échec (textes indisponibles). */
  messages: readonly unknown[] | null;
}

/**
 * Messages de la session détaillée, relus quand le panneau change (consigne, réponse, état, tuiles), au plus une fois toutes les
 * 2 s pour un même assistant (un autre assistant est lu tout de suite) ; null tant que la première lecture n'est pas arrivée.
 */
function useMessagesDuPanneau(detail: NeonDetail, etat: string, directory: string | undefined): Lecture | null {
  const sessionId = detail.sessionId;
  const cle = [
    sessionId,
    detail.panneau.consigne?.messageId ?? "",
    detail.panneau.reponse?.messageId ?? "",
    detail.panneau.resultat?.etat ?? "",
    etat,
    ...detail.dossiers.flatMap((d) => d.tuiles.map((t) => t.callId)),
  ].join("|");
  const [lecture, setLecture] = useState<Lecture | null>(null);
  const derniere = useRef<{ sessionId: string; at: number } | null>(null);
  useEffect(() => {
    let annule = false;
    const avant = derniere.current;
    const delai = avant?.sessionId === sessionId ? Math.max(0, avant.at + NEON_RELECTURE_MS - Date.now()) : 0;
    const minuteur = window.setTimeout(() => {
      derniere.current = { sessionId, at: Date.now() };
      oc.messages(sessionId, directory).then(
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
      window.clearTimeout(minuteur);
    };
  }, [cle, sessionId, directory]);
  return lecture?.sessionId === sessionId ? lecture : null;
}

/**
 * Texte d'un message relu dans la conversation : « non enregistré » si aucun fait ne le nomme (P12 : trou étiqueté), « … »
 * pendant la lecture, « Texte indisponible. » si la lecture échoue ou si le message est absent ou vide ; sinon le texte masqué
 * puis coupé par texteDuMessage, rendu en texte (échappé par React), jamais en HTML.
 */
function TexteLu({ lecture, messageId }: { lecture: Lecture | null; messageId: string | null }) {
  if (messageId === null) return <p className="neon-panel-text">{TEXTES.partout.nonEnregistre}</p>;
  if (lecture === null) return <p className="neon-panel-text">…</p>;
  const valeur = lecture.messages === null ? null : texteDuMessage(lecture.messages, messageId);
  return <p className="neon-panel-text">{valeur ?? TEXTES.partout.texteIndisponible}</p>;
}

/** « Résultat rendu » d'une délégation (texte rendu, échec ou arrêt), sinon « Réponse rédigée » si l'assistant en a une. */
function ResultatRendu({ panneau, lecture }: { panneau: NeonDetail["panneau"]; lecture: Lecture | null }) {
  const { resultat, reponse } = panneau;
  if (resultat === null && reponse === null) return null;
  let contenu = <TexteLu lecture={lecture} messageId={reponse?.messageId ?? null} />;
  if (resultat !== null && resultat.etat !== "rendu") contenu = <p className="neon-panel-text">{libelleEtat(resultat.etat === "echec" ? "echec" : "arrete")}</p>;
  return (
    <>
      <dt>{resultat === null ? TEXTES.partout.panneau.reponse : TEXTES.partout.panneau.resultat}</dt>
      <dd>{contenu}</dd>
    </>
  );
}

const etatsTuile = (t: NeonTile) =>
  [t.lu ? TEXTES.partout.tuiles.lu : "", t.modifie ? TEXTES.partout.tuiles.modifie : "", t.refuse ? TEXTES.partout.tuiles.refuse : "", t.enCours ? TEXTES.partout.tuiles.enCours : ""]
    .filter((mot) => mot !== "")
    .join(", ");

function NeonZoom3({
  vue,
  detail,
  directory,
  retourRef,
  onRetour,
}: {
  vue: NeonScene;
  detail: NeonDetail;
  directory: string | undefined;
  retourRef: RefObject<HTMLButtonElement | null>;
  onRetour: () => void;
}) {
  const svgRef = useRef<SVGSVGElement>(null);
  useTransitions(svgRef, vue);
  const noeud = vue.noeuds.find((n) => n.sessionId === detail.sessionId);
  const lecture = useMessagesDuPanneau(detail, noeud?.etat ?? "", directory);
  const chemins = useMemo(() => {
    const out = new Map<string, string>();
    if (lecture?.messages) {
      for (const d of detail.dossiers) {
        for (const t of d.tuiles) {
          const chemin = cheminDeLOutil(lecture.messages, t.callId);
          if (chemin !== null) out.set(t.callId, chemin);
        }
      }
    }
    return out;
  }, [lecture, detail]);
  const { panneau } = detail;
  const outilsUtilises = [...detail.outils.map((o) => ({ nom: libelleOutil(o.categorie), ...o })), { nom: libelleOutil("autres"), ...detail.autresOutils }]
    .map((o) => ({ nom: o.nom, total: o.enCours + o.termines + o.echecs + o.interrompus }))
    .filter((o) => o.total > 0);
  const tuiles = detail.dossiers.flatMap((d) => d.tuiles);
  return (
    <div className="neon-detail">
      <div className="neon-map-wrap">
        <svg ref={svgRef} className="neon-map" viewBox={`0 0 ${L} ${H}`} aria-hidden="true" focusable="false">
          <rect className="neon-fond" width={L} height={H} />
          <path className="neon-grille" d={GRILLE} />
          {noeud ? <Noeud noeud={noeud} position={detail.position} rayon={NEON_TAILLES.detail} /> : null}
          {detail.outils.map((o) => {
            const total = o.enCours + o.termines + o.echecs + o.interrompus;
            const { x, y } = o.position;
            return (
              <g
                key={o.categorie}
                className={`neon-outil${total === 0 ? " is-vide" : ""}`}
                data-neon-cle={`z3:o:${o.categorie}`}
                data-neon-etat={`${o.enCours}|${o.termines}|${o.echecs}|${o.interrompus}`}
                data-neon-anim="apparition"
              >
                <circle cx={x} cy={y} r={NEON_TAILLES.outil} />
                {total > 0 ? (
                  <text className="neon-texte" x={x} y={y + 3} textAnchor="middle">
                    {total}
                  </text>
                ) : null}
                <text className="neon-etiquette" x={x} y={y + NEON_TAILLES.outil + 9} textAnchor="middle">
                  {libelleOutil(o.categorie)}
                </text>
              </g>
            );
          })}
          {detail.dossiers.map((d) => {
            const premier = d.tuiles[0];
            const chemin = premier === undefined ? undefined : chemins.get(premier.callId);
            const x = 230 + 64 * d.colonne;
            return (
              <g key={d.dossier}>
                {chemin === undefined ? null : (
                  <text className="neon-etiquette" x={x - 8} y={12}>
                    {nomDeFichier(dossierDe(chemin), 11)}
                  </text>
                )}
                {d.tuiles.map((t) => (
                  <Tuile key={`${t.fichier}|${t.callId}`} tuile={t} chemin={chemins.get(t.callId)} />
                ))}
                {d.enPlus > 0 ? (
                  <text className="neon-etiquette" x={x - 8} y={H - 4}>
                    {remplir(TEXTES.partout.tuiles.enPlus, { n: d.enPlus })}
                  </text>
                ) : null}
              </g>
            );
          })}
          {detail.dossiersEnPlus > 0 ? (
            <text className="neon-etiquette" x={L - 6} y={H - 4} textAnchor="end">
              {remplir(TEXTES.partout.tuiles.enPlus, { n: detail.dossiersEnPlus })}
            </text>
          ) : null}
        </svg>
      </div>
      <div className="neon-panel">
        <div className="neon-panel-head">
          <p>{noeud ? libelleNoeud(noeud) : TEXTES.partout.assistantConversation}</p>
          <button ref={retourRef} type="button" className="btn sm" onClick={onRetour}>
            {TOUCHES.afficher}
          </button>
        </div>
        <dl>
          <dt>{TEXTES.partout.panneau.consigne}</dt>
          <dd>
            <TexteLu lecture={lecture} messageId={panneau.consigne?.messageId ?? null} />
          </dd>
          <dt>{TEXTES.partout.panneau.actions}</dt>
          <dd>
            {outilsUtilises.length === 0 && tuiles.length === 0 ? (
              <p className="neon-panel-text">—</p>
            ) : (
              <ul>
                {outilsUtilises.map((o) => (
                  <li key={o.nom}>
                    {o.nom} : {o.total}
                  </li>
                ))}
                {tuiles.map((t) => {
                  const etats = etatsTuile(t);
                  return (
                    <li key={`${t.fichier}|${t.callId}`}>
                      {couper(chemins.get(t.callId) ?? "…", 120)}
                      {etats === "" ? null : ` (${etats})`}
                    </li>
                  );
                })}
              </ul>
            )}
          </dd>
          <ResultatRendu panneau={panneau} lecture={lecture} />
        </dl>
      </div>
    </div>
  );
}

/** Tuile de fichier : contour bleu = lu, plein rose = modifié, barré = refusé, tirets = en cours ; nom relu et masqué. */
function Tuile({ tuile: t, chemin }: { tuile: NeonTile; chemin: string | undefined }) {
  const { x, y } = t.position;
  const r = NEON_TAILLES.tuile / 2;
  const classes = ["neon-tuile", t.lu ? "is-lu" : "", t.modifie ? "is-modifie" : "", t.refuse ? "is-refuse" : "", t.enCours ? "is-en-cours" : ""].filter(Boolean).join(" ");
  return (
    <g className={classes} data-neon-cle={`z3:t:${t.fichier}`} data-neon-etat={`${t.lu}|${t.modifie}|${t.refuse}|${t.enCours}`} data-neon-anim="apparition">
      <rect x={x - r} y={y - r} width={r * 2} height={r * 2} rx={2} />
      {t.refuse ? <line className="neon-barre" x1={x - r} y1={y + r} x2={x + r} y2={y - r} /> : null}
      {chemin === undefined ? null : (
        <text className="neon-etiquette" x={x + r + 3} y={y + 3}>
          {nomDeFichier(chemin, 9)}
        </text>
      )}
    </g>
  );
}

// --- Tableau ----------------------------------------------------------------------------------------------------------------------

/** [Tableau] : une ligne par assistant dessiné, mêmes faits que la carte. */
export function NeonTableau({ vue }: { vue: NeonScene }) {
  const lignes = useMemo(() => lignesTableau(vue), [vue]);
  const colonnes = TEXTES.partout.tableau;
  return (
    <div className="table-wrap">
      <table className="table neon-table">
        <caption className="visually-hidden">{titreBande(vue.mode)}</caption>
        <thead>
          <tr>
            <th scope="col">{colonnes.assistant}</th>
            <th scope="col">{colonnes.secteur}</th>
            <th scope="col">{colonnes.etat}</th>
            <th scope="col">{colonnes.depuis}</th>
            <th scope="col">{colonnes.carte}</th>
          </tr>
        </thead>
        <tbody>
          {lignes.map((l) => (
            <tr key={l.sessionId}>
              <th scope="row">{l.nom}</th>
              <td>{l.secteur ?? "—"}</td>
              <td>{l.etat}</td>
              <td className="tabular">{HEURE.format(l.depuis)}</td>
              <td>{l.signes.join(" · ")}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
