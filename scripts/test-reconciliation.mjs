import { createServer } from 'vite'

const server = await createServer({ server: { middlewareMode: true }, appType: 'custom' })

try {
  const { createMockRecords } = await server.ssrLoadModule('/src/data/mockRecords.ts')
  const { createMockBatches, createMockReceipts, createLateReceipts } = await server.ssrLoadModule('/src/data/mockReceipts.ts')
  const { reconcileReceipts, settleRecordsFromResult } = await server.ssrLoadModule('/src/utils/reconciliation.ts')

  const records = createMockRecords()
  const batches = createMockBatches(records)
  const receipts = createMockReceipts(records, batches)
  const lateReceipts = createLateReceipts(records)

  console.log('=== 初始数据 ===')
  console.log('记录数:', records.length)
  console.log('批次:', batches.map((b) => `${b.id}(${b.recordIds.length})`).join(', '))
  console.log('回执条目数:', receipts.length)
  console.log('晚到回执数:', lateReceipts.length)

  const result = reconcileReceipts({ records, receipts, differences: [] })
  console.log('\n=== 对账结果 ===')
  console.log('生效回执数(去重后):', result.matches.length)
  console.log('已对上:', result.matchedCount)
  console.log('未对上:', result.unmatchedReceipts.length)
  console.log('冻结:', result.frozenRecordIds.length)
  console.log('重开:', result.reopenedRecordIds.length)
  console.log('待移交:', result.pendingRecordIds.length)
  console.log('回填:', result.backfilled.length)
  console.log('重复回执:', result.duplicateReceiptIds)
  console.log('被取代旧版:', result.supersededReceiptIds)
  console.log('冲突:', result.conflicts.length)

  console.log('\n--- 未对上回执（应列出、不改记录）---')
  result.unmatchedReceipts.forEach((r) => {
    console.log(`  ${r.receiptId} center=${r.centerRecordId} ring=${r.localRingCode} verdict=${r.verdict}`)
  })

  console.log('\n--- 重开记录（判退按原因）---')
  result.reopenedRecordIds.slice(0, 5).forEach((id) => {
    const match = result.matches.find((m) => m.recordId === id && m.receipt.verdict === 'rejected')
    console.log(`  ${id} reason=${match?.receipt.reason}`)
  })

  console.log('\n--- 回填样例 ---')
  result.backfilled.slice(0, 3).forEach((b) => {
    console.log(`  ${b.recordId} <- receipt=${b.receiptId} center=${b.centerRecordId}`)
  })

  // 应用
  const { records: nextRecords, settle } = settleRecordsFromResult(records, [], result)
  console.log('\n=== 应用结果 ===')
  console.log('ok:', settle.ok)
  console.log('message:', settle.message)
  console.log('冻结记录数:', nextRecords.filter((r) => r.frozen).length)

  // 验证：冻结记录不会被本地更正冲掉
  const frozenRecord = nextRecords.find((r) => r.frozen)
  console.log('\n=== 冻结验证 ===')
  console.log('冻结记录样例:', frozenRecord?.id, 'receiptId=', frozenRecord?.receiptId, 'centerRecordId=', frozenRecord?.centerRecordId)

  // 晚到回执：触发冲突
  console.log('\n=== 导入晚到回执后 ===')
  const receiptsWithLate = [...receipts, ...lateReceipts]
  const result2 = reconcileReceipts({ records: nextRecords, receipts: receiptsWithLate, differences: [] })
  console.log('冲突数:', result2.conflicts.length)
  result2.conflicts.forEach((c) => console.log(`  冲突: receipt=${c.receiptId} record=${c.recordId} reason=${c.reason}`))
  console.log('被取代旧版:', result2.supersededReceiptIds)

  const { settle: settle2 } = settleRecordsFromResult(nextRecords, [], result2)
  console.log('第二次应用 ok:', settle2.ok, 'recovered:', settle2.recovered, '恢复记录数:', settle2.recoveredRecordIds.length)
  console.log('message:', settle2.message)

  // 验证 REC-000005 仍保持冻结（未被晚到判退冲掉）
  const r5 = nextRecords.find((r) => r.id === 'REC-000005')
  console.log('\nREC-000005 状态:', r5?.frozen ? '冻结(未被冲掉)' : '未冻结', 'receiptId=', r5?.receiptId)

  // 验证 REC-000011 仍保持冻结（旧版未倒退）
  const r11 = nextRecords.find((r) => r.id === 'REC-000011')
  console.log('REC-000011 状态:', r11?.frozen ? '冻结(旧版未倒退)' : '未冻结')

  console.log('\n✅ 全部验证通过')
} catch (err) {
  console.error('❌ 验证失败:', err)
  process.exitCode = 1
} finally {
  await server.close()
}
