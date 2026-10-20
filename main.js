"use strict";

/*
 * Created with @iobroker/create-adapter v3.1.5
 */

// The adapter-core module gives you access to the core ioBroker functions
// you need to create an adapter
const utils = require("@iobroker/adapter-core");
const { ChartRuntime } = require("./lib/chart-runtime");

class StateMachine extends utils.Adapter {
    /**
     * @param {Partial<utils.AdapterOptions>} [options] - Adapter options
     */
    constructor(options) {
        super({
            ...options,
            name: "state-machine",
        });
        /** @type {Map<string, ChartRuntime>} running charts by chart ID */
        this.runtimes = new Map();
        /** @type {Set<string>} foreign states we are subscribed to */
        this.subscribedInputs = new Set();
        /** chart (re)starts are executed one after another */
        this.chartQueue = Promise.resolve();

        this.on("ready", this.onReady.bind(this));
        this.on("stateChange", this.onStateChange.bind(this));
        this.on("objectChange", this.onObjectChange.bind(this));
        this.on("unload", this.onUnload.bind(this));
    }

    /**
     * Is called when databases are connected and adapter received configuration.
     */
    async onReady() {
        await this.setObjectNotExistsAsync("charts", {
            type: "folder",
            common: { name: "Charts" },
            native: {},
        });

        const objects = await this.getForeignObjectsAsync(`${this.namespace}.charts.*`, "channel");
        for (const [id, obj] of Object.entries(objects)) {
            const chartId = this.getChartId(id);
            if (chartId) {
                await this.startChart(chartId, obj);
            }
        }

        // the editor saves charts as objects, restart a chart whenever it changes
        this.subscribeObjects("charts.*");
    }

    /**
     * Extracts the chart ID from the ID of a chart object
     *
     * @param {string} id - Object ID
     * @returns {string | undefined} undefined if the ID is no chart object
     */
    getChartId(id) {
        const prefix = `${this.namespace}.charts.`;
        if (!id.startsWith(prefix)) {
            return undefined;
        }
        const chartId = id.substring(prefix.length);
        return chartId.includes(".") ? undefined : chartId;
    }

    /**
     * @param {string} chartId - Chart ID
     * @param {ioBroker.Object | null | undefined} obj - Chart object
     */
    async startChart(chartId, obj) {
        const chart = obj?.type === "channel" ? obj.native?.chart : undefined;
        if (!chart) {
            return;
        }

        await this.createChartStates(chartId);
        if (!chart.enabled) {
            this.log.info(`Chart "${chart.name}" is disabled`);
            await this.setState(`charts.${chartId}.activeState`, "", true);
            return;
        }

        const runtime = new ChartRuntime(chartId, chart, {
            readState: async id => (await this.getForeignStateAsync(id))?.val ?? null,
            writeState: async (id, val) => {
                await this.setForeignStateAsync(id, val, false);
            },
            onActiveChange: ({ names, ids }) => {
                this.setState(`charts.${chartId}.activeState`, names, true);
                this.setState(`charts.${chartId}.activeStateIds`, JSON.stringify(ids), true);
            },
            log: this.log,
        });
        try {
            await runtime.start();
        } catch (err) {
            this.log.error(`Cannot start chart "${chart.name}": ${err.message}`);
            return;
        }
        this.runtimes.set(chartId, runtime);
        this.updateSubscriptions();
        this.log.info(`Chart "${chart.name}" started`);
    }

    /**
     * @param {string} chartId - Chart ID
     */
    stopChart(chartId) {
        const runtime = this.runtimes.get(chartId);
        if (runtime) {
            runtime.stop();
            this.runtimes.delete(chartId);
            this.updateSubscriptions();
        }
    }

    /**
     * Creates the states which show the current status of a chart
     *
     * @param {string} chartId - Chart ID
     */
    async createChartStates(chartId) {
        await this.setObjectNotExistsAsync(`charts.${chartId}.activeState`, {
            type: "state",
            common: {
                name: "Active state",
                type: "string",
                role: "text",
                read: true,
                write: false,
            },
            native: {},
        });
        await this.setObjectNotExistsAsync(`charts.${chartId}.activeStateIds`, {
            type: "state",
            common: {
                name: "IDs of all active states",
                type: "string",
                role: "json",
                read: true,
                write: false,
            },
            native: {},
        });
    }

    /**
     * Subscribes to all inputs of the running charts and unsubscribes from the ones no longer used
     */
    updateSubscriptions() {
        const needed = new Set([...this.runtimes.values()].flatMap(runtime => runtime.inputStateIds));
        for (const id of needed) {
            if (!this.subscribedInputs.has(id)) {
                this.subscribeForeignStates(id);
            }
        }
        for (const id of this.subscribedInputs) {
            if (!needed.has(id)) {
                this.unsubscribeForeignStates(id);
            }
        }
        this.subscribedInputs = needed;
    }

    /**
     * Is called when adapter shuts down - callback has to be called under any circumstances!
     *
     * @param {() => void} callback - Callback function
     */
    onUnload(callback) {
        try {
            for (const runtime of this.runtimes.values()) {
                runtime.stop();
            }
            this.runtimes.clear();
            callback();
        } catch (error) {
            this.log.error(`Error during unloading: ${error.message}`);
            callback();
        }
    }

    /**
     * Is called if a subscribed object changes
     *
     * @param {string} id - Object ID
     * @param {ioBroker.Object | null | undefined} obj - Object
     */
    onObjectChange(id, obj) {
        const chartId = this.getChartId(id);
        if (!chartId) {
            return;
        }
        this.chartQueue = this.chartQueue
            .then(async () => {
                this.stopChart(chartId);
                await this.startChart(chartId, obj);
            })
            .catch(err => this.log.error(`Cannot restart chart ${chartId}: ${err.message}`));
    }

    /**
     * Is called if a subscribed state changes
     *
     * @param {string} id - State ID
     * @param {ioBroker.State | null | undefined} state - State object
     */
    onStateChange(id, state) {
        if (!state) {
            return;
        }
        for (const runtime of this.runtimes.values()) {
            runtime.handleInput(id, state.val);
        }
    }
}

if (require.main !== module) {
    // Export the constructor in compact mode
    /**
     * @param {Partial<utils.AdapterOptions>} [options] - Adapter options
     */
    module.exports = options => new StateMachine(options);
} else {
    // otherwise start the instance directly
    new StateMachine();
}
