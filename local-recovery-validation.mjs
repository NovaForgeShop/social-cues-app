import vm from "node:vm";

// Reuse the shipped UI's bounded pure content validators verbatim. Only trusted
// application source is compiled; recovery files are data, never executable code.
export function localRecoveryValidation(html) {
  const context = vm.createContext({ URL });
  for (const [start, end] of [
    ["// Posting pack: pure projection", "// End posting pack pure helpers."],
    ["// Manual proof: pure validation", "// End manual proof pure helpers."],
    ["// Self-launch evidence: pure selected-record projection", "// End self-launch evidence pure helpers."],
    ["// Content recovery: strict projection", "// End content recovery pure helpers."]
  ]) {
    const a = html.indexOf(start), b = html.indexOf(end, a);
    if (a < 0 || b <= a) throw new Error("local_recovery_validator_unavailable");
    vm.runInContext(html.slice(a, b), context);
  }
  return {
    project: value => JSON.parse(JSON.stringify(context.recoveryContent(value))),
    conflict: (current, content) => context.recoveryConflict(current, content)
  };
}
