// Banc (L21b), scénario `hooks` : PROVOQUE les automatismes GARDÉS de l'extension et relève leurs messages marqués (M28,
// reste R-7 de la clôture 2 bis). Le banc hors ligne de L21 n'avait relevé AUCUN message marqué (« Rien n'est écrit plutôt
// qu'une conclusion fausse », commit 938e67d) : son faux fournisseur ne rendait que du texte, jamais de quoi déclencher un
// automatisme. Ici, les réponses scriptées (lib/scenarios-faux.mjs) donnent à l'extension de quoi injecter ses directives.
//
// Trois provocations, chacune vers l'agent dont l'automatisme gardé est visé (docs/omo-audit-4.19.4.md, « garder ») :
// - `todo-continuation-enforcer` (agent `build`) : une liste de tâches laissée ouverte, puis le repos ;
// - `prometheus-md-only` (agent `prometheus`) : le planificateur écrit un fichier qui n'est pas un plan Markdown ;
// - `atlas` (agent `atlas`) : l'orchestrateur écrit lui-même au lieu de confier.
// Les agents sont RÉSOLUS dans `GET /agent` par leur clé (« Prometheus - Plan Builder » → `prometheus`, même règle que G12) :
// un nom écrit en dur retomberait en silence sur l'agent par défaut.
//
// Un répondeur DU BANC tient la place de celui du cockpit (L22d) pendant chaque provocation : il accorde « une fois » la seule
// écriture d'un fichier du projet jetable ouvert (sous `/workspace/projet-ouvert/`), et REFUSE toute autre demande (commande,
// lecture hors projet…). Sans lui, une écriture resterait en attente d'une autorisation, et l'automatisme qui la suit ne
// partirait jamais. Il ne lit que le type de la demande et ses motifs de chemin.
//
// Ce qui est relevé, sans jamais garder de contenu : les TYPES de directives marquées `[SYSTEM DIRECTIVE: OH-MY-OPENCODE - <TYPE>]`
// (même motif que la détection 2 du cockpit, app/server/shared/message-origin.ts) et les marqueurs internes `OMO_INTERNAL_*`, sur
// QUATRE canaux : le flux d'événements, les conversations stockées (une directive ajoutée à la sortie d'un outil peut ne vivre
// que là), le journal du conteneur, et le journal de l'extension (`oh-my-opencode.log`, dont seuls les COMPTES de lignes par
// automatisme visé sont gardés : ils disent si l'automatisme s'est déclenché, même quand sa directive n'arrive nulle part).
// Pour chaque conversation, les outils appelés sont comptés par « nom:état » (noms seuls). Le relevé est REMIS à l'intégrateur
// du train de la vague 4 : la table d'audit (docs/omo-audit-4.19.4.md, L20, close) n'est PAS modifiée ici. Trouver zéro type
// n'est pas un vert déguisé : l'écart est écrit.
//
// Aucun appel facturé : la salle ne parle qu'au faux fournisseur. Aucune dépendance npm (P8).
import { compteursEspion } from "../lib/lib-arret.mjs";
import { atlasEcritDirect, DIRECTIVES_MARQUEES, directivesDe, MARQUEURS_INTERNES, prometheusEcrit, todoInachevee } from "../lib/scenarios-faux.mjs";
import { cleAgent } from "./g12-agents.mjs";
import { typeDEvenement } from "./mesures.mjs";

const DOSSIER = "/workspace/projet-ouvert";
const enc = encodeURIComponent;

/** Modèle demandé à l'envoi : le faux sert toute IA de la famille github-copilot (comme `mesures` et `g1`). */
const MODELE = { providerID: "github-copilot", modelID: "claude-sonnet-5" };

/**
 * Décision du répondeur du banc pour une demande d'autorisation (`GET /permission`) : « once » pour une écriture (`edit`, `write`)
 * dont TOUS les motifs sont des chemins sous le projet jetable ouvert, sans remontée ; « reject » pour tout le reste. Pur.
 */
export function decisionRepondeurBanc(demande, dossier = DOSSIER) {
  const permission = String(demande?.permission ?? demande?.type ?? "");
  const motifs = Array.isArray(demande?.patterns) ? demande.patterns : typeof demande?.pattern === "string" ? [demande.pattern] : [];
  const sous = (m) => typeof m === "string" && !m.includes("..") && (m.startsWith(`${dossier}/`) || (!m.startsWith("/") && !m.startsWith("~") && m !== ""));
  if ((permission === "edit" || permission === "write") && motifs.length > 0 && motifs.every(sous)) return "once";
  return "reject";
}

/** Répondeur du banc : sonde `GET /permission` toutes les secondes et répond selon `decisionRepondeurBanc`. */
function repondeurBanc(ctx) {
  const vues = new Set();
  const compte = { once: 0, reject: 0, erreurs: 0 };
  let actif = true;
  const boucle = (async () => {
    while (actif) {
      const r = await ctx.client.get(`/permission?directory=${enc(DOSSIER)}`, { delaiMs: 10_000 }).catch(() => null);
      for (const demande of Array.isArray(r?.json) ? r.json : []) {
        const id = typeof demande?.id === "string" ? demande.id : null;
        if (id === null || vues.has(id)) continue;
        vues.add(id);
        const reply = decisionRepondeurBanc(demande);
        const envoi = await ctx.client.post(`/permission/${enc(id)}/reply?directory=${enc(DOSSIER)}`, { reply }).catch(() => null);
        if (envoi !== null && envoi.code >= 200 && envoi.code < 300) compte[reply] += 1;
        else compte.erreurs += 1;
      }
      await ctx.attendre(1000);
    }
  })();
  return {
    compte,
    async arreter() {
      actif = false;
      await boucle.catch(() => undefined);
    },
  };
}

/** Nom d'agent de `GET /agent` pour une clé de configuration (`prometheus` → « Prometheus - Plan Builder »), ou null. */
export function nomAgentPourCle(agents, cle) {
  for (const a of Array.isArray(agents) ? agents : []) {
    const nom = typeof a?.name === "string" ? a.name : null;
    if (nom !== null && cleAgent(nom) === cle) return nom;
  }
  return null;
}

/** Journal de l'extension dans la salle (`LOG_FILENAME` de la 4.19.4, sous le dossier temporaire du conteneur). */
export const JOURNAL_EXTENSION = "/tmp/oh-my-opencode.log";

/** Automatismes visés, tels que l'extension les nomme dans son journal (`[<nom>] …`). */
export const AUTOMATISMES_VISES = Object.freeze(["todo-continuation-enforcer", "prometheus-md-only", "atlas"]);

/**
 * Traces des automatismes visés dans un journal de l'extension : nombre de lignes par nom, et types de directives. Jamais une
 * ligne : un journal porte des identifiants et des chemins, le relevé n'en garde que des comptes.
 */
export function tracesAutomatismes(journal) {
  const lignes = String(journal ?? "").split("\n");
  const parNom = Object.fromEntries(AUTOMATISMES_VISES.map((nom) => [nom, lignes.filter((l) => l.includes(`[${nom}]`)).length]));
  // Phrases FIXES de l'extension (le texte de son code, entre « [nom] » et ses données « {…} ») : elles disent ce que
  // l'automatisme a fait ou pourquoi il s'est abstenu. Une phrase qui porterait un chemin, une citation ou des chiffres longs
  // est écartée : seul le texte du code est gardé, jamais une donnée de la session.
  const phrases = Object.fromEntries(
    AUTOMATISMES_VISES.map((nom) => {
      const vues = new Set();
      for (const l of lignes) {
        const i = l.indexOf(`[${nom}] `);
        if (i === -1) continue;
        const phrase = l.slice(i + nom.length + 3).split(" {")[0].trim().slice(0, 100);
        if (phrase !== "" && !/[/\\"'`]|\d{4,}/.test(phrase)) vues.add(phrase);
      }
      return [nom, [...vues].sort((a, b) => a.localeCompare(b)).slice(0, 20)];
    }),
  );
  return { lignes: lignes.filter((l) => l.trim() !== "").length, parNom, phrases, directives: [...new Set(directivesDe(journal))].sort((a, b) => a.localeCompare(b)) };
}

/**
 * Outils d'une conversation stockée (`GET /session/:id/message`) : nombre de parties d'outil par « nom:état », et types de
 * directives présents dans les messages stockés (sorties d'outils comprises). Noms et comptes seulement.
 */
export function releveStocke(messages) {
  const outils = {};
  for (const m of Array.isArray(messages) ? messages : []) {
    for (const p of Array.isArray(m?.parts) ? m.parts : []) {
      if (p?.type !== "tool") continue;
      const cle = `${String(p.tool ?? "?").slice(0, 40)}:${String(p.state?.status ?? "?").slice(0, 20)}`;
      outils[cle] = (outils[cle] ?? 0) + 1;
    }
  }
  return { messages: Array.isArray(messages) ? messages.length : 0, outils, directives: [...new Set(directivesDe(JSON.stringify(messages ?? [])))].sort((a, b) => a.localeCompare(b)) };
}

/** Envoie une demande à un agent, avec ses réponses scriptées, et capture le flux le temps que l'extension réagisse. */
async function provoquer(ctx, { titre, agent, reponses, dureeMs }) {
  const evenements = [];
  const flux = ctx.client.ouvrirFlux("/global/event", (e) => evenements.push(e.donnee), { delaiMs: dureeMs + 30_000 });
  const repondeur = repondeurBanc(ctx);
  await ctx.attendre(1000);
  await ctx.faux.reinitialiser();
  await ctx.faux.reponses({ reponses });
  const creee = await ctx.client.post(`/session?directory=${enc(DOSSIER)}`, { title: titre });
  const id = creee.json?.id ?? null;
  let envoi = null;
  if (id) {
    envoi = await ctx.client.post(`/session/${id}/prompt_async?directory=${enc(DOSSIER)}`, {
      agent,
      model: MODELE,
      parts: [{ type: "text", text: "Fais ce qui est prevu." }],
    });
  }
  await ctx.attendre(dureeMs);
  await repondeur.arreter();
  flux.arreter();
  await flux.promesse.catch(() => null);
  // Abandon de ce qui tournerait encore (une relance de la liste de tâches, par exemple) : la provocation suivante part au repos.
  if (id) await ctx.client.post(`/session/${id}/abort?directory=${enc(DOSSIER)}`, {}).catch(() => null);
  // Second canal : la conversation STOCKÉE (une directive ajoutée à la sortie d'un outil peut n'y vivre que là).
  const stockes = id ? await ctx.client.get(`/session/${id}/message?directory=${enc(DOSSIER)}`, { delaiMs: 30_000 }).catch(() => null) : null;
  const stocke = releveStocke(stockes?.code === 200 ? stockes.json : null);
  const servies = await ctx.faux.journal().catch(() => null);
  return { titre, agent, session: id, envoi: envoi?.code ?? null, evenements, autorisations: repondeur.compte, stocke, appelsFaux: servies?.json?.recues ?? null };
}

export default {
  id: "hooks",
  titre: "M28 (R-7) : provoque les hooks gardés, relève leurs messages marqués",
  async executer(ctx) {
    const points = [];
    const mesures = {};
    const ajouter = (nom, ok, detail) => points.push({ nom, ok: Boolean(ok), detail });

    let agents = null;
    const pret = await ctx.jusqua(
      async () => {
        const r = await ctx.client.get(`/agent?directory=${enc(DOSSIER)}`, { delaiMs: 30_000 }).catch(() => null);
        agents = r !== null && r.code === 200 && Array.isArray(r.json) ? r.json : null;
        return agents !== null && agents.length > 0;
      },
      { delaiMs: 300_000, pasMs: 2000 },
    );
    ajouter("la salle sert ses agents", pret, pret ? `${agents.length} agents` : "l'instance ne sert pas");
    if (!pret) return { points, mesures };

    const vises = [
      { cle: "build", titre: "banc-hooks-todo", reponses: todoInachevee(), dureeMs: 45_000 },
      { cle: "prometheus", titre: "banc-hooks-prometheus", reponses: prometheusEcrit(DOSSIER), dureeMs: 40_000 },
      { cle: "atlas", titre: "banc-hooks-atlas", reponses: atlasEcritDirect(DOSSIER), dureeMs: 40_000 },
    ];
    const resolus = vises.map((v) => ({ ...v, agent: nomAgentPourCle(agents, v.cle) }));
    const manquants = resolus.filter((v) => v.agent === null).map((v) => v.cle);
    ajouter("les agents visés existent dans GET /agent (build, prometheus, atlas)", manquants.length === 0, manquants.length === 0 ? resolus.map((v) => v.agent).join(", ") : `introuvables : ${manquants.join(", ")}`);

    const avant = await compteursEspion(ctx.portEspion).catch(() => null);
    const passes = [];
    for (const v of resolus) {
      if (v.agent === null) continue;
      passes.push(await provoquer(ctx, v));
    }
    const apres = await compteursEspion(ctx.portEspion).catch(() => null);

    // Relevé dans le FLUX (messages injectés), dans les conversations STOCKÉES, dans le JOURNAL du conteneur et dans celui de
    // l'EXTENSION : des TYPES et des comptes, jamais un texte.
    const journal = await ctx.logs("opencode-omo", { lignes: 8000 });
    const journalExtension = await ctx.exec("opencode-omo", ["cat", JOURNAL_EXTENSION], { delaiMs: 60_000 }).catch(() => null);
    const extension = tracesAutomatismes(journalExtension?.code === 0 ? journalExtension.sortie : "");
    const parPasse = passes.map((p) => {
      const types = new Set();
      let messages = 0;
      for (const e of p.evenements) {
        const t = typeDEvenement(e);
        if (t === "message.updated" || t === "message.part.updated") messages += 1;
        for (const d of directivesDe(JSON.stringify(e ?? {}))) types.add(d);
      }
      const marqueurs = MARQUEURS_INTERNES.filter((m) => JSON.stringify(p.evenements).includes(m));
      return {
        titre: p.titre,
        agent: p.agent,
        session: p.session,
        envoi: p.envoi,
        evenements: p.evenements.length,
        messages,
        autorisations: p.autorisations,
        appelsFauxCumules: p.appelsFaux,
        typesMarques: [...types].sort((a, b) => a.localeCompare(b)),
        stocke: p.stocke,
        marqueursInternes: marqueurs,
      };
    });
    const marquesFlux = [...new Set(parPasse.flatMap((p) => p.typesMarques))].sort((a, b) => a.localeCompare(b));
    const marquesStockes = [...new Set(parPasse.flatMap((p) => p.stocke.directives))].sort((a, b) => a.localeCompare(b));
    const marquesJournal = [...new Set([...directivesDe(journal), ...extension.directives])].sort((a, b) => a.localeCompare(b));
    const marqueursInternes = MARQUEURS_INTERNES.filter((m) => journal.includes(m) || parPasse.some((p) => p.marqueursInternes.includes(m)));
    const trouves = [...new Set([...marquesFlux, ...marquesStockes, ...marquesJournal])].sort((a, b) => a.localeCompare(b));
    const inconnus = trouves.filter((t) => !DIRECTIVES_MARQUEES.includes(t));
    const compteEspion =
      avant && apres
        ? {
            commandes: (apres.requetes.commande ?? 0) - (avant.requetes.commande ?? 0),
            envois: (apres.requetes.envoi ?? 0) - (avant.requetes.envoi ?? 0),
            sessionsHttp: (apres.requetes.session ?? 0) - (avant.requetes.session ?? 0),
            abandons: (apres.requetes.abandon ?? 0) - (avant.requetes.abandon ?? 0),
          }
        : null;

    mesures.M28 = {
      typesMarquesFlux: marquesFlux,
      typesMarquesStockes: marquesStockes,
      typesMarquesJournal: marquesJournal,
      journalExtension: { lu: journalExtension?.code === 0, lignes: extension.lignes, tracesParAutomatisme: extension.parNom, phrasesParAutomatisme: extension.phrases },
      marqueursInternes,
      tousLesTypes: trouves,
      typesInconnusDeLaListe: inconnus,
      passes: parPasse,
      compteEspion,
      remisA: "intégrateur du train de la vague 4 (table d'audit L20, close, NON modifiée ici)",
      consequence:
        trouves.length > 0
          ? "types de messages marqués relevés au banc : à comparer à la table d'audit et à la détection 2 (message-origin.ts) au train de la vague 4"
          : "aucun message marqué relevé sur cette passe : les automatismes visés ne se sont pas déclenchés devant le faux fournisseur (écart consigné, pas une preuve d'absence)",
    };
    ctx.ecrireSortie("hooks-m28.json", `${JSON.stringify(mesures.M28, null, 2)}\n`);

    // Un type marqué HORS de la liste de la 4.19.4 serait un défaut de la détection 2 (à relever, jamais à taire).
    ajouter("aucun type marqué hors de la liste de la 4.19.4", inconnus.length === 0, inconnus.join(", ") || "aucun");
    ajouter("chaque provocation a été envoyée (prompt_async accepté)", passes.length === resolus.length && passes.every((p) => p.envoi !== null && p.envoi >= 200 && p.envoi < 300), passes.map((p) => `${p.titre}:${p.envoi}`).join(", "));
    ajouter(
      "l'espion a compté le trafic réel de la salle, et aucun POST …/command",
      compteEspion !== null && compteEspion.envois >= passes.length && compteEspion.commandes === 0,
      compteEspion ? `commandes ${compteEspion.commandes}, envois ${compteEspion.envois}, sessions ${compteEspion.sessionsHttp}, abandons ${compteEspion.abandons}` : "compteurs illisibles",
    );
    // Verdict d'information : le relevé est produit ; zéro type est un écart consigné dans hooks-m28.json, pas un vert de façade.
    ajouter("relevé M28 produit et remis (types relevés, ou écart écrit)", true, trouves.length > 0 ? `types : ${trouves.join(", ")}` : "AUCUN type marqué relevé — écart écrit dans hooks-m28.json");
    return { points, mesures };
  },
};
