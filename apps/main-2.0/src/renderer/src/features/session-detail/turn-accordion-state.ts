import type { SessionTurnDetail } from "../../../../core/types";

export interface TurnAccordionState {
  sessionKey: string;
  expandedTurnIds: Set<string>;
  detailsById: Record<string, SessionTurnDetail | undefined>;
  loadingTurnIds: Set<string>;
  errorsById: Record<string, string | undefined>;
}

export type TurnAccordionAction =
  | { type: "reset"; sessionKey: string }
  | { type: "toggle"; turnId: string }
  | { type: "open"; turnId: string }
  | { type: "load-started"; turnId: string }
  | { type: "load-succeeded"; turnId: string; detail: SessionTurnDetail }
  | { type: "load-failed"; turnId: string; error: string };

export function createTurnAccordionState(sessionKey: string): TurnAccordionState {
  return {
    sessionKey,
    expandedTurnIds: new Set(),
    detailsById: {},
    loadingTurnIds: new Set(),
    errorsById: {},
  };
}

export function turnAccordionReducer(
  state: TurnAccordionState,
  action: TurnAccordionAction,
): TurnAccordionState {
  if (action.type === "reset") return createTurnAccordionState(action.sessionKey);

  if (action.type === "toggle" || action.type === "open") {
    const expandedTurnIds = new Set(state.expandedTurnIds);
    if (action.type === "open") {
      expandedTurnIds.add(action.turnId);
    } else if (expandedTurnIds.has(action.turnId)) {
      expandedTurnIds.delete(action.turnId);
    } else {
      expandedTurnIds.add(action.turnId);
    }
    return { ...state, expandedTurnIds };
  }

  const loadingTurnIds = new Set(state.loadingTurnIds);
  const errorsById = { ...state.errorsById };
  if (action.type === "load-started") {
    loadingTurnIds.add(action.turnId);
    delete errorsById[action.turnId];
    return { ...state, loadingTurnIds, errorsById };
  }

  loadingTurnIds.delete(action.turnId);
  if (action.type === "load-succeeded") {
    return {
      ...state,
      loadingTurnIds,
      errorsById,
      detailsById: { ...state.detailsById, [action.turnId]: action.detail },
    };
  }

  errorsById[action.turnId] = action.error;
  return { ...state, loadingTurnIds, errorsById };
}
