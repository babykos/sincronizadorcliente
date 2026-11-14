<# : batch
@echo off
setlocal
rem ==================================================================
rem  Instalador completo del Sincronizador Cliente
rem    1. Instala Node.js (LTS) si falta o es < 18
rem    2. Instala Git si falta
rem    3. Clona el proyecto (o lo actualiza si ya existe)
rem    4. Instala dependencias (npm ci)
rem    5. Ejecuta instalar_servicio.bat (servicio de Windows via NSSM)
rem
rem  Uso: copiar este archivo a la PC y darle doble clic.
rem  Instalacion offline: dejar junto a este .bat el instalador de Node
rem  (node-vXX-x64.msi) y/o de Git (Git-X.Y.Z-64-bit.exe) y se usaran
rem  en lugar de descargarlos.
rem ==================================================================
set "BOOTSTRAP_FILE=%~f0"
set "BOOTSTRAP_DIR=%~dp0"

net session >nul 2>&1
if %errorlevel% neq 0 (
    echo Solicitando permisos de administrador...
    powershell -NoProfile -Command "Start-Process -FilePath $env:BOOTSTRAP_FILE -Verb RunAs"
    exit /b
)

powershell -NoProfile -ExecutionPolicy Bypass -Command "iex ([IO.File]::ReadAllText($env:BOOTSTRAP_FILE))"
if %errorlevel% neq 0 pause
exit /b
#>

# ======================= CONFIGURACION =======================
$RepoUrl      = 'https://github.com/babykos/sincronizadorcliente.git'
$RepoBranch   = 'main'
$DirDefecto   = 'C:\sincronizadorcliente'
$NodeMinMajor = 18

# Opcional: URLs propias (p.ej. en tu nube) de los instaladores.
# Si quedan vacias se descarga la ultima version oficial.
$NodeMsiUrl   = ''   # ej. 'https://mi-nube/node-v22.11.0-x64.msi'
$GitExeUrl    = ''   # ej. 'https://mi-nube/Git-2.47.1-64-bit.exe'

# Archivos locales que se conservan al actualizar un proyecto existente.
$Conservar    = @('config.json', 'tablas.json')
# =============================================================

$ErrorActionPreference = 'Stop'
$ProgressPreference    = 'SilentlyContinue'   # acelera Invoke-WebRequest
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

$BootDir = $env:BOOTSTRAP_DIR
$EsArm   = $env:PROCESSOR_ARCHITECTURE -eq 'ARM64'
$Temp    = Join-Path $env:TEMP 'sincronizador_setup'
New-Item -ItemType Directory -Force -Path $Temp | Out-Null

function Paso($t) { Write-Host ''; Write-Host "==> $t" -ForegroundColor Cyan }
function Ok($t)   { Write-Host "    $t" -ForegroundColor Green }
function Info($t) { Write-Host "    $t" }

function Actualizar-Path {
    $m = [Environment]::GetEnvironmentVariable('Path', 'Machine')
    $u = [Environment]::GetEnvironmentVariable('Path', 'User')
    $env:Path = "$m;$u"
}

function Descargar($url, $destino) {
    Info "Descargando $url"
    Invoke-WebRequest -Uri $url -OutFile $destino -UseBasicParsing
}

function Buscar-Local($patron) {
    if (-not $BootDir) { return $null }
    Get-ChildItem -Path $BootDir -Filter $patron -File -ErrorAction SilentlyContinue |
        Sort-Object Name -Descending | Select-Object -First 1 -ExpandProperty FullName
}

function Ejecutar($exe, $argumentos) {
    $p = Start-Process -FilePath $exe -ArgumentList $argumentos -Wait -PassThru
    if ($p.ExitCode -ne 0 -and $p.ExitCode -ne 3010) {
        throw "$exe termino con codigo $($p.ExitCode)"
    }
}

function Invocar-Git {
    & git.exe @args
    if ($LASTEXITCODE -ne 0) { throw "git $($args -join ' ') fallo (codigo $LASTEXITCODE)" }
}

function Version-Node {
    $cmd = Get-Command node.exe -ErrorAction SilentlyContinue
    if (-not $cmd) { return $null }
    try { return [version]((& $cmd.Source -v) -replace '^v', '') } catch { return $null }
}

try {
    Actualizar-Path

    # ---------------------------------------------------------- Node.js
    Paso 'Verificando Node.js'
    $nv = Version-Node
    if ($nv -and $nv.Major -ge $NodeMinMajor) {
        Ok "Node.js $nv ya instalado"
    } else {
        if ($nv) { Info "Node.js $nv es muy antiguo (se requiere >= $NodeMinMajor)" }
        else     { Info 'Node.js no esta instalado' }

        $arq = if ($EsArm) { 'arm64' } else { 'x64' }
        $msi = Buscar-Local "node-v*-$arq.msi"
        if ($msi) {
            Info "Usando instalador local: $msi"
        } else {
            $url = $NodeMsiUrl
            if (-not $url) {
                $versiones = Invoke-RestMethod -Uri 'https://nodejs.org/dist/index.json' -UseBasicParsing
                $lts = $versiones | Where-Object { $_.lts } | Select-Object -First 1
                $url = "https://nodejs.org/dist/$($lts.version)/node-$($lts.version)-$arq.msi"
            }
            $msi = Join-Path $Temp 'node.msi'
            Descargar $url $msi
        }
        Info 'Instalando Node.js (puede tardar un par de minutos)...'
        Ejecutar 'msiexec.exe' @('/i', "`"$msi`"", '/qn', '/norestart')
        Actualizar-Path
        $nv = Version-Node
        if (-not $nv) { throw 'Node.js no quedo disponible despues de instalarlo.' }
        Ok "Node.js $nv instalado"
    }

    # ---------------------------------------------------------- Git
    Paso 'Verificando Git'
    if (Get-Command git.exe -ErrorAction SilentlyContinue) {
        Ok "$(& git.exe --version) ya instalado"
    } else {
        Info 'Git no esta instalado'
        $exe = Buscar-Local $(if ($EsArm) { 'Git-*-arm64.exe' } else { 'Git-*-64-bit.exe' })
        if ($exe) {
            Info "Usando instalador local: $exe"
        } else {
            $url = $GitExeUrl
            if (-not $url) {
                $rel    = Invoke-RestMethod -Uri 'https://api.github.com/repos/git-for-windows/git/releases/latest' -UseBasicParsing
                $patron = if ($EsArm) { '^Git-[\d.]+-arm64\.exe$' } else { '^Git-[\d.]+-64-bit\.exe$' }
                $asset  = $rel.assets | Where-Object { $_.name -match $patron } | Select-Object -First 1
                if (-not $asset) { throw 'No se encontro el instalador de Git en GitHub. Configure $GitExeUrl.' }
                $url = $asset.browser_download_url
            }
            $exe = Join-Path $Temp 'git-setup.exe'
            Descargar $url $exe
        }
        Info 'Instalando Git...'
        Ejecutar $exe @('/VERYSILENT', '/NORESTART', '/NOCANCEL', '/SP-', '/SUPPRESSMSGBOXES')
        Actualizar-Path
        if (-not (Get-Command git.exe -ErrorAction SilentlyContinue)) { throw 'Git no quedo disponible despues de instalarlo.' }
        Ok "$(& git.exe --version) instalado"
    }

    # ---------------------------------------------------------- Proyecto
    Paso 'Proyecto'
    $dir = Read-Host "Carpeta de instalacion [$DirDefecto]"
    if (-not $dir) { $dir = $DirDefecto }
    $dir = $dir.Trim().TrimEnd('\')

    # Se clona como Administrador; sin esto git rechaza la carpeta
    # ("dubious ownership") cuando otro usuario haga git pull despues.
    $dirGit = $dir -replace '\\', '/'
    $seguros = & git.exe config --system --get-all safe.directory 2>$null
    if (-not ($seguros -contains $dirGit)) { Invocar-Git config --system --add safe.directory $dirGit }

    if (Test-Path (Join-Path $dir '.git')) {
        Info "Ya existe una instalacion en $dir; se actualizara."

        # Detener los servicios NSSM que corren desde esta carpeta
        $nssm = (Join-Path $dir 'nssm.exe').ToLower()
        Get-CimInstance Win32_Service |
            Where-Object { $_.State -eq 'Running' -and $_.PathName -and $_.PathName.ToLower().Contains($nssm) } |
            ForEach-Object { Info "Deteniendo servicio $($_.Name)"; Stop-Service -Name $_.Name -Force }

        $respaldo = @{}
        foreach ($f in $Conservar) {
            $p = Join-Path $dir $f
            if (Test-Path $p) { $respaldo[$f] = [IO.File]::ReadAllBytes($p) }
        }
        Invocar-Git -C $dir fetch origin $RepoBranch
        Invocar-Git -C $dir reset --hard "origin/$RepoBranch"
        foreach ($f in $respaldo.Keys) { [IO.File]::WriteAllBytes((Join-Path $dir $f), $respaldo[$f]) }
        Ok "Proyecto actualizado (se conservaron: $($respaldo.Keys -join ', '))"
    } elseif ((Test-Path $dir) -and (Get-ChildItem -Path $dir -Force | Select-Object -First 1)) {
        throw "La carpeta $dir existe, no esta vacia y no es un repositorio git."
    } else {
        Invocar-Git clone --branch $RepoBranch $RepoUrl $dir
        Ok "Proyecto descargado en $dir"
    }

    # ---------------------------------------------------------- Dependencias
    Paso 'Instalando dependencias (npm ci)'
    Push-Location $dir
    try {
        & npm.cmd ci --omit=dev --no-audit --no-fund
        if ($LASTEXITCODE -ne 0) { throw "npm ci fallo (codigo $LASTEXITCODE)" }
    } finally { Pop-Location }
    Ok 'Dependencias instaladas'

    # ---------------------------------------------------------- Servicio
    Paso 'Instalando el servicio de Windows'
    & (Join-Path $dir 'instalar_servicio.bat')
    if ($LASTEXITCODE -ne 0) {
        Write-Host "    instalar_servicio.bat termino con codigo $LASTEXITCODE; revise los mensajes de arriba." -ForegroundColor Yellow
    }
    exit 0
} catch {
    Write-Host ''
    Write-Host "ERROR: $($_.Exception.Message)" -ForegroundColor Red
    exit 1
}
