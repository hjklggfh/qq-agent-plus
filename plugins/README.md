# 插件目录

这个目录同时是**插件装载器的所在地**和**随版本分发的插件根**。

```
plugins/
├── loader.js            ← 装载器入口（src/server.js 在 createApp() 之前 await 它）
├── _host/               ← 宿主侧支撑模块
│   ├── manifest.js       manifest 校验（id/version/apiVersion/entry/capabilities/tools）
│   ├── capabilities.js   能力白名单（唯一决定"插件能碰到宿主什么"的地方）
│   ├── context.js        能力门面：把宿主 ctx 收窄成插件能看到的那一份
│   ├── storage.js        每插件键值存储（<数据目录>/plugin-state/<id>/）
│   ├── http.js           受限网络请求（复用 web_fetch 的 SSRF 防护）
│   └── registry.js       运行时工具注册表（默认空，导入不碰磁盘）
├── README.md            ← 本文件
└── hello/               ← 一个插件 = 一个目录：plugin.json + index.js
```

**`_host/` 与 `loader.js` 不是插件。** 装载器只把子**目录**当插件，且跳过以 `.` / `_` 开头的
目录名，所以它扫不到自己人（`test/plugin-loader.test.mjs` 有用例钉住这条）。

完整说明见 [`docs/PLUGINS.md`](../docs/PLUGINS.md)。

## 加一个随版本分发的插件

```bash
mkdir -p plugins/my-plugin
$EDITOR plugins/my-plugin/plugin.json   # id 必须等于目录名 my-plugin
$EDITOR plugins/my-plugin/index.js      # export async function activate(api) { … }
```

然后在 `config.json` 里把这个 id 加进 `plugins.enabled` 并补上 `plugins.approved` 的
能力/工具快照（照抄启动日志或控制台给出的待确认清单），重启服务。

## 加一个只给自己用的第三方插件

**别放这里**，也**别放进 `data/`**（那是记忆与聊天记录）。放到安装目录**外面**，
例如 `/mnt/data/qq-agent/plugins`，再在 `config.json` 里指过去：

```json
{ "plugins": { "roots": ["/mnt/data/qq-agent/plugins"] } }
```

这条路完全不经过 `deploy.sh` 的 `rsync -a --delete`，升级最稳。

如果你图省事丢进**安装目录**的 `plugins/`：`deploy.sh` 有一条
`--filter='protect /plugins/***'` 会保住它（发送端里有的文件照常更新，接收端独有的不删）。
代价是这个目录与仓库同名目录共用，而且以后从仓库删掉同名插件时残留文件不会被自动清理。

## 开发这个目录时的注意

- `plugins/**/*.js` 在 eslint 范围内（与 `src/` 同一套规则）；`test/fixtures/**` 被排除，
  因为那里的插件夹具是故意写坏的。
- `test/layout.test.mjs` 会扫描本目录下所有相对 import，挪文件时别漏改路径。
- 别把 `data/` 加进这里，也别在 `_host/` 里 import `src/tools/tools-core.js`：那会把 OneBot
  协议栈（`ws` 等）拖进装载器，让"装载插件"这件事依赖整个消息链路可加载。
  内置工具名是从 `src/server.js` **注入**进来的（`builtinToolNames`），就是为了避免这个耦合。
