# 精准 SRT 日文分词器选型调研

## 1. 调研范围与结论

调研时间：2026-09-08。证据仅采用各项目官方仓库、官方文档和 PyPI 项目页/发布元数据。

**结论：精准 SRT 的日文短语切分应选 `SudachiPy + SudachiDict-core`。** 推荐先用 `SplitMode.C` 保留词典可识别的专名和复合词；只有当一个 C 粒度词超过字幕长度或时长约束时，才通过该 Morpheme 自带的 `split(SplitMode.B)`、再按需 `split(SplitMode.A)` 逐级细分。随后只根据 POS（词性）和活用信息把助词、助动词、接尾辞附着到前一个内容词，把接头辞附着到后一个内容词。该方案不需要维护具体词面清单。

这项选择解决的是**语言学候选边界**，不是直接生成字幕。最终边界仍须与 ASR（语音识别）的已对齐时间边界取交集，并以约 0.4～1.5 秒作为优化窗口；当时间上必须拆分时，应优先在内容词组之间拆，不留下单独的助词或助动词。

## 2. 选择标准

项目目标不是获得尽可能细的形态素序列，而是获得适合短字幕的“可见短语”：

- 词典认识的专名、机构名、产品名和一般复合词应尽量完整显示。
- 助词、助动词等功能成分应按词性附着，不能依赖 `です`、`ます` 等词面硬编码。
- 字幕通常约 0.4～1.5 秒，因此必须能在复合词保护与时长上限冲突时有控制地降级细分。
- Windows x64 + Python 3.12 应能直接安装；安装完成后处理本地文本时不得依赖网络。
- 需要稳定的 surface、POS、活用形和原文偏移，以便映射回 ASR 时间轴。

任何形态素分析器都不会单独给出满足上述时长的字幕边界；其职责是提供词典边界和语法属性，字幕分组仍由本项目完成。

## 3. SudachiPy + SudachiDict

### 3.1 可用性、维护与许可证

- SudachiPy 是 Sudachi.rs 的 Python 绑定，不是纯 Python 实现。官方 README 要求 Python 3.10+，声明提供 Windows、macOS 和 Linux 二进制包；PyPI 目前的 `0.6.11` 发布包含 `cp312-win_amd64` wheel，因此 Windows x64 + Python 3.12 可直接安装。[官方 README](https://github.com/WorksApplications/sudachi.rs/tree/develop/python#readme)；[PyPI 发布元数据](https://pypi.org/project/SudachiPy/)
- 原 `WorksApplications/SudachiPy` 仓库已归档，当前实现和维护转移到活跃的 `WorksApplications/sudachi.rs`；当前 PyPI 版 `0.6.11` 发布于 2026-04-13，主仓库在 2026-08 仍有提交。[旧仓库](https://github.com/WorksApplications/SudachiPy)；[当前仓库](https://github.com/WorksApplications/sudachi.rs/commits/develop/)
- Sudachi.rs、SudachiPy 和 SudachiDict 均采用 Apache-2.0。SudachiDict 官方说明其还包含 UniDic 和部分 NEologd 内容。[Sudachi.rs LICENSE](https://github.com/WorksApplications/sudachi.rs/blob/develop/LICENSE)；[SudachiDict README](https://github.com/WorksApplications/SudachiDict#licenses)
- 安装命令为 `pip install sudachipy sudachidict_core`。词典安装到本机后，分词只读取本地 `system.dic`，运行期离线。[SudachiPy 安装说明](https://github.com/WorksApplications/sudachi.rs/tree/develop/python#setup)

### 3.2 词典体积与版本

SudachiDict 有 small、core、full 三种版本：small 只含 UniDic 词汇，core 增加基本词汇且是默认版，full 再加入更多专有名词。当前三者版本均为 `20260723`。[版本与版本差异](https://github.com/WorksApplications/SudachiDict#dictionary-types)；[small PyPI](https://pypi.org/project/SudachiDict-small/)；[core PyPI](https://pypi.org/project/SudachiDict-core/)；[full PyPI](https://pypi.org/project/SudachiDict-full/)

官方 `20260723` 压缩词典约为：small 41.8 MB、core 72.3 MB、full 126.6 MB；当前 PyPI 的 small/core wheel 分别约 41.8/72.3 MB，full 的小型源码包在安装时下载对应词典。下载发生在安装/打包阶段，不是每次分词时发生。[官方词典下载](http://sudachi.s3-website-ap-northeast-1.amazonaws.com/sudachidict/)；[Python 词典包说明](https://github.com/WorksApplications/SudachiDict/tree/develop/python)

**推荐 core，不推荐 small 或 full 作为默认值。** small 对新词和一般复合词覆盖较弱；full 的额外专名有价值，但增加约 54 MB 下载量。core 在复合词覆盖和本地体积之间更适合作为桌面字幕工具默认配置。若以后有真实字幕样本证明专名召回不足，再以同一 API 切换 full，不需要改变切分算法。

### 3.3 粒度、复合词与 POS

- Sudachi 原生提供 A/B/C 三种粒度。官方示例中 `国家公務員` 在 C 模式是一个词，在 B 模式为 `国家` + `公務員`，在 A 模式为 `国家` + `公務` + `員`；`高輪ゲートウェイ駅` 在默认 C 模式也保持为一个词。[多粒度示例](https://github.com/WorksApplications/sudachi.rs/tree/develop/python#usage-as-a-python-package)
- 每个 Morpheme 可以再调用 `split(mode)`，因此可以先保留 C 粒度复合词，只对超限项降到 B/A，而不是把全文预先切成最细单位。[Morpheme API](https://worksapplications.github.io/sudachi.rs/python/api/sudachipy.html#sudachipy.Morpheme)
- 每个结果提供原文 surface、六级 POS（四级词性、活用型、活用形）、字典形、读音、规范化形、词典 ID 和 OOV（未登录词）状态，足够实现语法附着和原文位置映射。[输出字段](https://github.com/WorksApplications/sudachi.rs/tree/develop/python#output)
- 官方支持编译用户词典：`sudachipy ubuild -s system.dic source.csv`，再通过 `sudachi.json` 的 `userDict` 加载。用户词典适合项目/客户术语，不应替代一般语法规则。[用户词典](https://github.com/WorksApplications/sudachi.rs/tree/develop/python#user-dictionary)

该组合的主要优势是：**“保护复合词”和“必要时细分”由同一词典条目的层级结构同时提供**。这比先得到最细形态素、再猜测哪些相邻名词应合并更可控。

## 4. MeCab + UniDic（含 fugashi）

### 4.1 可用性、维护与许可证

- MeCab 是通用形态素分析引擎，词典决定日文边界和特征。Python 侧更适合用 fugashi：它是 MeCab 的 Cython 包装，提供 Python 风格的节点和命名字段，并明确支持 Linux、macOS、Windows x64。[fugashi 官方仓库](https://github.com/polm/fugashi)
- fugashi `1.5.2` 要求 Python >=3.9，PyPI 提供 `cp312-win_amd64` wheel；`mecab-python3 1.0.12` 同样提供 Python 3.12 Windows wheel，但官方提示 Windows 还需要 Microsoft Visual C++ Redistributable。两者都不内置日文词典。[fugashi PyPI](https://pypi.org/project/fugashi/)；[mecab-python3 PyPI](https://pypi.org/project/mecab-python3/)；[mecab-python3 官方说明](https://github.com/SamuraiT/mecab-python3)
- fugashi 当前版发布于 2025-10-24，mecab-python3 当前版发布于 2025-11-25，包装层仍在维护。MeCab 核心接口成熟但版本演进慢；若选该路线，优先 fugashi，不直接依赖非 Python 风格的 mecab-python3 API。
- fugashi 代码为 MIT，wheel 中携带的 MeCab 为 BSD-3-Clause；PyPI 元数据给出的组合许可证是 `MIT AND BSD-3-Clause`。现代日文 UniDic 由国立国语研究所按 GPL v2、LGPL v2.1、修正 BSD 三选一授权。[fugashi 许可证说明](https://github.com/polm/fugashi#license-and-copyright-notice)；[UniDic 商用与许可证](https://clrd.ninjal.ac.jp/unidic/commerce_use.html)

### 4.2 词典体积、离线运行与维护差异

- 轻量安装为 `pip install "fugashi[unidic-lite]"`。`unidic-lite 1.0.8` 的 PyPI 源码包约 47.4 MB，但它是经过轻微修改的 UniDic 2.1.2（2013），适合验证和轻量运行，不代表最新词典。[fugashi 词典说明](https://github.com/polm/fugashi#installing-a-dictionary)；[unidic-lite PyPI](https://pypi.org/project/unidic-lite/)
- 完整安装为 `pip install "fugashi[unidic]"` 后执行 `python -m unidic download`。该 Python 下载器的 PyPI 包本身只有约 8 KB；其官方 README 指向 UniDic 3.1.0，并注明下载后约占磁盘 770 MB。[unidic-py 官方仓库](https://github.com/polm/unidic-py)；[unidic PyPI](https://pypi.org/project/unidic/)
- 国立国语研究所目前发布的现代书面语 UniDic 已更新到 `202512`，而 `unidic-py` 的自动下载包装仍标注 3.1.0；因此“官方最新 UniDic”和“fugashi 最简 pip 安装链路”存在版本差异。[国立国语研究所最新版下载页](https://clrd.ninjal.ac.jp/unidic/download.html)
- 词典下载完成后，MeCab/fugashi 的分词完全本地运行。

### 4.3 粒度、复合词与 POS

- UniDic 的解析词典以国立国语研究所定义的“短单位”作为词条，目标是统一的语料标注和检索。官方还明确说明短单位不适合直接承担句法/语义分析，并推荐句法分析使用从文节自顶向下认定的长单位。[UniDic 设计说明](https://clrd.ninjal.ac.jp/unidic/about_unidic.html)
- 这使 UniDic 很适合提供细致、稳定的 POS、活用型、活用形、lemma、书写形和读音，但默认结果通常比字幕所需短语更细。fugashi 暴露这些命名字段，却没有像 Sudachi A/B/C 那样针对同一结果的原生多粒度切换。[unidic-py 字段说明](https://github.com/polm/unidic-py#fields)；[fugashi 使用示例](https://github.com/polm/fugashi#usage)
- MeCab 支持用 CSV 和 `mecab-dict-index` 编译系统词典或用户词典，fugashi 也可加载任意 MeCab 词典；但在 Windows 打包链路中维护词典编译工具、字典路径和字段包装，比 Sudachi 的 `ubuild` 更复杂。[MeCab 官方词典文档](https://taku910.github.io/mecab/dic.html)；[fugashi 任意词典支持](https://github.com/polm/fugashi#dictionary-use)

**判断：作为通用形态素底座，fugashi + UniDic 很强；作为本项目“先保护可见复合词、超限才拆”的边界源，不如 Sudachi 直接。** 若从 UniDic 短单位重建字幕短语，仍需额外做复合词识别；仅按“连续名词全部合并”会把不应合并的名词串也粘在一起，用户词典则会变成需要长期维护的词汇清单。

## 5. Janome

### 5.1 可用性、维护与许可证

- Janome 是纯 Python 形态素分析器，内置语言模型和 `mecab-ipadic-2.7.0-20070801` 词典。它采用 Apache-2.0，并注明使用 MeCab-IPADIC 词典/统计模型。[官方 README](https://github.com/mocobeta/janome)；[官方文档](https://janome.mocobeta.dev/en/)
- 当前 PyPI 稳定版 `0.5.0` 发布于 2023-07-01，wheel 约 19.7 MB。官方仓库仍在维护，2026-06 已迁移到现代构建配置；当前主分支要求 Python >=3.10，因此 Python 3.12 可用。[Janome PyPI](https://pypi.org/project/Janome/)；[当前构建配置](https://github.com/mocobeta/janome/blob/master/pyproject.toml)；[提交记录](https://github.com/mocobeta/janome/commits/master/)
- `pip install janome` 即包含词典，安装后完全离线。纯 Python 降低了 Windows 原生二进制风险；官方同时提示构建安装包时约消耗 500 MB 内存。[安装说明](https://github.com/mocobeta/janome#install)

### 5.2 粒度、复合词、POS 与用户词典

- Janome 的 Token 提供 surface、IPADIC 风格 POS、活用型、活用形、基本形、读音和发音，足以识别助词/助动词并附着。[官方使用示例](https://janome.mocobeta.dev/en/#usage)
- 它只有词典/Viterbi 给出的单一基础粒度，没有 Sudachi 的 A/B/C 层级。Janome 的 `CompoundNounFilter` 能在后处理阶段合并连续名词，但这是通用规则，不是词典对具体复合词边界的多粒度表示。[Analyzer 示例](https://janome.mocobeta.dev/en/#experimental-analyzer-framework-v0-3-4)
- 支持运行时加载 MeCab-IPADIC CSV 或简化的 `surface, POS, reading` 用户词典，也支持通过 Python API 预编译大用户词典。[用户词典文档](https://janome.mocobeta.dev/en/#how-to-use-with-user-defined-dictionary)

**判断：Janome 的部署最简单、体积最小，适合作为最低依赖方案，但不应作为本目标的首选。** 内置 IPADIC 基础较旧，且缺少原生多粒度复合词结构。继续使用 Janome 时，可以用 POS 消除句尾词面硬编码，但无法同等可靠地实现“先保护词典复合词、必要时再逐层拆分”。

## 6. GiNZA 为何不适合作为本地轻量默认方案

GiNZA 基于 spaCy、SudachiPy 和 SudachiDict，标准模型能直接输出 Universal Dependencies 依存关系、文节边界和文节内位置，这些信息比单纯 POS 更接近理想的字幕语法短语。[GiNZA 官方仓库与输出示例](https://github.com/megagonlabs/ginza)

但本项目当前只需要“词边界 + POS + 受时长约束的分组”。`ginza 5.2.1` 本身依赖 spaCy、SudachiPy、SudachiDict-core 和 plac；标准 `ja_ginza 5.2.0` 模型包约 59.1 MB，还要叠加约 72.3 MB 的 core 词典及 spaCy/Thinc 等原生依赖。Transformer 模型还会在首次运行自动下载未包含在 PyPI 包中的大模型。[ginza PyPI 依赖](https://pypi.org/project/ginza/)；[ja-ginza PyPI](https://pypi.org/project/ja-ginza/)；[官方安装说明](https://github.com/megagonlabs/ginza#runtime-set-up)

GiNZA 在完整安装模型后可以离线，也兼容 Python 3.12 的当前 spaCy wheel；不采用它的原因是依赖、模型体积、启动和推理成本超出本任务需要，而不是功能或平台不兼容。若未来字幕质量评估证明仅靠 POS 无法可靠恢复文节，再单独评估 GiNZA 的 `bunsetu_*` API。

## 7. 综合排序

1. **SudachiPy + SudachiDict-core：推荐。** Windows/Python 3.12 安装直接，当前维护活跃，Apache-2.0，约 72.3 MB 词典，运行离线；A/B/C 多粒度最贴合“复合词优先、超限再拆”。
2. **fugashi + UniDic：第二选择。** POS 和词形信息最丰富，Windows/Python 3.12 wheel 完整；但 full UniDic 约 770 MB，lite 词典较旧，默认短单位需要另做复合词重建。
3. **Janome：轻量部署选择。** 纯 Python、约 19.7 MB wheel、内置词典、离线且有 POS/用户词典；但基础词典旧且只有单一粒度，对复合词保护能力较弱。
4. **GiNZA：暂不采用。** 能提供文节与依存关系，但相对当前目标引入整套 spaCy 模型管线，投入和运行成本不成比例。

## 8. 建议的无词面硬编码切分策略

以下是后续实现时应遵守的规则，本次调研不修改代码或依赖：

1. 对完整日文文本执行 Sudachi `SplitMode.C`，保留每个 Morpheme 的原文起止偏移、POS、活用信息和其 B/A 子分词。
2. 把 C 粒度内容词作为默认不可拆显示单元。只有该单元本身无法满足字符上限或约 1.5 秒目标时，才对该 Morpheme 降到 B；B 仍超限时才降到 A。
3. 根据 POS 类别分组，而不是检查具体 surface：接头辞与后续内容词同组；助词、助动词、接尾辞及非独立活用成分与前一内容词同组；标点提供强弱边界；新的独立内容词提供候选边界。
4. 将语言学候选边界投影到 ASR 已对齐词尾。没有对应时间边界的形态素内部位置不能直接切字幕。
5. 在候选边界上以 0.4～1.5 秒、字符上限和停顿强度共同评分。短于 0.4 秒的组优先与相邻组合并；超过目标上限时先在内容词组之间拆，再考虑把 C 降到 B/A。
6. 时间硬约束优先于复合词保护，但不得产生只有助词/助动词的字幕。需要拆开长语法链时，边界应移动到前一个合法内容词组边界。
7. 领域词汇只通过可选用户词典进入，不在源码里维护“应合并词”或句尾表。用户词典是对 OOV 专名的补充，不参与一般语法判断。

这套策略利用 Sudachi 的词典层级保护“可见复合词”，利用 POS 决定语法附着，利用 ASR 时间轴决定字幕长度；三个职责相互独立，能够满足短字幕需求而不引入词汇硬编码。
