param(
    [Parameter(Mandatory=$false)]
    [ValidateSet("patch", "minor", "major")]
    [string]$VersionType = "patch",
    [Parameter(Mandatory=$false)]
    [switch]$SkipVersion
)

# 先编译，只有编译成功才会考虑增加版本号和打包
Write-Host "Compiling..." -ForegroundColor Green
npm run compile

# 检查编译结果，失败则退出（不增加版本号、不打包）
if ($LASTEXITCODE -ne 0) {
    Write-Host "Error: compilation failed. Aborting version bump and packaging." -ForegroundColor Red
    exit $LASTEXITCODE
}

# 编译成功后，按需增加版本号（除非用户通过 -SkipVersion 指定跳过）
if (-not $SkipVersion) {
    # 自动增加版本号
    Write-Host "Reading current version from package.json..." -ForegroundColor Green

    # 读取 package.json 文件
    $packageJsonPath = "package.json"
    $packageJson = Get-Content $packageJsonPath -Raw | ConvertFrom-Json

    # 获取当前版本
    $currentVersion = $packageJson.version
    Write-Host "Current version: $currentVersion" -ForegroundColor Yellow

    # 解析版本号 (假设格式为 x.y.z)
    $versionParts = $currentVersion -split '\.'
    if ($versionParts.Length -ne 3) {
        Write-Host "Error: Version format should be x.y.z" -ForegroundColor Red
        exit 1
    }

    # 根据参数增加相应版本号
    $major = [int]$versionParts[0]
    $minor = [int]$versionParts[1]
    $patch = [int]$versionParts[2]

    switch ($VersionType) {
        "major" {
            $major++
            $minor = 0
            $patch = 0
        }
        "minor" {
            $minor++
            $patch = 0
        }
        "patch" {
            $patch++
        }
    }

    $newVersion = "$major.$minor.$patch"
    Write-Host "New version ($VersionType): $newVersion" -ForegroundColor Green

    # 更新 package.json 中的版本
    $packageJson.version = $newVersion
    $packageJson | ConvertTo-Json -Depth 10 | Set-Content $packageJsonPath -Encoding UTF8

    Write-Host "Version updated to $newVersion" -ForegroundColor Green
} else {
    # 读取当前版本用于显示
    $packageJson = Get-Content "package.json" -Raw | ConvertFrom-Json
    $currentVersion = $packageJson.version
    Write-Host "Using current version: $currentVersion (no increment)" -ForegroundColor Cyan
}

# 清理根目录中的旧 .vsix 文件
Write-Host "Cleaning old .vsix files from root directory..." -ForegroundColor Yellow
Get-ChildItem -Path "." -Filter "*.vsix" | Remove-Item -Force

Write-Host "Packaging..." -ForegroundColor Green
npm run package

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
