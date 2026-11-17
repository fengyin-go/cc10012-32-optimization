<template>
  <section class="page" data-module="export">
    <header class="page-head">
      <div>
        <h2>数据导出管理</h2>
        <p class="page-desc">维护数据导出任务的输入、执行约束与结果记录，为数据导出提供可验证的数据工程流程。</p>
      </div>
      <div class="page-actions">
        <button class="btn primary" type="button" @click="openCreate">登记导出任务</button>
        <button class="btn" type="button" :disabled="busy" @click="exportRows">导出数据导出清单</button>
      </div>
    </header>

    <div class="stat-row">
      <article v-for="item in stats" :key="item.label" class="stat-card">
        <span class="stat-label">{{ item.label }}</span>
        <strong class="stat-value">{{ item.value }}</strong>
      </article>
    </div>

    <p class="status-legend">
      <span v-for="item in statusSummary" :key="item.status" class="legend-item">
        {{ item.status }}：{{ item.count }}
      </span>
    </p>

    <form class="filter-bar" @submit.prevent="reload">
      <label v-for="field in filterFields" :key="field" class="filter-item">
        <span>{{ field }}</span>
        <input v-model="filters[field]" :placeholder="`按${field}检索`" />
      </label>
      <button class="btn" type="submit">查询</button>
      <button class="btn ghost" type="button" @click="resetFilters">重置条件</button>
    </form>

    <table class="data-table">
      <thead>
        <tr>
          <th v-for="column in columns" :key="column">{{ column }}</th>
          <th>当前状态</th>
          <th>可执行动作</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="row in rows" :key="String(row.id)">
          <td v-for="column in columns" :key="column">{{ row[column] ?? '—' }}</td>
          <td>{{ row.status }}</td>
          <td class="row-actions">
            <button
              v-for="action in actions"
              :key="action"
              class="link"
              type="button"
              @click="runAction(action, row)"
            >
              {{ action }}
            </button>
          </td>
        </tr>
        <tr v-if="!rows.length">
          <td :colspan="columns.length + 2" class="empty-state">暂无数据导出数据，可先登记导出任务</td>
        </tr>
      </tbody>
    </table>

    <!-- 导出数据明细文件：分批写入、断点续做、完整性校验与发布控制 -->
    <article class="export-panel">
      <header class="export-panel-head">
        <h3>导出数据明细文件（可断点续做）</h3>
        <span class="export-hint">分片暂存不进下载区；仅行数与摘要双校验通过的完整文件才发布</span>
      </header>

      <!-- 12000 行大结果集演示：8000 行中断 → 安全断点续做 -->
      <div class="demo-box">
        <strong>大结果集演示（12000 行，每批 1000 行，含跨行文本）</strong>
        <div class="demo-actions">
          <button class="btn" type="button" :disabled="busy" @click="demoCreate">新建演示导出</button>
          <button class="btn" type="button" :disabled="busy" @click="demoBatch">写入一个批次</button>
          <button class="btn danger" type="button" :disabled="busy" @click="demoInterrupt">在 8000 行注入中断</button>
          <button class="btn primary" type="button" :disabled="busy" @click="demoResume">从安全断点续做</button>
          <button class="btn" type="button" :disabled="busy" @click="demoRevise">封存分片并发布修订文件</button>
          <button class="btn ghost" type="button" :disabled="busy" @click="demoDownload">下载入口取文件</button>
          <button class="btn ghost" type="button" :disabled="busy" @click="demoReset">重置演示</button>
        </div>
        <p v-if="demoMessage" class="demo-message" :class="{ 'error-text': demoMessageIsError }">{{ demoMessage }}</p>
      </div>

      <template v-if="demo">
        <div class="inspect-grid">
          <div><span class="inspect-label">文件状态</span><strong :class="statusClass(demo.status)">{{ statusText(demo.status) }}</strong></div>
          <div><span class="inspect-label">安全断点</span><strong>第 {{ demo.nextRow }} / {{ demo.totalRows }} 行</strong></div>
          <div><span class="inspect-label">已完成批次</span><strong>{{ demo.batchNo }} 批（每批 {{ demo.batchSize }} 行）</strong></div>
          <div><span class="inspect-label">进度</span><strong>{{ demo.progressPercent }}%</strong></div>
          <div class="inspect-wide"><span class="inspect-label">滚动摘要（数据行）</span><code>{{ demo.rollingDigest ?? '尚未写入数据行' }}</code></div>
          <div class="inspect-wide"><span class="inspect-label">最近事件</span><span>{{ demo.lastEvent }}</span></div>
          <div v-if="demo.failureReason" class="inspect-wide">
            <span class="inspect-label">中断 / 失败原因</span><span class="error-text">{{ demo.failureReason }}</span>
          </div>
        </div>

        <div class="progress-track"><div class="progress-bar" :style="{ width: `${demo.progressPercent}%` }"></div></div>

        <h4>版本轨迹与完整性摘要</h4>
        <table v-if="demo.versions.length" class="data-table version-table">
          <thead>
            <tr>
              <th>版本</th><th>来源</th><th>状态</th><th>逻辑行数</th><th>数据行数</th>
              <th>完整摘要</th><th>滚动摘要</th><th>字节数</th><th>时间</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="version in demo.versions" :key="version.version">
              <td>v{{ version.version }}<span v-if="version.revisedFromVersion">（修订自 v{{ version.revisedFromVersion }}）</span></td>
              <td>{{ originText(version.origin) }}</td>
              <td>{{ versionStatusText(version.status) }}</td>
              <td>{{ version.lineCount }}</td>
              <td>{{ version.dataRows }}</td>
              <td><code>{{ version.digest }}</code></td>
              <td><code>{{ version.rollingDigest }}</code></td>
              <td>{{ version.byteLength }}</td>
              <td>{{ version.publishedAt ?? version.sealedAt ?? '—' }}</td>
            </tr>
          </tbody>
        </table>
        <p v-else class="empty-state">尚无任何版本：分片只在暂存区累积，完成校验前下载区无文件。</p>

        <div v-if="demo.publishedCheck" class="published-check" :class="{ ok: demo.publishedCheck.ok }">
          <span class="inspect-label">已发布文件实时复核</span>
          <strong :class="demo.publishedCheck.ok ? 'ok-text' : 'error-text'">
            {{ demo.publishedCheck.ok ? '通过' : '未通过' }}
          </strong>
          <span>逻辑行 {{ demo.publishedCheck.lineCount }}（含表头），数据行 {{ demo.publishedCheck.dataRows }}，摘要 {{ demo.publishedCheck.digest }}</span>
          <ul v-if="!demo.publishedCheck.ok">
            <li v-for="reason in demo.publishedCheck.reasons" :key="reason" class="error-text">{{ reason }}</li>
          </ul>
        </div>

        <details class="archive-box">
          <summary>归档信息：导出任务与字段列表</summary>
          <pre>{{ JSON.stringify(demo.archived, null, 2) }}</pre>
        </details>
      </template>

      <p v-else class="empty-state">
        没有可用的导出数据明细文件。点击「新建演示导出」生成分批写入任务；中断或失败后此面板会说明原因，刷新页面后状态仍可检查、可续做。
      </p>

      <footer class="page-foot">
        <span>共 {{ total }} 条数据导出记录</span>
        <span v-if="errorMessage" class="error-text">{{ errorMessage }}</span>
      </footer>
    </article>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'

import {
  downloadEntries,
  ensureDemoExport,
  getDemoExportFile,
  inspectDemoExport,
  listEntries,
  moduleMeta,
  resetDemoExport,
  resumeDemoExport,
  reviseDemoExport,
  runAction as applyAction,
  runDemoBatch,
} from '@/api/local-service'
import type { ExportInspection } from '@/api/export-detail'
import type { EntryRow } from '@/data/types'

const meta = moduleMeta('export')
const columns = ["任务编号", "查询SQL", "导出格式", "字段列表", "分隔符", "编码格式", "压缩方式", "目标路径"]
const actions = ["提交执行", "启动导出", "终止导出", "归档文件"]
const statuses = ["草稿", "待执行", "执行中", "已完成", "已失败"]
const stats = [{"label": "导出任务总数", "value": 0}, {"label": "执行中任务", "value": 0}, {"label": "已完成任务", "value": 0}]

const rows = ref<EntryRow[]>([])
const total = ref(0)
const errorMessage = ref('')
const filters = ref<Record<string, string>>({})
const filterFields = columns.slice(0, 3)
const statusSummary = computed(() =>
  statuses.map((status: string) => ({
    status,
    count: rows.value.filter((row) => String(row.status) === status).length,
  })),
)

const busy = ref(false)
const demo = ref<ExportInspection | null>(null)
const demoMessage = ref('')
const demoMessageIsError = ref(false)

function refreshDemo() {
  demo.value = inspectDemoExport()
}

function notify(message: string, isError = false) {
  demoMessage.value = message
  demoMessageIsError.value = isError
}

function statusText(status: string): string {
  return { running: '执行中', interrupted: '已中断（可续做）', failed: '已失败', published: '已发布' }[status] ?? status
}
function statusClass(status: string): string {
  return status === 'published' ? 'ok-text' : status === 'failed' ? 'error-text' : ''
}
function originText(origin: string): string {
  return { initial: '初次写入', resume: '原文件续写', revision: '封存后修订' }[origin] ?? origin
}
function versionStatusText(status: string): string {
  return { sealed: '已封存（不提供下载）', published: '已发布（下载入口可见）', superseded: '已被取代' }[status] ?? status
}

function resetFilters() {
  filters.value = {}
  reload()
}

async function exportRows() {
  errorMessage.value = ''
  busy.value = true
  try {
    const result = await downloadEntries(meta.key)
    if (!result.ok) errorMessage.value = result.message
    reload()
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '导出数据明细文件生成失败'
  } finally {
    busy.value = false
  }
}

function openCreate() {
  errorMessage.value = '导出任务登记入口尚未接入审批流'
}

function runAction(action: string, row: EntryRow) {
  errorMessage.value = ''
  const result = applyAction(meta.key, Number(row.id), action)
  if (!result.ok) {
    errorMessage.value = result.message
    return
  }
  reload()
}

function reload() {
  errorMessage.value = ''
  try {
    const payload = listEntries(meta.key, filters.value)
    rows.value = payload.items
    total.value = payload.total
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '数据导出列表读取失败'
  }
}

// 演示操作：12000 行导出在 8000 行中断，从安全断点继续，完成前下载区无文件
function demoCreate() {
  const inspection = ensureDemoExport({ totalRows: 12000, batchSize: 1000 })
  refreshDemo()
  notify(`已新建演示导出：共 ${inspection.totalRows} 行，每批 ${inspection.batchSize} 行，断点位于第 0 行`)
}

function demoBatch() {
  if (!demo.value) return notify('请先新建演示导出', true)
  const { inspection, faultTriggered } = runDemoBatch()
  refreshDemo()
  if (faultTriggered) {
    notify(`批次写入中断，断点保持在第 ${inspection.nextRow} 行，未产生半成品文件`, true)
  } else if (inspection.status === 'published') {
    notify(`全部完成并发布：文件正好 ${inspection.totalRows} 个数据行，下载入口可见完整文件`)
  } else {
    notify(`批次完成，安全断点推进至第 ${inspection.nextRow} 行`)
  }
}

function demoInterrupt() {
  if (!demo.value) return notify('请先新建演示导出', true)
  // 在 nextRow 达到 8000 后的下一批注入「分片写一半」故障
  const { inspection } = runDemoBatch({ interruptAt: 8000 })
  refreshDemo()
  const beforeDownload = getDemoExportFile()
  notify(
    `已在 8000 行附近注入写入中断：断点停在第 ${inspection.nextRow} 行，失败分片未推进断点。` +
      `下载入口检查：${beforeDownload.ok ? '异常：出现文件' : '无文件（符合预期）'}`,
    true,
  )
}

function demoResume() {
  if (!demo.value) return notify('请先新建演示导出', true)
  try {
    const inspection = resumeDemoExport()
    refreshDemo()
    if (inspection.status === 'published') {
      notify(`断点续做完成：仅补齐安全断点之后的未完成行，已发布 ${inspection.totalRows} 行完整文件`)
    } else {
      notify(`续做后状态：${statusText(inspection.status)}，断点第 ${inspection.nextRow} 行`, true)
    }
  } catch (error) {
    refreshDemo()
    notify(error instanceof Error ? error.message : '续做失败', true)
  }
}

function demoRevise() {
  if (!demo.value) return notify('请先新建演示导出', true)
  try {
    const inspection = reviseDemoExport()
    refreshDemo()
    notify(`已封存失败分片并发布修订文件 v${inspection.publishedVersion}：v1 封存件不进下载区，v2 为唯一完整文件`)
  } catch (error) {
    refreshDemo()
    notify(error instanceof Error ? error.message : '修订发布失败', true)
  }
}

function demoDownload() {
  const file = getDemoExportFile()
  if (!file.ok) {
    notify(file.reason ?? '下载区无文件', true)
    return
  }
  const blob = new Blob([file.content!], { type: 'text/csv;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = file.filename!
  document.body.appendChild(anchor)
  anchor.click()
  document.body.removeChild(anchor)
  URL.revokeObjectURL(url)
  notify(`下载入口发布完整文件：${file.filename}，v${file.version}，数据行 ${file.dataRows}，摘要 ${file.digest}`)
}

function demoReset() {
  resetDemoExport()
  refreshDemo()
  notify('演示已重置，所有分片与版本轨迹已清除')
}

onMounted(() => {
  reload()
  refreshDemo()
})
</script>

<style scoped>
.export-panel {
  margin-top: 18px;
  background: #fff;
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 14px 16px;
}
.export-panel-head {
  display: flex;
  justify-content: space-between;
  align-items: baseline;
  gap: 12px;
  margin-bottom: 10px;
}
.export-panel-head h3 { margin: 0; font-size: 16px; }
.export-hint { color: var(--muted); font-size: 12px; }
.demo-box {
  background: #f1f5fb;
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 10px 12px;
  margin-bottom: 12px;
}
.demo-actions { display: flex; flex-wrap: wrap; gap: 8px; margin: 8px 0; }
.btn.danger { border-color: #b42318; color: #b42318; }
.btn:disabled { opacity: 0.5; cursor: not-allowed; }
.demo-message { margin: 6px 0 0; font-size: 13px; }
.inspect-grid {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 10px;
  margin-bottom: 10px;
}
.inspect-grid > div { display: flex; flex-direction: column; gap: 2px; font-size: 13px; }
.inspect-wide { grid-column: span 4; }
.inspect-label { color: var(--muted); font-size: 12px; }
.inspect-grid code, .version-table code {
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 12px;
  background: #eef2f7;
  padding: 1px 6px;
  border-radius: 4px;
}
.progress-track {
  height: 8px;
  background: #e5eaf1;
  border-radius: 999px;
  overflow: hidden;
  margin-bottom: 14px;
}
.progress-bar { height: 100%; background: var(--brand); transition: width 0.2s; }
.version-table { margin: 6px 0 12px; }
.published-check {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  align-items: center;
  border: 1px solid var(--border);
  border-radius: 6px;
  padding: 8px 10px;
  font-size: 13px;
  margin-bottom: 10px;
}
.published-check.ok { border-color: #1a7f37; background: #f0fdf4; }
.ok-text { color: #1a7f37; }
.archive-box summary { cursor: pointer; font-size: 13px; color: var(--muted); }
.archive-box pre {
  font-size: 12px;
  background: #0f172a;
  color: #dbe4f0;
  padding: 10px;
  border-radius: 6px;
  overflow: auto;
}
</style>
