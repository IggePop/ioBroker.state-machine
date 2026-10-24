"use strict";

/*
 * The structure of a chart (hierarchy, transition order, kind of transitions) as the runtime executes it.
 * Shared by the runtime and the code generator, so the generated code always shows what is executed.
 */

/**
 * @typedef {import("./chart-model").Chart} Chart
 * @typedef {import("./chart-model").ChartState} ChartState
 * @typedef {import("./chart-model").ChartTransition} ChartTransition
 */

class ChartStructure {
    /**
     * @param {Chart} chart
     */
    constructor(chart) {
        this.chart = chart;
        /** @type {Map<string, ChartState>} */
        this.statesById = new Map(chart.states.map(s => [s.id, s]));
        /** @type {Map<string, ChartState[]>} children by parent ID, "" for the top level */
        this.childrenByParent = new Map();
        for (const state of chart.states) {
            // states with an unknown parent are treated like top level states
            const parent = state.parent && this.statesById.has(state.parent) ? state.parent : "";
            this.childrenByParent.set(parent, [...(this.childrenByParent.get(parent) || []), state]);
        }
        /** @type {Map<string, ChartTransition[]>} transitions by source, sorted by priority */
        this.transitionsBySource = new Map();
        for (const transition of chart.transitions) {
            const list = this.transitionsBySource.get(transition.source) || [];
            this.transitionsBySource.set(transition.source, [...list, transition]);
        }
        for (const list of this.transitionsBySource.values()) {
            // the sort is stable: transitions without priority keep their order, after the others
            list.sort((a, b) => (a.priority ?? Number.MAX_SAFE_INTEGER) - (b.priority ?? Number.MAX_SAFE_INTEGER));
        }
    }

    /**
     * @param {string | null} parentId null for the top level
     * @returns {ChartState[]}
     */
    getChildren(parentId) {
        return this.childrenByParent.get(parentId || "") || [];
    }

    /**
     * The initial state of a level: the configured one if it is a child of this level, otherwise the first child
     *
     * @param {string | null} parentId null for the top level
     * @returns {string | undefined} undefined if the level has no states
     */
    getInitialChild(parentId) {
        const children = this.getChildren(parentId);
        const configured = parentId ? this.statesById.get(parentId)?.initial : this.chart.initial;
        return children.some(s => s.id === configured) ? configured : children[0]?.id;
    }

    /**
     * @param {string} stateId
     * @returns {ChartTransition[]} the transitions starting at the state, sorted by priority
     */
    getTransitions(stateId) {
        return this.transitionsBySource.get(stateId) || [];
    }

    /**
     * @param {string} ancestorId
     * @param {string} id
     * @returns {boolean} true if the state "id" is a (direct or indirect) child of "ancestorId"
     */
    isDescendant(ancestorId, id) {
        let parent = this.statesById.get(id)?.parent;
        // the counter protects against cycles in invalid charts
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
     * @param {ChartTransition} transition
     * @returns {{ inner: boolean; reenter: boolean }} inner: checked after the during action of the source,
     *     the source stays active. reenter: the source state is left and entered again (XState "reenter").
     */
    getTransitionKind(transition) {
        const { source, target } = transition;
        const toChild = this.isDescendant(source, target);
        // an inner transition stays in the source state, only its active child is left
        const inner = toChild && !transition.reenterParent;
        // Like Stateflow, the source state is left and entered again by self transitions, by transitions
        // to an own child which should re-enter the parent, and by transitions from a child to its parent.
        // Without "reenter", XState does not leave the source state if the target is a child of it.
        const reenter = source === target || (toChild && !inner) || this.isDescendant(target, source);
        return { inner, reenter };
    }
}

module.exports = { ChartStructure };
