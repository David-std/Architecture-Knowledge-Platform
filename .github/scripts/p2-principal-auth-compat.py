from pathlib import Path

path = Path(".github/scripts/p2-principal-auth.py")
text = path.read_text()

# The workspace slice evolved after this materializer was drafted. Rewrite only
# the stale literals inside the temporary staging script so it still validates
# every real product anchor rather than weakening the product patch itself.
old_list = '''old = ''' + "'''" + '''      const sessions = await listWorkspaceSessionsForParticipant(
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
new_list = '''old = ''' + "'''" + '''      const sessions = await listWorkspaceSessionsForParticipant(
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
if text.count(old_list) != 1:
    raise SystemExit(f"principal session-list compatibility anchor changed: {text.count(old_list)}")
text = text.replace(old_list, new_list, 1)

old_event = '    Body: { eventType: string; payload: Record<string, unknown> };\n'
new_event = '    Body: { eventType: string; payload?: Record<string, unknown> };\n'
if text.count(old_event) != 1:
    raise SystemExit(f"principal event-payload compatibility anchor changed: {text.count(old_event)}")
text = text.replace(old_event, new_event, 1)

path.write_text(text)
