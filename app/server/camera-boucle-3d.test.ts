// Caméra et boucle de la salle de contrôle 3D (itération 3, L29c ; spécification §5.8 l.996 « caméra perspective de 35°, inclinée
// de 55° », l.998 « Suivre l'action (translation de caméra en 1 s au plus) », JP-13 ; plan it3 §6 « L29c », D-3d-17).
// Deux modules PURS, hors de three/ : tout se joue en Node, sans three, sans DOM, sans horloge (l'instant est un paramètre).
// Chaque garde a ici un contrôle qui échoue sans elle : la borne d'une seconde, l'arrêt de la boucle sous mouvement réduit ou
// page cachée, la limite de 4 recalculs par seconde.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  ASPECT_REFERENCE,
  avancementSuivi,
  avancerSuivi,
  cadrer,
  CHAMP_DEG,
  creerSuivi,
  DISTANCE_MIN,
  dureeSuivi,
  FACTEUR_CADRAGE_MAX,
  facteurCadrage,
  INCLINAISON_DEG,
  INCLINAISON_MAX_DEG,
  INCLINAISON_MIN_DEG,
  interpolerPoint,
  LOIN,
  positionCamera,
  PRES,
  REGLAGE_DEFAUT,
  reglageBorne,
  SUIVI_MS_MAX,
} from "../web/pages/salle-controle/camera-3d.ts";
import { creerLimiteur, doitAnimer, INTERVALLE_RECALCUL_MS, PERIODE_HALO_S, phaseHalo, RECALCULS_PAR_SECONDE } from "../web/pages/salle-controle/boucle-3d.ts";
import { PLAN3D_CAMERA } from "./shared/neon-plan3d.ts";
import type { Plan3dCamera, Point3 } from "./shared/salle3d-types.ts";

const RAD = Math.PI / 180;

const point = (x: number, y: number, z: number): Point3 => ({ x, y, z });

const reglage = (partiel: Partial<Plan3dCamera> = {}): Plan3dCamera => ({
  cible: point(0, 0, 0),
  distance: 26,
  inclinaisonDeg: INCLINAISON_DEG,
  fovDeg: CHAMP_DEG,
  ...partiel,
});

/** Distance entre deux points. */
const distance = (a: Point3, b: Point3) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);

/** Angle (degrés) entre le sol et la ligne qui va de la cible à l'œil. */
const inclinaisonMesuree = (cible: Point3, oeil: Point3) => Math.atan2(oeil.y - cible.y, Math.hypot(oeil.x - cible.x, oeil.z - cible.z)) / RAD;

const proche = (obtenu: number, attendu: number, marge = 1e-9) => assert.ok(Math.abs(obtenu - attendu) <= marge, `${obtenu} ≈ ${attendu} (marge ${marge})`);

// --- Caméra -------------------------------------------------------------------------------------------------------------------------

describe("camera-3d : 35° d'ouverture, 55° d'inclinaison (spéc. l.996)", () => {
  it("les valeurs viennent du plan (PLAN3D_CAMERA, L29a) : jamais recopiées", () => {
    assert.equal(CHAMP_DEG, 35);
    assert.equal(INCLINAISON_DEG, 55);
    assert.equal(CHAMP_DEG, PLAN3D_CAMERA.fovDeg);
    assert.equal(INCLINAISON_DEG, PLAN3D_CAMERA.inclinaisonDeg);
    assert.deepEqual(REGLAGE_DEFAUT, { cible: point(0, 0, 0), distance: PLAN3D_CAMERA.distances[1], inclinaisonDeg: 55, fovDeg: 35 });
    assert.ok(PRES > 0 && PRES < 1 && LOIN > 260, "le sol (260 unités de côté) tient dans le tronc de vue");
  });

  it("l'œil est à la distance demandée, élevé de l'inclinaison, du côté de la station « Vous » (z > 0)", () => {
    const vue = reglage({ cible: point(3, 0, -2), distance: 15 });
    const oeil = positionCamera(vue);
    proche(distance(vue.cible, oeil), 15);
    proche(inclinaisonMesuree(vue.cible, oeil), 55, 1e-9);
    assert.equal(oeil.x, 3, "aucun décalage latéral : la caméra reste au-dessus de l'axe de la cible");
    assert.ok(oeil.z > vue.cible.z, "l'œil est en avant de la cible");
    assert.ok(oeil.y > vue.cible.y, "vue plongeante");
    proche(oeil.y, 15 * Math.sin(55 * RAD));
    proche(oeil.z, -2 + 15 * Math.cos(55 * RAD));
  });

  it("une inclinaison de 0° ou de 90° est ramenée dans ses bornes (visée jamais dégénérée)", () => {
    proche(inclinaisonMesuree(point(0, 0, 0), positionCamera(reglage({ inclinaisonDeg: 0 }))), INCLINAISON_MIN_DEG, 1e-9);
    proche(inclinaisonMesuree(point(0, 0, 0), positionCamera(reglage({ inclinaisonDeg: 90 }))), INCLINAISON_MAX_DEG, 1e-9);
    assert.equal(reglageBorne(reglage({ distance: 0 })).distance, DISTANCE_MIN);
    assert.equal(reglageBorne(reglage({ distance: Number.NaN })).distance, DISTANCE_MIN);
    assert.equal(reglageBorne(reglage({ fovDeg: 500 })).fovDeg, 100);
    // Le réglage du plan, lui, traverse les bornes sans changer.
    assert.deepEqual(reglageBorne(reglage()), reglage());
  });
});

describe("camera-3d : cadrage d'un zoom", () => {
  it("cadre au moins aussi large que la référence : la distance du plan est gardée", () => {
    for (const aspect of [ASPECT_REFERENCE, 2, 3.5]) {
      assert.equal(facteurCadrage(aspect), 1, `aspect ${aspect}`);
      assert.deepEqual(cadrer(reglage(), aspect), reglage(), `aspect ${aspect}`);
    }
  });

  it("cadre plus étroit : la caméra recule juste assez pour garder la largeur visible, sans dépasser le facteur maximal", () => {
    const etroit = cadrer(reglage(), 1);
    proche(etroit.distance, 26 * ASPECT_REFERENCE);
    // Largeur visible = distance × tan(champ / 2) × aspect : inchangée par le recul.
    const largeurVisible = (r: Plan3dCamera, aspect: number) => r.distance * Math.tan((r.fovDeg / 2) * RAD) * aspect;
    proche(largeurVisible(etroit, 1), largeurVisible(reglage(), ASPECT_REFERENCE), 1e-9);
    assert.equal(facteurCadrage(0.1), FACTEUR_CADRAGE_MAX);
    assert.equal(cadrer(reglage(), 0.1).distance, 26 * FACTEUR_CADRAGE_MAX);
    // Le cadrage ne touche ni la cible, ni l'inclinaison, ni le champ.
    assert.deepEqual({ ...etroit, distance: 26 }, reglage());
  });

  it("cadre absurde (0, négatif, non fini) : distance inchangée plutôt qu'infinie", () => {
    for (const aspect of [0, -2, Number.NaN, Number.POSITIVE_INFINITY]) assert.equal(facteurCadrage(aspect), 1, `aspect ${aspect}`);
  });

  it("zooms du plan : plus on descend, plus la caméra s'approche", () => {
    const distances = [1, 2, 3].map((zoom) => PLAN3D_CAMERA.distances[zoom as 1 | 2 | 3]);
    assert.deepEqual(distances, [...distances].sort((a, b) => b - a));
    for (const d of distances) assert.equal(cadrer(reglage({ distance: d }), ASPECT_REFERENCE).distance, d);
  });
});

describe("camera-3d : « Suivre l'action », translation bornée à 1 s (spéc. l.998)", () => {
  it("la durée demandée est bornée à 1 s, et une durée absente vaut un déplacement immédiat", () => {
    assert.equal(SUIVI_MS_MAX, 1000);
    assert.equal(dureeSuivi(400), 400);
    assert.equal(dureeSuivi(1000), 1000);
    assert.equal(dureeSuivi(5000), SUIVI_MS_MAX);
    for (const ms of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) assert.equal(dureeSuivi(ms), 0, `ms ${ms}`);
  });

  it("une translation de 5 s est FINIE au bout d'une seconde (borne, garde discriminante)", () => {
    const suivi = creerSuivi(point(0, 0, 0), point(10, 0, 0), 1_000, 5_000);
    assert.notEqual(suivi, null);
    assert.equal(suivi?.ms, SUIVI_MS_MAX);
    const fin = avancerSuivi(suivi as NonNullable<typeof suivi>, 2_000);
    assert.deepEqual(fin, { cible: point(10, 0, 0), fini: true });
    // Au milieu de la seconde : à mi-chemin, et pas encore fini.
    const milieu = avancerSuivi(suivi as NonNullable<typeof suivi>, 1_500);
    assert.equal(milieu.fini, false);
    proche(milieu.cible.x, 5);
  });

  it("avancement lissé : 0 au départ, 1 à l'arrivée, jamais hors de [0, 1], croissant", () => {
    assert.equal(avancementSuivi(0, 1000), 0);
    assert.equal(avancementSuivi(1000, 1000), 1);
    assert.equal(avancementSuivi(-50, 1000), 0);
    assert.equal(avancementSuivi(9_999, 1000), 1);
    assert.equal(avancementSuivi(0, 0), 1, "durée nulle : déjà arrivé");
    let precedent = -1;
    for (let ms = 0; ms <= 1000; ms += 50) {
      const t = avancementSuivi(ms, 1000);
      assert.ok(t >= 0 && t <= 1, `avancement ${t}`);
      assert.ok(t >= precedent, `croissant en ${ms} ms`);
      precedent = t;
    }
    proche(avancementSuivi(500, 1000), 0.5);
  });

  it("interpolation : chaque coordonnée suit l'avancement, bornée aux extrémités", () => {
    const de = point(-2, 1, 4);
    const vers = point(6, 3, -4);
    assert.deepEqual(interpolerPoint(de, vers, 0), de);
    assert.deepEqual(interpolerPoint(de, vers, 1), vers);
    assert.deepEqual(interpolerPoint(de, vers, 0.5), point(2, 2, 0));
    assert.deepEqual(interpolerPoint(de, vers, -3), de);
    assert.deepEqual(interpolerPoint(de, vers, 12), vers);
    assert.deepEqual(interpolerPoint(de, vers, Number.NaN), vers);
  });

  it("translation inutile : durée nulle ou cible déjà atteinte → aucune animation (l'appelant pose la cible)", () => {
    assert.equal(creerSuivi(point(0, 0, 0), point(5, 0, 0), 0, 0), null);
    assert.equal(creerSuivi(point(5, 1, 2), point(5, 1, 2), 0, 800), null);
    assert.notEqual(creerSuivi(point(0, 0, 0), point(5, 0, 0), 0, 800), null);
  });
});

// --- Boucle ---------------------------------------------------------------------------------------------------------------------------

describe("boucle-3d : une image de plus seulement si quelque chose bouge (D-3d-17)", () => {
  it("mouvement réduit : JAMAIS d'animation, même si le plan s'anime et que la page est visible (JP-13)", () => {
    assert.equal(doitAnimer({ anime: true, mouvementReduit: true, visible: true }), false);
    assert.equal(doitAnimer({ anime: true, mouvementReduit: false, visible: true }), true);
  });

  it("rien d'animé : arrêt de la boucle", () => {
    assert.equal(doitAnimer({ anime: false, mouvementReduit: false, visible: true }), false);
  });

  it("page cachée : aucune image demandée (un onglet caché n'en reçoit pas, MX-3D M3D-4)", () => {
    assert.equal(doitAnimer({ anime: true, mouvementReduit: false, visible: false }), false);
  });

  it("les trois conditions sont nécessaires : une seule fausse suffit à arrêter", () => {
    const cas = [true, false];
    for (const anime of cas) {
      for (const mouvementReduit of cas) {
        for (const visible of cas) {
          assert.equal(doitAnimer({ anime, mouvementReduit, visible }), anime && !mouvementReduit && visible, `${anime}/${mouvementReduit}/${visible}`);
        }
      }
    }
  });
});

describe("boucle-3d : halo pulsé, un cycle par 2 s (spéc. l.996)", () => {
  it("période de 2 s, sommet à 0,5 s, creux à 1,5 s, bornes 0 et 1", () => {
    assert.equal(PERIODE_HALO_S, 2);
    proche(phaseHalo(0), 0.5);
    proche(phaseHalo(0.5), 1);
    proche(phaseHalo(1), 0.5, 1e-12);
    proche(phaseHalo(1.5), 0);
    for (let t = 0; t <= 6; t += 0.05) {
      const phase = phaseHalo(t);
      assert.ok(phase >= 0 && phase <= 1, `phase ${phase} en ${t} s`);
      proche(phase, phaseHalo(t + PERIODE_HALO_S), 1e-12);
    }
    assert.equal(phaseHalo(Number.NaN), 0.5, "temps illisible : halo au repos plutôt qu'une valeur folle");
  });
});

describe("boucle-3d : 4 recalculs du plan par seconde au plus (D-3d-17)", () => {
  it("rafale de 50 plans en 1 s : 4 recalculs, jamais un de plus", () => {
    assert.equal(RECALCULS_PAR_SECONDE, 4);
    assert.equal(INTERVALLE_RECALCUL_MS, 250);
    const limiteur = creerLimiteur();
    const passes: number[] = [];
    // 50 plans, un toutes les 20 ms, de 0 à 980 ms : une seconde pleine.
    for (let i = 0; i < 50; i++) {
      const maintenant = i * 20;
      if (limiteur.autoriser(maintenant)) passes.push(maintenant);
    }
    // Les plans tombent toutes les 20 ms : le premier plan qui suit chaque intervalle de 250 ms est retenu.
    assert.deepEqual(passes, [0, 260, 520, 780]);
    assert.equal(passes.length, RECALCULS_PAR_SECONDE);
  });

  it("deux recalculs sont toujours séparés d'au moins 250 ms, sur une rafale irrégulière", () => {
    const limiteur = creerLimiteur();
    const passes: number[] = [];
    let maintenant = 0;
    for (let i = 0; i < 200; i++) {
      maintenant += 3 + (i % 17);
      if (limiteur.autoriser(maintenant)) passes.push(maintenant);
    }
    assert.ok(passes.length > 1, `${passes.length} recalculs`);
    for (let i = 1; i < passes.length; i++) {
      const ecart = (passes[i] ?? 0) - (passes[i - 1] ?? 0);
      assert.ok(ecart >= INTERVALLE_RECALCUL_MS, `écart ${ecart} ms`);
    }
  });

  it("le plan retardé n'est pas perdu : attente() dit combien de temps attendre, puis le recalcul passe", () => {
    const limiteur = creerLimiteur();
    assert.equal(limiteur.attente(0), 0);
    assert.equal(limiteur.autoriser(0), true);
    assert.equal(limiteur.attente(40), 210);
    assert.equal(limiteur.autoriser(40), false);
    assert.equal(limiteur.attente(249), 1);
    assert.equal(limiteur.autoriser(250), true);
    assert.equal(limiteur.attente(250), 250);
  });

  it("horloge qui recule ou illisible : le recalcul repart du présent, jamais une attente sans fin", () => {
    const limiteur = creerLimiteur();
    limiteur.marquer(10_000);
    assert.equal(limiteur.attente(5_000), 0);
    limiteur.marquer(Number.NaN);
    assert.equal(limiteur.attente(0), 0);
    limiteur.reinitialiser();
    assert.equal(limiteur.attente(0), 0);
  });

  it("intervalle réglable (essais) ; un intervalle absurde revient à celui du plan", () => {
    const rapide = creerLimiteur(50);
    assert.equal(rapide.autoriser(0), true);
    assert.equal(rapide.autoriser(49), false);
    assert.equal(rapide.autoriser(50), true);
    const defaut = creerLimiteur(Number.NaN);
    assert.equal(defaut.autoriser(0), true);
    assert.equal(defaut.attente(100), 150);
  });
});
