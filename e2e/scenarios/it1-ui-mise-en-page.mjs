// Scénario e2e de l'interface de l'itération 1 (correction de la répétition générale) : la mise en page du chat pendant une
// délégation en mode Avancé, mesurée dans le navigateur par elementFromPoint aux quatre tailles (1440 × 900, 1280 × 800,
// 1024 × 768, 400 × 860), panneau « Contexte » dans son état par défaut.
//
// Constat de la répétition générale (rg-reel-9-ui-mesure, opencode réel hors ligne) : carte des agents, « Qui travaille ? » et carte
// de la demande poussaient le fil à 0 px ; « Autoriser une fois » et « Arrêter » sortaient de la fenêtre, sous une zone principale
// (.main) qui ne défile pas ; [Répondre] la faisait défiler et la laissait décalée ; « Arrêter » était recouvert par le panneau
// « Contexte » à 1280 et 400 px.
//
// Ce que le scénario établit (« --faux », mode Avancé : en Simple la délégation est refusée d'office, décision n° 4) :
//   1. demande de délégation en attente (posée quelques ms après la partie task, comme opencode réel), à chaque taille : fil et
//      région « Qui travaille ? » visibles, « Autoriser une fois », « Refuser… » et « Arrêter » dans la fenêtre et non recouverts,
//      zone principale ni défilée ni débordée, en-tête en vue ; panneau « Contexte » fermé de lui-même à 1280 px et au-dessous (il
//      s'y pose sur la conversation), ouvert à 1440. Clôture de l'itération 1 : la carte des agents reste dépliée pendant la demande
//      (défaut du mode Avancé, §5.1), « Qui travaille ? » aussi au-dessus de 400 px ; l'attente de votre accord (§5.7.1) et la
//      préparation en pointillé fixe (§5.7.3) sont visibles sans défiler là où la hauteur suffit (1440 × 900, 1280 × 800) ; là où
//      elle manque (1024 × 768 du banc : la saisie y prend 428 px), la région d'activité se borne et on les atteint en la faisant
//      défiler, elle seule ; à 400 px, pas de carte (liste seule, §5.6). [Répondre] est atteignable, au besoin en faisant défiler la
//      seule région d'activité ;
//   2. [Répondre] de « Qui travaille ? » : focus sur « Autoriser une fois », atteignable, zone principale toujours en place ;
//   3. « Autoriser une fois » cliqué, travail délégué en cours, à chaque taille : « Arrêter » atteignable, fil et « Qui travaille ? »
//      visibles, zone principale en place ; la carte des agents reste dépliée (défaut du mode Avancé) ;
//   4. « Arrêter » cliqué : plus aucune session de l'arbre occupée ; aucune violation de la CSP, console muette, P6 et P4 tenus.
// En « --reel-hors-ligne », le faux fournisseur ne délègue pas : le scénario le dit et ne joue rien.
import {
  attendre,
  attendreDemandes,
  attendreEtatActeur,
  attendreIa,
  attendreModeAffiche,
  attendreQue,
  avecTemoinP6,
  capturerConversation,
  cliquerBouton,
  delegation,
  demandeDeDelegation,
  enModeAvance,
  exiger,
  exigerAucuneViolationCsp,
  exigerSignesDeLaDemande,
  LARGE,
  nonJoue,
  oc,
  occupees,
  ouvrirConversation,
  PHRASES,
  preparerPage,
  releve,
  resume,
  signesPendantLaDemande,
} from "./it1-ui-commun.mjs";

const DESCRIPTION = "Relire les journaux de la nuit";
const REFUSER = "Refuser…";
/**
 * `signes` pendant la demande : « visibles » sans défiler ; « par-defilement » (la hauteur manque dans les conditions du banc : la
 * région d'activité, bornée, les montre quand on la fait défiler, elle seule ; visibles directement, c'est mieux encore) ;
 * « sans-carte » à 400 px (liste seule, §5.6).
 */
const TAILLES = [
  { nom: "1440", largeur: 1440, hauteur: 900, signes: "visibles" },
  { nom: "1280", largeur: 1280, hauteur: 800, signes: "visibles" },
  { nom: "1024", largeur: 1024, hauteur: 768, signes: "par-defilement" },
  { nom: "400", largeur: 400, hauteur: 860, signes: "sans-carte" },
];
/** Demande posée quelques ms après la partie task, comme opencode 1.18.30 réel (askAfterMs du faux, rg-reel-7). */
const DEMANDE_APRES_MS = 5;
/** Hauteur visible minimale du fil (chat.css : min(64px, 8vh) pendant une demande, min(96px, 12vh) sinon). */
const FIL_MIN = 40;
/** Hauteur visible minimale de la région « Qui travaille ? » (au moins sa ligne de tête). */
const ACTIVITE_MIN = 30;

/** Mesure dans la page : fil visible, boutons atteignables (centre dans la fenêtre et elementFromPoint), zone principale, panneau. */
const MESURE = (boutons) => `(() => {
  const vh = window.innerHeight, vw = window.innerWidth;
  const visible = (sel) => { const e = document.querySelector(sel); if (!e) return 0; const r = e.getBoundingClientRect(); return Math.max(0, Math.round(Math.min(r.bottom, vh) - Math.max(r.top, 0))); };
  const bouton = (texte, portee) => {
    const racine = document.querySelector(portee); if (!racine) return "absent";
    const b = [...racine.querySelectorAll("button")].find((x) => x.textContent.replace(/\\s+/g, " ").trim() === texte && x.getClientRects().length > 0);
    if (!b) return "absent";
    const r = b.getBoundingClientRect();
    const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
    if (cy < 0 || cy > vh || cx < 0 || cx > vw) return "hors-fenetre(y=" + Math.round(cy) + ")";
    const dessus = document.elementFromPoint(cx, cy);
    return dessus && (dessus === b || b.contains(dessus)) ? "atteignable" : "recouvert(par " + String(dessus?.className ?? "?").slice(0, 40) + ")";
  };
  const main = document.querySelector(".main");
  const entete = document.querySelector(".chat-header")?.getBoundingClientRect();
  return {
    fenetre: vw + "x" + vh,
    fil: visible(".chat-scroll"),
    activite: visible(".activity-region"),
    demandes: visible(".interactions"),
    boutons: Object.fromEntries(${JSON.stringify(boutons)}.map(([t, p]) => [t, bouton(t, p)])),
    repondre: bouton("Répondre", ".activity-region"),
    // [Répondre] sous la carte des agents, dans la région bornée : défilée ELLE SEULE (molette au-dessus d'elle), mesuré, remise en place.
    repondreApresDefilement: (() => {
      const region = document.querySelector(".activity-region");
      const b = region ? [...region.querySelectorAll("button")].find((x) => x.textContent.replace(/\\s+/g, " ").trim() === "Répondre" && x.getClientRects().length > 0) : null;
      if (!b) return "absent";
      const avant = region.scrollTop;
      const rr = region.getBoundingClientRect(), rb = b.getBoundingClientRect();
      if (rb.top < rr.top || rb.bottom > rr.bottom) region.scrollTop += rb.top + rb.height / 2 - (rr.top + rr.height / 2);
      const etat = bouton("Répondre", ".activity-region");
      const main = document.querySelector(".main")?.scrollTop ?? null;
      region.scrollTop = avant;
      return main === 0 ? etat : etat + " (zone principale défilée)";
    })(),
    mainDefile: main ? Math.round(main.scrollTop) : null,
    mainDeborde: main ? main.scrollHeight - main.clientHeight : null,
    entete: entete ? Math.round(entete.top) : null,
    contexte: document.querySelector(".chat")?.classList.contains("aside-open") ?? null,
    carte: document.querySelector(".neon-band .neon-commands button[aria-expanded]")?.getAttribute("aria-expanded") ?? null,
  };
})()`;

/** Exige la mesure d'une taille : fil visible, boutons atteignables, zone principale en place, panneau selon la largeur. */
function exigerMesure(m, taille, boutons, etape) {
  const ou = `${etape}, ${taille.nom} (${resume(m, 600)})`;
  exiger(m.fil >= FIL_MIN, `${ou} : fil visible sur ${m.fil} px seulement.`);
  exiger(m.activite >= ACTIVITE_MIN, `${ou} : « Qui travaille ? » visible sur ${m.activite} px seulement.`);
  for (const [texte] of boutons) exiger(m.boutons[texte] === "atteignable", `${ou} : « ${texte} » ${m.boutons[texte]}.`);
  exiger(m.mainDefile === 0 && m.mainDeborde !== null && m.mainDeborde <= 1, `${ou} : zone principale défilée ou débordée.`);
  exiger(m.entete !== null && m.entete >= 0, `${ou} : en-tête de la conversation hors de la fenêtre.`);
  exiger(m.contexte === taille.largeur > 1280, `${ou} : panneau « Contexte » ${m.contexte ? "ouvert" : "fermé"}.`);
}

/**
 * Panneau « Contexte » selon la largeur : à 1280 px et au-dessous, il doit s'être fermé de lui-même (il s'y pose sur la conversation) ;
 * au large, il est ouvert, rouvert par son bouton après un passage sous 1280 px comme le ferait l'utilisateur (jamais rouvert d'office).
 */
async function panneauSelonLaTaille(page, taille) {
  const ouvert = "document.querySelector('.chat')?.classList.contains('aside-open') === true";
  if (taille.largeur <= 1280) {
    await page.attendreQue(`!(${ouvert})`, { libelle: `panneau « Contexte » fermé de lui-même à ${taille.nom}` });
    return;
  }
  if (!(await page.evaluer(ouvert))) await page.evaluer(`document.querySelector('.chat-header button[aria-label="Afficher le contexte"]')?.click()`);
  await page.attendreQue(ouvert, { libelle: `panneau « Contexte » ouvert à ${taille.nom}` });
}

export async function run(ctx) {
  const page = await preparerPage(ctx);
  if (ctx.mode !== "faux") {
    nonJoue(ctx, "mise en page pendant une délégation", "le faux fournisseur ne répond que du texte, il ne délègue pas");
    ctx.expectNoConsoleErrors();
    return;
  }
  await avecTemoinP6(ctx, async () => {
    await enModeAvance(ctx, async () => {
      await attendreModeAffiche(page, "avance");
      const ia = await attendreIa(ctx);
      const client = oc(ctx);
      const racine = await client.creerConversation("it1-ui-mise-en-page");
      await ctx.faux.scripter(racine.id, {
        tools: [{ ...delegation(DESCRIPTION, "general", { text: "Rien d'anormal.", workMs: 60_000 }), askAfterMs: DEMANDE_APRES_MS }],
        followUp: { text: "Relecture faite." },
      });
      await ouvrirConversation(ctx, racine.id);
      const envoi = await client.envoyer(racine.id, "Fais relire les journaux de la nuit par un autre assistant.", ia);
      exiger(envoi.code === 204, `envoi refusé (${envoi.code}) : ${resume(envoi.corps)}`);

      // 1. Demande en attente, aux quatre tailles.
      await attendreDemandes(client, demandeDeDelegation(racine.id, DESCRIPTION), { libelle: "délégation en attente" });
      await page.attendreQue("document.querySelector('.interactions .delegation-details dl')", { libelle: "carte « Détails de la délégation »" });
      await attendreEtatActeur(page, "general", "en attente de votre accord");
      const enAttente = [
        [PHRASES.autoriser, ".interactions"],
        [REFUSER, ".interactions"],
        [PHRASES.arreter, ".composer"],
      ];
      for (const taille of TAILLES) {
        await page.taille(taille);
        await panneauSelonLaTaille(page, taille);
        await attendre(700);
        const m = await page.evaluer(MESURE(enAttente));
        releve(ctx, `attente de votre accord, ${taille.nom} : ${JSON.stringify(m)}`);
        exigerMesure(m, taille, enAttente, "attente de votre accord");
        exiger(
          m.repondre === "atteignable" || m.repondreApresDefilement === "atteignable",
          `attente de votre accord, ${taille.nom} : [Répondre] de « Qui travaille ? » ${m.repondre}, ${m.repondreApresDefilement} en faisant défiler la région.`,
        );
        // Clôture de l'itération 1 : jamais de repli pour une demande en Avancé ; les signes de la carte selon la hauteur disponible.
        exiger(m.carte === "true", `attente de votre accord, ${taille.nom} : carte des agents repliée pendant la demande (${m.carte}).`);
        if (taille.signes === "sans-carte") continue;
        const s = await signesPendantLaDemande(page, racine.id, { defiler: taille.signes === "par-defilement" });
        releve(ctx, `attente de votre accord, ${taille.nom}, signes de la carte : ${JSON.stringify(s)}`);
        exigerSignesDeLaDemande(s, `attente de votre accord, ${taille.nom}`);
        if (taille.signes === "visibles") exiger(s.defilement === 0, `attente de votre accord, ${taille.nom} : signes vus après un défilement de ${s.defilement} px.`);
      }
      await capturerConversation(ctx, "attente-accord");
      await panneauSelonLaTaille(page, TAILLES[0]);

      // 2. [Répondre] : focus sur « Autoriser une fois », atteignable ; la zone principale ne bouge pas.
      await cliquerBouton(page, "Répondre", { portee: ".activity-region" });
      await page.attendreQue(`document.activeElement?.textContent.replace(/\\s+/g, " ").trim() === ${JSON.stringify(PHRASES.autoriser)}`, {
        libelle: "focus sur « Autoriser une fois » après [Répondre]",
      });
      const apresRepondre = await page.evaluer(MESURE([[PHRASES.autoriser, ".interactions"]]));
      releve(ctx, `après [Répondre], 1440 : ${JSON.stringify(apresRepondre)}`);
      exigerMesure(apresRepondre, TAILLES[0], [[PHRASES.autoriser, ".interactions"]], "après [Répondre]");

      // 3. « Autoriser une fois » : travail délégué en cours, aux quatre tailles.
      await cliquerBouton(page, PHRASES.autoriser, { portee: ".interactions" });
      const enfant = await attendreQue(
        async () => {
          const [premier] = (await client.enfants(racine.id)) ?? [];
          return premier && (await occupees(client, [racine.id, premier.id])).length === 2 ? premier : false;
        },
        { libelle: "racine et enfant occupés" },
      );
      await attendreEtatActeur(page, "general", "travaille");
      const pendant = [[PHRASES.arreter, ".composer"]];
      for (const taille of TAILLES) {
        await page.taille(taille);
        await panneauSelonLaTaille(page, taille);
        await attendre(700);
        const m = await page.evaluer(MESURE(pendant));
        releve(ctx, `travail délégué, ${taille.nom} : ${JSON.stringify(m)}`);
        exigerMesure(m, taille, pendant, "travail délégué");
        exiger(m.carte === "true", `travail délégué, ${taille.nom} : carte des agents repliée pendant le travail délégué (${m.carte}).`);
      }
      exiger((await occupees(client, [racine.id, enfant.id])).length === 2, "le travail délégué s'est terminé pendant les mesures.");

      // 4. « Arrêter » : l'arbre s'arrête.
      await page.taille(LARGE);
      await cliquerBouton(page, PHRASES.arreter, { portee: ".composer" });
      await attendreQue(async () => (await occupees(client, [racine.id, enfant.id])).length === 0, { libelle: "arbre au repos après « Arrêter »" });
      await exigerAucuneViolationCsp(page);
    });
  });
  ctx.expectNoConsoleErrors();
}
