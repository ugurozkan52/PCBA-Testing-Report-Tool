import json, math, sys, cadquery as cq
OUT = sys.argv[1] if len(sys.argv) > 1 else 'testcase3.step'
SKIP = int(sys.argv[2]) if len(sys.argv) > 2 else 0  # drop every SKIP-th body (parts without a model)
d = json.load(open('/tmp/claude-0/s3/fp.json'))
bb = d['bb']; T = 1.6
def to_step(p): return (p[0], -p[1])
board = (cq.Workplane('XY').polyline([to_step(p) for p in [(bb['minx'],bb['miny']),(bb['maxx'],bb['miny']),(bb['maxx'],bb['maxy']),(bb['minx'],bb['maxy'])]]).close().extrude(T))
asm = cq.Assembly(name='TestBoard_PCB_Assembly')
asm.add(board, name='TestBoard_PCB', color=cq.Color(0.1,0.35,0.2))
for i, f in enumerate(d['fps']):
    b = f['bbox']
    if not b['size'][0]: continue
    if SKIP and i % SKIP == SKIP - 1: continue
    a = math.radians(-b['angle']); ca, sa = math.cos(a), math.sin(a)
    rx, ry = b['relpos']; w, h = b['size']
    pts = []
    for (u, v) in [(rx, ry), (rx+w, ry), (rx+w, ry+h), (rx, ry+h)]:
        x = b['pos'][0] + u*ca - v*sa; y = b['pos'][1] + u*sa + v*ca
        pts.append(to_step((x, y)))
    hgt = 0.8 + (i % 4) * 0.6
    if f['layer'] == 'F':
        s = cq.Workplane('XY').workplane(offset=T).polyline(pts).close().extrude(hgt)
    else:
        s = cq.Workplane('XY').polyline(pts).close().extrude(-hgt)
    nm = f['ref'] if i % 3 == 0 else (f['ref'] + '_TestBoard' if i % 3 == 1 else 'Body_%d' % i)
    col = cq.Color(0.15,0.15,0.17) if i % 2 else cq.Color(0.75,0.6,0.3)
    asm.add(s, name=nm, color=col)
asm.save(OUT)
print('ok')
