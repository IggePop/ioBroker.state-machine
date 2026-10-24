import React, { useEffect, useMemo, useRef } from "react";
import { Compartment, EditorState } from "@codemirror/state";
import { EditorView, keymap, placeholder as placeholderExtension } from "@codemirror/view";
import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import { bracketMatching, defaultHighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { javascript } from "@codemirror/lang-javascript";
import { forceLinting, linter } from "@codemirror/lint";
import { autocompletion, closeBrackets, closeBracketsKeymap, completionKeymap } from "@codemirror/autocomplete";
import { oneDarkHighlightStyle } from "@codemirror/theme-one-dark";
import { Box, Typography, useTheme } from "@mui/material";
import { I18n } from "@iobroker/adapter-react-v5";

/**
 * @typedef {import("../../../lib/chart-validation").Diagnostic} Diagnostic
 */

/**
 * Translates a diagnostic, the English message is used if there is no translation
 *
 * @param {Diagnostic} diagnostic
 * @returns {string}
 */
export function translateDiagnostic(diagnostic) {
    // I18n.t returns the key itself if it is unknown, the key contains %s placeholders
    return I18n.t(/** @type {any} */ (diagnostic.key), ...diagnostic.args);
}

/**
 * @param {import("@mui/material").Theme} theme
 * @param {number} minRows
 */
export function createTheme(theme, minRows) {
    const dark = theme.palette.mode === "dark";
    return [
        EditorView.theme(
            {
                "&": {
                    fontSize: "13px",
                    backgroundColor: theme.palette.background.paper,
                    color: theme.palette.text.primary,
                    border: `1px solid ${theme.palette.divider}`,
                    borderRadius: "4px",
                },
                "&.cm-focused": {
                    outline: `2px solid ${theme.palette.primary.main}`,
                    outlineOffset: "-1px",
                },
                ".cm-content": {
                    fontFamily: "monospace",
                    minHeight: `${minRows * 1.4 + 0.8}em`,
                    caretColor: theme.palette.text.primary,
                },
                ".cm-line": { lineHeight: "1.4" },
                ".cm-cursor": { borderLeftColor: theme.palette.text.primary },
                ".cm-placeholder": { color: theme.palette.text.disabled },
                ".cm-tooltip": {
                    backgroundColor: theme.palette.background.paper,
                    color: theme.palette.text.primary,
                    border: `1px solid ${theme.palette.divider}`,
                },
            },
            { dark },
        ),
        syntaxHighlighting(dark ? oneDarkHighlightStyle : defaultHighlightStyle),
    ];
}

/**
 * Code input with JavaScript syntax highlighting, underlined errors and completion of variable names
 *
 * @param {object} props
 * @param {string} props.label
 * @param {string} props.value
 * @param {(value: string) => void} props.onChange
 * @param {(text: string) => Diagnostic[]} props.validate
 * @param {{ label: string; detail?: string }[]} props.completions
 * @param {string} [props.placeholder]
 * @param {string} [props.helperText] Shown if there are no problems
 * @param {number} [props.minRows]
 */
export default function CodeEditor({
    label,
    value,
    onChange,
    validate,
    completions,
    placeholder,
    helperText,
    minRows = 2,
}) {
    const theme = useTheme();
    const container = useRef(/** @type {HTMLDivElement | null} */ (null));
    const view = useRef(/** @type {EditorView | null} */ (null));
    const themeCompartment = useRef(new Compartment());

    // the extensions are created once, they read the current props through this ref
    const props = useRef({ onChange, validate, completions });
    props.current = { onChange, validate, completions };

    useEffect(() => {
        const editor = new EditorView({
            parent: /** @type {HTMLDivElement} */ (container.current),
            state: EditorState.create({
                doc: value,
                extensions: [
                    history(),
                    closeBrackets(),
                    bracketMatching(),
                    javascript(),
                    keymap.of([...closeBracketsKeymap, ...defaultKeymap, ...historyKeymap, ...completionKeymap]),
                    placeholderExtension(placeholder || ""),
                    EditorView.lineWrapping,
                    autocompletion({
                        override: [
                            context => {
                                const word = context.matchBefore(/[\w$]+/);
                                if (!word || (word.from === word.to && !context.explicit)) {
                                    return null;
                                }
                                return {
                                    from: word.from,
                                    options: props.current.completions.map(c => ({ ...c, type: "variable" })),
                                };
                            },
                        ],
                    }),
                    linter(
                        v => {
                            const length = v.state.doc.length;
                            return props.current.validate(v.state.doc.toString()).map(d => ({
                                from: Math.min(d.from, length),
                                to: Math.min(d.to, length),
                                severity: d.severity,
                                message: translateDiagnostic(d),
                            }));
                        },
                        { delay: 300 },
                    ),
                    EditorView.updateListener.of(update => {
                        if (update.docChanged) {
                            props.current.onChange(update.state.doc.toString());
                        }
                    }),
                    themeCompartment.current.of(createTheme(theme, minRows)),
                ],
            }),
        });
        view.current = editor;
        return () => editor.destroy();
        // the editor is created only once, changes of the props are applied by the effects below
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    // e.g. another state was selected
    useEffect(() => {
        const editor = view.current;
        if (editor && editor.state.doc.toString() !== value) {
            editor.dispatch({ changes: { from: 0, to: editor.state.doc.length, insert: value } });
        }
    }, [value]);

    useEffect(() => {
        view.current?.dispatch({ effects: themeCompartment.current.reconfigure(createTheme(theme, minRows)) });
    }, [theme, minRows]);

    // check again if e.g. a variable was added
    useEffect(() => {
        if (view.current) {
            forceLinting(view.current);
        }
    }, [validate]);

    const diagnostics = useMemo(() => validate(value), [validate, value]);

    return (
        <Box className="nokey">
            <Typography
                variant="caption"
                color="text.secondary"
                component="div"
                sx={{ mb: 0.5 }}
            >
                {label}
            </Typography>
            <div ref={container} />
            {diagnostics.length ? (
                diagnostics.map((d, i) => (
                    <Typography
                        key={i}
                        variant="caption"
                        component="div"
                        color={d.severity === "error" ? "error" : "warning.main"}
                        sx={{ mt: 0.5 }}
                    >
                        {translateDiagnostic(d)}
                    </Typography>
                ))
            ) : helperText ? (
                <Typography
                    variant="caption"
                    component="div"
                    color="text.secondary"
                    sx={{ mt: 0.5 }}
                >
                    {helperText}
                </Typography>
            ) : null}
        </Box>
    );
}
