#!/usr/bin/env python3
"""
MTG Proxy Print — All-in-One Launcher

Startet automatisch:
  1. Lokalen Webserver (statische Dateien aus tools/)
  2. Real-ESRGAN Upscale-API auf demselben Port
  3. Oeffnet Browser auf proxy-print.html

Usage:
  python3 tools/proxy-print.py
  python3 tools/proxy-print.py --port 8765
  python3 tools/proxy-print.py --binary /path/to/realesrgan-ncnn-vulkan
"""

import argparse
import hashlib
import http.server
import json
import os
import shutil
import subprocess
import sys
import tempfile
import webbrowser
from pathlib import Path
from urllib.parse import urlparse, parse_qs
import cgi

DEFAULT_PORT = 8765
BINARY_NAMES = ['upscayl-bin', 'upscayl-bin.exe', 'realesrgan-ncnn-vulkan', 'realesrgan-ncnn-vulkan.exe']
MODEL_NAME = 'remacri-4x'
SCALE = 2

TOOLS_DIR = Path(__file__).parent
CACHE_DIR = TOOLS_DIR / '.proxy_cache' / 'upscaled'


def find_binary(custom_path=None):
    if custom_path and os.path.isfile(custom_path):
        return custom_path
    for name in BINARY_NAMES:
        p = TOOLS_DIR / name
        if p.is_file():
            return str(p)
    for name in BINARY_NAMES:
        found = shutil.which(name)
        if found:
            return found
    return None


def is_upscayl_bin(binary):
    return 'upscayl-bin' in Path(binary).name


def upscale_image(binary, input_path, output_path, scale=SCALE):
    binary_dir = str(Path(binary).parent)
    models_dir = os.path.join(binary_dir, 'models')
    if is_upscayl_bin(binary):
        # upscayl-bin: -s is output scale, model auto-detects its native scale
        cmd = [binary, '-i', input_path, '-o', output_path,
               '-s', str(scale), '-n', MODEL_NAME, '-m', models_dir,
               '-f', 'jpg', '-c', '0']
    else:
        # legacy realesrgan-ncnn-vulkan
        cmd = [binary, '-i', input_path, '-o', output_path,
               '-s', str(scale), '-n', MODEL_NAME, '-m', models_dir]
    result = subprocess.run(cmd, capture_output=True, text=True, timeout=120,
                            cwd=binary_dir)
    if result.returncode != 0:
        raise RuntimeError(result.stderr.strip())
    if not os.path.isfile(output_path):
        raise RuntimeError("Output not created")


def upscale_pillow(input_path, output_path, scale=2):
    """Fallback: Pillow LANCZOS upscale (no AI, no GPU needed)."""
    from PIL import Image
    with Image.open(input_path) as img:
        new_size = (img.width * scale, img.height * scale)
        upscaled = img.resize(new_size, Image.LANCZOS)
        upscaled.save(output_path, 'PNG')


class Handler(http.server.SimpleHTTPRequestHandler):
    binary = None

    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(TOOLS_DIR), **kwargs)

    def end_headers(self):
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
        self.send_header('Access-Control-Allow-Headers', 'Content-Type')
        super().end_headers()

    def do_OPTIONS(self):
        self.send_response(200)
        self.end_headers()

    def do_GET(self):
        path = urlparse(self.path).path
        if path == '/':
            self.send_response(302)
            self.send_header('Location', '/proxy-print.html')
            self.end_headers()
        elif path == '/health':
            self._health()
        else:
            super().do_GET()

    def do_POST(self):
        path = urlparse(self.path).path
        if path == '/upscale':
            self._upscale()
        else:
            self.send_response(404)
            self.end_headers()

    def _health(self):
        data = {
            'status': 'ok',
            'binary': self.binary or 'pillow-lanczos',
            'mode': 'ai' if self.binary else 'lanczos',
            'scale': SCALE,
            'model': MODEL_NAME if self.binary else 'LANCZOS',
        }
        self.send_response(200)
        self.send_header('Content-Type', 'application/json')
        self.end_headers()
        self.wfile.write(json.dumps(data).encode())

    def _upscale(self):
        # Parse scale from query string (?scale=2 or ?scale=4)
        qs = parse_qs(urlparse(self.path).query)
        scale = int(qs.get('scale', [str(SCALE)])[0])
        if scale not in (2, 4):
            scale = SCALE

        content_type = self.headers.get('Content-Type', '')
        content_length = int(self.headers.get('Content-Length', 0))

        if 'multipart/form-data' in content_type:
            form = cgi.FieldStorage(
                fp=self.rfile, headers=self.headers,
                environ={'REQUEST_METHOD': 'POST', 'CONTENT_TYPE': content_type}
            )
            item = form['image']
            img_data = item.file.read()
            ext = Path(item.filename or 'i.png').suffix or '.png'
        else:
            img_data = self.rfile.read(content_length)
            ext = '.png'

        # Check disk cache
        img_hash = hashlib.sha256(img_data).hexdigest()[:16]
        mode = 'ai' if self.binary else 'lanczos'
        use_jpg = self.binary and is_upscayl_bin(self.binary)
        out_ext = 'jpg' if use_jpg else 'png'
        content_type = 'image/jpeg' if use_jpg else 'image/png'
        cache_path = CACHE_DIR / f'{img_hash}_{scale}x_{mode}.{out_ext}'

        if cache_path.exists():
            result = cache_path.read_bytes()
            self.send_response(200)
            self.send_header('Content-Type', content_type)
            self.send_header('Content-Length', str(len(result)))
            self.end_headers()
            self.wfile.write(result)
            print(f"  {scale}x: cached ({len(result)//1024}KB)")
            return

        with tempfile.TemporaryDirectory() as tmp:
            inp = os.path.join(tmp, f'in{ext}')
            out = os.path.join(tmp, f'out.{out_ext}')
            with open(inp, 'wb') as f:
                f.write(img_data)
            try:
                if self.binary:
                    upscale_image(self.binary, inp, out, scale=scale)
                else:
                    upscale_pillow(inp, out, scale=scale)
            except Exception as e:
                self._json_error(500, str(e))
                return
            with open(out, 'rb') as f:
                result = f.read()

        # Write to disk cache
        CACHE_DIR.mkdir(parents=True, exist_ok=True)
        cache_path.write_bytes(result)

        self.send_response(200)
        self.send_header('Content-Type', content_type)
        self.send_header('Content-Length', str(len(result)))
        self.end_headers()
        self.wfile.write(result)

        in_kb = len(img_data) // 1024
        out_kb = len(result) // 1024
        print(f"  {scale}x {mode}: {in_kb}KB -> {out_kb}KB")

    def _json_error(self, code, msg):
        self.send_response(code)
        self.send_header('Content-Type', 'application/json')
        self.end_headers()
        self.wfile.write(json.dumps({'error': msg}).encode())

    def log_message(self, fmt, *args):
        if '/health' not in (args[0] if args else ''):
            print(f"  {args[0]}")


def main():
    parser = argparse.ArgumentParser(description='MTG Proxy Print')
    parser.add_argument('--port', type=int, default=DEFAULT_PORT)
    parser.add_argument('--binary', type=str, default=None)
    parser.add_argument('--no-browser', action='store_true')
    args = parser.parse_args()

    binary = find_binary(args.binary)
    Handler.binary = binary

    url = f'http://127.0.0.1:{args.port}'

    print()
    print(f"  MTG Proxy Print")
    print(f"  {'=' * 40}")
    print(f"  URL:      {url}")
    print(f"  Cache:    {CACHE_DIR}")
    if binary:
        print(f"  Upscaler: {Path(binary).name}")
        print(f"  Model:    {MODEL_NAME}")
        print(f"  Mode:     {SCALE}x AI (600 DPI)")
    else:
        print(f"  Upscaler: Pillow LANCZOS (kein Binary)")
        print(f"  Mode:     {SCALE}x LANCZOS (600 DPI, niedrigere Qualitaet)")
        print()
        print(f"  Fuer AI-Upscaling: upscayl-bin in tools/ legen")
        print(f"  Download: https://github.com/upscayl/upscayl-ncnn/releases")
    print(f"  {'=' * 40}")
    print()

    server = http.server.ThreadingHTTPServer(('127.0.0.1', args.port), Handler)

    if not args.no_browser:
        webbrowser.open(url)

    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nGestoppt.")
        server.server_close()


if __name__ == '__main__':
    main()
