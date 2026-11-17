import { MODULE_BY_KEY } from '@/data/modules'
import { allRows, listRows, resetRows, saveRows } from '@/data/local-store'
import type { ActionResult, EntryRow, ModuleMeta, OverviewResult, PageResult } from '@/data/types'
import {
  dataSourceFromRows,
  ExportConflictError,
  ExportFailedError,
  ExportInterruptedError,
  getPublishedFile,
  inspectExport,
  localStorageExportStorage,
  memoryExportStorage,
  recoverStaleExports,
  removeExport,
  resumeExport,
  runBatch,
  runToCompletion,
  sealAndRevise,
  startExport,
  type ExportArchive,
  type ExportDataSource,
  type ExportInspection,
  type ExportStorage,
  type PublishedFile,
} from '@/api/export-detail'

// 会写进数据的「往回走」动作：命中就把这条记录标成异常态，看板上能一眼看出来。
const NEGATIVE_ACTIONS = ['撤销', '作废', '拒绝', '驳回', '停用', '忽略', '下线', '回滚']

// ---------------------------------------------------------------------------
// 导出数据明细文件存储（与业务条目同处本地存储，重开浏览器仍可检查、续做）
// ---------------------------------------------------------------------------

let exportStorage: ExportStorage | null = null

function storage(): ExportStorage {
  if (!exportStorage) {
    exportStorage =
      typeof window !== 'undefined' && window.localStorage
        ? localStorageExportStorage()
        : memoryExportStorage()
  }
  return exportStorage
}

/**
 * 同一浏览器会话内的写入者标识：同页所有批次/续做/修订调用共用一把锁；
 * 不同会话（并发执行）持有不同标识，会被引擎拒绝，保证只认可一份明细文件。
 */
const SESSION_OWNER = `session-${
  typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(16).slice(2)}`
}`

/** 应用启动 / 页面重开时调用：把过期锁的执行中任务恢复为可续做的中断态 */
export function recoverExportsOnOpen(): ExportInspection[] {
  return recoverStaleExports(storage()).map((manifest) => inspectExport(storage(), manifest.key)!)
}

export function moduleExportSource(key: string): ExportDataSource {
  const meta = moduleMeta(key)
  const rows = listRows(key)
  const header = ['编号', ...meta.fields, '当前状态']
  const task: ExportArchive['task'] = {
    模块: meta.name,
    业务对象: meta.entity,
    记录总数: rows.length,
  }
  return dataSourceFromRows(`${meta.name}-清单.csv`, header, rows, meta.fields, task)
}

/** 导出入口与报告明细一致：同一份导出数据明细文件，不在内存里另拼一份内容 */
export function getModuleExportFile(key: string): PublishedFile {
  return getPublishedFile(storage(), key)
}

export function inspectModuleExport(key: string): ExportInspection | null {
  return inspectExport(storage(), key)
}

export function listModuleExportKeys(): string[] {
  return storage().listManifestKeys()
}

export function resetModuleExport(key: string): void {
  removeExport(storage(), key)
}

export function ensureModuleExport(
  key: string,
  options: { batchSize?: number } = {},
): { manifest: ExportInspection; interrupted: boolean } {
  const store = storage()
  const source = moduleExportSource(key)
  let manifest = inspectExport(store, key)
  if (manifest && (manifest.status === 'interrupted' || manifest.status === 'failed')) {
    return { manifest, interrupted: true }
  }
  if (manifest && manifest.status !== 'published') {
    return { manifest, interrupted: false }
  }
  const created = startExport(store, key, source, { batchSize: options.batchSize ?? 1000, owner: SESSION_OWNER })
  return { manifest: inspectExport(store, created.key)!, interrupted: false }
}

export async function completeModuleExport(key: string): Promise<ExportInspection> {
  const store = storage()
  const source = moduleExportSource(key)
  await runToCompletion(store, key, source, { yieldEveryBatch: true, owner: SESSION_OWNER })
  return inspectExport(store, key)!
}

export function resumeModuleExport(key: string): ExportInspection {
  const manifest = resumeExport(storage(), key, moduleExportSource(key), { owner: SESSION_OWNER })
  return inspectExport(storage(), manifest.key)!
}

export function reviseModuleExport(key: string): ExportInspection {
  const manifest = sealAndRevise(storage(), key, moduleExportSource(key), { owner: SESSION_OWNER })
  return inspectExport(storage(), manifest.key)!
}

// ---------------------------------------------------------------------------
// 演示用大结果集数据源：12000 行，含跨行文本字段（验证半行续写安全性）
// ---------------------------------------------------------------------------

export type DemoExportOptions = {
  key?: string
  totalRows?: number
  batchSize?: number
  interruptAt?: number
}

const DEMO_EXPORT_KEY = 'export-demo-12000'
const DEMO_HEADER = ['行号', '批次标签', '跨行备注', '校验值', '当前状态']

function demoSource(totalRows: number): ExportDataSource {
  return {
    filename: '大数据量导出明细-12000行.csv',
    header: DEMO_HEADER,
    totalRows,
    getRows(offset: number, limit: number) {
      const rows: unknown[][] = []
      for (let i = offset; i < offset + limit && i < totalRows; i += 1) {
        // 每 17 行放一条带换行/引号/逗号的跨行文本，模拟真实 CSV 记录
        const multiline = i % 17 === 0
        const note = multiline
          ? `第${i + 1}行备注\n跨行第二段，含"引号"与,逗号`
          : `普通备注 ${i + 1}`
        rows.push([i + 1, `BATCH-${Math.floor(i / 1000) + 1}`, note, (i * 31) % 9973, '已导出'])
      }
      return rows
    },
    archived: {
      task: {
        任务编号: 'EXPO-DEMO-12000',
        查询SQL: 'SELECT * FROM big_result_set',
        导出格式: 'CSV',
        分隔符: ',',
        编码格式: 'UTF-8 BOM',
        压缩方式: '不压缩',
        目标路径: '下载区/大数据量导出明细-12000行.csv',
      },
      fields: [...DEMO_HEADER],
    },
  }
}

export function demoExportKey(custom?: string): string {
  return custom ?? DEMO_EXPORT_KEY
}

export function ensureDemoExport(options: DemoExportOptions = {}): ExportInspection {
  const store = storage()
  const key = demoExportKey(options.key)
  const totalRows = options.totalRows ?? 12000
  const existing = inspectExport(store, key)
  if (existing) return existing
  const manifest = startExport(store, key, demoSource(totalRows), {
    batchSize: options.batchSize ?? 1000,
    owner: SESSION_OWNER,
  })
  return inspectExport(store, manifest.key)!
}

/** 演示：跑一个批次；在 interruptAt 断点注入「写入中途截断」故障 */
export function runDemoBatch(options: DemoExportOptions = {}): {
  inspection: ExportInspection
  faultTriggered: boolean
} {
  const store = storage()
  const key = demoExportKey(options.key)
  const totalRows = options.totalRows ?? 12000
  if (!inspectExport(store, key)) throw new Error('演示导出任务尚未创建')
  const fault =
    options.interruptAt !== undefined
      ? { failAtRow: options.interruptAt, partialWrite: true, once: true }
      : undefined
  let faultTriggered = false
  try {
    runBatch(store, key, demoSource(totalRows), { fault, owner: SESSION_OWNER })
  } catch (error) {
    if (error instanceof ExportInterruptedError) {
      faultTriggered = true
    } else {
      throw error
    }
  }
  return { inspection: inspectExport(store, key)!, faultTriggered }
}

export function resumeDemoExport(options: DemoExportOptions = {}): ExportInspection {
  const store = storage()
  const key = demoExportKey(options.key)
  const totalRows = options.totalRows ?? 12000
  const manifest = resumeExport(store, key, demoSource(totalRows), { owner: SESSION_OWNER })
  return inspectExport(store, manifest.key)!
}

export function reviseDemoExport(options: DemoExportOptions = {}): ExportInspection {
  const store = storage()
  const key = demoExportKey(options.key)
  const totalRows = options.totalRows ?? 12000
  const manifest = sealAndRevise(store, key, demoSource(totalRows), { owner: SESSION_OWNER })
  return inspectExport(store, manifest.key)!
}

export function resetDemoExport(options: DemoExportOptions = {}): void {
  removeExport(storage(), demoExportKey(options.key))
}

export function getDemoExportFile(options: DemoExportOptions = {}): PublishedFile {
  return getPublishedFile(storage(), demoExportKey(options.key))
}

export function inspectDemoExport(options: DemoExportOptions = {}): ExportInspection | null {
  return inspectExport(storage(), demoExportKey(options.key))
}

// ---------------------------------------------------------------------------
// 报告附件：报告生成读取「导出数据明细文件」，只保存附件摘要
// ---------------------------------------------------------------------------

const ATTACHMENT_STORAGE_KEY = 'data-explore-studio:report-attachments'

export type ReportAttachment = {
  id: number
  reportId: number
  reportName: string
  sourceExportKey: string
  filename: string
  version: number
  digest: string
  lineCount: number
  dataRows: number
  byteLength: number
  createdAt: string
}

// 无浏览器 localStorage（如测试环境）时退化为内存存储，保持读写一致
const attachmentMemory: ReportAttachment[] = []

function attachmentBackend(): { getItem: () => string | null; setItem: (raw: string) => void } {
  if (typeof window !== 'undefined' && window.localStorage) {
    return {
      getItem: () => window.localStorage.getItem(ATTACHMENT_STORAGE_KEY),
      setItem: (raw) => window.localStorage.setItem(ATTACHMENT_STORAGE_KEY, raw),
    }
  }
  return {
    getItem: () => (attachmentMemory.length ? JSON.stringify(attachmentMemory) : null),
    setItem: (raw) => {
      attachmentMemory.length = 0
      attachmentMemory.push(...(JSON.parse(raw) as ReportAttachment[]))
    },
  }
}

function readAttachments(): ReportAttachment[] {
  const raw = attachmentBackend().getItem()
  if (!raw) return []
  try {
    return JSON.parse(raw) as ReportAttachment[]
  } catch {
    return []
  }
}

function writeAttachments(items: ReportAttachment[]): void {
  attachmentBackend().setItem(JSON.stringify(items))
}

export function listReportAttachments(reportId?: number): ReportAttachment[] {
  const items = readAttachments()
  return reportId === undefined ? items : items.filter((item) => item.reportId === reportId)
}

/** 报告生成：读取导出数据明细文件（下载入口同一取数口），通过校验后只保存附件摘要 */
export function generateReportAttachment(
  reportId: number,
  reportName: string,
  sourceExportKey: string,
): ActionResult & { attachment?: ReportAttachment } {
  const file = getPublishedFile(storage(), sourceExportKey)
  if (!file.ok || !file.content) {
    return {
      ok: false,
      message: file.reason ?? '没有可用的导出数据明细文件，无法生成报告附件',
    }
  }
  const items = readAttachments()
  const attachment: ReportAttachment = {
    id: items.length ? Math.max(...items.map((item) => item.id)) + 1 : 1,
    reportId,
    reportName,
    sourceExportKey,
    filename: file.filename!,
    version: file.version!,
    digest: file.digest!,
    lineCount: file.lineCount!,
    dataRows: file.dataRows!,
    byteLength: file.content.length,
    createdAt: new Date().toISOString(),
  }
  items.push(attachment)
  writeAttachments(items)
  return { ok: true, message: `报告附件已生成并保存摘要：${attachment.filename}（${attachment.dataRows} 行，摘要 ${attachment.digest}）`, attachment }
}

// ---------------------------------------------------------------------------
// 页面通用：模块列表 / 状态流转 / 下载
// ---------------------------------------------------------------------------

export function moduleMeta(key: string): ModuleMeta {
  const meta = MODULE_BY_KEY.get(key)
  if (!meta) {
    throw new Error(`没有登记名为 ${key} 的业务模块`)
  }
  return meta
}

export function filterRows(rows: EntryRow[], filters: Record<string, string>): EntryRow[] {
  const pairs = Object.entries(filters).filter(([, value]) => value.trim() !== '')
  if (pairs.length === 0) {
    return rows
  }
  return rows.filter((row) =>
    pairs.every(([field, value]) => String(row[field] ?? '').includes(value.trim())),
  )
}

export function listEntries(key: string, filters: Record<string, string> = {}): PageResult {
  const matched = filterRows(listRows(key), filters)
  return { items: matched, total: matched.length, page: 1, size: matched.length }
}

export function runAction(key: string, id: number, action: string): ActionResult {
  const meta = moduleMeta(key)
  const target = meta.actionTargets[action]
  if (!target) {
    return { ok: false, message: `${meta.entity}没有登记「${action}」这个动作` }
  }
  const rows = listRows(key)
  const index = rows.findIndex((row) => Number(row.id) === id)
  if (index < 0) {
    return { ok: false, message: `没有找到编号为 ${id} 的${meta.entity}` }
  }
  const current = String(rows[index].status)
  if (current === target) {
    return { ok: false, message: `${meta.entity}已经是「${target}」，不用重复操作` }
  }
  const lastStatus = meta.statuses[meta.statuses.length - 1]
  const updated: EntryRow = {
    ...rows[index],
    status: target,
    pending: target !== lastStatus,
    abnormal: NEGATIVE_ACTIONS.some((verb) => action.startsWith(verb)),
  }
  const next = [...rows]
  next[index] = updated
  saveRows(key, next)
  return { ok: true, message: `${meta.entity}已${action}，当前状态「${target}」` }
}

export function resetModule(key: string): PageResult {
  resetRows(key)
  resetModuleExport(key)
  return listEntries(key)
}

/**
 * 下载入口（所有模块页面统一调用）：
 * 先确保明细文件走分批引擎生成；只有通过行数与摘要校验的完整文件才触发浏览器下载，
 * 中断 / 失败 / 执行中一律返回说明，下载区不会出现半成品。
 */
export async function downloadEntries(key: string): Promise<ActionResult> {
  try {
    const { manifest, interrupted } = ensureModuleExport(key)
    if (interrupted) {
      return {
        ok: false,
        message: `导出在第 ${manifest.nextRow}/${manifest.totalRows} 行中断：${manifest.failureReason ?? '写入中断'}，完成前下载区无文件`,
      }
    }
    if (manifest.status !== 'published') {
      await completeModuleExport(key)
    }
    const file = getModuleExportFile(key)
    if (!file.ok || !file.content) {
      return { ok: false, message: file.reason ?? '完整文件校验未通过，下载入口拒绝提供文件' }
    }
    triggerBrowserDownload(file.filename!, file.content)
    return {
      ok: true,
      message: `已下载完整明细文件：${file.filename}（${file.dataRows} 行，摘要 ${file.digest}）`,
    }
  } catch (error) {
    if (error instanceof ExportConflictError || error instanceof ExportFailedError) {
      return { ok: false, message: error.message }
    }
    throw error
  }
}

function triggerBrowserDownload(filename: string, content: string): void {
  if (typeof document === 'undefined') return
  const blob = new Blob([content], { type: 'text/csv;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  document.body.appendChild(anchor)
  anchor.click()
  document.body.removeChild(anchor)
  URL.revokeObjectURL(url)
}

export function loadOverview(): OverviewResult {
  const rows = allRows()
  const modules = [...MODULE_BY_KEY.values()].map((meta) => {
    const entries = rows[meta.key] ?? []
    return {
      name: meta.name,
      created: entries.length,
      pending: entries.filter((row) => row.pending).length,
      abnormal: entries.filter((row) => row.abnormal).length,
    }
  })
  const cards = [
    { label: '业务模块', value: modules.length },
    { label: '登记总量', value: modules.reduce((sum, item) => sum + item.created, 0) },
    { label: '待处理', value: modules.reduce((sum, item) => sum + item.pending, 0) },
    { label: '异常量', value: modules.reduce((sum, item) => sum + item.abnormal, 0) },
  ]
  return { cards, modules }
}
