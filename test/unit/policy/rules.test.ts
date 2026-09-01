import { describe, expect, it } from 'vitest'

import { ValidationError } from '../../../src/contract/errors.js'
import {
  firstMatch,
  intersectAllow,
  matchRule,
  parseRule,
  parseRulesLenient,
  requiredRuleFor,
} from '../../../src/policy/rules.js'
import { HARD_DENY, resolvePolicy } from '../../../src/policy/profiles.js'

describe('parseRule', () => {
  it('parses verb(pattern)', () => {
    expect(parseRule('command(git status)')).toEqual({
      verb: 'command',
      pattern: 'git status',
      regex: false,
      raw: 'command(git status)',
    })
  })

  it('opts into regex with the regex: prefix', () => {
    const r = parseRule('read_file(regex:^/ws/.*\\.txt$)')
    expect(r.regex).toBe(true)
    expect(r.pattern).toBe('^/ws/.*\\.txt$')
  })

  it('throws ValidationError with allowed_verbs for a malformed rule', () => {
    expect(() => parseRule('not-a-rule')).toThrow(ValidationError)
    try {
      parseRule('bogus(x)')
    } catch (e) {
      expect(e).toBeInstanceOf(ValidationError)
      expect((e as ValidationError).detail.allowed_verbs).toBeDefined()
    }
  })
})

describe('matchRule — command pattern matching', () => {
  it('matches an exact prefix, leaving trailing tokens unconstrained', () => {
    const rule = parseRule('command(git status|log|diff)')
    expect(matchRule(rule, { verb: 'command', value: 'git status' })).toBe(true)
    expect(matchRule(rule, { verb: 'command', value: 'git log --oneline' })).toBe(true)
    expect(matchRule(rule, { verb: 'command', value: 'git push' })).toBe(false)
  })

  it('a wildcard * matches anything for that verb', () => {
    const rule = parseRule('command(*)')
    expect(matchRule(rule, { verb: 'command', value: 'anything at all' })).toBe(true)
  })

  it('never matches a different verb', () => {
    const rule = parseRule('command(git status)')
    expect(matchRule(rule, { verb: 'read_file', value: 'git status' })).toBe(false)
  })
})

describe('firstMatch — deny is checked before allow (docs/03 §1.3)', () => {
  it('a subject matching both a deny rule and an allow rule is denied', () => {
    // This mirrors gate.ts decide(): deny list is scanned first, unconditionally,
    // regardless of what allow contains.
    const deny = parseRulesLenient(['command(git push)'])
    const allow = parseRulesLenient(['command(git push|status)'])
    const subject = { verb: 'command' as const, value: 'git push origin main' }

    expect(firstMatch(deny, subject)).not.toBeNull()
    expect(firstMatch(allow, subject)).not.toBeNull()
    // The gate's own decide() checks deny first and returns immediately on a hit —
    // covered end-to-end in gate.test.ts. Here we confirm both lists really do
    // both match, so that end-to-end assertion is meaningful and not vacuous.
  })
})

describe('intersectAllow — a client can only narrow the profile ceiling, never widen it', () => {
  it('keeps a requested rule that the ceiling already covers', () => {
    const ceiling = ['command(git status|log|diff|add|commit)']
    const { allowed, rejected } = intersectAllow(['command(git status)'], ceiling)
    expect(allowed).toEqual(['command(git status)'])
    expect(rejected).toEqual([])
  })

  it('rejects a requested rule the ceiling does not cover, even a superficially similar one', () => {
    const ceiling = ['command(git status|log|diff)']
    const { allowed, rejected } = intersectAllow(['command(git push)'], ceiling)
    expect(allowed).toEqual([])
    expect(rejected).toEqual(['command(git push)'])
  })

  it('rejects an attempt to widen via a bare wildcard the ceiling never granted', () => {
    const ceiling = ['command(git status|log|diff)']
    const { allowed, rejected } = intersectAllow(['command(*)'], ceiling)
    expect(allowed).toEqual([])
    expect(rejected).toEqual(['command(*)'])
  })

  it('a malformed requested rule is rejected, not silently dropped', () => {
    const { allowed, rejected } = intersectAllow(['not-a-rule'], ['command(*)'])
    expect(allowed).toEqual([])
    expect(rejected).toEqual(['not-a-rule'])
  })
})

describe('requiredRuleFor', () => {
  it('renders the narrowest rule string that would have permitted the subject', () => {
    expect(requiredRuleFor({ verb: 'command', value: 'npm run build' })).toBe(
      'command(npm run build)',
    )
  })
})

describe('resolvePolicy — deny is a union the client cannot shrink; HARD_DENY always present', () => {
  it('every HARD_DENY entry is present in the effective policy regardless of profile', () => {
    const policy = resolvePolicy({ profile: 'general_worker', workspace: process.cwd() })
    for (const hard of HARD_DENY) {
      expect(policy.deny).toContain(hard)
    }
  })

  it('a client-requested deny is unioned in, but a client cannot remove a profile or HARD_DENY entry', () => {
    // There is no "remove" input at all — resolvePolicy only ever adds to deny.
    const policy = resolvePolicy({
      profile: 'general_worker',
      workspace: process.cwd(),
      requested: { deny: ['command(python)'] },
    })
    expect(policy.deny).toContain('command(python)') // client's own addition
    expect(policy.deny).toContain('command(git push)') // profile's own deny, untouched
    for (const hard of HARD_DENY) {
      expect(policy.deny).toContain(hard) // hard deny, untouched
    }
  })

  it('an allow request wider than the profile ceiling is rejected into rejected_allow, not granted', () => {
    const policy = resolvePolicy({
      profile: 'research_readonly',
      workspace: process.cwd(),
      requested: { allow: ['command(rm -rf)', 'write_file(**)'] },
    })
    expect(policy.allow).toEqual([])
    expect(policy.rejected_allow).toEqual(['command(rm -rf)', 'write_file(**)'])
  })

  it('omitting requested.allow entirely keeps the full profile ceiling (no narrowing requested)', () => {
    const policy = resolvePolicy({ profile: 'general_worker', workspace: process.cwd() })
    expect(policy.allow.length).toBeGreaterThan(0)
    expect(policy.rejected_allow).toEqual([])
  })
})
