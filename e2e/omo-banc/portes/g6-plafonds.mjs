// Porte G6 « Plafonds » sur le banc COMPLET (L27b ; spécification §7.10 l.1220, §7.6 l.1160 ; plan 2 bis-2 ter §6 fiche L27b, §7).
// Cockpit RÉEL (image bâtie par `git archive`, `SALLE_OUVERTE` basculée dans la copie seulement), salle réelle, faux Copilot hors
// ligne : aucun appel facturé, aucun jeton.
//
// Cas joués (identifiants entre crochets ; rejeu isolé par `BANC_L27B_CAS=g6:<cas>`, variable du BANC, jamais lue par le produit) :
//   [refus]       champ vide ou hors bornes, confirmation absente → 409 et sa phrase, SANS AUCUN envoi (espion et faux à zéro) ;
//   [tentatives]  réponses 429 d'affilée → arrêt « plafond-tentatives », aucun appel après l'arrêt ;
//   [cout]        montant saisi par le script ; deux sessions occupées en même temps (concurrence 2 : la racine et une session
//                 enfant) ; dépassement d'AU PLUS un appel par session occupée ; arrêt « plafond-cout » ;
//   [sessions]    plus de 30 sessions créées pendant la demande → arrêt « plafond-sessions » ;
//   [mensuel]     seuil de 80 % du budget du mois franchi pendant la demande → arrêt « seuil-mensuel » (budget rétabli ensuite) ;
//   [redemarrage] cockpit redémarré PENDANT le travail d'une session enfant → aucun appel au faux après la reprise, salle relancée ;
//
// Sessions enfants : l'extension ne délègue pas dans la salle (`task` rend « Failed to delegate … agents.some is not a function »,
// constat de L27a, relevé à nouveau par [cout] et [redemarrage]). Les sessions enfants dont G6 a besoin naissent donc par l'API de
// la salle, avec le mot de passe de la salle que le banc tire (enfantParLApi) : pour le cockpit, le chemin est celui d'une
// délégation — un `session.created` de la salle dont le parent est la racine, compté dans l'arbre de la demande. Seul l'auteur de la
// session change ; ce que G6 éprouve (plafonds, arrêt, reprise) ne dépend pas de lui.
//   [duree]       une demande occupée 60 minutes → arrêt « plafond-duree ». Joué seulement avec `BANC_G6_DUREE=1` (exécution dédiée
//                 d'environ 62 min) ; sinon EN ATTENTE, jamais vert.
//
// Rien du contenu n'est lu : codes, compteurs de l'espion, journal du faux (IA, session, nombre d'outils servis, code), faits du
// cockpit, dépense du registre. Le montant part toujours en CHAÎNE (lib-activation, règle 1).
//
// Ce fichier porte aussi les OUTILS COMMUNS aux trois portes de L27b (G6, G7, G8), exportés : un fichier de `portes/` est chargé
// comme une porte, il n'y a donc pas de module d'outils à part. Les bibliothèques du banc (lib/, L21b) sont réutilisées telles
// quelles, jamais modifiées. Aucune dépendance npm (P8) : modules `node:` seulement.
import fs from "node:fs";
import path from "node:path";
import process from "node:process";

import { activer, attendreEtatSalle, CONFIRMATION, connecterCockpit, ouvrirSalle, passerEnAvance, statutSalle } from "../lib/lib-activation.mjs";
import { arreter, ecartActivite, releverActivite } from "../lib/lib-arret.mjs";
import { appels, lecture, outil, serie429, texte } from "../lib/scenarios-faux.mjs";

// --- Outils communs aux portes de L27b ---------------------------------------------------------------------------------------------

/** Projet ouvert par les portes, et projet préparé jamais ouvert (témoin de la portée « prepares »). */
export const PROJET = "projet-ouvert";
export const PROJET_TEMOIN = "projet-temoin";
export const DOSSIER = `/workspace/${PROJET}`;

/** Usage d'une réponse « chère » : 1 000 jetons d'entrée et de sortie, soit 0,012 $ sur claude-sonnet-5 (grille du cockpit). */
export const USAGE_CHER = Object.freeze({ entree: 1000, sortie: 1000 });

const enc = encodeURIComponent;
export const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Dernière racine de salle ouverte par les outils communs : `assainir` l'arrête si un cas la laisse active. */
let dernierRoot = null;
/** Note la dernière racine ouverte (isolation des cas). */
export const marquerRoot = (rootId) => {
  if (typeof rootId === "string" && rootId !== "") dernierRoot = rootId;
};

/** Réponse du faux rendue « chère » (plafonds mesurés en appels, pas en jetons) et, si demandé, lente (60 s au plus). */
export function cher(reponse, delaiMs) {
  return { ...reponse, usage: { ...USAGE_CHER }, ...(delaiMs === undefined ? {} : { delaiMs }) };
}

/** Réponse du faux ralentie (délai avant le premier octet, 60 s au plus : borne du faux). */
export function lente(reponse, delaiMs) {
  return { ...reponse, delaiMs };
}

/** Cas demandés pour un rejeu isolé : `BANC_L27B_CAS=g6:cout,g7:*` ; sans variable, tous. */
export function casDemande(porte, cas) {
  const brut = String(process.env.BANC_L27B_CAS ?? "").trim();
  if (brut === "") return true;
  const voulus = brut.split(",").map((x) => x.trim().toLowerCase());
  return voulus.includes(`${porte}:${cas}`) || voulus.includes(`${porte}:*`);
}

/** Accumulateur de points, d'étapes en attente et de mesures d'une porte. */
export function registre() {
  const points = [];
  const enAttente = [];
  const mesures = {};
  return {
    points,
    enAttente,
    mesures,
    ajouter(nom, ok, detail) {
      points.push({ nom, ok: Boolean(ok), ...(detail === undefined ? {} : { detail: String(detail).slice(0, 900) }) });
      return Boolean(ok);
    },
    attendre(etape, raison) {
      enAttente.push({ etape, raison });
    },
    rendu() {
      return { points, enAttente, mesures };
    },
  };
}

/** Cockpit RÉEL du banc ouvert et passé en mode Avancé ; null hors du mode complet (la porte dit alors « sans objet »). */
export async function ouvrirCockpit(ctx) {
  if (!ctx?.cockpitPort || !ctx?.cockpitJeton) return null;
  const client = await connecterCockpit({ port: ctx.cockpitPort, jeton: ctx.cockpitJeton, delaiMs: 180_000 });
  const avance = await passerEnAvance(client);
  return { client, avance };
}

/**
 * Type d'un événement du flux du cockpit (`BrowserEvent`, hub.ts) : `{kind: "cockpit", type, data}` ou `{kind: "opencode",
 * event: {type, properties}}`, avec `instance` quand il vient de la salle.
 */
export function typeEvenement(e) {
  if (e?.kind === "opencode") return typeof e.event?.type === "string" ? e.event.type : null;
  return typeof e?.type === "string" ? e.type : null;
}

/**
 * Écoute du flux du cockpit (`GET /api/events`) : chaque événement est gardé avec l'heure de RÉCEPTION (horloge de l'hôte). Seuls
 * le type, les données bornées et l'instance sont gardés. Un flux coupé (cockpit redémarré) s'arrête sans erreur ; `rouvrir` en
 * ouvre un autre sur un nouveau client.
 */
export function ecouter(client) {
  const evenements = [];
  let controleur = null;
  const ouvrir = (c) => {
    controleur = new AbortController();
    const signal = controleur.signal;
    void (async () => {
      try {
        const r = await c.flux("/api/events", { signal });
        if (!r?.ok || !r.corps) return;
        const lecteur = r.corps.getReader();
        const decodeur = new TextDecoder();
        let tampon = "";
        for (;;) {
          const { value, done } = await lecteur.read();
          if (done) break;
          tampon += decodeur.decode(value, { stream: true });
          let coupe = tampon.indexOf("\n\n");
          while (coupe !== -1) {
            const bloc = tampon.slice(0, coupe);
            tampon = tampon.slice(coupe + 2);
            coupe = tampon.indexOf("\n\n");
            const ligne = bloc.split("\n").find((l) => l.startsWith("data:"));
            if (ligne === undefined) continue;
            try {
              const e = JSON.parse(ligne.slice(5).trim());
              const type = typeEvenement(e);
              if (type !== null && type !== "heartbeat") {
                const data = e.kind === "opencode" ? (e.event?.properties ?? null) : (e.data ?? null);
                evenements.push({ recu: Date.now(), type, data, instance: e.instance ?? null });
              }
            } catch {
              /* bloc illisible : ignoré, jamais recopié */
            }
            if (evenements.length > 20_000) evenements.splice(0, 5_000);
          }
          if (tampon.length > 4_000_000) tampon = "";
        }
      } catch {
        /* flux coupé (arrêt demandé ou cockpit redémarré) */
      }
    })();
  };
  ouvrir(client);
  return {
    evenements,
    rouvrir(c) {
      controleur?.abort();
      ouvrir(c);
    },
    arreter() {
      controleur?.abort();
    },
    /** Premier événement reçu après `depuis` qui satisfait `predicat`, attendu `delaiMs` au plus ; null sinon. */
    async attendre(predicat, { depuis = 0, delaiMs = 120_000, pasMs = 250 } = {}) {
      const debut = Date.now();
      for (;;) {
        const trouve = evenements.find((e) => e.recu >= depuis && predicat(e));
        if (trouve !== undefined) return trouve;
        if (Date.now() - debut >= delaiMs) return null;
        await pause(pasMs);
      }
    },
  };
}

/**
 * Suivi du journal du faux Copilot (pilotage L21a) : chaque appel est gardé avec l'heure où le banc l'a VU pour la première fois,
 * et ses champs mis à jour à chaque relevé (servi, abandonné). Le faux ne garde aucun contenu.
 */
export function suivreFaux(faux, { pasMs = 250 } = {}) {
  const vus = new Map();
  let actif = true;
  let recues = 0;
  const relever = async () => {
    const r = await faux.journal();
    // Journal remis à zéro (`reinitialiser`, au lancement d'une demande) : les numéros repartent de 1, les anciens appels partent.
    if (Number.isInteger(r.json?.recues) && r.json.recues < recues) vus.clear();
    if (Number.isInteger(r.json?.recues)) recues = r.json.recues;
    for (const e of r.json?.journal ?? []) {
      if (!Number.isInteger(e?.n)) continue;
      const connu = vus.get(e.n);
      if (connu === undefined) vus.set(e.n, { ...e, vuA: Date.now() });
      else Object.assign(connu, e, { vuA: connu.vuA });
    }
  };
  const boucle = (async () => {
    while (actif) {
      try {
        await relever();
      } catch {
        /* pilotage momentanément injoignable */
      }
      await pause(pasMs);
    }
  })();
  return {
    /** Appels à l'API de complétion seulement (le catalogue `/models` n'est pas un appel d'IA), dans l'ordre d'arrivée. */
    appels: () => [...vus.values()].filter((e) => e.route === "chat").sort((a, b) => a.n - b.n),
    async arreter() {
      actif = false;
      await boucle;
      try {
        await relever();
      } catch {
        /* dernier relevé impossible : les entrées déjà vues restent */
      }
    },
  };
}

// --- Poste : dossier de travail JETABLE du banc seulement -------------------------------------------------------------------------

/** Chemin absolu d'une entrée du dossier de travail du banc ; lève si le chemin en sort (`..`, chemin absolu, lecteur). */
function dansLeDossierDeTravail(ws, relatif) {
  const base = path.resolve(ws);
  const cible = path.resolve(base, ...String(relatif).split("/"));
  if (!cible.startsWith(base + path.sep)) throw new Error(`chemin hors du dossier de travail du banc refusé : ${String(relatif).slice(0, 80)}`);
  return cible;
}

/** Écrit un fichier du dossier de travail JETABLE du banc (dossiers créés), jamais ailleurs. */
export function deposer(ws, relatif, contenu) {
  const cible = dansLeDossierDeTravail(ws, relatif);
  fs.mkdirSync(path.dirname(cible), { recursive: true });
  fs.writeFileSync(cible, contenu);
}

/** Retire une entrée (fichier ou dossier) du dossier de travail JETABLE du banc, jamais ailleurs. */
export function retirer(ws, relatif) {
  fs.rmSync(dansLeDossierDeTravail(ws, relatif), { recursive: true, force: true });
}

// --- Relevés de diagnostic, SANS CONTENU (écrits dans la sortie du banc, hors du dépôt) --------------------------------------------

/** Identifiant raccourci (six derniers caractères) : assez pour suivre une session, jamais un contenu. */
const court = (id) => (typeof id === "string" && id !== "" ? id.slice(-6) : null);

/** Types d'événements relevés pour le diagnostic ; `message.part.updated` seulement pour les parties d'outil. */
const TYPES_DIAGNOSTIC = new Set([
  "session.status",
  "session.idle",
  "session.error",
  "session.created",
  "permission.asked",
  "permission.replied",
  "message.part.updated",
  "autonomie.decision",
  "conversation.arretee",
  "server.connected",
  "server.instance.disposed",
]);

/**
 * Événements de la salle reçus depuis `depuis`, réduits à leur forme : type, session raccourcie, statut (type et numéro de
 * tentative), nom d'erreur, permission demandée ou réponse, outil et état d'une partie d'outil, verdict et règle d'une décision,
 * cause d'un arrêt. Aucun texte, aucun argument d'outil. Borné à 600 lignes.
 */
export function resumeSalle(ecoute, depuis) {
  const lignes = [];
  for (const e of ecoute.evenements) {
    if (e.recu < depuis || lignes.length >= 600) continue;
    if (!TYPES_DIAGNOSTIC.has(e.type) && !String(e.type).startsWith("omo.")) continue;
    const d = e.data ?? {};
    const ligne = { t: Math.round((e.recu - depuis) / 100) / 10, type: e.type, ...(e.instance ? { instance: e.instance } : {}) };
    const session = d.sessionID ?? d.sessionId ?? d.info?.id ?? d.part?.sessionID ?? null;
    if (session !== null) ligne.s = court(session);
    if (e.type === "message.part.updated") {
      if (d.part?.type !== "tool") continue;
      ligne.outil = typeof d.part.tool === "string" ? d.part.tool : null;
      ligne.etat = typeof d.part.state?.status === "string" ? d.part.state.status : null;
    }
    if (e.type === "session.status") {
      ligne.statut = d.status?.type ?? null;
      if (typeof d.status?.attempt === "number") ligne.tentative = d.status.attempt;
    }
    if (e.type === "session.error") ligne.erreur = typeof d.error?.name === "string" ? d.error.name : null;
    if (e.type === "session.created") ligne.parent = court(d.info?.parentID ?? null);
    if (e.type === "permission.asked") ligne.permission = typeof d.permission === "string" ? d.permission : null;
    if (e.type === "permission.replied") ligne.reponse = typeof d.reply === "string" ? d.reply : typeof d.response === "string" ? d.response : null;
    if (e.type === "autonomie.decision") Object.assign(ligne, { verdict: d.verdict ?? null, regle: d.regle ?? null });
    if (e.type === "conversation.arretee" || e.type === "omo.hors-controle") ligne.cause = d.cause ?? null;
    if (e.type === "omo.recreation") Object.assign(ligne, { raison: d.raison ?? null, etat: d.etat ?? null });
    if (e.type === "omo.connection") ligne.connecte = d.connected === true;
    lignes.push(ligne);
  }
  return lignes;
}

/** Appels vus au faux depuis `depuis` : numéro, heure relative, IA, session raccourcie, code servi, outils servis, abandon. */
export function resumeFaux(suivi, depuis) {
  return suivi.appels().map((e) => ({
    n: e.n,
    t: Math.round((e.vuA - depuis) / 100) / 10,
    ia: e.ia ?? null,
    s: court(e.copilot?.session ?? null),
    servie: e.servie ?? null,
    outils: e.outilsServis ?? 0,
    ...(e.abandon ? { abandon: true } : {}),
  }));
}

/** Champs du journal du cockpit gardés pour le diagnostic (le journal est déjà masqué par le produit, log.ts). */
const CHAMPS_JOURNAL = ["cause", "code", "raison", "verdict", "regle", "permission", "phase", "fin", "genre", "projet", "error"];

/**
 * Lignes « salle : … » du journal du cockpit écrites depuis `depuis` : heure relative, niveau, message et quelques champs
 * nommés, chacun borné. Jamais une ligne entière recopiée.
 */
export async function journalCockpit(ctx, depuis) {
  const brut = await Promise.resolve()
    .then(() => ctx.logs?.("cockpit", { lignes: 4000 }) ?? "")
    .catch(() => "");
  const lignes = [];
  for (const texteLigne of String(brut).split(/\r?\n/)) {
    const i = texteLigne.indexOf("{");
    if (i === -1) continue;
    let j;
    try {
      j = JSON.parse(texteLigne.slice(i));
    } catch {
      continue;
    }
    if (typeof j?.msg !== "string" || !j.msg.startsWith("salle")) continue;
    const t = Date.parse(String(j.t ?? ""));
    if (Number.isFinite(t) && t < depuis - 2000) continue;
    const ligne = { t: Number.isFinite(t) ? Math.round((t - depuis) / 100) / 10 : null, niveau: j.level ?? null, msg: j.msg.slice(0, 160) };
    for (const cle of CHAMPS_JOURNAL) if (typeof j[cle] === "string" || typeof j[cle] === "number") ligne[cle] = String(j[cle]).slice(0, 200);
    lignes.push(ligne);
  }
  return lignes.slice(-300);
}

/**
 * Parties d'outil d'une conversation de la salle (racine et enfants), lues dans la salle par l'espion : outil, état, et le début
 * du message d'erreur d'opencode ou de l'extension (borné). Ni argument, ni sortie d'outil. null sans client de la salle.
 */
export async function partiesDeLaSalle(ctx, rootId, dossier = DOSSIER) {
  const client = ctx.clientSalle;
  if (!client || typeof rootId !== "string") return null;
  const lire = async (id) => {
    const r = await client.get(`/session/${enc(id)}/message?directory=${enc(dossier)}`, { delaiMs: 15_000 }).catch(() => null);
    if (r?.code !== 200 || !Array.isArray(r.json)) return { s: court(id), illisible: r?.code ?? 0 };
    const parties = [];
    for (const m of r.json) {
      for (const p of Array.isArray(m?.parts) ? m.parts : []) {
        if (p?.type !== "tool") continue;
        const erreur = p.state?.status === "error" ? { erreur: String(p.state?.error ?? "").slice(0, 160) } : {};
        // Délégation que l'extension n'a pas su faire : `task` TERMINÉ dont la sortie commence par la phrase fixe de l'extension
        // (« Failed to delegate… », mesure L27a) ; seul ce drapeau est gardé, jamais la sortie.
        const echec = p.tool === "task" && String(p.state?.output ?? "").startsWith("Failed to delegate") ? { echecDelegation: true } : {};
        parties.push({ outil: p.tool ?? null, etat: p.state?.status ?? null, ...erreur, ...echec });
      }
    }
    return { s: court(id), parties };
  };
  const enfants = await client.get(`/session/${enc(rootId)}/children?directory=${enc(dossier)}`, { delaiMs: 15_000 }).catch(() => null);
  const ids = [rootId, ...(Array.isArray(enfants?.json) ? enfants.json.map((s) => s?.id).filter((x) => typeof x === "string") : [])];
  const out = [];
  for (const id of ids.slice(0, 40)) out.push(await lire(id));
  return out;
}

/**
 * Délégation `task` de l'extension, telle que son schéma publié l'accepte (`prompt` requis, `load_skills` passé vide ; relevé du
 * `dist` de la 4.19.4, `delegateTaskArgsSchema`). Consigne synthétique, aucun texte de l'extension.
 */
export const tacheOmo = ({ description = "tache du banc", prompt = "Reponds en une ligne.", subagent = "explore", enFond = false } = {}) =>
  outil("task", { description, prompt, subagent_type: subagent, run_in_background: enFond, load_skills: [] });

/**
 * Délégations d'une demande, relevées dans la salle après coup : sessions enfants de la racine, et appels `task` que l'extension n'a
 * pas su déléguer. `echouee` : aucune session enfant ET au moins un échec de délégation relevé — le constat (remis à l'intégrateur)
 * n'est écrit que sur cette preuve ; une racine illisible n'est jamais lue « échouée ». Les sessions enfants comptées par les
 * plafonds sont, elles, relevées par le flux du cockpit.
 */
export async function delegationsDe(ctx, rootId, { delaiMs = 45_000, pasMs = 3000 } = {}) {
  // Juste après une relance, l'instance fraîche de la salle peut ne pas encore servir les messages du projet : la lecture est
  // refaite jusqu'à obtenir ceux de la racine. Une racine illisible n'est jamais « lue » (fermé en cas de doute : rouge).
  const debut = Date.now();
  let lu = null;
  for (;;) {
    lu = await partiesDeLaSalle(ctx, rootId).catch(() => null);
    if (Array.isArray(lu?.[0]?.parties) || Date.now() - debut >= delaiMs) break;
    await pause(pasMs);
  }
  if (!Array.isArray(lu?.[0]?.parties)) return { lisible: false, enfants: 0, echecs: 0, echouee: false };
  // Échecs relevés dans TOUT l'arbre lu : la racine et la session enfant du banc lisent la même file du faux, et l'appel `task`
  // scripté peut être pris par l'une ou l'autre (banc l27b4 : pris par la session enfant).
  const echecs = lu.reduce((n, s) => n + (Array.isArray(s.parties) ? s.parties.filter((p) => p.echecDelegation === true).length : 0), 0);
  const enfants = Math.max(0, lu.length - 1);
  return { lisible: true, enfants, echecs, echouee: enfants === 0 && echecs > 0 };
}

/**
 * Session ENFANT de la racine, ouverte par l'API de la salle (par l'espion, avec le mot de passe de la salle que le banc tire à
 * chaque exécution), là où l'extension l'ouvrirait par une délégation `task`, qu'elle ne sait pas faire dans la salle (constat
 * relevé à chaque cas par `delegationsDe`). Pour le cockpit, c'est le même chemin : un `session.created` de la salle dont le parent
 * est la racine, compté dans l'arbre de la demande (plafonds de coût et de sessions, arrêt). Rend l'identifiant, ou null.
 */
export async function enfantParLApi(ctx, rootId, { titre = "session enfant du banc", dossier = DOSSIER } = {}) {
  const salle = ctx.clientSalle;
  if (!salle || typeof rootId !== "string" || rootId === "") return null;
  const r = await salle.post(`/session?directory=${enc(dossier)}`, { parentID: rootId, title: titre }, { delaiMs: 15_000 }).catch(() => null);
  return r?.code === 200 && typeof r.json?.id === "string" && r.json.parentID === rootId ? r.json.id : null;
}

/**
 * Envoi DIRECT à une session enfant, par l'API de la salle, avec l'IA donnée (jamais celle par défaut : la file du faux est choisie
 * par l'IA). Seul le code est rendu. Jamais vers une racine : un message de racine venu d'ailleurs que du cockpit arrêterait la
 * salle (origine inconnue, L23c) — c'est ce que ce banc ne cherche pas ici.
 */
export async function envoyerALEnfant(ctx, sessionId, texteEnvoye, model, dossier = DOSSIER) {
  const salle = ctx.clientSalle;
  if (!salle || typeof sessionId !== "string" || !model?.providerID || !model?.modelID) return 0;
  const corps = { parts: [{ type: "text", text: String(texteEnvoye) }], model: { providerID: model.providerID, modelID: model.modelID } };
  const r = await salle.post(`/session/${enc(sessionId)}/prompt_async?directory=${enc(dossier)}`, corps, { delaiMs: 15_000 }).catch(() => null);
  return r?.code ?? 0;
}

/** Attend qu'au moins `n` appels d'IA aient été vus au faux (`delaiMs` au plus) ; rend le nombre vu. */
export async function attendreAppels(suivi, n, delaiMs = 60_000) {
  const debut = Date.now();
  while (suivi.appels().length < n && Date.now() - debut < delaiMs) await pause(250);
  return suivi.appels().length;
}

/**
 * Seconde session occupée d'une demande : une session enfant ouverte par l'API de la salle (enfantParLApi), à qui le banc envoie
 * `texteEnvoye` avec l'IA de l'assistant (même file du faux que la racine). Rend `{ id, code }` ; `id` null si elle n'a pas pu naître.
 */
export async function secondeSession(ctx, demande, texteEnvoye) {
  const id = await enfantParLApi(ctx, demande.salle.rootId, { titre: "seconde session du banc" });
  const code = id === null ? 0 : await envoyerALEnfant(ctx, id, texteEnvoye, demande.ia.model);
  return { id, code };
}

/** Écrit le diagnostic d'un cas (`<porte>-<cas>-diag.json` dans la sortie du banc) : salle, faux, journal du cockpit, parties d'outil. */
export async function ecrireDiagnostic(ctx, nom, { ecoute = null, suivi = null, depuis, rootId = dernierRoot, extra = {} }) {
  try {
    const diag = {
      cas: nom,
      salle: ecoute === null ? [] : resumeSalle(ecoute, depuis),
      faux: suivi === null ? [] : resumeFaux(suivi, depuis),
      cockpit: await journalCockpit(ctx, depuis),
      parties: await partiesDeLaSalle(ctx, rootId).catch(() => null),
      ...extra,
    };
    ctx.ecrireSortie?.(`${nom}-diag.json`, `${JSON.stringify(diag, null, 1)}\n`);
  } catch {
    /* un diagnostic manqué n'arrête jamais une porte */
  }
}

/** Code d'un refus de la salle : `raison` du corps (`corpsRefusSalle`), sinon `error`. */
export const raisonDu = (r) => (typeof r?.json?.raison === "string" ? r.json.raison : (r?.erreur ?? null));

/**
 * IA que l'assistant de la salle impose, lue SANS RIEN ENVOYER : un envoi avec une IA du catalogue du faux reçoit 409
 * « assistant-model-changed » avant les crochets (le jeton d'activation n'est jamais pris). Appelée avant toute activation : si
 * l'IA convenait, l'envoi serait refusé faute d'activation, et rien ne partirait non plus.
 */
export async function iaImposee(client, rootId, dossier = DOSSIER) {
  const r = await client.brut(
    "POST",
    `/api/omo/oc/session/${enc(rootId)}/prompt_async?directory=${enc(dossier)}`,
    { parts: [{ type: "text", text: "." }], model: { providerID: "github-copilot", modelID: "faux-m1" } },
    { entetes: CONFIRMATION },
  );
  let json = null;
  try {
    json = r.corps === "" ? null : JSON.parse(r.corps);
  } catch {
    json = null;
  }
  const m = json?.model;
  if (r.code === 409 && json?.error === "assistant-model-changed" && typeof m?.providerID === "string" && typeof m?.modelID === "string") {
    return { ok: true, model: { providerID: m.providerID, modelID: m.modelID }, variant: typeof json.variant === "string" && json.variant !== "" ? json.variant : null };
  }
  return { ok: false, code: r.code, erreur: json?.raison ?? json?.error ?? null };
}

/** Envoi dans la salle avec l'IA déjà connue (aucun renvoi) : code et raison seulement. */
export async function envoyerAvec(client, rootId, texteEnvoye, ia, dossier = DOSSIER) {
  const corps = { parts: [{ type: "text", text: String(texteEnvoye) }], model: ia.model, ...(ia.variant ? { variant: ia.variant } : {}) };
  const r = await client.brut("POST", `/api/omo/oc/session/${enc(rootId)}/prompt_async?directory=${enc(dossier)}`, corps, { entetes: CONFIRMATION });
  let json = null;
  try {
    json = r.corps === "" ? null : JSON.parse(r.corps);
  } catch {
    json = null;
  }
  return { code: r.code, erreur: json?.raison ?? json?.error ?? null };
}

/** Poste un lot au faux ; lève si le faux le refuse (une porte ne joue jamais sur la réponse par défaut sans le savoir). */
export async function scripter(faux, reponses, ia) {
  if (reponses.length === 0) return;
  const r = await faux.reponses(ia === undefined ? { reponses } : { ia, reponses });
  if (r.code !== 200) throw new Error(`lot refusé par le faux (code ${r.code}) : ${String(r.json?.erreur ?? r.texte).slice(0, 200)}`);
}

/** Heure de la dernière relance de la salle faite par le banc lui-même (`relancerSalle`), pour `attendreFluxSalle`. */
let derniereRelanceBanc = 0;

/** Attentes du flux de la salle relevées par `attendreFluxSalle` (mesure de la fenêtre aveugle du banc, remise à l'intégrateur). */
export const ATTENTES_FLUX = [];

/**
 * Attend que le cockpit écoute de nouveau le flux de la salle après la dernière relance (omo.recreation, arrêt, relance du banc).
 * Sur le banc, l'espion ne referme pas côté cockpit un flux dont l'amont est mort sans fin propre (`pipe` ne termine pas la
 * destination sur une coupure) : le cockpit ne s'en aperçoit qu'à son chien de garde (35 s sans données, opencode.ts), et une
 * demande lancée entre-temps serait jouée sans répondeur, sans détections ni plafonds en direct. Constat remis (espion de L21b,
 * clos) ; sans espion, la reconnexion suit l'attente croissante du client (10 s au plus).
 *
 * Une relance que CETTE écoute n'a pas vue compte aussi (banc l27b4 du 26/09 : G6 [tentatives] joué 15 s après la relance de fin de
 * demande de la fumée, qu'aucune écoute de G6 n'avait vue : cockpit aveugle, aucun `session.status` reçu, aucune tentative comptée) :
 * `lireEtat` rend l'état publié par le superviseur, dont `startedAt` date le démarrage en cours. Le flux est tenu pour rouvert sur une
 * connexion vue après la relance, ou `RECONNEXION_MS` après elle (chien de garde de 35 s, plus l'attente du client). Rend
 * `{ ok, attenteMs, depuisRelanceMs }`.
 */
export const RECONNEXION_MS = 45_000;

export async function attendreFluxSalle(ecoute, { delaiMs = 75_000, lireEtat = null } = {}) {
  const debut = Date.now();
  // Lu une fois : une relance pendant l'attente se voit, elle, dans le flux (omo.recreation, conversation.arretee).
  const etat = lireEtat === null ? null : await Promise.resolve().then(lireEtat).catch(() => null);
  const demarrage = Number.isFinite(etat?.startedAt) ? etat.startedAt : 0;
  for (;;) {
    let relance = Math.max(derniereRelanceBanc, demarrage);
    let connexion = null;
    for (const e of ecoute.evenements) {
      if (e.type === "omo.recreation" || e.type === "conversation.arretee") relance = Math.max(relance, e.recu);
      if (e.type === "omo.connection") connexion = e;
    }
    const reconnecte = connexion !== null && connexion.data?.connected === true && connexion.recu > relance;
    const ok = relance === 0 || reconnecte || Date.now() - relance >= RECONNEXION_MS;
    if (ok || Date.now() - debut >= delaiMs) {
      const attente = { ok, attenteMs: Date.now() - debut, depuisRelanceMs: relance === 0 ? null : Date.now() - relance };
      ATTENTES_FLUX.push(attente);
      return attente;
    }
    await pause(500);
  }
}

/**
 * Demande scriptée, du geste de la page à l'envoi : flux de la salle écouté (`ecoute`, voir attendreFluxSalle), salle NEUVE sur
 * `projet`, IA de l'assistant lue sans rien envoyer, faux remis à zéro puis scripté (`racine` dans la file de l'IA de
 * l'assistant — la file commune peut être prise par un titre de session —, `commune` dans la file commune, pour les sous-sessions
 * dont l'IA n'a pas de file), activation au montant donné, envoi.
 */
export async function lancerDemande(ctx, client, { plafond, texteEnvoye = "Travail du banc.", racine = [], commune = [], projet = PROJET, ecoute = null }) {
  const dossier = `/workspace/${projet}`;
  if (ecoute !== null) {
    const flux = await attendreFluxSalle(ecoute, { lireEtat: ctx.etat });
    if (!flux.ok) return { salle: { rootId: null }, envoyee: false, raison: `flux de la salle toujours coupé côté cockpit après ${Math.round(flux.attenteMs / 1000)} s` };
  }
  const salle = await ouvrirSalleRobuste(client, projet);
  if (salle.rootId === null) return { salle, envoyee: false, raison: `ouverture refusée : ${salle.code} ${raisonDu(salle) ?? ""}` };
  marquerRoot(salle.rootId);
  const ia = await iaImposee(client, salle.rootId, dossier);
  if (!ia.ok) return { salle, envoyee: false, raison: `IA de l'assistant illisible : ${ia.code} ${ia.erreur ?? ""}` };
  await ctx.faux.reinitialiser();
  await scripter(ctx.faux, racine, ia.model.modelID);
  await scripter(ctx.faux, commune);
  const activation = await activer(client, salle.rootId, plafond);
  if (activation.code < 200 || activation.code >= 300) return { salle, ia, activation, envoyee: false, raison: `activation refusée : ${activation.code} ${raisonDu(activation) ?? ""}` };
  const debut = Date.now();
  const envoi = await envoyerAvec(client, salle.rootId, texteEnvoye, ia, dossier);
  const envoyee = envoi.code >= 200 && envoi.code < 300;
  return { salle, ia, activation, envoi, debut, envoyee, raison: envoyee ? null : `envoi refusé : ${envoi.code} ${envoi.erreur ?? ""}` };
}

/** Faits de la conversation (`GET …/facts?since=0`, mode Avancé) : `[]` si illisibles. */
export async function faits(client, rootId) {
  const r = await client.brut("GET", `/api/conversations/${enc(rootId)}/facts?since=0`);
  try {
    const json = JSON.parse(r.corps);
    return Array.isArray(json?.facts) ? json.facts : [];
  } catch {
    return [];
  }
}

/** Cause (`motif`) du DERNIER fait « statut » posé par un arrêt de la salle sur cette racine ; null si aucun. */
export function motifDArret(listeFaits) {
  const statuts = listeFaits.filter((f) => f?.kind === "statut" && typeof f?.data?.motif === "string");
  return statuts.length === 0 ? null : statuts[statuts.length - 1].data.motif;
}

/**
 * Attend l'arrêt de la salle pour `rootId` : `conversation.arretee` reçu (heure de réception), sinon fait « statut » relu.
 * Rend `{ ok, cause, recu }`.
 */
export async function attendreArret(ecoute, client, rootId, { depuis, delaiMs = 180_000 } = {}) {
  const e = await ecoute.attendre((x) => x.type === "conversation.arretee" && x.data?.rootId === rootId, { depuis, delaiMs });
  if (e !== null) return { ok: true, cause: e.data?.cause ?? null, recu: e.recu };
  const motif = motifDArret(await faits(client, rootId));
  return { ok: motif !== null, cause: motif, recu: null };
}

/** Salle « prête » de nouveau (relance à neuf finie, pré-contrôle passé), sinon l'état vu. */
export async function attendrePrete(client, delaiMs = 240_000) {
  return await attendreEtatSalle(client, ["prete"], { delaiMs, pasMs: 2000 });
}

/**
 * Ouvre une salle en tolérant la course « état prête mais instance encore en relance » : `GET /api/omo/status` peut dire
 * « prete » (phase opencode-lance publiée) une fraction de seconde avant que l'instance ne serve, et `POST /api/omo/rooms` rend
 * alors 409 « salle-en-relance » ou « non-prepare » transitoire. On attend prête puis on réessaie, jusqu'à `delaiMs`. Un refus
 * DÉFINITIF (mode, salle coupée, projet piégé) est rendu tel quel sans réessai.
 */
export async function ouvrirSalleRobuste(client, projet, { delaiMs = 120_000 } = {}) {
  const debut = Date.now();
  let dernier = null;
  for (;;) {
    await attendrePrete(client, Math.max(2000, delaiMs - (Date.now() - debut)));
    dernier = await ouvrirSalle(client, projet);
    if (dernier.rootId !== null) return dernier;
    const transitoire = dernier.code === 409 && (raisonDu(dernier) === "salle-en-relance" || raisonDu(dernier) === "non-prepare");
    if (!transitoire || Date.now() - debut >= delaiMs) return dernier;
    await pause(2000);
  }
}

/**
 * Assainit la salle après un cas : si une demande est encore active (un cas qui l'a laissée ouverte, ou un enchaînement d'outils
 * qui n'a pas atteint la fin de demande), l'arrête par « Arrêter » (D-2b-30) et attend le retour à « prête ». Ainsi un cas ne
 * peut jamais empoisonner le suivant. `rootId` : la racine du cas ; null pour n'arrêter que si l'état l'exige.
 */
export async function assainir(client, rootId = dernierRoot) {
  const st = (await statutSalle(client)).json;
  if (rootId !== null && (st?.etatSalle === "demande-active" || st?.etatSalle === "en-relance")) {
    await arreter(client, rootId).catch(() => undefined);
  }
  return await attendrePrete(client, 180_000);
}

/**
 * Relance de la salle par le banc (`docker compose restart opencode-omo`, conteneur du projet du banc SEULEMENT) : le superviseur
 * repart et publie un NOUVEAU démarrage, que le cockpit pré-contrôle. Rend l'ancien et le nouveau `startId`.
 */
export async function relancerSalle(ctx, { delaiMs = 180_000 } = {}) {
  const avant = await ctx.etat();
  const startIdAvant = typeof avant?.startId === "string" ? avant.startId : null;
  derniereRelanceBanc = Date.now();
  const r = await ctx.compose(["restart", "--timeout", "20", "opencode-omo"], { delaiMs: 180_000 });
  const debut = Date.now();
  for (;;) {
    const etat = await ctx.etat();
    const startId = typeof etat?.startId === "string" ? etat.startId : null;
    if (startId !== null && startId !== startIdAvant) return { ok: true, code: r.code, startIdAvant, startId, phase: etat.phase ?? null, attenteMs: Date.now() - debut };
    if (Date.now() - debut >= delaiMs) return { ok: false, code: r.code, startIdAvant, startId, phase: etat?.phase ?? null, attenteMs: Date.now() - debut };
    await pause(1000);
  }
}

/**
 * Pré-contrôle du cockpit pour CE démarrage : attend que `GET /api/omo/status` porte `dernierDemarrage.startId === startId`
 * (contrôlé et inscrit dans `omo_room_starts`), puis rend ses résultats et le `precheck-ok` du volume de contrôle.
 */
export async function precontroleDuDemarrage(ctx, client, startId, { delaiMs = 90_000 } = {}) {
  const debut = Date.now();
  let statut = null;
  for (;;) {
    statut = (await statutSalle(client)).json;
    if (statut?.dernierDemarrage?.startId === startId) break;
    if (Date.now() - debut >= delaiMs) return { vu: false, statut, resultats: [], precheckOk: await lirePrecheckOk(ctx) };
    await pause(1000);
  }
  return { vu: true, statut, resultats: statut.dernierDemarrage.precheck ?? [], precheckOk: await lirePrecheckOk(ctx) };
}

/** `precheck-ok` du volume de contrôle (non secret : un startId, une heure, des chemins et des empreintes) ; null s'il manque. */
export async function lirePrecheckOk(ctx) {
  const texte = await ctx.lireVolume("control-omo", "precheck-ok");
  if (texte === null) return null;
  try {
    return JSON.parse(texte);
  } catch {
    return null;
  }
}

/** Résultat du pré-contrôle d'un projet dans une liste de résultats de démarrage (chemin relatif à /workspace). */
export const resultatDe = (resultats, projet) => (Array.isArray(resultats) ? (resultats.find((r) => r?.projet === projet) ?? null) : null);

// --- Coût d'un appel, avec la grille du cockpit ------------------------------------------------------------------------------------

/**
 * Coût d'un appel servi par le faux, avec la GRILLE du cockpit (app/server/pricing.ts, lue telle quelle) : IA lue au journal du
 * faux ; usage scripté (réponse à outils = usage cher, texte = usage par défaut du faux, 20 et 6). IA hors grille : 0.
 */
export async function coutParAppel() {
  const { COPILOT_PRICES, computeCost } = await import("../../../app/server/pricing.ts");
  return (entree) => {
    if (entree?.servie !== 200) return 0;
    const prix = COPILOT_PRICES[entree.ia ?? ""];
    if (prix === undefined) return 0;
    const usage = entree.outilsServis > 0 ? { input: USAGE_CHER.entree, output: USAGE_CHER.sortie } : { input: 20, output: 6 };
    return computeCost({ ...usage, reasoning: 0, cacheRead: 0, cacheWrite: 0 }, prix);
  };
}

/** Dépense de la racine (arbre entier) selon le registre du cockpit (`GET /api/usage/session/:rootId`). */
export async function depenseDeLaRacine(client, rootId) {
  const r = await client.brut("GET", `/api/usage/session/${enc(rootId)}`);
  try {
    const json = JSON.parse(r.corps);
    return typeof json?.cost === "number" ? json.cost : null;
  } catch {
    return null;
  }
}

/**
 * Arrêt attendu : cause lue dans l'événement ou le fait, puis AUCUN appel au faux vu après la réception de l'arrêt (marge de
 * 1,5 s : pas du suivi et transit). Rend l'arrêt lu.
 */
export async function verifierArret(r, cas, { ecoute, client, suivi, demande, cause, delaiMs }) {
  const arret = await attendreArret(ecoute, client, demande.salle.rootId, { depuis: demande.debut, delaiMs });
  await pause(8000);
  const motif = motifDArret(await faits(client, demande.salle.rootId));
  r.ajouter(`[${cas}] la demande est arrêtée pour « ${cause} »`, arret.ok && (arret.cause === cause || motif === cause), `événement ${arret.cause ?? "aucun"}, fait ${motif ?? "aucun"}`);
  const apres = arret.recu === null ? [] : suivi.appels().filter((e) => e.vuA > arret.recu + 1500);
  r.ajouter(
    `[${cas}] aucun appel au faux après l'arrêt`,
    arret.recu !== null && apres.length === 0,
    arret.recu === null ? "arrêt non reçu par le flux : rien à dater" : `${apres.length} appel(s) après l'arrêt${apres.length > 0 ? ` : ${JSON.stringify(apres.map((e) => ({ n: e.n, ia: e.ia, s: e.copilot?.session })))}` : ""}`,
  );
  return arret;
}

// --- Porte G6 --------------------------------------------------------------------------------------------------------------------

/** Montants refusés sans envoi : vide, blancs, zéro, négatif, non numérique, exposant, trois décimales, au-dessus de la borne. */
export function montantsRefuses(plafondMaxUsd) {
  const auDessus = Number.isFinite(plafondMaxUsd) ? (Math.round(plafondMaxUsd * 100) + 1) / 100 : 5.01;
  return [
    ["", "plafond-vide"],
    ["   ", "plafond-vide"],
    ["0", "plafond-invalide"],
    ["0.00", "plafond-invalide"],
    ["-1", "plafond-invalide"],
    ["abc", "plafond-invalide"],
    ["1e2", "plafond-invalide"],
    ["1.234", "plafond-invalide"],
    [auDessus.toFixed(2), "plafond-hors-bornes"],
    ["1000000", "plafond-hors-bornes"],
  ];
}

async function casRefus(ctx, client, r) {
  const salle = await ouvrirSalleRobuste(client, PROJET);
  marquerRoot(salle.rootId);
  if (!r.ajouter("[refus] une salle s'ouvre sur le projet préparé", salle.rootId !== null, `code ${salle.code}`)) return;
  const reglages = await client.brut("GET", "/api/settings");
  let plafondMaxUsd = Number.NaN;
  try {
    plafondMaxUsd = JSON.parse(reglages.corps)?.budget?.autonomie?.plafondMaxUsd;
  } catch {
    plafondMaxUsd = Number.NaN;
  }
  await ctx.faux.reinitialiser();
  const avant = await releverActivite({ portEspion: ctx.portEspion, faux: ctx.faux });
  const vus = [];
  for (const [montant, attendu] of montantsRefuses(plafondMaxUsd)) {
    const a = await activer(client, salle.rootId, montant);
    vus.push({ montant: JSON.stringify(montant), attendu, code: a.code, raison: raisonDu(a), phrase: typeof a.json?.message === "string" && a.json.message.length > 0 });
  }
  const sansConfirmation = await activer(client, salle.rootId, "0.10", { confirmer: false });
  // Envoi tenté après ces refus : aucune activation acceptée, il doit être refusé lui aussi, sans rien atteindre.
  const ia = await iaImposee(client, salle.rootId);
  const envoi = ia.ok ? await envoyerAvec(client, salle.rootId, "Ne doit jamais partir.", ia) : { code: 0, erreur: "ia-illisible" };
  await pause(3000);
  const apres = await releverActivite({ portEspion: ctx.portEspion, faux: ctx.faux });
  const ecart = ecartActivite(avant, apres);
  r.mesures.refus = { plafondMaxUsd, montants: vus, sansConfirmation: { code: sansConfirmation.code, raison: raisonDu(sansConfirmation) }, envoiApres: envoi, ecart };
  const mauvais = vus.filter((v) => v.code !== 409 || v.raison !== v.attendu || !v.phrase);
  r.ajouter(
    "[refus] champ vide, nul, négatif, non numérique ou hors bornes : 409, sa raison et sa phrase, pour chaque montant",
    mauvais.length === 0,
    mauvais.length === 0 ? vus.map((v) => `${v.montant}→${v.raison}`).join(" ; ") : `écarts : ${JSON.stringify(mauvais)}`,
  );
  r.ajouter("[refus] confirmation absente : 409 « confirmation-requise »", sansConfirmation.code === 409 && raisonDu(sansConfirmation) === "confirmation-requise", `code ${sansConfirmation.code} ${raisonDu(sansConfirmation) ?? ""}`);
  r.ajouter("[refus] envoi tenté sans activation acceptée : refusé", envoi.code >= 400, `code ${envoi.code} ${envoi.erreur ?? ""}`);
  r.ajouter(
    "[refus] AUCUN envoi : zéro envoi vers la salle, zéro appel au faux, zéro POST …/command",
    ecart.envois === 0 && ecart.appelsFournisseur === 0 && ecart.commandes === 0,
    JSON.stringify({ envois: ecart.envois, appels: ecart.appelsFournisseur, commandes: ecart.commandes }),
  );
}

async function casTentatives(ctx, client, ecoute, r) {
  const debutCas = Date.now();
  const suivi = suivreFaux(ctx.faux);
  try {
    const demande = await lancerDemande(ctx, client, { ecoute, plafond: "1.00", texteEnvoye: "Lis le LISEZMOI.", racine: serie429(8, 1) });
    if (!r.ajouter("[tentatives] demande lancée (activation et envoi acceptés)", demande.envoyee, demande.raison ?? "")) return;
    await verifierArret(r, "tentatives", { ecoute, client, suivi, demande, cause: "plafond-tentatives", delaiMs: 180_000 });
    const servis429 = suivi.appels().filter((e) => e.servie === 429).length;
    r.mesures.tentatives = { reponses429: servis429 };
    r.ajouter("[tentatives] au moins trois 429 servis d'affilée, et pas plus de quatre avant l'arrêt", servis429 >= 3 && servis429 <= 4, `${servis429} réponse(s) 429 servie(s)`);
  } finally {
    await suivi.arreter();
    await ecrireDiagnostic(ctx, "g6-tentatives", { ecoute, suivi, depuis: debutCas });
  }
}

async function casCout(ctx, client, ecoute, r) {
  // Plafond assez haut (≈ 16 appels chers de 0,012 $) et chaque appel ralenti : la seconde session a le temps de facturer elle aussi,
  // pour exercer la concurrence 2. Le plafond de coût s'arrête de toute façon (garde dure : dépassement d'au plus un par session).
  const PLAFOND = "0.20";
  const cout = await coutParAppel();
  const debutCas = Date.now();
  const suivi = suivreFaux(ctx.faux);
  try {
    // Racine : une délégation EN FOND (l'extension la tente ; elle échoue dans la salle, constat relevé plus bas) et une lecture ;
    // puis chaque session lit en boucle, chaque appel « cher » et lent (2,5 s), pour que chaque usage soit vu par le cockpit avant
    // l'appel suivant. Seconde session occupée : une session enfant de la racine ouverte par l'API de la salle (secondeSession), qui
    // lit la même boucle, dans la file de la même IA. La file commune porte aussi la boucle, pour un enfant d'une autre IA.
    const premier = cher(appels(tacheOmo({ description: "delegation du banc G6", prompt: "Lis le LISEZMOI du projet, encore et encore.", enFond: true }), lecture(`${DOSSIER}/LISEZMOI.md`)));
    const boucle = (n) => Array.from({ length: n }, () => cher(appels(lecture(`${DOSSIER}/LISEZMOI.md`)), 2500));
    const demande = await lancerDemande(ctx, client, { ecoute, plafond: PLAFOND, texteEnvoye: "Délègue une lecture en fond et lis en boucle.", racine: [premier, ...boucle(60)], commune: boucle(40) });
    if (!r.ajouter("[cout] demande lancée au montant saisi par le script", demande.envoyee, demande.raison ?? `montant ${PLAFOND}`)) return;
    // La racine a appelé le faux : la seconde session naît et part à son tour, bien avant le franchissement (≈ 16 appels).
    await attendreAppels(suivi, 1, 60_000);
    const seconde = await secondeSession(ctx, demande, "Lis le LISEZMOI du projet, encore et encore.");
    r.ajouter("[cout] seconde session occupée : une session enfant de la racine, ouverte par l'API de la salle, travaille en même temps", seconde.id !== null && seconde.code >= 200 && seconde.code < 300, `enfant ${seconde.id === null ? "non créé" : "créé"} ; envoi ${seconde.code}`);
    const arret = await verifierArret(r, "cout", { ecoute, client, suivi, demande, cause: "plafond-cout", delaiMs: 240_000 });
    await suivi.arreter();
    const servis = suivi.appels().filter((e) => e.servie === 200);
    // Coût cumulé dans l'ordre d'arrivée : l'appel qui franchit le montant, puis ceux qui ont encore été servis.
    let cumul = 0;
    let franchi = -1;
    servis.forEach((e, i) => {
      cumul += cout(e);
      if (franchi === -1 && Math.round(cumul * 1e6) >= Math.round(Number(PLAFOND) * 1e6)) franchi = i;
    });
    const avantFranchi = franchi === -1 ? servis : servis.slice(0, franchi + 1);
    const apresFranchi = franchi === -1 ? [] : servis.slice(franchi + 1).filter((e) => cout(e) > 0);
    const sessionsOccupees = new Set(avantFranchi.filter((e) => cout(e) > 0).map((e) => e.copilot?.session).filter((s) => typeof s === "string"));
    const parSession = {};
    for (const e of apresFranchi) parSession[e.copilot?.session ?? "?"] = (parSession[e.copilot?.session ?? "?"] ?? 0) + 1;
    const maxAppel = Math.max(0, ...servis.map(cout));
    const depense = await depenseDeLaRacine(client, demande.salle.rootId);
    r.mesures.cout = {
      plafond: PLAFOND,
      appelsServis: servis.length,
      franchiAuRang: franchi === -1 ? null : franchi + 1,
      depassement: apresFranchi.length,
      depassementParSession: parSession,
      sessionsOccupees: sessionsOccupees.size,
      coutMaxAppel: Math.round(maxAppel * 1e6) / 1e6,
      depenseRegistre: depense,
      ia: [...new Set(servis.map((e) => e.ia))],
      arretRecu: arret.recu !== null,
    };
    // Concurrence 2 : deux sessions de l'arbre facturent en même temps avant le franchissement (la racine et la seconde session).
    // La délégation de l'extension est relevée à part (constat) : elle ne fait pas la concurrence, la seconde session la fait.
    await attendrePrete(client, 180_000);
    const delegations = await delegationsDe(ctx, demande.salle.rootId);
    r.mesures.cout.delegations = delegations;
    r.mesures.cout.secondeSession = { creee: seconde.id !== null, envoi: seconde.code, facturee: seconde.id !== null && servis.some((e) => e.copilot?.session === seconde.id && cout(e) > 0) };
    r.ajouter(
      "[cout] concurrence 2 : deux sessions de l'arbre facturées en même temps avant le franchissement (racine et session enfant)",
      sessionsOccupees.size >= 2,
      `${sessionsOccupees.size} session(s) facturée(s) avant le franchissement ; délégation de l'extension : ${delegations.echecs} échec(s) relevé(s)${delegations.lisible ? "" : " (racine illisible)"}`,
    );
    r.ajouter("[cout] le montant a été atteint (registre du cockpit)", franchi !== -1 && depense !== null && depense >= Number(PLAFOND) - 1e-9, `rang ${franchi + 1}, dépense du registre ${depense}`);
    r.ajouter(
      "[cout] dépassement d'au plus un appel par session occupée",
      franchi !== -1 && apresFranchi.length <= Math.max(1, sessionsOccupees.size) && Object.values(parSession).every((n) => n <= 1),
      `${apresFranchi.length} appel(s) facturé(s) après le franchissement, par session ${JSON.stringify(parSession)}`,
    );
    r.ajouter(
      "[cout] dépense finale ≤ montant + un appel par session occupée (registre du cockpit)",
      depense !== null && depense <= Number(PLAFOND) + Math.max(1, sessionsOccupees.size) * maxAppel + 1e-6,
      `dépense ${depense} ; borne ${Math.round((Number(PLAFOND) + Math.max(1, sessionsOccupees.size) * maxAppel) * 1e6) / 1e6}`,
    );
  } finally {
    await suivi.arreter();
    await ecrireDiagnostic(ctx, "g6-cout", { ecoute, suivi, depuis: debutCas });
  }
}

/** Sessions ouvertes par [sessions] : une de plus que le plafond (`OMO_LIMITES.sessionsMax` = 30, « plus de 30 » arrête). */
export const SESSIONS_OUVERTES = 31;

async function casSessions(ctx, client, ecoute, r) {
  const debutCas = Date.now();
  const suivi = suivreFaux(ctx.faux);
  try {
    // La racine reste occupée (une réponse lente du faux) : la demande est active pendant que 31 sessions enfants de la racine
    // naissent par l'API de la salle (l'extension ne délègue pas dans la salle ; pour le cockpit, le chemin est le même : un
    // `session.created` de la salle dans l'arbre de la demande). Le plafond compte TOUTES les sessions créées pendant la demande.
    const racine = [lente(appels(lecture(`${DOSSIER}/LISEZMOI.md`)), 45_000), lente(texte("Lecture faite."), 30_000)];
    const demande = await lancerDemande(ctx, client, { ecoute, plafond: "2.00", texteEnvoye: "Lis le LISEZMOI, lentement.", racine });
    if (!r.ajouter("[sessions] demande lancée", demande.envoyee, demande.raison ?? "")) return;
    await attendreAppels(suivi, 1, 60_000);
    const ouvertes = [];
    let arretVu = null;
    for (let i = 1; i <= SESSIONS_OUVERTES; i += 1) {
      arretVu = ecoute.evenements.find((e) => e.recu >= demande.debut && e.type === "conversation.arretee" && e.data?.rootId === demande.salle.rootId) ?? null;
      if (arretVu !== null) break;
      const id = await enfantParLApi(ctx, demande.salle.rootId, { titre: `session du banc ${i}` });
      if (id === null) break;
      ouvertes.push(id);
    }
    const arret = await attendreArret(ecoute, client, demande.salle.rootId, { depuis: demande.debut, delaiMs: 60_000 });
    await pause(8000);
    const creees = ecoute.evenements.filter((e) => e.recu >= demande.debut && e.type === "session.created" && e.instance === "omo" && e.data?.info?.parentID === demande.salle.rootId).length;
    const apres = arret.recu === null ? [] : suivi.appels().filter((e) => e.vuA > arret.recu + 1500);
    if (!arret.ok) await arreter(client, demande.salle.rootId).catch(() => undefined);
    r.mesures.sessions = { ouvertesParLApi: ouvertes.length, sessionsEnfantsVuesParLeFlux: creees, arret: arret.cause, arretAvantLaFin: arretVu !== null, appels: suivi.appels().length, appelsApresArret: apres.length };
    r.ajouter("[sessions] 31 sessions enfants de la racine naissent pendant la demande (API de la salle)", ouvertes.length === SESSIONS_OUVERTES && creees >= SESSIONS_OUVERTES, `${ouvertes.length} ouverte(s), ${creees} vue(s) par le flux du cockpit`);
    r.ajouter("[sessions] plus de 30 sessions créées → arrêt « plafond-sessions »", arret.ok && arret.cause === "plafond-sessions", `arrêt ${arret.cause ?? "aucun"}`);
    r.ajouter("[sessions] aucun appel au faux après l'arrêt", arret.recu !== null && apres.length === 0, arret.recu === null ? "arrêt non reçu par le flux : rien à dater" : `${apres.length} appel(s) après l'arrêt`);
  } finally {
    await suivi.arreter();
    await ecrireDiagnostic(ctx, "g6-sessions", { ecoute, suivi, depuis: debutCas });
  }
}

async function casMensuel(ctx, client, ecoute, r) {
  const lireResume = async () => {
    const resume = await client.brut("GET", "/api/usage/summary");
    try {
      const json = JSON.parse(resume.corps);
      return { depense: json?.spentUsd, budget: json?.budgetUsd };
    } catch {
      return { depense: Number.NaN, budget: Number.NaN };
    }
  };
  const { depense, budget: budgetAvant } = await lireResume();
  if (!r.ajouter("[mensuel] dépense et budget du mois lisibles", Number.isFinite(depense) && Number.isFinite(budgetAvant), `dépense ${depense}, budget ${budgetAvant}`)) return;
  // Budget choisi pour que 80 % soit franchi au troisième appel cher (0,012 $ chacun) : au départ, bien sous 80 %.
  const budget = Math.ceil(((depense + 0.03) / 0.8) * 10_000) / 10_000;
  const pose = await client.brut("PUT", "/api/settings", { budget: { monthlyUsd: budget } });
  const debutCas = Date.now();
  const suivi = suivreFaux(ctx.faux);
  try {
    if (!r.ajouter("[mensuel] budget du mois réglé pour le banc", pose.code === 200, `code ${pose.code}, budget ${budget} $ (dépense ${Math.round(depense * 1e6) / 1e6} $)`)) return;
    const boucle = Array.from({ length: 20 }, () => cher(appels(lecture(`${DOSSIER}/LISEZMOI.md`)), 1000));
    const demande = await lancerDemande(ctx, client, { ecoute, plafond: "4.00", texteEnvoye: "Lis en boucle.", racine: boucle });
    if (!r.ajouter("[mensuel] demande lancée sous le seuil (80 % non atteints au départ)", demande.envoyee, demande.raison ?? "")) return;
    await verifierArret(r, "mensuel", { ecoute, client, suivi, demande, cause: "seuil-mensuel", delaiMs: 180_000 });
    r.mesures.mensuel = { budget, depenseAvant: depense, apres: await lireResume(), appels: suivi.appels().length };
  } finally {
    await suivi.arreter();
    await ecrireDiagnostic(ctx, "g6-mensuel", { ecoute, suivi, depuis: debutCas });
    const retour = await client.brut("PUT", "/api/settings", { budget: { monthlyUsd: budgetAvant } }).catch(() => ({ code: 0 }));
    r.ajouter("[mensuel] budget du mois rétabli", retour.code === 200, `code ${retour.code}, budget ${budgetAvant} $`);
  }
}

async function casRedemarrage(ctx, etat, ecoute, r) {
  const debutCas = Date.now();
  const suivi = suivreFaux(ctx.faux);
  try {
    // Délégation EN FOND tentée par l'extension (elle échoue dans la salle : constat), puis chaque appel lent (45 s) ; une session
    // enfant de la racine, ouverte par l'API de la salle, lit elle aussi lentement : le redémarrage tombe pendant que les DEUX
    // sessions de l'arbre ont un appel en vol au faux.
    const lent = (n) => Array.from({ length: n }, () => lente(appels(lecture(`${DOSSIER}/LISEZMOI.md`)), 45_000));
    const racine = [appels(tacheOmo({ description: "delegation du banc G6 redemarrage", prompt: "Lis lentement.", enFond: true })), ...lent(10)];
    const demande = await lancerDemande(ctx, etat.client, { ecoute, plafond: "2.00", texteEnvoye: "Délègue une lecture lente.", racine, commune: lent(6) });
    if (!r.ajouter("[redemarrage] demande lancée", demande.envoyee, demande.raison ?? "")) return;
    await attendreAppels(suivi, 1, 60_000);
    const seconde = await secondeSession(ctx, demande, "Lis le LISEZMOI, lentement.");
    // Deux sessions de l'arbre qui ont appelé le faux, dont au moins un appel encore en vol.
    let enVol = [];
    const debutAttente = Date.now();
    while (Date.now() - debutAttente < 120_000) {
      const sessionsVues = new Set(suivi.appels().map((e) => e.copilot?.session).filter(Boolean));
      enVol = suivi.appels().filter((e) => e.servie === null && !e.abandon);
      if (enVol.length >= 1 && sessionsVues.size >= 2) break;
      await pause(500);
    }
    const sessionsAvant = new Set(suivi.appels().map((e) => e.copilot?.session).filter(Boolean));
    if (!r.ajouter("[redemarrage] une demande est en cours au moment du redémarrage (appel en vol au faux)", enVol.length >= 1, `${sessionsAvant.size} session(s), ${enVol.length} appel(s) en vol`)) return;
    const delegations = await delegationsDe(ctx, demande.salle.rootId, { delaiMs: 5_000 });
    r.ajouter(
      "[redemarrage] le redémarrage tombe PENDANT le travail d'une session enfant (deux sessions de l'arbre ont appelé le faux)",
      sessionsAvant.size >= 2 && seconde.id !== null && sessionsAvant.has(seconde.id),
      `${sessionsAvant.size} session(s) ; session enfant ${seconde.id === null ? "non créée" : sessionsAvant.has(seconde.id) ? "au travail" : "muette"} (envoi ${seconde.code}) ; délégation de l'extension : ${delegations.echecs} échec(s) relevé(s)${delegations.lisible ? "" : " (racine illisible)"}`,
    );
    const startIdAvant = (await ctx.etat())?.startId ?? null;
    ecoute.arreter();
    const re = await ctx.compose(["restart", "--timeout", "20", "cockpit"], { delaiMs: 180_000 });
    const ouvert = await ouvrirCockpit(ctx);
    // Reprise : le cockpit répond de nouveau. Le journal du faux est lu À CET INSTANT (numéro du dernier appel reçu, réponses
    // encore en file) : un appel reçu ensuite porte un numéro plus grand, quelle que soit l'heure à laquelle le banc le voit.
    const journalReprise = (await ctx.faux.journal()).json ?? {};
    const nReprise = Number.isInteger(journalReprise.recues) ? journalReprise.recues : Number.POSITIVE_INFINITY;
    const fileReprise = journalReprise.enFile ?? null;
    etat.client = ouvert.client;
    ecoute.rouvrir(ouvert.client);
    r.ajouter("[redemarrage] le cockpit redémarre et répond de nouveau", re.code === 0 && ouvert.avance.code === 200, `restart ${re.code}, mode ${ouvert.avance.code}`);
    // Le démarrage trouvé lancé est arrêté par le cockpit (L23b) : la salle repart à neuf.
    let startIdApres = startIdAvant;
    const debutRelance = Date.now();
    while (Date.now() - debutRelance < 180_000) {
      startIdApres = (await ctx.etat())?.startId ?? null;
      if (startIdApres !== null && startIdApres !== startIdAvant) break;
      await pause(1000);
    }
    await pause(20_000);
    await suivi.arreter();
    const journalFin = (await ctx.faux.journal()).json ?? {};
    // Appels d'IA reçus après la reprise (le catalogue `/models` d'un opencode relancé n'est pas un appel d'IA).
    const apres = (journalFin.journal ?? []).filter((e) => Number.isInteger(e?.n) && e.n > nReprise && e.route === "chat");
    const listeFaits = await faits(etat.client, demande.salle.rootId);
    const statuts = listeFaits.filter((f) => f?.kind === "statut").map((f) => f.data);
    r.mesures.redemarrage = {
      startIdAvant,
      startIdApres,
      appelsApresReprise: apres.length,
      appelsEnVol: enVol.map((e) => ({ n: e.n, ia: e.ia })),
      fileAvantApres: [fileReprise, journalFin.enFile ?? null],
      statuts,
    };
    r.ajouter("[redemarrage] la salle trouvée lancée est relancée à neuf (nouveau démarrage)", startIdApres !== null && startIdApres !== startIdAvant, `${String(startIdAvant).slice(0, 8)}… → ${String(startIdApres).slice(0, 8)}…`);
    r.ajouter(
      "[redemarrage] AUCUN appel d'IA au faux après la reprise du cockpit (réponses restées en file)",
      Number.isFinite(nReprise) && apres.length === 0,
      `${apres.length} appel(s) après la reprise ; file ${JSON.stringify(fileReprise)} → ${JSON.stringify(journalFin.enFile ?? null)}${apres.length > 0 ? ` : ${JSON.stringify(apres.map((e) => ({ n: e.n, ia: e.ia })))}` : ""}`,
    );
    r.ajouter("[redemarrage] la demande interrompue est close « redemarrage-cockpit » (fait « statut »)", statuts.some((s) => s?.motif === "redemarrage-cockpit"), JSON.stringify(statuts).slice(0, 300));
  } finally {
    await suivi.arreter();
    await ecrireDiagnostic(ctx, "g6-redemarrage", { ecoute, suivi, depuis: debutCas });
  }
}

async function casDuree(ctx, client, ecoute, r) {
  const debutCas = Date.now();
  const suivi = suivreFaux(ctx.faux, { pasMs: 2000 });
  try {
    // 70 appels de 55 s : la demande reste occupée plus de 60 minutes et ne se termine jamais d'elle-même avant.
    const racine = Array.from({ length: 70 }, () => lente(appels(lecture(`${DOSSIER}/LISEZMOI.md`)), 55_000));
    const demande = await lancerDemande(ctx, client, { ecoute, plafond: "4.00", texteEnvoye: "Lis lentement, longtemps.", racine });
    if (!r.ajouter("[duree] demande lancée", demande.envoyee, demande.raison ?? "")) return;
    const arret = await verifierArret(r, "duree", { ecoute, client, suivi, demande, cause: "plafond-duree", delaiMs: 68 * 60_000 });
    const minutes = arret.recu === null ? null : Math.round(((arret.recu - demande.debut) / 60_000) * 10) / 10;
    r.mesures.duree = { minutes, appels: suivi.appels().length };
    r.ajouter("[duree] arrêt au bout de 60 minutes (entre 60 et 62)", minutes !== null && minutes >= 59.9 && minutes <= 62, `${minutes} min`);
  } finally {
    await suivi.arreter();
    await ecrireDiagnostic(ctx, "g6-duree", { ecoute, suivi, depuis: debutCas });
  }
}

export default {
  id: "g6",
  titre: "G6 Plafonds : montant saisi, un appel par session occupée, 30 sessions, 429, seuil mensuel, durée, redémarrage",
  async executer(ctx) {
    const ouvert = await ouvrirCockpit(ctx);
    if (ouvert === null) return { sansObjet: "porte du banc complet : lancée hors du mode --complet (aucun cockpit réel à joindre)" };
    const r = registre();
    const etat = { client: ouvert.client };
    r.ajouter("cockpit réel joint, mode Avancé", ouvert.avance.code === 200, `code ${ouvert.avance.code}`);
    const ecoute = ecouter(etat.client);
    const cas = [
      ["refus", () => casRefus(ctx, etat.client, r)],
      ["tentatives", () => casTentatives(ctx, etat.client, ecoute, r)],
      ["cout", () => casCout(ctx, etat.client, ecoute, r)],
      ["sessions", () => casSessions(ctx, etat.client, ecoute, r)],
      ["mensuel", () => casMensuel(ctx, etat.client, ecoute, r)],
      ["redemarrage", () => casRedemarrage(ctx, etat, ecoute, r)],
    ];
    try {
      for (const [nom, jouer] of cas) {
        if (!casDemande("g6", nom)) continue;
        const prete = await attendrePrete(etat.client);
        if (!r.ajouter(`[${nom}] salle prête avant le cas`, prete.ok, `état ${prete.etat ?? "?"} en ${Math.round(prete.attenteMs / 1000)} s`)) break;
        try {
          await jouer();
        } catch (err) {
          r.ajouter(`[${nom}] exécution`, false, String(err?.stack ?? err).slice(0, 800));
        } finally {
          // Isolation : un cas qui laisse une demande active (arrêt lent, enchaînement d'outils) ne doit pas empoisonner le suivant.
          await assainir(etat.client).catch(() => undefined);
        }
      }
      if (process.env.BANC_G6_DUREE === "1" && casDemande("g6", "duree")) {
        const prete = await attendrePrete(etat.client);
        if (r.ajouter("[duree] salle prête avant le cas", prete.ok, `état ${prete.etat ?? "?"}`)) {
          try {
            await casDuree(ctx, etat.client, ecoute, r);
          } catch (err) {
            r.ajouter("[duree] exécution", false, String(err?.stack ?? err).slice(0, 800));
          }
        }
      } else {
        r.attendre("[duree] plafond de 60 minutes", "exécution dédiée d'environ 62 min : relancer la porte avec BANC_G6_DUREE=1 (et BANC_L27B_CAS=g6:duree pour ne jouer qu'elle)");
      }
      const fin = await attendrePrete(etat.client);
      r.ajouter("la salle est de nouveau prête à la fin de la porte", fin.ok, `état ${fin.etat ?? "?"}`);
    } finally {
      ecoute.arreter();
      // Attentes du flux de la salle avant chaque demande (fenêtre aveugle du banc, constat de l'espion remis à l'intégrateur).
      r.mesures.attentesFlux = ATTENTES_FLUX.map((a) => ({ ok: a.ok, attenteMs: a.attenteMs }));
      ctx.ecrireSortie?.("g6-plafonds.json", `${JSON.stringify(r.rendu(), null, 2)}\n`);
    }
    return r.rendu();
  },
};
