// Catalogue des méthodes livrées avec le cockpit (conception C §12.2 ; recherche RM §2 ; plan d'exécution it5, fiche L44a).
// Versionné et relu dans le dépôt, comme assistants-catalogue.ts : toute modification d'un `bloc` augmente sa `version`.
//
// Une méthode est du TEXTE : aucun appel d'IA en plus. Les méthodes sont CONSEILLÉES (`suggereePour`), jamais attachées
// automatiquement à un assistant installé (C §16, D-5-07). « Seconde lecture » n'est pas un bloc de texte : c'est un autre
// assistant qui relit (kind « relecture », `bloc` vide).
//
// `titre` et `phrase` sont ceux de C §12.2, à l'octet. `quand` et `attention` viennent de RM §2 (« When » ; défaillances de
// l'IA et parade), 200 caractères au plus. `bloc` est réécrit en français depuis RM §2 (« What it adds »), 120 mots au plus :
// première phrase = déclencheur et en-tête à écrire, dernière phrase « Sinon, n'applique pas cette méthode. » (sauf la méthode
// de base « certitude », qui s'applique toujours). `sources` : liens de RM §2 et §7, affichés en mode Avancé seulement.
import type { Method } from "./shared/methods.ts";

export const METHODS: readonly Method[] = Object.freeze([
  {
    id: "certitude",
    version: 1,
    titre: "Certitude et À VÉRIFIER",
    phrase: "L'assistant distingue ce qu'il a vérifié, ce qu'il déduit et ce que vous devez vérifier.",
    quand: "Toujours, et surtout dès qu'une réponse cite une commande, une option, une version, un nom de serveur, une date ou une faille connue.",
    attention:
      "L'IA affirme trop sûrement, écrit « À VÉRIFIER » partout (ce qui cache les vraies inconnues) ou invente une source. Parade : une source doit avoir été lue ici, 5 affirmations au plus.",
    kind: "consigne",
    bloc: [
      "Pour toute réponse qui cite une commande, une option, une version, un nom de serveur, une date ou une cause : commence ta réponse par « ### Méthode : Certitude et À VÉRIFIER ».",
      "Classe ensuite chaque affirmation qui compte : Vérifié, avec la source que tu as lue (fichier:ligne, sortie de commande, document fourni) ; Déduit ; ou À VÉRIFIER, avec la façon de le vérifier (la commande à lancer, le document à ouvrir).",
      "Cinq affirmations au plus, les plus importantes. Une source est quelque chose que tu as lu dans cette conversation : n'en invente aucune. N'écris pas « À VÉRIFIER » sur tout : les vraies inconnues y disparaîtraient.",
    ].join("\n"),
    enTete: "### Méthode : Certitude et À VÉRIFIER",
    suggereePour: [],
    sources: ["https://arxiv.org/abs/2207.05221", "https://arxiv.org/abs/2306.13063", "https://arxiv.org/abs/2309.11495"],
  },
  {
    id: "clarifier-d-abord",
    version: 1,
    titre: "Clarifier d'abord",
    phrase: "Avant de répondre, l'assistant reformule votre demande et pose les questions indispensables.",
    quand: "Demande vague (« le traitement de nuit plante »), environnement non dit (production ou recette, quel serveur, quelle version), ou action destructrice.",
    attention:
      "L'IA ne demande rien, ou demande tout et fait perdre un tour payant ; elle peut réclamer une donnée client ou un secret. Parade : 3 questions au plus, aucune donnée sensible.",
    kind: "consigne",
    bloc: [
      "Quand la demande est vague, que l'environnement n'est pas dit ou que l'action est destructrice : commence ta réponse par « ### Méthode : Clarifier d'abord ».",
      "Reformule la demande en une ligne. Pose ensuite trois questions bloquantes au plus, puis arrête-toi et attends la réponse.",
      "Ne demande jamais de donnée client, de mot de passe ni de clé. Si rien ne bloque, écris une courte liste « Hypothèses retenues », puis réponds.",
      "Sinon, n'applique pas cette méthode.",
    ].join("\n"),
    enTete: "### Méthode : Clarifier d'abord",
    suggereePour: ["rediger-runbook"],
    sources: ["https://arxiv.org/html/2605.25284v1", "https://arxiv.org/pdf/2505.13360"],
  },
  {
    id: "diagnostic-differentiel",
    version: 1,
    titre: "Diagnostic différentiel",
    phrase: "L'assistant liste plusieurs causes possibles, puis les élimine une à une avec des indices.",
    quand: "Incident, alerte, traitement par lots instable, baisse de performance : partout où la première explication qui vient est tentante.",
    attention:
      "L'IA se fixe sur la première hypothèse, cite des indices qu'elle n'a pas lus, ou propose un test qui modifie l'état. Parade : chaque indice cite une lecture, tests en lecture seule.",
    kind: "consigne",
    bloc: [
      "Quand la demande porte sur un incident, une alerte ou une baisse de performance : commence ta réponse par « ### Méthode : Diagnostic différentiel ».",
      "Donne un tableau de cinq hypothèses au plus, avec pour chacune : indice pour, indice contre, test qui départage, état (écartée, possible, probable).",
      "Chaque indice cite ce que tu as lu ; sans source, écris « À VÉRIFIER ». Le test qui départage est une commande ou un contrôle en lecture seule, lancé par la personne, jamais par toi.",
      "Termine en nommant ce qui reste ouvert.",
      "Sinon, n'applique pas cette méthode.",
    ].join("\n"),
    enTete: "### Méthode : Diagnostic différentiel",
    suggereePour: ["analyser-incident", "expliquer-alerte"],
    sources: [
      "https://www.ccjm.org/content/ccjom/82/11/745.full.pdf",
      "https://codex.ucsf.edu/primer-3-role-clinical-reasoning-diagnostic-excellence",
    ],
  },
  {
    id: "cinq-pourquoi",
    version: 1,
    titre: "5 pourquoi",
    phrase: "L'assistant remonte de la panne à ses causes profondes, sur plusieurs pistes.",
    quand: "Après le dépannage : compte rendu d'incident, panne qui revient, constat d'audit. Jamais pendant que l'incident est en cours.",
    attention:
      "L'IA suit une seule chaîne de causes, invente des liens plausibles, met en cause une personne, ou s'arrête à cinq quoi qu'il arrive. Parade : 2 à 3 pistes, chaque cause marquée.",
    kind: "consigne",
    bloc: [
      "Quand la demande porte sur les causes profondes d'une panne déjà dépannée : commence ta réponse par « ### Méthode : 5 pourquoi ».",
      "Choisis deux à trois pistes parmi : changement, code, configuration, infrastructure, données, dépendance externe, procédure, supervision.",
      "Sur chaque piste, enchaîne les « pourquoi » jusqu'à une cause sur laquelle on peut agir : pas forcément cinq. Marque chaque « parce que » Vérifié, Déduit ou À VÉRIFIER.",
      "Propose une action par cause profonde. Écris les causes en termes de systèmes et de procédures, jamais de personnes.",
      "Sinon, n'applique pas cette méthode.",
    ].join("\n"),
    enTete: "### Méthode : 5 pourquoi",
    suggereePour: ["rediger-compte-rendu-incident"],
    sources: [
      "https://pubmed.ncbi.nlm.nih.gov/27590189/",
      "https://asq.org/quality-resources/fishbone",
      "https://sre.google/sre-book/postmortem-culture/",
    ],
  },
  {
    id: "pre-mortem",
    version: 1,
    titre: "Pré-mortem",
    phrase: "L'assistant imagine que le changement a échoué et explique pourquoi, pour corriger le plan avant.",
    quand: "Avant un changement, une migration, une demande CAB, une bascule de production ou une rotation de certificat.",
    attention:
      "L'IA donne des risques passe-partout (« le réseau peut tomber »), flatte le plan, ou n'en finit plus. Parade : chaque risque nomme une étape ou un composant de CE plan, cinq au plus.",
    kind: "consigne",
    bloc: [
      "Quand la demande porte sur un changement, une migration ou une demande CAB : commence ta réponse par « ### Méthode : Pré-mortem ».",
      "Imagine que le changement a échoué. Donne les 5 raisons les plus probables, chacune liée à une étape ou un composant précis de ce plan, avec : signal d'alerte visible en premier, prévention, équipe concernée.",
      "Termine par le point le plus fragile du plan, en une ligne. Ne rassure pas. N'invente aucun composant : ce que tu n'as pas lu est « À VÉRIFIER ».",
      "Sinon, n'applique pas cette méthode.",
    ].join("\n"),
    enTete: "### Méthode : Pré-mortem",
    suggereePour: ["preparer-revue-cab"],
    sources: ["https://hbr.org/2007/09/performing-a-project-premortem"],
  },
  {
    id: "retour-arriere-d-abord",
    version: 1,
    titre: "Retour arrière d'abord",
    phrase: "Avant de proposer une action, l'assistant dit ce qu'elle peut casser et comment revenir en arrière.",
    quand: "Toute réponse qui propose un script, une commande, une requête SQL, un changement de configuration ou de pare-feu, ou une étape de fiche d'intervention.",
    attention:
      "L'IA propose un retour arrière qui ne marche pas, oublie l'irréversible (DROP, TRUNCATE, rm, clés), ou invente les commandes. Parade : impact, retour arrière et vérification d'abord.",
    kind: "consigne",
    bloc: [
      "Quand ta réponse propose un script, une commande, une requête SQL, un changement de configuration ou une étape d'intervention : commence ta réponse par « ### Méthode : Retour arrière d'abord ».",
      "Avant toute étape qui modifie quelque chose, donne dans cet ordre : 1. rayon d'impact (ce qui est touché, qui est gêné, réversible ou non) ; " +
        "2. retour arrière (étapes exactes, quand s'en servir, ce qui ne se défait pas, en gras) ; " +
        "3. vérification (comment confirmer, sur un périmètre réduit si possible) ; 4. seulement ensuite, le changement.",
      "Écris « IRRÉVERSIBLE » et « À VÉRIFIER : sauvegarde testée ? » quand c'est le cas.",
      "Sinon, n'applique pas cette méthode.",
    ].join("\n"),
    enTete: "### Méthode : Retour arrière d'abord",
    suggereePour: ["relire-script", "preparer-revue-cab", "rediger-runbook", "relire-requete-sql"],
    sources: [
      "https://eur-lex.europa.eu/eli/reg/2022/2554/oj/eng",
      "https://sre.google/workbook/canarying-releases/",
      "https://sre.google/sre-book/reliable-product-launches/",
    ],
  },
  {
    id: "avocat-du-diable",
    version: 1,
    titre: "Avocat du diable",
    phrase: "L'assistant défend sérieusement la meilleure option opposée, pour tester votre choix.",
    quand: "Choix entre deux approches (bascule ou mise à jour sur place, maintenant ou plus tard), hypothèse à laquelle on tient, décision d'architecture.",
    attention:
      "L'IA caricature l'option opposée, conteste pour contester, ou change d'avis pour faire plaisir. Parade : défendre la version la plus solide, ne rien changer sans fait nouveau.",
    kind: "consigne",
    bloc: [
      "Quand la demande compare deux approches ou défend une hypothèse : commence ta réponse par « ### Méthode : Avocat du diable ».",
      "Donne « Option retenue », puis « Meilleure option opposée » dans sa version la plus solide, jamais caricaturée, avec les trois arguments les plus forts en sa faveur.",
      "Ajoute « Ce qui me ferait changer d'avis », avec des faits observables. Termine par une recommandation qui dit si elle a changé.",
      "Ne change pas de conclusion sans fait nouveau, et ne conteste pas pour contester.",
      "Sinon, n'applique pas cette méthode.",
    ].join("\n"),
    enTete: "### Méthode : Avocat du diable",
    suggereePour: [],
    sources: [
      "https://www.semanticscholar.org/paper/Considering-the-opposite:-a-corrective-strategy-for-Lord-Lepper/e71bbae72f8ad78e97c54f5ec88c9af2c70759f2",
      "https://dl.acm.org/doi/10.1145/3640543.3645199",
    ],
  },
  {
    id: "seconde-lecture",
    version: 1,
    titre: "Seconde lecture",
    phrase: "Un autre assistant relit la réponse avec une liste de contrôle. Il ne remplace pas la relecture par un collègue.",
    quand: "Avant d'agir sur un script, une requête SQL, un texte pour le CAB ou une conclusion d'incident. À votre demande, réponse par réponse.",
    attention:
      "Une IA qui se relit elle-même tamponne sans rien voir, chipote, ou casse un passage juste. Parade : un autre assistant, une liste de contrôle, des défauts situés, aucun verdict global.",
    kind: "relecture",
    bloc: "",
    enTete: "### Méthode : Seconde lecture",
    suggereePour: ["relecteur-critique"],
    sources: [
      "https://arxiv.org/abs/2310.01798",
      "https://arxiv.org/abs/2311.08516",
      "https://arxiv.org/abs/2404.13076",
      "https://www.anthropic.com/engineering/building-effective-agents",
    ],
  },
]);
