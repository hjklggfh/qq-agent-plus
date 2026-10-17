import assert from 'node:assert/strict';
import test from 'node:test';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import net from 'node:net';
import { fileURLToPath } from 'node:url';

const python = process.platform === 'win32' ? 'python' : 'python3';
const source = fileURLToPath(new URL('../src/features/pixiv/connect_proxy.py', import.meta.url));
const available = spawnSync(python, ['--version'], { timeout: 5000 }).status === 0;
const load = 'import importlib.util,sys; s=importlib.util.spec_from_file_location("pixiv_proxy",sys.argv[1]); m=importlib.util.module_from_spec(s); s.loader.exec_module(m)\n';

test('PID独立代理只允许指定HTTPS主机，并拒绝DNS解析为私网', { skip: !available }, () => {
  const script = load + `
from unittest.mock import patch
assert m.target_of('CONNECT','www.pixiv.net:443') == 'www.pixiv.net'
for method,target in [('GET','https://www.pixiv.net/'),('CONNECT','127.0.0.1:443'),('CONNECT','www.pixiv.net:80'),('CONNECT','www.pixiv.net.evil.test:443'),('CONNECT','u:p@www.pixiv.net:443')]:
 try: m.target_of(method,target)
 except ValueError: pass
 else: raise AssertionError(target)
with patch('socket.getaddrinfo', return_value=[(2,1,6,'',('127.0.0.1',443))]):
 try: m.public_address('www.pixiv.net')
 except ValueError: pass
 else: raise AssertionError('Private DNS accepted')
`;
  const result = spawnSync(python, ['-B', '-c', script, source], { encoding: 'utf8', timeout: 10000 });
  assert.equal(result.status, 0, result.stderr);
});

test('PID代理本机健康检查可用，通用HTTP与白名单外CONNECT均被拒绝', { skip: !available }, async (t) => {
  const child = spawn(python, ['-B', '-u', '-c', load + "server=m.Server(('127.0.0.1',0),m.Handler); print(server.server_address[1],flush=True); server.serve_forever()", source], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  t.after(async () => { const stopped = once(child, 'exit'); child.kill(); await stopped; });
  const [chunk] = await once(child.stdout, 'data');
  const port = Number(chunk.toString().trim()); assert.ok(port > 0);
  const request = (line) => new Promise((resolve, reject) => {
    const socket = net.connect(port, '127.0.0.1');
    socket.setTimeout(3000, () => socket.destroy(new Error('Proxy test timeout')));
    socket.once('error', reject);
    socket.once('connect', () => socket.write(line + '\r\nHost: localhost\r\n\r\n'));
    let text = '';
    socket.on('data', (data) => { text += data.toString(); });
    socket.once('end', () => resolve(text));
  });
  assert.match(await request('GET /healthz HTTP/1.1'), /^HTTP\/1.1 200/);
  assert.match(await request('GET https://www.pixiv.net/ HTTP/1.1'), /^HTTP\/1.1 403/);
  assert.match(await request('CONNECT example.com:443 HTTP/1.1'), /^HTTP\/1.1 403/);
  assert.match(await request('CONNECT 127.0.0.1:443 HTTP/1.1'), /^HTTP\/1.1 403/);
});
