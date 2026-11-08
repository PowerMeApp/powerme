"""Use-case diagram helper for the Report 3 UCD figures (ucd_*.py in the folders below this one).

Same visual style and SVG skeleton as the screen flows (`screen-flow/driver/sfdraw.py`):
system boundary = blue rectangle labelled <<System: ...>>, use case = blue ellipse with the
bold UC code over the name (optional [MoSCoW] tag and an "Extension Points" compartment),
stick-figure actors (secondary systems carry «system»), plain associations, hollow-triangle
generalization, dashed <<Extend>> / <<Include>> dependencies.

Coordinates are diagram units; the SVG is rendered at zoom 2 for the committed PNG.

Usage (from a UCD folder):
    PYTHONPATH=.. python3 ucd_driver.py          # -> ucd-driver.svg
    rsvg-convert -z 2 ucd-driver.svg -o ucd-driver.png

Text widths come from DejaVu Sans via Pillow. The font is looked up in $VPUC_FONT_DIR, the usual
Linux path, C:/Windows/Fonts and matplotlib's bundled copy. Without Pillow or the font, a width
estimate is used, so the layout still works but the ellipse widths can differ by a few units.
"""
import math
import os

FS, FS_SMALL, FS_TITLE = 13, 11.5, 17       # text, tag / label, title font sizes
LH = 16                                     # line height inside a use case
BLUE, STROKE = "#7FCDF2", "#222"

esc = lambda s: s.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")


def _font_dirs():
    dirs = [os.environ.get("VPUC_FONT_DIR", ""), "/usr/share/fonts/truetype/dejavu", "C:/Windows/Fonts"]
    try:
        import matplotlib
        dirs.append(os.path.join(os.path.dirname(matplotlib.__file__), "mpl-data", "fonts", "ttf"))
    except ImportError:
        pass
    return [d for d in dirs if d]


def _load_fonts():
    try:
        from PIL import ImageFont
    except ImportError:
        return None
    for d in _font_dirs():
        reg, bold = os.path.join(d, "DejaVuSans.ttf"), os.path.join(d, "DejaVuSans-Bold.ttf")
        if os.path.exists(reg) and os.path.exists(bold):
            return lambda s, n, b: ImageFont.truetype(bold if b else reg, n).getlength(s)
    return None


_measure = _load_fonts()


def tw(s, n=FS, b=False):
    """Width of string s in font size n (bold if b)."""
    if _measure:
        return _measure(s, n, b)
    return len(s) * n * (0.66 if b else 0.60)      # DejaVu Sans average advance (fallback)


class Diagram:
    def __init__(s, title):
        s.title, s.back, s.mid, s.front, s.lab, s.bb = title, [], [], [], [], []

    # -- elements -------------------------------------------------------------------------------
    def boundary(s, x, y, w, h, name):
        """System boundary: top-left corner (x, y), size w x h."""
        s.back.append(f'<rect x="{x}" y="{y}" width="{w}" height="{h}" fill="{BLUE}" stroke="#333" stroke-width="1.5"/>'
                      f'<text x="{x + w / 2:.1f}" y="{y + 18}" font-size="{FS}" text-anchor="middle">'
                      f'{esc("<<System: " + name + ">>")}</text>')
        s.bb += [(x, y), (x + w, y + h)]

    def uc(s, x, y, code, name, ep=None, tag=None):
        """Use case centred on (x, y). ep = extension point names, tag = MoSCoW priority shown as [tag]."""
        top = [(code, FS, "bold"), (name, FS, "")] + ([(f"[{tag}]", FS_SMALL, "italic")] if tag else [])
        bot = ([("Extension Points", FS, "bold")] + [(p, FS, "") for p in ep]) if ep else []
        widest = max(tw(t, n, st == "bold") for t, n, st in top + bot)
        w = widest + 72
        h = 32 + LH * (len(top) + len(bot)) + (20 if bot else 0)
        out = [f'<ellipse cx="{x:.1f}" cy="{y:.1f}" rx="{w / 2:.1f}" ry="{h / 2:.1f}" fill="{BLUE}" stroke="{STROKE}" stroke-width="1.4"/>']
        # text block: top lines, (separator gap of 21 between the two groups), bottom lines; centred on y
        span = LH * (len(top) - 1) + ((21 + LH * (len(bot) - 1)) if bot else 0)
        cy = y - span / 2
        lines = []
        for i, t in enumerate(top):
            lines.append((cy + i * LH, t))
        if bot:
            sep = cy + LH * (len(top) - 1) + 10
            half = (w / 2) * math.sqrt(max(0.0, 1 - ((sep - y) / (h / 2)) ** 2))
            out.append(f'<line x1="{x - half:.1f}" y1="{sep:.1f}" x2="{x + half:.1f}" y2="{sep:.1f}" stroke="{STROKE}" stroke-width="1.2"/>')
            for i, t in enumerate(bot):
                lines.append((sep + 11 + i * LH, t))
        for ly, (t, n, st) in lines:
            style = {"bold": ' font-weight="bold"', "italic": ' font-style="italic"', "": ""}[st]
            out.append(f'<text x="{x:.1f}" y="{ly + n * 0.36:.1f}" font-size="{n}"{style} text-anchor="middle">{esc(t)}</text>')
        s.front.append("".join(out))
        s.bb += [(x - w / 2, y - h / 2), (x + w / 2, y + h / 2)]
        return dict(kind="uc", x=x, y=y, w=w, h=h)

    def actor(s, x, y, name, kind="person"):
        """Stick-figure actor, body centred on (x, y). kind="system" adds the «system» stereotype."""
        out = [f'<g fill="none" stroke="{STROKE}" stroke-width="1.5">'
               f'<circle cx="{x}" cy="{y - 30}" r="10" fill="{BLUE}"/>'
               f'<line x1="{x}" y1="{y - 20}" x2="{x}" y2="{y + 8}"/>'
               f'<line x1="{x - 15}" y1="{y - 8}" x2="{x + 15}" y2="{y - 8}"/>'
               f'<line x1="{x}" y1="{y + 8}" x2="{x - 13}" y2="{y + 30}"/>'
               f'<line x1="{x}" y1="{y + 8}" x2="{x + 13}" y2="{y + 30}"/></g>',
               f'<text x="{x}" y="{y + 48}" font-size="{FS}" text-anchor="middle">{esc(name)}</text>']
        top = y - 40
        if kind == "system":
            out.append(f'<text x="{x}" y="{y - 46}" font-size="{FS_SMALL}" font-style="italic" text-anchor="middle">«system»</text>')
            top = y - 58
        s.front.append("".join(out))
        half = max(tw(name) / 2, 16)
        s.bb += [(x - half, top), (x + half, y + 52)]
        return dict(kind="actor", x=x, y=y)

    # -- geometry ------------------------------------------------------------------------------
    @staticmethod
    def _port(e, tx, ty):
        """Point where a line from e towards (tx, ty) leaves e."""
        dx, dy = tx - e["x"], ty - e["y"]
        if e["kind"] == "actor":                     # arm level, just past the hand on the facing side
            return e["x"] + (20 if dx >= 0 else -20), e["y"] - 8
        L = math.hypot(dx, dy) or 1
        t = 1 / math.sqrt((dx / (e["w"] / 2)) ** 2 + (dy / (e["h"] / 2)) ** 2) * L
        return e["x"] + dx / L * t, e["y"] + dy / L * t

    def _ends(s, a, b):
        ax, ay = (a["x"], a["y"] - 8) if a["kind"] == "actor" else (a["x"], a["y"])
        bx, by = (b["x"], b["y"] - 8) if b["kind"] == "actor" else (b["x"], b["y"])
        return s._port(a, bx, by), s._port(b, ax, ay)

    # -- relationships -------------------------------------------------------------------------
    def assoc(s, a, b):
        """Association (plain line) between an actor and a use case."""
        (x0, y0), (x1, y1) = s._ends(a, b)
        s.mid.append(f'<line x1="{x0:.1f}" y1="{y0:.1f}" x2="{x1:.1f}" y2="{y1:.1f}" stroke="{STROKE}" stroke-width="1.3"/>')

    def gen(s, child, parent):
        """Generalization child -> parent (actors stacked vertically): hollow triangle at the parent's head."""
        x = parent["x"]
        y0 = child["y"] + 58 if parent["y"] > child["y"] else child["y"] - 58
        y1 = parent["y"] - 40 if parent["y"] > child["y"] else parent["y"] + 52
        d = 1 if y1 > y0 else -1
        base = y1 - d * 17
        s.mid.append(f'<line x1="{child["x"]}" y1="{y0}" x2="{x}" y2="{base}" stroke="{STROKE}" stroke-width="1.3"/>'
                     f'<path d="M{x - 9},{base} L{x + 9},{base} L{x},{y1} Z" fill="#fff" stroke="{STROKE}" stroke-width="1.3"/>')

    def dep(s, a, b, kind="Extend", lx=0, ly=0):
        """Dashed dependency a -> b with an open arrowhead at b, labelled <<kind>> at the midpoint + (lx, ly)."""
        (x0, y0), (x1, y1) = s._ends(a, b)
        s.mid.append(f'<line x1="{x0:.1f}" y1="{y0:.1f}" x2="{x1:.1f}" y2="{y1:.1f}" stroke="{STROKE}" stroke-width="1.3" '
                     f'stroke-dasharray="6 4" marker-end="url(#arr)"/>')
        mx, my = (x0 + x1) / 2 + lx, (y0 + y1) / 2 + ly + (4 if not ly else 0)
        label = f"<<{kind}>>"
        s.lab.append(f'<text x="{mx:.1f}" y="{my:.1f}" font-size="{FS_SMALL}" text-anchor="middle">{esc(label)}</text>')
        W = tw(label, FS_SMALL)
        s.bb += [(mx - W / 2, my - 12), (mx + W / 2, my + 4)]

    # -- output --------------------------------------------------------------------------------
    def save(s, path):
        xs = [p[0] for p in s.bb]; ys = [p[1] for p in s.bb]; P = 24
        x0, x1, y0, y1 = min(xs) - P, max(xs) + P, min(ys) - P - 40, max(ys) + P; W, H = x1 - x0, y1 - y0
        svg = [f'<svg xmlns="http://www.w3.org/2000/svg" width="{W:.0f}" height="{H:.0f}" viewBox="{x0:.0f} {y0:.0f} {W:.0f} {H:.0f}" font-family="DejaVu Sans, Arial, sans-serif" fill="#111">',
               '<defs><marker id="arr" viewBox="0 0 12 12" refX="11" refY="6" markerWidth="10" markerHeight="10" orient="auto" markerUnits="userSpaceOnUse">'
               '<path d="M1,1 L11,6 L1,11" fill="none" stroke="#222" stroke-width="1.5"/></marker></defs>',
               f'<rect x="{x0}" y="{y0}" width="{W}" height="{H}" fill="#fff"/>',
               f'<text x="{(x0 + x1) / 2:.0f}" y="{y0 + P + 14:.0f}" font-size="{FS_TITLE}" font-weight="bold" text-anchor="middle">{esc(s.title)}</text>']
        with open(path, "w", encoding="utf-8") as f:
            f.write("\n".join(svg + s.back + s.mid + s.front + s.lab + ["</svg>"]))
