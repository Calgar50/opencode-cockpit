// Captures du banc de la salle (fiche L21 ; D-2b-31) : les trois fixtures `omo-banc-*.jsonl` produites par les mesures M20,
// M21 et R16 sur l'extension réelle.
//
// D-2b-31 : **aucun texte de l'extension n'est versionné**. Dans une fixture `omo-*`, une partie texte est soit un marqueur de
// la liste fermée, soit un texte `[synthétique] …` qui n'en garde que la longueur et l'empreinte. Ce test le vérifie sur les
// captures du banc, en attendant `omo-fixtures.test.ts` (L25a), qui portera la même règle sur toutes les fixtures `omo-*`.
//
// Il vérifie aussi ce qui fait d'une capture une capture utilisable : le format `{recv, event}` de `readCapture()`, des heures
// de réception croissantes et relatives, et l'absence de secret ou de chemin de la machine.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

const FIXTURES = path.join(import.meta.dirname, "test-support", "fixtures");

/** Les trois captures du banc, avec la mesure qui les a produites. */
const CAPTURES: readonly { fichier: string; mesure: string }[] = [
  { fichier: "omo-banc-m20.jsonl", mesure: "M20 — débit d'événements d'une demande simulée" },
  { fichier: "omo-banc-m21.jsonl", mesure: "M21 — tâche de fond et réveil" },
  { fichier: "omo-banc-r16.jsonl", mesure: "R16 — session.updated pendant une délégation" },
];

/** Marqueurs de la liste fermée (D-2b-31), les seules suites de l'extension qu'une fixture garde telles quelles. */
const MARQUEURS: readonly string[] = ["<!-- OMO_INTERNAL_NOREPLY -->", "<!-- OMO_INTERNAL_INITIATOR -->", "[SYSTEM DIRECTIVE: OH-MY-OPENCODE -"];

/** Forme exacte d'un texte réduit : longueur et empreinte, rien d'autre. */
const SYNTHETIQUE = /^\[synthétique\] (\d+) car\. sha256:[0-9a-f]{16}$/;

/**
 * Un texte de la fixture est admis s'il est court et sans prose (un identifiant, un type, un chemin), un marqueur de la liste
 * fermée, ou une réduction `[synthétique] …`. Tout le reste est du texte de l'extension ou de l'IA : refusé.
 */
function texteAdmis(valeur: string): boolean {
  if (valeur.length <= 24 && /^[A-Za-z0-9_.:@/-]*$/.test(valeur)) return true;
  if (MARQUEURS.some((m) => valeur.startsWith(m))) return true;
  return SYNTHETIQUE.test(valeur);
}

/** Toutes les chaînes d'un objet, avec le chemin où elles se trouvent. */
function chaines(valeur: unknown, chemin = "", sortie: { chemin: string; texte: string }[] = []): { chemin: string; texte: string }[] {
  if (typeof valeur === "string") sortie.push({ chemin, texte: valeur });
  else if (Array.isArray(valeur)) valeur.forEach((v, i) => chaines(v, `${chemin}[${i}]`, sortie));
  else if (valeur && typeof valeur === "object") for (const [k, v] of Object.entries(valeur)) chaines(v, chemin === "" ? k : `${chemin}.${k}`, sortie);
  return sortie;
}

/** Motifs de secret et de machine cherchés dans chaque fixture, comme le fait `fake-opencode.test.ts`. */
const MOTIFS: readonly { nom: string; re: RegExp }[] = [
  { nom: "autorisation", re: /\b(authorization|Bearer |Basic [A-Za-z0-9+/=]{8,})/i },
  { nom: "jeton GitHub", re: /(gh[pousr]_|github_pat_)[A-Za-z0-9_]{16,}/ },
  { nom: "clé d'API", re: /\bsk-[A-Za-z0-9]{16,}/ },
  { nom: "JWT", re: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\./ },
  { nom: "clé privée", re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
  { nom: "adresse e-mail", re: /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/ },
  { nom: "chemin Windows", re: /[A-Za-z]:\\|\/c\/Users\/|AppData/i },
  { nom: "mot de passe", re: /\b(password|motdepasse)\b\s*[:=]/i },
];

for (const { fichier, mesure } of CAPTURES) {
  describe(`L21, capture ${fichier} (${mesure})`, () => {
    const chemin = path.join(FIXTURES, fichier);
    const present = fs.existsSync(chemin);
    const lignes = present
      ? fs
          .readFileSync(chemin, "utf8")
          .split("\n")
          .filter((l) => l.trim() !== "")
      : [];

    it("la capture est présente et au format d'une capture du cockpit", () => {
      assert.ok(present, `capture absente : ${fichier} (elle est écrite par le banc, node e2e/omo-banc/run-banc.mjs)`);
      assert.ok(lignes.length > 0, "une capture vide ne prouve rien");
      let precedent = -1;
      for (const [i, ligne] of lignes.entries()) {
        const bloc = JSON.parse(ligne) as { recv?: unknown; event?: unknown };
        assert.equal(typeof bloc.recv, "number", `ligne ${i + 1} : recv attendu`);
        assert.ok((bloc.recv as number) >= 0, `ligne ${i + 1} : recv relatif au début de la capture`);
        assert.ok((bloc.recv as number) >= precedent, `ligne ${i + 1} : les heures de réception doivent croître`);
        precedent = bloc.recv as number;
        assert.ok(bloc.event !== undefined && bloc.event !== null, `ligne ${i + 1} : event attendu`);
      }
    });

    it("D-2b-31 : aucune partie texte de l'extension n'est versionnée", () => {
      assert.ok(present, `capture absente : ${fichier}`);
      const refusees: string[] = [];
      for (const [i, ligne] of lignes.entries()) {
        const bloc = JSON.parse(ligne) as { event?: unknown };
        for (const { chemin: ou, texte } of chaines(bloc.event)) {
          if (!texteAdmis(texte)) refusees.push(`ligne ${i + 1}, ${ou} : ${texte.slice(0, 60)}`);
        }
      }
      assert.deepEqual(refusees.slice(0, 8), [], `${refusees.length} texte(s) non réduit(s)`);
    });

    it("aucune suite de 60 caractères ou plus qui ne soit pas une réduction (SUL, côté dépôt)", () => {
      assert.ok(present, `capture absente : ${fichier}`);
      // Les seules longues suites admises sont les réductions elles-mêmes et les marqueurs de la liste fermée : une capture
      // qui porterait 60 caractères de l'extension serait visible ici, sans avoir à ouvrir l'image.
      for (const [i, ligne] of lignes.entries()) {
        const bloc = JSON.parse(ligne) as { event?: unknown };
        for (const { texte } of chaines(bloc.event)) {
          if (texte.length < 60) continue;
          assert.ok(SYNTHETIQUE.test(texte) || MARQUEURS.some((m) => texte.startsWith(m)), `ligne ${i + 1} : suite de ${texte.length} caractères non réduite`);
        }
      }
    });

    it("analyse de secrets : rien du banc ni de la machine", () => {
      assert.ok(present, `capture absente : ${fichier}`);
      const texte = fs.readFileSync(chemin, "utf8");
      for (const { nom, re } of MOTIFS) {
        const trouve = re.exec(texte);
        assert.equal(trouve, null, `${nom} dans ${fichier} : ${String(trouve?.[0]).slice(0, 40)}`);
      }
      const utilisateur = os.userInfo().username;
      if (utilisateur.length >= 4 && !["root", "node", "runner", "user", "admin"].includes(utilisateur.toLowerCase())) {
        assert.ok(!texte.toLowerCase().includes(utilisateur.toLowerCase()), `nom de l'utilisateur dans ${fichier}`);
      }
    });
  });
}

describe("L21, chaque motif de l'analyse de secrets attrape bien son exemple", () => {
  it("un exemple planté est détecté par chaque motif", () => {
    const exemples: Record<string, string> = {
      autorisation: 'Authorization: Bearer abc',
      "jeton GitHub": `ghp_${"a".repeat(20)}`,
      "clé d'API": `sk-${"b".repeat(20)}`,
      JWT: "eyJhbGciOiJIUzI1.eyJzdWIiOiIxMjM0.abc",
      "clé privée": "-----BEGIN RSA PRIVATE KEY-----",
      "adresse e-mail": "quelquun@exemple.fr",
      "chemin Windows": "C:\\Users\\quelquun",
      "mot de passe": "password: secret",
    };
    for (const { nom, re } of MOTIFS) {
      const exemple = exemples[nom];
      assert.ok(exemple !== undefined, `motif sans exemple planté : ${nom}`);
      assert.ok(re.test(exemple), `le motif « ${nom} » ne détecte pas son propre exemple`);
    }
  });
});
