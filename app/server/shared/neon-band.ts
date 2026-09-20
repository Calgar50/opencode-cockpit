// Bande néon 2D du chat (spécification §5.7.4, §5.5, §5.6, JP-13, P12 ; plan d'exécution, fiche L5c) : modèle pur de la bande
// dessinée par web/pages/chat/activity/NeonBand.tsx, testé sans navigateur (neon-band.test.ts).
// - File d'affichage : au plus 4 rendus par seconde, un changement reçu à la fois, dans l'ordre. Un changement qui attend depuis
//   plus de 2 s vide la file d'un coup : « Affichage rattrapé » (persisté par POST …/facts/affichage, décision du 15/09), annoncé
//   2 s au moins (le fait `affichage` renvoyé par le serveur est un changement : son rendu ne l'efface pas). « Figer l'affichage »
//   garde l'image pendant que le travail continue ; la reprise montre le direct, sans rattrapage annoncé.
// - Bande repliée par défaut en mode Simple, dépliée en mode Avancé (§5.1). Résumé d'une ligne (bande repliée), lignes du
//   [Tableau] (une par assistant dessiné) et signes de chaque assistant, tous tirés de la scène (P12 : aucun signe sans fait).
// - Panneau du zoom 3 : textes relus dans les messages de la session (consigne, réponse, chemins des tuiles), TOUJOURS passés par
//   redactSecrets PUIS coupés (une coupe avant le masquage laisserait passer un morceau de secret) ; l'interface les rend en texte,
//   échappé par React, jamais en HTML.
// - Mouvement (JP-13) : images clés sur `opacity` et `transform` seulement, une transition d'environ 900 ms par changement,
//   terminée sur l'état statique ; aucune répétition.
// - Géométrie des signes (chevrons, losanges, hexagones, retraits) : constante, jamais liée à une grandeur (§5.7.1).
// Module pur (server/shared) : ni module node, ni horloge (l'heure est un paramètre), ni aléa, ni réseau.
import { redactSecrets } from "../redact.ts";
import type { NeonBeam, NeonMode, NeonNode, NeonPoint, NeonScene } from "./neon-scene.ts";
import { libelleBouton, libelleEtat, libelleOrigine, libelleSecteur, remplir, TEXTES } from "./neon-texts.ts";

/** Au plus 4 rendus par seconde (§5.7.4). */
export const NEON_RENDU_MS = 250;
/** File bornée à 2 s, puis « Affichage rattrapé » (§5.7.4). */
export const NEON_FILE_MAX_MS = 2_000;
/** « Affichage rattrapé » reste annoncé 2 s après le rattrapage. */
export const NEON_RATTRAPE_MS = 2_000;
/** Une transition d'environ 900 ms par changement (JP-13). */
export const NEON_TRANSITION_MS = 900;
/** Panneau du zoom 3 : au plus une relecture des messages toutes les 2 s. */
export const NEON_RELECTURE_MS = 2_000;
/** Panneau du zoom 3 : caractères gardés par texte (consigne, réponse), après masquage. */
export const NEON_TEXTE_MAX = 600;
/** Nom d'assistant, de fichier ou de dossier écrit sur la carte : caractères gardés. */
export const NEON_NOM_MAX = 16;

// --- File d'affichage -------------------------------------------------------------------------------------------------------------

/** Changement reçu : nombre de faits de la liste à ce moment et heure d'arrivée (ms). */
export interface NeonChangement {
  faits: number;
  depuis: number;
}

export interface NeonFile {
  /** Faits affichés : préfixe de la liste reçue. */
  affiches: number;
  /** Changements reçus pas encore affichés, dans l'ordre d'arrivée. */
  attente: readonly NeonChangement[];
  /** Heure du dernier rendu, null avant le premier. */
  dernierRendu: number | null;
  /** Heure du dernier rattrapage (file vidée d'un coup) tant qu'il est annoncé (2 s), null sinon. */
  rattrapage: number | null;
  /** « Figer l'affichage » : rien n'est rendu, seule la dernière cible est gardée. */
  fige: boolean;
}

export interface NeonPas {
  file: NeonFile;
  /** La file vient d'être vidée d'un coup : l'interface l'enregistre (« Affichage rattrapé » s'affiche tant que `rattrapage`). */
  rattrape: boolean;
  /** Heure du prochain pas utile (changement à rendre, annonce à retirer), null s'il n'y en a pas (rien n'attend, ou figée). */
  prochain: number | null;
}

const borne = (n: number) => (Number.isSafeInteger(n) && n > 0 ? n : 0);

/** File d'une liste lue d'un coup (ouverture, relecture) : affichée telle quelle, sans attente. */
export function fileNeuve(faits: number): NeonFile {
  return { affiches: borne(faits), attente: [], dernierRendu: null, rattrapage: null, fige: false };
}

/** Nombre de faits que l'affichage doit finir par montrer. */
export function cible(file: NeonFile): number {
  return file.attente.at(-1)?.faits ?? file.affiches;
}

/**
 * Nouvelle longueur de la liste des faits. Plus longue : un changement de plus dans la file. Plus courte : la liste a été remplacée
 * (relecture), elle est affichée telle quelle. Figée : seule la dernière cible est gardée (la file ne grossit pas).
 */
export function recevoir(file: NeonFile, faits: number, maintenant: number): NeonFile {
  const n = borne(faits);
  const but = cible(file);
  if (n === but) return file;
  if (n < but) return { ...file, affiches: n, attente: [], rattrapage: null };
  const changement: NeonChangement = { faits: n, depuis: maintenant };
  return { ...file, attente: file.fige ? [changement] : [...file.attente, changement] };
}

/** Heure du rattrapage encore annoncé à `maintenant` (moins de 2 s), null sinon ; une horloge qui recule retire l'annonce. */
function annonce(file: NeonFile, maintenant: number): number | null {
  const at = file.rattrapage;
  return at !== null && maintenant >= at && maintenant - at < NEON_RATTRAPE_MS ? at : null;
}

/**
 * Pas de la file à l'heure `maintenant`. Rien avant 250 ms après le dernier rendu (au plus 4 rendus par seconde, rattrapage
 * compris ; une horloge qui recule n'empêche rien). Ensuite : rattrapage si le plus ancien changement attend depuis plus de 2 s,
 * sinon rendu du changement suivant. Un changement est donc affiché au plus 2 s + 250 ms après son arrivée. L'annonce d'un
 * rattrapage survit aux rendus pendant 2 s ; un dernier pas la retire.
 */
export function avancer(file: NeonFile, maintenant: number): NeonPas {
  if (file.fige) return { file, rattrape: false, prochain: null };
  const rattrapage = annonce(file, maintenant);
  const finAnnonce = rattrapage === null ? null : rattrapage + NEON_RATTRAPE_MS;
  const inchangee = rattrapage === file.rattrapage ? file : { ...file, rattrapage };
  const premier = file.attente[0];
  if (premier === undefined) return { file: inchangee, rattrape: false, prochain: finAnnonce };
  const dernier = file.dernierRendu;
  if (dernier !== null && maintenant >= dernier && maintenant - dernier < NEON_RENDU_MS) {
    return { file: inchangee, rattrape: false, prochain: dernier + NEON_RENDU_MS };
  }
  if (maintenant - premier.depuis > NEON_FILE_MAX_MS) {
    return {
      file: { ...file, affiches: cible(file), attente: [], dernierRendu: maintenant, rattrapage: maintenant },
      rattrape: true,
      prochain: maintenant + NEON_RATTRAPE_MS,
    };
  }
  const reste = file.attente.slice(1);
  return {
    file: { ...file, affiches: premier.faits, attente: reste, dernierRendu: maintenant, rattrapage },
    rattrape: false,
    prochain: reste.length > 0 ? maintenant + NEON_RENDU_MS : finAnnonce,
  };
}

/**
 * « Figer l'affichage » ou « Reprendre l'affichage en direct ». Figer retire l'annonce d'un rattrapage (l'image ne bouge plus) ;
 * la reprise montre la dernière cible, sans rattrapage annoncé.
 */
export function figer(file: NeonFile, fige: boolean, maintenant: number): NeonFile {
  if (fige === file.fige) return file;
  if (fige) return { ...file, fige: true, attente: file.attente.slice(-1), rattrapage: null };
  return { affiches: cible(file), attente: [], dernierRendu: maintenant, rattrapage: null, fige: false };
}

/** Bande dépliée par défaut en mode Avancé ; repliée en mode Simple, avec un résumé d'une ligne (§5.1). */
export function deplieeParDefaut(mode: NeonMode): boolean {
  return mode === "avance";
}

// --- Résumé et tableau ------------------------------------------------------------------------------------------------------------

/** Nom d'un assistant dessiné : son nom enregistré ; sinon « Assistant de la conversation » ou « Assistant non identifié ». */
export function nomAssistant(noeud: Pick<NeonNode, "agent" | "role">): string {
  if (noeud.agent !== null && noeud.agent !== "") return noeud.agent;
  return noeud.role === "conversation" ? TEXTES.partout.assistantConversation : TEXTES.partout.assistantInconnu;
}

/** Nom accessible du bouton d'un assistant : « {nom}, {état} ». */
export function libelleNoeud(noeud: Pick<NeonNode, "agent" | "role" | "etat">): string {
  return libelleBouton(nomAssistant(noeud), noeud.etat);
}

/**
 * Résumé d'une ligne de la bande repliée : l'assistant de la conversation et son état, et, en mode Simple, le travail confié
 * avant le passage en mode Simple (compté, non dessiné). null tant qu'aucun fait ne dessine l'assistant de la conversation.
 */
export function resumeBande(vue: NeonScene): string | null {
  const racine = vue.noeuds.find((noeud) => noeud.role === "conversation");
  if (racine === undefined) return null;
  const morceaux = [libelleNoeud(racine)];
  if (vue.delegationsMasquees > 0) morceaux.push(TEXTES.simple.travailConfieHorsCarte);
  return morceaux.join(" · ");
}

const faisceauxVers = (vue: NeonScene, sessionId: string) => vue.faisceaux.filter((f) => f.vers === sessionId);
const faisceauxDe = (vue: NeonScene, sessionId: string) => vue.faisceaux.filter((f) => f.de === sessionId);

/** Libellé d'un faisceau dans le tableau : son signe, et « en même temps » pour une consigne d'une même vague. */
function libelleFaisceau(faisceau: NeonBeam): string {
  const signe = TEXTES.partout.signes[faisceau.kind];
  return faisceau.enMemeTemps ? `${signe} (${TEXTES.partout.enMemeTemps})` : signe;
}

/**
 * Signes dessinés pour un assistant, en toutes lettres, dans l'ordre de la grammaire : faisceaux reçus (votre demande, consigne)
 * et envoyés (préparation, résultat), attente, décision, appel d'IA, marque d'origine, nouvelle tentative, tâches, mémoire résumée,
 * arrêt. Chacun vient d'un signe de la scène, donc d'un fait (P12).
 */
export function signesAssistant(vue: NeonScene, sessionId: string): string[] {
  const recus = faisceauxVers(vue, sessionId).filter((f) => f.kind === "demande" || f.kind === "consigne");
  const envoyes = faisceauxDe(vue, sessionId).filter((f) => f.kind === "preparation" || f.kind === "resultat");
  const signes = [...recus, ...envoyes].map(libelleFaisceau);
  if (vue.attentes.some((a) => a.sessionId === sessionId)) signes.push(TEXTES.partout.signes.attente);
  for (const d of vue.decisions.filter((candidat) => candidat.sessionId === sessionId)) signes.push(TEXTES.partout.signes[d.signe]);
  if (vue.impulsions.some((i) => i.sessionId === sessionId)) signes.push(TEXTES.partout.signes.appel);
  for (const o of vue.origines.filter((candidat) => candidat.sessionId === sessionId)) signes.push(libelleOrigine(o.origine, vue.mode) ?? "");
  const noeud = vue.noeuds.find((n) => n.sessionId === sessionId);
  if (noeud !== undefined) signes.push(...marquesDuNoeud(noeud));
  const arrete = noeud?.role === "conversation" && vue.arret !== null;
  if (arrete || faisceauxVers(vue, sessionId).some((f) => f.fige) || faisceauxDe(vue, sessionId).some((f) => f.fige)) signes.push(TEXTES.partout.signes.arret);
  return [...new Set(signes.filter((signe) => signe !== ""))];
}

/** Nouvelle tentative, tâches et mémoire résumée d'un assistant. */
function marquesDuNoeud(noeud: NeonNode): string[] {
  const marques: string[] = [];
  if (noeud.tentative !== null) marques.push(remplir(TEXTES.partout.tentative, { n: noeud.tentative }));
  if (noeud.taches !== null) marques.push(remplir(TEXTES.partout.taches, { faites: noeud.taches.faites, total: noeud.taches.total }));
  if (noeud.memoireResumee !== null) marques.push(TEXTES.partout.memoireResumee);
  return marques;
}

export interface NeonLigne {
  sessionId: string;
  nom: string;
  /** Libellé du secteur ; null pour l'assistant de la conversation, au centre. */
  secteur: string | null;
  etat: string;
  /** Heure (ms) du dernier changement d'état. */
  depuis: number;
  signes: string[];
}

/** Lignes du [Tableau] : une par assistant dessiné, dans l'ordre de la scène (conversation d'abord). */
export function lignesTableau(vue: NeonScene): NeonLigne[] {
  return vue.noeuds.map((noeud) => ({
    sessionId: noeud.sessionId,
    nom: nomAssistant(noeud),
    secteur: noeud.secteur === null ? null : libelleSecteur(noeud.secteur),
    etat: libelleEtat(noeud.etat),
    depuis: noeud.depuis,
    signes: signesAssistant(vue, noeud.sessionId),
  }));
}

// --- Panneau du zoom 3 : textes relus dans la conversation ----------------------------------------------------------------------

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

/** Coupe un texte à `max` caractères (points de code), avec « … » ; jamais au milieu d'une paire de substitution. */
export function couper(texte: string, max: number): string {
  const points = Array.from(texte);
  return points.length <= max ? texte : `${points.slice(0, Math.max(0, max - 1)).join("").trimEnd()}…`;
}

/** Parties d'un message de la liste (forme de GET /session/:id/message : { info: { id }, parts }), null si absent. */
function partiesDu(messages: readonly unknown[], messageId: string): Record<string, unknown>[] | null {
  for (const message of messages) {
    if (!isRecord(message) || !isRecord(message.info) || message.info.id !== messageId) continue;
    return Array.isArray(message.parts) ? message.parts.filter(isRecord) : [];
  }
  return null;
}

/**
 * Texte d'un message (parties texte écrites, ni ajoutées par opencode ni ignorées), masqué par redactSecrets puis coupé à `max`
 * caractères ; null si le message est absent ou sans texte.
 */
export function texteDuMessage(messages: readonly unknown[], messageId: string | null, max: number = NEON_TEXTE_MAX): string | null {
  if (messageId === null) return null;
  const parties = partiesDu(messages, messageId);
  if (parties === null) return null;
  const texte = parties
    .filter((p) => p.type === "text" && typeof p.text === "string" && p.synthetic !== true && p.ignored !== true)
    .map((p) => p.text as string)
    .join("\n\n")
    .trim();
  return texte === "" ? null : couper(redactSecrets(texte), max);
}

/** Chemin du fichier d'une partie d'outil (`state.input.filePath`, même lecture que les faits), masqué ; null sinon. */
export function cheminDeLOutil(messages: readonly unknown[], callId: string): string | null {
  const partie = partieOutil(messages, callId);
  const entree = partie !== null && isRecord(partie.state) && isRecord(partie.state.input) ? partie.state.input : null;
  const chemin = entree?.filePath;
  return typeof chemin === "string" && chemin !== "" ? redactSecrets(chemin) : null;
}

/** Partie d'outil `callId` dans les messages, null si absente. */
function partieOutil(messages: readonly unknown[], callId: string): Record<string, unknown> | null {
  for (const message of messages) {
    if (!isRecord(message) || !Array.isArray(message.parts)) continue;
    const partie = message.parts.find((p: unknown) => isRecord(p) && p.type === "tool" && p.callID === callId);
    if (isRecord(partie)) return partie;
  }
  return null;
}

const normaliser = (chemin: string) => chemin.replaceAll("\\", "/").replace(/\/{2,}/g, "/").replace(/(.)\/$/, "$1");

/** Nom du fichier d'un chemin (dernier élément), coupé pour la carte. */
export function nomDeFichier(chemin: string, max: number = NEON_NOM_MAX): string {
  const normal = normaliser(chemin);
  return couper(normal.slice(normal.lastIndexOf("/") + 1) || normal, max);
}

/** Dossier d'un chemin (tout sauf le dernier élément), « / » à la racine. */
export function dossierDe(chemin: string): string {
  const normal = normaliser(chemin);
  const coupe = normal.lastIndexOf("/");
  return coupe <= 0 ? "/" : normal.slice(0, coupe);
}

// --- Géométrie des signes (constante) ---------------------------------------------------------------------------------------------

const arrondi = (v: number) => Math.round(v * 10) / 10;

/**
 * Décor de la carte (zoom 2) : centre de l'assistant de la conversation et demi-axes de l'anneau 1 ; l'anneau k a des demi-axes
 * k fois plus grands. Mêmes valeurs que la géométrie de neon-scene.ts (CENTRE, RING_RX, RING_RY), vérifiées par neon-band.test.ts
 * sur les positions attribuées par scene().
 */
export const NEON_CENTRE: Readonly<NeonPoint> = Object.freeze({ x: 280, y: 110 });
export const NEON_ANNEAU = Object.freeze({ rx: 80, ry: 30 });

/** Grille du fond, pas de 20 : un seul chemin (décor). Un pas non fini ou inférieur à 1 ne dessine rien (jamais de boucle sans fin). */
export function grille(largeur: number, hauteur: number, pas = 20): string {
  const traits: string[] = [];
  if (!Number.isFinite(pas) || pas < 1) return "";
  for (let x = pas; x < largeur; x += pas) traits.push(`M${x} 0V${hauteur}`);
  for (let y = pas; y < hauteur; y += pas) traits.push(`M0 ${y}H${largeur}`);
  return traits.join("");
}

/** Point à la fraction `t` du segment [a, b]. */
export function pointSur(a: NeonPoint, b: NeonPoint, t: number): NeonPoint {
  return { x: arrondi(a.x + (b.x - a.x) * t), y: arrondi(a.y + (b.y - a.y) * t) };
}

/** Angle (degrés) de a vers b ; 0 si les points sont confondus. */
export function angle(a: NeonPoint, b: NeonPoint): number {
  return a.x === b.x && a.y === b.y ? 0 : arrondi((Math.atan2(b.y - a.y, b.x - a.x) * 180) / Math.PI);
}

/** Segment [a, b] raccourci de `retraitA` au départ et `retraitB` à l'arrivée (bords des signes) ; null s'il ne reste rien. */
export function segment(a: NeonPoint, b: NeonPoint, retraitA: number, retraitB: number): { a: NeonPoint; b: NeonPoint } | null {
  const longueur = Math.hypot(b.x - a.x, b.y - a.y);
  if (longueur <= retraitA + retraitB + 1) return null;
  return { a: pointSur(a, b, retraitA / longueur), b: pointSur(a, b, 1 - retraitB / longueur) };
}

/** Sommets d'un hexagone régulier (pointe en haut) de rayon r, au format de l'attribut `points`. */
export function hexagone(centre: NeonPoint, r: number): string {
  const sommets: string[] = [];
  for (let i = 0; i < 6; i++) {
    const a = ((60 * i - 90) * Math.PI) / 180;
    sommets.push(`${arrondi(centre.x + r * Math.cos(a))},${arrondi(centre.y + r * Math.sin(a))}`);
  }
  return sommets.join(" ");
}

/** Préparation d'une délégation, cible encore inconnue : trait court vers l'extérieur de la carte, depuis le centre du dessin. */
export function versLExterieur(depart: NeonPoint, centre: NeonPoint, longueur: number): NeonPoint {
  const dx = depart.x - centre.x;
  const dy = depart.y - centre.y;
  const norme = Math.hypot(dx, dy);
  const [ux, uy] = norme < 1 ? [0.894, -0.447] : [dx / norme, dy / norme];
  return { x: arrondi(depart.x + ux * longueur), y: arrondi(depart.y + uy * longueur) };
}

// --- Mouvement (JP-13) ------------------------------------------------------------------------------------------------------------

/**
 * Transition d'un signe : « apparition » d'un assistant ou d'une marque (opacité et échelle), « trait » d'un faisceau (opacité),
 * « trajet » d'une enveloppe ou d'une impulsion qui glisse depuis son départ (dx, dy : chemin parcouru), « changement » d'état.
 */
export type NeonTransition = "apparition" | "trait" | "trajet" | "changement";

/** Image clé WAAPI : seulement `opacity` et `transform` (JP-13). Type (et non interface) : assignable à `Keyframe`. */
export type NeonImageCle = {
  opacity: number;
  transform?: string;
};

/** Images clés d'une transition : deux images, la dernière est l'état statique du dessin (opacité 1, aucune transformation). */
export function imagesCles(transition: NeonTransition, dx = 0, dy = 0): NeonImageCle[] {
  switch (transition) {
    case "apparition":
      return [
        { opacity: 0, transform: "scale(0.6)" },
        { opacity: 1, transform: "scale(1)" },
      ];
    case "trajet":
      return [
        { opacity: 0.2, transform: `translate(${arrondi(-dx)}px, ${arrondi(-dy)}px)` },
        { opacity: 1, transform: "translate(0px, 0px)" },
      ];
    case "trait":
      return [{ opacity: 0 }, { opacity: 1 }];
    default:
      return [{ opacity: 0.35 }, { opacity: 1 }];
  }
}
