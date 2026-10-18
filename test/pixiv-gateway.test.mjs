import assert from 'node:assert/strict';
import test from 'node:test';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import net from 'node:net';
import { fileURLToPath } from 'node:url';

const python = process.platform === 'win32' ? 'python' : 'python3';
const source = fileURLToPath(new URL('../src/features/pixiv/ssh_gateway.py', import.meta.url));
const available = spawnSync(python, ['--version'], { timeout: 5000 }).status === 0;
const load = 'import importlib.util,sys; s=importlib.util.spec_from_file_location("gateway",sys.argv[1]); m=importlib.util.module_from_spec(s); s.loader.exec_module(m)\n';

test('PID网关仅通过已有密钥转发固定东京端口，保留主机验证', { skip: !available }, () => {
  const result = spawnSync(python, ['-B', '-c', load + `
command=m.ssh_command('ubuntu@example.com','/private/key','/private/known')
assert command[-3:]==['-W','127.0.0.1:3222','ubuntu@example.com']
assert 'StrictHostKeyChecking=yes' in command and 'BatchMode=yes' in command
assert 'UserKnownHostsFile='+str(m.Path('/private/known')) in command and 'IdentitiesOnly=yes' in command
for host in ['-oProxyCommand=evil','ubuntu@host;evil','ubuntu@host/path','user name@host']:
 try:m.ssh_command(host,'key','known')
 except ValueError:pass
 else:raise AssertionError(host)
`, source], { encoding: 'utf8', timeout: 10000 });
  assert.equal(result.status, 0, result.stderr);
});

test('PID网关每个请求建立新进程，完整转发响应且退出释放资源', { skip: !available || process.platform === 'win32' }, async (t) => {
  const script = load + `
server=m.Server(('127.0.0.1',0),m.Handler)
server.command=[sys.executable,'-u','-c',"import os;os.read(0,4096);body=str(os.getpid()).encode();sep=bytes([13,10]);os.write(1,b'HTTP/1.1 200 OK'+sep+b'Connection: close'+sep+b'Content-Length: '+str(len(body)).encode()+sep+sep+body)"]
print(server.server_address[1],flush=True);server.serve_forever()
`;
  const child = spawn(python, ['-B', '-u', '-c', script, source], { stdio: ['ignore', 'pipe', 'pipe'] });
  t.after(async () => { const stopped = once(child, 'exit'); child.kill(); await stopped; });
  const [chunk] = await once(child.stdout, 'data');
  const port = Number(chunk.toString().trim());
  const request = () => new Promise((resolve, reject) => {
    const socket = net.connect(port, '127.0.0.1');
    socket.setTimeout(5000, () => socket.destroy(new Error('Gateway timeout')));
    socket.once('error', reject);
    socket.once('connect', () => socket.write('GET /healthz HTTP/1.1\r\nHost: local\r\n\r\n'));
    let response = '';
    socket.on('data', (data) => { response += data; });
    socket.once('end', () => resolve(response));
  });
  const first = await request(), second = await request();
  assert.match(first, /^HTTP\/1.1 200 OK/);
  assert.match(second, /^HTTP\/1.1 200 OK/);
  assert.notEqual(first.split('\r\n\r\n')[1], second.split('\r\n\r\n')[1]);
});
