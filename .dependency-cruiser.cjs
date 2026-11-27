/**
 * The dependency rule from Section 5 of the blueprint:
 *   contracts depends on nothing.
 *   kernel depends on contracts.
 *   modules depend on kernel and contracts, and never on each other.
 *   the shell (src/ui) talks to the kernel and contracts, never to modules.
 *   src/main.ts is the only file that wires modules together.
 * `npm run lint:deps` fails the build when an import breaks this.
 */
module.exports = {
  forbidden: [
    {
      name: 'contracts-depend-on-nothing',
      severity: 'error',
      comment: 'contracts/ may import only other contracts files (and JSON schemas).',
      from: { path: '^src/contracts/' },
      to: { pathNot: '^src/contracts/' },
    },
    {
      name: 'kernel-depends-on-contracts',
      severity: 'error',
      comment: 'kernel/ may import contracts and approved libraries, never modules or the shell.',
      from: { path: '^src/kernel/' },
      to: { path: '^src/(modules|ui)/|^src/main\\.ts$' },
    },
    {
      name: 'modules-never-import-each-other',
      severity: 'error',
      comment: 'A module may import its own folder, the kernel and contracts. Talk through events instead.',
      // trackers/<name>, recognizers/<name> and effects/<name> are each a separate module;
      // every other folder directly under modules/ is one module.
      from: { path: '^src/modules/((?:trackers|recognizers|effects)/[^/]+|[^/]+)/' },
      to: {
        path: '^src/modules/',
        pathNot: '^src/modules/$1/',
      },
    },
    {
      name: 'modules-never-import-shell-or-main',
      severity: 'error',
      from: { path: '^src/modules/' },
      to: { path: '^src/(ui/|main\\.ts$)' },
    },
    {
      name: 'only-main-wires-modules',
      severity: 'error',
      comment: 'Section 5: one file, src/main.ts, wires modules together. tools/ pages are separate composition roots and are not linted here.',
      from: { path: '^src/', pathNot: '^src/(modules/|main\\.ts$)' },
      to: { path: '^src/modules/' },
    },
    {
      name: 'shell-talks-to-kernel',
      severity: 'error',
      comment: 'The shell imports the kernel and contracts. Modules are wired in src/main.ts.',
      from: { path: '^src/ui/' },
      to: { path: '^src/modules/' },
    },
    {
      name: 'no-circular',
      severity: 'error',
      from: {},
      to: { circular: true },
    },
  ],
  options: {
    doNotFollow: { path: 'node_modules' },
    exclude: { path: '\\.test\\.ts$' },
    tsPreCompilationDeps: true,
    tsConfig: { fileName: 'tsconfig.json' },
    enhancedResolveOptions: { exportsFields: ['exports'], conditionNames: ['import', 'require', 'node', 'default', 'types'] },
  },
};
