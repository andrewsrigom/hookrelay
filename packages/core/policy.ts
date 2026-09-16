/** Times are milliseconds unless the name says otherwise. Shared by workers and CDK. */
export const policy = {
  maxEndpoints: 20,
  maxPayloadBytes: 32 * 1024,
  requestTimeoutMs: 8000,
  leaseMs: 30000,
  maxAttempts: 5,
  retryDelaysMs: [2000, 5000, 15000, 60000] as readonly number[],
  workerTimeoutSeconds: 20,
  queueVisibilitySeconds: 120,
  maxInfrastructureReceives: 8,
};

export function isRetryable(status?: number): boolean {
  return status === undefined || status === 408 || status === 429 || status >= 500;
}

export function retryDelay(attempt: number, retryAfterMs?: number): number {
  const configured =
    policy.retryDelaysMs[Math.min(attempt - 1, policy.retryDelaysMs.length - 1)] ?? 60000;
  // SQS message delays cannot exceed 15 minutes.
  return Math.min(900000, Math.max(configured, retryAfterMs ?? 0));
}
