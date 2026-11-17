/**
 * 导出数据明细文件引擎测试（node --test）。
 * 运行：node --test --import ./test/register.mjs ./test/export-detail.test.mjs
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import {
  ExportConflictError,
  ExportInterruptedError,
  fnvDigest,
  getPublishedFile,
  inspectExport,
  memoryExportStorage,
  parseCsvRecords,
  recoverStaleExports,
  resumeExport,
  runBatch,
  sealAndRevise,
  startExport,
  UTF8_BOM,
  verifyExportContent,
} from '../src/api/export-detail.ts'

const TOTAL = 12000
const BATCH = 1000
const KEY = 'export-demo-12000'

function makeSource(totalRows = TOTAL) {
  const header = ['行号', '批次标签', '跨行备注', '校验值', '当前状态']
  return {
    filename: '大数据量导出明细-12000行.csv',
    header,
    totalRows,
    getRows(offset, limit) {
      const rows = []
      for (let i = offset; i < offset + limit && i < totalRows; i += 1) {
        const multiline = i % 17 === 0
        const note = multiline
          ? `第${i + 1}行备注\n跨行第二段，含"引号"与,逗号`
          : `普通备注 ${i + 1}`
        rows.push([i + 1, `BATCH-${Math.floor(i / 1000) + 1}`, note, (i * 31) % 9973, '已导出'])
      }
      return rows
    },
    archived: {
      task: { 任务编号: 'EXPO-DEMO-12000', 导出格式: 'CSV' },
      fields: [...header],
    },
  }
}

test('CSV 解析把跨行引号文本算作一条逻辑记录', () => {
  const text = 'a,b\n1,"x\ny",3\n2,plain,4\n'
  const { count, records } = parseCsvRecords(text)
  assert.equal(count, 3)
  assert.match(records[1], /x\ny/)
})

test('正常全量分批导出：发布文件行数与摘要校验通过', () => {
  const storage = memoryExportStorage()
  const source = makeSource()
  startExport(storage, KEY, source, { batchSize: BATCH, owner: 'owner-A' })
  for (let i = 0; i < TOTAL / BATCH; i += 1) runBatch(storage, KEY, source, { owner: 'owner-A' })
  const manifest = inspectExport(storage, KEY)
  assert.equal(manifest.status, 'published')
  assert.equal(manifest.nextRow, TOTAL)
  const file = getPublishedFile(storage, KEY)
  assert.equal(file.ok, true)
  assert.equal(file.dataRows, TOTAL)
  assert.equal(file.lineCount, TOTAL + 1) // 含表头
  const { count } = parseCsvRecords(file.content)
  assert.equal(count, TOTAL + 1)
  // 完成前下载区无文件：中途取文件必须失败
  const storage2 = memoryExportStorage()
  startExport(storage2, KEY, source, { batchSize: BATCH, owner: 'owner-A' })
  runBatch(storage2, KEY, source, { owner: 'owner-A' })
  assert.equal(getPublishedFile(storage2, KEY).ok, false)
})

test('12000 行导出在 8000 行中断：停在安全断点、无半成品、续做只补未完成行且正好 12000 行', () => {
  const storage = memoryExportStorage()
  const source = makeSource()
  startExport(storage, KEY, source, { batchSize: BATCH, owner: 'owner-A' })
  for (let i = 0; i < 8; i += 1) runBatch(storage, KEY, source, { owner: 'owner-A' }) // 8000 行
  let interrupted = inspectExport(storage, KEY)
  assert.equal(interrupted.nextRow, 8000)

  // 下一批在 8000 行断点注入「分片写一半」故障（跨行文本可能被截断）
  assert.throws(
    () =>
      runBatch(storage, KEY, source, {
        fault: { failAtRow: 8000, partialWrite: true, once: true },
        owner: 'owner-A',
      }),
    ExportInterruptedError,
  )
  interrupted = inspectExport(storage, KEY)
  assert.equal(interrupted.status, 'interrupted')
  assert.equal(interrupted.nextRow, 8000, '断点不得推进')
  assert.equal(interrupted.batchNo, 8)
  // 完成前下载区无文件
  const before = getPublishedFile(storage, KEY)
  assert.equal(before.ok, false)
  assert.match(before.reason, /8000/)

  // 失败分片路径固定且不登记进 chunks，续做时会被整批覆盖，不会留下半行
  const rawInterrupted = storage.readManifest(KEY)
  const brokenChunk = storage.read(`${KEY}/v1/chunk-0008`)
  assert.equal(typeof brokenChunk, 'string')
  // chunks 只登记成功分片，失败分片不登记；确认没有第 9 个登记分片
  assert.equal(rawInterrupted.chunks.length, 8)
  assert.equal(interrupted.batchNo, 8)

  // 从安全断点续做：重试只补未完成行（8000..12000）
  const resumed = resumeExport(storage, KEY, source, { owner: 'owner-A' })
  assert.equal(resumed.status, 'published')
  assert.equal(resumed.nextRow, TOTAL)
  assert.equal(resumed.publishedVersion, 1)

  const file = getPublishedFile(storage, KEY)
  assert.equal(file.ok, true)
  assert.equal(file.dataRows, TOTAL, '完成文件正好 12000 个数据行')
  assert.equal(file.lineCount, TOTAL + 1)
  const parsed = parseCsvRecords(file.content)
  assert.equal(parsed.count, TOTAL + 1, '跨行文本未产生半行或错行')
  // 每行行号唯一且连续，证明没有重复补行
  const lineNumbers = parsed.records.slice(1).map((record) => Number(record.split(',')[0]))
  assert.deepEqual(lineNumbers[0], 1)
  assert.deepEqual(lineNumbers[TOTAL - 1], TOTAL)
  assert.equal(new Set(lineNumbers).size, TOTAL)
})

test('once 故障只触发一次，再次调用同一断点不再中断', () => {
  const storage = memoryExportStorage()
  const source = makeSource(2000)
  startExport(storage, KEY, source, { batchSize: 1000, owner: 'owner-A' })
  runBatch(storage, KEY, source, { owner: 'owner-A' })
  assert.throws(
    () => runBatch(storage, KEY, source, { fault: { failAtRow: 1000, partialWrite: false, once: true }, owner: 'owner-A' }),
    ExportInterruptedError,
  )
  // 同一故障对象再次使用：不再触发，直接完成
  const fault = { failAtRow: 1000, partialWrite: false, once: true }
  const manifest = resumeExport(storage, KEY, source, { fault, owner: 'owner-A' })
  assert.equal(manifest.status, 'published')
  assert.equal(manifest.injectedFaults.length, 1)
})

test('修订路径：封存失败分片后发布 v2，下载入口只暴露完整文件且保留版本轨迹', () => {
  const storage = memoryExportStorage()
  const source = makeSource()
  startExport(storage, KEY, source, { batchSize: BATCH, owner: 'owner-A' })
  for (let i = 0; i < 8; i += 1) runBatch(storage, KEY, source, { owner: 'owner-A' })
  assert.throws(
    () =>
      runBatch(storage, KEY, source, {
        fault: { failAtRow: 8000, partialWrite: true, once: true },
        owner: 'owner-A',
      }),
    ExportInterruptedError,
  )
  const revised = sealAndRevise(storage, KEY, source, { owner: 'owner-A' })
  assert.equal(revised.status, 'published')
  assert.equal(revised.workingVersion, 2)
  assert.equal(revised.publishedVersion, 2)
  assert.equal(revised.versions.length, 2)
  const [v1, v2] = revised.versions
  assert.equal(v1.status, 'sealed')
  assert.equal(v1.dataRows, 8000)
  assert.equal(v1.origin, 'initial')
  assert.equal(v2.status, 'published')
  assert.equal(v2.origin, 'revision')
  assert.equal(v2.revisedFromVersion, 1)
  assert.equal(v2.dataRows, TOTAL)

  // 封存件存在但下载入口不暴露
  assert.equal(storage.exists(v1.path), true)
  const file = getPublishedFile(storage, KEY)
  assert.equal(file.ok, true)
  assert.equal(file.version, 2)
  assert.equal(file.dataRows, TOTAL)
})

test('并发执行：活跃写入锁拒绝第二个写入者，且只认可一份明细文件', () => {
  const storage = memoryExportStorage()
  const source = makeSource()
  startExport(storage, KEY, source, { batchSize: BATCH, owner: 'owner-A' })
  runBatch(storage, KEY, source, { owner: 'owner-A' })
  assert.throws(
    () => runBatch(storage, KEY, source, { owner: 'owner-B' }),
    ExportConflictError,
  )
  // 同一 owner 可继续
  assert.doesNotThrow(() => runBatch(storage, KEY, source, { owner: 'owner-A' }))
  // 重复 start 同一 key 不产生第二份文件
  const again = startExport(storage, KEY, source, { batchSize: BATCH, owner: 'owner-A' })
  assert.equal(again.workingVersion, 1)
  assert.equal(storage.listManifestKeys().filter((k) => k === KEY).length, 1)
})

test('发布后篡改文件会被读取侧复核拦截，下载入口拒绝截断数据', () => {
  const storage = memoryExportStorage()
  const source = makeSource(3000)
  startExport(storage, KEY, source, { batchSize: 1000, owner: 'owner-A' })
  for (let i = 0; i < 3; i += 1) runBatch(storage, KEY, source, { owner: 'owner-A' })
  const before = getPublishedFile(storage, KEY)
  assert.equal(before.ok, true)

  // 模拟外部截断：删掉最后 500 个字符
  const manifestPath = inspectExport(storage, KEY).versions[0].path
  const original = storage.read(manifestPath)
  storage.write(manifestPath, original.slice(0, original.length - 500))
  const tampered = getPublishedFile(storage, KEY)
  assert.equal(tampered.ok, false)
  assert.match(tampered.reason, /复核失败|摘要/)
})

test('没有明细文件时下载入口返回说明状态', () => {
  const storage = memoryExportStorage()
  const file = getPublishedFile(storage, 'missing-key')
  assert.equal(file.ok, false)
  assert.match(file.reason, /暂无可用的导出数据明细文件/)
  assert.equal(inspectExport(storage, 'missing-key'), null)
})

test('页面重开恢复：过期锁的执行中任务变为可续做的中断态，续做后完整发布', () => {
  const storage = memoryExportStorage()
  const source = makeSource(5000)
  startExport(storage, KEY, source, { batchSize: 1000, owner: 'owner-A' })
  runBatch(storage, KEY, source, { owner: 'owner-A' })
  runBatch(storage, KEY, source, { owner: 'owner-A' })
  // 模拟页面关闭：状态仍为 running，但锁已过期
  const stale = inspectExport(storage, KEY)
  assert.equal(stale.status, 'running')
  storage.writeManifest(KEY, {
    ...raw(storage, KEY),
    ownerExpiresAt: new Date(Date.now() - 1000).toISOString(),
  })
  const recovered = recoverStaleExports(storage)
  assert.equal(recovered.length, 1)
  assert.equal(recovered[0].status, 'interrupted')
  assert.equal(recovered[0].nextRow, 2000)
  assert.match(recovered[0].failureReason, /安全断点/)
  const resumed = resumeExport(storage, KEY, source, { owner: 'owner-A' })
  assert.equal(resumed.status, 'published')
  assert.equal(resumed.nextRow, 5000)
})

function raw(storage, key) {
  return storage.readManifest(key)
}

test('verifyExportContent 同时校验行数与滚动摘要', () => {
  const content = `${UTF8_BOM}a,b\n1,x\n2,y\n`
  const rows = ['1,x\n', '2,y\n']
  let rolling = null
  for (const line of rows) rolling = fnvDigest(line, rolling)
  const okReport = verifyExportContent(content, { totalRows: 2, rollingDigest: rolling })
  assert.equal(okReport.ok, true)
  const badCount = verifyExportContent(content, { totalRows: 3, rollingDigest: rolling })
  assert.equal(badCount.ok, false)
  assert.match(badCount.reasons[0], /数据行数校验失败/)
  const badDigest = verifyExportContent(content, { totalRows: 2, rollingDigest: 'deadbeef' })
  assert.equal(badDigest.ok, false)
  assert.match(badDigest.reasons[0], /滚动摘要校验失败/)
})

test('数据源缺行时批次失败且断点不推进', () => {
  const storage = memoryExportStorage()
  const source = makeSource(2000)
  source.getRows = (offset, limit) => (offset === 1000 ? [] : makeSource(2000).getRows(offset, limit))
  startExport(storage, KEY, source, { batchSize: 1000, owner: 'owner-A' })
  runBatch(storage, KEY, source, { owner: 'owner-A' })
  assert.throws(() => runBatch(storage, KEY, source, { owner: 'owner-A' }), /数据源批次缺行/)
  const manifest = inspectExport(storage, KEY)
  assert.equal(manifest.status, 'interrupted')
  assert.equal(manifest.nextRow, 1000)
})

test('终检失败保持 failed 终态，不会被降级为中断，且下载区无文件', () => {
  const storage = memoryExportStorage()
  const source = makeSource(2000)
  startExport(storage, KEY, source, { batchSize: 1000, owner: 'owner-A' })
  runBatch(storage, KEY, source, { owner: 'owner-A' })
  // 破坏已成功分片：让组装后的完整文件缺少数据行，终检必然失败
  const raw = storage.readManifest(KEY)
  storage.write(raw.chunks[0], storage.read(raw.chunks[0]).split('\n').slice(0, 2).join('\n') + '\n')
  assert.throws(
    () => runBatch(storage, KEY, source, { owner: 'owner-A' }),
    /完整性校验未通过/,
  )
  const manifest = inspectExport(storage, KEY)
  assert.equal(manifest.status, 'failed')
  assert.match(manifest.failureReason, /完整性校验未通过/)
  assert.equal(getPublishedFile(storage, KEY).ok, false)
})
