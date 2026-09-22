// Propriétaire : L26a.
// Modèle PUR de ce que la page de la Salle OMO montre (spécification §4.8.2 l.722, l.729-730 ; §4.12 l.784 ; §4.13 l.802 ;
// §4.14.1 l.806-811 ; §4.14.6 l.854-868 ; §5.6 l.928 ; JS-12 ; JP-10 ; plan d'exécution 2 bis-2 ter, fiche L26a, D-2b-30,
// D-2b-37, D-2b-38, D-2b-45 ; arbitrage A16 point 4 du 22/09) : écran d'activation (champ de plafond, erreur, conditions),
// bandeau permanent, état de la salle avec la RAISON de son attente, résultat du pré-contrôle et fichiers signalés.
//
// Les composants de web/pages/omo/** restent minces : ils rendent ce que ce module décide ; ils n'ont ni condition ni phrase à
// eux. AUCUN texte n'est écrit ici : toutes les phrases viennent de omo-room-texts.ts (T3a), gabarits remplis tels quels ; les
// seules chaînes de ce module sont des codes, des séparateurs et le tiret d'un montant illisible (« — », autonomy-texts.ts).
//
// Honnêteté (P3) : aucune phrase n'est réécrite ni complétée ici, aucun geste n'est promis. La raison d'une attente git vient de
// `refus["git-inscriptible"]` — balayage de la salle, aucun geste promis — et jamais de `refus["workspace-non-verifie"]`, qui
// propose `install.ps1` pour des dépôts que le cockpit sait ajoutés après l'installation.
//
// Aucune valeur de plafond de coût (Q7) : la borne et le dernier montant viennent de `OmoActivationView` ; le champ est vide la
// première fois. La validation du montant est celle du serveur (omo-cap.ts), rejouée ici pour annoncer l'erreur près du champ ;
// le serveur reste seul juge (§4.8.2 : « jamais seulement par le navigateur »).
// Module pur (server/shared).
import { CLES } from "./omo-audit-4.19.4.ts";
import { proposePlafond, validatePlafond } from "./omo-cap.ts";
import { PRECHECK_BORNES } from "./omo-precheck-rules.ts";
import { phrasePrecontrole, phraseRefusActivation, TEXTES } from "./omo-room-texts.ts";
import type {
  BootstrapOmo,
  OmoActivationRefusalCode,
  OmoActivationView,
  OmoEtatSalle,
  OmoPrecheckProjectResult,
  OmoSignale,
  OmoStatusResponse,
} from "./omo-types.ts";

/** Séparateur des chemins d'une liste masquée remise à un gabarit {liste}. */
export const SEPARATEUR_LISTE = ", ";

/** Montant illisible : le tiret de autonomy-texts.ts (`montantInconnu`), jamais un zéro inventé. */
const MONTANT_INCONNU = "—";

/** Remplit un gabarit « {nom} » ; un nom absent des valeurs garde son gabarit, pour qu'un oubli se voie. */
function remplir(gabarit: string, valeurs: Readonly<Record<string, string>>): string {
  return gabarit.replace(/\{(\w+)\}/g, (marque: string, nom: string) => (Object.hasOwn(valeurs, nom) ? String(valeurs[nom]) : marque));
}

/**
 * Montant en dollars, deux décimales, virgule décimale (gabarit {x} du bandeau) ; « — » si le nombre est inconnu ou illisible.
 * Un montant qu'on ne connaît pas ne devient JAMAIS zéro : le cockpit ne promet pas un coût (P3).
 */
export function montantAffiche(usd: number | null): string {
  if (typeof usd !== "number" || !Number.isFinite(usd) || usd < 0) return MONTANT_INCONNU;
  return (Math.round(usd * 100) / 100).toFixed(2).replace(".", ",");
}

/** Montant SAISI, rendu tel qu'il a été tapé, virgule décimale (gabarit {montant}) ; « — » s'il n'est plus lisible. */
export function montantSaisiAffiche(saisie: string | null): string {
  if (typeof saisie !== "string" || saisie.trim() === "") return MONTANT_INCONNU;
  return saisie.replace(".", ",");
}

/** Phrase d'un refus d'activation, gabarits remplis ({projet}, {plafondMaxUsd}, {liste}). */
export function phraseRefus(code: OmoActivationRefusalCode, valeurs: Readonly<Record<string, string>> = {}): string {
  return remplir(phraseRefusActivation(code), valeurs);
}

// --- Variante Prometheus de l'écran d'activation (§4.14.6, G12) ------------------------------------------------------------------

/**
 * Vrai seulement si `omo.jsonc` laisse le planificateur (Prometheus) avec `edit: "allow"` : la phrase « modifie des fichiers sans
 * demande » est alors vraie. Lu dans l'audit de la 4.19.4 (L20), jamais écrit à la main : la clé `agents` y épingle la permission
 * réellement posée. Toute autre valeur, ou une clé illisible, donne la variante « contrôle des interdits du cockpit ».
 */
export function planificateurSansDemande(): boolean {
  const agents = CLES.find((c) => c.cle === "agents")?.valeur;
  if (typeof agents !== "object" || agents === null) return false;
  const prometheus = (agents as Record<string, unknown>).prometheus;
  if (typeof prometheus !== "object" || prometheus === null) return false;
  const permission = (prometheus as Record<string, unknown>).permission;
  if (typeof permission !== "object" || permission === null) return false;
  return (permission as Record<string, unknown>).edit === "allow";
}

// --- Écran d'activation (§4.14.6, JS-12) ------------------------------------------------------------------------------------------

export interface ActivationEntree {
  /** Vue rendue par le port d'activation (T3a) : projet, dernier montant, borne, conditions. */
  vue: OmoActivationView;
  /** Texte du champ tel que l'utilisateur l'a tapé ; null : champ jamais touché (valeur proposée). */
  saisie: string | null;
  /** [Lancer comme Oh My OpenAgent] a été pressé au moins une fois : l'erreur du champ est annoncée. */
  tentee: boolean;
  /** Date d'audit de l'extension (gabarit {date}) ; chaîne vide : le gabarit reste visible. */
  dateAudit: string;
  /**
   * Valeurs de gabarit que seule la page connaît, pour les phrases des conditions : {liste} des historiques git non protégés.
   * {projet} et {plafondMaxUsd} sont remplis d'office ; un gabarit sans valeur reste visible, pour qu'un oubli se voie.
   */
  valeurs?: Readonly<Record<string, string>>;
}

export interface ChampPlafond {
  libelle: string;
  unite: string;
  borne: string;
  aide: string;
  /** Valeur affichée dans le champ : vide la première fois, dernier montant ensuite (§4.8.2 l.722, l.730). */
  valeur: string;
  /** Le montant proposé dépasse la borne en vigueur : proposé tel quel, marqué hors bornes, jamais remplacé. */
  horsBornes: boolean;
  /** `aria-invalid` du champ. */
  invalide: boolean;
}

export interface VueActivation {
  titre: string;
  /** Phrases d'honnêteté de l'écran, dans l'ordre du §4.14.6 (variante Prometheus comprise). */
  phrases: string[];
  champ: ChampPlafond;
  /** Erreur annoncée près du champ (`role="alert"`) ; null quand rien n'est à dire. */
  erreur: { code: OmoActivationRefusalCode; phrase: string } | null;
  /** Conditions du §4.14.2 qui ne sont PAS remplies, avec leur phrase : le lancement est refusé tant qu'il en reste une. */
  conditions: { code: OmoActivationRefusalCode; phrase: string }[];
  boutons: { lancer: string; annuler: string; sansDemande: string };
  lancerPossible: boolean;
}

/** Décision du garde-fou budgétaire, lue dans les conditions du port : `budget-mensuel` faux = refus. */
function guardRunsDe(vue: OmoActivationView): "ok" | "refus" {
  const condition = vue.conditions.find((c) => c.code === "budget-mensuel");
  return condition !== undefined && !condition.ok ? "refus" : "ok";
}

/**
 * Écran d'activation, à chaque demande (§4.14.6). Le champ est vide la première fois, prérempli du dernier montant ensuite ; la
 * borne est affichée ; le montant est vérifié comme le serveur le vérifie (omo-cap.ts) et son refus est annoncé près du champ.
 */
export function vueActivation(entree: ActivationEntree): VueActivation {
  const { activation } = TEXTES.avance;
  const { vue, saisie, tentee, dateAudit, valeurs = {} } = entree;
  const propose = proposePlafond(vue.dernierPlafondUsd, vue.plafondMaxUsd);
  const valeur = saisie ?? propose.valeur;
  const validation = validatePlafond(valeur, { plafondMaxUsd: vue.plafondMaxUsd, guardRuns: guardRunsDe(vue) });
  const horsBornes = saisie === null ? propose.horsBornes : !validation.ok && validation.code === "plafond-hors-bornes";
  // Erreur annoncée : dès qu'un montant est saisi ou proposé hors bornes, et à chaque tentative de lancement.
  const annoncer = !validation.ok && (tentee || horsBornes || (saisie !== null && saisie.trim() !== ""));
  const bornes = { plafondMaxUsd: montantAffiche(vue.plafondMaxUsd) };
  const conditions = vue.conditions
    .filter((c) => !c.ok)
    .map((c) => ({ code: c.code, phrase: phraseRefus(c.code, { ...bornes, projet: vue.projet, ...valeurs }) }));
  const planificateur = planificateurSansDemande() ? activation.planificateurSansDemande : activation.planificateurControle;
  return {
    titre: activation.titre,
    phrases: [
      remplir(activation.extension, { date: dateAudit }),
      remplir(activation.autorise, { projet: vue.projet }),
      activation.refuse,
      activation.reseau,
      planificateur,
      activation.programme,
      activation.fichiersExecutes,
      activation.arreter,
      activation.sansDemande,
    ],
    champ: {
      libelle: activation.champ.libelle,
      unite: activation.champ.unite,
      borne: remplir(activation.champ.borne, bornes),
      aide: activation.champ.aide,
      valeur,
      horsBornes,
      invalide: annoncer,
    },
    erreur: annoncer && !validation.ok ? { code: validation.code, phrase: phraseRefus(validation.code, bornes) } : null,
    conditions,
    boutons: { ...activation.boutons },
    lancerPossible: validation.ok && conditions.length === 0 && !vue.demandeActive,
  };
}

// --- Bandeau permanent de la salle (§4.12 l.784, D-2b-45) ---------------------------------------------------------------------

export interface BandeauEntree {
  /** Dépense de la demande en cours, en dollars ; null : pas encore connue (le bandeau affiche « — », jamais 0,00). */
  depenseUsd: number | null;
  /** Montant d'arrêt saisi à l'activation, tel quel ; null : aucune demande confirmée. */
  plafondSaisi: string | null;
  /** Une demande de la salle est en cours : le bandeau n'apparaît pas sans elle. */
  demandeActive: boolean;
}

export interface VueBandeau {
  texte: string;
  arreter: string;
  journal: string;
}

/** Bandeau « Salle OMO · extension active · … · {x} $ sur {montant} $ » [Arrêter] [Journal] ; null hors demande. */
export function vueBandeau(entree: BandeauEntree): VueBandeau | null {
  if (!entree.demandeActive) return null;
  const { bandeau } = TEXTES.avance;
  return {
    texte: remplir(bandeau.texte, { x: montantAffiche(entree.depenseUsd), montant: montantSaisiAffiche(entree.plafondSaisi) }),
    arreter: bandeau.arreter,
    journal: bandeau.journal,
  };
}

/** Annonce polie du bandeau : seulement une TRANSITION (le texte a changé), jamais ce qu'une première lecture révèle. */
export function annonceBandeau(precedent: VueBandeau | null, suivant: VueBandeau | null): string | null {
  if (suivant === null || precedent === null) return null;
  return precedent.texte === suivant.texte ? null : suivant.texte;
}

// --- Tableau « sans demande » (§6, tableau d'honnêteté) ---------------------------------------------------------------------------

export interface SansDemandeEntree {
  /** Montant d'arrêt saisi, tel quel ; null : aucune demande confirmée (le gabarit reçoit « — »). */
  plafondSaisi: string | null;
  /** Date d'audit de l'extension (gabarit {date}). */
  dateAudit: string;
}

/**
 * Lignes du tableau « sans demande » (§6), dans l'ordre : ce que l'extension enchaîne seule, le planificateur, le réseau, les
 * interdits absolus, le coût constaté après coup, la relance à neuf, l'homme mort, la version auditée. Formulations DISTINCTES
 * de celles de l'écran d'activation : ce sont celles de `honnetete`, jamais celles d'`activation`.
 */
export function vueSansDemande(entree: SansDemandeEntree): string[] {
  const { honnetete } = TEXTES.avance;
  return [
    honnetete.delegue,
    planificateurSansDemande() ? honnetete.planificateurSansDemande : honnetete.planificateurControle,
    honnetete.reseauFerme,
    honnetete.interditsAbsolus,
    remplir(honnetete.coutApresCoup, { montant: montantSaisiAffiche(entree.plafondSaisi) }),
    honnetete.arreterRelance,
    honnetete.hommeMort,
    remplir(honnetete.version, { date: entree.dateAudit }),
  ];
}

// --- État de la salle et RAISON de son attente (A16 point 4, arbitrage L21 n° 2) --------------------------------------------------

/** Aucune image de la salle n'est chargée : état hors de l'union `OmoEtatSalle`, avec sa propre phrase (§5.4 l.915). */
export const ETAT_NON_INSTALLEE = "non-installee";

export type CodeEtatSalle = OmoEtatSalle | typeof ETAT_NON_INSTALLEE;

export interface EtatSalleEntree {
  /**
   * Champ `omo` de /api/bootstrap : le canal qui marche quand la salle est coupée. GET /api/omo/status répond alors 403
   * « salle-coupee » — ce n'est pas une erreur technique à montrer (A16 point 4 b) : l'état vient d'ici.
   */
  boot: BootstrapOmo | null;
  /** Réponse de GET /api/omo/status ; null : route refusée (403 salle-coupee) ou pas encore lue. */
  statut: OmoStatusResponse | null;
}

export interface VueEtatSalle {
  code: CodeEtatSalle;
  libelle: string;
  /** POURQUOI la salle attend, en phrases de T3a ; vide quand il n'y a rien à dire. Aucun geste n'est promis. */
  raisons: string[];
  /** La salle peut recevoir une demande. */
  prete: boolean;
}

/** Chemins non protégés, relevés par le balayage de la salle ET par l'état git des projets préparés, sans doublon. */
export function cheminsNonProteges(statut: OmoStatusResponse): string[] {
  const chemins = new Set<string>();
  for (const chemin of statut.workspaceGit?.nonProteges ?? []) chemins.add(chemin);
  for (const projet of statut.projetsPrepares) if (projet.git === "inscriptible") chemins.add(projet.chemin);
  return [...chemins];
}

/** Interrupteurs et image, lus dans le statut quand il a répondu, sinon dans le Bootstrap (canal qui marche salle coupée). */
function interrupteursDe(entree: EtatSalleEntree): { imageChargee: boolean; omo: boolean; salleOuverte: boolean; autonomie: boolean } {
  const { boot, statut } = entree;
  if (statut === null) {
    return {
      imageChargee: boot?.imageChargee ?? false,
      omo: boot?.enabled ?? false,
      salleOuverte: boot?.salleOuverte ?? false,
      // Le Bootstrap ne porte pas COCKPIT_AUTONOMY pour la salle : rien n'est affirmé sur lui.
      autonomie: true,
    };
  }
  return {
    imageChargee: statut.image.chargee,
    omo: statut.interrupteurs.omo,
    salleOuverte: statut.interrupteurs.salleOuverte,
    autonomie: statut.interrupteurs.autonomie,
  };
}

/** Ce que le statut publié empêche : plafond de balayage, historiques git non protégés, authentification, battement, état. */
function raisonsDuStatut(statut: OmoStatusResponse): string[] {
  const { diagnostic } = TEXTES.avance;
  const raisons: string[] = [];
  if (statut.workspaceGit?.limiteAtteinte === true) raisons.push(diagnostic.limiteAtteinte);
  const chemins = cheminsNonProteges(statut);
  if (chemins.length > 0) raisons.push(phraseRefus("git-inscriptible", { liste: chemins.join(SEPARATEUR_LISTE) }));
  if (!statut.authSalle.presente) raisons.push(diagnostic.authAbsente);
  if (!statut.battement.actif) raisons.push(phraseRefus("battement-absent"));
  if (statut.etatSalle === "suspendue") raisons.push(phraseRefus("salle-suspendue"));
  if (statut.etatSalle === "en-relance") raisons.push(phraseRefus("salle-en-relance"));
  return raisons;
}

/**
 * État de la salle et raison de son attente. La raison est AFFICHÉE, jamais seulement disponible : c'est ce que vérifie le test
 * de croisement de la vague (arbitrage L21 n° 3, point 3). L'ordre part du plus décisif : rien d'installé, salle coupée, puis ce
 * que le balayage du dossier de travail empêche, puis l'état publié. Fermé en cas de doute : sans statut lisible, la salle est
 * dite coupée, jamais prête.
 */
export function vueEtatSalle(entree: EtatSalleEntree): VueEtatSalle {
  const { etats, nonInstallee } = TEXTES.avance;
  const { statut } = entree;
  const { imageChargee, omo, salleOuverte, autonomie } = interrupteursDe(entree);
  const brutes = [
    ...(imageChargee ? [] : [nonInstallee]),
    ...(autonomie ? [] : [phraseRefus("autonomie-coupee")]),
    ...(omo && salleOuverte ? [] : [phraseRefus("salle-coupee")]),
    ...(statut === null ? [phraseRefus("salle-coupee")] : raisonsDuStatut(statut)),
  ];
  const raisons = [...new Set(brutes)];
  if (!imageChargee) return { code: ETAT_NON_INSTALLEE, libelle: nonInstallee, raisons, prete: false };
  const code: OmoEtatSalle = statut === null || !omo || !salleOuverte || !autonomie ? "coupee" : statut.etatSalle;
  return { code, libelle: etats[code], raisons, prete: code === "prete" };
}

/** Annonce polie de l'état : seulement une TRANSITION d'un état à un autre. */
export function annonceEtatSalle(precedent: VueEtatSalle | null, suivant: VueEtatSalle): string | null {
  return precedent === null || precedent.code === suivant.code ? null : suivant.libelle;
}

/**
 * Conditions du §4.14.2 que le STATUT permet de vérifier depuis le navigateur, pour les annoncer avant d'envoyer. Ce n'est
 * jamais une autorisation : le serveur les revérifie toutes à l'activation et refuse 409 sans rien lancer (L22c). Les
 * conditions qu'aucune donnée publiée ne porte — manifeste, image attendue, adresse Copilot, catalogue du compte, jeton
 * consommé — ne sont PAS inventées ici : elles restent au serveur. Sans statut lisible, la salle est dite coupée.
 */
export function conditionsActivation(statut: OmoStatusResponse | null, demandeActive: boolean): { code: OmoActivationRefusalCode; ok: boolean }[] {
  if (statut === null) return [{ code: "salle-coupee", ok: false }];
  return [
    { code: "salle-coupee", ok: statut.interrupteurs.omo && statut.interrupteurs.salleOuverte },
    { code: "autonomie-coupee", ok: statut.interrupteurs.autonomie },
    { code: "git-inscriptible", ok: cheminsNonProteges(statut).length === 0 },
    { code: "battement-absent", ok: statut.battement.actif },
    { code: "demande-active", ok: !demandeActive },
    { code: "salle-suspendue", ok: statut.etatSalle !== "suspendue" },
    { code: "salle-en-relance", ok: statut.etatSalle !== "en-relance" },
  ];
}

// --- Pré-contrôle d'un projet (§4.14.1 l.808, liste masquée) ---------------------------------------------------------------------

export interface VuePrecontrole {
  projet: string;
  conforme: boolean;
  /** Raison du refus, en phrase de T3a ; null quand le projet est conforme. */
  phrase: string | null;
  /** Chemins trouvés, masqués, relatifs au projet. */
  chemins: string[];
  /** La liste rendue par le serveur atteint sa borne : elle est écourtée. */
  ecourtee: boolean;
}

export function vuePrecontrole(resultat: OmoPrecheckProjectResult): VuePrecontrole {
  const chemins = resultat.trouves.slice(0, PRECHECK_BORNES.trouvesMax);
  return {
    projet: resultat.projet,
    conforme: resultat.verdict === "conforme",
    phrase: resultat.raison === null ? null : phrasePrecontrole(resultat.raison),
    chemins,
    ecourtee: resultat.trouves.length >= PRECHECK_BORNES.trouvesMax,
  };
}

// --- Fichiers signalés et quarantaine après une détection (D-2b-37) ---------------------------------------------------------------

export interface GroupeSignale {
  genre: OmoSignale["genre"];
  /** Phrase du genre, gabarit {chemin} rempli pour la quarantaine. */
  phrase: string;
  chemins: string[];
}

/** Ordre d'affichage : la quarantaine d'abord (un historique git mis de côté), puis l'IDE et la CI, puis les programmes. */
const ORDRE_SIGNALES: readonly OmoSignale["genre"][] = ["git-quarantaine", "ide-ci", "programme"];

/** Fichiers signalés groupés par genre, avec leur phrase ; les genres sans fichier sont absents. */
export function vueSignales(signales: readonly OmoSignale[]): GroupeSignale[] {
  const groupes: GroupeSignale[] = [];
  for (const genre of ORDRE_SIGNALES) {
    const chemins = signales.filter((s) => s.genre === genre).map((s) => s.chemin);
    if (chemins.length === 0) continue;
    const phrase = TEXTES.avance.signales[genre];
    groupes.push({ genre, phrase: remplir(phrase, { chemin: chemins.join(SEPARATEUR_LISTE) }), chemins });
  }
  return groupes;
}
