#!/usr/bin/env python3
"""生成插件图标（16/48/128 PNG），无需第三方库。
Generate extension icons (16/48/128 PNG) with no third-party dependencies.

图标样式：微信绿圆角方块背景 + 白色 "MD" 文字（像素字体绘制）。
Icon style: WeChat-green rounded square with a white "MD" glyph (pixel font).

License: MIT — see ../LICENSE
"""
import struct
import zlib
import os

GREEN = (7, 193, 96, 255)      # 微信绿
GREEN_DARK = (5, 150, 75, 255)  # 底边微暗
WHITE = (255, 255, 255, 255)
TRANSPARENT = (0, 0, 0, 0)


def rounded_rect_alpha(x, y, w, h, r):
    """返回 (x,y) 处是否在圆角矩形内（含抗锯齿权重 0~1）。"""
    if x < 0 or y < 0 or x >= w or y >= h:
        return 0.0
    # 圆角区域检测
    cx = min(max(x, r), w - 1 - r)
    cy = min(max(y, r), h - 1 - r)
    dx = abs(x - cx)
    dy = abs(y - cy)
    dist = (dx * dx + dy * dy) ** 0.5
    if dist <= r - 0.5:
        return 1.0
    if dist <= r + 0.5:
        return max(0.0, r + 0.5 - dist)
    return 0.0


# 5x7 像素字体：M 和 D
FONT_M = [
    "X...X",
    "XX.XX",
    "X.X.X",
    "X.X.X",
    "X.X.X",
    "X.X.X",
    "X.X.X",
]
FONT_D = [
    "XXXX.",
    "X...X",
    "X...X",
    "X...X",
    "X...X",
    "X...X",
    "XXXX.",
]


def draw_glyph(pixels, size, glyph, ox, oy, cell, color):
    for gy, row in enumerate(glyph):
        for gx, ch in enumerate(row):
            if ch != 'X':
                continue
            # 每个字体像素画成 cell x cell 的实心块
            for py in range(cell):
                for px in range(cell):
                    X = ox + gx * cell + px
                    Y = oy + gy * cell + py
                    if 0 <= X < size and 0 <= Y < size:
                        pixels[Y][X] = color


def make_icon(size):
    pixels = [[TRANSPARENT] * size for _ in range(size)]
    r = max(2, round(size * 0.20))

    # 背景圆角矩形
    for y in range(size):
        for x in range(size):
            a = rounded_rect_alpha(x, y, size, size, r)
            if a <= 0:
                continue
            base = GREEN if y < size - max(1, size // 12) else GREEN_DARK
            if a >= 1.0:
                pixels[y][x] = base
            else:
                pixels[y][x] = tuple(int(c * a) for c in base[:3]) + (int(255 * a),)

    # 文字 "MD"：5 列 M + 5 列 D，中间空 1 列 → 总宽 11 个字体像素
    cell = max(1, round(size / 16))            # 每个字体像素的边长
    glyph_w = 11 * cell
    glyph_h = 7 * cell
    ox = (size - glyph_w) // 2
    oy = (size - glyph_h) // 2
    draw_glyph(pixels, size, FONT_M, ox, oy, cell, WHITE)
    draw_glyph(pixels, size, FONT_D, ox + 6 * cell, oy, cell, WHITE)

    return pixels


def write_png(path, pixels):
    size = len(pixels)
    raw = b''.join(b'\x00' + b''.join(struct.pack('4B', *px) for px in row) for row in pixels)

    def chunk(tag, data):
        c = struct.pack('>I', len(data)) + tag + data
        return c + struct.pack('>I', zlib.crc32(tag + data) & 0xffffffff)

    png = b'\x89PNG\r\n\x1a\n'
    png += chunk(b'IHDR', struct.pack('>IIBBBBB', size, size, 8, 6, 0, 0, 0))
    png += chunk(b'IDAT', zlib.compress(raw, 9))
    png += chunk(b'IEND', b'')
    with open(path, 'wb') as f:
        f.write(png)
    print('written', path, os.path.getsize(path), 'bytes')


if __name__ == '__main__':
    here = os.path.dirname(os.path.abspath(__file__))
    out_dir = os.path.join(os.path.dirname(here), 'icons')
    os.makedirs(out_dir, exist_ok=True)
    for size in (16, 48, 128):
        write_png(os.path.join(out_dir, f'icon{size}.png'), make_icon(size))
