import { z } from "zod";
import { defineIpcRequest } from "./contract";

const noInput = z.tuple([]);
const numericInput = z.number().int().min(0);
const limitInput = z.number().int().min(1).max(100);
const nameInput = z.string().trim().min(1).max(200);
const searchOptionsInput = z.record(z.string(), z.unknown());
const createInput = z.tuple([nameInput, searchOptionsInput]);
const queryWithLimit = z.tuple([z.string(), limitInput]);
const relatedInput = z.tuple([z.string().trim().min(1), z.number().int().min(1).max(50)]);
const sessionKeyInput = z.tuple([z.string().trim().min(1).max(2_000)]);
const recordSearchInput = z.tuple([z.string(), numericInput, searchOptionsInput.nullable()]);

export const DISCOVERY_IPC = {
  listSavedSearches: defineIpcRequest("discovery:saved-searches-list", noInput),
  createSavedSearch: defineIpcRequest("discovery:saved-searches-create", createInput),
  deleteSavedSearch: defineIpcRequest("discovery:saved-searches-delete", z.tuple([numericInput])),
  touchSavedSearch: defineIpcRequest("discovery:saved-searches-touch", z.tuple([numericInput])),
  listRecentSearches: defineIpcRequest("discovery:history-recent", z.tuple([limitInput])),
  searchHistory: defineIpcRequest("discovery:history-search", queryWithLimit),
  clearSearchHistory: defineIpcRequest("discovery:history-clear", noInput),
  recordSearch: defineIpcRequest("discovery:history-record", recordSearchInput),
  getRelatedSessions: defineIpcRequest("discovery:related-sessions", relatedInput),
  getSessionFamily: defineIpcRequest("discovery:session-family", sessionKeyInput),
} as const;
