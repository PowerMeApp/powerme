import math
from vpuc import Diagram
d = Diagram("Figure 3 — Use Case Diagram: Operator")
DX, DY = -170, 640
def at(r, deg): a = math.radians(deg); return DX + r*math.cos(a), DY + r*math.sin(a)
RI, RO = 640, 1100
def U(r, deg, *a, **k): x, y = at(r, deg); return d.uc(x, y, *a, **k)
d.boundary(140, 150, 1000, 1130, "PowerMe Platform")
# inner arc — operator goals without secondary actors
o1 = U(RI, -40, "UC-OPS-01", "Onboard Charge Point")
o2 = U(RI, -28, "UC-OPS-02", "Monitor Charge Point Status")
o5 = U(RI, -16, "UC-OPS-05", "Resolve Unattributed Session")
o6 = U(RI, 17, "UC-OPS-06", "Configure Tariff Schedule")
o7 = U(RI, 29, "UC-OPS-07", "Manage Promotions")
o9 = U(RI, 41, "UC-OPS-09", "View Station Revenue")
# outer column — fault handling: base + extensions
o4 = U(RO, -9, "UC-OPS-04", "Send Remote Charge Point Command")
o3 = U(RO, 0.5, "UC-OPS-03", "View Fault Alerts", ep=["remote reset", "maintenance ticket"])
o8 = U(RO, 10.5, "UC-OPS-08", "Manage Maintenance Tickets", tag="Should")
login = d.uc(330, 1200, "UC-ACC-04", "Log In", ep=["log out"])
logout = d.uc(o3["x"], 1200, "UC-ACC-05", "Log Out")
OP = d.actor(DX, DY, "Operator")
US = d.actor(DX, 1200, "User")
CP = d.actor(1290, o4["y"], "Charge Point", "system")
for u in [o1, o2, o5, o4, o3, o8, o6, o7, o9]: d.assoc(OP, u)
d.assoc(US, login); d.gen(OP, US)
d.assoc(CP, o4)
d.dep(o4, o3, "Extend", lx=48)
d.dep(o8, o3, "Extend", lx=48)
d.dep(logout, login, "Extend", ly=-8)
d.save("ucd-operator.svg")
