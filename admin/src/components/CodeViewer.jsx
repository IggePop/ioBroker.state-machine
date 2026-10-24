import React, { useEffect, useRef } from "react";
import { Compartment, EditorState } from "@codemirror/state";
import { EditorView, highlightActiveLine, lineNumbers } from "@codemirror/view";
import { bracketMatching, foldGutter } from "@codemirror/language";
import { javascript } from "@codemirror/lang-javascript";
import { useTheme } from "@mui/material";
import { createTheme } from "./CodeEditor";

/**
 * Read only code with syntax highlighting and line numbers. The text can be selected and copied.
 *
 * @param {object} props
 * @param {string} props.value
 */
export default function CodeViewer({ value }) {
    const theme = useTheme();
    const container = useRef(/** @type {HTMLDivElement | null} */ (null));
    const view = useRef(/** @type {EditorView | null} */ (null));
    const themeCompartment = useRef(new Compartment());

    useEffect(() => {
        const viewer = new EditorView({
            parent: /** @type {HTMLDivElement} */ (container.current),
            state: EditorState.create({
                doc: value,
                extensions: [
                    EditorState.readOnly.of(true),
                    lineNumbers(),
                    foldGutter(),
                    highlightActiveLine(),
                    bracketMatching(),
                    javascript(),
                    themeCompartment.current.of(createTheme(theme, 1)),
                ],
            }),
        });
        view.current = viewer;
        return () => viewer.destroy();
        // the viewer is created only once, changes of the props are applied by the effects below
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    useEffect(() => {
        const viewer = view.current;
        if (viewer && viewer.state.doc.toString() !== value) {
            viewer.dispatch({ changes: { from: 0, to: viewer.state.doc.length, insert: value } });
        }
    }, [value]);

    useEffect(() => {
        view.current?.dispatch({ effects: themeCompartment.current.reconfigure(createTheme(theme, 1)) });
    }, [theme]);

    return (
        <div
            ref={container}
            className="nokey"
        />
    );
}
