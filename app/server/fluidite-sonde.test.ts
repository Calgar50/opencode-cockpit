// Fluidité côté navigateur (plan it3, fiche L30 ; spécification §5.8 l.1003-1008, JP-12 ; D-3d-18, D-3d-22, D-3d-25, D-3d-27),
// sous Node, avec des doublures injectées :
// - sonder : exactement 90 mesures et 90 appels à `raf`, aucune image au-delà ; horloge `performance.now` lue à l'appel (l'horloge
//   du « moteur simulé » de l'e2e s'applique) ; erreur de rendu → rejet et arrêt ;
// - capacites : requêtes média, contexte demandé avec failIfMajorPerformanceCaveat puis relâché, second essai sans le drapeau,
//   nom du moteur de rendu borné ;
// - préférence locale en try/catch, marque « salle3d:bascule » ;
// - contrôleur de useFluidite : sonde, surveillance, proposition, [Passer en 2D], [Rester en 3D], [Réessayer], abandon ;
// - useFluidite sans texte, sans boucle, sans import croisé de V0 ni de three.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import {
  type CapacitesNavigateur,
  type FluidityReason,
  type Preference,
  type PreferenceChoix,
  preferenceAuto,
  verdictCapacites,
  verdictSonde,
} from "./shared/fluidity.ts";
import {
  type CanevasEssai,
  type ContexteEssai,
  capacites,
  creerSurveillance,
  enregistrerPreference,
  MARQUE_BASCULE,
  MOTEUR_MAX,
  marquerBascule,
  preferenceLocale,
  REQUETE_COULEURS_FORCEES,
  REQUETE_MOUVEMENT_REDUIT,
  type StockagePoste,
  sonder,
} from "../web/pages/salle-controle/fluidite.ts";
import { creerControleFluidite, type EtatFluidite, type Fluidite, useFluidite } from "../web/pages/salle-controle/useFluidite.ts";

const WEB = path.join(import.meta.dirname, "..", "web", "pages", "salle-controle");
const lire = (fichier: string) => fs.readFileSync(path.join(WEB, fichier), "utf8");

/** File de rappels d'images : `raf` les empile, `derouler` les joue jusqu'à épuisement (borné). */
function fileDImages() {
  const file: FrameRequestCallback[] = [];
  let appels = 0;
  return {
    raf: (rappel: FrameRequestCallback) => {
      appels += 1;
      file.push(rappel);
      return appels;
    },
    derouler() {
      let tours = 0;
      while (file.length > 0) {
        assert.ok(++tours <= 1_000, "boucle d'images non bornée");
        (file.shift() as FrameRequestCallback)(tours * 16);
      }
    },
    appels: () => appels,
    enAttente: () => file.length,
  };
}

/** Horloge factice : +pas ms à chaque lecture. */
function horloge(pas: number) {
  let t = 1_000;
  let lectures = 0;
  return {
    now: () => {
      lectures += 1;
      t += pas;
      return t;
    },
    lectures: () => lectures,
  };
}

describe("sonder : 90 images forcées, bornée (D-3d-18, D-3d-22)", () => {
  it("raf et now injectés : exactement 90 mesures, 90 appels à raf, 90 rendus, aucune image au-delà", async () => {
    const images = fileDImages();
    const temps = horloge(12);
    let rendus = 0;
    const promesse = sonder(() => (rendus += 1), images.raf, temps.now);
    images.derouler();
    const mesures = await promesse;
    assert.equal(mesures.length, 90);
    assert.ok(mesures.every((ms) => ms === 12));
    assert.equal(images.appels(), 90);
    assert.equal(rendus, 90);
    assert.equal(images.enAttente(), 0);
    assert.equal(temps.lectures(), 91, "une lecture au départ, puis une par image");
    assert.deepEqual(verdictSonde(mesures), { ok: true, p95: 12, lentes: 0 });
  });

  it("raf qui rappelle aussitôt : toujours 90 mesures et 90 appels", async () => {
    let appels = 0;
    const raf = (rappel: FrameRequestCallback) => {
      appels += 1;
      assert.ok(appels <= 90, "au plus 90 appels à raf");
      rappel(0);
      return appels;
    };
    const mesures = await sonder(() => {}, raf, horloge(30).now);
    assert.equal(mesures.length, 90);
    assert.equal(appels, 90);
    assert.equal(verdictSonde(mesures).ok, false, "30 ms par image : p95 au-delà de 20 ms");
  });

  it("performance.now lu à l'appel, jamais retenu au chargement : l'horloge remplacée après l'import s'applique", async (t) => {
    let instant = 50_000;
    t.mock.method(performance, "now", () => (instant += 12));
    const images = fileDImages();
    const promesse = sonder(() => {}, images.raf);
    images.derouler();
    const mesures = await promesse;
    assert.equal(mesures.length, 90);
    assert.ok(mesures.every((ms) => ms === 12), "horloge du « moteur simulé » : 12 ms par image");
    assert.equal(instant, 50_000 + 12 * 91);
  });

  it("erreur de rendu ou de raf : promesse rejetée, aucune image demandée après", async () => {
    const images = fileDImages();
    let rendus = 0;
    const promesse = sonder(
      () => {
        rendus += 1;
        if (rendus === 10) throw new Error("rendu impossible");
      },
      images.raf,
      horloge(12).now,
    );
    images.derouler();
    await assert.rejects(promesse, /rendu impossible/);
    assert.equal(images.appels(), 10);
    assert.equal(images.enAttente(), 0);
    await assert.rejects(
      sonder(
        () => {},
        () => {
          throw new Error("raf absent");
        },
        horloge(12).now,
      ),
      /raf absent/,
    );
  });
});

/** Contexte webgl2 factice : extensions présentes ou non, nom du moteur de rendu, relâche comptée. */
function contexteFactice(options: { moteur?: string | null; debugLeve?: boolean; perteLeve?: boolean } = {}) {
  let relaches = 0;
  const contexte: ContexteEssai = {
    getExtension: ((nom: string) => {
      if (nom === "WEBGL_lose_context") {
        return {
          loseContext() {
            relaches += 1;
            if (options.perteLeve) throw new Error("contexte déjà perdu");
          },
        };
      }
      if (nom === "WEBGL_debug_renderer_info") return options.moteur === null ? null : { UNMASKED_RENDERER_WEBGL: 0x9246 };
      return null;
    }) as ContexteEssai["getExtension"],
    getParameter(parametre: number) {
      if (options.debugLeve) throw new Error("paramètre refusé");
      return parametre === 0x9246 ? (options.moteur ?? "ANGLE (AMD, Radeon RX 7800 XT Direct3D11 vs_5_0 ps_5_0, D3D11)") : null;
    },
  };
  return { contexte, relaches: () => relaches };
}

/** Environnement factice : réglages actifs, et un contexte (ou null, ou une erreur) par essai successif. */
function environnement(essais: Array<ContexteEssai | null | "leve">, actifs: readonly string[] = []) {
  const demandes: Array<WebGLContextAttributes | undefined> = [];
  const requetes: string[] = [];
  let canevas = 0;
  return {
    env: {
      media: (requete: string) => {
        requetes.push(requete);
        return actifs.includes(requete);
      },
      canevas: (): CanevasEssai => {
        const essai = essais[canevas];
        canevas += 1;
        return {
          getContext: (type, options) => {
            assert.equal(type, "webgl2");
            demandes.push(options);
            if (essai === "leve") throw new Error("getContext refusé");
            return essai ?? null;
          },
        };
      },
    },
    demandes,
    requetes,
    canevas: () => canevas,
  };
}

describe("capacites : accessibilité et contexte webgl2 d'un canevas jetable", () => {
  it("contexte matériel : un seul canevas, demandé avec failIfMajorPerformanceCaveat, relâché ; nom du moteur lu", () => {
    const gl = contexteFactice();
    const banc = environnement([gl.contexte]);
    const lues = capacites(banc.env);
    assert.deepEqual(lues, {
      mouvementReduit: false,
      couleursForcees: false,
      webgl2: true,
      contexteRefuse: false,
      moteur: "ANGLE (AMD, Radeon RX 7800 XT Direct3D11 vs_5_0 ps_5_0, D3D11)",
    });
    assert.equal(banc.canevas(), 1);
    assert.deepEqual(banc.demandes, [{ failIfMajorPerformanceCaveat: true }]);
    assert.equal(gl.relaches(), 1);
    assert.deepEqual(verdictCapacites({ ...lues, preference: "auto" }), { mode: "3d" });
  });

  it("requêtes média des deux réglages ; réglage actif ou matchMedia qui lève", () => {
    const banc = environnement([contexteFactice().contexte], [REQUETE_MOUVEMENT_REDUIT]);
    const lues = capacites(banc.env);
    assert.deepEqual(banc.requetes, [REQUETE_MOUVEMENT_REDUIT, REQUETE_COULEURS_FORCEES]);
    assert.equal(lues.mouvementReduit, true);
    assert.equal(lues.couleursForcees, false);
    assert.deepEqual(verdictCapacites({ ...lues, preference: "auto" }), { mode: "2d", raison: "accessibilite" });
    assert.equal(capacites(environnement([contexteFactice().contexte], [REQUETE_COULEURS_FORCEES]).env).couleursForcees, true);
    const leve = { media: () => { throw new Error("matchMedia absent"); }, canevas: environnement([contexteFactice().contexte]).env.canevas };
    assert.deepEqual([capacites(leve).mouvementReduit, capacites(leve).couleursForcees], [false, false]);
    for (const requete of [REQUETE_MOUVEMENT_REDUIT, REQUETE_COULEURS_FORCEES]) assert.doesNotMatch(requete, /\s/);
    assert.equal(REQUETE_MOUVEMENT_REDUIT, "(prefers-reduced-motion:reduce)");
    assert.equal(REQUETE_COULEURS_FORCEES, "(forced-colors:active)");
  });

  it("refusé avec le drapeau, obtenu sans : contexteRefuse, second canevas relâché, verdict rendu-logiciel", () => {
    const logiciel = contexteFactice({ moteur: "ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero)), SwiftShader driver)" });
    const banc = environnement([null, logiciel.contexte]);
    const lues = capacites(banc.env);
    assert.equal(banc.canevas(), 2);
    assert.deepEqual(banc.demandes, [{ failIfMajorPerformanceCaveat: true }, { failIfMajorPerformanceCaveat: false }]);
    assert.deepEqual({ webgl2: lues.webgl2, contexteRefuse: lues.contexteRefuse }, { webgl2: true, contexteRefuse: true });
    assert.equal(logiciel.relaches(), 1);
    assert.deepEqual(verdictCapacites({ ...lues, preference: "auto" }), { mode: "2d", raison: "rendu-logiciel" });
  });

  it("refusé deux fois, ou getContext qui lève : webgl-absent", () => {
    for (const essais of [[null, null], ["leve", "leve"], ["leve", null]] as const) {
      const lues = capacites(environnement([...essais]).env);
      assert.deepEqual({ webgl2: lues.webgl2, contexteRefuse: lues.contexteRefuse, moteur: lues.moteur }, { webgl2: false, contexteRefuse: true, moteur: null });
      assert.deepEqual(verdictCapacites({ ...lues, preference: "auto" }), { mode: "2d", raison: "webgl-absent" });
    }
  });

  it("extension de débogage absente ou en erreur : moteur inconnu, contexte relâché quand même ; relâche en erreur sans effet", () => {
    const sansExtension = contexteFactice({ moteur: null });
    assert.equal(capacites(environnement([sansExtension.contexte]).env).moteur, null);
    assert.equal(sansExtension.relaches(), 1);
    const enErreur = contexteFactice({ debugLeve: true, perteLeve: true });
    const lues = capacites(environnement([enErreur.contexte]).env);
    assert.deepEqual({ webgl2: lues.webgl2, moteur: lues.moteur }, { webgl2: true, moteur: null });
    assert.equal(enErreur.relaches(), 1);
  });

  it("nom du moteur de rendu borné à MOTEUR_MAX caractères", () => {
    const long = contexteFactice({ moteur: `llvmpipe ${"x".repeat(1_000)}` });
    const moteur = capacites(environnement([long.contexte]).env).moteur ?? "";
    assert.equal(moteur.length, MOTEUR_MAX);
    assert.ok(moteur.startsWith("llvmpipe"));
  });
});

describe("préférence locale (D-3d-25) et marque de bascule (D-3d-18)", () => {
  const memoire = (initial: Record<string, string> = {}) => {
    const valeurs = new Map(Object.entries(initial));
    const stockage: StockagePoste = { getItem: (cle) => valeurs.get(cle) ?? null, setItem: (cle, valeur) => void valeurs.set(cle, valeur) };
    return { stockage: () => stockage, valeurs };
  };

  it("lue et écrite sous cockpit.salle3d ; illisible ou absente → auto", () => {
    const poste = memoire();
    assert.deepEqual(preferenceLocale(poste.stockage), preferenceAuto());
    assert.equal(enregistrerPreference("2d", "saccades", 42, poste.stockage), true);
    assert.equal(poste.valeurs.get("cockpit.salle3d"), '{"v":1,"choix":"2d","raison":"saccades","le":42}');
    assert.deepEqual(preferenceLocale(poste.stockage), { v: 1, choix: "2d", raison: "saccades", le: 42 });
    assert.deepEqual(preferenceLocale(memoire({ "cockpit.salle3d": "2d" }).stockage), preferenceAuto());
  });

  it("stockage indisponible (accès, lecture ou écriture qui lèvent) : auto à la lecture, false à l'écriture, jamais d'exception", () => {
    const refuse = () => {
      throw new Error("SecurityError");
    };
    const leve: StockagePoste = { getItem: refuse, setItem: refuse };
    assert.deepEqual(preferenceLocale(refuse), preferenceAuto());
    assert.deepEqual(preferenceLocale(() => leve), preferenceAuto());
    assert.equal(enregistrerPreference("2d", "preference-2d", 1, refuse), false);
    assert.equal(enregistrerPreference("auto", null, 1, () => leve), false);
  });

  it("marque « salle3d:bascule » avec sa raison ; marque refusée sans effet", (t) => {
    const marques: Array<[string, unknown]> = [];
    const mark = t.mock.method(performance, "mark", ((nom: string, options?: PerformanceMarkOptions) => {
      marques.push([nom, options?.detail]);
      return undefined as unknown as PerformanceMark;
    }) as typeof performance.mark);
    marquerBascule("rendu-logiciel");
    assert.equal(MARQUE_BASCULE, "salle3d:bascule");
    assert.deepEqual(marques, [["salle3d:bascule", { raison: "rendu-logiciel" }]]);
    mark.mock.mockImplementation((() => {
      throw new TypeError("mark refusée");
    }) as typeof performance.mark);
    assert.doesNotThrow(() => marquerBascule("saccades"));
  });

  it("creerSurveillance : horloge lue aux seules images animées", () => {
    const temps = horloge(40);
    const surveillance = creerSurveillance(temps.now);
    assert.equal(surveillance.image(500, false), "rien");
    assert.equal(temps.lectures(), 0);
    const actions = Array.from({ length: 125 }, () => surveillance.image(40, true));
    assert.equal(actions.at(-1), "proposer");
    assert.equal(temps.lectures(), 125);
    assert.equal(surveillance.etat().periode?.debut, 1_040);
    surveillance.reinitialiser();
    assert.equal(surveillance.etat().periode, null);
  });
});

const MATERIEL: CapacitesNavigateur = { mouvementReduit: false, couleursForcees: false, webgl2: true, contexteRefuse: false, moteur: "Radeon" };
const FLUIDE = Array.from({ length: 90 }, () => 12);
const LENTE = Array.from({ length: 90 }, () => 40);
const vider = () => new Promise<void>((resoudre) => setImmediate(resoudre));

/** Contrôleur de fluidité sur doublures : capacités modifiables, sondes à résoudre à la main, journal des écritures et des marques. */
function banc(options: { capacites?: Partial<CapacitesNavigateur>; preference?: Preference } = {}) {
  let caps: CapacitesNavigateur = { ...MATERIEL, ...options.capacites };
  const enregistrements: Array<[PreferenceChoix, FluidityReason | null]> = [];
  const marques: FluidityReason[] = [];
  const sondes: Array<{ renderFrame: () => void; resoudre: (ms: number[]) => void; rejeter: (erreur: unknown) => void }> = [];
  const temps = horloge(16);
  const controle = creerControleFluidite({
    capacites: () => caps,
    preference: () => options.preference ?? preferenceAuto(),
    enregistrer: (choix, raison) => void enregistrements.push([choix, raison]),
    sonder: (renderFrame) => new Promise<number[]>((resoudre, rejeter) => void sondes.push({ renderFrame, resoudre, rejeter })),
    surveillance: () => creerSurveillance(temps.now),
    marquer: (raison) => void marques.push(raison),
  });
  let notifications = 0;
  controle.abonner(() => (notifications += 1));
  const images = (n: number, ms: number, anime = true) => {
    for (let i = 0; i < n; i++) controle.image(ms, anime);
  };
  return {
    controle,
    enregistrements,
    marques,
    sondes,
    images,
    notifications: () => notifications,
    changer: (changements: Partial<CapacitesNavigateur>) => {
      caps = { ...caps, ...changements };
    },
  };
}

/** Poignée de scène 3D factice qui compte ses rendus. */
function poignee() {
  let rendus = 0;
  return { renderFrame: () => void (rendus += 1), rendus: () => rendus };
}

/** Banc passé en 3D : poignée remise, sonde fluide. */
async function en3d(b: ReturnType<typeof banc>) {
  b.controle.ouvrir();
  b.controle.pret(poignee());
  b.sondes.at(-1)?.resoudre(FLUIDE);
  await vider();
  assert.deepEqual(b.controle.etat(), { verdict: { mode: "3d" }, sondeEnCours: false, proposition: false });
}

describe("useFluidite : contrôleur (sans texte : raisons seulement)", () => {
  it("2D dès l'ouverture : raison donnée, aucune sonde ; marque posée au montage, une seule fois", () => {
    const b = banc({ capacites: { couleursForcees: true } });
    assert.deepEqual(b.controle.etat(), { verdict: { mode: "2d", raison: "accessibilite" }, sondeEnCours: false, proposition: false });
    assert.deepEqual(b.marques, [], "rien pendant le rendu");
    b.controle.ouvrir();
    b.controle.fermer();
    b.controle.ouvrir();
    assert.deepEqual(b.marques, ["accessibilite"]);
    b.controle.pret(poignee());
    assert.equal(b.sondes.length, 0);
    const pref = banc({ preference: { v: 1, choix: "2d", raison: "saccades", le: 1 } });
    assert.deepEqual(pref.controle.etat().verdict, { mode: "2d", raison: "preference-2d" });
  });

  it("3D : sonde en cours jusqu'à la poignée ; une seule sonde ; sonde fluide → 3D", async () => {
    const b = banc();
    b.controle.ouvrir();
    assert.deepEqual(b.controle.etat(), { verdict: { mode: "3d" }, sondeEnCours: true, proposition: false });
    assert.equal(b.sondes.length, 0, "aucune sonde sans poignée");
    const scene = poignee();
    b.controle.pret(scene);
    b.controle.pret(scene);
    assert.equal(b.sondes.length, 1);
    b.sondes[0]?.renderFrame();
    assert.equal(scene.rendus(), 1);
    b.images(300, 40);
    b.controle.rester3d();
    assert.deepEqual(b.controle.etat(), { verdict: { mode: "3d" }, sondeEnCours: true, proposition: false }, "images et [Rester en 3D] ignorés pendant la sonde");
    b.sondes[0]?.resoudre(FLUIDE);
    await vider();
    assert.deepEqual(b.controle.etat(), { verdict: { mode: "3d" }, sondeEnCours: false, proposition: false });
    assert.deepEqual(b.marques, []);
    assert.ok(b.notifications() >= 1);
    b.images(300, 40);
    assert.deepEqual(b.controle.etat().verdict, { mode: "2d", raison: "saccades" }, "[Rester en 3D] pendant la sonde restait sans effet");
  });

  it("sonde lente → 2D « sonde-lente » ; rendu en erreur → 2D « webgl-absent » ; marque à chaque passage", async () => {
    const lente = banc();
    lente.controle.ouvrir();
    lente.controle.pret(poignee());
    lente.sondes[0]?.resoudre(LENTE);
    await vider();
    assert.deepEqual(lente.controle.etat().verdict, { mode: "2d", raison: "sonde-lente" });
    assert.deepEqual(lente.marques, ["sonde-lente"]);
    assert.deepEqual(lente.enregistrements, [], "bascule automatique : préférence inchangée");
    const erreur = banc();
    erreur.controle.pret(poignee());
    erreur.sondes[0]?.rejeter(new Error("contexte perdu"));
    await vider();
    assert.deepEqual(erreur.controle.etat().verdict, { mode: "2d", raison: "webgl-absent" });
    assert.deepEqual(erreur.marques, ["webgl-absent"]);
  });

  it("démontage pendant la sonde : résultat ignoré, plus aucun rendu demandé à la poignée ; poignée changée → nouvelle sonde", async () => {
    const b = banc();
    const scene = poignee();
    b.controle.pret(scene);
    b.controle.fermer();
    b.sondes[0]?.renderFrame();
    assert.equal(scene.rendus(), 0);
    b.sondes[0]?.resoudre(LENTE);
    await vider();
    assert.deepEqual(b.controle.etat(), { verdict: { mode: "3d" }, sondeEnCours: true, proposition: false });
    const autre = poignee();
    b.controle.pret(autre);
    assert.equal(b.sondes.length, 2);
    b.controle.pret(null);
    b.controle.pret(poignee());
    assert.equal(b.sondes.length, 3, "poignée retirée puis remise : sonde relancée");
    b.sondes[1]?.rejeter(new Error("scène démontée"));
    await vider();
    assert.equal(b.controle.etat().sondeEnCours, true, "sonde abandonnée : son échec est ignoré");
    b.sondes[2]?.resoudre(FLUIDE);
    await vider();
    assert.deepEqual(b.controle.etat().verdict, { mode: "3d" });
  });

  it("démontage puis remontage avec la même poignée (double montage de React) : la sonde est relancée", () => {
    const b = banc();
    const scene = poignee();
    b.controle.pret(scene);
    b.controle.fermer();
    b.controle.pret(scene);
    assert.equal(b.sondes.length, 2);
  });

  it("sonde en cours abandonnée par [Réessayer] ou [Passer en 2D] : son résultat est ignoré", async () => {
    const b = banc();
    b.controle.pret(poignee());
    b.controle.reessayer();
    assert.equal(b.sondes.length, 2);
    b.sondes[0]?.resoudre(LENTE);
    await vider();
    assert.deepEqual(b.controle.etat(), { verdict: { mode: "3d" }, sondeEnCours: true, proposition: false });
    b.controle.passer2d();
    b.sondes[1]?.resoudre(FLUIDE);
    await vider();
    assert.deepEqual(b.controle.etat().verdict, { mode: "2d", raison: "preference-2d" });
  });

  it("surveillance : proposition à 5 s, retirée par une reprise, bascule automatique à 10 s (« saccades »)", async () => {
    const b = banc();
    await en3d(b);
    b.images(124, 40);
    b.images(300, 200, false);
    assert.equal(b.controle.etat().proposition, false);
    b.images(1, 40);
    assert.equal(b.controle.etat().proposition, true);
    b.images(10, 16);
    assert.equal(b.controle.etat().proposition, false, "fluidité revenue : proposition retirée");
    // Fenêtre encore faite d'images rapides : la période ne tient qu'à partir de la 5e image lente, 10 s atteintes vers la 254e.
    b.images(300, 40);
    assert.deepEqual(b.controle.etat(), { verdict: { mode: "2d", raison: "saccades" }, sondeEnCours: false, proposition: false });
    assert.deepEqual(b.marques, ["saccades"]);
    assert.deepEqual(b.enregistrements, [], "bascule automatique : préférence du poste inchangée");
    b.images(10, 16);
    assert.deepEqual(b.controle.etat().verdict, { mode: "2d", raison: "saccades" }, "images ignorées en 2D");
  });

  it("[Passer en 2D] : préférence 2D gardée (cause « saccades » si proposée), verdict « preference-2d » ; sans effet en 2D", async () => {
    const b = banc();
    await en3d(b);
    b.images(125, 40);
    b.controle.passer2d();
    assert.deepEqual(b.enregistrements, [["2d", "saccades"]]);
    assert.deepEqual(b.controle.etat(), { verdict: { mode: "2d", raison: "preference-2d" }, sondeEnCours: false, proposition: false });
    assert.deepEqual(b.marques, ["preference-2d"]);
    b.controle.passer2d();
    assert.equal(b.enregistrements.length, 1);
    b.images(300, 40);
    assert.deepEqual(b.controle.etat().verdict, { mode: "2d", raison: "preference-2d" }, "images ignorées en 2D");
    const directe = banc();
    await en3d(directe);
    directe.controle.passer2d();
    assert.deepEqual(directe.enregistrements, [["2d", "preference-2d"]]);
  });

  it("[Rester en 3D] : proposition retirée, plus de bascule tant que la personne ne réessaie pas", async () => {
    const b = banc();
    await en3d(b);
    b.images(125, 40);
    assert.equal(b.controle.etat().proposition, true);
    b.controle.rester3d();
    assert.equal(b.controle.etat().proposition, false);
    b.images(600, 40);
    assert.deepEqual(b.controle.etat(), { verdict: { mode: "3d" }, sondeEnCours: false, proposition: false });
    assert.deepEqual(b.marques, []);
    const avant = b.notifications();
    b.controle.rester3d();
    assert.equal(b.notifications(), avant, "état inchangé : aucune notification");
  });

  it("[Réessayer] : préférence remise à auto, capacités relues, nouvelle sonde ; la préférence gardée n'est pas relue", async () => {
    const b = banc({ preference: { v: 1, choix: "2d", raison: "preference-2d", le: 1 } });
    b.controle.ouvrir();
    assert.deepEqual(b.controle.etat().verdict, { mode: "2d", raison: "preference-2d" });
    b.controle.reessayer();
    assert.deepEqual(b.enregistrements, [["auto", null]]);
    assert.deepEqual(b.controle.etat(), { verdict: { mode: "3d" }, sondeEnCours: true, proposition: false });
    b.controle.pret(poignee());
    b.sondes[0]?.resoudre(FLUIDE);
    await vider();
    assert.deepEqual(b.controle.etat().verdict, { mode: "3d" });
    b.changer({ mouvementReduit: true });
    b.controle.reessayer();
    assert.deepEqual(b.controle.etat().verdict, { mode: "2d", raison: "accessibilite" });
    assert.deepEqual(b.marques, ["preference-2d", "accessibilite"]);
  });

  it("[Réessayer] en 3D avec la scène montée : sonde relancée sur la même poignée ; surveillance réactivée", async () => {
    const b = banc();
    await en3d(b);
    b.controle.rester3d();
    b.controle.reessayer();
    assert.equal(b.sondes.length, 2);
    b.sondes[1]?.resoudre(FLUIDE);
    await vider();
    b.images(250, 40);
    assert.deepEqual(b.controle.etat().verdict, { mode: "2d", raison: "saccades" });
  });

  it("[Réessayer] après une sonde lente : attend la nouvelle scène (l'ancienne poignée ne sert plus) ; sonde réussie → surveillance remise à zéro", async () => {
    const b = banc();
    b.controle.pret(poignee());
    b.sondes[0]?.resoudre(LENTE);
    await vider();
    b.controle.reessayer();
    assert.equal(b.sondes.length, 1, "aucune sonde sur la scène démontée");
    b.controle.pret(poignee());
    assert.equal(b.sondes.length, 2);
    const scene = banc();
    await en3d(scene);
    scene.images(120, 40);
    scene.controle.reessayer();
    scene.sondes[1]?.resoudre(FLUIDE);
    await vider();
    scene.images(10, 40);
    assert.equal(scene.controle.etat().proposition, false, "4,8 s lentes d'avant la sonde oubliées");
  });

  it("[Réessayer] après un échec de la scène survenu AVANT la première image : transition observable (verdict d'identité neuve, abonnés prévenus)", () => {
    // La scène a échoué avant tout onReady (contexte refusé au montage, morceau paresseux introuvable) : la page a remis
    // `pret(null)`, et l'état du contrôle est resté « 3D, sonde en cours », sans poignée. [Réessayer] recalcule le MÊME état ;
    // sans transition forcée, la garde d'égalité sortirait, la page ne verrait rien et le bouton serait mort.
    const b = banc();
    b.controle.ouvrir();
    b.controle.pret(null);
    const avant = b.controle.etat();
    assert.deepEqual(avant, { verdict: { mode: "3d" }, sondeEnCours: true, proposition: false });
    assert.equal(b.sondes.length, 0, "aucune sonde : il n'y a jamais eu de poignée");
    const vues = b.notifications();
    b.controle.reessayer();
    const apres = b.controle.etat();
    assert.deepEqual(apres, { verdict: { mode: "3d" }, sondeEnCours: true, proposition: false });
    assert.notEqual(apres.verdict, avant.verdict, "identité neuve : la page compare le verdict par référence");
    assert.ok(b.notifications() > vues, "les abonnés sont prévenus");
    // La scène remontée par la page rend sa poignée : la sonde repart pour de bon.
    b.controle.pret(poignee());
    assert.equal(b.sondes.length, 1);
  });

  it("[Réessayer] après une perte de contexte pendant la sonde (poignée retirée) : même transition observable", () => {
    const b = banc();
    b.controle.ouvrir();
    b.controle.pret(poignee());
    assert.equal(b.sondes.length, 1);
    b.controle.pret(null);
    const avant = b.controle.etat().verdict;
    b.controle.reessayer();
    assert.notEqual(b.controle.etat().verdict, avant);
    assert.deepEqual(b.controle.etat(), { verdict: { mode: "3d" }, sondeEnCours: true, proposition: false });
  });

  it("[Réessayer] sur une 2D dont la cause n'a pas bougé : état reposé pour la page, aucune marque « salle3d:bascule » en double", () => {
    const b = banc({ capacites: { couleursForcees: true } });
    b.controle.ouvrir();
    assert.deepEqual(b.marques, ["accessibilite"]);
    const avant = b.controle.etat().verdict;
    b.controle.reessayer();
    assert.deepEqual(b.controle.etat().verdict, { mode: "2d", raison: "accessibilite" });
    assert.notEqual(b.controle.etat().verdict, avant, "la page voit le geste, même quand la cause est la même");
    assert.deepEqual(b.marques, ["accessibilite"], "D-3d-18 : une bascule n'est jamais comptée deux fois");
  });

  it("abonnement : notifié à chaque changement, plus après désabonnement", async () => {
    const b = banc();
    let vus = 0;
    const desabonner = b.controle.abonner(() => (vus += 1));
    await en3d(b);
    assert.equal(vus, 1);
    desabonner();
    b.controle.passer2d();
    assert.equal(vus, 1);
  });
});

describe("useFluidite : crochet React", () => {
  it("rendu : état du contrôleur et actions ; aucun effet (marque) pendant le rendu", () => {
    const marques: FluidityReason[] = [];
    let vu: Fluidite | null = null;
    const Sonde = () => {
      vu = useFluidite({ capacites: () => ({ ...MATERIEL, contexteRefuse: true }), preference: preferenceAuto, marquer: (raison) => void marques.push(raison) });
      return null;
    };
    renderToString(createElement(Sonde));
    const lu = vu as Fluidite | null;
    assert.ok(lu);
    const etat: EtatFluidite = { verdict: lu.verdict, sondeEnCours: lu.sondeEnCours, proposition: lu.proposition };
    assert.deepEqual(etat, { verdict: { mode: "2d", raison: "rendu-logiciel" }, sondeEnCours: false, proposition: false });
    for (const action of ["pret", "image", "reessayer", "passer2d", "rester3d"] as const) assert.equal(typeof lu[action], "function", action);
    assert.deepEqual(marques, []);
  });
});

// --- Lecture statique : sans texte, sans boucle, sans import croisé ------------------------------------------------------------

/** Source sans commentaires, chaînes gardées (les fichiers lus n'ont pas d'expression régulière littérale). */
function lexique(source: string): { code: string; chaines: string[] } {
  let code = "";
  const chaines: string[] = [];
  let i = 0;
  while (i < source.length) {
    const c = source.charAt(i);
    if (c === "/" && (source[i + 1] === "/" || source[i + 1] === "*")) {
      const fin = source[i + 1] === "/" ? source.indexOf("\n", i) : source.indexOf("*/", i + 2) + 2;
      i = fin <= 1 ? source.length : fin;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") {
      let j = i + 1;
      let morceau = "";
      while (j < source.length && source[j] !== c) {
        if (source[j] === "\\") {
          morceau += source.slice(j, j + 2);
          j += 2;
        } else if (c === "`" && source.startsWith("${", j)) {
          chaines.push(morceau);
          morceau = "";
          const fin = source.indexOf("}", j);
          j = fin === -1 ? source.length : fin + 1;
        } else {
          morceau += source[j];
          j += 1;
        }
      }
      chaines.push(morceau);
      code += `${c}${morceau}${c}`;
      i = j + 1;
      continue;
    }
    code += c;
    i += 1;
  }
  return { code, chaines };
}

/** Même lexique que textes.test.ts : un code (minuscules ASCII, chiffres, - _ . :) passe ; texte = lettre et espace, lettre accentuée ou mot à majuscule initiale. */
const CODE = /^[a-z0-9]+(?:[-_.:][a-z0-9]+)*$/;
const affichable = (texte: string) =>
  !CODE.test(texte) && ((/\p{L}/u.test(texte) && /\s/u.test(texte)) || /(?=\P{ASCII})\p{L}/u.test(texte) || /^\p{Lu}\p{Ll}[\p{L}'’-]*[.!?…]?$/u.test(texte));

const textesDe = (source: string) => lexique(source).chaines.filter(affichable);

/** Boucles et demandes d'images interdites dans le crochet (D-3d-22 : seuls three/moteur.ts et fluidite.ts demandent des images). */
const BOUCLES = [/\brequestAnimationFrame\b/, /\bsetInterval\b/, /\bsetTimeout\b/, /\.animate\s*\(/, /\bwhile\s*\(\s*true\s*\)/, /\bfor\s*\(\s*;\s*;\s*\)/];
const bouclesDe = (source: string) => BOUCLES.filter((motif) => motif.test(lexique(source).code)).map(String);

/** Imports d'un source (statiques, dynamiques, réexportations). */
const importsDe = (source: string) => [...lexique(source).code.matchAll(/(?:\bfrom\s*|\bimport\s*\(?\s*)["']([^"']+)["']/g)].map((m) => m[1] ?? "");
const IMPORTS_V0_INTERDITS = /(?:^three(?:\/|$)|\/three\/|salle3d-types|salle3d-texts|revoir-texts|legendes-texts|slots-3d)/;

describe("fluidité : lecture statique (sans texte, sans boucle, D-3d-22, D-3d-27)", () => {
  it("contrôles discriminants sur des sources fabriqués", () => {
    assert.deepEqual(textesDe('// Un commentaire « Réessayer »\nconst a = "sonde-lente";'), []);
    assert.deepEqual(textesDe('const a = "La 3D saccade";'), ["La 3D saccade"]);
    assert.deepEqual(textesDe("const b = `Passage ${x} en 2D`;"), ["Passage ", " en 2D"]);
    assert.deepEqual(textesDe('const c = "Réessayer";'), ["Réessayer"]);
    assert.deepEqual(textesDe('const d = "Rester";'), ["Rester"]);
    assert.deepEqual(bouclesDe("// requestAnimationFrame dans un commentaire\nconst x = 1;"), []);
    assert.deepEqual(bouclesDe("requestAnimationFrame(image);"), [String(BOUCLES[0])]);
    assert.deepEqual(bouclesDe("const id = setInterval(f, 10);"), [String(BOUCLES[1])]);
    assert.deepEqual(importsDe('import { x } from "three";\nimport type { Y } from "./salle3d-types.ts";\nconst m = import("./three/moteur.ts");'), [
      "three",
      "./salle3d-types.ts",
      "./three/moteur.ts",
    ]);
    assert.ok(["three", "./salle3d-types.ts", "../../../server/shared/salle3d-texts.ts", "./three/moteur.ts", "./slots-3d.ts"].every((spec) => IMPORTS_V0_INTERDITS.test(spec)));
    assert.equal(IMPORTS_V0_INTERDITS.test("../../../server/shared/fluidity.ts"), false);
  });

  it("useFluidite.ts et fluidite.ts : aucun texte affichable (les raisons sont traduites par la page)", () => {
    for (const fichier of ["useFluidite.ts", "fluidite.ts"]) assert.deepEqual(textesDe(lire(fichier)), [], fichier);
  });

  it("useFluidite.ts : aucune boucle, aucune minuterie, aucune demande d'image ; fluidite.ts : aucune minuterie répétée", () => {
    assert.deepEqual(bouclesDe(lire("useFluidite.ts")), []);
    assert.equal(/\bsetInterval\b/.test(lexique(lire("fluidite.ts")).code), false);
  });

  it("aucun import de three ni d'un fichier d'un autre paquet de V0 (D-3d-27) ; imports attendus seulement", () => {
    assert.deepEqual(importsDe(lire("fluidite.ts")), ["../../../server/shared/fluidity.ts"]);
    assert.deepEqual(importsDe(lire("useFluidite.ts")), ["react", "../../../server/shared/fluidity.ts", "./fluidite.ts"]);
    for (const fichier of ["useFluidite.ts", "fluidite.ts"]) {
      assert.deepEqual(importsDe(lire(fichier)).filter((spec) => IMPORTS_V0_INTERDITS.test(spec)), [], fichier);
    }
  });
});
