"use strict";
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);
var chart_structure_exports = {};
__export(chart_structure_exports, {
  ChartStructure: () => ChartStructure
});
module.exports = __toCommonJS(chart_structure_exports);
class ChartStructure {
  constructor(chart) {
    this.chart = chart;
    this.statesById = new Map(chart.states.map((s) => [s.id, s]));
    for (const state of chart.states) {
      const parent = state.parent && this.statesById.has(state.parent) ? state.parent : "";
      this.childrenByParent.set(parent, [...this.childrenByParent.get(parent) || [], state]);
    }
    for (const transition of chart.transitions) {
      const list = this.transitionsBySource.get(transition.source) || [];
      this.transitionsBySource.set(transition.source, [...list, transition]);
    }
    for (const list of this.transitionsBySource.values()) {
      list.sort((a, b) => (a.priority ?? Number.MAX_SAFE_INTEGER) - (b.priority ?? Number.MAX_SAFE_INTEGER));
    }
  }
  statesById;
  /** children by parent ID, "" for the top level */
  childrenByParent = /* @__PURE__ */ new Map();
  /** transitions by source, sorted by priority */
  transitionsBySource = /* @__PURE__ */ new Map();
  /**
   * @param parentId null for the top level
   */
  getChildren(parentId) {
    return this.childrenByParent.get(parentId || "") || [];
  }
  /**
   * The initial state of a level: the configured one if it is a child of this level, otherwise the first child
   *
   * @param parentId null for the top level
   * @returns undefined if the level has no states
   */
  getInitialChild(parentId) {
    const children = this.getChildren(parentId);
    const configured = parentId ? this.statesById.get(parentId)?.initial : this.chart.initial;
    return children.some((s) => s.id === configured) ? configured : children[0]?.id;
  }
  /**
   * @param stateId ID of the source state
   * @returns the transitions starting at the state, sorted by priority
   */
  getTransitions(stateId) {
    return this.transitionsBySource.get(stateId) || [];
  }
  /**
   * @param ancestorId ID of the possible ancestor
   * @param id ID of the possible descendant
   * @returns true if the state "id" is a (direct or indirect) child of "ancestorId"
   */
  isDescendant(ancestorId, id) {
    let parent = this.statesById.get(id)?.parent;
    for (let i = 0; parent && i < this.statesById.size; i++) {
      if (parent === ancestorId) {
        return true;
      }
      parent = this.statesById.get(parent)?.parent;
    }
    return false;
  }
  /**
   * How a transition is executed
   *
   * @param transition The transition
   */
  getTransitionKind(transition) {
    const { source, target } = transition;
    const toChild = this.isDescendant(source, target);
    const inner = toChild && !transition.reenterParent;
    const reenter = source === target || toChild && !inner || this.isDescendant(target, source);
    return { inner, reenter };
  }
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  ChartStructure
});
//# sourceMappingURL=chart-structure.js.map
