import { readFileSync } from "node:fs";

/** Split a SQL file on "-- @@" separator lines; drop comment-only lines at the top of each part. */
export function splitStatements(text: string, vars: Record<string, string> = {}): string[] {
  return text
    .split(/\n-- @@\s*\n/)
    .map((part) =>
      part
        .split("\n")
        .filter((l) => !/^\s*--/.test(l))
        .join("\n")
        .trim(),
    )
    .filter(Boolean)
    .map((s) => s.replace(/\$\{(\w+)\}/g, (_, k: string) => vars[k] ?? ""));
}

export function readStatements(path: string, vars: Record<string, string> = {}): string[] {
  return splitStatements(readFileSync(path, "utf8"), vars);
}
