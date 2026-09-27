// Bande néon 2D du chat (spécification §5.7.4, §5.5, §5.6, §5.1, JP-13, JP-14, P12 ; plan d'exécution, fiche L5c) :
// - file d'affichage : au plus 4 rendus par seconde (rattrapage compris), un changement affiché au plus 2 s + 250 ms après son
//   arrivée, « Affichage rattrapé » annoncé 2 s puis retiré, aucun minuteur sans raison, figer et reprendre ;
// - repli par défaut (Simple repliée, Avancé dépliée), résumé d'une ligne et [Tableau] tirés de la scène (P12) ;
// - panneau du zoom 3 : textes masqués par redactSecrets PUIS coupés, parties ajoutées ou ignorées écartées, rendu échappé ;
// - mouvement : images clés sur opacity et transform seulement, terminées sur l'état statique, environ 900 ms ;
// - feuilles : jetons néon de styles.css identiques à la palette JP-14 (néon clair, néon sombre), neon.css sans animation ni
//   couleur écrite en clair, mini-carte sous 900 px, liste seule à 400 px (le résumé d'une ligne remplace la carte), couleurs
//   forcées sur tous les jetons ;
// - SVG aria-hidden au cadre 560 × 220 ; pureté du module.
// Chaque garde a son contrôle discriminant (un source ou un état fabriqué qui la ferait échouer).
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import { redactSecrets } from "./redact.ts";
import type { ActivityFact, ActivityFactKind, FactValue } from "./shared/activity-types.ts";
import {
  avancer,
  cheminDeLOutil,
  cible,
  couper,
  deplieeParDefaut,
  dossierDe,
  figer,
  fileNeuve,
  grille,
  hexagone,
  imagesCles,
  libelleNoeud,
  lignesTableau,
  NEON_ANNEAU,
  NEON_CENTRE,
  NEON_FILE_MAX_MS,
  NEON_RATTRAPE_MS,
  NEON_RENDU_MS,
  NEON_TEXTE_MAX,
  NEON_TRANSITION_MS,
  type NeonFile,
  type NeonTransition,
  nomAssistant,
  nomDeFichier,
  recevoir,
  resumeBande,
  segment,
  signesAssistant,
  texteDuMessage,
  versLExterieur,
} from "./shared/neon-band.ts";
import { neonCssVariables } from "./shared/neon-palette.ts";
import { NEON_CADRE, type NeonScene, scene } from "./shared/neon-scene.ts";
import { TEXTES, texteHorsBornes } from "./shared/neon-texts.ts";

const WEB_DIR = path.join(import.meta.dirname, "..", "web");
const BAND_TSX = path.join(WEB_DIR, "pages", "chat", "activity", "NeonBand.tsx");
const NEON_CSS = path.join(WEB_DIR, "pages", "chat", "activity", "neon.css");
const STYLES_CSS = path.join(WEB_DIR, "styles.css");

// --- File d'affichage ------------------------------------------------------------------------------------------------------------

interface Rendu {
  at: number;
  affiches: number;
  rattrape: boolean;
}

interface Simulation {
  rendus: Rendu[];
  /** Heure du premier affichage de chaque arrivée (null : jamais affichée). */
  affichees: Array<number | null>;
  /** État de l'annonce après chaque pas. */
  annonces: Array<{ at: number; visible: boolean }>;
  /** Minuteur encore planifié à la fin (null : plus rien à faire). */
  minuteur: number | null;
  file: NeonFile;
}

/**
 * Rejoue le crochet useAffichage de NeonBand.tsx sur une horloge simulée : chaque arrivée (heure, longueur de la liste) passe par
 * recevoir puis un pas replanifié ; chaque minuteur échu fait un pas. Arrivées triées par heure.
 */
function simuler(arrivees: ReadonlyArray<readonly [number, number]>): Simulation {
  let file = fileNeuve(0);
  let minuteur: number | null = null;
  const rendus: Rendu[] = [];
  const annonces: Array<{ at: number; visible: boolean }> = [];
  const affichees: Array<number | null> = arrivees.map(() => null);
  const noter = (at: number) => {
    arrivees.forEach(([, n], k) => {
      if (affichees[k] === null && file.affiches >= n) affichees[k] = at;
    });
  };
  const pas = (at: number) => {
    const avant = file;
    const r = avancer(file, at);
    file = r.file;
    if (file.affiches !== avant.affiches || r.rattrape) rendus.push({ at, affiches: file.affiches, rattrape: r.rattrape });
    annonces.push({ at, visible: file.rattrapage !== null });
    noter(at);
    minuteur = r.prochain;
  };
  let i = 0;
  for (let garde = 0; garde < 100_000; garde++) {
    const arrivee = arrivees[i];
    if (minuteur !== null && (arrivee === undefined || minuteur < arrivee[0])) {
      pas(minuteur);
      continue;
    }
    if (arrivee === undefined) break;
    i += 1;
    file = recevoir(file, arrivee[1], arrivee[0]);
    pas(arrivee[0]);
  }
  return { rendus, affichees, annonces, minuteur, file };
}

/** Rafale : une arrivée toutes les `ecart` ms pendant `duree` ms, la liste grandit d'un fait à chaque fois. */
const rafale = (ecart: number, duree: number, debut = 0): Array<[number, number]> =>
  Array.from({ length: Math.floor(duree / ecart) }, (_, k) => [debut + k * ecart, k + 1]);

describe("bande néon : file d'affichage", () => {
  it("liste lue d'un coup : affichée sans attente ; longueur invalide bornée à 0 ; rien à faire, aucun minuteur", () => {
    assert.deepEqual(fileNeuve(12), { affiches: 12, attente: [], dernierRendu: null, rattrapage: null, fige: false });
    for (const n of [-1, Number.NaN, 1.5, Number.MAX_VALUE]) assert.equal(fileNeuve(n).affiches, 0, String(n));
    const lue = fileNeuve(12);
    const pas = avancer(lue, 5_000);
    assert.equal(pas.file, lue, "rien ne change");
    assert.equal(pas.prochain, null);
    assert.equal(pas.rattrape, false);
    assert.equal(recevoir(lue, 12, 5_000), lue, "même longueur : rien en attente");
  });

  it("un changement à la fois, dans l'ordre, au plus un rendu par 250 ms", () => {
    let file = recevoir(fileNeuve(0), 1, 0);
    let pas = avancer(file, 0);
    assert.equal(pas.file.affiches, 1, "premier changement affiché tout de suite");
    assert.equal(pas.prochain, null);
    file = recevoir(recevoir(pas.file, 2, 50), 3, 60);
    pas = avancer(file, 60);
    assert.equal(pas.file.affiches, 1, "moins de 250 ms après le dernier rendu : rien");
    assert.equal(pas.prochain, NEON_RENDU_MS);
    pas = avancer(pas.file, NEON_RENDU_MS);
    assert.equal(pas.file.affiches, 2, "le changement suivant, pas le dernier");
    assert.equal(pas.prochain, 2 * NEON_RENDU_MS);
    pas = avancer(pas.file, 2 * NEON_RENDU_MS);
    assert.equal(pas.file.affiches, 3);
    assert.equal(pas.prochain, null, "plus rien n'attend : aucun minuteur");
  });

  it("rafale soutenue : jamais plus de 4 rendus par seconde, rattrapage compris ; chaque changement affiché en 2 s + 250 ms au plus", () => {
    for (const ecart of [40, 100, 180]) {
      const arrivees = rafale(ecart, 12_000);
      const s = simuler(arrivees);
      for (let k = 1; k < s.rendus.length; k++) {
        const ecartRendus = (s.rendus[k]?.at ?? 0) - (s.rendus[k - 1]?.at ?? 0);
        assert.ok(ecartRendus >= NEON_RENDU_MS, `écart ${ecart} : rendus ${k - 1} et ${k} séparés de ${ecartRendus} ms`);
      }
      arrivees.forEach(([at], k) => {
        const affichee = s.affichees[k];
        assert.ok(affichee !== null && affichee !== undefined, `écart ${ecart} : arrivée ${k} jamais affichée`);
        assert.ok(affichee - at <= NEON_FILE_MAX_MS + NEON_RENDU_MS, `écart ${ecart} : arrivée ${k} affichée après ${affichee - at} ms`);
      });
      assert.ok(s.rendus.some((r) => r.rattrape), `écart ${ecart} : la rafale déborde, un rattrapage est attendu`);
      assert.equal(s.file.affiches, arrivees.length, "tout finit affiché");
      assert.equal(s.minuteur, null, "fin de rafale : l'annonce retirée, aucun minuteur restant");
      assert.equal(s.annonces.at(-1)?.visible, false);
    }
  });

  it("rythme lent (au plus 4 changements par seconde) : chaque changement affiché à son arrivée, jamais de rattrapage", () => {
    const arrivees = rafale(NEON_RENDU_MS, 6_000);
    const s = simuler(arrivees);
    assert.equal(s.rendus.length, arrivees.length);
    assert.deepEqual(s.affichees, arrivees.map(([at]) => at));
    assert.equal(s.rendus.some((r) => r.rattrape), false);
  });

  it("rattrapage : file vidée d'un coup, annonce gardée 2 s malgré les rendus suivants (fait « affichage » renvoyé), puis retirée", () => {
    let file = recevoir(fileNeuve(0), 1, 0);
    file = avancer(file, 0).file;
    file = recevoir(file, 2, 10);
    file = recevoir(file, 5, 20);
    const vide = avancer(file, 10 + NEON_FILE_MAX_MS + 1);
    assert.equal(vide.rattrape, true);
    assert.equal(vide.file.affiches, 5, "tout d'un coup, jusqu'à la dernière liste reçue");
    assert.deepEqual(vide.file.attente, []);
    const r = 10 + NEON_FILE_MAX_MS + 1;
    assert.equal(vide.file.rattrapage, r);
    assert.equal(vide.prochain, r + NEON_RATTRAPE_MS, "un pas prévu pour retirer l'annonce");
    // Le fait « affichage » renvoyé par le serveur arrive 300 ms plus tard : rendu ordinaire, l'annonce reste.
    const suite = avancer(recevoir(vide.file, 6, r + 300), r + 300);
    assert.equal(suite.file.affiches, 6);
    assert.equal(suite.rattrape, false, "un rendu ordinaire n'est pas un nouveau rattrapage (rien à enregistrer)");
    assert.equal(suite.file.rattrapage, r, "annonce toujours affichée");
    assert.equal(suite.prochain, r + NEON_RATTRAPE_MS, "rien n'attend : prochain pas à la fin de l'annonce");
    const encore = avancer(suite.file, r + NEON_RATTRAPE_MS - 1);
    assert.equal(encore.file.rattrapage, r);
    const fin = avancer(suite.file, r + NEON_RATTRAPE_MS);
    assert.equal(fin.file.rattrapage, null, "2 s écoulées : annonce retirée");
    assert.equal(fin.prochain, null, "plus aucun minuteur");
  });

  it("horloge qui recule : le rendu n'est pas bloqué, l'annonce est retirée", () => {
    const file: NeonFile = { affiches: 1, attente: [{ faits: 2, depuis: 1_000 }], dernierRendu: 1_000, rattrapage: 1_000, fige: false };
    const pas = avancer(file, 400);
    assert.equal(pas.file.affiches, 2);
    assert.equal(pas.file.rattrapage, null);
    assert.equal(pas.rattrape, false);
  });

  it("liste raccourcie (relue) : affichée telle quelle, attente vidée", () => {
    let file = recevoir(fileNeuve(3), 4, 0);
    file = recevoir(file, 5, 10);
    const court = recevoir(file, 2, 20);
    assert.equal(court.affiches, 2);
    assert.deepEqual(court.attente, []);
    assert.equal(cible(court), 2);
    assert.equal(recevoir(court, 2, 30), court, "même longueur : rien de neuf");
  });

  it("figer : rien n'est rendu, la file garde la seule dernière cible, l'annonce est retirée ; reprendre montre le direct sans rattrapage", () => {
    let file: NeonFile = { affiches: 1, attente: [{ faits: 2, depuis: 0 }], dernierRendu: 0, rattrapage: 0, fige: false };
    file = figer(file, true, 100);
    assert.equal(file.fige, true);
    assert.equal(file.rattrapage, null);
    for (let k = 3; k < 50; k++) file = recevoir(file, k, 100 + k);
    assert.equal(file.attente.length, 1, "file bornée pendant le gel");
    assert.equal(cible(file), 49);
    const gele = avancer(file, 60_000);
    assert.equal(gele.file.affiches, 1, "figé : l'image ne bouge pas");
    assert.equal(gele.rattrape, false, "figé : jamais de rattrapage, même après 2 s");
    assert.equal(gele.prochain, null, "figé : aucun minuteur");
    assert.equal(figer(file, true, 60_000), file);
    const repris = figer(file, false, 60_000);
    assert.deepEqual(repris, { affiches: 49, attente: [], dernierRendu: 60_000, rattrapage: null, fige: false });
  });

  it("repli par défaut : Simple repliée (résumé d'une ligne), Avancé dépliée", () => {
    assert.equal(deplieeParDefaut("simple"), false);
    assert.equal(deplieeParDefaut("avance"), true);
  });
});

// --- Résumé, tableau et noms (P12) ----------------------------------------------------------------------------------------------

const R = "ses_racine";
const E1 = "ses_explore";
const E2 = "ses_inconnu";

class Histoire {
  readonly facts: ActivityFact[] = [];
  #at = 1_000;

  add(sessionId: string, kind: ActivityFactKind, data: Record<string, FactValue>, ref: string | null = null): this {
    this.#at += 10;
    this.facts.push({ rootId: R, sessionId, kind, ref, data, at: this.#at });
    return this;
  }
}

/** Demande, deux délégations du même message (explore, puis un assistant sans nom), l'une rendue, l'autre en attente d'accord. */
function histoire(avecAttente = true): ActivityFact[] {
  const h = new Histoire()
    .add(R, "origine", { origine: "demande", cas: 1, messageId: "msg_d" }, "msg_d")
    .add(R, "statut", { etat: "occupee" })
    .add(R, "consigne", { etat: "prepare", callId: "call_1", messageId: "msg_a" }, "call_1")
    .add(R, "consigne", { etat: "prepare", callId: "call_2", messageId: "msg_a" }, "call_2")
    .add(E1, "statut", { etat: "creee", role: "delegation", parent: R, agent: "explore", instance: "principale" })
    .add(R, "consigne", { etat: "envoyee", callId: "call_1", messageId: "msg_a", enfant: E1, agent: "explore", source: "ia", commande: null, reprise: false }, "call_1")
    .add(E1, "statut", { etat: "occupee" })
    .add(E2, "statut", { etat: "creee", role: "delegation", parent: R, agent: "", instance: "principale" })
    .add(R, "consigne", { etat: "envoyee", callId: "call_2", messageId: "msg_a", enfant: E2, agent: null, source: "ia", commande: null, reprise: false }, "call_2")
    .add(E2, "statut", { etat: "occupee" });
  if (avecAttente) h.add(E2, "attente", { permission: "bash", messageId: "msg_o", callId: "call_b", agent: null }, "per_1");
  h.add(R, "resultat", { etat: "rendu", callId: "call_1", messageId: "msg_x", enfant: E1 }, "call_1");
  return h.facts;
}

const AVANCE = { zoom: 2, mode: "avance" } as const;
const SIMPLE = { zoom: 2, mode: "simple" } as const;

/** Tous les libellés de signe que le tableau peut écrire. */
function libellesConnus(): Set<string> {
  const p = TEXTES.partout;
  const base = [...Object.values(p.signes), ...Object.values(p.origines), ...Object.values(TEXTES.avance.origines), p.memoireResumee];
  return new Set([...base, ...base.map((s) => `${s} (${p.enMemeTemps})`)]);
}

describe("bande néon : résumé, tableau et noms tirés de la scène (P12)", () => {
  it("rien à montrer tant qu'aucun fait ne dessine l'assistant de la conversation", () => {
    assert.equal(resumeBande(scene([], null, AVANCE)), null);
    assert.deepEqual(lignesTableau(scene([], null, AVANCE)), []);
  });

  it("Avancé : une ligne par assistant dessiné, dans l'ordre de la scène, noms, secteurs, états et signes en toutes lettres", () => {
    const vue = scene(histoire(), null, AVANCE);
    assert.equal(resumeBande(vue), "Assistant de la conversation, travaille");
    const lignes = lignesTableau(vue);
    assert.deepEqual(
      lignes.map((l) => l.sessionId),
      vue.noeuds.map((n) => n.sessionId),
    );
    assert.deepEqual(
      lignes.map((l) => [l.nom, l.secteur, l.etat, l.signes]),
      [
        ["Assistant de la conversation", null, "travaille", ["Votre demande"]],
        ["explore", "Chercher", "terminé", ["Résultat rendu"]],
        ["Assistant non identifié", "Autres", "en attente de votre accord", ["Consigne confiée (en même temps)", "En attente de votre accord"]],
      ],
    );
    const connus = libellesConnus();
    for (const l of lignes) for (const signe of l.signes) assert.ok(connus.has(signe), `${l.nom} : « ${signe} » n'est pas un libellé de signe`);
  });

  it("aucun signe sans fait : sans le fait d'attente, ni attente dans le tableau ni état « en attente »", () => {
    const vue = scene(histoire(false), null, AVANCE);
    const e2 = lignesTableau(vue).find((l) => l.sessionId === E2);
    assert.deepEqual(e2?.signes, ["Consigne confiée (en même temps)"]);
    assert.equal(e2?.etat, "travaille");
    assert.deepEqual(signesAssistant(vue, "ses_absente"), [], "assistant absent de la scène : aucun signe");
  });

  it("Simple : un seul assistant ; le travail confié avant le passage en Simple est dit dans le résumé, jamais dessiné", () => {
    const vue = scene(histoire(), null, SIMPLE);
    assert.deepEqual(
      lignesTableau(vue).map((l) => l.nom),
      ["Assistant de la conversation"],
    );
    assert.equal(resumeBande(vue), `Assistant de la conversation, travaille · ${TEXTES.simple.travailConfieHorsCarte}`);
  });

  it("noms : nom enregistré, sinon « Assistant de la conversation » ou « Assistant non identifié » ; bouton « {nom}, {état} »", () => {
    assert.equal(nomAssistant({ agent: "plan", role: "delegation" }), "plan");
    assert.equal(nomAssistant({ agent: null, role: "conversation" }), TEXTES.partout.assistantConversation);
    assert.equal(nomAssistant({ agent: "", role: "delegation" }), TEXTES.partout.assistantInconnu);
    assert.equal(libelleNoeud({ agent: null, role: "delegation", etat: "echec" }), "Assistant non identifié, échec");
  });

  it("assistants non dessinés (relecture 2ter-vague-4) : singulier pour un seul, pluriel au-delà ; la bande écrit cette phrase-là", () => {
    assert.equal(texteHorsBornes(1), "Déroulé partiel : 1 assistant non dessiné (plus de 3 niveaux ou de 50 assistants).");
    assert.equal(texteHorsBornes(2), "Déroulé partiel : 2 assistants non dessinés (plus de 3 niveaux ou de 50 assistants).");
    assert.equal(texteHorsBornes(11), "Déroulé partiel : 11 assistants non dessinés (plus de 3 niveaux ou de 50 assistants).");
    const source = fs.readFileSync(BAND_TSX, "utf8");
    assert.match(source, /texteHorsBornes\(vue\.horsBornes\)/);
    assert.doesNotMatch(source, /TEXTES\.partout\.horsBornes/, "le gabarit au pluriel n'est plus rempli à la main");
  });
});

// --- Panneau du zoom 3 -------------------------------------------------------------------------------------------------------------

/** Jeton GitHub factice, fabriqué (jamais écrit en clair) : son corps « Q7Q7… » est facile à chercher. */
const JETON = `ghp_${"Q7".repeat(18)}`;
const message = (id: string, parts: unknown[]) => ({ info: { id, role: "user" }, parts });

describe("bande néon : textes du panneau (zoom 3)", () => {
  it("masqué PUIS coupé : un secret à cheval sur la coupe ne laisse passer aucun morceau", () => {
    // Coupé d'abord à 600 caractères, le jeton n'aurait plus que 14 caractères après « ghp_ » : trop court pour être reconnu.
    const texte = `${"x".repeat(NEON_TEXTE_MAX - 20)} ${JETON} fin`;
    assert.equal(redactSecrets(couper(texte, NEON_TEXTE_MAX)).includes("Q7Q7Q7"), true, "contrôle : l'ordre inverse fuit");
    const lu = texteDuMessage([message("msg_1", [{ type: "text", text: texte }])], "msg_1");
    assert.ok(lu !== null);
    assert.equal(lu.includes("Q7Q7Q7"), false);
    assert.equal(lu.includes("ghp_Q"), false);
    assert.ok(Array.from(lu).length <= NEON_TEXTE_MAX);
  });

  it("texte coupé à 600 caractères au plus, avec « … » ; parties ajoutées par opencode, ignorées ou non textuelles écartées", () => {
    const long = texteDuMessage([message("msg_1", [{ type: "text", text: "a".repeat(2_000) }])], "msg_1");
    assert.equal(long?.length, NEON_TEXTE_MAX);
    assert.equal(long?.endsWith("…"), true);
    const parts = [
      { type: "text", text: "Consigne réelle." },
      { type: "text", text: "Ajouté par opencode", synthetic: true },
      { type: "text", text: "Ignoré", ignored: true },
      { type: "tool", callID: "call_1", state: { input: { filePath: "/a/b.ts" } } },
      { type: "text", text: "Suite." },
    ];
    assert.equal(texteDuMessage([message("msg_1", parts)], "msg_1"), "Consigne réelle.\n\nSuite.");
  });

  it("message absent, vide ou mal formé : null (le panneau dit « Texte indisponible. »)", () => {
    const messages = [null, 3, { info: null }, message("msg_vide", [{ type: "text", text: "   " }]), message("msg_sans", "x" as unknown as unknown[])];
    assert.equal(texteDuMessage(messages, "msg_absent"), null);
    assert.equal(texteDuMessage(messages, "msg_vide"), null);
    assert.equal(texteDuMessage(messages, "msg_sans"), null);
    assert.equal(texteDuMessage(messages, null), null);
    assert.equal(TEXTES.partout.texteIndisponible, "Texte indisponible.");
  });

  it("chemin d'une tuile : lu dans la partie d'outil, masqué ; absent ou d'une autre nature : null", () => {
    const messages = [
      message("msg_1", [
        { type: "tool", callID: "call_1", state: { input: { filePath: `/srv/depot/${JETON}.txt` } } },
        { type: "text", callID: "call_2", text: "/pas/un/outil" },
        { type: "tool", callID: "call_3", state: { input: { filePath: "" } } },
      ]),
    ];
    const chemin = cheminDeLOutil(messages, "call_1");
    assert.ok(chemin !== null);
    assert.equal(chemin.includes("Q7Q7Q7"), false);
    assert.equal(chemin.startsWith("/srv/depot/"), true);
    assert.equal(cheminDeLOutil(messages, "call_2"), null);
    assert.equal(cheminDeLOutil(messages, "call_3"), null);
    assert.equal(cheminDeLOutil(messages, "call_absent"), null);
  });

  it("coupe jamais au milieu d'un caractère ; noms de fichier et dossiers (séparateurs Windows, fin « / », racine)", () => {
    const coupe = couper("😀".repeat(10), 5);
    assert.equal(coupe, `${"😀".repeat(4)}…`);
    assert.equal(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(coupe), false);
    assert.equal(couper("court", 16), "court");
    assert.equal(nomDeFichier("C:\\depot\\src\\index.ts"), "index.ts");
    assert.equal(nomDeFichier("/a/b/dossier/"), "dossier");
    assert.equal(nomDeFichier("/a/un-nom-de-fichier-bien-trop-long.ts", 10), "un-nom-de…");
    assert.equal(dossierDe("C:\\depot\\src\\index.ts"), "C:/depot/src");
    assert.equal(dossierDe("/index.ts"), "/");
    assert.equal(dossierDe("index.ts"), "/");
  });

  it("rendu échappé : NeonBand.tsx n'écrit jamais de HTML (textes de l'IA, du fichier ou d'opencode rendus en texte)", () => {
    const source = code(fs.readFileSync(BAND_TSX, "utf8"));
    const interdits = checkHtml(source);
    assert.deepEqual(interdits, []);
    // Contrôle discriminant : un panneau qui injecterait le texte en HTML est refusé.
    assert.deepEqual(checkHtml('<dd dangerouslySetInnerHTML={{ __html: texte }} />; el.innerHTML = t; el.insertAdjacentHTML("beforeend", t);'), [
      "dangerouslySetInnerHTML",
      "innerHTML",
      "insertAdjacentHTML",
    ]);
  });
});

/** Écritures de HTML brut dans un source. */
function checkHtml(source: string): string[] {
  return ["dangerouslySetInnerHTML", "innerHTML", "outerHTML", "insertAdjacentHTML", "createContextualFragment", "DOMParser", "document.write"].filter((mot) =>
    new RegExp(`(?<![\\w$])${mot.replace(".", "\\.")}(?![\\w$])`).test(source),
  );
}

/** Source TS/TSX sans commentaires. */
function code(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`\\])\/\/.*$/gm, "$1");
}

// --- Mouvement et dessin -------------------------------------------------------------------------------------------------------------

describe("bande néon : mouvement (JP-13) et dessin", () => {
  it("images clés : opacity et transform seulement, deux images, la dernière est l'état statique", () => {
    const transitions: NeonTransition[] = ["apparition", "trait", "trajet", "changement"];
    for (const transition of transitions) {
      const images = imagesCles(transition, 12, -7);
      assert.equal(images.length, 2, transition);
      for (const image of images) for (const cle of Object.keys(image)) assert.ok(cle === "opacity" || cle === "transform", `${transition} : ${cle}`);
      const fin = images.at(-1);
      assert.equal(fin?.opacity, 1, transition);
      assert.ok(fin?.transform === undefined || /^(?:scale\(1\)|translate\(0px, 0px\))$/.test(fin.transform), `${transition} : ${fin?.transform}`);
    }
    assert.deepEqual(imagesCles("trajet", 12, -7)[0], { opacity: 0.2, transform: "translate(-12px, 7px)" });
    assert.ok(NEON_TRANSITION_MS >= 800 && NEON_TRANSITION_MS <= 1_000, "environ 900 ms");
  });

  it("NeonBand.tsx : SVG aria-hidden au cadre 560 × 220 ; une seule transition WAAPI, une itération, sous mouvement permis", () => {
    assert.deepEqual(NEON_CADRE, { largeur: 560, hauteur: 220 });
    const source = code(fs.readFileSync(BAND_TSX, "utf8"));
    const svgs = [...source.matchAll(/<svg\b[^>]*>/g)].map((m) => m[0]);
    assert.ok(svgs.length >= 2, "carte (zoom 2) et zoom 3");
    for (const svg of svgs) {
      assert.match(svg, /aria-hidden="true"/, svg);
      assert.match(svg, /viewBox=\{`0 0 \$\{L\} \$\{H\}`\}/, svg);
    }
    assert.match(source, /const L = NEON_CADRE\.largeur;/);
    assert.match(source, /const H = NEON_CADRE\.hauteur;/);
    const appels = [...source.matchAll(/\.animate\(([^;]*)\);/g)].map((m) => m[1] ?? "");
    assert.equal(appels.length, 1);
    assert.match(appels[0] ?? "", /duration: NEON_TRANSITION_MS/);
    assert.match(appels[0] ?? "", /iterations: 1\b/);
    assert.match(source, /const bouger = avant !== null && typeof svg\.animate === "function" && mouvementPermis\(\);/);
    assert.match(source, /matchMedia\("\(prefers-reduced-motion: no-preference\)"\)\.matches/);
  });

  it("« Affichage rattrapé » enregistré : un seul appel POST …/facts/affichage, sur le pas qui vide la file", () => {
    const source = code(fs.readFileSync(BAND_TSX, "utf8"));
    assert.equal([...source.matchAll(/activityApi\.affichage\(/g)].length, 1);
    assert.match(source, /if \(vide\) enregistrerRattrapage\(rootId\);/);
  });

  it("NeonBand.tsx : défaut selon le mode (et retour au défaut pour une autre conversation), file remise à neuf, pas replanifié à chaque réception", () => {
    const source = code(fs.readFileSync(BAND_TSX, "utf8"));
    const gardes: Array<[RegExp, string]> = [
      [/useState\(\(\) => deplieeParDefaut\(mode\)\)/, "repli par défaut selon le mode"],
      [/const contexte = `\$\{mode\}\|\$\{rootId\}`;/, "contexte : mode et conversation"],
      [/if \(contexteVu !== contexte\) \{[^}]*setDeplie\(deplieeParDefaut\(mode\)\);[^}]*setFocus\(null\);[^}]*setFige\(false\);/, "autre contexte : défaut, carte, direct"],
      [/if \(!actif \|\| racine\.current !== rootId\) \{[^}]*file\.current = fileNeuve\(facts\.length\);/, "autre conversation : liste lue d'un coup"],
      [/arreter\(\);\s*pas\(\);\s*\}, \[rootId, facts, actif, arreter, pas\]\);/, "pas replanifié à chaque réception"],
      [/const bouger = avant !== null/, "rien au premier rendu"],
    ];
    for (const [re, garde] of gardes) assert.match(source, re, garde);
    // Contrôle discriminant : l'ancien « pas seulement sans minuteur » laisserait un changement attendre la fin d'une annonce (2 s).
    assert.doesNotMatch(source, /if \(minuteur\.current === null\) pas\(\);/);
    const file = avancer(recevoir({ affiches: 3, attente: [], dernierRendu: 0, rattrapage: 0, fige: false }, 4, 300), 300);
    assert.equal(file.file.affiches, 4, "pendant une annonce, un changement est rendu à son créneau, sans attendre la fin de l'annonce");
  });

  it("NeonBand.tsx, ActivityRegion.tsx : une demande ne replie jamais la carte en mode Avancé ; en Simple seulement, repliée d'office tant qu'elle attend (sauf focus dans la carte), rendue ensuite ; votre choix l'emporte", () => {
    // Clôture de l'itération 1 (revue de l'itération, rg-reel-7 en échec sur opencode 1.18.30 réel) : la correction de la répétition
    // générale repliait la carte à CHAQUE demande, en Avancé aussi (modification, commande, délégation) ; l'attente de votre accord
    // (§5.7.1) et la préparation en pointillé fixe (§5.7.3) ne se voyaient plus sans clic. Le repli d'office ne passe plus que par
    // repliPourLaDemande, calculé par ActivityRegion avec replierPendantLaDemande (useActivity.ts : jamais en Avancé ; comportement
    // vérifié dans activity-live.test.ts). La place de la carte pendant une demande en Avancé : croisements-it1-v4 (sources) et e2e
    // it1-ui-delegation, it1-ui-mise-en-page (navigateur).
    const source = code(fs.readFileSync(BAND_TSX, "utf8"));
    const gardes: Array<[RegExp, string]> = [
      [/repliPourLaDemande = false \}: NeonBandProps\)/, "propriété facultative, fausse par défaut"],
      [/if \(contexteVu !== contexte\) \{[^}]*setReplieeDOffice\(false\);\s*setAttenteVue\(false\);\s*\} else if \(attenteVue !== repliPourLaDemande\) \{/, "autre contexte : repli d'office oublié, demande relue au rendu suivant"],
      [/const focusDansLaBande = bandeRef\.current\?\.contains\(document\.activeElement\) === true;/, "focus clavier dans la bande entière : pas de repli"],
      [/if \(repliPourLaDemande && deplie && !focusDansLaBande\) \{\s*setReplieeDOffice\(true\);\s*setDeplie\(false\);\s*setFocus\(null\);\s*\}/, "repli d'office d'une carte dépliée (Simple)"],
      [/else if \(!repliPourLaDemande && replieeDOffice\) \{\s*setDeplie\(true\);\s*setReplieeDOffice\(false\);\s*\}/, "demande réglée : carte dépliée de nouveau"],
      [/const basculerRepli = \(\) => \{[^}]*setReplieeDOffice\(false\);/, "votre choix l'emporte sur le repli d'office"],
      [/<section className="neon-band"[^>]*\sref=\{bandeRef\}>/, "bande entière suivie pour le focus, boîtes de la barre de commandes comprises"],
      [/<div className="neon-body" id=\{corpsId\}>/, "corps de la carte : plus de ref propre, le focus est lu sur la bande"],
    ];
    for (const [re, garde] of gardes) assert.match(source, re, garde);
    // Contrôles discriminants : la bande ne lit aucune demande elle-même (ni propriété « demande en attente », ni lignes d'acteurs), et
    // ne se replie d'office qu'à un seul endroit, celui de repliPourLaDemande.
    assert.doesNotMatch(source, /demandeEnAttente|rows\.some/, "NeonBand n'obéit qu'à repliPourLaDemande");
    assert.equal([...source.matchAll(/setDeplie\(false\)/g)].length, 1, "un seul repli d'office");
    const region = code(fs.readFileSync(path.join(WEB_DIR, "pages", "chat", "activity", "ActivityRegion.tsx"), "utf8"));
    assert.match(region, /const repliPourLaDemande = replierPendantLaDemande\(advanced, activity\.rows\);/, "repli calculé avec le mode");
    assert.match(region, /<NeonBand[^>]*\srepliPourLaDemande=\{repliPourLaDemande\}\s*\/>/, "bande : repli de la seule règle");
    assert.match(region, /<WhoIsWorking[^>]*\srepliPourLaDemande=\{repliPourLaDemande\}/, "« Qui travaille ? » : repli de la seule règle");
    assert.doesNotMatch(region, /demandeEnAttente=\{|permissionId !== null/, "aucune demande brute passée aux composants");
  });

  it("NeonBand.tsx : le repli d'office lit le focus sur la BANDE, jamais sur le seul corps (une boîte de la barre de commandes n'est pas démontée)", () => {
    // Corrections de la relecture 3-vague-1 : [Revoir cette demande] (L28b) ouvre une boîte modale rendue dans .neon-head >
    // .neon-commands, donc HORS de .neon-body. Tant que le garde-fou du repli n'interrogeait que le corps, une demande d'autorisation
    // qui survient en mode Simple repliait la bande, démontait la boîte ouverte et laissait le focus retomber sur <body>
    // (spécification §5.5 : « focus jamais volé ni perdu »).
    const source = code(fs.readFileSync(BAND_TSX, "utf8"));

    /** Nom du `ref` interrogé par le calcul du repli, et élément qui le porte : les deux doivent être la bande. */
    const refDuRepli = (src: string): { lu: string | null; porteParLaBande: string | null; porteParLeCorps: string | null } => ({
      lu: /const focusDansLa\w+ = (\w+)\.current\?\.contains\(document\.activeElement\)/.exec(src)?.[1] ?? null,
      porteParLaBande: /<section className="neon-band"[^>]*\sref=\{(\w+)\}/.exec(src)?.[1] ?? null,
      porteParLeCorps: /<div className="neon-body"[^>]*\sref=\{(\w+)\}/.exec(src)?.[1] ?? null,
    });

    const reel = refDuRepli(source);
    assert.notEqual(reel.lu, null, "le calcul du repli lit bien un ref");
    assert.equal(reel.lu, reel.porteParLaBande, "le ref interrogé est celui de <section className=\"neon-band\">");
    assert.equal(reel.porteParLeCorps, null, ".neon-body ne porte plus de ref : le focus se lit sur la bande entière");
    // La boîte de « Revoir » est bien à l'intérieur de la section, dans la barre de commandes : le garde-fou la couvre donc.
    assert.match(source, /<section className="neon-band"[\s\S]*<div className="neon-commands">[\s\S]*<BandCommands3d\b/);

    // DISCRIMINANT : la variante fautive (ref du seul corps) est vue comme un manquement.
    const fautif = source
      .replace(/const bandeRef = useRef<HTMLElement>\(null\);/, "const corpsRef = useRef<HTMLDivElement>(null);")
      .replace(/const focusDansLaBande = bandeRef\./, "const focusDansLaCarte = corpsRef.")
      .replace(/<section className="neon-band"([^>]*)\sref=\{bandeRef\}>/, "<section className=\"neon-band\"$1>")
      .replace(/<div className="neon-body" id=\{corpsId\}>/, "<div className=\"neon-body\" id={corpsId} ref={corpsRef}>");
    const variante = refDuRepli(fautif);
    assert.equal(variante.lu, "corpsRef");
    assert.equal(variante.porteParLaBande, null, "source fabriqué : la bande ne porte aucun ref");
    assert.equal(variante.porteParLeCorps, "corpsRef", "source fabriqué : seul le corps est suivi — c'est le manquement");
    assert.notEqual(variante.lu, variante.porteParLaBande);
  });

  it("géométrie : mêmes centre et anneaux que la scène ; grille sans boucle sans fin ; segments, hexagones, trait vers l'extérieur", () => {
    const vue: NeonScene = scene(histoire(), null, AVANCE);
    const racine = vue.noeuds.find((n) => n.role === "conversation");
    assert.deepEqual(racine?.position, { x: NEON_CENTRE.x, y: NEON_CENTRE.y });
    const places = vue.noeuds.filter((n) => n.role === "delegation" && n.place === 0 && !n.empile);
    assert.ok(places.length >= 2);
    for (const n of places) {
      const ex = (n.position.x - NEON_CENTRE.x) / (NEON_ANNEAU.rx * n.anneau);
      const ey = (n.position.y - NEON_CENTRE.y) / (NEON_ANNEAU.ry * n.anneau);
      assert.ok(Math.abs(ex * ex + ey * ey - 1) < 0.02, `${n.sessionId} hors de l'anneau ${n.anneau}`);
    }
    const g = grille(560, 220);
    assert.equal(g.split("M").length - 1, 27 + 10);
    for (const pas of [0, -5, Number.NaN, 0.5]) assert.equal(grille(560, 220, pas), "", `pas ${pas}`);
    assert.equal(segment({ x: 0, y: 0 }, { x: 10, y: 0 }, 5, 5), null);
    assert.deepEqual(segment({ x: 0, y: 0 }, { x: 100, y: 0 }, 10, 20), { a: { x: 10, y: 0 }, b: { x: 80, y: 0 } });
    assert.equal(hexagone({ x: 0, y: 0 }, 10).split(" ").length, 6);
    assert.deepEqual(versLExterieur(NEON_CENTRE, NEON_CENTRE, 10), { x: 288.9, y: 105.5 });
  });
});

// --- Feuilles de style -------------------------------------------------------------------------------------------------------------

interface Declaration {
  prop: string;
  value: string;
  blocks: string[];
}

/** Déclarations CSS (commentaires écartés) avec les en-têtes des blocs qui les contiennent. */
function declarations(css: string): Declaration[] {
  const text = css.replace(/\/\*[\s\S]*?\*\//g, "");
  const out: Declaration[] = [];
  const stack: string[] = [];
  let buffer = "";
  const flush = () => {
    const match = /^\s*([\w-]+)\s*:([\s\S]*)$/.exec(buffer);
    if (match && stack.length > 0) out.push({ prop: (match[1] ?? "").toLowerCase(), value: (match[2] ?? "").trim(), blocks: [...stack] });
  };
  for (const c of text) {
    if (c === "{") {
      stack.push(buffer.trim().replace(/\s+/g, " "));
      buffer = "";
    } else if (c === ";" || c === "}") {
      flush();
      if (c === "}") stack.pop();
      buffer = "";
    } else {
      buffer += c;
    }
  }
  return out;
}

/** Jetons --neon-* par contexte (en-têtes de blocs joints par « > »). */
function neonTokens(css: string): Map<string, Record<string, string>> {
  const out = new Map<string, Record<string, string>>();
  for (const d of declarations(css)) {
    if (!d.prop.startsWith("--neon-")) continue;
    const contexte = d.blocks.join(" > ");
    out.set(contexte, { ...(out.get(contexte) ?? {}), [d.prop]: d.value });
  }
  return out;
}

const SOMBRE_MEDIA = '@media (prefers-color-scheme: dark) > :root:not([data-theme="light"])';
const SOMBRE_FORCE = ':root[data-theme="dark"]';

/** Écarts entre les jetons de styles.css et la palette JP-14 (vide si copie exacte). */
function tokenProblems(css: string): string[] {
  const attendu = new Map([
    [":root", neonCssVariables("clair")],
    [SOMBRE_MEDIA, neonCssVariables("sombre")],
    [SOMBRE_FORCE, neonCssVariables("sombre")],
  ]);
  const lus = neonTokens(css);
  const problems: string[] = [];
  for (const contexte of lus.keys()) if (!attendu.has(contexte)) problems.push(`jetons dans un bloc inattendu : ${contexte}`);
  for (const [contexte, jetons] of attendu) {
    const trouve = lus.get(contexte) ?? {};
    for (const [nom, valeur] of Object.entries(jetons)) if (trouve[nom] !== valeur) problems.push(`${contexte} ${nom} : ${trouve[nom] ?? "absent"} au lieu de ${valeur}`);
    for (const nom of Object.keys(trouve)) if (!(nom in jetons)) problems.push(`${contexte} ${nom} : jeton hors palette`);
  }
  return problems;
}

const SYSTEM_COLORS = /^(?:Canvas|CanvasText|GrayText|Highlight|HighlightText|LinkText|ButtonText|ButtonFace|ButtonBorder|Mark|MarkText|AccentColor|AccentColorText)$/;
const COLOR_PROPS = new Set(["color", "fill", "stroke", "background", "background-color", "border", "border-color", "outline", "outline-color", "box-shadow"]);
const LITERAL_COLOR = /#[0-9a-f]{3,8}\b|\b(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch|color)\(/i;

/** Manquements de neon.css (vide si la feuille tient ses règles). */
function neonCssProblems(css: string): string[] {
  const problems: string[] = [];
  const decls = declarations(css);
  const jetons = Object.keys(neonCssVariables("sombre"));
  if (/@keyframes\b/i.test(css.replace(/\/\*[\s\S]*?\*\//g, ""))) problems.push("@keyframes");
  for (const d of decls) {
    const ou = `${d.blocks.join(" > ")} { ${d.prop} }`;
    if (/^(?:animation|transition)(?:-|$)/.test(d.prop)) problems.push(`mouvement CSS : ${ou}`);
    if (COLOR_PROPS.has(d.prop) && LITERAL_COLOR.test(d.value)) problems.push(`couleur écrite en clair : ${ou} ${d.value}`);
    for (const m of d.value.matchAll(/var\((--neon-[\w-]+)/g)) if (!jetons.includes(m[1] ?? "")) problems.push(`jeton inconnu : ${m[1]}`);
  }
  const dans = (media: string, selecteur: string, prop: string) =>
    decls.find((d) => d.blocks[0] === media && d.blocks[1] === selecteur && d.prop === prop)?.value ?? null;
  const mini = "@media (max-width: 899.98px)";
  if (dans(mini, ".neon-nodes", "display") !== "none") problems.push("sous 900 px : boutons posés sur la carte non masqués");
  if (dans(mini, ".neon-map", "height") === null) problems.push("sous 900 px : pas de mini-carte");
  if (dans("@media (max-width: 400px)", ".neon-map-wrap", "display") !== "none") problems.push("à 400 px : la carte n'est pas retirée");
  const resumeDeplie = decls.find((d) => d.blocks.length === 1 && d.blocks[0] === ".neon-summary.is-deplie" && d.prop === "display")?.value;
  if (resumeDeplie !== "none" || dans("@media (max-width: 400px)", ".neon-summary.is-deplie", "display") !== "block") {
    problems.push("résumé d'une ligne : masqué quand la carte est dépliée, affiché à 400 px à sa place");
  }
  const force = "@media (forced-colors: active)";
  if (dans(force, ".neon-map", "forced-color-adjust") !== "none") problems.push("couleurs forcées : la carte ne garde pas ses couleurs système");
  for (const jeton of jetons) {
    const valeur = dans(force, ".neon-band", jeton);
    if (valeur === null || !SYSTEM_COLORS.test(valeur)) problems.push(`couleurs forcées : ${jeton} = ${valeur ?? "absent"}`);
  }
  for (const d of decls.filter((x) => x.blocks[0] === force)) {
    if (/var\(--neon-/.test(d.value)) problems.push(`couleurs forcées : jeton néon lu dans ${d.blocks.join(" > ")}`);
  }
  return problems;
}

describe("bande néon : feuilles de style", () => {
  it("styles.css : jetons néon clair (:root) et néon sombre (préférence du système et thème forcé), copie exacte de la palette JP-14", () => {
    const css = fs.readFileSync(STYLES_CSS, "utf8");
    assert.deepEqual(tokenProblems(css), []);
    // Contrôles discriminants : une couleur changée, un jeton oublié dans le thème forcé.
    assert.deepEqual(tokenProblems(css.replace("--neon-consigne: #C2187A;", "--neon-consigne: #E0409A;")), [":root --neon-consigne : #E0409A au lieu de #C2187A"]);
    const sansForce = css.replace(/(:root\[data-theme="dark"\] \{[^}]*?)\s*--neon-arret: #6B778A;/, "$1");
    assert.notEqual(sansForce, css);
    assert.deepEqual(tokenProblems(sansForce), [`${SOMBRE_FORCE} --neon-arret : absent au lieu de #6B778A`]);
  });

  it("neon.css : aucun mouvement CSS, aucune couleur en clair, mini-carte sous 900 px, liste seule à 400 px, couleurs forcées sur tous les jetons", () => {
    const css = fs.readFileSync(NEON_CSS, "utf8");
    assert.deepEqual(neonCssProblems(css), []);
  });

  it("neon.css : contrôles discriminants (transition, couleur en clair, jeton inconnu, largeurs, couleurs forcées)", () => {
    const css = fs.readFileSync(NEON_CSS, "utf8");
    const cas: Array<[string, string, string]> = [
      [".neon-halo {", ".neon-halo {\n  transition: opacity 0.9s;", "mouvement CSS : .neon-halo { transition }"],
      [".neon-halo {", ".neon-halo {\n  stroke: #2EE6FF;", "couleur écrite en clair : .neon-halo { stroke } #2EE6FF"],
      ["fill: var(--neon-arret);", "fill: var(--neon-gris);", "jeton inconnu : --neon-gris"],
      ["  .neon-nodes {\n    display: none;\n  }", "", "sous 900 px : boutons posés sur la carte non masqués"],
      ["@media (max-width: 400px) {\n  .neon-map-wrap {\n    display: none;", "@media (max-width: 400px) {\n  .neon-map-wrap {\n    display: block;", "à 400 px : la carte n'est pas retirée"],
      ["  .neon-summary.is-deplie {\n    display: block;\n  }\n", "", "résumé d'une ligne : masqué quand la carte est dépliée, affiché à 400 px à sa place"],
      ["    --neon-consigne: CanvasText;\n", "", "couleurs forcées : --neon-consigne = absent"],
      ["    --neon-auto: CanvasText;", "    --neon-auto: var(--neon-auto);", "couleurs forcées : --neon-auto = var(--neon-auto)"],
    ];
    for (const [avant, apres, attendu] of cas) {
      const mute = css.replace(avant, apres);
      assert.notEqual(mute, css, avant);
      assert.ok(neonCssProblems(mute).includes(attendu), `${attendu} : ${neonCssProblems(mute).join(" | ")}`);
    }
  });
});

// --- Pureté ----------------------------------------------------------------------------------------------------------------------

describe("bande néon : pureté de neon-band.ts", () => {
  it("ni module node, ni process, ni horloge, ni aléa, ni réseau ; imports voisins et masquage seulement", () => {
    const source = fs.readFileSync(path.join(import.meta.dirname, "shared", "neon-band.ts"), "utf8");
    assert.equal(source.includes('"node:'), false);
    assert.equal(/\bprocess\./.test(source), false);
    assert.equal(/\bDate\.now\b|new Date\b|Math\.random|\bfetch\s*\(|\bsetTimeout\b|\bsetInterval\b|\bperformance\.|\bcrypto\./.test(source), false);
    const imports = [...source.matchAll(/\bfrom\s*["']([^"']+)["']/g)].map((m) => m[1] ?? "");
    for (const spec of imports) assert.ok(spec === "../redact.ts" || /^\.\/[\w.-]+\.ts$/.test(spec), spec);
  });

  it("même entrée, même sortie ; la liste des faits et la file ne sont jamais modifiées", () => {
    const facts = histoire();
    const copie = JSON.stringify(facts);
    const vue = scene(facts, null, AVANCE);
    assert.deepEqual(lignesTableau(vue), lignesTableau(scene(facts, null, AVANCE)));
    assert.equal(JSON.stringify(facts), copie);
    const file = Object.freeze({ affiches: 1, attente: Object.freeze([{ faits: 2, depuis: 0 }]), dernierRendu: 0, rattrapage: null, fige: false });
    assert.doesNotThrow(() => {
      avancer(file, 10);
      avancer(file, 5_000);
      recevoir(file, 7, 10);
      figer(file, true, 10);
    });
  });
});
