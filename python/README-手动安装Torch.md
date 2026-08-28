# 手动安装 CUDA 版 PyTorch

本项目的 Python 运行时固定使用 **Python 3.12 x64**，请下载下面这个 Windows CUDA wheel：

```text
torch-2.11.0+cu128-cp312-cp312-win_amd64.whl
```

官方下载目录：

```text
https://download.pytorch.org/whl/cu128/
```

下载后把文件放到：

```text
D:\Project\Koubox\python\wheels\
```

`Koubox-subtitle-tool/python/wheels` 已通过 **目录联接（junction）** 指向上述路径，无需再拷一份。

然后在 `D:\Project\Koubox\python` 执行：

```powershell
uv sync --python 3.12
.\.venv\Scripts\python.exe -m pip install --no-deps .\wheels\torch-2.11.0+cu128-cp312-cp312-win_amd64.whl
.\.venv\Scripts\python.exe -c "import torch; print(torch.__version__); print(torch.version.cuda); print(torch.cuda.is_available()); print(torch.cuda.get_device_name(0))"
```

最后一条命令应依次输出 CUDA 版 torch、CUDA 版本、`True` 和 NVIDIA 显卡名称。

注意：CUDA Toolkit 不必另装；但系统必须已安装兼容的 NVIDIA 显卡驱动。
