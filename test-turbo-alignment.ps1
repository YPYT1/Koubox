# 测试 turbo 模型有文案模式对齐质量
$env:KOUBOX_REAL_ASR='1'
$env:KOUBOX_ALIGN_AUDIO='C:\Users\Administrator\Desktop\文案\日语\文案_05_高信頼性材料（语速1.4-声调2-音量1.6）.wav'
$env:KOUBOX_ALIGN_TEXT='C:\Users\Administrator\Desktop\文案\日语\文案_05_高信頼性材料.txt'

Write-Host "测试 turbo 模型 + 有文案模式" -ForegroundColor Cyan
Write-Host "音频: $env:KOUBOX_ALIGN_AUDIO" -ForegroundColor Gray
Write-Host "文案: $env:KOUBOX_ALIGN_TEXT" -ForegroundColor Gray
Write-Host ""

cd d:\Project\Koubox
pnpm --filter @koubox/core exec vitest run test/precise-srt-align-fallback.integration.test.ts --reporter=verbose
