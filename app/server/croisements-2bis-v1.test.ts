// Tests de croisement du train de V1 de la Salle OMO (plan d'exécution 2 bis-2 ter §2.3, §5.2 ; propriété de l'intégrateur) :
// L15a (image, configurations, validation, manifeste), L15b (script de construction), L17b (service de contrôle du cockpit), L24
// (plugin de garde, filet), confrontés entre eux et aux paquets de V0 (T3a contrat, L17a superviseur, L20 audit).
// Ce que la vague doit prouver ensemble, et qu'aucun paquet ne peut prouver seul :
//   1. omo.jsonc (L15a) : noms ⊆ énumérations de L20 lues dans la TABLE (pas dans son jumeau JSON), chaque « couper » appliqué ;
//   2. opencode.jsonc (L15a) et le filet (L24) : plugin au chemin du contrat, et les deux filets refusent les mêmes clés ;
//   3. chemins : build-omo-image.ps1 (L15b) = Dockerfile (L15a) = contrat (T3a) = validate.mjs = supervisor.sh ;
//   4. périmètre de manifest.sh = contrat = superviseur, et tout le périmètre à root, sans écriture ;
//   5. guard-state.json écrit par L17b, lu par le lecteur de L24 (mêmes vecteurs, borne de 4 Kio tenue) ;
//   6. fichiers de L17b acceptés par supervisor-lib.mjs, et state.json du superviseur relu par L17b ;
//   7. auth.json publié par L17b : la seule entrée github-copilot, recopiée par le superviseur, jamais journalisée ;
//   8. configuration du HOME (demande de contrat (A) de L15a, D-2b-33 révisée au train) : ce que le superviseur pose est ce que
//      validate.mjs exige au démarrage ; sans lui (volume vide de V0), la salle refuse de démarrer ;
//   9. grille : directive « syntax » non épinglée retirée, package.json de l'image en module (plus d'avertissement du filet).
// Aucun conteneur, aucune pause fixe, aucun port, aucun réseau : horloge injectée, dossiers temporaires, processus enfants locaux.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, type TestContext } from "node:test";
import { pathToFileURL } from "node:url";
import * as garde from "../../docker/opencode-omo/guard/cockpit-guard.js";
import * as salle from "../../docker/opencode-omo/supervisor-lib.mjs";
import {
  CATEGORIES_4_19_4,
  GREFFONS,
  LISTES_COUPEES,
  SONDES_PERMISES,
  SONDES_REFUSEES,
  actionPour,
  lireJsonc,
  verifierOmo,
  verifierOpencode,
  verifierTexteOpencode,
} from "../../docker/opencode-omo/validate-core.mjs";
import { OMO_SALLE_CONTRACT_FILE, OMO_SALLE_CONTRACT_SCHEMA, OMO_STOP_CAUSES } from "./omo-contracts.ts";
import { createOmoControl, type OmoControlClock } from "./omo-control.ts";
import {
  AGENTS,
  CLES,
  COMMANDES,
  COMPETENCES,
  enumerations,
  FOURNISSEURS_COUPES,
  HOOKS,
  MCPS,
  OUTILS_A_COUPER,
  valeursEpinglees,
} from "./shared/omo-audit-4.19.4.ts";
import { analyserGuardState, ecrireGuardState, OMO_GUARD_TOOLS } from "./shared/omo-control-protocol.ts";
import type { OmoGuardTool, OmoPreparedProjects, OmoRecreationRaison, OmoSalleContract } from "./shared/omo-types.ts";

const RACINE = path.join(import.meta.dirname, "..", "..");
const DOCKER_OMO = path.join(RACINE, "docker", "opencode-omo");
const lireDepot = (...morceaux: string[]): string => fs.readFileSync(path.join(RACINE, ...morceaux), "utf8");

/** Contrat machine lu ET validé par son schéma. */
const CONTRAT: OmoSalleContract = OMO_SALLE_CONTRACT_SCHEMA.parse(JSON.parse(lireDepot(OMO_SALLE_CONTRACT_FILE)));
const IMG = CONTRAT.cheminsImage;

type Json = Record<string, unknown>;
const objet = (v: unknown): Json => (v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Json) : {});
const textes = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);

const OMO = objet(lireJsonc(lireDepot("docker", "opencode-omo", "omo.jsonc")));
const TEXTE_OPENCODE = lireDepot("docker", "opencode-omo", "opencode.jsonc");
const OPENCODE = objet(lireJsonc(TEXTE_OPENCODE));

/** Instructions du Dockerfile, continuations jointes, commentaires retirés. */
const DOCKERFILE_TEXTE = lireDepot("docker", "opencode-omo", "Dockerfile");
const INSTRUCTIONS: { cmd: string; args: string }[] = (() => {
  const sortie: { cmd: string; args: string }[] = [];
  let courant = "";
  for (const ligne of DOCKERFILE_TEXTE.split("\n")) {
    if (courant === "" && (ligne.trim() === "" || ligne.trimStart().startsWith("#"))) continue;
    courant += ligne.trimEnd().endsWith("\\") ? `${ligne.trimEnd().slice(0, -1)} ` : ligne;
    if (ligne.trimEnd().endsWith("\\")) continue;
    const [cmd = "", ...reste] = courant.trim().split(/\s+/u);
    sortie.push({ cmd: cmd.toUpperCase(), args: reste.join(" ") });
    courant = "";
  }
  return sortie;
})();
const RUNS = INSTRUCTIONS.filter((i) => i.cmd === "RUN").map((i) => i.args);
/** Destination de chaque COPY (dernier argument), avec ses sources. */
const COPIES = INSTRUCTIONS.filter((i) => i.cmd === "COPY").map((i) => {
  const mots = i.args.split(" ").filter((m) => m !== "" && !m.startsWith("--"));
  return { sources: mots.slice(0, -1), destination: mots.at(-1) ?? "" };
});

/** Chaînes littérales d'un objet `export const <nom> = Object.freeze({ … })` d'un module .mjs, sans l'importer. */
function objetDuSource(source: string, nom: string): Record<string, string> {
  const debut = source.indexOf(`export const ${nom} = Object.freeze({`);
  assert.ok(debut >= 0, `${nom} introuvable`);
  const fin = source.indexOf("});", debut);
  return Object.fromEntries([...source.slice(debut, fin).matchAll(/(\w+):\s*"([^"]*)"/gu)].map((m) => [m[1] ?? "", m[2] ?? ""]));
}

const posix = (chemin: string): string => chemin.replaceAll("\\", "/");

function dossierTemporaire(t: TestContext, prefixe: string): string {
  const dir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), prefixe));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

// --- 1. omo.jsonc (L15a) et l'audit de la 4.19.4 (L20) ---------------------------------------------------------------------------

describe("croisements 2bis V1 : omo.jsonc (L15a) = décisions de L20", () => {
  const coupes = <T extends { decision: string }>(entrees: readonly T[], cle: (e: T) => string) => entrees.filter((e) => e.decision === "couper").map(cle);

  it("jugé par la TABLE de L20 (et non par son jumeau JSON) : aucun message du validateur de l'image", () => {
    assert.deepEqual(verifierOmo(OMO, enumerations()), []);
  });

  it("chaque liste disabled_* : noms ⊆ énumérations de L20, et chaque « couper » de L20 y est", () => {
    const enums = enumerations() as unknown as Record<string, readonly string[]>;
    for (const [cle, famille] of Object.entries(LISTES_COUPEES)) {
      const ecrits = textes(OMO[cle]);
      assert.ok(ecrits.length > 0, `${cle} vide ou absente`);
      const permis = famille === "fournisseursCoupes" ? enums.fournisseursCoupes : enums[famille];
      for (const nom of ecrits) assert.ok(permis?.includes(nom), `${cle} : ${nom} hors énumération de la 4.19.4`);
    }
    const attendus: Record<string, readonly string[]> = {
      disabled_hooks: coupes(HOOKS, (h) => h.nom),
      disabled_tools: OUTILS_A_COUPER,
      disabled_mcps: coupes(MCPS, (m) => m.nom),
      disabled_skills: coupes(COMPETENCES, (c) => c.nom),
      disabled_commands: coupes(COMMANDES, (c) => c.nom),
      disabled_agents: coupes(AGENTS, (a) => a.cle),
      disabled_providers: FOURNISSEURS_COUPES,
    };
    for (const [cle, noms] of Object.entries(attendus)) {
      assert.ok(noms.length > 0, `${cle} : aucune coupure dans l'audit ?`);
      assert.deepEqual([...textes(OMO[cle])].sort(), [...noms].sort(), cle);
    }
  });

  it("valeurs épinglées égales, clé par clé ; une clé « couper » sans valeur n'est jamais écrite (ralph_loop, _migrations…)", () => {
    for (const [cle, valeur] of Object.entries(valeursEpinglees())) {
      if (cle === "agents") continue; // IA de chaque agent en plus : jugé par verifierOmo (permission de Prometheus comprise).
      assert.deepEqual(OMO[cle], valeur, cle);
    }
    const sansValeur = CLES.filter((c) => c.decision === "couper" && c.valeur === null).map((c) => c.cle);
    assert.ok(sansValeur.includes("ralph_loop"));
    for (const cle of sansValeur) assert.equal(Object.hasOwn(OMO, cle), false, cle);
  });

  it("décision n° 8 du 19/09 : goal coupé partout (hook, commande, clé), et aucun ralph-loop", () => {
    assert.ok(textes(OMO.disabled_hooks).includes("goal"));
    assert.ok(textes(OMO.disabled_commands).includes("goal"));
    assert.equal(objet(OMO.goal).enabled, false);
    assert.equal(JSON.stringify(OMO).includes("ralph"), false);
  });

  it("agents et catégories : noms de la 4.19.4 seulement, IA github-copilot/* partout, coupés compris (G3 statique)", () => {
    const agents = objet(OMO.agents);
    // Chaque agent de l'audit a son IA épinglée, même ceux que disabled_agents coupe : si la coupure échouait, ce serait Copilot.
    assert.deepEqual(Object.keys(agents).sort(), [...enumerations().agents].sort());
    for (const nom of Object.keys(agents)) assert.match(String(objet(agents[nom]).model), /^github-copilot\//u, nom);
    const categories = objet(OMO.categories);
    assert.deepEqual(Object.keys(categories).sort(), [...CATEGORIES_4_19_4].sort());
    for (const [nom, section] of Object.entries(categories)) assert.match(String(objet(section).model), /^github-copilot\//u, nom);
  });
});

// --- 2. opencode.jsonc (L15a) et le filet (L24) -----------------------------------------------------------------------------------

describe("croisements 2bis V1 : opencode.jsonc (L15a) et le filet (L24), mêmes clés refusées", () => {
  it("plugins : l'extension installée par npm ci, PUIS le filet au chemin du contrat, copié là par le Dockerfile", () => {
    assert.deepEqual(OPENCODE.plugin, [...GREFFONS]);
    assert.deepEqual(GREFFONS, [`file://${IMG.extension}/node_modules/oh-my-openagent/dist/index.js`, `file://${IMG.garde}`]);
    assert.ok(COPIES.some((c) => c.destination === IMG.garde && c.sources.join(" ") === "guard/cockpit-guard.js"));
    assert.deepEqual(verifierOpencode(OPENCODE), []);
    assert.deepEqual(verifierTexteOpencode(TEXTE_OPENCODE), []);
  });

  it("décision M3 du 19/09 : réseau et hors-projet refusés dans la configuration ET par le filet ; edit et bash demandés", () => {
    const permission = objet(OPENCODE.permission);
    for (const outil of ["webfetch", "websearch", "external_directory"]) assert.equal(permission[outil], "deny", outil);
    for (const outil of ["bash", "task"]) assert.equal(permission[outil], "ask", outil);
    assert.equal(objet(permission.edit)["*"], "ask");
    assert.deepEqual([...garde.OUTILS_RESEAU].sort(), ["webfetch", "websearch"]);
    const contexte = { dossier: "/workspace/projet", sortiesOutils: null, reel: (c: string) => c, lireEtat: () => ({ etat: "absent" as const }) };
    for (const outil of ["webfetch", "websearch"]) assert.equal(garde.decider(outil, { url: "https://exemple.invalid" }, contexte)?.categorie, "reseau", outil);
  });

  it("deux filets, mêmes clés : chaque témoin de clé du plugin est refusé par opencode.jsonc (lecture et écriture), et réciproquement", () => {
    const permission = objet(OPENCODE.permission);
    const regles = (outil: string) => objet(permission[outil]) as Record<string, string>;
    for (const temoin of garde.TEMOINS_CLE) {
      assert.equal(garde.estNomCle(temoin), true, temoin);
      for (const outil of ["read", "edit"]) assert.equal(actionPour(regles(outil), temoin), "deny", `${outil} ${temoin} (témoin de L24)`);
    }
    for (const sonde of SONDES_REFUSEES) {
      assert.ok(garde.estNomCle(path.posix.basename(sonde)) || garde.estCheminCle(sonde), `sonde de L15a non refusée par le filet : ${sonde}`);
    }
    // .env.example reste permis des deux côtés, les fichiers ordinaires aussi.
    for (const temoin of [...garde.TEMOINS_ORDINAIRES, ...SONDES_PERMISES]) {
      assert.equal(garde.estNomCle(path.posix.basename(temoin)), false, temoin);
      assert.notEqual(actionPour(regles("read"), temoin), "deny", `read ${temoin}`);
    }
  });

  it("grep refusé des deux côtés : règle d'opencode évaluée sur l'EXPRESSION cherchée (grep.ts 1.18.30) → deny ; filet → « recherche »", () => {
    const permission = objet(OPENCODE.permission);
    assert.equal(permission.grep, "deny");
    // Même lecture qu'opencode : `grep: "deny"` vaut la règle { "*": "deny" }, que l'expression cherchée ne peut contourner.
    const regle = typeof permission.grep === "string" ? { "*": permission.grep } : (objet(permission.grep) as Record<string, string>);
    for (const expression of ["SECRET", "PASSWORD|SECRET|TOKEN", "BEGIN .* PRIVATE KEY", ".env", "x"]) {
      assert.equal(actionPour(regle, expression), "deny", `opencode.jsonc : grep ${expression}`);
      const contexte = { dossier: "/workspace/projet", sortiesOutils: null, reel: (c: string) => c, lireEtat: () => ({ etat: "absent" as const }) };
      assert.equal(garde.decider("grep", { pattern: expression }, contexte)?.categorie, "recherche", `filet : grep ${expression}`);
    }
    // Le grep de l'extension (qui remplacerait l'outil natif) reste coupé : seul l'outil natif, refusé, porterait ce nom.
    assert.ok(textes(OMO.disabled_tools).includes("grep"));
  });
});

// --- 3. Chemins : script (L15b) = Dockerfile (L15a) = contrat (T3a) = validate.mjs = supervisor.sh --------------------------------

describe("croisements 2bis V1 : chemins de l'image, du script de construction au superviseur", () => {
  const SCRIPT = lireDepot("scripts", "build-omo-image.ps1");
  const SUPERVISEUR = lireDepot("docker", "opencode-omo", "supervisor.sh");
  const VALIDATE = lireDepot("docker", "opencode-omo", "validate.mjs");

  it("chaque chemin de l'image a sa copie dans le Dockerfile, au chemin exact du contrat", () => {
    const dans = (dossier: string, chemin: string) => path.posix.dirname(chemin) === dossier.replace(/\/$/u, "");
    const verifier = (chemin: string, source: string) =>
      assert.ok(
        COPIES.some((c) => c.sources.includes(source) && (c.destination === chemin || (c.destination.endsWith("/") && dans(c.destination, chemin)))),
        `${source} → ${chemin}`,
      );
    verifier(IMG.superviseur, "supervisor.sh");
    verifier(IMG.superviseurLib, "supervisor-lib.mjs");
    verifier(IMG.valider, "validate.mjs");
    verifier(IMG.validerCoeur, "validate-core.mjs");
    verifier(IMG.enumerations, "enums-4.19.4.json");
    verifier(IMG.manifeste, "manifest.sh");
    verifier(IMG.referenceManifeste, "omo-manifest.sha256");
    verifier(`${IMG.configuration}/opencode.jsonc`, "opencode.jsonc");
    verifier(salle.CHEMINS.configurationOmo, "omo.jsonc");
    assert.ok(RUNS.some((r) => r.includes(`> ${IMG.imageId};`)), "image-id écrit au chemin du contrat");
    assert.ok(RUNS.some((r) => r.includes(`cp ${IMG.extension}/node_modules/oh-my-openagent/LICENSE.md ${IMG.licence};`)));
  });

  it("build-omo-image.ps1 lit ses chemins dans le contrat, n'en recopie aucun, et chaque rôle lu existe", () => {
    const code = SCRIPT.split("\n").filter((l) => !l.trimStart().startsWith("#"));
    for (const chemin of Object.values(IMG)) {
      assert.equal(code.some((l) => l.includes(`'${chemin}'`) || l.includes(`"${chemin}"`)), false, `chemin recopié dans le script : ${chemin}`);
    }
    const roles = /foreach \(\$key in @\(([^)]*)\)\) \{ \$paths\[\$key\] = \[string\]\(Get-OmoProp \$images \$key\) \}/u.exec(SCRIPT)?.[1];
    assert.ok(roles, "lecture des rôles du contrat introuvable dans le script");
    for (const role of [...roles.matchAll(/'([^']+)'/gu)].map((m) => m[1] ?? "")) assert.ok(Object.hasOwn(IMG, role), role);
  });

  it("--construction à la construction (Dockerfile, script), TOUS les contrôles au démarrage (superviseur) : demande (E) de L15a", () => {
    assert.ok(RUNS.includes(`node ${IMG.valider} --construction`), "étape RUN de validation du Dockerfile (G14, -SelfTest de L15b)");
    assert.ok(SCRIPT.includes("@($Contract.Valider, '--construction')"));
    const lignes = SUPERVISEUR.split("\n").map((l) => l.trim());
    assert.ok(lignes.includes(`VALIDATE=${IMG.valider}`));
    assert.ok(lignes.includes(`LIB=${IMG.superviseurLib}`));
    assert.ok(lignes.includes(`MANIFEST=${IMG.manifeste}`));
    assert.ok(lignes.includes('executer node "$VALIDATE"'));
    assert.equal(lignes.some((l) => !l.startsWith("#") && l.includes("--construction")), false, "le superviseur ne saute aucun contrôle");
  });

  it("validate.mjs lit aux chemins du contrat et du superviseur, et la configuration effective dans un dossier du HOME", () => {
    const chemins = objetDuSource(VALIDATE, "CHEMINS_VALIDATION");
    assert.equal(chemins.enumerations, IMG.enumerations);
    assert.equal(chemins.configurationOpencode, `${IMG.configuration}/opencode.jsonc`);
    assert.equal(chemins.configurationOmo, salle.CHEMINS.configurationOmo);
    assert.ok(salle.CHEMINS.configurationOmo.startsWith(`${IMG.configuration}/`), "référence dans le périmètre du manifeste");
    assert.ok(chemins.paquet?.startsWith(`${IMG.extension}/`) && chemins.dist?.startsWith(`${IMG.extension}/`));
    assert.ok(salle.DOSSIERS_CONFIG_HOME.includes(chemins.dossierOmoUtilisateur ?? ""), "~/.omo est un dossier de configuration du HOME");
    assert.equal(chemins.dossierOmoUtilisateur, "/home/node/.omo");
    // Le fichier que validate.mjs relit est celui que le superviseur pose.
    assert.ok(VALIDATE.includes("`${dossier}/omo.jsonc`"));
    assert.equal(salle.CONFIG_HOME_FICHIERS.omo, "omo.jsonc");
  });
});

// --- 4. Manifeste : périmètre et droits ----------------------------------------------------------------------------------------------

describe("croisements 2bis V1 : périmètre du manifeste = contrat, tout à root, sans écriture", () => {
  it("manifest.sh (L15a) = contrat = superviseur (L17a) ; la référence reste hors du périmètre", () => {
    const perimetre = /^PERIMETRE="([^"]*)"$/mu.exec(lireDepot("docker", "opencode-omo", "manifest.sh"))?.[1]?.split(" ");
    assert.deepEqual(perimetre, CONTRAT.perimetreManifeste);
    assert.deepEqual([...salle.PERIMETRE_MANIFESTE], CONTRAT.perimetreManifeste);
    assert.equal(CONTRAT.perimetreManifeste.some((racine) => IMG.referenceManifeste.startsWith(`${racine}/`)), false);
  });

  it("chaque racine du périmètre passe à root:root et perd tout droit d'écriture dans le Dockerfile ; l'image finit en root", () => {
    const echapper = (texte: string) => texte.replace(/[.*+?^${}()|[\]\\/]/gu, "\\$&");
    for (const racine of CONTRAT.perimetreManifeste) {
      const chown = RUNS.some((r) => new RegExp(`chown -R root:root [^;]*${echapper(racine)}(?:[ ;]|$)`, "u").test(r));
      const sansEcriture = RUNS.some((r) => new RegExp(`chmod (?:-R a\\+rX,a-w|0555) [^;]*${echapper(racine)}(?:[ ;]|$)`, "u").test(r));
      assert.ok(chown, `chown root:root : ${racine}`);
      assert.ok(sansEcriture, `sans écriture : ${racine}`);
    }
    assert.ok(RUNS.some((r) => r.includes("npm ci --ignore-scripts")), "--ignore-scripts");
    assert.equal(INSTRUCTIONS.findLast((i) => i.cmd === "USER")?.args, "root");
  });

  it("aucune directive « syntax » : le frontal BuildKit intégré, jamais une image tirée sans empreinte (grille V1, point 8 de L15b)", () => {
    assert.equal(/^\s*#\s*syntax\s*=/imu.test(DOCKERFILE_TEXTE), false);
    // Les instructions utilisées sont toutes celles du frontal intégré.
    assert.deepEqual([...new Set(INSTRUCTIONS.map((i) => i.cmd))].sort(), ["ARG", "COPY", "ENTRYPOINT", "ENV", "FROM", "RUN", "USER", "WORKDIR"]);
  });
});

// --- 5 à 7. Service de contrôle (L17b) face au superviseur (L17a) et au filet (L24) -------------------------------------------------

/** Horloge figée : aucune minuterie ne se déclenche seule ; le premier battement part à `startHeartbeat`. */
function horlogeFigee(maintenant: number): OmoControlClock {
  return { now: () => maintenant, setTimer: () => ({}), clearTimer: () => undefined };
}

function espion() {
  const lignes: { message: string; champs: Record<string, unknown> | undefined }[] = [];
  return {
    lignes,
    log: {
      info: (message: string, champs?: Record<string, unknown>) => void lignes.push({ message, champs }),
      warn: (message: string, champs?: Record<string, unknown>) => void lignes.push({ message, champs }),
    },
  };
}

function monterControle(t: TestContext, maintenant: number, options: { projets?: OmoPreparedProjects; actif?: () => boolean } = {}) {
  const racine = dossierTemporaire(t, "omo-v1-controle-");
  const d = {
    controlDir: path.join(racine, "control-omo"),
    stateDir: path.join(racine, "omo-state"),
    authDir: path.join(racine, "omo-auth"),
    dataDir: path.join(racine, "oc-data"),
    projectsFile: path.join(racine, "hote", "omo-projets.json"),
    donneesSalle: path.join(racine, "salle-donnees"),
    donneesCockpit: path.join(racine, "donnees-cockpit"),
  };
  for (const dossier of [d.stateDir, d.dataDir, path.dirname(d.projectsFile), d.donneesCockpit]) fs.mkdirSync(dossier, { recursive: true });
  if (options.projets) fs.writeFileSync(d.projectsFile, JSON.stringify(options.projets));
  const journal = espion();
  const ctl = createOmoControl({
    controlDir: d.controlDir,
    stateDir: d.stateDir,
    authDir: d.authDir,
    opencodeDataDir: d.dataDir,
    cockpitDataDir: d.donneesCockpit,
    projectsFile: options.projets ? d.projectsFile : null,
    clock: horlogeFigee(maintenant),
    actif: options.actif ?? (() => true),
    log: journal.log,
  });
  t.after(async () => {
    ctl.stopHeartbeat();
    await ctl.settled();
  });
  return { d, ctl, journal };
}

const AT = 1_757_000_000_000;

describe("croisements 2bis V1 : guard-state.json, du cockpit (L17b) au filet (L24)", () => {
  it("chemin : le filet lit /control/guard-state.json, soit le montage du contrôle dans la salle et le nom du contrat", () => {
    const controle = CONTRAT.volumes.find((v) => v.nom === "control-omo")?.montages.find((m) => m.service === "salle");
    assert.equal(controle?.mode, "ro");
    assert.equal(garde.CHEMIN_ETAT_GARDE, `${controle?.cible}/${CONTRAT.fichiersControle.garde}`);
    assert.deepEqual([...garde.OUTILS_DELEGATION], [...OMO_GUARD_TOOLS]);
  });

  it("chaque état écrit par writeGuardState est relu « valide » et identique par lireEtatGarde du filet", async (t) => {
    const { d, ctl } = monterControle(t, AT);
    const etats: OmoGuardTool[][] = [[], ["task"], ["call_omo_agent"], ["task", "call_omo_agent"]];
    for (const bloquer of etats) {
      await ctl.writeGuardState({ version: 1, at: AT, bloquer });
      const lu = garde.lireEtatGarde(path.join(d.controlDir, CONTRAT.fichiersControle.garde));
      assert.deepEqual(lu, { etat: "valide", garde: { version: 1, at: AT, bloquer } }, bloquer.join(",") || "rien");
    }
  });

  it("borne : le plus gros état valide tient sous les 4 Kio du filet (le protocole en permet 64) : demande n° 4 de L17b", () => {
    const pire = ecrireGuardState(253_402_300_799_999, [...OMO_GUARD_TOOLS]);
    assert.ok(Buffer.byteLength(pire) <= 128, `${Buffer.byteLength(pire)} octets`);
    assert.ok(Buffer.byteLength(pire) < garde.ETAT_GARDE_MAX_OCTETS);
    assert.deepEqual(garde.analyserEtatGarde(pire), analyserGuardState(pire));
  });

  it("vecteurs « garde » de L17a : même verdict pour le filet et pour le protocole du cockpit", () => {
    const vecteurs = (JSON.parse(lireDepot("app", "server", "test-support", "fixtures", "omo-control-vectors.json")) as { vecteurs: { format: string; nom: string; texte: string; attendu: unknown }[] }).vecteurs.filter(
      (v) => v.format === "garde",
    );
    assert.ok(vecteurs.length >= 4);
    for (const v of vecteurs) {
      assert.deepEqual(garde.analyserEtatGarde(v.texte), v.attendu, v.nom);
      assert.deepEqual(analyserGuardState(v.texte), v.attendu, v.nom);
    }
  });
});

describe("croisements 2bis V1 : fichiers de contrôle de L17b acceptés par le superviseur (L17a)", () => {
  const PROJETS: OmoPreparedProjects = {
    version: 1,
    genereLe: "2026-09-19T10:00:00Z",
    projets: [
      { chemin: "alpha", git: "dossier" },
      { chemin: "beta", git: "absent" },
    ],
    gitProteges: [{ chemin: "alpha", forme: "dossier" }],
  };

  it("battement et omo-projets.json déposés par startHeartbeat, relus par le superviseur", async (t) => {
    const { d, ctl } = monterControle(t, AT, { projets: PROJETS });
    ctl.startHeartbeat();
    await ctl.settled();
    const battement = salle.lireBattement(d.controlDir);
    assert.deepEqual(battement, { at: AT });
    assert.equal(salle.battementFrais(battement, AT + 1000), true);
    assert.deepEqual(salle.lireProjetsPrepares(d.controlDir), PROJETS);
  });

  it("stop-request : chaque cause, avec le startId publié par le superviseur, relue et visant CE démarrage", async (t) => {
    const { d, ctl } = monterControle(t, AT);
    const travail = salle.initTravail(d.stateDir, AT - 5000);
    salle.publierEtat(d.stateDir, travail, "opencode-lance");
    const causes: OmoRecreationRaison[] = [...OMO_STOP_CAUSES, "fin-de-demande"];
    for (const cause of causes) {
      await ctl.requestStop(cause);
      const arret = salle.lireArret(d.controlDir);
      assert.deepEqual(arret, { at: AT, cause, startId: travail.startId }, cause);
      assert.equal(salle.arretDuDemarrage(arret, travail.startId, travail.startedAt), true, cause);
    }
    // La relance suivante (autre startId) n'est pas visée par le même fichier (D-2b-29).
    assert.equal(salle.arretDuDemarrage(salle.lireArret(d.controlDir), salle.nouveauStartId(), AT + 1), false);
  });

  it("precheck-ok du démarrage publié : relu et accepté par le superviseur ; state.json du superviseur relu par L17b", async (t) => {
    const { d, ctl } = monterControle(t, AT);
    const travail = salle.initTravail(d.stateDir, AT - 5000);
    const publie = salle.publierEtat(d.stateDir, travail, "attente");
    const etat = await ctl.readState();
    assert.equal(etat?.startId, travail.startId);
    assert.deepEqual(etat, publie);
    const projets = [{ chemin: "alpha", sha256: "a".repeat(64) }];
    await ctl.writePrecheckOk(travail.startId, projets);
    const precheck = salle.lirePrecheckOk(d.controlDir);
    assert.deepEqual(precheck, { startId: travail.startId, at: AT, projets });
    assert.equal(salle.precheckDuDemarrage(precheck, travail.startId, AT + 1000), true);
  });
});

describe("croisements 2bis V1 : auth.json (D-2b-26), du cockpit (L17b) au superviseur (L17a)", () => {
  const SECRETS = ["FACTICE-RAFRAICHIR-L17B-V1", "FACTICE-ACCES-L17B-V1", "FACTICE-ANTHROPIC-V1", "FACTICE-OPENAI-V1"];
  const SOURCE = {
    "github-copilot": { type: "oauth", refresh: SECRETS[0], access: SECRETS[1], expires: 0 },
    anthropic: { type: "api", key: SECRETS[2] },
    openai: { type: "api", key: SECRETS[3] },
  };

  it("publié avec la SEULE entrée github-copilot, en 0600, recopié tel quel par le superviseur ; aucun secret au journal", async (t) => {
    const { d, ctl, journal } = monterControle(t, AT);
    fs.writeFileSync(path.join(d.dataDir, "auth.json"), JSON.stringify(SOURCE));
    await ctl.publishAuth();
    const publie = path.join(d.authDir, "auth.json");
    const texte = fs.readFileSync(publie, "utf8");
    assert.deepEqual(JSON.parse(texte), { "github-copilot": SOURCE["github-copilot"] });
    if (process.platform !== "win32") assert.equal(fs.statSync(publie).mode & 0o777, 0o600);

    const copie = salle.copierAuth({ source: publie, donnees: d.donneesSalle });
    assert.deepEqual(copie, { etat: "posee", octets: Buffer.byteLength(texte) });
    assert.equal(fs.readFileSync(path.join(d.donneesSalle, "auth.json"), "utf8"), texte);

    const vu = JSON.stringify(journal.lignes);
    for (const secret of SECRETS) assert.equal(vu.includes(secret), false, "secret au journal");
    assert.ok(journal.lignes.some((l) => l.message.includes("github-copilot seule")), "la publication est dite, sans contenu");
  });

  it("salle coupée : auth.json retiré, et le superviseur n'a plus rien à recopier", async (t) => {
    let actif = true;
    const { d, ctl } = monterControle(t, AT, { actif: () => actif });
    fs.writeFileSync(path.join(d.dataDir, "auth.json"), JSON.stringify(SOURCE));
    await ctl.publishAuth();
    actif = false;
    await ctl.publishAuth();
    const publie = path.join(d.authDir, "auth.json");
    assert.equal(fs.existsSync(publie), false);
    assert.deepEqual(salle.copierAuth({ source: publie, donnees: d.donneesSalle }), { etat: "absente", octets: 0 });
  });
});

// --- 8. Configuration du HOME : ce que pose le superviseur est ce qu'exige validate.mjs ----------------------------------------------

describe("croisements 2bis V1 : configuration du HOME (demande (A) de L15a) — superviseur (L17a révisé) × validate.mjs (L15a)", () => {
  const VALIDATE = path.join(DOCKER_OMO, "validate.mjs");
  const ENUMS = JSON.parse(lireDepot("docker", "opencode-omo", "enums-4.19.4.json")) as Record<string, unknown>;
  const TEXTE_OMO = lireDepot("docker", "opencode-omo", "omo.jsonc");

  /** Arborescence d'image jetable (comme omo-validate.test.ts) : dist SYNTHÉTIQUE fait des seuls noms énumérés. */
  function image(t: TestContext): { dir: string; ici: (chemin: string) => string } {
    const dir = dossierTemporaire(t, "omo-v1-image-");
    const ici = (chemin: string) => path.join(dir, ...chemin.split("/").filter(Boolean));
    const poser = (chemin: string, contenu: string) => {
      fs.mkdirSync(path.dirname(ici(chemin)), { recursive: true });
      fs.writeFileSync(ici(chemin), contenu);
    };
    poser(IMG.enumerations, JSON.stringify(ENUMS));
    poser(salle.CHEMINS.configurationOmo, TEXTE_OMO);
    poser(`${IMG.configuration}/opencode.jsonc`, TEXTE_OPENCODE);
    poser(`${IMG.extension}/node_modules/oh-my-openagent/package.json`, JSON.stringify({ name: "oh-my-openagent", version: "4.19.4" }));
    const noms = [
      ...Object.entries(ENUMS)
        .filter(([cle, v]) => Array.isArray(v) && cle !== "cles")
        .flatMap(([, v]) => textes(v)),
      ...CATEGORIES_4_19_4,
    ];
    poser(`${IMG.extension}/node_modules/oh-my-openagent/dist/index.js`, `// dist synthétique du test\n${noms.map((n) => JSON.stringify(n)).join("\n")}\n`);
    fs.mkdirSync(ici(salle.CHEMINS.configHome), { recursive: true });
    return { dir, ici };
  }

  /** Le montage en lecture seule de omo-config sur ~/.omo, simulé par un lien de dossier (jonction sous Windows). */
  function monterOmo(ici: (chemin: string) => string, cible: string): void {
    fs.mkdirSync(path.dirname(ici("/home/node/.omo")), { recursive: true });
    fs.symlinkSync(cible, ici("/home/node/.omo"), process.platform === "win32" ? "junction" : "dir");
  }

  function valider(dir: string) {
    const env = Object.fromEntries(Object.entries(process.env).filter(([cle]) => cle !== "COCKPIT_COPILOT_API_URL"));
    return spawnSync(process.execPath, [VALIDATE, "--racine", dir], {
      encoding: "utf8",
      env: { ...env, COCKPIT_COPILOT_API_URL: "https://api.githubcopilot.com" },
      timeout: 30_000,
    });
  }

  it("après l'étape 1 bis, la validation de démarrage passe : ~/.omo/omo.jsonc est la référence, octet pour octet", (t) => {
    const { dir, ici } = image(t);
    const volume = ici(salle.CHEMINS.configHome);
    const constat = salle.preparerConfigHome({
      dossier: volume,
      reference: ici(salle.CHEMINS.configurationOmo),
      montages: [posix(volume)],
      uid: fs.lstatSync(volume).uid,
    });
    assert.equal(constat.ok, true, JSON.stringify(constat));
    monterOmo(ici, volume);
    const r = valider(dir);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /configuration conforme, oh-my-openagent 4\.19\.4, démarrage/u);
  });

  it("contrat de V0 (volume VIDE sur ~/.omo) : la salle refuse de démarrer, l'extension tournerait sur ses défauts", (t) => {
    const { dir, ici } = image(t);
    const vide = ici("/vol-vide");
    fs.mkdirSync(vide);
    monterOmo(ici, vide);
    const r = valider(dir);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /configuration lue par l'extension absente : \/home\/node\/\.omo\/omo\.jsonc/u);
  });

  it("le .gitignore posé couvre les dossiers de configuration qu'opencode parcourt (constat EROFS de L24)", () => {
    // opencode 1.18.30 écrit ce fichier dans ~/.config/opencode, ~/.opencode et OPENCODE_CONFIG_DIR : les deux premiers voient le
    // volume omo-config ; le troisième est /etc/opencode-omo, où le Dockerfile le pose.
    for (const dossier of ["/home/node/.config/opencode", "/home/node/.opencode"]) assert.ok(salle.DOSSIERS_CONFIG_HOME.includes(dossier), dossier);
    assert.ok(RUNS.some((r) => r.includes(`> ${IMG.configuration}/.gitignore;`)));
    assert.equal(salle.CONFIG_HOME_FICHIERS.gitignore, ".gitignore");
  });
});

// --- 9. package.json de l'image : module ------------------------------------------------------------------------------------------------

describe("croisements 2bis V1 : package.json de l'image et filet chargés sans avertissement (demande n° 5 de L24)", () => {
  it("docker/opencode-omo/package.json est un module : le filet (.js) se charge sans MODULE_TYPELESS_PACKAGE_JSON", () => {
    assert.equal(objet(JSON.parse(lireDepot("docker", "opencode-omo", "package.json"))).type, "module");
    const url = pathToFileURL(path.join(DOCKER_OMO, "guard", "cockpit-guard.js")).href;
    const r = spawnSync(process.execPath, ["--input-type=module", "-e", `const m = await import(${JSON.stringify(url)}); process.stdout.write(m.default.id);`], {
      encoding: "utf8",
      timeout: 30_000,
    });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout, garde.ID_PLUGIN);
    assert.doesNotMatch(r.stderr, /MODULE_TYPELESS_PACKAGE_JSON|Module type of/u);
  });
});
