#!/usr/bin/env python3
"""מייצר את אייקוני ההשקה של אנדרואיד מתוך אותו סמל — טבעת בנזן.
מריצים אחרי `npx cap add android`.  PNG טהור, בלי תלויות."""
import math, os, struct, zlib

ROOT = os.path.join(os.path.dirname(__file__), '..')
RES = os.path.join(ROOT, 'android', 'app', 'src', 'main', 'res')
BG = (0x0E, 0x7C, 0x72)
FG = (0xF2, 0xFB, 0xF9)
SS = 2

DENSITIES = ['mdpi', 'hdpi', 'xhdpi', 'xxhdpi', 'xxxhdpi']
SCALE = {'mdpi': 1, 'hdpi': 1.5, 'xhdpi': 2, 'xxhdpi': 3, 'xxxhdpi': 4}


def hex_sdf(px, py, r):
    kx, ky, kz = -0.866025404, 0.5, 0.577350269
    px, py = abs(px), abs(py)
    d = 2.0 * min(kx * px + ky * py, 0.0)
    px -= d * kx
    py -= d * ky
    px -= max(-kz * r, min(px, kz * r))
    py -= r
    return math.hypot(px, py) * (1.0 if py >= 0 else -1.0)


def render(size, shape, art_scale):
    """shape: 'square' | 'round' | 'none' (רקע שקוף, לאייקון אדפטיבי).
    art_scale — גודל הסמל ביחס לצלע."""
    S = size * SS
    c = S / 2.0
    r_hex = S * art_scale * 0.30
    t_hex = S * art_scale * 0.055
    r_cir = S * art_scale * 0.155
    t_cir = S * art_scale * 0.042
    r_mask = S / 2.0

    art = [[0] * size for _ in range(size)]
    bg = [[0] * size for _ in range(size)]
    for y in range(S):
        py = y + 0.5 - c
        ra, rb = art[y // SS], bg[y // SS]
        for x in range(S):
            px = x + 0.5 - c
            if abs(hex_sdf(px, py, r_hex)) < t_hex / 2.0 or \
               abs(math.hypot(px, py) - r_cir) < t_cir / 2.0:
                ra[x // SS] += 1
            if shape == 'square':
                rb[x // SS] += 1
            elif shape == 'round' and math.hypot(px, py) <= r_mask:
                rb[x // SS] += 1

    m = float(SS * SS)
    raw = bytearray()
    for y in range(size):
        raw.append(0)
        ra, rb = art[y], bg[y]
        for x in range(size):
            a_art = ra[x] / m
            a_bg = rb[x] / m
            alpha = a_bg + a_art * (1.0 - a_bg) if shape != 'none' else a_art
            if alpha <= 0:
                raw += b'\x00\x00\x00\x00'
                continue
            for i in range(3):
                col = (BG[i] * a_bg * (1 - a_art) + FG[i] * a_art) / alpha if shape != 'none' \
                    else FG[i]
                raw.append(max(0, min(255, int(round(col)))))
            raw.append(int(round(alpha * 255)))
    return bytes(raw)


def write_png(path, size, raw):
    def chunk(tag, data):
        c = tag + data
        return struct.pack('>I', len(data)) + c + struct.pack('>I', zlib.crc32(c) & 0xffffffff)
    ihdr = struct.pack('>IIBBBBB', size, size, 8, 6, 0, 0, 0)  # RGBA
    with open(path, 'wb') as f:
        f.write(b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', ihdr)
                + chunk(b'IDAT', zlib.compress(raw, 9)) + chunk(b'IEND', b''))


if __name__ == '__main__':
    for d in DENSITIES:
        out = os.path.join(RES, 'mipmap-' + d)
        os.makedirs(out, exist_ok=True)
        legacy = int(round(48 * SCALE[d]))
        adaptive = int(round(108 * SCALE[d]))
        write_png(os.path.join(out, 'ic_launcher.png'), legacy, render(legacy, 'square', 1.0))
        write_png(os.path.join(out, 'ic_launcher_round.png'), legacy, render(legacy, 'round', 1.0))
        # אזור בטוח באייקון אדפטיבי: 66 מתוך 108
        write_png(os.path.join(out, 'ic_launcher_foreground.png'), adaptive,
                  render(adaptive, 'none', 0.60))
        print('mipmap-%-8s  %dpx legacy · %dpx adaptive' % (d, legacy, adaptive))

    colors = os.path.join(RES, 'values', 'ic_launcher_background.xml')
    os.makedirs(os.path.dirname(colors), exist_ok=True)
    with open(colors, 'w') as f:
        f.write('<?xml version="1.0" encoding="utf-8"?>\n<resources>\n'
                '    <color name="ic_launcher_background">#0E7C72</color>\n</resources>\n')
    print('ic_launcher_background = #0E7C72')
