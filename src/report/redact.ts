/**
 * The single choke point for every string that reaches an HTML report
 * (docs/.local/13-usage-and-debug-records.md §4). A report is built out of
 * job logs, and job logs contain whatever the agent read or ran — file
 * contents, command output, environment variables it happened to print. None
 * of that has been vetted for secrets or for HTML meaning, so nothing from
 * L2 may reach the renderer without going through `redactText` and, at the
 * point of interpolation, `escapeHtml` or `escapeJsonForScript`.
 *
 * This module is pure and has no dependency on the rest of `src/` on
 * purpose: it is small enough to audit in one sitting, and it must stay that
 * way as the renderer around it grows.
 */

/** Escapes the five characters that give HTML text or an attribute meaning. */
export function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;')
}

/**
 * `JSON.stringify` for embedding inside `<script type="application/json">`.
 *
 * The data embedded for the report's own sorting and filtering comes from job
 * logs, and those carry file contents the agent read — which may legitimately
 * contain a literal `</script>` (this very file, for instance, if a job ever
 * reads it). A raw `</script>` inside the JSON text would close the element
 * early and hand the browser's HTML parser the rest of the payload as markup.
 * Writing the `<` as the six-character escape `\u003c` defuses that without
 * changing what `JSON.parse` sees, since the escape is decoded back to the
 * original character before parsing. U+2028 and U+2029 get the same treatment
 * because some consumers still treat them as line terminators — cheap
 * insurance, since valid JSON never needs the literal code points.
 */
export function escapeJsonForScript(value: unknown): string {
  const json = JSON.stringify(value) ?? 'null'
  return json.replace(/</g, '\\u003c').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029')
}

export interface RedactOptions {
  level: 'default' | 'strict'
  /** Absolute path to the user's home directory. Omit to skip that substitution. */
  home?: string
  /** Absolute path to the project workspace. Omit to skip that substitution. */
  workspace?: string
}

/**
 * Kept the module pure: the caller (report.ts, which does I/O) decides what
 * "home" and "workspace" are — this file never calls `os.homedir()` itself.
 */
function substitutePaths(text: string, options: RedactOptions): string {
  const substitutions: Array<{ path: string; replacement: string }> = []
  if (options.workspace) substitutions.push({ path: options.workspace, replacement: '<workspace>' })
  if (options.home) substitutions.push({ path: options.home, replacement: '~' })

  // Longest path first: a workspace nested under home (the common case) must
  // be rewritten to <workspace> whole, before a home substitution gets a
  // chance to eat its prefix and leave "~/rest-of-workspace-path" behind.
  substitutions.sort((a, b) => b.path.length - a.path.length)

  let result = text
  for (const { path, replacement } of substitutions) {
    if (path.length === 0) continue
    // A plain split/join is a literal (non-regex) replace-all — no escaping
    // to get wrong, and no risk of the path being read as a pattern.
    result = result.split(path).join(replacement)
  }
  return result
}

interface SecretPattern {
  regex: RegExp
  replace: (substring: string, ...groups: string[]) => string
}

const SECRET_PATTERNS: SecretPattern[] = [
  // GitHub personal/app/OAuth/refresh tokens all share this shape.
  { regex: /gh[pousr]_[A-Za-z0-9]{20,}/g, replace: () => '[redacted:github_token]' },
  // Generic vendor API-key shape (OpenAI-style and others that copied it).
  { regex: /sk-[A-Za-z0-9-]{20,}/g, replace: () => '[redacted:api_key]' },
  // AWS access key ids.
  { regex: /AKIA[0-9A-Z]{16}/g, replace: () => '[redacted:aws_access_key]' },
  // PEM private key blocks — the whole thing, header through footer, not
  // just the header line, since the body is the actual secret material.
  { regex: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, replace: () => '[redacted:private_key]' },
  // Authorization headers a log might have printed verbatim.
  { regex: /authorization:\s*bearer\s+\S+/gi, replace: () => '[redacted:bearer_token]' },
  // key = value / key: value pairs named for a secret. The key name stays —
  // it is what makes the redacted line legible ("token=... was here") — only
  // the value is masked. The `(?!\[redacted:)` guard stops this, the last
  // pattern to run, from re-swallowing a more specific marker one of the
  // patterns above just produced (e.g. a github token that also happened to
  // sit after "token:") and downgrading it to the generic "secret" label —
  // which matters for idempotence and for keeping the readable label.
  {
    regex: /\b(api[_-]?key|token|secret|password)\b(\s*[:=]\s*)(?!\[redacted:)\S+/gi,
    replace: (_match, key: string, separator: string) => `${key}${separator}[redacted:secret]`,
  },
]

const STRICT_PATTERNS: SecretPattern[] = [
  // Ordinary email address. Runs before the base64/hex patterns below so a
  // short, plausible local-part (all-hex letters, say) is not eaten by the
  // hex pattern first and left as "[redacted:long_token]@example.com".
  { regex: /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, replace: () => '[redacted:email]' },
  // Standalone runs of 40+ hex digits (git SHAs are 40 or 64 — a false
  // positive there is an acceptable cost of catching hex-encoded secrets of
  // the same length; strict mode is opt-in for exactly this trade-off).
  { regex: /(?<![0-9a-fA-F])[0-9a-fA-F]{40,}(?![0-9a-fA-F])/g, replace: () => '[redacted:long_token]' },
  // Standalone runs of 40+ base64 characters, once the narrower hex pattern
  // above has already taken the purely-hex runs.
  { regex: /(?<![A-Za-z0-9+/=])[A-Za-z0-9+/]{40,}={0,2}(?![A-Za-z0-9+/=])/g, replace: () => '[redacted:long_token]' },
]

/**
 * Applies path substitution then secret masking, in the fixed order the
 * design doc specifies, so a rule string like `command(npx vitest)` and a
 * file path never get evaluated against a text that has already been
 * partially masked in a way that hides one of them from the other.
 *
 * Must be idempotent: `redactText(redactText(x)) === redactText(x)`. Every
 * pattern above either (a) removes the thing it matches entirely, so a
 * second pass has nothing left to match, or (b) always writes the same
 * fixed marker for a given match regardless of what it replaced, so a
 * second pass reproduces the same marker even if it re-matches. Tested
 * directly in redact.test.ts against a string containing every pattern at
 * once.
 */
export function redactText(input: string, options: RedactOptions): string {
  let text = substitutePaths(input, options)

  for (const pattern of SECRET_PATTERNS) {
    text = text.replace(pattern.regex, pattern.replace)
  }

  if (options.level === 'strict') {
    for (const pattern of STRICT_PATTERNS) {
      text = text.replace(pattern.regex, pattern.replace)
    }
  }

  return text
}

/**
 * Printed once at the top of every generated report so a human reads what a
 * report contains before deciding to attach it to a public issue — this
 * sentence is a more reliable safeguard than any regex above, since it asks
 * a person to look rather than trusting a pattern list to be complete.
 */
export const REDACTION_NOTICE =
  'This report is a local snapshot of one or more agy jobs, meant for pasting into a bug report. ' +
  'Prompts and response text are left out unless it was generated with --include-prompt. ' +
  'Absolute paths under the workspace or the home directory are rewritten to <workspace> and ~. ' +
  'Recognisable secrets — API keys, tokens, AWS keys, private key blocks, bearer headers, and key=value pairs named token, secret, password or api_key — are replaced with [redacted:<kind>] markers. ' +
  'Everything else, including the raw normalized log, tool output, and file contents the agent read, is included verbatim: read it before you attach it to anything, and pass --redact strict if it needs a firmer hand.'
