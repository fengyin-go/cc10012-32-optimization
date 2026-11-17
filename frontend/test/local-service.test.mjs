/**
 * 调用链集成测试：页面 → local-service（更新点）→ export-detail 引擎。
 * 覆盖 12000 行演示导出的中断/续做、下载入口门禁与报告附件摘要保存。
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import {
  ensureDemoExport,
  runDemoBatch,
  getDemoExportFile,
  resumeDemoExport,
  reviseDemoExport,
  resetDemoExport,
  inspectDemoExport,
  downloadEntries,
  generateReportAttachment,
  listReportAttachments,
  listModuleExportKeys,
  inspectModuleExport,
} from '../src/api/local-service.ts'

test('演示导出：12000 行写到 8000 行中断，完成前下载区无文件，续做后正好 12000 行', () => {
  resetDemoExport()
  const created = ensureDemoExport({ totalRows: 12000, batchSize: 1000 })
  assert.equal(created.nextRow, 0)

  // 连写 8 批 = 8000 行
  for (let i = 0; i < 8; i += 1) {
    const result = runDemoBatch()
    assert.equal(result.faultTriggered, false)
  }
  assert.equal(inspectDemoExport().nextRow, 8000)

  // 在 8000 行安全断点注入中断
  const interrupted = runDemoBatch({ interruptAt: 8000 })
  assert.equal(interrupted.faultTriggered, true)
  assert.equal(interrupted.inspection.nextRow, 8000)
  assert.equal(interrupted.inspection.status, 'interrupted')

  // 完成前下载区无文件，且说明中断原因
  const gated = getDemoExportFile()
  assert.equal(gated.ok, false)
  assert.match(gated.reason, /8000/)

  // 从安全断点续做，完成文件正好 12000 个数据行
  const resumed = resumeDemoExport()
  assert.equal(resumed.status, 'published')
  const file = getDemoExportFile()
  assert.equal(file.ok, true)
  assert.equal(file.dataRows, 12000)
  assert.equal(file.lineCount, 12001)
  resetDemoExport()
})

test('修订路径后下载入口只暴露修订版完整文件', () => {
  resetDemoExport()
  ensureDemoExport({ totalRows: 12000, batchSize: 1000 })
  for (let i = 0; i < 8; i += 1) runDemoBatch()
  runDemoBatch({ interruptAt: 8000 })
  const revised = reviseDemoExport()
  assert.equal(revised.publishedVersion, 2)
  const file = getDemoExportFile()
  assert.equal(file.ok, true)
  assert.equal(file.version, 2)
  assert.equal(file.dataRows, 12000)
  resetDemoExport()
})

test('模块下载入口：没有明细文件时先建后写，仅完整文件返回 ok', async () => {
  // 模块导出 key 与演示 key 隔离
  const result = await downloadEntries('cache')
  assert.equal(result.ok, true)
  const inspection = inspectModuleExport('cache')
  assert.equal(inspection.status, 'published')
  assert.ok(listModuleExportKeys().includes('cache'))
})

test('报告附件读取导出明细文件并保存摘要；无文件时说明原因', () => {
  resetDemoExport()
  ensureDemoExport({ totalRows: 500, batchSize: 100 })
  for (let i = 0; i < 5; i += 1) runDemoBatch()
  const ok = generateReportAttachment(7, '销售分析报告模板', 'export-demo-12000')
  assert.equal(ok.ok, true)
  const attachments = listReportAttachments(7)
  assert.equal(attachments.length, 1)
  assert.equal(attachments[0].dataRows, 500)
  assert.match(attachments[0].digest, /^[0-9a-f]{8}$/)
  assert.equal(attachments[0].sourceExportKey, 'export-demo-12000')

  const missing = generateReportAttachment(8, '无来源报告', 'no-such-export')
  assert.equal(missing.ok, false)
  assert.match(missing.message, /暂无可用的导出数据明细文件/)
  resetDemoExport()
})
