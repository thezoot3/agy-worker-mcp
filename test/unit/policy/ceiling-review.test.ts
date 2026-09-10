/**
 * `reviewCeilingDraft` / `classifyRuleRisk` (`src/policy/ceiling-review.ts`):
 * the review a human sees before approving a ceiling. `ok` must agree with
 * `loadCeiling`; risk classes must put the consequential things first.
 */
import { describe, expect, it } from 'vitest'

import { classifyRuleRisk, reviewCeilingDraft } from '../../../src/policy/ceiling-review.js'

describe('classifyRuleRisk', () => {
  it.each([
    ['command(ls)', 'read_utility'],
    ['command(git status|log|diff)', 'vcs_local'],
    ['command(git push)', 'vcs_remote'],
    ['command(git push --force)', 'destructive'],
    ['command(curl)', 'network'],
    ['command(npm install)', 'install'],
    ['command(sudo)', 'privilege'],
    ['command(sudo npm install)', 'privilege'],
    ['command(rm -rf)', 'destructive'],
    ['command(./gradlew)', 'build'],
    ['command(cargo)', 'build'],
    ['command(bash -c)', 'build'],
    ['command(ls|curl)', 'network'],
    ['read_file(~/.gradle/**)', 'filesystem'],
    ['write_file({workspace}/build/**)', 'filesystem'],
    ['fetch(*)', 'network'],
    ['command(frobnicate)', 'other'],
    ['not a rule', 'other'],
  ])('%s → %s', (rule, risk) => {
    expect(classifyRuleRisk(rule)).toBe(risk)
  })
})

describe('reviewCeilingDraft', () => {
  it('a clean v2 draft is ok with one row per rule and no warnings', () => {
    const r = reviewCeilingDraft({ version: 2, allow: ['command(cargo)'], read_roots: ['/tmp'] })
    expect(r.ok).toBe(true)
    expect(r.errors).toEqual([])
    expect(r.warnings).toEqual([])
    expect(r.rules).toEqual([{ key: 'allow', rule: 'command(cargo)', risk: 'build', notes: [] }])
  })

  it('reports loadCeiling errors verbatim: bad version, bad rule, HARD_DENY in exceptions', () => {
    expect(reviewCeilingDraft({ version: 3 }).ok).toBe(false)
    expect(reviewCeilingDraft({ version: 2, allow: ['nope'] }).errors[0]).toContain('nope')
    const hd = reviewCeilingDraft({ version: 2, exceptions: ['write_file({workspace}/.agents/**)'] })
    expect(hd.ok).toBe(false)
    expect(hd.errors[0]).toContain('HARD_DENY')
  })

  it('a v1 draft fails review with the conversion error', () => {
    const r = reviewCeilingDraft({ version: 1, extra_allow: ['command(ls)'] })
    expect(r.ok).toBe(false)
    expect(r.errors[0]).toContain('"version": 2')
    expect(r.errors[0]).toContain("<<'JSON'")
  })

  it('flags redundant allow, allow-vs-deny confusion, and exceptions that lift nothing', () => {
    const r = reviewCeilingDraft({
      version: 2,
      allow: ['command(ls)', 'command(git push)'],
      exceptions: ['command(git)'],
    })
    expect(r.ok).toBe(true)
    const byRule = Object.fromEntries(r.rules.map((x) => [`${x.key}:${x.rule}`, x.notes]))
    expect(byRule['allow:command(ls)']?.[0]).toContain('already in')
    expect(byRule['allow:command(git push)']?.[0]).toContain('use exceptions')
    expect(byRule['exceptions:command(git)']?.[0]).toContain('lifts nothing')
  })

  it('an elevated-risk exception and denylist mode both demand explicit approval', () => {
    const r = reviewCeilingDraft({ version: 2, exceptions: ['command(git push)'], command_policy: 'denylist' })
    expect(r.ok).toBe(true)
    const row = r.rules.find((x) => x.key === 'exceptions')!
    expect(row.risk).toBe('vcs_remote')
    expect(row.notes.some((n) => n.includes('explicit'))).toBe(true)
    expect(r.warnings.some((w) => w.includes('denylist'))).toBe(true)
  })

  it('a non-object draft is an error, not a crash', () => {
    expect(reviewCeilingDraft('nope').ok).toBe(false)
    expect(reviewCeilingDraft(null).ok).toBe(false)
  })
})
