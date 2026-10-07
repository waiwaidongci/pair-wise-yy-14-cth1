import {
  Alert,
  App as AntdApp,
  Badge,
  Button,
  Card,
  Collapse,
  Descriptions,
  Empty,
  Input,
  Modal,
  Popconfirm,
  Space,
  Statistic,
  Switch,
  Table,
  Tabs,
  Tag,
  Timeline,
  Tooltip,
  Typography,
} from 'antd'
import type { ColumnsType } from 'antd/es/table'
import {
  CheckCircleTwoTone,
  CloseCircleTwoTone,
  DatabaseTwoTone,
  InboxOutlined,
  SendOutlined,
  SyncOutlined,
  WarningTwoTone,
} from '@ant-design/icons'
import { useMemo, useState } from 'react'
import { INBOX_FILE_LABELS } from '../data/mockReconciliation'
import { useValidationStore } from '../stores/validationStore'
import type {
  FieldDifference,
  LedgerEntry,
  ReceiptIngestion,
  ReconcileMismatch,
  TransferBatch,
  ValidationIssue,
} from '../types'
import {
  ledgerSummary,
  selectPendingTransfer,
  statusLabel,
} from '../utils/reconciliation'
import { exportPendingTransferCsv } from '../utils/exporters'

const mismatchMeta: Record<ReconcileMismatch['kind'], { label: string; color: string }> = {
  record_missing: { label: '中心记录号不存在', color: 'red' },
  ring_mismatch: { label: '环号对不上', color: 'volcano' },
  time_mismatch: { label: '时间对不上', color: 'orange' },
  duplicate_center_ref: { label: '中心记录号重复', color: 'magenta' },
}

const ingestionColor: Record<ReceiptIngestion['status'], string> = {
  applied: 'green',
  duplicate: 'default',
  superseded: 'gold',
  stale: 'orange',
  failed: 'red',
  recovered: 'cyan',
}

const ledgerStatusMeta: Record<LedgerEntry['status'], { label: string; color: string }> = {
  pending: { label: '待移交', color: 'default' },
  transferred: { label: '已移交待回执', color: 'processing' },
  approved: { label: '中心通过·冻结', color: 'green' },
  rejected: { label: '中心判退·已重开', color: 'volcano' },
}

const diffSourceMeta: Record<FieldDifference['source'], { label: string; color: string }> = {
  center_presentation: { label: '中心写法差异（不采信）', color: 'gold' },
  local_correction: { label: '冻结后本地更正（仅差异）', color: 'blue' },
}

function formatTime(iso: string) {
  if (!iso) return ''
  return new Date(iso).toLocaleString('zh-CN', { hour12: false })
}

export function ReconcilePage() {
  const { message, modal } = AntdApp.useApp()
  const records = useValidationStore((s) => s.records)
  const issues = useValidationStore((s) => s.issues)
  const operations = useValidationStore((s) => s.operations)
  const reconcile = useValidationStore((s) => s.reconcile)
  const ingest = useValidationStore((s) => s.ingestInboxReceipt)
  const recover = useValidationStore((s) => s.recoverFailedReceipt)
  const packBatch = useValidationStore((s) => s.packPendingBatch)
  const armFailure = useValidationStore((s) => s.armFailure)
  const resolveMismatch = useValidationStore((s) => s.markMismatchResolved)
  const simulateCorrection = useValidationStore((s) => s.simulateFrozenCorrection)
  const [batchLabel, setBatchLabel] = useState('')

  const pending = useMemo(
    () => selectPendingTransfer(reconcile, records, issues),
    [reconcile, records, issues],
  )
  const summary = ledgerSummary(reconcile.ledger)
  const unresolvedMismatches = reconcile.mismatches.filter((m) => !m.resolved)
  const failedJournals = reconcile.journals.filter((j) => !j.replayed)

  const issueCountByRecord = useMemo(() => {
    const map = new Map<string, ValidationIssue[]>()
    issues.forEach((issue) => {
      if (issue.status === 'open' || issue.status === 'reopened') {
        map.set(issue.recordId, [...(map.get(issue.recordId) ?? []), issue])
      }
    })
    return map
  }, [issues])

  const runIngest = (receiptKey: string, copyIndex: number) => {
    const result = ingest(receiptKey, copyIndex)
    if (result.ok) {
      void message.success({
        content: (
          <Space direction="vertical" size={0}>
            <span>{result.resultText}</span>
            {result.reopenedCount > 0 && (
              <span className="muted-text">中心判退已按原因重开 {result.reopenedCount} 条处置记录</span>
            )}
            {result.restoredCount > 0 && (
              <span>改判通过，还原重开处置 {result.restoredCount} 条</span>
            )}
          </Space>
        ),
        duration: 6,
      })
    } else if (result.failedJournalId) {
      void message.error({
        content: `台账写入失败：${result.resultText} 请到“处置流水”从日志重放。`,
        duration: 7,
      })
    } else {
      void message.warning(result.resultText)
    }
  }

  /* ------------------------------ 收件箱表格 ------------------------------ */
  const inboxRows = reconcile.inbox.map((receipt, index) => {
    const copyIndex = reconcile.inbox
      .slice(0, index + 1)
      .filter((item) => item.id === receipt.id && item.version === receipt.version).length - 1
    const totalCopies = reconcile.inbox.filter(
      (item) => item.id === receipt.id && item.version === receipt.version,
    ).length
    const handled = reconcile.ingestions.find(
      (item) => item.receiptId === receipt.id && item.version === receipt.version,
    )
    return {
      key: `${receipt.id}:${receipt.version}#${copyIndex}`,
      receiptKey: `${receipt.id}:${receipt.version}`,
      copyIndex,
      totalCopies,
      receipt,
      handled,
    }
  })

  const inboxColumns: ColumnsType<(typeof inboxRows)[number]> = [
    {
      title: '回执文件',
      render: (_, row) => (
        <Space direction="vertical" size={2}>
          <strong>
            <InboxOutlined /> {INBOX_FILE_LABELS[row.receiptKey] ?? `${row.receipt.id} v${row.receipt.version}`}
            {row.totalCopies > 1 && (
              <Tag color="purple" style={{ marginLeft: 8 }}>
                重发副本 {row.copyIndex + 1}/{row.totalCopies}
              </Tag>
            )}
          </strong>
          <span className="muted-text">
            批次 {row.receipt.batchId} · 中心签发 {formatTime(row.receipt.issuedAt)} · {row.receipt.lines.length} 条结论
          </span>
        </Space>
      ),
    },
    {
      title: '登记状态',
      width: 150,
      render: (_, row) =>
        row.handled ? (
          <Tag color={ingestionColor[row.handled.status]}>{statusLabel(row.handled.status)}</Tag>
        ) : (
          <Badge status="processing" text="待对账" />
        ),
    },
    {
      title: '操作',
      width: 200,
      render: (_, row) => (
        <Space>
          <Button
            type="primary"
            size="small"
            disabled={Boolean(row.handled && row.handled.status !== 'failed')}
            onClick={() => runIngest(row.receiptKey, row.copyIndex)}
          >
            对并入账
          </Button>
          {row.handled?.status === 'failed' && (
            <Button size="small" danger onClick={() => runIngest(row.receiptKey, row.copyIndex)}>
              重发件试试
            </Button>
          )}
        </Space>
      ),
    },
  ]

  /* ------------------------------ 挂起清单表格 ----------------------------- */
  const mismatchColumns: ColumnsType<ReconcileMismatch> = [
    {
      title: '类型',
      dataIndex: 'kind',
      width: 150,
      render: (kind: ReconcileMismatch['kind']) => (
        <Tag color={mismatchMeta[kind].color}>{mismatchMeta[kind].label}</Tag>
      ),
    },
    { title: '回执', dataIndex: 'receiptId', width: 150 },
    {
      title: '中心记录号',
      width: 200,
      render: (_, row) => <Typography.Text code>{row.line.centerRecordNo}</Typography.Text>,
    },
    { title: '说明', dataIndex: 'detail' },
    {
      title: '结论',
      width: 90,
      render: (_, row) => (
        <Tag color={row.line.decision === 'approved' ? 'green' : 'volcano'}>
          {row.line.decision === 'approved' ? '判通过' : '判退'}
        </Tag>
      ),
    },
    {
      title: '状态 / 处理',
      width: 260,
      render: (_, row) =>
        row.resolved ? (
          <Tooltip title={row.resolvedNote}>
            <Tag color="default">已人工核对（记录未改）</Tag>
          </Tooltip>
        ) : (
          <Button
            size="small"
            onClick={() =>
              Modal.confirm({
                title: '人工核对该挂起项',
                content: '仅登记核对结论，不会修改任何移交或本地记录。',
                okText: '确认维持本地记录',
                onOk: () => {
                  resolveMismatch(row.id, '')
                  void message.success('已标记核对完成，本地记录保持不变')
                },
              })
            }
          >
            核对并挂起
          </Button>
        ),
    },
  ]

  /* ------------------------------- 台账表格 ------------------------------- */
  const ledgerColumns: ColumnsType<LedgerEntry> = [
    {
      title: '中心记录号',
      dataIndex: 'centerRecordNo',
      width: 200,
      fixed: 'left',
      render: (value: string) => <Typography.Text code>{value}</Typography.Text>,
    },
    { title: '本地记录', dataIndex: 'recordId', width: 130 },
    { title: '批次', dataIndex: 'batchId', width: 150 },
    {
      title: '状态',
      dataIndex: 'status',
      width: 150,
      render: (status: LedgerEntry['status']) => (
        <Tag color={ledgerStatusMeta[status].color}>{ledgerStatusMeta[status].label}</Tag>
      ),
    },
    {
      title: '当前结论',
      width: 420,
      render: (_, row) => {
        if (!row.current) return <span className="muted-text">中心尚无结论</span>
        const write = row.current
        return (
          <Space direction="vertical" size={2}>
            <Space size={6}>
              <Tag color={write.kind === 'approved' ? 'green' : 'volcano'}>
                {write.kind === 'approved' ? '判通过（已冻结）' : '判退（按原因重开）'}
              </Tag>
              <span className="muted-text">
                {write.receiptId} v{write.receiptVersion} · {formatTime(write.at)}
              </span>
            </Space>
            {write.kind === 'rejected' && <span>退回来因：{write.reason}</span>}
            {write.kind === 'approved' && write.centerRingCode && (
              <span className="muted-text">中心环号呈现：{write.centerRingCode}</span>
            )}
          </Space>
        )
      },
    },
    {
      title: '差异登记',
      width: 260,
      render: (_, row) =>
        row.differences.length ? (
          <Space wrap>
            {row.differences.map((diff, index) => (
              <Tooltip
                key={`${diff.field}-${index}`}
                title={
                  <Space direction="vertical" size={2}>
                    <span>{diff.detail}</span>
                    <span>本地定稿：{diff.localValue || '（空）'}</span>
                    <span>另一侧值：{diff.centerValue}</span>
                  </Space>
                }
              >
                <Tag color={diffSourceMeta[diff.source].color}>
                  {diffSourceMeta[diff.source].label}
                </Tag>
              </Tooltip>
            ))}
          </Space>
        ) : (
          <span className="muted-text">—</span>
        ),
    },
    {
      title: '历史结论',
      width: 110,
      render: (_, row) =>
        row.history.length > 1 ? (
          <Tooltip
            title={row.history
              .map(
                (write, index) =>
                  `${index + 1}. ${write.kind === 'approved' ? '通过' : '判退'} · ${write.receiptId || '历史缺编号'} v${write.receiptVersion}`,
              )
              .join('\n')}
          >
            <Tag>{row.history.length} 版结论</Tag>
          </Tooltip>
        ) : (
          <span className="muted-text">—</span>
        ),
    },
    {
      title: '冻结后更正演练',
      width: 150,
      render: (_, row) =>
        row.current?.kind === 'approved' ? (
          <Button
            size="small"
            onClick={() =>
              simulateCorrection(row.recordId, { remarks: `后到补报 ${new Date().toISOString().slice(0, 10)}` }, '演练：来源班组后到补报')
                ? void message.success('已登记差异，冻结定稿未改动')
                : void message.warning('该记录无法登记更正')
            }
          >
            模拟后到更正
          </Button>
        ) : null,
    },
  ]

  /* ------------------------------ 处置流水表格 ----------------------------- */
  const ingestionColumns: ColumnsType<ReceiptIngestion> = [
    { title: '回执编号', dataIndex: 'receiptId', width: 160 },
    { title: '版本', dataIndex: 'version', width: 70 },
    { title: '批次', dataIndex: 'batchId', width: 150 },
    { title: '到件时间', dataIndex: 'receivedAt', width: 180, render: (v: string) => formatTime(v) },
    {
      title: '登记状态',
      dataIndex: 'status',
      width: 140,
      render: (status: ReceiptIngestion['status']) => (
        <Tag color={ingestionColor[status]}>{statusLabel(status)}</Tag>
      ),
    },
    {
      title: '生效 / 旧版拦截 / 重复 / 挂起',
      width: 240,
      render: (_, row) => (
        <Space size={4} split={<span className="muted-text">·</span>}>
          <span>{row.applied}</span>
          <span>{row.stale}</span>
          <span>{row.duplicate}</span>
          <span>{row.unmatched}</span>
        </Space>
      ),
    },
    { title: '说明', dataIndex: 'detail' },
    {
      title: '恢复',
      width: 110,
      render: (_, row) =>
        row.status === 'failed' ? (
          <Popconfirm
            title="从已对上记录的写入日志恢复？"
            description="台账将按日志重放，同一份回执仍只算一次。"
            onConfirm={() => {
              if (!row.recoveryJournalId) return
              const result = recover(row.recoveryJournalId)
              if (result.ok) void message.success('恢复完成，结论已按日志重放')
              else void message.error(result.resultText)
            }}
          >
            <Button size="small" type="primary" danger>
              从日志恢复
            </Button>
          </Popconfirm>
        ) : null,
    },
  ]

  const pendingColumns: ColumnsType<(typeof pending)[number]> = [
    { title: '记录编号', dataIndex: 'id', width: 130 },
    { title: '原始环号', dataIndex: 'rawRingCode', width: 150 },
    { title: '归一化环号', dataIndex: 'normalizedRingCode', width: 160 },
    { title: '鸟种', dataIndex: 'speciesCanonical', width: 120 },
    { title: '观察时间', dataIndex: 'observedAt', width: 160 },
    { title: '地点', dataIndex: 'location', width: 130 },
    {
      title: '重算依据',
      width: 420,
      render: (_, record) => {
        const latest = [...reconcile.ledger]
          .reverse()
          .find((entry) => entry.recordId === record.id)
        const blocking = issueCountByRecord.get(record.id)
        if (blocking?.length) {
          return <Tag color="orange">未决问题 {blocking.length} 条，暂不可移交</Tag>
        }
        if (!latest) return <Tag color="blue">首次移交候选</Tag>
        if (latest.status === 'rejected') {
          return (
            <Space direction="vertical" size={0}>
              <Tag color="volcano">判退后重开，处置完成随下一批带回</Tag>
              <span className="muted-text">
                {latest.current?.kind === 'rejected' ? latest.current.reason : ''}
              </span>
            </Space>
          )
        }
        return <Tag color="processing">原挂起项已人工核对销项，带回下一批重报（{latest.centerRecordNo}）</Tag>
      },
    },
  ]

  const batchItems = reconcile.batches.map((batch: TransferBatch) => ({
    key: batch.id,
    label: (
      <Space>
        <strong>{batch.label}</strong>
        <Tag>{batch.id}</Tag>
        <span className="muted-text">{batch.manifest.length} 条 · {formatTime(batch.packedAt)}</span>
        {batch.initialReceiptId && <Tag color="purple">初始回执 {batch.initialReceiptId}</Tag>}
      </Space>
    ),
    children: (
      <Descriptions size="small" column={3} bordered
        items={[
          { key: 'center', label: '接收中心', children: batch.center },
          { key: 'count', label: '定稿条数', children: batch.manifest.length },
          {
            key: 'initial',
            label: '初始回执',
            children: batch.initialReceiptId ?? '无（新批次）',
          },
          {
            key: 'status',
            label: '回执覆盖',
            children: (
              <Space wrap>
                {(() => {
                  const inBatch = reconcile.ledger.filter((entry) => entry.batchId === batch.id)
                  const approved = inBatch.filter((entry) => entry.status === 'approved').length
                  const rejected = inBatch.filter((entry) => entry.status === 'rejected').length
                  const waiting = inBatch.filter((entry) => entry.status === 'transferred').length
                  return (
                    <>
                      <Tag color="green">通过 {approved}</Tag>
                      <Tag color="volcano">判退 {rejected}</Tag>
                      <Tag>待回执 {waiting}</Tag>
                    </>
                  )
                })()}
              </Space>
            ),
          },
          {
            key: 'sample',
            label: '首末中心记录号',
            children: `${batch.manifest[0]?.centerRecordNo ?? '—'} ～ ${batch.manifest.at(-1)?.centerRecordNo ?? '—'}`,
          },
        ]}
      />
    ),
  }))

  return (
    <div className="page-stack">
      <div className="page-heading">
        <div>
          <Typography.Title level={2}>移交批次 × 审核回执 × 处置记录对账</Typography.Title>
          <Typography.Paragraph type="secondary">
            回执按中心记录号、本地环号与观察时间三方对上；对不上的只列出不改记录。中心环号归一化仅作呈现比对，
            判通过即冻结，判退按原因重开处置；同一份回执只算一次，晚到旧版本不倒退状态。
          </Typography.Paragraph>
        </div>
        <Space direction="vertical" align="end">
          <Space>
            <span className="muted-text">演练：下一份回执写入失败</span>
            <Switch
              checked={reconcile.failureArmed}
              onChange={(checked) => {
                armFailure(checked)
                void message.info(checked ? '已开启写入失败演练，下一份入账只落日志不提交' : '已关闭失败演练')
              }}
            />
          </Space>
          <Tag icon={<DatabaseTwoTone />} color="purple">
            对账日志 {reconcile.journals.length} 份
          </Tag>
        </Space>
      </div>

      <div className="reconcile-stats">
        <Card variant="borderless" className="stat-card stat-card--teal">
          <div className="stat-card__icon"><SendOutlined /></div>
          <div>
            <span className="stat-card__label">已移交定稿</span>
            <strong className="stat-card__value">{reconcile.ledger.length}</strong>
            <small>{reconcile.batches.length} 个批次</small>
          </div>
        </Card>
        <Card variant="borderless" className="stat-card stat-card--teal">
          <div className="stat-card__icon"><CheckCircleTwoTone twoToneColor="#16a34a" /></div>
          <div>
            <span className="stat-card__label">中心通过·冻结</span>
            <strong className="stat-card__value">{summary.approved}</strong>
            <small>本地后到更正只列差异</small>
          </div>
        </Card>
        <Card variant="borderless" className="stat-card stat-card--red">
          <div className="stat-card__icon"><CloseCircleTwoTone twoToneColor="#dc2626" /></div>
          <div>
            <span className="stat-card__label">判退重开</span>
            <strong className="stat-card__value">{summary.rejected + issues.filter((i) => i.status === 'reopened').length}</strong>
            <small>台账判退 {summary.rejected} · 待处置重开 {issues.filter((i) => i.status === 'reopened').length}</small>
          </div>
        </Card>
        <Card variant="borderless" className="stat-card stat-card--amber">
          <div className="stat-card__icon"><WarningTwoTone twoToneColor="#d97706" /></div>
          <div>
            <span className="stat-card__label">对不上挂起</span>
            <strong className="stat-card__value">{unresolvedMismatches.length}</strong>
            <small>只列出，不改任何记录</small>
          </div>
        </Card>
        <Card variant="borderless" className="stat-card stat-card--blue">
          <div className="stat-card__icon"><SyncOutlined /></div>
          <div>
            <span className="stat-card__label">待移交（按新结果重算）</span>
            <strong className="stat-card__value">{pending.length.toLocaleString()}</strong>
            <small>冻结记录已排除</small>
          </div>
        </Card>
      </div>

      {failedJournals.length > 0 && (
        <Alert
          type="error"
          showIcon
          message="存在写入失败的回执"
          description={`${failedJournals.length} 份回执已先落日志但未提交台账，记录未被修改。请在“处置流水”中对失败登记执行“从日志恢复”，或直接在收件箱对重发件进行去重拦截验证。`}
        />
      )}

      <Card className="tool-card" variant="borderless">
        <Collapse items={batchItems} defaultActiveKey={[reconcile.batches.at(-1)?.id ?? '']} />
      </Card>

      <Card className="table-card" variant="borderless">
        <Tabs
          items={[
            {
              key: 'inbox',
              label: <Badge count={inboxRows.filter((r) => !r.handled).length} size="small" offset={[10, 0]}>回执收件箱（{inboxRows.length}）</Badge>,
              children: (
                <Space direction="vertical" style={{ width: '100%' }}>
                  <Alert
                    type="info"
                    showIcon
                    message="分批回传、可能重发：同编号同版本重发只算一次；签发更早的晚到旧件整份拦截，状态不倒退。"
                  />
                  <Table rowKey="key" size="small" bordered columns={inboxColumns} dataSource={inboxRows} pagination={false} />
                </Space>
              ),
            },
            {
              key: 'pending',
              label: `待移交清单（${pending.length.toLocaleString()}）`,
              children: (
                <Space direction="vertical" style={{ width: '100%' }}>
                  <Space style={{ justifyContent: 'space-between', width: '100%' }}>
                    <Alert
                      style={{ flex: 1 }}
                      type="info"
                      showIcon
                      message="该清单在每次回执更新后按新结果重算：通过冻结的剔除，判退重开处理完后带回，已移交未见结论的随下一批重报。"
                    />
                    <Button
                      onClick={() => exportPendingTransferCsv(records, reconcile, issues)}
                    >
                      导出待移交 CSV
                    </Button>
                  </Space>
                  <Table
                    rowKey="id"
                    size="small"
                    bordered
                    virtual
                    columns={pendingColumns}
                    dataSource={pending.slice(0, 500)}
                    pagination={{ pageSize: 20, showSizeChanger: false }}
                    scroll={{ x: 1250, y: 420 }}
                  />
                  <span className="muted-text">
                    预览前 500 条；导出 CSV 包含全部 {pending.length.toLocaleString()} 条重算结果。
                  </span>
                  <Card size="small" variant="borderless" style={{ background: '#f7faf9' }}>
                    <Space wrap>
                      <span>组下一批移交包（演示单批上限 60 条）：</span>
                      <Input
                        style={{ width: 280 }}
                        value={batchLabel}
                        onChange={(e) => setBatchLabel(e.target.value)}
                        placeholder="批次备注，可留空"
                      />
                      <Popconfirm
                        title="将当前重算后的待移交记录定稿进包？"
                        description="进包即视为定稿，回执对账以包内中心记录号、环号、时间为准。"
                        onConfirm={() => {
                          const batch = packBatch(batchLabel)
                          if (!batch) {
                            void message.warning('当前没有可定稿进包的记录')
                          } else {
                            setBatchLabel('')
                            void message.success(`批次 ${batch.id} 已生成，台账新增 ${batch.manifest.length} 条定稿`)
                          }
                        }}
                      >
                        <Button type="primary" icon={<SendOutlined />}>生成下一移交批次</Button>
                      </Popconfirm>
                    </Space>
                  </Card>
                </Space>
              ),
            },
            {
              key: 'mismatch',
              label: <Badge count={unresolvedMismatches.length} size="small" offset={[12, 0]}>对不上清单（{reconcile.mismatches.length}）</Badge>,
              children: reconcile.mismatches.length ? (
                <Table
                  rowKey="id"
                  size="small"
                  bordered
                  columns={mismatchColumns}
                  dataSource={reconcile.mismatches}
                  pagination={false}
                  scroll={{ x: 1200 }}
                />
              ) : (
                <Empty description="先对收件箱执行“对并入账”，对不上的条目会列在这里且不改动记录。" />
              ),
            },
            {
              key: 'ledger',
              label: `对账台账（${reconcile.ledger.length}）`,
              children: (
                <Table
                  rowKey="centerRecordNo"
                  size="small"
                  bordered
                  virtual
                  columns={ledgerColumns}
                  dataSource={reconcile.ledger}
                  pagination={false}
                  scroll={{ x: 1750, y: 520 }}
                />
              ),
            },
            {
              key: 'ingestions',
              label: `处置流水（${reconcile.ingestions.length}）`,
              children: (
                <Table
                  rowKey={(row) => `${row.receiptId}-${row.version}-${row.receivedAt}`}
                  size="small"
                  bordered
                  columns={ingestionColumns}
                  dataSource={[...reconcile.ingestions].reverse()}
                  pagination={false}
                  scroll={{ x: 1200 }}
                />
              ),
            },
            {
              key: 'audit',
              label: `操作审计（${operations.length}）`,
              children: operations.length ? (
                <Timeline
                  items={operations.map((op) => ({
                    color: op.locked ? 'purple' : op.rolledBack ? 'gray' : 'green',
                    children: (
                      <Space direction="vertical" size={0}>
                        <Space>
                          <strong>{op.title}</strong>
                          {op.locked && <Tag color="purple">定稿锁定·不可回滚</Tag>}
                          {op.rolledBack && <Tag>已回滚</Tag>}
                          <span className="muted-text">{op.count} 条</span>
                        </Space>
                        <span>{op.detail}</span>
                        <span className="muted-text">{formatTime(op.timestamp)}</span>
                      </Space>
                    ),
                  }))}
                />
              ) : (
                <Empty description="对账动作会追加为锁定的审计记录，中心结论不允许回滚。" />
              ),
            },
          ]}
        />
      </Card>

      <Card className="audit-note" variant="borderless">
        <Statistic
          title="对账口径速览"
          value={`${summary.approved} 冻结 / ${summary.rejected} 判退重开 / ${unresolvedMismatches.length} 挂起 / ${pending.length.toLocaleString()} 待移交`}
        />
      </Card>
    </div>
  )
}
