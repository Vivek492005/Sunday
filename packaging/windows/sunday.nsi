; Sunday Agent — Windows installer (NSIS).
; Built on GitHub Actions (windows-latest, makensis preinstalled).
; Installs the sunday-agent .vsix into VS Code / VSCodium.
;
; Build: makensis /DVERSION=0.1.0 /DVSIX=sunday-agent-0.1.0.vsix packaging/windows/sunday.nsi

!include "LogicLib.nsh"
!include "FileFunc.nsh"

!ifndef VERSION
  !error "VERSION not defined (pass /DVERSION=...)"
!endif
!ifndef VSIX
  !error "VSIX not defined (pass /DVSIX=path to .vsix)"
!endif

Name "Sunday Agent ${VERSION}"
!ifndef OUTFILE
  !define OUTFILE "Sunday-Agent-Setup-${VERSION}.exe"
!endif
OutFile "${OUTFILE}"
InstallDir "$LOCALAPPDATA\Programs\Sunday"
RequestExecutionLevel user
ShowInstDetails show

Section "Install"
  SetOutPath "$INSTDIR"
  File "${VSIX}"

  ; Find a VS Code binary: code.cmd on PATH, else the default install location.
  Var /GLOBAL CODEBIN
  StrCpy $CODEBIN ""
  nsExec::ExecToStack 'where code.cmd'
  Pop $0
  ${If} $0 == 0
    Pop $1
    StrCpy $CODEBIN $1
  ${Else}
    ${If} ${FileExists} "$LOCALAPPDATA\Programs\Microsoft VS Code\bin\code.cmd"
      StrCpy $CODEBIN "$LOCALAPPDATA\Programs\Microsoft VS Code\bin\code.cmd"
    ${EndIf}
  ${EndIf}

  ${If} $CODEBIN == ""
    MessageBox MB_ICONEXCLAMATION "VS Code was not found. Install VS Code first (https://code.visualstudio.com), then re-run this installer."
    Abort
  ${EndIf}

  DetailPrint "Installing extension with $CODEBIN ..."
  nsExec::ExecToStack '"$CODEBIN" --install-extension "$INSTDIR\${VSIX}" --force'
  Pop $0
  Pop $1
  ${If} $0 != 0
    MessageBox MB_ICONEXCLAMATION "Extension install failed (exit $0):$\n$1"
    Abort
  ${EndIf}
  DetailPrint $1

  WriteUninstaller "$INSTDIR\Uninstall.exe"
SectionEnd

Section "Uninstall"
  nsExec::ExecToStack 'where code.cmd'
  Pop $0
  ${If} $0 == 0
    Pop $1
    nsExec::ExecToStack '"$1" --uninstall-extension sunday.sunday-agent'
  ${EndIf}
  Delete "$INSTDIR\${VSIX}"
  Delete "$INSTDIR\Uninstall.exe"
  RMDir "$INSTDIR"
SectionEnd
