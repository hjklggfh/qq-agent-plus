"""Loopback-only HTTPS CONNECT proxy for the operator's Pixiv SSH tunnel.

CONNECT preserves end-to-end TLS. The optional /image endpoint fetches public
CDN images and compresses them without accepting cookies. Nothing is persisted.
"""
import argparse
import http.client
import io
import ipaddress
import json
import select
import socket
import socketserver
import threading
from urllib.parse import urlsplit

HOSTS = frozenset({
    'www.pixiv.net', 'app-api.pixiv.net', 'i.pximg.net', 's.pximg.net',
    'pixiv.re', 'i.pixiv.re', 'api.lolicon.app',
})
SLOTS = threading.BoundedSemaphore(8)
IMAGE_SLOT = threading.BoundedSemaphore(3)
DECODE_SLOT = threading.BoundedSemaphore(1)


class PublicHTTPS(http.client.HTTPSConnection):
    def connect(self):
        raw = socket.create_connection((public_address(self.host), 443), self.timeout)
        try:
            self.sock = self._context.wrap_socket(raw, server_hostname=self.host)
        except Exception:
            raw.close()
            raise


def image_request(value):
    if not isinstance(value, dict) or set(value) - {'url', 'maxBytes', 'maxEdge', 'timeoutSeconds'}:
        raise ValueError('Invalid image options')
    url = urlsplit(str(value.get('url', '')))
    if (url.scheme != 'https' or url.netloc != 'i.pximg.net' or url.query or url.fragment
            or not url.path.startswith(('/img-original/img/', '/img-master/img/', '/c/'))):
        raise ValueError('Official image URL required')
    limit = value.get('maxBytes', 5 * 1024 * 1024)
    edge = value.get('maxEdge', 1200)
    timeout = value.get('timeoutSeconds', 60)
    if (type(limit) is not int or not 65536 <= limit <= 16 * 1024 * 1024
            or type(edge) is not int or not 256 <= edge <= 4096
            or type(timeout) is not int or not 3 <= timeout <= 60):
        raise ValueError('Invalid image limits')
    return url.path, limit, edge, timeout


def compressed_image(value):
    from PIL import Image
    target, limit, edge, timeout = image_request(value)
    connection = PublicHTTPS('i.pximg.net', timeout=timeout)
    try:
        connection.request('GET', target, headers={'Referer': 'https://www.pixiv.net/', 'User-Agent': 'Mozilla/5.0'})
        response = connection.getresponse()
        if response.status != 200:
            return response.status if response.status >= 400 else 502, b''
        if int(response.getheader('Content-Length') or 0) > limit:
            return 413, b''
        data = response.read(limit + 1)
        if len(data) > limit:
            return 413, b''
    finally:
        connection.close()
    with DECODE_SLOT, Image.open(io.BytesIO(data)) as image:
        if image.width * image.height > 24000000:
            return 413, b''
        image.thumbnail((edge, edge))
        with image.convert('RGBA') as rgba, Image.new('RGB', image.size, 'white') as rgb, io.BytesIO() as output:
            rgb.paste(rgba, mask=rgba.getchannel('A'))
            rgb.save(output, 'JPEG', quality=75, optimize=True)
            return 200, output.getvalue()


def target_of(method, target):
    if method != 'CONNECT':
        raise ValueError('CONNECT required')
    host, separator, port = target.rpartition(':')
    if separator != ':' or port != '443' or host not in HOSTS:
        raise ValueError('Destination denied')
    return host


def public_address(host):
    addresses = socket.getaddrinfo(host, 443, socket.AF_INET, socket.SOCK_STREAM)
    for entry in addresses:
        address = entry[4][0]
        if ipaddress.ip_address(address).is_global:
            return address
    raise ValueError('Public destination required')


class Handler(socketserver.StreamRequestHandler):
    def reply(self, status):
        self.wfile.write(f'HTTP/1.1 {status}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n'.encode('ascii'))
        self.wfile.flush()

    def handle(self):
        self.connection.settimeout(10)
        self.connection.setsockopt(socket.IPPROTO_TCP, socket.TCP_NODELAY, 1)
        acquired = False
        connected = False
        try:
            request = self.rfile.readline(8193)
            if len(request) > 8192:
                self.reply('431 Request Header Fields Too Large')
                return
            parts = request.decode('ascii').strip().split()
            if len(parts) != 3:
                self.reply('400 Bad Request')
                return
            method, target, version = parts
            size = len(request)
            length = 0
            while True:
                header = self.rfile.readline(8193)
                size += len(header)
                if size > 16384:
                    self.reply('431 Request Header Fields Too Large')
                    return
                if header in (b'\r\n', b'\n', b''):
                    break
                if header.lower().startswith(b'content-length:'):
                    length = int(header.split(b':', 1)[1].strip())
            if (method, target) == ('POST', '/image'):
                if not 1 <= length <= 4096:
                    self.reply('400 Bad Request')
                    return
                value = json.loads(self.rfile.read(length))
                try:
                    image_request(value)
                except ValueError:
                    self.reply('403 Forbidden')
                    return
                if not IMAGE_SLOT.acquire(blocking=False):
                    self.reply('503 Service Unavailable')
                    return
                try:
                    status, data = compressed_image(value)
                    self.wfile.write(f'HTTP/1.1 {status} Image Response\r\nContent-Type: image/jpeg\r\nContent-Length: {len(data)}\r\nConnection: close\r\n\r\n'.encode('ascii'))
                    self.wfile.write(data)
                    self.wfile.flush()
                finally:
                    IMAGE_SLOT.release()
                return
            if (method, target) == ('GET', '/healthz'):
                self.reply('200 OK')
                return
            try:
                host = target_of(method, target)
            except ValueError:
                self.reply('403 Forbidden')
                return
            if version not in ('HTTP/1.1', 'HTTP/1.0'):
                self.reply('400 Bad Request')
                return
            acquired = SLOTS.acquire(blocking=False)
            if not acquired:
                self.reply('503 Service Unavailable')
                return
            with socket.create_connection((public_address(host), 443), timeout=15) as upstream:
                upstream.setsockopt(socket.IPPROTO_TCP, socket.TCP_NODELAY, 1)
                self.wfile.write(b'HTTP/1.1 200 Connection Established\r\n\r\n')
                self.wfile.flush()
                connected = True
                upstream.settimeout(30)
                self.connection.settimeout(30)
                while True:
                    ready, _, _ = select.select([self.connection, upstream], [], [], 120)
                    if not ready:
                        break
                    for source in ready:
                        data = source.recv(65536)
                        if not data:
                            return
                        (upstream if source is self.connection else self.connection).sendall(data)
        except (OSError, ValueError, UnicodeError):
            if not connected:
                try:
                    self.reply('502 Bad Gateway')
                except OSError:
                    pass
        finally:
            if acquired:
                SLOTS.release()


class Server(socketserver.ThreadingTCPServer):
    allow_reuse_address = True
    daemon_threads = True

    def handle_error(self, request, client_address):
        # Do not include request details or encrypted transport data in logs.
        pass


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--port', type=int, default=3222)
    options = parser.parse_args()
    if not 1 <= options.port <= 65535:
        parser.error('Invalid port')
    with Server(('127.0.0.1', options.port), Handler) as server:
        server.serve_forever()


if __name__ == '__main__':
    main()
