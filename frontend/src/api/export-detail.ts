/**
 * 导出数据明细文件引擎：分批写入、断点续做、完整性校验与发布控制。
 *
 * 设计要点
 * - 明细文件按批写入，每批是一个独立分片。只有整批写完并落盘后才推进断点，
 *   中断时停在最近一个「安全断点」，重试只补未完成的行，跨行文本不会留下半行。
 * - 分片只在暂存区累积；未通过「行数 + 摘要」校验前不会出现在下载入口。
 * - 校验通过后才发布为唯一的完整明细文件，下载入口只读取已发布文件，且每次读取
 *   都会重新校验，再次打开依然可检查。
 * - 同一明细文件同时只认可一个写入者（owner 锁 + TTL），并发执行只会认可同一份文件。
 * - 中断后两条路径都保留版本轨迹：沿用原文件续写（resume，发布 v1），或封存失败
 *   分片后发布修订文件（revision，发布 v2）。任何路径都只向下载入口暴露完整文件，
 *   冲突处理保留来源（origin / revisedFromVersion）取舍记录。
 */
import type { EntryRow } from '@/data/types'

// ---------------------------------------------------------------------------
// 类型定义
// ---------------------------------------------------------------------------

export type ExportStatus = 'running' | 'interrupted' | 'failed' | 'published'

export type VersionStatus = 'sealed' | 'published' | 'superseded'

export type ExportFileVersion = {
  version: number
  status: VersionStatus
  /** 完整文件（published）或封存分片（sealed）的存储路径 */
  path: string
  /** 组装该版本时使用的分片轨迹 */
  chunks: string[]
  origin: 'initial' | 'resume' | 'revision'
  revisedFromVersion?: number
  /** 含表头的逻辑行数 */
  lineCount: number
  /** 数据行数（不含表头） */
  dataRows: number
  /** 完整文件摘要（含 BOM 与表头） */
  digest: string
  /** 数据行滚动摘要（不含 BOM 与表头） */
  rollingDigest: string
  byteLength: number
  sealedAt?: string
  publishedAt?: string
  note?: string
}

export type ExportArchive = {
  /** 归档的导出任务信息 */
  task: Record<string, string | number | boolean | undefined>
  /** 归档的字段列表 */
  fields: string[]
}

export type ExportManifest = {
  key: string
  filename: string
  header: string[]
  totalRows: number
  batchSize: number
  status: ExportStatus
  owner: string | null
  ownerSince: string | null
  ownerExpiresAt: string | null
  /** 安全断点：[0, nextRow) 已完整落盘，下一条待写行即 nextRow */
  nextRow: number
  /** 已成功批次数 */
  batchNo: number
  /** 表头（含 BOM）是否已随首个分片写入；修订版本复用封存件时保持为 true */
  headerWritten: boolean
  /** 已写数据行的滚动摘要（每行按 line + '\n' 续算） */
  rollingDigest: string | null
  /** 当前工作版本的暂存分片路径（按顺序拼接即文件内容） */
  chunks: string[]
  /** 每个分片的数据行数（表头不计） */
  chunkRows: number[]
  /** 当前工作版本号 */
  workingVersion: number
  versions: ExportFileVersion[]
  publishedVersion: number | null
  failureReason: string | null
  lastEvent: string
  /** 已注入过的故障断点（保证 once 故障只触发一次） */
  injectedFaults: number[]
  createdAt: string
  updatedAt: string
  archived: ExportArchive
  /** 修订路径：本明细文件修订自哪个 key 的哪个版本 */
  revisionOf?: { key: string; version: number }
}

/** 导出数据源：调用链按批次取行，不在内存里一次性拼接整份内容 */
export type ExportDataSource = {
  filename: string
  header: string[]
  totalRows: number
  getRows: (offset: number, limit: number) => unknown[][]
  archived: ExportArchive
}

export type IntegrityReport = {
  ok: boolean
  lineCount: number
  dataRows: number
  digest: string
  rollingDigest: string
  byteLength: number
  reasons: string[]
}

export type BatchFault = {
  /** 命中该断点（nextRow 达到该值）的下一批写入时注入故障 */
  failAtRow: number
  /** true = 先写入截断分片再抛错（模拟跨行文本写一半断电）；false = 直接抛错 */
  partialWrite: boolean
  /** 仅注入一次 */
  once: boolean
}

export type BatchResult = {
  manifest: ExportManifest
  attempted: boolean
  faultTriggered: boolean
}

// ---------------------------------------------------------------------------
// 错误类型
// ---------------------------------------------------------------------------

export class ExportConflictError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ExportConflictError'
  }
}

export class ExportInterruptedError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ExportInterruptedError'
  }
}

export class ExportFailedError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ExportFailedError'
  }
}

// ---------------------------------------------------------------------------
// 存储驱动
// ---------------------------------------------------------------------------

export interface ExportStorage {
  listManifestKeys(): string[]
  readManifest(key: string): ExportManifest | null
  writeManifest(key: string, manifest: ExportManifest): void
  removeManifest(key: string): void
  read(path: string): string | null
  write(path: string, content: string): void
  remove(path: string): void
  exists(path: string): boolean
}

const EXPORT_NS = 'data-explore-studio:export'

/** 浏览器 localStorage 驱动：所有状态随本地存储持久化，重开浏览器仍可检查、续做 */
export function localStorageExportStorage(): ExportStorage {
  function available(): boolean {
    return typeof window !== 'undefined' && !!window.localStorage
  }
  return {
    listManifestKeys() {
      if (!available()) return []
      const keys: string[] = []
      for (let i = 0; i < window.localStorage.length; i += 1) {
        const raw = window.localStorage.key(i) ?? ''
        if (raw.startsWith(`${EXPORT_NS}:manifest:`)) {
          keys.push(raw.slice(`${EXPORT_NS}:manifest:`.length))
        }
      }
      return keys
    },
    readManifest(key) {
      if (!available()) return null
      const raw = window.localStorage.getItem(`${EXPORT_NS}:manifest:${key}`)
      if (!raw) return null
      return JSON.parse(raw) as ExportManifest
    },
    writeManifest(key, manifest) {
      if (!available()) return
      window.localStorage.setItem(`${EXPORT_NS}:manifest:${key}`, JSON.stringify(manifest))
    },
    removeManifest(key) {
      if (!available()) return
      window.localStorage.removeItem(`${EXPORT_NS}:manifest:${key}`)
    },
    read(path) {
      if (!available()) return null
      return window.localStorage.getItem(`${EXPORT_NS}:blob:${path}`)
    },
    write(path, content) {
      if (!available()) return
      window.localStorage.setItem(`${EXPORT_NS}:blob:${path}`, content)
    },
    remove(path) {
      if (!available()) return
      window.localStorage.removeItem(`${EXPORT_NS}:blob:${path}`)
    },
    exists(path) {
      return available() && window.localStorage.getItem(`${EXPORT_NS}:blob:${path}`) !== null
    },
  }
}

/** 内存驱动：供单元测试与无 localStorage 环境使用 */
export function memoryExportStorage(seed?: Map<string, string>): ExportStorage {
  const blobs = seed ?? new Map<string, string>()
  const manifests = new Map<string, ExportManifest>()
  return {
    listManifestKeys: () => [...manifests.keys()],
    readManifest: (key) => manifests.get(key) ?? null,
    writeManifest: (key, manifest) => manifests.set(key, cloneManifest(manifest)),
    removeManifest: (key) => manifests.delete(key),
    read: (path) => blobs.get(path) ?? null,
    write: (path, content) => blobs.set(path, content),
    remove: (path) => blobs.delete(path),
    exists: (path) => blobs.has(path),
  }
}

function cloneManifest(manifest: ExportManifest): ExportManifest {
  return JSON.parse(JSON.stringify(manifest)) as ExportManifest
}

// ---------------------------------------------------------------------------
// CSV 与摘要工具
// ---------------------------------------------------------------------------

export const UTF8_BOM = '﻿'

export function csvEscape(value: unknown): string {
  const text = value === null || value === undefined ? '' : String(value)
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text
}

function toCsvLine(cells: unknown[]): string {
  return cells.map(csvEscape).join(',')
}

/** FNV-1a 32 位摘要，可从已有状态续算（滚动摘要） */
export function fnvDigest(text: string, seedHex?: string | null): string {
  let hash = seedHex === undefined || seedHex === null ? 0x811c9dc5 : parseInt(seedHex, 16)
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193)
  }
  return (hash >>> 0).toString(16).padStart(8, '0')
}

/**
 * 按 CSV 语法统计逻辑记录数（一条跨行引号文本只算一行），
 * 同时返回每条逻辑记录的原始文本（保留转义形态，用于滚动摘要复算）。
 */
export function parseCsvRecords(text: string): { count: number; records: string[] } {
  const records: string[] = []
  let inQuotes = false
  let start = 0
  let hasContent = false
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i]
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          i += 1
        } else {
          inQuotes = false
        }
      }
      continue
    }
    if (ch === '"') {
      inQuotes = true
      hasContent = true
      continue
    }
    if (ch === '\n' || ch === '\r') {
      const lineEnd = i
      if (ch === '\r' && text[i + 1] === '\n') i += 1
      if (hasContent) {
        records.push(text.slice(start, lineEnd))
        hasContent = false
      }
      start = i + 1
      continue
    }
    hasContent = true
  }
  if (hasContent) records.push(text.slice(start))
  return { count: records.length, records }
}

/** 完整性校验：逻辑行数（含表头）、数据行数、完整摘要、数据行滚动摘要 */
export function verifyExportContent(
  content: string,
  expected: { totalRows: number; rollingDigest: string | null },
): IntegrityReport {
  const reasons: string[] = []
  const { count, records } = parseCsvRecords(content)
  const dataRows = count - 1
  if (count < 1) reasons.push('文件缺少表头行')
  if (dataRows !== expected.totalRows) {
    reasons.push(`数据行数校验失败：实际 ${dataRows} 行，应为 ${expected.totalRows} 行`)
  }
  let rolling: string | null = null
  for (let i = 1; i < records.length; i += 1) {
    rolling = fnvDigest(`${records[i]}\n`, rolling)
  }
  if (expected.rollingDigest !== null && rolling !== expected.rollingDigest) {
    reasons.push('数据行滚动摘要校验失败：文件内容与写入断点摘要不一致')
  }
  const digest = fnvDigest(content)
  return {
    ok: reasons.length === 0,
    lineCount: count,
    dataRows,
    digest,
    rollingDigest: rolling ?? fnvDigest(''),
    byteLength: content.length,
    reasons,
  }
}

// ---------------------------------------------------------------------------
// 引擎
// ---------------------------------------------------------------------------

const LOCK_TTL_MS = 30_000

function nowIso(): string {
  return new Date().toISOString()
}

function chunkPath(key: string, version: number, batchNo: number): string {
  return `${key}/v${version}/chunk-${String(batchNo).padStart(4, '0')}`
}

function filePath(key: string, version: number): string {
  return `${key}/v${version}/export-detail.csv`
}

function sealedPath(key: string, version: number): string {
  return `${key}/v${version}/sealed-shards.csv`
}

function newOwner(): string {
  const rand = typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : `r-${Date.now()}-${Math.random().toString(16).slice(2)}`
  return `owner-${rand}`
}

function isLockActive(manifest: ExportManifest, at: number = Date.now()): boolean {
  if (!manifest.owner || !manifest.ownerExpiresAt) return false
  return new Date(manifest.ownerExpiresAt).getTime() > at
}

function acquireLock(manifest: ExportManifest, owner: string): void {
  if (isLockActive(manifest) && manifest.owner !== owner) {
    throw new ExportConflictError(
      `导出数据明细文件「${manifest.filename}」正由另一个写入者处理，并发执行只认可一份文件，请稍后重试或断点续做`,
    )
  }
  manifest.owner = owner
  manifest.ownerSince = nowIso()
  manifest.ownerExpiresAt = new Date(Date.now() + LOCK_TTL_MS).toISOString()
}

function releaseLock(manifest: ExportManifest): void {
  manifest.owner = null
  manifest.ownerSince = null
  manifest.ownerExpiresAt = null
}

function persist(storage: ExportStorage, manifest: ExportManifest, event: string): ExportManifest {
  manifest.lastEvent = event
  manifest.updatedAt = nowIso()
  storage.writeManifest(manifest.key, manifest)
  return manifest
}

/** 恢复遗留状态：页面关闭等原因留下的 running 锁过期后，标记为可续做的中断态 */
export function recoverStaleExports(storage: ExportStorage): ExportManifest[] {
  const recovered: ExportManifest[] = []
  for (const key of storage.listManifestKeys()) {
    const manifest = storage.readManifest(key)
    if (!manifest || manifest.status !== 'running') continue
    if (!isLockActive(manifest)) {
      manifest.status = 'interrupted'
      manifest.failureReason = '导出在批次写入间隙中断，已停在最近安全断点，可继续未完成行'
      releaseLock(manifest)
      persist(storage, manifest, '恢复：检测到过期写入锁，标记为中断待续做')
      recovered.push(manifest)
    }
  }
  return recovered
}

/** 新建一份导出数据明细文件（已发布 / 中断中的同 key 文件不会被覆盖） */
export function startExport(
  storage: ExportStorage,
  key: string,
  source: ExportDataSource,
  options: { batchSize?: number; owner?: string } = {},
): ExportManifest {
  const existing = storage.readManifest(key)
  if (existing) {
    // 并发/重复执行只认可同一份已发布文件
    if (existing.status === 'published') {
      return existing
    }
    if (existing.status === 'running' && isLockActive(existing)) {
      // 同一写入者重复发起：幂等返回同一份文件；不同写入者：拒绝并发
      if (existing.owner === (options.owner ?? null)) return existing
      throw new ExportConflictError(
        `导出数据明细文件「${existing.filename}」正在写入中，并发执行只认可一份文件`,
      )
    }
    throw new ExportFailedError(
      `已存在状态为「${existing.status}」的明细文件，请从断点继续（resume）或封存失败分片后发布修订文件（revision）`,
    )
  }

  const batchSize = Math.max(1, options.batchSize ?? 2000)
  const timestamp = nowIso()
  const manifest: ExportManifest = {
    key,
    filename: source.filename,
    header: source.header,
    totalRows: source.totalRows,
    batchSize,
    status: 'running',
    owner: null,
    ownerSince: null,
    ownerExpiresAt: null,
    nextRow: 0,
    batchNo: 0,
    headerWritten: false,
    rollingDigest: null,
    chunks: [],
    chunkRows: [],
    workingVersion: 1,
    versions: [],
    publishedVersion: null,
    failureReason: null,
    lastEvent: '创建导出任务',
    injectedFaults: [],
    createdAt: timestamp,
    updatedAt: timestamp,
    archived: source.archived,
  }
  acquireLock(manifest, options.owner ?? newOwner())
  return persist(storage, manifest, '创建导出任务，进入首批写入')
}

function loadWritableManifest(
  storage: ExportStorage,
  key: string,
  owner: string,
): ExportManifest {
  const manifest = storage.readManifest(key)
  if (!manifest) throw new ExportFailedError('没有可用的导出数据明细文件，请先新建导出任务')
  if (manifest.status === 'published') return manifest
  if (manifest.status === 'failed') {
    throw new ExportFailedError(`导出已失败：${manifest.failureReason ?? '未知原因'}；请封存失败分片后发布修订文件`)
  }
  acquireLock(manifest, owner)
  if (manifest.status === 'interrupted') {
    manifest.status = 'running'
    manifest.failureReason = null
    persist(storage, manifest, '从安全断点恢复写入')
  }
  return manifest
}

/**
 * 执行一个批次。整批成功才推进断点；故障时断点保持不变，分片路径固定可被重试覆盖，
 * 因此即使分片被截断（跨行文本写一半），续做也不会产生半行或重复行。
 */
export function runBatch(
  storage: ExportStorage,
  key: string,
  source: ExportDataSource,
  options: { owner?: string; fault?: BatchFault } = {},
): BatchResult {
  const owner = options.owner ?? newOwner()
  const manifest = loadWritableManifest(storage, key, owner)
  if (manifest.status === 'published') {
    return { manifest, attempted: false, faultTriggered: false }
  }

  const fault = options.fault
  const triggerFault =
    !!fault &&
    manifest.nextRow >= fault.failAtRow &&
    manifest.nextRow < manifest.totalRows &&
    (!fault.once || !manifest.injectedFaults.includes(fault.failAtRow))

  const start = manifest.nextRow
  const end = Math.min(start + manifest.batchSize, manifest.totalRows)
  const path = chunkPath(key, manifest.workingVersion, manifest.batchNo)
  const isFirstBatch = !manifest.headerWritten

  try {
    let piece = ''
    if (isFirstBatch) piece = `${UTF8_BOM}${toCsvLine(manifest.header)}\n`
    const rows = source.getRows(start, end - start)
    if (rows.length !== end - start) {
      throw new Error(`数据源批次缺行：期望 ${end - start} 行，实际 ${rows.length} 行`)
    }
    for (const cells of rows) piece += `${toCsvLine(cells)}\n`

    if (triggerFault) {
      manifest.injectedFaults.push(fault!.failAtRow)
      storage.write(path, fault!.partialWrite ? piece.slice(0, Math.max(0, Math.floor(piece.length / 2))) : piece)
      throw new ExportInterruptedError(
        `写入在第 ${start + 1} 行附近中断（故障注入），断点保持在第 ${start} 行`,
      )
    }
    storage.write(path, piece)

    // 分片自检：截断 / 缺行的分片一律不推进断点
    const written = storage.read(path) ?? ''
    const expectedRecords = (isFirstBatch ? 1 : 0) + rows.length
    const parsed = parseCsvRecords(written)
    if (parsed.count !== expectedRecords) {
      throw new Error(`分片自检失败：期望 ${expectedRecords} 个逻辑记录，实际 ${parsed.count} 个`)
    }

    // 仅在整批落盘并自检通过后推进安全断点
    let rolling = manifest.rollingDigest
    for (const cells of rows) rolling = fnvDigest(`${toCsvLine(cells)}\n`, rolling)
    manifest.rollingDigest = rolling
    manifest.chunks.push(path)
    manifest.chunkRows.push(rows.length)
    manifest.nextRow = end
    manifest.batchNo += 1
    manifest.headerWritten = true
    manifest.failureReason = null

    if (manifest.nextRow >= manifest.totalRows) {
      finalize(storage, manifest)
    } else {
      persist(storage, manifest, `批次 ${manifest.batchNo} 完成，安全断点推进至第 ${manifest.nextRow} 行`)
    }
    return { manifest, attempted: true, faultTriggered: false }
  } catch (error) {
    // 终检失败等终态错误已经写好 failed 状态，直接上抛，不再降级为中断
    if (error instanceof ExportFailedError) throw error
    manifest.status = 'interrupted'
    manifest.failureReason = error instanceof Error ? error.message : String(error)
    persist(storage, manifest, '批次写入中断，断点未推进，等待续做')
    throw new ExportInterruptedError(manifest.failureReason)
  }
}

/** 组装暂存分片并做行数 + 摘要双重校验，通过才发布到下载入口 */
function finalize(storage: ExportStorage, manifest: ExportManifest): void {
  const content = manifest.chunks.map((path) => storage.read(path) ?? '').join('')
  const report = verifyExportContent(content, {
    totalRows: manifest.totalRows,
    rollingDigest: manifest.rollingDigest,
  })
  if (!report.ok) {
    manifest.status = 'failed'
    manifest.failureReason = `完整性校验未通过，禁止发布：${report.reasons.join('；')}`
    releaseLock(manifest)
    persist(storage, manifest, '终检失败，文件未发布')
    throw new ExportFailedError(manifest.failureReason)
  }

  const path = filePath(manifest.key, manifest.workingVersion)
  storage.write(path, content)

  // 发布后再读回校验，确保下载入口拿到的字节与校验对象一致
  const published = storage.read(path)
  if (published === null || fnvDigest(published) !== report.digest) {
    storage.remove(path)
    manifest.status = 'failed'
    manifest.failureReason = '发布文件读回摘要不一致，已撤回发布'
    releaseLock(manifest)
    persist(storage, manifest, '发布读回校验失败，文件未发布')
    throw new ExportFailedError(manifest.failureReason)
  }

  // 同一文件只暴露一个已发布版本：旧发布版本降级为 superseded，轨迹保留
  for (const version of manifest.versions) {
    if (version.status === 'published') version.status = 'superseded'
  }
  manifest.versions.push({
    version: manifest.workingVersion,
    status: 'published',
    path,
    chunks: [...manifest.chunks],
    origin: manifest.workingVersion === 1 ? (manifest.revisionOf ? 'revision' : 'resume') : 'revision',
    revisedFromVersion: manifest.revisionOf?.version,
    lineCount: report.lineCount,
    dataRows: report.dataRows,
    digest: report.digest,
    rollingDigest: report.rollingDigest,
    byteLength: report.byteLength,
    publishedAt: nowIso(),
  })
  manifest.publishedVersion = manifest.workingVersion
  manifest.status = 'published'
  manifest.failureReason = null
  releaseLock(manifest)
  persist(storage, manifest, `完整性校验通过，发布 v${manifest.workingVersion} 完整明细文件（${report.dataRows} 行）`)
}

/** 路径一：沿用原文件续写，只补 [nextRow, totalRows) 的未完成行，完成后发布 */
export function resumeExport(
  storage: ExportStorage,
  key: string,
  source: ExportDataSource,
  options: { owner?: string; fault?: BatchFault } = {},
): ExportManifest {
  const owner = options.owner ?? newOwner()
  let manifest = loadWritableManifest(storage, key, owner)
  let guard = 0
  while (manifest.status !== 'published' && guard <= manifest.totalRows + 1) {
    const result = runBatch(storage, key, source, { owner, fault: options.fault })
    manifest = result.manifest
    if (!result.attempted) break
    guard += 1
  }
  return storage.readManifest(key) ?? manifest
}

/**
 * 路径二：封存失败分片后发布修订文件。
 * v1 的分片组装成封存件（sealed，不进入下载入口）保留轨迹；v2 复用封存件中
 * 已确认完整的数据、从同一安全断点续写剩余行，校验通过后作为修订版发布。
 */
export function sealAndRevise(
  storage: ExportStorage,
  key: string,
  source: ExportDataSource,
  options: { owner?: string } = {},
): ExportManifest {
  const owner = options.owner ?? newOwner()
  const manifest = loadWritableManifest(storage, key, owner)
  if (manifest.status === 'published') return manifest
  if (manifest.workingVersion !== 1 || manifest.versions.some((v) => v.version === 1)) {
    throw new ExportFailedError('当前版本已封存或已发布，不能重复修订')
  }

  // 1) 封存失败分片：拼接暂存分片，明确标注为非完整、不可下载
  const sealedContent = manifest.chunks.map((p) => storage.read(p) ?? '').join('')
  const sealedReport = verifyExportContent(sealedContent, {
    totalRows: manifest.nextRow,
    rollingDigest: manifest.rollingDigest,
  })
  const sealed = sealedPath(key, 1)
  storage.write(sealed, sealedContent)
  manifest.versions.push({
    version: 1,
    status: 'sealed',
    path: sealed,
    chunks: [...manifest.chunks],
    origin: 'initial',
    lineCount: sealedReport.lineCount,
    dataRows: sealedReport.dataRows,
    digest: sealedReport.digest,
    rollingDigest: sealedReport.rollingDigest,
    byteLength: sealedReport.byteLength,
    sealedAt: nowIso(),
    note: `失败分片封存：中断于安全断点第 ${manifest.nextRow}/${manifest.totalRows} 行`,
  })

  // 2) 开启修订版本 v2：封存件已含 BOM+表头+已确认完整的数据，作为 v2 首个分片，
  //    新分片只写剩余数据行，从同一安全断点续写
  const checkpoint = manifest.nextRow
  const rolling = manifest.rollingDigest
  manifest.workingVersion = 2
  manifest.chunks = [sealed]
  manifest.chunkRows = [checkpoint]
  manifest.nextRow = checkpoint
  manifest.batchNo = 0
  // 封存件已含 BOM+表头，修订分片不得再写表头
  manifest.headerWritten = true
  manifest.rollingDigest = rolling
  manifest.status = 'running'
  manifest.failureReason = null
  manifest.revisionOf = { key, version: 1 }
  persist(storage, manifest, `封存 v1 失败分片（${checkpoint}/${manifest.totalRows} 行），启动 v2 修订文件`)

  // 3) 续写并发布修订版
  return resumeExport(storage, key, source, { owner })
}

/** 跑完剩余全部批次（异步让出事件循环，避免大结果集阻塞页面） */
export async function runToCompletion(
  storage: ExportStorage,
  key: string,
  source: ExportDataSource,
  options: { owner?: string; fault?: BatchFault; yieldEveryBatch?: boolean } = {},
): Promise<ExportManifest> {
  const owner = options.owner ?? newOwner()
  let manifest = storage.readManifest(key)
  if (!manifest) throw new ExportFailedError('没有可用的导出数据明细文件，请先新建导出任务')
  let guard = 0
  while (manifest && manifest.status !== 'published' && guard <= manifest.totalRows + 1) {
    const result = runBatch(storage, key, source, { owner, fault: options.fault })
    manifest = result.manifest
    if (!result.attempted) break
    if (options.yieldEveryBatch) await new Promise((resolve) => setTimeout(resolve, 0))
    guard += 1
  }
  return storage.readManifest(key) ?? manifest
}

// ---------------------------------------------------------------------------
// 读取侧：下载入口与检查视图
// ---------------------------------------------------------------------------

export type PublishedFile = {
  ok: boolean
  filename?: string
  content?: string
  version?: number
  digest?: string
  lineCount?: number
  dataRows?: number
  reason?: string
  status?: ExportStatus
}

/** 下载入口唯一取数口：只发布通过行数与摘要校验的完整文件，每次读取重新校验 */
export function getPublishedFile(storage: ExportStorage, key: string): PublishedFile {
  const manifest = storage.readManifest(key)
  if (!manifest) {
    return { ok: false, status: undefined, reason: '暂无可用的导出数据明细文件，请先新建并完成导出任务' }
  }
  if (manifest.status !== 'published' || manifest.publishedVersion === null) {
    const reason =
      manifest.status === 'interrupted'
        ? `导出在第 ${manifest.nextRow}/${manifest.totalRows} 行中断：${manifest.failureReason ?? '写入中断'}，完成前下载区不提供文件`
        : manifest.status === 'failed'
          ? `导出失败：${manifest.failureReason ?? '未知原因'}，下载区不提供文件`
          : `导出仍在执行（断点 ${manifest.nextRow}/${manifest.totalRows}），完成前下载区不提供文件`
    return { ok: false, status: manifest.status, reason }
  }
  const version = manifest.versions.find((v) => v.version === manifest.publishedVersion)
  if (!version || version.status !== 'published') {
    return { ok: false, status: manifest.status, reason: '已发布版本记录缺失或已被取代，下载区不提供文件' }
  }
  const content = storage.read(version.path)
  if (content === null) {
    return { ok: false, status: manifest.status, reason: '完整文件存储缺失，下载区不提供文件' }
  }
  const report = verifyExportContent(content, {
    totalRows: manifest.totalRows,
    rollingDigest: version.rollingDigest,
  })
  if (!report.ok || report.digest !== version.digest) {
    return {
      ok: false,
      status: manifest.status,
      reason: `完整文件复核失败（${report.reasons.join('；') || '摘要不一致'}），下载区拒绝提供截断数据`,
    }
  }
  return {
    ok: true,
    filename: manifest.filename,
    content,
    version: version.version,
    digest: version.digest,
    lineCount: report.lineCount,
    dataRows: report.dataRows,
    status: 'published',
  }
}

export type ExportInspection = {
  key: string
  filename: string
  status: ExportStatus
  totalRows: number
  nextRow: number
  batchSize: number
  batchNo: number
  progressPercent: number
  rollingDigest: string | null
  failureReason: string | null
  lastEvent: string
  publishedVersion: number | null
  versions: ExportFileVersion[]
  archived: ExportArchive
  /** 已发布文件的实时复核结果（未发布时为 null） */
  publishedCheck: IntegrityReport | null
  createdAt: string
  updatedAt: string
}

/** 用户可检查视图：断点位置、文件行数、完整性摘要、版本轨迹与失败原因都可核对 */
export function inspectExport(storage: ExportStorage, key: string): ExportInspection | null {
  const manifest = storage.readManifest(key)
  if (!manifest) return null
  let publishedCheck: IntegrityReport | null = null
  if (manifest.status === 'published' && manifest.publishedVersion !== null) {
    const version = manifest.versions.find((v) => v.version === manifest.publishedVersion)
    const content = version ? storage.read(version.path) : null
    if (version && content !== null) {
      publishedCheck = verifyExportContent(content, {
        totalRows: manifest.totalRows,
        rollingDigest: version.rollingDigest,
      })
    }
  }
  return {
    key: manifest.key,
    filename: manifest.filename,
    status: manifest.status,
    totalRows: manifest.totalRows,
    nextRow: manifest.nextRow,
    batchSize: manifest.batchSize,
    batchNo: manifest.batchNo,
    progressPercent: manifest.totalRows === 0 ? 100 : Math.floor((manifest.nextRow / manifest.totalRows) * 100),
    rollingDigest: manifest.rollingDigest,
    failureReason: manifest.failureReason,
    lastEvent: manifest.lastEvent,
    publishedVersion: manifest.publishedVersion,
    versions: manifest.versions,
    archived: manifest.archived,
    publishedCheck,
    createdAt: manifest.createdAt,
    updatedAt: manifest.updatedAt,
  }
}

export function listExportKeys(storage: ExportStorage): string[] {
  return storage.listManifestKeys()
}

/** 删除一份明细文件及其全部分片与版本（仅用于演示重置） */
export function removeExport(storage: ExportStorage, key: string): void {
  const manifest = storage.readManifest(key)
  if (manifest) {
    const paths = new Set<string>([...manifest.chunks, ...manifest.versions.map((v) => v.path)])
    for (const path of paths) storage.remove(path)
  }
  storage.removeManifest(key)
}

/** 由业务行构造标准数据源（归档导出任务与字段列表） */
export function dataSourceFromRows(
  filename: string,
  header: string[],
  rows: EntryRow[],
  fields: string[],
  task: ExportArchive['task'],
): ExportDataSource {
  return {
    filename,
    header,
    totalRows: rows.length,
    getRows(offset: number, limit: number) {
      return rows.slice(offset, offset + limit).map((row) => [
        row.id,
        ...fields.map((field) => row[field] ?? ''),
        row.status,
      ])
    },
    archived: { task, fields: [...header] },
  }
}
