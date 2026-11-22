// Tool classification for both Antigravity (CLI/App/IDE) and Claude Code tool names.
import { readOnly } from './bash.mjs'

const LOOKS = new Set([
  // Antigravity tools
  'read_file', 'view_file', 'grep_search', 'find_by_name', 'list_dir',
  'search_web', 'read_url_content', 'ask_question', 'list_permissions', 'ask_permission',
  'invoke_subagent', 'define_subagent', 'send_message', 'manage_subagents',
  'manage_task', 'schedule', 'list_resources', 'read_resource',
  // Claude Code equivalents kept for test compatibility
  'Read', 'Grep', 'Glob', 'LS', 'WebFetch', 'WebSearch', 'TodoWrite', 'TodoRead',
  'Agent', 'Task', 'AskUserQuestion', 'ToolSearch', 'Skill',
  'ListMcpResourcesTool', 'ReadMcpResourceTool', 'ReadMcpResourceDirTool',
  'TaskGet', 'TaskList', 'TaskOutput', 'ExitPlanMode', 'EnterPlanMode', 'LSP'
])

const MCP_LOOKS = /^(?:mcp__|mcp_).+?[_/](?:get|list|read|search|find|fetch|query|view|show|describe|lookup|check|count|stat)(?:_|$)/i
const MCP_WRITES = /(?:^|_)(?:write|edit|replace|create|update|delete|remove|move|rename|apply|fix|set|save|patch|insert|put|add|append|upsert|store|upload|download|copy|clear|reset|commit|merge|run|exec|execute|format|generate|install|import|sync|push|pull|restore|extract)(?:_|$)/i

export function mayWrite (tool, input = {}) {
  if (tool === 'run_command' || tool === 'Bash') {
    const cmd = typeof input.CommandLine === 'string' ? input.CommandLine : input.command
    if (typeof cmd === 'string' && cmd.includes('timeline-cli.mjs')) return false
    return !(typeof cmd === 'string' && readOnly(cmd))
  }
  if (tool === 'call_mcp_tool') {
    const sub = String(input.ToolName || '')
    const full = `mcp__${input.ServerName || 'srv'}__${sub}`
    return !(MCP_LOOKS.test(full) && !MCP_WRITES.test(sub))
  }
  if (LOOKS.has(tool)) return false
  return !(MCP_LOOKS.test(tool) && !MCP_WRITES.test(tool.replace(/^(?:mcp__|mcp_).+?[_/]/, '')))
}
