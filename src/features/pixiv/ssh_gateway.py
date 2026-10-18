"""Linux loopback gateway: a fresh restricted SSH transport per TCP request.

Uses the operator's existing key and known_hosts; never accepts remote targets
from clients. The Tokyo proxy retains all destination and image size checks.
"""
import argparse
import os
from pathlib import Path
import re
import select
import socketserver
import subprocess
import threading

SLOTS = threading.BoundedSemaphore(8)


def ssh_command(host, key, known_hosts):
    if not re.fullmatch(r'[a-z_][a-z0-9_-]*@[A-Za-z0-9][A-Za-z0-9.-]*', host):
        raise ValueError('Expected user@host')
    return ['ssh', '-T', '-i', str(Path(key).expanduser()),
            '-o', 'IdentitiesOnly=yes', '-o', 'BatchMode=yes',
            '-o', 'StrictHostKeyChecking=yes',
            '-o', 'UserKnownHostsFile=' + str(Path(known_hosts).expanduser()),
            '-o', 'ConnectTimeout=10', '-o', 'ServerAliveInterval=15',
            '-o', 'ServerAliveCountMax=2', '-o', 'IPQoS=none',
            '-W', '127.0.0.1:3222', host]


class Handler(socketserver.BaseRequestHandler):
    def handle(self):
        if not SLOTS.acquire(blocking=False):
            return
        child = None
        try:
            self.request.settimeout(15)
            child = subprocess.Popen(self.server.command, stdin=subprocess.PIPE,
                                     stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
            while True:
                ready, _, _ = select.select([self.request, child.stdout], [], [], 120)
                if not ready:
                    break
                if child.stdout in ready:
                    data = os.read(child.stdout.fileno(), 65536)
                    if not data:
                        break
                    self.request.sendall(data)
                if self.request in ready:
                    data = self.request.recv(65536)
                    if not data:
                        break
                    child.stdin.write(data)
                    child.stdin.flush()
        except (OSError, ValueError):
            pass
        finally:
            if child:
                if child.poll() is None:
                    child.terminate()
                try:
                    child.wait(timeout=3)
                except subprocess.TimeoutExpired:
                    child.kill()
                    child.wait()
                child.stdin.close()
                child.stdout.close()
            SLOTS.release()


class Server(socketserver.ThreadingTCPServer):
    allow_reuse_address = True
    daemon_threads = True

    def handle_error(self, request, client_address):
        pass  # Never log traffic or credentials.


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--host', required=True)
    parser.add_argument('--key', required=True)
    parser.add_argument('--known-hosts', required=True)
    parser.add_argument('--port', type=int, default=3222)
    options = parser.parse_args()
    if not 1 <= options.port <= 65535:
        parser.error('Invalid port')
    command = ssh_command(options.host, options.key, options.known_hosts)
    with Server(('127.0.0.1', options.port), Handler) as server:
        server.command = command
        server.serve_forever()


if __name__ == '__main__':
    main()
