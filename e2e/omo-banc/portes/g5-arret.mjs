// Porte G5 (L27a) — Arrêt, sur le banc COMPLET (spécification §7.6 l.1160, §7.10 l.1219 ; plan §6 fiche L27a, §7 ; §3.12.1 ;
// D-2b-26, D-2b-30, D-2b-36, D-2b-37 ; JS-1).
//
// Une vraie demande tourne dans la salle derrière le cockpit RÉEL (activation, envoi, un appel d'outil, puis une réponse lente du
// faux fournisseur) ; « Arrêter » (POST /api/omo/rooms/:rootId/stop, D-2b-30) déclenche stopTreeOmo. La porte prouve alors :
//   1. aucune session occupée en 10 s : `GET /session/status` de la salle sans session occupée, ou opencode de la demande déjà
//      arrêté (autre démarrage publié, phase « arret ») — une salle arrêtée n'a plus rien d'occupé ; l'arrêt est confirmé ;
//   2. RIEN pendant 180 s : aucun message, aucun usage (tout appel au faux fournisseur ; seul le catalogue `GET /models` relu par
//      l'opencode relancé n'en est pas un, il est relevé à part), aucune session, sur les compteurs de l'espion (requêtes ET
//      événements de TOUS les flux, relance comprise), le flux du cockpit et la file du faux, qui garde intactes les réponses que la
//      demande aurait prises si elle avait continué ;
//   3. zéro POST …/command à l'espion, sur toute la porte ;
//   4. empreintes des dossiers de configuration ET d'`oc-omo-data` hors `opencode.db*` et `storage/` identiques après la relance à
//      neuf (D-2b-26, D-2b-36 : la purge du démarrage ne laisse rien d'autre survivre). Une seule entrée change par nature à chaque
//      démarrage : le journal du processus opencode (`log/`, écrit avec l'heure ; mesuré au banc le 25/09 : `log/opencode.log`, seul
//      écart). Il n'est pas comparé octet pour octet, il est prouvé RECRÉÉ : trois témoins sont posés dans `oc-omo-data` (à sa
//      racine, dans `log/` et dans un dossier) APRÈS la référence et AVANT l'arrêt, et aucun ne doit survivre à la relance ; tout
//      autre écart, et le moindre témoin survivant, rendent le point rouge ;
//   5. `.omo/boulder.json` mis de côté dans CHAQUE projet ouvert (renommé `boulder.arrete-…json`, contenu intact, jamais supprimé) :
//      depuis L16c, un carnet ne peut venir que du poste — le banc en dépose un dans chacun des deux projets préparés, et ouvre une
//      salle sur les deux.
//
// La partie « puis recette » de G5 (l'arrêt d'une VRAIE demande facturée sur Copilot) est une RECETTE EN ATTENTE (décision du 17/09
// n° 4, plan §3.3) : elle est consignée dans le bilan, jamais lancée ici, et la porte est donc « VERTE, PARTIELLE » au mieux. Une
// porte G5 rouge sans correctif appelle le repli C (§7.10 l.1211) : c'est dit dans le journal et dans les mesures.
//
// Ce fichier porte aussi les OUTILS COMMUNS aux trois portes de L27a (G9 et G13 les importent) : flux du cockpit, IA de la salle,
// demande jouée comme la page, horloge du conteneur, et l'attente du FLUX DE LA SALLE (voir `attendreFluxSalle`) : sur le banc,
// l'espion garde ouvert pendant 35 s le flux du cockpit vers un opencode relancé (constat remis, execution/mesures/L27a.md) ; une
// demande envoyée dans ces 35 s perdrait ses demandes d'autorisation, que personne ne rejoue. lib-activation.mjs et lib-arret.mjs
// (L21b) sont réutilisées, jamais réécrites. Rien ici ne lit ni ne garde un contenu de message : des codes, des types d'événement,
// des compteurs et des empreintes SHA-256. Aucune dépendance npm (P8).
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { activer, amorce, attendreEtatSalle, connecterCockpit, envoyer, modeleDeLaSalle, ouvrirSalle, passerEnAvance } from "../lib/lib-activation.mjs";
import { arreter, attendreNouveauDemarrage, comparerEmpreintes, compteursEspion, DONNEES_SALLE, empreintes, occupee } from "../lib/lib-arret.mjs";
import { appels, commande, lecture, lente, texte } from "../lib/scenarios-faux.mjs";

export const enc = encodeURIComponent;

/** Projets préparés par le banc (run-banc.mjs) : `projet-ouvert` et `projet-temoin`. */
export const PROJET = "projet-ouvert";
export const DOSSIER = `/workspace/${PROJET}`;
export const PROJETS_G5 = Object.freeze(["projet-ouvert", "projet-temoin"]);

/** Montant de G5, en CHAÎNE comme la page le saisit (lib-activation, règle 1) ; jamais une valeur par défaut du produit. */
export const PLAFOND_G5 = "0.20";
/** Aucune session occupée en 10 s après l'arrêt (§7.10 l.1219). */
export const REPOS_MAX_S = 10;
/** Rien pendant 180 s après l'arrêt (§7.10 l.1219). */
export const SILENCE_S = 180;
/** Réponses que la demande prendrait si elle continuait : elles doivent rester dans la file du faux (preuve du silence). */
export const REPONSES_GARDEES = 3;
/** Attente du flux du cockpit vers la salle rouvert (35 s de flux muet côté espion, plus la reconnexion, plus une marge). */
export const FLUX_SALLE_MAX_MS = 60_000;
/** Journal du processus opencode dans `oc-omo-data` : recréé à chaque démarrage, jamais comparé octet pour octet (point 4). */
export const JOURNAL_DONNEES = /^log(\/|$)/;
/** Témoins posés dans `oc-omo-data` avant l'arrêt : aucun ne doit survivre à la relance (purge du démarrage, D-2b-36). */
export const TEMOINS_DONNEES = Object.freeze(["temoin-g5.txt", "log/temoin-g5.txt", "temoin-g5-dossier/fichier.txt"]);

// --- Outils communs aux portes de L27a --------------------------------------------------------------------------------------------

const estObjet = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const chaine = (v, max = 200) => (typeof v === "string" && v !== "" ? v.slice(0, max) : null);

/**
 * Réduit un événement du flux du cockpit (`/api/events`) à ce qu'une porte lit : genre, type, instance et quelques identifiants.
 * Jamais un texte de message : pour une partie d'outil, seulement son nom, son état et deux booléens — « refus du filet » (message
 * « … coupé dans la salle … » de docker/opencode-omo/guard) et « échec de délégation » (sortie de `task` qui commence par « Failed
 * to delegate »), qui ne sont pas des contenus de l'utilisateur ; pour `omo.connection`, l'état du flux. null : rien à garder.
 */
export function reduireEvenement(valeur, recu) {
  if (!estObjet(valeur)) return null;
  const instance = chaine(valeur.instance, 20);
  if (valeur.kind === "cockpit") {
    if (valeur.type === "heartbeat") return null;
    const d = estObjet(valeur.data) ? valeur.data : {};
    return {
      recu,
      kind: "cockpit",
      type: chaine(valeur.type, 80),
      instance,
      cause: chaine(d.cause, 60),
      raison: chaine(d.raison, 60),
      etat: chaine(d.etat, 60),
      rootId: chaine(d.rootId, 128),
      // `omo.connection` : état du flux du cockpit vers la salle (relevé, jamais l'erreur en clair au-delà de 60 caractères).
      connecte: typeof d.connected === "boolean" ? d.connected : null,
    };
  }
  if (valeur.kind === "opencode") {
    const ev = estObjet(valeur.event) ? valeur.event : {};
    const p = estObjet(ev.properties) ? ev.properties : {};
    const info = estObjet(p.info) ? p.info : {};
    const part = estObjet(p.part) ? p.part : {};
    const etatPart = estObjet(part.state) ? part.state : {};
    const type = chaine(ev.type, 80);
    return {
      recu,
      kind: "opencode",
      type,
      instance,
      sessionId: chaine(info.id, 128) ?? chaine(p.sessionID, 128) ?? chaine(part.sessionID, 128) ?? chaine(info.sessionID, 128),
      parentId: type === "session.created" || type === "session.updated" ? chaine(info.parentID, 128) : null,
      requestId: chaine(p.requestID, 128) ?? (type === "permission.asked" ? chaine(p.id, 128) : null),
      reply: chaine(p.reply, 20),
      statut: estObjet(p.status) ? chaine(p.status.type, 20) : null,
      outil: part.type === "tool" ? chaine(part.tool, 64) : null,
      etatOutil: part.type === "tool" ? chaine(etatPart.status, 20) : null,
      refusFiletCoupe: part.type === "tool" && typeof etatPart.error === "string" ? /coup[ée] dans la salle/.test(etatPart.error) : null,
      // Délégation refusée par l'extension elle-même (sortie de `task` : « Failed to delegate … ») : UN booléen, jamais la sortie.
      echecDelegation: part.type === "tool" && part.tool === "task" && typeof etatPart.output === "string" ? /^Failed to delegate\b/.test(etatPart.output) : null,
    };
  }
  return null;
}

/** Bloc SSE → `{ nom, valeur }` (lignes `event:` et `data:`), comme les scénarios du banc e2e. */
export function lireBlocSse(bloc) {
  const lignes = String(bloc).split("\n");
  const nom = lignes.find((l) => l.startsWith("event:"))?.slice(6).trim() ?? null;
  const donnees = lignes
    .filter((l) => l.startsWith("data:"))
    .map((l) => l.slice(5).replace(/^ /, ""))
    .join("\n");
  if (!donnees) return { nom, valeur: null };
  try {
    return { nom, valeur: JSON.parse(donnees) };
  } catch {
    return { nom, valeur: null };
  }
}

/**
 * Moniteur du flux d'événements du cockpit RÉEL (mode Avancé : les événements de la salle n'y passent qu'en Avancé). Chaque
 * événement est horodaté à sa réception, sur l'horloge de l'hôte : un fait de la salle relayé et l'arrêt qui le suit sont donc
 * mesurés sur la MÊME horloge. Rend `{ evenements, depuis, attendre, fermer }`.
 */
export async function ouvrirMoniteur(client, { delaiHelloMs = 15_000, max = 50_000 } = {}) {
  const controleur = new AbortController();
  const evenements = [];
  const reponse = await client.flux("/api/events", { signal: controleur.signal });
  if (!reponse.ok || !reponse.corps) throw new Error(`flux d'événements du cockpit refusé (code ${reponse.status})`);
  let bonjour;
  const hello = new Promise((resolve) => {
    bonjour = resolve;
  });
  const lecture = (async () => {
    const decodeur = new TextDecoder();
    let tampon = "";
    for await (const morceau of reponse.corps) {
      tampon += (typeof morceau === "string" ? morceau : decodeur.decode(morceau, { stream: true })).replaceAll("\r\n", "\n");
      for (let fin = tampon.indexOf("\n\n"); fin >= 0; fin = tampon.indexOf("\n\n")) {
        const { nom, valeur } = lireBlocSse(tampon.slice(0, fin));
        tampon = tampon.slice(fin + 2);
        if (nom === "hello") {
          bonjour();
          continue;
        }
        const e = reduireEvenement(valeur, Date.now());
        if (e !== null) {
          evenements.push(e);
          if (evenements.length > max) evenements.splice(0, evenements.length - max);
        }
      }
      if (tampon.length > 4_000_000) tampon = "";
    }
  })().catch(() => undefined);
  let minuteur;
  const accueilli = await Promise.race([hello.then(() => true), new Promise((resolve) => (minuteur = setTimeout(() => resolve(false), delaiHelloMs)))]);
  clearTimeout(minuteur);
  if (!accueilli) {
    controleur.abort();
    throw new Error(`flux d'événements du cockpit : aucun « hello » en ${delaiHelloMs / 1000} s`);
  }
  return {
    evenements,
    depuis: (t) => evenements.filter((e) => e.recu >= t),
    /** Premier événement reçu depuis `t` qui satisfait `test`, ou null au bout de `delaiMs`. */
    async attendre(test, { depuis = 0, delaiMs = 15_000, pasMs = 100 } = {}) {
      const fin = Date.now() + delaiMs;
      for (;;) {
        const e = evenements.find((x) => x.recu >= depuis && test(x));
        if (e !== undefined) return e;
        if (Date.now() >= fin) return null;
        await new Promise((r) => setTimeout(r, pasMs));
      }
    },
    async fermer() {
      controleur.abort();
      await lecture;
    },
  };
}

/** Événement du cockpit d'un type donné, ou d'un type d'événement de la SALLE (instance « omo »). */
export const estCockpit = (type, test = () => true) => (e) => e.kind === "cockpit" && e.type === type && test(e);
export const estSalle = (type, test = () => true) => (e) => e.kind === "opencode" && e.instance === "omo" && e.type === type && test(e);

/** Attente d'un serveur de salle qui SERT (après une relance ou une levée de suspension, mesuré : jusqu'à une minute). */
export const SALLE_SERVANTE_MAX_MS = 120_000;

/**
 * Attend que le serveur de la salle serve le projet (`GET /agent` : 200 et au moins un assistant), par l'espion. « prête », pour le
 * cockpit, veut dire « opencode lancé » (`state.json`) : le serveur peut encore ouvrir l'instance du projet, et le cockpit répond
 * alors 409 « salle-en-relance » (mesuré au banc le 25/09, juste après la levée d'une suspension). Rend `{ ok, attenteMs }`.
 */
export async function attendreSalleServante(ctx, dossier = DOSSIER, { delaiMs = SALLE_SERVANTE_MAX_MS, pasMs = 2000 } = {}) {
  const debut = Date.now();
  for (;;) {
    const r = await ctx.clientSalle.get(`/agent?directory=${enc(dossier)}`, { delaiMs: 30_000 }).catch(() => null);
    if (r !== null && r.code === 200 && Array.isArray(r.json) && r.json.length > 0) return { ok: true, attenteMs: Date.now() - debut };
    if (Date.now() - debut >= delaiMs) return { ok: false, attenteMs: Date.now() - debut };
    await new Promise((res) => setTimeout(res, pasMs));
  }
}

/**
 * IA de l'assistant par défaut de la SALLE (`default_agent` de sa configuration, puis son `model`) : la demande part directement sur
 * elle, sans le 409 « assistant-model-changed ». Repli : l'IA de la configuration, puis le catalogue (modeleDeLaSalle). null : aucune.
 * Attend d'abord que la salle serve (`attendreSalleServante`) : une salle « prête » qui ouvre encore son instance ne dit rien.
 */
export async function modeleDeLAssistant(ctx, dossier = DOSSIER) {
  await attendreSalleServante(ctx, dossier);
  const q = `directory=${enc(dossier)}`;
  const config = await ctx.clientSalle.get(`/config?${q}`, { delaiMs: 30_000 }).catch(() => null);
  const agents = await ctx.clientSalle.get(`/agent?${q}`, { delaiMs: 30_000 }).catch(() => null);
  const nom = config?.json?.default_agent;
  const agent = Array.isArray(agents?.json) ? agents.json.find((a) => a?.name === nom) : undefined;
  if (agent?.model?.providerID === "github-copilot" && typeof agent.model.modelID === "string") return { providerID: "github-copilot", modelID: agent.model.modelID };
  const m = /^github-copilot\/([A-Za-z0-9._-]{1,80})$/.exec(String(config?.json?.model ?? ""));
  if (m) return { providerID: "github-copilot", modelID: m[1] };
  const providers = await ctx.clientSalle.get(`/config/providers?${q}`, { delaiMs: 30_000 }).catch(() => null);
  return modeleDeLaSalle(providers?.json ?? null);
}

/**
 * Vrai quand l'espion relaie un flux `/global/event` OUVERT vers la salle (compteurs de l'espion, lib/espion.mjs). Le seul client
 * de ce flux, sur le banc complet, est le cockpit réel (`OPENCODE_OMO_URL` passe par l'espion) : un flux fermé côté salle (opencode
 * relancé) et pas encore rouvert, c'est un cockpit qui ne VOIT PAS la salle — aucune demande d'autorisation n'y serait répondue.
 */
export function fluxSalleOuvert(compteurs) {
  return Array.isArray(compteurs?.flux) && compteurs.flux.some((f) => f?.chemin === "/global/event" && f.ouvert === true);
}

/**
 * Attend que le cockpit voie de nouveau la salle, par l'espion (au plus `delaiMs`). Pourquoi c'est nécessaire, sur le banc : quand
 * la salle relance opencode (fin de demande, arrêt, détection), l'espion ferme le flux amont mais laisse ouvert le flux aval du
 * cockpit (défaut du banc, constat remis à l'intégrateur : `reponse.pipe(res)` ne propage pas une fermeture sans « end ») ; le
 * cockpit reste 35 s sur un flux muet (chien de garde d'opencode.ts), puis se reconnecte. Une demande envoyée dans ces 35 s perd ses
 * `permission.asked`, que le répondeur ne rejoue jamais : elle resterait occupée jusqu'au plafond de durée. Rend `{ ok, attenteMs }`.
 */
export async function attendreFluxSalle(ctx, { delaiMs = FLUX_SALLE_MAX_MS, pasMs = 500 } = {}) {
  const debut = Date.now();
  for (;;) {
    const compteurs = await compteursEspion(ctx.portEspion).catch(() => null);
    if (fluxSalleOuvert(compteurs)) return { ok: true, attenteMs: Date.now() - debut };
    if (Date.now() - debut >= delaiMs) return { ok: false, attenteMs: Date.now() - debut };
    await new Promise((r) => setTimeout(r, pasMs));
  }
}

/** Ports du banc complet : le cockpit parle à l'espion (4097), l'espion à la salle (4096) (cockpit/cockpit.compose.yml). */
export const PORT_ESPION_INTERNE = 4097;
export const PORT_SALLE = 4096;

/** États TCP du noyau Linux (colonne `st` de `/proc/net/tcp`). */
const ETATS_TCP = Object.freeze({
  "01": "ESTABLISHED",
  "02": "SYN_SENT",
  "03": "SYN_RECV",
  "04": "FIN_WAIT1",
  "05": "FIN_WAIT2",
  "06": "TIME_WAIT",
  "07": "CLOSE",
  "08": "CLOSE_WAIT",
  "09": "LAST_ACK",
  "0A": "LISTEN",
  "0B": "CLOSING",
});

/** Adresse `HHHHHHHH:PPPP` de `/proc/net/tcp` (IPv4, octets dans l'ordre de la machine) → `a.b.c.d:port` ; null sinon. */
export function adresseTcp(hex) {
  const m = /^([0-9A-F]{8}):([0-9A-F]{4})$/i.exec(String(hex ?? ""));
  if (m === null) return null;
  const octets = m[1].match(/../g).map((x) => Number.parseInt(x, 16)).reverse();
  return `${octets.join(".")}:${Number.parseInt(m[2], 16)}`;
}

/**
 * Connexions d'un `/proc/net/tcp` dont le port local OU distant vaut `port` : `{ local, distant, etat }`. Des adresses et des
 * états, aucune donnée échangée. Pure (testable sans Docker).
 */
export function connexionsTcp(texte, port) {
  const suffixe = `:${port}`;
  const out = [];
  for (const ligne of String(texte ?? "").split(/\r?\n/).slice(1)) {
    const c = ligne.trim().split(/\s+/);
    if (c.length < 4) continue;
    const local = adresseTcp(c[1]);
    const distant = adresseTcp(c[2]);
    if (local === null || distant === null || !(local.endsWith(suffixe) || distant.endsWith(suffixe))) continue;
    out.push({ local, distant, etat: ETATS_TCP[c[3].toUpperCase()] ?? c[3] });
  }
  return out;
}

/** Ligne du journal du cockpit gardée par le relevé : elle parle de la salle ou du flux, et ne porte aucun mot de secret. */
export const ligneDeJournalGardee = (ligne) =>
  /omo|salle|global\/event|flux|connexion|connection/i.test(ligne) && !/pass(word|wd)?|token|jeton|secret|authori[sz]ation|bearer|basic |cookie/i.test(ligne);

/** Nombre de relevés « flux bloqué » écrits par ce banc (un fichier par relevé). */
let releves = 0;

/**
 * Relevé fait quand le flux du cockpit vers la salle ne se rouvre pas (constat du 26/09, execution/mesures/L27a.md) : connexions TCP
 * du cockpit vers l'espion (4097), de l'espion vers la salle et de l'écoute de la salle (4096), phase de la salle, et les lignes du
 * journal du cockpit qui parlent de la salle (filtrées, bornées). Écrit `flux-bloque-<n>.json` dans la sortie du banc ; rend un
 * résumé d'une ligne. Rien de secret : des adresses, des états, des lignes sans mot de secret.
 */
export async function releverFluxBloque(ctx) {
  const tcp = async (service) => {
    const r = await ctx.exec(service, ["cat", "/proc/net/tcp"], { delaiMs: 20_000 }).catch(() => null);
    return r !== null && r.code === 0 ? String(r.sortie) : null;
  };
  const lire = (texte, port) => (texte === null ? "illisible" : connexionsTcp(texte, port));
  const journal = await ctx.logs("cockpit", { lignes: 800 }).catch(() => "");
  const etat = await ctx.etat();
  const releve = {
    at: new Date().toISOString(),
    salle: etat === null ? null : { phase: etat.phase ?? null, startId: etat.startId ?? null },
    cockpitVersEspion: lire(await tcp("cockpit"), PORT_ESPION_INTERNE),
    espionVersSalle: lire(await tcp("banc-espion"), PORT_SALLE),
    ecouteSalle: lire(await tcp("opencode-omo"), PORT_SALLE),
    journalCockpit: String(journal)
      .split(/\r?\n/)
      .filter(ligneDeJournalGardee)
      .slice(-60)
      .map((l) => l.slice(0, 300)),
  };
  releves += 1;
  ctx.ecrireSortie(`flux-bloque-${releves}.json`, `${JSON.stringify(releve, null, 2)}\n`);
  const etats = (liste) => (Array.isArray(liste) ? [...new Set(liste.map((c) => c.etat))].join("+") || "aucune" : liste);
  return `relevé flux-bloque-${releves}.json : cockpit→espion ${etats(releve.cockpitVersEspion)}, espion→salle ${etats(releve.espionVersSalle)}, salle ${etats(releve.ecouteSalle)}, phase ${releve.salle?.phase ?? "?"}`;
}

/**
 * Une demande jouée comme la page : salle « prête », flux du cockpit vers la salle rouvert (`attendreFluxSalle`), salle ouverte sur
 * `projet`, réponses du faux mises en file, activation avec `plafond` (chaîne), envoi sur `model`. Rend `{ ok, salle, activation,
 * envoi, startIdAvant, debut, attenteFluxMs }` ; `ok` faux dit l'étape. Flux non rouvert : relevé des connexions (releverFluxBloque).
 */
export async function jouerDemande(ctx, client, { projet = PROJET, reponses, texteEnvoi, plafond, model, attenteMs = 180_000 }) {
  const prete = await attendreEtatSalle(client, ["prete"], { delaiMs: attenteMs, pasMs: 1000 });
  if (!prete.ok) return { ok: false, etape: `salle non prête (état ${prete.etat ?? "?"})` };
  const flux = await attendreFluxSalle(ctx);
  if (!flux.ok) {
    const releve = await releverFluxBloque(ctx).catch((err) => `relevé impossible (${String(err?.message ?? err).slice(0, 80)})`);
    return { ok: false, etape: `flux du cockpit vers la salle non rouvert en ${Math.round(flux.attenteMs / 1000)} s (espion) ; ${releve}`, attenteFluxMs: flux.attenteMs };
  }
  const etat = await ctx.etat();
  const startIdAvant = etat?.startId ?? null;
  const attenteFluxMs = flux.attenteMs;
  const salle = await ouvrirSalle(client, projet);
  if (salle.code !== 200 || salle.rootId === null) return { ok: false, etape: `ouverture refusée (${salle.code} ${salle.erreur ?? ""})`, salle, startIdAvant, attenteFluxMs };
  if (Array.isArray(reponses) && reponses.length > 0) {
    const mis = await ctx.faux.reponses({ reponses });
    if (mis.code !== 200) return { ok: false, etape: `réponses du faux refusées (${mis.code})`, salle, startIdAvant, attenteFluxMs };
  }
  const debut = Date.now();
  const activation = await activer(client, salle.rootId, plafond);
  if (activation.code < 200 || activation.code >= 300) {
    return { ok: false, etape: `activation refusée (${activation.code} ${activation.erreur ?? ""})`, salle, activation, startIdAvant, debut, attenteFluxMs };
  }
  const envoi = await envoyer(client, salle.rootId, `/workspace/${projet}`, texteEnvoi, { model });
  const ok = envoi.code >= 200 && envoi.code < 300;
  return { ok, etape: ok ? "envoyee" : `envoi refusé (${envoi.code} ${envoi.erreur ?? ""})`, salle, activation, envoi, startIdAvant, debut, attenteFluxMs };
}

/** Relance à neuf (nouveau `startId`, opencode lancé) puis salle « prête » derrière le cockpit. */
export async function attendreRelance(ctx, client, startIdAvant, { delaiMs = 180_000 } = {}) {
  const relance = await attendreNouveauDemarrage(() => ctx.etat(), startIdAvant, { delaiMs });
  const prete = relance.ok ? await attendreEtatSalle(client, ["prete"], { delaiMs: 120_000, pasMs: 1000 }) : { ok: false, etat: null };
  return { ok: relance.ok && prete.ok, relance, etat: prete.etat ?? null };
}

/** Fichier JSON du volume de contrôle (`heartbeat`, `stop-request`, `precheck-ok`…), lu par un conteneur jetable ; null sinon. */
export async function lireControle(ctx, nom) {
  const texte = await ctx.lireVolume("control-omo", nom).catch(() => null);
  if (texte === null) return null;
  try {
    return JSON.parse(texte);
  } catch {
    return null;
  }
}

/**
 * Horloge des conteneurs (celle de la machine virtuelle de Docker, commune à tous) contre celle de l'hôte : `decalageMs` =
 * conteneur − hôte, au milieu de l'aller-retour, `incertitudeMs` = demi-aller-retour. Rend null si le conteneur ne répond pas.
 */
export async function decalageHorloge(ctx) {
  const t0 = Date.now();
  const r = await ctx.exec("opencode-omo", ["date", "+%s%3N"], { delaiMs: 20_000 }).catch(() => null);
  const t1 = Date.now();
  const lu = Number(String(r?.sortie ?? "").trim());
  if (r === null || r.code !== 0 || !Number.isSafeInteger(lu)) return null;
  return { decalageMs: lu - Math.round((t0 + t1) / 2), incertitudeMs: Math.ceil((t1 - t0) / 2) };
}

/** Chemin d'hôte d'une entrée du dossier de travail jetable du banc ; refuse tout chemin qui en sortirait. */
export function cheminPoste(ctx, relatif) {
  const base = path.resolve(ctx.chemins.ws);
  const cible = path.resolve(base, ...String(relatif).split("/"));
  if (cible !== base && !cible.startsWith(`${base}${path.sep}`)) throw new Error(`chemin hors du dossier de travail du banc : ${String(relatif).slice(0, 80)}`);
  return cible;
}

export const sha256 = (tampon) => crypto.createHash("sha256").update(tampon).digest("hex");

/**
 * Écart d'activité sur TOUS les flux de l'espion : un flux ouvert après le premier instantané (la salle relancée) compte depuis
 * zéro. `ecartActivite` de lib-arret ne compte que les flux présents dans les deux instantanés : une salle relancée qui se
 * remettrait à écrire sur son nouveau flux y serait invisible. Rend le total par type, et les requêtes qui engagent la salle.
 */
export function ecartTousFlux(avant, apres) {
  const r = (cle) => (apres?.requetes?.[cle] ?? 0) - (avant?.requetes?.[cle] ?? 0);
  const deAvant = new Map((avant?.flux ?? []).map((f) => [f.n, f.types ?? {}]));
  const types = {};
  for (const f of apres?.flux ?? []) {
    const base = deAvant.get(f.n) ?? {};
    for (const [type, n] of Object.entries(f.types ?? {})) {
      const d = n - (base[type] ?? 0);
      if (d > 0) types[type] = (types[type] ?? 0) + d;
    }
  }
  return { commandes: r("commande"), envois: r("envoi") + r("message"), sessionsHttp: r("session"), abandons: r("abandon"), types };
}

/** Événements de la salle qui disent une ACTIVITÉ (jamais la simple reconnexion d'un flux) : message, session créée, session occupée. */
export function activiteDeLaSalle(evenements) {
  return evenements.filter(
    (e) =>
      e.kind === "opencode" &&
      e.instance === "omo" &&
      (e.type === "message.updated" || e.type === "session.created" || e.type === "message.part.updated" || (e.type === "session.status" && e.statut !== null && e.statut !== "idle")),
  );
}

// --- G5 : jugements purs (testables sans Docker) ---------------------------------------------------------------------------------

/** Vrai quand aucun `boulder.json` vivant ne reste, qu'une copie mise de côté porte le contenu déposé, et que rien n'est en erreur. */
export function boulderMisDeCote(constat) {
  if (!estObjet(constat) || constat.depose !== true) return false;
  return constat.vivant === false && Array.isArray(constat.misDeCote) && constat.misDeCote.length === 1 && constat.contenuIntact === true;
}

/**
 * Appels reçus par le faux fournisseur depuis le relevé `depuisN` (numéros `n` du journal du pilotage, L21a), partagés entre le
 * CATALOGUE (route « modeles » : `GET /models` qu'un opencode relancé relit, ni message, ni usage, ni session) et les USAGES : TOUT
 * le reste, la route « chat » comme une route « non-servie » (un `POST /responses`, par exemple, serait une inférence que le faux
 * ne sert pas, mais que Copilot facturerait) — fermé en cas de doute. null si le journal ne rend pas compte de tous les appels
 * comptés (`recues`). Aucun contenu : la route et le code rendu.
 */
export function appelsFauxDepuis(journal, depuisN, recuesFin) {
  if (!Array.isArray(journal) || typeof depuisN !== "number" || typeof recuesFin !== "number") return null;
  const fenetre = journal.filter((e) => typeof e?.n === "number" && e.n > depuisN);
  if (fenetre.length !== recuesFin - depuisN) return null;
  const resume = (e) => ({ n: e.n, route: typeof e.route === "string" ? e.route : "?", servie: e.servie ?? null });
  const estCatalogue = (e) => e.route === "modeles";
  return { usages: fenetre.filter((e) => !estCatalogue(e)).map(resume), catalogue: fenetre.filter(estCatalogue).map(resume) };
}

/**
 * Silence de G5 : aucune session créée, aucun message, aucun usage (appel « chat » au faux fournisseur), aucune commande, aucun
 * envoi, et les réponses gardées de la file du faux intactes. Les abandons ne comptent pas : ce sont ceux de l'arrêt lui-même.
 */
export function silenceG5({ ecart, appelsFaux, fileAvant, fileApres, activiteCockpit }) {
  if (!estObjet(ecart) || typeof appelsFaux !== "number") return false;
  const t = ecart.types ?? {};
  return (
    ecart.commandes === 0 &&
    ecart.envois === 0 &&
    ecart.sessionsHttp === 0 &&
    (t["session.created"] ?? 0) === 0 &&
    (t["message.updated"] ?? 0) === 0 &&
    (t["message.part.updated"] ?? 0) === 0 &&
    appelsFaux === 0 &&
    typeof fileAvant === "number" &&
    fileAvant === fileApres &&
    activiteCockpit === 0
  );
}

/**
 * Partage PUR des écarts d'empreintes (point 4) : `journal` = écarts du journal du processus opencode (`log/` d'`oc-omo-data`,
 * recréé à chaque démarrage), `autres` = tout le reste, qui doit être vide. Un écart dans un dossier de configuration n'est JAMAIS
 * rangé au journal, quel que soit son nom.
 */
export function partagerEcarts(ecarts) {
  const liste = Array.isArray(ecarts) ? ecarts : [];
  const estJournal = (e) => e?.racine === DONNEES_SALLE && typeof e.chemin === "string" && JOURNAL_DONNEES.test(e.chemin);
  return { journal: liste.filter(estJournal), autres: liste.filter((e) => !estJournal(e)) };
}

/**
 * Sonde lancée DANS la salle (en tant que `node`) : pose les témoins d'`oc-omo-data` (argv[1] = "poser") ou dit lesquels existent
 * encore (argv[1] = "lire"). Des fichiers de quelques octets, sans contenu utile ; rien d'autre n'est écrit ni lu.
 */
export const SONDE_TEMOINS = `
const fs = require("node:fs");
const path = require("node:path");
const base = ${JSON.stringify(DONNEES_SALLE)};
const temoins = ${JSON.stringify(TEMOINS_DONNEES)};
const out = {};
for (const t of temoins) {
  const f = path.join(base, t);
  if (process.argv[1] === "poser") {
    try { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, "temoin G5\\n"); out[t] = "pose"; } catch (e) { out[t] = "erreur:" + e.code; }
  } else {
    out[t] = fs.existsSync(f) ? "present" : "absent";
  }
}
process.stdout.write(JSON.stringify(out));
`;

async function temoins(ctx, geste) {
  const r = await ctx.exec("opencode-omo", ["node", "-e", SONDE_TEMOINS, geste], { delaiMs: 60_000 });
  try {
    return JSON.parse(String(r.sortie).trim());
  } catch {
    return null;
  }
}

/** Vrai quand chaque témoin avait été posé et qu'aucun n'a survécu à la relance. */
export function temoinsPurges(poses, lus) {
  if (!estObjet(poses) || !estObjet(lus)) return false;
  return TEMOINS_DONNEES.every((t) => poses[t] === "pose" && lus[t] === "absent");
}

/** Jugement PUR de G5 à partir des relevés. Rend la liste des points, sans effet de bord. */
export function jugerG5({ repos, silence, detailSilence, commandes, empreintesEcart, temoinsOk = false, boulders, relance }) {
  const points = [];
  const p = (nom, ok, detail) => points.push({ nom, ok: Boolean(ok), detail });
  p(
    `aucune session occupée en ${REPOS_MAX_S} s après « Arrêter », arrêt confirmé`,
    repos?.ok === true && typeof repos.attenteMs === "number" && repos.attenteMs <= REPOS_MAX_S * 1000,
    repos ? `${(repos.attenteMs / 1000).toFixed(1)} s (${repos.comment ?? "?"})` : "non mesuré",
  );
  p(`rien pendant ${SILENCE_S} s : aucun message, usage ni session (espion, flux du cockpit, file du faux)`, silence === true, detailSilence ?? "");
  p("zéro POST …/command vers la salle sur toute la porte (D-2b-30)", commandes === 0, `${commandes ?? "?"} commande(s)`);
  p("relance à neuf après l'arrêt (nouveau startId, salle prête)", relance?.ok === true, relance?.relance?.startId ? `startId ${relance.relance.startId.slice(0, 8)}…` : "aucune relance vue");
  const lisibles = Array.isArray(empreintesEcart);
  const { journal, autres } = partagerEcarts(empreintesEcart);
  const decrire = (liste) => liste.slice(0, 4).map((e) => `${e.ecart} ${e.chemin}`).join(", ");
  let detailEmpreintes = "empreintes illisibles";
  if (lisibles) {
    const reste = autres.length > 0 ? ` : ${decrire(autres)}` : "";
    const recree = journal.length > 0 ? ` ; journal du processus recréé (${decrire(journal)})` : "";
    detailEmpreintes = `${autres.length} écart(s)${reste}${recree} ; témoins d'oc-omo-data purgés : ${temoinsOk}`;
  }
  p(
    "empreintes des dossiers de configuration et d'oc-omo-data (hors opencode.db*, storage/) identiques après la relance, journal du processus (log/) recréé, aucun témoin survivant",
    lisibles && autres.length === 0 && temoinsOk === true,
    detailEmpreintes,
  );
  const liste = Array.isArray(boulders) ? boulders : [];
  p(
    `boulder.json mis de côté dans chaque projet ouvert (${liste.length}), renommé et intact, jamais supprimé`,
    liste.length >= 2 && liste.every((b) => boulderMisDeCote(b)),
    JSON.stringify(liste.map((b) => ({ projet: b.projet, vivant: b.vivant, misDeCote: b.misDeCote, intact: b.contenuIntact }))),
  );
  return points;
}

/** Carnet synthétique déposé depuis le poste : aucune forme de l'extension recopiée (D-2b-31), seulement de quoi être reconnu. */
const carnetDuBanc = (projet) => `${JSON.stringify({ banc: "G5", projet, note: "carnet synthétique déposé par le banc" })}\n`;

/** Relevé d'un projet après l'arrêt : `boulder.json` vivant ou non, copies mises de côté, contenu intact (empreinte). */
function constatBoulder(ctx, projet, empreinteDeposee) {
  const dossier = cheminPoste(ctx, `${projet}/.omo`);
  let noms = [];
  try {
    noms = fs.readdirSync(dossier);
  } catch (err) {
    return { projet, depose: true, erreur: String(err?.code ?? "illisible") };
  }
  // Nom de L23b (`nomBoulderArrete`) ; en cas de collision, renommerSansSuivreLiens (L19a) ajoute « -<essai> » au nom entier.
  const misDeCote = noms.filter((n) => /^boulder\.arrete-\d+\.json(?:-\d+)?$/.test(n));
  const intact = misDeCote.length === 1 && sha256(fs.readFileSync(path.join(dossier, misDeCote[0]))) === empreinteDeposee;
  return { projet, depose: true, vivant: noms.includes("boulder.json"), misDeCote, contenuIntact: intact };
}

/**
 * « Aucune session occupée » après l'arrêt, sondée toutes les 250 ms : `GET /session/status` de la salle (par l'espion) sans session
 * occupée, OU opencode de la demande arrêté (state.json publie un autre démarrage ou la phase « arret »). Une salle injoignable
 * sans preuve d'arrêt n'est PAS au repos (fermé en cas de doute).
 */
async function attendreAucuneOccupee(ctx, startIdDemande, debut, { delaiMs = 30_000 } = {}) {
  for (;;) {
    const r = await ctx.clientSalle.get(`/session/status?directory=${enc(DOSSIER)}`, { delaiMs: 2_000 }).catch(() => null);
    if (r !== null && r.code === 200 && !occupee(r.json)) return { ok: true, attenteMs: Date.now() - debut, comment: "GET /session/status : aucune session occupée" };
    const etat = await ctx.etat();
    if (etat !== null && (etat.startId !== startIdDemande || etat.phase === "arret")) {
      return { ok: true, attenteMs: Date.now() - debut, comment: `opencode de la demande arrêté (phase ${etat.phase}${etat.startId !== startIdDemande ? ", autre démarrage" : ""})` };
    }
    if (Date.now() - debut >= delaiMs) return { ok: false, attenteMs: Date.now() - debut, comment: "sessions encore occupées ou état illisible" };
    await new Promise((res) => setTimeout(res, 250));
  }
}

/** Ouvre l'instance d'opencode sur chaque projet (lecture seule, `GET /agent`) : les deux relevés d'empreintes la voient ouverte. */
async function ouvrirInstances(ctx) {
  for (const projet of PROJETS_G5) await ctx.clientSalle.get(`/agent?directory=${enc(`/workspace/${projet}`)}`, { delaiMs: 60_000 }).catch(() => null);
}

export default {
  id: "g5",
  titre: "Arrêt : après « Arrêter », repos en 10 s, rien pendant 180 s, zéro commande, empreintes identiques, boulder.json mis de côté",
  async executer(ctx) {
    const points = [];
    const enAttente = [];
    const m = {};
    const mesures = { g5: m };
    const ajouter = (nom, ok, detail) => points.push({ nom, ok: Boolean(ok), detail });
    const fin = () => {
      if (points.some((pt) => !pt.ok)) {
        m.repliC = "G5 rouge : sans correctif, repli C (§7.10 l.1211) — la salle reste coupée";
        ctx.dire(`  REPLI C à signaler : ${m.repliC}`);
      }
      ctx.ecrireSortie("g5-arret.json", `${JSON.stringify({ points, enAttente, mesures: m }, null, 2)}\n`);
      return { points, mesures, enAttente };
    };

    if (!ctx.cockpitPort || !ctx.cockpitJeton) return { sansObjet: "G5 : lancée hors du mode --complet (aucun cockpit réel à joindre)" };
    enAttente.push({
      etape: "G5 puis recette",
      raison: "arrêt d'une VRAIE demande facturée sur Copilot : recette en attente (décision du 17/09 n° 4, plan §3.3), jamais lancée par le banc",
    });

    const client = await connecterCockpit({ port: ctx.cockpitPort, jeton: ctx.cockpitJeton, delaiMs: 180_000 });
    const avance = await passerEnAvance(client);
    ajouter("le cockpit réel passe en mode Avancé", avance.code === 200, `code ${avance.code}`);
    const boot = await amorce(client);
    if (boot.json?.omo?.salleOuverte !== true) {
      ajouter("l'image du cockpit porte SALLE_OUVERTE=true", false, JSON.stringify(boot.json?.omo ?? null));
      return fin();
    }
    if (ctx.activationLivree !== true) {
      ajouter("l'activation « omo » est livrée par la tête éprouvée (L22c)", false, "cockpit bâti sans l'activation : G5 ne peut rien arrêter");
      return fin();
    }
    const moniteur = await ouvrirMoniteur(client);
    try {
      const prete = await attendreEtatSalle(client, ["prete"], { delaiMs: 240_000, pasMs: 2000 });
      ajouter("la salle est « prête » derrière le cockpit réel", prete.ok, `état ${prete.etat ?? "?"} en ${Math.round(prete.attenteMs / 1000)} s`);
      if (!prete.ok) return fin();
      const model = await modeleDeLAssistant(ctx);
      m.model = model;
      if (model === null) {
        ajouter("la salle sert une IA github-copilot (assistant par défaut)", false, "aucune IA lisible");
        return fin();
      }

      // 5 (préparation) : un carnet déposé DEPUIS LE POSTE dans chaque projet préparé, et une salle ouverte sur chacun.
      const depots = {};
      for (const projet of PROJETS_G5) {
        const cible = cheminPoste(ctx, `${projet}/.omo/boulder.json`);
        fs.mkdirSync(path.dirname(cible), { recursive: true });
        const contenu = carnetDuBanc(projet);
        fs.writeFileSync(cible, contenu);
        depots[projet] = sha256(Buffer.from(contenu));
      }
      const temoin = await ouvrirSalle(client, "projet-temoin");
      ajouter("une salle s'ouvre aussi sur le second projet préparé (deux projets ouverts)", temoin.code === 200 && temoin.rootId !== null, `code ${temoin.code}`);

      // 4 (référence) : instance ouverte sur les deux projets, puis empreintes, salle prête, AVANT la demande.
      await ouvrirInstances(ctx);
      const empAvant = await empreintes(ctx);
      m.empreintesAvant = { ok: empAvant.ok, erreur: empAvant.erreur, racines: empAvant.empreintes ? Object.fromEntries(Object.entries(empAvant.empreintes).map(([r, t]) => [r, Object.keys(t).length])) : null };
      ajouter("empreintes de référence relevées dans la salle (en tant que node)", empAvant.ok, empAvant.erreur ?? "");
      // Témoins APRÈS la référence : absents d'elle, ils ne doivent pas davantage être là après la relance (purge du démarrage).
      const poses = await temoins(ctx, "poser");
      m.temoins = { poses };

      // La demande : un appel d'outil, puis une réponse LENTE du faux (la session reste occupée), puis des réponses qui ne doivent
      // jamais être prises. Tout ce que le cockpit envoie à la salle, depuis ici, est compté.
      const departEspion = await compteursEspion(ctx.portEspion);
      await ctx.faux.reinitialiser();
      const reponses = [
        appels(lecture(`${DOSSIER}/LISEZMOI.md`)),
        lente(55_000, "Réponse lente du faux : la demande est encore occupée."),
        appels(commande("git status --short", "état du dépôt")),
        texte("Réponse qui ne doit jamais partir."),
        texte("Réponse qui ne doit jamais partir."),
      ];
      const demande = await jouerDemande(ctx, client, { reponses, texteEnvoi: "Lis le LISEZMOI et prends ton temps.", plafond: PLAFOND_G5, model });
      m.demande = {
        etape: demande.etape,
        activation: demande.activation?.code ?? null,
        envoi: demande.envoi?.code ?? null,
        renvoye: demande.envoi?.renvoye ?? null,
        attenteFluxS: typeof demande.attenteFluxMs === "number" ? Math.round(demande.attenteFluxMs / 1000) : null,
      };
      ajouter(`demande lancée dans la salle (activation à ${PLAFOND_G5} $, envoi)`, demande.ok, demande.etape);
      if (!demande.ok) return fin();
      const rootId = demande.salle.rootId;

      // La demande travaille : la réponse lente est en cours au faux (deuxième appel « chat » reçu, pas encore servi).
      const enCours = await ctx.jusqua(
        async () => {
          const j = (await ctx.faux.journal()).json?.journal ?? [];
          const chats = j.filter((e) => e.route === "chat");
          return chats.length >= 2 && chats[chats.length - 1].servie === null;
        },
        { delaiMs: 60_000, pasMs: 500 },
      );
      const statut = await ctx.clientSalle.get(`/session/status?directory=${enc(DOSSIER)}`, { delaiMs: 5_000 }).catch(() => null);
      m.avantArret = { reponseLenteEnCours: enCours, sessionOccupee: statut?.code === 200 ? occupee(statut.json) : null };
      ajouter("avant l'arrêt, la demande est occupée (réponse lente en cours au faux)", enCours && m.avantArret.sessionOccupee === true, JSON.stringify(m.avantArret));

      // --- « Arrêter » ---------------------------------------------------------------------------------------------------------
      const debutArret = Date.now();
      const stop = await arreter(client, rootId);
      m.arret = { code: stop.code, erreur: stop.erreur, dureeRouteMs: Date.now() - debutArret };
      ajouter("« Arrêter » accepté (POST /api/omo/rooms/:rootId/stop → stopTreeOmo)", stop.code === 200 && stop.json?.arretee === true, `code ${stop.code}, ${m.arret.dureeRouteMs} ms`);
      const arretee = await moniteur.attendre(estCockpit("conversation.arretee", (e) => e.rootId === rootId), { depuis: debutArret, delaiMs: 5_000 });
      const confirme = moniteur.depuis(debutArret).find(estCockpit("omo.recreation", (e) => e.raison === "vous" && (e.etat === "arret-confirme" || e.etat === "arret-non-confirme")));
      m.arret.recreation = confirme?.etat ?? null;
      m.arret.conversationArretee = arretee !== null;
      ajouter("stopTreeOmo confirme l'arrêt de la salle (omo.recreation « arret-confirme »)", confirme?.etat === "arret-confirme", `omo.recreation ${confirme?.etat ?? "absent"}`);
      const stopRequest = await lireControle(ctx, "stop-request");
      m.arret.stopRequest = stopRequest === null ? null : { cause: stopRequest.cause, startIdVise: stopRequest.startId === demande.startIdAvant };
      ajouter("stop-request « vous » écrit pour le démarrage de la demande", stopRequest?.cause === "vous" && stopRequest.startId === demande.startIdAvant, JSON.stringify(m.arret.stopRequest));

      // 1. Aucune session occupée en 10 s.
      const repos = await attendreAucuneOccupee(ctx, demande.startIdAvant, debutArret);
      m.repos = repos;

      // 2. Rien pendant 180 s, à partir de la fin de l'arrêt.
      const t0 = Date.now();
      const espion0 = await compteursEspion(ctx.portEspion);
      const faux0 = (await ctx.faux.journal()).json;
      ctx.dire(`  G5 : ${SILENCE_S} s d'observation, rien ne doit bouger dans la salle…`);
      await ctx.attendre(SILENCE_S * 1000);
      const espion1 = await compteursEspion(ctx.portEspion);
      const faux1 = (await ctx.faux.journal()).json;
      const ecart = ecartTousFlux(espion0, espion1);
      // Seul le catalogue (`GET /models`) que l'opencode relancé relit n'est pas un usage : il est relevé à part, jamais passé sous
      // silence (mesuré le 25/09 : un appel « modeles » dans la fenêtre, file intacte). Tout autre appel au faux est un usage.
      const fenetreFaux = appelsFauxDepuis(faux1?.journal, faux0?.recues, faux1?.recues);
      const appelsFaux = fenetreFaux === null ? undefined : fenetreFaux.usages.length;
      const activite = activiteDeLaSalle(moniteur.depuis(t0));
      const silence = silenceG5({ ecart, appelsFaux, fileAvant: faux0?.enFile?.ordre, fileApres: faux1?.enFile?.ordre, activiteCockpit: activite.length });
      m.silence = {
        fenetreS: Math.round((Date.now() - t0) / 1000),
        ecart,
        appelsFaux: fenetreFaux === null ? "journal du faux incomplet" : { usages: fenetreFaux.usages, catalogue: fenetreFaux.catalogue },
        file: { avant: faux0?.enFile?.ordre ?? null, apres: faux1?.enFile?.ordre ?? null, gardees: REPONSES_GARDEES },
        activiteCockpit: activite.map((e) => ({ type: e.type, statut: e.statut })).slice(0, 20),
        abandonsDeLaDemande: (faux1?.journal ?? []).filter((e) => e.abandon === true).length,
      };
      const detailSilence = JSON.stringify({
        types: ecart.types,
        envois: ecart.envois,
        sessions: ecart.sessionsHttp,
        commandes: ecart.commandes,
        usagesFaux: appelsFaux ?? "illisible",
        catalogueFaux: fenetreFaux === null ? "illisible" : fenetreFaux.catalogue.map((e) => `${e.route}:${e.servie}`),
        file: m.silence.file,
        activite: activite.length,
      });

      // Relance à neuf (déjà faite pendant la fenêtre, d'ordinaire), puis empreintes.
      const relance = await attendreRelance(ctx, client, demande.startIdAvant);
      m.relance = { ok: relance.ok, attenteMs: relance.relance.attenteMs, startIdNeuf: relance.relance.startId !== null && relance.relance.startId !== demande.startIdAvant };
      await ouvrirInstances(ctx);
      const empApres = relance.ok ? await empreintes(ctx) : { ok: false, empreintes: null };
      const empreintesEcart = empAvant.ok && empApres.ok ? comparerEmpreintes(empAvant.empreintes, empApres.empreintes) : null;
      m.empreintesEcart = empreintesEcart;
      m.temoins.lus = relance.ok ? await temoins(ctx, "lire") : null;
      const temoinsOk = temoinsPurges(m.temoins.poses, m.temoins.lus);
      m.temoins.purges = temoinsOk;

      // 3. Zéro POST …/command sur toute la porte.
      const finEspion = await compteursEspion(ctx.portEspion);
      const commandes = (finEspion?.requetes?.commande ?? 0) - (departEspion?.requetes?.commande ?? 0);
      m.commandes = commandes;

      // 5. boulder.json de chaque projet ouvert.
      const boulders = PROJETS_G5.map((projet) => constatBoulder(ctx, projet, depots[projet]));
      m.boulders = boulders;

      for (const pt of jugerG5({ repos, silence, detailSilence, commandes, empreintesEcart, temoinsOk, boulders, relance })) points.push(pt);
      return fin();
    } finally {
      await moniteur.fermer();
    }
  },
};
