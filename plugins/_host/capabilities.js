// 插件能力清单（capability allowlist）。
//
// 这是整套插件系统里**唯一**决定"插件能碰到宿主什么"的地方。设计口径：
//
// - 没在 manifest.capabilities 里声明的能力，门面上**根本不存在那个方法** ——
//   插件不是"拿到全权限但被劝告别用"，而是根本拿不到（见 context.js）。声明式清单
//   之所以有意义，全靠这一点。
// - 能力清单进 manifest 指纹（manifest.js 的 manifestFingerprint），所以插件升级后
//   新增能力会变成 pending-approval、必须管理员重新确认 —— 这条是 fail-closed 的关键：
//   否则"换个版本号"就能悄悄多拿一个 chat:send。
// - 每个能力的 label/risk 给控制台直接用，不要在 UI 里另抄一份文案。

/**
 * risk 的语义（控制台按它排序与上色）：
 *   'low'    只读或纯本地，坏了最多是插件自己出问题
 *   'medium' 会写出宿主可见的状态（发消息、写磁盘、发网络请求）
 *   'high'   能碰到凭据
 */
export const PLUGIN_CAPABILITIES = Object.freeze([
  {
    id: 'chat:send',
    label: '发送消息',
    risk: 'medium',
    summary: '在当前会话里发言（文本/表情），走宿主既有的分条、限频与 outbox 记账。',
    detail: 'chatKey 由宿主绑死，插件无法把消息发到别的会话。发送结果与内置工具同一套'
      + '（成功进 session.sent、失败按网络错误重试一次），插件拿不到底层发送队列。'
  },
  {
    id: 'chat:read',
    label: '读取聊天记录',
    risk: 'low',
    summary: '读取当前会话最近的消息，条数与字段都有上限。',
    detail: '只返回当前会话、只读、条数封顶（默认 20，最多 100），只给文本与发言人标识，'
      + '不给图片二进制、不给其它会话、不给翻页历史。'
  },
  {
    id: 'chat:send-image',
    label: '发送图片',
    risk: 'medium',
    summary: '把一张图片发到当前会话：可以给自己状态目录里的文件，也可以给一个公网图片地址。',
    detail: '与 chat:send 是**两个**能力，因为它是一种不同的外发效果（往群里贴图），'
      + '管理员应当能分开决定给不给。chatKey 同样由宿主绑死；引用/@ 不支持。'
      + '两种来源：① `{ path }` —— 必须是**该插件自己状态目录内**的文件'
      + '（<数据目录>/plugin-state/<插件 id>/，需要同时声明 storage），宿主读出来按既有约定'
      + '拼成 base64 发送，并有体积上限；**不接受状态目录之外的路径** —— 否则一个插件就能'
      + '把宿主的 config.json（含明文凭据）当图片发出去。'
      + '② `{ url }` —— 公网 http(s) 地址，按内置表情的同一道守卫校验（拒绝内网/本机/非法协议），'
      + '由协议端自行下载。发送走既有的发送队列：禁言预检、限频、outbox 记账、'
      + '「可确认未送达才重试」与异常捕获全部继承。'
  },
  {
    id: 'storage',
    label: '持久化存储',
    risk: 'low',
    summary: '读写自己的键值存储与状态目录，重启不丢。',
    detail: '落在 <数据目录>/plugin-state/<插件 id>/，与插件代码目录分开 —— 换掉插件目录不会'
      + '丢数据。写入走 tmp+rename+0600，单次写入有体积上限。'
  },
  {
    id: 'http',
    label: '发起网络请求',
    risk: 'medium',
    summary: '按 SSRF 防护发起 http/https 请求（GET/POST/PUT/PATCH/DELETE/HEAD）。',
    detail: '复用宿主 web_fetch 的同一套防护：仅 http(s)、拒绝带凭据的 URL、DNS 级拒绝内网/本机'
      + '地址（并发请求到已校验的 IP，保留 Host/SNI，从根上消除 DNS rebinding）、响应体积与'
      + '超时都有上限。插件拿不到裸 fetch。'
  },
  {
    id: 'secrets',
    label: '读取自己的凭据',
    risk: 'high',
    summary: '读取配置里本插件自己那一段的凭据字段，明文只在宿主进程内可见。',
    detail: '只能读到 plugins.settings.<插件 id> 下、且字段名命中密钥模式的键；其它插件与宿主的'
      + '任何凭据都读不到。这些字段在 /api/config 响应里始终被剥离，审计日志同样脱敏。'
  }
]);

/** 能力 id 列表，给 manifest 校验当白名单用。 */
export const PLUGIN_CAPABILITY_IDS = Object.freeze(
  PLUGIN_CAPABILITIES.map((entry) => entry.id)
);

const BY_ID = new Map(PLUGIN_CAPABILITIES.map((entry) => [entry.id, entry]));

export function capabilityById(id) {
  return BY_ID.get(String(id ?? '')) || null;
}

export function isKnownCapability(id) {
  return BY_ID.has(String(id ?? ''));
}

/** 给控制台用的摘要（不含 detail，体积小）。 */
export function capabilitySummary() {
  return PLUGIN_CAPABILITIES.map((entry) => ({
    id: entry.id,
    label: entry.label,
    risk: entry.risk,
    summary: entry.summary
  }));
}
