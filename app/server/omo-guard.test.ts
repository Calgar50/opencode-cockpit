// Plugin de garde de la Salle OMO (L24 ; plan 2 bis §6 ; spéc. §7.6 l.1157, §4.2 l.612, F-n l.170, F-aa l.183, §4.14.6 l.863,
// R11) : `docker/opencode-omo/guard/cockpit-guard.js`, un FILET `tool.execute.before` chargé par opencode dans la salle.
//
// Deux étages :
// 1. UNITAIRES, dans `npm test` : entrées de crochet synthétiques (clés et `.env*`, `.env.example` permis, chemins hors du projet,
//    liens, réseau, délégations selon l'état de garde), lecteur de `guard-state.json` sur les vecteurs de L17a et sur de vrais
//    fichiers, listes comparées à celles du cockpit, forme du plugin attendue par opencode 1.18.30, textes (T-L24-c). Aucun
//    conteneur, aucune pause, aucun port.
// 2. RÉELS, SAUTÉS sans `OMO_TESTS_CONTENEUR=1` (D-2b-44 ; question Q1 (b), accord du 17/09) : opencode 1.18.30 réel SANS
//    l'extension (image `omo11/opencode:omo11`, déjà construite), faux fournisseur de la salle (L21a) en mode `--http`, projet
//    Compose `omo11-l24`, réseau interne, aucun port publié, dossiers de configuration et plugin en lecture seule : T-L24-a (lecture
//    d'`id_ed25519` par un appel d'outil scripté → erreur d'outil) et T-L24-b (`task` bloqué, absent, invalide), puis une
//    contre-épreuve SANS le filet (la même configuration laisse tout passer : c'est bien le filet qui refuse). Aucun appel facturé,
//    aucun jeton Copilot ; nettoyage même en échec. L'extension n'est ni installée ni exécutée.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it, type TestContext } from "node:test";
import { pathToFileURL } from "node:url";
import * as garde from "../../docker/opencode-omo/guard/cockpit-guard.js";
import type { CategorieRefus, ContexteGarde, LectureEtatGarde } from "../../docker/opencode-omo/guard/cockpit-guard.js";
import { OMO_SALLE_CONTRACT_FILE, OMO_SALLE_CONTRACT_SCHEMA } from "./omo-contracts.ts";
import { KEY_FILE_READ_RULES } from "./shared/assistant-rules.ts";
import { OMO_FICHIERS_CONTROLE, OMO_GUARD_TOOLS, analyserGuardState, ecrireGuardState } from "./shared/omo-control-protocol.ts";
import { EXTENSIONS_CLE_P03, estFichierCle } from "./shared/omo-precheck-rules.ts";

const RACINE = path.join(import.meta.dirname, "..", "..");
const GARDE_JS = path.join(RACINE, "docker", "opencode-omo", "guard", "cockpit-guard.js");
const GARDE_DTS = path.join(RACINE, "docker", "opencode-omo", "guard", "cockpit-guard.d.ts");
const BANC = path.join(RACINE, "e2e", "omo-banc", "guard");

const PROJET = "/workspace/projet";
const SORTIES = "/home/node/.local/share/opencode/tool-output";

/** Contexte de décision : chemins réels égaux aux chemins (aucun lien) sauf ceux qu'on donne, état de garde choisi. */
function contexte(options: { etat?: LectureEtatGarde; liens?: Record<string, string | null>; dossier?: unknown } = {}): ContexteGarde & { lectures: number } {
  const ctx: ContexteGarde & { lectures: number } = {
    dossier: "dossier" in options ? options.dossier : PROJET,
    sortiesOutils: SORTIES,
    reel: (chemin: string) => {
      const liens = options.liens ?? {};
      return chemin in liens ? (liens[chemin] ?? null) : chemin;
    },
    lectures: 0,
    lireEtat: () => {
      ctx.lectures += 1;
      return options.etat ?? { etat: "absent" };
    },
  };
  return ctx;
}

const categorie = (outil: string, args: unknown, ctx: ContexteGarde = contexte()): CategorieRefus | null => garde.decider(outil, args, ctx)?.categorie ?? null;

const message = (cat: CategorieRefus, outil: string): string => garde.MESSAGES_FILET[cat].replace("{outil}", outil);

// --- Fichiers de clés et .env ----------------------------------------------------------------------------------------------------

describe("filet : fichiers de clés et .env refusés, .env.example permis", () => {
  it("read d'id_ed25519, .env, .env.local et d'autres clés → refus « cle » (chemin absolu ou relatif au projet)", () => {
    for (const chemin of [
      `${PROJET}/id_ed25519`,
      "id_ed25519",
      ".env",
      ".env.local",
      ".ENV.production",
      "sous/dossier/.env",
      "prod.env",
      ".envrc",
      "certs/serveur.key",
      "certs/serveur.KEY",
      "tls.pem",
      "coffre.kdbx",
      "infra/terraform.tfstate",
      "id_rsa.pub",
      "kubeconfig",
      "deploy/.kube/config",
    ]) {
      assert.equal(categorie("read", { filePath: chemin }), "cle", chemin);
    }
  });

  it(".env.example (et x.env.example) → permis ; fichiers ordinaires → permis", () => {
    for (const chemin of [".env.example", "config/app.env.example", "README.md", "src/index.ts", "environment.md", "package.json"]) {
      assert.equal(categorie("read", { filePath: chemin }), null, chemin);
    }
  });

  it("écriture aussi : write, edit, apply_patch (en-têtes Add, Update, Delete, Move to), et tout argument nommé comme un chemin", () => {
    assert.equal(categorie("write", { filePath: ".env", content: "A=1" }), "cle");
    assert.equal(categorie("edit", { filePath: "certs/client.p12", oldString: "a", newString: "b" }), "cle");
    for (const entete of ["*** Add File: config/.env", "*** Update File: id_ed25519", "*** Delete File: tls.pem", "*** Update File: a.txt\n*** Move to: .env.local"]) {
      assert.equal(categorie("apply_patch", { patchText: `*** Begin Patch\n${entete}\n+x\n*** End Patch` }), "cle", entete);
    }
    assert.equal(categorie("apply_patch", { patchText: "*** Begin Patch\n*** Update File: src/a.ts\n+x\n*** End Patch" }), null);
    // Outil d'une extension : reconnu par le nom de l'argument (file_path, paths), pas par le nom de l'outil.
    assert.equal(categorie("look_at", { file_path: ".env" }), "cle");
    assert.equal(categorie("outil_inconnu", { paths: ["src/a.ts", "id_ecdsa"] }), "cle");
    assert.equal(categorie("edit", { edits: [{ filePath: "src/a.ts" }, { filePath: ".env" }] }), "cle");
    assert.equal(categorie("lsp", { operation: "hover", filePath: "server.keystore", line: 1, character: 1 }), "cle");
  });

  it("glob et motifs de fichiers d'une extension (include, globs) : chemin de clé, ou motif qui ne vise que des clés → refus ; motif large ou ordinaire → permis", () => {
    assert.equal(categorie("glob", { pattern: "*.ts", path: ".env" }), "cle");
    for (const motif of [".env*", ".env", "*.env", "**/.env.*", "*.pem", "*.{ts,env}", "id_*", "[.]env", "**/id_ed25519", "*.kube/config"]) {
      assert.equal(categorie("outil_extension", { pattern: "x", include: motif }), "cle", `include ${motif}`);
      assert.equal(categorie("ast_grep_search", { pattern: "$A", globs: [motif] }), "cle", `globs ${motif}`);
      assert.equal(categorie("glob", { pattern: motif }), "cle", `glob ${motif}`);
    }
    for (const motif of ["*.ts", "*", "**/*", "*.*", "????", "src/**/*.{ts,tsx}", "*.env.example", "!.env", "*e*"]) {
      assert.equal(categorie("outil_extension", { pattern: "x", include: motif }), null, `include ${motif}`);
      assert.equal(categorie("glob", { pattern: motif }), null, `glob ${motif}`);
    }
    // Hors de l'outil glob, `pattern` est une expression sur le CONTENU, jamais un nom de fichier.
    assert.equal(categorie("outil_extension", { pattern: ".env" }), null);
  });

  it("grep refusé en toutes circonstances (« recherche ») : opencode 1.18.30 n'applique ses règles qu'à l'expression cherchée, et ripgrep lit tout fichier que git n'ignore pas", () => {
    // Sans chemin ni motif de fichiers, grep.ts cherche dans tout le projet, .env et fichiers de clés compris (rg --hidden).
    const appels: unknown[] = [
      { pattern: "PASSWORD|SECRET|TOKEN" },
      { pattern: "BEGIN .* PRIVATE KEY" },
      { pattern: "x", include: "*.ts" },
      { pattern: "x", path: "src" },
      { pattern: "SECRET", path: ".env" },
      { pattern: "x", path: SORTIES },
      {},
      undefined,
    ];
    for (const args of appels) assert.equal(categorie("grep", args), "recherche", JSON.stringify(args));
    assert.deepEqual([...garde.OUTILS_RECHERCHE], ["grep"]);
    assert.deepEqual(garde.decider("grep", { pattern: "x" }, contexte()), { categorie: "recherche", message: message("recherche", "grep") });
  });

  it("motif illisible ou démesuré → refus (fermé en cas de doute)", () => {
    assert.equal(categorie("glob", { pattern: "[abc" }), "cle");
    assert.equal(categorie("glob", { pattern: "x\\" }), "cle");
    assert.equal(categorie("glob", { pattern: "{a,b}{c,d}{e,f}{g,h}{i,j}{k,l}{m,n}" }), "cle");
    assert.equal(categorie("glob", { pattern: "a".repeat(5000) }), "cle");
    assert.equal(categorie("outil_extension", { pattern: "x", include: 42 }), "doute");
    assert.equal(categorie("grep", { pattern: "x", include: 42 }), "recherche");
  });

  it("témoins des motifs : chaque témoin « clé » est une clé, aucun témoin ordinaire n'en est une", () => {
    for (const nom of garde.TEMOINS_CLE) assert.equal(garde.estNomCle(nom), true, nom);
    for (const nom of garde.TEMOINS_ORDINAIRES) assert.equal(garde.estNomCle(nom), false, nom);
  });
});

// --- Hors du projet, liens, doute -----------------------------------------------------------------------------------------------

describe("filet : chemins hors du projet ouvert (décision M3, external_directory)", () => {
  it("read de /etc/hostname, de ../autre et bash avec workdir hors du projet → refus « hors-projet »", () => {
    assert.equal(categorie("read", { filePath: "/etc/hostname" }), "hors-projet");
    assert.equal(categorie("read", { filePath: "../autre-projet/src/a.ts" }), "hors-projet");
    assert.equal(categorie("read", { filePath: "/workspace/projet-voisin/a.ts" }), "hors-projet");
    assert.equal(categorie("bash", { command: "ls", workdir: "/tmp" }), "hors-projet");
    assert.equal(categorie("glob", { pattern: "*.ts", path: "/workspace" }), "hors-projet");
    assert.equal(categorie("bash", { command: "ls", workdir: "sous-dossier" }), null);
    assert.equal(categorie("read", { filePath: PROJET }), null);
  });

  it("sorties longues d'opencode (tool-output) : lisibles par read et glob, jamais écrites", () => {
    assert.equal(categorie("read", { filePath: `${SORTIES}/tool_abc`, offset: 10 }), null);
    assert.equal(categorie("glob", { pattern: "tool_*", path: SORTIES }), null);
    assert.equal(categorie("write", { filePath: `${SORTIES}/tool_abc`, content: "x" }), "hors-projet");
    assert.equal(categorie("edit", { filePath: `${SORTIES}/tool_abc`, oldString: "a", newString: "b" }), "hors-projet");
  });

  it("lien du projet : son chemin réel compte (vers une clé → « cle », hors du projet → « hors-projet »)", () => {
    const liens = { [`${PROJET}/notes`]: "/workspace/dehors/id_ed25519", [`${PROJET}/doc.txt`]: "/etc/passwd" };
    assert.equal(categorie("read", { filePath: "notes" }, contexte({ liens })), "cle");
    assert.equal(categorie("read", { filePath: "doc.txt" }, contexte({ liens })), "hors-projet");
    // Un projet ouvert par un chemin qui est lui-même un lien : comparé à son chemin réel.
    const projetLie = { [PROJET]: "/donnees/projet", [`${PROJET}/a.ts`]: "/donnees/projet/a.ts" };
    assert.equal(categorie("read", { filePath: "a.ts" }, contexte({ liens: projetLie })), null);
  });

  it("chemin ABSOLU avec « . » ou « .. » → refus : opencode 1.18.30 le passe tel quel au système, qui résout un lien AVANT le « .. » qui le suit", () => {
    // read.ts, write.ts et edit.ts ne normalisent qu'un chemin relatif. Même sans lien connu du filet, « <projet>/partage/../x »
    // mène hors du projet dès que « partage » est un lien vers l'extérieur : le chemin lexical ne le montre pas.
    const appels: [string, Record<string, unknown>][] = [
      ["read", { filePath: `${PROJET}/partage/../src/code.ts` }],
      ["write", { filePath: `${PROJET}/partage/../src/code.ts`, content: "x" }],
      ["edit", { filePath: `${PROJET}/partage/../src/code.ts`, oldString: "a", newString: "b" }],
      ["read", { filePath: `${PROJET}/racine/../etc/passwd` }],
      ["read", { filePath: `${PROJET}/./src/code.ts` }],
      ["read", { filePath: `${PROJET}/src/..` }],
      ["bash", { command: "ls", workdir: `${PROJET}/partage/..` }],
      ["glob", { pattern: "*.ts", path: `${PROJET}/partage/../src` }],
      ["apply_patch", { patchText: `*** Begin Patch\n*** Add File: ${PROJET}/partage/../src/neuf.ts\n+x\n*** End Patch` }],
    ];
    for (const [outil, args] of appels) assert.equal(categorie(outil, args), "doute", `${outil} ${JSON.stringify(args)}`);
    // Hors du projet même lu à la lettre : « hors-projet » ; vers une clé : « cle » (le dernier composant ne change pas).
    assert.equal(categorie("read", { filePath: `${PROJET}/../autre/x.ts` }), "hors-projet");
    assert.equal(categorie("read", { filePath: `${PROJET}/partage/../.env` }), "cle");
    // Relatif : opencode le normalise lui-même (path.resolve, path.join) avant de le passer au système, comme le filet.
    assert.equal(categorie("read", { filePath: "partage/../src/code.ts" }), null);
    assert.equal(categorie("write", { filePath: "./src/code.ts", content: "x" }), null);
    assert.equal(categorie("read", { filePath: `${PROJET}/src/code.ts` }), null);
  });

  it("chemin réel introuvable, projet inconnu, octet nul ou chemin démesuré → refus « doute »", () => {
    assert.equal(categorie("read", { filePath: "boucle" }, contexte({ liens: { [`${PROJET}/boucle`]: null } })), "doute");
    assert.equal(categorie("read", { filePath: "a.ts" }, contexte({ liens: { [PROJET]: null } })), "hors-projet");
    for (const dossier of [undefined, null, "relatif/projet", 42]) {
      assert.equal(categorie("read", { filePath: "a.ts" }, contexte({ dossier })), "doute", String(dossier));
      assert.equal(categorie("todowrite", { todos: [{ content: "a", status: "pending" }] }, contexte({ dossier })), null);
    }
    assert.equal(categorie("read", { filePath: "a\0.ts" }), "doute");
    assert.equal(categorie("read", { filePath: `${"a/".repeat(2100)}b` }), "doute");
    assert.equal(categorie("read", { filePath: 12 }), "doute");
  });

  it("arguments illisibles ou trop profonds → refus « doute » ; aucun argument → rien à vérifier", () => {
    assert.equal(categorie("read", "pas un objet"), "doute");
    assert.equal(categorie("read", ["a"]), "doute");
    let profond: Record<string, unknown> = { filePath: "a.ts" };
    for (let i = 0; i < 6; i += 1) profond = { niveau: profond };
    assert.equal(categorie("outil_inconnu", profond), "doute");
    assert.equal(categorie("outil_inconnu", { liste: Array.from({ length: 2100 }, () => ({ x: 1 })) }), "doute");
    assert.equal(categorie("todowrite", undefined), null);
    assert.equal(categorie("todowrite", null), null);
  });

  it("la clé l'emporte sur « hors du projet », qui l'emporte sur le doute", () => {
    assert.equal(categorie("outil_inconnu", { paths: ["/etc/hostname", ".env"] }), "cle");
    assert.equal(categorie("outil_inconnu", { paths: ["a\0", "/etc/hostname"] }), "hors-projet");
  });
});

// --- Réseau ----------------------------------------------------------------------------------------------------------------------

describe("filet : réseau refusé dans la salle (décision M3)", () => {
  it("webfetch, websearch et les outils des MCP réseau → refus « reseau », quels que soient les arguments", () => {
    for (const outil of ["webfetch", "websearch", "websearch_web_search_exa", "context7_query-docs", "grep_app_searchGitHub"]) {
      assert.equal(categorie(outil, { url: "http://example.invalid" }), "reseau", outil);
      assert.equal(categorie(outil, undefined), "reseau", outil);
    }
    assert.equal(categorie("webfetcher_local", {}), null);
  });
});

// --- Délégations et état de garde -------------------------------------------------------------------------------------------------

describe("filet : délégations selon guard-state.json (Q2, variante (a))", () => {
  const tache = { description: "d", prompt: "p", subagent_type: "general" };
  const valide = (bloquer: ("task" | "call_omo_agent")[]): LectureEtatGarde => ({ etat: "valide", garde: { version: 1, at: 1, bloquer } });

  it("état absent → aucun blocage ; état qui bloque task → task refusé, call_omo_agent permis", () => {
    assert.equal(categorie("task", tache, contexte({ etat: { etat: "absent" } })), null);
    assert.equal(categorie("call_omo_agent", tache, contexte({ etat: { etat: "absent" } })), null);
    assert.equal(categorie("task", tache, contexte({ etat: valide(["task"]) })), "delegation");
    assert.equal(categorie("call_omo_agent", tache, contexte({ etat: valide(["task"]) })), null);
    assert.equal(categorie("call_omo_agent", tache, contexte({ etat: valide(["call_omo_agent"]) })), "delegation");
    assert.equal(categorie("task", tache, contexte({ etat: valide([]) })), null);
  });

  it("état invalide → task et call_omo_agent refusés ; les autres outils ne lisent jamais l'état", () => {
    const ctx = contexte({ etat: { etat: "invalide", raison: "contenu" } });
    assert.equal(categorie("task", tache, ctx), "etat-illisible");
    assert.equal(categorie("call_omo_agent", tache, ctx), "etat-illisible");
    assert.equal(ctx.lectures, 2);
    assert.equal(categorie("read", { filePath: "a.ts" }, ctx), null);
    assert.equal(categorie("bash", { command: "npm test" }, ctx), null);
    assert.equal(ctx.lectures, 2);
    // Lecture qui ne ressemble à rien de connu : fermé en cas de doute.
    const bizarre = contexte({ etat: { etat: "valide" } as unknown as LectureEtatGarde });
    assert.equal(categorie("task", tache, bizarre), "etat-illisible");
  });

  it("chaque refus porte son message, avec le nom de l'outil (réduit à « outil » s'il est étrange)", () => {
    const refus = garde.decider("task", tache, contexte({ etat: valide(["task"]) }));
    assert.deepEqual(refus, { categorie: "delegation", message: message("delegation", "task") });
    assert.equal(garde.decider("outil étrange<script>", { filePath: ".env" }, contexte())?.message, message("cle", "outil"));
  });
});

// --- Lecteur de guard-state.json ------------------------------------------------------------------------------------------------

interface Vecteur {
  nom: string;
  format: string;
  texte: string;
  attendu: unknown;
}

const VECTEURS = (
  JSON.parse(fs.readFileSync(path.join(import.meta.dirname, "test-support", "fixtures", "omo-control-vectors.json"), "utf8")) as { vecteurs: Vecteur[] }
).vecteurs.filter((v) => v.format === "garde");

describe("lecteur de guard-state.json : vecteurs de L17a et bornes du filet", () => {
  it("les vecteurs « garde » de L17a donnent le résultat attendu, comme le lecteur du cockpit", () => {
    assert.ok(VECTEURS.length >= 4, "vecteurs « garde » absents de omo-control-vectors.json");
    for (const v of VECTEURS) {
      assert.deepEqual(garde.analyserEtatGarde(v.texte), v.attendu, v.nom);
      assert.deepEqual(garde.analyserEtatGarde(v.texte), analyserGuardState(v.texte), v.nom);
    }
  });

  it("même analyse que analyserGuardState sous 4 Kio (vecteurs de bord), et ce qu'écrit le cockpit est relu à l'identique", () => {
    const textes = [
      "",
      "null",
      "[]",
      '"texte"',
      "{}",
      '{"version":1,"at":0,"bloquer":[]}',
      '{"version":1,"at":-1,"bloquer":[]}',
      '{"version":1,"at":1.5,"bloquer":[]}',
      '{"version":1,"at":253402300800000,"bloquer":[]}',
      '{"version":"1","at":1,"bloquer":[]}',
      '{"version":1,"at":1,"bloquer":"task"}',
      '{"version":1,"at":1,"bloquer":["task","task","call_omo_agent"]}',
      '{"version":1,"at":1,"bloquer":[null]}',
      '{"version":1,"at":1,"bloquer":["TASK"]}',
      '{"version":1,"at":1,"bloquer":[],"autre":true}',
      "{pas du json",
    ];
    for (const texte of textes) assert.deepEqual(garde.analyserEtatGarde(texte), analyserGuardState(texte), texte);
    for (const bloquer of [[], ["task"], ["call_omo_agent"], ["task", "call_omo_agent"]] as const) {
      const ecrit = ecrireGuardState(1_757_000_000_000, bloquer);
      assert.deepEqual(garde.analyserEtatGarde(ecrit), { version: 1, at: 1_757_000_000_000, bloquer: [...bloquer] });
    }
  });

  it("au-delà de 4 Kio : invalide pour le filet (le cockpit, lui, lit jusqu'à 64 Kio)", () => {
    const base = '{"version":1,"at":1,"bloquer":[]}';
    const juste = base + " ".repeat(garde.ETAT_GARDE_MAX_OCTETS - base.length);
    assert.equal(Buffer.byteLength(juste), garde.ETAT_GARDE_MAX_OCTETS);
    assert.deepEqual(garde.analyserEtatGarde(juste), { version: 1, at: 1, bloquer: [] });
    assert.equal(garde.analyserEtatGarde(`${juste} `), null);
    assert.notEqual(analyserGuardState(`${juste} `), null);
    // Octets, pas caractères : 2 048 « é » font 4 096 octets, un de plus dépasse.
    assert.equal(garde.analyserEtatGarde(`{"version":1,"at":1,"bloquer":[],"x":"${"é".repeat(2100)}"}`), null);
  });

  describe("lireEtatGarde sur de vrais fichiers", () => {
    let dossier = "";
    before(() => {
      dossier = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "omo-l24-"));
    });
    after(() => {
      fs.rmSync(dossier, { recursive: true, force: true });
    });
    const poser = (nom: string, contenu: string | Buffer): string => {
      const chemin = path.join(dossier, nom);
      fs.writeFileSync(chemin, contenu);
      return chemin;
    };

    it("absent → « absent » ; valide → « valide » ; vide, illisible, trop gros, mauvais encodage → « invalide »", () => {
      assert.deepEqual(garde.lireEtatGarde(path.join(dossier, "absent.json")), { etat: "absent" });
      assert.deepEqual(garde.lireEtatGarde(poser("ok.json", ecrireGuardState(5, ["task"]))), { etat: "valide", garde: { version: 1, at: 5, bloquer: ["task"] } });
      assert.deepEqual(garde.lireEtatGarde(poser("vide.json", "")), { etat: "invalide", raison: "contenu" });
      assert.deepEqual(garde.lireEtatGarde(poser("faux.json", "{pas du json")), { etat: "invalide", raison: "contenu" });
      // Taille annoncée au-delà de 4 Kio : refusé sans rien lire.
      assert.deepEqual(garde.lireEtatGarde(poser("gros.json", `${ecrireGuardState(5, [])}${" ".repeat(5000)}`)), { etat: "invalide", raison: "taille" });
      assert.deepEqual(garde.lireEtatGarde(poser("latin1.json", Buffer.from([0x7b, 0xe9, 0x7d]))), { etat: "invalide", raison: "encodage" });
      const juste = '{"version":1,"at":1,"bloquer":[]}';
      assert.equal(garde.lireEtatGarde(poser("juste.json", juste + " ".repeat(garde.ETAT_GARDE_MAX_OCTETS - juste.length))).etat, "valide");
    });

    it("un dossier à la place du fichier → « invalide » (jamais « absent »), sans lecture", () => {
      fs.mkdirSync(path.join(dossier, "dossier.json"));
      assert.deepEqual(garde.lireEtatGarde(path.join(dossier, "dossier.json")), { etat: "invalide", raison: "pas un fichier" });
    });

    it("taille annoncée qui ment (/proc) : la lecture reste bornée à 4 Kio + 1", { skip: process.platform !== "linux" && "/proc absent de ce système : joué sous Linux (conteneur, CI)" }, () => {
      assert.ok(fs.statSync("/proc/self/maps").size <= garde.ETAT_GARDE_MAX_OCTETS, "taille annoncée de /proc/self/maps");
      assert.deepEqual(garde.lireEtatGarde("/proc/self/maps"), { etat: "invalide", raison: "trop gros" });
    });

    it(
      "fichier illisible (droits) → « invalide », jamais « absent »",
      { skip: process.platform === "win32" ? "droits POSIX absents sous Windows : joué sous Linux (conteneur, CI)" : process.getuid?.() === 0 ? "root lit un fichier en 000 : lancer hors root" : false },
      () => {
        const chemin = poser("ferme.json", ecrireGuardState(5, []));
        fs.chmodSync(chemin, 0o000);
        assert.deepEqual(garde.lireEtatGarde(chemin), { etat: "invalide", raison: "illisible" });
      },
    );

    it("tube nommé à la place du fichier → « invalide », sans attendre d'écrivain", { skip: process.platform !== "linux" && "tube nommé : joué sous Linux (conteneur, CI)" }, () => {
      const tube = path.join(dossier, "tube.json");
      const fabrique = spawnSync("mkfifo", [tube], { encoding: "utf8" });
      assert.equal(fabrique.status, 0, fabrique.stderr);
      // Dans un processus enfant borné : sans O_NONBLOCK, l'ouverture attendrait un écrivain pour toujours (le test ne bloque pas).
      const lecture = spawnSync(
        process.execPath,
        ["--input-type=module", "-e", `import(process.argv[1]).then((m) => process.stdout.write(JSON.stringify(m.lireEtatGarde(process.argv[2]))))`, pathToFileURL(GARDE_JS).href, tube],
        { encoding: "utf8", timeout: 10_000 },
      );
      assert.equal(lecture.status, 0, `lecture du tube : ${lecture.error?.message ?? lecture.stderr}`);
      assert.deepEqual(JSON.parse(lecture.stdout), { etat: "invalide", raison: "pas un fichier" });
    });

    it("un lien à la place du fichier → « invalide », jamais suivi", (t) => {
      const cible = poser("cible.json", ecrireGuardState(5, []));
      const lien = path.join(dossier, "lien.json");
      try {
        fs.symlinkSync(cible, lien, "file");
      } catch {
        t.skip("lien de fichier non créable sur ce système (droits Windows) : joué en conteneur par T-L24-b");
        return;
      }
      if (process.platform === "win32") {
        t.skip("O_NOFOLLOW absent sous Windows : joué en conteneur (scénario b5-lien)");
        return;
      }
      // Le lien mène à un état VALIDE qui ne bloque rien : le suivre laisserait passer les délégations.
      assert.deepEqual(garde.lireEtatGarde(lien), { etat: "invalide", raison: "lien" });
    });
  });
});

// --- Listes : mêmes que celles du cockpit ----------------------------------------------------------------------------------------

describe("filet : listes égales à celles du cockpit (croisements de V1 et V2)", () => {
  it("motifs de clés = KEY_FILE_READ_RULES (refusés sans « / », permis, avec « / »), extensions = EXTENSIONS_CLE_P03", () => {
    const regles = Object.entries(KEY_FILE_READ_RULES);
    assert.deepEqual([...garde.MOTIFS_CLE_REGLES], regles.filter(([m, a]) => a !== "allow" && !m.includes("/")).map(([m]) => m));
    assert.deepEqual([...garde.MOTIFS_CLE_PERMIS], regles.filter(([m, a]) => a === "allow").map(([m]) => m));
    assert.deepEqual([...garde.MOTIFS_CLE_CHEMIN], regles.filter(([m, a]) => a !== "allow" && m.includes("/")).map(([m]) => m));
    assert.deepEqual([...garde.EXTENSIONS_CLE_P03], [...EXTENSIONS_CLE_P03]);
    assert.deepEqual([...garde.MOTIFS_ENV], [".env*"]);
  });

  it("estNomCle ⊇ estFichierCle du pré-contrôle ; la seule différence est la famille « .env* » de la fiche L24", () => {
    const corpus = [
      ...garde.TEMOINS_CLE,
      ...garde.TEMOINS_ORDINAIRES,
      ".env-prod",
      ".env_ancien",
      ".environment",
      "a.env",
      "a.env.b",
      "A.ENV.EXAMPLE",
      "id_rsa",
      "mon_id_rsa_copie",
      "serveur.P12",
      "cle.PEM",
      "privkey",
      "kubeconfig.yaml",
      "config",
      "Makefile",
    ];
    const ecarts: string[] = [];
    for (const nom of corpus) {
      const precontrole = estFichierCle(nom);
      const filet = garde.estNomCle(nom);
      if (precontrole) assert.equal(filet, true, `${nom} : refusé par le pré-contrôle, permis par le filet`);
      if (filet && !precontrole) ecarts.push(nom);
    }
    assert.deepEqual(ecarts.sort(), [".env-prod", ".env_ancien", ".environment", ".envrc"]);
  });

  it("outils de délégation = OMO_GUARD_TOOLS ; chemin de l'état = volume de contrôle monté dans la salle + fichiersControle.garde", () => {
    assert.deepEqual([...garde.OUTILS_DELEGATION], [...OMO_GUARD_TOOLS]);
    const contrat = OMO_SALLE_CONTRACT_SCHEMA.parse(JSON.parse(fs.readFileSync(path.join(RACINE, OMO_SALLE_CONTRACT_FILE), "utf8")));
    const controle = contrat.volumes.find((v) => v.nom === "control-omo");
    const montage = controle?.montages.find((m) => m.service === "salle");
    assert.deepEqual(montage && { cible: montage.cible, mode: montage.mode }, { cible: "/control", mode: "ro" });
    assert.equal(garde.CHEMIN_ETAT_GARDE, `${montage?.cible}/${contrat.fichiersControle.garde}`);
    assert.equal(contrat.fichiersControle.garde, OMO_FICHIERS_CONTROLE.garde);
    // Le plugin est copié tel quel dans l'image, au chemin du contrat (Dockerfile de L15a), dans le périmètre du manifeste.
    assert.equal(path.posix.basename(contrat.cheminsImage.garde), path.basename(GARDE_JS));
    assert.ok(contrat.perimetreManifeste.includes(path.posix.dirname(contrat.cheminsImage.garde)));
  });
});

// --- Plugin tel qu'opencode 1.18.30 le charge ------------------------------------------------------------------------------------

describe("plugin : forme « v1 » d'opencode 1.18.30, crochet tool.execute.before", () => {
  it("export par défaut { id, server } (readV1Plugin, plugin chargé par file://), même objet que l'export nommé", async () => {
    const module = (await import(pathToFileURL(GARDE_JS).href)) as { default: unknown };
    assert.equal(module.default, garde.plugin);
    assert.equal(typeof garde.plugin.id, "string");
    assert.equal(garde.plugin.id.trim(), garde.ID_PLUGIN);
    assert.equal(typeof garde.plugin.server, "function");
    assert.equal("tui" in garde.plugin, false);
    assert.equal(Object.isFrozen(garde.plugin), true);
  });

  it("server({directory}) rend le seul crochet ; un refus est une erreur d'outil au message du filet, les arguments restent intacts", async () => {
    const crochets = await garde.plugin.server({ directory: PROJET });
    assert.deepEqual(Object.keys(crochets), ["tool.execute.before"]);
    const avant = crochets["tool.execute.before"];
    const args = { filePath: `${PROJET}/.env` };
    const copie = structuredClone(args);
    await assert.rejects(avant({ tool: "read", sessionID: "ses_x", callID: "c1" }, { args }), { message: message("cle", "read") });
    assert.deepEqual(args, copie);
    await assert.rejects(avant({ tool: "webfetch", sessionID: "ses_x", callID: "c2" }, { args: { url: "http://example.invalid" } }), {
      message: message("reseau", "webfetch"),
    });
    await avant({ tool: "todowrite", sessionID: "ses_x", callID: "c3" }, { args: { todos: [] } });
  });

  it("une erreur imprévue du filet refuse (fermé en cas de doute), sans rien laisser passer", () => {
    const g = garde.creerGarde({
      dossier: PROJET,
      reel: () => {
        throw new Error("panne du disque");
      },
    });
    assert.throws(() => g.avant({ tool: "read" }, { args: { filePath: "a.ts" } }), { message: message("doute", "read") });
    const lecteurEnPanne = garde.creerGarde({
      dossier: PROJET,
      lireEtat: () => {
        throw new Error("panne");
      },
    });
    assert.throws(() => lecteurEnPanne.avant({ tool: "task" }, { args: {} }), { message: message("doute", "task") });
    // Appel sans nom ni arguments : rien à vérifier, rien à refuser (le disque n'est même pas consulté).
    assert.doesNotThrow(() => g.avant(undefined, undefined));
  });

  it("chemin réel : liens résolus, suite à créer recollée au plus long préfixe existant", (t) => {
    const dossier = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "omo-l24-reel-"));
    try {
      const posixise = (c: string) => c.split(path.sep).join("/");
      if (process.platform === "win32") {
        t.skip("chemins POSIX du plugin : joué en conteneur (scénarios a5 et a6)");
        return;
      }
      fs.mkdirSync(path.join(dossier, "projet"));
      fs.mkdirSync(path.join(dossier, "dehors"));
      fs.symlinkSync("../dehors", path.join(dossier, "projet", "lien"));
      assert.equal(garde.cheminReel(posixise(path.join(dossier, "projet", "lien", "nouveau.txt"))), posixise(path.join(dossier, "dehors", "nouveau.txt")));
      assert.equal(garde.cheminReel(posixise(path.join(dossier, "projet", "a", "b"))), posixise(path.join(dossier, "projet", "a", "b")));
    } finally {
      fs.rmSync(dossier, { recursive: true, force: true });
    }
  });

  it("sans dépendance : seuls node:fs, node:os et node:path ; aucun appel réseau ; seule variable lue : XDG_DATA_HOME", () => {
    const source = fs.readFileSync(GARDE_JS, "utf8");
    const imports = [...source.matchAll(/^import\s.+?from\s+"([^"]+)";?$/gm)].map((m) => m[1]);
    assert.deepEqual(imports.sort(), ["node:fs", "node:os", "node:path"]);
    const code = source.replace(/^\s*(?:\/\/|\/?\*).*$/gm, "");
    assert.equal(/\bimport\s*\(|\brequire\s*\(|@opencode-ai\/plugin|fetch\s*\(|node:https?|node:net|child_process/.test(code), false);
    assert.deepEqual([...new Set([...source.matchAll(/process\.env\.([A-Z_]+)/g)].map((m) => m[1]))], ["XDG_DATA_HOME"]);
  });
});

// --- Vrais liens (Linux) ----------------------------------------------------------------------------------------------------------

const SAUT_LIENS = process.platform === "win32" ? "chemins POSIX du plugin et liens symboliques : joués sous Linux (conteneur, CI)" : false;

/**
 * Arborescence jetable : `projet` (projet ouvert) et `autre` (un autre projet préparé), liens RELATIFS comme ceux d'un dépôt ou
 * d'un « ln -s » accepté par le portillon ; filet réel (chemins réels du disque, aucun état de garde).
 */
function monterLiens(t: TestContext) {
  const racine = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "omo-l24-liens-"));
  t.after(() => fs.rmSync(racine, { recursive: true, force: true }));
  const projet = path.posix.join(racine, "projet");
  const autre = path.posix.join(racine, "autre");
  const poser = (chemin: string, contenu: string) => {
    fs.mkdirSync(path.posix.dirname(chemin), { recursive: true });
    fs.writeFileSync(chemin, contenu);
  };
  const lier = (cible: string, lien: string) => fs.symlinkSync(cible, path.posix.join(projet, lien));
  poser(path.posix.join(projet, "src", "code.ts"), "PROJET\n");
  poser(path.posix.join(autre, "src", "code.ts"), "AUTRE\n");
  fs.mkdirSync(path.posix.join(autre, "sous"));
  const g = garde.creerGarde({ dossier: projet, sortiesOutils: null, lireEtat: () => ({ etat: "absent" }) });
  const cat = (outil: string, args: unknown): CategorieRefus | null => g.decider(outil, args)?.categorie ?? null;
  return { projet, autre, poser, lier, cat };
}

describe("filet sur de vrais liens : chemin réel du système, fermé en cas de doute", { skip: SAUT_LIENS }, () => {
  it("lien de dossier vers l'extérieur puis « .. » : read, write et edit de <projet>/partage/../src/code.ts refusés ; lien vers / aussi", (t) => {
    const { projet, autre, lier, cat } = monterLiens(t);
    lier("../autre/sous", "partage");
    lier("/", "racine");
    const detour = `${projet}/partage/../src/code.ts`;
    // Le système suit le lien AVANT le « .. » : c'est le fichier de l'autre projet qui serait lu puis réécrit.
    assert.equal(fs.readFileSync(detour, "utf8"), "AUTRE\n");
    assert.equal(cat("read", { filePath: `${projet}/partage/x` }), "hors-projet", "témoin : le lien seul mène dehors");
    assert.equal(cat("read", { filePath: detour }), "doute");
    assert.equal(cat("write", { filePath: detour, content: "x" }), "doute");
    assert.equal(cat("edit", { filePath: detour, oldString: "AUTRE", newString: "x" }), "doute");
    assert.equal(cat("read", { filePath: `${projet}/racine/../etc/passwd` }), "doute");
    assert.equal(fs.readFileSync(path.posix.join(autre, "src", "code.ts"), "utf8"), "AUTRE\n");
    // Relatif : normalisé par opencode avant le système (path.join), donc le fichier du projet : permis.
    assert.equal(cat("read", { filePath: "partage/../src/code.ts" }), null);
  });

  it("lien dont la cible passe par un autre lien puis « .. » : chemin réel de la libc (realpath native), jamais celui, lexical, de fs.realpathSync", (t) => {
    const { projet, autre, poser, lier, cat } = monterLiens(t);
    lier("../autre/sous", "a");
    lier("a/../x", "lien");
    poser(path.posix.join(autre, "x"), "AUTRE-X\n");
    // Leurre : fs.realpathSync (JS) normalise « a/../x » avant de suivre « a », et croit lire <projet>/x.
    poser(path.posix.join(projet, "x"), "PROJET-X\n");
    assert.equal(fs.readFileSync(path.posix.join(projet, "lien"), "utf8"), "AUTRE-X\n", "le système lit le fichier de l'autre projet");
    assert.equal(garde.cheminReel(path.posix.join(projet, "lien")), path.posix.join(autre, "x"));
    assert.equal(cat("read", { filePath: "lien" }), "hors-projet");
    assert.equal(cat("write", { filePath: `${projet}/lien`, content: "x" }), "hors-projet");
  });

  it("lien PENDANT du projet : write, edit en création et apply_patch « *** Add File: » refusés ; lien existant vers l'extérieur : « hors-projet »", (t) => {
    const { projet, autre, poser, lier, cat } = monterLiens(t);
    lier("../autre/.vscode/tasks.json", "lien-pendant");
    lier("../autre/nouveau", "dossier-pendant");
    poser(path.posix.join(autre, "existant.txt"), "AUTRE\n");
    lier("../autre/existant.txt", "lien-existant");
    // Preuve sur ce système : écrire par un lien pendant crée le fichier au bout du lien, hors du projet.
    lier("../autre/preuve.txt", "preuve");
    fs.writeFileSync(path.posix.join(projet, "preuve"), "x");
    assert.equal(fs.existsSync(path.posix.join(autre, "preuve.txt")), true);

    assert.equal(garde.cheminReel(path.posix.join(projet, "lien-pendant")), null);
    assert.equal(garde.cheminReel(path.posix.join(projet, "dossier-pendant", "f.txt")), null);
    assert.equal(cat("write", { filePath: `${projet}/lien-pendant`, content: "{}" }), "doute");
    assert.equal(cat("write", { filePath: "lien-pendant", content: "{}" }), "doute");
    assert.equal(cat("edit", { filePath: "lien-pendant", oldString: "", newString: "{}" }), "doute");
    assert.equal(cat("apply_patch", { patchText: "*** Begin Patch\n*** Add File: lien-pendant\n+{}\n*** End Patch" }), "doute");
    assert.equal(cat("write", { filePath: "dossier-pendant/f.txt", content: "x" }), "doute");
    assert.equal(fs.existsSync(path.posix.join(autre, ".vscode")), false);
    // Témoins : lien existant vers l'extérieur refusé comme avant ; fichier à créer sous un vrai dossier du projet, permis.
    assert.equal(cat("write", { filePath: "lien-existant", content: "x" }), "hors-projet");
    assert.equal(cat("write", { filePath: "src/neuf/fichier.ts", content: "x" }), null);
  });
});

// --- Textes (T-L24-c) -----------------------------------------------------------------------------------------------------------

/** Règle « mot entier » du test « textes » (textes.test.ts) : ni lettre ni trait d'union avant, ni lettre après, casse ignorée. */
const LETTRE = "\\p{L}\\p{N}_";
const mot = (motif: string): RegExp => new RegExp(`(?<![${LETTRE}-])(?:${motif})(?![${LETTRE}])`, "iu");

/** Interdits partout et bannis (§2.2, §2.3), recopiés de textes.test.ts ; plus les mots interdits en mode Simple, par prudence. */
const INTERDITS = [
  "toujours\\s+autoriser",
  "jamais\\s+plus\\s+de",
  "sans\\s+risques?",
  "tout\\s+autoriser",
  "réussie?s?",
  "dossiers?\\s+transmis",
  "chefs?\\s+d['’]\\s*équipes?",
  "validations?",
  "mod[èe]les?(?!\\s+de\\s+réflexion)",
  "r[ée]fl[ée]chi(?:t|ssent)",
  "agents?",
  "sous-agents?",
  "sessions?",
  "prompts?",
  "jetons?",
  "tokens?",
  "workflows?",
  "permissions?",
  "boucles?",
  "validée?s?",
  "approuvée?s?",
].map(mot);

/** « bloque toujours » et ses variantes : le filet ne promet jamais de tout bloquer (spéc. l.1157). */
const PROMESSES = /bloqu\p{L}*\s+(?:tout\s+)?toujours|toujours\s+bloqu|bloqu\p{L}*\s+tout(?![\p{L}])/iu;

describe("textes du filet (T-L24-c)", () => {
  it("chaque message se présente comme un filet, ne porte que le gabarit {outil}, et aucun mot interdit", () => {
    const messages = Object.entries(garde.MESSAGES_FILET);
    assert.deepEqual(messages.map(([cle]) => cle).sort(), ["cle", "delegation", "doute", "etat-illisible", "hors-projet", "recherche", "reseau"]);
    for (const [cle, texte] of messages) {
      assert.match(texte, /^Filet du cockpit : /, cle);
      assert.deepEqual([...texte.matchAll(/\{[^}]*\}/g)].map((m) => m[0]), ["{outil}"], cle);
      assert.equal(PROMESSES.test(texte), false, `${cle} : promesse de blocage total`);
      for (const re of INTERDITS) assert.equal(re.test(texte), false, `${cle} : ${re.source}`);
    }
  });

  it("jamais « bloque toujours » : ni dans le plugin, ni dans ses déclarations, ni dans le banc", () => {
    for (const fichier of [GARDE_JS, GARDE_DTS, path.join(BANC, "run-guard.mjs"), path.join(BANC, "docker-compose.guard.yml"), path.join(BANC, "opencode.jsonc")]) {
      assert.equal(PROMESSES.test(fs.readFileSync(fichier, "utf8")), false, fichier);
    }
  });

  it("le plugin se dit filet, « jamais une frontière » (§4.2 l.612), dès son en-tête", () => {
    const entete = fs
      .readFileSync(GARDE_JS, "utf8")
      .split(/\r?\n/)
      .slice(0, 6)
      .map((ligne) => ligne.replace(/^\/\/\s?/, ""))
      .join(" ");
    assert.match(entete, /un FILET sous les outils de l'IA, jamais une frontière/);
  });
});

// --- Tests réels : opencode 1.18.30 sans extension (D-2b-44, Q1 (b)) -------------------------------------------------------------

const CONTENEUR_DEMANDE = process.env.OMO_TESTS_CONTENEUR === "1";
const PROJET_COMPOSE = "omo11-l24";
const IMAGES = ["omo11/opencode:omo11", "omo11/app:omo11"] as const;

interface Sortie {
  code: number;
  stdout: string;
  stderr: string;
}

function docker(args: string[], env: NodeJS.ProcessEnv = {}, timeoutMs = 120_000): Sortie {
  const res = spawnSync("docker", args, {
    encoding: "utf8",
    timeout: timeoutMs,
    // MSYS_NO_PATHCONV : sous Git Bash, les chemins du conteneur seraient réécrits en chemins Windows.
    env: { ...process.env, ...env, MSYS_NO_PATHCONV: "1" },
  });
  return { code: res.status ?? -1, stdout: res.stdout ?? "", stderr: res.stderr ?? "" };
}

function raisonDuSaut(): string | null {
  if (!CONTENEUR_DEMANDE) return "tests réels hors « npm test » : relancer avec OMO_TESTS_CONTENEUR=1 (D-2b-44)";
  if (docker(["version", "--format", "{{.Server.Version}}"], {}, 20_000).code !== 0) return "Docker n'est pas disponible sur ce poste";
  for (const image of IMAGES) {
    if (docker(["image", "inspect", image], {}, 20_000).code !== 0) {
      return `image ${image} absente : la construire depuis une archive git de la branche (build-images.sh de MX-OMO), puis relancer ; ce test ne construit ni ne télécharge rien`;
    }
  }
  return null;
}

const SAUT = raisonDuSaut();

interface ResultatScenario {
  nom: string;
  outil: string;
  envoi?: number;
  statut?: string | null;
  erreur?: string | null;
  sortie?: string | null;
  marquesVues?: Record<string, boolean>;
  enfants?: number;
  appelsIa?: number;
  echec?: string;
}

interface Rapport {
  opencode: string | null;
  scenarios: ResultatScenario[];
  erreur: string | null;
}

interface Banc {
  rapport: Rapport;
  journalOpencode: string;
}

/** Garde de nom : toute commande « down » vise un projet omo11-*, jamais la pile de l'utilisateur. */
function compose(dossier: string, args: string[], env: NodeJS.ProcessEnv, timeoutMs = 180_000): Sortie {
  assert.match(PROJET_COMPOSE, /^omo11-/);
  return docker(["compose", "-p", PROJET_COMPOSE, "-f", path.join(dossier, "compose.yml"), ...args], env, timeoutMs);
}

/** Restes du projet omo11-l24 (conteneurs, volumes, réseaux), cherchés par nom. */
function restes(): string[] {
  const lister = (args: string[]) => docker(args, {}, 30_000).stdout.split("\n").map((l) => l.trim()).filter(Boolean);
  return [
    ...lister(["ps", "-a", "--filter", `name=${PROJET_COMPOSE}`, "--format", "conteneur {{.Names}}"]),
    ...lister(["volume", "ls", "--filter", `name=${PROJET_COMPOSE}`, "--format", "volume {{.Name}}"]),
    ...lister(["network", "ls", "--filter", `name=${PROJET_COMPOSE}`, "--format", "réseau {{.Name}}"]),
  ];
}

/** Retire tout ce que le projet a créé, même après un pilote interrompu (conteneur « run » encore en vie). */
function nettoyer(dossier: string, env: NodeJS.ProcessEnv): void {
  const conteneurs = docker(["ps", "-aq", "--filter", `label=com.docker.compose.project=${PROJET_COMPOSE}`], {}, 30_000).stdout.split("\n").filter(Boolean);
  if (conteneurs.length > 0) docker(["rm", "-f", "-v", ...conteneurs], {}, 60_000);
  compose(dossier, ["down", "-v", "--remove-orphans", "--timeout", "5"], env, 120_000);
  for (const reste of restes()) {
    const [genre, nom] = reste.split(" ");
    if (genre === "volume" && nom?.startsWith(`${PROJET_COMPOSE}_`)) docker(["volume", "rm", "-f", nom], {}, 30_000);
    if (genre === "réseau" && nom?.startsWith(`${PROJET_COMPOSE}_`)) docker(["network", "rm", nom], {}, 30_000);
  }
}

/**
 * Un passage du banc, dans un dossier temporaire plat (Docker Desktop refuse un montage au 17e niveau de dossiers, MO-3) : copies
 * du compose, de la configuration, du pilote, du faux fournisseur et du plugin ; `.gitignore` dans chaque dossier de configuration
 * en lecture seule (mesuré : sans lui, opencode 1.18.30 échoue sur EROFS) ; mot de passe tiré ici, jamais écrit ni affiché.
 */
function jouerBanc({ filet, scenarios = [] }: { filet: boolean; scenarios?: string[] }): Banc {
  const dossier = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "omo-l24-banc-"));
  const motDePasse = crypto.randomBytes(24).toString("base64url");
  const env = { OPENCODE_SERVER_PASSWORD: motDePasse, BANC_SCENARIOS: scenarios.join(",") };
  const masquer = (texte: string) => texte.split(motDePasse).join("****");
  const copier = (source: string, cible: string) => {
    fs.mkdirSync(path.dirname(path.join(dossier, cible)), { recursive: true });
    fs.copyFileSync(source, path.join(dossier, cible));
  };
  try {
    copier(path.join(BANC, "docker-compose.guard.yml"), "compose.yml");
    copier(path.join(BANC, "run-guard.mjs"), "banc/run-guard.mjs");
    copier(path.join(RACINE, "e2e", "omo-banc", "lib", "faux-copilot.mjs"), "banc/faux-copilot.mjs");
    copier(GARDE_JS, "guard/cockpit-guard.js");
    const config = fs.readFileSync(path.join(BANC, "opencode.jsonc"), "utf8");
    const sansFilet = config.replace(/"plugin": \["file:\/\/\/opt\/omo-guard\/cockpit-guard\.js"\]/, '"plugin": []');
    assert.notEqual(sansFilet, config, "la ligne « plugin » de la configuration du banc a changé : adapter la contre-épreuve");
    fs.mkdirSync(path.join(dossier, "config"));
    fs.writeFileSync(path.join(dossier, "config", "opencode.jsonc"), filet ? config : sansFilet);
    fs.mkdirSync(path.join(dossier, "vide"));
    for (const d of ["config", "vide"]) fs.writeFileSync(path.join(dossier, d, ".gitignore"), "node_modules\n");

    nettoyer(dossier, env);
    const monte = compose(dossier, ["up", "-d", "opencode"], env);
    assert.equal(monte.code, 0, masquer(monte.stderr));
    const pilote = compose(dossier, ["run", "--rm", "-T", "--use-aliases", "banc"], env, 240_000);
    const ligne = pilote.stdout.split("\n").find((l) => l.startsWith("RAPPORT "));
    assert.ok(ligne, `pilote sans rapport (code ${pilote.code}) : ${masquer(pilote.stderr).slice(-1500)}`);
    const rapport = JSON.parse(masquer(ligne.slice("RAPPORT ".length))) as Rapport;
    const journaux = compose(dossier, ["logs", "--no-log-prefix", "opencode"], env, 60_000);
    return { rapport, journalOpencode: masquer(journaux.stdout + journaux.stderr) };
  } finally {
    nettoyer(dossier, env);
    fs.rmSync(dossier, { recursive: true, force: true });
  }
}

describe("filet sur opencode 1.18.30 réel, sans l'extension (T-L24-a, T-L24-b)", { skip: SAUT ?? false }, () => {
  let avec: Banc;
  let sans: Banc;
  const scenario = (banc: Banc, nom: string): ResultatScenario => {
    const trouve = banc.rapport.scenarios.find((s) => s.nom === nom);
    assert.ok(trouve, `scénario ${nom} absent du rapport`);
    assert.equal(trouve.echec, undefined, `${nom} : ${trouve.echec}`);
    return trouve;
  };
  const refuse = (banc: Banc, nom: string, cat: CategorieRefus, outil: string) => {
    const s = scenario(banc, nom);
    assert.equal(s.statut, "error", `${nom} : ${s.statut}`);
    assert.equal(s.erreur, message(cat, outil), nom);
    return s;
  };
  const passe = (banc: Banc, nom: string) => {
    const s = scenario(banc, nom);
    assert.equal(s.statut, "completed", `${nom} : ${s.statut} ${s.erreur ?? ""}`);
    return s;
  };

  before(() => {
    avec = jouerBanc({ filet: true });
    sans = jouerBanc({ filet: false, scenarios: ["a2-cle", "a3-env", "a5-lien-vers-cle", "a6-lien-dehors", "a7-hors-projet", "a9-grep-env", "b1-bloquer", "b3-invalide"] });
  });

  after(() => {
    assert.deepEqual(restes(), [], "projet omo11-l24 : ressources restantes");
  });

  it("opencode 1.18.30 réel, un seul plugin (le filet), aucune installation npm, aucun EROFS", () => {
    for (const banc of [avec, sans]) {
      assert.equal(banc.rapport.erreur, null);
      assert.equal(banc.rapport.opencode, "1.18.30");
      assert.doesNotMatch(banc.journalOpencode, /EROFS|dependency install|failed to load plugin|Failed to load plugin/i);
    }
    assert.equal(avec.rapport.scenarios.length, 15);
  });

  it("T-L24-a : read d'id_ed25519 par un appel d'outil scripté → erreur d'outil du filet, contenu jamais lu", () => {
    const s = refuse(avec, "a2-cle", "cle", "read");
    assert.equal(s.marquesVues?.cle, false);
    assert.equal(refuse(avec, "a3-env", "cle", "read").marquesVues?.env, false);
    assert.equal(passe(avec, "a4-env-example").marquesVues?.exemple, true);
    assert.equal(passe(avec, "a1-temoin").marquesVues?.ordinaire, true);
    assert.equal(refuse(avec, "a5-lien-vers-cle", "cle", "read").marquesVues?.cleDehors, false);
    assert.equal(refuse(avec, "a6-lien-dehors", "hors-projet", "read").marquesVues?.dehors, false);
    refuse(avec, "a7-hors-projet", "hors-projet", "read");
    refuse(avec, "a8-reseau", "reseau", "webfetch");
    // grep refusé en toutes circonstances (« recherche ») : ses règles ne voient que l'expression cherchée.
    assert.equal(refuse(avec, "a9-grep-env", "recherche", "grep").marquesVues?.env, false);
  });

  it("T-L24-b : task avec l'état « bloquer » → erreur ; absent → aucun blocage ; invalide, trop gros ou lien → blocage", () => {
    const bloque = refuse(avec, "b1-bloquer", "delegation", "task");
    assert.deepEqual([bloque.enfants, bloque.appelsIa], [0, 2]);
    const absent = passe(avec, "b2-absent");
    assert.deepEqual([absent.enfants, absent.appelsIa], [1, 3]);
    for (const nom of ["b3-invalide", "b4-trop-gros", "b5-lien"]) assert.equal(refuse(avec, nom, "etat-illisible", "task").enfants, 0, nom);
    assert.equal(passe(avec, "b6-rien-a-bloquer").enfants, 1);
  });

  it("contre-épreuve : sans le filet, la même configuration laisse tout passer (c'est bien le filet qui refuse)", () => {
    assert.equal(sans.rapport.scenarios.length, 8);
    for (const s of sans.rapport.scenarios) assert.doesNotMatch(s.erreur ?? "", /Filet du cockpit/, s.nom);
    assert.equal(passe(sans, "a2-cle").marquesVues?.cle, true);
    assert.equal(passe(sans, "a3-env").marquesVues?.env, true);
    assert.equal(passe(sans, "a5-lien-vers-cle").marquesVues?.cleDehors, true);
    assert.equal(passe(sans, "a6-lien-dehors").marquesVues?.dehors, true);
    passe(sans, "a7-hors-projet");
    assert.equal(passe(sans, "a9-grep-env").marquesVues?.env, true);
    assert.equal(passe(sans, "b1-bloquer").enfants, 1);
    assert.equal(passe(sans, "b3-invalide").enfants, 1);
  });
});
