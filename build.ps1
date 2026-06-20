param(
    [Parameter(Mandatory=$false)]
    [ValidateSet("patch", "minor", "major")]
    [string]$VersionType = "patch",
    [Parameter(Mandatory=$false)]
    [switch]$S
)

function Invoke-PythonTests {
    $pythonCommand = Get-Command python -ErrorAction SilentlyContinue
    if ($pythonCommand) {
        & $pythonCommand.Source scripts/mpyrepl/run_python_tests_with_coverage.py
        return
    }

    $pyLauncher = Get-Command py -ErrorAction SilentlyContinue
    if ($pyLauncher) {
        & $pyLauncher.Source -3 scripts/mpyrepl/run_python_tests_with_coverage.py
        return
    }

    Write-Host "Error: Python was not found. Install Python or ensure python/py is on PATH." -ForegroundColor Red
    exit 1
}

function Get-NpmCommand {
    $npmCmd = Get-Command npm.cmd -ErrorAction SilentlyContinue
    if ($npmCmd) {
        return $npmCmd.Source
    }

    $npmCommand = Get-Command npm -ErrorAction SilentlyContinue
    if ($npmCommand) {
        return $npmCommand.Source
    }

    Write-Host "Error: npm was not found. Install Node.js or ensure npm is on PATH." -ForegroundColor Red
    exit 1
}

function Invoke-Npm {
    param(
        [Parameter(ValueFromRemainingArguments=$true)]
        [string[]]$Arguments
    )

    $npm = Get-NpmCommand
    & $npm @Arguments
}

function Get-PackageJsonVersion {
    $version = node -p "require('./package.json').version"
    if ($LASTEXITCODE -ne 0) {
        Write-Host "Error: failed to read package.json version via node." -ForegroundColor Red
        exit $LASTEXITCODE
    }
    return (($version | Select-Object -Last 1) -as [string]).Trim()
}

# 先编译，只有编译成功才会考虑增加版本号和打包
Write-Host "Compiling..." -ForegroundColor Green
Invoke-Npm run compile

# 检查编译结果，失败则退出（不增加版本号、不打包）
if ($LASTEXITCODE -ne 0) {
    Write-Host "Error: compilation failed. Aborting version bump and packaging." -ForegroundColor Red
    exit $LASTEXITCODE
}

Write-Host "Running JavaScript tests..." -ForegroundColor Green
Invoke-Npm test

if ($LASTEXITCODE -ne 0) {
    Write-Host "Error: JavaScript tests failed. Aborting version bump and packaging." -ForegroundColor Red
    exit $LASTEXITCODE
}

Write-Host "Running Python tests..." -ForegroundColor Green
Invoke-PythonTests

if ($LASTEXITCODE -ne 0) {
    Write-Host "Error: Python tests failed. Aborting version bump and packaging." -ForegroundColor Red
    exit $LASTEXITCODE
}

# 编译成功后，按需增加版本号（除非用户通过 -SkipVersion 指定跳过）
if (-not $S) {
    # 自动增加版本号
    Write-Host "Reading current version from package.json..." -ForegroundColor Green

    # 获取当前版本
    $currentVersion = Get-PackageJsonVersion
    Write-Host "Current version: $currentVersion" -ForegroundColor Yellow

    # Let npm update package.json and package-lock.json together without creating a git tag.
    Write-Host "Incrementing version ($VersionType)..." -ForegroundColor Green
    Invoke-Npm version $VersionType --no-git-tag-version

    if ($LASTEXITCODE -ne 0) {
        Write-Host "Error: version bump failed. Aborting packaging." -ForegroundColor Red
        exit $LASTEXITCODE
    }

    $newVersion = Get-PackageJsonVersion
    Write-Host "Version updated to $newVersion" -ForegroundColor Green
} else {
    # 读取当前版本用于显示
    $currentVersion = Get-PackageJsonVersion
    Write-Host "Using current version: $currentVersion (no increment)" -ForegroundColor Cyan
}

# 清理根目录中的旧 .vsix 文件
Write-Host "Cleaning old .vsix files from root directory..." -ForegroundColor Yellow
Get-ChildItem -Path "." -Filter "*.vsix" | Remove-Item -Force

Write-Host "Packaging..." -ForegroundColor Green
Invoke-Npm run package

if ($LASTEXITCODE -ne 0) {
    Write-Host "Error: packaging failed. Aborting output organization." -ForegroundColor Red
    exit $LASTEXITCODE
}

# 整理输出
Write-Host "Organizing output..." -ForegroundColor Green

# 创建输出目录
$outputDir = "release"
if (-not (Test-Path $outputDir)) {
    New-Item -ItemType Directory -Path $outputDir | Out-Null
    Write-Host "Created output directory: $outputDir" -ForegroundColor Green
}

# 查找新生成的 .vsix 文件并移动到输出目录
$vsixFiles = Get-ChildItem -Path "." -Filter "*.vsix"
if ($vsixFiles.Count -gt 0) {
    foreach ($vsixFile in $vsixFiles) {
        $destinationPath = Join-Path $outputDir $vsixFile.Name
        Move-Item -Path $vsixFile.FullName -Destination $destinationPath -Force
        Write-Host "Moved $($vsixFile.Name) to $outputDir" -ForegroundColor Green
    }
} else {
    Write-Host "Warning: No .vsix files found to move" -ForegroundColor Yellow
}

Write-Host "Build completed successfully!" -ForegroundColor Green
Write-Host "Output files are located in: $outputDir" -ForegroundColor Cyan
