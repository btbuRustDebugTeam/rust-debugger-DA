---
title: 安装与使用
weight: 2
bookToc: true
---

# 安装与使用

## 插件安装

以下操作在 Ubuntu 环境中进行。

1. 下载 VS Code [code-debug 调试插件最新安装包](https://github.com/chenzhiy2001/code-debug/releases)

2. 然后启动 VS Code，在扩展视图（Extensions View）中，点击右上角的 **"..."** 菜单，选择 **"从 VSIX 安装..." (Install from VSIX...)**，然后选择第一步下载的 `.vsix` 安装包即可，到这一步调试器插件就可以使用了。

## 使用方法

### rCore-Tutorial-v3 配置

1. 请确保 rCore-Tutorial-v3 能成功运行。

2. 根据该 [commit](https://github.com/chenzhiy2001/rCore-Tutorial-v3/commit/c64ae25ecee708c0257c9acb9da92309d32e1059) 为你本地的 rCore 打好调试补丁。

3. 打开 VS Code，并打开被调试的 rCore-Tutorial-v3 文件夹，在 `.vscode` 文件夹中创建 `launch.json` 文件，添加[该配置文件](https://github.com/chenzhiy2001/code-debug/blob/c102c48714221e5a38d28a54289080fff7ca0892/installation%20and%20usage/ebpf_launch.json)中内容。

4. 为了用 eBPF Panel，需要在 rCore-Tutorial-v3 的根目录下添加一个脚本 `qemu-system-riscv64-with-logs.sh`，内容如下：

    ```shell
    tty > ./qemu_tty
    qemu-system-riscv64 "$@" | tee ./code_debug_qemu_output_history.txt
    ```

    保存并添加可执行权限 `chmod +x qemu-system-riscv64-with-logs.sh`，然后再编译一遍 rCore。

5. 启动调试：在 VS Code 的 rCore 窗口下按 **F5** 启动调试即可。

    > **NOTE**：此处是[演示视频](https://gitlab.eduxiji.net/T202410011992734/project2210132-235708/-/blob/master/installation%20and%20usage/%E6%BC%94%E7%A4%BA%E8%A7%86%E9%A2%91.mp4)（该视频是使用仓库代码启动的调试器，如果使用 VS Code code-debug 插件，即可直接按照上面的方法启动调试）

6. （可选）如果你要用 rust-gdb，先保证你的 GDB 有 Python 支持，然后在 rCore-Tutorial-v3 的根目录下添加一个脚本：

    ```shell
    export RUST_GDB=riscv64-unknown-elf-gdb
    rust-gdb "$@"
    ```

    将这个脚本命名为 `riscv64-unknown-elf-gdb-rust.sh`，添加可执行权限，然后将刚才 `launch.json` 中的 `"gdbpath": "riscv64-unknown-elf-gdb"` 改为 `"gdbpath": "${workspaceRoot}/riscv64-unknown-elf-gdb-rust.sh"`。

## 开发环境配置

如果你想要开发我们的调试器，请确保以下依赖安装好：

```shell
# 使用命令检查是否安装成功：
npm -v  # 版本在 9 以上
node -v # 版本在 18 以上
```

如果上方所需依赖环境中不存在，请按以下提示进行安装：

```shell
# npm 安装，尽量安装较新的版本
curl -fsSL https://deb.nodesource.com/setup_18.x | sudo -E bash -
sudo apt-get install -y nodejs
# 查看版本信息
node --version
npm --version
```

环境配置好后，克隆我们的[仓库](https://github.com/chenzhiy2001/code-debug)，即可进行开发。
