import { isResolvableConflict, splitConflicts, type SyncOperation, type SyncPlan } from "./sync-plan";

const GROUPS: ReadonlyArray<readonly [SyncOperation["kind"], string]> = [
  ["delete-local", "Local deletes"],
  ["delete-remote", "Remote deletes"],
  ["upload", "Uploads"],
  ["download", "Downloads"],
  ["noop", "No-ops"],
];

export function formatCompleteSyncReport(
  plan: SyncPlan,
  context: { version: string; folderPath: string; createdAt: string },
  /** What Vaultbox would do with each resolvable conflict, keyed by conflict path. */
  proposals?: ReadonlyMap<string, string>,
): string {
  const lines = [
    "Simulation snapshot (not applied)",
    `Version: ${context.version}`,
    `Generated: ${context.createdAt}`,
    `Dropbox folder: ${JSON.stringify(context.folderPath)}`,
    "This snapshot is not a live plan. Run Simulate again after any changes.",
    "Paths may contain private information. Review before sharing.",
    "Paths are JSON-quoted; escapes preserve newlines and other control characters.",
  ];

  for (const [kind, label] of GROUPS) {
    const operations = plan.operations.filter((operation) => operation.kind === kind);
    lines.push("", `${label} (${operations.length})`);
    for (const operation of operations) {
      lines.push(`- ${JSON.stringify(operation.path)}`);
    }
  }

  const { blocking } = splitConflicts(plan.conflicts);
  lines.push("", `Conflicts (${plan.conflicts.length})`);
  if (blocking.length > 0) {
    lines.push(`${blocking.length} of these block the whole sync until the vault is repaired.`);
  }
  for (const conflict of plan.conflicts) {
    const outcome = isResolvableConflict(conflict)
      ? proposals?.get(conflict.path) ?? "needs a decision"
      : "blocks sync";
    lines.push(`- ${JSON.stringify(conflict.path)}: ${JSON.stringify(conflict.message)} [${outcome}]`);
  }

  return lines.join("\n");
}
