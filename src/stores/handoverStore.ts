import { create } from 'zustand'
import { createLateReceipts, createMockBatches, createMockReceipts } from '../data/mockReceipts'
import type {
  AuditReceipt,
  HandoverBatch,
  ReconciliationResult,
  SettleResult,
} from '../types'
import { reconcileReceipts } from '../utils/reconciliation'
import { registerHandoverReset, useValidationStore } from './validationStore'

interface HandoverState {
  batches: HandoverBatch[]
  receipts: AuditReceipt[]
  lateReceipts: AuditReceipt[]
  reconciliation: ReconciliationResult | null
  settleResult: SettleResult | null
  loaded: boolean
  loadMockData: () => void
  runReconciliation: () => ReconciliationResult | null
  applyReconciliation: () => SettleResult | null
  loadLateReceipts: () => void
  recomputePending: () => string[]
  reset: () => void
}

function computePending(): string[] {
  return useValidationStore
    .getState()
    .records.filter((record) => !record.frozen)
    .map((record) => record.id)
}

export const useHandoverStore = create<HandoverState>((set, get) => ({
  batches: [],
  receipts: [],
  lateReceipts: [],
  reconciliation: null,
  settleResult: null,
  loaded: false,

  loadMockData: () => {
    const records = useValidationStore.getState().records
    const batches = createMockBatches(records)
    const receipts = createMockReceipts(records, batches)
    const lateReceipts = createLateReceipts(records)
    set({ batches, receipts, lateReceipts, loaded: true })
    // 自动跑一次对账并应用，便于直接看到冻结 / 重开 / 待移交结果
    get().runReconciliation()
    get().applyReconciliation()
  },

  runReconciliation: () => {
    const state = get()
    if (!state.receipts.length) return null
    const records = useValidationStore.getState().records
    const differences = useValidationStore.getState().frozenDifferences
    const result = reconcileReceipts({ records, receipts: state.receipts, differences })
    set({ reconciliation: result })
    return result
  },

  applyReconciliation: () => {
    const state = get()
    if (!state.reconciliation) return null
    const settle = useValidationStore.getState().settleRecordsFromReceipts({
      freezeIds: state.reconciliation.frozenRecordIds,
      reopenIds: state.reconciliation.reopenedRecordIds,
      backfill: state.reconciliation.backfilled,
      differences: state.reconciliation.differences,
      conflicts: state.reconciliation.conflicts,
      receiptCount: state.reconciliation.receiptCount,
    })
    // 回执更新后按新结果重算待移交清单
    const pending = computePending()
    set({
      settleResult: settle,
      reconciliation: state.reconciliation ? { ...state.reconciliation, pendingRecordIds: pending } : null,
      batches: state.batches.map((batch) => {
        const settled = batch.recordIds.filter((id) => !pending.includes(id)).length
        const status = settled === batch.recordIds.length ? 'settled' : settled > 0 ? 'partial' : 'sent'
        return { ...batch, status: status as HandoverBatch['status'] }
      }),
    })
    return settle
  },

  loadLateReceipts: () => {
    const state = get()
    if (!state.lateReceipts.length) return
    set({ receipts: [...state.receipts, ...state.lateReceipts], lateReceipts: [] })
    get().runReconciliation()
    get().applyReconciliation()
  },

  recomputePending: () => {
    const pending = computePending()
    const state = get()
    set({
      reconciliation: state.reconciliation ? { ...state.reconciliation, pendingRecordIds: pending } : null,
    })
    return pending
  },

  reset: () => {
    set({ batches: [], receipts: [], lateReceipts: [], reconciliation: null, settleResult: null, loaded: false })
  },
}))

// 注册重置回调：校验页“重新载入”时一并清空移交对账状态
registerHandoverReset(() => useHandoverStore.getState().reset())
