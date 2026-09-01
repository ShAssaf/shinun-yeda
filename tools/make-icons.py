#!/usr/bin/env python3
"""מייצר את אייקוני האפליקציה — טבעת בנזן על רקע טורקיז. PNG טהור, בלי תלויות."""
import math, os, struct, zlib

OUT = os.path.join(os.path.dirname(__file__), '..', 'www', 'icons')
BG     = (0x0E, 0x7C, 0x72)
STROKE = (0xF2, 0xFB, 0xF9)

SS = 3  # supersampling


def hex_sdf(px, py, r):
    """Signed distance לשישון משוכלל (iq)."""
    kx, ky, kz = -0.866025404, 0.5, 0.577350269
    px, py = abs(px), abs(py)
    d = 2.0 * min(kx * px + ky * py, 0.0)
    px -= d * kx
    py -= d * ky
    px -= max(-kz * r, min(px, kz * r))
    py -= r
    return math.hypot(px, py) * (1.0 if py >= 0 else -1.0)


def render(size, inset):
    """inset — כמה מהמסגרת להשאיר ריק (0.0 רגיל, 0.18 ל-maskable)."""
    S = size * SS
    cx = cy = S / 2.0
    scale = (1.0 - inset)
    r_hex = S * 0.30 * scale
    t_hex = S * 0.055 * scale
    r_cir = S * 0.155 * scale
    t_cir = S * 0.042 * scale

    acc = [[0] * size for _ in range(size)]
    for y in range(S):
        py = y + 0.5 - cy
        row = acc[y // SS]
        for x in range(S):
            px = x + 0.5 - cx
            on = abs(hex_sdf(px, py, r_hex)) < t_hex / 2.0
            if not on:
                on = abs(math.hypot(px, py) - r_cir) < t_cir / 2.0
            if on:
                row[x // SS] += 1

    m = SS * SS
    raw = bytearray()
    for y in range(size):
        raw.append(0)
        row = acc[y]
        for x in range(size):
            a = row[x] / m
            raw += bytes(int(round(BG[i] + (STROKE[i] - BG[i]) * a)) for i in range(3))
    return bytes(raw)


def write_png(path, size, raw):
    def chunk(tag, data):
        c = tag + data
        return struct.pack('>I', len(data)) + c + struct.pack('>I', zlib.crc32(c) & 0xffffffff)
    ihdr = struct.pack('>IIBBBBB', size, size, 8, 2, 0, 0, 0)  # 8-bit truecolor
    png = (b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', ihdr)
           + chunk(b'IDAT', zlib.compress(raw, 9)) + chunk(b'IEND', b''))
    with open(path, 'wb') as f:
        f.write(png)
    print('%s  %dx%d  %.1f KB' % (os.path.basename(path), size, size, len(png) / 1024.0))


if __name__ == '__main__':
    os.makedirs(OUT, exist_ok=True)
    for size, inset, name in [(192, 0.0, 'icon-192.png'),
                              (512, 0.0, 'icon-512.png'),
                              (512, 0.20, 'maskable-512.png'),
                              (180, 0.0, 'apple-touch-icon.png')]:
        write_png(os.path.join(OUT, name), size, render(size, inset))
