// D-2b-31, « aucun texte de l'extension versionné » (plan d'exécution, fiche L25a ; risque 17 ; C2-7) : dans TOUTE fixture
// `test-support/fixtures/omo-*`, une partie texte est soit un marqueur de la liste fermée, soit un texte « [synthétique] … » de
// 120 caractères au plus ; aucune chaîne tirée du paquet 4.19.4 ne dépasse 200 caractères.
//
// Ce test est OPPOSABLE À TOUTE FIXTURE `omo-*` FUTURE : il découvre les fichiers sur le disque, et toute fixture non déclarée
// est jugée comme une CAPTURE, c'est-à-dire avec la règle la plus stricte. Une fixture qui n'est pas une capture (un contrat
// écrit par le cockpit, jamais un événement d'opencode ni de l'extension) doit être inscrite dans NON_CAPTURES, avec sa raison :
// c'est la seule façon d'en sortir, et elle laisse une trace lisible en revue.
//
// Il double, sans le remplacer, `omo-banc-fixtures.test.ts` (fiche L21), qui vérifie en plus ce qui fait d'une capture du banc une
// capture utilisable (format `{recv, event}`, heures de réception relatives et croissantes).
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

const FIXTURES = path.join(import.meta.dirname, "test-support", "fixtures");

/**
 * Fixtures `omo-*` qui ne sont PAS des captures : leur contenu est écrit par le cockpit, pas par opencode ni par l'extension.
 * Leurs chaînes ne viennent donc pas du paquet 4.19.4 ; seules les règles sur les parties texte leur sont appliquées.
 */
const NON_CAPTURES: Readonly<Record<string, string>> = {
  "omo-control-vectors.json":
    "vecteurs du protocole de contrôle de la salle (T3a) : contenus de fichiers de contrôle et descriptions écrits par le cockpit, aucun événement d'opencode",
  // Train de la vague 2 (itération 2 ter) : L22b et L25a se rencontrent ici pour la première fois. Le corpus de L22b est écrit
  // à la main par le cockpit — il le dit lui-même dans son champ `source` (« aucune capture, aucune donnée de la machine ») —
  // et ses seules chaînes longues sont sa propre documentation en français. Aucune valeur n'y est un texte de message : c'est
  // ce que vérifie, plus bas, le contrôle « une exception déclarée ne porte aucune partie texte ».
  "omo-forbidden-corpus.json":
    "corpus unitaire de la porte G7 (L22b) : demandes d'autorisation et attendus écrits à la main par le cockpit d'après les formes relevées par MX1, aucun événement d'opencode ni de l'extension",
};

/** Marqueurs de la liste fermée (D-2b-31), les seules suites de l'extension qu'une fixture garde telles quelles. */
const MARQUEURS: readonly string[] = ["<!-- OMO_INTERNAL_NOREPLY -->", "<!-- OMO_INTERNAL_INITIATOR -->"];
/** Troisième marqueur de la liste fermée : le préfixe de relance, avec son type (§5.7.2 cas 5). */
const DIRECTIVE_RE = /^\[SYSTEM DIRECTIVE: OH-MY-OPENCODE - [A-Z0-9][A-Z0-9 _/-]{0,63}\]/;
/** Texte réduit : l'étiquette est obligatoire, et elle est en tête. */
const SYNTHETIQUE_RE = /^\[synthétique\](?: [^\n\r]*)?$/;
/** Identifiant, chemin, nom technique, version : aucune prose ne passe ici (ni espace, ni ponctuation de phrase). */
const TECHNIQUE_RE = /^[A-Za-z0-9_.:@/\\-]{0,64}$/;

/** Longueur maximale d'un texte réduit (fiche L25a). */
const SYNTHETIQUE_MAX = 120;
/** Longueur maximale d'une chaîne d'une capture : au-delà, c'est du contenu du paquet 4.19.4, quelle que soit sa forme. */
const CHAINE_MAX = 200;

/** Clés dont la valeur est, dans le flux d'opencode, un texte de message ou de sortie : la règle des parties texte s'y applique. */
const CLES_DE_TEXTE: readonly string[] = ["text", "prompt", "output", "content", "delta", "preview", "reasoning", "summary"];

/** Retire les marqueurs de la liste fermée écrits en tête, autant de fois qu'ils s'y trouvent. */
function reste(valeur: string): string {
  let v = valeur.trimStart();
  for (let tour = 0; tour < 8; tour++) {
    const directive = DIRECTIVE_RE.exec(v);
    const marqueur = MARQUEURS.find((m) => v.startsWith(m));
    if (directive !== null) v = v.slice(directive[0].length).trimStart();
    else if (marqueur !== undefined) v = v.slice(marqueur.length).trimStart();
    else return v;
  }
  return v;
}

/** Vrai si la chaîne est admise : marqueurs de la liste fermée, texte réduit borné, ou suite technique sans prose. */
export function texteAdmis(valeur: string): boolean {
  if (valeur.length > CHAINE_MAX) return false;
  const r = reste(valeur);
  if (r === "" || TECHNIQUE_RE.test(r)) return true;
  return SYNTHETIQUE_RE.test(r) && r.length <= SYNTHETIQUE_MAX;
}

/** Toutes les chaînes d'un objet, avec le chemin et la dernière clé où elles se trouvent. */
function chaines(valeur: unknown, chemin = "", cle = "", sortie: { chemin: string; cle: string; texte: string }[] = []): { chemin: string; cle: string; texte: string }[] {
  if (typeof valeur === "string") sortie.push({ chemin, cle, texte: valeur });
  else if (Array.isArray(valeur)) valeur.forEach((v, i) => chaines(v, `${chemin}[${i}]`, cle, sortie));
  else if (valeur && typeof valeur === "object") for (const [k, v] of Object.entries(valeur)) chaines(v, chemin === "" ? k : `${chemin}.${k}`, k, sortie);
  return sortie;
}

/** Motifs de secret et de machine cherchés dans chaque fixture (analyse de secrets de la fiche). */
const MOTIFS: readonly { nom: string; re: RegExp }[] = [
  { nom: "autorisation", re: /\b(authorization|Bearer |Basic [A-Za-z0-9+/=]{8,})/i },
  { nom: "jeton GitHub", re: /(gh[pousr]_|github_pat_)[A-Za-z0-9_]{16,}/ },
  { nom: "clé d'API", re: /\bsk-[A-Za-z0-9]{16,}/ },
  { nom: "JWT", re: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\./ },
  { nom: "clé privée", re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
  { nom: "adresse e-mail", re: /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/ },
  { nom: "chemin Windows", re: /[A-Za-z]:\\Users\\|\/c\/Users\/|AppData/i },
  { nom: "mot de passe", re: /\b(password|motdepasse)\b\s*[:=]/i },
];

/** Documents d'une fixture : une ligne par objet pour un `.jsonl`, un seul objet sinon. */
function documents(fichier: string): unknown[] {
  const brut = fs.readFileSync(path.join(FIXTURES, fichier), "utf8");
  if (!fichier.endsWith(".jsonl")) return [JSON.parse(brut)];
  return brut
    .split("\n")
    .filter((ligne) => ligne.trim() !== "")
    .map((ligne) => JSON.parse(ligne));
}

const FICHIERS = fs
  .readdirSync(FIXTURES)
  .filter((nom) => nom.startsWith("omo-"))
  .sort();

describe("D-2b-31 : aucun texte de l'extension dans une fixture omo-* (L25a)", () => {
  it("les fixtures omo-* sont découvertes sur le disque, et chacune est une capture ou une exception déclarée", () => {
    assert.ok(FICHIERS.length >= 4, `fixtures omo-* trouvées : ${FICHIERS.join(", ")}`);
    assert.ok(FICHIERS.includes("omo-jp1-jp7.jsonl"), "la fixture des faits de la salle (L25a) doit être là");
    for (const declaree of Object.keys(NON_CAPTURES)) {
      assert.ok(FICHIERS.includes(declaree), `NON_CAPTURES cite une fixture absente : ${declaree} (à retirer de la liste)`);
      assert.ok((NON_CAPTURES[declaree] ?? "").length > 40, `l'exception ${declaree} doit dire pourquoi elle n'est pas une capture`);
    }
  });

  // Train de la vague 2 (2 ter). Déclarer une exception allège la règle : ce contrôle empêche de s'en servir pour faire entrer
  // une vraie capture. Une capture d'opencode porte des parties texte (`text`, `prompt`, `content`…) ou un marqueur de la liste
  // fermée ; une fixture écrite par le cockpit n'en porte aucun. Si l'un des deux apparaît, l'exception tombe et le fichier
  // repasse sous la règle stricte des captures.
  it("une exception déclarée ne porte aucune partie texte ni marqueur de l'extension — sinon c'est une capture", () => {
    for (const declaree of Object.keys(NON_CAPTURES)) {
      for (const [i, document] of documents(declaree).entries()) {
        for (const { chemin, cle } of chaines(document)) {
          assert.ok(
            !CLES_DE_TEXTE.includes(cle),
            `${declaree} ligne ${i + 1} : valeur de texte de message en ${chemin} — cette fixture est une capture, à retirer de NON_CAPTURES`,
          );
        }
      }
      const brut = fs.readFileSync(path.join(FIXTURES, declaree), "utf8");
      for (const marqueur of MARQUEURS) {
        assert.ok(!brut.includes(marqueur), `${declaree} porte le marqueur ${marqueur} : c'est une capture, à retirer de NON_CAPTURES`);
      }
      assert.ok(!/\[SYSTEM DIRECTIVE: OH-MY-OPENCODE/.test(brut), `${declaree} porte le préfixe de relance : c'est une capture, à retirer de NON_CAPTURES`);
    }
  });

  for (const fichier of FICHIERS) {
    const capture = NON_CAPTURES[fichier] === undefined;
    describe(`${fichier} (${capture ? "capture" : "exception déclarée"})`, () => {
      it("chaque partie texte est un marqueur de la liste fermée ou un texte « [synthétique] … » de 120 caractères au plus", () => {
        const refusees: string[] = [];
        for (const [i, document] of documents(fichier).entries()) {
          for (const { chemin, cle, texte } of chaines(document)) {
            // Dans une capture, TOUTE chaîne vient d'opencode ou de l'extension ; ailleurs, seules les valeurs de texte de message.
            if (!capture && !CLES_DE_TEXTE.includes(cle)) continue;
            if (!texteAdmis(texte)) refusees.push(`ligne ${i + 1}, ${chemin} (${texte.length} car.)`);
          }
        }
        assert.deepEqual(refusees.slice(0, 8), [], `${refusees.length} chaîne(s) non réduite(s) dans ${fichier}`);
      });

      it("aucune chaîne de plus de 200 caractères tirée du paquet 4.19.4", () => {
        const longues: string[] = [];
        for (const [i, document] of documents(fichier).entries()) {
          for (const { chemin, cle, texte } of chaines(document)) {
            if (!capture && !CLES_DE_TEXTE.includes(cle)) continue;
            if (texte.length > CHAINE_MAX) longues.push(`ligne ${i + 1}, ${chemin} : ${texte.length} caractères`);
          }
        }
        assert.deepEqual(longues.slice(0, 8), [], `${longues.length} chaîne(s) trop longue(s) dans ${fichier}`);
      });

      it("analyse de secrets : rien du banc ni de la machine", () => {
        const texte = fs.readFileSync(path.join(FIXTURES, fichier), "utf8");
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
});

describe("D-2b-31 : la règle elle-même (contrôles discriminants)", () => {
  it("les trois marqueurs de la liste fermée passent, seuls ou suivis d'un texte réduit", () => {
    for (const marqueur of [...MARQUEURS, "[SYSTEM DIRECTIVE: OH-MY-OPENCODE - TODO CONTINUATION]", "[SYSTEM DIRECTIVE: OH-MY-OPENCODE - RALPH LOOP 1/5]"]) {
      assert.equal(texteAdmis(marqueur), true, marqueur);
      assert.equal(texteAdmis(`${marqueur} [synthétique] 42 car. sha256:0123456789abcdef`), true, marqueur);
    }
    assert.equal(texteAdmis("[synthétique] 399 car. sha256:0784d77b2ac7e8be"), true);
    assert.equal(texteAdmis("[synthétique]"), true);
    assert.equal(texteAdmis(""), true);
    assert.equal(texteAdmis("/workspace/projet/.omo/notepads/plan/learnings.md"), true, "un chemin n'est pas de la prose");
  });

  it("de la prose, un texte réduit trop long, ou une chaîne trop longue sont refusés", () => {
    const refuses = [
      "You are a helpful agent. Record your learnings in the notepad before finishing.",
      "Résumé de la conversation précédente, à relire avant de continuer.",
      "<Work_Context>\n## Notepad Location (for recording learnings)",
      `[synthétique] ${"a".repeat(SYNTHETIQUE_MAX)}`,
      "a".repeat(CHAINE_MAX + 1),
      `[SYSTEM DIRECTIVE: OH-MY-OPENCODE - TODO CONTINUATION] ${"b".repeat(CHAINE_MAX)}`,
      "[synthetique] etiquette sans accent, donc non reconnue",
      "Texte libre [synthétique] étiquette qui n'est pas en tête",
    ];
    for (const refuse of refuses) assert.equal(texteAdmis(refuse), false, refuse.slice(0, 48));
  });

  it("une capture plantée est bien refusée par la règle appliquée aux fixtures (mutation)", () => {
    const planté = { recv: 0, event: { type: "message.part.updated", properties: { part: { type: "text", text: "Summarize the task tool output above and continue working." } } } };
    const refusees = chaines(planté).filter(({ texte }) => !texteAdmis(texte));
    assert.equal(refusees.length, 1, "le texte planté doit être la seule chaîne refusée");
    assert.equal(refusees[0]?.cle, "text");
  });

  it("chaque motif de l'analyse de secrets attrape son propre exemple", () => {
    const exemples: Record<string, string> = {
      autorisation: "Authorization: Bearer abc",
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
