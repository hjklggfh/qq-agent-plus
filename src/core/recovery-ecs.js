import fs from 'node:fs';
import https from 'node:https';
import { createHash, createHmac, randomUUID } from 'node:crypto';

const ALLOWED = new Set(['DescribeInstanceStatus', 'DescribeInstancesFullStatus', 'RebootInstance']);
const hash = value => createHash('sha256').update(value).digest('hex');
const encode = value => encodeURIComponent(String(value)).replace(/[!'()*]/g, char => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);

export function loadEcsCredentials(file, expected = {}) {
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.size > 16384 || (stat.mode & 0o077) || (process.getuid && stat.uid !== process.getuid())) throw new Error('ECS credential file must be private and owned by this user');
  const data = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!/^[A-Za-z0-9]{8,128}$/.test(data.accessKeyId || '') || typeof data.accessKeySecret !== 'string' || data.accessKeySecret.length < 16
    || !/^[a-z]{2}-[a-z0-9-]+$/.test(data.regionId || '') || !/^i-[a-z0-9]+$/.test(data.instanceId || '')) throw new Error('ECS credential configuration invalid');
  if ((expected.instanceId && expected.instanceId !== data.instanceId) || (expected.regionId && expected.regionId !== data.regionId)) throw new Error('ECS target differs from configured instance');
  return data;
}

export function ecsSignedRequest(credentials, action, parameters, options = {}) {
  if (!ALLOWED.has(action) || (action === 'RebootInstance' && parameters.ForceStop !== 'false')) throw new Error('ECS operation not allowed');
  if (!/^[a-z]{2}-[a-z0-9-]+$/.test(credentials.regionId)) throw new Error('Invalid ECS region');
  const hostname = `ecs.${credentials.regionId}.aliyuncs.com`;
  const query = Object.keys(parameters).sort().map(key => `${encode(key)}=${encode(parameters[key])}`).join('&');
  const headers = { host: hostname, 'x-acs-action': action, 'x-acs-version': '2014-05-26',
    'x-acs-date': (options.now || new Date()).toISOString().replace(/\.\d{3}Z$/, 'Z'),
    'x-acs-signature-nonce': options.nonce || randomUUID(), 'x-acs-content-sha256': hash('') };
  const names = Object.keys(headers).sort();
  const canonicalHeaders = names.map(name => `${name}:${headers[name]}\n`).join('');
  const canonical = ['POST', '/', query, canonicalHeaders, names.join(';'), hash('')].join('\n');
  const signature = createHmac('sha256', credentials.accessKeySecret).update(`ACS3-HMAC-SHA256\n${hash(canonical)}`).digest('hex');
  headers.authorization = `ACS3-HMAC-SHA256 Credential=${credentials.accessKeyId},SignedHeaders=${names.join(';')},Signature=${signature}`;
  headers.accept = 'application/json'; headers['content-length'] = '0';
  return { hostname, path: `/?${query}`, method: 'POST', headers };
}

async function ecsCall(credentials, action, parameters, options = {}) {
  const requestOptions = ecsSignedRequest(credentials, action, parameters);
  const send = options.send || https.request;
  return new Promise((resolve, reject) => {
    const request = send({ ...requestOptions, signal: AbortSignal.timeout(12000) }, response => {
      let size = 0; const chunks = [];
      response.on('error', () => reject(Object.assign(new Error('ECS response interrupted'), { code: 'NetworkFailure' })));
      response.on('data', chunk => { size += chunk.length; if (size > 262144) { response.destroy(); reject(new Error('ECS response too large')); } else chunks.push(chunk); });
      response.on('end', () => {
        let body; try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { reject(new Error('ECS response invalid')); return; }
        if (response.statusCode < 200 || response.statusCode >= 300 || body.Code) {
          const code = /^[A-Za-z0-9._-]{1,120}$/.test(body.Code || '') ? body.Code : `HTTP${response.statusCode}`;
          reject(Object.assign(new Error(`ECS API ${code}`), { code })); return;
        }
        resolve(body);
      });
    });
    request.on('error', () => reject(Object.assign(new Error('ECS request outcome unknown'), { code: 'NetworkFailure' })));
    request.end();
  });
}

export async function ecsInstanceState(credentials, options = {}) {
  const data = await ecsCall(credentials, 'DescribeInstanceStatus', { RegionId: credentials.regionId, 'InstanceId.1': credentials.instanceId }, options);
  const rows = data.InstanceStatuses?.InstanceStatus;
  const matches = Array.isArray(rows) ? rows.filter(row => row.InstanceId === credentials.instanceId) : [];
  if (matches.length !== 1) throw new Error('ECS instance status missing');
  return { status: matches[0].Status };
}

export async function ecsFullState(credentials, options = {}) {
  const data = await ecsCall(credentials, 'DescribeInstancesFullStatus', { RegionId: credentials.regionId, 'InstanceId.1': credentials.instanceId }, options);
  const rows = data.InstanceFullStatusSet?.InstanceFullStatusType;
  const matches = Array.isArray(rows) ? rows.filter(row => row.InstanceId === credentials.instanceId) : [];
  if (matches.length !== 1) throw new Error('ECS full status missing');
  const row = matches[0];
  return { status: row.Status?.Name, health: row.HealthStatus?.Name,
    scheduledEvents: row.ScheduledSystemEventSet?.ScheduledSystemEventType?.length || 0 };
}

export async function ecsReboot(credentials, options = {}) {
  const dryRun = options.dryRun !== false;
  if (!dryRun && options.confirm !== true) throw new Error('ECS reboot requires explicit confirmation');
  try {
    const response = await ecsCall(credentials, 'RebootInstance', { RegionId: credentials.regionId, InstanceId: credentials.instanceId,
      ForceStop: 'false', DryRun: String(dryRun) }, options);
    if (dryRun) throw new Error('ECS dry run returned an unexpected response');
    if (!/^[A-Za-z0-9-]{8,128}$/.test(response.RequestId || '')) throw new Error('ECS reboot acknowledgment missing');
    return { accepted: true, requestId: response.RequestId, forceStop: false };
  } catch (error) {
    if (dryRun && error.code === 'DryRunOperation') return { dryRunPassed: true, forceStop: false };
    throw error;
  }
}
