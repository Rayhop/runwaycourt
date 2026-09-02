/**
 * Hand-written row types mirroring supabase/migrations/0001_init.sql.
 *
 * numeric(78,0) columns come back from PostgREST as strings (they exceed
 * Number.MAX_SAFE_INTEGER), so they are typed as string here and converted to
 * bigint at the edges. Never JSON.parse them into numbers.
 */

export type FileTier = "warm" | "cold"
export type FilePriority = "critical" | "normal" | "archive" | "junk"
export type FileStatus = "active" | "downgraded" | "dropped"
export type SessionStatus = "open" | "closed" | "failed"
export type VerdictKind = "KEEP" | "DOWNGRADE" | "DROP"

export interface AgentAccountRow {
  id: number
  // Added by 0003_multi_tenant.sql.
  user_id: string | null
  wallet_address: string | null
  session_key_address: string | null
  session_key_expires_at: string | null
  session_key_permissions: string[]
  session_key_tx: string | null
  funds: string
  debt: string
  last_settled_at: string
  runway_threshold_epochs: number
  target_runway_epochs: number
  created_at: string
}

export interface FileRow {
  id: string
  user_id: string | null
  name: string
  piece_cid: string | null
  size_bytes: number
  cost_per_epoch: string
  tier: FileTier
  priority: FilePriority
  status: FileStatus
  last_accessed_at: string | null
  created_at: string
  dropped_at: string | null
  // Added by 0002_filecoin_links.sql. Null until `npm run sync:filecoin` links
  // the row to a real FWSS data set.
  data_set_id: string | null
  pdp_rail_id: string | null
  cdn_rail_id: string | null
  provider: string | null
  synced_at: string | null
}

export interface AccessEventRow {
  id: number
  file_id: string
  occurred_at: string
}

export interface CourtSessionRow {
  id: number
  user_id: string | null
  opened_at: string
  closed_at: string | null
  status: SessionStatus
  trigger_runway_epochs: number | null
  runway_before_epochs: number | null
  runway_after_epochs: number | null
  budget_per_epoch: string | null
  spend_per_epoch: string | null
  kept_count: number
  downgraded_count: number
  dropped_count: number
  narration: string | null
  chain_source: string
}

export interface ScoreBreakdown {
  accessTerm: number
  recencyTerm: number
  priorityTerm: number
  costPenalty: number
  accessesLast7d: number
  daysSinceAccess: number | null
  costPerEpoch: string
}

export interface VerdictRow {
  id: number
  session_id: number
  file_id: string | null
  file_name: string
  verdict: VerdictKind
  rank: number
  score: number
  score_breakdown: ScoreBreakdown
  rationale: string
  tx_hash: string | null
  executed: boolean
  execution_note: string | null
  created_at: string
}
