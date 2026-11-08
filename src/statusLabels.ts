// Shared Walrus aggregator health labels. Pure mapping, no JSX, no I/O:
// safe to unit-test outside the browser bundle. Unknown values pass
// through verbatim (honest display) and never map to healthy.
export type WalrusAggregatorTone = 'ok' | 'warn' | 'error' | 'unknown'

export interface WalrusAggregatorLabel {
  label: string
  tone: WalrusAggregatorTone
}

export function walrusAggregatorStatusLabel(status: string | null | undefined): WalrusAggregatorLabel {
  switch (status) {
    case 'probe_accepted':
      return { label: 'Accepted', tone: 'ok' }
    case 'probe_rejected':
      return { label: 'Rejected — reachable, inconclusive', tone: 'warn' }
    case 'service_error':
      return { label: 'Service error', tone: 'error' }
    case 'unreachable':
      return { label: 'Unreachable', tone: 'error' }
    // Legacy values from before the probe vocabulary (same meanings).
    case 'reachable':
      return { label: 'Accepted', tone: 'ok' }
    case 'checking':
      return { label: 'Checking', tone: 'unknown' }
    default:
      return { label: status || 'Unknown', tone: 'unknown' }
  }
}
