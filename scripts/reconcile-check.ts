import assert from 'node:assert/strict'
import { createMockRecords } from '../src/data/mockRecords'
import { createInitialReconcile } from '../src/data/mockReconciliation'
import { validateRecords } from '../src/utils/validation'
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
  ringIdentity,
  selectPendingTransfer,
} from '../src/utils/reconciliation'

const records = createMockRecords()
const baseIssues = validateRecords(records)
const initial = createInitialReconcile(records, baseIssues)
let state = initial.reconcile
let issues = initial.issues
const t = (iso: string) => iso
const log: string[] = []
function check(name: string, fn: () => void) {
  fn()
  log.push(`  ✓ ${name}`)
}

/* 0. 初始态 */
check('第一批 7 条历史通过数据缺回执编号，1 条无结论；第二批 9 条均已移交', () => {
  const b1 = state.ledger.filter((e) => e.batchId === 'TB-2026SPR-01')
  assert.equal(b1.length, 8)
  assert.equal(b1.filter((e) => e.status === 'approved').length, 7)
  assert.ok(b1.filter((e) => e.status === 'approved').every((e) => e.current?.receiptId === ''))
  assert.equal(b1.filter((e) => e.status === 'transferred').length, 1)
  assert.equal(state.ledger.filter((e) => e.batchId === 'TB-2026SPR-02').length, 9)
  assert.ok(state.inbox.length === 5)
})

/* 1. 第一批初始回执：回填编号 + 第 8 条新通过 */
const r0312 = state.inbox.find((r) => r.id === 'RCP-2026-0312')!
{
  const prepared = prepareReceipt(state, r0312, t('2026-03-12T12:00:00Z'))
  assert.equal(prepared.status, 'applied')
  assert.equal(prepared.backfilledReceiptIds.length, 7)
  assert.equal(prepared.writes.length, 1)
  const withSnap = attachFrozenSnapshots(prepared, records)
  const journal = journalFromPrepared(withSnap, 'J-0312', t('2026-03-12T12:00:00Z'))
  const committed = commitReceipt(state, issues, withSnap, journal, {})
  state = committed.state
  issues = committed.issues
}
check('初始回执把缺编号的 7 条回填为 RCP-2026-0312，第 8 条同步冻结', () => {
  const b1 = state.ledger.filter((e) => e.batchId === 'TB-2026SPR-01')
  assert.equal(b1.filter((e) => e.status === 'approved').length, 8)
  assert.ok(b1.every((e) => e.current?.receiptId === 'RCP-2026-0312'))
})

/* 2. 第二批 v1：5 通过 2 判退 3 对不上 */
const r0320v1 = state.inbox.find((r) => r.id === 'RCP-2026-0320' && r.version === 1)!
let v1Committed: ReturnType<typeof commitReceipt>
{
  const prepared = prepareReceipt(state, r0320v1, t('2026-03-20T18:00:00Z'))
  assert.equal(prepared.status, 'applied')
  assert.equal(prepared.writes.filter((w) => w.kind === 'approved').length, 5)
  assert.equal(prepared.writes.filter((w) => w.kind === 'rejected').length, 2)
  assert.equal(prepared.mismatches.length, 3)
  const kinds = prepared.mismatches.map((m) => m.kind).sort()
  assert.deepEqual(kinds, ['record_missing', 'ring_mismatch', 'time_mismatch'])
  const withSnap = attachFrozenSnapshots(prepared, records)
  const journal = journalFromPrepared(withSnap, 'J-0320-1', t('2026-03-20T18:00:00Z'))
  v1Committed = commitReceipt(state, issues, withSnap, journal, {})
  state = v1Committed.state
  issues = v1Committed.issues
}
check('v1：5 通过冻结、2 判退按原因重开、3 条对不上只列出且记录不变', () => {
  assert.equal(v1Committed.reopened.length > 0, true)
  const no3 = state.ledger.find((e) => e.centerRecordNo === 'CR-TB-2026SPR-02-0003')!
  assert.equal(no3.status, 'rejected')
  assert.match(no3.current?.kind === 'rejected' ? no3.current.reason : '', /原始环志登记表/)
  assert.equal(state.mismatches.length, 3)
  // 对不上的 0008/0009 状态不变
  for (const no of ['0008', '0009']) {
    const e = state.ledger.find((x) => x.centerRecordNo === `CR-TB-2026SPR-02-${no}`)!
    assert.equal(e.status, 'transferred')
    assert.equal(e.current, undefined)
  }
})
check('中心环号写法不同（去分隔符）身份一致 → 只记呈现差异，不覆盖本地环号', () => {
  const no1 = state.ledger.find((e) => e.centerRecordNo === 'CR-TB-2026SPR-02-0001')!
  const diffs = no1.differences.filter((d) => d.source === 'center_presentation')
  assert.equal(diffs.length, 1)
  assert.notEqual(diffs[0].centerValue, diffs[0].localValue)
  assert.equal(ringIdentity(diffs[0].centerValue), ringIdentity(diffs[0].localValue))
})

/* 3. 重发同编号同版本 → 只算一次 */
{
  const prepared = prepareReceipt(state, r0320v1, t('2026-03-22T09:00:00Z'))
  assert.equal(prepared.status, 'duplicate')
  assert.equal(prepared.writes.length, 0)
  const snapshot = JSON.stringify({ l: state.ledger, m: state.mismatches, i: issues })
  const prepared2 = prepareReceipt(state, { ...r0320v1 }, t('2026-03-22T09:05:00Z'))
  assert.equal(prepared2.status, 'duplicate')
  assert.equal(JSON.stringify({ l: state.ledger, m: state.mismatches, i: issues }), snapshot)
  check('v1 重发副本幂等：不新增写入、不新增挂起、台账字节级不变', () => {})
}

/* 4. 晚到旧件 → 整份拦截不倒退 */
const r0319 = state.inbox.find((r) => r.id === 'RCP-2026-0319')!
{
  const prepared = prepareReceipt(state, r0319, t('2026-03-22T10:00:00Z'))
  assert.equal(prepared.status, 'stale')
  assert.equal(prepared.writes.length, 0)
  const no1 = state.ledger.find((e) => e.centerRecordNo === 'CR-TB-2026SPR-02-0001')!
  assert.equal(no1.status, 'approved')
}
check('晚到的 RCP-2026-0319（签发更早）整份拦截，0001 仍为通过不退回', () => {})

/* 5. v2：判退改判通过 → 还原重开前处置态 */
const r0320v2 = state.inbox.find((r) => r.id === 'RCP-2026-0320' && r.version === 2)!
{
  const prepared = prepareReceipt(state, r0320v2, t('2026-03-21T16:00:00Z'))
  assert.equal(prepared.status, 'applied')
  assert.equal(prepared.writes.length, 2)
  assert.ok(prepared.writes.every((w) => w.kind === 'approved'))
  const withSnap = attachFrozenSnapshots(prepared, records)
  const journal = journalFromPrepared(withSnap, 'J-0320-2', t('2026-03-21T16:00:00Z'))
  const committed = commitReceipt(state, issues, withSnap, journal, {})
  state = committed.state
  issues = committed.issues
  assert.equal(committed.restored.length, v1Committed.reopened.length)
  assert.ok(issues.filter((i) => i.status === 'reopened').every(
    (i) => !['0003', '0006'].includes(
      state.ledger.find((e) => e.recordId === i.recordId)?.centerRecordNo.slice(-4) ?? '',
    ),
  ))
  const no3 = state.ledger.find((e) => e.centerRecordNo === 'CR-TB-2026SPR-02-0003')!
  assert.equal(no3.status, 'approved')
  assert.equal(no3.current?.kind, 'approved')
  assert.ok(no3.history.some((h) => h.kind === 'rejected'))
  assert.ok(no3.history.some((h) => h.kind === 'approved'))
  assert.equal(no3.history[0].kind, 'approved')
  assert.ok(no3.history.slice(1).some((h) => h.kind === 'rejected'))
}
check('v2 改判通过：最新通过在 current 与 history 首位，旧判退保留可追溯，重开问题还原', () => {})

/* 6. 晚到旧件在 v2 之后同样拦截；v1/v2 再到都不重复 */
check('v2 之后旧件与已处理件均不再生效', () => {
  assert.equal(prepareReceipt(state, r0319, t('2026-03-22T10:00:00Z')).status, 'stale')
  assert.equal(prepareReceipt(state, r0320v1, t('2026-03-22T10:01:00Z')).status, 'duplicate')
  assert.equal(prepareReceipt(state, r0320v2, t('2026-03-22T10:02:00Z')).status, 'duplicate')
})

/* 7. 待移交清单按新结果重算 */
{
  const pendingBefore = selectPendingTransfer(state, records, issues)
  const pendingIds = new Set(pendingBefore.map((r) => r.id))
  const approvedIds = new Set(
    state.ledger.filter((e) => e.status === 'approved').map((e) => e.recordId),
  )
  check('待移交清单：通过冻结的不出现；对不上未销项的 0008/0009 留在原批不重报', () => {
    for (const id of approvedIds) assert.equal(pendingIds.has(id), false)
    const no8 = state.ledger.find((e) => e.centerRecordNo === 'CR-TB-2026SPR-02-0008')!
    const no9 = state.ledger.find((e) => e.centerRecordNo === 'CR-TB-2026SPR-02-0009')!
    assert.equal(pendingIds.has(no8.recordId), false)
    assert.equal(pendingIds.has(no9.recordId), false)
    assert.ok(pendingBefore.length > 1000)
  })
  // 人工核对销项（不改记录）后，这两条才回到下一批候选
  const resolvedState = state.mismatches
    .filter((m) => ['CR-TB-2026SPR-02-0008', 'CR-TB-2026SPR-02-0009'].includes(m.line.centerRecordNo))
    .reduce((acc, m) => resolveMismatch(acc, m.id, '已核对纸质表，维持本地环号/时间'), state)
  const pendingAfter = selectPendingTransfer(resolvedState, records, issues)
  const afterIds = new Set(pendingAfter.map((r) => r.id))
  const no8 = state.ledger.find((e) => e.centerRecordNo === 'CR-TB-2026SPR-02-0008')!
  check('挂起项人工核对销项后，0008/0009 才带回下一批；本地记录值未改', () => {
    assert.ok(afterIds.has(no8.recordId))
  })
  state = resolvedState
}

/* 8. 冻结后本地更正：只列差异，定稿不变 */
{
  const approvedEntry = state.ledger.find((e) => e.status === 'approved')!
  const frozenRecord = records.find((r) => r.id === approvedEntry.recordId)!
  const before = JSON.stringify(frozenRecord)
  const outcome = registerPostFreezeCorrection(
    state,
    frozenRecord,
    { location: '后到更正地点' },
    '救助站补报',
    t('2026-03-25T08:00:00Z'),
  )
  assert.ok(outcome)
  assert.equal(outcome.differences.length >= 1, true)
  assert.equal(JSON.stringify(frozenRecord), before)
  state = outcome.state
}
check('冻结记录的本地后到更正不改任何记录值，差异挂在台账可查', () => {})

/* 9. 打包下一批：只打可移交记录，生成新批次与台账 */
{
  const before = state.ledger.length
  const { state: next, packed, eligible } = packTransferBatch(state, records, {
    id: 'TB-2026SPR-03',
    label: '第三批',
    center: '华东区域鸟类环志中心',
    packedAt: t('2026-04-01T01:00:00Z'),
    limit: 50,
  })
  assert.equal(packed.length, 50)
  assert.ok(eligible >= 50)
  assert.equal(next.ledger.length, before + 50)
  assert.ok(packed.every((item) => !state.ledger.some(
    (e) => e.recordId === item.recordId && e.status === 'approved',
  )))
  state = next
}
check('新批次只纳入重算后的待移交记录（冻结记录被排除）', () => {})

/* 10. 写入失败 → 台账不变、日志保留 → 从已对上记录恢复 */
{
  const fresh = createInitialReconcile(records, baseIssues)
  let s2 = fresh.reconcile
  let i2 = fresh.issues
  // 先处理第一批
  const p0 = prepareReceipt(s2, s2.inbox.find((r) => r.id === 'RCP-2026-0312')!, t('2026-03-12T12:00:00Z'))
  const c0 = commitReceipt(s2, i2, attachFrozenSnapshots(p0, records), journalFromPrepared(attachFrozenSnapshots(p0, records), 'K0', t('2026-03-12T12:00:00Z')), {})
  s2 = c0.state; i2 = c0.issues
  const ledgerBefore = JSON.stringify(s2.ledger)
  const pv1 = prepareReceipt(s2, s2.inbox.find((r) => r.id === 'RCP-2026-0320' && r.version === 1)!, t('2026-03-20T18:00:00Z'))
  const jv1 = journalFromPrepared(attachFrozenSnapshots(pv1, records), 'K-FAIL', t('2026-03-20T18:00:00Z'))
  const failed = failReceipt(s2, attachFrozenSnapshots(pv1, records), jv1)
  s2 = failed.state
  assert.equal(JSON.stringify(s2.ledger), ledgerBefore)
  assert.equal(s2.ingestions.at(-1)?.status, 'failed')
  assert.equal(s2.journals.find((j) => j.id === 'K-FAIL')?.replayed, false)
  // 同件重发在失败状态下仍不重复处理
  const again = prepareReceipt(s2, s2.inbox.find((r) => r.id === 'RCP-2026-0320' && r.version === 1)!, t('2026-03-20T19:00:00Z'))
  assert.equal(again.status, 'duplicate')
  // 从日志恢复
  const recovered = recoverReceipt(s2, i2, 'K-FAIL', records)
  assert.ok(recovered)
  s2 = recovered.state; i2 = recovered.issues
  assert.equal(recovered.ingestion.status, 'recovered')
  assert.equal(s2.ledger.find((e) => e.centerRecordNo === 'CR-TB-2026SPR-02-0003')!.status, 'rejected')
  assert.equal(i2.filter((i) => i.status === 'reopened').length > 0, true)
  // 恢复只算一次：再次恢复被拒绝
  assert.equal(recoverReceipt(s2, i2, 'K-FAIL', records), null)
}
check('写入失败后台账零改动；从已对上记录的日志恢复，且恢复也只算一次', () => {})

/* 11. 环号身份键：分隔符/空格/全半角归一 */
check('ringIdentity 忽略写法差异、保留数字串身份', () => {
  assert.equal(ringIdentity('BJ-2021-01234'), ringIdentity('BJ202101234'))
  assert.notEqual(ringIdentity('BJ-2021-01234'), ringIdentity('BJ-2021-01235'))
  assert.equal(ringIdentity('沪环 2021 01234'), ringIdentity('SH-2021-01234'))
})

console.log(log.join('\n'))
console.log(`\n全部 ${log.length} 组对账规则校验通过。`)
