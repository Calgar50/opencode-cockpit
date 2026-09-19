// Protocole de contrôle de la Salle OMO (L17a) : les mêmes vecteurs sont lus par le module pur du cockpit
// (`shared/omo-control-protocol.ts`) et par la bibliothèque du superviseur (`docker/opencode-omo/supervisor-lib.mjs`), qui ne
// s'importent jamais l'un l'autre. Deux copies d'un protocole qui divergent, c'est un cockpit qui croit la salle arrêtée pendant
// qu'elle travaille : ce test est la couture entre les deux.
//
// Il vérifie aussi la promesse faite à l'utilisateur (§7.5 l.1145) : « 30 secondes au plus ». La borne est CALCULÉE à partir des
// délais, pas recopiée ; des délais qui la feraient franchir font échouer le test, dans les deux modules.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import * as salle from "../../docker/opencode-omo/supervisor-lib.mjs";
import {
  OMO_BORNE_HOMME_MORT_MAX_S,
  OMO_CONTROL_MAX_OCTETS,
  OMO_DELAIS,
  OMO_FICHIER_ETAT,
  OMO_FICHIER_PROJETS,
  OMO_FICHIERS_CONTROLE,
  OMO_LISTE_MAX,
  OMO_MARGE_HOMME_MORT_S,
  OmoControlTropGrosError,
  analyserArret,
  analyserBattement,
  analyserEtat,
  analyserGuardState,
  analyserPrecheckOk,
  ageBattementMs,
  battementFrais,
  borneHommeMort,
  cheminTemporaire,
  decisionSuperviseur,
  delaisTiennentLaPromesse,
  ecrireArret,
  ecrireBattement,
  ecrireEtat,
  ecrireGuardState,
  ecrirePrecheckOk,
  precheckDuDemarrage,
  type OmoDelais,
  type OmoSupervisorState,
} from "./shared/omo-control-protocol.ts";
import { leaks } from "./test-support/helpers.ts";

// --- Vecteurs -------------------------------------------------------------------------------------------------------------------

interface Vecteur {
  nom: string;
  format: "battement" | "arret" | "precheck" | "garde" | "projets" | "etat";
  lecteurs: ("cockpit" | "salle")[];
  texte?: string;
  rembourrageOctets?: number;
  projetsGeneres?: number;
  attendu?: unknown;
  attenduProjets?: number;
}

interface Fixture {
  version: number;
  delais: OmoDelais;
  margeHommeMortS: number;
  borneHommeMortS: number;
  borneMaxS: number;
  maxOctets: number;
  listeMax: number;
  startId: string;
  autreStartId: string;
  vecteurs: Vecteur[];
  fraicheur: { nom: string; at: number | null; maintenant: number; frais: boolean }[];
  precheckDemarrage: { nom: string; startIdFichier: string | null; at: number; startIdCourant: string; maintenant: number; accepte: boolean }[];
  decisions: { nom: string; battementAt: number | null; arret: boolean; maintenant: number; decision: string }[];
}

const CHEMIN_FIXTURE = path.join(import.meta.dirname, "test-support", "fixtures", "omo-control-vectors.json");
const BRUT = fs.readFileSync(CHEMIN_FIXTURE, "utf8");
const FIXTURE = JSON.parse(BRUT) as Fixture;

/** `at` fixe et rembourrage : un battement d'exactement `octets` octets (tout en ASCII, un octet par caractère). */
function battementRembourre(octets: number): string {
  const vide = JSON.stringify({ at: 1757000000000, bourrage: "" });
  return JSON.stringify({ at: 1757000000000, bourrage: "x".repeat(Math.max(0, octets - vide.length)) });
}

/** `n` projets de pré-contrôle, chacun avec une empreinte valide : sert à passer la borne de la liste. */
function precheckGenere(n: number, startId: string): string {
  const projets = Array.from({ length: n }, (_, i) => ({ chemin: `projet-${i}`, sha256: `${"0".repeat(63)}${(i % 16).toString(16)}` }));
  return JSON.stringify({ startId, at: 1757000000000, projets });
}

/** Texte du vecteur : littéral, rembourré, ou engendré. */
function texteDuVecteur(vecteur: Vecteur): string {
  if (vecteur.rembourrageOctets !== undefined) return battementRembourre(vecteur.rembourrageOctets);
  if (vecteur.projetsGeneres !== undefined) return precheckGenere(vecteur.projetsGeneres, FIXTURE.startId);
  assert.equal(typeof vecteur.texte, "string", `${vecteur.nom} : ni texte, ni rembourrage, ni projets engendrés`);
  return vecteur.texte as string;
}

type Lecteur = (texte: string | null | undefined) => unknown;

const LECTEURS_COCKPIT: Record<Vecteur["format"], Lecteur | null> = {
  battement: analyserBattement,
  arret: analyserArret,
  precheck: analyserPrecheckOk,
  garde: analyserGuardState,
  etat: analyserEtat,
  projets: null,
};

const LECTEURS_SALLE: Record<Vecteur["format"], Lecteur | null> = {
  battement: salle.analyserBattement,
  arret: salle.analyserArret,
  precheck: salle.analyserPrecheckOk,
  garde: null,
  etat: null,
  projets: salle.analyserProjetsPrepares,
};

describe("protocole de contrôle : les deux lecteurs disent la même chose", () => {
  it("chaque vecteur donne le résultat attendu, côté cockpit comme côté salle", () => {
    assert.ok(FIXTURE.vecteurs.length >= 30, `${FIXTURE.vecteurs.length} vecteurs`);
    for (const vecteur of FIXTURE.vecteurs) {
      const texte = texteDuVecteur(vecteur);
      const resultats: unknown[] = [];
      for (const [role, table] of [
        ["cockpit", LECTEURS_COCKPIT],
        ["salle", LECTEURS_SALLE],
      ] as const) {
        if (!vecteur.lecteurs.includes(role)) continue;
        const lecteur = table[vecteur.format];
        assert.ok(lecteur, `${vecteur.nom} : ${role} n'a pas de lecteur pour « ${vecteur.format} »`);
        const obtenu = lecteur(texte);
        if (vecteur.attenduProjets !== undefined) {
          const projets = (obtenu as { projets?: unknown[] } | null)?.projets;
          assert.equal(projets?.length, vecteur.attenduProjets, `${vecteur.nom} (${role})`);
        } else {
          assert.deepEqual(obtenu, vecteur.attendu ?? null, `${vecteur.nom} (${role})`);
        }
        resultats.push(obtenu);
      }
      assert.ok(resultats.length >= 1, `${vecteur.nom} : aucun lecteur`);
      // Les formats lus des deux côtés doivent l'être à l'identique, pas seulement « chacun comme attendu ».
      if (resultats.length === 2) assert.deepEqual(resultats[0], resultats[1], `${vecteur.nom} : les deux lecteurs divergent`);
    }
  });

  it("les trois fichiers écrits par le cockpit sont lus des deux côtés", () => {
    for (const format of ["battement", "arret", "precheck"] as const) {
      const vus = FIXTURE.vecteurs.filter((v) => v.format === format);
      assert.ok(vus.length >= 5, `${format} : ${vus.length} vecteurs`);
      for (const vecteur of vus) assert.deepEqual([...vecteur.lecteurs].sort(), ["cockpit", "salle"], vecteur.nom);
    }
  });

  it("les noms de fichiers sont les mêmes des deux côtés", () => {
    assert.deepEqual({ ...salle.FICHIERS_CONTROLE }, { ...OMO_FICHIERS_CONTROLE });
    assert.equal(salle.FICHIER_ETAT, OMO_FICHIER_ETAT);
    assert.equal(salle.FICHIER_PROJETS, OMO_FICHIER_PROJETS);
  });

  it("les bornes sont les mêmes des deux côtés et dans la fixture", () => {
    assert.equal(salle.OMO_CONTROL_MAX_OCTETS, OMO_CONTROL_MAX_OCTETS);
    assert.equal(salle.OMO_LISTE_MAX, OMO_LISTE_MAX);
    assert.equal(FIXTURE.maxOctets, OMO_CONTROL_MAX_OCTETS);
    assert.equal(FIXTURE.listeMax, OMO_LISTE_MAX);
  });
});

describe("protocole de contrôle : homme mort (D-2b-25, §7.5 l.1145)", () => {
  it("les délais sont égaux des deux côtés et dans la fixture", () => {
    assert.deepEqual({ ...salle.OMO_DELAIS }, { ...OMO_DELAIS });
    assert.deepEqual({ ...FIXTURE.delais }, { ...OMO_DELAIS });
    assert.equal(salle.OMO_MARGE_HOMME_MORT_S, OMO_MARGE_HOMME_MORT_S);
    assert.equal(FIXTURE.margeHommeMortS, OMO_MARGE_HOMME_MORT_S);
    assert.equal(salle.OMO_BORNE_HOMME_MORT_MAX_S, OMO_BORNE_HOMME_MORT_MAX_S);
  });

  it("la borne vaut 27 s des deux côtés, sous les 30 s promises", () => {
    assert.equal(borneHommeMort(OMO_DELAIS), 27);
    assert.equal(salle.borneHommeMort(salle.OMO_DELAIS), 27);
    assert.equal(FIXTURE.borneHommeMortS, 27);
    assert.equal(FIXTURE.borneMaxS, OMO_BORNE_HOMME_MORT_MAX_S);
    assert.ok(borneHommeMort(OMO_DELAIS) <= OMO_BORNE_HOMME_MORT_MAX_S);
    assert.equal(delaisTiennentLaPromesse(OMO_DELAIS), true);
  });

  it("des délais qui franchiraient les 30 s sont refusés (la borne est calculée, pas recopiée)", () => {
    const trop: OmoDelais = { battementS: 5, perimeS: 25, verificationS: 2, killApresS: 3 };
    assert.equal(borneHommeMort(trop), 32);
    assert.equal(salle.borneHommeMort(trop), 32);
    assert.equal(delaisTiennentLaPromesse(trop), false);
    // 26 s : pile au-dessus, refusé aussi. La marge n'est pas décorative.
    assert.equal(delaisTiennentLaPromesse({ battementS: 5, perimeS: 24, verificationS: 2, killApresS: 3 }), false);
    assert.equal(delaisTiennentLaPromesse({ battementS: 5, perimeS: 23, verificationS: 2, killApresS: 3 }), true);
  });

  it("le battement vieillit de la même façon des deux côtés", () => {
    for (const cas of FIXTURE.fraicheur) {
      const battement = cas.at === null ? null : { at: cas.at };
      assert.equal(battementFrais(battement, cas.maintenant), cas.frais, cas.nom);
      assert.equal(salle.battementFrais(battement, cas.maintenant), cas.frais, `${cas.nom} (salle)`);
    }
  });

  it("l'âge du battement est dit tel quel, même négatif, et « inconnu » quand il n'y en a pas", () => {
    assert.equal(ageBattementMs(null, 1757000000000), null);
    assert.equal(ageBattementMs({ at: 1757000000000 }, 1757000005000), 5000);
    assert.equal(ageBattementMs({ at: 1757000005000 }, 1757000000000), -5000);
  });

  it("le pré-contrôle d'un autre démarrage ne vaut rien, des deux côtés", () => {
    for (const cas of FIXTURE.precheckDemarrage) {
      const precheck = cas.startIdFichier === null ? null : { startId: cas.startIdFichier, at: cas.at, projets: [] };
      assert.equal(precheckDuDemarrage(precheck, cas.startIdCourant, cas.maintenant), cas.accepte, cas.nom);
      assert.equal(salle.precheckDuDemarrage(precheck, cas.startIdCourant, cas.maintenant), cas.accepte, `${cas.nom} (salle)`);
    }
  });

  it("la décision du superviseur est la même des deux côtés", () => {
    for (const cas of FIXTURE.decisions) {
      const battement = cas.battementAt === null ? null : { at: cas.battementAt };
      const arret = cas.arret ? { at: cas.maintenant, cause: "vous" as const } : null;
      assert.equal(decisionSuperviseur(battement, arret, cas.maintenant), cas.decision, cas.nom);
      assert.equal(salle.decisionSuperviseur(battement, arret, cas.maintenant), cas.decision, `${cas.nom} (salle)`);
    }
  });
});

describe("protocole de contrôle : écriture", () => {
  it("ce qui est écrit se relit, des deux côtés", () => {
    const texteBattement = ecrireBattement(1757000000000);
    assert.deepEqual(analyserBattement(texteBattement), { at: 1757000000000 });
    assert.deepEqual(salle.analyserBattement(texteBattement), { at: 1757000000000 });

    const texteArret = ecrireArret(1757000000000, "plafond-duree");
    assert.deepEqual(analyserArret(texteArret), { at: 1757000000000, cause: "plafond-duree" });
    assert.deepEqual(salle.analyserArret(texteArret), { at: 1757000000000, cause: "plafond-duree" });

    const textePrecheck = ecrirePrecheckOk(FIXTURE.startId, 1757000000000, [{ chemin: "alpha", sha256: "0".repeat(64) }]);
    assert.deepEqual(salle.analyserPrecheckOk(textePrecheck), analyserPrecheckOk(textePrecheck));
    assert.equal(analyserPrecheckOk(textePrecheck)?.startId, FIXTURE.startId);

    const texteGarde = ecrireGuardState(1757000000000, ["task"]);
    assert.deepEqual(analyserGuardState(texteGarde), { version: 1, at: 1757000000000, bloquer: ["task"] });
  });

  it("chaque écriture finit par un saut de ligne et tient sur une ligne", () => {
    for (const texte of [ecrireBattement(1), ecrireArret(1, "vous"), ecrirePrecheckOk(FIXTURE.startId, 1, []), ecrireGuardState(1, [])]) {
      assert.equal(texte.endsWith("\n"), true);
      assert.equal(texte.trimEnd().includes("\n"), false);
    }
  });

  it("un fichier de contrôle qui dépasserait 64 Kio est refusé À L'ÉCRITURE", () => {
    const enorme = Array.from({ length: OMO_LISTE_MAX }, (_, i) => ({ chemin: `${"x".repeat(4000)}-${i}`, sha256: "0".repeat(64) }));
    assert.throws(() => ecrirePrecheckOk(FIXTURE.startId, 1757000000000, enorme), OmoControlTropGrosError);
    // Sans la borne, ce fichier serait écrit puis relu comme « inconnu » : un pré-contrôle perdu sans que personne ne le sache.
    assert.equal(analyserPrecheckOk(JSON.stringify({ startId: FIXTURE.startId, at: 1, projets: enorme })), null);
  });

  it("l'état publié par la salle est relu par le cockpit", () => {
    const etat: OmoSupervisorState = {
      startId: FIXTURE.startId,
      phase: "attente",
      imageId: "",
      manifestSha256: "0".repeat(64),
      manifesteReference: "ok",
      validation: "ok",
      dossiersConfig: [{ chemin: "/home/node/.omo", ok: true }],
      projets: [{ chemin: "alpha", gitLectureSeule: true }],
      workspaceGit: { verifieLe: 1757000000000, limiteAtteinte: false, nonProteges: [] },
      startedAt: 1757000000000,
    };
    assert.deepEqual(analyserEtat(ecrireEtat(etat)), etat);
  });

  it("le chemin temporaire reste dans le dossier, même avec une marque hostile", () => {
    assert.equal(cheminTemporaire("/control/heartbeat", "1234"), "/control/heartbeat.1234.tmp");
    assert.equal(cheminTemporaire("/control/heartbeat", "../../etc/passwd"), "/control/heartbeat.etcpasswd.tmp");
    assert.equal(cheminTemporaire("/control/heartbeat", ""), "/control/heartbeat.0.tmp");
    assert.equal(cheminTemporaire("/control/heartbeat", "/".repeat(50)), "/control/heartbeat.0.tmp");
    // Même règle dans la salle : les deux modules écrivent au même endroit.
    assert.equal(salle.cheminTemporaire("/control/heartbeat", "../../etc/passwd"), "/control/heartbeat.etcpasswd.tmp");
  });
});

describe("protocole de contrôle : la fixture elle-même", () => {
  it("ne porte ni secret ni chemin d'hôte", () => {
    assert.deepEqual(leaks(BRUT), []);
  });

  it("déclare les identifiants de démarrage attendus", () => {
    assert.notEqual(FIXTURE.startId, FIXTURE.autreStartId);
    assert.equal(salle.estStartId(FIXTURE.startId), true);
    assert.equal(salle.estStartId(FIXTURE.autreStartId), true);
    assert.equal(salle.estStartId("demarrage-1"), false);
  });
});
