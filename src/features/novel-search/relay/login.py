"""Interactive one-time Telegram login helper for Tokyo qq-tg-novel-relay.

Run this directly on the Tokyo server in your own terminal:
    python3 login.py

Your phone number, verification code, and optional 2FA password stay strictly
on the Tokyo server and are never sent to chat or logs.
"""

from __future__ import annotations

import asyncio
import getpass
import os
import stat
from pathlib import Path

from telethon import TelegramClient
from telethon.errors import SessionPasswordNeededError

from server import _load_channels_config, _load_env_file


async def main() -> None:
    data_dir = Path(os.environ.get("TG_NOVEL_DATA_DIR", str(Path.home() / ".local/share/qq-tg-novel-relay")))
    data_dir.mkdir(parents=True, exist_ok=True)
    os.chmod(data_dir, 0o700)
    env_path = data_dir / ".env"
    _load_env_file(env_path)

    api_id_str = os.environ.get("TG_API_ID", "").strip()
    api_hash = os.environ.get("TG_API_HASH", "").strip()

    if not api_id_str or not api_hash:
        print(f"未在 {env_path} 中找到 TG_API_ID / TG_API_HASH。")
        api_id_str = input("请输入 TG_API_ID（纯数字）: ").strip()
        api_hash = getpass.getpass("请输入 TG_API_HASH（输入不回显）: ").strip()
        if not api_id_str.isdigit() or not api_hash:
            raise SystemExit("API ID 必须是纯数字且 API Hash 不能为空。")
        env_path.write_text(f"TG_API_ID={api_id_str}\nTG_API_HASH={api_hash}\n", encoding="utf-8")
        os.chmod(env_path, stat.S_IRUSR | stat.S_IWUSR)
        print(f"已写入 {env_path}（权限 600）。")

    session_path = os.environ.get("TG_SESSION_PATH", str(data_dir / "tg_novel"))
    client = TelegramClient(
        session_path,
        int(api_id_str),
        api_hash,
        device_model="Desktop",
        system_version="Linux 6.8",
        app_version="4.16.8",
        lang_code="zh-hans",
        system_lang_code="zh-hans",
    )
    await client.connect()
    try:
        if not await client.is_user_authorized():
            phone = input("请输入手机号（带国际区号，如 +86138xxxxxxxx）: ").strip()
            await client.send_code_request(phone)
            code = input("请输入 Telegram App 内收到的 5 位验证码: ").strip()
            try:
                await client.sign_in(phone, code)
            except SessionPasswordNeededError:
                pwd = getpass.getpass("账号开启了两步验证，请输入 2FA 密码（输入不回显）: ")
                await client.sign_in(password=pwd)
            print("登录成功！")
        else:
            print("检测到已有有效登录会话，跳过验证码步骤。")

        session_file = Path(f"{session_path}.session")
        if session_file.is_file():
            os.chmod(session_file, stat.S_IRUSR | stat.S_IWUSR)

        me = await client.get_me()
        masked_id = f"***{str(me.id)[-4:]}" if me and me.id else "unknown"
        print(f"当前会话账号 ID（已脱敏）: {masked_id}")

        channels = _load_channels_config()
        print("\n正在校验白名单频道可达性：")
        for cid, meta in channels.items():
            try:
                ent = await client.get_entity(cid)
                title = getattr(ent, "title", cid)
                print(f"  [OK] @{cid} -> {title}")
            except Exception as exc:
                print(f"  [FAIL] @{cid} -> {exc}")
    finally:
        await client.disconnect()


if __name__ == "__main__":
    asyncio.run(main())
