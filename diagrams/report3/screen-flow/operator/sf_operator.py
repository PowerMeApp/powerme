from sfdraw import SF
s = SF("Figure 7 — Screen Flow: Operator Dashboard")
s.composite(230, -130, 1220, 860, "Signed In")
ini = s.initial(40, 200)
login = s.state(40, 330, "Login")
DW = 230
dash = s.state(400, 330, "Operator Dashboard", note="counts by status · open alerts", w=DW, h=700)
R = 400 + DW/2
rows = [("Charge Point List / Map", 30, None), ("Fault Alerts", 200, None), ("Unattributed Sessions", 370, None),
        ("Pricing & Promotions", 500, None), ("Station Revenue", 630, "charged · sessions · energy")]
kids = {}
for name, y, note in rows:
    kids[name] = s.state(840, y, name, note=note, w=250)
    pt = dict(kind="box", x=R, y=y, w=0.1, h=0.1)
    s.tr(pt, kids[name], "open", off=-9, ldy=-12)
    s.tr(kids[name], pt, "back", off=-9, ldy=24)
cpl, fa = kids["Charge Point List / Map"], kids["Fault Alerts"]
onb = s.state(1270, -50, "Charge Point Onboarding", "sheet", note="credential shown once", w=240)
det = s.state(1270, 130, "Charge Point Detail", note="status · faults · remote commands", w=250)
mt = s.state(1270, 330, "Maintenance Tickets", note="[Should]", w=230)
s.tr(ini, login, "open dashboard", ldx=-8, anchor="end")
s.tr(login, dash, "log in [valid credentials, operator staff]", lpos=0.62, ldy=-10)
s.tr(dict(kind="box", x=230, y=-30, w=0.1, h=0.1), login, "log out", via=[(100, -30), (100, 305)], lpos=0.2, ldy=-6)
s.tr(cpl, onb, "add charge point", off=10, lpos=0.5, ldy=22)
s.tr(onb, cpl, "save [serial in registry]", off=10, lpos=0.45, ldy=-14)
s.tr(cpl, det, "select charge point", off=10, lpos=0.5, ldy=22)
s.tr(det, cpl, "back", off=10, lpos=0.5, ldy=-10)
s.tr(fa, det, "select alert", lpos=0.5, ldy=20)
s.tr(det, mt, "open tickets", off=-14, ldx=10, anchor="start")
s.tr(mt, det, "back", off=-14, ldx=-10, anchor="end")
s.legend(1220, 520)
s.save("sf-operator.svg")
