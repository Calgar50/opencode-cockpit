// « Compléter » un agent créé avant 0.2 (§13) : titre, type de tâche et taille, sans réécrire son fichier.
import { useEffect, useId, useState } from "react";
import { DRAFT_LIMITS, TASK_SIZE_HINT, TASK_SIZE_LABELS, TASK_SIZES, USE_CASE_INFO, USE_CASES } from "../../../server/shared/assistant-rules.ts";
import { Icon } from "../../components/Icon.tsx";
import { useToast } from "../../components/Toast.tsx";
import { Button, Field, Modal } from "../../components/ui.tsx";
import { api } from "../../lib/api.ts";
import { openAssistants } from "../../lib/router.ts";
import type { TaskSize, ToCompleteItem, UseCase } from "../../lib/types.ts";
import { assistantErrorText } from "./errors.ts";
import { IdentityCard, identityOfToComplete } from "./IdentityCard.tsx";
import { humanizeName } from "./templates.ts";

export function AdoptDialog({ item, onClose, onDone }: { item: ToCompleteItem | null; onClose: () => void; onDone: () => void }) {
  const toast = useToast();
  const ids = { title: useId(), useCase: useId(), size: useId() };
  const [title, setTitle] = useState("");
  const [useCase, setUseCase] = useState<UseCase>("autre");
  const [taskSize, setTaskSize] = useState<TaskSize>("M");
  const [attempted, setAttempted] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);

  useEffect(() => {
    if (!item) return;
    setTitle(humanizeName(item.name).slice(0, DRAFT_LIMITS.titleMax));
    setUseCase("autre");
    setTaskSize("M");
    setAttempted(false);
    setError(null);
    // Réinitialisation à l'ouverture d'un autre agent seulement.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [item?.name]);

  const trimmed = title.trim();
  const titleError =
    trimmed.length < DRAFT_LIMITS.titleMin
      ? "Donnez un nom à l'assistant (3 caractères au moins)."
      : trimmed.length > DRAFT_LIMITS.titleMax
        ? `Le nom est trop long (${DRAFT_LIMITS.titleMax} caractères au plus).`
        : null;

  const submit = async () => {
    setAttempted(true);
    if (!item || titleError) return;
    setBusy(true);
    setError(null);
    try {
      const view = await api.adoptAssistant(item.name, { title: trimmed, useCase, taskSize });
      toast.success("Assistant complété", `« ${view.title} » apparaît maintenant dans vos assistants.`);
      onDone();
      onClose();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open={item !== null}
      wide
      title={item ? `Compléter « ${item.name} »` : ""}
      onClose={onClose}
      footer={
        item ? (
          <>
            <Button variant="ghost" icon="edit" onClick={() => openAssistants({ mode: "completer", name: item.name })}>
              Réécrire avec l'assistant de création
            </Button>
            <span className="spacer" />
            <Button onClick={onClose}>Annuler</Button>
            <Button variant="primary" icon="check" loading={busy} onClick={() => void submit()}>
              Compléter
            </Button>
          </>
        ) : null
      }
    >
      {item ? (
        <div className="stack">
          <p className="secondary">
            « {item.name} » a été créé avant la version 0.2. Donnez-lui un titre pour le retrouver parmi vos assistants. Son fichier n'est pas
            modifié : son IA et ses droits restent ceux d'aujourd'hui.
          </p>
          <Field label="Nom de l'assistant" htmlFor={ids.title} hint="Un verbe et une tâche. C'est ce que vous verrez dans le chat." error={attempted ? titleError : null}>
            <input id={ids.title} className="input" value={title} maxLength={DRAFT_LIMITS.titleMax} onChange={(e) => setTitle(e.target.value)} />
          </Field>
          <div className="grid-2">
            <Field label="Type de tâche" htmlFor={ids.useCase} hint={USE_CASE_INFO[useCase].hint || undefined}>
              <select id={ids.useCase} className="select" value={useCase} onChange={(e) => setUseCase(e.target.value as UseCase)}>
                {USE_CASES.map((uc) => (
                  <option key={uc} value={uc}>
                    {USE_CASE_INFO[uc].label}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Taille habituelle des demandes" htmlFor={ids.size} hint={TASK_SIZE_HINT}>
              <select id={ids.size} className="select" value={taskSize} onChange={(e) => setTaskSize(e.target.value as TaskSize)}>
                {TASK_SIZES.map((size) => (
                  <option key={size} value={size}>
                    {TASK_SIZE_LABELS[size]}
                  </option>
                ))}
              </select>
            </Field>
          </div>
          <IdentityCard data={identityOfToComplete(item, trimmed || item.name)} />
          {error ? (
            <div className="callout critical" role="alert">
              <Icon name="alert" size={18} />
              <span>{assistantErrorText(error)}</span>
            </div>
          ) : null}
        </div>
      ) : null}
    </Modal>
  );
}
