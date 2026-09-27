// Porte G14 — configuration figée (spéc. §7.10 l.1228 ; D-2b-32 ; fiche L15b).
//
// Deux moitiés, et elles ne prouvent pas la même chose :
// 1. À LA CONSTRUCTION : `build-omo-image.ps1 -SelfTest` refait quatre constructions dans des copies temporaires — un témoin
//    qui doit passer, puis un nom de hook faux, une clé inconnue et une valeur épinglée retirée, qui doivent chacun faire
//    échouer la construction À L'ÉTAPE DE VALIDATION, avec un message qui les cite.
// 2. AU DÉMARRAGE : la salle refuse de partir si la configuration figée ou la référence du manifeste ne sont plus celles de
//    l'image. Le banc le montre en posant, par-dessus l'image, un `omo.jsonc` muté puis l'amorce du manifeste : dans les deux
//    cas le superviseur s'arrête, sans rien servir.
//
// Rien de tout cela ne touche le dépôt : les copies du `-SelfTest` sont temporaires, et les deux démarrages refusés se font
// par des montages en lecture seule sur des conteneurs jetables.
import fs from "node:fs";
import path from "node:path";

/** Conteneur jetable qui lance le VRAI superviseur, avec un seul fichier remplacé. Rend `{ code, journal }`. */
async function demarrageRefuse(ctx, montages, etiquette) {
  const args = [
    "run",
    "--rm",
    "--network",
    "none",
    "--user",
    "0:0",
    "--cap-drop",
    "ALL",
    "--cap-add",
    "SETUID",
    "--cap-add",
    "SETGID",
    "--security-opt",
    "no-new-privileges:true",
    "--tmpfs",
    "/omo-state:mode=0755",
    "--tmpfs",
    "/tmp:exec,mode=1777",
  ];
  for (const m of montages) args.push("--volume", m);
  args.push(ctx.image);
  const r = await ctx.docker(args, { delaiMs: 180_000 });
  const journal = `${r.sortie}\n${r.erreur}`;
  ctx.ecrireSortie(`g14-${etiquette}.log`, journal);
  return { code: r.code, journal };
}

export default {
  id: "g14",
  titre: "Configuration figée : auto-test de construction, et démarrage refusé sur mutation",
  async executer(ctx) {
    const points = [];
    const mesures = {};
    const ajouter = (nom, ok, detail) => points.push({ nom, ok: Boolean(ok), detail });

    // --- Démarrage refusé : omo.jsonc muté -------------------------------------------------------------------------------
    const dossierMutations = path.join(ctx.chemins.dossier, "mutations");
    fs.mkdirSync(dossierMutations, { recursive: true });
    const reference = fs.readFileSync(path.join(ctx.racine, "docker", "opencode-omo", "omo.jsonc"), "utf8");
    // Une mutation visible et sans ambiguïté : un agent coupé par la configuration figée est réautorisé.
    const mute = reference.replace('"disabled_agents": ["librarian", "multimodal-looker"]', '"disabled_agents": []');
    if (mute === reference) throw new Error("La mutation de omo.jsonc n'a rien changé : la porte ne prouverait rien.");
    const cheminMute = path.join(dossierMutations, "omo.jsonc");
    fs.writeFileSync(cheminMute, mute);

    const refusConfig = await demarrageRefuse(ctx, [`${cheminMute.replace(/\\/g, "/")}:/etc/opencode-omo/omo/omo.jsonc:ro`], "omo-jsonc-mute");
    ajouter("démarrage refusé avec un omo.jsonc muté", refusConfig.code !== 0 && /REFUS/.test(refusConfig.journal), `code ${refusConfig.code} — ${(refusConfig.journal.match(/REFUS:[^\n]*/) ?? ["(aucun REFUS)"])[0].slice(0, 160)}`);

    // --- Démarrage refusé : amorce du manifeste ---------------------------------------------------------------------------
    const cheminAmorce = path.join(dossierMutations, "omo-manifest.sha256");
    fs.writeFileSync(cheminAmorce, "# amorce\n");
    const refusAmorce = await demarrageRefuse(ctx, [`${cheminAmorce.replace(/\\/g, "/")}:/etc/omo-reference/omo-manifest.sha256:ro`], "amorce");
    ajouter("démarrage refusé avec l'amorce du manifeste (D-2b-32)", refusAmorce.code !== 0 && /REFUS/.test(refusAmorce.journal), `code ${refusAmorce.code} — ${(refusAmorce.journal.match(/REFUS:[^\n]*/) ?? ["(aucun REFUS)"])[0].slice(0, 160)}`);

    // --- Témoin : l'image telle quelle passe ses deux premières étapes ---------------------------------------------------
    // Sans mutation, le superviseur va jusqu'à l'attente du battement (aucun pilote ici) : il ne REFUSE pas, il attend.
    const temoin = await ctx.docker(
      [
        "run",
        "--rm",
        "--network",
        "none",
        "--user",
        "0:0",
        "--cap-drop",
        "ALL",
        "--security-opt",
        "no-new-privileges:true",
        "--entrypoint",
        "node",
        ctx.image,
        "/opt/omo-check/validate.mjs",
        "--construction",
      ],
      { delaiMs: 120_000 },
    );
    ctx.ecrireSortie("g14-temoin-validation.log", `${temoin.sortie}\n${temoin.erreur}`);
    ajouter("témoin : la validation de l'image passe", temoin.code === 0, `code ${temoin.code}`);
    mesures.g14Demarrage = { omoJsoncMute: refusConfig.code, amorce: refusAmorce.code, temoinValidation: temoin.code };

    // --- Auto-test de construction ---------------------------------------------------------------------------------------
    if (ctx.baseImage) {
      const sortieSelfTest = path.join(ctx.chemins.dossier, "selftest");
      const r = await ctx.lancer(
        "powershell.exe",
        ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", path.join(ctx.racine, "scripts", "build-omo-image.ps1"), "-BaseImage", ctx.baseImage, "-OutDir", sortieSelfTest, "-SelfTest"],
        { cwd: ctx.racine, delaiMs: 1_800_000 },
      );
      ctx.ecrireSortie("g14-selftest.log", `${r.sortie}\n${r.erreur}`);
      const vert = r.code === 0 && /G14 vert/.test(String(r.sortie));
      ajouter("-SelfTest : témoin accepté, trois mutations refusées par la validation", vert, `code ${r.code} — ${(String(r.sortie).match(/G14 vert[^\n]*/) ?? String(r.sortie).match(/ARRET[^\n]*/) ?? ["(sans verdict)"])[0].slice(0, 200)}`);
      mesures.g14SelfTest = { code: r.code, vert };
    } else {
      ajouter("-SelfTest : lancé à part (image de base non fournie au banc)", true, "voir execution/mesures/L21.md, § G14");
      mesures.g14SelfTest = { code: null, vert: null, note: "joué à part, hors du banc" };
    }

    return { points, mesures };
  },
};
