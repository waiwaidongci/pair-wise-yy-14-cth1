import {
  CheckCircleOutlined,
  CloseCircleOutlined,
  ExclamationCircleOutlined,
  ImportOutlined,
  ReloadOutlined,
  SafetyCertificateOutlined,
  SyncOutlined,
  UndoOutlined,
  WarningOutlined,
} from '@ant-design/icons'
import {
  Alert,
  App as AntdApp,
  Button,
  Card,
  Col,
  Empty,
  Row,
  Space,
  Table,
  Tabs,
  Tag,
  Typography,
} from 'antd'
import type { ColumnsType } from 'antd/es/table'
import { useEffect, useMemo } from 'react'
import { useHandoverStore } from '../stores/handoverStore'
import { useValidationStore } from '../stores/validationStore'
import type { AuditReceipt, HandoverBatch, ReceiptMatch } from '../types'

const verdictMeta = {
  approved: { label: '通过', color: 'green' },
  rejected: { label: '判退', color: 'volcano' },
}

const dispositionMeta = {
  matched: { label: '已对上', color: 'green' },
  unmatched: { label: '未对上', color: 'default' },
  conflict: { label: '冲突', color: 'red' },
}

const matchFieldLabels = {
  centerRecordId: '中心记录号',
  localRingCode: '本地环号',
  observedAt: '时间',
}

export function ReconciliationPage() {
  const { message, modal } = AntdApp.useApp()
  const records = useValidationStore((state) => state.records)
  const frozenDifferences = useValidationStore((state) => state.frozenDifferences)
  const batches = useHandoverStore((state) => state.batches)
  const receipts = useHandoverStore((state) => state.receipts)
  const lateReceipts = useHandoverStore((state) => state.lateReceipts)
  const reconciliation = useHandoverStore((state) => state.reconciliation)
  const settleResult = useHandoverStore((state) => state.settleResult)
  const loaded = useHandoverStore((state) => state.loaded)
  const loadMockData = useHandoverStore((state) => state.loadMockData)
  const runReconciliation = useHandoverStore((state) => state.runReconciliation)
  const applyReconciliation = useHandoverStore((state) => state.applyReconciliation)
  const loadLateReceipts = useHandoverStore((state) => state.loadLateReceipts)
  const recomputePending = useHandoverStore((state) => state.recomputePending)

  useEffect(() => {
    if (!loaded) loadMockData()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loaded])

  const recordById = useMemo(() => new Map(records.map((record) => [record.id, record])), [records])

  const matchByReceiptId = useMemo(() => {
    const map = new Map<string, ReceiptMatch>()
    reconciliation?.matches.forEach((match) => map.set(match.receipt.id, match))
    return map
  }, [reconciliation])

  const pendingRecords = useMemo(
    () => records.filter((record) => reconciliation?.pendingRecordIds.includes(record.id)),
    [records, reconciliation],
  )
  const frozenRecords = useMemo(
    () => records.filter((record) => record.frozen),
    [records],
  )
  const reopenedRecords = useMemo(() => {
    if (!reconciliation) return []
    return reconciliation.reopenedRecordIds
      .map((id) => recordById.get(id))
      .filter((record): record is NonNullable<typeof record> => Boolean(record))
  }, [reconciliation, recordById])

  const unmatchedReceipts = reconciliation?.unmatchedReceipts ?? []
  const conflicts = reconciliation?.conflicts ?? []
  const backfilled = reconciliation?.backfilled ?? []
  const differences = reconciliation?.differences ?? frozenDifferences

  const receiptColumns: ColumnsType<AuditReceipt> = [
    { title: '回执编号', dataIndex: 'receiptId', width: 130, fixed: 'left', render: (v: string) => <Typography.Text code>{v}</Typography.Text> },
    { title: '版本', dataIndex: 'version', width: 70, render: (v: number) => <Tag>v{v}</Tag> },
    { title: '批次', dataIndex: 'batchId', width: 150 },
    { title: '中心记录号', dataIndex: 'centerRecordId', width: 130, render: (v: string) => <Typography.Text code>{v}</Typography.Text> },
    { title: '本地环号', dataIndex: 'localRingCode', width: 160, render: (v: string) => <Typography.Text code>{v}</Typography.Text> },
    { title: '时间', dataIndex: 'observedAt', width: 150 },
    {
      title: '判定',
      dataIndex: 'verdict',
      width: 80,
      render: (v: AuditReceipt['verdict']) => <Tag color={verdictMeta[v].color}>{verdictMeta[v].label}</Tag>,
    },
    { title: '判退原因', dataIndex: 'reason', width: 220, ellipsis: true, render: (v?: string) => v || '—' },
    {
      title: '匹配状态',
      key: 'disposition',
      width: 100,
      render: (_, receipt) => {
        const match = matchByReceiptId.get(receipt.id)
        const disposition = match?.disposition ?? 'unmatched'
        return <Tag color={dispositionMeta[disposition].color}>{dispositionMeta[disposition].label}</Tag>
      },
    },
    {
      title: '匹配字段',
      key: 'matchedBy',
      width: 200,
      render: (_, receipt) => {
        const match = matchByReceiptId.get(receipt.id)
        if (!match || !match.matchedBy.length) return <Typography.Text type="secondary">—</Typography.Text>
        return match.matchedBy.map((field) => (
          <Tag key={field} color="blue">{matchFieldLabels[field]}</Tag>
        ))
      },
    },
    {
      title: '对应记录',
      key: 'recordId',
      width: 130,
      render: (_, receipt) => {
        const match = matchByReceiptId.get(receipt.id)
        return match?.recordId ? <Typography.Text code>{match.recordId}</Typography.Text> : '—'
      },
    },
  ]

  const pendingColumns: ColumnsType<(typeof pendingRecords)[number]> = [
    { title: '记录编号', dataIndex: 'id', width: 130, render: (v: string) => <Typography.Text code>{v}</Typography.Text> },
    { title: '归一化环号', dataIndex: 'normalizedRingCode', width: 160, render: (v: string) => <strong>{v}</strong> },
    { title: '原始环号', dataIndex: 'rawRingCode', width: 160 },
    { title: '鸟种', dataIndex: 'speciesCanonical', width: 140 },
    { title: '地点', dataIndex: 'location', width: 140 },
    { title: '来源', dataIndex: 'source', width: 170 },
    { title: '观察时间', dataIndex: 'observedAt', width: 160 },
  ]

  const frozenColumns: ColumnsType<(typeof frozenRecords)[number]> = [
    { title: '记录编号', dataIndex: 'id', width: 130, render: (v: string) => <Typography.Text code>{v}</Typography.Text> },
    { title: '归一化环号', dataIndex: 'normalizedRingCode', width: 160 },
    { title: '鸟种', dataIndex: 'speciesCanonical', width: 140 },
    { title: '回执编号', dataIndex: 'receiptId', width: 130, render: (v?: string) => v ? <Typography.Text code>{v}</Typography.Text> : '—' },
    { title: '中心记录号', dataIndex: 'centerRecordId', width: 130, render: (v?: string) => v ? <Typography.Text code>{v}</Typography.Text> : '—' },
    { title: '冻结原因', dataIndex: 'frozenReason', width: 160 },
    { title: '冻结时间', dataIndex: 'frozenAt', width: 180, render: (v?: string) => v ? new Date(v).toLocaleString('zh-CN') : '—' },
  ]

  const reopenedColumns: ColumnsType<(typeof reopenedRecords)[number]> = [
    { title: '记录编号', dataIndex: 'id', width: 130, render: (v: string) => <Typography.Text code>{v}</Typography.Text> },
    { title: '归一化环号', dataIndex: 'normalizedRingCode', width: 160 },
    { title: '鸟种', dataIndex: 'speciesCanonical', width: 140 },
    { title: '地点', dataIndex: 'location', width: 140 },
    {
      title: '判退原因',
      key: 'reason',
      width: 320,
      ellipsis: true,
      render: (_, record) => {
        const match = reconciliation?.matches.find(
          (m) => m.recordId === record.id && m.disposition === 'matched' && m.receipt.verdict === 'rejected',
        )
        return match?.receipt.reason || '—'
      },
    },
  ]

  const unmatchedColumns: ColumnsType<AuditReceipt> = [
    { title: '回执编号', dataIndex: 'receiptId', width: 140, render: (v: string) => <Typography.Text code>{v}</Typography.Text> },
    { title: '中心记录号', dataIndex: 'centerRecordId', width: 140, render: (v: string) => <Typography.Text code>{v}</Typography.Text> },
    { title: '本地环号', dataIndex: 'localRingCode', width: 180, render: (v: string) => <Typography.Text code>{v}</Typography.Text> },
    { title: '时间', dataIndex: 'observedAt', width: 160 },
    { title: '判定', dataIndex: 'verdict', width: 90, render: (v: AuditReceipt['verdict']) => <Tag color={verdictMeta[v].color}>{verdictMeta[v].label}</Tag> },
    { title: '判退原因', dataIndex: 'reason', width: 240, ellipsis: true, render: (v?: string) => v || '—' },
    { title: '回传时间', dataIndex: 'receivedAt', width: 180, render: (v: string) => new Date(v).toLocaleString('zh-CN') },
  ]

  const differenceColumns = [
    { title: '记录编号', dataIndex: 'recordId', width: 130, render: (v: string) => <Typography.Text code>{v}</Typography.Text> },
    { title: '字段', dataIndex: 'field', width: 120 },
    { title: '本地更正（后到）', dataIndex: 'localValue', width: 200, render: (v: string) => <Typography.Text code>{v || '空'}</Typography.Text> },
    { title: '中心口径（冻结）', dataIndex: 'centerValue', width: 200, render: (v: string) => <Typography.Text code>{v || '空'}</Typography.Text> },
    { title: '说明', dataIndex: 'reason', width: 260, ellipsis: true },
    { title: '时间', dataIndex: 'reportedAt', width: 180, render: (v: string) => new Date(v).toLocaleString('zh-CN') },
  ]

  const backfillColumns = [
    { title: '记录编号', dataIndex: 'recordId', width: 140, render: (v: string) => <Typography.Text code>{v}</Typography.Text> },
    { title: '回填回执编号', dataIndex: 'receiptId', width: 160, render: (v: string) => <Typography.Text code>{v}</Typography.Text> },
    { title: '回填中心记录号', dataIndex: 'centerRecordId', width: 160, render: (v: string) => <Typography.Text code>{v}</Typography.Text> },
  ]

  const conflictColumns = [
    { title: '回执编号', dataIndex: 'receiptId', width: 160, render: (v: string) => <Typography.Text code>{v}</Typography.Text> },
    { title: '记录编号', dataIndex: 'recordId', width: 140, render: (v: string) => <Typography.Text code>{v}</Typography.Text> },
    { title: '冲突原因', dataIndex: 'reason', width: 400, ellipsis: true },
  ]

  const stats = [
    { label: '回执总数', value: reconciliation?.receiptCount ?? 0, icon: <SyncOutlined />, tone: 'teal' },
    { label: '已对上', value: reconciliation?.matchedCount ?? 0, icon: <CheckCircleOutlined />, tone: 'green' },
    { label: '未对上', value: unmatchedReceipts.length, icon: <ExclamationCircleOutlined />, tone: 'amber' },
    { label: '冻结记录', value: frozenRecords.length, icon: <SafetyCertificateOutlined />, tone: 'blue' },
    { label: '重开记录', value: reopenedRecords.length, icon: <UndoOutlined />, tone: 'red' },
    { label: '待移交', value: pendingRecords.length, icon: <ImportOutlined />, tone: 'teal' },
    { label: '回填编号', value: backfilled.length, icon: <ReloadOutlined />, tone: 'green' },
    { label: '重复回执', value: reconciliation?.duplicateReceiptIds.length ?? 0, icon: <SyncOutlined />, tone: 'amber' },
    { label: '被取代旧版', value: reconciliation?.supersededReceiptIds.length ?? 0, icon: <CloseCircleOutlined />, tone: 'amber' },
    { label: '写入冲突', value: conflicts.length, icon: <WarningOutlined />, tone: 'red' },
  ]

  return (
    <div className="page-stack">
      <div className="page-heading">
        <div>
          <Typography.Title level={2}>移交批次 · 审核回执 · 处置记录 对账</Typography.Title>
          <Typography.Paragraph type="secondary">
            回执按中心记录号、本地环号和时间对上；对不上的先列出、不改记录。中心判通过的冻结，本地后到更正只列差异；判退的按原因重开。同一份回执只算一次，晚到旧版本不倒退状态。
          </Typography.Paragraph>
        </div>
        <Tag icon={<SafetyCertificateOutlined />} color="green">对账在浏览器内运行，写入失败自动恢复</Tag>
      </div>

      <Card className="tool-card" variant="borderless">
        <div className="toolbar-row">
          <Space wrap>
            <Button
              icon={<ReloadOutlined />}
              onClick={() => {
                runReconciliation()
                void message.success('已按当前回执重新对账')
              }}
            >
              重新对账
            </Button>
            <Button
              type="primary"
              icon={<CheckCircleOutlined />}
              onClick={() => {
                const result = applyReconciliation()
                if (result?.ok) void message.success(result.message)
                else if (result) void message.warning(result.message)
              }}
            >
              应用回执结果
            </Button>
            <Button
              icon={<ImportOutlined />}
              disabled={!lateReceipts.length}
              onClick={() => {
                modal.confirm({
                  title: '导入晚到回执？',
                  content: '将导入 1 条判退新版回执（触发写入冲突演示）和 1 条旧版回执（不得倒退状态）。',
                  okText: '导入并对账',
                  onOk: () => {
                    loadLateReceipts()
                    void message.info('晚到回执已导入并重新对账')
                  },
                })
              }}
            >
              导入晚到回执 {lateReceipts.length ? `（${lateReceipts.length}）` : ''}
            </Button>
            <Button
              icon={<SyncOutlined />}
              onClick={() => {
                recomputePending()
                void message.success('待移交清单已按最新结果重算')
              }}
            >
              重算待移交清单
            </Button>
          </Space>
        </div>
      </Card>

      {settleResult && !settleResult.ok && (
        <Alert
          showIcon
          type="error"
          icon={<WarningOutlined />}
          message="写入失败，已从已对上的记录恢复"
          description={
            <div>
              <div>{settleResult.message}</div>
              <div className="muted-text">
                已恢复 {settleResult.recoveredRecordIds.length} 条已对上记录：
                {settleResult.recoveredRecordIds.slice(0, 12).map((id) => (
                  <Tag key={id} color="default">{id}</Tag>
                ))}
                {settleResult.recoveredRecordIds.length > 12 ? ' …' : ''}
              </div>
            </div>
          }
        />
      )}

      {settleResult?.ok && (
        <Alert
          showIcon
          type="success"
          message="回执结果已应用"
          description={settleResult.message}
        />
      )}

      {unmatchedReceipts.length > 0 && (
        <Alert
          showIcon
          type="warning"
          icon={<ExclamationCircleOutlined />}
          message={`${unmatchedReceipts.length} 条回执对不上，已列出、未改任何记录`}
          description="以下回执的中心记录号、本地环号或时间无法与本地记录对应，请人工核对后再决定是否补录。"
        />
      )}

      <Row gutter={[12, 12]}>
        {stats.map((stat) => (
          <Col key={stat.label} span={4}>
            <Card variant="borderless" className={`stat-card stat-card--${stat.tone}`}>
              <div className="stat-card__icon">{stat.icon}</div>
              <div>
                <span className="stat-card__label">{stat.label}</span>
                <strong className="stat-card__value">{stat.value.toLocaleString()}</strong>
              </div>
            </Card>
          </Col>
        ))}
      </Row>

      <Card className="table-card" variant="borderless" title="移交批次">
        <Table
          rowKey="id"
          size="small"
          pagination={false}
          dataSource={batches}
          columns={[
            { title: '批次编号', dataIndex: 'id', width: 170, render: (v: string) => <Typography.Text code>{v}</Typography.Text> },
            { title: '批次名称', dataIndex: 'name' },
            { title: '移交时间', dataIndex: 'sentAt', width: 180, render: (v: string) => new Date(v).toLocaleString('zh-CN') },
            { title: '记录数', dataIndex: 'recordIds', width: 90, render: (ids: string[]) => ids.length },
            {
              title: '状态',
              dataIndex: 'status',
              width: 100,
              render: (v: HandoverBatch['status']) => {
                const map: Record<HandoverBatch['status'], { label: string; color: string }> = {
                  sent: { label: '已移交', color: 'blue' },
                  partial: { label: '部分结算', color: 'gold' },
                  settled: { label: '已结算', color: 'green' },
                }
                return <Tag color={map[v].color}>{map[v].label}</Tag>
              },
            },
          ]}
        />
      </Card>

      <Card className="table-card" variant="borderless">
        <Tabs
          items={[
            {
              key: 'receipts',
              label: `回执列表（${receipts.length}）`,
              children: (
                <Table<AuditReceipt>
                  rowKey="id"
                  size="small"
                  bordered
                  columns={receiptColumns}
                  dataSource={receipts}
                  pagination={{ pageSize: 12, showSizeChanger: false }}
                  scroll={{ x: 1500 }}
                />
              ),
            },
            {
              key: 'unmatched',
              label: `未对上回执（${unmatchedReceipts.length}）`,
              children: unmatchedReceipts.length ? (
                <Table<AuditReceipt>
                  rowKey="id"
                  size="small"
                  bordered
                  columns={unmatchedColumns}
                  dataSource={unmatchedReceipts}
                  pagination={false}
                />
              ) : (
                <Empty description="所有回执均已对上" />
              ),
            },
            {
              key: 'pending',
              label: `待移交清单（${pendingRecords.length}）`,
              children: (
                <Table<(typeof pendingRecords)[number]>
                  rowKey="id"
                  size="small"
                  bordered
                  columns={pendingColumns}
                  dataSource={pendingRecords}
                  pagination={{ pageSize: 12, showSizeChanger: false }}
                  scroll={{ x: 1100 }}
                />
              ),
            },
            {
              key: 'frozen',
              label: `冻结记录（${frozenRecords.length}）`,
              children: (
                <Table<(typeof frozenRecords)[number]>
                  rowKey="id"
                  size="small"
                  bordered
                  columns={frozenColumns}
                  dataSource={frozenRecords}
                  pagination={{ pageSize: 12, showSizeChanger: false }}
                  scroll={{ x: 1200 }}
                />
              ),
            },
            {
              key: 'reopened',
              label: `判退重开（${reopenedRecords.length}）`,
              children: reopenedRecords.length ? (
                <Table<(typeof reopenedRecords)[number]>
                  rowKey="id"
                  size="small"
                  bordered
                  columns={reopenedColumns}
                  dataSource={reopenedRecords}
                  pagination={{ pageSize: 12, showSizeChanger: false }}
                  scroll={{ x: 1100 }}
                />
              ) : (
                <Empty description="暂无判退重开记录" />
              ),
            },
            {
              key: 'differences',
              label: `更正差异（${differences.length}）`,
              children: differences.length ? (
                <Table
                  rowKey={(record) => `${record.recordId}-${record.field}-${record.reportedAt}`}
                  size="small"
                  bordered
                  columns={differenceColumns}
                  dataSource={differences}
                  pagination={false}
                />
              ) : (
                <Empty description="暂无本地后到更正与中心口径的差异" />
              ),
            },
            {
              key: 'backfill',
              label: `回执回填（${backfilled.length}）`,
              children: backfilled.length ? (
                <Table
                  rowKey="recordId"
                  size="small"
                  bordered
                  columns={backfillColumns}
                  dataSource={backfilled}
                  pagination={false}
                />
              ) : (
                <Empty description="所有已对上记录均已有回执编号" />
              ),
            },
            {
              key: 'conflicts',
              label: `写入冲突（${conflicts.length}）`,
              children: conflicts.length ? (
                <Table
                  rowKey={(record) => `${record.receiptId}-${record.recordId}`}
                  size="small"
                  bordered
                  columns={conflictColumns}
                  dataSource={conflicts}
                  pagination={false}
                />
              ) : (
                <Empty description="暂无写入冲突" />
              ),
            },
          ]}
        />
      </Card>
    </div>
  )
}
