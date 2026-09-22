// Liens de la construction avec l'itération 4 (itération 5b, vague 3, paquet L44f ; conception C §9.4, §9.6, §9.7, §9.8 ;
// conception A §7.7 ; spécification §1.1 n° 1 ; plan d'exécution it5 §4.3, §2.7, D-5-06, D-5-22, D-5-24).
//
// Quatre liens, et rien d'autre :
//   1. l'onglet « Méthodes » (`#/assistants/methodes`) dans les onglets de l'itération 4, et la section de la page devenue un
//      lien vers lui ;
//   2. la puce de méthode éteinte quand une équipe tient la saisie, avec la phrase du §4.3 ;
//   3. [Seconde lecture] sous la carte de résultat d'une équipe, variante de texte « equipe », MASQUÉE pendant un lancement de
//      la conversation (le proxy refuserait l'envoi en 409 `equipe-en-cours`) ;
//   4. les deux messages qu'une équipe fait écrire au cockpit rendus à leur auteur dans la transcription archivée.
//
// Ce que les liens ne changent PAS, et qui est gardé ici : aucune route, aucun en-tête, aucun contrat de repli pour la Seconde
// lecture (MC5-1 est tenue), `SecondReadingEstimate.base` sans « reponse », et jamais « au moins » dans un libellé (D-5-22).
//
// Méthode : le comportement là où il est écrit en TypeScript pur (routes, découpage des archives, verrou d'équipe, textes) est
// éprouvé en l'appelant ; les branchements écrits en TSX, que Node ne peut pas importer, sont lus dans le source, comme le font
// déjà `web-equipes-slots.test.ts`, `web-team-cards.test.ts` et `agent-choice.test.ts`. Chaque lecture de source est doublée
// d'un contrôle discriminant : la règle échoue sur un source fabriqué qui la viole.
//
// Aucun réseau, aucune base, aucune IA : tout est pur ou lu sur le disque.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import { buildDigest } from "./archive.ts";
import type { OcMessageWithParts, OcSession } from "./opencode.ts";
import { estMessageDeSecondeLecture } from "./second-reading.ts";
import { secondReadingButtonLabel, secondReadingMessageFor, secondReadingTooltip } from "./shared/chat-methods-view.ts";
import { TEXTES, secondReadingPrefix } from "./shared/construction-texts.ts";
import type { SecondReadingEstimate } from "./shared/construction-types.ts";
import { injectionText } from "./shared/flow.ts";
import type { TeamRunState, TeamRunView } from "./shared/team-types.ts";
import {
  ASSISTANTS_TABS,
  type AssistantsView,
  assistantsHref,
  assistantsTabHref,
  assistantsTabOf,
  assistantsViewOf,
  parseRoute,
  parseRouteQuery,
} from "../web/lib/router.ts";
import { blocsDArchive } from "../web/pages/chat/team/team-transcript.ts";
import { verrouDe } from "../web/pages/chat/team/team-view-model.ts";

const APP_DIR = path.join(import.meta.dirname, "..");

/** Source d'un fichier, chemin relatif au dossier app (séparateur « / »). */
const lire = (fichier: string) => fs.readFileSync(path.join(APP_DIR, fichier), "utf8");
const blanc = (texte: string) => texte.replace(/[^\n]/g, " ");
/** Commentaires retirés, positions gardées : une règle ne doit jamais être « vérifiée » par un commentaire. */
const sansCommentaires = (texte: string) => texte.replace(/\/\*[\s\S]*?\*\//g, blanc).replace(/\/\/[^\n]*/g, blanc);

const COMPOSEUR = "web/pages/chat/Composer.tsx";
const CARTE_RESULTAT = "web/pages/chat/team/TeamResultCard.tsx";
const BOUTON = "web/pages/chat/methods/SecondReadingButton.tsx";
const PAGE_ASSISTANTS = "web/pages/AssistantsPage.tsx";
const ONGLETS = "web/pages/assistants/AssistantsTabs.tsx";
const ARCHIVE = "web/pages/archives/ArchiveDetail.tsx";
const ROUTEUR = "web/lib/router.ts";

/** Les six fichiers d'interface touchés par le paquet : les gardes communes valent pour tous. */
const TOUCHES: readonly string[] = [COMPOSEUR, CARTE_RESULTAT, BOUTON, PAGE_ASSISTANTS, ONGLETS, ARCHIVE, ROUTEUR];

// --- 1. Onglet « Méthodes » ------------------------------------------------------------------------------------------------

describe("liens de la construction : onglet « Méthodes »", () => {
  const vueDe = (href: string): AssistantsView => assistantsViewOf(parseRoute(href), parseRouteQuery(href));

  it("#/assistants/methodes est une vue d'AssistantsView, et son adresse fait l'aller-retour", () => {
    assert.deepEqual(vueDe("#/assistants/methodes"), { mode: "methodes" });
    assert.equal(assistantsHref({ mode: "methodes" }), "#/assistants/methodes");
    assert.deepEqual(vueDe(assistantsHref({ mode: "methodes" })), { mode: "methodes" });
  });

  it("l'onglet est le dernier ; l'ordre des trois onglets de l'itération 4 ne bouge pas", () => {
    assert.deepEqual([...ASSISTANTS_TABS], ["assistants", "equipes", "carte", "methodes"]);
    assert.equal(assistantsTabHref("methodes"), "#/assistants/methodes");
    assert.equal(assistantsTabOf({ mode: "methodes" }), "methodes");
    // Les vues voisines gardent leur onglet : l'ajout n'en déplace aucune.
    assert.equal(assistantsTabOf({ mode: "liste" }), "assistants");
    assert.equal(assistantsTabOf({ mode: "equipes" }), "equipes");
    assert.equal(assistantsTabOf({ mode: "carte", element: null }), "carte");
    // Vues en pleine page : toujours aucun onglet.
    assert.equal(assistantsTabOf({ mode: "nouveau" }), null);
  });

  it("une adresse « methodes » avec un segment en trop retombe sur la vue par défaut, jamais sur l'onglet", () => {
    for (const href of ["#/assistants/methodes/x", "#/assistants/methodes/x/y", "#/assistants/methodes/nouvelle"]) {
      assert.deepEqual(vueDe(href), { mode: "liste" }, href);
    }
    // Un paramètre d'adresse ne change rien : l'onglet n'en lit aucun.
    assert.deepEqual(vueDe("#/assistants/methodes?element=vous"), { mode: "methodes" });
  });

  it("l'onglet porte son libellé, et la page monte la bibliothèque dans la page à onglets de l'itération 4", () => {
    const onglets = sansCommentaires(lire(ONGLETS));
    assert.match(onglets, /methodes: "Méthodes"/);
    const page = sansCommentaires(lire(PAGE_ASSISTANTS));
    assert.match(page, /if \(teamView\.mode === "methodes"\) return <MethodsTab advanced=\{advanced\} \/>;/);
    assert.match(page, /<AssistantsTabsPage current="methodes">/);
    assert.match(page, /<MethodsLibrary/);
  });

  it("la section « Méthodes » de la page est devenue un LIEN vers l'onglet : elle ne monte plus la bibliothèque", () => {
    const page = sansCommentaires(lire(PAGE_ASSISTANTS));
    const section = page.slice(page.indexOf("<Section title=\"Méthodes\""), page.indexOf("</Section>", page.indexOf("<Section title=\"Méthodes\"")));
    assert.notEqual(section, "");
    assert.match(section, /href=\{assistantsTabHref\("methodes"\)\}/);
    assert.doesNotMatch(section, /<MethodsLibrary/, "la bibliothèque n'est montée que par l'onglet");
    // Contrôle discriminant : la section d'avant le paquet serait vue.
    assert.match('<Section title="Méthodes">\n<MethodsLibrary />\n</Section>', /<MethodsLibrary/);
  });
});

// --- 2. Puce de méthode avec une équipe --------------------------------------------------------------------------------------

describe("liens de la construction : puce de méthode quand une équipe tient la saisie", () => {
  it("la phrase est celle du §4.3, prise au module de textes et jamais réécrite", () => {
    assert.equal(TEXTES.partout.methodes.limites.equipe, "Les méthodes d'une équipe se règlent sur ses étapes.");
    const composeur = lire(COMPOSEUR);
    assert.match(composeur, /TEXTES_C5\.partout\.methodes\.limites\.equipe/);
    assert.doesNotMatch(sansCommentaires(composeur), /"Les méthodes d'une équipe/, "la phrase n'est pas recopiée dans le composant");
  });

  it("la puce est DÉSACTIVÉE et la phrase affichée, une seule fois, quelle que soit la ligne des méthodes retenues", () => {
    const code = sansCommentaires(lire(COMPOSEUR));
    assert.match(code, /const equipeChoisie = team !== undefined && disabled;/);
    assert.match(code, /desactive=\{disabled \|\| equipeChoisie\}/);
    // La phrase passe par la ligne des méthodes retenues ; sans aucune méthode retenue, elle est posée seule.
    assert.match(code, /raison=\{raisonMethodes\}/);
    assert.match(code, /\{equipeChoisie && methodes\.length === 0 \? \(/);
    // L'équipe l'emporte sur les deux refus de L44e, qui restent écrits.
    const raison = code.slice(code.indexOf("const raisonMethodes"), code.indexOf("const onCommandChangeRef"));
    assert.ok(raison.indexOf("equipeChoisie") < raison.indexOf("methodChipReason(\"raccourci\")"), raison);
    assert.match(raison, /methodChipReason\("sans-texte"\)/);
  });

  it("aucune constante propre au mode Simple des équipes n'est créée par le paquet (D-5-24)", () => {
    for (const fichier of TOUCHES) {
      const code = sansCommentaires(lire(fichier));
      assert.doesNotMatch(code, /\bEQUIPES_SIMPLE_OUVERTES\s*=/, fichier);
      assert.doesNotMatch(code, /\bconst [A-Z_]*SIMPLE[A-Z_]* =/, fichier);
    }
    // Contrôle discriminant.
    assert.match("const SECONDE_LECTURE_SIMPLE = true;", /\bconst [A-Z_]*SIMPLE[A-Z_]* =/);
  });
});

// --- 3. [Seconde lecture] sous la carte de résultat d'une équipe --------------------------------------------------------------

/** Lancement d'équipe minimal : seul `state` compte pour le verrou de la conversation. */
function lancement(state: TeamRunState, patch: Partial<TeamRunView> = {}): TeamRunView {
  return {
    id: "run-1",
    teamId: "revue-sql",
    titre: "Revue SQL sur réplica",
    rootId: "ses_root",
    directory: "/w/projet",
    state,
    cause: null,
    modeUi: "avance",
    estimate: { typique: 0.1, maximum: 0.4 },
    plafond: 0.4,
    cost: 0.09,
    steps: [],
    pause: null,
    relancable: false,
    suite: null,
    resultatsAjoutes: false,
    requestMessageId: "msg_demande",
    resultMessageId: "msg_resultat",
    createdAt: 1_000,
    startedAt: 2_000,
    endedAt: 10_000,
    ...patch,
  };
}

describe("liens de la construction : Seconde lecture d'un résultat d'équipe", () => {
  it("PENDANT un lancement, la conversation est verrouillée ; APRÈS, elle ne l'est plus", () => {
    // Le bouton suit exactement le verrou de la saisie : une seule règle pour les deux (D-eq-16).
    for (const state of ["preparation", "en-cours", "attente-verification", "attente-budget"] as const) {
      assert.notEqual(verrouDe([lancement(state)]), null, state);
    }
    for (const state of ["terminee", "arretee", "echec", "interrompue", "plafond"] as const) {
      assert.equal(verrouDe([lancement(state)]), null, state);
    }
    // Un lancement terminé et un autre en cours dans la MÊME conversation : le verrou tient, le bouton reste masqué.
    assert.notEqual(verrouDe([lancement("terminee"), lancement("en-cours", { id: "run-2" })]), null);
    assert.equal(verrouDe([]), null);
  });

  it("la carte masque le bouton pendant un lancement, et ne le propose que si les équipes sont ouvertes (U1, D-5-24)", () => {
    const code = sansCommentaires(lire(CARTE_RESULTAT));
    assert.match(code, /const secondeLectureProposee = useEquipesOuvertes\(advanced\) && verrouDe\(runs\) === null;/);
    assert.match(code, /\{secondeLectureProposee \? \(/);
    assert.match(code, /<SecondReadingButton/);
    assert.match(code, /cible="equipe"/);
    // `ouvertesEnSimple` de GET /api/teams est la SEULE valeur qui ouvre les équipes en Simple ; fermé par défaut.
    assert.match(code, /teamsApi\.list\(/);
    assert.match(code, /reponse\.ouvertesEnSimple === true/);
    assert.match(code, /useState\(false\)/);
    assert.match(code, /return advanced \|\| ouvertesEnSimple;/);
  });

  it("le message envoyé est le texte EXACT de la variante « equipe », et le serveur le reconnaît", () => {
    const equipe = "Revue SQL sur réplica";
    const message = secondReadingMessageFor("equipe", equipe);
    assert.equal(
      message,
      "Seconde lecture du résultat de l'équipe « Revue SQL sur réplica ». Vérifie-le avec ta liste de contrôle. Relis les fichiers cités si tu y as accès. Ne change pas une conclusion sourcée sans fait nouveau.",
    );
    assert.equal(message, TEXTES.partout.secondeLecture.messageEquipe.replace("{equipe}", equipe));
    assert.ok(message.startsWith(secondReadingPrefix("equipe")));
    // Le crochet du serveur (D-5-06) requalifie la ligne : la variante « equipe » est reconnue comme celle d'une réponse.
    assert.equal(estMessageDeSecondeLecture(message), true);
    assert.equal(estMessageDeSecondeLecture(secondReadingMessageFor("reponse", "Relire un script")), true);
    assert.equal(estMessageDeSecondeLecture("Seconde lecture, s'il te plaît."), false);
  });

  it("un titre d'équipe n'est jamais lu comme une séquence de remplacement, et sa casse est gardée", () => {
    for (const titre of ["$&", "$'", "$`", "$$", "A$&B", "{equipe}"]) {
      const message = secondReadingMessageFor("equipe", titre);
      assert.ok(message.includes(`« ${titre} »`), `${titre} → ${message}`);
      assert.ok(message.startsWith(secondReadingPrefix("equipe")), titre);
    }
  });

  it("le libellé porte « ≈ », jamais « au moins » (D-5-22), et sans montant il perd seulement sa parenthèse", () => {
    assert.equal(secondReadingButtonLabel("0,06"), "Seconde lecture (≈ 0,06 $)");
    assert.equal(secondReadingButtonLabel(null), "Seconde lecture");
    for (const montant of ["0,06", "1,20", null]) {
      assert.doesNotMatch(secondReadingButtonLabel(montant), /au moins/i, String(montant));
    }
    const estimation: SecondReadingEstimate = {
      installe: true,
      assistant: { name: "relecteur-critique", title: "Relecteur critique" },
      ia: { model: "github-copilot/gpt-5-mini", libelle: "Rapide" },
      usd: 0.06,
      base: "conversation",
    };
    const infobulle = secondReadingTooltip(estimation) ?? "";
    assert.ok(infobulle.includes("Rapide"), infobulle);
    assert.ok(infobulle.includes(TEXTES.partout.secondeLecture.base.conversation), infobulle);
    assert.doesNotMatch(infobulle, /au moins/i);
    // Aucun texte de Seconde lecture ne porte « au moins », quelle que soit la base.
    for (const phrase of Object.values(TEXTES.partout.secondeLecture)) {
      for (const valeur of typeof phrase === "string" ? [phrase] : Object.values(phrase)) {
        assert.doesNotMatch(String(valeur), /au moins/i, String(valeur));
      }
    }
  });

  it("MC5-1 tenue : aucun contrat de repli, et `SecondReadingEstimate.base` ne gagne pas « reponse »", () => {
    const types = sansCommentaires(lire("server/shared/construction-types.ts"));
    assert.match(types, /base: "conversation" \| "observe" \| "profil" \| "aucune";/);
    assert.doesNotMatch(types, /base: [^;]*"reponse"/);
    // Le bouton ne connaît qu'une voie : un `prompt_async` dans la conversation, sans session enfant ni route propre.
    const bouton = sansCommentaires(lire(BOUTON));
    assert.match(bouton, /oc\.promptAsync\(/);
    assert.doesNotMatch(bouton, /\brepli\b/i);
    assert.doesNotMatch(bouton, /POST \/session/);
  });
});

// --- 4. Marqueurs de l'itération 4 dans les Archives --------------------------------------------------------------------------

const EQUIPE = "Revue SQL sur réplica";
const RUN = "run-1";
const DEMANDE = "Le traitement de nuit est tombé deux fois cette semaine.";
const RESULTAT = "Trois causes possibles, la première est la plus probable.";

const session = { id: "ses_1", projectID: "p", directory: "/workspace/app", title: "Incident", time: { created: 1, updated: 9 } } as OcSession;

/** Message utilisateur de la transcription archivée (forme lue par `buildDigest`). */
function messageUtilisateur(id: string, texte: string, created: number): OcMessageWithParts {
  return {
    info: { id, sessionID: "ses_1", role: "user", time: { created } },
    parts: [{ id: `prt_${id}`, sessionID: "ses_1", messageID: id, type: "text", text: texte }],
  } as unknown as OcMessageWithParts;
}

/** Réponse d'assistant de la transcription archivée. */
function messageAssistant(id: string, texte: string, created: number): OcMessageWithParts {
  return {
    info: {
      id,
      sessionID: "ses_1",
      role: "assistant",
      time: { created },
      agent: "build",
      providerID: "github-copilot",
      modelID: "claude-sonnet-5",
      cost: 0,
      tokens: { input: 1, output: 1, reasoning: 0, cache: { read: 0, write: 0 } },
    },
    parts: [{ id: `prt_${id}`, sessionID: "ses_1", messageID: id, type: "text", text: texte }],
  } as unknown as OcMessageWithParts;
}

/** Transcription archivée d'une conversation qui a lancé une équipe : les deux injections sont celles de l'itération 4. */
function transcriptionAvecEquipe(): string {
  return buildDigest(
    session,
    [
      messageUtilisateur("msg_1", "Regarde cet incident.", 1),
      messageAssistant("msg_2", "D'accord.", 2),
      messageUtilisateur("msg_3", injectionText("demande", { runId: RUN, equipe: EQUIPE, texte: DEMANDE }), 3),
      messageUtilisateur("msg_4", injectionText("resultat", { runId: RUN, equipe: EQUIPE, texte: RESULTAT }), 4),
      messageAssistant("msg_5", "Voici la suite.", 5),
    ],
    "/workspace",
  ).transcript;
}

describe("liens de la construction : marqueurs de l'itération 4 dans les Archives", () => {
  it("les deux messages écrits par le cockpit pour l'équipe forment leur propre bloc, dans l'ordre", () => {
    const blocs = blocsDArchive(transcriptionAvecEquipe());
    assert.deepEqual(
      blocs.map((bloc) => bloc.genre),
      ["texte", "equipe-demande", "equipe-resultat", "texte"],
    );
    assert.ok(blocs[1]?.texte.includes(DEMANDE), blocs[1]?.texte);
    assert.ok(blocs[2]?.texte.includes(RESULTAT), blocs[2]?.texte);
    // Les sections ordinaires restent celles de l'itération 1, et rien ne se perd.
    assert.ok(blocs[0]?.texte.includes("Regarde cet incident."), blocs[0]?.texte);
    assert.ok(blocs[3]?.texte.includes("Voici la suite."), blocs[3]?.texte);
  });

  it("aucune ligne de marqueur du cockpit n'est rendue", () => {
    for (const bloc of blocsDArchive(transcriptionAvecEquipe())) {
      assert.doesNotMatch(bloc.texte, /cockpit:/, bloc.genre);
    }
    // Contrôle discriminant : la transcription, elle, les porte bien.
    assert.match(transcriptionAvecEquipe(), /<!-- cockpit:equipe-demande run=run-1 -->/);
  });

  it("une transcription sans marqueur rend un bloc unique, à l'octet près", () => {
    const sansEquipe = buildDigest(session, [messageUtilisateur("msg_1", "Bonjour.", 1), messageAssistant("msg_2", "Bonjour !", 2)], "/workspace").transcript;
    const blocs = blocsDArchive(sansEquipe);
    assert.equal(blocs.length, 1);
    assert.equal(blocs[0]?.genre, "texte");
    assert.equal(blocs[0]?.texte, sansEquipe.trim());
    assert.deepEqual(blocsDArchive(""), [{ genre: "texte", texte: "" }]);
  });

  it("un marqueur recopié par une IA ou tapé par vous ne fait pas une carte d'équipe (risque 19)", () => {
    const recopie = `Voici ce que j'ai lu :\n<!-- cockpit:equipe-resultat run=run-1 -->\nTexte que je vous recopie.`;
    const transcript = buildDigest(session, [messageAssistant("msg_1", recopie, 1)], "/workspace").transcript;
    const blocs = blocsDArchive(transcript);
    assert.deepEqual(
      blocs.map((bloc) => bloc.genre),
      ["texte"],
      "le marqueur n'ouvre pas le corps de la section : elle reste ordinaire",
    );
    // Un marqueur au milieu d'une ligne n'est pas reconnu non plus (flow.ts n'en écrit jamais de cette forme).
    assert.deepEqual(
      blocsDArchive("## 🧑 Vous · x\n\nvoir <!-- cockpit:equipe-demande run=run-1 --> ici").map((bloc) => bloc.genre),
      ["texte"],
    );
    // Contrôle discriminant : en tête du corps, il est reconnu.
    assert.deepEqual(
      blocsDArchive("## 🧑 Vous · x\n\n<!-- cockpit:equipe-demande run=run-1 -->\n\nma demande").map((bloc) => bloc.genre),
      ["equipe-demande"],
    );
  });

  it("la fiche d'Archives rend les deux blocs en cartes nommées, par le composant Markdown existant", () => {
    const code = sansCommentaires(lire(ARCHIVE));
    assert.match(code, /"equipe-demande": "Demande à l'équipe"/);
    assert.match(code, /"equipe-resultat": "Réponse de l'équipe"/);
    assert.match(code, /blocsDArchive\(texte\)/);
    assert.match(code, /<Markdown text=\{bloc\.texte\} className="archive-transcript" \/>/);
    assert.match(code, /aria-label=\{TITRES_EQUIPE\[bloc\.genre\]\}/);
  });

  it("une carte d'équipe ne garde pas le titre « ## 🧑 Vous · … » qu'elle est là pour corriger", () => {
    const blocs = blocsDArchive(transcriptionAvecEquipe());
    for (const bloc of blocs) {
      if (bloc.genre !== "texte") assert.doesNotMatch(bloc.texte, /^## /m, `${bloc.genre} : ${JSON.stringify(bloc.texte)}`);
    }
    // Le corps, lui, est rendu entier, et sans les lignes vides laissées par le retrait du marqueur : la demande recopiée
    // commence à la demande, et le résultat injecté garde son enveloppe de l'itération 4, rien de plus.
    assert.equal(blocs[1]?.texte, DEMANDE);
    assert.ok((blocs[2]?.texte ?? "").includes(RESULTAT), blocs[2]?.texte);
    assert.doesNotMatch(blocs[2]?.texte ?? "", /^\s/, "aucune ligne vide de tête laissée par le marqueur");
    // Contrôle discriminant : les sections ORDINAIRES gardent bien leurs titres, à la place qu'elles occupaient.
    assert.match(blocs[0]?.texte ?? "", /^## 🧑 Vous · /);
    assert.match(blocs[3]?.texte ?? "", /^## 🤖 /);
  });

  it("le découpage reste linéaire, et il n'est pas rejoué à chaque rendu de la fiche", () => {
    // Une conversation longue archivée : `buildDigest` ouvre une section par message, et `MAX_TRANSCRIPT` (archive.ts) laisse
    // passer 200 000 caractères. Recopier le bloc déjà écrit à chaque section coûtait le carré du nombre de sections.
    const lignes: string[] = [];
    for (let i = 0; i < 2000; i++) lignes.push(`## 🧑 Vous · section ${i}`, "", `Corps de la section ${i}, avec de quoi peser.`, "");
    const texte = lignes.join("\n");
    const debut = performance.now();
    const blocs = blocsDArchive(texte);
    const duree = performance.now() - debut;
    assert.equal(blocs.length, 1, "les sections ordinaires restent collées entre elles");
    assert.equal(blocs[0]?.texte, texte.trim(), "et le texte reste celui de la transcription, à l'octet près");
    assert.ok(duree < 100, `2 000 sections découpées en ${duree.toFixed(0)} ms : le coût est redevenu quadratique`);
    // Et la vue ne refait pas le découpage à chaque rendu : la transcription archivée ne change jamais.
    assert.match(sansCommentaires(lire(ARCHIVE)), /useMemo\(\(\) => blocsDArchive\(texte\), \[texte\]\)/);
  });

  it("sections mêlées : le découpage rend exactement ce qu'il rendait, marqueurs et lignes vides compris", () => {
    // Cas composés à la main, dont la sortie est écrite ici en toutes lettres : c'est le garde-fou de la réunion des
    // sections, qui accumule désormais des LIGNES au lieu de recopier le texte.
    const cas: ReadonlyArray<readonly [string, ReadonlyArray<{ genre: string; texte: string }>]> = [
      ["", [{ genre: "texte", texte: "" }]],
      ["\n\n\n", [{ genre: "texte", texte: "" }]],
      ["## A\n\nun\n\n## B\n\ndeux\n", [{ genre: "texte", texte: "## A\n\nun\n\n## B\n\ndeux" }]],
      // Une section vide entre deux sections ordinaires ne double pas la ligne vide qui les sépare.
      ["## A\n\nun\n\n## vide\n\n\n## B\n\ndeux", [{ genre: "texte", texte: "## A\n\nun\n\n## vide\n\n## B\n\ndeux" }]],
      [
        "## A\n\nun\n\n## 🧑 Vous · x\n\n<!-- cockpit:equipe-demande run=r -->\n\nma demande\n\n## B\n\ndeux",
        [
          { genre: "texte", texte: "## A\n\nun" },
          { genre: "equipe-demande", texte: "ma demande" },
          { genre: "texte", texte: "## B\n\ndeux" },
        ],
      ],
      // Deux cartes d'équipe à la suite restent deux blocs, sans rien entre elles.
      [
        "## 🧑 Vous · x\n\n<!-- cockpit:equipe-demande run=r -->\n\nma demande\n\n## 🧑 Vous · y\n\n<!-- cockpit:equipe-resultat run=r -->\n\nle résultat",
        [
          { genre: "equipe-demande", texte: "ma demande" },
          { genre: "equipe-resultat", texte: "le résultat" },
        ],
      ],
      // Une carte d'équipe au corps vide reste une carte (son titre ne la remplit pas).
      ["## 🧑 Vous · x\n\n<!-- cockpit:equipe-resultat run=r -->\n", [{ genre: "equipe-resultat", texte: "" }]],
    ];
    for (const [transcript, attendu] of cas) {
      assert.deepEqual(blocsDArchive(transcript), attendu, JSON.stringify(transcript));
    }
  });
});

// --- Gardes communes du paquet -------------------------------------------------------------------------------------------------

describe("liens de la construction : ce que le paquet ne fait pas", () => {
  it("aucun texte d'IA, de fichier ou d'opencode inséré en HTML brut, aucune évaluation de code", () => {
    for (const fichier of TOUCHES) {
      const code = sansCommentaires(lire(fichier));
      assert.doesNotMatch(code, /dangerouslySetInnerHTML|innerHTML|insertAdjacentHTML/, fichier);
      assert.doesNotMatch(code, /\beval\s*\(|new Function\s*\(/, fichier);
    }
    // Contrôle discriminant.
    assert.match('el.innerHTML = texte;', /innerHTML/);
  });

  it("aucune route et aucun en-tête HTTP nouveaux", () => {
    for (const fichier of TOUCHES) {
      const code = sansCommentaires(lire(fichier));
      assert.doesNotMatch(code, /\bapp\.(get|post|put|delete)\(/, fichier);
      assert.doesNotMatch(code, /headers:\s*\{/, fichier);
      assert.doesNotMatch(code, /"x-cockpit-/, fichier);
    }
    assert.doesNotMatch(sansCommentaires(lire(BOUTON)), /headers:\s*\{|"x-cockpit-/);
    // Contrôle discriminant.
    assert.match('app.post("/api/x", handler);', /\bapp\.(get|post|put|delete)\(/);
  });

  it("aucun fichier interdit n'est touché par les liens : les contrats et le câblage 1.1 restent à l'intégrateur", () => {
    for (const fichier of TOUCHES) {
      const code = sansCommentaires(lire(fichier));
      assert.doesNotMatch(code, /contracts-11\.ts|wiring-11\.ts|config-queue\.ts|oc-copilot-config\.ts/, fichier);
      assert.doesNotMatch(code, /\bMIGRATIONS\b/, fichier);
    }
  });
});
