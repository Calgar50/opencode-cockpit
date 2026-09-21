// Tests de croisement du train de V0 de la Salle OMO (plan d'exécution 2 bis-2 ter §2.3, §5.2 ; propriété de l'intégrateur) :
// T3a (contrats), L22a (plafond saisi), L23a (détections), L19a (pré-contrôle), L16a (egress), L17a (superviseur et protocole),
// L20 (audit de la 4.19.4), L21a (faux fournisseur), et le report de MX-OMO (MO-5, MO-9).
// Ce que la vague doit prouver ensemble, et qu'aucun paquet ne peut prouver seul :
//   1. les unions propres aux modules purs égalent celles de T3a, au type ET à l'exécution ; stop-request porte toutes les raisons
//      de relance de T3a, « fin-de-demande » comprise ;
//   2. chaque code de chaque module a sa phrase dans omo-room-texts.ts ;
//   3. homme mort : mêmes délais dans le cockpit et dans l'image, borne calculée (27 s) sous les « 30 secondes » écrites ;
//   4. chemins, fichiers, volumes, propriétaires et options de sécurité de supervisor-lib.mjs = contrat-salle.json ;
//   5. noms de configuration : pré-contrôle (L19a) = détections (L23a) = contrat (T3a) ;
//   6. règle de la détection 4 retenue au train d'après MO-5 ;
//   7. faux fournisseur : tool_calls pour chaque outil de l'audit, 429 jusqu'au seuil de la détection 8 ;
//   8. tous les modules installés : la salle reste absente (aucune route, aucun import de production).
// Aucun conteneur, aucune pause fixe, aucun fetch (node:http seulement, ports 0).
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { describe, it, type TestContext } from "node:test";
import * as salle from "../../docker/opencode-omo/supervisor-lib.mjs";
import { EGRESS_JOURNAL_DOSSIER_DEFAUT } from "./egress-journal.ts";
import { EGRESS_PORT_ECOUTE } from "./egress-proxy.ts";
import {
  EGRESS_REFUSAL_REASONS,
  OMO_ACTIVATION_REFUSAL_CODES,
  OMO_DETECTION_CAUSES,
  OMO_PRECHECK_REASONS,
  OMO_SALLE_CONTRACT_FILE,
  OMO_SALLE_CONTRACT_SCHEMA,
  OMO_STOP_CAUSES,
} from "./omo-contracts.ts";
import { EGRESS_REFUSAL_REASONS as RAISONS_EGRESS, type EgressRefusalReason as RaisonEgress } from "./shared/egress-allow.ts";
import { enumerations } from "./shared/omo-audit-4.19.4.ts";
import { OMO_CAP_REFUSAL_CODES, type OmoCapRefusalCode, proposePlafond, validatePlafond } from "./shared/omo-cap.ts";
import {
  analyserArret,
  analyserPrecheckOk,
  borneHommeMort,
  ecrireArret,
  ecrirePrecheckOk,
  OMO_ARRET_CAUSES,
  OMO_BORNE_HOMME_MORT_MAX_S,
  OMO_DELAIS,
  OMO_FICHIER_ETAT,
  OMO_FICHIER_PROJETS,
  OMO_FICHIERS_CONTROLE,
  type OmoArretCause,
  type OmoGitForme,
  type OmoGuardState as GardeProtocole,
  type OmoGuardTool as OutilProtocole,
  type OmoPrecheckOkProjet,
  type OmoSupervisorPhase as PhaseProtocole,
  type OmoSupervisorState as EtatProtocole,
  type OmoWorkspaceGit as WorkspaceProtocole,
} from "./shared/omo-control-protocol.ts";
import {
  detect,
  etatInitial,
  OMO_CONFIG_NOMS,
  OMO_DETECTION_CAUSES as CAUSES_DETECTIONS,
  OMO_REGLE_PERMISSION,
  OMO_TENTATIVES_429_MAX,
  type OmoDetectionCause as CauseDetections,
  type OmoDetectionState,
  type OmoPermissionRule,
  type OmoReglePermission,
  type OmoSignale as SignaleDetections,
} from "./shared/omo-detections.ts";
import { OMO_LIMITES } from "./shared/omo-limits.ts";
import {
  DOSSIER_ETAT_OMO,
  NOMS_CONFIG_EXTENSION,
  NOMS_CONFIG_OPENCODE,
  NOMS_DANS_OMO_REFUSES,
  OMO_PRECHECK_REASONS as RAISONS_PRECONTROLE,
  type OmoPrecheckReason as RaisonPrecontrole,
} from "./shared/omo-precheck-rules.ts";
import { libelleSortieRefusee, phraseArret, phraseDetection, phrasePrecontrole, phraseRefusActivation, TEXTES } from "./shared/omo-room-texts.ts";
import type {
  EgressRefusalReason,
  OmoActivationRefusalCode,
  OmoDetectionCause,
  OmoGitForm,
  OmoGuardState,
  OmoGuardTool,
  OmoPrecheckOkProject,
  OmoPrecheckReason,
  OmoPreparedProjects,
  OmoRecreationRaison,
  OmoSalleContract,
  OmoSignale,
  OmoSupervisorPhase,
  OmoSupervisorState,
  OmoWorkspaceGit,
} from "./shared/omo-types.ts";
import { startCockpit } from "./test-support/cockpit-harness.ts";
import { until } from "./test-support/helpers.ts";

const RACINE = path.join(import.meta.dirname, "..", "..");

/** Contrat machine lu ET validé par son schéma : une forme fausse fait échouer tout le fichier, pas un test au hasard. */
const CONTRAT: OmoSalleContract = OMO_SALLE_CONTRACT_SCHEMA.parse(JSON.parse(fs.readFileSync(path.join(RACINE, OMO_SALLE_CONTRACT_FILE), "utf8")));

/** Vrai au typecheck si A et B sont le même type, dans les deux sens ; sinon `memeType<A, B>(true)` ne compile pas. */
type Egal<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
const memeType = <A, B>(preuve: Egal<A, B>): boolean => preuve;

// --- 1. Unions ---------------------------------------------------------------------------------------------------------------------

describe("croisements 2bis V0 : unions de T3a = codes des modules purs", () => {
  it("au type : chaque union propre à un module égale celle de T3a (le typecheck échoue sinon)", () => {
    const preuves = [
      memeType<CauseDetections, OmoDetectionCause>(true),
      memeType<SignaleDetections, OmoSignale>(true),
      memeType<RaisonPrecontrole, OmoPrecheckReason>(true),
      memeType<RaisonEgress, EgressRefusalReason>(true),
      // stop-request : les causes d'arrêt de T3a plus « fin-de-demande » (requestStop du port de contrôle, D-2b-29).
      memeType<OmoArretCause, OmoRecreationRaison>(true),
      memeType<OmoGitForme, OmoGitForm>(true),
      memeType<OutilProtocole, OmoGuardTool>(true),
      memeType<GardeProtocole, OmoGuardState>(true),
      memeType<WorkspaceProtocole, OmoWorkspaceGit>(true),
      memeType<PhaseProtocole, OmoSupervisorPhase>(true),
      memeType<EtatProtocole, OmoSupervisorState>(true),
      memeType<OmoPrecheckOkProjet, OmoPrecheckOkProject>(true),
      memeType<salle.ProjetsPrepares, OmoPreparedProjects>(true),
      // Les refus du plafond saisi (L22a) sont des refus d'activation de T3a.
      memeType<Extract<OmoActivationRefusalCode, OmoCapRefusalCode>, OmoCapRefusalCode>(true),
    ];
    assert.equal(preuves.every(Boolean), true);
  });

  it("à l'exécution : mêmes listes, dans le même ordre", () => {
    assert.deepEqual([...CAUSES_DETECTIONS], [...OMO_DETECTION_CAUSES]);
    assert.deepEqual([...RAISONS_PRECONTROLE], [...OMO_PRECHECK_REASONS]);
    assert.ok(RAISONS_PRECONTROLE.includes("empreinte-impossible"));
    assert.deepEqual([...RAISONS_EGRESS], [...EGRESS_REFUSAL_REASONS]);
    assert.deepEqual([...OMO_ARRET_CAUSES], [...OMO_STOP_CAUSES, "fin-de-demande"]);
    const refus: readonly string[] = OMO_ACTIVATION_REFUSAL_CODES;
    for (const code of OMO_CAP_REFUSAL_CODES) assert.ok(refus.includes(code), code);
    assert.equal(OMO_TENTATIVES_429_MAX, OMO_LIMITES.tentatives429Max);
  });

  it("stop-request : chaque raison de relance de T3a écrite par le cockpit est relue telle quelle, côté cockpit et côté salle", () => {
    const at = 1_757_000_000_000;
    const startId = "3f2a1c88-9d4e-4b6a-8f01-2c7d5e9a4b13";
    const raisons: readonly OmoRecreationRaison[] = [...OMO_STOP_CAUSES, "fin-de-demande"];
    for (const raison of raisons) {
      const texte = ecrireArret(at, raison, startId);
      assert.deepEqual(analyserArret(texte), { at, cause: raison, startId }, `cockpit : ${raison}`);
      assert.deepEqual(salle.analyserArret(texte), { at, cause: raison, startId }, `salle : ${raison}`);
    }
  });

  it("omo-projets.json au format de T3a lu par le superviseur ; precheck-ok de T3a lu à l'identique des deux côtés", () => {
    const projets: OmoPreparedProjects = {
      version: 1,
      genereLe: "2026-09-19T10:00:00.000Z",
      projets: [
        { chemin: "app", git: "dossier" },
        { chemin: "docs", git: "absent" },
      ],
      gitProteges: [
        { chemin: "app/.git", forme: "dossier" },
        { chemin: "lib/.git", forme: "fichier" },
      ],
    };
    assert.deepEqual(salle.analyserProjetsPrepares(JSON.stringify(projets)), projets);
    const empreintes: OmoPrecheckOkProject[] = [{ chemin: "app", sha256: "a".repeat(64) }];
    const texte = ecrirePrecheckOk("3f2a1c88-9d4e-4b6a-8f01-2c7d5e9a4b13", 1_757_000_000_000, empreintes);
    const cote = analyserPrecheckOk(texte);
    assert.deepEqual(cote?.projets, empreintes);
    assert.deepEqual(salle.analyserPrecheckOk(texte), cote);
  });
});

// --- 2. Phrases --------------------------------------------------------------------------------------------------------------------

describe("croisements 2bis V0 : chaque code des modules a sa phrase (omo-room-texts.ts)", () => {
  const phrase = (quoi: string, texte: string): void => {
    assert.equal(typeof texte, "string", quoi);
    assert.ok(texte.trim().length > 0, `${quoi} : phrase vide`);
  };

  it("plafond (L22a), détections (L23a), pré-contrôle (L19a), sorties refusées (L16a), arrêts (L17a)", () => {
    for (const code of OMO_CAP_REFUSAL_CODES) phrase(`plafond ${code}`, phraseRefusActivation(code));
    for (const cause of CAUSES_DETECTIONS) phrase(`détection ${cause}`, phraseDetection(cause));
    for (const raison of RAISONS_PRECONTROLE) phrase(`pré-contrôle ${raison}`, phrasePrecontrole(raison));
    for (const raison of RAISONS_EGRESS) phrase(`sortie refusée ${raison}`, libelleSortieRefusee(raison));
    for (const cause of OMO_ARRET_CAUSES) {
      // La fin de demande n'est pas un arrêt affiché : c'est la relance à neuf, dite par omo.recreation.
      if (cause === "fin-de-demande") phrase("relance à neuf", TEXTES.avance.recreation.relancee);
      else phrase(`arrêt ${cause}`, phraseArret(cause));
    }
  });

  it("aucune valeur de plafond par défaut : champ vide la première fois, saisie vide refusée avec sa phrase", () => {
    assert.deepEqual(proposePlafond(null, 50), { valeur: "", horsBornes: false });
    const vide = validatePlafond("", { plafondMaxUsd: 50, guardRuns: "ok" });
    assert.deepEqual(vide, { ok: false, code: "plafond-vide" });
    if (!vide.ok) phrase("plafond vide", phraseRefusActivation(vide.code));
  });
});

// --- 3. Homme mort -----------------------------------------------------------------------------------------------------------------

describe("croisements 2bis V0 : homme mort (D-2b-25)", () => {
  it("mêmes délais dans le cockpit et dans l'image ; borne calculée 27 s, sous les « 30 secondes » écrites", () => {
    assert.deepEqual({ ...salle.OMO_DELAIS }, { ...OMO_DELAIS });
    assert.equal(borneHommeMort(OMO_DELAIS), 27);
    assert.equal(salle.borneHommeMort(salle.OMO_DELAIS), 27);
    assert.equal(salle.OMO_BORNE_HOMME_MORT_MAX_S, OMO_BORNE_HOMME_MORT_MAX_S);
    const promis = [TEXTES.avance.honnetete.hommeMort, TEXTES.avance.activation.arreter].map((texte) => {
      const trouve = /(\d+) secondes au plus/u.exec(texte);
      assert.ok(trouve, texte);
      return Number(trouve[1]);
    });
    assert.deepEqual(promis, [OMO_BORNE_HOMME_MORT_MAX_S, OMO_BORNE_HOMME_MORT_MAX_S]);
    assert.ok(borneHommeMort(OMO_DELAIS) <= OMO_BORNE_HOMME_MORT_MAX_S);
    // Un battement en retard n'arrête rien : il faut en manquer plusieurs d'affilée.
    assert.ok(OMO_DELAIS.perimeS >= 3 * OMO_DELAIS.battementS);
  });
});

// --- 4. Contrat machine ------------------------------------------------------------------------------------------------------------

/** Point de montage d'un volume du contrat dans la salle. */
function montageSalle(nom: string): string {
  const volume = CONTRAT.volumes.find((v) => v.nom === nom);
  const montage = volume?.montages.find((m) => m.service === "salle");
  assert.ok(montage, `${nom} : aucun montage dans la salle`);
  return montage.cible;
}

/** Chaînes littérales d'un tableau `const <nom> = [ … ];` dans un fichier source, dans l'ordre. */
function tableauDuSource(fichier: string, nom: string): string[] {
  const source = fs.readFileSync(fichier, "utf8");
  const debut = source.indexOf(`const ${nom} = [`);
  assert.ok(debut >= 0, `${nom} introuvable dans ${path.basename(fichier)}`);
  const fin = source.indexOf("];", debut);
  return [...source.slice(debut, fin).matchAll(/"([^"]*)"/gu)].map((m) => m[1] ?? "");
}

describe("croisements 2bis V0 : supervisor-lib.mjs et le cockpit = contrat-salle.json", () => {
  it("chemins de l'image, périmètre du manifeste et dossiers de configuration du HOME : les mêmes, rôle par rôle", () => {
    for (const [role, chemin] of Object.entries(CONTRAT.cheminsImage)) {
      assert.equal(salle.CHEMINS[role as keyof typeof salle.CHEMINS], chemin, role);
    }
    // L'identifiant d'image (L15a) est lu par défaut au chemin du contrat, jamais recomposé ailleurs.
    const lib = fs.readFileSync(path.join(RACINE, "docker", "opencode-omo", "supervisor-lib.mjs"), "utf8");
    assert.match(lib, /export function lireImageId\(chemin = CHEMINS\.imageId\)/u);
    assert.equal(lib.includes('"image-id"'), false, "aucun autre chemin d'identifiant d'image");
    assert.deepEqual([...salle.PERIMETRE_MANIFESTE], CONTRAT.perimetreManifeste);
    assert.deepEqual([...salle.DOSSIERS_CONFIG_HOME], CONTRAT.dossiersConfigHome);
  });

  it("points de montage des volumes et des tmpfs dans la salle", () => {
    assert.equal(salle.CHEMINS.controle, montageSalle("control-omo"));
    assert.equal(salle.CHEMINS.authSource, montageSalle("omo-auth"));
    assert.equal(salle.CHEMINS.etat, montageSalle("omo-state"));
    assert.equal(salle.CHEMINS.donnees, montageSalle("oc-omo-data"));
    // Train de V1 (D-2b-33 révisée) : omo-config, en écriture sur /omo-config pour le superviseur, en lecture seule sur les cinq dossiers.
    const config = CONTRAT.volumes.find((v) => v.nom === "omo-config");
    assert.equal(salle.CHEMINS.configHome, montageSalle("omo-config"));
    assert.deepEqual(
      config?.montages.filter((m) => m.mode === "ro").map((m) => m.cible),
      CONTRAT.dossiersConfigHome,
    );
    assert.deepEqual(CONTRAT.securite.tmpfs.map((entree) => entree.split(":")[0]).sort(), [salle.CHEMINS.home, salle.CHEMINS.tmp].sort());
  });

  it("propriétaires (MO-11) : chaque volume monté dans la salle est vérifié par le superviseur, avec le propriétaire du contrat", () => {
    const uid = (proprietaire: "root" | "node"): number => (proprietaire === "root" ? 0 : salle.UID_NODE);
    const attendus = CONTRAT.volumes
      .filter((v) => v.montages.some((m) => m.service === "salle"))
      .map((v) => ({ volume: v.nom, chemin: montageSalle(v.nom), uid: uid(v.proprietaire) }));
    assert.deepEqual(salle.VOLUMES_SALLE, attendus);
    // Fermés à node : montés en lecture seule dans la salle, ou appartenant à root (G9, M32). Les cinq dossiers du HOME sont jugés à
    // part (DOSSIERS_CONFIG_HOME, même test -w en tant que node).
    const fermes = CONTRAT.volumes
      .flatMap((v) => v.montages.filter((m) => m.service === "salle" && (m.mode === "ro" || v.proprietaire === "root")).map((m) => m.cible))
      .filter((cible) => !CONTRAT.dossiersConfigHome.includes(cible));
    assert.deepEqual([...salle.VOLUMES_FERMES_A_NODE].sort(), fermes.sort());
    // Le contrat dit « node », le superviseur compare un nombre : 1000, l'utilisateur node de l'image officielle, et le tmpfs du HOME
    // lui est donné (MO-4 : sans uid ni gid, /home/node repart à root).
    assert.equal(salle.UID_NODE, 1000);
    const home = CONTRAT.securite.tmpfs.find((entree) => entree.startsWith(`${salle.CHEMINS.home}:`)) ?? "";
    assert.deepEqual(home.split(":")[1]?.split(",").sort(), ["exec", `gid=${salle.UID_NODE}`, "mode=0755", `uid=${salle.UID_NODE}`]);
  });

  it("fichiers de contrôle, projets préparés et état : mêmes noms dans le contrat, le cockpit et l'image", () => {
    const { projets, ...controle } = CONTRAT.fichiersControle;
    assert.deepEqual({ ...OMO_FICHIERS_CONTROLE }, controle);
    assert.deepEqual({ ...salle.FICHIERS_CONTROLE }, controle);
    assert.equal(OMO_FICHIER_PROJETS, projets);
    assert.equal(salle.FICHIER_PROJETS, projets);
    assert.equal(OMO_FICHIER_ETAT, CONTRAT.etat);
    assert.equal(salle.FICHIER_ETAT, CONTRAT.etat);
  });

  it("egress (L16a) : port d'écoute et dossier du journal du contrat", () => {
    assert.equal(EGRESS_PORT_ECOUTE, CONTRAT.egress.port);
    const journal = CONTRAT.volumes.find((v) => v.nom === "egress-log");
    assert.equal(journal?.ecrivain, "egress");
    assert.deepEqual(
      journal?.montages.map((m) => m.cible),
      [EGRESS_JOURNAL_DOSSIER_DEFAUT, EGRESS_JOURNAL_DOSSIER_DEFAUT],
    );
    assert.ok(CONTRAT.variables.cockpit.includes("COCKPIT_EGRESS_JOURNAL"));
  });

  // Train de V2 : le conteneur de L17a joue désormais les options RÉELLES du service `opencode-omo` de docker-compose.yml
  // (L16b), et non plus celles du seul contrat. La seule différence entre les deux est le tmpfs d'état du HOME (MO-3 point 8),
  // que le compose ajoute et que `omo-compose.test.ts` nomme explicitement ; le reste doit rester identique au contrat.
  it("conteneur de L17a (OMO_TESTS_CONTENEUR=1) : les options de sécurité jouées sont celles du compose, dans l'ordre", () => {
    const joue = tableauDuSource(path.join(import.meta.dirname, "omo-supervisor.test.ts"), "SECURITE");
    const s = CONTRAT.securite;
    const composeSource = fs.readFileSync(path.join(import.meta.dirname, "..", "..", "docker-compose.yml"), "utf8");
    const lignes = composeSource.split("\n");
    const debut = lignes.indexOf("  opencode-omo:");
    assert.ok(debut > 0, "service opencode-omo introuvable dans docker-compose.yml");
    const suite = lignes.findIndex((l, i) => i > debut && /^ {0,2}\S/.test(l));
    const bloc = lignes.slice(debut, suite === -1 ? lignes.length : suite).join("\n");
    const tmpfsCompose = [...bloc.matchAll(/^ {6}- "([^"]+)"$/gm)].map((m) => m[1] as string).filter((v) => v.startsWith("/"));
    // Le compose part du contrat et n'ajoute que le tmpfs d'état.
    assert.deepEqual(tmpfsCompose.slice(0, s.tmpfs.length), s.tmpfs);
    assert.deepEqual(tmpfsCompose.slice(s.tmpfs.length), ["/home/node/.local/state:exec,mode=0755,uid=1000,gid=1000"]);
    const attendu = [
      ...s.cap_drop.flatMap((c) => ["--cap-drop", c]),
      ...s.cap_add.flatMap((c) => ["--cap-add", c]),
      ...s.security_opt.flatMap((o) => ["--security-opt", o]),
      ...(s.read_only ? ["--read-only"] : []),
      ...tmpfsCompose.flatMap((t) => ["--tmpfs", t]),
    ];
    assert.deepEqual(joue, attendu);
  });
});

// --- 5. Noms de configuration --------------------------------------------------------------------------------------------------

describe("croisements 2bis V0 : noms de configuration", () => {
  it("pré-contrôle (L19a) = détections (L23a) = contrat (T3a), casse ignorée, .agents compris", () => {
    const bas = (noms: readonly string[]): string[] => [...new Set(noms.map((nom) => nom.toLowerCase()))].sort();
    const contrat = bas([...CONTRAT.nomsPrecontrole.fichiers, ...CONTRAT.nomsPrecontrole.dossiers]);
    const precontrole = bas([...NOMS_CONFIG_EXTENSION, ...NOMS_CONFIG_OPENCODE, ...NOMS_DANS_OMO_REFUSES.map((nom) => `${DOSSIER_ETAT_OMO}/${nom}`)]);
    assert.deepEqual(precontrole, contrat);
    assert.deepEqual(bas(OMO_CONFIG_NOMS), contrat);
    assert.ok(contrat.includes(".agents"));
  });
});

// --- 6. Détection 4 (MO-5) -----------------------------------------------------------------------------------------------------

describe("croisements 2bis V0 : règle de la détection 4 retenue d'après MO-5", () => {
  const regle = (permission: string, action: string): OmoPermissionRule => ({ permission, pattern: "*", action });
  const apres = (avant: OmoPermissionRule[], ensuite: OmoPermissionRule[], variante?: OmoReglePermission): string | null => {
    const etat: OmoDetectionState = etatInitial();
    const lu = detect(
      etat,
      { type: "session.updated", sessionId: "ses_racine", rootId: "ses_racine", permissionAvant: avant, permissionApres: ensuite },
      variante === undefined ? {} : { reglePermission: variante },
    );
    return lu.detection?.cause ?? null;
  };

  it("« toute-modification » : les trois transitions mesurées par MO-5 arrêtent, le repli en laisserait passer deux", () => {
    assert.equal(OMO_REGLE_PERMISSION, "toute-modification");
    // MO-5 c2 : tools {bash:false} → la liste devient [bash deny].
    const c2 = [regle("bash", "deny")];
    // MO-5 c3 : tools {bash:true, write:false, edit:false} → liste REMPLACÉE en entier : bash allow (élévation), write et edit deny.
    const c3 = [regle("bash", "allow"), regle("write", "deny"), regle("edit", "deny")];
    assert.equal(apres([], c2), "permission-modifiee");
    assert.equal(apres(c2, c3), "permission-modifiee");
    assert.equal(apres(c3, []), "permission-modifiee", "règles effacées : seule la différence les voit");
    assert.equal(apres(c3, c3), null);
    // Le repli « ajout d'un allow ou d'un ask » voit l'élévation, mais ni le refus posé, ni l'effacement.
    assert.equal(apres(c2, c3, "ajout-allow-ou-ask"), "permission-modifiee");
    assert.equal(apres([], c2, "ajout-allow-ou-ask"), null);
    assert.equal(apres(c3, [], "ajout-allow-ou-ask"), null);
  });
});

// --- 7. Faux fournisseur (L21a) ------------------------------------------------------------------------------------------------

const FAUX = path.join(RACINE, "e2e", "omo-banc", "lib", "faux-copilot.mjs");

/** Outils d'opencode que le banc scripte aussi (réponses d'IA synthétiques), en plus de ceux de l'extension relevés par L20. */
const OUTILS_OPENCODE = ["read", "list", "glob", "grep", "bash", "edit", "write", "task"];

interface Reponse {
  statut: number;
  entetes: http.IncomingHttpHeaders;
  corps: string;
}

/** Requête HTTP locale par node:http (jamais fetch : aucun port refusé par fetch ne peut faire échouer ce test). */
function requete(port: number, methode: string, chemin: string, corps?: unknown): Promise<Reponse> {
  return new Promise((resolve, reject) => {
    const texte = corps === undefined ? undefined : JSON.stringify(corps);
    const entetes: Record<string, string> = texte === undefined ? {} : { "content-type": "application/json", "content-length": String(Buffer.byteLength(texte)) };
    const req = http.request({ host: "127.0.0.1", port, path: chemin, method: methode, headers: entetes, agent: false }, (res) => {
      const morceaux: Buffer[] = [];
      res.on("data", (morceau: Buffer) => morceaux.push(morceau));
      res.on("end", () => resolve({ statut: res.statusCode ?? 0, entetes: res.headers, corps: Buffer.concat(morceaux).toString("utf8") }));
      res.on("error", reject);
    });
    req.on("error", reject);
    req.end(texte);
  });
}

/** Lance le faux en processus enfant (ports 0), attend sa ligne d'annonce, et l'arrête à la fin du test quoi qu'il arrive. */
async function lancerFaux(t: TestContext): Promise<{ api: number; pilote: number }> {
  const enfant = spawn(process.execPath, [FAUX, "--http", "--port", "0", "--pilot-port", "0"], { stdio: ["ignore", "pipe", "pipe"] });
  let code: number | null = null;
  const fin = new Promise<number>((resolve) => {
    enfant.once("close", (sortie) => {
      code = sortie ?? -1;
      resolve(code);
    });
  });
  t.after(async () => {
    if (code === null) enfant.kill();
    await fin;
  });
  let sortie = "";
  let erreurs = "";
  enfant.stdout.setEncoding("utf8");
  enfant.stdout.on("data", (bout: string) => {
    sortie += bout;
  });
  enfant.stderr.setEncoding("utf8");
  enfant.stderr.on("data", (bout: string) => {
    erreurs += bout;
  });
  const annonce = await until(() => {
    if (code !== null) throw new Error(`faux-copilot arrêté (code ${code}) : ${erreurs.slice(0, 300)}`);
    for (const ligne of sortie.split("\n")) {
      if (!ligne.startsWith("{")) continue;
      const lue = JSON.parse(ligne) as { pret?: boolean; api?: { port: number }; pilote?: { port: number } };
      if (lue.pret === true && lue.api !== undefined && lue.pilote !== undefined) return { api: lue.api.port, pilote: lue.pilote.port };
    }
    return undefined;
  }, 10_000);
  return annonce;
}

interface AppelOutil {
  id: string;
  type: string;
  function: { name: string; arguments: string };
}

describe("croisements 2bis V0 : faux fournisseur (L21a)", () => {
  it("sert en tool_calls chaque outil de l'audit 4.19.4 et d'opencode, puis 429 jusqu'au seuil de la détection 8 (L23a)", async (t) => {
    const faux = await lancerFaux(t);
    const appel = { model: "faux-m1", messages: [{ role: "user", content: "Croisement V0." }] };

    const outils = [...new Set([...enumerations().outils, ...OUTILS_OPENCODE])];
    assert.ok(outils.includes("call_omo_agent") && outils.includes("skill_mcp") && outils.includes("task"));
    // Vingt appels d'outils au plus par réponse : par paquets.
    for (let i = 0; i < outils.length; i += 20) {
      const paquet = outils.slice(i, i + 20);
      const pilote = await requete(faux.pilote, "POST", "/reponses", { reponses: [{ outils: paquet.map((nom) => ({ nom, arguments: {} })) }] });
      assert.equal(pilote.statut, 200, pilote.corps);
      const rep = await requete(faux.api, "POST", "/v1/chat/completions", appel);
      assert.equal(rep.statut, 200, rep.corps);
      const choix = (JSON.parse(rep.corps) as { choices: { finish_reason: string; message: { tool_calls: AppelOutil[] } }[] }).choices[0];
      assert.ok(choix, rep.corps);
      assert.equal(choix.finish_reason, "tool_calls");
      assert.deepEqual(
        choix.message.tool_calls.map((a) => a.function.name),
        paquet,
      );
      for (const a of choix.message.tool_calls) {
        assert.equal(a.type, "function");
        assert.deepEqual(JSON.parse(a.function.arguments), {});
      }
      assert.equal(new Set(choix.message.tool_calls.map((a) => a.id)).size, paquet.length, "identifiants d'appel distincts");
    }

    // Autant de 429 que le seuil de la détection 8, puis un succès : opencode publie une nouvelle tentative à chaque 429.
    const seuil = OMO_LIMITES.tentatives429Max;
    const pilote = await requete(faux.pilote, "POST", "/reponses", {
      reponses: [...Array.from({ length: seuil }, () => ({ statut: 429, retryAfter: 1 })), { texte: "Enfin." }],
    });
    assert.equal(pilote.statut, 200, pilote.corps);
    let etat = etatInitial();
    let cause: string | null = null;
    for (let tentative = 1; tentative <= seuil; tentative += 1) {
      assert.equal(cause, null, `arrêt avant la tentative ${tentative}`);
      const rep = await requete(faux.api, "POST", "/v1/chat/completions", appel);
      assert.equal(rep.statut, 429, rep.corps);
      assert.equal(rep.entetes["retry-after"], "1");
      const lu = detect(etat, { type: "session.status", sessionId: "ses_racine", rootId: "ses_racine", statut: "retry", tentative, demandeActive: "ses_racine" });
      etat = lu.etat;
      cause = lu.detection?.cause ?? null;
    }
    assert.equal(cause, "tentatives-429");
    const enfin = await requete(faux.api, "POST", "/v1/chat/completions", appel);
    assert.equal(enfin.statut, 200, enfin.corps);
  });
});

// --- 8. Salle absente ------------------------------------------------------------------------------------------------------------

/**
 * Modules de la salle encore NON BRANCHÉS (fichiers neufs) : seuls eux-mêmes et leurs tests les importent. Liste étendue à chaque
 * train (demande de contrat n° 1 de L17b, train de V1) : V0, puis V1 (service de contrôle du cockpit, validateurs de l'image,
 * filet). T3b (V2) a branché le service de contrôle (`omo-control.ts`) dans le câblage, avec son test de salle coupée : ce nom est
 * retiré, et avec lui les trois modules que ce service importe (`omo-contracts.ts`, `shared/omo-control-protocol.ts`,
 * `shared/omo-types.ts`) plus le module de textes que la route de la salle lit pour sa phrase de refus (`shared/omo-room-texts.ts`)
 * — sans quoi le service branché, désormais parcouru comme un fichier de production, serait pris en faute pour ses propres
 * importations.
 *
 * V3 retire six noms de plus, pour la même raison, et les deux paquets qui les branchent le disent ici (train de V3, conflit
 * résolu en gardant les deux retraits) :
 * — L18c a branché les salles (`omo-room.ts`, `routes-omo.ts`) : `GET /api/omo/status` lit le journal des sorties refusées
 *   (`egress-journal.ts`, fiche L18c), l'hôte autorisé d'`egress` (`egress-allow.ts`, que le journal importe lui-même) et la
 *   version auditée de l'extension (`omo-audit-4.19.4.ts`, et donc `shared/omo-roles.ts` qu'elle importe) ;
 * — L19b a rempli le port `omoPrecheck` (`omo-precheck-service.ts`) : il appelle les deux modules du pré-contrôle
 *   (`shared/omo-precheck-rules.ts` et `omo-precheck-reader.ts`).
 * Ces six noms sont désormais parcourus comme des fichiers de production, exactement comme `omo-control.ts` et ses modules
 * depuis le train de V2. `egress-proxy.ts` reste dans la liste : rien ne l'importe hors de son propre lancement. Les autres
 * modules de comportement de la salle (plafonds, détections, audit de l'extension au-delà de la version branchée, superviseur)
 * restent interdits d'importation : ils arrivent avec leurs paquets, en V4.
 */
const MODULES_SALLE_V0 = new Set([
  // V1
  "validate.mjs",
  "validate-core.mjs",
  "cockpit-guard.js",
  // V0
  "omo-limits.ts",
  "omo-cap.ts",
  "omo-detections.ts",
  "egress-proxy.ts",
  "omo-audit-texts.ts",
  "supervisor-lib.mjs",
]);

describe("croisements 2bis V0 : tous les modules installés, la salle reste absente", () => {
  // T3b (V2) a câblé les modules de la salle : les routes /api/omo/* existent désormais, et refusent toutes 403 « salle-coupee »
  // tant que SALLE_OUVERTE est faux (plan 2 bis §2.7). Aucune salle n'est ouverte pour autant, et le bootstrap reste sans champ omo.
  it("app-factory avec modules « tous » : toute route /api/omo → 403 salle-coupee, bootstrap sans champ omo, opencode jamais relancé", async (t) => {
    const h = await startCockpit(t, { modules: "tous" });
    const ouverture = await h.call("POST", "/api/omo/rooms", { headers: h.headers.confirmed, body: { projet: "app" } });
    assert.equal(ouverture.status, 403, ouverture.body);
    assert.equal(ouverture.json<{ error: string }>().error, "salle-coupee");
    const statut = await h.call("GET", "/api/omo/status", { headers: h.headers.authed });
    assert.equal(statut.status, 403, statut.body);
    assert.equal(statut.json<{ error: string }>().error, "salle-coupee");
    const bootstrap = await h.call("GET", "/api/bootstrap", { headers: h.headers.authed });
    assert.equal(bootstrap.status, 200, bootstrap.body);
    assert.equal(Object.hasOwn(bootstrap.json<Record<string, unknown>>(), "omo"), false);
    h.assertNoGlobalRestart();
  });

  it("aucun fichier de production hors de la vague n'importe un module de la salle", () => {
    const appDir = path.join(RACINE, "app");
    const problemes: string[] = [];
    for (const top of ["server", "web"]) {
      for (const entree of fs.readdirSync(path.join(appDir, top), { recursive: true }) as string[]) {
        const rel = entree.replaceAll("\\", "/");
        const nom = path.posix.basename(rel);
        if (!/\.tsx?$/u.test(nom) || /\.test\.tsx?$/u.test(nom) || rel.startsWith("test-support/") || MODULES_SALLE_V0.has(nom)) continue;
        const brut = fs.readFileSync(path.join(appDir, top, entree), "utf8");
        // « import type … ; » est effacé à la compilation : il ne fait entrer AUCUN code de la salle dans le produit, et un
        // contrat de types partagé (omo-types.ts) peut donc être cité par une signature de l'instance principale (T3c, D-2b-41).
        // Tout autre import reste interdit hors de la vague.
        const source = brut.replace(/\bimport\s+type\s[^;]*?;/gu, "");
        // « from "x" », « import "x" » (effet de bord seul) et « import("x") ».
        for (const trouve of source.matchAll(/\bfrom\s*["']([^"']+)["']|\bimport\s*\(?\s*["']([^"']+)["']/gu)) {
          const cible = path.posix.basename(trouve[1] ?? trouve[2] ?? "");
          if (MODULES_SALLE_V0.has(cible)) problemes.push(`${top}/${rel} → ${cible}`);
        }
      }
    }
    assert.deepEqual(problemes, []);
  });
});
