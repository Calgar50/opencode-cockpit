// Tests L28c, annonces des légendes de « Revoir » (spécification §5.5 l.920, §5.8 l.999-1002 ; plan d'exécution it3, fiche L28c,
// D-3d-29, constat 11) : le texte annoncé vient de la fonction PURE annonceLegende (web/pages/salle-controle/revoir/
// annonces-revoir.ts), et il passe par l'Announcer de web/lib/announcer.ts, donc par la région UNIQUE de la page.
// - ANNONCES COUPÉES → AUCUNE ÉCRITURE : l'Announcer est monté sur des dépendances factices (horloge, minuteries, write espion) ;
//   setEnabled(false) (réglage ui.activityAnnouncements à faux), puis toutes les légendes de la capture p1 → `write` n'est jamais
//   appelé, et aucune minuterie ne reste posée.
// - Témoin : les mêmes annonces, setEnabled(true) → au moins une écriture, et jamais deux à moins de 2 s.
// Aucun DOM, aucun React : annonceLegende est testable sous Node, et c'est ce que la fiche demande.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { annonceLegende } from "../web/pages/salle-controle/revoir/annonces-revoir.ts";
import { Announcer } from "../web/lib/announcer.ts";
import { ANNOUNCE_MIN_INTERVAL_MS } from "./shared/activity.ts";
import { legendesAuMoment } from "./shared/legendes.ts";
import { moments, type NeonMode } from "./shared/neon-scene.ts";
import { TEXTES as LEGENDES } from "./shared/legendes-texts.ts";
import { DEMO_P1_CAPTURE, DEMO_P1_ROOT, DEMO_P1_SENT, demoFacts } from "./test-support/gen-demo.ts";

const T0 = 1_700_000_000_000;

/** Horloge manuelle : `advance` exécute les minuteries échues dans l'ordre (même forme que activity-live.test.ts). */
class HorlogeFactice {
  t = T0;
  #seq = 0;
  minuteries: Array<{ id: number; at: number; fn: () => void }> = [];
  readonly now = () => this.t;
  readonly setTimer = (fn: () => void, ms: number) => {
    const id = ++this.#seq;
    this.minuteries.push({ id, at: this.t + ms, fn });
    return id;
  };
  readonly clearTimer = (handle: unknown) => {
    this.minuteries = this.minuteries.filter((minuterie) => minuterie.id !== handle);
  };
  advance(ms: number): void {
    const fin = this.t + ms;
    for (;;) {
      const due = this.minuteries.filter((minuterie) => minuterie.at <= fin).sort((a, b) => a.at - b.at || a.id - b.id)[0];
      if (!due) break;
      this.minuteries = this.minuteries.filter((minuterie) => minuterie !== due);
      this.t = due.at;
      due.fn();
    }
    this.t = fin;
  }
}

function environnement() {
  const horloge = new HorlogeFactice();
  const ecrites: Array<{ at: number; texte: string }> = [];
  const announcer = new Announcer({
    now: horloge.now,
    setTimer: horloge.setTimer,
    clearTimer: horloge.clearTimer,
    write: (texte) => ecrites.push({ at: horloge.t, texte }),
  });
  return { horloge, ecrites, announcer };
}

const FAITS = demoFacts(DEMO_P1_CAPTURE, DEMO_P1_ROOT, DEMO_P1_SENT);

/** Annonces de TOUTES les légendes de p1, à chacun de ses moments, dans les deux modes. */
function annoncesDeP1(mode: NeonMode, salle: boolean): string[] {
  const out: string[] = [];
  for (const t of moments(FAITS)) {
    for (const legende of legendesAuMoment(FAITS, t, { salle })) out.push(annonceLegende(legende.cles, mode));
  }
  return out;
}

describe("annonces des légendes : texte pur (annonceLegende)", () => {
  it("les phrases sont celles de legendes-texts.ts, réunies par une espace ; aucune clé connue → chaîne vide", () => {
    assert.equal(annonceLegende(["neuf"], "simple"), LEGENDES.partout.neuf);
    assert.equal(annonceLegende(["reprise", "carnet"], "avance"), `${LEGENDES.partout.reprise} ${LEGENDES.partout.carnet}`);
    // Garde d'honnêteté de phrasesLegende : « ne voit pas votre conversation » n'est jamais dite sur une reprise (spéc. l.1169).
    assert.equal(annonceLegende(["neuf", "reprise"], "simple"), LEGENDES.partout.reprise);
    assert.equal(annonceLegende(["relance"], "simple"), LEGENDES.simple.relance);
    assert.equal(annonceLegende(["relance"], "avance"), LEGENDES.avance.relance);
    assert.equal(annonceLegende([], "simple"), "");
  });

  it("la capture p1 produit bien des annonces, sinon la garde ne prouverait rien", () => {
    const annonces = annoncesDeP1("simple", true);
    assert.ok(annonces.length >= 2, `${annonces.length} annonces`);
    assert.ok(
      annonces.some((texte) => texte !== ""),
      "aucune phrase",
    );
  });
});

describe("annonces coupées → aucune écriture (D-3d-29, constat 11)", () => {
  it("setEnabled(false) : toutes les légendes de p1 ne posent ni écriture, ni minuterie", () => {
    const { horloge, ecrites, announcer } = environnement();
    announcer.setEnabled(false);
    for (const texte of annoncesDeP1("simple", true)) {
      announcer.say(texte);
      horloge.advance(250);
    }
    horloge.advance(60_000);
    assert.deepEqual(ecrites, []);
    assert.deepEqual(horloge.minuteries, []);
  });

  it("coupées en cours de route : ce qui attendait est oublié, rien n'est dit ensuite", () => {
    const { horloge, ecrites, announcer } = environnement();
    const annonces = annoncesDeP1("avance", true).filter((texte) => texte !== "");
    announcer.say(annonces[0] ?? "");
    announcer.say(annonces[1] ?? "");
    announcer.setEnabled(false);
    horloge.advance(60_000);
    // Seule la première annonce, dite avant la coupure, a pu être écrite.
    assert.ok(ecrites.length <= 1, JSON.stringify(ecrites));
    const avant = ecrites.length;
    for (const texte of annonces) announcer.say(texte);
    horloge.advance(60_000);
    assert.equal(ecrites.length, avant);
  });

  it("TÉMOIN : setEnabled(true) : au moins une écriture, jamais deux à moins de 2 s", () => {
    const { horloge, ecrites, announcer } = environnement();
    announcer.setEnabled(true);
    for (const texte of annoncesDeP1("simple", true)) {
      announcer.say(texte);
      horloge.advance(250);
    }
    horloge.advance(60_000);
    assert.ok(ecrites.length >= 1, "aucune annonce écrite alors qu'elles sont activées");
    for (let i = 1; i < ecrites.length; i++) {
      assert.ok((ecrites[i]?.at ?? 0) - (ecrites[i - 1]?.at ?? 0) >= ANNOUNCE_MIN_INTERVAL_MS, JSON.stringify(ecrites.map((e) => e.at - T0)));
    }
    for (const ecrite of ecrites) assert.notEqual(ecrite.texte.trim(), "");
  });
});
