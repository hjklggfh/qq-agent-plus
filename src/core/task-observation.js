// Bounded, process-local telemetry. Never retain errors, payloads or timer handles.
const observations = new WeakMap();
export const TASK_FAILURE_REASONS = Object.freeze({
  timeout: '请求超时，请检查服务响应与网络', network: '网络连接失败，请检查目标服务',
  disk: '磁盘空间不足，状态读写失败', permission: '访问被拒绝，请检查文件或服务权限',
  database: '数据库读写失败，请检查服务日志', execution: '任务执行失败，请到对应功能或服务日志查看详情'
});

function observation(owner, id) {
  if (!observations.has(owner)) observations.set(owner, new Map());
  const tasks = observations.get(owner);
  if (!tasks.has(id)) tasks.set(id, {});
  return tasks.get(id);
}

function failureCode(error) {
  const code = String(error?.code || error?.cause?.code || error?.name || '');
  if (/TIMEOUT|ETIMEDOUT|TimeoutError/.test(code)) return 'timeout';
  if (/ECONN|ENOTFOUND|EAI_AGAIN|UND_ERR/.test(code)) return 'network';
  if (/ENOSPC|SQLITE_FULL/.test(code)) return 'disk';
  if (/EACCES|EPERM/.test(code)) return 'permission';
  if (/SQLITE/.test(code)) return 'database';
  return 'execution';
}

export function scheduleTaskObservation(owner, id, nextRunAt) {
  observation(owner, id).nextRunAt = nextRunAt;
}

export function taskObservation(owner, id) {
  return { ...observations.get(owner)?.get(id) };
}

// Preserve synchronous callers and the original rejection/logging behavior.
export function observeTask(owner, id, operation, now = Date.now) {
  const readClock = now;
  const data = observation(owner, id);
  data.lastRunAt = readClock();
  data.pendingCount = (data.pendingCount || 0) + 1;
  data.running = true;
  const finish = () => { data.pendingCount--; data.running = data.pendingCount > 0; };
  const success = value => { finish(); data.lastSuccessAt = readClock(); data.failed = false; return value; };
  const failure = error => {
    finish();
    if (error?.name !== 'AbortError' && error?.code !== 'TIME_CONTROL_INACTIVE') {
      data.lastErrorAt = readClock(); data.failureCode = failureCode(error); data.failed = true;
    }
    throw error;
  };
  try {
    const result = operation();
    return result && typeof result.then === 'function' ? result.then(success, failure) : success(result);
  } catch (error) { return failure(error); }
}
