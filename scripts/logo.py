import base64
from collections import Counter
from io import BytesIO
from pathlib import Path

from PIL import Image

ROOT = Path(__file__).resolve().parent.parent
SOURCE = ROOT / "assets" / "logo.png"
TARGET = ROOT / "src" / "cli" / "logo" / "pixels.ts"
COLUMNS = 14
CROP = (0.327, 0.136, 0.75, 0.558)
COLORS = 60
DARK = 45
COVERAGE = 0.35
KEYS = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789"

source = Image.open(SOURCE).convert("RGBA")
image = Image.alpha_composite(Image.new("RGBA", source.size, (0, 0, 0, 255)), source).convert("RGB")
art = image.crop(tuple(round(edge * size) for edge, size in zip(CROP, source.size * 2)))
WIDTH = COLUMNS * 2
height = round(art.height / art.width * COLUMNS / 2) * 4
cell_w, cell_h = art.width / WIDTH, art.height / height

grid = Image.new("RGB", (WIDTH, height))
for y in range(height):
    for x in range(WIDTH):
        cell = art.crop((int(x * cell_w), int(y * cell_h), int((x + 1) * cell_w), int((y + 1) * cell_h)))
        counts = Counter(cell.quantize(6).convert("RGB").get_flattened_data())
        lit = [(n, color) for color, n in counts.items() if sum(color) > DARK]
        covered = sum(n for n, _ in lit) > COVERAGE * sum(counts.values())
        grid.putpixel((x, y), max(lit)[1] if lit and covered else (0, 0, 0))

quantized = grid.quantize(COLORS)
palette = quantized.getpalette()[: COLORS * 3]
colors = [tuple(palette[i : i + 3]) for i in range(0, len(palette), 3)]
used = sorted({quantized.getpixel((x, y)) for y in range(height) for x in range(WIDTH)})
visible = [index for index in used if sum(colors[index]) > DARK]
key = {index: KEYS[n] for n, index in enumerate(visible)}

rows = ["".join(key.get(quantized.getpixel((x, y)), ".") for x in range(WIDTH)) for y in range(height)]
hexes = [f'"#{r:02x}{g:02x}{b:02x}"' for r, g, b in (colors[index] for index in visible)]

TARGET.write_text(
    "export const LOGO_KEYS = " + f'"{KEYS[: len(visible)]}"' + "\n\n"
    + "export const LOGO_PALETTE = [" + ", ".join(hexes) + "]\n\n"
    + "export const LOGO_PIXELS = [\n" + "".join(f'  "{row}",\n' for row in rows) + "]\n"
)
print(f"{WIDTH}x{height}, {len(visible)} colours -> {TARGET.relative_to(ROOT)}")

README_SIZE = 140
README_SCALE = 3
README_TARGET = ROOT / "assets" / "logo.svg"

buffer = BytesIO()
source.resize((README_SIZE * README_SCALE,) * 2, Image.LANCZOS).save(buffer, "PNG", optimize=True)
encoded = base64.b64encode(buffer.getvalue()).decode()
README_TARGET.write_text(
    f'<svg xmlns="http://www.w3.org/2000/svg" width="{README_SIZE}" height="{README_SIZE}" viewBox="0 0 {README_SIZE} {README_SIZE}">'
    f'<image width="{README_SIZE}" height="{README_SIZE}" href="data:image/png;base64,{encoded}"/></svg>\n'
)
print(f"{README_SIZE}px at {README_SCALE}x -> {README_TARGET.relative_to(ROOT)}")
