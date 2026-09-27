// Banc COMPLET (L21b), scénario de fumée du cockpit RÉEL : le chemin de la page, du début à la fin.
//   salle ouverte → activation à 0,10 $ → un appel d'outil → fin de demande → relance à neuf.
//
// Il ne tourne qu'en mode `--complet` (cockpit réel jetable). Il parle au cockpit par ses VRAIES routes (lib/lib-activation.mjs),
// arrête, attend et compte par lib/lib-arret.mjs — les deux bibliothèques communes à L27a et L27b.
//
// Ce que ce scénario prouve dépend de ce que la tête d'où le cockpit a été bâti LIVRE (cockpit/preparer.mjs le lit dans la source
// extraite, jamais d'un code HTTP) :
// - toujours, avec le cockpit réel : la bascule `SALLE_OUVERTE` portée par l'image ; l'authentification PUBLIÉE par le cockpit
//   (entrée `github-copilot` seule, 0600, relevée sans jamais lire la valeur) ; le PRÉ-CONTRÔLE réel du démarrage (le
//   `precheck-ok` du cockpit porte le `startId` publié par le superviseur) ; l'ouverture d'une salle sur un projet préparé, par
//   la vraie route, qui crée la racine sur la salle À TRAVERS l'espion ; zéro `POST …/command` ;
// - quand le cockpit bat lui-même (un code de production appelle `startHeartbeat()`) : la salle prête sans aucun pilote ;
// - quand l'activation « omo » est livrée (L22c) : activation à 0,10 $, un appel d'outil, fin de demande et relance à neuf.
// Ce qui n'est pas livré n'est NI vert NI rouge : c'est une étape EN ATTENTE, nommée avec sa raison dans le bilan. Et même en
// attente, une activation refusée doit n'avoir RIEN envoyé à la salle : cela, c'est vérifié.
//
// Aucune dépendance npm (P8).
import { activer, amorce, attendreEtatSalle, connecterCockpit, envoyer, modeleDeLaSalle, ouvrirSalle, passerEnAvance, statutSalle } from "../lib/lib-activation.mjs";
import { attendreNouveauDemarrage, attendreRepos, compteursEspion, ecartActivite, releverActivite } from "../lib/lib-arret.mjs";
import { lecture, unOutilPuisFin } from "../lib/scenarios-faux.mjs";

const PROJET = "projet-ouvert";
const DOSSIER = `/workspace/${PROJET}`;
/** Montant de la fumée, en CHAÎNE comme la page le saisit (lib-activation, règle 1) ; jamais une valeur par défaut du produit. */
export const PLAFOND_FUMEE = "0.10";

/**
 * Sonde de l'authentification publiée, dans un conteneur jetable SANS réseau, en tant que `node` : les NOMS des entrées et les
 * droits du fichier, jamais une valeur. C'est tout ce que la fumée a besoin de savoir d'un `auth.json`, même factice.
 */
export const SONDE_AUTH = `
const fs = require("node:fs");
try {
  const st = fs.statSync("/lu/auth.json");
  const cles = Object.keys(JSON.parse(fs.readFileSync("/lu/auth.json", "utf8"))).sort();
  process.stdout.write(JSON.stringify({ present: true, cles, mode: (st.mode & 0o777).toString(8), uid: st.uid }));
} catch (e) {
  process.stdout.write(JSON.stringify({ present: false, erreur: String(e && e.code || "illisible") }));
}
`;

async function sonderAuth(ctx) {
  const r = await ctx.docker(
    ["run", "--rm", "--network", "none", "--cap-drop", "ALL", "--security-opt", "no-new-privileges:true", "--user", "1000:1000",
      "--volume", `${ctx.projet}_omo-auth:/lu:ro`, "--entrypoint", "node", ctx.imageApp, "-e", SONDE_AUTH],
    { delaiMs: 60_000, silencieux: true },
  );
  try {
    return JSON.parse(String(r.sortie).trim());
  } catch {
    return { present: false, erreur: `sonde illisible (code ${r.code})` };
  }
}

/** `precheck-ok` du volume de contrôle : il n'est pas secret (un startId, une heure, des chemins et des empreintes). */
async function lirePrecheckOk(ctx) {
  const texte = await ctx.lireVolume("control-omo", "precheck-ok");
  if (texte === null) return null;
  try {
    return JSON.parse(texte);
  } catch {
    return null;
  }
}

export default {
  id: "cockpit-fumee",
  titre: "Fumée du cockpit réel : salle ouverte, activation 0,10 $, un appel d'outil, fin de demande → relance",
  async executer(ctx) {
    const points = [];
    const enAttente = [];
    const mesures = {};
    const ajouter = (nom, ok, detail) => points.push({ nom, ok: Boolean(ok), detail });
    const attendreAussi = (etape, raison) => enAttente.push({ etape, raison });

    if (!ctx.cockpitPort || !ctx.cockpitJeton) {
      return { sansObjet: "scénario du cockpit réel : lancé hors du mode --complet (aucun cockpit à joindre)" };
    }
    const livre = { activation: ctx.activationLivree === true, battementCockpit: ctx.battementCockpit === true };
    mesures.fumee = { livre, battementBanc: ctx.battementBanc === true, plafond: PLAFOND_FUMEE };

    // 1. Cockpit réel joint, mode Avancé, porte du code ouverte DANS CETTE IMAGE.
    const client = await connecterCockpit({ port: ctx.cockpitPort, jeton: ctx.cockpitJeton, delaiMs: 180_000 });
    const avance = await passerEnAvance(client);
    ajouter("le cockpit réel passe en mode Avancé (la salle n'existe qu'en Avancé)", avance.code === 200, `code ${avance.code}`);
    const boot = await amorce(client);
    const salleOuverte = boot.json?.omo?.salleOuverte === true;
    ajouter("l'image du cockpit porte SALLE_OUVERTE=true (bascule de la copie jetable)", salleOuverte, `Bootstrap.omo = ${JSON.stringify(boot.json?.omo ?? null)}`);
    if (!salleOuverte) return { points, mesures, enAttente };

    // Compteurs de départ : tout ce que le cockpit demande à la salle passe par l'espion.
    const depart = await compteursEspion(ctx.portEspion).catch(() => null);

    // 2. Authentification publiée par le cockpit, au démarrage : entrée github-copilot seule, 0600, à node.
    let auth = null;
    const publiee = await ctx.jusqua(
      async () => {
        auth = await sonderAuth(ctx);
        return auth.present === true;
      },
      { delaiMs: 60_000, pasMs: 2000 },
    );
    mesures.fumee.auth = auth;
    ajouter(
      "authentification publiée par le cockpit : auth.json de la salle réduit à github-copilot, 0600, à node",
      publiee && JSON.stringify(auth.cles) === JSON.stringify(["github-copilot"]) && auth.mode === "600" && auth.uid === 1000,
      JSON.stringify(auth),
    );

    // 3. Battement : celui du cockpit s'il en écrit un ; sinon celui du banc, DIT ; sinon rien ne peut démarrer.
    if (livre.battementCockpit) {
      const bat = await ctx.jusqua(async () => (await statutSalle(client)).json?.battement?.actif === true, { delaiMs: 30_000, pasMs: 1000 });
      ajouter("battement écrit par le cockpit réel (aucun pilote)", bat, bat ? "battement actif" : "aucun battement en 30 s");
    } else if (ctx.battementBanc) {
      attendreAussi(
        "battement du cockpit",
        "aucun code de production n'appelle omoControl.startHeartbeat() : battement et liste des projets déposés par les pilotes du banc (--battement-banc) — constat remis à l'intégrateur",
      );
    } else {
      attendreAussi(
        "battement du cockpit, puis tout le reste",
        "aucun code de production n'appelle omoControl.startHeartbeat() : sans battement la salle ne démarre jamais (homme mort) ; relancer avec --battement-banc pour éprouver le reste",
      );
      return { points, mesures, enAttente };
    }

    // 4. Salle prête : le superviseur a eu battement ET precheck-ok du démarrage en cours.
    const prete = await attendreEtatSalle(client, ["prete"], { delaiMs: 240_000, pasMs: 2000 });
    mesures.fumee.salle = { etat: prete.etat, attenteMs: prete.attenteMs };
    ajouter("la salle devient « prête » derrière le cockpit réel", prete.ok, `état ${prete.etat ?? "?"} en ${Math.round(prete.attenteMs / 1000)} s`);
    if (!prete.ok) {
      ctx.ecrireSortie("cockpit-fumee-etat.json", `${JSON.stringify({ statut: prete.statut?.json ?? null, etat: await ctx.etat() }, null, 2)}\n`);
      return { points, mesures, enAttente };
    }

    // 5. Pré-contrôle RÉEL : le precheck-ok du volume porte le startId publié par le superviseur, et le cockpit l'a inscrit.
    const etat = await ctx.etat();
    const precheck = await lirePrecheckOk(ctx);
    const statut = (await statutSalle(client)).json;
    const projetsOk = Array.isArray(precheck?.projets) ? precheck.projets.map((p) => p.chemin).sort() : [];
    mesures.fumee.precheck = { startId: etat?.startId ?? null, precheckStartId: precheck?.startId ?? null, projets: projetsOk, dernierDemarrage: statut?.dernierDemarrage?.startId ?? null };
    ajouter(
      "pré-contrôle réel du cockpit : precheck-ok du démarrage en cours, inscrit dans omo_room_starts",
      typeof etat?.startId === "string" && precheck?.startId === etat.startId && statut?.dernierDemarrage?.startId === etat.startId && projetsOk.length >= 1,
      JSON.stringify(mesures.fumee.precheck),
    );

    // 6. Ouverture d'une salle sur le projet préparé, par la vraie route : la racine est créée SUR LA SALLE, à travers l'espion.
    const salle = await ouvrirSalle(client, PROJET);
    const apresOuverture = await compteursEspion(ctx.portEspion).catch(() => null);
    const sessionsCreees = (apresOuverture?.requetes?.session ?? 0) - (depart?.requetes?.session ?? 0);
    ajouter(
      "une salle s'ouvre sur le projet préparé ; la racine est créée sur la salle (POST /session vu par l'espion)",
      salle.code === 200 && salle.rootId !== null && sessionsCreees >= 1,
      `code ${salle.code}, projet ${salle.projet ?? "?"}, sessions créées par HTTP ${sessionsCreees}`,
    );
    if (salle.rootId === null) return { points, mesures, enAttente };

    // 7. Activation à 0,10 $. Livrée : elle doit passer. Non livrée : EN ATTENTE, mais le refus ne doit rien avoir envoyé.
    await ctx.faux.reinitialiser();
    await ctx.faux.reponses({ reponses: unOutilPuisFin(lecture(`${DOSSIER}/LISEZMOI.md`)) });
    const avant = await releverActivite({ portEspion: ctx.portEspion, faux: ctx.faux });
    const startIdAvant = etat?.startId ?? null;
    const activation = await activer(client, salle.rootId, PLAFOND_FUMEE);
    mesures.fumee.activation = { code: activation.code, erreur: activation.erreur };
    const activee = activation.code >= 200 && activation.code < 300;
    if (!activee) {
      await ctx.attendre(3000);
      const apresRefus = await releverActivite({ portEspion: ctx.portEspion, faux: ctx.faux });
      const ecart = ecartActivite(avant, apresRefus);
      ajouter("activation refusée : RIEN n'est parti vers la salle ni vers le faux fournisseur", ecart.envois === 0 && ecart.appelsFournisseur === 0 && ecart.commandes === 0, JSON.stringify({ envois: ecart.envois, appels: ecart.appelsFournisseur, commandes: ecart.commandes }));
      if (livre.activation) {
        ajouter(`activation à ${PLAFOND_FUMEE} $ acceptée`, false, `code ${activation.code} (${activation.erreur ?? "?"})`);
      } else {
        attendreAussi(`activation à ${PLAFOND_FUMEE} $`, `« omo » n'est pas un choix livré sur cette tête (L22c, train de la vague 4) : PUT …/autonomie → ${activation.code} ${activation.erreur ?? ""}`.trim());
        attendreAussi("un appel d'outil dans la salle", "suit l'activation (L22c)");
        attendreAussi("fin de demande → relance à neuf", "suit l'activation (L22c, L22d, L23b)");
      }
    } else {
      ajouter(`activation à ${PLAFOND_FUMEE} $ acceptée`, true, `code ${activation.code}`);
      // L'IA de l'envoi est une de celles que la salle sert (catalogue du faux Copilot lu par la salle), jamais un nom deviné.
      const providers = await ctx.clientSalle.get(`/config/providers?directory=${encodeURIComponent(DOSSIER)}`, { delaiMs: 30_000 }).catch(() => null);
      const model = modeleDeLaSalle(providers?.json ?? null);
      mesures.fumee.model = model;
      if (model === null) {
        ajouter("la salle sert au moins une IA github-copilot (catalogue du faux)", false, `GET /config/providers → ${providers?.code ?? "injoignable"}`);
        return { points, mesures, enAttente };
      }
      const envoi = await envoyer(client, salle.rootId, DOSSIER, "Lis le LISEZMOI, rien de plus.", { model });
      const renvoi = envoi.renvoye ? `, renvoyé une fois avec l'IA de l'assistant (${envoi.model.modelID})` : "";
      mesures.fumee.envoi = { code: envoi.code, erreur: envoi.erreur, renvoye: envoi.renvoye === true, model: envoi.model };
      ajouter("l'envoi part vers la salle", envoi.code >= 200 && envoi.code < 300, `code ${envoi.code}${envoi.erreur ? ` (${envoi.erreur})` : ""}, IA ${model.modelID}${renvoi}`);
      // Fin de demande : le cockpit clôt la demande et demande l'arrêt ; le superviseur sort, Docker relance, un NOUVEAU startId
      // est publié, le pré-contrôle réel le contrôle, opencode repart. La salle relancée ne doit porter aucune session occupée.
      const relance = await attendreNouveauDemarrage(() => ctx.etat(), startIdAvant, { delaiMs: 240_000 });
      mesures.fumee.relance = relance;
      ajouter("fin de demande → relance à neuf (nouveau startId, opencode relancé)", relance.ok, `startId ${relance.startId === null ? "?" : relance.startId.slice(0, 8)}…, ${Math.round(relance.attenteMs / 1000)} s`);
      const repos = await attendreRepos(ctx.clientSalle, DOSSIER, { delaiMs: 60_000 });
      ajouter("la salle relancée est au repos (aucune session occupée)", relance.ok && repos.ok, `en ${Math.round(repos.attenteMs / 1000)} s`);
      const apres = await releverActivite({ portEspion: ctx.portEspion, faux: ctx.faux });
      const ecart = ecartActivite(avant, apres);
      mesures.fumee.ecart = ecart;
      ajouter("l'espion a compté l'appel d'outil (un envoi, deux appels au faux au moins)", ecart.envois >= 1 && ecart.appelsFournisseur >= 2, JSON.stringify({ envois: ecart.envois, appels: ecart.appelsFournisseur }));
    }

    // 8. Sur toute la fumée : AUCUN `POST …/command` vers la salle (G5, D-2b-30).
    const fin = await compteursEspion(ctx.portEspion).catch(() => null);
    const commandes = (fin?.requetes?.commande ?? 0) - (depart?.requetes?.commande ?? 0);
    ajouter("zéro POST …/command vers la salle pendant toute la fumée", fin !== null && commandes === 0, `${commandes} commande(s)`);

    ctx.ecrireSortie("cockpit-fumee.json", `${JSON.stringify({ points, enAttente, mesures: mesures.fumee }, null, 2)}\n`);
    return { points, mesures, enAttente };
  },
};
