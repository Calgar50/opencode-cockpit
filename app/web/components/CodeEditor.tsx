// Éditeur CodeMirror 6 (Markdown ou JSON), thème suivant celui de l'interface.
import { json } from "@codemirror/lang-json";
import { markdown } from "@codemirror/lang-markdown";
import { Compartment, EditorState } from "@codemirror/state";
import { oneDark } from "@codemirror/theme-one-dark";
import { EditorView } from "@codemirror/view";
import { basicSetup } from "codemirror";
import { useEffect, useRef } from "react";

export function CodeEditor({
  value,
  onChange,
  language = "markdown",
  minHeight = 260,
  maxHeight,
  readOnly = false,
  dark = false,
  ariaLabel,
}: {
  value: string;
  onChange?: (value: string) => void;
  language?: "markdown" | "json";
  minHeight?: number;
  maxHeight?: number;
  readOnly?: boolean;
  dark?: boolean;
  ariaLabel?: string;
}) {
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  const theme = useRef(new Compartment());

  useEffect(() => {
    if (!host.current) return;
    const editor = new EditorView({
      parent: host.current,
      state: EditorState.create({
        doc: value,
        extensions: [
          basicSetup,
          language === "json" ? json() : markdown(),
          EditorView.lineWrapping,
          EditorState.readOnly.of(readOnly),
          theme.current.of(dark ? oneDark : []),
          EditorView.contentAttributes.of(ariaLabel ? { "aria-label": ariaLabel } : {}),
          EditorView.theme({
            "&": { minHeight: `${minHeight}px`, ...(maxHeight ? { maxHeight: `${maxHeight}px` } : {}) },
            ".cm-scroller": { minHeight: `${minHeight}px` },
          }),
          EditorView.updateListener.of((update) => {
            if (update.docChanged) onChangeRef.current?.(update.state.doc.toString());
          }),
        ],
      }),
    });
    view.current = editor;
    return () => {
      editor.destroy();
      view.current = null;
    };
    // Recréé uniquement si la nature de l'éditeur change ; la valeur est synchronisée plus bas.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [language, readOnly, minHeight, maxHeight]);

  useEffect(() => {
    const editor = view.current;
    if (editor && editor.state.doc.toString() !== value) {
      editor.dispatch({ changes: { from: 0, to: editor.state.doc.length, insert: value } });
    }
  }, [value]);

  useEffect(() => {
    view.current?.dispatch({ effects: theme.current.reconfigure(dark ? oneDark : []) });
  }, [dark]);

  return <div className="code-editor" ref={host} />;
}
