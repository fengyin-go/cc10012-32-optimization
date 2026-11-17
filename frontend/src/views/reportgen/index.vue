<template>
  <section class="page" data-module="reportgen">
    <header class="page-head">
      <div>
        <h2>报告生成管理</h2>
        <p class="page-desc">维护分析报告模板的输入、执行约束与结果记录，为报告生成提供可验证的数据工程流程。</p>
      </div>
      <div class="page-actions">
        <button class="btn primary" type="button" @click="openCreate">登记报告模板</button>
        <button class="btn" type="button" @click="exportRows">导出报告生成清单</button>
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
            <button class="link" type="button" @click="makeAttachment(row)">生成报告附件</button>
          </td>
        </tr>
        <tr v-if="!rows.length">
          <td :colspan="columns.length + 2" class="empty-state">暂无报告生成数据，可先登记报告模板</td>
        </tr>
      </tbody>
    </table>

    <!-- 报告附件：读取导出数据明细文件，通过行数与摘要校验后只保存附件摘要 -->
    <article class="attachment-panel">
      <header class="attachment-head">
        <h3>报告附件摘要</h3>
        <span class="attachment-hint">报告生成与导出入口共用同一份导出数据明细文件，截断数据无法成为附件</span>
      </header>

      <div class="attachment-source">
        <label class="filter-item">
          <span>来源导出数据明细文件</span>
          <select v-model="sourceKey">
            <option v-for="key in exportKeys" :key="key" :value="key">{{ key }}</option>
          </select>
        </label>
        <button class="btn" type="button" @click="refreshSources">刷新来源列表</button>
      </div>
      <p v-if="!exportKeys.length" class="empty-state">
        暂无可用的导出数据明细文件：请先到「数据导出」完成分批导出；中断或失败的文件不会出现在来源中，也无法生成附件。
      </p>

      <table v-if="attachments.length" class="data-table">
        <thead>
          <tr>
            <th>附件编号</th><th>报告</th><th>来源明细文件</th><th>文件名</th>
            <th>版本</th><th>逻辑行数</th><th>数据行数</th><th>字节数</th><th>附件摘要</th><th>生成时间</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="item in attachments" :key="item.id">
            <td>{{ item.id }}</td>
            <td>{{ item.reportName }}</td>
            <td>{{ item.sourceExportKey }}</td>
            <td>{{ item.filename }}</td>
            <td>v{{ item.version }}</td>
            <td>{{ item.lineCount }}</td>
            <td>{{ item.dataRows }}</td>
            <td>{{ item.byteLength }}</td>
            <td><code>{{ item.digest }}</code></td>
            <td>{{ item.createdAt }}</td>
          </tr>
        </tbody>
      </table>
      <p v-else class="empty-state">尚未生成附件摘要。点击报告行的「生成报告附件」，系统会先复核完整文件再保存摘要。</p>

      <footer class="page-foot">
        <span>共 {{ total }} 条报告生成记录</span>
        <span v-if="errorMessage" class="error-text">{{ errorMessage }}</span>
      </footer>
    </article>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'

import {
  downloadEntries,
  generateReportAttachment,
  listModuleExportKeys,
  listReportAttachments,
  listEntries,
  moduleMeta,
  runAction as applyAction,
} from '@/api/local-service'
import type { EntryRow } from '@/data/types'
import type { ReportAttachment } from '@/api/local-service'

const meta = moduleMeta('reportgen')
const columns = ["模板编号", "模板名称", "包含图表", "报告周期", "导出格式", "推送渠道", "水印开关", "附件压缩"]
const actions = ["提交审核", "生效发布", "停用模板"]
const statuses = ["草稿", "待审核", "已生效", "已停用"]
const stats = [{"label": "报告模板总数", "value": 0}, {"label": "已生效模板", "value": 0}, {"label": "待审核模板", "value": 0}]

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

const exportKeys = ref<string[]>([])
const sourceKey = ref('')
const attachments = ref<ReportAttachment[]>([])

function refreshSources() {
  exportKeys.value = listModuleExportKeys()
  if (!sourceKey.value && exportKeys.value.length) sourceKey.value = exportKeys.value[0]
}

function refreshAttachments() {
  attachments.value = listReportAttachments()
}

function resetFilters() {
  filters.value = {}
  reload()
}

async function exportRows() {
  errorMessage.value = ''
  try {
    const result = await downloadEntries(meta.key)
    if (!result.ok) errorMessage.value = result.message
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '导出数据明细文件生成失败'
  }
}

function openCreate() {
  errorMessage.value = '报告模板登记入口尚未接入审批流'
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

function makeAttachment(row: EntryRow) {
  errorMessage.value = ''
  refreshSources()
  if (!sourceKey.value) {
    errorMessage.value = '没有可用的导出数据明细文件：请先在「数据导出」完成分批导出并通过完整性校验'
    return
  }
  const result = generateReportAttachment(Number(row.id), String(row[columns[1]] ?? row.id), sourceKey.value)
  if (!result.ok) {
    errorMessage.value = result.message
    return
  }
  refreshAttachments()
}

function reload() {
  errorMessage.value = ''
  try {
    const payload = listEntries(meta.key, filters.value)
    rows.value = payload.items
    total.value = payload.total
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '报告生成列表读取失败'
  }
}

onMounted(() => {
  reload()
  refreshSources()
  refreshAttachments()
})
</script>

<style scoped>
.attachment-panel {
  margin-top: 18px;
  background: #fff;
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 14px 16px;
}
.attachment-head {
  display: flex;
  justify-content: space-between;
  align-items: baseline;
  gap: 12px;
  margin-bottom: 10px;
}
.attachment-head h3 { margin: 0; font-size: 16px; }
.attachment-hint { color: var(--muted); font-size: 12px; }
.attachment-source { display: flex; gap: 12px; align-items: flex-end; margin-bottom: 12px; }
.attachment-source select { min-width: 260px; padding: 6px 8px; border: 1px solid var(--border); border-radius: 6px; }
code {
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 12px;
  background: #eef2f7;
  padding: 1px 6px;
  border-radius: 4px;
}
</style>
