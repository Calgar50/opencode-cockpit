// Fluidité et repli 2D, module pur (plan it3, fiche L30 ; spécification §5.8 l.1003-1008, §7.7 l.1171, JP-12 ; D-3d-25,
// D-3d-27) : séries synthétiques de la sonde (fluide, saccadée, images lentes, trop courte, durées non mesurables), rendus
// logiciels, ordre du verdict (le mouvement réduit l'emporte sur tout), surveillance des seules images animées (proposition à 5 s,
// bascule à 10 s, remise à zéro après une reprise, image bornée), préférence du poste (illisible = auto), contrat et pureté.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import {
  type ActionSurveillance,
  type CapacitesPoste,
  centile,
  ecrirePreference,
  estRenduLogiciel,
  type EtatSurveillance,
  FLUIDITE,
  type FluidityReason,
  type FluidityVerdict,
  IMAGE_MAX_MS,
  lirePreference,
  MEDIANE_IMAGES,
  mediane,
  PREFERENCE_BRUT_MAX,
  PREFERENCE_CLE,
  preferenceAuto,
  RAISONS_FLUIDITE,
  RENDUS_LOGICIELS,
  SURVEILLANCE_INITIALE,
  surveiller,
  verdictCapacites,
  verdictSonde,
} from "./shared/fluidity.ts";

const SOURCE = fs.readFileSync(path.join(import.meta.dirname, "shared", "fluidity.ts"), "utf8");

/** `n` images de `ms` millisecondes. */
const serie = (n: number, ms: number): number[] => Array.from({ length: n }, () => ms);

/** Poste qui suit : accessibilité inactive, préférence auto, contexte matériel. */
const POSTE: CapacitesPoste = {
  mouvementReduit: false,
  couleursForcees: false,
  webgl2: true,
  contexteRefuse: false,
  moteur: "ANGLE (NVIDIA, NVIDIA GeForce RTX 4070 (0x00002786) Direct3D11 vs_5_0 ps_5_0, D3D11)",
  preference: "auto",
};

const poste = (changements: Partial<CapacitesPoste>): CapacitesPoste => ({ ...POSTE, ...changements });
const deuxD = (raison: FluidityReason): FluidityVerdict => ({ mode: "2d", raison });

/** Noms de moteurs de rendu logiciels tels que les donnent les navigateurs (bureau à distance, machine virtuelle, sans tête). */
const NOMS_LOGICIELS = [
  "ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero) (0x0000C0DE)), SwiftShader driver)",
  "Google SwiftShader",
  "llvmpipe (LLVM 15.0.7, 256 bits)",
  "Mesa/X.org, llvmpipe (LLVM 17.0.6, 256 bits)",
  "ANGLE (Microsoft, Microsoft Basic Render Driver (0x0000008C) Direct3D11 vs_5_0 ps_5_0, D3D11)",
];

describe("fluidity : verdict des capacités (§5.8 l.1004-1008)", () => {
  it("poste qui suit : 3D sous réserve de la sonde ; moteur inconnu (extension absente) : la sonde décide", () => {
    assert.deepEqual(verdictCapacites(POSTE), { mode: "3d" });
    assert.deepEqual(verdictCapacites(poste({ moteur: null })), { mode: "3d" });
  });

  it("chacun des trois noms logiciels → rendu-logiciel, sous-chaîne et casse ignorée", () => {
    for (const motif of RENDUS_LOGICIELS) {
      for (const nom of [motif, motif.toUpperCase(), motif.toLowerCase(), `ANGLE (${motif} Device)`]) {
        assert.equal(estRenduLogiciel(nom), true, nom);
        assert.deepEqual(verdictCapacites(poste({ moteur: nom })), deuxD("rendu-logiciel"), nom);
      }
    }
    for (const nom of NOMS_LOGICIELS) assert.deepEqual(verdictCapacites(poste({ moteur: nom })), deuxD("rendu-logiciel"), nom);
    for (const nom of [POSTE.moteur ?? "", "ANGLE (Intel, Intel(R) UHD Graphics 770 Direct3D11 vs_5_0 ps_5_0, D3D11)", "Apple M2", "Microsoft Basic"]) {
      assert.equal(estRenduLogiciel(nom), false, nom);
      assert.deepEqual(verdictCapacites(poste({ moteur: nom })), { mode: "3d" }, nom);
    }
  });

  it("aucun contexte webgl2 → webgl-absent ; contexte refusé avec failIfMajorPerformanceCaveat → rendu-logiciel", () => {
    assert.deepEqual(verdictCapacites(poste({ webgl2: false, moteur: null })), deuxD("webgl-absent"));
    assert.deepEqual(verdictCapacites(poste({ webgl2: false, contexteRefuse: true, moteur: null })), deuxD("webgl-absent"));
    assert.deepEqual(verdictCapacites(poste({ contexteRefuse: true })), deuxD("rendu-logiciel"));
    assert.deepEqual(verdictCapacites(poste({ contexteRefuse: true, moteur: null })), deuxD("rendu-logiciel"));
  });

  it("préférence 2D du poste → preference-2d, avant le contexte et le moteur", () => {
    assert.deepEqual(verdictCapacites(poste({ preference: "2d" })), deuxD("preference-2d"));
    assert.deepEqual(verdictCapacites(poste({ preference: "2d", webgl2: false })), deuxD("preference-2d"));
    assert.deepEqual(verdictCapacites(poste({ preference: "2d", contexteRefuse: true })), deuxD("preference-2d"));
    assert.deepEqual(verdictCapacites(poste({ preference: "2d", moteur: "llvmpipe" })), deuxD("preference-2d"));
  });

  it("le mouvement réduit (ou les couleurs forcées) l'emporte sur tout : toutes les combinaisons", () => {
    const moteurs = [null, POSTE.moteur, "SwiftShader"];
    let cas = 0;
    for (const [mouvementReduit, couleursForcees] of [[true, false], [false, true], [true, true]] as const) {
      for (const webgl2 of [true, false]) {
        for (const contexteRefuse of [true, false]) {
          for (const moteur of moteurs) {
            for (const preference of ["auto", "2d"] as const) {
              const capacites = { mouvementReduit, couleursForcees, webgl2, contexteRefuse, moteur, preference };
              assert.deepEqual(verdictCapacites(capacites), deuxD("accessibilite"), JSON.stringify(capacites));
              cas += 1;
            }
          }
        }
      }
    }
    assert.equal(cas, 72);
  });
});

describe("fluidity : sonde forcée de 90 images (§5.8 l.1006)", () => {
  it("centile au rang le plus proche ; liste vide ou p hors bornes → NaN ; la liste n'est jamais modifiée", () => {
    const cent = Object.freeze(Array.from({ length: 100 }, (_, i) => 100 - i));
    assert.equal(centile(cent, 95), 95);
    assert.equal(centile(cent, 50), 50);
    assert.equal(centile(cent, 100), 100);
    assert.equal(centile(cent, 1), 1);
    assert.equal(centile([7], 95), 7);
    assert.equal(centile([...serie(85, 12), ...serie(5, 26)], 95), 26, "rang 86 sur 90");
    assert.equal(centile([...serie(86, 12), ...serie(4, 26)], 95), 12);
    assert.ok(Number.isNaN(centile([], 95)));
    for (const p of [0, -5, 101, 100.5, Number.NaN]) assert.ok(Number.isNaN(centile(cent, p)), String(p));
    assert.equal(cent[0], 100, "entrée intacte");
  });

  it("fluide (90 × 12 ms) → ok", () => {
    assert.deepEqual(verdictSonde(serie(90, 12)), { ok: true, p95: 12, lentes: 0 });
  });

  it("saccadé (p95 à 26 ms) → pas ok ; p95 à 20 ms tout juste → ok", () => {
    const saccade = [...serie(85, 12), ...serie(5, 26)];
    assert.deepEqual(verdictSonde(saccade), { ok: false, p95: 26, lentes: 0 });
    assert.deepEqual(verdictSonde([...serie(85, 12), ...serie(5, 20)]), { ok: true, p95: 20, lentes: 0 });
    assert.equal(verdictSonde(serie(90, 20.5)).ok, false);
  });

  it("quatre images de 60 ms → pas ok ; trois → ok ; une image de 50 ms tout juste n'est pas lente", () => {
    assert.deepEqual(verdictSonde([...serie(86, 12), ...serie(4, 60)]), { ok: false, p95: 12, lentes: 4 });
    assert.deepEqual(verdictSonde([...serie(87, 12), ...serie(3, 60)]), { ok: true, p95: 12, lentes: 3 });
    assert.deepEqual(verdictSonde([...serie(86, 12), ...serie(4, 50)]), { ok: true, p95: 12, lentes: 0 });
  });

  it("89 images → pas ok ; aucune image → pas ok", () => {
    assert.deepEqual(verdictSonde(serie(89, 12)), { ok: false, p95: 12, lentes: 0 });
    const vide = verdictSonde([]);
    assert.equal(vide.ok, false);
    assert.ok(Number.isNaN(vide.p95));
    assert.equal(FLUIDITE.sonde.images, 90);
  });

  it("durée non mesurable (NaN, négative, infinie) comptée lente : quatre → pas ok ; p95 jamais NaN", () => {
    const douteuses = [...serie(86, 12), Number.NaN, -5, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY];
    assert.deepEqual(verdictSonde(douteuses), { ok: false, p95: 12, lentes: 4 });
    const pire = verdictSonde([...serie(85, 12), ...serie(5, Number.NaN)]);
    assert.equal(pire.ok, false);
    assert.equal(pire.p95, Number.POSITIVE_INFINITY);
  });
});

/** Rejoue des images dans la surveillance ; rend les actions et l'état final. */
function rejouer(images: ReadonlyArray<{ ms: number; anime?: boolean }>, depart: EtatSurveillance = SURVEILLANCE_INITIALE, now0 = 1_000) {
  let etat = depart;
  let now = now0;
  const actions: ActionSurveillance[] = [];
  for (const image of images) {
    now += image.ms;
    const suite = surveiller(etat, { ms: image.ms, anime: image.anime ?? true, now });
    etat = suite.etat;
    actions.push(suite.action);
  }
  return { etat, actions };
}

const animees = (n: number, ms: number) => serie(n, ms).map((valeur) => ({ ms: valeur }));
/** Indices (à partir de 1) des images dont l'action n'est pas « rien ». */
const evenements = (actions: readonly ActionSurveillance[]) => actions.flatMap((action, i) => (action === "rien" ? [] : [`${i + 1}:${action}`]));

describe("fluidity : surveillance des images animées (§5.8 l.1007)", () => {
  it("proposition à 5 s de temps animé lent, une seule fois ; bascule à 10 s", () => {
    const { actions, etat } = rejouer(animees(260, 40));
    assert.deepEqual(evenements(actions).slice(0, 2), ["125:proposer", "250:basculer"]);
    assert.ok(actions.slice(250).every((action) => action === "basculer"), "au-delà de 10 s : toujours basculer");
    assert.equal(etat.periode?.debut, 1_040, "la période commence à la première image lente");
    assert.equal(etat.periode?.proposee, true);
  });

  it("une image de 33 ms tout juste n'est pas lente : aucune période ; une médiane de 33 ms tout juste ne la ferme pas", () => {
    const { actions, etat } = rejouer(animees(400, 33));
    assert.deepEqual(evenements(actions), []);
    assert.equal(etat.periode, null);
    const ouverte = rejouer(animees(20, 33), rejouer(animees(100, 40)).etat);
    assert.equal(ouverte.etat.periode?.lentMs, 4_000 + 20 * 33, "médiane à 33 ms : pas « sous » 33 ms");
  });

  it("images non animées ignorées : état rendu tel quel, jamais comptées", () => {
    const debut = rejouer(animees(124, 40));
    assert.deepEqual(evenements(debut.actions), []);
    for (const ms of [5, 100, 400, 60_000]) {
      const suite = surveiller(debut.etat, { ms, anime: false, now: 99 });
      assert.equal(suite.etat, debut.etat);
      assert.equal(suite.action, "rien");
    }
    const pause = rejouer(serie(500, 100).map((ms) => ({ ms, anime: false })), debut.etat);
    assert.deepEqual(evenements(pause.actions), []);
    assert.equal(pause.etat, debut.etat);
    assert.equal(rejouer(animees(1, 40), pause.etat).actions[0], "proposer", "125e image animée lente");
  });

  it("remise à zéro quand la médiane des 10 dernières images animées repasse sous 33 ms", () => {
    const lent = rejouer(animees(100, 40));
    assert.equal(lent.etat.periode?.lentMs, 4_000);
    const reprise = rejouer(animees(MEDIANE_IMAGES, 16), lent.etat);
    assert.equal(reprise.etat.periode, null, "reprise : période close");
    const encore = rejouer(animees(100, 40), reprise.etat);
    assert.deepEqual(evenements(encore.actions), [], "7 s lentes en deux périodes : aucune proposition");
    assert.ok((encore.etat.periode?.lentMs ?? 0) < FLUIDITE.surveillance.proposerMs);
  });

  it("proposition retirée par une reprise : l'état ne la porte plus", () => {
    const propose = rejouer(animees(130, 40));
    assert.equal(propose.etat.periode?.proposee, true);
    assert.equal(rejouer(animees(MEDIANE_IMAGES, 16), propose.etat).etat.periode, null);
  });

  it("une image lente isolée ouvre une période que la reprise ferme aussitôt", () => {
    const fluide = rejouer(animees(20, 16));
    const hoquet = rejouer([{ ms: 80 }], fluide.etat);
    assert.equal(hoquet.etat.periode?.lentMs, 80);
    assert.equal(rejouer(animees(1, 16), hoquet.etat).etat.periode, null);
  });

  it("une image compte au plus IMAGE_MAX_MS : une minute (onglet masqué) ne bascule pas ; une scène figée bascule quand même", () => {
    const masque = rejouer([{ ms: 60_000 }]);
    assert.deepEqual(masque.actions, ["rien"]);
    assert.equal(masque.etat.periode?.lentMs, IMAGE_MAX_MS);
    const figee = rejouer(animees(10, 2_000));
    assert.deepEqual(evenements(figee.actions), ["5:proposer", "10:basculer"]);
  });

  it("durée non mesurable ignorée ; fenêtre de 10 images ; médiane", () => {
    const debut = rejouer(animees(3, 40));
    for (const ms of [Number.NaN, -1, Number.POSITIVE_INFINITY]) assert.equal(surveiller(debut.etat, { ms, anime: true, now: 5 }).etat, debut.etat);
    assert.equal(rejouer(animees(25, 16)).etat.recentes.length, MEDIANE_IMAGES);
    const liste = Object.freeze([4, 1, 3, 2]);
    assert.equal(mediane(liste), 2.5);
    assert.equal(mediane([3, 1, 2]), 2);
    assert.ok(Number.isNaN(mediane([])));
    assert.deepEqual(liste, [4, 1, 3, 2]);
  });
});

describe("fluidity : préférence du poste (D-3d-25)", () => {
  it("format exact sous la clé cockpit.salle3d, aller et retour", () => {
    assert.equal(PREFERENCE_CLE, "cockpit.salle3d");
    assert.equal(ecrirePreference("2d", "saccades", 1_758_268_800_000), '{"v":1,"choix":"2d","raison":"saccades","le":1758268800000}');
    assert.equal(ecrirePreference("auto", null, 12.9), '{"v":1,"choix":"auto","raison":null,"le":12}');
    assert.equal(ecrirePreference("auto", null, Number.NaN), '{"v":1,"choix":"auto","raison":null,"le":null}');
    assert.equal(ecrirePreference("2d", "saccades", -1), '{"v":1,"choix":"2d","raison":"saccades","le":null}');
    assert.equal(lirePreference(ecrirePreference("2d", "saccades", -1)).choix, "2d", "heure douteuse : le choix reste lisible");
    for (const raison of RAISONS_FLUIDITE) {
      assert.deepEqual(lirePreference(ecrirePreference("2d", raison, 5)), { v: 1, choix: "2d", raison, le: 5 });
    }
    assert.deepEqual(lirePreference(ecrirePreference("auto", null, -1)), { v: 1, choix: "auto", raison: null, le: null });
  });

  it("absente ou illisible → auto", () => {
    const valide = (changements: Record<string, unknown>) => JSON.stringify({ v: 1, choix: "2d", raison: "preference-2d", le: 1, ...changements });
    const illisibles: Array<string | null> = [
      null,
      "",
      "{",
      "2d",
      '"2d"',
      "null",
      "[]",
      '["2d"]',
      "{}",
      valide({ v: 2 }),
      valide({ v: "1" }),
      valide({ choix: "3d" }),
      valide({ choix: "2D" }),
      valide({ raison: "inconnue" }),
      valide({ raison: undefined }),
      valide({ le: "hier" }),
      valide({ le: -1 }),
      valide({ le: undefined }),
      `${valide({})}${" ".repeat(PREFERENCE_BRUT_MAX)}`,
    ];
    for (const brut of illisibles) assert.deepEqual(lirePreference(brut), preferenceAuto(), String(brut));
    assert.deepEqual(lirePreference(valide({})), { v: 1, choix: "2d", raison: "preference-2d", le: 1 });
    assert.deepEqual(lirePreference(valide({ raison: null, le: null })), { v: 1, choix: "2d", raison: null, le: null });
  });

  it("seuls les quatre champs du format sont lus ; « __proto__ » ne pollue rien", () => {
    const lue = lirePreference('{"v":1,"choix":"2d","raison":null,"le":3,"autre":true,"__proto__":{"pollue":true}}');
    assert.deepEqual(lue, { v: 1, choix: "2d", raison: null, le: 3 });
    assert.deepEqual(Object.keys(lue), ["v", "choix", "raison", "le"]);
    assert.equal((lue as unknown as Record<string, unknown>).pollue, undefined);
    assert.equal(({} as Record<string, unknown>).pollue, undefined);
  });

  it("préférence par défaut : un objet neuf à chaque appel", () => {
    const a = preferenceAuto();
    a.choix = "2d";
    assert.equal(preferenceAuto().choix, "auto");
  });
});

describe("fluidity : contrat (D-3d-27) et pureté", () => {
  it("six raisons, seuils de la spécification, trois rendus logiciels", () => {
    assert.deepEqual([...RAISONS_FLUIDITE], ["accessibilite", "webgl-absent", "rendu-logiciel", "sonde-lente", "saccades", "preference-2d"]);
    // Chaque raison du type figure dans la liste (vérifié à la compilation).
    const exhaustif: [Exclude<FluidityReason, (typeof RAISONS_FLUIDITE)[number]>] extends [never] ? true : false = true;
    assert.equal(exhaustif, true);
    assert.deepEqual(FLUIDITE, { sonde: { images: 90, p95MaxMs: 20, lenteMs: 50, lentesMax: 3 }, surveillance: { seuilMs: 33, proposerMs: 5_000, basculerMs: 10_000 } });
    assert.deepEqual([...RENDUS_LOGICIELS], ["SwiftShader", "llvmpipe", "Microsoft Basic Render"]);
    assert.ok(Object.isFrozen(SURVEILLANCE_INITIALE));
  });

  it("types partagés réexportés de salle3d-types.ts depuis le train de V0 (D-3d-27) ; seul import : ces types (ni textes, ni three)", () => {
    assert.ok(SOURCE.includes('import type { FluidityReason, FluidityVerdict } from "./salle3d-types.ts";'));
    assert.ok(SOURCE.includes('export type { FluidityReason, FluidityVerdict } from "./salle3d-types.ts";'));
    assert.doesNotMatch(SOURCE, /\btype\s+(?:FluidityReason|FluidityVerdict)\s*=/, "plus aucune copie");
    const sources = [...SOURCE.matchAll(/^\s*(?:import|export)\b[^;]*\bfrom\s*["']([^"']+)["']/gm)].map((m) => m[1]);
    assert.deepEqual([...new Set(sources)], ["./salle3d-types.ts"], "seul import");
    assert.equal(/^\s*import\s+(?!type\b)/m.test(SOURCE), false, "aucun import de valeur");
    assert.equal(/\bimport\s*\(/.test(SOURCE), false, "aucun import dynamique");
  });

  it("ni module node, ni process, ni horloge, ni aléa, ni réseau, ni minuterie, ni navigateur", () => {
    assert.equal(SOURCE.includes('"node:'), false);
    for (const interdit of [/\bprocess\./, /\bDate\b/, /Math\.random/, /\bperformance\./, /\bfetch\s*\(/, /\bset(?:Timeout|Interval)\b/, /\bcrypto\./, /\bwindow\./, /\bdocument\./, /\blocalStorage\./]) {
      assert.doesNotMatch(SOURCE, interdit);
    }
  });
});
