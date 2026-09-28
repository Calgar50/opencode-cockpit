// Résolution anticipée des noms coupée, liens externes sans fuite (1.1.0, arbitrage A47 (1), après le banc réseau v2).
// Chromium résout d'avance le nom des liens d'une page servie en HTTP (mode -Http) : le nom d'un lien affiché (réponse d'IA,
// fichier, source d'une méthode, tarifs) partirait vers le DNS du poste sans aucun clic. Le cockpit le coupe par l'en-tête
// X-DNS-Prefetch-Control: off sur TOUTES ses réponses (page, fichiers, API, refus) et par la méta équivalente de l'index HTML.
// - En-tête : harnais du cockpit réel (security.ts, premier intergiciel de http.ts), page, route API publique, route API avec
//   session, 401, 404 de l'API et 421 de l'hôte refusé.
// - Méta : index.html source de l'interface (le HTML construit par vite est contrôlé dans croisements-3d-v2.test.ts, qui fait le
//   vrai build) ; aucune balise <link> de préconnexion, de préchargement ou de résolution anticipée vers un autre hôte.
// - Liens externes : tout <a> de l'interface qui vise une adresse hors du cockpit s'ouvre dans un nouvel onglet avec
//   rel="noopener noreferrer" (jetons dans n'importe quel ordre) ; le Markdown assaini (réponses de l'IA) pose ces deux attributs
//   sur chaque lien, <a> comme <area>. Contrôle de source : DOMPurify exige un DOM que la suite Node n'a pas.
// Aucun réseau, aucun conteneur, aucun appel facturé.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import { startCockpit } from "./test-support/cockpit-harness.ts";

const WEB = path.join(import.meta.dirname, "..", "web");
const lire = (relatif: string): string => fs.readFileSync(path.join(WEB, relatif), "utf8");

/** Fichiers .tsx de l'interface, chemins relatifs POSIX, tests exclus. */
function composants(): string[] {
  return fs
    .readdirSync(WEB, { recursive: true, encoding: "utf8" })
    .map((relatif) => relatif.replaceAll("\\", "/"))
    .filter((relatif) => relatif.endsWith(".tsx") && !relatif.includes(".test."))
    .sort();
}

/** Source sans commentaires : lignes « // … » entières et blocs « /* … *\/ » (une adresse « https:// » d'une chaîne reste). */
const sansCommentaires = (source: string): string => source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

/** Balises ouvrantes `<a …>` d'un source JSX, de `<a` jusqu'au `>` hors accolades et hors chaînes (balises sur plusieurs lignes). */
function balisesA(texte: string): string[] {
  const source = sansCommentaires(texte);
  const balises: string[] = [];
  const debut = /<a(?=[\s>])/g;
  for (let m = debut.exec(source); m; m = debut.exec(source)) {
    let profondeur = 0;
    let chaine: string | null = null;
    let fin = -1;
    for (let i = m.index + 2; i < source.length; i += 1) {
      const c = source[i] as string;
      if (chaine) {
        if (c === chaine) chaine = null;
      } else if (c === '"' || c === "'" || c === "`") chaine = c;
      else if (c === "{") profondeur += 1;
      else if (c === "}") profondeur -= 1;
      else if (c === ">" && profondeur === 0) {
        fin = i;
        break;
      }
    }
    assert.notEqual(fin, -1, `balise <a non refermée à la position ${m.index}`);
    balises.push(source.slice(m.index, fin + 1));
  }
  return balises;
}

/** Valeur brute d'un attribut JSX : "texte" ou {expression} (accolades équilibrées), ou null. */
function attribut(balise: string, nom: string): string | null {
  const m = new RegExp(`\\s${nom}=`).exec(balise);
  if (!m) return null;
  const debut = m.index + m[0].length;
  if (balise[debut] === '"') return balise.slice(debut, balise.indexOf('"', debut + 1) + 1);
  if (balise[debut] !== "{") return null;
  let profondeur = 0;
  for (let i = debut; i < balise.length; i += 1) {
    if (balise[i] === "{") profondeur += 1;
    else if (balise[i] === "}") {
      profondeur -= 1;
      if (profondeur === 0) return balise.slice(debut, i + 1);
    }
  }
  return null;
}

/**
 * Adresse qui reste dans le cockpit : route de l'interface (#/…), chemin de la même origine (/…), ou fabriquée par une aide
 * interne de l'interface (routes, onglet Fichiers, exports de l'API).
 */
const INTERNES: readonly RegExp[] = [
  /^"#\//,
  /^"\/(?!\/)/,
  /^\{routeHref\(/,
  /^\{assistantsHref\(/,
  /^\{assistantsTabHref\(/,
  /^\{adresseFichiers\(/,
  /^\{ouvrirDansFichiers\}$/,
  /^\{api\.\w+Url\(/,
];

const jetonsRel = (rel: string | null): string[] => (rel ?? "").replace(/^\{?["'`]?|["'`]?\}?$/g, "").split(/\s+/).filter(Boolean);

describe("préchargement DNS coupé (A47) : en-tête X-DNS-Prefetch-Control sur toutes les réponses", () => {
  it("page, fichier inconnu (repli sur l'interface), API publique, API avec session, 401, 404 de l'API et 421 : « off »", async (t) => {
    const h = await startCockpit(t);
    const reponses = {
      page: await h.call("GET", "/"),
      repliInterface: await h.call("GET", "/chat/inconnu"),
      santé: await h.call("GET", "/api/health"),
      réglages: await h.call("GET", "/api/settings", { headers: h.headers.authed }),
      sansSession: await h.call("GET", "/api/bootstrap"),
      routeInconnue: await h.call("GET", "/api/route-inconnue", { headers: h.headers.authed }),
      hôteRefusé: await h.call("GET", "/", { headers: { host: "evil.example" } }),
    };
    assert.deepEqual(
      Object.fromEntries(Object.entries(reponses).map(([nom, r]) => [nom, r.status])),
      { page: 200, repliInterface: 200, santé: 200, réglages: 200, sansSession: 401, routeInconnue: 404, hôteRefusé: 421 },
    );
    for (const [nom, r] of Object.entries(reponses)) {
      assert.equal(r.headers["x-dns-prefetch-control"], "off", `${nom} : en-tête X-DNS-Prefetch-Control`);
      // Les en-têtes voisins restent posés tels quels.
      assert.equal(r.headers["referrer-policy"], "no-referrer", `${nom} : Referrer-Policy`);
    }
  });
});

describe("préchargement DNS coupé (A47) : index HTML de l'interface", () => {
  const html = lire("index.html");
  const tete = /<head>([\s\S]*?)<\/head>/.exec(html)?.[1] ?? "";

  it("la balise head porte <meta http-equiv=\"x-dns-prefetch-control\" content=\"off\" />, avant tout lien et tout script", () => {
    assert.notEqual(tete, "", "index.html a une balise head");
    const meta = tete.search(/<meta\s+http-equiv="x-dns-prefetch-control"\s+content="off"\s*\/?>/);
    assert.ok(meta >= 0, "méta x-dns-prefetch-control absente de la tête");
    const premierLien = tete.search(/<link\b/);
    if (premierLien >= 0) assert.ok(meta < premierLien, "la méta précède le premier <link>");
    assert.ok(!/<script\b/.test(tete.slice(0, meta)), "aucun script avant la méta");
    assert.equal(html.match(/x-dns-prefetch-control/g)?.length, 1, "une seule méta, jamais remise à « on »");
  });

  it("aucun <link> de préconnexion, de préchargement ou de résolution anticipée ; chaque <link> vise la même origine", () => {
    const liens = html.match(/<link\b[^>]*>/g) ?? [];
    for (const lien of liens) {
      assert.doesNotMatch(lien, /\brel="[^"]*\b(?:preconnect|dns-prefetch|prefetch|preload|prerender|modulepreload)\b/, lien);
      const href = /\bhref="([^"]*)"/.exec(lien)?.[1] ?? "";
      assert.match(href, /^\/(?!\/)/, `lien vers la même origine seulement : ${lien}`);
    }
  });
});

describe("liens externes de l'interface : nouvel onglet, rel=\"noopener noreferrer\"", () => {
  it("le Markdown assaini (réponses de l'IA) pose target=\"_blank\" et rel=\"noopener noreferrer\" sur chaque <a> et <area>", () => {
    const source = lire("components/Markdown.tsx");
    const crochet = /DOMPurify\.addHook\("afterSanitizeAttributes",\s*\(node\)\s*=>\s*\{([\s\S]*?)\n\}\);/.exec(source)?.[1] ?? "";
    assert.notEqual(crochet, "", "crochet afterSanitizeAttributes de DOMPurify");
    assert.match(crochet, /if \(node\.tagName === "A" \|\| node\.tagName === "AREA"\) \{/, "les deux éléments porteurs d'un lien");
    assert.match(crochet, /node\.setAttribute\("target", "_blank"\);/);
    assert.match(crochet, /node\.setAttribute\("rel", "noopener noreferrer"\);/);
    // Aucune option ne réautorise une balise <link> ou <meta> (absentes de la liste blanche de DOMPurify) dans une réponse.
    assert.doesNotMatch(source, /ADD_TAGS|ALLOWED_TAGS|WHOLE_DOCUMENT/);
  });

  it("chaque <a> des composants vise le cockpit, ou s'ouvre dans un nouvel onglet avec noopener et noreferrer", () => {
    const externes: string[] = [];
    let total = 0;
    for (const relatif of composants()) {
      for (const balise of balisesA(lire(relatif))) {
        total += 1;
        const href = attribut(balise, "href");
        const cible = attribut(balise, "target");
        const rel = jetonsRel(attribut(balise, "rel"));
        const interne = href !== null && INTERNES.some((re) => re.test(href));
        if (!interne) externes.push(`${relatif} ${href}`);
        if (!interne || cible !== null) {
          assert.equal(cible, '"_blank"', `${relatif} : lien ${href} hors du cockpit sans target="_blank"`);
          assert.ok(rel.includes("noopener") && rel.includes("noreferrer"), `${relatif} : lien ${href} sans rel="noopener noreferrer"`);
        }
      }
    }
    // Garde du contrôle lui-même : il voit bien les liens de l'interface, dont les trois qui sortent du cockpit.
    assert.ok(total >= 20, `${total} balises <a> lues`);
    assert.deepEqual(externes, [
      "pages/assistants/methods/MethodCard.tsx {href}",
      "pages/settings/ConnectionTab.tsx {flow.url}",
      "pages/settings/PricingTab.tsx {p.sourceUrl}",
    ]);
  });
});
