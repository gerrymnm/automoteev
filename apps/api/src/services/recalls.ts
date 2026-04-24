export interface RecallResult {
  hasOpenRecall: boolean;
  summary: string;
  source: "placeholder";
}

export async function lookupRecallsByVin(vin: string): Promise<RecallResult> {
  const last = vin.trim().toUpperCase().at(-1);
  const hasOpenRecall = last === "7";
  return {
    hasOpenRecall,
    summary: hasOpenRecall
      ? "Open recall placeholder found. Confirm with NHTSA integration before scheduling."
      : "No open recall placeholder result.",
    source: "placeholder"
  };
}
