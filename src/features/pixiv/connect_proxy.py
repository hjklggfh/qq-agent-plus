"""Loopback-only HTTPS CONNECT proxy for the operator's Pixiv SSH tunnel.

TLS stays between the Agent and the destination. No cookies, URLs, or image
contents are logged or stored here. This service is independent of image search.
"""
import argparse
import ipaddress
import select
import socket
import socketserver
import threading

HOSTS = frozenset({
    'www.pixiv.net', 'app-api.pixiv.net', 'i.pximg.net', 's.pximg.net',
    'pixiv.re', 'i.pixiv.re', 'api.lolicon.app',
})
SLOTS = threading.BoundedSemaphore(8)


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
            while True:
                header = self.rfile.readline(8193)
                size += len(header)
                if size > 16384:
                    self.reply('431 Request Header Fields Too Large')
                    return
                if header in (b'\r\n', b'\n', b''):
                    break
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
