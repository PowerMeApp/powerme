#!/bin/sh
# v1.2 (10/11): model.py + lmodel.py + pmodel.json synced with migrations 0000-0015 -> 34 entities / 54 relationships, 44 tables / 84 FKs.
# Needs: node + elkjs 0.9.3 (npm i elkjs@0.9.3), python3 + Pillow, rsvg-convert. Edit the paths at the top of erd_elk.py
# (and on Python < 3.12 the f-string at the row-text line needs no backslash inside {}). Seeds from search2.py, 250 tries each.
export NP=BRANDES_KOEPF
SHUF=9485 python3 erd_elk.py conceptual RIGHT 8071 300   # 40 crossings / 54 relationships
SHUF=7534 python3 erd_elk.py logical    RIGHT 177  300   # 18 crossings
SHUF=5918 python3 erd_elk.py physical   RIGHT 3050 300   # 77 crossings / 84 FKs, all 44 tables on one page
for f in conceptual logical physical; do rsvg-convert -z 1.5 erd-$f.svg -o erd-$f.png; done
