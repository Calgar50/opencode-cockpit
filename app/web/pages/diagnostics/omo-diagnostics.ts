// Propriétaire : L26b.
// Lignes du « Diagnostic OMO » et raisons d'attente de la salle, calculées À PARTIR D'UNE RÉPONSE `OmoStatusResponse` (T3a) :
// module pur, sans React, sans horloge et sans appel réseau. OmoDiagnostics.tsx ne fait que les afficher, et la page Diagnostic
// reçoit l'état par PROPRIÉTÉS (plan d'exécution 2 bis-2 ter §6, fiche L26b ; §2.9 : `web/lib/api-omo.ts` appartient à L26a, de
// la même vague, donc `getOmoStatus()` est branché par l'intégrateur au train de V2).
// Spécification §4.12 l.784, §4.10 l.759, §5.4 l.915, §3.15.2 l.521, §7.6 l.1159.
// Phrases : server/shared/omo-room-texts.ts (T3a), jamais réécrites ici ; les gabarits {liste} et {projet} sont remplis par
// `remplir`, et {liste} est rendue par une vraie liste sous la phrase, jamais collée dedans.
// Honnêteté (P3) : rien n'est deviné. L'authentification de la salle n'est décrite que par sa PRÉSENCE, jamais par son contenu ;
// les chemins restent relatifs à `/workspace` (jamais un chemin de votre PC) ; un balayage non publié est dit non publié.
// A16 (4) du 22/09 : le Diagnostic est l'un des deux canaux qui doivent dire POURQUOI la salle attend. `raisonsAttente` n'est
// donc pas facultative, et la section des `.git` non protégés porte la phrase de omo-room-texts.ts avec sa liste masquée.
import { phrasePrecontrole, TEXTES } from "../../../server/shared/omo-room-texts.ts";
import type { OmoEtatSalle, OmoProjectGitState, OmoStatusResponse } from "../../../server/shared/omo-types.ts";

const T = TEXTES.avance;

export type TonOmo = "good" | "warning" | "critical" | "neutral";

/** Ligne du Diagnostic OMO : un libellé, une valeur, une précision, et la liste masquée des chemins qui la justifient. */
export interface LigneOmo {
  cle: string;
  label: string;
  /** Valeur à droite du libellé ; chaîne vide : aucune. */
  valeur: string;
  /** Précision sous la ligne ; chaîne vide : aucune. */
  indice: string;
  ton: TonOmo;
  /** Chemins relatifs à `/workspace`, montrés sous la ligne. */
  chemins: readonly string[];
}

/** Raison lisible de l'attente de la salle (A16 point 4) : une phrase du module de textes, et ses chemins. */
export interface RaisonAttente {
  cle: string;
  phrase: string;
  chemins: readonly string[];
}

/** Résultat du pré-contrôle d'un projet du dernier démarrage (§3.15.2). */
export interface LignePrecontrole {
  projet: string;
  verdict: "conforme" | "refuse";
  /** Chaîne vide quand le projet est conforme. */
  phrase: string;
  chemins: readonly string[];
}

/** Mise en forme passée par l'appelant : le module reste pur et ses sorties restent comparables dans un test. */
export interface FormatsOmo {
  dateHeure(ms: number): string;
  duree(ms: number): string;
}

/** Remplit les gabarits {nom} d'une phrase de omo-room-texts.ts ; un gabarit sans valeur reste tel quel. */
function remplir(phrase: string, valeurs: Readonly<Record<string, string>>): string {
  return phrase.replace(/\{(\w+)\}/g, (entier: string, nom: string) => valeurs[nom] ?? entier).trim();
}

/** Phrase dont la liste masquée est rendue à part : le gabarit {liste} disparaît, la liste est portée par `chemins`. */
const sansListe = (phrase: string): string => remplir(phrase, { liste: "" });

const TON_ETAT: Readonly<Record<OmoEtatSalle, TonOmo>> = {
  coupee: "neutral",
  arretee: "neutral",
  "en-relance": "warning",
  prete: "good",
  "demande-active": "good",
  suspendue: "critical",
};

const TON_GIT: Readonly<Record<OmoProjectGitState, TonOmo>> = {
  "lecture-seule": "good",
  inscriptible: "critical",
  absent: "neutral",
  inconnu: "warning",
};

/** §5.4 l.915 : sans image chargée, la Salle Oh My OpenAgent n'est pas installée sur ce poste. */
export function salleInstallee(statut: OmoStatusResponse): boolean {
  return statut.image.chargee;
}

/**
 * Raisons de l'attente de la salle, dans l'ordre où elles se lisent (A16 point 4, arbitrage L21 n° 2) : chacune est une phrase
 * de omo-room-texts.ts, et aucune n'est inventée. Liste vide : rien n'empêche la salle de travailler.
 */
export function raisonsAttente(statut: OmoStatusResponse): RaisonAttente[] {
  const raisons: RaisonAttente[] = [];
  const pousser = (cle: string, phrase: string, chemins: readonly string[] = []) => raisons.push({ cle, phrase, chemins });

  if (!statut.image.chargee) pousser("non-installee", T.nonInstallee);
  if (!statut.interrupteurs.omo || !statut.interrupteurs.salleOuverte) pousser("salle-coupee", T.refus["salle-coupee"]);
  if (!statut.interrupteurs.autonomie) pousser("autonomie-coupee", T.refus["autonomie-coupee"]);
  if (statut.etatSalle === "suspendue") pousser("salle-suspendue", T.refus["salle-suspendue"]);
  if (statut.etatSalle === "en-relance") pousser("salle-en-relance", T.refus["salle-en-relance"]);

  const git = statut.workspaceGit;
  if (git === null) pousser("workspace-non-verifie", sansListe(T.refus["workspace-non-verifie"]));
  else if (git.limiteAtteinte) pousser("limite-atteinte", T.diagnostic.limiteAtteinte);
  else if (git.nonProteges.length > 0) pousser("workspace-non-verifie", sansListe(T.refus["workspace-non-verifie"]), git.nonProteges);

  const inscriptibles = statut.projetsPrepares.filter((projet) => projet.git === "inscriptible").map((projet) => projet.chemin);
  if (inscriptibles.length > 0) pousser("git-inscriptible", sansListe(T.refus["git-inscriptible"]), inscriptibles);

  if (!statut.battement.actif) pousser("battement-absent", T.refus["battement-absent"]);

  for (const projet of statut.dernierDemarrage?.precheck ?? []) {
    if (projet.verdict !== "refuse") continue;
    const refus = remplir(T.refus["precheck-refuse"], { projet: projet.projet });
    const raison = projet.raison === null ? refus : `${refus} ${phrasePrecontrole(projet.raison)}`;
    pousser(`precheck:${projet.projet}`, raison, projet.trouves);
  }
  return raisons;
}

/** Résultat du pré-contrôle du dernier démarrage, projet par projet ; liste vide quand aucun démarrage n'a eu lieu. */
export function lignesPrecontrole(statut: OmoStatusResponse): LignePrecontrole[] {
  return (statut.dernierDemarrage?.precheck ?? []).map((projet) => ({
    projet: projet.projet,
    verdict: projet.verdict,
    phrase: projet.verdict === "conforme" || projet.raison === null ? "" : phrasePrecontrole(projet.raison),
    chemins: projet.trouves,
  }));
}

/**
 * Lignes du Diagnostic OMO, dans l'ordre d'affichage : état de la salle, image (identifiant, manifeste, version, date d'audit),
 * dernier démarrage, liste blanche de sortie, projets préparés et état de leur `.git`, `.git` non protégés du dossier de travail,
 * authentification de la salle (présence seulement), battement du cockpit, emplacement du tableau « sans demande ».
 */
export function lignesDiagnosticOmo(statut: OmoStatusResponse, formats: FormatsOmo): LigneOmo[] {
  const lignes: LigneOmo[] = [];
  const ligne = (cle: string, label: string, valeur: string, indice: string, ton: TonOmo, chemins: readonly string[] = []) =>
    lignes.push({ cle, label, valeur, indice, ton, chemins });

  ligne("etat", "État de la salle", T.etats[statut.etatSalle], "", TON_ETAT[statut.etatSalle]);

  const image = statut.image;
  ligne("image", "Image de la salle", image.chargee ? "chargée" : "absente", image.id ?? "", image.chargee ? "good" : "warning");
  ligne("manifeste", "Manifeste de l'image (SHA-256)", image.manifesteSha256 ?? "inconnu", "", image.manifesteSha256 === null ? "warning" : "neutral");
  ligne(
    "version",
    "Extension dans l'image",
    image.version ?? "inconnue",
    image.auditeLe === null ? "" : `Auditée le ${image.auditeLe}.`,
    image.version === null ? "warning" : "neutral",
  );

  const demarrage = statut.dernierDemarrage;
  ligne(
    "demarrage",
    "Dernier démarrage",
    demarrage === null ? "aucun" : formats.dateHeure(demarrage.at),
    demarrage === null ? "" : demarrage.startId,
    "neutral",
  );

  ligne(
    "liste-blanche",
    "Liste blanche de sortie",
    statut.listeBlanche.length === 0 ? "aucun hôte autorisé" : statut.listeBlanche.join(" · "),
    "Le proxy de sortie n'ouvre que ces hôtes, sur le port 443.",
    statut.listeBlanche.length === 0 ? "warning" : "neutral",
  );

  ligne(
    "projets",
    "Projets préparés",
    String(statut.projetsPrepares.length),
    statut.projetsPrepares.length === 0 ? T.precontrole["non-prepare"] : "",
    statut.projetsPrepares.length === 0 ? "warning" : "neutral",
  );
  for (const projet of statut.projetsPrepares) ligne(`projet:${projet.chemin}`, projet.chemin, T.git[projet.git], "", TON_GIT[projet.git]);

  const git = statut.workspaceGit;
  const balayage = git === null ? "" : `Dernier balayage : ${formats.dateHeure(git.verifieLe)}.`;
  if (git === null) {
    ligne("workspace-git", "Historiques git du dossier de travail", "balayage non publié", sansListe(T.refus["workspace-non-verifie"]), "warning");
  } else if (git.limiteAtteinte) {
    ligne("workspace-git", T.diagnostic.limiteAtteinte, "", balayage, "critical");
  } else if (git.nonProteges.length > 0) {
    ligne("workspace-git", sansListe(T.refus["workspace-non-verifie"]), String(git.nonProteges.length), balayage, "critical", git.nonProteges);
  } else {
    ligne("workspace-git", "Historiques git du dossier de travail", "aucun non protégé au dernier balayage", balayage, "good");
  }

  ligne(
    "auth",
    statut.authSalle.presente ? T.diagnostic.authPresente : T.diagnostic.authAbsente,
    "",
    "Le cockpit n'en montre jamais le contenu.",
    statut.authSalle.presente ? "good" : "warning",
  );

  const battement = statut.battement;
  ligne(
    "battement",
    battement.actif ? T.diagnostic.battementActif : T.diagnostic.battementAbsent,
    battement.ageMs === null ? "" : formats.duree(battement.ageMs),
    "",
    battement.actif ? "good" : "critical",
  );

  ligne(
    "sans-demande",
    T.activation.boutons.sansDemande,
    "",
    "Ce tableau est montré à l'ouverture de la Salle OMO et sur l'écran d'activation.",
    "neutral",
  );
  return lignes;
}
