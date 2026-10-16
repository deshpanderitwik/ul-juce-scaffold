#!/usr/bin/env python3
"""Join exported animations, end to end, into one video.

    python3 animations/reel.py            list the reels
    python3 animations/reel.py time       write animations/reels/time.mp4
    python3 animations/reel.py time --stale-ok

A reel is a named list of animation folders in animations/reels.json. Each
animation is still its own page and exported on its own (E in the page);
this joins their exported frames in order and encodes them once, so nothing
is compressed twice. Shots are built to start on the frame the previous one
ends on, so the joins are invisible.

It refuses to join an export older than its page or than the shared scripts
in animations/, because a stale shot is easy to miss in a long reel; re-export
the shots it names, or pass --stale-ok.
"""

import json
import subprocess
import sys
import tempfile
from pathlib import Path

from serve import video_args

ANIMATIONS = Path(__file__).resolve().parent
ROOT = ANIMATIONS.parent


def main():
    reels = json.loads((ANIMATIONS / 'reels.json').read_text())
    args = [a for a in sys.argv[1:] if not a.startswith('--')]
    stale_ok = '--stale-ok' in sys.argv
    if not args:
        for name, shots in reels.items():
            print(f'{name}: {" -> ".join(shots)}')
        return 0
    name = args[0]
    if name not in reels:
        sys.exit(f'no reel named {name!r} in reels.json')

    shared = max(p.stat().st_mtime for p in ANIMATIONS.glob('*.js'))
    metas, problems = [], []
    for shot in reels[name]:
        d = ANIMATIONS / shot
        meta_file = d / 'render' / 'meta.json'
        if not meta_file.is_file():
            problems.append(f'{shot}: not exported yet')
            continue
        exported = meta_file.stat().st_mtime
        if exported < max(shared, (d / 'index.html').stat().st_mtime) and not stale_ok:
            problems.append(f'{shot}: changed since it was exported')
        metas.append((d, json.loads(meta_file.read_text())))
    if problems:
        sys.exit('Re-export first (E in each page):\n  ' + '\n  '.join(problems))

    first = metas[0][1]
    for d, m in metas:
        if (m['fps'], m['width'], m['height']) != (first['fps'], first['width'], first['height']):
            sys.exit(f'{d.name} is {m["width"]}x{m["height"]} at {m["fps"]} fps; '
                     f'{metas[0][0].name} is {first["width"]}x{first["height"]} at {first["fps"]} fps')

    alpha = any(m['alpha'] for _, m in metas)
    out_dir = ANIMATIONS / 'reels'
    out_dir.mkdir(exist_ok=True)
    out = out_dir / f'{name}.{"mov" if alpha else "mp4"}'

    with tempfile.TemporaryDirectory() as tmp:
        n = 0
        for d, m in metas:
            for f in range(m['frames']):
                (Path(tmp) / f'{n:06d}.png').symlink_to(d / 'render' / 'frames' / f'{f:05d}.png')
                n += 1
        cmd = ['ffmpeg', '-y', '-loglevel', 'error', '-framerate', str(first['fps']),
               '-i', str(Path(tmp) / '%06d.png')]
        subprocess.run(cmd + video_args(alpha) + [str(out)], check=True)

    print(f'{out.relative_to(ROOT)}: {n} frames, {n / first["fps"]:.2f} s')
    for d, m in metas:
        print(f'  {d.name}: {m["frames"]} frames')
    return 0


if __name__ == '__main__':
    sys.exit(main())
