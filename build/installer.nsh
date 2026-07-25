; AgentRecall data is retained by default. The user must explicitly choose
; removal after the application binaries have been uninstalled.
!macro customUnInstall
  MessageBox MB_YESNO|MB_ICONQUESTION|MB_DEFBUTTON2 \
    "Also remove AgentRecall's local database, settings, update cache, and backups? Your Claude Code and Codex session files are never removed." \
    IDNO keep_agent_recall_data

  SetShellVarContext current
  RMDir /r "$APPDATA\AgentRecall"
  RMDir /r "$LOCALAPPDATA\agent-recall-updater"
  RMDir /r "$PROFILE\.agent-recall"

  keep_agent_recall_data:
!macroend
