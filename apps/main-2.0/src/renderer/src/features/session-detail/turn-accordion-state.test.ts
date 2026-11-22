import { describe, expect, it } from "vitest";

import type { SessionTurnDetail } from "../../../../core/types";
import { createTurnAccordionState, turnAccordionReducer } from "./turn-accordion-state";

describe("turnAccordionReducer", () => {
  it("toggles expansion while open is idempotent", () => {
    let state = createTurnAccordionState("session-a");
    state = turnAccordionReducer(state, { type: "toggle", turnId: "t1" });
    expect([...state.expandedTurnIds]).toEqual(["t1"]);
    state = turnAccordionReducer(state, { type: "open", turnId: "t1" });
    expect([...state.expandedTurnIds]).toEqual(["t1"]);
    state = turnAccordionReducer(state, { type: "toggle", turnId: "t1" });
    expect([...state.expandedTurnIds]).toEqual([]);
  });

  it("tracks loading, clears a retried failure, stores loaded details, and resets per session", () => {
    const detail = { id: "t1" } as SessionTurnDetail;
    let state = createTurnAccordionState("session-a");
    state = turnAccordionReducer(state, { type: "load-started", turnId: "t1" });
    state = turnAccordionReducer(state, { type: "load-failed", turnId: "t1", error: "offline" });
    expect(state.loadingTurnIds.has("t1")).toBe(false);
    expect(state.errorsById.t1).toBe("offline");

    state = turnAccordionReducer(state, { type: "load-started", turnId: "t1" });
    expect(state.loadingTurnIds.has("t1")).toBe(true);
    expect(state.errorsById.t1).toBeUndefined();

    state = turnAccordionReducer(state, { type: "load-succeeded", turnId: "t1", detail });
    expect(state.loadingTurnIds.has("t1")).toBe(false);
    expect(state.detailsById.t1).toBe(detail);

    state = turnAccordionReducer(state, { type: "reset", sessionKey: "session-b" });
    expect(state).toEqual(createTurnAccordionState("session-b"));
  });
});
