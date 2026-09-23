// Scénario e2e de l'itération 5 (paquet L50b) : la forme RELECTURE de bout en bout, sur l'exemple « Compte rendu d'incident
// relu » (spécification §5.3, §6 ; conception C §17.3 n° 3 ; plan d'exécution it5, fiches L42a à L42c, D-5-14).
//
// Ce que le scénario établit, dans la vraie pile, sur le faux opencode :
//   1. le premier jet est rendu, puis l'équipe S'ARRÊTE d'elle-même (`pauseAvantRelecture`) : rien n'est envoyé au relecteur
//      tant que vous n'avez pas continué ;
//   2. le verdict est lu sur la DERNIÈRE ligne du relecteur, à l'octet, accents compris (D-5-14, MC5-2) : « À REPRENDRE » au
//      tour 1 fait repartir le rédacteur, et le relecteur relit une seconde fois ;
//   3. le PLAFOND de tours est respecté : `toursMax` vaut 2, le relecteur ne travaille pas trois fois, et le livrable porte
//      la note d'honnêteté « Relecture non conclue après 2 tours : points restants ci-dessous. » quand le second verdict
//      reste « à reprendre » ;
//   4. le JOURNAL de relecture est REPLIÉ sous le résultat (C §9.6), avec ses deux tours et leurs verdicts ; le livrable
//      n'est pas réécrit, il est découpé ;
//   5. le COÛT du lancement est la somme des CINQ appels scriptés (trois jets, deux relectures), il reste sous le PLAFOND
//      d'arrêt du lancement, et la carte l'écrit ;
//   6. les tours suivants REPRENNENT les sessions du tour 1 (D-5-14, MC5-2) : exactement DEUX `POST /session` pour le bloc
//      (rédaction, relecture), et les cinq envois partent dans ces deux sessions-là.
// En « --reel-hors-ligne », les étapes ne sont pas scriptables (le faux fournisseur ne rend que du texte) : le scénario le
// dit et ne joue rien, comme les scénarios d'équipe de l'itération 4.
import { attendre, attendreQue, exiger, nonJoue, releve, resume } from "./it1-api-commun.mjs";
import { attendreIa, preparerPage } from "./it1-ui-commun.mjs";
import { attendreRun, declarerAssistants, enAvance, equipes, ouvrirLaConversation, repere, requetesDepuis, scripterEtape } from "./it4-commun.mjs";

/** Exemple éprouvé ici, tel quel (comme it4-pause éprouve « relecture-script ») : ses identifiants d'étape sont les siens. */
const EXEMPLE = "postmortem";
const REDACTION = "redaction";
const RELECTURE = "relecture";

/** Demande écrite par l'utilisateur : reconnaissable dans le message du rédacteur. */
const DEMANDE = "Rédige le compte rendu de la coupure de paiement du 12 septembre.";

/**
 * Verdicts, écrits en clair : c'est la spécification qu'on éprouve, pas ce que le code déclare. La ligne est lue SEULE, en
 * dernier, et les accents comptent (flow.ts, `readVerdict`).
 */
const A_REPRENDRE = "VERDICT: À REPRENDRE";
const RIEN_A_REPRENDRE = "VERDICT: RIEN À REPRENDRE";

/** Phrases attendues (construction-texts.ts `partout.execution.relecture`), écrites en clair. */
const PHRASES = {
  journal: "Journal de relecture",
  tour1: "tour 1",
  tour2: "tour 2",
  aReprendre: "À reprendre",
  rienAReprendre: "Rien à reprendre",
  nonConclue: "Relecture non conclue après 2 tours : points restants ci-dessous.",
  nonRelue: "Non relue après la dernière correction.",
};

/**
 * Les CINQ appels du lancement : trois jets du rédacteur, deux relectures. Le compte n'est pas symétrique, et c'est la
 * définition d'un tour (team-types.ts, `StepRunView.tour` : 1 à `toursMax + 1` pour une relecture) : chaque relecture « à
 * reprendre » rend la main au rédacteur, y compris la DERNIÈRE — sa correction part donc sans être relue, et le cockpit le
 * dit. Le relecteur, lui, ne travaille jamais plus de `toursMax` fois : c'est le plafond. Les coûts sont distincts, donc
 * identifiables un par un dans le total.
 */
const JET_1 = {
  text: "# Compte rendu\n\nImpact : 42 minutes sans paiement.\nCause : un certificat périmé sur la passerelle.",
  cost: 0.02,
  tokens: { input: 900, output: 260, cache: { read: 0, write: 0 } },
  stepMs: 5,
};
const JET_2 = {
  text: "# Compte rendu (corrigé)\n\nImpact : 42 minutes, 1 380 paiements refusés (source : journal de la passerelle).\nCause : un certificat périmé, renouvellement non surveillé.",
  cost: 0.03,
  tokens: { input: 1500, output: 320, cache: { read: 0, write: 0 } },
  stepMs: 5,
};
const RELECTURE_1 = {
  text: `Défauts situés :\n- l'impact n'est pas chiffré ;\n- aucune source n'est citée pour la cause.\n\n${A_REPRENDRE}`,
  cost: 0.01,
  tokens: { input: 1200, output: 90, cache: { read: 0, write: 0 } },
  stepMs: 5,
};
/** Troisième jet : la correction qui suit la dernière relecture. Elle n'est plus relue — le plafond est atteint. */
const JET_3 = {
  text: "# Compte rendu (v3)\n\nImpact : 42 minutes, 1 380 paiements refusés (source : journal de la passerelle).\nActions : surveiller l'échéance des certificats (exploitation, 30/09, alerte à J-30).",
  cost: 0.012,
  tokens: { input: 1800, output: 200, cache: { read: 0, write: 0 } },
  stepMs: 5,
};

/** Second verdict encore « à reprendre » : c'est le cas qui met le PLAFOND à l'épreuve (le relecteur ne relit pas trois fois). */
const RELECTURE_2 = {
  text: `Reste à faire :\n- aucune action n'a d'échéance.\n\n${A_REPRENDRE}`,
  cost: 0.015,
  tokens: { input: 1700, output: 70, cache: { read: 0, write: 0 } },
  stepMs: 5,
};

const COUT_ATTENDU = JET_1.cost + JET_2.cost + JET_3.cost + RELECTURE_1.cost + RELECTURE_2.cost;

/** Envois facturables reçus par le faux, hors requêtes de fond. */
const envois = (requetes) => requetes.filter((requete) => requete.method === "POST" && requete.pathname.endsWith("/prompt_async"));

/**
 * Assistants d'un déroulé de la 5b, déclarés au faux opencode.
 *
 * `declarerAssistants` (it4) ne connaît que les blocs `etape`, `avis` et `pause` : un bloc `relecture` ou `aiguillage` ne lui
 * montre aucune étape, et le pré-lancement refuserait l'équipe en « assistant-absent ». On lui passe donc un déroulé de la
 * forme qu'elle connaît — UNE étape par assistant distinct —, qui ne sert qu'à nommer les assistants et à interroger l'aperçu
 * du serveur ; le déroulé réel, lui, n'est jamais modifié. Recopié dans les scénarios `c5b-*` qui lancent une équipe : chaque
 * scénario reste lisible seul, et la fiche du paquet fixe la liste des fichiers (aucun `c5b-commun.mjs`).
 */
export function assistantsDuDeroule(flow) {
  const etapes = flow.blocs.flatMap((bloc) => {
    if (bloc.type === "etape") return [bloc.etape];
    if (bloc.type === "avis") return [...bloc.avis, bloc.synthese];
    if (bloc.type === "relecture") return [bloc.auteur, bloc.relecteur];
    if (bloc.type === "aiguillage") return [bloc.aiguilleur, ...bloc.specialistes, ...(bloc.synthese === null ? [] : [bloc.synthese])];
    return [];
  });
  return [...new Set(etapes.map((etape) => etape.assistant))];
}

/** Déclare au faux les assistants d'un déroulé de la 5b (blocs `relecture` et `aiguillage` compris). */
export async function declarerLesAssistants(api, flow) {
  return await declarerNoms(api, assistantsDuDeroule(flow));
}

/**
 * Règles d'un assistant d'équipe EN LECTURE SEULE, telles qu'opencode les rend à `GET /agent` pour le fichier que le cockpit
 * écrit (catalogue ou Studio : lire, chercher, lister ; rien d'autre). Même forme que `REGLES_LECTURE_SEULE` d'it4-commun.mjs.
 */
const REGLES_LECTURE_SEULE = [
  { permission: "*", pattern: "*", action: "deny" },
  { permission: "read", pattern: "*", action: "allow" },
  { permission: "grep", pattern: "*", action: "allow" },
  { permission: "glob", pattern: "*", action: "allow" },
];

/** Un agent servi par le faux avec ces règles-là : tout refusé d'abord, puis seulement la lecture. */
const enLectureSeule = (agent) =>
  Array.isArray(agent?.permission) &&
  agent.permission.some((regle) => regle.permission === "*" && regle.pattern === "*" && regle.action === "deny") &&
  agent.permission.every((regle) => regle.action === "deny" || ["read", "grep", "glob", "list"].includes(regle.permission));

/**
 * Même chemin, à partir d'une simple liste de noms. Trois vérités, et il faut les TROIS (mesuré au banc, 22 et 23/09) :
 *   1. le COCKPIT doit connaître l'assistant — sans quoi l'estimation le dit « absent » alors que `PUT /api/teams/:id` vient
 *      de l'accepter. Le fichier d'agent est écrit par le Studio, en lecture seule, comme l'utilisateur le ferait ;
 *      l'installation depuis le catalogue, elle, demande le catalogue d'IA, que la pile du banc n'a pas toujours ;
 *   2. le FAUX opencode doit le servir à `GET /agent` : il ne lit aucun fichier ;
 *   3. et il doit le servir avec les RÈGLES DE SON FICHIER, en lecture seule. Un scénario précédent peut avoir déclaré le même
 *      agent autrement : `c5a-seconde-lecture` sert le « Relecteur critique » par `banc:agents`, SANS AUCUNE RÈGLE (ce qui,
 *      pour opencode, veut dire « tout permis ») — ce qui suffit à une seconde lecture, mais pas à une étape d'équipe, que la
 *      grammaire refuse alors en « delegue » et « internet » (mesuré : passe `--scenarios c5` du 23/09). Le vrai opencode lit le
 *      fichier installé, en lecture seule : le faux est remis d'accord avec lui, les autres agents servis restent tels quels.
 * Même chemin que `ecrireAssistantsParLeStudio` de l'itération 4, qui tient la part « --reel-hors-ligne ».
 */
export async function declarerNoms(api, noms) {
  const ctx = api.ctx;
  const ia = await attendreIa(ctx);
  const connus = new Set((((await ctx.api.get("/api/assistants"))?.assistants) ?? []).map((assistant) => assistant.name));
  for (const nom of noms.filter((candidat) => !connus.has(candidat))) {
    const reponse = await ctx.api.brut("PUT", `/api/studio/agents/${encodeURIComponent(nom)}`, {
      frontmatter: {
        description: `Assistant d'équipe en lecture seule, écrit par le banc e2e pour l'étape « ${nom} ».`,
        mode: "all",
        model: `${ia.providerID}/${ia.modelID}`,
        steps: 20,
        permission: { "*": "deny", read: "allow", grep: "allow", glob: "allow" },
      },
      body: "Tu relis et tu rends un avis court. Tu ne modifies rien et tu ne lances aucune commande.\n",
    });
    exiger(reponse.code === 200, `écriture de l'assistant « ${nom} » par le Studio refusée (${reponse.code}) : ${resume(reponse.corps, 300)}`);
  }
  if (ctx.mode === "faux") {
    // 3. Les agents du déroulé déjà servis SANS leurs règles de lecture seule sont redits au faux ; les autres restent.
    const servis = await api.agents();
    const voulus = new Set(noms);
    const aRedire = servis.filter((agent) => voulus.has(agent.name) && !enLectureSeule(agent));
    if (aRedire.length > 0) {
      const redits = aRedire.map((agent) => ({
        ...agent,
        mode: agent.mode ?? "all",
        model: agent.model ?? { providerID: ia.providerID, modelID: ia.modelID },
        permission: REGLES_LECTURE_SEULE,
      }));
      await ctx.faux.scripter("agents:defaut", ...servis.filter((agent) => !aRedire.includes(agent)), ...redits);
      releve(ctx, `agents du déroulé remis en lecture seule au faux (fichier d'agent réel) : ${aRedire.map((agent) => agent.name).join(", ")}`);
    }
  }
  const projection = {
    version: 1,
    blocs: noms.map((assistant, rang) => ({
      type: "etape",
      id: `bd-${rang}`,
      etape: {
        id: `decl-${rang}`,
        titre: `Déclaration ${rang + 1}`,
        assistant,
        niveau: null,
        taille: "S",
        consigne: "Étape de déclaration du banc : elle n'est jamais lancée.",
        recoit: rang === 0 ? "demande" : "precedent",
      },
    })),
  };
  return await declarerAssistants(api, projection);
}

/** Codes de l'aperçu qui disent l'état des AGENTS servis (cache de 15 s de `GET /agent`), jamais celui du déroulé. */
const CODES_DES_AGENTS = new Set(["assistant-absent", "niveau-indisponible", "delegue", "internet", "autorise-sans-demander", "personnalise"]);

/**
 * Attend que le SERVEUR voie les agents tels que le faux les sert maintenant : le cockpit garde `GET /agent` en cache 15 s
 * (`LOOKUP_TTL_MS`), et un déroulé posé juste après une nouvelle déclaration serait jugé sur l'ancienne. L'aperçu de
 * l'éditeur (`POST /api/teams/preview`) dit exactement ce que le serveur voit, sans rien écrire. Un problème qui ne s'en va
 * pas n'est pas masqué : l'enregistrement qui suit le rendra tel quel.
 */
async function attendreAgentsAJour(api, flow) {
  try {
    await attendreQue(
      async () => ((await api.apercu(flow))?.problems ?? []).every((probleme) => !(probleme.bloquant !== false && CODES_DES_AGENTS.has(probleme.code))),
      { delaiMs: 40_000, pasMs: 1_000, libelle: "agents du déroulé vus à jour par le cockpit (cache GET /agent)" },
    );
  } catch {
    // L'enregistrement qui suit dira lui-même les problèmes restants.
  }
}

/** Étapes d'un bloc, dans l'ordre où le déroulé les exécute (formes de l'itération 4 et de la 5b). */
export function etapesDuBloc(bloc) {
  if (bloc.type === "etape") return [bloc.etape];
  if (bloc.type === "avis") return [...bloc.avis, bloc.synthese];
  if (bloc.type === "relecture") return [bloc.auteur, bloc.relecteur];
  if (bloc.type === "aiguillage") return [bloc.aiguilleur, ...bloc.specialistes, ...(bloc.synthese === null ? [] : [bloc.synthese])];
  return [];
}

/**
 * Déroulé de référence d'un exemple : celui de l'équipe déjà installée, sinon celui du catalogue des exemples.
 *
 * Le banc ne passe PAS par `installerExemple` pour les formes de la 5b. L'installation d'un exemple installe ses assistants
 * de catalogue, ce qui demande le catalogue d'IA — indisponible sur une pile sans accès au réseau : l'aide de l'itération 4
 * se rabat alors sur un `PUT`, mais avant d'avoir déclaré au faux les assistants d'un bloc `relecture` ou `aiguillage`
 * qu'elle ne sait pas lire, et le `PUT` est refusé en « assistant-absent » (mesuré au banc, 22/09). On lit donc le déroulé
 * de référence, on déclare ses assistants, puis on pose l'équipe : même déroulé, mêmes assistants, même parcours.
 */
async function derouleDeReference(api, exemple) {
  const liste = await api.liste();
  const installee = (liste.teams ?? []).find((equipe) => equipe.id === exemple);
  if (installee) return installee;
  const modele = (liste.exemples ?? []).find((candidat) => candidat.id === exemple);
  exiger(modele !== undefined, `exemple « ${exemple} » absent du catalogue : ${resume((liste.exemples ?? []).map((e) => e.id))}`);
  return modele;
}

/**
 * Équipe POSÉE PAR LE BANC à partir d'un exemple : même déroulé, mêmes assistants. `suffixe` nomme une copie propre à un
 * scénario (identifiants d'étape suffixés) ; `null` pose l'exemple sous son propre identifiant.
 *
 * Deux raisons de suffixer, toutes deux mesurées au banc : les scénarios partagent UN faux opencode, et un script posé par
 * prédicat (`quand:etape=`) vaut pour toute session créée ENSUITE — deux lancements qui portent le même identifiant d'étape
 * jouent donc la même file de tours, et le second rejouerait le premier (`FakeOpencode.script` AJOUTE les tours, il ne les
 * remplace pas). `equipeDerivee` de `it4-commun.mjs` ne sait pas recopier les blocs `relecture` et `aiguillage` de la 5b : elle
 * les rendrait en pauses. `patch(bloc)` ajuste le bloc copié quand un scénario en a besoin.
 */
export async function equipeDeriveeC5(api, exemple, suffixe, patch = () => ({})) {
  const source = await derouleDeReference(api, exemple);
  const renomme = (etape) => (suffixe === null ? etape : { ...etape, id: `${etape.id}-${suffixe}` });
  const flow = {
    version: source.flow.version,
    blocs: source.flow.blocs.map((bloc) => {
      const id = suffixe === null ? bloc.id : `${bloc.id}-${suffixe}`;
      if (bloc.type === "etape") return { type: "etape", id, etape: renomme(bloc.etape) };
      if (bloc.type === "avis") return { type: "avis", id, avis: bloc.avis.map(renomme), synthese: renomme(bloc.synthese) };
      if (bloc.type === "pause") return { type: "pause", id, message: bloc.message };
      if (bloc.type === "relecture") return { ...bloc, id, auteur: renomme(bloc.auteur), relecteur: renomme(bloc.relecteur), ...patch(bloc) };
      return {
        ...bloc,
        id,
        aiguilleur: renomme(bloc.aiguilleur),
        specialistes: bloc.specialistes.map(renomme),
        synthese: bloc.synthese === null ? null : renomme(bloc.synthese),
        ...patch(bloc),
      };
    }),
  };
  // Les assistants sont déclarés AVANT l'enregistrement : le faux ne lit aucun fichier d'agent, et `PUT /api/teams/:id` refuse
  // un déroulé dont un assistant n'est pas servi par opencode (« assistant-absent », bloquant).
  await declarerLesAssistants(api, flow);
  await attendreAgentsAJour(api, flow);
  const equipeId = suffixe === null ? exemple : `${exemple}-${suffixe}`;
  const titre = (suffixe === null ? source.titre : `${source.titre} (${suffixe})`).slice(0, 80);
  const reponse = await api.mettreAJourBrut(equipeId, { titre, description: source.description ?? "", flow });
  exiger(reponse.code === 200, `équipe dérivée « ${equipeId} » refusée (${reponse.code}) : ${resume(reponse.corps, 400)}`);
  return { id: equipeId, flow, titre: JSON.parse(reponse.corps).titre };
}

/** États FINAUX d'un lancement : au-delà, il n'occupe plus de place parmi les équipes en cours. */
const FINIS = new Set(["terminee", "arretee", "echec", "interrompue", "plafond"]);

/**
 * Arrête les lancements qui n'ont pas abouti. Un lancement laissé en attente occupe une place parmi les « équipes en cours en
 * même temps » : le scénario suivant serait refusé en 409 « trop-d-equipes » pour une raison qui ne le regarde pas. À appeler
 * dans un `finally`, y compris quand le scénario tombe.
 */
export async function arreterLesLancements(api, runIds) {
  for (const runId of runIds) {
    const vue = await api.vue(runId).catch(() => null);
    if (vue !== null && !FINIS.has(vue.state)) await api.arreterBrut(runId).catch(() => {});
  }
}

/** Estime puis lance une équipe déjà posée, avec la demande donnée ; rend { runId, rootId }. */
export async function lancerAvec(api, equipeId, demande) {
  const estimation = await api.estimer(equipeId);
  exiger(estimation.blocage == null, `estimation de « ${equipeId} » bloquée : ${resume(estimation.blocage)}`);
  const reponse = await api.lancerBrut(equipeId, {
    directory: api.directory,
    rootId: null,
    demande,
    fichiers: [],
    agentConversation: "build",
    estimateSha256: estimation.estimateSha256,
    confirmations: { workspace: true },
  });
  exiger(reponse.code === 202, `lancement de « ${equipeId} » refusé (${reponse.code}) : ${resume(reponse.corps, 400)}`);
  return { estimation, ...JSON.parse(reponse.corps) };
}

export async function run(ctx) {
  if (ctx.mode !== "faux") {
    nonJoue(ctx, "relecture de bout en bout", "le faux fournisseur ne rend que du texte : les étapes d'une équipe n'y sont pas scriptables");
    ctx.expectNoConsoleErrors();
    return;
  }
  const page = await preparerPage(ctx);

  const lancements = [];
  let apiDuScenario = null;
  await enAvance(ctx, async () => {
    const api = equipes(ctx);
    apiDuScenario = api;
    const equipe = await equipeDeriveeC5(api, EXEMPLE, null);

    // Le déroulé livré est bien une relecture de 2 tours, avec la pause avant la première relecture : c'est ce que le scénario
    // éprouve, et un exemple qui changerait de forme doit le faire échouer ici, pas plus loin.
    const bloc = equipe.flow.blocs.find((candidat) => candidat.type === "relecture");
    exiger(bloc !== undefined, `l'exemple « ${EXEMPLE} » ne porte pas de bloc « relecture » : ${resume(equipe.flow.blocs.map((b) => b.type))}`);
    exiger(bloc.toursMax === 2, `toursMax vaut ${bloc.toursMax} au lieu de 2.`);
    exiger(bloc.pauseAvantRelecture === true, "l'exemple ne laisse pas vérifier le premier jet avant la relecture.");
    exiger(bloc.auteur.id === REDACTION && bloc.relecteur.id === RELECTURE, `étapes « ${bloc.auteur.id} » et « ${bloc.relecteur.id} ».`);

    await scripterEtape(ctx, REDACTION, JET_1, JET_2, JET_3);
    await scripterEtape(ctx, RELECTURE, RELECTURE_1, RELECTURE_2);

    const estimation = await api.estimer(EXEMPLE);
    exiger(estimation.blocage == null, `estimation bloquée : ${resume(estimation.blocage)}`);
    // « 1 tour en général, 2 au plus » : le « au plus » de P3 n'est écrit que là où le cockpit applique un plafond, et
    // l'estimation porte donc les répétitions du déroulé (FlowEstimate.repetitions, 5b).
    releve(ctx, `estimation de « ${EXEMPLE} » : répétitions ${resume(estimation.estimate?.repetitions ?? null, 120)}, plafond ${estimation.plafond} $`);
    exiger(estimation.estimate?.repetitions?.tours === 2, `l'estimation annonce ${resume(estimation.estimate?.repetitions?.tours)} tour(s) au plus au lieu de 2.`);
    const lancement = await api.lancerBrut(EXEMPLE, {
      directory: api.directory,
      rootId: null,
      demande: DEMANDE,
      fichiers: [],
      agentConversation: "build",
      estimateSha256: estimation.estimateSha256,
      confirmations: { workspace: true },
    });
    exiger(lancement.code === 202, `lancement refusé (${lancement.code}) : ${resume(lancement.corps, 400)}`);
    const { runId, rootId } = JSON.parse(lancement.corps);
    lancements.push(runId);

    // 1. Premier jet rendu, puis pause : RIEN n'est envoyé au relecteur tant que vous n'avez pas continué.
    const enPause = await attendreRun(api, runId, (vue) => vue.state === "attente-verification", "pause avant la première relecture");
    const etat = (stepId, tour = 1) => enPause.steps.find((step) => step.stepId === stepId && (step.tour ?? 1) === tour)?.state;
    exiger(etat(REDACTION) === "terminee", `premier jet : état « ${etat(REDACTION)} ».`);
    exiger(etat(RELECTURE) !== "en-cours" && etat(RELECTURE) !== "terminee", `le relecteur travaille pendant la pause : « ${etat(RELECTURE)} ».`);
    const avantReprise = await repere(ctx);
    await attendre(500);
    const pendantLaPause = envois(await requetesDepuis(ctx, avantReprise));
    exiger(pendantLaPause.length === 0, `${pendantLaPause.length} envoi(s) pendant la pause avant relecture.`);

    // 2 et 3. Deux tours, puis l'arrêt au plafond : le relecteur ne travaille pas trois fois.
    const reprise = await api.continuerBrut(runId, {});
    exiger(reprise.code === 200, `reprise refusée (${reprise.code}) : ${resume(reprise.corps, 300)}`);
    const finie = await attendreRun(api, runId, (vue) => vue.state === "terminee" || vue.state === "en-echec", "relecture terminée", 90_000);
    exiger(finie.state === "terminee", `lancement en état « ${finie.state} » : ${resume(finie.steps.map((s) => `${s.stepId}/${s.tour}=${s.state}`))}`);

    const tours = (stepId) => finie.steps.filter((step) => step.stepId === stepId);
    releve(ctx, `étapes du lancement : ${resume(finie.steps.map((s) => `${s.stepId} tour ${s.tour ?? 1} : ${s.state} ${s.verdict ?? ""}`.trim()), 400)}`);
    exiger(tours(RELECTURE).length === 2, `${tours(RELECTURE).length} relecture(s) au lieu de 2 : le plafond de tours n'est pas respecté.`);
    exiger(tours(REDACTION).length === 3, `${tours(REDACTION).length} rédaction(s) au lieu de 3 (toursMax + 1 : la dernière correction n'est plus relue).`);
    const verdicts = tours(RELECTURE).map((step) => step.verdict ?? null);
    exiger(
      verdicts.length === 2 && verdicts.every((verdict) => verdict === "a-reprendre"),
      `verdicts lus : ${resume(verdicts)} (deux « a-reprendre » attendus, lus sur la dernière ligne).`,
    );

    // 5. Coût : la somme des cinq appels scriptés, à un centième de cent près (arrondis d'affichage exclus), et sous le
    //    plafond d'arrêt du lancement (« Arrêt automatique à {x} $ », spéc. §6) : le plafond n'a pas eu à jouer.
    const cout = Number(finie.cost ?? finie.depense ?? 0);
    releve(ctx, `coût du lancement : ${cout} $ (attendu ${COUT_ATTENDU} $ = ${[JET_1, JET_2, JET_3, RELECTURE_1, RELECTURE_2].map((t) => t.cost).join(" + ")}), plafond ${finie.plafond} $`);
    exiger(Math.abs(cout - COUT_ATTENDU) < 1e-6, `coût du lancement ${cout} $ au lieu de ${COUT_ATTENDU} $.`);
    exiger(typeof finie.plafond === "number" && finie.plafond > 0, `le lancement n'a pas de plafond d'arrêt : ${resume(finie.plafond)}`);
    exiger(cout <= finie.plafond, `coût du lancement ${cout} $ au-dessus du plafond ${finie.plafond} $.`);

    // 6. Sessions reprises (D-5-14) : deux créations de session pour ce lancement, et les cinq envois dans ces deux-là.
    const journal = await ctx.opencodeRequests();
    const creations = journal.filter(
      (requete) => requete.method === "POST" && requete.pathname === "/session" && requete.body?.metadata?.run === runId,
    );
    const etapesCreees = creations.map((requete) => `${requete.body.metadata.etape} (tour ${requete.body.metadata.tour})`);
    releve(ctx, `sessions créées pour le lancement : ${resume(etapesCreees)}`);
    exiger(creations.length === 2, `${creations.length} session(s) créée(s) pour la relecture au lieu de 2 : un tour suivant a ouvert une session neuve (D-5-14).`);
    const sessionsDuLancement = new Set(finie.steps.map((step) => step.sessionId).filter((id) => typeof id === "string"));
    exiger(sessionsDuLancement.size === 2, `${sessionsDuLancement.size} session(s) portées par les étapes au lieu de 2 : ${resume([...sessionsDuLancement])}`);
    const envoisDuLancement = envois(journal).filter((requete) => sessionsDuLancement.has(requete.pathname.split("/")[2]));
    exiger(envoisDuLancement.length === 5, `${envoisDuLancement.length} envoi(s) dans les sessions du lancement au lieu de 5 (trois jets, deux relectures).`);

    // 4. Journal de relecture REPLIÉ sous le résultat, avec ses deux tours, et la note d'honnêteté du plafond.
    await ouvrirLaConversation(ctx, rootId);
    await page.attendreQue("document.querySelector('.team-result')", { delaiMs: 25_000, libelle: "carte de résultat de la relecture" });
    // Le journal est lu par `textContent`, pas par `innerText` : un <details> FERMÉ ne rend pas son contenu, et `innerText`
    // rend alors une chaîne vide (mesuré au banc, 22/09) — ce qui est exactement ce que « replié » veut dire à l'écran. Le
    // lecteur d'écran, lui, le trouve en dépliant le résumé : c'est ce texte-là qui est vérifié.
    const carte = await page.evaluer(`(() => {
      const section = document.querySelector(".team-result");
      const journal = section.querySelector("details.team-journal");
      return {
        texte: (section.innerText ?? "").replace(/\\s+/g, " ").trim(),
        journalPresent: journal !== null,
        journalReplie: journal === null ? null : journal.open === false,
        journalTitre: (journal?.querySelector("summary")?.textContent ?? "").trim(),
        journalTexte: (journal?.querySelector(".team-result-text")?.textContent ?? "").replace(/\\s+/g, " ").trim(),
        journalVisible: (journal?.querySelector(".team-result-text")?.innerText ?? "").trim() !== "",
      };
    })()`);
    releve(ctx, `carte de résultat : journal ${carte.journalPresent ? "présent" : "absent"}, replié ${carte.journalReplie}`);
    exiger(carte.journalPresent, `aucun journal de relecture sous le résultat : ${resume(carte.texte, 400)}`);
    exiger(carte.journalReplie === true, "le journal de relecture n'est pas replié sous le résultat.");
    exiger(carte.journalVisible === false, "le contenu du journal est rendu à l'écran alors que le journal est replié.");
    exiger(carte.journalTitre === PHRASES.journal, `titre du journal : « ${carte.journalTitre} ».`);
    for (const attendu of [PHRASES.tour1, PHRASES.tour2, PHRASES.aReprendre]) {
      exiger(carte.journalTexte.includes(attendu), `le journal ne porte pas « ${attendu} » : ${resume(carte.journalTexte, 400)}`);
    }
    // Les deux relectures sont dans le journal, pas dans le résultat : le livrable n'est pas réécrit, il est découpé.
    exiger(carte.journalTexte.includes("aucune source n'est citée"), `le journal ne reprend pas la relecture du tour 1 : ${resume(carte.journalTexte, 400)}`);
    exiger(carte.journalTexte.includes("aucune action n'a d'échéance"), `le journal ne reprend pas la relecture du tour 2 : ${resume(carte.journalTexte, 400)}`);
    // La carte DIT que la relecture n'a pas conclu : « Relecture non conclue après 2 tours … », ou « Non relue après la
    // dernière correction. » quand c'est cette correction-là que vous lisez. L'une des deux, jamais le silence.
    const notes = [PHRASES.nonConclue, PHRASES.nonRelue].filter((phrase) => carte.texte.includes(phrase));
    releve(ctx, `notes d'honnêteté de la carte : ${resume(notes)}`);
    exiger(notes.length > 0, `la carte ne dit pas que la relecture n'a pas conclu : ${resume(carte.texte, 400)}`);
    // Le livrable n'est pas réécrit : le dernier jet du rédacteur reste le résultat, journal mis à part.
    exiger(carte.texte.includes("1 380 paiements refusés"), `le résultat ne porte pas le dernier jet : ${resume(carte.texte, 400)}`);
    exiger(!carte.texte.includes(RIEN_A_REPRENDRE), "un verdict « rien à reprendre » apparaît alors qu'aucun tour ne l'a rendu.");
  }).finally(async () => {
    if (apiDuScenario !== null) await arreterLesLancements(apiDuScenario, lancements);
  });

  ctx.expectNoConsoleErrors();
}
