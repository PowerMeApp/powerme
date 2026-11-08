#!/bin/sh
# Rebuild the 3 ERDs (one page each) with the layout parameters chosen by search2.py (fewest crossings).
# Needs: node + elkjs 0.9.3 (npm i elkjs@0.9.3), python3 + Pillow, rsvg-convert. Edit the paths at the top of erd_elk.py.
# v1.1 (01/11): + Refund (R8) -> 34 entities / 53 relationships, 44 tables / 83 FKs. Seeds re-searched (150 tries each).
export NP=BRANDES_KOEPF
SHUF=1598 python3 erd_elk.py conceptual RIGHT 7891 100   # 27 crossings / 53 relationships
SHUF=9393 python3 erd_elk.py logical    RIGHT 3704 300   #  9 crossings / 56 lines
SHUF=7693 python3 erd_elk.py physical   RIGHT 2406 100   # 74 crossings / 83 FKs, all 44 tables on one page
for f in conceptual logical physical; do rsvg-convert -z 1.5 erd-$f.svg -o erd-$f.png; done
