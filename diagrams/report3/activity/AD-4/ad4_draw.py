"""AD-4 Reserve a charging connector — UML 2.5 activity diagram with a real
interruptible activity region. Hand-placed SVG (no layout engine), black & white,
same look as the PlantUML AD set. Run: python ad4_draw.py  -> AD-4.svg
"""
from xml.sax.saxutils import escape

W, H = 1740, 2010
FONT = "Arial, Helvetica, sans-serif"
CW = 7.0          # approx char width at 13 px
LH = 16           # line height
out = []

def text(x, y, s, size=13, anchor="middle", bold=False):
    lines = s.split("\n")
    y0 = y - (len(lines) - 1) * LH / 2 + size * 0.35
    w = ' font-weight="bold"' if bold else ""
    for i, ln in enumerate(lines):
        out.append(f'<text x="{x}" y="{y0 + i*LH:.1f}" font-family="{FONT}" font-size="{size}" '
                   f'text-anchor="{anchor}"{w}>{escape(ln)}</text>')

def box_w(s, pad=26):
    return max(len(l) for l in s.split("\n")) * CW + pad

def box_h(s):
    return len(s.split("\n")) * LH + 14

def action(x, y, s):
    w, h = box_w(s), box_h(s)
    out.append(f'<rect x="{x-w/2}" y="{y-h/2}" width="{w}" height="{h}" rx="12" fill="white" stroke="black"/>')
    text(x, y, s); return (x, y, w, h)

def objnode(x, y, s):
    w, h = box_w(s, 24), box_h(s) + 4
    out.append(f'<rect x="{x-w/2}" y="{y-h/2}" width="{w}" height="{h}" fill="white" stroke="black"/>')
    text(x, y, s); return (x, y, w, h)

def send(x, y, s):
    w, h = box_w(s, 36), box_h(s)
    x0, x1, y0, y1 = x-w/2, x+w/2, y-h/2, y+h/2
    out.append(f'<polygon points="{x0},{y0} {x1-16},{y0} {x1},{y} {x1-16},{y1} {x0},{y1}" fill="white" stroke="black"/>')
    text(x - 6, y, s); return (x, y, w, h)

def accept(x, y, s):
    w, h = box_w(s, 40), box_h(s)
    x0, x1, y0, y1 = x-w/2, x+w/2, y-h/2, y+h/2
    out.append(f'<polygon points="{x0},{y0} {x1},{y0} {x1},{y1} {x0},{y1} {x0+16},{y}" fill="white" stroke="black"/>')
    text(x + 7, y, s); return (x, y, w, h)

def hourglass(x, y):
    out.append(f'<polygon points="{x-11},{y-14} {x+11},{y-14} {x-11},{y+14} {x+11},{y+14}" fill="white" stroke="black"/>')

def diamond(x, y, r=14):
    out.append(f'<polygon points="{x},{y-r} {x+r},{y} {x},{y+r} {x-r},{y}" fill="white" stroke="black"/>')

def initial(x, y):
    out.append(f'<circle cx="{x}" cy="{y}" r="11" fill="black"/>')

def final(x, y):
    out.append(f'<circle cx="{x}" cy="{y}" r="12" fill="white" stroke="black" stroke-width="1.5"/>')
    out.append(f'<circle cx="{x}" cy="{y}" r="7" fill="black"/>')

def bar(x0, x1, y):
    out.append(f'<rect x="{x0}" y="{y-3}" width="{x1-x0}" height="6" fill="black"/>')

def edge(*pts, arrow=True):
    d = " ".join(f"{x},{y}" for x, y in pts)
    m = ' marker-end="url(#arr)"' if arrow else ""
    out.append(f'<polyline points="{d}" fill="none" stroke="black" stroke-width="1.2"{m}/>')

def lightning(x, ytop, ybot):
    """Interrupting edge: straight, zig-zag across the region's bottom border, straight."""
    edge((x, ytop), (x, RY1 - 14), (x + 11, RY1 - 2), (x - 11, RY1 + 4), (x, RY1 + 16), arrow=False)
    return RY1 + 16

def guard(x, y, s, anchor="start"):
    text(x, y, s, size=12, anchor=anchor)

# ---------- frame, title, lanes ----------
LD, LP, LC = (20, 420), (420, 1400), (1400, 1720)
cD, cP, cC = 220, 870, 1560
out.append(f'<rect x="0" y="0" width="{W}" height="{H}" fill="white"/>')
text(W/2, 22, "AD-4 (System level) — Reserve a charging connector [Should]", 15, bold=True)
text(W/2, 42, "Trigger: Driver taps Reserve on a connector · Use case: UC-CHG-06 · Rules: BR-P24 – BR-P31", 14, bold=True)
TOP = 60
for x in (LD[0], LP[0], LC[0], LC[1]):
    out.append(f'<line x1="{x}" y1="{TOP}" x2="{x}" y2="{H-10}" stroke="black" stroke-width="1.5"/>')
for (a, b), s in ((LD, "«person»\nDriver"), (LP, "«software system»\nPowerMe Platform"), (LC, "«external system»\nCharge Point")):
    text((a+b)/2, TOP + 24, s, 13, bold=True)

# ---------- before the hold ----------
initial(cD, 115)
a1 = action(cD, 175, "Review hold window, fees and\nfree-cancel cut-off, then confirm")
edge((cD, 126), (cD, 175 - a1[3]/2))
a2 = action(cP, 275, "Check eligibility and\ncreate the reservation")
edge((cD, 175 + a1[3]/2), (cD, 225), (cP, 225), (cP, 275 - a2[3]/2))
diamond(cP, 345)
edge((cP, 275 + a2[3]/2), (cP, 331))
# refuse branch
xr = 640
a3 = action(xr, 445, "Refuse with reason and\nnearby alternatives")
edge((cP-14, 345), (xr, 345), (xr, 445 - a3[3]/2))
guard(xr - 10, 385, "[connector not Available, offline\nor incompatible, credit < start\nminimum, Driver already holds one,\nor just reserved by another Driver]", "end")
final(xr, 510); edge((xr, 445 + a3[3]/2), (xr, 498))
# eligible
o1 = objnode(cP, 430, "Reservation\n[active]")
edge((cP, 359), (cP, 430 - o1[3]/2)); guard(cP + 8, 380, "[eligible]")
diamond(cP, 500); edge((cP, 430 + o1[3]/2), (cP, 486))
s1 = send(1150, 560, "Send hold request")
edge((cP+14, 500), (1150, 500), (1150, 560 - s1[3]/2)); guard(cP + 20, 490, "[Charge Point supports reservations]")
a5 = action(cC, 560, "Accept or reject\nthe hold")
edge((1150 + s1[2]/2, 560), (cC - a5[2]/2, 560))
diamond(cP, 630)
edge((cC, 560 + a5[3]/2), (cC, 630), (cP + 14, 630))
edge((cP, 514), (cP, 616)); guard(cP - 8, 560, "[else]", "end")
diamond(cP, 690); edge((cP, 644), (cP, 676))
a6 = action(700, 750, "Apply platform hold:\nblock other Drivers' starts")
edge((cP-14, 690), (700, 690), (700, 750 - a6[3]/2)); guard(690, 708, "[not supported\nor rejected]", "end")
diamond(cP, 815)
edge((700, 750 + a6[3]/2), (700, 815), (cP - 14, 815))
edge((cP+14, 690), (1040, 690), (1040, 815), (cP + 14, 815)); guard(cP + 20, 680, "[hold accepted by Charge Point]")
a7 = action(cP, 875, "Show connector \"Reserved until\nHH:MM\" to all Drivers")
edge((cP, 829), (cP, 875 - a7[3]/2))

# ---------- interruptible activity region ----------
RX0, RX1, RY0, RY1 = 450, 1385, 935, 1120
out.append(f'<rect x="{RX0}" y="{RY0}" width="{RX1-RX0}" height="{RY1-RY0}" rx="16" fill="none" '
           f'stroke="black" stroke-width="1.2" stroke-dasharray="7,5"/>')
xs = {"cancel": 600, "time": 845, "void": 1055, "start": 1270}
bar(xs["cancel"] - 40, xs["start"] + 40, 965)
edge((cP, 875 + a7[3]/2), (cP, 962))
YA = 1035
e_c = accept(xs["cancel"], YA, "Driver cancels")
hourglass(xs["time"], YA - 12); text(xs["time"], YA + 26, "after hold window\n(15 min default)", 12)
e_v = accept(xs["void"], YA, "Connector faulted,\noffline or taken, or\nOperator cancels")
e_s = accept(xs["start"], YA, "Driver starts a session\non this Charge Point")
edge((xs["cancel"], 968), (xs["cancel"], YA - e_c[3]/2))
edge((xs["time"], 968), (xs["time"], YA - 26))
edge((xs["void"], 968), (xs["void"], YA - e_v[3]/2))
edge((xs["start"], 968), (xs["start"], YA - e_s[3]/2))

# ---------- outcomes (interrupting edges leave the region) ----------
Y1 = 1200
# cancel
diamond(xs["cancel"], Y1)
y = lightning(xs["cancel"], YA + e_c[3]/2, Y1 - 14); edge((xs["cancel"], y), (xs["cancel"], Y1 - 14))
of = objnode(525, 1275, "Reservation\n[cancelled_free]")
ol = objnode(685, 1275, "Reservation\n[cancelled_late]")
edge((xs["cancel"] - 14, Y1), (525, Y1), (525, 1275 - of[3]/2)); guard(520, Y1 - 10, "[≥ 5 min\nbefore expiry]", "end")
edge((xs["cancel"] + 14, Y1), (685, Y1), (685, 1275 - ol[3]/2)); guard(xs["cancel"] + 20, Y1 - 10, "[last 5 min]")
diamond(xs["cancel"], 1345)
edge((525, 1275 + of[3]/2), (525, 1345), (xs["cancel"] - 14, 1345))
edge((685, 1275 + ol[3]/2), (685, 1345), (xs["cancel"] + 14, 1345))
# no-show
oe = objnode(xs["time"], 1275, "Reservation\n[expired_no_show]")
y = lightning(xs["time"], YA + 40, 1275 - oe[3]/2); edge((xs["time"], y), (xs["time"], 1275 - oe[3]/2))
# void
av = action(xs["void"], 1210, "Notify Driver with up to\nthree alternatives (no fee)")
y = lightning(xs["void"], YA + e_v[3]/2, 1210 - av[3]/2); edge((xs["void"], y), (xs["void"], 1210 - av[3]/2))
ov = objnode(xs["void"], 1290, "Reservation\n[voided]")
edge((xs["void"], 1210 + av[3]/2), (xs["void"], 1290 - ov[3]/2))
# fulfilled
ofu = objnode(xs["start"], 1200, "Reservation\n[fulfilled]")
y = lightning(xs["start"], YA + e_s[3]/2, 1200 - ofu[3]/2); edge((xs["start"], y), (xs["start"], 1200 - ofu[3]/2))
cb = action(xs["start"], 1280, "Continue as \"Charge a\nvehicle\" ⋔ (AD-1)")
edge((xs["start"], 1200 + ofu[3]/2), (xs["start"], 1280 - cb[3]/2))
final(xs["start"], 1350); edge((xs["start"], 1280 + cb[3]/2), (xs["start"], 1338))

# ---------- fee and release ----------
M5 = 1400
diamond(xs["time"], M5)
edge((xs["cancel"], 1359), (xs["cancel"], M5), (xs["time"] - 14, M5))
edge((xs["time"], 1275 + oe[3]/2), (xs["time"], M5 - 14))
edge((xs["void"], 1290 + ov[3]/2), (xs["void"], M5), (xs["time"] + 14, M5))
D5 = 1460
diamond(xs["time"], D5); edge((xs["time"], M5 + 14), (xs["time"], D5 - 14))
a9 = action(xs["time"], 1530, "Debit reservation fee (no-show\n20,000 VND, late cancel 50%)")
edge((xs["time"], D5 + 14), (xs["time"], 1530 - a9[3]/2)); guard(xs["time"] - 8, D5 + 30, "[cancelled late\nor no-show]", "end")
oc = objnode(xs["time"], 1605, "CreditTransaction\n[reservation_fee]")
edge((xs["time"], 1530 + a9[3]/2), (xs["time"], 1605 - oc[3]/2))
D6 = 1665
diamond(xs["time"], D6); edge((xs["time"], 1605 + oc[3]/2), (xs["time"], D6 - 14))
osf = objnode(xs["time"], 1735, "CreditAccount\n[in_shortfall]")
edge((xs["time"], D6 + 14), (xs["time"], 1735 - osf[3]/2)); guard(xs["time"] - 8, D6 + 32, "[balance < 0: new starts\nblocked until top-up]", "end")
M6 = 1800
diamond(xs["time"], M6); edge((xs["time"], 1735 + osf[3]/2), (xs["time"], M6 - 14))
edge((xs["time"] + 14, D6), (980, D6), (980, M6), (xs["time"] + 14, M6)); guard(xs["time"] + 20, D6 - 10, "[else]")
M7 = 1855
diamond(xs["time"], M7); edge((xs["time"], M6 + 14), (xs["time"], M7 - 14))
edge((xs["time"] + 14, D5), (1140, D5), (1140, M7), (xs["time"] + 14, M7)); guard(xs["time"] + 20, D5 - 10, "[no fee]")
s2 = send(xs["time"], 1920, "Release the hold and show\nconnector Available")
edge((xs["time"], M7 + 14), (xs["time"], 1920 - s2[3]/2))
a10 = action(cC, 1920, "Release connector hold\n(if held here)")
edge((xs["time"] + s2[2]/2, 1920), (cC - a10[2]/2, 1920))
final(cC, 1980); edge((cC, 1920 + a10[3]/2), (cC, 1968))

svg = (f'<svg xmlns="http://www.w3.org/2000/svg" width="{W}" height="{H}" viewBox="0 0 {W} {H}">'
       '<defs><marker id="arr" markerWidth="10" markerHeight="10" refX="9" refY="5" orient="auto" '
       'markerUnits="userSpaceOnUse"><path d="M0,0 L10,5 L0,10 L3,5 z" fill="black"/></marker></defs>'
       + "".join(out) + "</svg>")
open("AD-4.svg", "w", encoding="utf-8").write(svg)
print("ok", W, H)
