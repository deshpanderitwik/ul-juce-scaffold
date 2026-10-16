#!/usr/bin/env python3
"""Serve the repo for the animations and write their exported frames to disk.

    python3 animations/serve.py [port]

Serves the repository root, so a page can load anything in it (for instance
../../web/three.min.js). Open http://127.0.0.1:<port>/animations/NNN-name/.

POST /render/start            {"anim": "/animations/NNN-name/"}
    Empties NNN-name/render/frames/.
POST /render/frame?anim=...&n=12    body: PNG bytes
    Writes NNN-name/render/frames/00012.png.
POST /render/finish           {"anim": ..., "fps": 60, "width": 1920, "height": 1080,
                               "alpha": false, "audio": "mix.wav" | null}
    Writes NNN-name/render/meta.json (for reel.py), then encodes the frames with ffmpeg: NNN-name/render/NNN-name.mp4 (H.264), or
    NNN-name.mov (ProRes 4444, keeps transparency) when alpha is set. The
    audio path is relative to the animation's folder.

Only folders directly inside animations/ can be written to.
"""

import json
import shutil
import subprocess
import sys
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

ANIMATIONS = Path(__file__).resolve().parent
ROOT = ANIMATIONS.parent


def anim_dir(url_path):
    """The animation folder a page path names, or None if it is not one."""
    d = (ROOT / url_path.strip('/')).resolve()
    return d if d.parent == ANIMATIONS and d.is_dir() else None


class Handler(SimpleHTTPRequestHandler):
    def end_headers(self):
        # Edits show up on a plain reload.
        self.send_header('Cache-Control', 'no-store')
        super().end_headers()

    def reply(self, status, body):
        data = json.dumps(body).encode()
        self.send_response(status)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_POST(self):
        url = urlparse(self.path)
        body = self.rfile.read(int(self.headers.get('Content-Length') or 0))
        try:
            if url.path == '/render/frame':
                q = parse_qs(url.query)
                d = anim_dir(q['anim'][0])
                if not d:
                    return self.reply(400, {'ok': False, 'error': 'not an animation folder'})
                n = int(q['n'][0])
                (d / 'render' / 'frames' / f'{n:05d}.png').write_bytes(body)
                return self.reply(200, {'ok': True})

            args = json.loads(body or b'{}')
            d = anim_dir(args.get('anim', ''))
            if not d:
                return self.reply(400, {'ok': False, 'error': 'not an animation folder'})
            frames = d / 'render' / 'frames'

            if url.path == '/render/start':
                shutil.rmtree(frames, ignore_errors=True)
                frames.mkdir(parents=True)
                return self.reply(200, {'ok': True})

            if url.path == '/render/finish':
                # What reel.py needs to join this export to others.
                meta = {'fps': int(args.get('fps') or 60), 'width': args.get('width'), 'height': args.get('height'),
                        'frames': len(list(frames.glob('*.png'))), 'alpha': bool(args.get('alpha'))}
                (d / 'render' / 'meta.json').write_text(json.dumps(meta, indent=2) + '\n')
                return self.reply(200, encode(d, frames, args))

            self.reply(404, {'ok': False, 'error': 'unknown endpoint'})
        except Exception as e:  # report to the page instead of dropping the connection
            self.reply(500, {'ok': False, 'error': f'{type(e).__name__}: {e}'})

    def log_message(self, fmt, *args):
        # One line per frame upload would bury everything else.
        if '/render/frame' not in self.path:
            super().log_message(fmt, *args)


def encode(d, frames, args):
    if not shutil.which('ffmpeg'):
        return {'ok': True, 'output': f'{frames.relative_to(ROOT)} (ffmpeg not found, frames only)'}
    fps = str(int(args.get('fps') or 60))
    cmd = ['ffmpeg', '-y', '-loglevel', 'error', '-framerate', fps, '-start_number', '0',
           '-i', str(frames / '%05d.png')]
    audio = args.get('audio')
    if audio:
        a = (d / audio).resolve()
        if not a.is_file() or ROOT not in a.parents:
            return {'ok': False, 'error': f'audio not found: {audio}'}
        cmd += ['-i', str(a)]
    if args.get('alpha'):
        out = d / 'render' / f'{d.name}.mov'
        cmd += ['-c:v', 'prores_ks', '-profile:v', '4444', '-pix_fmt', 'yuva444p10le']
        if audio:
            cmd += ['-c:a', 'pcm_s16le']
    else:
        out = d / 'render' / f'{d.name}.mp4'
        cmd += ['-c:v', 'libx264', '-preset', 'slow', '-crf', '12', '-pix_fmt', 'yuv420p', '-movflags', '+faststart']
        if audio:
            cmd += ['-c:a', 'aac', '-b:a', '320k']
    # The picture sets the length: the audio is cut to it, or ends early.
    cmd += ['-t', str(len(list(frames.glob('*.png'))) / int(fps))]
    cmd.append(str(out))
    r = subprocess.run(cmd, capture_output=True, text=True)
    if r.returncode != 0:
        return {'ok': False, 'error': 'ffmpeg: ' + r.stderr.strip()[-600:]}
    return {'ok': True, 'output': str(out.relative_to(ROOT))}


def main():
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8002
    server = ThreadingHTTPServer(('127.0.0.1', port), partial(Handler, directory=str(ROOT)))
    print(f'http://127.0.0.1:{port}/animations/', flush=True)
    server.serve_forever()


if __name__ == '__main__':
    main()
