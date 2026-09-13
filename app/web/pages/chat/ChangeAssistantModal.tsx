// Confirmation d'un changement d'assistant au milieu d'une conversation.
import { Button, Modal } from "../../components/ui.tsx";

export interface ChangeAssistantTarget {
  name: string;
  /** « Claude Sonnet 5 · Équilibré » */
  ia: string | null;
  /** « 0,18 $ » */
  cost: string | null;
}

export function ChangeAssistantModal({
  target,
  onChange,
  onNewConversation,
  onCancel,
}: {
  target: ChangeAssistantTarget | null;
  onChange: () => void;
  onNewConversation: () => void;
  onCancel: () => void;
}) {
  const ia = target?.ia ? ` (${target.ia}${target.cost ? `, ≈ ${target.cost} par demande` : ""})` : "";
  return (
    <Modal
      open={target !== null}
      title="Changer d'assistant dans cette conversation ?"
      onClose={onCancel}
      footer={
        <>
          <Button onClick={onCancel}>Annuler</Button>
          <Button onClick={onNewConversation}>Nouvelle conversation</Button>
          <Button variant="primary" onClick={onChange}>
            Changer d'assistant
          </Button>
        </>
      }
    >
      <p className="secondary">
        Le nouvel assistant reprend l'historique avec ses propres droits et son IA{ia}. Pour repartir de zéro, créez une nouvelle conversation.
      </p>
    </Modal>
  );
}
