// Démonstrations enregistrées de l'itération 3 (spécification §5.9 l.1013-1017, §6 l.1064, JP-9 ; plan d'exécution it3, fiche
// L34, D-3d-20, D-3d-26, D-3d-30 ; décision U1) :
// - les deux fixtures valent exactement la sortie de test-support/gen-demos-it3.ts, et une régénération les rend à l'identique ;
// - chaque fait passe la garde des faits (aucun texte de message dans `data`), et les seuls faits écrits par le cockpit
//   lui-même portent `data.source = "service"` (D-3d-26) ;
// - analyse de secrets des deux fixtures (fixtures/README.md, « Nettoyage ») ;
// - légendes conditionnelles attendues (« neuf » sur p1 et sur les deux délégations de l'arrêt au plafond) ;
// - mode Simple (D-3d-20) : la vue de p1 montre au moins deux assistants et un faisceau de consigne, sans aucun nom
//   d'assistant enregistré, ni « agent », ni « orchestrateur » ; calculée en mode Simple, elle n'en montrerait qu'un ;
// - phrase demoAvance (U1) : les démonstrations qui dessinent une délégation, en mode Simple seulement ;
// - « différé = direct » sur les deux suites ;
// - DemoPlayer.tsx : ni fetch, ni api, ni oc, ni setInterval, ni requestAnimationFrame, et LegendeBulle sans onVoirConsigne.
// Chaque garde a son contrôle discriminant (fixture modifiée, secret planté, condition mutée).
// L'e2e « zéro requête vers opencode pendant une démonstration » est joué par L35 (navigateur).
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import { factProblem } from "./shared/activity-facts.ts";
import type { ActivityFact } from "./shared/activity-types.ts";
import { legendesAuMoment } from "./shared/legendes.ts";
import { libelleNoeud, lignesTableau } from "./shared/neon-band.ts";
import { moments, NEON_SECTEURS, type NeonSceneOptions, scene, visibleCount } from "./shared/neon-scene.ts";
import { libelleSecteur } from "./shared/neon-texts.ts";
import { TEXTES } from "./shared/revoir-texts.ts";
import { nomsSimples, vueSimple } from "./shared/vue-simple.ts";
import { DEMO_P1_FILE } from "./test-support/gen-demo.ts";
import { type DemoIt3Cle, type DemoIt3File, DEMOS_IT3, demoJson, fichierDemo, genererDemo } from "./test-support/gen-demos-it3.ts";
import { leaks, localUsername } from "./test-support/helpers.ts";

const APP_DIR = path.join(import.meta.dirname, "..");
const DEMO_PLAYER = path.join(APP_DIR, "web", "pages", "chat", "activity", "DemoPlayer.tsx");
const GENERATEUR = path.join(APP_DIR, "server", "test-support", "gen-demos-it3.ts");

/** Scène du lecteur : carte au zoom 2, toujours calculée en mode Avancé (D-3d-20), comme DemoPlayer.tsx. */
const AVANCE: Readonly<NeonSceneOptions> = Object.freeze({ zoom: 2, mode: "avance" });

const faitsDuFichier = (fichier: string): ActivityFact[] => (JSON.parse(fs.readFileSync(fichier, "utf8")) as { faits: ActivityFact[] }).faits;

const TEXTE = new Map<DemoIt3Cle, string>(DEMOS_IT3.map((cle) => [cle, fs.readFileSync(fichierDemo(cle), "utf8")]));
const FAITS = new Map<DemoIt3Cle, ActivityFact[]>(DEMOS_IT3.map((cle) => [cle, faitsDuFichier(fichierDemo(cle))]));
const FAITS_P1 = faitsDuFichier(DEMO_P1_FILE);

/** Suites jouées une fois sur le faux opencode au chargement du fichier de test ; aucune IA appelée, aucun appel facturé. */
const GENERES = new Map<DemoIt3Cle, DemoIt3File>();
for (const cle of DEMOS_IT3) GENERES.set(cle, await genererDemo(cle));

const genere = (cle: DemoIt3Cle): DemoIt3File => GENERES.get(cle) as DemoIt3File;
const texteDe = (cle: DemoIt3Cle): string => TEXTE.get(cle) as string;
const faitsDe = (cle: DemoIt3Cle): ActivityFact[] => FAITS.get(cle) as ActivityFact[];

/**
 * Source sans commentaires : un mot cité dans un commentaire n'est pas du code. Les commentaires de LIGNE sont retirés d'abord :
 * un « /* » écrit dans une phrase ouvrirait sinon un bloc qui avalerait le code jusqu'au commentaire suivant.
 */
const sansCommentaires = (source: string): string => source.replace(/^[ \t]*\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");

/** Démonstration qui dessine une délégation : un assistant au moins n'est pas celui de la conversation (règle de DemoPlayer.tsx). */
const dessineUneDelegation = (faits: readonly ActivityFact[]): boolean => scene(faits, null, AVANCE).noeuds.some((noeud) => noeud.role !== "conversation");

// --- Fichiers générés -----------------------------------------------------------------------------------------------------------

describe("démonstrations it3 : fixtures = sortie du générateur (D-3d-26)", () => {
  for (const cle of DEMOS_IT3) {
    it(`${cle} : le fichier est exactement la sortie de gen-demos-it3.ts ; un fait modifié ou retiré est vu`, () => {
      const attendu = demoJson(genere(cle));
      assert.equal(texteDe(cle), attendu);
      const lignes = texteDe(cle).split("\n");
      const premier = lignes.findIndex((ligne) => ligne.includes('"kind":"statut"'));
      assert.ok(premier > 0);
      assert.notEqual(lignes.filter((_, i) => i !== premier).join("\n"), attendu);
      assert.notEqual(texteDe(cle).replace('"etat":"repos"', '"etat":"occupee"'), attendu);
    });
  }

  it("la régénération rend le même fichier, à l'octet : identifiants et heures fixes", async () => {
    for (const cle of DEMOS_IT3) {
      const seconde = await genererDemo(cle);
      assert.equal(demoJson(seconde), demoJson(genere(cle)), cle);
      assert.deepEqual(seconde.faits, genere(cle).faits, cle);
    }
  });

  it("aucune heure ni aucun identifiant du poste : heures croissantes posées sur DEBUT_MS, écarts sous le seuil de raccourci", () => {
    for (const cle of DEMOS_IT3) {
      const faits = faitsDe(cle);
      assert.ok(faits.length > 10, `${cle} : ${faits.length} faits`);
      const premier = faits[0]?.at ?? 0;
      assert.equal(premier, 1_789_200_000_000);
      for (let i = 1; i < faits.length; i++) {
        const ecart = (faits[i]?.at ?? 0) - (faits[i - 1]?.at ?? 0);
        assert.ok(ecart >= 0 && ecart <= 4_000, `${cle} : écart ${ecart} ms`);
      }
    }
  });
});

// --- Garde des faits et faits de service ------------------------------------------------------------------------------------------

describe("démonstrations it3 : aucun texte dans les faits, faits de service marqués (D-3d-26)", () => {
  for (const cle of DEMOS_IT3) {
    it(`${cle} : chaque fait passe la garde des faits ; un texte de message y est refusé`, () => {
      const faits = faitsDe(cle);
      for (const fait of faits) assert.equal(factProblem(fait), null, JSON.stringify(fait));
      const racines = new Set(faits.map((fait) => fait.rootId));
      assert.equal(racines.size, 1);
      // Contrôle discriminant : la garde refuse bien un texte de message glissé dans `data`.
      const premier = faits[0] as ActivityFact;
      assert.notEqual(factProblem({ ...premier, data: { ...premier.data, texte: "Lance les tests du projet." } }), null);
    });
  }

  it("« Attente de votre accord » : bash demandé, attente, accord « once », reprise ; aucun fait de service", () => {
    const faits = faitsDe("attente-accord");
    const attente = faits.find((fait) => fait.kind === "attente");
    assert.equal(attente?.data.permission, "bash");
    const reponse = faits.find((fait) => fait.kind === "reponse");
    assert.equal(reponse?.data.reponse, "once");
    assert.ok((attente?.at ?? 0) < (reponse?.at ?? 0), "l'attente précède la réponse");
    const outils = faits.filter((fait) => fait.kind === "statut" && fait.data.etat === "outil").map((fait) => fait.data.phase);
    assert.deepEqual(outils, ["en-cours", "termine"]);
    // Reprise : un second appel d'IA après l'outil, puis le repos.
    const appels = faits.filter((fait) => fait.kind === "statut" && fait.data.etat === "appel");
    assert.equal(appels.length, 2);
    assert.ok((appels[1]?.at ?? 0) > (reponse?.at ?? 0));
    assert.equal(faits.at(-1)?.data.etat, "repos");
    assert.deepEqual(
      faits.filter((fait) => fait.data.source === "service"),
      [],
    );
  });

  it("« Arrêt au plafond » : deux délégations, coût croissant, puis refus automatique et arrêt, marqués « service »", () => {
    const faits = faitsDe("arret-plafond");
    const consignes = faits.filter((fait) => fait.kind === "consigne" && fait.data.etat === "envoyee");
    assert.equal(consignes.length, 2);
    assert.equal(new Set(consignes.map((fait) => fait.data.enfant)).size, 2);
    for (const consigne of consignes) assert.equal(consigne.data.source, "ia", "une consigne vient d'un événement, jamais du service");
    const couts = faits.filter((fait) => fait.data.etat === "appel-fini").map((fait) => Number(fait.data.cout ?? 0));
    assert.ok(couts.length >= 4, `${couts.length} appels facturés`);
    assert.ok(Math.max(...couts.slice(0, 2)) < Math.max(...couts.slice(2)), `coûts : ${couts.join(", ")}`);
    const service = faits.filter((fait) => fait.data.source === "service");
    assert.deepEqual(
      service.map((fait) => fait.kind),
      ["decision", "statut"],
    );
    assert.deepEqual(service, faits.slice(-2), "les faits de service closent la suite");
    assert.equal(service[0]?.data.verdict, "refus-auto");
    assert.equal(service[0]?.data.regle, "plafond-cout");
    assert.equal(service[1]?.data.cause, "plafond");
    // Ce que la scène en fait : la conversation est arrêtée, les deux délégations restent terminées.
    const fin = scene(faits, null, AVANCE);
    const racine = fin.noeuds.find((noeud) => noeud.role === "conversation");
    assert.equal(racine?.etat, "arrete");
    assert.equal(fin.noeuds.filter((noeud) => noeud.role !== "conversation" && noeud.etat === "termine").length, 2);
  });
});

// --- Analyse de secrets ------------------------------------------------------------------------------------------------------------

describe("démonstrations it3 : analyse de secrets (fixtures/README.md, « Nettoyage »)", () => {
  for (const cle of DEMOS_IT3) {
    it(`${cle} : aucun motif de secret ; un motif planté est trouvé`, () => {
      const texte = texteDe(cle);
      assert.deepEqual(leaks(texte), []);
      assert.deepEqual(leaks(texte.replace('"etat":"repos"', '"etat":"dev@exemple.fr"')), ["adresse e-mail"]);
      assert.deepEqual(leaks(texte.replace('"etat":"repos"', '"etat":"ghp_abcdefghijklmnopqrstuvwx"')), ["jeton GitHub"]);
      const utilisateur = localUsername();
      if (utilisateur) assert.ok(leaks(texte.replace('"etat":"repos"', `"etat":"/home/${utilisateur}"`)).includes("nom d'utilisateur"));
    });
  }

  it("le générateur ne parle qu'au faux opencode : aucun client d'un vrai opencode importé", () => {
    const code = sansCommentaires(fs.readFileSync(GENERATEUR, "utf8"));
    const specifiers = [...code.matchAll(/^[ \t]*import[^;]*?from\s*["']([^"']+)["']/gm)].map((m) => m[1] ?? "");
    assert.ok(specifiers.includes("./fake-opencode.ts"));
    for (const specifier of specifiers.filter((s) => s !== "./fake-opencode.ts")) assert.doesNotMatch(specifier, /opencode|oc-|proxy|api/, specifier);
    assert.doesNotMatch(code, /https?:\/\//, "aucune adresse écrite en dur");
  });
});

// --- Légendes conditionnelles --------------------------------------------------------------------------------------------------

/** Clés des légendes émises à chaque moment d'une suite, dans l'ordre. */
function clesDesLegendes(faits: readonly ActivityFact[]): string[] {
  return moments(faits).flatMap((t) => legendesAuMoment(faits, t, { salle: false }).map((legende) => legende.cles.join("+")));
}

describe("démonstrations it3 : légendes conditionnelles (JP-5, L28a)", () => {
  it("« neuf » sur la délégation de p1 et sur les deux délégations de l'arrêt au plafond ; jamais « reprise »", () => {
    const p1 = clesDesLegendes(FAITS_P1);
    assert.ok(p1.includes("neuf"), p1.join(", "));
    assert.equal(p1.includes("reprise"), false, p1.join(", "));
    const plafond = clesDesLegendes(faitsDe("arret-plafond"));
    assert.deepEqual(plafond, ["neuf", "neuf"]);
    assert.deepEqual(clesDesLegendes(faitsDe("attente-accord")), [], "une suite sans délégation n'a aucune légende");
  });

  it("chaque légende de délégation porte le callId de sa consigne ; le lecteur n'en offre pourtant aucune consigne (D-3d-30)", () => {
    const faits = faitsDe("arret-plafond");
    const legendes = moments(faits).flatMap((t) => legendesAuMoment(faits, t, { salle: false }));
    assert.equal(legendes.length, 2);
    for (const legende of legendes) assert.match(String(legende.callId), /^call_/);
    const code = sansCommentaires(fs.readFileSync(DEMO_PLAYER, "utf8"));
    assert.match(code, /<LegendeBulle\b[^>]*\/>/, "le lecteur monte LegendeBulle");
    assert.doesNotMatch(code, /onVoirConsigne/, "une démonstration n'a aucune consigne gardée (D-3d-30)");
  });
});

// --- Mode Simple (D-3d-20) et phrase demoAvance (U1) --------------------------------------------------------------------------

describe("démonstrations it3 : mode Simple (D-3d-20, décision n° 7)", () => {
  it("p1 : au moins deux assistants et un faisceau de consigne, sans aucun nom d'assistant enregistré à l'écran", () => {
    const permis = new Set<string>([TEXTES.simple.assistantPrincipal, ...NEON_SECTEURS.map((secteur) => libelleSecteur(secteur))]);
    const nomsDeLaFixture = [...new Set(scene(FAITS_P1, null, AVANCE).noeuds.map((noeud) => noeud.agent ?? "").filter((nom) => nom !== ""))];
    assert.ok(nomsDeLaFixture.length >= 2, "la fixture doit porter des noms d'assistant, sinon la garde ne prouve rien");
    let trouvee = false;
    for (const t of moments(FAITS_P1)) {
      const brute = scene(FAITS_P1.slice(0, visibleCount(FAITS_P1, t)), null, AVANCE);
      if (brute.noeuds.length < 2 || !brute.faisceaux.some((faisceau) => faisceau.kind === "consigne")) continue;
      trouvee = true;
      const vue = vueSimple(brute, nomsSimples(brute, true));
      assert.equal(vue.mode, "simple");
      const montre = [...lignesTableau(vue).flatMap((ligne) => [ligne.nom, ligne.secteur ?? "", ligne.etat, ...ligne.signes]), ...vue.noeuds.map((noeud) => libelleNoeud(noeud))].join(" | ");
      for (const nom of nomsDeLaFixture) assert.equal(montre.includes(nom), false, `nom d'assistant montré : ${nom}`);
      assert.doesNotMatch(montre, /agent/i, montre);
      assert.doesNotMatch(montre, /orchestrateur/i, montre);
      for (const noeud of vue.noeuds) assert.ok(noeud.agent !== null && permis.has(noeud.agent), `nom montré : ${noeud.agent}`);
      // Contrôle discriminant : calculée en mode Simple, la même scène ne dessinerait qu'un assistant.
      assert.equal(scene(FAITS_P1.slice(0, visibleCount(FAITS_P1, t)), null, { zoom: 2, mode: "simple" }).noeuds.length, 1);
      break;
    }
    assert.ok(trouvee, "aucun moment de p1 ne montre deux assistants et une consigne");
  });

  it("phrase demoAvance : les démonstrations qui dessinent une délégation, en mode Simple SEULEMENT (U1)", () => {
    assert.equal(
      TEXTES.simple.demoAvance,
      "Démonstration enregistrée en mode Avancé : en mode Simple, l'IA ne délègue pas, elle continue seule.",
    );
    assert.equal(dessineUneDelegation(FAITS_P1), true);
    assert.equal(dessineUneDelegation(faitsDe("arret-plafond")), true);
    assert.equal(dessineUneDelegation(faitsDe("attente-accord")), false);
    const code = sansCommentaires(fs.readFileSync(DEMO_PLAYER, "utf8"));
    // La phrase est écartée en mode Avancé (advanced) et sans délégation (!delegue) ; `delegue` vient de la scène complète.
    assert.match(code, /\{advanced \|\| !delegue \? null : <p [^>]*>\{REVOIR\.simple\.demoAvance\}<\/p>\}/);
    assert.match(code, /noeuds\.some\(\(noeud\) => noeud\.role !== "conversation"\)/);
    assert.match(code, /const delegue = useMemo\(\(\) => dessineUneDelegation\(faits\), \[faits\]\);/);
    // Contrôles discriminants : une condition mutée n'est plus reconnue.
    assert.doesNotMatch(code.replace("advanced || !delegue", "!delegue"), /\{advanced \|\| !delegue \? null :/);
    assert.doesNotMatch(code.replace('noeud.role !== "conversation"', "true"), /noeuds\.some\(\(noeud\) => noeud\.role !== "conversation"\)/);
  });

  it("le lecteur calcule toujours la scène en mode Avancé, puis la renomme (D-3d-20)", () => {
    const code = sansCommentaires(fs.readFileSync(DEMO_PLAYER, "utf8"));
    assert.match(code, /Object\.freeze\(\{ zoom: 2, mode: "avance" \}\)/);
    assert.match(code, /return advanced \? brute : vueSimple\(brute, nomsSimples\(brute, true\)\);/);
    assert.doesNotMatch(code, /mode: "simple"/, "la scène n'est jamais calculée en mode Simple");
  });
});

// --- « Différé = direct » -----------------------------------------------------------------------------------------------------

describe("démonstrations it3 : « différé = direct » (P12)", () => {
  for (const cle of DEMOS_IT3) {
    it(`${cle} : à chaque moment, la scène du différé est celle du direct`, () => {
      const faits = faitsDe(cle);
      const tous = moments(faits);
      assert.ok(tous.length > 5, `${tous.length} moments`);
      for (const t of tous) {
        const differe = scene(faits, t, AVANCE);
        const direct = scene(faits.slice(0, visibleCount(faits, t)), null, AVANCE);
        assert.deepEqual(differe, direct, `moment ${t}`);
      }
    });
  }
});

// --- DemoPlayer.tsx : aucune requête, aucune boucle ---------------------------------------------------------------------------

describe("DemoPlayer : aucune requête ni boucle dans le fichier (§6 l.1064, L34)", () => {
  const INTERDITS: ReadonlyArray<[string, RegExp]> = [
    ["fetch", /\bfetch\s*\(/],
    ["api", /\bapi\b/],
    ["oc", /\boc\b/],
    ["setInterval", /\bsetInterval\b/],
    ["requestAnimationFrame", /\brequestAnimationFrame\b/],
    ["XMLHttpRequest", /\bXMLHttpRequest\b/],
    ["EventSource", /\bEventSource\b/],
    ["import dynamique", /\bimport\s*\(/],
  ];

  it("ni fetch, ni api, ni oc, ni setInterval, ni requestAnimationFrame", () => {
    const code = sansCommentaires(fs.readFileSync(DEMO_PLAYER, "utf8"));
    const trouves = INTERDITS.filter(([, motif]) => motif.test(code)).map(([nom]) => nom);
    assert.deepEqual(trouves, []);
  });

  it("contrôles discriminants : chaque mot interdit ajouté au fichier est vu", () => {
    const code = sansCommentaires(fs.readFileSync(DEMO_PLAYER, "utf8"));
    const ajouts: ReadonlyArray<[string, string]> = [
      ["fetch", 'const lire = () => fetch("/api/activite");'],
      ["api", "const lire = () => api.get();"],
      ["oc", 'const lire = () => oc.messages("ses_x");'],
      ["setInterval", "const minuteur = setInterval(suivant, 500);"],
      ["requestAnimationFrame", "requestAnimationFrame(pas);"],
      ["EventSource", 'const flux = new EventSource("/api/events");'],
      ["import dynamique", 'const charger = () => import("./NeonBand.tsx");'],
    ];
    for (const [nom, ajout] of ajouts) {
      const mute = `${code}\n${ajout}`;
      const trouves = INTERDITS.filter(([, motif]) => motif.test(mute)).map(([trouve]) => trouve);
      assert.ok(trouves.includes(nom), `${nom} non vu dans « ${ajout} »`);
    }
    // Un mot cité dans un commentaire n'est pas du code.
    assert.deepEqual(
      INTERDITS.filter(([, motif]) => motif.test(sansCommentaires(`${code}\n// fetch( et oc.messages()`))).map(([nom]) => nom),
      [],
    );
  });

  it("les trois démonstrations sont proposées, avec les libellés de revoir-texts.ts (T3d-b)", () => {
    const code = sansCommentaires(fs.readFileSync(DEMO_PLAYER, "utf8"));
    for (const cle of ["deuxEnMemeTemps", "attenteAccord", "arretPlafond", "choisir"]) assert.ok(code.includes(`T.demos.${cle}`), cle);
    // La séquence réelle de la Salle OMO reste derrière sa porte (L3s-b) : elle n'est pas proposée ici.
    assert.doesNotMatch(code, /salleReelle/);
    for (const fichier of ["./demo-p1.json", "./demos/arret-plafond.json", "./demos/attente-accord.json"]) assert.ok(code.includes(`"${fichier}"`), fichier);
    // Lecteur complet de L28c : les minuteries restent dans useReplay.ts, jamais ici.
    assert.ok(code.includes("useReplay(faits, null)"));
    assert.match(code, /<ReplayBar\b/);
  });
});
