'use strict';
// A real OS child speaking the deterministic fixture protocol, never OpenAI.
// Requires an explicit synthetic home provided by the test parent.
const {Server} = require('./workspace-lifecycle-server.cjs');
if (!process.env.CODEX_LABELS_LIFECYCLE_TEST || !process.env.CODEX_HOME) process.exit(2);
const server = new Server(process.env.CODEX_HOME);
let initialized = false;
const receive = server.receive.bind(server);
server.receive = async m => {
  if (m.method === 'initialized') initialized = true;
  if (m.method && m.method !== 'initialize' && m.method !== 'initialized' && !initialized) throw Error('Not initialized');
  return receive(m);
};
server.nativeOut.pipe(process.stdout);
process.stdin.pipe(server.stdin);
server.once('exit', () => setImmediate(() => process.exit(0)));
