// Course « vérifier puis renommer » de la quarantaine (relecture 2ter-vague-4, constat L23c) : ce que la salle pouvait faire dans
// une entrée ouverte en écriture (A16) quand le cockpit mettait un `.git` en quarantaine AVANT l'arrêt. Depuis le second tour de
// la relecture, la quarantaine suit l'arrêt et la relance de la salle ; l'échange reste simulé pour prouver cet ordre et le second
// rempart de `renommerSansSuivreLiens`. Au moment choisi, un dossier du chemin est déplacé à côté et remplacé par une jonction (un
// lien symbolique hors Windows) vers un autre dossier, par exemple un autre projet dont le `.git` est protégé.
//
// Le moment est un `lstat` : celui du premier nom dont le nom de base commence par `declencheur`. `renommerSansSuivreLiens` ne
// `lstat` un nom de destination (`.git.suspect-…`) qu'APRÈS toutes ses vérifications du chemin : c'est la fenêtre du constat.
// Contenus synthétiques, rien hors du dossier reçu.
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import type { TestContext } from "node:test";

export interface EchangeParLien {
  /** Vrai une fois l'échange fait. */
  fait(): boolean;
}

/**
 * Au premier `lstat` (fs/promises) d'un chemin dont le nom de base commence par `declencheur` : `racine/dossier` est renommé en
 * `racine/dossier-avant`, puis `racine/dossier` devient une jonction vers `racine/cible`. Le `lstat` demandé est fait APRÈS
 * l'échange. Le faux `lstat` est retiré à la fin du test (t.mock).
 */
export function echangerParLienAuLstat(t: TestContext, racine: string, declencheur: string, dossier: string, cible: string): EchangeParLien {
  const lstatReel = fsp.lstat;
  let fait = false;
  const faux = async (...args: unknown[]): Promise<unknown> => {
    if (!fait && path.basename(String(args[0])).startsWith(declencheur)) {
      fait = true;
      fs.renameSync(path.join(racine, dossier), path.join(racine, `${dossier}-avant`));
      fs.symlinkSync(path.join(racine, cible), path.join(racine, dossier), "junction");
    }
    return Reflect.apply(lstatReel, fsp, args);
  };
  t.mock.method(fsp, "lstat", faux as never);
  return { fait: () => fait };
}
