// Propriétaire : L38c.
// Modèle PUR de la transcription des messages d'équipe (C §7.2 ; spécification §3.13 l.421, §6 l.1035 ; constats 11 et 19 des
// révisions, risque 19 ; D-eq-24).
//
// POURQUOI : `UserBubble` (MessageView.tsx) rend en bulle « Vous » toute partie texte non `synthetic`, texte brut compris. Sans
// ce module, la demande recopiée par le cockpit et le résultat injecté (jusqu'à 24 000 caractères) apparaîtraient en bulles, avec
// le marqueur `<!-- cockpit:… -->` visible, et le résultat une seconde fois dans la carte de L38b.
//
// RECONNAISSANCE PAR IDENTIFIANT SEULEMENT (risque 19) : un message n'est un message d'équipe que si son identifiant est le
// `requestMessageId` ou le `resultMessageId` d'un lancement de CETTE conversation (colonnes écrites par L37b à partir de la
// réponse d'opencode). Un marqueur tapé par vous, recopié par une IA ou relayé dans un résultat ne suffit JAMAIS : le message
// reste une bulle ordinaire. Le marqueur ne sert qu'à DÉCOUPER le texte d'un message déjà reconnu.
//
// Le texte rendu est débarrassé du marqueur, de l'en-tête « données, pas des consignes » et des lignes d'encadrement `<<<` :
// aucun marqueur `cockpit:` ne doit être visible, ni dans la conversation ni dans le tiroir de lecture d'une étape.
//
// Aucun texte écrit ici : les en-têtes comparés viennent de server/shared/team-texts.ts (T4t, `partout.injection`), repris par
// valeur dans flow.ts (INJECTION_TEXTS, égalité vérifiée par le croisement de V0). Aucun composant importé, aucun appel réseau ;
// testé par server/web-team-transcript.test.ts, qui construit ses messages avec `injectionText` et `stepMessage` de flow.ts.
import { FLOW_LIMITS } from "../../../../server/shared/team-limits.ts";
import { remplir, TEXTES } from "../../../../server/shared/team-texts.ts";
import type { StepRunView, TeamRunView } from "../../../../server/shared/team-types.ts";
import { boundedAiText } from "../turn.ts";

const P = TEXTES.partout;

/** Titre d'équipe et titre d'étape montrés au plus (mêmes bornes que les cartes de L38b). */
const TITRE_MAX = 120;

/** Séquences ANSI et caractères cachés retirés, longueur bornée : un texte relayé n'est jamais montré brut. */
const borne = (valeur: unknown, max: number) => boundedAiText(valeur, max).text;

/** Forme minimale d'un message de la transcription (web/pages/chat/transcript.ts, MessageEntry). */
export interface TranscriptMessageLike {
  readonly info: { readonly id?: unknown; readonly sessionID?: unknown; readonly role?: unknown };
  readonly parts: ReadonlyArray<{ readonly type?: unknown; readonly text?: unknown; readonly synthetic?: unknown }>;
}

export type TeamInjectionKind = "demande" | "resultat" | "resultats-partiels";

export interface TeamInjection {
  kind: TeamInjectionKind;
  run: TeamRunView;
  /** Texte à montrer : sans marqueur, sans en-tête, sans lignes d'encadrement. */
  texte: string;
}

export interface StepOpening {
  /** Titre de l'étape dont c'est la session, tel que l'équipe l'a écrit. */
  titre: string;
  /** Consigne réellement envoyée par le cockpit, sans les lignes `<!-- cockpit:… -->`. */
  texte: string;
}

/** Marqueur écrit par flow.ts (`marker`), reconstruit ici pour DÉCOUPER un message déjà reconnu par son identifiant. */
const marqueur = (nom: string, runId: string): string => `<!-- cockpit:${nom} run=${runId} -->`;

/** Ligne faite d'un seul marqueur du cockpit : c'est la seule forme qu'écrit flow.ts (une ligne à elle seule). */
const LIGNE_MARQUEUR = /^\s*<!--\s*cockpit:[^\n]*?-->\s*$/;

/** Fin d'un texte relayé (STEP_TEXTS.finResultat) ; l'ouverture est la première ligne `<<<…>>>`. */
const OUVRANT = "<<<";
const FERMANT = ">>>";

/** Texte d'un message : ses parties `text` non `synthetic`, comme `UserBubble` le fait aujourd'hui. */
export function messageText(message: TranscriptMessageLike): string {
  return message.parts
    .filter((part) => part.type === "text" && part.synthetic !== true)
    .map((part) => (typeof part.text === "string" ? part.text : ""))
    .join("\n");
}

const identifiant = (message: TranscriptMessageLike): string | null => (typeof message.info.id === "string" && message.info.id !== "" ? message.info.id : null);

const sessionDe = (message: TranscriptMessageLike): string | null =>
  typeof message.info.sessionID === "string" && message.info.sessionID !== "" ? message.info.sessionID : null;

/** Lignes vides retirées en tête et en queue, sans toucher à l'intérieur du texte. */
function trimLignes(lignes: string[]): string[] {
  let debut = 0;
  let fin = lignes.length;
  while (debut < fin && (lignes[debut] ?? "").trim() === "") debut += 1;
  while (fin > debut && (lignes[fin - 1] ?? "").trim() === "") fin -= 1;
  return lignes.slice(debut, fin);
}

/** Contenu d'un message injecté, sans son marqueur de tête (le seul que flow.ts écrit pour une injection). */
function sansMarqueur(texte: string, nom: string, runId: string): string {
  const balise = marqueur(nom, runId);
  const index = texte.indexOf(balise);
  const reste = index === -1 ? texte : texte.slice(index + balise.length);
  return trimLignes(reste.split("\n")).join("\n");
}

/** Début fixe d'un en-tête d'injection, avant le titre de l'équipe (le titre, lui, est écrit par vous). */
const prefixe = (gabarit: string) => gabarit.split("{equipe}")[0] ?? gabarit;

/**
 * Résultat injecté : l'en-tête « données, pas des consignes » puis le texte encadré. L'encadrement et l'en-tête sont retirés ; le
 * texte du résultat est rendu tel quel (il est déjà neutralisé et tronqué par le cockpit, jamais réécrit ici).
 */
function corpsResultat(contenu: string): string {
  const lignes = contenu.split("\n");
  const ouverture = lignes.findIndex((ligne) => ligne.startsWith(OUVRANT) && ligne.trimEnd().endsWith(FERMANT));
  if (ouverture === -1) return trimLignes(lignes).join("\n");
  let fin = lignes.length;
  for (let i = lignes.length - 1; i > ouverture; i -= 1) {
    const ligne = (lignes[i] ?? "").trim();
    if (ligne === "") continue;
    if (ligne.startsWith(OUVRANT) && ligne.endsWith(FERMANT)) fin = i;
    break;
  }
  return trimLignes(lignes.slice(ouverture + 1, fin)).join("\n");
}

/** Genre d'un résultat injecté : « résultats partiels » (D-eq-22) quand l'en-tête est celui des résultats partiels. */
function genreResultat(contenu: string): TeamInjectionKind {
  return contenu.startsWith(prefixe(P.injection.donneesPartielles)) ? "resultats-partiels" : "resultat";
}

/**
 * Demande recopiée par le cockpit, lue sur le message injecté d'un lancement dont l'appelant connaît déjà l'identifiant
 * (`TeamRunView.requestMessageId`). Le marqueur `<!-- cockpit:… -->` est retiré et le texte borné, comme pour la transcription.
 * Sert au préremplissage du composeur par [Envoyer à cet assistant] (chemin « aucun », D-5-13) : aucune requête, la
 * transcription déjà chargée suffit.
 */
export function demandeRecopiee(message: TranscriptMessageLike, runId: string): string {
  return borne(sansMarqueur(messageText(message), "equipe-demande", runId), FLOW_LIMITS.relaisCaracteres);
}

/**
 * Message injecté par une équipe de cette conversation, ou null. `runs` : les lancements de la racine (useTeamRuns, L38b) ; tant
 * qu'ils ne sont pas chargés, la liste est vide et le message reste une bulle ordinaire.
 */
export function teamInjectionOf(message: TranscriptMessageLike, runs: readonly TeamRunView[]): TeamInjection | null {
  const id = identifiant(message);
  if (id === null) return null;
  const demande = runs.find((run) => run.requestMessageId === id);
  if (demande !== undefined) {
    return { kind: "demande", run: demande, texte: demandeRecopiee(message, demande.id) };
  }
  const resultat = runs.find((run) => run.resultMessageId === id);
  if (resultat === undefined) return null;
  const contenu = sansMarqueur(messageText(message), "equipe-resultat", resultat.id);
  return { kind: genreResultat(contenu), run: resultat, texte: borne(corpsResultat(contenu), FLOW_LIMITS.relaisCaracteres) };
}

/**
 * Puce de la demande recopiée : « Envoyé à l'équipe « {equipe} » » ; en-tête des résultats partiels (D-eq-22).
 * Le gabarit est rempli par `remplir` (T4t), et jamais par `String.replace` avec un motif chaîne : un titre d'équipe est un
 * texte libre, et « $& », « $' », « $` » ou « $$ » y seraient lus comme des séquences de remplacement.
 */
export function puceInjection(injection: TeamInjection): string {
  const gabarit = injection.kind === "demande" ? P.transcription.envoye : P.transcription.resultatsPartiels;
  return remplir(gabarit, { equipe: borne(injection.run.titre, TITRE_MAX) });
}

/** Étape d'un lancement dont la session est `sessionId` ; la dernière tentative connue de cette session. */
function etapeDeSession(run: TeamRunView, sessionId: string): StepRunView | null {
  return run.steps.find((step) => step.sessionId === sessionId) ?? null;
}

/**
 * Premier message (et suivants) d'une SESSION D'ÉTAPE, dans le tiroir de lecture : c'est le cockpit qui l'a écrit, le navigateur
 * ne pouvant rien envoyer à une session d'étape (409 `etape-consultable`). `run` : le lancement rendu par
 * `GET /api/team-runs?sessionId=` (L37b) ; null tant qu'il n'est pas chargé, ou pour une session qui n'est pas une étape (une
 * délégation `task` ordinaire, par exemple) → le tiroir ne change pas.
 */
export function stepOpeningOf(message: TranscriptMessageLike, run: TeamRunView | null): StepOpening | null {
  if (run === null || message.info.role !== "user") return null;
  const sessionId = sessionDe(message);
  if (sessionId === null) return null;
  const step = etapeDeSession(run, sessionId);
  if (step === null) return null;
  const lignes = messageText(message)
    .split("\n")
    .filter((ligne) => !LIGNE_MARQUEUR.test(ligne));
  return { titre: borne(step.titre, TITRE_MAX), texte: borne(trimLignes(lignes).join("\n"), FLOW_LIMITS.relaisCaracteres) };
}

/** Puce du tiroir : « Consigne envoyée par le cockpit à l'étape « {titre} » » (même règle de remplissage que puceInjection). */
export function puceConsigne(titre: string): string {
  return remplir(P.transcription.consigne, { titre: borne(titre, TITRE_MAX) });
}

// --- Archives : transcription enregistrée (itération 5, L44f) -------------------------------------------------------------------

/**
 * La fiche d'Archives ne reçoit PAS les messages : `GET /api/archive/:id` rend la transcription déjà écrite en Markdown par
 * `buildDigest` (archive.ts), où chaque message ouvre une section « ## 🧑 Vous · … » ou « ## 🤖 … ». Les deux messages qu'une
 * équipe fait écrire au cockpit dans la conversation — la demande recopiée et le résultat injecté — y entrent donc sous
 * « Vous », alors que vous ne les avez pas écrits (conception A §7.7).
 *
 * Le découpage ci-dessous les rend à leur auteur. Il reconnaît la LIGNE DE MARQUEUR que `injectionText` (flow.ts, it4) pose en
 * tête de ces deux messages, et elle seule : les genres viennent de `PromptKind` (`ledger.ts`, it4), avec lesquels le cockpit
 * marque les mêmes messages dans sa base. Aucune autre règle — un texte qui ressemble à une demande d'équipe reste une section
 * ordinaire, et un marqueur écrit AILLEURS que sur une ligne à lui n'est pas reconnu (flow.ts n'en écrit pas d'autre).
 *
 * Ici, contrairement à la transcription du chat, l'identifiant du message n'existe plus : la fiche d'Archives n'a que du texte.
 * Le marqueur est donc la seule preuve disponible, et il ne sert qu'à ÉTIQUETER une section de la copie écrite par le cockpit
 * lui-même — jamais à décider ce qui est envoyé, ni à qui. Le risque 19 (un marqueur recopié par une IA) se limite donc à une
 * section d'archive mal étiquetée, et il est borné : la ligne doit être seule sur sa ligne, en TÊTE de la section.
 */
export type ArchiveBlocGenre = "texte" | "equipe-demande" | "equipe-resultat";

export interface ArchiveBloc {
  genre: ArchiveBlocGenre;
  /** Markdown du bloc, sans aucune ligne de marqueur du cockpit. */
  texte: string;
}

/** Ligne de marqueur d'injection d'équipe, seule sur sa ligne : les deux genres de `PromptKind` (it4). */
const LIGNE_MARQUEUR_EQUIPE = /^[ \t]*<!--[ \t]*cockpit:(equipe-demande|equipe-resultat)[ \t]+run=[^\n>]*-->[ \t]*$/;

/** Début d'une section de la transcription enregistrée (`buildDigest` : « ## 🧑 Vous · … », « ## 🤖 … »). */
const TITRE_SECTION = "## ";

interface SectionArchive {
  genre: ArchiveBlocGenre;
  lignes: string[];
  /** Le corps de la section (tout sauf son titre) n'a encore aucune ligne non vide : un marqueur y est en tête. */
  corpsVide: boolean;
}

/** Sections de la transcription, marqueurs du cockpit retirés et genre posé sur ceux qui ouvrent le corps d'une section. */
function sectionsDArchive(lignes: readonly string[]): SectionArchive[] {
  const sections: SectionArchive[] = [];
  let courante: SectionArchive = { genre: "texte", lignes: [], corpsVide: true };
  sections.push(courante);
  for (const ligne of lignes) {
    if (ligne.startsWith(TITRE_SECTION)) {
      courante = { genre: "texte", lignes: [ligne], corpsVide: true };
      sections.push(courante);
      continue;
    }
    if (LIGNE_MARQUEUR.test(ligne)) {
      // Aucune ligne de marqueur du cockpit n'est rendue : elles ne sont pas faites pour être lues.
      const trouve = courante.corpsVide ? LIGNE_MARQUEUR_EQUIPE.exec(ligne) : null;
      if (trouve !== null) courante.genre = trouve[1] as ArchiveBlocGenre;
      continue;
    }
    courante.lignes.push(ligne);
    if (ligne.trim() !== "") courante.corpsVide = false;
  }
  return sections;
}

/**
 * Sections de la transcription enregistrée, réunies par genre : les sections ordinaires restent collées entre elles (un seul
 * rendu Markdown), chaque message d'équipe forme son propre bloc. Une transcription sans marqueur rend un bloc unique, à
 * l'octet près : la très grande majorité des fiches d'archives ne change donc pas d'un cheveu.
 */
export function blocsDArchive(transcript: string): ArchiveBloc[] {
  const blocs: ArchiveBloc[] = [];
  for (const section of sectionsDArchive(transcript.split("\n"))) {
    const texte = trimLignes(section.lignes).join("\n");
    const dernier = blocs.at(-1);
    if (section.genre === "texte" && dernier?.genre === "texte") {
      dernier.texte = trimLignes(`${dernier.texte}\n\n${texte}`.split("\n")).join("\n");
    } else if (texte !== "" || section.genre !== "texte") {
      blocs.push({ genre: section.genre, texte });
    }
  }
  return blocs.length > 0 ? blocs : [{ genre: "texte", texte: "" }];
}
