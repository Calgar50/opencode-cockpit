// Propriétaire : L26a.
// Modèle pur de la page de la Salle OMO (shared/omo-activation-view.ts) : champ de plafond vide la première fois, prérempli
// ensuite, hors bornes proposé tel quel ; une phrase par code de `OmoActivationRefusalCode` ; chaque état de la salle rendu avec
// sa phrase ; bandeau permanent, pré-contrôle et fichiers signalés.
//
// Arbitrage L21 n° 3, point 3 (A16 point 4) : la RAISON de l'attente — historique git non protégé, plafond de balayage atteint,
// salle coupée — doit être AFFICHÉE, pas seulement présente dans les textes. Deux gardes : le modèle la rend (comportement), et
// la page la rend à l'écran (lecture du source de SalleOmoPage.tsx, comme web-animations.test.ts lit les sources de l'interface).
//
// Relecture 2ter-vague-2 (deux constats confirmés, fin de fichier) :
// - le bandeau était livré sans son [Journal] et le Journal de la salle n'était joignable par aucun chemin : la page passe
//   maintenant `onOpenJournal` et rend le Journal du contrôle de sa racine, détections et fichiers mis de côté compris ;
// - un échec passager de GET /api/omo/status effaçait le bandeau et le seul [Arrêter] de la salle, et faisait dire « Salle
//   coupée » sans donnée : « illisible » n'est plus « coupée », et le bandeau suit le dernier statut RÉELLEMENT lu.
// Node exécute le TypeScript mais pas le JSX (P8 : aucun transformateur) : le comportement est prouvé par les modèles purs, le
// branchement par la lecture des sources, comme omo-diagnostic-journal.test.ts.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import { ajouterDetection, DETECTIONS_MAX, journalDeLaSalle, lireDetection, relireJournalApres } from "../web/pages/omo/salle-journal.ts";
import { OMO_ACTIVATION_REFUSAL_CODES, OMO_DETECTION_CAUSES, OMO_ETATS_SALLE } from "./omo-contracts.ts";
import {
  annonceBandeau,
  annonceEtatSalle,
  apresLecture,
  conditionsActivation,
  demandeEnCours,
  ETAT_ILLISIBLE,
  ETAT_NON_INSTALLEE,
  LECTURE_INITIALE,
  montantAffiche,
  montantSaisiAffiche,
  phraseRefus,
  planificateurSansDemande,
  statutAffiche,
  vueActivation,
  vueBandeau,
  vueEtatSalle,
  vuePrecontrole,
  vueSansDemande,
  vueSignales,
} from "./shared/omo-activation-view.ts";
import { TEXTES } from "./shared/omo-room-texts.ts";
import { PRECHECK_BORNES } from "./shared/omo-precheck-rules.ts";
import type { BootstrapOmo, OmoActivationView, OmoEtatSalle, OmoStatusResponse } from "./shared/omo-types.ts";

const PAGE = path.join(import.meta.dirname, "..", "web", "pages", "omo", "SalleOmoPage.tsx");
const BANDEAU = path.join(import.meta.dirname, "..", "web", "pages", "omo", "OmoBanner.tsx");

/** Source sans ses commentaires : ce que le composant fait vraiment, et non ce que ses commentaires nomment. */
const sansCommentaires = (source: string): string => source.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/^[ \t]*\/\/[^\n]*$/gm, " ");

/** Vue d'activation minimale : aucune condition fausse, aucun dernier montant (première activation). */
function vueDActivation(patch: Partial<OmoActivationView> = {}): OmoActivationView {
  return {
    rootId: "ses_salle",
    projet: "mon-projet",
    dernierPlafondUsd: null,
    plafondMaxUsd: 5,
    horsBornes: false,
    demandeActive: false,
    conditions: [],
    ...patch,
  };
}

function statut(patch: Partial<OmoStatusResponse> = {}): OmoStatusResponse {
  return {
    interrupteurs: { omo: true, autonomie: true, salleOuverte: true },
    image: { chargee: true, id: "sha256:1", manifesteSha256: "abc", version: "4.19.4", auditeLe: "2026-09-12" },
    dernierDemarrage: null,
    listeBlanche: ["api.githubcopilot.com"],
    projetsPrepares: [{ chemin: "mon-projet", git: "lecture-seule" }],
    workspaceGit: { verifieLe: 1, limiteAtteinte: false, nonProteges: [] },
    etatSalle: "prete",
    authSalle: { presente: true },
    sortiesRefusees24h: [],
    battement: { actif: true, ageMs: 500 },
    ...patch,
  };
}

const BOOT_COUPEE: BootstrapOmo = { enabled: false, imageChargee: true, salleOuverte: false };

/** Gabarit « {nom} » resté dans une phrase : un oubli de valeur se voit. */
const GABARIT_RESTANT = /\{\w+\}/;

describe("Salle OMO : écran d'activation (§4.14.6, JS-12)", () => {
  it("première activation : champ vide, borne affichée, aucune erreur annoncée", () => {
    const vue = vueActivation({ vue: vueDActivation(), saisie: null, tentee: false, dateAudit: "12 septembre 2026" });
    assert.equal(vue.champ.valeur, "");
    assert.equal(vue.champ.horsBornes, false);
    assert.equal(vue.champ.invalide, false);
    assert.equal(vue.erreur, null);
    assert.equal(vue.lancerPossible, false, "un champ vide ne lance rien");
    assert.equal(vue.champ.borne, "au plus 5,00 $");
    assert.equal(vue.titre, TEXTES.avance.activation.titre);
    assert.equal(vue.boutons.lancer, TEXTES.avance.activation.boutons.lancer);
    for (const phrase of vue.phrases) assert.equal(GABARIT_RESTANT.test(phrase), false, phrase);
    assert.ok(vue.phrases.some((p) => p.includes("12 septembre 2026")), "la date d'audit remplit son gabarit");
    assert.ok(vue.phrases.some((p) => p.includes("mon-projet")), "le projet remplit son gabarit");
  });

  it("activation suivante : dernier montant proposé, modifiable, lancement possible", () => {
    const vue = vueActivation({ vue: vueDActivation({ dernierPlafondUsd: "1,50" }), saisie: null, tentee: false, dateAudit: "" });
    assert.equal(vue.champ.valeur, "1,50");
    assert.equal(vue.champ.horsBornes, false);
    assert.equal(vue.erreur, null);
    assert.equal(vue.lancerPossible, true);
    const modifie = vueActivation({ vue: vueDActivation({ dernierPlafondUsd: "1,50" }), saisie: "2", tentee: false, dateAudit: "" });
    assert.equal(modifie.champ.valeur, "2");
    assert.equal(modifie.lancerPossible, true);
  });

  it("dernier montant au-dessus de la borne : proposé tel quel, marqué hors bornes, lancement refusé", () => {
    const vue = vueActivation({ vue: vueDActivation({ dernierPlafondUsd: "9,00", plafondMaxUsd: 5 }), saisie: null, tentee: false, dateAudit: "" });
    assert.equal(vue.champ.valeur, "9,00", "le cockpit ne choisit jamais un montant à la place de l'utilisateur");
    assert.equal(vue.champ.horsBornes, true);
    assert.equal(vue.champ.invalide, true);
    assert.equal(vue.erreur?.code, "plafond-hors-bornes");
    assert.ok(vue.erreur !== null && vue.erreur.phrase.includes("5,00 $"));
    assert.equal(vue.lancerPossible, false);
  });

  it("montant saisi invalide ou vide : erreur annoncée à la tentative, jamais arrondie", () => {
    const trois = vueActivation({ vue: vueDActivation(), saisie: "1,234", tentee: true, dateAudit: "" });
    assert.equal(trois.erreur?.code, "plafond-invalide");
    assert.equal(trois.lancerPossible, false);
    const vide = vueActivation({ vue: vueDActivation(), saisie: "", tentee: true, dateAudit: "" });
    assert.equal(vide.erreur?.code, "plafond-vide");
    assert.equal(vide.champ.invalide, true);
    const pasEncore = vueActivation({ vue: vueDActivation(), saisie: "", tentee: false, dateAudit: "" });
    assert.equal(pasEncore.erreur, null, "un champ jamais soumis n'accuse pas l'utilisateur");
  });

  it("budget mensuel refusé par le garde-fou : montant valide, lancement refusé", () => {
    const vue = vueActivation({
      vue: vueDActivation({ dernierPlafondUsd: "1", conditions: [{ code: "budget-mensuel", ok: false }] }),
      saisie: null,
      tentee: true,
      dateAudit: "",
    });
    assert.equal(vue.erreur?.code, "budget-mensuel");
    assert.equal(vue.lancerPossible, false);
    assert.deepEqual(vue.conditions.map((c) => c.code), ["budget-mensuel"]);
  });

  it("conditions fausses du §4.14.2 : chacune rendue avec sa phrase, lancement refusé", () => {
    const vue = vueActivation({
      vue: vueDActivation({
        dernierPlafondUsd: "1",
        conditions: [
          { code: "manifeste", ok: false },
          { code: "battement-absent", ok: true },
          { code: "precheck-refuse", ok: false },
        ],
      }),
      saisie: null,
      tentee: false,
      dateAudit: "",
    });
    assert.deepEqual(vue.conditions.map((c) => c.code), ["manifeste", "precheck-refuse"]);
    for (const condition of vue.conditions) assert.equal(GABARIT_RESTANT.test(condition.phrase), false, condition.phrase);
    assert.ok(vue.conditions.some((c) => c.phrase.includes("mon-projet")));
    assert.equal(vue.lancerPossible, false);
  });

  it("une demande déjà active dans la salle : lancement refusé même avec un montant valide", () => {
    const vue = vueActivation({ vue: vueDActivation({ dernierPlafondUsd: "1", demandeActive: true }), saisie: null, tentee: false, dateAudit: "" });
    assert.equal(vue.erreur, null);
    assert.equal(vue.lancerPossible, false);
  });

  it("variante Prometheus : la phrase suit la permission réellement posée par le cockpit", () => {
    const vue = vueActivation({ vue: vueDActivation(), saisie: null, tentee: false, dateAudit: "" });
    const attendue = planificateurSansDemande()
      ? TEXTES.avance.activation.planificateurSansDemande
      : TEXTES.avance.activation.planificateurControle;
    assert.ok(vue.phrases.includes(attendue));
    // `omo.jsonc` épingle edit: "ask" pour le planificateur (JS-3) : la variante « sans demande » n'est pas celle qui s'affiche.
    assert.equal(planificateurSansDemande(), false);
  });

  it("chaque code de refus a une phrase, gabarits remplis", () => {
    for (const code of OMO_ACTIVATION_REFUSAL_CODES) {
      const phrase = phraseRefus(code, { projet: "mon-projet", plafondMaxUsd: "5,00", liste: "a, b" });
      assert.notEqual(phrase.trim(), "", code);
      assert.equal(GABARIT_RESTANT.test(phrase), false, `${code} : ${phrase}`);
    }
  });
});

describe("Salle OMO : bandeau permanent (§4.12 l.784, D-2b-45)", () => {
  it("hors demande : aucun bandeau", () => {
    assert.equal(vueBandeau({ depenseUsd: 0, plafondSaisi: "2", demandeActive: false }), null);
  });

  it("demande en cours : dépense sur montant saisi, [Arrêter] et [Journal]", () => {
    const vue = vueBandeau({ depenseUsd: 0.08, plafondSaisi: "1.00", demandeActive: true });
    assert.equal(vue?.texte, "Salle OMO · extension active · actions non contrôlées avant exécution · 0,08 $ sur 1,00 $");
    assert.equal(vue?.arreter, TEXTES.avance.bandeau.arreter);
    assert.equal(vue?.journal, TEXTES.avance.bandeau.journal);
  });

  it("dépense pas encore connue : tiret dans le bandeau, jamais 0,00", () => {
    const vue = vueBandeau({ depenseUsd: null, plafondSaisi: "1", demandeActive: true });
    assert.equal(vue?.texte, "Salle OMO · extension active · actions non contrôlées avant exécution · — $ sur 1 $");
  });

  it("montant illisible : tiret, jamais un zéro inventé", () => {
    assert.equal(montantAffiche(null), "—");
    assert.equal(montantAffiche(Number.NaN), "—");
    assert.equal(montantAffiche(-1), "—");
    assert.equal(montantAffiche(0), "0,00");
    assert.equal(montantSaisiAffiche(null), "—");
    assert.equal(montantSaisiAffiche(" "), "—");
    assert.equal(montantSaisiAffiche("0.50"), "0,50");
  });

  it("annonce polie : seulement une transition du bandeau", () => {
    const a = vueBandeau({ depenseUsd: 0.08, plafondSaisi: "1", demandeActive: true });
    const b = vueBandeau({ depenseUsd: 0.2, plafondSaisi: "1", demandeActive: true });
    assert.equal(annonceBandeau(null, a), null, "une première lecture ne s'annonce pas");
    assert.equal(annonceBandeau(a, a), null);
    assert.equal(annonceBandeau(a, b), b?.texte);
    assert.equal(annonceBandeau(a, null), null);
  });
});

describe("Salle OMO : états de la salle et raison de l'attente (A16 point 4)", () => {
  it("chaque état de l'union est rendu avec sa phrase", () => {
    for (const etat of OMO_ETATS_SALLE) {
      const vue = vueEtatSalle({ boot: null, statut: statut({ etatSalle: etat, interrupteurs: { omo: etat !== "coupee", autonomie: true, salleOuverte: etat !== "coupee" } }) });
      assert.equal(vue.code, etat, etat);
      assert.equal(vue.libelle, TEXTES.avance.etats[etat as OmoEtatSalle], etat);
    }
  });

  it("aucune image chargée : état « non installée » avec sa phrase", () => {
    const vue = vueEtatSalle({ boot: null, statut: statut({ image: { chargee: false, id: null, manifesteSha256: null, version: null, auditeLe: null } }) });
    assert.equal(vue.code, ETAT_NON_INSTALLEE);
    assert.equal(vue.libelle, TEXTES.avance.nonInstallee);
    assert.ok(vue.raisons.includes(TEXTES.avance.nonInstallee));
    assert.equal(vue.prete, false);
  });

  it("statut refusé (403 salle-coupee) : état lu dans Bootstrap.omo, jamais une erreur technique", () => {
    const vue = vueEtatSalle({ boot: BOOT_COUPEE, statut: null });
    assert.equal(vue.code, "coupee");
    assert.equal(vue.libelle, TEXTES.avance.etats.coupee);
    assert.deepEqual(vue.raisons, [TEXTES.avance.refus["salle-coupee"]]);
    assert.equal(vue.prete, false);
  });

  it("historique git non protégé : la phrase de T3a est rendue, avec la liste et sans promesse de geste", () => {
    const vue = vueEtatSalle({
      boot: null,
      statut: statut({ etatSalle: "arretee", workspaceGit: { verifieLe: 1, limiteAtteinte: false, nonProteges: ["projet-a", "projet-b/.git"] } }),
    });
    const attendue = TEXTES.avance.refus["git-inscriptible"].replace("{liste}", "projet-a, projet-b/.git");
    assert.ok(vue.raisons.includes(attendue), JSON.stringify(vue.raisons));
    assert.equal(vue.raisons.some((r) => r.includes("install.ps1")), false, "aucun geste n'est promis pour le balayage de la salle");
    assert.equal(vue.prete, false);
  });

  it("projet préparé à l'historique git inscriptible : même phrase, chemin du projet dans la liste, sans doublon", () => {
    const vue = vueEtatSalle({
      boot: null,
      statut: statut({
        etatSalle: "arretee",
        projetsPrepares: [{ chemin: "mon-projet", git: "inscriptible" }, { chemin: "autre", git: "lecture-seule" }],
        workspaceGit: { verifieLe: 1, limiteAtteinte: false, nonProteges: ["mon-projet"] },
      }),
    });
    const attendue = TEXTES.avance.refus["git-inscriptible"].replace("{liste}", "mon-projet");
    assert.ok(vue.raisons.includes(attendue), JSON.stringify(vue.raisons));
    assert.equal(vue.raisons.filter((r) => r === attendue).length, 1);
  });

  it("plafond du balayage atteint, authentification absente, battement perdu : chaque raison est rendue", () => {
    const vue = vueEtatSalle({
      boot: null,
      statut: statut({
        etatSalle: "arretee",
        workspaceGit: { verifieLe: 1, limiteAtteinte: true, nonProteges: [] },
        authSalle: { presente: false },
        battement: { actif: false, ageMs: null },
      }),
    });
    assert.ok(vue.raisons.includes(TEXTES.avance.diagnostic.limiteAtteinte));
    assert.ok(vue.raisons.includes(TEXTES.avance.diagnostic.authAbsente));
    assert.ok(vue.raisons.includes(TEXTES.avance.refus["battement-absent"]));
  });

  it("salle suspendue ou en relance : la phrase du refus correspondant est rendue", () => {
    const suspendue = vueEtatSalle({ boot: null, statut: statut({ etatSalle: "suspendue" }) });
    assert.ok(suspendue.raisons.includes(TEXTES.avance.refus["salle-suspendue"]));
    const relance = vueEtatSalle({ boot: null, statut: statut({ etatSalle: "en-relance" }) });
    assert.ok(relance.raisons.includes(TEXTES.avance.refus["salle-en-relance"]));
  });

  it("autonomie coupée : la salle l'est aussi, avec sa phrase", () => {
    const vue = vueEtatSalle({ boot: null, statut: statut({ interrupteurs: { omo: true, autonomie: false, salleOuverte: true } }) });
    assert.equal(vue.code, "coupee");
    assert.ok(vue.raisons.includes(TEXTES.avance.refus["autonomie-coupee"]));
  });

  it("salle prête : aucune raison à montrer", () => {
    const vue = vueEtatSalle({ boot: null, statut: statut() });
    assert.equal(vue.code, "prete");
    assert.deepEqual(vue.raisons, []);
    assert.equal(vue.prete, true);
  });

  it("annonce polie : seulement un changement d'état", () => {
    const prete = vueEtatSalle({ boot: null, statut: statut() });
    const arretee = vueEtatSalle({ boot: null, statut: statut({ etatSalle: "arretee" }) });
    assert.equal(annonceEtatSalle(null, prete), null);
    assert.equal(annonceEtatSalle(prete, prete), null);
    assert.equal(annonceEtatSalle(prete, arretee), TEXTES.avance.etats.arretee);
  });
});

describe("Salle OMO : la page affiche la raison de l'attente (arbitrage L21 n° 3, point 3)", () => {
  const source = fs.readFileSync(PAGE, "utf8");

  it("SalleOmoPage.tsx lit l'état par le modèle pur", () => {
    assert.match(source, /vueEtatSalle/, "la page calcule l'état par shared/omo-activation-view.ts");
  });

  it("SalleOmoPage.tsx rend chaque raison à l'écran", () => {
    const rendu = /raisons\.map\(([\s\S]{0,400}?)\)\}/.exec(source);
    assert.ok(rendu !== null, "la page parcourt etat.raisons pour les afficher");
    // La raison doit être le CONTENU d'un élément (« …> {raison} »), pas seulement une clé de liste (« key={raison} ») :
    // sans cette distinction, une page qui compte les raisons sans les écrire passerait le contrôle.
    assert.match(rendu[1] ?? "", />\s*\{raison\}/, "chaque raison est écrite dans le rendu, jamais seulement comptée");
  });
});

describe("Salle OMO : tableau « sans demande » et conditions du §4.14.2", () => {
  it("tableau « sans demande » : les phrases d'honnêteté, distinctes de celles de l'écran d'activation", () => {
    const lignes = vueSansDemande({ plafondSaisi: "1,00", dateAudit: "12 septembre 2026" });
    for (const ligne of lignes) assert.equal(GABARIT_RESTANT.test(ligne), false, ligne);
    assert.ok(lignes.includes(TEXTES.avance.honnetete.delegue));
    assert.ok(lignes.some((l) => l.includes("1,00 $")), "le montant saisi remplit son gabarit");
    assert.ok(lignes.some((l) => l.includes("12 septembre 2026")));
    // Les deux phrases de l.1057 et l.1058 de l'écran d'activation ne sont PAS reprises telles quelles ici.
    assert.equal(lignes.includes(TEXTES.avance.activation.programme), false);
    assert.equal(lignes.includes(TEXTES.avance.activation.fichiersExecutes), false);
  });

  it("sans montant confirmé : le gabarit reçoit un tiret, jamais un montant inventé", () => {
    const lignes = vueSansDemande({ plafondSaisi: null, dateAudit: "" });
    assert.ok(lignes.some((l) => l.includes("— $")));
  });

  it("conditions lues dans le statut : chacune vraie quand le statut le dit, fausse sinon", () => {
    assert.deepEqual(
      conditionsActivation(statut(), false).filter((c) => !c.ok),
      [],
      "une salle prête ne refuse aucune condition vérifiable",
    );
    const coupee = conditionsActivation(statut({ interrupteurs: { omo: false, autonomie: true, salleOuverte: true } }), false);
    assert.equal(coupee.find((c) => c.code === "salle-coupee")?.ok, false);
    const git = conditionsActivation(statut({ workspaceGit: { verifieLe: 1, limiteAtteinte: false, nonProteges: ["a"] } }), false);
    assert.equal(git.find((c) => c.code === "git-inscriptible")?.ok, false);
    const active = conditionsActivation(statut({ etatSalle: "demande-active" }), true);
    assert.equal(active.find((c) => c.code === "demande-active")?.ok, false);
  });

  it("statut illisible : la seule condition rendue est « salle coupée », jamais une autorisation", () => {
    assert.deepEqual(conditionsActivation(null, false), [{ code: "salle-coupee", ok: false }]);
  });

  it("aucune condition inventée : manifeste, image, adresse Copilot et catalogue restent au serveur", () => {
    const codes = conditionsActivation(statut(), false).map((c) => c.code);
    for (const code of ["manifeste", "image-inattendue", "adresse-copilot-changee", "catalogue-absent", "jeton-consomme"] as const) {
      assert.equal(codes.includes(code), false, code);
    }
  });
});

describe("Salle OMO : pré-contrôle et fichiers signalés", () => {
  it("projet conforme : aucune phrase, aucune liste", () => {
    const vue = vuePrecontrole({ projet: "mon-projet", verdict: "conforme", raison: null, trouves: [] });
    assert.equal(vue.conforme, true);
    assert.equal(vue.phrase, null);
    assert.deepEqual(vue.chemins, []);
    assert.equal(vue.ecourtee, false);
  });

  it("projet refusé : phrase de la raison et liste masquée bornée", () => {
    const trouves = Array.from({ length: PRECHECK_BORNES.trouvesMax + 5 }, (_, i) => `chemin-${i}`);
    const vue = vuePrecontrole({ projet: "mon-projet", verdict: "refuse", raison: "config-extension", trouves });
    assert.equal(vue.conforme, false);
    assert.equal(vue.phrase, TEXTES.avance.precontrole["config-extension"]);
    assert.equal(vue.chemins.length, PRECHECK_BORNES.trouvesMax);
    assert.equal(vue.ecourtee, true);
  });

  it("fichiers signalés : un groupe par genre, quarantaine d'abord, chemin dans la phrase", () => {
    const groupes = vueSignales([
      { chemin: "a/.github/workflows/ci.yml", genre: "ide-ci" },
      { chemin: "a/.git.suspect-1", genre: "git-quarantaine" },
      { chemin: "a/build.ps1", genre: "programme" },
    ]);
    assert.deepEqual(groupes.map((g) => g.genre), ["git-quarantaine", "ide-ci", "programme"]);
    assert.ok(groupes[0]?.phrase.includes("a/.git.suspect-1"));
    assert.equal(GABARIT_RESTANT.test(groupes[0]?.phrase ?? ""), false);
    assert.equal(groupes[1]?.phrase, TEXTES.avance.signales["ide-ci"]);
    assert.deepEqual(groupes[2]?.chemins, ["a/build.ps1"]);
    assert.deepEqual(vueSignales([]), []);
  });
});

// =================================================================================================================================
// Relecture 2ter-vague-2, constat n° 2 (sécurité) : un statut ILLISIBLE n'est pas une salle COUPÉE.
// Scénario du constat : une demande est en cours ; `omo.etat` fait relire GET /api/omo/status, qui répond 500 (ou le flux tombe,
// ou le serveur redémarre). L'ancienne page posait `statut = null`, donc « coupée », donc `demandeActive` faux, donc AUCUN
// bandeau : le seul [Arrêter] de la salle disparaissait (POST /api/conversations/:rootId/stop rend 404 sur une racine de la
// salle, D-2b-30), au moment précis où le cockpit ne voyait plus la salle, et la page affirmait « Salle coupée » sans donnée.
// =================================================================================================================================

const BOOT_OUVERTE: BootstrapOmo = { enabled: true, imageChargee: true, salleOuverte: true };

describe("Salle OMO : statut illisible, jamais « salle coupée » (relecture 2ter-vague-2)", () => {
  it("GET /api/omo/status en 500 pendant une demande active : le bandeau et [Arrêter] restent, l'état dit « illisible »", () => {
    const enCours = apresLecture(LECTURE_INITIALE, { ok: true, statut: statut({ etatSalle: "demande-active" }) });
    assert.equal(demandeEnCours(BOOT_OUVERTE, enCours), true, "témoin : la demande lue est en cours");

    const echec = apresLecture(enCours, { ok: false, salleCoupee: false });
    assert.equal(echec.illisible, true);
    assert.equal(demandeEnCours(BOOT_OUVERTE, echec), true, "un échec de lecture ne termine pas une demande");
    const bandeau = vueBandeau({ depenseUsd: null, plafondSaisi: "1", demandeActive: demandeEnCours(BOOT_OUVERTE, echec) });
    assert.ok(bandeau !== null, "le bandeau reste rendu");
    assert.equal(bandeau.arreter, TEXTES.avance.bandeau.arreter, "[Arrêter] reste rendu, donc stopOmo reste appelable");
    assert.equal(bandeau.journal, TEXTES.avance.bandeau.journal);

    const etat = vueEtatSalle({ boot: BOOT_OUVERTE, statut: statutAffiche(echec), illisible: echec.illisible });
    assert.equal(etat.code, ETAT_ILLISIBLE);
    assert.equal(etat.libelle, TEXTES.avance.statutIllisible.libelle);
    assert.notEqual(etat.libelle, TEXTES.avance.etats.coupee, "la page ne dit pas « Salle coupée » sans donnée (P3)");
    assert.equal(etat.raisons.includes(TEXTES.avance.refus["salle-coupee"]), false);
    assert.deepEqual(etat.raisons, [TEXTES.avance.statutIllisible.raison], "la raison dit que l'état n'a pas pu être lu");
    assert.equal(etat.prete, false, "fermé en cas de doute : rien ne se prépare ni ne s'active sur un état inconnu");
  });

  it("témoin de l'ancien défaut : un statut oublié sur un 500 faisait tomber le bandeau et disait « coupée »", () => {
    // Ce que faisait l'ancienne page (setStatut(null) sur TOUTE erreur) : c'est exactement ce que apresLecture ne fait plus.
    const ancienne = vueEtatSalle({ boot: BOOT_OUVERTE, statut: null });
    const bandeauAncien = vueBandeau({ depenseUsd: null, plafondSaisi: "1", demandeActive: ancienne.code === "demande-active" });
    assert.equal(ancienne.code, "coupee");
    assert.equal(bandeauAncien, null);
    const lecture = apresLecture(apresLecture(LECTURE_INITIALE, { ok: true, statut: statut({ etatSalle: "demande-active" }) }), {
      ok: false,
      salleCoupee: false,
    });
    assert.notEqual(lecture.statut, null, "le dernier statut lu est GARDÉ sur une erreur autre que 403 « salle-coupee »");
  });

  it("403 « salle-coupee » : le serveur a répondu, le statut est oublié, le bandeau retiré, la salle dite coupée", () => {
    const enCours = apresLecture(LECTURE_INITIALE, { ok: true, statut: statut({ etatSalle: "demande-active" }) });
    const coupee = apresLecture(enCours, { ok: false, salleCoupee: true });
    assert.deepEqual(coupee, { statut: null, illisible: false });
    assert.equal(demandeEnCours(BOOT_COUPEE, coupee), false);
    const etat = vueEtatSalle({ boot: BOOT_COUPEE, statut: statutAffiche(coupee), illisible: coupee.illisible });
    assert.equal(etat.code, "coupee");
    assert.deepEqual(etat.raisons, [TEXTES.avance.refus["salle-coupee"]]);
  });

  it("une lecture réussie après l'échec rend l'état réel : demande finie, bandeau retiré", () => {
    const echec = apresLecture(apresLecture(LECTURE_INITIALE, { ok: true, statut: statut({ etatSalle: "demande-active" }) }), {
      ok: false,
      salleCoupee: false,
    });
    const relue = apresLecture(echec, { ok: true, statut: statut({ etatSalle: "prete" }) });
    assert.deepEqual(relue, { statut: statut({ etatSalle: "prete" }), illisible: false });
    assert.equal(demandeEnCours(BOOT_OUVERTE, relue), false);
    assert.equal(vueEtatSalle({ boot: BOOT_OUVERTE, statut: statutAffiche(relue), illisible: relue.illisible }).code, "prete");
  });

  it("statut illisible : aucun état périmé affiché, aucune préparation ni activation possibles", () => {
    const echec = apresLecture(apresLecture(LECTURE_INITIALE, { ok: true, statut: statut() }), { ok: false, salleCoupee: false });
    assert.equal(statutAffiche(echec), null, "rien n'est affirmé d'après une lecture périmée");
    const etat = vueEtatSalle({ boot: BOOT_OUVERTE, statut: statut(), illisible: true });
    assert.equal(etat.code, ETAT_ILLISIBLE, "même avec un statut « prête » en main, l'échec l'emporte");
    assert.equal(etat.prete, false);
    // Jamais lu du tout (premier appel en échec) : illisible aussi, sans bandeau puisque rien n'a jamais dit « en cours ».
    const jamaisLu = apresLecture(LECTURE_INITIALE, { ok: false, salleCoupee: false });
    assert.equal(vueEtatSalle({ boot: BOOT_OUVERTE, statut: statutAffiche(jamaisLu), illisible: jamaisLu.illisible }).code, ETAT_ILLISIBLE);
    assert.equal(demandeEnCours(BOOT_OUVERTE, jamaisLu), false);
  });

  it("ce que le Bootstrap sait reste sûr, même statut illisible : rien d'installé, ou salle fermée par ses interrupteurs", () => {
    assert.equal(vueEtatSalle({ boot: BOOT_COUPEE, statut: null, illisible: true }).code, "coupee");
    assert.equal(vueEtatSalle({ boot: { ...BOOT_OUVERTE, imageChargee: false }, statut: null, illisible: true }).code, ETAT_NON_INSTALLEE);
    assert.equal(vueEtatSalle({ boot: null, statut: null, illisible: true }).code, ETAT_NON_INSTALLEE);
  });

  it("annonce polie : le passage à « illisible » est une transition, dite avec son libellé", () => {
    const active = vueEtatSalle({ boot: BOOT_OUVERTE, statut: statut({ etatSalle: "demande-active" }) });
    const illisible = vueEtatSalle({ boot: BOOT_OUVERTE, statut: null, illisible: true });
    assert.equal(annonceEtatSalle(active, illisible), TEXTES.avance.statutIllisible.libelle);
    assert.equal(annonceEtatSalle(illisible, illisible), null);
  });
});

describe("Salle OMO : la page garde le bandeau et [Arrêter] quand le statut est illisible (source, relecture 2ter-vague-2)", () => {
  const page = sansCommentaires(fs.readFileSync(PAGE, "utf8"));
  const balise = (nom: string): string => {
    const trouvee = new RegExp(`<${nom}\\b[\\s\\S]*?/>`).exec(page);
    assert.ok(trouvee !== null, `<${nom} … /> est rendu par la page`);
    return trouvee[0];
  };

  it("la lecture du statut passe par apresLecture : seul un 403 « salle-coupee » oublie le dernier statut lu", () => {
    assert.match(page, /apresLecture\(/, "la page tient sa lecture par le modèle pur");
    assert.match(page, /salleCoupee: estSalleCoupee\(err\)/, "le 403 « salle-coupee » est le seul échec qui dit la salle coupée");
    assert.equal(/setStatut\(null\)/.test(page), false, "aucune erreur n'efface plus le statut lu en dehors du modèle");
  });

  it("le bandeau suit le DERNIER statut réellement lu, jamais l'état affiché, et reste rendu tant qu'une salle est ouverte", () => {
    assert.match(balise("OmoBanner"), /demandeActive=\{demandeEnCours\(/, "demandeActive vient de demandeEnCours (modèle pur)");
    assert.equal(/demandeActive=\{etat\.code/.test(balise("OmoBanner")), false, "plus jamais l'état affiché, qui peut être « illisible »");
    assert.match(page, /\{salle !== null \? \(\s*<OmoBanner\b/, "le bandeau ne dépend que de la salle ouverte et de demandeEnCours");
  });

  it("l'état affiché reçoit « illisible », et [Envoyer] se ferme tant que l'état n'est pas lu", () => {
    assert.match(page, /vueEtatSalle\(\{[^}]*\billisible\b/, "vueEtatSalle sait que la lecture a échoué");
    assert.match(page, /disabled=\{[^}]*ETAT_ILLISIBLE/, "[Envoyer] fermé : l'écran d'activation dirait « coupée » à tort");
  });

  it("l'attente pleine page ne remplace jamais une salle ouverte (bandeau, conversation et [Arrêter] restent montés)", () => {
    const attente = /if \(([^)]*chargement[^{]*)\)\s*\{\s*return \(\s*<div className="page">\s*<Spinner large \/>/.exec(page);
    assert.ok(attente !== null, "la page garde son attente pleine page");
    assert.match(attente[1] ?? "", /salle === null/, "l'attente n'efface pas une salle ouverte");
    assert.match(attente[1] ?? "", /!lecture\.illisible/, "ni une page dont la dernière lecture a échoué");
  });
});

// =================================================================================================================================
// Relecture 2ter-vague-2, constat n° 1 (justesse) : le bandeau de la salle était livré sans [Journal], et les blocs « détections »
// et « quarantaine » du Journal (L26b) ne recevaient jamais de données. La page rend maintenant le Journal du contrôle de SA
// racine (décisions par GET …/activity, permis en mode Avancé), l'ouvre par [Journal] et lui passe détections et quarantaine.
// =================================================================================================================================

describe("Salle OMO : données du Journal de la salle (salle-journal.ts, relecture 2ter-vague-2)", () => {
  it("détection du flux : cause connue lue, racine gardée, fichiers signalés de genre connu seulement", () => {
    assert.deepEqual(
      lireDetection({
        rootId: "ses_salle",
        cause: "git-cree",
        signales: [
          { chemin: "a/.git.suspect-1", genre: "git-quarantaine" },
          { chemin: "a/x", genre: "inconnu" },
          { chemin: 3, genre: "ide-ci" },
          "texte",
        ],
      }),
      { rootId: "ses_salle", cause: "git-cree", signales: [{ chemin: "a/.git.suspect-1", genre: "git-quarantaine" }] },
    );
    assert.deepEqual(lireDetection({ rootId: null, cause: "activite-hors-demande" }), {
      rootId: null,
      cause: "activite-hors-demande",
      signales: [],
    });
  });

  it("données non fiables : cause absente ou inconnue écartée, jamais « undefined » à l'écran", () => {
    for (const data of [null, "texte", 3, {}, { cause: 3 }, { cause: "inventee" }, { cause: "toString" }]) {
      assert.equal(lireDetection(data), null, JSON.stringify(data));
    }
    // Chaque cause du contrat est lisible, et a sa phrase.
    for (const cause of OMO_DETECTION_CAUSES) assert.equal(lireDetection({ rootId: "r", cause })?.cause, cause, cause);
  });

  it("Journal de la racine ouverte : ses détections et celles hors demande, jamais celles d'une autre racine", () => {
    let recues = ajouterDetection([], { rootId: "ses_salle", cause: "git-cree", signales: [{ chemin: "a/.git.suspect-1", genre: "git-quarantaine" }] }, "d1", 1_000);
    recues = ajouterDetection(recues, { rootId: "ses_autre", cause: "racine-etrangere", signales: [{ chemin: "b/x", genre: "ide-ci" }] }, "d2", 2_000);
    recues = ajouterDetection(recues, { rootId: null, cause: "activite-hors-demande", signales: [] }, "d3", 3_000);
    recues = ajouterDetection(
      recues,
      { rootId: "ses_salle", cause: "ide-ci-modifie", signales: [{ chemin: "a/.git.suspect-1", genre: "git-quarantaine" }, { chemin: "a/.vscode/tasks.json", genre: "ide-ci" }] },
      "d4",
      4_000,
    );
    const journal = journalDeLaSalle("ses_salle", recues);
    assert.deepEqual(journal.detections, [
      { id: "d1", at: 1_000, cause: "git-cree" },
      { id: "d3", at: 3_000, cause: "activite-hors-demande" },
      { id: "d4", at: 4_000, cause: "ide-ci-modifie" },
    ]);
    assert.deepEqual(journal.quarantaine, [
      { chemin: "a/.git.suspect-1", genre: "git-quarantaine" },
      { chemin: "a/.vscode/tasks.json", genre: "ide-ci" },
    ], "fichiers mis de côté sans doublon, dans l'ordre d'arrivée");
    assert.deepEqual(journalDeLaSalle("ses_vide", []), { detections: [], quarantaine: [] });
  });

  it("détections gardées pendant la visite : bornées, les plus anciennes sortent", () => {
    let recues: ReturnType<typeof ajouterDetection> = [];
    for (let i = 0; i < DETECTIONS_MAX + 5; i += 1) recues = ajouterDetection(recues, { rootId: "r", cause: "git-cree", signales: [] }, `d${i}`, i);
    assert.equal(recues.length, DETECTIONS_MAX);
    assert.equal(recues[0]?.id, "d5");
    assert.equal(recues.at(-1)?.id, `d${DETECTIONS_MAX + 4}`);
  });

  it("relecture du Journal : après une décision de CETTE racine seulement", () => {
    assert.equal(relireJournalApres("autonomie.decision", { rootId: "ses_salle", verdict: "refus-interdit" }, "ses_salle"), true);
    assert.equal(relireJournalApres("activite.fait", { rootId: "ses_salle", kind: "decision" }, "ses_salle"), true);
    assert.equal(relireJournalApres("activite.fait", { rootId: "ses_salle", kind: "statut" }, "ses_salle"), false);
    assert.equal(relireJournalApres("autonomie.decision", { rootId: "ses_autre" }, "ses_salle"), false);
    assert.equal(relireJournalApres("omo.etat", { rootId: "ses_salle" }, "ses_salle"), false);
    assert.equal(relireJournalApres("autonomie.decision", null, "ses_salle"), false);
  });
});

describe("Salle OMO : [Journal] du bandeau ouvre le Journal du contrôle de la salle (source, relecture 2ter-vague-2)", () => {
  const page = sansCommentaires(fs.readFileSync(PAGE, "utf8"));
  const bandeau = sansCommentaires(fs.readFileSync(BANDEAU, "utf8"));
  const balise = (nom: string): string => {
    const trouvee = new RegExp(`<${nom}\\b[\\s\\S]*?/>`).exec(page);
    assert.ok(trouvee !== null, `<${nom} … /> est rendu par la page`);
    return trouvee[0];
  };

  it("la page passe onOpenJournal au bandeau, qui rend alors [Journal] avec le libellé du modèle", () => {
    assert.match(balise("OmoBanner"), /\bonOpenJournal=\{/, "sans onOpenJournal, OmoBanner ne rend pas [Journal]");
    // Côté bandeau, le bouton n'existe que si la page le demande, et porte TEXTES.avance.bandeau.journal (vueBandeau().journal).
    assert.match(bandeau, /\{onOpenJournal \? \(\s*<Button[^>]*onClick=\{onOpenJournal\}[^>]*>\s*\{vue\.journal\}/);
  });

  it("la page rend le Journal du contrôle de sa racine : décisions lues, détections et fichiers mis de côté passés", () => {
    assert.match(page, /import \{ ControlJournal, useControlDecisions \} from "\.\.\/chat\/autonomy\/ControlJournal\.tsx";/);
    assert.match(page, /useControlDecisions\(rootId, /, "les décisions de la racine de la salle sont lues (GET …/activity)");
    const journal = balise("ControlJournal");
    for (const propriete of ["decisions", "chargement", "error", "detections", "quarantaine"]) {
      assert.match(journal, new RegExp(`\\b${propriete}=\\{`), propriete);
    }
    assert.match(page, /journalDeLaSalle\(/, "détections et quarantaine viennent du modèle pur de la page");
    assert.match(page, /<JournalSalle\b[^>]*\brootId=\{salle\.rootId\}/, "le Journal est celui de la racine ouverte");
  });

  it("[Journal] amène le Journal à l'écran et y place le focus (modèle du journalNonce du Déroulé)", () => {
    const section = /<section\b[^>]*className="card omo-journal"[^>]*>/.exec(page)?.[0] ?? "";
    assert.match(section, /tabIndex=\{-1\}/, "la section est focalisable par programme");
    assert.match(section, /ref=\{/);
    assert.match(page, /scrollIntoView\(\{ block: "nearest" \}\)/);
    assert.match(page, /focus\(\{ preventScroll: true \}\)/);
  });
});
