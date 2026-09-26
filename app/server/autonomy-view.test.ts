// Tests des cartes d'autonomie et du bandeau (L12b ; spécification §4.3 étapes 6 et 7, §4.4 fin, §4.12, §4.13, §2.3 « États »,
// §5.4, §5.5, §5.6 ; plan d'exécution, fiche L12b). Le modèle pur (server/shared/autonomy-view.ts) porte toute la logique :
// bascule des boutons à 60 s avec une horloge INJECTÉE, états de la carte, compteurs et segments du bandeau, montants, bouton de
// fin de demande, état vide, annonces polies, textes venus d'une IA masqués et bornés à 120 caractères.
// L'interface n'étant pas exécutée par `npm test`, les composants et leur feuille de style sont relus (contrat statique P7 :
// aucun texte recopié, aucune animation, aucune seconde région aria-live, aucun appel non relayé, forced-colors, 400 px).
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import { DEFAULT_SETTINGS } from "./settings.ts";
import { libelleDecision, montant, TEXTES } from "./shared/autonomy-texts.ts";
import type { AutonomyCaps, AutonomyRequestView, RequestEnd } from "./shared/autonomy-types.ts";
import {
  annonceBandeau,
  avecDecision,
  avecExamen,
  type BandeauVue,
  bandeauVue,
  carteVue,
  type DecisionEvenement,
  demandeApresEvenement,
  type DemandeEvenementLu,
  type EtatDemande,
  ETATS_MAX,
  ETATS_VIDES,
  EXAMEN_BOUTONS_MS,
  examenEnCours,
  ICONES_VERDICT,
  phraseFinDemande,
  prochaineBascule,
  relirePourEvenement,
  sansDemande,
  SEPARATEUR,
  SUIVI_VIDE,
  type SuiviBandeau,
  suiviApresEvenement,
  suiviApresRelecture,
  TEXTE_IA_MAX,
  texteAffichable,
  vueEtats,
} from "./shared/autonomy-view.ts";

const APP_DIR = path.join(import.meta.dirname, "..");
const read = (rel: string) => fs.readFileSync(path.join(APP_DIR, rel), "utf8");

/**
 * Source sans ses commentaires (TS, TSX et CSS), lue de gauche à droite : un contrat statique porte sur le CODE, jamais sur ce
 * que les commentaires citent (ils nomment justement les textes et les règles de la spécification).
 */
function sansCommentaires(texte: string): string {
  let out = "";
  for (let i = 0; i < texte.length; ) {
    if (texte.startsWith("//", i)) {
      const fin = texte.indexOf("\n", i);
      i = fin === -1 ? texte.length : fin;
    } else if (texte.startsWith("/*", i)) {
      const fin = texte.indexOf("*/", i + 2);
      i = fin === -1 ? texte.length : fin + 2;
    } else {
      out += texte[i];
      i++;
    }
  }
  return out;
}

/** Code d'un fichier de l'interface ou du modèle, commentaires retirés. */
const code = (rel: string) => sansCommentaires(read(rel));

/**
 * Phrase RECOPIÉE dans un source : écrite entre guillemets ou rendue en texte JSX. Un identifiant qui contient le mot
 * (`onOpenJournal`) n'est pas une recopie : seul un texte affiché en est une.
 */
function recopie(source: string, phrase: string): boolean {
  return new RegExp(`(?:["'\`>])\\s*${phrase.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`).test(source);
}
const MODEL_FILE = "server/shared/autonomy-view.ts";
const CARD_FILE = "web/pages/chat/autonomy/DecisionStatus.tsx";
const BANNER_FILE = "web/pages/chat/autonomy/AutonomyBanner.tsx";
const CSS_FILE = "web/pages/chat/autonomy/autonomy-cards.css";

// --- Doublures --------------------------------------------------------------------------------------------------------------

const CAPS: AutonomyCaps = {
  plafondUsd: 1,
  actionsMax: DEFAULT_SETTINGS.budget.autonomie.actionsMax,
  delegationsMax: DEFAULT_SETTINGS.budget.autonomie.delegationsMax,
  dureeMinutes: DEFAULT_SETTINGS.budget.autonomie.dureeMinutes,
  fichiersMax: DEFAULT_SETTINGS.budget.autonomie.fichiersMax,
  controlesIaMax: DEFAULT_SETTINGS.budget.autonomie.controlesIaMax,
};

function demandeOf(patch: Partial<AutonomyRequestView> = {}): AutonomyRequestView {
  return {
    id: "req_1",
    rootId: "ses_root",
    choix: "autonome",
    plafonds: CAPS,
    startedAt: 1_000,
    endedAt: null,
    spent: 0,
    auto: 0,
    attentes: 0,
    refus: 0,
    controles: 0,
    fichiers: 0,
    delegations: 0,
    fin: null,
    ...patch,
  };
}

function decisionOf(patch: Partial<DecisionEvenement> = {}): DecisionEvenement {
  return { sessionId: "ses_a", permissionId: "perm_1", verdict: "attente", regle: "E2", raison: "", par: "regles", ...patch };
}

const SIMPLE = { mode: "simple", controleIa: true } as const;

// --- Textes venus d'ailleurs (§4.12, P12) -----------------------------------------------------------------------------------

describe("L12b : texte venu d'une IA, d'un fichier ou d'opencode", () => {
  it("masqué à 120 caractères, avec les blancs réduits et les caractères invisibles retirés", () => {
    assert.equal(TEXTE_IA_MAX, 120);
    assert.equal(texteAffichable("  deux   espaces\net une ligne  "), "deux espaces et une ligne");
    assert.equal(texteAffichable("a​bc"), "ab c");
    const long = "é".repeat(400);
    const coupe = texteAffichable(long);
    assert.equal(Array.from(coupe).length, TEXTE_IA_MAX);
    assert.ok(coupe.endsWith("…"));
    // Borne comptée en caractères affichés, pas en unités UTF-16 : un émoji compte pour un.
    assert.equal(Array.from(texteAffichable("🙂".repeat(400))).length, TEXTE_IA_MAX);
    assert.equal(texteAffichable(undefined), "");
    assert.equal(texteAffichable(42), "");
  });

  it("secrets masqués avant la coupe : aucun jeton ne passe, même en fin de texte", () => {
    const secret = `raison ghp_${"a".repeat(36)}`;
    const vu = texteAffichable(secret);
    assert.equal(vu.includes("a".repeat(36)), false);
    assert.ok(Array.from(vu).length <= TEXTE_IA_MAX);
  });

  it("la raison d'une décision passe par la coupe (carte)", () => {
    const vue = carteVue({ ...SIMPLE, examining: false, decision: decisionOf({ raison: "z".repeat(300) }) });
    assert.ok(vue);
    assert.equal(Array.from(vue.raison ?? "").length, TEXTE_IA_MAX);
  });
});

// --- Bascule des boutons à 60 s (§4.3 étape 7) ------------------------------------------------------------------------------

describe("L12b : bascule des boutons à 60 s", () => {
  it("horloge injectée : examen avant 60 s, boutons normaux après", () => {
    assert.equal(EXAMEN_BOUTONS_MS, 60_000);
    const etat: EtatDemande = { examenDepuis: 10_000, decision: null };
    assert.equal(examenEnCours(etat, 10_000), true);
    assert.equal(examenEnCours(etat, 10_000 + EXAMEN_BOUTONS_MS - 1), true);
    assert.equal(examenEnCours(etat, 10_000 + EXAMEN_BOUTONS_MS), false);
    assert.equal(examenEnCours(etat, 10_000 + EXAMEN_BOUTONS_MS + 60_000), false);
    // Horloge qui recule : l'examen ne se rallume pas au-delà de la borne, il reste simplement en cours avant elle.
    assert.equal(examenEnCours(etat, 9_000), true);
    assert.equal(examenEnCours(null, 10_000), false);
  });

  it("une décision arrivée avant 60 s arrête l'examen tout de suite", () => {
    const etat: EtatDemande = { examenDepuis: 10_000, decision: decisionOf() };
    assert.equal(examenEnCours(etat, 10_001), false);
  });

  it("la carte d'examen ne propose que [Refuser…] ; après 60 s, les boutons normaux reviennent", () => {
    const examen = carteVue({ ...SIMPLE, examining: true, decision: null });
    assert.ok(examen);
    assert.equal(examen.etat, "examen");
    assert.equal(examen.titre, TEXTES.partout.carte.examen);
    assert.equal(examen.icone, "shield");
    assert.equal(examen.regle, null);
    assert.deepEqual(examen.boutons, { autoriser: false, refuser: true, arreter: false });
    // Au-delà de 60 s, la source de l'état rend examining faux : sans décision, la carte redevient celle de la 1.0.4.
    assert.equal(carteVue({ ...SIMPLE, examining: false, decision: null }), null);
  });

  it("une seule minuterie, posée sur l'examen qui finit le plus tôt", () => {
    let etats = avecExamen(ETATS_VIDES, "perm_1", 1_000);
    etats = avecExamen(etats, "perm_2", 5_000);
    assert.equal(prochaineBascule(etats, 1_000), EXAMEN_BOUTONS_MS);
    assert.equal(prochaineBascule(etats, 1_000 + EXAMEN_BOUTONS_MS - 10), 10);
    // Le premier examen est fini : seule l'échéance du second reste.
    assert.equal(prochaineBascule(etats, 1_000 + EXAMEN_BOUTONS_MS), 4_000);
    assert.equal(prochaineBascule(etats, 5_000 + EXAMEN_BOUTONS_MS), null);
    assert.equal(prochaineBascule(ETATS_VIDES, 1_000), null);
  });

  it("vueEtats rend la forme figée de slots.ts, bascule comprise", () => {
    const etats = avecExamen(ETATS_VIDES, "perm_1", 1_000);
    assert.deepEqual(vueEtats(etats, 1_500).get("perm_1"), { examining: true, decision: null });
    assert.deepEqual(vueEtats(etats, 1_000 + EXAMEN_BOUTONS_MS).get("perm_1"), { examining: false, decision: null });
  });
});

// --- Suite des états d'une demande (§4.3 étape 6) ---------------------------------------------------------------------------

describe("L12b : états des demandes d'autorisation", () => {
  it("examen, puis décision, puis réponse : l'état suit et finit par être oublié", () => {
    let etats = avecExamen(ETATS_VIDES, "perm_1", 1_000);
    assert.equal(etats.get("perm_1")?.examenDepuis, 1_000);
    const decision = decisionOf({ verdict: "attente", regle: "E2" });
    etats = avecDecision(etats, decision);
    assert.equal(etats.get("perm_1")?.decision?.regle, "E2");
    assert.equal(etats.get("perm_1")?.examenDepuis, 1_000);
    etats = sansDemande(etats, "perm_1");
    assert.equal(etats.has("perm_1"), false);
    // Demande inconnue : la même table est rendue (aucun rendu inutile).
    assert.equal(sansDemande(etats, "perm_absent"), etats);
  });

  it("une décision hors demande (permissionId absent) ne change rien", () => {
    const etats = avecDecision(ETATS_VIDES, decisionOf({ permissionId: null }));
    assert.equal(etats.size, 0);
    assert.equal(avecExamen(ETATS_VIDES, "", 1_000).size, 0);
  });

  it("table bornée : au-delà de ETATS_MAX, les plus anciennes demandes sont oubliées", () => {
    let etats = ETATS_VIDES;
    for (let i = 0; i < ETATS_MAX + 5; i++) etats = avecExamen(etats, `perm_${i}`, 1_000 + i);
    assert.equal(etats.size, ETATS_MAX);
    assert.equal(etats.has("perm_0"), false);
    assert.equal(etats.has(`perm_${ETATS_MAX + 4}`), true);
  });
});

// --- Carte d'attente (§4.13) ------------------------------------------------------------------------------------------------

describe("L12b : carte « En attente de votre accord »", () => {
  it("titre, « Règle : {phrase} » et boutons de la spécification", () => {
    const vue = carteVue({ ...SIMPLE, examining: false, decision: decisionOf({ verdict: "attente", regle: "E2" }) });
    assert.ok(vue);
    assert.equal(vue.etat, "attente");
    assert.equal(vue.titre, "En attente de votre accord");
    assert.equal(vue.titre, libelleDecision("attente"));
    assert.equal(vue.regle, "Règle : Fichier protégé (configuration, CI/CD, infrastructure ou consignes d'IA)");
    assert.deepEqual(vue.boutons, { autoriser: true, refuser: true, arreter: true });
  });

  it("chaque verdict a son icône, jamais la couleur seule (§2.3, §5.5)", () => {
    for (const [verdict, icone] of Object.entries(ICONES_VERDICT)) {
      const vue = carteVue({ ...SIMPLE, examining: false, decision: decisionOf({ verdict: verdict as DecisionEvenement["verdict"] }) });
      assert.ok(vue, verdict);
      assert.equal(vue.icone, icone, verdict);
      assert.ok(vue.titre.length > 0, verdict);
    }
    assert.equal(new Set(Object.values(ICONES_VERDICT)).size, Object.keys(ICONES_VERDICT).length);
  });

  it("une décision automatique n'est plus une attente : ses boutons s'effacent", () => {
    const vue = carteVue({ ...SIMPLE, examining: false, decision: decisionOf({ verdict: "auto", regle: "A-edit" }) });
    assert.ok(vue);
    assert.equal(vue.etat, "terminee");
    assert.deepEqual(vue.boutons, { autoriser: false, refuser: false, arreter: false });
  });

  it("la phrase de la règle suit le mode et l'IA de contrôle (deux variantes de controleIa)", () => {
    const decision = decisionOf({ regle: "S7" });
    const avec = carteVue({ mode: "simple", controleIa: true, examining: false, decision });
    const sans = carteVue({ mode: "simple", controleIa: false, examining: false, decision });
    assert.equal(avec?.regle, "Règle : Programme que le cockpit ne connaît pas : jugé par l'IA de contrôle");
    assert.equal(sans?.regle, "Règle : Programme que le cockpit ne connaît pas : le contrôle par IA est coupé");
    const simple = carteVue({ mode: "simple", controleIa: true, examining: false, decision: decisionOf({ regle: "D1" }) });
    const avance = carteVue({ mode: "avance", controleIa: true, examining: false, decision: decisionOf({ regle: "D1" }) });
    assert.notEqual(simple?.regle, avance?.regle);
  });

  it("une règle inconnue de cette version ne donne jamais une phrase inventée", () => {
    const vue = carteVue({ ...SIMPLE, examining: false, decision: decisionOf({ regle: "Z99" }) });
    assert.equal(vue?.regle, `Règle : ${TEXTES.partout.regles.inconnue}`);
  });

  it("un verdict inconnu (refus-interdit de la Salle OMO, version plus récente) laisse la carte de la 1.0.4", () => {
    assert.equal(carteVue({ ...SIMPLE, examining: false, decision: decisionOf({ verdict: "refus-interdit" as never }) }), null);
    assert.equal(carteVue({ ...SIMPLE, examining: false, decision: null }), null);
  });
});

// --- Bandeau (§4.12, §5.4, §5.6) --------------------------------------------------------------------------------------------

describe("L12b : bandeau « Autonome avec contrôle »", () => {
  it("résumé, compteurs et montants de la spécification", () => {
    const vue = bandeauVue({ demande: demandeOf({ auto: 12, attentes: 1, spent: 0.08 }), etroit: false });
    assert.ok(vue);
    assert.equal(vue.resume, "Autonome avec contrôle · 12 automatiques · 1 en attente · 0,08 $ sur 1,00 $");
    assert.deepEqual(vue.compteurs, { auto: 12, attentes: 1 });
    assert.equal(vue.depense, "0,08 $");
    assert.equal(vue.plafond, "1,00 $");
    assert.equal(montant(0.08), "0,08 $");
    assert.ok(vue.resume.endsWith("0,08 $ sur 1,00 $"));
  });

  it("une seule décision automatique se dit au singulier", () => {
    const vue = bandeauVue({ demande: demandeOf({ auto: 1, attentes: 0 }), etroit: false });
    assert.equal(vue?.resume, "Autonome avec contrôle · 1 automatique · 0 en attente · 0,00 $ sur 1,00 $");
  });

  it("aucun bandeau sans demande, ni pour un autre choix que « Autonome avec contrôle »", () => {
    assert.equal(bandeauVue({ demande: null, etroit: false }), null);
    assert.equal(bandeauVue({ demande: demandeOf({ choix: "modifications" }), etroit: false }), null);
  });

  it("400 px : le bandeau tient sur une ligne, les segments du milieu passent dans « +2 » (§5.6)", () => {
    const demande = demandeOf({ auto: 12, attentes: 1, spent: 0.08 });
    const large = bandeauVue({ demande, etroit: false });
    assert.ok(large);
    assert.equal(large.enPlus, null);
    assert.ok(large.segments.every((s) => s.visible));

    const etroit = bandeauVue({ demande, etroit: true });
    assert.ok(etroit);
    assert.equal(etroit.segments.length, 4);
    assert.deepEqual(
      etroit.segments.map((s) => s.visible),
      [true, false, false, true],
    );
    assert.equal(etroit.enPlus?.court, "+2");
    assert.ok((etroit.enPlus?.accessible ?? "").includes("2"));
    // Le résumé entier reste lu par le lecteur d'écran : rien n'est perdu, seul l'affichage se replie.
    assert.equal(etroit.segments.map((s) => s.texte).join(SEPARATEUR), etroit.resume);
  });

  it("[Voir les modifications de cette demande] seulement en fin de demande (§4.4)", () => {
    const enCours = bandeauVue({ demande: demandeOf({ auto: 3 }), etroit: false });
    assert.deepEqual(enCours?.boutons, { arreter: true, journal: true, modifications: false });
    const finie = bandeauVue({ demande: demandeOf({ auto: 3, fin: "terminee" }), etroit: false });
    assert.deepEqual(finie?.boutons, { arreter: false, journal: true, modifications: true });
    assert.equal(TEXTES.partout.commandes.voirModifications, "Voir les modifications de cette demande");
  });

  it("phrase de fin : plafond atteint avec ses chiffres, arrêt, fin normale ; fin inconnue muette", () => {
    const plafond = bandeauVue({ demande: demandeOf({ spent: 1.02, fin: "plafond-cout" }), etroit: false });
    assert.ok(plafond?.fin?.startsWith("Arrêtée : plafond d'arrêt atteint (1,02 $ sur 1,00 $)"));
    assert.equal(bandeauVue({ demande: demandeOf({ fin: "terminee" }), etroit: false })?.fin, "Demande terminée.");
    assert.equal(bandeauVue({ demande: demandeOf({ fin: "vous" }), etroit: false })?.fin, "Demande arrêtée par vous.");
    // Fin d'une Salle OMO ou d'une version plus récente : aucune phrase inventée (P3).
    assert.equal(bandeauVue({ demande: demandeOf({ fin: "homme-mort" }), etroit: false })?.fin, null);
    assert.equal(bandeauVue({ demande: demandeOf({ fin: "inventee" as RequestEnd }), etroit: false })?.fin, null);
    assert.equal(bandeauVue({ demande: demandeOf(), etroit: false })?.fin, null);
  });

  it("état vide (§5.4) : une demande terminée sans aucune décision automatique le dit", () => {
    const vide = bandeauVue({ demande: demandeOf({ auto: 0, fin: "terminee" }), etroit: false });
    assert.equal(vide?.vide, TEXTES.partout.journal.vide);
    assert.match(vide?.vide ?? "", /^Aucune décision .* pour cette demande\.$/);
    // Tant qu'elle travaille, ou dès qu'une décision est prise, aucun état vide.
    assert.equal(bandeauVue({ demande: demandeOf({ auto: 0 }), etroit: false })?.vide, null);
    assert.equal(bandeauVue({ demande: demandeOf({ auto: 1, fin: "terminee" }), etroit: false })?.vide, null);
  });
});

// --- Annonces polies (§4.12, §5.5) ------------------------------------------------------------------------------------------

describe("L12b : annonces polies du bandeau", () => {
  const vueDe = (patch: Partial<AutonomyRequestView>): BandeauVue => {
    const vue = bandeauVue({ demande: demandeOf(patch), etroit: false });
    assert.ok(vue);
    return vue;
  };

  it("une attente nouvelle et une fin de demande sont annoncées ; le reste non", () => {
    const depart = vueDe({ auto: 1, attentes: 0 });
    assert.equal(annonceBandeau(depart, vueDe({ auto: 1, attentes: 1 })), "En attente de votre accord");
    assert.equal(annonceBandeau(depart, vueDe({ auto: 1, attentes: 0, fin: "terminee" })), "Demande terminée.");
    // Compteur d'automatiques qui monte, dépense qui monte, attente qui retombe : rien à annoncer.
    assert.equal(annonceBandeau(depart, vueDe({ auto: 9, attentes: 0 })), null);
    assert.equal(annonceBandeau(depart, vueDe({ auto: 1, attentes: 0, spent: 0.5 })), null);
    assert.equal(annonceBandeau(vueDe({ attentes: 2 }), vueDe({ attentes: 1 })), null);
  });

  it("une première lecture n'annonce rien, une demande disparue non plus", () => {
    assert.equal(annonceBandeau(null, vueDe({ attentes: 1 })), null);
    assert.equal(annonceBandeau(vueDe({ attentes: 1 }), null), null);
  });
});

// --- Suivi de la demande par le flux (§4.12) --------------------------------------------------------------------------------

describe("L12b : demande tenue à jour par le flux", () => {
  const evenement = { requestId: "req_1", compteurs: { auto: 4, attentes: 1 }, spent: 0.2 };

  it("les compteurs et la dépense de l'événement sont reportés sur la demande lue", () => {
    const suite = demandeApresEvenement(demandeOf({ auto: 1 }), evenement);
    assert.equal(suite?.auto, 4);
    assert.equal(suite?.attentes, 1);
    assert.equal(suite?.spent, 0.2);
    assert.equal(suite?.fin, null);
    assert.equal(demandeApresEvenement(demandeOf(), { ...evenement, fin: "terminee" })?.fin, "terminee");
    // Un compteur absent de l'événement garde sa valeur.
    assert.equal(demandeApresEvenement(demandeOf({ fichiers: 3 }), evenement)?.fichiers, 3);
  });

  it("un événement d'une autre demande ne mélange rien : l'interface relit la route", () => {
    const autre = { ...evenement, requestId: "req_2" };
    const demande = demandeOf({ auto: 1 });
    assert.equal(demandeApresEvenement(demande, autre), demande);
    assert.equal(relirePourEvenement(demande, autre), true);
    assert.equal(relirePourEvenement(demande, evenement), false);
    assert.equal(relirePourEvenement(null, evenement), true);
    assert.equal(demandeApresEvenement(null, evenement), null);
  });
});

// --- Fin de demande gardée à travers les relectures (R106-b) ------------------------------------------------------------------

/**
 * Suite d'arrivées vue par le bandeau : réponse d'une relecture de GET …/autonomie (la demande EN COURS, ou null) ou événement
 * `autonomie.demande` du flux. Un événement qui demande une relecture est compté : la relecture elle-même est le pas suivant.
 */
type Arrivee = { relecture: AutonomyRequestView | null } | { evenement: DemandeEvenementLu };

function jouer(arrivees: Arrivee[]): { suivi: SuiviBandeau; relectures: number; vue: BandeauVue | null } {
  let suivi = SUIVI_VIDE;
  let relectures = 0;
  for (const arrivee of arrivees) {
    if ("relecture" in arrivee) {
      suivi = suiviApresRelecture(suivi, arrivee.relecture);
      continue;
    }
    const suite = suiviApresEvenement(suivi, arrivee.evenement);
    if (suite.relire) relectures++;
    else suivi = suite.suivi;
  }
  return { suivi, relectures, vue: bandeauVue({ demande: suivi.affichee, etroit: false }) };
}

describe("R106-b : la fin de demande reste affichée quand la route ne rend plus la demande", () => {
  // Demande X ouverte telle que la route la rend, puis l'événement de sa fin : compteurs de it2-ui-bandeau-journal.
  const ouverte = demandeOf({ id: "req_x", auto: 2, attentes: 1, fichiers: 1 });
  const fin = (motif: RequestEnd): DemandeEvenementLu => ({ requestId: "req_x", compteurs: { auto: 2, attentes: 1, fichiers: 1 }, spent: 0.004, fin: motif });
  const exigerFin = (vue: BandeauVue | null, phrase: string, ou: string) => {
    assert.ok(vue !== null, `${ou} : bandeau disparu`);
    assert.equal(vue.terminee, true, `${ou} : demande affichée en cours`);
    assert.equal(vue.fin, phrase, `${ou} : phrase de fin`);
    assert.equal(vue.boutons.modifications, true, `${ou} : [Voir les modifications de cette demande] absent`);
    assert.equal(vue.boutons.arreter, false, `${ou} : [Arrêter] encore proposé`);
  };

  it("relecture APRÈS l'événement de fin (changement de choix juste avant l'envoi) : la fin reste", () => {
    const { vue, relectures } = jouer([{ relecture: ouverte }, { evenement: fin("terminee") }, { relecture: null }]);
    exigerFin(vue, TEXTES.partout.fins.terminee, "relecture après la fin");
    assert.equal(relectures, 0);
  });

  it("relecture calculée après la clôture mais arrivée AVANT l'événement de fin : la fin revient par l'événement, sans relecture", () => {
    const retiree = jouer([{ relecture: ouverte }, { relecture: null }]);
    // Sa fin n'est pas encore connue : rien n'est inventé, le bandeau se retire en attendant.
    assert.equal(retiree.vue, null);
    assert.equal(retiree.suivi.connue?.id, "req_x");
    const { vue, relectures } = jouer([{ relecture: ouverte }, { relecture: null }, { evenement: fin("terminee") }]);
    exigerFin(vue, TEXTES.partout.fins.terminee, "relecture avant la fin");
    assert.equal(relectures, 0, "la route ne rendrait plus la demande : aucune relecture");
  });

  it("relecture calculée AVANT la clôture et arrivée après l'événement de fin : une demande close ne se rouvre pas", () => {
    const { vue } = jouer([{ relecture: ouverte }, { evenement: fin("terminee") }, { relecture: ouverte }]);
    exigerFin(vue, TEXTES.partout.fins.terminee, "relecture ancienne");
  });

  it("plafond de coût : fin « plafond-cout » PUIS retour à « Demander » (autonomie.choix → relecture) : la phrase du plafond reste", () => {
    const plafond = phraseFinDemande({ ...ouverte, spent: 0.004, fin: "plafond-cout" });
    assert.ok(plafond !== null && plafond !== "");
    const { vue } = jouer([{ relecture: ouverte }, { evenement: fin("plafond-cout") }, { relecture: null }]);
    exigerFin(vue, plafond, "plafond de coût");
  });

  it("redémarrage d'opencode : fin « interrompue » puis relecture : la fin reste", () => {
    const { vue } = jouer([{ relecture: ouverte }, { evenement: fin("interrompue") }, { relecture: null }]);
    exigerFin(vue, TEXTES.partout.fins.interrompue, "demande interrompue");
  });

  it("une demande suivante remplace la fin de la précédente (relecture de la route, jamais un mélange)", () => {
    const suivante = demandeOf({ id: "req_y" });
    const { vue, relectures, suivi } = jouer([
      { relecture: ouverte },
      { evenement: fin("terminee") },
      { relecture: null },
      { evenement: { requestId: "req_y", compteurs: { auto: 0 }, spent: 0 } },
      { relecture: suivante },
    ]);
    assert.equal(relectures, 1);
    assert.equal(suivi.affichee?.id, "req_y");
    assert.equal(vue?.terminee, false);
    assert.equal(vue?.boutons.arreter, true);
  });

  it("demande retirée sans événement de fin (flux coupé) : rien n'est inventé, un événement sans fin fait relire", () => {
    const { vue, relectures } = jouer([{ relecture: ouverte }, { relecture: null }, { evenement: { requestId: "req_x", compteurs: { auto: 3 }, spent: 0.01 } }]);
    assert.equal(vue, null);
    assert.equal(relectures, 1);
    // Aucune demande jamais vue : un événement fait relire, comme avant.
    assert.equal(suiviApresEvenement(SUIVI_VIDE, fin("terminee")).relire, true);
  });

  it("le bandeau passe par ce suivi : une relecture n'est jamais appliquée telle quelle", () => {
    const source = code(BANNER_FILE);
    assert.ok(source.includes("suiviApresRelecture("), "relectures composées par suiviApresRelecture");
    assert.ok(source.includes("suiviApresEvenement("), "événements composés par suiviApresEvenement");
    assert.doesNotMatch(source, /set\w+\(\s*vue\.demande\s*\)/, "réponse de la route appliquée telle quelle");
    assert.ok(source.includes("demande: suivi.affichee"), "le bandeau rend la demande affichée du suivi");
  });
});

// --- Contrat statique de l'interface (P7) -----------------------------------------------------------------------------------

describe("L12b : contrat statique des composants", () => {
  it("le retrait des commentaires et la détection d'une recopie (contrôles discriminants)", () => {
    assert.equal(sansCommentaires("a // titre\nb"), "a \nb");
    assert.equal(sansCommentaires("a /* titre */ b"), "a  b");
    assert.equal(sansCommentaires("/* sans fin"), "");
    assert.equal(recopie('<Button>Journal</Button>', "Journal"), true);
    assert.equal(recopie('const x = "Journal";', "Journal"), true);
    assert.equal(recopie("onOpenJournal={onOpenJournal}", "Journal"), false);
    assert.equal(recopie("{commandes.journal}", "Journal"), false);
  });

  it("les composants ne recopient aucun texte : toutes les phrases viennent des modules de textes", () => {
    for (const fichier of [CARD_FILE, BANNER_FILE]) {
      const source = code(fichier);
      for (const phrase of ["Contrôle de sécurité en cours", "En attente de votre accord", "Autonome avec contrôle", "Règle :", "Arrêter", "Journal"]) {
        assert.equal(recopie(source, phrase), false, `${fichier} : « ${phrase} » recopié`);
      }
      assert.ok(source.includes("autonomy-view.ts"), `${fichier} : modèle pur non utilisé`);
      assert.equal(source.includes("dangerouslySetInnerHTML"), false, `${fichier} : HTML brut`);
    }
    assert.ok(code(BANNER_FILE).includes("autonomy-texts.ts"), "le bandeau prend ses libellés de boutons dans L9b");
  });

  it("le bandeau annonce par l'annonceur de la page : aucune seconde région aria-live", () => {
    const source = code(BANNER_FILE);
    assert.ok(source.includes("useAnnouncer"));
    assert.ok(source.includes("annonceBandeau"));
    assert.equal(/aria-live/.test(source), false);
    assert.equal(/role="status"|role="alert"/.test(source), false);
    // La région unique de la page reste celle de L5b.
    assert.ok(read("web/lib/announcer.ts").includes('aria-live", "polite"'));
  });

  it("aucun appel non relayé : la fin de demande passe par GET /session/:id/diff du proxy", () => {
    const source = code(BANNER_FILE);
    assert.ok(source.includes("oc.diff("), "les modifications viennent de oc.diff (proxy /api/oc/session/:id/diff)");
    assert.equal(/\bfetch\s*\(|XMLHttpRequest|EventSource\s*\(/.test(source), false);
    assert.ok(read("web/lib/api.ts").includes("/api/oc/session/${enc(id)}/diff"), "la route relayée existe toujours");
  });

  it("aucune animation dans la feuille de style, et les états ne tiennent pas à la couleur seule", () => {
    const css = code(CSS_FILE);
    assert.equal(/\banimation\b|@keyframes|\btransition\b/.test(css), false);
    assert.ok(css.includes("@media (forced-colors: active)"), "forced-colors");
    assert.ok(css.includes("@media (max-width: 400px)"), "400 px");
    // Un mot accompagne toujours l'icône : les composants rendent le titre et l'icône ensemble.
    const carte = code(CARD_FILE);
    assert.ok(carte.includes("vue.titre"));
    assert.ok(carte.includes("vue.icone"));
  });

  it("le modèle reste pur et sans texte : seuls des codes et le séparateur y sont écrits", () => {
    const source = code(MODEL_FILE);
    assert.equal(source.includes('"node:'), false);
    assert.equal(/\bprocess\./.test(source), false);
    assert.equal(/\bDate\.now\(|new Date\(/.test(source), false, "horloge injectée, jamais lue ici");
    assert.equal(SEPARATEUR, " · ");
  });
});
