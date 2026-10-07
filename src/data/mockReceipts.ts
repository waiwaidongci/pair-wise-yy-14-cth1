import type { AuditReceipt, BirdRecord, HandoverBatch } from '../types'
import { normalizeRingCode } from '../utils/normalization'

function addDays(iso: string, days: number): string {
  const date = new Date(iso)
  date.setUTCDate(date.getUTCDate() + days)
  return date.toISOString()
}

/**
 * 中心口径环号：去掉连字符与空格、保留原始前缀（如“沪环”），
 * 本地用同一套归一化器仍能对上，用来模拟“中心归一化与本地不同”。
 */
function centerRingVariant(record: BirdRecord): string {
  const ring = normalizeRingCode(record.rawRingCode)
  if (ring.valid) {
    return record.rawRingCode.replace(/[^一-龥A-Za-z0-9]/g, '').toUpperCase()
  }
  return record.normalizedRingCode
}

function centerRejectReason(index: number): string {
  const reasons = [
    '环号与中心库存记录不符，需核对原始环志登记表',
    '鸟种鉴定存疑，请补充鉴定照片或录音',
    '观察地点与环志记录冲突，请核实',
    '时间超出迁徙窗口期，请确认观察日期',
    '环志员信息缺失，请补充',
  ]
  return reasons[index % reasons.length]
}

export function createMockBatches(records: BirdRecord[]): HandoverBatch[] {
  const configs = [
    { id: 'BATCH-2026-001', name: '2026 春季移交批次（第一批）', sentAt: '2026-03-01T09:00:00.000Z', start: 0, end: 60 },
    { id: 'BATCH-2026-002', name: '2026 春季移交批次（第二批）', sentAt: '2026-03-15T09:00:00.000Z', start: 60, end: 120 },
    { id: 'BATCH-2026-003', name: '2026 春季移交批次（第三批）', sentAt: '2026-04-01T09:00:00.000Z', start: 120, end: 150 },
  ]
  return configs.map((cfg) => ({
    id: cfg.id,
    name: cfg.name,
    sentAt: cfg.sentAt,
    recordIds: records.slice(cfg.start, cfg.end).map((record) => record.id),
    status: 'sent' as const,
  }))
}

export function createMockReceipts(records: BirdRecord[], batches: HandoverBatch[]): AuditReceipt[] {
  const receipts: AuditReceipt[] = []
  batches.forEach((batch) => {
    const batchRecords = records.filter((record) => batch.recordIds.includes(record.id))
    batchRecords.forEach((record, i) => {
      const globalIndex = records.indexOf(record)
      if (globalIndex % 13 === 0) return // 约 1/13 暂无回执，留在待移交清单
      const approved = globalIndex % 10 < 7
      const receiptId = `R-${batch.id.slice(-3)}-${String(i + 1).padStart(3, '0')}`
      const useVariant = globalIndex % 7 === 0
      const localRingCode = useVariant ? centerRingVariant(record) : record.normalizedRingCode
      const receivedAt = addDays(batch.sentAt, (i % 5) + 2)
      const base = {
        batchId: batch.id,
        centerRecordId: `CR-${String(globalIndex + 1).padStart(6, '0')}`,
        localRingCode,
        observedAt: record.observedAt,
      }
      receipts.push({
        ...base,
        id: `rcpt-${receiptId}-v1`,
        receiptId,
        version: 1,
        verdict: approved ? 'approved' : 'rejected',
        reason: approved ? undefined : centerRejectReason(globalIndex),
        receivedAt,
      })
      // 重发：同一份回执再发一次（同版本），只算一次
      if (globalIndex % 12 === 0) {
        receipts.push({
          ...base,
          id: `rcpt-${receiptId}-v1-resend`,
          receiptId,
          version: 1,
          verdict: approved ? 'approved' : 'rejected',
          reason: approved ? undefined : centerRejectReason(globalIndex),
          receivedAt: addDays(receivedAt, 1),
        })
      }
      // 旧版本：结论与新版相反，用于演示“同一份只算一次”
      if (globalIndex % 14 === 0) {
        receipts.push({
          ...base,
          id: `rcpt-${receiptId}-v0`,
          receiptId,
          version: 0,
          verdict: approved ? 'rejected' : 'approved',
          reason: approved ? centerRejectReason(globalIndex) : undefined,
          receivedAt: addDays(receivedAt, -2),
        })
      }
    })
  })
  // 对不上的回执：中心记录号、环号、时间均无法匹配本地记录，先列出、不改记录
  for (let k = 1; k <= 5; k++) {
    receipts.push({
      id: `rcpt-unmatched-${k}`,
      receiptId: `R-UNMATCHED-${k}`,
      version: 1,
      batchId: 'BATCH-2026-003',
      centerRecordId: `CR-999${String(k).padStart(3, '0')}`,
      localRingCode: `UNMATCHED-RING-${k}`,
      observedAt: `2026-0${k}-15 10:00`,
      verdict: k % 2 === 0 ? 'approved' : 'rejected',
      reason: k % 2 === 0 ? undefined : '中心记录无法与本地记录对应',
      receivedAt: '2026-04-10T09:00:00.000Z',
    })
  }
  return receipts
}

/**
 * 晚到的回执：用于演示
 * 1. 旧版本晚到不得倒退已冻结状态（REC-000011）
 * 2. 已冻结记录收到判退新版 → 写入失败，从已对上的记录恢复（REC-000005）
 */
export function createLateReceipts(records: BirdRecord[]): AuditReceipt[] {
  const late: AuditReceipt[] = []
  const findRecord = (id: string) => records.find((record) => record.id === id)
  const r5 = findRecord('REC-000005')
  if (r5) {
    late.push({
      id: 'rcpt-R-001-005-v2',
      receiptId: 'R-001-005',
      version: 2,
      batchId: 'BATCH-2026-001',
      centerRecordId: 'CR-000005',
      localRingCode: r5.normalizedRingCode,
      observedAt: r5.observedAt,
      verdict: 'rejected',
      reason: '中心复核发现环号录入错误，退回重核',
      receivedAt: '2026-04-20T09:00:00.000Z',
    })
  }
  // REC-000011：v1 已通过冻结，晚到 v0 旧版判退 → 旧版本不得倒退状态
  const r11 = findRecord('REC-000011')
  if (r11) {
    late.push({
      id: 'rcpt-R-001-011-v0-late',
      receiptId: 'R-001-011',
      version: 0,
      batchId: 'BATCH-2026-001',
      centerRecordId: 'CR-000011',
      localRingCode: r11.normalizedRingCode,
      observedAt: r11.observedAt,
      verdict: 'rejected',
      reason: '旧版回执（已作废）',
      receivedAt: '2026-04-22T09:00:00.000Z',
    })
  }
  return late
}
