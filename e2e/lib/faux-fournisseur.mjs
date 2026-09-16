// Banc e2e (L7a), mode « --reel-hors-ligne » : faux fournisseur compatible OpenAI pour un vrai opencode 1.18.30.
//
// Aucune IA réelle, aucun appel facturé, aucune sortie Internet : le levier mesuré par M-B1 (MX1 §8) est
// « COCKPIT_ALLOWED_PROVIDERS=banc », « COCKPIT_COPILOT_API_URL » vide, aucun auth.json, et une configuration
// d'opencode dont enabled_providers ne contient que ce fournisseur (e2e/lib/opencode-hors-ligne.jsonc).
//
// Deux ports : 8080 sert l'API du fournisseur à opencode, 8081 le pilotage du banc (jeton obligatoire), publié sur
// 127.0.0.1 seulement.
import { createHash, timingSafeEqual } from "node:crypto";
import http from "node:http";

const PORT_API = Number(process.env.E2E_PORT_API ?? 8080);
const PORT_BANC = Number(process.env.E2E_PORT_BANC ?? 8081);
const JETON = process.env.E2E_JETON_CONTROLE ?? "";
const MAX_CORPS = 4_194_304;

if (!JETON) {
  console.error("faux fournisseur : E2E_JETON_CONTROLE manquant.");
  process.exit(2);
}

const memeSecret = (donne, attendu) =>
  timingSafeEqual(createHash("sha256").update(String(donne ?? "")).digest(), createHash("sha256").update(String(attendu ?? "")).digest());

/** Requêtes reçues : ce que le banc relève par ctx.billedCalls(). Aucun texte de message n'est gardé (P-secrets). */
const requetes = [];
/** Réponses à jouer, dans l'ordre ; à défaut, la réponse par défaut. */
const scripts = [];
let parDefaut = { texte: "Réponse du faux fournisseur du banc.", cout: { entree: 20, sortie: 6 } };

const lireCorps = async (req) => {
  const morceaux = [];
  let taille = 0;
  for await (const morceau of req) {
    taille += morceau.length;
    if (taille > MAX_CORPS) throw new Error("corps trop long");
    morceaux.push(morceau);
  }
  const texte = Buffer.concat(morceaux).toString("utf8");
  return texte ? JSON.parse(texte) : {};
};

const repondre = (res, code, corps) => {
  res.writeHead(code, { "content-type": "application/json", "cache-control": "no-store" });
  res.end(JSON.stringify(corps));
};

const empreinte = (valeur) => createHash("sha256").update(typeof valeur === "string" ? valeur : JSON.stringify(valeur ?? "")).digest("hex").slice(0, 12);

const api = http.createServer((req, res) => {
  void (async () => {
    try {
      const chemin = new URL(req.url ?? "/", "http://fournisseur").pathname;
      if (req.method === "GET" && chemin === "/v1/models") {
        repondre(res, 200, { object: "list", data: [{ id: "banc-1", object: "model", owned_by: "banc" }] });
        return;
      }
      if (req.method !== "POST" || chemin !== "/v1/chat/completions") {
        repondre(res, 404, { error: { message: "route inconnue" } });
        return;
      }
      const corps = await lireCorps(req);
      const reponse = scripts.shift() ?? parDefaut;
      // Relevé sans aucun texte : outils proposés, empreinte du message système, nombre de messages.
      requetes.push({
        recu: Date.now(),
        modele: corps.model ?? null,
        outils: (corps.tools ?? []).map((t) => t.function?.name).filter(Boolean),
        messages: (corps.messages ?? []).length,
        systeme: empreinte((corps.messages ?? []).find((m) => m.role === "system")?.content),
        flux: corps.stream === true,
      });
      if (corps.stream === true) envoyerFlux(res, corps.model ?? "banc-1", reponse);
      else repondre(res, 200, blocComplet(corps.model ?? "banc-1", reponse));
    } catch (err) {
      repondre(res, 400, { error: { message: err instanceof Error ? err.message : "requête refusée" } });
    }
  })();
});

function blocComplet(modele, reponse) {
  return {
    id: `chatcmpl-${requetes.length}`,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model: modele,
    choices: [{ index: 0, message: { role: "assistant", content: reponse.texte }, finish_reason: "stop" }],
    usage: { prompt_tokens: reponse.cout?.entree ?? 20, completion_tokens: reponse.cout?.sortie ?? 6, total_tokens: (reponse.cout?.entree ?? 20) + (reponse.cout?.sortie ?? 6) },
  };
}

function envoyerFlux(res, modele, reponse) {
  res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store", connection: "keep-alive" });
  const base = { id: `chatcmpl-${requetes.length}`, object: "chat.completion.chunk", created: Math.floor(Date.now() / 1000), model: modele };
  const bloc = (donnees) => res.write(`data: ${JSON.stringify({ ...base, ...donnees })}\n\n`);
  bloc({ choices: [{ index: 0, delta: { role: "assistant", content: reponse.texte }, finish_reason: null }] });
  bloc({
    choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
    usage: { prompt_tokens: reponse.cout?.entree ?? 20, completion_tokens: reponse.cout?.sortie ?? 6, total_tokens: (reponse.cout?.entree ?? 20) + (reponse.cout?.sortie ?? 6) },
  });
  res.write("data: [DONE]\n\n");
  res.end();
}

const banc = http.createServer((req, res) => {
  void (async () => {
    try {
      const jeton = req.headers["x-banc-jeton"];
      if (typeof jeton !== "string" || !memeSecret(jeton, JETON)) {
        repondre(res, 401, { erreur: "jeton du banc manquant ou incorrect" });
        return;
      }
      const chemin = new URL(req.url ?? "/", "http://banc").pathname;
      if (req.method === "GET" && chemin === "/banc/etat") {
        repondre(res, 200, { fournisseur: "banc", requetes: requetes.length, scripts: scripts.length });
        return;
      }
      if (req.method === "GET" && chemin === "/banc/requetes") {
        repondre(res, 200, { requetes });
        return;
      }
      if (req.method === "GET" && chemin === "/banc/evenements") {
        repondre(res, 200, { evenements: [] });
        return;
      }
      if (req.method === "POST" && chemin === "/banc/script") {
        const corps = await lireCorps(req);
        if (!Array.isArray(corps.tours)) {
          repondre(res, 400, { erreur: "tours (liste) attendu" });
          return;
        }
        scripts.push(...corps.tours);
        repondre(res, 200, { ok: true });
        return;
      }
      if (req.method === "POST" && chemin === "/banc/defaut") {
        const corps = await lireCorps(req);
        if (typeof corps.tour !== "object" || corps.tour === null) {
          repondre(res, 400, { erreur: "tour (objet) attendu" });
          return;
        }
        parDefaut = corps.tour;
        repondre(res, 200, { ok: true });
        return;
      }
      if (req.method === "POST" && chemin === "/banc/oublier") {
        requetes.length = 0;
        scripts.length = 0;
        repondre(res, 200, { ok: true });
        return;
      }
      repondre(res, 404, { erreur: "route inconnue" });
    } catch (err) {
      repondre(res, 400, { erreur: err instanceof Error ? err.message : "requête refusée" });
    }
  })();
});

api.listen(PORT_API, "0.0.0.0", () => console.log(`faux fournisseur : API sur 0.0.0.0:${PORT_API}`));
banc.listen(PORT_BANC, "0.0.0.0", () => console.log(`faux fournisseur : pilotage du banc sur 0.0.0.0:${PORT_BANC}`));

const arreter = (signal) => {
  console.log(`faux fournisseur : arrêt (${signal}).`);
  api.close();
  banc.close();
  process.exit(0);
};
process.on("SIGTERM", () => arreter("SIGTERM"));
process.on("SIGINT", () => arreter("SIGINT"));
