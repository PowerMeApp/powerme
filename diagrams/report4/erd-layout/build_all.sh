#!/bin/sh
# v1.4 (26/11): pmodel.json rebuilt from powerme_physical.dbml v1.4 (migrations 0000-0029, main 20fa134) by dbml2pmodel.py
# -> 45 tables / 86 FKs (+ top_up_payment_conflicts, 0024). model.py + lmodel.py (Conceptual / Logical ERD v1.2) unchanged.
# v1.2 (10/11): model.py + lmodel.py + pmodel.json synced with migrations 0000-0015 -> 34 entities / 54 relationships, 44 tables / 84 FKs.
# Needs: node + elkjs 0.9.3 (npm i elkjs@0.9.3), python3 + Pillow, rsvg-convert. Paths are relative to this folder.
# (On Python < 3.12 the f-string at the row-text line needs no backslash inside {}). Seeds from search2.py.
export NP=BRANDES_KOEPF
python3 dbml2pmodel.py ../erd-physical/powerme_physical.dbml pmodel.json pmodel.json   # keeps TABLE / TECH / PART / TRIG
SHUF=9485 python3 erd_elk.py conceptual RIGHT 8071 300   # 40 crossings / 54 relationships (v1.2, not redrawn on 26/11)
SHUF=7534 python3 erd_elk.py logical    RIGHT 177  300   # 18 crossings (v1.2, not redrawn on 26/11)
SHUF=5130 python3 erd_elk.py physical   RIGHT 543  300   # v1.4: 95 crossings / 86 FKs, all 45 tables on one page (best of ~400 seeds)
for f in conceptual logical physical; do rsvg-convert -z 1.5 erd-$f.svg -o erd-$f.png; done
