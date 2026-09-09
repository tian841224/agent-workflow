import { changedPaths, JsonObject, normalizeRepoPath } from "../core.js";

export const covers = (scopes: string[], path: string): boolean => {
  const normalizedPath = normalizeRepoPath(path);
  return scopes.some((scope) => {
    const normalizedScope = normalizeRepoPath(scope);
    return normalizedPath === normalizedScope || normalizedPath.startsWith(normalizedScope.replace(/\/?$/, "/"));
  });
};
// Declaring file_ownership declares a boundary, so a delivery that reaches outside it is a
// violation in its own right — never something diff-scoped review is allowed to filter away. The
// baseline is base_commit when the task records one, else the base a role review was taken against.
export function ownershipErrors(state: JsonObject, repoRoot: string, evidence: JsonObject[], livePaths?: string[]): string[] {
  const ownership = Array.isArray(state.file_ownership) ? state.file_ownership.map(String) : [];
  if (!ownership.length) return [];
  const base = String(state.base_commit || evidence.find((item) => typeof item.reviewed_base === "string")?.reviewed_base || "");
  if (!base) return ["file_ownership is declared but the task records no base_commit to measure the delivery against"];
  try {
    const paths = livePaths && String(state.base_commit || "") === base ? livePaths : changedPaths(repoRoot, base);
    const outside = paths.filter((changed) => !covers(ownership, changed));
    if (outside.length) return [`ownership violation: ${outside.slice(0, 5).join(", ")}${outside.length > 5 ? `, +${outside.length - 5} more` : ""} changed outside file_ownership (${ownership.join(", ")})`];
  } catch (error) { return [`ownership cannot be checked: ${String((error as Error).message || error)}`]; }
  return [];
}
