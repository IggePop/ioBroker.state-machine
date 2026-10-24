/*
 * Conversion between the chart model (lib/chart-model.js) and the nodes/edges of React Flow
 */

/**
 * @typedef {import("../../lib/chart-model").Chart} Chart
 * @typedef {import("../../lib/chart-model").ChartState} ChartState
 * @typedef {import("../../lib/chart-model").ChartTransition} ChartTransition
 * @typedef {import("../../lib/chart-model").ChartFunction} ChartFunction
 * @typedef {import("../../lib/chart-model").ChartNote} ChartNote
 * @typedef {import("@xyflow/react").Node<{ state: ChartState }, "state">} StateFlowNode
 * @typedef {import("@xyflow/react").Node<{ fn: ChartFunction }, "function">} FunctionFlowNode
 * @typedef {import("@xyflow/react").Node<{ note: ChartNote }, "note">} NoteFlowNode
 * @typedef {StateFlowNode | FunctionFlowNode | NoteFlowNode} ChartFlowNode
 * @typedef {import("@xyflow/react").Edge<{ transition: ChartTransition }>} TransitionFlowEdge
 */

export const DEFAULT_STATE_WIDTH = 180;
export const DEFAULT_STATE_HEIGHT = 90;
export const DEFAULT_FUNCTION_WIDTH = 260;
export const DEFAULT_FUNCTION_HEIGHT = 120;
export const DEFAULT_NOTE_WIDTH = 200;
export const DEFAULT_NOTE_HEIGHT = 100;

/** Node types which can be placed in a state (and move together with it) */
const NESTABLE_TYPES = ["state", "note"];

/** Prefix of the IDs of new nodes */
export const ID_PREFIXES = { state: "s", function: "f", note: "n" };

/**
 * @param {Chart} chart
 * @returns {{ nodes: ChartFlowNode[]; edges: TransitionFlowEdge[] }}
 */
export function chartToFlow(chart) {
    const stateIds = new Set(chart.states.map(s => s.id));
    /** @type {StateFlowNode[]} */
    const states = chart.states.map(state => ({
        id: state.id,
        type: "state",
        // like in React Flow, the position of a child is relative to its parent
        position: { x: state.x, y: state.y },
        width: state.width || DEFAULT_STATE_WIDTH,
        height: state.height || DEFAULT_STATE_HEIGHT,
        ...(state.parent && stateIds.has(state.parent) ? { parentId: state.parent, expandParent: true } : {}),
        data: { state },
    }));
    /** @type {FunctionFlowNode[]} */
    const functions = (chart.functions || []).map(fn => ({
        id: fn.id,
        type: "function",
        position: { x: fn.x, y: fn.y },
        width: fn.width || DEFAULT_FUNCTION_WIDTH,
        height: fn.height || DEFAULT_FUNCTION_HEIGHT,
        data: { fn },
    }));
    /** @type {NoteFlowNode[]} */
    const notes = (chart.notes || []).map(note => ({
        id: note.id,
        type: "note",
        position: { x: note.x, y: note.y },
        width: note.width || DEFAULT_NOTE_WIDTH,
        height: note.height || DEFAULT_NOTE_HEIGHT,
        ...(note.parent && stateIds.has(note.parent) ? { parentId: note.parent, expandParent: true } : {}),
        data: { note },
    }));
    return {
        nodes: sortParentsFirst([...states, ...functions, ...notes]),
        edges: chart.transitions.map(transition => ({
            id: transition.id,
            type: "transition",
            source: transition.source,
            target: transition.target,
            sourceHandle: transition.sourceHandle,
            targetHandle: transition.targetHandle,
            data: { transition },
        })),
    };
}

/**
 * @param {ChartFlowNode} node
 * @param {number} defaultWidth
 * @param {number} defaultHeight
 */
function getGeometry(node, defaultWidth, defaultHeight) {
    return {
        id: node.id,
        x: Math.round(node.position.x),
        y: Math.round(node.position.y),
        width: Math.round(node.width ?? node.measured?.width ?? defaultWidth),
        height: Math.round(node.height ?? node.measured?.height ?? defaultHeight),
    };
}

/**
 * Writes positions, sizes and connections from React Flow back into the chart
 *
 * @param {Chart} chart Chart with the chart level properties (name, symbols, ...)
 * @param {ChartFlowNode[]} nodes
 * @param {TransitionFlowEdge[]} edges
 * @returns {Chart}
 */
export function flowToChart(chart, nodes, edges) {
    /** @type {ChartState[]} */
    const states = [];
    /** @type {ChartFunction[]} */
    const functions = [];
    /** @type {ChartNote[]} */
    const notes = [];
    for (const node of nodes) {
        if (node.type === "function") {
            functions.push({
                ...node.data.fn,
                ...getGeometry(node, DEFAULT_FUNCTION_WIDTH, DEFAULT_FUNCTION_HEIGHT),
            });
        } else if (node.type === "note") {
            notes.push({
                ...node.data.note,
                ...getGeometry(node, DEFAULT_NOTE_WIDTH, DEFAULT_NOTE_HEIGHT),
                parent: node.parentId || null,
            });
        } else {
            states.push({
                ...node.data.state,
                ...getGeometry(node, DEFAULT_STATE_WIDTH, DEFAULT_STATE_HEIGHT),
                parent: node.parentId || null,
            });
        }
    }
    return {
        ...chart,
        states,
        functions,
        notes,
        transitions: edges.map(edge => ({
            ...edge.data?.transition,
            id: edge.id,
            source: edge.source,
            target: edge.target,
            sourceHandle: edge.sourceHandle ?? undefined,
            targetHandle: edge.targetHandle ?? undefined,
        })),
    };
}

/**
 * React Flow requires parents to be before their children in the list of nodes
 *
 * @template {{ id: string; parentId?: string }} T
 * @param {T[]} nodes
 * @returns {T[]}
 */
export function sortParentsFirst(nodes) {
    const byId = new Map(nodes.map(n => [n.id, n]));
    /** @param {T} node */
    const depth = node => {
        let d = 0;
        for (let parent = node.parentId; parent && d <= nodes.length; d++) {
            parent = byId.get(parent)?.parentId;
        }
        return d;
    };
    // the sort is stable, so the order of the states on the same level is kept
    return [...nodes].sort((a, b) => depth(a) - depth(b));
}

/**
 * @param {{ id: string; parentId?: string }[]} nodes
 * @param {string} ancestorId
 * @param {string} id
 * @returns {boolean} true if node "id" is a (direct or indirect) child of node "ancestorId"
 */
export function isDescendantNode(nodes, ancestorId, id) {
    const byId = new Map(nodes.map(n => [n.id, n]));
    let parent = byId.get(id)?.parentId;
    for (let i = 0; parent && i < nodes.length; i++) {
        if (parent === ancestorId) {
            return true;
        }
        parent = byId.get(parent)?.parentId;
    }
    return false;
}

/**
 * @typedef {{ x: number; y: number; width: number; height: number }} Rect
 */

/**
 * Finds the state a node is dropped into: the smallest state which contains the center of the node.
 * The node itself, its children and function blocks are no candidates.
 *
 * @param {ChartFlowNode[]} nodes
 * @param {string} id ID of the dragged node
 * @param {(id: string) => Rect | null} getRect Absolute position and size of a node
 * @returns {string | null} ID of the new parent, null for the top level
 */
export function findDropParent(nodes, id, getRect) {
    const rect = getRect(id);
    if (!rect) {
        return null;
    }
    const cx = rect.x + rect.width / 2;
    const cy = rect.y + rect.height / 2;
    let best = null;
    let bestArea = Infinity;
    for (const node of nodes) {
        if (node.type !== "state" || node.id === id || isDescendantNode(nodes, id, node.id)) {
            continue;
        }
        const r = getRect(node.id);
        if (
            r &&
            cx >= r.x &&
            cx <= r.x + r.width &&
            cy >= r.y &&
            cy <= r.y + r.height &&
            r.width * r.height < bestArea
        ) {
            best = node.id;
            bestArea = r.width * r.height;
        }
    }
    return best;
}

/**
 * Moves dragged states and notes into the state they were dropped into, or out of their parent.
 * The positions are converted, so they stay where they were dropped.
 *
 * @param {ChartFlowNode[]} nodes
 * @param {string[]} draggedIds
 * @param {(id: string) => Rect | null} getRect Absolute position and size of a node (before the change)
 * @returns {ChartFlowNode[]} the same array if nothing changed
 */
export function reparentNodes(nodes, draggedIds, getRect) {
    let result = nodes;
    for (const id of draggedIds) {
        const node = result.find(n => n.id === id);
        // a child dragged together with its parent stays in it
        if (!node || !NESTABLE_TYPES.includes(node.type) || (node.parentId && draggedIds.includes(node.parentId))) {
            continue;
        }
        const parentId = findDropParent(result, id, getRect);
        const rect = getRect(id);
        if ((node.parentId || null) === parentId || !rect) {
            continue;
        }
        const parentRect = parentId ? getRect(parentId) : null;
        /** @type {ChartFlowNode} */
        const moved = {
            ...node,
            position: { x: rect.x - (parentRect?.x ?? 0), y: rect.y - (parentRect?.y ?? 0) },
        };
        if (parentId) {
            moved.parentId = parentId;
            moved.expandParent = true;
        } else {
            delete moved.parentId;
            delete moved.expandParent;
        }
        result = result.map(n => (n.id === id ? moved : n));
    }
    return result === nodes ? nodes : sortParentsFirst(result);
}

/**
 * The initial state of every level: the configured one if it is valid, otherwise the first state,
 * exactly like the runtime does it
 *
 * @param {ChartFlowNode[]} nodes
 * @param {string | undefined} chartInitial Initial state of the top level
 * @returns {Set<string>} IDs of all initial states
 */
export function getInitialStateIds(nodes, chartInitial) {
    /** @type {Map<string, string[]>} children by parent ID, "" for the top level */
    const children = new Map();
    /** @type {Map<string, string | undefined>} configured initial state by parent ID */
    const configured = new Map([["", chartInitial]]);
    for (const node of nodes) {
        if (node.type !== "state") {
            continue;
        }
        const parent = node.parentId || "";
        children.set(parent, [...(children.get(parent) || []), node.id]);
        configured.set(node.id, node.data.state.initial);
    }
    const result = new Set();
    for (const [parent, ids] of children) {
        const initial = configured.get(parent);
        result.add(initial && ids.includes(initial) ? initial : ids[0]);
    }
    return result;
}

/**
 * Creates an ID which is not used yet
 *
 * @param {string} prefix
 * @param {{ id: string }[]} existing
 * @returns {string}
 */
export function createId(prefix, existing) {
    const ids = new Set(existing.map(item => item.id));
    let i = existing.length + 1;
    while (ids.has(`${prefix}${i}`)) {
        i++;
    }
    return `${prefix}${i}`;
}

/**
 * Copied states, function blocks and transitions
 *
 * @typedef {{ nodes: ChartFlowNode[]; edges: TransitionFlowEdge[] }} ClipboardContent
 */

/**
 * Copies the selected states and function blocks, together with the sub states of copied states
 * and the transitions between copied states
 *
 * @param {ChartFlowNode[]} nodes
 * @param {TransitionFlowEdge[]} edges
 * @param {(id: string) => Rect | null} getRect Absolute position and size of a node
 * @returns {ClipboardContent | null} null if nothing is selected
 */
export function copySelection(nodes, edges, getRect) {
    const selected = new Set(nodes.filter(n => n.selected).map(n => n.id));
    const copied = new Set(
        nodes
            .filter(n => selected.has(n.id) || [...selected].some(id => isDescendantNode(nodes, id, n.id)))
            .map(n => n.id),
    );
    if (!copied.size) {
        return null;
    }
    /** @type {ChartFlowNode[]} */
    const copiedNodes = [];
    for (const node of nodes) {
        if (!copied.has(node.id)) {
            continue;
        }
        // a copy which is independent of the editor state
        const copy = /** @type {ChartFlowNode} */ ({
            ...node,
            selected: false,
            data: JSON.parse(JSON.stringify(node.data)),
        });
        if (node.parentId && !copied.has(node.parentId)) {
            // the parent is not copied: the copy is a top level state at the same place
            const rect = getRect(node.id);
            copy.position = rect ? { x: rect.x, y: rect.y } : { ...node.position };
            delete copy.parentId;
            delete copy.expandParent;
        }
        copiedNodes.push(copy);
    }
    const copiedEdges = edges
        .filter(e => copied.has(e.source) && copied.has(e.target))
        .map(e => ({ ...e, selected: false, data: JSON.parse(JSON.stringify(e.data)) }));
    return { nodes: copiedNodes, edges: copiedEdges };
}

/**
 * Inserts copied elements with new IDs, moved by an offset. The inserted elements are selected,
 * all others are deselected.
 *
 * @param {ClipboardContent} clipboard
 * @param {ChartFlowNode[]} nodes
 * @param {TransitionFlowEdge[]} edges
 * @param {number} offset Added to the position of the inserted top level elements
 * @returns {{ nodes: ChartFlowNode[]; edges: TransitionFlowEdge[] }}
 */
export function pasteClipboard(clipboard, nodes, edges, offset) {
    /** @type {Map<string, string>} old ID -> new ID */
    const ids = new Map();
    /** @type {{ id: string }[]} all IDs in use, to create unique ones */
    const used = [...nodes];
    for (const node of clipboard.nodes) {
        const id = createId(ID_PREFIXES[node.type], used);
        ids.set(node.id, id);
        used.push({ id });
    }

    /** @type {ChartFlowNode[]} */
    const pasted = clipboard.nodes.map(node => {
        const id = /** @type {string} */ (ids.get(node.id));
        const parentId = node.parentId ? ids.get(node.parentId) : undefined;
        // children keep their position relative to the (copied) parent
        const position = parentId ? { ...node.position } : { x: node.position.x + offset, y: node.position.y + offset };
        if (node.type === "function") {
            return { ...node, id, position, selected: true, data: { fn: { ...node.data.fn, id } } };
        }
        /** @type {ChartFlowNode} */
        let copy;
        if (node.type === "note") {
            copy = {
                ...node,
                id,
                position,
                selected: true,
                data: { note: { ...node.data.note, id, parent: parentId ?? null } },
            };
        } else {
            const state = { ...node.data.state, id, parent: parentId ?? null };
            if (state.initial) {
                state.initial = ids.get(state.initial);
            }
            copy = { ...node, id, position, selected: true, data: { state } };
        }
        if (parentId) {
            copy.parentId = parentId;
        } else {
            delete copy.parentId;
            delete copy.expandParent;
        }
        return copy;
    });

    /** @type {{ id: string }[]} */
    const usedEdges = [...edges];
    const pastedEdges = clipboard.edges.map(edge => {
        const id = createId("t", usedEdges);
        usedEdges.push({ id });
        const source = /** @type {string} */ (ids.get(edge.source));
        const target = /** @type {string} */ (ids.get(edge.target));
        return {
            ...edge,
            id,
            source,
            target,
            selected: true,
            data: { transition: { ...edge.data?.transition, id, source, target } },
        };
    });

    return {
        nodes: sortParentsFirst([...nodes.map(n => ({ ...n, selected: false })), ...pasted]),
        edges: [...edges.map(e => ({ ...e, selected: false })), ...pastedEdges],
    };
}
