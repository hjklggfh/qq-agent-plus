# JM 禁漫下载插件

`jm-suomingor` 是 QQ Agent Plus 的原生插件适配，保留原 skill 的下载、PDF/图片处理、任务控制、群文件上传、本地书架、今日列表和日更能力。

## 安装与启用

1. 保证目录位于宿主代码的 `plugins/jm-suomingor/`。
2. 在控制台的“插件”页面启用插件，并确认它声明的能力，尤其是“JM 专用 OneBot 操作”。
3. 在“设置 → JM 禁漫下载”保存参数；设置改动需要重启服务。

独立设置页只管理 JM 参数，插件的启用和高风险能力确认仍在“插件”页面完成。

## 数据与依赖

插件状态、下载任务和成品保存在宿主数据目录的：

```text
<dataDir>/plugin-state/jm-suomingor/
```

下载不会写入插件代码目录。Python + Pillow 可用于竖切还原和 PDF 合成；未安装时会降级为保存原始图片。日文标题翻译使用宿主现有模型配置，结果写入插件状态目录缓存。

## 工具

插件向模型注册 `jm_download_album`、`jm_control`、`jm_group_toggle`、`jm_task_status`、`jm_today_list`、`jm_daily_updates`、`jm_library` 和 `jm_storage`。下载工具只入队，实际下载和上传在后台执行，并把结果发回触发请求的当前会话。

## 权限边界

JM 专用 OneBot 能力只允许当前群/私聊的文件操作、群文件查询和删除、群成员权限查询以及当前会话消息发送。插件不能取得通用 OneBot 客户端，也不能操作其它会话。