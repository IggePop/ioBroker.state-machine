import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
    applyEdgeChanges,
    applyNodeChanges,
    Background,
    ConnectionMode,
    Controls,
    MarkerType,
    MiniMap,
    ReactFlow,
    ReactFlowProvider,
    useReactFlow,
} from "@xyflow/react";
import { Box, Divider, IconButton, Tab, Tabs, Toolbar, Tooltip } from "@mui/material";
import {
    Add as AddIcon,
    Code as CodeIcon,
    ContentCopy as CopyIcon,
    ContentPaste as PasteIcon,
    FileDownload as ExportIcon,
    Functions as FunctionIcon,
    Redo as RedoIcon,
    Save as SaveIcon,
    Undo as UndoIcon,
} from "@mui/icons-material";
import { I18n } from "@iobroker/adapter-react-v5";
import { useEditHistory } from "../edit-history";

import StateNode from "./StateNode";
import FunctionNode from "./FunctionNode";
import TransitionEdge from "./TransitionEdge";
import PropertiesPanel from "./PropertiesPanel";
import ResizablePanel from "./ResizablePanel";
import SymbolsEditor from "./SymbolsEditor";
import GeneratedCodeDialog from "./GeneratedCodeDialog";
import { generateChartCode } from "../../../lib/chart-codegen";
import { createExport } from "../../../lib/chart-model";
import { downloadJson } from "../download";
import { translateDiagnostic } from "./CodeEditor";
import {
    chartToFlow,
    copySelection,
    createId,
    DEFAULT_FUNCTION_HEIGHT,
    DEFAULT_FUNCTION_WIDTH,
    DEFAULT_STATE_HEIGHT,
    DEFAULT_STATE_WIDTH,
    findDropParent,
    flowToChart,
    getInitialStateIds,
    isDescendantNode,
    pasteClipboard,
    reparentNodes,
} from "../flow-model";
import { getDeclarations, validateChart } from "../../../lib/chart-validation";

/**
 * @typedef {import("../../../lib/chart-model").Chart} Chart
 * @typedef {import("../flow-model").ChartFlowNode} ChartFlowNode
 * @typedef {import("../flow-model").TransitionFlowEdge} TransitionFlowEdge
 */

// defined outside the component, so React Flow does not re-create them on every render
const nodeTypes = { state: StateNode, function: FunctionNode };
const edgeTypes = { transition: TransitionEdge };
const markerEnd = { type: MarkerType.ArrowClosed, width: 18, height: 18 };

/**
 * Copied elements, outside the component so they can be pasted into another chart as well
 *
 * @type {import("../flow-model").ClipboardContent | null}
 */
let clipboard = null;

/** Distance of pasted elements from the copied ones */
const PASTE_OFFSET = 30;

/**
 * A button of the toolbar: only an icon, the title is shown as tooltip
 *
 * @param {object} props
 * @param {string} props.title
 * @param {React.ReactNode} props.icon
 * @param {() => void} props.onClick
 * @param {boolean} [props.disabled]
 * @param {"default" | "primary"} [props.color]
 */
function ToolButton({ title, icon, onClick, disabled, color = "default" }) {
    return (
        <Tooltip title={title}>
            {/* disabled buttons get no mouse events, the span shows the tooltip anyway */}
            <span>
                <IconButton
                    size="small"
                    color={color}
                    disabled={disabled}
                    onClick={onClick}
                    aria-label={title}
                >
                    {icon}
                </IconButton>
            </span>
        </Tooltip>
    );
}

/**
 * @param {EventTarget | null} target
 * @returns {boolean} true for text fields and code editors, which handle the keyboard shortcuts themselves
 */
function isTextInput(target) {
    if (!(target instanceof Element)) {
        return false;
    }
    return (
        ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName) ||
        (target instanceof HTMLElement && target.isContentEditable) ||
        !!target.closest(".cm-editor")
    );
}

/**
 * @typedef {object} ChartEditorProps
 * @property {string} chartId ID of the chart (last part of the object ID)
 * @property {Chart} chart The saved chart
 * @property {string[]} activeIds IDs of the currently active states
 * @property {(chart: Chart) => Promise<void>} onSave
 * @property {(changed: boolean) => void} [onChangedChange] Called when the editor gets or loses unsaved changes
 * @property {{ current: (() => Promise<void>) | null }} [saveRef] Set to a function which saves the chart
 * @property {any} socket
 * @property {import("@iobroker/adapter-react-v5").IobTheme} theme
 */

/**
 * @param {ChartEditorProps} props
 */
function ChartEditorInner({ chartId, chart: savedChart, activeIds, onSave, onChangedChange, saveRef, socket, theme }) {
    const reactFlow = useReactFlow();
    /** chart level properties (name, symbols, initial state, ...), states and transitions live in nodes/edges */
    const [chart, setChart] = useState(savedChart);
    const [nodes, setNodes] = useState(() => chartToFlow(savedChart).nodes);
    const [edges, setEdges] = useState(() => chartToFlow(savedChart).edges);
    const history = useEditHistory({ chart, nodes, edges }, document => {
        // selected elements of the past would show their (old) properties, so the selection is cleared
        setChart(document.chart);
        setNodes(document.nodes.map(n => ({ ...n, selected: false })));
        setEdges(document.edges.map(e => ({ ...e, selected: false })));
    });
    const { record, changed } = history;
    /** how often the clipboard was pasted, each time a bit further away */
    const pasteCount = useRef(0);
    /** the clipboard is no state, this re-renders the editor (to enable the paste button) when it is filled */
    const [hasClipboard, setHasClipboard] = useState(!!clipboard);
    const [saving, setSaving] = useState(false);
    const [panelTab, setPanelTab] = useState("properties");
    /** the code generated from the current (maybe unsaved) chart, null if the dialog is closed */
    const [generatedCode, setGeneratedCode] = useState(/** @type {string | null} */ (null));
    /** state into which the dragged state would be moved when it is dropped */
    const [dropTarget, setDropTarget] = useState(/** @type {string | null} */ (null));

    /**
     * Absolute position and size of a node, as currently shown by React Flow
     *
     * @param {string} id
     * @returns {import("../flow-model").Rect | null}
     */
    const getRect = useCallback(
        id => {
            const node = reactFlow.getInternalNode(id);
            if (!node) {
                return null;
            }
            return {
                ...node.internals.positionAbsolute,
                width: node.measured.width ?? node.width ?? 0,
                height: node.measured.height ?? node.height ?? 0,
            };
        },
        [reactFlow],
    );

    /** @type {import("@xyflow/react").OnNodeDrag<ChartFlowNode>} */
    const onNodeDrag = useCallback(
        (_event, node, dragged) => {
            const target =
                dragged.length === 1 && node.type === "state" ? findDropParent(nodes, node.id, getRect) : null;
            // only show a target if the state would really be moved into another parent
            setDropTarget(target !== (node.parentId || null) ? target : null);
        },
        [nodes, getRect],
    );

    /** @type {import("@xyflow/react").OnNodeDrag<ChartFlowNode>} */
    const onNodeDragStop = useCallback(
        (_event, _node, dragged) => {
            setDropTarget(null);
            setNodes(nds =>
                reparentNodes(
                    nds,
                    dragged.map(n => n.id),
                    getRect,
                ),
            );
        },
        [getRect],
    );

    /** @type {import("@xyflow/react").OnNodesChange<ChartFlowNode>} */
    const onNodesChange = useCallback(
        changes => {
            // selection and measuring are no modifications of the chart
            if (changes.some(c => c.type === "remove")) {
                // removing states also removes their transitions: one step
                record("remove");
            } else if (changes.some(c => c.type === "dimensions" && c.resizing)) {
                record("resize");
            } else if (changes.some(c => c.type === "position" && c.position)) {
                // dragged or moved with the arrow keys, all position changes of a drag are one step
                // (including moving the state into another state when it is dropped)
                record("move");
            }
            setNodes(nds => applyNodeChanges(changes, nds));
        },
        [record],
    );

    /** @type {import("@xyflow/react").OnEdgesChange<TransitionFlowEdge>} */
    const onEdgesChange = useCallback(
        changes => {
            if (changes.some(c => c.type === "remove")) {
                record("remove");
            }
            setEdges(eds => applyEdgeChanges(changes, eds));
        },
        [record],
    );

    /** @type {import("@xyflow/react").OnConnect} */
    const onConnect = useCallback(
        connection => {
            record();
            setEdges(eds => {
                const id = createId("t", eds);
                const outgoing = eds.filter(e => e.source === connection.source).length;
                return [
                    ...eds.map(e => ({ ...e, selected: false })),
                    {
                        id,
                        type: "transition",
                        source: connection.source,
                        target: connection.target,
                        sourceHandle: connection.sourceHandle,
                        targetHandle: connection.targetHandle,
                        selected: true,
                        data: {
                            transition: {
                                id,
                                source: connection.source,
                                target: connection.target,
                                label: "",
                                priority: outgoing + 1,
                            },
                        },
                    },
                ];
            });
            setNodes(nds => nds.map(n => ({ ...n, selected: false })));
        },
        [record],
    );

    // a double click selects the state/transition (first click) and shows its properties
    const showProperties = useCallback(() => setPanelTab("properties"), []);

    /**
     * Adds a node in the middle of the visible area and selects it
     *
     * @param {(id: string, x: number, y: number) => ChartFlowNode} create
     * @param {string} idPrefix
     * @returns {string} ID of the new node
     */
    const addNode = (create, idPrefix) => {
        record();
        const id = createId(idPrefix, nodes);
        const { x, y } = reactFlow.screenToFlowPosition({ x: window.innerWidth / 3, y: window.innerHeight / 3 });
        setNodes(nds => [
            ...nds.map(n => ({ ...n, selected: false })),
            { ...create(id, Math.round(x), Math.round(y)), selected: true },
        ]);
        setEdges(eds => eds.map(e => ({ ...e, selected: false })));
        setPanelTab("properties");
        return id;
    };

    const addState = () => {
        const states = nodes.filter(n => n.type === "state");
        const id = addNode(
            (id, x, y) => ({
                id,
                type: "state",
                position: { x, y },
                width: DEFAULT_STATE_WIDTH,
                height: DEFAULT_STATE_HEIGHT,
                data: { state: { id, name: `${I18n.t("State")} ${states.length + 1}`, x, y } },
            }),
            "s",
        );
        if (!states.some(n => n.id === chart.initial)) {
            setChart(c => ({ ...c, initial: id }));
        }
    };

    const addFunction = () => {
        addNode(
            (id, x, y) => ({
                id,
                type: "function",
                position: { x, y },
                width: DEFAULT_FUNCTION_WIDTH,
                height: DEFAULT_FUNCTION_HEIGHT,
                data: { fn: { id, code: "function myFunction(value) {\n    return value;\n}", x, y } },
            }),
            "f",
        );
    };

    /**
     * @param {Partial<Chart>} patch
     */
    const updateChart = patch => {
        // typing in the same field is one step
        record(`chart:${Object.keys(patch).join()}`);
        setChart(c => ({ ...c, ...patch }));
    };

    /**
     * @param {string} id
     * @param {Partial<import("../../../lib/chart-model").ChartState>} patch
     */
    const updateState = (id, patch) => {
        record(`state:${id}:${Object.keys(patch).join()}`);
        setNodes(nds =>
            nds.map(n =>
                n.id === id && n.type === "state" ? { ...n, data: { state: { ...n.data.state, ...patch } } } : n,
            ),
        );
    };

    /**
     * @param {string} id
     * @param {Partial<import("../../../lib/chart-model").ChartFunction>} patch
     */
    const updateFunction = (id, patch) => {
        record(`function:${id}:${Object.keys(patch).join()}`);
        setNodes(nds =>
            nds.map(n =>
                n.id === id && n.type === "function" ? { ...n, data: { fn: { ...n.data.fn, ...patch } } } : n,
            ),
        );
    };

    /**
     * @param {string} id
     * @param {Partial<import("../../../lib/chart-model").ChartTransition>} patch
     */
    const updateTransition = (id, patch) => {
        record(`transition:${id}:${Object.keys(patch).join()}`);
        setEdges(eds =>
            eds.map(e =>
                e.id === id
                    ? {
                          ...e,
                          data: {
                              ...e.data,
                              transition: { ...e.data?.transition, ...patch, id, source: e.source, target: e.target },
                          },
                      }
                    : e,
            ),
        );
    };

    /**
     * @returns {Chart} the chart as shown in the editor, including unsaved changes
     */
    const getCurrentChart = () => {
        const current = flowToChart(chart, nodes, edges);
        const topLevel = current.states.filter(s => !s.parent);
        if (!topLevel.some(s => s.id === current.initial)) {
            current.initial = topLevel[0]?.id;
        }
        return current;
    };

    const exportChart = () => downloadJson(`${chartId}.state-machine.json`, createExport([getCurrentChart()]));

    const save = async () => {
        const newChart = getCurrentChart();
        const version = history.version;
        setSaving(true);
        try {
            await onSave(newChart);
            setChart(c => ({ ...c, initial: newChart.initial }));
            history.markSaved(version);
        } finally {
            setSaving(false);
        }
    };

    const copy = () => {
        const content = copySelection(nodes, edges, getRect);
        if (content) {
            clipboard = content;
            pasteCount.current = 0;
            setHasClipboard(true);
        }
        return !!content;
    };

    const cut = () => {
        if (copy()) {
            reactFlow.deleteElements({
                nodes: nodes.filter(n => n.selected).map(n => ({ id: n.id })),
                edges: edges.filter(e => e.selected).map(e => ({ id: e.id })),
            });
        }
    };

    const paste = () => {
        if (!clipboard) {
            return;
        }
        record();
        pasteCount.current++;
        const result = pasteClipboard(clipboard, nodes, edges, PASTE_OFFSET * pasteCount.current);
        setNodes(result.nodes);
        setEdges(result.edges);
        setPanelTab("properties");
    };

    // the keyboard shortcuts call the functions of the current render
    const shortcuts = useRef({ undo: history.undo, redo: history.redo, copy, cut, paste });
    shortcuts.current = { undo: history.undo, redo: history.redo, copy, cut, paste };

    useEffect(() => {
        /** @param {KeyboardEvent} e */
        const onKeyDown = e => {
            // text fields and code editors have their own undo, copy and paste
            if (!(e.ctrlKey || e.metaKey) || e.altKey || isTextInput(e.target)) {
                return;
            }
            const key = e.key.toLowerCase();
            const action =
                key === "z" && e.shiftKey
                    ? "redo"
                    : !e.shiftKey && { z: "undo", y: "redo", c: "copy", x: "cut", v: "paste" }[key];
            if (action) {
                e.preventDefault();
                shortcuts.current[action]();
            }
        };
        window.addEventListener("keydown", onKeyDown);
        return () => window.removeEventListener("keydown", onKeyDown);
    }, []);

    useEffect(() => {
        if (!changed) {
            return undefined;
        }
        // the browser asks before the page is closed or reloaded
        /** @param {BeforeUnloadEvent} e */
        const onBeforeUnload = e => {
            e.preventDefault();
            e.returnValue = "";
        };
        window.addEventListener("beforeunload", onBeforeUnload);
        return () => window.removeEventListener("beforeunload", onBeforeUnload);
    }, [changed]);

    useEffect(() => onChangedChange?.(changed), [changed, onChangedChange]);
    useEffect(() => {
        if (saveRef) {
            saveRef.current = save;
        }
    });

    const selectedNodes = nodes.filter(n => n.selected);
    const selectedEdges = edges.filter(e => e.selected);
    const selectedNode = selectedNodes.length === 1 && !selectedEdges.length ? selectedNodes[0] : null;
    const selectedState = selectedNode?.type === "state" ? selectedNode.data.state : null;
    const selectedFunction = selectedNode?.type === "function" ? selectedNode.data.fn : null;
    const selectedTransition =
        selectedEdges.length === 1 && !selectedNodes.length ? selectedEdges[0].data?.transition || null : null;

    // add the information which is not stored in the nodes/edges themselves
    // only the code and the variables matter for the validation, not e.g. the positions which change while dragging
    const codeSignature = JSON.stringify([
        chart.symbols,
        nodes.map(n =>
            n.type === "function"
                ? [n.id, n.data.fn.code]
                : [n.id, n.data.state.entry, n.data.state.during, n.data.state.exit],
        ),
        edges.map(e => [e.id, e.data?.transition.label]),
    ]);
    const functionCodes = JSON.stringify(nodes.map(n => (n.type === "function" ? n.data.fn.code : null)));
    const { functions, declarations } = useMemo(() => {
        const fns = nodes.flatMap(n => (n.type === "function" ? [n.data.fn] : []));
        return {
            functions: fns,
            /** names declared in the function blocks, they can be used in all conditions and actions */
            declarations: fns.flatMap(fn => getDeclarations(fn.code)),
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [functionCodes]);

    /** translated problem messages by state/transition/function ID */
    const problems = useMemo(() => {
        /** @type {Map<string, string[]>} */
        const byId = new Map();
        for (const problem of validateChart(flowToChart(chart, nodes, edges))) {
            const prefix = problem.kind === "state" ? `${problem.field}: ` : "";
            byId.set(problem.id, [...(byId.get(problem.id) || []), prefix + translateDiagnostic(problem.diagnostic)]);
        }
        return byId;
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [codeSignature]);

    /**
     * Makes a state the initial state of its level: of its parent, or of the chart for top level states
     *
     * @param {string} id
     */
    const setInitial = id => {
        const parentId = nodes.find(n => n.id === id)?.parentId;
        if (parentId) {
            updateState(parentId, { initial: id });
        } else {
            updateChart({ initial: id });
        }
    };

    const initialIds = useMemo(() => getInitialStateIds(nodes, chart.initial), [nodes, chart.initial]);

    const displayNodes = useMemo(
        () =>
            nodes.map(n => ({
                ...n,
                // the extra fields are only read by the node components
                data: /** @type {any} */ ({
                    ...n.data,
                    isInitial: initialIds.has(n.id),
                    isActive: activeIds.includes(n.id),
                    isDropTarget: n.id === dropTarget,
                    problems: problems.get(n.id),
                }),
            })),
        [nodes, initialIds, activeIds, dropTarget, problems],
    );
    const displayEdges = useMemo(() => {
        /** @type {Record<string, number>} */
        const outgoing = {};
        edges.forEach(e => (outgoing[e.source] = (outgoing[e.source] || 0) + 1));
        return edges.map(
            e =>
                /** @type {TransitionFlowEdge} */ ({
                    ...e,
                    // like the nodes: no zooming on double click and no panning when dragging the edge
                    className: "nopan",
                    markerEnd,
                    data: {
                        ...e.data,
                        showPriority: outgoing[e.source] > 1,
                        // a transition to an own child which keeps the parent active
                        inner: isDescendantNode(nodes, e.source, e.target) && !e.data?.transition.reenterParent,
                        problems: problems.get(e.id),
                    },
                }),
        );
    }, [edges, nodes, problems]);

    return (
        <Box sx={{ display: "flex", height: "100%", minHeight: 0 }}>
            <Box sx={{ flex: 1, display: "flex", flexDirection: "column", minWidth: 0 }}>
                <Toolbar
                    variant="dense"
                    sx={{ gap: 0.5, borderBottom: 1, borderColor: "divider" }}
                >
                    <ToolButton
                        title={`${I18n.t("Save")} (${changed ? I18n.t("unsaved changes") : I18n.t("no changes")})`}
                        icon={<SaveIcon />}
                        // highlighted when there is something to save
                        color={changed ? "primary" : "default"}
                        disabled={!changed || saving}
                        onClick={save}
                    />
                    <ToolButton
                        title={`${I18n.t("Copy")} (Ctrl+C)`}
                        icon={<CopyIcon />}
                        disabled={!nodes.some(n => n.selected)}
                        onClick={copy}
                    />
                    <ToolButton
                        title={`${I18n.t("Paste")} (Ctrl+V)`}
                        icon={<PasteIcon />}
                        disabled={!hasClipboard}
                        onClick={paste}
                    />
                    <ToolButton
                        title={`${I18n.t("Undo")} (Ctrl+Z)`}
                        icon={<UndoIcon />}
                        disabled={!history.canUndo}
                        onClick={history.undo}
                    />
                    <ToolButton
                        title={`${I18n.t("Redo")} (Ctrl+Y)`}
                        icon={<RedoIcon />}
                        disabled={!history.canRedo}
                        onClick={history.redo}
                    />
                    <Divider
                        orientation="vertical"
                        flexItem
                        sx={{ mx: 0.5 }}
                    />
                    <ToolButton
                        title={I18n.t("Show code")}
                        icon={<CodeIcon />}
                        onClick={() => setGeneratedCode(generateChartCode(flowToChart(chart, nodes, edges), chartId))}
                    />
                    <ToolButton
                        title={I18n.t("Add state")}
                        icon={<AddIcon />}
                        onClick={addState}
                    />
                    <ToolButton
                        title={I18n.t("Add function")}
                        icon={<FunctionIcon />}
                        onClick={addFunction}
                    />
                    <Divider
                        orientation="vertical"
                        flexItem
                        sx={{ mx: 0.5 }}
                    />
                    <ToolButton
                        title={`${I18n.t("Export chart")}${changed ? ` (${I18n.t("including unsaved changes")})` : ""}`}
                        icon={<ExportIcon />}
                        onClick={exportChart}
                    />
                </Toolbar>
                <Box sx={{ flex: 1, minHeight: 0 }}>
                    <ReactFlow
                        nodes={displayNodes}
                        edges={displayEdges}
                        nodeTypes={nodeTypes}
                        edgeTypes={edgeTypes}
                        onNodesChange={onNodesChange}
                        onEdgesChange={onEdgesChange}
                        onConnect={onConnect}
                        onNodeDoubleClick={showProperties}
                        onEdgeDoubleClick={showProperties}
                        onNodeDrag={onNodeDrag}
                        onNodeDragStop={onNodeDragStop}
                        // children above their parents, transitions of children above the parents as well
                        zIndexMode="auto"
                        connectionMode={ConnectionMode.Loose}
                        colorMode={theme.palette.mode}
                        snapToGrid
                        snapGrid={[10, 10]}
                        deleteKeyCode={["Delete", "Backspace"]}
                        fitView
                        fitViewOptions={{ maxZoom: 1 }}
                    >
                        <Background />
                        <Controls />
                        <MiniMap
                            pannable
                            zoomable
                        />
                    </ReactFlow>
                </Box>
            </Box>
            <ResizablePanel
                side="right"
                storageKey="state-machine.propertiesWidth"
                defaultWidth={360}
                minWidth={260}
                maxWidth={900}
            >
                <Tabs
                    value={panelTab}
                    onChange={(_e, value) => setPanelTab(value)}
                    variant="fullWidth"
                >
                    <Tab
                        value="properties"
                        label={I18n.t("Properties")}
                    />
                    <Tab
                        value="symbols"
                        label={I18n.t("Variables")}
                    />
                </Tabs>
                <Box sx={{ p: 2, overflow: "auto", flex: 1 }}>
                    {panelTab === "properties" ? (
                        <PropertiesPanel
                            chart={chart}
                            selectedState={selectedState}
                            selectedTransition={selectedTransition}
                            selectedFunction={selectedFunction}
                            isInitial={!!selectedState && initialIds.has(selectedState.id)}
                            toChild={
                                !!selectedTransition &&
                                isDescendantNode(nodes, selectedTransition.source, selectedTransition.target)
                            }
                            onSetInitial={setInitial}
                            functions={functions}
                            declarations={declarations}
                            onChartChange={updateChart}
                            onStateChange={updateState}
                            onTransitionChange={updateTransition}
                            onFunctionChange={updateFunction}
                            onDeleteNode={id => reactFlow.deleteElements({ nodes: [{ id }] })}
                            onDeleteTransition={id => reactFlow.deleteElements({ edges: [{ id }] })}
                        />
                    ) : (
                        <SymbolsEditor
                            symbols={chart.symbols}
                            onChange={symbols => updateChart({ symbols })}
                            socket={socket}
                            theme={theme}
                        />
                    )}
                </Box>
            </ResizablePanel>
            {generatedCode !== null && (
                <GeneratedCodeDialog
                    code={generatedCode}
                    unsaved={changed}
                    onClose={() => setGeneratedCode(null)}
                />
            )}
        </Box>
    );
}

/**
 * Graphical editor for one chart
 *
 * @param {ChartEditorProps} props
 */
export default function ChartEditor(props) {
    return (
        <ReactFlowProvider>
            <ChartEditorInner {...props} />
        </ReactFlowProvider>
    );
}
