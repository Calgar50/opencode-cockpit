// Tests de l'annonce de la 1.1.0 et du numéro de version (L51 ; plan it5 §4.3, §8.7 L51, §13.2, D-5-16, D-5-24 ; plan it4 §2.6 et
// D-eq-13 ; conception C §9.14 corrigée au plan it5 §1.3 ; fiche de la migration du web §7 ; décisions U1 et A37).
// - annonce110 (module pur) : phrase d'équipe selon le mode et `ouvertesEnSimple` (equipesOuvertes de GF5, jamais redéfinie) ;
//   variante fermée à la lecture en échec ; phrase de l'itération 4 reprise à l'octet ; paragraphe « Internet » dans les deux
//   modes, phrase technique en mode Avancé seulement ; en mode Simple, ni webfetch, ni websearch, ni D11, ni « volume » ;
// - FirstRunRules.tsx (source) : UPGRADE_NOTICE_VERSION = "1.1.0", lecture de `ouvertesEnSimple` par GET /api/teams (client
//   api-teams.ts), annonce montrée une fois, dans le chat et dans Assistants, boutons [Voir la carte] et [Compris] ;
// - numéro de version : VERSION, app/package.json et la racine du lockfile valent 1.1.0, et rien d'autre de package.json ne bouge.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import type { UiMode } from "./shared/assistant-rules.ts";
import { annonce110 } from "./shared/annonce-110.ts";
import { annonceMiseAJour, TEXTES } from "./shared/construction-texts.ts";
import { phraseErreur } from "./shared/team-texts.ts";
import { EQUIPES_SIMPLE_OUVERTES } from "./wiring-eq.ts";

const APP_DIR = path.join(import.meta.dirname, "..");
const DEPOT = path.join(APP_DIR, "..");
const lire = (...parts: string[]): string => fs.readFileSync(path.join(DEPOT, ...parts), "utf8");
/** Source sans commentaires de ligne ni commentaires JSX : un texte cité en commentaire ne compte pas. */
const code = (source: string): string => source.replace(/\{\/\*[\s\S]*?\*\/\}/g, "").replace(/^\s*\/\/.*$/gm, "");

const TITRE_OUVERTES = "Nouveau : voir qui travaille, et faire travailler une équipe";
const TITRE_FERMEES = "Nouveau : voir qui travaille";
const PHRASE_EQUIPE = "Vous pouvez aussi lancer une équipe prête à l'emploi.";
/** Phrase de l'itération 4 (plan it4 §2.6), reprise à l'octet. */
const PHRASE_IT4 = "Les équipes arrivent bientôt en mode Simple. En mode Avancé, vous pouvez déjà les essayer.";
/** Fiche de la migration du web §7, « Annonce 1.1.0 », à la lettre. */
const WEB_SIMPLE =
  "L'assistant ne va plus sur Internet. C'était déjà impossible au travail ; cela évite surtout qu'une demande restée sans réponse bloque vos autres autorisations. Vos assistants n'ont pas été modifiés ; ceux qui pouvaient demander Internet sont signalés dans Paramètres › Sécurité.";
const WEB_AVANCE =
  "Dans la configuration d'opencode, seules les règles Internet ont changé (profils de la 1.0, et valeurs « ask » de webfetch et websearch, y compris dans agent.<nom>.permission) ; copie : <fichier>.avant-1.1.0. Les assistants créés dans le cockpit ne sont pas modifiés.";

const LECTURES: ReadonlyArray<boolean | null> = [true, false, null];

/** Toutes les chaînes d'une annonce, dans l'ordre d'affichage. */
const phrases = (mode: UiMode, ouvertesEnSimple: boolean | null): string[] => {
  const a = annonce110(mode, ouvertesEnSimple);
  return [a.titre, a.texte, ...a.internet, a.voirCarte, a.compris, a.region];
};

describe("annonce de la 1.1.0 (L51) : phrase d'équipe selon le mode et ouvertesEnSimple (U1, D-5-24)", () => {
  it("Avancé → titre et phrase d'équipe, quelle que soit la lecture de ouvertesEnSimple", () => {
    for (const lecture of LECTURES) {
      const a = annonce110("avance", lecture);
      assert.equal(a.titre, TITRE_OUVERTES, String(lecture));
      assert.ok(a.texte.includes(PHRASE_EQUIPE), String(lecture));
      assert.equal(a.texte.includes(PHRASE_IT4), false, String(lecture));
    }
  });

  it("Simple, ouvertesEnSimple faux → sans la phrase d'équipe, avec la phrase de l'itération 4 à l'octet", () => {
    const a = annonce110("simple", false);
    assert.equal(a.titre, TITRE_FERMEES);
    assert.equal(a.texte.includes(PHRASE_EQUIPE), false);
    assert.ok(a.texte.endsWith(PHRASE_IT4));
    assert.equal(PHRASE_IT4, phraseErreur("equipes-simple-fermees"), "même phrase que l'onglet Équipes fermé (itération 4)");
  });

  it("Simple, ouvertesEnSimple vrai (ouverture en une ligne) → avec la phrase d'équipe", () => {
    const a = annonce110("simple", true);
    assert.equal(a.titre, TITRE_OUVERTES);
    assert.ok(a.texte.includes(PHRASE_EQUIPE));
    assert.equal(a.texte.includes(PHRASE_IT4), false);
  });

  it("Simple, lecture absente ou en échec (null) → variante fermée : fermé en cas de doute", () => {
    assert.deepEqual(annonce110("simple", null), annonce110("simple", false));
    assert.equal(annonce110("simple", null).texte.includes(PHRASE_EQUIPE), false);
  });

  it("interrupteur livré : EQUIPES_SIMPLE_OUVERTES vaut false, donc l'annonce en Simple ne propose aucune équipe", () => {
    assert.equal(EQUIPES_SIMPLE_OUVERTES, false);
    const a = annonce110("simple", EQUIPES_SIMPLE_OUVERTES);
    assert.equal(a.titre, TITRE_FERMEES);
    for (const texte of phrases("simple", EQUIPES_SIMPLE_OUVERTES)) assert.equal(texte.includes("lancer une équipe"), false, texte);
  });

  it("assemblée par annonceMiseAJour (construction-texts.ts), jamais recomposée ; boutons [Voir la carte] [Compris]", () => {
    for (const [mode, lecture, ouvertes] of [
      ["avance", false, true],
      ["simple", true, true],
      ["simple", false, false],
      ["simple", null, false],
    ] as const) {
      const a = annonce110(mode, lecture);
      const attendu = annonceMiseAJour({ equipesOuvertes: ouvertes });
      assert.equal(a.titre, attendu.titre);
      assert.equal(a.texte, attendu.texte);
      assert.equal(a.voirCarte, "Voir la carte");
      assert.equal(a.compris, "Compris");
    }
  });
});

describe("annonce de la 1.1.0 (L51) : paragraphe « Internet » (fiche MW §7, A37)", () => {
  it("Simple : la phrase des deux modes, seule ; Avancé : la même, puis la phrase technique", () => {
    for (const lecture of LECTURES) {
      assert.deepEqual(annonce110("simple", lecture).internet, [WEB_SIMPLE]);
      assert.deepEqual(annonce110("avance", lecture).internet, [WEB_SIMPLE, WEB_AVANCE]);
    }
    assert.equal(TEXTES.partout.annonce.web, WEB_SIMPLE);
    assert.equal(TEXTES.avance.annonce.web, WEB_AVANCE);
  });

  it("Simple : ni webfetch, ni websearch, ni D11, ni « volume », dans aucune chaîne de l'annonce", () => {
    for (const lecture of LECTURES) {
      for (const texte of phrases("simple", lecture)) {
        assert.doesNotMatch(texte, /webfetch|websearch|\bD11\b|\bvolumes?\b/i, texte);
      }
    }
  });

  it("Simple : aucun mot interdit du mode Simple (spéc. §2.3) dans l'annonce", () => {
    const interdits = /(?<![\p{L}-])(?:agents?|sous-agents?|sessions?|prompts?|jetons?|tokens?|mod[èe]les?|workflows?|pipelines?|permissions?|parall[èe]les?|boucles?|itérations?|validée?s?|approuvée?s?)(?![\p{L}])/iu;
    for (const lecture of LECTURES) {
      for (const texte of phrases("simple", lecture)) assert.doesNotMatch(texte, interdits, texte);
    }
  });
});

describe("annonce-110.ts : module pur, equipesOuvertes reprise sans redéfinition (GF5)", () => {
  it("imports : assistant-rules (type), construction-texts et equipes-ouvertes ; aucune fonction equipesOuvertes ici ; ni horloge ni réseau", () => {
    const source = lire("app", "server", "shared", "annonce-110.ts");
    const imports = [...source.matchAll(/^import\s[^;]+;$/gm)].map((m) => m[0]);
    assert.deepEqual(imports, [
      'import type { UiMode } from "./assistant-rules.ts";',
      'import { annonceMiseAJour, TEXTES } from "./construction-texts.ts";',
      'import { equipesOuvertes } from "./equipes-ouvertes.ts";',
    ]);
    assert.doesNotMatch(source, /function\s+equipesOuvertes|const\s+equipesOuvertes/);
    assert.match(code(source), /annonceMiseAJour\(\{ equipesOuvertes: equipesOuvertes\(mode, ouvertesEnSimple\) \}\)/);
    assert.doesNotMatch(source, /Date\.now|new Date|fetch\(|process\.|require\(/);
  });
});

describe("FirstRunRules.tsx : l'annonce de la 1.1.0 affichée une fois, dans le chat et dans Assistants (L51)", () => {
  const source = code(lire("app", "web", "app", "FirstRunRules.tsx"));

  it("UPGRADE_NOTICE_VERSION vaut « 1.1.0 », et les deux boutons l'enregistrent dans ui.noticeSeen", () => {
    assert.match(source, /^export const UPGRADE_NOTICE_VERSION = "1\.1\.0";$/m);
    assert.match(source, /await saveUi\(\{ noticeSeen: UPGRADE_NOTICE_VERSION \}\);/);
    assert.match(source, /if \(voirCarte\) openAssistants\(\{ mode: "carte", element: null \}\);/, "[Voir la carte] ouvre la carte des assistants");
    assert.match(source, /onClick=\{\(\) => void dismiss\(true\)\}>\s*\{annonce\.voirCarte\}/);
    assert.match(source, /onClick=\{\(\) => void dismiss\(false\)\}>\s*\{annonce\.compris\}/);
    // La coquille ne montre l'annonce que tant que cette version n'a pas été vue (une fois).
    assert.match(code(lire("app", "web", "app", "App.tsx")), /ui\.noticeSeen !== UPGRADE_NOTICE_VERSION \? <UpgradeNotice \/> : null/);
  });

  it("chat et Assistants seulement ; ouvertesEnSimple lu par GET /api/teams en mode Simple, null tant qu'il n'a pas répondu", () => {
    assert.match(source, /const NOTICE_SECTIONS: ReadonlySet<string> = new Set\(\["chat", "assistants"\]\);/);
    assert.match(source, /const visible = NOTICE_SECTIONS\.has\(route\[0\] \?\? "chat"\);/);
    assert.match(source, /const ouvertesEnSimple = useOuvertesEnSimple\(visible && !advanced\);/);
    assert.match(source, /if \(!visible\) return null;/);
    assert.match(source, /const annonce = annonce110\(advanced \? "avance" : "simple", ouvertesEnSimple\);/);
    assert.doesNotMatch(source, /equipesOuvertes|EQUIPES_SIMPLE_OUVERTES/, "aucune règle recalculée dans le composant");
    const crochet = code(lire("app", "web", "pages", "chat", "activity", "useOuvertesEnSimple.ts"));
    assert.match(crochet, /import \{ teamsApi \} from "\.\.\/\.\.\/\.\.\/lib\/api-teams\.ts";/, "client api-teams.ts de l'itération 4");
    assert.match(crochet, /teamsApi\.list\(\)\.then\(/);
    assert.match(crochet, /if \(vivant\) setValeur\(null\);/, "lecture en échec → null → variante fermée");
    assert.match(code(lire("app", "web", "lib", "api-teams.ts")), /\/api\/teams/);
  });

  it("titre, texte et paragraphe « Internet » viennent d'annonce110 ; plus aucun texte de la notice de la 1.0", () => {
    assert.match(source, /\{annonce\.titre\}/);
    assert.match(source, /\{annonce\.texte\}/);
    assert.match(source, /annonce\.internet\.map\(/);
    assert.doesNotMatch(source, /Nouveau en 1\.0|Passer en mode Avancé/);
  });
});

describe("version 1.1.0 (L51, D-5-16)", () => {
  it("VERSION, app/package.json et la racine du lockfile valent 1.1.0", () => {
    assert.equal(lire("VERSION"), "1.1.0\n");
    const paquet = JSON.parse(lire("app", "package.json")) as { version: string };
    const verrou = JSON.parse(lire("app", "package-lock.json")) as { version: string; packages: Record<string, { version?: string }> };
    assert.equal(paquet.version, "1.1.0");
    assert.equal(verrou.version, "1.1.0");
    assert.equal(verrou.packages[""]?.version, "1.1.0");
  });
});
