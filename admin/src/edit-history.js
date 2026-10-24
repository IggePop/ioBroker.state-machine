import { useCallback, useRef, useState } from "react";

/** Maximum number of steps which can be undone */
const MAX_STEPS = 100;

/** Changes with the same key within this time are one step, e.g. typing in a field */
const MERGE_MS = 1000;

/**
 * @template T
 * @typedef {object} HistoryEntry
 * @property {T} document The edited document before/after a change
 * @property {number} version Identifies the document, used to know if it is the saved one
 */

/**
 * @template T
 * @typedef {object} History
 * @property {HistoryEntry<T>[]} past
 * @property {HistoryEntry<T>[]} future
 * @property {number} version Of the current document
 * @property {number} savedVersion
 * @property {number} nextVersion
 * @property {string | null} lastKey Key of the last recorded change
 * @property {number} lastTime Time of the last recorded change
 */

/**
 * @template T
 * @returns {History<T>}
 */
export function createHistory() {
    return { past: [], future: [], version: 0, savedVersion: 0, nextVersion: 1, lastKey: null, lastTime: 0 };
}

/**
 * Records the document before a change
 *
 * @template T
 * @param {History<T>} history
 * @param {T} document The document before the change
 * @param {string | null} key Changes with the same key within a short time are one step
 * @param {number} now
 * @returns {History<T>}
 */
export function recordChange(history, document, key, now) {
    if (key !== null && key === history.lastKey && now - history.lastTime < MERGE_MS) {
        return { ...history, lastTime: now };
    }
    return {
        ...history,
        past: [...history.past.slice(-(MAX_STEPS - 1)), { document, version: history.version }],
        future: [],
        version: history.nextVersion,
        nextVersion: history.nextVersion + 1,
        lastKey: key,
        lastTime: now,
    };
}

/**
 * @template T
 * @param {History<T>} history
 * @param {T} current The current document
 * @returns {{ history: History<T>; document: T } | null} null if there is nothing to undo
 */
export function undoChange(history, current) {
    const entry = history.past.at(-1);
    if (!entry) {
        return null;
    }
    return {
        document: entry.document,
        history: {
            ...history,
            past: history.past.slice(0, -1),
            future: [{ document: current, version: history.version }, ...history.future],
            version: entry.version,
            lastKey: null,
        },
    };
}

/**
 * @template T
 * @param {History<T>} history
 * @param {T} current The current document
 * @returns {{ history: History<T>; document: T } | null} null if there is nothing to redo
 */
export function redoChange(history, current) {
    const entry = history.future[0];
    if (!entry) {
        return null;
    }
    return {
        document: entry.document,
        history: {
            ...history,
            past: [...history.past, { document: current, version: history.version }],
            future: history.future.slice(1),
            version: entry.version,
            lastKey: null,
        },
    };
}

/**
 * @template T
 * @param {History<T>} history
 * @param {number} version The version which was saved, changes during saving are still unsaved
 * @returns {History<T>}
 */
export function markSaved(history, version) {
    // the next change is a new step, even if it has the same key as the last one
    return { ...history, savedVersion: version, lastKey: null };
}

/**
 * Undo/redo for an editor. The editor calls record() before each change of its document.
 *
 * @template T
 * @param {T} document The current document
 * @param {(document: T) => void} restore Sets the document of the editor
 */
export function useEditHistory(document, restore) {
    const documentRef = useRef(document);
    documentRef.current = document;
    const restoreRef = useRef(restore);
    restoreRef.current = restore;

    const [history, setHistory] = useState(/** @type {() => History<T>} */ (createHistory));
    // the history is also read by event handlers, which may run several times before the next render
    const historyRef = useRef(history);
    historyRef.current = history;

    /** @param {History<T>} value */
    const update = value => {
        historyRef.current = value;
        setHistory(value);
    };

    /**
     * Must be called before the document is changed
     *
     * @param {string | null} [key] Changes with the same key within a short time are one step
     */
    const record = useCallback(
        (/** @type {string | null} */ key = null) =>
            update(recordChange(historyRef.current, documentRef.current, key, Date.now())),
        [],
    );

    const undo = useCallback(() => {
        const result = undoChange(historyRef.current, documentRef.current);
        if (result) {
            restoreRef.current(result.document);
            // several undos may run before the next render
            documentRef.current = result.document;
            update(result.history);
        }
    }, []);

    const redo = useCallback(() => {
        const result = redoChange(historyRef.current, documentRef.current);
        if (result) {
            restoreRef.current(result.document);
            documentRef.current = result.document;
            update(result.history);
        }
    }, []);

    return {
        record,
        undo,
        redo,
        /** Must be called after the document was saved, with the version which was saved */
        markSaved: useCallback((/** @type {number} */ version) => update(markSaved(historyRef.current, version)), []),
        /** the version of the current document, see markSaved() */
        version: history.version,
        canUndo: history.past.length > 0,
        canRedo: history.future.length > 0,
        /** true if the document differs from the saved one */
        changed: history.version !== history.savedVersion,
    };
}
