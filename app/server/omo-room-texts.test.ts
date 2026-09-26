// Tests T3a : textes de la Salle OMO (omo-room-texts.ts), plan d'exécution 2 bis-2 ter §4.1.5 ; spécification §2.3 l.102-105,
// §4.14.6 l.854-868, §6 l.1052-1067, P3 l.38.
// Chaque garde est d'abord éprouvée sur un module factice (elle échoue quand la règle est violée), puis appliquée aux textes
// livrés : une phrase par code des six unions, « agent » et « orchestrateur » en mode Avancé seulement et accolés à un nom de
// rôle, « bloque toujours » absent, « au plus » réservé aux deux phrases garanties, phrases réécrites (D-2b-38) à l'octet et
// ancienne formulation de l.863 absente, gabarits connus et cohérents, sections (rien en `simple`).
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  EGRESS_REFUSAL_REASONS,
  OMO_ACTIVATION_REFUSAL_CODES,
  OMO_DETECTION_CAUSES,
  OMO_FORBIDDEN_CATEGORIES,
  OMO_PRECHECK_REASONS,
  OMO_STOP_CAUSES,
} from "./omo-contracts.ts";
import {
  libelleInterdit,
  libelleSortieRefusee,
  phraseArret,
  phraseDetection,
  phrasePrecontrole,
  phraseRefusActivation,
  TEXTES,
} from "./shared/omo-room-texts.ts";

type Section = "simple" | "avance" | "partout";

interface Feuille {
  chemin: string;
  texte: string;
}

/** Feuilles (chaînes) d'une valeur de TEXTES, avec leur chemin. */
function feuilles(valeur: unknown, chemin: string): Feuille[] {
  if (typeof valeur === "string") return [{ chemin, texte: valeur }];
  if (valeur === null || typeof valeur !== "object") return [];
  return Object.entries(valeur).flatMap(([cle, sous]) => feuilles(sous, chemin === "" ? cle : `${chemin}.${cle}`));
}

function feuillesDe(textes: Record<Section, unknown>): Feuille[] {
  return (["simple", "avance", "partout"] as const).flatMap((section) => feuilles(textes[section], section));
}

const TOUTES = feuillesDe(TEXTES);
const TEXTE = (chemin: string): string => {
  const trouvee = TOUTES.find((f) => f.chemin === chemin);
  assert.ok(trouvee, chemin);
  return trouvee.texte;
};

// --- Gardes, éprouvées sur des textes factices avant d'être appliquées ------------------------------------------------------------

/** §2.3 l.104 : « agent » et « orchestrateur » en mode Avancé seulement, accolés à un nom de rôle français et au nom de l'agent. */
function motsDeRoleMalPlaces(feuillesLues: readonly Feuille[]): string[] {
  const mauvaises: string[] = [];
  for (const { chemin, texte } of feuillesLues) {
    const enAvance = chemin.startsWith("avance.");
    for (const trouve of texte.matchAll(/(?<![\p{L}-])(agents?|orchestrat(?:eur|rice)s?)(?![\p{L}])/giu)) {
      if (!enAvance) {
        mauvaises.push(`${chemin} : ${trouve[0]} hors du mode Avancé`);
        continue;
      }
      const suite = texte.slice((trouve.index ?? 0) + trouve[0].length);
      // « Orchestrateur (Sisyphus) », ou « agent Orchestrateur (Sisyphus) » : le nom de l'agent suit, entre parenthèses.
      if (!/^\s*(?:\p{Lu}[\p{L}'-]*\s*)?\(\p{Lu}[\p{L}'-]*\)/u.test(suite)) mauvaises.push(`${chemin} : ${trouve[0]} sans nom de rôle entre parenthèses`);
    }
  }
  return mauvaises;
}

/** P3 : « bloque toujours » (ou « bloquent toujours ») jamais écrit : le filet n'est pas une garantie. */
function blocageToujours(feuillesLues: readonly Feuille[]): string[] {
  return feuillesLues.filter((f) => /bloqu\p{L}*\s+toujours/iu.test(f.texte)).map((f) => f.chemin);
}

/** P3 : « au plus » seulement dans les deux phrases garanties (homme mort 30 secondes, borne {plafondMaxUsd} du serveur). */
function auPlusHorsGaranties(feuillesLues: readonly Feuille[]): string[] {
  return feuillesLues
    .filter((f) => /(?<![\p{L}-])au plus(?![\p{L}])/iu.test(f.texte))
    .filter((f) => !/30 secondes au plus/.test(f.texte) && !/au plus \{plafondMaxUsd\}/.test(f.texte))
    .map((f) => f.chemin);
}

/** {n} : nombre de fichiers relevés non affichés (`signalesFin.masques`, relecture 2ter-vague-5), seul dans sa phrase. */
const GABARITS_CONNUS = ["projet", "date", "x", "montant", "plafondMaxUsd", "categorie", "liste", "chemin", "n"];

/** Gabarits « {nom} » hors de la liste connue, ou gabarit de gabarit `${…}` (interdit par la convention TEXTES). */
function gabaritsInconnus(feuillesLues: readonly Feuille[]): string[] {
  const mauvais: string[] = [];
  for (const { chemin, texte } of feuillesLues) {
    if (texte.includes("${")) mauvais.push(`${chemin} : gabarit JavaScript`);
    for (const trouve of texte.matchAll(/\{([^{}]*)\}/g)) {
      const nom = trouve[1] ?? "";
      if (!GABARITS_CONNUS.includes(nom)) mauvais.push(`${chemin} : {${nom}}`);
    }
  }
  return mauvais;
}

describe("T3a : gardes des textes de la salle", () => {
  it("mots de rôle : refusés hors du mode Avancé, et en Avancé sans nom entre parenthèses", () => {
    assert.deepEqual(motsDeRoleMalPlaces([{ chemin: "avance.a", texte: "Orchestrateur (Sisyphus) a confié le travail." }]), []);
    assert.deepEqual(motsDeRoleMalPlaces([{ chemin: "avance.b", texte: "L'agent Orchestrateur (Sisyphus) relance." }]), []);
    assert.equal(motsDeRoleMalPlaces([{ chemin: "partout.c", texte: "Orchestrateur (Sisyphus) travaille." }]).length, 1, "hors du mode Avancé");
    assert.equal(motsDeRoleMalPlaces([{ chemin: "avance.d", texte: "L'agent relance la demande." }]).length, 1);
    assert.equal(motsDeRoleMalPlaces([{ chemin: "avance.e", texte: "L'orchestrateur relance la demande." }]).length, 1);
    assert.deepEqual(motsDeRoleMalPlaces([{ chemin: "avance.f", texte: "Le planificateur (Prometheus) modifie." }]), []);
  });

  it("« bloque toujours » : trouvé dans toutes ses formes", () => {
    assert.deepEqual(blocageToujours([{ chemin: "a", texte: "Le filet bloque toujours ces outils." }]), ["a"]);
    assert.deepEqual(blocageToujours([{ chemin: "b", texte: "Ces outils bloquent toujours." }]), ["b"]);
    assert.deepEqual(blocageToujours([{ chemin: "c", texte: "Le filet bloque ces outils." }]), []);
  });

  it("« au plus » : accepté seulement dans les deux phrases garanties", () => {
    assert.deepEqual(auPlusHorsGaranties([{ chemin: "a", texte: "La salle s'arrête en 30 secondes au plus." }]), []);
    assert.deepEqual(auPlusHorsGaranties([{ chemin: "b", texte: "au plus {plafondMaxUsd} $" }]), []);
    assert.deepEqual(auPlusHorsGaranties([{ chemin: "c", texte: "Le coût dépassera d'un appel au plus." }]), ["c"]);
  });

  it("gabarits : nom inconnu ou gabarit JavaScript refusés", () => {
    assert.deepEqual(gabaritsInconnus([{ chemin: "a", texte: "Projet {projet}, montant {montant} $" }]), []);
    assert.deepEqual(gabaritsInconnus([{ chemin: "b", texte: "Montant {montant saisi} $" }]), ["b : {montant saisi}"]);
    assert.deepEqual(gabaritsInconnus([{ chemin: "c", texte: "Coût ${cout}" }]), ["c : gabarit JavaScript", "c : {cout}"]);
  });
});

// --- Textes livrés -----------------------------------------------------------------------------------------------------------------

describe("T3a : une phrase par code, sections et honnêteté", () => {
  it("chaque code des six unions a sa phrase, par la table et par sa fonction", () => {
    /** La table couvre exactement l'union (satisfies dans le module), et la fonction rend la même phrase. */
    const verifieTable = <C extends string>(nom: string, codes: readonly C[], table: Record<C, string>, phrase: (code: C) => string): void => {
      assert.deepEqual(Object.keys(table).sort(), [...codes].sort(), nom);
      for (const code of codes) {
        assert.ok(table[code].length > 0, `${nom} : ${code}`);
        assert.equal(phrase(code), table[code], `${nom} : ${code}`);
      }
    };
    verifieTable("refus d'activation", OMO_ACTIVATION_REFUSAL_CODES, { ...TEXTES.avance.refus, ...TEXTES.partout.refus }, phraseRefusActivation);
    verifieTable("arrêt", OMO_STOP_CAUSES, TEXTES.avance.arrets, phraseArret);
    verifieTable("détection", OMO_DETECTION_CAUSES, TEXTES.avance.detections, phraseDetection);
    verifieTable("interdit", OMO_FORBIDDEN_CATEGORIES, TEXTES.avance.interdits.categories, libelleInterdit);
    verifieTable("pré-contrôle", OMO_PRECHECK_REASONS, TEXTES.avance.precontrole, phrasePrecontrole);
    verifieTable("sortie refusée", EGRESS_REFUSAL_REASONS, TEXTES.avance.sortiesRefusees.raisons, libelleSortieRefusee);
  });

  it("sections : rien en « simple », « partout » réduit au refus lu en mode Simple, tout le reste en « avance »", () => {
    assert.deepEqual(feuilles(TEXTES.simple, "simple"), []);
    assert.deepEqual(feuillesDe(TEXTES).filter((f) => f.chemin.startsWith("partout.")), [
      { chemin: "partout.refus.mode-avance", texte: "La Salle OMO est réservée au mode Avancé." },
    ]);
    assert.ok(TOUTES.length > 80, `${TOUTES.length} phrases`);
    assert.equal(
      TOUTES.every((f) => f.chemin.startsWith("avance.") || f.chemin.startsWith("partout.")),
      true,
    );
  });

  it("mots de rôle, « bloque toujours » et « au plus » : les textes livrés passent les trois gardes", () => {
    assert.deepEqual(motsDeRoleMalPlaces(TOUTES), []);
    assert.deepEqual(blocageToujours(TOUTES), []);
    assert.deepEqual(auPlusHorsGaranties(TOUTES), []);
    // Les deux phrases garanties existent : sans elles, « au plus » ne serait écrit nulle part.
    assert.equal(TOUTES.some((f) => /30 secondes au plus/.test(f.texte)), true);
    assert.equal(TEXTE("avance.activation.champ.borne"), "au plus {plafondMaxUsd} $");
  });

  it("gabarits : tous connus, et présents là où la phrase les exige", () => {
    assert.deepEqual(gabaritsInconnus(TOUTES), []);
    const exige: Array<[string, string[]]> = [
      ["avance.activation.extension", ["{date}"]],
      ["avance.activation.autorise", ["{projet}"]],
      ["avance.activation.champ.borne", ["{plafondMaxUsd}"]],
      ["avance.bandeau.texte", ["{x}", "{montant}"]],
      ["avance.honnetete.coutApresCoup", ["{montant}"]],
      ["avance.honnetete.version", ["{date}"]],
      ["avance.refus.plafond-hors-bornes", ["{plafondMaxUsd}"]],
      ["avance.refus.precheck-refuse", ["{projet}"]],
      ["avance.refus.git-inscriptible", ["{liste}"]],
      ["avance.refus.workspace-non-verifie", ["{liste}"]],
      ["avance.arrets.plafond-cout", ["{x}", "{montant}"]],
      ["avance.interdits.message", ["{categorie}"]],
      ["avance.signales.git-quarantaine", ["{chemin}"]],
      ["avance.signalesFin.masques", ["{n}"]],
    ];
    for (const [chemin, gabarits] of exige) for (const gabarit of gabarits) assert.ok(TEXTE(chemin).includes(gabarit), `${chemin} : ${gabarit}`);
    // Un gabarit ne s'écrit jamais dans une phrase qui ne le remplit pas : {liste} et {chemin} restent dans leurs phrases.
    assert.deepEqual(
      TOUTES.filter((f) => f.texte.includes("{liste}")).map((f) => f.chemin),
      ["avance.refus.git-inscriptible", "avance.refus.workspace-non-verifie"],
    );
    assert.deepEqual(
      TOUTES.filter((f) => f.texte.includes("{n}")).map((f) => f.chemin),
      ["avance.signalesFin.masques"],
    );
  });
});

describe("T3a : phrases réécrites (D-2b-38) et reprises de la spécification", () => {
  /** Plan §4.1.3, lignes 367 à 372 : les cinq phrases réécrites, copiées à l'octet. */
  const REECRITES: Array<[string, string]> = [
    [
      "avance.activation.refuse",
      "Refusé automatiquement aux outils de l'IA (interdits absolus) : fichiers de clés et `.env`, production, réseau, envoi git, hors du projet, fichiers de configuration, d'IDE et de CI.",
    ],
    [
      "avance.activation.programme",
      "Un programme lancé automatiquement peut lire et modifier les fichiers de tous les projets du dossier de travail, dont les `.env` et les fichiers de clés, lire le jeton Copilot et agir sur opencode. Le cockpit arrête tout s'il le détecte, après coup.",
    ],
    [
      "avance.activation.fichiersExecutes",
      "Des fichiers écrits dans le dossier de travail peuvent s'exécuter plus tard sur votre poste. L'historique git de chaque projet reste en lecture seule ; une modification des fichiers d'IDE ou de CI arrête la demande et vous est signalée.",
    ],
    ["avance.honnetete.interditsAbsolus", "Interdits absolus, refusés automatiquement aux outils de l'IA : fichiers de clés, production, réseau, envoi git."],
    [
      "avance.activation.arreter",
      "Arrêter relance la salle à neuf ; elle l'est aussi à la fin de chaque demande. Si le cockpit s'arrête, la salle s'arrête en 30 secondes au plus.",
    ],
  ];

  /** Formulations remplacées (spécification l.859, l.863, l.864, l.865, l.1059) : plus aucune trace. */
  const ANCIENNES = [
    "les fichiers du projet, dont les `.env`",
    "Refusé automatiquement (interdits absolus)",
    "Des fichiers écrits dans le projet peuvent s'exécuter",
    "L'historique git reste en lecture seule",
    "Arrêter relance la salle à neuf. Si le cockpit",
    "Interdits absolus : fichiers de clés, production, réseau, envoi git",
  ];

  it("les cinq phrases réécrites sont présentes à l'octet, à leur place", () => {
    for (const [chemin, texte] of REECRITES) assert.equal(TEXTE(chemin), texte, chemin);
  });

  it("aucune ancienne formulation, l.863 comprise", () => {
    for (const ancienne of ANCIENNES) {
      assert.deepEqual(
        TOUTES.filter((f) => f.texte.includes(ancienne)).map((f) => f.chemin),
        [],
        ancienne,
      );
    }
  });

  it("reprises de la spécification, à l'octet", () => {
    const reprises: Array<[string, string]> = [
      ["avance.activation.titre", "Lancer cette demande comme Oh My OpenAgent ?"],
      [
        "avance.activation.extension",
        "L'extension Oh My OpenAgent (version 4.19.4, auditée le {date}) enchaîne le travail seule : elle délègue, relance et résume sans vous demander.",
      ],
      ["avance.activation.autorise", "Autorisé automatiquement : lire et modifier les fichiers de {projet}, lancer des commandes, les tests et les programmes du projet."],
      ["avance.activation.reseau", "Réseau fermé sauf GitHub Copilot."],
      ["avance.activation.champ.libelle", "Arrêt automatique à :"],
      ["avance.activation.champ.unite", "$"],
      [
        "avance.activation.champ.aide",
        "Ses appels ne passent pas par le contrôle de coût avant envoi : le cockpit arrête à ce montant ; un appel en cours par assistant peut le dépasser.",
      ],
      ["avance.activation.planificateurSansDemande", "Le planificateur (Prometheus) modifie des fichiers sans demande, seulement filtré par l'extension."],
      ["avance.activation.planificateurControle", "Les modifications du planificateur passent par le contrôle des interdits du cockpit."],
      ["avance.activation.sansDemande", "Certaines actions de l'extension ne passent par aucune demande."],
      ["avance.activation.boutons.lancer", "Lancer comme Oh My OpenAgent"],
      ["avance.activation.boutons.annuler", "Annuler"],
      ["avance.activation.boutons.sansDemande", "Ce que l'extension fait sans demande"],
      ["avance.bandeau.texte", "Salle OMO · extension active · actions non contrôlées avant exécution · {x} $ sur {montant} $"],
      ["avance.honnetete.reseauFerme", "Réseau fermé sauf GitHub Copilot"],
      ["avance.honnetete.delegue", "L'extension délègue, relance et résume sans vous demander"],
      [
        "avance.honnetete.coutApresCoup",
        "Ses appels ne passent pas par le contrôle de coût avant envoi : le cockpit arrête à {montant} $ ; un appel en cours par assistant peut le dépasser",
      ],
      ["avance.honnetete.planificateurSansDemande", "Le planificateur (Prometheus) modifie des fichiers sans demande, seulement filtré par l'extension"],
      ["avance.honnetete.planificateurControle", "Les modifications du planificateur passent par le contrôle des interdits du cockpit"],
      ["avance.honnetete.arreterRelance", "Arrêter relance la salle à neuf"],
      ["avance.honnetete.hommeMort", "Si le cockpit s'arrête, la salle s'arrête en 30 secondes au plus"],
      ["avance.honnetete.version", "Version 4.19.4, auditée le {date} ; image construite sur votre PC, jamais publiée"],
      ["avance.precontrole.non-prepare", "Projet non préparé pour la salle : relancez `install.ps1`"],
      ["avance.refus.adresse-copilot-changee", "Adresse Copilot changée : relancez l'installation"],
      ["avance.interdits.message", "Interdit absolu du cockpit : {categorie}. N'essayez pas de le contourner."],
      ["avance.sortiesRefusees.titre", "Sorties refusées (24 h)"],
      ["avance.nonInstallee", "La Salle Oh My OpenAgent n'est pas installée sur ce poste."],
      ["avance.recreation.arret-non-confirme", "arrêt non confirmé"],
      ["avance.signales.programme", "à relire avant de lancer sur votre poste"],
      ["avance.marques.ajouteParExtension", "ajouté par l'extension"],
      ["avance.marques.dapresMarqueur", "d'après son marqueur"],
      ["avance.marques.relanceExtension", "relance par l'extension (sans demande)"],
      ["avance.marques.parExtension", "par l'extension"],
      ["avance.marques.nonControle", "non contrôlé avant exécution"],
      ["avance.marques.origineInconnue", "Message non écrit par vous (origine non identifiée)"],
      ["avance.marques.reveilSansReponse", "Résultat déposé, lu à son prochain tour (sans appel d'IA)"],
      ["avance.signales.ide-ci", "Relisez ces fichiers avant de rouvrir ce projet dans votre éditeur."],
    ];
    for (const [chemin, texte] of reprises) assert.equal(TEXTE(chemin), texte, chemin);
    // l.861 : le libellé du champ et son unité encadrent la saisie (« [    ] » est le champ, jamais du texte).
    assert.equal(`${TEXTE("avance.activation.champ.libelle")} [    ] ${TEXTE("avance.activation.champ.unite")}`, "Arrêt automatique à : [    ] $");
  });

  it("phrases des décisions du 14 et du 15 septembre : suspension, relance, activité hors demande, redémarrage du cockpit, quarantaine", () => {
    assert.equal(TEXTE("avance.refus.salle-suspendue"), "Salle suspendue : l'extension a agi sans demande à deux reprises. Rouvrez une salle pour la relancer.");
    assert.equal(TEXTE("avance.refus.salle-en-relance"), "La salle redémarre à neuf. Réessayez dans quelques secondes.");
    assert.equal(TEXTE("avance.refus.battement-absent"), "La salle ne répond pas : le cockpit ne peut pas vérifier qu'elle s'arrêtera.");
    assert.equal(TEXTE("avance.refus.demande-active"), "Une demande est déjà en cours dans la salle : attendez sa fin ou arrêtez-la.");
    assert.equal(TEXTE("avance.refus.plafond-vide"), "Saisissez le montant d'arrêt automatique.");
    // Deux causes, deux phrases (mesure L21 §2) : le balayage de la salle voit aussi des alias de casse inscriptibles, que
    // relancer l'installation ne peut PAS fermer ; le balayage du cockpit, lui, ne voit que des dépôts ajoutés après coup.
    assert.equal(TEXTE("avance.refus.git-inscriptible"), "L'historique git de ces dossiers n'est pas protégé : la salle ne démarre pas. {liste}");
    assert.doesNotMatch(TEXTE("avance.refus.git-inscriptible"), /install\.ps1/u, "aucun geste promis là où il n'aboutit pas (P3)");
    assert.equal(TEXTE("avance.refus.workspace-non-verifie"), "L'historique git de ces dossiers n'est pas protégé : relancez `install.ps1`. {liste}");
    assert.notEqual(TEXTE("avance.refus.workspace-non-verifie"), TEXTE("avance.refus.git-inscriptible"));
    assert.equal(TEXTE("avance.arrets.redemarrage-cockpit"), "Le cockpit a redémarré : la demande en cours a été arrêtée et la salle relancée à neuf.");
    assert.equal(TEXTE("avance.detections.activite-hors-demande"), "L'extension a agi alors qu'aucune demande n'était en cours : la salle a été arrêtée.");
    assert.equal(
      TEXTE("avance.signales.git-quarantaine"),
      "Un historique git créé pendant la demande a été mis de côté ({chemin}). Relisez ces fichiers avant de rouvrir ce projet dans votre éditeur.",
    );
  });

  it("honnêteté : le coût n'est jamais promis, et une détection est dite après coup", () => {
    for (const chemin of ["avance.activation.champ.aide", "avance.honnetete.coutApresCoup", "avance.arrets.plafond-cout"]) {
      assert.match(TEXTE(chemin), /peut (?:le|l'avoir) dépass/u, chemin);
    }
    assert.match(TEXTE("avance.detectionApresCoup"), /après coup/u);
    assert.match(TEXTE("avance.activation.programme"), /après coup\.$/u);
  });
});
