// browser build: the host name in log entries
module.exports = { hostname: () => (typeof navigator !== 'undefined' ? 'web' : 'web'), tmpdir: () => '/tmp', EOL: '\n' };
