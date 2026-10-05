@echo off
chcp 65001 >nul
title WeChat Channels Downloader
cd /d "%~dp0"
node channels_dl.js %*
echo.
pause
