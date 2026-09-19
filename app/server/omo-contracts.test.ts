// Tests T3a : contrats de la salle (omo-contracts.ts, shared/omo-types.ts, shared/omo-limits.ts, docker/opencode-omo/contrat-salle.json),
// plan d'exécution 2 bis-2 ter §4.1.5 ; spécification §3.9, §3.12.1, §3.15, §4.8.2, §4.14 ; décisions D-2b-25 à D-2b-47.
// Aucun comportement n'est exercé : listes fermées égales à leurs unions (contrôle de type et d'exécution), ordre proposé des
// inscriptions, port de contrôle sans méthode de redémarrage, limites sans valeur de coût, contrat machine validé et cohérent.
// Chaque règle du contrat est éprouvée par une mutation qui doit être refusée.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import type { z } from "zod";
import {
  EGRESS_REFUSAL_REASONS,
  OMO_ACTIVATION_REFUSAL_CODES,
  OMO_DETECTION_CAUSES,
  OMO_ETATS_SALLE,
  OMO_FORBIDDEN_CATEGORIES,
  OMO_GIT_FORMS,
  OMO_MODULE_NAMES,
  OMO_ORDRE_PROPOSE,
  OMO_PRECHECK_REASONS,
  OMO_SALLE_CONTRACT_FILE,
  OMO_SALLE_CONTRACT_SCHEMA,
  OMO_SIGNALE_GENRES,
  OMO_STOP_CAUSES,
  type OmoControlPort,
  type OmoModuleName,
} from "./omo-contracts.ts";
import { OMO_LIMITES } from "./shared/omo-limits.ts";
import type {
  EgressRefusalReason,
  OmoActivationRefusalCode,
  OmoDetectionCause,
  OmoEtatSalle,
  OmoForbiddenCategory,
  OmoGitForm,
  OmoPrecheckReason,
  OmoSalleContract,
  OmoSignale,
  OmoStopCause,
} from "./shared/omo-types.ts";

const APP_DIR = path.join(import.meta.dirname, "..");
const RACINE = path.join(APP_DIR, "..");

// --- Contrôles de type (échouent au typecheck, donc au FIN) ------------------------------------------------------------------------

/** Une liste couvre toute son union : sinon, [Exclude<…>] extends [never] est faux et l'affectation échoue. */
type Complete<U, L extends readonly U[]> = [Exclude<U, L[number]>] extends [never] ? true : false;

const _listesCompletes: [
  Complete<OmoPrecheckReason, typeof OMO_PRECHECK_REASONS>,
  Complete<OmoActivationRefusalCode, typeof OMO_ACTIVATION_REFUSAL_CODES>,
  Complete<OmoStopCause, typeof OMO_STOP_CAUSES>,
  Complete<OmoDetectionCause, typeof OMO_DETECTION_CAUSES>,
  Complete<OmoForbiddenCategory, typeof OMO_FORBIDDEN_CATEGORIES>,
  Complete<EgressRefusalReason, typeof EGRESS_REFUSAL_REASONS>,
  Complete<OmoGitForm, typeof OMO_GIT_FORMS>,
  Complete<OmoEtatSalle, typeof OMO_ETATS_SALLE>,
  Complete<OmoSignale["genre"], typeof OMO_SIGNALE_GENRES>,
  Complete<OmoModuleName, typeof OMO_MODULE_NAMES>,
] = [true, true, true, true, true, true, true, true, true, true];

/** Le port de contrôle n'expose aucune méthode de redémarrage (D-2b-29, §3.12.1) : sinon, l'affectation échoue. */
type NomDeRedemarrage = `${string}${"restart" | "Restart" | "redemarr" | "Redemarr" | "relance" | "Relance" | "reboot" | "Reboot"}${string}`;
const _sansRedemarrage: [Extract<keyof OmoControlPort, NomDeRedemarrage>] extends [never] ? true : false = true;

/** Le schéma décrit exactement OmoSalleContract, dans les deux sens. */
const _versContrat: OmoSalleContract = {} as z.infer<typeof OMO_SALLE_CONTRACT_SCHEMA>;
const _versSchema: z.infer<typeof OMO_SALLE_CONTRACT_SCHEMA> = {} as OmoSalleContract;

// --- Listes fermées ------------------------------------------------------------------------------------------------------------------

describe("T3a : listes fermées des codes", () => {
  it("chaque liste vaut exactement son union, sans doublon, avec le compte annoncé par la spécification", () => {
    const listes: Array<[string, readonly string[], number]> = [
      ["pré-contrôle", OMO_PRECHECK_REASONS, 9],
      ["refus d'activation", OMO_ACTIVATION_REFUSAL_CODES, 21],
      ["arrêts", OMO_STOP_CAUSES, 9],
      ["détections", OMO_DETECTION_CAUSES, 10],
      ["interdits absolus", OMO_FORBIDDEN_CATEGORIES, 11],
      ["sorties refusées", EGRESS_REFUSAL_REASONS, 5],
      ["formes de .git", OMO_GIT_FORMS, 4],
      ["états de la salle", OMO_ETATS_SALLE, 6],
      ["fichiers signalés", OMO_SIGNALE_GENRES, 3],
      ["modules de la salle", OMO_MODULE_NAMES, 8],
    ];
    for (const [nom, liste, compte] of listes) {
      assert.equal(liste.length, compte, nom);
      assert.equal(new Set(liste).size, liste.length, `${nom} : doublon`);
      for (const code of liste) assert.match(code, /^[a-z][a-z0-9-]*$|^omo[A-Z][A-Za-z]*$/u, `${nom} : ${code}`);
    }
  });

  it("codes ajoutés par le plan (D-2b) présents : l'union et sa liste les portent", () => {
    for (const code of ["salle-suspendue", "salle-en-relance", "workspace-non-verifie"]) assert.ok(OMO_ACTIVATION_REFUSAL_CODES.includes(code as never), code);
    assert.ok(OMO_STOP_CAUSES.includes("redemarrage-cockpit"));
    assert.ok(OMO_DETECTION_CAUSES.includes("activite-hors-demande"));
    assert.ok(OMO_PRECHECK_REASONS.includes("empreinte-impossible"));
    assert.ok(OMO_FORBIDDEN_CATEGORIES.includes("config-extension"));
  });
});

// --- Ordre proposé des inscriptions ---------------------------------------------------------------------------------------------------

describe("T3a : ordre proposé des inscriptions de l'instance omo (appliqué par T3b)", () => {
  const tousLesCouples = [
    ...Object.values(OMO_ORDRE_PROPOSE.hooks).flat(),
    ...OMO_ORDRE_PROPOSE.derivations,
    ...OMO_ORDRE_PROPOSE.hub.map(([module]) => module),
    ...OMO_ORDRE_PROPOSE.startup,
    ...OMO_ORDRE_PROPOSE.routes.map(([, module]) => module),
  ];

  it("aucune inscription sur createSession, sessionCreated et beforeOnceRelay (D-2b-04)", () => {
    assert.deepEqual([...OMO_ORDRE_PROPOSE.hooks.createSession], []);
    assert.deepEqual([...OMO_ORDRE_PROPOSE.hooks.sessionCreated], []);
    assert.deepEqual([...OMO_ORDRE_PROPOSE.hooks.beforeOnceRelay], []);
  });

  it("chaque module de la salle est inscrit au moins une fois, et seuls des modules connus le sont", () => {
    const connus = new Set<string>([...OMO_MODULE_NAMES, "gate", "facts"]);
    for (const module of tousLesCouples) assert.ok(connus.has(module), module);
    for (const module of OMO_MODULE_NAMES) assert.ok(tousLesCouples.includes(module), module);
  });

  it("ordre des étapes : activation avant les plafonds, arrêt sur abort, contrôle puis arrêt au démarrage", () => {
    assert.deepEqual([...OMO_ORDRE_PROPOSE.hooks.beforeBilledSend], ["omoActivation", "omoCaps"]);
    assert.deepEqual([...OMO_ORDRE_PROPOSE.hooks.abort], ["omoStop"]);
    assert.deepEqual([...OMO_ORDRE_PROPOSE.derivations], ["gate", "omoDetections", "omoResponder", "facts", "omoCaps"]);
    assert.deepEqual(
      OMO_ORDRE_PROPOSE.hub.map((couple) => [...couple]),
      [
        ["omoCaps", "usage.updated"],
        ["omoDetections", "usage.updated"],
      ],
    );
    assert.deepEqual([...OMO_ORDRE_PROPOSE.startup], ["omoControl", "omoStop", "omoRoom", "omoPrecheck"]);
    assert.deepEqual(
      OMO_ORDRE_PROPOSE.routes.map((couple) => [...couple]),
      [["omo", "omoRoom"]],
    );
    assert.equal(OMO_ORDRE_PROPOSE.instance, "omo");
  });

  it("le port de contrôle n'a aucune méthode de redémarrage (source relue)", () => {
    const source = fs.readFileSync(path.join(import.meta.dirname, "omo-contracts.ts"), "utf8");
    const bloc = /export interface OmoControlPort \{([\s\S]*?)\n\}/u.exec(source)?.[1] ?? "";
    assert.ok(bloc.includes("startHeartbeat"), "interface OmoControlPort relue");
    const methodes = [...bloc.matchAll(/^\s{2}(\w+)[(<]/gmu)].map((m) => m[1] ?? "");
    assert.deepEqual(methodes, ["startHeartbeat", "stopHeartbeat", "requestStop", "writePrecheckOk", "writeGuardState", "publishAuth", "readState", "suspend", "resume", "suspended"]);
    assert.deepEqual(methodes.filter((nom) => /restart|redemarr|relance|reboot/iu.test(nom)), []);
  });
});

// --- Limites -------------------------------------------------------------------------------------------------------------------------

describe("T3a : limites de la salle (omo-limits.ts)", () => {
  it("valeurs de la spécification §4.8.2 et des décisions D-2b-29", () => {
    assert.deepEqual({ ...OMO_LIMITES, suspension: { ...OMO_LIMITES.suspension } }, {
      dureeMinutes: 60,
      sessionsMax: 30,
      tentatives429Max: 3,
      tachesDeFond: 2,
      finDemandeReposS: 15,
      suspension: { detections: 2, fenetreMin: 10 },
    });
  });

  it("aucune clé ni valeur de plafond de coût : le montant est saisi à chaque activation (Q7)", () => {
    const cles: string[] = [];
    const parcourir = (valeur: unknown, chemin: string): void => {
      if (valeur === null || typeof valeur !== "object") return;
      for (const [cle, sous] of Object.entries(valeur)) {
        cles.push(chemin === "" ? cle : `${chemin}.${cle}`);
        parcourir(sous, chemin === "" ? cle : `${chemin}.${cle}`);
      }
    };
    parcourir(OMO_LIMITES, "");
    assert.deepEqual(cles.filter((cle) => /plafond|cout|co[uû]t|usd|montant|cents|budget|dollar/iu.test(cle)), []);
    // Garde éprouvée : une clé de coût ajoutée serait trouvée.
    const faux: string[] = [];
    parcourir({ dureeMinutes: 60, plafondUsd: 1 }, "");
    for (const cle of ["dureeMinutes", "plafondUsd"]) if (/plafond|usd/iu.test(cle)) faux.push(cle);
    assert.deepEqual(faux, ["plafondUsd"]);
  });

  it("table gelée et module sans autre exportation de valeur", async () => {
    assert.equal(Object.isFrozen(OMO_LIMITES), true);
    assert.equal(Object.isFrozen(OMO_LIMITES.suspension), true);
    const module = (await import("./shared/omo-limits.ts")) as Record<string, unknown>;
    assert.deepEqual(
      Object.keys(module).filter((nom) => nom !== "default"),
      ["OMO_LIMITES"],
    );
  });

  it("modules partagés de la salle : purs (ni node:, ni process, ni horloge, ni aléa, ni réseau ; imports voisins seulement)", () => {
    for (const fichier of ["omo-types.ts", "omo-limits.ts", "omo-room-texts.ts"]) {
      const source = fs.readFileSync(path.join(import.meta.dirname, "shared", fichier), "utf8");
      assert.equal(source.includes('"node:'), false, fichier);
      assert.equal(/\bprocess\./u.test(source), false, fichier);
      assert.equal(/\bDate\.now\b|new Date\b|Math\.random|\bfetch\s*\(|\bsetTimeout\b|\bperformance\./u.test(source), false, fichier);
      for (const spec of [...source.matchAll(/\bfrom\s*["']([^"']+)["']/gu)].map((m) => m[1] ?? "")) assert.match(spec, /^\.\/[\w.-]+\.ts$/u, `${fichier} : ${spec}`);
    }
  });
});

// --- Contrat machine ------------------------------------------------------------------------------------------------------------------

/** Règles du contrat qui ne tiennent pas dans le schéma ; rend la liste des écarts (vide = contrat conforme). */
function ecartsDuContrat(contrat: OmoSalleContract): string[] {
  const ecarts: string[] = [];
  const sansDoublon = (nom: string, valeurs: readonly string[]): void => {
    if (new Set(valeurs).size !== valeurs.length) ecarts.push(`${nom} : doublon`);
  };
  const dans = (chemin: string, racine: string): boolean => chemin === racine || chemin.startsWith(`${racine}/`);

  sansDoublon("volumes", contrat.volumes.map((volume) => volume.nom));
  sansDoublon("perimetreManifeste", contrat.perimetreManifeste);
  sansDoublon("dossiersConfigHome", contrat.dossiersConfigHome);
  sansDoublon("nomsPrecontrole", [...contrat.nomsPrecontrole.fichiers, ...contrat.nomsPrecontrole.dossiers]);
  sansDoublon("variables.cockpit", contrat.variables.cockpit);
  sansDoublon("variables.salle", contrat.variables.salle);
  sansDoublon("cheminsImage", Object.values(contrat.cheminsImage));
  sansDoublon(
    "montages",
    contrat.volumes.flatMap((volume) => volume.montages.map((montage) => `${montage.service}:${montage.cible}`)),
  );

  // D-2b-32 : tout chemin de l'image est haché, sauf la licence et la référence du manifeste, qui reste hors périmètre.
  for (const [role, chemin] of Object.entries(contrat.cheminsImage)) {
    const couvert = contrat.perimetreManifeste.some((racine) => dans(chemin, racine));
    if (role === "referenceManifeste" && couvert) ecarts.push("referenceManifeste dans le périmètre du manifeste");
    if (role !== "referenceManifeste" && role !== "licence" && !couvert) ecarts.push(`${role} hors du périmètre du manifeste`);
  }

  // D-2b-33, révisée au train de V1 (demande de contrat (A) de L15a) : les cinq dossiers de configuration du HOME viennent d'UN
  // volume à root, monté en lecture seule sur chacun, dans la salle seule ; son unique montage en écriture est celui du superviseur
  // (root), HORS du HOME, où il pose le omo.jsonc de référence de l'image et un .gitignore (la 4.19.4 ne lit sa configuration
  // utilisateur qu'à ~/.omo/omo.jsonc ; opencode écrit un .gitignore dans chaque dossier de configuration, EROFS sinon).
  const dansLeHome = (chemin: string): boolean => dans(chemin, "/home/node");
  const config = contrat.volumes.find((volume) => volume.montages.some((montage) => contrat.dossiersConfigHome.includes(montage.cible)));
  if (config === undefined) ecarts.push("aucun volume pour les dossiers de configuration du HOME");
  else {
    if (config.proprietaire !== "root") ecarts.push(`${config.nom} : propriétaire attendu root`);
    if (config.montages.some((montage) => montage.service !== "salle")) ecarts.push(`${config.nom} : monté hors de la salle`);
    const enLecture = config.montages.filter((montage) => montage.mode === "ro");
    assertMemeEnsemble(ecarts, "dossiersConfigHome", contrat.dossiersConfigHome, enLecture.map((montage) => montage.cible));
    for (const montage of config.montages) {
      if (montage.mode === "rw" && dansLeHome(montage.cible)) ecarts.push(`${config.nom} : écrit dans le HOME (${montage.cible})`);
    }
  }
  for (const volume of contrat.volumes) {
    if (volume === config) continue;
    for (const montage of volume.montages) {
      if (contrat.dossiersConfigHome.includes(montage.cible)) ecarts.push(`${volume.nom} : monte un dossier de configuration du HOME (${montage.cible})`);
    }
  }
  if (contrat.dossiersConfigHome.length !== 5) ecarts.push("dossiersConfigHome : cinq dossiers attendus (D-2b-33)");

  // Un seul écrivain par volume ; les autres services ne le montent qu'en lecture seule.
  for (const volume of contrat.volumes) {
    const enEcriture = volume.montages.filter((montage) => montage.mode === "rw");
    if (volume.ecrivain === null && enEcriture.length > 0) ecarts.push(`${volume.nom} : écrit sans écrivain déclaré`);
    if (volume.ecrivain !== null && enEcriture.length !== 1) ecarts.push(`${volume.nom} : ${enEcriture.length} montage(s) en écriture`);
    for (const montage of enEcriture) if (montage.service !== volume.ecrivain) ecarts.push(`${volume.nom} : écrit par ${montage.service}`);
  }

  // D-2b-26 : la salle ne monte jamais oc-data ni un volume de l'instance principale ; le dossier de contrôle lui est en lecture seule.
  for (const volume of contrat.volumes) {
    if (["oc-data", "oc-config", "oc-cache", "control", "cockpit-data"].includes(volume.nom)) ecarts.push(`${volume.nom} : volume de l'instance principale`);
    for (const montage of volume.montages) if (montage.service === "salle" && montage.mode === "rw" && volume.ecrivain !== "salle") ecarts.push(`${volume.nom} : écrit par la salle`);
  }

  // Sécurité (§3.15.2, MO-7, D-2b-15).
  for (const capacite of contrat.securite.cap_add) if (capacite !== "SETUID" && capacite !== "SETGID") ecarts.push(`cap_add : ${capacite}`);
  if (!contrat.securite.security_opt.includes("no-new-privileges:true")) ecarts.push("security_opt : no-new-privileges:true absent");
  assertMemeEnsemble(ecarts, "tmpfs", contrat.securite.tmpfs.map((entree) => entree.split(":")[0] ?? ""), ["/home/node", "/tmp"]);
  for (const entree of contrat.securite.tmpfs) if (!entree.split(":").slice(1).join(",").split(",").includes("exec")) ecarts.push(`tmpfs : ${entree} sans exec`);

  // Variables : aucun nom commun aux deux listes, liste blanche fermée pour la salle (aucun secret du cockpit).
  for (const nom of contrat.variables.salle) {
    if (contrat.variables.cockpit.includes(nom)) ecarts.push(`variables : ${nom} des deux côtés`);
    if (!VARIABLES_SALLE_ATTENDUES.includes(nom)) ecarts.push(`variables.salle : ${nom} hors de la liste blanche`);
  }
  return ecarts;
}

const VARIABLES_SALLE_ATTENDUES = ["HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY", "OPENCODE_SERVER_USERNAME", "OPENCODE_SERVER_PASSWORD", "COCKPIT_COPILOT_API_URL", "NODE_EXTRA_CA_CERTS"];

function assertMemeEnsemble(ecarts: string[], nom: string, attendu: readonly string[], recu: readonly string[]): void {
  const a = [...new Set(attendu)].sort();
  const b = [...new Set(recu)].sort();
  if (a.join("|") !== b.join("|")) ecarts.push(`${nom} : ${b.join(", ")} au lieu de ${a.join(", ")}`);
}

/** Valide un contrat lu : forme (schéma) puis règles. */
function verifierContrat(valeur: unknown): string[] {
  const lu = OMO_SALLE_CONTRACT_SCHEMA.safeParse(valeur);
  if (!lu.success) return lu.error.issues.map((issue) => `${issue.path.join(".")} : ${issue.code}`);
  return ecartsDuContrat(lu.data);
}

describe("T3a : contrat machine contrat-salle.json (D-2b-39)", () => {
  const brut = fs.readFileSync(path.join(RACINE, OMO_SALLE_CONTRACT_FILE), "utf8");
  const contrat = JSON.parse(brut) as OmoSalleContract;

  it("fichier JSON strict, sans marque d'ordre, terminé par une fin de ligne", () => {
    assert.equal(brut.startsWith("{"), true);
    assert.equal(brut.endsWith("}\n"), true);
  });

  it("forme conforme à OmoSalleContract et règles du plan tenues", () => {
    assert.deepEqual(verifierContrat(contrat), []);
  });

  it("services, profil, réseau, fichiers de contrôle et port d'egress", () => {
    assert.deepEqual(contrat.services, { salle: "opencode-omo", egress: "egress", cockpit: "cockpit", principale: "opencode" });
    assert.equal(contrat.profil, "omo");
    assert.equal(contrat.reseau, "omo-internal");
    assert.deepEqual(contrat.fichiersControle, {
      battement: "heartbeat",
      arret: "stop-request",
      precheck: "precheck-ok",
      garde: "guard-state.json",
      projets: "omo-projets.json",
    });
    assert.equal(contrat.etat, "state.json");
    assert.equal(contrat.egress.port, 3128);
    for (const nom of [...Object.values(contrat.fichiersControle), contrat.etat]) assert.doesNotMatch(nom, /[\\/]/u, nom);
  });

  it("volumes : contrôle et authentification écrits par le cockpit, état par la salle, journal par egress, sessions de la salle", () => {
    const par = (nom: string) => contrat.volumes.find((volume) => volume.nom === nom);
    assert.deepEqual(contrat.volumes.map((volume) => volume.nom), ["control-omo", "omo-auth", "omo-state", "egress-log", "oc-omo-data", "omo-config"]);
    assert.deepEqual(par("control-omo")?.montages, [
      { service: "cockpit", cible: "/control-omo", mode: "rw" },
      { service: "salle", cible: "/control", mode: "ro" },
    ]);
    assert.deepEqual(par("omo-auth")?.montages, [
      { service: "cockpit", cible: "/omo-auth", mode: "rw" },
      { service: "salle", cible: "/auth-src", mode: "ro" },
    ]);
    assert.equal(par("omo-state")?.ecrivain, "salle");
    assert.equal(par("omo-state")?.proprietaire, "root");
    assert.equal(par("egress-log")?.ecrivain, "egress");
    assert.equal(par("oc-omo-data")?.montages[0]?.cible, "/home/node/.local/share/opencode");
    // Train de V1 : la configuration du HOME n'est plus un volume vide. Le superviseur (root) remplit omo-config sur /omo-config, seul
    // montage en écriture, hors du HOME ; les cinq dossiers le voient en lecture seule.
    assert.equal(par("omo-config")?.ecrivain, "salle");
    assert.equal(par("omo-config")?.proprietaire, "root");
    assert.deepEqual(par("omo-config")?.montages, [
      { service: "salle", cible: "/omo-config", mode: "rw" },
      ...contrat.dossiersConfigHome.map((cible) => ({ service: "salle", cible, mode: "ro" })),
    ]);
  });

  it("chemins de l'image : les douze chemins attendus, tous absolus (identifiant d'image ajouté au train de V0)", () => {
    assert.deepEqual(Object.values(contrat.cheminsImage).sort(), [
      "/etc/omo-reference/omo-manifest.sha256",
      "/etc/opencode-omo",
      "/etc/opencode-omo/image-id",
      "/opt/omo",
      "/opt/omo-check/enums-4.19.4.json",
      "/opt/omo-check/manifest.sh",
      "/opt/omo-check/supervisor-lib.mjs",
      "/opt/omo-check/validate-core.mjs",
      "/opt/omo-check/validate.mjs",
      "/opt/omo-guard/cockpit-guard.js",
      "/usr/local/bin/omo-supervisor",
      "/usr/share/doc/oh-my-openagent/LICENSE.md",
    ]);
    assert.equal(Object.keys(contrat.cheminsImage).length, 12);
    assert.deepEqual(contrat.perimetreManifeste, ["/opt/omo", "/opt/omo-check", "/opt/omo-guard", "/etc/opencode-omo", "/usr/local/bin/omo-supervisor"]);
  });

  it("variables : les dix noms du cockpit, liste blanche fermée pour la salle", () => {
    assert.deepEqual(contrat.variables.cockpit, [
      "COCKPIT_OMO",
      "OPENCODE_OMO_URL",
      "OPENCODE_OMO_PASSWORD",
      "COCKPIT_OMO_IMAGE",
      "COCKPIT_OMO_CONTROL_DIR",
      "COCKPIT_OMO_STATE_DIR",
      "COCKPIT_OMO_AUTH_DIR",
      "COCKPIT_OMO_PROJECTS_FILE",
      "COCKPIT_EGRESS_JOURNAL",
      "COCKPIT_AUTONOMY",
    ]);
    assert.deepEqual(contrat.variables.salle, VARIABLES_SALLE_ATTENDUES);
    for (const secret of ["COCKPIT_TOKEN", "OPENCODE_OMO_PASSWORD", "COCKPIT_OMO_IMAGE"]) assert.equal(contrat.variables.salle.includes(secret), false, secret);
  });

  it("chaque règle est discriminante : une mutation du contrat est refusée", () => {
    const mute = (change: (copie: OmoSalleContract) => void): string[] => {
      const copie = structuredClone(contrat);
      change(copie);
      return verifierContrat(copie);
    };
    const refuse = (nom: string, change: (copie: OmoSalleContract) => void): void => {
      assert.notDeepEqual(mute(change), [], nom);
    };
    refuse("clé inconnue", (c) => {
      (c as unknown as Record<string, unknown>).extra = 1;
    });
    refuse("chemin relatif", (c) => {
      c.cheminsImage.superviseur = "usr/local/bin/omo-supervisor";
    });
    refuse("chemin avec ..", (c) => {
      c.cheminsImage.extension = "/opt/omo/../omo";
    });
    refuse("capacité ajoutée", (c) => {
      (c.securite.cap_add as string[]).push("NET_ADMIN");
    });
    refuse("no-new-privileges retiré", (c) => {
      c.securite.security_opt = [];
    });
    refuse("read_only retiré", (c) => {
      (c.securite as unknown as Record<string, unknown>).read_only = false;
    });
    refuse("tmpfs sans exec", (c) => {
      c.securite.tmpfs = ["/home/node", "/tmp:exec"];
    });
    refuse("référence du manifeste dans le périmètre", (c) => {
      c.cheminsImage.referenceManifeste = "/opt/omo-check/omo-manifest.sha256";
    });
    refuse("superviseur hors du périmètre", (c) => {
      c.perimetreManifeste = c.perimetreManifeste.filter((chemin) => chemin !== "/usr/local/bin/omo-supervisor");
    });
    refuse("dossier de configuration du HOME non monté", (c) => {
      c.dossiersConfigHome = c.dossiersConfigHome.filter((chemin) => chemin !== "/home/node/.agents");
    });
    const configHome = (c: OmoSalleContract) => {
      const volume = c.volumes.find((v) => v.nom === "omo-config");
      assert.ok(volume, "volume omo-config absent du contrat");
      return volume;
    };
    refuse("dossier de configuration inscriptible", (c) => {
      const montage = configHome(c).montages.find((m) => m.cible === "/home/node/.omo");
      if (montage !== undefined) montage.mode = "rw";
    });
    refuse("configuration du HOME écrite depuis le HOME", (c) => {
      const montage = configHome(c).montages.find((m) => m.mode === "rw");
      if (montage !== undefined) montage.cible = "/home/node/.omo-ecriture";
    });
    refuse("volume de configuration du HOME à node", (c) => {
      configHome(c).proprietaire = "node";
    });
    refuse("volume de configuration du HOME monté par le cockpit", (c) => {
      configHome(c).montages.push({ service: "cockpit", cible: "/omo-config", mode: "ro" });
    });
    refuse("volume de configuration du HOME écrit par personne mais monté en écriture", (c) => {
      configHome(c).ecrivain = null;
    });
    refuse("dossier de configuration du HOME pris sur un autre volume", (c) => {
      const config = configHome(c);
      config.montages = config.montages.filter((m) => m.cible !== "/home/node/.agents");
      c.volumes.find((v) => v.nom === "oc-omo-data")?.montages.push({ service: "salle", cible: "/home/node/.agents", mode: "ro" });
    });
    refuse("contrôle inscriptible par la salle", (c) => {
      const control = c.volumes.find((volume) => volume.nom === "control-omo");
      if (control?.montages[1] !== undefined) control.montages[1].mode = "rw";
    });
    refuse("deux écrivains", (c) => {
      const etat = c.volumes.find((volume) => volume.nom === "omo-state");
      if (etat?.montages[1] !== undefined) etat.montages[1].mode = "rw";
    });
    refuse("oc-data monté dans la salle (D-2b-26)", (c) => {
      c.volumes.push({ nom: "oc-data", proprietaire: "node", ecrivain: null, montages: [{ service: "salle", cible: "/auth-src", mode: "ro" }] });
    });
    refuse("variable hors liste blanche pour la salle", (c) => {
      c.variables.salle = [...c.variables.salle, "COCKPIT_TOKEN"];
    });
    refuse("doublon de variable", (c) => {
      c.variables.cockpit = [...c.variables.cockpit, "COCKPIT_OMO"];
    });
    refuse("doublon de chemin d'image", (c) => {
      c.cheminsImage.valider = c.cheminsImage.validerCoeur;
    });
    refuse("nom de fichier de contrôle transformé en chemin", (c) => {
      (c.fichiersControle as unknown as Record<string, string>).battement = "sous/heartbeat";
    });
    refuse("profil changé", (c) => {
      (c as unknown as Record<string, unknown>).profil = "autre";
    });
    // Le contrat livré, lui, passe toutes ces règles.
    assert.deepEqual(verifierContrat(contrat), []);
  });

  it("noms du pré-contrôle : relatifs, sans doublon, avec les noms de la spécification et .agents (D-2b-34)", () => {
    for (const nom of [...contrat.nomsPrecontrole.fichiers, ...contrat.nomsPrecontrole.dossiers]) {
      assert.doesNotMatch(nom, /^\//u, nom);
      assert.doesNotMatch(nom, /(?:^|\/)\.\.?(?:\/|$)/u, nom);
    }
    for (const nom of [".omo/omo.json", ".omo/omo.jsonc", "oh-my-openagent.json", "oh-my-opencode.json", ".mcp.json", "opencode.json", "opencode.jsonc"]) {
      assert.ok(contrat.nomsPrecontrole.fichiers.includes(nom), nom);
    }
    assert.deepEqual(contrat.nomsPrecontrole.dossiers, [".sisyphus", ".claude", ".opencode", ".agents"]);
  });
});
