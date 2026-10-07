export type IssueSeverity = 'error' | 'warning' | 'review'
export type IssueStatus = 'open' | 'accepted' | 'returned' | 'corrected'
export type IssueType =
  | 'ring_invalid'
  | 'ring_duplicate'
  | 'species_alias'
  | 'species_unknown'
  | 'coordinate_invalid'
  | 'location_jump'

export interface SpeciesRule {
  canonical: string
  scientificName: string
  aliases: string[]
}

export interface RingScheme {
  prefix: string
  normalizedPrefix: string
  organization: string
  pattern: string
}

export interface BirdRecord {
  id: string
  source: string
  sourceFile: string
  rawRingCode: string
  normalizedRingCode: string
  ringScheme: string
  speciesRaw: string
  speciesCanonical: string
  scientificName: string
  observedAt: string
  location: string
  latitudeRaw: string
  longitudeRaw: string
  latitude: number | null
  longitude: number | null
  recorder: string
  ageCode: string
  sex: string
  remarks: string
  /** 中心记录号：由区域环志中心分配，回执回填或手工登记 */
  centerRecordId?: string
  /** 回执编号：结算该记录的回执编号 */
  receiptId?: string
  /** 冻结：中心审核通过后冻结，本地更正只列差异不改记录 */
  frozen?: boolean
  frozenReason?: string
  frozenAt?: string
}

export interface ValidationIssue {
  id: string
  recordId: string
  type: IssueType
  severity: IssueSeverity
  title: string
  description: string
  field: keyof BirdRecord
  currentValue: string
  suggestedValue: string
  suggestion: string
  status: IssueStatus
  returnReason?: string
  detectedAt: string
}

export interface OperationSnapshot {
  records: BirdRecord[]
  issues: ValidationIssue[]
}

export interface OperationLog {
  id: string
  action: 'batch_fix' | 'accept' | 'return' | 'manual_edit' | 'reset' | 'receipt_settle'
  title: string
  detail: string
  count: number
  timestamp: string
  rolledBack: boolean
  snapshot: OperationSnapshot
}

export interface IssueRule {
  type: IssueType
  severity: IssueSeverity
  label: string
  description: string
  correctionMode: 'automatic' | 'manual'
}

/** 移交批次：一次送往区域环志中心的记录集合 */
export interface HandoverBatch {
  id: string
  name: string
  sentAt: string
  recordIds: string[]
  status: 'sent' | 'partial' | 'settled'
}

/** 审核回执：区域环志中心按批次回传的审核结果 */
export interface AuditReceipt {
  id: string
  /** 回执编号：同一份回执重发时编号相同 */
  receiptId: string
  /** 版本号：越大越新，旧版本不得倒退状态 */
  version: number
  batchId: string
  /** 中心记录号 */
  centerRecordId: string
  /** 本地环号（中心口径，归一化可能与本地不同） */
  localRingCode: string
  /** 时间（观察时间） */
  observedAt: string
  verdict: 'approved' | 'rejected'
  /** 判退原因 */
  reason?: string
  receivedAt: string
}

export type ReceiptDisposition = 'matched' | 'unmatched' | 'conflict'
export type CenterMatchField = 'centerRecordId' | 'localRingCode' | 'observedAt'

/** 单条回执的匹配结果 */
export interface ReceiptMatch {
  receipt: AuditReceipt
  recordId: string | null
  matchedBy: CenterMatchField[]
  disposition: ReceiptDisposition
  conflictReason?: string
}

/** 本地后到更正与中心口径的差异（只列差异，不改记录） */
export interface ReconciliationDifference {
  recordId: string
  field: string
  localValue: string
  centerValue: string
  reason: string
  reportedAt: string
}

/** 回填条目：缺回执编号的记录按初始回执回填 */
export interface BackfillEntry {
  recordId: string
  receiptId: string
  centerRecordId: string
}

export interface ReconciliationConflict {
  receiptId: string
  recordId: string
  reason: string
}

/** 对账结果 */
export interface ReconciliationResult {
  id: string
  ranAt: string
  matches: ReceiptMatch[]
  unmatchedReceipts: AuditReceipt[]
  frozenRecordIds: string[]
  reopenedRecordIds: string[]
  backfilled: BackfillEntry[]
  differences: ReconciliationDifference[]
  pendingRecordIds: string[]
  duplicateReceiptIds: string[]
  supersededReceiptIds: string[]
  conflicts: ReconciliationConflict[]
  receiptCount: number
  matchedCount: number
}

/** 写入结果：含失败恢复信息 */
export interface SettleResult {
  ok: boolean
  applied: { frozen: string[]; reopened: string[]; backfilled: BackfillEntry[] }
  recovered: boolean
  recoveredRecordIds: string[]
  conflicts: ReconciliationConflict[]
  message: string
}
