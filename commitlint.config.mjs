/**
 * Conventional Commits, enforced in CI by `.github/workflows/commitlint.yml`.
 *
 * The type and scope are the machine-readable half; the body is the human half.
 * We warn (not fail) on a missing body or an over-long line so that a rushed
 * fix is still mergeable, while `feat`, `fix`, and `refactor` commits that a
 * reviewer must understand are nudged toward prose. See CONTRIBUTING.md.
 */
export default {
  extends: ['@commitlint/config-conventional'],
  rules: {
    'header-max-length': [1, 'always', 100],
    'body-max-line-length': [1, 'always', 100],
    'body-empty': [1, 'always'],
    'footer-leading-blank': [1, 'always'],
    'subject-full-stop': [2, 'never', '.'],
  },
};
