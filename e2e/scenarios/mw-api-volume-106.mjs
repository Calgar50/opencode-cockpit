// Migration du web 1.0.x → 1.1.0 (décision A37, fiche MW §6 T7) : une installation 1.0.6 mise à jour, sur un VRAI opencode 1.18.30.
//
// Pile « --reel-hors-ligne --volume-1-0-6 » (e2e/lib/docker-e2e.mjs, section mw:) : le volume oc-config a reçu le fichier livré
// de la 1.0.0 à la 1.0.6 (fournisseur du banc en plus), puis la migration l'a traité AVANT le démarrage (ligne « migré, Prudent,
// copie créée » exigée par le banc), et un temporaire non migré a été laissé comme leurre. Ce scénario vérifie ce que sert la pile :
//   1. GET /api/opencode/config : permission = profil Prudent 1.1 (web refusé) ; opencode a donc démarré avec la copie
//      opencode.jsonc.avant-1.1.0 et le temporaire présents, sans les lire (tous deux gardent le web sur « ask ») ;
//   2. /api/opencode/config/raw : le fichier attendu à l'octet, commentaires de la 1.0.6 gardés ;
//   3. security.webIssues = { global: false, assistants: [] } (MW-b, exigé depuis le train de la vague 2) ;
//   4. webfetch et websearch refusés par les règles effectives de chaque agent (GET /agent, evaluate) : websearch n'est jamais
//      proposé à ce fournisseur, la preuve de son refus est donc la règle ;
//   5. webfetch absent des outils envoyés au faux fournisseur pour un vrai tour ;
//   6. second passage (ctx.migrerVolume : arrêt d'opencode, conteneur jetable, relance) : « conforme », texte identique à celui
//      relu JUSTE AVANT.
// « Non joué » sans l'option ET en « --faux » : ni l'image opencode ni son superviseur n'y tournent, il n'y a pas de volume à migrer.
import fs from "node:fs";
import path from "node:path";
import { evaluate, PERMISSION_PRESETS } from "../../app/server/shared/assistant-rules.ts";
import { attendreFinDuTour, attendreQue, exiger, iaDuBanc, libererLesDemandes, nonJoue, oc, releve, requetesAvecOutils, resume } from "./it1-api-commun.mjs";

const RACINE = path.resolve(import.meta.dirname, "..", "..");
const ATTENDU = fs.readFileSync(path.join(RACINE, "e2e", "lib", "opencode-volume-1.0.6.migre.jsonc"), "utf8");
const CONFORME = "migration-web etat=conforme profil=- fichier=opencode.jsonc blocs=0 restes=0 sauvegarde=- raison=-";

/** Égalité de deux valeurs JSON, ordre des clés ignoré. */
function egal(a, b) {
  if (a === b) return true;
  if (Array.isArray(a) || Array.isArray(b)) return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((v, i) => egal(v, b[i]));
  if (a && b && typeof a === "object" && typeof b === "object") {
    const ka = Object.keys(a);
    return ka.length === Object.keys(b).length && ka.every((k) => Object.hasOwn(b, k) && egal(a[k], b[k]));
  }
  return false;
}

async function exigerPrudent11(ctx, libelle) {
  const config = await ctx.api.get("/api/opencode/config");
  exiger(egal(config?.permission, PERMISSION_PRESETS.prudent.permission), `${libelle} : permission servie ${resume(config?.permission)} au lieu du Prudent 1.1.`);
}

export async function run(ctx) {
  if (ctx.mode !== "reel-hors-ligne" || ctx.volume106 !== true) {
    nonJoue(
      ctx,
      "migration du volume 1.0.6",
      ctx.mode === "faux" ? "ni l'image opencode ni son superviseur ne tournent en « --faux »" : "elle demande « --reel-hors-ligne --volume-1-0-6 »",
    );
    return;
  }

  // 1. et 2. Ce que sert la pile migrée.
  await exigerPrudent11(ctx, "après la migration");
  const raw = await ctx.api.get("/api/opencode/config/raw");
  exiger(raw?.file === "opencode.jsonc", `fichier servi : ${resume(raw?.file)}`);
  exiger(raw.content === ATTENDU, "le fichier servi n'est pas l'attendu migré à l'octet (e2e/lib/opencode-volume-1.0.6.migre.jsonc).");
  exiger(raw.content.includes("// Configuration initiale posée par opencode-cockpit au premier démarrage."), "commentaires de la 1.0.6 perdus.");
  releve(ctx, "volume 1.0.6 migré : Prudent 1.1 servi, fichier attendu à l'octet, copie et temporaire présents et ignorés");

  // 3. Signalement (MW-b, intégré au train de la vague 2) : le champ est exigé. null veut dire « opencode injoignable ou budget de
  // 3 s dépassé » (jamais un faux « fermé ») : relu jusqu'à une valeur, puis comparé.
  const bootstrap = await ctx.api.get("/api/bootstrap");
  exiger(bootstrap?.security !== undefined && Object.hasOwn(bootstrap.security, "webIssues"), "security.webIssues absent du bootstrap (MW-b).");
  const webIssues = await attendreQue(async () => (await ctx.api.get("/api/bootstrap"))?.security?.webIssues ?? null, {
    delaiMs: 60_000,
    pasMs: 2_000,
    libelle: "security.webIssues lisible",
  });
  exiger(egal(webIssues, { global: false, assistants: [] }), `security.webIssues : ${resume(webIssues)}`);
  releve(ctx, "security.webIssues = { global: false, assistants: [] } : plus rien ne peut demander Internet");

  // 4. Règles effectives de chaque agent : webfetch et websearch refusés.
  const client = oc(ctx);
  const agents = (await client.agents()) ?? [];
  exiger(agents.some((a) => a.name === "build"), "assistant « build » absent de GET /agent.");
  for (const agent of agents.filter((a) => Array.isArray(a.permission))) {
    for (const outil of ["webfetch", "websearch"]) {
      exiger(evaluate(agent.permission, outil, "https://exemple.invalid/") === "deny", `${agent.name} : ${outil} n'est pas refusé par ses règles effectives.`);
    }
  }

  // 5. Un vrai tour : webfetch absent des outils envoyés au faux fournisseur.
  const ia = iaDuBanc(bootstrap);
  const debut = (await ctx.billedCalls()).length;
  const creee = await client.creerConversation("mw-api-volume-106");
  exiger(typeof creee?.id === "string", `conversation non créée : ${resume(creee)}`);
  try {
    const envoi = await client.envoyer(creee.id, "Bonjour.", ia);
    exiger(envoi.code === 204, `envoi refusé (${envoi.code}) : ${resume(envoi.corps)}`);
    await attendreFinDuTour(client, creee.id);
    const requetes = await requetesAvecOutils(ctx, debut);
    exiger(requetes.length > 0, "le faux fournisseur n'a reçu aucune requête avec des outils pour ce tour.");
    for (const requete of requetes) {
      const web = requete.outils.filter((outil) => outil === "webfetch" || outil === "websearch");
      exiger(web.length === 0, `outils web envoyés à l'IA : ${web.join(", ")}`);
    }
    releve(ctx, `outils envoyés à l'IA (${requetes.length} requête(s)) sans webfetch ni websearch`);
  } finally {
    await libererLesDemandes(ctx, [creee.id]);
  }

  // 6. Second passage : conforme, texte identique à celui relu juste avant.
  const avant = (await ctx.api.get("/api/opencode/config/raw"))?.content;
  const { ligne } = await ctx.migrerVolume();
  exiger(ligne === CONFORME, `second passage : « ${ligne} » au lieu de « ${CONFORME} ».`);
  await attendreQue(async () => (await ctx.api.get("/api/bootstrap"))?.opencode?.reachable === true, { delaiMs: 180_000, pasMs: 1_000, libelle: "opencode relancé" });
  const apres = (await ctx.api.get("/api/opencode/config/raw"))?.content;
  exiger(apres === avant, "second passage : le fichier a changé.");
  await exigerPrudent11(ctx, "après le second passage");
  releve(ctx, `second passage : ${ligne}`);
}
