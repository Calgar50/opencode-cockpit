// Vue pure de la conversation : puce, bulle, présence et bouton « Seconde lecture » (plan d'exécution it5, fiche L44e ;
// D-5-08, D-5-22 ; spécification §5.5, §6 l.1051 ; conception C §9.4, §9.7 ; RM §5.3, §5.4).
// Chaque garde a ici un test qui échoue sans elle :
// - puce désactivée pour un raccourci, pour une méthode déjà dans l'assistant, et au-delà de 2 méthodes par message ;
// - une méthode déjà retenue reste décochable ;
// - bloc ajouté au texte, bulle repliée, aller-retour avec `splitMessageMethods` ;
// - présence de la section attendue dans la réponse, et rien d'affirmé d'une méthode inconnue du catalogue ;
// - visibilité du bouton : réponse terminée seulement, ni message repère, ni la relecture elle-même ;
// - pied reconnu à partir du début fixe du message, comme le crochet du serveur ;
// - libellé du bouton et phrase de base pour CHAQUE valeur de `base`, jamais « au moins » (D-5-22).
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { estMessageDeSecondeLecture } from "./second-reading.ts";
import { TEXTES, secondReadingPrefix } from "./shared/construction-texts.ts";
import type { MethodView, SecondReadingEstimate } from "./shared/construction-types.ts";
import {
  estDemandeDeSecondeLecture,
  type MethodChipCode,
  methodBubbleRows,
  methodChipLabels,
  methodChipReason,
  methodChipState,
  methodPresenceRows,
  secondReadingBasePhrase,
  secondReadingButtonLabel,
  secondReadingButtonVisible,
  secondReadingFooter,
  secondReadingMessage,
  secondReadingTooltip,
} from "./shared/chat-methods-view.ts";
import { METHOD_LIMITS, renderMessageMethodBlock, splitMessageMethods } from "./shared/methods.ts";

// --- Fixtures -------------------------------------------------------------------------------------------------------------------

/** Méthode de catalogue vue par l'interface ; le bloc porte l'en-tête demandé, comme toute entrée réelle. */
function vue(id: string, titre: string, options: Partial<MethodView> = {}): MethodView {
  const enTete = `### Méthode : ${titre}`;
  return {
    id,
    version: 1,
    titre,
    phrase: `Phrase de ${titre}.`,
    quand: `le sujet s'y prête (${id})`,
    attention: `Attention de ${titre}.`,
    kind: "consigne",
    bloc: `${enTete}\nFais ceci, puis cela. Sinon, n'applique pas cette méthode.`,
    enTete,
    sources: [],
    utiliseePar: [],
    conseilleePour: [],
    ...options,
  };
}

const PRE_MORTEM = vue("pre-mortem", "Pré-mortem");
const CERTITUDE = vue("certitude", "Niveau de certitude");
const CONTRADICTION = vue("contradiction", "Contradiction");
/** Une méthode « relecture » n'est pas un bloc de texte : elle n'est jamais proposée par la puce (D-5-07). */
const RELECTURE = vue("seconde-lecture", "Seconde lecture", { kind: "relecture", bloc: "", enTete: "" });

const CATALOGUE = [PRE_MORTEM, CERTITUDE, CONTRADICTION, RELECTURE];

const etat = (options: { agent?: string; estRaccourci?: boolean; choisies?: string[]; methods?: MethodView[] } = {}) =>
  methodChipState({
    methods: options.methods ?? CATALOGUE,
    agent: options.agent ?? "build",
    estRaccourci: options.estRaccourci ?? false,
    choisies: options.choisies ?? [],
  });

const item = (state: ReturnType<typeof etat>, id: string) => {
  const trouve = state.items.find((ligne) => ligne.id === id);
  if (!trouve) throw new Error(`ligne ${id} absente de la puce`);
  return trouve;
};

const estimation = (patch: Partial<SecondReadingEstimate> = {}): SecondReadingEstimate => ({
  installe: true,
  assistant: { name: "relecteur-critique", title: "Relecteur critique" },
  ia: { model: "github-copilot/gpt-5-mini", libelle: "GPT-5 mini" },
  usd: 0.06,
  base: "conversation",
  ...patch,
});

// --- Puce « + Méthode » ---------------------------------------------------------------------------------------------------------

describe("puce « + Méthode » (C §9.4)", () => {
  it("ne propose que les méthodes « consigne » : une méthode « relecture » n'est pas un bloc de texte", () => {
    const state = etat();
    assert.deepEqual(
      state.items.map((ligne) => ligne.id),
      ["pre-mortem", "certitude", "contradiction"],
    );
    assert.equal(state.boutonActif, true);
    assert.equal(state.boutonRaison, null);
    assert.equal(state.limite, METHOD_LIMITS.parMessage);
  });

  it("raccourci : bouton et toutes les lignes désactivés, avec la phrase du §4.3", () => {
    const state = etat({ estRaccourci: true });
    assert.equal(state.boutonActif, false);
    assert.equal(state.boutonRaison, "Les méthodes ne s'ajoutent pas à un raccourci.");
    assert.equal(state.boutonRaison, TEXTES.partout.methodes.limites.raccourci);
    for (const ligne of state.items) {
      assert.equal(ligne.active, false, ligne.id);
      assert.equal(ligne.code, "raccourci", ligne.id);
      assert.equal(ligne.raison, TEXTES.partout.methodes.limites.raccourci, ligne.id);
    }
  });

  it("raccourci : même une méthode DÉJÀ retenue reste désactivée (rien ne s'ajoute à un raccourci)", () => {
    const state = etat({ estRaccourci: true, choisies: ["pre-mortem"] });
    assert.equal(item(state, "pre-mortem").active, false);
    assert.equal(item(state, "pre-mortem").code, "raccourci");
  });

  it("méthode déjà dans les consignes de l'assistant : désactivée, « Déjà appliquée par l'assistant. »", () => {
    const attachee = vue("pre-mortem", "Pré-mortem", { utiliseePar: [{ name: "build", title: "Construire" }] });
    const state = etat({ methods: [attachee, CERTITUDE], agent: "build" });
    assert.equal(item(state, "pre-mortem").active, false);
    assert.equal(item(state, "pre-mortem").code, "deja");
    assert.equal(item(state, "pre-mortem").raison, "Déjà appliquée par l'assistant.");
    // Un AUTRE assistant n'est pas concerné : la même méthode reste proposée.
    assert.equal(item(etat({ methods: [attachee], agent: "plan" }), "pre-mortem").active, true);
  });

  it("2 méthodes au plus avec le message : la troisième est refusée avec sa phrase", () => {
    const state = etat({ choisies: ["pre-mortem", "certitude"] });
    assert.equal(state.retenues, 2);
    assert.equal(item(state, "contradiction").active, false);
    assert.equal(item(state, "contradiction").code, "trop");
    assert.equal(item(state, "contradiction").raison, "2 méthodes au maximum : au-delà, l'assistant les applique moins bien.");
    // Une seule retenue : la limite n'est pas atteinte.
    assert.equal(item(etat({ choisies: ["pre-mortem"] }), "contradiction").active, true);
  });

  it("une méthode retenue reste décochable, même devenue « déjà appliquée » après un changement d'assistant", () => {
    const attachee = vue("pre-mortem", "Pré-mortem", { utiliseePar: [{ name: "build", title: "Construire" }] });
    const state = etat({ methods: [attachee, CERTITUDE], agent: "build", choisies: ["pre-mortem", "certitude"] });
    const ligne = item(state, "pre-mortem");
    assert.equal(ligne.choisie, true);
    assert.equal(ligne.active, true, "sans cette garde, le bloc resterait attaché sans moyen de le retirer");
    assert.equal(ligne.code, "deja");
  });

  it("chaque ligne porte le bloc du message et « Quand : … », phrases du catalogue seulement", () => {
    const ligne = item(etat(), "pre-mortem");
    assert.equal(ligne.bloc, renderMessageMethodBlock({ ...PRE_MORTEM, suggereePour: [] }));
    assert.ok(ligne.bloc.includes("<!-- cockpit:methode-message pre-mortem v1 -->"));
    assert.equal(ligne.quand, `Quand : ${PRE_MORTEM.quand}`);
    assert.equal(ligne.phrase, PRE_MORTEM.phrase);
  });

  it("une phrase par code de refus, toutes venues de construction-texts.ts", () => {
    const codes: MethodChipCode[] = ["raccourci", "sans-texte", "deja", "trop"];
    const attendues = [
      TEXTES.partout.methodes.limites.raccourci,
      TEXTES.partout.methodes.limites.sansTexte,
      TEXTES.partout.methodes.limites.deja,
      TEXTES.partout.methodes.limites.trop,
    ];
    assert.deepEqual(codes.map(methodChipReason), attendues);
    // Quatre phrases distinctes : un code sans phrase propre n'apprendrait rien à la personne.
    assert.equal(new Set(attendues).size, codes.length);
    // « sans-texte » est le refus d'un message sans un mot écrit : le bloc seul ne serait une demande pour personne. Il n'est
    // PAS un état du popover — le catalogue reste choisissable tant que rien n'est envoyé.
    for (const ligne of etat().items) assert.notEqual(ligne.code, "sans-texte");
  });

  it("libellés de la puce retenue et de son retrait", () => {
    assert.deepEqual(methodChipLabels("Pré-mortem"), { choisie: "Méthode : Pré-mortem", retirer: "Retirer la méthode Pré-mortem" });
  });
});

// --- Bulle du message -----------------------------------------------------------------------------------------------------------

describe("bulle d'un message utilisateur (spéc. §5.5)", () => {
  it("le texte envoyé porte le bloc ; la bulle le sépare et le replie sous « Méthode demandée : {titre} »", () => {
    const envoye = `Analyse ce plan.${renderMessageMethodBlock({ ...PRE_MORTEM, suggereePour: [] })}`;
    const { texte, methodes } = splitMessageMethods(envoye);
    assert.equal(texte, "Analyse ce plan.");
    const lignes = methodBubbleRows(methodes, CATALOGUE);
    assert.equal(lignes.length, 1);
    assert.equal(lignes[0]?.libelle, "Méthode demandée : Pré-mortem");
    assert.ok(lignes[0]?.bloc.startsWith("### Méthode : Pré-mortem"));
  });

  it("méthode retirée du catalogue : son identifiant tient lieu de titre, le bloc envoyé est montré tel quel", () => {
    const lignes = methodBubbleRows([{ id: "methode-disparue", version: 3, bloc: "Texte envoyé." }], CATALOGUE);
    assert.deepEqual(lignes, [
      { id: "methode-disparue", titre: "methode-disparue", libelle: "Méthode demandée : methode-disparue", bloc: "Texte envoyé." },
    ]);
  });
});

// --- Présence dans la réponse ---------------------------------------------------------------------------------------------------

describe("présence de la méthode dans la réponse (spéc. §6 l.1051)", () => {
  const demandee = { id: "pre-mortem", version: 1, bloc: PRE_MORTEM.bloc };

  it("section attendue présente : « Méthode appliquée », avec l'infobulle qui borne ce qui est vérifié", () => {
    const lignes = methodPresenceRows({
      demandees: [demandee],
      catalogue: CATALOGUE,
      reponse: "Voici l'analyse.\n### Méthode : Pré-mortem\nCe qui pourrait échouer…",
    });
    assert.equal(lignes.length, 1);
    assert.equal(lignes[0]?.presente, true);
    assert.equal(lignes[0]?.libelle, "Méthode appliquée");
    assert.equal(lignes[0]?.infobulle, "Le cockpit vérifie seulement que la section attendue est présente, pas que le raisonnement est juste.");
  });

  it("section absente : « Méthode non détectée dans la réponse », jamais un jugement sur le raisonnement", () => {
    const lignes = methodPresenceRows({ demandees: [demandee], catalogue: CATALOGUE, reponse: "Voici l'analyse, sans section." });
    assert.equal(lignes[0]?.presente, false);
    assert.equal(lignes[0]?.libelle, "Méthode non détectée dans la réponse");
  });

  it("méthode inconnue du catalogue : aucune ligne, car aucun en-tête à chercher", () => {
    assert.deepEqual(methodPresenceRows({ demandees: [{ id: "inconnue", version: 1, bloc: "" }], catalogue: CATALOGUE, reponse: "### Méthode : Inconnue" }), []);
  });
});

// --- Bouton « Seconde lecture » -------------------------------------------------------------------------------------------------

describe("visibilité du bouton « Seconde lecture » (C §9.7)", () => {
  const base = { terminee: true, repere: false, estSecondeLecture: false };

  it("réponse terminée : le bouton est proposé", () => {
    assert.deepEqual(secondReadingButtonVisible(base), { visible: true, code: null });
  });

  it("réponse en cours : aucun bouton", () => {
    assert.deepEqual(secondReadingButtonVisible({ ...base, terminee: false }), { visible: false, code: "en-cours" });
  });

  it("message repère non facturé : aucun bouton, il n'y a rien à relire", () => {
    assert.deepEqual(secondReadingButtonVisible({ ...base, repere: true }), { visible: false, code: "repere" });
  });

  it("la relecture elle-même : aucun bouton", () => {
    assert.deepEqual(secondReadingButtonVisible({ ...base, estSecondeLecture: true }), { visible: false, code: "relecture" });
  });

  it("une relecture en cours reste exclue par sa qualité de relecture, avant même « en cours »", () => {
    assert.deepEqual(secondReadingButtonVisible({ terminee: false, repere: true, estSecondeLecture: true }), { visible: false, code: "relecture" });
  });
});

describe("libellé, infobulle et base de l'estimation (D-5-22)", () => {
  const BASES: SecondReadingEstimate["base"][] = ["conversation", "observe", "profil", "aucune"];

  it("libellé chiffré : « Seconde lecture (≈ {x} $) » pour chaque base qui donne un montant", () => {
    for (const valeur of BASES) {
      const montant = valeur === "aucune" ? null : "0,06";
      const libelle = secondReadingButtonLabel(montant);
      assert.equal(libelle, valeur === "aucune" ? "Seconde lecture" : "Seconde lecture (≈ 0,06 $)", valeur);
      assert.ok(!/au moins/i.test(libelle), `« au moins » interdit (${valeur})`);
      assert.ok(!/minimum/i.test(libelle), `« minimum » interdit (${valeur})`);
    }
  });

  it("aucun montant : le libellé perd sa parenthèse, jamais un chiffre inventé", () => {
    assert.equal(secondReadingButtonLabel(null), "Seconde lecture");
    assert.ok(!secondReadingButtonLabel(null).includes("{x}"));
  });

  it("une phrase de base par valeur, sauf « aucune » qui n'affiche aucun montant", () => {
    assert.equal(secondReadingBasePhrase("conversation"), "Estimation d'après la longueur actuelle de la conversation.");
    assert.equal(secondReadingBasePhrase("observe"), "Estimation d'après ses relectures précédentes.");
    assert.equal(secondReadingBasePhrase("profil"), "Estimation pour une conversation courte : une longue conversation coûte davantage.");
    assert.equal(secondReadingBasePhrase("aucune"), null);
  });

  it("infobulle : l'IA nommée, puis la phrase de la base, pour chaque base", () => {
    for (const valeur of BASES) {
      const texte = secondReadingTooltip(estimation({ base: valeur }));
      assert.ok(texte !== null, valeur);
      assert.ok(texte.includes("GPT-5 mini"), `IA nommée (${valeur})`);
      assert.ok(texte.includes("Il voit toute la conversation"), `base du coût (${valeur})`);
      const phrase = secondReadingBasePhrase(valeur);
      assert.equal(texte.endsWith(phrase ?? "conversation : le coût dépend de sa longueur."), true, valeur);
      assert.ok(!/au moins/i.test(texte), `« au moins » interdit (${valeur})`);
    }
  });

  it("aucune IA résolue : aucune infobulle, plutôt qu'une IA inventée", () => {
    assert.equal(secondReadingTooltip(estimation({ ia: null, usd: null, base: "aucune" })), null);
  });

  it("aucun gabarit ne porte « au moins » (D-5-22, contrôle des textes eux-mêmes)", () => {
    const textes = TEXTES.partout.secondeLecture;
    const toutes = [textes.bouton, textes.infobulle, textes.base.conversation, textes.base.observe, textes.base.profil, textes.pied];
    for (const phrase of toutes) assert.ok(!/au moins/i.test(phrase), phrase);
  });
});

describe("reconnaissance d'une seconde lecture et pied de la réponse", () => {
  const demande = secondReadingMessage("Analyser un incident");

  it("le message envoyé est le texte exact du §4.3, variante « reponse »", () => {
    assert.equal(demande, TEXTES.partout.secondeLecture.message.replace("{assistant}", "Analyser un incident"));
    assert.ok(demande.startsWith(secondReadingPrefix("reponse")));
  });

  it("une demande de seconde lecture est reconnue, une demande ordinaire ne l'est pas", () => {
    assert.equal(estDemandeDeSecondeLecture(demande), true);
    assert.equal(estDemandeDeSecondeLecture(TEXTES.partout.secondeLecture.messageEquipe.replace("{equipe}", "Revue SQL")), true);
    assert.equal(estDemandeDeSecondeLecture("Relis la réponse précédente, s'il te plaît."), false);
    assert.equal(estDemandeDeSecondeLecture(""), false);
  });

  it("même règle que le crochet du serveur, pour que l'interface reconnaisse les tours requalifiés", () => {
    for (const texte of [demande, "Relis la réponse précédente.", "", TEXTES.partout.secondeLecture.messageEquipe]) {
      assert.equal(estDemandeDeSecondeLecture(texte), estMessageDeSecondeLecture(texte), texte.slice(0, 40));
    }
  });

  it("pied affiché sous la réponse à une demande de seconde lecture, et nulle part ailleurs", () => {
    assert.equal(secondReadingFooter(demande), "Relecture par un autre assistant : elle ne remplace ni la relecture par un collègue ni le CAB.");
    assert.equal(secondReadingFooter("Analyse ce plan."), null);
    assert.equal(secondReadingFooter(null), null);
  });
});
