// Tests d'equipesOuvertes et du choix des démonstrations (GF5, U1, D-5-24 ; plan it5 §8.6 GF5 point 3) : module pur.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import { demonstrationsProposees, equipesOuvertes } from "./shared/equipes-ouvertes.ts";
import { EQUIPES_SIMPLE_OUVERTES } from "./wiring-eq.ts";

describe("equipesOuvertes (U1) : Avancé toujours ; Simple seulement si ouvertesEnSimple vaut true ; null ferme", () => {
  it("les six cas", () => {
    assert.equal(equipesOuvertes("avance", false), true);
    assert.equal(equipesOuvertes("avance", true), true);
    assert.equal(equipesOuvertes("avance", null), true);
    assert.equal(equipesOuvertes("simple", false), false);
    assert.equal(equipesOuvertes("simple", true), true, "ouverture en une ligne (EQUIPES_SIMPLE_OUVERTES = true) : présente");
    assert.equal(equipesOuvertes("simple", null), false, "lecture absente, en cours ou en échec : fermé en cas de doute");
  });

  it("interrupteur livré FERMÉ : EQUIPES_SIMPLE_OUVERTES === false, donc aucune équipe en Simple", () => {
    assert.equal(EQUIPES_SIMPLE_OUVERTES, false);
    assert.equal(equipesOuvertes("simple", EQUIPES_SIMPLE_OUVERTES), false);
  });

  it("module pur : aucun import de valeur, ni horloge, ni réseau", () => {
    const source = fs.readFileSync(path.join(import.meta.dirname, "shared", "equipes-ouvertes.ts"), "utf8");
    assert.deepEqual(
      [...source.matchAll(/^import\s+(?!type\b)[^;]+;/gm)].map((m) => m[0]),
      [],
    );
    assert.doesNotMatch(source, /Date\.now|new Date|fetch\(|process\.|require\(/);
  });
});

describe("choix du lecteur complet (U1) : la démonstration d'équipe seulement si l'appelant la rend visible", () => {
  const choix = (mode: "simple" | "avance", ouvertesEnSimple: boolean | null) => demonstrationsProposees(equipesOuvertes(mode, ouvertesEnSimple));
  it("Simple et ouvertesEnSimple faux → AUCUNE démonstration d'équipe ; vrai → présente ; Avancé → présente ; null → absente", () => {
    assert.deepEqual(choix("simple", false), ["p1", "attente-accord", "arret-plafond"]);
    assert.deepEqual(choix("simple", true), ["p1", "attente-accord", "arret-plafond", "equipe"]);
    assert.deepEqual(choix("avance", false), ["p1", "attente-accord", "arret-plafond", "equipe"]);
    assert.deepEqual(choix("simple", null), ["p1", "attente-accord", "arret-plafond"]);
  });
});
