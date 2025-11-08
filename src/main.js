// filename: baseline.mjs
// 终端菜单：clean / build / occupants / spawn / patrol / stop / status / quit
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

// ------- PlaceTracker：记录“放过什么块/区域”，以便精准清理 ------- //
class PlaceTracker {
  constructor() {
    this.boxes = []   // {x1,y1,z1,x2,y2,z2, block}
    this.single = []  // {x,y,z, block}
  }
  static norm(x1,y1,z1,x2,y2,z2){
    return {
      x1: Math.min(x1,x2), y1: Math.min(y1,y2), z1: Math.min(z1,z2),
      x2: Math.max(x1,x2), y2: Math.max(y1,y2), z2: Math.max(z1,z2)
    }
  }
  recordFill(x1,y1,z1,x2,y2,z2, block){
    this.boxes.push({...PlaceTracker.norm(x1,y1,z1,x2,y2,z2), block})
  }
  recordSet(x,y,z, block){ this.single.push({x,y,z, block}) }
  async clearAll(Q){
    for (const b of this.boxes) {
      await Q.chatCommand(`fill ${b.x1} ${b.y1} ${b.z1} ${b.x2} ${b.y2} ${b.z2} air`, CMD_HEAVY_PAD_MS)
    }
    for (const s of this.single) {
      await Q.chatCommand(`setblock ${s.x} ${s.y} ${s.z} air`, 200)
    }
    this.boxes.length = 0
    this.single.length = 0
  }
}
const PT = new PlaceTracker()

// —— worldborder 以原点为中心 —— //
function frameCenter(){
  return { cx: 0, cz: 0 }
}
async function applyWorldBorder(padding = 16){
  const {cx, cz} = frameCenter()
  // 以 FRAME 的最大边 + padding 作为直径
  const w = FRAME.x2 - FRAME.x1 + 1 + padding*2
  const h = FRAME.z2 - FRAME.z1 + 1 + padding*2
  const size = Math.max(w, h)
  await Q.chatCommand(`worldborder center ${cx} ${cz}`, 400)
  await Q.chatCommand(`worldborder set ${size}`, 400)
  await Q.chatCommand(`worldborder damage buffer 0`, 200)
  await Q.chatCommand(`worldborder warning distance 2`, 200)
  console.log(`🧱 WorldBorder 已设置：中心(${cx},${cz})，直径≈${size}`)
}

// ---------- 参数 ----------
const BOT_NAME = 'sweeper'
const HOST = '127.0.0.1'
const PORT = 25565

// 节流（如仍被踢，把 600 调到 800 / 1000）
const CMD_DELAY_MS = Number(process.env.CMD_DELAY_MS || 600)
const CMD_HEAVY_PAD_MS = Number(process.env.CMD_HEAVY_PAD_MS || 900)

// —— 地面基准（贴地）：默认 y=4 —— //
const Y = 4
const BUILD_OFFSET = 0
let LAYOUT_Y = Y + BUILD_OFFSET

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
    exit_marker: 'green_wool',
    occupants: { num: 5 }
  }
}
const FRAME          = CONF.frame
const CORRIDOR_MAIN  = CONF.corridor  // 一条走廊（例如 z:16..23）

// —— 坐标偏移：把 FRAME 左下角贴到世界原点(0,0) —— //
const SHIFT_X = -FRAME.x1
const SHIFT_Z = -FRAME.z1

// —— 建筑内部“同步点”：默认原点，后续根据布局动态调整到“走廊中心的可站立空间” —— //
let SPAWN_X = 0
let SPAWN_Z = 0
let SPAWN_Y = LAYOUT_Y + 1

// 房间来自配置
const ROOMS_TOP = [...(CONF.rooms_top || [])]
const ROOMS_BOTTOM = [...(CONF.rooms_bottom || [])]

// 门配置（在与走廊外墙相接处开门）
const DOOR_XS = Array.isArray(CONF.doors?.xs) ? [...CONF.doors.xs] : [20, 52, 84]
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
  { x: CORRIDOR_MAIN.x + SHIFT_X,                       y: LAYOUT_Y, z: CORRIDOR_MAIN.z + Math.floor((CORRIDOR_MAIN.h||1)/2) + SHIFT_Z },
  { x: CORRIDOR_MAIN.x + (CORRIDOR_MAIN.w||1) - 1 + SHIFT_X, y: LAYOUT_Y, z: CORRIDOR_MAIN.z + Math.floor((CORRIDOR_MAIN.h||1)/2) + SHIFT_Z },
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
  if (typeof bot?.chat === 'function') {
    try { bot.chat(line); return } catch (_) {}
  }
  try {
    bot?._client?.write('chat_message', { message: line })
    return
  } catch (_) {}
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
let doorsState = []
const Q = new CommandQueue(bot)

// 锁定与同步控制
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

// —— datapack —— //
const DP_ROOT = path.resolve(WORLD_DIR, 'datapacks', 'force_origin')
async function ensureDatapack(){
  if (!USE_DATAPACK) {
    console.log('[datapack] 已禁用（USE_DATAPACK=0），跳过写入 world')
    return
  }
  const files = [
    { p: path.join(DP_ROOT, 'pack.mcmeta'),
      c: '{\n  "pack": {\n    "pack_format": 15,\n    "description": "Force origin spawn; mob-free via gamerules; player creative"\n  }\n}\n',
      overwrite: true
    },
    { p: path.join(DP_ROOT, 'data/minecraft/tags/functions/load.json'),
      c: '{\n  "values": [\n    "force_origin:load"\n  ]\n}\n',
      overwrite: true
    },
    { p: path.join(DP_ROOT, 'data/minecraft/tags/functions/tick.json'),
      c: '{\n  "values": [\n    "force_origin:tick"\n  ]\n}\n',
      overwrite: true
    },

    // —— 世界初始化：用 gamerule/难度 来禁止自然刷新和巡逻/商人/幻翼/袭击 —— //
    { p: path.join(DP_ROOT, 'data/force_origin/functions/load.mcfunction'),
      c: `scoreboard objectives add joined dummy
setworldspawn ${SPAWN_X} ${SPAWN_Y} ${SPAWN_Z}

# 不生成生物/怪物（包含被动/敌对的自然刷新）
difficulty peaceful
gamerule doMobSpawning false

# 禁止巡逻队、流浪商人、幻翼、袭击等特殊刷新/事件
gamerule doPatrolSpawning false
gamerule doTraderSpawning false
gamerule doInsomnia false
gamerule disableRaids true

# 其余环境与可视稳定
gamerule doDaylightCycle false
gamerule doWeatherCycle false
time set day
weather clear 1000000
gamerule spawnRadius 0

# 标记已有玩家为 joined=1，避免首次 tick 触发传送
execute as @a run scoreboard players set @s joined 1
`,
      overwrite: true
    },

    // —— 每 tick：只做玩家初始化与环境维持，不做任何 kill —— //
    { p: path.join(DP_ROOT, 'data/force_origin/functions/tick.mcfunction'),
      c: `execute as @a[scores={joined=0}] at @s run tp @s ${SPAWN_X} ${SPAWN_Y} ${SPAWN_Z}
execute as @a[scores={joined=0}] run scoreboard players set @s joined 1

gamemode creative @a
# 不再有任何 kill 行为；世界由 gamerule 控制不刷新生物/怪物
`,
      overwrite: true
    }
  ]

  for (const f of files){
    await fsp.mkdir(path.dirname(f.p), { recursive: true })
    await fsp.writeFile(f.p, f.c)
  }
  console.log('[datapack] 写入完成（基于 gamerule 的无生物/怪物世界，已禁用 kill）')
}

// 输出日志目录
const OUT = path.resolve(__dirname, '../log')
async function ensureOut(){
  await fsp.mkdir(OUT, { recursive: true })
  await fsp.writeFile(path.join(OUT,'events.csv'), 't,event,detail\n')
  await fsp.writeFile(path.join(OUT,'responder_track.csv'), 't,x,y,z\n')
  await fsp.writeFile(path.join(OUT,'villagers_track.csv'), 't,id,x,y,z\n')
  const doorHeader = 'door_idx,x,y,z,cleared,cleared_tick\n'
  doorsState = DOOR_POS.map((p,i)=>({idx:i, x:p.x, y:p.y, z:p.z, cleared:false, cleared_tick:-1}))
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

    const NON_BOT = `@a[name=!${BOT_NAME}]`
    await Q.chatCommand(`gamemode creative ${NON_BOT}`, 800)
    await Q.chatCommand('difficulty peaceful', 800)
    await Q.chatCommand('gamerule doMobSpawning false', 800)
    await Q.chatCommand('gamerule doDaylightCycle false', 800)
    await Q.chatCommand('time set day', 800)
    await Q.chatCommand('gamerule doWeatherCycle false', 800)
    await Q.chatCommand('weather clear 1000000', 800)
  if (USE_DATAPACK) await Q.chatCommand('reload', 800)

  // 将所有玩家（含 bot）传送到内部同步点，一次性对齐环境
  await Q.chatCommand(`setworldspawn ${SPAWN_X} ${SPAWN_Y} ${SPAWN_Z}`, 400)
  await Q.chatCommand(`tp @a ${SPAWN_X} ${SPAWN_Y} ${SPAWN_Z}`, 800)

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

    console.log('✅ bot 已上线。终端菜单：clean / build / occupants / spawn / patrol / stop / status / quit')
  } catch (e) {
    console.log('spawn init error:', e)
  }
})
bot.on('kicked', r => { console.log('[KICKED]', r); if (demoTimer) clearInterval(demoTimer) })
bot.on('end',    r => { console.log('[END]',    r); if (demoTimer) clearInterval(demoTimer) })

function here(){ return bot.entity?.position?.clone() || new Vec3(0,0,0) }

// —— 判定/寻找可安全站立的位置（两格高空气，上方不碰撞） —— //
function isAirName(name){ return name === 'air' }
function isPassableBlockName(name){
  if (!name) return false
  // 保守：仅当空气才认为可站立空间，避免卡在非完整方块（如草丛）
  return name === 'air'
}
function canStandAt(x, y, z){
  const below = getBlockSafe(x, y - 1, z)
  const head  = getBlockSafe(x, y, z)
  const top   = getBlockSafe(x, y + 1, z)
  if (!below || !head || !top) return false
  const belowSolid = (below.name && below.name !== 'air' && !below.name.includes('water') && !below.name.includes('lava'))
  return belowSolid && isPassableBlockName(head.name) && isPassableBlockName(top.name)
}
function corridorCenterPos(){
  const cx = (CORRIDOR_MAIN?.x ?? 0) + SHIFT_X + Math.floor(((CORRIDOR_MAIN?.w || 1) - 1) / 2)
  const cz = (CORRIDOR_MAIN?.z ?? 0) + SHIFT_Z + Math.floor(((CORRIDOR_MAIN?.h || 1) - 1) / 2)
  return { x: cx, y: LAYOUT_Y + 1, z: cz }
}
function* spiralOffsets(maxR = 6){
  yield [0,0]
  for (let r = 1; r <= maxR; r++){
    for (let dx = -r; dx <= r; dx++){
      yield [dx, -r]
      yield [dx,  r]
    }
    for (let dz = -r + 1; dz <= r - 1; dz++){
      yield [-r, dz]
      yield [ r, dz]
    }
  }
}
function clamp(v, a, b){ return Math.max(a, Math.min(b, v)) }
function inRect(x, z, rect){
  const x1 = rect.x + SHIFT_X, z1 = rect.z + SHIFT_Z
  const x2 = rect.x + rect.w - 1 + SHIFT_X
  const z2 = rect.z + rect.h - 1 + SHIFT_Z
  return x >= x1 && x <= x2 && z >= z1 && z <= z2
}
function findSafeSpotNearCorridor(base, maxR = 8){
  // 在主走廊矩形内优先寻找；否则在相邻位置寻找
  for (const [dx, dz] of spiralOffsets(maxR)){
    const x = base.x + dx
    const z = base.z + dz
    if (CORRIDOR_MAIN && (CORRIDOR_MAIN.w||0) > 0 && (CORRIDOR_MAIN.h||0) > 0){
      if (!inRect(x, z, CORRIDOR_MAIN)) continue
    }
    const y = LAYOUT_Y + 1
    if (canStandAt(x, y, z)) return { x, y, z }
  }
  // 兜底：在 FRAME 区域内做一次较小范围搜索
  const rect = { x: FRAME.x1, z: FRAME.z1, w: FRAME.x2 - FRAME.x1 + 1, h: FRAME.z2 - FRAME.z1 + 1 }
  for (const [dx, dz] of spiralOffsets(maxR + 4)){
    const x = clamp(base.x + dx, FRAME.x1 + SHIFT_X, FRAME.x2 + SHIFT_X)
    const z = clamp(base.z + dz, FRAME.z1 + SHIFT_Z, FRAME.z2 + SHIFT_Z)
    const y = LAYOUT_Y + 1
    if (canStandAt(x, y, z)) return { x, y, z }
  }
  return null
}
function updateSpawn(pos){
  if (!pos) return
  SPAWN_X = pos.x; SPAWN_Y = pos.y; SPAWN_Z = pos.z
}

// —— 极简填充：不画黑边，只保留主体块 —— //
async function fillRect(rect, block){
  const x1 = rect.x + SHIFT_X
  const z1 = rect.z + SHIFT_Z
  const x2 = rect.x + rect.w - 1 + SHIFT_X
  const z2 = rect.z + rect.h - 1 + SHIFT_Z
  const y  = LAYOUT_Y
  await Q.chatCommand(`fill ${x1} ${y} ${z1} ${x2} ${y} ${z2} ${block}`)
  PT.recordFill(x1, y, z1, x2, y, z2, block)
}

// 在矩形四周砌墙，高度为 height（默认3），不封顶
async function buildWalls(rect, material = 'white_concrete', height = 3){
  const x1 = rect.x + SHIFT_X
  const z1 = rect.z + SHIFT_Z
  const x2 = rect.x + rect.w - 1 + SHIFT_X
  const z2 = rect.z + rect.h - 1 + SHIFT_Z
  const y1 = LAYOUT_Y + 1
  const y2 = LAYOUT_Y + height
  const cmds = [
    {a:[x1,y1,z1, x2,y2,z1]},
    {a:[x1,y1,z2, x2,y2,z2]},
    {a:[x1,y1,z1, x1,y2,z2]},
    {a:[x2,y1,z1, x2,y2,z2]},
  ]
  for (const {a} of cmds){
    await Q.chatCommand(`fill ${a[0]} ${a[1]} ${a[2]} ${a[3]} ${a[4]} ${a[5]} ${material}`)
    PT.recordFill(a[0],a[1],a[2], a[3],a[4],a[5], material)
  }
}

// —— 门（打穿墙体） —— //
const DOOR_WIDTH   = 1
const DOOR_HEIGHT  = 2
const DOOR_PAD_MS  = 200
async function carveVerticalDoor(x, z, height = DOOR_HEIGHT, width = DOOR_WIDTH) {
  const y1 = LAYOUT_Y + 1
  const y2 = LAYOUT_Y + height
  const xl = x - Math.floor((width - 1) / 2)
  const xr = x + Math.floor(width / 2)
  await Q.chatCommand(`fill ${xl} ${y1} ${z} ${xr} ${y2} ${z} air`, DOOR_PAD_MS)
}
async function carveAllDoors() {
  for (const x of DOOR_XS) await carveVerticalDoor(x + SHIFT_X, TOP_WALL_Z)
  for (const x of DOOR_XS) await carveVerticalDoor(x + SHIFT_X, BOT_WALL_Z)
}

// —— 清理&地面恢复（clean） —— //
async function clearVerticalSlice(x1, x2, z1, z2, startY){
  const top = (bot?.game?.height && Number.isFinite(bot.game.height)) ? bot.game.height - 1 : 255
  const area = (x2 - x1 + 1) * (z2 - z1 + 1)
  const maxH = Math.max(1, Math.floor(32768 / Math.max(1, area))) // fill 上限保护
  let y = Math.max(0, startY)
  while (y <= top){
    const yEnd = Math.min(top, y + maxH - 1)
    await Q.chatCommand(`fill ${x1} ${y} ${z1} ${x2} ${yEnd} ${z2} air`, CMD_HEAVY_PAD_MS)
    y = yEnd + 1
  }
}
async function cleanMap(){
  console.log('🧹 clean：精准清理 + 恢复地表')
  await Q.chatCommand('difficulty peaceful', 400)
  await Q.chatCommand('gamerule doMobSpawning false', 400)
  await Q.chatCommand('gamerule doDaylightCycle false', 400)
  await Q.chatCommand('time set day', 400)
  await Q.chatCommand('gamerule doWeatherCycle false', 400)
  await Q.chatCommand('weather clear 1000000', 400)
  await Q.chatCommand('gamemode creative @a', 400)
  // 不再 kill 生物；只清理临时掉落物/投射物/经验球，保留所有村民与玩家
  const ephemeral = ['item','arrow','experience_orb','firework_rocket','tnt','falling_block','boat','chest_boat','minecart','tnt_minecart','furnace_minecart','hopper_minecart','chest_minecart','painting','item_frame','glow_item_frame','armor_stand']
  for (const t of ephemeral) {
    await Q.chatCommand(`kill @e[type=${t}]`, 150)
  }

  // 仅清理“曾经放过”的结构
  await PT.clearAll(Q)

  // 把实验框架 FRAME 的地面层刷回草（一层）
  const x1 = FRAME.x1 + SHIFT_X, x2 = FRAME.x2 + SHIFT_X
  const z1 = FRAME.z1 + SHIFT_Z, z2 = FRAME.z2 + SHIFT_Z
  await Q.chatCommand(`fill ${x1} ${LAYOUT_Y} ${z1} ${x2} ${LAYOUT_Y} ${z2} grass_block`, CMD_HEAVY_PAD_MS)
  PT.recordFill(x1, LAYOUT_Y, z1, x2, LAYOUT_Y, z2, 'grass_block')

  await Q.chatCommand(`setworldspawn ${SPAWN_X} ${SPAWN_Y} ${SPAWN_Z}`, 300)
  console.log('✅ clean 完成（未 kill 任何生物）')
}

// —— 构建布局（build） —— //
async function buildLayout(){
  console.log('🧱 build：按 layout 在固定高度搭建')
  ev('BUILD_BEGIN', {})

  // 铺走廊
  if ((CORRIDOR_MAIN?.w ?? 0) > 0 && (CORRIDOR_MAIN?.h ?? 0) > 0) {
    await fillRect(CORRIDOR_MAIN,  CONF.corridor_floor || 'white_concrete')
  }

  // 房间地面 + 墙
  for (const r of ROOMS_TOP){
    await fillRect(r, r.block || 'white_concrete')
    await buildWalls(r, CONF.wall?.material || 'white_concrete', CONF.wall?.height || 3)
  }
  for (const r of ROOMS_BOTTOM){
    await fillRect(r, r.block || 'white_concrete')
    await buildWalls(r, CONF.wall?.material || 'white_concrete', CONF.wall?.height || 3)
  }

  // 开门
  await carveAllDoors()

  // 出口标记（若走廊有效）
  if ((CORRIDOR_MAIN?.w ?? 0) > 0 && (CORRIDOR_MAIN?.h ?? 0) > 0) {
    for (const ex of EXITS){
      await Q.chatCommand(`setblock ${ex.x} ${LAYOUT_Y} ${ex.z} ${CONF.exit_marker || 'green_wool'}`)
      PT.recordSet(ex.x, LAYOUT_Y, ex.z, CONF.exit_marker || 'green_wool')
    }
  }

  // 选择一个走廊内“可站立”的安全点作为新的内部同步点，并传送过去
  let base = corridorCenterPos()
  let safe = findSafeSpotNearCorridor(base, 8)
  if (!safe) {
    // 若仍未找到，退回原点上方 2 格尝试（极端兜底）
    safe = { x: SPAWN_X, y: LAYOUT_Y + 2, z: SPAWN_Z }
  }
  updateSpawn(safe)
  await Q.chatCommand(`setworldspawn ${SPAWN_X} ${SPAWN_Y} ${SPAWN_Z}`, 400)
  await Q.chatCommand(`tp ${SPAWN_X} ${SPAWN_Y} ${SPAWN_Z}`, 500)
  ev('BUILD_DONE')
  console.log('✅ build 完成（固定高度，无抬高，原点贴齐）')
}

// —— occupants：按房间随机放置 occupants（villager） —— //
function randInt(a, b){ return Math.floor(Math.random() * (b - a + 1)) + a }
function* randomPointsInRoom(room, n){
  const xMin = room.x + 1 + SHIFT_X
  const xMax = room.x + room.w - 2 + SHIFT_X
  const zMin = room.z + 1 + SHIFT_Z
  const zMax = room.z + room.h - 2 + SHIFT_Z
  for (let i=0; i<n; i++){
    yield { x: randInt(xMin, xMax), y: LAYOUT_Y, z: randInt(zMin, zMax) }
  }
}
async function spawnOccupants(){
  const nPerRoom = Number(CONF?.occupants?.num ?? CONF?.occupants?.per_room ?? 5)
  if (!Number.isFinite(nPerRoom) || nPerRoom <= 0) {
    console.log('👥 occupants.num 无效，跳过生成'); return
  }
  console.log(`👥 occupants：每房目标 ${nPerRoom}，仅补足缺口，不 kill 现有村民`)
  const rooms = [...ROOMS_TOP, ...ROOMS_BOTTOM]
  const villEntities = Object.values(bot.entities).filter(e => e.name === 'villager')
  let totalAdded = 0
  for (const room of rooms){
    const x1 = room.x + SHIFT_X, x2 = room.x + room.w - 1 + SHIFT_X
    const z1 = room.z + SHIFT_Z, z2 = room.z + room.h - 1 + SHIFT_Z
    const existing = villEntities.filter(v => {
      const p = v.position
      return p.x >= x1+1 && p.x <= x2-1 && p.z >= z1+1 && p.z <= z2-1 && Math.abs(p.y - LAYOUT_Y) <= 1
    }).length
    const need = Math.max(0, nPerRoom - existing)
    let placed = 0
    for (const p of randomPointsInRoom(room, need)){
      await Q.chatCommand(`summon villager ${p.x} ${p.y} ${p.z} {Tags:["keep"]}`, 500)
      placed += 1; totalAdded += 1
    }
    console.log(`  - 房间(${room.x},${room.z},${room.w}x${room.h}) 已有 ${existing}，新增 ${placed} → 目标 ${nPerRoom}`)
  }
  console.log(`✅ occupants 完成，总新增 ${totalAdded}（无 kill）`)
}

// —— demo 巡逻（保留） —— //
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
  }, 300)
}
function stopPatrol(){
  if (demoTimer) clearInterval(demoTimer)
  demoTimer = null
  ev('DEMO_STOP'); console.log('⏹️ 巡逻结束')
}

// —— 如果禁用 datapack，用事件兜底 —— //
if (!USE_DATAPACK) {
  bot.on('playerJoined', (p) => {
    if (!p?.username || p.username === BOT_NAME) return
    Q.chatCommand(`gamemode creative ${p.username}`, 500)
    Q.chatCommand(`tp ${p.username} ${SPAWN_X} ${SPAWN_Y} ${SPAWN_Z}`, 700)
  })
  setInterval(() => {
    Q.chatCommand('time set day', 500)
    Q.chatCommand('weather clear 1000000', 500)
  }, 15000)
}

// —— 派生数据重算 —— //
function recomputeDerived() {
  SPAWN_Y = LAYOUT_Y + 1
  DOOR_POS = [
    ...DOOR_XS.map(x => ({ x: x + SHIFT_X, y: LAYOUT_Y, z: TOP_DOOR_Z_CORRIDOR })),
    ...DOOR_XS.map(x => ({ x: x + SHIFT_X, y: LAYOUT_Y, z: BOT_DOOR_Z_CORRIDOR })),
  ]
  PATROL = [...DOOR_POS]
  EXITS = [
    { x: (CORRIDOR_MAIN.x ?? 0) + SHIFT_X, y: LAYOUT_Y, z: (CORRIDOR_MAIN.z ?? 0) + Math.floor((CORRIDOR_MAIN.h||1)/2) + SHIFT_Z },
    { x: (CORRIDOR_MAIN.x ?? 0) + (CORRIDOR_MAIN.w||1) - 1 + SHIFT_X, y: LAYOUT_Y, z: (CORRIDOR_MAIN.z ?? 0) + Math.floor((CORRIDOR_MAIN.h||1)/2) + SHIFT_Z },
  ]
}
recomputeDerived()

// —— 地面探测（保留，默认关闭自动贴地） —— //
const AUTO_GROUND = false
function getBlockSafe(x, y, z) {
  try {
    if (bot?.world?.getBlock) return bot.world.getBlock(new Vec3(x, y, z))
    if (typeof bot?.blockAt === 'function') return bot.blockAt(new Vec3(x, y, z))
  } catch (_) {}
  return null
}
function highestSurfaceYAt(x, z) {
  if (!bot?.world && typeof bot?.blockAt !== 'function') return null
  const yMax = (bot?.game?.height && Number.isFinite(bot.game.height)) ? bot.game.height - 1 : 255
  for (let y = yMax; y >= 0; y--) {
    const b = getBlockSafe(x, y, z)
    if (!b) continue
    const name = b.name || ''
    if (name !== 'air' && !name.includes('water') && !name.includes('lava')) return y + 1
  }
  return null
}
async function detectGroundYNearCorridor() {
  const cz = Math.round((CORRIDOR_MAIN.z ?? 0) + Math.floor((CORRIDOR_MAIN.h||1)/2) + SHIFT_Z)
  const xs = [0.1, 0.3, 0.5, 0.7, 0.9].map(
    t => Math.round((CORRIDOR_MAIN.x ?? 0) + t * ((CORRIDOR_MAIN.w || 1) - 1) + SHIFT_X)
  )
  if (bot?.entity) await sleep(300)
  const samples = []
  for (const x of xs) {
    const y = highestSurfaceYAt(x, cz)
    if (Number.isFinite(y)) samples.push(y)
  }
  if (samples.length === 0) {
    if (bot?.entity?.position) return Math.max(0, Math.floor(bot.entity.position.y - 1))
    return null
  }
  samples.sort((a, b) => a - b)
  return samples[Math.floor(samples.length / 2)]
}

// ---------- 聊天命令 ----------
bot.on('chat', async (username, message)=>{
  if (!username || username === BOT_NAME) return
  const msg = message.trim().toLowerCase()
  if (msg === 'clean')        await cleanMap()
  else if (msg === 'build')   await buildLayout()
  else if (msg === 'occupants') await spawnOccupants()
  else if (msg.includes('patrol') || msg.includes('demo')) await startPatrol()
  else if (msg === 'stop')    stopPatrol()
  else if (msg === 'status')  bot.chat?.(`cleared ${doorsState.filter(d=>d.cleared).length}/${doorsState.length}, tick=${tick}`)
  else if (msg === 'home' || msg === 'origin') { lockToOrigin(); bot.chat?.('回到原点并锁定') }
  else if (msg.includes('unlock')) unlockMovement()
  else if (msg.includes('quit') || msg.includes('exit')) { stopPatrol(); bot.chat?.('再见！'); setTimeout(()=>bot.quit(), 300) }
  else if (msg === 'border') { await applyWorldBorder(16); bot.chat?.('WorldBorder set.') }
  else bot.chat?.('我听懂：clean / build / occupants / spawn / patrol / stop / status / quit')
})

// ---------- 终端菜单 ----------
const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
console.log('\n🧭 控制菜单：\n----------------------------------\n clean      → 清空并初始化环境（仅清临时实体）\n build      → 生成/重建布局\n occupants  → 按房间补足村民，不移除现有\n patrol     → 开始巡逻\n stop       → 停止巡逻\n status     → 查看门清理进度\n quit       → 退出程序\n----------------------------------\n')
rl.on('line', async (input)=>{
  const msg = input.trim().toLowerCase()
  if (msg === 'clean')        await cleanMap()
  else if (msg === 'build')   await buildLayout()
  else if (msg === 'occupants') await spawnOccupants()
  else if (msg === 'patrol')  await startPatrol()
  else if (msg === 'stop')    stopPatrol()
  else if (msg === 'status'){ console.log(`状态: cleared ${doorsState.filter(d=>d.cleared).length}/${doorsState.length}, tick=${tick}`) }
  else if (msg === 'quit' || msg === 'exit') { stopPatrol(); console.log('👋 Bye'); setTimeout(()=>{ rl.close(); bot.quit(); process.exit(0) }, 300) }
  else if (msg === 'border') { await applyWorldBorder(16) }
  else console.log('未知命令：clean / build / occupants / spawn / patrol / stop / status / quit')
})

