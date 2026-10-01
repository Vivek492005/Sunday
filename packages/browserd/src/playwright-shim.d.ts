// Minimal ambient types for the lazily-loaded `playwright` module.
//
// playwright is an OPTIONAL peer of @sunday/browserd: the real driver loads it
// with a dynamic import() at first use, so unit tests, type checks and
// installs without a browser keep working. Nothing in this package may
// `import ... from 'playwright'` statically.
//
// If playwright is ever added as a real dependency, DELETE this file in favour
// of its bundled types.
declare module 'playwright' {
  const chromium: any;
  export { chromium };
}
