// SUL — aucune sous-chaîne de l'extension versionnée (D-2b-31).
//
// La règle : dans une fixture `omo-*` ou dans `docs/omo-audit-4.19.4.md`, aucune suite de 60 caractères ou plus ne doit se
// retrouver telle quelle dans le `dist` ni dans les `SKILL.md` de la 4.19.4 — SAUF si cette suite est un nom, un chemin ou un
// symbole, que la même décision autorise expressément l'audit à citer. C'est ce que le banc a mesuré : les seules
// concordances du document sont des chemins de fichiers de l'extension, dont plusieurs dépassent 60 caractères à eux seuls.
// Ce qui reste interdit, et que cette porte cherche : un extrait de code ou de consigne.
//
// Comment c'est vérifié sans tout recopier : le banc extrait du dépôt toutes les fenêtres de 60 caractères des fixtures et du
// document, en garde les empreintes dans un ensemble, puis fait DÉFILER le `dist` de l'image dans un conteneur jetable, avec
// une empreinte glissante. Une concordance d'empreinte est ensuite confirmée caractère par caractère : aucune fausse alerte.
//
// Le travail se fait DANS l'image : le `dist` ne sort jamais d'elle, et rien de son contenu n'entre dans le dépôt.
import fs from "node:fs";
import path from "node:path";

const LONGUEUR = 60;

/**
 * Ce que D-2b-31 autorise expressément : « l'audit cite des NOMS, des CHEMINS et des SYMBOLES, jamais un extrait de code ou
 * de consigne ». Un chemin de l'extension peut à lui seul dépasser 60 caractères
 * (`packages/omo-opencode/src/shared/model-capabilities-cache.ts` en fait 60). Une concordance faite d'un seul chemin ou
 * symbole — aucune espace, aucune ponctuation de prose — est donc une citation permise, et non une sous-chaîne versionnée.
 * Tout le reste est un manquement.
 */
const CITATION = /^[A-Za-z0-9_@./:-]+$/;

/** Fichiers du dépôt soumis à la règle. Le nom décide : toute fixture `omo-*`, plus le document d'audit. */
function fichiersSoumis(racine) {
  const fixtures = path.join(racine, "app", "server", "test-support", "fixtures");
  const liste = [];
  if (fs.existsSync(fixtures)) {
    for (const nom of fs.readdirSync(fixtures)) {
      if (/^omo-/.test(nom)) liste.push(path.join(fixtures, nom));
    }
  }
  const doc = path.join(racine, "docs", "omo-audit-4.19.4.md");
  if (fs.existsSync(doc)) liste.push(doc);
  return liste;
}

/**
 * Empreintes des fenêtres de 60 caractères d'un texte. Empreinte 32 bits, calculée en glissant : c'est un filtre, la
 * confirmation se fait ensuite sur le texte lui-même.
 */
const BASE = 131;
function empreintes(texte) {
  const sortie = new Map();
  if (texte.length < LONGUEUR) return sortie;
  let puissance = 1;
  for (let i = 1; i < LONGUEUR; i += 1) puissance = Math.imul(puissance, BASE);
  let h = 0;
  for (let i = 0; i < LONGUEUR; i += 1) h = Math.imul(h, BASE) + texte.charCodeAt(i);
  const poser = (cle, debut) => {
    if (!sortie.has(cle)) sortie.set(cle, []);
    const liste = sortie.get(cle);
    if (liste.length < 8) liste.push(debut);
  };
  poser(h, 0);
  for (let i = LONGUEUR; i < texte.length; i += 1) {
    h = Math.imul(h - Math.imul(texte.charCodeAt(i - LONGUEUR), puissance), BASE) + texte.charCodeAt(i);
    poser(h, i - LONGUEUR + 1);
  }
  return sortie;
}

export default {
  id: "sul",
  titre: "SUL : aucune sous-chaîne de 60 caractères de la 4.19.4 dans le dépôt",
  async executer(ctx) {
    const points = [];
    const mesures = {};
    const ajouter = (nom, ok, detail) => points.push({ nom, ok: Boolean(ok), detail });

    const fichiers = fichiersSoumis(ctx.racine);
    ajouter("des fichiers soumis à la règle existent", fichiers.length > 0, fichiers.map((f) => path.basename(f)).join(", ") || "aucun");
    if (fichiers.length === 0) return { points, mesures };

    // Toutes les fenêtres, par fichier, dans un seul tableau d'empreintes envoyé au conteneur.
    const parEmpreinte = new Map();
    let caracteres = 0;
    for (const fichier of fichiers) {
      const texte = fs.readFileSync(fichier, "utf8").replace(/\r\n/g, "\n");
      caracteres += texte.length;
      for (const [cle, debuts] of empreintes(texte)) {
        if (!parEmpreinte.has(cle)) parEmpreinte.set(cle, []);
        const liste = parEmpreinte.get(cle);
        for (const d of debuts) {
          if (liste.length < 4) liste.push({ fichier: path.basename(fichier), debut: d, extrait: texte.slice(d, d + LONGUEUR) });
        }
      }
    }

    const dossier = path.join(ctx.chemins.dossier, "sul");
    fs.mkdirSync(dossier, { recursive: true });
    // Seules les empreintes partent dans le conteneur, jamais les textes : la confirmation se fait au retour, côté hôte.
    fs.writeFileSync(path.join(dossier, "empreintes.json"), JSON.stringify([...parEmpreinte.keys()]));

    const script = `
const fs = require("node:fs");
const path = require("node:path");
const LONGUEUR = ${LONGUEUR};
const BASE = ${BASE};
const cles = new Set(JSON.parse(fs.readFileSync("/sul/empreintes.json", "utf8")));
const racine = "/opt/omo/node_modules/oh-my-openagent";
const fichiers = [];
const parcourir = (d, p) => {
  if (p > 8) return;
  let entrees = [];
  try { entrees = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
  for (const e of entrees) {
    const c = path.join(d, e.name);
    if (e.isDirectory()) parcourir(c, p + 1);
    else if (e.isFile() && (/\\.(js|mjs|cjs)$/.test(e.name) || e.name === "SKILL.md")) fichiers.push(c);
  }
};
parcourir(path.join(racine, "dist"), 0);
let puissance = 1;
for (let i = 1; i < LONGUEUR; i += 1) puissance = Math.imul(puissance, BASE);
const touches = [];
let octets = 0;
for (const f of fichiers) {
  let t = "";
  try { t = fs.readFileSync(f, "utf8"); } catch { continue; }
  octets += t.length;
  if (t.length < LONGUEUR) continue;
  let h = 0;
  for (let i = 0; i < LONGUEUR; i += 1) h = Math.imul(h, BASE) + t.charCodeAt(i);
  if (cles.has(h)) touches.push({ fichier: f.slice(racine.length + 1), debut: 0, extrait: t.slice(0, LONGUEUR) });
  for (let i = LONGUEUR; i < t.length; i += 1) {
    h = Math.imul(h - Math.imul(t.charCodeAt(i - LONGUEUR), puissance), BASE) + t.charCodeAt(i);
    if (cles.has(h) && touches.length < 200) touches.push({ fichier: f.slice(racine.length + 1), debut: i - LONGUEUR + 1, extrait: t.slice(i - LONGUEUR + 1, i + 1) });
  }
}
process.stdout.write(JSON.stringify({ fichiers: fichiers.length, octets, empreintes: cles.size, touches }));
`;
    const r = await ctx.docker(
      [
        "run",
        "--rm",
        "--network",
        "none",
        "--cap-drop",
        "ALL",
        "--security-opt",
        "no-new-privileges:true",
        "--volume",
        `${dossier.replace(/\\/g, "/")}:/sul:ro`,
        "--entrypoint",
        "node",
        ctx.image,
        "--max-old-space-size=2048",
        "-e",
        script,
      ],
      { delaiMs: 900_000 },
    );
    let vue = null;
    try {
      vue = JSON.parse(String(r.sortie).trim());
    } catch {
      vue = null;
    }
    if (!vue) {
      ajouter("balayage du dist lisible", false, `${String(r.erreur).slice(0, 300)} ${String(r.sortie).slice(0, 200)}`);
      return { points, mesures };
    }

    // Confirmation caractère par caractère : une concordance d'empreinte n'est retenue que si le texte est vraiment le même.
    const vraies = [];
    const citations = [];
    for (const touche of vue.touches) {
      // Les empreintes du dépôt sont indexées par leur valeur ; on ne peut plus la recalculer ici (l'extrait vient de l'image),
      // alors on la recalcule sur l'extrait reçu, puis on compare aux extraits du dépôt de la même empreinte.
      const m = empreintes(touche.extrait);
      const cle = [...m.keys()][0];
      for (const candidat of parEmpreinte.get(cle) ?? []) {
        if (candidat.extrait !== touche.extrait) continue;
        const concordance = { depot: `${candidat.fichier}@${candidat.debut}`, image: `${touche.fichier}@${touche.debut}`, longueur: LONGUEUR, extrait: touche.extrait };
        if (CITATION.test(touche.extrait)) citations.push(concordance);
        else vraies.push(concordance);
      }
    }
    // Le relevé garde les citations telles quelles (ce sont des chemins de l'extension, que l'audit a le droit de nommer) et
    // ne réduit que les manquements, qui ne doivent de toute façon pas exister.
    ctx.ecrireSortie(
      "sul.json",
      `${JSON.stringify(
        {
          fichiersDepot: fichiers.map((f) => path.basename(f)),
          caracteresDepot: caracteres,
          empreintes: parEmpreinte.size,
          distFichiers: vue.fichiers,
          distOctets: vue.octets,
          concordancesBrutes: vue.touches.length,
          citationsPermises: citations.length,
          citations: [...new Set(citations.map((c) => c.extrait))].slice(0, 40),
          manquements: vraies.map((v) => ({ depot: v.depot, image: v.image, apercu: v.extrait.slice(0, 20) })),
        },
        null,
        2,
      )}\n`,
    );
    ajouter(
      `aucune sous-chaîne de ${LONGUEUR} caractères de la 4.19.4 qui ne soit un nom, un chemin ou un symbole`,
      vraies.length === 0,
      `${fichiers.length} fichiers du dépôt (${caracteres} caractères), ${vue.fichiers} fichiers du dist (${vue.octets} caractères) ; ${vue.touches.length} concordance(s) d'empreinte, ${citations.length} citation(s) permise(s) (D-2b-31), ${vraies.length} manquement(s)`,
    );
    mesures.sul = {
      fichiersDepot: fichiers.length,
      caracteresDepot: caracteres,
      distFichiers: vue.fichiers,
      distOctets: vue.octets,
      concordancesBrutes: vue.touches.length,
      citationsPermises: citations.length,
      manquements: vraies.length,
    };

    return { points, mesures };
  },
};
