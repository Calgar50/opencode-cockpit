// Tests de croisement du train it3 V3 (plan d'exécution it3 §2.4, §5.2 ; propriété de l'intégrateur) : L35 (banc e2e de
// l'itération 3) croisé avec tout ce que les vagues 1 et 2 ont fusionné. Chaque paquet a ses propres tests ; ici, seulement ce
// qui ne se voit QU'UNE FOIS le banc posé sur le code complet.
//   1. L35 × L31c (M20, spéc. l.1176, l.1288) : le débit mesuré par `it3-debit` est celui de la CADENCE, pas celui des
//      événements. Le crochet des faits est rejoué sans React — 200 événements par seconde pendant 4 s — et le nombre de
//      publications (donc de scènes, de plans et de marques `salle3d:plan`) reste au plus de 4 par fenêtre d'une seconde, avec
//      au moins une publication par seconde. Témoin : une publication par fait en donnerait 200, ce que la garde refuse.
//      C'est l'écart n° 1 du paquet L35 (débit mesuré de 8 à 11 marques par seconde), corrigé ici par l'intégrateur.
//   2. L35 × L34 × L28c (banc it1) : le lecteur des démonstrations est maintenant le lecteur COMPLET de « Revoir ». Les
//      scénarios du banc — celui de l'itération 1 comme celui de l'itération 3 — parlent les textes d'AUJOURD'HUI
//      (revoir-texts) : compteur « n / N », [Moment suivant], avis unique du mode Simple, et plus de [Recommencer]. C'est la
//      régression remise par L35 (écart n° 7), corrigée ici.
//   3. L35 seul, contrôles NON VIDES : les cinq scénarios `it3-*` existent, sont cités dans `e2e/README.md`, exigent une preuve
//      de 3D (morceau de three exécuté, marques `salle3d:scene`) et ne tolèrent aucun dépassement du plafond de 4.
//   4. Isolation du banc (P-R105 vraie) : aucune injection ne passe par un réglage du cockpit, `e2e/lib/cdp.mjs` n'est pas
//      touché par la 3D, aucun scénario n'ouvre de session par `POST /api/login`, et la route de pilotage `POST /banc/emettre`
//      reste bornée et derrière le jeton du banc.
//   5. Constantes à garder (règles de train) : three@0.186.0 exact en devDependencies, `chunkSizeWarningLimit` jamais relevé,
//      `SALLE_OUVERTE` jamais posée à vrai.
//   6. Ce que le banc COMPLET a mis au jour, corrigé par l'intégrateur : `it3-debit` rejouait la même suite dense pour sa mesure
//      2D (le cockpit écarte les doublons : la mesure était vide) ; `it1-ui-demonstration` remettait le curseur des moments par
//      une valeur posée (React ne voit pas ce changement) ; et « Revoir » comptait comme sienne la relecture de la liste que la
//      page du chat lance après un classement, alors que la boîte ne connaît que `GET /api/revoir/…`.
//   7. Corrections de la relecture de la vague 3 : les DEUX scénarios des démonstrations mènent le curseur au clavier (celui
//      de l'itération 3 le posait encore par une valeur, que React ne voit pas) ; un chemin toléré par un scénario est une
//      route que le cockpit monte vraiment (`GET /api/conversations` nu n'existe pas : la liste est `GET /api/archive`) ;
//      `e2e/README.md` ne promet « zéro requête au faux » que pour un scénario qui l'exige encore ; et l'anneau de focus des
//      commandes de la tête reste entier là où la tête défile latéralement.
// Aucun conteneur Docker, aucun vrai opencode, aucun appel facturé : tout se joue en Node. Le banc lui-même
// (`scripts/run-e2e.sh --faux --project-prefix 3d11-e2e --image-tag 3d11`) est joué par l'intégrateur, hors de `npm test`
// (décision D-06) ; ses chiffres sont recopiés dans `EXEC/mesures/L35.md`.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import {
  creerCadence,
  type DependancesCadence,
  prefixeMontre,
} from "../web/pages/salle-controle/useFaitsConversation.ts";
import { FactDeduper } from "./shared/activity-facts.ts";
import type { ActivityFact } from "./shared/activity-types.ts";
import { NEON_RENDU_MS } from "./shared/neon-band.ts";
import { remplir } from "./shared/neon-texts.ts";
import { TEXTES as REVOIR } from "./shared/revoir-texts.ts";

const APP_DIR = path.join(import.meta.dirname, "..");
const DEPOT = path.join(APP_DIR, "..");
const E2E_DIR = path.join(DEPOT, "e2e");
const SCENARIOS_DIR = path.join(E2E_DIR, "scenarios");
const HOOK = path.join(APP_DIR, "web", "pages", "salle-controle", "useFaitsConversation.ts");

/** §5.7.4, D-3d-17, M20 : au plus 4 recalculs par seconde, le plafond que compte `it3-debit`. */
const PLAFOND = 4;
/** Cinq scénarios de l'itération 3 livrés par L35 (`it3-captures` vient de L33, en vague 4). */
const SCENARIOS_IT3 = ["it3-salle-controle.mjs", "it3-repli.mjs", "it3-revoir.mjs", "it3-demos.mjs", "it3-debit.mjs"] as const;
/** Les deux scénarios qui jouent une démonstration enregistrée sur le lecteur complet (itération 1 et itération 3). */
const DEMONSTRATIONS = ["it1-ui-demonstration.mjs", "it3-demos.mjs"] as const;

const lire = (fichier: string): string => fs.readFileSync(fichier, "utf8");
/** Source sans commentaires : une phrase citée dans un commentaire ne prouve ni ne réfute rien. */
const sansCommentaires = (source: string): string => source.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/^\s*\/\/.*$/gm, " ");

// --- Horloge et minuteur factices (mêmes dépendances que zoom-conversation.test.ts) ----------------------------------------------

interface Horloge extends DependancesCadence {
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

const fait = (n: number, at: number): ActivityFact =>
  ({ rootId: "ses_root3d", sessionId: `ses_s${n % 50}`, kind: "statut", ref: null, data: { etat: "occupee" }, at }) as unknown as ActivityFact;

/**
 * Le crochet `useFaitsConversation`, rejoué sans React : la liste brute vit dans une référence, et SEULE la cadence publie le
 * préfixe montré. Chaque publication est un tableau neuf, donc une scène, un plan et une marque `salle3d:plan` de plus.
 */
function crochetSimule(horloge: Horloge, publierParFait = false) {
  let liste: readonly ActivityFact[] = [];
  const publications: Array<{ at: number; faits: readonly ActivityFact[] }> = [];
  const publier = (montres: number) => publications.push({ at: horloge.maintenantMs, faits: prefixeMontre(liste, montres) });
  const cadence = creerCadence(publier, horloge);
  return {
    publications,
    cadence,
    ouvrir(faits: readonly ActivityFact[]) {
      liste = faits;
      cadence.ouvrir(faits.length);
    },
    recevoir(unFait: ActivityFact) {
      liste = [...liste, unFait];
      // Témoin de la forme REFUSÉE (celle d'avant la correction) : la liste publiée à chaque fait reçu.
      if (publierParFait) publier(cadence.affiches());
      cadence.recevoir(liste.length);
    },
  };
}

/** Plus grand nombre de publications dans une fenêtre GLISSANTE d'une seconde (même calcul que `debitParSeconde` du banc). */
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

/** Secondes pleines de la rafale sans aucune publication : un contrôle vide échoue aussi (M20). */
function secondesVides(instants: readonly number[], debut: number, fin: number): number {
  let vides = 0;
  for (let s = 0; s < Math.floor((fin - debut) / 1_000); s++) {
    const a = debut + s * 1_000;
    if (!instants.some((t) => t >= a && t < a + 1_000)) vides++;
  }
  return vides;
}

// --- 1. M20 : le débit de la vue est celui de la cadence, pas celui des événements ------------------------------------------------

describe("croisement 3-V3 : L35 × L31c, débit de la salle de contrôle (M20, spéc. l.1176 et l.1288)", () => {
  it("200 événements par seconde pendant 4 s : au plus 4 publications par fenêtre d'une seconde, et jamais zéro", () => {
    const horloge = horlogeFactice();
    const crochet = crochetSimule(horloge);
    crochet.ouvrir([fait(0, 0)]);
    const ouverture = crochet.publications.length;

    // Quatre rafales d'une seconde, un fait toutes les 5 ms (le débit de la fixture dense de `it3-debit`).
    const DUREE_MS = 4_000;
    for (let i = 1; i <= DUREE_MS / 5; i++) {
      horloge.avancerA(i * 5);
      crochet.recevoir(fait(i, i * 5));
    }
    horloge.avancerA(DUREE_MS + NEON_RENDU_MS);

    const instants = crochet.publications.slice(ouverture).map((p) => p.at);
    assert.ok(instants.length > 0, "aucune publication pendant les rafales : contrôle vide");
    assert.ok(maxParSeconde(instants) <= PLAFOND, `${maxParSeconde(instants)} publications dans une même seconde : ${instants.join(", ")}`);
    assert.equal(secondesVides(instants, 0, DUREE_MS), 0, "une seconde de rafale n'a rien montré");
    // Rien n'est perdu : la file finit par tout montrer.
    horloge.avancerA(DUREE_MS + 10_000);
    assert.equal(crochet.cadence.affiches(), DUREE_MS / 5 + 1);
    crochet.cadence.arreter();
  });

  it("témoin : publier la liste à chaque fait reçu donne un recalcul par événement (la forme refusée)", () => {
    const horloge = horlogeFactice();
    const crochet = crochetSimule(horloge, true);
    crochet.ouvrir([fait(0, 0)]);
    const ouverture = crochet.publications.length;
    for (let i = 1; i <= 200; i++) {
      horloge.avancerA(i * 5);
      crochet.recevoir(fait(i, i * 5));
    }
    const instants = crochet.publications.slice(ouverture).map((p) => p.at);
    assert.ok(maxParSeconde(instants) > PLAFOND * 10, `le témoin doit dépasser largement le plafond : ${maxParSeconde(instants)}`);
    crochet.cadence.arreter();
  });

  it("le préfixe montré n'est recalculé qu'avec la cadence (préfixe identique = même contenu, publié une seule fois)", () => {
    const horloge = horlogeFactice();
    const crochet = crochetSimule(horloge);
    crochet.ouvrir([]);
    for (let i = 1; i <= 40; i++) {
      horloge.avancerA(i * 10);
      crochet.recevoir(fait(i, i * 10));
    }
    horloge.avancerA(10_000);
    // Deux publications consécutives montrent toujours un nombre de faits DIFFÉRENT : aucune ne redit la même vue.
    const tailles = crochet.publications.map((p) => p.faits.length);
    for (let i = 1; i < tailles.length; i++) assert.notEqual(tailles[i], tailles[i - 1], `publication n° ${i} sans changement : ${tailles.join(", ")}`);
    // Le préfixe est bien un préfixe : jamais plus long que la liste reçue, jamais tronqué une fois rattrapé.
    assert.equal(tailles.at(-1), 40, crochet.publications.map((p) => `${p.at}:${p.faits.length}`).join(" "));
    assert.deepEqual(prefixeMontre([fait(1, 1), fait(2, 2)], 5), [fait(1, 1), fait(2, 2)].map((f) => f));
    assert.equal(prefixeMontre([fait(1, 1), fait(2, 2)], 1).length, 1);
    assert.equal(prefixeMontre([fait(1, 1), fait(2, 2)], -3).length, 0);
    crochet.cadence.arreter();
  });

  it("le crochet ne publie les faits que depuis la cadence (contrôle de source)", () => {
    const code = sansCommentaires(lire(HOOK));
    assert.match(code, /creerCadence\(\(montres\) => setFaits\(prefixeMontre\(listeRef\.current, montres\)\)\)/, "la cadence est le seul chemin de publication");
    assert.ok(!/setListe\s*\(/.test(code), "la liste brute est republiée à chaque fait (état React au lieu d'une référence)");
    // Dans le gestionnaire du flux, un fait reçu ne fait que rallonger la référence : aucun état n'y est posé.
    const debut = code.indexOf("useEvents(");
    const fin = code.indexOf("return { faits", debut);
    assert.ok(debut > 0 && fin > debut, "gestionnaire du flux introuvable");
    const bloc = code.slice(debut, fin);
    assert.ok(/cadence\.recevoir\(suivante\.length\)/.test(bloc), "le fait reçu passe par la cadence");
    assert.ok(!/\bset[A-Z]\w*\s*\(/.test(bloc), `un fait reçu publie hors de la cadence : ${bloc.trim().slice(0, 200)}`);
  });
});

// --- 2. Les scénarios du banc parlent les textes d'aujourd'hui --------------------------------------------------------------------

describe("croisement 3-V3 : L35 × L34 × L28c, le banc suit le lecteur complet des démonstrations", () => {
  it("le compteur des moments lu par le banc est celui de revoir-texts", () => {
    const rendu = remplir(REVOIR.partout.moments, { n: 1, total: 12 });
    assert.equal(rendu, "1 / 12", "le compteur du lecteur a changé de forme : les scénarios qui le lisent sont à reprendre");
    for (const nom of DEMONSTRATIONS) {
      const source = lire(path.join(SCENARIOS_DIR, nom));
      assert.ok(source.includes(".revoir-moments"), `${nom} ne lit pas le compteur du lecteur complet`);
      // L'expression que le scénario applique au compteur doit accepter ce que le lecteur écrit AUJOURD'HUI.
      const litteral = /\/\^\(?\\d\+\)?[^\n]*?\$\//.exec(source);
      assert.ok(litteral, `${nom} ne contient pas d'expression pour le compteur « n / N »`);
      assert.match(rendu, new RegExp(litteral[0].slice(1, -1)), `${nom} : l'expression ${litteral[0]} ne reconnaît plus « ${rendu} »`);
    }
  });

  it("les commandes citées existent, et [Recommencer] n'est plus attendu nulle part", () => {
    for (const nom of DEMONSTRATIONS) {
      const source = sansCommentaires(lire(path.join(SCENARIOS_DIR, nom)));
      assert.ok(!source.includes("Recommencer"), `${nom} attend encore [Recommencer], que le lecteur complet n'offre pas`);
    }
    // Le scénario de l'itération 1 parcourt les moments un à un : il clique la commande du lecteur d'aujourd'hui.
    const it1 = sansCommentaires(lire(path.join(SCENARIOS_DIR, "it1-ui-demonstration.mjs")));
    assert.ok(it1.includes(REVOIR.partout.suivant), `it1-ui-demonstration.mjs n'utilise pas « ${REVOIR.partout.suivant} »`);
    // Celui de l'itération 3 joue la lecture : [Lire] et [Figer ici], le vocabulaire de D-3d-11.
    const it3 = sansCommentaires(lire(path.join(SCENARIOS_DIR, "it3-demos.mjs")));
    assert.ok(it3.includes(REVOIR.partout.lire) && it3.includes(REVOIR.partout.figer), "it3-demos.mjs n'utilise pas [Lire] et [Figer ici]");
    const player = lire(path.join(APP_DIR, "web", "pages", "chat", "activity", "DemoPlayer.tsx"));
    assert.ok(!sansCommentaires(player).includes("TEXTES.partout.lecteur"), "le lecteur des démonstrations est revenu aux textes de l'itération 1");
  });

  it("l'avis du mode Simple attendu par les deux scénarios est la phrase unique d'U1", () => {
    for (const nom of DEMONSTRATIONS) {
      const source = lire(path.join(SCENARIOS_DIR, nom));
      assert.ok(source.includes(REVOIR.simple.demoAvance), `${nom} n'attend pas l'avis « ${REVOIR.simple.demoAvance} »`);
      assert.ok(!source.includes("Enregistrée en mode Avancé. En mode Simple"), `${nom} attend encore l'avis en deux morceaux de l'itération 1`);
    }
  });
});

// --- 3. Contrôles non vides et plafond du banc de l'itération 3 -------------------------------------------------------------------

describe("croisement 3-V3 : L35, le banc de l'itération 3 ne peut pas être vert à vide", () => {
  it("les cinq scénarios existent, exportent run, et sont cités dans e2e/README.md", () => {
    const readme = lire(path.join(E2E_DIR, "README.md"));
    for (const nom of SCENARIOS_IT3) {
      const source = lire(path.join(SCENARIOS_DIR, nom));
      assert.match(source, /export async function run\(ctx\)/, `${nom} n'expose pas run(ctx)`);
      assert.ok(readme.includes(nom), `${nom} n'est pas cité dans e2e/README.md`);
    }
  });

  it("la 3D jouée est prouvée : morceau de three chargé et marques salle3d:scene exigées", () => {
    const webgl = lire(path.join(E2E_DIR, "lib", "webgl.mjs"));
    assert.match(webgl, /export async function preuveTroisD/, "la preuve de 3D n'existe plus");
    assert.match(webgl, /export const TAILLE_MORCEAU_THREE = \d/, "la taille du morceau three n'est plus contrôlée");
    const salle = lire(path.join(SCENARIOS_DIR, "it3-salle-controle.mjs"));
    assert.ok(salle.includes("preuveTroisD"), "it3-salle-controle ne demande aucune preuve de 3D");
    const debit = lire(path.join(SCENARIOS_DIR, "it3-debit.mjs"));
    assert.ok(debit.includes("contrôle 3D vide"), "it3-debit accepte une mesure sans aucune image rendue");
  });

  it("it3-debit compte sur une fenêtre glissante, au plafond de 4, sans tolérance", () => {
    const debit = sansCommentaires(lire(path.join(SCENARIOS_DIR, "it3-debit.mjs")));
    assert.match(debit, /const PLAFOND = 4;/, "le plafond de M20 n'est plus 4");
    assert.match(debit, /debitPlan\.max <= PLAFOND/, "le plafond n'est plus contrôlé sur le maximum par seconde");
    assert.ok(!/PLAFOND \+ \d|tolerance|tolérance/i.test(debit), "une tolérance a été ajoutée au plafond de M20");
    assert.match(debit, /pendantLesRafales\.vides === 0/, "les secondes de rafale sans marque ne font plus échouer la mesure");
    assert.match(debit, /debitParSeconde\(plans\.map\(\(m\) => m\.t\), \{ debut, fin: finDesRafales \}\)/, "les secondes vides ne sont plus comptées sur les seules rafales");
    const webgl = lire(path.join(E2E_DIR, "lib", "webgl.mjs"));
    assert.match(webgl, /while \(j < tries\.length && tries\[j\] - tries\[i\] < 1_000\) j\+\+;/, "la fenêtre d'une seconde n'est plus glissante");
  });
});

// --- 4. Isolation du banc (P-R105 vraie) ------------------------------------------------------------------------------------------

describe("croisement 3-V3 : isolation du banc de l'itération 3", () => {
  it("toutes les injections passent par Page.addScriptToEvaluateOnNewDocument, jamais par un réglage du cockpit", () => {
    const webgl = sansCommentaires(lire(path.join(E2E_DIR, "lib", "webgl.mjs")));
    assert.match(webgl, /Page\.addScriptToEvaluateOnNewDocument/, "les injections ne passent plus par le document neuf");
    assert.ok(!/COCKPIT_[A-Z_]+/.test(webgl), "une injection passe par une variable d'environnement du cockpit");
    assert.ok(!/\/api\/(config|settings)/.test(webgl), "une injection passe par un réglage du cockpit");
  });

  it("e2e/lib/cdp.mjs n'est pas touché par la 3D, et aucun scénario n'ouvre de session par POST /api/login", () => {
    const cdp = lire(path.join(E2E_DIR, "lib", "cdp.mjs"));
    assert.ok(!cdp.includes("[3d]"), "e2e/lib/cdp.mjs porte une section [3d] : il devait rester intact");
    for (const nom of [...SCENARIOS_IT3, "it1-ui-demonstration.mjs"]) {
      const source = sansCommentaires(lire(path.join(SCENARIOS_DIR, nom)));
      assert.ok(!source.includes("/api/login"), `${nom} ouvre une session par POST /api/login (le banc se connecte par ticket)`);
    }
  });

  it("la route de pilotage POST /banc/emettre est bornée et derrière le jeton du banc", () => {
    const faux = lire(path.join(E2E_DIR, "fake-opencode-server.ts"));
    assert.match(faux, /\/\/ \[3d\] début[\s\S]*?POST" && chemin === "\/banc\/emettre"[\s\S]*?\/\/ \[3d\] fin/, "la route du rejeu n'est plus dans une section [3d]");
    assert.match(faux, /const MAX_CORPS = 1_048_576;/, "la borne du corps de pilotage a changé");
    assert.match(faux, /if \(taille > MAX_CORPS\) throw new Error\("corps trop long"\);/, "le corps du pilotage n'est plus borné");
    // Le jeton est vérifié AVANT toute route de pilotage : la route du rejeu vient après ce contrôle.
    const gardeJeton = faux.indexOf("jeton du banc manquant ou incorrect");
    assert.ok(gardeJeton > 0 && gardeJeton < faux.indexOf('chemin === "/banc/emettre"'), "le rejeu n'est plus derrière le jeton du banc");
  });
});

// --- 5. Constantes à garder -------------------------------------------------------------------------------------------------------

describe("croisement 3-V3 : constantes à garder (règles de train)", () => {
  it("three@0.186.0 exact reste en devDependencies, et rien d'autre n'a été ajouté", () => {
    const paquet = JSON.parse(lire(path.join(APP_DIR, "package.json"))) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    assert.equal(paquet.devDependencies?.three, "0.186.0", "three@0.186.0 exact est la seule dépendance permise (P8) : ni retirée, ni changée");
    assert.equal(paquet.dependencies?.three, undefined, "three doit rester une dépendance de développement");
  });

  it("chunkSizeWarningLimit n'est pas relevé et SALLE_OUVERTE n'est jamais posée à vrai", () => {
    const limite = Number(/chunkSizeWarningLimit:\s*(\d+)/.exec(lire(path.join(APP_DIR, "vite.config.ts")))?.[1]);
    assert.ok(limite <= 1500, `chunkSizeWarningLimit = ${limite} : jamais relevé pour masquer l'avertissement de taille`);
    const fichiers = [path.join(APP_DIR, "server"), path.join(APP_DIR, "web")].flatMap((racine) => sources(racine));
    for (const fichier of fichiers) {
      assert.ok(!/SALLE_OUVERTE\s*=\s*true/.test(lire(fichier)), `${path.relative(DEPOT, fichier)} ouvre la Salle OMO`);
    }
  });
});

// --- 6. Corrections du train : ce que le banc complet a mis au jour ----------------------------------------------------------------

describe("croisement 3-V3 : corrections du train sur le banc complet", () => {
  it("it3-debit rejoue une SECONDE suite en repli 2D : la première ne ferait naître aucun fait", () => {
    const debit = sansCommentaires(lire(path.join(SCENARIOS_DIR, "it3-debit.mjs")));
    const suites = [...debit.matchAll(/suiteDense\("([a-z])"\)/g)].map((trouve) => trouve[1]);
    assert.equal(suites.length, 2, "le scénario ne charge plus exactement deux suites denses (3D puis repli 2D)");
    assert.notEqual(suites[0], suites[1], "les deux suites portent la même marque de préfixe : leurs sessions seraient les mêmes");
    assert.match(debit, /emettre\(dense2d\.creations\)/, "les sessions de la seconde suite ne sont plus annoncées avant la mesure 2D");
    assert.match(debit, /repliAFaire = \{ rootId, rafales: dense2d\.rafales \}/, "la mesure 2D ne rejoue plus la seconde suite");
    assert.match(debit, /mesurer\(ctx, page2d, repli\.cdp, repliAFaire\.rootId, repliAFaire\.rafales/, "la mesure 2D ne rejoue pas la suite préparée pour elle");
  });

  it("it3-debit ne tient jamais deux connexions du banc en même temps, et quitte la salle avant de changer les réglages", () => {
    const debit = sansCommentaires(lire(path.join(SCENARIOS_DIR, "it3-debit.mjs")));
    const quitte = debit.indexOf("location.hash = '#/'");
    const ferme = debit.indexOf("premiere.cdp.fermer()");
    const repli = debit.indexOf('preparer3d(ctx, { mouvementReduit: true })');
    assert.ok(quitte > 0 && ferme > quitte, "la salle n'est plus quittée avant la fermeture de la première connexion (moteur vivant au déchargement)");
    assert.ok(repli > ferme, "la connexion du repli est ouverte avant la fermeture de la première : les réglages émulés se recouvrent");
  });

  it("raison de la seconde suite : un appel d'outil rejoué à l'identique est écarté, celui d'une autre session est gardé", () => {
    const deduper = new FactDeduper();
    const fait = (sessionId: string): ActivityFact => ({ rootId: "ses_r", sessionId, kind: "statut", ref: "c0-00", data: { etat: "outil", phase: "running" }, at: 1 });
    assert.equal(deduper.accept(fait("dk3f2n200")), true, "le premier appel doit être gardé");
    assert.equal(deduper.accept(fait("dk3f2n200")), false, "le MÊME appel rejoué doit être écarté : rejouer la première suite ne dessinerait rien");
    assert.equal(deduper.accept(fait("rk3f2n200")), true, "le même appel sur une AUTRE session doit être gardé : c'est ce que fait la seconde suite");
  });

  it("les deux scénarios des démonstrations mènent le curseur au clavier, jamais par une valeur posée", () => {
    // Le curseur des moments est un `<input type="range">` CONTRÔLÉ par React (ReplayBar : `value={rang}` + `onChange`). React
    // remplace l'accesseur `value` du nœud par son traqueur : une valeur posée met le traqueur à jour, l'événement est alors jeté
    // comme « valeur inchangée », et `onAller` n'est jamais appelé — le lecteur ne bouge pas. Les deux scénarios doivent donc
    // déplacer le curseur au clavier, avec un filet flèche pour le cas où le saut ([Début]/[Fin]) ne serait pas servi.
    const attendus = {
      "it1-ui-demonstration.mjs": { fonction: "allerAuPremierMoment", saut: "Home", filet: "ArrowLeft", sens: "[Début] et ←" },
      "it3-demos.mjs": { fonction: "allerAuDernierMoment", saut: "End", filet: "ArrowRight", sens: "[Fin] et →" },
    } as const satisfies Record<(typeof DEMONSTRATIONS)[number], { fonction: string; saut: string; filet: string; sens: string }>;
    for (const nom of DEMONSTRATIONS) {
      const attendu = attendus[nom];
      const source = sansCommentaires(lire(path.join(SCENARIOS_DIR, nom)));
      const bloc = new RegExp(`async function ${attendu.fonction}[\\s\\S]*?\\n}`).exec(source)?.[0] ?? "";
      assert.ok(bloc.length > 0, `${nom} : ${attendu.fonction} a disparu du scénario des démonstrations`);
      assert.ok(
        !/\.value\s*=/.test(bloc),
        `${nom} : le curseur est déplacé par une valeur posée — React ne voit pas ce changement (le lecteur ne bouge pas)`,
      );
      assert.ok(bloc.includes(`touche("${attendu.saut}")`), `${nom} : le curseur n'est plus mené par ${attendu.sens.split(" et ")[0]}`);
      assert.ok(bloc.includes(`touche("${attendu.filet}")`), `${nom} : le filet clavier (${attendu.sens.split(" et ")[1]}) a disparu`);
    }
    // Les touches frappées par le banc partent avec le code virtuel d'un vrai clavier : sans lui, le curseur natif ne les sert pas.
    const cdp = lire(path.join(E2E_DIR, "lib", "cdp.mjs"));
    const codes = /const codes = \{([^}]*)\}/.exec(cdp)?.[1] ?? "";
    for (const [touche, code] of [["End", 35], ["Home", 36], ["ArrowLeft", 37], ["ArrowRight", 39]] as const) {
      assert.match(codes, new RegExp(`${touche}:\\s*${code}\\b`), `e2e/lib/cdp.mjs n'envoie plus le code de la touche ${touche}`);
    }
  });

  it("la tête de la bande reste sur une ligne pendant une demande : la carte garde la place de ses signes", () => {
    // Mesuré sur le banc (20/09) : avec [Revoir cette demande] et [Ouvrir la salle de contrôle], la tête passait à 80 px sur
    // trois lignes ; la bande n'en a que 114 à 1280 × 800, et la carte (63 px, son plancher) était coupée — ses signes
    // tombaient sous « Qui travaille ? ». Sur une ligne, la tête fait 26 px et tout tient (it1-ui-mise-en-page, §5.7.1).
    const css = lire(path.join(APP_DIR, "web", "pages", "chat", "activity", "activity.css"));
    const bloc = /\.activity-region\.demande > \.neon-band > \.neon-head \{[^}]*flex-wrap: nowrap;[^}]*\}/.exec(css)?.[0] ?? "";
    assert.ok(bloc.length > 0, "la tête de la bande peut de nouveau passer à la ligne pendant une demande");
    assert.match(bloc, /overflow-x: auto;/, "les commandes qui débordent ne sont plus atteignables par défilement latéral");
    assert.match(css, /\.activity-region\.demande > \.neon-band > \.neon-head > \.neon-commands \{[^}]*flex-wrap: nowrap;[^}]*\}/, "les commandes passent encore à la ligne");
    assert.match(css, /\.activity-region\.demande > \.neon-band > \.neon-head \.btn \{\s*white-space: nowrap;\s*\}/, "un libellé de commande peut encore se couper en deux lignes");
    // La règle ne vaut QUE pendant une demande : hors demande, la tête garde son retour à la ligne (§5.6).
    const neon = lire(path.join(APP_DIR, "web", "pages", "chat", "activity", "neon.css"));
    assert.match(neon, /\.neon-head \{[^}]*flex-wrap: wrap;[^}]*\}/, "la tête de la bande ne revient plus à la ligne hors demande");
  });

  it("« Revoir » ne peut pas lire les archives : la relecture de la liste vient de la page du chat", () => {
    // La boîte ne connaît que `salle3dApi` (GET /api/revoir/…) ; le croisement de la vague 1 interdit déjà `lib/api.ts` sous
    // le dossier `revoir/`. Aucune route d'archive ne peut donc venir de « Revoir » : celle que le scénario compte à part est la liste
    // que la PAGE DU CHAT relit après un événement de classement (ChatPage.tsx).
    const dossier = path.join(APP_DIR, "web", "pages", "salle-controle", "revoir");
    const fichiers = fs.readdirSync(dossier).filter((nom) => /\.tsx?$/.test(nom));
    assert.ok(fichiers.length >= 6, "dossier revoir/ non parcouru");
    for (const nom of fichiers) assert.ok(!lire(path.join(dossier, nom)).includes("/api/archive"), `${nom} cite une route d'archive`);
    const chat = sansCommentaires(lire(path.join(APP_DIR, "web", "pages", "ChatPage.tsx")));
    assert.match(chat, /conversation\.classified[\s\S]{0,400}loadConversations/, "la relecture de la liste du chat n'est plus celle du classement");
    const scenario = sansCommentaires(lire(path.join(SCENARIOS_DIR, "it3-revoir.mjs")));
    assert.match(scenario, /await attendreClassement\(ctx, rootId\)/, "le scénario n'attend plus le classement avant de mesurer le réseau");
    assert.match(scenario, /chemin\(ligne\) === "\/api\/archive"/, "la relecture de la liste n'est plus comptée à part");
    assert.match(scenario, /autres\.length === 0/, "le contrôle « rien d'autre que GET /api/revoir/… » a disparu");
    // Côté opencode, ce que le faux reçoit est ATTRIBUÉ : rien sur la conversation revue, aucun appel d'IA hors classement.
    assert.match(scenario, /surLaConversation\.length === 0/, "le scénario ne contrôle plus ce qu'opencode reçoit sur la conversation revue");
    assert.match(scenario, /appelsIa\.length === 0/, "le scénario ne contrôle plus les appels d'IA pendant « Revoir »");
    assert.match(scenario, /r\.body\?\.agent !== "cockpit-classifier"/, "le classement automatique n'est plus la seule exception admise");
  });
});

// --- 7. Corrections de la relecture de la vague 3 ---------------------------------------------------------------------------------

describe("croisement 3-V3 : corrections de la relecture (3-vague-3)", () => {
  it("un chemin toléré par un scénario du banc est une route que le cockpit monte vraiment", () => {
    // `/api/conversations` nu n'a jamais existé : le cockpit monte `/api/conversations/:rootId/activity`, `…/facts` et la liste
    // des conversations sous `GET /api/archive`. Une tolérance MORTE laisse passer un faux rouge le jour où la vraie route
    // tombe dans le journal, avec un message qui ne désigne pas sa cause.
    const serveur = path.join(APP_DIR, "server");
    const fichiers = ["http.ts", ...fs.readdirSync(serveur).filter((nom) => /^routes-.*\.ts$/.test(nom) && !nom.endsWith(".test.ts"))];
    const montees = new Set<string>();
    for (const fichier of fichiers) {
      const source = lire(path.join(serveur, fichier));
      for (const trouve of source.matchAll(/app\.(get|post|put|patch|delete)\(\s*"([^"]+)"/g)) {
        montees.add(`${(trouve[1] ?? "").toUpperCase()} ${trouve[2]}`);
      }
    }
    assert.ok(montees.size > 40, `routes du cockpit non parcourues (${montees.size} trouvées)`);
    assert.ok(montees.has("GET /api/archive"), "la liste des conversations n'est plus « GET /api/archive » : les scénarios qui la comptent à part sont à reprendre");
    assert.ok(!montees.has("GET /api/conversations"), "« GET /api/conversations » nu existe maintenant : ce croisement est à revoir");
    for (const nom of [...DEMONSTRATIONS, "it3-revoir.mjs"]) {
      const source = sansCommentaires(lire(path.join(SCENARIOS_DIR, nom)));
      for (const trouve of source.matchAll(/[!=]==\s*"(\/api\/[^"]*)"/g)) {
        assert.ok(montees.has(`GET ${trouve[1]}`), `${nom} compare un chemin à « ${trouve[1]} », que le cockpit ne monte pas`);
      }
    }
  });

  it("les scénarios des démonstrations comptent à part la relecture de la liste du chat, et interdisent tout le reste", () => {
    // La page du chat repose un minuteur de 500 ms sur « conversation.classified » / « conversation.updated » et relit SA liste :
    // le classement de fond d'une conversation d'un scénario précédent de la pile tombe pendant la boîte. Ce n'est pas une
    // requête de la démonstration, qui ne lit rien ; elle est comptée à part, comme dans `it3-revoir.mjs`.
    const chat = sansCommentaires(lire(path.join(APP_DIR, "web", "pages", "ChatPage.tsx")));
    assert.match(chat, /conversation\.classified[\s\S]{0,400}loadConversations/, "la relecture de la liste du chat n'est plus celle du classement");
    assert.match(chat, /archiveList\(\{ limit: 200 \}\)/, "la page du chat ne relit plus sa liste par « GET /api/archive »");
    for (const nom of DEMONSTRATIONS) {
      const source = sansCommentaires(lire(path.join(SCENARIOS_DIR, nom)));
      assert.match(source, /listeDuChat = \(l\) => l\.methode === "GET" && chemin\(l\) === "\/api\/archive"/, `${nom} ne compte pas à part la relecture de la liste du chat`);
      assert.ok(!source.includes("/api/conversations"), `${nom} garde une tolérance morte sur « /api/conversations »`);
      assert.match(source, /interdites\.length === 0/, `${nom} n'interdit plus les autres requêtes de la page`);
      assert.match(source, /relecture\(s\) de la liste du chat/, `${nom} ne consigne plus le nombre de relectures dans son relevé`);
    }
  });

  it("e2e/README.md ne promet « zéro requête au faux » que pour un scénario qui l'exige encore", () => {
    // DOC-3D et la revue lisent ce tableau pour dire ce que le banc établit : aucune ligne de sortie déclarée tenue sans mesure.
    const readme = lire(path.join(E2E_DIR, "README.md"));
    for (const ligne of readme.split("\n")) {
      const nom = /^\|\s*`(it[0-9a-z-]+\.mjs)`\s*\|/.exec(ligne)?.[1];
      if (!nom || !ligne.includes("zéro requête au faux")) continue;
      const source = sansCommentaires(lire(path.join(SCENARIOS_DIR, nom)));
      assert.match(
        source,
        /apres\.faux === avant\.faux/,
        `e2e/README.md annonce « zéro requête au faux » pour ${nom}, qui ne l'exige plus : le tableau promet plus que la mesure`,
      );
    }
    // La ligne de `it3-revoir` dit aujourd'hui ce que le scénario contrôle vraiment depuis les ajustements de la vague 3.
    const revoir = readme.split("\n").find((l) => l.startsWith("| `it3-revoir.mjs`")) ?? "";
    assert.ok(revoir.length > 0, "la ligne de `it3-revoir.mjs` a disparu du tableau de e2e/README.md");
    assert.ok(revoir.includes("`GET /api/archive`"), "la ligne de `it3-revoir.mjs` ne dit pas que la relecture de la liste du chat est comptée à part");
    assert.ok(
      revoir.includes("rien reçu par le faux sur la conversation revue") && revoir.includes("hors le classement automatique"),
      "la ligne de `it3-revoir.mjs` ne dit pas ce que le scénario attribue vraiment au faux",
    );
  });

  it("l'anneau de focus des commandes de la tête reste entier malgré le défilement latéral", () => {
    // `overflow-x: auto` fait de la tête un conteneur de défilement sur les DEUX axes (un `overflow-x` autre que `visible` rend
    // `overflow-y: visible` équivalent à `auto`). La tête n'a aucun rembourrage : l'anneau du dépôt, posé 2 px en dehors du
    // bouton, serait rogné en haut et en bas, et le repère du parcours au clavier deviendrait illisible (§5.7.1).
    const styles = lire(path.join(APP_DIR, "web", "styles.css"));
    assert.match(styles, /:focus-visible \{[^}]*outline-offset: 2px;[^}]*\}/, "l'anneau de focus du dépôt n'est plus posé en dehors de la boîte : ce croisement est à revoir");
    const css = lire(path.join(APP_DIR, "web", "pages", "chat", "activity", "activity.css"));
    // La tête a plusieurs blocs sous ce sélecteur : c'est celui qui pose le défilement qui compte.
    const blocs = [...css.matchAll(/\.activity-region\.demande > \.neon-band > \.neon-head \{([^}]*)\}/g)].map((t) => t[1] ?? "");
    assert.ok(blocs.length > 0, "la tête de la bande pendant une demande n'a plus de règle propre");
    if (!blocs.some((bloc) => /overflow-x:\s*(auto|scroll)/.test(bloc))) return; // Sans défilement, rien à compenser.
    assert.match(
      css,
      /\.activity-region\.demande > \.neon-band > \.neon-head \.btn:focus-visible \{\s*outline-offset: -2px;\s*\}/,
      "la tête défile latéralement sans rembourrage : l'anneau de focus de ses commandes est rogné en haut et en bas",
    );
  });
});

/** Fichiers TypeScript d'un dossier, sans node_modules. */
function sources(racine: string): string[] {
  const trouves: string[] = [];
  for (const entree of fs.readdirSync(racine, { withFileTypes: true })) {
    const complet = path.join(racine, entree.name);
    if (entree.isDirectory()) {
      if (entree.name !== "node_modules") trouves.push(...sources(complet));
    } else if (/\.tsx?$/.test(entree.name)) trouves.push(complet);
  }
  return trouves;
}
