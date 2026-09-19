// Détections de la Salle OMO, module pur (plan d'exécution 2 bis et 2 ter, fiche L23a ; spécification §4.14.5, JS-6, JS-7, G13,
// R16 ; D-2b-18, D-2b-29, D-2b-37) : un cas par cause, activité hors demande, disque sur tous les projets préparés, /workspace et
// son premier niveau, les deux variantes de la détection 4, gardes contre les faux positifs, fichiers signalés sans arrêt, pureté.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import type { MessageOrigin } from "./shared/activity-types.ts";
import {
  detect,
  etatInitial,
  OMO_CONFIG_NOMS,
  OMO_DETAIL_CHEMINS_MAX,
  OMO_DETECTION_CAUSES,
  OMO_IDE_CI_NOMS,
  OMO_REGLE_PERMISSION,
  OMO_REGLES_PERMISSION,
  OMO_TENTATIVES_429_MAX,
  type OmoDetectionCause,
  type OmoDetectionInput,
  type OmoDetectionOptions,
  type OmoDetectionResult,
  type OmoDetectionState,
  type OmoDiskElement,
  type OmoDiskSnapshot,
  type OmoPermissionRule,
} from "./shared/omo-detections.ts";

const RACINE = "ses_racine";
const ENFANT = "ses_enfant";
const PETIT_ENFANT = "ses_petit_enfant";
const AUTRE_RACINE = "ses_autre_racine";

interface Rejeu {
  etat: OmoDetectionState;
  resultats: OmoDetectionResult[];
  causes: (OmoDetectionCause | null)[];
}

function rejouer(entrees: readonly OmoDetectionInput[], options?: OmoDetectionOptions, depart: OmoDetectionState = etatInitial()): Rejeu {
  let etat = depart;
  const resultats: OmoDetectionResult[] = [];
  for (const entree of entrees) {
    const r = detect(etat, entree, options);
    resultats.push(r);
    etat = r.etat;
  }
  return { etat, resultats, causes: resultats.map((r) => r.detection?.cause ?? null) };
}

const derniere = (entrees: readonly OmoDetectionInput[], options?: OmoDetectionOptions) => rejouer(entrees, options).resultats.at(-1);

// --- Fabriques de faits -------------------------------------------------------------------------------------------------------------

const statut = (
  valeur: "busy" | "idle" | "retry",
  o: { sessionId?: string; rootId?: string | null; tentative?: number | null; demandeActive?: string | null } = {},
): OmoDetectionInput => ({
  type: "session.status",
  sessionId: o.sessionId ?? RACINE,
  rootId: o.rootId === undefined ? RACINE : o.rootId,
  statut: valeur,
  tentative: o.tentative ?? null,
  demandeActive: o.demandeActive === undefined ? RACINE : o.demandeActive,
});

const tentative = (numero: number | null, o: { sessionId?: string; rootId?: string; demandeActive?: string | null } = {}) => statut("retry", { ...o, tentative: numero });

const progres = (rootId: string | null = RACINE): OmoDetectionInput => ({ type: "progres", rootId });

const usage = (demandeActive: string | null, rootId: string | null = RACINE): OmoDetectionInput => ({
  type: "usage.updated",
  sessionId: ENFANT,
  rootId,
  demandeActive,
});

const message = (o: { racine?: boolean; origine?: MessageOrigin | null; demandeActive?: string | null; rootId?: string | null; sessionId?: string } = {}): OmoDetectionInput => ({
  type: "message",
  sessionId: o.sessionId ?? RACINE,
  rootId: o.rootId === undefined ? RACINE : o.rootId,
  racine: o.racine ?? true,
  origine: o.origine === undefined ? "demande" : o.origine,
  demandeActive: o.demandeActive === undefined ? RACINE : o.demandeActive,
});

const creee = (o: { sessionId?: string; parentID?: string | null; rootId?: string | null; ouverte?: boolean; demandeActive?: string | null } = {}): OmoDetectionInput => ({
  type: "session.created",
  sessionId: o.sessionId ?? ENFANT,
  parentID: o.parentID === undefined ? RACINE : o.parentID,
  rootId: o.rootId === undefined ? RACINE : o.rootId,
  racineOuverteParLeCockpit: o.ouverte ?? false,
  demandeActive: o.demandeActive === undefined ? RACINE : o.demandeActive,
});

const rule = (permission: string, pattern: string, action: string): OmoPermissionRule => ({ permission, pattern, action });

const miseAJour = (avant: readonly OmoPermissionRule[], apres: readonly OmoPermissionRule[], sessionId = ENFANT): OmoDetectionInput => ({
  type: "session.updated",
  sessionId,
  rootId: RACINE,
  permissionAvant: avant,
  permissionApres: apres,
});

const patch = (permission: readonly OmoPermissionRule[], sessionId = ENFANT): OmoDetectionInput => ({ type: "permission.patch-cockpit", sessionId, permission });

// --- Relevés du disque ---------------------------------------------------------------------------------------------------------------

const H1 = "1".repeat(64);
const H2 = "2".repeat(64);
const DOSSIER: OmoDiskElement = { forme: "dossier", empreinte: null };
const fichier = (empreinte: string | null): OmoDiskElement => ({ forme: "fichier", empreinte });

/** /workspace, projet préparé ouvert, projet préparé NON ouvert, dossier de premier niveau sans projet. */
const DOSSIERS = ["", "ouvert", "autre", "notes"];

/** Relevé du démarrage : `.git` protégés, configuration présente hors du pré-contrôle, fichiers d'IDE et de CI, fichiers signalés. */
const DEPART: Readonly<Record<string, OmoDiskElement>> = {
  "ouvert/.git": DOSSIER,
  "ouvert/package.json": fichier(H1),
  "ouvert/old.ps1": fichier(H1),
  "ouvert/Jenkinsfile": fichier(H1),
  "ouvert/.github": DOSSIER,
  "ouvert/.github/workflows/ci.yml": fichier(H1),
  "autre/.git": DOSSIER,
  "autre/.vscode": DOSSIER,
  "autre/.vscode/tasks.json": fichier(H1),
  "notes/.claude": DOSSIER,
  "notes/.claude/settings.json": fichier(H1),
};

function releve(elements: Readonly<Record<string, OmoDiskElement | null>>, o: { dossiers?: readonly string[]; incomplet?: boolean } = {}): OmoDiskSnapshot {
  const map = new Map<string, OmoDiskElement>();
  for (const [chemin, element] of Object.entries(elements)) if (element !== null) map.set(chemin, element);
  return { dossiers: o.dossiers ?? DOSSIERS, elements: map, incomplet: o.incomplet ?? false };
}

/** Relevé du démarrage, puis relevé courant = démarrage + changements (null : supprimé). */
function disque(changements: Readonly<Record<string, OmoDiskElement | null>>, o: { avant?: OmoDiskSnapshot; apres?: Partial<OmoDiskSnapshot> } = {}): OmoDetectionResult {
  const avant = o.avant ?? releve(DEPART);
  const apres = { ...releve({ ...DEPART, ...changements }), ...o.apres };
  return detect(etatInitial(), { type: "disque", avant, apres });
}

// --- Tests -------------------------------------------------------------------------------------------------------------------------

describe("causes de détection (T3a)", () => {
  it("les 10 causes exactes de OmoDetectionCause, sans doublon", () => {
    assert.deepEqual(
      [...OMO_DETECTION_CAUSES],
      [
        "reponse-non-emise",
        "racine-etrangere",
        "dispose-non-demande",
        "permission-modifiee",
        "origine-inconnue",
        "config-apparue",
        "git-cree",
        "ide-ci-modifie",
        "tentatives-429",
        "activite-hors-demande",
      ],
    );
    assert.equal(new Set(OMO_DETECTION_CAUSES).size, 10);
    assert.equal(OMO_TENTATIVES_429_MAX, 3);
  });

  /** Un cas par cause : les faits qui précèdent ne détectent rien, le dernier détecte la cause, et elle seule. */
  const CAS = {
    "reponse-non-emise": [{ type: "permission.replied", sessionId: ENFANT, rootId: RACINE, emisParPortillon: false }],
    "racine-etrangere": [creee({ sessionId: AUTRE_RACINE, parentID: null, rootId: AUTRE_RACINE, ouverte: false })],
    "dispose-non-demande": [{ type: "dispose", evenement: "global.disposed", demandeParLeCockpit: false }],
    "permission-modifiee": [miseAJour([], [rule("edit", "*", "allow")])],
    "origine-inconnue": [message({ origine: "origine-inconnue" })],
    "config-apparue": [{ type: "disque", avant: releve(DEPART), apres: releve({ ...DEPART, "ouvert/.agents": DOSSIER }) }],
    "git-cree": [{ type: "disque", avant: releve(DEPART), apres: releve({ ...DEPART, ".git": DOSSIER }) }],
    "ide-ci-modifie": [{ type: "disque", avant: releve(DEPART), apres: releve({ ...DEPART, "autre/.vscode/tasks.json": fichier(H2) }) }],
    "tentatives-429": [tentative(1), statut("busy"), tentative(2), statut("busy"), tentative(3)],
    "activite-hors-demande": [statut("busy", { demandeActive: null })],
  } satisfies Record<OmoDetectionCause, OmoDetectionInput[]>;

  for (const cause of OMO_DETECTION_CAUSES) {
    it(`un cas : ${cause}`, () => {
      const { causes } = rejouer(CAS[cause]);
      assert.deepEqual(causes, [...causes.slice(0, -1).map(() => null), cause]);
    });
  }
});

describe("détection 1 : réponse d'autorisation non émise par le portillon", () => {
  it("non inscrite au registre → détection, avec l'arbre et la session ; inscrite → rien ; drapeau absent → détection", () => {
    const non = derniere([{ type: "permission.replied", sessionId: ENFANT, rootId: RACINE, emisParPortillon: false }]);
    assert.deepEqual(non?.detection, { cause: "reponse-non-emise", detail: { rootId: RACINE, sessionId: ENFANT, chemins: [] } });
    assert.equal(derniere([{ type: "permission.replied", sessionId: ENFANT, rootId: RACINE, emisParPortillon: true }])?.detection, null);
    const absent = { type: "permission.replied", sessionId: ENFANT, rootId: RACINE } as unknown as OmoDetectionInput;
    assert.equal(derniere([absent])?.detection?.cause, "reponse-non-emise");
  });
});

describe("détection 2 : racine non créée par le proxy", () => {
  it("racine sans parentID non ouverte par le cockpit → détection, pendant une demande comme sans demande", () => {
    for (const demandeActive of [RACINE, null]) {
      const r = derniere([creee({ sessionId: AUTRE_RACINE, parentID: null, rootId: AUTRE_RACINE, demandeActive })]);
      assert.deepEqual(r?.detection, { cause: "racine-etrangere", detail: { rootId: AUTRE_RACINE, sessionId: AUTRE_RACINE, chemins: [] } });
    }
    const vide = derniere([creee({ sessionId: AUTRE_RACINE, parentID: "", rootId: AUTRE_RACINE })]);
    assert.equal(vide?.detection?.cause, "racine-etrangere", "parentID vide : racine");
  });

  it("garde : enfant créé par l'extension avec parentID, pendant la demande → rien (petit-enfant compris)", () => {
    assert.deepEqual(rejouer([creee({ sessionId: ENFANT, parentID: RACINE }), creee({ sessionId: PETIT_ENFANT, parentID: ENFANT })]).causes, [null, null]);
  });

  it("garde : ouverture d'une salle par le cockpit, sans demande → ni racine étrangère ni activité hors demande", () => {
    assert.equal(derniere([creee({ sessionId: RACINE, parentID: null, rootId: RACINE, ouverte: true, demandeActive: null })])?.detection, null);
  });
});

describe("détection 3 : libération d'instance non demandée", () => {
  it("global.disposed ou server.instance.disposed non demandé → détection ; demandé par le cockpit → rien", () => {
    for (const evenement of ["global.disposed", "server.instance.disposed"] as const) {
      assert.deepEqual(derniere([{ type: "dispose", evenement, demandeParLeCockpit: false }])?.detection, {
        cause: "dispose-non-demande",
        detail: { rootId: null, sessionId: null, chemins: [] },
      });
      assert.equal(derniere([{ type: "dispose", evenement, demandeParLeCockpit: true }])?.detection, null);
    }
  });
});

describe("détection 4 : permission de session modifiée sans le cockpit (deux variantes, MO-5, R16)", () => {
  const TOUTE: OmoDetectionOptions = { reglePermission: "toute-modification" };
  const AJOUT: OmoDetectionOptions = { reglePermission: "ajout-allow-ou-ask" };
  const DEPART_REGLES = [rule("*", "*", "deny"), rule("read", "*", "allow"), rule("bash", "*", "deny")];

  const cause = (avant: readonly OmoPermissionRule[], apres: readonly OmoPermissionRule[], options: OmoDetectionOptions) =>
    derniere([miseAJour(avant, apres)], options)?.detection?.cause ?? null;

  it("variantes connues ; variante retenue provisoire « toute-modification », fixée au train de V0 d'après MO-5", () => {
    assert.deepEqual([...OMO_REGLES_PERMISSION], ["toute-modification", "ajout-allow-ou-ask"]);
    assert.equal(OMO_REGLE_PERMISSION, "toute-modification");
    const sans = derniere([miseAJour(DEPART_REGLES, [...DEPART_REGLES, rule("task", "*", "deny")])]);
    assert.equal(sans?.detection?.cause, "permission-modifiee", "sans option : la variante retenue");
    const inconnue = { reglePermission: "autre" } as unknown as OmoDetectionOptions;
    assert.equal(cause(DEPART_REGLES, [...DEPART_REGLES, rule("task", "*", "deny")], inconnue), "permission-modifiee", "variante inconnue : la plus stricte");
  });

  it("garde : session.updated sans changement de permission (titre, horodatage) → rien, dans les deux variantes", () => {
    for (const options of [TOUTE, AJOUT]) {
      assert.equal(cause(DEPART_REGLES, DEPART_REGLES.map((r) => ({ ...r })), options), null);
      assert.equal(cause([], [], options), null);
    }
  });

  it("« toute-modification » : ajout d'un refus, retrait, réordonnancement, remplacement par des refus → détection", () => {
    assert.equal(cause(DEPART_REGLES, [...DEPART_REGLES, rule("task", "*", "deny")], TOUTE), "permission-modifiee");
    assert.equal(cause(DEPART_REGLES, DEPART_REGLES.slice(0, 2), TOUTE), "permission-modifiee");
    assert.equal(cause(DEPART_REGLES, [...DEPART_REGLES].reverse(), TOUTE), "permission-modifiee");
    assert.equal(cause(DEPART_REGLES, [rule("task", "*", "deny"), rule("call_omo_agent", "*", "deny")], TOUTE), "permission-modifiee");
  });

  it("« ajout-allow-ou-ask » : un allow, un ask, une action inconnue ou un allow en double ajoutés → détection", () => {
    assert.equal(cause(DEPART_REGLES, [...DEPART_REGLES, rule("edit", "*", "allow")], AJOUT), "permission-modifiee");
    assert.equal(cause(DEPART_REGLES, [...DEPART_REGLES, rule("bash", "git *", "ask")], AJOUT), "permission-modifiee");
    assert.equal(cause(DEPART_REGLES, [...DEPART_REGLES, rule("bash", "*", "always")], AJOUT), "permission-modifiee");
    assert.equal(cause(DEPART_REGLES, [...DEPART_REGLES, rule("read", "*", "allow")], AJOUT), "permission-modifiee");
    // F-y : `tools` du prompt interne remplace la permission (prompt.ts:1060-1067) ; un `true` y devient un allow.
    assert.equal(cause(DEPART_REGLES, [rule("edit", "*", "allow")], AJOUT), "permission-modifiee");
  });

  it("« ajout-allow-ou-ask » : remplacement fait de refus, retrait d'un refus, réordonnancement → rien", () => {
    assert.equal(cause(DEPART_REGLES, [rule("task", "*", "deny"), rule("call_omo_agent", "*", "deny")], AJOUT), null);
    assert.equal(cause(DEPART_REGLES, DEPART_REGLES.slice(0, 2), AJOUT), null);
    assert.equal(cause(DEPART_REGLES, [...DEPART_REGLES].reverse(), AJOUT), null);
  });

  it("liste ou règle mal formée → détection dans les deux variantes (fermé en cas de doute)", () => {
    const malFormee = [{ permission: "edit", pattern: "*" }] as unknown as OmoPermissionRule[];
    for (const options of [TOUTE, AJOUT]) {
      assert.equal(cause(DEPART_REGLES, malFormee, options), "permission-modifiee");
      assert.equal(cause(DEPART_REGLES, null as unknown as OmoPermissionRule[], options), "permission-modifiee");
    }
  });

  it("garde : écho d'un PATCH du cockpit → rien, une seule fois ; autre permission ou autre session → détection", () => {
    const voulu = [...DEPART_REGLES, rule("edit", "*", "deny")];
    for (const options of [TOUTE, AJOUT]) {
      const avecAllow = [...DEPART_REGLES, rule("edit", "src/*", "allow")];
      const r = rejouer([patch(avecAllow), miseAJour(DEPART_REGLES, avecAllow), miseAJour(DEPART_REGLES, avecAllow)], options);
      assert.deepEqual(r.causes, [null, null, "permission-modifiee"], "écho accepté une fois");
      const autre = rejouer([patch(voulu), miseAJour(DEPART_REGLES, [...voulu, rule("bash", "*", "allow")])], options);
      assert.deepEqual(autre.causes, [null, "permission-modifiee"], "permission différente de celle du PATCH");
      const ailleurs = rejouer([patch(avecAllow, PETIT_ENFANT), miseAJour(DEPART_REGLES, avecAllow, ENFANT)], options);
      assert.deepEqual(ailleurs.causes, [null, "permission-modifiee"], "PATCH d'une autre session");
    }
    const attente = rejouer([patch(voulu), miseAJour(DEPART_REGLES, DEPART_REGLES), miseAJour(DEPART_REGLES, voulu)]);
    assert.deepEqual(attente.causes, [null, null, null], "mise à jour sans changement avant l'écho : l'attente reste");
  });
});

describe("détection 5 : message de racine d'origine inconnue", () => {
  it("racine, origine inconnue → détection, même pendant la demande ; enfant ou autre origine → rien", () => {
    assert.deepEqual(derniere([message({ origine: "origine-inconnue" })])?.detection, {
      cause: "origine-inconnue",
      detail: { rootId: RACINE, sessionId: RACINE, chemins: [] },
    });
    assert.equal(derniere([message({ origine: "origine-inconnue", racine: false, sessionId: ENFANT })])?.detection, null);
    for (const origine of ["demande", "consigne", "reveil-sans-reponse", "relance-extension", "interne-extension", null] as const) {
      assert.equal(derniere([message({ origine })])?.detection, null, String(origine));
    }
  });

  it("origine inconnue sans demande : l'origine l'emporte sur l'activité hors demande", () => {
    assert.equal(derniere([message({ origine: "origine-inconnue", demandeActive: null })])?.detection?.cause, "origine-inconnue");
  });
});

describe("détection 8 : nouvelles tentatives d'affilée dans l'arbre (D-2b-18)", () => {
  it("3 nouvelles tentatives dans l'arbre → détection à la troisième, puis à chaque suivante tant qu'aucun progrès", () => {
    const r = rejouer([tentative(1), statut("busy"), tentative(2), statut("busy"), tentative(3), statut("busy"), tentative(4)]);
    assert.deepEqual(r.causes, [null, null, null, null, "tentatives-429", null, "tentatives-429"]);
    assert.deepEqual(r.resultats[4]?.detection?.detail, { rootId: RACINE, sessionId: RACINE, chemins: [] });
  });

  it("un seul compteur par arbre : tentatives de deux sessions du même arbre additionnées ; un autre arbre compte à part", () => {
    const r = rejouer([
      tentative(1, { sessionId: RACINE }),
      tentative(1, { sessionId: ENFANT }),
      tentative(1, { sessionId: AUTRE_RACINE, rootId: AUTRE_RACINE, demandeActive: AUTRE_RACINE }),
      tentative(1, { sessionId: PETIT_ENFANT }),
    ]);
    assert.deepEqual(r.causes, [null, null, null, "tentatives-429"]);
  });

  it("garde : nouvelle tentative puis progrès → compteur remis à zéro ; le progrès d'un autre arbre ne remet rien", () => {
    assert.deepEqual(rejouer([tentative(1), statut("busy"), tentative(2), progres(), tentative(1), statut("busy"), tentative(2)]).causes, [null, null, null, null, null, null, null]);
    assert.deepEqual(rejouer([tentative(1), statut("busy"), tentative(2), progres(AUTRE_RACINE), statut("busy"), tentative(3)]).causes, [null, null, null, null, null, "tentatives-429"]);
    const deuxArbres = rejouer([
      tentative(1),
      statut("busy"),
      tentative(2),
      tentative(1, { sessionId: AUTRE_RACINE, rootId: AUTRE_RACINE, demandeActive: AUTRE_RACINE }),
      progres(AUTRE_RACINE),
      statut("busy"),
      tentative(3),
    ]);
    assert.deepEqual(deuxArbres.causes, [null, null, null, null, null, null, "tentatives-429"], "le progrès d'un arbre qui compte n'efface que le sien");
  });

  it("au repos entre deux tentatives : l'affilée continue (un repos n'est pas un progrès)", () => {
    assert.deepEqual(rejouer([tentative(1), statut("idle"), tentative(1), statut("idle"), tentative(1)]).causes, [null, null, null, null, "tentatives-429"]);
  });

  it("garde : même événement de nouvelle tentative reçu deux fois → compté une fois ; numéro absent → toujours compté", () => {
    assert.deepEqual(rejouer([tentative(1), tentative(1), statut("busy"), tentative(2), tentative(2)]).causes, [null, null, null, null, null]);
    assert.deepEqual(rejouer([tentative(null), tentative(null), tentative(null)]).causes, [null, null, "tentatives-429"]);
    assert.deepEqual(rejouer([tentative(1), tentative(0), tentative(1.5)]).causes, [null, null, "tentatives-429"], "numéro invalide : compté");
    assert.deepEqual(rejouer([tentative(0), tentative(0), tentative(0)]).causes, [null, null, "tentatives-429"], "numéro invalide : jamais pris pour un doublon");
  });
});

describe("activité hors demande (D-2b-29)", () => {
  const hors = (entree: OmoDetectionInput) => derniere([entree])?.detection?.cause ?? null;

  it("occupée, nouvelle tentative, usage, nouveau message ou enfant créé sans demande → détection", () => {
    assert.equal(hors(statut("busy", { demandeActive: null })), "activite-hors-demande");
    assert.equal(hors(statut("retry", { demandeActive: null, tentative: 1 })), "activite-hors-demande");
    assert.equal(hors(usage(null)), "activite-hors-demande");
    assert.equal(hors(message({ demandeActive: null, origine: "relance-extension" })), "activite-hors-demande");
    assert.equal(hors(message({ demandeActive: null, origine: null, racine: false, sessionId: ENFANT })), "activite-hors-demande");
    assert.equal(hors(creee({ demandeActive: null })), "activite-hors-demande");
    assert.deepEqual(derniere([usage(null)])?.detection?.detail, { rootId: RACINE, sessionId: ENFANT, chemins: [] });
  });

  it("pendant la demande de cet arbre → rien", () => {
    for (const entree of [statut("busy"), statut("retry", { tentative: 1 }), usage(RACINE), message(), message({ racine: false, origine: "consigne" }), creee()]) {
      assert.equal(hors(entree), null, entree.type);
    }
  });

  it("activité d'un autre arbre que celui de la demande, ou d'un arbre inconnu → détection", () => {
    assert.equal(hors(statut("busy", { sessionId: AUTRE_RACINE, rootId: AUTRE_RACINE })), "activite-hors-demande");
    assert.equal(hors(usage(RACINE, AUTRE_RACINE)), "activite-hors-demande");
    assert.equal(hors(message({ rootId: null })), "activite-hors-demande");
    assert.equal(hors(creee({ rootId: null })), "activite-hors-demande", "enfant d'un arbre inconnu");
    assert.equal(hors(usage("", "")), "activite-hors-demande", "identifiants vides");
  });

  it("au repos sans demande, ou progrès sans demande → rien ; nouvelle tentative hors demande : l'activité l'emporte sur les 429", () => {
    assert.equal(hors(statut("idle", { demandeActive: null })), null);
    assert.equal(hors(progres()), null);
    const r = rejouer([tentative(1), statut("busy"), tentative(2), statut("busy"), statut("retry", { tentative: 3, demandeActive: null })]);
    assert.equal(r.causes.at(-1), "activite-hors-demande");
  });
});

describe("disque : tous les projets préparés, /workspace et son premier niveau", () => {
  it("garde : relevé inchangé (configuration, .git, IDE et CI présents au démarrage) → rien", () => {
    const r = disque({});
    assert.deepEqual({ detection: r.detection, signales: r.signales, quarantaine: r.quarantaine }, { detection: null, signales: [], quarantaine: [] });
  });

  it(".vscode/tasks.json modifié dans un projet préparé NON ouvert → ide-ci-modifie, signalé à relire", () => {
    const r = disque({ "autre/.vscode/tasks.json": fichier(H2) });
    assert.deepEqual(r.detection, { cause: "ide-ci-modifie", detail: { rootId: null, sessionId: null, chemins: ["autre/.vscode/tasks.json"] } });
    assert.deepEqual(r.signales, [{ chemin: "autre/.vscode/tasks.json", genre: "ide-ci" }]);
    assert.deepEqual(r.quarantaine, []);
  });

  it("chaque nom d'IDE et de CI, à la racine d'un dossier contrôlé, casse ignorée → ide-ci-modifie", () => {
    const crees = [
      ...OMO_IDE_CI_NOMS.map((nom) => `notes/${nom}`),
      "notes/.github/workflows/deploy.yml",
      "notes/.husky/pre-commit",
      "notes/azure-pipelines.yml",
      "notes/azure-pipelines-prod.yml",
      "ouvert/.VSCode/settings.json",
      ".devcontainer/devcontainer.json",
    ];
    for (const chemin of crees) assert.equal(disque({ [chemin]: fichier(H1) }).detection?.cause, "ide-ci-modifie", chemin);
    assert.equal(disque({ "ouvert/.github/workflows/ci.yml": null }).detection?.cause, "ide-ci-modifie", "workflow supprimé");
    const supprime = disque({ "ouvert/Jenkinsfile": null });
    assert.deepEqual([supprime.detection?.cause, supprime.signales], ["ide-ci-modifie", []], "supprimé : détecté, rien à relire");
  });

  it("hors de la racine d'un dossier contrôlé, ou nom voisin → rien", () => {
    for (const chemin of ["ouvert/src/.vscode/settings.json", "ouvert/.vscode-test/x.json", "ouvert/docs/Jenkinsfile.md", "ouvert/azure-pipelines.yml.bak", "ouvert/src/.github/x.yml"]) {
      assert.equal(disque({ [chemin]: fichier(H1) }).detection, null, chemin);
    }
  });

  it("fermé en cas de doute : fichier illisible, relevé incomplet, dossiers absents, chemin invalide → ide-ci-modifie", () => {
    assert.equal(disque({ "autre/.vscode/tasks.json": fichier(null) }).detection?.cause, "ide-ci-modifie", "illisible");
    const deuxFoisIllisible = detect(etatInitial(), { type: "disque", avant: releve({ "autre/.vscode/tasks.json": fichier(null) }), apres: releve({ "autre/.vscode/tasks.json": fichier(null) }) });
    assert.equal(deuxFoisIllisible.detection?.cause, "ide-ci-modifie", "illisible au démarrage et maintenant");
    assert.deepEqual(disque({}, { apres: { incomplet: true } }).detection, { cause: "ide-ci-modifie", detail: { rootId: null, sessionId: null, chemins: [] } });
    assert.equal(disque({}, { avant: releve(DEPART, { incomplet: true }) }).detection?.cause, "ide-ci-modifie", "départ incomplet");
    const sansDossiers = detect(etatInitial(), { type: "disque", avant: releve(DEPART, { dossiers: [] }), apres: releve(DEPART, { dossiers: [] }) });
    assert.equal(sansDossiers.detection?.cause, "ide-ci-modifie", "aucun dossier contrôlé");
    const invalide = disque({ "ouvert/../evade/.git": DOSSIER });
    assert.deepEqual([invalide.detection?.cause, invalide.quarantaine], ["ide-ci-modifie", []], "chemin invalide : jamais en quarantaine");
    assert.equal(disque({}, { apres: { dossiers: [...DOSSIERS, "/abs"] } }).detection?.cause, "ide-ci-modifie", "dossier invalide");
  });

  it(".agents/ apparu → config-apparue (compétence dans le projet, dossier seul dans un projet non ouvert)", () => {
    assert.deepEqual(disque({ "ouvert/.agents/skills/x/SKILL.md": fichier(H1) }).detection, {
      cause: "config-apparue",
      detail: { rootId: null, sessionId: null, chemins: ["ouvert/.agents/skills/x/SKILL.md"] },
    });
    assert.equal(disque({ "autre/.agents": DOSSIER }).detection?.cause, "config-apparue");
  });

  it("chaque nom de configuration apparu à la racine d'un dossier contrôlé, /workspace compris, casse ignorée → config-apparue", () => {
    for (const nom of OMO_CONFIG_NOMS) {
      assert.equal(disque({ [`ouvert/${nom}`]: fichier(H1) }).detection?.cause, "config-apparue", nom);
      assert.equal(disque({ [nom]: fichier(H1) }).detection?.cause, "config-apparue", `/workspace/${nom}`);
    }
    assert.equal(disque({ "ouvert/.Claude/settings.json": fichier(H1) }).detection?.cause, "config-apparue");
    assert.equal(disque({ "notes/OH-MY-OPENCODE.JSON": fichier(H1) }).detection?.cause, "config-apparue");
  });

  it("garde : dossiers d'état de l'extension, configuration hors racine, nom voisin, configuration disparue → rien", () => {
    for (const chemin of ["ouvert/.omo/boulder.json", "ouvert/.omo/boulder.arrete-1.json", "ouvert/.omo/plans/p.md", "ouvert/.omo/notepads/n.md", "ouvert/src/opencode.json", "ouvert/.claude-notes.md"]) {
      assert.equal(disque({ [chemin]: fichier(H1) }).detection, null, chemin);
    }
    assert.equal(disque({ "notes/.claude/settings.json": null, "notes/.claude": null }).detection, null);
  });

  it("configuration présente au démarrage : inchangée → rien ; modifiée ou complétée → config-apparue", () => {
    assert.equal(disque({ "notes/.claude/settings.json": fichier(H1) }).detection, null);
    assert.equal(disque({ "notes/.claude/settings.json": fichier(H2) }).detection?.cause, "config-apparue");
    assert.equal(disque({ "notes/.claude/agents/x.md": fichier(H1) }).detection?.cause, "config-apparue");
  });

  it("/workspace/.git créé → git-cree, chemin en quarantaine et signalé", () => {
    const r = disque({ ".git": DOSSIER, ".git/config": fichier(H1) });
    assert.deepEqual(r.detection, { cause: "git-cree", detail: { rootId: null, sessionId: null, chemins: [".git"] } });
    assert.deepEqual(r.quarantaine, [".git"]);
    assert.deepEqual(r.signales, [{ chemin: ".git", genre: "git-quarantaine" }]);
  });

  it(".git créé dans un dossier sans .git, connu par son seul contenu, ou plus profond → git-cree et quarantaine ; node_modules ignoré", () => {
    assert.deepEqual(disque({ "notes/.git/HEAD": fichier(H1) }).quarantaine, ["notes/.git"]);
    const profond = disque({ "ouvert/vendor/lib/.git": DOSSIER });
    assert.deepEqual([profond.detection?.cause, profond.quarantaine], ["git-cree", ["ouvert/vendor/lib/.git"]]);
    const dependance = disque({ "ouvert/node_modules/pkg/.git": DOSSIER, "ouvert/node_modules/pkg/.git/HEAD": fichier(H1) });
    assert.deepEqual([dependance.detection, dependance.quarantaine], [null, []]);
  });

  it("garde : .git présent au démarrage (contenu relevé en plus, casse différente) → rien, jamais en quarantaine", () => {
    const contenu = disque({ "ouvert/.git/HEAD": fichier(H1) });
    assert.deepEqual([contenu.detection, contenu.quarantaine], [null, []]);
    const casse = detect(etatInitial(), { type: "disque", avant: releve(DEPART), apres: releve({ ...DEPART, "autre/.git": null, "autre/.GIT": DOSSIER }) });
    assert.deepEqual([casse.detection, casse.quarantaine], [null, []]);
  });

  it(".git présent au démarrage dont la forme change → git-cree sans quarantaine", () => {
    const r = disque({ "ouvert/.git": fichier(H1) });
    assert.deepEqual([r.detection, r.quarantaine], [{ cause: "git-cree", detail: { rootId: null, sessionId: null, chemins: ["ouvert/.git"] } }, []]);
  });

  it("package.json, Makefile et *.ps1 modifiés ou créés → signalés sans arrêt ; supprimés ou sous node_modules → rien", () => {
    const r = disque({ "ouvert/package.json": fichier(H2), "autre/Makefile": fichier(H1), "ouvert/scripts/Build.PS1": fichier(H1), "notes/sub/package.json": fichier(H1) });
    assert.equal(r.detection, null);
    assert.deepEqual(r.quarantaine, []);
    assert.deepEqual(r.signales, [
      { chemin: "autre/Makefile", genre: "programme" },
      { chemin: "notes/sub/package.json", genre: "programme" },
      { chemin: "ouvert/package.json", genre: "programme" },
      { chemin: "ouvert/scripts/Build.PS1", genre: "programme" },
    ]);
    assert.deepEqual(disque({ "ouvert/old.ps1": null, "ouvert/node_modules/x/package.json": fichier(H1), "ouvert/package.json": fichier(H1) }).signales, []);
  });

  it("plusieurs changements : .git créé l'emporte, puis la configuration ; quarantaine et signalés complets et triés", () => {
    const tout = disque({ "notes/.git": DOSSIER, ".git": DOSSIER, "ouvert/.agents": DOSSIER, "autre/.vscode/tasks.json": fichier(H2), "ouvert/package.json": fichier(H2) });
    assert.equal(tout.detection?.cause, "git-cree");
    assert.deepEqual(tout.detection?.detail.chemins, [".git", "notes/.git"]);
    assert.deepEqual(tout.quarantaine, [".git", "notes/.git"]);
    assert.deepEqual(tout.signales, [
      { chemin: ".git", genre: "git-quarantaine" },
      { chemin: "autre/.vscode/tasks.json", genre: "ide-ci" },
      { chemin: "notes/.git", genre: "git-quarantaine" },
      { chemin: "ouvert/package.json", genre: "programme" },
    ]);
    assert.equal(disque({ "ouvert/.agents": DOSSIER, "autre/.vscode/tasks.json": fichier(H2) }).detection?.cause, "config-apparue");
    const doubleGenre = disque({ "ouvert/.husky/hook.ps1": fichier(H1) });
    assert.deepEqual(doubleGenre.signales, [
      { chemin: "ouvert/.husky/hook.ps1", genre: "ide-ci" },
      { chemin: "ouvert/.husky/hook.ps1", genre: "programme" },
    ]);
  });

  it(`détail borné à ${OMO_DETAIL_CHEMINS_MAX} chemins triés ; signalés et quarantaine complets`, () => {
    const crees: Record<string, OmoDiskElement> = {};
    for (let i = 24; i >= 0; i--) crees[`ouvert/.github/workflows/w${String(i).padStart(2, "0")}.yml`] = fichier(H1);
    const r = disque(crees);
    assert.equal(r.detection?.detail.chemins.length, OMO_DETAIL_CHEMINS_MAX);
    assert.deepEqual(r.detection?.detail.chemins, [...(r.detection?.detail.chemins ?? [])].sort());
    assert.equal(r.detection?.detail.chemins[0], "ouvert/.github/workflows/w00.yml");
    assert.equal(r.signales.length, 25);
  });

  it("dossier contrôlé apparu depuis le démarrage (projet préparé ou premier niveau créé) → contrôlé lui aussi", () => {
    const apres = releve({ ...DEPART, "neuf/.vscode/tasks.json": fichier(H1) }, { dossiers: [...DOSSIERS, "neuf"] });
    const r = detect(etatInitial(), { type: "disque", avant: releve(DEPART), apres });
    assert.deepEqual(r.detection, { cause: "ide-ci-modifie", detail: { rootId: null, sessionId: null, chemins: ["neuf/.vscode/tasks.json"] } });
  });

  it("séparateur « \\ » lu comme « / » (dossier de travail Windows)", () => {
    assert.equal(disque({ "ouvert\\.vscode\\tasks.json": fichier(H1) }).detection?.cause, "ide-ci-modifie");
  });
});

describe("pureté du module omo-detections", () => {
  const SOURCE = fs.readFileSync(path.join(import.meta.dirname, "shared", "omo-detections.ts"), "utf8");

  it("ni module node, ni process, ni horloge, ni aléa, ni réseau, ni minuterie ; imports de types voisins seulement", () => {
    assert.equal(SOURCE.includes('"node:'), false);
    assert.equal(/\bprocess\./.test(SOURCE), false);
    assert.equal(/\bDate\b|Math\.random|\bfetch\s*\(|\bsetTimeout\b|\bsetInterval\b|\bperformance\.|\bcrypto\b|\brequire\s*\(/.test(SOURCE), false);
    const imports = [...SOURCE.matchAll(/\bfrom\s*["']([^"']+)["']/g)].map((m) => m[1] ?? "");
    assert.ok(imports.length > 0);
    for (const spec of imports) assert.match(spec, /^\.\/[\w.-]+\.ts$/);
    assert.equal(/^\s*import (?!type\b)/m.test(SOURCE), false, "import de valeur");
  });

  /** Forme lisible d'une valeur, Maps comprises. */
  const serialiser = (value: unknown) => JSON.stringify(value, (_key, v: unknown) => (v instanceof Map ? { map: [...v.entries()] } : v));

  it("ni l'état ni le fait ne sont modifiés ; même état et même fait, même résultat", () => {
    const entrees: OmoDetectionInput[] = [
      patch([rule("edit", "*", "deny")]),
      tentative(1),
      tentative(1, { sessionId: ENFANT }),
      miseAJour([], [rule("edit", "*", "deny")]),
      statut("busy", { sessionId: ENFANT }),
      progres(),
      tentative(1),
      { type: "disque", avant: releve(DEPART), apres: releve({ ...DEPART, ".git": DOSSIER, "ouvert/package.json": fichier(H2) }) },
      usage(null),
    ];
    let etat = etatInitial();
    const vus: { etat: OmoDetectionState; avant: string }[] = [];
    for (const entree of entrees) {
      const figeEntree = serialiser(entree);
      const figeEtat = serialiser(etat);
      vus.push({ etat, avant: figeEtat });
      const premier = detect(etat, entree);
      const second = detect(etat, entree);
      assert.equal(serialiser(premier), serialiser(second), entree.type);
      assert.equal(serialiser(entree), figeEntree, `${entree.type} : fait modifié`);
      assert.equal(serialiser(etat), figeEtat, `${entree.type} : état modifié`);
      etat = premier.etat;
    }
    for (const vu of vus) assert.equal(serialiser(vu.etat), vu.avant, "état passé modifié plus tard");
  });

  it("fait inconnu → erreur (jamais « rien détecté » en silence)", () => {
    assert.throws(() => detect(etatInitial(), { type: "inconnu" } as unknown as OmoDetectionInput), TypeError);
  });
});
