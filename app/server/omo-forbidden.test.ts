// Interdits absolus de la Salle OMO (L22b ; spécification §4.14.3 l.827-832, §4.5 l.671, §4.1 l.583-588, §3.7 l.310, §9.4 n° 1
// l.1417, G7 l.1221 ; plan 2 bis et 2 ter §6 fiche L22b, D-2b-34, D-2b-09) : `shared/omo-forbidden.ts`, module PUR.
//
// Trois étages, tous dans `npm test`, sans conteneur, sans port, sans pause :
// 1. le corpus de la porte G7 (`test-support/fixtures/omo-forbidden-corpus.json`) rejoué cas par cas, avec l'analyse de secrets
//    de la fixture à chaque exécution ;
// 2. une garde par test : chaque interdit tombe sans sa règle (enveloppes, mots cités, enchaînements, options globales de git,
//    famille `.env*`, cibles de la configuration git relevées dans l'arbre de travail, projet ouvert inconnu) ;
// 3. les croisements de listes : les programmes S4 « réseau » et « production » de L8a, les noms de configuration et les
//    fichiers d'IDE et de CI de L23a, les témoins du filet de L24 (qui a ses propres listes, recopiées : ce module doit refuser
//    au moins tout ce que le filet refuse) et la pureté du module.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import * as garde from "../../docker/opencode-omo/guard/cockpit-guard.js";
import { OMO_CONFIG_NOMS, OMO_IDE_CI_NOMS } from "./shared/omo-detections.ts";
import { DOSSIER_ETAT_OMO, NOMS_CONFIG_EXTENSION, NOMS_CONFIG_OPENCODE, NOMS_DANS_OMO_REFUSES } from "./shared/omo-precheck-rules.ts";
import {
  categorieCommande,
  categorieEcritureDansProjet,
  cheminsEcriture,
  classifyOmoPermission,
  estCheminEnv,
  MOTIFS_ENV_PERMIS,
  MOTIFS_ENV_REFUSES,
  type OmoForbiddenContext,
  type OmoPermissionVerdict,
} from "./shared/omo-forbidden.ts";
import type { OmoForbiddenCategory } from "./shared/omo-types.ts";
import { SHELL_FORBIDDEN } from "./shared/shell-gate.ts";
import { leaks } from "./test-support/helpers.ts";

// --- Corpus ---------------------------------------------------------------------------------------------------------------------

interface CorpusCas {
  nom: string;
  demande: { permission: string; metadata: Record<string, unknown> };
  attendu: { verdict: "once" | "interdit"; categorie?: OmoForbiddenCategory };
  pourquoi: string;
}

interface Corpus {
  source: string;
  porte: string;
  nettoyage: string;
  projetOuvert: string;
  autreProjetPrepare: string;
  ideCiDynamiques: string[];
  notes: string[];
  cas: CorpusCas[];
}

const CORPUS_URL = new URL("./test-support/fixtures/omo-forbidden-corpus.json", import.meta.url);
const CORPUS_TEXT = fs.readFileSync(CORPUS_URL, "utf8");
const CORPUS = JSON.parse(CORPUS_TEXT) as Corpus;

const CTX: OmoForbiddenContext = { projetOuvert: CORPUS.projetOuvert, ideCiDynamiques: CORPUS.ideCiDynamiques };

/** Toutes les catégories du contrat (T3a) ; l'exhaustivité est vérifiée par le type ci-dessous. */
const TOUTES_CATEGORIES = [
  "fichier-cle",
  "env",
  "production",
  "reseau",
  "git-envoi",
  "git-options-globales",
  "hors-projet",
  "config-extension",
  "ide-ci",
  "git-interne",
  "web",
] as const satisfies readonly OmoForbiddenCategory[];

/** Échoue à la compilation si le contrat gagne une catégorie que ce test ne connaît pas. */
type CategorieOubliee = Exclude<OmoForbiddenCategory, (typeof TOUTES_CATEGORIES)[number]>;
const AUCUNE_CATEGORIE_OUBLIEE: CategorieOubliee extends never ? true : false = true;

const bash = (command: string): OmoPermissionVerdict => classifyOmoPermission({ permission: "bash", metadata: { command } }, CTX);
const ecrire = (filepath: string, ctx: OmoForbiddenContext = CTX): OmoPermissionVerdict => classifyOmoPermission({ permission: "edit", metadata: { filepath } }, ctx);
const refus = (categorie: OmoForbiddenCategory): OmoPermissionVerdict => ({ verdict: "interdit", categorie });
const ONCE: OmoPermissionVerdict = { verdict: "once" };

describe("corpus G7 : interdits absolus de la salle", () => {
  it("chaque cas du corpus rend le verdict attendu", () => {
    assert.ok(CORPUS.cas.length >= 40, `corpus trop court : ${CORPUS.cas.length}`);
    assert.equal(new Set(CORPUS.cas.map((cas) => cas.nom)).size, CORPUS.cas.length, "noms de cas en double");
    for (const cas of CORPUS.cas) {
      const verdictAttendu: OmoPermissionVerdict = cas.attendu.verdict === "once" ? ONCE : refus(cas.attendu.categorie as OmoForbiddenCategory);
      assert.deepEqual(classifyOmoPermission(cas.demande, CTX), verdictAttendu, `${cas.nom} (${cas.pourquoi})`);
    }
  });

  it("le corpus couvre chaque catégorie du contrat, et chaque cas est bien formé", () => {
    for (const cas of CORPUS.cas) {
      assert.ok(typeof cas.pourquoi === "string" && cas.pourquoi.length > 0, cas.nom);
      assert.equal(cas.attendu.verdict === "interdit", cas.attendu.categorie !== undefined, cas.nom);
      if (cas.attendu.categorie !== undefined) assert.ok((TOUTES_CATEGORIES as readonly string[]).includes(cas.attendu.categorie), cas.nom);
    }
    const vues = new Set(CORPUS.cas.map((cas) => cas.attendu.categorie).filter((categorie) => categorie !== undefined));
    assert.deepEqual([...TOUTES_CATEGORIES].filter((categorie) => !vues.has(categorie)), [], "catégories sans cas de corpus");
    assert.ok(CORPUS.cas.some((cas) => cas.attendu.verdict === "once"), "aucun témoin autorisé");
    assert.equal(AUCUNE_CATEGORIE_OUBLIEE, true);
  });

  it("analyse de secrets : la fixture ne porte aucun secret, aucune adresse, aucun chemin d'hôte", () => {
    assert.deepEqual(leaks(CORPUS_TEXT), []);
    for (const cas of CORPUS.cas) assert.deepEqual(leaks(JSON.stringify(cas)), [], cas.nom);
    assert.match(CORPUS.nettoyage, /Aucun secret/);
    assert.equal(CORPUS.porte, "G7");
  });
});

describe("commandes : ce que la salle refuse, et rien de plus (décision n° 7)", () => {
  it("S4 « réseau » et « production » seulement : les interpréteurs, les tests et les scripts passent", () => {
    for (const programme of ["curl", "wget", "ssh", "openssl", "gh"]) assert.deepEqual(bash(`${programme} quelque-chose`), refus("reseau"), programme);
    for (const programme of ["kubectl", "helm", "terraform", "docker", "psql"]) assert.deepEqual(bash(`${programme} quelque-chose`), refus("production"), programme);
    for (const commande of ["npm test", "pytest -q", "make", "python script.py", "node outils/build.js", "sh outils/lance.sh", "rm fichier-temporaire"]) {
      assert.deepEqual(bash(commande), ONCE, commande);
    }
  });

  it("une enveloppe ne cache pas le programme qu'elle lance", () => {
    for (const commande of ["env FOO=1 curl adresse", "sudo docker ps", "timeout 5 kubectl get pods", "xargs -I fichier curl adresse", "nohup wget adresse"]) {
      assert.equal(classifyOmoPermission({ permission: "bash", metadata: { command: commande } }, CTX).verdict, "interdit", commande);
    }
    // Sans enveloppe, un argument reste un argument : aucun faux refus sur une tâche au nom trompeur.
    for (const commande of ["npm run docker", "make deploy-kubectl", "python outils/curl.py"]) assert.deepEqual(bash(commande), ONCE, commande);
  });

  it("le contenu d'un mot cité est découpé à son tour", () => {
    assert.deepEqual(bash("sh -c 'curl adresse'"), refus("reseau"));
    assert.deepEqual(bash("bash -c 'git push origin main'"), refus("git-envoi"));
    // Un mot cité qui ne commence pas par un programme interdit passe : c'est un argument, pas une commande.
    assert.deepEqual(bash("git commit -m 'passage a docker'"), ONCE);
  });

  it("une commande que la porte de L8a ne découpe pas est analysée par fragments", () => {
    assert.deepEqual(bash("npm run build && docker compose up -d"), refus("production"));
    assert.deepEqual(bash("echo ok | git push"), refus("git-envoi"));
    assert.deepEqual(bash("npm test | tee sortie.txt"), ONCE);
    // Caractère hors ASCII : la porte refuse le découpage, l'analyse par fragments prend le relais.
    assert.deepEqual(bash("echo clé && curl adresse"), refus("reseau"));
  });

  it("git : envoi et options globales refusés, consultation et travail local permis", () => {
    for (const commande of ["git push", "git push origin main", "git remote -v", "git remote add miroir depot"]) {
      assert.deepEqual(bash(commande), refus("git-envoi"), commande);
    }
    for (const commande of ["git -c core.pager=cat log", "git -C autre status", "git --git-dir=autre/.git log", "git --exec-path=outils status", "git -C/ailleurs log"]) {
      assert.deepEqual(bash(commande), refus("git-options-globales"), commande);
    }
    for (const commande of ["git status", "git log --oneline", "git add fichier.ts", "git commit -m message", "git diff --stat"]) {
      assert.deepEqual(bash(commande), ONCE, commande);
    }
  });

  it("chemins sensibles P03 : clés, dossiers sensibles et .env* refusés à la commande", () => {
    assert.deepEqual(bash("cat .ssh/id_ed25519"), refus("fichier-cle"));
    assert.deepEqual(bash("wc -l secrets/mot-de-passe"), refus("fichier-cle"));
    assert.deepEqual(bash("cat .opencode/opencode.json"), refus("config-extension"));
    assert.deepEqual(bash("ls .git/hooks"), refus("git-interne"));
    assert.deepEqual(bash("cat .env"), refus("env"));
    assert.deepEqual(bash("cat .env.example"), ONCE);
  });

  it("commande absente, vide ou mal typée : refus (fermé en cas de doute)", () => {
    assert.deepEqual(classifyOmoPermission({ permission: "bash", metadata: {} }, CTX), refus("hors-projet"));
    assert.deepEqual(classifyOmoPermission({ permission: "bash", metadata: { command: "" } }, CTX), refus("hors-projet"));
    assert.deepEqual(classifyOmoPermission({ permission: "bash", metadata: { command: 12 } }, CTX), refus("hors-projet"));
  });
});

describe("écritures : projet ouvert, configuration, IDE et CI, clés", () => {
  it("hors du projet ouvert, un autre projet préparé compris (D-2b-09)", () => {
    assert.deepEqual(ecrire(`${CORPUS.autreProjetPrepare}/src/y.ts`), refus("hors-projet"));
    assert.deepEqual(ecrire("/workspace/projet/../autre-projet/src/y.ts"), refus("hors-projet"));
    assert.deepEqual(ecrire("/tmp/essai.txt"), refus("hors-projet"));
    assert.deepEqual(ecrire("/workspace/projet/src/y.ts"), ONCE);
    // Chemin relatif : il part du projet ouvert.
    assert.deepEqual(ecrire("src/y.ts"), ONCE);
    assert.deepEqual(ecrire("../autre-projet/src/y.ts"), refus("hors-projet"));
  });

  it("projet ouvert inconnu ou relatif : plus rien ne passe", () => {
    for (const projetOuvert of ["", "projet", "./projet"]) {
      assert.deepEqual(ecrire("/workspace/projet/src/y.ts", { projetOuvert }), refus("hors-projet"), projetOuvert);
    }
  });

  it("demande d'écriture sans chemin lisible : refus", () => {
    assert.deepEqual(classifyOmoPermission({ permission: "edit", metadata: {} }, CTX), refus("hors-projet"));
    assert.deepEqual(classifyOmoPermission({ permission: "edit", metadata: { filepath: 7 } }, CTX), refus("hors-projet"));
    assert.deepEqual(classifyOmoPermission({ permission: "edit", metadata: { files: [{ type: "add" }] } }, CTX), refus("hors-projet"));
  });

  it("tout fichier d'un correctif est contrôlé, cible d'un déplacement comprise (MX1)", () => {
    const patch = (files: unknown[]) => classifyOmoPermission({ permission: "edit", metadata: { filepath: "src/a.ts", files } }, CTX);
    assert.deepEqual(patch([{ filePath: "/workspace/projet/src/a.ts" }, { filePath: "/workspace/projet/src/b.ts" }]), ONCE);
    assert.deepEqual(patch([{ filePath: "/workspace/projet/src/a.ts" }, { filePath: "/workspace/projet/.git/config" }]), refus("git-interne"));
    assert.deepEqual(patch([{ filePath: "/workspace/projet/src/a.ts", movePath: `${CORPUS.autreProjetPrepare}/a.ts` }]), refus("hors-projet"));
    // `relativePath` sert seulement quand `filePath` manque ; il part du projet ouvert.
    assert.deepEqual(patch([{ relativePath: ".vscode/tasks.json" }]), refus("ide-ci"));
    // Liste de fichiers jointe par « , » dans `filepath` (correctif multiple sans `files`).
    assert.deepEqual(classifyOmoPermission({ permission: "edit", metadata: { filepath: "src/a.ts, .env" } }, CTX), refus("env"));
    assert.deepEqual(cheminsEcriture({ filepath: "src/a.ts, src/b.ts" }), ["src/a.ts", "src/b.ts"]);
  });

  it("configuration de l'extension et d'opencode (liste du pré-contrôle, dont .agents/)", () => {
    for (const relatif of [".omo/omo.jsonc", ".omo/omo.json", "oh-my-openagent.json", ".sisyphus/etat.json", ".agents/skills/x/SKILL.md", "opencode.jsonc", ".opencode/agent/a.md", ".claude/settings.json", ".mcp.json"]) {
      assert.deepEqual(ecrire(`/workspace/projet/${relatif}`), refus("config-extension"), relatif);
    }
    // L'extension écrit son propre état dans .omo : lui seul passe (§9.3 n° 11).
    for (const relatif of [".omo/boulder.json", ".omo/plans/p1.md", ".omo/notepads/n1.md"]) assert.deepEqual(ecrire(`/workspace/projet/${relatif}`), ONCE, relatif);
  });

  it("fichiers d'IDE et de CI : liste fixe et cibles de la configuration git relevées dans l'arbre de travail", () => {
    for (const relatif of [".vscode/tasks.json", ".idea/workspace.xml", ".devcontainer/devcontainer.json", ".github/workflows/build.yml", ".gitlab-ci.yml", ".husky/pre-commit", ".pre-commit-config.yaml", "Jenkinsfile", "azure-pipelines-nuit.yml"]) {
      assert.deepEqual(ecrire(`/workspace/projet/${relatif}`), refus("ide-ci"), relatif);
    }
    // Relecture 2bis-vague-0 : core.hooksPath, core.fsmonitor et les fichiers inclus sont traités comme de l'IDE et de la CI.
    assert.deepEqual(ecrire("/workspace/projet/.githooks/pre-commit"), refus("ide-ci"));
    assert.deepEqual(ecrire("/workspace/projet/outils/hooks/post-checkout"), refus("ide-ci"));
    // Sans la cible relevée, le même fichier passe : c'est bien la liste dynamique qui refuse.
    assert.deepEqual(ecrire("/workspace/projet/.githooks/pre-commit", { projetOuvert: CORPUS.projetOuvert }), ONCE);
    assert.deepEqual(categorieEcritureDansProjet("outils/hooks/post-checkout"), null);
  });

  it(".git est en lecture seule, quelle que soit sa place ou sa casse", () => {
    for (const relatif of [".git/hooks/pre-commit", ".git/config", "sous-module/.git/config", ".GIT/hooks/pre-commit"]) {
      assert.deepEqual(ecrire(`/workspace/projet/${relatif}`), refus("git-interne"), relatif);
    }
    assert.deepEqual(ecrire("/workspace/projet/.gitignore"), ONCE);
  });

  it("fichiers de clés refusés, noms qui leur ressemblent permis à l'écriture", () => {
    for (const relatif of ["deploiement/id_ed25519", "certificats/serveur.key", "coffre.kdbx", "infra/terraform.tfstate", ".ssh/config", "auth.json"]) {
      assert.deepEqual(ecrire(`/workspace/projet/${relatif}`), refus("fichier-cle"), relatif);
    }
    for (const relatif of ["src/token-parser.ts", "docs/secrets.md", "src/password-form.tsx", "src/credentials.test.ts"]) {
      assert.deepEqual(ecrire(`/workspace/projet/${relatif}`), ONCE, relatif);
    }
  });
});

describe("famille .env* (reste L24 n° 3 : liste tranchée ici)", () => {
  it("refusés : .env* sur chaque segment, *.env et *.env.* sur le nom", () => {
    for (const chemin of [".env", ".env.local", ".env.production", ".envrc", ".env-prod", "config/.env", ".env.d/valeurs", "prod.env", "prod.env.local", ".env.example.bak"]) {
      assert.equal(estCheminEnv(chemin), true, chemin);
      assert.deepEqual(ecrire(`/workspace/projet/${chemin}`), refus("env"), chemin);
      assert.deepEqual(bash(`cat ${chemin}`), refus("env"), chemin);
    }
  });

  it("permis : .env.example et *.env.example, en lecture comme en écriture (§9.4 n° 1)", () => {
    for (const chemin of [".env.example", "config/.env.example", "service.env.example"]) {
      assert.equal(estCheminEnv(chemin), false, chemin);
      assert.deepEqual(ecrire(`/workspace/projet/${chemin}`), ONCE, chemin);
      assert.deepEqual(bash(`cat ${chemin}`), ONCE, chemin);
    }
    assert.deepEqual([...MOTIFS_ENV_REFUSES], [".env*", "*.env", "*.env.*"]);
    assert.deepEqual([...MOTIFS_ENV_PERMIS], [".env.example", "*.env.example"]);
  });

  it("plus large que le filet de L24 : ses motifs ne valent que pour le dernier segment", () => {
    // Le filet ne voit qu'un nom d'entrée ; ce module voit le chemin entier.
    assert.equal(garde.estCheminCle("config/.env.d/valeurs.txt"), false);
    assert.deepEqual(ecrire("/workspace/projet/config/.env.d/valeurs.txt"), refus("env"));
    // Sur un nom, les deux disent la même chose.
    for (const nom of [".env", ".env.local", ".envrc", "prod.env", "prod.env.local", ".env.example.bak"]) {
      assert.equal(garde.estNomCle(nom), true, nom);
      assert.equal(estCheminEnv(nom), true, nom);
    }
    for (const nom of [".env.example", "service.env.example"]) {
      assert.equal(garde.estNomCle(nom), false, nom);
      assert.equal(estCheminEnv(nom), false, nom);
    }
  });
});

describe("web et sortie du dossier (décision du 19/09 n° 7)", () => {
  it("external_directory, webfetch et websearch sont refusés, quelles que soient leurs métadonnées", () => {
    assert.deepEqual(classifyOmoPermission({ permission: "external_directory", metadata: {} }, CTX), refus("hors-projet"));
    assert.deepEqual(classifyOmoPermission({ permission: "webfetch", metadata: { url: "adresse" } }, CTX), refus("web"));
    assert.deepEqual(classifyOmoPermission({ permission: "websearch", metadata: {} }, CTX), refus("web"));
    assert.deepEqual(classifyOmoPermission({ permission: "WebFetch", metadata: {} }, CTX), refus("web"));
  });

  it("une demande sans interdit passe : lecture, délégation, permission inconnue", () => {
    for (const permission of ["read", "task", "glob", "grep", "list", "question", "doom_loop", ""]) {
      assert.deepEqual(classifyOmoPermission({ permission, metadata: { filePath: "/ailleurs/cle.pem" } }, CTX), ONCE, permission);
    }
    // Entrée hors contrat : aucun plantage, verdict « once » (le répondeur ne fabrique pas de refus à partir de rien).
    assert.deepEqual(classifyOmoPermission({ permission: null as unknown as string, metadata: null as unknown as Record<string, unknown> }, CTX), ONCE);
  });
});

// --- Décision A18 (23/09) : trois failles du portillon, arbitrage 3 juges × 3 angles, mesurées sur 89385da ----------------------

describe("A18 n° 1 : un correctif de plus de 256 fichiers n'est jamais tronqué en silence", () => {
  const PROJET = "/workspace/projet";
  const CTX_256: OmoForbiddenContext = { projetOuvert: PROJET, ideCiDynamiques: ["outils/hooks"] };
  const anodins = (n: number) => Array.from({ length: n }, (_, i) => `src/f${i}.ts`);
  /** Forme MX1 META-PMULTI d'opencode 1.18.30 : `filepath` joint par « , » et `files[]`. */
  const correctif = (relatifs: readonly string[], forme: "complete" | "relatif" = "complete") => ({
    permission: "edit",
    metadata: {
      filepath: relatifs.join(", "),
      files: relatifs.map((rel) => (forme === "complete" ? { filePath: `${PROJET}/${rel}`, relativePath: rel, type: "add" } : { relativePath: rel, type: "add" })),
    },
  });
  const CIBLES: readonly [string, OmoForbiddenCategory][] = [
    [".git/hooks/pre-commit", "git-interne"],
    [".GIT/hooks/pre-commit", "git-interne"],
    [".husky/pre-commit", "ide-ci"],
    [".vscode/tasks.json", "ide-ci"],
    [".github/workflows/ci.yml", "ide-ci"],
    ["outils/hooks/pre-commit", "ide-ci"],
    ["opencode.jsonc", "config-extension"],
    ["packages/web/opencode.jsonc", "config-extension"],
    [".claude/settings.json", "config-extension"],
    [".agents/skills/x/SKILL.md", "config-extension"],
    [".env", "env"],
    ["id_ed25519", "fichier-cle"],
    ["../autre-projet/src/x.ts", "hors-projet"],
  ];

  it("témoins : la cible seule, puis en 256e et dernière position, est refusée par sa catégorie", () => {
    for (const [cible, categorie] of CIBLES) {
      assert.deepEqual(classifyOmoPermission(correctif([cible]), CTX_256), refus(categorie), cible);
      assert.deepEqual(classifyOmoPermission(correctif([...anodins(255), cible]), CTX_256), refus(categorie), `255 + ${cible}`);
    }
  });

  it("une cible placée APRÈS le 256e fichier est refusée, formes complète et relative", () => {
    for (const [cible] of CIBLES) {
      for (const n of [256, 257, 1000]) {
        assert.equal(classifyOmoPermission(correctif([...anodins(n), cible]), CTX_256).verdict, "interdit", `${n} + ${cible}`);
        assert.equal(classifyOmoPermission(correctif([...anodins(n), cible], "relatif"), CTX_256).verdict, "interdit", `${n} + ${cible} (relativePath)`);
      }
    }
    // Les entrées en double comptent aussi : 256 fois le même fichier, puis la cible.
    const doubles = correctif([...Array.from({ length: 256 }, () => "src/a.ts"), ".git/hooks/pre-commit"]);
    assert.equal(classifyOmoPermission(doubles, CTX_256).verdict, "interdit");
  });

  it("la cible d'un déplacement placé après le 256e fichier est refusée", () => {
    const demande = correctif(anodins(256));
    (demande.metadata.files as Record<string, unknown>[]).push({ filePath: `${PROJET}/src/x.ts`, relativePath: "src/x.ts", movePath: `${PROJET}/.git/hooks/pre-commit`, type: "move" });
    assert.equal(classifyOmoPermission(demande, CTX_256).verdict, "interdit");
  });

  it("au-delà de 256 fichiers : refus EN BLOC « hors-projet », même tout anodin ; 256 fichiers anodins passent", () => {
    assert.deepEqual(classifyOmoPermission(correctif(anodins(257)), CTX_256), refus("hors-projet"));
    assert.deepEqual(classifyOmoPermission(correctif(anodins(257), "relatif"), CTX_256), refus("hors-projet"));
    assert.deepEqual(classifyOmoPermission(correctif([...anodins(256), ".git/hooks/pre-commit"]), CTX_256), refus("hors-projet"));
    assert.deepEqual(classifyOmoPermission(correctif(anodins(256)), CTX_256), ONCE);
    assert.deepEqual(classifyOmoPermission(correctif(anodins(256), "relatif"), CTX_256), ONCE);
    assert.equal(cheminsEcriture(correctif(anodins(257)).metadata), null);
  });

  it("une entrée de files[] illisible n'est jamais sautée : la demande entière est refusée", () => {
    const avec = (entree: unknown) => ({ permission: "edit", metadata: { filepath: "src/a.ts", files: [{ filePath: `${PROJET}/src/a.ts`, relativePath: "src/a.ts" }, entree] } });
    const illisibles: unknown[] = [null, {}, "src/b.ts", { type: "add" }, { filePath: 7 }, { filePath: "" }, { relativePath: `./${"a/".repeat(2100)}.git/hooks/pre-commit` }, { filePath: `${PROJET}/src/b.ts`, movePath: null }];
    for (const entree of illisibles) assert.deepEqual(classifyOmoPermission(avec(entree), CTX_256), refus("hors-projet"), JSON.stringify(entree).slice(0, 80));
    // `files` présent sans être une liste : illisible aussi.
    assert.deepEqual(classifyOmoPermission({ permission: "edit", metadata: { filepath: "src/a.ts", files: "src/a.ts" } }, CTX_256), refus("hors-projet"));
    // Témoin : une entrée complète de plus passe.
    assert.deepEqual(classifyOmoPermission(avec({ filePath: `${PROJET}/src/b.ts`, relativePath: "src/b.ts", type: "add" }), CTX_256), ONCE);
  });
});

describe("A18 n° 2 : une citation au milieu d'un mot ne cache jamais un nom interdit (le texte complet fait foi, §4.5)", () => {
  it("les morceaux cités d'un même mot sont recollés comme le fait le shell", () => {
    const attendus: readonly [string, OmoForbiddenCategory][] = [
      ['cat .e"nv"', "env"],
      ["cat .e'nv'", "env"],
      ["cat .''env", "env"],
      ['cat .e""nv', "env"],
      ["cat .e''nv", "env"],
      ['cat ./.e"nv"', "env"],
      ['cp .e"nv" /tmp/vol.txt', "env"],
      ['echo CLE=x > .e"nv"', "env"],
      [String.raw`cat .e\nv`, "env"],
      [String.raw`cat .en\v`, "env"],
      [String.raw`cat .\env`, "env"],
      ['cat deploiement/id_ed2"5"519', "fichier-cle"],
      ['echo x > .g"it"/hooks/pre-commit', "git-interne"],
      ["cp outils/h .gi't'/hooks/pre-commit", "git-interne"],
      ["g'i't push", "git-envoi"],
      ['gi"t" push', "git-envoi"],
      ['git p"u"sh', "git-envoi"],
      ['sh -c "git push"', "git-envoi"],
      ["P=push; git $P", "git-envoi"],
      ['git "$SOUS_COMMANDE" origin', "git-envoi"],
      ["cu'r'l adresse", "reseau"],
      ['cu"r"l adresse', "reseau"],
      ['bash -c "curl adresse"', "reseau"],
      ['kube"ctl" get pods', "production"],
    ];
    for (const [commande, categorie] of attendus) assert.deepEqual(bash(commande), refus(categorie), commande);
  });

  it("propriété : une citation, où qu'elle coupe le mot, ne change jamais le verdict d'un chemin refusé", () => {
    const temoins = [".env", ".env.local", "config/.env", "prod.env", ".ssh/id_ed25519", "cle.pem", "auth.json", ".netrc", ".git/config"];
    for (const temoin of temoins) {
      const attendu = bash(`cat ${temoin}`);
      assert.equal(attendu.verdict, "interdit", temoin);
      for (let i = 0; i <= temoin.length; i++) {
        const avant = temoin.slice(0, i);
        const apres = temoin.slice(i);
        for (const commande of [`cat ${avant}""${apres}`, `cat ${avant}''${apres}`, `cat ${avant}"${apres}"`, `cat ${avant}'${apres}'`]) {
          assert.deepEqual(bash(commande), attendu, commande);
        }
      }
    }
  });

  it("non-régression : les commandes ordinaires, citées ou non, passent toujours", () => {
    for (const commande of [
      "npm test | tee sortie.txt",
      'git commit -m "passage a docker"',
      "git commit -m 'passage a docker'",
      'echo "ok" && npm test',
      "echo $HOME && npm test",
      "for f in src/*.ts; do wc -l $f; done",
      'git log --format="%h $x" -n 3',
      "python outils/curl.py",
      "npm run docker",
      "cat .env.example",
      'cat ".env.example"',
      'cat .e"nv".example',
      "export PATH=$PATH:/x; npm test",
    ]) {
      assert.deepEqual(bash(commande), ONCE, commande);
    }
  });
});

describe("A18 n° 3 : un métacaractère de shell ne fait jamais tomber la catégorie « nom » de P03", () => {
  const TEMOINS_NOM = ["credentials.json", "./credentials.json", ".credentials.json", "config/client_secret.json", "db-secrets.txt", "passwords.md", "mon-token.txt", "id_dsa", "deploy/id_dsa", "/workspace/autre-projet/credentials.json"];
  const HABILLAGES: readonly ((t: string) => string)[] = [
    (t) => `cat ${t} | head`,
    (t) => `cat ${t} && echo ok`,
    (t) => `cat ${t} > /tmp/x`,
    (t) => `cat ${t} 2>/dev/null`,
    (t) => `cat ${t}; true`,
    (t) => `cat "${t}"`,
    (t) => `sh -c 'cat ${t} docs/a.md'`,
  ];

  it("le verdict d'un fragment est celui de la commande seule (repli par fragments, l.284)", () => {
    for (const temoin of TEMOINS_NOM) {
      assert.deepEqual(bash(`cat ${temoin}`), refus("fichier-cle"), `cat ${temoin}`);
      for (const habiller of HABILLAGES) assert.deepEqual(bash(habiller(temoin)), refus("fichier-cle"), habiller(temoin));
    }
  });

  it("mot cité réévalué par sh -c : même règle (contenu cité, l.288)", () => {
    assert.deepEqual(bash("sh -c 'cat credentials.json > /tmp/x'"), refus("fichier-cle"));
    assert.deepEqual(bash("sh -c 'cat db-secrets.txt | tr a b > out/y'"), refus("fichier-cle"));
    assert.deepEqual(bash("bash -c 'cat secrets.yaml > out/x.txt'"), refus("fichier-cle"));
  });

  it("témoins inchangés : clés et .env derrière un tube, commandes ordinaires avec un tube", () => {
    for (const temoin of ["id_ed25519", "auth.json", "cle.pem", "secrets/x", ".netrc"]) assert.deepEqual(bash(`cat ${temoin} | head`), refus("fichier-cle"), temoin);
    assert.deepEqual(bash("cat .env | head"), refus("env"));
    assert.deepEqual(bash("echo x > .git/hooks/pre-commit"), refus("git-interne"));
    for (const commande of ["npm test | tee sortie.txt", "npm run build && npm test", "git log --oneline | head -20", "cat src/index.ts | head", "echo ok | git status"]) {
      assert.deepEqual(bash(commande), ONCE, commande);
    }
  });
});

describe("croisements de listes (train de V2)", () => {
  it("tout programme S4 « réseau » ou « production » de L8a est refusé, les autres catégories passent", () => {
    for (const categorie of ["reseau", "production"] as const) {
      for (const entree of SHELL_FORBIDDEN[categorie]) {
        const programme = entree.endsWith("*") ? `${entree.slice(0, -1)}x` : entree;
        assert.deepEqual(bash(`${programme} argument`), refus(categorie), `${categorie} : ${programme}`);
      }
    }
    for (const categorie of ["code", "enveloppes", "suppression", "editeurs", "declarations"] as const) {
      for (const entree of SHELL_FORBIDDEN[categorie]) {
        if (entree.endsWith("*") || entree === ".") continue;
        // Seul le programme compte : les enveloppes font examiner la suite, d'où un argument neutre.
        assert.deepEqual(bash(`${entree} fichier`), ONCE, `${categorie} : ${entree}`);
      }
    }
  });

  it("liste de configuration : L19a (source de ce module) et L23a (détections) disent exactement la même chose", () => {
    const deL19a = [...NOMS_CONFIG_EXTENSION, ...NOMS_CONFIG_OPENCODE, ...NOMS_DANS_OMO_REFUSES.map((nom) => `${DOSSIER_ETAT_OMO}/${nom}`)]
      .map((nom) => nom.toLowerCase())
      .sort();
    const deL23a = OMO_CONFIG_NOMS.map((nom) => nom.toLowerCase()).sort();
    assert.deepEqual(deL19a, deL23a, "les deux listes ont divergé : à trancher au train de V2");
  });

  it("tout nom de configuration et tout fichier d'IDE ou de CI de L23a est refusé à l'écriture", () => {
    for (const nom of OMO_CONFIG_NOMS) assert.deepEqual(ecrire(`/workspace/projet/${nom}`), refus("config-extension"), nom);
    for (const nom of OMO_IDE_CI_NOMS) {
      assert.deepEqual(ecrire(`/workspace/projet/${nom}`), refus("ide-ci"), nom);
      assert.deepEqual(ecrire(`/workspace/projet/${nom}/dedans.txt`), refus("ide-ci"), `${nom}/dedans.txt`);
    }
  });

  it("les témoins du filet de L24 : ce module refuse au moins tout ce que le filet refuse", () => {
    for (const nom of garde.TEMOINS_CLE) {
      assert.equal(garde.estNomCle(nom), true, `filet : ${nom}`);
      assert.deepEqual(ecrire(`/workspace/projet/src/${nom}`), refus(estCheminEnv(nom) ? "env" : "fichier-cle"), nom);
      assert.equal(categorieCommande(`cat src/${nom}`) !== null, true, nom);
    }
    for (const nom of garde.TEMOINS_ORDINAIRES) {
      assert.equal(garde.estNomCle(nom), false, `filet : ${nom}`);
      assert.deepEqual(ecrire(`/workspace/projet/src/${nom}`), ONCE, nom);
    }
  });
});

describe("module partagé : pureté de shared/omo-forbidden.ts", () => {
  it("ni « node: », ni accès au système, ni horloge, ni aléa ; imports limités aux modules purs voisins", () => {
    const source = fs.readFileSync(path.join(import.meta.dirname, "shared", "omo-forbidden.ts"), "utf8");
    assert.equal(source.includes('"node:'), false, "module node:");
    assert.equal(/\bprocess\./.test(source), false, "process");
    assert.equal(/\brequire\s*\(/.test(source), false, "require");
    assert.equal(/\bDate\b|\bMath\.random\b|\bperformance\./.test(source), false, "horloge ou aléa");
    const imports = [...source.matchAll(/\bfrom\s*["']([^"']+)["']/g)].map((m) => m[1] ?? "").sort();
    assert.deepEqual(imports, ["./omo-detections.ts", "./omo-precheck-rules.ts", "./omo-types.ts", "./shell-gate.ts"]);
  });

  it("aucun effet de bord : deux appels identiques donnent le même verdict, et le contexte n'est jamais modifié", () => {
    const ctx: OmoForbiddenContext = { projetOuvert: "/workspace/projet", ideCiDynamiques: [".githooks"] };
    const avant = JSON.stringify(ctx);
    const demande = { permission: "bash", metadata: { command: "git push" } };
    const premier = classifyOmoPermission(demande, ctx);
    assert.deepEqual(premier, classifyOmoPermission(demande, ctx));
    assert.deepEqual(premier, refus("git-envoi"));
    assert.equal(JSON.stringify(ctx), avant);
    assert.deepEqual(demande, { permission: "bash", metadata: { command: "git push" } });
  });
});
