# Authenticode-sign Windows release files (release workflow, jobs
# `sign-windows-exe` and `sign-windows-installer`; also usable locally).
#
#   pwsh scripts/release/windows-sign.ps1 -Path <file> [-Path <file> ...]
#
# Credentials come from the environment and are optional:
#   WINDOWS_CERTIFICATE           code-signing .pfx, base64
#   WINDOWS_CERTIFICATE_PASSWORD  its password
#   WINDOWS_TIMESTAMP_URL         RFC 3161 server (default DigiCert)
# Without WINDOWS_CERTIFICATE the files are left unsigned and a warning is
# printed. The certificate is imported for the duration of the script only.
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string[]] $Path
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

foreach ($file in $Path) {
    if (-not (Test-Path -LiteralPath $file -PathType Leaf)) { throw "No such file: $file" }
}

if (-not $env:WINDOWS_CERTIFICATE) {
    Write-Output '::warning::WINDOWS_CERTIFICATE not set: Windows files stay unsigned (SmartScreen will warn).'
    exit 0
}

$timestampUrl = if ($env:WINDOWS_TIMESTAMP_URL) { $env:WINDOWS_TIMESTAMP_URL } else { 'http://timestamp.digicert.com' }

# signtool ships with the Windows SDK; take the newest x64 build.
$signtool = Get-ChildItem -Path "${env:ProgramFiles(x86)}\Windows Kits\10\bin\*\x64\signtool.exe" -ErrorAction SilentlyContinue |
    Sort-Object -Property FullName -Descending | Select-Object -First 1
if (-not $signtool) { throw 'signtool.exe not found (install the Windows 10/11 SDK).' }

$tempDir = if ($env:RUNNER_TEMP) { $env:RUNNER_TEMP } else { [IO.Path]::GetTempPath() }
$pfx = Join-Path $tempDir ("signing-{0}.pfx" -f [guid]::NewGuid())
$cert = $null
try {
    [IO.File]::WriteAllBytes($pfx, [Convert]::FromBase64String($env:WINDOWS_CERTIFICATE))
    $password = ConvertTo-SecureString -String $env:WINDOWS_CERTIFICATE_PASSWORD -AsPlainText -Force
    # Not -Exportable: the private key cannot be read back out of the store.
    $cert = Import-PfxCertificate -FilePath $pfx -CertStoreLocation 'Cert:\CurrentUser\My' -Password $password
    Remove-Item -LiteralPath $pfx -Force
    if (-not $cert) { throw 'The .pfx did not contain a certificate.' }

    foreach ($file in $Path) {
        & $signtool.FullName sign /sha1 $cert.Thumbprint /s My /fd sha256 /tr $timestampUrl /td sha256 /d 'FaceTimelapse' $file
        if ($LASTEXITCODE -ne 0) { throw "signtool sign failed for $file (exit $LASTEXITCODE)" }
        & $signtool.FullName verify /pa /v $file
        if ($LASTEXITCODE -ne 0) { throw "signature verification failed for $file (exit $LASTEXITCODE)" }
        Write-Output "signed $file"
    }
}
finally {
    if (Test-Path -LiteralPath $pfx) { Remove-Item -LiteralPath $pfx -Force }
    if ($cert) {
        try {
            Remove-Item -Path ("Cert:\CurrentUser\My\{0}" -f $cert.Thumbprint) -DeleteKey -ErrorAction Stop
        }
        catch {
            Write-Output "::warning::Could not remove the signing certificate from the store: $_"
        }
    }
}
