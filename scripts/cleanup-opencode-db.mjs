/**
 * cleanup-opencode-db — opencode.db 瘦身工具 (event 表清理 + VACUUM)
 *
 * 背景: opencode.db 的 event 表 (event-sourcing 账本) 每次流式更新存全量消息快照,
 *       无保留/压缩机制 (官方 issue #33356/#32005/#36523), 重用户几个月涨到 7-16GB。
 *       session/message/part 是投影读模型, display/LLM context/revert/compaction
 *       全读 session_message 不读 event → event 只用于 replay/sync, 单用户可安全清理。
 *       社区验证: 清 event + VACUUM 后 session/message/part 零丢失, 8.7GB → 3.8GB。
 *
 * 用法 (必须关掉所有 opencode 窗口后运行!):
 *   node scripts/cleanup-opencode-db.mjs            # 全清 event + VACUUM (推荐)
 *   node scripts/cleanup-opencode-db.mjs --mode 7d  # 只清 7 天前会话的 event (保守)
 *   node scripts/cleanup-opencode-db.mjs --no-backup  # 跳过 7GB 备份 (有风险)
 *   node scripts/cleanup-opencode-db.mjs --dry-run    # 只分析, 不动 db
 *   node scripts/cleanup-opencode-db.mjs --force      # 跳过进程检测 (仅在确认无 opencode 运行时用)
 *
 * 参数:
 *   --mode all|7d   清理范围 (默认 all: 清空 event 表; 7d: 保留近 7 天活跃会话的事件)
 *   --days N        7d 模式的保留天数 (默认 7)
 *   --db <path>     覆盖 db 路径 (默认 ~/.local/share/opencode/opencode.db)
 *   --no-backup     跳过备份 (不推荐: db 会先复制成 .backup-<ts> 再动)
 *   --dry-run       只输出分析报告 (大小构成 + 可回收量), 不执行任何修改
 *   --yes           跳过交互确认
 *   --force         进程检测失败/误报时跳过检测 (危险, 仅在确认无 opencode 进程时用)
 *
 * 安全:
 *   1. 检测到 opencode 进程在跑 → 拒绝执行 (运行中改 db 会损坏/阻塞)
 *   2. 默认先备份 opencode.db → opencode.db.backup-<ts>
 *   3. DELETE 分 25k 行/批提交, 避免长事务
 *   4. 清 event 后 VACUUM 回收文件空间; WAL checkpoint(TRUNCATE) 压缩 367MB WAL
 *   5. 完成后 quick_check 校验
 */
import { createRequire } from 'node:module'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { existsSync, statSync, copyFileSync, renameSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { createInterface } from 'node:readline'

const require = createRequire(import.meta.url)
const IS_BUN = typeof process.versions !== 'undefined' && !!process.versions.bun
const DatabaseSync = IS_BUN ? require('bun:sqlite').Database : require('node:sqlite').DatabaseSync

const DEFAULT_DB = join(homedir(), '.local', 'share', 'opencode', 'opencode.db')
const CHUNK = 25000

function parseArgs(argv) {
  const a = { mode: 'all', days: 7, db: DEFAULT_DB, backup: true, dryRun: false, yes: false, force: false }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--mode') a.mode = argv[++i] === '7d' ? '7d' : 'all'
    else if (arg === '--days') a.days = Math.max(1, Number(argv[++i]) || 7)
    else if (arg === '--db') a.db = argv[++i]
    else if (arg === '--no-backup') a.backup = false
    else if (arg === '--dry-run') a.dryRun = true
    else if (arg === '--yes') a.yes = true
    else if (arg === '--force') a.force = true
  }
  return a
}

/**
 * 检测 opencode 进程。返回 { procs, error }:
 *  - procs: 匹配到的进程描述行数组 (空数组 = 无)
 *  - error: 检测本身失败时的原因 (非 null 表示"无法确认是否无 opencode 在跑" → fail-closed)
 * 主用 tasklist; tasklist 不可用时用 PowerShell Get-Process 兜底; 两者都失败 → error (拒绝执行)。
 */
function detectOpenCodeProcesses() {
  try {
    const r = spawnSync('tasklist', ['/FI', 'IMAGENAME eq opencode.exe', '/NH'], {
      encoding: 'utf8',
      windowsHide: true,
      timeout: 10000,
    })
    if (r.status === 0) {
      const out = (r.stdout || '') + (r.stderr || '')
      const lines = out.split(/\r?\n/).filter((l) => l.trim().length > 0)
      const procs = lines
        .filter((l) => /opencode\.exe/i.test(l) && !/信息:|INFO:|No tasks/i.test(l))
        .map((l) => l.trim())
      return { procs, error: null }
    }
  } catch { /* 落到兜底 */ }
  // 兜底: PowerShell Get-Process 统计 (tasklist 不可用/异常时)
  try {
    const ps = spawnSync('powershell', ['-NoProfile', '-Command', '(Get-Process opencode -ErrorAction SilentlyContinue | Measure-Object).Count'], {
      encoding: 'utf8',
      windowsHide: true,
      timeout: 10000,
    })
    const n = Number.parseInt((ps.stdout || '').trim(), 10)
    if (ps.status === 0 && Number.isFinite(n)) {
      return { procs: n > 0 ? [`opencode.exe x${n} (via powershell)`] : [], error: null }
    }
  } catch { /* 都失败 */ }
  return { procs: [], error: 'tasklist 与 PowerShell 检测均失败' }
}

/** 交互确认: readline 直读 stdin (不 spawn 子进程, 兼容交互终端) */
function confirmQuestion(prompt) {
  const rl = createInterface({ input: process.stdin, output: process.stdout })
  return new Promise((resolve) => {
    rl.question(prompt, (ans) => {
      rl.close()
      resolve(ans.trim().toLowerCase())
    })
  })
}

/** 分析: 表构成 + 可回收量 (只读) */
function analyze(dbPath) {
  const db = new DatabaseSync(dbPath, { readOnly: true })
  const pageSize = db.prepare('PRAGMA page_size').get().page_size
  const pageCount = db.prepare('PRAGMA page_count').get().page_count
  const totalBytes = pageSize * pageCount
  const info = { totalBytes, sections: [] }
  for (const t of ['event', 'message', 'part', 'session']) {
    try {
      const c = db.prepare(`SELECT COUNT(*) c FROM ${t}`).get().c
      let bytes = 0
      try {
        bytes = db.prepare(`SELECT SUM(length(data)) s FROM ${t}`).get().s || 0
      } catch { /* 无 data 列 */ }
      info.sections.push({ table: t, rows: c, dataBytes: bytes })
    } catch { /* 表不存在 */ }
  }
  db.close()
  return info
}

function fmtMB(b) {
  return `${(b / 1048576).toFixed(1)} MB`
}

async function main() {
  const a = parseArgs(process.argv.slice(2))
  console.log(`opencode.db 清理工具`)
  console.log(`  db:    ${a.db}`)
  console.log(`  mode:  ${a.mode === '7d' ? `7d (保留 ${a.days} 天内活跃会话的 event)` : 'all (清空 event 表)'}`)
  console.log()

  if (!existsSync(a.db)) {
    console.error(`✗ db 不存在: ${a.db}`)
    process.exit(1)
  }
  const sizeBefore = statSync(a.db).size

  // 0) 进程检测 (运行中绝不操作; 检测失败 = 拒绝执行, fail-closed)
  const det = detectOpenCodeProcesses()
  if (det.error && !a.force) {
    console.error(`✗ 进程检测失败: ${det.error}`)
    console.error(`  无法确认没有 opencode 在运行 — 为防损坏 db, 已中止。`)
    console.error(`  确认所有 opencode 已关闭后重试; 或加 --force 显式跳过检测 (仅在确认无进程时用)。`)
    process.exit(3)
  }
  if (det.procs.length > 0 && !a.force) {
    console.error(`✗ 检测到 opencode 正在运行 (${det.procs.length} 个进程)!`)
    console.error(`  运行中改 db 会损坏/阻塞。请先关闭【所有】opencode 窗口(包括 IDE/终端里开的), 再重跑。`)
    console.error(`  若确认已全部关闭但检测误报, 可加 --force 跳过 (不推荐)。`)
    process.exit(2)
  }

  // 1) 分析
  const info = analyze(a.db)
  console.log(`=== 当前构成 (db 总 ${fmtMB(info.totalBytes)}) ===`)
  for (const s of info.sections) {
    console.log(`  ${s.table.padEnd(8)} ${String(s.rows).padStart(8)} 行, data ${fmtMB(s.dataBytes)}`)
  }
  const eventSection = info.sections.find((s) => s.table === 'event')
  const eventReclaim = eventSection ? (eventSection.dataBytes || eventSection.rows * 1000) : 0
  console.log(`  预计可回收: event 表 ~${fmtMB(eventReclaim)} (VACUUM 后磁盘实际回收更多, 含碎片页)`)
  // WAL
  const walPath = a.db + '-wal'
  const walSize = existsSync(walPath) ? statSync(walPath).size : 0
  if (walSize > 0) console.log(`  WAL 待合并: ${fmtMB(walSize)} (checkpoint 后并入主 db)`)
  console.log()

  if (a.dryRun) {
    console.log(`--dry-run: 未做任何修改。本次实际执行可回收大约 ${fmtMB(eventReclaim + walSize)}。`)
    return
  }

  // 2) 确认
  if (!a.yes) {
    console.log(`将删除 event 表${a.mode === '7d' ? `中 ${a.days} 天前活跃会话的所有事件` : '全部记录'} (仅影响 replay/sync, 不影响会话历史/消息内容)。`)
    const answer = await confirmQuestion('确认执行? [y/N] ')
    if (answer !== 'y' && answer !== 'yes') {
      console.log('已取消。')
      return
    }
  }

  // 3) 备份
  if (a.backup) {
    const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
    const bak = `${a.db}.backup-${ts}`
    console.log(`备份中 ${a.db} → ${bak}  (${fmtMB(sizeBefore)}, 大文件请稍候)...`)
    const t0 = Date.now()
    copyFileSync(a.db, bak)
    console.log(`  完成, 耗时 ${((Date.now() - t0) / 1000).toFixed(0)}s`)
  }

  // 4) 打开 + checkpoint
  const db = new DatabaseSync(a.db)
  try {
    db.exec('PRAGMA wal_checkpoint(TRUNCATE)')
  } catch { /* WAL 无内容时忽略 */ }

  // 5) 删除 event (chunked)
  console.log(`清理 event 表 (mode=${a.mode})...`)
  let total = 0
  const t0 = Date.now()
  if (a.mode === '7d') {
    const cutoff = Date.now() - a.days * 86400 * 1000
    for (;;) {
      const r = db
        .prepare(
          `DELETE FROM event WHERE rowid IN (
             SELECT e.rowid FROM event e
             JOIN session s ON s.id = e.aggregate_id
             WHERE s.time_updated < ?
             LIMIT ?
           )`
        )
        .run(cutoff, CHUNK)
      total += r.changes
      if (r.changes < CHUNK) break
    }
  } else {
    for (;;) {
      const r = db.prepare('DELETE FROM event WHERE rowid IN (SELECT rowid FROM event LIMIT ?)').run(CHUNK)
      total += r.changes
      if (r.changes < CHUNK) break
    }
  }
  console.log(`  删除 ${total} 条 event, 耗时 ${((Date.now() - t0) / 1000).toFixed(0)}s`)

  // 6) VACUUM 回收文件空间
  console.log(`VACUUM 回收空间 (${fmtMB(statSync(a.db).size)}, 需要等量临时空间, 请勿中断)...`)
  const t1 = Date.now()
  db.exec('VACUUM')
  console.log(`  完成, 耗时 ${((Date.now() - t1) / 1000).toFixed(0)}s`)

  // 7) 校验
  const check = db.prepare('PRAGMA quick_check').get()
  const checkOk = check && typeof check === 'object' && Object.values(check).join('') === 'ok'
  console.log(`integrity: ${checkOk ? '✓ quick_check ok' : `✗ ${JSON.stringify(check)}`}`)
  db.close()

  const sizeAfter = statSync(a.db).size
  console.log()
  console.log(`=== 完成 ===`)
  console.log(`  之前: ${fmtMB(sizeBefore)}  →  之后: ${fmtMB(sizeAfter)}  →  回收: ${fmtMB(sizeBefore - sizeAfter)}`)
  if (a.backup) console.log(`  备份: ${a.db}.backup-* (确认一切正常后可删除)`)
  if (!checkOk) process.exit(1)
}

main().catch((e) => {
  console.error(`✗ 未预期异常: ${e?.stack || e}`)
  process.exit(1)
})