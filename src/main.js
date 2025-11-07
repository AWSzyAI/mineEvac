// filename: baseline.mjs
// 终端菜单：build / spawn / patrol / stop / status / quit
// （可选）网页：安装 prismarine-viewer 后访问 http://localhost:3000
// 反 SPAM：大延时+极简命令（不画黑边），必要时提高 CMD_DELAY_MS

import mineflayer from 'mineflayer'
import mfPathfinder from 'mineflayer-pathfinder'
const { pathfinder, Movements, goals } = mfPathfinder
import minecraftData from 'minecraft-data'
import vec3 from 'vec3'
const { Vec3 } = vec3
import fs, { promises as fsp } from 'fs'
import path from 'path'
import readline from 'readline'
import { fileURLToPath } from 'url'

// ---------- 可选：viewer ----------
let mineflayerViewer = null
try {
  const pv = await import('prismarine-viewer')
  mineflayerViewer = pv.mineflayer || pv.default?.mineflayer || null
} catch (_) {
  // 未安装就忽略
}

// ---------- 小工具 ----------
const __filename = fileURLToPath(import.meta.url)
const __dirname  = path.dirname(__filename)
const sleep = (ms) => new Promise(r => setTimeout(r, ms))

// ---------- 参数 ----------
const BOT_NAME = 'sweeper'
const HOST = '127.0.0.1'
const PORT = 25565

// 节流（如仍被踢，把 600 调到 800 / 1000）
const CMD_DELAY_MS = Number(process.env.CMD_DELAY_MS || 600)
const CMD_HEAVY_PAD_MS = Number(process.env.CMD_HEAVY_PAD_MS || 900)

// 超平坦模式：设置环境变量 FLAT=1 切换（或直接改下面的默认）
const IS_FLAT = process.env.FLAT === '1'
// 支持强制指定基准高度：BASE_Y 优先，其次根据是否平坦选择 4 或 64
const BASE_Y_ENV = process.env.BASE_Y
const Y = (BASE_Y_ENV !== undefined && !Number.isNaN(Number(BASE_Y_ENV)))
  ? Number(BASE_Y_ENV)
  : (IS_FLAT ? 4 : 64)
// 布局构建层：距离地面 1 格（ground 在 Y-1，因此默认放在 Y）。
// 可通过环境变量 BUILD_OFFSET 调整相对地面的偏移（默认 0 -> 放在 Y）。
const BUILD_OFFSET = Number(process.env.BUILD_OFFSET || 0)
// const LAYOUT_Y = Y + BUILD_OFFSET
let LAYOUT_Y = Y + BUILD_OFFSET
// 目标原点（默认对齐到世界坐标 0,0，可通过环境变量覆盖）
const ORIGIN_X = Number(process.env.ORIGIN_X || 0)
const ORIGIN_Z = Number(process.env.ORIGIN_Z || 0)

// 是否允许写入服务器 world（默认允许；设置 USE_DATAPACK=0 则不改世界，仅用命令强制环境）
const USE_DATAPACK = process.env.USE_DATAPACK !== '0'
// 世界目录（默认指向 ../server/world，可通过 WORLD_DIR 覆盖）
const WORLD_DIR = process.env.WORLD_DIR
  ? path.resolve(__dirname, process.env.WORLD_DIR)
  : path.resolve(__dirname, '../server/world')


// ---------- 读取 building 配置（默认 baseline.json，可用 BUILDING 环境变量切换） ----------
const BUILDING_NAME = process.env.BUILDING || 'baseline'
const CONFIG_CANDIDATES = [
  path.resolve(__dirname, 'buildings', 'configs', `${BUILDING_NAME}.json`), // 旧路径（兼容）
  path.resolve(__dirname, '../layout', `${BUILDING_NAME}.json`)              // 新路径（推荐）
]
let CONF
try {
  let found = null, lastErr = null
  for (const pth of CONFIG_CANDIDATES) {
    try {
      const raw = await fsp.readFile(pth, 'utf8')
      CONF = JSON.parse(raw)
      found = pth
      break
    } catch (e) { lastErr = e }
  }
  if (found) {
    console.log(`[building] 使用配置 ${BUILDING_NAME}.json -> ${path.relative(process.cwd(), found)}`)
  } else {
    throw lastErr || new Error('未找到配置文件')
  }
} catch (e) {
  console.log(`[building] 配置加载失败，使用内置 baseline：${e?.message || e}`)
  CONF = {
    name: 'baseline',
    frame: { x1: 0, z1: 0, x2: 100, z2: 40 },
    corridor: { x: 5, z: 16, w: 90, h: 8 },
    rooms_top: [
      { x:  8, z: 24, w: 24, h: 12, block: 'orange_wool' },
      { x: 40, z: 24, w: 24, h: 12, block: 'green_wool'  },
      { x: 72, z: 24, w: 24, h: 12, block: 'pink_wool'   },
    ],
    rooms_bottom: [
      { x:  8, z:  1, w: 24, h: 15, block: 'cyan_wool'   },
      { x: 40, z:  1, w: 24, h: 15, block: 'purple_wool' },
      { x: 72, z:  1, w: 24, h: 15, block: 'blue_wool'   },
    ],
    doors: { topZ: 24, bottomZ: 15, xs: [20, 52, 84] },
    wall: { material: 'white_concrete', height: 3 },
    corridor_floor: 'white_concrete',
    exit_marker: 'green_wool'
  }
}
const FRAME          = CONF.frame
const CORRIDOR_MAIN  = CONF.corridor  // 一条走廊（z:16..23）

// —— 坐标偏移与同步点 —— //
// 将主走廊中心对齐到 ORIGIN_X/ORIGIN_Z，以便建筑整体贴近世界原点
const MID_X = Math.floor((CORRIDOR_MAIN.x * 2 + CORRIDOR_MAIN.w) / 2)
const MID_Z = CORRIDOR_MAIN.z + Math.floor(CORRIDOR_MAIN.h / 2)
const SHIFT_X = ORIGIN_X - MID_X
const SHIFT_Z = ORIGIN_Z - MID_Z

// 建筑内部“同步点”
const SPAWN_X = MID_X + SHIFT_X
const SPAWN_Z = MID_Z + SHIFT_Z
// const SPAWN_Y = LAYOUT_Y + 1 // 站在地面上一格，避免卡方块
let SPAWN_Y = LAYOUT_Y + 1

// 房间来自配置
const ROOMS_TOP = CONF.rooms_top
const ROOMS_BOTTOM = CONF.rooms_bottom

// 门配置（在与走廊外墙相接处开门）
const DOOR_XS = (CONF.doors && Array.isArray(CONF.doors.xs)) ? CONF.doors.xs : [20,52,84]
const TOP_WALL_Z = (CONF.doors?.topZ ?? 24) + SHIFT_Z
const BOT_WALL_Z = (CONF.doors?.bottomZ ?? 15) + SHIFT_Z
const TOP_DOOR_Z_CORRIDOR = (CONF.doors?.topZ ?? 24) - 1 + SHIFT_Z
const BOT_DOOR_Z_CORRIDOR = (CONF.doors?.bottomZ ?? 15) + 1 + SHIFT_Z

// 巡逻用门点（走廊内侧一格）
let DOOR_POS = [
  ...DOOR_XS.map(x => ({ x: x + SHIFT_X, y: LAYOUT_Y, z: TOP_DOOR_Z_CORRIDOR })),
  ...DOOR_XS.map(x => ({ x: x + SHIFT_X, y: LAYOUT_Y, z: BOT_DOOR_Z_CORRIDOR })),
]
let PATROL = [...DOOR_POS]

// 出口：走廊两端中线
let EXITS = [
  { x: CORRIDOR_MAIN.x + SHIFT_X,                       y: LAYOUT_Y, z: CORRIDOR_MAIN.z + Math.floor(CORRIDOR_MAIN.h/2) + SHIFT_Z },
  { x: CORRIDOR_MAIN.x + CORRIDOR_MAIN.w - 1 + SHIFT_X, y: LAYOUT_Y, z: CORRIDOR_MAIN.z + Math.floor(CORRIDOR_MAIN.h/2) + SHIFT_Z },
]

// ---------- 命令队列（串行+延迟，含兜底发包） ----------
class CommandQueue {
  constructor(bot, baseDelay = CMD_DELAY_MS) {
    this.bot = bot
    this.queue = Promise.resolve()
    this.baseDelay = baseDelay
    this._alive = true
    bot.once('end',    () => { this._alive = false })
    bot.once('kicked', () => { this._alive = false })
    bot.once('error',  () => { this._alive = false })
  }
  push(fn, delay = this.baseDelay) {
    this.queue = this.queue.then(async () => {
      if (!this._alive) return
      try { await fn() } catch (e) { console.log('[CMD][ERR]', e?.message || e) }
      await sleep(delay)
    })
    return this.queue
  }
  chatCommand(cmd, delay = this.baseDelay) {
    return this.push(async () => {
      await sendSlashCommand(this.bot, cmd)
      console.log('[CMD]', cmd)
    }, delay)
  }
}

// —— 统一的命令发送（优先 bot.chat，失败则发包兜底） —— //
async function sendSlashCommand(bot, cmd) {
  const line = '/' + String(cmd)
  // 1) 官方 API
  if (typeof bot?.chat === 'function') {
    try { bot.chat(line); return } catch (_) { /* fallback */ }
  }
  // 2) 旧版/通用：chat_message
  try {
    bot?._client?.write('chat_message', { message: line })
    return
  } catch (_) { /* fallback */ }
  // 3) 新版（1.19+）：chat_command
  try {
    const now = BigInt(Date.now())
    bot?._client?.write('chat_command', {
      command: line.slice(1),
      timestamp: now,
      salt: 0n,
      signedPreview: false,
      messageCount: 0,
      lastSeenMessages: []
    })
    return
  } catch (e) {
    console.log('[CMD][ERR][fallback]', e?.message || e)
  }
}

// ---------- Bot ----------
// const bot = mineflayer.createBot({ host: HOST, port: PORT, username: BOT_NAME })
const bot = mineflayer.createBot({
  host: HOST,
  port: PORT,
  username: BOT_NAME,
  version: "1.20.1" 
})

bot.loadPlugin(pathfinder)

let mcData, movements
let tick = 0, patrolIdx = 0, dwell = 0
const DWELL_K = 8
let demoTimer = null
let doorsState = PATROL.map((p,i)=>({idx:i, x:p.x, y:p.y, z:p.z, cleared:false, cleared_tick:-1}))
const Q = new CommandQueue(bot)

// 锁定与同步控制（默认解锁，允许移动）
let LOCKED = false
let LOCKED_TO_PLAYER = false
let _syncInterval = null

function lockToOrigin(){
  LOCKED = true
  LOCKED_TO_PLAYER = false
  if (_syncInterval) { clearInterval(_syncInterval); _syncInterval = null }
  Q.chatCommand(`tp ${SPAWN_X} ${SPAWN_Y} ${SPAWN_Z}`, 800)
  console.log(`🔒 bot 已锁定并传送到内部同步点 (${SPAWN_X}, ${SPAWN_Y}, ${SPAWN_Z})`) 
}

function lockToNearestPlayer(){
  LOCKED = true
  LOCKED_TO_PLAYER = true
  const players = Object.values(bot.players).filter(p=>p && p.username && p.username !== BOT_NAME && p.entity)
  if (players.length > 0){
    const pos = players[0].entity.position
    Q.chatCommand(`tp ${Math.round(pos.x)} ${Math.round(pos.y)} ${Math.round(pos.z)}`, 800)
    console.log('🔒 bot 已同步到玩家', players[0].username)
  } else {
    console.log('🔒 未找到在线玩家，稍后会继续尝试同步')
  }
  if (_syncInterval) clearInterval(_syncInterval)
  _syncInterval = setInterval(()=>{
    const ps = Object.values(bot.players).filter(p=>p && p.username && p.username !== BOT_NAME && p.entity)
    if (ps.length > 0){
      const p = ps[0].entity.position
      Q.chatCommand(`tp ${Math.round(p.x)} ${Math.round(p.y)} ${Math.round(p.z)}`, 1500)
    }
  }, 2000)
}

function unlockMovement(){
  LOCKED = false
  LOCKED_TO_PLAYER = false
  if (_syncInterval) { clearInterval(_syncInterval); _syncInterval = null }
  console.log('🔓 bot 已解锁（允许移动/巡逻）')
}

// —— 确保 datapack 存在：如果 world 被删，自动重建 datapack 并可触发 reload —— //
const DP_ROOT = path.resolve(WORLD_DIR, 'datapacks', 'force_origin')
async function ensureDatapack(){
  if (!USE_DATAPACK) {
    console.log('[datapack] 已禁用（USE_DATAPACK=0），跳过写入 world')
    return
  }
  const files = [
    { p: path.join(DP_ROOT, 'pack.mcmeta'),
      c: '{\n  "pack": {\n    "pack_format": 15,\n    "description": "Force origin spawn; no mobs; player creative by default"\n  }\n}\n' },
    { p: path.join(DP_ROOT, 'data/minecraft/tags/functions/load.json'),
      c: '{\n  "values": [\n    "force_origin:load"\n  ]\n}\n' },
    { p: path.join(DP_ROOT, 'data/minecraft/tags/functions/tick.json'),
      c: '{\n  "values": [\n    "force_origin:tick"\n  ]\n}\n' },
    { p: path.join(DP_ROOT, 'data/force_origin/functions/load.mcfunction'),
      c: `# 初始化：创建 scoreboard、设置世界重生点，并固定为白天无天气变化\nscoreboard objectives add joined dummy\nsetworldspawn ${SPAWN_X} ${SPAWN_Y} ${SPAWN_Z}\n# 禁止自然生成生物\ngamerule doMobSpawning false\n# 永远白天与晴朗\ngamerule doDaylightCycle false\ntime set day\ngamerule doWeatherCycle false\nweather clear 1000000\n# 装载时将已在线的玩家标记为已处理\nexecute as @a run scoreboard players set @s joined 1\n` },
    { p: path.join(DP_ROOT, 'data/force_origin/functions/tick.mcfunction'),
      c: `# 每 tick：首次加入玩家传送到内部同步点；给予玩家创造模式；清理非玩家实体\n# 1) 把首次加入玩家送到建筑内部并标记\nexecute as @a[scores={joined=0}] at @s run tp @s ${SPAWN_X} ${SPAWN_Y} ${SPAWN_Z}\nexecute as @a[scores={joined=0}] run scoreboard players set @s joined 1\n\n# 2) 给予创造模式（便于自由移动/飞行）\ngamemode creative @a\n\n# 3) 清理非玩家实体（保留常见无害实体）\nkill @e[type=!player,type=!item,type=!arrow,type=!experience_orb,type=!boat,type=!minecart,type=!painting,type=!armor_stand]\n` }
  ]
  for (const f of files){
    await fsp.mkdir(path.dirname(f.p), { recursive: true })
    try {
      await fsp.stat(f.p)
      // 若已存在则跳过写入，保留你手动改动
    } catch {
      await fsp.writeFile(f.p, f.c)
    }
  }
}

// 输出日志目录迁移到项目根的 log/
const OUT = path.resolve(__dirname, '../log')
async function ensureOut(){
  await fsp.mkdir(OUT, { recursive: true })
  await fsp.writeFile(path.join(OUT,'events.csv'), 't,event,detail\n')
  await fsp.writeFile(path.join(OUT,'responder_track.csv'), 't,x,y,z\n')
  await fsp.writeFile(path.join(OUT,'villagers_track.csv'), 't,id,x,y,z\n')
  const doorHeader = 'door_idx,x,y,z,cleared,cleared_tick\n'
  await fsp.writeFile(path.join(OUT,'doors.csv'),
    doorHeader + doorsState.map(d=>`${d.idx},${d.x},${d.y},${d.z},false,-1`).join('\n') + '\n')
}
const ev = (type, detail={}) => {
  fs.appendFileSync(path.join(OUT, 'events.csv'), `${Date.now()},${type},${JSON.stringify(detail)}\n`)
}
const logResp = (p) => {
  fs.appendFileSync(path.join(OUT, 'responder_track.csv'), `${tick},${p.x.toFixed(2)},${p.y.toFixed(2)},${p.z.toFixed(2)}\n`)
}
const logVill = (id, p) => {
  fs.appendFileSync(path.join(OUT, 'villagers_track.csv'), `${tick},${id},${p.x.toFixed(2)},${p.y.toFixed(2)},${p.z.toFixed(2)}\n`)
}

// 方便排错：打印服务端回显
bot.on('message', (jsonMsg) => {
  try { console.log('[CHAT]', jsonMsg.toString()) } catch { /* ignore */ }
})

bot.once('spawn', async () => {
  try {
    await ensureOut()
    await ensureDatapack()

  // 让所有非机器人玩家切到 creative，立刻可飞（新的选择器语法：name=!<botName>）
  const NON_BOT = `@a[name=!${BOT_NAME}]`
  await Q.chatCommand(`gamemode creative ${NON_BOT}`, 800)
    await Q.chatCommand('difficulty peaceful', 800)
    await Q.chatCommand('gamerule doMobSpawning false', 800)
    await Q.chatCommand('gamerule doDaylightCycle false', 800)
    await Q.chatCommand('time set day', 800)
    await Q.chatCommand('gamerule doWeatherCycle false', 800)
    await Q.chatCommand('weather clear 1000000', 800)
    if (USE_DATAPACK) {
      await Q.chatCommand('reload', 800) // 若刚重建 datapack，使其立即生效
    }

    console.log(`[height] BASE_Y=${Y}, BUILD_OFFSET=${BUILD_OFFSET}, LAYOUT_Y=${LAYOUT_Y}`)

    mcData = minecraftData(bot.version)
    movements = new Movements(bot, mcData)

    if (mineflayerViewer) {
      try {
        mineflayerViewer(bot, { port: 3000, firstPerson: true })
        console.log('🌐 Viewer: http://localhost:3000')
      } catch (e) {
        console.log('[viewer] 启动失败：', e?.message || e)
      }
    } else {
      console.log('（若需网页：npm i prismarine-viewer）')
    }

    console.log('✅ bot 已上线。终端菜单：build / spawn / patrol / stop / status / quit')
  } catch (e) {
    console.log('spawn init error:', e)
  }
})
bot.on('kicked', r => { console.log('[KICKED]', r); if (demoTimer) clearInterval(demoTimer) })
bot.on('end',    r => { console.log('[END]',    r); if (demoTimer) clearInterval(demoTimer) })

function here(){ return bot.entity?.position?.clone() || new Vec3(0,0,0) }

// —— 极简填充：不画黑边，只保留主体块 —— //
async function fillRect(rect, block){
  const x1 = rect.x + SHIFT_X
  const z1 = rect.z + SHIFT_Z
  const x2 = rect.x + rect.w - 1 + SHIFT_X
  const z2 = rect.z + rect.h - 1 + SHIFT_Z
  // 将平面块放在布局层（地面层 LAYOUT_Y）
  await Q.chatCommand(`fill ${x1} ${LAYOUT_Y} ${z1} ${x2} ${LAYOUT_Y} ${z2} ${block}`)
}

// 在矩形四周砌墙，高度为 height（默认3），不封顶
async function buildWalls(rect, material = 'white_concrete', height = 3){
  const x1 = rect.x + SHIFT_X
  const z1 = rect.z + SHIFT_Z
  const x2 = rect.x + rect.w - 1 + SHIFT_X
  const z2 = rect.z + rect.h - 1 + SHIFT_Z
  const y1 = LAYOUT_Y + 1
  const y2 = LAYOUT_Y + height
  // 上、下边
  await Q.chatCommand(`fill ${x1} ${y1} ${z1} ${x2} ${y2} ${z1} ${material}`)
  await Q.chatCommand(`fill ${x1} ${y1} ${z2} ${x2} ${y2} ${z2} ${material}`)
  // 左、右边
  await Q.chatCommand(`fill ${x1} ${y1} ${z1} ${x1} ${y2} ${z2} ${material}`)
  await Q.chatCommand(`fill ${x2} ${y1} ${z1} ${x2} ${y2} ${z2} ${material}`)
}

// —— 真正打穿房间外墙的“门洞” —— //
const DOOR_WIDTH   = 1
const DOOR_HEIGHT  = 2   // 门高 2 格（够走路），需要更高可改 3
const DOOR_PAD_MS  = 200

// 在指定 x,z 的墙线位置打一个 宽*高 的门洞（清空为空气）
async function carveVerticalDoor(x, z, height = DOOR_HEIGHT, width = DOOR_WIDTH) {
  const y1 = LAYOUT_Y + 1
  const y2 = LAYOUT_Y + height
  const xl = x - Math.floor((width - 1) / 2)
  const xr = x + Math.floor(width / 2)
  await Q.chatCommand(`fill ${xl} ${y1} ${z} ${xr} ${y2} ${z} air`, DOOR_PAD_MS)
}

// 根据布局在与走廊接缝的那条“房间外墙”开门：
// 上侧房矩形 z=24..35 → 外墙在 z=24 （紧贴走廊上沿 z=23）
// 下侧房矩形 z= 1..15 → 外墙在 z=15 （紧贴走廊下沿 z=16）
async function carveAllDoors() {
  // 配置中的 topZ / bottomZ 表示房间外墙 z；直接打穿该墙体
  const topWallZ = TOP_WALL_Z
  const botWallZ = BOT_WALL_Z
  for (const x of DOOR_XS) await carveVerticalDoor(x + SHIFT_X, topWallZ)
  for (const x of DOOR_XS) await carveVerticalDoor(x + SHIFT_X, botWallZ)
}

// —— 构建布局 —— //
async function buildLayout(){
  console.log('🧱 开始搭建 baseline 布局…')
  ev('BUILD_BEGIN', { flat: IS_FLAT })
  if (AUTO_GROUND) {
    const gy = await detectGroundYNearCorridor()
    if (Number.isFinite(gy)) {
      LAYOUT_Y = gy
      recomputeDerived()
      console.log('📐 AutoGround: 采用探测到的地表层 LAYOUT_Y =', LAYOUT_Y)
    } else {
      console.log('📐 AutoGround: 未成功探测地表，沿用默认 LAYOUT_Y =', LAYOUT_Y)
    }
  }
  // 若存在上一次构建位置：仅清理“地面以上”空间，保留地面层，避免悬空
  const lastFile = path.join(OUT, 'last_build.json')
  try {
    const raw = await fsp.readFile(lastFile, 'utf8')
    const last = JSON.parse(raw)
    if (Number.isFinite(last.shiftX) && Number.isFinite(last.shiftZ) && Number.isFinite(last.layoutY)) {
      await Q.chatCommand(
        `fill ${FRAME.x1 + last.shiftX} ${last.layoutY + 1} ${FRAME.z1 + last.shiftZ} ${FRAME.x2 + last.shiftX} ${last.layoutY + 10} ${FRAME.z2 + last.shiftZ} air`,
        CMD_HEAVY_PAD_MS
      )
      // 用草方块覆盖上一版本的地面层，恢复“自然地面”视觉
      await Q.chatCommand(
        `fill ${FRAME.x1 + last.shiftX} ${last.layoutY} ${FRAME.z1 + last.shiftZ} ${FRAME.x2 + last.shiftX} ${last.layoutY} ${FRAME.z2 + last.shiftZ} grass_block`,
        CMD_HEAVY_PAD_MS
      )
    }
  } catch (_) { /* 首次构建或读取失败，忽略 */ }

  // 当前目标区域：清理地面以上空间，并为地面层铺设草（防止出现大片空气导致建筑“漂浮”）
  await Q.chatCommand(
    `fill ${FRAME.x1 + SHIFT_X} ${LAYOUT_Y + 1} ${FRAME.z1 + SHIFT_Z} ${FRAME.x2 + SHIFT_X} ${LAYOUT_Y + 10} ${FRAME.z2 + SHIFT_Z} air`,
    CMD_HEAVY_PAD_MS
  )
  await Q.chatCommand(
    `fill ${FRAME.x1 + SHIFT_X} ${LAYOUT_Y} ${FRAME.z1 + SHIFT_Z} ${FRAME.x2 + SHIFT_X} ${LAYOUT_Y} ${FRAME.z2 + SHIFT_Z} grass_block`,
    CMD_HEAVY_PAD_MS
  )

  // 铺设主走廊地面（来自配置）
  await fillRect(CORRIDOR_MAIN,  CONF.corridor_floor || 'white_concrete')

  // 铺设房间地面，并砌3格高的墙（不封顶）
  for (const r of ROOMS_TOP){
    await fillRect(r, r.block)
    await buildWalls(r, CONF.wall?.material || 'white_concrete', CONF.wall?.height || 3)
  }
  for (const r of ROOMS_BOTTOM){
    await fillRect(r, r.block)
    await buildWalls(r, CONF.wall?.material || 'white_concrete', CONF.wall?.height || 3)
  }

  // 在与走廊接壤的外墙上“打门洞”（真正打穿墙体）
  await carveAllDoors()

  // 标出两个出口（走廊两端中线）
  for (const ex of EXITS){
    await Q.chatCommand(`setblock ${ex.x} ${LAYOUT_Y} ${ex.z} ${CONF.exit_marker || 'green_wool'}`)
  }

  // 传送 bot 到内部同步点
  await Q.chatCommand(`tp ${SPAWN_X} ${SPAWN_Y} ${SPAWN_Z}`, 800)

  ev('BUILD_DONE')
  console.log('✅ 布局完成')

  // 记录本次构建位置，供下次清理使用
  try {
    const meta = { shiftX: SHIFT_X, shiftZ: SHIFT_Z, layoutY: LAYOUT_Y, t: Date.now() }
    await fsp.writeFile(lastFile, JSON.stringify(meta))
  } catch (_) { /* 忽略写入失败 */ }
}

async function spawnActors(){
  console.log('👥 生成 3 个村民 …')
  await Q.chatCommand('kill @e[type=villager]', 800)
  // 与门点大致对应的三个位置（上1/上2/下3）
  const spots = [
    new Vec3((DOOR_XS[0] || 20) + SHIFT_X, LAYOUT_Y, TOP_DOOR_Z_CORRIDOR),
    new Vec3((DOOR_XS[1] || 52) + SHIFT_X, LAYOUT_Y, TOP_DOOR_Z_CORRIDOR),
    new Vec3((DOOR_XS[2] || 84) + SHIFT_X, LAYOUT_Y, BOT_DOOR_Z_CORRIDOR)
  ]
  for (const p of spots) await Q.chatCommand(`summon villager ${p.x} ${p.y} ${p.z}`)
  ev('SPAWN', { villagers: spots.length })
  console.log('✅ 生成完成')
}

async function startPatrol(){
  if (LOCKED) { console.log('🔒 当前为锁定状态：忽略巡逻请求'); return }
  if (demoTimer) clearInterval(demoTimer)
  patrolIdx = 0; dwell = 0; tick = 0
  bot.pathfinder.setMovements(movements)
  ev('DEMO_START'); console.log('🚶 开始巡逻…')

  demoTimer = setInterval(async ()=>{
    tick += 1
    const pos = here()
    logResp(pos)

    const tgt = PATROL[patrolIdx % PATROL.length]
    const atDoor = (Math.abs(pos.x - tgt.x) + Math.abs(pos.z - tgt.z)) <= 1.2

    if (!atDoor){
      bot.pathfinder.setGoal(new goals.GoalBlock(tgt.x, tgt.y, tgt.z), false)
      ev('STEP', { patrolIdx, target: tgt })
    } else {
      dwell += 1
      if (dwell === 1){
        const d = doorsState[patrolIdx % doorsState.length]
        if (!d.cleared){
          d.cleared = true
          d.cleared_tick = tick
          await Q.chatCommand(`setblock ${tgt.x} ${LAYOUT_Y} ${tgt.z} blue_concrete`, 800)
          ev('CLEAR', { door_idx: patrolIdx % doorsState.length, tick })
          console.log(`🧹 清理 Door#${patrolIdx % doorsState.length}`)
        }
      }
      if (dwell >= DWELL_K){ patrolIdx += 1; dwell = 0 }
    }

    // 低频挪动村民，保持命令总量低
    if (tick % 80 === 0){
      const vill = Object.values(bot.entities).filter(e=>e.name==='villager')
      for (const v of vill){
        const p = v.position
        const jitter = new Vec3((Math.random()<0.5?-1:1)*2, 0, (Math.random()<0.5?-1:1)*2)
        const to = p.plus(jitter)
        await Q.chatCommand(
          `tp @e[type=villager,limit=1,sort=nearest,x=${Math.round(p.x)},y=${Math.round(p.y)},z=${Math.round(p.z)}] ${Math.round(to.x)} ${Math.round(to.y)} ${Math.round(to.z)}`,
          800
        )
        logVill(v.id, to); ev('VILLAGER_STEP', { id: v.id, to })
      }
    }
  }, 300) // ~3.3Hz，降低 tick 频率
}

function stopPatrol(){
  if (demoTimer) clearInterval(demoTimer)
  demoTimer = null
  ev('DEMO_STOP'); console.log('⏹️ 巡逻结束')
}

// 若不写 world，用事件与心跳替代 datapack 的首登/日晴强制
if (!USE_DATAPACK) {
  // 新玩家加入后立刻拉到创造并传送到同步点
  bot.on('playerJoined', (p) => {
    if (!p?.username || p.username === BOT_NAME) return
    Q.chatCommand(`gamemode creative ${p.username}`, 500)
    Q.chatCommand(`tp ${p.username} ${SPAWN_X} ${SPAWN_Y} ${SPAWN_Z}`, 700)
  })
  // 简易心跳：每 15 秒巩固一次白天晴天（避免被手动更改）
  setInterval(() => {
    Q.chatCommand('time set day', 500)
    Q.chatCommand('weather clear 1000000', 500)
  }, 15000)
}
function recomputeDerived() {
  SPAWN_Y = LAYOUT_Y + 1
  DOOR_POS = [
    ...DOOR_XS.map(x => ({ x: x + SHIFT_X, y: LAYOUT_Y, z: TOP_DOOR_Z_CORRIDOR })),
    ...DOOR_XS.map(x => ({ x: x + SHIFT_X, y: LAYOUT_Y, z: BOT_DOOR_Z_CORRIDOR })),
  ]
  PATROL = [...DOOR_POS]
  EXITS = [
    { x: CORRIDOR_MAIN.x + SHIFT_X,                       y: LAYOUT_Y, z: CORRIDOR_MAIN.z + Math.floor(CORRIDOR_MAIN.h/2) + SHIFT_Z },
    { x: CORRIDOR_MAIN.x + CORRIDOR_MAIN.w - 1 + SHIFT_X, y: LAYOUT_Y, z: CORRIDOR_MAIN.z + Math.floor(CORRIDOR_MAIN.h/2) + SHIFT_Z },
  ]
}
recomputeDerived()
// 自动贴地开关：AUTO_GROUND=1 开启（默认开启）
// const AUTO_GROUND = process.env.AUTO_GROUND !== '0'
const AUTO_GROUND = process.env.AUTO_GROUND !== '0' && process.env.FLAT !== '1'

function getBlockSafe(x, y, z) {
  try {
    if (bot?.world?.getBlock) return bot.world.getBlock(new Vec3(x, y, z))
    if (typeof bot?.blockAt === 'function') return bot.blockAt(new Vec3(x, y, z))
  } catch (_) {}
  return null
}
// 取 (x,z) 的“最高实心块之上那一层”作为地表层
function highestSurfaceYAt(x, z) {
  // 若世界尚未就绪（未 spawn / 已断开），直接放弃探测
  if (!bot?.world && typeof bot?.blockAt !== 'function') return null

  const yMax = (bot?.game?.height && Number.isFinite(bot.game.height)) ? bot.game.height - 1 : 255
  for (let y = yMax; y >= 0; y--) {
    const b = getBlockSafe(x, y, z)
    if (!b) continue
    const name = b.name || ''
    if (name !== 'air' && !name.includes('water') && !name.includes('lava')) {
      return y + 1
    }
  }
  return null
}
// 在走廊中线附近采样多个点，取中位数，得到稳健的 LAYOUT_Y
async function detectGroundYNearCorridor() {
  // 不强制 tp，直接在目标区域采样；避免某些服务端因命令/协议断开
  // 若区块未加载，getBlockSafe 会返回 null，我们有回退逻辑

  const cz = Math.round(CORRIDOR_MAIN.z + 4 + SHIFT_Z)
  const xs = [0.1, 0.3, 0.5, 0.7, 0.9].map(
    t => Math.round(CORRIDOR_MAIN.x + t * (CORRIDOR_MAIN.w - 1) + SHIFT_X)
  )

  // 如果 bot 已经在世界里，稍等一会让附近区块加载好
  if (bot?.entity) await sleep(300)

  const samples = []
  for (const x of xs) {
    const y = highestSurfaceYAt(x, cz)
    if (Number.isFinite(y)) samples.push(y)
  }
  if (samples.length === 0) {
    // 回退策略：若已 spawn，则用“当前脚下-1”估算地面，否则沿用默认 LAYOUT_Y
    if (bot?.entity?.position) return Math.max(0, Math.floor(bot.entity.position.y - 1))
    return null
  }
  samples.sort((a, b) => a - b)
  return samples[Math.floor(samples.length / 2)]
}
// ---------- 聊天命令（保留） ----------
bot.on('chat', async (username, message)=>{
  if (!username || username === BOT_NAME) return
  const msg = message.trim().toLowerCase()
  if (msg.includes('build'))  await buildLayout()
  else if (msg.includes('spawn'))   await spawnActors()
  else if (msg.includes('patrol') || msg.includes('demo')) await startPatrol()
  else if (msg.includes('stop'))    stopPatrol()
  else if (msg === 'clearabove' || msg === 'clear' ) {
    // 清除地面以上的大范围方块（不动地面），高度到 +50，保证干净
    await Q.chatCommand(`fill ${FRAME.x1 + SHIFT_X} ${LAYOUT_Y+1} ${FRAME.z1 + SHIFT_Z} ${FRAME.x2 + SHIFT_X} ${LAYOUT_Y+50} ${FRAME.z2 + SHIFT_Z} air`, CMD_HEAVY_PAD_MS)
    bot.chat?.('已清理地面以上方块')
  }
  else if (msg === 'home' || msg === 'origin') {
    lockToOrigin(); bot.chat?.('回到原点并锁定')
  }
  else if (msg.includes('syncme'))  lockToNearestPlayer()
  else if (msg.includes('lockorigin')) lockToOrigin()
  else if (msg.includes('unlock')) unlockMovement()
  else if (msg.includes('status'))  bot.chat?.(`cleared ${doorsState.filter(d=>d.cleared).length}/${doorsState.length}, tick=${tick}`)
  else if (msg.includes('quit') || msg.includes('exit')) { stopPatrol(); bot.chat?.('再见！'); setTimeout(()=>bot.quit(), 300) }
  else bot.chat?.('我听懂：build / spawn / patrol / stop / status / quit')
})

// ---------- 终端菜单 ----------
const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
console.log('\n🧭 控制菜单：\n----------------------------------\n build   → 生成建筑布局\n spawn   → 生成村民\n patrol  → 开始巡逻\n stop    → 停止巡逻\n status  → 查看状态\n quit    → 退出程序\n----------------------------------\n')
rl.on('line', async (input)=>{
  const msg = input.trim().toLowerCase()
  if (msg === 'build')       await buildLayout()
  else if (msg === 'build?') {
    console.log('\n可选布局:')
    console.log('  1) baseline (layout/baseline.json)')
    console.log('  2) layout_1 (layout/layout_1.json)')
    console.log('  3) layout_2 (layout/layout_2.json)')
    console.log('输入编号或名称继续 (例如: 2 或 layout_1)，空回车取消')
    rl.question('选择布局: ', async ans => {
      const a = ans.trim().toLowerCase()
      if (!a) return console.log('取消。')
      const mapping = { '1':'baseline', '2':'layout_1', '3':'layout_2' }
      const chosen = mapping[a] || a
      await switchBuilding(chosen)
    })
  }
  else if (msg === 'spawn')  await spawnActors()
  else if (msg === 'patrol') await startPatrol()
  else if (msg === 'stop')   stopPatrol()
  else if (msg === 'clearabove' || msg === 'clear') {
    await Q.chatCommand(`fill ${FRAME.x1 + SHIFT_X} ${LAYOUT_Y+1} ${FRAME.z1 + SHIFT_Z} ${FRAME.x2 + SHIFT_X} ${LAYOUT_Y+50} ${FRAME.z2 + SHIFT_Z} air`, CMD_HEAVY_PAD_MS)
    console.log('🧼 已清理地面以上方块')
  }
  else if (msg === 'home' || msg === 'origin') { lockToOrigin(); console.log('🏠 回到原点并锁定') }
  else if (msg === 'syncme') lockToNearestPlayer()
  else if (msg === 'lockorigin') lockToOrigin()
  else if (msg === 'unlock') unlockMovement()
  else if (msg === 'status'){ console.log(`状态: cleared ${doorsState.filter(d=>d.cleared).length}/${doorsState.length}, tick=${tick}`) }
  else if (msg === 'quit' || msg === 'exit') { stopPatrol(); console.log('👋 Bye'); setTimeout(()=>{ rl.close(); bot.quit(); process.exit(0) }, 300) }
  else console.log('未知命令：build / spawn / patrol / stop / status / quit')
})

// —— 切换布局：重新读取 JSON，重算派生数据并执行 build —— //
async function switchBuilding(name){
  try {
    const candidates = [
      path.resolve(__dirname, 'buildings', 'configs', `${name}.json`),
      path.resolve(__dirname, '../layout', `${name}.json`)
    ]
    let loaded = null
    for (const pth of candidates){
      try {
        const raw = await fsp.readFile(pth, 'utf8')
        CONF = JSON.parse(raw)
        loaded = pth
        break
      } catch (_) {}
    }
    if (!loaded) {
      console.log(`[building] 未找到 ${name}.json，保留当前布局`) ; return
    }
    console.log(`[building] 切换到 ${name}.json -> ${path.relative(process.cwd(), loaded)}`)
    // 更新核心引用
    Object.assign(FRAME, CONF.frame)
    Object.assign(CORRIDOR_MAIN, CONF.corridor)
    // 更新房间、门等（注意不可直接重新赋值常量，这里用重新生成数组方式）
    ROOMS_TOP.splice(0, ROOMS_TOP.length, ...(CONF.rooms_top||[]))
    ROOMS_BOTTOM.splice(0, ROOMS_BOTTOM.length, ...(CONF.rooms_bottom||[]))
    // 门配置
    const doorsDef = CONF.doors || {}
    DOOR_XS.splice(0, DOOR_XS.length, ...(Array.isArray(doorsDef.xs)?doorsDef.xs:[20,52,84]))
    // 重算外墙 Z 与巡逻/出口等派生
    recomputeDerived()
    await buildLayout()
  } catch (e){
    console.log('[building] 切换失败：', e?.message || e)
  }
}