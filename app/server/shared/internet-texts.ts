// Textes de l'accès à Internet fermé (1.1.0, décision A37 ; fiche de la migration du web §5 et §7), rangés ici pour être contrôlés
// par le test « textes » (convention TEXTES de T0, textes.test.ts). Lus par l'écran Sécurité, l'assistant de création, le Studio,
// le Diagnostic, Paramètres › opencode et les refus 422 « internet-ferme » du serveur.
//
// Mode Simple : jamais le nom d'un outil (webfetch, websearch), ni D11, ni « volume », ni les mots interdits de la spécification
// §2.3 (agent, permission…). Seul écart avec la lettre de la fiche §7 : la confirmation de « Revenir au profil Prudent », affichée
// aussi en mode Simple, dit « Les règles globales » au lieu de « Les permissions globales » (§2.3 prime).
//
// Honnêteté (P3), chaque phrase tenue par un test :
// - « Il ne va jamais sur Internet » (Prudent 1.1) : webfetch et websearch refusés par le profil (PERMISSION_PRESETS, A31 c) et par le
//   relais de sortie d'opencode (1.0.6), qui n'ouvre que GitHub Copilot ;
// - « votre profil est gardé, seul l'accès à Internet change » : POST /api/security/update-profile écrit presetPermission(id) du
//   MÊME profil (legacyPresetOf), rendu 409 pour tout autre réglage (integration.test.ts) ;
// - « En enregistrant, Internet sera fermé pour lui » : buildAssistantFile écrit toujours web=false (core.test.ts, assistants.test.ts) ;
// - « peuvent encore le demander » : webAskAgents sur les règles EFFECTIVES de GET /agent (web-rules.test.ts) ; rien n'est affiché
//   quand opencode ne répond pas (security.webIssues null).

export const TEXTES = {
  simple: {},
  avance: {
    /** Point « Web » des trois cartes de profil (Paramètres › opencode). */
    cartesWeb: "Web : refusé",
    resumeEquilibre: "Modifications de fichiers libres ; commandes et sous-agents sur confirmation ; web refusé.",
    /** Confirmation du profil « Sans confirmation (déconseillé) ». */
    avertissementSansConfirmation:
      "L'agent pourra modifier des fichiers et lancer n'importe quelle commande sans rien vous demander. Internet reste fermé. À réserver à des projets jetables ou entièrement versionnés.",
    /** Repère d'un profil de la 1.0 (web encore ouvert) sur sa carte : il n'est plus « actif », « Appliquer » le met à jour. */
    repereAncien: "Version précédente : Internet pas encore fermé.",
    /** Refus 422 « internet-ferme » (correctif, fichier brut, permissions globales) ; {chemins} : ouvertures introduites. */
    refus: "Internet est fermé : « ask » et « allow » ne sont plus acceptés pour webfetch et websearch ({chemins}). Une demande web restée en attente bloquait les autres autorisations. Mettez « deny ».",
    /** Refus 422 « internet-ferme » du Studio, par clé ; {cle} : clé de permission (ou « permission » pour une règle en texte). */
    studio: "Internet est fermé : « {cle} » n'accepte plus que « deny ».",
    /** Studio : webfetch ou websearch à ask, à allow ou en motifs dans le fichier, écrit « deny » à l'enregistrement. */
    refuserALEnregistrement: "Refuser (appliqué à l'enregistrement)",
    refuser: "Refuser",
    herite: "Hérité",
    heriteAide: "Utilise la règle de la configuration globale, qui refuse Internet.",
    /** Studio : outil absent du fichier alors que la règle globale ne le refuse pas (« Hérité » n'est pas proposé). */
    heriteOuvert: "La règle globale ne refuse pas cet outil : choisissez « Refuser ».",
  },
  partout: {
    /** Profil Prudent (1.1), en vert (SECURITY_TEXTS.prudent). */
    prudent:
      "Profil de droits : Prudent. L'assistant demande avant de modifier un fichier, lancer une commande ou déléguer. Il ne va jamais sur Internet.",
    /** Profil d'une version précédente (legacyProfileText) ; {profil} : libellé du profil. */
    ancien:
      "Profil de droits : {profil} (réglage d'une version précédente). L'assistant peut encore vous demander d'aller sur Internet. C'est impossible au travail, et une telle demande restée sans réponse peut bloquer les autres demandes d'autorisation. Cliquez sur « Fermer l'accès à Internet » : votre profil est gardé, seul l'accès à Internet change.",
    fermer: "Fermer l'accès à Internet",
    fermerTitre: "Fermer l'accès à Internet ?",
    fermerMessage:
      "Votre profil {profil} est gardé ; seul l'accès à Internet passe à « refusé ». opencode redémarre quelques secondes pour appliquer ces règles, jamais pendant une réponse.",
    fermerReussite: "Internet est fermé. Votre profil {profil} est inchangé.",
    /** 409 « profil-inconnu » de POST /api/security/update-profile (réglage qui n'est pas un profil d'une version précédente). */
    profilInconnu:
      "Ce réglage n'est pas un profil d'une version précédente : rien n'a été changé. Pour revenir aux règles conseillées, utilisez « Revenir au profil Prudent ».",
    /** Confirmation et réussite de « Revenir au profil Prudent ». */
    prudentMessage:
      "Les règles globales d'opencode seront remplacées : l'assistant demandera avant de modifier un fichier, lancer une commande ou déléguer, et n'ira jamais sur Internet. opencode redémarre quelques secondes pour appliquer ces règles, jamais pendant une réponse.",
    prudentReussite: "L'assistant demande de nouveau avant chaque action sensible. Internet est fermé.",
    /** Assistants signalés (écran Sécurité, quand la règle générale ne demande plus) ; {titres} : titres, séparés par des virgules. */
    assistantsSignales:
      "Ces assistants peuvent encore vous demander d'aller sur Internet : {titres}. Ouvrez chacun (Assistants › Modifier), puis Enregistrer : Internet sera fermé pour lui.",
    /** Assistants signalés sans titre, en mode Simple (jamais leur nom technique). */
    autre: "1 autre créé hors de l'assistant de création",
    autres: "{n} autres créés hors de l'assistant de création",
    /** Assistant de création, à la place de la case « Consulter Internet » (deux modes). */
    creationFerme: "Internet : fermé. L'assistant ne consulte jamais Internet : au travail, seul GitHub Copilot est joignable.",
    /** Assistant d'une version précédente (ouverture et « Compléter ») : detectRights rend web: true. */
    creationAncien: "Cet assistant pouvait demander à aller sur Internet. En enregistrant, Internet sera fermé pour lui.",
    /** Diagnostic. */
    diagnosticFerme: "Accès à Internet de l'assistant : fermé.",
    diagnosticAssistant: "Accès à Internet : 1 assistant peut encore le demander. Voir Paramètres › Sécurité.",
    diagnosticAssistants: "Accès à Internet : {n} assistants peuvent encore le demander. Voir Paramètres › Sécurité.",
    diagnosticGlobal: "Accès à Internet : la règle générale le demande encore. Voir Paramètres › Sécurité.",
  },
};

/** Forme de security.webIssues lue par les textes (WebIssues d'assistant-rules.ts). */
interface WebIssuesLite {
  global: boolean;
  assistants: ReadonlyArray<{ name: string; title: string | null }>;
}

/** Remplit un gabarit « {nom} » ; un nom absent des valeurs garde son gabarit. */
function remplir(gabarit: string, valeurs: Readonly<Record<string, string | number>>): string {
  return gabarit.replace(/\{(\w+)\}/g, (match: string, nom: string) => (Object.hasOwn(valeurs, nom) ? String(valeurs[nom]) : match));
}

/** Profil d'une version précédente (écran Sécurité, mode Simple et Avancé). */
export function texteProfilAncien(profil: string): string {
  return remplir(TEXTES.partout.ancien, { profil });
}

/** Confirmation de « Fermer l'accès à Internet ». */
export function texteFermerMessage(profil: string): string {
  return remplir(TEXTES.partout.fermerMessage, { profil });
}

/** Réussite de « Fermer l'accès à Internet ». */
export function texteFermerReussite(profil: string): string {
  return remplir(TEXTES.partout.fermerReussite, { profil });
}

/** Refus 422 « internet-ferme » (mode Avancé) : chemins des ouvertures introduites. */
export function texteRefusInternet(chemins: readonly string[]): string {
  return remplir(TEXTES.avance.refus, { chemins: chemins.join(", ") });
}

/** Refus 422 « internet-ferme » du Studio, pour une clé. */
export function texteStudioInternet(cle: string): string {
  return remplir(TEXTES.avance.studio, { cle });
}

/**
 * Assistants qui peuvent encore demander Internet (écran Sécurité), seulement quand la règle générale ne le demande plus (sinon
 * l'encadré du profil suffit) ; null : rien à signaler ou état inconnu. Mode Simple : titres seulement, les autres comptés.
 */
export function texteAssistantsSignales(issues: WebIssuesLite | null, avance: boolean): string | null {
  if (issues === null || issues.global || issues.assistants.length === 0) return null;
  const titres = avance
    ? issues.assistants.map((a) => a.title ?? a.name)
    : issues.assistants.flatMap((a) => (a.title === null ? [] : [a.title]));
  const sansTitre = avance ? 0 : issues.assistants.filter((a) => a.title === null).length;
  if (sansTitre === 1) titres.push(TEXTES.partout.autre);
  else if (sansTitre > 1) titres.push(remplir(TEXTES.partout.autres, { n: sansTitre }));
  return remplir(TEXTES.partout.assistantsSignales, { titres: titres.join(", ") });
}

/** Ligne du Diagnostic ; null : opencode n'a pas répondu (aucun état inventé). */
export function texteDiagnosticInternet(issues: WebIssuesLite | null): { ton: "bon" | "attention"; texte: string } | null {
  if (issues === null) return null;
  if (issues.global) return { ton: "attention", texte: TEXTES.partout.diagnosticGlobal };
  const n = issues.assistants.length;
  if (n === 0) return { ton: "bon", texte: TEXTES.partout.diagnosticFerme };
  return { ton: "attention", texte: n === 1 ? TEXTES.partout.diagnosticAssistant : remplir(TEXTES.partout.diagnosticAssistants, { n }) };
}
