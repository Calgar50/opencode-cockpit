// Propriétaire : L26b.
// Diagnostic OMO et lignes de Salle OMO du Journal (spécification §4.12 l.784, §4.10 l.759, §5.4 l.915, §3.15.2 l.521,
// §5.7.4 l.987 ; plan d'exécution 2 bis-2 ter §6, fiche L26b ; A16 point 4 du 22/09).
// Deux familles de contrôles :
//  1. ce que l'écran AFFICHE, ligne par ligne, calculé par les modules purs `web/pages/diagnostics/omo-diagnostics.ts` et
//     `web/pages/chat/autonomy/omo-journal.ts` — un `OmoStatusResponse` complet, puis l'état vide « salle non installée » ;
//  2. ce que les composants NE FONT PAS : aucun appel réseau, aucun import de `web/lib/api-omo.ts` ni de `pages/omo/**` (L26a,
//     même vague), aucun changement de la bande néon (D-2b-45), et le point d'insertion de `getOmoStatus()` laissé à
//     l'intégrateur du train de V2.
// Les composants sont en .tsx : Node exécute le TypeScript mais pas le JSX, et P8 interdit d'ajouter un transformateur. Le rendu
// est donc contrôlé par ses données (1) et par la lecture des sources (2), comme le fait déjà autonomy-replay.test.ts.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import {
  DECISION_REFUS_INTERDIT,
  estDecisionOmo,
  marquesOmo,
  PAR_EXTENSION,
  phraseDetectionJournal,
  phraseQuarantaine,
} from "../web/pages/chat/autonomy/omo-journal.ts";
import { type FormatsOmo, lignesDiagnosticOmo, lignesPrecontrole, raisonsAttente, salleInstallee } from "../web/pages/diagnostics/omo-diagnostics.ts";
import { TEXTES } from "./shared/omo-room-texts.ts";
import type { OmoStatusResponse } from "./shared/omo-types.ts";

const T = TEXTES.avance;
const APP_DIR = path.join(import.meta.dirname, "..");

/** Lecture d'un fichier de l'interface, chemin relatif à `app/`. */
const lire = (...segments: string[]): string => fs.readFileSync(path.join(APP_DIR, ...segments), "utf8");

/** Source sans ses commentaires : ce que le composant fait vraiment, et non ce que ses commentaires nomment. */
const sansCommentaires = (source: string): string => source.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/^[ \t]*\/\/[^\n]*$/gm, " ");

/** Code d'un fichier de l'interface, commentaires retirés. */
const code = (...segments: string[]): string => sansCommentaires(lire(...segments));

const DIAGNOSTIC_TSX = ["web", "pages", "diagnostics", "OmoDiagnostics.tsx"];
const PAGE_TSX = ["web", "pages", "DiagnosticsPage.tsx"];
const JOURNAL_TSX = ["web", "pages", "chat", "autonomy", "ControlJournal.tsx"];
const ANIMATIONS_TEST = ["server", "web-animations.test.ts"];

/** Mise en forme fixe : les lignes attendues ne dépendent ni du fuseau ni de l'horloge. */
const FORMATS: FormatsOmo = { dateHeure: (ms) => `le ${ms}`, duree: (ms) => `${ms} ms` };

/** Salle installée, prête, mais avec un dépôt non protégé, un projet inscriptible et un projet refusé au pré-contrôle. */
const COMPLET: OmoStatusResponse = {
  interrupteurs: { omo: true, autonomie: true, salleOuverte: true },
  image: {
    chargee: true,
    id: "sha256:7c1b9ad0",
    manifesteSha256: "0f3a9b7c5d1e2408a6b4c2d0e8f6a4b2c0d8e6f4a2b0c8d6e4f2a0b8c6d4e2f0",
    version: "4.19.4",
    auditeLe: "2026-09-12",
  },
  dernierDemarrage: {
    startId: "start-7",
    at: 1_700_000_000_000,
    precheck: [
      { projet: "cockpit", verdict: "conforme", raison: null, trouves: [] },
      { projet: "vieux-projet", verdict: "refuse", raison: "config-opencode", trouves: ["opencode.jsonc"] },
    ],
  },
  listeBlanche: ["api.githubcopilot.com"],
  projetsPrepares: [
    { chemin: "cockpit", git: "lecture-seule" },
    { chemin: "vieux-projet", git: "inscriptible" },
  ],
  workspaceGit: { verifieLe: 1_700_000_050_000, limiteAtteinte: false, nonProteges: ["notes/.git"] },
  etatSalle: "prete",
  authSalle: { presente: true },
  sortiesRefusees24h: [{ hote: "exemple.invalide", nombre: 3, dernier: 1_700_000_040_000 }],
  battement: { actif: true, ageMs: 4_000 },
};

/** §5.4 l.915 : aucune image chargée, donc rien d'installé sur ce poste. */
const VIDE: OmoStatusResponse = {
  interrupteurs: { omo: false, autonomie: true, salleOuverte: false },
  image: { chargee: false, id: null, manifesteSha256: null, version: null, auditeLe: null },
  dernierDemarrage: null,
  listeBlanche: [],
  projetsPrepares: [],
  workspaceGit: null,
  etatSalle: "coupee",
  authSalle: { presente: false },
  sortiesRefusees24h: [],
  battement: { actif: false, ageMs: null },
};

const avec = (modifications: Partial<OmoStatusResponse>): OmoStatusResponse => ({ ...COMPLET, ...modifications });

const ligne = (statut: OmoStatusResponse, cle: string) => {
  const trouvee = lignesDiagnosticOmo(statut, FORMATS).find((candidate) => candidate.cle === cle);
  assert.ok(trouvee, `ligne ${cle}`);
  return trouvee;
};

/** Phrase de omo-room-texts.ts dont la liste masquée est rendue à part : le gabarit {liste} ne doit jamais rester affiché. */
const sansListe = (phrase: string) => phrase.replace("{liste}", "").trim();

// --- 1. Diagnostic OMO : ce que l'écran affiche ----------------------------------------------------------------------------------

describe("L26b : Diagnostic OMO, avec un état complet", () => {
  it("les lignes attendues sont là, dans l'ordre du §4.12", () => {
    assert.deepEqual(
      lignesDiagnosticOmo(COMPLET, FORMATS).map((l) => l.cle),
      [
        "etat",
        "image",
        "manifeste",
        "version",
        "demarrage",
        "liste-blanche",
        "projets",
        "projet:cockpit",
        "projet:vieux-projet",
        "workspace-git",
        "auth",
        "battement",
        "sans-demande",
      ],
    );
  });

  it("image chargée : identifiant, manifeste, version et date d'audit", () => {
    assert.equal(ligne(COMPLET, "etat").valeur, T.etats.prete);
    assert.equal(ligne(COMPLET, "image").valeur, "chargée");
    assert.equal(ligne(COMPLET, "image").indice, COMPLET.image.id);
    assert.equal(ligne(COMPLET, "manifeste").valeur, COMPLET.image.manifesteSha256);
    assert.equal(ligne(COMPLET, "version").valeur, "4.19.4");
    assert.equal(ligne(COMPLET, "version").indice, "Auditée le 2026-09-12.");
  });

  it("dernier démarrage, liste blanche de sortie et projets préparés avec l'état de leur .git", () => {
    assert.equal(ligne(COMPLET, "demarrage").valeur, "le 1700000000000");
    assert.equal(ligne(COMPLET, "demarrage").indice, "start-7");
    assert.equal(ligne(COMPLET, "liste-blanche").valeur, "api.githubcopilot.com");
    assert.equal(ligne(COMPLET, "projets").valeur, "2");
    assert.equal(ligne(COMPLET, "projet:cockpit").valeur, T.git["lecture-seule"]);
    assert.equal(ligne(COMPLET, "projet:cockpit").ton, "good");
    assert.equal(ligne(COMPLET, "projet:vieux-projet").valeur, T.git.inscriptible);
    assert.equal(ligne(COMPLET, "projet:vieux-projet").ton, "critical");
  });

  it("A16 (4) : les .git non protégés portent la phrase des textes et la liste masquée des chemins", () => {
    const git = ligne(COMPLET, "workspace-git");
    assert.equal(git.label, sansListe(T.refus["workspace-non-verifie"]));
    assert.equal(git.ton, "critical");
    assert.deepEqual(git.chemins, ["notes/.git"]);
    assert.doesNotMatch(git.label, /\{liste\}/, "le gabarit est remplacé par la vraie liste, jamais affiché");
    assert.equal(git.indice, "Dernier balayage : le 1700000050000.");
  });

  it("dossier de travail trop grand, ou balayage non publié : dit pour ce qu'il est (P3)", () => {
    assert.equal(ligne(avec({ workspaceGit: { verifieLe: 1, limiteAtteinte: true, nonProteges: [] } }), "workspace-git").label, T.diagnostic.limiteAtteinte);
    assert.equal(ligne(avec({ workspaceGit: null }), "workspace-git").valeur, "balayage non publié");
    const propre = ligne(avec({ workspaceGit: { verifieLe: 5, limiteAtteinte: false, nonProteges: [] } }), "workspace-git");
    assert.equal(propre.ton, "good");
    assert.deepEqual(propre.chemins, []);
  });

  it("authentification de la salle : sa présence seulement, jamais son contenu", () => {
    assert.equal(ligne(COMPLET, "auth").label, T.diagnostic.authPresente);
    assert.equal(ligne(avec({ authSalle: { presente: false } }), "auth").label, T.diagnostic.authAbsente);
    const tout = JSON.stringify(lignesDiagnosticOmo(COMPLET, FORMATS));
    for (const secret of ["auth.json", "Authorization", "ghu_", "gho_", "Bearer"]) assert.doesNotMatch(tout, new RegExp(secret), secret);
  });

  it("battement du cockpit et emplacement du tableau « sans demande »", () => {
    assert.equal(ligne(COMPLET, "battement").label, T.diagnostic.battementActif);
    assert.equal(ligne(COMPLET, "battement").valeur, "4000 ms");
    const absent = ligne(avec({ battement: { actif: false, ageMs: null } }), "battement");
    assert.equal(absent.label, T.diagnostic.battementAbsent);
    assert.equal(absent.ton, "critical");
    assert.equal(ligne(COMPLET, "sans-demande").label, T.activation.boutons.sansDemande);
  });

  it("aucun chemin du PC : les chemins restent relatifs au dossier de travail", () => {
    const tout = JSON.stringify(lignesDiagnosticOmo(COMPLET, FORMATS)) + JSON.stringify(raisonsAttente(COMPLET));
    assert.doesNotMatch(tout, /[A-Za-z]:\\\\/, "aucun chemin Windows absolu");
    assert.doesNotMatch(tout, /"\/(?:home|Users|mnt|workspace)\//, "aucun chemin absolu de l'hôte ni du conteneur");
  });

  it("pré-contrôle du dernier démarrage : verdict par projet et chemins trouvés", () => {
    assert.deepEqual(lignesPrecontrole(COMPLET), [
      { projet: "cockpit", verdict: "conforme", phrase: "", chemins: [] },
      { projet: "vieux-projet", verdict: "refuse", phrase: T.precontrole["config-opencode"], chemins: ["opencode.jsonc"] },
    ]);
    assert.deepEqual(lignesPrecontrole(avec({ dernierDemarrage: null })), []);
  });
});

describe("L26b : Diagnostic OMO, état vide (salle non installée)", () => {
  it("§5.4 l.915 : la seule phrase affichée est celle de l'état vide", () => {
    assert.equal(salleInstallee(VIDE), false);
    assert.equal(salleInstallee(COMPLET), true);
    assert.equal(T.nonInstallee, "La Salle Oh My OpenAgent n'est pas installée sur ce poste.");
    assert.equal(raisonsAttente(VIDE)[0]?.phrase, T.nonInstallee);
    assert.match(lire(...DIAGNOSTIC_TSX), /salleInstallee\(statut\)/, "l'écran teste l'image chargée avant tout le reste");
    assert.match(lire(...DIAGNOSTIC_TSX), /T\.nonInstallee/, "la phrase de l'état vide vient des textes");
  });

  it("sans image, rien n'est affirmé : chaque ligne dit son ignorance", () => {
    assert.equal(ligne(VIDE, "image").valeur, "absente");
    assert.equal(ligne(VIDE, "manifeste").valeur, "inconnu");
    assert.equal(ligne(VIDE, "version").valeur, "inconnue");
    assert.equal(ligne(VIDE, "version").indice, "");
    assert.equal(ligne(VIDE, "demarrage").valeur, "aucun");
    assert.equal(ligne(VIDE, "liste-blanche").valeur, "aucun hôte autorisé");
    assert.equal(ligne(VIDE, "projets").indice, T.precontrole["non-prepare"]);
  });
});

// --- 2. Pourquoi la salle attend (A16 point 4) ------------------------------------------------------------------------------------

describe("L26b : raisons de l'attente de la salle", () => {
  it("salle prête mais dépôts non protégés : la phrase et les chemins, dans l'ordre", () => {
    assert.deepEqual(
      raisonsAttente(COMPLET).map((r) => r.cle),
      ["workspace-non-verifie", "git-inscriptible", "precheck:vieux-projet"],
    );
    const [workspace, inscriptible, precheck] = raisonsAttente(COMPLET);
    assert.equal(workspace?.phrase, sansListe(T.refus["workspace-non-verifie"]));
    assert.deepEqual(workspace?.chemins, ["notes/.git"]);
    assert.equal(inscriptible?.phrase, sansListe(T.refus["git-inscriptible"]));
    assert.deepEqual(inscriptible?.chemins, ["vieux-projet"]);
    assert.equal(precheck?.phrase, `Le pré-contrôle de vieux-projet n'est pas conforme : rien n'a été lancé. ${T.precontrole["config-opencode"]}`);
  });

  it("salle coupée, suspendue, en relance, battement perdu : chaque cause a sa phrase, aucune n'est inventée", () => {
    assert.deepEqual(
      raisonsAttente(VIDE).map((r) => r.phrase),
      [T.nonInstallee, T.refus["salle-coupee"], sansListe(T.refus["workspace-non-verifie"]), T.refus["battement-absent"]],
    );
    const suspendue = avec({ etatSalle: "suspendue", workspaceGit: { verifieLe: 1, limiteAtteinte: false, nonProteges: [] }, projetsPrepares: [] });
    assert.deepEqual(
      raisonsAttente({ ...suspendue, dernierDemarrage: null }).map((r) => r.phrase),
      [T.refus["salle-suspendue"]],
    );
    const relance = avec({ etatSalle: "en-relance", workspaceGit: { verifieLe: 1, limiteAtteinte: true, nonProteges: [] }, projetsPrepares: [] });
    assert.deepEqual(
      raisonsAttente({ ...relance, dernierDemarrage: null }).map((r) => r.phrase),
      [T.refus["salle-en-relance"], T.diagnostic.limiteAtteinte],
    );
    const coupee = avec({ interrupteurs: { omo: true, autonomie: false, salleOuverte: true } });
    assert.ok(raisonsAttente(coupee).some((r) => r.phrase === T.refus["autonomie-coupee"]));
  });

  it("rien ne bloque : aucune raison, donc aucune section", () => {
    const propre = avec({
      projetsPrepares: [{ chemin: "cockpit", git: "lecture-seule" }],
      workspaceGit: { verifieLe: 1, limiteAtteinte: false, nonProteges: [] },
      dernierDemarrage: { startId: "start-8", at: 1, precheck: [{ projet: "cockpit", verdict: "conforme", raison: null, trouves: [] }] },
    });
    assert.deepEqual(raisonsAttente(propre), []);
  });
});

// --- 3. Journal du contrôle : lignes de la Salle OMO --------------------------------------------------------------------------------

describe("L26b : lignes de Salle OMO du Journal", () => {
  it("refus-interdit et « par : extension » ont un mot, et la marque « non contrôlé avant exécution »", () => {
    assert.equal(estDecisionOmo({ verdict: "refus-interdit", par: "regles" }), true);
    assert.equal(estDecisionOmo({ verdict: "auto", par: "extension" }), true);
    assert.equal(estDecisionOmo({ verdict: "auto", par: "regles" }), false);
    assert.deepEqual(marquesOmo({ verdict: "refus-interdit", par: "regles", regle: "fichier-cle" }), [
      `Interdit absolu du cockpit : ${T.interdits.categories["fichier-cle"]}. N'essayez pas de le contourner.`,
    ]);
    assert.deepEqual(marquesOmo({ verdict: "auto", par: "extension", regle: "A-grep" }), [T.marques.nonControle]);
    assert.deepEqual(marquesOmo({ verdict: "auto", par: "regles", regle: "A-grep" }), []);
    // Règle inconnue : aucune phrase inventée (P3).
    assert.deepEqual(marquesOmo({ verdict: "refus-interdit", par: "regles", regle: "S4-inconnue" }), []);
    assert.equal(DECISION_REFUS_INTERDIT, "Refusé : interdit absolu");
    assert.equal(PAR_EXTENSION, "l'extension");
  });

  it("détections : la phrase de la cause, suivie du rappel qu'elle vient après coup", () => {
    assert.equal(phraseDetectionJournal("git-cree"), `${T.detections["git-cree"]} ${T.detectionApresCoup}`);
    assert.match(phraseDetectionJournal("activite-hors-demande"), /après coup/);
  });

  it("quarantaine : le chemin remplit le gabarit, aucun gabarit ne reste affiché", () => {
    const phrase = phraseQuarantaine({ chemin: "vieux-projet/.git", genre: "git-quarantaine" });
    assert.match(phrase, /vieux-projet\/\.git/);
    assert.doesNotMatch(phrase, /\{chemin\}/);
    assert.equal(phraseQuarantaine({ chemin: ".vscode/tasks.json", genre: "ide-ci" }), T.signales["ide-ci"]);
  });

  it("le Journal affiche ces lignes : elles ne sont plus écartées, et elles arrivent par propriétés", () => {
    const source = code(...JOURNAL_TSX);
    assert.doesNotMatch(source, /estPrincipale/, "plus aucun filtre qui écarte les décisions de la salle");
    assert.match(source, /lu\.data\?\.decisions \?\? \[\]/, "toutes les décisions enregistrées sont rendues");
    assert.match(source, /libelleDecisionPrincipale\(verdict\) : DECISION_REFUS_INTERDIT/, "le mot de l'interdit absolu, sans toucher aux autres");
    assert.match(source, /libellePar\(par\) : PAR_EXTENSION/, "le « Par » de l'extension, sans toucher aux autres");
    assert.match(source, /phraseDetectionJournal\(detection\.cause\)/, "les détections ont leur phrase");
    assert.match(source, /phraseQuarantaine\(signale\)/, "les fichiers mis de côté ont la leur");
    assert.match(source, /detections\?: readonly JournalDetection\[\]/, "détections passées par propriétés");
    assert.match(source, /quarantaine\?: readonly OmoSignale\[\]/, "quarantaine passée par propriétés");
    assert.equal(/fetch\(|http\.post|http\.put/.test(source), false, "aucune route nouvelle, aucune écriture");
    assert.equal(source.includes("api-omo"), false, "le Journal n'appelle pas la salle");
  });
});

// --- 4. Règle de vague : alimenté par propriétés, rien d'autre ----------------------------------------------------------------------

describe("L26b : règle de vague et périmètre", () => {
  it("le Diagnostic OMO ne fait aucun appel réseau et n'importe rien de L26a", () => {
    const source = code(...DIAGNOSTIC_TSX);
    assert.equal(/fetch\(|XMLHttpRequest|EventSource/.test(source), false, "aucun appel réseau dans le composant");
    assert.equal(source.includes("api-omo"), false, "api-omo.ts appartient à L26a (même vague)");
    assert.equal(source.includes("pages/omo"), false, "pages/omo/** appartient à L26a (même vague)");
    assert.match(source, /statut: OmoStatusResponse/, "l'état arrive par propriétés (T3a)");
    assert.match(source, /from "\.\/omo-diagnostics\.ts"/, "les calculs sont dans le module pur");
  });

  it("D-2b-45 : ni la bande néon ni sa feuille de style ne sont touchées", () => {
    for (const fichier of [DIAGNOSTIC_TSX, JOURNAL_TSX]) {
      const source = code(...fichier);
      assert.equal(source.includes("NeonBand"), false, fichier.join("/"));
      assert.equal(source.includes("neon.css"), false, fichier.join("/"));
    }
  });

  it("le point d'insertion de getOmoStatus() est laissé à l'intégrateur, et la carte reste absente sans lui", () => {
    const source = lire(...PAGE_TSX);
    assert.match(source, /POINT D'INSERTION DU TRAIN DE LA VAGUE 2/, "le point d'insertion est signalé");
    assert.match(source, /getOmoStatus\(\)/, "l'intégrateur sait quoi brancher");
    assert.match(source, /function useOmoStatus\([^)]*\): OmoStatusResponse \| null \{\s*return null;\s*\}/, "non branché : aucun état inventé");
    assert.match(source, /<OmoDiagnostics statut=\{omoStatut\} \/>/, "la carte est posée, alimentée par propriétés");
    assert.equal(code(...PAGE_TSX).includes("api-omo"), false, "la page n'importe pas api-omo.ts (L26a, même vague)");
  });

  it("le périmètre de web-animations couvre pages/omo", () => {
    assert.match(lire(...ANIMATIONS_TEST), /"pages\/omo"/, "la Salle OMO est soumise aux règles de mouvement");
  });
});
