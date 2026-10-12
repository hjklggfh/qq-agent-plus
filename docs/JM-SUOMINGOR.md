# JM 禁漫下载

JM 是宿主内置的单功能模块，不属于可安装插件，也不会出现在“插件”页面或能力审批列表中。

## 设置

打开“设置 → JM 禁漫下载”，可直接开启或关闭并配置输出格式、并发、超时、PDF 处理、上传方式、群文件保留、触发白名单和 Python 路径。配置保存在顶层 `config.jm`，默认关闭。

旧版本写在 `plugins.settings.jm-suomingor` 的配置会在启动时自动迁移到 `jm`，历史数据继续使用：

```text
<dataDir>/plugin-state/jm-suomingor/
```

## 能力

JM 工具由宿主内置工具表注册：`jm_download_album`、`jm_control`、`jm_group_toggle`、`jm_task_status`、`jm_today_list`、`jm_daily_updates`、`jm_library` 和 `jm_storage`。下载、PDF/图片处理、群文件上传和日更功能继续复用原 skill 实现。

工具只能操作当前会话；群文件和私聊文件操作由宿主内部的受限 OneBot 门面执行。

群白名单由群内指令管理：只有目标群群主或机主 QQ `2118530760` 可以执行 `开启JM`、`关闭JM`、`JM群列表` 和 `JM所有群开放`。普通管理员不能修改 JM 群白名单；`allowIds` 仍只用于限制谁能触发下载，不会扩大群开关权限。

PDF 合成会逐页解码、还原并写入临时 PDF，同一进程只运行一个 PDF 任务，避免多本同时合成耗尽服务器内存。单页超过 2400 万像素时会跳过该页并在结果中报告；全部页面失败时不保留不完整的 PDF。合成成功后才会将临时 PDF 替换为正式文件。
