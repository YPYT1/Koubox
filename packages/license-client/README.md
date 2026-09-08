# @koubox/license-client

Koubox 桌面授权深 module。它集中处理凭据安全存储、每日验证调度、两小时宽限、锁定状态和开发场景，调用方只使用 `LicenseController` interface。

生产构建必须提供固定验证地址、包内 Token/API 密钥和递增的 `packageCredentialVersion`。Electron adapter 使用 `safeStorage` 加密本地凭据，不会回退到明文。
