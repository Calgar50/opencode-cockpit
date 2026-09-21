// Tests T3c : lecture de l'environnement de la Salle OMO (`parseOmo`, `AppEnv.omo`, `omoOf`).
// Spécification §3.6 l.289 (COCKPIT_OMO=on|off, défaut off, jamais modifiable depuis l'interface) et §3.15 ; plan d'exécution
// 2 bis-2 ter §4.3 ; contrat machine docker/opencode-omo/contrat-salle.json (`variables.cockpit`, D-2b-39).
// Aucun comportement de la salle n'est exercé : seuls des réglages sont lus. Le mot de passe du serveur de la salle est tiré au
// hasard à chaque exécution et n'est jamais imprimé ; un espion vérifie qu'aucune sortie ne le laisse échapper.
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import { EGRESS_JOURNAL_DOSSIER_DEFAUT } from "./egress-journal.ts";
import {
  type AppEnv,
  EnvError,
  loadEnv,
  OMO_AUTH_DIR_DEFAUT,
  OMO_CONTROL_DIR_DEFAUT,
  OMO_COUPEE,
  OMO_EGRESS_JOURNAL_DEFAUT,
  OMO_PASSWORD_MIN,
  OMO_STATE_DIR_DEFAUT,
  OMO_URL_DEFAUT,
  omoOf,
  parseOmo,
} from "./env.ts";
import { FETCH_BLOCKED_PORTS } from "./fetch-ports.ts";
import { OMO_SALLE_CONTRACT_FILE } from "./omo-contracts.ts";
import type { OmoSalleContract } from "./shared/omo-types.ts";

const RACINE = path.join(import.meta.dirname, "..", "..");
const CONTRAT = JSON.parse(fs.readFileSync(path.join(RACINE, OMO_SALLE_CONTRACT_FILE), "utf8")) as OmoSalleContract;

/** Secrets de test, tirés à chaque exécution : jamais écrits en clair dans le dépôt. */
const TOKEN = randomBytes(36).toString("base64url");
const PASSWORD = randomBytes(18).toString("base64url");
const OMO_PASSWORD = randomBytes(32).toString("base64url");

const base = () => ({ COCKPIT_TOKEN: TOKEN, OPENCODE_SERVER_PASSWORD: PASSWORD });
const ouverte = (extra: NodeJS.ProcessEnv = {}) => ({ COCKPIT_OMO: "on", OPENCODE_OMO_PASSWORD: OMO_PASSWORD, ...extra });

/** Volume du contrat monté dans le cockpit : cible attendue d'office. */
function cibleCockpit(nom: string): string {
  const volume = CONTRAT.volumes.find((v) => v.nom === nom);
  assert.ok(volume, `volume ${nom} absent du contrat`);
  const montage = volume.montages.find((m) => m.service === "cockpit");
  assert.ok(montage, `volume ${nom} non monté dans le cockpit`);
  return montage.cible;
}

describe("T3c : COCKPIT_OMO, interrupteur de la salle (§3.6 l.289)", () => {
  it("absent, vide ou « off » : salle coupée ; « on » l'ouvre ; toute autre valeur refuse le démarrage", () => {
    assert.equal(parseOmo({}).enabled, false);
    for (const value of ["", " ", "off", "OFF", " Off "]) assert.equal(parseOmo({ COCKPIT_OMO: value }).enabled, false, JSON.stringify(value));
    for (const value of ["on", "ON", " On "]) {
      assert.equal(parseOmo({ COCKPIT_OMO: value, OPENCODE_OMO_PASSWORD: OMO_PASSWORD }).enabled, true, JSON.stringify(value));
    }
    for (const value of ["oui", "1", "0", "true", "false", "non", "yes", "enabled"]) {
      assert.throws(
        () => parseOmo({ COCKPIT_OMO: value, OPENCODE_OMO_PASSWORD: OMO_PASSWORD }),
        (err: unknown) => {
          assert.ok(err instanceof EnvError, String(err));
          assert.equal(err.message, "COCKPIT_OMO : valeur refusée (on ou off).");
          return true;
        },
        value,
      );
    }
  });

  it("salle coupée : valeurs d'office, aucune exigence de mot de passe ; AppEnv.omo rempli par loadEnv", () => {
    const omo = parseOmo({});
    assert.deepEqual(omo, {
      enabled: false,
      url: OMO_URL_DEFAUT,
      password: "",
      image: "",
      controlDir: path.resolve(OMO_CONTROL_DIR_DEFAUT),
      stateDir: path.resolve(OMO_STATE_DIR_DEFAUT),
      authDir: path.resolve(OMO_AUTH_DIR_DEFAUT),
      projectsFile: null,
      egressJournal: path.resolve(OMO_EGRESS_JOURNAL_DEFAUT),
    });
    assert.deepEqual(loadEnv(base()).omo, omo);
    // Champ absent (objet AppEnv construit à la main) : salle coupée, jamais « undefined » qui traverse le serveur.
    assert.equal(omoOf({}), OMO_COUPEE);
    assert.equal(omoOf({ omo }), omo);
    assert.equal(OMO_COUPEE.enabled, false);
    assert.equal(OMO_COUPEE.password, "");
    assert.throws(() => {
      (OMO_COUPEE as { enabled: boolean }).enabled = true;
    }, TypeError);
  });
});

describe("T3c : mot de passe du serveur de la salle, jamais journalisé", () => {
  it(`exigé (${OMO_PASSWORD_MIN} caractères au moins) seulement salle ouverte ; trop court refusé`, () => {
    assert.equal(OMO_PASSWORD_MIN, 32);
    assert.equal(parseOmo(ouverte()).password, OMO_PASSWORD);
    assert.equal(OMO_PASSWORD.length >= OMO_PASSWORD_MIN, true);
    // Salle coupée : aucune exigence, la valeur est simplement reportée.
    assert.equal(parseOmo({ OPENCODE_OMO_PASSWORD: "court" }).password, "court");
    assert.equal(parseOmo({}).password, "");
    for (const court of ["", "   ", "x", "a".repeat(OMO_PASSWORD_MIN - 1)]) {
      assert.throws(
        () => parseOmo({ COCKPIT_OMO: "on", OPENCODE_OMO_PASSWORD: court }),
        (err: unknown) => {
          assert.ok(err instanceof EnvError, String(err));
          assert.equal(err.message, `Variable OPENCODE_OMO_PASSWORD manquante ou trop courte (${OMO_PASSWORD_MIN} caractères minimum).`);
          return true;
        },
        JSON.stringify(court),
      );
    }
  });

  it("espion des sorties : lire l'environnement n'écrit rien, et aucun message d'erreur ne recopie un secret ni une adresse", (t) => {
    const ecrit: string[] = [];
    for (const flux of [process.stdout, process.stderr]) {
      t.mock.method(flux, "write", (chunk: unknown) => {
        ecrit.push(String(chunk));
        return true;
      });
    }
    for (const niveau of ["log", "info", "warn", "error", "debug"] as const) {
      t.mock.method(console, niveau, (...args: unknown[]) => ecrit.push(args.map(String).join(" ")));
    }

    const secret = randomBytes(24).toString("base64url");
    const env = {
      ...base(),
      ...ouverte(),
      OPENCODE_OMO_PASSWORD: secret,
      COCKPIT_OMO_IMAGE: "registre.interne.test/salle@sha256:0f1e",
      OPENCODE_OMO_URL: "http://salle-interne.test:4096",
    };
    assert.equal(loadEnv(env).omo?.password, secret);
    // Chaque refus possible : la clé est nommée, la valeur lue ne l'est jamais.
    const refus: string[] = [];
    for (const casse of [
      { ...env, COCKPIT_OMO: "oui" },
      { ...env, OPENCODE_OMO_PASSWORD: secret.slice(0, 8) },
      { ...env, OPENCODE_OMO_URL: "ftp://salle-interne.test:21" },
      { ...env, OPENCODE_OMO_URL: "pas une adresse" },
      { ...env, COCKPIT_OMO_CONTROL_DIR: "control-omo" },
      { ...env, COCKPIT_OMO_PROJECTS_FILE: "omo-projets.json" },
    ]) {
      assert.throws(
        () => loadEnv(casse),
        (err: unknown) => {
          assert.ok(err instanceof EnvError, String(err));
          refus.push(err.message);
          return true;
        },
        JSON.stringify(Object.keys(casse).length),
      );
    }
    assert.equal(refus.length, 6);
    assert.deepEqual(ecrit, [], "lire l'environnement ne doit rien écrire");
    for (const texte of [...refus, ...ecrit]) {
      for (const interdit of [secret, secret.slice(0, 8), TOKEN, PASSWORD, "registre.interne.test", "salle-interne.test", "omo-projets.json"]) {
        assert.equal(texte.includes(interdit), false, `${texte} recopie une valeur lue`);
      }
    }
  });
});

describe("T3c : adresse et chemins de la salle", () => {
  it("OPENCODE_OMO_URL : défaut du contrat, barres finales retirées, schéma et port vérifiés", () => {
    assert.equal(parseOmo({}).url, OMO_URL_DEFAUT);
    assert.equal(parseOmo({ OPENCODE_OMO_URL: "  " }).url, OMO_URL_DEFAUT);
    assert.equal(parseOmo({ OPENCODE_OMO_URL: "http://salle.test:4096///" }).url, "http://salle.test:4096");
    assert.equal(parseOmo({ OPENCODE_OMO_URL: "https://salle.test" }).url, "https://salle.test");
    for (const mauvaise of ["ftp://salle.test:21", "file:///etc/passwd", "salle.test:4096"]) {
      assert.throws(() => parseOmo({ OPENCODE_OMO_URL: mauvaise }), EnvError, mauvaise);
    }
    // Même piège que OPENCODE_URL : un port refusé par fetch rendrait la salle injoignable sans erreur lisible.
    for (const port of FETCH_BLOCKED_PORTS) {
      assert.throws(
        () => parseOmo({ OPENCODE_OMO_URL: `http://salle.test:${port}` }),
        (err: unknown) => err instanceof EnvError && err.message.includes(`le port ${port} est refusé par fetch`),
        `port ${port}`,
      );
    }
    assert.equal(parseOmo({ OPENCODE_OMO_URL: "http://salle.test:4096" }).url, "http://salle.test:4096");
  });

  it("dossiers : chemin absolu exigé, valeurs d'office égales aux montages du contrat ; omo-projets.json absent = null", () => {
    assert.equal(OMO_URL_DEFAUT, `http://${CONTRAT.services.salle}:4096`);
    assert.equal(OMO_CONTROL_DIR_DEFAUT, cibleCockpit("control-omo"));
    assert.equal(OMO_STATE_DIR_DEFAUT, cibleCockpit("omo-state"));
    assert.equal(OMO_AUTH_DIR_DEFAUT, cibleCockpit("omo-auth"));
    assert.equal(OMO_EGRESS_JOURNAL_DEFAUT, cibleCockpit("egress-log"));
    // Le cockpit et `egress` lisent le même journal : une seule valeur d'office dans tout le serveur.
    assert.equal(OMO_EGRESS_JOURNAL_DEFAUT, EGRESS_JOURNAL_DOSSIER_DEFAUT);

    const absolu = path.resolve(path.sep, "ailleurs", "salle");
    const omo = parseOmo({
      COCKPIT_OMO_CONTROL_DIR: absolu,
      COCKPIT_OMO_STATE_DIR: absolu,
      COCKPIT_OMO_AUTH_DIR: absolu,
      COCKPIT_EGRESS_JOURNAL: absolu,
      COCKPIT_OMO_PROJECTS_FILE: path.join(absolu, CONTRAT.fichiersControle.projets),
      COCKPIT_OMO_IMAGE: " image:etiquette ",
    });
    assert.deepEqual(
      { controlDir: omo.controlDir, stateDir: omo.stateDir, authDir: omo.authDir, egressJournal: omo.egressJournal },
      { controlDir: absolu, stateDir: absolu, authDir: absolu, egressJournal: absolu },
    );
    assert.equal(omo.projectsFile, path.join(absolu, CONTRAT.fichiersControle.projets));
    assert.equal(omo.image, "image:etiquette");
    assert.equal(parseOmo({ COCKPIT_OMO_PROJECTS_FILE: "  " }).projectsFile, null);

    for (const clef of ["COCKPIT_OMO_CONTROL_DIR", "COCKPIT_OMO_STATE_DIR", "COCKPIT_OMO_AUTH_DIR", "COCKPIT_EGRESS_JOURNAL", "COCKPIT_OMO_PROJECTS_FILE"]) {
      assert.throws(
        () => parseOmo({ [clef]: "relatif/salle" }),
        (err: unknown) => err instanceof EnvError && err.message.startsWith(`${clef} :`),
        clef,
      );
    }
  });
});

describe("T3c : noms lus = contrat machine (D-2b-39)", () => {
  it("chaque variable de `variables.cockpit` est lue par env.ts, et aucune autre variable de la salle ne l'est", () => {
    const attendus = [...CONTRAT.variables.cockpit].sort((a, b) => a.localeCompare(b));
    const source = fs.readFileSync(path.join(import.meta.dirname, "env.ts"), "utf8");
    // Deux formes de lecture dans env.ts : `env.NOM` et le nom passé en chaîne à une aide (absolutePath, required).
    const noms = new Set<string>();
    for (const trouve of source.matchAll(/\benv\.([A-Z][A-Z0-9_]*)\b|["']((?:COCKPIT|OPENCODE)_[A-Z0-9_]+)["']/gu)) {
      noms.add((trouve[1] ?? trouve[2]) as string);
    }
    const salle = [...noms].filter((nom) => /^(?:COCKPIT_OMO|OPENCODE_OMO)/u.test(nom) || nom === "COCKPIT_EGRESS_JOURNAL" || nom === "COCKPIT_AUTONOMY");
    assert.deepEqual(
      salle.sort((a, b) => a.localeCompare(b)),
      attendus,
    );
  });

  it("chaque variable du contrat change bien le résultat : aucune n'est lue sous un autre nom", () => {
    const absolu = path.resolve(path.sep, "essai");
    const cas: Record<string, { valeur: string; lu: (omo: NonNullable<AppEnv["omo"]>) => unknown; attendu: unknown }> = {
      COCKPIT_OMO: { valeur: "on", lu: (omo) => omo.enabled, attendu: true },
      OPENCODE_OMO_URL: { valeur: "https://autre-salle.test", lu: (omo) => omo.url, attendu: "https://autre-salle.test" },
      OPENCODE_OMO_PASSWORD: { valeur: OMO_PASSWORD, lu: (omo) => omo.password, attendu: OMO_PASSWORD },
      COCKPIT_OMO_IMAGE: { valeur: "salle:essai", lu: (omo) => omo.image, attendu: "salle:essai" },
      COCKPIT_OMO_CONTROL_DIR: { valeur: absolu, lu: (omo) => omo.controlDir, attendu: absolu },
      COCKPIT_OMO_STATE_DIR: { valeur: absolu, lu: (omo) => omo.stateDir, attendu: absolu },
      COCKPIT_OMO_AUTH_DIR: { valeur: absolu, lu: (omo) => omo.authDir, attendu: absolu },
      COCKPIT_OMO_PROJECTS_FILE: { valeur: absolu, lu: (omo) => omo.projectsFile, attendu: absolu },
      COCKPIT_EGRESS_JOURNAL: { valeur: absolu, lu: (omo) => omo.egressJournal, attendu: absolu },
    };
    // COCKPIT_AUTONOMY est au contrat lui aussi, mais il est lu hors de parseOmo (interrupteur commun, §9.4 n° 3).
    assert.deepEqual(
      [...CONTRAT.variables.cockpit].filter((nom) => nom !== "COCKPIT_AUTONOMY").sort((a, b) => a.localeCompare(b)),
      Object.keys(cas).sort((a, b) => a.localeCompare(b)),
    );
    assert.equal(loadEnv({ ...base(), COCKPIT_AUTONOMY: "off" }).autonomy, false);
    const coupee = omoOf(loadEnv({ ...base(), COCKPIT_OMO: "off" }));
    for (const [nom, { valeur, lu, attendu }] of Object.entries(cas)) {
      assert.deepEqual(lu(omoOf(loadEnv({ ...base(), ...ouverte(), [nom]: valeur }))), attendu, nom);
      // Sans la variable, la valeur lue diffère : la lecture vient bien de ce nom-là.
      assert.notDeepEqual(lu(coupee), attendu, `${nom} : la variable ne change rien`);
    }
  });
});
