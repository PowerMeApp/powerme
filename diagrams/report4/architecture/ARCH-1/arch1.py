# ARCH-1 — UML 2.5 component diagram of the PowerMe Platform (hand-placed SVG)
import html, math
W, H = 1900, 1350
e = lambda s: html.escape(s)
FONT = "Arial, Helvetica, sans-serif"
INK = "#1F2D3D"; GREY = "#5E6B78"; LINE = "#34495E"
DOM = {  # fill, border
 "api":      ("#E4EEFA", "#2F6FB0"),
 "network":  ("#E3F3E8", "#23864A"),
 "charging": ("#FDF0DC", "#B9730F"),
 "billing":  ("#EFE5F6", "#7D3C98"),
 "platform": ("#DFF1EE", "#138D75"),
 "client":   ("#F3F6FA", "#2F6FB0"),
 "external": ("#FFFFFF", "#6C7A89"),
}
out = []; segs = []          # segs: drawn connector segments for hop detection
def T(x, y, s, size=13, weight="normal", anchor="middle", fill=INK, style="normal"):
    out.append(f'<text x="{x:.1f}" y="{y:.1f}" font-family="{FONT}" font-size="{size}" font-weight="{weight}" font-style="{style}" text-anchor="{anchor}" fill="{fill}">{e(s)}</text>')
def icon(x, y, col):   # UML component icon, top-right corner at (x, y)
    out.append(f'<rect x="{x-16}" y="{y}" width="14" height="17" fill="white" stroke="{col}" stroke-width="1.2"/>')
    out.append(f'<rect x="{x-20}" y="{y+3}" width="8" height="4" fill="white" stroke="{col}" stroke-width="1.2"/>')
    out.append(f'<rect x="{x-20}" y="{y+10}" width="8" height="4" fill="white" stroke="{col}" stroke-width="1.2"/>')
BOX = {}
def comp(key, x, y, w, h, name, dom, stereo="«component»", sub=None, planned=False):
    fill, col = DOM[dom]
    dash = ' stroke-dasharray="7 4"' if planned else ''
    out.append(f'<rect x="{x}" y="{y}" width="{w}" height="{h}" rx="4" fill="{fill}" stroke="{col}" stroke-width="1.6"{dash}/>')
    icon(x + w - 6, y + 6, col)
    cy = y + 22
    T(x + w / 2, cy, stereo + ("  «planned»" if planned else ""), 11.5, fill=GREY); cy += 18
    for k, nm in enumerate(name.split("\n")):
        if k: cy += 17
        T(x + w / 2, cy, nm, 14, "bold")
    for s in (sub or []):
        cy += 16; T(x + w / 2, cy, s, 11.5, fill=GREY)
    BOX[key] = (x, y, w, h)
def poly(pts, color=LINE, width=1.4, dash=None, record=True):
    d = []
    for i, (x, y) in enumerate(pts):
        if i == 0: d.append(f"M{x},{y}"); continue
        px, py = pts[i - 1]
        if py == y and record:   # horizontal: add hops over earlier vertical segments
            step = 1 if x > px else -1
            hops = sorted([sx for (sx, sy1, sy2, kind) in segs if kind == 'v' and min(px, x) + 8 < sx < max(px, x) - 8 and min(sy1, sy2) < y < max(sy1, sy2)], reverse=(step < 0))
            for hx in hops:
                d.append(f"L{hx - 6*step},{y}")
                d.append(f"A6,6 0 0 {1 if step > 0 else 0} {hx + 6*step},{y}")
        d.append(f"L{x},{y}")
    dd = f' stroke-dasharray="{dash}"' if dash else ''
    out.append(f'<path d="{" ".join(d)}" fill="none" stroke="{color}" stroke-width="{width}"{dd}/>')
    if record:
        for (ax, ay), (bx, by) in zip(pts, pts[1:]):
            if ax == bx: segs.append((ax, ay, by, 'v'))
            else: segs.append((ay, ax, bx, 'h'))
def ball(x, y, r=8):
    out.append(f'<circle cx="{x}" cy="{y}" r="{r}" fill="white" stroke="{LINE}" stroke-width="1.6"/>')
def socket(x, y, direction, r=13):
    # arc of radius r around the ball centre (x,y), opening towards `direction` the provider side
    a = {'right': 0, 'left': 180, 'down': 90, 'up': 270}[direction]
    a1, a2 = math.radians(a - 75), math.radians(a + 75)
    # the open side faces the provider: draw the arc on the opposite side
    b1, b2 = math.radians(a + 105), math.radians(a + 255)
    x1, y1 = x + r * math.cos(b1), y + r * math.sin(b1); x2, y2 = x + r * math.cos(b2), y + r * math.sin(b2)
    out.append(f'<path d="M{x1:.1f},{y1:.1f} A{r},{r} 0 0 1 {x2:.1f},{y2:.1f}" fill="none" stroke="{LINE}" stroke-width="1.6"/>')
def label(x, y, name, proto=None, anchor="middle"):
    T(x, y, name, 12, "bold", anchor)
    if proto: T(x, y + 14, proto, 10.5, fill=GREY, anchor=anchor)
def assembly(req_pts, prov_pts, at, direction, name, proto=None, lab=(0, 24), anchor="middle"):
    """req_pts: path from the requiring component to the socket; prov_pts: path from the providing component to the ball.
    at = ball centre; direction = where the provider is, seen from the ball"""
    poly(req_pts); poly(prov_pts)
    ball(*at); socket(*at, direction)
    label(at[0] + lab[0], at[1] + lab[1], name, proto, anchor)
def port(x, y):
    out.append(f'<rect x="{x-7}" y="{y-7}" width="14" height="14" fill="#2C3E50" stroke="#2C3E50"/>')

# ---------------- frame and title
out.append(f'<rect width="{W}" height="{H}" fill="white"/>')
T(40, 44, "ARCH-1 (Software level) — UML component diagram of the PowerMe Platform", 22, "bold", "start")
T(40, 68, "One deployable component (CSMS back end) with its internal components, ports, provided and required interfaces, and the clients and external systems it is assembled with · v2.2 · 10/11/2026", 13, anchor="start", fill=GREY)

# ---------------- CSMS (outer component)
X0, Y0, X1, Y1 = 420, 78, 1400, 1020
out.append(f'<rect x="{X0}" y="{Y0}" width="{X1-X0}" height="{Y1-Y0}" rx="6" fill="#F6F8FA" stroke="#2C3E50" stroke-width="2.2"/>')
icon(X1 - 8, Y0 + 8, "#2C3E50")
T((X0 + X1) / 2, Y0 + 22, "«component»", 12, fill=GREY)
T((X0 + X1) / 2, Y0 + 41, "CSMS back end  [NestJS 12 · Node.js 24 · modular monolith, ADR-0002]", 15, "bold")

# ---------------- internal components
comp("drv", 470, 200, 200, 80, "driver-api", "api", sub=["/api/driver/v1: search, places,", "route (#98); charge «planned»"])
comp("usr", 470, 350, 200, 78, "users", "platform", sub=["accounts, roles (driver JWT", "check is in driver-api, #98)"], planned=True)
comp("opr", 470, 490, 200, 80, "operator-api", "api", sub=["REST for dashboard / console"], planned=True)
comp("ocpp", 470, 760, 200, 100, "ocpp-gateway", "network", sub=["OCPP 1.6J server, epochs,", "message log, replay detector"])
comp("sug", 790, 185, 210, 75, "suggestions", "platform", sub=["smart ranking (#98);", "time left «planned»"])
comp("ses", 790, 330, 210, 90, "sessions", "charging", sub=["STM-1, start / stop,", "settlement job"])
comp("rec", 790, 500, 210, 75, "reconciliation", "charging", sub=["replay, gaps, conflicts (RQ1)"])
comp("sta", 790, 640, 210, 90, "stations", "network", sub=["charge points, onboarding,", "faults (STM-3, STM-6)"])
comp("tar", 1120, 175, 230, 60, "tariffs", "billing", sub=["time-of-day prices"], planned=True)
comp("bil", 1120, 290, 230, 190, "billing", "billing", sub=["in code: Charging Credit ledger,", "loyalty earn, STM-4 / STM-10;", "«planned»: top-ups, refunds,", "e-invoices, revenue report"])
comp("db", 1110, 870, 135, 70, "db", "platform", sub=["Drizzle ORM"])
comp("job", 1255, 870, 135, 70, "jobs", "platform", sub=["DB polling (D7)"])
comp("con", 470, 600, 200, 80, "console", "api", sub=["operator HTTP :3000,", "loopback, no login yet"])
T(1250, 962, "used by every module (uses not drawn)", 11, fill=GREY, style="italic")

# vertical hop support: redefine poly to hop on either orientation
def poly(pts, color=LINE, width=1.4, dash=None, record=True):
    d = []
    for i, (x, y) in enumerate(pts):
        if i == 0: d.append(f"M{x},{y}"); continue
        px, py = pts[i - 1]
        if record and py == y:
            st = 1 if x > px else -1
            hs = sorted([sx for (sx, a, b, k) in segs if k == 'v' and min(px, x) + 9 < sx < max(px, x) - 9 and min(a, b) + 2 < y < max(a, b) - 2], reverse=(st < 0))
            for hx in hs: d += [f"L{hx-6*st},{y}", f"A6,6 0 0 {1 if st>0 else 0} {hx+6*st},{y}"]
        elif record and px == x:
            st = 1 if y > py else -1
            hs = sorted([sy for (sy, a, b, k) in segs if k == 'h' and min(py, y) + 9 < sy < max(py, y) - 9 and min(a, b) + 2 < x < max(a, b) - 2], reverse=(st < 0))
            for hy in hs: d += [f"L{x},{hy-6*st}", f"A6,6 0 0 {0 if st>0 else 1} {x},{hy+6*st}"]
        d.append(f"L{x},{y}")
    dd = f' stroke-dasharray="{dash}"' if dash else ''
    out.append(f'<path d="{" ".join(d)}" fill="none" stroke="{color}" stroke-width="{width}"{dd}/>')
    if record:
        for (ax, ay), (bx, by) in zip(pts, pts[1:]):
            if ax == bx: segs.append((ax, ay, by, 'v'))
            elif ay == by: segs.append((ay, ax, bx, 'h'))
def assembly(req, prov, at, direction, name, proto=None, lab=(0, 24), anchor="middle"):
    poly(req); poly(prov); ball(*at); socket(*at, direction); label(at[0] + lab[0], at[1] + lab[1], name, proto, anchor)

# ---------------- internal assembly connectors (requirer path ends at the socket, provider path ends at the ball)
assembly([(670, 222), (720, 222)], [(790, 222), (733, 222)], (733, 222), 'right', "IStationSearch", lab=(0, -14))
assembly([(670, 262), (745, 262), (745, 288)], [(790, 372), (745, 372), (745, 301)], (745, 301), 'down', "IChargingControl", lab=(-12, 4), anchor="end")
assembly([(560, 200), (560, 150), (900, 150)], [(1120, 305), (1090, 305), (1090, 150), (913, 150)], (913, 150), 'right', "ICreditAccount", lab=(0, -12))
assembly([(540, 280), (540, 307)], [(540, 350), (540, 320)], (540, 320), 'down', "IAuth", lab=(14, 4), anchor="start")
assembly([(540, 490), (540, 463)], [(540, 428), (540, 450)], (540, 450), 'up', "IAuth", lab=(14, 4), anchor="start")
assembly([(1000, 350), (1047, 350)], [(1120, 350), (1060, 350)], (1060, 350), 'right', "ISettlement", lab=(0, -14))
assembly([(895, 420), (895, 447)], [(895, 500), (895, 460)], (895, 460), 'down', "IReconcile", lab=(14, 4), anchor="start")
assembly([(1235, 290), (1235, 262)], [(1235, 235), (1235, 249)], (1235, 249), 'up', "IPricing", lab=(14, 4), anchor="start")
# ocpp-gateway -> sessions / stations, stations -> ocpp-gateway (drawn before the operator connectors so they hop over these)
assembly([(670, 775), (752, 775), (752, 472)], [(820, 420), (820, 485), (765, 485)], (752, 485), 'right', "ISessionEvents", lab=(-12, -2), anchor="end")
assembly([(670, 805), (775, 805), (775, 768)], [(790, 705), (775, 705), (775, 755)], (775, 755), 'up', "IStationEvents", lab=(-12, -14), anchor="end")
assembly([(895, 730), (895, 840), (713, 840)], [(670, 840), (700, 840)], (700, 840), 'left', "IRemoteCommand", lab=(0, 24))
assembly([(670, 515), (712, 515), (712, 600), (1047, 600)], [(1120, 440), (1075, 440), (1075, 600), (1060, 600)], (1060, 600), 'right', "IBillingAdmin", lab=(-4, 22))
assembly([(670, 548), (690, 548), (690, 672)], [(790, 685), (690, 685)], (690, 685), 'up', "IChargePointAdmin", lab=(-12, 18), anchor="end")

# ---------------- ports, delegation and assembly with clients / external systems
def ext(x, y, w, h, name, stereo, sub=None, dom="external", planned=False):
    comp(name, x, y, w, h, name, dom, stereo, sub, planned)
# left: clients and charge point
ext(20, 195, 230, 90, "Driver App", "«component»", ["Flutter, Android / iOS"], "client")
ext(20, 480, 230, 100, "Operator Dashboard &\nAdmin Console", "«component»", ["React + Vite, browser"], "client", planned=True)
ext(20, 760, 230, 110, "Charge Point", "«external system»", ["D1 / YJ-EU, OCPP 1.6J", "(simulator in tests)"])
def left_provided(y, inner_x, name, proto):    # CSMS provides at a left port; client requires
    port(420, y); poly([(427, y), (inner_x, y)]); poly([(413, y), (348, y)]); ball(340, y)
    poly([(250, y), (326, y)]); socket(340, y, 'right'); label(335, y - 20, name, None); T(335, y + 26, proto, 10.5, fill=GREY)
left_provided(240, 470, "IDriverAPI", "HTTPS / JSON")
left_provided(530, 470, "IOperatorAPI", "HTTPS / JSON")
left_provided(790, 470, "IOcppCentralSystem", "OCPP 1.6J over WSS")
# console: provided on a loopback port only (no client assembled; Iteration 1)
port(420, 640); poly([(427, 640), (470, 640)]); poly([(413, 640), (348, 640)]); ball(340, 640)
label(335, 620, "IConsole", None); T(335, 666, "HTTP, 127.0.0.1 only", 10.5, fill=GREY)
# CSMS requires the charge point's interface (remote commands)
port(420, 845); poly([(427, 845), (470, 845)]); poly([(413, 845), (353, 845)]); socket(340, 845, 'left'); poly([(250, 845), (332, 845)]); ball(340, 845)
label(335, 872, "IOcppChargePoint", None); T(335, 886, "remote start / stop / reset", 10.5, fill=GREY)
# right: external systems used by billing
ext(1560, 265, 290, 125, "Payment Gateway", "«external system»", ["VNPay sandbox"])
ext(1560, 425, 290, 70, "E-Invoice Provider", "«external system»", ["licensed provider, sandbox"])
ext(1560, 530, 290, 70, "Push Notification Service", "«external system»", ["FCM"])
def right_required(y, inner_pts, name, proto, ext_x=1560):   # CSMS requires at a right port; external provides
    port(1400, y); poly(inner_pts + [(1393, y)]); poly([(1407, y), (1467, y)]); socket(1480, y, 'right')
    poly([(ext_x, y), (1488, y)]); ball(1480, y); label(1480, y - 18, name, None); T(1480, y + 26, proto, 10.5, fill=GREY)
def right_provided(y, inner_pts, name, proto, ext_x=1560):   # CSMS provides at a right port; external requires
    port(1400, y); poly(inner_pts + [(1393, y)]); poly([(1407, y), (1472, y)]); ball(1480, y)
    poly([(ext_x, y), (1494, y)]); socket(1480, y, 'left'); label(1480, y - 18, name, None); T(1480, y + 26, proto, 10.5, fill=GREY)
right_required(295, [(1350, 295)], "IPaymentGateway", "pay, query, refund")
right_provided(365, [(1350, 365)], "IPaymentNotification", "signed IPN")
right_required(460, [(1350, 425), (1372, 425), (1372, 460)], "IEInvoice", "issue, adjust")
right_required(565, [(1350, 465), (1385, 465), (1385, 565)], "IPushNotification", "HTTPS")
# top: map and routing for suggestions
ext(815, -30, 300, 70, "Vietmap Maps API v4", "«external system»", ["map & routing: places, route (#98)"])
port(965, 78); poly([(965, 185), (965, 85)]); poly([(965, 71), (965, 66)]); socket(965, 58, 'up'); poly([(965, 40), (965, 50)]); ball(965, 58)
T(985, 62, "IRouting", 12, "bold", "start")
# bottom: database and job queue
ext(1070, 1080, 210, 75, "PostgreSQL 16", "«external system»", ["44 tables, partitions"])
ext(1295, 1080, 215, 75, "Redis 7.4", "«external system»", ["BullMQ queue"], planned=True)
port(1177, 1020); poly([(1177, 940), (1177, 1013)]); poly([(1177, 1027), (1177, 1037)]); socket(1177, 1050, 'down'); poly([(1177, 1080), (1177, 1058)]); ball(1177, 1050)
T(1165, 1054, "ISQL", 12, "bold", "end")
port(1322, 1020); poly([(1322, 940), (1322, 1013)], dash="6 4"); poly([(1322, 1027), (1322, 1037)], dash="6 4"); socket(1322, 1050, 'down'); poly([(1375, 1080), (1375, 1068), (1322, 1068), (1322, 1058)], dash="6 4"); ball(1322, 1050)
T(1340, 1054, "IJobQueue «planned»", 12, "bold", "start")

# ---------------- legend
LX, LY = 20, 1060
out.append(f'<rect x="{LX}" y="{LY}" width="900" height="132" rx="6" fill="white" stroke="#AAB4BE"/>')
T(LX + 14, LY + 24, "Legend (UML 2.5 component notation)", 13, "bold", "start")
ball(LX + 30, LY + 50); poly([(LX + 38, LY + 50), (LX + 60, LY + 50)], record=False); T(LX + 70, LY + 54, "provided interface (ball)", 12, anchor="start")
socket(LX + 30, LY + 80, 'left'); poly([(LX + 43, LY + 80), (LX + 60, LY + 80)], record=False); T(LX + 70, LY + 84, "required interface (socket)", 12, anchor="start")
port(LX + 30, LY + 110); T(LX + 70, LY + 114, "port on the component boundary", 12, anchor="start")
T(LX + 330, LY + 54, "ball inside socket = assembly connector", 12, anchor="start"); T(LX + 330, LY + 84, "line from a port to a part = delegation", 12, anchor="start"); T(LX + 330, LY + 114, "a line crossing another jumps over it (hop)", 12, anchor="start")
for i, (k, n) in enumerate([("api", "API adapters"), ("network", "charge-point network"), ("charging", "charging sessions"), ("billing", "billing & pricing"), ("platform", "platform services")]):
    fx = LX + 640 + (i // 3) * 0; fy = LY + 30 + i * 18
    fill, col = DOM[k]; out.append(f'<rect x="{fx}" y="{fy-11}" width="22" height="14" fill="{fill}" stroke="{col}" stroke-width="1.4"/>'); T(fx + 30, fy, n, 11.5, anchor="start")
out.append(f'<rect x="{LX+640}" y="{LY+109}" width="22" height="12" fill="white" stroke="{GREY}" stroke-width="1.4" stroke-dasharray="5 3"/>'); T(LX + 670, LY + 119, "«planned»: designed, not in code yet", 11.5, anchor="start")
T(W - 30, 1200, "Owner: Trần Đức Ân (WP1) with Ngô Văn Minh Trí (WP2) · names = PKG-1 modules (GitHub main 0ba20c4) · deployment view: ARCH-2", 11, fill=GREY, anchor="end")

body = "\n".join(out)
svg = f'<svg xmlns="http://www.w3.org/2000/svg" width="{W}" height="{H}" viewBox="0 0 {W} {H}">\n<rect width="{W}" height="{H}" fill="white"/>\n'
# title stays at the top, everything else is shifted down by 110
title_end = body.index('<rect x="420"')
svg += body[:title_end] + f'<g transform="translate(0,125)">' + body[title_end:] + '</g></svg>'
open('ARCH-1.svg', 'w').write(svg)
