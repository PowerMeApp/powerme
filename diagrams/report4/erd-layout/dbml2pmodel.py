# Builds pmodel.json (input of erd_elk.py physical) from powerme_physical.dbml.
# Usage: python3 dbml2pmodel.py powerme_physical.dbml pmodel.json [old_pmodel.json for TABLE/TECH/PART/TRIG]
import re, json, sys, collections
src, out = sys.argv[1], sys.argv[2]
old = json.load(open(sys.argv[3])) if len(sys.argv) > 3 else {}
txt = open(src).read()
def strip_comments(s):
    return "\n".join(l for l in s.splitlines() if not l.lstrip().startswith("//"))
txt = strip_comments(txt)
ENUMS = {m.group(1): re.findall(r'"([^"]+)"', m.group(2)) for m in re.finditer(r'^Enum (\w+) \{(.*?)^\}', txt, re.S | re.M)}
def split_top(s, sep=","):
    out, depth, q, cur = [], 0, None, ""
    for ch in s:
        if q:
            cur += ch
            if ch == q and not cur.endswith("\\" + q): q = None
            continue
        if ch in "'`\"": q = ch; cur += ch; continue
        if ch in "([": depth += 1
        if ch in ")]": depth -= 1
        if ch == sep and depth == 0: out.append(cur.strip()); cur = ""; continue
        cur += ch
    if cur.strip(): out.append(cur.strip())
    return out
ROWS, CONS, IDX, ORDER = {}, collections.defaultdict(list), {}, []
for m in re.finditer(r'^Table (\w+) \{\n(.*?)^\}', txt, re.S | re.M):
    t, body = m.group(1), m.group(2); ORDER.append(t)
    cols, pk, uniq, idx, checks = [], None, [], [], []
    sect = None
    for line in body.splitlines():
        s = line.strip()
        if not s: continue
        if s in ("indexes {", "checks {"): sect = s.split()[0]; continue
        if s == "}": sect = None; continue
        if s.startswith("Note:"): continue
        if sect == "indexes":
            mm = re.match(r'(\(.*?\)|\w+)\s*(?:\[(.*)\])?$', s)
            cs = [c.strip() for c in mm.group(1).strip("()").split(",")]
            opts = mm.group(2) or ""
            if re.search(r'\bpk\b', opts): pk = cs
            elif re.search(r'\bunique\b', opts):
                nm = re.search(r"name: '([^']+)'", opts); uniq.append((nm.group(1) if nm else f"{t}_{'_'.join(cs)}_key", cs))
            else:
                nm = re.search(r"name: '([^']+)'", opts); idx.append({"name": nm.group(1) if nm else "", "defn": "(" + ", ".join(cs) + ")", "unique": False})
            continue
        if sect == "checks":
            mm = re.match(r'`(.*)`\s*\[name: \'([^\']+)\'\]', s)
            expr = mm.group(1)
            checks.append({"type": "c", "name": mm.group(2), "defn": f"CHECK ({expr})", "cols": []})
            continue
        mm = re.match(r'(\w+)\s+("[^"]+"|\S+)\s*(?:\[(.*)\])?$', s)
        name, typ, opts = mm.group(1), mm.group(2).strip('"'), mm.group(3) or ""
        o = split_top(opts)
        flags = {x for x in o if ":" not in x}
        kv = dict((x.split(":", 1)[0].strip(), x.split(":", 1)[1].strip()) for x in o if ":" in x)
        d = kv.get("default", "")
        raw = d
        if d.startswith("`") and d.endswith("`"): d = d.strip("`")
        if "increment" in flags: d = "identity"
        if "sequence" in kv.get("note", "") and "auto number" in kv.get("note", ""): d = "sequence"
        nn = "not null" in flags or "pk" in flags or "increment" in flags
        if "pk" in flags: pk = [name]
        if "unique" in flags: uniq.append((f"{t}_{name}_key", [name]))
        cols.append({"key": "", "planned": False, "name": name, "type": typ, "nn": nn, "default": d, "raw_default": raw})
    if pk:
        for c in cols:
            if c["name"] in pk: c["nn"] = True
        CONS[t].append({"type": "p", "name": f"{t}_pkey", "defn": f"PRIMARY KEY ({', '.join(pk)})", "cols": pk})
    for nm, cs in uniq: CONS[t].append({"type": "u", "name": nm, "defn": f"UNIQUE ({', '.join(cs)})", "cols": cs})
    CONS[t] += checks
    ROWS[t] = cols; IDX[t] = idx
FKS = []
for m in re.finditer(r'^Ref (\w+): (\w+)\.(\(.*?\)|\w+) ([<>-]) (\w+)\.(\(.*?\)|\w+)(?: \[(.*)\])?$', txt, re.M):
    nm, t1, c1, op, t2, c2, opts = m.groups()
    c1 = [c.strip() for c in c1.strip("()").split(",")]; c2 = [c.strip() for c in c2.strip("()").split(",")]
    if op == ">": ch, cc, pa, pc = t1, c1, t2, c2
    elif op == "<": ch, cc, pa, pc = t2, c2, t1, c1
    else: pa, pc, ch, cc = t1, c1, t2, c2     # parent.pk - child.fk (one-to-one)
    od = re.search(r'delete: (\w+)', opts or ""); od = od.group(1).upper() if od else "NO ACTION"
    FKS.append({"table": ch, "name": nm, "cols": cc, "ref": pa, "ref_cols": pc, "on_delete": od})
    CONS[ch].append({"type": "f", "name": nm, "defn": f"FOREIGN KEY ({', '.join(cc)}) REFERENCES {pa}({', '.join(pc)})", "cols": cc})
FKS.sort(key=lambda f: (f["table"], f["name"]))
# key column: PK / FK / UQ (single) / UQn (parts of the n-th composite unique, PK supersets skipped)
for t, cols in ROWS.items():
    pk = next((c["cols"] for c in CONS[t] if c["type"] == "p"), [])
    fkc = {x for c in CONS[t] if c["type"] == "f" for x in c["cols"]}
    single = {c["cols"][0] for c in CONS[t] if c["type"] == "u" and len(c["cols"]) == 1}
    comps = [c["cols"] for c in CONS[t] if c["type"] == "u" and len(c["cols"]) > 1 and not set(pk) <= set(c["cols"])]
    for c in cols:
        k = []
        if c["name"] in pk: k.append("PK")
        if c["name"] in fkc: k.append("FK")
        if c["name"] in single and c["name"] not in pk: k.append("UQ")
        for i, cs in enumerate(comps, 1):
            if c["name"] in cs: k.append(f"UQ{i}" if len(comps) > 1 or True else "UQ")
        c["key"] = ",".join(k)
TABLE = dict(old.get("TABLE", {})); TECH = list(old.get("TECH", []))
known = set(TABLE.values()) | set(TECH)
for t in ORDER:
    if t not in known: TECH.append(t) if False else None
M = {"TABLE": TABLE, "TECH": TECH, "ROWS": ROWS, "CONS": dict(CONS), "IDX": IDX, "PART": old.get("PART", {}), "TRIG": old.get("TRIG", {}), "ENUMS": ENUMS, "FKS": FKS, "ORDER": ORDER}
json.dump(M, open(out, "w"), indent=2)
print(len(ROWS), "tables", sum(map(len, ROWS.values())), "cols", len(ENUMS), "enums", len(FKS), "fks",
      sum(1 for t in CONS for c in CONS[t] if c["type"] == "c"), "checks; not in TABLE/TECH:", [t for t in ORDER if t not in known])
