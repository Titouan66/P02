"""Petit serveur de développement sans cache : python3 serveur.py [port]"""
import sys
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer


class SansCache(SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header("Cache-Control", "no-store")
        super().end_headers()


port = int(sys.argv[1]) if len(sys.argv) > 1 else 8000
print(f"http://localhost:{port}")
ThreadingHTTPServer(("", port), SansCache).serve_forever()
