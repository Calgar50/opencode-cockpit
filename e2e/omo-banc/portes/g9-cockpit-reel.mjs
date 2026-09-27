// Porte G9 (L27a) — Homme mort, avec le COCKPIT RÉEL (spécification §7.6 l.1160, §7.10 l.1223 ; plan §6 fiche L27a, §7 ; D-2b-25,
// D-2b-29 n° 1 ; T-L17-c).
//
// La porte G9 « pilote » (scenarios/g9-pilote.mjs, L21, banc hors ligne) arrête un pilote de battement. Ici, c'est le VRAI cockpit
// qui bat, et on le TUE (`docker kill` du conteneur cockpit de la pile jetable), chaque fois pendant qu'une demande tourne :
//   B. redémarrage du cockpit (D-2b-29 n° 1) : tué puis rallumé aussitôt, il trouve dans `state.json` un opencode lancé → il écrit
//      un stop-request « redemarrage-cockpit » pour CE démarrage, et la salle ne fait plus AUCUN usage du faux fournisseur après la
//      reprise (l'appel en cours est abandonné, les réponses suivantes restent dans la file). Tout appel compte, sauf le catalogue
//      `GET /models` que l'opencode relancé à neuf relit à son démarrage, relevé à part avec sa route (comme en G5) ;
//   A. homme mort : tué et laissé mort → opencode de la salle arrêté en 27 s au plus DEPUIS LE DERNIER BATTEMENT ÉCRIT (borne de
//      D-2b-25 : 20 péremption + 2 vérification + 3 arrêt + 2 marge), mesuré sur l'horloge des conteneurs (celle de la machine
//      virtuelle de Docker, commune au cockpit qui date le battement et à la salle où l'arrêt est constaté). Opencode doit être VU
//      dans la salle juste avant le kill (témoin du relevé `ps`) ; une salle qui ne répond plus n'est tenue pour arrêtée que sur une
//      sortie de son conteneur postérieure au dernier battement (`docker inspect`), jamais sur un simple silence. Aucun redémarrage
//      d'opencode sans battement frais ; aucun appel au faux après l'arrêt ; puis le cockpit rallumé, la salle redevient prête ;
//   et T-L17-c revu au passage : le battement n'est pas inscriptible depuis la salle.
//
// Aucun appel Copilot : faux fournisseur hors ligne, dont seuls le nombre d'appels, leurs routes et leurs codes, et la file sont
// lus. Outils communs de L27a : g5-arret.mjs. lib-activation.mjs et lib-arret.mjs (L21b) réutilisées, jamais réécrites. Aucune
// dépendance npm (P8).
import { amorce, attendreEtatSalle, connecterCockpit, passerEnAvance } from "../lib/lib-activation.mjs";
import { appels, commande, lecture, lente, texte } from "../lib/scenarios-faux.mjs";
import { appelsFauxDepuis, decalageHorloge, jouerDemande, lireControle, modeleDeLAssistant } from "./g5-arret.mjs";

/** Borne du contrat (D-2b-25), recopiée ici pour que la porte ne dépende d'aucun module du cockpit. */
export const BORNE_S = 27;
/** Service Compose du cockpit réel (cockpit/cockpit.compose.yml). */
export const SERVICE_COCKPIT = "cockpit";
/** Montant des demandes de G9, en CHAÎNE comme la page le saisit. */
export const PLAFOND_G9 = "0.20";
/** Temps laissé à la salle sans battement pour prouver qu'elle ne redémarre pas. */
export const SANS_BATTEMENT_S = 30;

/** Réponses d'une demande qui travaille encore quand le cockpit meurt : un outil, puis une réponse LENTE, puis ce qui ne doit jamais partir. */
export function demandeLongue(dossier) {
  return [appels(lecture(`${dossier}/LISEZMOI.md`)), lente(58_000, "Réponse lente du faux : la demande travaille encore."), appels(commande("git status --short", "état du dépôt")), texte("Ne doit jamais partir."), texte("Ne doit jamais partir.")];
}

/**
 * Sonde de la salle sur l'horloge des conteneurs : heure (ms) et nombre de processus `opencode serve`. Rend `{ at, n }`, ou null si
 * le conteneur ne répond pas (il redémarre : le superviseur sort après avoir arrêté opencode).
 */
async function sonderOpencode(ctx) {
  const r = await ctx.exec("opencode-omo", ["sh", "-c", "date +%s%3N; ps -eo args | grep -c '[o]pencode serve'"], { delaiMs: 10_000 }).catch(() => null);
  if (r === null || r.code !== 0 && r.code !== 1) return null;
  const [heure, nombre] = String(r.sortie).trim().split(/\s+/);
  const at = Number(heure);
  const n = Number(nombre);
  return Number.isSafeInteger(at) && Number.isInteger(n) ? { at, n } : null;
}

/** Instant RFC 3339 de Docker (jusqu'à la nanoseconde) → millisecondes ; null pour la date nulle (« 0001-01-01… ») ou illisible. */
export function instantDocker(texte) {
  const m = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d{1,9}))?Z$/.exec(String(texte ?? ""));
  if (m === null || m[1].startsWith("0001-")) return null;
  const ms = Date.parse(`${m[1]}.${(m[2] ?? "0").padEnd(3, "0").slice(0, 3)}Z`);
  return Number.isFinite(ms) ? ms : null;
}

/**
 * Dernière sortie du conteneur de la salle, lue par `docker inspect` : `{ finiAt, demarreAt }` en millisecondes, sur l'horloge du
 * démon Docker (celle de la machine virtuelle, commune aux conteneurs), ou null si illisible. Le superviseur ne sort qu'après avoir
 * arrêté opencode : `finiAt` borne donc l'arrêt d'opencode PAR AU-DESSUS.
 */
async function sortieConteneur(ctx) {
  const ps = await ctx.compose(["ps", "--all", "--quiet", "opencode-omo"], { delaiMs: 30_000 }).catch(() => null);
  const id = String(ps?.sortie ?? "").trim().split(/\s+/)[0];
  if (!/^[0-9a-f]{12,64}$/.test(id)) return null;
  const r = await ctx.docker(["inspect", "--format", "{{json .State}}", id], { delaiMs: 30_000 }).catch(() => null);
  if (r === null || r.code !== 0) return null;
  try {
    const etat = JSON.parse(String(r.sortie).trim());
    return { finiAt: instantDocker(etat.FinishedAt), demarreAt: instantDocker(etat.StartedAt) };
  } catch {
    return null;
  }
}

/**
 * Jugement PUR d'une sonde faite après le kill (testable sans Docker). L'arrêt d'opencode n'est CONSTATÉ que (1) par `ps` dans la
 * salle (aucun `opencode serve`, heure du conteneur), ou (2) quand la salle ne répond pas, par une SORTIE du conteneur postérieure
 * au dernier battement écrit (`finiAt`, borne haute de l'arrêt). Une salle muette sans sortie confirmée n'est PAS arrêtée (un
 * `docker exec` trop lent sur une machine chargée ne doit jamais verdir la porte) : on sonde encore. Rend l'arrêt, ou null.
 */
export function constaterArret({ sonde, sortie, dernierBattementAt }) {
  if (sonde !== null && sonde !== undefined) return sonde.n === 0 ? { at: sonde.at, par: "ps dans la salle (heure du conteneur)" } : null;
  if (typeof sortie?.finiAt === "number" && typeof dernierBattementAt === "number" && sortie.finiAt >= dernierBattementAt) {
    return { at: sortie.finiAt, par: "sortie du conteneur de la salle (FinishedAt, horloge de Docker)" };
  }
  return null;
}

/**
 * Jugement PUR de l'homme mort (testable sans Docker) : opencode VU dans la salle juste avant le kill (sans ce témoin, un relevé
 * `ps` qui ne reconnaîtrait jamais opencode passerait pour un arrêt immédiat), puis constaté arrêté, dans la borne DEPUIS LE
 * DERNIER BATTEMENT ÉCRIT, les deux heures sur la même horloge (celle des conteneurs). Un arrêt constaté AVANT le dernier battement
 * est une incohérence.
 */
export function jugerHommeMort({ tournaitAvant, dernierBattementAt, arreteAt, arrete }, borneS = BORNE_S) {
  if (tournaitAvant !== true) return { ok: false, delaiS: null, detail: "opencode non vu dans la salle avant le kill : le relevé ps ne prouverait rien" };
  if (!arrete) return { ok: false, delaiS: null, detail: "opencode ne s'est pas arrêté" };
  if (typeof dernierBattementAt !== "number" || typeof arreteAt !== "number") return { ok: false, delaiS: null, detail: "dernier battement ou heure d'arrêt illisible" };
  const delaiS = (arreteAt - dernierBattementAt) / 1000;
  return { ok: delaiS >= 0 && delaiS <= borneS, delaiS: Number(delaiS.toFixed(2)), detail: `${delaiS.toFixed(1)} s depuis le dernier battement écrit (borne ${borneS} s)` };
}

/**
 * Jugement PUR de la reprise (testable sans Docker) : stop-request « redemarrage-cockpit » pour le démarrage de la demande, AUCUN
 * USAGE du faux depuis la reprise, et les réponses gardées toujours dans sa file. `fenetre` = `appelsFauxDepuis` (g5-arret.mjs) :
 * tout appel est un usage (« chat », route non servie), sauf le catalogue `GET /models` que l'opencode RELANCÉ relit à son
 * démarrage, relevé à part. Mesuré au banc le 26/09 : 5 appels au faux par passe (les 2 « chat » de la demande, 3 hors « chat »,
 * file jamais entamée) ; selon que la relance tombe avant ou après le relevé de la reprise, 0, 1 ou 2 d'entre eux arrivent après
 * lui, et ceux-là ont été relevés : `modeles:200`. Journal du faux incomplet ou illisible : rouge.
 */
export function jugerReprise({ stopRequest, startIdDemande, fenetre, fileReprise, fileFin }) {
  const stopRequestOk = stopRequest?.cause === "redemarrage-cockpit" && typeof startIdDemande === "string" && stopRequest.startId === startIdDemande;
  const lisible = Array.isArray(fenetre?.usages) && Array.isArray(fenetre?.catalogue) && [fileReprise, fileFin].every((x) => typeof x === "number");
  const fauxOk = lisible && fenetre.usages.length === 0 && fileFin === fileReprise;
  return { stopRequestOk, fauxOk, usages: lisible ? fenetre.usages.length : null, catalogue: lisible ? fenetre.catalogue.length : null };
}

/** Sonde T-L17-c : le volume de contrôle est-il inscriptible par node, depuis la salle ? */
const SONDE_CONTROLE = `
const fs = require("node:fs");
const out = {};
try { fs.accessSync("/control", fs.constants.W_OK); out.inscriptible = true; } catch (e) { out.inscriptible = false; out.refus = e.code; }
try { fs.writeFileSync("/control/heartbeat", JSON.stringify({ at: Date.now() })); out.battementEcrit = true; } catch (e) { out.battementEcrit = e.code; }
process.stdout.write(JSON.stringify(out));
`;

const journalFaux = async (ctx) => (await ctx.faux.journal()).json ?? null;

/** Attend que la réponse lente soit en cours au faux (deuxième appel « chat » reçu, pas encore servi). */
async function reponseLenteEnCours(ctx) {
  return await ctx.jusqua(
    async () => {
      const chats = ((await journalFaux(ctx))?.journal ?? []).filter((e) => e.route === "chat");
      return chats.length >= 2 && chats[chats.length - 1].servie === null;
    },
    { delaiMs: 60_000, pasMs: 500 },
  );
}

export default {
  id: "g9",
  titre: "Homme mort, cockpit réel : tué → opencode arrêté ≤ 27 s après le dernier battement ; rallumé → stop-request, aucun usage du faux",
  async executer(ctx) {
    const points = [];
    const m = {};
    const mesures = { g9Cockpit: m };
    const ajouter = (nom, ok, detail) => points.push({ nom, ok: Boolean(ok), detail });
    const fin = () => {
      ctx.ecrireSortie("g9-cockpit-reel.json", `${JSON.stringify({ points, mesures: m }, null, 2)}\n`);
      return { points, mesures };
    };

    if (!ctx.cockpitPort || !ctx.cockpitJeton) return { sansObjet: "G9 (cockpit réel) : lancée hors du mode --complet (aucun cockpit réel à tuer)" };
    if (ctx.battementCockpit !== true) {
      return { sansObjet: "G9 (cockpit réel) : cette tête ne fait pas battre le cockpit (battement des pilotes) — la porte G9 « pilote » de L21 vaut seule" };
    }
    const connecter = async () => {
      const c = await connecterCockpit({ port: ctx.cockpitPort, jeton: ctx.cockpitJeton, delaiMs: 180_000 });
      await passerEnAvance(c);
      return c;
    };
    let client = await connecter();
    const boot = await amorce(client);
    if (boot.json?.omo?.salleOuverte !== true) {
      ajouter("l'image du cockpit porte SALLE_OUVERTE=true", false, JSON.stringify(boot.json?.omo ?? null));
      return fin();
    }
    const prete = await attendreEtatSalle(client, ["prete"], { delaiMs: 240_000, pasMs: 2000 });
    ajouter("la salle est « prête » derrière le cockpit réel", prete.ok, `état ${prete.etat ?? "?"}`);
    if (!prete.ok) return fin();
    const model = await modeleDeLAssistant(ctx);
    if (model === null) {
      ajouter("la salle sert une IA github-copilot (assistant par défaut)", false, "aucune IA lisible");
      return fin();
    }
    const dossier = "/workspace/projet-ouvert";

    // T-L17-c, revu : le battement n'est pas inscriptible depuis la salle (sinon elle tiendrait son propre homme mort).
    const controle = await ctx.exec("opencode-omo", ["node", "-e", SONDE_CONTROLE], { delaiMs: 60_000 });
    let vue = null;
    try {
      vue = JSON.parse(String(controle.sortie).trim());
    } catch {
      vue = null;
    }
    m.controle = vue;
    ajouter("T-L17-c : le battement n'est pas inscriptible depuis la salle (node)", vue !== null && vue.inscriptible === false && vue.battementEcrit !== true, JSON.stringify(vue));

    // --- B. Redémarrage du cockpit pendant une demande ------------------------------------------------------------------------
    if (ctx.activationLivree !== true) {
      ajouter("l'activation « omo » est livrée par la tête éprouvée (L22c)", false, "sans elle, aucune demande ne tourne quand le cockpit meurt");
      return fin();
    }
    await ctx.faux.reinitialiser();
    const dB = await jouerDemande(ctx, client, { reponses: demandeLongue(dossier), texteEnvoi: "Travaille longtemps (G9, reprise).", plafond: PLAFOND_G9, model });
    ajouter("B : une demande tourne quand le cockpit meurt", dB.ok && (await reponseLenteEnCours(ctx)), dB.etape);
    if (!dB.ok) return fin();
    const tueB = await ctx.compose(["kill", SERVICE_COCKPIT], { delaiMs: 60_000 });
    const rallume = await ctx.compose(["start", SERVICE_COCKPIT], { delaiMs: 180_000 });
    client = await connecter();
    const fauxReprise = await journalFaux(ctx);
    const stopRequestVu = await ctx.jusqua(async () => (await lireControle(ctx, "stop-request"))?.cause === "redemarrage-cockpit", { delaiMs: 60_000, pasMs: 1000 });
    const stopRequest = await lireControle(ctx, "stop-request");
    const relanceB = await attendreEtatSalle(client, ["prete"], { delaiMs: 240_000, pasMs: 1000 });
    const etatB = await ctx.etat();
    await ctx.attendre(20_000);
    const fauxFin = await journalFaux(ctx);
    const fenetre = appelsFauxDepuis(fauxFin?.journal, fauxReprise?.recues, fauxFin?.recues);
    const reprise = jugerReprise({ stopRequest, startIdDemande: dB.startIdAvant, fenetre, fileReprise: fauxReprise?.enFile?.ordre, fileFin: fauxFin?.enFile?.ordre });
    m.reprise = {
      kill: tueB.code,
      start: rallume.code,
      stopRequest: stopRequest === null ? null : { cause: stopRequest.cause, startIdDeLaDemande: stopRequest.startId === dB.startIdAvant },
      vuEn60s: stopRequestVu,
      appels: {
        reprise: fauxReprise?.recues ?? null,
        fin: fauxFin?.recues ?? null,
        // Routes et codes seulement (aucun contenu) : ce qui a joint le faux après la reprise.
        apresReprise: fenetre === null ? "journal du faux incomplet" : { usages: fenetre.usages, catalogue: fenetre.catalogue },
      },
      file: { reprise: fauxReprise?.enFile?.ordre ?? null, fin: fauxFin?.enFile?.ordre ?? null },
      appelAbandonne: (fauxFin?.journal ?? []).some((e) => e.route === "chat" && e.abandon === true),
      relance: { etat: relanceB.etat, startIdNeuf: etatB !== null && etatB.startId !== dB.startIdAvant },
    };
    ajouter("B : docker kill du cockpit pendant la demande, puis cockpit rallumé", tueB.code === 0 && rallume.code === 0, `kill ${tueB.code}, start ${rallume.code}`);
    ajouter("B : le cockpit rallumé écrit un stop-request « redemarrage-cockpit » pour le démarrage de la demande", reprise.stopRequestOk, JSON.stringify(m.reprise.stopRequest));
    ajouter(
      "B : aucun usage du faux fournisseur après la reprise (appel en cours abandonné, réponses suivantes restées en file ; catalogue relu par l'opencode relancé relevé à part)",
      reprise.fauxOk && m.reprise.appelAbandonne,
      `${reprise.usages ?? "?"} usage(s) neuf(s), catalogue relu ${reprise.catalogue ?? "?"} fois, file ${m.reprise.file.reprise} → ${m.reprise.file.fin}, appel en cours abandonné : ${m.reprise.appelAbandonne}`,
    );
    ajouter("B : la salle repart à neuf après la reprise (nouveau démarrage, prête)", relanceB.ok && m.reprise.relance.startIdNeuf, JSON.stringify(m.reprise.relance));
    if (!relanceB.ok) return fin();

    // --- A. Homme mort : le cockpit tué et laissé mort, pendant une demande ---------------------------------------------------
    const horloge = await decalageHorloge(ctx);
    m.horloge = horloge;
    await ctx.faux.reinitialiser();
    const dA = await jouerDemande(ctx, client, { reponses: demandeLongue(dossier), texteEnvoi: "Travaille longtemps (G9, homme mort).", plafond: PLAFOND_G9, model });
    ajouter("A : une demande tourne quand le cockpit meurt", dA.ok && (await reponseLenteEnCours(ctx)), dA.etape);
    if (!dA.ok) return fin();
    // Témoin du relevé : opencode est VU dans la salle juste avant le kill.
    const avantKill = await sonderOpencode(ctx);
    const tueA = await ctx.compose(["kill", SERVICE_COCKPIT], { delaiMs: 60_000 });
    const tueAt = Date.now();
    // Le fichier garde le DERNIER battement écrit : le cockpit, tué, n'en écrit plus aucun.
    const battement = await lireControle(ctx, "heartbeat");
    let arret = null;
    let sansReponse = 0;
    const debut = Date.now();
    while (Date.now() - debut < 90_000) {
      const sonde = await sonderOpencode(ctx);
      // Salle muette : conteneur qui redémarre (le superviseur est sorti, opencode avant lui), ou simple lenteur. Seule une sortie
      // du conteneur postérieure au dernier battement le prouve (constaterArret).
      if (sonde === null) sansReponse += 1;
      arret = constaterArret({ sonde, sortie: sonde === null ? await sortieConteneur(ctx) : null, dernierBattementAt: battement?.at });
      if (arret !== null) break;
      await ctx.attendre(400);
    }
    const homme = jugerHommeMort({ tournaitAvant: avantKill !== null && avantKill.n >= 1, dernierBattementAt: battement?.at, arreteAt: arret?.at, arrete: arret !== null });
    m.hommeMort = {
      kill: tueA.code,
      opencodeAvantKill: avantKill?.n ?? null,
      dernierBattement: battement?.at ?? null,
      arret,
      sondesSansReponse: sansReponse,
      delaiS: homme.delaiS,
      borneS: BORNE_S,
      tueApresS: battement?.at && horloge ? Number(((tueAt + horloge.decalageMs - battement.at) / 1000).toFixed(2)) : null,
    };
    ajouter(
      `A : docker kill du cockpit → opencode de la salle arrêté en ${BORNE_S} s au plus depuis le dernier battement écrit`,
      tueA.code === 0 && homme.ok,
      `${homme.detail} ; ${arret?.par ?? "arrêt non constaté"} ; opencode avant le kill : ${avantKill?.n ?? "?"} processus`,
    );

    // Aucun redémarrage d'opencode sans battement frais ; aucun appel au faux après l'arrêt.
    const appelsArret = (await journalFaux(ctx))?.recues ?? null;
    await ctx.attendre(SANS_BATTEMENT_S * 1000);
    const s = await sonderOpencode(ctx);
    const etat = await ctx.etat();
    const appelsApres = (await journalFaux(ctx))?.recues ?? null;
    m.sansBattement = { opencode: s?.n ?? null, phase: etat?.phase ?? null, appels: { arret: appelsArret, apres: appelsApres } };
    ajouter(
      `A : aucun redémarrage d'opencode sans battement frais (${SANS_BATTEMENT_S} s après l'arrêt)`,
      s !== null && s.n === 0 && etat?.phase !== "opencode-lance",
      `opencode ${s?.n ?? "?"} processus, phase ${etat?.phase ?? "illisible"}`,
    );
    ajouter("A : aucun appel au faux fournisseur après l'arrêt", typeof appelsArret === "number" && appelsApres === appelsArret, `${appelsArret} → ${appelsApres}`);

    // Remise en marche : le cockpit rallumé bat de nouveau, la salle redevient prête (pile propre pour la suite).
    const rallumeA = await ctx.compose(["start", SERVICE_COCKPIT], { delaiMs: 180_000 });
    client = await connecter();
    const revenue = await attendreEtatSalle(client, ["prete"], { delaiMs: 240_000, pasMs: 1000 });
    m.remiseEnMarche = { start: rallumeA.code, etat: revenue.etat, attenteS: Math.round(revenue.attenteMs / 1000) };
    ajouter("A : cockpit rallumé → battement repris, la salle redevient prête", rallumeA.code === 0 && revenue.ok, JSON.stringify(m.remiseEnMarche));
    return fin();
  },
};
