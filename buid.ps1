param(
    [Parameter(Mandatory=$false)]
    [ValidateSet("patch", "minor", "major")]
    [string]$VersionType = "patch"
)

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

# 编译和打包
Write-Host "Compiling..." -ForegroundColor Green
npm run compile

Write-Host "Packaging..." -ForegroundColor Green
npm run package

Write-Host "Build completed successfully!" -ForegroundColor Green
