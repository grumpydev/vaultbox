import type { SyncOperation, SyncPlan } from "./sync-plan";

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

  lines.push("", `Conflicts (${plan.conflicts.length})`);
  for (const conflict of plan.conflicts) {
    lines.push(`- ${JSON.stringify(conflict.path)}: ${JSON.stringify(conflict.message)}`);
  }

  return lines.join("\n");
}
