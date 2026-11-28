#!/bin/sh
# v1.5 (27/11): model.py + lmodel.py (Conceptual / Logical ERD v1.3) + TopUpPaymentConflict, RfidCreditHold (0031) and the R4-9 attributes -> 36 entities / 58 relationships.
#   Conceptual seed 2227 SHUF 6638 thoroughness 100 (46 crossings); Logical seed 1611 SHUF 5786 thoroughness 300 (24 crossings); best of ~190 / ~125 seeds.
# v1.5 (27/11): pmodel.json rebuilt from powerme_physical.dbml v1.5 (migrations 0000-0031) -> 48 tables / 91 FKs (+ rfid_credit_holds, rfid_stop_jobs, charge_point_offline_auth_checks).
# v1.4 (26/11): pmodel.json rebuilt from powerme_physical.dbml v1.4 (migrations 0000-0029, main 20fa134) by dbml2pmodel.py
# -> 45 tables / 86 FKs (+ top_up_payment_conflicts, 0024). model.py + lmodel.py (Conceptual / Logical ERD v1.2) unchanged.
# v1.2 (10/11): model.py + lmodel.py + pmodel.json synced with migrations 0000-0015 -> 34 entities / 54 relationships, 44 tables / 84 FKs.
# Needs: node + elkjs 0.9.3 (npm i elkjs@0.9.3), python3 + Pillow, rsvg-convert. Paths are relative to this folder.
# (On Python < 3.12 the f-string at the row-text line needs no backslash inside {}). Seeds from search2.py.
export NP=BRANDES_KOEPF
python3 dbml2pmodel.py ../erd-physical/powerme_physical.dbml pmodel.json pmodel.json   # keeps TABLE / TECH / PART / TRIG
SHUF=6638 python3 erd_elk.py conceptual RIGHT 2227 100   # 46 crossings / 58 relationships (v1.3, 27/11)
SHUF=5786 python3 erd_elk.py logical    RIGHT 1611 300   # 24 crossings (v1.3, 27/11)
SHUF=104 python3 erd_elk.py physical   RIGHT 8590 300   # v1.5: 113 crossings / 91 FKs, all 48 tables on one page (best of ~360 seeds)
for f in conceptual logical physical; do rsvg-convert -z 1.5 erd-$f.svg -o erd-$f.png; done
