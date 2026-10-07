export type IssueSeverity = 'error' | 'warning' | 'review'
export type IssueStatus = 'open' | 'accepted' | 'returned' | 'corrected' | 'reopened'
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
  /** 中心判退后按原因重开时记录的说明 */
  reopenReason?: string
  /** 重开前的问题状态，改判通过时据此还原 */
  preReopenStatus?: IssueStatus
  detectedAt: string
}

export interface OperationSnapshot {
  records: BirdRecord[]
  issues: ValidationIssue[]
}

export interface OperationLog {
  id: string
  action:
    | 'batch_fix'
    | 'accept'
    | 'return'
    | 'manual_edit'
    | 'reset'
    | 'transfer_pack'
    | 'receipt_apply'
    | 'receipt_recover'
    | 'local_correction'
  title: string
  detail: string
  count: number
  timestamp: string
  rolledBack: boolean
  /** 中心已通过等不可回滚动作的快照不允许恢复 */
  locked?: boolean
  snapshot: OperationSnapshot
}

export interface IssueRule {
  type: IssueType
  severity: IssueSeverity
  label: string
  description: string
  correctionMode: 'automatic' | 'manual'
}

/* ============================ 移交与回执对账 ============================ */

/** 进入移交包后工具内的定稿状态 */
export type TransferStatus = 'pending' | 'transferred' | 'approved' | 'rejected'

/** 回执处置结论（中心判退仍算已处理，但记录会重开） */
export type ReceiptDecision = 'approved' | 'rejected'

/** 回执登记状态：同一份回执只生效一次，晚到旧版本不倒退状态 */
export type ReceiptIngestStatus =
  | 'applied'
  | 'duplicate'
  | 'superseded'
  | 'stale'
  | 'failed'
  | 'recovered'

/** 中心记录号 + 环号 + 时间 对不上的具体原因，只列出不改记录 */
export type ReconcileMismatchKind =
  | 'record_missing'
  | 'ring_mismatch'
  | 'time_mismatch'
  | 'duplicate_center_ref'

/** 差异来源：通过后本地更正 vs 中心归一化呈现差异（均不得冲掉本地值） */
export type FieldDifferenceSource = 'local_correction' | 'center_presentation'

/** 移交包中的一条定稿记录快照 */
export interface TransferManifestItem {
  centerRecordNo: string
  recordId: string
  localRawRingCode: string
  localNormalizedRingCode: string
  observedAt: string
  packedAt: string
}

export interface TransferBatch {
  id: string
  label: string
  center: string
  packedAt: string
  manifest: TransferManifestItem[]
  /** 移交时的初始回执编号（可能为空，用于历史数据回填） */
  initialReceiptId?: string
}

export interface ReceiptLine {
  centerRecordNo: string
  decision: ReceiptDecision
  reason?: string
  /** 中心按其口径归一化后的环号，仅用于呈现比对，不采信覆盖 */
  centerRingCode?: string
  observedAt?: string
  /** 中心回传的本地记录编号，仅作参考，不参与主键匹配 */
  recordIdRef?: string
}

export interface CenterReceipt {
  id: string
  batchId: string
  version: number
  issuedAt: string
  lines: ReceiptLine[]
}

export interface ReceiptIngestion {
  receiptId: string
  batchId: string
  version: number
  issuedAt: string
  receivedAt: string
  status: ReceiptIngestStatus
  applied: number
  stale: number
  duplicate: number
  unmatched: number
  detail: string
  /** 写入失败后据此从已对上的记录恢复 */
  recoveryJournalId?: string
  fileLabel: string
}

export interface ReconcileMismatch {
  id: string
  receiptId: string
  batchId: string
  line: ReceiptLine
  kind: ReconcileMismatchKind
  detail: string
  manifestItem?: TransferManifestItem
  resolved: boolean
  resolvedNote?: string
  receivedAt: string
}

export interface FieldDifference {
  field: keyof BirdRecord
  localValue: string
  centerValue: string
  source: FieldDifferenceSource
  noticedAt: string
  detail: string
}

export type LedgerWrite =
  | {
      kind: 'approved'
      receiptId: string
      receiptVersion: number
      issuedAt: string
      at: string
      /** 通过瞬间冻结的本地记录，之后任何更正都只能列差异 */
      frozenSnapshot: BirdRecord
      centerRingCode?: string
    }
  | {
      kind: 'rejected'
      receiptId: string
      receiptVersion: number
      issuedAt: string
      at: string
      reason: string
      centerRingCode?: string
    }

export interface LedgerEntry {
  centerRecordNo: string
  recordId: string
  batchId: string
  status: TransferStatus
  transferredAt: string
  current?: LedgerWrite
  history: LedgerWrite[]
  differences: FieldDifference[]
}

export interface PendingCorrection {
  recordId: string
  field: keyof BirdRecord
  newValue: string
  reason: string
  createdAt: string
}

/** 对账写入日志：先落日志再提交台账，失败可按日志逐条恢复 */
export type JournalWrite =
  | (Extract<LedgerWrite, { kind: 'approved' }> & { centerRecordNo: string })
  | (Extract<LedgerWrite, { kind: 'rejected' }> & { centerRecordNo: string })

export interface ReconcileJournal {
  id: string
  receiptId: string
  batchId: string
  createdAt: string
  writes: JournalWrite[]
  replayed: boolean
}

/** 对账整体状态：批次、台账、回执登记、收件箱、挂起清单与恢复日志 */
export interface ReconcileState {
  batches: TransferBatch[]
  ledger: LedgerEntry[]
  ingestions: ReceiptIngestion[]
  inbox: CenterReceipt[]
  mismatches: ReconcileMismatch[]
  pendingCorrections: { recordId: string }[]
  journals: ReconcileJournal[]
  failureArmed: boolean
}

