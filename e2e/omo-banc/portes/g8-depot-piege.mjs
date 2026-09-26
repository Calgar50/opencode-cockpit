// Porte G8 « Dépôt piégé » sur le banc COMPLET (L27b ; spécification §7.10 l.1222, §7.6 l.1160 ; plan §7 ; D-2b-35). Cockpit RÉEL,
// salle réelle, faux Copilot hors ligne : aucun appel facturé, aucun jeton.
//
// Cas joués (identifiants entre crochets ; rejeu isolé par `BANC_L27B_CAS=g8:<cas>`, variable du BANC) :
//   [pieges]  banc clair. Les 15 dépôts piégés de T-L19-a (liste DEPOTS_PIEGES de app/server/test-support/omo-trapped-repos.ts,
//             importée telle quelle : une seule liste pour la CI et le banc) sont posés un par un côté poste, dans le projet
//             préparé JAMAIS OUVERT (piège « projet ») ou dans le dossier parent, le dossier de travail (piège « parent ») ; la salle
//             est relancée à chaque fois. Pour chaque piège : le pré-contrôle RÉEL de ce démarrage refuse le projet visé avec la
//             raison attendue, aucun `precheck-ok` n'est écrit pour ce démarrage et la salle ne devient jamais « prête » — refus
//             AVANT le démarrage, portée « prepares » (D-2b-35) : un projet préparé non ouvert suffit à tout bloquer. Ouvrir le
//             projet piégé répond 409 avec sa raison. Piège retiré, la salle repart : le pré-contrôle est refait à chaque démarrage.
//   [refuse]  banc lancé avec le projet de test piégé de L21b (`run-banc.mjs --complet --projets-test g7 --scenarios g8`) : le
//             démarrage est refusé dès la première préparation (même preuve, sur un dépôt copié au lancement du banc).
//   [relance] banc clair. Un fichier piégé créé EN COURS de demande (`opencode.json` à la racine du projet ouvert, posé côté poste :
//             sous A16, la salle ne peut rien créer à cette racine) → arrêt (configuration apparue) → relance à neuf, dont le
//             pré-contrôle REFAIT refuse le projet tant que le piège est là → piège retiré → démarrage suivant pré-contrôlé, accepté,
//             `precheck-ok` à son startId. Chaque démarrage vu pendant le cas a eu SON pré-contrôle. (Le `.git` créé par l'IA, mis en
//             quarantaine, est le cas [git-imbrique] de G7.)
//
// Rien du contenu n'est lu : codes, état de la salle, résultats de pré-contrôle masqués (chemins, jamais un contenu), startId. Les
// pièges sont des fichiers synthétiques (« [synthétique] … aucun secret »), posés dans le dossier de travail JETABLE du banc et
// retirés aussitôt. lib-activation, lib-arret et g6-plafonds (outils communs L27b) sont réutilisés. Aucune dépendance npm (P8).
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { ouvrirSalle, statutSalle } from "../lib/lib-activation.mjs";
import { appels, commande, lecture, texte } from "../lib/scenarios-faux.mjs";
import {
  assainir,
  attendreArret,
  attendrePrete,
  casDemande,
  deposer,
  ecouter,
  ecrireDiagnostic,
  lancerDemande,
  lente,
  lirePrecheckOk,
  ouvrirCockpit,
  pause,
  PROJET,
  PROJET_TEMOIN,
  precontroleDuDemarrage,
  raisonDu,
  registre,
  relancerSalle,
  retirer,
  suivreFaux,
} from "./g6-plafonds.mjs";

const RACINE_DEPOT = path.join(import.meta.dirname, "..", "..", "..");

/** Noms des projets de test piégés recopiés par `--projets-test` (préfixés `projet-test-` par run-banc). g7 porte .agents/skills. */
const PROJETS_PIEGES = Object.freeze(["projet-test-g7"]);

/** Contenu des pièges posés par le banc : reconnaissable, inoffensif. */
const CONTENU_PIEGE = "[synthétique] dépôt piégé du banc G8, aucun secret.\n";

/** Piège qui apparaît pendant une demande ([relance]) : configuration d'opencode à la racine du projet ouvert (raison config-opencode). */
const PIEGE_EN_COURS = "opencode.json";

/**
 * Lit le statut de la salle et en tire la configuration : projets préparés, projets piégés de test vus, dernier démarrage et ses
 * résultats de pré-contrôle. Rend `{ statut, prepares, pieges, refuses }`.
 */
async function lireConfig(client) {
  const s = (await statutSalle(client)).json ?? {};
  const prepares = Array.isArray(s.projetsPrepares) ? s.projetsPrepares.map((p) => p.chemin) : [];
  const pieges = prepares.filter((chemin) => PROJETS_PIEGES.some((nom) => chemin === nom || chemin.endsWith(`/${nom}`)));
  const resultats = Array.isArray(s.dernierDemarrage?.precheck) ? s.dernierDemarrage.precheck : [];
  const refuses = resultats.filter((rr) => rr?.verdict === "refuse");
  return { statut: s, prepares, pieges, refuses };
}

// --- [pieges] Les 15 dépôts piégés de T-L19-a, posés côté poste ------------------------------------------------------------------

/**
 * Où et quoi poser pour un piège de DEPOTS_PIEGES : « projet » dans le projet préparé non ouvert, « parent » à la racine du dossier
 * de travail (le parent des projets du banc). `quoi` finissant par « / » est un dossier : un fichier y est posé. Rend le chemin du
 * fichier posé et l'entrée de premier niveau à retirer ensuite, relatifs au dossier de travail.
 */
export function poseDuPiege(depot) {
  const hote = depot.ou === "projet" ? PROJET_TEMOIN : "";
  const fichier = depot.quoi.endsWith("/") ? `${depot.quoi}piege-banc.txt` : depot.quoi;
  const entree = depot.quoi.split("/")[0];
  const prefixe = hote === "" ? "" : `${hote}/`;
  return { fichier: prefixe + fichier, entree: prefixe + entree, vises: depot.ou === "projet" ? [PROJET_TEMOIN] : null };
}

async function casPieges(ctx, client, r) {
  const ws = ctx.chemins?.ws ?? null;
  if (!r.ajouter("[pieges] dossier de travail du banc connu côté poste", ws !== null, ws === null ? "ctx.chemins.ws absent" : "")) return;
  const { DEPOTS_PIEGES } = await import(pathToFileURL(path.join(RACINE_DEPOT, "app", "server", "test-support", "omo-trapped-repos.ts")).href);
  r.ajouter("[pieges] la liste de T-L19-a porte 15 dépôts piégés", DEPOTS_PIEGES.length === 15, `${DEPOTS_PIEGES.length} pièges`);
  const config = await lireConfig(client);
  const prepares = config.prepares;
  const bilan = [];
  let ouvertureVue = false;
  for (const depot of DEPOTS_PIEGES) {
    const pose = poseDuPiege(depot);
    if (fs.existsSync(path.join(ws, ...pose.entree.split("/")))) {
      r.ajouter(`[pieges] ${depot.id} : l'entrée ${pose.entree} n'existe pas avant le piège`, false, "déjà présente : le banc ne pose rien par-dessus");
      continue;
    }
    let ligne = { id: depot.id, ou: depot.ou, raison: depot.raison };
    try {
      deposer(ws, pose.fichier, CONTENU_PIEGE);
      const relance = await relancerSalle(ctx, { delaiMs: 180_000 });
      const pre = relance.startId === null ? { vu: false, resultats: [], precheckOk: null, statut: null } : await precontroleDuDemarrage(ctx, client, relance.startId, { delaiMs: 90_000 });
      const vises = pose.vises ?? prepares;
      const refuses = vises.map((p) => pre.resultats.find((x) => x?.projet === p) ?? null);
      const bonsRefus = refuses.every((x) => x?.verdict === "refuse" && x?.raison === depot.raison);
      const sansPrecheck = pre.precheckOk === null || pre.precheckOk.startId !== relance.startId;
      // Jamais prête : quelques secondes de plus, pour qu'un precheck-ok tardif soit vu.
      await pause(4000);
      const etat = (await statutSalle(client)).json?.etatSalle ?? null;
      const precheckTardif = await lirePrecheckOk(ctx);
      const jamaisPrete = etat !== "prete" && (precheckTardif === null || precheckTardif.startId !== relance.startId);
      let ouverture = null;
      if (!ouvertureVue && depot.ou === "projet") {
        const o = await ouvrirSalle(client, PROJET_TEMOIN);
        ouverture = { code: o.code, raison: raisonDu(o) };
        ouvertureVue = true;
      }
      ligne = { ...ligne, startId: relance.startId?.slice(0, 8) ?? null, vu: pre.vu, refuses: refuses.map((x) => (x === null ? null : `${x.projet}:${x.verdict}:${x.raison ?? ""}`)), sansPrecheck, etat, ouverture };
      r.ajouter(
        `[pieges] ${depot.id} (${depot.quoi}, ${depot.ou}) : démarrage refusé AVANT opencode, raison « ${depot.raison} », aucun precheck-ok, jamais prête`,
        relance.ok && pre.vu && bonsRefus && sansPrecheck && jamaisPrete,
        `démarrage ${ligne.startId ?? "non vu"} ; pré-contrôle ${pre.vu ? "vu" : "non vu"} ; ${JSON.stringify(ligne.refuses)} ; état ${etat ?? "?"}`,
      );
      if (ouverture !== null) {
        r.ajouter(`[pieges] ouvrir le projet préparé piégé NON ouvert (${PROJET_TEMOIN}) → 409 avec sa raison`, ouverture.code === 409 && ouverture.raison === depot.raison, `code ${ouverture.code}, raison ${ouverture.raison ?? "?"}`);
      }
    } catch (err) {
      r.ajouter(`[pieges] ${depot.id} : exécution`, false, String(err?.stack ?? err).slice(0, 600));
    } finally {
      retirer(ws, pose.entree);
      bilan.push(ligne);
    }
  }
  r.mesures.pieges = bilan;
  // Pièges retirés : la salle repart, et CE démarrage est pré-contrôlé à son tour (precheck-ok à son startId).
  const relance = await relancerSalle(ctx, { delaiMs: 180_000 });
  const prete = await attendrePrete(client, 240_000);
  const precheckOk = await lirePrecheckOk(ctx);
  r.ajouter(
    "[pieges] pièges retirés : la salle repart, le pré-contrôle refait à ce démarrage écrit precheck-ok à son startId",
    relance.ok && prete.ok && precheckOk?.startId === relance.startId,
    `démarrage ${relance.startId?.slice(0, 8) ?? "?"}… ; état ${prete.etat ?? "?"} ; precheck-ok ${precheckOk?.startId?.slice(0, 8) ?? "absent"}…`,
  );
}

// --- [refuse] Banc lancé avec le projet de test piégé de L21b ----------------------------------------------------------------------

/** État de la salle jamais atteint quand un projet préparé est piégé (portée « prepares »). */
const ETATS_NON_DEMARRES = new Set(["arretee", "en-relance", "suspendue", "coupee"]);

async function casRefuse(client, ctx, r, config) {
  // La salle ne doit JAMAIS devenir prête tant qu'un projet préparé est piégé.
  const attente = await attendrePrete(client, 60_000);
  r.ajouter("[refuse] la salle ne démarre pas (jamais « prête ») tant qu'un projet préparé est piégé", !attente.ok && ETATS_NON_DEMARRES.has(attente.etat ?? ""), `état ${attente.etat ?? "?"} après 60 s`);
  // Le dernier démarrage porte le projet piégé en « refuse », avec une raison de la liste fermée.
  const apres = await lireConfig(client);
  const raisons = [...new Set(apres.refuses.map((rr) => rr.raison))];
  r.mesures.refuse = { prepares: apres.prepares, pieges: apres.pieges, refuses: apres.refuses.map((rr) => ({ projet: rr.projet, raison: rr.raison, trouves: rr.trouves?.length ?? 0 })) };
  r.ajouter(
    "[refuse] le dernier démarrage marque le projet de test piégé « refuse » avec sa raison (config-extension : .agents/skills)",
    apres.pieges.length > 0 && apres.refuses.some((rr) => apres.pieges.includes(rr.projet) && rr.raison === "config-extension") && raisons.every((x) => typeof x === "string" && x.length > 0),
    `piégés préparés ${JSON.stringify(apres.pieges)} ; refusés ${JSON.stringify(apres.refuses.map((rr) => `${rr.projet}:${rr.raison}`))}`,
  );
  // Aucun precheck-ok n'est écrit pour ce démarrage (fermé en cas de doute).
  const precheckOk = await lirePrecheckOk(ctx);
  r.ajouter("[refuse] aucun precheck-ok n'est écrit (portée « prepares » : un seul refus bloque tout)", precheckOk === null || precheckOk.startId !== apres.statut?.dernierDemarrage?.startId, `precheck-ok ${precheckOk === null ? "absent" : precheckOk.startId?.slice(0, 8)}`);
  // Ouvrir le projet piégé (préparé mais non ouvert) → 409 avec sa raison.
  for (const piege of config.pieges) {
    const salle = await ouvrirSalle(client, piege);
    r.ajouter(`[refuse] ouvrir le projet préparé piégé « ${piege} » (non ouvert) → 409 avec sa raison`, salle.code === 409 && raisonDu(salle) === "config-extension", `code ${salle.code}, raison ${raisonDu(salle) ?? "?"}`);
  }
}

// --- [relance] Fichier créé en cours → arrêt, quarantaine, relance ; pré-contrôle à chaque démarrage ---------------------------------

async function casRelance(ctx, client, ecoute, r) {
  const ws = ctx.chemins?.ws ?? null;
  if (!r.ajouter("[relance] dossier de travail du banc connu côté poste", ws !== null, ws === null ? "ctx.chemins.ws absent" : "")) return;
  const debutCas = Date.now();
  const suivi = suivreFaux(ctx.faux);
  // Relevé continu : chaque démarrage publié par le superviseur (startId, phases) et chaque démarrage pré-contrôlé par le cockpit,
  // avec le verdict du projet ouvert.
  const demarrages = new Map();
  const precontroles = new Map();
  let actif = true;
  const releve = (async () => {
    while (actif) {
      const etat = await ctx.etat().catch(() => null);
      if (typeof etat?.startId === "string") {
        const phases = demarrages.get(etat.startId) ?? new Set();
        phases.add(String(etat.phase ?? "?"));
        demarrages.set(etat.startId, phases);
      }
      const s = (await statutSalle(client).catch(() => ({ json: null }))).json;
      const dernier = s?.dernierDemarrage;
      if (typeof dernier?.startId === "string") {
        const ouvert = (dernier.precheck ?? []).find((x) => x?.projet === PROJET) ?? null;
        precontroles.set(dernier.startId, ouvert === null ? "?" : `${ouvert.verdict}${ouvert.raison ? `:${ouvert.raison}` : ""}`);
      }
      await pause(700);
    }
  })();
  let startIdFinal = null;
  try {
    const avant = await ctx.etat();
    const startIdAvant = typeof avant?.startId === "string" ? avant.startId : null;
    // 1er appel lent (8 s) : le piège apparaît côté poste pendant ce temps (sous A16, la salle ne peut rien créer à la racine d'un
    // projet ; c'est l'éditeur ou un outil du poste qui le ferait).
    const racine = [lente(appels(lecture(`/workspace/${PROJET}/LISEZMOI.md`)), 8000), appels(commande("echo apres", "après le piège")), texte("Fin.")];
    const demande = await lancerDemande(ctx, client, { ecoute, plafond: "1.00", texteEnvoye: "Lis le LISEZMOI.", racine });
    if (!r.ajouter("[relance] demande lancée", demande.envoyee, demande.raison ?? "")) return;
    deposer(ws, `${PROJET}/${PIEGE_EN_COURS}`, CONTENU_PIEGE);
    const arret = await attendreArret(ecoute, client, demande.salle.rootId, { depuis: demande.debut, delaiMs: 90_000 });
    const horsControle = ecoute.evenements.find((e) => e.recu >= demande.debut && e.type === "omo.hors-controle") ?? null;
    r.ajouter(
      `[relance] un fichier piégé créé en cours (${PIEGE_EN_COURS}) ARRÊTE la salle (hors-controle, configuration apparue)`,
      arret.ok && arret.cause === "hors-controle" && horsControle?.data?.cause === "config-apparue",
      `arrêt ${arret.cause ?? "aucun"} ; omo.hors-controle ${horsControle?.data?.cause ?? "absent"}`,
    );
    // Relance à neuf : le démarrage suivant est pré-contrôlé, et le piège, toujours là, le fait refuser (jamais « prête »).
    const debutRefus = Date.now();
    let refus = null;
    while (Date.now() - debutRefus < 120_000 && refus === null) {
      refus = [...precontroles.entries()].find(([id, verdict]) => id !== startIdAvant && verdict === "refuse:config-opencode") ?? null;
      if (refus === null) await pause(1000);
    }
    const etatRefus = (await statutSalle(client)).json?.etatSalle ?? null;
    r.ajouter(
      "[relance] relance à neuf : le pré-contrôle REFAIT à ce démarrage refuse le projet (config-opencode), la salle ne devient pas prête",
      refus !== null && etatRefus !== "prete",
      refus === null ? `aucun démarrage refusé vu en 120 s (${JSON.stringify([...precontroles.entries()]).slice(0, 200)})` : `démarrage ${refus[0].slice(0, 8)}… ${refus[1]} ; état ${etatRefus ?? "?"}`,
    );
    // Piège retiré : le démarrage suivant est pré-contrôlé à son tour, accepté, et porte le precheck-ok.
    retirer(ws, `${PROJET}/${PIEGE_EN_COURS}`);
    const relance = await relancerSalle(ctx, { delaiMs: 180_000 });
    startIdFinal = relance.startId;
    const pre = relance.startId === null ? { vu: false, resultats: [] } : await precontroleDuDemarrage(ctx, client, relance.startId, { delaiMs: 90_000 });
    const prete = await attendrePrete(client, 240_000);
    const precheckOk = await lirePrecheckOk(ctx);
    await pause(2000);
    actif = false;
    await releve;
    const vus = [...demarrages.keys()].filter((id) => id !== startIdAvant);
    const sansPrecontrole = vus.filter((id) => !precontroles.has(id));
    r.mesures.relance = {
      startIdAvant: startIdAvant?.slice(0, 8) ?? null,
      startIdFinal: startIdFinal?.slice(0, 8) ?? null,
      demarrages: [...demarrages.entries()].map(([id, phases]) => ({ startId: id.slice(0, 8), phases: [...phases], precontrole: precontroles.get(id) ?? null })),
      precheckOk: precheckOk?.startId?.slice(0, 8) ?? null,
    };
    r.ajouter(
      "[relance] piège retiré : le démarrage suivant est pré-contrôlé, accepté, et porte le precheck-ok (salle prête)",
      pre.vu && !pre.resultats.some((x) => x?.verdict === "refuse") && prete.ok && precheckOk?.startId === startIdFinal,
      `démarrage ${String(startIdFinal).slice(0, 8)}… ; état ${prete.etat ?? "?"} ; precheck-ok ${precheckOk?.startId?.slice(0, 8) ?? "absent"}…`,
    );
    r.ajouter(
      "[relance] pré-contrôle refait à CHAQUE démarrage : chaque démarrage vu pendant le cas a eu le sien",
      vus.length >= 2 && sansPrecontrole.length === 0,
      `${vus.length} démarrage(s) vu(s), ${sansPrecontrole.length} sans pré-contrôle : ${JSON.stringify(r.mesures.relance.demarrages).slice(0, 300)}`,
    );
  } finally {
    actif = false;
    await releve;
    await suivi.arreter();
    retirer(ws, `${PROJET}/${PIEGE_EN_COURS}`);
    await ecrireDiagnostic(ctx, "g8-relance", { ecoute, suivi, depuis: debutCas });
  }
}

export default {
  id: "g8",
  titre: "G8 Dépôt piégé : 15 pièges refusés avant démarrage (portée « prepares »), fichier créé en cours → arrêt et relance, pré-contrôle à chaque démarrage",
  async executer(ctx) {
    const ouvert = await ouvrirCockpit(ctx);
    if (ouvert === null) return { sansObjet: "porte du banc complet : lancée hors du mode --complet (aucun cockpit réel à joindre)" };
    const r = registre();
    const client = ouvert.client;
    r.ajouter("cockpit réel joint, mode Avancé", ouvert.avance.code === 200, `code ${ouvert.avance.code}`);
    const ecoute = ecouter(client);
    try {
      const config = await lireConfig(client);
      r.mesures.config = { prepares: config.prepares, pieges: config.pieges, refuses: config.refuses.length };
      if (config.pieges.length > 0) {
        // Banc lancé avec un projet de test piégé : la salle ne démarre pas, seul [refuse] se joue.
        if (casDemande("g8", "refuse")) await casRefuse(client, ctx, r, config);
        r.attendre("[pieges] et [relance]", "ce banc a un projet préparé piégé (--projets-test g7) : la salle ne démarre pas ; ils se jouent sur un banc clair");
      } else {
        const prete = await attendrePrete(client);
        if (r.ajouter("la salle est « prête » derrière le cockpit réel (banc clair)", prete.ok, `état ${prete.etat ?? "?"}`)) {
          for (const [nom, jouer] of [
            ["pieges", () => casPieges(ctx, client, r)],
            ["relance", () => casRelance(ctx, client, ecoute, r)],
          ]) {
            if (!casDemande("g8", nom)) continue;
            const p = await attendrePrete(client);
            if (!r.ajouter(`[${nom}] salle prête avant le cas`, p.ok, `état ${p.etat ?? "?"}`)) break;
            try {
              await jouer();
            } catch (err) {
              r.ajouter(`[${nom}] exécution`, false, String(err?.stack ?? err).slice(0, 800));
            } finally {
              await assainir(client).catch(() => undefined);
            }
          }
        }
        r.attendre("[refuse] projet de test piégé copié au lancement", "se joue sur un banc lancé avec --projets-test g7 --scenarios g8 (le démarrage y est refusé dès la première préparation)");
      }
    } catch (err) {
      r.ajouter("exécution", false, String(err?.stack ?? err).slice(0, 800));
    } finally {
      ecoute.arreter();
      ctx.ecrireSortie?.("g8-depot-piege.json", `${JSON.stringify(r.rendu(), null, 2)}\n`);
    }
    return r.rendu();
  },
};
