from pathlib import Path

path = Path(".github/scripts/p2-principal-auth.py")
text = path.read_text()
old = '''old = ''' + "'''" + '''      const sessions = await listWorkspaceSessionsForParticipant(
        db,
        actor.id,
        unrestrictedSpaces,
        fullVaultIds,
      );
      return { sessions };
''' + "'''" + '''
new = ''' + "'''" + '''      const sessions = await listWorkspaceSessionsForParticipant(
        db,
        actor.id,
        unrestrictedSpaces,
        fullVaultIds,
      );
      return {
        sessions:
          actor.principalKind === "AGENT_PROCESS"
            ? sessions.filter((session) => session.id === actor.principalSessionId)
            : sessions,
      };
''' + "'''" + '''
text = replace_once(text, old, new, "bound session list")
'''
new = '''old = ''' + "'''" + '''      const sessions = await listWorkspaceSessionsForParticipant(
        db,
        actor.id,
        spaces,
        [...new Set(vaultIds)],
      );
      return { sessions };
''' + "'''" + '''
new = ''' + "'''" + '''      const sessions = await listWorkspaceSessionsForParticipant(
        db,
        actor.id,
        spaces,
        [...new Set(vaultIds)],
      );
      return {
        sessions:
          actor.principalKind === "AGENT_PROCESS"
            ? sessions.filter((session) => session.id === actor.principalSessionId)
            : sessions,
      };
''' + "'''" + '''
text = replace_once(text, old, new, "bound session list")
'''
if text.count(old) != 1:
    raise SystemExit(f"principal staging compatibility anchor changed: {text.count(old)}")
path.write_text(text.replace(old, new, 1))
