/* eslint-disable @typescript-eslint/no-require-imports */
import React from "react";
import {
    Box,
    Button,
    Dialog,
    DialogActions,
    DialogContent,
    DialogTitle,
    IconButton,
    List,
    ListItemButton,
    ListItemText,
    StyledEngineProvider,
    TextField,
    ThemeProvider,
    Toolbar,
    Tooltip,
    Typography,
} from "@mui/material";
import {
    Add as AddIcon,
    Delete as DeleteIcon,
    FileDownload as ExportIcon,
    FileUpload as ImportIcon,
    Pause as PauseIcon,
    PlayArrow as StartIcon,
} from "@mui/icons-material";
import { DialogConfirm, GenericApp, I18n, Loader } from "@iobroker/adapter-react-v5";
import "@xyflow/react/dist/style.css";

import ChartEditor from "./components/ChartEditor";
import ResizablePanel from "./components/ResizablePanel";
import { downloadJson } from "./download";
import { createChart, createExport, nameToId, parseExport } from "../../lib/chart-model";

/**
 * @typedef {import("../../lib/chart-model").Chart} Chart
 * @typedef {import("@iobroker/adapter-react-v5").GenericAppState & {
 *     charts: Record<string, ioBroker.Object>;
 *     selectedChart: string | null;
 *     activeIds: string[];
 *     newChartName: string | null;
 *     deleteChart: string | null;
 *     changed: boolean;
 *     pendingSelect: { id: string | null } | null;
 * }} TabAppState
 */

/**
 * @extends {GenericApp<import("@iobroker/adapter-react-v5").GenericAppProps, TabAppState>}
 */
class TabApp extends GenericApp {
    constructor(props) {
        const extendedProps = {
            ...props,
            encryptedFields: [],
            // the tab is no settings dialog, so it needs no Save/Close buttons
            bottomButtons: false,
            translations: {
                en: require("./i18n/en.json"),
                de: require("./i18n/de.json"),
                ru: require("./i18n/ru.json"),
                pt: require("./i18n/pt.json"),
                nl: require("./i18n/nl.json"),
                fr: require("./i18n/fr.json"),
                it: require("./i18n/it.json"),
                es: require("./i18n/es.json"),
                pl: require("./i18n/pl.json"),
                uk: require("./i18n/uk.json"),
                "zh-cn": require("./i18n/zh-cn.json"),
            },
        };
        super(props, extendedProps);
        this.state = /** @type {TabAppState} */ ({
            ...this.state,
            charts: {},
            selectedChart: null,
            activeIds: [],
            newChartName: null,
            deleteChart: null,
            // if the editor has unsaved changes
            changed: false,
            // the chart to show after the user decided what to do with the unsaved changes
            pendingSelect: null,
        });
        this.chartPrefix = `${this.adapterName}.${this.instance}.charts.`;
        /** @type {{ current: (() => Promise<void>) | null }} saves the chart in the editor */
        this.saveRef = { current: null };
        /** @type {React.RefObject<HTMLInputElement>} hidden file input for importing charts */
        this.importInput = React.createRef();
        /** @type {string | null} state with the active state IDs of the selected chart */
        this.activeIdsStateId = null;
    }

    onConnectionReady() {
        // executed when connection is ready: load all charts and keep the list up to date
        this.socket.getObjectViewSystem("channel", this.chartPrefix, `${this.chartPrefix}香`).then(charts => {
            const ids = Object.keys(charts).sort();
            this.setState({ charts });
            if (ids.length) {
                this.showChart(ids[0]);
            }
        });
        this.socket.subscribeObject(`${this.chartPrefix}*`, this.onObjectChange);
    }

    componentWillUnmount() {
        this.socket.unsubscribeObject(`${this.chartPrefix}*`, this.onObjectChange);
        if (this.activeIdsStateId) {
            this.socket.unsubscribeState(this.activeIdsStateId, this.onActiveIdsChange);
        }
        super.componentWillUnmount();
    }

    /**
     * @param {string} id
     * @param {ioBroker.Object | null | undefined} obj
     */
    onObjectChange = (id, obj) => {
        // only the chart objects themselves, not the states below them
        if (id.substring(this.chartPrefix.length).includes(".")) {
            return;
        }
        const charts = { ...this.state.charts };
        if (obj?.type === "channel") {
            charts[id] = obj;
        } else {
            delete charts[id];
        }
        this.setState({ charts });
    };

    /**
     * @param {string} _id
     * @param {ioBroker.State | null | undefined} state
     */
    onActiveIdsChange = (_id, state) => {
        let activeIds = [];
        try {
            activeIds = JSON.parse(String(state?.val || "[]"));
        } catch {
            // ignore invalid values
        }
        this.setState({ activeIds });
    };

    /**
     * Shows another chart, but asks first if the editor has unsaved changes
     *
     * @param {string | null} id Object ID of the chart
     */
    selectChart(id) {
        if (this.state.changed && id !== this.state.selectedChart) {
            this.setState({ pendingSelect: { id } });
        } else {
            this.showChart(id);
        }
    }

    /**
     * Shows another chart, unsaved changes are lost
     *
     * @param {string | null} id Object ID of the chart
     */
    showChart(id) {
        if (this.activeIdsStateId) {
            this.socket.unsubscribeState(this.activeIdsStateId, this.onActiveIdsChange);
            this.activeIdsStateId = null;
        }
        this.setState({ selectedChart: id, activeIds: [], changed: false });
        if (id) {
            this.activeIdsStateId = `${id}.activeStateIds`;
            this.socket.subscribeState(this.activeIdsStateId, false, this.onActiveIdsChange);
        }
    }

    /**
     * @param {string} name Name of the chart
     * @param {Set<string>} [taken] Object IDs which are used as well, but not yet in the list of charts
     * @returns {string} an object ID which is not used yet
     */
    getUniqueChartId(name, taken = new Set()) {
        let id = `${this.chartPrefix}${nameToId(name)}`;
        for (let i = 2; this.state.charts[id] || taken.has(id); i++) {
            id = `${this.chartPrefix}${nameToId(name)}_${i}`;
        }
        return id;
    }

    /**
     * Imports the charts of an export file as new charts. They are paused, because their variables
     * may refer to states of another system.
     *
     * @param {File} file
     */
    async importFile(file) {
        let charts;
        try {
            charts = parseExport(await file.text());
        } catch (err) {
            this.showError(`${I18n.t("Import failed")}: ${err.message}`);
            return;
        }
        const taken = new Set();
        const ids = [];
        try {
            for (const chart of charts) {
                const id = this.getUniqueChartId(chart.name, taken);
                taken.add(id);
                await this.socket.setObject(id, {
                    type: "channel",
                    common: { name: chart.name },
                    native: { chart: { ...chart, enabled: false } },
                });
                ids.push(id);
            }
        } catch (err) {
            this.showError(`${I18n.t("Import failed")}: ${err}`);
        }
        if (ids.length) {
            this.showToast(I18n.t("importedCharts", String(ids.length)));
            this.selectChart(ids[0]);
        }
    }

    /** Exports all saved charts to one file */
    exportAll() {
        const charts = Object.keys(this.state.charts)
            .sort()
            .map(id => this.state.charts[id].native?.chart)
            .filter(Boolean);
        downloadJson(`${this.adapterName}.${this.instance}.charts.json`, createExport(charts));
    }

    /**
     * @param {string} name
     */
    async createChart(name) {
        const id = this.getUniqueChartId(name);
        await this.socket.setObject(id, {
            type: "channel",
            common: { name },
            native: { chart: createChart(name) },
        });
        this.selectChart(id);
    }

    /**
     * @param {string} id Object ID of the chart
     * @param {Chart} chart
     */
    async saveChart(id, chart) {
        // running or paused is only changed with the button in the chart list, the editor may have an old value
        const enabled = this.state.charts[id]?.native?.chart?.enabled ?? chart.enabled;
        try {
            await this.socket.extendObject(id, {
                common: { name: chart.name },
                native: { chart: { ...chart, enabled } },
            });
        } catch (err) {
            this.showError(`${I18n.t("Cannot save chart")}: ${err}`);
            throw err;
        }
    }

    /**
     * Pauses a running chart or starts a paused one, the adapter applies it immediately
     *
     * @param {string} id Object ID of the chart
     */
    async toggleChart(id) {
        const enabled = this.state.charts[id]?.native?.chart?.enabled !== false;
        try {
            await this.socket.extendObject(id, { native: { chart: { enabled: !enabled } } });
        } catch (err) {
            this.showError(`${I18n.t("Cannot save chart")}: ${err}`);
        }
    }

    /**
     * @param {string} id Object ID of the chart
     */
    async deleteChart(id) {
        // also deletes the states below the chart
        await this.socket.delObjects(id, false);
        if (this.state.selectedChart === id) {
            // the chart is deleted, so its unsaved changes do not matter
            this.showChart(Object.keys(this.state.charts).find(chartId => chartId !== id) || null);
        }
    }

    renderChartList() {
        const ids = Object.keys(this.state.charts).sort();
        return (
            <Box sx={{ flex: 1, display: "flex", flexDirection: "column", minHeight: 0 }}>
                <Toolbar
                    variant="dense"
                    sx={{ gap: 1, borderBottom: 1, borderColor: "divider" }}
                >
                    <Typography
                        variant="subtitle1"
                        sx={{ flex: 1 }}
                    >
                        {I18n.t("Charts")}
                    </Typography>
                    <Tooltip title={I18n.t("New chart")}>
                        <IconButton
                            size="small"
                            onClick={() => this.setState({ newChartName: "" })}
                        >
                            <AddIcon />
                        </IconButton>
                    </Tooltip>
                    <Tooltip title={I18n.t("Import charts")}>
                        <IconButton
                            size="small"
                            onClick={() => this.importInput.current?.click()}
                        >
                            <ImportIcon />
                        </IconButton>
                    </Tooltip>
                    <Tooltip title={I18n.t("Export all charts")}>
                        <span>
                            <IconButton
                                size="small"
                                disabled={!ids.length}
                                onClick={() => this.exportAll()}
                            >
                                <ExportIcon />
                            </IconButton>
                        </span>
                    </Tooltip>
                    <input
                        ref={this.importInput}
                        type="file"
                        accept=".json,application/json"
                        hidden
                        onChange={e => {
                            const file = e.target.files?.[0];
                            // allows importing the same file again
                            e.target.value = "";
                            if (file) {
                                this.importFile(file);
                            }
                        }}
                    />
                </Toolbar>
                <List
                    dense
                    sx={{ overflow: "auto", flex: 1 }}
                >
                    {ids.map(id => {
                        const chart = this.state.charts[id].native?.chart;
                        const paused = chart?.enabled === false;
                        const unsaved = id === this.state.selectedChart && this.state.changed;
                        const secondary = [paused && I18n.t("paused"), unsaved && I18n.t("unsaved changes")]
                            .filter(Boolean)
                            .join(", ");
                        return (
                            <ListItemButton
                                key={id}
                                selected={id === this.state.selectedChart}
                                onClick={() => this.selectChart(id)}
                            >
                                <ListItemText
                                    primary={`${chart?.name || id.substring(this.chartPrefix.length)}${unsaved ? " •" : ""}`}
                                    secondary={secondary || null}
                                    slotProps={{ primary: { color: paused ? "text.secondary" : "text.primary" } }}
                                />
                                <Tooltip title={I18n.t(paused ? "Start chart" : "Pause chart")}>
                                    <IconButton
                                        size="small"
                                        color={paused ? "success" : "default"}
                                        onClick={e => {
                                            e.stopPropagation();
                                            this.toggleChart(id);
                                        }}
                                    >
                                        {paused ? <StartIcon fontSize="small" /> : <PauseIcon fontSize="small" />}
                                    </IconButton>
                                </Tooltip>
                                <Tooltip title={I18n.t("Delete chart")}>
                                    <IconButton
                                        size="small"
                                        edge="end"
                                        onClick={e => {
                                            e.stopPropagation();
                                            this.setState({ deleteChart: id });
                                        }}
                                    >
                                        <DeleteIcon fontSize="small" />
                                    </IconButton>
                                </Tooltip>
                            </ListItemButton>
                        );
                    })}
                </List>
            </Box>
        );
    }

    renderNewChartDialog() {
        if (this.state.newChartName === null) {
            return null;
        }
        const name = this.state.newChartName.trim();
        const close = () => this.setState({ newChartName: null });
        const create = () => {
            close();
            this.createChart(name).catch(err => this.showError(String(err)));
        };
        return (
            <Dialog
                open
                onClose={close}
                maxWidth="xs"
                fullWidth
            >
                <DialogTitle>{I18n.t("New chart")}</DialogTitle>
                <DialogContent>
                    <TextField
                        autoFocus
                        fullWidth
                        variant="standard"
                        label={I18n.t("Name")}
                        value={this.state.newChartName}
                        onChange={e => this.setState({ newChartName: e.target.value })}
                        onKeyDown={e => e.key === "Enter" && name && create()}
                    />
                </DialogContent>
                <DialogActions>
                    <Button onClick={close}>{I18n.t("Cancel")}</Button>
                    <Button
                        variant="contained"
                        disabled={!name}
                        onClick={create}
                    >
                        {I18n.t("Create")}
                    </Button>
                </DialogActions>
            </Dialog>
        );
    }

    renderDeleteDialog() {
        const id = this.state.deleteChart;
        if (!id) {
            return null;
        }
        return (
            <DialogConfirm
                title={I18n.t("Delete chart")}
                text={I18n.t("deleteChartText", this.state.charts[id]?.native?.chart?.name || id)}
                ok={I18n.t("Delete")}
                cancel={I18n.t("Cancel")}
                onClose={ok => {
                    this.setState({ deleteChart: null });
                    if (ok) {
                        this.deleteChart(id).catch(err => this.showError(String(err)));
                    }
                }}
            />
        );
    }

    /** @param {boolean} changed */
    onChangedChange = changed => this.setState({ changed });

    renderUnsavedDialog() {
        const pending = this.state.pendingSelect;
        if (!pending) {
            return null;
        }
        const selected = this.state.selectedChart;
        const name = (selected && this.state.charts[selected]?.native?.chart?.name) || selected;
        const close = () => this.setState({ pendingSelect: null });
        return (
            <Dialog
                open
                onClose={close}
                maxWidth="xs"
                fullWidth
            >
                <DialogTitle>{I18n.t("Unsaved changes")}</DialogTitle>
                <DialogContent>
                    <Typography>{I18n.t("unsavedChangesText", String(name))}</Typography>
                </DialogContent>
                <DialogActions>
                    <Button onClick={close}>{I18n.t("Cancel")}</Button>
                    <Button
                        color="error"
                        onClick={() => {
                            close();
                            this.showChart(pending.id);
                        }}
                    >
                        {I18n.t("Discard")}
                    </Button>
                    <Button
                        variant="contained"
                        onClick={async () => {
                            close();
                            try {
                                await this.saveRef.current?.();
                            } catch {
                                // saveChart() shows the error, the chart stays open so nothing is lost
                                return;
                            }
                            this.showChart(pending.id);
                        }}
                    >
                        {I18n.t("Save")}
                    </Button>
                </DialogActions>
            </Dialog>
        );
    }

    renderContent() {
        if (!this.state.loaded) {
            return <Loader themeType={this.state.themeType} />;
        }
        const selected = this.state.selectedChart;
        const chart = selected ? this.state.charts[selected]?.native?.chart : null;

        return (
            <Box sx={{ display: "flex", height: "100%", bgcolor: "background.default", color: "text.primary" }}>
                <ResizablePanel
                    side="left"
                    storageKey="state-machine.chartListWidth"
                    defaultWidth={240}
                    minWidth={160}
                    maxWidth={600}
                >
                    {this.renderChartList()}
                </ResizablePanel>
                <Box sx={{ flex: 1, minWidth: 0 }}>
                    {selected && chart ? (
                        <ChartEditor
                            // a new editor for every chart, so no unsaved changes are carried over
                            key={selected}
                            chartId={selected.substring(this.chartPrefix.length)}
                            chart={chart}
                            activeIds={this.state.activeIds}
                            onSave={newChart => this.saveChart(selected, newChart)}
                            onChangedChange={this.onChangedChange}
                            saveRef={this.saveRef}
                            socket={this.socket}
                            theme={this.state.theme}
                        />
                    ) : (
                        <Typography
                            sx={{ p: 2 }}
                            color="text.secondary"
                        >
                            {I18n.t("noChartsHelp")}
                        </Typography>
                    )}
                </Box>
                {this.renderNewChartDialog()}
                {this.renderDeleteDialog()}
                {this.renderUnsavedDialog()}
                {this.renderError()}
                {this.renderToast()}
            </Box>
        );
    }

    render() {
        return (
            <StyledEngineProvider injectFirst>
                <ThemeProvider theme={this.state.theme}>{this.renderContent()}</ThemeProvider>
            </StyledEngineProvider>
        );
    }
}

export default TabApp;
