"""BCD-1 radial layout generator: one black-box circle, entities evenly around it,
one straight one-way arrow per information flow (parallel lanes, no crossings)."""
import math
from PIL import ImageFont
FONT = "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf"
FS, EFS, SFS = 14, 19, 24          # flow label, entity, system font sizes
ft = ImageFont.truetype(FONT, FS)
tw = lambda s, f=ft: f.getlength(s)

R = 215                             # system circle radius
LANE = 27                           # spacing between parallel arrows
# name, angle (deg, 0 = right, CCW), box w, h, inbound (-> system), outbound (system ->)
E = [
 ("Driver", 180, 280, 120,
  ["Driver Account & Vehicle Details","Station Search Criteria","Top-Up Order","Charging Command","Charge Point Fault Report"],
  ["Station Status & Suggestions","Live Charging Progress","Charging Statement","Receipt & E-Invoice","Credit & Loyalty Statement"]),
 ("Operator", 135, 280, 120,
  ["Charge Point Onboarding Details","Tariff Schedule & Promotion","Remote Charge Point Command","Unattributed Session Resolution","Fault & Maintenance Update"],
  ["Charge Point Credential","Charge Point Status & Fault Alert","Unattributed Session List","Revenue Share Statement"]),
 ("Admin", 225, 280, 120,
  ["User Account & Role Assignment","Charge Point & Card Registry Entry","Platform Fee Rate","Billing Exception Decision"],
  ["Charge Point Monitoring Summary","Transaction & Revenue Summary","Billing Exception List"]),
 ("Charge Point", 0, 280, 120,
  ["Charge Point Status","Card Identifier","Transaction Record"],
  ["Authorization Decision","Remote Charging Command","Charge Point Configuration"]),
 ("Payment Gateway", 45, 280, 120,
  ["Payment Result","Refund Result"], ["Payment Order","Refund Order"]),
 ("E-Invoice Provider", 315, 280, 120, ["Issued E-Invoice"], ["Invoice Data"]),
 ("Map & Routing Service", 270, 280, 120, ["Travel Time Estimate"], ["Route Query"]),
]

def box_exit(cx, cy, w, h, px, py, ux, uy):
    """largest t so that p + t*u is still inside the box (box edge facing the system)."""
    ts = []
    for c, p, u, half in ((cx, px, ux, w/2), (cy, py, uy, h/2)):
        if abs(u) < 1e-9: continue
        ts += [((c - half) - p)/u, ((c + half) - p)/u]
    ts.sort()
    return ts[2] if len(ts) == 4 else ts[1]

def circle_entry(px, py, ux, uy):
    b = px*ux + py*uy; c = px*px + py*py - R*R
    return -b - math.sqrt(b*b - c)

parts, arrows, labels, boxes = [], [], [], []
# hand-placed sector centres (deg, CCW from the right): heavy entities on the
# left/right so their labels stay near-horizontal; light ones top/bottom.
CENTER = {"Map & Routing Service": 90, "Operator": 150, "Driver": 211,
          "Payment Gateway": 50, "Admin": 12, "Charge Point": -32,
          "E-Invoice Provider": -78}
step = 6.4
for name, _a, w, h, ins, outs in E:
    flows = [(f, 1) for f in ins] + [(f, -1) for f in outs]
    n = len(flows)
    ang = CENTER[name]
    st = step*2.2 if n <= 2 else step
    thetas = [ang + st*((n-1)/2 - i) for i in range(n)]
    a = math.radians(ang)
    dx, dy = math.cos(a), -math.sin(a)
    ux, uy = -dx, -dy
    tx, ty = math.sin(a), math.cos(a)          # direction of decreasing theta (clockwise)
    vertical = abs(dy) > 0.85
    longest = max(tw(f) for f, _ in flows)
    gap = 120 if vertical else longest + 50
    half_depth = abs(dx)*w/2 + abs(dy)*h/2
    D = R + gap + half_depth
    cx, cy = dx*D, dy*D
    boxes.append((name, cx, cy, w, h))
    face = abs(tx)*w + abs(ty)*h               # usable width of the facing side
    sp = min(LANE*1.25, (face-24)/max(n-1,1)) if n > 1 else 0
    if vertical: sp = 110
    for i, (f, d) in enumerate(flows):
        off = (i - (n-1)/2) * sp
        px, py = cx + tx*off, cy + ty*off
        th = math.radians(thetas[i])
        ex, ey = R*math.cos(th), -R*math.sin(th)
        vx, vy = ex-px, ey-py; L = math.hypot(vx, vy); vx, vy = vx/L, vy/L
        t0 = box_exit(cx, cy, w, h, px, py, vx, vy)
        x0, y0 = px + vx*t0, py + vy*t0
        x1, y1 = ex, ey
        if d < 0: x0, y0, x1, y1 = x1, y1, x0, y0
        arrows.append((x0, y0, x1, y1))
        mx, my = (x0+x1)/2, (y0+y1)/2
        if vertical:
            side = 1 if mx > cx else -1
            labels.append((f, mx + side*10, my, 0, "start" if side > 0 else "end"))
        else:
            rot = math.degrees(math.atan2(vy, vx))
            if rot > 90: rot -= 180
            if rot < -90: rot += 180
            labels.append((f, mx, my, rot, "middle"))

# bounds
xs, ys = [], []
for _, cx, cy, w, h in boxes: xs += [cx-w/2, cx+w/2]; ys += [cy-h/2, cy+h/2]
for f, x, y, r, anc in labels:
    L = tw(f); xs += [x-L/2-10, x+L/2+10] if anc == "middle" else ([x, x+L] if anc == "start" else [x-L, x])
PAD, TITLE = 30, 60
minx, maxx, miny, maxy = min(xs)-PAD, max(xs)+PAD, min(ys)-PAD-TITLE, max(ys)+PAD
W, H = maxx-minx, maxy-miny

o = [f'<svg xmlns="http://www.w3.org/2000/svg" width="{W:.0f}" height="{H:.0f}" viewBox="{minx:.1f} {miny:.1f} {W:.1f} {H:.1f}" font-family="DejaVu Sans, Arial, sans-serif">',
     '<defs><marker id="ah" viewBox="0 0 10 10" refX="10" refY="5" markerWidth="9" markerHeight="9" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" fill="#333"/></marker></defs>',
     f'<rect x="{minx}" y="{miny}" width="{W}" height="{H}" fill="#fff"/>',
     f'<text x="{(minx+maxx)/2:.1f}" y="{miny+PAD+14:.1f}" font-size="20" font-weight="bold" text-anchor="middle" fill="#111">Figure 1 — Business Context Diagram: PowerMe Platform</text>']
for x0, y0, x1, y1 in arrows:
    o.append(f'<line x1="{x0:.1f}" y1="{y0:.1f}" x2="{x1:.1f}" y2="{y1:.1f}" stroke="#333" stroke-width="1.4" marker-end="url(#ah)"/>')
for name, cx, cy, w, h in boxes:
    o.append(f'<rect x="{cx-w/2:.1f}" y="{cy-h/2:.1f}" width="{w}" height="{h}" fill="#f2f2f2" stroke="#222" stroke-width="2"/>')
    o.append(f'<text x="{cx:.1f}" y="{cy+7:.1f}" font-size="{EFS}" font-weight="bold" text-anchor="middle" fill="#111">{name.replace("&","&amp;")}</text>')
o.append(f'<circle cx="0" cy="0" r="{R}" fill="#e6e6e6" stroke="#111" stroke-width="2.5"/>')
o.append(f'<text x="0" y="-4" font-size="{SFS}" font-weight="bold" text-anchor="middle" fill="#111">PowerMe</text>')
o.append(f'<text x="0" y="26" font-size="{SFS}" font-weight="bold" text-anchor="middle" fill="#111">Platform</text>')
for f, x, y, r, anc in labels:
    t = f.replace("&", "&amp;"); L = tw(f)
    tr = f' transform="rotate({r:.1f} {x:.1f} {y:.1f})"' if r else ""
    bx = x-L/2 if anc == "middle" else (x if anc == "start" else x-L)
    o.append(f'<g{tr}><rect x="{bx-3:.1f}" y="{y-9:.1f}" width="{L+6:.1f}" height="18" fill="#fff"/>'
             f'<text x="{x:.1f}" y="{y+5:.1f}" font-size="{FS}" text-anchor="{anc}" fill="#111">{t}</text></g>')
o.append('</svg>')
open("BCD-1_PowerMe_Platform.svg", "w").write("\n".join(o))
print(f"{W:.0f}x{H:.0f}, arrows={len(arrows)}")
