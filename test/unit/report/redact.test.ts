/**
 * §4 of docs/.local/13-usage-and-debug-records.md is the spec: this is the
 * only place a job log's raw text is allowed to reach an HTML report, so
 * every pattern gets a positive and a near-miss case, and idempotence is
 * pinned down directly rather than trusted to eyeballing the regexes.
 */
import { describe, expect, it } from 'vitest'

import { escapeHtml, escapeJsonForScript, redactText, REDACTION_NOTICE } from '../../../src/report/redact.js'

describe('escapeHtml', () => {
  it('escapes all five characters, in a string an agent could plausibly have read from a file', () => {
    expect(escapeHtml('<script>alert(1)</script>')).toBe('&lt;script&gt;alert(1)&lt;/script&gt;')
    expect(escapeHtml(`& < > " '`)).toBe('&amp; &lt; &gt; &quot; &#39;')
  })
})

describe('escapeJsonForScript', () => {
  it('escapes an embedded </script> so it cannot close the surrounding element early', () => {
    const out = escapeJsonForScript({ note: 'saw a </script> tag in the file' })
    expect(out).not.toContain('</script>')
    // only "<" is escaped — ">" needs no escaping to stop the parser
    expect(out).toContain('\\u003c/script>')
    // and it must still be valid JSON once the browser's parser sees it verbatim
    expect(JSON.parse(out)).toEqual({ note: 'saw a </script> tag in the file' })
  })

  it('escapes U+2028/U+2029 defensively', () => {
    const out = escapeJsonForScript('line\u2028sep\u2029end')
    expect(out).not.toMatch(/[\u2028\u2029]/)
    expect(JSON.parse(out)).toBe('line\u2028sep\u2029end')
  })
})

describe('redactText — path substitution', () => {
  it('replaces workspace and home, longest-first, so a workspace nested under home is not half-replaced', () => {
    const input = 'reading /Users/alice/code/project/src/index.ts and /Users/alice/.bashrc'
    const out = redactText(input, { level: 'default', home: '/Users/alice', workspace: '/Users/alice/code/project' })
    expect(out).toBe('reading <workspace>/src/index.ts and ~/.bashrc')
    // in particular, no leftover "~/code/project/..." from home matching first
    expect(out).not.toContain('~/code/project')
  })

  it('is a no-op when neither path is given', () => {
    expect(redactText('/Users/alice/code/project', { level: 'default' })).toBe('/Users/alice/code/project')
  })
})

describe('redactText — secret patterns', () => {
  it('redacts a GitHub token and leaves a near-miss (wrong letter, too short) alone', () => {
    expect(redactText('token is ghp_abcdEFGH0123456789abcd', { level: 'default' })).toContain('[redacted:github_token]')
    // wrong middle letter ('x' is not one of p/o/u/s/r) — not a github token shape
    expect(redactText('ghx_abcdEFGH0123456789abcd is fine', { level: 'default' })).toContain('ghx_abcdEFGH0123456789abcd')
  })

  it('redacts an sk- API key and leaves a too-short near-miss alone', () => {
    expect(redactText('key sk-abcdefghijklmnopqrstuvwx', { level: 'default' })).toContain('[redacted:api_key]')
    expect(redactText('key sk-short', { level: 'default' })).toContain('sk-short')
  })

  it('redacts an AWS access key id and leaves a near-miss (too few digits) alone', () => {
    expect(redactText('id AKIA1234567890ABCDEF', { level: 'default' })).toContain('[redacted:aws_access_key]')
    expect(redactText('id AKIASHORT', { level: 'default' })).toContain('AKIASHORT')
  })

  it('redacts a whole PEM private key block and leaves a non-private-key PEM block alone', () => {
    const block = ['-----BEGIN RSA PRIVATE KEY-----', 'MIIBogIBAAJBAK...', 'more body text', '-----END RSA PRIVATE KEY-----'].join('\n')
    const out = redactText(`before ${block} after`, { level: 'default' })
    expect(out).toBe('before [redacted:private_key] after')
    expect(out).not.toContain('MIIBogIBAAJBAK')

    const certificate = '-----BEGIN CERTIFICATE-----\nMIIB...\n-----END CERTIFICATE-----'
    expect(redactText(certificate, { level: 'default' })).toBe(certificate)
  })

  it('redacts an authorization bearer header and leaves "authorization: basic ..." alone', () => {
    expect(redactText('Authorization: Bearer abc.def-123', { level: 'default' })).toBe('[redacted:bearer_token]')
    expect(redactText('authorization: basic abc123', { level: 'default' })).toBe('authorization: basic abc123')
  })

  it('redacts key=value / key: value secrets by name and leaves an unrelated key alone', () => {
    expect(redactText('api_key: sekret-value-1', { level: 'default' })).toBe('api_key: [redacted:secret]')
    expect(redactText('password=hunter2', { level: 'default' })).toBe('password=[redacted:secret]')
    // "tokenized" contains "token" as a substring but is not the word "token"
    expect(redactText('tokenized: true', { level: 'default' })).toBe('tokenized: true')
  })
})

describe('redactText — strict level', () => {
  it('adds standalone long hex/base64 runs and leaves a short one alone', () => {
    const hex = 'a'.repeat(40)
    const shortHex = 'a'.repeat(10)
    expect(redactText(`sha ${hex} done`, { level: 'strict' })).toBe('sha [redacted:long_token] done')
    expect(redactText(`sha ${shortHex} done`, { level: 'strict' })).toBe(`sha ${shortHex} done`)
    expect(redactText(`sha ${hex} done`, { level: 'default' })).toBe(`sha ${hex} done`)

    // not pure hex (contains 'z' and 'Q', outside 0-9a-fA-F), so this only
    // matches the base64 pattern, not the hex one
    const base64ish = 'Q' + 'z'.repeat(38) + 'Q'
    expect(redactText(`blob ${base64ish} end`, { level: 'strict' })).toBe('blob [redacted:long_token] end')
  })

  it('adds email addresses and leaves default level alone', () => {
    expect(redactText('contact alice@example.com now', { level: 'strict' })).toBe('contact [redacted:email] now')
    expect(redactText('contact alice@example.com now', { level: 'default' })).toBe('contact alice@example.com now')
    // near miss: no TLD
    expect(redactText('not an email: alice@localhost', { level: 'strict' })).toBe('not an email: alice@localhost')
  })
})

describe('redactText — idempotence', () => {
  const everything = [
    '/Users/alice/code/project/src/index.ts is under /Users/alice',
    'ghp_abcdEFGH0123456789abcd',
    'sk-abcdefghijklmnopqrstuvwx',
    'AKIA1234567890ABCDEF',
    '-----BEGIN PRIVATE KEY-----\nbody\n-----END PRIVATE KEY-----',
    'Authorization: Bearer abc.def-123',
    'api_key: sekret-value-1',
    'a'.repeat(40),
    'contact alice@example.com',
  ].join('\n')

  it('default level: redacting twice equals redacting once', () => {
    const options = { level: 'default' as const, home: '/Users/alice', workspace: '/Users/alice/code/project' }
    const once = redactText(everything, options)
    const twice = redactText(once, options)
    expect(twice).toBe(once)
  })

  it('strict level: redacting twice equals redacting once', () => {
    const options = { level: 'strict' as const, home: '/Users/alice', workspace: '/Users/alice/code/project' }
    const once = redactText(everything, options)
    const twice = redactText(once, options)
    expect(twice).toBe(once)
  })
})

describe('REDACTION_NOTICE', () => {
  it('is a non-empty string mentioning the shape of what is included and excluded', () => {
    expect(typeof REDACTION_NOTICE).toBe('string')
    expect(REDACTION_NOTICE.length).toBeGreaterThan(0)
    expect(REDACTION_NOTICE).toContain('--include-prompt')
    expect(REDACTION_NOTICE).toContain('<workspace>')
  })
})
