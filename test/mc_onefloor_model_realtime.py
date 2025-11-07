# filename: mc_onefloor_model_realtime.py
# Usage (命令行示例):
#   python mc_onefloor_model_realtime.py                 # 实时显示 + 默认300步
#   python mc_onefloor_model_realtime.py --steps 600     # 改步数
#   python mc_onefloor_model_realtime.py --interval 0.05 # 加速
#   python mc_onefloor_model_realtime.py --no-display    # 只跑仿真与出图，不开窗口
#   python mc_onefloor_model_realtime.py --outdir runs/v1 # 指定输出目录
#
# 输出：PNG 图（4张）+ CSV 日志（事件/轨迹/门状态），默认保存在 ./py_mc_model/
# 地图：单层平面，一条主走廊贯穿左右，两端设出口；走廊两侧各分布3间矩形房间（矩形网格布局）。

import os, json, argparse, time
from dataclasses import dataclass
from typing import Tuple, List
import numpy as np
import pandas as pd
import matplotlib.pyplot as plt

# ========== 1) 配置 ==========
@dataclass
class MCConfig:
    H: int = 15                 # 网格高度（行，y）
    W: int = 45                 # 网格宽度（列，x）
    corridor_y: int = 7         # 中央走廊所在 y
    room_xs: Tuple[int, ...] = (9, 21, 33)  # 三个房门的 x
    room_depth: int = 3         # 房间向走廊外延伸格数（矩形的“高度”）
    room_width: int = 5         # 房间的横向宽度（以门中心左右扩展），需为正整数
    exits: Tuple[int, int] = (1, 43)        # 走廊两端出口的 x
    max_steps: int = 300        # 模拟步数
    dwell_k: int = 8            # 在门口驻留 k 步视为“清理”
    n_occupants: int = 3        # occupant 数量
    seed: int = 7               # 随机种子

# ========== 2) 环境 ==========
class MCSweepEnv:
    """
    layout 编码:
      0: outside/wall
      1: corridor
      2: room
      3: exit
    """
    def __init__(self, cfg: MCConfig):
        self.cfg = cfg
        self.rng = np.random.default_rng(cfg.seed)

        # --- 生成布局 ---
        self.layout = np.zeros((cfg.H, cfg.W), dtype=np.int8)
        y = cfg.corridor_y
        self.layout[y, :] = 1  # corridor
        self.layout[y, cfg.exits[0]] = 3
        self.layout[y, cfg.exits[1]] = 3
        # 矩形房间：以每个门中心 x=rx 为中心，左右各扩展 (room_width//2)，
        #          并向上下远离走廊扩展 room_depth，形成矩形块
        half_w = max(0, int(cfg.room_width) // 2)
        for rx in cfg.room_xs:
            # 上侧房间（走廊上方）
            for d in range(1, cfg.room_depth + 1):
                yy = y - d
                if 0 <= yy < cfg.H:
                    for dx in range(-half_w, half_w + 1):
                        xx = rx + dx
                        if 0 <= xx < cfg.W:
                            self.layout[yy, xx] = 2
            # 下侧房间（走廊下方）
            for d in range(1, cfg.room_depth + 1):
                yy = y + d
                if 0 <= yy < cfg.H:
                    for dx in range(-half_w, half_w + 1):
                        xx = rx + dx
                        if 0 <= xx < cfg.W:
                            self.layout[yy, xx] = 2

        # 门口（紧邻走廊的房间格）
        self.doors: List[Tuple[int,int]] = (
            [(y-1, rx) for rx in cfg.room_xs] +  # 上侧门
            [(y+1, rx) for rx in cfg.room_xs]    # 下侧门
        )
        # 巡逻顺序：上侧从左到右 -> 下侧从右到左（夹逼）
        self.patrol: List[Tuple[int,int]] = (
            [(y-1, rx) for rx in cfg.room_xs] +
            [(y+1, rx) for rx in cfg.room_xs[::-1]]
        )
        self.reset()

    def reset(self):
        y = self.cfg.corridor_y
        self.t = 0
        # responder 从左侧出口进入
        self.responder = np.array([y, self.cfg.exits[0]], dtype=int)
        # occupants 初始在房间附近
        occ_starts = [(y-2, self.cfg.room_xs[0]),
                      (y-2, self.cfg.room_xs[-1]),
                      (y+2, self.cfg.room_xs[1])]
        self.occupants = [np.array([yy, xx], dtype=int) for (yy, xx) in occ_starts[:self.cfg.n_occupants]]

        # 每个门的清理标记（按门口索引）
        self.cleared = np.zeros(len(self.doors), dtype=np.int8)
        self.dwell = 0
        self.patrol_idx = 0

        # 日志
        self.responder_track: List[Tuple[int,int]] = []
        self.occupant_tracks: List[List[Tuple[int,int]]] = [[] for _ in self.occupants]
        self.events: List[Tuple[int,str,dict]] = []  # (t, type, detail)

    # --- 基础工具 ---
    def in_bounds(self, y, x): return 0 <= y < self.cfg.H and 0 <= x < self.cfg.W
    def is_walkable(self, y, x): return self.layout[y, x] in (1, 2, 3)

    def neighbors(self, pos):
        y, x = pos
        cand = [(y-1,x),(y+1,x),(y,x-1),(y,x+1)]
        return [(yy,xx) for (yy,xx) in cand if self.in_bounds(yy,xx) and self.is_walkable(yy,xx)]

    def nearest_exit(self, pos):
        y, x = pos
        e1 = (self.cfg.corridor_y, self.cfg.exits[0])
        e2 = (self.cfg.corridor_y, self.cfg.exits[1])
        d1 = abs(y-e1[0]) + abs(x-e1[1])
        d2 = abs(y-e2[0]) + abs(x-e2[1])
        return e1 if d1 <= d2 else e2

    def _greedy_move(self, pos, target):
        y, x = pos; ty, tx = target
        # 先沿 y 轴再沿 x 轴靠近；不可达则原地
        options = []
        if ty != y: options.append((y + int(np.sign(ty - y)), x))
        if tx != x: options.append((y, x + int(np.sign(tx - x))))
        options.append((y, x))
        for (yy, xx) in options:
            if self.in_bounds(yy, xx) and self.is_walkable(yy, xx):
                return np.array([yy, xx], dtype=int)
        return np.array([y, x], dtype=int)

    def _door_room_cell(self, door_idx):
        y, x = self.doors[door_idx]
        return (y-1, x) if y < self.cfg.corridor_y else (y+1, x)

    # --- 主 step ---
    def step(self):
        self.t += 1

        # Responder：按巡逻序列移动，在门口驻留 k 步视为清理
        tgt = self.patrol[self.patrol_idx % len(self.patrol)]
        self.responder = self._greedy_move(self.responder, tgt)
        if tuple(self.responder) == tgt:
            self.dwell += 1
            if self.dwell == 1:
                didx = self.patrol_idx % len(self.patrol)
                if self.cleared[didx] == 0:
                    self.cleared[didx] = 1
                    self.events.append((self.t, 'CLEAR', {'door_idx': int(didx),
                                                          'room_cell': self._door_room_cell(didx)}))
            if self.dwell >= self.cfg.dwell_k:
                self.patrol_idx += 1
                self.dwell = 0

        # Occupants：带犹豫的偏向出口移动
        new_occ = []
        for p in self.occupants:
            y, x = p
            ex = self.nearest_exit((y, x))
            cands = self.neighbors((y, x))
            if not cands:
                new_occ.append(p.copy())
            else:
                d0 = abs(y-ex[0]) + abs(x-ex[1])
                def gain(q): return d0 - (abs(q[0]-ex[0]) + abs(q[1]-ex[1]))
                if self.rng.random() < 0.75:
                    k = int(np.argmax([gain(q) for q in cands]))  # 往更近出口前进
                else:
                    k = int(self.rng.integers(len(cands)))        # 偶尔犹豫随机
                new_occ.append(np.array(cands[k], dtype=int))
        self.occupants = new_occ

        # 轨迹日志
        self.responder_track.append(tuple(self.responder))
        for i, p in enumerate(self.occupants):
            self.occupant_tracks[i].append(tuple(p))

    # --- 渲染辅助（Minecraft-like 配色） ---
    def render_layout_rgb(self):
        pal = {0:(0,0,0), 1:(140,140,140), 2:(220,220,220), 3:(40,160,60)}  # void/走廊/房间/出口
        img = np.zeros((self.cfg.H, self.cfg.W, 3), dtype=np.uint8)
        for v, color in pal.items():
            img[self.layout == v] = color
        # 门口涂成黄色
        for (y, x) in self.doors:
            img[y, x] = (230, 200, 40)
        return img

# ========== 3) 实时“游戏画面”显示 ==========
class LiveViewer:
    """
    用 Matplotlib 做简易“游戏窗口”：
      - 红色：Responder
      - 蓝色：Occupants
      - 右上角文字：步数、已清房数量
      - 支持按键：空格暂停/继续， +/- 调整速度
    """
    def __init__(self, env: MCSweepEnv, interval: float = 0.1):
        self.env = env
        self.interval = max(0.0, float(interval))
        self.paused = False

        self.fig, self.ax = plt.subplots(figsize=(12, 4))
        self.im = None
        self.txt = None
        self.fig.canvas.mpl_connect('key_press_event', self.on_key)

    def on_key(self, event):
        if event.key == ' ':
            self.paused = not self.paused
        elif event.key in ['+', '=']:
            self.interval = max(0.0, self.interval * 0.8)  # 加速
        elif event.key in ['-', '_']:
            self.interval = self.interval * 1.25            # 减速

    def draw_frame(self):
        img = self.env.render_layout_rgb().copy()
        # 标出 responder / occupants
        ry, rx = self.env.responder
        if 0 <= ry < self.env.cfg.H and 0 <= rx < self.env.cfg.W:
            img[ry, rx] = (255, 80, 80)  # responder: 红
        for p in self.env.occupants:
            y, x = p
            if 0 <= y < self.env.cfg.H and 0 <= x < self.env.cfg.W:
                img[y, x] = (80, 80, 255) # occupant: 蓝
        # 绘制
        if self.im is None:
            self.im = self.ax.imshow(img, origin='upper')
            self.ax.set_title("Minecraft-like One-Floor Sweep (live)")
            self.ax.set_xticks([]); self.ax.set_yticks([])
            self.txt = self.ax.text(
                0.99, 0.02,
                f"t={self.env.t} cleared={int(self.env.cleared.sum())}/{len(self.env.cleared)}  interval={self.interval:.2f}s",
                ha='right', va='bottom', transform=self.ax.transAxes
            )
        else:
            self.im.set_data(img)
            self.txt.set_text(
                f"t={self.env.t} cleared={int(self.env.cleared.sum())}/{len(self.env.cleared)}  interval={self.interval:.2f}s"
            )
        plt.pause(self.interval)

    def run(self, steps: int):
        plt.ion()
        for _ in range(steps):
            # 等待暂停
            while self.paused:
                plt.pause(0.05)
            # 先画当前帧（s=t），再推进到 s=t+1
            self.draw_frame()
            self.env.step()
        # 结束时再画一次最终帧
        self.draw_frame()
        plt.ioff()
        plt.show(block=False)

# ========== 4) 批量出图 & 导出日志 ==========
def export_figs_and_logs(env: MCSweepEnv, outdir: str):
    os.makedirs(outdir, exist_ok=True)

    # CSV 日志
    pd.DataFrame(env.responder_track, columns=["y","x"]).to_csv(f"{outdir}/responder_track.csv", index=False)
    for i, tr in enumerate(env.occupant_tracks):
        pd.DataFrame(tr, columns=["y","x"]).to_csv(f"{outdir}/occupant_{i}_track.csv", index=False)
    pd.DataFrame([
        {"door_idx": i, "door_y": env.doors[i][0], "door_x": env.doors[i][1], "cleared": int(env.cleared[i])}
        for i in range(len(env.doors))
    ]).to_csv(f"{outdir}/doors.csv", index=False)
    ev_df = pd.DataFrame([{"t":t, "type":typ, "detail":json.dumps(det)} for (t,typ,det) in env.events])
    if len(ev_df)==0: ev_df = pd.DataFrame(columns=["t","type","detail"])
    ev_df.to_csv(f"{outdir}/events.csv", index=False)

    # 图1：顶视布局
    layout_rgb = env.render_layout_rgb()
    plt.figure(figsize=(12,4), dpi=150)
    plt.imshow(layout_rgb, origin="upper"); plt.axis("off")
    plt.title("Top-down Layout (Minecraft-like colors)")
    plt.tight_layout(); plt.savefig(f"{outdir}/01_layout_rgb.png"); plt.close()

    # 图2：轨迹叠加 + 已清房间
    plt.figure(figsize=(12,4), dpi=150)
    plt.imshow(layout_rgb, origin="upper")
    rp = np.array(env.responder_track)
    if len(rp) > 0:
        plt.plot(rp[:,1], rp[:,0], linewidth=2.0)
        plt.scatter(rp[0,1], rp[0,0], s=30)
    for tr in env.occupant_tracks:
        p = np.array(tr)
        if len(p) > 0:
            plt.plot(p[:,1], p[:,0], linewidth=1.5)
            plt.scatter(p[0,1], p[0,0], s=20)
    for i in range(len(env.doors)):
        if env.cleared[i]:
            ry, rx = env._door_room_cell(i)
            plt.scatter([rx],[ry], marker="s", s=60)
    plt.axis("off")
    plt.title("Trajectories & Cleared Rooms (top-down)")
    plt.tight_layout(); plt.savefig(f"{outdir}/02_traj_cleared.png"); plt.close()

    # 图3：清理进度曲线（按事件重建）
    t_axis = np.arange(max(1, len(env.responder_track)))
    cleared_over_time = np.zeros_like(t_axis)
    cleared_set = set(); idx = 0
    for t in range(len(t_axis)):
        while idx < len(env.events) and env.events[idx][0] <= t:
            cleared_set.add(env.events[idx][2]["door_idx"]); idx += 1
        cleared_over_time[t] = len(cleared_set)
    plt.figure(figsize=(7,3), dpi=150)
    plt.plot(t_axis, cleared_over_time)
    plt.xlabel("Step"); plt.ylabel("#Rooms Cleared")
    plt.title("Rooms Cleared Over Time")
    plt.tight_layout(); plt.savefig(f"{outdir}/03_cleared_over_time.png"); plt.close()

    # 图4：访问热力图（Responder×2 权重）
    visit = np.zeros((env.cfg.H, env.cfg.W), dtype=float)
    for (y,x) in env.responder_track: visit[y,x] += 2.0
    for tr in env.occupant_tracks:
        for (y,x) in tr: visit[y,x] += 1.0
    plt.figure(figsize=(12,4), dpi=150)
    plt.imshow(visit, origin="upper"); plt.colorbar(shrink=0.7); plt.axis("off")
    plt.title("Visit Heatmap (Responder weighted x2)")
    plt.tight_layout(); plt.savefig(f"{outdir}/04_visit_heatmap.png"); plt.close()

# ========== 5) 主入口 ==========
def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--steps', type=int, default=MCConfig.max_steps, help='仿真步数（默认300）')
    parser.add_argument('--interval', type=float, default=0.1, help='实时显示每步暂停秒数（默认0.1s）')
    parser.add_argument('--no-display', action='store_true', help='不打开实时窗口，只跑仿真与出图')
    parser.add_argument('--outdir', type=str, default='py_mc_model', help='输出目录')
    args = parser.parse_args()

    cfg = MCConfig(max_steps=args.steps)
    env = MCSweepEnv(cfg)

    if args.no_display:
        # 只仿真，不显示
        for _ in range(cfg.max_steps):
            env.step()
    else:
        # 实时“游戏画面”
        viewer = LiveViewer(env, interval=args.interval)
        viewer.run(cfg.max_steps)

    # 导出图与日志
    export_figs_and_logs(env, args.outdir)

    print("Saved to:", os.path.abspath(args.outdir))
    for f in ["01_layout_rgb.png","02_traj_cleared.png","03_cleared_over_time.png",
              "04_visit_heatmap.png","responder_track.csv","occupant_0_track.csv",
              "occupant_1_track.csv","occupant_2_track.csv","doors.csv","events.csv"]:
        print(" -", os.path.join(args.outdir, f))

if __name__ == "__main__":
    main()