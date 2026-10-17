import assert from 'node:assert/strict';
import test from 'node:test';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import net from 'node:net';
import { fileURLToPath } from 'node:url';
import { fetchRelayedImage, validateImageRelay } from '../src/features/pixiv/image-relay.js';

const python = process.platform === 'win32' ? 'python' : 'python3';
const source = fileURLToPath(new URL('../src/features/pixiv/connect_proxy.py', import.meta.url));
const available = spawnSync(python, ['--version'], { timeout: 5000 }).status === 0;
const load = 'import importlib.util,sys; s=importlib.util.spec_from_file_location("pixiv_proxy",sys.argv[1]); m=importlib.util.module_from_spec(s); s.loader.exec_module(m)\n';

test('图片中转只接受本机端点，图片请求不转发Cookie', async () => {
  for (const url of ['http://example.com/image', 'https://127.0.0.1/image', 'http://u:p@127.0.0.1/image', 'http://127.0.0.1/image?secret=1']) assert.throws(() => validateImageRelay(url));
  const signal = new AbortController().signal;
  await fetchRelayedImage('https://i.pximg.net/img-original/img/test.jpg', { imageRelayUrl: 'http://127.0.0.1:3222/image', maxImageBytes: 1048576, downsampleMaxEdge: 1200, timeoutMs: 60000, cookie: 'private' }, { signal, fetchImpl: async (url, options) => {
    assert.equal(url, 'http://127.0.0.1:3222/image');
    assert.equal(options.signal, signal);
    assert.equal(options.redirect, 'error');
    assert.deepEqual(options.headers, { 'content-type': 'application/json' });
    assert.deepEqual(JSON.parse(options.body), { url: 'https://i.pximg.net/img-original/img/test.jpg', maxBytes: 1048576, maxEdge: 1200, timeoutSeconds: 60 });
    return new Response('ok');
  } });
  await assert.rejects(fetchRelayedImage('https://evil.test/a.jpg', { imageRelayUrl: 'http://127.0.0.1:3222/image' }));
});

test('东京图片处理拒绝其他主机、凭据、查询串与超限参数', { skip: !available }, () => {
  const script = load + `
valid={'url':'https://i.pximg.net/img-original/img/test.jpg','maxBytes':1048576,'maxEdge':1200,'timeoutSeconds':60}
assert m.image_request(valid)==('/img-original/img/test.jpg',1048576,1200,60)
for bad in [dict(valid,url='https://127.0.0.1/img-original/img/a.jpg'),dict(valid,url='https://i.pximg.net.evil.test/img-original/img/a.jpg'),dict(valid,url='https://u:p@i.pximg.net/img-original/img/a.jpg'),dict(valid,url=valid['url']+'?secret=1'),dict(valid,cookie='private'),dict(valid,maxBytes=999999999),dict(valid,maxEdge=99999),dict(valid,timeoutSeconds=True)]:
 try:m.image_request(bad)
 except ValueError:pass
 else:raise AssertionError(bad)
`;
  const result = spawnSync(python, ['-B', '-c', script, source], { encoding: 'utf8', timeout: 10000 });
  assert.equal(result.status, 0, result.stderr);
});

const pillow = available && spawnSync(python, ['-c', 'import PIL'], { timeout: 5000 }).status === 0;
test('东京缩图生成白底JPEG，并拒绝超大文件及重定向', { skip: !pillow }, () => {
  const script = load + `
from PIL import Image
from unittest.mock import patch
import io
buf=io.BytesIO();Image.new('RGBA',(1600,800),(255,0,0,0)).save(buf,'PNG');data=buf.getvalue()
class Response:
 status=200
 def getheader(self,name):return str(len(data))
 def read(self,limit):return data[:limit]
class Connection:
 def __init__(self,*a,**kw):pass
 def request(self,method,path,headers):assert set(headers)=={'Referer','User-Agent'}
 def getresponse(self):return Response()
 def close(self):pass
value={'url':'https://i.pximg.net/img-original/img/test.png','maxEdge':800}
with patch.object(m,'PublicHTTPS',Connection):
 status,result=m.compressed_image(value);assert status==200
 with Image.open(io.BytesIO(result)) as image:
  assert image.size==(800,400);assert image.format=='JPEG';assert min(image.getpixel((10,10)))>245
 with patch.object(Response,'status',302):assert m.compressed_image(value)[0]==502
 with patch.object(Response,'getheader',return_value='999999999'):assert m.compressed_image(value)[0]==413
`;
  const result = spawnSync(python, ['-B', '-c', script, source], { encoding: 'utf8', timeout: 15000 });
  assert.equal(result.status, 0, result.stderr);
});

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
