// « Déroulé partiel » du zoom 2 de la salle de contrôle et de « Revoir » (revue F1, décision A36 point 1 ; spécification §3.10
// l.356 : « 3 niveaux et 50 sessions au plus (au-delà : « Déroulé partiel ») » ; itération « 3s », L3s-a). Depuis la grande fusion
// (GF2), la scène de la salle est BORNÉE (L25b : NEON_SESSIONS_MAX = 50 assistants, conversation comprise, NEON_PROFONDEUR_MAX = 3
// niveaux) : le surplus n'est pas dessiné et il est compté dans `horsBornes`. La bande le dit (NeonBand.tsx, texteHorsBornes) ; le
// zoom 2 (en 3D comme en repli 2D) et « Revoir » doivent le dire aussi, avec la même phrase.
// Rendu CÔTÉ SERVEUR, sans navigateur, par la technique de neon-scene.test.ts (transformWithOxc de vite, imports relatifs et React
// réécrits en adresses absolues, module chargé par une adresse data:, renderToStaticMarkup) :
// - ZoomConversation.tsx est rendu EN ENTIER : ses faits arrivent d'ordinaire par un crochet réseau (useFaitsConversation), remplacé
//   ici par une enveloppe qui rend les faits du test et réexporte tout le reste du vrai module ; les composants .tsx que node ne
//   charge pas sont remplacés par des composants nommés qui laissent une trace (scène 3D, carte et tableau néon) ; DeroulePartiel.tsx
//   est chargé pour de vrai. Le zoom 2 est rendu en 3D ET en repli 2D ;
// - RevoirDialog.tsx lit ses faits dans un effet (GET /api/revoir), qu'un rendu serveur ne joue pas : la sous-vue qu'il monte
//   (DeroulePartiel.tsx) est rendue sur la vue calculée comme il la calcule (salle en Simple : scène en Avancé, rôles par clé, puis
//   vueSimple), et un contrôle de source prouve qu'il la monte avec `vue.horsBornes` de cette vue.
// Ces tests échouent sur la base de « 3s » (255e2c0) : ni le zoom 2 ni « Revoir » n'y écrivent la phrase (preuve dans le rapport de
// L3s-a : exécution avec les deux composants de la base).
// Bornes : 60 délégations d'une même réponse font 61 assistants, dont 50 dessinés → 11 non dessinés ; 60 assistants (la
// conversation et 59 délégations) → 10 ; une chaîne de 4 niveaux → 1, au singulier.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import { pathToFileURL } from "node:url";
import type { ActivityFact, ActivityFactKind, FactValue, SessionInstance } from "./shared/activity-types.ts";
import { NEON_PROFONDEUR_MAX, NEON_SESSIONS_MAX, type NeonScene, scene } from "./shared/neon-scene.ts";
import { texteHorsBornes, TEXTES as NEON } from "./shared/neon-texts.ts";
import { roleDeAgent } from "./shared/omo-roles.ts";
import { TEXTES as REVOIR } from "./shared/revoir-texts.ts";
import { modeSceneRevoir, nomsSimples, vueSimple } from "./shared/vue-simple.ts";

const APP_DIR = path.join(import.meta.dirname, "..");
const SALLE_DIR = path.join(APP_DIR, "web", "pages", "salle-controle");
const ZOOM_FILE = path.join(SALLE_DIR, "ZoomConversation.tsx");
const REVOIR_FILE = path.join(SALLE_DIR, "revoir", "RevoirDialog.tsx");
const DEROULE_FILE = path.join(SALLE_DIR, "DeroulePartiel.tsx");
const FAITS_FILE = path.join(SALLE_DIR, "useFaitsConversation.ts");

// --- Faits synthétiques ---------------------------------------------------------------------------------------------------------

const R = "ses_bornes_racine";

class Histoire {
  readonly faits: ActivityFact[] = [];
  readonly instance: SessionInstance;
  #at = 1_000;
  constructor(instance: SessionInstance) {
    this.instance = instance;
  }
  add(sessionId: string, kind: ActivityFactKind, data: Record<string, FactValue>, ref: string | null = null): void {
    this.#at += 10;
    this.faits.push({ rootId: R, sessionId, kind, ref, data, at: this.#at });
  }
  debut(): this {
    if (this.instance === "omo") this.add(R, "statut", { etat: "creee", role: "conversation", parent: null, agent: "sisyphus", instance: "omo" });
    this.add(R, "origine", { origine: "demande", cas: 1, messageId: "msg_d" }, "msg_d");
    this.add(R, "statut", { etat: "occupee" });
    return this;
  }
  /** Délégation envoyée et au travail, avec les clés de la salle quand la racine en est. */
  deleguer(parent: string, callId: string, enfant: string, agent = "explore"): this {
    const salle: Record<string, FactValue> = this.instance === "omo" ? { categorie: "quick", ia: null, competences: 0, fond: false } : {};
    this.add(parent, "consigne", { etat: "prepare", callId, messageId: `msg_${parent}` }, callId);
    this.add(enfant, "statut", { etat: "creee", role: "delegation", parent, agent, instance: this.instance });
    this.add(parent, "consigne", { etat: "envoyee", callId, messageId: `msg_${parent}`, enfant, agent, source: "ia", commande: null, reprise: false, ...salle }, callId);
    this.add(enfant, "statut", { etat: "occupee" });
    return this;
  }
}

/** `n` délégations d'une même réponse de la conversation. */
function delegations(n: number, instance: SessionInstance = "principale"): ActivityFact[] {
  const h = new Histoire(instance).debut();
  for (let i = 0; i < n; i++) h.deleguer(R, `call_${i}`, `ses_d${String(i).padStart(2, "0")}`);
  return h.faits;
}

/** Chaîne de `niveaux` délégations imbriquées sous la conversation. */
function niveaux(n: number, instance: SessionInstance = "principale"): ActivityFact[] {
  const h = new Histoire(instance).debut();
  let parent = R;
  for (let i = 1; i <= n; i++) {
    h.deleguer(parent, `call_n${i}`, `ses_n${i}`, "sisyphus-junior");
    parent = `ses_n${i}`;
  }
  return h.faits;
}

const AVANCE = { zoom: 2, mode: "avance", roleSalle: roleDeAgent } as const;

// --- Chargement des composants par vite, rendu serveur -----------------------------------------------------------------------------

type Rendre = (composant: unknown, props: object) => string;

/** Clé des faits servis par l'enveloppe de useFaitsConversation : une valeur partagée entre le test et le module chargé. */
const CLE_FAITS = Symbol.for("salle3d-hors-bornes.faits");
const poserFaits = (faits: readonly ActivityFact[]) => {
  (globalThis as Record<symbol, unknown>)[CLE_FAITS] = faits;
};

const dataUrl = (code: string) => `data:text/javascript;base64,${Buffer.from(code).toString("base64")}`;

/**
 * Charge un .tsx transformé en mémoire (rien n'est écrit sur disque). Chaque import relatif est réécrit en adresse absolue ; un
 * .tsx de `charges` est transformé à son tour ; un autre .tsx est remplacé par les composants de `remplaces` (un nom oublié fait
 * échouer le chargement : aucun composant n'est retiré en silence) ; un module de `modules` est remplacé par son adresse ; une
 * feuille de style est retirée.
 */
async function chargerTsx(
  fichier: string,
  options: { charges?: readonly string[]; remplaces?: Readonly<Record<string, string>>; modules?: Readonly<Record<string, string>> } = {},
  vus: string[] = [],
): Promise<string> {
  const { transformWithOxc } = (await import("vite")) as unknown as { transformWithOxc: (code: string, file: string, options: object) => Promise<{ code: string }> };
  const { code } = await transformWithOxc(fs.readFileSync(fichier, "utf8"), fichier, { lang: "tsx", jsx: { runtime: "automatic" } });
  const dossier = path.dirname(fichier);
  let sortie = code.replace(/^import\s+["'][^"']+\.css["'];?[ \t]*$/gm, "");
  const remplacements: string[] = [];
  for (const m of [...sortie.matchAll(/^import\s+\{([^}]*)\}\s+from\s+["'](\.{1,2}\/[^"']+)["'];?[ \t]*$/gm)]) {
    const [ligne, noms = "", spec = ""] = m;
    const cible = path.resolve(dossier, spec);
    let nouvelle: string;
    if (spec.endsWith(".tsx") && !(options.charges ?? []).includes(cible)) {
      nouvelle = noms
        .split(",")
        .map((nom) => nom.trim())
        .filter((nom) => nom !== "")
        .map((nom) => {
          const [exporte, local = exporte] = nom.split(/\s+as\s+/);
          const remplacant = options.remplaces?.[exporte ?? ""];
          assert.ok(remplacant !== undefined, `${path.basename(fichier)} : composant ${exporte} de ${spec} à nommer ici, ou à charger`);
          vus.push(exporte ?? "");
          return `const ${local} = ${remplacant};`;
        })
        .join("\n");
    } else {
      const adresse = spec.endsWith(".tsx") ? await chargerTsx(cible, options, vus) : (options.modules?.[cible] ?? pathToFileURL(cible).href);
      nouvelle = `import {${noms}} from ${JSON.stringify(adresse)};`;
    }
    remplacements.push(nouvelle);
    sortie = sortie.replace(ligne, nouvelle);
  }
  sortie = sortie
    .replace(/(\bfrom\s+)["'](\.{1,2}\/[^"']+)["']/g, (_m, tete: string, spec: string) => `${tete}${JSON.stringify(pathToFileURL(path.resolve(dossier, spec)).href)}`)
    .replace(/(\bfrom\s+)["'](react|react\/jsx-runtime)["']/g, (_m, tete: string, spec: string) => `${tete}${JSON.stringify(import.meta.resolve(spec))}`);
  assert.equal(/\bfrom\s+["'](?!file:|data:)/.test(sortie), false, `${path.basename(fichier)} : un import resté relatif ou nu ne se chargerait pas`);
  return dataUrl(sortie);
}

let rendu: Promise<{ zoom: unknown; deroule: unknown; rendre: Rendre; remplaces: string[] }> | null = null;

/** ZoomConversation.tsx rendu pour de vrai ; ses faits par l'enveloppe de useFaitsConversation, ses sous-composants .tsx tracés. */
function charger() {
  rendu ??= (async () => {
    const enveloppe = dataUrl(
      [
        `export * from ${JSON.stringify(pathToFileURL(FAITS_FILE).href)};`,
        "export function useFaitsConversation() {",
        `  return { faits: globalThis[Symbol.for(${JSON.stringify(CLE_FAITS.description)})] ?? [], partiel: false, chargement: false, echec: false };`,
        "}",
      ].join("\n"),
    );
    const remplaces: string[] = [];
    const trace = (nom: string) => `(props) => ${JSON.stringify(`[${nom}]`)}`;
    const zoomUrl = await chargerTsx(
      ZOOM_FILE,
      {
        charges: [DEROULE_FILE],
        modules: { [FAITS_FILE]: enveloppe },
        remplaces: {
          useApp: "() => ({ boot: { workspace: { root: '/workspace' } } })",
          NeonCarte: trace("carte néon"),
          NeonTableau: trace("tableau néon"),
          Scene3d: "(props) => `[scène 3D : ${props.plan.noeuds.length} nœuds ; secteurs ${[...new Set(props.plan.noeuds.map((n) => n.secteur ?? '-'))].join(',')}]`",
          ConsigneRevoir: trace("consigne"),
          LegendeBulle: trace("légende"),
          PanneauRevoir: trace("panneau"),
          ReplayBar: trace("lecteur"),
          RevoirEntree: trace("revoir"),
        },
      },
      remplaces,
    );
    const zoom = ((await import(zoomUrl)) as { ZoomConversation: unknown }).ZoomConversation;
    const deroule = ((await import(await chargerTsx(DEROULE_FILE))) as { DeroulePartiel: unknown }).DeroulePartiel;
    const react = (await import(import.meta.resolve("react"))) as { createElement: (type: unknown, props: object) => unknown };
    const serveur = (await import("react-dom/server")) as unknown as { renderToStaticMarkup: (element: unknown) => string };
    return { zoom, deroule, remplaces, rendre: (composant: unknown, props: object) => serveur.renderToStaticMarkup(react.createElement(composant, props)) };
  })();
  return rendu;
}

const rien = () => undefined;

/** Zoom 2 d'une conversation rendu côté serveur, en 3D ou en repli 2D. */
async function zoom2(faits: readonly ActivityFact[], options: { vue3d: boolean; salle?: boolean; mode?: "simple" | "avance" }): Promise<string> {
  const { zoom, rendre } = await charger();
  poserFaits(faits);
  return rendre(zoom, {
    rootId: R,
    sessionId: null,
    mode: options.mode ?? "avance",
    theme: "sombre",
    salle: options.salle ?? false,
    vue3d: options.vue3d,
    mouvementReduit: true,
    onEchec3d: rien,
    onZoom: rien,
  });
}

/** Paragraphe exact que DeroulePartiel doit rendre dans un écran, avec la classe de sa note voisine. */
const paragraphe = (classe: string, n: number) => `<p class="${classe}">${texteHorsBornes(n)}</p>`;

// --- Tests ------------------------------------------------------------------------------------------------------------------------

describe("« Déroulé partiel » : bornes de la scène (L25b) et phrase de la bande", () => {
  it("60 délégations → 11 non dessinés (la conversation compte parmi les 50) ; 60 assistants → 10 ; 4 niveaux → 1, au singulier", () => {
    assert.deepEqual([NEON_SESSIONS_MAX, NEON_PROFONDEUR_MAX], [50, 3]);
    const soixante = scene(delegations(60), null, AVANCE);
    assert.equal(soixante.noeuds.length, NEON_SESSIONS_MAX);
    assert.equal(soixante.horsBornes, 11);
    assert.equal(scene(delegations(59), null, AVANCE).horsBornes, 10);
    const quatre = scene(niveaux(4), null, AVANCE);
    assert.equal(quatre.horsBornes, 1);
    assert.equal(texteHorsBornes(1), NEON.partout.horsBornesUn, "singulier");
    assert.equal(texteHorsBornes(10), "Déroulé partiel : 10 assistants non dessinés (plus de 3 niveaux ou de 50 assistants).");
    // Sous la borne : rien à dire.
    assert.equal(scene(delegations(49), null, AVANCE).horsBornes, 0);
    assert.equal(scene(niveaux(3), null, AVANCE).horsBornes, 0);
  });
});

describe("zoom 2 de la salle de contrôle (ZoomConversation.tsx), rendu côté serveur : 3D et repli 2D", () => {
  it("les composants remplacés sont nommés ; DeroulePartiel est chargé pour de vrai", async () => {
    const { remplaces } = await charger();
    assert.deepEqual(
      [...new Set(remplaces)].sort(),
      ["ConsigneRevoir", "LegendeBulle", "NeonCarte", "NeonTableau", "PanneauRevoir", "ReplayBar", "RevoirEntree", "Scene3d", "useApp"],
    );
  });

  for (const vue3d of [true, false]) {
    const rendu2d = vue3d ? "en 3D" : "en repli 2D (NeonCarte, NeonTableau)";
    it(`60 délégations en Avancé, ${rendu2d} : texteHorsBornes(11), et la vue montrée est bien la scène bornée`, async () => {
      const html = await zoom2(delegations(60), { vue3d });
      assert.ok(html.includes(paragraphe("zoom-conv-note", 11)), html.slice(0, 2_000));
      if (vue3d) assert.ok(html.includes(`[scène 3D : ${NEON_SESSIONS_MAX} nœuds ;`), "la 3D reçoit le plan borné");
      else assert.ok(html.includes("[carte néon]") && !html.includes("[scène 3D"), "repli 2D : la carte néon, sans scène 3D");
      assert.ok(html.includes("[tableau néon]"), "le tableau est toujours là");
    });

    it(`60 assistants (la conversation et 59 délégations), ${rendu2d} : texteHorsBornes(10)`, async () => {
      assert.ok((await zoom2(delegations(59), { vue3d })).includes(paragraphe("zoom-conv-note", 10)));
    });

    it(`4 niveaux, ${rendu2d} : texteHorsBornes(vue.horsBornes), au singulier`, async () => {
      const faits = niveaux(4);
      const html = await zoom2(faits, { vue3d });
      assert.ok(html.includes(paragraphe("zoom-conv-note", scene(faits, null, AVANCE).horsBornes)), html.slice(0, 2_000));
      assert.ok(html.includes(NEON.partout.horsBornesUn));
    });

    it(`racine de la Salle OMO en Avancé (rôles par clé), ${rendu2d} : même phrase ; bandeau de l'enceinte écrit`, async () => {
      const html = await zoom2(delegations(60, "omo"), { vue3d, salle: true });
      assert.ok(html.includes(paragraphe("zoom-conv-note", 11)));
      assert.ok(html.includes(NEON.avance.salle), "bandeau de l'enceinte (JP-10)");
    });
  }

  it("salle branchée (L3s-a) : le zoom 2 range les assistants de la salle par leur RÔLE (clé de l'agent), comme la bande", async () => {
    // « sisyphus-junior » : inconnu des secteurs d'opencode (« Autres »), rôle « Exécuter » dans la salle (omo-roles.ts).
    const h = new Histoire("omo").debut();
    h.deleguer(R, "call_j1", "ses_j1", "sisyphus-junior");
    h.deleguer(R, "call_j2", "ses_j2", "librarian");
    const html = await zoom2(h.faits, { vue3d: true, salle: true });
    assert.ok(html.includes("secteurs -,executer,chercher]"), html.slice(0, 1_500));
    // Témoin : la même conversation hors de la salle (instance principale) garde les secteurs d'opencode.
    const hors = new Histoire("principale").debut();
    hors.deleguer(R, "call_j1", "ses_j1", "sisyphus-junior");
    hors.deleguer(R, "call_j2", "ses_j2", "librarian");
    assert.ok((await zoom2(hors.faits, { vue3d: true })).includes("secteurs -,autres]"));
  });

  it("sous la borne : aucune phrase ; la note des faits partiels (borne du magasin) reste une autre phrase", async () => {
    for (const faits of [delegations(49), niveaux(3)]) {
      const html = await zoom2(faits, { vue3d: true });
      assert.equal(html.includes("assistants non dessinés") || html.includes("assistant non dessiné"), false);
    }
    assert.notEqual(REVOIR.partout.partiel, texteHorsBornes(1));
    assert.notEqual(REVOIR.partout.partiel, texteHorsBornes(2));
  });
});

describe("« Revoir » (RevoirDialog.tsx) : sous-vue DeroulePartiel et contrôle de source", () => {
  /** Vue que RevoirDialog calcule (L28c, D-3d-12, D-3d-20) : salle → scène en Avancé et rôles par clé, puis vueSimple en Simple. */
  const vueDeRevoir = (faits: readonly ActivityFact[], salle: boolean, advanced: boolean): NeonScene => {
    const brute = scene(faits, null, { zoom: 2, mode: modeSceneRevoir({ salle, advanced }), focus: null, roleSalle: roleDeAgent });
    return salle && !advanced ? vueSimple(brute, nomsSimples(brute, true)) : brute;
  };

  it("salle en Simple (vue renommée par vueSimple), salle en Avancé, racine principale en Avancé : la sous-vue dit texteHorsBornes(vue.horsBornes)", async () => {
    const { deroule, rendre } = await charger();
    for (const [nom, faits, salle, advanced, attendu] of [
      ["salle, Simple, 60 délégations", delegations(60, "omo"), true, false, 11],
      ["salle, Simple, 4 niveaux", niveaux(4, "omo"), true, false, 1],
      ["salle, Avancé, 60 délégations", delegations(60, "omo"), true, true, 11],
      ["principale, Avancé, 60 délégations", delegations(60), false, true, 11],
      ["principale, Avancé, 4 niveaux", niveaux(4), false, true, 1],
    ] as const) {
      const vue = vueDeRevoir(faits, salle, advanced);
      assert.equal(vue.horsBornes, attendu, `${nom} : vueSimple garde horsBornes`);
      assert.equal(rendre(deroule, { horsBornes: vue.horsBornes, className: "revoir-note" }), paragraphe("revoir-note", attendu), nom);
    }
    assert.equal(rendre(deroule, { horsBornes: 0, className: "revoir-note" }), "", "rien sous la borne");
  });

  it("RevoirDialog monte DeroulePartiel avec `vue.horsBornes` de la vue MONTRÉE (après vueSimple), à côté de la note des faits partiels", () => {
    const source = fs.readFileSync(REVOIR_FILE, "utf8");
    assert.match(source, /^import \{ DeroulePartiel \} from "\.\.\/DeroulePartiel\.tsx";$/m);
    assert.match(source, /\{reponse\?\.partial === true \? <p className="revoir-note">\{T\.partiel\}<\/p> : null\}\n(?:\s*\{\/\*[^\n]*\*\/\}\n)?\s*<DeroulePartiel horsBornes=\{vue\.horsBornes\} className="revoir-note" \/>/);
    // `vue` est celle que la boîte montre : la scène, renommée par vueSimple pour la salle en Simple.
    assert.match(source, /const vue = useMemo<NeonScene>\(\(\) => \{[\s\S]*?return simpleSalle \? vueSimple\(brute, nomsSimples\(brute, true\)\) : brute;/);
    assert.equal((source.match(/<DeroulePartiel /g) ?? []).length, 1);
  });

  it("ZoomConversation monte DeroulePartiel dans l'en-tête commun à la 3D et au repli 2D (hors du choix `plan === null`)", () => {
    const source = fs.readFileSync(ZOOM_FILE, "utf8");
    const tete = source.slice(source.indexOf('<div className="zoom-conv-tete">'), source.indexOf("<ReplayBar"));
    assert.match(tete, /<DeroulePartiel horsBornes=\{vue\.horsBornes\} className="zoom-conv-note" \/>/);
    assert.equal((source.match(/<DeroulePartiel /g) ?? []).length, 1);
  });

  it("DeroulePartiel : phrase de la bande seulement, aucune région aria-live, aucune animation ni style propre", () => {
    const source = fs.readFileSync(DEROULE_FILE, "utf8");
    assert.match(source, /import \{ texteHorsBornes \} from "\.\.\/\.\.\/\.\.\/server\/shared\/neon-texts\.ts";/);
    assert.equal(/aria-live|role=|style=|animation|transition|\.css/.test(source.replace(/^\s*\/\/.*$/gm, "")), false);
  });
});
