"""Build review sheets from the current Flutter capture manifest (Pillow required)."""

import json
from pathlib import Path

from PIL import Image, ImageDraw


def main():
    root = Path(__file__).resolve().parents[1] / "build" / "previews"
    manifest = json.loads((root / "manifest.json").read_text(encoding="utf-8"))
    captures = []
    for name in manifest["images"]:
        source = (root / name).resolve()
        if source.parent != root.resolve() or source.suffix != ".png":
            raise ValueError(f"Invalid capture path: {name}")
        captures.append(source)

    outputs = []
    for offset in range(0, len(captures), 8):
        sheet = Image.new("RGB", (976, 1096), "#1f1f1f")
        draw = ImageDraw.Draw(sheet)
        for index, source in enumerate(captures[offset : offset + 8]):
            left = 16 + (index % 4) * 240
            top = 16 + (index // 4) * 540
            with Image.open(source) as image:
                image.thumbnail((224, 492), Image.Resampling.LANCZOS)
                sheet.paste(image.convert("RGB"), (left, top))
            draw.text((left, top + 496), source.stem, fill="#ffffff")
        output = root / f"review-{offset // 8 + 1}.jpg"
        sheet.save(output, quality=92)
        outputs.append(output.name)
    print(f"{len(captures)} captures -> {', '.join(outputs)}")


if __name__ == "__main__":
    main()
