export const mobileNotificationMetrics = {
  queued: 0, sent: 0, retry: 0, expired: 0, permanentFailure: 0,
  receiptOk: 0, receiptError: 0, receiptMissing: 0, latencyMsTotal: 0, latencyCount: 0, activeInstallations: 0,
};
export function mobileNotificationMetricsSnapshot() { return { ...mobileNotificationMetrics }; }
