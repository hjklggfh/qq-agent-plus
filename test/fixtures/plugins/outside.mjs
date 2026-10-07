// 故意放在任何插件目录之外：fixture-escape-entry 的 entry 指向它，
// 用来验证"entry 越出插件目录"会被拒绝（宿主不能靠 manifest 把 import 引到任意文件）。
export async function activate() { return {}; }