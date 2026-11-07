from sfdraw import SF
s = SF("Figure 8 — Screen Flow: Admin Console")
s.composite(230, -110, 1260, 1040, "Signed In")
ini = s.initial(40, 280)
login = s.state(40, 410, "Login")
DW = 230
dash = s.state(400, 410, "Admin Dashboard", note="counts · open exceptions", w=DW, h=920)
dash_note_fix = None
R = 400 + DW/2
rows = [("Users & Roles", -10, None), ("Charge Point Registry", 110, None), ("Card Registry & Free-Vend Tags", 230, None),
        ("Charge Point Network Monitor", 350, "status · faults · uptime, all operators"),
        ("Billing Exceptions", 480, "refunds · late payments · e-invoice retries"),
        ("Platform Fee Rates", 600, "fee % per operator"),
        ("Platform Revenue", 720, "charged · platform fee · owner share"),
        ("Policy Templates", 840, "[Should]")]
kids = {}
for name, y, note in rows:
    kids[name] = s.state(850, y, name, note=note, w=310)
    pt = dict(kind="box", x=R, y=y, w=0.1, h=0.1)
    s.tr(pt, kids[name], "open", off=-9, ldy=-12)
    s.tr(kids[name], pt, "back", off=-9, ldy=24)
be = kids["Billing Exceptions"]
ref = s.state(1340, 480, "Refund / Retry", "sheet", note="adjustment invoice issued", w=230)
s.tr(be, ref, "refund / retry [balance covers refund]", off=-10, lpos=0.5, ldy=-14)
s.tr(ref, be, "confirm / cancel", off=-10, lpos=0.5, ldy=24)
s.tr(ini, login, "open console", ldx=-8, anchor="end")
s.tr(login, dash, "log in [valid credentials, admin]", lpos=0.62, ldy=-10)
s.tr(dict(kind="box", x=230, y=60, w=0.1, h=0.1), login, "log out", via=[(100, 60), (100, 385)], lpos=0.2, ldy=-6)
s.legend(1270, 700)
s.save("sf-admin.svg")
