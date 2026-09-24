// Référence du manifeste de l'image opencode-omo contre les SOURCES du dépôt (plan 2 bis-2 ter, fiche L21b ; reste R-1 de la
// clôture 2 bis, constats-salle-2bis.md ; D-2b-32).
//
// Pourquoi ce test existe. Le commit 91cce89 a modifié quatre fichiers copiés tels quels dans l'image (`opencode.jsonc`,
// `omo.jsonc`, `supervisor.sh`, `guard/cockpit-guard.js`) sans régénérer `omo-manifest.sha256` ; son message affirmait
// qu'« aucun test ne peut l'attraper hors de l'image ». C'est faux : chacun de ces fichiers est copié OCTET POUR OCTET du
// dossier `docker/opencode-omo` vers un chemin du périmètre du manifeste, et la référence porte l'empreinte SHA-256 de ce
// chemin. Hacher la source et la comparer à la ligne de sa destination suffit, sans Docker, sans image, sans réseau.
//
// Ce que le test tient :
// - chaque COPY du Dockerfile dont la destination tombe dans `perimetreManifeste` (contrat-salle.json) a SA ligne dans la
//   référence, et cette ligne porte l'empreinte de la source telle qu'elle est dans le dépôt ;
// - les deux fichiers que l'image écrit elle-même à partir d'entrées du dépôt sont recalculés de la même façon :
//   `/etc/opencode-omo/image-id` (version, empreinte de l'image de base lue dans l'en-tête de la référence, empreinte du
//   lockfile) et `/etc/opencode-omo/.gitignore` (texte fixe du Dockerfile) ;
// - aucune source n'est ignorée en silence : une destination du périmètre qui n'a pas de ligne est un écart.
//
// Ce qu'il ne tient PAS, et qui reste au banc et au script de construction : `/opt/omo/node_modules/**` (ce que `npm ci`
// installe dans l'image) et les lignes `meta` (droits et propriétaires). Une modification de `package-lock.json` est vue ici
// par deux lignes : la copie de `/opt/omo/package-lock.json` et `image-id`.
//
// En cas d'échec : une source livrée a changé sans `build-omo-image.ps1 -AcceptManifest`. Le superviseur d'une image
// reconstruite refuserait de démarrer (manifeste différent de la référence). Relancer l'amorçage, relire le diff de la
// référence, et commiter les deux ensemble.
//
// Contre-épreuve faite à l'écriture (L21b, execution/mesures/L21b.md) : la même comparaison, jouée sur l'arbre de 91cce89,
// rend exactement quatre écarts — les quatre fichiers nommés par la revue — et zéro sur fde7eca, qui a régénéré la référence,
// comme sur la tête de la vague 3 (7e5f9c4).
//
// Rapport au croisement n° 11 du train de V3 (croisements-2bis-v3.test.ts, e5fe0cf), posé entre-temps pour l'écart n° 4 de
// L16c : il tient déjà la ligne de chaque COPIE du périmètre. Ce fichier-ci le complète sans le dupliquer dans son principe :
// les deux fichiers que l'image ÉCRIT elle-même à partir d'entrées du dépôt (`image-id`, `.gitignore`), le périmètre lu dans
// le CONTRAT (pas une liste recopiée), le rejeu en mémoire de 91cce89 et de chaque autre forme de dérive, et le « fermé en cas
// de doute » sur une forme du Dockerfile qu'on ne sait plus recalculer.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import { OMO_SALLE_CONTRACT_FILE } from "./omo-contracts.ts";
import type { OmoSalleContract } from "./shared/omo-types.ts";

const RACINE_DEPOT = path.join(import.meta.dirname, "..", "..");
const DOCKER_OMO = path.join(RACINE_DEPOT, "docker", "opencode-omo");

const octets = (relatif: string): Buffer => fs.readFileSync(path.join(DOCKER_OMO, ...relatif.split("/")));
const sha256 = (donnees: Buffer | string): string => createHash("sha256").update(donnees).digest("hex");

// --- Lecture du Dockerfile, de la référence et du contrat -----------------------------------------------------------------

/** Instructions du Dockerfile : lignes jointes aux « \ » de fin, commentaires retirés (comme Docker, et comme omo-image.test.ts). */
export function instructionsDockerfile(texte: string): { cmd: string; args: string }[] {
  const sortie: { cmd: string; args: string }[] = [];
  let courante: { cmd: string; args: string } | null = null;
  for (const brute of texte.split("\n")) {
    const ligne = brute.replace(/\r$/, "");
    if (/^\s*#/.test(ligne) || (courante === null && ligne.trim() === "")) continue;
    let reste = ligne;
    if (courante === null) {
      const m = /^\s*([A-Za-z]+)\s*(.*)$/.exec(ligne);
      assert.ok(m, `instruction illisible : ${ligne}`);
      courante = { cmd: (m[1] ?? "").toUpperCase(), args: "" };
      reste = m[2] ?? "";
    }
    if (reste.endsWith("\\")) {
      courante.args += `${reste.slice(0, -1).trim()} `;
    } else {
      courante.args = `${courante.args}${reste.trim()}`.trim();
      sortie.push(courante);
      courante = null;
    }
  }
  assert.equal(courante, null, "instruction non terminée à la fin du Dockerfile");
  return sortie;
}

/**
 * Copies du Dockerfile : destination de chaque fichier → source, relative au contexte de construction (docker/opencode-omo).
 * `COPY --from=…` vient d'une autre étape, pas du dépôt : écartée (le manifeste de l'image la tient, pas ce test). La forme JSON
 * (`COPY ["a", "b"]`) n'est pas lue : elle lève, pour que le test tombe au lieu de sauter une source en silence.
 */
export function copiesDockerfile(texte: string): Map<string, string> {
  const map = new Map<string, string>();
  for (const { cmd, args } of instructionsDockerfile(texte)) {
    if (cmd !== "COPY") continue;
    if (/(^|\s)--from=/.test(args)) continue;
    assert.ok(!args.trimStart().startsWith("["), `forme JSON de COPY non lue par ce test : ${args}`);
    const mots = args.split(/\s+/).filter((m) => m !== "" && !m.startsWith("--"));
    const dest = mots.pop() ?? "";
    assert.ok(mots.length > 0, `COPY sans source : ${args}`);
    if (dest.endsWith("/")) for (const source of mots) map.set(`${dest}${path.posix.basename(source)}`, source);
    else {
      assert.equal(mots.length, 1, `COPY vers un fichier avec plusieurs sources : ${args}`);
      map.set(dest, mots[0] ?? "");
    }
  }
  return map;
}

/** Lignes d'empreinte de la référence : chemin de l'image → SHA-256 (format de sha256sum, deux espaces). */
export function empreintesReference(texte: string): Map<string, string> {
  const map = new Map<string, string>();
  for (const brute of texte.split("\n")) {
    const m = /^([0-9a-f]{64}) {2}(\/.+)$/.exec(brute.replace(/\r$/, ""));
    if (m) map.set(m[2] ?? "", m[1] ?? "");
  }
  return map;
}

/** Empreinte de l'image de base, lue dans l'en-tête que `-AcceptManifest` écrit (« # Image de base : …@sha256:<64 hex> »). */
export function baseDeLaReference(texte: string): string | null {
  return /^# Image de base : \S+@sha256:([0-9a-f]{64})\r?$/m.exec(texte)?.[1] ?? null;
}

const dansLePerimetre = (chemin: string, perimetre: readonly string[]): boolean => perimetre.some((p) => chemin === p || chemin.startsWith(`${p}/`));

// --- Comparaison (pure) -----------------------------------------------------------------------------------------------------

export interface EntreesManifeste {
  dockerfile: string;
  reference: string;
  perimetre: readonly string[];
  /** Octets d'une source du contexte de construction (chemin relatif à docker/opencode-omo, barres obliques). */
  source(relatif: string): Buffer;
}

export interface EcartManifeste {
  chemin: string;
  raison: "ligne-absente" | "empreinte-differente" | "base-illisible" | "format-inconnu";
  source: string;
}

/**
 * Écarts entre les sources du dépôt et la référence du manifeste. Vide : la référence est à jour pour tout ce que le dépôt
 * décide. Fermé en cas de doute : un format du Dockerfile qu'on ne sait pas recalculer (image-id, .gitignore) est un écart,
 * jamais un saut silencieux.
 */
export function ecartsDuManifeste(e: EntreesManifeste): EcartManifeste[] {
  const ecarts: EcartManifeste[] = [];
  const lignes = empreintesReference(e.reference);
  const comparer = (chemin: string, source: string, contenu: Buffer | string): void => {
    const attendue = lignes.get(chemin);
    if (attendue === undefined) ecarts.push({ chemin, raison: "ligne-absente", source });
    else if (attendue !== sha256(contenu)) ecarts.push({ chemin, raison: "empreinte-differente", source });
  };

  // 1. Copies octet pour octet.
  for (const [destination, source] of copiesDockerfile(e.dockerfile)) {
    if (!dansLePerimetre(destination, e.perimetre)) continue;
    comparer(destination, source, e.source(source));
  }

  // 2. Fichiers écrits par l'image à partir d'entrées du dépôt.
  const runs = instructionsDockerfile(e.dockerfile)
    .filter((i) => i.cmd === "RUN")
    .map((i) => i.args)
    .join("\n");
  // `(?![\w.-])` : la destination entière, jamais un préfixe (`image-id.txt` n'est pas `image-id`).
  const gitignore = /printf '%s\\n' "([^"]*)" > \/etc\/opencode-omo\/\.gitignore(?![\w.-])/.exec(runs);
  if (gitignore === null) ecarts.push({ chemin: "/etc/opencode-omo/.gitignore", raison: "format-inconnu", source: "Dockerfile" });
  else comparer("/etc/opencode-omo/.gitignore", "Dockerfile", `${gitignore[1] ?? ""}\n`);

  const imageId = /printf '(oh-my-openagent@[0-9.]+) base=sha256:%s lock=sha256:%s\\n'[^>]*> \/etc\/opencode-omo\/image-id(?![\w.-])/.exec(runs);
  const base = baseDeLaReference(e.reference);
  if (imageId === null) ecarts.push({ chemin: "/etc/opencode-omo/image-id", raison: "format-inconnu", source: "Dockerfile" });
  else if (base === null) ecarts.push({ chemin: "/etc/opencode-omo/image-id", raison: "base-illisible", source: "omo-manifest.sha256" });
  else comparer("/etc/opencode-omo/image-id", "package-lock.json", `${imageId[1]} base=sha256:${base} lock=sha256:${sha256(e.source("package-lock.json"))}\n`);

  return ecarts;
}

// --- Le dépôt tel qu'il est -----------------------------------------------------------------------------------------------

const CONTRAT = JSON.parse(fs.readFileSync(path.join(RACINE_DEPOT, OMO_SALLE_CONTRACT_FILE), "utf8")) as OmoSalleContract;
const DOCKERFILE = octets("Dockerfile").toString("utf8");
const REFERENCE = octets("omo-manifest.sha256").toString("utf8");

const entreesDuDepot = (remplacements: Partial<EntreesManifeste> = {}, sources: Record<string, Buffer> = {}): EntreesManifeste => ({
  dockerfile: DOCKERFILE,
  reference: REFERENCE,
  perimetre: CONTRAT.perimetreManifeste,
  source: (relatif) => sources[relatif] ?? octets(relatif),
  ...remplacements,
});

describe("R-1 : la référence du manifeste suit les sources du dépôt copiées dans l'image", () => {
  it("chaque source du périmètre a sa ligne, à l'empreinte du dépôt ; image-id et .gitignore recalculés", () => {
    const ecarts = ecartsDuManifeste(entreesDuDepot());
    assert.deepEqual(
      ecarts,
      [],
      `référence périmée : ${ecarts.map((x) => `${x.chemin} (${x.raison}, source ${x.source})`).join(" ; ")}. ` +
        "Relancez scripts/build-omo-image.ps1 -AcceptManifest, relisez le diff de docker/opencode-omo/omo-manifest.sha256 et commitez-le avec la source.",
    );
  });

  it("le test voit bien les copies du périmètre : onze fichiers du dépôt, dont les quatre de 91cce89", () => {
    const duPerimetre = [...copiesDockerfile(DOCKERFILE)].filter(([d]) => dansLePerimetre(d, CONTRAT.perimetreManifeste));
    const sources = duPerimetre.map(([, s]) => s).sort();
    for (const attendue of ["opencode.jsonc", "omo.jsonc", "supervisor.sh", "guard/cockpit-guard.js", "supervisor-lib.mjs", "package-lock.json"]) {
      assert.ok(sources.includes(attendue), `source du périmètre non vue : ${attendue}`);
    }
    assert.equal(duPerimetre.length, 11, `copies du périmètre : ${sources.join(", ")}`);
    // La référence elle-même est HORS du périmètre (elle ne peut pas se contenir) : jamais comparée à elle-même.
    assert.ok(!duPerimetre.some(([, s]) => s === "omo-manifest.sha256"));
  });

  it("le périmètre lu est celui du contrat, et l'en-tête de la référence porte l'image de base épinglée", () => {
    assert.deepEqual(CONTRAT.perimetreManifeste, ["/opt/omo", "/opt/omo-check", "/opt/omo-guard", "/etc/opencode-omo", "/usr/local/bin/omo-supervisor"]);
    assert.match(baseDeLaReference(REFERENCE) ?? "", /^[0-9a-f]{64}$/);
  });
});

describe("R-1 : chaque garde tombe sur la modification qu'elle doit voir (mutations en mémoire, le dépôt n'est jamais touché)", () => {
  const unOctetDePlus = (relatif: string): Record<string, Buffer> => ({ [relatif]: Buffer.concat([octets(relatif), Buffer.from(" ")]) });

  it("91cce89 rejoué : chacune des quatre sources modifiées sans -AcceptManifest donne SON écart", () => {
    for (const [source, destination] of [
      ["opencode.jsonc", "/etc/opencode-omo/opencode.jsonc"],
      ["omo.jsonc", "/etc/opencode-omo/omo/omo.jsonc"],
      ["supervisor.sh", "/usr/local/bin/omo-supervisor"],
      ["guard/cockpit-guard.js", "/opt/omo-guard/cockpit-guard.js"],
    ] as const) {
      const ecarts = ecartsDuManifeste(entreesDuDepot({}, unOctetDePlus(source)));
      assert.deepEqual(ecarts, [{ chemin: destination, raison: "empreinte-differente", source }], source);
    }
  });

  it("lockfile changé : la copie ET image-id tombent", () => {
    const ecarts = ecartsDuManifeste(entreesDuDepot({}, unOctetDePlus("package-lock.json")));
    assert.deepEqual(ecarts.map((x) => x.chemin).sort(), ["/etc/opencode-omo/image-id", "/opt/omo/package-lock.json"]);
  });

  it("image de base changée dans l'en-tête sans nouvel amorçage : image-id tombe", () => {
    const base = baseDeLaReference(REFERENCE) ?? "";
    const autre = REFERENCE.replace(base, base.startsWith("0") ? `1${base.slice(1)}` : `0${base.slice(1)}`);
    assert.notEqual(autre, REFERENCE);
    assert.deepEqual(ecartsDuManifeste(entreesDuDepot({ reference: autre })).map((x) => x.chemin), ["/etc/opencode-omo/image-id"]);
  });

  it("nouvelle copie dans le périmètre sans ligne de référence : écart « ligne-absente », jamais ignorée", () => {
    const dockerfile = DOCKERFILE.replace("COPY guard/cockpit-guard.js", "COPY guard/cockpit-guard.js /opt/omo-guard/nouveau.js\nCOPY guard/cockpit-guard.js");
    assert.notEqual(dockerfile, DOCKERFILE);
    assert.deepEqual(ecartsDuManifeste(entreesDuDepot({ dockerfile })), [{ chemin: "/opt/omo-guard/nouveau.js", raison: "ligne-absente", source: "guard/cockpit-guard.js" }]);
  });

  it("ligne retirée de la référence : écart ; texte du .gitignore de l'image changé : écart", () => {
    const sansLigne = REFERENCE.split("\n")
      .filter((l) => !l.endsWith("  /opt/omo-check/validate.mjs"))
      .join("\n");
    assert.deepEqual(ecartsDuManifeste(entreesDuDepot({ reference: sansLigne })), [{ chemin: "/opt/omo-check/validate.mjs", raison: "ligne-absente", source: "validate.mjs" }]);
    const dockerfile = DOCKERFILE.replace("opencode ne l'ecrit pas", "opencode ne l'ecrit plus");
    assert.notEqual(dockerfile, DOCKERFILE);
    assert.deepEqual(ecartsDuManifeste(entreesDuDepot({ dockerfile })).map((x) => x.chemin), ["/etc/opencode-omo/.gitignore"]);
  });

  it("COPY --from (autre étape) écartée ; COPY en forme JSON : le test tombe au lieu de sauter une source", () => {
    const multi = DOCKERFILE.replace("COPY guard/cockpit-guard.js", "COPY --from=etape /x /opt/omo-guard/depuis-etape.js\nCOPY guard/cockpit-guard.js");
    assert.notEqual(multi, DOCKERFILE);
    assert.deepEqual(ecartsDuManifeste(entreesDuDepot({ dockerfile: multi })), [], "une copie d'une autre étape n'est pas une source du dépôt");
    const json = DOCKERFILE.replace("COPY guard/cockpit-guard.js /opt/omo-guard/cockpit-guard.js", 'COPY ["guard/cockpit-guard.js", "/opt/omo-guard/cockpit-guard.js"]');
    assert.notEqual(json, DOCKERFILE);
    assert.throws(() => ecartsDuManifeste(entreesDuDepot({ dockerfile: json })), /forme JSON de COPY/);
  });

  it("forme du Dockerfile qu'on ne sait plus recalculer : fermé en cas de doute (écart « format-inconnu »), jamais un saut", () => {
    const dockerfile = DOCKERFILE.replace("> /etc/opencode-omo/image-id", "> /etc/opencode-omo/image-id.txt");
    assert.notEqual(dockerfile, DOCKERFILE);
    assert.ok(ecartsDuManifeste(entreesDuDepot({ dockerfile })).some((x) => x.chemin === "/etc/opencode-omo/image-id" && x.raison === "format-inconnu"));
    const sansBase = REFERENCE.replace(/^# Image de base : .*$/m, "# Image de base : (inconnue)");
    assert.ok(ecartsDuManifeste(entreesDuDepot({ reference: sansBase })).some((x) => x.raison === "base-illisible"));
  });
});
