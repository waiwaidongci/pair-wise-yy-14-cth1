import type {
  BirdRecord,
  CenterReceipt,
  LedgerEntry,
  ReconcileState,
  TransferBatch,
  TransferManifestItem,
  ValidationIssue,
} from '../types'
import { centerStyleRingCode } from '../utils/reconciliation'

/**
 * 对账模拟数据（全部浏览器内置）：
 *
 * 批次 TB-2026SPR-01（3 月 5 日移交，8 条）
 *  - 前 7 条中心 3 月 12 日已判通过，但这批历史数据导入时缺回执编号（receiptId 为空），
 *    批次上登记初始回执 RCP-2026-0312；收件箱里有该回执的补发件，用于演示编号回填。
 *  - 第 8 条尚无结论。
 *
 * 批次 TB-2026SPR-02（3 月 18 日移交，9 条，中心记录号 …0001–…0009）
 *  收件箱按到件顺序：
 *  1. RCP-2026-0320 v1：0001/0002/0004/0005/0007 通过（0001 的中心环号写法不同，
 *     身份一致，演示“只列呈现差异、不覆盖本地”）；0003/0006 判退附原因；
 *     另含 3 条对不上的脏行：不存在的中心记录号、环号身份不符、时间相差一天。
 *  2. RCP-2026-0320 v1 的重发副本（同编号同版本，必须只算一次）。
 *  3. RCP-2026-0319 v1 晚到旧件（批次已有更高版本生效，整份拦截，状态不倒退）。
 *  4. RCP-2026-0320 v2：0003/0006 改判通过（旧结论进历史，被新版本取代）。
 */

const CENTER = '华东区域鸟类环志中心'

function itemOf(
  batchId: string,
  seq: number,
  record: BirdRecord,
  packedAt: string,
): TransferManifestItem {
  return {
    centerRecordNo: `CR-${batchId}-${String(seq).padStart(4, '0')}`,
    recordId: record.id,
    localRawRingCode: record.rawRingCode,
    localNormalizedRingCode: record.normalizedRingCode,
    observedAt: record.observedAt,
    packedAt,
  }
}

function shiftDay(observedAt: string, deltaDays: number): string {
  const [date, time] = observedAt.split(' ')
  const stamp = new Date(`${date}T${time}:00Z`)
  stamp.setUTCDate(stamp.getUTCDate() + deltaDays)
  const pad = (value: number) => String(value).padStart(2, '0')
  return `${stamp.getUTCFullYear()}-${pad(stamp.getUTCMonth() + 1)}-${pad(stamp.getUTCDate())} ${time}`
}

function tamperSerial(ringCode: string): string {
  const match = ringCode.match(/^(.*?)(\d)(\D*)$/)
  if (!match) return `${ringCode}X`
  const [, head, last, tail] = match
  return `${head}${(Number(last) + 1) % 10}${tail}`
}

export function createInitialReconcile(
  records: BirdRecord[],
  issues: ValidationIssue[],
): { reconcile: ReconcileState; issues: ValidationIssue[] } {
  const byId = new Map(records.map((record) => [record.id, record]))
  const pick = (index: number) => {
    const record = byId.get(`REC-${String(index + 1).padStart(6, '0')}`)
    if (!record) throw new Error(`mock record index ${index} missing`)
    return record
  }

  /* ------------------------------- 第一批 ------------------------------- */
  const batch1Id = 'TB-2026SPR-01'
  const packedAt1 = '2026-03-05T09:12:00.000Z'
  const batch1Indexes = [2, 5, 8, 11, 14, 17, 20, 23]
  const batch1Records = batch1Indexes.map(pick)
  const manifest1 = batch1Records.map((record, index) => itemOf(batch1Id, index + 1, record, packedAt1))
  const initialReceiptAt = '2026-03-12T10:05:00.000Z'
  const ledger1: LedgerEntry[] = manifest1.map((item, index) => {
    const base: LedgerEntry = {
      centerRecordNo: item.centerRecordNo,
      recordId: item.recordId,
      batchId: batch1Id,
      status: 'transferred',
      transferredAt: packedAt1,
      history: [],
      differences: [],
    }
    if (index < 7) {
      // 历史导入缺回执编号：receiptId 留空，等待按初始回执 RCP-2026-0312 回填
      const write = {
        kind: 'approved' as const,
        receiptId: '',
        receiptVersion: 1,
        issuedAt: initialReceiptAt,
        at: initialReceiptAt,
        frozenSnapshot: { ...batch1Records[index] },
      }
      return { ...base, status: 'approved', current: write, history: [write] }
    }
    return base
  })

  const batch1: TransferBatch = {
    id: batch1Id,
    label: '2026 春季移交批次（第一批）',
    center: CENTER,
    packedAt: packedAt1,
    manifest: manifest1,
    initialReceiptId: 'RCP-2026-0312',
  }

  /* ------------------------------- 第二批 ------------------------------- */
  const batch2Id = 'TB-2026SPR-02'
  const packedAt2 = '2026-03-18T08:40:00.000Z'
  const batch2Indexes = [30, 33, 43, 39, 42, 45, 48, 51, 54]
  const batch2Records = batch2Indexes.map(pick)
  const manifest2 = batch2Records.map((record, index) => itemOf(batch2Id, index + 1, record, packedAt2))
  const ledger2: LedgerEntry[] = manifest2.map((item) => ({
    centerRecordNo: item.centerRecordNo,
    recordId: item.recordId,
    batchId: batch2Id,
    status: 'transferred' as const,
    transferredAt: packedAt2,
    history: [],
    differences: [],
  }))
  const batch2: TransferBatch = {
    id: batch2Id,
    label: '2026 春季移交批次（第二批）',
    center: CENTER,
    packedAt: packedAt2,
    manifest: manifest2,
  }

  // 进包记录在移交前的问题都应已处置（接受/修正/退回），这样判退才能演示「按原因重开」
  const packedIds = new Set([...batch1Records, ...batch2Records].map((record) => record.id))
  const adjustedIssues = issues.map((issue) => {
    if (!packedIds.has(issue.recordId)) return issue
    if (issue.status !== 'open') return issue
    if (issue.suggestedValue) {
      return { ...issue, status: 'corrected' as const }
    }
    return { ...issue, status: 'accepted' as const }
  })

  /* --------------------------- 收件箱（分批回传） -------------------------- */
  const no0001 = manifest2[0]
  const no0002 = manifest2[1]
  const no0003 = manifest2[2]
  const no0004 = manifest2[3]
  const no0005 = manifest2[4]
  const no0006 = manifest2[5]
  const no0007 = manifest2[6]
  const no0008 = manifest2[7]
  const no0009 = manifest2[8]

  // 历史回执补发：第一批 8 条全部判通过
  const receipt0312: CenterReceipt = {
    id: 'RCP-2026-0312',
    batchId: batch1Id,
    version: 1,
    issuedAt: '2026-03-12T10:00:00.000Z',
    lines: manifest1.map((item) => ({
      centerRecordNo: item.centerRecordNo,
      decision: 'approved',
      centerRingCode: item.localNormalizedRingCode,
      observedAt: item.observedAt,
    })),
  }

  const receipt0320v1: CenterReceipt = {
    id: 'RCP-2026-0320',
    batchId: batch2Id,
    version: 1,
    issuedAt: '2026-03-20T11:00:00.000Z',
    lines: [
      {
        centerRecordNo: no0001.centerRecordNo,
        decision: 'approved',
        // 中心归一化去分隔符：身份一致、写法不同 → 只能记呈现差异
        centerRingCode: centerStyleRingCode(no0001.localNormalizedRingCode),
        observedAt: no0001.observedAt,
      },
      {
        centerRecordNo: no0002.centerRecordNo,
        decision: 'approved',
        centerRingCode: no0002.localNormalizedRingCode,
        observedAt: no0002.observedAt,
      },
      {
        centerRecordNo: no0003.centerRecordNo,
        decision: 'rejected',
        reason: '环号年份与移交清单不符，需核对原始环志登记表后重报。',
        centerRingCode: no0003.localNormalizedRingCode,
        observedAt: no0003.observedAt,
      },
      {
        centerRecordNo: no0004.centerRecordNo,
        decision: 'approved',
        centerRingCode: no0004.localNormalizedRingCode,
        observedAt: no0004.observedAt,
      },
      {
        centerRecordNo: no0005.centerRecordNo,
        decision: 'approved',
        centerRingCode: no0005.localNormalizedRingCode,
        observedAt: no0005.observedAt,
      },
      {
        centerRecordNo: no0006.centerRecordNo,
        decision: 'rejected',
        reason: '鸟种鉴定存疑，请补充环志现场照片与鉴定人签字。',
        centerRingCode: no0006.localNormalizedRingCode,
        observedAt: no0006.observedAt,
      },
      {
        centerRecordNo: no0007.centerRecordNo,
        decision: 'approved',
        centerRingCode: no0007.localNormalizedRingCode,
        observedAt: no0007.observedAt,
      },
      // —— 以下 3 条对不上，必须只列出、不改记录 ——
      {
        centerRecordNo: `CR-${batch2Id}-0010`,
        decision: 'approved',
        centerRingCode: 'BJ202100999',
        observedAt: '2026-03-18 10:00',
      },
      {
        centerRecordNo: no0008.centerRecordNo,
        decision: 'approved',
        centerRingCode: tamperSerial(no0008.localNormalizedRingCode),
        observedAt: no0008.observedAt,
      },
      {
        centerRecordNo: no0009.centerRecordNo,
        decision: 'approved',
        centerRingCode: no0009.localNormalizedRingCode,
        observedAt: shiftDay(no0009.observedAt, 1),
      },
    ],
  }

  // 同一份回执的重发副本：编号与版本完全相同
  const receipt0320v1Resend: CenterReceipt = {
    ...receipt0320v1,
    lines: receipt0320v1.lines.map((line) => ({ ...line })),
  }

  // 晚到的旧版本：编号不同、版本更低，且批次已按更高版本处理
  const receipt0319Stale: CenterReceipt = {
    id: 'RCP-2026-0319',
    batchId: batch2Id,
    version: 1,
    issuedAt: '2026-03-19T09:30:00.000Z',
    lines: [
      {
        centerRecordNo: no0001.centerRecordNo,
        decision: 'rejected',
        reason: '旧版回执的误判结论（不应再生效）。',
        centerRingCode: no0001.localNormalizedRingCode,
        observedAt: no0001.observedAt,
      },
    ],
  }

  // 新版回执：判退的两条改判通过
  const receipt0320v2: CenterReceipt = {
    id: 'RCP-2026-0320',
    batchId: batch2Id,
    version: 2,
    issuedAt: '2026-03-21T15:20:00.000Z',
    lines: [no0003, no0006].map((item) => ({
      centerRecordNo: item.centerRecordNo,
      decision: 'approved',
      centerRingCode: item.localNormalizedRingCode,
      observedAt: item.observedAt,
    })),
  }

  return {
    reconcile: {
      batches: [batch1, batch2],
      ledger: [...ledger1, ...ledger2],
      ingestions: [],
      inbox: [receipt0312, receipt0320v1, receipt0320v1Resend, receipt0319Stale, receipt0320v2],
      mismatches: [],
      pendingCorrections: [],
      journals: [],
      failureArmed: false,
    },
    issues: adjustedIssues,
  }
}

export const INBOX_FILE_LABELS: Record<string, string> = {
  'RCP-2026-0312:1': '审核回执_RCP-2026-0312_v1_第一批补发.json',
  'RCP-2026-0320:1': '审核回执_RCP-2026-0320_v1.json',
  'RCP-2026-0319:1': '审核回执_RCP-2026-0319_v1_晚到旧件.json',
  'RCP-2026-0320:2': '审核回执_RCP-2026-0320_v2_更正版.json',
}
