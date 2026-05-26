from http.server import BaseHTTPRequestHandler, HTTPServer
import json
import os


class Handler(BaseHTTPRequestHandler):
    def do_GET(self):
        payload = {
            "status": "placeholder",
            "service": "chronos",
            "message": "Future Chronos prediction service will live here.",
        }
        body = json.dumps(payload).encode("utf-8")

        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)


port = int(os.environ.get("CHRONOS_PORT", "8000"))
server = HTTPServer(("0.0.0.0", port), Handler)
print(f"Chronos placeholder listening on http://0.0.0.0:{port}")
server.serve_forever()
