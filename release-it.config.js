/** @type {import('release-it').Configuration} */
export default {
  git: {
    requireCommits: true,
    requireCommitsFilter: '**',
    commitsPath: null,
  },
  github: {
    release: true,
    releaseName: 'v${version}',
  },
  npm: {
    publish: true,
    publishArgs: ['--access', 'public'],
  },
  plugins: {
    '@release-it/bumper': {
      files: ['package.json'],
      patterns: [{ key: 'version' }],
    },
  },
  hooks: {
    'before:init': ['bun run typecheck', 'bun run lint', 'bun run test'],
    'before:bump': ['bun run clean', 'bun run prepare'],
  },
}
