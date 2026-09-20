// Magasins partagés de la construction (itération 5, fiche L44e ; corrections de la relecture de 5a V2) : le catalogue des
// méthodes (`catalogue-store.ts`) et la Seconde lecture d'une conversation (`second-reading-store.ts`).
//
// Les deux magasins vivent au niveau du MODULE, au-dessus de React : ils survivent au démontage de la page de chat, alors que
// leur abonnement au flux, lui, est lâché dès que le dernier abonné part. Tout ce qui arrive pendant ce creux est perdu. Ces
// tests rejouent exactement ce creux — abonner, désabonner, réabonner — et exigent une relecture au retour :
// - catalogue : sans elle, une méthode attachée à l'assistant depuis la page Assistants n'était pas vue au retour dans le chat,
//   la ligne restait cochable et le bloc partait une seconde fois dans le message (L44e, « Déjà appliquée par l'assistant. ») ;
// - seconde lecture : sans elle, l'estimation affichée était celle d'avant la longue réponse (§13.2, « le coût dépend de la
//   longueur de la conversation »), et l'occupation lue au flux pouvait rester bloquée.
//
// S'y ajoute `studio.changed` pour la seconde lecture : le Relecteur peut être supprimé pendant que la conversation est ouverte.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { MethodsResponse, MethodView, SecondReadingEstimate } from "./shared/construction-types.ts";
import type { BrowserEvent } from "../web/lib/types.ts";
import { creerMagasinCatalogue } from "../web/pages/chat/methods/catalogue-store.ts";
import { MagasinSecondeLecture, creerTableMagasins } from "../web/pages/chat/methods/second-reading-store.ts";

/** Laisse tourner les promesses déjà résolues des magasins (leurs lectures ne sont pas attendues par l'appelant). */
const vidange = () => new Promise((resolve) => setImmediate(resolve));

/** Flux du cockpit simulé : le test pousse les événements, et compte les abonnements pour voir le creux. */
function flux() {
  const ecouteurs = new Set<(event: BrowserEvent) => void>();
  let abonnements = 0;
  return {
    get abonnes(): number {
      return ecouteurs.size;
    },
    get abonnements(): number {
      return abonnements;
    },
    abonnerFlux(ecouter: (event: BrowserEvent) => void): () => void {
      abonnements++;
      ecouteurs.add(ecouter);
      return () => ecouteurs.delete(ecouter);
    },
    emettre(event: BrowserEvent): void {
      for (const ecouteur of [...ecouteurs]) ecouteur(event);
    },
  };
}

const methode = (id: string, utiliseePar: { name: string; title: string }[] = []): MethodView => ({
  id,
  version: 1,
  titre: id,
  phrase: "phrase",
  quand: "quand",
  attention: "attention",
  kind: "consigne",
  bloc: "bloc",
  enTete: `### Méthode : ${id}`,
  sources: [],
  utiliseePar,
  conseilleePour: [],
});

const reponse = (methods: MethodView[]): MethodsResponse => ({ methods, limites: { parMessage: 2, parAssistant: 2, parEtape: 2 } });

// --- Catalogue des méthodes -----------------------------------------------------------------------------------------------------

describe("magasin du catalogue des méthodes (L44e)", () => {
  it("une seule lecture pour plusieurs abonnés, et une relecture à chaque retour dans le chat", async () => {
    const f = flux();
    let lectures = 0;
    let courant = [methode("pre-mortem")];
    const magasin = creerMagasinCatalogue({ lire: async () => (lectures++, reponse(courant)), abonnerFlux: f.abonnerFlux });

    // Premier montage du chat : deux vues (la puce et une bulle) s'abonnent, une seule lecture part.
    const puce = magasin.abonner(() => undefined);
    const bulle = magasin.abonner(() => undefined);
    await vidange();
    assert.equal(lectures, 1, "une lecture par vue : le catalogue n'est plus partagé");
    assert.equal(f.abonnes, 1, "un abonnement au flux par vue");
    assert.deepEqual(magasin.instantane().map((m) => m.id), ["pre-mortem"]);

    // On quitte le chat : les deux vues sont démontées, le flux est lâché.
    puce();
    bulle();
    assert.equal(f.abonnes, 0, "le flux reste tenu alors que plus personne n'écoute");

    // Pendant ce temps, la méthode est attachée à « build » depuis la page Assistants. Le `studio.changed` du serveur passe
    // sans personne pour l'écouter : c'est le creux que la relecture au retour doit rattraper.
    courant = [methode("pre-mortem", [{ name: "build", title: "Assistant général" }])];
    f.emettre({ kind: "cockpit", type: "studio.changed", data: null });
    await vidange();
    assert.equal(lectures, 1, "une lecture est partie alors que plus personne n'écoutait");

    // Retour dans le chat.
    const retour = magasin.abonner(() => undefined);
    await vidange();
    assert.equal(lectures, 2, "le catalogue n'est pas relu au retour dans le chat : « Déjà appliquée » serait contournée");
    assert.deepEqual(magasin.instantane()[0]?.utiliseePar.map((a) => a.name), ["build"]);
    retour();
  });

  it("abonné, le magasin relit sur studio.changed et sur stream.reconnected, et prévient ses abonnés", async () => {
    const f = flux();
    let lectures = 0;
    const magasin = creerMagasinCatalogue({ lire: async () => (lectures++, reponse([methode("certitude")])), abonnerFlux: f.abonnerFlux });
    let avis = 0;
    const stop = magasin.abonner(() => avis++);
    await vidange();
    assert.equal(lectures, 1);
    const avisApresLecture = avis;

    f.emettre({ kind: "cockpit", type: "studio.changed", data: null });
    await vidange();
    assert.equal(lectures, 2);
    f.emettre({ kind: "cockpit", type: "stream.reconnected", data: null });
    await vidange();
    assert.equal(lectures, 3);
    // Un événement qui ne concerne pas le catalogue ne déclenche rien.
    f.emettre({ kind: "cockpit", type: "budget.alert", data: null });
    await vidange();
    assert.equal(lectures, 3);
    assert.ok(avis > avisApresLecture, "les abonnés ne sont pas prévenus des relectures");
    stop();
  });

  it("lecture en échec : catalogue VIDE, jamais un catalogue inventé, et la relecture suivante le rétablit", async () => {
    const f = flux();
    let echouer = true;
    const avertissements: string[] = [];
    const magasin = creerMagasinCatalogue({
      lire: async () => {
        if (echouer) throw new Error("réseau coupé");
        return reponse([methode("pre-mortem")]);
      },
      abonnerFlux: f.abonnerFlux,
      avertir: (message) => avertissements.push(message),
    });
    const stop = magasin.abonner(() => undefined);
    await vidange();
    assert.deepEqual(magasin.instantane(), []);
    assert.equal(avertissements.length, 1);
    echouer = false;
    f.emettre({ kind: "cockpit", type: "studio.changed", data: null });
    await vidange();
    assert.deepEqual(magasin.instantane().map((m) => m.id), ["pre-mortem"]);
    stop();
  });
});

// --- Seconde lecture ------------------------------------------------------------------------------------------------------------

const estimation = (patch: Partial<SecondReadingEstimate> = {}): SecondReadingEstimate => ({
  installe: true,
  assistant: { name: "relecteur-critique", title: "Relecteur critique" },
  ia: { model: "github-copilot/gpt-5-mini", libelle: "GPT-5 mini" },
  usd: 0.01,
  base: "conversation",
  ...patch,
});

const idle = (sessionID: string): BrowserEvent => ({ kind: "opencode", event: { type: "session.idle", properties: { sessionID } } });
const statut = (sessionID: string, type: string): BrowserEvent => ({
  kind: "opencode",
  event: { type: "session.status", properties: { sessionID, status: { type } } },
});

describe("magasin de la Seconde lecture (L44e)", () => {
  it("estimation redemandée au retour dans la conversation, après un session.idle passé sans personne", async () => {
    const f = flux();
    const montants = [0.01, 0.42];
    let lectures = 0;
    const magasin = new MagasinSecondeLecture("ses_1", {
      estimer: async () => estimation({ usd: montants[Math.min(lectures++, montants.length - 1)] ?? null }),
      abonnerFlux: f.abonnerFlux,
    });

    const stop = magasin.abonner(() => undefined, "/travail");
    await vidange();
    assert.equal(lectures, 1);
    assert.equal(magasin.etat.estimation?.usd, 0.01);
    assert.equal(magasin.etat.lue, true);

    // On part sur la page Coûts pendant que la longue réponse travaille : le flux est lâché.
    stop();
    assert.equal(f.abonnes, 0);
    f.emettre(idle("ses_1"));
    await vidange();
    assert.equal(lectures, 1, "une lecture est partie alors que plus personne n'écoutait");

    // Retour dans la conversation : la réponse est terminée, la conversation s'est allongée, le montant doit suivre.
    const retour = magasin.abonner(() => undefined, "/travail");
    await vidange();
    assert.equal(lectures, 2, "l'estimation n'est pas redemandée au retour : le montant affiché est celui d'avant la réponse");
    assert.equal(magasin.etat.estimation?.usd, 0.42);
    retour();
  });

  it("occupation lue au flux : oubliée à la reprise, jamais gardée d'une visite à l'autre", async () => {
    const f = flux();
    const magasin = new MagasinSecondeLecture("ses_2", { estimer: async () => estimation(), abonnerFlux: f.abonnerFlux });
    const stop = magasin.abonner(() => undefined, "/travail");
    await vidange();
    assert.equal(magasin.etat.occupee, false);

    f.emettre(statut("ses_2", "busy"));
    assert.equal(magasin.etat.occupee, true, "une réponse en cours devrait désactiver le bouton");

    // On quitte : le `session.status` de fin passera sans personne.
    stop();
    f.emettre(statut("ses_2", "idle"));
    const retour = magasin.abonner(() => undefined, "/travail");
    await vidange();
    assert.equal(magasin.etat.occupee, false, "le bouton reste inactif sur une occupation qui n'a plus de source");
    retour();
  });

  it("Relecteur supprimé pendant la conversation : studio.changed relit, et l'état repasse à « non installé »", async () => {
    const f = flux();
    let installe = true;
    const magasin = new MagasinSecondeLecture("ses_3", {
      estimer: async () => (installe ? estimation() : estimation({ installe: false, assistant: null, ia: null, usd: null, base: "aucune" })),
      abonnerFlux: f.abonnerFlux,
    });
    const stop = magasin.abonner(() => undefined, "/travail");
    await vidange();
    assert.equal(magasin.etat.estimation?.installe, true);

    // L'utilisateur supprime le Relecteur depuis la page Assistants : le serveur publie `studio.changed`.
    installe = false;
    f.emettre({ kind: "cockpit", type: "studio.changed", data: null });
    await vidange();
    assert.equal(magasin.etat.estimation?.installe, false, "l'estimation survit à la disparition du Relecteur : le bouton d'envoi reste affiché");
    stop();
  });

  it("session.idle d'une AUTRE conversation : rien n'est relu", async () => {
    const f = flux();
    let lectures = 0;
    const magasin = new MagasinSecondeLecture("ses_4", { estimer: async () => (lectures++, estimation()), abonnerFlux: f.abonnerFlux });
    const stop = magasin.abonner(() => undefined, "/travail");
    await vidange();
    assert.equal(lectures, 1);
    f.emettre(idle("ses_autre"));
    await vidange();
    assert.equal(lectures, 1);
    f.emettre(idle("ses_4"));
    await vidange();
    assert.equal(lectures, 2);
    stop();
  });

  it("table des magasins : une entrée par conversation, gardée entre deux visites", () => {
    const f = flux();
    const magasinDe = creerTableMagasins({ estimer: async () => estimation(), abonnerFlux: f.abonnerFlux });
    const premier = magasinDe("ses_5");
    assert.equal(magasinDe("ses_5"), premier, "deux magasins pour une même conversation : deux estimations");
    assert.notEqual(magasinDe("ses_6"), premier);
  });
});
