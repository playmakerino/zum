#!/usr/bin/env python
"""motif-r.py: the r value (pattern width / mock width) for a new mock + map set.

Every view in the GARMENT DATA of flatlay-composite.html / zum_prd_form.html carries r: the pattern is
rastered to r x mock width and tiled. This prints r for one flatlay and any number of on-model views of the
same garment, from their panel maps (red channel / 20 = panel id, 1..8 = fabric), so the checks-per-body
size on every model matches the flatlay:

    r_model = r_flat x (W_flat / bodyW_flat) x (bodyW_model / W_model)

bodyW = 70th percentile of the per-row fabric run width (pose-robust body width). r_flat comes from
--flat-r when the flatlay already exists in production (tuned by eye), else from the pre-2026-09-10 rule
1.5 x fabric-bbox-width x k / W (k = 0.62 for a mockup that lays the top + pants side by side, else 1).

Usage (maps as local paths, full URLs, or bare CDN filenames):
    python motif-r.py --flat zum-flatlay-map-pajama.png?v=1788601405 zum-flatlay-model-map-pajama-boy-1.png?v=1788949141 ...
    python motif-r.py --flat new-flat-map.png --flat-r 0.80 new-model-map-1.png new-model-map-2.png
    python motif-r.py --flat wide-layout-map.png --k 0.62
"""
import argparse, os, sys, tempfile
import numpy as np
from PIL import Image

CDN = 'https://cdn.shopify.com/s/files/1/0704/3321/0621/files/'
K_BASE = 1.5

def fetch(src):
    if os.path.exists(src): return src
    url = src if src.startswith('http') else CDN + src
    cache = os.path.join(tempfile.gettempdir(), 'motif-r-cache'); os.makedirs(cache, exist_ok=True)
    p = os.path.join(cache, os.path.basename(url.split('?')[0]))
    if not os.path.exists(p):
        import requests
        r = requests.get(url, timeout=120); r.raise_for_status(); open(p, 'wb').write(r.content)
    return p

def analyze(src):
    a = np.asarray(Image.open(fetch(src)).convert('RGB'))
    ids = (a[:, :, 0].astype(np.int32) + 10) // 20
    fab = (ids >= 1) & (ids <= 8)
    if not fab.any(): sys.exit(f'{src}: no fabric panel (ids 1..8) in the red channel')
    cols = np.where(fab.any(0))[0]; gw = int(cols[-1] - cols[0] + 1)
    rw = []
    for y in np.where(fab.any(1))[0]:
        xs = np.where(fab[y])[0]; rw.append(int(xs[-1] - xs[0] + 1))
    rw.sort(); bodyW = rw[min(len(rw) - 1, int(len(rw) * 0.70))]
    return dict(W=a.shape[1], H=a.shape[0], gw=gw, bodyW=bodyW)

def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--flat', required=True, help='flatlay panel map')
    ap.add_argument('--flat-r', type=float, help='r already used for this flatlay in production (else derived)')
    ap.add_argument('--k', type=float, default=1.0, help='flatlay layout multiplier when deriving r (0.62 = pieces side by side)')
    ap.add_argument('models', nargs='*', help='on-model panel maps of the same garment')
    a = ap.parse_args()
    F = analyze(a.flat)
    rf = a.flat_r if a.flat_r is not None else K_BASE * F['gw'] * a.k / F['W']
    name = lambda s: os.path.basename(s.split('?')[0])
    print(f"{'view':48s} {'W':>5s} {'H':>5s} {'gw':>5s} {'bodyW':>5s}   r")
    print(f"{name(a.flat):48s} {F['W']:5d} {F['H']:5d} {F['gw']:5d} {F['bodyW']:5d}   {rf:.3f}" + ('' if a.flat_r is not None else f"   (derived, k={a.k})"))
    for m in a.models:
        M = analyze(m)
        rm = rf * (F['W'] / F['bodyW']) * (M['bodyW'] / M['W'])
        print(f"{name(m):48s} {M['W']:5d} {M['H']:5d} {M['gw']:5d} {M['bodyW']:5d}   {rm:.3f}")

if __name__ == '__main__': main()
