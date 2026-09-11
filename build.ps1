$ErrorActionPreference = "Stop"

$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
$Deno = Join-Path $Root "deno.exe"
$OutDir = Join-Path $Root "dist"
$BuildDir = Join-Path $Root "build"
$AppExe = Join-Path $OutDir "Svid.exe"
$SetupExe = Join-Path $OutDir "Svid-Setup.exe"
$BackendExe = Join-Path $BuildDir "svdc-backend.exe"
$DistBackendExe = Join-Path $OutDir "svdc-backend.exe"
$DesktopProject = Join-Path $Root "native-ui\SimpleVideoDownloadAndCut.Desktop.csproj"
$InstallerProject = Join-Path $Root "installer\Svid.Setup.csproj"
$InstallerPublishDir = Join-Path $BuildDir "installer-publish"

New-Item -ItemType Directory -Force -Path $OutDir | Out-Null
New-Item -ItemType Directory -Force -Path $BuildDir | Out-Null

if (Test-Path $AppExe) {
  Remove-Item -Force $AppExe
}

if (Test-Path $SetupExe) {
  Remove-Item -Force $SetupExe
}

$OldAppExe = Join-Path $OutDir "SimpleVideoDownloadAndCut.exe"
if (Test-Path $OldAppExe) {
  Remove-Item -Force $OldAppExe
}

if (Test-Path $BackendExe) {
  Remove-Item -Force $BackendExe
}

if (Test-Path $DistBackendExe) {
  Remove-Item -Force $DistBackendExe
}

$LegacyAppExe = Join-Path $OutDir "ByronMediaToolkit.exe"
if (Test-Path $LegacyAppExe) {
  Remove-Item -Force $LegacyAppExe
}

& $Deno compile `
  --allow-run `
  --allow-read `
  --allow-write `
  --allow-net `
  --allow-env `
  --allow-sys `
  --no-terminal `
  --app-name "SvidBackend" `
  --output $BackendExe `
  (Join-Path $Root "downloader.ts")

dotnet publish $DesktopProject `
  -c Release `
  -r win-x64 `
  --self-contained true `
  -p:PublishSingleFile=true `
  -p:EnableCompressionInSingleFile=true `
  -p:IncludeNativeLibrariesForSelfExtract=true `
  -p:PublishReadyToRun=false `
  -p:DebugType=none `
  -p:DebugSymbols=false `
  -p:PublishDir="$OutDir\"

Get-ChildItem -Path $OutDir -Filter "Microsoft.Web.WebView2.*.xml" -File -ErrorAction SilentlyContinue |
  Remove-Item -Force

if (Test-Path $InstallerPublishDir) {
  Remove-Item -Recurse -Force $InstallerPublishDir
}

dotnet publish $InstallerProject `
  -c Release `
  -r win-x64 `
  --self-contained true `
  -p:PublishSingleFile=true `
  -p:EnableCompressionInSingleFile=true `
  -p:IncludeNativeLibrariesForSelfExtract=true `
  -p:PublishReadyToRun=false `
  -p:DebugType=none `
  -p:DebugSymbols=false `
  -p:PublishDir="$InstallerPublishDir\"

$PublishedSetupExe = Join-Path $InstallerPublishDir "SvidSetup.exe"
Copy-Item -Force $PublishedSetupExe $SetupExe

Write-Host ""
Write-Host "Built: $AppExe"
Write-Host "Built: $SetupExe"
Write-Host "Portable app: $AppExe"
Write-Host "Installer: $SetupExe"
