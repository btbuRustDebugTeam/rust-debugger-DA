---
title: OS Debug
titleOnly: true
weight: 1
bookToc: false
---

# OS Debug

**适用于操作系统开发的源代码级调试工具**

OS Debug 是一款 VS Code 调试插件，让你可以在 VS Code 中像调试普通程序一样调试操作系统内核。它支持跨内核态和用户态的源代码级断点调试，以及基于 eBPF 的动态跟踪，适用于 QEMU 虚拟机和真实 RISC-V 硬件环境。

## 核心特性

- **跨特权级调试** — 在内核代码和用户程序中同时设置断点，插件自动处理地址空间切换
- **多种调试模式** — 支持 QEMU 虚拟机调试、SSH 远程调试、真实硬件（JTAG）调试
- **eBPF 动态跟踪** — 不暂停程序，通过 kprobe/uprobe 轻量级追踪内核和用户程序
- **多语言支持** — C、C++、Rust、RISC-V 汇编等所有 GDB 支持的语言
- **灵活配置** — 所有调试行为通过标准 `launch.json` 配置，支持 VS Code 变量替换

## 快速链接

- [项目介绍](docs/) — 项目概述与背景
- [安装与使用](docs/usage) — 插件安装、调试配置与开发环境搭建
- [功能介绍](docs/features) — 了解插件的全部功能
- [项目阶段工作](docs/roadmap) — 项目的开发历程
- [代码仓库](https://github.com/chenzhiy2001/code-debug) — GitHub 源代码
