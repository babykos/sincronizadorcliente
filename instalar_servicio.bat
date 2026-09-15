@echo off
setlocal enabledelayedexpansion
chcp 65001 >nul

rem === Instalador del servicio Sincronizador Cliente (via NSSM) ===

rem Debe ejecutarse como Administrador
net session >nul 2>&1
if %errorlevel% neq 0 (
    echo ERROR: Este script debe ejecutarse como Administrador.
    echo Haga clic derecho sobre el .bat y elija "Ejecutar como administrador".
    pause
    exit /b 1
)

set "PROYECTO_DIR=%~dp0"
if "%PROYECTO_DIR:~-1%"=="\" set "PROYECTO_DIR=%PROYECTO_DIR:~0,-1%"

rem Al ejecutar como Administrador, el directorio de trabajo suele quedar en
rem System32; nos posicionamos explicitamente en la carpeta del proyecto.
cd /d "%PROYECTO_DIR%"

set "NSSM_EXE=%PROYECTO_DIR%\nssm.exe"
set "NODE_EXE=C:\Program Files\nodejs\node.exe"
set "APP_JS=%PROYECTO_DIR%\app.js"
set "CONFIG_JSON=%PROYECTO_DIR%\config.json"
set "SET_PUERTO_JS=%PROYECTO_DIR%\bin\set_puerto.js"

if not exist "%NSSM_EXE%" (
    echo ERROR: No se encontro nssm.exe en "%PROYECTO_DIR%".
    pause
    exit /b 1
)

if not exist "%NODE_EXE%" (
    echo ERROR: No se encontro node.exe en "C:\Program Files\nodejs".
    echo Edite este .bat y ajuste la variable NODE_EXE con la ruta correcta.
    pause
    exit /b 1
)

if not exist "%APP_JS%" (
    echo ERROR: No se encontro app.js en "%PROYECTO_DIR%".
    pause
    exit /b 1
)

set "NOMBRE_SERVICIO=sincronizador_cliente"
set /p "NOMBRE_SERVICIO=Nombre del servicio [sincronizador_cliente]: "
if "%NOMBRE_SERVICIO%"=="" set "NOMBRE_SERVICIO=sincronizador_cliente"

set "PUERTO=3010"
set /p "PUERTO=Puerto donde se ejecutara [3010]: "
if "%PUERTO%"=="" set "PUERTO=3010"

echo %PUERTO%| findstr /r "^[0-9][0-9]*$" >nul
if %errorlevel% neq 0 (
    echo ERROR: El puerto debe ser numerico.
    pause
    exit /b 1
)

echo.
echo Actualizando config.json con el puerto %PUERTO%...
"%NODE_EXE%" "%SET_PUERTO_JS%" "%CONFIG_JSON%" %PUERTO%
if %errorlevel% neq 0 (
    echo ERROR: No se pudo actualizar config.json.
    pause
    exit /b 1
)

echo.
echo Verificando si el servicio "%NOMBRE_SERVICIO%" ya existe...
"%NSSM_EXE%" status "%NOMBRE_SERVICIO%" >nul 2>&1
if %errorlevel% equ 0 (
    echo El servicio ya existe. Deteniendolo y eliminandolo para reinstalar...
    "%NSSM_EXE%" stop "%NOMBRE_SERVICIO%" >nul 2>&1
    "%NSSM_EXE%" remove "%NOMBRE_SERVICIO%" confirm >nul 2>&1
)

echo.
echo Instalando el servicio "%NOMBRE_SERVICIO%"...
"%NSSM_EXE%" install "%NOMBRE_SERVICIO%" "%NODE_EXE%" "%APP_JS%"
"%NSSM_EXE%" set "%NOMBRE_SERVICIO%" AppDirectory "%PROYECTO_DIR%"
"%NSSM_EXE%" set "%NOMBRE_SERVICIO%" DisplayName "%NOMBRE_SERVICIO%"
"%NSSM_EXE%" set "%NOMBRE_SERVICIO%" Description "Sincronizador de cliente (puerto %PUERTO%)"
"%NSSM_EXE%" set "%NOMBRE_SERVICIO%" Start SERVICE_AUTO_START
"%NSSM_EXE%" set "%NOMBRE_SERVICIO%" AppStdout "%PROYECTO_DIR%\state\service_stdout.log"
"%NSSM_EXE%" set "%NOMBRE_SERVICIO%" AppStderr "%PROYECTO_DIR%\state\service_stderr.log"
"%NSSM_EXE%" set "%NOMBRE_SERVICIO%" AppRotateFiles 1

echo.
echo Iniciando el servicio...
"%NSSM_EXE%" start "%NOMBRE_SERVICIO%"

echo.
echo ===============================================
echo Servicio "%NOMBRE_SERVICIO%" instalado y en ejecucion.
echo Panel: http://127.0.0.1:%PUERTO%
echo ===============================================
pause
