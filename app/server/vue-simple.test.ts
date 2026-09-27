// Tests L28c, vocabulaire du mode Simple d'une scène néon (spécification §5.9 l.1018-1024, §2.3 l.102-104 ; plan d'exécution it3,
// fiche L28c, D-3d-12, D-3d-20 ; décision de l'utilisateur n° 7) :
// - « Revoir » en mode Simple d'une racine de la Salle OMO (p1, deux délégations en même temps, marquée `salle`) DESSINE les
//   délégations : scène calculée en « avance » par modeSceneRevoir, puis renommée par vueSimple ;
// - aucun nom d'agent de la fixture, ni « agent », ni « orchestrateur » n'atteint l'écran (lignesTableau, libelleNoeud) ;
// - DISCRIMINANT : le même moment calculé directement en « simple » n'a qu'un nœud, donc la décision n° 7 est bien ce qui fait
//   la différence ;
// - une racine ordinaire en mode Simple garde le mode « simple » (différé = direct de la bande 2D) ;
// - P12 : les `faits` de chaque signe sont les mêmes avant et après le renommage.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { libelleNoeud, lignesTableau, nomAssistant } from "./shared/neon-band.ts";
import { moments, NEON_SECTEURS, type NeonScene, scene } from "./shared/neon-scene.ts";
import { libelleSecteur } from "./shared/neon-texts.ts";
import { TEXTES } from "./shared/revoir-texts.ts";
import { modeSceneRevoir, nomsSimples, vueSimple } from "./shared/vue-simple.ts";
import { DEMO_P1_CAPTURE, DEMO_P1_ROOT, DEMO_P1_SENT, demoFacts } from "./test-support/gen-demo.ts";

const FAITS = demoFacts(DEMO_P1_CAPTURE, DEMO_P1_ROOT, DEMO_P1_SENT);
const MOMENTS = moments(FAITS);

/** Noms Simples permis à l'écran : « Assistant principal » au centre, les libellés de secteur ailleurs (D-3d-20). */
const NOMS_PERMIS = new Set<string>([TEXTES.simple.assistantPrincipal, ...NEON_SECTEURS.map((secteur) => libelleSecteur(secteur))]);

/** Noms d'agent enregistrés dans la fixture : aucun ne doit atteindre l'écran en mode Simple pour une racine de la salle. */
const NOMS_FIXTURE = [
  ...new Set(
    FAITS.map((fait) => fait.data.agent)
      .filter((agent): agent is string => typeof agent === "string" && agent !== "")
      .concat(scene(FAITS, null, { zoom: 2, mode: "avance" }).noeuds.map((noeud) => noeud.agent ?? "").filter((nom) => nom !== "")),
  ),
];

/** Premier moment où la scène en « avance » montre au moins deux nœuds ET au moins un faisceau de consigne. */
function momentDeDelegation(): number {
  for (const t of MOMENTS) {
    const vue = scene(FAITS, t, { zoom: 2, mode: "avance" });
    if (vue.noeuds.length >= 2 && vue.faisceaux.some((faisceau) => faisceau.kind === "consigne")) return t;
  }
  throw new Error("aucun moment de p1 ne montre une délégation en cours");
}

/** Tous les indices de faits que la scène cite (P12), dans l'ordre de ses signes. */
function refsDeLaVue(vue: NeonScene): number[][] {
  return [
    ...vue.noeuds.map((n) => n.faits),
    ...vue.faisceaux.map((f) => f.faits),
    ...vue.attentes.map((a) => a.faits),
    ...vue.decisions.map((d) => d.faits),
    ...vue.impulsions.map((i) => i.faits),
    ...vue.origines.map((o) => o.faits),
  ];
}

const T_DELEGATION = momentDeDelegation();

describe("vue Simple d'une racine de la Salle OMO (D-3d-20, décision n° 7)", () => {
  it("la fixture p1 porte bien des noms d'agent, sinon la garde ne prouverait rien", () => {
    assert.ok(NOMS_FIXTURE.length >= 2, NOMS_FIXTURE.join(", "));
    for (const nom of NOMS_FIXTURE) assert.equal(NOMS_PERMIS.has(nom), false, nom);
  });

  it("mode de la scène : « avance » pour une racine de la salle, quel que soit le mode de l'utilisateur", () => {
    assert.equal(modeSceneRevoir({ salle: true, advanced: false }), "avance");
    assert.equal(modeSceneRevoir({ salle: true, advanced: true }), "avance");
  });

  it("racine de la salle en mode Simple : au moins deux assistants, un faisceau de consigne, et le vocabulaire Simple", () => {
    const brute = scene(FAITS, T_DELEGATION, { zoom: 2, mode: modeSceneRevoir({ salle: true, advanced: false }) });
    const vue = vueSimple(brute, nomsSimples(brute, true));

    assert.ok(vue.noeuds.length >= 2, `${vue.noeuds.length} nœuds`);
    assert.ok(
      vue.faisceaux.some((faisceau) => faisceau.kind === "consigne"),
      "aucun faisceau de consigne",
    );
    assert.equal(vue.mode, "simple");

    for (const noeud of vue.noeuds) assert.ok(noeud.agent !== null && NOMS_PERMIS.has(noeud.agent), `nom montré : ${noeud.agent}`);

    const montre = [...lignesTableau(vue).flatMap((ligne) => [ligne.nom, ligne.secteur ?? "", ligne.etat, ...ligne.signes]), ...vue.noeuds.map((noeud) => libelleNoeud(noeud))].join(" | ");
    for (const nom of NOMS_FIXTURE) assert.equal(montre.includes(nom), false, `${nom} montré : ${montre}`);
    assert.equal(/agent/i.test(montre), false, montre);
    assert.equal(/orchestrateur/i.test(montre), false, montre);
  });

  it("DISCRIMINANT : le même moment calculé en « simple » n'a qu'un seul nœud (la décision n° 7 fait la différence)", () => {
    const sansDecision = scene(FAITS, T_DELEGATION, { zoom: 2, mode: "simple" });
    assert.equal(sansDecision.noeuds.length, 1);
    assert.equal(
      sansDecision.faisceaux.some((faisceau) => faisceau.kind === "consigne"),
      false,
    );
    assert.ok(sansDecision.delegationsMasquees >= 1);
  });

  it("P12 : le renommage ne touche que les noms — positions, faisceaux, détail et faits sont recopiés tels quels", () => {
    const brute = scene(FAITS, T_DELEGATION, { zoom: 2, mode: "avance" });
    const vue = vueSimple(brute, nomsSimples(brute, true));
    assert.deepEqual(refsDeLaVue(vue), refsDeLaVue(brute));
    assert.deepEqual(
      vue.noeuds.map((n) => n.position),
      brute.noeuds.map((n) => n.position),
    );
    assert.deepEqual(vue.faisceaux, brute.faisceaux);
    assert.deepEqual(vue.attentes, brute.attentes);
    assert.deepEqual(vue.stations, brute.stations);
    assert.equal(vue.rootId, brute.rootId);
    assert.equal(vue.delegationsMasquees, brute.delegationsMasquees);
    assert.deepEqual(
      vue.noeuds.map((n) => ({ ...n, agent: null })),
      brute.noeuds.map((n) => ({ ...n, agent: null })),
    );
  });

  it("zoom 3 : le détail d'une délégation est recopié, et son assistant porte aussi un nom Simple", () => {
    const enfant = scene(FAITS, T_DELEGATION, { zoom: 2, mode: "avance" }).noeuds.find((n) => n.role === "delegation");
    assert.ok(enfant !== undefined);
    const brute = scene(FAITS, T_DELEGATION, { zoom: 3, mode: "avance", focus: enfant.sessionId });
    const vue = vueSimple(brute, nomsSimples(brute, true));
    assert.deepEqual(vue.detail, brute.detail);
    const montre = vue.noeuds.find((n) => n.sessionId === enfant.sessionId);
    assert.ok(montre !== undefined);
    assert.equal(nomAssistant(montre), libelleSecteur(enfant.secteur ?? "autres"));
  });
});

describe("vue Simple hors de la Salle OMO", () => {
  it("racine ordinaire en mode Simple : mode « simple » (différé = direct de la bande)", () => {
    assert.equal(modeSceneRevoir({ salle: false, advanced: false }), "simple");
    assert.equal(modeSceneRevoir({ salle: false, advanced: true }), "avance");
  });

  it("aucun renommage hors de la salle : les noms d'assistant du cockpit restent ceux de la bande", () => {
    const brute = scene(FAITS, T_DELEGATION, { zoom: 2, mode: "avance" });
    assert.equal(nomsSimples(brute, false).size, 0);
    const vue = vueSimple(brute, nomsSimples(brute, false));
    assert.equal(vue.mode, "simple");
    assert.deepEqual(
      vue.noeuds.map((n) => n.agent),
      brute.noeuds.map((n) => n.agent),
    );
  });

  it("un nœud absent de la carte des noms garde le sien", () => {
    const brute = scene(FAITS, T_DELEGATION, { zoom: 2, mode: "avance" });
    const partielle = new Map([[brute.noeuds[0]?.sessionId ?? "", TEXTES.simple.assistantPrincipal]]);
    const vue = vueSimple(brute, partielle);
    assert.equal(vue.noeuds[0]?.agent, TEXTES.simple.assistantPrincipal);
    assert.equal(vue.noeuds[1]?.agent, brute.noeuds[1]?.agent);
  });
});
