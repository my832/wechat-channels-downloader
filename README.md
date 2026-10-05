# 微信视频号视频下载器 (WeChat Channels Downloader)

[![Platform](https://img.shields.io/badge/platform-Windows%20%2B%20微信PC-blue)](#环境要求)
[![Runtime](https://img.shields.io/badge/runtime-Node.js%20%E2%89%A5%2018-green)](#环境要求)

一个用于**备份自己在微信中可以观看的视频号视频**的 Windows 桌面工具。全自动完成：抓取真实 CDN 地址 → 下载 → 解密 → 输出可播放的 MP4。

> ⚠️ **免责声明**：本项目仅供个人备份与学习研究使用，请勿用于侵犯他人版权或违反《微信软件许可及服务协议》的用途。下载内容的版权归原创作者所有。使用本工具产生的一切后果由使用者自行承担。

## ✨ 特性

- 🎯 全自动：双击运行后只需在微信里播放目标视频，其余全部自动完成
- 🔓 自动破解视频号的分段加密（Isaac64 PRNG + XOR，仅文件前 128KB）
- 🧩 使用微信官方的 WASM 解密模块，与播放器行为完全一致
- 🧹 退出时自动还原系统代理，不影响日常上网
- 📦 首次运行自动下载运行组件，无需手动配置

## 🔧 工作原理

```
微信PC播放视频号视频
        │  (Chromium 内核走系统代理)
        ▼
本地 mitmproxy 捕获真实 CDN 地址 (finder.video.qq.com/.../stodownload?...)
        │
        ▼
curl 下载完整文件 (39MB 级，HTTP 206 分段)
        │  文件前 128KB 为 Isaac64 PRNG 密钥流 XOR 加密
        ▼
扫描微信播放器进程内存，恢复解密种子 decode_key
        │
        ▼
用微信官方 WASM 模块生成密钥流，解密前 128KB
        │
        ▼
完整可播放的 MP4 ✅
```

## 📋 环境要求

| 依赖 | 说明 |
|---|---|
| Windows 10/11 | 需要微信 **PC 版**（已登录） |
| [Node.js](https://nodejs.org/) ≥ 18 | `node -v` 能输出版本号即可 |
| mitmproxy / WASM 模块 | 首次运行自动下载，无需手动安装 |

## 🚀 快速开始

1. 下载本仓库（`git clone` 或 Download ZIP）
2. 双击 **`run.bat`**
3. 按提示在微信里**打开并播放**你想保存的视频号视频
   - 如果之前看过（已缓存），**拖动一下进度条**即可触发新的下载请求
4. 等待完成，MP4 会出现在 `视频` 文件夹（`xxx_完整.mp4`）

<details>
<summary>命令行用法</summary>

```text
node channels_dl.js                       交互式下载
node channels_dl.js --setup               仅下载运行组件（mitmproxy/WASM）
node channels_dl.js -o D:\out.mp4         指定输出文件
node channels_dl.js --test enc.mp4 --seed 123456789
                                          对已下载的加密文件验证解密
```
</details>

## ❓ 常见问题

<details>
<summary><b>提示"没有捕获到视频地址"？</b></summary>

- 确认视频真的在播放（播放器里有进度条在走）
- 已缓存过的视频要**拖动进度条**才会发起请求
- 确认没有其他代理/VPN 占用 8080 端口
- 确认微信是 PC 版且已登录
</details>

<details>
<summary><b>提示"未找到匹配的种子"？</b></summary>

解密种子保存在**播放器进程内存**里，窗口一关就没了：

- **保持视频号播放器窗口开着**（可以暂停）
- 按回车重新扫描，或关掉工具重新跑一遍
</details>

<details>
<summary><b>运行结束后微信联网异常？</b></summary>

工具正常退出时会自动还原系统代理。如果异常中断，手动检查：
设置 → 网络和 Internet → 代理 → 关闭"使用代理服务器"。
</details>

<details>
<summary><b>安全与证书</b></summary>

首次运行会向**当前用户**证书库安装一张 `mitmproxy` 根证书，用于解密微信自身流量，仅在本机生效。不再使用本工具时建议删除：

`Win+R` → `certmgr.msc` → 受信任的根证书颁发机构 → 证书 → 删除 `mitmproxy`
</details>

## 🗂️ 项目结构

```
├── channels_dl.js      主程序（抓包/下载/内存扫描/解密）
├── run.bat             Windows 一键启动
├── tools/              首次运行自动生成（mitmdump.exe、WASM）
└── 使用说明.txt         中文快速上手
```

## 🙏 致谢

- [Evil0ctal/WeChat-Channels-Video-File-Decryption](https://github.com/Evil0ctal/WeChat-Channels-Video-File-Decryption) — 加密机制分析（Isaac64 PRNG + WASM）
- [知乎：微信视频号视频文件的加密秘密](https://zhuanlan.zhihu.com/p/1962617259756352138)

## 📄 License

[MIT](LICENSE)
