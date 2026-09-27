// Lancement d'une équipe dans le chat (1.1, itération 4, L38a ; plan it4 §6 fiche L38a, §4.1.1, D-eq-13, D-eq-17, D-eq-24 ;
// spécification §7.8 l.1184, §3.13 l.413-414, §5.5, §5.6 ; C §9.4 corrigée). Deux parties :
// - le MODÈLE PUR web/pages/chat/team/launch-sheet-model.ts : menu du lanceur, feuille, confirmations, corps du lancement et
//   fraîcheur de l'instantané, sans navigateur ni réseau ;
// - la LECTURE DES SOURCES des deux composants et de la feuille de style : aucun texte en dur, tout passe par le client de T4,
//   motif de menu APG, bloc de contraste forcé.
// Chaque garde a son contrôle discriminant : la règle est aussi vérifiée sur l'entrée qui doit la faire échouer.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import {
  accordsApresRefus,
  AUCUN_ACCORD,
  type AccordsFeuille,
  blocsFeuille,
  confirmationDuRefus,
  confirmationsDuCorps,
  corpsLancement,
  DELAI_REESTIMATION_MIN_MS,
  delaiAvantReestimation,
  enTeteConfirmation,
  estimationAFaire,
  type EtatFeuille,
  MARGE_EXPIRATION_MS,
  refusDemandeReestimation,
  vueFeuille,
  vueLanceur,
} from "../web/pages/chat/team/launch-sheet-model.ts";
import { TEAM_ERROR_CODES } from "./shared/team-limits.ts";
import { montant, TEXTES } from "./shared/team-texts.ts";
import type { FlowRow, StepEstimate, TeamEstimateResponse, TeamsListResponse, TeamView } from "./shared/team-types.ts";

const P = TEXTES.partout;
const MAINTENANT = 1_800_000_000_000;

// --- Montages -------------------------------------------------------------------------------------------------------------------

const LAYOUT: FlowRow[] = [
  {
    bloc: "avis-1",
    kind: "avis",
    cellules: [
      { stepId: "exactitude", titre: "Exactitude", sousTitre: "relire-requete-sql" },
      { stepId: "performance", titre: "Performance et verrous", sousTitre: "relire-requete-sql" },
    ],
    recoitDe: [],
  },
  { bloc: "avis-1", kind: "synthese", cellules: [{ stepId: "synthese", titre: "Synthèse", sousTitre: "relire-requete-sql" }], recoitDe: ["exactitude", "performance"] },
];

function equipe(sur: Partial<TeamView> = {}): TeamView {
  return {
    id: "revue-sql-replica",
    titre: "Revue SQL sur réplica",
    description: "",
    flow: { version: 1, blocs: [] },
    forme: "avis",
    origine: "exemple",
    exempleId: "revue-sql",
    etat: "ok",
    estimate: null,
    layout: LAYOUT,
    liste: [],
    droits: [],
    dernierLancement: null,
    ...sur,
  };
}

function etape(stepId: string, titre: string, sur: Partial<StepEstimate> = {}): StepEstimate {
  return { stepId, titre, assistant: "relire-requete-sql", model: null, modelLabel: null, niveau: null, choisieParEquipe: false, typique: 0.2, maximum: 0.5, source: "profil", ...sur };
}

function estimation(sur: Partial<TeamEstimateResponse> = {}): TeamEstimateResponse {
  return {
    estimate: {
      typique: 0.6,
      maximum: 2,
      plafond: 2,
      etapesFacturees: 3,
      depassementUnAppel: 0.35,
      relais: 0.05,
      parEtape: [etape("exactitude", "Exactitude"), etape("performance", "Performance et verrous"), etape("synthese", "Synthèse")],
    },
    estimateSha256: "a".repeat(64),
    problems: [],
    plafond: 2,
    confirmations: [],
    blocage: null,
    expireA: MAINTENANT + 600_000,
    deja: null,
    ...sur,
  };
}

function etat(sur: Partial<EtatFeuille> = {}): EtatFeuille {
  return { equipe: equipe(), advanced: true, estimation: estimation(), estimationEnCours: false, refus: null, accords: AUCUN_ACCORD, occupee: false, envoiEnCours: false, detailOuvert: false, ...sur };
}

const refus = (code: string, details: Record<string, unknown> | null = null, message = "") => ({ status: 409, code, message, details });
const accords = (sur: Partial<AccordsFeuille>): AccordsFeuille => ({ ...AUCUN_ACCORD, ...sur });

function liste(sur: Partial<TeamsListResponse> = {}): TeamsListResponse {
  return { teams: [equipe()], exemples: [], ouvertesEnSimple: false, ...sur };
}

// --- Lanceur ----------------------------------------------------------------------------------------------------------------------

describe("L38a, lanceur : mode Simple fermé (U1, D-eq-13)", () => {
  it("absent en Simple tant que ouvertesEnSimple est faux, présent dès qu'elle est vraie et toujours présent en Avancé", () => {
    const entree = { liste: liste(), advanced: false, busy: false, demandeVide: false };
    assert.equal(vueLanceur(entree).visible, false);
    assert.equal(vueLanceur({ ...entree, liste: liste({ ouvertesEnSimple: true }) }).visible, true);
    assert.equal(vueLanceur({ ...entree, advanced: true }).visible, true);
  });

  it("liste pas encore lue : aucun lanceur, jamais une liste supposée", () => {
    assert.equal(vueLanceur({ liste: null, advanced: true, busy: false, demandeVide: false }).visible, false);
  });
});

describe("L38a, lanceur : bouton, raisons et éléments du menu", () => {
  const entree = { liste: liste(), advanced: true, busy: false, demandeVide: false };

  it("actif avec une équipe lançable, une demande écrite et une conversation au repos", () => {
    const vue = vueLanceur(entree);
    assert.equal(vue.libelle, "Lancer une équipe");
    assert.equal(vue.actif, true);
    assert.equal(vue.raison, null);
    assert.deepEqual(
      vue.items.map((item) => [item.titre, item.sousTitre, item.lancable]),
      [["Revue SQL sur réplica", "Avis indépendants · 3 étapes", true]],
    );
  });

  it("désactivé avec sa raison : conversation qui travaille, saisie vide, aucune équipe installée", () => {
    assert.equal(vueLanceur({ ...entree, busy: true }).actif, false);
    assert.equal(vueLanceur({ ...entree, busy: true }).raison, "Une réponse est en cours dans cette conversation : attendez sa fin.");
    assert.equal(vueLanceur({ ...entree, demandeVide: true }).actif, false);
    assert.equal(vueLanceur({ ...entree, demandeVide: true }).raison, "Écrivez d'abord votre demande dans la saisie.");
    const vide = vueLanceur({ ...entree, liste: liste({ teams: [] }) });
    assert.equal(vide.actif, false);
    assert.equal(vide.raison, "Aucune équipe installée : ouvrez l'onglet Équipes des assistants.");
  });

  it("équipe non lançable dans le mode courant : élément gardé, désactivé, avec sa raison ; bouton inactif si c'est la seule", () => {
    const aCompleter = vueLanceur({ ...entree, liste: liste({ teams: [equipe({ etat: "a-completer" })] }) });
    assert.equal(aCompleter.items[0]?.lancable, false);
    assert.equal(aCompleter.items[0]?.raison, "Un assistant de l'équipe n'est plus installé.");
    assert.equal(aCompleter.actif, false);

    const avancee = liste({ teams: [equipe({ etat: "avance" })], ouvertesEnSimple: true });
    const enSimple = vueLanceur({ ...entree, advanced: false, liste: avancee });
    assert.equal(enSimple.items[0]?.lancable, false);
    assert.equal(enSimple.items[0]?.raison, P.onglet.etatsAide.avance);
    // La même équipe est lançable en mode Avancé : la raison tient au mode, pas à l'équipe.
    assert.equal(vueLanceur({ ...entree, liste: avancee }).items[0]?.lancable, true);
  });
});

// --- Feuille : corps affiché --------------------------------------------------------------------------------------------------------

describe("L38a, feuille : textes de C §9.4 corrigée, tous repris de T4t", () => {
  it("titre, confidentialité, ce que fait l'équipe, honnêteté, même fichier, arrêt possible", () => {
    const vue = vueFeuille(etat());
    assert.equal(vue.titre, "Avant de lancer l'équipe « Revue SQL sur réplica »");
    assert.deepEqual(vue.intro, [
      "Votre demande et les fichiers joints partent chez 3 assistants (GitHub Copilot). N'y mettez ni donnée client ni secret.",
      "L'équipe reçoit votre demande et les fichiers joints, pas le reste de la conversation.",
      "Ce que fait l'équipe : lit les fichiers du projet.",
      "Aucune étape ne modifie, ne lance de commande, ne va sur Internet ni ne délègue.",
      "N'ouvre jamais les fichiers de clés ; une recherche dans le projet peut en afficher une ligne.",
      "Chaque avis ne voit pas le travail des autres.",
      "Plusieurs étapes peuvent lire le même fichier.",
      "Vous pouvez arrêter l'équipe à tout moment.",
    ]);
  });

  it("déroulé sans bloc d'avis : la phrase des avis n'est pas affichée", () => {
    const suite: FlowRow[] = [{ bloc: "e1", kind: "etape", cellules: [{ stepId: "standards", titre: "Standards de l'équipe", sousTitre: "relire-script" }], recoitDe: [] }];
    assert.equal(vueFeuille(etat({ equipe: equipe({ layout: suite }) })).intro.includes(P.honnetete.avis), false);
  });

  it("liste des blocs : « En même temps : … » pour un bloc d'avis, le titre seul sinon", () => {
    assert.deepEqual(blocsFeuille(LAYOUT), ["En même temps : Exactitude, Performance et verrous", "Synthèse"]);
    assert.deepEqual(blocsFeuille([{ bloc: "p", kind: "pause", cellules: [{ stepId: null, titre: "Pause pour vérifier", sousTitre: "" }], recoitDe: [] }]), ["Pause pour vérifier"]);
  });

  it("coût et arrêt automatique : montants écrits par montant(), jamais un « $ » en double", () => {
    const vue = vueFeuille(etat());
    assert.equal(vue.cout, "Coût : ≈ 0,60 $ en général · 2 $ au plus (arrêt automatique) · 3 étapes facturées");
    assert.equal(vue.arret, "Arrêt automatique à 2 $ ; un appel en cours peut le dépasser d'environ 0,35 $.");
    assert.equal(vue.arret?.includes("$ $"), false);
    assert.equal(montant(0.6), "0,60");
  });

  it("détail par étape : IA de l'étape en Avancé seulement, et seulement quand l'équipe l'a choisie (§3.13 l.413)", () => {
    const choisie = estimation({
      estimate: { ...estimation().estimate, parEtape: [etape("exactitude", "Exactitude", { choisieParEquipe: true, modelLabel: "Rapide" }), etape("synthese", "Synthèse")] },
    });
    const avance = vueFeuille(etat({ advanced: true, estimation: choisie }));
    assert.equal(avance.detail?.libelle, "Détail par étape");
    assert.equal(avance.detail?.lignes[0]?.texte, "Exactitude · relire-requete-sql · ≈ 0,20 $ en général, 0,50 $ en estimation haute");
    assert.equal(avance.detail?.lignes[0]?.ia, "IA de l'étape : Rapide (choisie par l'équipe)");
    assert.equal(avance.detail?.lignes[1]?.ia, null);
    // Simple : aucune IA par étape (décision n° 3), les lignes de coût restent.
    const simple = vueFeuille(etat({ advanced: false, estimation: choisie }));
    assert.deepEqual(
      simple.detail?.lignes.map((ligne) => ligne.ia),
      [null, null],
    );
    assert.equal(simple.detail?.lignes.length, 2);
  });

  it("estimation en cours : corps en attente, aucune confirmation, bouton inactif", () => {
    const vue = vueFeuille(etat({ estimationEnCours: true }));
    assert.equal(vue.chargement, true);
    assert.deepEqual(vue.confirmations, []);
    assert.equal(vue.lancer.actif, false);
  });

  it("estimation impossible : plus d'attente, la phrase est affichée, le lancement reste fermé", () => {
    const vue = vueFeuille(etat({ estimation: null, estimationEnCours: false, refus: refus("opencode-injoignable") }));
    assert.equal(vue.chargement, false);
    assert.deepEqual(vue.intro, []);
    assert.equal(vue.cout, null);
    assert.equal(vue.detail, null);
    assert.ok(vue.alerte !== null && vue.alerte.texte.startsWith("opencode ne répond pas"), vue.alerte?.texte ?? "");
    assert.equal(vue.lancer.actif, false);
  });
});

// --- Feuille : refus, blocage et confirmations ----------------------------------------------------------------------------------

describe("L38a, feuille : refus prévisible avant tout clic (D-eq-17, A4)", () => {
  it("blocage de l'estimation : [Lancer l'équipe] désactivé, raison écrite près de lui", () => {
    const vue = vueFeuille(etat({ estimation: estimation({ blocage: { status: 409, code: "extension-configuree" } }) }));
    assert.equal(vue.lancer.actif, false);
    assert.ok(vue.lancer.raison?.startsWith("L'équipe ne peut pas être lancée pour l'instant. "), vue.lancer.raison ?? "");
    assert.ok(vue.lancer.raison?.includes("outils MCP"), vue.lancer.raison ?? "");
    // Contrôle discriminant : sans blocage, le bouton est actif.
    assert.equal(vueFeuille(etat()).lancer.actif, true);
  });

  it("problème bloquant du déroulé : bouton désactivé, raison du problème et [Modifier l'équipe]", () => {
    const vue = vueFeuille(etat({ estimation: estimation({ problems: [{ code: "assistant-absent", bloc: "avis-1", etape: "exactitude", bloquant: true }] }) }));
    assert.equal(vue.lancer.actif, false);
    assert.equal(vue.lancer.raison, "L'assistant choisi n'est pas installé : installez-le ou choisissez-en un autre.");
    assert.equal(vue.modifierEquipe, "Modifier l'équipe");
    // Un problème non bloquant ne ferme pas le lancement.
    assert.equal(vueFeuille(etat({ estimation: estimation({ problems: [{ code: "titre", bloc: null, etape: "exactitude", bloquant: false }] }) })).lancer.actif, true);
  });

  it("conversation occupée : bouton désactivé avec sa raison", () => {
    const vue = vueFeuille(etat({ occupee: true }));
    assert.equal(vue.lancer.actif, false);
    assert.equal(vue.lancer.raison, "Une réponse est en cours dans cette conversation : attendez sa fin.");
  });
});

describe("L38a, feuille : un état et un texte par code de refus", () => {
  it("chaque code de TeamErrorCode rend un état complet : confirmation, information ou refus écrit", () => {
    for (const code of TEAM_ERROR_CODES) {
      const vue = vueFeuille(etat({ refus: refus(code) }));
      const cle = confirmationDuRefus(code);
      if (cle !== null) {
        assert.ok(
          vue.confirmations.some((confirmation) => confirmation.cle === cle && confirmation.texte.trim() !== ""),
          `confirmation attendue pour ${code}`,
        );
        assert.equal(vue.alerte, null, code);
      } else {
        assert.ok(vue.alerte !== null && vue.alerte.texte.trim() !== "", `texte attendu pour ${code}`);
      }
    }
  });

  it("refus ordinaire : phrase du code suivie de « Rien n'a été envoyé ni facturé. » (A4)", () => {
    const vue = vueFeuille(etat({ refus: refus("fichier-refuse") }));
    assert.equal(vue.alerte?.ton, "refus");
    assert.ok(vue.alerte?.texte.startsWith("Un fichier joint est refusé"), vue.alerte?.texte ?? "");
    assert.ok(vue.alerte?.texte.endsWith("Rien n'a été envoyé ni facturé."), vue.alerte?.texte ?? "");
  });

  it("code inconnu (garde de rechargement, panne) : message du serveur ou phrase générale, jamais « Rien n'a été envoyé »", () => {
    const garde = vueFeuille(etat({ refus: refus("sessions-busy", null, "Une réponse est en cours : réessayez après.") }));
    assert.equal(garde.alerte?.texte, "Une réponse est en cours : réessayez après.");
    const muet = vueFeuille(etat({ refus: refus("", null, "") }));
    assert.equal(muet.alerte?.texte, "Le cockpit a refusé cette action.");
    assert.equal(muet.alerte?.texte.includes("Rien n'a été envoyé"), false);
  });

  it("opencode injoignable (502) et IA indisponible : phrases propres à la feuille", () => {
    assert.equal(vueFeuille(etat({ estimation: null, refus: refus("opencode-injoignable") })).alerte?.texte, "opencode ne répond pas : l'estimation n'a pas pu être faite. Rien n'a été envoyé ni facturé.");
    const ia = vueFeuille(etat({ refus: refus("ia-indisponible", { titre: "Synthèse" }) }));
    assert.equal(ia.alerte?.texte, "L'étape « Synthèse » demande une IA indisponible sur votre compte GitHub Copilot. Rien n'a été envoyé ni facturé.");
    assert.equal(ia.modifierEquipe, "Modifier l'équipe");
    // Sans détail, la phrase générale du code prend la place : aucun gabarit « {titre} » affiché.
    assert.equal(vueFeuille(etat({ refus: refus("ia-indisponible") })).alerte?.texte.includes("{titre}"), false);
  });

  it("estimation périmée : information, nouvelle estimation demandée, jamais un lancement automatique", () => {
    assert.equal(refusDemandeReestimation("estimation-perimee"), true);
    assert.equal(refusDemandeReestimation("budget-guard"), false);
    const vue = vueFeuille(etat({ refus: refus("estimation-perimee") }));
    assert.equal(vue.alerte?.ton, "info");
    assert.equal(vue.alerte?.texte, "L'estimation n'était plus à jour : voici la nouvelle. Rien n'a été envoyé ni facturé.");
    assert.equal(vue.lancer.actif, true);
  });
});

describe("L38a, feuille : confirmations (P7 dans le corps, P6 par l'en-tête)", () => {
  it("« Tout le workspace » : case « Je confirme », bouton bloqué tant qu'elle n'est pas cochée", () => {
    const attendu = etat({ estimation: estimation({ confirmations: ["workspace"] }) });
    const vue = vueFeuille(attendu);
    assert.equal(vue.confirmations[0]?.titre, "Tout le workspace");
    assert.equal(vue.confirmations[0]?.texte, "L'équipe travaille sur tout le workspace : chaque assistant peut lire tous vos projets.");
    assert.equal(vue.confirmations[0]?.controle, "case");
    assert.equal(vue.confirmations[0]?.libelle, "Je confirme");
    assert.equal(vue.lancer.actif, false);
    assert.equal(vue.lancer.raison, "L'équipe travaillerait sur tout le workspace : confirmez d'abord.");
    // Cochée : le bouton s'ouvre.
    assert.equal(vueFeuille({ ...attendu, accords: accords({ workspace: true }) }).lancer.actif, true);
  });

  it("secret probable : [Modifier la demande] et [Lancer quand même], avec le nombre d'envois", () => {
    const vue = vueFeuille(etat({ refus: refus("secret-probable") }));
    assert.equal(vue.confirmations[0]?.texte, "Le cockpit a repéré ce qui ressemble à un secret dans votre demande. Il serait envoyé 3 fois.");
    assert.equal(vue.confirmations[0]?.controle, "bouton");
    assert.equal(vue.confirmations[0]?.libelle, "Lancer quand même");
    assert.equal(vue.confirmations[0]?.secondaire, "Modifier la demande");
    assert.equal(vue.lancer.actif, false);
  });

  it("plafond trop haut : refus en Simple (rien à cocher), confirmation en Avancé", () => {
    const details = { permis: 1 };
    const simple = vueFeuille(etat({ advanced: false, refus: refus("plafond-trop-haut", details) }));
    assert.equal(simple.confirmations[0]?.controle, "aucun");
    assert.equal(simple.confirmations[0]?.texte, "Le plafond d'arrêt de cette équipe (2 $) dépasse le plafond maximum d'un lancement (1 $), réglable en mode Avancé dans Paramètres › Budget.");
    assert.equal(simple.lancer.actif, false);
    assert.equal(simple.lancer.raison, simple.confirmations[0]?.texte);

    const avance = vueFeuille(etat({ advanced: true, refus: refus("plafond-a-confirmer", details) }));
    assert.equal(avance.confirmations[0]?.controle, "case");
    assert.equal(avance.confirmations[0]?.texte, "Le plafond d'arrêt de cette équipe (2 $) dépasse le plafond maximum d'un lancement (1 $). Lancer quand même ?");
    assert.equal(vueFeuille({ ...etat({ advanced: true, refus: refus("plafond-a-confirmer", details) }), accords: accords({ plafond: true }) }).lancer.actif, true);
  });

  it("budget restant et garde-fou budgétaire : montants quand ils sont connus, texte du serveur pour P6", () => {
    const budget = vueFeuille(etat({ refus: refus("budget-insuffisant", { reste: 0.5 }) }));
    assert.equal(budget.confirmations[0]?.texte, "Le plafond d'arrêt de cette équipe (2 $) dépasse ce qui reste sur le budget du mois (0,50 $). Lancer quand même ?");
    // Détails absents (confirmation annoncée par l'estimation) : phrase du code, sans gabarit resté en place.
    const annonce = vueFeuille(etat({ estimation: estimation({ confirmations: ["budget"] }) }));
    assert.equal(annonce.confirmations[0]?.texte.includes("{"), false);
    assert.ok(annonce.confirmations[0]?.texte.startsWith("Le plafond d'arrêt de cette équipe dépasse"), annonce.confirmations[0]?.texte ?? "");

    const garde = vueFeuille(etat({ refus: refus("budget-guard", null, "Demande coûteuse : 82 % du budget du mois. Lancer quand même ?") }));
    assert.equal(garde.confirmations[0]?.cle, "gardeBudget");
    assert.equal(garde.confirmations[0]?.texte, "Demande coûteuse : 82 % du budget du mois. Lancer quand même ?");
  });

  it("confirmation annoncée par l'estimation puis redemandée par un refus : une seule entrée", () => {
    const vue = vueFeuille(etat({ estimation: estimation({ confirmations: ["workspace"] }), refus: refus("confirmation-workspace") }));
    assert.equal(vue.confirmations.length, 1);
  });

  it("accord remis à zéro par le refus qui le demande, les autres gardés", () => {
    const avant = accords({ workspace: true, secret: true });
    assert.deepEqual(accordsApresRefus(avant, "secret-probable"), accords({ workspace: true }));
    assert.deepEqual(accordsApresRefus(avant, "not-found"), avant);
  });
});

// --- Envoi ------------------------------------------------------------------------------------------------------------------------

describe("L38a, envoi : confirmations seulement après un clic, empreinte toujours jointe", () => {
  const base = { directory: "C:/projets/reporting", rootId: "ses_1", demande: "Relis cette requête", fichiers: ["requete.sql"], agentConversation: "general", estimateSha256: "b".repeat(64) };

  it("aucun accord : corps sans confirmation et sans en-tête de confirmation", () => {
    const corps = corpsLancement({ ...base, accords: AUCUN_ACCORD });
    assert.deepEqual(corps.confirmations, {});
    assert.deepEqual(enTeteConfirmation(AUCUN_ACCORD), {});
    assert.equal(corps.estimateSha256, "b".repeat(64));
    assert.deepEqual(corps.fichiers, ["requete.sql"]);
  });

  it("accords donnés : P7 dans le corps, garde-fou budgétaire P6 par l'en-tête seulement", () => {
    const tous = accords({ workspace: true, secret: true, plafond: true, budget: true, gardeBudget: true });
    assert.deepEqual(confirmationsDuCorps(tous), { workspace: true, secret: true, plafond: true, budget: true });
    assert.equal(Object.hasOwn(confirmationsDuCorps(tous), "gardeBudget"), false);
    assert.deepEqual(enTeteConfirmation(tous), { confirm: true });
    assert.deepEqual(enTeteConfirmation(accords({ workspace: true })), {});
  });

  it("les fichiers du brouillon sont recopiés : le corps ne garde pas la référence du tableau", () => {
    const fichiers = ["requete.sql"];
    const corps = corpsLancement({ ...base, fichiers, accords: AUCUN_ACCORD });
    fichiers.push("secret.env");
    assert.deepEqual(corps.fichiers, ["requete.sql"]);
  });
});

describe("L38a, fraîcheur de l'instantané (D-eq-17)", () => {
  it("instantané absent ou bientôt périmé : nouvelle estimation avant tout envoi", () => {
    assert.equal(estimationAFaire(null, MAINTENANT), true);
    assert.equal(estimationAFaire(estimation({ expireA: MAINTENANT + MARGE_EXPIRATION_MS + 1 }), MAINTENANT), false);
    assert.equal(estimationAFaire(estimation({ expireA: MAINTENANT + MARGE_EXPIRATION_MS }), MAINTENANT), true);
    assert.equal(estimationAFaire(estimation({ expireA: MAINTENANT - 1 }), MAINTENANT), true);
  });

  it("minuteur de ré-estimation : armé avant `expireA`, jamais en dessous du délai minimum (aucune suite de lectures serrées)", () => {
    assert.equal(delaiAvantReestimation(estimation({ expireA: MAINTENANT + 600_000 }), MAINTENANT), 600_000 - MARGE_EXPIRATION_MS);
    assert.equal(delaiAvantReestimation(estimation({ expireA: MAINTENANT - 60_000 }), MAINTENANT), DELAI_REESTIMATION_MIN_MS);
    assert.equal(delaiAvantReestimation(null, MAINTENANT), DELAI_REESTIMATION_MIN_MS);
    assert.ok(DELAI_REESTIMATION_MIN_MS > 0);
  });
});

// --- Sources ------------------------------------------------------------------------------------------------------------------------

const APP_DIR = path.join(import.meta.dirname, "..");
const read = (fichier: string) => fs.readFileSync(path.join(APP_DIR, fichier), "utf8");
const blank = (texte: string) => texte.replace(/[^\n]/g, " ");
const sansCommentaires = (texte: string) => texte.replace(/\/\*[\s\S]*?\*\//g, blank).replace(/\/\/[^\n]*/g, blank);
const TSX = ["web/pages/chat/team/TeamLauncher.tsx", "web/pages/chat/team/TeamLaunchSheet.tsx"];

/** Texte écrit directement entre deux balises JSX (`>texte</`), jamais admis : tout texte vient du modèle. */
const TEXTE_JSX = />\s*([A-Za-zÀ-ÿ][^<>{}]*?)\s*<\//g;

/** Chaînes littérales d'un source, hors des lignes de journal (console.*), qui ne sont pas des textes d'interface. */
function litteraux(code: string): string[] {
  const out: string[] = [];
  for (const match of code.matchAll(/"([^"\\\n]*)"|'([^'\\\n]*)'/g)) {
    const ligneDebut = code.lastIndexOf("\n", match.index ?? 0) + 1;
    const finLigne = code.indexOf("\n", match.index ?? 0);
    const ligne = code.slice(ligneDebut, finLigne === -1 ? undefined : finLigne);
    if (ligne.includes("console.")) continue;
    out.push(match[1] ?? match[2] ?? "");
  }
  return out;
}

describe("L38a, sources : aucun texte en dur (tout vient de T4t par le modèle)", () => {
  for (const fichier of TSX) {
    it(`${fichier} : aucune lettre accentuée dans une chaîne, aucun texte JSX écrit`, () => {
      const code = sansCommentaires(read(fichier));
      assert.deepEqual(
        litteraux(code).filter((valeur) => /[À-ÿ]/.test(valeur)),
        [],
      );
      assert.deepEqual([...code.matchAll(TEXTE_JSX)].map((m) => m[1]), []);
    });

    it(`${fichier} : les textes passent par le modèle, jamais par un import direct de team-texts`, () => {
      assert.equal(sansCommentaires(read(fichier)).includes("team-texts.ts"), false);
    });
  }

  it("contrôles discriminants : une phrase en dur et un import direct seraient relevés", () => {
    assert.deepEqual(litteraux('const a = "Lancer l\'équipe";').filter((v) => /[À-ÿ]/.test(v)), ["Lancer l'équipe"]);
    assert.deepEqual(litteraux('console.warn("équipes : illisible");'), []);
    assert.deepEqual([...'<p>Avant de lancer</p>'.matchAll(TEXTE_JSX)].map((m) => m[1]), ["Avant de lancer"]);
  });
});

describe("L38a, sources : appels par le client de T4, menu APG, contraste forcé", () => {
  it("TeamLauncher : propriétaire, propriétés figées, bouton de menu et lecture de GET /api/teams", () => {
    const code = read("web/pages/chat/team/TeamLauncher.tsx");
    assert.equal((code.split("\n")[0] ?? "").replace(/\r$/, ""), "// Propriétaire : L38a.");
    assert.match(code, /import type \{ TeamLauncherProps \} from "\.\/slots\.ts";/);
    assert.match(code, /export function TeamLauncher\(\{[^)]*\}: TeamLauncherProps\)/);
    assert.match(code, /aria-haspopup="menu"/);
    assert.match(code, /role="menu"/);
    assert.match(code, /teamsApi\.list\(/);
    // Clavier APG repris du module partagé, jamais réécrit ici.
    assert.match(code, /from "\.\.\/\.\.\/\.\.\/\.\.\/server\/shared\/autonomy-menu\.ts";/);
  });

  it("TeamLaunchSheet : estimation à l'ouverture, lancement par api-teams, aucun appel direct au réseau", () => {
    const code = sansCommentaires(read("web/pages/chat/team/TeamLaunchSheet.tsx"));
    assert.match(code, /teamsApi\.estimate\(/);
    assert.match(code, /teamsApi\.run\(/);
    for (const interdit of [/\bfetch\s*\(/, /x-cockpit-csrf/, /x-cockpit-confirm/]) assert.doesNotMatch(code, interdit);
    // L'empreinte et l'en-tête de confirmation passent par le modèle pur.
    assert.match(code, /estimateSha256: estimation\.estimateSha256/);
    assert.match(code, /enTeteConfirmation\(accords\)/);
  });

  it("team-launch.css : bloc @media (forced-colors: active) non vide (U9, spécification §5.5 l.922)", () => {
    const css = read("web/pages/chat/team/team-launch.css").replace(/\/\*[\s\S]*?\*\//g, blank);
    const bloc = /@media\b[^{]*\(\s*forced-colors\s*:\s*active\s*\)\s*\{\s*[^}\s]/.exec(css);
    assert.ok(bloc !== null, "bloc forced-colors absent ou vide");
    assert.match(css, /outline:\s*2px solid Highlight/);
    assert.match(css, /color:\s*CanvasText/);
    assert.match(css, /border:\s*1px solid CanvasText/);
  });
});
