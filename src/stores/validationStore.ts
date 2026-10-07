import { create } from 'zustand'
import { createMockRecords } from '../data/mockRecords'
import type {
  BackfillEntry,
  BirdRecord,
  IssueSeverity,
  IssueStatus,
  OperationLog,
  ReconciliationConflict,
  ReconciliationDifference,
  SettleResult,
  ValidationIssue,
} from '../types'
import { applyIssueSuggestion, validateRecords } from '../utils/validation'
import { normalizeRecord } from '../utils/normalization'
import { settleRecordsFromResult } from '../utils/reconciliation'

const initialRecords = createMockRecords()
const initialIssues = validateRecords(initialRecords)

interface ValidationState {
  records: BirdRecord[]
  issues: ValidationIssue[]
  operations: OperationLog[]
  selectedIssueIds: string[]
  selectedRecordIds: string[]
  /** 已冻结记录收到的本地更正：只列差异，不改记录 */
  frozenDifferences: ReconciliationDifference[]
  setSelectedIssueIds: (ids: string[]) => void
  setSelectedRecordIds: (ids: string[]) => void
  batchFix: (type: ValidationIssue['type']) => number
  acceptIssues: (ids: string[]) => void
  returnIssues: (ids: string[], reason: string) => void
  updateRecord: (recordId: string, patch: Partial<BirdRecord>, reason: string) => void
  settleRecordsFromReceipts: (args: {
    freezeIds: string[]
    reopenIds: string[]
    backfill: BackfillEntry[]
    differences: ReconciliationDifference[]
    conflicts: ReconciliationConflict[]
    receiptCount: number
  }) => SettleResult
  rollback: (operationId: string) => void
  reset: () => void
}

function operation(
  action: OperationLog['action'],
  title: string,
  detail: string,
  count: number,
  snapshot: OperationLog['snapshot'],
): OperationLog {
  return {
    id: crypto.randomUUID(),
    action,
    title,
    detail,
    count,
    timestamp: new Date().toISOString(),
    rolledBack: false,
    snapshot,
  }
}

export const useValidationStore = create<ValidationState>((set, get) => ({
  records: initialRecords,
  issues: initialIssues,
  operations: [],
  selectedIssueIds: [],
  selectedRecordIds: [],
  frozenDifferences: [],
  setSelectedIssueIds: (ids) => set({ selectedIssueIds: ids }),
  setSelectedRecordIds: (ids) => set({ selectedRecordIds: ids }),
  batchFix: (type) => {
    const state = get()
    const candidates = state.issues.filter(
      (issue) => issue.type === type && issue.status === 'open' && issue.suggestedValue,
    )
    if (!candidates.length) return 0
    const snapshot = {
      records: state.records.map((record) => ({ ...record })),
      issues: state.issues.map((issue) => ({ ...issue })),
    }
    const byRecord = new Map<string, ValidationIssue>()
    candidates.forEach((issue) => byRecord.set(issue.recordId, issue))
    const records = state.records.map((record) => {
      const issue = byRecord.get(record.id)
      return issue ? applyIssueSuggestion(record, issue) : record
    })
    const targetIds = new Set(candidates.map((issue) => issue.id))
    let issues = state.issues.map((issue) =>
      targetIds.has(issue.id) ? { ...issue, status: 'corrected' as const } : issue,
    )
    issues = issues.map((issue) => ({ ...issue }))
    set({
      records,
      issues,
      operations: [
        operation('batch_fix', '按规则批量修正', `已处理 ${candidates.length} 条“${candidates[0].title}”问题。`, candidates.length, snapshot),
        ...state.operations,
      ],
      selectedIssueIds: [],
    })
    return candidates.length
  },
  acceptIssues: (ids) => {
    const state = get()
    const targetIds = new Set(ids)
    const count = state.issues.filter((issue) => targetIds.has(issue.id) && issue.status === 'open').length
    if (!count) return
    set({
      issues: state.issues.map((issue) =>
        targetIds.has(issue.id) && issue.status === 'open'
          ? { ...issue, status: 'accepted' as IssueStatus }
          : issue,
      ),
      operations: [
        operation(
          'accept',
          '接受校验问题',
          '已确认原记录符合现场情况，问题作为已说明项移交。',
          count,
          {
            records: state.records.map((record) => ({ ...record })),
            issues: state.issues.map((issue) => ({ ...issue })),
          },
        ),
        ...state.operations,
      ],
      selectedIssueIds: [],
    })
  },
  returnIssues: (ids, reason) => {
    const state = get()
    const targetIds = new Set(ids)
    const count = state.issues.filter((issue) => targetIds.has(issue.id) && issue.status === 'open').length
    if (!count || !reason.trim()) return
    set({
      issues: state.issues.map((issue) =>
        targetIds.has(issue.id) && issue.status === 'open'
          ? { ...issue, status: 'returned', returnReason: reason.trim() }
          : issue,
      ),
      operations: [
        operation(
          'return',
          '退回来源班组',
          `退回原因：${reason.trim()}`,
          count,
          {
            records: state.records.map((record) => ({ ...record })),
            issues: state.issues.map((issue) => ({ ...issue })),
          },
        ),
        ...state.operations,
      ],
      selectedIssueIds: [],
    })
  },
  updateRecord: (recordId, patch, reason) => {
    const state = get()
    const record = state.records.find((item) => item.id === recordId)
    if (!record) return
    // 中心判通过已冻结：本地后到更正只列差异，不改记录、不冲掉人工结论
    if (record.frozen) {
      const field = Object.keys(patch)[0] || 'record'
      const localValue = String((record as unknown as Record<string, unknown>)[field] ?? '')
      const centerValue = String((patch as unknown as Record<string, unknown>)[field] ?? '')
      const difference: ReconciliationDifference = {
        recordId,
        field,
        localValue,
        centerValue,
        reason: reason.trim() || '本地更正与中心口径不一致',
        reportedAt: new Date().toISOString(),
      }
      set({ frozenDifferences: [difference, ...state.frozenDifferences] })
      return
    }
    set({
      records: state.records.map((item) =>
        item.id === recordId ? normalizeRecord({ ...item, ...patch }) : item,
      ),
      issues: state.issues.map((issue) =>
        issue.recordId === recordId && issue.status === 'open'
          ? { ...issue, status: 'corrected' }
          : issue,
      ),
      operations: [
        operation(
          'manual_edit',
          '人工编辑记录',
          reason.trim() || `修正 ${record.id} 的问题字段。`,
          1,
          {
            records: state.records.map((item) => ({ ...item })),
            issues: state.issues.map((issue) => ({ ...issue })),
          },
        ),
        ...state.operations,
      ],
    })
  },
  settleRecordsFromReceipts: (args) => {
    const state = get()
    // 用纯函数计算结果，写入失败时整批放弃、从已对上的记录恢复
    const fakeResult = {
      id: 'settle',
      ranAt: new Date().toISOString(),
      matches: [],
      unmatchedReceipts: [],
      frozenRecordIds: args.freezeIds,
      reopenedRecordIds: args.reopenIds,
      backfilled: args.backfill,
      differences: args.differences,
      pendingRecordIds: [],
      duplicateReceiptIds: [],
      supersededReceiptIds: [],
      conflicts: args.conflicts,
      receiptCount: args.receiptCount,
      matchedCount: args.freezeIds.length + args.reopenIds.length,
    }
    const { records: nextRecords, issues: nextIssues, settle } = settleRecordsFromResult(
      state.records,
      state.issues,
      fakeResult,
    )
    const snapshot = {
      records: state.records.map((record) => ({ ...record })),
      issues: state.issues.map((issue) => ({ ...issue })),
    }
    if (!settle.ok) {
      // 写入失败：恢复到写入前快照，不改动任何记录
      set({
        records: snapshot.records,
        issues: snapshot.issues,
        frozenDifferences: [...args.differences, ...state.frozenDifferences],
        operations: [
          operation(
            'receipt_settle',
            '回执对账（写入失败，已恢复）',
            settle.message,
            0,
            snapshot,
          ),
          ...state.operations,
        ],
      })
      return settle
    }
    set({
      records: nextRecords,
      issues: nextIssues,
      frozenDifferences: [...args.differences, ...state.frozenDifferences],
      operations: [
        operation(
          'receipt_settle',
          '回执对账与冻结',
          settle.message,
          settle.applied.frozen.length + settle.applied.reopened.length,
          snapshot,
        ),
        ...state.operations,
      ],
    })
    return settle
  },
  rollback: (operationId) => {
    const state = get()
    const target = state.operations.find((item) => item.id === operationId)
    if (!target || target.rolledBack) return
    set({
      records: target.snapshot.records.map((record) => ({ ...record })),
      issues: target.snapshot.issues.map((issue) => ({ ...issue })),
      operations: state.operations.map((item) =>
        item.id === operationId ? { ...item, rolledBack: true } : item,
      ),
      selectedIssueIds: [],
      selectedRecordIds: [],
    })
  },
  reset: () => {
    const records = createMockRecords()
    set({
      records,
      issues: validateRecords(records),
      operations: [],
      selectedIssueIds: [],
      selectedRecordIds: [],
      frozenDifferences: [],
    })
    resetHandoverCallback?.()
  },
}))

/** 移交对账模块注册的重置回调，避免两个 store 循环依赖 */
let resetHandoverCallback: (() => void) | null = null
export function registerHandoverReset(callback: () => void) {
  resetHandoverCallback = callback
}

export function filterIssues(
  issues: ValidationIssue[],
  filters: {
    severity?: IssueSeverity | 'all'
    status?: IssueStatus | 'all'
    type?: ValidationIssue['type'] | 'all'
    keyword?: string
  },
) {
  const keyword = filters.keyword?.trim().toLowerCase()
  return issues.filter((issue) => {
    if (filters.severity && filters.severity !== 'all' && issue.severity !== filters.severity) return false
    if (filters.status && filters.status !== 'all' && issue.status !== filters.status) return false
    if (filters.type && filters.type !== 'all' && issue.type !== filters.type) return false
    if (
      keyword &&
      !issue.recordId.toLowerCase().includes(keyword) &&
      !issue.title.toLowerCase().includes(keyword) &&
      !issue.description.toLowerCase().includes(keyword)
    )
      return false
    return true
  })
}
