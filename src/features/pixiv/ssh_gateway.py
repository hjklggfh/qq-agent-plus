"""Linux loopback gateway with short, bounded batches of SSH transports.

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
import tempfile
import threading
import time

SLOTS = threading.BoundedSemaphore(8)


class TransportPool:
    def __init__(self, command, batch_size=3, max_age=10, idle_seconds=3,
                 clock=time.monotonic, background=True):
        self.command = command
        self.batch_size = batch_size
        self.max_age = max_age
        self.idle_seconds = idle_seconds
        self.clock = clock
        self.root = tempfile.TemporaryDirectory(prefix='qq-pixiv-ssh-')
        self.entries = []
        self.lock = threading.Lock()
        self.counter = 0
        self.stopped = threading.Event()
        self.reaper = threading.Thread(target=self._reap, daemon=True) if background else None
        if self.reaper:
            self.reaper.start()

    def _expired(self, entry, now):
        return (entry['uses'] >= self.batch_size or now - entry['born'] >= self.max_age
                or now - entry['last'] >= self.idle_seconds
                or entry['process'] is not None and entry['process'].poll() is not None)

    @staticmethod
    def _stop(entry):
        process = entry['process']
        if process is not None:
            if process.poll() is None:
                process.terminate()
            try:
                process.wait(timeout=2)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait()
        Path(entry['path']).unlink(missing_ok=True)

    def sweep(self):
        with self.lock:
            expired = [e for e in self.entries if not e['busy'] and self._expired(e, self.clock())]
            self.entries = [e for e in self.entries if e not in expired]
        for entry in expired:
            self._stop(entry)

    def acquire(self):
        self.sweep()
        with self.lock:
            entry = next((e for e in self.entries if not e['busy']), None)
            if entry is None:
                if len(self.entries) >= 8:
                    raise OSError('Transport capacity reached')
                self.counter += 1
                entry = {'path': str(Path(self.root.name) / str(self.counter)),
                         'process': None, 'uses': 0, 'busy': False,
                         'born': self.clock(), 'last': self.clock()}
                self.entries.append(entry)
            entry['uses'] += 1
            entry['busy'] = True
            return entry

    def worker_command(self, entry):
        if entry['process'] is None:
            command = self.command[:-3] + ['-M', '-N', '-S', entry['path'],
                                         '-o', 'ControlPersist=no', self.command[-1]]
            entry['process'] = subprocess.Popen(command, stdin=subprocess.DEVNULL,
                                                stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            deadline = time.monotonic() + 12
            while not Path(entry['path']).exists():
                if entry['process'].poll() is not None or time.monotonic() > deadline:
                    raise OSError('SSH transport startup failed')
                time.sleep(.02)
        return self.command[:-3] + ['-S', entry['path'], '-o', 'ControlMaster=no'] + self.command[-3:]

    def release(self, entry):
        with self.lock:
            entry['busy'] = False
            entry['last'] = self.clock()
        self.sweep()

    def _reap(self):
        while not self.stopped.wait(.5):
            self.sweep()

    def close(self):
        self.stopped.set()
        if self.reaper:
            self.reaper.join(timeout=2)
        for entry in self.entries:
            self._stop(entry)
        self.entries.clear()
        self.root.cleanup()


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
        lease = None
        pool = getattr(self.server, 'pool', None)
        try:
            self.request.settimeout(15)
            lease = pool.acquire() if pool else None
            command = pool.worker_command(lease) if pool else self.server.command
            child = subprocess.Popen(command, stdin=subprocess.PIPE,
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
            if lease is not None:
                pool.release(lease)
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
    parser.add_argument('--batch-size', type=int, default=3)
    options = parser.parse_args()
    if not 1 <= options.port <= 65535:
        parser.error('Invalid port')
    if not 1 <= options.batch_size <= 3:
        parser.error('Batch size must be between 1 and 3')
    command = ssh_command(options.host, options.key, options.known_hosts)
    pool = TransportPool(command, batch_size=options.batch_size) if options.batch_size > 1 else None
    try:
        with Server(('127.0.0.1', options.port), Handler) as server:
            server.command = command
            server.pool = pool
            server.serve_forever()
    finally:
        if pool:
            pool.close()


if __name__ == '__main__':
    main()
