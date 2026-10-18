# Verifies the existing public installer; does not rebuild, sign, trust, publish, or use real accounts.
$ErrorActionPreference = 'Stop'
if ($env:GITHUB_ACTIONS -ne 'true' -or $env:CI -ne 'true' -or $env:RUNNER_OS -ne 'Windows' -or $env:RUNNER_ENVIRONMENT -ne 'github-hosted') {
  throw 'Installer verification requires a disposable GitHub-hosted Windows runner'
}
$evidence = Join-Path $PWD 'nsis-evidence'
New-Item -ItemType Directory -Force $evidence | Out-Null
$registryRoots = @('HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall', 'HKLM:\Software\Microsoft\Windows\CurrentVersion\Uninstall', 'HKLM:\Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall')
function Find-TalkWeaverInstall {
  foreach ($root in $registryRoots) {
    Get-ItemProperty "$root\*" -ErrorAction SilentlyContinue | Where-Object { $_.DisplayName -like 'TalkWeaver*' } | Select-Object DisplayName, InstallLocation
  }
}
if ((Find-TalkWeaverInstall) -or (Get-Process TalkWeaver -ErrorAction SilentlyContinue) -or (Get-AppxPackage -Name DominikLukes.TalkWeaver)) {
  throw 'An existing TalkWeaver installation or process was found; refusing to change it'
}
$scratch = Join-Path $env:RUNNER_TEMP "talkweaver-public-nsis-$env:GITHUB_RUN_ID-$env:GITHUB_RUN_ATTEMPT"
if (Test-Path $scratch) { throw 'The isolated installer-test directory already exists' }
New-Item -ItemType Directory $scratch | Out-Null
$install = Join-Path $scratch 'installed'
$installer = Join-Path $scratch 'TalkWeaver-windows-x64-setup.exe'
$demo = Join-Path $scratch 'TalkWeaver-demo-vault.zip'
$failures = @()
$startedAt = Get-Date
Get-CimInstance Win32_OperatingSystem | Select-Object Caption, Version, BuildNumber, OSArchitecture | ConvertTo-Json | Set-Content (Join-Path $evidence 'windows-version.json')
function Save-InstallerCrashEvidence {
  try {
    # Text events only, limited to this application's installer. Never collect dumps or environment.
    Get-WinEvent -FilterHashtable @{ LogName = 'Application'; Id = 1000,1001; StartTime = $startedAt } -ErrorAction SilentlyContinue |
      Where-Object { $_.Message -match 'TalkWeaver-windows-x64-setup|TalkWeaver.exe' } |
      Select-Object TimeCreated, Id, ProviderName, Message | ConvertTo-Json -Depth 3 |
      Set-Content (Join-Path $evidence 'installer-crash-events.json')
  } catch { $_.Exception.Message | Set-Content (Join-Path $evidence 'event-query-error.txt') }
}

function Invoke-BoundedProbe([string]$Executable, [string[]]$Arguments, [string]$Name, [int]$TimeoutSeconds, [bool]$RedirectOutput = $true) {
  Write-Host "START $Name; limit $TimeoutSeconds seconds"
  $options = @{ FilePath = $Executable; ArgumentList = $Arguments; PassThru = $true }
  if ($RedirectOutput) {
    $options.RedirectStandardOutput = Join-Path $evidence "$Name.stdout.log"
    $options.RedirectStandardError = Join-Path $evidence "$Name.stderr.log"
  }
  # Controlled repeat: NSIS has no console output. Do not redirect its GUI process handles.
  $probe = Start-Process @options
  if (-not $probe.WaitForExit($TimeoutSeconds * 1000)) {
    & taskkill.exe /PID $probe.Id /T /F | Out-Null
    throw "$Name exceeded its $TimeoutSeconds second limit"
  }
  if ($RedirectOutput) {
    Get-Content (Join-Path $evidence "$Name.stdout.log") | ForEach-Object { Write-Host $_ }
    Get-Content (Join-Path $evidence "$Name.stderr.log") | ForEach-Object { Write-Host $_ }
  }
  [pscustomobject]@{ name = $Name; exitCode = $probe.ExitCode; redirected = $RedirectOutput; arguments = $Arguments } | ConvertTo-Json | Set-Content (Join-Path $evidence "$Name-process.json")
  Write-Host "END $Name; exit $($probe.ExitCode)"
  if ($probe.ExitCode -ne 0) { throw "$Name exited with $($probe.ExitCode); see retained process and diagnostic evidence" }
}
try {
  $files = @(
    @{ name = 'installer'; url = 'https://github.com/techczech/talkweaver-app/releases/download/v0.39.0/TalkWeaver-windows-x64-setup.exe'; path = $installer; sha256 = 'e6bb537912123a4682cfdc568e1617de2aeeb6866e72398a14060520a3313010' },
    @{ name = 'demo'; url = 'https://github.com/techczech/talkweaver-app/releases/download/v0.39.0/TalkWeaver-demo-vault.zip'; path = $demo; sha256 = '5a06c8817480035379f895b7ab05e7c75cf9590648a8054eef17bf3497f80684' }
  )
  foreach ($file in $files) {
    Invoke-WebRequest -Uri $file.url -OutFile $file.path -TimeoutSec 180
    $actual = (Get-FileHash $file.path -Algorithm SHA256).Hash.ToLower()
    if ($actual -ne $file.sha256) { throw "$($file.name) SHA256 mismatch: $actual" }
    Write-Host "PASS $($file.name) exact public-release SHA256 $actual"
  }
  $files | ForEach-Object { [pscustomobject]@{ name = $_.name; url = $_.url; sha256 = $_.sha256 } } | ConvertTo-Json | Set-Content (Join-Path $evidence 'verified-downloads.json')
  $signature = Get-AuthenticodeSignature -LiteralPath $installer
  $signature | Select-Object Status, StatusMessage | ConvertTo-Json | Set-Content (Join-Path $evidence 'authenticode.json')
  Write-Host "Official installer Authenticode status: $($signature.Status)"
  # This fixed official release is unsigned. Do not change trust or Windows security settings.
  if ($signature.Status -ne 'NotSigned') { throw 'The fixed public release has an unexpected Authenticode status' }
  Expand-Archive -LiteralPath $demo -DestinationPath (Join-Path $scratch 'demo')
  $env:TW_NSIS_SCRATCH = $scratch
  $env:TW_NSIS_VAULT = Join-Path $scratch 'demo\TalkWeaver demo vault'
  $env:TW_NSIS_INSTALL = $install
  $env:TW_NSIS_EXE = Join-Path $install 'TalkWeaver.exe'
  Invoke-BoundedProbe $installer @('/S', '/currentuser', "/D=$install") 'install' 180 $false
  if (-not (Test-Path $env:TW_NSIS_EXE)) { throw 'Silent installer did not create the expected executable in the isolated directory' }
  Invoke-BoundedProbe 'node' @('e2e/diagnose-public-windows-installer.mjs') 'installed-app' 180
} catch {
  Save-InstallerCrashEvidence
  $_ | Out-String | Set-Content (Join-Path $evidence 'failure.txt')
  $failures += $_.Exception.Message
} finally {
  try {
    Get-Process TalkWeaver -ErrorAction SilentlyContinue | Where-Object { $_.Path -and $_.Path.StartsWith($install, [StringComparison]::OrdinalIgnoreCase) } | Stop-Process -Force
    $uninstaller = Join-Path $install 'Uninstall TalkWeaver.exe'
    if (Test-Path $uninstaller) {
      $uninstallCopy = Join-Path $scratch 'uninstall-test-copy.exe'
      Copy-Item $uninstaller $uninstallCopy
      Invoke-BoundedProbe $uninstallCopy @('/S', "_?=$install") 'uninstall' 120
      if (Test-Path (Join-Path $install 'TalkWeaver.exe')) { throw 'Uninstall left the application executable behind' }
      if (Find-TalkWeaverInstall) { throw 'Uninstall left a TalkWeaver registration behind' }
      'PASS installed executable and uninstall registration removed' | Set-Content (Join-Path $evidence 'uninstall.txt')
    } elseif (Test-Path (Join-Path $install 'TalkWeaver.exe')) {
      throw 'Installed application has no expected uninstaller'
    }
  } catch {
    $_ | Out-String | Set-Content (Join-Path $evidence 'uninstall-failure.txt')
    $failures += $_.Exception.Message
  } finally {
    Remove-Item $scratch -Recurse -Force -ErrorAction SilentlyContinue
    if (Test-Path $scratch) { $failures += 'Isolated test files could not be removed' }
  }
}
if ($failures.Count) { throw ($failures -join '; ') }
'PASS public NSIS installer verification and cleanup completed' | Set-Content (Join-Path $evidence 'result.txt')
