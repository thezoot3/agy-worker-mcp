import { describe, expect, it } from 'vitest'

import { homedir } from 'node:os'

import { resolvePolicy } from '../../../src/policy/profiles.js'

/** Credential-path deny rules embed the real home; normalise so the snapshot is machine-independent. */
function tilde(rules: string[]): string[] {
  return rules.map((r) => r.split(homedir() + '/').join('~/'))
}

describe('profile golden snapshots', () => {
  it('research_readonly allow and deny match snapshots', () => {
    const policy = resolvePolicy({ profile: 'research_readonly', workspace: '/test/workspace' })
    expect(policy.allow).toMatchInlineSnapshot(`
      [
        "read_file(/test/workspace)",
        "read_file(/test/workspace/**)",
        "command(git status|log|diff)",
        "command(rg)",
        "command(ls)",
        "command(cat)",
        "command(wc)",
      ]
    `)
    expect(tilde(policy.deny)).toMatchInlineSnapshot(`
      [
        "write_file(*)",
        "command(python)",
        "command(node)",
        "command(pip)",
        "fetch(*)",
        "read_file(~/.ssh/**)",
        "read_file(~/.aws/**)",
        "read_file(~/.gnupg/**)",
        "read_file(~/.netrc)",
        "read_file(~/.npmrc)",
        "read_file(~/.git-credentials)",
        "read_file(~/.config/gh/**)",
        "read_file(~/.config/gcloud/**)",
        "read_file(~/.docker/config.json)",
        "read_file(~/.kube/**)",
        "write_file(/test/workspace/.agents/**)",
      ]
    `)
  })

  it('general_worker allow and deny match snapshots', () => {
    const policy = resolvePolicy({ profile: 'general_worker', workspace: '/test/workspace' })
    expect(policy.allow).toMatchInlineSnapshot(`
      [
        "read_file(/test/workspace)",
        "read_file(/test/workspace/**)",
        "write_file(/test/workspace/**)",
        "command(git)",
        "command(ls)",
        "command(cat)",
        "command(head)",
        "command(tail)",
        "command(wc)",
        "command(grep)",
        "command(rg)",
        "command(find)",
        "command(stat)",
        "command(sed)",
        "command(sort)",
        "command(uniq)",
        "command(diff)",
        "command(cut)",
        "command(tr)",
        "command(basename)",
        "command(dirname)",
        "command(realpath)",
        "command(which)",
        "command(echo)",
        "command(printf)",
        "command(test)",
        "command(true)",
        "command(false)",
        "command(mkdir)",
        "command(touch)",
        "command(cp)",
        "command(mv)",
        "command(rm)",
        "command(python3 -c)",
        "command(python -c)",
        "command(node -e)",
        "command(bash -c)",
        "command(sh -c)",
        "command(python -m pytest)",
        "command(./gradlew)",
        "command(gradle)",
        "command(mvn)",
        "command(npm test)",
        "command(npm run)",
        "command(javac)",
        "command(java)",
      ]
    `)
    expect(tilde(policy.deny)).toMatchInlineSnapshot(`
      [
        "command(curl)",
        "command(wget)",
        "command(ssh)",
        "command(scp)",
        "command(git push)",
        "command(sudo)",
        "command(docker)",
        "command(rm -rf)",
        "command(git reset --hard)",
        "command(git clean)",
        "command(git filter-branch)",
        "command(git branch -D)",
        "command(git stash drop)",
        "command(git remote add)",
        "command(git remote set-url)",
        "command(git config --global)",
        "command(git checkout -- .)",
        "command(git restore .)",
        "command(git restore --staged .)",
        "command(pip install)",
        "command(npm install)",
        "read_file(~/.ssh/**)",
        "read_file(~/.aws/**)",
        "read_file(~/.gnupg/**)",
        "read_file(~/.netrc)",
        "read_file(~/.npmrc)",
        "read_file(~/.git-credentials)",
        "read_file(~/.config/gh/**)",
        "read_file(~/.config/gcloud/**)",
        "read_file(~/.docker/config.json)",
        "read_file(~/.kube/**)",
        "write_file(/test/workspace/.agents/**)",
      ]
    `)
  })
})
