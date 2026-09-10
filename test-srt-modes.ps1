# 精准 SRT 深度测试脚本
# 测试有文案和无文案两种模式

$testCases = @(
    @{
        Name = "文案_02_先端パッケージ_语速1.1"
        Audio = "C:\Users\Administrator\Desktop\文案\日语\文案_02_先端パッケージ（语速1.1-声调2-音量1.3）.wav"
        Text = "C:\Users\Administrator\Desktop\文案\日语\文案_02_先端パッケージ.txt"
    },
    @{
        Name = "文案_05_高信頼性材料_语速1.4"
        Audio = "C:\Users\Administrator\Desktop\文案\日语\文案_05_高信頼性材料（语速1.4-声调2-音量1.6）.wav"
        Text = "C:\Users\Administrator\Desktop\文案\日语\文案_05_高信頼性材料.txt"
    },
    @{
        Name = "文案_08_車載センシング_语速1.7"
        Audio = "C:\Users\Administrator\Desktop\文案\日语\文案_08_車載センシング(语速1.7-音调-2-音量1.9).wav"
        Text = "C:\Users\Administrator\Desktop\文案\日语\文案_08_車載センシング.txt"
    }
)

$outputRoot = "d:\Project\Koubox\test-outputs"
New-Item -ItemType Directory -Force -Path $outputRoot | Out-Null

foreach ($case in $testCases) {
    Write-Host "`n========================================" -ForegroundColor Cyan
    Write-Host "测试用例: $($case.Name)" -ForegroundColor Cyan
    Write-Host "========================================`n" -ForegroundColor Cyan
    
    # 测试有文案模式
    Write-Host "【有文案模式】" -ForegroundColor Yellow
    $withTextOutput = Join-Path $outputRoot "$($case.Name)_有文案.srt"
    
    $job = Start-Job -ScriptBlock {
        param($audio, $text, $output)
        Set-Location "d:\Project\Koubox"
        $env:KOUBOX_REAL_ASR='1'
        
        # 调用 TaskManager API
        node -e @"
const { TaskManager } = require('./packages/core/dist/tasks.js');
const { readFileSync } = require('fs');
const config = {
  modelsDirectory: 'C:\\\\Users\\\\Administrator\\\\.subtitle-tool\\\\models',
  translationModelDirectory: '',
  vendorPaths: { ffmpegExecutable: 'ffmpeg' },
  platformAuth: {}
};
const manager = new TaskManager(config, () => {});
const sourceText = readFileSync('$text', 'utf-8');
manager.startRequirementTwo('$audio', sourceText, '$output'.replace(/[^\\\\]+$/, ''), 
  { asrPlan: null, translation: null }, 'ja', 'off')
  .then(r => console.log('Task:', r.taskId))
  .catch(e => console.error(e));
"@
    } -ArgumentList $case.Audio, $case.Text, $withTextOutput
    
    Wait-Job $job -Timeout 180 | Out-Null
    $result = Receive-Job $job
    Remove-Job $job
    
    if (Test-Path $withTextOutput) {
        $content = Get-Content $withTextOutput -Raw -Encoding UTF8
        Write-Host "✓ 生成成功: $withTextOutput" -ForegroundColor Green
        Write-Host "片段数: $(($content -split '\n\n').Count - 1)" -ForegroundColor Gray
    } else {
        Write-Host "✗ 生成失败" -ForegroundColor Red
    }
    
    # 测试无文案模式
    Write-Host "`n【无文案模式】" -ForegroundColor Yellow
    $withoutTextOutput = Join-Path $outputRoot "$($case.Name)_无文案.srt"
    
    $job = Start-Job -ScriptBlock {
        param($audio, $output)
        Set-Location "d:\Project\Koubox"
        $env:KOUBOX_REAL_ASR='1'
        
        node -e @"
const { TaskManager } = require('./packages/core/dist/tasks.js');
const config = {
  modelsDirectory: 'C:\\\\Users\\\\Administrator\\\\.subtitle-tool\\\\models',
  translationModelDirectory: '',
  vendorPaths: { ffmpegExecutable: 'ffmpeg' },
  platformAuth: {}
};
const manager = new TaskManager(config, () => {});
manager.startRequirementTwo('$audio', '', '$output'.replace(/[^\\\\]+$/, ''), 
  { asrPlan: null, translation: null }, 'ja', 'off')
  .then(r => console.log('Task:', r.taskId))
  .catch(e => console.error(e));
"@
    } -ArgumentList $case.Audio, $withoutTextOutput
    
    Wait-Job $job -Timeout 180 | Out-Null
    $result = Receive-Job $job
    Remove-Job $job
    
    if (Test-Path $withoutTextOutput) {
        $content = Get-Content $withoutTextOutput -Raw -Encoding UTF8
        Write-Host "✓ 生成成功: $withoutTextOutput" -ForegroundColor Green
        Write-Host "片段数: $(($content -split '\n\n').Count - 1)" -ForegroundColor Gray
    } else {
        Write-Host "✗ 生成失败" -ForegroundColor Red
    }
    
    Start-Sleep -Seconds 2
}

Write-Host "`n========================================" -ForegroundColor Cyan
Write-Host "测试完成！输出目录: $outputRoot" -ForegroundColor Cyan
Write-Host "========================================" -ForegroundColor Cyan
