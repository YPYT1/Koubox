# 手动安装 CUDA 版 PyTorch

本项目的 Python 运行时固定使用 **Python 3.12 x64**。请下载下面这个 Windows CUDA wheel：

```text
torch-2.11.0+cu128-cp312-cp312-win_amd64.whl
```

官方下载目录：

```text
https://download.pytorch.org/whl/cu128/
```

下载后放到仓库内：

```text
python/wheels/
```

然后在 `python/` 目录执行：

```powershell
uv sync --python 3.12
.\.venv\Scripts\python.exe -m pip install --no-deps .\wheels\torch-2.11.0+cu128-cp312-cp312-win_amd64.whl
.\.venv\Scripts\python.exe -c "import torch; print(torch.__version__); print(torch.version.cuda); print(torch.cuda.is_available()); print(torch.cuda.get_device_name(0))"
```

最后一条命令应依次输出：CUDA 版 torch 版本、CUDA 版本、`True`、NVIDIA 显卡名称。

注意：不必另装 CUDA Toolkit；系统须已安装兼容的 NVIDIA 显卡驱动。  
`pyproject.toml` 中 `tool.uv.sources.torch` 已指向上述本地 wheel；换版本时请同步改 wheel 文件名与该配置。
