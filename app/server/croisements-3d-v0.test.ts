// Tests de croisement du train it3 V0 (plan d'exécution it3 §2.4, §5.2, D-3d-27 ; propriété de l'intégrateur) : T3d-a (contrats,
// routes neutres, propriétés figées), T3d-b (textes), L30 (fluidité), L28a (lecteur « Revoir », légendes, accès). L32 (three,
// garde du build, P8) est croisé par ses propres tests (p8-dependances, three-guard, three-import, three-exports) et par le vrai
// build du train ; MX-3D (mesures hors dépôt) par les conséquences écrites dans EXEC/mesures/MX-3D.md.
// - Types dupliqués de la vague 0 (D-3d-27) : égaux par affectation dans les deux sens (vérifié par npm run typecheck), puis
//   remplacés par une réexportation de salle3d-types.ts, seule déclaration restante (contrôle statique, commentaires ignorés).
// - Valeurs : chaque raison de fluidité a sa phrase ; vitesses de L28a = clés de revoir-texts.vitesses ; refus de L28a = clés de
//   revoir-texts.refus ; chaque clé de légende a une phrase dans les deux modes.
// - Capture p1 rejouée par le vrai processeur (module facts) : lecteur, badges et raccourcis mis en phrases sans gabarit restant ;
//   légendes de consigne avec leur callId (U2), qui passe la validation de la route des consignes de T3d-a ; « Revoir » et ses
//   consignes lus sans requête à opencode.
// - Contrôles « sans texte » (textes-3d.test.ts) et parcours de salle-controle/ (salle3d-animations.test.ts) non sautés.
// Chaque contrôle statique est éprouvé sur un source fabriqué.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import { creerSurveillance } from "../web/pages/salle-controle/fluidite.ts";
import type { ConsigneRevoirProps, LegendeBulleProps, ReplayBarProps } from "../web/pages/salle-controle/slots-3d.ts";
import { creerControleFluidite } from "../web/pages/salle-controle/useFluidite.ts";
import type { ActivityFact, FactsResponse } from "./shared/activity-types.ts";
import * as fluidity from "./shared/fluidity.ts";
import { ID_RE, SESSION_ID_RE } from "./shared/ids.ts";
import * as legendes from "./shared/legendes.ts";
import * as legendesTexts from "./shared/legendes-texts.ts";
import type { NeonMode } from "./shared/neon-scene.ts";
import * as revoir from "./shared/revoir.ts";
import * as revoirAccess from "./shared/revoir-access.ts";
import * as revoirTexts from "./shared/revoir-texts.ts";
import * as salle3dTexts from "./shared/salle3d-texts.ts";
import type * as Ref from "./shared/salle3d-types.ts";
import type { RevoirEtatResponse } from "./shared/salle3d-types.ts";
import { startCockpit } from "./test-support/cockpit-harness.ts";
import { readCapture } from "./test-support/fake-opencode.ts";

const APP_DIR = path.join(import.meta.dirname, "..");
const lire = (relatif: string) => fs.readFileSync(path.join(APP_DIR, relatif), "utf8");

// --- Types dupliqués (D-3d-27) : affectation dans les deux sens -------------------------------------------------------------------

/**
 * Ne compile que si A s'affecte à B ET B à A (npm run typecheck ; à l'exécution, rend seulement true). Une valeur de plus ou de
 * moins dans l'une des copies fait échouer le typecheck du train.
 */
function deuxSens<A, B>(versB: (a: A) => B, versA: (b: B) => A): true {
  void versB;
  void versA;
  return true;
}

/** Égalité stricte (ni any, ni types seulement compatibles). */
type Egal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;

const TYPES_EGAUX = {
  // FluidityReason, FluidityVerdict : T3d-a = T3d-b (salle3d-texts) = L30 (fluidity).
  fluidityReasonTexts: deuxSens<Ref.FluidityReason, salle3dTexts.FluidityReason>((x) => x, (x) => x),
  fluidityReasonL30: deuxSens<Ref.FluidityReason, fluidity.FluidityReason>((x) => x, (x) => x),
  fluidityVerdictTexts: deuxSens<Ref.FluidityVerdict, salle3dTexts.FluidityVerdict>((x) => x, (x) => x),
  fluidityVerdictL30: deuxSens<Ref.FluidityVerdict, fluidity.FluidityVerdict>((x) => x, (x) => x),
  // ReplaySpeed, ReplayBadge : T3d-a = T3d-b (revoir-texts) = L28a (revoir).
  replaySpeedTexts: deuxSens<Ref.ReplaySpeed, revoirTexts.ReplaySpeed>((x) => x, (x) => x),
  replaySpeedL28a: deuxSens<Ref.ReplaySpeed, revoir.ReplaySpeed>((x) => x, (x) => x),
  replayBadgeTexts: deuxSens<Ref.ReplayBadge, revoirTexts.ReplayBadge>((x) => x, (x) => x),
  replayBadgeL28a: deuxSens<Ref.ReplayBadge, revoir.ReplayBadge>((x) => x, (x) => x),
  // LegendeKey : T3d-a = T3d-b (legendes-texts) = L28a (legendes).
  legendeKeyTexts: deuxSens<Ref.LegendeKey, legendesTexts.LegendeKey>((x) => x, (x) => x),
  legendeKeyL28a: deuxSens<Ref.LegendeKey, legendes.LegendeKey>((x) => x, (x) => x),
  // RevoirRefus : T3d-a = T3d-b (revoir-texts) = L28a (revoir-access).
  revoirRefusTexts: deuxSens<Ref.RevoirRefus, revoirTexts.RevoirRefus>((x) => x, (x) => x),
  revoirRefusL28a: deuxSens<Ref.RevoirRefus, revoirAccess.RevoirRefus>((x) => x, (x) => x),
};

const EGALITES_STRICTES: Record<string, true> = {
  fluidityReason: true satisfies Egal<Ref.FluidityReason, fluidity.FluidityReason> & Egal<Ref.FluidityReason, salle3dTexts.FluidityReason>,
  fluidityVerdict: true satisfies Egal<Ref.FluidityVerdict, fluidity.FluidityVerdict> & Egal<Ref.FluidityVerdict, salle3dTexts.FluidityVerdict>,
  replaySpeed: true satisfies Egal<Ref.ReplaySpeed, revoir.ReplaySpeed> & Egal<Ref.ReplaySpeed, revoirTexts.ReplaySpeed>,
  replayBadge: true satisfies Egal<Ref.ReplayBadge, revoir.ReplayBadge> & Egal<Ref.ReplayBadge, revoirTexts.ReplayBadge>,
  legendeKey: true satisfies Egal<Ref.LegendeKey, legendes.LegendeKey> & Egal<Ref.LegendeKey, legendesTexts.LegendeKey>,
  revoirRefus: true satisfies Egal<Ref.RevoirRefus, revoirAccess.RevoirRefus> & Egal<Ref.RevoirRefus, revoirTexts.RevoirRefus>,
  // Types de sortie des modules : ceux de la référence (RevoirAcces de L28a et RevoirResult de T3d-a disent les mêmes codes).
  accesCode: true satisfies Egal<Extract<revoirAccess.RevoirAcces, { ok: false }>["code"], Ref.RevoirRefus>,
  verdictCapacites: true satisfies Egal<ReturnType<typeof fluidity.verdictCapacites>, Ref.FluidityVerdict>,
  badge: true satisfies Egal<ReturnType<typeof revoir.badge>, Ref.ReplayBadge>,
  legendeCles: true satisfies Egal<legendes.Legende["cles"][number], Ref.LegendeKey>,
};

// --- Valeurs de la référence, exhaustives par construction ------------------------------------------------------------------------

const RAISONS = Object.keys({
  accessibilite: true,
  "webgl-absent": true,
  "rendu-logiciel": true,
  "sonde-lente": true,
  saccades: true,
  "preference-2d": true,
} satisfies Record<Ref.FluidityReason, true>) as Ref.FluidityReason[];

const VITESSES = Object.keys({ "0.25": true, "0.5": true, "1": true, "2": true, "4": true } satisfies Record<`${Ref.ReplaySpeed}`, true>)
  .map(Number)
  .sort((a, b) => a - b) as Ref.ReplaySpeed[];

const REFUS = Object.keys({ "racine-inconnue": true, "salle-demande-en-cours": true, "salle-fin-inconnue": true } satisfies Record<Ref.RevoirRefus, true>) as Ref.RevoirRefus[];

const CLES = Object.keys({
  neuf: true,
  reprise: true,
  carnet: true,
  "tache-de-fond": true,
  reveil: true,
  relance: true,
} satisfies Record<Ref.LegendeKey, true>) as Ref.LegendeKey[];

const MODES: readonly NeonMode[] = ["simple", "avance"];

// --- Contrôle statique des réexportations (commentaires ignorés) ------------------------------------------------------------------

const NOMS_PARTAGES = ["FluidityReason", "FluidityVerdict", "ReplaySpeed", "ReplayBadge", "LegendeKey", "RevoirRefus"] as const;

/** Fichiers qui portaient une copie en vague 0, et les types qu'ils réexportent de salle3d-types.ts depuis le train. */
const REEXPORTS: Readonly<Record<string, readonly string[]>> = {
  "server/shared/salle3d-texts.ts": ["FluidityReason", "FluidityVerdict"],
  "server/shared/fluidity.ts": ["FluidityReason", "FluidityVerdict"],
  "server/shared/revoir-texts.ts": ["ReplaySpeed", "ReplayBadge", "RevoirRefus"],
  "server/shared/revoir.ts": ["ReplaySpeed", "ReplayBadge"],
  "server/shared/legendes-texts.ts": ["LegendeKey"],
  "server/shared/legendes.ts": ["LegendeKey"],
  "server/shared/revoir-access.ts": ["RevoirRefus"],
};

const REFERENCE = "server/shared/salle3d-types.ts";

/** Source sans commentaires (// et /* … *\/), chaînes laissées telles quelles (recopié de salle3d-contrats.test.ts). */
function sansCommentaires(text: string): string {
  let out = "";
  for (let i = 0; i < text.length; ) {
    if (text.startsWith("//", i)) {
      const end = text.indexOf("\n", i);
      i = end === -1 ? text.length : end;
    } else if (text.startsWith("/*", i)) {
      const end = text.indexOf("*/", i + 2);
      i = end === -1 ? text.length : end + 2;
    } else {
      out += text[i];
      i++;
    }
  }
  return out;
}

/** Déclarations locales (type X = …, interface X) des six types partagés. */
function declarationsLocales(source: string): string[] {
  const code = sansCommentaires(source);
  return [...code.matchAll(new RegExp(`\\b(?:type|interface)\\s+(${NOMS_PARTAGES.join("|")})\\b\\s*[=<{]`, "g"))].map((m) => m[1] ?? "");
}

const noms = (liste: string) =>
  liste
    .split(",")
    .map((nom) => nom.trim())
    .filter((nom) => nom !== "");

/**
 * Types réexportés de salle3d-types.ts : `import type { … } from "./salle3d-types.ts"` suivi de `export type { … };` (les deux
 * listes), ou `export type { … } from "./salle3d-types.ts"`. Un import de valeur (sans `type`) n'est pas compté.
 */
function reexportations(source: string): string[] {
  const code = sansCommentaires(source);
  const importes = new Set([...code.matchAll(/^\s*import\s+type\s*\{([^}]*)\}\s*from\s*["']\.\/salle3d-types\.ts["']/gm)].flatMap((m) => noms(m[1] ?? "")));
  const exportes = [...code.matchAll(/^\s*export\s+type\s*\{([^}]*)\}\s*;/gm)].flatMap((m) => noms(m[1] ?? "")).filter((nom) => importes.has(nom));
  const directs = [...code.matchAll(/^\s*export\s+type\s*\{([^}]*)\}\s*from\s*["']\.\/salle3d-types\.ts["']/gm)].flatMap((m) => noms(m[1] ?? ""));
  return [...new Set([...exportes, ...directs])].sort();
}

/** Sources de production (.ts, .tsx, hors tests et test-support) sous server/ et web/, relatives à app/. */
function sourcesProduction(): string[] {
  const out: string[] = [];
  for (const racine of ["server", "web"]) {
    for (const entree of fs.readdirSync(path.join(APP_DIR, racine), { recursive: true }) as string[]) {
      const relatif = `${racine}/${entree.replaceAll("\\", "/")}`;
      if (!/\.tsx?$/.test(relatif) || /\.test\.tsx?$/.test(relatif) || relatif.includes("/test-support/") || relatif.endsWith(".d.ts")) continue;
      out.push(relatif);
    }
  }
  return out.sort();
}

describe("croisements 3d V0 : types dupliqués (D-3d-27)", () => {
  it("les contrôles statiques échouent sur des sources fabriqués", () => {
    assert.deepEqual(declarationsLocales('// copie D-3d-27, remplacée au train de V0\nexport type FluidityReason = "a" | "b";'), ["FluidityReason"]);
    assert.deepEqual(declarationsLocales("interface LegendeKey {\n  a: 1;\n}"), ["LegendeKey"]);
    assert.deepEqual(declarationsLocales("type ReplayBadge<T> = T;"), ["ReplayBadge"]);
    assert.deepEqual(declarationsLocales('// export type RevoirRefus = "x";\n/* type ReplaySpeed = 1; */\nexport type Autre = 1;'), []);
    assert.deepEqual(reexportations('import type { FluidityReason, FluidityVerdict } from "./salle3d-types.ts";\nexport type { FluidityReason, FluidityVerdict };'), [
      "FluidityReason",
      "FluidityVerdict",
    ]);
    assert.deepEqual(reexportations('export type { LegendeKey } from "./salle3d-types.ts";'), ["LegendeKey"]);
    assert.deepEqual(reexportations('import { FluidityReason } from "./salle3d-types.ts";\nexport type { FluidityReason };'), [], "import de valeur");
    assert.deepEqual(reexportations('import type { RevoirRefus } from "./salle3d-types.ts";'), [], "importé sans être réexporté");
    assert.deepEqual(reexportations('import type { RevoirRefus } from "./autre.ts";\nexport type { RevoirRefus };'), [], "autre source");
    assert.deepEqual(reexportations('// import type { LegendeKey } from "./salle3d-types.ts";\n// export type { LegendeKey };'), [], "commentaires");
  });

  it("égaux par affectation dans les deux sens et à l'identique (typecheck du train)", () => {
    assert.ok(Object.values(TYPES_EGAUX).every((v) => v === true));
    assert.equal(Object.keys(TYPES_EGAUX).length, 12);
    assert.ok(Object.values(EGALITES_STRICTES).every((v) => v === true));
  });

  it("copies remplacées : chaque fichier réexporte ses types de salle3d-types.ts, sans déclaration ni commentaire de copie", () => {
    for (const [fichier, attendus] of Object.entries(REEXPORTS)) {
      const source = lire(fichier);
      assert.deepEqual(declarationsLocales(source), [], `${fichier} : déclaration locale restante`);
      assert.deepEqual(reexportations(source), [...attendus].sort(), `${fichier} : réexportations`);
      assert.equal(source.includes("copie D-3d-27"), false, `${fichier} : commentaire de copie restant`);
    }
  });

  it("salle3d-types.ts est la seule déclaration des six types dans les sources de production (server/ et web/)", () => {
    const sources = sourcesProduction();
    assert.ok(sources.includes(REFERENCE) && sources.length > 100, "parcours non vide");
    const trouvees = sources.flatMap((fichier) => declarationsLocales(lire(fichier)).map((nom) => `${fichier} : ${nom}`));
    assert.deepEqual([...trouvees].sort(), NOMS_PARTAGES.map((nom) => `${REFERENCE} : ${nom}`).sort(), "déclarations");
    assert.deepEqual(
      sources.filter((fichier) => lire(fichier).includes("copie D-3d-27")),
      [],
      "aucun commentaire de copie ne reste",
    );
  });
});

describe("croisements 3d V0 : valeurs des types partagés et leurs phrases", () => {
  it("fluidité : chaque raison (référence) est dans RAISONS_FLUIDITE (L30) et a sa phrase (T3d-b), l.1007 partagée par la sonde et la bascule", () => {
    assert.deepEqual([...fluidity.RAISONS_FLUIDITE].sort(), [...RAISONS].sort());
    const phrases = RAISONS.map((raison) => salle3dTexts.messageFluidite(raison));
    // Seules la sonde lente et la bascule automatique partagent leur phrase (spéc. l.1007) ; toute autre paire est distincte.
    assert.equal(new Set(phrases).size, RAISONS.length - 1, "une phrase par raison, l.1007 pour « sonde-lente » et « saccades »");
    for (const [i, a] of RAISONS.entries()) {
      for (const b of RAISONS.slice(i + 1)) {
        const partagee = [a, b].sort().join(" ") === "saccades sonde-lente";
        assert.equal(phrases[i] === salle3dTexts.messageFluidite(b), partagee, `${a} / ${b}`);
      }
    }
    for (const [i, phrase] of phrases.entries()) {
      assert.notEqual(phrase, salle3dTexts.TEXTES.partout.fluidite.autre, RAISONS[i]);
      assert.doesNotMatch(phrase, /[{}]/, RAISONS[i]);
    }
  });

  it("fluidité : proposition au présent pendant la 3D, phrase de spéc. l.1007 après la bascule automatique (L30 → T3d-b)", async () => {
    let t = 1_000;
    const controle = creerControleFluidite({
      capacites: () => ({ mouvementReduit: false, couleursForcees: false, webgl2: true, contexteRefuse: false, moteur: "Radeon" }),
      preference: () => fluidity.preferenceAuto(),
      enregistrer: () => undefined,
      sonder: () => Promise.resolve(Array.from({ length: 90 }, () => 12)),
      surveillance: () => creerSurveillance(() => (t += 40)),
      marquer: () => undefined,
    });
    controle.ouvrir();
    controle.pret({ renderFrame: () => undefined });
    await new Promise<void>((resoudre) => setImmediate(resoudre));
    assert.deepEqual(controle.etat().verdict, { mode: "3d" }, "sonde fluide");
    let proposee = false;
    for (let i = 0; i < 400 && controle.etat().verdict.mode === "3d"; i++) {
      controle.image(40, true);
      if (controle.etat().proposition) {
        proposee = true;
        // Proposition : la vue est encore en 3D, la page montre le texte au présent avec [Passer en 2D] et [Rester en 3D].
        assert.equal(controle.etat().verdict.mode, "3d");
      }
    }
    assert.ok(proposee, "proposition avant la bascule");
    const verdict = controle.etat().verdict;
    assert.deepEqual(verdict, { mode: "2d", raison: "saccades" }, "bascule automatique");
    if (verdict.mode !== "2d") return;
    assert.equal(salle3dTexts.messageFluidite(verdict.raison), "La 3D n'était pas fluide sur ce poste");
    assert.notEqual(salle3dTexts.messageFluidite(verdict.raison), salle3dTexts.TEXTES.partout.fluidite.saccades);
    controle.fermer();
  });

  it("fluidité : tout verdict 2D de verdictCapacites (L30) et toute préférence relue ont une phrase (T3d-b)", () => {
    const vus = new Set<Ref.FluidityReason>();
    for (const mouvementReduit of [false, true]) {
      for (const couleursForcees of [false, true]) {
        for (const webgl2 of [false, true]) {
          for (const contexteRefuse of [false, true]) {
            for (const moteur of [null, "ANGLE (NVIDIA, NVIDIA GeForce RTX 5090 Direct3D11 vs_5_0 ps_5_0, D3D11)", "ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero)))"]) {
              for (const preference of ["auto", "2d"] as const) {
                const verdict: Ref.FluidityVerdict = fluidity.verdictCapacites({ mouvementReduit, couleursForcees, webgl2, contexteRefuse, moteur, preference });
                if (verdict.mode === "3d") continue;
                vus.add(verdict.raison);
                assert.notEqual(salle3dTexts.messageFluidite(verdict.raison), salle3dTexts.TEXTES.partout.fluidite.autre, verdict.raison);
              }
            }
          }
        }
      }
    }
    assert.deepEqual([...vus].sort(), ["accessibilite", "preference-2d", "rendu-logiciel", "webgl-absent"], "raisons atteintes à l'ouverture");
    for (const raison of RAISONS) {
      const relue = fluidity.lirePreference(fluidity.ecrirePreference("2d", raison, 1_000));
      assert.equal(relue.raison, raison);
      assert.notEqual(salle3dTexts.messageFluidite(relue.raison ?? raison), salle3dTexts.TEXTES.partout.fluidite.autre);
    }
  });

  it("lecteur : VITESSES (L28a) = référence = clés de revoir-texts.vitesses (T3d-b), une étiquette chacune", () => {
    assert.deepEqual([...revoir.VITESSES], VITESSES);
    assert.deepEqual(Object.keys(revoirTexts.TEXTES.partout.vitesses).sort(), VITESSES.map(String).sort());
    for (const v of VITESSES) {
      const etat = revoir.choisirVitesse(revoir.ouvrir([], null), v);
      assert.equal(etat.vitesse, v);
      assert.equal(revoirTexts.formatVitesse(etat.vitesse), revoirTexts.TEXTES.partout.vitesses[String(v) as `${Ref.ReplaySpeed}`]);
    }
  });

  it("refus : codes de revoirAcces (L28a) = référence = clés de revoir-texts.refus (T3d-b), une phrase connue chacun", () => {
    assert.deepEqual(Object.keys(revoirTexts.TEXTES.partout.refus).sort(), [...REFUS].sort());
    const codes = new Set<Ref.RevoirRefus>();
    for (const existe of [false, true]) {
      for (const instance of ["principale", "omo", null] as const) {
        for (const mode of MODES) {
          for (const sessionsOccupees of [null, 0, 1]) {
            for (const derniereDemande of [null, { finie: false }, { finie: true }]) {
              const acces = revoirAccess.revoirAcces({ existe, instance, mode, sessionsOccupees, derniereDemande });
              if (!acces.ok) codes.add(acces.code);
            }
          }
        }
      }
    }
    assert.deepEqual([...codes].sort(), [...REFUS].sort(), "chaque code est atteint");
    for (const code of REFUS) assert.notEqual(revoirTexts.libelleRefus(code), revoirTexts.TEXTES.partout.refusInconnu, code);
  });

  it("légendes : chaque clé (référence) a une phrase dans les deux modes (phrasesLegende, T3d-b) ; « neuf » jamais dit avec « reprise »", () => {
    for (const cle of CLES) {
      for (const mode of MODES) {
        const phrases = legendesTexts.phrasesLegende([cle], mode);
        assert.equal(phrases.length, 1, `${cle} ${mode}`);
        assert.ok((phrases[0] ?? "").length > 0 && !/[{}]/.test(phrases[0] ?? ""), `${cle} ${mode}`);
      }
    }
    assert.deepEqual(legendesTexts.phrasesLegende(["neuf", "reprise"], "simple"), [legendesTexts.TEXTES.partout.reprise]);
    assert.equal(legendes.LEGENDE_CLES_MAX, 2);
  });
});

// --- Capture p1 rejouée par le vrai processeur ------------------------------------------------------------------------------------

/** Attente d'une condition lue par une requête (recopié de croisements-it1-v2.test.ts). */
async function untilAsync<T>(read: () => Promise<T | undefined | null | false>, timeoutMs = 5000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await read();
    if (value !== undefined && value !== null && value !== false) return value;
    if (Date.now() > deadline) throw new Error("condition non atteinte à temps");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

/** Racine des captures p1, p6 et p7 (expérience « ocgraph », opencode 1.18.30). */
const ROOT = "ses_f618ff214ffevi6gfuGx6TvpTP";
/** Demande de p1, envoyée par le proxy du cockpit (fait origine « demande »). */
const P1_MESSAGE = { created: 1789364546638 };

describe("croisements 3d V0 : p1 rejouée (processeur réel), lecteur, légendes de consigne et routes de « Revoir »", () => {
  it("demande, badges, raccourcis et légendes mis en phrases ; callId (U2) accepté par la route des consignes ; zéro requête à opencode", async (t) => {
    const h = await startCockpit(t, { modules: ["facts"] });
    h.ledger.recordChatTurn({ session_id: ROOT, created_at: P1_MESSAGE.created - 40, kind: "message", agent: "orchestrateur", command: null, tier: null, model: null, variant: null, runs: [] });
    for (const { wire } of readCapture("p1-delegation-parallele.jsonl")) h.fake.emitRaw(wire);
    const lireFaits = async (): Promise<ActivityFact[]> => {
      const res = await h.call("GET", `/api/conversations/${ROOT}/facts?since=0`, { headers: h.headers.authed });
      assert.equal(res.status, 200, res.body);
      const body = res.json<FactsResponse>();
      assert.equal(body.partial, false);
      return body.facts;
    };
    const faits = await untilAsync(async () => {
      const lus = await lireFaits();
      return lus.filter((f) => f.kind === "resultat").length === 2 && lus.at(-1)?.kind === "statut" && lus.at(-1)?.data.etat === "repos" ? lus : null;
    }, 10_000);

    // Lecteur (L28a) → textes (T3d-b) → barre (T3d-a).
    const demandes = revoir.demandes(faits, ROOT);
    assert.equal(demandes.length, 1, "une demande dans p1");
    const ouvert = revoir.ouvrir(faits, demandes[0] ?? null);
    assert.ok(ouvert.moments.length > 3, "plusieurs moments");
    for (let i = 0; i < ouvert.moments.length; i++) {
      const etat = revoir.aller(ouvert, i);
      const delai = revoir.delaiSuivant(etat);
      const barre: Pick<ReplayBarProps, "index" | "total" | "heure" | "vitesse" | "lecture" | "direct" | "raccourciMs"> = {
        index: etat.index,
        total: etat.moments.length,
        heure: revoir.instant(etat),
        vitesse: etat.vitesse,
        lecture: etat.lecture,
        direct: etat.direct,
        raccourciMs: delai?.raccourciMs ?? null,
      };
      assert.equal(barre.index, i);
      const badge: Ref.ReplayBadge = revoir.badge(etat);
      assert.match(revoirTexts.libelleBadge(badge, 120), /^EN DIFFÉRÉ ×1 · \d\d:\d\d:\d\d$/);
      if (barre.raccourciMs !== null) assert.doesNotMatch(revoirTexts.libelleRaccourci(barre.raccourciMs), /[{}]/);
      assert.equal(delai === null, i === ouvert.moments.length - 1, "aucun délai au dernier moment seulement");
    }
    assert.equal(revoirTexts.libelleBadge(revoir.badge(revoir.auDirect(ouvert)), 120), revoirTexts.TEXTES.partout.badgeDirect);

    // Légendes (L28a) → phrases (T3d-b) → bulle et panneau de consigne (T3d-a) ; callId de chaque consigne envoyée (U2).
    const envoyees = faits.filter((f) => f.kind === "consigne" && f.data.etat === "envoyee");
    assert.equal(envoyees.length, 2, "deux consignes envoyées dans p1");
    for (const salle of [false, true]) {
      const deConsigne = revoir
        .ouvrir(faits, null)
        .moments.flatMap((t) => legendes.legendesAuMoment(faits, t, { salle }))
        .filter((l) => l.callId !== null);
      assert.deepEqual(
        deConsigne.map((l) => l.callId).sort(),
        envoyees.map((f) => String(f.data.callId)).sort(),
        `une légende par consigne envoyée, avec son callId (salle : ${salle})`,
      );
      for (const legende of deConsigne) {
        const callId = legende.callId ?? "";
        assert.match(callId, ID_RE, "callId accepté par la route des consignes");
        assert.match(legende.sessionId, SESSION_ID_RE, "enfant accepté par ?enfant=");
        assert.deepEqual(legende.cles, salle ? ["neuf", "carnet"] : ["neuf"], "enfants neufs dans p1");
        for (const mode of MODES) {
          const bulle: LegendeBulleProps = { cles: legende.cles, salle, mode, onVoirConsigne: () => {} };
          assert.equal(legendesTexts.phrasesLegende(bulle.cles, bulle.mode).length, legende.cles.length, `${mode} ${salle}`);
        }
        const panneau: ConsigneRevoirProps = { rootId: ROOT, cible: { callId }, onFermer: () => {} };
        assert.ok("callId" in panneau.cible);
      }
    }

    // Routes de « Revoir » (T3d-a, montées par app-factory) sur la vraie racine : identifiants acceptés, codes mis en phrases, aucune
    // requête à opencode (lecture seule). Les statuts exacts sont ceux des ports (neutres en V0, réels en V1) : jamais 400 ici.
    const depuis = h.fake.requests.length;
    const get = (chemin: string) => h.call("GET", chemin, { headers: h.headers.authed });
    const complet = await get(`/api/revoir/${ROOT}`);
    assert.ok([200, 403, 404].includes(complet.status), `revoir : ${complet.status}`);
    if (complet.status !== 200) {
      const code = complet.json<{ code: Ref.RevoirRefus }>().code;
      assert.ok(REFUS.includes(code), code);
      assert.notEqual(revoirTexts.libelleRefus(code), revoirTexts.TEXTES.partout.refusInconnu);
    }
    const etat = await get(`/api/revoir/${ROOT}?etat=1`);
    assert.equal(etat.status, 200);
    const acces = etat.json<RevoirEtatResponse>();
    assert.equal(acces.acces, acces.raison === null);
    if (acces.raison !== null) assert.ok(REFUS.includes(acces.raison), acces.raison);
    for (const fait of envoyees) {
      const consigne = await get(`/api/revoir/${ROOT}/consignes/${String(fait.data.callId)}`);
      assert.ok([200, 403, 404].includes(consigne.status), `consigne ${String(fait.data.callId)} : ${consigne.status}`);
      const parEnfant = await get(`/api/revoir/${ROOT}/consignes?enfant=${String(fait.data.enfant)}`);
      assert.ok([200, 403, 404].includes(parEnfant.status), `?enfant=${String(fait.data.enfant)} : ${parEnfant.status}`);
    }
    assert.deepEqual(h.fake.requests.slice(depuis).map((r) => `${r.method} ${r.pathname}`), [], "aucune requête à opencode pendant « Revoir »");
  });
});

// --- Contrôles de la vague qui ne doivent plus être sautés --------------------------------------------------------------------------

describe("croisements 3d V0 : contrôles non sautés après fusion", () => {
  it("textes-3d.test.ts : modules « sans texte » de L28a présents et listés (contrôle non sauté)", () => {
    const source = lire("server/textes-3d.test.ts");
    for (const fichier of ["legendes.ts", "revoir.ts", "revoir-access.ts"]) {
      assert.ok(fs.existsSync(path.join(APP_DIR, "server", "shared", fichier)), fichier);
      assert.ok(source.includes(`{ fichier: "${fichier}", paquet: "L28a" }`), `${fichier} listé`);
    }
  });

  it("salle3d-animations.test.ts : web/pages/salle-controle/ existe et porte les fichiers de T3d-a et de L30 (parcours réel)", () => {
    const dossier = path.join(APP_DIR, "web", "pages", "salle-controle");
    assert.ok(fs.existsSync(dossier));
    const fichiers = (fs.readdirSync(dossier, { recursive: true }) as string[]).map((f) => f.replaceAll("\\", "/"));
    for (const attendu of ["SalleControlePage.tsx", "Scene3d.tsx", "moteur-chargeur.ts", "three/moteur.ts", "revoir/ReplayBar.tsx", "fluidite.ts", "useFluidite.ts"]) {
      assert.ok(fichiers.includes(attendu), attendu);
    }
  });
});
