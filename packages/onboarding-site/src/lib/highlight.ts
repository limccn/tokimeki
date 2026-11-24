/**
 * Tokenizers for the generated shell commands and viewer config JSON.
 *
 * Returns plain token arrays instead of HTML strings so the renderer can build
 * spans with textContent only. Tokens always concatenate back to the input.
 */

export type CodeLanguage = "shell" | "json";

export type CodeTokenKind = "plain" | "keyword" | "key" | "string" | "comment" | "number";

export interface CodeToken {
  readonly text: string;
  readonly kind: CodeTokenKind;
}

const SHELL_PATTERN =
  /(#[^\n]*)|('(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*")|(\$env:[A-Za-z_][A-Za-z0-9_]*|TOKIMEKI_[A-Z0-9_]+)|(\b(?:export|set|tokimeki)\b)|(--?[A-Za-z][A-Za-z0-9-]*)/gm;

const JSON_PATTERN =
  /"(?:[^"\\]|\\.)*"|\btrue\b|\bfalse\b|\bnull\b|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/g;

export function highlightCode(text: string, language: CodeLanguage): CodeToken[] {
  if (text.length === 0) return [];
  return language === "json" ? tokenizeJson(text) : tokenizeShell(text);
}

function tokenizeShell(text: string): CodeToken[] {
  const tokens: CodeToken[] = [];
  let last = 0;
  for (const match of text.matchAll(SHELL_PATTERN)) {
    const index = match.index ?? 0;
    if (index > last) tokens.push({ text: text.slice(last, index), kind: "plain" });
    const value = match[0];
    if (value === undefined) continue;
    let kind: CodeTokenKind = "plain";
    if (match[1] !== undefined) kind = "comment";
    else if (match[2] !== undefined) kind = "string";
    else if (match[3] !== undefined) kind = "key";
    else if (match[4] !== undefined) kind = "keyword";
    else if (match[5] !== undefined) kind = "key";
    tokens.push({ text: value, kind });
    last = index + value.length;
  }
  if (last < text.length) tokens.push({ text: text.slice(last), kind: "plain" });
  return tokens;
}

function tokenizeJson(text: string): CodeToken[] {
  const tokens: CodeToken[] = [];
  let last = 0;
  for (const match of text.matchAll(JSON_PATTERN)) {
    const index = match.index ?? 0;
    if (index > last) tokens.push({ text: text.slice(last, index), kind: "plain" });
    const value = match[0];
    if (value === undefined) continue;
    let kind: CodeTokenKind = "number";
    if (value.startsWith('"')) {
      const rest = text.slice(index + value.length);
      kind = /^\s*:/.test(rest) ? "key" : "string";
    } else if (value === "true" || value === "false" || value === "null") {
      kind = "keyword";
    }
    tokens.push({ text: value, kind });
    last = index + value.length;
  }
  if (last < text.length) tokens.push({ text: text.slice(last), kind: "plain" });
  return tokens;
}
