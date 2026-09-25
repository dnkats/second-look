@echo off
rem Runs the review-comments tool that ships with this skill; needs Node.js.
setlocal
set "NODE=node"
where node >nul 2>nul
if errorlevel 1 if exist "%~dp0node-path" set /p NODE=<"%~dp0node-path"
"%NODE%" "%~dp0review-comments.js" %*
