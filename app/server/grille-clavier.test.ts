// Clavier de la liste en grille du zoom 1 (plan d'exécution it3, fiche L31b ; spécification §5.5 l.917 « aucun raccourci à une
// touche hors composant focalisé ; flèches selon APG », §5.8 l.1009), sous Node : le module est pur.
// - flèches : déplacement d'une cellule, lignes de longueurs différentes, lignes vides sautées ;
// - bords : la flèche est prise mais ne déplace rien (aucun bouclage, aucun saut de ligne) ;
// - Début et Fin : bord de la ligne ; avec Ctrl ou Cmd, bord de la grille entière ;
// - Entrée : ouvre la conversation de la cellule courante ;
// - AUCUNE touche prise quand l'événement ne vient pas d'une cellule de la grille.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { type ActionGrille, type EtatGrille, indexDe, positionDe, toucheGrille, totalCellules } from "../web/pages/salle-controle/grille-clavier.ts";

/** Trois projets : 2 conversations, 0 (projet sans conversation récente), 3. Index de lecture : 0-1, puis 2-3-4. */
const LIGNES = [2, 0, 3];

const etat = (index: number, options: Partial<EtatGrille> = {}): EtatGrille => ({ lignes: LIGNES, index, dansLaGrille: true, ...options });

const touche = (key: string, modificateurs: { ctrlKey?: boolean; metaKey?: boolean; altKey?: boolean } = {}) => ({ key, ...modificateurs });

const deplacement = (action: ActionGrille | null): number | null => (action !== null && action.type === "deplacer" ? action.index : null);

describe("grille-clavier : repères", () => {
  it("totalCellules, positionDe et indexDe se répondent, lignes vides comprises", () => {
    assert.equal(totalCellules(LIGNES), 5);
    assert.equal(totalCellules([]), 0);
    assert.deepEqual(positionDe(LIGNES, 0), { ligne: 0, colonne: 0 });
    assert.deepEqual(positionDe(LIGNES, 1), { ligne: 0, colonne: 1 });
    // La ligne vide n'a aucun index : la cellule 2 est la première de la troisième ligne.
    assert.deepEqual(positionDe(LIGNES, 2), { ligne: 2, colonne: 0 });
    assert.deepEqual(positionDe(LIGNES, 4), { ligne: 2, colonne: 2 });
    assert.equal(positionDe(LIGNES, 5), null);
    assert.equal(positionDe(LIGNES, -1), null);
    assert.equal(indexDe(LIGNES, 2, 1), 3);
    // Colonne ramenée dans la ligne, et ligne vide ramenée à son début.
    assert.equal(indexDe(LIGNES, 0, 9), 1);
    assert.equal(indexDe(LIGNES, 1, 0), 2);
  });
});

describe("grille-clavier : flèches et bords (APG)", () => {
  it("droite et gauche se déplacent dans la ligne", () => {
    assert.equal(deplacement(toucheGrille(touche("ArrowRight"), etat(0))), 1);
    assert.equal(deplacement(toucheGrille(touche("ArrowLeft"), etat(1))), 0);
    assert.equal(deplacement(toucheGrille(touche("ArrowRight"), etat(2))), 3);
  });

  it("bords : la touche est prise, mais rien ne bouge (aucun bouclage, aucun saut de ligne)", () => {
    assert.equal(deplacement(toucheGrille(touche("ArrowRight"), etat(1))), 1);
    assert.equal(deplacement(toucheGrille(touche("ArrowLeft"), etat(0))), 0);
    assert.equal(deplacement(toucheGrille(touche("ArrowRight"), etat(4))), 4);
    assert.equal(deplacement(toucheGrille(touche("ArrowUp"), etat(0))), 0);
    assert.equal(deplacement(toucheGrille(touche("ArrowDown"), etat(4))), 4);
  });

  it("haut et bas changent de ligne, sautent les lignes vides et ramènent la colonne", () => {
    assert.equal(deplacement(toucheGrille(touche("ArrowDown"), etat(1))), 3);
    assert.equal(deplacement(toucheGrille(touche("ArrowUp"), etat(3))), 1);
    // Troisième colonne : la ligne du dessus n'en a que deux, la colonne est ramenée à la dernière.
    assert.equal(deplacement(toucheGrille(touche("ArrowUp"), etat(4))), 1);
  });

  it("grille vide : aucune touche ne fait rien", () => {
    for (const key of ["ArrowRight", "ArrowDown", "Home", "End", "Enter"]) {
      assert.equal(toucheGrille(touche(key), { lignes: [0, 0], index: 0, dansLaGrille: true }), null, key);
    }
  });

  it("index hors bornes : ramené dans la grille avant le déplacement", () => {
    assert.equal(deplacement(toucheGrille(touche("ArrowLeft"), etat(99))), 3);
    assert.equal(deplacement(toucheGrille(touche("ArrowRight"), etat(-5))), 1);
  });
});

describe("grille-clavier : Début, Fin et Entrée", () => {
  it("Début et Fin vont au bord de la ligne", () => {
    assert.equal(deplacement(toucheGrille(touche("Home"), etat(4))), 2);
    assert.equal(deplacement(toucheGrille(touche("End"), etat(2))), 4);
    assert.equal(deplacement(toucheGrille(touche("End"), etat(0))), 1);
  });

  it("Ctrl (ou Cmd) avec Début et Fin vont au bord de la grille entière", () => {
    assert.equal(deplacement(toucheGrille(touche("Home", { ctrlKey: true }), etat(4))), 0);
    assert.equal(deplacement(toucheGrille(touche("End", { ctrlKey: true }), etat(0))), 4);
    assert.equal(deplacement(toucheGrille(touche("Home", { metaKey: true }), etat(3))), 0);
    assert.equal(deplacement(toucheGrille(touche("End", { metaKey: true }), etat(1))), 4);
  });

  it("Entrée ouvre la cellule courante", () => {
    assert.deepEqual(toucheGrille(touche("Enter"), etat(3)), { type: "ouvrir", index: 3 });
    assert.deepEqual(toucheGrille(touche("Enter"), etat(0)), { type: "ouvrir", index: 0 });
  });
});

describe("grille-clavier : aucune touche prise hors de la grille (§5.5 l.917)", () => {
  it("événement venu d'ailleurs : rien n'est pris, pas même Entrée ou les flèches", () => {
    for (const key of ["ArrowRight", "ArrowLeft", "ArrowUp", "ArrowDown", "Home", "End", "Enter"]) {
      assert.equal(toucheGrille(touche(key), etat(0, { dansLaGrille: false })), null, key);
      // DISCRIMINANT : la même touche, venue d'une cellule, est bien prise.
      assert.notEqual(toucheGrille(touche(key), etat(0)), null, key);
    }
  });

  it("Échap, espace, Tab et les lettres ne sont jamais pris par la grille", () => {
    for (const key of ["Escape", " ", "Tab", "a", "PageDown", "F5"]) {
      assert.equal(toucheGrille(touche(key), etat(2)), null, key);
    }
  });

  it("Alt avec une flèche appartient au navigateur : jamais pris", () => {
    assert.equal(toucheGrille(touche("ArrowLeft", { altKey: true }), etat(3)), null);
    assert.equal(toucheGrille(touche("ArrowRight", { altKey: true }), etat(0)), null);
  });
});
