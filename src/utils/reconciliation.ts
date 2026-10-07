import type {
  AuditReceipt,
  BackfillEntry,
  BirdRecord,
  ReconciliationConflict,
  ReconciliationDifference,
  ReconciliationResult,
  ReceiptMatch,
  SettleResult,
  ValidationIssue,
} from '../types'
import { normalizeRingCode } from './normalization'

export interface MatchOutcome {
  record: BirdRecord
  matchedBy: Array<'centerRecordId' | 'localRingCode' | 'observedAt'>
}

/** 环号是否对上：中心归一化可能与本地不同，用本地归一化器重算后仍算对上，但不覆盖本地值 */
export function ringCodeMatches(receiptRing: string, record: BirdRecord): boolean {
  const candidate = receiptRing.trim()
  if (!candidate) return false
  if (candidate === record.rawRingCode || candidate === record.normalizedRingCode) return true
  const renormalized = normalizeRingCode(candidate)
  if (renormalized.normalized === record.normalizedRingCode) return true
  if (renormalized.original === record.rawRingCode) return true
  return false
}

/** 时间是否对上：按观察日期匹配 */
export function observedTimeMatches(receiptTime: string, recordTime: string): boolean {
  return receiptTime.trim().slice(0, 10) === recordTime.trim().slice(0, 10)
}

/**
 * 回执按中心记录号、本地环号和时间对上。
 * 中心记录号最强；否则本地环号 + 时间同时满足才算对上。
 */
export function matchReceiptToRecord(
  receipt: AuditReceipt,
  records: BirdRecord[],
): MatchOutcome | null {
  if (receipt.centerRecordId) {
    const byCenter = records.find((record) => record.centerRecordId === receipt.centerRecordId)
    if (byCenter) return { record: byCenter, matchedBy: ['centerRecordId'] }
  }
  const ringMatches = records.filter((record) => ringCodeMatches(receipt.localRingCode, record))
  if (!ringMatches.length) return null
  const withTime = ringMatches.filter((record) => observedTimeMatches(receipt.observedAt, record.observedAt))
  if (withTime.length === 1) {
    return { record: withTime[0], matchedBy: ['localRingCode', 'observedAt'] }
  }
  if (withTime.length > 1) return null // 环号+时间仍不唯一，不强行匹配
  return null
}

export interface DedupOutcome {
  effective: AuditReceipt[]
  duplicates: string[]
  superseded: string[]
}

/**
 * 同一份回执只算一次：按回执编号分组，取最高版本。
 * 同版本重发算重复；被更高版本取代的旧版本不再生效（晚到也不倒退状态）。
 */
export function deduplicateReceipts(receipts: AuditReceipt[]): DedupOutcome {
  const grouped = new Map<string, AuditReceipt[]>()
  receipts.forEach((receipt) => {
    const list = grouped.get(receipt.receiptId) || []
    list.push(receipt)
    grouped.set(receipt.receiptId, list)
  })
  const effective: AuditReceipt[] = []
  const duplicates: string[] = []
  const superseded: string[] = []
  grouped.forEach((list, receiptId) => {
    const sorted = [...list].sort((a, b) => b.version - a.version)
    const topVersion = sorted[0].version
    const top = sorted.filter((receipt) => receipt.version === topVersion)
    effective.push(top[0])
    if (top.length > 1) duplicates.push(receiptId)
    if (sorted.length > top.length) superseded.push(receiptId)
  })
  return { effective, duplicates, superseded }
}

export interface ReconcileInput {
  records: BirdRecord[]
  receipts: AuditReceipt[]
  differences: ReconciliationDifference[]
}

/** 对账：只计算结果，不改记录。对不上的先列出。 */
export function reconcileReceipts(input: ReconcileInput): ReconciliationResult {
  const { records, receipts, differences } = input
  const { effective, duplicates, superseded } = deduplicateReceipts(receipts)
  const matches: ReceiptMatch[] = []
  const unmatchedReceipts: AuditReceipt[] = []
  const frozenRecordIds: string[] = []
  const reopenedRecordIds: string[] = []
  const conflicts: ReconciliationConflict[] = []

  effective.forEach((receipt) => {
    const outcome = matchReceiptToRecord(receipt, records)
    if (!outcome) {
      unmatchedReceipts.push(receipt)
      matches.push({ receipt, recordId: null, matchedBy: [], disposition: 'unmatched' })
      return
    }
    const { record, matchedBy } = outcome
    // 写入冲突：记录已被中心通过冻结，生效回执却判退
    if (record.frozen && receipt.verdict === 'rejected') {
      conflicts.push({
        receiptId: receipt.receiptId,
        recordId: record.id,
        reason: '记录已被中心审核通过冻结，生效回执却判退，写入冲突。',
      })
      matches.push({
        receipt,
        recordId: record.id,
        matchedBy,
        disposition: 'conflict',
        conflictReason: '冻结记录收到判退回执',
      })
      return
    }
    matches.push({ receipt, recordId: record.id, matchedBy, disposition: 'matched' })
    if (receipt.verdict === 'approved') {
      if (!frozenRecordIds.includes(record.id)) frozenRecordIds.push(record.id)
    } else if (!reopenedRecordIds.includes(record.id)) {
      reopenedRecordIds.push(record.id)
    }
  })

  // 回填：缺回执编号的记录按初始（最早回传）回执回填
  const earliestByRecord = new Map<string, AuditReceipt>()
  matches.forEach((match) => {
    if (match.disposition !== 'matched' || !match.recordId) return
    const prev = earliestByRecord.get(match.recordId)
    if (!prev || match.receipt.receivedAt < prev.receivedAt) {
      earliestByRecord.set(match.recordId, match.receipt)
    }
  })
  const backfilled: BackfillEntry[] = []
  earliestByRecord.forEach((receipt, recordId) => {
    const record = records.find((item) => item.id === recordId)
    if (record && (!record.receiptId || !record.centerRecordId)) {
      backfilled.push({
        recordId,
        receiptId: receipt.receiptId,
        centerRecordId: receipt.centerRecordId,
      })
    }
  })

  // 待移交清单：未冻结的记录（含判退重开、从未结算）
  const pendingRecordIds = records.filter((record) => !record.frozen).map((record) => record.id)

  const matchedCount = matches.filter((match) => match.disposition === 'matched').length
  return {
    id: `REC-${new Date().toISOString().slice(0, 10).replace(/-/g, '')}-${String(Date.now()).slice(-6)}`,
    ranAt: new Date().toISOString(),
    matches,
    unmatchedReceipts,
    frozenRecordIds,
    reopenedRecordIds,
    backfilled,
    differences,
    pendingRecordIds,
    duplicateReceiptIds: duplicates,
    supersededReceiptIds: superseded,
    conflicts,
    receiptCount: receipts.length,
    matchedCount,
  }
}

/**
 * 应用对账结果。纯函数，便于在写入失败时放弃整批修改。
 * 有冲突时不改动任何记录，返回恢复状态（从已对上的记录恢复）。
 */
export function settleRecordsFromResult(
  records: BirdRecord[],
  issues: ValidationIssue[],
  result: ReconciliationResult,
): { records: BirdRecord[]; issues: ValidationIssue[]; settle: SettleResult } {
  if (result.conflicts.length) {
    const recoveredRecordIds = result.matches
      .filter((match) => match.recordId && match.disposition === 'matched')
      .map((match) => match.recordId as string)
    return {
      records,
      issues,
      settle: {
        ok: false,
        applied: { frozen: [], reopened: [], backfilled: [] },
        recovered: true,
        recoveredRecordIds,
        conflicts: result.conflicts,
        message: `检测到 ${result.conflicts.length} 处写入冲突，已从 ${recoveredRecordIds.length} 条已对上记录恢复，未改动任何记录。`,
      },
    }
  }

  const now = new Date().toISOString()
  const backfillByRecord = new Map(result.backfilled.map((entry) => [entry.recordId, entry]))
  const nextRecords = records.map((record) => {
    let next = record
    const backfill = backfillByRecord.get(record.id)
    if (backfill && (!next.receiptId || !next.centerRecordId)) {
      next = {
        ...next,
        receiptId: backfill.receiptId,
        centerRecordId: backfill.centerRecordId || next.centerRecordId,
      }
    }
    if (result.frozenRecordIds.includes(record.id)) {
      next = { ...next, frozen: true, frozenAt: now, frozenReason: '中心审核通过' }
    } else if (result.reopenedRecordIds.includes(record.id)) {
      next = { ...next, frozen: false, frozenAt: undefined, frozenReason: undefined }
    }
    return next
  })

  const nextIssues = issues.map((issue) => {
    if (result.reopenedRecordIds.includes(issue.recordId) && issue.status !== 'open') {
      return { ...issue, status: 'open' as const, returnReason: undefined }
    }
    return issue
  })

  return {
    records: nextRecords,
    issues: nextIssues,
    settle: {
      ok: true,
      applied: {
        frozen: result.frozenRecordIds,
        reopened: result.reopenedRecordIds,
        backfilled: result.backfilled,
      },
      recovered: false,
      recoveredRecordIds: [],
      conflicts: [],
      message: `已冻结 ${result.frozenRecordIds.length} 条通过记录，重开 ${result.reopenedRecordIds.length} 条判退记录，回填 ${result.backfilled.length} 条回执编号。`,
    },
  }
}
