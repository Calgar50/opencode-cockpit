// Porte « sup » — une entrée de premier niveau SUPPRIMÉE sur le poste après install.ps1 n'est jamais recréée par Docker quand la
// salle redémarre (relecture 2ter-vague-3, constats « justesse » et « sécurité » sur install.ps1).
//
// Le défaut mesuré : chaque exception de la surcharge est un bind vers une entrée de premier niveau d'un projet. Supprimée ensuite
// sur le poste (`git clean -fdx`, `npm run clean`, changement de branche), elle était RECRÉÉE par Docker en dossier vide à chaque
// relance du conteneur — un fichier devenait un dossier, et l'outil qui l'écrit échouait en EISDIR. `restart: unless-stopped` la
// relançait seul, à la fin de chaque demande. La correction : la surcharge écrit ses exceptions en syntaxe longue avec
// `bind.create_host_path: false` (une relance échoue alors franchement, sans rien créer : mesuré), et cockpit.ps1 ne passe plus
// le profil de la salle à la création des conteneurs tant qu'une source manque (joué par les tests PowerShell, faux docker).
//
// Cette porte joue, sur le produit tel quel, le chemin que cockpit.ps1 ne voit pas : la relance par la POLITIQUE `restart`
// (fin du battement, le superviseur sort, Docker relance seul), puis `docker compose restart`. Elle vérifie CÔTÉ POSTE que rien
// n'a été recréé, et que la salle ne repart pas. Elle tourne en dernier : elle laisse la salle arrêtée.
//
// Ce qu'elle écrit : rien. Elle SUPPRIME un fichier et un dossier de premier niveau du projet jetable du banc (jamais `.git`).
import fs from "node:fs";
import path from "node:path";
import { PROJET_ECRIT } from "./git-protection.mjs";

/** Forme d'un chemin du poste, sans suivre de lien. */
function forme(chemin) {
  try {
    const info = fs.lstatSync(chemin);
    if (info.isSymbolicLink()) return "lien";
    if (info.isDirectory()) return "dossier";
    return info.isFile() ? "fichier" : "autre";
  } catch {
    return "absent";
  }
}

/** État du conteneur de la salle, lu par `docker inspect` (jamais son environnement). */
async function etatConteneur(ctx) {
  const r = await ctx.docker(["inspect", "--format", "{{.State.Status}}|{{.RestartCount}}|{{.State.Error}}", `${ctx.projet}-opencode-omo-1`], { silencieux: true });
  const [statut = "", relances = "", ...erreur] = String(r.sortie ?? "").trim().split("|");
  return { code: r.code, statut, relances: Number(relances) || 0, erreur: erreur.join("|") };
}

/** Lignes de la surcharge d'install.ps1 qui ouvrent `relatif` en écriture. */
function lignesDe(surcharge, relatif) {
  return surcharge.split(/\r?\n/).filter((ligne) => ligne.includes(`target: "/workspace/${relatif}"`));
}

export default {
  id: "sup",
  titre: "Entrée de premier niveau supprimée après install.ps1 : jamais recréée sur le poste, la salle ne repart pas",
  async executer(ctx) {
    const points = [];
    const mesures = {};
    const ajouter = (nom, ok, detail) => points.push({ nom, ok: Boolean(ok), detail });

    const ws = ctx.chemins?.ws ?? null;
    const projet = ws === null ? null : path.join(ws, PROJET_ECRIT);
    if (projet === null || forme(projet) !== "dossier") {
      ajouter("le projet jetable du banc est connu côté poste", false, `ctx.chemins.ws : ${String(ws)}`);
      return { points, mesures };
    }
    const entrees = fs.readdirSync(projet, { withFileTypes: true }).filter((e) => !/^\.git[. ]*$/i.test(e.name) && e.name.toLowerCase() !== ".omo" && !e.isSymbolicLink());
    const fichier = entrees.find((e) => e.isFile())?.name ?? null;
    const dossier = entrees.find((e) => e.isDirectory())?.name ?? null;
    if (fichier === null || dossier === null) {
      ajouter("le projet jetable a un fichier et un dossier de premier niveau", false, entrees.map((e) => e.name).join(", "));
      return { points, mesures };
    }
    const hoteFichier = path.join(projet, fichier);
    const hoteDossier = path.join(projet, dossier);

    // --- 1. La surcharge est celle de la correction : syntaxe longue, create_host_path: false, forme relevée ------------------
    const surcharge = ctx.surcharge?.() ?? "";
    for (const [relatif, attendue] of [
      [`${PROJET_ECRIT}/${fichier}`, "fichier"],
      [`${PROJET_ECRIT}/${dossier}`, "dossier"],
    ]) {
      const lignes = lignesDe(surcharge, relatif);
      ajouter(
        `surcharge : ${relatif} ouvert par UN bind en syntaxe longue, create_host_path: false, forme « ${attendue} »`,
        lignes.length === 1 && lignes[0].includes("bind: { create_host_path: false }") && lignes[0].trimEnd().endsWith(`# ${attendue}`),
        lignes.join(" | ").slice(0, 400) || "(aucune ligne)",
      );
    }

    // --- 2. L'utilisateur supprime une entrée fichier et une entrée dossier, la salle tournant ----------------------------------
    const avant = await etatConteneur(ctx);
    mesures.supAvant = avant;
    fs.rmSync(hoteFichier, { force: true });
    fs.rmSync(hoteDossier, { recursive: true, force: true });
    ajouter("suppression faite côté poste", forme(hoteFichier) === "absent" && forme(hoteDossier) === "absent", `${fichier} : ${forme(hoteFichier)} ; ${dossier} : ${forme(hoteDossier)}`);

    // --- 3. Relance par la POLITIQUE restart : le battement s'arrête, le superviseur sort, Docker relance seul -----------------
    await ctx.compose(["stop", "--timeout", "5", "banc-battement"], { delaiMs: 90_000 });
    const tentee = await ctx.jusqua(
      async () => {
        const e = await etatConteneur(ctx);
        return e.relances > avant.relances || e.erreur !== "";
      },
      { delaiMs: 150_000, pasMs: 1000 },
    );
    // Laisse à Docker le temps de retenter, s'il le fait.
    await ctx.attendre(15_000);
    const apresPolitique = await etatConteneur(ctx);
    mesures.supPolitique = apresPolitique;
    ajouter("la relance par la politique restart a bien été tentée", tentee, JSON.stringify(apresPolitique).slice(0, 300));
    ajouter(
      "cette relance ÉCHOUE franchement sur la source absente (create_host_path: false) : la salle ne repart pas",
      apresPolitique.statut !== "running" && /no such file or directory/i.test(apresPolitique.erreur),
      `${apresPolitique.statut} — ${apresPolitique.erreur.slice(0, 300)}`,
    );
    ajouter("côté poste, après la relance par la politique : le fichier supprimé n'est pas recréé (ni fichier, ni dossier)", forme(hoteFichier) === "absent", forme(hoteFichier));
    ajouter("côté poste, après la relance par la politique : le dossier supprimé n'est pas recréé", forme(hoteDossier) === "absent", forme(hoteDossier));

    // --- 4. `docker compose restart` à la main : même refus, rien de créé ---------------------------------------------------------
    const redemarrage = await ctx.compose(["restart", "opencode-omo"], { delaiMs: 120_000, silencieux: true });
    const apresRestart = await etatConteneur(ctx);
    mesures.supRestart = { code: redemarrage.code, ...apresRestart };
    ajouter(
      "docker compose restart est refusé sur la source absente, sans rien créer",
      redemarrage.code !== 0 && apresRestart.statut !== "running" && forme(hoteFichier) === "absent" && forme(hoteDossier) === "absent",
      `code ${redemarrage.code} ; ${apresRestart.statut} ; ${fichier} : ${forme(hoteFichier)} ; ${dossier} : ${forme(hoteDossier)} ; ${String(redemarrage.erreur ?? "").slice(-300)}`,
    );

    // --- 5. Le battement revient : la salle ne repart toujours pas, et rien n'apparaît sur le poste ------------------------------
    await ctx.compose(["start", "banc-battement"], { delaiMs: 120_000 });
    await ctx.attendre(20_000);
    const fin = await etatConteneur(ctx);
    mesures.supFin = fin;
    ajouter(
      "battement revenu : la salle reste arrêtée tant qu'install.ps1 n'a pas été relancé, et le poste est intact",
      fin.statut !== "running" && forme(hoteFichier) === "absent" && forme(hoteDossier) === "absent",
      `${fin.statut} ; ${fichier} : ${forme(hoteFichier)} ; ${dossier} : ${forme(hoteDossier)}`,
    );
    ctx.ecrireSortie("sup-etats.json", `${JSON.stringify(mesures, null, 2)}\n`);
    return { points, mesures };
  },
};
