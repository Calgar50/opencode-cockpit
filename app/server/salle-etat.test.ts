// État de la page « Salle de contrôle » (plan d'exécution it3, fiche L31b ; spécification §5.8 l.992-1009, §5.5 l.917-924 ;
// D-3d-15, D-3d-25, D-3d-28 ; mesures EXEC/mesures/MX-3D.md §9.1 et §9.3), sous Node : le module est pur.
// - adresses des trois zooms et navigation ;
// - échec 3D pendant un zoom 2 → verdict 2D et clé de ZoomConversation INCHANGÉE (la position du lecteur survit) ;
// - [Réessayer] remet la préférence du poste à `auto` ; la bascule automatique (« sonde-lente », « saccades ») n'écrit JAMAIS de
//   préférence : aucune transition automatique ne demande d'action au contrôle de fluidité, et le contrôle lui-même n'écrit rien
//   (contrôle croisé sur le vrai contrôleur de L30, avec des doublures) ;
// - `pret()` n'est pas lancé page cachée et `Scene3d` n'est pas monté sans verdict 3D (MX-3D §9.1 et §9.3), gardes lues aussi
//   dans SalleControlePage.tsx : la page ne monte la scène et ne remet la poignée que derrière ces deux fonctions.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import { creerSurveillance } from "../web/pages/salle-controle/fluidite.ts";
import {
  appartenanceRacine,
  cleZoom,
  doitMonterScene3d,
  echec3d,
  type EtatSalle,
  etatInitial,
  lireAdresse,
  naviguer,
  passer2d,
  peutRemettrePoignee,
  PREFERENCE_ECRITE,
  reessayer,
  rester3d,
  salleDeLaRacine,
  SECTION_SALLE,
  surveillance,
  verdictSonde,
  type VueTerritoires,
} from "../web/pages/salle-controle/salle-etat.ts";
import { creerControleFluidite } from "../web/pages/salle-controle/useFluidite.ts";
import { type CapacitesNavigateur, type FluidityReason, type PreferenceChoix, preferenceAuto } from "./shared/fluidity.ts";
import type { FluidityVerdict } from "./shared/salle3d-types.ts";

const TROIS_D: FluidityVerdict = { mode: "3d" };
const routeZoom = (...segments: string[]) => [SECTION_SALLE, ...segments];

const ouvert = (route: readonly string[], verdict: FluidityVerdict = TROIS_D): EtatSalle => etatInitial(route, verdict);

// --- Adresses (D-3d-15) ----------------------------------------------------------------------------------------------------------

describe("salle-etat : adresses des trois zooms", () => {
  it("#/salle-controle, /<racine> et /<racine>/<session>", () => {
    assert.deepEqual(lireAdresse(routeZoom()), { zoom: 1, rootId: null, sessionId: null });
    assert.deepEqual(lireAdresse(routeZoom("ses_root")), { zoom: 2, rootId: "ses_root", sessionId: null });
    assert.deepEqual(lireAdresse(routeZoom("ses_root", "ses_fils")), { zoom: 3, rootId: "ses_root", sessionId: "ses_fils" });
  });

  it("adresse d'une autre page, ou segment qui n'est pas un identifiant : zoom 1, jamais une racine inventée", () => {
    assert.deepEqual(lireAdresse(["archives", "ses_root"]), { zoom: 1, rootId: null, sessionId: null });
    assert.deepEqual(lireAdresse([]), { zoom: 1, rootId: null, sessionId: null });
    assert.deepEqual(lireAdresse(routeZoom("../secret")), { zoom: 1, rootId: null, sessionId: null });
    // Session illisible : la conversation reste montrée au zoom 2, sans session détaillée.
    assert.deepEqual(lireAdresse(routeZoom("ses_root", "a b")), { zoom: 2, rootId: "ses_root", sessionId: null });
  });

  it("navigation du zoom 3 vers le zoom 1 : racine et session oubliées, verdict et message gardés", () => {
    const zoom3 = { ...ouvert(routeZoom("ses_root", "ses_fils"), { mode: "2d", raison: "rendu-logiciel" }) };
    const apres = naviguer(zoom3, routeZoom());
    assert.equal(apres.action, null);
    assert.deepEqual(apres.etat, { ...zoom3, zoom: 1, rootId: null, sessionId: null });
    assert.deepEqual(apres.etat.message, { genre: "fluidite", raison: "rendu-logiciel" });
    // Et le retour au zoom 2 par le fil d'Ariane.
    assert.equal(naviguer(apres.etat, routeZoom("ses_root")).etat.zoom, 2);
  });
});

// --- Position du lecteur (§5.8 l.1007) --------------------------------------------------------------------------------------------

describe("salle-etat : la position du lecteur survit au passage en 2D", () => {
  it("échec 3D pendant un zoom 2 : verdict 2D, message de la perte, clé de ZoomConversation INCHANGÉE", () => {
    const zoom2 = ouvert(routeZoom("ses_root"));
    const avant = cleZoom(zoom2);
    const apres = echec3d(zoom2, "contexte-perdu");
    assert.equal(apres.action, null, "aucune action de fluidité : rien n'est gardé sur le poste");
    assert.deepEqual(apres.etat.verdict, { mode: "2d", raison: "webgl-absent" });
    assert.deepEqual(apres.etat.message, { genre: "contexte-perdu" });
    assert.equal(doitMonterScene3d(apres.etat), false);
    assert.equal(cleZoom(apres.etat), avant, "la clé ne dépend pas du verdict");
  });

  it("contexte refusé à la création : 2D avec la phrase du refus (webgl-absent)", () => {
    const apres = echec3d(ouvert(routeZoom("ses_root")), "contexte-refuse");
    assert.deepEqual(apres.etat.message, { genre: "fluidite", raison: "webgl-absent" });
    assert.deepEqual(apres.etat.verdict, { mode: "2d", raison: "webgl-absent" });
  });

  it("la clé ne dépend ni du verdict, ni du zoom, ni de la session : une conversation, un seul montage", () => {
    const zoom2 = ouvert(routeZoom("ses_root"));
    const zoom3 = naviguer(zoom2, routeZoom("ses_root", "ses_fils")).etat;
    const en2d = verdictSonde(zoom3, { mode: "2d", raison: "saccades" }).etat;
    assert.equal(cleZoom(zoom3), cleZoom(zoom2));
    assert.equal(cleZoom(en2d), cleZoom(zoom2));
    // DISCRIMINANT : une autre conversation a bien une autre clé.
    assert.notEqual(cleZoom(naviguer(zoom2, routeZoom("ses_autre")).etat), cleZoom(zoom2));
  });
});

// --- Gardes de MX-3D (§9.1 et §9.3) ------------------------------------------------------------------------------------------------

describe("salle-etat : aucune scène 3D sans verdict 3D, aucune poignée page cachée", () => {
  const raisons: FluidityReason[] = ["accessibilite", "webgl-absent", "rendu-logiciel", "sonde-lente", "saccades", "preference-2d"];

  it("Scene3d n'est montée qu'après un verdict 3D de capacites() (aucun WebGLRenderer sinon)", () => {
    assert.equal(doitMonterScene3d(ouvert(routeZoom(), TROIS_D)), true);
    for (const raison of raisons) assert.equal(doitMonterScene3d(ouvert(routeZoom(), { mode: "2d", raison })), false, raison);
  });

  it("pret() n'est pas lancé page cachée, ni sans verdict 3D", () => {
    const en3d = ouvert(routeZoom(), TROIS_D);
    assert.equal(peutRemettrePoignee(en3d, true), true);
    assert.equal(peutRemettrePoignee(en3d, false), false, "onglet caché : aucune image, donc aucune sonde lancée");
    for (const raison of raisons) assert.equal(peutRemettrePoignee(ouvert(routeZoom(), { mode: "2d", raison }), true), false, raison);
  });
});

// --- Appartenance d'une racine (D-3d-14, §5.9 l.1018-1024) ----------------------------------------------------------------------

const conv = (...rootIds: string[]) => ({ conversations: rootIds.map((rootId) => ({ rootId })) });

/** Réponse des territoires : la racine « ses_ordinaire » dans un projet, « ses_salle » dans l'enceinte, « ses_absente » nulle part. */
const VUE: VueTerritoires = { projets: [conv("ses_ordinaire")], salle: { projets: [conv("ses_salle")] } };

describe("salle-etat : l'appartenance d'une racine n'est jamais déduite d'une absence (D-3d-14)", () => {
  it("appartenanceRacine : projet, enceinte, ou « inconnue » — réponse absente, racine absente, enceinte nulle", () => {
    assert.equal(appartenanceRacine(VUE, "ses_ordinaire"), "projets");
    assert.equal(appartenanceRacine(VUE, "ses_salle"), "salle");
    assert.equal(appartenanceRacine(VUE, "ses_absente"), "inconnue", "hors des 24 h, du plafond de 200, ou écartée par le filtre Simple");
    assert.equal(appartenanceRacine(null, "ses_ordinaire"), "inconnue", "aucune lecture aboutie : rien n'est prouvé");
    assert.equal(appartenanceRacine({ projets: [], salle: null }, "ses_salle"), "inconnue", "aucune enceinte : toujours pas une preuve");
    assert.equal(appartenanceRacine(VUE, null), "inconnue");
  });

  it("salleDeLaRacine : prouvée par la liste, l'instance n'est même pas demandée", () => {
    for (const advanced of [false, true]) {
      assert.equal(salleDeLaRacine("projets", null, advanced), false, `projets, avancé ${advanced}`);
      assert.equal(salleDeLaRacine("salle", null, advanced), true, `salle, avancé ${advanced}`);
    }
  });

  it("salleDeLaRacine : appartenance inconnue — en Simple, rien n'est monté tant que l'instance n'est pas lue", () => {
    // Le défaut corrigé : « inconnue » valait « ce n'est pas la salle », et le zoom en direct partait lire /facts en mode Simple.
    assert.equal(salleDeLaRacine("inconnue", null, false), null, "Simple : rien de monté tant que l'instance n'est pas lue");
    assert.equal(salleDeLaRacine("inconnue", "omo", false), true, "instance lue : c'est la salle, donc « Revoir » seulement");
    assert.equal(salleDeLaRacine("inconnue", "principale", false), false, "instance lue : conversation ordinaire, le direct est servi");
    assert.equal(salleDeLaRacine("inconnue", null, true), false, "Avancé : le direct est servi de toute façon, aucune lecture de plus");
  });
});

// --- Préférence du poste (D-3d-25) ---------------------------------------------------------------------------------------------------

describe("salle-etat : seul un choix de la personne est gardé sur le poste", () => {
  it("[Passer en 2D], [Rester en 3D] et [Réessayer] passent une action ; [Réessayer] remet auto", () => {
    const en3d = { ...ouvert(routeZoom()), proposition: true };
    assert.deepEqual(passer2d(en3d), { etat: { ...en3d, proposition: false }, action: "passer2d" });
    assert.deepEqual(rester3d(en3d), { etat: { ...en3d, proposition: false }, action: "rester3d" });
    assert.deepEqual(reessayer(en3d), { etat: { ...en3d, proposition: false }, action: "reessayer" });
    assert.equal(PREFERENCE_ECRITE.reessayer, "auto");
    assert.equal(PREFERENCE_ECRITE.passer2d, "2d");
    assert.equal(PREFERENCE_ECRITE.rester3d, null);
  });

  it("la bascule automatique (sonde-lente, saccades) et l'échec 3D ne demandent AUCUNE action, donc n'écrivent rien", () => {
    const en3d = ouvert(routeZoom("ses_root"));
    for (const raison of ["sonde-lente", "saccades"] as const) {
      const apres = verdictSonde(en3d, { mode: "2d", raison });
      assert.equal(apres.action, null, raison);
      assert.deepEqual(apres.etat.message, { genre: "fluidite", raison });
    }
    assert.equal(surveillance(en3d, true).action, null);
    assert.equal(surveillance(en3d, true).etat.proposition, true);
    // Proposition retirée dès que la vue passe en 2D (les commandes de la proposition disparaissent avec elle).
    assert.equal(verdictSonde(surveillance(en3d, true).etat, { mode: "2d", raison: "saccades" }).etat.proposition, false);
    assert.equal(surveillance(echec3d(en3d, "contexte-perdu").etat, true).etat.proposition, false);
  });

  it("CROISEMENT (L30) : le contrôle de fluidité n'écrit rien sur une sonde lente ni sur une bascule à 10 s", async () => {
    const materiel: CapacitesNavigateur = { mouvementReduit: false, couleursForcees: false, webgl2: true, contexteRefuse: false, moteur: "Radeon" };
    const banc = () => {
      const ecritures: Array<[PreferenceChoix, FluidityReason | null]> = [];
      const sondes: Array<(ms: number[]) => void> = [];
      let t = 1_000;
      const controle = creerControleFluidite({
        capacites: () => materiel,
        preference: () => preferenceAuto(),
        enregistrer: (choix, raison) => void ecritures.push([choix, raison]),
        sonder: () => new Promise<number[]>((resoudre) => void sondes.push(resoudre)),
        surveillance: () =>
          creerSurveillance(() => {
            t += 40;
            return t;
          }),
        marquer: () => {},
      });
      controle.ouvrir();
      controle.pret({ renderFrame: () => {} });
      return { controle, ecritures, sondes };
    };

    const lente = banc();
    lente.sondes[0]?.(Array.from({ length: 90 }, () => 40));
    await new Promise<void>((resoudre) => void setImmediate(resoudre));
    assert.deepEqual(lente.controle.etat().verdict, { mode: "2d", raison: "sonde-lente" });
    assert.deepEqual(lente.ecritures, [], "sonde lente : préférence du poste inchangée");

    const saccade = banc();
    saccade.sondes[0]?.(Array.from({ length: 90 }, () => 12));
    await new Promise<void>((resoudre) => void setImmediate(resoudre));
    for (let i = 0; i < 400; i += 1) saccade.controle.image(40, true);
    assert.deepEqual(saccade.controle.etat().verdict, { mode: "2d", raison: "saccades" });
    assert.deepEqual(saccade.ecritures, [], "bascule automatique : préférence du poste inchangée");
    // DISCRIMINANT : le choix de la personne, lui, est bien gardé.
    const choisi = banc();
    choisi.sondes[0]?.(Array.from({ length: 90 }, () => 12));
    await new Promise<void>((resoudre) => void setImmediate(resoudre));
    choisi.controle.passer2d();
    assert.deepEqual(choisi.ecritures, [["2d", "preference-2d"]]);
  });
});

// --- Gardes lues dans la page ---------------------------------------------------------------------------------------------------

/** Source sans commentaires (les chaînes du fichier n'ont ni « // » ni « /* »). */
function sansCommentaires(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/^[^\n]*?\/\/[^\n]*$/gm, (ligne) => ligne.slice(0, ligne.indexOf("//")));
}

const PAGE = sansCommentaires(fs.readFileSync(path.join(import.meta.dirname, "..", "web", "pages", "salle-controle", "SalleControlePage.tsx"), "utf8"));

describe("SalleControlePage : les gardes de MX-3D et du clavier sont bien celles du module", () => {
  it("la scène 3D n'est écrite que derrière doitMonterScene3d", () => {
    assert.match(PAGE, /const vue3d = doitMonterScene3d\(etat\);/);
    const montages = [...PAGE.matchAll(/<Scene3d[\s/>]/g)];
    assert.equal(montages.length, 1);
    const avant = PAGE.slice(Math.max((montages[0]?.index ?? 0) - 80, 0), montages[0]?.index ?? 0);
    assert.match(avant, /vue3d \?/);
    assert.match(PAGE, /vue3d=\{vue3d\}/, "ZoomConversation reçoit le même verdict");
  });

  it("l'appartenance à la salle vient de salleDeLaRacine, jamais d'un repli sur « ce n'est pas la salle » (D-3d-14)", () => {
    assert.match(PAGE, /const appartenance = appartenanceRacine\(reponse, etat\.rootId\);/);
    assert.match(PAGE, /const salle = salleDeLaRacine\(appartenance, instanceRacine, advanced\);/);
    assert.match(PAGE, /salle=\{salle\}/, "ZoomConversation reçoit l'appartenance prouvée");
    assert.equal(/salle=\{[^}]*\?\?\s*false\}/.test(PAGE), false, "aucune absence ne vaut « ce n'est pas la salle »");
    // Appartenance non prouvée (null) : rien n'est monté, donc aucune lecture de /facts ni de message pour une racine de la salle.
    assert.match(PAGE, /etat\.rootId === null \|\| salle === null \? null : \(/);
    // La lecture décisive est demandée seulement quand la liste ne prouve rien ET que le mode Simple ferme la salle.
    assert.match(PAGE, /const aProuver = etat\.zoom >= 2 && !advanced && appartenance === "inconnue";/);
    assert.match(PAGE, /useInstanceRacine\(aProuver \? etat\.rootId : null\)/);
    const lectures = [...PAGE.matchAll(/salle3dApi\.(\w+)\(/g)].map((trouve) => trouve[1]);
    assert.deepEqual(lectures, ["revoirEtat"], "la page ne fait que cette lecture seule, jamais une requête à opencode");
  });

  it("la poignée n'est remise qu'à travers peutRemettrePoignee", () => {
    const appels = [...PAGE.matchAll(/\bpret\(/g)];
    assert.equal(appels.length, 1);
    assert.match(PAGE.slice(appels[0]?.index ?? 0, (appels[0]?.index ?? 0) + 120), /peutRemettrePoignee\(etat, visible\)/);
    assert.match(PAGE, /visibilitychange/, "la page suit la visibilité");
  });

  it("ZoomConversation est monté avec cleZoom, et la page ne pose aucune touche ni aucun focus global", () => {
    assert.match(PAGE, /key=\{cleZoom\(etat\)\}/);
    assert.equal(/addEventListener\(\s*["'`]key/.test(PAGE), false, "aucun raccourci global (§5.5 l.917)");
    assert.equal(/\bautoFocus\b/.test(PAGE), false, "le focus n'est jamais volé au montage");
    // Un seul endroit déplace le focus : la grille, sur une touche ou un geste de la personne.
    assert.equal([...PAGE.matchAll(/\.focus\(\)/g)].length, 1);
    assert.match(PAGE, /useAnnouncer\(ui\.activityAnnouncements\)/, "une seule région d'annonces (D-3d-29)");
  });
});
