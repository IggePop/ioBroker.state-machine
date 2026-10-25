"use strict";
var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
  // If the importer is in node compatibility mode or this is not an ESM
  // file that has been converted to a CommonJS file using a Babel-
  // compatible transform (i.e. "__esModule" has not been set), then set
  // "default" to the CommonJS "module.exports" for node compatibility.
  isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
  mod
));
var utils = __toESM(require("@iobroker/adapter-core"));
var import_chart_runtime = require("./lib/chart-runtime");
class Statechart extends utils.Adapter {
  /** running charts by chart ID */
  runtimes = /* @__PURE__ */ new Map();
  /** foreign states we are subscribed to */
  subscribedInputs = /* @__PURE__ */ new Set();
  /** chart (re)starts are executed one after another */
  chartQueue = Promise.resolve();
  /** for the astro helper functions */
  location = null;
  constructor(options = {}) {
    super({
      ...options,
      name: "statechart"
    });
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
      native: {}
    });
    await this.loadLocation();
    const objects = await this.getForeignObjectsAsync(`${this.namespace}.charts.*`, "channel");
    for (const [id, obj] of Object.entries(objects)) {
      const chartId = this.getChartId(id);
      if (chartId) {
        await this.startChart(chartId, obj, true);
      }
    }
    this.subscribeObjects("charts.*");
  }
  /**
   * Reads the location of the ioBroker system settings, used by isDaytime() and astroTime()
   */
  async loadLocation() {
    const config = await this.getForeignObjectAsync("system.config");
    const latitude = parseFloat(String(config?.common?.latitude ?? ""));
    const longitude = parseFloat(String(config?.common?.longitude ?? ""));
    if (Number.isFinite(latitude) && Number.isFinite(longitude)) {
      this.location = { latitude, longitude };
    } else {
      this.log.info("No location configured in the system settings, isDaytime() and astroTime() do not work");
    }
  }
  /**
   * Extracts the chart ID from the ID of a chart object
   *
   * @param id Object ID
   * @returns undefined if the ID is no chart object
   */
  getChartId(id) {
    const prefix = `${this.namespace}.charts.`;
    if (!id.startsWith(prefix)) {
      return void 0;
    }
    const chartId = id.substring(prefix.length);
    return chartId.includes(".") ? void 0 : chartId;
  }
  /**
   * @param chartId Chart ID
   * @param obj Chart object
   * @param restore Continue with the persisted state instead of the initial state
   */
  async startChart(chartId, obj, restore = false) {
    const chart = obj?.type === "channel" ? obj.native?.chart : void 0;
    if (!chart) {
      return;
    }
    await this.createChartStates(chartId);
    const empty = !chart.states?.length;
    if (!chart.enabled || empty) {
      if (empty) {
        this.log.warn(`Chart "${chart.name}" has no states, it is not started`);
      } else {
        this.log.info(`Chart "${chart.name}" is paused`);
      }
      await this.setState(`charts.${chartId}.activeState`, "", true);
      await this.setState(`charts.${chartId}.activeStateIds`, "[]", true);
      return;
    }
    const runtime = new import_chart_runtime.ChartRuntime(chartId, chart, {
      readState: async (id) => (await this.getForeignStateAsync(id))?.val ?? null,
      writeState: async (id, val, ack = false) => {
        await this.setForeignStateAsync(id, val, ack);
      },
      sendTo: (instance, command, message) => this.sendTo(instance, command, message),
      getLocation: () => this.location,
      onActiveChange: ({ names, ids }) => {
        void this.setState(`charts.${chartId}.activeState`, names, true);
        void this.setState(`charts.${chartId}.activeStateIds`, JSON.stringify(ids), true);
      },
      persist: (data) => {
        void this.setState(`charts.${chartId}.snapshot`, JSON.stringify(data), true);
      },
      loadPersisted: async () => {
        const state = await this.getStateAsync(`charts.${chartId}.snapshot`);
        return typeof state?.val === "string" && state.val ? JSON.parse(state.val) : null;
      },
      log: this.log
    });
    try {
      await runtime.start({ restore });
    } catch (err) {
      this.log.error(`Cannot start chart "${chart.name}": ${err.message}`);
      return;
    }
    this.runtimes.set(chartId, runtime);
    this.updateSubscriptions();
    this.log.info(`Chart "${chart.name}" started`);
  }
  /**
   * @param chartId Chart ID
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
   * @param chartId Chart ID
   */
  async createChartStates(chartId) {
    await this.setObjectNotExistsAsync(`charts.${chartId}.activeState`, {
      type: "state",
      common: {
        name: "Active state",
        type: "string",
        role: "text",
        read: true,
        write: false
      },
      native: {}
    });
    await this.setObjectNotExistsAsync(`charts.${chartId}.snapshot`, {
      type: "state",
      common: {
        name: "Stored state of the chart, restored after a restart of the adapter",
        type: "string",
        role: "json",
        read: true,
        write: false
      },
      native: {}
    });
    await this.setObjectNotExistsAsync(`charts.${chartId}.activeStateIds`, {
      type: "state",
      common: {
        name: "IDs of all active states",
        type: "string",
        role: "json",
        read: true,
        write: false
      },
      native: {}
    });
  }
  /**
   * Subscribes to all inputs of the running charts and unsubscribes from the ones no longer used
   */
  updateSubscriptions() {
    const needed = new Set([...this.runtimes.values()].flatMap((runtime) => runtime.inputStateIds));
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
   * @param callback Callback function
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
   * @param id Object ID
   * @param obj Object
   */
  onObjectChange(id, obj) {
    const chartId = this.getChartId(id);
    if (!chartId) {
      return;
    }
    this.chartQueue = this.chartQueue.then(async () => {
      this.stopChart(chartId);
      await this.startChart(chartId, obj);
    }).catch((err) => this.log.error(`Cannot restart chart ${chartId}: ${err.message}`));
  }
  /**
   * Is called if a subscribed state changes
   *
   * @param id State ID
   * @param state State object
   */
  onStateChange(id, state) {
    if (!state) {
      return;
    }
    for (const runtime of this.runtimes.values()) {
      runtime.handleInput(id, state.val, { ack: state.ack });
    }
  }
}
if (require.main !== module) {
  module.exports = (options) => new Statechart(options);
} else {
  (() => new Statechart())();
}
//# sourceMappingURL=main.js.map
