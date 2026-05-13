from PIL import Image, ImageOps
from pathlib import Path

SRC = Path("public/12_arcanos")
OUT = Path("public/12_arcanos_web")
OUT.mkdir(exist_ok=True)

files = {
    "mago.jpg": "mago.webp",
    "sacerdotisa.jpg": "sacerdotisa.webp",
    "emperatriz.jpg": "emperatriz.webp",
    "emperador.jpg": "emperador.webp",
    "sacerdote.jpg": "sacerdote.webp",
    "enamorados.jpg": "enamorados.webp",
    "carro.jpg": "carro.webp",
    "fuerza.jpg": "fuerza.webp",
    "rueda.png": "rueda.webp",
    "estrella.png": "estrella.webp",
    "juicio.jpg": "juicio.webp",
    "sol.png": "sol.webp",
}

CARD_W, CARD_H = 420, 620
MARGIN = 36

for src_name, out_name in files.items():
    img = Image.open(SRC / src_name).convert("RGB")
    img.thumbnail((CARD_W - MARGIN * 2, CARD_H - MARGIN * 2), Image.LANCZOS)

    canvas = Image.new("RGB", (CARD_W, CARD_H), (18, 10, 20))
    x = (CARD_W - img.width) // 2
    y = (CARD_H - img.height) // 2
    canvas.paste(img, (x, y))

    canvas = ImageOps.expand(canvas, border=8, fill=(226, 186, 91))
    canvas.save(OUT / out_name, "WEBP", quality=82)

print("Listo: imágenes optimizadas en public/12_arcanos_web")