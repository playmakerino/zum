#!/usr/bin/env python
"""motif-r.py: r (pattern width / mock width) for new mock + map views of a garment.

Every view in the GARMENT DATA of pattern-mockup.html / zum_prd_form.html carries r: the pattern file is
rastered to r x mock width and tiled into the fabric panels. So r is "how many mock widths one repeat of
the pattern spans": r = 0.5 -> the pattern repeats twice across the mock width, r = 2 -> one repeat is
twice as wide as the whole mock. A bigger r = a bigger motif.

Photos of one garment are cropped very differently (the body spans 40% of one frame and 99% of another),
so r differs per view. This tool keeps the motif the same size ON THE GARMENT across views: it measures
the top's torso panel width on each map and scales r with it.

    r_new = r_ref x (torsoW_new / W_new) / (torsoW_ref / W_ref)

torsoW = extent of the torso panel across its own narrow axis (PCA minor axis, 2.5..97.5 percentile), so a
top laid at an angle measures the same as an upright one. The torso panel is map id 1 on every pajama map
(red channel / 20 = panel id); pass --panel for a garment mapped differently.

The anchor is any existing view of the SAME garment whose r is already in GARMENT DATA (its first
flatlay, normally). A brand-new garment has no anchor: set the r of its first flatlay by eye in
pattern-mockup.html (0.76 is a good start for a flatlay whose top spans ~27% of the width), then anchor
the other views on it.

Usage (maps as local paths, full URLs, or bare CDN filenames with their ?v):
    python motif-r.py --ref zum-flatlay-map-men-pajama.png?v=1789030328 --ref-r 0.758 new-model-map-8.png new-model-map-9.png
"""
import argparse, os, sys, tempfile
import numpy as np
from PIL import Image

CDN = 'https://cdn.shopify.com/s/files/1/0704/3321/0621/files/'

def fetch(src):
    if os.path.exists(src): return src
    url = src if src.startswith('http') else CDN + src
    cache = os.path.join(tempfile.gettempdir(), 'motif-r-cache'); os.makedirs(cache, exist_ok=True)
    p = os.path.join(cache, os.path.basename(url.split('?')[0]))
    if not os.path.exists(p):
        import requests
        r = requests.get(url, timeout=120); r.raise_for_status(); open(p, 'wb').write(r.content)
    return p

def torso(src, panel):
    a = np.asarray(Image.open(fetch(src)).convert('RGB'))
    ids = (a[:, :, 0].astype(np.int32) + 10) // 20
    ys, xs = np.where(ids == panel)
    if len(xs) < 1000: sys.exit(f'{src}: panel {panel} has {len(xs)} px (map not a panel map, or wrong --panel)')
    xs = xs[::3].astype(float); ys = ys[::3].astype(float)
    mx, my = xs.mean(), ys.mean()
    w, v = np.linalg.eigh(np.cov(np.vstack([xs - mx, ys - my])))
    minor = v[:, 0]                       # eigenvector of the smaller variance = across the torso
    proj = (xs - mx) * minor[0] + (ys - my) * minor[1]
    tw = float(np.percentile(proj, 97.5) - np.percentile(proj, 2.5))
    return dict(W=a.shape[1], H=a.shape[0], torsoW=tw, frac=tw / a.shape[1])

def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--ref', required=True, help='panel map of an existing view of the same garment')
    ap.add_argument('--ref-r', type=float, required=True, help='the r that view has in GARMENT DATA')
    ap.add_argument('--panel', type=int, default=1, help='map id of the torso panel (default 1)')
    ap.add_argument('maps', nargs='+', help='panel maps of the new views')
    a = ap.parse_args()
    name = lambda s: os.path.basename(s.split('?')[0])
    F = torso(a.ref, a.panel)
    print(f"{'view':48s} {'W':>5s} {'H':>5s} {'torsoW':>7s} {'torso/W':>7s}   r")
    print(f"{name(a.ref):48s} {F['W']:5d} {F['H']:5d} {F['torsoW']:7.0f} {F['frac']:7.3f}   {a.ref_r:.3f}   (anchor)")
    for m in a.maps:
        M = torso(m, a.panel)
        print(f"{name(m):48s} {M['W']:5d} {M['H']:5d} {M['torsoW']:7.0f} {M['frac']:7.3f}   {a.ref_r * M['frac'] / F['frac']:.3f}")

if __name__ == '__main__': main()
