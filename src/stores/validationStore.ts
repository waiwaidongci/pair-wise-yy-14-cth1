import { create } from 'zustand'
import { createMockRecords } from '../data/mockRecords'
import { createInitialReconcile } from '../data/mockReconciliation'
import type {
  BirdRecord,
  IssueSeverity,
  IssueStatus,
  OperationLog,
  ReceiptIngestion,
  ReconcileJournal,
  ReconcileState,
  TransferBatch,
  ValidationIssue,
} from '../types'
import { applyIssueSuggestion, validateRecords } from '../utils/validation'
import { normalizeRecord } from '../utils/normalization'
import {
  attachFrozenSnapshots,
  commitReceipt,
  failReceipt,
  journalFromPrepared,
  packTransferBatch,
  prepareReceipt,
  recoverReceipt,
  registerPostFreezeCorrection,
  resolveMismatch,
} from '../utils/reconciliation'

const initialRecords = createMockRecords()
const initialValidation = createInitialReconcile(initialRecords, validateRecords(initialRecords))
const initialIssues = initialValidation.issues
const initialReconcile = initialValidation.reconcile

interface IngestOutcome {
  ok: boolean
  ingestion?: ReceiptIngestion
  resultText: string
  failedJournalId?: string
  reopenedCount: number
  restoredCount: number
}

interface ValidationState {
  records: BirdRecord[]
  issues: ValidationIssue[]
  operations: OperationLog[]
  selectedIssueIds: string[]
  selectedRecordIds: string[]
  reconcile: ReconcileState
  setSelectedIssueIds: (ids: string[]) => void
  setSelectedRecordIds: (ids: string[]) => void
  batchFix: (type: ValidationIssue['type']) => number
  acceptIssues: (ids: string[]) => void
  returnIssues: (ids: string[], reason: string) => void
  updateRecord: (recordId: string, patch: Partial<BirdRecord>, reason: string) => { frozen: boolean }
  rollback: (operationId: string) => { ok: boolean; reason?: string }
  reset: () => void
  packPendingBatch: (label: string) => TransferBatch | null
  ingestInboxReceipt: (receiptKey: string, inboxIndex?: number) => IngestOutcome
  recoverFailedReceipt: (journalId: string) => IngestOutcome
  armFailure: (armed: boolean) => void
  markMismatchResolved: (mismatchId: string, note: string) => void
  simulateFrozenCorrection: (recordId: string, patch: Partial<BirdRecord>, reason: string) => boolean
}

function operation(
  action: OperationLog['action'],
  title: string,
  detail: string,
  count: number,
  snapshot: OperationLog['snapshot'],
  locked = false,
): OperationLog {
  return {
    id: crypto.randomUUID(),
    action,
    title,
    detail,
    count,
    timestamp: new Date().toISOString(),
    rolledBack: false,
    locked,
    snapshot,
  }
}

function snapshotOf(records: BirdRecord[], issues: ValidationIssue[]): OperationLog['snapshot'] {
  return {
    records: records.map((record) => ({ ...record })),
    issues: issues.map((issue) => ({ ...issue })),
  }
}

export const useValidationStore = create<ValidationState>((set, get) => ({
  records: initialRecords,
  issues: initialIssues,
  operations: [],
  selectedIssueIds: [],
  selectedRecordIds: [],
  reconcile: initialReconcile,

  setSelectedIssueIds: (ids) => set({ selectedIssueIds: ids }),
  setSelectedRecordIds: (ids) => set({ selectedRecordIds: ids }),

  batchFix: (type) => {
    const state = get()
    const candidates = state.issues.filter(
      (issue) =>
        issue.type === type &&
        (issue.status === 'open' || issue.status === 'reopened') &&
        issue.suggestedValue,
    )
    if (!candidates.length) return 0
    const snapshot = snapshotOf(state.records, state.issues)
    const byRecord = new Map<string, ValidationIssue>()
    candidates.forEach((issue) => byRecord.set(issue.recordId, issue))
    const records = state.records.map((record) => {
      const issue = byRecord.get(record.id)
      return issue ? applyIssueSuggestion(record, issue) : record
    })
    const targetIds = new Set(candidates.map((issue) => issue.id))
    const issues = state.issues.map((issue) =>
      targetIds.has(issue.id) ? { ...issue, status: 'corrected' as const, reopenReason: undefined } : issue,
    )
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
    const count = state.issues.filter(
      (issue) =>
        targetIds.has(issue.id) &&
        (issue.status === 'open' || issue.status === 'reopened'),
    ).length
    if (!count) return
    set({
      issues: state.issues.map((issue) =>
        targetIds.has(issue.id) && (issue.status === 'open' || issue.status === 'reopened')
          ? { ...issue, status: 'accepted' as IssueStatus, reopenReason: undefined }
          : issue,
      ),
      operations: [
        operation(
          'accept',
          '接受校验问题',
          '已确认原记录符合现场情况，问题作为已说明项移交。',
          count,
          snapshotOf(state.records, state.issues),
        ),
        ...state.operations,
      ],
      selectedIssueIds: [],
    })
  },

  returnIssues: (ids, reason) => {
    const state = get()
    const targetIds = new Set(ids)
    const count = state.issues.filter(
      (issue) =>
        targetIds.has(issue.id) &&
        (issue.status === 'open' || issue.status === 'reopened'),
    ).length
    if (!count || !reason.trim()) return
    set({
      issues: state.issues.map((issue) =>
        targetIds.has(issue.id) && (issue.status === 'open' || issue.status === 'reopened')
          ? { ...issue, status: 'returned', returnReason: reason.trim(), reopenReason: undefined }
          : issue,
      ),
      operations: [
        operation(
          'return',
          '退回来源班组',
          `退回原因：${reason.trim()}`,
          count,
          snapshotOf(state.records, state.issues),
        ),
        ...state.operations,
      ],
      selectedIssueIds: [],
    })
  },

  updateRecord: (recordId, patch, reason) => {
    const state = get()
    const record = state.records.find((item) => item.id === recordId)
    if (!record) return { frozen: false }

    // 中心判通过的记录已冻结：本地后到更正不改定稿，只列差异
    const frozen = state.reconcile.ledger.some(
      (entry) => entry.recordId === recordId && entry.current?.kind === 'approved',
    )
    if (frozen) {
      get().simulateFrozenCorrection(recordId, patch, reason)
      return { frozen: true }
    }

    set({
      records: state.records.map((item) =>
        item.id === recordId ? normalizeRecord({ ...item, ...patch }) : item,
      ),
      issues: state.issues.map((issue) =>
        issue.recordId === recordId && (issue.status === 'open' || issue.status === 'reopened')
          ? { ...issue, status: 'corrected', reopenReason: undefined }
          : issue,
      ),
      operations: [
        operation(
          'manual_edit',
          '人工编辑记录',
          reason.trim() || `修正 ${record.id} 的问题字段。`,
          1,
          snapshotOf(state.records, state.issues),
        ),
        ...state.operations,
      ],
    })
    return { frozen: false }
  },

  rollback: (operationId) => {
    const state = get()
    const target = state.operations.find((item) => item.id === operationId)
    if (!target || target.rolledBack) return { ok: false, reason: '操作不存在或已回滚。' }
    if (target.locked) {
      return { ok: false, reason: '该操作涉及中心回执或移交定稿，按审计要求不可回滚。' }
    }
    // 回滚会改写已冻结记录（中心通过）或抹掉判退重开结论时，拒绝执行
    const frozenIds = new Set(
      state.reconcile.ledger
        .filter((entry) => entry.current?.kind === 'approved')
        .map((entry) => entry.recordId),
    )
    const reopenedIds = new Set(
      state.issues.filter((issue) => issue.status === 'reopened').map((issue) => issue.recordId),
    )
    const conflicts = target.snapshot.records.some((record) => frozenIds.has(record.id))
    const reopenConflicts = target.snapshot.issues.some(
      (issue) => reopenedIds.has(issue.recordId) && issue.status !== 'reopened',
    )
    if (conflicts || reopenConflicts) {
      return { ok: false, reason: '回滚会覆盖中心已通过的冻结记录或判退重开结论，已阻止。' }
    }
    set({
      records: target.snapshot.records.map((record) => ({ ...record })),
      issues: target.snapshot.issues.map((issue) => ({ ...issue })),
      operations: state.operations.map((item) =>
        item.id === operationId ? { ...item, rolledBack: true } : item,
      ),
      selectedIssueIds: [],
      selectedRecordIds: [],
    })
    return { ok: true }
  },

  reset: () => {
    const records = createMockRecords()
    const initialized = createInitialReconcile(records, validateRecords(records))
    set({
      records,
      issues: initialized.issues,
      operations: [],
      selectedIssueIds: [],
      selectedRecordIds: [],
      reconcile: initialized.reconcile,
    })
  },

  /* ----------------------------- 移交批次 ----------------------------- */
  packPendingBatch: (label) => {
    const state = get()
    const nextSeq = state.reconcile.batches.length + 1
    const id = `TB-2026SPR-${String(nextSeq).padStart(2, '0')}`
    const packedAt = new Date().toISOString()
    // 演示环境单批最多打包 60 条，逻辑本身不分页，全量打包时去掉上限即可
    const LIMIT = 60
    const { state: nextReconcile, packed } = packTransferBatch(state.reconcile, state.records, {
      id,
      label: label.trim() || `2026 春季移交批次（第 ${nextSeq} 批）`,
      center: '华东区域鸟类环志中心',
      packedAt,
      limit: LIMIT,
    })
    if (!packed.length) return null
    set({
      reconcile: nextReconcile,
      operations: [
        operation(
          'transfer_pack',
          '生成移交批次',
          `批次 ${id} 定稿 ${packed.length} 条记录，进包后按定稿参与回执对账。`,
          packed.length,
          snapshotOf(state.records, state.issues),
          true,
        ),
        ...state.operations,
      ],
    })
    return nextReconcile.batches.find((batch) => batch.id === id) ?? null
  },

  /* ------------------------------ 回执对账 ------------------------------ */
  ingestInboxReceipt: (receiptKey, inboxIndex = 0) => {
    const state = get()
    // key 形如 RCP-2026-0320:1；收件箱允许同编号同版本的重发副本与不同版本并存
    const [receiptId, versionText] = receiptKey.split(':')
    const version = Number(versionText)
    const matches = state.reconcile.inbox.filter(
      (item) => item.id === receiptId && item.version === version,
    )
    const receipt = matches[inboxIndex] ?? matches[0]
    if (!receipt) {
      return { ok: false, resultText: '收件箱中找不到该回执。', reopenedCount: 0, restoredCount: 0 }
    }
    const receivedAt = new Date().toISOString()
    const prepared = prepareReceipt(state.reconcile, receipt, receivedAt)

    // 整份重复 / 晚到旧版本 / 批次缺失：绝不改数据。
    // 同一份回执只留一条去重/拦截登记，反复重发不再追加流水。
    if (prepared.status === 'duplicate' || prepared.status === 'stale') {
      const existing = state.reconcile.ingestions.find(
        (item) => item.receiptId === receipt.id && item.version === receipt.version,
      )
      if (existing) {
        return { ok: true, ingestion: existing, resultText: prepared.detail, reopenedCount: 0, restoredCount: 0 }
      }
      const ingestion: ReceiptIngestion = {
        receiptId: receipt.id,
        batchId: receipt.batchId,
        version: receipt.version,
        issuedAt: receipt.issuedAt,
        receivedAt,
        status: prepared.status,
        applied: 0,
        stale: prepared.stale,
        duplicate: prepared.duplicate,
        unmatched: prepared.mismatches.length,
        detail: prepared.detail,
        fileLabel: `${receipt.id} v${receipt.version}`,
      }
      set({
        reconcile: { ...state.reconcile, ingestions: [...state.reconcile.ingestions, ingestion] },
        operations: [
          operation(
            'receipt_apply',
            prepared.status === 'stale' ? '拦截晚到旧回执' : '回执重发去重',
            prepared.detail,
            0,
            snapshotOf(state.records, state.issues),
            true,
          ),
          ...state.operations,
        ],
      })
      return { ok: true, ingestion, resultText: prepared.detail, reopenedCount: 0, restoredCount: 0 }
    }

    const withSnapshots = attachFrozenSnapshots(prepared, state.records)
    const journal: ReconcileJournal = journalFromPrepared(
      withSnapshots,
      `journal-${receipt.id}-v${receipt.version}-${state.reconcile.journals.length + 1}`,
      receivedAt,
    )

    // 演示写入失败：日志先落盘，台账不提交
    if (state.reconcile.failureArmed) {
      const { state: failedState, ingestion } = failReceipt(state.reconcile, withSnapshots, journal)
      set({
        reconcile: failedState,
        operations: [
          operation(
            'receipt_apply',
            '回执写入失败',
            ingestion.detail,
            0,
            snapshotOf(state.records, state.issues),
            true,
          ),
          ...state.operations,
        ],
      })
      return {
        ok: false,
        ingestion,
        resultText: ingestion.detail,
        failedJournalId: journal.id,
        reopenedCount: 0,
        restoredCount: 0,
      }
    }

    const result = commitReceipt(state.reconcile, state.issues, withSnapshots, journal, {})
    set({
      reconcile: result.state,
      issues: result.issues,
      operations: [
        operation(
          'receipt_apply',
          '应用审核回执',
          result.ingestion.detail,
          journal.writes.length,
          snapshotOf(state.records, state.issues),
          true,
        ),
        ...state.operations,
      ],
    })
    return {
      ok: true,
      ingestion: result.ingestion,
      resultText: result.ingestion.detail,
      reopenedCount: result.reopened.length,
      restoredCount: result.restored.length,
    }
  },

  recoverFailedReceipt: (journalId) => {
    const state = get()
    const result = recoverReceipt(state.reconcile, state.issues, journalId, state.records)
    if (!result) return { ok: false, resultText: '找不到可恢复的写入日志。', reopenedCount: 0, restoredCount: 0 }
    set({
      reconcile: result.state,
      issues: result.issues,
      operations: [
        operation(
          'receipt_recover',
          '从对账日志恢复回执',
          `依据已对上记录的写入日志重放，回执 ${result.ingestion.receiptId} 恢复为“已恢复”，结论与正常生效一致。`,
          result.journal.writes.length,
          snapshotOf(state.records, state.issues),
          true,
        ),
        ...state.operations,
      ],
    })
    return {
      ok: true,
      ingestion: result.ingestion,
      resultText: result.ingestion.detail,
      reopenedCount: result.reopened.length,
      restoredCount: result.restored.length,
    }
  },

  armFailure: (armed) => set({ reconcile: { ...get().reconcile, failureArmed: armed } }),

  markMismatchResolved: (mismatchIdValue, note) => {
    set({ reconcile: resolveMismatch(get().reconcile, mismatchIdValue, note) })
  },

  simulateFrozenCorrection: (recordId, patch, reason) => {
    const state = get()
    const record = state.records.find((item) => item.id === recordId)
    if (!record) return false
    const outcome = registerPostFreezeCorrection(
      state.reconcile,
      record,
      patch,
      reason,
      new Date().toISOString(),
    )
    if (!outcome) return false
    set({
      reconcile: outcome.state,
      operations: [
        operation(
          'local_correction',
          '冻结记录后到更正',
          `记录 ${recordId} 已被中心判通过并冻结，后到更正仅登记 ${outcome.differences.length} 项差异，定稿不变。`,
          outcome.differences.length,
          snapshotOf(state.records, state.issues),
          true,
        ),
        ...state.operations,
      ],
    })
    return true
  },
}))

export function filterIssues(
  issues: ValidationIssue[],
  filters: {
    severity?: IssueSeverity | 'all'
    status?: IssueStatus | 'all' | 'unresolved'
    type?: ValidationIssue['type'] | 'all'
    keyword?: string
  },
) {
  const keyword = filters.keyword?.trim().toLowerCase()
  return issues.filter((issue) => {
    if (filters.severity && filters.severity !== 'all' && issue.severity !== filters.severity) return false
    if (filters.status && filters.status !== 'all') {
      if (filters.status === 'unresolved') {
        if (issue.status !== 'open' && issue.status !== 'reopened') return false
      } else if (issue.status !== filters.status) return false
    }
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

