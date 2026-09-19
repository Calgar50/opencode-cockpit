// Superviseur de la Salle OMO (L17a) : la bibliothèque qui tourne dans l'image (`docker/opencode-omo/supervisor-lib.mjs`), puis le
// superviseur entier dans un conteneur jetable.
//
// Deux étages :
// 1. UNITAIRES, dans `npm test` : lectures bornées, battement périmé, `startId` d'un autre démarrage, manifeste, dossiers de
//    configuration et volumes (propriétaire, point de montage : MO-3, MO-11), bascule vers node (MO-7), boucle de l'homme mort,
//    purge (MO-2), copie d'`auth.json`, balayage git. Aucun conteneur, aucune pause fixe, aucun port.
// 2. CONTENEUR, SAUTÉS sans `OMO_TESTS_CONTENEUR=1` (D-2b-44) : un conteneur Debian jetable, JAMAIS l'image `opencode-omo`, jamais
//    l'extension, jamais un vrai opencode — un faux opencode d'une douzaine de lignes suffit à prouver l'homme mort. Les options de
//    sécurité sont celles du contrat (`cap_drop: ALL` + SETUID/SETGID, `no-new-privileges`, `read_only`, tmpfs). Les volumes sont
//    des volumes nommés `omo11-l17a-*` : sur un bind de l'hôte, ni les droits 0600 ni le propriétaire ne voudraient dire quoi que
//    ce soit. Nettoyage même en échec.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import * as salle from "../../docker/opencode-omo/supervisor-lib.mjs";
import { analyserEtat } from "./shared/omo-control-protocol.ts";

const RACINE = path.join(import.meta.dirname, "..", "..");
const DOCKER_OMO = path.join(RACINE, "docker", "opencode-omo");

// --- Dossiers de test ------------------------------------------------------------------------------------------------------------

function dossierTemporaire(): string {
  return fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "omo-l17a-"));
}

/** Lien de dossier : jonction sous Windows (aucun privilège demandé), lien symbolique ailleurs. `null` si le système refuse. */
function lienDossier(cible: string, lien: string): boolean {
  try {
    fs.symlinkSync(cible, lien, process.platform === "win32" ? "junction" : "dir");
    return true;
  } catch {
    return false;
  }
}

// --- Bibliothèque du superviseur : lectures bornées -------------------------------------------------------------------------------

describe("superviseur : lectures bornées (fermé en cas de doute)", () => {
  it("un fichier de contrôle de plus de 64 Kio n'est jamais lu", (t) => {
    const dir = dossierTemporaire();
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const chemin = path.join(dir, salle.FICHIERS_CONTROLE.battement);
    fs.writeFileSync(chemin, JSON.stringify({ at: 1757000000000, bourrage: "x".repeat(salle.OMO_CONTROL_MAX_OCTETS) }));
    assert.equal(salle.lireTexteBorne(chemin), null);
    assert.equal(salle.lireBattement(dir), null);
    // Sans la borne, ce battement serait lu : le même contenu, raccourci, l'est bien. La borne est la seule différence.
    fs.writeFileSync(chemin, JSON.stringify({ at: 1757000000000, bourrage: "x" }));
    assert.deepEqual(salle.lireBattement(dir), { at: 1757000000000 });
  });

  it("un fichier de 64 Kio pile est lu", (t) => {
    const dir = dossierTemporaire();
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const vide = JSON.stringify({ at: 1757000000000, bourrage: "" });
    const pile = JSON.stringify({ at: 1757000000000, bourrage: "x".repeat(salle.OMO_CONTROL_MAX_OCTETS - vide.length) });
    assert.equal(salle.tailleOctets(pile), salle.OMO_CONTROL_MAX_OCTETS);
    fs.writeFileSync(path.join(dir, salle.FICHIERS_CONTROLE.battement), pile);
    assert.deepEqual(salle.lireBattement(dir), { at: 1757000000000 });
  });

  it("un fichier qui annonce une taille nulle reste borné à la lecture (/proc)", { skip: process.platform !== "linux" && "/proc absent de ce système : joué sous Linux (CI) et dans le conteneur" }, () => {
    // /proc/self/status annonce 0 octet et en contient plus d'un millier : seule la borne de lecture l'arrête.
    assert.equal(fs.statSync("/proc/self/status").size, 0);
    assert.equal(salle.lireTexteBorne("/proc/self/status", 100), null);
    assert.match(salle.lireTexteBorne("/proc/self/status", 64 * 1024) ?? "", /^Name:/);
    // Un périphérique n'est pas un fichier : jamais lu, même s'il ne rendrait « rien ».
    assert.equal(salle.lireTexteBorne("/dev/null"), null);
  });

  it("un fichier absent, un dossier ou un fichier illisible valent « inconnu »", (t) => {
    const dir = dossierTemporaire();
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    assert.equal(salle.lireTexteBorne(path.join(dir, "absent")), null);
    fs.mkdirSync(path.join(dir, salle.FICHIERS_CONTROLE.battement));
    assert.equal(salle.lireBattement(dir), null);
    assert.equal(salle.lireArret(dir), null);
    assert.equal(salle.lirePrecheckOk(dir), null);
    assert.equal(salle.lireProjetsPrepares(dir), null);
  });
});

describe("superviseur : battement et pré-contrôle du démarrage en cours", () => {
  it("un battement périmé n'autorise rien", (t) => {
    const dir = dossierTemporaire();
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const maintenant = 1757000030000;
    fs.writeFileSync(path.join(dir, salle.FICHIERS_CONTROLE.battement), JSON.stringify({ at: 1757000000000 }));
    assert.equal(salle.battementFrais(salle.lireBattement(dir), maintenant), false);
    assert.equal(salle.decisionSuperviseur(salle.lireBattement(dir), null, maintenant), "battement-perime");
    // Le même battement, lu 10 s plus tôt, est frais : c'est bien l'âge qui décide, pas la présence du fichier.
    assert.equal(salle.battementFrais(salle.lireBattement(dir), 1757000010000), true);
  });

  it("un pré-contrôle d'un autre démarrage ne démarre rien", (t) => {
    const dir = dossierTemporaire();
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const startId = salle.nouveauStartId();
    const autre = salle.nouveauStartId();
    assert.notEqual(startId, autre);
    fs.writeFileSync(path.join(dir, salle.FICHIERS_CONTROLE.precheck), JSON.stringify({ startId: autre, at: 1757000000000, projets: [] }));
    assert.equal(salle.precheckDuDemarrage(salle.lirePrecheckOk(dir), startId, 1757000001000), false);
    fs.writeFileSync(path.join(dir, salle.FICHIERS_CONTROLE.precheck), JSON.stringify({ startId, at: 1757000000000, projets: [] }));
    assert.equal(salle.precheckDuDemarrage(salle.lirePrecheckOk(dir), startId, 1757000001000), true);
  });

  it("chaque identifiant de démarrage est neuf", () => {
    const vus = new Set(Array.from({ length: 64 }, () => salle.nouveauStartId()));
    assert.equal(vus.size, 64);
    for (const id of vus) assert.equal(salle.estStartId(id), true);
  });
});

// --- Signaux et présence d'opencode (mesure L17a : root sans CAP_KILL) -----------------------------------------------------------

describe("superviseur : présence d'opencode et signaux", () => {
  /** Faux /proc : un `stat` par processus, au format du noyau. */
  function faussePro(t: { after: (fn: () => void) => void }, etats: Record<string, string>): string {
    const dir = dossierTemporaire();
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    for (const [pid, contenu] of Object.entries(etats)) {
      fs.mkdirSync(path.join(dir, pid), { recursive: true });
      fs.writeFileSync(path.join(dir, pid, "stat"), contenu);
    }
    return dir;
  }

  it("un processus qui dort ou tourne est vivant ; un zombie ou un mort ne l'est plus", (t) => {
    const proc = faussePro(t, {
      "118": "118 (opencode) S 7 7 1 0 -1 4194560 120 0 0 0\n",
      "119": "119 (opencode) R 7 7 1 0 -1 4194560 120 0 0 0\n",
      "120": "120 (opencode) Z 7 7 1 0 -1 4194560 120 0 0 0\n",
      "121": "121 (opencode) X 7 7 1 0 -1 4194560 120 0 0 0\n",
    });
    assert.equal(salle.vivant(118, proc), true);
    assert.equal(salle.vivant("119", proc), true);
    // Sans ce contrôle, un opencode mort mais pas encore ramassé passerait pour vivant jusqu'à l'arrêt du conteneur.
    assert.equal(salle.vivant(120, proc), false);
    assert.equal(salle.vivant(121, proc), false);
    assert.equal(salle.vivant(999, proc), false);
  });

  it("le nom du programme ne trompe pas la lecture de l'état", (t) => {
    const proc = faussePro(t, { "130": "130 (faux) Z (x) S 7 7 1 0\n", "131": "131 (a) R (b) Z 7 7 1 0\n" });
    assert.equal(salle.vivant(130, proc), true, "l'état suit la dernière parenthèse fermante");
    assert.equal(salle.vivant(131, proc), false);
  });

  it("un identifiant de processus douteux ne lit rien", (t) => {
    const proc = faussePro(t, { "1": "1 (init) S 0 0 0 0\n" });
    for (const douteux of ["0", "-1", "../1", "1/../1", "abc", "", "12345678901"]) assert.equal(salle.vivant(douteux, proc), false, douteux);
  });

  it("supervisor.sh signale opencode EN TANT QUE node, et n'attend jamais sans borne", () => {
    const lignes = fs
      .readFileSync(path.join(DOCKER_OMO, "supervisor.sh"), "utf8")
      .split("\n")
      .map((ligne) => ligne.trim())
      .filter((ligne) => ligne !== "" && !ligne.startsWith("#"));
    const kills = lignes.filter((ligne) => /\bkill\b/.test(ligne));
    assert.ok(kills.length >= 1, "au moins un signal envoyé");
    // Root n'a pas CAP_KILL : un « kill » direct échouerait en EPERM et la boucle croirait opencode mort (T-L17-a l'a montré).
    for (const ligne of kills) assert.match(ligne, /^\$SETPRIV sh -c 'kill -s /, ligne);
    // « wait » bloquerait pour toujours sur un opencode qui ignore TERM si le KILL n'a pas pu partir.
    assert.equal(lignes.some((ligne) => /\bwait\b/.test(ligne)), false);
  });

  it("supervisor.sh passe à node sans groupe ni capacité héritable, avec le HOME de node", () => {
    const lignes = fs
      .readFileSync(path.join(DOCKER_OMO, "supervisor.sh"), "utf8")
      .split("\n")
      .map((ligne) => ligne.trim());
    // D-2b-27 : exactement ces options. « --bounding-set -all » est absent exprès (sans CAP_SETPCAP, il ne change rien).
    assert.ok(lignes.includes('SETPRIV="setpriv --reuid node --regid node --clear-groups --inh-caps -all"'));
    // setpriv garde l'environnement : sans HOME=/home/node, opencode chercherait sa configuration dans /root.
    assert.ok(lignes.includes("HOME=/home/node"));
    assert.ok(lignes.some((ligne) => /^export .*\bHOME\b/.test(ligne)));
  });

  it("supervisor.sh suit l'ordre de la fiche, bascule vérifiée avant tout travail de node, montages figés avant opencode", () => {
    const lignes = fs
      .readFileSync(path.join(DOCKER_OMO, "supervisor.sh"), "utf8")
      .split("\n")
      .map((ligne) => ligne.trim())
      .filter((ligne) => ligne !== "" && !ligne.startsWith("#"));
    const position = (motif: RegExp) => {
      const i = lignes.findIndex((ligne) => motif.test(ligne));
      assert.ok(i >= 0, `étape absente : ${motif}`);
      return i;
    };
    const ordre = [
      /node "\$LIB" manifeste /,
      /node "\$VALIDATE"$/,
      /node "\$LIB" config-root$/,
      /node "\$LIB" volumes-root$/,
      // MO-7 : le processus bascule vers node PUIS juge lui-même ses capacités, avec exactement les options d'opencode.
      /^executer \$SETPRIV node "\$LIB" capacites$/,
      /^executer \$SETPRIV node "\$LIB" config-node /,
      /^executer \$SETPRIV node "\$LIB" preparation /,
      /node "\$LIB" publier attente/,
      /node "\$LIB" pret$/,
      /node "\$LIB" figer-montages /,
      /^\$SETPRIV opencode serve /,
      /node "\$LIB" verifier /,
    ].map(position);
    assert.deepEqual(
      [...ordre].sort((x, y) => x - y),
      ordre,
      "étapes dans le désordre",
    );
    // Chaque contrôle de l'étape 3 refuse : la ligne qui suit exige un code nul.
    for (const motif of [/node "\$LIB" volumes-root$/, /^executer \$SETPRIV node "\$LIB" capacites$/]) {
      assert.match(lignes[position(motif) + 1] ?? "", /^\[ "\$CODE" -eq 0 \] \|\| refus /);
    }
  });
});

// --- Bascule vers node (MO-7) et boucle de l'homme mort ---------------------------------------------------------------------------

describe("superviseur : bascule vers node vérifiée (MO-7)", () => {
  /** /proc/self/status d'un processus basculé par setpriv dans le conteneur du contrat (relevé de L17a, T-L17-a). */
  const statutNode = [
    "Name:\tnode",
    "Umask:\t0022",
    "State:\tR (running)",
    "Uid:\t1000\t1000\t1000\t1000",
    "Gid:\t1000\t1000\t1000\t1000",
    "Groups:\t",
    "CapInh:\t0000000000000000",
    "CapPrm:\t0000000000000000",
    "CapEff:\t0000000000000000",
    "CapBnd:\t00000000000000c0",
    "CapAmb:\t0000000000000000",
    "NoNewPrivs:\t1",
    "",
  ].join("\n");
  const avec = (champ: string, valeur: string) => statutNode.replace(new RegExp(`^${champ}:.*$`, "m"), `${champ}:\t${valeur}`);

  it("node sans capacité ni groupe, no-new-privileges : accepté (CapBnd à SETUID+SETGID reste la limite dite)", () => {
    assert.equal(salle.capacitesNulles(statutNode), true);
  });

  it("toute capacité effective, permise, héritable ou ambiante refuse", () => {
    for (const champ of ["CapInh", "CapPrm", "CapEff", "CapAmb"]) {
      assert.equal(salle.capacitesNulles(avec(champ, "0000000000000080")), false, champ);
    }
  });

  it("root, une identité mêlée, un groupe en plus ou sans no-new-privileges : refusé", () => {
    assert.equal(salle.capacitesNulles(avec("Uid", "0\t0\t0\t0")), false);
    assert.equal(salle.capacitesNulles(avec("Uid", "1000\t0\t1000\t1000")), false, "setresuid à moitié fait");
    assert.equal(salle.capacitesNulles(avec("Uid", "1000\t1001\t1000\t1000")), false, "identités réelle et effective différentes");
    assert.equal(salle.capacitesNulles(avec("Gid", "0\t0\t0\t0")), false);
    assert.equal(salle.capacitesNulles(avec("Groups", "0")), false, "--clear-groups oublié");
    assert.equal(salle.capacitesNulles(avec("NoNewPrivs", "0")), false, "sans no-new-privileges, un binaire setuid rendrait root");
  });

  it("un statut absent, vide ou tronqué refuse (fermé en cas de doute)", () => {
    assert.equal(salle.capacitesNulles(null), false);
    assert.equal(salle.capacitesNulles(""), false);
    assert.equal(salle.capacitesNulles(statutNode.replace(/^CapAmb:.*\n/m, "")), false);
    assert.equal(salle.capacitesNulles(statutNode.replace(/^Groups:.*\n/m, "")), false);
  });
});

describe("superviseur : un tour de la boucle de l'homme mort", () => {
  const maintenant = 1757000100000;
  const frais = { at: maintenant - 1000 };
  const base = { battement: frais, arret: null, maintenantMs: maintenant, empreinte: "e1", empreinteAttendue: "e1", enfantVivant: true };

  it("tout va bien : on continue", () => {
    assert.equal(salle.decisionBoucle(base), salle.CODES.ok);
  });

  it("stop-request, puis battement périmé, puis montage déplacé, puis opencode arrêté", () => {
    assert.equal(salle.decisionBoucle({ ...base, arret: { at: maintenant, cause: "vous" }, empreinte: "autre", enfantVivant: false }), salle.CODES.arret);
    assert.equal(salle.decisionBoucle({ ...base, battement: { at: maintenant - 21_000 }, empreinte: "autre" }), salle.CODES.perime);
    assert.equal(salle.decisionBoucle({ ...base, empreinte: "autre", enfantVivant: false }), salle.CODES.montage);
    assert.equal(salle.decisionBoucle({ ...base, enfantVivant: false }), salle.CODES.fini);
  });

  it("une empreinte jamais figée arrête aussi (MO-3, fermé en cas de doute)", () => {
    assert.equal(salle.decisionBoucle({ ...base, empreinte: "", empreinteAttendue: "" }), salle.CODES.montage);
    assert.equal(salle.CODES.montage, 13);
  });
});

// --- Manifeste (D-2b-32) ----------------------------------------------------------------------------------------------------------

describe("superviseur : manifeste comparé à la référence de l'image", () => {
  const manifeste = ["aaaa  /opt/omo/index.js", "bbbb  /opt/omo-check/validate.mjs"].join("\n");

  it("identique : « ok »", () => {
    const verdict = salle.comparerManifeste(`${manifeste}\n`, `${manifeste}\n`);
    assert.equal(verdict.manifesteReference, "ok");
    assert.match(verdict.manifestSha256, /^[0-9a-f]{64}$/);
  });

  it("commentaires et blancs de fin ne comptent pas", () => {
    assert.equal(salle.comparerManifeste(`${manifeste}  \n\n`, `# calculé le 17\n${manifeste}\n`).manifesteReference, "ok");
  });

  it("une ligne changée, ajoutée ou retirée : « ecart »", () => {
    assert.equal(salle.comparerManifeste(`${manifeste}\n`, "aaaa  /opt/omo/index.js\ncccc  /opt/omo-check/validate.mjs\n").manifesteReference, "ecart");
    assert.equal(salle.comparerManifeste(`${manifeste}\nzzzz  /opt/omo/ajout.js\n`, `${manifeste}\n`).manifesteReference, "ecart");
    assert.equal(salle.comparerManifeste("aaaa  /opt/omo/index.js\n", `${manifeste}\n`).manifesteReference, "ecart");
  });

  it("l'amorce commitée par L15a refuse le démarrage", () => {
    assert.equal(salle.estAmorce("# amorce\n"), true);
    assert.equal(salle.estAmorce("#amorce : remplacé par build-omo-image.ps1 -AcceptManifest\n"), true);
    assert.equal(salle.comparerManifeste(`${manifeste}\n`, "# amorce\n").manifesteReference, "amorce");
    // Une amorce n'est pas un manifeste vide : un vrai manifeste ne devient jamais « amorce » par accident.
    assert.equal(salle.estAmorce(`# amorce\n${manifeste}\n`), false);
  });

  it("référence absente, vide ou manifeste vide : « ecart » (jamais « ok » par défaut)", () => {
    assert.equal(salle.comparerManifeste(`${manifeste}\n`, null).manifesteReference, "ecart");
    assert.equal(salle.comparerManifeste(`${manifeste}\n`, "\n\n").manifesteReference, "ecart");
    assert.equal(salle.comparerManifeste("", `${manifeste}\n`).manifesteReference, "ecart");
    assert.equal(salle.comparerManifeste(null, null).manifesteReference, "ecart");
  });
});

// --- Dossiers de configuration du HOME (D-2b-33) -----------------------------------------------------------------------------------

describe("superviseur : cinq dossiers de configuration du HOME", () => {
  it("le contrat en cite cinq, dont ceux des fiches et des compétences (D-2b-34)", () => {
    assert.equal(salle.DOSSIERS_CONFIG_HOME.length, 5);
    for (const attendu of ["/home/node/.config/opencode", "/home/node/.opencode", "/home/node/.omo", "/home/node/.claude", "/home/node/.agents"]) {
      assert.ok(salle.DOSSIERS_CONFIG_HOME.includes(attendu), attendu);
    }
  });

  it("un dossier absent ou remplacé par un fichier est refusé", (t) => {
    const dir = dossierTemporaire();
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    assert.deepEqual(salle.controlerDossierConfigRoot(path.join(dir, "absent")), { chemin: path.join(dir, "absent"), ok: false, raison: "absent" });
    fs.writeFileSync(path.join(dir, "fichier"), "");
    assert.equal(salle.controlerDossierConfigRoot(path.join(dir, "fichier")).ok, false);
    fs.mkdirSync(path.join(dir, "vrai"));
    // Le propriétaire n'est vérifiable que là où les uid existent : le conteneur s'en charge (T-L17-f).
    const monte = [path.join(dir, "vrai").replaceAll("\\", "/")];
    if (process.platform !== "win32") assert.equal(salle.controlerDossierConfigRoot(path.join(dir, "vrai"), monte).ok, process.getuid?.() === 0);
  });

  it("vu par node, un dossier inscriptible est refusé", () => {
    const inscriptible = (chemin: string) => chemin.endsWith(".omo");
    assert.equal(salle.controlerDossierConfigNode("/home/node/.omo", inscriptible).ok, false);
    assert.equal(salle.controlerDossierConfigNode("/home/node/.omo", inscriptible).raison, "inscriptible");
    assert.equal(salle.controlerDossierConfigNode("/home/node/.claude", inscriptible).ok, true);
  });

  it("un dossier qui n'est plus un point de montage est refusé (MO-3 : parent renommé, dossier neuf à sa place)", (t) => {
    const dir = dossierTemporaire();
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const vrai = path.join(dir, "vrai");
    fs.mkdirSync(vrai);
    // Le propriétaire réel du dossier de test (0 sous Windows, l'utilisateur ailleurs) : seul le point de montage change ici.
    const uid = fs.lstatSync(vrai).uid;
    assert.deepEqual(salle.controlerDossierRoot(vrai, uid, []), { chemin: vrai, ok: false, raison: "pas-un-montage" });
    assert.deepEqual(salle.controlerDossierRoot(vrai, uid, [`${vrai.replaceAll("\\", "/")}/sous-dossier`, dir.replaceAll("\\", "/")]).raison, "pas-un-montage");
    assert.deepEqual(salle.controlerDossierRoot(vrai, uid, [vrai.replaceAll("\\", "/")]), { chemin: vrai, ok: true, raison: null });
    assert.equal(salle.controlerDossierRoot(vrai, uid + 1, [vrai.replaceAll("\\", "/")]).raison, "proprietaire");
    // Le contrôle des dossiers de configuration passe par la même règle, propriétaire root exigé.
    assert.equal(salle.controlerDossierConfigRoot(vrai, [vrai.replaceAll("\\", "/")]).ok, uid === 0);
  });
});

// --- Volumes de la salle (MO-11, M32, G9) -------------------------------------------------------------------------------------------

describe("superviseur : volumes de la salle", () => {
  it("chaque volume monté dans la salle a le propriétaire du contrat (plan §4.1.4)", () => {
    assert.deepEqual(salle.VOLUMES_SALLE, [
      { volume: "control-omo", chemin: "/control", uid: 1000 },
      { volume: "omo-auth", chemin: "/auth-src", uid: 1000 },
      { volume: "omo-state", chemin: "/omo-state", uid: 0 },
      { volume: "oc-omo-data", chemin: "/home/node/.local/share/opencode", uid: 1000 },
    ]);
    assert.equal(salle.UID_NODE, 1000);
    // Le battement, l'authentification et l'état publié : jamais inscriptibles par node (G9, M32).
    assert.deepEqual(salle.VOLUMES_FERMES_A_NODE, ["/control", "/auth-src", "/omo-state"]);
  });

  it("propriétaire, point de montage et présence sont vérifiés, jamais déduits (MO-11)", (t) => {
    const dir = dossierTemporaire();
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const a = path.join(dir, "a");
    fs.mkdirSync(a);
    const uid = fs.lstatSync(a).uid;
    const montages = [a.replaceAll("\\", "/")];
    const juger = (volumes: { volume: string; chemin: string; uid: number }[], m: string[]) =>
      salle.controlerVolumesRoot(m, volumes).map((v) => `${v.volume}:${v.raison ?? "ok"}`);
    assert.deepEqual(juger([{ volume: "a", chemin: a, uid }], montages), ["a:ok"]);
    assert.deepEqual(juger([{ volume: "a", chemin: a, uid: uid + 1 }], montages), ["a:proprietaire"]);
    assert.deepEqual(juger([{ volume: "a", chemin: a, uid }], []), ["a:pas-un-montage"]);
    assert.deepEqual(juger([{ volume: "b", chemin: path.join(dir, "b"), uid }], montages), ["b:absent"]);
  });

  it("vu par node, un volume fermé mais inscriptible fait échouer l'étape, comme un dossier de configuration", () => {
    assert.equal(salle.etapeConfigNode(() => false).ok, true);
    const battementOuvert = salle.etapeConfigNode((chemin) => chemin === "/control");
    assert.equal(battementOuvert.ok, false);
    assert.deepEqual(
      battementOuvert.volumes.filter((v) => !v.ok).map((v) => v.chemin),
      ["/control"],
    );
    assert.equal(battementOuvert.dossiers.every((d) => d.ok), true);
    assert.equal(salle.etapeConfigNode((chemin) => chemin === "/omo-state").ok, false);
    assert.equal(salle.etapeConfigNode((chemin) => chemin === "/home/node/.agents").ok, false);
  });

  it("root n'accepte le constat de node que si chaque volume fermé y est dit non inscriptible", (t) => {
    const dir = dossierTemporaire();
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    salle.initTravail(dir, 1757000000000);
    salle.majTravail(dir, { dossiersConfig: salle.DOSSIERS_CONFIG_HOME.map((chemin) => ({ chemin, ok: true })) });
    const fichier = path.join(dir, "constat.json");
    const essayer = (constat: unknown) => {
      fs.writeFileSync(fichier, JSON.stringify(constat));
      return salle.absorber(dir, fichier).ok;
    };
    const propre = salle.etapeConfigNode(() => false);
    assert.equal(essayer(propre), true);
    assert.equal(essayer(salle.etapeConfigNode((chemin) => chemin === "/auth-src")), false);
    // Un volume absent du constat vaut « inscriptible » : seul un « non » explicite de node compte.
    assert.equal(essayer({ ...propre, volumes: propre.volumes.filter((v) => v.chemin !== "/omo-state") }), false);
    assert.equal(essayer({ ...propre, volumes: undefined }), false);
  });
});

// --- Balayage git (D-2b-28) ---------------------------------------------------------------------------------------------------------

describe("superviseur : balayage git du dossier de travail", () => {
  /** Dossier de travail de test : un projet protégé, un projet ouvert, un `.git` fichier, un `.git` sous node_modules. */
  function workspace(t: { after: (fn: () => void) => void }): string {
    const dir = dossierTemporaire();
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    fs.mkdirSync(path.join(dir, "protege", ".git"), { recursive: true });
    fs.mkdirSync(path.join(dir, "ouvert", ".git", "hooks"), { recursive: true });
    fs.mkdirSync(path.join(dir, "sous-module"), { recursive: true });
    fs.writeFileSync(path.join(dir, "sous-module", ".git"), "gitdir: ../protege/.git/modules/sous-module\n");
    fs.mkdirSync(path.join(dir, "appli", "node_modules", "paquet", ".git"), { recursive: true });
    fs.mkdirSync(path.join(dir, "sans-depot", "src"), { recursive: true });
    return dir;
  }

  const inscriptibleSi = (motif: string) => (chemin: string) => chemin.replace(/\\/g, "/").includes(motif);

  /** Points de montage, au format de /proc/self/mountinfo (chemins POSIX), pour des chemins relatifs au dossier de travail. */
  const montagesDe = (dir: string, ...relatifs: string[]) => relatifs.map((relatif) => `${dir.replaceAll("\\", "/")}/${relatif}`);

  /** Les trois `.git` du dossier de travail de test, tous montés en lecture seule comme le fait la surcharge. */
  const tousMontes = (dir: string) => montagesDe(dir, "protege/.git", "ouvert/.git", "sous-module/.git");

  /** Ajoute un projet dont le `.git` est un lien vers un autre dépôt. Faux si le système refuse les liens (droits Windows). */
  function ajouterLien(dir: string, nom: string): boolean {
    fs.mkdirSync(path.join(dir, nom), { recursive: true });
    return lienDossier(path.join(dir, "protege", ".git"), path.join(dir, nom, ".git"));
  }

  it("classe chaque .git par sa forme, sans suivre les liens", (t) => {
    const dir = workspace(t);
    const avecLien = ajouterLien(dir, "lien-vers-depot");
    // Un raccourci vers un projet ouvert : le suivre ferait compter deux fois le même dépôt, et sortir du dossier de travail.
    const avecRaccourci = lienDossier(path.join(dir, "ouvert"), path.join(dir, "raccourci"));
    const balayage = salle.balayerGit(dir, { accesEcriture: inscriptibleSi("/ouvert/"), maintenant: 1757000000000 });
    const formes = new Map(balayage.gits.map((git) => [git.chemin.replace(/\\/g, "/"), git.forme]));
    assert.equal(formes.get("protege/.git"), "dossier");
    assert.equal(formes.get("ouvert/.git"), "dossier");
    assert.equal(formes.get("sous-module/.git"), "fichier");
    if (avecLien) assert.equal(formes.get("lien-vers-depot/.git"), "lien");
    else assert.equal(formes.has("lien-vers-depot/.git"), false, "lien non créable sur ce système : forme « lien » non jouée");
    if (avecRaccourci) assert.equal(formes.has("raccourci/.git"), false, "un lien de dossier a été suivi");
    assert.equal(balayage.verifieLe, 1757000000000);
  });

  it("node_modules n'est pas parcouru", (t) => {
    const dir = workspace(t);
    const balayage = salle.balayerGit(dir, { accesEcriture: () => false });
    assert.equal(
      balayage.gits.some((git) => git.chemin.includes("node_modules")),
      false,
    );
    // Sans l'exclusion, un seul dépôt d'une dépendance ferait passer tout le dossier de travail pour non protégé.
    const sansExclusion = salle.balayerGit(dir, { accesEcriture: () => true, exclus: [] });
    assert.equal(
      sansExclusion.gits.some((git) => git.chemin.includes("node_modules")),
      true,
    );
  });

  it("l'intérieur d'un .git n'est pas parcouru", (t) => {
    const dir = workspace(t);
    fs.mkdirSync(path.join(dir, "ouvert", ".git", "modules", "interne", ".git"), { recursive: true });
    const balayage = salle.balayerGit(dir, { accesEcriture: () => false });
    assert.equal(
      balayage.gits.some((git) => git.chemin.includes("modules")),
      false,
    );
  });

  it("un .git inscriptible par node est listé dans nonProteges ; un .git lien aussi", (t) => {
    const dir = workspace(t);
    const balayage = salle.balayerGit(dir, { accesEcriture: inscriptibleSi("/ouvert/"), montages: tousMontes(dir) });
    const nonProteges = balayage.nonProteges.map((chemin) => chemin.replace(/\\/g, "/"));
    assert.deepEqual(nonProteges, ["ouvert/.git"]);
    assert.equal(balayage.limiteAtteinte, false);

    if (ajouterLien(dir, "lien")) {
      // Même « monté » dans la table, un lien n'est jamais protégé : il n'est pas suivi.
      const apres = salle.balayerGit(dir, { accesEcriture: () => false, montages: [...tousMontes(dir), ...montagesDe(dir, "lien/.git")] });
      assert.deepEqual(
        apres.nonProteges.map((chemin) => chemin.replace(/\\/g, "/")),
        ["lien/.git"],
      );
    }
  });

  it("un .git non inscriptible mais hors montage n'est pas protégé (MO-3 : un parent renommé le remplace)", (t) => {
    const dir = workspace(t);
    // Personne n'écrit dans « ouvert/.git » aujourd'hui, mais aucun bind ne le tient : renommer « ouvert » suffit à en poser un neuf.
    const balayage = salle.balayerGit(dir, { accesEcriture: () => false, montages: montagesDe(dir, "protege/.git", "sous-module/.git") });
    assert.deepEqual(
      balayage.nonProteges.map((chemin) => chemin.replace(/\\/g, "/")),
      ["ouvert/.git"],
    );
    const ouvert = balayage.gits.find((git) => git.chemin.replace(/\\/g, "/") === "ouvert/.git");
    assert.deepEqual(ouvert && { inscriptible: ouvert.inscriptible, montage: ouvert.montage }, { inscriptible: false, montage: false });
    // Un préfixe ne compte pas : « /x/protege » monté ne fait pas de « /x/protege/.git » un point de montage.
    const prefixe = salle.balayerGit(dir, { accesEcriture: () => false, montages: montagesDe(dir, "protege", "ouvert", "sous-module") });
    assert.equal(prefixe.nonProteges.length, 3);
  });

  it("rien d'inscriptible et tout monté : nonProteges vide", (t) => {
    const dir = workspace(t);
    const balayage = salle.balayerGit(dir, { accesEcriture: () => false, montages: tousMontes(dir) });
    assert.deepEqual(balayage.nonProteges, []);
    assert.equal(balayage.limiteAtteinte, false);
  });

  it("le plafond d'entrées atteint vaut « limite atteinte », pas « tout va bien »", (t) => {
    const dir = workspace(t);
    const balayage = salle.balayerGit(dir, { accesEcriture: () => false, plafond: 3 });
    assert.equal(balayage.limiteAtteinte, true);
    assert.ok(balayage.entrees <= 4, `${balayage.entrees} entrées`);
    assert.equal(salle.BALAYAGE_PLAFOND, 200_000);
  });

  it("une profondeur déraisonnable vaut « limite atteinte »", (t) => {
    const dir = workspace(t);
    const balayage = salle.balayerGit(dir, { accesEcriture: () => false, profondeurMax: 0 });
    assert.equal(balayage.limiteAtteinte, true);
    assert.equal(salle.BALAYAGE_PROFONDEUR_MAX, 256);
  });

  it("un dossier illisible est compté, jamais pris pour un dossier vide", (t) => {
    const dir = workspace(t);
    const balayage = salle.balayerGit(path.join(dir, "absent"), { accesEcriture: () => false });
    assert.equal(balayage.illisibles, 1);
    assert.equal(balayage.gits.length, 0);
  });

  it("le résumé publié ne porte que les trois champs du contrat", (t) => {
    const dir = workspace(t);
    const resume = salle.resumeWorkspaceGit(salle.balayerGit(dir, { accesEcriture: () => false, maintenant: 7 }));
    assert.deepEqual(Object.keys(resume).sort(), ["limiteAtteinte", "nonProteges", "verifieLe"]);
    assert.equal(resume.verifieLe, 7);
  });

  it("le dossier de travail n'est « protégé » que si tout l'est, et jamais par défaut", () => {
    const propre = { workspaceGit: { verifieLe: 1, limiteAtteinte: false, nonProteges: [] }, projets: [{ gitLectureSeule: true }] };
    assert.equal(salle.gitProtege(propre), true);
    assert.equal(salle.gitProtege({ ...propre, workspaceGit: { ...propre.workspaceGit, limiteAtteinte: true } }), false);
    assert.equal(salle.gitProtege({ ...propre, workspaceGit: { ...propre.workspaceGit, nonProteges: ["gamma/.git"] } }), false);
    assert.equal(salle.gitProtege({ ...propre, projets: [{ gitLectureSeule: true }, { gitLectureSeule: false }] }), false);
    assert.equal(salle.gitProtege({ projets: [] }), false);
    assert.equal(salle.gitProtege(null), false);
  });

  it("l'état des projets préparés suit ce que node peut écrire", (t) => {
    const dir = workspace(t);
    const prepares = salle.analyserProjetsPrepares(
      JSON.stringify({
        version: 1,
        genereLe: "2026-09-17T10:00:00Z",
        projets: [
          { chemin: "protege", git: "dossier" },
          { chemin: "ouvert", git: "dossier" },
          { chemin: "sans-depot", git: "absent" },
        ],
        gitProteges: [{ chemin: "protege", forme: "dossier" }],
      }),
    );
    const etat = salle.controlerProjetsPrepares(prepares, dir, inscriptibleSi("/ouvert/"), tousMontes(dir));
    assert.deepEqual(etat, [
      { chemin: "protege", gitLectureSeule: true },
      { chemin: "ouvert", gitLectureSeule: false },
      { chemin: "sans-depot", gitLectureSeule: true },
    ]);
    // MO-3 : non inscriptible aujourd'hui, mais plus un point de montage (parent renommé, surcharge oubliée) : pas en lecture seule.
    const horsMontage = salle.controlerProjetsPrepares(prepares, dir, () => false, montagesDe(dir, "ouvert/.git"));
    assert.deepEqual(horsMontage[0], { chemin: "protege", gitLectureSeule: false });
    assert.deepEqual(salle.controlerProjetsPrepares(null, dir), []);
  });
});

// --- Purge et auth.json -------------------------------------------------------------------------------------------------------------

describe("superviseur : purge du démarrage (D-2b-36)", () => {
  it("le dossier de données garde opencode.db, -shm et -wal, et rien d'autre (MO-2)", (t) => {
    const dir = dossierTemporaire();
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    for (const nom of ["opencode.db", "opencode.db-wal", "opencode.db-shm"]) fs.writeFileSync(path.join(dir, nom), "x");
    // Inventaire réel d'opencode 1.18.30 (MO-2), plus « storage/ » d'avant 1.18 et deux voisins de nom.
    fs.mkdirSync(path.join(dir, "storage", "session"), { recursive: true });
    fs.mkdirSync(path.join(dir, "snapshot", "abcd"), { recursive: true });
    fs.mkdirSync(path.join(dir, "tool-output"), { recursive: true });
    fs.writeFileSync(path.join(dir, "tool-output", "tool_1"), "x");
    fs.mkdirSync(path.join(dir, "log"), { recursive: true });
    fs.mkdirSync(path.join(dir, "repos"), { recursive: true });
    fs.mkdirSync(path.join(dir, "bin"), { recursive: true });
    for (const nom of ["auth.json", "opencode.db-journal", "opencode.dbx", "copie-opencode.db"]) fs.writeFileSync(path.join(dir, nom), "x");
    const rapport = salle.viderDossier(dir, { gardes: salle.PURGE_GARDES });
    assert.deepEqual(fs.readdirSync(dir).sort(), ["opencode.db", "opencode.db-shm", "opencode.db-wal"]);
    assert.equal(rapport.retires, 10);
    // Les anciens noms ne sont gardés sous aucune forme, même en fichier : « storage » n'est plus une persistance d'opencode.
    for (const nom of ["storage", "snapshot", "bin", "repos"]) fs.writeFileSync(path.join(dir, nom), "x");
    salle.viderDossier(dir, { gardes: salle.PURGE_GARDES });
    assert.deepEqual(fs.readdirSync(dir).sort(), ["opencode.db", "opencode.db-shm", "opencode.db-wal"]);
    // Sans la liste de gardes, la base des conversations partirait avec les instantanés.
    salle.viderDossier(dir, { gardes: [] });
    assert.deepEqual(fs.readdirSync(dir), []);
  });

  it("un nom gardé ne garde qu'un fichier : un dossier ou un lien du même nom part", (t) => {
    const dir = dossierTemporaire();
    const ailleurs = dossierTemporaire();
    t.after(() => {
      fs.rmSync(dir, { recursive: true, force: true });
      fs.rmSync(ailleurs, { recursive: true, force: true });
    });
    // Sans cette règle, node rangerait ce qu'il veut dans « opencode.db/ » et le retrouverait à chaque relance.
    fs.mkdirSync(path.join(dir, "opencode.db", "cache"), { recursive: true });
    fs.writeFileSync(path.join(dir, "opencode.db", "cache", "a"), "x");
    fs.writeFileSync(path.join(ailleurs, "temoin"), "x");
    const avecLien = lienDossier(ailleurs, path.join(dir, "opencode.db-wal"));
    salle.viderDossier(dir, { gardes: salle.PURGE_GARDES });
    assert.deepEqual(fs.readdirSync(dir), []);
    // Le lien est retiré, jamais suivi : ce qu'il vise, hors du dossier purgé, est intact.
    if (avecLien) assert.equal(fs.existsSync(path.join(ailleurs, "temoin")), true);
  });

  it("un point de montage est gardé, jamais « retiré » en silence", (t) => {
    const dir = dossierTemporaire();
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    fs.mkdirSync(path.join(dir, "monte", "dedans"), { recursive: true });
    fs.writeFileSync(path.join(dir, "libre"), "x");
    // /proc/self/mountinfo ne connaît que des chemins POSIX : le test les donne tels quels, comme dans le conteneur.
    const rapport = salle.viderDossier(dir, { montages: [`${dir.replaceAll("\\", "/")}/monte/dedans`] });
    assert.deepEqual(rapport.gardes, ["monte"]);
    assert.deepEqual(fs.readdirSync(dir), ["monte"]);
  });

  it("le rapport de purge reste borné, même si une session a semé des milliers de noms gardés", (t) => {
    const dir = dossierTemporaire();
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    for (let i = 0; i < 25; i++) fs.writeFileSync(path.join(dir, `garde-${i}`), "x");
    const rapport = salle.viderDossier(dir, { gardes: [/^garde-/] });
    assert.equal(rapport.gardes.length, salle.OMO_LISTE_MAX);
    assert.equal(rapport.gardesTotal, 25);
    assert.ok(JSON.stringify(rapport).length < salle.OMO_CONTROL_MAX_OCTETS);
  });

  it("un dossier absent ne fait pas échouer la purge", () => {
    const rapport = salle.viderDossier(path.join(dossierTemporaire(), "jamais"), {});
    assert.equal(rapport.absent, true);
    assert.equal(rapport.retires, 0);
  });

  it("les points de montage sont lus sans suivre les échappements à la lettre", (t) => {
    const dir = dossierTemporaire();
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const fichier = path.join(dir, "mountinfo");
    fs.writeFileSync(
      fichier,
      [
        "24 30 0:22 / /home/node rw,relatime shared:5 - tmpfs tmpfs rw",
        "25 24 0:23 / /home/node/.config/opencode ro,relatime - ext4 /dev/sda1 ro",
        "26 24 0:24 / /workspace/mon\\040projet rw - ext4 /dev/sda1 rw",
        "ligne trop courte",
        "",
      ].join("\n"),
    );
    const points = salle.pointsDeMontage(fichier);
    assert.deepEqual(points, ["/home/node", "/home/node/.config/opencode", "/workspace/mon projet"]);
    assert.equal(salle.porteUnMontage("/home/node", points), true);
    assert.equal(salle.porteUnMontage("/home/node/.config", points), true);
    assert.equal(salle.porteUnMontage("/home/node/rien", points), false);
    assert.deepEqual(salle.pointsDeMontage(path.join(dir, "absent")), []);
  });

  it("un point de montage se reconnaît au chemin exact, jamais par préfixe (MO-3)", () => {
    const points = ["/home/node", "/home/node/.config/opencode", "/workspace/alpha/.git"];
    assert.equal(salle.estPointDeMontage("/home/node/.config/opencode", points), true);
    assert.equal(salle.estPointDeMontage("/home/node/.config", points), false, "un parent n'est pas un montage");
    assert.equal(salle.estPointDeMontage("/workspace/alpha", points), false);
    assert.equal(salle.estPointDeMontage("/workspace/alpha/.git/hooks", points), false, "l'intérieur d'un montage n'en est pas un");
  });

  it("l'empreinte des montages change dès qu'un montage change de chemin, jamais avec l'ordre des lignes", () => {
    const avant = ["/", "/home/node", "/home/node/.config/opencode", "/workspace", "/workspace/alpha/.git"];
    const e = salle.empreinteMontages(avant);
    assert.match(e, /^[0-9a-f]{64}$/);
    assert.equal(salle.empreinteMontages([...avant].reverse()), e);
    // `mv ~/.config ~/.config-deplace` : mountinfo suit l'inode, le chemin change (MO-3, point 7).
    assert.notEqual(salle.empreinteMontages(avant.map((p) => p.replace("/.config/", "/.config-deplace/"))), e);
    assert.notEqual(salle.empreinteMontages(avant.map((p) => p.replace("/alpha/", "/alpha-deplace/"))), e);
    assert.equal(salle.empreinteMontages([]), "");
    assert.equal(salle.empreinteMontages(null), "");
  });
});

describe("superviseur : copie d'auth.json (D-2b-26)", () => {
  it("la copie est posée, et jamais journalisée", (t) => {
    const dir = dossierTemporaire();
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const source = path.join(dir, "auth-src", "auth.json");
    const donnees = path.join(dir, "donnees");
    fs.mkdirSync(path.dirname(source), { recursive: true });
    fs.mkdirSync(donnees, { recursive: true });
    fs.writeFileSync(source, JSON.stringify({ "github-copilot": { type: "oauth", refresh: "valeur-de-test" } }));
    const rapport = salle.copierAuth({ source, donnees });
    assert.equal(rapport.etat, "posee");
    assert.equal(fs.readFileSync(path.join(donnees, "auth.json"), "utf8"), fs.readFileSync(source, "utf8"));
    // Le rapport ne porte que l'état et la taille : rien de ce fichier ne doit se retrouver dans un journal.
    assert.deepEqual(Object.keys(rapport).sort(), ["etat", "octets"]);
    assert.equal(JSON.stringify(rapport).includes("valeur-de-test"), false);
    if (process.platform !== "win32") assert.equal(fs.statSync(path.join(donnees, "auth.json")).mode & 0o777, 0o600);
  });

  it("source absente : la copie d'avant est retirée", (t) => {
    const dir = dossierTemporaire();
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const donnees = path.join(dir, "donnees");
    fs.mkdirSync(donnees, { recursive: true });
    fs.writeFileSync(path.join(donnees, "auth.json"), "{}");
    const rapport = salle.copierAuth({ source: path.join(dir, "absent.json"), donnees });
    assert.equal(rapport.etat, "absente");
    assert.equal(fs.existsSync(path.join(donnees, "auth.json")), false);
  });

  it("source trop grosse : refusée, et la copie d'avant retirée", (t) => {
    const dir = dossierTemporaire();
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const source = path.join(dir, "auth.json");
    const donnees = path.join(dir, "donnees");
    fs.mkdirSync(donnees, { recursive: true });
    fs.writeFileSync(source, "x".repeat(salle.OMO_AUTH_MAX_OCTETS + 1));
    fs.writeFileSync(path.join(donnees, "auth.json"), "{}");
    const rapport = salle.copierAuth({ source, donnees });
    assert.equal(rapport.etat, "trop-grosse");
    assert.equal(fs.existsSync(path.join(donnees, "auth.json")), false);
  });
});

// --- Écriture atomique, dossier de travail et état publié ---------------------------------------------------------------------------

describe("superviseur : état publié", () => {
  it("l'écriture est atomique et ne laisse aucun fichier temporaire", (t) => {
    const dir = dossierTemporaire();
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const cible = path.join(dir, "fichier.json");
    salle.ecrireAtomique(cible, '{"a":1}\n');
    salle.ecrireAtomique(cible, '{"a":2}\n');
    assert.equal(fs.readFileSync(cible, "utf8"), '{"a":2}\n');
    assert.deepEqual(fs.readdirSync(dir), ["fichier.json"]);
  });

  it("l'état publié est celui que le cockpit sait relire", (t) => {
    const dir = dossierTemporaire();
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const travail = salle.initTravail(dir, 1757000000000);
    assert.equal(salle.estStartId(travail.startId), true);
    // Fermé en cas de doute : avant toute vérification, l'état de départ est le plus défavorable.
    assert.equal(travail.manifesteReference, "ecart");
    assert.equal(travail.validation, "echec");
    assert.equal(travail.workspaceGit.limiteAtteinte, true);
    assert.deepEqual(
      travail.dossiersConfig.map((d) => d.ok),
      [false, false, false, false, false],
    );

    salle.majTravail(dir, {
      manifesteReference: "ok",
      manifestSha256: "0".repeat(64),
      validation: "ok",
      dossiersConfig: salle.DOSSIERS_CONFIG_HOME.map((chemin) => ({ chemin, ok: true })),
      projets: [{ chemin: "alpha", gitLectureSeule: true }],
      workspaceGit: { verifieLe: 1757000000000, limiteAtteinte: false, nonProteges: [] },
    });
    const publie = salle.publierEtat(dir, salle.lireTravail(dir), "opencode-lance");
    const relu = analyserEtat(fs.readFileSync(path.join(dir, salle.FICHIER_ETAT), "utf8"));
    assert.deepEqual(relu, publie);
    assert.equal(relu?.phase, "opencode-lance");
    assert.equal(relu?.startId, travail.startId);
    // Le dossier de travail reste caché et n'est pas l'état publié.
    assert.equal(path.basename(salle.cheminTravail(dir)).startsWith("."), true);
  });

  it("une phase inconnue n'est jamais publiée", (t) => {
    const dir = dossierTemporaire();
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const travail = salle.initTravail(dir, 1757000000000);
    assert.throws(() => salle.publierEtat(dir, travail, "repos"), /phase inconnue/);
    assert.deepEqual(salle.PHASES, ["verification", "attente", "opencode-lance", "arret"]);
  });

  it("les délais passés au shell sont des entiers, rien d'autre", () => {
    assert.equal(salle.delaisShell(), "OMO_BATTEMENT_S=5\nOMO_PERIME_S=20\nOMO_VERIFICATION_S=2\nOMO_KILL_APRES_S=3\n");
    // Une valeur hostile ne devient jamais du code : « eval » ne verra que des chiffres.
    const hostile = salle.delaisShell({ battementS: "5; rm -rf /", perimeS: 20, verificationS: 2, killApresS: 3 } as never);
    assert.match(hostile, /^(?:OMO_[A-Z_]+=\d+\n){4}$/);
  });
});

// --- Chemins : le contrat et la bibliothèque disent la même chose ---------------------------------------------------------------------

describe("superviseur : chemins du contrat", () => {
  it("les chemins de l'image sont absolus et sans doublon", () => {
    const chemins = Object.values(salle.CHEMINS);
    for (const chemin of chemins) assert.equal(chemin.startsWith("/"), true, chemin);
    assert.equal(new Set(chemins).size, chemins.length);
    for (const chemin of salle.DOSSIERS_CONFIG_HOME) assert.equal(chemin.startsWith("/home/node"), true, chemin);
  });

  it("le périmètre du manifeste porte la bibliothèque du superviseur elle-même", () => {
    assert.ok(salle.PERIMETRE_MANIFESTE.some((racine) => salle.CHEMINS.superviseurLib.startsWith(`${racine}/`)));
    assert.ok(salle.PERIMETRE_MANIFESTE.includes(salle.CHEMINS.superviseur));
    // La référence du manifeste reste HORS du périmètre haché (D-2b-32), sinon elle se contiendrait elle-même.
    assert.equal(
      salle.PERIMETRE_MANIFESTE.some((racine) => salle.CHEMINS.referenceManifeste.startsWith(`${racine}/`) || salle.CHEMINS.referenceManifeste === racine),
      false,
    );
  });

  it("le superviseur lit ses chemins dans la bibliothèque, pas dans l'environnement", () => {
    const source = fs.readFileSync(path.join(DOCKER_OMO, "supervisor-lib.mjs"), "utf8");
    assert.equal(/process\.env/.test(source), false, "aucun chemin ni délai pris dans l'environnement");
    const script = fs.readFileSync(path.join(DOCKER_OMO, "supervisor.sh"), "utf8");
    // Le script ne fait que la boucle et les signaux : aucune règle métier, aucun JSON lu à la main.
    assert.equal(/\bgrep\b|\bsed\b|\bawk\b|\bjq\b|\bcut\b/.test(script), false, "supervisor.sh ne doit rien analyser lui-même");
  });

  it("supervisor.sh est en ASCII pur et en fins de ligne Unix", () => {
    const brut = fs.readFileSync(path.join(DOCKER_OMO, "supervisor.sh"));
    assert.equal(brut.includes(0x0d), false, "un CR casserait « /bin/sh^M: not found »");
    for (const octet of brut) assert.ok(octet <= 0x7f, `octet hors ASCII : ${octet}`);
    assert.equal(brut.subarray(0, 9).toString("utf8"), "#!/bin/sh");
  });

  it("le faux opencode des tests est en ASCII pur et ne lance rien de réel", () => {
    const brut = fs.readFileSync(path.join(import.meta.dirname, "test-support", "omo-opencode-stub.sh"));
    assert.equal(brut.includes(0x0d), false);
    for (const octet of brut) assert.ok(octet <= 0x7f, `octet hors ASCII : ${octet}`);
    const texte = brut.toString("utf8");
    assert.equal(/\bnpm\b|\bnpx\b|curl|wget/.test(texte), false);
  });
});

// --- Tests conteneur (D-2b-44) ---------------------------------------------------------------------------------------------------

const CONTENEUR_DEMANDE = process.env.OMO_TESTS_CONTENEUR === "1";
const IMAGE_BASE = "omo11-l17a-base:omo11";
const IMAGE_SOURCE = "node:24-bookworm-slim";
const PREFIXE = "omo11-l17a";

interface Sortie {
  code: number;
  stdout: string;
  stderr: string;
}

function docker(args: string[], entree?: string, timeoutMs = 120_000): Sortie {
  const res = spawnSync("docker", args, {
    encoding: "utf8",
    input: entree,
    timeout: timeoutMs,
    // MSYS_NO_PATHCONV : sous Git Bash, les chemins du conteneur seraient réécrits en chemins Windows.
    env: { ...process.env, MSYS_NO_PATHCONV: "1" },
  });
  return { code: res.status ?? -1, stdout: res.stdout ?? "", stderr: res.stderr ?? "" };
}

/** Raison du saut, ou `null` si les tests conteneur peuvent tourner. */
function raisonDuSaut(): string | null {
  if (!CONTENEUR_DEMANDE) return "tests conteneur hors « npm test » : relancer avec OMO_TESTS_CONTENEUR=1 (D-2b-44)";
  if (docker(["version", "--format", "{{.Server.Version}}"], undefined, 20_000).code !== 0) return "Docker n'est pas disponible sur ce poste";
  if (docker(["image", "inspect", IMAGE_BASE], undefined, 20_000).code !== 0) {
    if (docker(["image", "inspect", IMAGE_SOURCE], undefined, 20_000).code !== 0) {
      return `image de base absente : « docker pull ${IMAGE_SOURCE} » puis relancer (aucun téléchargement n'est fait par ce test)`;
    }
    if (docker(["tag", IMAGE_SOURCE, IMAGE_BASE], undefined, 20_000).code !== 0) return "impossible d'étiqueter l'image de base";
  }
  return null;
}

const SAUT = raisonDuSaut();

/** Ressources d'un cas : volumes et conteneurs, tous préfixés, tous retirés à la fin, même en échec. */
class Cas {
  readonly nom: string;
  private readonly volumes: string[] = [];
  private readonly conteneurs: string[] = [];

  constructor(nom: string) {
    this.nom = `${PREFIXE}-${nom}`;
  }

  volume(suffixe: string): string {
    const nom = `${this.nom}-${suffixe}`;
    if (!this.volumes.includes(nom)) {
      docker(["volume", "create", nom]);
      this.volumes.push(nom);
    }
    return nom;
  }

  conteneur(suffixe: string): string {
    const nom = `${this.nom}-${suffixe}`;
    if (!this.conteneurs.includes(nom)) this.conteneurs.push(nom);
    return nom;
  }

  nettoyer(): void {
    for (const nom of this.conteneurs) docker(["rm", "-f", "-v", nom], undefined, 60_000);
    for (const nom of this.volumes) docker(["volume", "rm", "-f", nom], undefined, 60_000);
  }
}

const base64 = (chemin: string): string => fs.readFileSync(chemin).toString("base64");

/** Écrit un fichier dans le conteneur de préparation sans passer par un bind de l'hôte (droits et propriétaires réels). */
const poser = (destination: string, contenu: string, mode: string): string =>
  [`mkdir -p "$(dirname ${destination})"`, `printf %s '${Buffer.from(contenu, "utf8").toString("base64")}' | base64 -d > ${destination}`, `chmod ${mode} ${destination}`].join("\n");

const poserFichier = (destination: string, chemin: string, mode: string): string =>
  [`mkdir -p "$(dirname ${destination})"`, `printf %s '${base64(chemin)}' | base64 -d > ${destination}`, `chmod ${mode} ${destination}`].join("\n");

interface OptionsCas {
  /** Contenu de la référence du manifeste ; par défaut, celui que calcule le faux `manifest.sh`. */
  reference?: string;
  /** Code de sortie du faux validateur (G14). */
  codeValidation?: number;
  /** Dossiers de configuration à ne pas créer, ou à donner à `node` (T-L17-f). */
  configAbsente?: readonly string[];
  configANode?: readonly string[];
  /** `.git` inscriptible par `node` dans ce projet (T-L17-d). */
  projetOuvert?: boolean;
  /** `.git` à root, non inscriptible par `node`, mais monté par personne (T-L17-d, MO-3). */
  gitHorsMontage?: boolean;
  /** Volume d'authentification laissé à root (MO-11) : lisible, mais pas au propriétaire du contrat. */
  authARoot?: boolean;
  /** Volume d'état donné à `node` et ouvert en écriture (M32, MO-11). */
  etatOuvertANode?: boolean;
  /** Salle lancée sans `no-new-privileges` (MO-7) : la bascule vers node doit être refusée. */
  sansNoNewPrivs?: boolean;
  /** Faux opencode qui ignore TERM : la boucle doit aller jusqu'au KILL. */
  tetu?: boolean;
}

const MANIFESTE_FAUX = "aaaa  /opt/omo/index.js\nbbbb  /opt/omo-check/supervisor-lib.mjs\n";

/** Prépare tous les volumes d'un cas en UN conteneur (root) : scripts, référence, authentification, dossiers, dossier de travail. */
function preparer(cas: Cas, options: OptionsCas): void {
  const reference = options.reference ?? MANIFESTE_FAUX;
  const script = [
    "set -eu",
    poserFichier("/vol-image/supervisor.sh", path.join(DOCKER_OMO, "supervisor.sh"), "755"),
    poserFichier("/vol-image/supervisor-lib.mjs", path.join(DOCKER_OMO, "supervisor-lib.mjs"), "644"),
    // Faux calcul de manifeste et faux validateur : L15a fournit les vrais, ce test ne juge que le superviseur.
    poser("/vol-image/manifest.sh", `#!/bin/sh\nprintf %s '${Buffer.from(MANIFESTE_FAUX, "utf8").toString("base64")}' | base64 -d\n`, "755"),
    poser("/vol-image/validate.mjs", `process.exit(${options.codeValidation ?? 0});\n`, "644"),
    poser("/vol-ref/omo-manifest.sha256", reference, "644"),
    poserFichier("/vol-sbin/opencode", path.join(import.meta.dirname, "test-support", "omo-opencode-stub.sh"), "755"),
    // auth.json du cockpit : 0600, uid 1000 ; seul `node` peut le lire, et le superviseur ne le lit qu'après setpriv. Le volume
    // lui-même appartient à node, comme le veut le contrat (MO-11), sauf dans le cas qui vérifie ce contrôle.
    poser("/vol-auth/auth.json", JSON.stringify({ "github-copilot": { type: "oauth", refresh: "faux-jeton-de-test" } }), "600"),
    "chown 1000:1000 /vol-auth/auth.json",
    options.authARoot ? "chmod 755 /vol-auth" : "chown 1000:1000 /vol-auth",
    // Volume d'état : root (tel que Docker le crée), ou donné à node et ouvert à tous pour le cas M32.
    options.etatOuvertANode ? "chown 1000:1000 /vol-state && chmod 777 /vol-state" : "chown 0:0 /vol-state",
    // Dossier de données : l'inventaire réel d'opencode 1.18.30 (MO-2), plus « storage/ » et « bin/ » qu'aucune version récente ne
    // crée. Seuls opencode.db, -shm et -wal doivent rester (D-2b-36 corrigée par MO-2).
    "mkdir -p /vol-data/storage/session /vol-data/snapshot/abcd /vol-data/bin /vol-data/tool-output /vol-data/log /vol-data/repos",
    "printf 'base' > /vol-data/opencode.db",
    "printf 'wal' > /vol-data/opencode.db-wal",
    "printf 'shm' > /vol-data/opencode.db-shm",
    "printf 'x' > /vol-data/storage/session/garde.json",
    "printf 'x' > /vol-data/snapshot/abcd/a-retirer",
    "printf 'x' > /vol-data/tool-output/tool_1",
    "printf 'x' > /vol-data/log/opencode.log",
    "chown -R 1000:1000 /vol-data",
    // Dossier de travail : alpha protégé par un volume :ro monté sur son .git, beta sans dépôt, gamma ouvert au besoin.
    "mkdir -p /vol-ws/alpha /vol-ws/beta/src",
    "printf 'x' > /vol-ws/alpha/fichier.txt",
    "mkdir -p /vol-git-alpha/hooks",
    "printf 'ref: refs/heads/principale\\n' > /vol-git-alpha/HEAD",
    options.projetOuvert ? "mkdir -p /vol-ws/gamma/.git/hooks && printf 'ref: x\\n' > /vol-ws/gamma/.git/HEAD" : "mkdir -p /vol-ws/gamma",
    "chown -R 1000:1000 /vol-ws",
    // delta/.git : à root, 755, donc NON inscriptible par node, mais monté par personne. MO-3 : renommer « delta » suffirait à en
    // poser un neuf, inscriptible. Posé APRÈS le chown pour rester à root.
    options.gitHorsMontage ? "mkdir -p /vol-ws/delta/.git/hooks && chown 1000:1000 /vol-ws/delta && chmod 755 /vol-ws/delta/.git" : "true",
    poser(
      "/vol-control/omo-projets.json",
      JSON.stringify({
        version: 1,
        genereLe: "2026-09-17T10:00:00Z",
        projets: [
          { chemin: "alpha", git: "dossier" },
          { chemin: "beta", git: "absent" },
        ],
        gitProteges: [{ chemin: "alpha", forme: "dossier" }],
      }),
      "644",
    ),
    "chown 1000:1000 /vol-control /vol-control/omo-projets.json",
    // Cinq dossiers de configuration : un volume vide par dossier, root, monté en lecture seule (D-2b-33).
    ...["config-opencode", "opencode", "omo", "claude", "agents"].map((nom) => `mkdir -p /vol-vide-${nom}`),
    ...(options.configANode ?? []).map((nom) => `chown 1000:1000 /vol-vide-${nom}`),
  ].join("\n");

  const montages = [
    "-v",
    `${cas.volume("image")}:/vol-image`,
    "-v",
    `${cas.volume("ref")}:/vol-ref`,
    "-v",
    `${cas.volume("sbin")}:/vol-sbin`,
    "-v",
    `${cas.volume("auth")}:/vol-auth`,
    "-v",
    `${cas.volume("data")}:/vol-data`,
    "-v",
    `${cas.volume("ws")}:/vol-ws`,
    "-v",
    `${cas.volume("git-alpha")}:/vol-git-alpha`,
    "-v",
    `${cas.volume("control")}:/vol-control`,
    "-v",
    `${cas.volume("state")}:/vol-state`,
    ...["config-opencode", "opencode", "omo", "claude", "agents"].flatMap((nom) => ["-v", `${cas.volume(`vide-${nom}`)}:/vol-vide-${nom}`]),
  ];
  const res = docker(["run", "--rm", "-i", ...montages, IMAGE_BASE, "sh", "-s"], script);
  assert.equal(res.code, 0, `préparation de ${cas.nom} : ${res.stderr}`);
}

/** Options de sécurité du contrat (`contrat-salle.json`, `securite`). */
const SECURITE = [
  "--cap-drop",
  "ALL",
  "--cap-add",
  "SETUID",
  "--cap-add",
  "SETGID",
  "--security-opt",
  "no-new-privileges:true",
  "--read-only",
  "--tmpfs",
  "/home/node:exec,mode=0755,uid=1000,gid=1000",
  "--tmpfs",
  "/tmp:exec,mode=1777",
];

/** Lance le superviseur en arrière-plan et rend le nom du conteneur. */
function lancerSuperviseur(cas: Cas, options: OptionsCas): string {
  const nom = cas.conteneur("salle");
  const dossiersConfig = [
    ["config-opencode", "/home/node/.config/opencode"],
    ["opencode", "/home/node/.opencode"],
    ["omo", "/home/node/.omo"],
    ["claude", "/home/node/.claude"],
    ["agents", "/home/node/.agents"],
  ] as const;
  const args = [
    "run",
    "-d",
    "--init",
    "--name",
    nom,
    "--network",
    "none",
    // Le cas MO-7 retire no-new-privileges, et lui seul : tout le reste du contrat est gardé.
    ...(options.sansNoNewPrivs ? SECURITE.filter((option, i) => option !== "no-new-privileges:true" && SECURITE[i + 1] !== "no-new-privileges:true") : SECURITE),
    ...(options.tetu ? ["-e", "OMO_STUB_TETU=1"] : []),
    "-v",
    `${cas.volume("image")}:/opt/omo-check:ro`,
    "-v",
    `${cas.volume("ref")}:/etc/omo-reference:ro`,
    "-v",
    `${cas.volume("sbin")}:/usr/local/sbin:ro`,
    "-v",
    `${cas.volume("control")}:/control:ro`,
    "-v",
    `${cas.volume("state")}:/omo-state`,
    "-v",
    `${cas.volume("auth")}:/auth-src:ro`,
    "-v",
    `${cas.volume("data")}:/home/node/.local/share/opencode`,
    "-v",
    `${cas.volume("ws")}:/workspace`,
    "-v",
    `${cas.volume("git-alpha")}:/workspace/alpha/.git:ro`,
    ...dossiersConfig
      .filter(([nom2]) => !(options.configAbsente ?? []).includes(nom2))
      .flatMap(([nom2, cible]) => ["-v", `${cas.volume(`vide-${nom2}`)}:${cible}:ro`]),
    IMAGE_BASE,
    "sh",
    "/opt/omo-check/supervisor.sh",
  ];
  const res = docker(args);
  assert.equal(res.code, 0, `lancement de ${nom} : ${res.stderr}`);
  return nom;
}

/** Écrit le battement du cockpit toutes les 5 s dans le volume de contrôle, comme le fera `omo-control.ts` (L17b). */
function lancerBattement(cas: Cas): string {
  const nom = cas.conteneur("battement");
  const boucle = [
    "while true; do",
    '  printf \'{"at":%s}\' "$(date +%s%3N)" > /control/heartbeat.tmp',
    "  mv -f /control/heartbeat.tmp /control/heartbeat",
    "  sleep 5",
    "done",
  ].join("\n");
  const res = docker(["run", "-d", "--name", nom, "--network", "none", "-v", `${cas.volume("control")}:/control`, IMAGE_BASE, "sh", "-c", boucle]);
  assert.equal(res.code, 0, `battement : ${res.stderr}`);
  return nom;
}

/** Écrit un `precheck-ok` dans le volume de contrôle, pour le `startId` donné (ou un autre, pour T-L17-b). */
function ecrirePrecheck(cas: Cas, startId: string): void {
  const contenu = JSON.stringify({ startId, at: Date.now(), projets: [] });
  const script = `printf %s '${Buffer.from(contenu, "utf8").toString("base64")}' | base64 -d > /control/precheck-ok.tmp\nmv -f /control/precheck-ok.tmp /control/precheck-ok\n`;
  const res = docker(["run", "--rm", "-i", "-v", `${cas.volume("control")}:/control`, IMAGE_BASE, "sh", "-s"], script);
  assert.equal(res.code, 0, `precheck-ok : ${res.stderr}`);
}

/** Écrit un `stop-request` dans le volume de contrôle, comme le fera `stopTreeOmo` (§3.12.1 l.404). */
function ecrireArret(cas: Cas): void {
  const contenu = JSON.stringify({ at: Date.now(), cause: "vous" });
  const script = `printf %s '${Buffer.from(contenu, "utf8").toString("base64")}' | base64 -d > /control/stop-request.tmp\nmv -f /control/stop-request.tmp /control/stop-request\n`;
  const res = docker(["run", "--rm", "-i", "-v", `${cas.volume("control")}:/control`, IMAGE_BASE, "sh", "-s"], script);
  assert.equal(res.code, 0, `stop-request : ${res.stderr}`);
}

/** Contenu d'un fichier d'un volume, `null` s'il n'existe pas. */
function lireDansVolume(cas: Cas, volume: string, cible: string, chemin: string): string | null {
  const res = docker(["run", "--rm", "-v", `${cas.volume(volume)}:${cible}`, IMAGE_BASE, "sh", "-c", `cat ${chemin} 2>/dev/null || true`]);
  assert.equal(res.code, 0, res.stderr);
  return res.stdout === "" ? null : res.stdout;
}

const inspecter = (nom: string, format: string): string => docker(["inspect", "-f", format, nom]).stdout.trim();

/** Journal du conteneur : ce que le superviseur a dit de lui-même. Joint à tout échec, sinon on cherche à l'aveugle. */
const journal = (nom: string): string => {
  const res = docker(["logs", "--tail", "40", nom]);
  return `${res.stdout}${res.stderr}`.trim();
};

/** Attend une condition, par sondage borné (on s'arrête dès que c'est vrai). */
async function attendre<T>(lire: () => T | null | undefined | false, limiteMs: number, quoi: string, pasMs = 500): Promise<T> {
  const fin = Date.now() + limiteMs;
  for (;;) {
    const valeur = lire();
    if (valeur !== null && valeur !== undefined && valeur !== false) return valeur;
    if (Date.now() > fin) throw new Error(`${quoi} : rien en ${limiteMs} ms`);
    await new Promise((resolve) => setTimeout(resolve, pasMs));
  }
}

/**
 * Fenêtre d'observation d'une propriété NÉGATIVE (« rien ne démarre ») : la seule façon de prouver qu'il ne se passe rien est de
 * regarder un moment. La durée n'est pas un chiffre magique : c'est deux tours de la boucle d'attente du superviseur, qui relit le
 * volume de contrôle toutes les `battementS` secondes. Le test échoue DÈS que la propriété est violée, sans attendre la fin.
 */
async function resterFaux(lire: () => unknown, quoi: string, tours = 2): Promise<void> {
  const fin = Date.now() + tours * salle.OMO_DELAIS.battementS * 1000;
  while (Date.now() < fin) {
    const valeur = lire();
    assert.ok(valeur === null || valeur === undefined || valeur === false, quoi);
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
}

const etatPublie = (cas: Cas) => {
  const texte = lireDansVolume(cas, "state", "/omo-state", "/omo-state/state.json");
  return texte === null ? null : analyserEtat(texte);
};

const capacitesDuFaux = (cas: Cas) => lireDansVolume(cas, "data", "/data", "/data/omo-stub-capacites.txt");

describe("superviseur dans un conteneur jetable", { skip: SAUT ?? false }, () => {
  const cas: Cas[] = [];
  const nouveauCas = (nom: string) => {
    const c = new Cas(nom);
    cas.push(c);
    return c;
  };

  before(() => {
    // Un cas resté d'une exécution interrompue empêcherait « docker run --name » : on part d'un poste propre.
    const anciens = docker(["ps", "-a", "--filter", `name=${PREFIXE}-`, "--format", "{{.Names}}"]).stdout.split("\n").filter(Boolean);
    for (const nom of anciens) docker(["rm", "-f", "-v", nom]);
    const volumes = docker(["volume", "ls", "--filter", `name=${PREFIXE}-`, "--format", "{{.Name}}"]).stdout.split("\n").filter(Boolean);
    for (const nom of volumes) docker(["volume", "rm", "-f", nom]);
  });

  after(() => {
    for (const c of cas) c.nettoyer();
    const restants = docker(["ps", "-a", "--filter", `name=${PREFIXE}-`, "--format", "{{.Names}}"]).stdout.split("\n").filter(Boolean);
    assert.deepEqual(restants, [], "conteneurs de L17a non nettoyés");
  });

  it("T-L17-a : battement coupé, opencode arrêté sous la borne des 27 s", async (t) => {
    t.diagnostic("un battement coupé, un faux opencode qui ignore TERM : la mort doit venir du KILL");
    const c = nouveauCas("a");
    preparer(c, { tetu: true });
    const battement = lancerBattement(c);
    const salleNom = lancerSuperviseur(c, { tetu: true });

    // Le superviseur attend le precheck-ok de CE démarrage : il faut d'abord lire le startId qu'il vient de tirer.
    const etat = await attendre(() => etatPublie(c), 60_000, "état publié par le superviseur");
    assert.equal(etat.phase, "attente");
    assert.equal(etat.manifesteReference, "ok");
    assert.equal(etat.validation, "ok");
    assert.deepEqual(
      etat.dossiersConfig.map((d) => d.ok),
      [true, true, true, true, true],
    );
    assert.deepEqual(etat.projets, [
      { chemin: "alpha", gitLectureSeule: true },
      { chemin: "beta", gitLectureSeule: true },
    ]);
    assert.deepEqual(etat.workspaceGit.nonProteges, []);
    assert.equal(etat.workspaceGit.limiteAtteinte, false);

    ecrirePrecheck(c, etat.startId);
    const capacites = await attendre(() => capacitesDuFaux(c), 60_000, "faux opencode lancé");

    // M32 : opencode tourne en tant que node, sans aucune capacité effective, permise, héritable ni ambiante.
    assert.match(capacites, /Uid:\s+1000\s+1000\s+1000\s+1000/);
    for (const champ of ["CapInh", "CapPrm", "CapEff", "CapAmb"]) {
      assert.match(capacites, new RegExp(`${champ}:\\s+0{16}`), `${champ} doit être nul : ${capacites}`);
    }
    assert.match(capacites, /NoNewPrivs:\s+1/);
    // La limite dite (R10) : l'ensemble borné garde SETUID et SETGID, faute de CAP_SETPCAP (mesure L17a).
    assert.match(capacites, /CapBnd:\s+0{14}c0/);

    // Purge (D-2b-36 corrigée par MO-2) et auth.json (D-2b-26), faits avant le lancement : la base et ses deux fichiers WAL, la
    // copie d'auth.json, et le fichier que le faux opencode vient d'écrire. Rien d'autre.
    const restes = docker(["run", "--rm", "-v", `${c.volume("data")}:/data`, IMAGE_BASE, "sh", "-c", "ls -A /data | sort"]).stdout.split("\n").filter(Boolean);
    assert.deepEqual(restes, ["auth.json", "omo-stub-capacites.txt", "opencode.db", "opencode.db-shm", "opencode.db-wal"], `purge : ${restes.join(", ")}`);
    const droits = docker(["run", "--rm", "-v", `${c.volume("data")}:/data`, IMAGE_BASE, "sh", "-c", "stat -c '%a %u %g' /data/auth.json"]).stdout.trim();
    assert.equal(droits, "600 1000 1000", "auth.json recopié en 0600 pour node");

    // Le battement s'arrête : le dernier `at` écrit est le point de départ de la mesure.
    docker(["rm", "-f", "-v", battement]);
    const dernier = lireDansVolume(c, "control", "/control", "/control/heartbeat");
    const at = JSON.parse(dernier ?? "{}").at as number;
    assert.ok(Number.isSafeInteger(at), `dernier battement illisible : ${dernier}`);

    const fin = await attendre(
      () => {
        const statut = inspecter(salleNom, "{{.State.Status}}");
        return statut === "exited" ? inspecter(salleNom, "{{.State.FinishedAt}}") : null;
      },
      90_000,
      `arrêt du conteneur de la salle\njournal :\n${journal(salleNom)}`,
    ).catch((err: Error) => {
      throw new Error(`${err.message}\njournal final :\n${journal(salleNom)}`);
    });
    const delai = (Date.parse(fin) - at) / 1000;
    t.diagnostic(`arrêt ${delai.toFixed(1)} s après le dernier battement (borne ${salle.borneHommeMort()} s)`);
    assert.ok(delai > 0, `mesure incohérente : ${delai} s`);
    assert.ok(delai <= salle.borneHommeMort(), `arrêt en ${delai.toFixed(1)} s, borne ${salle.borneHommeMort()} s`);
    assert.equal(inspecter(salleNom, "{{.State.ExitCode}}"), "11", "sortie « battement périmé », non nulle : la salle repart à neuf");
    assert.equal(etatPublie(c)?.phase, "arret");
    // Le faux opencode ignore TERM : c'est bien le KILL, envoyé en tant que node, qui l'a arrêté (root n'a pas CAP_KILL).
    assert.match(journal(salleNom), /apres TERM : KILL/);
  });

  it("stop-request : TERM envoyé en tant que node, opencode s'arrête sans KILL", async (t) => {
    t.diagnostic("root n'a pas CAP_KILL : sans setpriv, ce TERM n'arriverait jamais et le journal dirait KILL");
    const c = nouveauCas("arret");
    preparer(c, {});
    lancerBattement(c);
    const salleNom = lancerSuperviseur(c, {});
    const etat = await attendre(() => etatPublie(c), 60_000, "état publié");
    ecrirePrecheck(c, etat.startId);
    await attendre(() => capacitesDuFaux(c), 60_000, "faux opencode lancé");

    const avant = Date.now();
    ecrireArret(c);
    await attendre(() => inspecter(salleNom, "{{.State.Status}}") === "exited", 30_000, `arrêt demandé\n${journal(salleNom)}`);
    t.diagnostic(`arrêt ${((Date.now() - avant) / 1000).toFixed(1)} s après le stop-request`);
    assert.equal(inspecter(salleNom, "{{.State.ExitCode}}"), "10", "sortie « arrêt demandé »");
    const texte = journal(salleNom);
    assert.doesNotMatch(texte, /KILL/, `le faux opencode coopératif aurait dû s'arrêter sur TERM :\n${texte}`);
    assert.equal(etatPublie(c)?.phase, "arret");
  });

  it("T-L17-b : aucun démarrage sans battement, ni avec le pré-contrôle d'un autre démarrage", async () => {
    const c = nouveauCas("b");
    preparer(c, {});
    lancerSuperviseur(c, {});
    const etat = await attendre(() => etatPublie(c), 60_000, "état publié");
    assert.equal(etat.phase, "attente");

    // 1. Pré-contrôle du bon démarrage, mais aucun battement.
    ecrirePrecheck(c, etat.startId);
    await resterFaux(() => capacitesDuFaux(c), "opencode lancé sans battement");

    // 2. Battement frais, mais pré-contrôle d'un démarrage précédent.
    ecrirePrecheck(c, "a41b7e52-0c63-4f8d-9a25-6b8e0d31f7c4");
    lancerBattement(c);
    await resterFaux(() => capacitesDuFaux(c), "opencode lancé sur le pré-contrôle d'un autre démarrage");
    assert.equal(etatPublie(c)?.phase, "attente");

    // 3. Le bon pré-contrôle, enfin : la salle démarre. Sans ce troisième temps, le test passerait même si RIEN ne démarrait jamais.
    ecrirePrecheck(c, etat.startId);
    await attendre(() => capacitesDuFaux(c), 60_000, "faux opencode lancé après le bon pré-contrôle");
  });

  it("lecture bornée dans l'image : /proc annonce 0 octet, la borne de lecture tient quand même", () => {
    const c = nouveauCas("proc");
    preparer(c, {});
    // /dev/null et /dev/zero : pas des fichiers ordinaires, jamais lus (l'un rendrait « rien », l'autre des zéros sans fin).
    const script =
      "import('/opt/omo-check/supervisor-lib.mjs').then((m) => process.stdout.write(JSON.stringify([m.lireTexteBorne('/proc/self/status', 100), (m.lireTexteBorne('/proc/self/status', 65536) ?? '').slice(0, 5), m.lireTexteBorne('/dev/null'), m.lireTexteBorne('/dev/zero')])))";
    const res = docker(["run", "--rm", "--network", "none", ...SECURITE, "-v", `${c.volume("image")}:/opt/omo-check:ro`, IMAGE_BASE, "node", "-e", script]);
    assert.equal(res.code, 0, res.stderr);
    assert.deepEqual(JSON.parse(res.stdout), [null, "Name:", null, null]);
  });

  it("stop-request pendant l'attente : sortie sans rien démarrer", async () => {
    const c = nouveauCas("attente");
    preparer(c, {});
    const salleNom = lancerSuperviseur(c, {});
    await attendre(() => etatPublie(c)?.phase === "attente", 60_000, "attente du battement");
    ecrireArret(c);
    await attendre(() => inspecter(salleNom, "{{.State.Status}}") === "exited", 30_000, `sortie sur stop-request\n${journal(salleNom)}`);
    assert.equal(inspecter(salleNom, "{{.State.ExitCode}}"), "3");
    assert.equal(capacitesDuFaux(c), null);
    assert.equal(etatPublie(c)?.phase, "arret");
  });

  it("T-L17-d : un .git inscriptible par node, ou hors montage, remplit workspaceGit.nonProteges et rien ne démarre", async () => {
    const c = nouveauCas("d");
    preparer(c, { projetOuvert: true, gitHorsMontage: true });
    lancerSuperviseur(c, {});
    const etat = await attendre(() => etatPublie(c), 60_000, "état publié");
    // gamma/.git : node peut y écrire. delta/.git : node ne le peut pas, mais aucun bind ne le tient (MO-3).
    assert.deepEqual([...etat.workspaceGit.nonProteges].sort(), ["delta/.git", "gamma/.git"]);
    assert.equal(etat.workspaceGit.limiteAtteinte, false);
    // Le .git monté en lecture seule, lui, reste protégé : c'est bien l'écriture qui décide, pas la présence du dossier.
    assert.deepEqual(etat.projets, [
      { chemin: "alpha", gitLectureSeule: true },
      { chemin: "beta", gitLectureSeule: true },
    ]);
    // Le superviseur ne refuse pas (le cockpit refusera l'activation, D-2b-28), mais il ne se déclare jamais prêt :
    // même avec un battement et un pré-contrôle en règle, opencode ne démarre pas sur un dossier de travail non protégé.
    lancerBattement(c);
    ecrirePrecheck(c, etat.startId);
    await resterFaux(() => capacitesDuFaux(c), "opencode lancé alors qu'un .git est inscriptible");
    assert.equal(etatPublie(c)?.phase, "attente");
  });

  for (const [nom, options, attendu] of [
    ["manifeste modifié", { reference: "aaaa  /opt/omo/index.js\nzzzz  /opt/omo-check/supervisor-lib.mjs\n" }, "ecart"],
    ["amorce non remplacée", { reference: "# amorce\n" }, "amorce"],
    ["validation en échec", { codeValidation: 1 }, "validation"],
  ] as const) {
    it(`T-L17-e : ${nom} → aucun démarrage`, async () => {
      const c = nouveauCas(`e-${attendu}`);
      preparer(c, options);
      const salleNom = lancerSuperviseur(c, options);
      await attendre(() => inspecter(salleNom, "{{.State.Status}}") === "exited", 60_000, "refus du superviseur");
      assert.notEqual(inspecter(salleNom, "{{.State.ExitCode}}"), "0");
      assert.equal(capacitesDuFaux(c), null, "opencode lancé malgré le refus");
      const etat = etatPublie(c);
      assert.equal(etat?.phase, "arret");
      if (attendu === "validation") assert.equal(etat?.validation, "echec");
      else assert.equal(etat?.manifesteReference, attendu);
    });
  }

  for (const [nom, options] of [
    ["dossier de configuration absent", { configAbsente: ["omo"] }],
    ["dossier de configuration appartenant à node", { configANode: ["claude"] }],
  ] as const) {
    it(`T-L17-f : ${nom} → aucun démarrage`, async () => {
      const c = nouveauCas(`f-${options.configAbsente ? "absent" : "node"}`);
      preparer(c, options);
      const salleNom = lancerSuperviseur(c, options);
      await attendre(() => inspecter(salleNom, "{{.State.Status}}") === "exited", 60_000, "refus du superviseur");
      assert.notEqual(inspecter(salleNom, "{{.State.ExitCode}}"), "0");
      assert.equal(capacitesDuFaux(c), null, "opencode lancé malgré un dossier de configuration douteux");
      const etat = etatPublie(c);
      assert.equal(etat?.phase, "arret");
      assert.ok(
        etat?.dossiersConfig.some((d) => !d.ok),
        "le dossier fautif doit apparaître dans l'état publié",
      );
    });
  }

  for (const [nom, suffixe, commande] of [
    ["un projet renommé, son .git monté suit l'inode", "projet", ["mv", "/workspace/alpha", "/workspace/alpha-deplace"]],
    ["le parent d'un dossier de configuration renommé", "config", ["mv", "/home/node/.config", "/home/node/.config-deplace"]],
  ] as const) {
    it(`MO-3 : ${nom} pendant la salle → arrêt, sortie 13`, async (t) => {
      const c = nouveauCas(`mo3-${suffixe}`);
      preparer(c, {});
      lancerBattement(c);
      const salleNom = lancerSuperviseur(c, {});
      const etat = await attendre(() => etatPublie(c), 60_000, "état publié");
      ecrirePrecheck(c, etat.startId);
      await attendre(() => capacitesDuFaux(c), 60_000, "faux opencode lancé");
      // Ce que l'IA peut faire en tant que node : renommer un PARENT. Le montage :ro suit l'inode renommé, et un dossier neuf,
      // inscriptible, pourrait prendre sa place (MO-3, point 7). Les droits ne voient rien ; la table des montages, si.
      const res = docker(["exec", "-u", "1000:1000", salleNom, ...commande]);
      assert.equal(res.code, 0, `renommage refusé dans la salle : ${res.stderr}`);
      const avant = Date.now();
      await attendre(() => inspecter(salleNom, "{{.State.Status}}") === "exited", 30_000, `arrêt sur montage déplacé\n${journal(salleNom)}`);
      t.diagnostic(`arrêt ${((Date.now() - avant) / 1000).toFixed(1)} s après le renommage`);
      assert.equal(inspecter(salleNom, "{{.State.ExitCode}}"), "13", `sortie « point de montage déplacé » attendue :\n${journal(salleNom)}`);
      assert.equal(etatPublie(c)?.phase, "arret");
    });
  }

  for (const [nom, suffixe, options] of [
    ["volume d'authentification laissé à root", "auth", { authARoot: true }],
    ["volume d'état donné à node et ouvert en écriture", "etat", { etatOuvertANode: true }],
  ] as const) {
    it(`MO-11 : ${nom} → aucun démarrage`, async () => {
      const c = nouveauCas(`mo11-${suffixe}`);
      preparer(c, options);
      lancerBattement(c);
      const salleNom = lancerSuperviseur(c, options);
      await attendre(() => inspecter(salleNom, "{{.State.Status}}") === "exited", 60_000, `refus du superviseur\n${journal(salleNom)}`);
      assert.notEqual(inspecter(salleNom, "{{.State.ExitCode}}"), "0");
      assert.equal(capacitesDuFaux(c), null, "opencode lancé malgré un volume au mauvais propriétaire");
      assert.match(journal(salleNom), /REFUS: un volume de la salle .* proprietaire du contrat/);
    });
  }

  it("MO-7 : salle lancée sans no-new-privileges → bascule refusée, aucun démarrage", async () => {
    const c = nouveauCas("mo7");
    preparer(c, {});
    lancerBattement(c);
    const salleNom = lancerSuperviseur(c, { sansNoNewPrivs: true });
    await attendre(() => inspecter(salleNom, "{{.State.Status}}") === "exited", 60_000, `refus du superviseur\n${journal(salleNom)}`);
    assert.notEqual(inspecter(salleNom, "{{.State.ExitCode}}"), "0");
    assert.equal(capacitesDuFaux(c), null, "opencode lancé sans no-new-privileges");
    assert.match(journal(salleNom), /REFUS: bascule vers node incomplete/);
    assert.equal(etatPublie(c)?.phase, "arret");
  });
});
