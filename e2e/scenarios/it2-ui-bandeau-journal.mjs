// Scénario e2e de l'interface de l'itération 2 (paquet L13) : bandeau d'autonomie, Journal du contrôle, carte en attente, et
// [Voir les modifications de cette demande] en fin de demande. Captures des vues de L12 (1440, 1024, 400 px, clair et sombre).
//
// Spécification §4.12 (bandeau « Autonome avec contrôle · … · … · x $ sur y $ » [Arrêter] [Journal] ; Journal du contrôle :
// Heure · Qui · Action · Décision · Par · Règle · Raison · Coût), §4.4 fin ([Voir les modifications de cette demande]), §4.13
// (carte d'attente), §5.4 (états vides), §5.5, §5.6 (400 px) ; plan d'exécution, fiche L13 (captures de L12).
//
// Ce que le scénario établit, sur une conversation en « Autonome avec contrôle » :
//   1. un tour qui fait deux actions automatiques et laisse une attente affiche le bandeau, avec les compteurs, la dépense et le
//      plafond, [Arrêter] et [Journal] — et PAS [Voir les modifications de cette demande], qui n'est pas de saison ;
//   2. [Journal] ouvre le Déroulé sur le Journal du contrôle : une ligne par décision, l'action masquée telle que le serveur
//      l'a bornée, « Autorisé automatiquement » pour les deux automatiques et « En attente de votre accord » pour l'attente ;
//   3. six captures de cette vue (1440, 1024 et 400, clair et sombre) ;
//   4. la demande close, le bandeau passe en fin de demande : plus d'[Arrêter], la phrase « Demande terminée. », et
//      [Voir les modifications de cette demande] qui ouvre la fenêtre des modifications ;
//   5. six captures de cette vue ; aucune violation de la CSP, console muette.
import {
  activerAutonome,
  atelier,
  attendre,
  attendreBandeau,
  attendreDecisions,
  attendreDemandes,
  attendreIa,
  attendreQue,
  avecTemoinP6,
  bandeau,
  capturerConversation,
  cliquerBouton,
  commande,
  decisionAttente,
  decisionAuto,
  DOSSIER_ATELIER,
  ecriture,
  envoyerEtJouer,
  exiger,
  exigerAucuneViolationCsp,
  LIBELLES,
  lignesDuJournal,
  nonJoue,
  oc,
  ouvrirConversation,
  preparerPage,
  putAutonomie,
  releve,
  resume,
} from "./it2-ui-commun.mjs";

const FICHIER_AUTO = "bilan.md";
const FICHIER_PROTEGE = ".github/workflows/bandeau.yml";
const CONSULTATION = "ls -la src";

export async function run(ctx) {
  atelier(ctx);
  const page = await preparerPage(ctx);
  if (ctx.mode !== "faux") {
    nonJoue(ctx, "bandeau, Journal et fin de demande", "aucun tour ne se script hors du faux opencode");
    return;
  }
  // P6 sur tout le scénario : il agit (envois, réponses d'autorisation), donc le témoin complet, flux d'événements compris.
  await avecTemoinP6(ctx, () => scenario(ctx, page));
}

async function scenario(ctx, page) {
  const client = oc(ctx, DOSSIER_ATELIER);
  const ia = await attendreIa(ctx);

  const racine = await client.creerConversation("it2-ui-bandeau-journal");
  const vue = await activerAutonome(ctx, racine.id);
  await ouvrirConversation(ctx, racine.id);

  // 1. Deux actions automatiques et une attente.
  await envoyerEtJouer(
    ctx,
    client,
    racine.id,
    {
      tools: [ecriture(DOSSIER_ATELIER, FICHIER_AUTO, "# Bilan\n\nÉcrit par l'atelier.\n"), commande(CONSULTATION), ecriture(DOSSIER_ATELIER, FICHIER_PROTEGE, "name: ci\n")],
      cost: 0.004,
    },
    { ia },
  );
  await attendreDecisions(ctx, racine.id, decisionAuto("A-edit"), { libelle: "modification automatique" });
  await attendreDecisions(ctx, racine.id, decisionAuto("A-ls"), { libelle: "consultation automatique" });
  await attendreDecisions(ctx, racine.id, decisionAttente("E2"), { libelle: "attente sur le fichier protégé" });

  const enCours = await attendreBandeau(page, (b) => b.terminee === "non" && /2 automatiques/.test(b.resume) && /1 en attente/.test(b.resume), {
    libelle: "bandeau « 2 automatiques · 1 en attente »",
  });
  exiger(enCours.resume.startsWith(LIBELLES.autonome), `bandeau : « ${resume(enCours.resume)} » ne commence pas par le choix.`);
  exiger(enCours.resume.includes(`sur ${montantFr(vue.plafonds.plafondUsd)}`), `bandeau sans le plafond d'arrêt : « ${resume(enCours.resume)} »`);
  exiger(enCours.arreter && enCours.journal, `bandeau sans [Arrêter] ou [Journal] : ${resume(enCours)}`);
  exiger(!enCours.modifications, "[Voir les modifications de cette demande] visible alors que la demande travaille encore.");

  // 2. [Journal] : le Déroulé montre le Journal du contrôle.
  await cliquerBouton(page, LIBELLES.journal, { portee: ".autonomy-banner" });
  await page.attendreQue("document.querySelector('.deroule-journal .journal-table tbody tr')", { delaiMs: 20_000, libelle: "Journal du contrôle affiché" });
  const lignes = await attendreQue(
    async () => {
      const lues = (await lignesDuJournal(page)) ?? [];
      return lues.length >= 3 ? lues : false;
    },
    { libelle: "trois lignes dans le Journal du contrôle" },
  );
  const decisions = lignes.map((l) => l.decision);
  exiger(decisions.filter((d) => d.includes("Autorisé automatiquement")).length >= 2, `décisions du Journal : ${resume(decisions)}`);
  exiger(decisions.some((d) => d.includes("En attente de votre accord")), `aucune attente dans le Journal : ${resume(decisions)}`);
  exiger(lignes.some((l) => l.action === CONSULTATION), `l'action de la consultation n'est pas dans le Journal : ${resume(lignes.map((l) => l.action))}`);
  exiger(
    lignes.some((l) => l.raison === "Consultation dans le dossier de la conversation"),
    `raison de la consultation absente : ${resume(lignes.map((l) => l.raison))}`,
  );
  exiger(lignes.every((l) => l.action.length <= 120), `action non bornée à 120 caractères : ${resume(lignes.map((l) => l.action.length))}`);

  // 3. Captures de la vue de L12 : bandeau, carte d'attente et Journal, aux trois largeurs et dans les deux thèmes.
  const captures = await capturerConversation(ctx, "bandeau-journal");
  exiger(captures.length === 6, `${captures.length} capture(s) du bandeau et du Journal au lieu de six.`);

  // 4. Fin de demande : l'utilisateur refuse l'attente, resserre son choix, puis renvoie — la demande se clôt « terminée ».
  const attentes = await attendreDemandes(client, (d) => d.sessionID === racine.id && d.permission === "edit", { libelle: "attente sur le fichier protégé" });
  await client.repondre(attentes[0].id, "reject");
  await attendreQue(async () => ((await client.demandes()) ?? []).length === 0, { libelle: "plus aucune demande d'autorisation en attente" });
  const resserre = await putAutonomie(ctx, racine.id, { choix: "demander" });
  exiger(resserre.code === 200, `resserrement refusé : code ${resserre.code} (${resume(resserre.texte)}).`);
  await envoyerEtJouer(ctx, client, racine.id, { text: "Merci." }, { ia });

  const terminee = await attendreBandeau(page, (b) => b.terminee === "oui", { libelle: "bandeau en fin de demande" });
  exiger(terminee.fin === "Demande terminée.", `phrase de fin : « ${resume(terminee.fin)} ».`);
  exiger(!terminee.arreter, "[Arrêter] encore proposé après la fin de la demande.");
  exiger(terminee.modifications, "[Voir les modifications de cette demande] absent en fin de demande.");

  await cliquerBouton(page, LIBELLES.voirModifications, { portee: ".autonomy-banner" });
  await page.attendreQue(`[...document.querySelectorAll('[role="dialog"] .modal-header h2')].some((h) => h.textContent.trim() === ${JSON.stringify(LIBELLES.voirModifications)})`, {
    libelle: "fenêtre des modifications de la demande",
  });
  await attendre(300);

  // 5. Captures de la fin de demande, puis fermeture.
  const finales = await ctx.screenshot("fin-de-demande");
  exiger(finales.length === 6, `${finales.length} capture(s) de la fin de demande au lieu de six.`);
  await page.touche("Escape");
  await page.attendreQue(`!document.querySelector('[role="dialog"]')`, { libelle: "fenêtre des modifications fermée" });

  await exigerAucuneViolationCsp(page);
  ctx.expectNoConsoleErrors();
  releve(
    ctx,
    `bandeau « ${resume(enCours.resume, 120)} » ; Journal du contrôle à ${lignes.length} lignes ; fin de demande avec ` +
      "[Voir les modifications de cette demande] ; 12 captures (deux vues × 1440, 1024, 400 × clair, sombre)",
  );
}

/** Montant tel que le bandeau l'écrit (autonomy-texts.ts : « {valeur} $ », virgule décimale française). */
function montantFr(valeur) {
  return `${valeur.toFixed(2).replace(".", ",")} $`;
}
