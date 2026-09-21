// Porte G9 (partie « pilote ») — homme mort (spéc. §7.5 l.1149, §7.10 l.1226 ; D-2b-25 ; T-L17-c).
//
// La promesse faite à l'utilisateur : si le cockpit disparaît, la salle s'arrête en moins de 30 secondes. La borne calculée
// est de 27 s (20 péremption + 2 vérification + 3 kill + 2 marge), et elle se compte DEPUIS LE DERNIER BATTEMENT ÉCRIT, pas
// depuis l'arrêt du pilote : c'est pour cela que le pilote note chaque battement dans son journal.
//
// Trois choses sont prouvées ici :
// 1. pilote de battement arrêté → opencode arrêté en moins de 27 s depuis le dernier battement écrit ;
// 2. aucun redémarrage sans battement : le conteneur, relancé par Docker (`restart: unless-stopped`), s'arrête à l'étape 7 et
//    ne lance PAS opencode tant qu'aucun battement frais n'est là ;
// 3. `/control` n'est pas inscriptible par `node` (T-L17-c) : sinon la salle tiendrait elle-même son propre homme mort.
//
// La porte remet ensuite la salle en marche (le battement reprend), et mesure au passage MB-2, la durée d'une relance à neuf.

/** Borne du contrat, recopiée ici pour que la porte ne dépende d'aucun module du cockpit. Égalité vérifiée par un test. */
const BORNE_S = 27;

const SONDE_CONTROLE = `
const fs = require("node:fs");
const out = {};
for (const [nom, chemin] of [["controle", "/control"], ["auth", "/auth-src"], ["etat", "/omo-state"], ["config", "/omo-config"]]) {
  const entree = {};
  try { fs.accessSync(chemin, fs.constants.W_OK); entree.inscriptible = true; } catch (e) { entree.inscriptible = false; entree.refus = e.code; }
  try { fs.writeFileSync(chemin + "/temoin-banc.txt", "x"); entree.ecriture = "acceptee"; } catch (e) { entree.ecriture = e.code; }
  try { fs.unlinkSync("/control/heartbeat"); entree.suppression = "acceptee"; } catch (e) { if (nom === "controle") entree.suppression = e.code; }
  out[nom] = entree;
}
process.stdout.write(JSON.stringify(out));
`;

const etatDe = async (ctx) => (await ctx.etat()) ?? { phase: "illisible" };

/** Vrai tant que le processus `opencode serve` tourne dans le conteneur de la salle. */
async function opencodeTourne(ctx) {
  const r = await ctx.exec("opencode-omo", ["sh", "-c", "ps -eo args | grep -c '[o]pencode serve'"], { delaiMs: 20_000 });
  return r.code === 0 && Number(String(r.sortie).trim()) > 0;
}

export default {
  id: "g9",
  titre: "Homme mort : sans battement, la salle s'arrête en moins de 27 s",
  async executer(ctx) {
    const points = [];
    const mesures = {};
    const ajouter = (nom, ok, detail) => points.push({ nom, ok: Boolean(ok), detail });

    // --- 3 d'abord : /control fermé à node (rien ne doit fausser la suite) -------------------------------------------------
    const sonde = await ctx.exec("opencode-omo", ["node", "-e", SONDE_CONTROLE], { delaiMs: 60_000 });
    let vue = null;
    try {
      vue = JSON.parse(String(sonde.sortie).trim());
    } catch {
      vue = null;
    }
    ctx.ecrireSortie("g9-controle.json", `${JSON.stringify(vue ?? { brut: String(sonde.sortie).slice(0, 1200) }, null, 2)}\n`);
    if (vue) {
      ajouter("T-L17-c : /control non inscriptible par node", vue.controle?.inscriptible === false && vue.controle?.ecriture !== "acceptee", JSON.stringify(vue.controle));
      ajouter("le battement ne peut pas être supprimé depuis la salle", vue.controle?.suppression !== "acceptee", JSON.stringify(vue.controle?.suppression));
      ajouter("/auth-src, /omo-state et /omo-config fermés à node (M32)", ["auth", "etat", "config"].every((k) => vue[k]?.inscriptible === false), JSON.stringify({ auth: vue.auth?.ecriture, etat: vue.etat?.ecriture, config: vue.config?.ecriture }));
      mesures.g9Controle = vue;
    } else {
      ajouter("sonde du volume de contrôle lisible", false, String(sonde.erreur).slice(0, 200));
    }

    const avant = await etatDe(ctx);
    ajouter("la salle tourne avant l'épreuve", avant.phase === "opencode-lance", `phase ${avant.phase}`);

    // --- 1. Le pilote s'arrête ---------------------------------------------------------------------------------------------
    const battementsAvant = ctx.lignesSortie("battement.jsonl");
    await ctx.compose(["stop", "--timeout", "5", "banc-battement"], { delaiMs: 90_000 });
    const battements = ctx.lignesSortie("battement.jsonl");
    const dernier = battements.length > 0 ? battements[battements.length - 1].at : Date.now();
    ctx.dire(`  G9 : ${battements.length} battements écrits (${battements.length - battementsAvant.length} pendant l'arrêt), dernier à ${new Date(dernier).toISOString()}`);

    const arrete = await ctx.jusqua(async () => !(await opencodeTourne(ctx)), { delaiMs: 90_000, pasMs: 500 });
    const finOpencode = Date.now();
    const delaiS = (finOpencode - dernier) / 1000;
    ajouter(`opencode arrêté en ${delaiS.toFixed(1)} s depuis le dernier battement (borne ${BORNE_S} s)`, arrete && delaiS <= BORNE_S, `arrêt constaté : ${arrete}`);
    mesures.g9HommeMort = { dernierBattement: dernier, arreteA: finOpencode, delaiS: Number(delaiS.toFixed(2)), borneS: BORNE_S, respecte: arrete && delaiS <= BORNE_S };

    // --- 2. Aucun redémarrage sans battement -------------------------------------------------------------------------------
    // Le conteneur revient (restart: unless-stopped) ; ce qui ne doit pas revenir, c'est opencode.
    await ctx.attendre(25_000);
    const pendant = await etatDe(ctx);
    const relance = await opencodeTourne(ctx);
    const journal = await ctx.logs("opencode-omo", { lignes: 400 });
    ctx.ecrireSortie("g9-sans-battement.log", journal);
    ajouter("aucun redémarrage d'opencode sans battement", !relance, `phase ${pendant.phase}, opencode ${relance ? "relancé" : "arrêté"}`);
    ajouter("le superviseur attend un battement frais", pendant.phase === "attente" || pendant.phase === "arret" || pendant.phase === "verification", `phase ${pendant.phase}`);
    mesures.g9SansBattement = { phase: pendant.phase, opencodeRelance: relance };

    // --- Remise en marche : MB-2, durée d'une relance à neuf ---------------------------------------------------------------
    const depart = Date.now();
    await ctx.compose(["start", "banc-battement"], { delaiMs: 120_000 });
    const revenu = await ctx.jusqua(async () => (await etatDe(ctx)).phase === "opencode-lance", { delaiMs: 240_000, pasMs: 1000 });
    const dureeRelanceS = (Date.now() - depart) / 1000;
    ajouter("la salle repart dès que le battement revient", revenu, `${dureeRelanceS.toFixed(1)} s`);
    const apres = await etatDe(ctx);
    const demarrages = ctx.lignesSortie("precheck.jsonl");
    mesures.MB2 = {
      dureeRelanceS: Number(dureeRelanceS.toFixed(2)),
      startIdAvant: avant.startId ?? null,
      startIdApres: apres.startId ?? null,
      neuf: Boolean(avant.startId && apres.startId && avant.startId !== apres.startId),
      precheckParDemarrage: demarrages.length,
    };
    ajouter("la relance est bien « à neuf » (nouveau startId, nouveau precheck-ok)", mesures.MB2.neuf && demarrages.length >= 2, `${demarrages.length} precheck-ok, startId ${mesures.MB2.neuf ? "changé" : "inchangé"}`);

    return { points, mesures };
  },
};
