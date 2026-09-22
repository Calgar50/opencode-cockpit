// Propriétaire : L40a.
// Installation d'un exemple d'équipe (spécification §5.3 l.896 ; C §9.10) : la liste du déroulé installé, la phrase des
// assistants posés en plus (« Installe aussi : l'assistant « {nom} ». Relisez-le avec votre équipe. »), puis [Installer].
// L'appel est POST /api/teams/examples/:id/install (L37a). Un 409 de la GARDE DE RECHARGEMENT (`sessions-busy`,
// `redemarrage-en-cours`, `reponses-non-verifiables`) est expliqué par le TEXTE EXISTANT de la garde, rendu TEL QUEL : T4t
// n'écrit aucun texte pour ces codes (texteRefus de teams-tab-model.ts).
// Aucun texte écrit ici ; aucune écriture n'est possible en mode Simple fermé, où la galerie n'est pas montée (U1).
import { useEffect, useState } from "react";
import { Icon } from "../../../components/Icon.tsx";
import { Button, Modal } from "../../../components/ui.tsx";
import { errorText } from "../../../lib/api.ts";
import { teamError, teamsApi } from "../../../lib/api-teams.ts";
import type { TeamExampleView, TeamView } from "../../../lib/types.ts";
import { FlowList } from "./FlowList.tsx";
import { FlowSchema } from "./FlowSchema.tsx";
import { installationDe, texteRefus } from "./teams-tab-model.ts";

export interface TeamInstallDialogProps {
  /** Exemple à installer ; null : boîte fermée. */
  exemple: TeamExampleView | null;
  onClose: () => void;
  /** Installation acceptée : l'onglet relit la liste des équipes. */
  onInstalled: (team: TeamView) => void;
}

export function TeamInstallDialog({ exemple, onClose, onInstalled }: TeamInstallDialogProps) {
  const [busy, setBusy] = useState(false);
  const [refus, setRefus] = useState<string | null>(null);

  useEffect(() => {
    setRefus(null);
    setBusy(false);
  }, [exemple?.id]);

  if (exemple === null) return null;
  const modele = installationDe(exemple);

  const installer = async () => {
    setBusy(true);
    setRefus(null);
    try {
      const reponse = await teamsApi.installExample(exemple.id);
      onInstalled(reponse.team);
      onClose();
    } catch (err) {
      setRefus(texteRefus(teamError(err), errorText(err)));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open
      wide
      title={modele.titre}
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>{modele.annuler}</Button>
          <Button variant="primary" icon="download" loading={busy} onClick={() => void installer()}>
            {modele.installer}
          </Button>
        </>
      }
    >
      <div className="stack">
        <p className="secondary">{exemple.description}</p>
        <FlowList liste={exemple.liste} libelle={modele.libelleSchema} schema={<FlowSchema layout={exemple.layout} />} toujoursVisible />
        {modele.aussi ? (
          <p className="callout tm-installation-aussi">
            <Icon name="bot" size={18} />
            <span>{modele.aussi}</span>
          </p>
        ) : null}
        {refus ? (
          <p className="callout critical tm-installation-refus" role="alert">
            <Icon name="alert" size={18} />
            <span>{refus}</span>
          </p>
        ) : null}
      </div>
    </Modal>
  );
}
