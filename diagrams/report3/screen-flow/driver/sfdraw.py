"""Screen-flow diagram in UML state-machine notation (same visual style as the use-case figures):
state = screen (rounded box), shaded state = pop-up sheet, initial / final pseudostates,
composite state 'Signed In', transitions labelled 'event [guard]'."""
import math
from PIL import ImageFont
FR = "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf"; FB = "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf"
def tw(s, n=13, b=False): return ImageFont.truetype(FB if b else FR, n).getlength(s)
esc = lambda s: s.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")
BLUE, SHEET, EXT = "#7FCDF2", "#C9E9F8", "#FFFFFF"

class SF:
    def __init__(s, title): s.title, s.back, s.mid, s.front, s.lab, s.bb = title, [], [], [], [], []
    def composite(s, x, y, w, h, name):
        s.back.append(f'<rect x="{x}" y="{y}" width="{w}" height="{h}" rx="18" fill="#EEF8FD" stroke="#333" stroke-width="1.5"/>'
                      f'<text x="{x+16}" y="{y+22}" font-size="14" font-weight="bold">{esc(name)}</text>'
                      f'<line x1="{x}" y1="{y+32}" x2="{x+w}" y2="{y+32}" stroke="#333" stroke-width="1"/>')
        s.bb += [(x, y), (x+w, y+h)]
        return dict(kind="box", x=x+w/2, y=y+h/2, w=w, h=h)
    def state(s, cx, cy, name, kind="screen", note=None, w=None):
        lines = [name] + ([note] if note else [])
        w = w or max(max(tw(l, 13, i == 0) for i, l in enumerate(lines)) + 34, 150)
        h = 40 + 16*(len(lines)-1)
        fill = {"screen": BLUE, "sheet": SHEET, "ext": EXT}[kind]
        dash = ' stroke-dasharray="5 3"' if kind == "ext" else ""
        t = [f'<rect x="{cx-w/2:.1f}" y="{cy-h/2:.1f}" width="{w:.1f}" height="{h}" rx="12" fill="{fill}" stroke="#222" stroke-width="1.4"{dash}/>']
        y0 = cy - h/2 + 25
        for i, l in enumerate(lines):
            st = 'font-weight="bold" font-size="13"' if i == 0 else 'font-style="italic" font-size="11.5"'
            t.append(f'<text x="{cx}" y="{y0+i*16:.1f}" {st} text-anchor="middle">{esc(l)}</text>')
        s.front.append("".join(t)); s.bb += [(cx-w/2, cy-h/2), (cx+w/2, cy+h/2)]
        return dict(kind="box", x=cx, y=cy, w=w, h=h)
    def initial(s, cx, cy):
        s.front.append(f'<circle cx="{cx}" cy="{cy}" r="10" fill="#111"/>'); s.bb += [(cx-12, cy-12), (cx+12, cy+12)]
        return dict(kind="circ", x=cx, y=cy, r=10)
    def final(s, cx, cy):
        s.front.append(f'<circle cx="{cx}" cy="{cy}" r="13" fill="#fff" stroke="#111" stroke-width="1.6"/><circle cx="{cx}" cy="{cy}" r="8" fill="#111"/>')
        s.bb += [(cx-15, cy-15), (cx+15, cy+15)]
        return dict(kind="circ", x=cx, y=cy, r=13)
    @staticmethod
    def edge(e, dx, dy, px, py):
        """exit point from element e (centre shifted by (px,py)) in direction (dx,dy)."""
        if e["kind"] == "circ":
            L = math.hypot(dx, dy); return e["x"]+dx/L*e["r"], e["y"]+dy/L*e["r"]
        cx, cy = e["x"]+px, e["y"]+py; hw, hh = e["w"]/2, e["h"]/2
        t = min(hw/abs(dx) if dx else 1e9, hh/abs(dy) if dy else 1e9)
        return cx+dx*t, cy+dy*t
    def tr(s, a, b, label="", off=0, lpos=0.5, ldx=0, ldy=0, anchor="middle", via=None):
        """transition a -> b. off = parallel offset (px) for paired arrows. via = list of bend points."""
        pts_mid = via or []
        ax, ay = a["x"], a["y"]; bx, by = b["x"], b["y"]
        first = pts_mid[0] if pts_mid else (bx, by); last = pts_mid[-1] if pts_mid else (ax, ay)
        dx, dy = first[0]-ax, first[1]-ay; L = math.hypot(dx, dy) or 1
        nx, ny = -dy/L*off, dx/L*off
        p0 = s.edge(a, dx, dy, nx if not pts_mid else 0, ny if not pts_mid else 0)
        ex, ey = bx-last[0], by-last[1]
        p1 = s.edge(b, -ex, -ey, nx if not pts_mid else 0, ny if not pts_mid else 0)
        pts = [p0] + list(pts_mid) + [p1]
        d = "M" + " L".join(f"{x:.1f},{y:.1f}" for x, y in pts)
        s.mid.append(f'<path d="{d}" fill="none" stroke="#222" stroke-width="1.3" marker-end="url(#arr)"/>')
        if label:
            # label on the segment chosen by lpos along the polyline
            seg = min(int(lpos*(len(pts)-1)), len(pts)-2); f = lpos*(len(pts)-1) - seg
            lx = pts[seg][0] + (pts[seg+1][0]-pts[seg][0])*f + ldx; ly = pts[seg][1] + (pts[seg+1][1]-pts[seg][1])*f + ldy
            W = tw(label, 11.5)
            bx0 = lx - W/2 if anchor == "middle" else (lx if anchor == "start" else lx - W)
            s.lab.append(f'<rect x="{bx0-3:.1f}" y="{ly-11:.1f}" width="{W+6:.1f}" height="15" fill="#fff" fill-opacity="0.92"/>'
                         f'<text x="{lx:.1f}" y="{ly:.1f}" font-size="11.5" text-anchor="{anchor}">{esc(label)}</text>')
            s.bb += [(bx0-4, ly-12), (bx0+W+4, ly+4)]
    def legend(s, x, y):
        items = [(BLUE, "", "screen"), (SHEET, "", "pop-up sheet"), (EXT, ' stroke-dasharray="5 3"', "external page")]
        out = [f'<text x="{x}" y="{y}" font-size="12" font-weight="bold">Legend</text>']
        for i, (f, d, t) in enumerate(items):
            yy = y + 12 + i*24
            out.append(f'<rect x="{x}" y="{yy}" width="34" height="18" rx="5" fill="{f}" stroke="#222"{d}/><text x="{x+44}" y="{yy+14}" font-size="12">{t}</text>')
        s.front.append("".join(out)); s.bb += [(x, y-14), (x+150, y+12+3*24)]
    def save(s, path):
        xs = [p[0] for p in s.bb]; ys = [p[1] for p in s.bb]; P = 24
        x0, x1, y0, y1 = min(xs)-P, max(xs)+P, min(ys)-P-40, max(ys)+P; W, H = x1-x0, y1-y0
        svg = [f'<svg xmlns="http://www.w3.org/2000/svg" width="{W:.0f}" height="{H:.0f}" viewBox="{x0:.0f} {y0:.0f} {W:.0f} {H:.0f}" font-family="DejaVu Sans, Arial, sans-serif" fill="#111">',
               '<defs><marker id="arr" viewBox="0 0 12 12" refX="11" refY="6" markerWidth="10" markerHeight="10" orient="auto"><path d="M1,1 L11,6 L1,11" fill="none" stroke="#222" stroke-width="1.5"/></marker></defs>',
               f'<rect x="{x0}" y="{y0}" width="{W}" height="{H}" fill="#fff"/>',
               f'<text x="{(x0+x1)/2:.0f}" y="{y0+P+14:.0f}" font-size="17" font-weight="bold" text-anchor="middle">{esc(s.title)}</text>']
        open(path, "w").write("\n".join(svg + s.back + s.mid + s.front + s.lab + ['</svg>']))
