import type {
  BirdRecord,
  CenterReceipt,
  FieldDifference,
  JournalWrite,
  LedgerEntry,
  LedgerWrite,
  ReceiptIngestion,
  ReceiptLine,
  ReceiptIngestStatus,
  ReconcileJournal,
  ReconcileMismatch,
  ReconcileMismatchKind,
  ReconcileState,
  TransferBatch,
  TransferManifestItem,
  TransferStatus,
  ValidationIssue,
} from '../types'
import { RING_SCHEMES } from './normalization'

/**
 * 移交批次 / 审核回执 / 处置记录三方对账引擎。
 *
 * 约束（对应业务规则）：
 * 1. 回执按「中心记录号 + 本地环号 + 时间」对上，对不上的只列出、不改任何记录；
 * 2. 中心对环号的归一化只用于呈现比对，绝不采信覆盖本地人工结论；
 * 3. 判通过的记录冻结，本地后到更正只记差异；判退按原因重开；
 * 4. 同一份回执只算一次（同版本重发幂等），晚到旧版本不倒退状态（旧版本整体 stale、
 *    已被新版本取代的单条 superseded）；
 * 5. 缺回执编号的历史数据按批次的初始回执回填；
 * 6. 台账写入走「先落日志、再提交」，写入失败后从已对上的记录（日志）恢复。
 */

/* -------------------------------- 比对键 -------------------------------- */

const SCHEME_CODE = new Map<string, string>()
for (const scheme of RING_SCHEMES) {
  SCHEME_CODE.set(scheme.prefix.toUpperCase(), scheme.normalizedPrefix)
  SCHEME_CODE.set(scheme.normalizedPrefix.toUpperCase(), scheme.normalizedPrefix)
}

/**
 * 环号身份键：只保留「方案码 + 数字串」。中心与本地的分隔符、空格、全半角差异
 * 不影响身份判定；身份一致但写法不同属于呈现差异，不算对不上、也不覆盖本地。
 */
export function ringIdentity(input: string | undefined | null): string {
  if (!input) return ''
  let prefixToken = ''
  for (const token of SCHEME_CODE.keys()) {
    if (input.toUpperCase().includes(token)) {
      prefixToken = token
      break
    }
  }
  const code = prefixToken ? SCHEME_CODE.get(prefixToken.toUpperCase())! : ''
  const digits = input.replace(/[^0-9]/g, '')
  return `${code}|${digits}`
}

/** 时间键：本地观察时间精确到分钟，中心回传含秒也不影响对账 */
export function timeMinute(input: string | undefined | null): string {
  if (!input) return ''
  return input.trim().replace('T', ' ').slice(0, 16)
}

/* ------------------------------ 待移交清单 ------------------------------ */

export function latestLedgerByRecord(ledger: LedgerEntry[]): Map<string, LedgerEntry> {
  const map = new Map<string, LedgerEntry>()
  for (const entry of ledger) {
    const existing = map.get(entry.recordId)
    if (!existing || existing.transferredAt <= entry.transferredAt) map.set(entry.recordId, entry)
  }
  return map
}

/**
 * 回执更新后按新结果重算「下一批可移交」记录：
 * - 从未进包、且没有未决问题（open / reopened）的记录可移交；
 * - 中心判退的记录问题按原因重开；重开问题处置完成后随下一批带回；
 * - 判通过（已冻结）的记录不再出现；
 * - 已移交未见结论的记录等待回执，不重复组包；
 * - 对不上挂起的记录先留在原批次；人工核对销项后才允许带回下一批。
 */
export function selectPendingTransfer(
  state: Pick<ReconcileState, 'batches' | 'ledger' | 'mismatches'>,
  records: BirdRecord[],
  issues: ValidationIssue[],
): BirdRecord[] {
  const latest = latestLedgerByRecord(state.ledger)
  const blocking = new Set(
    issues
      .filter((issue) => issue.status === 'open' || issue.status === 'reopened')
      .map((issue) => issue.recordId),
  )
  const unresolvedByNo = new Set(
    state.mismatches.filter((item) => !item.resolved).map((item) => item.line.centerRecordNo),
  )
  const resolvedByNo = new Set(
    state.mismatches.filter((item) => item.resolved).map((item) => item.line.centerRecordNo),
  )
  return records.filter((record) => {
    const entry = latest.get(record.id)
    if (blocking.has(record.id)) return false
    if (!entry) return true
    if (entry.status === 'approved') return false
    if (entry.status === 'rejected') return true
    if (entry.status === 'pending') return true
    if (entry.status === 'transferred') {
      // 对不上挂起：未核对前不重报；全部挂起项核对销项后才带回下一批
      if (unresolvedByNo.has(entry.centerRecordNo)) return false
      if (resolvedByNo.has(entry.centerRecordNo)) return true
      return false
    }
    return false
  })
}

/* -------------------------------- 组移交包 ------------------------------- */

export function packTransferBatch(
  state: ReconcileState,
  records: BirdRecord[],
  options: {
    id: string
    label: string
    center: string
    packedAt: string
    initialReceiptId?: string
    limit?: number
  },
): { state: ReconcileState; packed: TransferManifestItem[]; eligible: number } {
  const pendingAll = selectPendingTransfer(state, records, [])
  const pending = options.limit ? pendingAll.slice(0, options.limit) : pendingAll
  const usedNumbers = new Set(state.ledger.map((entry) => entry.centerRecordNo))
  const seq = state.ledger.length
  const manifest: TransferManifestItem[] = []
  const entries: LedgerEntry[] = []
  pending.forEach((record, index) => {
    const centerRecordNo = `CR-${options.id}-${String(seq + index + 1).padStart(4, '0')}`
    // 防御性校验：生成编号不应与已有编号碰撞
    if (usedNumbers.has(centerRecordNo)) return
    usedNumbers.add(centerRecordNo)
    manifest.push({
      centerRecordNo,
      recordId: record.id,
      localRawRingCode: record.rawRingCode,
      localNormalizedRingCode: record.normalizedRingCode,
      observedAt: record.observedAt,
      packedAt: options.packedAt,
    })
    entries.push({
      centerRecordNo,
      recordId: record.id,
      batchId: options.id,
      status: 'transferred',
      transferredAt: options.packedAt,
      history: [],
      differences: [],
    })
  })
  const batch: TransferBatch = {
    id: options.id,
    label: options.label,
    center: options.center,
    packedAt: options.packedAt,
    manifest,
    initialReceiptId: options.initialReceiptId,
  }
  return {
    state: { ...state, batches: [...state.batches, batch], ledger: [...state.ledger, ...entries] },
    packed: manifest,
    eligible: pendingAll.length,
  }
}

/* ------------------------------ 回执预匹配 ------------------------------- */

export interface PreparedReceipt {
  receipt: CenterReceipt
  status: ReceiptIngestStatus
  detail: string
  backfilledReceiptIds: string[]
  /** 已含本回执回填结果的台账基底，提交时在此之上变更 */
  ledger: LedgerEntry[]
  matched: { item: TransferManifestItem; batch: TransferBatch; line: ReceiptLine }[]
  writes: JournalWrite[]
  mismatches: ReconcileMismatch[]
  stale: number
  superseded: number
  duplicate: number
  presentationDiffs: { entry: LedgerEntry; diff: FieldDifference }[]
  receivedAt: string
}

const mismatchId = (receiptId: string, line: ReceiptLine, kind: ReconcileMismatchKind) =>
  `mm-${receiptId}-${line.centerRecordNo}-${kind}`

/**
 * 预匹配一份回执：不修改任何业务数据，只产出「可提交的写入 + 对不上清单 + 幂等判定」。
 */
export function prepareReceipt(
  state: ReconcileState,
  receipt: CenterReceipt,
  receivedAt: string,
): PreparedReceipt {
  const empty: PreparedReceipt = {
    receipt,
    status: 'duplicate',
    detail: '',
    backfilledReceiptIds: [],
    ledger: state.ledger,
    matched: [],

    writes: [],
    mismatches: [],
    stale: 0,
    superseded: 0,
    duplicate: 0,
    presentationDiffs: [],
    receivedAt,
  }

  // 1. 同一份回执只算一次：同编号 + 同版本（无论上次成功、失败还是恢复后）都不重复处理
  const sameDoc = state.ingestions.find(
    (item) => item.receiptId === receipt.id && item.version === receipt.version,
  )
  if (sameDoc) {
    return {
      ...empty,
      status: 'duplicate',
      detail:
        sameDoc.status === 'failed'
          ? `回执 ${receipt.id} v${receipt.version} 上次写入中断（${sameDoc.receivedAt}），重发件不再处理；请使用“从日志恢复”。`
          : `回执 ${receipt.id} v${receipt.version} 已于 ${sameDoc.receivedAt} 处理（${statusLabel(sameDoc.status)}），重发内容不再生效。`,
    }
  }

  const batch = state.batches.find((item) => item.id === receipt.batchId)
  if (!batch) {
    return {
      ...empty,
      status: 'stale',
      detail: `回执 ${receipt.id} 指向的移交批次 ${receipt.batchId} 在本地不存在，整份挂起不处理。`,
    }
  }

  // 2. 晚到的旧版本：本批次已有「不同回执且签发时间不早于本件」的结论生效时，
  //    旧版整份不倒退状态（版本号高低不作为唯一依据，同版本误时重发同样拦截）
  const priorApplied = state.ingestions.find(
    (item) =>
      item.batchId === receipt.batchId &&
      (item.status === 'applied' || item.status === 'recovered') &&
      item.receiptId !== receipt.id &&
      item.issuedAt >= receipt.issuedAt,
  )
  if (priorApplied) {
    return {
      ...empty,
      status: 'stale',
      detail: `批次 ${receipt.batchId} 已按 ${priorApplied.receiptId}（签发于 ${priorApplied.issuedAt}）处理，晚到的 ${receipt.id} v${receipt.version}（签发于 ${receipt.issuedAt}）为旧版本，状态不回退。`,
    }
  }

  // 3. 缺回执编号的历史数据按批次的初始回执回填
  const backfilledReceiptIds: string[] = []
  let ledger = state.ledger
  if (batch.initialReceiptId && batch.initialReceiptId === receipt.id) {
    ledger = state.ledger.map((entry) => {
      const inBatch = batch.manifest.some((item) => item.centerRecordNo === entry.centerRecordNo)
      if (!inBatch) return entry
      // 已对上中心结论、但历史导入缺回执编号的写入统一回填（current 与 history 一并补齐）
      const oldWrite = entry.current ?? entry.history[0]
      if (oldWrite?.kind !== 'approved' || oldWrite.receiptId) return entry
      backfilledReceiptIds.push(entry.centerRecordNo)
      const fill = <W extends LedgerWrite>(write: W): W =>
        write.kind === 'approved' && !write.receiptId
          ? ({ ...write, receiptId: receipt.id, issuedAt: receipt.issuedAt } as W)
          : write
      const filledCurrent = entry.current ? fill(entry.current) : entry.current
      return {
        ...entry,
        current: filledCurrent,
        history: entry.history.map(fill),
      }
    })
  }
  const backfilledSet = new Set(backfilledReceiptIds)

  // 4. 按「中心记录号 + 本地环号 + 时间」逐条匹配，对不上的只列出
  const manifestByNo = new Map<string, { item: TransferManifestItem; duplicated: boolean }>()
  const seen = new Set<string>()
  for (const item of batch.manifest) {
    manifestByNo.set(item.centerRecordNo, {
      item,
      duplicated: seen.has(item.centerRecordNo),
    })
    seen.add(item.centerRecordNo)
  }

  const lineSeen = new Set<string>()
  const matched: PreparedReceipt['matched'] = []
  const mismatches: ReconcileMismatch[] = []

  receipt.lines.forEach((line) => {
    const duplicateLine = lineSeen.has(line.centerRecordNo)
    lineSeen.add(line.centerRecordNo)
    const located = manifestByNo.get(line.centerRecordNo)
    if (!located) {
      mismatches.push(buildMismatch(receipt, line, 'record_missing', receivedAt,
        `中心记录号 ${line.centerRecordNo} 在批次 ${receipt.batchId} 的移交清单中不存在。`))
      return
    }
    if (duplicateLine || located.duplicated) {
      mismatches.push(buildMismatch(receipt, line, 'duplicate_center_ref', receivedAt,
        `中心记录号 ${line.centerRecordNo} 在回执${duplicateLine ? '内重复' : '移交清单内重复'}，无法唯一对账。`,
        located.item))
      return
    }
    const { item } = located
    const localIdentities = new Set(
      [item.localRawRingCode, item.localNormalizedRingCode].map(ringIdentity).filter(Boolean),
    )
    const centerIdentity = ringIdentity(line.centerRingCode)
    const ringOk = !centerIdentity || localIdentities.has(centerIdentity)
    const timeOk = !line.observedAt || timeMinute(line.observedAt) === timeMinute(item.observedAt)
    if (!ringOk) {
      mismatches.push(buildMismatch(receipt, line, 'ring_mismatch', receivedAt,
        `环号对不上：中心“${line.centerRingCode}”与本地定稿“${item.localNormalizedRingCode || item.localRawRingCode}”身份不一致。`,
        item))
      return
    }
    if (!timeOk) {
      mismatches.push(buildMismatch(receipt, line, 'time_mismatch', receivedAt,
        `观察时间对不上：中心 ${timeMinute(line.observedAt)}，本地定稿 ${timeMinute(item.observedAt)}。`,
        item))
      return
    }
    matched.push({ item, batch, line })
  })

  // 5. 已对上记录：幂等 / 旧版条目不生效，其余生成台账写入
  const writes: PreparedReceipt['writes'] = []
  const presentationDiffs: PreparedReceipt['presentationDiffs'] = []
  let stale = 0
  let superseded = 0
  let duplicate = 0
  const now = receivedAt

  for (const { item, line } of matched) {
    const entry = ledger.find(
      (candidate) =>
        candidate.batchId === receipt.batchId &&
        candidate.centerRecordNo === item.centerRecordNo,
    )
    const current = entry?.current
    if (current) {
      // 刚刚按初始回执回填编号的结论不算重复，本件不再产生新写入即可
      if (backfilledSet.has(item.centerRecordNo)) {
        continue
      }
      // 同一份回执同一条结论重发 → 幂等
      if (current.receiptId === receipt.id && current.receiptVersion === receipt.version) {
        duplicate += 1
        continue
      }
      // 该条已有结论来自签发时间不早于本件的回执 → 本条旧结论不倒退
      if (current.issuedAt >= receipt.issuedAt) {
        stale += 1
        continue
      }
      // 同一批已有结论，被这份更新签发的回执取代
      superseded += 1
    }

    if (line.decision === 'approved') {
      // 中心归一化只列呈现差异，不覆盖本地：身份一致但写法不同
      if (
        line.centerRingCode &&
        ringIdentity(line.centerRingCode) === ringIdentity(item.localNormalizedRingCode) &&
        line.centerRingCode.trim() !== item.localNormalizedRingCode.trim()
      ) {
        const diff: FieldDifference = {
          field: 'normalizedRingCode',
          localValue: item.localNormalizedRingCode,
          centerValue: line.centerRingCode,
          source: 'center_presentation',
          noticedAt: now,
          detail: `回执 ${receipt.id} 的中心环号写法不同，仅作呈现差异登记，保留本地人工结论。`,
        }
        if (entry) presentationDiffs.push({ entry, diff })
      }
      // 冻结快照在提交时从当前 records 生成（store 注入），这里先放占位
      writes.push({
        kind: 'approved',
        receiptId: receipt.id,
        receiptVersion: receipt.version,
        issuedAt: receipt.issuedAt,
        at: now,
        frozenSnapshot: null as unknown as BirdRecord,
        centerRingCode: line.centerRingCode,
        centerRecordNo: item.centerRecordNo,
      })
    } else {
      writes.push({
        kind: 'rejected',
        receiptId: receipt.id,
        receiptVersion: receipt.version,
        issuedAt: receipt.issuedAt,
        at: now,
        reason: line.reason?.trim() || '中心判退，未注明原因。',
        centerRingCode: line.centerRingCode,
        centerRecordNo: item.centerRecordNo,
      })
    }
  }

  const status: ReceiptIngestStatus =
    writes.length ||
    presentationDiffs.length ||
    backfilledReceiptIds.length ||
    mismatches.length
      ? 'applied'
      : stale > 0
        ? 'stale'
        : 'duplicate'

  return {
    receipt,
    status,
    detail: buildDetail({ writeCount: writes.length, matched: matched.length, mismatches: mismatches.length, stale, superseded, duplicate, backfilled: backfilledReceiptIds.length }),
    backfilledReceiptIds,
    ledger,
    matched,
    writes,
    mismatches,
    stale,
    superseded,
    duplicate,
    presentationDiffs,
    receivedAt,
  }
}

function buildMismatch(
  receipt: CenterReceipt,
  line: ReceiptLine,
  kind: ReconcileMismatchKind,
  receivedAt: string,
  detail: string,
  item?: TransferManifestItem,
): ReconcileMismatch {
  return {
    id: mismatchId(receipt.id, line, kind),
    receiptId: receipt.id,
    batchId: receipt.batchId,
    line,
    kind,
    detail,
    manifestItem: item,
    resolved: false,
    receivedAt,
  }
}

function buildDetail(parts: {
  writeCount: number
  matched: number
  mismatches: number
  stale: number
  superseded: number
  duplicate: number
  backfilled: number
}) {
  const segments: string[] = []
  if (parts.backfilled) segments.push(`回填回执编号 ${parts.backfilled} 条`)
  segments.push(`对上 ${parts.matched} 条、生效写入 ${parts.writeCount} 条`)
  if (parts.superseded) segments.push(`被新结论取代 ${parts.superseded} 条`)
  if (parts.duplicate) segments.push(`重复跳过 ${parts.duplicate} 条`)
  if (parts.stale) segments.push(`旧版本拦截 ${parts.stale} 条`)
  if (parts.mismatches) segments.push(`对不上挂起 ${parts.mismatches} 条`)
  return segments.join('，') + '。'
}

export function statusLabel(status: ReceiptIngestStatus): string {
  const labels: Record<ReceiptIngestStatus, string> = {
    applied: '已生效',
    duplicate: '重复跳过',
    superseded: '已被新版本取代',
    stale: '旧版本拦截',
    failed: '写入失败待恢复',
    recovered: '已恢复',
  }
  return labels[status]
}

/* ------------------------------ 日志与提交 ------------------------------- */

/**
 * 提交前把冻结快照补齐（批准的记录以提交瞬间的本地记录定稿冻结）。
 */
export function attachFrozenSnapshots(
  prepared: PreparedReceipt,
  records: BirdRecord[],
): PreparedReceipt {
  const recordByNo = new Map(
    prepared.matched.map(({ item }) => [item.centerRecordNo, item.recordId]),
  )
  const byRecordId = new Map(records.map((record) => [record.id, record]))
  const writes = prepared.writes.map((write) => {
    if (write.kind !== 'approved') return write
    const recordId = recordByNo.get(write.centerRecordNo)
    const record = recordId ? byRecordId.get(recordId) : undefined
    return { ...write, frozenSnapshot: record ? { ...record } : (null as unknown as BirdRecord) }
  })
  return { ...prepared, writes }
}

export function journalFromPrepared(
  prepared: PreparedReceipt,
  journalId: string,
  createdAt: string,
): ReconcileJournal {
  return {
    id: journalId,
    receiptId: prepared.receipt.id,
    batchId: prepared.receipt.batchId,
    createdAt,
    writes: prepared.writes.map((write) => ({ ...write })),
    replayed: false,
  }
}

export interface CommitResult {
  state: ReconcileState
  issues: ValidationIssue[]
  ingestion: ReceiptIngestion
  journal: ReconcileJournal
  reopened: ValidationIssue[]
  restored: ValidationIssue[]
}

/**
 * 提交一份已落日志的回执：通过→冻结；判退→按原因重开；
 * 判退被更新回执改判通过→还原重开前的处置态。
 * ledger 里同一中心记录号只保留一条有效 current，旧结论进 history。
 */
export function commitReceipt(
  state: ReconcileState,
  issues: ValidationIssue[],
  prepared: PreparedReceipt,
  journal: ReconcileJournal,
  options: { ingestionStatus?: ReceiptIngestStatus; replayed?: boolean },
): CommitResult {
  const recordDecision = new Map<
    string,
    { kind: 'approved' | 'rejected'; reason?: string; centerRecordNo: string }
  >()
  journal.writes.forEach((write) => {
    const match = prepared.matched.find((item) => item.item.centerRecordNo === write.centerRecordNo)
    if (match) {
      recordDecision.set(match.item.recordId, {
        kind: write.kind,
        reason: write.kind === 'rejected' ? write.reason : undefined,
        centerRecordNo: write.centerRecordNo,
      })
    }
  })

  const reasonByRecord = new Map<string, string>()
  recordDecision.forEach((decision, recordId) => {
    if (decision.kind === 'rejected') reasonByRecord.set(recordId, decision.reason ?? '未注明原因')
  })

  // 判退按原因重开（保留重开前状态）；改判通过时还原重开前处置态
  const reopened: ValidationIssue[] = []
  const restored: ValidationIssue[] = []
  const nextIssues = issues.map((issue) => {
    const decision = recordDecision.get(issue.recordId)
    if (!decision) return issue
    if (decision.kind === 'rejected') {
      if (issue.status === 'accepted' || issue.status === 'corrected' || issue.status === 'returned') {
        const reopenedIssue: ValidationIssue = {
          ...issue,
          status: 'reopened',
          preReopenStatus: issue.status,
          reopenReason: `中心判退重开（${journal.receiptId}）：${reasonByRecord.get(issue.recordId) ?? '未注明原因'}`,
        }
        reopened.push(reopenedIssue)
        return reopenedIssue
      }
      if (issue.status === 'open') {
        const reopenedIssue: ValidationIssue = {
          ...issue,
          status: 'reopened',
          preReopenStatus: 'open',
          reopenReason: `中心判退重开（${journal.receiptId}）：${reasonByRecord.get(issue.recordId) ?? '未注明原因'}`,
        }
        reopened.push(reopenedIssue)
        return reopenedIssue
      }
      return issue
    }
    // approved：此前判退重开的问题还原为重开前处置态
    if (issue.status === 'reopened') {
      const restoredIssue: ValidationIssue = {
        ...issue,
        status: issue.preReopenStatus && issue.preReopenStatus !== 'reopened'
          ? issue.preReopenStatus
          : 'accepted',
        reopenReason: undefined,
        preReopenStatus: undefined,
      }
      restored.push(restoredIssue)
      return restoredIssue
    }
    return issue
  })

  const writeByNo = new Map(journal.writes.map((write) => [write.centerRecordNo, write]))
  const presentationByNo = new Map(
    prepared.presentationDiffs.map(({ entry, diff }) => [entry.centerRecordNo, diff]),
  )

  const ledgerBase = prepared.ledger
  const ledger = ledgerBase.map((entry) => {
    const write = writeByNo.get(entry.centerRecordNo)
    if (!write) {
      const presentation = presentationByNo.get(entry.centerRecordNo)
      if (presentation && !entry.differences.some(
        (diff) => diff.source === 'center_presentation' && diff.noticedAt === presentation.noticedAt,
      )) {
        return { ...entry, differences: [...entry.differences, presentation] }
      }
      return entry
    }
    const { centerRecordNo: _no, ...writeBody } = write
    const status: TransferStatus = writeBody.kind === 'approved' ? 'approved' : 'rejected'
    // 旧 current 与 history 可能指向同一对象（历史导入数据），按引用去重保留一次
    const historySeen = new Set<LedgerWrite>()
    const history = [writeBody, ...(entry.current ? [entry.current] : []), ...entry.history]
      .filter((past) => {
        if (historySeen.has(past)) return false
        historySeen.add(past)
        return true
      })
    return {
      ...entry,
      status,
      current: writeBody,
      history,
      differences: presentationByNo.get(entry.centerRecordNo)
        ? [...entry.differences, presentationByNo.get(entry.centerRecordNo)!]
        : entry.differences,
    }
  })

  // 历史回执登记保持原样（不回改状态）；每条结论的取代关系都可在 ledger.history 追溯
  const ingestions = state.ingestions

  const ingestion: ReceiptIngestion = {
    receiptId: prepared.receipt.id,
    batchId: prepared.receipt.batchId,
    version: prepared.receipt.version,
    issuedAt: prepared.receipt.issuedAt,
    receivedAt: prepared.receivedAt,
    status: options.ingestionStatus ?? (options.replayed ? 'recovered' : 'applied'),
    applied: journal.writes.length,
    stale: prepared.stale,
    duplicate: prepared.duplicate,
    unmatched: prepared.mismatches.length,
    detail: prepared.detail,
    recoveryJournalId: journal.id,
    fileLabel: `${prepared.receipt.id} v${prepared.receipt.version}`,
  }

  // 对不上的挂起清单按 回执+记录号+类型 去重追加
  const knownMismatches = new Set(state.mismatches.map((item) => item.id))
  const mismatches = [
    ...state.mismatches,
    ...prepared.mismatches.filter((item) => !knownMismatches.has(item.id)),
  ]

  return {
    state: {
      ...state,
      ledger,
      ingestions: [...ingestions, ingestion],
      mismatches,
      journals: [
        ...state.journals.filter((item) => item.id !== journal.id),
        { ...journal, replayed: Boolean(options.replayed) },
      ],
    },
    issues: nextIssues,
    ingestion,
    journal,
    reopened,
    restored,
  }
}

/**
 * 写入失败：保留「失败」登记与日志，台账不提交任何改动。
 */
export function failReceipt(
  state: ReconcileState,
  prepared: PreparedReceipt,
  journal: ReconcileJournal,
): { state: ReconcileState; ingestion: ReceiptIngestion } {
  const ingestion: ReceiptIngestion = {
    receiptId: prepared.receipt.id,
    batchId: prepared.receipt.batchId,
    version: prepared.receipt.version,
    issuedAt: prepared.receipt.issuedAt,
    receivedAt: prepared.receivedAt,
    status: 'failed',
    applied: 0,
    stale: prepared.stale,
    duplicate: prepared.duplicate,
    unmatched: prepared.mismatches.length,
    detail: `台账写入中断，已对上 ${prepared.writes.length} 条的结论保存在恢复日志中；恢复前不改动任何记录。`,
    recoveryJournalId: journal.id,
    fileLabel: `${prepared.receipt.id} v${prepared.receipt.version}`,
  }
  return {
    state: {
      ...state,
      ingestions: [...state.ingestions, ingestion],
      journals: [...state.journals, journal],
    },
    ingestion,
  }
}

/**
 * 从已对上的记录（日志）恢复：同一份回执仍只算一次，恢复后状态不再倒退。
 */
export function recoverReceipt(
  state: ReconcileState,
  issues: ValidationIssue[],
  journalId: string,
  records: BirdRecord[],
): CommitResult | null {
  const journal = state.journals.find((item) => item.id === journalId)
  if (!journal || journal.replayed) return null
  const batch = state.batches.find((item) => item.id === journal.batchId)
  if (!batch) return null

  const matched: PreparedReceipt['matched'] = []
  const lines: ReceiptLine[] = []
  for (const write of journal.writes) {
    const item = batch.manifest.find((candidate) => candidate.centerRecordNo === write.centerRecordNo)
    if (!item) continue
    matched.push({
      item,
      batch,
      line: {
        centerRecordNo: write.centerRecordNo,
        decision: write.kind === 'approved' ? 'approved' : 'rejected',
        reason: write.kind === 'rejected' ? write.reason : undefined,
        centerRingCode: write.centerRingCode,
        observedAt: item.observedAt,
      },
    })
    lines.push(matched.at(-1)!.line)
  }

  // 批准写入若当时未及生成冻结快照，恢复时用当前记录补
  const writes = journal.writes.map((write) => {
    if (write.kind !== 'approved' || write.frozenSnapshot) return write
    const item = matched.find((match) => match.item.centerRecordNo === write.centerRecordNo)
    const record = item ? records.find((candidate) => candidate.id === item.item.recordId) : undefined
    return { ...write, frozenSnapshot: record ? { ...record } : (null as unknown as BirdRecord) }
  })

  const version = Math.max(1, ...writes.map((write) => write.receiptVersion))
  const receipt: CenterReceipt = {
    id: journal.receiptId,
    batchId: journal.batchId,
    version,
    issuedAt: journal.createdAt,
    lines,
  }
  const prepared: PreparedReceipt = {
    receipt,
    status: 'recovered',
    detail: `从恢复日志重放 ${writes.length} 条已对上记录。`,
    backfilledReceiptIds: [],
    ledger: state.ledger,
    matched,
    writes,
    mismatches: [],
    stale: 0,
    superseded: 0,
    duplicate: 0,
    presentationDiffs: [],
    receivedAt: journal.createdAt,
  }

  // 清掉失败登记，替换为恢复登记
  const stateWithoutFailure: ReconcileState = {
    ...state,
    ingestions: state.ingestions.filter(
      (item) => !(item.recoveryJournalId === journalId && item.status === 'failed'),
    ),
  }
  const replayJournal: ReconcileJournal = { ...journal, writes, replayed: true }
  return commitReceipt(stateWithoutFailure, issues, prepared, replayJournal, {
    ingestionStatus: 'recovered',
    replayed: true,
  })
}

/* --------------------------- 冻结后的本地更正 ---------------------------- */

/**
 * 冻结后本地后到的更正：不动冻结定稿，只登记差异。
 * 返回 null 表示该记录未冻结，按普通人工编辑处理。
 */
export function registerPostFreezeCorrection(
  state: ReconcileState,
  record: BirdRecord,
  patch: Partial<BirdRecord>,
  reason: string,
  at: string,
): { state: ReconcileState; differences: FieldDifference[] } | null {
  const approved = state.ledger.filter(
    (entry) => entry.recordId === record.id && entry.current?.kind === 'approved',
  )
  if (!approved.length) return null
  const differences: FieldDifference[] = []
  const touchedEntries = new Set<string>()
  for (const key of Object.keys(patch) as (keyof BirdRecord)[]) {
    const next = patch[key]
    if (next === undefined) continue
    const nextText = String(next)
    for (const entry of approved) {
      const frozen = entry.current?.kind === 'approved' ? entry.current.frozenSnapshot : null
      const frozenValue = frozen ? String(frozen[key] ?? '') : ''
      if (nextText === frozenValue || touchedEntries.has(`${entry.centerRecordNo}:${key}`)) continue
      touchedEntries.add(`${entry.centerRecordNo}:${key}`)
      differences.push({
        field: key,
        localValue: frozenValue,
        centerValue: nextText,
        source: 'local_correction',
        noticedAt: at,
        detail: reason.trim()
          ? `冻结后本地更正：${reason.trim()}（不改中心已定稿的数据）。`
          : '冻结后本地更正，仅登记差异。',
      })
    }
  }
  if (!differences.length) return { state, differences: [] }
  const diffByEntry = new Map<string, FieldDifference[]>()
  differences.forEach((diff) => {
    // 差异挂在该记录每个通过批次的台账下
    approved.forEach((entry) => {
      const key = entry.centerRecordNo
      if (diff.field && String(record[diff.field] ?? '') === diff.localValue) {
        diffByEntry.set(key, [...(diffByEntry.get(key) || []), diff])
      }
    })
  })
  const ledger = state.ledger.map((entry) => {
    const extra = diffByEntry.get(entry.centerRecordNo)
    return extra ? { ...entry, differences: [...entry.differences, ...extra] } : entry
  })
  return { state: { ...state, ledger }, differences }
}

/* ------------------------------ 挂起项处理 ------------------------------- */

export function resolveMismatch(
  state: ReconcileState,
  mismatchIdValue: string,
  note: string,
): ReconcileState {
  return {
    ...state,
    mismatches: state.mismatches.map((item) =>
      item.id === mismatchIdValue
        ? { ...item, resolved: true, resolvedNote: note.trim() || '已人工核对，维持本地记录不变。' }
        : item,
    ),
  }
}

/* ------------------------------ 小工具 ---------------------------------- */

export function ledgerSummary(ledger: LedgerEntry[]) {
  return {
    transferred: ledger.filter((entry) => entry.status === 'transferred').length,
    approved: ledger.filter((entry) => entry.status === 'approved').length,
    rejected: ledger.filter((entry) => entry.status === 'rejected').length,
    pending: ledger.filter((entry) => entry.status === 'pending').length,
  }
}

/** 中心回执常用的「去分隔符」写法，用于模拟中心归一化与本地的呈现差异 */
export function centerStyleRingCode(localNormalized: string): string {
  return localNormalized.replace(/-/g, '')
}
