"""Builds the transparent logos and icons in public/ from design/logo.jpeg.

    python3 design/make-logo.py        (needs Pillow)

JPEG has no transparency, so the white background is removed here:
- icon (left part): the near-white area connected to the border becomes
  transparent, so light pixels inside the icon stay opaque;
- text (right part): alpha grows with the distance from white, ignoring the
  last few levels where JPEG noise sits, and the colour is un-mixed from white.
logo-dark.png is the same with the dark grey tagline turned light grey.
"""
from PIL import Image, ImageDraw, ImageFilter

SRC = 'design/logo.jpeg'
SPLIT = 532  # x where the icon ends and the text starts, in source pixels
NOISE = 24   # levels below white treated as background
RAMP = 50    # levels over which text edges go from transparent to opaque

im = Image.open(SRC).convert('RGB')
W, H = im.size
src = im.load()

icon = im.crop((0, 0, SPLIT, H))
mark = icon.copy()
w, h = icon.size
for seed in [(0, 0), (0, h - 1), (w - 1, 0), (w - 1, h - 1), (w // 2, 0), (w // 2, h - 1), (0, h // 2)]:
    if min(mark.getpixel(seed)) > 225:
        ImageDraw.floodfill(mark, seed, (255, 0, 255), thresh=110)
mp = mark.load()
icon_alpha = Image.new('L', (w, h), 255)
ia = icon_alpha.load()
for y in range(h):
    for x in range(w):
        if mp[x, y] == (255, 0, 255):
            ia[x, y] = 0
        else:
            m = min(src[x, y])
            if m > 200:
                ia[x, y] = int(255 * (255 - m) / 55)
ia = icon_alpha.filter(ImageFilter.GaussianBlur(0.7)).load()

out = Image.new('RGBA', (W, H))
op = out.load()
for y in range(H):
    for x in range(W):
        r, g, b = src[x, y]
        if x < SPLIT:
            op[x, y] = (r, g, b, ia[x, y])
            continue
        a = min(1.0, max(0.0, (255 - min(r, g, b) - NOISE) / RAMP))
        if a == 0:
            op[x, y] = (0, 0, 0, 0)
            continue
        un = lambda c: max(0, min(255, round((c - 255 * (1 - a)) / a)))
        op[x, y] = (un(r), un(g), un(b), round(a * 255))

pad = 12
x0, y0, x1, y1 = out.getbbox()
box = (max(0, x0 - pad), max(0, y0 - pad), min(W, x1 + pad), min(H, y1 + pad))
logo = out.crop(box)
logo.save('public/logo.png', optimize=True)

dark = logo.copy()
dp = dark.load()
for y in range(dark.height):
    for x in range(dark.width):
        r, g, b, a = dp[x, y]
        if x + box[0] >= SPLIT and a > 0 and max(r, g, b) < 140 and max(r, g, b) - min(r, g, b) < 30:
            dp[x, y] = (214, 219, 226, a)
dark.save('public/logo-dark.png', optimize=True)

# Square icon: the icon part, centred on a transparent square.
ic = out.crop((105, 73, 529, 408))
side = max(ic.size)
sq = Image.new('RGBA', (side, side), (0, 0, 0, 0))
sq.paste(ic, ((side - ic.width) // 2, (side - ic.height) // 2), ic)
for size, name in [(512, 'icon-512.png'), (180, 'apple-touch-icon.png'), (64, 'favicon.png')]:
    sq.resize((size, size), Image.LANCZOS).save(f'public/{name}', optimize=True)
print('logo', logo.size)
