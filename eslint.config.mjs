// ESLint flat config（改进方案 C1–C3；devDependencies 实际版本见 package.json，当前 ^10）。
// 作用域：src/scripts/plugins = node ESM；test = node ESM（node:test 是 import 不是全局）；
// ui = 浏览器 ES module（2026-10-01 起跨文件引用靠 import，所以 sourceType 是 module）。
// tools/ 与 data/ 是本地未跟踪目录，不进 lint；test/fixtures 是**故意写坏**的测试数据，也不进。
import globals from 'globals';

// 全部规则 error（no-unused-vars 也已在 2026-09-30 的清零批次里清到 0 ——
// 含删除 ui/app.js 的 5 个上游遗产零调用函数及其配套死代码；此后 no-unused-vars
// 是硬门禁，新增未用变量会直接红）。
// caughtErrors:'none'：catch (e) 不用 e 无罪，空 catch 由 no-empty(error) 盯住。
const baseRules = {
  'no-undef': 'error',
  'no-unused-vars': ['error', { args: 'after-used', ignoreRestSiblings: true, caughtErrors: 'none' }],
  // no-empty 自 C2 起为 error：空块必须写明“有意忽略”的原因
  'no-empty': ['error', { allowEmptyCatch: false }],
  'no-dupe-keys': 'error',
  'no-unreachable': 'error',
  'no-constant-condition': 'error',
  'no-prototype-builtins': 'error',
};

const nodeScope = {
  languageOptions: { ecmaVersion: 2024, sourceType: 'module', globals: { ...globals.node } },
  rules: baseRules,
};

// ui/ 已是 ES module（2026-10-01，B 档 Step 2）：跨文件引用一律走显式 import，不再有
// "靠全局词法环境共享的名字"。原先那份 uiSharedGlobals 清单已随转化删除（它既是 lint 的
// globals，也是 test/ui-contract.test.mjs 冻结的耦合契约）；契约换成更强的一层：
// ui/**/*.js 的**未解析引用（除浏览器内建）必须为空** —— test/ui-module-graph.test.mjs。
// 有意留在 window 上的只剩两个显式赋值：core/registry.js 的 QARegistry、i18n/zh-CN.js 的 QAText。

export default [
  {
    ignores: [
      'node_modules/**', 'data/**', 'tools/**', '_staging/**',
      // 插件夹具里有一批**故意**坏掉的插件（manifest 非法、入口抛错、注册未声明的工具……），
      // 它们是"坏插件不许进来"这条契约的测试数据，不是源码。让 lint 去"修好"它们等于把
      // 用例的前提删掉。
      'test/fixtures/**'
    ]
  },
  { files: ['src/**/*.js'], ...nodeScope },
  { files: ['scripts/**/*.mjs'], ...nodeScope },
  { files: ['test/**/*.mjs'], ...nodeScope },
  // 插件子系统（plugins/loader.js 与 plugins/_host/*.js）是宿主代码，按 src/ 同一套规则。
  // 随版本分发的插件本体（plugins/<id>/index.js）也在内：它们会被大量复制成第三方插件的
  // 起点，no-undef 能当场抓出"抄漏/拼错一个宿主 API 名"。
  { files: ['plugins/**/*.js', 'plugins/**/*.mjs'], ...nodeScope },
  {
    files: ['ui/**/*.js'],
    languageOptions: {
      ecmaVersion: 2024,
      sourceType: 'module',
      // 只留浏览器内建：跨文件名字现在靠 import，no-undef 因此能真正兜住"漏 import / 拼错名字"
      // （原先被 uiSharedGlobals 清单掩盖，写错只在调用期静默 undefined）。
      globals: { ...globals.browser },
    },
    rules: baseRules,
  },
  {
    // 体积闸门（改进方案 §11）：**ui/ 下每个文件**都不得超过 1800 行。
    // 来历：app.js 从 13,130 行的单体拆成模块骨架后按自己的规矩纳入约束；按依赖层级抽出的
    // 叶子桶（core/widgets.js）当时就有 1606 行，设置页绑定的四段合计也有 1536 行 —— 按方案
    // 原写的 1500 切只能是任意切分，所以提到 1800（仍在 13k 量级之下）。
    // 各文件的**当前**行数不写在这里：这个注释已经漂过三次，想看现状跑 `wc -l ui/**/*.js`。
    files: ['ui/**/*.js'],
    rules: {
      // 等级必须是 error：lint 脚本不带 --max-warnings，warn 在 CI 里等于没有门禁
      // （2026-10-01 审查发现"体积闸门"一直是 warn）。
      'max-lines': ['error', { max: 1800 }],
    },
  },
];
