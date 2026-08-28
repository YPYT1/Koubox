# 开发计划索引

## 📋 当前计划

### 🎯 视频下载工具增强计划
**文档**: [视频下载工具增强计划.md](./视频下载工具增强计划.md)  
**状态**: 📝 规划中  
**目标**: 实现 YouTube、TikTok、Instagram、Facebook 四平台无障碍高画质下载

**快速导航**:
- [背景与目标](./视频下载工具增强计划.md#一背景与目标)
- [技术方案设计](./视频下载工具增强计划.md#二技术方案设计)
- [开发任务分解](./视频下载工具增强计划.md#三开发任务分解)
- [开发时间表](./视频下载工具增强计划.md#五开发时间表)

---

## 🚀 快速启动

### 前置条件检查
```bash
# 1. 确认工具链可用
cd D:\Project\Koubox-exp-platform-fetch
npm run typecheck

# 2. 检查 vendor 工具
ls vendor/yt-dlp/yt-dlp.exe
ls vendor/ffmpeg/ffmpeg.exe

# 3. 查看现有测试
ls tests/verification/20260825_public_video_fetch/
```

### 第一步：调研验证（今天）
```bash
# Task 1.2: 分析 cobalt 代码
cd D:\Project\cobalt-main
ls api/src/processing/services/

# 重点文件：
# - youtube.js
# - tiktok.js  
# - instagram.js
# - facebook.js

# Task 1.3: 测试现有能力
# 在桌面应用中测试：
# - YouTube Shorts
# - TikTok 公开视频
# - Instagram Reels（预期失败，需实现）
# - Facebook 视频（预期失败，需实现）
```

### 第二步：Instagram 实现（明天开始）
```bash
# 文件位置
code packages/core/src/public-video.ts

# 需要添加的函数：
# - resolveInstagram()
# - extractInstagramShortcode()
# - extractFromSharedData()
# - extractFromLDJson()
```

---

## 📊 进度追踪

### 里程碑
- [ ] **M0 (Day 1)**: 完成调研，确认技术路线
- [ ] **M1 (Day 3)**: Instagram 公开解析可用
- [ ] **M2 (Day 5)**: Facebook 公开解析可用  
- [ ] **M3 (Day 6)**: 四平台完整支持
- [ ] **M4 (Day 8)**: 测试通过，文档完善

### 阶段状态
| 阶段 | 状态 | 完成任务 | 总任务 |
|------|------|----------|--------|
| 阶段一：调研与验证 | 🟡 进行中 | 1/3 | 33% |
| 阶段二：Instagram 实现 | ⚪ 未开始 | 0/4 | 0% |
| 阶段三：Facebook 实现 | ⚪ 未开始 | 0/2 | 0% |
| 阶段四：TikTok 增强 | ⚪ 未开始 | 0/2 | 0% |
| 阶段五：YouTube 优化 | ⚪ 未开始 | 0/2 | 0% |
| 阶段六：测试与文档 | ⚪ 未开始 | 0/3 | 0% |

**总体进度**: 5% (1/18 tasks)

---

## 🔧 技术要点速查

### 三阶下载流程
```
用户输入 URL
    ↓
【阶段1】公开 yt-dlp（无 Cookie）
    ↓ 失败
【阶段2】增强公开解析
    ├─ YouTube → Piped API ✅
    ├─ TikTok → 页面抓取 ✅
    ├─ Instagram → embed API 🆕
    └─ Facebook → 页面解析 🆕
    ↓ 失败
【阶段3】Cookie yt-dlp 兜底
    ├─ builtin（应用内登录）
    ├─ paste（粘贴 Cookie）
    └─ file（Cookie 文件）
```

### 各平台实现策略

#### YouTube
- ✅ **已实现**: Piped API 多实例轮询
- 🔧 **优化**: format 选择、4K/8K 支持

#### TikTok  
- ✅ **已实现**: `__UNIVERSAL_DATA_FOR_REHYDRATION__` 解析
- 🔧 **增强**: bitrateInfo 无水印、H.265 支持

#### Instagram 🆕
- 🆕 **实现**: embed 页面 → `window._sharedData`
- 🆕 **回退**: GraphQL API (`/api/v1/media/{id}/info/`)

#### Facebook 🆕
- 🆕 **实现**: 页面解析 → `browser_native_hd_url`
- 🆕 **回退**: `__TAHOE_CONFIG__` 提取

### 关键文件清单
```
packages/core/src/
├── public-video.ts         # 🔥 公开解析核心（需扩展）
├── tasks.ts                # 下载流程管理
└── runtime.ts              # Cookie 配置迁移

packages/shared/src/
└── index.ts                # 平台检测、Cookie 规则

apps/desktop/src/
├── renderer/src/pages/
│   └── VideoDownloaderPage.tsx  # 下载工具 UI
└── main/
    └── cookies.ts          # 应用内登录 Cookie 管理

tests/verification/
└── 20260825_public_video_fetch/  # 现有测试基准
```

---

## 📚 参考资源

### 调研结果
- ✅ [油猴脚本评估](../../downloder/INDEX.md)
- 📖 [cobalt 项目](D:\Project\cobalt-main)

### 开发文档
- [技术分析](../技术分析/)
- [需求分析](../需求分析/)
- [Cookie 机制详解](./视频下载工具增强计划.md#42-cookie-管理策略)

### API 端点
```typescript
// Instagram
'https://www.instagram.com/p/{shortcode}/embed/captioned/'
'https://www.instagram.com/api/v1/media/{mediaId}/info/'

// Facebook  
'https://www.facebook.com/watch/?v={videoId}'
// 提取: browser_native_hd_url / __TAHOE_CONFIG__

// Piped (YouTube)
'https://pipedapi.kavin.rocks/streams/{videoId}'

// TikTok
'https://www.tiktok.com/@i/video/{postId}'
// 提取: __UNIVERSAL_DATA_FOR_REHYDRATION__
```

---

## ⚠️ 重要注意事项

### cobalt 许可证
- ✅ **可以**: 学习思路、参考 API 端点
- ❌ **不可**: 复制代码、调用公开实例
- ⚠️ **协议**: AGPL-3.0（衍生作品需开源）

### Cookie 安全
- 🔒 不在日志中输出 Cookie 值
- 🔒 文件权限限制（仅所有者可读）
- 🔒 应用内登录使用独立 partition

### 测试要求
- 🧪 每个平台至少 3 个公开 URL 测试
- 🧪 ffprobe 验证画质和音频
- 🧪 Cookie 方案回退验证

---

## 🤝 贡献指南

### 添加新平台
1. 在 `public-video.ts` 添加 `resolvePlatformName()` 函数
2. 在 `detectPlatform()` 添加 URL 匹配规则
3. 在 `PLATFORM_COOKIE_RULES` 添加 Cookie 规则
4. 编写单元测试
5. 更新用户文档

### 代码规范
- TypeScript 严格模式
- 错误必须有用户友好的提示
- 公开解析失败不应抛出异常（返回 undefined）
- 使用 `createLogger()` 记录调试信息

---

## 📞 问题反馈

如果在开发过程中遇到问题：

1. **技术问题**: 查看 [技术细节与约束](./视频下载工具增强计划.md#四技术细节与约束)
2. **测试失败**: 参考 [风险与缓解](./视频下载工具增强计划.md#六风险与缓解)
3. **需求变更**: 更新本计划文档并记录原因

---

**文档版本**: v1.0  
**最后更新**: 2026-08-25
