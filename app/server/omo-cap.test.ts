// Plafond saisi de la Salle OMO (spécification §4.8.2 l.722, l.729-730 ; §3.6 l.280-287 ; §9.2.2 Q7 l.1374 ; §7.6 l.1155 ; G6
// l.1220 ; plan d'exécution it2bis-it2ter, fiche L22a) : T-L22-e (formes refusées, avec leur code), T-L22-f (borne plafondMaxUsd,
// égalité comprise), T-L22-g (garde-fou budgétaire), centimes exacts, proposition du champ (vide la première fois, dernier montant
// tel quel, marqué hors bornes), propriété « aucune valeur par défaut », T-L22-n (pureté).
// Les caractères invisibles (espaces insécables, tabulation, fin de ligne) sont construits par String.fromCharCode : aucun
// caractère de contrôle n'est écrit dans ce fichier.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import * as omoCap from "./shared/omo-cap.ts";
import { OMO_CAP_REFUSAL_CODES, type OmoCapRefusalCode, type PlafondBornes, proposePlafond, validatePlafond } from "./shared/omo-cap.ts";

const SOURCE = fs.readFileSync(path.join(import.meta.dirname, "shared", "omo-cap.ts"), "utf8");

const TAB = String.fromCharCode(9);
const LF = String.fromCharCode(10);
const NBSP = String.fromCharCode(0xa0);
const NNBSP = String.fromCharCode(0x202f);
const ZWSP = String.fromCharCode(0x200b);

const bornes = (over: Partial<PlafondBornes> = {}): PlafondBornes => ({ plafondMaxUsd: 50, guardRuns: "ok", ...over });

/** Montant écrit en dollars et centimes, avec le séparateur donné : 435 → « 4,35 ». */
const ecrit = (cents: number, sep: "," | "."): string => `${Math.trunc(cents / 100)}${sep}${String(cents % 100).padStart(2, "0")}`;

/**
 * Code d'un module sans commentaires, avec ses chaînes littérales mises à part et ses expressions régulières retirées : ce qui
 * reste porte les nombres écrits en dur.
 */
function codeNu(source: string): { code: string; chaines: string[] } {
  const sansCommentaires = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");
  const chaines: string[] = [];
  const sansChaines = sansCommentaires.replace(/"(?:\\.|[^"\\\n])*"|'(?:\\.|[^'\\\n])*'|`(?:\\.|[^`\\])*`/g, (s) => {
    chaines.push(s.slice(1, -1));
    return '""';
  });
  const code = sansChaines.replace(/(?<=[=(,:!&|?]\s*)\/(?:\\.|\[(?:\\.|[^\]\\\n])*\]|[^/\\\n[])+\/[dgimsuyv]*/g, "/re/");
  return { code, chaines };
}

/** Nombres littéraux d'un code nu, dans l'ordre : décimaux, hexadécimaux, octaux, binaires, avec exposant ou en BigInt. */
const nombresEcrits = (code: string): string[] =>
  code.match(/(?<![\w$.])(?:0[xob][0-9a-f_]+|\.[0-9][0-9_]*(?:e[+-]?[0-9]+)?|[0-9][0-9_]*(?:\.[0-9_]*)?(?:e[+-]?[0-9]+)?)n?(?![\w$])/gi) ?? [];

describe("validatePlafond : formes refusées (T-L22-e)", () => {
  const refus: ReadonlyArray<readonly [string, OmoCapRefusalCode]> = [
    // Champ vide, ou blanc seulement : rien n'a été saisi.
    ["", "plafond-vide"],
    [" ", "plafond-vide"],
    ["   ", "plafond-vide"],
    [TAB, "plafond-vide"],
    [LF, "plafond-vide"],
    [NBSP, "plafond-vide"],
    // Nul : strictement positif.
    ["0", "plafond-invalide"],
    ["0,00", "plafond-invalide"],
    ["0.00", "plafond-invalide"],
    ["0,0", "plafond-invalide"],
    ["0.0", "plafond-invalide"],
    // Signes.
    ["-1", "plafond-invalide"],
    ["-0", "plafond-invalide"],
    ["+1", "plafond-invalide"],
    ["+0.5", "plafond-invalide"],
    ["- 1", "plafond-invalide"],
    // Non numérique.
    ["abc", "plafond-invalide"],
    ["NaN", "plafond-invalide"],
    ["Infinity", "plafond-invalide"],
    ["0x10", "plafond-invalide"],
    ["0b11", "plafond-invalide"],
    ["1_000", "plafond-invalide"],
    ["$5", "plafond-invalide"],
    ["5$", "plafond-invalide"],
    ["5€", "plafond-invalide"],
    ["5 €", "plafond-invalide"],
    // Exposant.
    ["1e2", "plafond-invalide"],
    ["1E2", "plafond-invalide"],
    ["1e-2", "plafond-invalide"],
    ["1.5e1", "plafond-invalide"],
    // Plus de deux décimales, jamais arrondies (« 1,234 » peut se lire mille deux cent trente-quatre).
    ["1.234", "plafond-invalide"],
    ["1,234", "plafond-invalide"],
    ["0,001", "plafond-invalide"],
    ["2.500", "plafond-invalide"],
    // Espaces, en tête, en fin, entre les chiffres ; séparateurs de milliers.
    [" 1", "plafond-invalide"],
    ["1 ", "plafond-invalide"],
    [`1${LF}`, "plafond-invalide"],
    [`${TAB}1`, "plafond-invalide"],
    ["1 000", "plafond-invalide"],
    [`1${NBSP}000`, "plafond-invalide"],
    [`1${NNBSP}000`, "plafond-invalide"],
    [`${ZWSP}5`, "plafond-invalide"],
    ["1 , 50", "plafond-invalide"],
    ["1.000,50", "plafond-invalide"],
    ["1,000.50", "plafond-invalide"],
    // Séparateurs sans chiffre de part ou d'autre, doublés, répétés.
    [".5", "plafond-invalide"],
    [",50", "plafond-invalide"],
    ["5.", "plafond-invalide"],
    ["5,", "plafond-invalide"],
    ["1,,5", "plafond-invalide"],
    ["1.5.0", "plafond-invalide"],
    ["1,5,0", "plafond-invalide"],
    [".", "plafond-invalide"],
    // Zéro de tête.
    ["01", "plafond-invalide"],
    ["00,50", "plafond-invalide"],
    // Chiffres hors ASCII (pleine chasse, arabes-indiens).
    [String.fromCharCode(0xff15), "plafond-invalide"],
    [String.fromCharCode(0x0661), "plafond-invalide"],
  ];

  for (const [saisie, code] of refus) {
    it(`${JSON.stringify(saisie)} → ${code}`, () => {
      assert.deepEqual(validatePlafond(saisie, bornes()), { ok: false, code });
    });
  }

  it("une valeur qui n'est pas une chaîne (nombre JSON compris) est invalide, jamais lue comme un montant", () => {
    for (const saisie of [5, 2.5, 0, null, undefined, true, ["5"], { valeur: "5" }]) {
      assert.deepEqual(validatePlafond(saisie as never, bornes()), { ok: false, code: "plafond-invalide" }, String(saisie));
    }
  });

  it("formes acceptées : virgule ou point, zéro, une ou deux décimales", () => {
    const acceptes: ReadonlyArray<readonly [string, number]> = [
      ["1", 100],
      ["0,01", 1],
      ["0.01", 1],
      ["0,1", 10],
      ["0.1", 10],
      ["0,10", 10],
      ["0.10", 10],
      ["2,5", 250],
      ["2.50", 250],
      ["4,35", 435],
      ["1.15", 115],
      ["0.29", 29],
      ["10", 1000],
      ["49,99", 4999],
      ["50", 5000],
    ];
    for (const [saisie, cents] of acceptes) assert.deepEqual(validatePlafond(saisie, bornes()), { ok: true, cents }, saisie);
  });

  it("tous les codes de refus sont atteints, et ce sont exactement ceux de la fiche", () => {
    assert.deepEqual([...OMO_CAP_REFUSAL_CODES], ["plafond-vide", "plafond-invalide", "plafond-hors-bornes", "budget-mensuel"]);
    const vus = new Set([
      ...refus.map(([saisie]) => validatePlafond(saisie, bornes())),
      validatePlafond("51", bornes()),
      validatePlafond("1", bornes({ guardRuns: "refus" })),
    ].map((r) => (r.ok ? "ok" : r.code)));
    assert.deepEqual([...vus].sort(), [...OMO_CAP_REFUSAL_CODES].sort());
  });
});

describe("validatePlafond : centimes exacts, sans flottant", () => {
  it("chaque montant de 0,01 à 50,00, avec virgule et avec point, donne ses centimes à l'unité près", () => {
    for (let cents = 1; cents <= 5000; cents++) {
      for (const sep of [",", "."] as const) {
        assert.deepEqual(validatePlafond(ecrit(cents, sep), bornes()), { ok: true, cents }, ecrit(cents, sep));
      }
      if (cents % 10 === 0) {
        const courte = `${Math.trunc(cents / 100)},${(cents % 100) / 10}`;
        assert.deepEqual(validatePlafond(courte, bornes()), { ok: true, cents }, courte);
      }
    }
  });

  it("borne égale au montant : accepté ; borne d'un centime en dessous : hors bornes (0,29, 4,35, 5,10… compris)", () => {
    for (let cents = 1; cents <= 5000; cents++) {
      const saisie = ecrit(cents, ",");
      assert.deepEqual(validatePlafond(saisie, bornes({ plafondMaxUsd: cents / 100 })), { ok: true, cents }, `${saisie} = borne`);
      if (cents > 1) {
        assert.deepEqual(validatePlafond(saisie, bornes({ plafondMaxUsd: (cents - 1) / 100 })), { ok: false, code: "plafond-hors-bornes" }, `${saisie} > borne`);
      }
    }
  });
});

describe("validatePlafond : borne plafondMaxUsd (T-L22-f)", () => {
  it("au-dessus de plafondMaxUsd → plafond-hors-bornes ; égal → accepté", () => {
    const max = bornes({ plafondMaxUsd: 5 });
    assert.deepEqual(validatePlafond("5", max), { ok: true, cents: 500 });
    assert.deepEqual(validatePlafond("5,00", max), { ok: true, cents: 500 });
    assert.deepEqual(validatePlafond("5.0", max), { ok: true, cents: 500 });
    assert.deepEqual(validatePlafond("4,99", max), { ok: true, cents: 499 });
    for (const saisie of ["5,01", "5.01", "6", "50", "1000000"]) {
      assert.deepEqual(validatePlafond(saisie, max), { ok: false, code: "plafond-hors-bornes" }, saisie);
    }
  });

  it("montant immense : hors bornes, sans exception ni perte de précision qui l'accepterait", () => {
    for (const saisie of ["9".repeat(16), "9".repeat(400), `${"9".repeat(400)},99`, "90071992547409,92"]) {
      assert.deepEqual(validatePlafond(saisie, bornes()), { ok: false, code: "plafond-hors-bornes" }, saisie.slice(0, 20));
    }
  });

  it("borne dont la forme décimale n'est pas exacte en flottant : 5,1 et 0,29 comparées au centime", () => {
    assert.deepEqual(validatePlafond("5,10", bornes({ plafondMaxUsd: 5.1 })), { ok: true, cents: 510 });
    assert.deepEqual(validatePlafond("5,11", bornes({ plafondMaxUsd: 5.1 })), { ok: false, code: "plafond-hors-bornes" });
    assert.deepEqual(validatePlafond("0,29", bornes({ plafondMaxUsd: 0.29 })), { ok: true, cents: 29 });
    assert.deepEqual(validatePlafond("0,30", bornes({ plafondMaxUsd: 0.29 })), { ok: false, code: "plafond-hors-bornes" });
  });

  it("borne à plus de deux décimales (le réglage ne les borne pas) : tronquée au centime inférieur", () => {
    assert.deepEqual(validatePlafond("4,99", bornes({ plafondMaxUsd: 4.999 })), { ok: true, cents: 499 });
    assert.deepEqual(validatePlafond("5", bornes({ plafondMaxUsd: 4.999 })), { ok: false, code: "plafond-hors-bornes" });
    assert.deepEqual(validatePlafond("0,01", bornes({ plafondMaxUsd: 0.019 })), { ok: true, cents: 1 });
    assert.deepEqual(validatePlafond("0,02", bornes({ plafondMaxUsd: 0.019 })), { ok: false, code: "plafond-hors-bornes" });
    // Sous le centime : aucun montant saisissable n'y tient.
    assert.deepEqual(validatePlafond("0,01", bornes({ plafondMaxUsd: 0.005 })), { ok: false, code: "plafond-hors-bornes" });
  });

  it("borne absente ou inutilisable : tout montant refusé (fermé en cas de doute), jamais une borne de remplacement", () => {
    const inutilisables: unknown[] = [undefined, null, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, 0, -0, -5, "5", "50", [50], { usd: 50 }, true, 1e-7, 1e21, 2 ** 60];
    for (const plafondMaxUsd of inutilisables) {
      for (const saisie of ["0,01", "1", "5"]) {
        assert.deepEqual(validatePlafond(saisie, bornes({ plafondMaxUsd: plafondMaxUsd as never })), { ok: false, code: "plafond-hors-bornes" }, `${String(plafondMaxUsd)} / ${saisie}`);
      }
    }
  });

  it("ordre des refus : forme d'abord, puis borne, puis garde-fou", () => {
    const pire = bornes({ plafondMaxUsd: Number.NaN, guardRuns: "refus" });
    assert.deepEqual(validatePlafond("", pire), { ok: false, code: "plafond-vide" });
    assert.deepEqual(validatePlafond("abc", pire), { ok: false, code: "plafond-invalide" });
    assert.deepEqual(validatePlafond("0", pire), { ok: false, code: "plafond-invalide" });
    assert.deepEqual(validatePlafond("6", bornes({ plafondMaxUsd: 5, guardRuns: "refus" })), { ok: false, code: "plafond-hors-bornes" });
    assert.deepEqual(validatePlafond("5", bornes({ plafondMaxUsd: 5, guardRuns: "refus" })), { ok: false, code: "budget-mensuel" });
  });
});

describe("validatePlafond : garde-fou budgétaire (T-L22-g)", () => {
  it("guardRuns refuse → budget-mensuel, même pour un montant valide dans les bornes", () => {
    for (const saisie of ["0,01", "1", "2.50", "50"]) {
      assert.deepEqual(validatePlafond(saisie, bornes({ guardRuns: "refus" })), { ok: false, code: "budget-mensuel" }, saisie);
      assert.equal(validatePlafond(saisie, bornes({ guardRuns: "ok" })).ok, true, saisie);
    }
  });

  it("garde-fou absent ou inattendu : refus budget-mensuel, seul « ok » laisse passer", () => {
    for (const guardRuns of [undefined, null, "", "OK", "oui", true, 1, { ok: true }]) {
      assert.deepEqual(validatePlafond("1", bornes({ guardRuns: guardRuns as never })), { ok: false, code: "budget-mensuel" }, String(guardRuns));
    }
  });
});

describe("proposePlafond : valeur du champ à l'activation", () => {
  it("première activation (aucun dernier montant) : champ vide", () => {
    for (const max of [0.01, 1, 5, 50]) assert.deepEqual(proposePlafond(null, max), { valeur: "", horsBornes: false }, String(max));
  });

  it("activation suivante : dernier montant proposé tel quel, dans les bornes", () => {
    assert.deepEqual(proposePlafond("2,50", 5), { valeur: "2,50", horsBornes: false });
    assert.deepEqual(proposePlafond("2.5", 5), { valeur: "2.5", horsBornes: false });
    assert.deepEqual(proposePlafond("5", 5), { valeur: "5", horsBornes: false });
    assert.deepEqual(proposePlafond("0,29", 0.29), { valeur: "0,29", horsBornes: false });
  });

  it("borne abaissée sous le dernier montant : proposé quand même, marqué hors bornes, jamais remplacé par la borne", () => {
    assert.deepEqual(proposePlafond("4.00", 3), { valeur: "4.00", horsBornes: true });
    assert.deepEqual(proposePlafond("5,01", 5), { valeur: "5,01", horsBornes: true });
    assert.deepEqual(proposePlafond("5", 4.999), { valeur: "5", horsBornes: true });
    assert.deepEqual(proposePlafond("1", Number.NaN), { valeur: "1", horsBornes: true });
    assert.deepEqual(proposePlafond("1", undefined as never), { valeur: "1", horsBornes: true });
  });

  it("dernier montant illisible (réglage altéré) : champ vide, jamais une autre valeur", () => {
    for (const dernier of ["", " ", "abc", "0", "0,00", " 2", "2 ", "1e2", "-1", "1,234", 5, undefined]) {
      assert.deepEqual(proposePlafond(dernier as never, 5), { valeur: "", horsBornes: false }, String(dernier));
    }
  });

  it("cohérent avec validatePlafond : une valeur proposée est acceptée exactement quand elle n'est pas hors bornes", () => {
    const derniers = [null, "", "abc", "0", "0,01", "1", "2,50", "4.99", "5", "5,01", "49,99", "50", "50.01", "9".repeat(30)];
    const maxima = [Number.NaN, 0, 0.01, 0.29, 1, 4.999, 5, 5.1, 50];
    for (const dernier of derniers) {
      for (const max of maxima) {
        const propose = proposePlafond(dernier, max);
        if (propose.valeur === "") {
          assert.equal(propose.horsBornes, false);
          continue;
        }
        assert.equal(propose.valeur, dernier);
        assert.equal(validatePlafond(propose.valeur, { plafondMaxUsd: max, guardRuns: "ok" }).ok, !propose.horsBornes, `${dernier} / ${max}`);
      }
    }
  });
});

describe("aucune valeur par défaut (Q7, §7.6 l.1155)", () => {
  it("sans dernier montant, jamais de proposition non vide, quelle que soit la borne", () => {
    for (const max of [Number.NaN, 0, 0.01, 0.29, 1, 4.999, 5, 5.1, 49.99, 50, 1e6, undefined as never]) {
      assert.deepEqual(proposePlafond(null, max), { valeur: "", horsBornes: false }, String(max));
    }
  });

  it("aucun montant n'est retenu sans saisie : vide ou blanc jamais accepté, borne et garde-fou jamais supposés", () => {
    for (const saisie of ["", " ", TAB, NBSP]) assert.equal(validatePlafond(saisie, bornes()).ok, false);
    assert.deepEqual(validatePlafond("1", { guardRuns: "ok" } as never), { ok: false, code: "plafond-hors-bornes" });
    assert.deepEqual(validatePlafond("1", { plafondMaxUsd: 50 } as never), { ok: false, code: "budget-mensuel" });
  });

  it("le module n'exporte que des fonctions et la liste des codes : aucun nombre, aucun montant", () => {
    const nombres: string[] = [];
    const parcours = (valeur: unknown, chemin: string): void => {
      if (typeof valeur === "number") nombres.push(chemin);
      else if (typeof valeur === "string") assert.equal(/[0-9]/.test(valeur), false, `${chemin} : ${valeur}`);
      else if (Array.isArray(valeur)) valeur.forEach((v, i) => parcours(v, `${chemin}[${i}]`));
      else if (valeur !== null && typeof valeur === "object") for (const [k, v] of Object.entries(valeur)) parcours(v, `${chemin}.${k}`);
    };
    for (const [nom, valeur] of Object.entries(omoCap)) {
      if (typeof valeur === "function") continue;
      assert.equal(nom, "OMO_CAP_REFUSAL_CODES", `export inattendu : ${nom}`);
      parcours(valeur, nom);
    }
    assert.deepEqual(nombres, []);
    assert.deepEqual(Object.keys(omoCap).sort(), ["OMO_CAP_REFUSAL_CODES", "proposePlafond", "validatePlafond"]);
  });

  it("source : aucun littéral de montant, aucune valeur par défaut de paramètre ou de repli pour la borne et le garde-fou", () => {
    const code = SOURCE.split(LF)
      .filter((ligne) => !/^\s*(\/\/|\/\*\*|\*)/.test(ligne))
      .join(LF);
    assert.equal(/(?<![\w.])[0-9]+\.[0-9]+/.test(code), false, "littéral décimal");
    assert.equal(/\b(plafondMaxUsd|guardRuns|dernier|saisie)\s*(\?\?|\|\||=(?!=))/.test(code), false, "valeur par défaut ou de repli");
    assert.equal(/\bparseFloat\b|\btoFixed\b|\bMath\.round\b|\bMath\.floor\b/.test(code), false, "calcul en flottant");
  });

  it("source : aucune constante de plafond, même interne et inutilisée (inventaire des nombres et des chaînes à chiffres)", () => {
    const { code, chaines } = codeNu(SOURCE);
    // Indices des groupes lus (m[1], m[2], deux fois chacun), deux décimales (padEnd, slice), facteur des centimes, zéro (début
    // de la coupe, montant nul). Tout autre nombre, même d'une constante interne, fait échouer ce test : à justifier ici.
    assert.deepEqual(nombresEcrits(code).sort(), ["0", "0", "1", "1", "100", "2", "2", "2", "2"]);
    // Seule chaîne à chiffre : le « 0 » de remplissage des centimes.
    assert.deepEqual(chaines.filter((s) => /[0-9]/.test(s)), ["0"]);
  });

  it("outil du contrôle de source : commentaires et expressions régulières retirés, chaînes mises à part, nombres gardés", () => {
    const echantillon = [
      "// 5 dollars en commentaire",
      "/** 7,50 en JSDoc */",
      "const A = /^[0-9]{1,2}\\/x$/;",
      'const B = "1,00";',
      "const C = 5; const D = 0x10; const E = .5; const F = 1e3;",
      "const G = m[1] ?? 100; // 9 en fin de ligne",
    ].join(LF);
    const { code, chaines } = codeNu(echantillon);
    assert.deepEqual(nombresEcrits(code), ["5", "0x10", ".5", "1e3", "1", "100"]);
    assert.deepEqual(chaines, ["1,00"]);
  });
});

describe("pureté (T-L22-n)", () => {
  it("ni module node, ni process, ni horloge, ni aléa, ni réseau, ni stockage ; aucun import", () => {
    assert.equal(SOURCE.includes('"node:'), false);
    assert.equal(/\bprocess\./.test(SOURCE), false);
    assert.equal(/\bDate\b|Math\.random|\bfetch\s*\(|\bsetTimeout\b|\bsetInterval\b|\bperformance\.|\bcrypto\.|\bglobalThis\b|\blocalStorage\b|\bwindow\.|\bdocument\./.test(SOURCE), false);
    assert.equal(/^\s*import\b|\brequire\s*\(|\bimport\s*\(/m.test(SOURCE), false);
  });

  it("mêmes entrées, mêmes sorties ; les bornes ne sont jamais modifiées", () => {
    const gelees = Object.freeze(bornes({ plafondMaxUsd: 5 }));
    const cas = ["", "abc", "0", "1", "4,99", "5", "5,01"];
    const premier = cas.map((saisie) => validatePlafond(saisie, gelees));
    for (let i = 0; i < 3; i++) assert.deepEqual(cas.map((saisie) => validatePlafond(saisie, gelees)), premier);
    assert.deepEqual(gelees, { plafondMaxUsd: 5, guardRuns: "ok" });
    assert.deepEqual(proposePlafond("6", 5), proposePlafond("6", 5));
  });
});
