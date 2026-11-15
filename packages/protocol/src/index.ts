/**
 * Shared tokimeki wire protocol.
 *
 * This package is the single source of truth for binary frame types, control
 * message schemas, error/close codes, u64 handling, and golden fixtures. The
 * normative cross-language description lives in `docs/protocol.md`.
 */
export * from "./constants.js";
export * from "./frames.js";
export * from "./ids.js";
export * from "./messages.js";
export * from "./u64.js";
