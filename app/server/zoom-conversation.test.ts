// Tests L31c, zooms 2 et 3 de la salle de contrôle (spécification §5.8 l.992-1009, §5.7.4, §5.6 l.928 ; plan d'exécution it3,
// fiche L31c, D-3d-11, D-3d-12, D-3d-17, D-3d-18, M20, U2, D-3d-14). Parties PURES seulement, jouées sous Node, sans navigateur :
//  1. cadence — une rafale de 50 faits en 1 s donne au plus 4 recalculs, et deux recalculs sont toujours séparés d'au moins
//     250 ms ; AUCUNE séquence d'ouvertures et de faits reçus ne dépasse 4 publications dans une fenêtre glissante d'une
//     seconde, ouvertures comprises (spéc. §7.7 l.1176 ; correction de la répétition générale de l'itération 3) ; tous les faits
//     finissent affichés ; la salle de contrôle n'écrit JAMAIS « Affichage rattrapé » (contrôle de source :
//     ni le fait `affichage`, ni le texte du rattrapage n'apparaissent dans les fichiers de L31c) ;
//  2. racine principale en mode Simple → un seul assistant dessiné (le mode de l'utilisateur est celui de la scène) ; une racine
//     de la Salle OMO est calculée en « avance » (décision n° 7, D-3d-12) ;
//  3. racine de la Salle OMO en mode Simple → aucune vue en direct : « Revoir » seulement (D-3d-14) ;
//  4. en différé, aucun texte de message n'est relu hors la consigne reçue, lue dans la copie gardée (D-3d-12, U2) ;
//  4 bis. tuiles de fichiers du panneau en direct : chaque tuile porte son CHEMIN, relu dans la partie d'outil de son `callId`
//     comme le panneau du zoom 3 de la bande 2D, suivi de ses états ; les `callId` entrent dans la clé de relecture ;
//  5. « Suivre l'action » : la cible rendue par cibleASuivre est retrouvée dans le plan (nœud, faisceau, attente), jamais inventée ;
//  6. dossier d'un projet : l'inverse de projetRelatif, repli honnête compris.
// Chaque garde échoue sans le code qu'elle garde (contrôles discriminants écrits à côté).
// Les marques « salle3d:plan » émises dans les deux rendus sont vérifiées en e2e par L35 (navigateur) : ici, seule la fonction
// pure qui les pose est contrôlée.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import type { ActivityFact } from "./shared/activity-types.ts";
import { NEON_RENDU_MS } from "./shared/neon-band.ts";
import { planConversation } from "./shared/neon-plan3d.ts";
import { scene } from "./shared/neon-scene.ts";
import { cibleASuivre } from "./shared/revoir.ts";
import { projetRelatif } from "./territoires-service.ts";
import {
  cheminsDesTuiles,
  cibleSuivre,
  creerCadence,
  type DependancesCadence,
  directServi,
  dossierDuProjet,
  etatsTuile,
  libelleTuile,
  MARQUE_PLAN,
  optionsScene,
  PANNEAU_CHEMIN_MAX,
  textesPanneau,
  zoomDe,
} from "../web/pages/salle-controle/useFaitsConversation.ts";

const APP_DIR = path.join(import.meta.dirname, "..");
const RACINE = "ses_root3d";
const ENFANT = "ses_enfant3d";

// --- Horloge et minuteur factices ------------------------------------------------------------------------------------------------

interface Horloge extends DependancesCadence {
  /** Avance jusqu'à `cible`, en jouant les minuteurs échus dans l'ordre. */
  avancerA(cible: number): void;
  maintenantMs: number;
}

function horlogeFactice(): Horloge {
  let maintenant = 0;
  let suivant = 1;
  const poses = new Map<number, { at: number; rappel: () => void }>();
  return {
    get maintenantMs() {
      return maintenant;
    },
    maintenant: () => maintenant,
    minuteur: (rappel, ms) => {
      const identifiant = suivant++;
      poses.set(identifiant, { at: maintenant + Math.max(0, ms), rappel });
      return identifiant;
    },
    annuler: (identifiant) => {
      poses.delete(identifiant);
    },
    avancerA(cible) {
      for (;;) {
        let prochain: { identifiant: number; at: number; rappel: () => void } | null = null;
        for (const [identifiant, pose] of poses) {
          if (pose.at <= cible && (prochain === null || pose.at < prochain.at)) prochain = { identifiant, ...pose };
        }
        if (prochain === null) break;
        poses.delete(prochain.identifiant);
        maintenant = Math.max(maintenant, prochain.at);
        prochain.rappel();
      }
      maintenant = Math.max(maintenant, cible);
    },
  };
}

// --- Débit de la cadence (spéc. §7.7 l.1176) --------------------------------------------------------------------------------------

/** Plus grand nombre de publications dans une fenêtre GLISSANTE d'une seconde : le même calcul que `debitParSeconde` du banc. */
function maxParSeconde(instants: readonly number[]): number {
  const tries = [...instants].sort((a, b) => a - b);
  let max = 0;
  for (let i = 0; i < tries.length; i++) {
    let j = i;
    while (j < tries.length && (tries[j] ?? 0) - (tries[i] ?? 0) < 1_000) j++;
    max = Math.max(max, j - i);
  }
  return max;
}

/** Faits que la réponse de `/facts` apporte d'un coup, à l'ouverture d'une conversation déjà remplie. */
const FAITS_LUS_DUN_COUP = 7;

/**
 * Rejoue l'affichage du crochet : `ouvrir(0)` au montage, un fait reçu toutes les 10 ms, et — quand `retard` n'est pas nul — la
 * réponse de `/facts` (`ouvrir`) à cet instant, au milieu de la rafale. Rend les publications et le nombre de faits que
 * l'ouverture doit montrer.
 */
function ouvertureEtRafale(retard: number | null, duree: number): { publications: Array<{ at: number; affiches: number }>; ouvertureFaits: number } {
  const horloge = horlogeFactice();
  const publications: Array<{ at: number; affiches: number }> = [];
  const cadence = creerCadence((affiches) => publications.push({ at: horloge.maintenantMs, affiches }), horloge);
  cadence.ouvrir(0);
  let total = 0;
  let ouvertureFaits = -1;
  for (let t = 0; t <= duree; t += 10) {
    horloge.avancerA(t);
    if (retard !== null && ouvertureFaits < 0 && t >= retard) {
      total += FAITS_LUS_DUN_COUP;
      ouvertureFaits = total;
      cadence.ouvrir(total);
    }
    total += 1;
    cadence.recevoir(total);
  }
  // Écoulement : la file finit de montrer ce qui attend, toujours au même créneau.
  horloge.avancerA(duree + 5_000);
  cadence.arreter();
  return { publications, ouvertureFaits };
}

// --- Faits d'essai ----------------------------------------------------------------------------------------------------------------

const fait = (kind: string, sessionId: string, at: number, data: Record<string, unknown> = {}, ref: string | null = null): ActivityFact =>
  ({ rootId: RACINE, sessionId, kind, ref, data, at }) as unknown as ActivityFact;

/** Conversation avec une délégation réelle : la demande, l'enfant créé, la consigne envoyée et l'enfant qui travaille. */
function faitsAvecDelegation(): ActivityFact[] {
  return [
    fait("origine", RACINE, 1_000, { origine: "demande", cas: 1, messageId: "msg_1" }, "msg_1"),
    fait("statut", RACINE, 1_010, { etat: "occupee" }),
    fait("statut", ENFANT, 1_020, { etat: "creee", role: "delegation", parent: RACINE, agent: "explore", instance: "principale" }),
    fait("consigne", RACINE, 1_030, { etat: "envoyee", callId: "call_1", messageId: "msg_x", enfant: ENFANT, agent: "explore", source: "ia", commande: null, reprise: false }, "call_1"),
    fait("statut", ENFANT, 1_040, { etat: "occupee" }),
  ];
}

describe("L31c : cadence d'affichage des faits (au plus 4 recalculs par seconde)", () => {
  it("une rafale de 50 faits en 1 s donne au plus 4 recalculs, espacés d'au moins 250 ms", () => {
    const horloge = horlogeFactice();
    const recalculs: Array<{ at: number; affiches: number }> = [];
    const cadence = creerCadence((affiches) => recalculs.push({ at: horloge.maintenantMs, affiches }), horloge);

    // Ouverture : la liste déjà lue est montrée d'un coup, sans attente (ce n'est pas un recalcul de la rafale).
    cadence.ouvrir(1);
    const ouverture = recalculs.length;

    // Rafale : 50 faits en 1 s, un toutes les 20 ms.
    for (let i = 0; i < 50; i++) {
      horloge.avancerA(i * 20);
      cadence.recevoir(2 + i);
    }
    // Fin de la fenêtre d'une seconde (exclue) : c'est elle qui porte « au plus 4 recalculs par seconde ».
    horloge.avancerA(999);

    const pendant = recalculs.slice(ouverture);
    assert.ok(pendant.length <= 4, `recalculs pendant la rafale : ${pendant.map((r) => r.at).join(", ")}`);
    assert.ok(pendant.length >= 1, "la rafale doit tout de même être affichée");
    for (let i = 1; i < pendant.length; i++) {
      const ecart = (pendant[i]?.at ?? 0) - (pendant[i - 1]?.at ?? 0);
      assert.ok(ecart >= NEON_RENDU_MS, `deux recalculs séparés de ${ecart} ms`);
    }
    // Témoin : sans la file, chaque fait serait un recalcul (50), ce que la garde refuse.
    assert.ok(pendant.length < 50);

    // Rien n'est perdu : la file finit par tout montrer.
    horloge.avancerA(5_000);
    assert.equal(cadence.affiches(), 51);
    cadence.arreter();
  });

  it("une liste raccourcie (relecture) est adoptée telle quelle, publiée au créneau suivant", () => {
    const horloge = horlogeFactice();
    const recalculs: number[] = [];
    const cadence = creerCadence((affiches) => recalculs.push(affiches), horloge);
    cadence.ouvrir(30);
    horloge.avancerA(100);
    cadence.recevoir(4);
    // La liste remplacée est adoptée TOUT DE SUITE : elle ne passe jamais par la file des 2 s.
    assert.equal(cadence.affiches(), 4);
    // Sa publication, elle, compte dans le plafond de 4 par seconde (spéc. l.1176) : elle attend le créneau, au plus 250 ms
    // après le recalcul précédent. Sans cette règle, une ouverture ou une relecture faisait un recalcul de plus dans la même
    // seconde que la rafale (constat de la répétition générale de l'itération 3).
    horloge.avancerA(100 + NEON_RENDU_MS);
    assert.equal(recalculs.at(-1), 4);
    assert.deepEqual(recalculs, [30, 4], "une liste remplacée ne doit donner qu'un seul recalcul de plus");
    cadence.arreter();
  });

  it("aucune séquence d'ouvertures et de faits reçus ne publie plus de 4 fois dans une fenêtre d'une seconde", () => {
    // Le plafond de la spécification (§7.7 l.1176) porte sur la VUE : il compte les publications d'une OUVERTURE comme celles
    // de la file. Le crochet ouvre DEUX fois (`ouvrir(0)` au montage, puis `ouvrir(n)` quand `/facts` répond) ; la répétition
    // générale de l'itération 3 a relevé 5 recalculs dans la première seconde glissante du repli 2D, la seconde ouverture
    // tombant au milieu d'une rafale. Ici, la même ouverture en deux temps est jouée à TOUS les décalages d'une seconde.
    const RAFALE_MS = 2_000;
    const PLAFOND = 4;

    // Témoin : la rafale SEULE sature déjà le plafond (exactement 4 par seconde glissante). Il n'y a donc aucune marge — une
    // publication d'ouverture de plus, hors créneau, le dépasserait, et ce contrôle le verrait.
    const seule = ouvertureEtRafale(null, RAFALE_MS);
    assert.equal(maxParSeconde(seule.publications.map((p) => p.at)), PLAFOND, "la rafale seule doit saturer le plafond : sinon ce contrôle ne discrimine rien");

    for (let retard = 0; retard <= 1_000; retard += 10) {
      const { publications, ouvertureFaits } = ouvertureEtRafale(retard, RAFALE_MS);
      const instants = publications.map((p) => p.at);
      const debit = maxParSeconde(instants);
      assert.ok(debit <= PLAFOND, `ouverture à ${retard} ms : ${debit} recalculs dans une même seconde (${instants.join(", ")})`);
      // L'ouverture reste montrée tout de suite : au plus un créneau (250 ms) après son appel, et avec SON nombre de faits.
      const ouverture = publications.find((p) => p.at >= retard && p.affiches === ouvertureFaits);
      assert.ok(ouverture, `ouverture à ${retard} ms : les ${ouvertureFaits} faits lus d'un coup n'ont jamais été montrés`);
      assert.ok(ouverture.at - retard <= NEON_RENDU_MS, `ouverture à ${retard} ms : montrée ${ouverture.at - retard} ms plus tard`);
    }
  });

  it("le minuteur est annulé à l'arrêt : plus aucun recalcul ensuite", () => {
    const horloge = horlogeFactice();
    let recalculs = 0;
    const cadence = creerCadence(() => recalculs++, horloge);
    cadence.ouvrir(0);
    cadence.recevoir(1);
    cadence.recevoir(2);
    const avant = recalculs;
    cadence.arreter();
    horloge.avancerA(10_000);
    assert.equal(recalculs, avant);
  });

  it("la salle de contrôle n'écrit jamais « Affichage rattrapé » (contrôle de source)", () => {
    for (const relatif of ["web/pages/salle-controle/useFaitsConversation.ts", "web/pages/salle-controle/ZoomConversation.tsx"]) {
      const source = fs.readFileSync(path.join(APP_DIR, relatif), "utf8");
      const code = source.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/^\s*\/\/.*$/gm, " ");
      assert.ok(!/\bactivityApi\s*\.\s*affichage\b/.test(code), `${relatif} enregistre un fait « affichage »`);
      assert.ok(!/\brattrape\b/.test(code), `${relatif} écrit « Affichage rattrapé »`);
      assert.ok(!/\bpartout\s*\.\s*rattrape\b/.test(code), `${relatif} affiche le texte du rattrapage`);
    }
  });
});

describe("L31c : mode de la scène et accès au direct", () => {
  it("racine principale en mode Simple : un seul assistant dessiné", () => {
    const faits = faitsAvecDelegation();
    const vue = scene(faits, null, optionsScene({ salle: false, mode: "simple" }, null));
    assert.equal(vue.mode, "simple");
    assert.equal(vue.noeuds.length, 1, "le mode Simple ne dessine que l'assistant de la conversation");
    assert.ok(vue.delegationsMasquees >= 1, "la délégation est comptée, pas dessinée");
    // Témoin : calculée en « avance » (ce que fait une racine de la salle), la même conversation en dessine deux.
    const avance = scene(faits, null, optionsScene({ salle: true, mode: "simple" }, null));
    assert.equal(avance.mode, "avance");
    assert.equal(avance.noeuds.length, 2);
  });

  it("le zoom suit la session détaillée, et le focus est passé à la scène", () => {
    assert.equal(zoomDe(null), 2);
    assert.equal(zoomDe(ENFANT), 3);
    assert.deepEqual(optionsScene({ salle: false, mode: "avance" }, ENFANT), { zoom: 3, mode: "avance", focus: ENFANT });
    const vue = scene(faitsAvecDelegation(), null, optionsScene({ salle: false, mode: "avance" }, ENFANT));
    assert.equal(vue.detail?.sessionId, ENFANT);
  });

  it("racine de la Salle OMO en mode Simple : aucun direct, « Revoir » seulement", () => {
    assert.equal(directServi({ salle: true, mode: "simple" }), false);
    assert.equal(directServi({ salle: true, mode: "avance" }), true);
    assert.equal(directServi({ salle: false, mode: "simple" }), true);
    assert.equal(directServi({ salle: false, mode: "avance" }), true);
  });

  it("le composant ne monte que « Revoir » pour une racine de la salle en Simple (contrôle de source)", () => {
    const source = fs.readFileSync(path.join(APP_DIR, "web/pages/salle-controle/ZoomConversation.tsx"), "utf8");
    assert.match(source, /directServi\(\{\s*salle:\s*props\.salle,\s*mode:\s*props\.mode\s*\}\)/, "le composant demande l'accès au direct");
    assert.match(source, /<SalleSimple rootId=\{props\.rootId\}/, "la racine de la salle en Simple va sur la vue « Revoir »");
    assert.match(source, /<RevoirEntree rootId=\{rootId\} placement="zoom1" \/>/, "la vue Simple n'offre que l'entrée de « Revoir »");
    // La vue Simple ne monte ni la scène 3D, ni la carte de la bande, ni le lecteur : elle n'a pas de direct.
    const simple = source.slice(source.indexOf("function SalleSimple"), source.indexOf("function Zoom("));
    for (const interdit of ["<Scene3d", "<NeonCarte", "<NeonTableau", "<ReplayBar", "useFaitsConversation("]) {
      assert.ok(!simple.includes(interdit), `la vue Simple de la salle monte ${interdit}`);
    }
  });
});

describe("L31c : textes du panneau du zoom 3 (direct et différé)", () => {
  const panneau = {
    consigne: { messageId: "msg_consigne", faits: [0] },
    actions: { termines: 2, faits: [1] },
    resultat: { callId: "call_1", etat: "rendu" as const, faits: [2] },
    reponse: { messageId: "msg_reponse", faits: [3] },
  };

  it("en direct, la consigne et la réponse sont relues dans la conversation", () => {
    const textes = textesPanneau(true, panneau);
    assert.deepEqual(textes.aRelire, ["msg_consigne", "msg_reponse"]);
    assert.equal(textes.nonAffiche, false);
    assert.equal(textes.consigneGardee, false);
  });

  it("en différé, aucun texte de message n'est relu ; seule la consigne gardée est offerte", () => {
    const textes = textesPanneau(false, panneau);
    assert.deepEqual(textes.aRelire, [], "aucune relecture en différé : rien n'est redemandé à opencode");
    assert.equal(textes.nonAffiche, true, "tout texte de message devient « Texte non affiché pendant « Revoir » »");
    assert.equal(textes.consigneGardee, true, "seule exception : la consigne, lue dans la copie gardée (U2)");
  });

  it("un panneau sans message ne demande aucune relecture, même en direct", () => {
    const textes = textesPanneau(true, { consigne: null, actions: { termines: 0, faits: [] }, resultat: null, reponse: null });
    assert.deepEqual(textes.aRelire, []);
  });

  it("le panneau du différé est celui de « Revoir », et la relecture est gardée par textesPanneau (contrôle de source)", () => {
    const source = fs.readFileSync(path.join(APP_DIR, "web/pages/salle-controle/ZoomConversation.tsx"), "utf8");
    assert.match(source, /if \(detail !== null && direct\) panneauDuZoom3 = <PanneauDirect/, "le panneau relu n'est monté qu'en direct");
    assert.match(source, /else if \(detail !== null\) \{\s*panneauDuZoom3 = <PanneauRevoir /, "le différé monte le panneau de « Revoir »");
    assert.match(source, /const relire = textes\.aRelire\.length > 0;/, "aucune requête quand rien n'est à relire");
    assert.match(source, /if \(!relire\)/, "la relecture est coupée quand aucun message n'est à relire");
  });
});

describe("L31c : tuiles de fichiers du panneau du zoom 3 en direct (§5.7.4, comme la bande 2D)", () => {
  /** Un appel d'outil sur un fichier : la scène n'en garde que les CLÉS (pathKey), jamais le chemin (activity-facts.ts). */
  const outil = (at: number, callId: string, categorie: string, phase: string, fichier: string): ActivityFact =>
    fait("statut", RACINE, at, { etat: "outil", outil: categorie, nom: categorie, phase, callId, messageId: "msg_2", fichier, dossier: "cle_src" }, callId);

  /** Deux fichiers lus, un modifié, un cherché sans aucun état posé — et aucune consigne ni réponse à relire. */
  const faitsAvecTuiles = (): ActivityFact[] => [
    fait("statut", RACINE, 1_010, { etat: "occupee" }),
    outil(1_100, "call_a", "lire", "termine", "cle_a"),
    outil(1_110, "call_b", "lire", "termine", "cle_b"),
    outil(1_120, "call_c", "modifier", "termine", "cle_c"),
    outil(1_130, "call_d", "chercher", "termine", "cle_d"),
  ];

  /** Messages de la conversation : le chemin de chaque tuile vit LÀ, dans `state.input.filePath` de sa partie d'outil. */
  const messages: readonly unknown[] = [
    {
      info: { id: "msg_2" },
      parts: [
        { type: "tool", callID: "call_a", state: { input: { filePath: "/srv/depot/src/a.ts" } } },
        { type: "tool", callID: "call_b", state: { input: { filePath: "/srv/depot/src/b.ts" } } },
        { type: "tool", callID: "call_c", state: { input: { filePath: "/srv/depot/src/c.ts" } } },
        { type: "tool", callID: "call_d", state: { input: { filePath: "/srv/depot/src/d.ts" } } },
      ],
    },
  ];

  function panneauDuZoom3() {
    const vue = scene(faitsAvecTuiles(), null, optionsScene({ salle: false, mode: "avance" }, RACINE));
    const detail = vue.detail;
    assert.ok(detail !== null, "le zoom 3 a bien un panneau");
    const tuiles = detail.dossiers.flatMap((un) => un.tuiles);
    assert.equal(tuiles.length, 4, "les quatre fichiers sont des tuiles (sinon la garde ne prouverait rien)");
    return { detail, tuiles };
  }

  const tuileDe = (tuiles: ReturnType<typeof panneauDuZoom3>["tuiles"], callId: string) => {
    const trouvee = tuiles.find((tuile) => tuile.callId === callId);
    assert.ok(trouvee !== undefined, `tuile ${callId} absente`);
    return trouvee;
  };

  it("deux tuiles de fichiers différents donnent deux libellés différents (le chemin, pas seulement l'état)", () => {
    const { detail, tuiles } = panneauDuZoom3();
    const chemins = cheminsDesTuiles(messages, detail.dossiers);
    const libelles = tuiles.map((tuile) => libelleTuile(tuile, chemins.get(tuile.callId)));
    assert.equal(new Set(libelles).size, libelles.length, `libellés indiscernables : ${libelles.join(" | ")}`);
    assert.ok(libelles.includes("/srv/depot/src/a.ts (lu)"), libelles.join(" | "));
    assert.ok(libelles.includes("/srv/depot/src/b.ts (lu)"), libelles.join(" | "));
    assert.ok(libelles.includes("/srv/depot/src/c.ts (modifié)"), libelles.join(" | "));
    // Témoin : les seuls états, rendus sans le chemin, ne distinguent PAS les deux fichiers lus.
    assert.equal(etatsTuile(tuileDe(tuiles, "call_a")), etatsTuile(tuileDe(tuiles, "call_b")));
  });

  it("une tuile sans état posé porte tout de même son chemin", () => {
    const { detail, tuiles } = panneauDuZoom3();
    const sansEtat = tuileDe(tuiles, "call_d");
    assert.equal(etatsTuile(sansEtat), "", "aucun état n'est posé sur cette tuile (sinon la garde ne prouverait rien)");
    const chemins = cheminsDesTuiles(messages, detail.dossiers);
    assert.equal(libelleTuile(sansEtat, chemins.get(sansEtat.callId)), "/srv/depot/src/d.ts", "le chemin est rendu, jamais un tiret seul");
  });

  it("un chemin pas encore relu devient « … » (jamais inventé, P12) ; un chemin trop long est coupé", () => {
    const { tuiles } = panneauDuZoom3();
    const lue = tuileDe(tuiles, "call_a");
    assert.equal(libelleTuile(lue, undefined), "… (lu)");
    const libelle = libelleTuile(lue, `/srv/depot/${"x".repeat(400)}.ts`);
    assert.ok(libelle.startsWith("/srv/depot/"), libelle);
    assert.ok(libelle.endsWith("… (lu)"), libelle);
    assert.ok(libelle.length <= PANNEAU_CHEMIN_MAX + " (lu)".length, `libellé de ${libelle.length} caractères`);
  });

  it("aucun chemin sans messages relus : la table est vide, et un callId inconnu reste sans chemin", () => {
    const { detail } = panneauDuZoom3();
    assert.equal(cheminsDesTuiles(null, detail.dossiers).size, 0, "en différé, rien n'est relu : aucune tuile n'a de chemin");
    assert.equal(cheminsDesTuiles([{ info: { id: "msg_2" }, parts: [] }], detail.dossiers).size, 0, "une partie d'outil absente ne donne aucun chemin");
  });

  it("les tuiles entrent dans la clé de relecture en direct, et une session sans consigne ni réponse se relit tout de même", () => {
    const { detail } = panneauDuZoom3();
    assert.equal(detail.panneau.consigne, null, "ce panneau n'a ni consigne…");
    assert.equal(detail.panneau.reponse, null, "…ni réponse (sinon la garde ne prouverait rien)");
    const textes = textesPanneau(true, detail.panneau, detail.dossiers);
    for (const callId of ["call_a", "call_b", "call_c", "call_d"]) assert.ok(textes.aRelire.includes(callId), `${callId} manque à la clé de relecture`);
    assert.ok(textes.aRelire.length > 0, "sans relecture, les tuiles resteraient « … » indéfiniment");
    // En différé, RIEN n'est relu : ni message, ni tuile (D-3d-12, U2).
    assert.deepEqual(textesPanneau(false, detail.panneau, detail.dossiers).aRelire, []);
  });

  it("le panneau en direct rend le chemin de chaque tuile et se relit quand elles changent (contrôle de source)", () => {
    const source = fs.readFileSync(path.join(APP_DIR, "web/pages/salle-controle/ZoomConversation.tsx"), "utf8");
    assert.match(source, /textesPanneau\(true, detail\.panneau, detail\.dossiers\)/, "les tuiles entrent dans la clé de relecture du panneau");
    assert.match(source, /cheminsDesTuiles\(lecture\?\.messages \?\? null, detail\.dossiers\)/, "les chemins sont relus dans les messages du panneau");
    assert.match(source, /\{libelleTuile\(tuile, chemins\.get\(tuile\.callId\)\)\}/, "chaque tuile rend son chemin, pas seulement ses états");
  });
});

describe("L31c : « Suivre l'action » et dossier du projet", () => {
  it("la cible suivie est retrouvée dans le plan (nœud, faisceau, attente), jamais inventée", () => {
    const faits = faitsAvecDelegation();
    const avant = scene(faits.slice(0, 2), null, optionsScene({ salle: false, mode: "avance" }, null));
    const apres = scene(faits, null, optionsScene({ salle: false, mode: "avance" }, null));
    const id = cibleASuivre(avant, apres);
    assert.ok(id !== null, "un signe a changé entre les deux moments");
    const plan = planConversation(apres, { theme: "sombre", mode: "avance" });
    const point = cibleSuivre(plan, id);
    assert.ok(point !== null, "la cible suivie a une position dans le plan");
    const connues = [...plan.noeuds.map((n) => n.position), ...plan.faisceaux.flatMap((f) => [f.de, ...(f.vers === null ? [] : [f.vers])]), ...plan.marques.map((m) => m.position)];
    assert.ok(
      connues.some((p) => p.x === point.x && p.y === point.y && p.z === point.z),
      "la position vient du plan",
    );
    assert.equal(cibleSuivre(plan, null), null);
    assert.equal(cibleSuivre(plan, "identifiant-inconnu"), null, "rien n'est inventé pour un identifiant inconnu");
  });

  it("une attente est suivie par sa marque", () => {
    const faits = [...faitsAvecDelegation(), fait("attente", ENFANT, 1_050, { etat: "attente", outil: "bash" }, "perm_1")];
    const vue = scene(faits, null, optionsScene({ salle: false, mode: "avance" }, null));
    const plan = planConversation(vue, { theme: "sombre", mode: "avance" });
    const attente = vue.attentes[0];
    assert.ok(attente !== undefined, "la scène porte bien une attente (sinon la garde ne prouverait rien)");
    assert.ok(cibleSuivre(plan, attente.permissionId) !== null, "l'attente est retrouvée par « attente:<permissionId> »");
  });

  it("le dossier d'un projet est l'inverse de projetRelatif", () => {
    for (const [racine, dossier] of [
      ["/workspace", "/workspace"],
      ["/workspace", "/workspace/projet"],
      ["/workspace", "/workspace/a/b"],
      ["C:\\web", "C:\\web"],
      ["C:\\web", "C:\\web\\cockpit"],
    ] as const) {
      const projet = projetRelatif(racine, dossier);
      assert.equal(dossierDuProjet(racine, projet), dossier, `${racine} → ${dossier}`);
    }
    // Repli honnête de projetRelatif (dossier hors de la racine, forme différente) : le chemin entier est rendu tel quel.
    assert.equal(dossierDuProjet("/workspace", "/autre/dossier"), "/autre/dossier");
    assert.equal(dossierDuProjet("C:\\web", "D:\\ailleurs"), "D:\\ailleurs");
  });

  it("la marque du plan porte le nom attendu par l'e2e (D-3d-18)", () => {
    assert.equal(MARQUE_PLAN, "salle3d:plan");
    const source = fs.readFileSync(path.join(APP_DIR, "web/pages/salle-controle/useFaitsConversation.ts"), "utf8");
    assert.match(source, /performance\.mark\(MARQUE_PLAN, \{ detail: \{ zoom, rendu \} \}\)/, "la marque porte le zoom et le rendu");
    const composant = fs.readFileSync(path.join(APP_DIR, "web/pages/salle-controle/ZoomConversation.tsx"), "utf8");
    assert.match(composant, /useMarquePlan\(vue, zoom, vue3d \? "3d" : "2d"\)/, "la marque est posée en 3D ET en repli 2D");
  });
});
