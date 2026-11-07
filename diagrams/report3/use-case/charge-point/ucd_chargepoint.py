import math
from vpuc import Diagram
d = Diagram("Figure 5 — Use Case Diagram: Charge Point")
DX, DY = -170, 330
def at(r, deg): a = math.radians(deg); return DX + r*math.cos(a), DY + r*math.sin(a)
RI = 560
def U(deg, *a, **k): x, y = at(RI, deg); return d.uc(x, y, *a, **k)
d.boundary(170, 20, 400, 610, "PowerMe Platform")
i1 = U(-24, "UC-INT-01", "Connect Charge Point to Platform")
i2 = U(-8, "UC-INT-02", "Authorize Charging Card")
i3 = U(8, "UC-INT-03", "Report Charging Transaction")
i4 = U(24, "UC-INT-04", "Report Connector Status")
CP = d.actor(DX, DY, "Charge Point", "system")
for u in [i1, i2, i3, i4]: d.assoc(CP, u)
d.save("ucd-chargepoint.svg")
