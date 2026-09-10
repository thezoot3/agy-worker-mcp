import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/**
 * The exact tool list agy 1.1.23 reported in `init`, copied from
 * `.spike/out/run1.events.ndjson`. Present so the fake's init event has the same
 * shape (array of 57 strings) as the real one.
 */
export const AGY_TOOLS = [
  'ask_custom_permission', 'ask_permission', 'ask_question', 'browser_click_element',
  'browser_drag_pixel_to_pixel', 'browser_get_dom', 'browser_get_network_request',
  'browser_input', 'browser_list_network_requests', 'browser_mouse_down', 'browser_mouse_up',
  'browser_move_mouse', 'browser_press_key', 'browser_refresh_page', 'browser_resize_window',
  'browser_scroll', 'browser_scroll_dom', 'browser_select_option', 'browser_subagent',
  'call_mcp_tool', 'capture_browser_console_logs', 'capture_browser_screenshot',
  'click_browser_pixel', 'command_status', 'define_subagent', 'delete_knowledge',
  'execute_browser_javascript', 'find_by_name', 'finish', 'generate_image', 'grep_search',
  'invoke_subagent', 'list_browser_pages', 'list_dir', 'list_permissions', 'list_resources',
  'manage_inbox', 'manage_subagents', 'manage_task', 'multi_replace_file_content',
  'notebook_edit', 'notebook_execution', 'open_browser_url', 'read_browser_page',
  'read_resource', 'read_url_content', 'replace_file_content', 'run_command', 'schedule',
  'search_web', 'sed_file', 'send_command_input', 'send_message', 'view_file', 'wait',
  'wait_5_seconds', 'write_to_file',
]

/** agy's internal artifact directory for a conversation — the only place `write_to_file` may write. */
export function brainDir(conversationId) {
  return path.join(os.homedir(), '.gemini', 'antigravity-cli', 'brain', conversationId)
}

/**
 * Real filesystem behaviour for the tools the M1 measurement identified as
 * actually reaching the model (§M1):
 * `view_file`, `list_dir`, `find_by_name`, `grep_search`, `replace_file_content`,
 * `write_to_file`, `manage_task`. Unlike `run_command` (which stays purely
 * scenario-scripted — the fake never execs a real shell), these operate on the
 * real filesystem so a scenario doesn't have to hand-script their output, and
 * PR2+ tests can assert against actual file state.
 *
 * Deliberately simple, not a faithful reimplementation of agy's own tool
 * semantics beyond what M1 measured:
 *   - `find_by_name` matches file *names* only (not directory names) against a
 *     glob (`*`/`?`), recursively.
 *   - `grep_search` does a plain substring search, not a regex engine.
 *   - `replace_file_content` replaces lines `StartLine..EndLine` (1-based,
 *     inclusive) when given, else replaces the first occurrence of
 *     `TargetContent` with `ReplacementContent`.
 *   - `manage_task` has no real background tasks to track; `status` is a no-op
 *     success, `send_input` enforces the one validation M1 observed directly
 *     (`Input is required for send_input action`).
 *
 * @returns `{ output }` on success, `{ error }` on failure, or `null` when
 * `name` isn't one of these tools (caller falls back to scripted output).
 */
export function runFileTool(name, parameters, ctx) {
  try {
    switch (name) {
      case 'view_file':
        return { output: fs.readFileSync(parameters.AbsolutePath, 'utf8') }

      case 'list_dir': {
        const entries = fs.readdirSync(parameters.DirectoryPath, { withFileTypes: true })
        const lines = entries.map((e) => (e.isDirectory() ? `${e.name}/` : e.name)).sort()
        return { output: lines.join('\n') + (lines.length ? '\n' : '') }
      }

      case 'find_by_name': {
        const re = globToRegExp(parameters.Pattern ?? '*')
        const matches = []
        walk(parameters.SearchDirectory, (full, entryName) => {
          if (re.test(entryName)) matches.push(full)
        })
        matches.sort()
        return { output: matches.join('\n') + (matches.length ? '\n' : '') }
      }

      case 'grep_search': {
        const query = parameters.Query ?? ''
        const perLine = parameters.MatchPerLine !== false
        const files = []
        const st = fs.statSync(parameters.SearchPath)
        if (st.isDirectory()) walk(parameters.SearchPath, (full) => files.push(full))
        else files.push(parameters.SearchPath)

        const hits = []
        for (const file of files) {
          let text
          try {
            text = fs.readFileSync(file, 'utf8')
          } catch {
            continue
          }
          if (perLine) {
            text.split('\n').forEach((line, i) => {
              if (line.includes(query)) hits.push(`${file}:${i + 1}:${line}`)
            })
          } else if (text.includes(query)) {
            hits.push(file)
          }
        }
        return { output: hits.join('\n') + (hits.length ? '\n' : '') }
      }

      case 'replace_file_content': {
        const file = parameters.TargetFile
        const original = fs.readFileSync(file, 'utf8')
        const { StartLine: start, EndLine: end } = parameters
        let next
        if (typeof start === 'number' && typeof end === 'number') {
          const lines = original.split('\n')
          next = [
            ...lines.slice(0, start - 1),
            ...(parameters.ReplacementContent ?? '').split('\n'),
            ...lines.slice(end),
          ].join('\n')
        } else {
          next = original.split(parameters.TargetContent ?? '').join(parameters.ReplacementContent ?? '')
        }
        fs.writeFileSync(file, next)
        return { output: '' }
      }

      case 'write_to_file': {
        const file = parameters.TargetFile
        const brain = brainDir(ctx.conversationId)
        const resolved = path.resolve(file)
        const brainResolved = path.resolve(brain)
        const insideBrain =
          resolved === brainResolved || resolved.startsWith(brainResolved + path.sep)
        if (!insideBrain) {
          // Verbatim shape from §M1 measurement.
          return {
            error:
              'declaring permissions: cortex tool write_to_file: convert tool call for permissions: ' +
              'model output error: invalid tool call error (invalid_args) ' +
              `${file} is not a valid artifact path; artifacts must be in ${brain}/`,
          }
        }
        if (fs.existsSync(resolved) && parameters.Overwrite !== true) {
          return { error: `${file} already exists; pass Overwrite to replace it` }
        }
        fs.mkdirSync(path.dirname(resolved), { recursive: true })
        fs.writeFileSync(resolved, parameters.CodeContent ?? '')
        return { output: '' }
      }

      case 'manage_task': {
        // Verbatim from §M1: send_input rejects an empty Input.
        if (parameters.Action === 'send_input' && !parameters.Input) {
          return { error: 'Input is required for send_input action' }
        }
        return { output: '' }
      }

      default:
        return null
    }
  } catch (e) {
    return { error: e?.message ?? String(e) }
  }
}

function globToRegExp(pattern) {
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '.*')
    .replace(/\?/g, '.')
  return new RegExp(`^${escaped}$`)
}

function walk(dir, visit) {
  let entries
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) walk(full, visit)
    else visit(full, entry.name)
  }
}
