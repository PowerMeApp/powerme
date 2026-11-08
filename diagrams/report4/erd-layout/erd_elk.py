# PowerMe ERDs (conceptual / logical / physical) laid out with ELK layered + orthogonal routing.
# Every relationship end gets its own port, so crow's feet never share a point; ELK minimises crossings and puts
# related tables next to each other (domain = header colour, no frames forcing tables apart).
# Usage: python3 erd_elk.py LEVEL [direction] [seed] [thoroughness] -> erd-LEVEL.svg, prints crossings
import sys, json, subprocess, html, collections, os, math
from PIL import ImageFont
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from model import ENTITIES, REL, WEAK, ASSOC, SHOULD, SUBTYPES
from lmodel import ATTR
LEVEL = sys.argv[1]; DIR = sys.argv[2] if len(sys.argv) > 2 else "RIGHT"
SEED = int(sys.argv[3]) if len(sys.argv) > 3 else 1; THO = int(sys.argv[4]) if len(sys.argv) > 4 else 60
OUT = os.environ.get("OUT", f"erd-{LEVEL}.svg")
FR = "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf"; FB = "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf"
_f = {}
def tw(s, n, b=False):
    k = (n, b)
    if k not in _f: _f[k] = ImageFont.truetype(FB if b else FR, n)
    return _f[k].getlength(s)
e = lambda s: html.escape(str(s), quote=True)
INK, GREY, LINE = "#1F2D3D", "#5E6B78", "#46525E"
DOMAIN = {  # domain -> (colour, label, logical entities)
 "people":   ("#2F80C9", "People & vehicles", ["User", "Admin", "OperatorStaff", "Driver", "Vehicle", "VehicleModel", "RfidCard"]),
 "network":  ("#219653", "Charging network & operations", ["Operator", "Site", "ChargePoint", "Connector", "ConnectorStatusEvent",
                                                           "RemoteCommand", "FaultEvent", "FaultReport", "MaintenanceTicket"]),
 "pricing":  ("#138D75", "Pricing & promotions", ["TariffPeriod", "Promotion", "PolicyTemplate"]),
 "charging": ("#D68910", "Charging sessions", ["Reservation", "ChargingSession", "SessionPause", "SessionStatusChange",
                                              "MeterReading", "SessionTariffSegment", "ReconciliationRecord"]),
 "billing":  ("#7D3C98", "Billing & loyalty", ["CreditAccount", "CreditTransaction", "TopUp", "EInvoice", "InvoiceAdjustment", "Refund",
                                              "LoyaltyAccount", "LoyaltyTransaction"]),
 "technical": ("#6C7A89", "Technical (operation only)", []),
}
COL = {n: c for _, (c, _, ns) in DOMAIN.items() for n in ns}
# ---------------- model per level ----------------
HF, RF, SF = 24, 18, 15          # header, row, small font sizes (px)
ROWH, HDRH, PADX = 30, 46, 14
nodes, edges = [], []            # nodes: dict(id, w, h, kind, ...); edges: dict(id, s, t, sc, tc, ident, label)
if LEVEL.startswith("physical"):
    M = json.load(open(os.path.join(os.path.dirname(os.path.abspath(__file__)), "pmodel.json")))
    TABLE, TECH, ROWS, FKS = M["TABLE"], M["TECH"], M["ROWS"], M["FKS"]
    CONS = collections.defaultdict(list, M["CONS"])
    ENT_OF = {v: k for k, v in TABLE.items()}
    for t in TECH: COL[t] = DOMAIN["technical"][0]
    for t, n in ENT_OF.items(): COL[t] = COL[n]
    NN = {(t, r["name"]): r["nn"] for t in ROWS for r in ROWS[t]}
    BIZ = list(TABLE.values())
    if LEVEL == "physical":
        SHOW, STUB = BIZ + TECH, []
    elif LEVEL == "physical-biz":
        SHOW, STUB = BIZ, []
    else:   # technical page: technical tables + the business tables they reference, shown as key-only stubs
        SHOW = TECH
        STUB = sorted({f["ref"] for f in FKS if f["table"] in TECH and f["ref"] not in TECH})
    for t in STUB:
        pk = next(c["cols"] for c in CONS[t] if c["type"] == "p")
        rows = [[(c, RF, True, INK), (next(r["type"] for r in ROWS[t] if r["name"] == c), SF, False, GREY), ("PK", SF - 2, True, COL[t]), ("", SF - 2, False, GREY)] for c in pk]
        nodes.append(dict(id=t, title=t, rows=rows, weak=False, tag="see sheet 1"))
    for t in SHOW:
        pk = next(c["cols"] for c in CONS[t] if c["type"] == "p")
        rows = []
        for r in ROWS[t]:
            b = [x for x in r["key"].split(",") if x]
            if r["nn"] and r["name"] not in pk: b.append("NN")
            d = {"identity": "identity", "sequence": "nextval"}.get(r["default"], r["default"])
            rows.append([(r["name"], RF, r["name"] in pk, INK), (r["type"], SF, False, GREY), (" ".join(b), SF - 2, True, COL[t]), (d, SF - 2, False, GREY)])
        nodes.append(dict(id=t, title=t, rows=rows, weak=t in {TABLE[x] for x in WEAK}, tag="technical" if t in TECH else ""))
    UQ = lambda t, cols: any(c["type"] in "up" and sorted(c["cols"]) == sorted(cols) for c in CONS[t])
    shown = set(SHOW) | set(STUB)
    for f in FKS:
        ch, pa = f["table"], f["ref"]
        if ch not in SHOW or pa not in shown: continue
        pk = next(c["cols"] for c in CONS[ch] if c["type"] == "p")
        edges.append(dict(id=f["name"], s=pa, t=ch, sc="1" if all(NN[(ch, c)] for c in f["cols"]) else "0..1",
                          tc="0..1" if UQ(ch, f["cols"]) else "0..N", ident=set(f["cols"]) <= set(pk), label=""))
    TITLE = "Physical ERD — PowerMe Platform (PostgreSQL 16)"
    LEG = ["Drawn from powerme_physical.dbml. Columns: name · type · PK primary key, FK foreign key, UQ unique (UQ1/UQ2 = parts of one composite unique), NN not null · default.",
           "CHECK constraints, indexes, delete rules, partial indexes and partitions are in the DBML and the DDL. Each line runs from the referenced table (PK) to the table holding the FK."]
else:
    for n in ENTITIES:
        tag = ", ".join(x for x, s in (("weak", WEAK), ("associative", ASSOC), ("Should", SHOULD)) if n in s)
        rows = [] if LEVEL == "conceptual" else [[(a, RF, "PK" in k, INK), (ty, SF, False, GREY), (k.replace(",", " "), SF - 2, True, COL[n])]
                                                 for k, a, ty in ATTR[n]]
        nodes.append(dict(id=n, title=("◇ " if n in ASSOC else "") + n, rows=rows, weak=n in WEAK, tag=tag))
    for k, (a, v, b, ca, cb, ident) in enumerate(REL):
        edges.append(dict(id=f"r{k}", s=a, t=b, sc=ca, tc=cb, ident=bool(ident), label=v if LEVEL == "conceptual" else ""))
    if LEVEL == "conceptual":
        nodes.append(dict(id="ISA", title="", rows=[], weak=False, tag="", isa=True))
        edges.append(dict(id="isa_u", s="ISA", t="User", sc="", tc="tri", ident=True, label=""))
        for s in SUBTYPES: edges.append(dict(id=f"isa_{s}", s=s, t="ISA", sc="", tc="", ident=True, label=""))
        TITLE = "Conceptual ERD — PowerMe Platform"
        LEG = ["Entities and named relationships only (no keys, no data types). The verb on each line reads from the entity at the plain end towards the other entity.",
               "Generalization: User is exactly one of Admin, OperatorStaff, Driver (disjoint, total)."]
    else:
        for s in SUBTYPES: edges.append(dict(id=f"isa_{s}", s="User", t=s, sc="1", tc="0..1", ident=True, label=""))
        TITLE = "Logical ERD — PowerMe Platform"
        LEG = ["Tables with PK / FK / UK (UK1, UK2 = parts of one composite unique key) and generic types; /Name = derived value kept as a snapshot.",
               "Each line runs from the parent (PK) to the table holding the FK. Generalization = one table per subtype, PK = FK to User (1 : 0..1)."]
# ---------------- sizes ----------------
for n in nodes:
    if n.get("isa"): n["w"], n["h"] = 70, 60; continue
    tw_title = tw(n["title"], HF, True) + 2 * PADX + (tw(n["tag"], SF) + 20 if n["tag"] and n["rows"] else 0)
    if not n["rows"]:
        n["w"] = max(tw_title, tw(n["tag"], SF) + 2 * PADX, 170); n["h"] = 64 if n["tag"] else 52
    else:
        ncol = len(n["rows"][0])
        cw = [max(tw(r[i][0], r[i][1], r[i][2]) for r in n["rows"]) + 22 for i in range(ncol)]
        n["cw"] = cw; n["w"] = max(sum(cw) + 8, tw_title); n["h"] = HDRH + len(n["rows"]) * ROWH + 8
    if n["weak"]: n["w"] += 12; n["h"] += 12
# hubs need room so that every line end (and its crow's foot) gets its own place on the box side
DEG = collections.Counter([ed["s"] for ed in edges] + [ed["t"] for ed in edges])
for n in nodes:
    if n.get("isa"): continue
    need = 40 * math.ceil(DEG[n["id"]] / 2) + 24
    if n["h"] < need:
        n["pad"] = need - n["h"]; n["h"] = need
# ---------------- ELK graph ----------------
LO = {
 "elk.algorithm": "layered", "elk.direction": DIR, "elk.edgeRouting": "ORTHOGONAL",
 "elk.randomSeed": str(SEED), "elk.layered.thoroughness": str(THO),
 "elk.spacing.nodeNode": "70", "elk.layered.spacing.nodeNodeBetweenLayers": "150",
 "elk.spacing.edgeEdge": "26", "elk.layered.spacing.edgeEdgeBetweenLayers": "26",
 "elk.spacing.edgeNode": "40", "elk.layered.spacing.edgeNodeBetweenLayers": "60",
 "elk.spacing.portPort": "34", "elk.spacing.edgeLabel": "6",
 "elk.layered.crossingMinimization.strategy": "LAYER_SWEEP",
 "elk.layered.crossingMinimization.greedySwitch.type": "TWO_SIDED",
 "elk.layered.nodePlacement.strategy": os.environ.get("NP", "NETWORK_SIMPLEX"),
 "elk.layered.mergeEdges": "false", "elk.edgeLabels.placement": "CENTER",
 "elk.layered.unnecessaryBendpoints": "true",
 "elk.layered.nodePlacement.favorStraightEdges": "true",
}
if os.environ.get("ASPECT"): LO.update({"elk.aspectRatio": os.environ["ASPECT"], "elk.layered.wrapping.strategy": "MULTI_EDGE"})
g = {"id": "root", "layoutOptions": LO, "children": [], "edges": []}
import random
if os.environ.get("SHUF"):
    rnd = random.Random(int(os.environ["SHUF"])); rnd.shuffle(nodes); rnd.shuffle(edges)
for n in nodes:
    ports = [{"id": f"{n['id']}::{ed['id']}::{end}", "width": 1, "height": 1}
             for ed in edges for end, nid in (("s", ed["s"]), ("t", ed["t"])) if nid == n["id"]]
    g["children"].append({"id": n["id"], "width": n["w"], "height": n["h"], "ports": ports,
                          "layoutOptions": {"elk.portConstraints": "FREE", "elk.spacing.portPort": "38"}})
for ed in edges:
    E = {"id": ed["id"], "sources": [f"{ed['s']}::{ed['id']}::s"], "targets": [f"{ed['t']}::{ed['id']}::t"]}
    if ed["label"]:
        E["labels"] = [{"text": ed["label"], "width": tw(ed["label"], 17, ed["ident"]) + 12, "height": 24}]
    g["edges"].append(E)
import tempfile
_HERE = os.path.dirname(os.path.abspath(__file__))
_G = os.path.join(tempfile.gettempdir(), f"g_{LEVEL}.json")
_L = os.path.join(tempfile.gettempdir(), f"l_{LEVEL}.json")
json.dump(g, open(_G, "w"))
subprocess.run(["node", os.path.join(_HERE, "layout.js"), _G, _L], check=True)
L = json.load(open(_L))
POS = {c["id"]: c for c in L["children"]}
# ---------------- crossings ----------------
paths = {}
for ed in L["edges"]:
    s = ed["sections"][0]
    paths[ed["id"]] = [(s["startPoint"]["x"], s["startPoint"]["y"])] + [(p["x"], p["y"]) for p in s.get("bendPoints", [])] + [(s["endPoint"]["x"], s["endPoint"]["y"])]
def segs(p): return [(p[i], p[i + 1]) for i in range(len(p) - 1)]
def cross(a, b):
    (x1, y1), (x2, y2) = a; (x3, y3), (x4, y4) = b
    if x1 == x2 and y3 == y4:   # a vertical, b horizontal
        return min(x3, x4) < x1 < max(x3, x4) and min(y1, y2) < y3 < max(y1, y2)
    if y1 == y2 and x3 == x4: return cross(b, a)
    return False
ids = list(paths); NC = 0
for i in range(len(ids)):
    for j in range(i + 1, len(ids)):
        NC += sum(cross(a, b) for a in segs(paths[ids[i]]) for b in segs(paths[ids[j]]))
W, H = L["width"], L["height"]
if os.environ.get("COUNT_ONLY"):
    print(json.dumps({"cross": NC, "w": W, "h": H})); sys.exit()
# ---------------- render ----------------
TOP = 190
o = [f'<svg xmlns="http://www.w3.org/2000/svg" width="{W+80:.0f}" height="{H+TOP+60:.0f}" viewBox="-40 {-TOP} {W+80:.0f} {H+TOP+60:.0f}" font-family="DejaVu Sans, Arial, sans-serif">',
     f'<rect x="-40" y="{-TOP}" width="{W+80:.0f}" height="{H+TOP+60:.0f}" fill="#fff"/>',
     f'<text x="0" y="{-TOP+48}" font-size="40" font-weight="bold" fill="{INK}">{e(TITLE)}</text>']
for i, l in enumerate(LEG):
    o.append(f'<text x="0" y="{-TOP+82+i*24}" font-size="17" fill="{GREY}">{e(l)}</text>')
# domain key + notation key on the right of the title
x = 0
used = [k for k, (c, lab, ns) in DOMAIN.items() if any(n["id"] in ns or COL.get(n["id"]) == c for n in nodes)]
for k in used:
    c, lab, _ = DOMAIN[k]
    o.append(f'<rect x="{x}" y="{-TOP+130}" width="22" height="22" rx="3" fill="{c}"/><text x="{x+30}" y="{-TOP+148}" font-size="18" fill="{INK}">{e(lab)}</text>')
    x += 30 + tw(lab, 18) + 30
def mark(pt, ux, uy, card, LINE=LINE):   # crow's foot symbols; (ux,uy) unit vector from the box outwards along the line
    nx, ny = -uy, ux
    P = lambda d, k=0: (pt[0] + ux * d + nx * k, pt[1] + uy * d + ny * k)
    s = []
    ln = lambda a, b: s.append(f'<line x1="{a[0]:.1f}" y1="{a[1]:.1f}" x2="{b[0]:.1f}" y2="{b[1]:.1f}" stroke="{LINE}" stroke-width="2"/>')
    if card == "tri":
        a, b, c = P(0, 0), P(22, -14), P(22, 14)
        s.append(f'<polygon points="{a[0]:.1f},{a[1]:.1f} {b[0]:.1f},{b[1]:.1f} {c[0]:.1f},{c[1]:.1f}" fill="#fff" stroke="{LINE}" stroke-width="2"/>')
        return s
    if not card: return s
    many = card.endswith("N"); mn = card.split("..")[0]
    if many:
        for k in (-11, 0, 11): ln(P(22), P(0, k))
    else: ln(P(12, -10), P(12, 10))
    if mn == "0":
        c = P(34); s.append(f'<circle cx="{c[0]:.1f}" cy="{c[1]:.1f}" r="7" fill="#fff" stroke="{LINE}" stroke-width="2"/>')
    else: ln(P(28, -10), P(28, 10))
    return s
EDG = {ed["id"]: ed for ed in edges}
lines, marks, labels = [], [], []
import colorsys
def edge_col(m):
    c = COL.get(m["s"], LINE)
    r, g, b = (int(c[i:i+2], 16) / 255 for i in (1, 3, 5))
    h, l, s_ = colorsys.rgb_to_hls(r, g, b); r, g, b = colorsys.hls_to_rgb(h, l * 0.85, s_)
    return "#%02X%02X%02X" % (int(r * 255), int(g * 255), int(b * 255))
HOP = 7
# vertical segments of all edges, to put a hop on every horizontal segment that crosses one
VSEG = [(eid, a, b) for eid, p in paths.items() for a, b in segs(p) if a[0] == b[0]]
def path_d(eid, p):
    d = f"M{p[0][0]:.1f},{p[0][1]:.1f}"
    for a, b in segs(p):
        if a[1] == b[1] and a[0] != b[0]:   # horizontal: hop over crossing verticals
            xs = sorted(v[1][0] for v in VSEG if v[0] != eid and min(a[0], b[0]) + HOP < v[1][0] < max(a[0], b[0]) - HOP
                        and min(v[1][1], v[2][1]) < a[1] < max(v[1][1], v[2][1]))
            if b[0] < a[0]: xs = xs[::-1]
            sgn = 1 if b[0] > a[0] else -1
            for x in xs:
                d += f" L{x - sgn*HOP:.1f},{a[1]:.1f} A{HOP},{HOP} 0 0 {1 if sgn > 0 else 0} {x + sgn*HOP:.1f},{a[1]:.1f}"
        d += f" L{b[0]:.1f},{b[1]:.1f}"
    return d
for ed in L["edges"]:
    m = EDG[ed["id"]]; p = paths[ed["id"]]
    d = "" if m["ident"] else ' stroke-dasharray="10 6"'
    lines.append(f'<path d="{path_d(ed["id"], p)}" fill="none" stroke="{edge_col(m)}" stroke-width="2.2"{d}/>')
    for (a, b), card in ((p[0], m["sc"]), (p[-1], m["tc"])):
        q = p[1] if (a, b) == p[0] else p[-2]
        L_ = math.dist((a, b), q) or 1
        marks += mark((a, b), (q[0] - a) / L_, (q[1] - b) / L_, card, edge_col(m))
    for lb in ed.get("labels", []):
        fw = ' font-weight="bold"' if m["ident"] else ' font-style="italic"'
        labels.append(f'<rect x="{lb["x"]:.1f}" y="{lb["y"]:.1f}" width="{lb["width"]:.1f}" height="{lb["height"]:.1f}" fill="#fff" opacity="0.9"/>'
                      f'<text x="{lb["x"]+lb["width"]/2:.1f}" y="{lb["y"]+17:.1f}" font-size="17"{fw} fill="{INK}" text-anchor="middle">{e(lb["text"])}</text>')
boxes = []
for n in nodes:
    c = POS[n["id"]]; x0, y0, w, h = c["x"], c["y"], c["width"], c["height"]
    if n.get("isa"):
        boxes.append(f'<polygon points="{x0+w/2:.1f},{y0:.1f} {x0+w:.1f},{y0+h:.1f} {x0:.1f},{y0+h:.1f}" fill="#fff" stroke="{LINE}" stroke-width="2"/>'
                     f'<text x="{x0+w/2:.1f}" y="{y0+h-12:.1f}" font-size="16" font-weight="bold" fill="{INK}" text-anchor="middle">ISA</text>')
        continue
    col = COL[n["id"]]
    if n["weak"]:
        boxes.append(f'<rect x="{x0:.1f}" y="{y0:.1f}" width="{w:.1f}" height="{h:.1f}" rx="6" fill="none" stroke="{col}" stroke-width="2"/>')
        x0, y0, w, h = x0 + 6, y0 + 6, w - 12, h - 12
    if not n["rows"]:
        boxes.append(f'<rect x="{x0:.1f}" y="{y0:.1f}" width="{w:.1f}" height="{h:.1f}" rx="5" fill="{col}"/>')
        ty = y0 + (h / 2 + 8 if not n["tag"] else h / 2 - 2)
        boxes.append(f'<text x="{x0+w/2:.1f}" y="{ty:.1f}" font-size="{HF}" font-weight="bold" fill="#fff" text-anchor="middle">{e(n["title"])}</text>')
        if n["tag"]: boxes.append(f'<text x="{x0+w/2:.1f}" y="{y0+h/2+20:.1f}" font-size="{SF}" font-style="italic" fill="#fff" text-anchor="middle">{e(n["tag"])}</text>')
        continue
    boxes.append(f'<rect x="{x0:.1f}" y="{y0:.1f}" width="{w:.1f}" height="{h:.1f}" rx="5" fill="#fff" stroke="{col}" stroke-width="2"/>')
    boxes.append(f'<path d="M{x0:.1f},{y0+HDRH:.1f} V{y0+5:.1f} Q{x0:.1f},{y0:.1f} {x0+5:.1f},{y0:.1f} H{x0+w-5:.1f} Q{x0+w:.1f},{y0:.1f} {x0+w:.1f},{y0+5:.1f} V{y0+HDRH:.1f} Z" fill="{col}"/>')
    boxes.append(f'<text x="{x0+PADX:.1f}" y="{y0+31:.1f}" font-size="{HF}" font-weight="bold" fill="#fff">{e(n["title"])}</text>')
    if n["tag"]: boxes.append(f'<text x="{x0+w-PADX:.1f}" y="{y0+30:.1f}" font-size="{SF}" font-style="italic" fill="#fff" text-anchor="end">{e(n["tag"])}</text>')
    for i, r in enumerate(n["rows"]):
        ry = y0 + HDRH + i * ROWH
        if r[0][2]: boxes.append(f'<rect x="{x0+2:.1f}" y="{ry+2:.1f}" width="{w-4:.1f}" height="{ROWH-2}" fill="#FFF6DA"/>')
        elif i: boxes.append(f'<line x1="{x0+6:.1f}" y1="{ry:.1f}" x2="{x0+w-6:.1f}" y2="{ry:.1f}" stroke="#E6EAEE"/>')
        cx = x0 + 10
        for j, (txt, fs, bold, fc) in enumerate(r):
            if txt: boxes.append(f'<text x="{cx:.1f}" y="{ry+21:.1f}" font-size="{fs}"{" font-weight=\"bold\"" if bold else ""} fill="{fc}">{e(txt)}</text>')
            cx += n["cw"][j]
o += lines + boxes + marks + labels + ["</svg>"]
need = max(tw(TITLE, 40, True), x) + 80
if need > W + 80: o[0] = o[0].replace(f'width="{W+80:.0f}"', f'width="{need:.0f}"', 1).replace(f'{W+80:.0f} {H+TOP+60:.0f}"', f'{need:.0f} {H+TOP+60:.0f}"', 1); o[1] = o[1].replace(f'width="{W+80:.0f}"', f'width="{need:.0f}"')
open(OUT, "w").write("\n".join(o))
print(json.dumps({"cross": NC, "w": round(W), "h": round(H)}))
